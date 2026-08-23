# -*- coding: utf-8 -*-
"""Единое скругление углов и кадрирование для presentation_v2.pptx.

Готовые исходники (out/prepared/v2, slides1-4, slides5-6, slides7-10) не
меняются — здесь только производный слой out/prepared/v2r/ с прозрачными
скруглёнными углами (радиус 0,12" на итоговом размере в слайде).
"""
import json
import os
from PIL import Image, ImageDraw

BASE = os.path.dirname(os.path.abspath(__file__))
P = os.path.join(BASE, "prepared")
OUT = os.path.join(P, "v2r")
os.makedirs(OUT, exist_ok=True)

RADIUS_IN = 0.12
PPI = 300
SS = 4  # суперсэмплинг маски


def op(rel):
    return Image.open(os.path.join(P, rel)).convert("RGB")


def crop_to_aspect(im, aspect, anchor=(0.5, 0.5)):
    w, h = im.size
    if w / h > aspect:                      # слишком широкое -> режем по ширине
        nw = int(round(h * aspect))
        x = int(round((w - nw) * anchor[0]))
        return im.crop((x, 0, x + nw, h))
    nh = int(round(w / aspect))             # слишком высокое -> режем по высоте
    y = int(round((h - nh) * anchor[1]))
    return im.crop((0, y, w, y + nh))


sizes = {}


def rounded(im, disp_w_in, out_name, radius_in=RADIUS_IN):
    max_px = max(420, int(round(disp_w_in * PPI)))
    if im.width > max_px:
        im = im.resize((max_px, int(round(im.height * max_px / im.width))), Image.LANCZOS)
    r = max(4, int(round(radius_in / disp_w_in * im.width)))
    mask = Image.new("L", (im.width * SS, im.height * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, mask.width - 1, mask.height - 1), radius=r * SS, fill=255)
    mask = mask.resize(im.size, Image.LANCZOS)
    out = im.convert("RGBA")
    out.putalpha(mask)
    path = os.path.join(OUT, out_name)
    out.save(path)
    sizes[out_name] = list(out.size)
    print(f"{out_name:34s} {out.size[0]}x{out.size[1]}  (w={disp_w_in}\")")


def circle(im, disp_w_in, out_name):
    im = crop_to_aspect(im, 1.0)
    max_px = max(420, int(round(disp_w_in * PPI)))
    if im.width > max_px:
        im = im.resize((max_px, max_px), Image.LANCZOS)
    mask = Image.new("L", (im.width * SS, im.height * SS), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, mask.width - 1, mask.height - 1), fill=255)
    mask = mask.resize(im.size, Image.LANCZOS)
    out = im.convert("RGBA")
    out.putalpha(mask)
    out.save(os.path.join(OUT, out_name))
    sizes[out_name] = list(out.size)
    print(f"{out_name:34s} {out.size[0]}x{out.size[1]}  круг")


V2 = "v2"
S14 = "slides1-4"
S56 = "slides5-6"
S710 = "slides7-10"

# ── слайд 1 ─────────────────────────────────────────────────────────
rounded(op(f"{S14}/s1_school.jpg"), 5.76, "s1_school.png")

# ── слайд 3: портреты 3:4 ───────────────────────────────────────────
rounded(crop_to_aspect(op(f"{S14}/s3_student_b.jpg"), 0.75, (0.5, 0.18)), 2.40, "s3_zhilkina.png")
rounded(crop_to_aspect(op(f"{S14}/s3_student_c.jpg"), 0.75, (0.5, 0.25)), 2.40, "s3_grichenko.png")
rounded(crop_to_aspect(op(f"{S14}/s3_student_a.jpg"), 0.75, (0.5, 0.18)), 2.40, "s3_zhukova.png")

# ── слайд 4: четыре кадра 4:3 ───────────────────────────────────────
for src, dst in [("s4_starter_kit.jpg", "s4_starter_kit.png"),
                 ("s4_diplomy_atlas.jpg", "s4_diplomy_atlas.png"),
                 ("s4_nagrazhdenie_2024.jpg", "s4_nagrazhdenie_2024.png"),
                 ("s4_shtammy_ihbfm.jpg", "s4_shtammy_ihbfm.png")]:
    rounded(op(f"{V2}/{src}"), 2.70, dst)

# ── слайд 5: квадратные портреты + микровставки ─────────────────────
rounded(crop_to_aspect(op(f"{V2}/s5_zhukova_portrait.jpg"), 1.0, (0.5, 0.30)), 1.40, "s5_zhukova.png")
rounded(crop_to_aspect(op(f"{V2}/s5_kolyaskina_portrait.jpg"), 1.0, (0.5, 0.28)), 1.40, "s5_kolyaskina.png")
rounded(crop_to_aspect(op(f"{V2}/s5_petrova_portrait.jpg"), 1.0, (0.5, 0.45)), 1.40, "s5_petrova.png")
rounded(crop_to_aspect(op(f"{V2}/s5_elizarova_portrait.jpg"), 1.0, (0.5, 0.35)), 1.40, "s5_elizarova.png")
rounded(crop_to_aspect(op(f"{V2}/s5_kultivirovanie_insert.jpg"), 1.0, (0.5, 0.45)), 0.72, "s5_ins_kult.png")
rounded(crop_to_aspect(op(f"{S14}/s4_koljaskina_work.jpg"), 1.0, (0.5, 0.45)), 0.72, "s5_ins_work.png")
circle(op(f"{V2}/s5_micro_azotobacter_circle_mint.jpg"), 0.86, "s5_circ_azoto.png")
circle(op(f"{V2}/s5_micro_streptomyces_circle_mint.jpg"), 0.86, "s5_circ_strep.png")

# ── слайд 6 ─────────────────────────────────────────────────────────
rounded(op(f"{V2}/s6_udostoverenie_artek.jpg"), 3.21, "s6_artek.png")
rounded(crop_to_aspect(op(f"{S56}/foto_nagrazhdenie_nastavnikov.png"), 4 / 3, (0.5, 0.50)),
        3.21, "s6_foto_vruchenie.png")
rounded(crop_to_aspect(op(f"{S56}/foto_gruppovaya_rabota.png"), 4 / 3, (0.5, 0.45)),
        3.21, "s6_foto_gruppa.png")

# ── слайд 7 ─────────────────────────────────────────────────────────
rounded(op(f"{V2}/s7_zashchita_proekta.jpg"), 3.51, "s7_zashchita.png")
rounded(crop_to_aspect(op(f"{V2}/s7_biolab_room.jpg"), 1.44, (0.5, 0.28)), 3.51, "s7_biolab_room.png")

# ── слайд 9 ─────────────────────────────────────────────────────────
rounded(op(f"{S710}/s7_biolab_ecg_wide.jpg"), 4.00, "s9_ecg.png")
rounded(op(f"{S710}/s8_team_at_work_wide.jpg"), 4.00, "s9_team.png")

# ── слайд 10 ────────────────────────────────────────────────────────
rounded(op(f"{V2}/s10_limony.jpg"), 2.00, "s10_limony.png")

with open(os.path.join(OUT, "sizes.json"), "w", encoding="utf-8") as f:
    json.dump(sizes, f, ensure_ascii=False, indent=2, sort_keys=True)
print("\nsizes.json:", len(sizes), "файлов")
