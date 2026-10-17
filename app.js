'use strict';
/* ═══════════════════════════════════════════════════════════════
   Reader — PDF-Bücher lesen, offline, als Web-App fürs Handy

   Datenhaltung
   - localStorage 'reader.v1': Bibliothek, Lesestand, Lesezeichen, Regale,
     Statistik und Einstellungen — ein JSON-Objekt, siehe blank().
   - IndexedDB 'reader-files': die PDF-Dateien selbst, Cover und den
     aufbereiteten Text. Das ist alles zu groß für localStorage.
   Das Backup enthält nur den localStorage-Teil. Die PDFs findet die App nach
   einem erneuten Import über ihren Fingerabdruck (SHA-256) wieder.

   PDF.js liegt lokal unter vendor/pdfjs und wird erst beim ersten Öffnen
   eines Buchs geladen — die Bibliothek startet ohne die 3 MB.
   ═══════════════════════════════════════════════════════════════ */

const KEY = 'reader.v1';
/* Bei jeder Änderung hochzählen — wird in den Einstellungen angezeigt, damit
   sich auf dem Handy prüfen lässt, welche Fassung wirklich läuft. */
const APP_VERSION = '1.0.0';

const THEME_KEY = 'reader.theme';
/* `bar` ist die Hintergrundfarbe des Themes und landet im
   <meta name="theme-color">, damit die Systemleiste des Handys mitzieht —
   muss mit --bg in style.css übereinstimmen. */
const THEMES = {
  dark:  { label: 'Dunkel', bar: '#0b0e14' },
  light: { label: 'Hell',   bar: '#f3f5f9' },
};
/* Papier im Leser. `bar` wie oben, passend zu --pp-bg in style.css. */
const PAPERS = {
  light: { label: 'Weiß',    bar: '#ffffff' },
  sepia: { label: 'Sepia',   bar: '#f4ecd8' },
  dark:  { label: 'Dunkel',  bar: '#1a1a1a' },
  black: { label: 'Schwarz', bar: '#000000' },
};
const MODES = { page: 'Seiten', scroll: 'Scrollen', text: 'Text' };
const SORTS = {
  recent: 'Zuletzt gelesen', added: 'Zuletzt hinzugefügt', title: 'Titel',
  author: 'Autor', progress: 'Fortschritt',
};
const MARGINS = [14, 22, 34];                 // Textmodus: Rand schmal / mittel / breit in px
const LINE_HEIGHTS = { 1.35: 'Eng', 1.55: 'Normal', 1.8: 'Weit' };

/** Frische Grundstruktur. Basis beim Laden und beim Backup-Import, damit
    später ergänzte Felder in alten Daten nicht fehlen. */
const blank = () => ({
  v: 1,
  books: [],          // Metadaten je Buch, siehe blankBook(); die PDF liegt in IndexedDB
  shelves: [],        // {id, name, created} — eigene Regale
  stats: {},          // 'JJJJ-MM-TT' → {s: Sekunden gelesen, p: Seiten gelesen}
  theme: 'dark',      // App-Theme, Spiegel in THEME_KEY
  read: {             // Lese-Einstellungen, gelten für alle Bücher
    paper: 'light',     // Papierfarbe: light | sepia | dark | black
    mode: 'page',       // Ansicht für neu geöffnete Bücher: page | scroll | text
    tapTurn: true,      // Tippen am linken/rechten Rand blättert
    anim: true,         // Seiten gleiten beim Blättern
    wake: true,         // Bildschirm beim Lesen anlassen
    full: false,        // Vollbild beim Lesen (Statusleiste weg)
    dim: 0,             // Abdunkeln über der Seite, 0 … 0.7
    font: 'serif',      // Textmodus: serif | sans
    size: 19,           // Textmodus: Schriftgröße in px
    lh: 1.55,           // Textmodus: Zeilenabstand
    margin: 1,          // Textmodus: Index in MARGINS
    justify: true,      // Textmodus: Blocksatz mit Silbentrennung
  },
  lib: {              // Zustand der Bibliothek
    sort: 'recent',     // Schlüssel aus SORTS
    filter: 'all',      // all | reading | unread | done | shelf:<id>
    layout: 'grid',     // grid | list
  },
  tips: {},           // schon gezeigte Hinweise, z. B. {reader: true}
  lastBackup: null,   // ISO-Zeitpunkt des letzten Backups
});

/** Ein Buch. `id` ist zugleich der Schlüssel der Datei in IndexedDB. */
const blankBook = () => ({
  id: '',
  fp: '',             // Fingerabdruck der Datei — findet das Buch nach Backup-Import wieder
  title: '',
  author: '',
  fileName: '',
  size: 0,            // Bytes
  pages: 0,
  added: null,        // ISO
  lastRead: null,     // ISO; null = nie geöffnet
  finished: null,     // ISO; gesetzt = gelesen
  shelves: [],        // Regal-IDs
  pos: { page: 1, frac: 0 },  // Lesestand: Seite (1-basiert) und Anteil innerhalb der Seite
  mode: '',           // page | scroll | text — leer = read.mode
  crop: true,         // weiße Ränder abschneiden
  zoom: 1,            // Zoom im Scrollmodus (1 = Seitenbreite)
  box: null,          // ermittelter Inhaltsbereich {x0,y0,x1,y1} als Anteil der Seite (Cache)
  marks: [],          // Lesezeichen {id, page, frac, label, at}
  readSec: 0,         // Lesezeit gesamt
  readPages: 0,       // gelesene Seiten, für das Lesetempo
  maxPage: 1,         // weiteste erreichte Seite
});

let db = blank();

/* ── Persistenz ─────────────────────────────────────────────── */

/** Fremden Datensatz (aus localStorage oder Backup) auf die aktuelle Struktur
    bringen. Object.assign allein reicht nicht: es ersetzt verschachtelte
    Objekte im Ganzen — ein älteres Unterobjekt ohne ein neues Feld würde die
    Vorgabe nicht ergänzen, sondern löschen. Daten haben Vorrang vor Vorgabe. */
function normalize(src) {
  const base = blank();
  const d = Object.assign(blank(), src || {});
  delete d.meta;                                   // Kopfdaten des Backups gehören nicht in die Daten

  d.read = Object.assign(base.read, isObj(d.read) ? d.read : {});
  d.lib = Object.assign(blank().lib, isObj(d.lib) ? d.lib : {});
  d.tips = isObj(d.tips) ? d.tips : {};
  if (!THEMES[d.theme]) d.theme = base.theme;

  const r = d.read, rb = blank().read;
  if (!PAPERS[r.paper]) r.paper = rb.paper;
  if (!MODES[r.mode]) r.mode = rb.mode;
  if (!['serif', 'sans'].includes(r.font)) r.font = rb.font;
  r.size = clamp(Math.round(num(r.size)) || rb.size, 12, 34);
  r.lh = LINE_HEIGHTS[r.lh] ? num(r.lh) : rb.lh;
  r.margin = [0, 1, 2].includes(r.margin) ? r.margin : rb.margin;
  r.dim = clamp(num(r.dim), 0, 0.7);
  ['tapTurn', 'anim', 'wake', 'full', 'justify'].forEach((k) => { r[k] = !!r[k]; });

  d.shelves = (Array.isArray(d.shelves) ? d.shelves : []).filter(isObj)
    .map((s) => ({ id: String(s.id || uid()), name: String(s.name || 'Regal').slice(0, 60), created: s.created || null }));
  const shelfIds = new Set(d.shelves.map((s) => s.id));
  const seen = new Set();
  d.books = (Array.isArray(d.books) ? d.books : []).filter(isObj).map((b) => normBook(b, shelfIds))
    .filter((b) => (seen.has(b.id) ? false : seen.add(b.id)));

  d.stats = isObj(d.stats) ? d.stats : {};
  Object.keys(d.stats).forEach((k) => {
    const v = d.stats[k];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !isObj(v)) { delete d.stats[k]; return; }
    d.stats[k] = { s: Math.max(0, num(v.s)), p: Math.max(0, Math.round(num(v.p))) };
  });

  if (!SORTS[d.lib.sort]) d.lib.sort = 'recent';
  if (!['grid', 'list'].includes(d.lib.layout)) d.lib.layout = 'grid';
  if (typeof d.lib.filter !== 'string') d.lib.filter = 'all';
  if (d.lib.filter.startsWith('shelf:') && !shelfIds.has(d.lib.filter.slice(6))) d.lib.filter = 'all';
  return d;
}

function normBook(src, shelfIds) {
  const base = blankBook();
  const b = Object.assign(blankBook(), src);
  b.id = String(b.id || uid());
  ['fp', 'title', 'author', 'fileName'].forEach((k) => { b[k] = String(b[k] || ''); });
  if (!b.title) b.title = b.fileName.replace(/\.pdf$/i, '') || 'Ohne Titel';
  b.pages = Math.max(0, Math.round(num(b.pages)));
  b.pos = Object.assign(base.pos, isObj(src.pos) ? src.pos : {});
  b.pos.page = clamp(Math.round(num(b.pos.page)) || 1, 1, Math.max(1, b.pages));
  b.pos.frac = clamp(num(b.pos.frac), 0, 0.999);
  b.shelves = Array.isArray(b.shelves) ? b.shelves.map(String).filter((id) => shelfIds.has(id)) : [];
  b.marks = (Array.isArray(b.marks) ? b.marks : []).filter(isObj).map((m) => ({
    id: String(m.id || uid()), page: Math.max(1, Math.round(num(m.page)) || 1),
    frac: clamp(num(m.frac), 0, 0.999), label: String(m.label || '').slice(0, 200), at: m.at || null,
  }));
  if (!MODES[b.mode]) b.mode = '';
  b.crop = b.crop !== false;
  b.zoom = clamp(num(b.zoom) || 1, 1, 4);
  b.box = validBox(b.box) ? b.box : null;
  b.size = Math.max(0, num(b.size));
  b.readSec = Math.max(0, num(b.readSec));
  b.readPages = Math.max(0, Math.round(num(b.readPages)));
  b.maxPage = Math.max(1, Math.round(num(b.maxPage)) || 1);
  return b;
}

const validBox = (x) => isObj(x) && ['x0', 'y0', 'x1', 'y1'].every((k) => typeof x[k] === 'number' && x[k] >= 0 && x[k] <= 1)
  && x.x1 - x.x0 > 0.1 && x.y1 - x.y0 > 0.1;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    db = normalize(JSON.parse(raw));
  } catch (e) { console.warn('Laden fehlgeschlagen', e); }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { toast('Speichern fehlgeschlagen!'); console.error(e); }
}
/* Beim Scrollen ändert sich der Lesestand dutzendfach pro Sekunde — gespeichert
   wird gebündelt. pagehide/visibilitychange holen Ausstehendes nach. */
let saveT = null;
function saveSoon() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { saveT = null; save(); }, 700);
}
function saveNow() { if (saveT) { clearTimeout(saveT); saveT = null; } save(); }

/** Theme aufs Dokument legen. Der Spiegel in THEME_KEY ist das, was das
    Startskript in index.html liest — ohne ihn flackert der Start. */
function applyTheme(t) {
  if (!THEMES[t]) t = 'dark';
  db.theme = t;
  document.documentElement.dataset.theme = t;
  setBarColor(THEMES[t].bar);
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* nicht schlimm */ }
}
function setBarColor(c) {
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = c;
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ── Helfer ─────────────────────────────────────────────────── */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/* Eingaben können deutsches Komma enthalten — parseFloat allein verschluckt es. */
const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : 0; };

/* Formatierung immer über Intl — nie von Hand mit toFixed und Komma-Ersatz. */
const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const dfLong = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
const dfDate = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
const dfShort = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const dfWeekday = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });
const dfMonth = new Intl.DateTimeFormat('de-DE', { month: 'short' });
const dfMonthYear = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });

/** datetime-local braucht lokale Zeit ohne Zone — toISOString() liefert UTC
    und verschiebt das Datum je nach Uhrzeit um einen Tag. */
function localISO(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
       + `T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const dayKey = (d) => localISO(d).slice(0, 10);

function fmtDur(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} Min.`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} Std. ${r} Min.` : `${h} Std.`;
}
function fmtBytes(n) {
  if (n < 1024 * 1024) return nf0.format(Math.max(1, n / 1024)) + ' KB';
  if (n < 1024 * 1024 * 1024) return nf1.format(n / 1024 / 1024) + ' MB';
  return nf1.format(n / 1024 / 1024 / 1024) + ' GB';
}
const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
const strHash = (s) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

const book = (id) => db.books.find((b) => b.id === id);
/** Fortschritt 0 … 1. Die letzte Seite zählt voll — sonst bliebe ein
    zu Ende gelesenes Buch ewig bei 99 %. */
function progress(b) {
  if (b.finished) return 1;
  if (!b.pages) return 0;
  if (b.pos.page >= b.pages) return 1;
  return clamp((b.pos.page - 1 + b.pos.frac) / b.pages, 0, 1);
}

/* Icons als Pfade (Material-Symbole), gezeichnet mit currentColor —
   nur so ziehen sie beim Theme-Wechsel mit. */
const ICON = {
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  sort: 'M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z',
  grid: 'M3 3v8h8V3H3zm6 6H5V5h4v4zm-6 4v8h8v-8H3zm6 6H5v-4h4v4zm4-16v8h8V3h-8zm6 6h-4V5h4v4zm-6 4v8h8v-8h-8zm6 6h-4v-4h4v4z',
  list: 'M3 14h4v-4H3v4zm0 5h4v-4H3v4zM3 9h4V5H3v4zm5 5h13v-4H8v4zm0 5h13v-4H8v4zM8 5v4h13V5H8z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  book: 'M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1zm0 13.5c-1.1-.35-2.3-.5-3.5-.5-1.7 0-4.15.65-5.5 1.5V8c1.35-.85 3.8-1.5 5.5-1.5 1.2 0 2.4.15 3.5.5v11.5z',
  shelf: 'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 10l-2.5-1.5L15 12V4h5v8z',
  chart: 'M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  markOn: 'M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z',
  markOff: 'M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2zm0 15-5-2.18L7 18V5h10v13z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  del: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  upload: 'M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z',
  chev: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
};
const ic = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${ICON[name]}"/></svg>`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}
/** Arbeitsanzeige für Längeres (Import, Textaufbereitung). null blendet aus. */
function busy(msg) {
  const b = $('#busy');
  if (!msg) { b.classList.add('hidden'); return; }
  $('#busyText').textContent = msg;
  b.classList.remove('hidden');
}
const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/* ── IndexedDB: PDF-Dateien, Cover, aufbereiteter Text ──────────
   Schlüssel ist jeweils book.id. Alles hier ist asynchron; die Bibliothek
   rendert vorher schon aus localStorage und ergänzt Cover, sobald sie da sind. */
const IDB_NAME = 'reader-files';
const STORES = ['pdf', 'cover', 'text'];
let idbP = null;

function idb() {
  if (!idbP) {
    idbP = new Promise((res, rej) => {
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => {
        STORES.forEach((s) => { if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => { idbP = null; rej(r.error); };
    });
  }
  return idbP;
}
function idbReq(store, mode, fn) {
  return idb().then((d) => new Promise((res, rej) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => res(req ? req.result : undefined);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('Speichern abgebrochen'));
  }));
}
const idbGet = (s, k) => idbReq(s, 'readonly', (st) => st.get(k));
const idbPut = (s, k, v) => idbReq(s, 'readwrite', (st) => st.put(v, k));
const idbDel = (s, k) => idbReq(s, 'readwrite', (st) => st.delete(k));
const idbKeys = (s) => idbReq(s, 'readonly', (st) => st.getAllKeys());
const idbClear = (s) => idbReq(s, 'readwrite', (st) => st.clear());
/** Alle Einträge eines Speichers in einem Rutsch — für die Cover beim Start. */
function idbAll(s) {
  return idb().then((d) => new Promise((res, rej) => {
    const tx = d.transaction(s, 'readonly');
    const st = tx.objectStore(s);
    const k = st.getAllKeys(), v = st.getAll();
    tx.oncomplete = () => res(k.result.map((key, i) => [key, v.result[i]]));
    tx.onerror = () => rej(tx.error);
  }));
}

/* Welche Bücher ihre PDF auf diesem Gerät haben. Nach einem Backup-Import
   fehlen sie, bis die Datei erneut importiert wird. */
let files = new Set();
let filesReady = false;

/* ── PDF.js ─────────────────────────────────────────────────────
   Wird erst beim ersten Bedarf geladen. Ein klassisches Skript darf per
   import() ein Modul nachladen — app.js selbst bleibt ohne Module. */
let pdfjsP = null;
function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import('./vendor/pdfjs/pdf.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.mjs');
      return lib;
    }).catch((e) => { pdfjsP = null; throw e; });
  }
  return pdfjsP;
}
const vendorUrl = (p) => new URL('vendor/pdfjs/' + p, location.href).href;

/** Dokument schließen und Worker-Speicher freigeben. Seit PDF.js 5 hängt
    destroy() an der Ladeaufgabe, nicht mehr am Dokument. */
function closePdf(pdf) {
  try { (pdf.loadingTask || pdf).destroy(); } catch (e) { /* schon zu */ }
}

/** PDF öffnen. Achtung: PDF.js übernimmt den Puffer (transfer) — danach ist
    er leer. Wer die Bytes noch braucht, gibt eine Kopie. */
async function openPdf(data) {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data,
    cMapUrl: vendorUrl('cmaps/'), cMapPacked: true,
    standardFontDataUrl: vendorUrl('standard_fonts/'),
    wasmUrl: vendorUrl('wasm/'),
    iccUrl: vendorUrl('iccs/'),
    enableXfa: false,
  });
  task.onPassword = (update, reason) => {
    askText(reason === 2 ? 'Passwort falsch' : 'Passwort nötig',
      reason === 2 ? 'Das Passwort stimmt nicht. Noch einmal:' : 'Dieses PDF ist mit einem Passwort geschützt.',
      { password: true, okLabel: 'Öffnen' },
      (v) => { closeSheet(); update(v); },
      () => { closeSheet(); task.destroy(); });
  };
  return task.promise;
}

/** Fingerabdruck der Datei: findet ein Buch wieder, egal wie die Datei heißt. */
async function fingerprint(buf) {
  if (window.crypto && crypto.subtle) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return 'sha256:' + Array.from(h.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Ohne sicheren Kontext (http im Heimnetz) fehlt crypto.subtle — dann FNV-1a
  // über die ganze Datei. Nur zum Testen; online läuft die App immer über https.
  const a = new Uint8Array(buf);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < a.length; i++) {
    h1 = Math.imul(h1 ^ a[i], 16777619);
    h2 = Math.imul(h2 ^ a[a.length - 1 - i], 16777619);
  }
  return 'fnv:' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + a.length.toString(16);
}

/** Titel und Autor aus den PDF-Metadaten — oft Müll wie „Microsoft Word -
    Dok1.docx“. Dann lieber der Dateiname. */
function pickTitle(meta, fileName) {
  const info = (meta && meta.info) || {};
  const md = meta && meta.metadata;
  const get = (k) => { try { return md && md.get ? md.get(k) : null; } catch (e) { return null; } };
  let title = get('dc:title') || info.Title || '';
  let author = get('dc:creator') || info.Author || '';
  if (Array.isArray(title)) title = title[0];
  if (Array.isArray(author)) author = author.join(', ');
  title = String(title || '').replace(/\s+/g, ' ').trim();
  author = String(author || '').replace(/\s+/g, ' ').trim();
  const fromFile = String(fileName || '').replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const junk = /^(untitled|unbenannt|ohne titel|document|dokument|titel|title|microsoft word|powerpoint)\b|\.(docx?|odt|rtf|pdf|tex|indd|qxd|pages)$/i;
  if (!title || title.length < 2 || junk.test(title)) title = fromFile || 'Ohne Titel';
  if (/^(unknown|unbekannt|administrator|admin|user|owner|benutzer)$/i.test(author)) author = '';
  return { title: title.slice(0, 200), author: author.slice(0, 120) };
}

/** Cover aus Seite 1, als JPEG. 360 px Breite reichen fürs Raster auch auf
    hochauflösenden Displays und halten jedes Cover bei ~30 KB. */
async function renderCover(pdf) {
  const page = await pdf.getPage(1);
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(360 / v1.width, 560 / v1.height) });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
  page.cleanup();
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
}

/* ── Cover-Cache ────────────────────────────────────────────── */
const coverUrls = new Map();   // book.id → Objekt-URL

