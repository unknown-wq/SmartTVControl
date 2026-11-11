/* =====================================================================
 * 34_gfx_volcano.js — graphics of the «Вулкан» power (CONTRACT section 10.3).  Client only, no DOM at load time.
 *
 *  - icon 'volcano' (14x14 glyph)
 *  - persistent effect S.eff.volcanoes: glowing crater (additive banded glow + bubbling lava), a dark ash plume that rises and leans
 *    (<= 18 puffs per volcano, each ONE drawImage of a cached pixel-art cloud sprite), lava bombs in flight (arc, trail, ground shadow), ash flecks
 *  - the crater blast (flash, fireball, sparks, smoke ball; the big opening blast adds a shock ring) is drawn by the effect after the plume, from
 *    the entry's lb / lbg; Fx type volc_impact (bomb landing: splat, droplets, wisp). Both are baked once per animation frame into small canvases.
 *  Budget: <= 0.6 ms per frame with a full eruption in view. Everything is cached by small integer keys; nothing is allocated per frame.
 * ===================================================================== */

const GfxVolcano = (() => {
  const TAU = Math.PI * 2;

  // ------------------------------------------------------------------ icon
  GfxPlugins.icons.volcano = (b, IP) => {
    // ash cloud rising to the upper right, clearly apart from the cone
    b.disc(10.6, 1.5, 1.7, IP.W); b.disc(8.6, 2.9, 1.5, IP.g); b.disc(12, 3.1, 1.3, IP.g); b.disc(10.4, 3.7, 1.2, IP.G);
    b.set(10, 0, IP.w); b.set(11, 0, IP.w); b.set(9, 1, IP.w);
    // sparks flying out of the crater
    b.set(3, 3, IP.y); b.set(5, 1, IP.o); b.set(4, 4, IP.o); b.set(9, 4, IP.y);
    // the cone: four tones, light rock on the left, deep shade on the right
    for (const r of [[6, 3, 10], [7, 2, 11], [8, 2, 11], [9, 1, 12], [10, 1, 12], [11, 0, 13], [12, 0, 13]]) {
      for (let x = r[1]; x <= r[2]; x++) { const t = (x - r[1]) / (r[2] - r[1]); b.set(x, r[0], t < 0.16 ? IP.W : t < 0.5 ? IP.g : t < 0.8 ? IP.G : IP.d); }
    }
    // crater: dark rim, molten pool, a bubble of lava above it
    b.rect(4, 5, 6, 1, IP.o); b.rect(5, 4, 4, 1, IP.y); b.rect(6, 3, 2, 1, IP.y);
    b.rect(4, 6, 6, 1, IP.R); b.rect(5, 6, 4, 1, IP.o); b.rect(6, 6, 2, 1, IP.y);
    b.rect(5, 7, 4, 1, IP.r); b.rect(6, 7, 2, 1, IP.o);
    // lava streams down the slope
    b.set(6, 8, IP.o); b.set(6, 9, IP.r); b.set(5, 9, IP.o); b.set(5, 10, IP.r); b.set(4, 10, IP.o); b.set(4, 11, IP.r); b.set(3, 11, IP.o); b.set(3, 12, IP.r);
    b.set(8, 8, IP.O); b.set(9, 9, IP.O); b.set(9, 10, IP.R); b.set(10, 11, IP.R);
    // ground
    b.rect(0, 13, 14, 1, IP.n);
  };

  // ------------------------------------------------------------------ small helpers
  function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function hf(n) { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); }
  function smooth(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
  function pxDisc(g, cx, cy, rad, col) {
    g.fillStyle = col;
    const n = Math.ceil(rad), y0 = Math.round(cy);
    for (let j = -n; j <= n; j++) {
      const dy = j + 0.5; if (dy > rad || -dy > rad) continue;
      const w = Math.max(1, Math.round(Math.sqrt(rad * rad - dy * dy) * 2));
      g.fillRect(Math.round(cx - w / 2), y0 + j, w, 1);
    }
  }
  function pxRing(g, cx, cy, rx, ry, th, col) {
    g.fillStyle = col;
    const steps = Math.max(12, Math.round((rx + ry) * 1.6));
    for (let i = 0; i < steps; i++) { const a = i / steps * TAU; g.fillRect(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry), th, th); }
  }
  let bakeNow = -1, bakeLeft = 0;
  /** at most 3 new baked frames per rendered frame (a burst of new frame variants never costs a hitch) */
  function canBake(now) { if (now !== bakeNow) { bakeNow = now; bakeLeft = 3; } return bakeLeft-- > 0; }

  // ------------------------------------------------------------------ baked sprites
  const PUFF_N = 8;
  let puffs = null, halo = null, heat = null;
  function bakePuffs() {
    const DK = '#1d181e', BASE = '#3b3239', MID = '#5b4f58', LIGHT = '#8d8089';
    const out = [];
    for (let v = 0; v < PUFF_N; v++) {
      const c = mk(40, 40), g = c.getContext('2d'), lobes = [], n = 5 + (v % 3);
      for (let i = 0; i < n; i++) {
        const a = hf(v * 13.1 + i * 2.7) * TAU, d = i === 0 ? 0 : 4.5 + hf(v * 7.7 + i * 5.3) * 5.5;
        lobes.push([20 + Math.cos(a) * d, 21 + Math.sin(a) * d * 0.8, 7.5 + hf(v * 3.3 + i * 9.1) * 3.5 - i * 0.25]);
      }
      lobes.sort((p, q) => q[1] - p[1]);
      for (let i = 0; i < n; i++) pxDisc(g, lobes[i][0], lobes[i][1], lobes[i][2], DK);
      for (let i = 0; i < n; i++) pxDisc(g, lobes[i][0] - 0.6, lobes[i][1] - 0.8, lobes[i][2] - 1.4, BASE);
      for (let i = 0; i < n; i++) pxDisc(g, lobes[i][0] - lobes[i][2] * 0.22, lobes[i][1] - lobes[i][2] * 0.32, lobes[i][2] * 0.6, MID);
      for (let i = n - 1; i >= Math.max(0, n - 3); i--) pxDisc(g, lobes[i][0] - lobes[i][2] * 0.36, lobes[i][1] - lobes[i][2] * 0.46, lobes[i][2] * 0.26, LIGHT);
      out.push(c);
    }
    return out;
  }
  function bakeGlow(bands) {
    const c = mk(64, 64), g = c.getContext('2d');
    for (let i = 0; i < bands.length; i++) { g.globalAlpha = bands[i][1]; pxDisc(g, 32, 32, bands[i][0], bands[i][2]); }
    return c;
  }
  const HALO = [[31, 0.05, '#ff5a14'], [26, 0.07, '#ff6a18'], [21, 0.09, '#ff7a20'], [16, 0.11, '#ff9a2c'], [11, 0.13, '#ffb23c'], [6.5, 0.15, '#ffcc58']];   // warm tint over the ground (normal blend)
  const HEAT = [[31, 0.10, '#ff4a10'], [26, 0.14, '#ff6a18'], [21, 0.18, '#ff8a22'], [16, 0.24, '#ffaa30'], [11, 0.32, '#ffcc48']];                            // additive: lights the base of the smoke
  // the cone's own shading: light from the top-left, 4x4 px blocks derived from the cone profile (the terrain shading alone is too faint on a cone)
  const shadeBank = new Map();
  function bakeShade(r) {
    const gm = PowerVolcano.geom(r), rb = gm.rb, rc = gm.rc, T = Math.ceil(rb), N = 2 * T + 1, W = N * 16, BL = 4;
    const c = mk(W, W), g = c.getContext('2d');
    for (let by = 0; by < W / BL; by++) {
      for (let bx = 0; bx < W / BL; bx++) {
        const px = (bx + 0.5) * BL / 16 - (T + 0.5), py = (by + 0.5) * BL / 16 - (T + 0.5), d = Math.sqrt(px * px + py * py);
        if (d <= rc + 0.4 || d > rb + 0.35) continue;
        const slope = (gm.elevAt(Math.max(0, d - 0.12)) - gm.elevAt(d + 0.12)) / 0.24 * 0.045;     // the elevation falls outward
        const nx = slope * px / d, ny = slope * py / d, nn = Math.sqrt(nx * nx + ny * ny + 1);
        const lam = (-0.55 * nx - 0.55 * ny + 0.63) / nn - 0.63, edge = smooth((rb + 0.35 - d) / 0.9);
        let a = 0, col = '';
        if (lam > 0.16) { a = 0.2; col = '255,244,214'; } else if (lam > 0.07) { a = 0.1; col = '255,244,214'; }
        else if (lam < -0.30) { a = 0.34; col = '26,12,48'; } else if (lam < -0.19) { a = 0.24; col = '26,12,48'; } else if (lam < -0.08) { a = 0.12; col = '26,12,48'; }
        if (a === 0) continue;
        g.fillStyle = 'rgba(' + col + ',' + (a * edge).toFixed(3) + ')';
        g.fillRect(bx * BL, by * BL, BL, BL);
      }
    }
    return c;
  }
  function ensure() {
    if (!puffs) puffs = bakePuffs();
    if (!halo) { halo = bakeGlow(HALO); heat = bakeGlow(HEAT); }
  }

  // ---- fx frame banks: (big?) x frame -> canvas, built lazily
  const burstBank = new Map(), impactBank = new Map();
  const BURST = { n: 9, w: 192, h: 164, ax: 96, ay: 134 }, IMPACT = { n: 7, w: 64, h: 56, ax: 32, ay: 36 };

  function bakeBurst(big, fi) {
    const c = mk(BURST.w, BURST.h), g = c.getContext('2d'), p = (fi + 0.5) / BURST.n, k = big ? 2.5 : 1.3, AX = BURST.ax, AY = BURST.ay;
    const fade = p < 0.5 ? 1 : 1 - (p - 0.5) / 0.5;
    g.globalAlpha = fade;
    if (big && p < 0.75) {                                          // ground shock ring
      const q = p / 0.75;
      g.globalAlpha = 0.75 * (1 - q); pxRing(g, AX, AY, 14 + 74 * q, 6 + 26 * q, 2, '#fff0d0');
      g.globalAlpha = 0.4 * (1 - q); pxRing(g, AX, AY, 8 + 50 * q, 4 + 17 * q, 2, '#ffb040'); g.globalAlpha = fade;
    }
    if (p < 0.4) {                                                  // flash on the crater: a flat hot blob
      const q = p / 0.4;
      pxDisc(g, AX, AY - 2, (5 + 10 * q) * k, '#ff5a14'); pxDisc(g, AX, AY - 3, (3.6 + 7 * q) * k, '#ff9a2a');
      pxDisc(g, AX, AY - 4, (2.4 + 4 * q) * k, '#ffd84a'); pxDisc(g, AX, AY - 4, (1.2 + 2 * q) * k, '#fff6c8');
    }
    if (p < 0.8) {                                                  // a fire fountain: tongues of flame leaning out of the crater, a ragged head
      const grow = Math.sin(Math.min(1, p / 0.5) * Math.PI * 0.5), die = p < 0.55 ? 1 : 1 - (p - 0.55) / 0.25, top = (10 + 38 * grow) * k * die;
      const rows = [['#c93d12', 1], ['#ff6a1a', 0.78], ['#ffb030', 0.5], ['#ffe880', 0.24]];
      for (let j = -4; j <= 4; j++) {
        const fx = AX + j * 3.2 * k * 0.62 + (hf(j * 2.3 + fi * 1.7) - 0.5) * 2.5 * k * 0.5, hh = top * (1 - Math.abs(j) / 5.2) * (0.68 + 0.32 * hf(j * 3.9 + fi * 2.9));
        const lean = (hf(j + fi * 0.7) - 0.5) * hh * 0.28;
        for (let q = 0; q < rows.length; q++) {
          const w = Math.max(2, Math.round((4.2 - Math.abs(j) * 0.35) * k * 0.62 * rows[q][1])), h = Math.round(hh * rows[q][1]);
          g.fillStyle = rows[q][0];
          for (let y = 0; y < h; y += 2) g.fillRect(Math.round(fx - w / 2 + lean * (y / Math.max(1, h))), Math.round(AY - 3 - y - 2), Math.max(1, w - ((y / h) > 0.7 ? 1 : 0)), 2);
        }
      }
      const hr = (5 + 6 * grow) * k * die;                           // irregular head: three lobes
      for (let l = 0; l < 3; l++) {
        const hx = AX + (l - 1) * hr * 0.72 + (hf(fi * 1.1 + l) - 0.5) * 3, hy = AY - 3 - top * (0.92 - 0.1 * Math.abs(l - 1)) + hf(l + fi * 0.3) * 3, lr = hr * (l === 1 ? 1 : 0.74);
        pxDisc(g, hx, hy, lr, '#c93d12'); pxDisc(g, hx - 0.5, hy - 0.6, lr * 0.8, '#ff6a1a'); pxDisc(g, hx - 1, hy - 1.2, lr * 0.55, '#ffa030');
        if (p < 0.45) pxDisc(g, hx - 1.4, hy - 1.7, lr * 0.28, '#ffe880');
      }
    }
    const n = big ? 30 : 16, ks = Math.min(k, 1.9);                 // sparks / lava droplets in ballistic arcs
    for (let j = 0; j < n; j++) {
      const a = -Math.PI / 2 + (hf(j * 1.7 + 1) - 0.5) * 2.3, sp = (16 + 30 * hf(j * 3.3 + 2)) * ks;
      const t = Math.min(1, p * 1.25), sx = AX + Math.cos(a) * sp * t, sy = AY - 4 + Math.sin(a) * sp * t + 44 * t * t * ks * 0.55;
      g.fillStyle = j % 3 === 0 ? '#ffe070' : j % 3 === 1 ? '#ff9a2a' : '#ff5a1a';
      const sz = j % 4 === 0 ? 3 : 2;
      g.fillRect(Math.round(sx), Math.round(sy), sz, sz);
    }
    if (p > 0.3) {                                                  // a few ragged wisps of soot behind the flames (the plume does the real smoke)
      const q = (p - 0.3) / 0.7;
      g.globalAlpha = 0.7 * (1 - q * 0.8);
      for (let j = 0; j < 5; j++) {
        const sx = AX + (hf(j * 4.1 + 2) - 0.5) * 20 * k, sy = AY - (14 + 30 * hf(j * 2.2) + 22 * q) * k, rr = (2.6 + 3 * hf(j * 6.3 + 1)) * k * (0.7 + 0.5 * q);
        pxDisc(g, sx, sy, rr, '#2b2429'); pxDisc(g, sx - rr * 0.25, sy - rr * 0.3, rr * 0.6, '#52474e');
      }
    }
    return c;
  }
  function bakeImpact(fi) {
    const c = mk(IMPACT.w, IMPACT.h), g = c.getContext('2d'), p = (fi + 0.5) / IMPACT.n, AX = IMPACT.ax, AY = IMPACT.ay;
    const fade = p < 0.55 ? 1 : 1 - (p - 0.55) / 0.45;
    g.globalAlpha = fade;
    if (p < 0.3) { pxDisc(g, AX, AY, 7 + p * 14, '#ff7a1e'); pxDisc(g, AX, AY, 4.5 + p * 10, '#ffd048'); pxDisc(g, AX, AY - 1, 2.5 + p * 4, '#fff6c8'); }
    // the puddle: blobs around a hot centre, cooling to a dark crust
    const hot = Math.max(0, 1 - p * 1.5), rr = 6 + 4 * Math.min(1, p * 2.5);
    pxDisc(g, AX, AY, rr, p > 0.5 ? '#4c1810' : '#9a2408');
    pxDisc(g, AX - 0.5, AY - 0.5, rr * 0.8, p > 0.4 ? '#8a2612' : '#d84a12');
    if (hot > 0) { pxDisc(g, AX - 1, AY - 1, rr * 0.5, '#ff9a2a'); pxDisc(g, AX - 1, AY - 1, rr * 0.25, '#ffe070'); }
    for (let j = 0; j < 7; j++) {                                  // droplets thrown out
      const a = hf(j * 2.1 + 5) * TAU, d = (6 + 12 * hf(j * 4.3 + 1)) * Math.min(1, p * 2), up = Math.sin(Math.min(1, p * 1.6) * Math.PI) * (4 + 5 * hf(j + 9));
      g.fillStyle = j & 1 ? '#ffb030' : '#ff6a1a';
      g.fillRect(Math.round(AX + Math.cos(a) * d), Math.round(AY + Math.sin(a) * d * 0.6 - up), 2, 2);
    }
    if (p > 0.35) {                                                 // a wisp of smoke from the cooling puddle
      const q = (p - 0.35) / 0.65;
      g.globalAlpha = 0.55 * (1 - q);
      pxDisc(g, AX + 1, AY - 5 - q * 12, 3 + q * 3, '#4a4046'); pxDisc(g, AX, AY - 6 - q * 12, 1.8 + q * 1.8, '#7a6e74');
    }
    return c;
  }

  // ------------------------------------------------------------------ Fx entries
  // (the crater blast is drawn by the persistent effect, after the plume - Fx entries are painted before persistent effects and would sit behind the smoke)
  GfxPlugins.fx.volc_impact = (ctx, fx, px, py, scale, u, p, now) => {
    const fi = Math.min(IMPACT.n - 1, (p * IMPACT.n) | 0);
    let cv = impactBank.get(fi);
    if (cv === undefined) { if (!canBake(now)) return; cv = bakeImpact(fi); impactBank.set(fi, cv); }
    ctx.imageSmoothingEnabled = scale < 16;
    ctx.drawImage(cv, Math.round(px - IMPACT.ax * u), Math.round(py - IMPACT.ay * u), Math.round(IMPACT.w * u), Math.round(IMPACT.h * u));
  };

  // ------------------------------------------------------------------ persistent effect
  /** smoke strength 0..1.3 */
  function plumeK(e, tf) {
    if (e.phase === 0) return 0.14 + 0.5 * Math.min(1, Math.max(0, (tf - e.t0) / e.rum));
    if (e.phase === 1) { const s = Math.max(0, 1 - (tf - e.lb) / 24); return 0.95 + 0.35 * s * s; }
    const q = Math.max(0, 1 - (tf - e.t2) / Math.max(1, e.until - e.t2));
    return q * q * 0.95;
  }
  /** crater glow 0..1 */
  function glowK(e, tf) {
    if (e.phase === 0) return Math.max(0, ((tf - e.t0) / e.rum - 0.45) * 1.1);
    if (e.phase === 1) return 1;
    return Math.max(0, 1 - (tf - e.t2) / 70);
  }

  /** the cone's own light and shade (fades in while the cone rises, out while it cools: the entry is gone after that) */
  function drawShade(ctx, e, X, Y, sc, tf) {
    const a = e.phase === 0 ? (e.old ? 1 : smooth((tf - e.t0 - 6) / (e.rum - 14))) : e.phase === 1 ? 1 : 1 - smooth((tf - e.t2) / Math.max(1, e.until - e.t2));
    if (a < 0.02 || typeof PowerVolcano === 'undefined') return;
    let cv = shadeBank.get(e.r);
    if (cv === undefined) { cv = bakeShade(e.r); shadeBank.set(e.r, cv); }
    const T = Math.ceil(e.rb), W = (2 * T + 1) * sc;
    ctx.globalAlpha = a;
    ctx.drawImage(cv, Math.round(X - (T + 0.5) * sc), Math.round(Y - (T + 0.5) * sc), Math.round(W), Math.round(W));
    ctx.globalAlpha = 1;
  }
  function drawGlow(ctx, e, X, Y, sc, now, g) {
    const pulse = 1 + 0.06 * Math.sin(now / 170 + e.id) + 0.04 * Math.sin(now / 97 + e.id * 2);
    const rad = (e.rc + 1.9) * sc * pulse;
    ctx.globalAlpha = Math.min(1, g);                                       // warm tint on the ground (normal blend: additive washes grey rock out)
    ctx.drawImage(halo, X - rad, Y - rad, rad * 2, rad * 2);
    if (sc >= 9) {                                                         // a small hot core over the lava (additive blending is the slow path of a software canvas: not when the map is far away)
      const rr = (e.rc + 0.5) * sc * pulse;
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.3 * g;
      ctx.drawImage(heat, X - rr, Y - rr, rr * 2, rr * 2);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
    // bubbles popping on the lava surface
    if (sc >= 12 && e.phase === 1) {
      const u = sc / 16, cr = e.cr, w = S.w;
      for (let k = 0; k < cr.length; k++) {
        const i = cr[k], ph = (now / 650 + hf(i * 0.37 + e.id)) % 1;
        if (ph > 0.42 || S.tile[i] !== Const.T.LAVA) continue;
        const tx = i % w, ty = (i - tx) / w;
        const bx = X + (tx + 0.5 - e.x) * sc + (hf(i + Math.floor(now / 650 + hf(i * 0.37 + e.id))) - 0.5) * sc * 0.6, by = Y + (ty + 0.5 - e.y) * sc + (hf(i * 1.9 + 3) - 0.5) * sc * 0.5;
        const s = Math.sin(ph / 0.42 * Math.PI);
        ctx.fillStyle = '#fff1a8'; ctx.globalAlpha = 0.9 * s; ctx.fillRect(Math.round(bx), Math.round(by), Math.max(2, Math.round(u * (1 + 1.4 * s))), Math.max(2, Math.round(u * (1 + 1.4 * s))));
      }
      ctx.globalAlpha = 1;
    }
  }

  // A software canvas pays for every translucent pixel, and the plume was ~80% of the cost of a whole eruption (22 uniform slots overlapped ~8-fold, the big faint puffs at the top
  // cost the most and add the least). So the slots are packed toward the base (position = (slot / N) ^ PLUME_E): the dense dark body stays, the airy top gets fewer puffs: -32% pixels.
  const PLUME_N = 18, PLUME_E = 1.5;
  function drawPlume(ctx, e, X, Y, sc, now, k, g) {
    const N = sc < 10 ? 12 : PLUME_N, E = sc < 10 ? 1 : PLUME_E;           // a fixed number of slots (fewer when the map is zoomed far out): the column never pops when the strength changes
    const kk = Math.min(1.25, k), hgt = (3.2 + 5.6 * kk + 0.3 * e.rb) * sc;
    const lean = (e.wd * 0.9 + 0.12 * Math.sin(now / 3700 + e.id)) * hgt * 0.55;
    const sizeK = (0.5 + 0.5 * Math.min(1, k)) * (0.62 + 0.13 * e.rb);                  // wider column for a wider cone (r=1: 1.08, r=3: 1.2, r=8: 1.53)
    const tN = (now / 6600 + hf(e.id)) * N, fl = Math.floor(tN), i0 = fl % N, f = tN - fl;   // slot ring: puff j climbs, wraps from the top to the crater
    const aMax = 0.4 + 0.45 * Math.min(1, k);
    for (let q = N - 1; q >= 0; q--) {
      const p = E === 1 ? (q + f) / N : Math.pow((q + f) / N, E), j = ((q - i0) % N + N) % N;
      const h1 = hf(j * 7.31 + e.id * 0.17), h2 = hf(j * 3.77 + 1.3 + e.id * 0.31), h3 = hf(j * 5.13 + 2.9 + e.id * 0.11);
      const yy = hgt * (1 - Math.pow(1 - p, 1.5));
      const xx = lean * Math.pow(p, 1.3) + Math.sin(now / 1500 + j * 1.7 + e.id) * (0.12 + 0.45 * p) * sc + (h1 - 0.5) * sc * (0.5 + 2.6 * p);      // the column billows out toward the top
      const size = (1.05 + 3.1 * Math.pow(p, 0.68)) * sizeK * (0.82 + 0.36 * h2) * sc;
      const a = aMax * smooth(p / 0.07) * (1 - 0.8 * smooth((p - 0.35) / 0.65));
      if (a < 0.02) continue;
      ctx.globalAlpha = a;
      ctx.drawImage(puffs[(j + ((h3 * 4) | 0)) % PUFF_N], X + xx - size / 2, Y - 0.15 * sc - yy - size / 2 + (h3 - 0.5) * sc * 0.4, size, size);
    }
    ctx.globalAlpha = 1;
    // lit from below: a soft additive glow on the base of the column
    if (g > 0.05 && sc >= 9) {
      const rad = (1.4 + 0.7 * kk) * sc * (e.rb * 0.2 + 1);
      ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.2 * g * Math.min(1, k);
      ctx.drawImage(heat, X - rad, Y - rad * 1.55, rad * 2, rad * 2);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    }
  }

  /** the blast at the crater when a burst fires: ~9 ticks (14 for the big opening blast), baked frames, ONE drawImage */
  function drawBurst(ctx, e, X, Y, sc, now, tf) {
    const big = e.lbg ? 1 : 0, dur = big ? 14 : 9, age = tf - e.lb;
    if (age < 0 || age >= dur) return;
    const fi = Math.min(BURST.n - 1, (age / dur * BURST.n) | 0), key = big * 16 + fi, u = sc / 16;
    let cv = burstBank.get(key);
    if (cv === undefined) { if (!canBake(now)) return; cv = bakeBurst(big, fi); burstBank.set(key, cv); }
    ctx.drawImage(cv, Math.round(X - BURST.ax * u), Math.round(Y - BURST.ay * u), Math.round(BURST.w * u), Math.round(BURST.h * u));
  }
  function drawBombs(ctx, e, X, Y, sc, tf) {
    const bs = e.bombs, u = sc / 16;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (tf < b[4]) continue;
      const f = (tf - b[4]) / (b[5] - b[4]);
      if (f >= 1) continue;
      const gx = b[0] + (b[2] - b[0]) * f, gy = b[1] + (b[3] - b[1]) * f, up = b[6] * 4 * f * (1 - f);
      const bx = X + (gx - e.x) * sc, by = Y + (gy - e.y) * sc - up * sc;
      // shadow on the ground
      ctx.globalAlpha = 0.28 * (1 - up * 0.12 > 0.3 ? 1 - up * 0.12 : 0.3); ctx.fillStyle = '#000';
      const sw = Math.max(2, u * (4 - up * 0.3));
      ctx.fillRect(Math.round(X + (gx - e.x) * sc - sw / 2), Math.round(Y + (gy - e.y) * sc), Math.round(sw), Math.max(1, Math.round(u * 1.4)));
      // trail: embers cooling from orange to a smoky brown
      for (let j = 6; j >= 1; j--) {
        const ff = f - j * 0.026; if (ff < 0) continue;
        const tx = X + (b[0] + (b[2] - b[0]) * ff - e.x) * sc, ty = Y + (b[1] + (b[3] - b[1]) * ff - e.y) * sc - b[6] * 4 * ff * (1 - ff) * sc;
        const s = Math.max(2, u * (5.4 - j * 0.65));
        ctx.globalAlpha = 0.9 - j * 0.12; ctx.fillStyle = j <= 1 ? '#ffb030' : j === 2 ? '#ff7a1e' : j === 3 ? '#e0501a' : j === 4 ? '#b0381a' : '#5a2a22';
        ctx.fillRect(Math.round(tx - s / 2), Math.round(ty - s / 2), Math.round(s), Math.round(s));
      }
      // body: a round-ish glowing rock (a plus of two rects per layer): dark crust, orange, yellow, white-hot spot
      const s0 = Math.max(5, u * 7.5), q = Math.max(1, Math.round(u * 1.5)), hx = bx - s0 / 2, hy = by - s0 / 2;
      ctx.globalAlpha = 1; ctx.fillStyle = '#4a1a12';
      ctx.fillRect(Math.round(hx - u), Math.round(hy + q), Math.round(s0 + 2 * u), Math.round(s0 - 2 * q)); ctx.fillRect(Math.round(hx + q), Math.round(hy - u), Math.round(s0 - 2 * q), Math.round(s0 + 2 * u));
      ctx.fillStyle = '#ff7a1e';
      ctx.fillRect(Math.round(hx), Math.round(hy + q), Math.round(s0), Math.round(s0 - 2 * q)); ctx.fillRect(Math.round(hx + q), Math.round(hy), Math.round(s0 - 2 * q), Math.round(s0));
      ctx.fillStyle = '#ffd048'; const s1 = Math.max(2, Math.round(s0 * 0.55)); ctx.fillRect(Math.round(hx + u), Math.round(hy + u), s1, s1);
      ctx.fillStyle = '#fff6c8'; const s2 = Math.max(1, Math.round(s0 * 0.26)); ctx.fillRect(Math.round(hx + u * 1.5), Math.round(hy + u * 1.5), s2, s2);
    }
    ctx.globalAlpha = 1;
  }

  function drawAsh(ctx, e, X, Y, sc, now, k) {
    const u = sc / 16, n = Math.min(16, 6 + Math.round(10 * Math.min(1, k)));
    for (let j = 0; j < n; j++) {
      const ph = (now / (5200 + hf(j * 1.3) * 1800) + hf(j * 3.1 + e.id)) % 1, ang = hf(j * 7.7 + e.id) * TAU, rr = (0.6 + 2.0 * hf(j * 2.3 + 4)) * (e.rb + 1.5);
      const x = X + Math.cos(ang) * rr * sc + (e.wd * 0.8 + 0.3) * ph * sc * 2.2, y = Y + Math.sin(ang) * rr * sc * 0.65 - (1 - ph) * sc * (2.5 + 2 * hf(j * 5.9));
      ctx.globalAlpha = Math.sin(ph * Math.PI) * 0.9 * Math.min(1, k);
      ctx.fillStyle = j % 5 === 0 ? '#ff9a2a' : j & 1 ? '#3a3238' : '#80757d';
      const s = Math.max(1.5, u * (1.2 + 0.8 * hf(j + 8)));
      ctx.fillRect(Math.round(x), Math.round(y), Math.round(s), Math.round(s));
    }
    ctx.globalAlpha = 1;
  }

  function drawVolcano(ctx, e, X, Y, sc, now, alpha) {
    ensure();
    const tf = S.tick - 1 + alpha, k = plumeK(e, tf), g = glowK(e, tf);
    ctx.imageSmoothingEnabled = sc < 16;
    drawShade(ctx, e, X, Y, sc, tf);
    if (g > 0.02) drawGlow(ctx, e, X, Y, sc, now, g);
    if (k > 0.03) drawPlume(ctx, e, X, Y, sc, now, k, g);
    if (e.phase !== 0) drawBurst(ctx, e, X, Y, sc, now, tf);
    if (e.bombs.length) drawBombs(ctx, e, X, Y, sc, tf);
    if (sc >= 9 && k > 0.2) drawAsh(ctx, e, X, Y, sc, now, k);
  }

  GfxPlugins.addEffect({
    key: 'volcanoes', margin: 14,
    draw(ctx, e, px, py, scale, now, H, alpha) { drawVolcano(ctx, e, px, py, scale, now, alpha); },
  });

  return { plumeK, glowK };
})();
