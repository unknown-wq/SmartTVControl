/* =====================================================================
 * 30_gfx_dynamite.js — graphics plugin of the god power «Динамит» (CONTRACT section 10.3). Client side; NO DOM at load time (registrations only).
 *
 *  icon     'dynamite'        14x14 glyph for the dock (three red sticks, band, burning fuse)
 *  fx       'dyn_blast'       the explosion: fireball, white flash core, shock + dust ring, debris, smoke — BAKED frames (one drawImage per bang)
 *           'dyn_ore'         a stone / iron / gold icon pops out of a quarried vein
 *  effects  'dynamite'        S.eff.dynamite: the bundles (3 / 5 / 7 sticks by charge size) with a fuse that burns down + sparks and a blink before the bang, the cord between wired
 *                             charges (a spark runs along it while it is hot), the blast-radius ring (lethal core + damage radius) of charges about to go off and, for a moment, of a freshly laid
 *                             head / lone bundle
 *           'dynamite_scars'  S.eff.dynamite_scars: soot scars with debris that stay behind and fade (cosmetic)
 *  Bus      'dynamiteLaid'    toast «Динамит заложен» (the UI only toasts failures of Powers.apply, so the success message is shown from here)
 *
 *  Budget: everything is pre-rendered into small canvases (bundle sprites: 3 sizes x 4 fuse stages x 5 spark frames x 2 blink; rings per charge size; the cord is a baked rope stretched by ONE
 *  transform + drawImage, path strokes cost ~1.3 ms per frame for 80 cords; blast frames: 4 radius buckets x 2 variants x 12 frames and scars: 4 x 3, both trimmed to their content and baked
 *  lazily ONE per rendered frame with a background warm-up queue that starts when a charge of that size is first seen). A bundle costs 1-3 drawImage, a bang 1. Nothing allocates per frame.
 * ===================================================================== */

