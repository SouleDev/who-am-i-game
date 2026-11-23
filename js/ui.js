// Screens, rendering and input handling.
const Profile = {
  get() {
    const p = Store.get('profile', {});
    return { name: p.name || '', known: Array.isArray(p.known) ? p.known : [] };
  },
  set(p) { Store.set('profile', p); },
  // per-tab id so a refresh can rejoin as the same player (and test tabs stay separate)
  clientId() {
    // desktop app: survives restarts; browser: per tab
    const store = location.hostname === 'app.local' ? localStorage : sessionStorage;
    let id = store.getItem('whoami.clientId');
    if (!id) { id = randomId('c'); store.setItem('whoami.clientId', id); }
    return id;
  },
};

const TAG_LABELS = { 'top-anime': 'Top 500 anime', 'fandom-list': 'Fandom list', custom: 'Custom' };

const UI = {
  state: null,
  catalog: [],          // fandoms offered in the current lobby
  imgRequested: new Set(),
  cardHtml: new Map(),
  feedSig: {},
  settingsSig: '',
  deadline: 0, turnTotal: 30000,
  lastCurrent: null,
  resultsHidden: false,

  get me() { return this.state?.players.find(p => p.pid === this.state.you); },
  get amHost() { return Net.role === 'host'; },

  // ======================================================================
  async init() {
    await Library.load();
    const prof = Profile.get();
    $('#home-name').value = prof.name;
    this.refreshHome();

    $('#home-name').addEventListener('input', e => { const p = Profile.get(); p.name = e.target.value.trim(); Profile.set(p); });
    $('#home-edit-fandoms').onclick = () => this.editMyFandoms(this.localCatalog());
    $('#home-host').onclick = () => this.host();
    $('#home-join').onclick = () => this.join();
    $('#home-code').addEventListener('keydown', e => { if (e.key === 'Enter') this.join(); });
    $('#home-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    $('#home-custom').onclick = () => this.openCustomEditor();
    $('#home-how').onclick = () => this.openHowTo();

    $('#lobby-copy-code').onclick = async () => { await copyText(this.state.code); toast('Code copied!', 'good'); };
    $('#lobby-copy-link').onclick = async () => { await copyText(this.inviteUrl()); toast('Invite link copied!', 'good'); };
    $('#lobby-leave').onclick = () => this.leave();
    $('#lobby-my-fandoms').onclick = () => this.editMyFandoms(this.catalog);
    $('#lobby-start').onclick = () => Net.send({ t: 'start' });
    this.bindChat('#lobby-chat');
    this.bindChat('#game-chat');

    $('#game-leave').onclick = () => { if (confirm('Leave this game?')) this.leave(); };
    $('#game-add-time').onclick = () => Net.send({ t: 'addTime' });
    $('#game-skip').onclick = () => Net.send({ t: 'skipTurn' });
    $('#game-end').onclick = () => { if (confirm('End the game now? Everyone still guessing shares the remaining places.')) Net.send({ t: 'endGame' }); };
    $('#game-end-turn').onclick = () => Net.send({ t: 'endTurn' });
    $('#game-give-up').onclick = () => {
      if (confirm('Give up? Your character is revealed and you take the last open place.')) Net.send({ t: 'giveUp' });
    };
    $('#game-note').addEventListener('submit', e => {
      e.preventDefault();
      const inp = e.target.querySelector('input');
      if (inp.value.trim()) Net.send({ t: 'noteAdd', text: inp.value.trim() });
      inp.value = '';
    });
    $('#game-guess').addEventListener('submit', e => {
      e.preventDefault();
      const inp = e.target.querySelector('input');
      const text = inp.value.trim();
      if (!text) return;
      if (!confirm(`Lock in your guess: "${text}"?`)) return;
      Net.send({ t: 'guess', text });
      inp.value = '';
    });
    $('#game-board').addEventListener('click', e => {
      const b = e.target.closest('[data-del]');
      if (b) Net.send({ t: 'noteDel', index: +b.dataset.del });
    });
    const feedClick = e => {
      const b = e.target.closest('[data-override]');
      if (b) Net.send({ t: 'override', feedId: +b.dataset.override });
    };
    $('#game-feed').addEventListener('click', feedClick);

    Net.onMessage = m => this.onMessage(m);
    Net.onClosed = reason => { toast(reason, 'bad', 6000); this.leave(true); };
    setInterval(() => this.tickTimer(), 200);

    // invite links: …#join=CODE
    const m = location.hash.match(/join=([A-Za-z0-9]{4,8})/);
    if (m) {
      $('#home-code').value = m[1].toUpperCase();
      history.replaceState(null, '', location.pathname + location.search);
      if (prof.name) this.join(); else { $('#home-name').focus(); toast('Enter your name, then press Join.'); }
    }
  },

  refreshHome() {
    const prof = Profile.get();
    const n = prof.known.length;
    const canPick = this.localCatalog().length > 0;
    $('#home-edit-fandoms').classList.toggle('hidden', !canPick);
    $('#home-known-summary').textContent = !canPick
      ? "You'll choose the fandoms you know after you join a lobby (the host's game has the list)."
      : n ? `${n} fandom${n === 1 ? '' : 's'} selected` : 'None selected yet. Pick the fandoms whose characters you know.';
    $('#home-lib').textContent = Library.hasPack || Library.size
      ? `Library: ${Library.size.toLocaleString()} characters in ${Library.fandoms.size} fandoms.`
      : 'Web player: no picture pack on this device. The host sends the pictures during the game.';
  },

  localCatalog() {
    const map = new Map();
    for (const f of Library.remoteFandoms.values()) map.set(f.id, f);
    for (const f of Library.fandomList()) map.set(f.id, f);
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  },

  show(name) {
    for (const s of $$('.screen')) s.classList.toggle('hidden', s.id !== 'screen-' + name);
  },

  busy(text) {
    $('#busy').classList.toggle('hidden', !text);
    if (text) $('#busy-text').textContent = text;
  },

  needName() {
    const name = $('#home-name').value.trim();
    if (!name) { toast('Enter your name first.', 'bad'); $('#home-name').focus(); return null; }
    const p = Profile.get(); p.name = name; Profile.set(p);
    return name;
  },

  async host() {
    if (!this.needName()) return;
    if (!Library.size) return toast('This copy has no characters. Download the full game (or add custom characters) to host.', 'bad', 6000);
    if (!Profile.get().known.length) toast('Tip: pick the fandoms you know so the game can choose fair characters.');
    this.busy('Creating lobby…');
    try {
      await Net.hostLobby();
      this.catalog = Net.host.fandomCatalog();
      this.enterSession();
    } catch (e) { toast(e.message, 'bad', 6000); }
    finally { this.busy(null); }
  },

  async join() {
    if (!this.needName()) return;
    const code = $('#home-code').value.trim().toUpperCase();
    if (code.length !== 6) return toast('Lobby codes are 6 characters.', 'bad');
    this.busy('Joining lobby ' + code + '…');
    try {
      const w = await Net.joinLobby(code);
      this.catalog = w.fandoms || [];
      this.enterSession();
    } catch (e) { toast(e.message, 'bad', 6000); }
    finally { this.busy(null); }
  },

  enterSession() {
    this.imgRequested.clear(); this.cardHtml.clear(); this.feedSig = {}; this.settingsSig = '';
    this.lastCurrent = null; this.resultsHidden = false; this.askedFandoms = false;
    if (this.state) this.render(); else this.show('lobby');
  },

  leave(silent) {
    Net.leave();
    this.state = null;
    $('#results').classList.add('hidden');
    this.closeModal();
    this.show('home');
    this.refreshHome();
  },

  inviteUrl() {
    if (!this.state) return null;
    const cfg = window.WHOAMI_CONFIG || {};
    if (cfg.webClientUrl) return cfg.webClientUrl.replace(/#.*$/, '') + '#join=' + this.state.code;
    if (/^https?:$/.test(location.protocol) && location.hostname !== 'app.local') return location.origin + location.pathname + '#join=' + this.state.code;
    return null;
  },

  bindChat(sel) {
    $(sel).addEventListener('submit', e => {
      e.preventDefault();
      const inp = e.target.querySelector('input');
      if (inp.value.trim()) Net.send({ t: 'chat', text: inp.value.trim() });
      inp.value = '';
    });
  },

  // ======================================================================
  onMessage(m) {
    switch (m.t) {
      case 'state': {
        const prev = this.state;
        this.state = m;
        if (prev?.phase !== m.phase) { this.resultsHidden = false; this.cardHtml.clear(); }
        this.render();
        break;
      }
      case 'img':
        Library.received.set(m.id, m.data);
        this.cardHtml.clear();
        if (this.state) this.render();
        break;
      case 'notice': toast(m.text, 'bad'); break;
      case 'catalog': this.catalog = m.fandoms; Library.rememberRemoteFandoms(m.fandoms); this.settingsSig = ''; this.render(); break;
      case 'kicked': toast('The host removed you from the lobby.', 'bad', 6000); this.leave(true); break;
      case 'closed': toast('The host closed the lobby.', 'bad', 6000); this.leave(true); break;
    }
  },

  render() {
    const s = this.state;
    if (!s) return;
    if (s.phase === 'lobby') { this.show('lobby'); this.renderLobby(); }
    else { this.show('game'); this.renderGame(); }
  },

  pname(pid) { return this.state.players.find(p => p.pid === pid)?.name || '???'; },
  pcolor(pid) { return this.state.players.find(p => p.pid === pid)?.color || '#999'; },

  // ======================================================================
  //  LOBBY
  // ======================================================================
  renderLobby() {
    const s = this.state;
    $('#lobby-code').textContent = s.code;
    $('#lobby-copy-link').classList.toggle('hidden', !this.inviteUrl());
    const active = s.players.filter(p => p.connected);
    $('#lobby-count').textContent = `(${active.length}/${MAX_PLAYERS})`;
    const catIds = new Set(this.catalog.map(f => f.id));
    $('#lobby-players').innerHTML = s.players.map(p => `
      <li>
        <span class="dot" style="background:${p.color}"></span>
        <span class="grow"><b>${esc(p.name)}</b>${p.pid === s.you ? ' <span class="muted">(you)</span>' : ''}
          <div class="muted small">${(k => `${k} fandom${k === 1 ? "" : "s"} known`)(p.known.filter(id => catIds.has(id)).length)}</div></span>
        ${p.isHost ? '<span class="badge host">HOST</span>' : ''}
        ${!p.connected ? '<span class="badge off">offline</span>' : ''}
        ${this.amHost && !p.isHost ? `<button class="btn ghost small" data-kick="${p.pid}" title="Remove player">✕</button>` : ''}
      </li>`).join('');
    for (const b of $$('[data-kick]', $('#lobby-players'))) b.onclick = () => { if (confirm('Remove this player?')) Net.send({ t: 'kick', pid: b.dataset.kick }); };

    // "Your fandoms" box — prominent, and opens the picker automatically the first time if you know none.
    const me = s.players.find(p => p.pid === s.you);
    const myCount = me ? me.known.filter(id => catIds.has(id)).length : 0;
    const box = $('#lobby-my-known');
    box.classList.toggle('warn', myCount === 0);
    box.innerHTML = myCount
      ? `<span class="grow">You know <b>${myCount}</b> of this lobby's fandoms.</span><button class="btn small" data-pick-known>Change…</button>`
      : `<span class="grow"><b>Pick the fandoms you know</b><div class="small muted">So you get a character you can guess, and can answer about others.</div></span><button class="btn primary small" data-pick-known>Choose fandoms…</button>`;
    box.querySelector('[data-pick-known]').onclick = () => this.editMyFandoms(this.catalog);
    if (!this.askedFandoms && myCount === 0 && this.catalog.length && !$('#modal-root').children.length) {
      this.askedFandoms = true;
      setTimeout(() => this.editMyFandoms(this.catalog), 300);
    }

    this.renderSettings();
    $('#lobby-start-wrap').classList.toggle('hidden', !this.amHost);
    $('#lobby-wait').classList.toggle('hidden', this.amHost);
    $('#lobby-start').disabled = active.length < 2 || !s.settings.fandoms.length;
    $('#lobby-start').textContent = active.length < 2 ? 'Waiting for players…' : !s.settings.fandoms.length ? 'Choose round fandoms first' : `Start game (${active.length} players)`;
    this.renderFeed('#lobby-feed');
  },

  renderSettings() {
    const s = this.state, st = s.settings, box = $('#lobby-settings');
    const sig = JSON.stringify([st, s.players.map(p => [p.pid, p.known.length]), this.amHost]);
    if (sig === this.settingsSig || box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    this.settingsSig = sig;
    const names = st.fandoms.map(id => this.catalog.find(f => f.id === id)?.name || Library.fandomName(id)).sort();
    const pool = st.fandoms.reduce((n, id) => n + (this.catalog.find(f => f.id === id)?.count || 0), 0);
    const dis = this.amHost ? '' : 'disabled';
    box.innerHTML = `
      <div class="setting"><label>Turn timer (seconds)<div class="muted small">How long each player's turn lasts.</div></label>
        <input type="number" id="set-turn" min="10" max="300" step="5" value="${st.turnSeconds}" ${dis}></div>
      <div class="setting"><label>Guesses per round<div class="muted small">A round ends after everyone has had a turn.</div></label>
        <input type="number" id="set-guesses" min="1" max="5" value="${st.guessesPerRound}" ${dis}></div>
      <div class="setting"><label>Easy mode: tell players their own fandom<div class="muted small">Off by default. Players have to work out their fandom themselves.</div></label>
        <input type="checkbox" id="set-reveal" ${st.revealFandom ? 'checked' : ''} ${dis}></div>
      <div class="setting" style="border:0"><label>Fandoms this game<div class="muted small">${st.fandoms.length} fandoms · ${pool.toLocaleString()} characters. Players get characters from fandoms they know when possible.</div></label>
        ${this.amHost ? '<button id="set-fandoms" class="btn">Choose…</button>' : ''}</div>
      <div class="fandom-summary">${names.slice(0, 60).map(n => `<span class="chip">${esc(n)}</span>`).join('') || '<span class="muted small">None selected yet.</span>'}${names.length > 60 ? `<span class="chip">+${names.length - 60} more</span>` : ''}</div>`;
    if (!this.amHost) return;
    const num = (id, key) => $('#' + id).addEventListener('change', e => Net.send({ t: 'settings', [key]: +e.target.value }));
    num('set-turn', 'turnSeconds');
    num('set-guesses', 'guessesPerRound');
    $('#set-reveal').addEventListener('change', e => Net.send({ t: 'settings', revealFandom: e.target.checked }));
    $('#set-fandoms').onclick = () => this.openFandomPicker({
      title: 'Fandoms for this game',
      catalog: this.catalog,
      selected: new Set(st.fandoms),
      players: s.players.filter(p => p.connected),
      onSave: sel => Net.send({ t: 'settings', fandoms: [...sel] }),
    });
  },

  editMyFandoms(catalog) {
    const prof = Profile.get();
    this.openFandomPicker({
      title: 'Fandoms you know',
      subtitle: 'You will get characters from these fandoms when possible, and others can count on you to answer questions about them.',
      catalog,
      selected: new Set(prof.known),
      onSave: sel => {
        const inCat = new Set(catalog.map(f => f.id));
        const keep = prof.known.filter(id => !inCat.has(id));
        const p = Profile.get(); p.known = [...new Set([...keep, ...sel])]; Profile.set(p);
        this.refreshHome();
        if (Net.role) Net.send({ t: 'setKnown', known: p.known });
      },
    });
  },

  // ======================================================================
  //  GAME
  // ======================================================================
  renderGame() {
    const s = this.state, g = s.game;
    if (!g) return;
    const me = this.me;
    const myCard = g.cards.find(c => c.pid === s.you);
    const playing = !!myCard;
    const myTurn = g.current === s.you && !g.ended;

    $('#game-round').textContent = g.round;
    $('#game-code').textContent = s.code;
    $('#game-turn-label').innerHTML = g.ended ? 'Game over!'
      : !g.current ? 'Waiting for players to reconnect…'
      : myTurn ? '<span style="color:var(--accent2)">Your turn!</span> Ask questions, add notes, or guess.'
      : `<span style="color:${this.pcolor(g.current)}">${esc(this.pname(g.current))}</span>'s turn`;
    this.turnTotal = s.settings.turnSeconds * 1000;
    this.deadline = g.current ? performance.now() + g.turnRemaining : 0;
    if (g.current !== this.lastCurrent) {
      if (myTurn) { toast('Your turn!', 'turn'); setTimeout(() => $('#game-note input').focus(), 50); }
      this.lastCurrent = g.current;
    }
    $('#game-host-controls').classList.toggle('hidden', !this.amHost || g.ended);

    // board
    const board = $('#game-board');
    const want = [];
    const seen = new Set();
    for (const c of g.cards) {
      seen.add(c.pid);
      const html = this.cardMarkup(c, g, myTurn);
      let node = board.querySelector(`[data-pid="${c.pid}"]`);
      if (!node) { node = el(`<div class="card" data-pid="${c.pid}"></div>`); board.appendChild(node); }
      if (this.cardHtml.get(c.pid) !== html) { node.innerHTML = html; this.cardHtml.set(c.pid, html); }
      node.className = 'card' + (c.pid === g.current ? ' turn' : '') + (c.pid === s.you ? ' me' : '') + (c.rank ? ' ranked' : '');
      if (c.char && !Library.imgSrc(c.char.id) && !this.imgRequested.has(c.char.id)) want.push(c.char.id);
    }
    for (const n of $$('.card', board)) if (!seen.has(n.dataset.pid)) n.remove();
    // keep DOM order = turn order
    g.cards.forEach((c, i) => { const n = board.querySelector(`[data-pid="${c.pid}"]`); if (board.children[i] !== n) board.insertBefore(n, board.children[i]); });
    if (want.length) { want.forEach(id => this.imgRequested.add(id)); Net.send({ t: 'needImg', ids: want }); }

    // actions
    const acts = $('#game-actions');
    acts.classList.toggle('hidden', !playing || g.ended);
    acts.classList.toggle('my-turn', myTurn);
    if (playing) {
      const done = !!myCard.rank;
      $('#game-note input').disabled = $('#game-note button').disabled = !myTurn;
      $('#game-note input').placeholder = myTurn ? 'Add a keyword or phrase to your sheet…' : 'You can add notes to your sheet on your turn.';
      $('#game-guess input').disabled = $('#game-guess button').disabled = done || g.guessesLeft <= 0;
      $('#game-end-turn').disabled = !myTurn;
      $('#game-give-up').disabled = done;
      $('#game-guess-info').textContent = done
        ? `You finished ${placeLabel(myCard.rank.place)}. Keep helping the others!`
        : g.guessesLeft > 0 ? `${g.guessesLeft} guess${g.guessesLeft === 1 ? '' : 'es'} left this round. Wrong guesses don't knock you out.`
        : 'You used your guess for this round. Keep asking questions!';
    }
    this.renderFeed('#game-feed');
    this.renderResults();
  },

  cardMarkup(c, g, myTurn) {
    const s = this.state, isMe = c.pid === s.you, p = s.players.find(x => x.pid === c.pid) || {};
    let pic;
    if (c.char) {
      const src = Library.imgSrc(c.char.id);
      pic = src ? `<img src="${esc(src)}" alt="" draggable="false">` : '<div class="loading">Loading picture…</div>';
    } else pic = '<div class="mystery">?</div>';
    const name = c.char ? esc(c.char.n) : isMe ? 'Who are you?' : '???';
    const fandom = c.char ? esc(c.char.fname) : c.fandomHint ? 'From: ' + esc(c.fandomHint) : 'Unknown fandom';
    const canEdit = isMe && myTurn;
    const notes = c.sheet.length
      ? c.sheet.map((n, i) => `<span class="note">${esc(n)}${canEdit ? `<button data-del="${i}" title="Remove">×</button>` : ''}</span>`).join('')
      : `<span class="empty">${isMe ? 'Your sheet is empty. Add notes on your turn.' : 'No notes yet'}</span>`;
    return `
      <div class="pic">${pic}
        ${c.pid === g.current ? '<span class="turn-flag">TURN</span>' : ''}
        ${c.rank ? `<span class="medal" title="${placeLabel(c.rank.place)} place">${c.rank.how === 'guessed' ? medal(c.rank.place) : '🏳️'}</span>` : ''}
      </div>
      <div class="info">
        <div class="cname">${name}</div>
        <div class="cfandom">${fandom}</div>
        <div class="pname"><span class="dot" style="background:${p.color}"></span><b>${esc(p.name || '?')}</b>${isMe ? ' <span class="muted">(you)</span>' : ''}
          ${!p.connected ? '<span class="badge off">offline</span>' : ''}
          ${c.rank ? `<span class="badge">${placeLabel(c.rank.place)}</span>` : c.usedGuess ? '<span class="badge">guessed</span>' : ''}</div>
      </div>
      <div class="sheet">${notes}</div>`;
  },

  renderFeed(sel) {
    const box = $(sel), s = this.state;
    const sig = s.feed.map(f => f.id + (f.ok ? 'y' : '')).join(',') + (this.amHost ? 'h' : '') + JSON.stringify(s.game?.cards.map(c => !!c.rank) || []);
    if (this.feedSig[sel] === sig) return;
    this.feedSig[sel] = sig;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const rankedPids = new Set((s.game?.cards || []).filter(c => c.rank).map(c => c.pid));
    box.innerHTML = s.feed.map(f => {
      if (f.kind === 'sys') return `<div class="item sys ${f.style || ''}">${esc(f.text)}</div>`;
      const who = `<span class="who" style="color:${this.pcolor(f.pid)}">${esc(this.pname(f.pid))}</span>`;
      if (f.kind === 'chat') return `<div class="item">${who}${esc(f.text)}</div>`;
      const override = this.amHost && !f.ok && !rankedPids.has(f.pid) && s.game && !s.game.ended
        ? ` <button class="btn ghost small" data-override="${f.id}" title="Count this guess as correct">Accept</button>` : '';
      return `<div class="item guess ${f.ok ? 'ok' : ''}">${who}guessed “${esc(f.text)}” — ${f.ok ? (f.overridden ? '✔ accepted by host' : '✔ correct!') : '✘ not quite'}${override}</div>`;
    }).join('');
    if (atBottom || box.dataset.init !== '1') box.scrollTop = box.scrollHeight;
    box.dataset.init = '1';
  },

  tickTimer() {
    if (!this.state?.game || !this.deadline) {
      $('#game-timer-num').textContent = '–'; $('#game-timer-bar').style.width = '0%'; return;
    }
    const left = Math.max(0, this.deadline - performance.now());
    const secs = Math.ceil(left / 1000);
    $('#game-timer-num').textContent = secs;
    const pct = Math.min(100, left / this.turnTotal * 100);
    $('#game-timer-bar').style.width = pct + '%';
    $('#game-timer-bar').classList.toggle('low', secs <= 5);
  },

  renderResults() {
    const s = this.state, g = s.game, box = $('#results');
    if (s.phase !== 'results' || this.resultsHidden) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const rows = g.cards.slice().sort((a, b) => a.rank.place - b.rank.place).map(c => {
      const src = c.char && Library.imgSrc(c.char.id);
      const how = c.rank.how === 'guessed' ? `guessed it in round ${c.rank.round}` : c.rank.how === 'gave up' ? 'gave up' : 'still guessing when the game ended';
      return `<div class="rowp ${c.rank.place <= 3 && c.rank.how === 'guessed' ? 'top' : ''}">
        <div class="place">${c.rank.how === 'guessed' ? medal(c.rank.place) : ''}<div class="small">${placeLabel(c.rank.place)}</div></div>
        ${src ? `<img src="${esc(src)}" alt="">` : '<img alt="">'}
        <div class="grow"><b style="color:${this.pcolor(c.pid)}">${esc(this.pname(c.pid))}</b> was <b>${esc(c.char?.n || '?')}</b>
          <div class="muted small">${esc(c.char?.fname || '')} · ${how}</div></div></div>`;
    }).join('');
    box.innerHTML = `<div class="box">
      <h1>🏆 Results</h1>
      <div class="podium">${rows}</div>
      <div class="row" style="justify-content:center">
        <button class="btn" id="res-view">View board</button>
        ${this.amHost ? '<button class="btn primary big" id="res-again">Back to lobby</button>' : '<span class="muted">Waiting for the host to start another game…</span>'}
        <button class="btn danger" id="res-leave">Leave</button>
      </div></div>`;
    $('#res-view').onclick = () => { this.resultsHidden = true; box.classList.add('hidden'); toast('Results hidden. They come back when the host starts a new lobby.'); };
    $('#res-leave').onclick = () => this.leave();
    if (this.amHost) $('#res-again').onclick = () => Net.send({ t: 'toLobby' });
  },

  // ======================================================================
  //  MODALS
  // ======================================================================
  openModal(html) {
    this.closeModal();
    const bg = el(`<div class="modal-bg"><div class="modal">${html}</div></div>`);
    $('#modal-root').appendChild(bg);
    return bg.firstElementChild;
  },
  closeModal() { $('#modal-root').innerHTML = ''; },

  openFandomPicker({ title, subtitle, catalog, selected, players, onSave }) {
    const sel = new Set(selected);
    let filter = 'all', query = '';
    const knownBy = id => players ? players.filter(p => p.known.includes(id)).length : 0;
    const tags = [...new Set(catalog.flatMap(f => f.tags || []))];
    const m = this.openModal(`
      <header><h2>${esc(title)}</h2><input id="fp-q" placeholder="Search fandoms…" style="width:260px"></header>
      ${subtitle ? `<p class="muted small" style="padding:0 18px;margin:0 0 8px">${esc(subtitle)}</p>` : ''}
      <div class="filters">
        <button class="btn small on" data-f="all">All (${catalog.length})</button>
        <button class="btn small" data-f="selected">Selected</button>
        ${tags.map(t => `<button class="btn small" data-f="${esc(t)}">${esc(TAG_LABELS[t] || t)}</button>`).join('')}
        ${players ? '<span class="grow"></span><button class="btn small ghost" data-q="anyone">Select: known by anyone</button><button class="btn small ghost" data-q="everyone">Select: known by everyone</button>' : ''}
      </div>
      <div class="body"><div class="fandom-list" id="fp-list"></div></div>
      <footer><button class="btn ghost small" id="fp-all">Select shown</button><button class="btn ghost small" id="fp-none">Clear shown</button>
        <span class="grow muted small" id="fp-count"></span><button class="btn" id="fp-cancel">Cancel</button><button class="btn primary" id="fp-save">Save</button></footer>`);
    const shown = () => catalog.filter(f =>
      (filter === 'all' || (filter === 'selected' ? sel.has(f.id) : (f.tags || []).includes(filter))) &&
      (!query || f.name.toLowerCase().includes(query)));
    const draw = () => {
      $('#fp-list', m).innerHTML = shown().map(f => {
        const k = knownBy(f.id);
        return `<label><input type="checkbox" data-id="${esc(f.id)}" ${sel.has(f.id) ? 'checked' : ''}>
          <span class="fname" title="${esc(f.name)}">${esc(f.name)}</span>
          ${players ? `<span class="who" title="Players who know this fandom">${k ? '👤' + k : ''}</span>` : ''}
          <span class="cnt">${f.count || ''}</span></label>`;
      }).join('') || '<p class="muted">No fandoms match.</p>';
      $('#fp-count', m).textContent = `${sel.size} selected`;
    };
    $('#fp-list', m).addEventListener('change', e => {
      const id = e.target.dataset.id; if (!id) return;
      e.target.checked ? sel.add(id) : sel.delete(id);
      $('#fp-count', m).textContent = `${sel.size} selected`;
    });
    $('#fp-q', m).addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); draw(); });
    for (const b of $$('[data-f]', m)) b.onclick = () => { filter = b.dataset.f; $$('[data-f]', m).forEach(x => x.classList.toggle('on', x === b)); draw(); };
    for (const b of $$('[data-q]', m)) b.onclick = () => {
      sel.clear();
      for (const f of catalog) { const k = knownBy(f.id); if (b.dataset.q === 'anyone' ? k > 0 : k === players.length) sel.add(f.id); }
      draw();
    };
    $('#fp-all', m).onclick = () => { shown().forEach(f => sel.add(f.id)); draw(); };
    $('#fp-none', m).onclick = () => { shown().forEach(f => sel.delete(f.id)); draw(); };
    $('#fp-cancel', m).onclick = () => this.closeModal();
    $('#fp-save', m).onclick = () => { onSave(sel); this.closeModal(); };
    draw();
    $('#fp-q', m).focus();
  },

  openHowTo() {
    const m = this.openModal(`<header><h2>How to play</h2></header><div class="body how">
      <ol>
        <li><b>Set up:</b> enter your name and tick the fandoms you know. One person hosts and shares the <b>6-character lobby code</b>. Up to 10 players.</li>
        <li><b>Characters:</b> when the game starts, everyone gets a secret character from the host's chosen fandoms. Where possible it comes from a fandom you know. You can see everyone's character except your own.</li>
        <li><b>Turns:</b> players take turns in order, ${'30'} seconds each by default. On your turn, ask the others yes/no questions (voice or chat) and add keywords or phrases to your <b>sheet</b>. Everyone can see every sheet.</li>
        <li><b>Guessing:</b> you get one guess per round (a round is everyone taking one turn). You can guess at any time. A wrong guess doesn't knock you out, so keep asking.</li>
        <li><b>Ranking:</b> the first person to guess right takes 1st place, then 2nd, then 3rd, and so on.</li>
        <li><b>Give up:</b> the give-up button reveals your character right away and puts you in the last open place.</li>
        <li><b>Host tools:</b> the host can add 15 seconds, skip a turn, accept a near-miss guess, or end the game.</li>
      </ol>
      <p class="muted small">Only the host needs the character pictures. Players who are missing one get it from the host automatically, including any custom characters the host has added.</p>
    </div><footer><button class="btn primary" id="how-ok">Got it</button></footer>`);
    $('#how-ok', m).onclick = () => this.closeModal();
  },

  openCustomEditor() {
    let current = Library.custom.fandoms[0]?.id || '';
    const m = this.openModal(`
      <header><h2>Custom characters</h2></header>
      <div class="body">
        <p class="muted small" style="margin-top:0">Add your own characters, such as your friend group or fandoms that aren't included. They're saved on this device. Only the host needs them: pictures are sent to the other players during the game.</p>
        <div class="row" style="flex-wrap:wrap">
          <select id="cu-fandom" class="grow"></select>
          <button class="btn danger small" id="cu-del-f">Delete fandom</button>
        </div>
        <div class="row" style="margin-top:8px">
          <input id="cu-new-f" class="grow" placeholder="New fandom name…" maxlength="60"><button class="btn" id="cu-add-f">Create fandom</button>
        </div>
        <hr style="border-color:var(--line);margin:14px 0">
        <div class="row" style="flex-wrap:wrap">
          <input id="cu-name" placeholder="Character name" maxlength="60" style="flex:1 1 180px">
          <input id="cu-alias" placeholder="Other names (comma separated)" maxlength="200" style="flex:1 1 220px">
          <input id="cu-file" type="file" accept="image/*" style="flex:1 1 200px">
          <button class="btn primary" id="cu-add">Add character</button>
        </div>
        <div class="row" style="margin-top:8px"><span class="muted small grow">Or add many at once. Each picture's file name becomes the character's name.</span>
          <label class="btn small">Bulk add pictures…<input id="cu-bulk" type="file" accept="image/*" multiple hidden></label></div>
        <div id="cu-grid" class="custom-grid"></div>
      </div>
      <footer><button class="btn primary" id="cu-done">Done</button></footer>`);
    const drawFandoms = () => {
      const custom = Library.custom.fandoms;
      const builtIns = Library.fandomList().filter(f => !f.id.startsWith('c-'));
      if (!current && custom[0]) current = custom[0].id;
      $('#cu-fandom', m).innerHTML =
        (custom.length ? `<optgroup label="Your fandoms">${custom.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</optgroup>` : '') +
        `<optgroup label="Add to an included fandom">${builtIns.map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</optgroup>`;
      if (!current) current = builtIns[0]?.id || '';
      $('#cu-fandom', m).value = current;
      $('#cu-del-f', m).disabled = !current.startsWith('c-');
      drawGrid();
    };
    const drawGrid = () => {
      const list = Library.custom.characters.filter(c => c.f === current);
      $('#cu-grid', m).innerHTML = list.map(c => `<div class="cc"><img src="${c.data}" alt=""><div><b>${esc(c.n)}</b></div>
        <button class="btn danger small" data-del="${c.id}" title="Delete">✕</button></div>`).join('')
        || '<p class="muted small">No custom characters in this fandom yet.</p>';
    };
    $('#cu-fandom', m).onchange = e => { current = e.target.value; $('#cu-del-f', m).disabled = !current.startsWith('c-'); drawGrid(); };
    $('#cu-add-f', m).onclick = async () => {
      const name = $('#cu-new-f', m).value.trim();
      if (!name) return toast('Name the fandom first.', 'bad');
      const f = await Library.addCustomFandom(name);
      current = f.id; $('#cu-new-f', m).value = ''; drawFandoms();
    };
    $('#cu-del-f', m).onclick = async () => {
      if (!current.startsWith('c-') || !confirm('Delete this fandom and all its custom characters?')) return;
      await Library.deleteCustomFandom(current); current = ''; drawFandoms(); this.refreshHome();
    };
    $('#cu-add', m).onclick = async () => {
      const name = $('#cu-name', m).value.trim(), file = $('#cu-file', m).files[0];
      if (!current) return toast('Create or choose a fandom first.', 'bad');
      if (!name || !file) return toast('A character needs a name and a picture.', 'bad');
      try {
        const data = await fileToResizedDataURL(file);
        const aliases = $('#cu-alias', m).value.split(',').map(s => s.trim()).filter(Boolean);
        await Library.addCustomCharacter(current, name, aliases, data);
        $('#cu-name', m).value = ''; $('#cu-alias', m).value = ''; $('#cu-file', m).value = '';
        drawGrid(); this.refreshHome(); toast(`Added ${name}.`, 'good');
      } catch (e) { toast(e.message, 'bad'); }
    };
    $('#cu-bulk', m).onchange = async e => {
      if (!current) return toast('Create or choose a fandom first.', 'bad');
      let n = 0;
      for (const file of e.target.files) {
        try {
          const data = await fileToResizedDataURL(file);
          const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
          await Library.addCustomCharacter(current, name, [], data); n++;
        } catch { }
      }
      e.target.value = ''; drawGrid(); this.refreshHome(); toast(`Added ${n} characters.`, 'good');
    };
    $('#cu-grid', m).addEventListener('click', async e => {
      const b = e.target.closest('[data-del]'); if (!b) return;
      await Library.deleteCustomCharacter(b.dataset.del); drawGrid(); this.refreshHome();
    });
    $('#cu-done', m).onclick = () => {
      this.closeModal();
      if (Net.host) { this.catalog = Net.host.fandomCatalog(); this.settingsSig = ''; Net.host.sendCatalog(); }
    };
    drawFandoms();
  },
};

UI.init();
