// Shared helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode(n = 6) {
  let s = '';
  const buf = crypto.getRandomValues(new Uint32Array(n));
  for (let i = 0; i < n; i++) s += CODE_CHARS[buf[i] % CODE_CHARS.length];
  return s;
}
function randomId(prefix = '') { return prefix + randomCode(10).toLowerCase(); }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function weightedPick(items, weightFn) {
  const total = items.reduce((s, x) => s + weightFn(x), 0);
  let r = Math.random() * total;
  for (const x of items) { r -= weightFn(x); if (r <= 0) return x; }
  return items[items.length - 1];
}

// ---------- guess matching ----------
function normalizeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[★☆♪・·.,'"`’!?()\[\]{}:;_\-\/\\]/g, ' ')
    .replace(/\bthe\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const NAME_STOPWORDS = new Set(['the', 'of', 'von', 'van', 'de', 'da', 'del', 'la', 'le', 'san', 'chan', 'kun', 'sama', 'mr', 'mrs', 'ms', 'dr', 'sir', 'lord', 'lady', 'king', 'queen', 'captain', 'professor', 'doctor', 'general', 'agent', 'and', 'jr', 'sr']);

// Returns true when a typed guess should count as the character.
function guessMatches(guess, character) {
  const g = normalizeName(guess);
  if (g.length < 2) return false;
  const names = [character.n, ...(character.a || [])].map(normalizeName).filter(Boolean);
  const candidates = new Set();
  for (const n of names) {
    candidates.add(n);
    const parts = n.split(' ').filter(Boolean);
    if (parts.length > 1) {
      candidates.add(parts.slice().reverse().join(' '));
      for (const p of parts) if (p.length >= 3 && !NAME_STOPWORDS.has(p)) candidates.add(p);
    }
  }
  for (const c of candidates) {
    if (c === g) return true;
    const tol = c.length >= 12 ? 2 : c.length >= 6 ? 1 : 0;
    if (tol && Math.abs(c.length - g.length) <= tol && levenshtein(c, g) <= tol) return true;
  }
  return false;
}

// ---------- storage ----------
const Store = {
  get(key, def) {
    try { const v = localStorage.getItem('whoami.' + key); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(key, val) { try { localStorage.setItem('whoami.' + key, JSON.stringify(val)); } catch { } },
};

// Tiny IndexedDB key/value store (used for host custom characters, which hold image data).
const IDB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('whoami', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this._db = r.result; res(r.result); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(key) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  },
  async set(key, val) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  },
};

// ---------- UI helpers ----------
function toast(msg, kind = 'info', ms = 3500) {
  const t = el(`<div class="toast ${kind}">${esc(msg)}</div>`);
  $('#toasts').appendChild(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

const PLAYER_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#748ffc', '#da77f2', '#f783ac', '#a9e34b'];

function placeLabel(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
function medal(n) { return n === 1 ? '🥇' : n === 2 ? '🥈' : n === 3 ? '🥉' : '🏅'; }

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = el('<textarea style="position:fixed;opacity:0"></textarea>');
    ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}

// Resize an image File to a compact JPEG data URL (keeps custom characters small to store and send).
function fileToResizedDataURL(file, maxW = 360, maxH = 480) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width, maxH / img.height);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read image ' + file.name)); };
    img.src = url;
  });
}
