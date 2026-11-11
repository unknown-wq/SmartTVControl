/* =====================================================================
 * 33_gfx_nuke.js — graphics of the «Ядерная бомба» power (sim side: 18_power_nuke.js). Client only, no DOM at load time (CONTRACT section 10.3).
 * OWNER: nuke power agent.
 *
 * Registers: icon 'nuke', unit tint + badge «Облучён» (u.rad > S.tick), and three persistent-effect layers over S.eff (drawn in this order, bottom to top):
 *   fallout    [{x,y,r,R,t0,until}]   scorched ground (dark decal under everything), pale-green radiation haze, trefoil signs on the rim, rising motes
 *   nukes      [{x,y,r,t0,eta,w,..}]  «Тревога»: pulsing hazard disc + zone rings + crosshair + the label «ТРЕВОГА» with a countdown, the bomb falling on a
 *                                     near-vertical path with a fiery trail and a growing shadow (nothing is drawn once the wave has started: the cloud takes over)
 *   mushrooms  [{x,y,r,t0,until}]     white-hot fireball, two shock rings and a ground flash, then the mushroom cloud: glow, dust skirt, stem rising, cap spreading,
 *                                     colour cooling hot -> brown -> grey, embers and ash falling, fading out
 * Every sprite is baked once per blast radius into small offscreen canvases (lazily, a few per frame, warmed up while the bomb falls) and blitted with a
 * handful of drawImage calls; nothing allocates per frame. The sim timing constants below must match 18_power_nuke.js.
 * ===================================================================== */