function setCoverUrl(id, blob) {
  const old = coverUrls.get(id);
  if (old) URL.revokeObjectURL(old);
  if (blob) coverUrls.set(id, URL.createObjectURL(blob)); else coverUrls.delete(id);
}
async function loadCovers() {
  for (const [k, v] of await idbAll('cover')) if (v && !coverUrls.has(k)) setCoverUrl(k, v);
}
function coverHTML(b) {
  const u = coverUrls.get(b.id);
  if (u) return `<img src="${esc(u)}" alt="" draggable="false">`;
  return `<div class="bk-ph" data-c="${strHash(b.title) % 6}">${esc(b.title)}</div>`;
}

/* ── Import ─────────────────────────────────────────────────── */
let importTarget = null;   // Buch, dessen fehlende Datei gerade nachgeladen wird

function pickPdf(target) {
  importTarget = target || null;
  const inp = $('#pdfInput');
  inp.multiple = !target;
  inp.value = '';
  inp.click();
}

async function importFiles(list) {
  const arr = Array.from(list || []);
  if (!arr.length) return;
  const target = importTarget;
  importTarget = null;
  const res = { added: 0, restored: 0, dup: 0, errors: [] };
  let lastId = null;
  for (let i = 0; i < arr.length; i++) {
    busy(arr.length > 1 ? `Importiere ${i + 1} von ${arr.length} …` : 'Importiere …');
    try {
      const r = await importOne(arr[i], target);
      if (r.kind === 'ask') { busy(null); return; }      // Rückfrage läuft im Sheet weiter
      res[r.kind]++;
      lastId = r.id;
    } catch (e) {
      console.warn(e);
      res.errors.push(`${arr[i].name}: ${errText(e)}`);
    }
  }
  busy(null);
  render();
  if (res.errors.length) {
    infoSheet('Nicht alles importiert', res.errors.join('\n'));
    return;
  }
  const parts = [];
  if (res.added) parts.push(res.added === 1 ? '1 Buch importiert' : `${res.added} Bücher importiert`);
  if (res.restored) parts.push(res.restored === 1 ? 'Lesestand wiederhergestellt' : `${res.restored}× Lesestand wiederhergestellt`);
  if (res.dup) parts.push(res.dup === 1 ? 'schon in der Bibliothek' : `${res.dup} schon vorhanden`);
  toast(parts.join(' · '));
  if (arr.length === 1 && lastId && (res.added || res.restored) && view === 'library') flashBook(lastId);
}

function errText(e) {
  const m = (e && (e.message || e.name)) || String(e);
  if (/QuotaExceeded|quota/i.test(m)) return 'Kein Speicherplatz mehr frei.';
  if (/Invalid PDF|InvalidPDF/i.test(m)) return 'Die Datei ist beschädigt oder kein gültiges PDF.';
  if (/password|Passwort|destroy/i.test(m)) return 'Ohne Passwort nicht zu öffnen.';
  return m;
}

/** Eine Datei importieren. Ist das Buch über den Fingerabdruck schon bekannt
    (z. B. nach einem Backup ohne PDFs), bekommt es nur seine Datei zurück —
    Lesestand und Lesezeichen bleiben. */
async function importOne(file, target) {
  const buf = await file.arrayBuffer();
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
  if (!head.includes('%PDF-')) throw new Error('Keine PDF-Datei.');
  const fp = await fingerprint(buf);

  let known = db.books.find((b) => b.fp === fp);
  if (known && files.has(known.id)) return { kind: 'dup', id: known.id };

  if (target && (!known || known.id !== target.id)) {
    // Andere Datei für ein vorhandenes Buch gewählt (andere Ausgabe o. ä.)
    if (!known) {
      askSheet('Andere Datei',
        `Diese Datei ist nicht genau das PDF, das zu „${target.title}“ gehört — vielleicht eine andere Ausgabe. `
        + 'Trotzdem verwenden? Lesestand und Lesezeichen bleiben, die Seitenzahlen können abweichen.',
        'Trotzdem verwenden', async () => {
          closeSheet();
          busy('Importiere …');
          try { target.fp = fp; await attachFile(target, file, new Uint8Array(buf), false); toast('Datei zugeordnet'); }
          catch (e) { infoSheet('Import fehlgeschlagen', errText(e)); }
          busy(null);
          render();
        }, () => openBookSheet(target.id));
      return { kind: 'ask' };
    }
  }

  const isNew = !known;
  const b = known || Object.assign(blankBook(), { id: uid(), fp, added: new Date().toISOString() });
  await attachFile(b, file, new Uint8Array(buf), isNew);
  if (isNew) { db.books.push(b); save(); }
  return { kind: isNew ? 'added' : 'restored', id: b.id };
}

/** Datei, Cover und Eckdaten zu einem Buch speichern. */
async function attachFile(b, file, bytes, readMeta) {
  const pdf = await openPdf(bytes);
  try {
    if (readMeta) {
      const meta = await pdf.getMetadata().catch(() => null);
      Object.assign(b, pickTitle(meta, file.name));
    }
    b.fileName = file.name || b.fileName;
    b.size = file.size;
    b.pages = pdf.numPages;
    b.pos.page = clamp(b.pos.page, 1, b.pages);
    const cover = await renderCover(pdf).catch(() => null);
    await idbPut('pdf', b.id, file);
    if (cover) { await idbPut('cover', b.id, cover); setCoverUrl(b.id, cover); }
    await idbDel('text', b.id);              // alter Text-Cache passt evtl. nicht zur neuen Datei
    files.add(b.id);
    save();
  } finally {
    closePdf(pdf);
  }
}

/** PDFs in IndexedDB ohne Eintrag in der Bibliothek — etwa wenn localStorage
    allein gelöscht wurde. Statt sie verwaisen zu lassen, wird das Buch neu
    angelegt; der Lesestand ist dann zwar weg, die Datei aber nicht. */
let recovering = false;
async function recoverOrphans() {
  if (recovering) return;
  recovering = true;
  let n = 0;
  try {
    for (const id of [...files].filter((x) => !book(x))) {
      try {
        const blob = await idbGet('pdf', id);
        if (!blob) continue;
        const buf = await blob.arrayBuffer();
        const fp = await fingerprint(buf);
        if (book(id)) continue;                        // inzwischen anders angelegt
        if (db.books.some((b) => b.fp === fp)) {       // dieselbe Datei gibt es schon
          await Promise.all(STORES.map((s) => idbDel(s, id)));
          files.delete(id);
          setCoverUrl(id, null);
          continue;
        }
        const b = Object.assign(blankBook(), { id, fp, added: new Date().toISOString() });
        await attachFile(b, blob, new Uint8Array(buf), true);
        if (!book(id)) { db.books.push(b); n++; }
      } catch (e) { console.warn('Wiederherstellen fehlgeschlagen', id, e); }
    }
  } finally { recovering = false; }
  if (n) { save(); render(); toast(n === 1 ? '1 Buch wiederhergestellt' : `${n} Bücher wiederhergestellt`); }
}

/* ── Navigation ─────────────────────────────────────────────── */
const TITLES = { library: 'Bibliothek', shelves: 'Regale', stats: 'Statistik', settings: 'Einstellungen' };
let view = 'library';

