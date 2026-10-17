#!/usr/bin/env python3
"""Die 168 Zeichentabellen (CMaps) von PDF.js in eine Datei packen.

Warum: Der Upload über die GitHub-Weboberfläche nimmt höchstens 100 Dateien
auf einmal. Der Service Worker (sw.js) liefert die einzelnen .bcmap-Dateien
aus diesem Paket aus — für PDF.js sieht es aus, als lägen sie einzeln da.

Format von cmaps.bin:
  4 Byte   Länge L des Inhaltsverzeichnisses (uint32, little endian)
  L Byte   Inhaltsverzeichnis als JSON: {"Name": [Offset, Länge], …}
           Offset zählt ab dem Ende des Inhaltsverzeichnisses
  Rest     die .bcmap-Dateien hintereinander

Nur nötig, wenn PDF.js aktualisiert wird:
  python3 vendor/pack-cmaps.py <entpacktes-pdfjs-dist>/web/cmaps
"""
import json, struct, sys
from pathlib import Path

src = Path(sys.argv[1] if len(sys.argv) > 1 else 'cmaps')
out = Path(__file__).resolve().parent / 'pdfjs' / 'cmaps.bin'

index, blobs, pos = {}, [], 0
for f in sorted(src.glob('*.bcmap')):
    data = f.read_bytes()
    index[f.stem] = [pos, len(data)]
    blobs.append(data)
    pos += len(data)

head = json.dumps(index, separators=(',', ':')).encode()
out.write_bytes(struct.pack('<I', len(head)) + head + b''.join(blobs))
print(f'{len(index)} CMaps, {out.stat().st_size} Bytes → {out}')