const GfxDynamite = (() => {
  const TAU = Math.PI * 2;

  // ------------------------------------------------------------------ tiny software pixel buffer (RGBA, source-over blending)
  const rgba = (r, g, b, a) => ((((a === undefined ? 255 : a) & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
  function hex(s) { return rgba(parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)); }
  const WHITE = rgba(255, 255, 255);
  function hf(n) { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); }
  function h2(x, y, s) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  class PB {
    constructor(w, h) { this.w = w; this.h = h; this.d = new Uint32Array(w * h); }
    set(x, y, c) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c; }
    get(x, y) { return (x >= 0 && y >= 0 && x < this.w && y < this.h) ? this.d[y * this.w + x] : 0; }
    rect(x, y, w, h, c) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c); }
    hline(x, y, w, c) { for (let i = 0; i < w; i++) this.set(x + i, y, c); }
    vline(x, y, h, c) { for (let j = 0; j < h; j++) this.set(x, y + j, c); }
    line(x0, y0, x1, y1, c) {
      x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let n = 0; n < 400; n++) {
        this.set(x0, y0, c);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
    disc(cx, cy, r, c) {
      const r2 = r * r + 0.3;
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) { const dx = x - cx, dy = y - cy; if (dx * dx + dy * dy <= r2) this.set(x, y, c); }
    }
    ell(cx, cy, rx, ry, c) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) { const dx = (x - cx) / (rx + 0.35), dy = (y - cy) / (ry + 0.35); if (dx * dx + dy * dy <= 1) this.set(x, y, c); }
    }
    art(rows, p, ox, oy) {
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j];
        for (let i = 0; i < row.length; i++) { const ch = row[i]; if (ch === '.' || ch === ' ') continue; const c = p[ch]; if (c !== undefined) this.set(ox + i, oy + j, c); }
      }
    }
    over(o, ox, oy) { for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) { const c = o.d[y * o.w + x]; if ((c >>> 24) > 0) this.set(ox + x, oy + y, c); } }
    /** straight-alpha source-over of colour (r,g,b) with opacity a (0..1) onto pixel (x,y) */
    px(x, y, r, g, b, a) {
      x = Math.round(x); y = Math.round(y);
      if (!(a > 0) || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      const i = y * this.w + x, o = this.d[i], da = (o >>> 24) / 255, ra = a + da * (1 - a);
      if (ra <= 0) return;
      const ws = a / ra, wd = da * (1 - a) / ra;
      this.d[i] = rgba((o & 255) * wd + r * ws + 0.5, ((o >>> 8) & 255) * wd + g * ws + 0.5, ((o >>> 16) & 255) * wd + b * ws + 0.5, ra * 255 + 0.5);
    }
    rectA(x, y, w, h, c, a) { const r = c[0], g = c[1], b = c[2]; for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.px(i, j, r, g, b, a); }
    /** 1px outline written into transparent pixels next to opaque ones */
    outline(col) {
      const w = this.w, h = this.h, d = this.d, s = d.slice();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if ((s[i] >>> 24) > 40) continue;
        if ((y + 1 < h && (s[i + w] >>> 24) > 200) || (x + 1 < w && (s[i + 1] >>> 24) > 200) || (x > 0 && (s[i - 1] >>> 24) > 200) || (y > 0 && (s[i - w] >>> 24) > 200)) d[i] = col;
      }
      return this;
    }
    /** crop to the bounding box of the non-transparent pixels (less to fill per drawImage, less memory); the anchor ax,ay moves with the pixels */
    trim() {
      const w = this.w, h = this.h, d = this.d;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((d[y * w + x] >>> 24) !== 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < 0) { const e = new PB(1, 1); e.ax = 0; e.ay = 0; return e; }
      const o = new PB(x1 - x0 + 1, y1 - y0 + 1);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) o.d[(y - y0) * o.w + (x - x0)] = d[y * w + x];
      o.ax = (this.ax | 0) - x0; o.ay = (this.ay | 0) - y0;
      return o;
    }
    toCanvas() {
      const c = document.createElement('canvas'); c.width = this.w; c.height = this.h;
      const g = c.getContext('2d'), id = g.createImageData(this.w, this.h);
      new Uint32Array(id.data.buffer).set(this.d);
      g.putImageData(id, 0, 0);
      return c;
    }
  }

  // ------------------------------------------------------------------ palette
  const K = rgba(28, 20, 32);                                           // outline
  const STICK = { hi: hex('#ff7a62'), lt: hex('#f0483e'), md: hex('#d22f34'), dk: hex('#9a2028'), ex: hex('#6a1620') };
  const HOT = { hi: hex('#fff2c8'), lt: hex('#ffd890'), md: hex('#ffb060'), dk: hex('#f07a38'), ex: hex('#c0501c') };
  const CAP = { hi: hex('#fff4da'), lt: hex('#efdfbd'), md: hex('#c8b48e'), dk: hex('#8a7656') };
  const BAND = { hi: hex('#f4d28c'), lt: hex('#d9b06a'), md: hex('#a67c3e'), dk: hex('#6e4a22') };
  const FUSE = { hi: hex('#b08a54'), md: hex('#7a5a34'), dk: hex('#4a321c') };
  const SHADOW = rgba(10, 8, 24, 70);
  const SP = { w: WHITE, y: hex('#ffe85a'), o: hex('#ff9a1e'), r: hex('#ff5a1a') };

  // ------------------------------------------------------------------ icon (14x14, drawn with the Buf API handed in by Sprites: set rect hline vline line disc ell art over)
  // letters = icon palette IP (r/R red, o orange, y yellow, w/W white, g grey, t/T tan, n/N brown): three upright red sticks with 1px gaps (the automatic dark outline
  // fills them), pale paper caps, a tan band with a knot, a fuse curling up out of the middle stick and a spark on its end
  function drawIcon(b, IP, H) {
    const sticks = [[1, 6], [5, 4], [9, 6]];                           // [left column, top row]; each stick is 3 wide
    for (const [x, top] of sticks) {
      const h = 14 - top;
      b.rect(x, top, 3, h, IP.r);
      b.vline(x, top + 2, h - 2, IP.o); b.vline(x + 2, top + 2, h - 2, IP.R);
      b.hline(x, top, 3, IP.W); b.hline(x, top + 1, 3, IP.g); b.set(x, top, IP.w); b.set(x + 2, top + 1, IP.G);
      b.hline(x, 13, 3, IP.R);
      b.set(x, top + 4, IP.w);
    }
    b.rect(0, 9, 13, 2, IP.t); b.hline(0, 9, 13, IP.y); b.hline(0, 10, 13, IP.T); b.set(6, 9, IP.N); b.set(7, 10, IP.N); b.set(0, 10, IP.N); b.set(12, 10, IP.N);
    // fuse and spark
    b.set(6, 3, IP.n); b.set(7, 2, IP.n); b.set(7, 1, IP.N); b.set(8, 1, IP.n);
    b.set(9, 0, IP.w); b.set(8, 0, IP.y); b.set(10, 0, IP.y); b.set(9, 1, IP.o); b.set(10, 2, IP.y); b.set(11, 1, IP.o); b.set(9, 2, IP.o);
  }

  // ------------------------------------------------------------------ bundle sprites
  // size 0: 3 sticks in a row, 1: 5 sticks (2 behind, 3 in front), 2: 7 sticks (3 behind, 4 in front) with a second band and a longer fuse.
  // Sticks are 3 px wide with a 1 px gap (the automatic outline fills it), the middle ones stand a pixel higher.
  const SIZES = [
    { front: 3, back: 0, h: 9, bands: 1 },
    { front: 3, back: 2, h: 9, bands: 1 },
    { front: 4, back: 3, h: 10, bands: 2 },
  ];
  const FUSE_LEN = [8, 5, 3, 1];                                     // fuse stage 0 (full) .. 3 (a stump)
  function stick(b, x, y, h, P, back) {
    // 3 px wide cylinder: light left edge, body, dark right edge; paper cap on top (two rows), dark bottom row
    b.rect(x, y + 2, 3, h - 2, P.md);
    b.vline(x, y + 2, h - 2, back ? P.lt : P.hi); b.vline(x + 1, y + 2, h - 2, back ? P.md : P.lt);
    b.vline(x + 2, y + 2, h - 2, P.dk); b.hline(x, y + h - 1, 3, P.ex);
    b.hline(x, y, 3, back ? CAP.md : CAP.hi); b.hline(x, y + 1, 3, back ? CAP.dk : CAP.md);
    b.set(x + 2, y, CAP.md); b.set(x + 2, y + 1, CAP.dk);
    if (!back && h > 7) b.set(x, y + 3, P.hi);
  }
  /** one bundle: size 0..2, fuse stage 0..3, spark -1 (none) / 0..3 animation frame, hot = blinking palette. Anchor (ax,ay) = bottom centre. */
  function buildBundle(size, stage, spark, hot) {
    const S = SIZES[size], P = hot ? HOT : STICK;
    const FL = FUSE_LEN[stage] + (size === 2 ? 2 : size === 1 ? 1 : 0);
    const frontW = S.front * 4 - 1;                                    // 3 wide + gap
    const OX = 4, W = frontW + OX * 2, backUp = S.back ? 3 : 0, H = FL + 7 + S.h + backUp + 4;
    const body = new PB(W, H), base = H - 4;                          // lowest stick row
    const top = base - S.h + 1;
    // shadow (translucent, kept out of the outline pass)
    const shade = new PB(W, H);
    for (let x = OX - 1; x <= OX + frontW; x++) shade.set(x, H - 3, SHADOW);
    for (let x = OX; x < OX + frontW - 1; x++) shade.set(x, H - 2, rgba(10, 8, 24, 40));
    // back row (higher, between the front sticks), then the front row
    for (let j = 0; j < S.back; j++) stick(body, OX + 2 + j * 4, top - backUp, S.h - 1, P, true);
    const mid = (S.front - 1) / 2;
    for (let i = 0; i < S.front; i++) { const up = (!S.back && Math.abs(i - mid) < 0.6) ? 1 : 0; stick(body, OX + i * 4, top - up, S.h + up, P, false); }
    // band(s) tying the front sticks (a pixel of overhang each side) and a knot
    const bandY = [top + Math.round(S.h * 0.55)];
    if (S.bands === 2) bandY.push(top + 2);
    for (const by of bandY) {
      body.rect(OX - 1, by, frontW + 2, 2, BAND.lt); body.hline(OX - 1, by, frontW + 2, BAND.hi); body.hline(OX - 1, by + 1, frontW + 2, BAND.md);
      body.set(OX - 1, by + 1, BAND.dk); body.set(OX + frontW, by + 1, BAND.dk);
    }
    body.set(OX + Math.floor(frontW / 2), bandY[0] + 1, BAND.dk);
    // fuse: from the cap of the highest middle stick, a lazy S-curve to the upper right
    const fx0 = S.back ? OX + 2 + Math.floor((S.back - 1) / 2) * 4 + (S.back % 2 ? 1 : 2) : OX + Math.floor(S.front / 2) * 4 + 1;
    const fy0 = (S.back ? top - backUp : top - 1) - 1;
    const path = [];
    const DX = [0, 0, 1, 1, 1, 2, 2, 2, 1, 1, 1, 2];
    for (let i = 0; i < FL; i++) path.push([fx0 + DX[i], fy0 - i]);
    for (let i = 0; i < path.length; i++) { const q = path[i]; body.set(q[0], q[1], i & 1 ? FUSE.md : FUSE.hi); body.set(q[0] + 1, q[1], FUSE.dk); }
    // outline of the opaque body, then the translucent shadow underneath, then the spark (which gets no outline)
    const ol = new PB(W, H); ol.over(body, 0, 0); ol.outline(K);
    const out = new PB(W, H);
    out.over(shade, 0, 0); out.over(ol, 0, 0);
    if (spark >= 0 && path.length) {
      const tip = path[path.length - 1], sx = tip[0] + 1, sy = tip[1] - 1, f = spark & 3, core = hot ? SP.w : SP.y;
      if (f === 0) { out.set(sx, sy, SP.w); out.set(sx - 1, sy, SP.y); out.set(sx + 1, sy, SP.y); out.set(sx, sy - 1, SP.y); out.set(sx, sy + 1, SP.o); }
      else if (f === 1) { out.set(sx, sy, SP.w); out.set(sx - 1, sy - 1, SP.o); out.set(sx + 1, sy - 1, SP.y); out.set(sx - 1, sy + 1, SP.y); out.set(sx + 1, sy + 1, SP.o); out.set(sx, sy - 2, SP.r); }
      else if (f === 2) { out.set(sx, sy, core); out.set(sx - 2, sy, SP.o); out.set(sx + 2, sy, SP.o); out.set(sx, sy - 2, SP.y); out.set(sx - 1, sy, SP.y); out.set(sx + 1, sy, SP.y); out.set(sx + 1, sy - 2, SP.r); }
      else { out.set(sx, sy, SP.w); out.set(sx + 1, sy, SP.y); out.set(sx, sy + 1, SP.y); out.set(sx - 1, sy - 1, SP.o); out.set(sx + 2, sy - 1, SP.r); out.set(sx - 2, sy + 1, SP.o); }
    }
    out.ax = (OX + (frontW >> 1)) + 1; out.ay = H - 1;
    return out;
  }

  // ------------------------------------------------------------------ danger ring: lethal core (dotted) + damage radius (dashed), baked per charge size
  function buildRing(r, phase) {
    const Rb = 1.6 + 0.4 * r, Rp = Rb * 16, half = Math.ceil(Rp) + 4, size = half * 2 + 1;
    const b = new PB(size, size);
    const dash = (rad, on, off, th, col, ph, a) => {
      const circ = TAU * rad, n = Math.ceil(circ * 2);
      for (let i = 0; i < n; i++) {
        const t = i / n, s = (t * circ + ph) % (on + off);
        if (s >= on) continue;
        const an = t * TAU;
        for (let k = 0; k < th; k++) b.px(half + Math.cos(an) * (rad - k), half + Math.sin(an) * (rad - k), col[0], col[1], col[2], a);
      }
    };
    // faint fill inside the damage radius
    for (let y = -half; y <= half; y++) for (let x = -half; x <= half; x++) { const d = Math.sqrt(x * x + y * y); if (d <= Rp) b.px(half + x, half + y, 255, 70, 40, 0.055 + 0.07 * (d / Rp)); }
    dash(Rp, 5, 4, 2, [255, 96, 64], phase * 3, 0.95);
    dash(Rp * 0.42, 2, 3, 1, [255, 214, 90], -phase * 2, 0.85);
    b.ax = half; b.ay = half;
    return b;
  }

  // ------------------------------------------------------------------ scars: sooty crater mark with a dirt lip, rays and rubble, baked per blast-size bucket
  const SCAR_R = [2.2, 3.0, 3.8, 4.6];                                  // bucket radii in tiles (the sprite is scaled to the real blast radius)
  function bucketOf(Rb) { return Rb < 2.6 ? 0 : Rb < 3.4 ? 1 : Rb < 4.2 ? 2 : 3; }
  /** smooth value noise 0..1 on a lattice of `cell` pixels */
  function vnoise(x, y, cell, seed) {
    const gx = x / cell, gy = y / cell, x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = h2(x0, y0, seed), b = h2(x0 + 1, y0, seed), c = h2(x0, y0 + 1, seed), d = h2(x0 + 1, y0 + 1, seed);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  function buildScar(bk, variant) {
    const Rp = SCAR_R[bk] * 16, half = Math.ceil(Rp * 1.15) + 3, size = half * 2 + 1, b = new PB(size, size), seed = 40 + bk * 17 + variant * 101;
    const ph1 = hf(seed) * TAU, ph2 = hf(seed + 1) * TAU, ph3 = hf(seed + 2) * TAU;
    for (let y = -half; y <= half; y++) for (let x = -half; x <= half; x++) {
      const d = Math.sqrt(x * x + y * y * 1.1), an = Math.atan2(y, x);
      const wob = 1 + 0.12 * Math.sin(an * 3 + ph1) + 0.08 * Math.sin(an * 5 + ph2) + 0.05 * Math.sin(an * 9 + ph3);
      const n = vnoise(x, y, 7, seed) * 0.6 + vnoise(x, y, 3.5, seed + 9) * 0.4;
      const e = d / (Rp * 0.9 * wob) + (n - 0.5) * 0.5;
      if (e >= 1) continue;
      let r, g, bl, a;
      if (e < 0.3) { r = 18; g = 12; bl = 10; a = 0.74; }
      else if (e < 0.58) { r = 36; g = 26; bl = 20; a = 0.62; }
      else if (e < 0.82) { r = 62; g = 48; bl = 36; a = 0.46; }
      else { if (e > 0.93 && ((x + y) & 1)) continue; r = 86; g = 68; bl = 50; a = 0.28; }
      if (e > 0.3 && e < 0.4 && vnoise(x, y, 4, seed + 4) > 0.52) { r = 122; g = 94; bl = 62; a = 0.62; }          // broken lip of thrown-up dirt
      b.px(half + x, half + y, r, g, bl, a);
    }
    // soot rays running out of the centre (thin, a few reach beyond the edge)
    const rays = 7 + bk;
    for (let k = 0; k < rays; k++) {
      const an = hf(seed + 7 + k * 1.3) * TAU, len = Rp * (0.82 + 0.4 * hf(seed + 31 + k));
      for (let t = Rp * 0.45; t < len; t += 1) {
        const a = 0.4 * (1 - (t - Rp * 0.45) / (len - Rp * 0.45 + 0.01));
        b.px(half + Math.cos(an) * t, half + Math.sin(an) * t * 1.04, 20, 14, 11, a);
      }
    }
    // rubble: dark chunks, stones, splinters and a few last embers around the rim
    const chunks = 12 + bk * 5;
    for (let k = 0; k < chunks; k++) {
      const an = hf(seed + 90 + k * 2.7) * TAU, d = Rp * (0.3 + 0.7 * Math.sqrt(hf(seed + 120 + k))), x = Math.round(half + Math.cos(an) * d), y = Math.round(half + Math.sin(an) * d * 0.92);
      const kind = hf(seed + 150 + k);
      if (kind < 0.35) { b.px(x, y, 22, 16, 14, 0.95); b.px(x + 1, y, 22, 16, 14, 0.95); b.px(x, y - 1, 118, 98, 78, 0.8); }
      else if (kind < 0.65) { b.px(x, y, 128, 134, 148, 1); b.px(x + 1, y, 92, 98, 112, 1); b.px(x, y - 1, 196, 202, 214, 1); b.px(x + 1, y + 1, 70, 74, 88, 0.9); }
      else if (kind < 0.9) { b.px(x, y, 150, 96, 50, 1); b.px(x + 1, y + 1, 96, 58, 30, 1); b.px(x + 2, y + 1, 150, 96, 50, 1); }
      else { b.px(x, y, 255, 140, 40, 0.9); b.px(x, y + 1, 150, 50, 20, 0.7); }
    }
    b.ax = half; b.ay = half;
    return b;
  }

  // ------------------------------------------------------------------ the bang: 12 baked frames per (radius bucket, variant)
  const NF = 12;
  const DIRT = [[92, 66, 42], [150, 112, 70], [116, 86, 54]], STONE = [[130, 136, 150], [190, 196, 208], [98, 104, 120]], WOOD = [[150, 96, 50], [200, 140, 76], [104, 64, 32]], COAL = [[40, 30, 28], [82, 66, 56], [24, 18, 18]];
  const CHUNKS = [DIRT, STONE, DIRT, WOOD, COAL, STONE, DIRT, COAL];
  function ease(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return 1 - (1 - t) * (1 - t); }
  function smooth(a, b, t) { t = (t - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
  /** ragged disc: radius modulated by angular noise so it reads as a fireball, not as a circle */
  function blob(b, cx, cy, rad, rgb, a, seed, rough, sq) {
    if (rad < 0.6 || !(a > 0)) return;
    const R0 = Math.ceil(rad * (1 + rough)) + 1, p1 = hf(seed) * TAU, p2 = hf(seed + 3) * TAU, sy = sq || 1;
    for (let y = -R0; y <= R0; y++) for (let x = -R0; x <= R0; x++) {
      const d = Math.sqrt(x * x + (y / sy) * (y / sy));
      if (d > R0) continue;
      const an = Math.atan2(y / sy, x), edge = rad * (1 + rough * (0.5 * Math.sin(an * 3 + p1) + 0.35 * Math.sin(an * 7 + p2) + 0.15 * Math.sin(an * 13 + p1 * 2)));
      if (d <= edge) b.px(cx + x, cy + y, rgb[0], rgb[1], rgb[2], a);
    }
  }
  function puff(b, x, y, s, a, cols) {        // chunky smoke / dust square in three tones, lit from the top left
    b.rectA(Math.round(x - s / 2), Math.round(y - s / 2), Math.round(s), Math.round(s), cols[0], a);
    b.rectA(Math.round(x - s / 2), Math.round(y - s / 2), Math.max(1, Math.round(s * 0.66)), Math.max(1, Math.round(s * 0.66)), cols[1], a);
    b.rectA(Math.round(x - s / 2), Math.round(y - s / 2), Math.max(1, Math.round(s * 0.33)), Math.max(1, Math.round(s * 0.33)), cols[2], a);
  }
  const SMOKE = [[62, 58, 62], [104, 98, 100], [160, 154, 154]], DUST = [[130, 104, 70], [172, 142, 98], [212, 188, 140]];
  function chunk(b, x, y, sz, kind, a, ember) {          // one piece of debris: lit top left, dark bottom right
    x = Math.round(x); y = Math.round(y);
    b.rectA(x, y, sz, sz, ember ? [255, 150, 40] : kind[0], a);
    b.rectA(x, y, sz - 1, 1, ember ? [255, 236, 150] : kind[1], a); b.rectA(x, y + 1, 1, sz - 2, ember ? [255, 236, 150] : kind[1], a);
    b.rectA(x + sz - 1, y + 1, 1, sz - 1, ember ? [200, 60, 20] : kind[2], a); b.rectA(x + 1, y + sz - 1, sz - 1, 1, ember ? [200, 60, 20] : kind[2], a);
  }
  function buildBlast(bk, variant, f) {
    const Rp = SCAR_R[bk] * 16, half = Math.ceil(Rp * 1.4 + 10), size = half * 2 + 1, b = new PB(size, size), cx = half, cy = half;
    const p = (f + 0.5) / NF, seed = 11 + bk * 31 + variant * 977;
    const e = ease(p / 0.5), eSlow = ease(p / 0.8);
    // 1) ground scorch under the fireball (the scar sprite takes over afterwards)
    if (p < 0.5) blob(b, cx, cy, Rp * (0.26 + 0.44 * e), [26, 14, 10], 0.26 * (1 - p * 1.6), seed + 1, 0.22, 0.9);
    // 2) dust ring: many small puffs on an expanding ring, brown and tan, thinning out
    {
      const n = 30 + bk * 6, rr = Rp * (0.34 + 0.72 * eSlow), a = 0.95 * (1 - smooth(0.45, 1, p));
      for (let i = 0; i < n; i++) {
        const an = (i / n) * TAU + hf(seed + i) * 0.4, jr = rr * (0.88 + 0.22 * hf(seed + i * 3.7)), sz = 2 + Math.round(2.2 * smooth(0, 0.8, p) * (0.5 + hf(seed + i * 5.3)));
        const tone = hf(seed + i * 7.1), col = tone < 0.4 ? DUST[0] : tone < 0.8 ? DUST[1] : DUST[2];
        b.rectA(Math.round(cx + Math.cos(an) * jr), Math.round(cy + Math.sin(an) * jr * 0.8 - p * Rp * 0.08), sz, sz, col, a);
      }
    }
    // 3) shock ring: thin and bright, early
    if (p < 0.5) {
      const rr = Rp * (0.2 + 1.0 * ease(p / 0.5)), th = Math.max(1, 3.4 * (1 - p / 0.5)), a = 0.95 * (1 - p / 0.5);
      for (let k = 0; k < 360; k += 2) {
        const an = k / 360 * TAU;
        for (let q = 0; q < th; q++) b.px(cx + Math.cos(an) * (rr - q), cy + Math.sin(an) * (rr - q) * 0.86, 255, 244, 216, a);
      }
    }
    // 4) fireball: red rim, orange body, yellow heart, white core (centres a little off so it looks lit from the top left)
    if (p < 0.78) {
      const grow = 0.3 + 0.36 * ease(p / 0.42), fade = 1 - smooth(0.34, 0.78, p), rise = p * Rp * 0.14, a = fade;
      const rad = Rp * grow;
      blob(b, cx, cy - rise, rad, [255, 90, 20], a, seed + 2, 0.3, 0.92);
      blob(b, cx - rad * 0.04, cy - rise - rad * 0.06, rad * 0.8, [255, 154, 38], a, seed + 3, 0.26, 0.92);
      if (p < 0.62) blob(b, cx - rad * 0.08, cy - rise - rad * 0.1, rad * 0.56, [255, 216, 74], a, seed + 4, 0.22, 0.92);
      if (p < 0.45) blob(b, cx - rad * 0.1, cy - rise - rad * 0.12, rad * 0.3 * (1 - p), [255, 246, 200], a, seed + 5, 0.16, 0.92);
    }
    // 5) the white flash (first frames): a hot disc and a four-point star
    if (p < 0.2) {
      const k = 1 - p / 0.2, r0 = Rp * (0.12 + 0.26 * k);
      blob(b, cx, cy, r0, [255, 255, 255], 0.95 * k + 0.05, seed + 6, 0.12, 0.92);
      const len = Rp * (0.4 + 0.5 * k);
      for (let t = 0; t < len; t++) {
        const a = k * (1 - t / len), w = Math.max(0, 2 - t / (len * 0.4));
        for (let q = -w; q <= w; q++) {
          b.px(cx + t, cy + q, 255, 250, 230, a); b.px(cx - t, cy + q, 255, 250, 230, a); b.px(cx + q, cy + t * 0.8, 255, 250, 230, a); b.px(cx + q, cy - t * 0.8, 255, 250, 230, a);
        }
      }
    }
    // 6) hot sparks: bright 1-2 px dots with a short trail, early
    if (p < 0.5) {
      const n = 14 + bk * 3;
      for (let i = 0; i < n; i++) {
        const an = hf(seed + 200 + i * 1.9) * TAU, sp = Rp * (0.9 + 0.7 * hf(seed + 230 + i * 2.3)), t = Math.min(1, p * 1.9);
        const d = sp * ease(t), x = cx + Math.cos(an) * d, y = cy + Math.sin(an) * d * 0.7 + t * t * Rp * 0.25 - Math.sin(Math.min(1, t) * Math.PI) * Rp * 0.2, a = 1 - t;
        for (let q = 0; q < 3; q++) b.px(x - Math.cos(an) * q * 1.2, y - Math.sin(an) * q * 0.9, 255, q === 0 ? 240 : 170, q === 0 ? 150 : 60, a * (1 - q * 0.3));
      }
    }
    // 7) debris: chunks thrown out on arcs, 3x3 (4x4 for the big charges), fading at the end
    {
      const n = 12 + bk * 3;
      for (let i = 0; i < n; i++) {
        const an = hf(seed + 20 + i * 1.7) * TAU, sp = Rp * (0.6 + 0.75 * hf(seed + 40 + i * 3.1)), hgt = Rp * (0.35 + 0.6 * hf(seed + 60 + i * 5.3));
        const t = Math.min(1, p * 1.12 - hf(seed + 80 + i) * 0.05);
        if (t <= 0) continue;
        const d = sp * ease(t), x = cx + Math.cos(an) * d, y = cy + Math.sin(an) * d * 0.55 - hgt * 4 * t * (1 - t) + t * t * Rp * 0.12;
        const a = t < 0.8 ? 1 : (1 - t) / 0.2, kind = CHUNKS[i % CHUNKS.length], sz = (bk >= 2 && i % 4 === 0) ? 4 : (i % 3 === 2 ? 2 : 3);
        chunk(b, x, y, sz, kind, a, p < 0.3 && i % 4 === 0);
      }
    }
    // 8) smoke: a cloud of soft puffs fanning up and out once the fireball has died down
    if (p > 0.3) {
      const t = smooth(0.3, 1, p), n = 4 + bk;
      for (let i = 0; i < n; i++) {
        const th = -Math.PI / 2 + ((i + 0.5) / n - 0.5) * 2.4 + (hf(seed + 100 + i) - 0.5) * 0.4, rr = Rp * (0.12 + 0.42 * Math.pow(t, 0.7)) * (0.8 + 0.4 * hf(seed + 120 + i));
        const bx = cx + Math.cos(th) * rr * 1.1, by = cy - Rp * 0.08 - t * Rp * 0.22 + Math.sin(th) * rr * 0.9;
        const rad = 4 + t * (4 + Rp * 0.1) + hf(seed + 140 + i) * 3, a = 0.62 * Math.sin(Math.min(1, t) * Math.PI) * (0.7 + 0.3 * hf(seed + 150 + i));
        blob(b, bx, by, rad, SMOKE[0], a, seed + 160 + i, 0.3, 0.9);
        blob(b, bx - rad * 0.18, by - rad * 0.2, rad * 0.66, SMOKE[1], a, seed + 170 + i, 0.3, 0.9);
        blob(b, bx - rad * 0.3, by - rad * 0.36, rad * 0.34, SMOKE[2], a, seed + 180 + i, 0.25, 0.9);
      }
    }
    b.ax = half; b.ay = half;
    return b;
  }

  // ------------------------------------------------------------------ canvas caches (lazy, DOM only at draw time)
  // Building a blast frame costs ~2-5 ms, a scar ~4 ms: at most ONE of them is baked per rendered frame (shared token); a sprite that is not there yet is skipped
  // (blast frames fall back to the nearest earlier frame) and a warm-up queue bakes the sizes in use in the background, one per frame, long before the first bang.
  const bundleCv = [], ringCv = [], scarCv = [], blastCv = [];
  let bakeStamp = -1, bakeTaken = false;
  function token(now) { if (now !== bakeStamp) { bakeStamp = now; bakeTaken = false; } if (bakeTaken) return false; bakeTaken = true; return true; }
  const sprKey = (size, stage, spark, hot) => (((size * 4 + stage) * 5 + (spark + 1)) * 2 + hot);
  function bundle(size, stage, spark, hot) {
    const k = sprKey(size, stage, spark, hot);
    let c = bundleCv[k];
    if (c === undefined) { const pb = buildBundle(size, stage, spark, hot); c = pb.toCanvas(); c.ax = pb.ax; c.ay = pb.ay; bundleCv[k] = c; }
    return c;
  }
  function ring(r, ph) {
    const k = (r - 1) * 2 + ph;
    let c = ringCv[k];
    if (c === undefined) { const pb = buildRing(r, ph); c = pb.toCanvas(); c.ax = pb.ax; c.ay = pb.ay; ringCv[k] = c; }
    return c;
  }
  function bakeScar(bk, v) { const k = bk * 3 + v; if (scarCv[k] === undefined) { const pb = buildScar(bk, v).trim(); const c = pb.toCanvas(); c.ax = pb.ax; c.ay = pb.ay; scarCv[k] = c; } return scarCv[k]; }
  function bakeBlast(bk, v, f) { const k = (bk * 2 + v) * NF + f; if (blastCv[k] === undefined) { const pb = buildBlast(bk, v, f).trim(); const c = pb.toCanvas(); c.ax = pb.ax; c.ay = pb.ay; blastCv[k] = c; } return blastCv[k]; }
  function scar(bk, v, now) {
    const c = scarCv[bk * 3 + v];
    if (c !== undefined) return c;
    return token(now) ? bakeScar(bk, v) : null;
  }
  /** a baked blast frame; without a free bake token the nearest earlier frame stands in (never blocks, never flickers off) */
  function blastFrame(bk, v, f, now) {
    const c = blastCv[(bk * 2 + v) * NF + f];
    if (c !== undefined) return c;
    if (token(now)) return bakeBlast(bk, v, f);
    for (let q = f - 1; q >= 0; q--) if (blastCv[(bk * 2 + v) * NF + q] !== undefined) return blastCv[(bk * 2 + v) * NF + q];
    return null;
  }
  const warmFlag = [], warmQ = [];
  let warmI = 0;
  /** queue every sprite of a blast-size bucket (first scar variant first: it is needed the very frame the first bang happens) */
  function warm(bk) {
    if (warmFlag[bk]) return;
    warmFlag[bk] = true;
    warmQ.push([0, bk, 0, 0]);
    for (let f = 0; f < NF; f++) warmQ.push([1, bk, 0, f]);
    warmQ.push([0, bk, 1, 0], [0, bk, 2, 0]);
    for (let f = 0; f < NF; f++) warmQ.push([1, bk, 1, f]);
  }
  function pump(now) {
    if (warmI >= warmQ.length || !token(now)) return;
    const q = warmQ[warmI++];
    if (q[0] === 0) bakeScar(q[1], q[2]); else bakeBlast(q[1], q[2], q[3]);
  }

  // ------------------------------------------------------------------ drawing helpers
  const stats = { bundles: 0, scars: 0, blasts: 0, ores: 0, rings: 0, icon: 0, wires: 0 };
  let cordCv = null;
  /** the cord between two wired charges: a baked 3-row rope texture, stretched and rotated by ONE transform + drawImage (path strokes cost ~1.3 ms per frame for 80 cords in a 1500-unit scene, this ~0.2) */
  function cordSprite() {
    if (cordCv === null) {
      const b = new PB(32, 3), d = rgba(58, 38, 22), m = rgba(120, 86, 52), l = rgba(160, 120, 74);
      for (let x = 0; x < 32; x++) { b.set(x, 0, d); b.set(x, 1, ((x >> 1) & 1) ? m : l); b.set(x, 2, d); }
      cordCv = b.toCanvas();
    }
    return cordCv;
  }
  /** draws the cord from (x0,y0) to (x1,y1) but leaves `trim` device px free at both ends (the bundles stand there) */
  function drawCord(ctx, x0, y0, x1, y1, u, trim) {
    const dx = x1 - x0, dy = y1 - y0, full = Math.sqrt(dx * dx + dy * dy), len = full - 2 * trim;
    if (!(full >= 1) || len < 2) return;
    const c = dx / full, s = dy / full, w = Math.max(2, u * 2.6);
    ctx.setTransform(c, s, -s, c, x0 + c * trim, y0 + s * trim);
    ctx.drawImage(cordSprite(), 0, -w / 2, len, w);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  function snapK(u) { return u >= 3 ? Math.round(u) : u; }
  /** blit a baked sprite with its anchor (ax,ay) at device px (X,Y), scaled k (nearest neighbour when magnified) */
  function blit(ctx, cv, X, Y, k, extra) {
    const w = cv.width * k, h = cv.height * k;
    ctx.drawImage(cv, Math.round(X - cv.ax * k), Math.round(Y - cv.ay * k), Math.round(w), Math.round(h));
  }
  const sizeOf = (r) => (r <= 2 ? 0 : r <= 5 ? 1 : 2);

  // ------------------------------------------------------------------ effect: live charges
  function drawCharge(ctx, e, px, py, scale, now, H, alpha) {
    stats.bundles++;
    const u = scale / 16, k = snapK(u * 1.2);
    const tk = S.tick + (alpha > 0 ? alpha : 0), rem = e.boom - tk;
    const rr = e.r | 0 || 2;
    warm(bucketOf(1.6 + 0.4 * rr)); pump(now);
    if (scale < 7) {                                       // far away: a red dot with a spark
      const s = Math.max(2, Math.round(scale * 0.22));
      ctx.fillStyle = '#1c1420'; ctx.fillRect(Math.round(px - s / 2) - 1, Math.round(py - s) - 1, s + 2, s + 2);
      ctx.fillStyle = rem <= 14 && ((now / 90) & 1) ? '#ffd890' : '#e03a38'; ctx.fillRect(Math.round(px - s / 2), Math.round(py - s), s, s);
      return;
    }
    const lit = rem <= 36;
    let stage = 0;
    if (lit) stage = rem >= 24 ? 0 : rem >= 14 ? 1 : rem >= 6 ? 2 : 3;
    const hot = rem <= 14 && (((now / (rem > 7 ? 150 : 70)) | 0) & 1) === 1 ? 1 : 0;
    const sprk = lit ? (((now / 65) | 0) + (e.id | 0)) & 3 : -1;
    const sm = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = k < 1;
    // the danger ring (damage radius dashed, lethal core dotted): armed charges in their last second, and for a moment the head of a line / a lone bundle just laid
    // (the brush preview of the UI is the brush radius, the real blast is 1.6 + 0.4 r)
    if (rem <= 12) {
      const rc = ring(rr, ((now / 160) | 0) & 1);
      const pulse = 0.55 + 0.45 * Math.sin(now / (rem > 6 ? 120 : 60));
      ctx.globalAlpha = Math.min(1, pulse * (rem < 2 ? 0.5 + rem / 4 : 1));
      blit(ctx, rc, px, py, u);
      ctx.globalAlpha = 1;
      stats.rings++;
    } else if (!(e.pv > 0) && tk - e.t0 < 14 && scale >= 9) {
      const rc = ring(rr, 0);
      ctx.globalAlpha = 0.5 * (1 - (tk - e.t0) / 14);
      blit(ctx, rc, px, py, u);
      ctx.globalAlpha = 1;
      stats.rings++;
    }
    // cord to the charge this one is wired to (it burns away when the predecessor has gone off); it only shows between the bundles, a spark glint runs along it while it is hot
    if (e.pv > 0 && scale >= 9) {
      const X1 = px + (e.wx - e.x) * scale, Y1 = py + (e.wy - e.y) * scale, by = scale * 0.30;
      const dxw = X1 - px, dyw = Y1 - py, lw = Math.sqrt(dxw * dxw + dyw * dyw);
      if (lw >= 1 && lw <= scale * 3) {                                  // (charges of a stroke are 1.3 tiles apart; anything longer is a damaged save)
        const sm2 = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = true;      // smooth edges for the rotated rope
        drawCord(ctx, px, py + by, X1, Y1 + by, u, scale * 0.34);
        ctx.imageSmoothingEnabled = sm2;
        if (lit) {                                           // the fire running along the cord
          const t = 0.2 + 0.6 * (((now / 420) + hf(e.id) * 3) % 1), sx = px + dxw * t, sy = py + by + dyw * t;
          const gs = Math.max(2, Math.round(u * 1.6));
          ctx.fillStyle = '#ffe85a'; ctx.fillRect(Math.round(sx - gs / 2), Math.round(sy - gs / 2), gs, gs);
          ctx.fillStyle = '#ffffff'; ctx.fillRect(Math.round(sx - gs / 4), Math.round(sy - gs / 4), Math.max(1, Math.round(gs / 2)), Math.max(1, Math.round(gs / 2)));
        }
        stats.wires++;
      }
    }
    blit(ctx, bundle(sizeOf(e.r | 0), stage, sprk, hot), px, py + scale * 0.38, k);
    ctx.imageSmoothingEnabled = sm;
  }

  // ------------------------------------------------------------------ effect: scars
  function drawScar(ctx, e, px, py, scale, now, H, alpha) {
    stats.scars++;
    if (scale < 4) return;
    const life = typeof PowerDynamite !== 'undefined' && PowerDynamite.SCAR_LIFE > 0 ? PowerDynamite.SCAR_LIFE : 1800;
    const age = (S.tick - e.t0) / life;
    if (!(age >= 0) || age >= 1) return;
    const a = (age < 0.5 ? 1 : 1 - (age - 0.5) / 0.5) * Math.min(1, (S.tick - e.t0) / 5 + 0.15);
    const Rb = e.r > 0 ? e.r : 2.4, bk = bucketOf(Rb), v = ((e.x * 7 + e.y * 13) | 0) % 3;
    const cv = scar(bk, v < 0 ? v + 3 : v, now), k = (scale / 16) * (Rb / SCAR_R[bk]) * 0.8;
    if (cv === null) return;
    const sm = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = k < 1.5;
    ctx.globalAlpha = a * 0.9;
    ctx.drawImage(cv, Math.round(px - cv.ax * k), Math.round(py - cv.ay * k), Math.round(cv.width * k), Math.round(cv.height * k));
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = sm;
  }

  // ------------------------------------------------------------------ fx
  function fxBlast(ctx, fx, px, py, scale, u, p, now, H) {
    stats.blasts++;
    if (scale < 3) return;
    const Rb = fx.r > 0 ? fx.r : 2.4, bk = bucketOf(Rb), v = (fx.v | 0) & 1;
    let f = (p * NF) | 0; if (f >= NF) f = NF - 1;
    const cv = blastFrame(bk, v, f, now);
    if (!cv) return;
    const k = (scale / 16) * (Rb / SCAR_R[bk]);
    const sm = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = k < 1.5;
    ctx.drawImage(cv, Math.round(px - cv.ax * k), Math.round(py - cv.ay * k), Math.round(cv.width * k), Math.round(cv.height * k));
    ctx.imageSmoothingEnabled = sm;
  }
  function fxOre(ctx, fx, px, py, scale, u, p, now, H) {
    stats.ores++;
    if (typeof Sprites === 'undefined' || scale < 8) return;
    const ic = Sprites.icon(fx.kind || 'stone', 16);
    const rise = scale * (0.3 + 0.9 * (1 - (1 - p) * (1 - p))), a = p < 0.12 ? p / 0.12 : p > 0.65 ? (1 - p) / 0.35 : 1, s = scale * 0.62;
    const sm = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = a < 0 ? 0 : a;
    ctx.drawImage(ic, Math.round(px - s / 2), Math.round(py - rise - s / 2), Math.round(s), Math.round(s));
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = sm;
  }

  // ------------------------------------------------------------------ registrations (no DOM here)
  GfxPlugins.icons.dynamite = (b, IP, H) => { stats.icon++; drawIcon(b, IP, H); };
  GfxPlugins.fx.dyn_blast = fxBlast;
  GfxPlugins.fx.dyn_ore = fxOre;
  GfxPlugins.addEffect({ key: 'dynamite_scars', margin: 8, draw: drawScar });
  GfxPlugins.addEffect({ key: 'dynamite', margin: 7, draw: drawCharge });
  Bus.on('dynamiteLaid', (laid, first) => {
    try { if (first && typeof UI !== 'undefined' && UI && typeof UI.toast === 'function') UI.toast('Динамит заложен'); } catch (e) { /* cosmetic only */ }
  });

  return {
    stats, PB, NF, SCAR_R,
    // pure pixel builders (no DOM): used by the node sheet tool and the tests
    build: { bundle: buildBundle, ring: buildRing, scar: buildScar, blast: buildBlast, icon: drawIcon },
  };
})();