function nav(v) {
  if (!TITLES[v]) v = 'library';
  view = v;
  $$('.view').forEach((s) => s.classList.toggle('hidden', s.id !== 'view-' + v));
  $$('.tabbar button[data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === v));
  $('#viewTitle').textContent = TITLES[v];
  window.scrollTo(0, 0);
  armBack();                    // Zurück soll auf die Bibliothek führen, nicht aus der App
  render();
}

/** Alles neu zeichnen. Bei den Datenmengen einer Handy-App ist gezieltes
    Aktualisieren unnötige Komplexität — einmal neu rendern ist schnell genug
    und kann nicht aus dem Tritt geraten. */
function render() {
  renderTop();
  if (view === 'library') renderLibrary();
  else if (view === 'shelves') renderShelves();
  else if (view === 'stats') renderStats();
  else if (view === 'settings') renderSettings();
}

function renderTop() {
  const a = $('#topActions');
  if (view === 'library' && db.books.length) {
    a.innerHTML = `
      <button class="icon-btn${libSearchOpen ? ' on' : ''}" data-act="libSearch" aria-label="Suchen">${ic('search')}</button>
      <button class="icon-btn" data-act="libSort" aria-label="Sortieren">${ic('sort')}</button>
      <button class="icon-btn" data-act="libLayout" aria-label="${db.lib.layout === 'grid' ? 'Als Liste zeigen' : 'Als Raster zeigen'}">${ic(db.lib.layout === 'grid' ? 'list' : 'grid')}</button>`;
  } else if (view === 'shelves' && db.shelves.length) {
    a.innerHTML = `<button class="icon-btn" data-act="shelfNew" aria-label="Neues Regal">${ic('add')}</button>`;
  } else {
    a.innerHTML = '';
  }
}

/* ── Bibliothek ─────────────────────────────────────────────── */
let libQuery = '';
let libSearchOpen = false;
const FILTERS = { all: 'Alle', reading: 'Lese ich', unread: 'Ungelesen', done: 'Gelesen' };

function matchFilter(b, f) {
  if (f === 'reading') return !!b.lastRead && !b.finished;
  if (f === 'unread') return !b.lastRead && !b.finished;
  if (f === 'done') return !!b.finished;
  if (f.startsWith('shelf:')) return b.shelves.includes(f.slice(6));
  return true;
}

function sortBooks(list, s) {
  const byTitle = (a, b) => a.title.localeCompare(b.title, 'de', { numeric: true, sensitivity: 'base' });
  const ts = (x) => (x ? new Date(x).getTime() : 0);
  const fns = {
    recent: (a, b) => ts(b.lastRead) - ts(a.lastRead) || ts(b.added) - ts(a.added),
    added: (a, b) => ts(b.added) - ts(a.added),
    title: byTitle,
    // Bücher ohne Autor ans Ende
    author: (a, b) => (a.author || '￿').localeCompare(b.author || '￿', 'de', { sensitivity: 'base' }) || byTitle(a, b),
    progress: (a, b) => progress(b) - progress(a) || byTitle(a, b),
  };
  return list.slice().sort(fns[s] || fns.recent);
}

function renderLibrary() {
  const el = $('#view-library');
  if (!db.books.length) { el.innerHTML = emptyLibraryHTML(); return; }
  el.innerHTML = (libSearchOpen
    ? `<div class="lib-search"><input type="search" id="libQ" placeholder="Titel oder Autor suchen" value="${esc(libQuery)}" autocomplete="off" enterkeyhint="search"></div>`
    : '') + `<div id="libList">${libListHTML()}</div>`;
}
/* Beim Tippen in die Suche nur die Liste neu — sonst verliert das Feld den Fokus. */
function renderLibList() { const l = $('#libList'); if (l) l.innerHTML = libListHTML(); }

function libListHTML() {
  const f = db.lib.filter;
  const q = Reflow.fold(libQuery.trim());
  let list = db.books.filter((b) => matchFilter(b, f));
  if (q) list = list.filter((b) => Reflow.fold(`${b.title} ${b.author} ${b.fileName}`).includes(q));
  list = sortBooks(list, db.lib.sort);
  let h = q ? '' : backupHint();
  const cont = !q && f === 'all' ? continueBook() : null;
  if (cont) h += heroHTML(cont);
  h += chipsHTML();
  if (!list.length) h += `<div class="empty"><p>${q ? 'Kein Buch passt zur Suche.' : 'In dieser Auswahl liegt noch kein Buch.'}</p></div>`;
  else h += `<div class="${db.lib.layout === 'grid' ? 'grid' : 'list'}">${list.map(bookCard).join('')}</div>`;
  return h;
}

function chipsHTML() {
  const cnt = (f) => db.books.filter((b) => matchFilter(b, f)).length;
  const chip = (f, label) => `<button class="chip${db.lib.filter === f ? ' on' : ''}" data-act="libFilter" data-f="${esc(f)}">`
    + `${esc(label)}<span class="n">${cnt(f)}</span></button>`;
  return `<div class="chips">${Object.keys(FILTERS).map((f) => chip(f, FILTERS[f])).join('')}`
    + `${db.shelves.map((s) => chip('shelf:' + s.id, s.name)).join('')}</div>`;
}

function continueBook() {
  return sortBooks(db.books.filter((b) => b.lastRead && !b.finished && (!filesReady || files.has(b.id))), 'recent')[0] || null;
}

function heroHTML(b) {
  const p = progress(b);
  return `<button class="hero" data-act="open" data-id="${esc(b.id)}">
    <div class="bk-cover">${coverHTML(b)}</div>
    <div class="grow">
      <div class="k">Weiterlesen</div>
      <div class="t">${esc(b.title)}</div>
      <div class="s">Seite ${b.pos.page} von ${b.pages} · ${nf0.format(p * 100)} %</div>
      <div class="meter"><i style="width:${(p * 100).toFixed(1)}%"></i></div>
    </div></button>`;
}

function bookCard(b) {
  const p = progress(b);
  const miss = filesReady && !files.has(b.id);
  const reading = b.lastRead && !b.finished;
  const badge = miss ? '<span class="bk-badge miss">PDF fehlt</span>'
    : b.finished ? '<span class="bk-badge done">Gelesen</span>'
    : !b.lastRead ? '<span class="bk-badge">Neu</span>' : '';
  const sub = [b.author, reading ? nf0.format(p * 100) + ' %' : ''].filter(Boolean).join(' · ')
    || (b.pages ? `${b.pages} Seiten` : '');
  return `<div class="bk${miss ? ' missing' : ''}" data-act="open" data-id="${esc(b.id)}">
    <div class="bk-cover">${coverHTML(b)}${badge}${reading ? `<div class="meter"><i style="width:${(p * 100).toFixed(1)}%"></i></div>` : ''}</div>
    <div class="bk-meta">
      <div class="txt"><div class="bk-title">${esc(b.title)}</div><div class="bk-sub">${esc(sub)}</div></div>
      <button class="bk-more" data-act="book" data-id="${esc(b.id)}" aria-label="Details zu ${esc(b.title)}">${ic('more')}</button>
    </div></div>`;
}

function backupHint() {
  if (!db.books.some((b) => b.lastRead)) return '';
  const age = db.lastBackup ? daysAgo(db.lastBackup) : null;
  const snooze = db.tips.backupSnooze ? daysAgo(db.tips.backupSnooze) : 99;
  if ((age !== null && age < 30) || snooze < 7) return '';
  return `<div class="hint"><div class="grow">${age === null
    ? 'Noch kein Backup – Dein Lesestand liegt nur auf diesem Gerät.'
    : `Dein letztes Backup ist ${age} Tage alt.`}</div>
    <button class="btn btn-sm btn-ghost" data-act="hintLater">Später</button>
    <button class="btn btn-sm btn-primary" data-act="backupSave">Sichern</button></div>`;
}

function emptyLibraryHTML() {
  return `<div class="empty">${ic('book')}
    <h2>Noch keine Bücher</h2>
    <p>Importiere ein PDF über das Plus unten. Die Datei bleibt nur auf diesem Gerät – nichts wird hochgeladen.</p>
    <button class="btn btn-primary" data-act="import">${ic('add')} PDF importieren</button>
    <p class="small" style="margin-top:24px">Schon ein Backup? <button class="link" data-act="backupLoad">Backup laden</button></p>
  </div>`;
}

function flashBook(id) {
  const el = $(`.bk[data-id="${CSS.escape(id)}"]`);
  if (el) el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
}

function openSortSheet() {
  openSheet('Sortieren', `<div class="rows check-list">${Object.keys(SORTS).map((k) =>
    `<button class="row${db.lib.sort === k ? ' on' : ''}" data-act="libSortSet" data-v="${k}">`
    + `<span class="check">${ic('check')}</span><span class="grow">${SORTS[k]}</span></button>`).join('')}</div>`,
    null, null, 'Schließen');
}

/* ── Buch-Details ───────────────────────────────────────────── */
function openBookSheet(id) {
  const b = book(id);
  if (!b) { closeSheet(); return; }
  const miss = filesReady && !files.has(b.id);
  const p = progress(b);
  const facts = [
    ['Seiten', b.pages ? nf0.format(b.pages) : '–'],
    ['Datei', `${b.fileName || '–'}${b.size ? ' · ' + fmtBytes(b.size) : ''}`],
    ['Hinzugefügt', b.added ? dfDate.format(new Date(b.added)) : '–'],
  ];
  if (b.lastRead) facts.push(['Zuletzt gelesen', dfDate.format(new Date(b.lastRead))]);
  if (b.readSec >= 60) facts.push(['Lesezeit', fmtDur(b.readSec)]);
  if (b.finished) facts.push(['Gelesen am', dfDate.format(new Date(b.finished))]);
  if (b.marks.length) facts.push(['Lesezeichen', String(b.marks.length)]);
  const sid = esc(b.id);

  openSheet('Buch', `
    <div class="bs-head"><div class="bk-cover">${coverHTML(b)}</div><div style="flex:1;min-width:0">
      <h2>${esc(b.title)}</h2>
      <div class="a">${esc(b.author || 'Autor unbekannt')}</div>
      ${b.lastRead || b.finished
        ? `<div class="meter"><i style="width:${(p * 100).toFixed(1)}%"></i></div>
           <div class="small muted" style="margin-top:6px">${b.finished ? 'Gelesen' : `${nf0.format(p * 100)} % · Seite ${b.pos.page} von ${b.pages}`}</div>`
        : '<div class="small muted">Noch nicht begonnen</div>'}
    </div></div>
    ${miss ? `<div class="hint"><div class="grow">Die PDF-Datei fehlt auf diesem Gerät. Importiere dieselbe Datei
      noch einmal – Lesestand und Lesezeichen bleiben erhalten.</div></div>` : ''}
    <button class="btn btn-primary btn-block" data-act="${miss ? 'relink' : 'open'}" data-id="${sid}">
      ${miss ? 'PDF importieren' : b.lastRead ? 'Weiterlesen' : 'Lesen'}</button>
    <div class="sec-h">Regale</div>
    <div class="chip-pick">${db.shelves.map((s) =>
      `<button class="chip${b.shelves.includes(s.id) ? ' on' : ''}" data-act="bookShelf" data-id="${sid}" data-shelf="${esc(s.id)}">${esc(s.name)}</button>`).join('')}
      <button class="chip" data-act="shelfNewFor" data-id="${sid}">+ Neues Regal</button></div>
    <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    <div class="stack-btns">
      <button class="btn btn-block" data-act="bookEdit" data-id="${sid}">${ic('edit')} Titel und Autor ändern</button>
      <button class="btn btn-block" data-act="bookDone" data-id="${sid}">${ic('check')} ${b.finished ? 'Als ungelesen markieren' : 'Als gelesen markieren'}</button>
      ${b.lastRead || b.finished ? `<button class="btn btn-block" data-act="bookReset" data-id="${sid}">Lesestand zurücksetzen</button>` : ''}
      <button class="btn btn-block btn-ghost danger-text" data-act="bookDel" data-id="${sid}">${ic('del')} Buch löschen</button>
    </div>`, null, null, 'Schließen');
}

function editBook(id) {
  const b = book(id);
  openSheet('Titel und Autor', `
    <label>Titel<input id="ed_t" value="${esc(b.title)}" autocomplete="off"></label>
    <label>Autor<input id="ed_a" value="${esc(b.author)}" autocomplete="off" placeholder="optional"></label>`,
    () => {
      const t = $('#ed_t').value.trim();
      if (!t) { toast('Der Titel fehlt'); return; }
      b.title = t.slice(0, 200);
      b.author = $('#ed_a').value.trim().slice(0, 120);
      save(); render(); openBookSheet(id); toast('Gesichert');
    });
  $('#sheetCancel').onclick = () => openBookSheet(id);
}

function toggleDone(id) {
  const b = book(id);
  b.finished = b.finished ? null : new Date().toISOString();
  save(); render(); openBookSheet(id);
  toast(b.finished ? 'Als gelesen markiert' : 'Als ungelesen markiert');
}

function resetBook(id) {
  const b = book(id);
  askSheet('Lesestand zurücksetzen?',
    'Das Buch springt auf Seite 1 zurück und gilt wieder als ungelesen. Lesezeichen und Statistik bleiben.',
    'Zurücksetzen', () => {
      b.pos = { page: 1, frac: 0 }; b.lastRead = null; b.finished = null; b.maxPage = 1;
      save(); render(); openBookSheet(id); toast('Zurückgesetzt');
    }, () => openBookSheet(id), true);
}

function deleteBook(id) {
  const b = book(id);
  askSheet('Buch löschen?',
    `„${b.title}“ wird mit Lesestand und Lesezeichen von diesem Gerät entfernt. Das lässt sich nicht rückgängig machen.`,
    'Löschen', async () => {
      db.books = db.books.filter((x) => x.id !== id);
      save(); closeSheet();
      files.delete(id);
      setCoverUrl(id, null);
      try { await Promise.all(STORES.map((s) => idbDel(s, id))); } catch (e) { console.warn(e); }
      render(); toast('Gelöscht');
    }, () => openBookSheet(id), true);
}

/* ── Regale ─────────────────────────────────────────────────── */
const shelf = (id) => db.shelves.find((s) => s.id === id);

/** Regal anlegen; ein gleichnamiges wird wiederverwendet statt verdoppelt. */
function createShelf(name) {
  name = String(name || '').trim().slice(0, 60);
  if (!name) { toast('Der Name fehlt'); return null; }
  const same = db.shelves.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (same) return same;
  const s = { id: uid(), name, created: new Date().toISOString() };
  db.shelves.push(s);
  save();
  return s;
}

function newShelf() {
  askText('Neues Regal', 'Name', { placeholder: 'z. B. Fachbücher', okLabel: 'Anlegen' }, (v) => {
    const s = createShelf(v);
    if (!s) return;
    render();
    if (db.books.length) shelfAssign(s.id); else { closeSheet(); toast('Regal angelegt'); }
  });
}

function renderShelves() {
  const el = $('#view-shelves');
  if (!db.shelves.length) {
    el.innerHTML = `<div class="empty">${ic('shelf')}<h2>Noch keine Regale</h2>
      <p>Sortiere Deine Bücher in eigene Regale, etwa „Fachbücher“ oder „Romane“. Ein Buch kann in mehreren Regalen stehen.</p>
      <button class="btn btn-primary" data-act="shelfNew">${ic('add')} Neues Regal</button></div>`;
    return;
  }
  el.innerHTML = `<div style="margin-top:8px">${db.shelves.map((s) => {
    const bs = sortBooks(db.books.filter((b) => b.shelves.includes(s.id)), 'recent');
    const done = bs.filter((b) => b.finished).length;
    return `<div class="shelf" data-act="shelfOpen" data-id="${esc(s.id)}" role="button" tabindex="0">
      <div class="stack">${bs.slice(0, 3).map((b) => `<div>${coverHTML(b)}</div>`).join('') || '<div></div>'}</div>
      <div class="grow"><div class="t">${esc(s.name)}</div>
        <div class="s">${bs.length === 1 ? '1 Buch' : `${bs.length} Bücher`}${done ? ` · ${done} gelesen` : ''}</div></div>
      <button class="icon-btn" data-act="shelfMenu" data-id="${esc(s.id)}" aria-label="Regal „${esc(s.name)}“ bearbeiten">${ic('more')}</button>
    </div>`;
  }).join('')}</div>
  <p class="note">Tippe auf ein Regal, um seine Bücher zu sehen. Zuordnen kannst Du über die drei Punkte am Regal oder in den Details eines Buchs.</p>`;
}

function shelfMenu(id) {
  const s = shelf(id);
  if (!s) { closeSheet(); return; }
  openSheet(s.name, `<div class="rows">
    <button class="row" data-act="shelfAssign" data-id="${esc(id)}">${ic('shelf')}<span class="grow">Bücher zuordnen</span></button>
    <button class="row" data-act="shelfRename" data-id="${esc(id)}">${ic('edit')}<span class="grow">Umbenennen</span></button>
    <button class="row danger-text" data-act="shelfDel" data-id="${esc(id)}">${ic('del')}<span class="grow">Regal löschen</span></button>
  </div>`, null, null, 'Schließen');
}

function shelfAssign(id) {
  const s = shelf(id);
  const list = sortBooks(db.books, 'title');
  if (!list.length) { infoSheet('Keine Bücher', 'Importiere zuerst ein PDF.', () => shelfMenu(id)); return; }
  openSheet(`Bücher in „${s.name}“`, `<div class="rows check-list">${list.map((b) =>
    `<button class="row${b.shelves.includes(id) ? ' on' : ''}" data-act="chk" data-id="${esc(b.id)}">
      <span class="check">${ic('check')}</span>
      <span class="grow"><span>${esc(b.title)}</span>${b.author ? `<span class="sub">${esc(b.author)}</span>` : ''}</span></button>`).join('')}</div>`,
    () => {
      const on = new Set($$('#sheetBody .row.on').map((r) => r.dataset.id));
      db.books.forEach((b) => {
        const has = b.shelves.includes(id);
        if (on.has(b.id) && !has) b.shelves.push(id);
        if (!on.has(b.id) && has) b.shelves = b.shelves.filter((x) => x !== id);
      });
      save(); closeSheet(); render(); toast('Gesichert');
    });
  $('#sheetCancel').onclick = () => shelfMenu(id);
}

function shelfRename(id) {
  const s = shelf(id);
  askText('Regal umbenennen', 'Name', { value: s.name, okLabel: 'Sichern' }, (v) => {
    v = String(v).trim().slice(0, 60);
    if (!v) { toast('Der Name fehlt'); return; }
    s.name = v; save(); closeSheet(); render(); toast('Umbenannt');
  }, () => shelfMenu(id));
}

function shelfDelete(id) {
  const s = shelf(id);
  askSheet('Regal löschen?', `„${s.name}“ wird entfernt. Die Bücher darin bleiben in der Bibliothek.`, 'Löschen', () => {
    db.shelves = db.shelves.filter((x) => x.id !== id);
    db.books.forEach((b) => { b.shelves = b.shelves.filter((x) => x !== id); });
    if (db.lib.filter === 'shelf:' + id) db.lib.filter = 'all';
    save(); closeSheet(); render(); toast('Regal gelöscht');
  }, () => shelfMenu(id), true);
}

/* ── Statistik ──────────────────────────────────────────────── */
let statRange = 'week';      // week | month | year
let chartData = [];

const statDay = (k) => db.stats[k] || { s: 0, p: 0 };

/** Die letzten n Tage bis heute, je um 12 Uhr — Mittag statt Mitternacht,
    damit die Sommerzeit-Umstellung keinen Tag verschluckt. */
function lastDays(n) {
  const out = [], d = new Date();
  d.setHours(12, 0, 0, 0);
  for (let i = n - 1; i >= 0; i--) { const x = new Date(d); x.setDate(d.getDate() - i); out.push(x); }
  return out;
}

/** Tage in Folge mit mindestens einer Minute Lesezeit. Die laufende Serie
    reißt erst, wenn auch gestern nichts gelesen wurde — heute ist ja noch Zeit. */
function streaks() {
  const keys = Object.keys(db.stats).filter((k) => db.stats[k].s >= 60).sort();
  let best = 0, run = 0, prev = null;
  keys.forEach((k) => {
    const t = new Date(k + 'T12:00');
    run = prev && Math.round((t - prev) / 86400000) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  });
  const set = new Set(keys), d = new Date();
  d.setHours(12, 0, 0, 0);
  if (!set.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let cur = 0;
  while (set.has(dayKey(d))) { cur++; d.setDate(d.getDate() - 1); }
  return { cur, best };
}

function durHTML(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}<small>Min.</small>`;
  return `${Math.floor(m / 60)}<small>Std.</small> ${m % 60}<small>Min.</small>`;
}
const tile = (l, v, d) => `<div class="tile"><div class="tile-l">${esc(l)}</div><div class="tile-v">${v}</div><div class="tile-d">${esc(d)}</div></div>`;

function renderStats() {
  const el = $('#view-stats');
  const all = Object.values(db.stats);
  const totalS = all.reduce((n, v) => n + v.s, 0);
  const totalP = all.reduce((n, v) => n + v.p, 0);
  const finished = db.books.filter((b) => b.finished);
  if (totalS < 30 && !finished.length) {
    el.innerHTML = `<div class="empty">${ic('chart')}<h2>Noch keine Lesezeit</h2>
      <p>Sobald Du liest, siehst Du hier, wie viel und wie regelmäßig: Minuten und Seiten pro Tag, Serien und Dein Tempo je Buch.</p></div>`;
    return;
  }
  const year = new Date().getFullYear();
  const doneYear = finished.filter((b) => new Date(b.finished).getFullYear() === year).length;
  const today = statDay(dayKey(new Date()));
  const wk = lastDays(7).map((d) => statDay(dayKey(d)));
  const wkS = wk.reduce((n, v) => n + v.s, 0);
  const st = streaks();
  const readBooks = db.books.filter((b) => b.readSec >= 60).sort((a, b) => b.readSec - a.readSec);

  el.innerHTML = `
    <div class="sec-h">Überblick</div>
    <div class="tiles">
      ${tile('Heute', durHTML(today.s), today.p ? `${today.p} ${today.p === 1 ? 'Seite' : 'Seiten'}` : 'noch nichts gelesen')}
      ${tile('Serie', `${st.cur}<small>${st.cur === 1 ? 'Tag' : 'Tage'}</small>`, `Rekord: ${st.best} ${st.best === 1 ? 'Tag' : 'Tage'}`)}
      ${tile('Letzte 7 Tage', durHTML(wkS), `Ø ${nf0.format(wkS / 7 / 60)} Min. pro Tag`)}
      ${tile(`Gelesen ${year}`, `${doneYear}<small>${doneYear === 1 ? 'Buch' : 'Bücher'}</small>`, `insgesamt ${finished.length}`)}
    </div>
    <div class="sec-h">Lesezeit</div>
    <div class="chart-card">
      <div class="chart-head"><div class="seg small" style="flex:1">${[['week', '7 Tage'], ['month', '30 Tage'], ['year', '12 Monate']]
        .map(([k, l]) => `<button data-act="statRange" data-v="${k}" class="${statRange === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="chart" id="chart">${chartSVG()}</div>
      <div class="chart-head" style="padding:10px 4px 0"><span class="s">${esc(chartCaption())}</span></div>
    </div>
    ${readBooks.length ? `<div class="sec-h">Bücher</div><div class="rows">${readBooks.map(bookStatRow).join('')}</div>` : ''}
    <p class="note">Insgesamt ${fmtDur(totalS)} gelesen, ${nf0.format(totalP)} Seiten. Gezählt wird, solange ein Buch offen ist –
      nach 5 Minuten ohne Blättern pausiert die Uhr. Eine Seite zählt, wenn sie mindestens 4 Sekunden zu sehen war.</p>`;
}

function bookStatRow(b) {
  const pace = b.readPages >= 3 ? b.readSec / b.readPages : 0;
  const left = pace && !b.finished ? Math.max(0, b.pages - b.pos.page) * pace : 0;
  const sub = [fmtDur(b.readSec), `${nf0.format(b.readPages)} S.`];
  if (pace) sub.push(`${nf1.format(pace / 60)} Min./S.`);
  if (left >= 60) sub.push(`noch ca. ${fmtDur(left)}`);
  return `<button class="row" data-act="book" data-id="${esc(b.id)}"><span class="grow"><span>${esc(b.title)}</span>
    <span class="sub">${esc(sub.join(' · '))}</span></span><span class="num muted">${nf0.format(progress(b) * 100)} %</span></button>`;
}

function chartSeries() {
  if (statRange === 'year') {
    const out = [], now = new Date();
    for (let i = 11; i >= 0; i--) {
      const m = new Date(now.getFullYear(), now.getMonth() - i, 1, 12);
      const pre = dayKey(m).slice(0, 7);
      let s = 0, p = 0;
      Object.keys(db.stats).forEach((k) => { if (k.startsWith(pre)) { s += db.stats[k].s; p += db.stats[k].p; } });
      out.push({ label: dfMonth.format(m).replace('.', '').slice(0, 3), title: dfMonthYear.format(m), s, p, now: i === 0 });
    }
    return out;
  }
  const n = statRange === 'month' ? 30 : 7;
  return lastDays(n).map((d, i) => {
    const v = statDay(dayKey(d));
    const label = n === 7 ? dfWeekday.format(d).replace('.', '') : ((n - 1 - i) % 5 === 0 ? String(d.getDate()) : '');
    return { label, title: dfLong.format(d), s: v.s, p: v.p, now: i === n - 1 };
  });
}

function niceMax(v) {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * e >= v) return m * e;
  return 10 * e;
}
/** Säule mit 4 px Rundung oben, unten eckig auf der Grundlinie. */
function barPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Säulen von Hand als SVG. Eine Reihe, also keine Legende — die
    Überschrift sagt, was zu sehen ist. Antippen zeigt den Wert. */
function chartSVG() {
  chartData = chartSeries();
  const W = 320, H = 168, L = 32, B = 22, T = 18;
  const maxS = Math.max(60, ...chartData.map((d) => d.s));
  const hours = maxS > 3 * 3600;
  const unit = hours ? 3600 : 60;
  const top = niceMax(maxS / unit);
  const ph = H - B - T, slot = (W - L) / chartData.length;
  const bw = Math.min(24, slot - 2);
  let g = '';
  [0, 0.5, 1].forEach((f) => {
    const y = (T + ph * (1 - f)).toFixed(1);
    g += `<line class="gl" x1="${L}" x2="${W}" y1="${y}" y2="${y}"/>`
       + `<text class="ax" x="${L - 6}" y="${(+y + 4).toFixed(1)}" text-anchor="end">${nf1.format(top * f)}</text>`;
  });
  g += `<text class="ax" x="${L - 6}" y="${T - 8}" text-anchor="end">${hours ? 'Std.' : 'Min.'}</text>`;
  const maxI = chartData.reduce((m, d, i) => (d.s > chartData[m].s ? i : m), 0);
  chartData.forEach((d, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    const h = (d.s / unit) / top * ph;
    const y = T + ph - h;
    g += `<rect class="hit" data-act="chartTip" data-i="${i}" x="${(L + i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H}">`
       + `<title>${esc(d.title)}: ${esc(fmtDur(d.s))}</title></rect>`;
    if (h >= 1) g += `<path class="bar${d.now ? ' now' : ''}" data-i="${i}" d="${barPath(x, y, bw, h, 4)}"/>`;
    if (d.label) g += `<text class="ax" x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(d.label)}</text>`;
    if (i === maxI && d.s >= 60) {
      g += `<text class="lbl" x="${(x + bw / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle">`
         + `${hours ? nf1.format(d.s / 3600) : nf0.format(d.s / 60)}</text>`;
    }
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Lesezeit, ${statRange === 'year' ? 'letzte 12 Monate' : `letzte ${chartData.length} Tage`}">${g}</svg>`
    + '<div class="chart-tip hidden" id="chartTip"></div>';
}

function chartCaption() {
  const sum = chartData.reduce((n, d) => n + d.s, 0);
  const pages = chartData.reduce((n, d) => n + d.p, 0);
  const per = statRange === 'year' ? `${fmtDur(sum / 12)} pro Monat` : `${fmtDur(sum / chartData.length)} pro Tag`;
  return `Zusammen ${fmtDur(sum)} und ${nf0.format(pages)} Seiten · Ø ${per}`;
}

function showChartTip(i) {
  const d = chartData[i];
  const tip = $('#chartTip'), svg = $('#chart svg');
  if (!d || !tip || !svg) return;
  $$('#chart .bar.sel').forEach((b) => b.classList.remove('sel'));
  const bar = $(`#chart .bar[data-i="${i}"]`);
  if (bar) bar.classList.add('sel');
  const W = 320, L = 32, slot = (W - L) / chartData.length;
  const box = bar ? bar.getBBox() : { y: 150 };
  const sx = svg.clientWidth / W;
  tip.textContent = `${d.title}: ${fmtDur(d.s)}${d.p ? ` · ${d.p} S.` : ''}`;
  tip.classList.remove('hidden');
  const x = clamp((L + i * slot + slot / 2) * sx, tip.offsetWidth / 2, svg.clientWidth - tip.offsetWidth / 2);
  tip.style.left = x + 'px';
  tip.style.top = Math.max(0, box.y * sx - 6) + 'px';
}

/* ── Einstellungen ──────────────────────────────────────────── */
function switchRow(key, label, sub) {
  return `<button class="set-row" data-act="toggle" data-k="${key}"><span class="grow">${esc(label)}`
    + `${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>`
    + `<span class="switch" role="switch" aria-checked="${!!db.read[key]}"></span></button>`;
}

function renderSettings() {
  const r = db.read;
  const last = db.lastBackup ? `Zuletzt am ${dfDate.format(new Date(db.lastBackup))}` : 'Noch nie gesichert';
  $('#view-settings').innerHTML = `
    <div class="sec-h">Darstellung</div>
    <div class="rows"><div class="set-row col"><span>App-Farbe</span><div class="seg">${Object.keys(THEMES).map((k) =>
      `<button data-act="setTheme" data-v="${k}" class="${db.theme === k ? 'on' : ''}">${THEMES[k].label}</button>`).join('')}</div></div></div>

    <div class="sec-h">Lesen</div>
    <div class="rows">
      <div class="set-row col"><span>Ansicht für neue Bücher</span><div class="seg">${Object.keys(MODES).map((k) =>
        `<button data-act="setMode" data-v="${k}" class="${r.mode === k ? 'on' : ''}">${MODES[k]}</button>`).join('')}</div>
        <span class="sub" style="margin:0">Seiten: eine PDF-Seite pro Bildschirm. Scrollen: alle Seiten untereinander.
          Text: der Text des PDFs neu umbrochen, mit eigener Schriftgröße.</span></div>
      ${switchRow('tapTurn', 'Tippen am Rand blättert', 'Links zurück, rechts weiter, in der Mitte das Menü')}
      ${switchRow('anim', 'Blätter-Animation', 'Seiten gleiten beim Umblättern')}
      ${switchRow('wake', 'Bildschirm anlassen', 'Beim Lesen bleibt das Display an – nach 10 Minuten ohne Blättern nicht mehr')}
      ${switchRow('full', 'Vollbild beim Lesen', 'Blendet die Statusleiste des Handys aus')}
    </div>

    <div class="sec-h">Daten &amp; Backup</div>
    <div class="rows">
      <button class="set-row" data-act="backupSave">${ic('download')}<span class="grow">Backup speichern<span class="sub">${esc(last)}</span></span></button>
      <button class="set-row" data-act="backupLoad">${ic('upload')}<span class="grow">Backup laden</span></button>
    </div>
    <p class="note">Alles liegt nur auf diesem Gerät. „Browserdaten löschen“ oder Deinstallieren der App entfernt Bücher und
      Lesestand ohne Rückfrage. Das Backup sichert Lesestand, Lesezeichen, Regale und Statistik – <strong>nicht die PDFs</strong>.
      Bewahre die PDF-Dateien deshalb selbst auf. Nach dem Laden eines Backups importierst Du sie erneut, die App ordnet sie
      automatisch ihrem Lesestand zu.</p>
    <div class="rows" style="margin-top:12px">
      <div class="set-row"><span class="grow">Speicher<span class="sub" id="storageInfo">wird ermittelt …</span></span></div>
      <button class="set-row" data-act="clearText"><span class="grow">Text-Zwischenspeicher leeren
        <span class="sub">Textmodus und Suche bereiten den Text beim nächsten Mal neu auf</span></span></button>
    </div>

    <div class="sec-h">App</div>
    <div class="rows">
      <div class="set-row"><span class="grow">Version</span><span class="num muted">${APP_VERSION}</span></div>
      <button class="set-row" data-act="checkUpdate"><span class="grow">Nach Update suchen</span>${ic('chev')}</button>
      <button class="set-row" data-act="about"><span class="grow">Über diese App</span>${ic('chev')}</button>
      <button class="set-row danger-text" data-act="wipe"><span class="grow">Alle Daten löschen</span></button>
    </div>`;
  fillStorageInfo();
}

async function fillStorageInfo() {
  let t = db.books.length === 1 ? '1 Buch' : `${db.books.length} Bücher`;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      t += ` · ${fmtBytes(e.usage || 0)} belegt`;
      if (e.quota) t += ` von ${fmtBytes(e.quota)}`;
    }
    if (navigator.storage && navigator.storage.persisted) {
      t += (await navigator.storage.persisted()) ? ' · vor automatischem Löschen geschützt' : ' · der Browser darf bei Platzmangel aufräumen';
    }
  } catch (e) { /* Schätzung nicht verfügbar */ }
  const el = $('#storageInfo');
  if (el) el.textContent = t;
}

function wipeAll() {
  askSheet('Alle Daten löschen?',
    'Bücher, PDF-Dateien, Lesestand, Lesezeichen, Regale und Statistik werden von diesem Gerät entfernt. '
    + 'Mach vorher ein Backup, wenn Du den Lesestand behalten willst.',
    'Alles löschen', async () => {
      closeSheet();
      try { await Promise.all(STORES.map(idbClear)); } catch (e) { console.warn(e); }
      [...coverUrls.keys()].forEach((id) => setCoverUrl(id, null));
      files = new Set();
      const theme = db.theme;
      db = blank();
      db.theme = theme;
      save();
      nav('library');
      toast('Alles gelöscht');
    }, null, true);
}

/* ── Sheet-System ───────────────────────────────────────────── */
let sheetSaveFn = null;

function openSheet(title, html, saveFn, saveLabel, cancelLabel) {
  armBack();                              // Zurück soll das Sheet schließen, nicht die App
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  $('#sheetBody').onclick = null;         // Handler des vorherigen Sheets verwerfen
  $('#sheetCancel').onclick = closeSheet; // ggf. überschriebenes Abbrechen zurücksetzen
  $('#sheetCancel').textContent = cancelLabel || 'Abbrechen';
  sheetSaveFn = saveFn || null;
  const btn = $('#sheetSave');
  btn.classList.toggle('hidden', !saveFn);
  btn.textContent = saveLabel || 'Sichern';
  $('#sheet').classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
  $('#sheetBody').scrollTop = 0;
}

function closeSheet() {
  $('#sheet').classList.add('hidden');
  $('#scrim').classList.add('hidden');
  sheetSaveFn = null;
  // Während das Sheet offen war, hat die Tastatur evtl. die Höhe verändert —
  // der Leser ordnet sich erst jetzt neu, sonst springt er bei jedem Tastendruck.
  if (R.open) setTimeout(checkReaderSize, 120);
}
const sheetOpen = () => !$('#sheet').classList.contains('hidden');

/* ── Dialoge ────────────────────────────────────────────────────
   Ersatz für confirm() / prompt() / alert(): installierte Web-Apps
   unterdrücken die nativen Dialoge je nach Gerät kommentarlos — der Knopf
   tut dann scheinbar nichts. Diese hier sind normale Sheets und
   funktionieren überall gleich.
   `back` führt zurück zum vorherigen Sheet statt alles zuzuklappen. */

function askSheet(title, text, okLabel, onOk, back, danger) {
  openSheet(title, `
    <p class="dlg-t">${esc(text)}</p>
    <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-block" id="dlgOk">${esc(okLabel)}</button>
    <button class="btn btn-block" id="dlgNo" style="margin-top:8px">Abbrechen</button>
  `, null);
  const zurueck = () => (back ? back() : closeSheet());
  $('#dlgOk').onclick = onOk;
  $('#dlgNo').onclick = zurueck;
  $('#sheetCancel').onclick = zurueck;
}

function infoSheet(title, text, back) {
  openSheet(title, `
    <p class="dlg-t">${esc(text)}</p>
    <button class="btn btn-primary btn-block" id="dlgOk">Verstanden</button>
  `, null);
  const zurueck = () => (back ? back() : closeSheet());
  $('#dlgOk').onclick = zurueck;
  $('#sheetCancel').onclick = zurueck;
}

/** Einzeiliger Texteingabe-Dialog. `opts`: {value, placeholder, numeric, password, okLabel} */
function askText(title, label, opts, onOk, back) {
  opts = opts || {};
  const type = opts.password ? 'type="password" autocomplete="off"'
    : opts.numeric ? 'type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off"' : 'type="text" autocomplete="off"';
  openSheet(title, `
    <label>${esc(label)}<input id="dlg_in" ${type}
      placeholder="${esc(opts.placeholder || '')}"
      value="${esc(opts.value == null ? '' : opts.value)}"></label>
  `, () => onOk($('#dlg_in').value), opts.okLabel || 'Übernehmen');
  if (back) $('#sheetCancel').onclick = back;
  const inp = $('#dlg_in');
  inp.focus(); inp.select && inp.select();
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); sheetSaveFn && sheetSaveFn(); } };
}

