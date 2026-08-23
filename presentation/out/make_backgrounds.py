#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_backgrounds.py — генерация тематических фоновых подложек для презентации v2
«От „Большой Перемены“ к нейролаборатории».

Всё рисуется кодом (Pillow), никаких растровых картинок извне.
Размер: 2560×1440 (16:9), сплошная заливка цветом зоны + «водяные» контуры мотивов.

Ключевые принципы (SPEC_v2 §2 и §4):
  * непрозрачность графики 6–14 % от фона, линии 2–4 px (в масштабе 2560);
  * центральная зона (62 % ширины × 58 % высоты) абсолютно чистая — там ляжет текст;
  * элементы концентрируются по краям и в углах, к центру плавно затухают;
  * мотивы узнаваемы: чашка Петри, ДНК, ЭКГ, нейросеть, хлоропласт, микроскоп и т. д.

Антиалиасинг: всё рисуется в SS раз крупнее и усредняется (BOX) до финального размера.

Использование:
    python3 out/make_backgrounds.py            # 10 подложек
    python3 out/make_backgrounds.py --qa       # + контактный лист и тест читаемости текста
"""

from __future__ import annotations

import math
import os
import random
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

# ──────────────────────────────────────────────────────────────────────────────
# Константы
# ──────────────────────────────────────────────────────────────────────────────

W, H = 2560, 1440           # финальный размер подложки
SS = 3                      # supersampling для антиалиасинга

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "prepared", "backgrounds")
QA_DIR = os.path.join(OUT_DIR, "_qa")

# Цветовые зоны (SPEC_v2 §2)
A_BG = "#F2F5FC"; A_BLUE = "#1B3C8C"; A_GARNET = "#8C1D3F"
B_BG = "#EAF4FE"; B_BLUE = "#0B69C7"; B_BLUE_DK = "#06407A"
C_BG = "#EAF6E4"; C_GREEN = "#2E9B3E"; C_GREEN_DK = "#1E7A2C"; C_NAVY = "#14315E"

# Чистая центральная зона: полуширина/полувысота в долях полукадра
CLEAN_W, CLEAN_H = 0.62, 0.58
RAMP = 1.26                 # к этому значению нормы ink выходит на полную силу

FONT_DIR = "/usr/share/fonts/truetype/montserrat"


def hex2rgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


# ──────────────────────────────────────────────────────────────────────────────
# Маска чистого центра
# ──────────────────────────────────────────────────────────────────────────────

_CENTER_MASK = None


def center_mask() -> np.ndarray:
    """0 в центре (чистая зона под текст) → 1 у краёв, гладкий переход."""
    global _CENTER_MASK
    if _CENTER_MASK is None:
        x = (np.arange(W) + 0.5) / W * 2.0 - 1.0
        y = (np.arange(H) + 0.5) / H * 2.0 - 1.0
        u = np.abs(x)[None, :] / CLEAN_W
        v = np.abs(y)[:, None] / CLEAN_H
        p = 8.0                                   # почти max-норма → прямоугольная чистая зона
        m = (u ** p + v ** p) ** (1.0 / p)
        t = np.clip((m - 1.0) / (RAMP - 1.0), 0.0, 1.0)
        _CENTER_MASK = (t * t * (3.0 - 2.0 * t)).astype(np.float32)
    return _CENTER_MASK


# ──────────────────────────────────────────────────────────────────────────────
# Слой рисования (перо)
# ──────────────────────────────────────────────────────────────────────────────

class Pen:
    """Один «чернильный» слой: маска покрытия + цвет + непрозрачность."""

    def __init__(self, color: str, alpha: float):
        assert 0.06 <= alpha <= 0.14, "непрозрачность вне диапазона 6–14 % (SPEC_v2 §4)"
        self.color = hex2rgb(color)
        self.alpha = alpha
        self.img = Image.new("L", (W * SS, H * SS), 0)
        self.d = ImageDraw.Draw(self.img)

    # ---- низкоуровневые примитивы (координаты в финальных пикселях) ----------

    def _s(self, pts):
        return [(x * SS, y * SS) for x, y in pts]

    def poly(self, pts, w=3.0, closed=False):
        if len(pts) < 2:
            return
        p = self._s(pts)
        if closed:
            p = p + [p[0]]
        wid = max(1, int(round(w * SS)))
        joint = "curve" if (len(p) <= 60 and wid > 2) else None
        self.d.line(p, fill=255, width=wid, joint=joint)

    def dashed(self, pts, w=2.0, dash=14, gap=12):
        """Пунктир вдоль ломаной."""
        acc, on, seg = 0.0, True, [pts[0]]
        limit = dash
        for a, b in zip(pts, pts[1:]):
            d = math.hypot(b[0] - a[0], b[1] - a[1])
            t0 = 0.0
            while t0 < d:
                step = min(limit - acc, d - t0)
                t1 = t0 + step
                pa = (a[0] + (b[0] - a[0]) * t0 / d, a[1] + (b[1] - a[1]) * t0 / d)
                pb = (a[0] + (b[0] - a[0]) * t1 / d, a[1] + (b[1] - a[1]) * t1 / d)
                if on:
                    self.poly([pa, pb], w)
                acc += step
                t0 = t1
                if acc >= limit - 1e-6:
                    acc = 0.0
                    on = not on
                    limit = dash if on else gap
        del seg

    def ellipse(self, cx, cy, rx, ry, rot=0.0, w=3.0, n=160):
        c, s = math.cos(rot), math.sin(rot)
        pts = []
        for i in range(n + 1):
            a = 2 * math.pi * i / n
            X, Y = rx * math.cos(a), ry * math.sin(a)
            pts.append((cx + X * c - Y * s, cy + X * s + Y * c))
        self.poly(pts, w)

    def circle(self, cx, cy, r, w=3.0):
        self.ellipse(cx, cy, r, r, 0.0, w, n=max(48, int(r)))

    def disc(self, cx, cy, r):
        self.d.ellipse([(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS], fill=255)

    def arc(self, cx, cy, r, a0, a1, w=3.0):
        n = max(24, int(abs(a1 - a0) * r / 5))
        pts = [(cx + r * math.cos(a0 + (a1 - a0) * i / n),
                cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]
        self.poly(pts, w)

    def rrect(self, x0, y0, x1, y1, r, w=3.0):
        r = min(r, (x1 - x0) / 2, (y1 - y0) / 2)
        pts = []
        for (cx, cy, a0) in ((x1 - r, y1 - r, 0.0), (x0 + r, y1 - r, math.pi / 2),
                             (x0 + r, y0 + r, math.pi), (x1 - r, y0 + r, 1.5 * math.pi)):
            for i in range(13):
                a = a0 + math.pi / 2 * i / 12
                pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        self.poly(pts, w, closed=True)

    def capsule(self, cx, cy, length, width, ang, w=3.0):
        """Палочковидная бактерия — контур «стадиона»."""
        hl = max(0.0, length / 2 - width / 2)
        r = width / 2
        pts = []
        for i in range(19):                      # правый колпачок
            a = -math.pi / 2 + math.pi * i / 18
            pts.append((hl + r * math.cos(a), r * math.sin(a)))
        for i in range(19):                      # левый колпачок
            a = math.pi / 2 + math.pi * i / 18
            pts.append((-hl + r * math.cos(a), r * math.sin(a)))
        c, s = math.cos(ang), math.sin(ang)
        self.poly([(cx + X * c - Y * s, cy + X * s + Y * c) for X, Y in pts], w, closed=True)


# ──────────────────────────────────────────────────────────────────────────────
# Композитор
# ──────────────────────────────────────────────────────────────────────────────

class Board:
    def __init__(self, bg_hex: str):
        self.bg = hex2rgb(bg_hex)
        self.pens: list[Pen] = []

    def pen(self, color: str, alpha: float) -> Pen:
        p = Pen(color, alpha)
        self.pens.append(p)
        return p

    def render(self) -> Image.Image:
        base = np.zeros((H, W, 3), dtype=np.float32)
        base[:, :] = np.array(self.bg, dtype=np.float32)
        cm = center_mask()
        for pen in self.pens:
            small = pen.img.resize((W, H), Image.Resampling.BOX)
            cov = np.asarray(small, dtype=np.float32) / 255.0
            a = (cov * cm * pen.alpha)[:, :, None]
            base = base * (1.0 - a) + np.array(pen.color, dtype=np.float32)[None, None, :] * a
        return Image.fromarray(np.clip(base + 0.5, 0, 255).astype(np.uint8), "RGB")


# ──────────────────────────────────────────────────────────────────────────────
# Мотивы
# ──────────────────────────────────────────────────────────────────────────────

def petri(pen: Pen, cx, cy, r, rnd: random.Random, colonies=9, w=3.5):
    """Чашка Петри: круг + ободок крышки + колонии внутри."""
    pen.circle(cx, cy, r, w)
    pen.circle(cx, cy, r * 0.93, w * 0.62)
    pen.arc(cx, cy, r * 0.86, math.radians(200), math.radians(268), w * 0.55)
    for _ in range(colonies):
        a = rnd.uniform(0, 2 * math.pi)
        d = r * 0.80 * math.sqrt(rnd.uniform(0.02, 1.0))
        rr = rnd.uniform(r * 0.045, r * 0.115)
        x, y = cx + d * math.cos(a), cy + d * math.sin(a)
        pen.circle(x, y, rr, w * 0.6)
        if rnd.random() < 0.45:
            pen.disc(x, y, rr * 0.34)


def dna(pen: Pen, x0, y0, length, amp, period, ang, w=3.0, rung_step=None):
    """Двойная спираль: две синусоиды в противофазе + перемычки."""
    c, s = math.cos(ang), math.sin(ang)

    def tr(t, off):
        return (x0 + t * c - off * s, y0 + t * s + off * c)

    n = max(80, int(length / 4))
    for phase in (0.0, math.pi):
        pts = [tr(length * i / n, amp * math.sin(2 * math.pi * (length * i / n) / period + phase))
               for i in range(n + 1)]
        pen.poly(pts, w)
    step = rung_step or period / 9.0
    t = step / 2
    while t < length:
        o = amp * math.sin(2 * math.pi * t / period)
        if abs(o) < amp * 0.985:                 # у самых «шеек» перемычки не рисуем
            pen.poly([tr(t, o), tr(t, -o)], w * 0.62)
        t += step


def ecg_value(t: float) -> float:
    """Один кардиокомплекс P–QRS–T, t ∈ [0,1), значение в долях амплитуды R."""
    if 0.10 <= t < 0.21:                                   # P
        return 0.15 * math.sin(math.pi * (t - 0.10) / 0.11)
    if 0.285 <= t < 0.315:                                 # Q
        return -0.11 * math.sin(math.pi * (t - 0.285) / 0.03)
    if 0.315 <= t < 0.352:                                 # R
        return 1.00 * math.sin(math.pi * (t - 0.315) / 0.037)
    if 0.352 <= t < 0.392:                                 # S
        return -0.27 * math.sin(math.pi * (t - 0.352) / 0.040)
    if 0.392 <= t < 0.420:                                 # возврат к изолинии
        return -0.27 * (1 - (t - 0.392) / 0.028) * 0.35
    if 0.545 <= t < 0.735:                                 # T
        return 0.29 * math.sin(math.pi * (t - 0.545) / 0.190)
    return 0.0


def ecg(pen: Pen, x0, y, width, amp, beat, w=3.0, jitter=0.0, rnd=None):
    """Реалистичная лента ЭКГ: повторяющийся комплекс QRS."""
    pts = []
    n = int(width / 1.6)
    for i in range(n + 1):
        x = x0 + width * i / n
        tt = (x - x0) / beat
        k = int(tt)
        a = amp
        if jitter and rnd is not None:
            a *= 1.0 + jitter * math.sin(k * 1.7 + 0.6)
        pts.append((x, y - a * ecg_value(tt - k)))
    pen.poly(pts, w)


def rods(pen: Pen, cx, cy, rnd: random.Random, n=5, spread=140, L=(70, 130), w=3.0):
    for _ in range(n):
        x = cx + rnd.uniform(-spread, spread)
        y = cy + rnd.uniform(-spread * 0.7, spread * 0.7)
        ln = rnd.uniform(*L)
        pen.capsule(x, y, ln, ln * rnd.uniform(0.34, 0.45), rnd.uniform(0, math.pi), w)


def cocci(pen: Pen, cx, cy, rnd: random.Random, n=6, r=22, spread=90, w=3.0):
    """Сферические бактерии — гроздь/цепочка кокков."""
    a0 = rnd.uniform(0, math.pi)
    for i in range(n):
        a = a0 + i * rnd.uniform(0.7, 1.3)
        d = spread * (0.25 + 0.75 * i / max(1, n - 1))
        rr = r * rnd.uniform(0.75, 1.15)
        pen.circle(cx + d * math.cos(a), cy + d * math.sin(a) * 0.75, rr, w)


def microscope(pen: Pen, cx, cy_base, scale, w=3.0):
    """Силуэт светового микроскопа: штатив, тубусодержатель, столик, тубус, окуляр,
    объектив, осветитель. Локальные единицы: ширина 100, высота 110, ось Y вверх."""
    def T(p):
        return (cx + p[0] * scale, cy_base - p[1] * scale)

    def R(x0, y0, x1, y1, r, ww):
        a, b = T((x0, y1)), T((x1, y0))
        pen.rrect(a[0], a[1], b[0], b[1], r * scale, ww)

    R(-50, 0, 50, 16, 7, w)                                      # основание-штатив
    pen.poly([T(q) for q in [(27, 16), (35, 30), (38, 50), (35, 68), (28, 80)]], w)
    pen.poly([T(q) for q in [(13, 16), (21, 31), (24, 50), (21, 66), (16, 78)]], w * 0.8)
    R(-46, 36, 26, 46, 3, w)                                     # предметный столик
    pen.poly([T(q) for q in [(-36, 46), (-14, 46), (-14, 50), (-36, 50)]], w * 0.7, closed=True)
    R(-30, 70, 28, 90, 5, w)                                     # головка с тубусом
    pen.poly([T(q) for q in [(-30, 90), (-12, 90), (-24, 110), (-42, 110)]], w, closed=True)
    pen.poly([T(q) for q in [(-26, 70), (-8, 70), (-12, 52), (-22, 52)]], w * 0.85, closed=True)
    q = T((-10, 25))
    pen.ellipse(q[0], q[1], 12 * scale, 7 * scale, 0.0, w * 0.8)  # осветитель
    q = T((33, 44))
    pen.circle(q[0], q[1], 6 * scale, w * 0.8)                    # винт фокусировки


def chloroplast(pen: Pen, cx, cy, rx, ry, rot=0.0, w=3.0):
    """Хлоропласт: овал (двойная мембрана) + граны-тилакоиды + ламеллы."""
    pen.ellipse(cx, cy, rx, ry, rot, w)
    pen.ellipse(cx, cy, rx * 0.90, ry * 0.82, rot, w * 0.6)
    c, s = math.cos(rot), math.sin(rot)

    def T(X, Y):
        return (cx + X * c - Y * s, cy + X * s + Y * c)

    stacks = [(-0.52, 0.22), (-0.10, -0.26), (0.30, 0.24), (0.62, -0.18)]
    prev = None
    for fx, fy in stacks:
        X, Y = fx * rx, fy * ry
        half = rx * 0.115
        for k in range(-2, 3):                    # стопка тилакоидов
            yy = Y + k * ry * 0.11
            pen.poly([T(X - half, yy), T(X + half, yy)], w * 0.62)
        pen.poly([T(X - half, Y - ry * 0.24), T(X - half, Y + ry * 0.24)], w * 0.5)
        pen.poly([T(X + half, Y - ry * 0.24), T(X + half, Y + ry * 0.24)], w * 0.5)
        if prev is not None:                      # межгранная ламелла
            pen.poly([T(prev[0] + half, prev[1]), T(X - half, Y)], w * 0.5)
        prev = (X, Y)


def plant_cell(pen: Pen, x0, y0, x1, y1, rnd: random.Random, w=3.0):
    """Растительная клетка: стенка, мембрана, ядро, хлоропласты."""
    pen.rrect(x0, y0, x1, y1, 26, w)
    pen.rrect(x0 + 11, y0 + 11, x1 - 11, y1 - 11, 20, w * 0.6)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    nx = x0 + (x1 - x0) * 0.30
    ny = y0 + (y1 - y0) * 0.34
    nr = min(x1 - x0, y1 - y0) * 0.15
    pen.circle(nx, ny, nr, w * 0.8)
    pen.disc(nx, ny, nr * 0.30)
    for fx, fy, rot in ((0.70, 0.30, 0.5), (0.62, 0.70, -0.7), (0.32, 0.72, 0.2)):
        px, py = x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy
        chloroplast(pen, px, py, (x1 - x0) * 0.13, (y1 - y0) * 0.075, rot, w * 0.7)
    del cx, cy, rnd


def bacterial_cell(pen: Pen, cx, cy, r, w=3.0):
    """Контур бактериальной клетки: оболочка + нуклеоид + пили."""
    pen.circle(cx, cy, r, w)
    pen.circle(cx, cy, r * 0.86, w * 0.55)
    pen.arc(cx, cy, r * 0.45, 0.4, 3.6, w * 0.6)
    for i in range(7):
        a = 2 * math.pi * i / 7 + 0.3
        pen.poly([(cx + r * math.cos(a), cy + r * math.sin(a)),
                  (cx + (r + r * 0.22) * math.cos(a), cy + (r + r * 0.22) * math.sin(a))], w * 0.5)


def neural_net(pen_node: Pen, pen_edge: Pen, x0, y0, dx, dy, layers, r=11, w=2.5):
    """Нейросеть: слои узлов + рёбра между соседними слоями."""
    pos = []
    for li, n in enumerate(layers):
        col = []
        for i in range(n):
            col.append((x0 + li * dx, y0 + (i - (n - 1) / 2) * dy))
        pos.append(col)
    for a, b in zip(pos, pos[1:]):
        for p in a:
            for q in b:
                pen_edge.poly([p, q], w * 0.8)
    for col in pos:
        for p in col:
            pen_node.circle(p[0], p[1], r, w)
            pen_node.disc(p[0], p[1], r * 0.30)
    return pos


def biosignal(pen: Pen, x0, y, width, amp, rnd: random.Random, w=2.5, harmonics=5):
    """Гладкий биосигнал (ЭЭГ-подобный) — сумма гармоник."""
    ks = [(rnd.uniform(0.6, 1.4) * (i + 1), rnd.uniform(0, 2 * math.pi),
           1.0 / (i + 1) ** 1.15) for i in range(harmonics)]
    base = rnd.uniform(180, 320)
    pts = []
    n = int(width / 2.5)
    for i in range(n + 1):
        x = x0 + width * i / n
        v = sum(a * math.sin(2 * math.pi * f * (x - x0) / base + ph) for f, ph, a in ks)
        pts.append((x, y - amp * v / 1.9))
    pen.poly(pts, w)


def pixel_grid(pen_line: Pen, pen_fill: Pen, x0, y0, cols, rows, cell=26, gap=5,
               rnd: random.Random | None = None, fill_p=0.16, w=2.0):
    for r_ in range(rows):
        for c_ in range(cols):
            x = x0 + c_ * (cell + gap)
            y = y0 + r_ * (cell + gap)
            pen_line.rrect(x, y, x + cell, y + cell, 3, w)
            if rnd is not None and rnd.random() < fill_p:
                pen_fill.d.rectangle([(x + 4) * SS, (y + 4) * SS,
                                      (x + cell - 4) * SS, (y + cell - 4) * SS], fill=255)


def gaussian(pen: Pen, x0, base_y, width, amp, mu_f, sigma_f, w=3.0):
    n = int(width / 2.0)
    mu = x0 + width * mu_f
    sg = width * sigma_f
    pts = [(x0 + width * i / n,
            base_y - amp * math.exp(-((x0 + width * i / n - mu) ** 2) / (2 * sg * sg)))
           for i in range(n + 1)]
    pen.poly(pts, w)
    return mu, sg


def citrus_leaf(pen: Pen, cx, cy, length, rot=0.0, w=3.0, veins=5):
    """Лист цитрусовых: заострённый овал, средняя жилка, боковые жилки, крылатый черешок."""
    c, s = math.cos(rot), math.sin(rot)

    def T(X, Y):
        return (cx + X * c - Y * s, cy + X * s + Y * c)

    L = length
    half = L * 0.28
    up, dn = [], []
    n = 90
    for i in range(n + 1):
        t = i / n
        wdt = half * (math.sin(math.pi * t) ** 0.72) * (1.0 - 0.25 * t)
        up.append(T(-L / 2 + L * t, -wdt))
        dn.append(T(-L / 2 + L * t, wdt))
    pen.poly(up + dn[::-1], w, closed=True)
    pen.poly([T(-L / 2, 0), T(L / 2, 0)], w * 0.65)                 # средняя жилка
    for i in range(1, veins + 1):
        t = 0.12 + 0.72 * i / (veins + 1)
        wdt = half * (math.sin(math.pi * t) ** 0.72) * (1.0 - 0.25 * t)
        for sgn in (-1, 1):
            pen.poly([T(-L / 2 + L * t, 0),
                      T(-L / 2 + L * (t + 0.10), sgn * wdt * 0.60),
                      T(-L / 2 + L * (t + 0.16), sgn * wdt * 0.90)], w * 0.5)
    # крылатый черешок — характерный признак цитрусовых
    pen.poly([T(-L / 2, 0), T(-L / 2 - L * 0.13, 0)], w * 0.65)
    pen.ellipse(*T(-L / 2 - L * 0.075, 0), L * 0.075, L * 0.045, rot, w * 0.55)


def dot_ring(pen: Pen, cx, cy, r, n, dot=7, a0=0.0):
    for i in range(n):
        a = a0 + 2 * math.pi * i / n
        pen.disc(cx + r * math.cos(a), cy + r * math.sin(a), dot)


def rays(pen: Pen, cx, cy, r0, r1, a0, a1, n, w=2.5):
    for i in range(n):
        a = a0 + (a1 - a0) * i / max(1, n - 1)
        pen.poly([(cx + r0 * math.cos(a), cy + r0 * math.sin(a)),
                  (cx + r1 * math.cos(a), cy + r1 * math.sin(a))], w)


def soft_arcs(pen: Pen, cx, cy, radii, a0, a1, w=3.0):
    for r in radii:
        pen.arc(cx, cy, r, a0, a1, w)


def dot_field(pen: Pen, x0, y0, cols, rows, step, dot=5):
    for r_ in range(rows):
        for c_ in range(cols):
            pen.disc(x0 + c_ * step, y0 + r_ * step, dot)


# ──────────────────────────────────────────────────────────────────────────────
# Подложки
# ──────────────────────────────────────────────────────────────────────────────

def bg_a_title() -> Image.Image:
    """Слайд 1: ЭКГ + двойная спираль ДНК + контуры бактериальных клеток (зона A)."""
    rnd = random.Random(101)
    b = Board(A_BG)
    blue = b.pen(A_BLUE, 0.12)
    blue_s = b.pen(A_BLUE, 0.08)
    garnet = b.pen(A_GARNET, 0.11)

    # ЭКГ: широкая лента внизу и более мелкая вверху
    ecg(blue, -60, 1272, 2680, 118, 372, w=3.4, jitter=0.14, rnd=rnd)
    ecg(blue_s, -40, 1352, 2660, 64, 268, w=2.6, jitter=0.10, rnd=rnd)
    ecg(blue, -50, 158, 2680, 84, 300, w=3.0, jitter=0.12, rnd=rnd)

    # ДНК по левому и правому краю
    dna(blue, 148, -80, 1620, 66, 300, math.pi / 2, w=3.2)
    dna(blue, 2404, -60, 1580, 60, 276, math.pi / 2 + 0.05, w=3.2)

    # Бактериальные клетки по углам
    for cx, cy, r in ((236, 340, 96), (2330, 1128, 84), (352, 1108, 64), (2210, 296, 62)):
        bacterial_cell(garnet, cx, cy, r, w=3.0)
    rods(garnet, 470, 210, rnd, n=4, spread=210, L=(84, 132), w=2.8)
    rods(garnet, 2110, 1250, rnd, n=4, spread=230, L=(80, 128), w=2.8)
    cocci(garnet, 120, 780, rnd, n=5, r=24, spread=150, w=2.8)
    cocci(garnet, 2470, 640, rnd, n=5, r=22, spread=140, w=2.8)
    return b.render()


def _bp_geometry(b: Board, blue: Pen, garnet: Pen, blue_s: Pen, rnd: random.Random,
                 density=1.0):
    """Геометрия айдентики «Большой Перемены»: круги-точки, лучи, мягкие дуги."""
    soft_arcs(blue, -180, 1620, [520, 640, 760, 880, 1000, 1120], -1.30, 0.10, w=3.2)
    soft_arcs(garnet, 2760, -180, [520, 660, 800, 940, 1080], 1.72, 3.10, w=3.0)
    rays(blue_s, -120, -120, 380, 1350, 0.10, 1.36, int(11 * density), w=2.4)
    rays(garnet, 2740, 1600, 360, 1180, math.pi + 0.16, math.pi + 1.40, int(9 * density), w=2.4)
    dot_ring(garnet, 300, 300, 190, 20, dot=8)
    dot_ring(blue, 300, 300, 128, 14, dot=6, a0=0.2)
    dot_ring(blue, 2270, 1160, 210, 22, dot=8)
    dot_ring(garnet, 2270, 1160, 142, 15, dot=6, a0=0.25)
    blue.circle(300, 300, 258, w=3.0)
    garnet.circle(2270, 1160, 280, w=3.0)
    dot_field(blue_s, 2300, 120, 7, 4, 46, dot=6)
    dot_field(garnet, 80, 1200, 5, 4, 46, dot=6)
    for _ in range(int(14 * density)):
        x = rnd.choice([rnd.uniform(40, 520), rnd.uniform(2040, 2520)])
        y = rnd.uniform(60, 1380)
        blue_s.circle(x, y, rnd.uniform(16, 46), w=2.4)


def bg_a_plain() -> Image.Image:
    """Слайд 2: геометрия айдентики «Большой Перемены» (зона A)."""
    rnd = random.Random(202)
    b = Board(A_BG)
    blue = b.pen(A_BLUE, 0.12)
    blue_s = b.pen(A_BLUE, 0.075)
    garnet = b.pen(A_GARNET, 0.11)
    _bp_geometry(b, blue, garnet, blue_s, rnd, density=1.0)
    return b.render()


def bg_a_timeline() -> Image.Image:
    """Слайд 3: та же геометрия + сквозная «цепь достижений»."""
    rnd = random.Random(303)
    b = Board(A_BG)
    blue = b.pen(A_BLUE, 0.11)
    blue_s = b.pen(A_BLUE, 0.07)
    garnet = b.pen(A_GARNET, 0.12)
    _bp_geometry(b, blue, garnet, blue_s, rnd, density=0.6)

    # Цепь достижений: нижняя линия с узлами под тремя карточками
    y = 1258
    blue.poly([(0, y), (W, y)], 3.4)
    blue_s.dashed([(0, y + 26), (W, y + 26)], 2.2, dash=18, gap=16)
    for i, x in enumerate((470, 1280, 2090)):
        garnet.circle(x, y, 34, 3.6)
        garnet.circle(x, y, 19, 2.6)
        garnet.disc(x, y, 8)
        blue.poly([(x, y - 34), (x, y - 132)], 3.0)          # связь вверх к карточке
        blue_s.circle(x, y - 148, 14, 2.4)
        if i < 2:                                            # звенья между узлами
            for k in range(1, 5):
                xx = x + (810) * k / 5
                blue_s.circle(xx, y, 9, 2.2)
    # верхняя зеркальная линия-таймлайн
    blue_s.poly([(0, 176), (W, 176)], 2.6)
    for x in range(120, W, 240):
        blue_s.circle(x, 176, 11, 2.4)
    return b.render()


def bg_b_micro() -> Image.Image:
    """Слайд 4: чашки Петри, бактерии, ДНК, микроскоп (зона B, научный голубой)."""
    rnd = random.Random(404)
    b = Board(B_BG)
    blue = b.pen(B_BLUE, 0.12)
    blue_s = b.pen(B_BLUE, 0.08)
    dk = b.pen(B_BLUE_DK, 0.11)

    petri(blue, 150, 1290, 330, rnd, colonies=13, w=3.6)
    petri(blue, 2360, 250, 290, rnd, colonies=11, w=3.6)
    petri(blue_s, 640, 128, 180, rnd, colonies=7, w=3.0)
    petri(blue_s, 1930, 1372, 200, rnd, colonies=8, w=3.0)
    petri(blue, 2510, 800, 155, rnd, colonies=6, w=3.0)

    dna(blue, 2306, -70, 1560, 62, 288, math.pi / 2 - 0.06, w=3.2)
    dna(blue_s, 380, 1392, 1180, 44, 232, 0.0, w=2.8)          # горизонтальная спираль внизу

    microscope(dk, 195, 620, 3.3, w=3.2)                        # силуэт микроскопа слева

    rods(dk, 900, 1300, rnd, n=5, spread=230, L=(90, 140), w=3.0)
    rods(dk, 1500, 150, rnd, n=5, spread=250, L=(86, 136), w=3.0)
    cocci(dk, 480, 620, rnd, n=5, r=24, spread=160, w=2.8)
    cocci(dk, 2210, 700, rnd, n=6, r=22, spread=170, w=2.8)
    rods(blue_s, 2180, 1230, rnd, n=4, spread=150, L=(80, 120), w=2.6)
    return b.render()


def bg_c_micro() -> Image.Image:
    """Слайд 5: силуэты чашек Петри, микроскопов, палочковидных бактерий (зона C)."""
    rnd = random.Random(505)
    b = Board(C_BG)
    green = b.pen(C_GREEN, 0.12)
    green_s = b.pen(C_GREEN_DK, 0.08)
    navy = b.pen(C_NAVY, 0.10)

    petri(green, 210, 250, 300, rnd, colonies=12, w=3.6)
    petri(green, 2440, 1120, 300, rnd, colonies=12, w=3.6)
    petri(green_s, 1180, 1400, 210, rnd, colonies=8, w=3.0)
    petri(green_s, 1500, 60, 190, rnd, colonies=7, w=3.0)
    petri(green, 40, 880, 150, rnd, colonies=6, w=3.0)

    microscope(navy, 2350, 590, 3.2, w=3.2)
    microscope(navy, 180, 1400, 2.7, w=3.0)
    microscope(navy, 2400, 1420, 2.0, w=2.6)

    rods(green, 800, 170, rnd, n=6, spread=260, L=(90, 145), w=3.0)
    rods(green, 1900, 1300, rnd, n=6, spread=260, L=(88, 140), w=3.0)
    rods(green, 900, 1390, rnd, n=5, spread=230, L=(88, 138), w=3.0)
    rods(green_s, 90, 620, rnd, n=4, spread=140, L=(78, 120), w=2.8)
    cocci(navy, 1650, 1390, rnd, n=5, r=20, spread=140, w=2.6)
    return b.render()


def bg_c_cells() -> Image.Image:
    """Слайд 6: хлоропласты, растительные и бактериальные клетки + нейросети (зона C)."""
    rnd = random.Random(606)
    b = Board(C_BG)
    green = b.pen(C_GREEN, 0.12)
    green_s = b.pen(C_GREEN_DK, 0.075)
    navy = b.pen(C_NAVY, 0.10)
    navy_s = b.pen(C_NAVY, 0.065)

    plant_cell(green, -60, 60, 470, 430, rnd, w=3.4)
    plant_cell(green, 2130, 1030, 2640, 1410, rnd, w=3.4)
    plant_cell(green_s, 900, 1290, 1330, 1500, rnd, w=2.8)

    chloroplast(green, 300, 1180, 175, 96, 0.35, w=3.2)
    chloroplast(green, 2300, 330, 160, 88, -0.5, w=3.2)
    chloroplast(green_s, 1720, 1400, 150, 82, 0.15, w=2.8)
    chloroplast(green_s, 640, 90, 140, 76, -0.25, w=2.8)

    for cx, cy, r in ((110, 760, 78), (2470, 760, 70), (1010, 118, 58)):
        bacterial_cell(green_s, cx, cy, r, w=2.8)
    rods(green_s, 1450, 120, rnd, n=4, spread=190, L=(78, 118), w=2.6)

    neural_net(navy, navy_s, 1880, 200, 150, 96, [4, 5, 4], r=13, w=2.8)
    neural_net(navy, navy_s, 120, 1330, 165, 92, [3, 4, 3], r=12, w=2.8)
    neural_net(navy_s, navy_s, 2260, 900, 140, 88, [3, 3], r=11, w=2.4)
    return b.render()


def bg_c_neuro() -> Image.Image:
    """Слайды 7–8: графики биосигналов и нейросетей + цифровая пиксельная сетка (зона C)."""
    rnd = random.Random(707)
    b = Board(C_BG)
    green = b.pen(C_GREEN, 0.115)
    green_s = b.pen(C_GREEN_DK, 0.075)
    navy = b.pen(C_NAVY, 0.10)
    navy_s = b.pen(C_NAVY, 0.065)

    # ленты биосигналов сверху и снизу
    for y, amp, w_ in ((110, 58, 3.0), (196, 42, 2.6), (1258, 66, 3.2), (1350, 46, 2.6)):
        biosignal(green if amp > 50 else green_s, -40, y, 2640, amp, rnd, w=w_)
    ecg(green_s, -40, 1412, 2640, 50, 250, w=2.6)

    # нейросети слева и справа
    neural_net(navy, navy_s, 110, 720, 122, 104, [4, 5, 4], r=13, w=2.8)
    neural_net(navy, navy_s, 2200, 700, 122, 100, [3, 5, 4], r=13, w=2.8)

    # пиксельная IT-сетка по углам
    pixel_grid(navy_s, navy_s, 40, 40, 6, 4, 30, 6, rnd, 0.18, w=2.2)
    pixel_grid(navy_s, navy_s, 2200, 1230, 6, 4, 30, 6, rnd, 0.18, w=2.2)
    pixel_grid(green_s, green_s, 1050, 1330, 12, 2, 26, 6, rnd, 0.14, w=2.0)
    pixel_grid(green_s, green_s, 980, 30, 12, 2, 26, 6, rnd, 0.14, w=2.0)
    return b.render()


def bg_c_ecg() -> Image.Image:
    """Слайд 9: реалистичные линии ЭКГ разной амплитуды (зона C)."""
    rnd = random.Random(909)
    b = Board(C_BG)
    green = b.pen(C_GREEN, 0.12)
    green_s = b.pen(C_GREEN_DK, 0.08)
    navy = b.pen(C_NAVY, 0.095)
    navy_s = b.pen(C_NAVY, 0.06)

    # миллиметровая сетка кардиоленты — только по краям (центр гасится маской)
    for x in range(0, W + 1, 64):
        navy_s.poly([(x, 0), (x, H)], 1.8)
    for y in range(0, H + 1, 64):
        navy_s.poly([(0, y), (W, y)], 1.8)

    ecg(green, -60, 1240, 2680, 132, 400, w=3.6, jitter=0.16, rnd=rnd)
    ecg(navy, -50, 1372, 2660, 76, 262, w=2.8, jitter=0.12, rnd=rnd)
    ecg(green, -60, 150, 2680, 104, 336, w=3.2, jitter=0.14, rnd=rnd)
    ecg(green_s, -40, 262, 2640, 58, 220, w=2.6, jitter=0.10, rnd=rnd)
    ecg(navy, -40, 700, 700, 118, 360, w=3.0, jitter=0.15, rnd=rnd)     # слева, у самого края
    ecg(navy, 1860, 760, 760, 118, 360, w=3.0, jitter=0.15, rnd=rnd)    # справа
    return b.render()


def bg_c_split() -> Image.Image:
    """Слайд 10: слева листья цитрусовых, справа кривые Гаусса + пиксельная сетка (зона C)."""
    rnd = random.Random(1010)
    b = Board(C_BG)
    green = b.pen(C_GREEN, 0.12)
    green_s = b.pen(C_GREEN_DK, 0.08)
    navy = b.pen(C_NAVY, 0.10)
    navy_s = b.pen(C_NAVY, 0.065)

    # ── левая половина: цитрусовые листья
    citrus_leaf(green, 200, 300, 520, rot=-0.55, w=3.2)
    citrus_leaf(green, 330, 1160, 560, rot=0.42, w=3.2)
    citrus_leaf(green_s, 60, 760, 420, rot=1.15, w=2.8)
    citrus_leaf(green_s, 760, 110, 400, rot=-0.20, w=2.8)
    citrus_leaf(green_s, 830, 1360, 430, rot=0.25, w=2.8)
    citrus_leaf(green, 520, 640, 300, rot=-1.0, w=2.6)
    # ветвь, связывающая листья
    green_s.poly([(0, 1440), (180, 1230), (330, 1050), (430, 800), (470, 520), (420, 240)], 3.0)

    # ── правая половина: кривые Гаусса
    base_y = 1352
    for mu, sg, amp, pen, w_ in ((0.30, 0.085, 250, navy, 3.4),
                                 (0.52, 0.125, 205, green, 3.2),
                                 (0.74, 0.100, 160, navy_s, 3.0)):
        gaussian(pen, 1560, base_y, 1060, amp, mu, sg, w=w_)
    navy.poly([(1520, base_y), (2620, base_y)], 3.0)                       # ось X
    navy_s.poly([(1560, base_y + 20), (1560, base_y - 300)], 2.4)          # ось Y
    for k in range(1, 9):                                                   # засечки
        x = 1560 + 1060 * k / 9
        navy_s.poly([(x, base_y), (x, base_y + 14)], 2.2)
    base_y2 = 300
    for mu, sg, amp, pen in ((0.36, 0.10, 190, navy_s), (0.62, 0.14, 150, green_s)):
        gaussian(pen, 1620, base_y2, 1000, amp, mu, sg, w=2.8)
    navy_s.poly([(1600, base_y2), (2620, base_y2)], 2.4)

    # пиксельная IT-сетка справа
    pixel_grid(navy_s, navy_s, 2280, 560, 5, 7, 28, 6, rnd, 0.18, w=2.2)
    pixel_grid(navy_s, navy_s, 1700, 30, 8, 2, 26, 6, rnd, 0.16, w=2.0)

    # мягкий раздел половин — только вне текстовой зоны
    navy_s.dashed([(1280, 0), (1280, 250)], 2.2, dash=16, gap=18)
    navy_s.dashed([(1280, 1190), (1280, 1440)], 2.2, dash=16, gap=18)
    return b.render()


def bg_c_final() -> Image.Image:
    """Слайд 11: спокойная финальная подложка (зона C)."""
    rnd = random.Random(1111)
    b = Board(C_BG)
    green = b.pen(C_GREEN, 0.085)
    green_s = b.pen(C_GREEN_DK, 0.06)
    navy = b.pen(C_NAVY, 0.075)
    navy_s = b.pen(C_NAVY, 0.06)

    soft_arcs(green, -240, 1700, [560, 760, 960, 1160, 1360], -1.32, 0.06, w=3.0)
    soft_arcs(green_s, 2820, -260, [560, 780, 1000, 1220], 1.74, 3.10, w=2.8)

    chloroplast(green_s, 250, 240, 165, 90, -0.28, w=2.8)
    bacterial_cell(green_s, 2340, 1230, 82, w=2.6)
    plant_cell(green_s, 2160, 90, 2560, 380, rnd, w=2.6)

    nodes = neural_net(navy, navy_s, 190, 1290, 190, 110, [3, 3, 2], r=12, w=2.6)
    del nodes
    biosignal(navy_s, -40, 1408, 2640, 34, rnd, w=2.4, harmonics=4)
    biosignal(green_s, -40, 96, 2640, 30, rnd, w=2.4, harmonics=4)
    dot_ring(green_s, 2400, 760, 150, 16, dot=6)
    dot_ring(green_s, 2400, 760, 96, 11, dot=5, a0=0.3)
    return b.render()


BACKGROUNDS = [
    ("bg_a_title.png", bg_a_title, "зона A · слайд 1 · ЭКГ + ДНК + бактериальные клетки"),
    ("bg_a_plain.png", bg_a_plain, "зона A · слайд 2 · геометрия «Большой Перемены»"),
    ("bg_a_timeline.png", bg_a_timeline, "зона A · слайд 3 · геометрия + цепь достижений"),
    ("bg_b_micro.png", bg_b_micro, "зона B · слайд 4 · чашки Петри, бактерии, ДНК, микроскоп"),
    ("bg_c_micro.png", bg_c_micro, "зона C · слайд 5 · чашки Петри, микроскопы, палочки"),
    ("bg_c_cells.png", bg_c_cells, "зона C · слайд 6 · хлоропласты, клетки + нейросети"),
    ("bg_c_neuro.png", bg_c_neuro, "зона C · слайды 7–8 · биосигналы, нейросети, пиксель-сетка"),
    ("bg_c_ecg.png", bg_c_ecg, "зона C · слайд 9 · линии ЭКГ разной амплитуды"),
    ("bg_c_split.png", bg_c_split, "зона C · слайд 10 · листья цитрусовых | кривые Гаусса"),
    ("bg_c_final.png", bg_c_final, "зона C · слайд 11 · спокойный финал"),
]


# ──────────────────────────────────────────────────────────────────────────────
# QA: контактный лист и проба текста
# ──────────────────────────────────────────────────────────────────────────────

def font(name: str, px: int):
    path = os.path.join(FONT_DIR, f"Montserrat-{name}.ttf")
    try:
        return ImageFont.truetype(path, px)
    except OSError:
        return ImageFont.load_default()


def contact_sheet(paths):
    cols, rows = 2, 5
    tw, th = 760, 428
    pad, cap = 22, 30
    sheet = Image.new("RGB", (cols * (tw + pad) + pad, rows * (th + pad + cap) + pad), (250, 250, 250))
    d = ImageDraw.Draw(sheet)
    f = font("SemiBold", 20)
    for i, p in enumerate(paths):
        r_, c_ = divmod(i, cols)
        x = pad + c_ * (tw + pad)
        y = pad + r_ * (th + pad + cap)
        im = Image.open(p).resize((tw, th), Image.Resampling.LANCZOS)
        sheet.paste(im, (x, y))
        d.rectangle([x, y, x + tw, y + th], outline=(190, 190, 190), width=1)
        d.text((x + 2, y + th + 5), os.path.basename(p), fill=(30, 30, 30), font=f)
    out = os.path.join(QA_DIR, "contact_sheet.png")
    sheet.save(out)
    return out


PT = W / 13.333 / 72.0          # пикселей в одном пункте при ширине слайда 2560


def text_sample(path, out_name, title_color, body_color, plate=None):
    """Подложка + образец текста: заголовок 40 pt и абзац 18 pt в масштабе слайда."""
    im = Image.open(path).convert("RGB")
    d = ImageDraw.Draw(im, "RGBA")
    M = int(0.47 * W / 13.333)
    if plate:
        d.rounded_rectangle([M, 700, W - M, 1180], 24, fill=plate)
    f_title = font("ExtraBold", int(round(40 * PT)))
    f_body = font("Medium", int(round(18 * PT)))
    f_sub = font("Bold", int(round(26 * PT)))
    d.text((M, 150), "От «Большой Перемены» к нейролаборатории", font=f_title, fill=title_color)
    d.text((M, 300), "Эффективные практики в решении метапредметных задач", font=f_sub,
           fill=title_color)
    body = ("Осенью 2022 года школа вступила в исследовательскую программу ИХБФМ СО РАН\n"
            "«Всероссийский атлас почвенных микроорганизмов». Работа переведена в плоскость\n"
            "доказательной науки: с 2022 по 2024 год более 30 учеников стали научными\n"
            "волонтёрами, гражданскими учёными и соавторами Атласа.")
    d.multiline_text((M, 420), body, font=f_body, fill=body_color, spacing=int(14 * PT))
    if plate:
        d.text((M + 40, 740), "Проверка белого текста на плашке", font=f_sub, fill=(255, 255, 255))
        d.multiline_text((M + 40, 830), body, font=f_body, fill=(255, 255, 255),
                         spacing=int(14 * PT))
    # мелкий текст у самого края — там графика на полной силе
    d.text((M, 1330), "Подпись под фото 14 pt у нижнего края, где подложка максимально плотная",
           font=font("Medium", int(round(14 * PT))), fill=body_color)
    out = os.path.join(QA_DIR, out_name)
    im.save(out)
    return out


def center_report(path):
    """Числовая проверка: максимальное отклонение от фона в центральной зоне."""
    a = np.asarray(Image.open(path).convert("RGB"), dtype=np.int16)
    bg = a[2, 2].astype(np.int16)
    x0, x1 = int(W * 0.20), int(W * 0.80)          # 60 % ширины
    y0, y1 = int(H * 0.225), int(H * 0.775)        # 55 % высоты
    c = a[y0:y1, x0:x1]
    dev = np.abs(c - bg[None, None, :]).max(axis=2)
    full = np.abs(a - bg[None, None, :]).max(axis=2)
    return dict(center_max=int(dev.max()), center_mean=float(dev.mean()),
                frame_max=int(full.max()), frame_mean=float(full.mean()),
                ink_px=float((full > 3).mean() * 100))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    qa = "--qa" in sys.argv
    if qa:
        os.makedirs(QA_DIR, exist_ok=True)
    paths = []
    for name, fn, desc in BACKGROUNDS:
        img = fn()
        p = os.path.join(OUT_DIR, name)
        img.save(p, optimize=True)
        paths.append(p)
        r = center_report(p)
        print(f"{name:18s} {desc}\n{'':18s} центр: max Δ={r['center_max']:3d} "
              f"средн Δ={r['center_mean']:.2f} | кадр: max Δ={r['frame_max']:3d} "
              f"покрытие={r['ink_px']:.1f}%")
    if qa:
        print("контактный лист:", contact_sheet(paths))
        print(text_sample(os.path.join(OUT_DIR, "bg_a_title.png"), "sample_a_title.png",
                          hex2rgb(A_BLUE), (26, 26, 26), plate=hex2rgb(A_BLUE) + (255,)))
        print(text_sample(os.path.join(OUT_DIR, "bg_c_neuro.png"), "sample_c_neuro.png",
                          hex2rgb(C_NAVY), (20, 20, 20), plate=hex2rgb(C_NAVY) + (255,)))
        print(text_sample(os.path.join(OUT_DIR, "bg_b_micro.png"), "sample_b_micro.png",
                          hex2rgb(B_BLUE_DK), (24, 24, 24), plate=hex2rgb(B_BLUE_DK) + (255,)))


if __name__ == "__main__":
    main()
