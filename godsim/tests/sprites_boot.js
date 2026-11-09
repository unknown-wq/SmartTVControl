// Bootstrap for the Sprites contact sheets. Appended INSIDE the game scope by
//   node build.mjs --stubs --no-main --out=/tmp/godsim-sprites.html --extra=tests/sprites_boot.js
// so Sprites / Const / Tiles / Races / ToolDefs / Tabs / Palette are directly visible here.
// Exposes window.__sheet = { names, draw(name, opts) -> {w,h} } used by tests/sprites_sheet.mjs.
(function () {
  const t0 = performance.now();
  Sprites.init();
  window.__initMs = performance.now() - t0;
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;background:#14161c;overflow:auto';

  function mk(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.style.cssText = 'display:block;width:' + w + 'px;height:' + h + 'px;image-rendering:pixelated';
    const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
    return c;
  }
  function label(x, s, px, py, col, size) { x.fillStyle = col || '#9aa4b8'; x.font = (size || 11) + 'px monospace'; x.fillText(s, px, py); }
  function tint(x, px, py, w, h, t, size, seed) {                 // paint a terrain patch with mixed looks
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const v = (Math.imul(i * 7 + 3, 374761393) ^ Math.imul(j * 13 + seed, 668265263)) >>> 7 & 7;
      Sprites.drawTile(x, t, px + i * size, py + j * size, size, v);
    }
  }
  const TN = ['deep', 'shallow', 'sand', 'grass', 'forest', 'hill', 'mountain', 'snow', 'lava'];
  const KC = Palette.kingdom;

  const SEC = {};

  SEC.tiles = () => {
    const sc = 3, tw = 16 * sc, c = mk(80 + 16 * tw + 10, 9 * (tw + 4) + 40), x = c.getContext('2d');
    x.fillStyle = '#14161c'; x.fillRect(0, 0, c.width, c.height);
    for (let t = 0; t < 9; t++) {
      label(x, TN[t], 6, 40 + t * (tw + 4) + 28);
      for (let v = 0; v < 16; v++) Sprites.drawTile(x, t, 80 + v * tw, 30 + t * (tw + 4), tw, v);
    }
    label(x, 'looks 0..7 frame 0 | looks 0..7 frame 1', 80, 16, '#fff', 12);
    return c;
  };

  SEC.tiled = () => {
    const sc = 3, tw = 16 * sc, pw = 8, ph = 6, c = mk(3 * (pw * tw + 10) + 10, 3 * (ph * tw + 24) + 10), x = c.getContext('2d');
    x.fillStyle = '#14161c'; x.fillRect(0, 0, c.width, c.height);
    for (let t = 0; t < 9; t++) {
      const px = 10 + (t % 3) * (pw * tw + 10), py = 6 + ((t / 3) | 0) * (ph * tw + 24);
      tint(x, px, py + 14, pw, ph, t, tw, t * 5);
      label(x, TN[t], px, py + 10);
    }
    return c;
  };

  SEC.features = () => {
    const RES = Const.RES, names = ['TREE', 'ROCK', 'IRON', 'GOLD', 'BERRY'], kinds = [RES.TREE, RES.ROCK, RES.IRON, RES.GOLD, RES.BERRY];
    const sc = 6, cw = 16 * sc + 8, c = mk(80 + 6 * cw, 5 * (cw) + 40), x = c.getContext('2d');
    x.fillStyle = '#14161c'; x.fillRect(0, 0, c.width, c.height);
    for (let k = 0; k < 5; k++) {
      label(x, names[k], 6, 40 + k * cw + 50);
      const vs = k === 4 ? [0, 1, 2, 3, 9] : [0, 1, 2, 3];
      vs.forEach((v, i) => {
        const px = 80 + i * cw, py = 30 + k * cw;
        // grass backdrop for realism
        for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) Sprites.drawTile(x, 3, px - 8 + a * 8 * sc, py - 8 + b * 8 * sc, 8 * sc, 0);
        Sprites.drawTile(x, 3, px, py, 16 * sc, (k * 3 + i) & 7);
        x.imageSmoothingEnabled = false;
        x.drawImage(Sprites.feature(kinds[k], v), px, py, 16 * sc, 16 * sc);
        label(x, 'v' + v, px + 2, py + 12, '#fff');
      });
      // on sand + hill
      const px = 80 + 5 * cw, py = 30 + k * cw;
      Sprites.drawTile(x, 5, px, py, 16 * sc, 1); x.drawImage(Sprites.feature(kinds[k], 1), px, py, 16 * sc, 16 * sc);
    }
    return c;
  };

  SEC.units = (o) => {
    const race = (o && o.race) | 0, sc = 6, cw = 16 * sc + 2;
    const combos = [[0, 0], [1, 1], [2, 2], [3, 3]], stages = ['child', 'adult', 'elder'];
    const tints = [null, KC[0], KC[1], KC[2]];
    const c = mk(90 + combos.length * 2 * cw, 3 * 4 * cw + 30), x = c.getContext('2d');
    x.fillStyle = '#14161c'; x.fillRect(0, 0, c.width, c.height);
    stages.forEach((st, si) => tints.forEach((tn, ti) => {
      const py = 24 + (si * 4 + ti) * cw;
      if (ti === 0) label(x, st, 6, py + 20, '#fff');
      combos.forEach((cb, ci) => [0, 1].forEach(fr => {
        const X = 90 + (ci * 2 + fr) * cw;
        Sprites.drawTile(x, 3, X, py, cw - 2, (ci + fr + si + ti) & 7);
        x.drawImage(Sprites.unit(race, st, fr, tn, cb[0], cb[1], 0), X, py, 16 * sc, 16 * sc);
      }));
    }));
    label(x, 'rows: tint none/red/blue/green; cols: (weapon,armor) 0..3 x frame 0/1', 90, 14, '#fff', 11);
    return c;
  };

  SEC.units_stage = () => {                   // every race x stage at scale 9: frames 0/1 plain, then geared, on grass
    const sc = 9, cw = 16 * sc, cols = [[0, 0, 0], [1, 0, 0], [0, 1, 1], [1, 1, 1], [0, 2, 2], [1, 2, 2], [0, 3, 3], [1, 3, 3]];
    const c = mk(70 + cols.length * cw, 9 * cw + 24), x = c.getContext('2d');
    x.fillStyle = '#14161c'; x.fillRect(0, 0, c.width, c.height);
    const st = ['child', 'adult', 'elder'];
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) {
      const row = r * 3 + s, Y = 20 + row * cw;
      label(x, ['human', 'orc', 'elf'][r] + ' ' + st[s], 4, Y + 20);
      cols.forEach((cl, i) => {
        const X = 70 + i * cw;
        Sprites.drawTile(x, 3, X, Y, cw, (row + i) & 7);
        x.drawImage(Sprites.unit(r, st[s], cl[0], KC[r === 0 ? 1 : r === 1 ? 0 : 2], cl[1], cl[2], 0), X, Y, cw, cw);
      });
    }
    return c;
  };

  SEC.units_big = (o) => {                    // each race x look (0..3) adult, plus child/elder, scale 10, mixed gear
    const sc = 10, cw = 16 * sc, c = mk(10 + 4 * cw, 9 * cw + 10), x = c.getContext('2d');
    x.fillStyle = '#14161c'; x.fillRect(0, 0, c.width, c.height);
    const st = ['adult', 'child', 'elder'];
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) for (let l = 0; l < 4; l++) {
      const X = 10 + l * cw, Y = 5 + (r * 3 + s) * cw;
      Sprites.drawTile(x, 3, X, Y, cw, (r + l + s) & 7);
      x.drawImage(Sprites.unit(r, st[s], l & 1, KC[(l * 3 + r) % 16], l, l, l), X, Y, cw, cw);
    }
    return c;
  };

  SEC.buildings = (o) => {
    const sc = (o && o.sc) || 5, cw = 16 * sc + 4, names = ['HOUSE', 'FARM', 'STORAGE', 'BARRACKS', 'TOWNHALL', 'TEMPLE', 'MARKET'];
    const cols = 4, c = mk(70 + 3 * (cols * cw + 14), 7 * cw + 24), x = c.getContext('2d');
    x.fillStyle = '#14161c'; x.fillRect(0, 0, c.width, c.height);
    for (let r = 0; r < 3; r++) for (let t = 1; t <= 7; t++) for (let k = 0; k < cols; k++) {
      const X = 70 + r * (cols * cw + 14) + k * cw, Y = 20 + (t - 1) * cw;
      Sprites.drawTile(x, r === 1 ? 3 : r === 2 ? 3 : 3, X, Y, 16 * sc, (t + k) & 7);
      const lv = k < 3 ? k + 1 : 1, done = k < 3;
      x.drawImage(Sprites.building(t, r, lv, done, null), X, Y, 16 * sc, 16 * sc);
      if (r === 0 && k === 0) label(x, names[t - 1], 4, Y + 40);
    }
    label(x, 'human | orc | elf    (L1 L2 L3 scaffold)', 70, 12, '#fff', 12);
    return c;
  };

  SEC.buildings_tint = () => {
    const sc = 5, cw = 16 * sc + 4, c = mk(10 + 7 * cw, 3 * cw + 10), x = c.getContext('2d');
    x.fillStyle = '#14161c'; x.fillRect(0, 0, c.width, c.height);
    for (let r = 0; r < 3; r++) for (let t = 1; t <= 7; t++) {
      const X = 10 + (t - 1) * cw, Y = 4 + r * cw;
      Sprites.drawTile(x, 3, X, Y, 16 * sc, (t + r) & 7);
      x.drawImage(Sprites.building(t, r, 3, true, KC[(t + r * 3) % 16]), X, Y, 16 * sc, 16 * sc);
    }
    return c;
  };

  SEC.icons = (o) => {
    const keys = [];
    const add = k => { if (k && keys.indexOf(k) < 0) keys.push(k); };
    ToolDefs.forEach(t => add(t.icon)); Tabs.forEach(t => add(t.icon));
    'play pause speed1 speed2 speed4 menu hand brush save load newworld close map_normal map_borders map_culture crown sword heart food wood stone iron gold skull coin chevron_up chevron_down plus minus check log focus human orc elf'.split(' ').forEach(add);
    add('bogus_key');
    const size = (o && o.size) || 48, cw = size + 24, per = 11, rows = Math.ceil(keys.length / per);
    const c = mk(per * cw + 10, rows * (cw + 14) + 60 + 80), x = c.getContext('2d');
    x.fillStyle = '#222838'; x.fillRect(0, 0, c.width, c.height);
    keys.forEach((k, i) => {
      const X = 10 + (i % per) * cw, Y = 10 + ((i / per) | 0) * (cw + 14);
      x.fillStyle = '#2c3347'; x.fillRect(X, Y, cw - 4, cw - 4);
      x.drawImage(Sprites.icon(k, size), X + 10, Y + 10, size, size);
      label(x, k, X + 1, Y + cw + 4, '#aab', 9);
    });
    // size ladder for a few icons
    let X = 10; const Y = rows * (cw + 14) + 14;
    for (const k of ['lightning', 'human', 'sword', 'tab_land']) for (const s of [24, 32, 40, 56, 64]) { x.drawImage(Sprites.icon(k, s), X, Y, s, s); X += s + 6; }
    return c;
  };

  SEC.flags = () => {
    const cw = 76, c = mk(10 + 10 * cw, 6 * 54 + 130), x = c.getContext('2d');
    x.fillStyle = '#222838'; x.fillRect(0, 0, c.width, c.height);
    const cols = [['#c0392b', '#f4f4f4', '#ffd54f'], ['#1e88e5', '#ffd54f', '#ffffff'], ['#43a047', '#fff176', '#212121'], ['#8e24aa', '#f5f5f5', '#ffcc80'], ['#fb8c00', '#212121', '#ffffff'], ['#00acc1', '#e53935', '#fff59d']];
    for (let p = 0; p < 6; p++) for (let s = 0; s < 10; s++) {
      const fl = { pattern: p, symbol: s, c1: cols[(p + s) % 6][0], c2: cols[(p + s) % 6][1], c3: cols[(p + s) % 6][2] };
      x.drawImage(Sprites.flag(fl, 64, 40), 10 + s * cw, 10 + p * 54, 64, 40);
    }
    // small / large
    const fl2 = { pattern: 3, symbol: 7, c1: '#1e88e5', c2: '#ffd54f', c3: '#ffffff' };
    let X = 10; for (const w of [16, 24, 32, 48, 64, 96]) { x.drawImage(Sprites.flag(fl2, w, Math.round(w * 0.625)), X, 6 * 54 + 20, w, Math.round(w * 0.625)); X += w + 10; }
    for (let s = 0; s < 10; s++) x.drawImage(Sprites.flag({ pattern: 1, symbol: s, c1: '#e53935', c2: '#fdd835', c3: '#ffffff' }, 24, 16), 10 + s * 40, 6 * 54 + 100, 32, 20);
    return c;
  };

  SEC.fx = () => {
    const types = ['lightning', 'explosion', 'fire', 'smoke', 'heal', 'bless', 'plague', 'quake', 'dust', 'spark', 'splash', 'blood', 'whisper', 'ash', 'rain_drop'];
    const ps = [0.12, 0.35, 0.6, 0.85], cw = 150, ch = 150, c = mk(70 + ps.length * cw, types.length * ch / 1.25 + 10), x = c.getContext('2d');
    x.fillStyle = '#14161c'; x.fillRect(0, 0, c.width, c.height);
    const rowH = ch / 1.25;
    types.forEach((tp, i) => ps.forEach((p, j) => {
      const X = 70 + j * cw, Y = i * rowH;
      for (let a = 0; a < 5; a++) for (let b = 0; b < 4; b++) Sprites.drawTile(x, 3, X + a * 32, Y + b * 32, 32, (a + b * 3) & 7);
      const fx = { type: tp, x: 5 + i, y: 7 + j, ttl: 1, age: p, r: 2.2 };
      Sprites.drawFx(x, fx, X + cw / 2 - 5, Y + rowH * 0.62, 32, 5000 + p * 1000);
      if (j === 3) Sprites.drawFx(x, { type: tp, x: 5 + i, y: 7 + j, ttl: 1, age: 0.4, r: 2.2 }, X + cw - 22, Y + rowH * 0.8, 12, 5400);
      if (j === 0) label(x, tp, 4, Y + 20, '#fff');
    }));
    return c;
  };

  SEC.effects = () => {
    const c = mk(960, 640), x = c.getContext('2d');
    x.fillStyle = '#14161c'; x.fillRect(0, 0, c.width, c.height);
    for (let a = 0; a < 30; a++) for (let b = 0; b < 20; b++) Sprites.drawTile(x, 3, a * 32, b * 32, 32, (a * 3 + b) & 7);
    [0.3, 0.6, 0.88].forEach((p, i) => Sprites.drawEffect(x, 'meteor', { x: 3, y: 3, r: 2, eta: 100, t0: 0, p }, 90 + i * 150, 270, 32, 1000 + i * 300));
    Sprites.drawEffect(x, 'tornado', { x: 14, y: 3, dx: 0, dy: 0, until: 9, r: 2 }, 620, 230, 32, 1234);
    Sprites.drawEffect(x, 'tornado', { x: 18, y: 3, dx: 0, dy: 0, until: 9, r: 2 }, 740, 230, 32, 1500);
    Sprites.drawEffect(x, 'tornado', { x: 22, y: 3, dx: 0, dy: 0, until: 9, r: 2 }, 860, 230, 16, 1700);
    Sprites.drawEffect(x, 'rain', { x: 5, y: 10, r: 3 }, 130, 480, 32, 2000);
    Sprites.drawEffect(x, 'rain', { x: 5, y: 10, r: 6 }, 450, 500, 32, 2100);
    Sprites.drawEffect(x, 'quake', { x: 5, y: 10, r: 3 }, 800, 480, 32, 2200);
    return c;
  };

  // a little world scene: closest thing to what Render will produce, at in-game zoom
  SEC.scene = (o) => {
    const zoom = (o && o.zoom) || 4, W = 56, H = 38, ts = 16 * zoom, c = mk(W * ts, H * ts), x = c.getContext('2d');
    const T = Const.T, RES = Const.RES;
    function noise(px, py, s) { let v = 0, a = 1, f = 0.09, n = 0; for (let i = 0; i < 4; i++) { const xi = Math.floor(px * f), yi = Math.floor(py * f), fx = px * f - xi, fy = py * f - yi; const sm = t => t * t * (3 - 2 * t); const h = (a, b) => (Util.hash2(a, b, s + i) / 4294967295); const v00 = h(xi, yi), v10 = h(xi + 1, yi), v01 = h(xi, yi + 1), v11 = h(xi + 1, yi + 1); const v0 = v00 + (v10 - v00) * sm(fx), v1 = v01 + (v11 - v01) * sm(fx); v += (v0 + (v1 - v0) * sm(fy)) * a; n += a; a *= 0.5; f *= 2; } return v / n; }
    const tiles = [], looks = [];
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      let e = noise(i, j, 5) * 255 * 1.15 - 20 + (noise(i, j, 99) - 0.5) * 20;
      let t = Tiles.fromElev(Util.clamp(e, 0, 255));
      if (t === T.GRASS && noise(i, j, 33) > 0.58) t = T.FOREST;
      if (t === T.MOUNTAIN && noise(i, j, 71) > 0.66) t = T.LAVA;
      tiles.push(t); looks.push(Util.hash2(i, j, 3) & 7);
    }
    const frame = (o && o.frame) | 0;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const t = tiles[j * W + i];
      Sprites.drawTile(x, t, i * ts, j * ts, ts, looks[j * W + i] | ((t === 0 || t === 1 || t === 8) ? frame << 3 : 0));
    }
    x.imageSmoothingEnabled = false;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const t = tiles[j * W + i], hh = Util.hash2(i, j, 17) % 100;
      let k = 0, v = 0;
      if (t === T.GRASS) { if (hh < 5) { k = RES.TREE; v = hh % 4; } else if (hh < 8) { k = RES.BERRY; v = hh & 3; } else if (hh === 9) { k = RES.BERRY; v = 9; } }
      else if (t === T.HILL || t === T.SAND) { if (hh < 6) { k = [RES.ROCK, RES.IRON, RES.GOLD][hh % 3]; v = hh & 3; } }
      if (k) x.drawImage(Sprites.feature(k, v), i * ts, j * ts, ts, ts);
    }
    // buildings + units
    const bl = [[10, 12, 0, 5, 3], [13, 12, 0, 1, 2], [8, 12, 0, 2, 1], [11, 15, 0, 3, 2], [14, 15, 0, 6, 1], [16, 13, 0, 7, 1], [30, 10, 1, 5, 2], [32, 10, 1, 1, 1], [28, 11, 1, 4, 2], [30, 13, 1, 6, 1], [40, 22, 2, 5, 2], [42, 22, 2, 1, 2], [38, 23, 2, 2, 1], [40, 25, 2, 6, 2], [20, 20, 0, 1, 3], [22, 20, 1, 2, 1]];
    for (const b of bl) {
      const [bx, by, br, bt, bl2] = b;
      Sprites.drawTile(x, T.GRASS, bx * ts, by * ts, ts, 0);
      x.drawImage(Sprites.building(bt, br, bl2, true, KC[br]), bx * ts, by * ts, ts, ts);
    }
    let n = 0;
    for (const [ux, uy, r] of [[11, 13, 0], [12, 13, 0], [9, 13, 0], [12, 16, 0], [31, 12, 1], [32, 12, 1], [29, 12, 1], [39, 24, 2], [41, 24, 2], [43, 24, 2]]) {
      for (const st of ['adult', 'child', 'elder']) {
        n++;
        const dx = (n % 3) * 0.3, dy = ((n / 3) | 0) % 2 * 0.2;
        x.drawImage(Sprites.unit(r, st, n & 1, KC[r === 0 ? 0 : r === 1 ? 2 : 3], (n >> 1) & 3, (n >> 2) & 3, n & 3), (ux + dx) * ts, (uy + dy + (st === 'child' ? 0.9 : st === 'elder' ? 1.8 : 0)) * ts, ts, ts);
      }
    }
    return c;
  };

  // real-browser micro benchmarks (run with `node tests/sprites_sheet.mjs --perf`)
  window.__perf = () => {
    const out = {}, c = mk(800, 600), x = c.getContext('2d'), tints = [null, KC[0], KC[1], KC[2], KC[3]];
    const units = [];
    for (let i = 0; i < 1500; i++) units.push([i % 3, ['child', 'adult', 'adult', 'elder'][i % 4], i & 1, tints[i % 5], i % 4, (i >> 2) % 4, i & 3]);
    for (const u of units) Sprites.unit(u[0], u[1], u[2], u[3], u[4], u[5], u[6]);       // warm
    let t0 = performance.now();
    for (let f = 0; f < 100; f++) for (let i = 0; i < 1500; i++) { const u = units[i]; x.drawImage(Sprites.unit(u[0], u[1], (u[2] + f) & 1, u[3], u[4], u[5], u[6]), (i * 7) % 780, (i * 13) % 580, 16, 16); }
    out.units1500_frame_ms = (performance.now() - t0) / 100;
    t0 = performance.now();
    for (let f = 0; f < 100; f++) for (let j = 0; j < 38; j++) for (let i = 0; i < 56; i++) Sprites.drawTile(x, (i + j) % 9, i * 14, j * 14, 14, (i * 3 + j) & 15);
    out.tiles2128_frame_ms = (performance.now() - t0) / 100;
    for (const tp of ['lightning', 'explosion', 'fire', 'smoke', 'heal', 'bless', 'plague', 'quake', 'dust', 'spark', 'splash', 'blood', 'whisper', 'ash']) {
      t0 = performance.now();
      for (let i = 0; i < 300; i++) Sprites.drawFx(x, { type: tp, x: 3, y: 4, ttl: 1, age: (i % 20) / 20, r: 3 }, 400, 300, 24, i * 16);
      out['fx_' + tp + '_ms'] = +((performance.now() - t0) / 300).toFixed(4);
    }
    for (const k of ['meteor', 'tornado', 'rain', 'quake']) {
      t0 = performance.now();
      for (let i = 0; i < 300; i++) Sprites.drawEffect(x, k, { x: 3, y: 4, r: 4, eta: 100, t0: 0, p: (i % 20) / 20 }, 400, 300, 24, i * 16);
      out['eff_' + k + '_ms'] = +((performance.now() - t0) / 300).toFixed(4);
    }
    return out;
  };

  window.__sheet = {
    names: Object.keys(SEC),
    draw(name, o) {
      document.body.innerHTML = '';
      const c = SEC[name](o || {});
      document.body.appendChild(c);
      return { w: c.width, h: c.height };
    },
  };
})();
