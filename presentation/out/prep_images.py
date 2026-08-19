#!/usr/bin/env python3
"""Подготовка изображений для presentation.pptx:
   - кроп до нужного соотношения сторон (без искажения пропорций),
   - единое скругление углов (визуально одинаковый радиус на слайде),
   - круглые кропы для микрофотографий,
   - генерация панели «статистический анализ» для слайда 9.
Результат: out/prepared/build/ + sizes.json (пиксельные размеры всех файлов —
build_deck.js по ним вычисляет высоту от ширины, поэтому пропорции не искажаются
нигде и никогда).
"""
import json
import os
from PIL import Image, ImageDraw, ImageEnhance

BASE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(BASE)
BUILD = os.path.join(BASE, "prepared", "build")
os.makedirs(BUILD, exist_ok=True)

P14 = os.path.join(BASE, "prepared", "slides1-4")
P56 = os.path.join(BASE, "prepared", "slides5-6")
P710 = os.path.join(BASE, "prepared", "slides7-10")
ASSETS = os.path.join(PROJ, "assets")

RADIUS_IN = 0.11          # единый радиус скругления на слайде, дюймы (~0,28 см)
SS = 4                    # суперсэмплинг для гладкой маски
TINT = (244, 246, 251)    # цвет светлых плашек #F4F6FB


def crop_to_aspect(im, aspect, anchor=(0.5, 0.5)):
    """Кроп по центру (или заданному якорю) до соотношения width/height = aspect."""
    w, h = im.size
    cur = w / h
    if abs(cur - aspect) < 1e-4:
        return im
    if cur > aspect:                       # слишком широкое -> режем по ширине
        nw = int(round(h * aspect))
        x = int(round((w - nw) * anchor[0]))
        return im.crop((x, 0, x + nw, h))
    nh = int(round(w / aspect))            # слишком высокое -> режем по высоте
    y = int(round((h - nh) * anchor[1]))
    return im.crop((0, y, w, y + nh))


def rounded(im, disp_w_in, out_name, radius_in=RADIUS_IN, ppi=300, bg=(255, 255, 255)):
    """Скругляет углы так, чтобы радиус на слайде был одинаковым, и сохраняет JPEG.
    Разрешение ограничивается 300 ppi от размера на слайде — этого хватает и для
    проектора, и для печати, а вес файла остаётся разумным."""
    im = im.convert("RGB")
    max_px = max(420, int(round(disp_w_in * ppi)))
    if im.width > max_px:
        im = im.resize((max_px, int(round(im.height * max_px / im.width))), Image.LANCZOS)
    r = max(4, int(round(radius_in / disp_w_in * im.width)))
    mask = Image.new("L", (im.width * SS, im.height * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, mask.width - 1, mask.height - 1), radius=r * SS, fill=255)
    mask = mask.resize(im.size, Image.LANCZOS)
    # скруглённые углы «заливаются» цветом фона слайда — файл остаётся JPEG,
    # вес презентации в разы меньше, чем у RGBA-PNG, визуально то же самое
    out = Image.new("RGB", im.size, bg)
    out.paste(im, (0, 0), mask)
    path = os.path.join(BUILD, out_name)
    out.save(path, quality=88, optimize=True, subsampling=1)
    print(f"  {out_name}: {out.width}x{out.height}, r={r}px")
    return path


def circle(im, out_name, size=700, bg=(255, 255, 255)):
    im = crop_to_aspect(im.convert("RGB"), 1.0)
    im = im.resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * SS - 1, size * SS - 1), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    out = Image.new("RGB", (size, size), bg)
    out.paste(im, (0, 0), mask)
    out.save(os.path.join(BUILD, out_name), quality=88, optimize=True, subsampling=1)
    print(f"  {out_name}: круг {size}px")


def enhance(im, brightness=1.0, contrast=1.0, color=1.0):
    if brightness != 1.0:
        im = ImageEnhance.Brightness(im).enhance(brightness)
    if contrast != 1.0:
        im = ImageEnhance.Contrast(im).enhance(contrast)
    if color != 1.0:
        im = ImageEnhance.Color(im).enhance(color)
    return im


def op(p):
    return Image.open(p)


print("Слайд 1")
rounded(op(f"{P14}/s1_school.jpg"), 5.12, "s1_school.jpg")

