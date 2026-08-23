#!/usr/bin/env python3
"""Сжатие pptx под реальный размер картинок на слайде.

Для каждой картинки вычисляется её фактический размер в дюймах на слайде,
изображение масштабируется под 150 ppi (запас над 144 ppi проектора Full HD),
непрозрачные PNG переводятся в JPEG с обновлением rels и Content_Types.
"""
import zipfile, io, re, sys, os
from xml.etree import ElementTree as ET
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else 'presentation_v2.pptx'
DST = sys.argv[2] if len(sys.argv) > 2 else 'presentation_v2_small.pptx'
PPI, JPEG_Q, EMU = 150, 85, 914400.0

NS = {'p':'http://schemas.openxmlformats.org/presentationml/2006/main',
      'a':'http://schemas.openxmlformats.org/drawingml/2006/main',
      'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'pr':'http://schemas.openxmlformats.org/package/2006/relationships'}

zin = zipfile.ZipFile(SRC)
items = {i.filename: zin.read(i.filename) for i in zin.infolist()}

# media -> максимальный отображаемый размер в дюймах
want = {}
for name, data in items.items():
    if not re.match(r'ppt/(slides|slideLayouts|slideMasters)/[^/]+\.xml$', name):
        continue
    relname = os.path.dirname(name) + '/_rels/' + os.path.basename(name) + '.rels'
    if relname not in items:
        continue
    rid2t = {r.get('Id'): r.get('Target') for r in ET.fromstring(items[relname])}
    root = ET.fromstring(data)
    for pic in root.iter('{%s}pic' % NS['p']):
        blip = pic.find('.//{%s}blip' % NS['a'])
        ext = pic.find('.//{%s}xfrm/{%s}ext' % (NS['a'], NS['a']))
        if blip is None or ext is None:
            continue
        rid = blip.get('{%s}embed' % NS['r'])
        tgt = rid2t.get(rid)
        if not tgt:
            continue
        media = 'ppt/' + tgt.replace('../', '')
        win, hin = int(ext.get('cx'))/EMU, int(ext.get('cy'))/EMU
        prev = want.get(media, (0, 0))
        want[media] = (max(prev[0], win), max(prev[1], hin))

rename, newdata = {}, {}
report = []
for name, data in list(items.items()):
    if not name.startswith('ppt/media/'):
        continue
    try:
        im = Image.open(io.BytesIO(data)); im.load()
    except Exception:
        continue
    w, h = im.size
    win, hin = want.get(name, (13.333, 7.5))          # не найдено — считаем полноэкранной
    tw, th = max(64, round(win*PPI)), max(64, round(hin*PPI))
    if w > tw or h > th:
        im = im.resize((min(w, tw), min(h, th)), Image.LANCZOS)
    has_alpha = False
    if im.mode in ('RGBA','LA') or (im.mode=='P' and 'transparency' in im.info):
        has_alpha = im.convert('RGBA').getchannel('A').getextrema()[0] < 255
    buf = io.BytesIO()
    if has_alpha:
        im.convert('RGBA').save(buf, 'PNG', optimize=True)
        newdata[name] = buf.getvalue(); out = name
    else:
        im.convert('RGB').save(buf, 'JPEG', quality=JPEG_Q, optimize=True, progressive=True)
        out = re.sub(r'\.png$', '.jpeg', name, flags=re.I)
        if out != name: rename[name] = out
        newdata[out] = buf.getvalue()
    report.append((len(data), len(buf.getvalue()), os.path.basename(name), f'{win:.1f}×{hin:.1f}in', 'alpha' if has_alpha else 'jpeg'))

def patch(txt):
    for old, new in rename.items():
        txt = txt.replace(os.path.basename(old), os.path.basename(new))
    return txt

out_items = {}
for name, data in items.items():
    if name.startswith('ppt/media/'): continue
    if name.endswith('.rels') or name == '[Content_Types].xml':
        txt = patch(data.decode('utf-8'))
        if name == '[Content_Types].xml' and 'Extension="jpeg"' not in txt:
            txt = re.sub(r'(<Types[^>]*>)', r'\1<Default Extension="jpeg" ContentType="image/jpeg"/>', txt, count=1)
        data = txt.encode('utf-8')
    out_items[name] = data
out_items.update(newdata)

with zipfile.ZipFile(DST, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name, data in out_items.items():
        z.writestr(name, data)

for was, now, n, size, kind in sorted(report, reverse=True)[:8]:
    print(f'  {was/1e6:5.2f} -> {now/1e6:5.2f} МБ  {n:24s} на слайде {size:12s} {kind}')
a, b = os.path.getsize(SRC), os.path.getsize(DST)
print(f'\n{a/1e6:.1f} МБ -> {b/1e6:.1f} МБ ({100-b/a*100:.0f}% экономии), картинок: {len(report)}')
