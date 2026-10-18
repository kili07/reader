/* Service Worker — App offline verfügbar halten.

   Zwei Caches:
   - CACHE   die App selbst. Bei JEDER Änderung an den Dateien hochzählen,
             sonst liefert der Worker die alte Fassung weiter.
   - VENDOR  PDF.js (~6 MB). Ändert sich nur mit einer neuen PDF.js-Version
             und heißt deshalb nach ihr — so lädt nicht jedes App-Update die
             6 MB noch einmal herunter. */
const CACHE = 'reader-v2';
const VENDOR = 'reader-pdfjs-6.4.299';

const ASSETS = [
  './', './index.html', './style.css', './reflow.js', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

/* Alles, was PDF.js zur Laufzeit nachlädt: Schriften für PDFs ohne
   eingebettete Schrift, Zeichentabellen für asiatische Schriften (gebündelt
   in cmaps.bin, siehe unten), Decoder für JPEG 2000 / JBIG2 (häufig in
   Scans) und ein Farbprofil für CMYK. */
const FONTS = [
  'FoxitDingbats.pfb', 'FoxitFixed.pfb', 'FoxitFixedBold.pfb', 'FoxitFixedBoldItalic.pfb', 'FoxitFixedItalic.pfb',
  'FoxitSerif.pfb', 'FoxitSerifBold.pfb', 'FoxitSerifBoldItalic.pfb', 'FoxitSerifItalic.pfb', 'FoxitSymbol.pfb',
  'LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf',
];
const VENDOR_ASSETS = [
  './vendor/pdfjs/pdf.mjs', './vendor/pdfjs/pdf.worker.mjs',
  './vendor/pdfjs/wasm/openjpeg.wasm', './vendor/pdfjs/wasm/jbig2.wasm', './vendor/pdfjs/wasm/qcms_bg.wasm',
  './vendor/pdfjs/iccs/CGATS001Compat-v2-micro.icc',
  './vendor/pdfjs/cmaps.bin',
  ...FONTS.map((f) => './vendor/pdfjs/standard_fonts/' + f),
];

/* Zeichentabellen: PDF.js fragt einzelne Dateien an (cmaps/Name.bcmap), sie
   liegen aber gebündelt in cmaps.bin — der Upload über die GitHub-Weboberfläche
   nimmt nur 100 Dateien auf einmal, PDF.js bringt allein 168 Tabellen mit.
   Format und Erzeugung: vendor/pack-cmaps.py. */
let cmapPack = null;
function loadCmapPack() {
  if (!cmapPack) {
    cmapPack = caches.open(VENDOR).then(async (c) => {
      const url = './vendor/pdfjs/cmaps.bin';
      let res = await c.match(url);
      if (!res) {
        res = await fetch(url);
        if (!res.ok) throw new Error('cmaps.bin fehlt');
        await c.put(url, res.clone());
      }
      const buf = await res.arrayBuffer();
      const n = new DataView(buf).getUint32(0, true);
      const index = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
      return { buf, base: 4 + n, index };
    }).catch((e) => { cmapPack = null; throw e; });
  }
  return cmapPack;
}
async function cmapResponse(name) {
  const p = await loadCmapPack();
  const e = p.index[name];
  if (!e) return new Response('', { status: 404 });
  return new Response(p.buf.slice(p.base + e[0], p.base + e[0] + e[1]),
    { headers: { 'Content-Type': 'application/octet-stream' } });
}

self.addEventListener('install', (e) => {
  // cache:'reload' erzwingt frische Dateien vom Server. Ohne das würden sie aus
  // dem HTTP-Cache des Browsers geholt (GitHub Pages sendet max-age=600) — der
  // neue Cache enthielte dann die alte Version.
  const fill = (name, list) => caches.open(name)
    .then((c) => c.addAll(list.map((u) => new Request(u, { cache: 'reload' }))));
  e.waitUntil(
    Promise.all([
      fill(CACHE, ASSETS),
      // PDF.js nur laden, wenn diese Version noch nicht im Cache liegt
      caches.has(VENDOR).then((has) => (has ? null : fill(VENDOR, VENDOR_ASSETS))),
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== VENDOR).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  const cm = url.pathname.match(/\/vendor\/pdfjs\/cmaps\/([^/]+)\.bcmap$/);
  if (cm) {
    e.respondWith(cmapResponse(decodeURIComponent(cm[1])).catch(() => new Response('', { status: 404 })));
    return;
  }

  /* PDF.js ändert sich innerhalb einer Version nie: Cache zuerst, kein
     Nachladen im Hintergrund. */
  if (url.pathname.includes('/vendor/pdfjs/')) {
    e.respondWith(
      caches.open(VENDOR).then((c) => c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res && res.ok) c.put(e.request, res.clone());
        return res;
      })))
    );
    return;
  }

  /* App-Dateien: Stale-while-revalidate — sofort aus dem Cache liefern, im
     Hintergrund aktualisieren. */
  e.respondWith(
    caches.open(CACHE).then((c) => c.match(e.request).then((hit) => {
      const net = fetch(e.request).then((res) => {
        if (res && res.ok) c.put(e.request, res.clone());
        return res;
      }).catch(() => hit);
      return hit || net;
    }))
  );
});
