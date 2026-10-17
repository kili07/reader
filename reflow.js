'use strict';
/* ═══════════════════════════════════════════════════════════════
   reflow.js — Text aus PDF-Seiten ziehen und zu Absätzen fügen

   Grundlage für den Textmodus und die Volltextsuche. Läuft einmal pro Buch,
   das Ergebnis landet in IndexedDB (Speicher 'text').

   PDFs kennen keine Absätze, nur positionierte Textschnipsel. Alles hier
   ist deshalb Heuristik:
   - Zeilen über die gemeinsame Grundlinie,
   - Kopf- und Fußzeilen über ihre Wiederholung am Seitenrand,
   - Absätze über Zeilenabstand, Einzug und kurze Zeilen mit Satzende,
   - Überschriften und Fußnoten über die Schriftgröße,
   - Silbentrennung am Zeilenende wird wieder zusammengefügt.

   Ändert sich der Algorithmus, REFLOW_V hochzählen: dann wird der Cache
   jedes Buchs beim nächsten Öffnen neu aufgebaut.

   Ergebnis:
     { v, lang, pages: [ { b: [ {t, s, c?} ], img? } ] }
     t   'p' Absatz · 'h' Überschrift · 'f' kleiner Text (Fußnote)
     s   Text
     c   1 = setzt den letzten Absatz der Vorseite fort, 2 = ebenso, ohne Leerzeichen
     img 1 = Seite ohne nennenswerten Text (Bild, Cover) — im Textmodus als Bild zeigen
   ═══════════════════════════════════════════════════════════════ */

const REFLOW_V = 1;

