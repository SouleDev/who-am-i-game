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
  addPlayer({ clientId, name, known, checked, dropped, conn, isHost, have }) {
    let p = this.players.find(x => x.clientId === clientId);
    if (p) { // reconnect
      p.conn = conn; p.connected = true; p.name = name || p.name; p.have = new Set(have || []);
      if (known) p.known = new Set(known);
      if (checked) p.checked = new Set(checked);
      if (dropped) p.dropped = new Set(dropped);
      this.sys(`${p.name} reconnected.`);
      this.changed();
      return p;
    }
    const active = this.players.filter(x => !x.spectator);
    if (active.length >= MAX_PLAYERS && this.phase === 'lobby') return { error: 'That lobby is full (10 players max).' };
    const usedColors = new Set(this.players.map(x => x.color));
    p = {
      pid: randomId('p'), clientId, name: (name || 'Player').slice(0, 24), known: new Set(known || []), checked: new Set(checked || []), dropped: new Set(dropped || []),
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
      case 'setKnown':
        p.known = new Set((m.known || []).slice(0, 5000));
        if (Array.isArray(m.checked)) p.checked = new Set(m.checked.slice(0, 20000));
        if (Array.isArray(m.dropped)) p.dropped = new Set(m.dropped.slice(0, 20000));
        this.changed(); break;
      case 'charList': {
        // character names for fandoms (web players have no library of their own)
        const want = new Set((m.fandoms || []).slice(0, 1000));
        const chars = [...Library.chars.values()].filter(c => want.has(c.f)).slice(0, 8000).map(c => ({ id: c.id, n: c.n, f: c.f }));
        this.sendTo(p, { t: 'charList', req: m.req, chars });
        break;
      }
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
      case 'swap': {
        // players swap their own character once per game; the host may swap anyone's
        const target = isHost && m.pid ? this.player(m.pid) : p;
        if (target) this.swapCharacter(target, isHost && target !== p);
        break;
      }
    }
  }

  // Characters a player can be given: their fandoms (minus dropped) plus individually checked ones, within the game's fandoms.
  eligible(p, fandoms) {
    const fs = new Set(fandoms);
    const out = [];
    for (const f of fandoms) if (p.known.has(f)) for (const c of Library.charsIn(f)) if (!p.dropped.has(c.id)) out.push(c);
    for (const id of p.checked) { const c = Library.chars.get(id); if (c && fs.has(c.f) && !p.known.has(c.f)) out.push(c); }
    return out;
  }

  // Replace a player's character with another that fits the same rules (their fandoms + shared trait).
  swapCharacter(p, byHost) {
    const g = this.game;
    if (!g || g.ended || !g.order.includes(p.pid) || g.ranks[p.pid]) return;
    if (!byHost && (g.swapsUsed[p.pid] || 0) >= 1) return this.tell(p, 'You already used your swap this game.');
    const used = new Set(Object.values(g.assign));
    const tried = g.history[p.pid] || (g.history[p.pid] = new Set([g.assign[p.pid]]));
    const others = this.players.filter(o => o !== p && g.order.includes(o.pid));
    const options = this.eligible(p, g.fandoms)
      .filter(c => !used.has(c.id) && !tried.has(c.id) && (!g.theme || (c.t || []).includes(g.theme)));
    if (!options.length) {
      const who = byHost ? this.player(this.players.find(x => x.isHost)?.pid) : p;
      return this.tell(who || p, `No other characters fit ${byHost ? p.name + "'s" : 'your'} fandoms${g.theme ? ' and the #' + g.theme + ' trait' : ''}.`);
    }
    const c = weightedPick(shuffle(options), x => 1 + 2 * others.filter(o => o.known.has(x.f)).length);
    g.assign[p.pid] = c.id; tried.add(c.id);
    g.sheets[p.pid] = [];
    if (!byHost) g.swapsUsed[p.pid] = (g.swapsUsed[p.pid] || 0) + 1;
    this.sys(byHost ? `The host swapped ${p.name}'s character. Their sheet was cleared.` : `${p.name} swapped their character. Their sheet was cleared.`, 'reveal');
    this.changed();
  }

  // ---------------- game flow ----------------
  startGame() {
    if (this.game && !this.game.ended) return;
    const active = this.players.filter(p => p.connected);
    if (active.length < 2) return this.hostError('You need at least 2 players to start.');
    const fset = this.settings.fandoms.filter(id => Library.fandoms.has(id));
    if (!fset.length) return this.hostError('Pick at least one fandom for this round.');
    // Strict rule: a player's character only ever comes from fandoms THEY picked (and the host included).
    const cands = new Map(active.map(p => [p.pid, this.eligible(p, fset)]));
    const without = active.filter(p => !cands.get(p.pid).length);
    if (without.length) {
      const names = without.map(p => p.name).join(', ');
      return this.hostError(`${names} ${without.length > 1 ? "don't" : "doesn't"} have any characters in this game's fandoms. They need to pick fandoms or characters they know, or you can add one of their fandoms to the game.`);
    }

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
      order, assign, theme, fandoms: fset, swapsUsed: {}, history: {}, current: order[0], turnIdx: 0, round: 1, turnEndsAt: 0,
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
      // during a game only pictures you can already see; in the lobby anything (for browsing / Check or Drop)
      if (this.phase !== 'lobby' && !visible.has(id)) continue;
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
      players: this.players.map(p => ({ checkedN: p.checked.size, droppedN: p.dropped.size, pid: p.pid, name: p.name, isHost: p.isHost, connected: p.connected, spectator: p.spectator, color: p.color, known: [...p.known] })),
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
        swapsLeft: g.ranks[viewer.pid] ? 0 : Math.max(0, 1 - (g.swapsUsed[viewer.pid] || 0)),
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
    return Library.fandomList().map(f => ({ id: f.id, name: f.name, tags: f.tags, count: f.count, cat: f.cat || (f.id.startsWith("c-") ? "Custom" : "Other"), sub: f.sub || (f.id.startsWith("c-") ? "Your fandoms" : "Other") }));
  }
}
