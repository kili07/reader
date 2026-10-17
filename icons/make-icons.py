#!/usr/bin/env python3
"""App-Icons für Reader erzeugen: aufgeschlagenes Buch, weiß auf #1B1B1B.

Groß zeichnen (SS-fach) und verkleinern — sonst werden die Kanten stufig.
Farbe und Motivgröße stehen oben und lassen sich in einer Zeile ändern.

Aufruf:  python3 icons/make-icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

BG = (0x1B, 0x1B, 0x1B, 255)
FG = (0xFF, 0xFF, 0xFF, 255)
SS = 4                      # Überabtastung

# Motivbreite relativ zur Kantenlänge (siehe Bauanleitung 5.14)
ANY_W = 0.45
MASKABLE_W = 0.32

HERE = Path(__file__).resolve().parent


def quad(p0, p1, p2, steps=24):
    """Punkte einer quadratischen Bézierkurve — für die gewölbte Oberkante."""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
        pts.append((x, y))
    return pts


def book(draw, cx, cy, w):
    """Aufgeschlagenes Buch, Breite w, Mittelpunkt (cx, cy).

    Zwei Seiten mit schmalem Falz in der Mitte; die Oberkanten wölben sich
    zum Falz hin nach unten wie bei einem echten aufgeschlagenen Buch."""
    h = w * 0.72                 # Höhe des Motivs
    top = cy - h / 2
    gap = w * 0.035              # halber Falz
    sag = h * 0.12               # wie tief die Seiten zum Falz hin absinken

    for side in (-1, 1):
        outer = cx + side * w / 2
        inner = cx + side * gap
        # Oberkante: außen hoch, zum Falz hin abgesenkt
        top_edge = quad((outer, top), (cx + side * w * 0.22, top - sag * 0.35), (inner, top + sag))
        bottom_inner = (inner, top + h)
        bottom_outer = (outer, top + h - sag)
        pts = top_edge + [bottom_inner, bottom_outer]
        draw.polygon(pts, fill=FG)


def make(size, motif_w, name):
    big = size * SS
    img = Image.new('RGBA', (big, big), BG)
    d = ImageDraw.Draw(img)
    book(d, big / 2, big / 2 + big * 0.01, big * motif_w)
    img = img.resize((size, size), Image.LANCZOS)
    img.convert('RGB').save(HERE / name, optimize=True)
    print('geschrieben:', name)


if __name__ == '__main__':
    make(192, ANY_W, 'icon-192.png')
    make(512, ANY_W, 'icon-512.png')
    make(512, MASKABLE_W, 'icon-maskable-512.png')
