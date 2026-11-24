// Fandom picker: category tabs -> sections (e.g. Cartoons -> Nickelodeon) -> fandom chips.
const FANDOM_CATEGORIES = [
  { id: 'Anime', icon: '🌸', subs: ['MyAnimeList Top 500', 'MyAnimeList 501–1000', 'More Anime'] },
  { id: "Cartoons & Kids' TV", icon: '📺', subs: ['Nickelodeon', 'Cartoon Network', 'Disney Movies', 'Pixar', 'Disney Channel & Disney XD', 'Boomerang Classics', 'Other Cartoons'] },
  { id: 'Video Games', icon: '🎮', subs: ['Steam Top 100', 'More Games'] },
  { id: 'Movies & TV', icon: '🎬', subs: ['Movies', 'Animated Movies', 'TV Shows', 'Tokusatsu'] },
  { id: 'Books', icon: '📚', subs: ['Books'] },
  { id: 'Comics', icon: '💥', subs: ['Comics'] },
  { id: 'Other', icon: '✨', subs: ['Music', 'Tabletop', 'Other'] },
  { id: 'Custom', icon: '🖼️', subs: ['Your fandoms'] },
];
const SECTION_PREVIEW = 36; // chips shown before "Show all"

function fandomCat(f) { return f.cat || (String(f.id).startsWith('c-') ? 'Custom' : 'Other'); }
function fandomSub(f) { return f.sub || (String(f.id).startsWith('c-') ? 'Your fandoms' : 'Other'); }

// Short summary of a selection, e.g. "Anime 12 · Video Games 3"
function fandomSummary(ids, catalog) {
  const byId = new Map(catalog.map(f => [f.id, f]));
  const counts = new Map();
  for (const id of ids) { const f = byId.get(id); if (f) counts.set(fandomCat(f), (counts.get(fandomCat(f)) || 0) + 1); }
  return FANDOM_CATEGORIES.filter(c => counts.has(c.id)).map(c => ({ ...c, n: counts.get(c.id) }));
}

