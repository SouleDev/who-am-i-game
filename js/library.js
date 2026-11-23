// Character library: the built-in pack (data/library.json + images), the host's custom
// characters (IndexedDB) and pictures received from a host during a game.
const Library = {
  builtIn: { fandoms: [], characters: [], version: null },
  custom: { fandoms: [], characters: [] },
  chars: new Map(),       // id -> {id, f, n, a, img?, data?}
  fandoms: new Map(),     // id -> {id, name, tags, count}
  remoteFandoms: new Map(), // fandoms we only know about from a host's list
  received: new Map(),    // id -> data URL sent by host
  _dataCache: new Map(),

  async load() {
    try {
      const r = await fetch('data/library.json', { cache: 'no-cache' });
      if (r.ok) {
        this.builtIn = await r.json();
        for (const c of this.builtIn.characters) c.img = 'data/' + c.img; // paths in the pack are relative to data/
      }
    } catch { /* web player build ships without the pack */ }
    try {
      const c = await IDB.get('custom');
      if (c) this.custom = c;
    } catch (e) { console.warn('custom library unavailable', e); }
    for (const f of Store.get('remoteFandoms', [])) this.remoteFandoms.set(f.id, f);
    this.reindex();
  },

  reindex() {
    this.chars.clear(); this.fandoms.clear();
    for (const f of this.builtIn.fandoms || []) this.fandoms.set(f.id, { ...f, count: 0 });
    for (const f of this.custom.fandoms) this.fandoms.set(f.id, { ...f, tags: ['custom'], count: 0 });
    for (const c of this.builtIn.characters || []) this.chars.set(c.id, c);
    for (const c of this.custom.characters) this.chars.set(c.id, c);
    for (const c of this.chars.values()) {
      let f = this.fandoms.get(c.f);
      if (f) f.count++;
    }
    // custom characters may be added to built-in fandoms; tag those fandoms
    for (const c of this.custom.characters) {
      const f = this.fandoms.get(c.f);
      if (f && !f.tags.includes('custom')) f.tags = [...f.tags, 'custom'];
    }
    for (const [id, f] of this.fandoms) if (!f.count) this.fandoms.delete(id);
  },

  get hasPack() { return (this.builtIn.characters || []).length > 0; },
  get size() { return this.chars.size; },

  fandomList() { return [...this.fandoms.values()].sort((a, b) => a.name.localeCompare(b.name)); },
  fandomName(id) { return (this.fandoms.get(id) || this.remoteFandoms.get(id) || { name: id }).name; },
  charsIn(fid) { return [...this.chars.values()].filter(c => c.f === fid); },

  rememberRemoteFandoms(list) {
    for (const f of list) this.remoteFandoms.set(f.id, f);
    Store.set('remoteFandoms', [...this.remoteFandoms.values()].slice(-2000));
  },

  has(id) { return this.chars.has(id) || this.received.has(id); },

  imgSrc(id) {
    const c = this.chars.get(id);
    if (c) return c.data || c.img;
    return this.received.get(id) || null;
  },

  // Data URL for sending a picture to a player who doesn't have it.
  async imgData(id) {
    if (this._dataCache.has(id)) return this._dataCache.get(id);
    const c = this.chars.get(id);
    if (!c) return null;
    if (c.data) return c.data;
    const r = await fetch(c.img);
    if (!r.ok) return null;
    const d = await blobToDataURL(await r.blob());
    this._dataCache.set(id, d);
    return d;
  },

  // ---------- custom characters (host-side) ----------
  async saveCustom() { await IDB.set('custom', this.custom); this.reindex(); },

  async addCustomFandom(name) {
    const f = { id: 'c-' + randomCode(8).toLowerCase(), name: name.trim(), tags: ['custom'] };
    this.custom.fandoms.push(f);
    await IDB.set('custom', this.custom);
    return f;
  },

  async addCustomCharacter(fid, name, aliases, dataUrl) {
    const c = { id: 'c-' + randomCode(10).toLowerCase(), f: fid, n: name.trim(), a: aliases, data: dataUrl };
    this.custom.characters.push(c);
    await this.saveCustom();
    return c;
  },

  async deleteCustomCharacter(id) {
    this.custom.characters = this.custom.characters.filter(c => c.id !== id);
    await this.saveCustom();
  },

  async deleteCustomFandom(fid) {
    this.custom.fandoms = this.custom.fandoms.filter(f => f.id !== fid);
    this.custom.characters = this.custom.characters.filter(c => c.f !== fid);
    await this.saveCustom();
  },
};