const GfxNuke = (() => {
  const TAU = Math.PI * 2;
  const WAVE_TICKS = 8, MUSH_LIFE = 220;          // keep in sync with PowerNuke.consts
  const P = 10;                                   // baked pixels per tile (cloud parts)
  const P2 = 6;                                   // baked pixels per tile (ground decals: scorch, haze)
  const SCORCH_K = 0.92;                          // scorch decal radius / blast radius
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const easeOut = (x, k) => 1 - Math.pow(1 - clamp(x, 0, 1), k || 2);
  const hash = (n) => { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };

  // ------------------------------------------------------------------ colours (packed ABGR like Sprites)
  const rgba = (r, g, b, a) => ((((a === undefined ? 255 : a) & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
  const hexRGB = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  // one 5-band ramp (shadow -> highlight) per cooling stage: white-hot fire, red-orange fire, glowing brown, grey smoke
  const PAL = [
    ['#6a1a0e', '#d03c14', '#ff7a18', '#ffc232', '#fff6c4'],
    ['#3e1410', '#8a2812', '#d44e18', '#ff8620', '#ffd05a'],
    ['#2c1c1e', '#5e3632', '#8c5440', '#bf8258', '#ecbe8a'],
    ['#241e28', '#443c46', '#6c646e', '#978f99', '#c6c0ca'],
  ].map(r => r.map(hexRGB));
  // RT[stage][band][heat 0..15]: heat blends a pixel towards the previous (hotter) stage - embers keep glowing inside a cooling cloud
  const RT = PAL.map((pal, st) => pal.map((c, bd) => { const h = PAL[Math.max(0, st - 1)][bd], out = []; for (let q = 0; q < 16; q++) { const t = st === 0 ? 0 : q / 15 * 0.9; out.push(rgba(c[0] + (h[0] - c[0]) * t, c[1] + (h[1] - c[1]) * t, c[2] + (h[2] - c[2]) * t)); } return out; }));
  const OUT = rgba(28, 14, 20);
  const BAY = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const bay = (x, y) => (BAY[((y & 3) << 2) | (x & 3)] + 0.5) / 16;
  function mulberry(seed) { let s = seed | 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // ------------------------------------------------------------------ tiny pixel buffer (own copy: Sprites keeps its Buf private)
  class PB {
    constructor(w, h) { this.w = w; this.h = h; this.d = new Uint32Array(w * h); }
    set(x, y, c) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c; }
    rect(x, y, w, h, c) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c); }
    disc(cx, cy, r, c) { const r2 = r * r + 0.3; for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) { const dx = x - cx, dy = y - cy; if (dx * dx + dy * dy <= r2) this.set(x, y, c); } }
    art(rows, pal, ox, oy) { for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) { const ch = rows[j][i]; if (ch === '.' || ch === ' ') continue; const c = pal[ch]; if (c !== undefined) this.set(ox + i, oy + j, c); } }
    outline(col) {
      const w = this.w, h = this.h, d = this.d, s = d.slice();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if ((s[i] >>> 24) > 40) continue;
        if ((y + 1 < h && (s[i + w] >>> 24) > 200) || (x + 1 < w && (s[i + 1] >>> 24) > 200) || (x > 0 && (s[i - 1] >>> 24) > 200) || (y > 0 && (s[i - w] >>> 24) > 200)) d[i] = col;
      }
      return this;
    }
    toCanvas() {
      const c = document.createElement('canvas'); c.width = this.w; c.height = this.h;
      const g = c.getContext('2d'), id = g.createImageData(this.w, this.h);
      new Uint32Array(id.data.buffer).set(this.d);
      g.putImageData(id, 0, 0);
      return c;
    }
  }
  // light from the top-left, towards the viewer
  const LX = -0.52, LY = -0.62, LZ = 0.58;
  /** a shaded sphere painted over what is there (painter's algorithm); shade(l, x, y, nx, ny) -> packed colour or 0 */
  function puff(pb, cx, cy, r, shade) {
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(pb.w - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(pb.h - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const nx = (x + 0.5 - cx) / r, ny = (y + 0.5 - cy) / r, q = nx * nx + ny * ny;
      if (q > 1) continue;
      const l = nx * LX + ny * LY + Math.sqrt(1 - q) * LZ;
      const c = shade(l, x, y, nx, ny);
      if (c) pb.d[y * pb.w + x] = c;
    }
  }

  // ------------------------------------------------------------------ icon: a mushroom cloud (14x14 glyph, outline added by Sprites)
  GfxPlugins.icons.nuke = (b, IP) => {
    b.art([
      '...ooyyyyoo...',
      '..oyywwyyyyoo.',
      '.oywwyyyyyyyyO',
      'oywyyoyyyyoyyO',
      'oyyyyyyyyyyyOR',
      'ooyoyyyyyyoOOR',
      '.ROOooooooOOR.',
      '..RRrrrrrrRR..',
      '...nNOyyONn...',
      '....nOyyON....',
      '....nnoyONN...',
      '...nnoOyyONN..',
      '..nnNnnOOnNNn.',
      '.NNNNNNNNNNNN.',
    ], IP, 0, 0);
  };

  // ------------------------------------------------------------------ irradiated units: pale-green tint + badge
  GfxPlugins.addUnitTint('rad', 'rgba(140,255,90,0.46)');
  UIPlugins.unitBadges.push((u) => (u.rad > S.tick ? { t: 'Облучён', cls: 'bad' } : null));

  // ------------------------------------------------------------------ baked parts
  function bakeCap(R, stage, variant) {
    const W = Math.ceil(1.46 * R * P), H = Math.ceil(0.72 * R * P), pb = new PB(W, H), rnd = mulberry(R * 1315423911 + variant * 97 + 5);
    const cx = W * 0.5, yb = H * 0.5, ax = W * 0.5 - 2, ay = H * 0.5 - 1;
    const list = [];
    for (let k = 0; k < 7; k++) { const t = k / 6; list.push([cx - ax * 0.8 + t * ax * 1.6, yb + H * 0.2 + (rnd() - 0.5) * H * 0.04, H * (0.15 + 0.04 * rnd())]); }       // underside
    for (let k = 0; k < 8; k++) list.push([cx + (rnd() - 0.5) * ax * 1.2, yb - rnd() * ay * 0.5 + H * 0.02, H * (0.22 + 0.07 * rnd())]);                            // body
    list.push([cx - ax + H * 0.27, yb + H * 0.04, H * 0.27], [cx + ax - H * 0.27, yb + H * 0.04, H * 0.27]);                                                         // rolled lips
    const nD = R > 9 ? 11 : 9;
    for (let i = 0; i < nD; i++) { const phi = Math.PI * (0.07 + 0.86 * (i + 0.5) / nD), r = H * (0.17 + 0.07 * rnd()); list.push([cx - Math.cos(phi) * (ax - r * 0.95), yb - Math.sin(phi) * (ay - r * 0.95) + H * 0.02, r]); }   // dome ring
    for (let i = 0; i < 9; i++) { const a = rnd() * TAU, d = rnd(); list.push([cx + Math.cos(a) * d * ax * 0.78, yb - H * 0.08 + Math.sin(a) * d * ay * 0.5, H * (0.07 + 0.05 * rnd())]); }   // small billows on top of the rest
    const shade = (l, x, y) => {
      const hx = (x - cx) / (ax * 0.5), hy = (y - (yb + H * 0.14)) / (H * 0.4), hot = Math.exp(-(hx * hx + hy * hy));
      let v = Math.pow(l * 0.5 + 0.5, 1.12);
      if (y > yb + H * 0.16) v -= Math.min(0.6, (y - yb - H * 0.16) / (H * 0.4) * 0.65);      // dark underside
      if (stage === 0) v += hot * 0.2;
      return RT[stage][clamp(Math.floor(v * 4.99 + (bay(x, y) - 0.5) * 0.9), 0, 4)][Math.round(clamp(hot * 1.15, 0, 1) * 15)];
    };
    for (let i = 0; i < list.length; i++) puff(pb, list[i][0], list[i][1], list[i][2], shade);
    return pb.outline(OUT);
  }
  function bakeStem(R, stage) {                   // a spine plus cauliflower lumps, a glowing core line, flared foot
    const W = (Math.ceil(0.66 * R * P) | 1), H = 100, pb = new PB(W, H), cx = W / 2, rnd = mulberry(R * 7717 + 3);
    const prof = (t) => W * (0.17 + 0.23 * Math.pow(t, 2.4));
    const list = [];
    for (let i = 0; i < 12; i++) { const t = i / 11; list.push([cx + Math.sin(i * 2.1) * W * 0.02, 5 + t * (H - 12), prof(t) * 0.68]); }
    const lumps = [];
    for (let i = 0; i < 50; i++) { const t = rnd(), w = prof(t); lumps.push([cx + (rnd() * 2 - 1) * w * 0.62, 4 + t * (H - 9), W * (0.07 + 0.07 * rnd()) * (0.8 + 0.6 * t)]); }
    lumps.sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < lumps.length; i++) list.push(lumps[i]);
    list.push([cx - W * 0.22, H - 8, W * 0.2], [cx + W * 0.22, H - 8, W * 0.2], [cx - W * 0.08, H - 6, W * 0.22], [cx + W * 0.1, H - 6, W * 0.2]);
    const shade = (l, x, y) => {
      const core = Math.exp(-Math.pow((x - cx) / (W * 0.15), 2)) * (1 - 0.4 * y / H);
      const v = Math.pow(l * 0.5 + 0.5, 1.1) + core * 0.16 - 0.04;
      return RT[stage][clamp(Math.floor(v * 4.99 + (bay(x, y) - 0.5) * 0.9), 0, 4)][Math.round(clamp(core * 1.2, 0, 1) * 15)];
    };
    for (let i = 0; i < list.length; i++) puff(pb, list[i][0], list[i][1], list[i][2], shade);
    return pb.outline(OUT);
  }
  function bakeSkirt(R, stage) {                  // billowing dust skirt at the base
    const W = Math.ceil(1.5 * R * P), H = Math.ceil(0.42 * R * P), pb = new PB(W, H), rnd = mulberry(R * 4241 + 11);
    const cx = W / 2, cy = H * 0.58;
    const shade = (l, x, y) => {
      const v = Math.pow(l * 0.5 + 0.5, 1.1) - Math.max(0, (y - cy) / H) * 0.35;
      return RT[stage][clamp(Math.floor(v * 4.99 + (bay(x, y) - 0.5) * 0.9), 0, 4)][stage === 0 ? 0 : 7];
    };
    for (let i = 0; i < 17; i++) { const t = i / 16, a = W * 0.5 - H * 0.3; puff(pb, cx - a + t * a * 2, cy + Math.sin(t * Math.PI) * -H * 0.05 + (rnd() - 0.5) * H * 0.14, H * (0.2 + 0.1 * Math.sin(t * Math.PI) + 0.06 * rnd()), shade); }
    for (let i = 0; i < 12; i++) puff(pb, cx + (rnd() - 0.5) * W * 0.62, cy - H * 0.08 - rnd() * H * 0.16, H * (0.16 + 0.1 * rnd()), shade);
    return pb.outline(OUT);
  }
  let glowCv = null, fireCv = null, signCv = null, bombCv = null;
  function bakeGlow() {                           // soft light disc as a banded, dithered pixel sprite (blitted nearest-neighbour: a smoothed blit costs 6x more)
    const S0 = 80, pb = new PB(S0, S0);
    for (let y = 0; y < S0; y++) for (let x = 0; x < S0; x++) {
      const d = Math.hypot(x + 0.5 - S0 / 2, y + 0.5 - S0 / 2) / (S0 / 2);
      if (d >= 1) continue;
      const a = Math.pow(1 - d, 1.7), lvl = clamp(Math.floor(a * 9 + (bay(x, y) - 0.5) * 1.1), 0, 8);
      if (lvl <= 0) continue;
      pb.d[y * S0 + x] = rgba(255 - 30 * d, 232 - 80 * d, 160 - 90 * d, Math.round(lvl * 28));
    }
    return pb;
  }
  function bakeFire() {                           // white-hot fireball: lumpy cauliflower, bright core and orange / red rim, no outline (blends into the glow)
    const S0 = 56, pb = new PB(S0, S0), rnd = mulberry(99), c = S0 / 2;
    const shade = (l, x, y, nx, ny) => { const rr = Math.sqrt(nx * nx + ny * ny), v = 0.28 + 0.62 * Math.pow(1 - rr, 0.85) + 0.14 * l; return RT[0][clamp(Math.floor(v * 4.99 + (bay(x, y) - 0.5) * 0.9), 0, 4)][0]; };
    for (let i = 0; i < 9; i++) { const a = i / 9 * TAU + rnd() * 0.5, d = S0 * (0.2 + 0.05 * rnd()); puff(pb, c + Math.cos(a) * d, c + Math.sin(a) * d * 0.92, S0 * (0.17 + 0.05 * rnd()), shade); }
    puff(pb, c, c, S0 * 0.34, shade);
    puff(pb, c - 3, c - 4, S0 * 0.17, (l, x, y, nx, ny) => RT[0][clamp(3 + Math.floor((1 - Math.sqrt(nx * nx + ny * ny)) * 2.2), 3, 4)][0]);
    return pb;
  }
  function bakeScorch(R) {                        // blackened ground: soft dark disc with radial blast streaks and a glassy centre (2x2-block dither, 7 levels)
    const rad = SCORCH_K * R * P2, S0 = Math.ceil(rad * 2) + 2, pb = new PB(S0, S0), rnd = mulberry(R * 31 + 7);
    const ph = [rnd() * 6, rnd() * 6];
    for (let y = 0; y < S0; y++) for (let x = 0; x < S0; x++) {
      const dx = x + 0.5 - S0 / 2, dy = y + 0.5 - S0 / 2, d = Math.hypot(dx, dy) / rad;
      if (d >= 1) continue;
      const th = Math.atan2(dy, dx), st = 0.76 + 0.14 * Math.sin(th * 9 + ph[0]) + 0.1 * Math.sin(th * 23 + ph[1]);
      let a = Math.pow(1 - d, 0.95) * 0.8 * st;
      if (d < 0.12) a = 0.85;
      const lvl = clamp(Math.floor(a * 7.4 + (bay(x >> 1, y >> 1) - 0.5) * 1.0), 0, 7);
      if (lvl <= 0) continue;
      pb.d[y * S0 + x] = rgba(34 - lvl * 2, 22 - lvl, 16, Math.round(lvl * 26));
    }
    return pb;
  }
  function bakeHaze(R) {                          // pale-green radiation haze: dithered disc + a bright rim
    const rad = 0.74 * R * P2, S0 = Math.ceil(rad * 2) + 2, pb = new PB(S0, S0);
    for (let y = 0; y < S0; y++) for (let x = 0; x < S0; x++) {
      const dx = x + 0.5 - S0 / 2, dy = y + 0.5 - S0 / 2, d = Math.hypot(dx, dy) / rad;
      if (d >= 1) continue;
      if (d > 0.93) { if (((x + y) & 3) < 2) pb.d[y * S0 + x] = rgba(190, 255, 90, 215); continue; }
      const a = 0.13 + 0.2 * (1 - d) * (1 - d);
      if (a * 5 + (bay(x, y) - 0.5) * 1.3 < 0.62) continue;
      pb.d[y * S0 + x] = rgba(140, 255, 80, Math.round(110 + 80 * (1 - d)));
    }
    return pb;
  }
  function bakeSign() {                           // radiation trefoil on a yellow disc, 13x13
    const S0 = 13, pb = new PB(S0, S0), c = (S0 - 1) / 2;
    const Y = rgba(255, 214, 40), K = rgba(26, 18, 30);
    for (let y = 0; y < S0; y++) for (let x = 0; x < S0; x++) {
      const dx = x - c, dy = y - c, d = Math.hypot(dx, dy);
      if (d > 6.2) continue;
      let col = Y;
      if (d > 5.2) col = K;
      else if (d < 1.4) col = K;
      else if (d > 1.9 && d < 4.9) { const th = (Math.atan2(dy, dx) + TAU + Math.PI / 6) % (TAU / 3); if (th < TAU / 6) col = K; }
      pb.d[y * S0 + x] = col;
    }
    return pb;
  }
  function bakeBomb() {                           // 13x32, nose down, light top-left: dark steel egg, yellow bands, red tail fins and nose
    const pb = new PB(13, 32), steel = [rgba(18, 22, 32), rgba(34, 44, 62), rgba(58, 74, 102), rgba(94, 116, 152), rgba(150, 176, 212)];
    const fin = [rgba(110, 20, 26), rgba(190, 40, 44), rgba(240, 90, 72)];
    const egg = (cx, cy, rx, ry) => {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry, q = nx * nx + ny * ny;
        if (q > 1) continue;
        const l = nx * LX + ny * LY + Math.sqrt(1 - q) * LZ;
        pb.set(x, y, steel[clamp(Math.floor(Math.pow(l * 0.5 + 0.5, 1.25) * 4.99 + (bay(x, y) - 0.5) * 0.6), 0, 4)]);
      }
    };
    // tail: a cone from the body up to a narrow boom, with two big fins
    for (let y = 3; y <= 11; y++) { const hw = 1 + Math.floor((y - 3) * 0.55); for (let x = 6 - hw; x <= 6 + hw; x++) pb.set(x, y, steel[x < 6 ? 2 : 1]); }
    for (let y = 0; y <= 9; y++) {
      const w = 1 + Math.floor((9 - y) * 0.2 + (y > 6 ? 1 : 0)), off = Math.floor((9 - y) * 0.35);
      for (let k = 0; k < w + 1; k++) { pb.set(2 - off + k, y, fin[k === 0 ? 2 : 1]); pb.set(10 + off - k, y, fin[k === 0 ? 1 : 0]); }
      pb.set(2 - off + w + 1, y, fin[0]); pb.set(10 + off - w - 1, y, fin[0]);
    }
    pb.rect(5, 0, 3, 4, steel[1]); pb.rect(5, 0, 1, 4, steel[2]);
    egg(6.5, 20, 5.7, 10.2);
    pb.rect(1, 15, 11, 2, rgba(255, 214, 40)); pb.rect(1, 16, 11, 1, rgba(201, 154, 26)); pb.set(6, 15, rgba(26, 18, 30)); pb.set(6, 16, rgba(26, 18, 30));
    pb.rect(2, 23, 9, 1, rgba(255, 214, 40));
    pb.rect(5, 28, 3, 3, fin[1]); pb.rect(5, 28, 1, 3, fin[2]); pb.rect(6, 30, 2, 1, fin[0]);
    return pb.outline(OUT);
  }
  // pixel font 5x7 for «ТРЕВОГА» and the countdown digits
  const GLYPH = {
    'Т': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'], 'Р': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    'Е': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'], 'В': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
    'О': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], 'Г': ['#####', '#....', '#....', '#....', '#....', '#....', '#....'],
    'А': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'], '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'], '3': ['.###.', '#...#', '....#', '..##.', '....#', '#...#', '.###.'],
    '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'], '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    '6': ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'], '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
    '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'], '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.###.'],
  };
  function bakeText(str, col) {
    const w = str.length * 6 - 1 + 2, pb = new PB(w, 9), k = rgba(26, 14, 20);
    for (let i = 0; i < str.length; i++) {
      const g = GLYPH[str[i]]; if (!g) continue;
      for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) if (g[y][x] === '#') pb.set(1 + i * 6 + x, 1 + y, col);
    }
    return pb.outline(k);
  }

  // ------------------------------------------------------------------ kits: everything baked for one blast radius, built lazily a few parts per frame
  const kits = new Map();
  let cvCount = 0;
  function job(kit, fn) { kit.q.push(fn); }
  function makeKit(R) {
    const kit = { R, q: [], cap: new Array(12), stem: new Array(4), skirt: new Array(4), scorch: null, haze: null };
    const cv = (pb) => { cvCount++; return pb.toCanvas(); };
    job(kit, () => { kit.cap[0] = cv(bakeCap(R, 0, 0)); });
    job(kit, () => { kit.stem[0] = cv(bakeStem(R, 0)); });
    job(kit, () => { kit.skirt[0] = cv(bakeSkirt(R, 0)); });
    job(kit, () => { kit.scorch = cv(bakeScorch(R)); });
    job(kit, () => { kit.haze = cv(bakeHaze(R)); });
    for (let v = 1; v < 3; v++) job(kit, () => { kit.cap[v] = cv(bakeCap(R, 0, v)); });
    for (let s = 1; s < 4; s++) {
      job(kit, () => { kit.stem[s] = cv(bakeStem(R, s)); });
      job(kit, () => { kit.skirt[s] = cv(bakeSkirt(R, s)); });
      for (let v = 0; v < 3; v++) job(kit, () => { kit.cap[s * 3 + v] = cv(bakeCap(R, s, v)); });
    }
    return kit;
  }
  function kitFor(R) {
    R = clamp(Math.round(R), 4, 16);
    let k = kits.get(R);
    if (!k) {
      if (kits.size >= 9) { const first = kits.keys().next().value; kits.delete(first); }
      k = makeKit(R); kits.set(R, k);
    }
    return k;
  }
  function pump(kit, n) { while (n-- > 0 && kit.q.length) { const j = kit.q.shift(); try { j(); } catch (e) { /* a part that fails to bake is simply skipped */ } } }
  function shared() {
    if (!glowCv) { glowCv = bakeGlow().toCanvas(); fireCv = bakeFire().toCanvas(); signCv = bakeSign().toCanvas(); bombCv = bakeBomb().toCanvas(); cvCount += 4; }
  }
  const textCache = new Map();
  function textCv(str, col, key) { const k = key + str; let c = textCache.get(k); if (!c) { c = bakeText(str, col).toCanvas(); textCache.set(k, c); cvCount++; } return c; }
  const COL_RED = rgba(255, 70, 56), COL_WHITE = rgba(255, 255, 255), COL_YEL = rgba(255, 222, 60);

  // ------------------------------------------------------------------ drawing helpers
  function off(ctx, H, x0, y0, x1, y1) { const s = H.screen(ctx); return x1 < 0 || y1 < 0 || x0 > s.w || y0 > s.h; }
  /** nearest-neighbour blit (crisp pixels and ~6x cheaper than a smoothed one); smoothing only when the sprite is shrunk by more than 30% (far zoom) */
  function blit(ctx, cv, x, y, w, h) {
    if (!cv || w < 1 || h < 1) return;
    ctx.imageSmoothingEnabled = w < cv.width * 0.7;
    ctx.drawImage(cv, Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  }
  function sq(ctx, x, y, s) { ctx.fillRect(Math.round(x - s / 2), Math.round(y - s / 2), Math.max(1, Math.round(s)), Math.max(1, Math.round(s))); }
  /** a circle path (the game's own brush preview is vector too: a handful of calls instead of hundreds of pixel squares) */
  function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); }

  // ------------------------------------------------------------------ fallout: scorched ground + haze + signs + motes
  function drawFallout(ctx, e, px, py, scale, now, H, alpha) {
    if (typeof document === 'undefined') return;
    const Rb = e.R > 0 ? e.R : (e.r > 0 ? e.r / 0.7 : 8), r = e.r > 0 ? e.r : Rb * 0.7;
    const life = e.until - e.t0, age = S.tick + alpha - e.t0;
    if (!(life > 0) || age < 0.5) return;
    const I = clamp(1 - age / life, 0, 1);
    const ext = Rb * (SCORCH_K + 0.03) * scale;
    if (off(ctx, H, px - ext, py - ext, px + ext, py + ext)) return;
    const kit = kitFor(Rb); pump(kit, 1);
    const u = scale / 16, hz = r * scale;
    // scorched ground: strongest at first, fades with the fallout
    if (kit.scorch) { ctx.globalAlpha = clamp(0.35 + I * 1.1, 0, 1) * clamp(age / 6, 0, 1); const sd = 2 * SCORCH_K * Rb * scale; blit(ctx, kit.scorch, px - sd / 2, py - sd / 2, sd, sd); }
    // radiation haze
    const pulse = 0.88 + 0.12 * Math.sin(now / 520);
    if (kit.haze) { ctx.globalAlpha = clamp(Math.pow(I, 0.7), 0, 1) * 0.78 * pulse * clamp(age / 10, 0, 1); const hd = 2 * 0.74 * Rb * scale; blit(ctx, kit.haze, px - hd / 2, py - hd / 2, hd, hd); }
    if (scale < 5 || I < 0.08) { ctx.globalAlpha = 1; return; }
    // trefoil signs on the rim and a few rising motes
    shared();
    ctx.globalAlpha = clamp(Math.pow(I, 0.5), 0, 1) * (0.7 + 0.3 * Math.sin(now / 380));
    const ss = Math.max(9, Math.min(scale * 1.1, 40));
    for (let k = 0; k < 6; k++) { const a = k * TAU / 6 + 0.5; blit(ctx, signCv, px + Math.cos(a) * hz * 0.97 - ss / 2, py + Math.sin(a) * hz * 0.97 - ss / 2, ss, ss); }
    const n = scale > 12 ? 18 : 10;
    for (let i = 0; i < n; i++) {
      const t = ((now / 2600) + hash(i * 3.1 + e.t0)) % 1, a = hash(i * 7.7 + 1) * TAU, d = Math.sqrt(hash(i * 5.3 + 2)) * r * 0.92;
      ctx.globalAlpha = Math.sin(t * Math.PI) * 0.75 * clamp(I * 1.5, 0, 1);
      ctx.fillStyle = i & 1 ? '#c8ff6a' : '#8aff4a';
      sq(ctx, px + Math.cos(a) * d * scale, py + Math.sin(a) * d * scale * 0.9 - t * scale * 1.1, Math.max(2, u * 1.6));
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ the bomb: reticle, hazard rings, falling bomb
  const FALL_H = 24;                              // tiles above the target the bomb starts from
  function drawBombs(ctx, e, px, py, scale, now, H, alpha) {
    if (e.w > 0 || typeof document === 'undefined') return;
    const R = e.r > 0 ? e.r : 8, rr = R * scale, u = scale / 16;
    const span = e.eta - e.t0 > 0 ? e.eta - e.t0 : 25;
    const p = clamp((S.tick + alpha - e.t0) / span, 0, 1);
    if (off(ctx, H, px - rr - 10, py - rr - FALL_H * scale - 40, px + rr + 10, py + rr + 40)) return;
    const kit = kitFor(R); pump(kit, 4); shared();
    const pulse = 0.5 + 0.5 * Math.sin(now / 110), lwid = Math.max(2, u * 1.5), dash = Math.max(6, scale * 0.45);
    // hazard disc + zone rings: total destruction (0.45 R), firestorm (0.8 R), the blast edge (R, marching dashes)
    ctx.fillStyle = '#ff2a1a'; ctx.globalAlpha = 0.08 + 0.07 * pulse + 0.06 * p; circle(ctx, px, py, rr); ctx.fill();
    ctx.globalAlpha = 0.16 + 0.08 * pulse; circle(ctx, px, py, rr * 0.45); ctx.fill();
    ctx.strokeStyle = '#ff4a30'; ctx.lineWidth = lwid; ctx.globalAlpha = 0.55 + 0.35 * pulse; circle(ctx, px, py, rr * 0.45); ctx.stroke();
    ctx.strokeStyle = '#ffb040'; ctx.lineWidth = Math.max(1.5, lwid * 0.8); ctx.globalAlpha = 0.6; ctx.setLineDash([dash * 0.6, dash * 0.9]); circle(ctx, px, py, rr * 0.8); ctx.stroke();
    ctx.lineWidth = lwid * 1.5; ctx.globalAlpha = 0.95; ctx.setLineDash([dash, dash]); ctx.lineDashOffset = -now / 40 * (scale / 16);
    ctx.strokeStyle = '#ffffff'; circle(ctx, px, py, rr); ctx.stroke();
    ctx.lineDashOffset -= dash; ctx.strokeStyle = '#ff3a26'; circle(ctx, px, py, rr); ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0;
    // crosshair
    const cr = scale * (0.8 + 0.25 * pulse);
    ctx.globalAlpha = 0.95; ctx.fillStyle = pulse > 0.5 ? '#ff4a30' : '#ffe27a';
    const th = Math.max(2, u * 1.5);
    ctx.fillRect(Math.round(px - scale * 2.6), Math.round(py - th / 2), Math.round(scale * 1.7), Math.round(th));
    ctx.fillRect(Math.round(px + scale * 0.9), Math.round(py - th / 2), Math.round(scale * 1.7), Math.round(th));
    ctx.fillRect(Math.round(px - th / 2), Math.round(py - scale * 2.6), Math.round(th), Math.round(scale * 1.7));
    ctx.fillRect(Math.round(px - th / 2), Math.round(py + scale * 0.9), Math.round(th), Math.round(scale * 1.7));
    H.ringRows(ctx, px, py, cr, th, Math.max(1, u));
    // label with the countdown
    const secs = Math.max(0, Math.ceil((e.eta - (S.tick + alpha)) / 10));
    const lp = Math.max(2, Math.round(scale / 4.6)), flashOn = ((now / 180) | 0) % 2 === 0;
    const lw = textCv('ТРЕВОГА', COL_RED, 'r'), lw2 = textCv('ТРЕВОГА', COL_WHITE, 'w'), dg = textCv(String(secs), COL_YEL, 'y');
    const ly = py + scale * 3.2;
    ctx.globalAlpha = 1;
    blit(ctx, flashOn ? lw : lw2, px - (lw.width * lp) / 2 - dg.width * lp * 0.6, ly, lw.width * lp, lw.height * lp);
    blit(ctx, dg, px + (lw.width * lp) / 2 - dg.width * lp * 0.6 + lp * 3, ly, dg.width * lp, dg.height * lp);
    const sg = lp * 11;
    blit(ctx, signCv, px - (lw.width * lp) / 2 - dg.width * lp * 0.6 - sg - lp * 2, ly - lp, sg, sg);
    // ground shadow, growing as the bomb comes down
    ctx.fillStyle = '#000'; ctx.globalAlpha = 0.18 + 0.3 * p * p; ctx.save(); ctx.translate(px, py + u * 2); ctx.scale(1, 0.55); circle(ctx, 0, 0, scale * (0.3 + 0.9 * p)); ctx.fill(); ctx.restore();
    // the bomb: nearly vertical path, slight lean, accelerating
    const h = FALL_H * (1 - p * p), bx = px + 0.1 * h * scale, by = py - h * scale;
    if (kit.cap[0] || true) {
      for (let i = 18; i >= 1; i--) {                                    // trail: white-hot -> orange -> smoke, widening
        const t = i / 18, d = t * scale * (3 + 8 * (1 - p * 0.4)), tx = bx + 0.1 * d + Math.sin(now / 70 + i * 1.7) * u * 1.6, ty = by - d;
        ctx.globalAlpha = (1 - t * 0.85) * 0.95;
        ctx.fillStyle = t < 0.18 ? '#fff4b4' : t < 0.4 ? '#ffb43c' : t < 0.66 ? '#ff6a1e' : '#7a6462';
        sq(ctx, tx, ty, scale * (0.5 + 0.8 * t));
      }
      ctx.globalAlpha = 0.45 + 0.2 * pulse; ctx.fillStyle = '#ffb040'; sq(ctx, bx, by - scale * 1.4, scale * 2.1);
      ctx.globalAlpha = 0.35; ctx.fillStyle = '#fff0b0'; sq(ctx, bx, by - scale * 1.4, scale * 1.1);
      ctx.globalAlpha = 1;
      const bw = scale * 1.55, bh = bw * 32 / 13;
      ctx.translate(bx, by); ctx.rotate(0.1);
      blit(ctx, bombCv, -bw / 2, -bh * 0.62, bw, bh);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ the cloud
  const SW = [0, 24, 40, 75, 95, 140, 170];       // stage timeline: [hot ... brown ... grey] in ticks since the detonation
  function stageOf(a) {                           // -> float 0..3
    if (a < 24) return 0; if (a < 40) return (a - 24) / 16; if (a < 75) return 1; if (a < 95) return 1 + (a - 75) / 20;
    if (a < 140) return 2; if (a < 170) return 2 + (a - 140) / 30; return 3;
  }
  function drawMushroom(ctx, e, px, py, scale, now, H, alpha) {
    if (typeof document === 'undefined') return;
    const life = e.until - e.t0 > 0 ? e.until - e.t0 : MUSH_LIFE, age = S.tick + alpha - e.t0;
    if (age < 0 || age > life) return;
    const R = e.r > 0 ? e.r : 8, u = scale / 16;
    const capHt = 0.72 * R, HC = 0.98 * R + 2.1;
    if (off(ctx, H, px - R * scale * 1.3, py - (HC + capHt) * scale - 20, px + R * scale * 1.3, py + R * scale * 1.3)) return;
    const kit = kitFor(R); pump(kit, 2); shared();
    const fade = age > life - 45 ? clamp((life - age) / 45, 0, 1) : 1, k = scale / P;
    ctx.save();
    // ground flash + shock rings (the sim front: radius R * (1 - (1 - k/8)^1.5), then a little further while fading)
    if (age < 22) {
      const front = age < WAVE_TICKS ? 1 - Math.pow(1 - age / WAVE_TICKS, 1.5) : 1 + (age - WAVE_TICKS) * 0.028, fa = clamp(1 - (age - 4) / 16, 0, 1);
      const rs = R * scale * front, pr = u * Math.max(1, Math.ceil(rs / 40 / u));
      ctx.globalAlpha = 0.34 * clamp(1 - age / 12, 0, 1); ctx.fillStyle = '#ffe6a0'; circle(ctx, px, py, rs); ctx.fill();            // ground flash
      ctx.globalAlpha = 0.3 * fa; ctx.fillStyle = '#2a1c14'; H.ringRows(ctx, px, py, rs * 0.92, Math.max(u * 3, rs * 0.12), pr);        // dust wall behind the front
      ctx.globalAlpha = fa; ctx.fillStyle = age < 10 ? '#ffffff' : '#ffd890'; H.ringRows(ctx, px, py, rs, Math.max(u * 2.2, scale * 0.3 * (1 - age / 30)), pr);   // the front
    }
    // fireball at ground zero: grows fast, lifts off and becomes the cap
    if (age < 24) {
      const rf = R * scale * 0.5 * easeOut(age / 10, 2), fa = age < 9 ? 1 : clamp((24 - age) / 15, 0, 1);
      ctx.globalAlpha = 0.9 * fa; blit(ctx, glowCv, px - rf * 1.9, py - rf * 1.5 - rf * 0.5, rf * 3.8, rf * 3.8);
      ctx.globalAlpha = fa; blit(ctx, fireCv, px - rf, py - rf * 1.4, rf * 2, rf * 2);
    }
    // cloud geometry
    const rise = easeOut((age - 1.5) / 80, 2.3), spread = clamp((age - 60) / 140, 0, 1);
    const sc = (0.26 + 0.74 * Math.pow(rise, 0.7)) * (1 + 0.15 * spread);
    const sway = Math.sin(now / 1700 + e.x) * u * 1.6;
    const cw = kit.cap[0] ? kit.cap[0].width * k * sc : 0, chh = kit.cap[0] ? kit.cap[0].height * k * sc * (1 - 0.14 * spread) : 0;
    const ccy = py - HC * rise * scale, ccx = px + sway * rise;
    const sf = stageOf(age), s0 = Math.min(3, Math.floor(sf)), fr = sf - s0, v = ((now / 260) | 0) % 3;
    const warm = clamp(1 - sf / 2.2, 0, 1);
    // glow behind everything
    if (rise > 0.02) { const gr = (cw * 0.5 + scale * 1.2) * (0.92 + 0.08 * Math.sin(now / 300)); ctx.globalAlpha = 0.6 * warm * fade; blit(ctx, glowCv, ccx - gr, ccy - gr * 0.85, gr * 2, gr * 1.7); }
    // dust skirt at the base
    const ks = easeOut(age / 55, 2);
    const skCv = kit.skirt[s0] || kit.skirt[0];
    if (skCv && age > 1) {
      const sw2 = skCv.width * k * (0.3 + 0.7 * ks), sh2 = skCv.height * k * (0.4 + 0.6 * ks);
      ctx.globalAlpha = fade * clamp(age / 5, 0, 1); blit(ctx, skCv, px - sw2 / 2, py - sh2 * 0.62, sw2, sh2);
      if (fr > 0 && kit.skirt[s0 + 1]) { ctx.globalAlpha = fade * fr; blit(ctx, kit.skirt[s0 + 1], px - sw2 / 2, py - sh2 * 0.62, sw2, sh2); }
    }
    // stem: from the ground to the underside of the cap
    const stCv = kit.stem[s0] || kit.stem[0];
    if (stCv && rise > 0.01) {
      const top = ccy + chh * 0.26, bot = py + scale * 0.1, hs = bot - top;
      if (hs > 2) {
        const ws = stCv.width * k * (0.5 + 0.5 * rise) * (1 - 0.22 * spread);
        ctx.globalAlpha = fade; blit(ctx, stCv, px + sway * rise * 0.4 - ws / 2, top, ws, hs);
        if (fr > 0 && kit.stem[s0 + 1]) { ctx.globalAlpha = fade * fr; blit(ctx, kit.stem[s0 + 1], px + sway * rise * 0.4 - ws / 2, top, ws, hs); }
      }
    }
    // cap
    const capCv = kit.cap[s0 * 3 + v] || kit.cap[s0 * 3] || kit.cap[0];
    if (capCv && rise > 0.01) {
      ctx.globalAlpha = fade; blit(ctx, capCv, ccx - cw / 2, ccy - chh / 2, cw, chh);
      const nx = kit.cap[(s0 + 1) * 3 + v] || kit.cap[(s0 + 1) * 3];
      if (fr > 0 && nx) { ctx.globalAlpha = fade * fr; blit(ctx, nx, ccx - cw / 2, ccy - chh / 2, cw, chh); }
    }
    // embers falling out of the cap, then grey ash
    if (scale >= 4 && rise > 0.2) {
      if (age < 160) {
        for (let i = 0; i < 16; i++) {
          const t = ((age * 0.016) + hash(i * 3.7)) % 1, a = hash(i * 5.1) * 2 - 1, x = ccx + a * cw * 0.46, y = ccy + chh * 0.2 + t * (HC * 0.55 * scale);
          ctx.globalAlpha = Math.sin(t * Math.PI) * fade * clamp((160 - age) / 40, 0, 1); ctx.fillStyle = t < 0.35 ? '#fff0a0' : t < 0.7 ? '#ffa030' : '#e2481c';
          sq(ctx, x + Math.sin(t * 9 + i) * u * 2, y, Math.max(3, u * 2.8));
        }
      }
      if (age > 50) {
        for (let i = 0; i < 12; i++) {
          const t = ((age * 0.01) + hash(i * 9.3)) % 1, a = hash(i * 2.9) * 2 - 1, x = ccx + a * cw * 0.5 + t * u * 6, y = ccy + chh * 0.3 + t * (HC * 0.8 * scale);
          ctx.globalAlpha = Math.sin(t * Math.PI) * 0.8 * fade; ctx.fillStyle = i % 3 === 0 ? '#2a2630' : '#8c8490';
          sq(ctx, x, y, Math.max(2, u * 1.8));
        }
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ registration (bottom layer first)
  /** every layer leaves the shared context as it found it (smoothing flag, alpha, transform) */
  function guard(fn) {
    return (ctx, e, px, py, scale, now, H, alpha) => {
      const sm = ctx.imageSmoothingEnabled;
      try { fn(ctx, e, px, py, scale, now, H, alpha); } finally { ctx.imageSmoothingEnabled = sm; ctx.globalAlpha = 1; }
    };
  }
  GfxPlugins.addEffect({ key: 'fallout', margin: 18, draw: guard(drawFallout) });
  GfxPlugins.addEffect({ key: 'nukes', margin: 40, draw: guard(drawBombs) });
  GfxPlugins.addEffect({ key: 'mushrooms', margin: 40, draw: guard(drawMushroom) });

  return {
    /** every baked canvas of one blast radius (tests / sprite review): builds whatever is still pending */
    parts(R) { shared(); const k = kitFor(R); pump(k, 99); return { bomb: bombCv, sign: signCv, fire: fireCv, glow: glowCv, cap: k.cap, stem: k.stem, skirt: k.skirt, scorch: k.scorch, haze: k.haze, label: textCv('ТРЕВОГА', COL_RED, 'r') }; },
    kitFor, pump, stats() { let parts = 0, pending = 0; for (const k of kits.values()) { pending += k.q.length; parts += k.cap.filter(Boolean).length + k.stem.filter(Boolean).length + k.skirt.filter(Boolean).length + (k.scorch ? 1 : 0) + (k.haze ? 1 : 0); } return { kits: kits.size, parts, pending, canvases: cvCount }; },
    reset() { kits.clear(); textCache.clear(); },
  };
})();
