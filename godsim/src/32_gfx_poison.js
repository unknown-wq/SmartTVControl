/* =====================================================================
 * 32_gfx_poison.js — graphics of the god power «Яд» (CONTRACT section 10.3). Client side: registrations only at load time (no DOM).
 *
 *  - icon 'poison'            skull flask, 14x14 glyph with the Buf API
 *  - fx   'poison_burst'      the puff that opens when the tool is used (tap / spray)
 *  - fx   'poison_soul'       a pale skull wisp that rises from a victim
 *  - effect S.eff.clouds      the toxic cloud itself: a stippled haze disc with a dashed rim (= the zone where the poison acts) + ONE baked cloud body
 *                             (hemisphere height field, lit from the top-left, yellow-green lights -> teal -> violet shadows, ordered dithering; 8 radius
 *                             buckets x 2 variants x 4 "boiling" frames, baked lazily, one per frame) drawn translucent + rising bubbles + an
 *                             occasional skull wisp; it thins out with the density (fainter, smaller). <= ~15 drawImage per cloud, nothing is
 *                             allocated per frame.
 *  - unit tint 'poison'       violet glaze on poisoned sprites; small green bubbles above poisoned units (capped at 40, drawn by the first cloud of a frame)
 * ===================================================================== */

const GfxPoison = (() => {
  const TAU = Math.PI * 2;
  const hf = (n) => { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); };
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ------------------------------------------------------------------ colours (packed ABGR like Sprites)
  const px32 = (r, g, b, a) => ((((a === undefined ? 255 : a) & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
  function hx(s, a) { return px32(parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), a); }
  // cloud body: outlined cartoon cumulus (like every sprite of the game): cel-shaded puffs painted back to front, each with a dark outline
  const LOOK = { aMass: 1.0, aHaze: 0.92, spore: 0.28, hi: '#f4ffb4', lt: '#dcf460', mid: '#b8e244', sh: '#86bf42', out: '#352668', outw: 1.25, ahi: 215, alt: 185, amid: 160, ash: 175, aout: 240 };
  const PAL = {};
  function setPal() { PAL.hi = hx(LOOK.hi, LOOK.ahi); PAL.lt = hx(LOOK.lt, LOOK.alt); PAL.mid = hx(LOOK.mid, LOOK.amid); PAL.sh = hx(LOOK.sh, LOOK.ash); PAL.out = hx(LOOK.out, LOOK.aout); }
  setPal();

  // ------------------------------------------------------------------ tiny pixel buffer -> canvas (DOM only when a sprite is baked)
  function PB(w, h) { this.w = w; this.h = h; this.d = new Uint32Array(w * h); }
  PB.prototype.set = function (x, y, c) { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c; };
  PB.prototype.toCanvas = function () {
    const cv = document.createElement('canvas');
    cv.width = this.w; cv.height = this.h;
    const g = cv.getContext('2d'), id = g.createImageData(this.w, this.h);
    new Uint32Array(id.data.buffer).set(this.d);
    g.putImageData(id, 0, 0);
    return cv;
  };
  function rng(seed) {
    let s = seed | 0;
    return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // ------------------------------------------------------------------ sprite bakes (lazy; one cloud body per frame)
  const RB = [1.4, 2.0, 2.8, 3.8, 5.2, 7.0, 9.5, 12.5];  // cloud radius buckets (tiles); a cloud uses the bucket nearest to its initial radius and is scaled to fit
  const PXS = [14, 14, 12, 12, 10, 8, 7, 6];               // baked pixels per tile in each bucket (big bodies get chunkier pixels, memory stays ~4 MB at worst)
  const NF = 4, NVAR = 2;                                   // boiling frames, layout variants
  const masses = [];                                        // [bucket][variant * NF + frame] -> canvas
  for (let i = 0; i < RB.length; i++) masses.push([]);
  let hazeCv = null, hazeLite = null, skullCv = null, bakeFrame = -1, bakeLeft = 0;
  const bubbles = [];                                       // by diameter
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  /** one frame of a cloud body: many puffs of mixed sizes on a golden-angle spiral, painted back (top) to front (bottom) and cel-shaded (light from the top-left); only the silhouette of the whole mass is outlined */
  function bakeMass(bi, variant, frame, level) {
    const rb = RB[bi], PX = PXS[bi], side = Math.ceil(2 * rb * PX * 1.1) + 6, c = side / 2, Rc = rb * PX * 0.9;
    const rnd = rng(9100 + bi * 131 + variant * 17), ph = (frame / NF) * TAU;
    const n = Math.max(8, Math.round(clamp(Math.round(8 + 3.6 * rb), 9, 34) * level)), list = [];
    list.push([c, c + Rc * 0.05, Rc * 0.5 * (0.7 + 0.3 * level)]);                            // the heart
    for (let i = 0; i < n; i++) {
      const ga = i * 2.399963 + variant * 1.7 + rnd() * 0.5, rho = Math.sqrt((i + 0.5) / n) * 0.72 * Rc, phi = rnd() * TAU, amp = Rc * 0.05, q = rnd();
      const sz = (q < 0.22 ? 0.26 + 0.07 * rnd() : q < 0.62 ? 0.15 + 0.06 * rnd() : 0.08 + 0.05 * rnd()) * (0.8 + 0.2 * level);          // a few big, many medium, some small
      list.push([c + Math.cos(ga) * rho + Math.cos(ph + phi) * amp, c + Math.sin(ga) * rho * 0.95 + Math.sin(ph + phi) * amp, Rc * sz * (1 + 0.05 * Math.sin(ph + phi * 2))]);
    }
    list.sort((p, q) => p[1] - q[1]);                                                         // upper puffs first, lower ones in front
    const b = new PB(side, side);
    for (let k = 0; k < list.length; k++) {
      const px = list[k][0], py = list[k][1], rr = list[k][2];
      const x0 = Math.max(1, Math.floor(px - rr - 1)), x1 = Math.min(side - 2, Math.ceil(px + rr + 1)), y0 = Math.max(1, Math.floor(py - rr - 1)), y1 = Math.min(side - 2, Math.ceil(py + rr + 1));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const dx = x - px, dy = y - py, d = Math.sqrt(dx * dx + dy * dy);
        if (d > rr) continue;
        const sl = -(dx * 0.55 + dy * 0.72) / rr;                                              // light from the top-left: > 0 lit, < 0 shadow
        const t = BAYER[(x & 3) + (y & 3) * 4] / 16 - 0.5;
        const v = sl + t * 0.28;
        b.set(x, y, v > 0.62 ? PAL.hi : v > 0.18 ? PAL.lt : v > -0.38 ? PAL.mid : PAL.sh);
      }
    }
    const src = b.d.slice();                                                                  // silhouette outline: empty pixels next to the mass
    for (let y = 1; y < side - 1; y++) for (let x = 1; x < side - 1; x++) {
      const i = y * side + x;
      if ((src[i] >>> 24) !== 0) continue;
      if ((src[i - 1] >>> 24) !== 0 || (src[i + 1] >>> 24) !== 0 || (src[i - side] >>> 24) !== 0 || (src[i + side] >>> 24) !== 0) b.d[i] = PAL.out;
    }
    return b.toCanvas();
  }
  function bucketOf(r0) {
    let bi = 0, best = 1e9;
    for (let i = 0; i < RB.length; i++) { const d = Math.abs(Math.log(r0 / RB[i])); if (d < best) { best = d; bi = i; } }
    return bi;
  }
  const LEVELS = [1.0, 0.6];                                 // density levels: full body, thin body (fewer, smaller puffs)
  function getMass(bi, variant, frame, level, now) {
    const arr = masses[bi], key = (level * NVAR + variant) * NF + frame;
    let cv = arr[key];
    if (cv) return cv;
    if (now !== bakeFrame) { bakeFrame = now; bakeLeft = 1; }
    if (bakeLeft > 0) { bakeLeft--; cv = arr[key] = bakeMass(bi, variant, frame, LEVELS[level]); return cv; }
    for (let d = 1; d < NF; d++) { const a = arr[(level * NVAR + variant) * NF + ((frame + d) % NF)]; if (a) return a; }      // budget used up: another frame of the same body
    return null;
  }
  function bakeHaze(sz, lite) {
    const b = new PB(sz, sz), c = (sz - 1) / 2, vio = hx('#36206e', lite ? 110 : 84), grn = hx('#86d444', lite ? 70 : 52), grn2 = hx('#b0e850', lite ? 90 : 66);
    const dash = hx('#2b1a58', 205), dash2 = hx('#9be04a', 170);
    for (let y = 0; y < sz; y++) for (let x = 0; x < sz; x++) {
      const dx = x - c, dy = y - c, d = Math.sqrt(dx * dx + dy * dy) / (sz * 0.5);
      if (d > 1) continue;
      if (d <= 0.9) {
        let col = d < 0.55 ? grn2 : grn;
        if (BAYER[(x & 3) + (y & 3) * 4] / 16 < LOOK.spore * (0.35 + d)) col = vio;      // spores: violet speckles, denser towards the rim
        b.set(x, y, col);
      } else if (d <= 0.985) {
        const ang = Math.atan2(dy, dx), dsh = Math.floor(ang * sz * 0.5 / 2.4) & 1;
        if (dsh === 0) b.set(x, y, dx + dy < 0 ? dash2 : dash);
        else if (d < 0.94) b.set(x, y, vio);
      }
    }
    return b.toCanvas();
  }
  function bakeBubble(dia) {
    const b = new PB(dia + 2, dia + 2), c = (dia + 1) / 2, r = dia / 2, out = hx('#1c4a2c', 240), fill = hx('#a9ec63', 170), rim = hx('#e2ffa8', 245), hi = hx('#ffffff', 255);
    for (let y = 0; y < dia + 2; y++) for (let x = 0; x < dia + 2; x++) {
      const dx = x - c, dy = y - c, d = Math.sqrt(dx * dx + dy * dy);
      if (d <= r + 0.15) b.set(x, y, d >= r - 0.9 ? (dx + dy < 0 ? rim : out) : fill);
    }
    if (dia >= 4) b.set(Math.round(c - r * 0.38), Math.round(c - r * 0.38), hi);
    return b.toCanvas();
  }
  const SKULL = [
    '..wwwww..',
    '.wwwwwww.',
    'wwwwwwwWW',
    'wkkwwwkkW',
    'wkkwwwkkW',
    'wwwwkwwWW',
    '.wwwwwwW.',
    '..wkwkW..',
    '..wwwwW..',
    '...w.w...',
    '..w...w..',
  ];
  function bakeSkull() {
    const b = new PB(9, 11), cw = hx('#eaffc8'), cW = hx('#a8d478'), ck = hx('#2a1450');
    for (let j = 0; j < SKULL.length; j++) for (let i = 0; i < 9; i++) {
      const ch = SKULL[j][i];
      if (ch === 'w') b.set(i, j, j >= 10 ? hx('#eaffc8', 90) : j >= 9 ? hx('#eaffc8', 160) : cw);
      else if (ch === 'W') b.set(i, j, cW);
      else if (ch === 'k') b.set(i, j, ck);
    }
    return b.toCanvas();
  }
  function getBubble(dia) { return bubbles[dia] || (bubbles[dia] = bakeBubble(dia)); }
  function getSkull() { return skullCv || (skullCv = bakeSkull()); }
  function getHaze(lite) { return lite ? (hazeLite || (hazeLite = bakeHaze(48, true))) : (hazeCv || (hazeCv = bakeHaze(112, false))); }

  // ------------------------------------------------------------------ icon: a skull flask
  GfxPlugins.icons.poison = (b, IP, H) => {
    // glass flask (12 wide), cork on top, toxic green liquid with a skull on the belly
    b.art([
      '....nnnn....',
      '....nNNn....',
      '....WssW....',
      '....WslW....',
      '..WWWlgWWW..',
      '.WlleeeeeeG.',
      '.Wlewwwweeg.',
      '.Wlwwwwwweg.',
      '.Wlwkwwkweg.',
      '.Wlwwkkwweg.',
      '.Wlewkwkeeg.',
      '.WleeEEEEEg.',
      '..WeEEEEEg..',
      '...gggggg...',
    ], IP, 1, 0);
    b.set(3, 6, IP.z); b.set(10, 7, IP.l); b.set(4, 12, IP.l);                    // bubbles in the liquid
  };

  // ------------------------------------------------------------------ fx
  GfxPlugins.fx.poison_burst = (ctx, fx, px, py, scale, u, p, now, H) => {
    const r = (fx.r > 0 ? fx.r : 2) * scale, e = 1 - (1 - p) * (1 - p), a = 1 - p, ps = Math.max(u, 1);
    ctx.globalAlpha = 0.5 * a * a; ctx.fillStyle = '#e6ff90';
    H.discRows(ctx, px, py, r * (0.25 + 0.55 * e), ps * 2);                                  // pale flash
    const rr = r * (0.55 + 0.75 * e);                                                        // shock ring that travels past the cloud's edge
    ctx.globalAlpha = 0.9 * a; ctx.fillStyle = '#352668';
    H.ringRows(ctx, px, py, rr, Math.max(u * 1.8, 2), ps);
    ctx.globalAlpha = 0.8 * a; ctx.fillStyle = '#b6e450';
    H.ringRows(ctx, px, py, Math.max(0, rr - u * 1.8), Math.max(u * 1.2, 1.5), ps);
    const n = Math.min(16, 7 + Math.round(fx.r || 2) * 2);
    for (let i = 0; i < n; i++) {                                                            // droplets flung outward
      const an = hf(i * 1.7 + 3) * TAU, d = r * (0.2 + 1.0 * e) * (0.55 + 0.45 * hf(i * 2.9)), up = Math.sin(p * Math.PI) * scale * 0.45;
      const s = 2.5 + (i % 3), bx = px + Math.cos(an) * d, by = py + Math.sin(an) * d * 0.85 - up;
      ctx.globalAlpha = Math.min(1, a * 1.6);
      ctx.fillStyle = '#1c4a2c'; H.R4(ctx, bx, by, u, -s / 2 - 0.7, -s / 2 - 0.7, s + 1.4, s + 1.4);
      ctx.fillStyle = i & 1 ? '#a9ec63' : '#d2f77c'; H.R4(ctx, bx, by, u, -s / 2, -s / 2, s, s);
      ctx.fillStyle = '#ffffff'; H.R4(ctx, bx, by, u, -s / 2 + 0.4, -s / 2 + 0.4, 1, 1);
    }
    ctx.globalAlpha = 1;
  };
  GfxPlugins.fx.poison_soul = (ctx, fx, px, py, scale, u, p) => {
    const w = Math.max(8, Math.round(9 * Math.max(u, 1) * 1.2)), h = Math.round(w * 11 / 9);
    const x = px + Math.sin(p * 7 + (fx.x || 0)) * u * 2, y = py - p * scale * 1.3 - scale * 0.2;
    ctx.globalAlpha = Math.sin(Math.min(1, p) * Math.PI) * 0.9;
    const sm = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = false;
    ctx.drawImage(getSkull(), Math.round(x - w / 2), Math.round(y - h / 2), w, h);
    ctx.imageSmoothingEnabled = sm; ctx.globalAlpha = 1;
  };

  // ------------------------------------------------------------------ the cloud
  let ubFrame = -1, ubN = 0;
  const ubList = new Array(40);

  function drawCloud(ctx, e, X, Y, scale, now, H, alpha) {
    const dens = e.dens, r = e.r;
    if (!(dens > 0.02) || !(r > 0.2) || !(scale > 0)) return;
    const R = r * scale, sd = ((e.id || 1) * 7919) % 997, wp = scale / 16;
    const a = clamp(0.3 + dens * 0.85, 0, 1), lite = scale < 9;
    const sm = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    // 1) the danger zone: stippled haze disc with a dashed rim (it matches the radius where the poison acts)
    ctx.globalAlpha = a * (lite ? 1 : LOOK.aHaze);
    ctx.drawImage(getHaze(lite), Math.round(X - R), Math.round(Y - R), Math.round(R * 2), Math.round(R * 2));
    // 2) the cloud body: one baked, shaded sprite (radius bucket of the initial size, scaled to the current radius; shrinks a little as it thins out)
    const bi = bucketOf(e.r0 > 0 ? e.r0 : r), fi = (((now / 260) | 0) + sd) & (NF - 1);
    const cv = getMass(bi, sd & (NVAR - 1), fi, dens < 0.55 ? 1 : 0, now);
    if (cv) {
      const kk = (r / RB[bi]) * (scale / PXS[bi]) * (0.8 + 0.2 * Math.min(1, dens / 0.8)), side = cv.width * kk;
      ctx.imageSmoothingEnabled = kk < 0.85;                                       // smooth only when the sprite is shrunk (no aliasing at far zoom)
      ctx.globalAlpha = LOOK.aMass * Math.min(1, 0.4 + dens * 0.8);
      ctx.drawImage(cv, Math.round(X - side / 2), Math.round(Y - side / 2), Math.round(side), Math.round(side));
      ctx.imageSmoothingEnabled = false;
    }
    // 3) bubbles and the occasional skull wisp (skipped when zoomed far out)
    if (scale >= 11) {
      const nb = clamp(Math.round(r * 1.8), 3, 12);
      for (let j = 0; j < nb; j++) {
        const per = 1500 + hf(sd + j * 3.1) * 1500, tt = now + hf(sd + j * 7.7) * per * 4, g = Math.floor(tt / per), t = tt / per - g;
        const an = hf(sd + j * 13 + g * 7.3) * TAU, d = Math.sqrt(hf(sd + j * 5.7 + g * 3.1)) * R * 0.8;
        const dia = 4 + ((j + g) % 3);
        const sz = Math.max(4, Math.round((dia + 2) * wp * 0.85));
        ctx.globalAlpha = Math.min(1, Math.sin(t * Math.PI) * 1.6) * a;
        const bx = X + Math.cos(an) * d + Math.sin(t * 6 + j) * wp * 1.4, by = Y + Math.sin(an) * d * 0.9 - t * scale * 0.9;
        ctx.drawImage(getBubble(dia), Math.round(bx - sz / 2), Math.round(by - sz / 2), sz, sz);
      }
      if (r >= 1.6 && dens > 0.25) {
        const per = 6000 + hf(sd) * 3000, tt = now + hf(sd + 9) * per, g = Math.floor(tt / per), ph = (tt / per - g) / 0.45;
        if (ph < 1) {
          const an = hf(sd + g * 2.3) * TAU, d = Math.sqrt(hf(sd + g * 4.1 + 1)) * R * 0.55, w = Math.round(Math.max(9 * wp * 1.25, 11)), h = Math.round(w * 11 / 9);
          ctx.globalAlpha = Math.sin(ph * Math.PI) * 0.9 * a;
          ctx.drawImage(getSkull(), Math.round(X + Math.cos(an) * d - w / 2 + Math.sin(ph * 5) * wp * 2), Math.round(Y + Math.sin(an) * d * 0.9 - ph * scale * 1.3 - h / 2), w, h);
        }
      }
    }
    ctx.imageSmoothingEnabled = sm;
    ctx.globalAlpha = 1;
    // 4) bubbles over poisoned units (once per frame, from whichever cloud is drawn first)
    if (now !== ubFrame) { ubFrame = now; drawUnitBubbles(ctx, e, X, Y, scale, now, alpha); }
  }

  function drawUnitBubbles(ctx, e, X, Y, scale, now, alpha) {
    if (scale < 10 || typeof S === 'undefined' || !S.units) return;
    const cw = ctx.canvas.width, ch = ctx.canvas.height, tick = S.tick;
    const left = e.x - X / scale - 1, right = e.x + (cw - X) / scale + 1, top = e.y - Y / scale - 2, bottom = e.y + (ch - Y) / scale + 1;
    let n = 0;
    for (const u of S.units.values()) {
      if (u.poison > tick && u.x > left && u.x < right && u.y > top && u.y < bottom) { ubList[n++] = u; if (n >= ubList.length) break; }
    }
    ubN = n;
    if (!n) return;
    const wp = scale / 16, sm = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < n; i++) {
      const u = ubList[i], ux = u.px + (u.x - u.px) * alpha, uy = u.py + (u.y - u.py) * alpha;
      const sx = X + (ux - e.x) * scale, sy = Y + (uy - e.y) * scale;
      for (let j = 0; j < 2; j++) {
        const t = (now / 1300 + u.id * 0.371 + j * 0.5) % 1, dia = j ? 3 : 4, sz = Math.max(4, Math.round((dia + 2) * wp * 0.9));
        ctx.globalAlpha = Math.min(1, Math.sin(t * Math.PI) * 1.5);
        ctx.drawImage(getBubble(dia), Math.round(sx + Math.sin(t * 8 + u.id + j * 2.4) * wp * 1.6 - sz / 2 + (j ? wp * 2.4 : -wp * 2.4)), Math.round(sy - scale * 0.55 - t * scale * 0.55 - sz / 2), sz, sz);
      }
    }
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = sm;
  }

  GfxPlugins.addEffect({ key: 'clouds', margin: 15, draw: drawCloud });
  GfxPlugins.addUnitTint('poison', 'rgba(150,70,210,0.5)');
  UIPlugins.unitBadges.push((u) => (u.poison > S.tick ? { t: 'Отравлен', cls: 'bad' } : null));
  const api = { drawCloud, buckets: RB, stats() { return { masses: masses.map(a => a.filter(Boolean).length), unitBubbles: ubN }; } };
  if (typeof window !== 'undefined') window.__poisonGfx = api;      // test / debug hook (tests/power_poison.*)
  return api;
})();