print("Слайд 3")
# портреты: единый кроп 3:4, якорь смещён вверх — головы не срезаются
rounded(crop_to_aspect(op(f"{P14}/s3_student_b.jpg"), 0.75, (0.5, 0.25)), 1.88, "s3_zhilkina.jpg")
rounded(crop_to_aspect(op(f"{P14}/s3_student_c.jpg"), 0.75, (0.5, 0.30)), 1.88, "s3_grichenko.jpg")
rounded(crop_to_aspect(op(f"{P14}/s3_student_a.jpg"), 0.75, (0.5, 0.25)), 1.88, "s3_zhukova.jpg")

print("Слайд 4")
rounded(crop_to_aspect(enhance(op(f"{P14}/s4_koljaskina_work.jpg"), 1.12, 1.06),
                       4 / 3, (0.5, 0.02)), 3.35, "s4_kol_main.jpg")
rounded(crop_to_aspect(op(f"{P14}/s4_biolab_pair.jpg"), 4 / 3, (0.5, 0.45)), 3.35, "s4_zhu_main.jpg")
circle(op(f"{P14}/s4_micro_streptomyces.jpg"), "s4_micro_strep.jpg")
circle(enhance(op(f"{P14}/s4_micro_azotobacter.jpg"), 1.05, 1.05), "s4_micro_azoto.jpg")

print("Слайд 5")
# все три кадра приводятся к 4:3 — на слайде получаются три карточки одной ширины
rounded(crop_to_aspect(op(f"{P56}/foto_nagrazhdenie_nastavnikov.png"), 4 / 3, (0.5, 0.55)),
        2.60, "s5_photo1.jpg")
rounded(crop_to_aspect(op(f"{P56}/foto_gruppovaya_rabota.png"), 4 / 3, (0.5, 0.45)),
        2.60, "s5_photo2.jpg")
rounded(crop_to_aspect(op(f"{P56}/foto_obshchee_bp.png"), 4 / 3, (0.5, 0.45)),
        2.60, "s5_photo3.jpg")
rounded(op(f"{P56}/gramota_kirienko_2021.png"), 1.40, "s5_gram2021.jpg")
rounded(op(f"{P56}/gramota_kirienko_2024.png"), 1.40, "s5_gram2024.jpg")

print("Слайд 6")
# кроп под ширину правой колонки: 3,743" x 5,185" -> 0,722
rounded(crop_to_aspect(op(f"{P56}/foto_nagrazhdenie_uchenitsy.jpg"), 0.722, (0.5, 0.80)),
        3.75, "s6_live.jpg")
rounded(op(f"{P56}/diplom_bolshie_vyzovy_zhukova.jpg"), 1.35, "s6_dip1.jpg")
rounded(op(f"{P56}/diplom_bolshie_vyzovy_kolyaskina.jpg"), 1.30, "s6_dip2.jpg")
rounded(op(f"{P56}/diplom_ekopokolenie_zhukova.jpg"), 1.30, "s6_dip3.jpg")
rounded(op(f"{P56}/diplom_mnogolikaya_rossiya_elizarova.jpg"), 1.35, "s6_dip4.jpg")

print("Слайд 7")
rounded(op(f"{P710}/s7_biolab_ecg_wide.jpg"), 6.05, "s7_ecg.jpg")

print("Слайд 8")
rounded(crop_to_aspect(op(f"{P710}/s8_team_at_work_wide.jpg"), 2.20, (0.5, 0.40)),
        6.75, "s8_team.jpg")
rounded(op(f"{P710}/s8_group_from_image55.jpg"), 3.50, "s8_group.jpg")

print("Слайд 9")
LEMON_ASPECT = 1.85          # общая пропорция обеих иллюстраций слайда 9
lemon_src = os.path.join(BASE, "prepared", "slides7-10", "s9_lemon_wikimedia.jpg")
if os.path.exists(lemon_src):
    rounded(crop_to_aspect(op(lemon_src), LEMON_ASPECT, (0.5, 0.45)), 4.29, "s9_lemon.jpg", bg=TINT)

