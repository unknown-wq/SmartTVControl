#!/usr/bin/env python3
"""Сжатие мобильного (вертикального) pptx.

Отличия от compress_pptx.py:
  * PNG со скруглёнными углами (альфа-канал) не остаются тяжёлыми PNG, а
    подкладываются на тот цвет, который реально находится под картинкой на
    слайде (белая карточка, цветная плашка или фон), и сохраняются в JPEG.
    Цвет определяется по рендеру исходного файла: берутся пробы вокруг рамки
    картинки и выбирается преобладающий цвет. Скругление визуально сохраняется;
  * подложка слайда пересчитывается под 110 ppi (контурная графика 6–14 %),
    фотографии — под 150 ppi.

Использование:
    python3 compress_pptx_mobile.py вход.pptx выход.pptx рендер_каталог
Каталог рендера — страницы исходника (pdftoppm -png -r 100 → prefix-NN.png).
"""
import zipfile, io, re, sys, os, glob, collections
from xml.etree import ElementTree as ET
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else 'presentation_mobile.pptx'
DST = sys.argv[2] if len(sys.argv) > 2 else 'presentation_mobile_small.pptx'
RENDER = sys.argv[3] if len(sys.argv) > 3 else 'render_pages'
PPI_PHOTO, PPI_BG, JPEG_Q, EMU = 150, 110, 85, 914400.0
SLIDE_W, SLIDE_H = 7.5, 13.333
RDPI = 100                                   # ppi рендера страниц

NS = {'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
      'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}

zin = zipfile.ZipFile(SRC)
items = {i.filename: zin.read(i.filename) for i in zin.infolist()}

pages = {}
for f in sorted(glob.glob(os.path.join(RENDER, '*-*.png')) +
                glob.glob(os.path.join(RENDER, '*-*.jpg'))):
    n = int(re.search(r'-(\d+)\.(png|jpg)$', f).group(1))
    pages[n] = Image.open(f).convert('RGB')
if pages:
    px_per_in = list(pages.values())[0].width / SLIDE_W
else:
    px_per_in = RDPI

# ── разбор слайдов: media, геометрия, номер слайда ───────────────────────
want, placements = {}, []
for name, data in items.items():
    mo = re.match(r'ppt/slides/slide(\d+)\.xml$', name)
    if not (mo or re.match(r'ppt/(slideLayouts|slideMasters)/[^/]+\.xml$', name)):
        continue
    slide_no = int(mo.group(1)) if mo else None
    relname = os.path.dirname(name) + '/_rels/' + os.path.basename(name) + '.rels'
    if relname not in items:
        continue
    rid2t = {r.get('Id'): r.get('Target') for r in ET.fromstring(items[relname])}
    for pic in ET.fromstring(data).iter('{%s}pic' % NS['p']):
        blip = pic.find('.//{%s}blip' % NS['a'])
        off = pic.find('.//{%s}xfrm/{%s}off' % (NS['a'], NS['a']))
        ext = pic.find('.//{%s}xfrm/{%s}ext' % (NS['a'], NS['a']))
        if blip is None or ext is None:
            continue
        tgt = rid2t.get(blip.get('{%s}embed' % NS['r']))
        if not tgt:
            continue
        media = 'ppt/' + tgt.replace('../', '')
        win, hin = int(ext.get('cx')) / EMU, int(ext.get('cy')) / EMU
        prev = want.get(media, (0, 0))
        want[media] = (max(prev[0], win), max(prev[1], hin))
        if slide_no and off is not None:
            placements.append((media, slide_no, int(off.get('x')) / EMU,
                               int(off.get('y')) / EMU, win, hin))

def is_bg(win, hin):
    return win >= SLIDE_W - 0.1 and hin >= SLIDE_H - 0.1

bg_media = {m for m, (w, h) in want.items() if is_bg(w, h)}

def backdrop(media):
    """Преобладающий цвет вокруг рамки картинки — по рендеру исходника."""
    votes = collections.Counter()
    for m, no, x, y, w, h in placements:
        if m != media or no not in pages:
            continue
        img = pages[no]
        d = 0.07                                     # отступ пробы, дюймы
        probes = [(x - d, y + h / 2), (x + w + d, y + h / 2),
                  (x + w / 2, y - d), (x + w / 2, y + h + d),
                  (x - d, y + h * 0.25), (x + w + d, y + h * 0.75)]
        for px, py in probes:
            cx = int(round(px * px_per_in)); cy = int(round(py * px_per_in))
            if 0 <= cx < img.width and 0 <= cy < img.height:
                votes[img.getpixel((cx, cy))] += 1
        break
    if not votes:
        return (255, 255, 255)
    return votes.most_common(1)[0][0]

# ── пересжатие ───────────────────────────────────────────────────────────
rename, newdata, report = {}, {}, []
for name, data in list(items.items()):
    if not name.startswith('ppt/media/'):
        continue
    try:
        im = Image.open(io.BytesIO(data)); im.load()
    except Exception:
        continue
    w, h = im.size
    win, hin = want.get(name, (SLIDE_W, SLIDE_H))
    ppi = PPI_BG if name in bg_media else PPI_PHOTO
    tw, th = max(64, round(win * ppi)), max(64, round(hin * ppi))
    if w > tw or h > th:
        im = im.resize((min(w, tw), min(h, th)), Image.LANCZOS)

    has_alpha = False
    if im.mode in ('RGBA', 'LA') or (im.mode == 'P' and 'transparency' in im.info):
        has_alpha = im.convert('RGBA').getchannel('A').getextrema()[0] < 255
    fill = None
    if has_alpha:
        fill = backdrop(name)
        base = Image.new('RGB', im.size, fill)
        rgba = im.convert('RGBA')
        base.paste(rgba, (0, 0), rgba)
        im = base

    buf = io.BytesIO()
    im.convert('RGB').save(buf, 'JPEG', quality=JPEG_Q, optimize=True, progressive=True)
    out = re.sub(r'\.png$', '.jpeg', name, flags=re.I)
    if out != name:
        rename[name] = out
    newdata[out] = buf.getvalue()
    kind = 'фон' if name in bg_media else (f'альфа→{fill}' if has_alpha else 'jpeg')
    report.append((len(data), len(buf.getvalue()), os.path.basename(name),
                   f'{win:.1f}×{hin:.1f}in', kind))

def patch(txt):
    for old, new in rename.items():
        txt = txt.replace(os.path.basename(old), os.path.basename(new))
    return txt

out_items = {}
for name, data in items.items():
    if name.startswith('ppt/media/'):
        continue
    if name.endswith('.rels') or name == '[Content_Types].xml':
        txt = patch(data.decode('utf-8'))
        if name == '[Content_Types].xml' and 'Extension="jpeg"' not in txt:
            txt = re.sub(r'(<Types[^>]*>)',
                         r'\1<Default Extension="jpeg" ContentType="image/jpeg"/>',
                         txt, count=1)
        data = txt.encode('utf-8')
    out_items[name] = data
out_items.update(newdata)

with zipfile.ZipFile(DST, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name, data in out_items.items():
        z.writestr(name, data)

for was, now, n, size, kind in sorted(report, reverse=True)[:10]:
    print(f'  {was/1e6:5.2f} -> {now/1e6:5.2f} МБ  {n:22s} {size:14s} {kind}')
a, b = os.path.getsize(SRC), os.path.getsize(DST)
print(f'\n{a/1e6:.1f} МБ -> {b/1e6:.1f} МБ ({100-b/a*100:.0f}% экономии), картинок: {len(report)}')
