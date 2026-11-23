// Authoritative game state. Runs only on the host's machine; every player (including the
// host's own screen) receives a personalised view with their own character hidden.
const MAX_PLAYERS = 10;

class HostGame {
  constructor(code, deliverLocal) {
    this.code = code;
    this.deliverLocal = deliverLocal; // (msg) => void, for the host's own UI
    this.players = [];               // {pid, clientId, name, known:Set, conn, connected, isHost, spectator, color, have:Set}
    const prof = Profile.get();
    this.settings = {
      turnSeconds: 30,
      guessesPerRound: 1,
      revealFandom: false, // players work out their own fandom; host can turn on as an easy mode
      theme: 'shown',      // shared trait: 'shown' to everyone, 'secret' until the end, or 'off'
      fandoms: prof.known.filter(id => Library.fandoms.has(id)),
    };
    this.phase = 'lobby';
    this.game = null;
    this.feed = [];
    this.feedSeq = 0;
    this._dirty = false;
  }

  // ---------------- players ----------------
  addPlayer({ clientId, name, known, conn, isHost, have }) {
    let p = this.players.find(x => x.clientId === clientId);
    if (p) { // reconnect
      p.conn = conn; p.connected = true; p.name = name || p.name; p.have = new Set(have || []);
      if (known) p.known = new Set(known);
      this.sys(`${p.name} reconnected.`);
      this.changed();
      return p;
    }
    const active = this.players.filter(x => !x.spectator);
    if (active.length >= MAX_PLAYERS && this.phase === 'lobby') return { error: 'That lobby is full (10 players max).' };
    const usedColors = new Set(this.players.map(x => x.color));
    p = {
      pid: randomId('p'), clientId, name: (name || 'Player').slice(0, 24), known: new Set(known || []),
      conn, connected: true, isHost: !!isHost, spectator: this.phase !== 'lobby', have: new Set(have || []),
      color: PLAYER_COLORS.find(c => !usedColors.has(c)) || PLAYER_COLORS[this.players.length % PLAYER_COLORS.length],
    };
    this.players.push(p);
    this.sys(p.spectator ? `${p.name} joined as a spectator (game in progress).` : `${p.name} joined.`);
    this.changed();
    return p;
  }

  player(pid) { return this.players.find(p => p.pid === pid); }