const Reflow = (() => {
  /* Satzende am Zeilenende — dahinter darf ein neuer Absatz beginnen.
     Deutsche Anführungszeichen „…“ und »…« eingeschlossen. */
  const END = /[.!?:…"“”»«)\]]$/;
  const BULLET = /^([•·▪◦‣■□–—-]|\d{1,3}[.)]|[a-z][.)])\s/;
  /* „Ein- und Ausgang“: hier bleibt der Bindestrich, auch am Zeilenende */
  const KEEP_HYPHEN = /^(und|oder|bzw|bis|sowie|als|and|or|to|nor)\b/i;

  /** Alle Seiten auslesen. `onProgress(i, n)` meldet den Fortschritt,
      `cancelled()` darf jederzeit abbrechen (Leser geschlossen). */
  async function extract(pdf, Util, onProgress, cancelled) {
    const n = pdf.numPages;
    const raw = [];
    for (let i = 1; i <= n; i++) {
      if (cancelled && cancelled()) throw new Error('abgebrochen');
      let lines = [], w = 1, h = 1;
      try {
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        w = vp.width; h = vp.height;
        const tc = await page.getTextContent();
        lines = fixOrder(toLines(tc.items, vp, Util));
        page.cleanup();
      } catch (e) { /* beschädigte Seite — bleibt leer, der Rest läuft weiter */ }
      raw.push({ lines, w, h });
      if (onProgress && (i % 3 === 0 || i === n)) onProgress(i, n);
    }
    return build(raw);
  }

  /** Textschnipsel einer Seite zu Zeilen zusammenfassen. Koordinaten in
      Viewport-Einheiten (y nach unten), damit gedrehte Seiten mitspielen. */
  function toLines(items, vp, Util) {
    const lines = [];
    let cur = null;
    const done = () => { if (cur) lines.push(cur); cur = null; };
    for (const it of items) {
      if (typeof it.str !== 'string') continue;         // Marked Content ohne Text
      const t = Util.transform(vp.transform, it.transform);
      // Senkrechter Text (Randvermerke, gedrehte Tabellenköpfe) stört den Lesefluss
      if (Math.abs(t[1]) > Math.abs(t[0]) * 0.3 || t[0] <= 0) { if (it.hasEOL) done(); continue; }
      const size = Math.hypot(t[2], t[3]) || it.height || 1;
      const x = t[4], y = t[5], w = it.width * vp.scale;
      const str = it.str;
      if (!str) { if (it.hasEOL) done(); continue; }
      const same = cur
        && Math.abs(y - cur.y) <= Math.max(size, cur.size) * 0.5
        && x >= cur.x0 - size;
      if (same) {
        const gap = x - cur.x1;
        if (gap > Math.min(size, cur.size) * 0.18 && !/\s$/.test(cur.s) && !/^\s/.test(str)) cur.s += ' ';
        cur.s += str;
        cur.x1 = Math.max(cur.x1, x + w);
        cur.sz += size * str.length; cur.n += str.length;
      } else {
        done();
        cur = { s: str, x0: x, x1: x + w, y, size, sz: size * str.length, n: str.length };
      }
      if (it.hasEOL) done();
    }
    done();
    return lines
      .map((l) => ({ s: l.s.replace(/\s+/g, ' ').trim(), x0: l.x0, x1: l.x1, y: l.y,
                     size: l.n ? l.sz / l.n : l.size }))
      .filter((l) => l.s);
  }

  /** Manche Erzeuger schreiben Zeilen in wilder Reihenfolge in den Inhalt.
      Springt der Text auffällig oft nach oben, nach Position sortieren.
      Mehrspaltiger Satz springt nur einmal pro Spalte und bleibt unberührt. */
  function fixOrder(lines) {
    if (lines.length < 4) return lines;
    let back = 0;
    for (let i = 1; i < lines.length; i++) if (lines[i].y < lines[i - 1].y - lines[i - 1].size * 0.5) back++;
    if (back / lines.length <= 0.3) return lines;
    return lines.slice().sort((a, b) =>
      (Math.abs(a.y - b.y) < Math.min(a.size, b.size) * 0.5 ? a.x0 - b.x0 : a.y - b.y));
  }

  function build(raw) {
    const all = [];
    raw.forEach((p) => p.lines.forEach((l) => all.push(l)));
    const body = weightedMedian(all.map((l) => [l.size, l.s.length])) || 10;
    stripRunning(raw, body);
    const gap = typicalGap(raw, body);
    const pages = raw.map((p) => paragraphs(p, body, gap));
    linkPages(pages);
    const sample = pages.slice(0, 40).map((p) => p.b.map((b) => b.s).join(' ')).join(' ');
    return {
      v: REFLOW_V,
      lang: guessLang(sample),
      pages: pages.map((p) => {
        const o = { b: p.b.map((b) => (b.c ? { t: b.t, s: b.s, c: b.c } : { t: b.t, s: b.s })) };
        if (p.img) o.img = 1;
        return o;
      }),
    };
  }

  /** Kopf- und Fußzeilen entfernen: Seitenzahlen im Randstreifen immer,
      sonst Zeilen, die (Ziffern ausgenommen) auf mindestens drei Seiten
      gleich am Rand stehen. Größere Schrift bleibt — das sind eher
      Kapitelüberschriften, die zufällig oben auf der Seite stehen. */
  function stripRunning(raw, body) {
    const key = (s) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    const edge = (p) => {
      const ls = p.lines, out = [];
      [0, 1, ls.length - 2, ls.length - 1].forEach((i) => {
        if (i < 0 || i >= ls.length) return;
        const l = ls[i];
        if ((l.y < p.h * 0.12 || l.y > p.h * 0.88) && !out.includes(l)) out.push(l);
      });
      return out;
    };
    const count = new Map();
    raw.forEach((p) => {
      const seen = new Set();
      edge(p).forEach((l) => {
        const k = key(l.s);
        if (seen.has(k)) return;
        seen.add(k);
        count.set(k, (count.get(k) || 0) + 1);
      });
    });
    const repeats = raw.length >= 6;
    raw.forEach((p) => {
      const drop = edge(p).filter((l) => isPageNo(l.s)
        || (repeats && l.s.length < 120 && l.size <= body * 1.15 && count.get(key(l.s)) >= 3));
      if (drop.length) p.lines = p.lines.filter((l) => !drop.includes(l));
    });
  }

  const isPageNo = (s) =>
    /^[\W_]*(seite|page|s\.|p\.)?\s*(\d{1,4}|[ivxlcdm]{1,7})(\s*(\/|von|of|-)\s*\d{1,4})?[\W_]*$/i.test(s.trim());

  /** Üblicher Abstand zweier Grundlinien im Fließtext — Maßstab dafür, ob
      zwischen zwei Zeilen ein Absatz liegt. */
  function typicalGap(raw, body) {
    const d = [];
    raw.forEach((p) => {
      for (let i = 1; i < p.lines.length; i++) {
        const a = p.lines[i - 1], b = p.lines[i];
        if (Math.abs(a.size - body) > body * 0.15 || Math.abs(b.size - body) > body * 0.15) continue;
        const dy = b.y - a.y;
        if (dy > body * 0.5 && dy < body * 3) d.push(dy);
      }
    });
    return median(d) || body * 1.2;
  }

  function paragraphs(p, body, gap) {
    const ls = p.lines;
    const out = [];
    let cur = null, prev = null;
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i];
      // Linker und rechter Rand aus den Nachbarzeilen ähnlicher Größe —
      // lokal statt pro Seite, damit auch mehrspaltiger Satz funktioniert.
      const near = ls.slice(Math.max(0, i - 4), i + 5).filter((m) => Math.abs(m.size - l.size) <= l.size * 0.2);
      l.L = Math.min(...near.map((m) => m.x0));
      l.R = Math.max(...near.map((m) => m.x1));
      const t = l.size > body * 1.18 && l.s.length < 160 ? 'h' : l.size < body * 0.86 ? 'f' : 'p';
      const ind = l.x0 - l.L > body * 0.7 && l.x0 - l.L < (l.R - l.L) * 0.4;
      let brk = true;
      if (cur && prev) {
        const dy = l.y - prev.y;
        if (t === 'h') {
          brk = !(cur.t === 'h' && dy > 0 && dy < l.size * 1.9 && Math.abs(l.size - prev.size) < 1);
        } else {
          const prevShort = prev.x1 < prev.R - (prev.R - prev.L) * 0.12;
          brk = cur.t !== t
            || BULLET.test(l.s)
            || ind
            || dy > gap * 1.45 * (l.size / body)
            || (prevShort && END.test(prev.s));
        }
      }
      if (brk) { cur = { t, s: l.s, ind }; out.push(cur); }
      else cur.s = joinLines(cur.s, l.s);
      prev = l;
    }
    // Initiale (großer Anfangsbuchstabe über mehrere Zeilen) wieder an ihr Wort hängen
    for (let i = out.length - 2; i >= 0; i--) {
      if (out[i].t === 'h' && out[i].s.length <= 2 && /^\p{L}+$/u.test(out[i].s) && out[i + 1].t === 'p') {
        out[i + 1].s = out[i].s + out[i + 1].s;
        out.splice(i, 1);
      }
    }
    const chars = out.reduce((n, b) => n + b.s.length, 0);
    return chars < 30 ? { b: [], img: true } : { b: out, img: false };
  }

  /** Absätze über den Seitenumbruch hinweg verbinden: Endet die Vorseite
      ohne Satzzeichen und beginnt die neue Seite ohne Einzug, geht der
      Satz weiter. */
  function linkPages(pages) {
    for (let i = 1; i < pages.length; i++) {
      const a = pages[i - 1], b = pages[i];
      if (a.img || b.img || !a.b.length || !b.b.length) continue;
      const last = a.b[a.b.length - 1], first = b.b[0];
      if (last.t !== 'p' || first.t !== 'p' || first.ind || BULLET.test(first.s) || END.test(last.s)) continue;
      if (/\p{L}-$/u.test(last.s) && /^\p{Ll}/u.test(first.s) && !KEEP_HYPHEN.test(first.s)) {
        last.s = last.s.slice(0, -1);
        first.c = 2;
      } else {
        first.c = 1;
      }
    }
  }

  function joinLines(a, b) {
    if (a.endsWith('­')) return a.slice(0, -1) + b;
    if (/\p{L}-$/u.test(a)) {
      if (/^\p{Ll}/u.test(b) && !KEEP_HYPHEN.test(b)) return a.slice(0, -1) + b;   // Silbentrennung
      if (/^\p{Lu}/u.test(b)) return a + b;                                         // „Max-Planck“
    }
    return a + ' ' + b;
  }

  function guessLang(s) {
    const words = s.toLowerCase().split(/[^a-zäöüßàâçéèêëîïôûùüÿñ]+/);
    const L = {
      de: 'der die und das nicht ist ein eine mit sich auf für den dem von zu auch wie wird',
      en: 'the and of to is that it with for as was on are this be by',
      fr: 'le la les des et est une que pas pour dans qui sur au',
      es: 'el los las y que es una por con para del se no',
      it: 'il che di è non una per sono della gli con',
    };
    let best = 'de', bestN = -1;
    Object.keys(L).forEach((k) => {
      const set = new Set(L[k].split(' '));
      const n = words.reduce((c, w) => c + (set.has(w) ? 1 : 0), 0);
      if (n > bestN) { best = k; bestN = n; }
    });
    return best;
  }

  /* ── Helfer ─────────────────────────────────────────────────── */
  function median(a) {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }
  function weightedMedian(pairs) {
    const s = pairs.filter((p) => p[1] > 0).sort((a, b) => a[0] - b[0]);
    const total = s.reduce((n, p) => n + p[1], 0);
    let acc = 0;
    for (const p of s) { acc += p[1]; if (acc >= total / 2) return p[0]; }
    return 0;
  }

  /** Seitentext so, wie Textmodus und Suche ihn zählen: Blöcke mit \n
      getrennt. Zeichen-Offsets darin sind die Positionsangabe im Textmodus. */
  const pageString = (pg) => (pg && pg.b ? pg.b.map((b) => b.s).join('\n') : '');

  /* Suche ohne Rücksicht auf Groß-/Kleinschreibung und Akzente — Zeichen für
     Zeichen, damit die Positionen im Original gleich bleiben. */
  const foldCache = new Map();
  function foldChar(c) {
    let f = foldCache.get(c);
    if (f === undefined) {
      f = c.toLowerCase().normalize('NFD').charAt(0);
      if (!f || /\s/.test(c)) f = ' ';
      foldCache.set(c, f);
    }
    return f;
  }
  function fold(s) {
    let r = '';
    for (let i = 0; i < s.length; i++) r += foldChar(s[i]);
    return r;
  }

  return { extract, pageString, fold };
})();
