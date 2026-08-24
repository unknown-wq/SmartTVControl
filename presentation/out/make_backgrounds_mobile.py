#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_backgrounds_mobile.py — вертикальные подложки 9:16 для мобильной версии
презентации «От „Большой Перемены“ к нейролаборатории» (SPEC_MOBILE.md §4).

Горизонтальные подложки НЕ растягиваются: канва пересобирается заново
(1440×2560) теми же примитивами из make_backgrounds.py, но с вертикальными
композициями — мотивы уходят в верхнюю и нижнюю полосы и в боковые кромки,
центр остаётся чистым под текст.

Использование:  python3 out/make_backgrounds_mobile.py
"""

from __future__ import annotations

import math
import os
import random

import numpy as np
from PIL import Image

import make_backgrounds as mb

# ── переводим модуль-донор в вертикальную канву ────────────────────────────
W, H = 1440, 2560
mb.W, mb.H = W, H
mb.CLEAN_W, mb.CLEAN_H = 0.86, 0.70     # на вертикали текст занимает почти всю ширину
mb._CENTER_MASK = None                  # маска пересчитается под новый кадр

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "prepared", "backgrounds_mobile")

Board = mb.Board
petri, dna, ecg = mb.petri, mb.dna, mb.ecg
rods, cocci, microscope = mb.rods, mb.cocci, mb.microscope
chloroplast, plant_cell, bacterial_cell = mb.chloroplast, mb.plant_cell, mb.bacterial_cell
neural_net, biosignal, pixel_grid = mb.neural_net, mb.biosignal, mb.pixel_grid
gaussian, citrus_leaf = mb.gaussian, mb.citrus_leaf
dot_ring, rays, soft_arcs, dot_field = mb.dot_ring, mb.rays, mb.soft_arcs, mb.dot_field

A_BG, A_BLUE, A_GARNET = mb.A_BG, mb.A_BLUE, mb.A_GARNET
B_BG, B_BLUE, B_BLUE_DK = mb.B_BG, mb.B_BLUE, mb.B_BLUE_DK
C_BG, C_GREEN, C_GREEN_DK, C_NAVY = mb.C_BG, mb.C_GREEN, mb.C_GREEN_DK, mb.C_NAVY

TOP = 380          # высота верхней декоративной полосы
BOT = H - 380      # начало нижней полосы


# ── зона A ────────────────────────────────────────────────────────────────
def bg_a_title() -> Image.Image:
    """Экран 1: ЭКГ-полосы сверху/снизу, ДНК по кромкам, бактерии в углах."""
    rnd = random.Random(101)
    b = Board(A_BG)
    blue = b.pen(A_BLUE, 0.12)
    blue_s = b.pen(A_BLUE, 0.08)
    garnet = b.pen(A_GARNET, 0.11)

    ecg(blue, -60, 300, 1560, 104, 330, w=3.4, jitter=0.14, rnd=rnd)
    ecg(blue_s, -40, 186, 1540, 58, 240, w=2.6, jitter=0.10, rnd=rnd)
    ecg(blue, -60, 2320, 1560, 110, 344, w=3.4, jitter=0.14, rnd=rnd)
    ecg(blue_s, -40, 2452, 1540, 60, 246, w=2.6, jitter=0.10, rnd=rnd)

    dna(blue, 86, -80, 2740, 58, 300, math.pi / 2, w=3.2)
    dna(blue, 1352, -60, 2700, 54, 280, math.pi / 2 + 0.04, w=3.2)

    for cx, cy, r in ((178, 470, 92), (1268, 2120, 84), (240, 2220, 62), (1236, 322, 60)):
        bacterial_cell(garnet, cx, cy, r, w=3.0)
    rods(garnet, 620, 180, rnd, n=4, spread=210, L=(84, 132), w=2.8)
    rods(garnet, 880, 2420, rnd, n=4, spread=230, L=(80, 128), w=2.8)
    cocci(garnet, 70, 1320, rnd, n=5, r=24, spread=150, w=2.8)
    cocci(garnet, 1382, 1120, rnd, n=5, r=22, spread=140, w=2.8)
    return b.render()


def _bp_geometry_v(b, blue, garnet, blue_s, rnd, density=1.0):
    """Айдентика «Большой Перемены» в вертикальном кадре."""
    soft_arcs(blue, -180, -200, [460, 580, 700, 820, 940, 1060], 0.06, 1.46, w=3.2)
    soft_arcs(garnet, 1620, 2760, [460, 600, 740, 880, 1020], math.pi + 0.08,
              math.pi + 1.46, w=3.0)
    rays(blue_s, -120, 2700, 340, 1180, -1.42, -0.10, int(11 * density), w=2.4)
    rays(garnet, 1560, -140, 320, 1060, math.pi + 0.14, math.pi + 1.40,
         int(9 * density), w=2.4)

    dot_ring(garnet, 250, 330, 180, 20, dot=8)
    dot_ring(blue, 250, 330, 120, 14, dot=6, a0=0.2)
    blue.circle(250, 330, 244, w=3.0)
    dot_ring(blue, 1190, 2230, 196, 22, dot=8)
    dot_ring(garnet, 1190, 2230, 132, 15, dot=6, a0=0.25)
    garnet.circle(1190, 2230, 262, w=3.0)

    dot_field(blue_s, 1160, 130, 6, 4, 46, dot=6)
    dot_field(garnet, 60, 2280, 5, 4, 46, dot=6)
    for _ in range(int(16 * density)):
        x = rnd.choice([rnd.uniform(30, 190), rnd.uniform(1250, 1410)])
        y = rnd.uniform(60, H - 60)
        blue_s.circle(x, y, rnd.uniform(16, 44), w=2.4)


def bg_a_plain() -> Image.Image:
    """Экраны слайда 2: геометрия айдентики «Большой Перемены»."""
    rnd = random.Random(202)
    b = Board(A_BG)
    blue = b.pen(A_BLUE, 0.12)
    blue_s = b.pen(A_BLUE, 0.075)
    garnet = b.pen(A_GARNET, 0.11)
    _bp_geometry_v(b, blue, garnet, blue_s, rnd, density=1.0)
    return b.render()


def bg_a_timeline() -> Image.Image:
    """Экраны слайда 3: та же геометрия + вертикальная «цепь достижений» слева."""
    rnd = random.Random(303)
    b = Board(A_BG)
    blue = b.pen(A_BLUE, 0.11)
    blue_s = b.pen(A_BLUE, 0.07)
    garnet = b.pen(A_GARNET, 0.12)
    _bp_geometry_v(b, blue, garnet, blue_s, rnd, density=0.6)

    x = 62
    blue.poly([(x, 0), (x, H)], 3.4)
    blue_s.dashed([(x + 26, 0), (x + 26, H)], 2.2, dash=18, gap=16)
    for y in (520, 1280, 2040):
        garnet.circle(x, y, 32, 3.6)
        garnet.circle(x, y, 18, 2.6)
        garnet.disc(x, y, 8)
    return b.render()


# ── зона B ────────────────────────────────────────────────────────────────
def bg_b_micro() -> Image.Image:
    """Экраны слайда 4: чашки Петри, бактерии, ДНК, микроскоп (зона B)."""
    rnd = random.Random(404)
    b = Board(B_BG)
    blue = b.pen(B_BLUE, 0.12)
    blue_s = b.pen(B_BLUE_DK, 0.08)
    navy = b.pen(B_BLUE_DK, 0.10)

    petri(blue, 190, 250, 288, rnd, colonies=12, w=3.6)
    petri(blue, 1290, 2280, 288, rnd, colonies=12, w=3.6)
    petri(blue_s, 1330, 300, 176, rnd, colonies=7, w=3.0)
    petri(blue_s, 130, 2200, 168, rnd, colonies=7, w=3.0)
    petri(blue, 700, 2530, 210, rnd, colonies=8, w=3.0)
    petri(blue_s, 760, 40, 196, rnd, colonies=7, w=2.8)

    microscope(navy, 1330, 1360, 3.0, w=3.2)
    microscope(navy, 120, 1560, 2.4, w=2.8)

    dna(blue_s, 70, 640, 1300, 46, 260, math.pi / 2, w=2.8)
    dna(blue_s, 1372, 700, 1200, 44, 250, math.pi / 2 + 0.05, w=2.8)

    rods(blue, 520, 170, rnd, n=6, spread=250, L=(90, 142), w=3.0)
    rods(blue, 900, 2400, rnd, n=6, spread=250, L=(88, 140), w=3.0)
    cocci(navy, 380, 2470, rnd, n=5, r=20, spread=140, w=2.6)
    return b.render()


# ── зона C ────────────────────────────────────────────────────────────────
def bg_c_micro() -> Image.Image:
    """Зона C: чашки Петри, микроскопы, палочковидные бактерии."""
    rnd = random.Random(505)
    b = Board(C_BG)
    green = b.pen(C_GREEN, 0.12)
    green_s = b.pen(C_GREEN_DK, 0.08)
    navy = b.pen(C_NAVY, 0.10)

    petri(green, 180, 260, 292, rnd, colonies=12, w=3.6)
    petri(green, 1300, 2260, 292, rnd, colonies=12, w=3.6)
    petri(green_s, 1310, 240, 180, rnd, colonies=7, w=3.0)
    petri(green_s, 150, 2240, 176, rnd, colonies=7, w=3.0)
    petri(green, 720, 2540, 200, rnd, colonies=8, w=3.0)
    petri(green_s, 40, 1300, 148, rnd, colonies=6, w=3.0)
    petri(green_s, 1400, 1180, 146, rnd, colonies=6, w=3.0)

    microscope(navy, 1300, 1620, 2.9, w=3.2)
    microscope(navy, 130, 1780, 2.4, w=2.8)

    rods(green, 560, 160, rnd, n=6, spread=250, L=(90, 145), w=3.0)
    rods(green, 880, 2400, rnd, n=6, spread=250, L=(88, 140), w=3.0)
    rods(green_s, 60, 780, rnd, n=4, spread=140, L=(78, 120), w=2.8)
    rods(green_s, 1390, 800, rnd, n=4, spread=140, L=(78, 118), w=2.8)
    cocci(navy, 400, 2500, rnd, n=5, r=20, spread=140, w=2.6)
    return b.render()


def bg_c_cells() -> Image.Image:
    """Зона C: хлоропласты, растительные и бактериальные клетки + нейросети."""
    rnd = random.Random(606)
    b = Board(C_BG)
    green = b.pen(C_GREEN, 0.12)
    green_s = b.pen(C_GREEN_DK, 0.075)
    navy = b.pen(C_NAVY, 0.10)
    navy_s = b.pen(C_NAVY, 0.065)

    plant_cell(green, -60, 40, 430, 400, rnd, w=3.4)
    plant_cell(green, 1010, 2200, 1520, 2540, rnd, w=3.4)
    plant_cell(green_s, 900, 60, 1330, 280, rnd, w=2.8)

    chloroplast(green, 280, 2280, 170, 94, 0.35, w=3.2)
    chloroplast(green, 1180, 300, 158, 86, -0.5, w=3.2)
    chloroplast(green_s, 120, 1180, 146, 80, 1.15, w=2.8)
    chloroplast(green_s, 1330, 1500, 140, 76, -0.25, w=2.8)

    for cx, cy, r in ((70, 820, 76), (1390, 900, 70), (560, 2540, 58)):
        bacterial_cell(green_s, cx, cy, r, w=2.8)
    rods(green_s, 620, 130, rnd, n=4, spread=190, L=(78, 118), w=2.6)

    neural_net(navy, navy_s, 940, 2360, 150, 92, [4, 5, 4], r=13, w=2.8)
    neural_net(navy, navy_s, 80, 180, 148, 88, [3, 4, 3], r=12, w=2.8)
    neural_net(navy_s, navy_s, 1180, 1820, 120, 82, [3, 3], r=11, w=2.4)
    return b.render()


def bg_c_neuro() -> Image.Image:
    """Зона C: биосигналы, нейросети, цифровая пиксельная сетка."""
    rnd = random.Random(707)
    b = Board(C_BG)
    green = b.pen(C_GREEN, 0.115)
    green_s = b.pen(C_GREEN_DK, 0.075)
    navy = b.pen(C_NAVY, 0.10)
    navy_s = b.pen(C_NAVY, 0.065)

    for y, amp, w_ in ((150, 58, 3.0), (250, 42, 2.6), (2320, 66, 3.2), (2430, 46, 2.6)):
        biosignal(green if amp > 50 else green_s, -40, y, 1540, amp, rnd, w=w_)
    ecg(green_s, -40, 2510, 1540, 50, 250, w=2.6)

    neural_net(navy, navy_s, 60, 1120, 118, 100, [4, 5, 4], r=13, w=2.8)
    neural_net(navy, navy_s, 1080, 1180, 116, 98, [3, 5, 4], r=13, w=2.8)

    pixel_grid(navy_s, navy_s, 36, 36, 6, 4, 30, 6, rnd, 0.18, w=2.2)
    pixel_grid(navy_s, navy_s, 1120, 2400, 6, 4, 30, 6, rnd, 0.18, w=2.2)
    pixel_grid(green_s, green_s, 620, 40, 8, 2, 26, 6, rnd, 0.14, w=2.0)
    pixel_grid(green_s, green_s, 560, 2470, 8, 2, 26, 6, rnd, 0.14, w=2.0)
    return b.render()


def bg_c_ecg() -> Image.Image:
    """Зона C: линии ЭКГ разной амплитуды на миллиметровой сетке."""
    rnd = random.Random(909)
    b = Board(C_BG)
    green = b.pen(C_GREEN, 0.12)
    green_s = b.pen(C_GREEN_DK, 0.08)
    navy = b.pen(C_NAVY, 0.095)
    navy_s = b.pen(C_NAVY, 0.06)

    for x in range(0, W + 1, 64):
        navy_s.poly([(x, 0), (x, H)], 1.8)
    for y in range(0, H + 1, 64):
        navy_s.poly([(0, y), (W, y)], 1.8)

    ecg(green, -60, 210, 1560, 116, 350, w=3.6, jitter=0.16, rnd=rnd)
    ecg(green_s, -40, 320, 1540, 58, 220, w=2.6, jitter=0.10, rnd=rnd)
    ecg(green, -60, 2350, 1560, 124, 372, w=3.6, jitter=0.16, rnd=rnd)
    ecg(navy, -50, 2470, 1540, 72, 258, w=2.8, jitter=0.12, rnd=rnd)
    ecg(navy, -40, 1000, 420, 108, 340, w=3.0, jitter=0.15, rnd=rnd)
    ecg(navy, 1060, 1560, 420, 108, 340, w=3.0, jitter=0.15, rnd=rnd)
    return b.render()


def bg_c_split() -> Image.Image:
    """Зона C: цитрусовые листья сверху, кривые Гаусса снизу."""
    rnd = random.Random(1010)
    b = Board(C_BG)
    green = b.pen(C_GREEN, 0.12)
    green_s = b.pen(C_GREEN_DK, 0.08)
    navy = b.pen(C_NAVY, 0.10)
    navy_s = b.pen(C_NAVY, 0.065)

    # верх — цитрусовые листья и ветвь
    citrus_leaf(green, 230, 250, 480, rot=-0.55, w=3.2)
    citrus_leaf(green, 1150, 300, 500, rot=0.42, w=3.2)
    citrus_leaf(green_s, 660, 120, 400, rot=-0.20, w=2.8)
    citrus_leaf(green_s, 60, 700, 380, rot=1.15, w=2.8)
    citrus_leaf(green_s, 1370, 760, 400, rot=-1.05, w=2.8)
    citrus_leaf(green, 700, 480, 300, rot=0.25, w=2.6)
    green_s.poly([(0, 60), (220, 210), (450, 330), (700, 400), (980, 360), (1240, 190),
                  (1440, 40)], 3.0)

    # низ — кривые Гаусса с осями
    base_y = 2470
    for mu, sg, amp, pen, w_ in ((0.28, 0.085, 250, navy, 3.4),
                                 (0.52, 0.125, 205, green, 3.2),
                                 (0.76, 0.100, 158, navy_s, 3.0)):
        gaussian(pen, 100, base_y, 1240, amp, mu, sg, w=w_)
    navy.poly([(60, base_y), (1400, base_y)], 3.0)
    navy_s.poly([(100, base_y + 20), (100, base_y - 300)], 2.4)
    for k in range(1, 9):
        x = 100 + 1240 * k / 9
        navy_s.poly([(x, base_y), (x, base_y + 14)], 2.2)

    base_y2 = 2060
    for mu, sg, amp, pen in ((0.36, 0.10, 175, navy_s), (0.64, 0.14, 140, green_s)):
        gaussian(pen, 140, base_y2, 1180, amp, mu, sg, w=2.8)
    navy_s.poly([(110, base_y2), (1390, base_y2)], 2.4)

    pixel_grid(navy_s, navy_s, 40, 1560, 4, 6, 28, 6, rnd, 0.18, w=2.2)
    pixel_grid(navy_s, navy_s, 1230, 1500, 4, 6, 28, 6, rnd, 0.18, w=2.2)

    navy_s.dashed([(0, 1300), (300, 1300)], 2.2, dash=16, gap=18)
    navy_s.dashed([(1140, 1300), (1440, 1300)], 2.2, dash=16, gap=18)
    return b.render()


def bg_c_final() -> Image.Image:
    """Зона C: спокойная финальная подложка."""
    rnd = random.Random(1111)
    b = Board(C_BG)
    green = b.pen(C_GREEN, 0.085)
    green_s = b.pen(C_GREEN_DK, 0.06)
    navy = b.pen(C_NAVY, 0.075)
    navy_s = b.pen(C_NAVY, 0.06)

    soft_arcs(green, -240, -260, [520, 720, 920, 1120, 1320], 0.06, 1.44, w=3.0)
    soft_arcs(green_s, 1700, 2820, [520, 740, 960, 1180], math.pi + 0.08,
              math.pi + 1.44, w=2.8)

    chloroplast(green_s, 240, 250, 160, 88, -0.28, w=2.8)
    bacterial_cell(green_s, 1290, 2300, 80, w=2.6)
    plant_cell(green_s, 1060, 60, 1460, 340, rnd, w=2.6)

    neural_net(navy, navy_s, 120, 2260, 176, 104, [3, 3, 2], r=12, w=2.6)
    biosignal(navy_s, -40, 2520, 1540, 34, rnd, w=2.4, harmonics=4)
    biosignal(green_s, -40, 110, 1540, 30, rnd, w=2.4, harmonics=4)
    dot_ring(green_s, 1360, 1300, 148, 16, dot=6)
    dot_ring(green_s, 1360, 1300, 94, 11, dot=5, a0=0.3)
    return b.render()


BACKGROUNDS = [
    ("bg_a_title.png", bg_a_title, "зона A · титул"),
    ("bg_a_plain.png", bg_a_plain, "зона A · геометрия «Большой Перемены»"),
    ("bg_a_timeline.png", bg_a_timeline, "зона A · геометрия + цепь достижений"),
    ("bg_b_micro.png", bg_b_micro, "зона B · чашки Петри, ДНК, микроскоп"),
    ("bg_c_micro.png", bg_c_micro, "зона C · чашки Петри, микроскопы"),
    ("bg_c_cells.png", bg_c_cells, "зона C · клетки, хлоропласты, нейросети"),
    ("bg_c_neuro.png", bg_c_neuro, "зона C · биосигналы, пиксель-сетка"),
    ("bg_c_ecg.png", bg_c_ecg, "зона C · ЭКГ на миллиметровке"),
    ("bg_c_split.png", bg_c_split, "зона C · листья | кривые Гаусса"),
    ("bg_c_final.png", bg_c_final, "зона C · спокойный финал"),
]


def center_report(path):
    """Числовая проверка чистоты центральной зоны под текст."""
    a = np.asarray(Image.open(path).convert("RGB"), dtype=np.int16)
    base = a[2, 2].astype(np.int16)
    x0, x1 = int(W * 0.06), int(W * 0.94)      # почти вся ширина — там лежит текст
    y0, y1 = int(H * 0.18), int(H * 0.82)
    dev = np.abs(a[y0:y1, x0:x1] - base[None, None, :]).max(axis=2)
    full = np.abs(a - base[None, None, :]).max(axis=2)
    return dict(center_max=int(dev.max()), center_mean=float(dev.mean()),
                frame_max=int(full.max()), ink=float((full > 3).mean() * 100))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, fn, desc in BACKGROUNDS:
        img = fn()
        assert img.size == (W, H), img.size
        p = os.path.join(OUT_DIR, name)
        img.save(p, optimize=True)
        r = center_report(p)
        print(f"{name:18s} {desc}\n{'':18s} текстовая зона: max Δ={r['center_max']:3d} "
              f"средн Δ={r['center_mean']:.2f} | кадр: max Δ={r['frame_max']:3d} "
              f"покрытие={r['ink']:.1f}%")


if __name__ == "__main__":
    main()