UI.openFandomPicker = function ({ title, subtitle, catalog, selected, players, onSave, charPrefs, startDeck }) {
  const sel = new Set(selected);
  const knownBy = id => players ? players.filter(p => p.known.includes(id)).length : 0;
  const cats = FANDOM_CATEGORIES.map(c => ({ ...c, items: catalog.filter(f => fandomCat(f) === c.id) })).filter(c => c.items.length);
  let tab = (cats.find(c => c.items.some(f => sel.has(f.id))) || cats[0])?.id;
  let query = '';
  const expanded = new Set();
  const collapsed = new Set();

  const m = this.openModal(`
    <header><h2>${esc(title)}</h2><input id="fp-q" placeholder="🔍 Search all fandoms…" style="width:260px"></header>
    ${subtitle ? `<p class="muted small" style="padding:0 18px;margin:0 0 8px">${esc(subtitle)}</p>` : ''}
    <div class="fp-tabs" id="fp-tabs"></div>
    <div class="body" id="fp-body"></div>
    <footer>
      ${players ? '<button class="btn small ghost" data-q="anyone" title="Every fandom at least one player knows">Known by anyone</button><button class="btn small ghost" data-q="everyone" title="Only fandoms every player knows">Known by everyone</button>' : ''}
      <span class="grow muted small" id="fp-count"></span>
      <button class="btn" id="fp-cancel">Cancel</button><button class="btn primary" id="fp-save">Save</button>
    </footer>`);
  m.classList.add('fp-modal');

  const chip = f => {
    const k = knownBy(f.id);
    return `<button class="fchip ${sel.has(f.id) ? 'on' : ''}" data-id="${esc(f.id)}" title="${esc(f.name)}${f.count ? ` · ${f.count} characters` : ''}">
      <span class="tick">${sel.has(f.id) ? '✓' : '+'}</span>${esc(f.name)}${players && k ? `<span class="who">👤${k}</span>` : ''}</button>`;
  };

  const section = (key, label, items, opts = {}) => {
    items = items.slice().sort((a, b) => a.name.localeCompare(b.name));
    const on = items.filter(f => sel.has(f.id)).length;
    const isCollapsed = collapsed.has(key);
    const showAll = expanded.has(key) || opts.all || items.length <= SECTION_PREVIEW + 4;
    const shown = showAll ? items : items.slice(0, SECTION_PREVIEW);
    return `<section class="fsec ${isCollapsed ? 'closed' : ''}">
      <div class="fsec-head" data-toggle="${esc(key)}">
        <span class="caret">${isCollapsed ? '▸' : '▾'}</span>
        <b>${esc(label)}</b><span class="muted small">${on ? `${on} of ${items.length} picked` : `${items.length}`}</span>
        <span class="grow"></span>
        <button class="btn ghost small" data-all="${esc(key)}">All</button><button class="btn ghost small" data-none="${esc(key)}">None</button>
      </div>
      ${isCollapsed ? '' : `<div class="fchips">${shown.map(chip).join('')}
        ${showAll ? '' : `<button class="btn ghost small more" data-more="${esc(key)}">Show all ${items.length}…</button>`}</div>`}
    </section>`;
  };

  const charCtx = charPrefs && { catalog, sel, prefs: charPrefs, onChange: () => updateCount(), openDeck: () => CharUI.openDeck(m, charCtx), onClose: () => { if (tab === '__chars') { $('#fp-body', m).dataset.mounted = ''; draw(); } } };
  const updateCount = () => {
    $('#fp-count', m).textContent = `${sel.size} fandom${sel.size === 1 ? '' : 's'}` + (charPrefs ? ` · ✓ ${charPrefs.checked.size} · ✗ ${charPrefs.dropped.size}` : '') + ' picked';
  };

  // key -> items, so section buttons know what they affect
  let sectionItems = new Map();

  const draw = () => {
    sectionItems = new Map();
    // tabs
    $('#fp-tabs', m).innerHTML = cats.map(c => {
      const on = c.items.filter(f => sel.has(f.id)).length;
      return `<button class="fp-tab ${!query && tab === c.id ? 'on' : ''}" data-tab="${esc(c.id)}">${c.icon} ${esc(c.id)}${on ? `<span class="pill">${on}</span>` : ''}</button>`;
    }).join('') + `<button class="fp-tab ${!query && tab === '__sel' ? 'on' : ''}" data-tab="__sel">⭐ Picked<span class="pill">${sel.size}</span></button>`
      + (charPrefs ? `<button class="fp-tab ${!query && tab === '__chars' ? 'on' : ''}" data-tab="__chars">🧩 Characters${charPrefs.checked.size + charPrefs.dropped.size ? `<span class="pill">${charPrefs.checked.size + charPrefs.dropped.size}</span>` : ''}</button>` : '');
    const bodyEl = $('#fp-body', m);
    if (tab === '__chars' && !query && charPrefs) {
      if (bodyEl.dataset.mounted !== '1') { bodyEl._cleanup?.(); bodyEl.dataset.mounted = '1'; CharUI.mountTab(bodyEl, charCtx); }
      updateCount();
      return;
    }
    if (bodyEl.dataset.mounted === '1') { bodyEl._cleanup?.(); bodyEl._cleanup = null; bodyEl.dataset.mounted = ''; }

    let html = '';
    if (query) {
      const hits = catalog.filter(f => f.name.toLowerCase().includes(query));
      for (const c of cats) {
        const items = hits.filter(f => fandomCat(f) === c.id);
        if (!items.length) continue;
        const key = 'q:' + c.id; sectionItems.set(key, items);
        html += section(key, `${c.icon} ${c.id}`, items, { all: true });
      }
      html = html || '<p class="muted center" style="padding:30px">No fandoms match that search.</p>';
    } else if (tab === '__sel') {
      for (const c of cats) {
        const items = c.items.filter(f => sel.has(f.id));
        if (!items.length) continue;
        const key = 's:' + c.id; sectionItems.set(key, items);
        html += section(key, `${c.icon} ${c.id}`, items, { all: true });
      }
      html = html || '<p class="muted center" style="padding:30px">Nothing picked yet. Choose a category tab and tap the fandoms you know.</p>';
    } else {
      const c = cats.find(x => x.id === tab) || cats[0];
      const subs = [...new Set([...c.subs, ...c.items.map(fandomSub)])];
      for (const s of subs) {
        const items = c.items.filter(f => fandomSub(f) === s);
        if (!items.length) continue;
        const key = c.id + '›' + s; sectionItems.set(key, items);
        html += section(key, s, items);
      }
    }
    const body = $('#fp-body', m);
    const scroll = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = scroll;
    updateCount();
  };

  m.addEventListener('click', e => {
    const t = e.target.closest('button, .fsec-head');
    if (!t) return;
    if (t.dataset.id) { sel.has(t.dataset.id) ? sel.delete(t.dataset.id) : sel.add(t.dataset.id); }
    else if (t.dataset.tab) { tab = t.dataset.tab; query = ''; $('#fp-q', m).value = ''; $('#fp-body', m).scrollTop = 0; }
    else if (t.closest('.cod') || t.closest('#ct-grid') || t.dataset.deck !== undefined) return;
    else if (t.dataset.all) { sectionItems.get(t.dataset.all)?.forEach(f => sel.add(f.id)); }
    else if (t.dataset.none) { sectionItems.get(t.dataset.none)?.forEach(f => sel.delete(f.id)); }
    else if (t.dataset.more) { expanded.add(t.dataset.more); }
    else if (t.dataset.toggle) { collapsed.has(t.dataset.toggle) ? collapsed.delete(t.dataset.toggle) : collapsed.add(t.dataset.toggle); }
    else if (t.dataset.q) {
      sel.clear();
      for (const f of catalog) { const k = knownBy(f.id); if (t.dataset.q === 'anyone' ? k > 0 : k === players.length) sel.add(f.id); }
      tab = '__sel';
    }
    else return;
    e.stopPropagation();
    draw();
  });
  $('#fp-q', m).addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); draw(); });
  $('#fp-cancel', m).onclick = () => this.closeModal();
  $('#fp-save', m).onclick = () => { $('#fp-body', m)._cleanup?.(); onSave(sel, charPrefs); this.closeModal(); };
  if (startDeck && charPrefs) { tab = '__chars'; draw(); charCtx.openDeck(); } else draw();
};