/* ── Zurück-Taste ───────────────────────────────────────────────
   Ohne Zutun beendet ein einziger Druck auf Zurück die installierte App —
   viel zu leicht aus Versehen. Deshalb liegt ein zusätzlicher Verlaufseintrag
   („Wächter") über der App: Zurück landet dann bei uns statt beim System.

   Der Druck schließt der Reihe nach, was offen ist — Sheet, Buch, Unterseite —
   und baut den Wächter danach wieder auf. Steht nichts mehr offen und Du bist
   auf der Bibliothek, fragt ein Dialog nach. */
let guardUp = false;
let leaving = false;

function pushGuard() {
  if (guardUp) return;
  guardUp = true;
  try { history.pushState({ g: 1 }, ''); } catch (e) { guardUp = false; }
}

/** Vor allem, was die Zurück-Taste abfangen soll: Sheet öffnen, Seite wechseln, Buch öffnen. */
function armBack() { pushGuard(); }

/** „Verlassen" im Abschiedsdialog: der Dialog hat selbst einen Wächter
    aufgebaut (jedes Sheet tut das). Erst ihn abräumen, dann führt der zweite
    Schritt aus der App. Beides muss über zwei Runden laufen — history.back()
    zweimal hintereinander fasst der Browser zu einem Schritt zusammen. */
function leaveApp() {
  closeSheet();
  leaving = true;
  history.back();
}

function wireBack() {
  pushGuard();
  window.addEventListener('popstate', () => {
    guardUp = false;

    if (leaving) {
      leaving = false;
      history.back();
      // Falls nichts mehr zum Zurückgehen da ist (im Browser-Tab, in dem die App
      // der erste Eintrag ist), bleiben wir hier — dann fehlt der Wächter. Kein
      // Timer zum Nachrüsten: ein pushState würde den laufenden Schritt abbrechen
      // und genau das Verlassen verhindern. Also erst beim nächsten Antippen.
      document.addEventListener('pointerdown', pushGuard, { once: true });
      return;
    }
    // Über den Abbrechen-Knopf, nicht über closeSheet: verschachtelte Sheets
    // haben dort ihren Rückweg zum vorherigen Sheet hinterlegt.
    if (sheetOpen()) { $('#sheetCancel').click(); pushGuard(); return; }
    if (R.open) { closeReader(); pushGuard(); return; }
    if (view !== 'library') { nav('library'); pushGuard(); return; }

    askSheet('App verlassen?', 'Möchtest Du die App wirklich schließen?',
      'Verlassen', leaveApp);
  });
}

/* ── Backup ─────────────────────────────────────────────────────
   Nur die Lesedaten (localStorage-Teil). Die PDFs sind zu groß für eine
   handliche Datei — sie werden nach dem Laden erneut importiert und über den
   Fingerabdruck ihrem Lesestand zugeordnet. */
