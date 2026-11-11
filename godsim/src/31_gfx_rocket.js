/* =====================================================================
 * 31_gfx_rocket.js — graphics plugin of the rocket power «Ракеты» (CONTRACT section 10.3). Client only, no DOM at load time.
 * OWNER: rocket power. Sim side: src/16_power_rocket.js (S.eff.rockets, PowerRocket.path / pathS), tests: tests/power_rocket.test.mjs.
 *
 *  Registrations (everything else is lazy and cached):
 *   - icon 'rocket'                       14x14 glyph for the dock button
 *   - persistent effect 'rockets'         every rocket in flight: warning reticle on the impact point (last 10 ticks), ground shadow, smoke trail laid
 *                                         along the flight curve, the rocket sprite rotated along its screen-space velocity (32 baked directions x 3
 *                                         flame frames). Position = PowerRocket.path(e, S.tick + alpha): the renderer is one tick ahead of the units so
 *                                         a rocket reaches its target exactly when the sim processes the impact.
 *   - fx 'rocket_boom'                    impact burst, 14 baked frames (flash, cauliflower fireball that cools, shock ring, sparks, debris, dust, smoke);
 *                                         land (2 variants) / water (geyser + droplets); fx.m > 1 = merged burst of several impacts (several copies)
 *   - fx 'rocket_smoke'                   rising smoke column over the impact (18 baked frames, 2 variants)
 *   - fx 'rocket_trail'                   the smoke trail lingering after the rocket was gone (same puffs as in flight, fading, rising)
 *   - fx 'rocket_launch'                  flash + smoke at the launch point beyond the map edge
 *   - Bus 'rocketVolley'                  toast «Залп: N ракет» (plain host.msg only toasts failures) + warm-up of the baked frames
 *  Budget: baked frames (one drawImage each), nothing allocated per frame, trail = 11 puffs per rocket, the frames of the burst are baked lazily with a
 *  per-frame time budget and queued at the first salvo (a 9-rocket salvo in view costs ~0.3 ms per frame, see tests/power_rocket.test.mjs).
 *  Baking is DOM-free (PB pixel buffers) so the sprites can be inspected from node; only PB.toCanvas touches the DOM, lazily.
 * ===================================================================== */