# панель «статистический анализ» (рисуется, не сток) — та же пропорция, что у фото
W, H = 1380, int(round(1380 / LEMON_ASPECT))
panel = Image.new("RGBA", (W * 2, H * 2), (0, 0, 0, 0))
d = ImageDraw.Draw(panel)
NAVY = (43, 84, 158)
CRIM = (225, 30, 79)
SKY = (37, 173, 228)
GRID = (208, 216, 233)
d.rounded_rectangle((0, 0, W * 2 - 1, H * 2 - 1), radius=int(RADIUS_IN / 4.29 * W) * 2,
                    fill=(255, 255, 255, 255))
m = 130
base_y = H * 2 - 210
# сетка
for i in range(1, 5):
    y = m + i * (base_y - m) // 5
    d.line((m, y, W * 2 - m, y), fill=GRID, width=5)
# оси
d.line((m, m - 20, m, base_y), fill=NAVY, width=9)
d.line((m, base_y, W * 2 - m, base_y), fill=NAVY, width=9)


def bell(cx, sigma, amp):
    pts = []
    import math
    for px in range(m + 6, W * 2 - m - 6, 6):
        t = (px - cx) / sigma
        y = base_y - amp * math.exp(-0.5 * t * t)
        pts.append((px, y))
    return pts


d.line(bell(W * 0.85, 250, base_y - m - 120), fill=SKY, width=16, joint="curve")
d.line(bell(W * 1.28, 230, base_y - m - 250), fill=CRIM, width=16, joint="curve")
# пунктирная граница значимости
x = int(W * 1.06)
y = m + 40
while y < base_y:
    d.line((x, y, x, min(y + 28, base_y)), fill=(90, 103, 133), width=6)
    y += 52
panel = panel.resize((W, H), Image.LANCZOS)
panel.save(os.path.join(BUILD, "s9_stats.png"))
print(f"  s9_stats.png: сгенерирована {W}x{H}")

print("Слайд 11 (резерв)")
# 1-я страница каждого PDF «Атласа почвенных микроорганизмов» -> растр
SRC = os.path.join(BASE, "prepared", "pdfpages")
os.makedirs(SRC, exist_ok=True)
for tag, pdf in (("atlas23", "Атлас почв. микроорг. наставник 23.pdf"),
                 ("atlas24", "Атлас почв. микроорг.наставника  24.pdf")):
    if not os.path.exists(os.path.join(SRC, tag + "-1.jpg")):
        os.system('pdftoppm -jpeg -r 100 -f 1 -l 1 "%s" "%s"'
                  % (os.path.join(ASSETS, "diplomy_ucheniki", pdf), os.path.join(SRC, tag)))

eq = op(f"{ASSETS}/docx_media/image61.jpeg")
eq = eq.crop((0, 440, 1280, 964))             # нижняя часть кадра — кейсы датчиков
eq = enhance(eq, 1.04, 1.06)
rounded(eq, 7.49, "s11_equipment.jpg")
rounded(op(f"{P56}/gramota_kirienko_2022.png"), 1.15, "s11_gram2022.jpg")
rounded(op(f"{ASSETS}/diplomy_ucheniki/грамота Мин. обр. Тверской обл..jpeg"), 1.20,
        "s11_gramota_tver.jpg")
rounded(op(f"{SRC}/atlas23-1.jpg"), 2.25, "s11_atlas23.jpg")
rounded(op(f"{SRC}/atlas24-1.jpg"), 2.25, "s11_atlas24.jpg")

print("Фон финального слайда (сильно осветлённая подложка)")
bgim = op(f"{P14}/s1_school.jpg").convert("RGB")
bgim.thumbnail((1400, 1400), Image.LANCZOS)
bgim.save(os.path.join(BUILD, "s10_bg.jpg"), quality=82, optimize=True)

print("Логотип")
logo = op(f"{P14}/s1_logo_bp.png").convert("RGB")
logo.save(os.path.join(BUILD, "logo_bp.png"))

print("Манифест размеров")
sizes = {}
for name in sorted(os.listdir(BUILD)):
    if name.lower().endswith((".jpg", ".png")):
        with Image.open(os.path.join(BUILD, name)) as im:
            sizes[name] = list(im.size)
with open(os.path.join(BUILD, "sizes.json"), "w", encoding="utf-8") as f:
    json.dump(sizes, f, ensure_ascii=False, indent=1)
print(f"  sizes.json: {len(sizes)} файлов")
print("Готово.")