function exportBackup() {
  if (R.open) saveReaderPos();
  db.lastBackup = new Date().toISOString();
  save();
  /* Der gesamte Datensatz wandert unverändert in die Datei. `meta` steht nur
     als Kopfzeile davor und wird beim Import wieder entfernt (siehe
     normalize), damit es nicht in die Daten wandert. */
  const payload = Object.assign({
    meta: { app: 'Reader', appVersion: APP_VERSION, format: db.v, exported: db.lastBackup,
      note: 'Lesestand, Lesezeichen, Regale und Statistik. Die PDF-Dateien sind nicht enthalten.' },
  }, db);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `reader-${dayKey(new Date())}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup gespeichert');
  render();
}

function pickBackup() {
  const inp = $('#backupInput');
  inp.value = '';
  inp.click();
}

function importBackup(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result);
      if (!d || !Array.isArray(d.books)) throw new Error('Die Datei ist kein Backup dieser App.');
      // normalize() ergänzt, was in einem älteren Backup fehlt, und wirft die Kopfzeile `meta` weg.
      const stand = d.meta && d.meta.exported ? ` vom ${dfLong.format(new Date(d.meta.exported))}` : '';
      const inc = normalize(d);
      const fps = new Set(inc.books.map((b) => b.fp).filter(Boolean));
      // Bücher, deren PDF hier liegt, die aber nicht im Backup stehen, bleiben erhalten.
      const keep = db.books.filter((b) => files.has(b.id) && !fps.has(b.fp));
      const onDevice = (b) => db.books.some((c) => c.fp && c.fp === b.fp && files.has(c.id));
      const missing = inc.books.filter((b) => !onDevice(b)).length;
      let text = `Das Backup${stand} enthält ${inc.books.length === 1 ? '1 Buch' : `${inc.books.length} Bücher`} `
        + 'mit Lesestand und Lesezeichen sowie Regale und Statistik. Deine jetzigen Lesedaten werden dabei ersetzt.';
      if (missing) text += `\n\n${missing === 1 ? '1 Buch liegt' : `${missing} Bücher liegen`} nicht als PDF auf diesem Gerät. `
        + 'Importiere die Dateien danach erneut – sie werden automatisch zugeordnet.';
      if (keep.length) text += `\n\n${keep.length === 1 ? '1 Buch, das' : `${keep.length} Bücher, die`} nicht im Backup `
        + `${keep.length === 1 ? 'steht, bleibt' : 'stehen, bleiben'} in der Bibliothek.`;
      askSheet('Backup laden', text, 'Laden', () => {
        // IDs der Bücher übernehmen, deren PDF schon hier liegt — die Datei
        // hängt in IndexedDB an der ID.
        inc.books.forEach((b) => {
          const c = db.books.find((x) => x.fp && x.fp === b.fp && files.has(x.id));
          if (c) b.id = c.id;
        });
        keep.forEach((b) => { b.shelves = []; inc.books.push(b); });
        if (R.open) closeReader();
        db = inc;
        applyTheme(db.theme);
        save(); closeSheet(); render(); toast('Backup geladen');
      });
    } catch (e) { infoSheet('Import fehlgeschlagen', e.message || String(e)); }
  };
  r.readAsText(file);
}

/* ── Update-Erkennung ───────────────────────────────────────────
   Ohne das merkt die installierte App nie, dass eine neue Fassung online
   ist — der Service Worker liefert die alte weiter, teilweise über Tage. */
let swReg = null;

/** Welche APP_VERSION liegt im Offline-Cache? Das ist die Fassung, die beim
    nächsten Laden ausgeliefert wird — nicht zwingend die laufende. */
async function cachedVersion() {
  if (!('caches' in window)) return null;
  for (const k of await caches.keys()) {
    if (!k.startsWith('reader')) continue;
    const c = await caches.open(k);
    const res = (await c.match('./app.js')) || (await c.match('app.js'));
    if (!res) continue;
    const m = (await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (m) return m[1];
  }
  return null;
}

/** Lädt neu, wenn im Cache eine andere Fassung liegt als die laufende. Die
    Sperre in sessionStorage verhindert eine Endlosschleife, falls das
    Neuladen die Version wider Erwarten nicht ändert. Beim Lesen wird nicht
    neu geladen — das käme mitten im Satz. */
let reloading = false;
async function applyIfNewer(announce) {
  if (reloading) return false;
  const cv = await cachedVersion();
  if (!cv || cv === APP_VERSION) return false;
  if (sessionStorage.getItem('rd-reload') === cv) return false;   // schon versucht
  if (sheetOpen() || R.open) {                                     // Formular offen oder Buch offen
    toast(`Version ${cv} bereit — App neu starten`);
    return true;
  }
  reloading = true;
  sessionStorage.setItem('rd-reload', cv);
  if (announce) toast(`Version ${cv} wird geladen …`);
  setTimeout(() => location.reload(), announce ? 700 : 0);
  return true;
}

function wireUpdates() {
  if (!('serviceWorker' in navigator)) return;

  /* Auf 'controllerchange' ist kein Verlass: aktualisiert sich dieselbe
     Registrierung, gilt die Seite nicht als "neu kontrolliert" und das
     Ereignis bleibt aus. Verlässlich ist der Zustandswechsel des neuen
     Workers auf 'activated' — dann liegt der frische Cache bereit. */
  const watch = (w) => {
    if (!w) return;
    if (w.state === 'activated') { applyIfNewer(false); return; }
    w.addEventListener('statechange', () => {
      if (w.state === 'activated') applyIfNewer(false);
    });
  };

  navigator.serviceWorker.addEventListener('controllerchange', () => applyIfNewer(false));

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      swReg = reg;
      watch(reg.installing); watch(reg.waiting);
      reg.addEventListener('updatefound', () => watch(reg.installing));
      navigator.serviceWorker.ready.then(() => applyIfNewer(false));
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => {});
  });
}

/** Knopf „Nach Update suchen“: Server fragen, auf den neuen Worker warten
    (er lädt erst alle Dateien), dann wie gewohnt übernehmen. */
async function checkUpdate() {
  if (!swReg) { toast('Offline-Modus nicht aktiv – einfach neu laden'); return; }
  busy('Suche nach Update …');
  try {
    await swReg.update();
    const w = swReg.installing || swReg.waiting;
    if (w) {
      busy('Update wird geladen …');
      await new Promise((res) => {
        const f = () => { if (w.state === 'activated' || w.state === 'redundant') res(); };
        w.addEventListener('statechange', f);
        f();
        setTimeout(res, 30000);
      });
    }
  } catch (e) { busy(null); toast('Keine Verbindung zum Server'); return; }
  busy(null);
  if (!(await applyIfNewer(true))) toast(`Du hast die neueste Version (${APP_VERSION})`);
}

/* ══ Leser ═════════════════════════════════════════════════════
   Drei Ansichten teilen sich denselben Kern:
   - PageView   eine PDF-Seite pro Bildschirm, Wischen/Tippen, Pinch-Zoom
   - ScrollView alle Seiten untereinander, nur Sichtbares wird gerendert
   - TextView   der Text des PDFs neu umbrochen, in Bildschirmseiten
   Jede Ansicht hat init / go / next / prev / relayout / atEnd / destroy und
   meldet ihre Position über setPos(). Der Lesestand ist immer Seite + Anteil
   innerhalb der Seite — so überlebt er jeden Wechsel der Ansicht.
   ═══════════════════════════════════════════════════════════════ */

const R = {
  open: false,
  token: 0,          // zählt bei jedem Öffnen/Schließen hoch — alte async-Läufe erkennen sich daran
  book: null, pdf: null, lib: null, n: 1,
  labels: null,      // Seitenbezeichnungen aus dem PDF (z. B. römisch im Vorwort) oder null
  toc: [],           // Inhaltsverzeichnis, flach: {title, page, d}
  mode: 'page', page: 1, frac: 0,
  W: 0, H: 0,        // Größe der Lesefläche in CSS-Pixeln
  sizes: [],         // Seitengröße bei Maßstab 1 (Index = Seite)
  size1: null,       // Seite 1 — Schätzung für noch nicht geladene Seiten
  boxes: new Map(),  // Inhaltsbereich je Seite
  bookBox: null,     // typischer Inhaltsbereich des Buchs
  view: null,        // aktive Ansicht
  text: null, textP: null, textProg: null, lens: null, folded: null,
  search: '', searchRes: null,
  bars: false,
  lock: null, lockBusy: false, lockFail: 0,
};

function loading(msg) {
  $('#rdLoading').classList.toggle('hidden', !msg);
  if (msg) $('#rdLoadingText').textContent = msg;
}

async function openBook(id) {
  const b = book(id);
  if (!b) return;
  if (filesReady && !files.has(id)) { openBookSheet(id); return; }
  if (sheetOpen()) closeSheet();
  if (R.open) closeReader();
  armBack();                              // Zurück schließt das Buch, nicht die App
  const tok = ++R.token;
  Object.assign(R, {
    open: true, book: b, pdf: null, n: Math.max(1, b.pages), labels: null, toc: [],
    sizes: [], size1: null, boxes: new Map(), bookBox: b.box, view: null,
    text: null, textP: null, textProg: null, lens: null, folded: null, search: '', searchRes: null,
    mode: b.mode || db.read.mode, page: b.pos.page, frac: b.pos.frac,
  });
  tcCache.clear();
  document.body.classList.add('reading');
  const rd = $('#reader');
  rd.classList.remove('hidden');
  rd.dataset.mode = R.mode;
  applyPaper();
  applyTextStyle();
  $('#rdTitle').textContent = b.title;
  $('#rdChapter').textContent = b.author || '';
  $('#rdStage').innerHTML = '';
  showBars(false);
  loading('Öffne …');
  if (db.read.full) enterFull();
  try {
    const blob = await idbGet('pdf', id);
    if (!blob) throw new Error('Die PDF-Datei wurde auf diesem Gerät nicht gefunden.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (tok !== R.token) return;
    R.lib = await pdfjs();
    const pdf = await openPdf(bytes);
    if (tok !== R.token) { closePdf(pdf); return; }
    R.pdf = pdf;
    R.n = pdf.numPages;
    b.pages = R.n;
    R.size1 = await pageSize(1);
    R.page = clamp(R.page, 1, R.n);
    b.lastRead = new Date().toISOString();
    save();
    pdf.getPageLabels().then((l) => { if (tok === R.token) { R.labels = usefulLabels(l); updateUI(); } }).catch(() => {});
    loadToc(tok);
    await setMode(R.mode, true);
    if (tok !== R.token) return;
    statsStart();
    wakeOn();
    readerTip();
    if (!R.bookBox && b.crop) setTimeout(() => ensureBookBox(tok), 400);
  } catch (e) {
    if (tok !== R.token) return;
    console.error(e);
    closeReader();
    infoSheet('Öffnen fehlgeschlagen', errText(e));
  }
}

function closeReader() {
  if (!R.open) return;
  saveReaderPos();
  statsStop();
  R.token++;
  R.open = false;
  if (R.view) R.view.destroy();
  R.view = null;
  if (R.pdf) { closePdf(R.pdf); R.pdf = null; }
  wakeOff();
  exitFull();
  if (window.CSS && CSS.highlights) CSS.highlights.delete('search');
  const rd = $('#reader');
  rd.classList.add('hidden');
  $('#rdStage').innerHTML = '';
  $$('.rd-tip', rd).forEach((t) => t.remove());
  document.body.classList.remove('reading');
  setBarColor(THEMES[db.theme].bar);
  R.book = null; R.text = null; R.folded = null; R.lens = null; R.textP = null;
  tcCache.clear();
  render();
}

function saveReaderPos() {
  if (!R.book) return;
  R.book.pos = { page: R.page, frac: R.frac };
  saveNow();
}

/** Ansicht wechseln. Der Textmodus braucht den aufbereiteten Text — fehlt
    eine Textebene (Scan), bleibt es bei der bisherigen Ansicht. */
async function setMode(mode, initial) {
  if (!MODES[mode]) mode = 'page';
  const tok = R.token;
  if (mode === 'text' && !(await textReady())) {
    if (tok !== R.token) return;
    loading(null);
    if (!initial && R.view) return;
    mode = 'page';
  }
  if (tok !== R.token) return;
  if (R.view) R.view.destroy();
  R.view = null;
  R.mode = mode;
  R.book.mode = mode;
  saveSoon();
  $('#reader').dataset.mode = mode;
  measure();
  const v = mode === 'scroll' ? ScrollView : mode === 'text' ? TextView : PageView;
  R.view = v;
  await v.init();
  if (tok !== R.token) return;
  loading(null);
  updateUI();
}

async function textReady() {
  try { await ensureText(null); }
  catch (e) {
    if (R.open && !/abgebrochen/.test(e.message)) infoSheet('Text nicht verfügbar', errText(e));
    return false;
  }
  if (!R.text) return false;
  const chars = R.lens.reduce((n, l) => n + l, 0);
  if (chars < 40 * Math.min(R.n, 20)) {
    infoSheet('Kein Text gefunden', 'Dieses PDF besteht aus Bildern, etwa weil es eingescannt wurde. '
      + 'Der Textmodus braucht echten Text im PDF – bleib hier bei der Seiten- oder Scrollansicht.');
    return false;
  }
  return true;
}

/** Text des Buchs aufbereiten (reflow.js) oder aus dem Cache holen.
    `onProgress` lenkt die Fortschrittsmeldung um, etwa in die Suche —
    sonst erscheint sie groß über der Seite. */
function ensureText(onProgress) {
  if (R.text) return Promise.resolve(R.text);
  if (onProgress !== undefined) R.textProg = onProgress;
  if (R.textP) return R.textP;
  const tok = R.token, id = R.book.id;
  const p = (async () => {
    let t = null;
    try { t = await idbGet('text', id); } catch (e) { /* kein Cache — dann neu */ }
    if (!t || t.v !== REFLOW_V || !Array.isArray(t.pages) || t.pages.length !== R.n) {
      const report = (i, n) => {
        const msg = `Text wird aufbereitet … ${Math.round((i / n) * 100)} %`;
        if (tok !== R.token) return;
        if (R.textProg) R.textProg(msg); else loading(msg);
      };
      report(0, R.n);
      t = await Reflow.extract(R.pdf, R.lib.Util, report, () => tok !== R.token);
      try { await idbPut('text', id, t); } catch (e) { console.warn('Text-Cache nicht gespeichert', e); }
    }
    if (tok !== R.token) throw new Error('abgebrochen');
    R.text = t;
    R.lens = t.pages.map((pg) => Reflow.pageString(pg).length);
    return t;
  })();
  R.textP = p;
  p.catch(() => {}).then(() => { if (R.textP === p) R.textP = null; });
  return p;
}

function measure() {
  const r = $('#rdStage').getBoundingClientRect();
  R.W = Math.round(r.width);
  R.H = Math.round(r.height);
}

/** Nach Drehen, Tastatur oder Vollbild: Lesefläche neu vermessen. */
function checkReaderSize() {
  if (!R.open || !R.view || sheetOpen()) return;
  const r = $('#rdStage').getBoundingClientRect();
  if (Math.abs(r.width - R.W) < 2 && Math.abs(r.height - R.H) < 2) return;
  R.view.relayout();
}

/** Zentrale Meldung der Ansichten: hier steht der Leser jetzt.
    `via` 'jump' (Sprung über Inhalt, Regler …) markiert ein Buch nie als
    gelesen — nur wer bis zum Ende blättert, ist fertig. */
function setPos(page, frac, via) {
  const b = R.book;
  if (!b) return;
  const changed = page !== R.page;
  R.page = page;
  R.frac = clamp(frac || 0, 0, 0.999);
  b.pos.page = page;
  b.pos.frac = R.frac;
  if (page > b.maxPage) b.maxPage = page;
  if (changed) statsPage(page);
  activity();
  updateUI();
  saveSoon();
  if (via !== 'jump' && !b.finished && R.view && R.view.atEnd()) {
    b.finished = new Date().toISOString();
    save();
    toast('Ende erreicht – als gelesen markiert');
  }
}

const usefulLabels = (l) => (Array.isArray(l) && l.length === R.n && l.some((x, i) => x !== String(i + 1)) ? l : null);
const pageName = (p) => {
  const l = R.labels && R.labels[p - 1];
  return l && l !== String(p) ? `${l} (${p})` : String(p);
};

let rangeDrag = false;
function updateUI() {
  if (!R.open || !R.book) return;
  const n = R.n, p = R.page;
  const pr = Math.round(clamp(p >= n ? 1 : (p - 1 + R.frac) / n, 0, 1) * 100);
  const ch = chapterAt(p);
  $('#rdFootL').textContent = ch ? ch.title : R.book.title;
  $('#rdFootR').textContent = `${p} / ${n} · ${pr} %`;
  $('#rdChapter').textContent = ch ? ch.title : (R.book.author || '');
  const rg = $('#rdRange');
  rg.max = n;
  if (!rangeDrag) rg.value = p;
  $('#rdPageBtn').textContent = `Seite ${pageName(p)} von ${n}`;
  $('#rdLeft').textContent = leftText();
  const has = R.book.marks.some((m) => m.page === p);
  const mb = $('#rdMarkBtn');
  if (mb._has !== has) {
    mb._has = has;
    mb.innerHTML = ic(has ? 'markOn' : 'markOff');
    mb.classList.toggle('on', has);
    mb.setAttribute('aria-label', has ? 'Lesezeichen entfernen' : 'Lesezeichen setzen');
  }
}

function chapterAt(p) {
  let best = null;
  for (const t of R.toc) if (t.page && t.page <= p && (!best || t.page >= best.page)) best = t;
  return best;
}
function nextChapterPage(p) {
  if (!R.toc.length) return null;
  const c = chapterAt(p);
  const d = c ? c.d : 0;
  let nx = R.n + 1;
  for (const t of R.toc) if (t.page && t.page > p && t.d <= d && t.page < nx) nx = t.page;
  return nx;
}
function leftText() {
  const parts = [];
  const nx = nextChapterPage(R.page);
  if (nx) {
    const k = nx - R.page;
    parts.push(k <= 1 ? 'letzte Seite im Kapitel' : `noch ${k} S. im Kapitel`);
  }
  const b = R.book;
  const pace = b.readPages >= 5 && b.readSec >= 120 ? b.readSec / b.readPages : 0;
  const rest = (R.n - R.page) * pace;
  if (pace && rest >= 60) parts.push(`ca. ${fmtDur(rest)} bis zum Ende`);
  return parts.join(' · ');
}

function showBars(on) {
  R.bars = on;
  $('#reader').classList.toggle('bars', on);
  if (on) updateUI();
}
const toggleBars = () => showBars(!R.bars);

/** Gemeinsame Tipp-Logik für Seiten- und Textmodus. Rand: blättern,
    Mitte: Menü. Sind die Leisten offen, schließt jedes Tippen sie nur. */
function readerTap(x, onCenter) {
  activity();
  if (R.bars) { showBars(false); return; }
  if (db.read.tapTurn) {
    const z = x / R.W;
    if (z < 0.3) { R.view.prev(); return; }
    if (z > 0.7) { R.view.next(); return; }
  }
  if (onCenter) onCenter(); else toggleBars();
}

function applyPaper() {
  const p = db.read.paper;
  $('#reader').dataset.paper = p;
  $('#rdDim').style.opacity = db.read.dim;
  if (R.open) setBarColor(PAPERS[p].bar);
}

function applyTextStyle() {
  const s = $('#reader').style, r = db.read;
  s.setProperty('--tx-size', r.size + 'px');
  s.setProperty('--tx-lh', String(r.lh));
  s.setProperty('--tx-font', r.font === 'sans' ? 'var(--font-sans)' : 'var(--font-serif)');
  s.setProperty('--tx-m', MARGINS[r.margin] + 'px');
}

function readerTip() {
  if (db.tips.reader) return;
  db.tips.reader = true;
  save();
  if (R.mode === 'scroll' || !db.read.tapTurn) { toast('Tippe auf die Seite, um das Menü zu zeigen'); return; }
  const t = document.createElement('div');
  t.className = 'rd-tip';
  t.innerHTML = `<div>Tippen:<br>zurück</div><div>Tippen:<br>Menü${R.mode === 'page' ? '<br><br>Doppeltippen<br>oder zwei Finger:<br>Zoom' : ''}</div><div>Tippen:<br>weiter</div>`;
  t.onclick = () => t.remove();
  $('#reader').appendChild(t);
}

/* ── Bildschirm anlassen, Vollbild ──────────────────────────────
   Die Wake-Lock fällt nach 10 Minuten ohne Blättern weg — wer beim Lesen
   einschläft, soll morgens kein heißes Handy mit leerem Akku finden. */
const WAKE_IDLE = 10 * 60 * 1000;

async function wakeOn() {
  if (!db.read.wake || !R.open || R.lock || R.lockBusy || document.hidden || !('wakeLock' in navigator)) return;
  if (Date.now() - (R.lockFail || 0) < 30000) return;   // nach Ablehnung nicht bei jedem Scrollen neu fragen
  R.lockBusy = true;
  try {
    const l = await navigator.wakeLock.request('screen');
    if (!R.open) { l.release().catch(() => {}); return; }
    R.lock = l;
    l.addEventListener('release', () => { if (R.lock === l) R.lock = null; });
  } catch (e) { R.lockFail = Date.now(); /* abgelehnt (Energiesparmodus o. ä.) — dann eben ohne */ }
  finally { R.lockBusy = false; }
}
function wakeOff() {
  if (R.lock) { R.lock.release().catch(() => {}); R.lock = null; }
}
function enterFull() {
  const el = document.documentElement;
  if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}
function exitFull() {
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
}

/* ── Lesezeit ───────────────────────────────────────────────────
   Gezählt wird, solange ein Buch offen und sichtbar ist. Nach 5 Minuten
   ohne Aktivität (Blättern, Antippen, Scrollen) bleibt die Uhr stehen und
   zählt nur bis zur letzten Aktivität plus 5 Minuten — langsames Lesen einer
   dichten Seite zählt also, ein liegengelassenes Handy nicht. */
const IDLE = 5 * 60 * 1000;
const ST = { timer: null, last: 0, act: 0, counted: new Set(), pageT: null };

function statsStart() {
  ST.last = ST.act = Date.now();
  ST.counted = new Set();
  clearInterval(ST.timer);
  ST.timer = setInterval(statsTick, 15000);
}
function statsStop() {
  statsTick();
  clearInterval(ST.timer);
  ST.timer = null;
  clearTimeout(ST.pageT);
}
function activity() {
  const now = Date.now();
  if (now - ST.act > IDLE) ST.last = now;     // nach einer Pause neu anfangen zu zählen
  ST.act = now;
  if (R.open && !R.lock) wakeOn();
}
function statDayEntry() {
  const k = dayKey(new Date());
  return db.stats[k] || (db.stats[k] = { s: 0, p: 0 });
}
function statsTick() {
  if (!R.open || !R.book) return;
  const now = Date.now();
  if (now - ST.act > WAKE_IDLE) wakeOff();
  if (document.hidden) { ST.last = now; return; }
  const sec = (Math.min(now, ST.act + IDLE) - ST.last) / 1000;
  ST.last = now;
  if (sec <= 0) return;
  const e = statDayEntry();
  e.s = Math.round((e.s + sec) * 10) / 10;
  R.book.readSec = Math.round((R.book.readSec + sec) * 10) / 10;
  saveSoon();
}
/** Eine Seite zählt als gelesen, wenn sie 4 Sekunden zu sehen war — wer
    über den Regler 200 Seiten überspringt, hat sie nicht gelesen. */
function statsPage(p) {
  clearTimeout(ST.pageT);
  if (ST.counted.has(p)) return;
  ST.pageT = setTimeout(() => {
    if (!R.open || R.page !== p || ST.counted.has(p)) return;
    ST.counted.add(p);
    statDayEntry().p++;
    R.book.readPages++;
    saveSoon();
  }, 4000);
}

/* ── Seiten vermessen und zuschneiden ───────────────────────── */
const FULL = { x0: 0, y0: 0, x1: 1, y1: 1 };
const dpr = () => Math.min(window.devicePixelRatio || 1, 3);

async function pageSize(p) {
  if (R.sizes[p]) return R.sizes[p];
  const page = await R.pdf.getPage(p);
  const v = page.getViewport({ scale: 1 });
  R.sizes[p] = { w: v.width, h: v.height };
  return R.sizes[p];
}
/** Bekannte Größe oder Schätzung über Seite 1 — für das Layout im Scrollmodus,
    bevor jede Seite einzeln geladen ist. */
const sizeOf = (p) => R.sizes[p] || R.size1 || { w: 595, h: 842 };

/** Bereich mit Inhalt: Seite klein rendern und die Ränder ohne Farbe suchen.
    Ergebnis als Anteil der Seite, mit etwas Luft drumherum. */
async function pageBox(p) {
  if (R.boxes.has(p)) return R.boxes.get(p);
  const tok = R.token;
  let box = FULL;
  try {
    const page = await R.pdf.getPage(p);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 140 / v1.width });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    box = inkBox(ctx.getImageData(0, 0, c.width, c.height));
  } catch (e) { /* nicht auswertbar — dann ungeschnitten */ }
  if (tok === R.token) R.boxes.set(p, box);
  return box;
}

function inkBox(img) {
  const { width: w, height: h, data } = img;
  const rows = new Uint16Array(h), cols = new Uint16Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // „Tinte“ ist alles, was sichtbar von Weiß abweicht; zartes Grau zählt nicht
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) { rows[y]++; cols[x]++; }
    }
  }
  const minR = Math.max(1, Math.round(w * 0.01)), minC = Math.max(1, Math.round(h * 0.006));
  let y0 = 0; while (y0 < h && rows[y0] < minR) y0++;
  if (y0 >= h) return FULL;                                   // leere Seite
  let y1 = h - 1; while (y1 > y0 && rows[y1] < minR) y1--;
  let x0 = 0; while (x0 < w && cols[x0] < minC) x0++;
  let x1 = w - 1; while (x1 > x0 && cols[x1] < minC) x1--;
  const px = w * 0.03, py = h * 0.02;
  return {
    x0: clamp((x0 - px) / w, 0, 1), y0: clamp((y0 - py) / h, 0, 1),
    x1: clamp((x1 + 1 + px) / w, 0, 1), y1: clamp((y1 + 1 + py) / h, 0, 1),
  };
}

const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const boxSmall = (b) => b.x1 - b.x0 < 0.35 || b.y1 - b.y0 < 0.25;

/** Zuschnitt einer Seite im Seitenmodus: eigener Inhalt vereint mit dem
    typischen Bereich des Buchs. So bleibt die Schriftgröße von Seite zu
    Seite gleich, und eine Abbildung über den Rand hinaus wird nicht gekappt. */
async function cropFor(p) {
  if (!R.book.crop) return FULL;
  const pb = await pageBox(p);
  const bb = R.bookBox;
  if (pb === FULL) return bb || FULL;
  const b = bb ? union(pb, bb) : pb;
  return boxSmall(b) ? (bb && !boxSmall(bb) ? bb : FULL) : b;
}

/** Typischer Inhaltsbereich: bis zu neun Seiten quer durchs Buch auswerten,
    je Kante den zweitäußersten Wert nehmen — ein einzelner Ausreißer (Bild
    über die ganze Seite) zählt so nicht. Wird am Buch gespeichert. */
async function ensureBookBox(tok) {
  if (tok !== R.token || R.n < 3) return;
  const k = Math.min(9, R.n - 1), picks = new Set();
  for (let i = 0; i < k; i++) picks.add(2 + Math.round((i * (R.n - 2)) / Math.max(1, k - 1)));
  const boxes = [];
  for (const p of picks) {
    if (tok !== R.token) return;
    const b = await pageBox(Math.min(p, R.n));
    if (b !== FULL && !boxSmall(b)) boxes.push(b);
  }
  if (tok !== R.token || boxes.length < 2) return;
  const q = (arr, f) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(f * (arr.length - 1)))];
  R.bookBox = {
    x0: q(boxes.map((b) => b.x0), 0.15), y0: q(boxes.map((b) => b.y0), 0.15),
    x1: q(boxes.map((b) => b.x1), 0.85), y1: q(boxes.map((b) => b.y1), 0.85),
  };
  R.book.box = R.bookBox;
  saveSoon();
  if (R.view && R.mode !== 'text') R.view.relayout();
}

/** Seite p (zugeschnitten auf `box`) als Canvas in `host` zeichnen, cssW × cssH
    groß, bei Zoom entsprechend schärfer. Das alte Canvas bleibt stehen, bis
    das neue fertig ist — kein weißes Aufblitzen. Ein neuer Auftrag für
    denselben Host bricht den alten ab. */
async function drawPage(host, p, box, cssW, cssH, zoom) {
  const tok = (host._tok = (host._tok || 0) + 1);
  if (host._task) { try { host._task.cancel(); } catch (e) { /* schon fertig */ } host._task = null; }
  const pdf = R.pdf;
  if (!pdf) return false;
  let page;
  try { page = await pdf.getPage(p); } catch (e) { return false; }
  if (host._tok !== tok || R.pdf !== pdf) return false;
  const v1 = page.getViewport({ scale: 1 });
  const bw = v1.width * (box.x1 - box.x0), bh = v1.height * (box.y1 - box.y0);
  let res = (cssW / bw) * dpr() * (zoom || 1);      // Gerätepixel je PDF-Einheit
  // Speicher deckeln: ein Canvas über ~12 Mio. Pixel bringt Handys ins Schwitzen
  const maxPx = zoom > 1 ? 12e6 : 6e6;
  if (bw * bh * res * res > maxPx) res = Math.sqrt(maxPx / (bw * bh));
  const vp = page.getViewport({ scale: res });
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bw * res));
  c.height = Math.max(1, Math.round(bh * res));
  const task = page.render({
    canvasContext: c.getContext('2d', { alpha: false }),
    viewport: vp,
    transform: [1, 0, 0, 1, -box.x0 * vp.width, -box.y0 * vp.height],
  });
  host._task = task;
  try { await task.promise; } catch (e) { return false; }      // abgebrochen
  if (host._tok !== tok) return false;
  host._task = null;
  host._zoom = zoom || 1;
  const old = host.querySelector('canvas');
  if (old) { old.width = 0; old.height = 0; old.replaceWith(c); }   // Breite 0 gibt den Speicher sofort frei
  else host.prepend(c);
  return true;
}
function cancelDraw(host) {
  host._tok = (host._tok || 0) + 1;
  if (host._task) { try { host._task.cancel(); } catch (e) { /* egal */ } host._task = null; }
  const c = host.querySelector('canvas');
  if (c) { c.width = 0; c.height = 0; c.remove(); }
}

/* ── Inhaltsverzeichnis ─────────────────────────────────────── */
async function loadToc(tok) {
  try {
    const ol = await R.pdf.getOutline();
    if (!ol || tok !== R.token) return;
    const out = [];
    const walk = async (items, d) => {
      for (const it of items) {
        if (tok !== R.token) return;
        out.push({ title: String(it.title || '').replace(/\s+/g, ' ').trim() || '—', page: await destPage(it.dest), d });
        if (it.items && it.items.length && d < 3) await walk(it.items, d + 1);
      }
    };
    await walk(ol, 0);
    if (tok !== R.token) return;
    R.toc = out;
    updateUI();
  } catch (e) { /* kaputtes Inhaltsverzeichnis — dann eben keins */ }
}
async function destPage(dest) {
  try {
    const d = typeof dest === 'string' ? await R.pdf.getDestination(dest) : dest;
    if (!Array.isArray(d)) return null;
    if (d[0] && typeof d[0] === 'object') return (await R.pdf.getPageIndex(d[0])) + 1;
    if (Number.isInteger(d[0])) return d[0] + 1;
  } catch (e) { /* Ziel nicht auflösbar */ }
  return null;
}

/* ── Gesten ─────────────────────────────────────────────────────
   Pointer-Events statt Touch-Events: funktioniert mit Finger und Maus gleich.
   Aus den Rohdaten werden Tippen, Wischen (waagrecht), Verschieben (bei
   Zoom) und Zwei-Finger-Zoom. Die Ansicht entscheidet, was sie damit macht. */
const gdist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const gmid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function gestures(el, h) {
  const pts = new Map();
  let g = null;
  const rel = (e) => { const r = $('#rdStage').getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { el.setPointerCapture(e.pointerId); } catch (_) { /* egal */ }
    const p = rel(e);
    pts.set(e.pointerId, p);
    if (pts.size === 1) {
      const t = performance.now();
      g = { kind: 'tap', x0: p.x, y0: p.y, t0: t, lx: p.x, lt: t, vx: 0 };
    } else if (pts.size === 2 && h.pinchStart) {
      if (g && g.kind === 'swipe' && h.swipeEnd) h.swipeEnd(0, 0, true);
      const [a, b] = [...pts.values()];
      g = { kind: 'pinch', d0: gdist(a, b) || 1 };
      h.pinchStart(gmid(a, b));
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    const p = rel(e);
    pts.set(e.pointerId, p);
    if (g.kind === 'pinch') {
      if (pts.size >= 2) { const [a, b] = [...pts.values()]; h.pinchMove(gdist(a, b) / g.d0, gmid(a, b)); }
      return;
    }
    const dx = p.x - g.x0, dy = p.y - g.y0;
    const now = performance.now();
    if (now > g.lt) { g.vx = g.vx * 0.4 + ((p.x - g.lx) / (now - g.lt)) * 0.6; g.lx = p.x; g.lt = now; }
    if (g.kind === 'tap' && Math.hypot(dx, dy) > 10) {
      if (h.canPan && h.canPan()) { g.kind = 'pan'; h.panStart(); }
      else g.kind = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'vswipe';
    }
    if (g.kind === 'swipe' && h.swipeMove) h.swipeMove(dx);
    else if (g.kind === 'pan') h.panMove(dx, dy);
  });

  const up = (e, cancel) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!g) return;
    activity();
    if (g.kind === 'pinch') {
      if (pts.size < 2) {
        h.pinchEnd();
        // Ein Finger bleibt liegen: nahtlos ins Verschieben übergehen
        const rest = [...pts.values()][0];
        if (rest && h.canPan && h.canPan()) { g = { kind: 'pan', x0: rest.x, y0: rest.y, t0: performance.now(), vx: 0 }; h.panStart(); }
        else g = null;
      }
      return;
    }
    if (pts.size) return;
    const p = rel(e);
    const dx = p.x - g.x0, dy = p.y - g.y0;
    const kind = g.kind;
    const vx = g.vx;
    const quick = performance.now() - g.t0 < 500;
    g = null;
    if (cancel) {
      if (kind === 'swipe' && h.swipeEnd) h.swipeEnd(0, 0, true);
      if (kind === 'pan') h.panEnd(0, 0);
      return;
    }
    if (kind === 'tap' && quick) h.tap(p.x, p.y);
    else if (kind === 'swipe' && h.swipeEnd) h.swipeEnd(dx, vx, false);
    else if (kind === 'pan') h.panEnd(dx, dy);
  };
  el.addEventListener('pointerup', (e) => up(e, false));
  el.addEventListener('pointercancel', (e) => up(e, true));
}

/** Wurde weit genug oder schnell genug gewischt, um zu blättern? */
const swipeTurns = (dx, vx) => Math.abs(dx) > R.W * 0.18
  || (Math.abs(vx) > 0.35 && Math.sign(vx) === Math.sign(dx) && Math.abs(dx) > 30);

/* ── Seitenmodus ────────────────────────────────────────────────
   Drei Plätze nebeneinander: vorige, aktuelle, nächste Seite. Beim Wischen
   folgt die Spur dem Finger; nach dem Blättern rücken die Plätze einen
   weiter, und nur die neu hinzugekommene Nachbarseite wird gerendert. */
const PageView = {
  track: null, slots: [], Z: { s: 1, x: 0, y: 0 }, anim: null, tapT: null, lastTap: 0, sharpT: null, wheelT: 0,

  init() {
    $('#rdStage').innerHTML = '<div class="pm-track"><div class="pm-slot"></div><div class="pm-slot"></div><div class="pm-slot"></div></div>';
    this.track = $('#rdStage .pm-track');
    this.slots = $$('.pm-slot', this.track);
    this.Z = { s: 1, x: 0, y: 0 };
    this.anim = null;
    this.place();
    gestures(this.track, this.gest());
    this.track.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    // R.frac bleibt stehen, bis geblättert wird — so führt ein Wechsel
    // Text → Seiten → Text wieder genau an dieselbe Stelle.
    return this.renderAll();
  },

  place() { this.slots.forEach((s, i) => { s.style.left = (i - 1) * R.W + 'px'; s.style.width = R.W + 'px'; }); },
  cur() { return this.slots[1].querySelector('.pg'); },

  async renderAll() {
    const p = R.page;
    await this.renderSlot(this.slots[1], p);
    this.renderSlot(this.slots[2], p + 1);
    this.renderSlot(this.slots[0], p - 1);
  },

  async renderSlot(slot, p) {
    slot._want = p;
    if (p < 1 || p > R.n) {
      const pg = slot.querySelector('.pg');
      if (pg) cancelDraw(pg);
      slot.innerHTML = ''; slot._key = '';
      return;
    }
    const key = `${p}|${R.W}|${R.H}|${R.book.crop}|${R.bookBox ? 1 : 0}`;
    if (slot._key === key) return;
    const box = await cropFor(p);
    if (slot._want !== p || !R.open) return;
    const sz = await pageSize(p);
    if (slot._want !== p || !R.open) return;
    const bw = sz.w * (box.x1 - box.x0), bh = sz.h * (box.y1 - box.y0);
    const fit = Math.min(R.W / bw, R.H / bh);
    const cssW = Math.floor(bw * fit), cssH = Math.floor(bh * fit);
    const left = Math.round((R.W - cssW) / 2), top = Math.round((R.H - cssH) / 2);
    let pg = slot.querySelector('.pg');
    if (!pg) {
      pg = document.createElement('div');
      pg.className = 'pg';
      pg.innerHTML = '<div class="hl-layer"></div>';
      slot.appendChild(pg);
    }
    if (pg._p !== p) {                    // andere Seite: alte sofort weg, lieber kurz leer als falsch
      cancelDraw(pg);
      pg.querySelector('.hl-layer').innerHTML = '';
    }
    pg._p = p;
    pg._geo = { p, box, sz, fit, cssW, cssH, left, top };
    Object.assign(pg.style, { left: left + 'px', top: top + 'px', width: cssW + 'px', height: cssH + 'px', transform: '' });
    slot._key = key;
    if (await drawPage(pg, p, box, cssW, cssH, 1)) drawHighlights(pg);
  },

  turn(dir) {
    if (this.anim) this.anim();               // laufende Animation sofort abschließen
    const p = R.page + dir;
    if (p < 1 || p > R.n) {
      this.snap();
      toast(dir > 0 ? 'Ende des Buchs erreicht' : 'Anfang des Buchs');
      return;
    }
    const finish = () => {
      this.anim = null;
      this.track.classList.remove('anim');
      this.track.style.transform = '';
      this.resetZoom(false, true);
      if (dir > 0) this.slots.push(this.slots.shift()); else this.slots.unshift(this.slots.pop());
      this.place();
      setPos(p, 0, 'turn');
      if (this.slots[1]._want !== p) this.renderSlot(this.slots[1], p);
      this.renderSlot(dir > 0 ? this.slots[2] : this.slots[0], p + dir);
    };
    if (db.read.anim && !reducedMotion()) {
      this.track.classList.add('anim');
      this.track.style.transform = `translateX(${-dir * R.W}px)`;
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        this.track.removeEventListener('transitionend', end);
        finish();
      };
      const t = setTimeout(end, 360);
      this.track.addEventListener('transitionend', end);
      this.anim = end;
    } else finish();
  },

  snap() {
    if (!this.track.style.transform) return;
    this.track.classList.toggle('anim', db.read.anim && !reducedMotion());
    this.track.style.transform = '';
    setTimeout(() => { if (!this.anim) this.track.classList.remove('anim'); }, 260);
  },

  next() { this.turn(1); },
  prev() { this.turn(-1); },

  async go(p, via) {
    p = clamp(p, 1, R.n);
    if (this.anim) this.anim();
    this.resetZoom(false, true);
    setPos(p, 0, via);
    await this.renderAll();
  },

  relayout() {
    measure();
    if (this.anim) this.anim();
    this.place();
    this.Z = { s: 1, x: 0, y: 0 };
    this.renderAll();
  },

  atEnd() { return R.page >= R.n; },

  destroy() {
    clearTimeout(this.tapT); clearTimeout(this.sharpT);
    this.slots.forEach((s) => { const pg = s.querySelector('.pg'); if (pg) cancelDraw(pg); });
    this.slots = [];
  },

  /* Zoom: Transformation auf der aktuellen Seite, Ursprung oben links.
     Nach dem Zoomen wird die Seite in passender Auflösung neu gerendert. */
  applyZoom(animate) {
    const pg = this.cur();
    if (!pg) return;
    pg.classList.toggle('anim', !!animate);
    const { s, x, y } = this.Z;
    pg.style.transform = s === 1 ? '' : `translate(${x}px, ${y}px) scale(${s})`;
    if (animate) setTimeout(() => pg.classList.remove('anim'), 260);
  },
  clampZoom() {
    const pg = this.cur();
    if (!pg || !pg._geo) return;
    const g = pg._geo, Z = this.Z;
    const w = g.cssW * Z.s, h = g.cssH * Z.s;
    Z.x = w <= R.W ? (R.W - w) / 2 - g.left : clamp(Z.x, R.W - w - g.left, -g.left);
    Z.y = h <= R.H ? (R.H - h) / 2 - g.top : clamp(Z.y, R.H - h - g.top, -g.top);
  },
  zoomTo(s, fx, fy, animate) {
    const pg = this.cur();
    if (!pg || !pg._geo) return;
    const g = pg._geo, Z = this.Z;
    const cx = (fx - g.left - Z.x) / Z.s, cy = (fy - g.top - Z.y) / Z.s;
    Z.s = clamp(s, 1, 5);
    Z.x = fx - g.left - cx * Z.s;
    Z.y = fy - g.top - cy * Z.s;
    if (Z.s < 1.02) { this.resetZoom(animate); return; }
    this.clampZoom();
    this.applyZoom(animate);
    this.sharpen();
  },
  resetZoom(animate, quiet) {
    const pg = this.cur();
    this.Z = { s: 1, x: 0, y: 0 };
    this.slots.forEach((s) => { const g = s.querySelector('.pg'); if (g && g !== pg) g.style.transform = ''; });
    if (!pg) return;
    this.applyZoom(animate);
    // Hochaufgelöstes Canvas wieder verkleinern — spart viel Speicher
    if (!quiet && pg._zoom > 1 && pg._geo) { const g = pg._geo; drawPage(pg, g.p, g.box, g.cssW, g.cssH, 1); }
    else if (quiet && pg._zoom > 1 && pg._geo) { const g = pg._geo; setTimeout(() => drawPage(pg, g.p, g.box, g.cssW, g.cssH, 1), 300); }
  },
  sharpen() {
    clearTimeout(this.sharpT);
    this.sharpT = setTimeout(() => {
      const pg = this.cur();
      if (!pg || !pg._geo || this.Z.s <= 1.05) return;
      if (Math.abs((pg._zoom || 1) - this.Z.s) < 0.25) return;
      const g = pg._geo;
      drawPage(pg, g.p, g.box, g.cssW, g.cssH, this.Z.s);
    }, 220);
  },
  toggleZoom(x, y) {
    if (this.Z.s > 1.05) this.resetZoom(true); else this.zoomTo(2.5, x, y, true);
  },

  wheel(e) {
    e.preventDefault();
    activity();
    const r = $('#rdStage').getBoundingClientRect();
    if (e.ctrlKey) { this.zoomTo(this.Z.s * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top, false); return; }
    if (this.Z.s > 1.05) {
      this.Z.x -= e.deltaX; this.Z.y -= e.deltaY;
      this.clampZoom(); this.applyZoom(false);
      return;
    }
    const now = Date.now();
    if (now - this.wheelT < 350 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
    this.wheelT = now;
    if (e.deltaY > 0 || e.deltaX > 0) this.next(); else this.prev();
  },

  gest() {
    let pinch = null, pan = null;
    return {
      canPan: () => this.Z.s > 1.05,
      tap: (x, y) => readerTap(x, () => {
        // Mitte: kurz warten, ob ein zweites Tippen folgt (Doppeltippen = Zoom)
        const now = performance.now();
        if (this.tapT && now - this.lastTap < 300) {
          clearTimeout(this.tapT); this.tapT = null;
          this.toggleZoom(x, y);
          return;
        }
        this.lastTap = now;
        this.tapT = setTimeout(() => { this.tapT = null; toggleBars(); }, 280);
      }),
      swipeMove: (dx) => {
        if (this.anim) return;
        const edge = (dx > 0 && R.page <= 1) || (dx < 0 && R.page >= R.n);
        this.track.classList.remove('anim');
        this.track.style.transform = `translateX(${edge ? dx / 3 : dx}px)`;
      },
      swipeEnd: (dx, vx, cancel) => {
        if (!cancel && swipeTurns(dx, vx)) this.turn(dx < 0 ? 1 : -1); else this.snap();
      },
      panStart: () => { pan = { x: this.Z.x, y: this.Z.y, over: 0 }; },
      panMove: (dx, dy) => {
        if (!pan) return;
        const want = pan.x + dx;
        this.Z.x = want; this.Z.y = pan.y + dy;
        this.clampZoom();
        pan.over = want - this.Z.x;       // wie weit über den Rand hinaus gezogen
        this.applyZoom(false);
      },
      panEnd: () => {
        // Deutlich über den Rand hinaus gezogen: weiterblättern
        if (pan && Math.abs(pan.over) > R.W * 0.25) this.turn(pan.over < 0 ? 1 : -1);
        pan = null;
      },
      pinchStart: (m) => {
        this.snap();
        pinch = { s0: this.Z.s, x0: this.Z.x, y0: this.Z.y, m };
      },
      pinchMove: (ratio, m) => {
        const pg = this.cur();
        if (!pg || !pg._geo || !pinch) return;
        const g = pg._geo;
        const s = clamp(pinch.s0 * ratio, 1, 5);
        const cx = (pinch.m.x - g.left - pinch.x0) / pinch.s0, cy = (pinch.m.y - g.top - pinch.y0) / pinch.s0;
        this.Z.s = s;
        this.Z.x = m.x - g.left - cx * s;
        this.Z.y = m.y - g.top - cy * s;
        this.clampZoom();
        this.applyZoom(false);
      },
      pinchEnd: () => {
        pinch = null;
        if (this.Z.s < 1.05) this.resetZoom(true); else this.sharpen();
      },
    };
  },
};

/* ── Scrollmodus ────────────────────────────────────────────────
   Alle Seiten untereinander, absolut positioniert. Gerendert wird nur, was
   in der Nähe des Bildschirms liegt; Fernes wird wieder freigegeben. Die
   Höhen kommen aus Seite 1 und werden korrigiert, sobald eine Seite mit
   anderem Format auftaucht. */
const ScrollView = {
  wrap: null, list: null, tops: [], hs: [], w: 0, gap: 8, els: new Map(), queue: new Set(),
  busy: false, raf: 0, pinch: null, tapT: null, lastTap: 0, jumping: false,

  box() { return R.book.crop && R.bookBox ? R.bookBox : FULL; },
  key() { return `${this.w}|${R.book.crop}|${R.bookBox ? 1 : 0}`; },

  init() {
    $('#rdStage').innerHTML = '<div class="sc-wrap"><div class="sc-list"></div></div>';
    this.wrap = $('#rdStage .sc-wrap');
    this.list = $('#rdStage .sc-list');
    this.els = new Map(); this.queue = new Set(); this.busy = false; this.pinch = null;
    this.layout();
    this.jump(R.page, R.frac);
    const w = this.wrap;
    w.addEventListener('scroll', () => this.onScroll(), { passive: true });
    w.addEventListener('click', (e) => this.click(e));
    ['touchstart', 'touchend', 'touchcancel'].forEach((t) => w.addEventListener(t, (e) => this.touch(e), { passive: true }));
    w.addEventListener('touchmove', (e) => this.touch(e), { passive: false });
    w.addEventListener('wheel', (e) => {
      activity();
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = w.getBoundingClientRect();
      this.setZoom(R.book.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    this.update('jump');          // Öffnen ist kein Lesen — markiert nichts als gelesen
  },

  layout() {
    const box = this.box(), bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    this.w = Math.round(R.W * R.book.zoom);
    this.tops = new Array(R.n + 2);
    this.hs = new Array(R.n + 2);
    let y = 0;
    for (let p = 1; p <= R.n; p++) {
      const s = sizeOf(p);
      const h = Math.round((this.w * s.h * bh) / (s.w * bw));
      this.tops[p] = y; this.hs[p] = h;
      y += h + this.gap;
    }
    this.list.style.width = this.w + 'px';
    this.list.style.height = Math.max(0, y - this.gap) + 'px';
    this.els.forEach((el, p) => this.placeEl(el, p));
  },
  placeEl(el, p) {
    Object.assign(el.style, { top: this.tops[p] + 'px', width: this.w + 'px', height: this.hs[p] + 'px' });
  },
  pageAt(y) {
    let lo = 1, hi = R.n;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.tops[mid] <= y) lo = mid; else hi = mid - 1; }
    return lo;
  },
  jump(p, frac) {
    this.jumping = true;
    this.wrap.scrollTop = Math.round(this.tops[p] + frac * this.hs[p]);
    this.jumping = false;
  },

  onScroll() {
    activity();
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.update(); });
  },

  update(via) {
    if (!R.open || R.view !== this) return;
    const st = this.wrap.scrollTop, H = R.H;
    const y = st + 2;
    let p = this.pageAt(y);
    let frac = clamp((y - this.tops[p]) / (this.hs[p] || 1), 0, 0.999);
    // Ganz unten angekommen: die letzte Seite lässt sich nie bis an den oberen
    // Rand scrollen — trotzdem ist sie es, die gerade gelesen wird.
    if (this.atEnd() && R.n > 1) { p = R.n; frac = 0; }
    if (p !== R.page || Math.abs(frac - R.frac) > 0.002) setPos(p, frac, via || 'scroll');
    const a = this.pageAt(Math.max(0, st - H * 0.5)), b = this.pageAt(st + H * 1.6);
    for (let q = a; q <= b; q++) this.want(q);
    // Weit Entferntes wegräumen — jede Seite hält mehrere MB Pixel
    this.els.forEach((el, q) => {
      if (q >= a - 3 && q <= b + 3) return;
      cancelDraw(el); el.remove();
      this.els.delete(q); this.queue.delete(q);
    });
    this.pump();
  },

  want(p) {
    let el = this.els.get(p);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pg';
      el.innerHTML = '<div class="hl-layer"></div>';
      this.placeEl(el, p);
      this.list.appendChild(el);
      this.els.set(p, el);
    }
    if (el._key !== this.key()) this.queue.add(p);
  },

  /** Warteschlange abarbeiten, immer die Seite nahe der Bildschirmmitte zuerst. */
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.size && R.view === this && R.open) {
        const mid = this.pageAt(this.wrap.scrollTop + R.H / 2);
        let best = null;
        this.queue.forEach((q) => { if (best === null || Math.abs(q - mid) < Math.abs(best - mid)) best = q; });
        this.queue.delete(best);
        const el = this.els.get(best);
        if (!el) continue;
        const known = !!R.sizes[best];
        const sz = await pageSize(best);
        if (R.view !== this || !R.open) return;
        if (!known && R.size1 && (Math.abs(sz.w - R.size1.w) > 1 || Math.abs(sz.h - R.size1.h) > 1)) {
          const { page, frac } = R;
          this.layout();
          this.jump(page, frac);
        }
        const box = this.box();
        el._key = this.key();
        el._geo = { p: best, box, sz, fit: this.w / (sz.w * (box.x1 - box.x0)) };
        if (await drawPage(el, best, box, this.w, this.hs[best], 1)) drawHighlights(el);
      }
    } finally { this.busy = false; }
  },

  go(p, via, frac) {
    p = clamp(p, 1, R.n);
    this.jump(p, frac || 0);
    this.update(via);
  },
  next() { this.wrap.scrollBy({ top: R.H * 0.9, behavior: db.read.anim && !reducedMotion() ? 'smooth' : 'auto' }); },
  prev() { this.wrap.scrollBy({ top: -R.H * 0.9, behavior: db.read.anim && !reducedMotion() ? 'smooth' : 'auto' }); },

  relayout() {
    const { page, frac } = R;
    measure();
    this.layout();
    this.jump(page, frac);
    this.update('jump');
  },

  atEnd() { return this.wrap && this.wrap.scrollTop + this.wrap.clientHeight >= this.wrap.scrollHeight - 8; },

  destroy() {
    cancelAnimationFrame(this.raf); this.raf = 0;
    clearTimeout(this.tapT);
    this.els.forEach((el) => cancelDraw(el));
    this.els.clear(); this.queue.clear();
  },

  click(e) {
    const r = this.wrap.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    activity();
    if (R.bars) { showBars(false); return; }
    const now = performance.now();
    if (this.tapT && now - this.lastTap < 300) {
      clearTimeout(this.tapT); this.tapT = null;
      this.setZoom(R.book.zoom > 1.05 ? 1 : 2, x, y);
      return;
    }
    this.lastTap = now;
    this.tapT = setTimeout(() => { this.tapT = null; toggleBars(); }, 280);
  },

  /* Zwei-Finger-Zoom: währenddessen nur per CSS skalieren (flüssig), beim
     Loslassen die Seitenbreite wirklich ändern und neu rendern. */
  touch(e) {
    const t = e.touches;
    const td = () => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;
    if (e.type === 'touchstart' && t.length === 2) {
      const r = this.wrap.getBoundingClientRect();
      const m = { x: (t[0].clientX + t[1].clientX) / 2 - r.left, y: (t[0].clientY + t[1].clientY) / 2 - r.top };
      this.pinch = { d0: td(), z0: R.book.zoom, m, s: 1 };
      this.list.style.transformOrigin = `${this.wrap.scrollLeft + m.x - this.list.offsetLeft}px ${this.wrap.scrollTop + m.y}px`;
    } else if (e.type === 'touchmove' && this.pinch && t.length === 2) {
      if (e.cancelable) e.preventDefault();
      const z = clamp((this.pinch.z0 * td()) / this.pinch.d0, 1, 4);
      this.pinch.s = z / this.pinch.z0;
      this.list.style.transform = `scale(${this.pinch.s})`;
    } else if ((e.type === 'touchend' || e.type === 'touchcancel') && this.pinch && t.length < 2) {
      const p = this.pinch;
      this.pinch = null;
      this.list.style.transform = '';
      if (Math.abs(p.s - 1) > 0.02) this.setZoom(p.z0 * p.s, p.m.x, p.m.y);
    }
  },

  setZoom(z, fx, fy) {
    z = clamp(Math.round(z * 100) / 100, 1, 4);
    const old = R.book.zoom;
    if (Math.abs(z - old) < 0.01) return;
    const ratio = z / old;
    const cx = this.wrap.scrollLeft + fx, cy = this.wrap.scrollTop + fy;
    R.book.zoom = z;
    saveSoon();
    this.layout();
    this.jumping = true;
    this.wrap.scrollLeft = cx * ratio - fx;
    this.wrap.scrollTop = cy * ratio - fy;
    this.jumping = false;
    this.update();
    if (sheetOpen() && $('#lkDim')) refreshLook();
  },
};

/* ── Textmodus ──────────────────────────────────────────────────
   Der aufbereitete Text wird in CSS-Spalten gesetzt, die genau so breit
   sind wie der Bildschirm — eine Spalte ist eine Bildschirmseite, Blättern
   verschiebt nur. Das ganze Buch auf einmal wäre zu viel DOM; deshalb
   Abschnitte von rund 24 000 Zeichen. Unsichtbare Marken (data-p, data-o)
   halten fest, welche Stelle des PDFs wo steht. */
const TX_PT = 28, TX_PB = 12;   // Innenabstand oben/unten, wie --tx-pt/--tx-pb in style.css

const TextView = {
  view: null, flow: null, chunks: [], ci: -1, s: 0, screens: 1, marks: null, wheelT: 0,
  anchor: null,   // die gemerkte Stelle {p, o}: wechselt nur beim Blättern und Springen —
                  // so bleibt sie beim Ändern der Schriftgröße stabil, statt jedes Mal
                  // auf den Bildschirmanfang (oft noch im vorigen Absatz) zu rutschen

  init() {
    $('#rdStage').innerHTML = `<div class="tx-view"><div class="tx-flow${justifyOn() ? ' justify' : ''}" lang="${esc(R.text.lang || 'de')}"></div></div>`;
    this.view = $('#rdStage .tx-view');
    this.flow = $('#rdStage .tx-flow');
    this.chunks = makeChunks();
    this.ci = -1;
    this.anchor = null;
    gestures(this.view, this.gest());
    this.view.addEventListener('wheel', (e) => {
      e.preventDefault();
      activity();
      const now = Date.now();
      if (now - this.wheelT < 350 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
      this.wheelT = now;
      if (e.deltaY > 0 || e.deltaX > 0) this.next(); else this.prev();
    }, { passive: false });
    return this.go(R.page, 'jump', R.frac);
  },

  chunkOf(p) {
    const i = this.chunks.findIndex((c) => p >= c.a && p <= c.b);
    return i < 0 ? 0 : i;
  },

  async load(ci) {
    this.ci = ci;
    const c = this.chunks[ci];
    // Bildseiten brauchen ihr echtes Format, bevor das Layout steht
    for (let p = c.a; p <= c.b; p++) {
      if (R.text.pages[p - 1] && R.text.pages[p - 1].img) await pageSize(p);
      if (R.view !== this) return;
    }
    $$('.pg[data-img]', this.flow).forEach(cancelDraw);
    this.flow.innerHTML = chunkHTML(c.a, c.b, ci === this.chunks.length - 1);
    this.size();
    this.setX(0, false);
    this.measure();
    this.drawImages();
    txHighlight();
  },
  size() {
    const m = MARGINS[db.read.margin];
    this.flow.style.width = R.W + 'px';
    this.flow.style.columnWidth = (R.W - 2 * m) + 'px';
    this.flow.classList.toggle('justify', justifyOn());
  },
  measure() {
    this.screens = Math.max(1, Math.round(this.flow.scrollWidth / R.W));
    this.marks = null;
  },
  setX(x, anim) {
    this.flow.classList.toggle('anim', !!anim && db.read.anim && !reducedMotion());
    this.flow.style.transform = `translateX(${x}px)`;
  },
  show(s, anim) {
    this.s = clamp(s, 0, this.screens - 1);
    this.setX(-this.s * R.W, anim);
  },

  /** Alle Marken mit ihrer Bildschirmseite. Gemessen wird gegen die linke
      Kante des Textflusses — die Verschiebung beim Blättern kürzt sich weg. */
  markList() {
    if (this.marks) return this.marks;
    const base = this.flow.getBoundingClientRect().left;
    this.marks = $$('[data-p]', this.flow).map((el) => {
      const r = el.getClientRects()[0] || el.getBoundingClientRect();
      return { p: +el.dataset.p, o: +el.dataset.o, s: Math.max(0, Math.floor((r.left - base + 2) / R.W)) };
    });
    return this.marks;
  },
  /** Die Stelle oben auf Bildschirmseite s. */
  posAt(s) {
    let before = null;
    for (const m of this.markList()) {
      if (m.s === s) return m;
      if (m.s < s) before = m; else break;
    }
    return before || this.markList()[0] || { p: this.chunks[this.ci].a, o: 0 };
  },
  /** Bildschirmseite, auf der Seite p, Zeichen o steht. */
  screenOf(p, o) {
    let s = 0;
    for (const m of this.markList()) {
      if (m.p < p || (m.p === p && m.o <= o)) s = m.s; else break;
    }
    return s;
  },
  report(via) {
    const m = this.posAt(this.s);
    this.anchor = { p: m.p, o: m.o };
    setPos(m.p, m.o / (R.lens[m.p - 1] || 1), via);
  },

  /** Nach einem Sprung gilt das Sprungziel als Lesestand — nicht der Anfang
      des Bildschirms, der oft noch auf der Vorseite liegt. Sonst rutschte
      jeder Wechsel zwischen Seiten- und Textmodus eine Seite zurück. */
  async goOffset(p, o, via) {
    const ci = this.chunkOf(p);
    if (ci !== this.ci) await this.load(ci);
    if (R.view !== this) return;
    this.show(this.screenOf(p, o), false);
    this.anchor = { p, o };
    setPos(p, o / (R.lens[p - 1] || 1), via);
  },
  go(p, via, frac) {
    p = clamp(p, 1, R.n);
    return this.goOffset(p, Math.round((frac || 0) * (R.lens[p - 1] || 0)), via);
  },

  async next() {
    if (this.s < this.screens - 1) { this.show(this.s + 1, true); this.report('turn'); return; }
    if (this.ci < this.chunks.length - 1) { await this.load(this.ci + 1); this.show(0, false); this.report('turn'); return; }
    this.show(this.s, true);
    toast('Ende des Buchs erreicht');
  },
  async prev() {
    if (this.s > 0) { this.show(this.s - 1, true); this.report('turn'); return; }
    if (this.ci > 0) { await this.load(this.ci - 1); this.show(this.screens - 1, false); this.report('turn'); return; }
    this.show(0, true);
    toast('Anfang des Buchs');
  },

  async relayout() {
    const m = this.anchor || (this.ci >= 0 ? this.posAt(this.s) : { p: R.page, o: 0 });
    measure();
    await this.load(this.ci < 0 ? this.chunkOf(m.p) : this.ci);
    if (R.view !== this) return;
    this.show(this.screenOf(m.p, m.o), false);
    setPos(m.p, m.o / (R.lens[m.p - 1] || 1), 'jump');
  },

  atEnd() { return this.ci === this.chunks.length - 1 && this.s >= this.screens - 1; },

  destroy() {
    if (window.CSS && CSS.highlights) CSS.highlights.delete('search');
    if (this.flow) $$('.pg[data-img]', this.flow).forEach(cancelDraw);
    this.flow = null;
  },

  async drawImages() {
    const flow = this.flow;
    const tok = (flow._tok = (flow._tok || 0) + 1);
    for (const el of $$('.pg[data-img]', flow)) {
      if (flow._tok !== tok || R.view !== this) return;
      await drawPage(el, +el.dataset.img, FULL, parseFloat(el.style.width), parseFloat(el.style.height), 1);
    }
  },

  gest() {
    return {
      tap: (x) => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) { sel.removeAllRanges(); return; }
        readerTap(x);
      },
      swipeMove: (dx) => {
        const edge = (dx > 0 && this.ci === 0 && this.s === 0) || (dx < 0 && this.atEnd());
        this.setX(-this.s * R.W + (edge ? dx / 3 : dx), false);
      },
      swipeEnd: (dx, vx, cancel) => {
        if (!cancel && swipeTurns(dx, vx)) { if (dx < 0) this.next(); else this.prev(); }
        else this.setX(-this.s * R.W, true);
      },
    };
  },
};

/** Trennt der Browser in dieser Sprache wirklich? Ohne Wörterbuch (manche
    Desktop-Browser) reißt Blocksatz große Lücken — dann lieber linksbündig.
    Geprüft wird an einem langen Wort in einer schmalen Box. */
const hyphenCache = {};
function hyphensWork(lang) {
  if (hyphenCache[lang] !== undefined) return hyphenCache[lang];
  const d = document.createElement('div');
  d.lang = lang;
  d.style.cssText = 'position:absolute;visibility:hidden;width:4.5em;font:16px/20px serif;-webkit-hyphens:auto;hyphens:auto;overflow-wrap:normal;word-break:normal';
  d.textContent = lang === 'de' ? 'Donaudampfschifffahrtsgesellschaft' : 'internationalization responsibilities';
  document.body.appendChild(d);
  const ok = d.offsetHeight > 30;
  d.remove();
  return (hyphenCache[lang] = ok);
}
const justifyOn = () => db.read.justify && hyphensWork((R.text && R.text.lang) || 'de');

/** Abschnitte für den Textmodus: feste Grenzen, damit eine Stelle immer im
    selben Abschnitt landet. Bildseiten zählen pauschal wie 1500 Zeichen. */
function makeChunks() {
  const out = [];
  let a = 1, chars = 0;
  for (let p = 1; p <= R.n; p++) {
    const pg = R.text.pages[p - 1];
    chars += pg && pg.img ? 1500 : (R.lens[p - 1] || 0) + 1;
    if (chars >= 24000 || p - a + 1 >= 24 || p === R.n) { out.push({ a, b: p }); a = p + 1; chars = 0; }
  }
  return out;
}

function chunkHTML(a, b, last) {
  let h = '', open = null;        // offenes Element: 'p' | 'f' | 'h3'
  const close = () => { if (open) { h += open === 'h3' ? '</h3>' : '</p>'; open = null; } };
  for (let p = a; p <= b; p++) {
    const pg = R.text.pages[p - 1];
    if (!pg || pg.img) { close(); h += imgBlockHTML(p); continue; }
    if (!pg.b.length) { close(); h += `<div data-p="${p}" data-o="0"></div>`; continue; }
    let off = 0;
    pg.b.forEach((bl, i) => {
      if (i === 0 && bl.c && open === 'p') {
        // Satz geht über den Seitenumbruch weiter: im selben Absatz bleiben
        h += (bl.c === 1 ? ' ' : '') + `<i data-p="${p}" data-o="0"></i>` + segHTML(bl.s, p, 0);
      } else {
        close();
        if (bl.t === 'h') { h += `<h3 data-p="${p}" data-o="${off}">`; open = 'h3'; }
        else if (bl.t === 'f') { h += `<p class="tx-f" data-p="${p}" data-o="${off}">`; open = 'f'; }
        else { h += `<p${i === 0 && bl.c ? ' class="first"' : ''} data-p="${p}" data-o="${off}">`; open = 'p'; }
        h += segHTML(bl.s, p, off);
      }
      off += bl.s.length + 1;
    });
  }
  close();
  if (last) h += '<div class="tx-end">— Ende —</div>';
  return h;
}

/** Text mit einer unsichtbaren Marke alle ~200 Zeichen — so lässt sich auch
    mitten in einem langen Absatz sagen, welche Stelle oben steht. */
function segHTML(s, p, off) {
  if (s.length <= 240) return esc(s);
  let h = '', i = 0;
  while (i < s.length) {
    let j = Math.min(s.length, i + 200);
    if (j < s.length) { const sp = s.indexOf(' ', j); if (sp !== -1 && sp - j < 40) j = sp; }
    h += (i ? `<i data-p="${p}" data-o="${off + i}"></i>` : '') + esc(s.slice(i, j));
    i = j;
  }
  return h;
}

/** Seite ohne Text (Cover, Abbildung): als Bild in die Spalte setzen. */
function imgBlockHTML(p) {
  const m = MARGINS[db.read.margin];
  const colW = R.W - 2 * m, maxH = R.H - TX_PT - TX_PB - 44;
  const s = sizeOf(p);
  const f = Math.min(colW / s.w, maxH / s.h);
  const w = Math.floor(s.w * f), h = Math.floor(s.h * f);
  return `<div class="tx-img" data-p="${p}" data-o="0"><div class="pg" data-img="${p}" style="width:${w}px;height:${h}px"></div>`
    + `<span class="cap">Seite ${esc(pageName(p))}</span></div>`;
}

/* ── Treffer hervorheben ────────────────────────────────────────
   Seiten- und Scrollmodus: Kästchen über das Canvas, berechnet aus den
   Textschnipseln der Seite. Textmodus: CSS Custom Highlight API, ohne das
   DOM anzufassen. */
const tcCache = new Map();    // Seite → getTextContent() — die zuletzt gebrauchten

async function pageTextContent(p) {
  let tc = tcCache.get(p);
  if (!tc) {
    const page = await R.pdf.getPage(p);
    tc = await page.getTextContent();
    tcCache.set(p, tc);
    if (tcCache.size > 24) tcCache.delete(tcCache.keys().next().value);
  }
  return tc;
}

/** Rechtecke (Viewport-Maßstab 1) aller Vorkommen von q auf Seite p.
    Leerraum zählt nicht mit — PDFs zerlegen Wörter beliebig in Schnipsel,
    so findet „Hallo Welt“ auch „HalloWelt“ und umgekehrt. */
async function matchRects(p, q) {
  const fq = Reflow.fold(q).replace(/\s+/g, '');
  if (!fq) return [];
  const tc = await pageTextContent(p);
  const page = await R.pdf.getPage(p);
  const vp = page.getViewport({ scale: 1 });
  let comp = '';
  const map = [];
  tc.items.forEach((it, i) => {
    const f = Reflow.fold(it.str || '');
    for (let j = 0; j < f.length; j++) if (f[j] !== ' ') { comp += f[j]; map.push(i, j); }
  });
  const rects = [];
  const rect = (i, a, b) => {
    const it = tc.items[i];
    const t = R.lib.Util.transform(vp.transform, it.transform);
    const fs = Math.hypot(t[2], t[3]);
    const len = it.str.length || 1;
    const w = it.width;
    rects.push({ x: t[4] + (w * a) / len, y: t[5] - fs * 0.88, w: Math.max(2, (w * (b - a)) / len), h: fs * 1.12 });
  };
  let k = comp.indexOf(fq);
  while (k !== -1 && rects.length < 200) {
    let item = map[2 * k], start = map[2 * k + 1], last = start;
    for (let m = k + 1; m < k + fq.length; m++) {
      const it = map[2 * m], ch = map[2 * m + 1];
      if (it !== item) { rect(item, start, last + 1); item = it; start = ch; }
      last = ch;
    }
    rect(item, start, last + 1);
    k = comp.indexOf(fq, k + fq.length);
  }
  return rects;
}

async function drawHighlights(pg) {
  const layer = pg.querySelector('.hl-layer');
  if (!layer) return;
  const q = R.search, g = pg._geo;
  if (!q || !g) { layer.innerHTML = ''; return; }
  let rects;
  try { rects = await matchRects(g.p, q); } catch (e) { return; }
  if (pg._geo !== g || R.search !== q) return;
  const ox = g.box.x0 * g.sz.w, oy = g.box.y0 * g.sz.h;
  layer.innerHTML = rects.map((r) => `<div class="hl" style="left:${((r.x - ox) * g.fit).toFixed(1)}px;top:${((r.y - oy) * g.fit).toFixed(1)}px;`
    + `width:${(r.w * g.fit).toFixed(1)}px;height:${(r.h * g.fit).toFixed(1)}px"></div>`).join('');
}