const GfxRocket = (() => {
  const TAU = Math.PI * 2;

  // ------------------------------------------------------------------ colours (packed ABGR = RGBA bytes on little-endian, like Sprites)
  const rgba = (r, g, b, a) => ((((a === undefined ? 255 : a) & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
  const C = (h, a) => rgba(parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a);
  const cr = (c) => c & 255, cg = (c) => (c >>> 8) & 255, cb = (c) => (c >>> 16) & 255, ca = (c) => c >>> 24;
  const withA = (c, a) => ((c & 0x00ffffff) | (Math.max(0, Math.min(255, Math.round(ca(c) * a))) << 24)) >>> 0;
  const mixc = (a, b, t) => rgba(cr(a) + (cr(b) - cr(a)) * t, cg(a) + (cg(b) - cg(a)) * t, cb(a) + (cb(b) - cb(a)) * t, ca(a) + (ca(b) - ca(a)) * t);
  const OUT = rgba(22, 16, 30);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function hf(n) { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); }
  function nz(a, s) { return Math.sin(a * 2 + s * 1.7) * 0.5 + Math.sin(a * 3 + s * 2.9) * 0.3 + Math.sin(a * 5 + s * 4.3) * 0.2; }       // smooth angular noise -1..1
  function vn(x, y, s) {                                                                                                               // value noise 0..1
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const a = hf(ix * 127.1 + iy * 311.7 + s), b = hf((ix + 1) * 127.1 + iy * 311.7 + s), c = hf(ix * 127.1 + (iy + 1) * 311.7 + s), d = hf((ix + 1) * 127.1 + (iy + 1) * 311.7 + s);
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }
  const ease = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t) * (1 - t); };

  const P = {
    // rocket
    wHi: C('#ffffff'), wMid: C('#e2e6ee'), wSh: C('#aab2c4'), wDeep: C('#6a7388'),
    rHi: C('#ff8f7e'), rMid: C('#ee4a44'), rSh: C('#a82426'), rDeep: C('#6e1a22'),
    nzHi: C('#a4acc0'), nzMid: C('#6a7388'), nzDeep: C('#3a3f50'),
    winHi: C('#d8f6ff'), win: C('#66dcf4'), winDeep: C('#3f86e8'),
    // fire
    fWhite: C('#fffbe8'), fPale: C('#fff2a0'), fYel: C('#ffd83c'), fOra: C('#ff9a30'), fOra2: C('#f06a24'), fBrick: C('#c4401c'), fBurnt: C('#7a2a1c'), fRed: C('#ee4a44'), fDeep: C('#c4361c'), fRim: C('#7a2418'),
    smH: C('#756a60'), smM: C('#514842'), smS: C('#342d29'), smR: C('#221c1a'),
    // smoke
    sHi: C('#ffffff'), sMid: C('#eef0f6'), sSh: C('#c2c8d8'), sRim: C('#8f97ae'),
    dHi: C('#7a7a86'), dMid: C('#52525c'), dSh: C('#34343e'), dRim: C('#1e1e26'),
    hHi: C('#fffbe0'), hMid: C('#ffd83c'), hSh: C('#ff9a30'), hRim: C('#d8501c'),
    // ground
    tanHi: C('#e6d49a'), tanMid: C('#c8aa80'), tanSh: C('#8e7452'),
    dirt1: C('#b89868'), dirt2: C('#8a6a3e'), dirt3: C('#5a4026'), rock1: C('#8a8a96'), rock2: C('#5c5c68'), leaf1: C('#8ed25a'), leaf2: C('#4a8a3a'),
    water1: C('#ffffff'), water2: C('#d4eeff'), water3: C('#8cc8f4'), water4: C('#4a9aee'),
    ret: C('#ff5040'), retDark: C('#3a0a0e'), retCore: C('#ffd0a0'),
  };

  // ------------------------------------------------------------------ pixel buffer (DOM-free; only toCanvas touches the document)
  class PB {
    constructor(w, h) { this.w = w; this.h = h; this.d = new Uint32Array(w * h); }
    set(x, y, c) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c; }
    get(x, y) { return (x >= 0 && y >= 0 && x < this.w && y < this.h) ? this.d[y * this.w + x] : 0; }
    blend(x, y, c) {                                                       // source-over with straight alpha
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      const sa = c >>> 24;
      if (sa === 0) return;
      const i = y * this.w + x;
      if (sa === 255) { this.d[i] = c; return; }
      const o = this.d[i], da = o >>> 24;
      if (da === 0) { this.d[i] = c; return; }
      const a = sa / 255, db = da / 255, ra = a + db * (1 - a), ws = a / ra, wo = db * (1 - a) / ra;
      const r = cr(c) * ws + cr(o) * wo, g = cg(c) * ws + cg(o) * wo, b = cb(c) * ws + cb(o) * wo;
      this.d[i] = rgba((r + 0.5) | 0, (g + 0.5) | 0, (b + 0.5) | 0, (ra * 255 + 0.5) | 0);
    }
    outline(col) {                                                         // 1 px 4-neighbour outline into transparent pixels
      const w = this.w, h = this.h, s = this.d.slice(), d = this.d;
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
  /** draw an (opaque-pixel) layer over dst with one overall alpha: overlapping puffs inside the layer do not show through each other */
  function compose(dst, src, alpha) {
    if (!(alpha > 0.01)) return;
    const d = src.d, w = src.w;
    for (let i = 0; i < d.length; i++) {
      const c = d[i];
      if ((c >>> 24) === 0) continue;
      dst.blend(i % w, (i / w) | 0, alpha >= 1 ? c : withA(c, alpha));
    }
  }
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  /** like compose, but the fade is an ordered dither (opaque stipple): pixel-art style dissolve, no see-through outlines */
  function composeD(dst, src, alpha) {
    if (!(alpha > 0.01)) return;
    const d = src.d, w = src.w;
    for (let i = 0; i < d.length; i++) {
      const c = d[i];
      if ((c >>> 24) === 0) continue;
      const x = i % w, y = (i / w) | 0;
      if (alpha >= 1 || alpha > (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16) dst.blend(x, y, c);
    }
  }
  /** lumpy, 3-tone shaded disc (smoke / dust puffs): tones = [hi, mid, shade, rim]; ry < r squashes it */
  function blob(pb, cx, cy, r, seed, lump, tones, alpha, ry) {
    if (!(alpha > 0.01) || r < 0.4) return;
    ry = ry || r;
    const sq = r / ry;
    for (let y = Math.floor(cy - ry * (1 + lump) - 1); y <= Math.ceil(cy + ry * (1 + lump) + 1); y++) {
      for (let x = Math.floor(cx - r * (1 + lump) - 1); x <= Math.ceil(cx + r * (1 + lump) + 1); x++) {
        const dx = x + 0.5 - cx, dy = (y + 0.5 - cy) * sq, d = Math.sqrt(dx * dx + dy * dy);
        const rr = r * (1 + lump * nz(Math.atan2(dy, dx), seed));
        if (d > rr) continue;
        const li = (-dx * 0.55 - dy * 0.83) / (rr + 0.001);
        const col = rr - d < 1.0 && rr > 2.2 ? tones[3] : li > 0.34 ? tones[0] : li > -0.28 ? tones[1] : tones[2];
        pb.blend(x, y, alpha >= 1 ? col : withA(col, alpha));
      }
    }
  }
  /** soft smoke puff: lumpy edge, a blobby highlight at the upper left, shaded lower right, a thin rim (tones = [hi, mid, shade, rim]); drawn opaque */
  function smokePuff(pb, cx, cy, r, seed, tones, lump) {
    if (r < 0.6) return;
    lump = lump === undefined ? 0.13 : lump;
    for (let y = Math.floor(cy - r * (1 + lump) - 1); y <= Math.ceil(cy + r * (1 + lump) + 1); y++) {
      for (let x = Math.floor(cx - r * (1 + lump) - 1); x <= Math.ceil(cx + r * (1 + lump) + 1); x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.sqrt(dx * dx + dy * dy);
        const rr = r * (1 + lump * nz(Math.atan2(dy, dx), seed));
        if (d > rr) continue;
        if (rr - d < 0.95 && rr > 2.4 && (dx * 0.4 + dy * 0.9) > -0.15 * rr) { pb.set(x, y, tones[3]); continue; }                         // rim only on the lower half
        const hx = dx + 0.32 * rr, hy = dy + 0.38 * rr, hd = Math.sqrt(hx * hx + hy * hy), n = vn(x * 0.5, y * 0.5, seed) - 0.5;
        const sh = (dx * 0.45 + dy * 0.85) / rr + n * 0.35;
        pb.set(x, y, hd < 0.5 * rr + n * 0.12 * rr ? tones[0] : sh > 0.42 ? tones[2] : tones[1]);
      }
    }
  }
  /** one billowing smoke mass from a union of lobes (L = flat [x, y, r, ...]): lit by the combined thickness (light centre, dark crease / rim), dithered tone bands */
  function lobeSmoke(pb, L, n, tones, seed) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < n; i++) { const x = L[i * 3], y = L[i * 3 + 1], r = L[i * 3 + 2]; if (x - r < x0) x0 = x - r; if (x + r > x1) x1 = x + r; if (y - r < y0) y0 = y - r; if (y + r > y1) y1 = y + r; }
    for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y++) {
      for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x++) {
        let F = -1, bi = 0;
        for (let i = 0; i < n; i++) {
          const dx = x + 0.5 - L[i * 3], dy = y + 0.5 - L[i * 3 + 1], r = L[i * 3 + 2], f = 1 - Math.sqrt(dx * dx + dy * dy) * (1 + 0.1 * nz(Math.atan2(dy, dx), seed + i)) / r;
          if (f > F) { F = f; bi = i; }
        }
        if (F <= 0) continue;
        const r = L[bi * 3 + 2], dxl = x + 0.5 - L[bi * 3], dyl = y + 0.5 - L[bi * 3 + 1];
        let v = F * 0.95 + (vn(x * 0.33, y * 0.33, seed) - 0.5) * 0.36 + (-dxl * 0.5 - dyl * 0.8) / r * 0.3 + ((BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * 0.16;
        if (F < 0.07) v = -1;
        pb.set(x, y, v > 0.62 ? tones[0] : v > 0.36 ? tones[1] : v > 0.14 ? tones[2] : tones[3]);
      }
    }
  }
  function ringPx(pb, cx, cy, rad, th, col, alpha) {
    const a = withA(col, alpha), o = Math.ceil(rad + th);
    for (let y = Math.floor(cy - o); y <= Math.ceil(cy + o); y++) for (let x = Math.floor(cx - o); x <= Math.ceil(cx + o); x++) {
      const d = Math.sqrt((x + 0.5 - cx) * (x + 0.5 - cx) + (y + 0.5 - cy) * (y + 0.5 - cy));
      if (Math.abs(d - rad) <= th * 0.5) pb.blend(x, y, a);
    }
  }
  function sparkle(pb, x, y, col, a) { x = Math.round(x); y = Math.round(y); pb.blend(x, y, a >= 1 ? col : withA(col, a)); }

  // ------------------------------------------------------------------ the rocket sprite (32 directions x 3 flame frames)
  const ANG_N = 32, FLAME_N = 3, SPR = 44, SPR_C = 22, KS = 1.2;                    // KS = geometry scale of the in-game rocket (the icon uses its own)
  const LX = -0.5, LY = -0.76, LZ = 0.42;                                  // light from the top-left (screen space), LZ toward the viewer
  const finOut = (a) => 2.0 + 1.9 * Math.min(1, (-2.5 - a) / 3.5);
  /** which part of the rocket is at local (a along the axis to the nose, b across): 0 none, 1 body, 2 nose, 3 fin, 4 nozzle, 5 band, 6 window */
  function rocketPart(a, b) {
    const ab = b < 0 ? -b : b;
    if (a >= 3.0 && a <= 7.2) { const t = (a - 3.0) / 4.2; return ab <= 2.0 * (1 - Math.pow(t, 1.8)) ? 2 : 0; }
    if (a >= -6.6 && a < -5.4) { if (ab <= 1.25) return 4; return (a >= -6.0 && ab <= finOut(a)) ? 3 : 0; }
    if (a >= -5.4 && a < 3.0) {
      if (ab <= 2.0) { if (a >= 1.1 && a <= 2.1 && ab <= 0.7) return 6; if (a >= -1.3 && a <= -0.3) return 5; return 1; }
      if (a < -2.5 && ab <= finOut(a)) return 3;
    }
    return 0;
  }
  const PRIO = [0, 6, 5, 1, 2, 3, 4];                                       // tie-break order when a pixel is covered by several parts
  /** body + fins + nose (no flame) into pb, rotated by th (rad, 0 = nose to the right, clockwise on screen), centred on (cx,cy), geometry scale k */
  function drawRocketBody(pb, cx, cy, th, k) {
    const ca_ = Math.cos(th), sa_ = Math.sin(th), pl = -sa_ * LX + ca_ * LY;
    const R2 = Math.ceil(8 * k) + 2, cnt = [0, 0, 0, 0, 0, 0, 0];
    for (let y = Math.floor(cy - R2); y <= Math.ceil(cy + R2); y++) {
      for (let x = Math.floor(cx - R2); x <= Math.ceil(cx + R2); x++) {
        cnt.fill(0);
        let filled = 0;
        for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
          const dx = x + (sx + 0.5) / 3 - cx, dy = y + (sy + 0.5) / 3 - cy;
          const a = (dx * ca_ + dy * sa_) / k, b = (-dx * sa_ + dy * ca_) / k, part = rocketPart(a, b);
          if (part > 0) { cnt[part]++; filled++; }
        }
        if (filled < 4) continue;
        let best = 0, bc = -1;
        for (let q = 0; q < PRIO.length; q++) { const pi = PRIO[q]; if (pi && cnt[pi] > bc) { bc = cnt[pi]; best = pi; } }
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy, a = (dx * ca_ + dy * sa_) / k, b = (-dx * sa_ + dy * ca_) / k;
        let col;
        if (best === 1 || best === 2 || best === 5) {
          let hw = 2.0;
          if (best === 2) { const t = clamp((a - 3.0) / 4.2, 0, 1); hw = Math.max(0.5, 2.0 * (1 - Math.pow(t, 1.8))); }
          const n = clamp(b / hw, -1, 1), lit = pl * n + Math.sqrt(1 - n * n) * LZ;
          const ti = lit > 0.46 ? 0 : lit > 0.1 ? 1 : lit > -0.28 ? 2 : 3;
          if (best === 1) col = ti === 0 ? P.wHi : ti === 1 ? P.wMid : ti === 2 ? P.wSh : P.wDeep;
          else col = ti === 0 ? P.rHi : ti === 1 ? P.rMid : ti === 2 ? P.rSh : P.rDeep;
          if (best === 5) col = ti <= 1 ? P.rMid : P.rSh;
        } else if (best === 3) col = (b * pl) >= 0 ? P.rMid : P.rSh;
        else if (best === 4) col = a < -6.0 ? P.nzDeep : (b * pl >= 0 ? P.nzHi : P.nzMid);
        else col = (b * pl >= 0) ? P.winHi : P.win;
        pb.set(x, y, col);
      }
    }
    pb.outline(OUT);
  }
  /** exhaust flame behind the nozzle (3 flicker frames), drawn over the transparent pixels / outline */
  function drawFlame(pb, cx, cy, th, k, fi) {
    const ca_ = Math.cos(th), sa_ = Math.sin(th);
    const Lf = [7.6, 9.8, 8.4][fi % 3] * k, start = -6.3 * k;
    const R2 = Math.ceil(17 * k) + 1;
    for (let y = Math.floor(cy - R2); y <= Math.ceil(cy + R2); y++) {
      for (let x = Math.floor(cx - R2); x <= Math.ceil(cx + R2); x++) {
        let hits = 0, qsum = 0;
        for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
          const dx = x + (sx + 0.5) / 2 - cx, dy = y + (sy + 0.5) / 2 - cy;
          const a = dx * ca_ + dy * sa_, b = Math.abs(-dx * sa_ + dy * ca_);
          const t = (start - a) / Lf;
          if (t < -0.02 || t > 1) continue;
          const tt = Math.max(0, t), wob = 1 + 0.14 * Math.sin(tt * 9 + fi * 2.1);
          let q = 0;
          if (b <= 0.5 * k * (1 - tt) * wob && tt < 0.3) q = 5;
          else if (b <= 0.85 * k * (1 - tt * 0.8) * wob) q = 4;
          else if (b <= 1.6 * k * (1 - Math.pow(tt, 1.1)) * wob) q = 3;
          else if (b <= 2.6 * k * (1 - Math.pow(tt, 1.15)) * wob) q = tt > 0.62 ? 1 : 2;
          if (q > 0) { hits++; qsum += q; }
        }
        if (hits < 2) continue;
        const kind = Math.round(qsum / hits);                                               // mean heat of the covered samples (not the max: the flame keeps its orange shell)
        const col = kind === 5 ? P.fWhite : kind === 4 ? P.fPale : kind === 3 ? P.fYel : kind === 2 ? P.fOra : P.fRed;
        const old = pb.get(x, y);
        pb.set(x, y, (old >>> 24) > 200 && ((old & 0x00ffffff) !== (OUT & 0x00ffffff)) ? old : col);
      }
    }
  }
  function bakeRocket(ai, fi) {
    const pb = new PB(SPR, SPR), th = ai / ANG_N * TAU;
    drawRocketBody(pb, SPR_C, SPR_C, th, KS);
    drawFlame(pb, SPR_C, SPR_C, th, KS, fi);
    return pb;
  }

  // ------------------------------------------------------------------ smoke puffs of the trail: 5 sizes x 3 tones (smoke, hot, dark)
  const PUFF_R = [2.6, 3.6, 4.6, 5.8, 7.0];
  const PUFF_TONES = [[P.sHi, P.sMid, P.sSh, P.sRim], [P.hHi, P.hMid, P.hSh, P.hRim], [P.dHi, P.dMid, P.dSh, P.dRim]];
  const PUFF_LVL = [1, 0.74, 0.5, 0.3];                                    // dither levels: opaque stipple instead of see-through blits
  function bakePuff(cls, tone, lvl) {
    const r = PUFF_R[cls], n = Math.ceil(r * 2.3) + 2, pb = new PB(n, n), lay = new PB(n, n);
    smokePuff(lay, n / 2, n / 2, r, 3 + cls * 5 + tone * 11, PUFF_TONES[tone], 0.1);
    composeD(pb, lay, PUFF_LVL[lvl | 0]);
    return pb;
  }

  // ------------------------------------------------------------------ smoke trail strips: the puffs of a trail pre-arranged along a line, 64 directions x 4 kinds
  //   a trail is drawn as 2 strips (near: 0..2.2 tiles behind the rocket, far: 2.2..4.4) instead of ~11 single puffs (drawImage calls dominate the draw cost).
  //   kind 0 / 1 = in flight (hot puffs next to the flame), kind 2 / 3 = lingering after the impact (cooler, one size bigger)
  const STRIP_N = 64, STRIP_S = 96, STRIP_C = 48, D_MID = 2.2, TRAIL_PUFFS = 11, TRAIL_LEN = 4.4;
  const puffPBs = new Map();
  const lvlOf = (a) => (a > 0.8 ? 0 : a > 0.55 ? 1 : a > 0.36 ? 2 : 3);                 // alpha -> dither level of a baked puff
  function puffPB(cls, tone, lvl) { const key = (cls * 3 + tone) * 4 + lvl; let q = puffPBs.get(key); if (q === undefined) { q = bakePuff(cls, tone, lvl); puffPBs.set(key, q); } return q; }
  function stamp(dst, src, cx, cy) {
    const ox = Math.round(cx - src.w / 2), oy = Math.round(cy - src.h / 2);
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) { const c = src.d[y * src.w + x]; if ((c >>> 24) > 0) dst.set(ox + x, oy + y, c); }
  }
  function bakeStrip(ai, kind) {
    const pb = new PB(STRIP_S, STRIP_S), th = ai / STRIP_N * TAU, ux = Math.cos(th), uy = Math.sin(th), lingering = kind >= 2, far = (kind & 1) === 1;
    for (let j = TRAIL_PUFFS - 1; j >= 0; j--) {                                           // far puffs first: the near ones lie on top
      const tj = (j + 0.5) / TRAIL_PUFFS, d = TRAIL_LEN * Math.pow(tj, 1.35);
      if (far ? d < D_MID : d >= D_MID) continue;
      const a = Math.min(1, 1.45 - tj * 1.2);
      if (a < 0.12) continue;
      const dl = (far ? d - D_MID : d) * TILE, cls = j <= 1 && !lingering ? 0 : Math.min(4, 1 + ((tj * 4.2) | 0) + (lingering ? 1 : 0));
      stamp(pb, puffPB(cls, !lingering && j <= 1 ? 1 : 0, lvlOf(a)), STRIP_C + ux * dl, STRIP_C + uy * dl - tj * 0.42 * TILE);
    }
    return pb;
  }

  // ------------------------------------------------------------------ warning reticle (4 rotation phases): dashed blast ring + lethal-core ring + crosshair in ONE sprite
  const RET_N = 4, RET_S = 68, RET_C = 34;
  function bakeReticle(ph) {
    const pb = new PB(RET_S, RET_S), R_ = 1.8 * 16, Rc = 0.75 * 16;
    for (let y = 0; y < RET_S; y++) for (let x = 0; x < RET_S; x++) {                  // the ring is a little see-through (alpha baked in), the crosshair is not
      const dx = x + 0.5 - RET_C, dy = y + 0.5 - RET_C, d = Math.sqrt(dx * dx + dy * dy);
      const ang = Math.atan2(dy, dx), seg = (((ang / TAU) * 16 + ph * 0.25) % 1 + 1) % 1;
      if (Math.abs(d - R_) <= 1.0 && seg < 0.58) pb.set(x, y, withA(P.ret, 0.74));
      else if (Math.abs(d - R_) <= 1.95 && Math.abs(d - R_) > 1.0 && seg < 0.66) pb.set(x, y, withA(P.retDark, 0.55));
      else if (Math.abs(d - Rc) <= 0.6) pb.set(x, y, withA(P.ret, 0.4));
    }
    for (let i = 0; i < 4; i++) {                                                      // ticks at N E S W pointing at the centre
      const ux = i === 0 ? 1 : i === 2 ? -1 : 0, uy = i === 1 ? 1 : i === 3 ? -1 : 0;
      for (let t = 4; t <= 9; t++) { const x = Math.floor(RET_C + ux * t), y = Math.floor(RET_C + uy * t); pb.set(x, y, P.retCore); pb.set(x - (uy !== 0 ? 1 : 0), y - (ux !== 0 ? 1 : 0), withA(P.retDark, 0.9)); }
    }
    pb.set(RET_C - 1, RET_C - 1, P.sHi); pb.set(RET_C, RET_C - 1, P.sHi); pb.set(RET_C - 1, RET_C, P.sHi); pb.set(RET_C, RET_C, P.ret);
    return pb;
  }

  // ------------------------------------------------------------------ impact burst
  const BOOM_N = 14, BOOM_W = 88, BOOM_H = 108, BOOM_AX = 44, BOOM_AY = 72, TILE = 16;
  const DEBRIS_COLS = [[P.dirt1, P.dirt2], [P.dirt2, P.dirt3], [P.rock1, P.rock2], [P.dirt1, P.dirt2], [P.leaf1, P.leaf2], [P.dirt2, P.dirt3], [P.rock1, P.rock2], [P.leaf1, P.leaf2]];
  function chunk(pb, x, y, sz, c1, c2, a) {
    x = Math.round(x); y = Math.round(y);
    const k1 = a >= 1 ? c1 : withA(c1, a), k2 = a >= 1 ? c2 : withA(c2, a);
    for (let j = 0; j < sz; j++) for (let i = 0; i < sz; i++) pb.blend(x + i, y + j, i + j === 0 ? k1 : (i === sz - 1 && j === sz - 1) || sz === 1 ? k2 : (i + j < sz ? k1 : k2));
  }
  /** cauliflower fireball: a union of lobes, white-hot in the middle, cooling toward red / black at the rims; cool 0..1 darkens the whole ball */
  function lobeFire(pb, cx, cy, R, seed, cool, alpha, nL) {
    if (R < 1 || alpha <= 0) return;
    const lobes = [];                                                        // ring of lobes around the centre + one in the middle: the ball stays centred
    lobes.push(cx, cy - 0.04 * R, 0.66 * R);
    for (let i = 1; i < nL; i++) {
      const a = ((i - 1) / (nL - 1)) * TAU + hf(seed + i * 2.7) * 0.9, d = 0.4 + 0.16 * hf(seed + i * 4.1), r = 0.5 + 0.16 * hf(seed + i * 6.3);
      lobes.push(cx + Math.cos(a) * d * R, cy + Math.sin(a) * d * R * 0.88 - 0.06 * R, r * R);
    }
    const ext = R * 1.4;
    for (let y = Math.floor(cy - ext - 1); y <= Math.ceil(cy + ext + 1); y++) {
      for (let x = Math.floor(cx - ext - 1); x <= Math.ceil(cx + ext + 1); x++) {
        let F = -1;
        for (let i = 0; i < nL; i++) { const dx = x + 0.5 - lobes[i * 3], dy = y + 0.5 - lobes[i * 3 + 1], f = 1 - Math.sqrt(dx * dx + dy * dy) / lobes[i * 3 + 2]; if (f > F) F = f; }
        if (F <= 0) continue;
        const dxc = x + 0.5 - cx, dyc = y + 0.5 - cy, cb_ = 1 - Math.min(1, Math.sqrt(dxc * dxc + dyc * dyc) / R);
        const heat = (F * 0.5 + cb_ * 0.55) * (1 - cool * 0.35) + (vn(x * 0.42, y * 0.42, seed) - 0.5) * (0.3 + 0.25 * cool) - cool * 0.5 + (-dxc * 0.35 - dyc * 0.45) / R * 0.14;
        let col;
        if (F < 0.12) col = heat > 0.4 ? P.fDeep : P.fRim;
        else if (heat > 0.78) col = P.fWhite;
        else if (heat > 0.6) col = P.fPale;
        else if (heat > 0.42) col = P.fYel;
        else if (heat > 0.27) col = P.fOra;
        else if (heat > 0.13) col = P.fOra2;
        else if (heat > 0.0) col = P.fBrick;
        else col = P.fBurnt;
        pb.blend(x, y, alpha >= 1 ? col : withA(col, alpha));
      }
    }
  }
  function boomLand(pb, p, seed) {
    const cx = BOOM_AX, cy = BOOM_AY, T = TILE;
    // scorched ground
    const sA = Math.min(1, p / 0.16) * (p > 0.8 ? Math.max(0, (1 - p) / 0.2) : 1) * 0.45;
    blob(pb, cx, cy + 1, 1.15 * T, seed + 3, 0.18, [C('#241610'), C('#1a0e0a'), C('#120a08'), C('#120a08')], sA, 0.8 * 1.15 * T);
    // warm glow of the blast: dither density falls off with the distance from the ball
    if (p < 0.5) {
      const Rg = (0.9 + 1.5 * ease(p / 0.3)) * T, gy = cy - 0.35 * T, gf = 0.55 * (1 - p / 0.5);
      for (let y = Math.floor(gy - Rg); y <= Math.ceil(gy + Rg); y++) for (let x = Math.floor(cx - Rg); x <= Math.ceil(cx + Rg); x++) {
        const d = Math.sqrt((x + 0.5 - cx) * (x + 0.5 - cx) + (y + 0.5 - gy) * (y + 0.5 - gy)) / Rg;
        if (d >= 1) continue;
        if ((1 - d) * (1 - d) * gf > (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16) pb.blend(x, y, P.fOra);
      }
    }
    // dust cloud racing along the ground with the shock wave (one layer, dithered fade)
    if (p < 0.62) {
      const lay = new PB(pb.w, pb.h), rr = (0.6 + 1.4 * ease(p / 0.5)) * T;
      for (let j = 0; j < 11; j++) {
        const ang = (j / 11) * TAU + hf(seed + j * 2) * 0.5, rj = rr * (0.85 + 0.15 * hf(seed + j * 9));
        blob(lay, cx + Math.cos(ang) * rj, cy + Math.sin(ang) * rj * 0.8 - 2, (3.2 + 4.0 * p) * (0.8 + 0.4 * hf(seed + j)), seed + j, 0.12, [P.tanHi, P.tanMid, P.tanSh, P.tanSh], 1);
      }
      composeD(pb, lay, 0.95 * (1 - p / 0.62));
    }
    // smoke billows rising out of the ball (one layer, dithered fade)
    const sf = Math.min(1, (p - 0.22) / 0.14) * (1 - clamp((p - 0.62) / 0.38, 0, 1));
    if (sf > 0.01) {
      const lay = new PB(pb.w, pb.h), L = [];
      for (let j = 0; j < 7; j++) {
        const a = p - (0.16 + j * 0.035); if (a <= 0) continue;
        const h = hf(seed + j * 5.3);
        L.push(cx + (h - 0.5) * 1.5 * T * (0.2 + a * 1.1), cy - (0.75 + 1.55 * Math.pow(a, 0.85) + 0.25 * hf(seed + j * 7)) * T, (0.5 + 0.8 * Math.sqrt(a)) * T * (0.7 + 0.06 * j));
      }
      const cool = clamp((p - 0.2) * 1.2, 0, 1);
      if (L.length) lobeSmoke(lay, L, L.length / 3, [mixc(P.smH, P.sMid, cool * 0.35), mixc(P.smM, P.sSh, cool * 0.3), mixc(P.smS, P.sRim, cool * 0.25), mixc(P.smR, P.sRim, cool * 0.2)], seed);
      composeD(pb, lay, sf);
    }
    // debris (dirt, rock, leaves) and sparks: drawn in front of the ball (flyers() runs after it)
    const flyers = () => {
      const g = 165;
      for (let i = 0; i < 14; i++) {                                                                                // ballistic chunks, bigger and slower than the sparks
        const h1 = hf(seed + i * 3.7), h2 = hf(seed + i * 5.9 + 1), h3 = hf(seed + i * 7.3 + 2);
        const vx = (h1 - 0.5) * 112, vy = -(40 + h2 * 50), tl = -2 * vy / g, cols = DEBRIS_COLS[i % 8], sz = h3 > 0.45 ? 4 : 3;
        if (p <= tl) chunk(pb, cx + vx * p, cy - 3 + vy * p + 0.5 * g * p * p, sz, cols[0], cols[1], 1);
        else if (p < tl + 0.3) chunk(pb, cx + vx * tl, cy - 2 + (h3 - 0.5) * 6, Math.max(2, sz - 1), cols[0], cols[1], 1 - (p - tl) / 0.3);
      }
      for (let i = 0; i < 18; i++) {                                                                                // sparks
        const life = 0.16 + 0.32 * hf(seed + i * 4.1);
        if (p >= life) continue;
        const an = hf(seed + i * 1.9) * TAU, sp = 44 + 66 * hf(seed + i * 2.3), x = cx + Math.cos(an) * sp * p, y = cy - 6 + Math.sin(an) * sp * p * 0.8 + 100 * p * p;
        const col = i % 3 === 0 ? P.fWhite : i % 3 === 1 ? P.fYel : P.fOra, fa = 1 - p / life;
        sparkle(pb, x, y, col, 1); sparkle(pb, x + 1, y, col, 1); sparkle(pb, x, y + 1, col, 0.8);
        sparkle(pb, x - Math.cos(an) * 3, y - Math.sin(an) * 2.4, col, 0.7 * fa); sparkle(pb, x - Math.cos(an) * 5, y - Math.sin(an) * 4, col, 0.4 * fa);
      }
    };
    // shock ring
    if (p < 0.5) ringPx(pb, cx, cy - 1, (0.45 + 1.55 * ease(p / 0.45)) * T, 2.6 - 1.6 * (p / 0.5), C('#fff4dc'), 0.9 * (1 - p / 0.5));
    // fireball: expands, then cools and fades into the smoke
    const grow = ease(p / 0.38), shrink = p > 0.4 ? 1 - 0.3 * (p - 0.4) / 0.6 : 1, fa = p < 0.5 ? 1 : clamp((0.78 - p) / 0.28, 0, 1);
    if (fa >= 0.99) lobeFire(pb, cx, cy - (0.3 + 0.7 * p) * T, (0.38 + 1.12 * grow) * T * shrink, seed, clamp((p - 0.08) / 0.5, 0, 1), 1, 8);
    else if (fa > 0.02) { const lay = new PB(pb.w, pb.h); lobeFire(lay, cx, cy - (0.3 + 0.7 * p) * T, (0.38 + 1.12 * grow) * T * shrink, seed, clamp((p - 0.08) / 0.5, 0, 1), 1, 8); composeD(pb, lay, fa); }
    // flash + star
    if (p < 0.17) {
      const k = 1 - p / 0.17, L = 32 * k + 5, yy = cy - 0.35 * T;
      lobeFire(pb, cx, yy, (0.5 + 0.55 * (1 - k)) * T, seed + 50, 0, 1, 6);
      for (let t = 1; t < L; t++) for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        pb.set(Math.round(cx + ux * t), Math.round(yy + uy * t), P.fWhite);
        if (t < L * 0.45) { pb.blend(Math.round(cx + ux * t + uy), Math.round(yy + uy * t + ux), withA(P.fPale, 0.85)); pb.blend(Math.round(cx + ux * t - uy), Math.round(yy + uy * t - ux), withA(P.fPale, 0.85)); }
      }
      for (let t = 1; t < L * 0.5; t++) for (const [ux, uy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) pb.set(Math.round(cx + ux * t * 0.8), Math.round(yy + uy * t * 0.8), withA(P.fPale, 0.9));
    }
    flyers();
    // embers glowing on the scorched ground
    if (p > 0.45 && p < 0.95) for (let i = 0; i < 10; i++) { const q = 0.5 + 0.5 * Math.sin(p * 40 + i * 2.1); sparkle(pb, cx + (hf(seed + i * 6.1) - 0.5) * 1.6 * T, cy + (hf(seed + i * 8.3) - 0.5) * 1.2 * T, P.fOra, 0.9 * q * (1 - (p - 0.45) / 0.5)); }
  }
  function boomWater(pb, p, seed) {
    const cx = BOOM_AX, cy = BOOM_AY, T = TILE;
    for (let j = 0; j < 3; j++) { const q = (p - j * 0.11) / 0.74; if (q > 0 && q < 1) ringPx(pb, cx, cy, (0.3 + 1.75 * ease(q)) * T, 2.0 - 1.0 * q, j === 1 ? P.water3 : P.water1, 0.85 * (1 - q)); }
    const lay = new PB(pb.w, pb.h);
    if (p > 0.02 && p < 0.86) {                                                                                      // foam disc at the base + the geyser column and its crown
      const q = (p - 0.02) / 0.84, up = Math.sin(Math.min(1, q * 1.2) * Math.PI * 0.56 + 0.12), Hc = 2.7 * T * up * (1 - 0.3 * q);
      blob(lay, cx, cy, (0.5 + 0.9 * Math.min(1, q * 2)) * T * 0.8, seed, 0.2, [P.water1, P.water2, P.water3, P.water3], 1, 0.4 * T);
      for (let i = 0; i < 9; i++) {
        const t = i / 8, y = cy - 2 - t * Hc, w = (1.5 + 3.6 * Math.pow(1 - t, 1.2) + (t > 0.9 ? 3.2 : 0)) * (0.65 + 0.5 * Math.min(1, q * 2.5));
        blob(lay, cx + (hf(seed + i) - 0.5) * 2.4, y, w, seed + i, 0.2, [P.water1, P.water2, P.water3, P.water4], 1);
      }
      for (let i = 0; i < 3; i++) {                                                                                  // secondary spouts
        const h = Math.max(0, up * 0.55 - i * 0.1) * 1.4 * T, sx = cx + (i - 1) * 1.1 * T;
        if (h > 2) for (let t = 0; t < 4; t++) blob(lay, sx + (hf(seed + i * 3 + t) - 0.5) * 1.6, cy - 1 - t / 3 * h, 1.8 + (t === 3 ? 1.6 : 0), seed + i * 7 + t, 0.2, [P.water1, P.water2, P.water3, P.water4], 1);
      }
      compose(pb, lay, q > 0.72 ? 1 - (q - 0.72) / 0.28 : 1);
    }
    if (p < 0.24) { const k = 1 - p / 0.24; lobeFire(pb, cx, cy - 0.35 * T, (0.35 + 0.5 * (1 - k)) * T, seed + 9, 0.05 + (1 - k) * 0.5, k, 6); }
    for (let i = 0; i < 16; i++) {                                                                                  // droplets
      const h1 = hf(seed + i * 3.1), h2 = hf(seed + i * 4.3 + 1), vx = (h1 - 0.5) * 84, vy = -(40 + h2 * 50), g = 165, tl = -2 * vy / g;
      if (p < tl) { const x = cx + vx * p, y = cy - 4 + vy * p + 0.5 * g * p * p; sparkle(pb, x, y, i & 1 ? P.water1 : P.water3, 1); sparkle(pb, x, y + 1, P.water2, 0.7); if (i % 3 === 0) sparkle(pb, x + 1, y, P.water1, 0.8); }
    }
  }
  function bakeBoom(kind, v, fi) {
    const pb = new PB(BOOM_W, BOOM_H), p = (fi + 0.5) / BOOM_N;
    // the lumpy shapes keep one seed over the whole burst (the fireball does not boil)
    if (kind === 0) boomLand(pb, p, 11 + v * 37); else boomWater(pb, p, 112 + v * 37);
    return pb;
  }

  // ------------------------------------------------------------------ smoke column over the impact
  const SMK_N = 18, SMK_W = 64, SMK_H = 96, SMK_AX = 32, SMK_AY = 86;
  function bakeSmokeCol(v, fi) {
    const pb = new PB(SMK_W, SMK_H), lay = new PB(SMK_W, SMK_H), p = (fi + 0.5) / SMK_N, seed = 5 + v * 29, T = TILE, L = [];
    let cool = 0;
    for (let j = 9; j >= 0; j--) {
      const a = p - j * 0.04;
      if (a <= 0) continue;
      const q = Math.min(1, a / (0.74 + 0.03 * j));
      const rise = (0.3 + 3.1 * Math.pow(q, 0.78)) * T * (0.88 + 0.2 * hf(seed + j)), wob = Math.sin(q * 5 + seed + j * 1.7) * 2.2, drift = q * 8 + (hf(seed + j * 3) - 0.5) * 3;
      const r = (0.3 + 1.1 * Math.pow(q, 0.7) + 0.08 * (j % 3)) * T * 0.6 * (1 - 0.3 * clamp((q - 0.7) / 0.3, 0, 1));
      L.push(SMK_AX + wob + drift * 0.7 + (hf(seed + j * 5) - 0.5) * 4, SMK_AY - rise, r);
      cool = Math.max(cool, q);
    }
    const c = clamp(p * 1.2, 0, 1);
    if (L.length) lobeSmoke(lay, L, L.length / 3, [mixc(P.smH, P.sMid, c * 0.6), mixc(P.smM, P.sSh, c * 0.55), mixc(P.smS, P.sRim, c * 0.45), mixc(P.smR, P.sRim, c * 0.35)], seed);
    composeD(pb, lay, Math.min(1, p / 0.08) * (p > 0.6 ? Math.max(0, (1 - p) / 0.4) : 1));
    return pb;
  }

  // ------------------------------------------------------------------ icon (14x14, the in-game rocket rasterised at 45 degrees, small flame by hand)
  function drawIcon(b, IP) {
    const pb = new PB(16, 16);
    drawRocketBody(pb, 8.6, 6.9, -Math.PI / 4, 0.93);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const c = pb.get(x, y); if ((c >>> 24) > 100 && c !== OUT) b.set(x - 1, y, c); }
    for (const [x, y, c] of [[2, 11, IP.y], [3, 10, IP.y], [1, 12, IP.o], [2, 12, IP.o], [3, 11, IP.o], [1, 13, IP.r], [0, 13, IP.r], [2, 13, IP.r]]) b.set(x, y, c);
  }

  // ------------------------------------------------------------------ lazy cache with a baking budget; every sprite is cropped to its content (less area to rasterise)
  const cache = new Map();
  let frameStart = 0, frameNow = -1;
  const BUDGET_MS = 2.6;
  function tick(now) { if (now !== frameNow) { frameNow = now; frameStart = performance.now(); } }
  /** PB -> {cv, dx, dy, ow, oh}: canvas of the opaque bounding box, its offset inside the baked frame and the frame size (cv = null for an empty frame) */
  function crop(pb) {
    let x0 = pb.w, y0 = pb.h, x1 = -1, y1 = -1;
    for (let y = 0; y < pb.h; y++) for (let x = 0; x < pb.w; x++) if ((pb.d[y * pb.w + x] >>> 24) > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return { cv: null, dx: 0, dy: 0, ow: pb.w, oh: pb.h };
    const w = x1 - x0 + 1, h = y1 - y0 + 1, o = new PB(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o.d[y * w + x] = pb.d[(y + y0) * pb.w + x + x0];
    return { cv: o.toCanvas(), dx: x0, dy: y0, ow: pb.w, oh: pb.h };
  }
  /** cached sprite for key; bakes it when missing unless this frame's budget is spent (force = bake anyway: tiny sprites) */
  function get(key, fn, force) {
    let sp = cache.get(key);
    if (sp !== undefined) return sp;
    if (!force && performance.now() - frameStart > BUDGET_MS) return null;
    sp = crop(fn());
    cache.set(key, sp);
    return sp;
  }
  const rocketCv = (ai, fi) => get(1000 + ai * FLAME_N + fi, () => bakeRocket(ai, fi), true);
  const puffCv = (cls, tone, lvl) => get(2000 + (cls * 3 + tone) * 4 + lvl, () => bakePuff(cls, tone, lvl), true);
  const retCv = (ph) => get(3000 + ph, () => bakeReticle(ph), true);
  const stripCv = (ai, kind) => get(6000 + kind * STRIP_N + ai, () => bakeStrip(ai, kind), true);
  const boomCv = (kind, v, fi) => get(4000 + (kind * 2 + v) * BOOM_N + fi, () => bakeBoom(kind, v, fi), false);
  const smokeCv = (v, fi) => get(5000 + v * SMK_N + fi, () => bakeSmokeCol(v, fi), false);
  // warm-up queue: after the first salvo the burst / smoke frames are baked in the background, a few ms per frame
  const queue = [];
  let warmed = false;
  function warm() {
    if (warmed) return;
    warmed = true;
    for (let fi = 0; fi < BOOM_N; fi++) { queue.push(() => boomCv(0, 0, fi)); queue.push(() => boomCv(0, 1, fi)); }
    for (let fi = 0; fi < SMK_N; fi++) { queue.push(() => smokeCv(0, fi)); queue.push(() => smokeCv(1, fi)); }
    for (let fi = 0; fi < BOOM_N; fi++) queue.push(() => boomCv(1, 0, fi));
    queue.reverse();
  }
  function pump() {
    while (queue.length && performance.now() - frameStart < BUDGET_MS) queue.pop()();
  }

  // ------------------------------------------------------------------ drawing helpers
  const A = { x: 0, y: 0, alt: 0, s: 0, u: 0 }, B = { x: 0, y: 0, alt: 0, s: 0, u: 0 };
  /** draw sprite sp (anchor ax,ay in baked px of the uncropped frame) at device px X,Y, k = device px per baked px; alpha < 1 = translucent */
  function blit(ctx, sp, ax, ay, X, Y, k, alpha) {
    if (sp.cv === null) return;
    if (alpha < 1) ctx.globalAlpha = alpha;
    ctx.drawImage(sp.cv, Math.round(X + (sp.dx - ax) * k), Math.round(Y + (sp.dy - ay) * k), Math.round(sp.cv.width * k), Math.round(sp.cv.height * k));
    if (alpha < 1) ctx.globalAlpha = 1;
  }
  /** puff sprites are anchored at the middle of their frame */
  function blitPuff(ctx, sp, X, Y, k) {
    if (sp.cv === null) return;
    ctx.drawImage(sp.cv, Math.round(X + (sp.dx - sp.ow * 0.5) * k), Math.round(Y + (sp.dy - sp.oh * 0.5) * k), Math.round(sp.cv.width * k), Math.round(sp.cv.height * k));
  }
  const P0 = { x: 0, y: 0, alt: 0, s: 0 }, P1 = { x: 0, y: 0, alt: 0, s: 0 }, P2 = { x: 0, y: 0, alt: 0, s: 0 };
  /** the smoke trail of a rocket = 2 baked strips laid along its flight curve behind distance fraction sHead (screen origin ox,oy; k = device px per baked px).
   *  lingering (age01 >= 0): after the impact: cooler puffs, rising + growing with the age, fading with alpha */
  function drawStrips(ctx, e, sHead, ox, oy, sc, k, age01, alpha, cw, ch) {
    const L = Math.max(4, Math.hypot(e.x1 - e.x0, e.y1 - e.y0)), ds = D_MID / L, m = 4 * sc, lin = age01 >= 0, kk = lin ? k * (1 + 0.7 * age01) : k, up = lin ? age01 * 0.9 * sc : 0;
    PowerRocket.pathS(e, sHead, P0); PowerRocket.pathS(e, sHead - ds, P1); PowerRocket.pathS(e, sHead - 2 * ds, P2);
    const x0 = ox + P0.x * sc, y0 = oy + (P0.y - P0.alt) * sc, x1 = ox + P1.x * sc, y1 = oy + (P1.y - P1.alt) * sc, x2 = ox + P2.x * sc, y2 = oy + (P2.y - P2.alt) * sc;
    const kn = lin && age01 > 0.2 ? 2 : 0;
    for (let q = 0; q < 2; q++) {                                                                  // q = 0 near strip, 1 far strip
      const xa = q ? x1 : x0, ya = q ? y1 : y0, xb = q ? x2 : x1, yb = q ? y2 : y1, dx = xb - xa, dy = yb - ya;
      if (dx * dx + dy * dy < 4) continue;
      if ((xa < -m && xb < -m) || (xa > cw + m && xb > cw + m) || (ya < -m && yb < -m) || (ya > ch + m && yb > ch + m)) continue;
      let ai = Math.round(Math.atan2(dy, dx) / TAU * STRIP_N) % STRIP_N; if (ai < 0) ai += STRIP_N;
      const sp = stripCv(ai, kn + q);
      if (sp) blit(ctx, sp, STRIP_C, STRIP_C, xa, ya - up, kk, alpha);
    }
  }
  let passNow = -1, passIdx = -1;
  /** true for the first rocket drawn in a frame: the render time changed, or the entries came round again (same timestamp drawn twice) */
  function newPass(list, e, now) {
    let i = -1;
    for (let j = passIdx + 1; j < list.length; j++) if (list[j] === e) { i = j; break; }
    let fresh = now !== passNow;
    if (i < 0) { fresh = true; for (let j = 0; j <= passIdx && j < list.length; j++) if (list[j] === e) { i = j; break; } }
    passNow = now; passIdx = i;
    return fresh;
  }
  /** all warning reticles of the frame in one pass (called by the first rocket drawn): they lie under every rocket sprite. ref = the entry being drawn (screen origin) */
  function drawReticles(ctx, list, px, py, ref, sc, now, alpha, cw, ch) {
    const RT = PowerRocket.params.RETICLE_TICKS, k = sc / 16, ox = px - ref.x * sc, oy = py - ref.y * sc;
    const Tn = S.tick + (alpha > 0 ? alpha : 0), sp = retCv(((now / 90) | 0) & 3);
    for (let i = 0; i < list.length; i++) {
      const e = list[i], left = e.eta - Tn;
      if (!(left <= RT) || left <= 0 || !(Tn >= e.t0)) continue;
      const rx = ox + e.x1 * sc, ry = oy + e.y1 * sc;
      if (rx < -3 * sc || rx > cw + 3 * sc || ry < -3 * sc || ry > ch + 3 * sc) continue;
      const pulse = 0.85 + 0.15 * Math.sin(now / 75 + e.v), f = Math.min(1, (RT - left) / 2.2 + 0.15) * pulse;
      blit(ctx, sp, RET_C, RET_C, rx, ry, k * (1 + 0.32 * (left / RT)), f);
    }
  }
  function drawRocket(ctx, e, px, py, sc, now, H, alpha) {
    if (typeof PowerRocket === 'undefined') return;
    tick(now); pump();
    const cw = ctx.canvas.width, ch = ctx.canvas.height, list = S.eff.rockets;
    if (newPass(list, e, now)) drawReticles(ctx, list, px, py, e, sc, now, alpha, cw, ch);
    const Tn = S.tick + (alpha > 0 ? alpha : 0);
    if (!(Tn >= e.t0)) return;
    const eta = e.eta, T = Tn > eta ? eta : Tn;
    const ox = px - e.x * sc, oy = py - e.y * sc, k = sc / 16;
    PowerRocket.path(e, T, A);
    const hx = ox + A.x * sc, hy = oy + (A.y - A.alt) * sc, M = 9 * sc;
    const headIn = hx > -M && hx < cw + M && hy > -M && hy < ch + M;
    if (!headIn || T >= eta) return;
    // ground shadow
    const gx = ox + A.x * sc, gy = oy + A.y * sc, hh = Math.max(1, e.h);
    ctx.globalAlpha = 0.3 * (1 - 0.55 * Math.min(1, A.alt / hh));
    ctx.fillStyle = '#10141c';
    const sw = Math.max(2, Math.round(7 * k)), sh = Math.max(1, Math.round(2.2 * k));
    ctx.fillRect(Math.round(gx - sw / 2), Math.round(gy - sh / 2), sw, sh);
    ctx.globalAlpha = 1;
    // smoke trail
    drawStrips(ctx, e, A.s, ox, oy, sc, k, -1, 1, cw, ch);
    // the rocket: nose follows the screen-space velocity
    const T1 = Math.max(e.t0, T - 0.3), T2 = Math.min(eta, T + 0.3);
    PowerRocket.path(e, T1 < T2 ? T1 : eta - 0.6, A);
    PowerRocket.path(e, T1 < T2 ? T2 : eta, B);
    const ang = Math.atan2((B.y - B.alt) - (A.y - A.alt), B.x - A.x);
    let ai = Math.round(ang / TAU * ANG_N) % ANG_N; if (ai < 0) ai += ANG_N;
    const fi = (((now / 55) | 0) + (e.v & 3)) % FLAME_N;
    const sp = rocketCv(ai, fi);
    if (sp) blit(ctx, sp, SPR_C, SPR_C, hx, hy, k, 1);
  }

  // ------------------------------------------------------------------ fx
  function fxBoom(ctx, fx, px, py, sc, u, p, now, H) {
    tick(now); pump();
    const k = sc / 16, seed = (fx._s | 0), kind = fx.w ? 1 : 0;
    let fi = (p * BOOM_N) | 0; if (fi >= BOOM_N) fi = BOOM_N - 1;
    const copies = fx.m > 1 ? Math.min(5, 1 + (fx.m >> 1)) : 1;
    for (let j = 0; j < copies; j++) {
      let X = px, Y = py, f2 = fi;
      if (j > 0) {
        const an = hf(seed + j * 3.1) * TAU, d = (0.5 + 0.8 * hf(seed + j * 7.7)) * sc;
        X += Math.cos(an) * d; Y += Math.sin(an) * d * 0.8; f2 = Math.max(0, fi - (j & 1) - 1);
      }
      const sp = boomCv(kind, kind ? 0 : ((seed + j) & 1), f2);
      if (sp) blit(ctx, sp, BOOM_AX, BOOM_AY, X, Y, k, 1);
    }
  }
  function fxSmokeCol(ctx, fx, px, py, sc, u, p, now, H) {
    tick(now);
    let fi = (p * SMK_N) | 0; if (fi >= SMK_N) fi = SMK_N - 1;
    const sp = smokeCv((fx._s | 0) & 1, fi);
    if (sp) blit(ctx, sp, SMK_AX, SMK_AY, px, py, sc / 16, 1);
  }
  const TR = { x0: 0, y0: 0, x1: 0, y1: 0, b: 0, h: 1.5 };
  function fxTrail(ctx, fx, px, py, sc, u, p, now, H) {
    if (typeof PowerRocket === 'undefined') return;
    tick(now);
    TR.x0 = fx.x0; TR.y0 = fx.y0; TR.x1 = fx.x1; TR.y1 = fx.y1; TR.b = fx.b; TR.h = fx.h;
    drawStrips(ctx, TR, 1, px - fx.x1 * sc, py - fx.y1 * sc, sc, sc / 16, p, Math.pow(1 - p, 1.2), ctx.canvas.width, ctx.canvas.height);
  }
  const LAUNCH_ANG = [0.7, 1.9, 3.1, 4.4, 5.5, 2.6];
  function fxLaunch(ctx, fx, px, py, sc, u, p, now, H) {
    tick(now);
    const k = sc / 16, dx = fx.dx || 0, dy = fx.dy || 0;
    if (p < 0.2) {                                                                                         // muzzle flash
      ctx.globalAlpha = 1 - p / 0.2; ctx.fillStyle = '#fff6c8';
      H.R4(ctx, px, py, u, -7, -1.2, 14, 2.4); H.R4(ctx, px, py, u, -1.2, -7, 2.4, 14);
      ctx.fillStyle = '#ffd83c'; H.R4(ctx, px, py, u, -4, -4, 8, 8);
      ctx.globalAlpha = 1;
    }
    const a0 = Math.atan2(dy, dx);
    for (let i = 0; i < 6; i++) {                                                                          // smoke blown back + sideways
      const t = Math.max(0, p * 1.25 - i * 0.04); if (t <= 0 || t >= 1) continue;
      const an = a0 + Math.PI + (LAUNCH_ANG[i] - 3.1) * 0.5, d = (0.4 + 2.4 * ease(t)) * sc * (0.7 + 0.12 * i);
      const sp = puffCv(1 + (i & 1) + (t > 0.5 ? 1 : 0), 0, lvlOf((1 - t) * 0.95));
      if (sp) blitPuff(ctx, sp, px + Math.cos(an) * d, py + Math.sin(an) * d - t * sc * 0.5, k * (0.8 + t));
    }
  }

  // ------------------------------------------------------------------ registrations (load time: core globals only)
  GfxPlugins.icons.rocket = (b, IP, H) => drawIcon(b, IP);
  GfxPlugins.addEffect({ key: 'rockets', margin: 48, draw: drawRocket });
  GfxPlugins.fx.rocket_boom = fxBoom;
  GfxPlugins.fx.rocket_smoke = fxSmokeCol;
  GfxPlugins.fx.rocket_trail = fxTrail;
  GfxPlugins.fx.rocket_launch = fxLaunch;
  Bus.on('rocketVolley', (n) => {
    try {
      warm();
      if (typeof UI !== 'undefined' && UI && typeof UI.toast === 'function') UI.toast('Залп: ' + n + ' ' + Util.plural(n, 'ракета', 'ракеты', 'ракет'), 'good');
    } catch (err) { /* cosmetic only */ }
  });

  return {
    PB, bake: { rocket: bakeRocket, puff: bakePuff, strip: bakeStrip, reticle: bakeReticle, boom: bakeBoom, smoke: bakeSmokeCol, icon: drawIcon },
    dims: { ANG_N, FLAME_N, SPR, SPR_C, STRIP_N, STRIP_S, STRIP_C, BOOM_N, BOOM_W, BOOM_H, BOOM_AX, BOOM_AY, SMK_N, SMK_W, SMK_H, SMK_AX, SMK_AY, RET_S, RET_C, PUFF_R },
    stats() { return { cached: cache.size, queued: queue.length }; },
    warm, queue,
  };
})();
