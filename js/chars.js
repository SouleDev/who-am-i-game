// Individual character picks: the "Characters" tab in the picker and the Check or Drop deck.

// Where character names and pictures come from: this device's library, or the host (web players in a lobby).
const CharSource = {
  pending: new Map(),
  seq: 0,
  cache: new Map(), // fandom id -> [{id, n, f}]

  canBrowse() { return Library.hasPack || Net.role === 'client'; },

  async list(fids) {
    const need = fids.filter(f => !this.cache.has(f));
    if (need.length) {
      if (Library.hasPack || Net.role === 'host') {
        for (const f of need) this.cache.set(f, Library.charsIn(f).map(c => ({ id: c.id, n: c.n, f: c.f })));
      } else if (Net.role === 'client') {
        const req = ++this.seq;
        const got = await new Promise(res => {
          this.pending.set(req, res);
          Net.send({ t: 'charList', fandoms: need, req });
          setTimeout(() => { if (this.pending.has(req)) { this.pending.delete(req); res([]); } }, 15000);
        });
        for (const f of need) this.cache.set(f, []);
        for (const c of got) this.cache.get(c.f)?.push(c);
      }
    }
    return fids.flatMap(f => this.cache.get(f) || []);
  },

  resolve(m) { const r = this.pending.get(m.req); if (r) { this.pending.delete(m.req); r(m.chars || []); } },

  requested: new Set(),
  img(id) {
    const src = Library.imgSrc(id);
    if (src) return src;
    if (Net.role === 'client' && !this.requested.has(id)) { this.requested.add(id); Net.send({ t: 'needImg', ids: [id] }); }
    return null;
  },
};

