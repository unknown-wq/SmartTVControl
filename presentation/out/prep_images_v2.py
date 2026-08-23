#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
prep_images_v2.py — подготовка растровых изображений для пересборки презентации
«От „Большой Перемены“ к нейролаборатории» по спецификации SPEC_v2.md (§3).

Зона ответственности скрипта: ТОЛЬКО растровая подготовка исходников.
Вёрстка (build_deck.js) и фоновые подложки (make_backgrounds.py) — не трогаются.

Запуск (идемпотентно, с нуля):
    python3 out/prep_images_v2.py

Результат:
    out/prepared/v2/*.jpg|*.png   — готовые к вёрстке файлы
    out/prepared/v2/sizes.json    — {имя_файла: [ширина, высота]} для всех подготовленных файлов

Скругление углов НЕ применяется (это делает вёрстка); пропорции зафиксированы и
записаны в sizes.json, чтобы вёрстка не искажала кадры.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

Image.MAX_IMAGE_PIXELS = None

# ---------------------------------------------------------------- пути ----

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                      # …/project
ASSETS = os.path.join(ROOT, "assets")
V2 = os.path.join(ASSETS, "v2_remarks")
DIPL = os.path.join(ASSETS, "diplomy_ucheniki")
GRAM = os.path.join(ASSETS, "gramoty_nastavnika")
PREP = os.path.join(ROOT, "out", "prepared")
S14 = os.path.join(PREP, "slides1-4")
S56 = os.path.join(PREP, "slides5-6")
OUT = os.path.join(PREP, "v2")

MINT_BG = (0xEA, 0xF6, 0xE4)      # зона C — фон, на котором лежат круглые вставки

_tmpdir: str | None = None


def tmpdir() -> str:
    global _tmpdir
    if _tmpdir is None:
        _tmpdir = tempfile.mkdtemp(prefix="prep_v2_")
    return _tmpdir


# ------------------------------------------------------- базовые утилиты ----

def load(path: str) -> Image.Image:
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    return im.convert("RGB")


def gamma(im: Image.Image, g: float) -> Image.Image:
    """g < 1 — светлее, g > 1 — темнее."""
    if abs(g - 1.0) < 1e-3:
        return im
    lut = [min(255, int(round(255.0 * ((i / 255.0) ** g)))) for i in range(256)]
    return im.point(lut * len(im.getbands()))


def tune(im, g=1.0, auto=None, contrast=1.0, color=1.0, bright=1.0, sharpen=0.0):
    """Единая «проявка» кадра: гамма → авто-уровни → контраст/насыщенность → резкость."""
    im = gamma(im, g)
    if auto is not None:
        im = ImageOps.autocontrast(im, cutoff=auto, preserve_tone=True)
    if abs(bright - 1.0) > 1e-3:
        im = ImageEnhance.Brightness(im).enhance(bright)
    if abs(contrast - 1.0) > 1e-3:
        im = ImageEnhance.Contrast(im).enhance(contrast)
    if abs(color - 1.0) > 1e-3:
        im = ImageEnhance.Color(im).enhance(color)
    if sharpen > 0:
        im = im.filter(ImageFilter.UnsharpMask(radius=2.0, percent=int(90 * sharpen), threshold=3))
    return im


def fit(im: Image.Image, w: int, h: int, sharpen_on_upscale: bool = True) -> Image.Image:
    """Точный ресайз в w×h (кадр уже обрезан ровно в нужной пропорции)."""
    up = w > im.width
    out = im.resize((w, h), Image.LANCZOS)
    if up and sharpen_on_upscale:
        out = out.filter(ImageFilter.UnsharpMask(radius=1.6, percent=70, threshold=2))
    return out


def crop_ratio(im, ratio, anchor_x=0.5, anchor_y=0.5, box=None):
    """Кадрирование в заданную пропорцию (ratio = ширина/высота).
    box — необязательная предварительная обрезка (l, t, r, b)."""
    if box:
        im = im.crop(box)
    w, h = im.size
    if w / h > ratio:            # слишком широкий — режем по ширине
        nw, nh = int(round(h * ratio)), h
    else:                        # слишком высокий — режем по высоте
        nw, nh = w, int(round(w / ratio))
    left = int(round((w - nw) * anchor_x))
    top = int(round((h - nh) * anchor_y))
    return im.crop((left, top, left + nw, top + nh))


def save_jpg(im: Image.Image, name: str, quality: int = 92) -> None:
    im.convert("RGB").save(os.path.join(OUT, name), "JPEG", quality=quality,
                           subsampling=1, optimize=True, progressive=True)
    print(f"  ✓ {name:38s} {im.width}×{im.height}")


def save_png(im: Image.Image, name: str) -> None:
    im.save(os.path.join(OUT, name), "PNG", optimize=True)
    print(f"  ✓ {name:38s} {im.width}×{im.height}")


# ------------------------------------------------------- работа с PDF ----

def pdf_page(pdf_path: str, page: int, dpi: int = 120) -> Image.Image:
    """Конвертация страницы PDF в изображение (pdftoppm -png -r dpi -f p -l p)."""
    stem = os.path.join(tmpdir(), f"pg_{abs(hash((pdf_path, page, dpi))) % 10**8}")
    subprocess.run(["pdftoppm", "-png", "-r", str(dpi), "-f", str(page), "-l", str(page),
                    pdf_path, stem], check=True)
    for suf in (f"-{page}.png", f"-{page:02d}.png", f"-{page:03d}.png", ".png"):
        if os.path.exists(stem + suf):
            return load(stem + suf)
    cands = [f for f in os.listdir(tmpdir()) if f.startswith(os.path.basename(stem))]
    if cands:
        return load(os.path.join(tmpdir(), sorted(cands)[0]))
    raise FileNotFoundError(f"pdftoppm не создал страницу {page} из {pdf_path}")


# --------------------------------------------- обрезка полей сканов ----

def trim_white_padding(im: Image.Image, thr: int = 250) -> Image.Image:
    """Срезает служебные абсолютно белые поля (padding конвертера/сканера)."""
    g = im.convert("L")
    px = g.load()
    w, h = g.size

    def row_white(y):
        step = max(1, w // 200)
        return all(px[x, y] >= thr for x in range(0, w, step))

    def col_white(x):
        step = max(1, h // 200)
        return all(px[x, y] >= thr for y in range(0, h, step))

    top, bottom, left, right = 0, h - 1, 0, w - 1
    while top < bottom and row_white(top):
        top += 1
    while bottom > top and row_white(bottom):
        bottom -= 1
    while left < right and col_white(left):
        left += 1
    while right > left and col_white(right):
        right -= 1
    return im.crop((left, top, right + 1, bottom + 1))


def trim_doc(im: Image.Image, pad: float = 0.004, min_area: float = 0.25) -> Image.Image:
    """Обрезка полей скана документа: ищем «бумагу» по насыщенности/тону
    (гильош, рамки, печати) и обрезаем окружающий белый/серый фон сканера."""
    im = trim_white_padding(im)
    small = im.copy()
    small.thumbnail((480, 480), Image.LANCZOS)
    hsv = small.convert("HSV")
    s = hsv.getchannel("S").point(lambda v: 255 if v > 26 else 0)
    l = small.convert("L").point(lambda v: 255 if v < 165 else 0)
    mask = ImageChops_lighter(s, l)
    mask = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(3))
    bbox = mask.getbbox()
    if not bbox:
        return im
    kx, ky = im.width / small.width, im.height / small.height
    l_, t_, r_, b_ = bbox
    if (r_ - l_) * (b_ - t_) < min_area * small.width * small.height:
        return im
    px, py = pad * im.width, pad * im.height
    box = (max(0, int(l_ * kx - px)), max(0, int(t_ * ky - py)),
           min(im.width, int(r_ * kx + px)), min(im.height, int(b_ * ky + py)))
    return im.crop(box)


def ImageChops_lighter(a: Image.Image, b: Image.Image) -> Image.Image:
    from PIL import ImageChops
    return ImageChops.lighter(a, b)


# ------------------------------------------------- карточки и коллажи ----

def card(im: Image.Image, height: int, border: int = 12,
         border_color=(255, 255, 255)) -> Image.Image:
    """Документ с белой окантовкой, приведённый к заданной высоте."""
    w = max(1, int(round(im.width * height / im.height)))
    body = im.convert("RGB").resize((w, height), Image.LANCZOS)
    out = Image.new("RGBA", (w + 2 * border, height + 2 * border), border_color + (255,))
    out.paste(body, (border, border))
    return out


def with_shadow(rgba: Image.Image, angle: float, offset=(16, 20), blur=16,
                opacity=120) -> Image.Image:
    """Поворот карточки + мягкая тень. Возвращает RGBA с прозрачным фоном."""
    rot = rgba.rotate(angle, resample=Image.BICUBIC, expand=True)
    pad = blur * 3 + max(abs(offset[0]), abs(offset[1]))
    canvas = Image.new("RGBA", (rot.width + 2 * pad, rot.height + 2 * pad), (0, 0, 0, 0))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    silhouette = Image.new("RGBA", rot.size, (0, 0, 0, opacity))
    silhouette.putalpha(rot.getchannel("A").point(lambda v: int(v * opacity / 255)))
    shadow.paste(silhouette, (pad + offset[0], pad + offset[1]), silhouette)
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(rot, (pad, pad))
    return canvas


def place(canvas: Image.Image, piece: Image.Image, cx: int, cy: int) -> None:
    canvas.alpha_composite(piece, (int(cx - piece.width / 2), int(cy - piece.height / 2)))


def set_alpha(rgba: Image.Image, factor: float) -> Image.Image:
    a = rgba.getchannel("A").point(lambda v: int(round(v * factor)))
    out = rgba.copy()
    out.putalpha(a)
    return out


def crop_alpha(rgba: Image.Image) -> Image.Image:
    bb = rgba.getbbox()
    return rgba.crop(bb) if bb else rgba


def circle_thumb(src_path: str, diameter: int = 420, ring: int = 10) -> Image.Image:
    """Строго круглая миниатюра микроскопии с прозрачным фоном и белым кольцом.
    Квадрат берётся по светлому полю микроскопа (тёмная виньетка отбрасывается)."""
    im = load(src_path)
    g = im.convert("L")
    small = g.resize((240, int(240 * g.height / g.width)), Image.LANCZOS)
    mask = small.point(lambda v: 255 if v > 70 else 0)
    mask = mask.filter(ImageFilter.MedianFilter(5))
    bb = mask.getbbox()
    if bb:
        kx, ky = im.width / small.width, im.height / small.height
        l, t, r, b = bb[0] * kx, bb[1] * ky, bb[2] * kx, bb[3] * ky
    else:
        l, t, r, b = 0, 0, im.width, im.height
    cx, cy = (l + r) / 2, (t + b) / 2
    side = min(r - l, b - t) * 0.90     # уходим внутрь поля зрения, тёмная виньетка не попадает
    side = min(side, im.width, im.height)
    cx = min(max(cx, side / 2), im.width - side / 2)
    cy = min(max(cy, side / 2), im.height - side / 2)
    sq = im.crop((int(cx - side / 2), int(cy - side / 2),
                  int(cx + side / 2), int(cy + side / 2)))
    sq = tune(sq, auto=(0.4, 0.2), contrast=1.05, color=1.05)

    ss = 4  # супер-сэмплинг для гладкого края
    big = sq.resize((diameter * ss, diameter * ss), Image.LANCZOS).convert("RGBA")
    mask_big = Image.new("L", big.size, 0)
    ImageDraw.Draw(mask_big).ellipse((0, 0, big.width - 1, big.height - 1), fill=255)
    if ring > 0:
        ImageDraw.Draw(big).ellipse(
            (ring * ss // 2, ring * ss // 2, big.width - 1 - ring * ss // 2,
             big.height - 1 - ring * ss // 2),
            outline=(255, 255, 255, 255), width=ring * ss)
    big.putalpha(mask_big)
    return big.resize((diameter, diameter), Image.LANCZOS)


def blur_pad(content: Image.Image, ratio: float, out_w: int, out_h: int,
             top_share: float = 0.45) -> Image.Image:
    """Кадр, который физически не влезает в вертикальную пропорцию, ставится
    на размытую подложку из этого же снимка (поля сверху/снизу)."""
    bg = ImageOps.fit(content, (out_w, out_h), Image.LANCZOS, centering=(0.5, 0.5))
    bg = bg.filter(ImageFilter.GaussianBlur(out_w // 26))
    bg = ImageEnhance.Brightness(bg).enhance(0.82)
    bg = ImageEnhance.Color(bg).enhance(0.75)
    cw = out_w
    ch = int(round(content.height * out_w / content.width))
    body = content.resize((cw, ch), Image.LANCZOS)
    if cw > content.width:
        body = body.filter(ImageFilter.UnsharpMask(radius=1.6, percent=70, threshold=2))
    y = int(round((out_h - ch) * top_share))
    bg.paste(body, (0, y))
    d = ImageDraw.Draw(bg)
    d.line([(0, y - 1), (out_w, y - 1)], fill=(255, 255, 255), width=2)
    d.line([(0, y + ch), (out_w, y + ch)], fill=(255, 255, 255), width=2)
    return bg


# =====================================================================
#                              ЗАДАЧИ
# =====================================================================

def slide4() -> None:
    """Слайд 4, зона B: четыре кадра «Атласа» в единой сетке 4:3 (1200×900)."""
    print("Слайд 4 — «Наука в школе: исследования учеников» (4:3, 1200×900)")
    W, H = 1200, 900

    # 1. Стартовый набор «Охотники за микробами» и образцы почв (566×505, тускловат)
    im = load(os.path.join(V2, "s4_starter_kit.jpeg"))
    im = im.crop((0, 32, 566, 456))                       # 566×424 ≈ 4:3
    im = crop_ratio(im, 4 / 3)
    im = tune(im, g=0.94, auto=(0.6, 0.4), contrast=1.10, color=1.14, sharpen=1.0)
    save_jpg(fit(im, W, H), "s4_starter_kit.jpg")

    # 2. Дипломы наставника и соавторов «Атласа», 2022 (1429×804)
    im = load(os.path.join(V2, "s4_diplomy_atlas.jpeg"))
    base = tune(im, g=0.95, auto=(0.5, 0.3), contrast=1.06, color=1.05)
    sq = crop_ratio(base, 4 / 3, anchor_x=0.47, anchor_y=0.52)
    save_jpg(fit(sq, W, H), "s4_diplomy_atlas.jpg")
    # запасной широкий вариант 3:2, если вёрстке нужен горизонтальный слот
    wide = crop_ratio(base, 3 / 2, anchor_x=0.5, anchor_y=0.5)
    save_jpg(fit(wide, 1500, 1000), "s4_diplomy_atlas_wide.jpg")

    # 3. Награждение гражданских учёных, 2024 (1082×891)
    im = load(os.path.join(V2, "s4_nagrazhdenie_2024.jpeg"))
    im = im.crop((0, 10, 1082, 880))
    im = crop_ratio(im, 4 / 3, anchor_y=0.42)             # головы не режем
    im = tune(im, g=0.95, auto=(0.5, 0.25), contrast=1.05, color=1.06)
    save_jpg(fit(im, W, H), "s4_nagrazhdenie_2024.jpg")

    # 4. Штаммы почвенных бактерий перед отправкой в ИХБФМ СО РАН, 2023 (1053×898)
    im = load(os.path.join(V2, "s4_shtammy_ihbfm.jpeg"))
    im = im.crop((0, 20, 1053, 898))
    im = crop_ratio(im, 4 / 3, anchor_y=0.55)
    im = tune(im, g=0.92, auto=(0.6, 0.3), contrast=1.06, color=1.05, sharpen=0.6)
    save_jpg(fit(im, W, H), "s4_shtammy_ihbfm.jpg")


def slide5_portraits() -> None:
    """Слайд 5, зона C: четыре вертикальные карточки-портрета 3:4 (900×1200)."""
    print("Слайд 5 — портреты участниц (3:4, 900×1200)")
    W, H = 900, 1200

    # Алёна Жукова — на кадре две девушки, Алёна СЛЕВА
    im = load(os.path.join(V2, "s5_zhukova_lab.png"))
    im = im.crop((8, 20, 268, 367))                        # 260×347 ≈ 3:4, левая фигура
    im = crop_ratio(im, 3 / 4)
    im = tune(im, g=0.95, auto=(0.5, 0.3), contrast=1.06, color=1.05)
    save_jpg(fit(im, W, H), "s5_zhukova_portrait.jpg")

    # Ульяна Коляскина — кадр тёмный, вытягиваем яркость
    im = load(os.path.join(V2, "s5_kolyaskina.jpg"))
    im = im.crop((118, 0, 455, 450))                       # 337×450 = 3:4
    im = crop_ratio(im, 3 / 4)
    im = tune(im, g=0.70, auto=(1.2, 0.0), contrast=1.12, color=1.12, sharpen=0.8)
    save_jpg(fit(im, W, H), "s5_kolyaskina_portrait.jpg")

    # Софья Петрова — нужен и человек, и полигон с роботом: широкий кадр
    # физически не влезает в 3:4, ставим его на размытую подложку из того же снимка.
    im = load(os.path.join(V2, "s5_petrova_agronti.jpeg"))
    im = im.crop((118, 0, 700, 533))                       # девочка + поле + робот
    im = tune(im, g=0.88, auto=(0.8, 0.2), contrast=1.06, color=1.08, sharpen=0.5)
    save_jpg(blur_pad(im, 3 / 4, W, H, top_share=0.42), "s5_petrova_portrait.jpg")

    # Вероника Елизарова с наставником — обе фигуры обязательны
    im = load(os.path.join(V2, "s5_elizarova_s_nastavnikom.jpeg"))
    im = im.crop((300, 790, 1065, 1810))                   # 765×1020, лишний потолок/пол убран
    im = crop_ratio(im, 3 / 4, anchor_y=0.5)
    im = tune(im, g=0.94, auto=(0.5, 0.2), contrast=1.05, color=1.04)
    save_jpg(fit(im, W, H), "s5_elizarova_portrait.jpg")


def slide5_inserts() -> None:
    """Слайд 5: круглые миниатюры микроскопии + прямоугольная вставка."""
    print("Слайд 5 — вставки в карточки")
    save_png(circle_thumb(os.path.join(S14, "s4_micro_azotobacter.jpg"), 420),
             "s5_micro_azotobacter_circle.png")
    save_png(circle_thumb(os.path.join(S14, "s4_micro_streptomyces.jpg"), 420),
             "s5_micro_streptomyces_circle.png")
    # варианты со сплавленным фоном зоны C — если вёрстке проще без альфы
    for name in ("s5_micro_azotobacter_circle", "s5_micro_streptomyces_circle"):
        rgba = Image.open(os.path.join(OUT, name + ".png")).convert("RGBA")
        flat = Image.new("RGB", rgba.size, MINT_BG)
        flat.paste(rgba, (0, 0), rgba)
        save_jpg(flat, name.replace("_circle", "_circle_mint") + ".jpg", quality=94)

    im = load(os.path.join(S14, "s4_koljaskina_work.jpg"))  # культивирование штаммов
    im = im.crop((25, 0, 595, 760))                         # 570×760 = 3:4, голова не срезана
    im = crop_ratio(im, 3 / 4)
    im = tune(im, g=0.86, auto=(1.0, 0.1), contrast=1.08, color=1.10, sharpen=0.5)
    save_jpg(fit(im, 480, 640), "s5_kultivirovanie_insert.jpg")


def slide6_awards() -> None:
    """Слайд 6: четвёртая Благодарность (2020) из PDF, коллаж-стопка, «Артек»."""
    print("Слайд 6 — наградной блок")

    # 4-я страница PDF = Благодарность 2020 года
    g2020 = pdf_page(os.path.join(GRAM, "Благодарности_БП_наставник_37стр.pdf"), 4, 120)
    g2020 = trim_white_padding(g2020)
    w, h = g2020.size
    g2020 = g2020.crop((int(w * 0.013), int(h * 0.010),
                        int(w * 0.987), int(h * 0.992)))     # серые поля сканера
    g2020 = tune(g2020, auto=(0.3, 0.1), contrast=1.04)
    g2020 = fit(g2020, 960, int(round(960 * g2020.height / g2020.width)))
    save_png(g2020.convert("RGB"), "s6_gramota_kirienko_2020.png")

    # Коллаж: 2024 крупно спереди, за ней веером 2021, 2022, 2020
    front = load(os.path.join(S56, "gramota_kirienko_2024.png"))
    backs = [
        (load(os.path.join(S56, "gramota_kirienko_2021.png")), 17.0, (640, 1030)),
        (load(os.path.join(S56, "gramota_kirienko_2022.png")), 1.5, (1160, 640)),
        (Image.open(os.path.join(OUT, "s6_gramota_kirienko_2020.png")).convert("RGB"),
         -17.0, (1690, 1030)),
    ]
    canvas = Image.new("RGBA", (2320, 1980), (0, 0, 0, 0))
    for img, ang, (cx, cy) in backs:
        piece = with_shadow(card(img, 1180, border=14), ang, offset=(14, 18),
                            blur=18, opacity=110)
        place(canvas, piece, cx, cy)
    piece = with_shadow(card(front, 1520, border=18), -2.0, offset=(18, 26),
                        blur=24, opacity=140)
    place(canvas, piece, 1160, 1105)
    save_png(crop_alpha(canvas), "s6_nagrady_collage.png")

    # Удостоверение КПК «Артек» — скан повёрнут на 90°, бледный
    art = load(os.path.join(DIPL, "курсы повышения артек20225.jpeg"))
    art = art.rotate(-90, expand=True)                     # текст становится горизонтальным
    art = trim_doc(art, pad=0.002)
    art = art.rotate(-0.6, resample=Image.BICUBIC, expand=False,
                     fillcolor=(255, 255, 255))            # выравнивание перекоса
    w, h = art.size
    art = art.crop((int(w * 0.012), int(h * 0.014), int(w * 0.988), int(h * 0.986)))
    art = tune(art, g=1.06, auto=(0.4, 0.6), contrast=1.30, color=1.06, sharpen=0.9)
    art = fit(art, 2000, int(round(2000 * art.height / art.width)))
    save_jpg(art, "s6_udostoverenie_artek.jpg", quality=93)


def docs_fan(sources, out_name, alpha, width=2400, height=1150, doc_h=880,
             seed_angles=None):
    """Широкий веер документов с уже применённой прозрачностью.
    Крайние документы гарантированно помещаются в холст целиком."""
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    n = len(sources)
    angles = seed_angles or [(-9 + 18 * i / max(1, n - 1)) for i in range(n)]
    pieces = []
    for i, im in enumerate(sources):
        h = doc_h if im.height >= im.width else int(doc_h * 0.70)   # альбомные — ниже
        pieces.append(with_shadow(card(im, h, border=10), angles[i], offset=(10, 14),
                                  blur=14, opacity=95))
    margin = max(p.width for p in pieces) / 2 + 10
    step = (width - 2 * margin) / max(1, n - 1)
    for i, piece in enumerate(pieces):
        cy = height // 2 + (28 if i % 2 else -28)
        place(canvas, piece, int(margin + i * step), cy)
    save_png(set_alpha(canvas, alpha), out_name)


def fans() -> None:
    """Веер-подложки: слайд 6 (~20 %) и слайд 11 (~15 %)."""
    print("Веер-подложки документов")

    def kpk(name):
        """Сканы КПК лежат повёрнутыми на 90°."""
        return trim_doc(load(os.path.join(DIPL, name)).rotate(-90, expand=True))

    s6_docs = [
        trim_doc(load(os.path.join(DIPL, "грамота Мин. обр. Тверской обл..jpeg"))),
        kpk("КПК АНО БП 2023.jpeg"),
        kpk("кпк АНО БП 22.jpeg"),
        kpk("КПК НИ Новосибирск.jpeg"),
        kpk("КПК ФГОС био22.jpeg"),
        trim_doc(pdf_page(os.path.join(DIPL, "Атлас почв. микроорг. наставник 23.pdf"), 1, 150)),
        trim_doc(pdf_page(os.path.join(DIPL, "Атлас почв. микроорг.наставника  24.pdf"), 1, 150)),
    ]
    docs_fan(s6_docs, "s6_docs_fan_20.png", alpha=0.20)

    s11_docs = [
        trim_doc(pdf_page(os.path.join(DIPL, "Еременко А.М.pdf"), 1, 150)),                # диплом III ст.
        trim_doc(pdf_page(os.path.join(DIPL, "Еременко А.М Саратов жюри24.pdf"), 1, 150)),  # сертификат жюри
        trim_doc(pdf_page(os.path.join(DIPL, "Eremenko_A.pdf"), 1, 150)),                   # сертификат жюри
        trim_doc(load(os.path.join(DIPL, "грамота Мин. обр. Тверской обл..jpeg"))),
        trim_doc(pdf_page(os.path.join(DIPL, "Атлас почв. микроорг. наставник 23.pdf"), 1, 150)),
        trim_doc(pdf_page(os.path.join(DIPL, "Атлас почв. микроорг.наставника  24.pdf"), 1, 150)),
    ]
    docs_fan(s11_docs, "s11_docs_fan_15.png", alpha=0.15)


def slide7() -> None:
    """Слайд 7: защита проекта (тёмный зал) и кабинет «БиоЛаб»."""
    print("Слайд 7 — защита проекта и лаборатория")

    im = load(os.path.join(V2, "s7_zashchita_proekta.jpeg"))
    im = im.crop((130, 0, 1428, 864))                      # 1298×864 ≈ 3:2, ёлка подрезана
    im = crop_ratio(im, 3 / 2)
    im = tune(im, g=0.74, auto=(0.8, 0.05), contrast=1.10, color=1.10, sharpen=0.7)
    save_jpg(fit(im, 1440, 960), "s7_zashchita_proekta.jpg")

    im = load(os.path.join(V2, "s7_biolab_room.jpeg"))
    im = im.crop((0, 55, 1427, 1839))                      # 1427×1784 = 4:5, лишний пол убран
    im = crop_ratio(im, 4 / 5)
    im = tune(im, g=0.94, auto=(0.5, 0.3), contrast=1.08, color=1.10, sharpen=0.4)
    save_jpg(fit(im, 1200, 1500), "s7_biolab_room.jpg")


def slide10() -> None:
    """Слайд 10: маточные кустики лимонов «Лунарио» и «Павловский»."""
    print("Слайд 10 — лимоны")
    im = load(os.path.join(V2, "s10_limony.jpeg"))
    im = im.rotate(-1.5, resample=Image.BICUBIC, expand=False)   # завал горизонта
    im = im.crop((36, 40, 1391, 1846))                           # без полей поворота
    im = crop_ratio(im, 3 / 4, anchor_y=0.62)                    # этикетки внизу сохраняем
    im = tune(im, g=0.80, auto=(0.8, 0.15), contrast=1.10, color=1.12, sharpen=0.6)
    save_jpg(fit(im, 1200, 1600), "s10_limony.jpg")


# ----------------------------------------------------- sizes + контроль ----

def write_sizes() -> str:
    sizes = {}
    for name in sorted(os.listdir(OUT)):
        if name.startswith("_") or not name.lower().endswith((".jpg", ".png")):
            continue
        with Image.open(os.path.join(OUT, name)) as im:
            sizes[name] = [im.width, im.height]
    path = os.path.join(OUT, "sizes.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(sizes, f, ensure_ascii=False, indent=2)
    print(f"\nsizes.json — {len(sizes)} файлов → {path}")
    return path


def contact_sheet() -> None:
    """Контактный лист для визуального контроля (не входит в sizes.json)."""
    names = [n for n in sorted(os.listdir(OUT))
             if n.lower().endswith((".jpg", ".png")) and not n.startswith("_")]
    cols = 5
    cw, ch, cap = 430, 470, 26
    rows = (len(names) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cw, rows * (ch + cap)), (24, 26, 24))
    d = ImageDraw.Draw(sheet)
    for i, n in enumerate(names):
        im = Image.open(os.path.join(OUT, n))
        if im.mode == "RGBA":
            bg = Image.new("RGB", im.size, MINT_BG)
            bg.paste(im, (0, 0), im)
            im = bg
        im = im.convert("RGB")
        im.thumbnail((cw - 12, ch - 12), Image.LANCZOS)
        x, y = (i % cols) * cw, (i // cols) * (ch + cap)
        sheet.paste(im, (x + (cw - im.width) // 2, y + cap + (ch - im.height) // 2))
        with Image.open(os.path.join(OUT, n)) as o:
            d.text((x + 6, y + 7), f"{n}  {o.width}×{o.height}", fill=(255, 235, 120))
    out = os.path.join(OUT, "_contact_sheet.jpg")
    sheet.save(out, "JPEG", quality=88)
    print(f"контактный лист → {out} ({sheet.width}×{sheet.height})")


def main() -> None:
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)                     # идемпотентность: собираем с нуля
    os.makedirs(OUT, exist_ok=True)
    try:
        slide4()
        slide5_portraits()
        slide5_inserts()
        slide6_awards()
        fans()
        slide7()
        slide10()
        write_sizes()
        contact_sheet()
    finally:
        if _tmpdir and os.path.isdir(_tmpdir):
            shutil.rmtree(_tmpdir, ignore_errors=True)
    print("\nГотово. Каталог:", OUT)


if __name__ == "__main__":
    sys.exit(main())