  disconnect(pid) {
    const p = this.player(pid);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players = this.players.filter(x => x !== p);
      this.sys(`${p.name} left.`);
    } else {
      p.connected = false; p.conn = null;
      this.sys(`${p.name} disconnected.`);
      if (this.game && this.currentPid() === pid) this.nextTurn();
    }
    this.changed();
  }

  // ---------------- messages ----------------
  handle(pid, m) {
    const p = this.player(pid);
    if (!p || !m || typeof m !== 'object') return;
    const isHost = p.isHost;
    switch (m.t) {
      case 'setKnown': p.known = new Set((m.known || []).slice(0, 5000)); this.changed(); break;
      case 'setName': p.name = String(m.name || '').slice(0, 24) || p.name; this.changed(); break;
      case 'chat': {
        const text = String(m.text || '').trim().slice(0, 300);
        if (text) this.push({ kind: 'chat', pid, text });
        break;
      }
      case 'needImg': this.sendImages(p, m.ids || []); break;

      // host-only lobby controls
      case 'settings':
        if (!isHost || this.phase !== 'lobby') return;
        if (m.turnSeconds) this.settings.turnSeconds = Math.max(10, Math.min(300, m.turnSeconds | 0));
        if (m.guessesPerRound) this.settings.guessesPerRound = Math.max(1, Math.min(5, m.guessesPerRound | 0));
        if (typeof m.revealFandom === 'boolean') this.settings.revealFandom = m.revealFandom;
        if (['shown', 'secret', 'off'].includes(m.theme)) this.settings.theme = m.theme;
        if (Array.isArray(m.fandoms)) this.settings.fandoms = m.fandoms.filter(id => Library.fandoms.has(id));
        this.changed();
        break;
      case 'kick': {
        if (!isHost) return;
        const k = this.player(m.pid);
        if (!k || k.isHost) return;
        try { k.conn?.send({ t: 'kicked' }); } catch { }
        setTimeout(() => k.conn?.close(), 300);
        this.players = this.players.filter(x => x !== k);
        if (this.game) {
          this.game.order = this.game.order.filter(x => x !== k.pid);
          if (this.game.current === k.pid) this.nextTurn();
        }
        this.sys(`${k.name} was removed by the host.`);
        this.changed();
        break;
      }
      case 'start': if (isHost) this.startGame(); break;
      case 'addTime':
        if (isHost && this.game && !this.game.ended) { this.game.turnEndsAt += 15000; this.armTimer(); this.changed(); }
        break;
      case 'skipTurn': if (isHost && this.game && !this.game.ended) { this.sys(`Host skipped ${this.name(this.game.current)}'s turn.`); this.nextTurn(); } break;
      case 'endGame': if (isHost && this.game && !this.game.ended) this.endGame(true); break;
      case 'toLobby': if (isHost) this.backToLobby(); break;
      case 'override': if (isHost) this.overrideGuess(m.feedId); break;

      // gameplay
      case 'noteAdd': {
        const g = this.game;
        if (!g || g.ended || g.current !== pid) return;
        const text = String(m.text || '').trim().slice(0, 80);
        if (!text) return;
        const sheet = g.sheets[pid];
        if (sheet.length >= 40) return;
        sheet.push(text);
        this.changed();
        break;
      }
      case 'noteDel': {
        const g = this.game;
        if (!g || g.ended || g.current !== pid) return;
        g.sheets[pid].splice(m.index | 0, 1);
        this.changed();
        break;
      }
      case 'guess': this.guess(p, String(m.text || '').trim().slice(0, 80)); break;
      case 'endTurn': if (this.game && this.game.current === pid && !this.game.ended) this.nextTurn(); break;
      case 'giveUp': this.giveUp(p); break;
    }
  }

  // ---------------- game flow ----------------
  startGame() {
    if (this.game && !this.game.ended) return;
    const active = this.players.filter(p => p.connected);
    if (active.length < 2) return this.hostError('You need at least 2 players to start.');
    const fset = this.settings.fandoms.filter(id => Library.fandoms.has(id));
    if (!fset.length) return this.hostError('Pick at least one fandom for this round.');
    // Strict rule: a player's character only ever comes from fandoms THEY picked (and the host included).
    const pools = new Map(active.map(p => [p.pid, fset.filter(f => p.known.has(f))]));
    const without = active.filter(p => !pools.get(p.pid).length);
    if (without.length) {
      const names = without.map(p => p.name).join(', ');
      return this.hostError(`${names} ${without.length > 1 ? "don't" : "doesn't"} know any of this game's fandoms. They need to pick fandoms they know, or you can add one of theirs to the game.`);
    }
    const cands = new Map(active.map(p => [p.pid, pools.get(p.pid).flatMap(f => Library.charsIn(f))]));
    const knownByOthers = (p, c) => active.filter(o => o !== p && o.known.has(c.f)).length;

    // Give every player a different character from their list; null if impossible.
    const assignDistinct = listFor => {
      for (let attempt = 0; attempt < 25; attempt++) {
        const used = new Set(), result = {};
        const order = shuffle(active).sort((a, b) => listFor(a).length - listFor(b).length);
        let ok = true;
        for (const p of order) {
          const free = listFor(p).filter(c => !used.has(c.id));
          if (!free.length) { ok = false; break; }
          const c = weightedPick(shuffle(free), x => 1 + 2 * knownByOthers(p, x));
          used.add(c.id); result[p.pid] = c.id;
        }
        if (ok) return result;
      }
      return null;
    };

    // Shared trait: pick a tag that every player can get a character with.
    let theme = null, assign = null;
    if (this.settings.theme !== 'off') {
      const byTag = new Map(); // tag -> Map(pid -> chars[])
      for (const p of active) for (const c of cands.get(p.pid)) for (const t of Library.themeTags(c)) {
        if (!byTag.has(t)) byTag.set(t, new Map());
        const m = byTag.get(t); if (!m.has(p.pid)) m.set(p.pid, []); m.get(p.pid).push(c);
      }
      let options = [...byTag.entries()].filter(([, m]) => active.every(p => m.has(p.pid)));
      while (options.length && !assign) {
        const pick = weightedPick(options, ([, m]) => 1 + Math.min(4, Math.min(...active.map(p => m.get(p.pid).length))));
        options = options.filter(o => o !== pick);
        const [tag, m] = pick;
        assign = assignDistinct(p => m.get(p.pid));
        if (assign) theme = tag;
      }
    }
    if (!assign) assign = assignDistinct(p => cands.get(p.pid));
    if (!assign) return this.hostError("There aren't enough different characters in the players' fandoms. Add more fandoms to the game.");

    for (const p of active) p.spectator = false;
    const order = shuffle(active.map(p => p.pid));
    this.game = {
      order, assign, theme, current: order[0], turnIdx: 0, round: 1, turnEndsAt: 0,
      sheets: Object.fromEntries(order.map(pid => [pid, []])),
      guessesUsed: {}, ranks: {}, nextTop: 1, nextBottom: order.length, ended: false,
    };
    this.phase = 'playing';
    this.feed = [];
    this.sys(`Game started with ${order.length} players. Round 1 — ${this.name(order[0])} goes first.`);
    if (theme && this.settings.theme === 'shown') this.sys(`This game's shared trait is #${theme}. Every character has it!`, 'reveal');
    else if (theme) this.sys('Every character shares one secret trait. It is revealed at the end.', 'reveal');
    else if (this.settings.theme !== 'off') this.sys("No single trait fit everyone's fandoms this time, so characters were picked without a theme.");
    this.startTurn();
  }

  currentPid() { return this.game?.current; }
  name(pid) { return this.player(pid)?.name || 'Someone'; }

  canPlay(pid) {
    const p = this.player(pid);
    return p && p.connected && !this.game.ranks[pid];
  }

  startTurn() {
    const g = this.game;
    g.turnEndsAt = Date.now() + this.settings.turnSeconds * 1000;
    this.armTimer();
    this.changed();
  }

  armTimer() {
    clearTimeout(this._timer);
    const g = this.game;
    if (!g || g.ended) return;
    this._timer = setTimeout(() => {
      if (this.game !== g || g.ended) return;
      this.sys(`Time's up for ${this.name(g.current)}.`);
      this.nextTurn();
    }, Math.max(0, g.turnEndsAt - Date.now()));
  }

  nextTurn() {
    const g = this.game;
    if (!g || g.ended) return;
    if (!g.order.some(pid => this.canPlay(pid))) {
      if (g.order.every(pid => g.ranks[pid])) return this.endGame(false);
      // everyone left is disconnected — wait for someone to come back
      g.current = null; clearTimeout(this._timer); this.changed(); return;
    }
    const n = g.order.length;
    let idx = g.order.indexOf(g.current);
    if (idx < 0) idx = Math.min(g.turnIdx, n) - 1; // current player was removed
    let wrapped = false;
    for (let step = 1; step <= n + 1; step++) {
      const raw = idx + step;
      if (raw >= n && !wrapped) {
        wrapped = true; g.round++; g.guessesUsed = {};
        this.sys(`Round ${g.round} begins — everyone gets a fresh guess.`);
      }
      const ni = raw % n;
      const pid = g.order[ni];
      if (this.canPlay(pid)) { g.current = pid; g.turnIdx = ni; this.startTurn(); return; }
    }
  }

  guess(p, text) {
    const g = this.game;
    if (!g || g.ended || !text || g.ranks[p.pid] || !g.order.includes(p.pid)) return;
    const used = g.guessesUsed[p.pid] || 0;
    if (used >= this.settings.guessesPerRound) return this.tell(p, 'You already used your guess this round.');
    g.guessesUsed[p.pid] = used + 1;
    const c = Library.chars.get(g.assign[p.pid]);
    const ok = guessMatches(text, c);
    const item = this.push({ kind: 'guess', pid: p.pid, text, ok }, false);
    if (ok) this.rank(p.pid, 'guessed', item);
    else this.changed();
  }

  overrideGuess(feedId) {
    const g = this.game;
    const item = this.feed.find(f => f.id === feedId && f.kind === 'guess' && !f.ok);
    if (!g || g.ended || !item || g.ranks[item.pid]) return;
    item.ok = true; item.overridden = true;
    this.rank(item.pid, 'guessed', item);
  }

  giveUp(p) {
    const g = this.game;
    if (!g || g.ended || g.ranks[p.pid] || !g.order.includes(p.pid)) return;
    this.rank(p.pid, 'gave up');
  }

  rank(pid, how) {
    const g = this.game;
    const place = how === 'guessed' ? g.nextTop++ : g.nextBottom--;
    g.ranks[pid] = { place, how, round: g.round };
    const c = Library.chars.get(g.assign[pid]);
    this.sys(how === 'guessed'
      ? `${this.name(pid)} figured it out — they were ${c.n}! ${medal(place)} ${placeLabel(place)} place.`
      : `${this.name(pid)} gave up. They were ${c.n}. ${placeLabel(place)} place.`, 'reveal');
    if (g.order.every(x => g.ranks[x])) return this.endGame(false);
    if (g.current === pid) this.nextTurn(); else this.changed();
  }

  endGame(forced) {
    const g = this.game;
    g.ended = true; g.current = null;
    clearTimeout(this._timer);
    if (forced) {
      // anyone still guessing shares the remaining places in turn order
      for (const pid of g.order) if (!g.ranks[pid]) g.ranks[pid] = { place: g.nextTop++, how: 'unsolved', round: g.round };
    }
    this.phase = 'results';
    this.sys(forced ? 'The host ended the game.' : 'Everyone has been ranked — game over!');
    if (g.theme && this.settings.theme === 'secret') this.sys(`The secret shared trait was #${g.theme}.`, 'reveal');
    this.changed();
  }

  backToLobby() {
    clearTimeout(this._timer);
    this.game = null; this.phase = 'lobby'; this.feed = [];
    this.players = this.players.filter(p => p.connected);
    for (const p of this.players) p.spectator = false;
    this.sys('Back in the lobby.');
    this.changed();
  }

  hostError(msg) { const h = this.players.find(p => p.isHost); if (h) this.tell(h, msg); }

  tell(p, text) { this.sendTo(p, { t: 'notice', text }); }

  // ---------------- feed ----------------
  push(item, notify = true) {
    item.id = ++this.feedSeq; item.ts = Date.now();
    this.feed.push(item);
    if (this.feed.length > 200) this.feed.splice(0, this.feed.length - 200);
    if (notify) this.changed();
    return item;
  }
  sys(text, style) { return this.push({ kind: 'sys', text, style }, false); }

  // ---------------- images ----------------
  async sendImages(p, ids) {
    const view = this.viewFor(p);
    const visible = new Set((view.game?.cards || []).map(c => c.char?.id).filter(Boolean));
    for (const id of ids.slice(0, 20)) {
      if (!visible.has(id)) continue; // never leak your own character
      const data = await Library.imgData(id);
      if (data) this.sendTo(p, { t: 'img', id, data });
    }
  }

  // ---------------- views ----------------
  changed() {
    if (this._dirty) return;
    this._dirty = true;
    queueMicrotask(() => { this._dirty = false; this.broadcast(); });
  }

  broadcast() { for (const p of this.players) if (p.connected) this.sendTo(p, this.viewFor(p)); }

  sendTo(p, msg) {
    if (p.isHost) { this.deliverLocal(msg); return; }
    try { p.conn?.open && p.conn.send(msg); } catch (e) { console.warn('send failed', e); }
  }

  viewFor(viewer) {
    const g = this.game;
    const view = {
      t: 'state', you: viewer.pid, code: this.code, phase: this.phase,
      settings: { ...this.settings },
      players: this.players.map(p => ({ pid: p.pid, name: p.name, isHost: p.isHost, connected: p.connected, spectator: p.spectator, color: p.color, known: [...p.known] })),
      feed: this.feed.slice(-120),
      game: null,
    };
    if (g) {
      const seesAll = g.ended || !g.order.includes(viewer.pid);
      view.game = {
        round: g.round, current: g.current, ended: g.ended,
        theme: g.theme && (this.settings.theme === 'shown' || g.ended) ? g.theme : null,
        themeSecret: !!g.theme && this.settings.theme === 'secret' && !g.ended,
        turnRemaining: g.current ? Math.max(0, g.turnEndsAt - Date.now()) : 0,
        guessesLeft: Math.max(0, this.settings.guessesPerRound - (g.guessesUsed[viewer.pid] || 0)),
        cards: g.order.map(pid => {
          const c = Library.chars.get(g.assign[pid]);
          const visible = seesAll || pid !== viewer.pid || !!g.ranks[pid];
          return {
            pid,
            char: visible ? { id: c.id, n: c.n, f: c.f, fname: Library.fandomName(c.f) } : null,
            fandomHint: !visible && this.settings.revealFandom ? Library.fandomName(c.f) : null,
            sheet: g.sheets[pid].slice(),
            rank: g.ranks[pid] || null,
            usedGuess: (g.guessesUsed[pid] || 0) >= this.settings.guessesPerRound,
          };
        }),
      };
    }
    return view;
  }

  sendCatalog() {
    const fandoms = this.fandomCatalog();
    const ids = new Set(fandoms.map(f => f.id));
    this.settings.fandoms = this.settings.fandoms.filter(id => ids.has(id));
    for (const p of this.players) if (!p.isHost && p.connected) this.sendTo(p, { t: 'catalog', fandoms });
    this.changed();
  }

  fandomCatalog() {
    return Library.fandomList().map(f => ({ id: f.id, name: f.name, tags: f.tags, count: f.count }));
  }
}