const CharUI = {
  // Characters tab inside the picker.
  mountTab(body, ctx) {
    const { catalog, sel, prefs, onChange, openDeck } = ctx;
    if (!CharSource.canBrowse()) {
      body.innerHTML = `<p class="muted center" style="padding:30px">Join a lobby to browse characters. The host's game supplies the list and the pictures.</p>`;
      return;
    }
    const groups = FANDOM_CATEGORIES.map(c => ({ c, items: catalog.filter(f => fandomCat(f) === c.id).sort((a, b) => a.name.localeCompare(b.name)) })).filter(g => g.items.length);
    const first = ctx.fandom || catalog.find(f => sel.has(f.id))?.id || groups[0]?.items[0]?.id;
    body.innerHTML = `
      <div class="cod-launch">
        <div class="grow"><b>Check or Drop</b><div class="muted small">See characters one at a time. Tap the right side if you know them, the left side if you don't.</div></div>
        <button class="btn primary" data-deck>▶ Start Check or Drop</button>
      </div>
      <div class="row" style="margin:10px 0">
        <span class="muted small">Browse a fandom:</span>
        <select id="ct-fandom" class="grow">${groups.map(g => `<optgroup label="${esc(g.c.id)}">${g.items.map(f => `<option value="${esc(f.id)}" ${f.id === first ? 'selected' : ''}>${esc(f.name)}${sel.has(f.id) ? ' ✓' : ''}</option>`).join('')}</optgroup>`).join('')}</select>
      </div>
      <p class="muted small" id="ct-hint" style="margin:0 0 8px"></p>
      <div class="ct-grid" id="ct-grid"><p class="muted">Loading…</p></div>`;
    const grid = $('#ct-grid', body), select = $('#ct-fandom', body);
    let current = first, chars = [];
    const card = c => {
      const viaFandom = sel.has(c.f);
      const state = prefs.checked.has(c.id) ? 'on' : prefs.dropped.has(c.id) ? 'off' : viaFandom ? 'inc' : '';
      const src = CharSource.img(c.id);
      return `<div class="ct-card ${state}" data-cid="${esc(c.id)}">
        <div class="ct-pic">${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : '<span class="muted small">…</span>'}</div>
        <div class="ct-name" title="${esc(c.n)}">${esc(c.n)}</div>
        <div class="ct-btns"><button class="ct-x" data-act="drop" title="Drop: I don't know them">✗</button><button class="ct-v" data-act="check" title="Check: I know them">✓</button></div>
      </div>`;
    };
    const drawGrid = () => {
      const viaFandom = sel.has(current);
      $('#ct-hint', body).textContent = viaFandom
        ? 'You picked this whole fandom, so these are all in your pool unless you drop them (✗).'
        : "You didn't pick this fandom. Check (✓) any characters you know to add just them.";
      grid.innerHTML = chars.map(card).join('') || '<p class="muted">No characters.</p>';
    };
    const load = async () => { grid.innerHTML = '<p class="muted">Loading…</p>'; chars = (await CharSource.list([current])).sort((a, b) => a.n.localeCompare(b.n)); drawGrid(); };
    select.onchange = () => { current = select.value; ctx.fandom = current; load(); };
    grid.onclick = e => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const id = b.closest('[data-cid]').dataset.cid;
      if (b.dataset.act === 'check') { prefs.dropped.delete(id); prefs.checked.has(id) ? prefs.checked.delete(id) : prefs.checked.add(id); }
      else { prefs.checked.delete(id); prefs.dropped.has(id) ? prefs.dropped.delete(id) : prefs.dropped.add(id); }
      const c = chars.find(x => x.id === id); const el = b.closest('[data-cid]');
      el.outerHTML = card(c); onChange();
    };
    $('[data-deck]', body).onclick = () => openDeck();
    const onImg = ev => { const el = grid.querySelector(`[data-cid="${CSS.escape(ev.detail)}"] .ct-pic`); if (el) el.innerHTML = `<img src="${esc(Library.imgSrc(ev.detail))}" alt="">`; };
    document.addEventListener('whoami:img', onImg);
    body._cleanup = () => document.removeEventListener('whoami:img', onImg);
    load();
  },

  // Full-screen Check or Drop deck over the picker.
  async openDeck(host, ctx) {
    const { catalog, sel, prefs, onChange } = ctx;
    if (!CharSource.canBrowse()) return toast('Join a lobby first. The host supplies the characters.', 'bad');
    const ov = el(`<div class="cod">
      <div class="cod-top">
        <select id="cod-scope">
          <option value="mine">Characters from my fandoms (drop the ones you don't know)</option>
          <option value="other">Characters from other fandoms (check the ones you know)</option>
          <option value="all">Everything</option>
        </select>
        <span class="grow"></span><span class="muted small" id="cod-stats"></span>
        <button class="btn primary small" id="cod-done">Done</button>
      </div>
      <div class="cod-stage" id="cod-stage"></div>
      <div class="cod-bottom">
        <button class="btn" id="cod-undo">↶ Undo</button>
        <span class="muted small">Keys: ← drop · → check · ↓ skip</span>
        <button class="btn" id="cod-skip">Skip ↓</button>
      </div>
    </div>`);
    host.appendChild(ov);
    let deck = [], idx = 0;
    const history = [];
    const knownIds = catalog.filter(f => sel.has(f.id)).map(f => f.id);
    $('#cod-scope', ov).value = knownIds.length ? 'mine' : 'other';

    const stats = () => { $('#cod-stats', ov).textContent = `✓ ${prefs.checked.size} checked · ✗ ${prefs.dropped.size} dropped`; };
    const draw = () => {
      stats();
      const c = deck[idx];
      const stage = $('#cod-stage', ov);
      if (!c) { stage.innerHTML = `<div class="cod-empty"><h2>All done here!</h2><p class="muted">No more characters in this set. Pick another set above, or press Done.</p></div>`; return; }
      const src = CharSource.img(c.id);
      const fname = (catalog.find(f => f.id === c.f) || {}).name || '';
      stage.innerHTML = `
        <div class="cod-card">
          <button class="cod-side drop" data-go="drop" aria-label="Drop"><span class="cod-mark">✗</span><span>DROP</span><small>Don't know them</small></button>
          <div class="cod-face">
            <div class="cod-pic">${src ? `<img src="${esc(src)}" alt="">` : '<span class="muted">Loading picture…</span>'}</div>
            <div class="cod-name">${esc(c.n)}</div>
            <div class="muted small">${esc(fname)}</div>
            <div class="muted small" style="margin-top:4px">${idx + 1} / ${deck.length}</div>
          </div>
          <button class="cod-side check" data-go="check" aria-label="Check"><span class="cod-mark">✓</span><span>CHECK</span><small>I know them</small></button>
        </div>`;
      // preload the next few pictures
      for (const n of deck.slice(idx + 1, idx + 4)) CharSource.img(n.id);
    };
    const act = kind => {
      const c = deck[idx]; if (!c) return;
      history.push({ id: c.id, idx, had: { checked: prefs.checked.has(c.id), dropped: prefs.dropped.has(c.id) } });
      if (kind === 'check') { prefs.dropped.delete(c.id); if (!sel.has(c.f)) prefs.checked.add(c.id); }
      else if (kind === 'drop') { prefs.checked.delete(c.id); prefs.dropped.add(c.id); }
      const flash = ov.querySelector(`.cod-side.${kind}`); if (flash) flash.classList.add('hit');
      idx++; onChange(); setTimeout(draw, kind === 'skip' ? 0 : 140);
    };
    const undo = () => {
      const h = history.pop(); if (!h) return;
      h.had.checked ? prefs.checked.add(h.id) : prefs.checked.delete(h.id);
      h.had.dropped ? prefs.dropped.add(h.id) : prefs.dropped.delete(h.id);
      idx = h.idx; onChange(); draw();
    };
    const build = async () => {
      const scope = $('#cod-scope', ov).value;
      const fids = scope === 'mine' ? knownIds : scope === 'other' ? catalog.filter(f => !sel.has(f.id)).map(f => f.id) : catalog.map(f => f.id);
      $('#cod-stage', ov).innerHTML = '<div class="cod-empty muted">Loading characters…</div>';
      const all = await CharSource.list(fids);
      deck = shuffle(all.filter(c => !prefs.checked.has(c.id) && !prefs.dropped.has(c.id)));
      idx = 0; history.length = 0; draw();
    };
    ov.addEventListener('click', e => {
      const b = e.target.closest('[data-go]'); if (b) act(b.dataset.go);
    });
    $('#cod-skip', ov).onclick = () => act('skip');
    $('#cod-undo', ov).onclick = undo;
    $('#cod-scope', ov).onchange = build;
    const onKey = e => {
      if (e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); act('drop'); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); act('check'); }
      else if (e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); act('skip'); }
      else if (e.key === 'Backspace' || (e.key === 'z' && e.ctrlKey)) { e.preventDefault(); undo(); }
    };
    const onImg = ev => { if (deck[idx]?.id === ev.detail) { const p = ov.querySelector('.cod-pic'); if (p) p.innerHTML = `<img src="${esc(Library.imgSrc(ev.detail))}" alt="">`; } };
    document.addEventListener('keydown', onKey);
    document.addEventListener('whoami:img', onImg);
    const close = () => { document.removeEventListener('keydown', onKey); document.removeEventListener('whoami:img', onImg); ov.remove(); ctx.onClose?.(); };
    $('#cod-done', ov).onclick = close;
    await build();
  },
};