function txHighlight() {
  if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
  CSS.highlights.delete('search');
  const flow = TextView.flow;
  const fq = Reflow.fold(R.search || '').replace(/\s+/g, ' ').trim();
  if (!fq || !flow || R.view !== TextView) return;
  const ranges = [];
  const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode()) && ranges.length < 500) {
    const f = Reflow.fold(n.data);
    let i = f.indexOf(fq);
    while (i !== -1) {
      const r = new Range();
      r.setStart(n, i); r.setEnd(n, i + fq.length);
      ranges.push(r);
      i = f.indexOf(fq, i + fq.length);
    }
  }
  if (ranges.length) CSS.highlights.set('search', new Highlight(...ranges));
}

function refreshHighlights() {
  if (R.mode === 'text') { txHighlight(); return; }
  $$('#rdStage .pg').forEach((pg) => { if (pg._geo) drawHighlights(pg); });
}

/* ── Inhalt · Lesezeichen · Suche ───────────────────────────── */
let tocTab = 'toc';

function openToc(tab) {
  if (tab) tocTab = tab;
  showBars(false);
  openSheet(R.book.title, `<div class="seg" style="margin-bottom:14px">${[['toc', 'Inhalt'], ['marks', 'Lesezeichen'], ['search', 'Suche']]
    .map(([k, l]) => `<button data-act="tocTab" data-v="${k}" class="${tocTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="tocBody"></div>`, null, null, 'Schließen');
  fillToc();
}

function fillToc() {
  const el = $('#tocBody');
  if (!el) return;
  if (tocTab === 'toc') {
    el.innerHTML = tocHTML();
    const cur = $('.row.cur', el);
    if (cur) cur.scrollIntoView({ block: 'center' });
  } else if (tocTab === 'marks') {
    el.innerHTML = marksHTML();
  } else {
    el.innerHTML = `<form class="search-box" id="srchForm"><input type="search" id="srchQ" placeholder="Im Buch suchen"
      value="${esc(R.search)}" autocomplete="off" enterkeyhint="search" aria-label="Suchbegriff">
      <button class="btn btn-primary" type="submit">Suchen</button></form><div id="srchRes">${R.searchRes ? resultsHTML() : ''}</div>`;
    $('#srchForm').onsubmit = (e) => { e.preventDefault(); runSearch($('#srchQ').value); };
    if (!R.searchRes) $('#srchQ').focus();
  }
}

function headingsFromText() {
  const out = [];
  R.text.pages.forEach((pg, i) => (pg.b || []).forEach((b) => {
    if (b.t === 'h' && b.s.length > 1 && out.length < 300) out.push({ title: b.s.slice(0, 120), page: i + 1, d: 0 });
  }));
  return out;
}

function tocHTML() {
  let items = R.toc, note = '';
  if (!items.length && R.text) {
    items = headingsFromText();
    if (items.length) note = '<p class="note" style="margin:0 0 10px">Das PDF hat kein Inhaltsverzeichnis. Das hier sind die Überschriften, die im Text erkannt wurden.</p>';
  }
  if (!items.length) {
    return `<p class="dlg-t">Dieses PDF hat kein Inhaltsverzeichnis.${R.text ? ''
      : ' Nach einer Suche oder im Textmodus erkennt die App Überschriften selbst und zeigt sie hier.'}</p>`;
  }
  let cur = null;
  items.forEach((t) => { if (t.page && t.page <= R.page && (!cur || t.page >= cur.page)) cur = t; });
  return note + `<div class="rows toc">${items.map((t) => `<button class="row d${Math.min(t.d, 3)}${t === cur ? ' cur' : ''}"
    data-act="tocGo" data-p="${t.page || ''}"${t.page ? '' : ' disabled'}><span class="grow">${esc(t.title)}</span>
    <span class="p num">${t.page ? esc(R.labels ? R.labels[t.page - 1] : t.page) : ''}</span></button>`).join('')}</div>`;
}

function marksHTML() {
  const ms = R.book.marks.slice().sort((a, b) => a.page - b.page || a.frac - b.frac);
  const has = ms.some((m) => m.page === R.page);
  const h = `<button class="btn btn-block" data-act="rdMark" style="margin-bottom:12px">${ic(has ? 'markOn' : 'markOff')}
    ${has ? 'Lesezeichen dieser Seite entfernen' : `Lesezeichen auf Seite ${esc(pageName(R.page))} setzen`}</button>`;
  if (!ms.length) return h + '<p class="dlg-t">Noch keine Lesezeichen. Das Symbol oben im Leser merkt sich die aktuelle Seite.</p>';
  return h + `<div class="rows">${ms.map((m) => {
    const sub = [m.label || (chapterAt(m.page) || {}).title || '', m.at ? dfShort.format(new Date(m.at)) : ''].filter(Boolean).join(' · ');
    return `<div class="row" style="padding-right:4px"><button class="grow" style="text-align:left;min-height:44px" data-act="markGo" data-id="${esc(m.id)}">
      <span>Seite ${esc(pageName(m.page))}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</button>
      <button class="icon-btn" data-act="markEdit" data-id="${esc(m.id)}" aria-label="Lesezeichen benennen">${ic('edit')}</button>
      <button class="icon-btn" data-act="markDel" data-id="${esc(m.id)}" aria-label="Lesezeichen löschen">${ic('del')}</button></div>`;
  }).join('')}</div>`;
}

function snippetAt(p, frac) {
  if (!R.text || !R.text.pages[p - 1]) return '';
  const s = Reflow.pageString(R.text.pages[p - 1]).replace(/\s+/g, ' ');
  const o = Math.round(frac * s.length);
  const a = s.lastIndexOf(' ', o) + 1;
  const t = s.slice(a, a + 70);
  return t.length < 70 ? t : t.slice(0, t.lastIndexOf(' ')) + ' …';
}

function toggleMark() {
  const b = R.book;
  const ex = b.marks.find((m) => m.page === R.page);
  if (ex) {
    b.marks = b.marks.filter((m) => m !== ex);
    toast('Lesezeichen entfernt');
  } else {
    b.marks.push({ id: uid(), page: R.page, frac: R.frac, label: snippetAt(R.page, R.frac), at: new Date().toISOString() });
    toast(`Lesezeichen auf Seite ${pageName(R.page)}`);
  }
  save();
  updateUI();
  if (sheetOpen() && $('#tocBody')) fillToc();
}

function goTo(p, frac) {
  if (!R.view) return;
  if (R.mode === 'page') R.view.go(p, 'jump');
  else R.view.go(p, 'jump', frac || 0);
}

async function runSearch(q) {
  q = String(q || '').trim();
  if (q.length < 2) { toast('Bitte mindestens zwei Zeichen'); return; }
  $('#srchQ').blur();
  const out = (html) => { const r = $('#srchRes'); if (r) r.innerHTML = html; };
  out('<p class="dlg-t">Suche …</p>');
  try {
    await ensureText((msg) => out(`<p class="dlg-t">${esc(msg)}</p>`));
  } catch (e) {
    if (R.open) out(`<p class="dlg-t">${esc(errText(e))}</p>`);
    return;
  } finally { R.textProg = null; }
  if (!R.folded) R.folded = R.text.pages.map((pg) => Reflow.fold(Reflow.pageString(pg)));
  const fq = Reflow.fold(q).replace(/\s+/g, ' ');
  const hits = [];
  let total = 0;
  R.folded.forEach((f, i) => {
    let k = f.indexOf(fq);
    while (k !== -1) { total++; if (hits.length < 300) hits.push({ p: i + 1, o: k }); k = f.indexOf(fq, k + fq.length); }
  });
  R.search = q;
  R.searchRes = { q, hits, total, len: fq.length };
  out(resultsHTML());
  refreshHighlights();
}

function resultsHTML() {
  const { q, hits, total, len } = R.searchRes;
  if (!total) {
    const scan = R.lens.reduce((n, l) => n + l, 0) < 40 * Math.min(R.n, 20);
    return `<p class="dlg-t">${scan ? 'Dieses PDF enthält keinen durchsuchbaren Text – es besteht aus Bildern (z. B. ein Scan).'
      : `„${esc(q)}“ kommt im Buch nicht vor.`}</p>`;
  }
  const head = `<div class="set-inline"><span class="small muted">${total === 1 ? '1 Treffer' : `${nf0.format(total)} Treffer`}`
    + `${total > hits.length ? ` – die ersten ${hits.length}` : ''}</span>`
    + '<button class="link" data-act="searchClear">Markierung aufheben</button></div>';
  return head + `<div class="rows">${hits.map((h, i) => {
    const s = Reflow.pageString(R.text.pages[h.p - 1]);
    const a = Math.max(0, h.o - 50), e = Math.min(s.length, h.o + len + 70);
    return `<button class="row hit" data-act="hit" data-i="${i}"><span class="grow"><span class="small muted">Seite ${esc(pageName(h.p))}</span>
      <span>${a > 0 ? '…' : ''}${esc(s.slice(a, h.o))}<mark>${esc(s.slice(h.o, h.o + len))}</mark>${esc(s.slice(h.o + len, e))}${e < s.length ? '…' : ''}</span></span></button>`;
  }).join('')}</div>`;
}

function goHit(i) {
  const h = R.searchRes && R.searchRes.hits[i];
  if (!h) return;
  closeSheet();
  if (R.mode === 'text') TextView.goOffset(h.p, h.o, 'jump');
  else goTo(h.p, clamp(h.o / (R.lens[h.p - 1] || 1) - 0.15, 0, 0.9));
}

/* ── Darstellung ────────────────────────────────────────────── */
function lookHTML() {
  const r = db.read, b = R.book;
  const seg = (act, items, cur) => `<div class="seg">${items.map(([v, l]) =>
    `<button data-act="${act}" data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  let h = `<div class="look-sec"><div class="lbl">Ansicht</div>${seg('lkMode', Object.entries(MODES), R.mode)}</div>
    <div class="look-sec"><div class="lbl">Papier</div><div class="papers">${Object.entries(PAPERS).map(([k, p]) =>
      `<button data-act="lkPaper" data-v="${k}" data-paper="${k}" class="${r.paper === k ? 'on' : ''}">${p.label}</button>`).join('')}</div></div>`;
  if (R.mode === 'text') {
    h += `<div class="look-sec"><div class="lbl">Schriftgröße</div><div class="stepper">
        <button class="btn" data-act="lkSize" data-v="-1" aria-label="Schrift kleiner">A−</button>
        <span class="v num" id="lkSizeV">${r.size} px</span>
        <button class="btn" data-act="lkSize" data-v="1" aria-label="Schrift größer">A+</button></div></div>
      <div class="look-sec"><div class="lbl">Schrift</div>${seg('lkFont', [['serif', 'Serif'], ['sans', 'Sans']], r.font)}</div>
      <div class="look-sec"><div class="lbl">Zeilenabstand</div>${seg('lkLh', Object.entries(LINE_HEIGHTS), r.lh)}</div>
      <div class="look-sec"><div class="lbl">Rand</div>${seg('lkMargin', [[0, 'Schmal'], [1, 'Mittel'], [2, 'Breit']], r.margin)}</div>
      <div class="look-sec"><div class="set-inline"><span>Blocksatz mit Silbentrennung${hyphensWork(R.text.lang || 'de') ? ''
        : '<span class="sub muted small" style="display:block">Dieser Browser kann hier nicht trennen – der Text bleibt linksbündig</span>'}</span>
        <button class="switch" role="switch" data-act="lkJustify" aria-checked="${r.justify}" aria-label="Blocksatz"></button></div></div>`;
  } else {
    h += `<div class="look-sec"><div class="set-inline"><span>Weiße Ränder abschneiden</span>
        <button class="switch" role="switch" data-act="lkCrop" aria-checked="${b.crop}" aria-label="Ränder abschneiden"></button></div>
      ${R.mode === 'scroll' ? `<div class="set-inline"><span>Zoom ${nf0.format(b.zoom * 100)} %</span>
        <button class="btn btn-sm" data-act="lkZoom"${b.zoom === 1 ? ' disabled' : ''}>Seitenbreite</button></div>` : ''}</div>`;
  }
  h += `<div class="look-sec"><div class="lbl">Abdunkeln</div><input type="range" id="lkDim" min="0" max="70" step="5"
    value="${Math.round(r.dim * 100)}" aria-label="Abdunkeln"></div>`;
  return h;
}
function openLook() {
  showBars(false);
  openSheet('Darstellung', lookHTML(), null, null, 'Fertig');
  wireLook();
}
function refreshLook() { $('#sheetBody').innerHTML = lookHTML(); wireLook(); }
function wireLook() {
  const d = $('#lkDim');
  if (d) d.oninput = () => { db.read.dim = d.value / 100; applyPaper(); saveSoon(); };
}
function segOn(btn) { $$('button', btn.parentElement).forEach((b) => b.classList.toggle('on', b === btn)); }

/* Textmodus nach Änderungen an Schrift oder Rand neu setzen — kurz
   gebündelt, damit fünfmal „A+“ nicht fünfmal das Layout baut. */
let txRelayoutT = null;
function textRelayoutSoon() {
  applyTextStyle();
  clearTimeout(txRelayoutT);
  txRelayoutT = setTimeout(() => { if (R.view === TextView) TextView.relayout(); }, 150);
}

function openJump() {
  const n = R.n;
  askText('Gehe zu Seite', R.labels ? `Seite 1–${n} oder eine Bezeichnung wie „xii“` : `Seite 1–${n}`,
    { numeric: !R.labels, okLabel: 'Springen', placeholder: String(R.page) }, (v) => {
      v = String(v).trim();
      let p = null;
      if (R.labels) { const i = R.labels.indexOf(v); if (i >= 0) p = i + 1; }
      if (p == null && /^\d+$/.test(v)) p = parseInt(v, 10);
      if (p == null || p < 1 || p > n) { toast(`Bitte eine Seite von 1 bis ${n}`); return; }
      closeSheet();
      goTo(p, 0);
    });
}

/* ── Aktionen ───────────────────────────────────────────────────
   Jedes Element mit data-act="name" ruft ACT.name(element) auf. Ein
   einziger Klick-Handler am body statt einzelner Handler pro Zeile — die
   Listen werden ständig neu gerendert. */
const ACT = {
  /* Bibliothek */
  import: () => pickPdf(),
  open: (el) => openBook(el.dataset.id),
  book: (el) => openBookSheet(el.dataset.id),
  relink: (el) => { const b = book(el.dataset.id); closeSheet(); if (b) pickPdf(b); },
  libSearch: () => {
    libSearchOpen = !libSearchOpen;
    if (!libSearchOpen) libQuery = '';
    render();
    const q = $('#libQ');
    if (q) q.focus();
  },
  libSort: openSortSheet,
  libSortSet: (el) => { db.lib.sort = el.dataset.v; save(); closeSheet(); render(); },
  libLayout: () => { db.lib.layout = db.lib.layout === 'grid' ? 'list' : 'grid'; save(); render(); },
  libFilter: (el) => { db.lib.filter = el.dataset.f; save(); renderLibList(); },
  hintLater: () => { db.tips.backupSnooze = new Date().toISOString(); save(); render(); },

  /* Buch-Details */
  bookEdit: (el) => editBook(el.dataset.id),
  bookDone: (el) => toggleDone(el.dataset.id),
  bookReset: (el) => resetBook(el.dataset.id),
  bookDel: (el) => deleteBook(el.dataset.id),
  bookShelf: (el) => {
    const b = book(el.dataset.id), s = el.dataset.shelf;
    b.shelves = b.shelves.includes(s) ? b.shelves.filter((x) => x !== s) : b.shelves.concat(s);
    el.classList.toggle('on', b.shelves.includes(s));
    save(); render();
  },
  shelfNewFor: (el) => {
    const id = el.dataset.id;
    askText('Neues Regal', 'Name', { placeholder: 'z. B. Fachbücher', okLabel: 'Anlegen' }, (v) => {
      const s = createShelf(v);
      if (!s) return;
      const b = book(id);
      if (!b.shelves.includes(s.id)) b.shelves.push(s.id);
      save(); render(); openBookSheet(id);
    }, () => openBookSheet(id));
  },

  /* Regale */
  shelfNew: newShelf,
  shelfOpen: (el) => { db.lib.filter = 'shelf:' + el.dataset.id; save(); nav('library'); },
  shelfMenu: (el) => shelfMenu(el.dataset.id),
  shelfAssign: (el) => shelfAssign(el.dataset.id),
  shelfRename: (el) => shelfRename(el.dataset.id),
  shelfDel: (el) => shelfDelete(el.dataset.id),
  chk: (el) => el.classList.toggle('on'),

  /* Statistik */
  statRange: (el) => { statRange = el.dataset.v; renderStats(); },
  chartTip: (el) => showChartTip(+el.dataset.i),

  /* Einstellungen */
  setTheme: (el) => { applyTheme(el.dataset.v); save(); render(); },
  setMode: (el) => { db.read.mode = el.dataset.v; save(); segOn(el); },
  toggle: (el) => {
    const k = el.dataset.k;
    db.read[k] = !db.read[k];
    save();
    const sw = $('.switch', el);
    if (sw) sw.setAttribute('aria-checked', String(db.read[k]));
  },
  backupSave: exportBackup,
  backupLoad: pickBackup,
  clearText: () => askSheet('Text-Zwischenspeicher leeren?',
    'Der aufbereitete Text aller Bücher wird verworfen und beim nächsten Textmodus oder der nächsten Suche neu erzeugt. '
    + 'Lesestand und Lesezeichen bleiben.', 'Leeren', async () => {
      closeSheet();
      try { await idbClear('text'); toast('Geleert'); } catch (e) { toast('Das hat nicht geklappt'); }
      fillStorageInfo();
    }),
  checkUpdate: checkUpdate,
  about: () => infoSheet('Über Reader', `Version ${APP_VERSION}\n\n`
    + 'Reader zeigt PDF-Bücher offline an und merkt sich, wo Du warst. Alle Daten bleiben auf diesem Gerät – '
    + 'es gibt keinen Server und kein Konto.\n\n'
    + 'Die PDF-Darstellung übernimmt PDF.js von Mozilla (Apache-Lizenz 2.0), lokal mitgeliefert im Ordner vendor/pdfjs.'),
  wipe: wipeAll,

  /* Leser */
  rdClose: () => closeReader(),
  rdMark: toggleMark,
  rdToc: () => openToc(),
  rdLook: openLook,
  rdJump: openJump,
  tocTab: (el) => { tocTab = el.dataset.v; segOn(el); fillToc(); },
  tocGo: (el) => { const p = +el.dataset.p; if (!p) return; closeSheet(); goTo(p, 0); },
  markGo: (el) => {
    const m = R.book.marks.find((x) => x.id === el.dataset.id);
    if (!m) return;
    closeSheet();
    goTo(m.page, m.frac);
  },
  markEdit: (el) => {
    const m = R.book.marks.find((x) => x.id === el.dataset.id);
    if (!m) return;
    askText('Lesezeichen benennen', 'Name', { value: m.label, okLabel: 'Sichern' }, (v) => {
      m.label = String(v).trim().slice(0, 200);
      save(); openToc('marks');
    }, () => openToc('marks'));
  },
  markDel: (el) => {
    R.book.marks = R.book.marks.filter((x) => x.id !== el.dataset.id);
    save(); updateUI(); fillToc(); toast('Lesezeichen gelöscht');
  },
  hit: (el) => goHit(+el.dataset.i),
  searchClear: () => { R.search = ''; R.searchRes = null; refreshHighlights(); fillToc(); },

  /* Darstellung im Leser — wirkt sofort, das Sheet bleibt offen */
  lkMode: async (el) => {
    const v = el.dataset.v;
    if (v === R.mode) return;
    segOn(el);
    await setMode(v);
    if (sheetOpen() && $('#lkDim')) refreshLook();
  },
  lkPaper: (el) => { db.read.paper = el.dataset.v; applyPaper(); save(); segOn(el); },
  lkCrop: (el) => {
    R.book.crop = !R.book.crop;
    el.setAttribute('aria-checked', String(R.book.crop));
    save();
    if (R.book.crop && !R.bookBox) ensureBookBox(R.token);
    R.view.relayout();
  },
  lkZoom: () => { if (R.view === ScrollView) ScrollView.setZoom(1, 0, 0); refreshLook(); },
  lkSize: (el) => {
    db.read.size = clamp(db.read.size + +el.dataset.v, 12, 34);
    save();
    $('#lkSizeV').textContent = db.read.size + ' px';
    textRelayoutSoon();
  },
  lkFont: (el) => { db.read.font = el.dataset.v; save(); segOn(el); textRelayoutSoon(); },
  lkLh: (el) => { db.read.lh = num(el.dataset.v); save(); segOn(el); textRelayoutSoon(); },
  lkMargin: (el) => { db.read.margin = +el.dataset.v; save(); segOn(el); textRelayoutSoon(); },
  lkJustify: (el) => {
    db.read.justify = !db.read.justify;
    el.setAttribute('aria-checked', String(db.read.justify));
    save(); textRelayoutSoon();
  },
};

/** Vorschau am Seitenregler: welche Seite, welches Kapitel. */
function rangePreview(v) {
  rangeDrag = true;
  const out = $('#rdRangeOut');
  const ch = chapterAt(v);
  out.textContent = `Seite ${pageName(v)}${ch ? ' · ' + ch.title : ''}`;
  out.classList.remove('hidden');
  const f = (v - 1) / Math.max(1, R.n - 1);
  const w = $('#rdRange').clientWidth;
  out.style.left = clamp(f * (w - 24) + 12, out.offsetWidth / 2, w - out.offsetWidth / 2) + 'px';
}

/* ── Verdrahtung ────────────────────────────────────────────── */
function wire() {
  const body = document.body;
  body.addEventListener('click', (e) => {
    const n = e.target.closest('[data-nav]');
    if (n) { nav(n.dataset.nav); return; }
    const a = e.target.closest('[data-act]');
    if (!a || a.disabled) return;
    const fn = ACT[a.dataset.act];
    if (fn) fn(a, e);
  });
  // Langes Drücken auf ein Buch öffnet die Details. Im Leser kein Kontextmenü
  // über den Seiten — nur im Textmodus, dort darf man Text markieren.
  body.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.bk');
    if (b) { e.preventDefault(); openBookSheet(b.dataset.id); return; }
    if (R.open && !e.target.closest('.tx-flow') && !e.target.closest('.sheet')) e.preventDefault();
  });
  body.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"]')) { e.preventDefault(); e.target.click(); }
  });
  body.addEventListener('input', (e) => {
    if (e.target.id === 'libQ') { libQuery = e.target.value; renderLibList(); }
    else if (e.target.id === 'rdRange') rangePreview(+e.target.value);
  });
  $('#rdRange').addEventListener('change', (e) => {
    rangeDrag = false;
    $('#rdRangeOut').classList.add('hidden');
    goTo(+e.target.value, 0);
  });

  $('#btnImport').onclick = () => pickPdf();
  $('#pdfInput').onchange = (e) => importFiles(e.target.files);
  $('#backupInput').onchange = (e) => importBackup(e.target.files[0]);
  $('#sheetCancel').onclick = closeSheet;
  // Wie Abbrechen, nicht wie closeSheet: verschachtelte Sheets und die
  // Passwortabfrage haben dort ihren Rückweg hinterlegt.
  $('#scrim').onclick = () => $('#sheetCancel').click();
  $('#sheetSave').onclick = () => sheetSaveFn && sheetSaveFn();

  // Tastatur im Leser (Desktop, Tablets mit Tastatur, Fernbedienungen)
  document.addEventListener('keydown', (e) => {
    if (!R.open || !R.view || sheetOpen() || e.target.matches('input, textarea, select')) return;
    const k = e.key;
    if (['ArrowRight', 'PageDown', ' ', 'ArrowDown'].includes(k)) { e.preventDefault(); activity(); R.view.next(); }
    else if (['ArrowLeft', 'PageUp', 'ArrowUp'].includes(k)) { e.preventDefault(); activity(); R.view.prev(); }
    else if (k === 'Escape') closeReader();
  });

  // PDFs per Drag-and-Drop (am Rechner)
  document.addEventListener('dragover', (e) => { if (!R.open) e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (R.open) return;
    e.preventDefault();
    const f = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
    if (f.length) importFiles(f);
  });

  // App in den Hintergrund: Lesezeit und Lesestand sofort sichern — danach
  // kann das System sie jederzeit beenden.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (R.open) { statsTick(); saveReaderPos(); }
      saveNow();
    } else if (R.open) {
      ST.last = ST.act = Date.now();
      wakeOn();
    }
  });
  window.addEventListener('pagehide', () => { if (R.open) { statsTick(); saveReaderPos(); } saveNow(); });

  let rsT = null;
  window.addEventListener('resize', () => { clearTimeout(rsT); rsT = setTimeout(checkReaderSize, 200); });
  document.addEventListener('fullscreenchange', () => setTimeout(checkReaderSize, 250));
}

/** Dateien und Cover aus IndexedDB nachziehen — die Bibliothek steht da
    schon aus localStorage. */
async function boot() {
  try {
    files = new Set(await idbKeys('pdf'));
    await loadCovers();
  } catch (e) {
    console.warn('IndexedDB nicht verfügbar', e);
    infoSheet('Kein Dateispeicher', 'Der Browser erlaubt dieser App keinen Speicher für Dateien, etwa im privaten Modus. '
      + 'PDFs lassen sich so nicht dauerhaft ablegen.');
  }
  filesReady = true;
  render();
  recoverOrphans();
}

/* ── Start ──────────────────────────────────────────────────── */
load();
applyTheme(db.theme);
wire();
wireBack();
nav('library');
boot();

/* Bittet den Browser, den Speicher nicht bei Platzmangel wegzuräumen. */
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

wireUpdates();
