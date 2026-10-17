# Reader

PDF-Bücher auf dem Handy lesen – offline, als installierbare Web-App. Reader merkt
sich für jedes Buch, wo Du warst, und bringt alles mit, was ein E-Book-Reader braucht.

## Was die App kann

**Bibliothek**
- PDFs importieren (Plus-Knopf, mehrere auf einmal; am Rechner auch per Drag-and-Drop)
- Cover aus der ersten Seite, Titel und Autor aus den PDF-Metadaten (änderbar)
- „Weiterlesen“-Karte für das zuletzt gelesene Buch
- Filter: Alle · Lese ich · Ungelesen · Gelesen · eigene Regale
- Sortieren nach zuletzt gelesen, hinzugefügt, Titel, Autor, Fortschritt
- Suche nach Titel und Autor, Raster- oder Listenansicht
- Langes Drücken auf ein Buch öffnet die Details: Regale, als gelesen markieren,
  Lesestand zurücksetzen, löschen

**Regale** – eigene Sammlungen wie „Fachbücher“ oder „Romane“; ein Buch kann in mehreren stehen.

**Lesen**
- Drei Ansichten, jederzeit umschaltbar, der Lesestand bleibt erhalten:
  - *Seiten* – eine PDF-Seite pro Bildschirm, Blättern per Wischen oder Tippen
  - *Scrollen* – alle Seiten untereinander
  - *Text* – der Text des PDFs neu umbrochen wie in einem E-Book, mit eigener
    Schriftgröße, Schrift, Zeilenabstand, Rand und Blocksatz. Kopf- und Fußzeilen,
    Seitenzahlen und Silbentrennungen des PDFs werden dabei entfernt.
- Weiße Ränder automatisch abschneiden – die Schrift wird größer, ohne zu zoomen
- Zoom mit zwei Fingern oder Doppeltippen, danach scharf neu gerendert
- Inhaltsverzeichnis aus dem PDF (sonst aus erkannten Überschriften)
- Lesezeichen, benennbar
- Volltextsuche mit Markierung der Treffer auf der Seite
- Springen zu einer Seite (auch über gedruckte Seitenzahlen wie „xii“), Seitenregler
- Papier: Weiß, Sepia, Dunkel, Schwarz – plus Abdunkeln für die Nacht
- Bildschirm bleibt beim Lesen an (nach 10 Minuten ohne Blättern nicht mehr)
- Vollbild auf Wunsch, Zurück-Taste schließt das Buch statt die App
- Anzeige: Kapitel, Seite, Prozent, Seiten bis Kapitelende, Restzeit bis zum Buchende

**Statistik** – Lesezeit und Seiten pro Tag (7 Tage, 30 Tage, 12 Monate), Serie,
gelesene Bücher im Jahr, Lesetempo und Restzeit je Buch.

## Deine Daten

Alles bleibt **nur auf diesem Gerät**. Es gibt keinen Server und kein Konto.

- PDFs, Cover und aufbereiteter Text liegen in IndexedDB.
- Lesestand, Lesezeichen, Regale, Statistik und Einstellungen liegen in localStorage.

„Browserdaten löschen“ oder das Deinstallieren der App entfernt alles. Deshalb gibt es
unter *Mehr → Backup speichern* eine kleine JSON-Datei mit allen Lesedaten.
**Die PDFs selbst sind nicht im Backup** – bewahre sie also selbst auf. Nach
*Backup laden* zeigt die Bibliothek die Bücher mit „PDF fehlt“; importiere dann
dieselben Dateien erneut. Die App erkennt sie am Fingerabdruck (SHA-256), egal wie
die Datei heißt, und hängt Lesestand und Lesezeichen wieder an.

## Installieren (GitHub Pages)

1. Repo auf [github.com/new](https://github.com/new) anlegen, **Public**, kein README anhaken.
2. „uploading an existing file“ → den **Inhalt** dieses Ordners hineinziehen, nicht den Ordner
   selbst. `index.html` muss im Wurzelverzeichnis liegen. Mit hochladen:
   `index.html`, `style.css`, `app.js`, `reflow.js`, `sw.js`, `manifest.webmanifest`,
   `README.md` und die Ordner `icons/` und `vendor/` (zusammen rund 45 Dateien).
   **Nicht** hochladen: `.claude/`, `HANDY-WEBAPP-BAUANLEITUNG.md`, Backups.
3. *Settings → Pages → Deploy from a branch, `main`, `/ (root)`* → Save.
4. Nach ein bis zwei Minuten: `https://<name>.github.io/<repo>/`
5. Auf dem Handy in Chrome öffnen → ⋮ → **Zum Startbildschirm hinzufügen**.

Beim ersten Start lädt die App PDF.js (rund 5 MB) in den Offline-Speicher. Danach
startet sie ohne Netz.

## Technik

Vanilla JavaScript ohne Build-Schritt, nach der Bauanleitung in
`HANDY-WEBAPP-BAUANLEITUNG.md`. Einzige Abhängigkeit ist
[PDF.js](https://mozilla.github.io/pdf.js/) von Mozilla (Apache-Lizenz 2.0), Version
6.4.299 in der „legacy“-Fassung für ältere Handy-Browser. Es liegt lokal in
`vendor/pdfjs/` und wird nicht aus dem Netz nachgeladen.

| Datei | Inhalt |
|---|---|
| `app.js` | die ganze App: Bibliothek, Leser, Regale, Statistik, Backup |
| `reflow.js` | Text aus dem PDF ziehen und zu Absätzen fügen (Textmodus, Suche) |
| `sw.js` | Service Worker, Offline-Cache |
| `vendor/pdfjs/cmaps.bin` | die 168 Zeichentabellen von PDF.js in einer Datei – der Upload über die GitHub-Weboberfläche nimmt höchstens 100 Dateien; `sw.js` liefert sie einzeln aus |
| `vendor/pack-cmaps.py` | erzeugt `cmaps.bin`, nur nötig bei einem PDF.js-Update |
| `icons/make-icons.py` | erzeugt die App-Icons (Python + Pillow) |

Lokal testen: `python3 -m http.server 8123` im Projektordner, dann `http://localhost:8123`.

**PDF.js aktualisieren:** `pdfjs-<version>-legacy-dist.zip` von den
[PDF.js-Releases](https://github.com/mozilla/pdf.js/releases) entpacken, `build/pdf.mjs`
und `build/pdf.worker.mjs` sowie `web/standard_fonts`, `web/wasm` (nur die `.wasm`-Dateien
und Lizenzen) und `web/iccs` nach `vendor/pdfjs/` kopieren,
`python3 vendor/pack-cmaps.py <entpackt>/web/cmaps` ausführen und in `sw.js` den Namen
`VENDOR` auf die neue Version setzen.
