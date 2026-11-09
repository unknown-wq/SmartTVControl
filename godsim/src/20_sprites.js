/* =====================================================================
 * 20_sprites.js — Sprites: 100% procedural pixel art (no external assets)
 * OWNER: Sprites module.  Client module (needs DOM canvas), never call from sim code.
 *
 * Public API (see docs/CONTRACT.md section 4):
 *   Sprites.init()                                   idempotent, < 250 ms (rest is lazy)
 *   Sprites.drawTile(ctx,t,x,y,size,variant)         variant = look | (frame << 3)
 *                                                      look  = variant & 7   (8 looks per terrain type)
 *                                                      frame = (variant >> 3) & 1  (only DEEP / SHALLOW / LAVA animate)
 *   Sprites.tileAtlas()                              {canvas, cols:16, rows:9, tilePx:16, looks:8}
 *                                                      tile (t,variant&15) at sx=(variant&15)*16, sy=t*16
 *   Sprites.feature(kind,variant)                    TREE v0 sapling,1 young,2 oak,3 pine | ROCK/IRON/GOLD v0..3
 *                                                    BERRY v0..3 (with berries), v9 = depleted
 *   Sprites.unit(race,stage,frame,tint,weapon,armor[,look,pose,carry])
 *                                                    look 0..7 (e.g. (u.id&3)|(u.sex===1?4:0)): skin/hair variant, bit 2 = female
 *                                                    pose 0 walk,1 attack,2 chop,3 mine,4 farm,5 build,6 sleep,7 fish,8 forage ; carry 0 none,1 wood,2 stone,3 food,4 iron,5 gold
 *   Sprites.building(type,race,level,done[,tint,mode,variant])    tint = kingdom hex for banners / flags / awnings; mode = damage state / construction stage; variant = colour look
 *   Sprites.landmark(type,race,level,tint,mode)      16x24 canvas for town halls / temples (L2+) and castles (L3), else null
 *   Sprites.decal(kind,v) / chimney(type,race,level) / drawArrow / drawSmoke / drawBird / drawFishJump   art helpers drawn by Render
 *   Sprites.flag(flag,w,h) / Sprites.icon(key,size)
 *   Sprites.drawFx(ctx,fx,px,py,scale,now) / Sprites.drawEffect(ctx,kind,e,px,py,scale,now)
 * ===================================================================== */

const Sprites = (() => {
  const TS = 16;
  const LOOKS = 8;
  const ATLAS_COLS = 16;

  /* ---------------------------------------------------------------
   * colour helpers — packed ABGR uint32 == RGBA byte order of ImageData (little endian)
   * --------------------------------------------------------------- */
  const rgba = (r, g, b, a) => ((((a === undefined ? 255 : a) & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
  const cr = c => c & 255, cg = c => (c >>> 8) & 255, cb = c => (c >>> 16) & 255, ca = c => c >>> 24;
  function hex(s) {
    if (typeof s === 'number') return s;
    if (typeof s !== 'string' || s.charCodeAt(0) !== 35) return rgba(128, 128, 128);
    let r, g, b;
    if (s.length === 4) { r = parseInt(s[1] + s[1], 16); g = parseInt(s[2] + s[2], 16); b = parseInt(s[3] + s[3], 16); }
    else { r = parseInt(s.slice(1, 3), 16); g = parseInt(s.slice(3, 5), 16); b = parseInt(s.slice(5, 7), 16); }
    if (r !== r || g !== g || b !== b) return rgba(128, 128, 128);
    return rgba(r, g, b);
  }
  function mix(a, b, t) {
    return rgba(cr(a) + (cr(b) - cr(a)) * t, cg(a) + (cg(b) - cg(a)) * t, cb(a) + (cb(b) - cb(a)) * t, ca(a) + (ca(b) - ca(a)) * t);
  }
  const WHITE = rgba(255, 255, 255), BLACK = rgba(0, 0, 0);
  const dk = (c, f) => rgba(cr(c) * f, cg(c) * f, cb(c) * f, ca(c));       // f < 1 darker
  const lt = (c, t) => mix(c, WHITE, t);                                     // t 0..1 toward white
  function pal(o) { const p = {}; for (const k in o) p[k] = hex(o[k]); return p; }

  // seeded random (visuals only; never touches the sim RNG R)
  function rng(seed) {
    let s = seed | 0;
    return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function h2(x, y, s) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /* ---------------------------------------------------------------
   * pixel buffer
   * --------------------------------------------------------------- */
  class Buf {
    constructor(w, h, yo) { this.w = w; this.h = h; this.yo = yo | 0; this.d = new Uint32Array(w * h); }
    set(x, y, c) { y += this.yo; if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.d[y * this.w + x] = c; }
    get(x, y) { y += this.yo; return (x >= 0 && y >= 0 && x < this.w && y < this.h) ? this.d[y * this.w + x] : 0; }
    rect(x, y, w, h, c) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c); }
    hline(x, y, w, c) { for (let i = 0; i < w; i++) this.set(x + i, y, c); }
    vline(x, y, h, c) { for (let j = 0; j < h; j++) this.set(x, y + j, c); }
    line(x0, y0, x1, y1, c) {
      x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let n = 0; n < 200; n++) {
        this.set(x0, y0, c);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
    disc(cx, cy, r, c) {
      const r2 = r * r + 0.3;
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x - cx, dy = y - cy; if (dx * dx + dy * dy <= r2) this.set(x, y, c);
      }
    }
    ell(cx, cy, rx, ry, c) {
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / (rx + 0.35), dy = (y - cy) / (ry + 0.35); if (dx * dx + dy * dy <= 1) this.set(x, y, c);
      }
    }
    /** stamp ASCII rows; '.' and ' ' are transparent; p maps char -> colour */
    art(rows, p, ox, oy, flip) {
      for (let j = 0; j < rows.length; j++) {
        const row = rows[j], n = row.length;
        for (let i = 0; i < n; i++) {
          const ch = row[flip ? n - 1 - i : i];
          if (ch === '.' || ch === ' ') continue;
          const c = p[ch]; if (c !== undefined) this.set(ox + i, oy + j, c);
        }
      }
    }
    over(o, ox, oy) {
      for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) { const c = o.d[y * o.w + x]; if ((c >>> 24) > 0) this.set(ox + x, oy + y, c); }
    }
    /** 1px outline around opaque pixels, written into transparent pixels only. col = fixed colour or null (auto: dark tint of neighbour) */
    outline(col) {
      const w = this.w, h = this.h, d = this.d, s = d.slice();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if ((s[i] >>> 24) > 40) continue;
        let n = 0;
        if (y + 1 < h && (s[i + w] >>> 24) > 200) n = s[i + w];
        else if (x + 1 < w && (s[i + 1] >>> 24) > 200) n = s[i + 1];
        else if (x > 0 && (s[i - 1] >>> 24) > 200) n = s[i - 1];
        else if (y > 0 && (s[i - w] >>> 24) > 200) n = s[i - w];
        if (n) d[i] = col === null || col === undefined ? rgba(cr(n) * 0.26 + 10, cg(n) * 0.24 + 8, cb(n) * 0.3 + 18) : col;
      }
      return this;
    }
    bbox() {
      let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) if ((this.d[y * this.w + x] >>> 24) > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
    mirror() { const o = new Buf(this.w, this.h); for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) o.d[y * this.w + x] = this.d[y * this.w + (this.w - 1 - x)]; return o; }
    toCanvas() {
      const c = mkCanvas(this.w, this.h), x = c.getContext('2d');
      const id = x.createImageData(this.w, this.h);
      new Uint32Array(id.data.buffer).set(this.d);
      x.putImageData(id, 0, 0);
      return c;
    }
  }

  function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  /** nearest-neighbour upscale of a canvas to size x size (square) */
  function scaleNN(src, w, h) {
    if (src.width === w && src.height === h) return src;
    const c = mkCanvas(w, h), x = c.getContext('2d');
    x.imageSmoothingEnabled = false;
    x.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
    return c;
  }

  // soft ground shadow written only into transparent pixels
  function groundShadow(b, cx, y, rx, a) {
    const c = rgba(10, 8, 24, a === undefined ? 70 : a);
    for (let x = cx - rx; x <= cx + rx; x++) if ((b.get(x, y) >>> 24) < 40) b.set(x, y, c);
  }

  /* ===============================================================
   * TERRAIN TILES
   * =============================================================== */
  const TILE_NAMES = ['deep', 'shallow', 'sand', 'grass', 'forest', 'hill', 'mountain', 'snow', 'lava'];
  let atlas = null;      // {canvas, cols, rows, tilePx, looks}
  let atlasBuf = null;

  // every writer wraps coordinates, so each tile is periodic (seamless with itself and any neighbour that shares the base tone)
  function mkTileWriter(b, ox, oy) { return (x, y, c) => { b.d[(oy + (y & 15)) * b.w + ox + (x & 15)] = c; }; }
  function mkTileReader(b, ox, oy) { return (x, y) => b.d[(oy + (y & 15)) * b.w + ox + (x & 15)]; }

  const TC = {
    deep: pal({ a: '#17407f', b: '#133674', c: '#1c4b8e', w1: '#2a63a8', w2: '#3b7ac2' }),
    shallow: pal({ a: '#3588ca', b: '#2f7cbd', c: '#4a9ddc', w1: '#7fc6ee', w2: '#c4ecfa', e: '#2670b0' }),
    sand: pal({ a: '#dccd8c', b: '#cfbf7c', c: '#e8dba0', d: '#bba868', e: '#f3ebc2', f: '#a8956a' }),
    grass: pal({ a: '#58a03e', b: '#4c9236', c: '#65ae46', d: '#3c7c2e', e: '#82c85a', f: '#f4f4ec', g: '#f2d84a', h: '#e46a8a', i: '#d8503c', j: '#8a6a44' }),
    forest: pal({ floor: '#1a4a26', floor2: '#143e20', m: '#2b7a38', l: '#43a04c', ll: '#68c060', d: '#1c5e2c', dd: '#124a22', trunk: '#4a3018', m2: '#2d7a44', l2: '#4aa860' }),
    hill: pal({ a: '#85794a', b: '#786c41', c: '#908352', m: '#9d8f5b', l: '#b0a068', ll: '#c4b57a', d: '#6c6039', dd: '#554b2c', g: '#7f8c4a', g2: '#97a458' }),
    mountain: pal({ a: '#6c6874', b: '#625e6c', c: '#777382', l: '#a09cb0', ll: '#c8c4d6', m: '#85818f', d: '#575364', dd: '#3e3a4a', s: '#ebeff5' }),
    snow: pal({ a: '#eaf1fa', b: '#dfe9f6', c: '#f6f9fe', s: '#c5d6ec', s2: '#a9c0e0', w: '#ffffff', tint: '#d9e8fa' }),
    lava: pal({ a: '#c93d12', b: '#b8340f', c: '#d94c14', crust: '#6e1c10', crust2: '#8a2612', glow: '#ff9d2a', hot: '#ffd23f', white: '#fff3b0', r: '#ff6a1a' }),
  };

  function tDeep(p, v, f) {
    const C = TC.deep, r = rng(1000 + v);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const n = h2(x, y, 11 + v); p(x, y, n < 0.15 ? C.b : n > 0.9 ? C.c : C.a); }
    const sh = f ? 2 : 0;
    for (let k = 0; k < 4; k++) {
      const x = (r() * 16) | 0, y = (k * 4 + ((r() * 3) | 0)) & 15, len = 2 + ((r() * 2) | 0);
      for (let i = 0; i < len; i++) p(x + sh + i, y, i === 0 || i === len - 1 ? C.w1 : C.w2);
      p(x + sh - 1 + len, y + 1, C.w1);
    }
    if (f) for (let k = 0; k < 3; k++) { p(((r() * 16) | 0), ((r() * 16) | 0), C.w1); }
    else for (let k = 0; k < 3; k++) { r(); r(); }
  }
  function tShallow(p, v, f) {
    const C = TC.shallow, r = rng(2000 + v);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const n = h2(x, y, 21 + v); p(x, y, n < 0.18 ? C.b : n > 0.82 ? C.c : C.a); }
    const sh = f ? 1 : 0;
    for (let k = 0; k < 3; k++) {            // ripples: little arcs
      const x = (r() * 14) | 0, y = ((k * 5 + (r() * 3)) | 0) & 15;
      p(x + sh, y, C.w1); p(x + 1 + sh, y, C.w1); p(x + 2 + sh, y, C.w1);
      p(x + sh - 1, y + 1, C.w1); p(x + 3 + sh, y + 1, C.w1);
    }
    for (let k = 0; k < 2; k++) { const x = (r() * 16) | 0, y = (r() * 16) | 0; p(x + (f ? 1 : 0), y + (f ? 0 : 1), C.w2); }
    if (v & 1) { const x = (r() * 14) | 0, y = (r() * 16) | 0; p(x, y, C.e); p(x + 1, y, C.e); p(x + 2, y, C.e); }
    if (v === 6) {                             // lily pads with a little blossom
      const pad = [['#3f9a48', '#58c060', '#2a7a3a'], ['#4aa850', '#6ad070', '#2f8040']];
      for (let k = 0; k < 2; k++) {
        const cx = 3 + k * 7 + ((r() * 3) | 0), cy = 4 + k * 6 + ((r() * 3) | 0), P = pad[k].map(hex);
        p(cx, cy, P[1]); p(cx + 1, cy, P[0]); p(cx + 2, cy, P[0]); p(cx - 1, cy + 1, P[0]); p(cx, cy + 1, P[0]); p(cx + 1, cy + 1, P[2]); p(cx + 2, cy + 1, P[2]); p(cx, cy + 2, P[2]); p(cx + 1, cy + 2, P[2]);
        if (k === 0) { p(cx + 1, cy, hex('#ffb8d8')); p(cx + 1, cy - 1, hex('#ffffff')); }
      }
    } else if (v === 7) {                      // reed cluster with brown cattails
      const x0 = 9 + ((r() * 4) | 0), y0 = 6 + ((r() * 4) | 0), g1 = hex('#4aa850'), g2 = hex('#2f7a3c'), br = hex('#7a4a28');
      for (let i = 0; i < 4; i++) { const x = x0 + i * 2 - (i & 1), h = 4 + ((i * 5 + v) % 3); for (let j = 0; j < h; j++) p(x, y0 + 5 - j, j & 1 ? g1 : g2); if (i === 1 || i === 3) { p(x, y0 + 5 - h, br); p(x, y0 + 4 - h, br); } }
      p(x0 - 1, y0 + 6, C.w2); p(x0 + 2, y0 + 6, C.w2); p(x0 + 6, y0 + 6, C.w2);
    }
  }
  function tSand(p, v) {
    const C = TC.sand, r = rng(3000 + v);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const n = h2(x, y, 31 + v); p(x, y, n < 0.1 ? C.d : n < 0.26 ? C.b : n > 0.93 ? C.e : n > 0.78 ? C.c : C.a); }
    for (let k = 0; k < 2 + (v & 1); k++) {    // little ripples in the sand
      const x = (r() * 12) | 0, y = (r() * 16) | 0; p(x, y, C.d); p(x + 1, y, C.d); p(x + 2, y + 1, C.d);
    }
    if (v >= 5) {                              // pebble / shell
      const x = 2 + ((r() * 11) | 0), y = 2 + ((r() * 11) | 0);
      p(x, y, C.f); p(x + 1, y, C.f); p(x, y - 1, C.e); p(x + 1, y + 1, C.d);
    }
  }
  function tGrass(p, v) {
    const C = TC.grass, r = rng(4000 + v);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const n = h2(x, y, 41 + v); p(x, y, n < 0.17 ? C.b : n > 0.86 ? C.c : C.a); }
    const tufts = v === 3 ? 6 : 3 + (v & 1);
    for (let k = 0; k < tufts; k++) {          // grass tufts: little v-shapes, dark blades with light tip
      const x = 1 + ((r() * 13) | 0), y = 2 + ((r() * 12) | 0);
      p(x, y, C.d); p(x + 2, y, C.d); p(x + 1, y + 1, C.d); p(x + 1, y - 1, C.e); p(x, y - 1, C.c);
    }
    if (v >= 5) {                              // a few flowers
      const kinds = [C.f, C.g, C.h, C.i];
      const n = v === 5 ? 2 : 1 + (v & 1);
      for (let k = 0; k < n; k++) {
        const x = 2 + ((r() * 12) | 0), y = 2 + ((r() * 12) | 0), col = kinds[(v + k) & 3];
        p(x, y, col); p(x + 1, y + 1, C.d);
      }
    }
    if (v === 4) { const x = 3 + ((r() * 9) | 0), y = 3 + ((r() * 9) | 0); p(x, y, C.j); p(x + 1, y, C.j); p(x, y + 1, C.d); }
    if (v === 2) { const x = 2 + ((r() * 10) | 0), y = 3 + ((r() * 9) | 0), pb = [hex('#bcc0c8'), hex('#8a909c'), hex('#5e6470')]; p(x, y, pb[0]); p(x + 1, y, pb[1]); p(x, y + 1, pb[1]); p(x + 1, y + 1, pb[2]); p(x + 3, y + 2, pb[0]); p(x + 4, y + 2, pb[2]); }
    if (v === 1) { for (let k = 0; k < 2; k++) { const x = 2 + ((r() * 11) | 0), y = 3 + ((r() * 10) | 0), cl = hex('#8fd864'); p(x, y, cl); p(x + 1, y, C.e); p(x, y + 1, C.e); p(x - 1, y + 1, cl); p(x + 1, y + 1, C.d); } }
  }

  function oak(p, cx, cy, rr, C, light) {
    for (let dy = -rr - 1; dy <= rr + 1; dy++) for (let dx = -rr - 1; dx <= rr + 1; dx++) {
      const d2 = dx * dx + dy * dy; if (d2 > rr * rr + rr * 0.6) continue;
      const q = (dx + dy), n = h2(cx + dx, cy + dy, 7);
      let c = C.m;
      if (q < -rr * 0.55) c = light ? C.l2 : C.l; else if (q > rr * 0.5) c = C.d;
      if (d2 > (rr - 1) * (rr - 1) + 1 && q > 0) c = C.dd;
      else if (n > 0.86 && q < 0) c = C.ll;
      else if (n < 0.1 && q > -rr * 0.5) c = C.d;
      p(cx + dx, cy + dy, c);
    }
  }
  function pine(p, cx, top, layers, C) {
    for (let i = 0; i < layers; i++) {
      const y0 = top + i * 3, hw = i + 1 + (i > 0 ? 1 : 0);
      for (let j = 0; j < 4; j++) {
        const w = Math.min(hw, Math.floor(j * (hw + 1) / 3) + (j === 0 ? 0 : 0));
        for (let x = -w; x <= w; x++) {
          const edge = Math.abs(x) === w, c = x < 0 ? (edge ? C.m2 : C.l2) : x === 0 ? C.m2 : (edge ? C.dd : C.d);
          p(cx + x, y0 + j, j === 3 ? C.dd : (x < 0 && j < 2 ? C.l2 : c));
        }
      }
    }
    p(cx, top + layers * 3 + 1, C.trunk);
  }
  function tForest(p, v) {
    const C = TC.forest, r = rng(5000 + v);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p(x, y, h2(x, y, 51 + v) < 0.3 ? C.floor2 : C.floor);
    // jittered 2x2 grid of trees + one in the middle; v&1 swaps oak/pine bias
    const spots = [[3, 3], [11, 4], [7, 9], [2, 12], [12, 13], [8, 0]];
    const trees = [];
    for (let i = 0; i < spots.length; i++) trees.push({ x: spots[i][0] + ((r() * 3) | 0) - 1, y: spots[i][1] + ((r() * 3) | 0) - 1, pine: ((i + v) % 3 === 0) !== ((v & 4) !== 0) });
    trees.sort((a, b) => a.y - b.y);
    for (const t of trees) {
      if (t.pine) pine(p, t.x, t.y - 3, 2, C);
      else { oak(p, t.x, t.y, 4, C, (t.x + v) & 1); p(t.x, t.y + 5, C.trunk); }
    }
  }
  // height-field relief: toroidal peaks -> per-pixel slope shading from the top-left (seamless, consistent light)
  function tw16(d) { d = ((d % 16) + 16) % 16; return d > 8 ? d - 16 : d; }
  function relief(p, peaks, C, tones, k, shadow) {
    const H = new Float32Array(256);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      let h = 0;
      for (const q of peaks) {
        const dx = Math.abs(tw16(x - q.cx)), dy = Math.abs(tw16(y - q.cy));
        let hh;
        if (q.dome) { const e = (dx * dx) / (q.rx * q.rx) + (dy * dy) / (q.ry * q.ry); hh = e < 1 ? q.h * (1 - e) : 0; }
        else { const d = Math.max(dx, dy, (dx + dy) * 0.74) / q.rx; hh = q.h * (1 - d) + (h2(x, y, q.s) - 0.5) * q.j; }
        if (hh > h) h = hh;
      }
      H[y * 16 + x] = h;
    }
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const h = H[y * 16 + x];
      if (h <= 0.4) {
        if (shadow && (H[((y - 1) & 15) * 16 + ((x - 1) & 15)] > shadow || H[((y - 1) & 15) * 16 + ((x - 2) & 15)] > shadow + 1)) p(x, y, C.d);
        continue;
      }
      const gx = H[y * 16 + ((x + 1) & 15)] - H[y * 16 + ((x - 1) & 15)], gy = H[((y + 1) & 15) * 16 + x] - H[((y - 1) & 15) * 16 + x];
      const b = 0.5 + k * (gx + gy) + h * 0.012 + (h2(x, y, 5) - 0.5) * 0.1;
      p(x, y, b < tones[0] ? C.dd : b < tones[1] ? C.d : b < tones[2] ? C.m : b < tones[3] ? C.l : C.ll);
    }
  }
  function tHill(p, v) {
    const C = TC.hill, r = rng(6000 + v);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const n = h2(x, y, 61 + v); p(x, y, n < 0.2 ? C.b : n > 0.9 ? C.c : C.a); }
    const pk = [
      { dome: 1, cx: 3 + ((r() * 6) | 0), cy: 4 + ((r() * 4) | 0), rx: 5.2 + r() * 1.6, ry: 4.2 + r() * 1.2, h: 5 },
      { dome: 1, cx: 10 + ((r() * 5) | 0), cy: 10 + ((r() * 4) | 0), rx: 5 + r() * 1.5, ry: 4 + r() * 1.2, h: 4.5 },
    ];
    if (v & 1) pk.push({ dome: 1, cx: 12 + ((r() * 4) | 0), cy: 2 + ((r() * 3) | 0), rx: 4, ry: 3.2, h: 3 });
    relief(p, pk, C, [0.22, 0.38, 0.56, 0.7], 0.12, 2.4);
    for (let k = 0; k < 4; k++) { const x = (r() * 16) | 0, y = (r() * 16) | 0; p(x, y, k < 2 ? C.g : C.g2); }
  }
  function tMountain(p, v) {
    const C = TC.mountain, r = rng(7000 + v);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const n = h2(x, y, 71 + v); p(x, y, n < 0.22 ? C.b : n > 0.88 ? C.c : C.a); }
    const pk = [
      { cx: 3 + ((r() * 5) | 0), cy: 4 + ((r() * 4) | 0), rx: 6 + r() * 1.2, h: 9, s: v, j: 0.9 },
      { cx: 10 + ((r() * 5) | 0), cy: 10 + ((r() * 4) | 0), rx: 6.5 + r() * 1.2, h: 10, s: v + 9, j: 0.9 },
    ];
    if (v & 2) pk.push({ cx: 12 + ((r() * 4) | 0), cy: 2 + ((r() * 3) | 0), rx: 5, h: 7, s: v + 3, j: 1.2 });
    relief(p, pk, C, [0.2, 0.4, 0.58, 0.76], 0.085, 3);
  }
  function tSnow(p, v) {
    const C = TC.snow, r = rng(8000 + v);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const n = h2(x, y, 81 + v); p(x, y, n < 0.14 ? C.b : n > 0.8 ? C.c : C.a); }
    for (let k = 0; k < 2 + (v & 1); k++) {           // drifts with blue shadow on the lower right
      const cx = (r() * 16) | 0, cy = (r() * 16) | 0, rx = 3 + ((r() * 3) | 0);
      for (let x = -rx; x <= rx; x++) { const yy = Math.round(Math.sqrt(Math.max(0, 1 - (x * x) / (rx * rx))) * 1.6); p(cx + x, cy + yy, x > -rx / 2 ? C.s : C.s2); if (x > 0) p(cx + x, cy + yy + 1, C.s); }
      p(cx - 1, cy - 1, C.c); p(cx - 2, cy, C.w);
    }
    for (let k = 0; k < 3; k++) p((r() * 16) | 0, (r() * 16) | 0, C.w);
    if (v >= 4) { const x = (r() * 14) | 0, y = (r() * 14) | 0; p(x, y, C.s2); p(x + 1, y, C.s); }
  }
  function tLava(p, v, f) {
    const C = TC.lava, r = rng(9000 + v);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const n = h2(x, y, 91 + v); p(x, y, n < 0.2 ? C.b : n > 0.8 ? C.c : C.a); }
    for (let k = 0; k < 3; k++) {       // dark crust plates
      const cx = (r() * 16) | 0, cy = (r() * 16) | 0, rr = 1.5 + r() * 1.8;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= rr * rr) p(cx + dx, cy + dy, (dx + dy) < 0 ? C.crust2 : C.crust);
    }
    // glowing cracks (random walks); frame decides which pixels are white-hot
    for (let k = 0; k < 3; k++) {
      let x = (r() * 16) | 0, y = (r() * 16) | 0;
      const n = 5 + ((r() * 5) | 0);
      for (let i = 0; i < n; i++) {
        const hot = ((i + k + (f ? 1 : 0)) % 3) === 0;
        p(x, y, hot ? C.hot : C.glow);
        const m = r();
        if (m < 0.4) x++; else if (m < 0.7) y++; else if (m < 0.85) x--; else y--;
        if (i % 2 === 1) p(x, y - 1, C.r);
      }
    }
    for (let k = 0; k < 3; k++) { const x = (r() * 16) | 0, y = (r() * 16) | 0; p(x + (f ? 1 : 0), y, ((k + (f ? 1 : 0)) & 1) ? C.white : C.hot); }
  }
  const TILE_FN = [tDeep, tShallow, tSand, tGrass, tForest, tHill, tMountain, tSnow, tLava];

  function buildAtlas() {
    atlasBuf = new Buf(ATLAS_COLS * TS, 9 * TS);
    for (let t = 0; t < 9; t++) for (let v = 0; v < LOOKS; v++) for (let f = 0; f < 2; f++) {
      const p = mkTileWriter(atlasBuf, (v + f * 8) * TS, t * TS);
      TILE_FN[t](p, v, f);
    }
    atlas = { canvas: atlasBuf.toCanvas(), cols: ATLAS_COLS, rows: 9, tilePx: TS, looks: LOOKS };
  }
  function tileAtlas() { if (!atlas) buildAtlas(); return atlas; }
  function drawTile(ctx, t, x, y, size, variant) {
    if (!atlas) buildAtlas();
    if (t < 0 || t > 8) t = 0;
    ctx.drawImage(atlas.canvas, ((variant | 0) & 15) * TS, t * TS, TS, TS, x, y, size, size);
  }

  /* ===============================================================
   * FEATURES (lone tree, rock, iron, gold, berries) — transparent 16x16 sprites over any terrain
   * =============================================================== */
  const featCache = new Map();
  const FP = {
    tree: pal({ m: '#3c9c44', l: '#5ec054', ll: '#8ee070', d: '#2a7a38', dd: '#1c5a2a', trunk: '#6e4626', trunk2: '#4a2e18', l2: '#5ec054', m2: '#3c9c44' }),
    rock: pal({ hi: '#d4d8e0', lt: '#aeb4c0', md: '#8c93a2', dk: '#666d7e', ex: '#464c5c' }),
    iron: pal({ hi: '#c4cad8', lt: '#98a0b4', md: '#78809a', dk: '#58607a', ex: '#3e4560' }),
    gold: pal({ hi: '#d8d2c4', lt: '#b0a898', md: '#8e8678', dk: '#6c6458', ex: '#4a443c' }),
  };
  const ORE = {
    iron: pal({ a: '#e0803a', b: '#b05a26', c: '#7c3a1a', d: '#f6b070' }),
    gold: pal({ a: '#ffd83a', b: '#e8a818', c: '#b07410', d: '#fff6b0' }),
  };
  function shadedBlob(b, cx, cy, rx, ry, K, seed) {
    for (let y = Math.floor(cy - ry) - 1; y <= Math.ceil(cy + ry) + 1; y++) for (let x = Math.floor(cx - rx) - 1; x <= Math.ceil(cx + rx) + 1; x++) {
      const nx = (x - cx) / (rx + 0.45), ny = (y - cy) / (ry + 0.45), e = nx * nx + ny * ny;
      if (e > 1) continue;
      const li = -(nx * 0.6 + ny * 0.8) + (h2(x, y, seed) - 0.5) * 0.35;
      let c = K.md;
      if (li > 0.62) c = K.hi; else if (li > 0.2) c = K.lt; else if (li < -0.55) c = K.ex; else if (li < -0.15) c = K.dk;
      b.set(x, y, c);
    }
  }
  function ores(b, K, seed, n) {
    const r = rng(seed), pts = [];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if ((b.get(x, y) >>> 24) > 200) pts.push(x, y);
    const m = pts.length / 2;
    for (let i = 0; i < n && m > 0; i++) {
      const k = ((r() * m) | 0) * 2, x = pts[k], y = pts[k + 1];
      if (!((b.get(x + 1, y) >>> 24) > 200 && (b.get(x, y + 1) >>> 24) > 200)) { i--; if (i < -30) break; continue; }
      b.set(x, y, K.a); b.set(x + 1, y, K.a); b.set(x, y + 1, K.b); b.set(x + 1, y + 1, K.c);
      if (K.d) b.set(x, y, K.d);
    }
  }
  function drawTreeFeature(b, v) {
    const C = FP.tree, p = (x, y, c) => b.set(x, y, c);
    if (v === 0) {                      // sapling
      b.vline(7, 11, 3, C.trunk); b.set(8, 11, C.trunk2);
      b.disc(7, 9, 1.6, C.m); b.set(6, 8, C.l); b.set(7, 8, C.ll); b.set(8, 10, C.d); b.set(5, 10, C.l); b.set(9, 9, C.d);
    } else if (v === 1) {               // young tree
      b.rect(7, 10, 2, 4, C.trunk); b.vline(8, 10, 4, C.trunk2);
      oak(p, 7, 7, 3, C, 0);
    } else if (v === 2) {               // mature oak
      b.rect(7, 10, 2, 4, C.trunk); b.vline(8, 11, 3, C.trunk2); b.set(6, 13, C.trunk); b.set(9, 13, C.trunk2);
      oak(p, 4, 8, 3, C, 0); oak(p, 11, 8, 3, C, 0); oak(p, 7, 5, 4, C, 0); oak(p, 8, 8, 3, C, 0);
    } else {                            // pine
      b.vline(7, 11, 3, C.trunk); b.vline(8, 11, 3, C.trunk2);
      for (let i = 0; i < 4; i++) {
        const y0 = 1 + i * 3, hw = 1 + i;
        for (let j = 0; j < 4; j++) {
          const w = Math.min(hw, Math.round(j * hw / 3 + (i ? 0.6 : 0)));
          for (let x = -w; x <= w; x++) {
            const edge = Math.abs(x) === w;
            let c = x < 0 ? (edge ? C.m : C.l) : x === 0 ? C.m : (edge ? C.dd : C.d);
            if (j === 3) c = x < 0 ? C.d : C.dd;
            if (i === 0 && j === 0) c = C.ll;
            b.set(7 + x + (x >= 0 ? 0 : 0), y0 + j, c);
          }
        }
      }
    }
  }
  // ---- extra tree species: 4 birch, 5 palm (coast), 6 dead tree, 7 snow-laden pine, 8 autumn oak ----
  const TPAL = {
    birch: pal({ m: '#78c04c', l: '#a4e068', ll: '#d4f890', d: '#4a9a3c', dd: '#2c7030' }),
    autumn: pal({ m: '#e08a2a', l: '#f4b43a', ll: '#ffd860', d: '#b85a1c', dd: '#8a3c14' }),
    snowpine: pal({ m: '#3f7a62', l: '#5a9a7c', ll: '#ffffff', d: '#2c5a4c', dd: '#1e3e38', sn: '#eef6ff', sh: '#b4cce4' }),
    dead: pal({ a: '#7a6a58', b: '#9a8a74', c: '#52463a', d: '#34291f' }),
    palm: pal({ t1: '#9a7a46', t2: '#6e5230', t3: '#4a361c', f1: '#58c050', f2: '#3a9a3c', f3: '#8ae070', f4: '#26702c', nut: '#6a4220' }),
    bark: pal({ w1: '#eeeee6', w2: '#cacabe', w3: '#2e2e30' }),
  };
  function drawTreeExtra(b, v) {
    const p = (x, y, c) => b.set(x, y, c);
    if (v === 4) {                       // birch: slim white trunk, light airy crown
      const K = TPAL.bark, C = TPAL.birch;
      b.rect(7, 7, 2, 7, K.w1); b.vline(8, 7, 7, K.w2); b.set(7, 8, K.w3); b.set(8, 10, K.w3); b.set(7, 12, K.w3); b.set(8, 13, K.w3); b.set(6, 13, K.w2); b.set(9, 13, K.w2);
      oak(p, 7, 3, 2, C, 1); oak(p, 6, 5, 3, C, 1); oak(p, 9, 6, 2, C, 0); oak(p, 5, 8, 1, C, 0);
    } else if (v === 5) {                // palm
      const T = TPAL.palm;
      const trunk = [[7, 13], [7, 12], [7, 11], [8, 10], [8, 9], [8, 8], [9, 7], [9, 6]];
      trunk.forEach((q, i) => { p(q[0], q[1], i & 1 ? T.t2 : T.t1); p(q[0] + 1, q[1], i & 1 ? T.t3 : T.t2); });
      p(6, 13, T.t2); p(10, 13, T.t3);
      const top = [10, 5];
      const fr = [[[9, 4], [6, 3], [3, 4], [2, 6]], [[10, 4], [13, 3], [15, 5], [15, 7]], [[9, 4], [8, 1], [6, 0]], [[11, 4], [12, 1], [14, 1]], [[9, 5], [5, 6], [4, 9]], [[11, 5], [14, 7], [15, 10]]];
      fr.forEach((f, k) => { let q0 = [top[0], top[1]]; f.forEach((q, i) => { b.line(q0[0], q0[1], q[0], q[1], i === 0 ? T.f3 : (k & 1 ? T.f1 : T.f2)); q0 = q; }); });
      b.set(10, 4, T.f4); b.set(9, 5, T.f4); b.set(10, 6, T.nut); b.set(11, 6, T.nut); b.set(9, 6, T.nut);
    } else if (v === 6) {                // dead tree
      const D = TPAL.dead;
      b.rect(7, 5, 2, 9, D.a); b.vline(7, 5, 9, D.b); b.vline(8, 7, 7, D.c); b.set(6, 13, D.a); b.set(9, 13, D.c); b.set(7, 14, D.d);
      b.line(7, 8, 3, 4, D.a); b.line(8, 7, 12, 3, D.a); b.line(7, 10, 4, 9, D.c); b.line(8, 9, 12, 8, D.c); b.line(7, 5, 6, 1, D.b); b.line(8, 5, 9, 2, D.a);
      b.set(3, 3, D.c); b.set(12, 2, D.c); b.set(5, 6, D.b); b.set(10, 5, D.b);
    } else if (v === 7) {                // snow-laden pine
      const C = TPAL.snowpine;
      b.vline(7, 11, 3, FP.tree.trunk); b.vline(8, 11, 3, FP.tree.trunk2);
      for (let i = 0; i < 4; i++) {
        const y0 = 1 + i * 3, hw = 1 + i;
        for (let j = 0; j < 4; j++) {
          const w = Math.min(hw, Math.round(j * hw / 3 + (i ? 0.6 : 0)));
          for (let x = -w; x <= w; x++) {
            const edge = Math.abs(x) === w;
            let c = x < 0 ? (edge ? C.m : C.l) : x === 0 ? C.m : (edge ? C.dd : C.d);
            if (j === 3) c = x < 0 ? C.d : C.dd;
            if (j <= 1) c = x <= 0 ? C.sn : C.sh;                  // snow on the upper half of every tier
            if (i === 0 && j === 0) c = C.ll;
            b.set(7 + x, y0 + j, c);
          }
        }
      }
    } else {                             // 8: autumn oak
      const C = TPAL.autumn;
      b.rect(7, 10, 2, 4, FP.tree.trunk); b.vline(8, 11, 3, FP.tree.trunk2); b.set(6, 13, FP.tree.trunk); b.set(9, 13, FP.tree.trunk2);
      oak(p, 4, 8, 3, C, 0); oak(p, 11, 8, 3, C, 0); oak(p, 7, 5, 4, C, 0); oak(p, 8, 8, 3, C, 0);
    }
  }
  // ---- ground decals (transparent 16x16 overlays): scorch = burnt ground with charred stumps ----
  const decalCache = new Map();
  function buildDecal(kind, v) {
    const b = new Buf(TS, TS), r = rng(5000 + v * 7);
    if (kind === 'scorch') {
      const soot = [rgba(20, 14, 12, 190), rgba(40, 28, 22, 170), rgba(72, 58, 48, 140)], ash = rgba(150, 146, 140, 200), glow = rgba(120, 50, 20, 190);
      const cx = 7.5 + (r() - 0.5) * 3, cy = 8 + (r() - 0.5) * 3, rad = 5.2 + r() * 1.4;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const dx = x - cx, dy = (y - cy) * 1.15, dd = Math.sqrt(dx * dx + dy * dy), n = h2(x, y, 77 + v);
        const e = dd / rad + (n - 0.5) * 0.7;
        if (e > 1) continue;
        b.set(x, y, e < 0.45 ? soot[0] : e < 0.75 ? soot[1] : soot[2]);
        if (n > 0.93) b.set(x, y, ash); else if (n < 0.04 && e < 0.7) b.set(x, y, glow);
      }
      for (let k = 0; k < 2 + (v & 1); k++) {                // charred stumps / trunks
        const x = 3 + ((r() * 9) | 0), y = 5 + ((r() * 7) | 0), hh = 2 + ((r() * 3) | 0);
        for (let j = 0; j < hh; j++) { b.set(x, y + j, rgba(26, 18, 14)); b.set(x + 1, y + j, rgba(46, 34, 26)); }
        b.set(x, y - 1, rgba(80, 70, 62)); b.set(x + 1, y + hh, rgba(14, 10, 8, 170));
      }
    }
    if (kind === 'ruin') {                                 // rubble of a destroyed building: v & 1 = timber (burnt beams, planks), else stone blocks
      const wood = (v & 1) === 1, soot = rgba(28, 20, 16, 170), ash = rgba(92, 80, 72, 190);
      for (let y = 6; y < 15; y++) for (let x = 1; x < 15; x++) { const dx = (x - 7.5) / 6.8, dy = (y - 10.5) / 4.2, n = h2(x, y, 31 + v); if (dx * dx + dy * dy + (n - 0.5) * 0.5 < 1) b.set(x, y, n < 0.25 ? soot : ash); }
      const K = wood ? [rgba(110, 76, 44), rgba(78, 52, 30), rgba(46, 30, 18), rgba(150, 108, 66)] : [rgba(190, 192, 202), rgba(140, 142, 156), rgba(96, 98, 114), rgba(220, 222, 232)];
      if (wood) {
        for (let k = 0; k < 4; k++) { const x0 = 2 + ((r() * 8) | 0), y0 = 8 + ((r() * 6) | 0), dx = 3 + ((r() * 4) | 0), dy = ((r() * 5) | 0) - 2; b.line(x0, y0, x0 + dx, y0 + dy, K[k & 1]); b.line(x0, y0 + 1, x0 + dx, y0 + dy + 1, K[2]); b.set(x0, y0, K[3]); }
        const px = 4 + ((r() * 8) | 0); b.vline(px, 4, 8, K[1]); b.vline(px + 1, 5, 7, K[2]); b.set(px, 4, K[3]); b.set(px + 1, 3, soot);   // a charred post still standing
      } else {
        const wx = 3 + ((r() * 6) | 0); for (let j = 0; j < 4; j++) for (let i = 0; i < 5 - (j & 1); i++) b.set(wx + i, 8 + j, ((i + j) & 1) ? K[1] : K[0]);                // a stub of wall
        b.hline(wx, 8, 5, K[3]); b.set(wx + 4, 7, K[1]); b.set(wx + 1, 7, K[0]); b.hline(wx, 11, 5, K[2]);
        for (let k = 0; k < 5; k++) { const x = 1 + ((r() * 13) | 0), y = 11 + ((r() * 3) | 0); b.set(x, y, K[k % 3]); b.set(x + 1, y, K[(k + 1) % 3]); b.set(x, y - 1, K[3]); }
      }
      for (let k = 0; k < 3; k++) b.set(2 + ((r() * 12) | 0), 6 + ((r() * 8) | 0), rgba(255, 130, 40, 200));          // last embers
    }
    return b;
  }
  function decal(kind, variant) {
    const v = (variant | 0) & 7, key = kind + v;
    let c = decalCache.get(key);
    if (c !== undefined) return c;
    c = buildDecal(kind, v).toCanvas();
    decalCache.set(key, c);
    return c;
  }
  function buildFeature(kind, v) {
    const b = new Buf(TS, TS), RES = Const.RES;
    if (kind === RES.TREE) { if (v >= 4 && v <= 8) drawTreeExtra(b, v); else drawTreeFeature(b, v & 3); b.outline(); groundShadow(b, 8, 15, 4); return b; }
    if (kind === RES.ROCK || kind === RES.IRON || kind === RES.GOLD) {
      const K = kind === RES.ROCK ? FP.rock : kind === RES.IRON ? FP.iron : FP.gold, s = 100 + v + kind * 7;
      const vv = v & 3;
      if (vv === 0) { shadedBlob(b, 7.5, 9.5, 5.5, 4.2, K, s); shadedBlob(b, 12.5, 12, 2.3, 1.8, K, s + 1); }
      else if (vv === 1) { shadedBlob(b, 5, 10.5, 3.6, 3.2, K, s); shadedBlob(b, 10.5, 9, 4.6, 4.4, K, s + 2); }
      else if (vv === 2) {                      // jagged tall slab
        const rows = [[7, 8], [6, 9], [6, 10], [5, 10], [4, 11], [4, 11], [3, 12], [3, 12]];
        for (let j = 0; j < rows.length; j++) for (let x = rows[j][0]; x <= rows[j][1]; x++) {
          const t = (x - rows[j][0]) / (rows[j][1] - rows[j][0] + 0.001);
          b.set(x, 4 + j + 1, t < 0.3 ? K.hi : t < 0.55 ? K.lt : t < 0.8 ? K.md : K.dk);
        }
        b.vline(8, 7, 5, K.dk); b.set(7, 8, K.md); b.set(5, 11, K.lt);
        shadedBlob(b, 12.5, 12.5, 2, 1.6, K, s + 3);
      } else { shadedBlob(b, 4.5, 11, 2.8, 2.3, K, s); shadedBlob(b, 9.5, 9.5, 3.6, 3.2, K, s + 1); shadedBlob(b, 12, 12.5, 2, 1.6, K, s + 2); }
      if (kind === RES.IRON) ores(b, ORE.iron, s, 3);
      if (kind === RES.GOLD) { ores(b, ORE.gold, s, 3); b.set(9, 6, WHITE); b.set(8, 6, ORE.gold.d); b.set(10, 6, ORE.gold.d); b.set(9, 5, ORE.gold.d); b.set(9, 7, ORE.gold.d); }
      b.outline(); groundShadow(b, 8, 15, 5);
      return b;
    }
    if (kind === RES.BERRY) {
      const dep = v === 9 || v >= 8;
      const L = dep ? pal({ hi: '#a8b050', lt: '#8e9a40', md: '#737f34', dk: '#566026', ex: '#3c4418' }) : pal({ hi: '#7fe064', lt: '#58c050', md: '#3ea044', dk: '#2a7a38', ex: '#1c5a2a' });
      shadedBlob(b, 8, 9.5, 6, 4.4, L, 300 + v); shadedBlob(b, 4.5, 11, 3, 2.4, L, 301); shadedBlob(b, 11.5, 11, 3, 2.4, L, 302);
      if (dep) {
        const tw = pal({ a: '#6a4a2a', b: '#8a6a3e' });
        b.set(5, 7, tw.a); b.set(6, 6, tw.b); b.set(10, 7, tw.a); b.set(11, 6, tw.b); b.set(8, 5, tw.a); b.set(8, 4, tw.b); b.set(3, 10, tw.a); b.set(12, 10, tw.a);
      } else {
        const red = pal({ a: '#e02a2a', b: '#a81420', h: '#ff9a9a' });
        const pos = [[[5, 8], [8, 7], [11, 9], [7, 11], [10, 12]], [[6, 7], [9, 8], [4, 10], [12, 10], [8, 11]], [[5, 9], [9, 7], [11, 10], [7, 10], [8, 12], [3, 11]], [[7, 7], [10, 8], [5, 10], [12, 11], [9, 11]]][v & 3];
        for (const q of pos) { b.set(q[0], q[1], red.a); b.set(q[0] + 1, q[1], red.b); b.set(q[0], q[1] - 1 < 0 ? 0 : q[1] - 1, red.h); }
      }
      b.outline(); groundShadow(b, 8, 15, 5);
      return b;
    }
    // FISH or unknown: tiny fish + ripples
    const w = pal({ a: '#cfe8ff', b: '#6aa8e0', c: '#ffffff' });
    b.hline(5, 8, 5, w.b); b.hline(6, 7, 3, w.a); b.hline(6, 9, 3, w.a); b.set(10, 8, w.a); b.set(11, 7, w.a); b.set(11, 9, w.a); b.set(6, 8, w.c);
    b.set(3, 12, w.c); b.set(4, 12, w.c); b.set(11, 12, w.c); b.set(12, 12, w.c);
    return b;
  }
  function feature(kind, variant) {
    variant = variant | 0; if (variant < 0) variant = 0; if (variant > 15) variant = 15;
    const key = kind * 16 + variant;
    let c = featCache.get(key);
    if (c !== undefined) return c;
    c = buildFeature(kind, variant).toCanvas();
    featCache.set(key, c);
    return c;
  }

  /* ===============================================================
   * UNITS
   * =============================================================== */
  // base letters: weapons / armor are shared by all races
  const UBASE = pal({
    o: '#a06a34', O: '#6a4220', M: '#f2f6fb', m: '#b6c2d2', n: '#6c7890', g: '#f4c430', i: '#e8ecf2',
    r: '#a8683a', R: '#6c4020', q: '#cc8c54',
    a: '#a8b0ba', A: '#6e7884', z: '#dce2e8',
    B: '#dfe8f4', N: '#8798b4', Z: '#ffffff',
    u: '#7fffa0', U: '#d8fff0', x: '#2a1218', e: '#1a1224',
    d: '#4a2e1a', w: '#6a4426', W: '#f4f6f8',
    l: '#c4ccd8', J: '#8c93a2', T: '#566070', y: '#ffd83a', Q: '#b07410', f: '#e8cc90', D: '#a07848', I: '#a8b8d8', K: '#586078', '1': '#e04030', '2': '#58c050',
  });
  // race / look palettes (skin, hair, clothing basics)
  const HUMAN_LOOK = [
    { s: '#f2c8a2', S: '#d29c76', k: '#ffe0c4', h: '#6e4426', H: '#4a2c18', j: '#8a5a34' },
    { s: '#e2ab80', S: '#bc835a', k: '#f6c8a2', h: '#e8c45c', H: '#c29c38', j: '#f8e08a' },
    { s: '#b98358', S: '#94603e', k: '#d4a07a', h: '#34283a', H: '#1e1624', j: '#52425a' },
    { s: '#f7d9bd', S: '#dcb08c', k: '#fff0de', h: '#b04a22', H: '#80300f', j: '#d06a3a' },
  ];
  const ORC_LOOK = [
    { s: '#4a9a34', S: '#33701f', k: '#74c04a', h: '#2a2030', H: '#14101c', j: '#4a3a50' },
    { s: '#3f8a3c', S: '#2a6228', k: '#66b058', h: '#8a2a1a', H: '#5c160c', j: '#b04030' },
    { s: '#5aa83a', S: '#3c7e26', k: '#84cc52', h: '#2a2030', H: '#14101c', j: '#4a3a50' },
    { s: '#6cae2c', S: '#4a8420', k: '#94d048', h: '#5a4630', H: '#38281a', j: '#7a6244' },
  ];
  const ELF_LOOK = [
    { s: '#f6e0cc', S: '#dcbca4', k: '#fff2e4', h: '#e4e4f0', H: '#b4b4cc', j: '#ffffff' },
    { s: '#f6dcc4', S: '#dab69c', k: '#fff0e0', h: '#f0cc4c', H: '#c8a02a', j: '#fff08a' },
    { s: '#ecd0b8', S: '#cca88c', k: '#fae6d2', h: '#40345c', H: '#271e40', j: '#62528a' },
    { s: '#f4dcc8', S: '#d8b8a0', k: '#fff0e2', h: '#9a6a3a', H: '#6e4420', j: '#c28e58' },
  ];
  const NEUTRAL = hex('#8d7b66');

  function unitPal(race, stage, look, tint) {
    const P = Object.create(null);
    for (const k in UBASE) P[k] = UBASE[k];
    const L = (race === 1 ? ORC_LOOK : race === 2 ? ELF_LOOK : HUMAN_LOOK)[look & 3];
    for (const k in L) P[k] = hex(L[k]);
    if (stage === 2) {                          // elders: white / grey hair, duller skin
      P.h = hex('#e8e8ee'); P.H = hex('#b8b8c8'); P.j = hex('#ffffff');
      if (race === 1) { P.s = mix(P.s, hex('#9a9a80'), 0.35); P.S = mix(P.S, hex('#6a6a58'), 0.35); P.k = mix(P.k, hex('#b8b8a0'), 0.3); }
      else { P.s = mix(P.s, hex('#c8b4a0'), 0.25); P.S = mix(P.S, hex('#9a8470'), 0.25); }
    }
    const base = tint ? hex(tint) : NEUTRAL;
    P.C = base; P.c = dk(base, 0.66); P.L = lt(base, 0.32);
    if (race === 0) { P.p = hex('#5c6682'); P.P = hex('#444c64'); P.b = hex('#4a3020'); P.v = hex('#8a5a30'); P.V = hex('#5c3a1c'); }
    else if (race === 1) { P.p = hex('#5a3c24'); P.P = hex('#3c2614'); P.b = hex('#2e1e12'); P.v = hex('#92602e'); P.V = hex('#5c3a1c'); P.Y = hex('#ffe040'); P.t = hex('#fff4d0'); }
    else { P.p = hex('#4c7a50'); P.P = hex('#365a3a'); P.b = hex('#5c4228'); P.G = hex('#6cc468'); P.E = hex('#3f8a4c'); P.F = hex('#f6fff0'); P.v = hex('#8a6a40'); }
    return P;
  }

  // ---- rigs: art in frame-B (tall passing pose) coordinates; frame A (contact) sits 1px lower with legs spread ----
  // al/ar = [x, y, len, sleeveLetter, handLetter]; legs {y,h,x:[l,r],w,top,bot,spread}
  const RIG = [
    [ // human
      { // child
        head: ['hhhhh', 'seses', '.sss.'], hx: 5, hy: 7, torso: ['sCCCs', '.cCc.'], tx: 5, ty: 10, al: null, ar: null,
        legs: { y: 12, h: 2, x: [6, 8], w: 1, spread: 1 }, hand: [10, 10], helm: null, chest: null,
      },
      { // adult
        head: ['.hhh.', 'hhhhh', 'seses', '.sSs.'], hx: 5, hy: 3, torso: ['LCCCc', 'LCCCc', 'wwgww', 'cCCCc'], tx: 5, ty: 7,
        al: [4, 7, 3, 'c', 's'], ar: [10, 7, 3, 'c', 's'], legs: { y: 11, h: 3, x: [6, 8], w: 1, spread: 1 }, hand: [11, 8],
        helm: { x: 5, y: 3, w: 5 }, chest: { x: 5, y: 7, w: 5 },
      },
      { // elder
        head: ['.jjj.', 'jjjjj', 'seses', '.jjj.'], hx: 6, hy: 4, torso: ['LCCCc', 'CCCCc', 'cCCCc', 'cCCCc'], tx: 5, ty: 8,
        al: [4, 9, 2, 'c', 's'], ar: [10, 9, 3, 'c', 's'], legs: { y: 12, h: 2, x: [6, 8], w: 1, spread: 1 }, hand: [11, 10],
        helm: { x: 6, y: 4, w: 5 }, chest: { x: 5, y: 8, w: 5 }, extra: [[4, 8, 'c']],
      },
    ],
    [ // orc
      { // child
        head: ['..H..', 'sssss', 'sYsYs', '.tst.'], hx: 5, hy: 6, torso: ['sCCCs', '.vvv.'], tx: 5, ty: 10, al: null, ar: null,
        legs: { y: 12, h: 2, x: [6, 8], w: 1, spread: 1 }, hand: [10, 10], helm: null, chest: null,
      },
      { // adult: wide shoulders, bare chest, leather harness, tinted loincloth + sash
        head: ['..HH..', '.ssss.', 'sYssYs', 'tsxxst'], hx: 5, hy: 2,
        torso: ['VvSssSvV', 'VvsCCsvV', '.vSCCSv.', '.wwdwww.', '..cCCc..'], tx: 4, ty: 6,
        al: [3, 7, 4, 's', 's'], ar: [12, 7, 4, 's', 's'], legs: { y: 11, h: 3, x: [5, 9], w: 2, spread: 1, top: 'P', bot: 'b' }, hand: [13, 9],
        helm: { x: 5, y: 2, w: 6 }, chest: { x: 5, y: 6, w: 6 }, pads: [[4, 6], [11, 6], [4, 7], [11, 7]],
      },
      { // elder (hunched: head forward, body back, greyer skin)
        head: ['..jj..', '.ssss.', 'sYssYs', 'sjxxjs'], hx: 6, hy: 3,
        torso: ['VvSssSvV', 'VvsCCsvV', '.wwdwww.', '..cCCc..'], tx: 3, ty: 7,
        al: [2, 8, 3, 's', 's'], ar: [11, 8, 3, 's', 's'], legs: { y: 11, h: 3, x: [4, 8], w: 2, spread: 1, top: 'P', bot: 'b' }, hand: [12, 9],
        helm: { x: 6, y: 3, w: 6 }, chest: { x: 4, y: 7, w: 6 }, pads: [[3, 7], [10, 7], [3, 8], [10, 8]],
      },
    ],
    [ // elf
      { // child
        head: ['hhhhh', 'seses', '.sss.'], hx: 5, hy: 7, torso: ['sFFFs', '.GCG.'], tx: 5, ty: 10, al: null, ar: null,
        legs: { y: 12, h: 2, x: [6, 8], w: 1, spread: 1 }, hand: [10, 10], helm: null, chest: null,
        extra: [[4, 8, 'k'], [3, 7, 'k'], [10, 8, 'k'], [11, 7, 'k']],
      },
      { // adult
        head: ['.hhh.', 'hhhhh', 'seses', '.sss.'], hx: 5, hy: 2, torso: ['FFF', 'GGG', 'CCC', 'EGE'], tx: 6, ty: 6,
        al: [5, 6, 3, 'C', 's'], ar: [9, 6, 3, 'C', 's'], legs: { y: 10, h: 4, x: [6, 8], w: 1, spread: 1 }, hand: [11, 7],
        helm: { x: 5, y: 2, w: 5 }, chest: { x: 6, y: 6, w: 3 },
        extra: [[4, 3, 'k'], [3, 2, 'k'], [10, 3, 'k'], [11, 2, 'k'], [4, 4, 'h'], [4, 5, 'h'], [4, 6, 'h'], [4, 7, 'H'], [4, 8, 'H'], [10, 4, 'h'], [10, 5, 'h'], [10, 6, 'h'], [10, 7, 'H'], [10, 8, 'H']],
      },
      { // elder
        head: ['.jjj.', 'jjjjj', 'seses', '.jjj.'], hx: 5, hy: 3, torso: ['FFF', 'GGG', 'GCG', 'EGE'], tx: 6, ty: 7,
        al: [5, 7, 3, 'C', 's'], ar: [9, 7, 3, 'C', 's'], legs: { y: 11, h: 3, x: [6, 8], w: 1, spread: 1 }, hand: [11, 8],
        helm: { x: 5, y: 3, w: 5 }, chest: { x: 6, y: 7, w: 3 },
        extra: [[4, 4, 'k'], [3, 3, 'k'], [10, 4, 'k'], [11, 3, 'k'], [4, 5, 'j'], [4, 6, 'j'], [4, 7, 'j'], [4, 8, 'j'], [10, 5, 'j'], [10, 6, 'j'], [10, 7, 'j'], [10, 8, 'j']],
      },
    ],
  ];

  // ---- weapons (X = grip cell, replaced by the hand) ----
  const WEAPON = [
    [null,
      ['oo', 'oo', 'oO', 'O.', 'O.', 'X.', 'O.'],                                          // club
      [' M ', ' M ', ' m ', ' m ', 'ggg', ' X ', ' O '],                                   // sword
      [' Z ', ' M ', ' M ', ' M ', ' m ', ' m ', 'gMg', ' X ', ' g '],                     // steel sword
    ],
    [null,
      ['MoM', 'ooo', '.oO', '.O.', '.X.', '.O.'],                                          // spiked club
      ['OMM', 'OMM', 'OMn', 'On.', 'O..', 'X..', 'O..'],                                   // axe
      ['nMOMn', 'MMOMM', 'nMOMn', '..O..', '..X..', '..O..'],                              // great axe
    ],
    [null,
      ['to.', 'to.', 't.o', 't.X', 't.o', 'to.', 'to.'],                                   // short bow (string on the archer side)
      ['to.', 'to.', 'to.', 't.o', 't.X', 't.o', 'to.', 'to.', 'to.'].map(r => r.replace(/o/g, 'O')),   // long bow
      ['tgu', 'tg.', 'tg.', 't.g', 't.X', 't.g', 'tg.', 'tg.', 'tgu'],                     // elven bow, glowing tips
    ],
  ];
  // staff for elders without a weapon
  const CANE = ['o', 'o', 'o', 'X', 'O', 'O'];

  // ---- armour overlays (rows start at helm.y-1 so tier 3 can carry a tinted plume) ----
  const HELM5 = [
    null,
    ['.....', '.qrr.', 'rrrRr'],
    ['.....', '.zaa.', 'zaaAa', 'a...A', '.aAa.'],
    ['..C..', '.ZBB.', 'ZBBNB', 'B...N', '.NNN.'],
  ];
  const HELM6 = [
    null,
    ['......', '..qr..', '.rrRr.'],
    ['......', '..zaa.', '.zaaAa', 'a....A', '.aAAa.'],
    ['..CC..', '..ZBB.', '.ZBBNB', 'B....N', '.NNNN.'],
  ];
  const CHEST5 = [
    null,
    ['rCCCr', 'rCCCr'],
    ['zaCCa', 'aACCA', 'AaaAA'],
    ['ZBCCN', 'BBCCN', 'NBBNN'],
  ];
  const CHEST6 = [
    null,
    ['rrrrrr', 'rCCCCr', 'rCCCCr'],
    ['zaaaaa', 'aaCCaA', 'aACCAa'],
    ['ZBBBBN', 'BBCCNN', 'NBCCNN'],
  ];
  const CHEST3 = [
    null,
    ['rrr', 'rCr'],
    ['zaa', 'aCA', 'AaA'],
    ['ZBN', 'BCN', 'NBN'],
  ];

  // ---- poses / carried goods (appended to the base rigs) -------------------------------------------------
  // pose: 0 walk/stand (frame 0 contact, 1 passing) | 1 attack (0 raised, 1 strike) | 2 chop | 3 mine | 4 farm | 5 build
  //       6 sleep (lying, blanket in kingdom colour) | 7 fish | 8 forage ; for 1..5,7,8 frame 0 = tool up, 1 = tool down
  // carry: 0 none | 1 wood | 2 stone | 3 food | 4 iron | 5 gold (only drawn together with pose 0)
  const POSES = 9, CARRIES = 6;
  const TOOL = {
    2: ['.MM', 'OMm', 'OM.', 'O..', 'O..', 'X..', 'O..'],                          // axe
    3: ['.mMMMm.', '..nOn..', '...O...', '...O...', '...X...', '...O...'],         // pickaxe
    4: ['MMM', '.O.', '.O.', '.O.', '.X.', '.O.', '.O.'],                          // hoe
    5: ['nMn', 'nMn', '.O.', '.O.', '.X.', '.O.'],                                 // hammer
    7: ['..qO', '..q.', '.qO.', '.q..', 'X...', 'O...'],                            // fishing rod
  };
  const CARRY = [null,
    ['qrrrrrq', 'RrrrrrR'],                      // log
    ['.lll.', 'lllJJ', 'JJJTT'],                  // stone
    ['.12..', 'fDfDf', 'DfDfD', '.DDD.'],         // food basket
    ['IIII', 'KKKK'],                             // iron ingots
    ['.yy.', 'yyyQ', 'yQQQ'],                     // gold nuggets
  ];
  const SHIELD = [null, null,
    ['aaA', 'CLc', 'CCc', 'CCc'],                  // iron-rimmed buckler
    ['ZBN', 'CLc', 'CLc', 'CCc', '.Cc'],           // steel kite shield
  ];
  const flipCache = new Map();
  function flipArt(art) { let r = flipCache.get(art); if (r === undefined) { r = art.slice().reverse(); flipCache.set(art, r); } return r; }
  function stampTool(b, art, hx, hy, P, hand, rot) {
    if (rot) art = flipArt(art);
    let ax = 0, ay = 0;
    for (let j = 0; j < art.length; j++) { const i = art[j].indexOf('X'); if (i >= 0) { ax = i; ay = j; } }
    if (rot) {                                        // never let a plunged tool leave the canvas
      if (hy - ay + art.length > 15) hy = 15 - art.length + ay;
      if (hx - ax + art[0].length > 16) hx = 16 - art[0].length + ax;
    }
    for (let j = 0; j < art.length; j++) for (let i = 0; i < art[j].length; i++) {
      const ch = art[j][i];
      if (ch === ' ' || ch === '.') continue;
      const c = ch === 'X' ? hand : P[ch];
      if (c !== undefined) b.set(hx - ax + i, hy - ay + j, c);
    }
  }
  function limb(b, x0, y0, x1, y1, sleeve, hand) { b.line(x0, y0, x1, y1, sleeve); b.set(x1, y1, hand); }

  // ---- armour overlays (rows start at helm.y-1 so tier 3 can carry a tinted plume) ----
  // (HELM5 / HELM6 / CHEST* defined above)

  function sleeper(race, stage, tint, look) {      // lying figure: the standing body rotated, then a kingdom-coloured blanket
    const P = unitPal(race, stage, look, tint), rg = RIG[race][stage], st = new Buf(TS, TS);
    const lg = rg.legs;
    for (let i = 0; i < 2; i++) for (let j = 0; j < lg.h; j++) for (let w = 0; w < lg.w; w++) st.set(lg.x[i] + w, lg.y + j, P[j === lg.h - 1 ? (lg.bot || 'b') : (lg.top || 'p')]);
    st.art(rg.torso, P, rg.tx, rg.ty);
    for (const a of [rg.al, rg.ar]) if (a) for (let j = 0; j < a[2] - 1; j++) st.set(a[0], a[1] + j, P[a[3]]);
    if (rg.extra) for (const e of rg.extra) st.set(e[0], e[1], P[e[2]]);
    st.art(rg.head, P, rg.hx, rg.hy);
    const bb = st.bbox();
    const o = new Buf(TS, TS);
    if (!bb) return o;
    const W = bb.h, H = bb.w, ox = Math.max(0, (TS - W) >> 1), oy = 14 - H;      // top -> left, right -> up
    for (let y = bb.y0; y <= bb.y1; y++) for (let x = bb.x0; x <= bb.x1; x++) { const c = st.d[y * TS + x]; if ((c >>> 24) > 40) o.set(ox + (y - bb.y0), oy + (bb.x1 - x), c); }
    const hw = (rg.head.length) + 1;                                              // head length along x
    const bl = P.C, bd = P.c, bh = P.L;
    for (let y = oy + 1; y <= 13; y++) for (let x = ox + hw; x < ox + W - (stage === 0 ? 1 : 2); x++) {
      if ((o.get(x, y) >>> 24) < 40) continue;
      o.set(x, y, y === oy + 1 ? bh : y >= 13 ? bd : (((x + y) & 3) === 0 ? bd : bl));
    }
    for (let y = oy; y <= 13; y++) if ((o.get(ox + hw - 1, y) >>> 24) > 40) o.set(ox + hw - 1, y, P.W);   // pillow edge / collar
    o.outline();
    groundShadow(o, 8, 15, 5);
    return o;
  }

  function buildUnit(race, stage, fr, tint, weapon, armor, look, pose, carry) {
    const fem = look > 3; look &= 3;
    if (pose === 6) return sleeper(race, stage, tint, look);
    const b = new Buf(TS, TS), P = unitPal(race, stage, look, tint), rg = RIG[race][stage];
    // pose geometry: body drop d, legs frame lfr (0 spread / 1 together), upper-body lean ox, hand offset (dx,dy), tool rotation
    let d = fr ? 0 : 1, lfr = fr, ox = 0, dx = 0, dy = 0, rot = 0;
    if (pose === 1) { if (fr === 0) { d = 0; lfr = 1; ox = -1; dy = -2; } else { d = 1; lfr = 0; ox = 1; dx = 1; dy = -1; rot = 1; } }
    else if (pose === 8) { if (fr === 0) { d = 0; lfr = 1; dy = 1; } else { d = 1; lfr = 0; ox = 1; dx = 1; dy = 3; } }
    else if (pose === 7) { d = 0; lfr = 1; dy = fr ? 0 : -1; }
    else if (pose >= 2) { if (fr === 0) { d = 0; lfr = 1; dy = -2; } else { d = 1; lfr = 0; ox = 1; dx = 1; dy = 2; rot = 1; } }
    const HX = rg.hand[0] + ox + dx, HY = rg.hand[1] + d + dy;
    const lg = rg.legs, topL = lg.top || 'p', botL = lg.bot || 'b', tw = rg.torso[0].length;
    const tool = TOOL[pose];
    const bow = race === 2 && stage !== 0 && weapon > 0;
    const hasW = stage !== 0 && pose <= 1 && (weapon > 0 || (stage === 2 && weapon === 0 && pose === 0));
    // ---- behind the body: orc banner pole, elf cape
    if (stage !== 0 && armor > 0) {
      if (race === 1 && armor === 3) {                 // standard bearer: tinted war banner on a pole behind the shoulders
        const px = rg.al[0] - 1 + ox;
        b.vline(px, 0, rg.ty + d + 3, P.O); b.rect(px - 2, 0, 3, 3, P.C); b.hline(px - 2, 0, 3, P.L); b.set(px - 2, 3, P.C); b.set(px - 1, 3, P.c); b.set(px, 0, P.g);
      }
    }
    // ---- legs
    for (let i = 0; i < 2; i++) {
      let x = lg.x[i], y = lg.y, h = lg.h;
      if (!lfr) { x += (i === 0 ? -1 : 1) * lg.spread; y += 1; h = Math.max(1, h - 1); }
      for (let j = 0; j < h; j++) for (let w = 0; w < lg.w; w++) b.set(x + w, y + j, P[j === h - 1 ? botL : topL]);
    }
    // ---- torso (+ skirt for women)
    b.art(rg.torso, P, rg.tx + ox, rg.ty + d);
    if (fem && stage !== 0 && race !== 1) {
      const y0 = rg.ty + d + rg.torso.length, x0 = rg.tx + ox - 1;
      for (let j = 0; j < 2; j++) { b.hline(x0 - j, y0 + j, tw + 2 + j * 2, j ? P.c : P.C); b.set(x0 - j, y0 + j, P.c); }
      b.set(x0 + 1, y0, P.L);
    }
    // ---- carried goods that sit behind the head (shoulder loads)
    const shoulderY = rg.ty + d - 1, shoulderX = rg.tx + ox + (tw >> 1) - 3;
    if (carry === 1 || carry === 4 || carry === 5) {
      const art = CARRY[carry], w = art[0].length, sx = carry === 1 ? shoulderX : rg.tx + ox + tw - 3;
      b.art(art, P, sx, shoulderY);
      if (carry === 5) b.set(sx + 1, shoulderY, P.W);
    }
    // ---- arms
    const armOf = (a, side) => {
      if (!a) return;
      let n = a[2];
      if (pose === 0) { if ((side === 0 && !lfr) || (side === 1 && lfr)) n = Math.max(2, n - 1); }
      else if (pose === 8 && side === 0) n = Math.max(2, n - 1);
      if (pose === 0 && side === 1 && hasW) n = Math.max(1, n - 1);
      for (let j = 0; j < n; j++) b.set(a[0] + ox, a[1] + d + j, P[j === n - 1 ? a[4] : a[3]]);
    };
    armOf(rg.al, 0);
    if (rg.ar) {
      if (pose === 0) {
        armOf(rg.ar, 1);
        if (hasW) for (let x = rg.ar[0] + 1; x < rg.hand[0]; x++) b.set(x, rg.hand[1] + d, P[rg.ar[4]]);
      } else if (bow && pose === 1) {
        limb(b, rg.ar[0] + ox, rg.ar[1] + d, HX + 1, rg.hand[1] + d, P[rg.ar[3]], P[rg.ar[4]]);
        if (fr === 0) limb(b, rg.al[0] + ox, rg.al[1] + d, HX - 3, rg.hand[1] + d, P[rg.al[3]], P[rg.al[4]]);
      } else {
        limb(b, rg.ar[0] + ox, rg.ar[1] + d, HX, HY, P[rg.ar[3]], P[rg.ar[4]]);
      }
    }
    if (rg.extra) for (const e of rg.extra) b.set(e[0] + ox, e[1] + d, P[e[2]]);
    // ---- head (+ long hair for women)
    b.art(rg.head, P, rg.hx + ox, rg.hy + d);
    if (fem && stage !== 0) {
      const hxx = rg.hx + ox - 1, hyy = rg.hy + d + (race === 1 ? 2 : 1), n = race === 1 ? 3 : 4;
      for (let j = 0; j < n; j++) if ((b.get(hxx, hyy + j) >>> 24) < 40 || race === 1) b.set(hxx, hyy + j, j < 2 ? P.h : P.H);
      if (race === 1) b.set(rg.hx + ox + 5, rg.hy + d + 3, P.Y);         // earring
    }
    // ---- armour
    if (stage !== 0 && armor > 0) {
      const wide = rg.helm.w === 6, hz = (wide ? HELM6 : HELM5)[armor];
      b.art(hz, P, rg.helm.x + ox, rg.helm.y + d - 1);
      const ch = rg.chest.w === 6 ? CHEST6 : rg.chest.w === 3 ? CHEST3 : CHEST5;
      b.art(ch[armor], P, rg.chest.x + ox, rg.chest.y + d);
      const tinted = race === 1 ? P.C : null;
      if (armor >= 2) {                       // sleeves / pauldrons
        for (const a of [rg.al, rg.ar]) if (a) b.set(a[0] + ox, a[1] + d, armor === 3 ? P.B : P.a);
        if (armor === 3) for (const a of [rg.al, rg.ar]) if (a) b.set(a[0] + ox, a[1] + d + 1, P.N);
        if (rg.pads) for (const q of rg.pads) b.set(q[0] + ox, q[1] + d, tinted || (armor === 3 ? P.B : P.a));
      } else if (race !== 2) {
        for (const a of [rg.al, rg.ar]) if (a) b.set(a[0] + ox, a[1] + d, P.r);
        if (rg.pads) for (const q of rg.pads) b.set(q[0] + ox, q[1] + d, P.C);
      }
      if (armor === 3) for (let i = 0; i < 2; i++) { const lx = lg.x[i] + (lfr ? 0 : (i === 0 ? -1 : 1) * lg.spread); b.set(lx, lg.y + lg.h - 1 + (lfr ? 0 : 1), P.N); }
      if (race === 0 && armor >= 2) {          // kingdom shield on the left arm
        const sh = SHIELD[armor];
        b.art(sh, P, rg.al[0] - 2 + ox, rg.ty + d);
      }
      if (race === 2) {                        // kingdom cloak behind the shoulders
        const len = 3 + armor * 2, cx = rg.tx + ox - 2;
        for (let j = 0; j < len; j++) { const y = rg.ty + d + j; b.set(cx, y, j === len - 1 ? P.c : P.L); b.set(cx + 1, y, j === len - 1 ? P.c : P.C); }
        if (armor === 3) b.set(cx + 1, rg.ty + d, P.g);
      }
    }
    // ---- carried goods held in front
    if (carry === 2 || carry === 3) {
      const art = CARRY[carry], w = art[0].length;
      b.art(art, P, rg.tx + ox + tw - 2 - (w >> 1) + (race === 1 ? 0 : 0), rg.ty + d + (carry === 3 ? 1 : 1));
    }
    // ---- weapon / tool
    if (pose === 1 && bow) {
      const by = rg.hand[1] + d;
      stampTool(b, WEAPON[2][weapon], HX + 1, by, P, P.s, 0);
      if (fr === 0) { b.hline(HX - 3, by, 7, P.q); b.set(HX + 4, by, P.M); b.set(HX - 3, by - 1, P.u); b.set(HX - 3, by + 1, P.u); }
      else { b.hline(HX + 3, by, 3, P.q); b.set(HX + 6, by, P.M); b.set(HX + 3, by - 1, P.u); }
    } else if (pose === 1 && !hasW) {          // bare fist
      if (fr === 1) { b.hline(rg.ar[0] + ox, HY - 1, 3, P[rg.ar[3]]); b.set(HX + 1, HY - 1, P.s); b.set(HX + 2, HY - 1, P.s); }
    } else if (tool) {
      stampTool(b, tool, HX, HY, P, P.s, rot);
      if (pose === 7) { b.vline(HX + 3, HY - 5, 6 + (fr ? 1 : 0), P.m); b.set(HX + 3, HY + 1 + (fr ? 1 : 0), P.W); }
    } else if (hasW) {
      const art = weapon > 0 ? WEAPON[race][weapon] : CANE;
      stampTool(b, art, HX, HY, P, P.s, pose === 1 ? rot : 0);
    }
    b.outline();
    groundShadow(b, 8, 15, 4);
    for (const x of [4, 5, 10, 11]) if ((b.get(x, 14) >>> 24) < 40) b.set(x, 14, rgba(10, 8, 24, 55));
    return b;
  }

  const tintIds = new Map();
  const unitCache = new Map();
  let tintCount = 0;
  // normalised unit arguments of the last unitKey() call (module-level scratch so the hot path allocates nothing)
  let nR = 0, nS = 0, nF = 0, nW = 0, nA = 0, nL = 0, nP = 0, nC = 0, nT = null;
  function unitKey(race, stage, frame, tint, weapon, armor, look, pose, carry) {
    const st = stage === 'adult' ? 1 : stage === 'child' ? 0 : stage === 'elder' ? 2 : (stage | 0);
    let tid = 0;
    if (tint) { tid = tintIds.get(tint); if (tid === undefined) { tid = ++tintCount; tintIds.set(tint, tid); } }
    let w = weapon | 0, a = armor | 0, po = pose | 0, ca = carry | 0;
    if (st === 0) { w = 0; a = 0; ca = 0; if (po !== 6) po = 0; }
    w = w < 0 ? 0 : w > 3 ? 3 : w; a = a < 0 ? 0 : a > 3 ? 3 : a;
    if (po < 0 || po >= POSES) po = 0;
    if (po !== 0 || ca < 0 || ca >= CARRIES) ca = 0;
    const r = race === 1 ? 1 : race === 2 ? 2 : 0, lk = (look | 0) & 7;
    let f = frame & 1;
    if (po === 6) { w = 0; a = 0; f = 0; }
    nR = r; nS = st; nF = f; nW = w; nA = a; nL = lk; nP = po; nC = ca; nT = tint || null;
    return (((((((tid * 8 + lk) * 3 + r) * 3 + st) * 2 + f) * 4 + w) * 4 + a) * 9 + po) * 6 + ca;
  }
  function unit(race, stage, frame, tint, weapon, armor, look, pose, carry) {
    const key = unitKey(race, stage, frame, tint, weapon, armor, look, pose, carry);
    const hit = unitCache.get(key);
    if (hit !== undefined) return hit;
    if (unitCache.size > 6000) unitCache.clear();
    const c = buildUnit(nR, nS, nF, nT, nW, nA, nL, nP, nC).toCanvas();
    unitCache.set(key, c);
    return c;
  }

  /* ===============================================================
   * BUILDINGS — 16x16, bottom-centre anchored. type: Const.B (1 HOUSE .. 7 MARKET), race 0/1/2, level 1..3, done
   * level = size / richness (L1 small, L3 grand); FARM level = crop growth.  tint = kingdom colour for banners, flags, awnings.
   * =============================================================== */
  const BP = {
    // human
    wood: pal({ a: '#b98550', b: '#d4a064', c: '#8a5a30', d: '#5e3a1c' }),
    plaster: pal({ a: '#efe4c6', b: '#fff6dc', c: '#c8b898' }),
    stone: pal({ a: '#9b9ba8', b: '#bcbcc8', c: '#76768a', d: '#585868' }),
    roof: pal({ a: '#c8402e', b: '#e8604a', c: '#8e2418', d: '#6a1810' }),
    thatch: pal({ a: '#d9ac4e', b: '#f0c864', c: '#a8782a', d: '#7e5418' }),
    shingle: pal({ a: '#7a5440', b: '#9a7256', c: '#523624', d: '#3a241a' }),
    barn: pal({ a: '#a63a28', b: '#cc5640', c: '#742416', d: '#521810' }),
    glass: pal({ a: '#8fd4f4', b: '#d4f4ff', c: '#4a90c0' }),
    gold: pal({ a: '#f6c838', b: '#fff0a0', c: '#b88418' }),
    marble: pal({ a: '#eceef8', b: '#ffffff', c: '#b4b8d0', d: '#8a8ea8' }),
    // orc
    hide: pal({ a: '#7a5238', b: '#9a6c48', c: '#4f3322', d: '#2e1e14' }),
    obone: pal({ a: '#ece4cc', b: '#fffaf0', c: '#b8ae94' }),
    ored: pal({ a: '#b02020', b: '#e04030', c: '#701010' }),
    plank: pal({ a: '#5e4230', b: '#7c5a40', c: '#3e2a1c', d: '#241810' }),
    // elf
    bark: pal({ a: '#80603e', b: '#a07c52', c: '#5a4028', d: '#3a281a' }),
    leaf: pal({ a: '#4cb85c', b: '#82e08a', c: '#2c8a46', d: '#1c6a34', e: '#c4f4c0' }),
    ewhite: pal({ a: '#f2fbf0', b: '#ffffff', c: '#c6dcc4', d: '#98b898' }),
    glow: pal({ a: '#ffe89a', b: '#fffbd8', c: '#ffc04a' }),
    soil: pal({ a: '#7a5230', b: '#654020', c: '#9a6c40', d: '#4e3016' }),
    crystal: pal({ a: '#b8e8ff', b: '#f0fcff', c: '#78b8e8', d: '#e8c8ff' }),
  };
  // look variants (0 = default) for houses / markets: roof colours, thatch, hides and leaf crowns
  const BVAR = [
    null,
    { roof: pal({ a: '#566a94', b: '#7a90bc', c: '#38466a', d: '#242e4a' }), thatch: pal({ a: '#b8a46a', b: '#d8c88c', c: '#8a7a48', d: '#645630' }), hide: pal({ a: '#5e4a3c', b: '#7e6654', c: '#3c2e24', d: '#241a14' }), leaf: pal({ a: '#e8a43c', b: '#ffd070', c: '#c07820', d: '#8a5214', e: '#fff0b0' }) },
    { roof: pal({ a: '#4c8a54', b: '#74b87a', c: '#2e5c38', d: '#1e4026' }), thatch: pal({ a: '#c88a4a', b: '#e8ac68', c: '#965f2a', d: '#6e4018' }), hide: pal({ a: '#8a4a3a', b: '#aa6652', c: '#5e2c22', d: '#3a1812' }), leaf: pal({ a: '#f08ab8', b: '#ffb8d8', c: '#c85088', d: '#8a2c60', e: '#ffe0ee' }) },
  ];
  const DEFTINT = [hex('#c63a2c'), hex('#a02020'), hex('#3cb060')];
  const FLAME = [hex('#ff3a1a'), hex('#ff8a1e'), hex('#ffd23c')];

  function trap(b, y0, y1, xl0, xr0, xl1, xr1, fn) {       // trapezoid rows y0..y1 with linear edge interpolation
    const n = Math.max(1, y1 - y0);
    for (let y = y0; y <= y1; y++) {
      const t = (y - y0) / n, xl = Math.round(xl0 + (xl1 - xl0) * t), xr = Math.round(xr0 + (xr1 - xr0) * t);
      for (let x = xl; x <= xr; x++) b.set(x, y, fn(x, y, x - xl, xr - x, t));
    }
  }
  function wall(b, x, y, w, h, K, beams) {
    b.rect(x, y, w, h, K.a);
    b.vline(x, y, h, K.b); b.hline(x, y + h - 1, w, K.c);
    if (beams) for (let i = 2; i < w - 1; i += 3) b.vline(x + i, y, h - 1, K.c);
  }
  function roofFn(K) {
    return (x, y, l, r, t) => {
      if (t < 0.01 || l <= 0) return K.b;
      if (r <= 0) return K.c;
      if ((y & 1) === 0 && ((x + y) & 3) === 0) return K.c;
      return t > 0.85 ? K.c : (l < 2 ? K.b : K.a);
    };
  }
  function hideFn(x, y, l, r) { const H = BP.hide; return l === 0 ? H.b : r === 0 ? H.c : ((x + y * 2) % 7 === 0 ? H.c : (y + (x >> 2)) % 4 === 0 ? H.b : H.a); }
  function window2(b, x, y, glass, frame) { b.rect(x - 1, y - 1, 4, 4, frame); b.rect(x, y, 2, 2, glass); b.set(x, y, BP.glass.b); }
  function door(b, x, y, w, h, col, frame) { b.rect(x - 1, y - 1, w + 2, h + 1, frame); b.rect(x, y, w, h, col); b.set(x + w - 1, y + (h >> 1), BP.gold.a); }
  function tintOf(T, race) { return T || DEFTINT[race]; }
  function banner(b, x, y, h, col, pole) {
    b.vline(x, y, h + 2, pole);
    b.rect(x + 1, y, 3, h, col); b.set(x + 1, y, lt(col, 0.35)); b.set(x + 2, y, lt(col, 0.35));
    b.set(x + 2, y + h, col); b.set(x + 2, y + h - 1, dk(col, 0.7)); b.set(x + 3, y + h - 1, dk(col, 0.7));
  }
  function flagTop(b, x, y, col) {              // pennant on a pole
    b.vline(x, y, 5, BP.wood.d);
    b.rect(x + 1, y, 4, 3, col); b.set(x + 1, y, lt(col, 0.4)); b.set(x + 2, y, lt(col, 0.4)); b.set(x + 5, y + 1, col); b.set(x + 4, y + 2, dk(col, 0.7)); b.set(x + 3, y + 2, dk(col, 0.7));
  }
  function skull(b, x, y) { const K = BP.obone; b.rect(x, y, 3, 2, K.a); b.set(x, y, K.b); b.set(x + 1, y + 2, K.c); b.set(x, y + 1, BP.hide.d); b.set(x + 2, y + 1, BP.hide.d); }
  function crate(b, x, y, w, h, K) { b.rect(x, y, w, h, K.a); b.hline(x, y, w, K.b); b.hline(x, y + h - 1, w, K.c); b.vline(x, y, h, K.b); b.vline(x + w - 1, y, h, K.c); if (w > 2 && h > 2) b.line(x + 1, y + 1, x + w - 2, y + h - 2, K.c); }
  function torch(b, x, y) { b.vline(x, y + 1, 3, BP.plank.c); b.set(x, y, FLAME[1]); b.set(x, y - 1, FLAME[2]); b.set(x - 1, y, FLAME[0]); b.set(x + 1, y, FLAME[0]); }
  function leafDome(b, cx, cy, rx, ry, seed) {
    const K = BP.leaf;
    for (let y = Math.floor(cy - ry) - 1; y <= Math.ceil(cy + ry) + 1; y++) for (let x = Math.floor(cx - rx) - 1; x <= Math.ceil(cx + rx) + 1; x++) {
      const nx = (x - cx) / (rx + 0.4), ny = (y - cy) / (ry + 0.4), e = nx * nx + ny * ny;
      if (e > 1) continue;
      const li = -(nx * 0.6 + ny * 0.8), n = h2(x, y, seed);
      b.set(x, y, li > 0.5 ? (n > 0.5 ? K.e : K.b) : li > 0.05 ? K.a : li > -0.45 ? (n > 0.7 ? K.a : K.c) : K.d);
    }
  }
  function trunk(b, x, y, w, h) {
    const K = BP.bark;
    b.rect(x, y, w, h, K.a); b.vline(x, y, h, K.b); b.vline(x + w - 1, y, h, K.c);
    for (let j = y + 1; j < y + h - 1; j += 3) { b.set(x + 1 + (j & 1), j, K.c); }
    b.set(x - 1, y + h - 1, K.a); b.set(x - 1, y + h - 2, K.b); b.set(x + w, y + h - 1, K.c);
  }
  function elfDoor(b, x, y, h) { const K = BP.bark, G = BP.glow; b.rect(x - 1, y - 1, 4, h + 1, K.d); b.rect(x, y, 2, h, G.a); b.set(x, y, G.b); b.set(x + 1, y + h - 1, G.c); }
  function stallHuman(b, x, w, c1) {
    const W = BP.wood, A2 = hex('#fff2dc');
    b.rect(x, 7, 1, 7, W.c); b.rect(x + w - 1, 7, 1, 7, W.c);
    for (let i = 0; i < w; i++) { b.set(x + i, 5, i & 1 ? A2 : c1); b.set(x + i, 6, i & 1 ? A2 : c1); b.set(x + i, 7, i & 1 ? dk(A2, 0.8) : dk(c1, 0.8)); }
    b.hline(x - 1, 4, w + 2, lt(c1, 0.3));
    b.rect(x + 1, 10, w - 2, 2, W.a); b.hline(x + 1, 10, w - 2, W.b);
    b.set(x + 1, 9, hex('#e8402c')); b.set(x + 2, 9, hex('#ffd040')); if (w > 4) b.set(x + 3, 9, hex('#60c050')); if (w > 6) b.set(x + 4, 9, hex('#e8402c'));
    b.rect(x + 1, 12, w - 2, 2, W.c);
  }

  /* ---------------- HUMAN ---------------- */
  function humanHouse(b, lv) {
    const W = BP.wood, S = BP.stone, P = BP.plaster, R = BP.roof, Th = BP.thatch;
    if (lv === 1) {
      trap(b, 5, 9, 7, 8, 2, 13, roofFn(Th)); b.hline(1, 10, 14, Th.c);
      wall(b, 4, 10, 8, 4, W, true);
      door(b, 7, 11, 2, 3, W.d, W.c); window2(b, 5, 11, BP.glass.a, W.d); b.set(10, 12, BP.glass.a); b.set(10, 11, BP.glass.a);
    } else if (lv === 2) {
      b.rect(10, 1, 2, 4, S.a); b.vline(10, 1, 4, S.b); b.hline(10, 0, 2, S.c);
      wall(b, 3, 12, 10, 2, S, false); for (let x = 4; x < 12; x += 3) b.vline(x, 12, 2, S.c);
      b.rect(4, 8, 8, 4, P.a); b.hline(4, 8, 8, W.c); b.vline(4, 8, 4, W.c); b.vline(11, 8, 4, W.c); b.vline(7, 8, 4, W.c); b.vline(8, 9, 3, W.c);
      trap(b, 3, 8, 7, 8, 1, 14, roofFn(R));
      door(b, 7, 10, 2, 4, W.d, W.c); b.vline(7, 10, 4, W.c);
      window2(b, 5, 9, BP.glass.a, W.d); window2(b, 9, 9, BP.glass.a, W.d);
    } else {
      b.rect(11, 0, 2, 4, S.a); b.vline(11, 0, 4, S.b); b.rect(3, 1, 2, 4, S.a); b.vline(3, 1, 4, S.b);
      wall(b, 1, 11, 14, 3, S, false); for (let x = 2; x < 14; x += 3) b.vline(x, 11, 3, S.c);
      b.rect(2, 7, 12, 4, P.a); b.hline(2, 7, 12, W.c); b.hline(2, 10, 12, W.c);
      for (const x of [2, 7, 8, 13]) b.vline(x, 7, 4, W.c);
      trap(b, 2, 7, 7, 8, 0, 15, roofFn(R));
      b.set(7, 1, BP.gold.a); b.set(8, 1, BP.gold.a); b.set(7, 0, BP.gold.b);
      b.rect(6, 4, 4, 3, W.c); b.rect(7, 5, 2, 2, BP.glass.a); b.hline(6, 3, 4, R.b);
      door(b, 7, 11, 2, 3, W.d, W.c);
      window2(b, 3, 8, BP.glass.a, W.d); window2(b, 10, 8, BP.glass.a, W.d); b.set(4, 12, BP.glass.a); b.set(11, 12, BP.glass.a); b.set(4, 11, BP.glass.a); b.set(11, 11, BP.glass.a);
    }
  }
  function humanStorage(b, lv) {
    const W = BP.wood, Th = BP.thatch, Bn = BP.barn, Pk = BP.shingle;
    if (lv === 1) {                                     // shed + crates
      trap(b, 6, 9, 7, 8, 3, 12, roofFn(Th)); b.hline(2, 10, 12, Th.c);
      wall(b, 4, 10, 8, 4, W, true); door(b, 7, 11, 2, 3, W.d, W.c);
      crate(b, 12, 11, 3, 3, W); crate(b, 1, 12, 2, 2, W);
      return;
    }
    b.rect(2, 7, 12, 7, Bn.a); b.vline(2, 7, 7, Bn.b); b.vline(13, 7, 7, Bn.c); b.hline(2, 13, 12, Bn.c);
    for (let x = 4; x < 13; x += 2) b.vline(x, 7, 6, Bn.c);
    trap(b, 2, 7, 7, 8, 1, 14, (x, y, l, r) => (l === 0 ? Pk.b : r === 0 ? Pk.d : (y === 2 ? Pk.b : ((y + (x >> 1)) & 1 ? Pk.a : Pk.c))));
    b.rect(5, 8, 6, 6, W.d); b.rect(6, 9, 4, 5, W.a); b.line(6, 9, 9, 13, W.d); b.line(9, 9, 6, 13, W.d); b.vline(8, 9, 5, W.d);
    b.rect(7, 4, 2, 2, Th.a); b.set(7, 4, Th.b);
    if (lv >= 2) { b.rect(0, 11, 3, 3, Th.a); b.hline(0, 11, 3, Th.b); b.hline(0, 13, 3, Th.c); }
    if (lv >= 3) { crate(b, 12, 11, 4, 3, W); b.vline(8, 0, 2, BP.gold.c); b.set(9, 0, BP.gold.a); b.set(7, 1, BP.gold.a); }
  }
  function humanBarracks(b, lv, tc) {
    const S = BP.stone, W = BP.wood, Pk = BP.shingle;
    if (lv === 1) {                                     // timber guard house
      wall(b, 2, 8, 12, 6, W, true);
      trap(b, 5, 8, 7, 8, 1, 14, (x, y, l, r) => (l === 0 ? Pk.b : r === 0 ? Pk.d : (y === 5 ? Pk.b : ((y + (x >> 1)) & 1 ? Pk.a : Pk.c))));
      door(b, 7, 10, 2, 4, W.d, W.c); flagTop(b, 8, 0, tc);
      b.vline(4, 7, 6, W.d); b.vline(6, 8, 5, W.d); b.set(4, 6, BP.stone.b); b.set(6, 7, BP.stone.b);
      b.rect(10, 11, 3, 2, BP.stone.c); b.set(10, 10, BP.stone.b);
      return;
    }
    wall(b, 1, 5, 14, 9, S, false);
    for (let x = 1; x < 15; x += 2) b.set(x, 4, S.a); for (let x = 1; x < 15; x += 2) b.set(x, 3, S.b);
    for (let y = 6; y < 13; y += 2) for (let x = 2; x < 14; x += 4) b.hline(x + ((y >> 1) & 1) * 2, y, 2, S.c);
    door(b, 7, 9, 2, 5, W.d, S.d);
    banner(b, 3, 6, 5, tc, W.c); banner(b, 11, 6, 5, tc, W.c);
    b.line(6, 7, 9, 4, S.b); b.line(9, 7, 6, 4, S.b); b.set(6, 7, BP.gold.a); b.set(9, 7, BP.gold.a);
    if (lv >= 3) { b.rect(0, 2, 3, 12, S.a); b.rect(13, 2, 3, 12, S.a); b.vline(0, 2, 12, S.b); b.vline(15, 2, 12, S.c); for (const x of [0, 2, 13, 15]) b.set(x, 1, S.a); b.set(1, 1, S.b); b.set(14, 1, S.b); b.set(1, 0, tc); b.set(14, 0, tc); b.rect(1, 6, 1, 2, BP.glass.c); b.rect(14, 6, 1, 2, BP.glass.c); }
  }
  function humanTownhall(b, lv, tc) {
    const S = BP.stone, W = BP.wood, R = BP.roof, P = BP.plaster;
    if (lv === 1) {                                     // village hall with a flag on the ridge
      wall(b, 3, 12, 10, 2, S, false);
      b.rect(3, 8, 10, 4, P.a); b.hline(3, 8, 10, W.c); for (const x of [3, 6, 9, 12]) b.vline(x, 8, 4, W.c);
      trap(b, 3, 8, 7, 8, 1, 14, roofFn(R)); flagTop(b, 8, 0, tc);
      door(b, 7, 10, 2, 4, W.d, W.c); window2(b, 4, 9, BP.glass.a, W.d); window2(b, 10, 9, BP.glass.a, W.d);
      return;
    }
    wall(b, 1, 10, 14, 4, S, false); for (let x = 2; x < 14; x += 3) b.vline(x, 10, 4, S.c);
    b.rect(2, 7, 12, 3, P.a); b.hline(2, 7, 12, W.c); b.hline(2, 9, 12, W.c);
    for (const x of [2, 5, 10, 13]) b.vline(x, 7, 3, W.c);
    trap(b, 3, 7, 4, 11, 0, 15, roofFn(R));
    b.rect(6, 1, 4, 7, S.a); b.vline(6, 1, 7, S.b); b.vline(9, 1, 7, S.c);
    trap(b, 0, 2, 7, 8, 5, 10, roofFn(R));
    flagTop(b, 11, 0, tc);
    door(b, 7, 10, 2, 4, W.d, S.d); b.hline(6, 9, 4, BP.gold.a);
    window2(b, 3, 8, BP.glass.a, W.d); window2(b, 11, 8, BP.glass.a, W.d); b.rect(7, 4, 2, 2, BP.glass.a);
    b.set(4, 11, BP.glass.a); b.set(11, 11, BP.glass.a);
    if (lv >= 3) { b.rect(0, 5, 2, 9, S.b); b.rect(14, 5, 2, 9, S.b); b.hline(0, 4, 2, R.a); b.hline(14, 4, 2, R.a); b.set(0, 3, tc); b.set(15, 3, tc); b.set(0, 8, tc); b.set(0, 9, tc); b.set(15, 8, tc); b.set(15, 9, tc); b.set(7, 0, BP.gold.b); b.set(8, 0, BP.gold.a); }
  }
  function humanTemple(b, lv) {
    const M = BP.marble, G = BP.gold;
    if (lv === 1) {                                     // little shrine
      b.rect(3, 12, 10, 2, M.c); b.hline(2, 13, 12, M.d); b.hline(4, 11, 8, M.b);
      for (const x of [4, 10]) { b.rect(x, 6, 2, 5, M.a); b.vline(x, 6, 5, M.b); b.vline(x + 1, 6, 5, M.c); }
      trap(b, 3, 5, 7, 8, 3, 12, (x, y, l, r) => (l === 0 ? M.b : r === 0 ? M.c : y === 3 ? M.b : M.a)); b.hline(3, 5, 10, G.a);
      b.set(7, 2, G.a); b.set(8, 2, G.b);
      b.rect(7, 7, 2, 4, hex('#5a4a78')); b.rect(7, 8, 2, 3, hex('#8ad0ff')); b.set(7, 8, hex('#d8f4ff'));
      return;
    }
    b.rect(2, 12, 12, 2, M.c); b.hline(1, 13, 14, M.d); b.hline(3, 11, 10, M.b);
    b.rect(3, 6, 10, 5, M.a); b.vline(3, 6, 5, M.b); b.vline(12, 6, 5, M.c);
    for (const x of [4, 7, 10]) { b.rect(x, 6, 2, 5, M.b); b.vline(x + 1, 6, 5, M.c); }
    trap(b, 3, 5, 7, 8, 2, 13, (x, y, l, r) => (l === 0 ? M.b : r === 0 ? M.c : (y === 3 ? M.b : M.a)));
    b.hline(2, 5, 12, G.a);
    b.rect(7, 0, 2, 3, M.a); b.vline(7, 0, 3, M.b); b.set(7, 0, G.b); b.set(8, 0, G.a);
    b.rect(7, 6, 2, 5, hex('#5a4a78')); b.rect(7, 7, 2, 4, hex('#8ad0ff')); b.set(7, 7, hex('#d8f4ff'));
    if (lv >= 3) { b.rect(0, 7, 2, 7, M.a); b.rect(14, 7, 2, 7, M.a); b.set(0, 6, G.a); b.set(1, 6, G.a); b.set(14, 6, G.a); b.set(15, 6, G.a); b.vline(0, 7, 7, M.b); b.set(6, 1, G.b); b.set(9, 1, G.b); b.set(7, 0, hex('#fff8c0')); }
  }
  function humanMarket(b, lv, tc) {
    const W = BP.wood;
    if (lv === 1) { stallHuman(b, 3, 10, tc); return; }
    stallHuman(b, 1, 6, hex('#e04a3a')); stallHuman(b, 9, 6, tc);
    b.set(7, 12, BP.gold.a); b.set(8, 13, BP.gold.a); b.rect(7, 10, 2, 2, W.d);
    if (lv >= 3) { flagTop(b, 7, 0, tc); b.set(0, 12, BP.thatch.a); b.set(15, 12, BP.thatch.a); b.set(0, 13, BP.thatch.c); b.set(15, 13, BP.thatch.c); }
  }

  /* ---------------- ORC ---------------- */
  function orcHouse(b, lv) {
    const H = BP.hide, B = BP.obone, Rd = BP.ored, Pk = BP.plank;
    if (lv === 1) {
      trap(b, 4, 13, 7, 8, 2, 13, hideFn);
      b.vline(7, 1, 4, Pk.b); b.vline(8, 2, 3, Pk.a); b.set(6, 1, Pk.b); b.set(9, 2, Pk.b);
      trap(b, 9, 13, 7, 8, 6, 9, () => H.d);
      b.line(5, 8, 4, 12, B.c); b.line(10, 8, 11, 12, B.c);
    } else if (lv === 2) {
      trap(b, 3, 13, 7, 8, 1, 14, hideFn);
      b.vline(7, 0, 4, Pk.b); b.vline(8, 1, 3, Pk.a); skull(b, 6, 0);
      trap(b, 8, 13, 7, 8, 5, 10, () => H.d);
      trap(b, 6, 8, 5, 10, 4, 11, () => Rd.a); b.hline(5, 6, 6, Rd.b);
      b.line(2, 13, 3, 10, B.a); b.line(13, 13, 12, 10, B.a); b.set(3, 9, B.b); b.set(12, 9, B.b);
    } else {
      b.rect(1, 6, 14, 8, Pk.a); for (let x = 1; x < 15; x += 2) b.vline(x, 6, 8, Pk.c); b.vline(1, 6, 8, Pk.b); b.hline(1, 13, 14, Pk.d);
      trap(b, 2, 6, 7, 8, 0, 15, (x, y, l, r) => (l === 0 ? H.b : r === 0 ? H.d : (y === 2 ? H.b : ((x + y) % 5 === 0 ? H.c : H.a))));
      b.line(0, 2, 2, 0, B.a); b.line(15, 2, 13, 0, B.a); b.set(0, 1, B.b); b.set(15, 1, B.b); b.set(2, 1, B.c); b.set(13, 1, B.c);
      door(b, 7, 9, 2, 5, H.d, Pk.d);
      skull(b, 6, 6); b.rect(3, 9, 2, 3, Rd.a); b.rect(11, 9, 2, 3, Rd.a); b.vline(3, 9, 3, Rd.b);
      b.set(2, 8, B.a); b.set(13, 8, B.a);
    }
  }
  function orcStorage(b, lv) {
    const H = BP.hide, Pk = BP.plank, B = BP.obone, W = BP.wood;
    if (lv === 1) {                                     // crates under a hide tarp
      crate(b, 2, 10, 4, 4, Pk); crate(b, 10, 10, 4, 4, Pk); crate(b, 6, 11, 4, 3, W);
      trap(b, 6, 10, 7, 8, 3, 12, hideFn); b.set(7, 5, Pk.b); b.set(8, 5, Pk.b); b.hline(3, 11, 2, H.d);
      b.set(1, 9, B.a); b.set(14, 9, B.a);
      return;
    }
    b.rect(1, 8, 14, 6, Pk.a); for (let x = 1; x < 15; x += 2) b.vline(x, 8, 6, Pk.c); b.hline(1, 13, 14, Pk.d); b.hline(1, 8, 14, Pk.b);
    trap(b, 5, 8, 4, 11, 1, 14, (x, y, l, r) => (l === 0 ? H.b : r === 0 ? H.d : ((x + y) % 4 === 0 ? H.c : H.a)));
    crate(b, 3, 10, 4, 4, Pk); crate(b, 9, 10, 4, 4, Pk); crate(b, 6, 6, 4, 4, W);
    for (let x = 1; x < 15; x += 4) { b.set(x, 7, B.a); b.set(x, 6, B.b); }
    skull(b, 7, 3);
    if (lv >= 3) { b.set(0, 6, B.a); b.set(15, 6, B.a); b.rect(12, 5, 2, 2, BP.ored.a); b.vline(0, 7, 7, Pk.b); b.vline(15, 7, 7, Pk.b); b.set(0, 5, B.b); b.set(15, 5, B.b); }
  }
  function orcBarracks(b, lv, tc) {
    const Pk = BP.plank, B = BP.obone;
    if (lv === 1) {                                     // low stockade + banner
      for (let x = 1; x < 15; x += 2) { b.rect(x, 8, 2, 6, Pk.a); b.vline(x, 8, 6, Pk.b); b.set(x, 7, Pk.b); b.set(x, 6, B.a); }
      b.hline(1, 10, 14, Pk.c); b.hline(1, 13, 14, Pk.d);
      banner(b, 7, 1, 4, tc, Pk.d); door(b, 7, 10, 2, 4, BP.hide.d, Pk.d);
      return;
    }
    for (let x = 0; x < 16; x += 2) { b.rect(x, 6, 2, 8, Pk.a); b.vline(x, 6, 8, Pk.b); b.set(x, 5, Pk.b); b.set(x, 4, B.a); }
    b.hline(0, 9, 16, Pk.c); b.hline(0, 13, 16, Pk.d);
    banner(b, 7, 1, 5, tc, Pk.d); b.rect(7, 6, 1, 1, Pk.d);
    door(b, 7, 10, 2, 4, BP.hide.d, Pk.d);
    b.vline(2, 8, 5, BP.wood.c); b.hline(1, 8, 3, B.a); b.rect(1, 7, 3, 2, BP.ored.a); b.hline(1, 7, 3, B.a);
    b.vline(12, 8, 5, BP.wood.c); b.vline(13, 8, 5, BP.wood.c); b.hline(11, 8, 4, B.c);
    if (lv >= 3) { skull(b, 3, 3); skull(b, 11, 3); b.set(7, 0, B.b); b.set(8, 0, B.b); torch(b, 5, 11); torch(b, 10, 11); }
  }
  function orcTownhall(b, lv, tc) {
    const H = BP.hide, Pk = BP.plank, B = BP.obone, Rd = BP.ored;
    if (lv === 1) {                                     // chief's big tent with a banner
      trap(b, 3, 13, 7, 8, 1, 14, hideFn);
      b.vline(7, 0, 4, Pk.b); b.vline(8, 1, 3, Pk.a); b.rect(9, 0, 4, 3, tc); b.hline(9, 0, 4, lt(tc, 0.35)); b.set(13, 1, tc);
      trap(b, 8, 13, 7, 8, 5, 10, () => H.d); trap(b, 6, 8, 5, 10, 4, 11, () => Rd.a); b.hline(5, 6, 6, Rd.b);
      b.line(2, 13, 3, 10, B.a); b.line(13, 13, 12, 10, B.a);
      return;
    }
    b.rect(1, 8, 14, 6, Pk.a); for (let x = 1; x < 15; x += 2) b.vline(x, 8, 6, Pk.c); b.vline(1, 8, 6, Pk.b); b.hline(1, 13, 14, Pk.d);
    trap(b, 4, 8, 6, 9, 0, 15, (x, y, l, r) => (l === 0 ? H.b : r === 0 ? H.d : ((x + y) % 5 === 0 ? H.c : H.a)));
    trap(b, 1, 4, 7, 8, 4, 11, (x, y, l, r) => (l === 0 ? H.b : r === 0 ? H.d : ((x + y) % 4 === 0 ? H.c : H.a)));
    b.line(0, 4, 2, 1, B.a); b.line(15, 4, 13, 1, B.a); b.set(0, 3, B.b); b.set(15, 3, B.b); b.set(2, 2, B.c);
    b.vline(7, 0, 2, Pk.b);
    b.rect(5, 6, 6, 2, tc); b.hline(5, 6, 6, lt(tc, 0.3));
    door(b, 7, 9, 2, 5, H.d, Pk.d); skull(b, 7, 6);
    skull(b, 2, 9); skull(b, 12, 9);
    b.vline(0, 9, 5, Pk.b); b.vline(15, 9, 5, Pk.b); b.set(0, 8, B.a); b.set(15, 8, B.a);
    if (lv >= 3) { torch(b, 4, 10); torch(b, 11, 10); b.set(6, 0, B.a); b.set(9, 0, B.a); b.set(5, 1, B.b); b.set(10, 1, B.b); }
  }
  function orcTemple(b, lv) {
    const B = BP.obone, Pk = BP.plank, Rd = BP.ored;
    if (lv === 1) {                                     // skull totem with a brazier
      b.rect(5, 12, 6, 2, hex('#3a3238')); b.hline(5, 12, 6, hex('#5a5058'));
      b.vline(7, 3, 9, Pk.a); b.vline(8, 3, 9, Pk.c); skull(b, 6, 2); b.set(7, 1, B.b); b.set(8, 1, B.b);
      b.line(7, 6, 4, 4, B.a); b.line(8, 6, 11, 4, B.a); b.set(4, 3, B.b); b.set(11, 3, B.b);
      b.rect(5, 9, 6, 2, Pk.b); b.set(6, 8, FLAME[1]); b.set(9, 8, FLAME[1]); b.set(6, 7, FLAME[2]); b.set(9, 7, FLAME[2]); b.set(7, 8, FLAME[0]); b.set(8, 8, FLAME[0]);
      return;
    }
    b.rect(3, 11, 10, 3, hex('#3a3238')); b.hline(3, 11, 10, hex('#5a5058')); b.hline(2, 13, 12, hex('#241e24'));
    b.vline(7, 2, 9, Pk.a); b.vline(8, 2, 9, Pk.c); skull(b, 6, 2); b.set(7, 1, B.b); b.set(8, 1, B.b);
    b.line(7, 4, 3, 2, B.a); b.line(8, 4, 12, 2, B.a); b.set(3, 1, B.b); b.set(12, 1, B.b);
    b.line(7, 6, 2, 5, B.c); b.line(8, 6, 13, 5, B.c);
    for (const x of [3, 11]) { b.rect(x, 7, 2, 4, Pk.b); b.rect(x, 6, 2, 1, FLAME[1]); b.set(x, 5, FLAME[2]); b.set(x + 1, 6, FLAME[2]); }
    b.rect(6, 8, 4, 3, Rd.c); b.hline(6, 8, 4, Rd.a); b.set(7, 9, FLAME[2]); b.set(8, 9, FLAME[1]);
    if (lv >= 3) { b.set(1, 10, B.a); b.set(14, 10, B.a); b.set(1, 9, B.b); b.set(14, 9, B.b); b.set(5, 0, FLAME[1]); b.set(10, 0, FLAME[1]); b.set(7, 0, FLAME[0]); b.set(8, 0, FLAME[0]); b.set(3, 4, FLAME[2]); b.set(12, 4, FLAME[2]); }
  }
  function orcMarket(b, lv, tc) {
    const H = BP.hide, Pk = BP.plank, B = BP.obone, Rd = BP.ored;
    const tent = (x, w) => {
      trap(b, 4, 8, x + (w >> 1), x + (w >> 1), x, x + w - 1, (X, y, l, r) => (l === 0 ? H.b : r === 0 ? H.d : ((X + y) % 4 === 0 ? H.c : H.a)));
      b.rect(x, 8, 1, 6, Pk.c); b.rect(x + w - 1, 8, 1, 6, Pk.c);
      b.rect(x + 1, 10, w - 2, 3, Pk.a); b.hline(x + 1, 10, w - 2, Pk.b);
      b.hline(x + 1, 8, w - 2, Rd.a);
    };
    if (lv === 1) {
      tent(3, 10);
      skull(b, 7, 10); b.set(5, 11, hex('#ffd040')); b.set(10, 11, hex('#ffd040')); b.rect(4, 9, 2, 1, hex('#c04050')); b.rect(10, 9, 2, 1, hex('#c04050'));
      return;
    }
    tent(0, 8); tent(8, 8);
    b.rect(2, 8, 1, 2, B.a); b.set(2, 10, B.c); b.rect(5, 9, 2, 1, hex('#c04050')); skull(b, 10, 7); b.rect(13, 9, 2, 1, hex('#c04050'));
    b.set(3, 11, hex('#ffd040')); b.set(5, 11, hex('#ffd040')); b.set(11, 11, B.a); b.set(13, 11, hex('#ffd040'));
    if (lv >= 3) { b.vline(7, 1, 5, Pk.b); b.rect(8, 1, 3, 2, tc); b.set(7, 0, B.b); }
  }

  /* ---------------- ELF (living trees) ---------------- */
  function elfHouse(b, lv) {
    const Bk = BP.bark, G = BP.glow, W = BP.ewhite;
    if (lv === 1) {
      trunk(b, 6, 9, 4, 5); leafDome(b, 8, 5.5, 6.6, 4.4, 3);
      elfDoor(b, 7, 11, 3); b.set(5, 4, W.a); b.set(10, 6, hex('#ff9ac8')); b.set(8, 3, W.b);
    } else if (lv === 2) {
      trunk(b, 5, 9, 6, 5); leafDome(b, 8, 4.5, 7.5, 4.6, 5); leafDome(b, 3.5, 7.5, 3.3, 2.4, 6); leafDome(b, 12.5, 7.5, 3.3, 2.4, 7);
      elfDoor(b, 7, 11, 3); b.rect(5, 11, 1, 2, G.c); b.set(3, 10, G.a); b.set(3, 11, Bk.d); b.set(12, 10, G.a); b.set(12, 11, Bk.d);
      b.set(3, 5, W.a); b.set(13, 5, hex('#ff9ac8')); b.set(8, 1, W.b);
    } else {
      trunk(b, 5, 8, 6, 6); leafDome(b, 8, 4, 7.8, 4.4, 8); leafDome(b, 3, 6.5, 3.4, 2.6, 9); leafDome(b, 13, 6.5, 3.4, 2.6, 10);
      b.hline(1, 10, 14, Bk.b); b.hline(1, 11, 14, Bk.c); for (let x = 1; x < 15; x += 2) b.set(x, 9, Bk.d);
      elfDoor(b, 7, 12, 2); b.set(5, 12, G.a); b.set(10, 12, G.a); b.set(2, 12, G.a); b.set(13, 12, G.a); b.set(2, 13, Bk.d); b.set(13, 13, Bk.d);
      b.set(4, 3, W.b); b.set(11, 2, hex('#ff9ac8')); b.set(8, 0, G.b); b.set(1, 6, hex('#ff9ac8')); b.set(14, 6, W.a);
    }
  }
  function elfStorage(b, lv) {
    const Bk = BP.bark, G = BP.glow;
    if (lv === 1) {                                     // hollow stump
      b.rect(4, 8, 8, 6, Bk.a); b.vline(4, 8, 6, Bk.b); b.vline(11, 8, 6, Bk.c); b.hline(3, 13, 10, Bk.d);
      b.ell(8, 8, 4, 1.4, Bk.b); b.hline(6, 8, 4, Bk.a); b.set(7, 8, Bk.c); b.set(9, 8, Bk.c);
      leafDome(b, 11, 6.5, 2.6, 2, 21);
      b.rect(6, 10, 4, 4, BP.plank.c); b.rect(7, 11, 2, 3, G.a);
      return;
    }
    b.rect(3, 7, 10, 7, Bk.a); b.vline(3, 7, 7, Bk.b); b.vline(12, 7, 7, Bk.c); b.hline(2, 13, 12, Bk.d);
    for (let x = 5; x < 12; x += 2) b.vline(x, 8, 5, Bk.c);
    leafDome(b, 8, 4.5, 7.4, 3.6, 20);
    b.rect(6, 9, 4, 5, BP.plank.c); b.rect(7, 10, 2, 4, G.a); b.hline(6, 9, 4, Bk.d);
    b.hline(3, 11, 2, BP.ewhite.d); b.hline(11, 11, 2, BP.ewhite.d);
    if (lv >= 3) { crate(b, 0, 11, 3, 3, Bk); b.rect(13, 10, 3, 4, Bk.b); b.hline(13, 11, 3, Bk.d); b.hline(13, 13, 3, Bk.d); b.set(4, 8, BP.leaf.a); b.set(4, 9, BP.leaf.c); b.set(11, 9, BP.leaf.a); }
  }
  function elfBarracks(b, lv, tc) {
    const W = BP.ewhite, L = BP.leaf, Bk = BP.bark;
    if (lv === 1) {                                     // archery post
      b.line(8, 10, 5, 13, Bk.a); b.line(8, 10, 11, 13, Bk.c); b.vline(8, 9, 4, Bk.b);
      b.disc(8, 7.5, 3.6, W.a); b.disc(8, 7.5, 2.8, BP.ored.a); b.disc(8, 7.5, 1.8, W.b); b.disc(8, 7.5, 0.8, BP.ored.b);
      b.set(10, 6, Bk.d); b.set(11, 5, W.c);
      banner(b, 13, 4, 4, tc, Bk.c);
      leafDome(b, 3, 11, 2.4, 1.8, 24);
      return;
    }
    b.rect(2, 6, 1, 8, Bk.a); b.rect(13, 6, 1, 8, Bk.a); b.vline(2, 6, 8, Bk.b);
    trap(b, 2, 6, 7, 8, 0, 15, (x, y, l, r) => (l === 0 ? L.e : r === 0 ? L.d : (y === 2 ? L.e : ((x + y) & 1 ? L.a : L.b))));
    b.rect(3, 7, 10, 7, W.c); b.rect(4, 8, 8, 6, W.a);
    b.disc(8, 10.5, 3, W.b); b.disc(8, 10.5, 2, BP.ored.a); b.disc(8, 10.5, 1, W.b); b.set(8, 10, BP.ored.b); b.set(8, 11, BP.ored.b);
    b.set(9, 9, BP.wood.c); b.set(10, 8, BP.wood.d); b.set(6, 12, BP.wood.c);
    banner(b, 4, 7, 4, tc, Bk.c); b.vline(12, 8, 5, Bk.a);
    if (lv >= 2) { b.set(1, 5, L.b); b.set(14, 5, L.b); b.set(1, 6, L.a); }
    if (lv >= 3) { b.set(7, 1, BP.glow.b); b.set(8, 1, BP.glow.a); b.set(8, 0, BP.glow.b); banner(b, 11, 7, 4, tc, Bk.c); }
  }
  function elfTownhall(b, lv, tc) {
    const Bk = BP.bark, G = BP.glow, W = BP.ewhite, M = BP.marble;
    if (lv === 1) {
      trunk(b, 5, 8, 6, 6); leafDome(b, 8, 4.5, 7, 4.2, 30);
      flagTop(b, 8, 0, tc);
      b.rect(6, 10, 4, 4, W.c); b.rect(7, 11, 2, 3, G.a); b.hline(6, 10, 4, W.a);
      return;
    }
    b.rect(4, 7, 8, 7, Bk.a); b.vline(4, 7, 7, Bk.b); b.vline(11, 7, 7, Bk.c); b.rect(2, 12, 12, 2, Bk.a); b.hline(1, 13, 14, Bk.d); b.vline(2, 12, 2, Bk.b);
    for (const x of [6, 9]) b.vline(x, 8, 4, Bk.c);
    leafDome(b, 8, 4, 7.4, 3.8, 31); leafDome(b, 3, 7.5, 3, 2.2, 32); leafDome(b, 13, 7.5, 3, 2.2, 33);
    b.rect(7, 0, 2, 6, M.a); b.vline(7, 0, 6, M.b); b.set(8, 0, G.b); b.set(7, 0, G.b);
    flagTop(b, 11, 0, tc);
    b.rect(6, 9, 4, 5, M.d); b.rect(7, 10, 2, 4, G.a); b.set(7, 10, G.b); b.hline(6, 9, 4, M.c);
    b.rect(5, 9, 1, 2, G.c); b.rect(10, 9, 1, 2, G.c);
    if (lv >= 3) { b.rect(0, 8, 2, 6, M.a); b.rect(14, 8, 2, 6, M.a); b.vline(0, 8, 6, M.b); b.set(0, 7, G.b); b.set(15, 7, G.b); b.set(2, 10, G.a); b.set(13, 10, G.a); b.set(1, 5, W.b); b.set(14, 5, W.b); b.set(5, 1, G.b); b.set(10, 1, G.b); }
  }
  function elfTemple(b, lv) {
    const C = BP.crystal, W = BP.ewhite, G = BP.glow, L = BP.leaf, Bk = BP.bark;
    if (lv === 1) {                                     // crystal on a stone pedestal
      b.rect(4, 11, 8, 3, hex('#8aa886')); b.hline(4, 11, 8, hex('#b4d0b0')); b.hline(3, 13, 10, hex('#5c7a58'));
      trap(b, 2, 4, 7, 8, 6, 9, (x, y, l, r) => (l === 0 ? C.b : r === 0 ? C.c : C.a));
      trap(b, 5, 10, 6, 9, 5, 10, (x, y, l, r, t) => (l === 0 ? C.b : r === 0 ? C.c : t < 0.3 ? C.b : C.a));
      b.set(7, 1, W.b); b.vline(7, 5, 5, C.b); b.set(4, 6, G.b); b.set(11, 8, G.b);
      return;
    }
    b.ell(8, 13, 7, 1.2, hex('#5c7a58')); b.hline(2, 13, 12, hex('#8aa886'));
    b.rect(3, 6, 2, 8, Bk.a); b.rect(11, 6, 2, 8, Bk.a); b.vline(3, 6, 8, Bk.b);
    leafDome(b, 4, 5, 2.6, 2.2, 40); leafDome(b, 11, 5, 2.6, 2.2, 41);
    trap(b, 1, 3, 7, 8, 6, 9, (x, y, l, r) => (l === 0 ? C.b : r === 0 ? C.c : C.a));
    trap(b, 4, 11, 6, 9, 5, 10, (x, y, l, r, t) => (l === 0 ? C.b : r === 0 ? C.c : t < 0.3 ? C.b : C.a));
    b.set(7, 0, W.b); b.set(8, 0, C.d); b.vline(7, 5, 6, C.b); b.set(6, 6, C.d); b.set(9, 8, C.d);
    b.hline(5, 12, 6, hex('#9ec0e0'));
    if (lv >= 3) { b.set(3, 3, C.b); b.set(12, 3, C.b); b.set(1, 7, G.b); b.set(14, 7, G.b); b.set(5, 1, G.b); b.set(10, 1, G.b); b.set(4, 2, C.d); b.set(11, 2, C.d); b.set(6, 0, C.d); b.set(9, 0, C.d); }
  }
  function elfMarket(b, lv, tc) {
    const Bk = BP.bark, G = BP.glow, W = BP.ewhite;
    const stall = (x, w, fa, fb) => {
      b.rect(x, 7, 1, 7, Bk.c); b.rect(x + w - 1, 7, 1, 7, Bk.c);
      leafDome(b, x + (w >> 1), 5, (w >> 1) + 1.2, 3.6, 50 + x);
      b.rect(x + 1, 10, w - 2, 2, Bk.a); b.hline(x + 1, 10, w - 2, Bk.b);
      b.set(x + 1, 9, fa); b.set(x + 2, 9, fb); if (w > 4) b.set(x + 3, 9, fa);
      b.rect(x + 1, 12, w - 2, 2, Bk.c);
      b.set(x + 1, 8, G.a); b.set(x + w - 2, 8, G.c);
    };
    if (lv === 1) { stall(3, 10, hex('#ff8ac0'), hex('#fff0a0')); b.set(8, 12, tc); b.set(7, 12, tc); return; }
    stall(0, 8, hex('#ff8ac0'), hex('#fff0a0')); stall(8, 8, hex('#a0b8ff'), hex('#ff8ac0'));
    b.set(7, 12, tc); b.set(8, 12, tc); b.set(7, 11, tc);
    if (lv >= 3) { b.set(7, 8, G.b); b.set(8, 8, G.b); b.set(7, 0, G.b); b.set(8, 0, W.b); }
  }

  /* -------- FARM (level = growth stage: 1 sprouts, 2 green, 3 ripe) -------- */
  function farm(b, race, lv) {
    const S = BP.soil;
    for (let y = 5; y <= 13; y++) for (let x = 1; x <= 14; x++) {
      const row = (y - 5) >> 1, even = ((y - 5) & 1) === 0;
      b.set(x, y, even ? (row & 1 ? S.a : S.c) : S.b);
    }
    b.hline(1, 13, 14, S.d); b.vline(1, 5, 9, S.c); b.vline(14, 5, 9, S.d);
    const cropCols = race === 0 ? [BP.leaf.c, BP.leaf.a, BP.thatch.b, BP.thatch.a] : race === 1 ? [hex('#6a4a78'), hex('#9a5ca8'), hex('#e8d0f0'), hex('#c48ad0')] : [hex('#3a9a58'), hex('#6ad080'), hex('#ff9ac8'), hex('#9ab8ff')];
    for (let row = 0; row < 4; row++) {
      const y = 6 + row * 2;
      for (let x = 2; x < 14; x += 2) {
        const o = (row & 1) ? 1 : 0, xx = x + o - (o && x > 12 ? 2 : 0);
        if (lv === 1) { b.set(xx, y, cropCols[1]); }
        else if (lv === 2) { b.set(xx, y, cropCols[0]); b.set(xx, y - 1, cropCols[1]); if (race !== 0) b.set(xx + 1, y, cropCols[0]); }
        else if (race === 0) { b.set(xx, y, cropCols[3]); b.set(xx, y - 1, cropCols[2]); b.set(xx + 1, y - 1, cropCols[3]); }
        else { b.set(xx, y, cropCols[1]); b.set(xx, y - 1, cropCols[2]); b.set(xx + 1, y, cropCols[3]); }
      }
    }
    if (race === 0) { const F = BP.wood; b.hline(1, 14, 14, F.b); for (let x = 1; x < 15; x += 4) b.vline(x, 12, 3, F.c); b.set(1, 11, F.b); b.set(14, 11, F.b); if (lv === 3) { b.vline(8, 2, 6, F.c); b.hline(6, 4, 5, F.c); b.rect(7, 2, 3, 2, BP.thatch.a); b.set(8, 1, BP.hide.a); } }
    else if (race === 1) { const F = BP.obone; for (let x = 1; x < 15; x += 3) { b.vline(x, 12, 3, F.a); b.set(x, 11, F.b); } b.hline(1, 14, 14, BP.plank.b); if (lv === 3) skull(b, 7, 3); }
    else { const F = BP.stone; b.hline(1, 14, 14, F.a); for (let x = 1; x < 15; x += 2) b.set(x, 14, F.b); b.hline(1, 13, 14, F.c); if (lv === 3) { b.set(13, 3, BP.leaf.b); b.set(13, 4, BP.leaf.a); b.set(12, 4, BP.leaf.a); b.set(13, 5, BP.leaf.c); } }
  }

  /* -------- scaffold (unfinished sites): stage 0 foundation + stakes, 1 poles + low walls, 2 high walls + roof beams -------- */
  function scaffoldOf(fin, type, race, stage) {
    const b = new Buf(TS, TS), bb = fin.bbox();
    const wood = race === 1 ? [hex('#8a6a48'), hex('#5a3e28'), hex('#a88458')] : race === 2 ? [hex('#d4c090'), hex('#8c7850'), hex('#e8dcb0')] : [hex('#d8b070'), hex('#8c6434'), hex('#f0cc90')];
    const dirt = [hex('#8a6c48'), hex('#6a5030'), hex('#a8845a')];
    const rope = hex('#e8dcc0'), stoneC = [hex('#a4a4b0'), hex('#76768a'), hex('#c8c8d4')];
    if (!bb) return b;
    const x0 = bb.x0, x1 = bb.x1, y1 = bb.y1, h = bb.h;
    if (type === Const.B.FARM) {
      for (let y = 6; y <= 13; y++) for (let x = 1; x <= 14; x++) b.set(x, y, stage === 0 ? (h2(x, y, 5) < 0.2 ? dirt[1] : dirt[0]) : ((y - 6) & 1) ? dirt[1] : dirt[0]);
      b.hline(1, 6, 14, dirt[2]); b.vline(1, 6, 8, dirt[2]);
      for (const p of [[1, 4], [14, 4], [1, 11], [14, 11]]) { b.vline(p[0], p[1], 4, wood[0]); b.set(p[0], p[1], wood[2]); }
      if (stage >= 1) { b.line(1, 5, 14, 5, wood[1]); b.hline(1, 12, 14, wood[1]); }
      if (stage >= 2) for (let x = 3; x < 14; x += 3) b.set(x, 8, hex('#8a8a50'));
      b.outline(); return b;
    }
    const ghost = rgba(190, 225, 255, stage === 0 ? 90 : 150);
    const ghostPass = (yTo) => {
      for (let y = bb.y0; y < yTo; y++) for (let x = x0; x <= x1; x++) {
        if ((fin.get(x, y) >>> 24) < 100) continue;
        const edge = (fin.get(x - 1, y) >>> 24) < 100 || (fin.get(x + 1, y) >>> 24) < 100 || (fin.get(x, y - 1) >>> 24) < 100;
        if (edge && ((x + y) & 1) === 0) b.set(x, y, ghost);
      }
    };
    if (stage === 0) {                                  // foundation: trench, stone footing, corner stakes with rope, material piles, shovel
      ghostPass(y1 - 3);
      const fx0 = x0 + 1, fx1 = x1 - 1;
      for (let y = y1 - 4; y <= y1; y++) for (let x = fx0; x <= fx1; x++) b.set(x, y, y === y1 - 4 ? dirt[2] : y === y1 ? dirt[2] : (h2(x, y, 9) < 0.25 ? dirt[2] : dirt[0]));
      for (let x = fx0 + 1; x < fx1; x++) { b.set(x, y1 - 3, dirt[1]); b.set(x, y1 - 2, dirt[1]); }
      for (let x = fx0; x <= fx1; x += 2) { b.set(x, y1 - 4, stoneC[(x >> 1) & 1]); b.set(x, y1 - 1, stoneC[2]); }
      for (const q of [[fx0, y1 - 4], [fx1, y1 - 4], [fx0, y1], [fx1, y1]]) { b.vline(q[0], q[1] - 3, 3, wood[0]); b.set(q[0], q[1] - 3, wood[2]); }
      b.hline(fx0 + 1, y1 - 7, Math.max(1, fx1 - fx0 - 1), rope); b.hline(fx0 + 1, y1 - 3, Math.max(1, fx1 - fx0 - 1), rope);
      b.hline(x1 - 3, y1 - 2, 3, wood[2]); b.hline(x1 - 3, y1 - 1, 3, wood[0]); b.hline(x1 - 2, y1 - 3, 2, wood[2]);
      b.set(x0 + 2, y1 - 2, stoneC[2]); b.set(x0 + 3, y1 - 2, stoneC[0]); b.set(x0 + 2, y1 - 1, stoneC[1]);
      b.vline(x0 + 4, y1 - 5, 4, wood[1]); b.set(x0 + 4, y1 - 5, stoneC[2]); b.set(x0 + 5, y1 - 5, stoneC[0]);   // shovel
      b.outline(); return b;
    }
    const frac = stage === 1 ? 0.4 : 0.74;
    const wallTop = y1 - Math.max(3, Math.round(h * frac)), top = Math.max(0, y1 - Math.round(h * 0.86));
    ghostPass(wallTop);
    for (let y = wallTop; y <= y1; y++) for (let x = x0; x <= x1; x++) { const c = fin.get(x, y); if ((c >>> 24) > 100) b.set(x, y, mix(c, dirt[0], stage === 1 ? 0.14 : 0.06)); }
    b.hline(x0 + 1, y1, Math.max(1, x1 - x0 - 1), dirt[1]); b.hline(x0, y1 - 1, x1 - x0 + 1, dirt[0]);
    const poles = [x0 + 1, (x0 + x1) >> 1, x1 - 1];
    for (const px of poles) { b.vline(px, top, y1 - top, wood[0]); b.set(px, top, wood[2]); }
    const py1 = top + Math.round((y1 - top) * 0.3), py2 = top + Math.round((y1 - top) * 0.62);
    b.hline(x0 + 1, py1, Math.max(1, x1 - x0 - 1), wood[1]); b.hline(x0 + 1, py2, Math.max(1, x1 - x0 - 1), wood[0]);
    b.line(x0 + 1, py2, poles[1], py1, wood[1]); b.line(x1 - 1, py2, poles[1], py1, wood[1]);
    if (stage === 2) { b.line(x0 + 1, py1, poles[1], top, wood[1]); b.line(x1 - 1, py1, poles[1], top, wood[1]); b.hline(x0 + 1, top + 1, Math.max(1, x1 - x0 - 1), wood[2]); }
    b.hline(x1 - 2, y1, 3, wood[2]); b.hline(x1 - 2, y1 - 1, 3, wood[0]);
    b.vline(x0 + 3, py2, y1 - py2, wood[2]); b.vline(x0 + 4, py2, y1 - py2, wood[2]);
    for (let y = py2 + 1; y < y1; y += 2) b.hline(x0 + 3, y, 2, wood[1]);
    const pc = race === 0 ? hex('#f4c430') : race === 1 ? hex('#e03030') : hex('#7fe08a');
    b.set(poles[1] + 1, top, pc); b.set(poles[1] + 2, top, pc); b.set(poles[1] + 1, top + 1, pc);
    b.outline();
    return b;
  }

  /* -------- damage / scorch: applied to the finished art before the outline -------- */
  function wreck(b, seed, mode) {
    const bb = b.bbox(); if (!bb) return;
    const W = b.w, d = b.d, r = rng(seed);
    const rg = (x, y) => (x >= 0 && y >= 0 && x < W && y < b.h) ? d[y * W + x] : 0, rs = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < b.h) d[y * W + x] = c; };
    const dark = rgba(30, 18, 14), ember = rgba(255, 138, 42), soot = rgba(24, 14, 12), ash = rgba(70, 58, 52);
    for (let i = 0; i < d.length; i++) { const c = d[i]; if ((c >>> 24) > 40) d[i] = mix(c, dark, mode === 2 ? 0.5 : 0.14); }
    if (mode === 2) {                                 // burnt out: char patches, glowing embers, ash heaps
      for (let y = bb.y0; y <= bb.y1; y++) for (let x = bb.x0; x <= bb.x1; x++) {
        if ((rg(x, y) >>> 24) < 40) continue;
        const n = h2(x, y, seed);
        if (n < 0.22) rs(x, y, soot); else if (n < 0.3) rs(x, y, ash);
      }
      for (let k = 0; k < 5; k++) { const x = bb.x0 + ((r() * bb.w) | 0), y = bb.y0 + (((0.35 + r() * 0.6) * bb.h) | 0); if ((rg(x, y) >>> 24) > 40) rs(x, y, k & 1 ? ember : rgba(255, 90, 24)); }
      return;
    }
    for (let k = 0; k < 3; k++) {                     // crumbled notches on the roofline
      const x = bb.x0 + 1 + ((r() * (bb.w - 2)) | 0);
      for (let y = bb.y0; y <= bb.y1; y++) if ((rg(x, y) >>> 24) > 40) { rs(x, y, 0); rs(x + (k & 1 ? 1 : -1), y, 0); if (r() < 0.6) rs(x, y + 1, soot); break; }
    }
    for (let k = 0; k < 3; k++) {                     // scorch blotches with a hot ember
      const x = bb.x0 + 1 + ((r() * (bb.w - 3)) | 0), y = bb.y0 + 2 + ((r() * (bb.h - 4)) | 0);
      if ((rg(x, y) >>> 24) < 40) continue;
      rs(x, y, soot); rs(x + 1, y, soot); rs(x, y + 1, soot);
      if (r() < 0.7) rs(x + 1, y + 1, ember);
    }
    const cx = bb.x0 + 2 + ((r() * Math.max(1, bb.w - 5)) | 0), cy = bb.y0 + Math.max(2, bb.h >> 2);     // a crack
    for (let k = 0; k < 4; k++) if ((rg(cx + (k >> 1), cy + k) >>> 24) > 40) rs(cx + (k >> 1), cy + k, soot);
  }

  /* -------- landmarks: finished TOWNHALL / TEMPLE (level >= 2) and BARRACKS (level 3) grow 8 px taller (16x24, same footing) -------- */
  const TALLROWS = 8;
  function clearRect(b, x, y, w, h) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) b.set(i, j, 0); }
  function goldDome(b, cx, cy, rx, ry, G) {
    for (let y = Math.floor(cy - ry) - 1; y <= cy; y++) for (let x = Math.floor(cx - rx) - 1; x <= Math.ceil(cx + rx) + 1; x++) {
      const nx = (x - cx) / (rx + 0.4), ny = (y - cy) / (ry + 0.4);
      if (nx * nx + ny * ny > 1) continue;
      const li = -(nx * 0.6 + ny * 0.8);
      b.set(x, y, li > 0.62 ? G.b : li > 0.0 ? G.a : G.c);
    }
  }
  function topHumanHall(b, tc) {
    const S = BP.stone, R = BP.roof, G = BP.gold, W = BP.wood;
    clearRect(b, 4, -8, 12, 11);
    b.set(11, 3, R.c); b.set(11, 4, R.a);
    b.rect(6, -3, 4, 6, S.a); b.vline(6, -3, 6, S.b); b.vline(9, -3, 6, S.c);
    b.hline(6, 1, 4, S.c); b.hline(5, -4, 6, S.c); b.hline(5, -3, 6, S.b);
    b.rect(7, -2, 2, 3, S.d); b.set(7, -2, G.c); b.set(8, -2, G.c); b.set(7, -1, G.a); b.set(8, -1, G.b); b.set(8, 0, G.c);
    trap(b, -7, -4, 7, 8, 5, 10, roofFn(R));
    b.set(7, -8, G.b); b.set(8, -8, G.a);
    b.vline(11, -7, 5, W.d); b.rect(12, -7, 3, 2, tc); b.set(12, -7, lt(tc, 0.4)); b.set(13, -7, lt(tc, 0.3)); b.set(14, -5, tc); b.set(13, -5, dk(tc, 0.7));
  }
  function topHumanTemple(b) {
    const M = BP.marble, G = BP.gold;
    clearRect(b, 5, -8, 6, 11);
    b.rect(5, 0, 6, 3, M.a); b.vline(5, 0, 3, M.b); b.vline(10, 0, 3, M.c); b.set(7, 1, hex('#5a4a78')); b.set(8, 1, hex('#5a4a78')); b.set(6, 2, M.c); b.set(9, 2, M.c);
    b.hline(4, 0, 8, M.c); b.hline(4, -1, 8, G.a);
    goldDome(b, 7.5, -1, 4.6, 5.6, G);
    b.vline(7, -8, 3, G.c); b.set(8, -8, G.b); b.set(7, -8, G.a); b.set(6, -4, G.b);
    for (const x of [4, 11]) b.set(x, -2, G.b);
  }
  function topHumanBarracks(b, tc) {
    const S = BP.stone, K = { a: tc, b: lt(tc, 0.35), c: dk(tc, 0.6) };
    for (const x0 of [0, 13]) {
      clearRect(b, x0, -8, 3, 10);
      b.rect(x0, -2, 3, 4, S.a); b.vline(x0, -2, 4, S.b); b.vline(x0 + 2, -2, 4, S.c); b.set(x0 + 1, 0, S.d); b.set(x0 + 1, -1, S.d);
      b.hline(x0, -3, 3, S.c);
      trap(b, -7, -4, x0 + 1, x0 + 1, x0, x0 + 2, roofFn(K));
      b.set(x0 + 1, -8, BP.gold.a);
    }
    b.hline(3, -1, 10, BP.wood.d); b.hline(3, 0, 10, BP.wood.c);                         // bridge-walk between the towers
    banner(b, 6, -6, 4, tc, BP.wood.c);
  }
  function topOrcHall(b, tc) {
    const B = BP.obone, Pk = BP.plank, H = BP.hide;
    clearRect(b, 3, -8, 10, 10);
    b.vline(7, -2, 4, Pk.b); b.vline(8, -2, 4, Pk.a);
    b.art(['.bbbb.', 'BBBBBB', 'BkBBkB', 'BBBBBB', '.BccB.', '..kk..'], { b: B.b, B: B.a, c: B.c, k: H.d }, 5, -8);
    b.line(5, -7, 2, -8, B.a); b.line(10, -7, 13, -8, B.a); b.set(2, -7, B.b); b.set(13, -7, B.b);
    b.rect(9, -3, 5, 3, tc); b.hline(9, -3, 5, lt(tc, 0.35)); b.set(9, 0, tc); b.set(11, 0, tc); b.set(13, 0, tc); b.set(10, -1, dk(tc, 0.7)); b.set(12, -1, dk(tc, 0.7));
    b.set(7, -9 + 1, FLAME[2]);
  }
  function topOrcTemple(b) {
    const B = BP.obone, Pk = BP.plank, H = BP.hide;
    clearRect(b, 4, -8, 8, 11);
    b.vline(7, -2, 4, Pk.a); b.vline(8, -2, 4, Pk.c);
    b.art(['.bbbb.', 'BBBBBB', 'BkBBkB', 'BBBBBB', '.BccB.', '..kk..'], { b: B.b, B: B.a, c: B.c, k: H.d }, 5, -5);
    b.set(6, -4, FLAME[1]); b.set(9, -4, FLAME[1]);
    for (let i = 0; i < 3; i++) { b.set(5 + i * 2, -7 - (i & 1), FLAME[i % 2 ? 0 : 1]); b.set(6 + i * 2, -6, FLAME[2]); b.set(5 + i * 2, -6, FLAME[0]); }
    b.set(7, -8, FLAME[2]); b.set(8, -7, FLAME[2]);
  }
  function topOrcBarracks(b, tc) {
    const Pk = BP.plank, B = BP.obone;
    clearRect(b, 6, -8, 6, 14);
    for (const x of [8, 10]) { b.set(x, 5, Pk.b); b.set(x, 4, B.a); }
    b.rect(8, 1, 3, 3, Pk.a); b.rect(7, 4, 5, 1, Pk.c);
    b.vline(7, -8, 12, Pk.d); b.vline(8, -8, 3, Pk.b);
    b.rect(9, -8, 5, 5, tc); b.hline(9, -8, 5, lt(tc, 0.35)); b.set(9, -3, tc); b.set(11, -3, tc); b.set(13, -3, tc); b.set(10, -4, dk(tc, 0.7)); b.set(12, -4, dk(tc, 0.7));
    b.rect(11, -7, 1, 2, B.a); b.set(11, -6, BP.hide.d);
  }
  function topElfHall(b, tc) {              // a second, higher crown with a white spire and a pennant
    const M = BP.marble, G = BP.glow, W = BP.ewhite, Bk = BP.bark;
    clearRect(b, 4, -8, 12, 12);
    b.set(11, 3, BP.leaf.a); b.set(11, 4, BP.leaf.c);
    b.rect(6, 0, 4, 4, Bk.a); b.vline(6, 0, 4, Bk.b); b.vline(9, 0, 4, Bk.c);               // trunk between the crowns
    leafDome(b, 3, 1.5, 3.4, 2.6, 61); leafDome(b, 12.5, 1.5, 3.4, 2.6, 62);
    leafDome(b, 8, -2.6, 5.6, 4.4, 63);
    b.rect(7, -8, 2, 4, M.a); b.vline(7, -8, 4, M.b); b.set(8, -9 + 1, G.b); b.set(7, -8, G.b);       // white spire poking out of the canopy
    b.set(5, -1, G.b); b.set(11, -2, G.b); b.set(7, 1, G.c); b.set(9, 2, G.b);
    b.vline(12, -8, 5, Bk.d); b.rect(13, -8, 2, 2, tc); b.set(13, -8, lt(tc, 0.4)); b.set(14, -7, dk(tc, 0.7));
  }
  function topElfTemple(b) {
    const C = BP.crystal, W = BP.ewhite, G = BP.glow;
    clearRect(b, 5, -8, 6, 11);
    trap(b, -8, -2, 7, 8, 5, 10, (x, y, l, r, t) => (l === 0 ? C.b : r === 0 ? C.c : t < 0.35 ? C.b : C.a));
    trap(b, -1, 3, 5, 10, 6, 9, (x, y, l, r, t) => (l === 0 ? C.b : r === 0 ? C.c : C.a));
    b.vline(7, -7, 9, C.b); b.set(6, -4, C.d); b.set(9, -5, C.d); b.set(8, -8, W.b);
    b.set(4, -3, G.b); b.set(11, -1, G.b); b.set(3, 0, G.c); b.set(12, -4, G.c);
  }
  function topElfBarracks(b, tc) {           // canopy tier with a lookout hut and a tall banner
    const Bk = BP.bark, G = BP.glow, L = BP.leaf;
    leafDome(b, 8, -1.2, 6.6, 3.6, 71);
    b.rect(6, -5, 4, 3, Bk.a); b.vline(6, -5, 3, Bk.b); b.vline(9, -5, 3, Bk.c); b.rect(7, -4, 2, 2, G.a); b.set(7, -4, G.b);
    leafDome(b, 8, -6.2, 3.6, 2.2, 72);
    b.vline(12, -8, 8, Bk.d); b.rect(13, -8, 3, 4, tc); b.hline(13, -8, 3, lt(tc, 0.35)); b.set(13, -4, tc); b.set(15, -4, tc); b.set(14, -5, dk(tc, 0.7));
    b.set(4, -2, L.e); b.set(11, -1, L.e);
  }
  const TOP = {};
  TOP[Const.B.TOWNHALL * 3] = topHumanHall; TOP[Const.B.TOWNHALL * 3 + 1] = topOrcHall; TOP[Const.B.TOWNHALL * 3 + 2] = topElfHall;
  TOP[Const.B.TEMPLE * 3] = topHumanTemple; TOP[Const.B.TEMPLE * 3 + 1] = topOrcTemple; TOP[Const.B.TEMPLE * 3 + 2] = topElfTemple;
  TOP[Const.B.BARRACKS * 3] = topHumanBarracks; TOP[Const.B.BARRACKS * 3 + 1] = topOrcBarracks; TOP[Const.B.BARRACKS * 3 + 2] = topElfBarracks;
  function hasLandmark(type, lv) { return (type === Const.B.TOWNHALL || type === Const.B.TEMPLE) ? lv >= 2 : type === Const.B.BARRACKS ? lv >= 3 : false; }

  const bldCache = new Map(), lmCache = new Map();
  function drawBase(b, type, race, lv, tc) {
    const B = Const.B;
    switch (type) {
      case B.HOUSE: race === 0 ? humanHouse(b, lv) : race === 1 ? orcHouse(b, lv) : elfHouse(b, lv); break;
      case B.FARM: farm(b, race, lv); break;
      case B.STORAGE: race === 0 ? humanStorage(b, lv) : race === 1 ? orcStorage(b, lv) : elfStorage(b, lv); break;
      case B.BARRACKS: race === 0 ? humanBarracks(b, lv, tc) : race === 1 ? orcBarracks(b, lv, tc) : elfBarracks(b, lv, tc); break;
      case B.TOWNHALL: race === 0 ? humanTownhall(b, lv, tc) : race === 1 ? orcTownhall(b, lv, tc) : elfTownhall(b, lv, tc); break;
      case B.TEMPLE: race === 0 ? humanTemple(b, lv) : race === 1 ? orcTemple(b, lv) : elfTemple(b, lv); break;
      case B.MARKET: race === 0 ? humanMarket(b, lv, tc) : race === 1 ? orcMarket(b, lv, tc) : elfMarket(b, lv, tc); break;
      default: b.rect(4, 6, 8, 8, BP.wood.a); b.hline(3, 5, 10, BP.roof.a); break;
    }
  }
  function buildBuilding(type, race, lv, done, T, mode, tall, vr) {
    const B = Const.B, tc = tintOf(T ? hex(T) : null, race);
    const b = tall ? new Buf(TS, TS + TALLROWS, TALLROWS) : new Buf(TS, TS);
    const V = vr ? BVAR[vr] : null, sv = V ? { roof: BP.roof, thatch: BP.thatch, hide: BP.hide, leaf: BP.leaf } : null;
    if (V) { BP.roof = V.roof; BP.thatch = V.thatch; BP.hide = V.hide; BP.leaf = V.leaf; }
    try { drawBase(b, type, race, lv, tc); } finally { if (sv) { BP.roof = sv.roof; BP.thatch = sv.thatch; BP.hide = sv.hide; BP.leaf = sv.leaf; } }
    if (tall) { const f = TOP[type * 3 + race]; if (f) f(b, tc); }
    if (!done) {
      const fin = new Buf(TS, TS); fin.d.set(b.d);
      fin.outline();
      return scaffoldOf(type === B.FARM ? b : fin, type, race, mode);
    }
    if (mode) wreck(b, type * 131 + race * 17 + lv * 5 + mode, mode);
    b.outline();
    if (type !== B.FARM) { const bb = b.bbox(); if (bb) groundShadow(b, (bb.x0 + bb.x1) >> 1, 15, Math.max(3, (bb.w >> 1) - 1), 60); }
    return b;
  }
  function tintKey(tint) {
    if (!tint) return 0;
    let tid = tintIds.get(tint); if (tid === undefined) { tid = ++tintCount; tintIds.set(tint, tid); }
    return tid;
  }
  /** mode: finished -> 0 normal, 1 damaged, 2 burnt/scorched ; unfinished -> construction stage 0 foundation, 1 frame, 2 roofing */
  function building(type, race, level, done, tint, mode, variant) {
    let lv = level | 0; lv = lv < 1 ? 1 : lv > 3 ? 3 : lv;
    const r = race === 1 ? 1 : race === 2 ? 2 : 0, t = type | 0;
    let m = mode | 0; m = m < 0 ? 0 : m > 2 ? 2 : m;
    const tid = tintKey(tint);
    let vr = variant | 0; vr = (t === Const.B.HOUSE || t === Const.B.MARKET) && vr > 0 ? (vr === 1 ? 1 : 2) : 0;
    const key = (((((((tid * 3 + r) * 3 + (lv - 1)) * 2 + (done === false ? 0 : 1)) * 16) + t) * 3) + m) * 3 + vr;
    let c = bldCache.get(key);
    if (c !== undefined) return c;
    c = buildBuilding(t, r, lv, done !== false, tint, m, false, vr).toCanvas();
    bldCache.set(key, c);
    return c;
  }
  /** taller (16x24) sprite for landmark buildings, null when the type / level has none or the building is unfinished. Same footing as building(). */
  function landmark(type, race, level, tint, mode) {
    let lv = level | 0; lv = lv < 1 ? 1 : lv > 3 ? 3 : lv;
    const t = type | 0;
    if (!hasLandmark(t, lv)) return null;
    const r = race === 1 ? 1 : race === 2 ? 2 : 0;
    let m = mode | 0; m = m < 0 ? 0 : m > 2 ? 2 : m;
    const key = ((((tintKey(tint) * 3 + r) * 3 + (lv - 1)) * 16) + t) * 3 + m;
    let c = lmCache.get(key);
    if (c !== undefined) return c;
    c = buildBuilding(t, r, lv, true, tint, m, true).toCanvas();
    lmCache.set(key, c);
    return c;
  }

  /* ===============================================================
   * FLAGS — pattern 0..5 x symbol 0..9, colours c1 (field) c2 (secondary) c3 (symbol)
   * =============================================================== */
  const GLYPH = [
    ['...#...', '..###..', '#######', '.#####.', '..###..', '.##.##.', '.#...#.'],            // 0 star
    ['#..#..#', '##.#.##', '#######', '#######', '#######', '.......', '.......'],            // 1 crown
    ['...#...', '...#...', '...#...', '...#...', '.#####.', '...#...', '...#...'],            // 2 sword
    ['..####.', '.##....', '##.....', '##.....', '##.....', '.##....', '..####.'],            // 3 moon
    ['...#...', '.#.#.#.', '..###..', '#######', '..###..', '.#.#.#.', '...#...'],            // 4 sun
    ['...#...', '..###..', '.#####.', '..###..', '.#####.', '#######', '...#...'],            // 5 tree
    ['.#####.', '#######', '##.#.##', '#######', '.#####.', '.#.#.#.', '.......'],            // 6 skull
    ['#.....#', '##...##', '#######', '##.#.##', '.#####.', '..###..', '...#...'],            // 7 wolf
    ['.#####.', '.#####.', '...#...', '...#...', '...#...', '...#...', '...#...'],            // 8 hammer
    ['#.#.#.#', '#######', '.#####.', '.##.##.', '.#####.', '.#...#.', '.#...#.'],            // 9 tower
  ];
  // 5x5 glyphs for small flags (<= 10 logical rows): hand-drawn so they stay legible instead of down-sampling the 7x7 ones
  const MINI = [
    ['..#..', '#####', '.###.', '.#.#.', '#...#'], ['#.#.#', '#####', '#####', '#####', '.....'], ['..#..', '..#..', '#####', '..#..', '..#..'], ['.###.', '#....', '#....', '#....', '.###.'], ['#.#.#', '.###.', '#####', '.###.', '#.#.#'],
    ['..#..', '.###.', '#####', '..#..', '..#..'], ['.###.', '#####', '#.#.#', '.###.', '.#.#.'], ['#...#', '##.##', '#####', '.###.', '..#..'], ['#####', '#####', '..#..', '..#..', '..#..'], ['#.#.#', '#####', '.###.', '.###.', '#####'],
  ];
  const flagWeak = new WeakMap();
  const DEF_FLAG = { pattern: 0, symbol: 0, c1: '#c0392b', c2: '#f4f4f4', c3: '#ffd54f' };
  function buildFlag(flag, w, h) {
    const s = Math.max(1, Math.round(Math.min(w / 16, h / 10))), LW = Math.max(6, Math.round(w / s)), LH = Math.max(6, Math.round(h / s));
    const b = new Buf(LW, LH);
    const c1 = hex(flag.c1), c2 = hex(flag.c2), c3 = hex(flag.c3), pat = (flag.pattern | 0) % 6, sym = (flag.symbol | 0) % 10;
    const bw = Math.max(1, Math.round(LH / 6));                 // bar width
    for (let y = 0; y < LH; y++) for (let x = 0; x < LW; x++) {
      let c = c1;
      const fx = (x + 0.5) / LW, fy = (y + 0.5) / LH;
      if (pat === 1) c = fx >= 0.5 ? c2 : c1;
      else if (pat === 2) c = fy >= 1 / 3 && fy < 2 / 3 ? c2 : c1;
      else if (pat === 3) { const vx = Math.round(LW * 0.32 - bw / 2); c = (x >= vx && x < vx + bw) || (y >= Math.round((LH - bw) / 2) && y < Math.round((LH - bw) / 2) + bw) ? c2 : c1; }
      else if (pat === 4) c = fx + fy < 1 ? c1 : c2;
      else if (pat === 5) c = fx < 0.5 * (1 - Math.abs(fy - 0.5) * 2) + 0.02 ? c2 : c1;
      b.d[y * LW + x] = c;
    }
    // symbol with a dark rim so it never vanishes into the field
    const mini = LH <= 9 || (LH <= 10 && s === 1), g = mini ? MINI[sym] : GLYPH[sym], gs = mini ? 5 : Math.max(5, Math.min(7, LH - 3)), mask = new Buf(LW, LH);
    let cx = Math.round(LW / 2), cy = Math.round(LH / 2);
    if (pat === 3) cx = Math.round(LW * 0.32 + (bw & 1 ? 0.5 : 0));
    if (pat === 5) cx = Math.round(LW * 0.55);
    const ox = cx - (gs >> 1), oy = cy - (gs >> 1);
    for (let gy = 0; gy < gs; gy++) for (let gx = 0; gx < gs; gx++) {
      const sx = mini ? gx : Math.min(6, Math.floor(gx * 7 / gs)), sy = mini ? gy : Math.min(6, Math.floor(gy * 7 / gs));
      if (g[sy][sx] === '#') mask.set(ox + gx, oy + gy, c3);
    }
    mask.outline(rgba(cr(c3) * 0.22 + 6, cg(c3) * 0.22 + 6, cb(c3) * 0.22 + 10, 235));
    b.over(mask, 0, 0);
    // border + cloth shading
    const bd = rgba(24, 18, 30);
    for (let x = 0; x < LW; x++) { b.set(x, 0, bd); b.set(x, LH - 1, bd); }
    for (let y = 0; y < LH; y++) { b.set(0, y, bd); b.set(LW - 1, y, bd); }
    for (let y = 1; y < LH - 1; y++) { const c = b.get(LW - 2, y); if (c) b.set(LW - 2, y, mix(c, BLACK, 0.18)); const c0 = b.get(1, y); if (c0) b.set(1, y, mix(c0, WHITE, 0.14)); }
    const cv = b.toCanvas();
    return (LW === w && LH === h) ? cv : scaleNN(cv, w, h);
  }
  function flag(f, w, h) {
    f = f || DEF_FLAG;
    w = Math.max(6, w | 0 || 32); h = Math.max(6, h | 0 || 20);
    let e = flagWeak.get(f);
    if (e === undefined || e.p !== f.pattern || e.s !== f.symbol || e.a !== f.c1 || e.b !== f.c2 || e.c !== f.c3) {
      e = { p: f.pattern, s: f.symbol, a: f.c1, b: f.c2, c: f.c3, m: new Map() };
      flagWeak.set(f, e);
    }
    const k = w * 4096 + h;
    let c = e.m.get(k);
    if (c === undefined) { c = buildFlag(f, w, h); e.m.set(k, c); }
    return c;
  }

  /* ===============================================================
   * ICONS — drawn on a 16x16 grid (glyph <= 14x14 + 1px outline) and nearest-neighbour scaled
   * =============================================================== */
  const IP = pal({
    k: '#1c1420', w: '#ffffff', W: '#e2e6ee', g: '#aab2c4', G: '#6a7388',
    r: '#ee4a44', R: '#a82426', o: '#ff9a30', O: '#c4621c', y: '#ffd83c', Y: '#c99a1a',
    l: '#94e468', e: '#44ae48', E: '#26703a', c: '#66dcf4', b: '#3f86e8', B: '#2554a8', s: '#a8dcff',
    p: '#b058e8', P: '#6e2eae', m: '#ff80c4', n: '#94603a', N: '#5e3a20', t: '#dcbc7c', T: '#a98a52',
    f: '#f4cca6', F: '#d4a07c', h: '#7a4a28', H: '#e8c64a', d: '#2e2a3a', z: '#8de8c8', u: '#d8b0ff',
  });
  const ICON_OUT = rgba(22, 16, 30);

  function tri(b, x, y, w, h, c) {           // right-pointing triangle
    for (let j = 0; j < h; j++) {
      const t = 1 - Math.abs((j + 0.5) / h * 2 - 1), len = Math.max(1, Math.round(w * t));
      b.hline(x, y + j, len, c);
    }
  }
  function thick(b, x0, y0, x1, y1, c, c2) { b.line(x0, y0, x1, y1, c); if (c2 !== undefined) b.line(x0 + 1, y0, x1 + 1, y1, c2); }
  function ring(b, cx, cy, r0, r1, c) { for (let y = Math.floor(cy - r1); y <= Math.ceil(cy + r1); y++) for (let x = Math.floor(cx - r1); x <= Math.ceil(cx + r1); x++) { const d = Math.hypot(x - cx, y - cy); if (d <= r1 && d >= r0) b.set(x, y, c); } }
  function shadeDisc(b, cx, cy, r, c, hi, lo) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const dx = x - cx, dy = y - cy; if (dx * dx + dy * dy > r * r + 0.3) continue;
      const li = -(dx * 0.6 + dy * 0.8) / r; b.set(x, y, li > 0.45 ? hi : li < -0.35 ? lo : c);
    }
  }

  const ICONS = {
    // ---- terrain tools ----
    bell: ['.....yy.....', '....yyyy....', '...yywyyY...', '...ywyyyY...', '..yywyyyyY..', '..ywyyyyyY..', '..ywyyyyyY..', '.yywyyyyyyY.', '.ywyyyyyyyY.', 'yyyyyyyyyyYY', 'YYYYYYYYYYYY', '....oooo....', '.....oo.....'],
    crown: ['y.....y.....y', 'yy...yyy...yy', 'yyy.yyyyy.yyy', 'yyyyyyyyyyyyy', 'yYyyyyyyyyyYy', 'yyrYyybYyyYryy'.slice(0, 13), 'yYyYyYyYyYyYy', 'YYYYYYYYYYYYY'],
    raise: ['......yy......', '.....yyyy.....', '....yyyyyy....', '...yyyyyyyy...', '......yy......', '......yy......', '......yy......', '....llllll....', '..lleeeeeell..', '.leeeeeeeeeel.', 'nnnnnnnnnnnnnn', 'nNnnnNnnnnNnnn'],
    lower: ['......yy......', '......yy......', '......yy......', '...yyyyyyyy...', '....yyyyyy....', '.....yyyy.....', 'llllleeeelllll', 'eeeeebbbbeeeee', 'nnnnnbsbbnnnnn', 'nNnnnbbbbnNnnn'],
    grass: ['..............', '......l.......', '..l...le..l...', '..le..le..le..', '.llee.lee.lee.', '.leeelleeleeee', '.leEeelEeeEeel', 'eeEeeeeEeeeEee', 'EeeeeeeeeeeeeE', 'nnnnnnnnnnnnnn', 'nNnnnNnnnnNnnn'],
    sand: ['..............', '......yy......', '.....yttt.....', '....yttttT....', '...yttttttT...', '..yttttttttT..', '.yttTttttTttT.', 'ytttttTtttttTT', 'tTtttttttTtttT', 'TTTTTTTTTTTTTT'],
    hill: ['..............', '.....llll.....', '...llleeell...', '..lleeeeeeel..', '.lleeeeeeeeeel', '.leeeeeEeeeeEl', 'leeeeeeeeeEeee', 'eeeEeeeeeeeeEe', 'nnnnnnnnnnnnnn', 'nNnnnnNnnnnnNn'],
    mountain: ['.......ww.....', '......wWWw....', '.....wWgWWw...', '....WgGgggWg..', '...WgGGgggGGg.', '..WgGGGgGGGGGg', '.WgGGGGgGGGGGG', 'WgGGGGGGGGGGGG', 'GGGGGGGGGGGGGG'],
    snow: ['.......ww.....', '...w...ww..w..', '....w..ww.w...', '.....w.ww.w...', '..w..w.ww.w.w.', '...w.wsws.w...', '.wwwwwswswwwww', '...w.wsws.w...', '..w..w.ww.w.w.', '....w..ww.w...', '...w...ww..w..', '.......ww.....'],
    lava: ['.....y........', '....yoy...y...', '...yooy..yoy..', '..yoooyy.yoy..', '..yoorooyooy..', '.yoorrroooory.', '.orrrRrrrrrro.', 'orrrRRrrRRrroo', 'orRRrrrRrrRRro', '.oRRRRRRRRRRo.', '..ooRRRRRRoo..'],
    // ---- creatures (heads) ----
    human: ['....hhhhhh....', '...hhhhhhhh...', '..hhhhhhhhhh..', '..hhfffffffh..', '..hfffffffffh.', '..ffkfffkfff..', '..ffkfffkfff..', '..ffffffFfff..', '...fffmmffff..', '....ffffffff..', '....FFFFFFF...', '..bbbbbbbbbb..', '.bbbbbbbbbbbb.'],
    orc: ['......dd......', '.....dddd.....', '....eeeeee....', '...eeeeeeee...', '..eeEEeeEEee..', '..eeykeeykee..', '..eeeeeeeeee..', '..eeeeEEeeee..', '..eewweewwee..', '..eewEEEEwee..', '...eeEEEEee...', '....eeeeee....', '..nnnnnnnnnn..'],
    elf: ['....HHHHHH....', '...HHHHHHHH...', 'f.HHHHHHHHHH.f', 'ff.HfffffffH.ff', '.fHffkfffkfHf.', '..HfffffffffH.', '..HHffffmffHH.', '..HHfffffffHH.', '..HH.fffff.HH.', '..H..ggggg..H.', '.....gggggg...', '....gggggggg..'],
    erase: ['..........rrrr.', '.........rrrrrR', '........rrrrrRR', '.......rrrrrRR.', '......wrrrrRR..', '.....wwwrrRR...', '....wWWwwRR....', '...bwWWwwb.....', '..bbwWWwb......', '.bbbbwwwb......', '..bbbbbb.......', '...bbbb........'],
    // ---- powers ----
    lightning: ['......yyyyy...', '.....yyyyy....', '....yyyyy.....', '...yyyyy......', '..yyyyyyyyy...', '.....yyyyy....', '....yyyyy.....', '...yyyy.......', '...yyy........', '..yy..........', '..y...........'],
    meteor: ['y.............', 'oy............', '.oyy..........', '..ooyy........', '...ooyyGGGg...', '....oyGgGGGGg.', '.....yGgggGGGg', '......GGgggGGG', '.......GGGGGGG', '........GGGGG.'],
    fire: ['......o.......', '.....oo.o.....', '.....ooo.o....', '....ooyoo.....', '...oooyyoo.o..', '...ooyyyyoo...', '..ooyyyyyyoo..', '..ooyyywyyoo..', '..ooyyyyyyoo..', '...ooyyyyoo...', '....oooooo....'],
    earthquake: ['...y.....y....', '....y.y.......', '..y......y.y..', 'nnnnnn...nnnnn', 'nNnnnN..nnNnnn', 'nnnNn..k.nnnnn', '......kk......', '.....kk.......', 'nnnNnnk.nNnnnn', 'nnNnnnnk.nnNnn', 'nnnnnNnnnnnnnn'],
    plague: ['....pppp......', '..ppuupppp....', '.ppuuupppppp..', 'pppuuppppppppp', 'ppppppeeeepppp', '.pppeellleepp.', '..ppeleleepp..', '...ppeeeepp...', '....pppppp....', '..eeee..ee..e.', '.eleeee.eee.ee', '..eeee..ee..e.'],
    tornado: ['gggggggggggggg', '.GGGGGGGGGGGG.', '..gggggggggg..', '...GGGGGGGG...', '....gggggg....', '.....GGGG.....', '......ggg.....', '.....GGG......', '......gg......', '.....GG..y....', '......g.y.....'],
    rain: ['....gggg......', '..ggggggg.g...', '.ggggggggggg..', 'gggggggggggggg', 'GGGGGGGGGGGGGG', '..b..b..b..b..', '.bs.bs.bs.bs..', '..b..b..b..b..', 'b..b..b..b..b.', '.b..b..b..b...'],
    bless: ['......y.......', '......y.......', '..y...y...y...', '...y..y..y....', '....yyyyy.....', '.....yyy......', 'yyyyyywyyyyyyy', '.....yyy......', '....yyyyy.....', '...y..y..y....', '..y...y...y...', '......y.......', '......y.......'],
  };
  // helper-based icons (functions) ----------------------------------------------------------
  const IFN = {
    split(b) {
      const wl = IP.t, wd = IP.T, rf = IP.r, rd = IP.R;
      // left half of a house
      for (let y = 7; y <= 13; y++) for (let x = 2; x <= 7 - (y > 9 ? 1 : 0); x++) b.set(x, y, y === 7 ? wd : wl);
      trap(b, 3, 6, 6, 6, 1, 7, (x, y, l) => (l === 0 ? IP.o : rf)); b.vline(7, 3, 4, rd);
      // right half shifted down-right
      for (let y = 9; y <= 14; y++) for (let x = 9; x <= 14; x++) b.set(x, y, y === 9 ? wd : wl);
      trap(b, 5, 8, 9, 10, 9, 15, (x, y, l) => (l === 0 ? IP.o : rf));
      b.rect(11, 11, 2, 3, IP.N);
      b.line(8, 2, 8, 6, IP.y); b.line(8, 6, 9, 8, IP.y); b.line(9, 8, 8, 10, IP.y); b.line(8, 10, 9, 13, IP.y);
      b.set(7, 8, IP.k); b.set(8, 9, IP.k);
    },
    inspect(b) {
      ring(b, 6, 6, 3.2, 5.2, IP.g); shadeDisc(b, 6, 6, 3.2, IP.s, IP.w, IP.c);
      ring(b, 6, 6, 4.4, 5.4, IP.W);
      b.set(4, 4, IP.w); b.set(5, 4, IP.w); b.set(4, 5, IP.w);
      b.line(10, 10, 13, 13, IP.n); b.line(11, 10, 14, 13, IP.N); b.line(9, 9, 10, 10, IP.G);
    },
    tab_land(b) {
      shadeDisc(b, 11, 4, 2, IP.y, IP.w, IP.o);
      for (let y = 5; y <= 12; y++) { const hw = y - 4; for (let x = -hw; x <= hw; x++) { const px = 5 + x; b.set(px, y, x < 0 ? IP.g : x === 0 ? IP.W : IP.G); } }
      b.set(5, 5, IP.w); b.set(4, 6, IP.w); b.set(5, 6, IP.w); b.set(6, 6, IP.W);
      b.rect(0, 12, 14, 2, IP.e); b.hline(0, 12, 14, IP.l); b.rect(0, 14, 14, 1, IP.n);
    },
    tab_life(b) {
      b.disc(5, 5, 2.6, IP.f); b.hline(3, 3, 5, IP.h); b.hline(3, 2, 4, IP.h); b.vline(2, 3, 2, IP.h);
      b.set(4, 5, IP.k); b.set(6, 5, IP.k);
      b.rect(2, 8, 7, 6, IP.b); b.rect(1, 8, 1, 4, IP.f); b.rect(9, 8, 1, 4, IP.f); b.vline(2, 8, 6, IP.s);
      b.disc(11, 8, 2.2, IP.e); b.set(10, 8, IP.k); b.set(12, 8, IP.k); b.set(10, 10, IP.w); b.set(12, 10, IP.w);
      b.rect(9, 11, 5, 4, IP.n);
    },
    tab_powers(b) {
      shadeDisc(b, 7, 7, 6, IP.p, IP.u, IP.P);
      const bolt = ['.....yy', '....yy.', '...yyyy', '..yyyy.', '....yy.', '...yy..', '..y....'];
      b.art(bolt.map(r => r.padEnd(8, '.')), IP, 5, 3);
    },
    tab_kingdoms(b) {
      b.rect(2, 8, 11, 6, IP.g); b.vline(2, 8, 6, IP.W); b.vline(12, 8, 6, IP.G);
      for (const x of [2, 5, 8, 11]) b.rect(x, 6, 2, 2, IP.g);
      b.rect(0, 4, 3, 10, IP.W); b.rect(12, 4, 3, 10, IP.W); b.vline(14, 4, 10, IP.g);
      b.rect(0, 2, 3, 2, IP.g); b.rect(12, 2, 3, 2, IP.g);
      b.vline(1, 0, 2, IP.N); b.rect(2, 0, 2, 1, IP.r);
      b.rect(6, 10, 3, 4, IP.N); b.set(6, 10, IP.n); b.rect(4, 8, 1, 2, IP.c); b.rect(10, 8, 1, 2, IP.c);
    },
    tab_info(b) {
      shadeDisc(b, 7, 7, 6.2, IP.b, IP.s, IP.B);
      b.rect(6, 6, 3, 6, IP.w); b.rect(6, 3, 3, 2, IP.w);
    },
    help(b) {                                  // blue badge with a white question mark
      shadeDisc(b, 7, 7, 6.4, IP.b, IP.s, IP.B);
      b.art(['.www.', 'ww.ww', 'w...w', '....w', '...ww', '..ww.', '..w..', '.....', '..w..'], IP, 5, 3);
      b.set(5, 4, IP.W); b.set(9, 5, IP.W);
    },
    target(b) {                                // red crosshair (attack target)
      ring(b, 7, 7, 3.6, 5.6, IP.r); ring(b, 7, 7, 3.6, 4.3, IP.R); ring(b, 7, 7, 5.0, 5.6, IP.o);
      b.rect(6, 0, 2, 4, IP.r); b.rect(6, 11, 2, 4, IP.r); b.rect(0, 6, 4, 2, IP.r); b.rect(11, 6, 4, 2, IP.r);
      b.vline(6, 0, 3, IP.o); b.hline(0, 6, 3, IP.o);
      b.rect(6, 6, 2, 2, IP.w); b.set(7, 7, IP.y); b.set(6, 6, IP.W);
    },
    scales(b) {                                // balance of forces
      b.rect(7, 2, 2, 11, IP.Y); b.vline(7, 2, 11, IP.y); b.rect(4, 13, 8, 2, IP.Y); b.hline(4, 13, 8, IP.y);
      b.rect(7, 0, 2, 2, IP.y); b.hline(1, 3, 14, IP.Y); b.hline(1, 2, 14, IP.y); b.set(0, 3, IP.y); b.set(15, 3, IP.y);
      b.line(1, 4, 0, 9, IP.g); b.line(3, 4, 5, 9, IP.g); b.line(12, 4, 10, 9, IP.g); b.line(14, 4, 15, 9, IP.g);
      b.hline(0, 9, 6, IP.W); b.hline(1, 10, 4, IP.g); b.hline(10, 9, 6, IP.W); b.hline(11, 10, 4, IP.g);
      b.set(2, 8, IP.r); b.set(3, 8, IP.o); b.set(12, 8, IP.b); b.set(13, 8, IP.s);
    },
    scroll(b) {                                // casus belli: parchment with a red wax seal
      b.rect(2, 3, 11, 9, IP.t); b.hline(2, 3, 11, IP.w); b.hline(2, 11, 11, IP.T);
      b.rect(0, 1, 3, 13, IP.T); b.vline(0, 1, 13, IP.t); b.vline(1, 2, 11, IP.w); b.rect(13, 1, 3, 13, IP.T); b.vline(15, 1, 13, IP.N); b.vline(13, 2, 11, IP.t);
      for (const y of [5, 7, 9]) b.hline(4, y, y === 9 ? 4 : 8, IP.N);
      shadeDisc(b, 11, 10, 2.5, IP.r, IP.o, IP.R); b.set(10, 9, IP.w);
    },
    infamy(b) {                                // black mark: an ink blot with drips and a dull red glint
      shadeDisc(b, 7, 6, 5.2, IP.d, IP.G, IP.k);
      b.disc(3.5, 8, 2, IP.d); b.disc(11, 9, 2.2, IP.d);
      b.vline(4, 10, 4, IP.d); b.vline(9, 11, 3, IP.d); b.vline(12, 11, 2, IP.d); b.set(4, 14, IP.k); b.set(9, 14, IP.k);
      b.set(5, 3, IP.W); b.set(6, 3, IP.W); b.set(4, 4, IP.g); b.set(8, 7, IP.R); b.set(9, 7, IP.r); b.set(8, 8, IP.R); b.set(6, 7, IP.R); b.set(5, 7, IP.r);
      b.set(10, 4, IP.P); b.set(11, 5, IP.P);
    },
    drawer(b) {                                // pull-up handle: grab bar with a chevron
      b.line(2, 7, 7, 2, IP.w); b.line(3, 7, 7, 3, IP.W); b.line(13, 7, 8, 2, IP.w); b.line(12, 7, 8, 3, IP.W);
      b.rect(2, 10, 12, 3, IP.W); b.hline(2, 10, 12, IP.w); b.hline(2, 12, 12, IP.g); b.set(2, 10, 0); b.set(13, 10, 0); b.set(2, 12, 0); b.set(13, 12, 0);
    },
    play(b) { tri(b, 3, 1, 10, 13, IP.l); b.vline(3, 2, 11, IP.w); tri(b, 4, 3, 6, 9, IP.e); },
    pause(b) { b.rect(3, 2, 4, 12, IP.W); b.rect(9, 2, 4, 12, IP.W); b.vline(3, 2, 12, IP.w); b.vline(9, 2, 12, IP.w); b.vline(6, 2, 12, IP.g); b.vline(12, 2, 12, IP.g); },
    speed1(b) { tri(b, 3, 2, 10, 12, IP.W); b.vline(3, 3, 10, IP.w); },
    speed2(b) { tri(b, 0, 2, 7, 12, IP.W); tri(b, 7, 2, 7, 12, IP.W); b.vline(0, 3, 10, IP.w); b.vline(7, 3, 10, IP.w); },
    speed4(b) { for (let i = 0; i < 3; i++) { tri(b, i * 4.5 | 0, 2, 5, 12, IP.y); b.vline((i * 4.5) | 0, 3, 10, IP.w); } },
    menu(b) { for (const y of [2, 6, 10]) { b.rect(1, y, 13, 3, IP.W); b.hline(1, y, 13, IP.w); b.hline(1, y + 2, 13, IP.g); } },
    hand(b) {
      const f = IP.f, d = IP.F;
      b.rect(4, 6, 8, 7, f); b.rect(5, 13, 6, 1, f);
      for (let i = 0; i < 4; i++) { b.rect(4 + i * 2, 1 + (i === 1 || i === 2 ? 0 : 2), 2, 6, f); b.vline(5 + i * 2, 2, 6, d); }
      b.rect(1, 7, 3, 2, f); b.rect(2, 9, 3, 2, f); b.hline(1, 8, 3, d);
      b.vline(11, 8, 5, d); b.hline(5, 13, 6, d);
    },
    brush(b) {
      b.line(13, 1, 5, 9, IP.n); b.line(12, 1, 4, 9, IP.t); b.line(13, 2, 5, 10, IP.N);
      b.rect(3, 9, 3, 3, IP.g); b.line(3, 9, 6, 12, IP.W);
      b.rect(1, 11, 4, 3, IP.r); b.set(1, 13, IP.R); b.set(2, 13, IP.R); b.set(2, 11, IP.o); b.set(3, 12, IP.o);
    },
    save(b) {
      b.rect(1, 1, 13, 13, IP.b); b.rect(1, 1, 13, 1, IP.s); b.vline(1, 1, 13, IP.s); b.vline(13, 1, 13, IP.B); b.hline(1, 13, 13, IP.B);
      b.rect(4, 1, 7, 5, IP.W); b.rect(8, 2, 2, 3, IP.G);
      b.rect(3, 8, 9, 6, IP.w); b.rect(3, 8, 9, 1, IP.g); for (const y of [10, 12]) b.hline(4, y, 7, IP.g);
    },
    load(b) {
      b.rect(0, 5, 6, 2, IP.Y); b.rect(0, 6, 14, 8, IP.y); b.hline(0, 6, 14, IP.w); b.rect(0, 13, 14, 1, IP.Y);
      b.line(7, 0, 7, 8, IP.l);
      for (let j = 0; j < 4; j++) b.hline(7 - j, 6 + 0 - j + 3, 2 * j + 1, IP.l); b.vline(7, 0, 3, IP.l);
      b.rect(6, 0, 3, 3, IP.l); b.hline(4, 3, 7, IP.l); b.hline(5, 4, 5, IP.l); b.hline(6, 5, 3, IP.l); b.vline(7, 6, 2, IP.e);
    },
    newworld(b) {
      shadeDisc(b, 7, 8, 6, IP.b, IP.s, IP.B);
      for (let y = 2; y <= 14; y++) for (let x = 1; x <= 13; x++) {
        const dx = x - 7, dy = y - 8; if (dx * dx + dy * dy > 33) continue;
        const n = h2(x >> 1, y >> 1, 77) + h2(x, y, 5) * 0.2; if (n > 0.62) b.set(x, y, dx + dy < -2 ? IP.l : dx + dy > 4 ? IP.E : IP.e);
      }
      b.set(11, 0, IP.y); b.set(11, 1, IP.w); b.set(11, 2, IP.y); b.set(10, 1, IP.y); b.set(12, 1, IP.y);
      b.set(1, 2, IP.y); b.set(1, 3, IP.w); b.set(0, 3, IP.y); b.set(2, 3, IP.y); b.set(1, 4, IP.y);
    },
    close(b) { b.line(2, 2, 12, 12, IP.r); b.line(3, 2, 13, 12, IP.r); b.line(2, 12, 12, 2, IP.r); b.line(3, 12, 13, 2, IP.r); b.line(3, 3, 11, 11, IP.o); b.line(3, 11, 11, 3, IP.o); },
    map_normal(b) {
      b.rect(1, 2, 13, 11, IP.s);
      b.disc(5, 6, 3, IP.e); b.disc(9, 8, 3, IP.e); b.disc(10, 4, 1.5, IP.l); b.rect(4, 5, 3, 2, IP.l); b.set(4, 9, IP.t); b.set(5, 9, IP.t);
      b.rect(1, 2, 13, 1, IP.w); b.vline(1, 2, 11, IP.w); b.hline(1, 12, 13, IP.b); b.vline(13, 2, 11, IP.b);
    },
    map_borders(b) {
      b.rect(1, 2, 13, 11, IP.e); b.rect(1, 2, 6, 5, IP.l); b.rect(7, 7, 7, 6, IP.t);
      for (let x = 1; x < 14; x += 2) b.set(x, 7, IP.r); for (let y = 2; y < 13; y += 2) b.set(7, y, IP.r); for (let x = 7; x < 14; x += 2) b.set(x, 7, IP.r); b.vline(7, 7, 6, IP.r);
      b.hline(1, 7, 13, IP.r); b.vline(7, 2, 11, IP.r); b.hline(1, 2, 13, IP.w); b.vline(1, 2, 11, IP.w); b.hline(1, 12, 13, IP.E);
    },
    map_culture(b) {
      const cols = [IP.m, IP.s, IP.y, IP.l, IP.u, IP.o];
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) b.rect(1 + i * 4, 2 + j * 4, 4, 4, cols[(i + j * 2) % 6]);
      b.hline(1, 2, 12, IP.w); b.vline(1, 2, 12, IP.w);
      for (const q of [4, 8]) { b.vline(q, 2, 12, IP.k); b.hline(1, q + 1, 12, IP.k); }
    },
    sword(b) {
      for (let t = 0; t < 9; t++) { b.set(13 - t, 1 + t, IP.w); b.set(12 - t, 1 + t, IP.W); b.set(12 - t, 2 + t, IP.g); }
      b.set(13, 0, IP.w);
      b.line(3, 7, 8, 12, IP.y); b.line(4, 7, 8, 11, IP.Y); b.line(2, 7, 7, 12, IP.y);
      b.line(5, 9, 1, 13, IP.n); b.line(6, 9, 2, 13, IP.N); b.set(0, 14, IP.y); b.set(1, 14, IP.Y);
    },
    heart(b) {
      b.art(['.rrrr..rrrr.', 'rrwrrrrrrrrr', 'rwrrrrrrrrrr', 'rrrrrrrrrrrR', '.rrrrrrrrrR.', '..rrrrrrrR..', '...rrrrrR...', '....rrrR....', '.....rR.....'], IP, 1, 3);
    },
    food(b) {
      shadeDisc(b, 7, 9, 5, IP.r, IP.m, IP.R); shadeDisc(b, 6, 9, 3.5, IP.r, IP.o, IP.R);
      b.set(5, 6, IP.w); b.set(4, 7, IP.w);
      b.vline(7, 2, 3, IP.N); b.rect(8, 2, 3, 2, IP.l); b.set(10, 2, IP.e); b.set(9, 3, IP.e);
      b.set(7, 4, IP.R);
    },
    wood(b) {
      const logEnd = (cx, cy) => { b.disc(cx, cy, 3.3, IP.n); b.disc(cx, cy, 2.4, IP.t); b.disc(cx, cy, 1.5, IP.T); b.set(cx, cy, IP.n); b.set(cx - 1, cy - 1, IP.w); b.set(cx + 2, cy + 2, IP.N); b.set(cx - 3, cy + 1, IP.N); };
      logEnd(4, 10); logEnd(10, 10); logEnd(7, 5); b.set(7, 8, IP.N); b.set(8, 8, IP.N);
    },
    stone(b) {
      const K = FP.rock;
      shadedBlob(b, 6, 9, 5.4, 4.4, K, 5); shadedBlob(b, 11, 11, 3.2, 2.6, K, 6); shadedBlob(b, 10, 5, 3, 3, K, 7);
    },
    iron(b) {
      const ing = (x, y) => { b.rect(x + 1, y, 6, 3, IP.g); b.hline(x + 1, y, 6, IP.w); b.hline(x, y + 3, 8, IP.G); b.rect(x, y + 1, 1, 3, IP.W); b.rect(x + 7, y + 1, 1, 3, IP.G); b.rect(x + 1, y + 1, 6, 2, IP.W); b.hline(x + 1, y + 2, 6, IP.g); };
      ing(0, 9); ing(6, 9); ing(3, 5); b.set(5, 5, IP.s); b.set(10, 9, IP.s);
    },
    gold(b) {
      const ing = (x, y) => { b.rect(x + 1, y, 6, 3, IP.y); b.hline(x + 1, y, 6, IP.w); b.hline(x, y + 3, 8, IP.Y); b.rect(x, y + 1, 1, 3, IP.y); b.rect(x + 7, y + 1, 1, 3, IP.Y); b.hline(x + 1, y + 2, 6, IP.o); };
      ing(0, 9); ing(6, 9); ing(3, 5); b.set(5, 5, IP.w); b.set(11, 3, IP.w); b.set(10, 3, IP.y); b.set(12, 3, IP.y); b.set(11, 2, IP.y); b.set(11, 4, IP.y);
    },
    skull(b) {
      b.art(['.wwwwwwww.', 'wwwwwwwwww', 'wwwwwwwwww', 'wkkwwwwkkw', 'wkkwwwwkkw', 'wwwwkkwwww', '.wwwkkwwW.', '..wwwwwWW.', '..wkwkwkW.', '..wwwwwWW.'], IP, 2, 2);
      b.set(3, 5, IP.W); b.set(4, 4, IP.W);
    },
    coin(b) {
      shadeDisc(b, 7, 7, 6.2, IP.y, IP.w, IP.Y); ring(b, 7, 7, 4.2, 5.2, IP.o); shadeDisc(b, 7, 7, 3.6, IP.y, IP.y, IP.y);
      b.art(['..y..', '.yyy.', 'yyyyy', '.yyy.', '.y.y.'], { y: IP.Y }, 5, 5); b.set(7, 5, IP.o);
    },
    chevron_up(b) { for (let i = 0; i < 3; i++) { b.line(2, 9 - i * 0, 7, 4 - i * 0, IP.W); } b.line(2, 10, 7, 5, IP.W); b.line(3, 10, 7, 6, IP.W); b.line(12, 10, 7, 5, IP.W); b.line(11, 10, 7, 6, IP.W); b.line(2, 11, 7, 6, IP.g); b.line(12, 11, 7, 6, IP.g); b.set(7, 4, IP.w); b.set(7, 5, IP.w); },
    chevron_down(b) { b.line(2, 4, 7, 9, IP.W); b.line(3, 4, 7, 8, IP.W); b.line(12, 4, 7, 9, IP.W); b.line(11, 4, 7, 8, IP.W); b.line(2, 3, 7, 8, IP.w); b.line(12, 3, 7, 8, IP.w); b.set(7, 9, IP.g); b.set(7, 10, IP.g); },
    plus(b) { b.rect(5, 2, 4, 11, IP.l); b.rect(2, 5, 11, 4, IP.l); b.vline(5, 2, 11, IP.w); b.hline(2, 5, 11, IP.w); b.vline(8, 5, 8, IP.e); b.hline(5, 8, 8, IP.e); },
    minus(b) { b.rect(2, 5, 11, 4, IP.r); b.hline(2, 5, 11, IP.m); b.hline(2, 8, 11, IP.R); },
    check(b) { b.line(2, 8, 5, 11, IP.l); b.line(3, 8, 6, 11, IP.l); b.line(5, 11, 12, 3, IP.l); b.line(6, 11, 13, 3, IP.l); b.line(2, 7, 5, 10, IP.w); b.line(5, 10, 12, 2, IP.w); b.line(3, 9, 5, 12, IP.e); b.line(6, 12, 13, 4, IP.e); },
    forest(b) {
      const g = new Buf(TS, TS), h = new Buf(TS, TS);
      drawTreeFeature(g, 3); drawTreeFeature(h, 2);
      const sh = new Buf(TS, TS);
      for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) { const c = h.d[y * TS + x]; if ((c >>> 24) > 0) sh.set(x + 3, y + 2, c); }
      for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) { const c = g.d[y * TS + x]; if ((c >>> 24) > 0) b.set(x - 3, y, c); }
      b.over(sh, 0, 0);
      b.rect(0, 13, 14, 1, IP.E);
    },
    heal(b) {
      b.rect(5, 1, 5, 13, IP.e); b.rect(1, 5, 13, 5, IP.e);
      b.rect(6, 2, 3, 11, IP.l); b.rect(2, 6, 11, 3, IP.l);
      b.vline(6, 2, 11, IP.w); b.hline(2, 6, 11, IP.w); b.rect(7, 7, 2, 2, IP.w);
      b.vline(9, 9, 4, IP.e); b.hline(9, 9, 4, IP.e);
      b.set(13, 1, IP.w); b.set(12, 1, IP.y); b.set(14, 1, IP.y); b.set(13, 0, IP.y); b.set(13, 2, IP.y);
      b.set(1, 12, IP.w); b.set(0, 12, IP.c); b.set(2, 12, IP.c); b.set(1, 11, IP.c); b.set(1, 13, IP.c);
    },
    war_whisper(b) {
      b.rect(1, 1, 13, 10, IP.P); b.rect(2, 0, 11, 12, IP.P); b.rect(2, 1, 11, 9, IP.p); b.hline(2, 1, 11, IP.u);
      b.set(3, 11, IP.P); b.set(3, 12, IP.P); b.set(4, 11, IP.P); b.set(2, 13, IP.P); b.set(3, 11, IP.p); b.set(3, 12, IP.p);
      b.line(4, 2, 11, 9, IP.w); b.line(11, 2, 4, 9, IP.w); b.line(5, 2, 11, 8, IP.W); b.line(10, 2, 4, 8, IP.W);
      b.rect(3, 8, 3, 1, IP.y); b.rect(10, 8, 3, 1, IP.y); b.set(3, 9, IP.n); b.set(12, 9, IP.n);
      b.set(3, 2, IP.y); b.set(12, 2, IP.y);
    },
    peace(b) {
      b.vline(2, 0, 14, IP.n); b.vline(3, 0, 14, IP.N); b.set(2, 0, IP.y);
      for (let y = 1; y <= 8; y++) for (let x = 4; x <= 13; x++) {
        const wave = Math.round(Math.sin((x - 4) * 0.7) * 1);
        if (y + wave < 1 || y + wave > 8 || (x > 11 && y > 6 + wave)) continue;
        b.set(x, y + wave, (x + y) % 5 === 0 ? IP.W : IP.w);
      }
      b.line(4, 8, 12, 9, IP.g);
      b.set(1, 13, IP.e); b.set(0, 12, IP.l); b.set(0, 11, IP.e); b.set(4, 13, IP.e); b.set(5, 12, IP.l); b.set(5, 11, IP.e); b.hline(0, 13, 6, IP.E);
    },
    log(b) {
      b.rect(2, 1, 11, 13, IP.t); b.vline(2, 1, 13, IP.w); b.vline(12, 1, 13, IP.T); b.hline(2, 13, 11, IP.T); b.hline(2, 1, 11, IP.w);
      for (const y of [4, 6, 8, 10]) b.hline(4, y, y === 10 ? 4 : 7, IP.N);
      b.rect(1, 0, 13, 2, IP.T); b.rect(1, 13, 13, 2, IP.T); b.hline(1, 0, 13, IP.t);
    },
    focus(b) {
      ring(b, 7, 7, 4.2, 5.6, IP.W); ring(b, 7, 7, 1.2, 2.2, IP.r);
      for (const q of [[7, 0], [7, 11], [0, 7], [11, 7]]) { if (q[0] === 7) b.rect(6, q[1], 2, 4, IP.W); else b.rect(q[0], 6, 4, 2, IP.W); }
      b.set(7, 7, IP.r); b.set(6, 6, IP.o);
    },
    // ---- stage 2: command / region / war layer --------------------------------------------------
    command(b) {                               // officer's peaked cap with a gold star badge
      b.art([
        '....bbbbbb....',
        '..bbssbbbbbb..',
        '.bbssbbbbbbbB.',
        '.bbbbbbyybbbB.',
        '.bbbbbyyyybbB.',
        '.bbbbbbyybbbB.',
        'bbbbbbbbbbbbbB',
        'yYyYyYyYyYyYyY',
        'BBBBBBBBBBBBBB',
        '.kkkkkkkkkkkkkk',
        '..kGGGGGGGGGkk.',
      ], IP, 0, 1);
      b.set(7, 4, IP.w); b.set(6, 5, IP.Y); b.set(8, 5, IP.Y);
    },
    region(b) {                                // a parcel of land with a dashed border and a capital marker
      const inside = (x, y) => {
        const a = (x - 6.6) / 6.4, c = (y - 6.8) / 5.4;
        let d = a * a + c * c;
        d += Math.sin(x * 1.7 + 0.6) * 0.07 + Math.cos(y * 1.9) * 0.07;
        return d <= 1;
      };
      for (let y = 0; y < 14; y++) for (let x = 0; x < 14; x++) {
        if (!inside(x, y)) continue;
        const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
        const hi = !inside(x - 1, y) || !inside(x, y - 1);
        b.set(x, y, edge ? ((x + y) & 1 ? IP.r : IP.R) : (h2(x, y, 41) > 0.82 ? IP.E : (x + y < 9 ? IP.l : IP.e)));
        if (edge && hi && ((x + y) & 1) === 0) b.set(x, y, IP.o);
      }
      b.set(7, 6, IP.w); b.rect(6, 7, 3, 2, IP.y); b.set(6, 7, IP.w); b.hline(6, 9, 3, IP.Y);
      b.vline(7, 3, 3, IP.N); b.rect(8, 3, 3, 2, IP.r); b.set(10, 3, IP.R);
    },
    army(b) {                                  // plumed helmet between two spears
      b.vline(1, 2, 12, IP.n); b.vline(12, 2, 12, IP.n);
      b.art(['.w.', 'www', '.W.'], IP, 0, 0); b.art(['.w.', 'www', '.W.'], IP, 11, 0);
      b.set(1, 1, IP.w); b.set(12, 1, IP.w);
      shadeDisc(b, 6.5, 8, 4.6, IP.g, IP.w, IP.G);
      b.rect(2, 11, 9, 3, IP.G); b.hline(2, 11, 9, IP.g); b.hline(2, 13, 9, IP.d);
      b.rect(4, 8, 6, 1, IP.k); b.vline(6, 8, 4, IP.k); b.set(7, 9, IP.k);
      b.art(['.rr.', 'rrrr', 'rRrR', '.RR.'], IP, 5, 1); b.set(6, 2, IP.o);
    },
    shield(b) {                                // heater shield, white cross on blue, gold rim
      b.art([
        'YyyyyyyyyyY',
        'ybbbbwbbbBy',
        'ybsbbwbbbBy',
        'ybssbwbbbBy',
        'ywwwwwwwwwy',
        'ybssbwbbbBy',
        'ybsbbwbbbBy',
        '.ybbbwbbBy.',
        '.ybbbwbbBy.',
        '..ybbwbBy..',
        '...ybwBy...',
        '....yBy....',
        '.....y.....',
      ], IP, 1, 0);
    },
    arrow(b) {                                 // HOI4-style attack arrow (pointing up-right, curved tail)
      for (let y = 0; y < 14; y++) for (let x = 0; x < 14; x++) {
        const head = x >= 6 + y && y <= 7;
        const bend = x < 5 ? 13 + Math.round((5 - x) * (5 - x) * 0.09) : 13;     // tail bends down at the left
        const d = x + y - bend, body = Math.abs(d) <= 1 && x <= 10 && y >= 2 - (x < 3 ? 0 : 0);
        if (!head && !body) continue;
        let c = IP.r;
        if (head) c = (y === 0 || (x - y === 6 && y > 1)) ? (y === 0 ? IP.o : IP.R) : x === 13 ? IP.R : IP.r;
        else c = d === -1 ? IP.o : d === 1 ? IP.R : IP.r;
        b.set(x, y, c);
      }
      b.set(10, 1, IP.o); b.set(9, 2, IP.o);
    },
    star(b) {
      b.art([
        '......y......',
        '.....yyy.....',
        '.....ywy.....',
        'yyyyyywyyyyyy',
        '.yywwwwwyyyY.',
        '..yywwwwyyY..',
        '...yyyyyyY...',
        '...yyyyyYY...',
        '..yyyYyyYYY..',
        '..yyY...YYY..',
        '.yY.......YY.',
      ], IP, 0, 1);
    },
    supply(b) {                                // wooden supply crate with a strap
      b.rect(1, 4, 12, 9, IP.N);
      b.rect(2, 5, 10, 7, IP.t);
      b.hline(1, 3, 12, IP.T); b.hline(2, 4, 10, IP.t); b.hline(1, 4, 1, IP.T); b.hline(12, 4, 1, IP.T);
      b.line(3, 6, 10, 11, IP.n); b.line(10, 6, 3, 11, IP.n);
      b.vline(2, 5, 7, IP.T); b.vline(11, 5, 7, IP.T);
      b.hline(2, 5, 10, IP.w); b.hline(2, 11, 10, IP.T);
      b.rect(6, 4, 2, 9, IP.r); b.vline(6, 4, 9, IP.o); b.vline(7, 4, 9, IP.R);
      b.set(2, 6, IP.y); b.set(11, 6, IP.y); b.set(2, 10, IP.y); b.set(11, 10, IP.y);
    },
    war(b) {                                   // crossed swords
      const blade = (flip) => {
        const X = x => flip ? 13 - x : x;
        for (let t = 0; t < 9; t++) { b.set(X(1 + t), 1 + t, IP.w); b.set(X(2 + t), 1 + t, IP.W); b.set(X(1 + t), 2 + t, IP.g); }
        b.set(X(0), 0, IP.w); b.set(X(1), 0, IP.W); b.set(X(0), 1, IP.W);
        b.line(X(8), 12, X(12), 8, IP.y); b.line(X(8), 11, X(11), 8, IP.Y); b.line(X(9), 12, X(12), 9, IP.Y);
        b.line(X(10), 10, X(13), 13, IP.n); b.line(X(10), 11, X(12), 13, IP.N);
        b.set(X(13), 13, IP.y);
      };
      blade(false); blade(true);
      b.set(6, 5, IP.w); b.set(7, 5, IP.w); b.set(6, 6, IP.W); b.set(7, 6, IP.W);
    },
    flag_goal(b) {                             // war-goal banner planted on a marked spot
      b.ell(7, 13, 6, 1.6, IP.R); b.ell(7, 13, 4.2, 0.9, IP.r); b.ell(7, 13, 2, 0.4, IP.y);
      b.vline(3, 1, 12, IP.n); b.vline(4, 1, 12, IP.N); b.set(3, 0, IP.y); b.set(4, 0, IP.Y);
      b.art([
        'rrrrrrrrrr',
        'rrrrywrrrr',
        'rrrryyrrrr',
        'rRrrwyyrrr',
        'rRRrryyrRr',
        'rRRRrrrRR.',
        '.RRRRRRR..',
      ], IP, 5, 1);
      b.hline(5, 1, 10, IP.o);
    },
    handshake(b) {                             // agreement: two sleeves clasping hands
      b.rect(0, 3, 4, 8, IP.b); b.vline(0, 3, 8, IP.s); b.vline(3, 3, 8, IP.B); b.hline(0, 3, 4, IP.s); b.hline(0, 10, 4, IP.B);
      b.rect(10, 3, 4, 8, IP.r); b.vline(13, 3, 8, IP.R); b.vline(10, 3, 8, IP.m); b.hline(10, 3, 4, IP.m); b.hline(10, 10, 4, IP.R);
      b.rect(4, 4, 4, 5, IP.f); b.rect(6, 5, 4, 5, IP.F); b.hline(5, 3, 4, IP.f); b.hline(6, 2, 3, IP.f);
      b.hline(4, 9, 3, IP.f); b.hline(6, 10, 4, IP.F);
      for (const x of [5, 7, 9]) b.vline(x, 8, 3, IP.h);
      b.set(9, 11, IP.h); b.set(7, 11, IP.h); b.set(5, 10, IP.h);
      b.line(6, 4, 9, 7, IP.h); b.set(5, 5, IP.w); b.set(6, 3, IP.w); b.set(5, 4, IP.w);
    },
  };

  const iconCache = new Map();
  function buildIcon(key) {
    const b = new Buf(TS, TS);
    if (IFN[key]) {                            // code-drawn glyph: centre its bounding box inside the 14x14 inner area
      const g = new Buf(TS, TS); IFN[key](g);
      const bb = g.bbox();
      if (bb) { b.over(g, bb.w <= 14 ? 1 + ((14 - bb.w) >> 1) - bb.x0 : 0, bb.h <= 14 ? 1 + ((14 - bb.h) >> 1) - bb.y0 : 0); }
      b.outline(ICON_OUT);
    }
    else if (ICONS[key] && ICONS[key].length) {
      const rows = ICONS[key];
      let w = 0; for (const r of rows) w = Math.max(w, r.length);
      const ox = 1 + ((14 - w) >> 1), oy = 1 + ((14 - rows.length) >> 1);
      b.art(rows, IP, ox, oy);
      b.outline(ICON_OUT);
    } else {                                   // unknown key: "?"
      b.rect(3, 2, 10, 12, IP.G); b.rect(4, 3, 8, 10, IP.W);
      b.art(['.kkkk.', 'kk..kk', '...kk.', '..kk..', '..k...', '......', '..k...'], { k: IP.G }, 5, 4);
      b.outline(ICON_OUT);
    }
    return b;
  }
  function icon(key, size) {
    size = size | 0 || 32;
    let m = iconCache.get(key);
    if (m === undefined) { m = new Map(); iconCache.set(key, m); }
    let c = m.get(size);
    if (c !== undefined) return c;
    const base = buildIcon(key).toCanvas();
    c = size === TS ? base : scaleNN(base, size, size);
    m.set(size, c);
    return c;
  }

  /* ===============================================================
   * FX — procedural per-frame drawing, no allocation, pixel rects on a virtual 16px-per-tile grid
   *   px,py = screen centre of the effect; scale = CSS px per tile (u = scale/16 = one virtual pixel)
   * =============================================================== */
  const TAU = Math.PI * 2;
  function hf(n) { const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return s - Math.floor(s); }
  function fxSeed(fx) { return fx._s !== undefined ? fx._s : (fx._s = ((fx.x * 73.13 + fx.y * 31.7) * 100) | 0); }
  /** minimal software canvas context: fillStyle (hex / rgba string), globalAlpha, fillRect (integer rects, source-over) -> flat RGBA bitmap, so baked frames are plain pixel canvases */
  const colCache = new Map();
  function parseCol(str) {
    let c = colCache.get(str);
    if (c === undefined) {
      let r = 128, g = 128, b = 128, a = 1;
      if (str.charCodeAt(0) === 35) { const h = hex(str); r = cr(h); g = cg(h); b = cb(h); }
      else { const m = /rgba?\(([^)]*)\)/.exec(str); if (m) { const q = m[1].split(','); r = +q[0]; g = +q[1]; b = +q[2]; a = q.length > 3 ? +q[3] : 1; } }
      c = [r, g, b, a]; colCache.set(str, c);
    }
    return c;
  }
  class SoftCtx {
    constructor(w, h) { this.w = w; this.h = h; this.px = new Uint8ClampedArray(w * h * 4); this.globalAlpha = 1; this._c = [255, 255, 255, 1]; }
    set fillStyle(v) { this._c = parseCol(v); }
    get fillStyle() { return '#fff'; }
    fillRect(x, y, w, h) {
      const W = this.w, H = this.h, c = this._c, sa = this.globalAlpha * c[3], px = this.px;
      let x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h);
      if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 > W) x1 = W; if (y1 > H) y1 = H;
      if (!(sa > 0)) return;
      for (let j = y0; j < y1; j++) for (let i = x0, k = (j * W + x0) * 4; i < x1; i++, k += 4) {
        const da = px[k + 3] / 255, ra = sa + da * (1 - sa);
        if (ra <= 0) continue;
        const wd = da * (1 - sa) / ra, ws = sa / ra;
        px[k] = c[0] * ws + px[k] * wd; px[k + 1] = c[1] * ws + px[k + 1] * wd; px[k + 2] = c[2] * ws + px[k + 2] * wd; px[k + 3] = ra * 255;
      }
    }
    toCanvas() { const cv = mkCanvas(this.w, this.h), g = cv.getContext('2d'), id = g.createImageData(this.w, this.h); id.data.set(this.px); g.putImageData(id, 0, 0); return cv; }
  }
  let SNAP = false;                                       // true while an FX frame is being baked into the cache: every rect snaps to whole pixels
  function FR(ctx, x, y, w, h) {
    if (SNAP) { const x1 = Math.round(x + w), y1 = Math.round(y + h); x = Math.round(x); y = Math.round(y); w = x1 - x; h = y1 - y; if (w < 1) w = 1; if (h < 1) h = 1; }
    ctx.fillRect(x, y, w, h);
  }
  function R4(ctx, X, Y, u, gx, gy, w, h) { const pw = w * u, ph = h * u; FR(ctx, X + gx * u, Y + gy * u, pw < 1.4 ? 1.4 : pw, ph < 1.4 ? 1.4 : ph); }
  function snapU(v, u) { return Math.round(v / u) * u; }
  /** filled pixel-disc (rows) centred on X,Y with radius rad and pixel size ps */
  function discRows(ctx, X, Y, rad, ps) {
    if (rad < ps * 0.5) { FR(ctx, X - ps * 0.5, Y - ps * 0.5, ps, ps); return; }
    const n = Math.ceil(rad / ps);
    for (let j = -n; j <= n; j++) {
      const yy = Math.abs(j + (j < 0 ? 0.5 : 0.5) - (j < 0 ? 0 : 0)) * ps;
      const dy = (j + 0.5) * ps; if (Math.abs(dy) > rad) continue;
      const hw = Math.sqrt(rad * rad - dy * dy), w = Math.max(1, Math.round(hw / ps)) * 2;
      FR(ctx, X - w * ps * 0.5, Y + j * ps, w * ps, ps);
    }
  }
  function ringRows(ctx, X, Y, rad, th, ps) {
    const n = Math.ceil((rad + th) / ps);
    for (let j = -n; j <= n; j++) {
      const dy = (j + 0.5) * ps, ro = rad + th * 0.5, ri = rad - th * 0.5;
      if (Math.abs(dy) > ro) continue;
      const wo = Math.sqrt(ro * ro - dy * dy), wi = Math.abs(dy) < ri ? Math.sqrt(ri * ri - dy * dy) : 0;
      const a = Math.max(ps, Math.round(wo / ps) * ps), b = Math.round(wi / ps) * ps;
      if (wi <= 0) FR(ctx, X - a, Y + j * ps, a * 2, ps);
      else { FR(ctx, X - a, Y + j * ps, Math.max(ps, a - b), ps); FR(ctx, X + b, Y + j * ps, Math.max(ps, a - b), ps); }
    }
  }
  function pxLine(ctx, x0, y0, x1, y1, step, w) {
    const dx = x1 - x0, dy = y1 - y0, n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / step));
    for (let i = 0; i <= n; i++) { const t = i / n; FR(ctx, x0 + dx * t - w * 0.5, y0 + dy * t - w * 0.5, w, w); }
  }
  function ps14(rad, u) { return u * Math.max(1, Math.ceil(rad / 14 / u)); }

  function fxLightning(ctx, fx, X, Y, S, u, p, now) {
    const seed = fxSeed(fx), a = p < 0.3 ? 1 : Math.max(0, 1 - (p - 0.3) / 0.7), fl = (now / 55) | 0;
    // flash: three concentric discs
    ctx.fillStyle = '#cfe6ff'; ctx.globalAlpha = 0.16 * a; discRows(ctx, X, Y, S * (1.9 + p), ps14(S * 3, u));
    ctx.globalAlpha = 0.26 * a; discRows(ctx, X, Y, S * (1.2 + p * 0.6), ps14(S * 2, u));
    ctx.fillStyle = '#ffffff'; ctx.globalAlpha = (p < 0.2 ? 0.55 : 0.25) * a; discRows(ctx, X, Y, S * (0.55 + p * 0.5), ps14(S, u));
    const H = S * 11, segs = 11, step = Math.max(u * 1.5, 2);
    const px0 = X + (hf(seed + fl) - 0.5) * S * 1.0, py0 = Y - H;
    for (let layer = 0; layer < 3; layer++) {
      ctx.fillStyle = layer === 0 ? '#5a8cff' : layer === 1 ? '#bcd8ff' : '#ffffff';
      ctx.globalAlpha = (layer === 0 ? 0.5 : 1) * a;
      const w = Math.max(layer === 0 ? 3.5 : layer === 1 ? 2.4 : 1.4, layer === 0 ? u * 6 : layer === 1 ? u * 3.6 : u * 2);
      let x0 = px0, y0 = py0;
      for (let i = 1; i <= segs; i++) {
        const t = i / segs, nx = i === segs ? X : X + (hf(seed + i * 7.3 + fl * 3.1) - 0.5) * S * 1.3 * (1 - t * 0.75), ny = Y - H * (1 - t);
        pxLine(ctx, x0, y0, nx, ny, step, w);
        if ((i === 4 || i === 7 || i === 9) && hf(seed + i + fl) > 0.25) {          // forks
          const dir = hf(seed + i * 3) > 0.5 ? 1 : -1;
          pxLine(ctx, nx, ny, nx + dir * S * 0.9, ny + S * 1.1, step, w * 0.6);
        }
        x0 = nx; y0 = ny;
      }
    }
    ctx.globalAlpha = a; ctx.fillStyle = '#fff6b0';
    for (let i = 0; i < 8; i++) { const an = hf(seed + i * 2.1) * TAU, d = S * (0.2 + 0.7 * p) * (0.5 + hf(seed + i)); R4(ctx, X + Math.cos(an) * d, Y + Math.sin(an) * d * 0.7, u, 0, 0, 2, 2); }
    ctx.globalAlpha = 0.28 * a; ctx.fillStyle = '#1a1210'; ringRows(ctx, X, Y, S * (0.3 + 0.5 * p), Math.max(u * 1.5, 1.5), ps14(S, u));
    ctx.globalAlpha = 1;
  }

  function fxExplosion(ctx, fx, X, Y, S, u, p, now) {
    const seed = fxSeed(fx), rMax = (fx.r > 0 ? fx.r : 2) * S, e = 1 - (1 - p) * (1 - p);
    const rad = rMax * (0.2 + 0.8 * e), fade = p < 0.45 ? 1 : Math.max(0, 1 - (p - 0.45) / 0.55);
    // scorch + smoke-dark rim
    ctx.globalAlpha = 0.32 * (1 - p * 0.6); ctx.fillStyle = '#1a0e0a'; discRows(ctx, X, Y, rMax * (0.35 + 0.65 * e), ps14(rMax, u));
    const ps = ps14(rad, u);
    ctx.globalAlpha = fade; ctx.fillStyle = '#ff5a14'; discRows(ctx, X, Y, rad, ps);
    ctx.fillStyle = '#ff9a26'; discRows(ctx, X - rad * 0.04, Y - rad * 0.06, rad * 0.8, ps);
    if (p < 0.8) { ctx.fillStyle = '#ffd84a'; discRows(ctx, X - rad * 0.08, Y - rad * 0.1, rad * 0.56 * (1 - p * 0.6), ps); }
    if (p < 0.55) { ctx.fillStyle = '#fff6c8'; discRows(ctx, X - rad * 0.1, Y - rad * 0.12, rad * 0.3 * (1 - p), ps); }
    // shockwave ring
    ctx.globalAlpha = Math.max(0, 0.85 * (1 - p)); ctx.fillStyle = '#fff2d8';
    ringRows(ctx, X, Y, rMax * (0.35 + 0.85 * e), Math.max(u * 1.5, S * 0.16 * (1 - p)), ps14(rMax, u));
    // sparks
    ctx.globalAlpha = fade;
    const n = 12;
    for (let i = 0; i < n; i++) {
      const an = hf(seed + i * 1.7) * TAU, sp = 0.55 + hf(seed + i * 3.3) * 0.7, d = rMax * sp * (0.3 + 1.0 * e);
      const sx = X + Math.cos(an) * d, sy = Y + Math.sin(an) * d * 0.85 - Math.sin(p * Math.PI) * S * 0.6 * sp + p * p * S * 0.5;
      ctx.fillStyle = i & 1 ? '#ffe070' : '#ff8a30';
      R4(ctx, sx, sy, u, 0, 0, 2, 2);
    }
    // smoke puffs lifting away
    if (p > 0.35) {
      ctx.globalAlpha = 0.45 * (1 - p); ctx.fillStyle = '#3c3434';
      for (let i = 0; i < 4; i++) { const an = hf(seed + i * 5.1) * TAU, d = rMax * 0.5 * hf(seed + i); discRows(ctx, X + Math.cos(an) * d, Y + Math.sin(an) * d * 0.7 - (p - 0.35) * S * 1.6, S * (0.3 + 0.35 * hf(seed + i * 9)) * (0.6 + p), ps14(S, u)); }
    }
    ctx.globalAlpha = 1;
  }

  function fxFire(ctx, fx, X, Y, S, u, p, now) {
    const seed = fxSeed(fx), a = p > 0.75 ? Math.max(0, (1 - p) / 0.25) : 1, base = Y + S * 0.34;
    ctx.globalAlpha = a * 0.3; ctx.fillStyle = '#ff6a1a'; discRows(ctx, X, base - u * 3, S * 0.55, ps14(S, u));
    ctx.globalAlpha = a;
    for (let i = 0; i < 7; i++) {
      const gx = -7 + i * 2.1 + hf(seed + i) * 0.8 - 0.4, edge = i === 0 || i === 6 ? 2.5 : i === 1 || i === 5 ? 1 : 0;
      const fl = 0.5 + 0.5 * Math.sin(now / 85 + i * 1.9 + seed), h = 6 + 6 * fl + hf(seed + i * 2) * 3 - edge;
      ctx.fillStyle = '#d8301a'; R4(ctx, X, base, u, gx, -h, 3, h);
      ctx.fillStyle = '#ff7a1e'; R4(ctx, X, base, u, gx + 0.4, -h * 0.8, 2.3, h * 0.8);
      ctx.fillStyle = '#ffd23c'; R4(ctx, X, base, u, gx + 0.8, -h * 0.55, 1.6, h * 0.55);
      if (fl > 0.7) { ctx.fillStyle = '#fff2a0'; R4(ctx, X, base, u, gx + 1.1, -h * 0.3, 1, h * 0.25); }
      ctx.fillStyle = '#ff9a2a'; R4(ctx, X, base, u, gx + 0.8, -h - 1.5, 1.4, 1.4);
    }
    for (let i = 0; i < 4; i++) {                       // embers
      const t = ((now / 700) + hf(seed + i * 4)) % 1;
      ctx.fillStyle = '#ffc040'; R4(ctx, X, base, u, (hf(seed + i * 8) - 0.5) * 12 + Math.sin(t * 6 + i) * 1.5, -9 - t * 12, 1.2, 1.2);
    }
    ctx.globalAlpha = 1;
  }

  function fxSmoke(ctx, fx, X, Y, S, u, p, now) {
    const seed = fxSeed(fx), a = Math.sin(Math.min(1, p) * Math.PI);
    for (let i = 0; i < 4; i++) {
      const t = Math.min(1, p + i * 0.07), s = 3 + t * 6 + i * 0.8, gx = Math.sin(t * 5 + i * 2 + seed) * 3 + (i - 1.5) * 1.6, gy = -t * 20 - i * 1.5;
      ctx.globalAlpha = 0.75 * a * (1 - t * 0.45);
      ctx.fillStyle = '#4a4a54'; R4(ctx, X, Y, u, gx - s / 2, gy - s / 2, s, s);
      ctx.fillStyle = '#7c7c8a'; R4(ctx, X, Y, u, gx - s / 2, gy - s / 2, s * 0.62, s * 0.62);
      ctx.fillStyle = '#a8a8b6'; R4(ctx, X, Y, u, gx - s / 2, gy - s / 2, s * 0.3, s * 0.3);
    }
    ctx.globalAlpha = 1;
  }

  function fxHeal(ctx, fx, X, Y, S, u, p, now) {
    const seed = fxSeed(fx), r = fx.r > 0 ? fx.r : 1.5, rr = r * S, a = Math.sin(Math.min(1, p) * Math.PI);
    ctx.globalAlpha = 0.6 * (1 - p); ctx.fillStyle = '#9affb4';
    ringRows(ctx, X, Y, rr * (0.35 + 0.65 * Math.min(1, p * 1.6)), Math.max(u * 1.8, 1.6), ps14(rr, u));
    ctx.globalAlpha = 0.16 * a; ctx.fillStyle = '#6bff8a'; discRows(ctx, X, Y, rr * 0.9, ps14(rr, u));
    const n = Math.min(26, 7 + Math.round(r * 3));
    for (let i = 0; i < n; i++) {
      const an = hf(seed + i * 1.3) * TAU, d = Math.sqrt(hf(seed + i * 2.9)) * rr * 0.9, t = Math.min(1, Math.max(0, p * 1.25 - hf(seed + i * 5) * 0.25)), al = Math.sin(t * Math.PI);
      if (al <= 0) continue;
      const cx = X + Math.cos(an) * d, cy = Y + Math.sin(an) * d * 0.8 - t * S * 0.9;
      ctx.globalAlpha = al; ctx.fillStyle = '#2fd85c'; R4(ctx, cx, cy, u, -2, -1, 5, 2); R4(ctx, cx, cy, u, -1, -2, 2, 5);
      ctx.fillStyle = '#8bff9e'; R4(ctx, cx, cy, u, -1.5, -0.5, 4, 1); R4(ctx, cx, cy, u, -0.5, -1.5, 1, 4);
      ctx.fillStyle = '#ffffff'; R4(ctx, cx, cy, u, -0.5, -0.5, 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  function fxBless(ctx, fx, X, Y, S, u, p, now) {
    const seed = fxSeed(fx), r = fx.r > 0 ? fx.r : 1.5, rr = r * S, e = Math.min(1, p * 1.5), a = Math.sin(Math.min(1, p) * Math.PI);
    ctx.globalAlpha = 0.22 * a; ctx.fillStyle = '#fff4a0'; R4(ctx, X, Y - S * 1.6, u, -3, 0, 6, S * 1.6 / u);
    ctx.globalAlpha = 0.12 * a; discRows(ctx, X, Y, rr * 0.95, ps14(rr, u));
    ctx.globalAlpha = 0.75 * a; ctx.fillStyle = '#ffd84a'; ringRows(ctx, X, Y, rr * (0.45 + 0.5 * e), Math.max(u * 1.5, S * 0.07), ps14(rr, u));
    const n = Math.min(16, 6 + Math.round(r * 2.5));
    for (let i = 0; i < n; i++) {
      const an = (i / n) * TAU + now / 1400 + seed, d = rr * (0.45 + 0.5 * e), tw = 0.5 + 0.5 * Math.sin(now / 130 + i * 2.3);
      const sx = X + Math.cos(an) * d, sy = Y + Math.sin(an) * d - tw * S * 0.15 - p * S * 0.3;
      ctx.globalAlpha = a * (0.4 + 0.6 * tw); ctx.fillStyle = '#ffe680'; R4(ctx, sx, sy, u, -1, -0.5, 3, 1); R4(ctx, sx, sy, u, -0.5, -1, 1, 3);
      ctx.fillStyle = '#ffffff'; R4(ctx, sx, sy, u, -0.5, -0.5, 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  function fxPlague(ctx, fx, X, Y, S, u, p, now) {
    const seed = fxSeed(fx), r = fx.r > 0 ? fx.r : 2, rr = r * S, e = Math.min(1, p * 1.6), a = Math.sin(Math.min(1, p) * Math.PI);
    ctx.globalAlpha = 0.28 * a; ctx.fillStyle = '#7a3aa0'; discRows(ctx, X, Y, rr * (0.5 + 0.5 * e), ps14(rr, u));
    ctx.globalAlpha = 0.24 * a; ctx.fillStyle = '#5aa83a'; discRows(ctx, X + rr * 0.1, Y - rr * 0.08, rr * 0.7 * (0.5 + 0.5 * e), ps14(rr, u));
    const n = Math.min(22, 7 + Math.round(r * 2.5));
    for (let i = 0; i < n; i++) {
      const an = hf(seed + i * 1.9) * TAU, d = Math.sqrt(hf(seed + i * 3.1)) * rr * 0.85, t = (p * 1.2 + hf(seed + i * 7)) % 1;
      const bx = X + Math.cos(an) * d + Math.sin(t * 9 + i) * u * 1.5, by = Y + Math.sin(an) * d * 0.8 - t * S * 0.8, s = 3 + t * 3;
      ctx.globalAlpha = a * (t > 0.9 ? 0.4 : 0.95);
      ctx.fillStyle = '#243a1a'; R4(ctx, bx, by, u, -s / 2 - 0.6, -s / 2 - 0.6, s + 1.2, s + 1.2);
      ctx.fillStyle = i & 1 ? '#8cff5a' : '#c07cff'; R4(ctx, bx, by, u, -s / 2, -s / 2, s, s);
      ctx.fillStyle = '#eaffd8'; R4(ctx, bx, by, u, -s / 2 + 0.5, -s / 2 + 0.5, 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  function crackSet(ctx, X, Y, S, u, rr, grow, seed, shake, now) {
    const arms = 7, jit = shake ? ((now / 55) | 0) : 0;
    for (let k = 0; k < arms; k++) {
      let an = (k / arms) * TAU + hf(seed + k) * 0.5, x = X, y = Y;
      const len = rr * (0.45 + 0.55 * hf(seed + k * 3.7)) * grow, segs = 5;
      for (let i = 0; i < segs; i++) {
        an += (hf(seed + k * 11 + i + jit * 0.01) - 0.5) * 1.1;
        const l = len / segs, nx = x + Math.cos(an) * l, ny = y + Math.sin(an) * l * 0.85;
        ctx.fillStyle = '#6a4a30'; pxLine(ctx, x + u, y + u, nx + u, ny + u, u * 1.2, u * 1.6);
        ctx.fillStyle = '#1e120a'; pxLine(ctx, x, y, nx, ny, u * 1.2, u * 1.8);
        x = nx; y = ny;
      }
    }
  }
  function fxQuake(ctx, fx, X, Y, S, u, p, now) {
    const seed = fxSeed(fx), r = fx.r > 0 ? fx.r : 2, rr = r * S, e = Math.min(1, p * 2), a = p > 0.7 ? Math.max(0, (1 - p) / 0.3) : 1;
    ctx.globalAlpha = 0.15 * a; ctx.fillStyle = '#000'; discRows(ctx, X, Y, rr * e, ps14(rr, u));
    ctx.globalAlpha = a; crackSet(ctx, X + ((now / 50 | 0) % 3 - 1) * u * 0.7, Y, S, u, rr, e, seed, true, now);
    for (let i = 0; i < 9; i++) {
      const an = hf(seed + i * 2.2) * TAU, d = Math.sqrt(hf(seed + i * 4.1)) * rr * 0.9, t = (p * 1.6 + hf(seed + i)) % 1;
      ctx.globalAlpha = a * Math.sin(t * Math.PI) * 0.8; ctx.fillStyle = i & 1 ? '#c8aa80' : '#8e7452';
      R4(ctx, X + Math.cos(an) * d, Y + Math.sin(an) * d * 0.8 - t * S * 0.5, u, 0, 0, 2.5, 2.5);
    }
    ctx.globalAlpha = 1;
  }

  function fxDust(ctx, fx, X, Y, S, u, p, now) {
    const seed = fxSeed(fx), a = 1 - p;
    for (let i = 0; i < 6; i++) {
      const an = hf(seed + i * 2.3) * TAU, d = (0.15 + 0.6 * p) * S * (0.6 + hf(seed + i)), s = 2.5 + p * 3.5;
      ctx.globalAlpha = 0.85 * a; ctx.fillStyle = fx.color || '#8a7656';
      R4(ctx, X + Math.cos(an) * d, Y + Math.sin(an) * d * 0.5 - p * S * 0.2, u, -s / 2, -s / 2, s, s);
      ctx.globalAlpha = 0.85 * a; ctx.fillStyle = fx.color || '#d4c096';
      R4(ctx, X + Math.cos(an) * d, Y + Math.sin(an) * d * 0.5 - p * S * 0.2, u, -s / 2, -s / 2, s * 0.6, s * 0.6);
    }
    ctx.globalAlpha = 1;
  }
  function fxSpark(ctx, fx, X, Y, S, u, p, now) {
    const seed = fxSeed(fx), a = 1 - p, bx = fx.dx || 0, by = fx.dy || 0, n = fx.n > 0 ? Math.min(12, fx.n) : 8;
    if (p < 0.3) { ctx.globalAlpha = 1 - p / 0.3; ctx.fillStyle = '#ffffff'; R4(ctx, X, Y, u, -2, -1, 4, 2); R4(ctx, X, Y, u, -1, -2, 2, 4); }
    for (let i = 0; i < n; i++) {
      const an = hf(seed + i * 1.9) * TAU, d = (0.1 + 0.6 * Math.sqrt(p)) * S * (0.5 + hf(seed + i * 5));
      ctx.globalAlpha = a; ctx.fillStyle = i & 1 ? '#fff4a8' : '#ffb82c';
      R4(ctx, X + Math.cos(an) * d + bx * p * S * 0.3, Y + Math.sin(an) * d + by * p * S * 0.3 + p * p * S * 0.15, u, 0, 0, i % 3 === 0 ? 2.4 : 1.8, i % 3 === 0 ? 2.4 : 1.8);
    }
    ctx.globalAlpha = 1;
  }
  function fxSplash(ctx, fx, X, Y, S, u, p, now) {
    const seed = fxSeed(fx), a = 1 - p;
    ctx.globalAlpha = 0.85 * a; ctx.fillStyle = '#e4f4ff'; ringRows(ctx, X, Y, S * (0.12 + 0.5 * p), Math.max(u * 1.5, 1.4), u);
    for (let i = 0; i < 9; i++) {
      const sp = (hf(seed + i * 2.7) - 0.5) * 1.8, up = 0.8 + hf(seed + i * 3.9) * 1.0;
      const dx = sp * p * S * 0.8, dy = -(up * p - 1.7 * p * p) * S * 1.0;
      ctx.globalAlpha = a; ctx.fillStyle = i & 1 ? '#d4eeff' : '#4a9aee'; R4(ctx, X + dx, Y + dy, u, 0, 0, 2.2, 2.2);
    }
    ctx.globalAlpha = 1;
  }
  function pixArt(ctx, X, Y, u, rows, pal, flip) {          // draw an ASCII sprite as filled rects (X,Y = top-left, u = pixel size)
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j], n = row.length;
      for (let i = 0; i < n; i++) {
        const ch = row[flip ? n - 1 - i : i]; if (ch === '.') continue;
        const c = pal[ch]; if (c === undefined) continue;
        ctx.fillStyle = c; FR(ctx, X + i * u, Y + j * u, u + 0.4, u + 0.4);
      }
    }
  }
  function fxBlood(ctx, fx, X, Y, S, u, p, now) {          // melee hit: white slash arc, impact star, red droplets, short-lived splat
    const seed = fxSeed(fx), a = p > 0.7 ? (1 - p) / 0.3 : 1, dir = hf(seed) > 0.5 ? 1 : -1;
    if (p < 0.55) {                                         // slash: a diagonal streak that shrinks away
      const k = 1 - p / 0.55, len = S * (0.35 + 0.35 * k);
      ctx.globalAlpha = k; ctx.fillStyle = '#ffffff'; pxLine(ctx, X - dir * len * 0.5, Y - len * 0.6, X + dir * len * 0.5, Y + len * 0.5, Math.max(u, 1.2), Math.max(u * 1.6, 1.6));
      ctx.fillStyle = '#ffe9b0'; pxLine(ctx, X - dir * len * 0.3, Y - len * 0.35, X + dir * len * 0.3, Y + len * 0.3, Math.max(u, 1.2), Math.max(u * 1.1, 1.2));
    }
    if (p < 0.28) { ctx.globalAlpha = 1 - p / 0.28; ctx.fillStyle = '#ffffff'; R4(ctx, X, Y, u, -3, -0.5, 6, 1.4); R4(ctx, X, Y, u, -0.7, -3, 1.4, 6); }
    ctx.globalAlpha = a * 0.75; ctx.fillStyle = '#6e0a0e'; R4(ctx, X, Y + S * 0.14, u, -2.5, 0, 5, 2); R4(ctx, X, Y + S * 0.14, u, -1.5, 1.5, 3.5, 1.5);
    for (let i = 0; i < 9; i++) {
      const an = hf(seed + i * 2.1) * TAU, sp = 0.2 + 0.5 * hf(seed + i * 3.3), t = Math.min(1, p * 1.5);
      ctx.globalAlpha = a; ctx.fillStyle = i & 1 ? '#e02424' : '#8a0e10';
      R4(ctx, X + Math.cos(an) * sp * t * S, Y + Math.sin(an) * sp * t * S * 0.6 + t * t * S * 0.3 - (1 - t) * S * 0.1, u, 0, 0, i % 3 === 0 ? 2.4 : 1.8, i % 3 === 0 ? 2.4 : 1.8);
    }
    ctx.globalAlpha = 1;
  }
  const CHEV = ['..y..', '.yyy.', 'yy.yy'];
  function fxLevelUp(ctx, fx, X, Y, S, u, p, now) {          // gold ring at the feet + three chevrons rising + sparkles
    const seed = fxSeed(fx), a = p > 0.7 ? (1 - p) / 0.3 : 1;
    ctx.globalAlpha = a * 0.8; ctx.fillStyle = '#ffd83a';
    ringRows(ctx, X, Y + S * 0.1, S * (0.15 + 0.5 * Math.min(1, p * 1.5)), Math.max(u * 1.5, 1.4), u);
    ctx.globalAlpha = a * 0.25; ctx.fillStyle = '#fff2a0'; discRows(ctx, X, Y + S * 0.1, S * (0.12 + 0.4 * Math.min(1, p * 1.5)), u);
    const hu = u * 1.4;
    for (let i = 0; i < 3; i++) {
      const t = Math.min(1, Math.max(0, p * 1.3 - i * 0.14)); if (t <= 0) continue;
      const cx = X - 2.5 * hu, cy = Y - S * 0.2 - t * S * 1.3 - i * hu * 0.5;
      ctx.globalAlpha = Math.sin(t * Math.PI) * a;
      pixArt(ctx, cx - hu * 0.6, cy, hu, CHEV, { y: '#5a3a08' }); pixArt(ctx, cx + hu * 0.6, cy, hu, CHEV, { y: '#5a3a08' }); pixArt(ctx, cx, cy - hu * 0.6, hu, CHEV, { y: '#5a3a08' }); pixArt(ctx, cx, cy + hu * 0.6, hu, CHEV, { y: '#5a3a08' });
      pixArt(ctx, cx, cy, hu, CHEV, { y: i === 0 ? '#fff0a0' : '#ffd83a' });
    }
    for (let i = 0; i < 6; i++) { const t = (p * 1.5 + hf(seed + i)) % 1; ctx.globalAlpha = Math.sin(t * Math.PI) * a; ctx.fillStyle = i & 1 ? '#ffffff' : '#ffe680'; R4(ctx, X + (hf(seed + i * 3) - 0.5) * S * 0.9, Y - S * 0.1 - t * S * 1.1, u, -1.5, -0.5, 3, 1); R4(ctx, X + (hf(seed + i * 3) - 0.5) * S * 0.9, Y - S * 0.1 - t * S * 1.1, u, -0.5, -1.5, 1, 3); }
    ctx.globalAlpha = 1;
  }
  const HEART = ['.rr.rr.', 'rrrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...'];
  function fxHeart(ctx, fx, X, Y, S, u, p, now) {           // birth: pink hearts drifting up with twinkles
    const seed = fxSeed(fx), a = Math.sin(Math.min(1, p) * Math.PI);
    ctx.globalAlpha = Math.min(1, a * 1.4);
    for (let i = 0; i < 3; i++) {
      const t = Math.min(1, Math.max(0, p * 1.2 - i * 0.12)), sc = i === 0 ? 1 : 0.7;
      if (t <= 0) continue;
      const hx = X + Math.sin(t * 5 + i * 2.1 + seed) * S * 0.28 + (i - 1) * S * 0.28, hy = Y - S * 0.5 - t * S * 1.5, hu = u * sc * 1.5;
      const x0 = hx - 3.5 * hu, y0 = hy - 3 * hu;
      pixArt(ctx, x0 - hu, y0, hu, HEART, { r: '#5a0c24' }); pixArt(ctx, x0 + hu, y0, hu, HEART, { r: '#5a0c24' }); pixArt(ctx, x0, y0 - hu, hu, HEART, { r: '#5a0c24' }); pixArt(ctx, x0, y0 + hu, hu, HEART, { r: '#5a0c24' });
      pixArt(ctx, x0, y0, hu, HEART, { r: i === 1 ? '#ff7ab8' : '#ff4a78' });
      ctx.fillStyle = '#ffd0e0'; FR(ctx, x0 + hu, y0 + hu, hu, hu);
    }
    for (let i = 0; i < 4; i++) {                           // twinkles
      const t = (p * 1.6 + hf(seed + i)) % 1, tw = Math.sin(t * Math.PI);
      ctx.globalAlpha = a * tw; ctx.fillStyle = '#fff4a0';
      R4(ctx, X + (hf(seed + i * 3) - 0.5) * S * 1.2, Y - S * 0.4 - t * S * 1.2, u, -1.5, -0.5, 3, 1); R4(ctx, X + (hf(seed + i * 3) - 0.5) * S * 1.2, Y - S * 0.4 - t * S * 1.2, u, -0.5, -1.5, 1, 3);
    }
    ctx.globalAlpha = 1;
  }
  const SOUL = ['.www.', 'wwwww', 'wkwkw', 'wwwww', 'wwwww', 'w.w.w'];
  function fxSoul(ctx, fx, X, Y, S, u, p, now) {            // death of old age / sickness / hunger: a pale wisp floats up
    const seed = fxSeed(fx), a = p < 0.15 ? p / 0.15 : (1 - p) / 0.85, t = p, sway = Math.sin(t * 7 + seed) * S * 0.18;
    const hx = X + sway, hy = Y - S * 0.35 - t * S * 1.6, hu = u * 1.7;
    ctx.globalAlpha = 0.5 * a; ctx.fillStyle = '#cfe0ff';
    discRows(ctx, hx, hy + hu * 2, S * 0.38, ps14(S, u));
    ctx.globalAlpha = 0.9 * a;
    pixArt(ctx, hx - 2.5 * hu, hy - 3 * hu, hu, SOUL, { w: '#f4f8ff', k: '#6a7aa8' });
    ctx.globalAlpha = 0.45 * a; ctx.fillStyle = '#e8f0ff';
    for (let i = 0; i < 4; i++) R4(ctx, hx, hy, hu, -2 + i * 1.3 + Math.sin(t * 9 + i) * 0.8, 3.5 + i * 1.2, 1.4, 1.4);
    ctx.globalAlpha = 1;
  }
  function fxFlagRaise(ctx, fx, X, Y, S, u0, p, now) {
    const u = u0 * 1.4;       // occupation / founding: a banner in the kingdom colour is hoisted up a pole
    const col = fx.color || '#e53935', cn = hex(col), c = col, hi = '#' + ((1 << 24) | (cr(lt(cn, 0.4)) << 16) | (cg(lt(cn, 0.4)) << 8) | cb(lt(cn, 0.4))).toString(16).slice(1), lo = '#' + ((1 << 24) | (cr(dk(cn, 0.62)) << 16) | (cg(dk(cn, 0.62)) << 8) | cb(dk(cn, 0.62))).toString(16).slice(1);
    const a = p > 0.85 ? (1 - p) / 0.15 : 1, rise = Math.min(1, p / 0.55), bx = X + S * 0.1, by = Y + S * 0.28, H = 22;
    ctx.globalAlpha = a * 0.5; ctx.fillStyle = '#000'; R4(ctx, bx, by, u, -4, -0.5, 9, 1.6);
    ctx.globalAlpha = a;
    ctx.fillStyle = '#4a3220'; R4(ctx, bx, by, u, -0.5, -H, 1.6, H); ctx.fillStyle = '#8a6a44'; R4(ctx, bx, by, u, -0.5, -H, 0.8, H);
    ctx.fillStyle = '#ffd23c'; R4(ctx, bx, by, u, -1, -H - 1.4, 2.6, 2);
    const fy = by - u * (3 + (H - 8) * rise);
    for (let i = 0; i < 9; i++) {                            // 9 columns of cloth waving
      const wv = Math.sin(now / 120 + i * 0.9) * (0.6 + i * 0.12) * (p > 0.5 ? 1 : 0.3);
      ctx.fillStyle = i === 0 ? hi : c; R4(ctx, bx, fy + wv * u, u, 1 + i, 0, 1, 2); ctx.fillStyle = c; R4(ctx, bx, fy + wv * u, u, 1 + i, 2, 1, 2);
      ctx.fillStyle = lo; R4(ctx, bx, fy + wv * u, u, 1 + i, 4, 1, i > 6 ? 0 : 1);
    }
    if (p < 0.4) { ctx.globalAlpha = a * (1 - p / 0.4) * 0.6; ctx.fillStyle = '#d4c096'; for (let i = 0; i < 5; i++) { const an = hf(i * 2.3 + 1) * TAU, d = (0.1 + p) * S * 0.5; R4(ctx, X + Math.cos(an) * d, Y + S * 0.3 + Math.sin(an) * d * 0.4, u, 0, 0, 2.4, 2.4); } }
    if (p > 0.55) { for (let i = 0; i < 6; i++) { const t = ((p - 0.55) * 2.2 + hf(i * 3.1)) % 1; ctx.globalAlpha = a * Math.sin(t * Math.PI); ctx.fillStyle = i & 1 ? '#fff4a0' : '#ffffff'; R4(ctx, bx + 4 * u, fy, u, (hf(i * 5.7) - 0.3) * 12, -3 - t * 8, 1.4, 1.4); } }
    ctx.globalAlpha = 1;
  }
  function fxWhisper(ctx, fx, X, Y, S, u, p, now) {
    const seed = fxSeed(fx), a = Math.sin(Math.min(1, p) * Math.PI);
    ctx.globalAlpha = 0.45 * a; ctx.fillStyle = '#7a3cd8'; ringRows(ctx, X, Y + S * 0.1, S * (0.2 + 0.4 * p), Math.max(u * 1.5, 1.4), u);
    for (let i = 0; i < 22; i++) {
      const t = i / 22, an = t * 8 + now / 240 + seed, rad = t * S * 0.6 + u * 2;
      ctx.globalAlpha = a * (1 - t * 0.5); ctx.fillStyle = i % 4 === 0 ? '#f0dcff' : i & 1 ? '#b074ff' : '#7a3cd8';
      R4(ctx, X + Math.cos(an) * rad, Y + Math.sin(an) * rad * 0.5 - t * S * 0.7 - p * S * 0.3, u, 0, 0, 2.2, 2.2);
    }
    ctx.globalAlpha = 1;
  }
  function fxAsh(ctx, fx, X, Y, S, u, p, now) {
    const seed = fxSeed(fx), a = Math.sin(Math.min(1, p) * Math.PI);
    for (let i = 0; i < 9; i++) {
      const t = (p + hf(seed + i)) % 1, gx = (hf(seed + i * 2.2) - 0.5) * 12 + Math.sin(t * 6 + i) * 2.5, gy = -6 + t * 18;
      ctx.globalAlpha = a * 0.95; ctx.fillStyle = i % 3 === 0 ? '#26262a' : i & 1 ? '#8a8a92' : '#c4c4cc';
      R4(ctx, X, Y, u, gx, gy, i % 3 === 0 ? 2.4 : 1.8, 1.8);
    }
    ctx.globalAlpha = 1;
  }
  function fxDrop(ctx, fx, X, Y, S, u, p) {
    ctx.globalAlpha = 0.9 * (1 - p); ctx.fillStyle = '#d4eeff'; ringRows(ctx, X, Y, S * (0.06 + 0.26 * p), Math.max(u * 1.4, 1.3), u);
    ctx.globalAlpha = 1;
  }
  const FXD = {
    lightning: fxLightning, explosion: fxExplosion, fire: fxFire, smoke: fxSmoke, heal: fxHeal, bless: fxBless, plague: fxPlague,
    quake: fxQuake, dust: fxDust, spark: fxSpark, splash: fxSplash, blood: fxBlood, whisper: fxWhisper, ash: fxAsh, rain_drop: fxDrop,
    heart: fxHeart, soul: fxSoul, flagraise: fxFlagRaise, levelup: fxLevelUp,
  };
  /* ---- FX frame cache: the small cosmetic effects (hit / heart / soul / smoke ...) are baked once per (type, animation frame, seed variant, colour)
   *      into tiny canvases (pixel-snapped, drawn by the very same procedural code) and blitted with ONE drawImage per Fx afterwards.
   *      Big / radius-dependent effects (explosion, lightning, heal, bless, plague, quake) stay procedural: they are rare. ---- */
  // n frames over the lifetime, v seed variants, box (w,h) in 16-px-per-tile virtual px around the anchor (ax,ay), res = baked pixels per virtual px
  const FXC = {
    blood: { n: 6, v: 2, w: 36, h: 36, ax: 18, ay: 16, res: 1 },
    spark: { n: 6, v: 2, w: 44, h: 44, ax: 22, ay: 22, res: 1 },
    dust: { n: 6, v: 2, w: 52, h: 36, ax: 26, ay: 20, res: 1, col: true },
    splash: { n: 6, v: 2, w: 40, h: 36, ax: 20, ay: 14, res: 1 },
    ash: { n: 8, v: 2, w: 28, h: 28, ax: 14, ay: 10, res: 1 },
    smoke: { n: 8, v: 3, w: 32, h: 44, ax: 16, ay: 36, res: 1 },
    fire: { n: 8, v: 3, w: 32, h: 40, ax: 16, ay: 26, res: 1 },
    whisper: { n: 8, v: 1, w: 44, h: 48, ax: 22, ay: 32, res: 1 },
    rain_drop: { n: 4, v: 1, w: 20, h: 16, ax: 10, ay: 8, res: 1 },
    heart: { n: 10, v: 2, w: 44, h: 52, ax: 22, ay: 44, res: 2 },
    soul: { n: 10, v: 1, w: 32, h: 48, ax: 16, ay: 40, res: 2 },
    levelup: { n: 10, v: 1, w: 52, h: 60, ax: 26, ay: 46, res: 2 },
    flagraise: { n: 12, v: 1, w: 68, h: 56, ax: 28, ay: 42, res: 2, col: true },
  };
  let fxTi = 0;
  for (const k in FXC) { const d = FXC[k]; d.type = k; d.ti = fxTi++; d.cv = new Map(); d.fn = FXD[k]; }
  const fxColors = new Map();
  function fxColorId(col) {                               // -> 0 for none, 1..15 per distinct colour string, -1 when the table is full (procedural fallback)
    if (!col) return 0;
    let id = fxColors.get(col);
    if (id === undefined) { if (fxColors.size >= 15) return -1; id = fxColors.size + 1; fxColors.set(col, id); }
    return id;
  }
  const fxTmp = { type: '', x: 0, y: 0, ttl: 1, age: 0, _s: 0, color: undefined, n: undefined, dx: 0, dy: 0, r: 2 };
  function bakeFx(d, fx, fi, vi) {
    const R = d.res, g = new SoftCtx(d.w * R, d.h * R);
    fxTmp.type = d.type; fxTmp._s = 101 + vi * 7919; fxTmp.color = fx.color; fxTmp.n = fx.n; fxTmp.dx = 0; fxTmp.dy = 0;
    SNAP = true;
    try { d.fn(g, fxTmp, d.ax * R, d.ay * R, 16 * R, R, (fi + 0.5) / d.n, fi * 83 + vi * 17); } catch (e) { /* keep the empty frame */ }
    SNAP = false;
    return g.toCanvas();
  }
  let fxBudNow = -1, fxBud = 0;
  /** true = handled (drawn, or skipped because this frame's baking budget is used up), false = use the procedural path */
  function drawFxCached(ctx, d, fx, px, py, scale, p, now) {
    const col = d.col ? fxColorId(fx.color) : 0;
    if (col < 0) return false;
    if (d.type === 'spark' && (fx.dx || fx.dy)) return false;
    const nn = d.type === 'spark' ? (fx.n > 0 ? (fx.n > 12 ? 12 : fx.n | 0) : 8) : 0;
    const seed = fxSeed(fx), vi = d.v === 1 ? 0 : (((seed % d.v) + d.v) % d.v);
    let fi = (p * d.n) | 0; if (fi >= d.n) fi = d.n - 1;
    const key = (((((d.ti * 16 + col) * 4 + vi) * 16 + fi) * 16) + nn);
    let cv = d.cv.get(key);
    if (cv === undefined) {
      if (now !== fxBudNow) { fxBudNow = now; fxBud = 10; }
      if (fxBud <= 0) return true;
      fxBud--;
      cv = bakeFx(d, fx, fi, vi);
      d.cv.set(key, cv);
    }
    const k = scale / (16 * d.res);                        // device px per baked px
    const dw = Math.round(d.w * d.res * k), dh = Math.round(d.h * d.res * k);
    if (dw < 1 || dh < 1) return true;
    ctx.drawImage(cv, Math.round(px - d.ax * scale / 16), Math.round(py - d.ay * scale / 16), dw, dh);
    return true;
  }
  function drawFx(ctx, fx, px, py, scale, now) {
    const f = FXD[fx.type];
    if (f === undefined) return;
    const ttl = fx.ttl > 0 ? fx.ttl : 0.8;
    let p = fx.age / ttl; p = p < 0 ? 0 : p > 1 ? 1 : p;
    const d = FXC[fx.type];
    if (d !== undefined && scale > 0 && drawFxCached(ctx, d, fx, px, py, scale, p, now || 0)) return;
    f(ctx, fx, px, py, scale, scale / 16, p, now || 0);
  }

  /* ---------------- helpers drawn by Render (not Fx entries): arrows, smoke columns, birds, jumping fish ---------------- */
  /** an arrow in flight from (x0,y0) to (x1,y1) (device px), p = 0..1, S = px per tile */
  function drawArrow(ctx, x0, y0, x1, y1, p, S) {
    p = p < 0 ? 0 : p > 1 ? 1 : p;
    const u = Math.max(1, S / 16), arc = Math.sin(p * Math.PI) * S * 0.4;
    const X = x0 + (x1 - x0) * p, Y = y0 + (y1 - y0) * p - arc;
    let dx = x1 - x0, dy = (y1 - y0) - Math.cos(p * Math.PI) * Math.PI * S * 0.4;
    const L = Math.sqrt(dx * dx + dy * dy) || 1; dx /= L; dy /= L;
    const len = Math.max(5, u * 6);
    ctx.globalAlpha = (p > 0.88 ? (1 - p) / 0.12 : 1) * 0.28; ctx.fillStyle = '#10141c';
    ctx.fillRect(Math.round(x0 + (x1 - x0) * p - u), Math.round(y0 + (y1 - y0) * p + u), Math.max(2, Math.round(u * 2)), Math.max(1, Math.round(u)));
    ctx.globalAlpha = p > 0.88 ? (1 - p) / 0.12 : 1;
    ctx.fillStyle = '#6a4a28'; pxLine(ctx, X - dx * len + 1, Y - dy * len + 1, X + 1, Y + 1, Math.max(1, u), Math.max(1.4, u * 1.2));
    ctx.fillStyle = '#f0e0b8'; pxLine(ctx, X - dx * len, Y - dy * len, X, Y, Math.max(1, u), Math.max(1.4, u * 1.2));
    ctx.fillStyle = '#ffffff'; ctx.fillRect(X + dx * u * 0.5 - u * 0.6, Y + dy * u * 0.5 - u * 0.6, u * 1.6, u * 1.6);            // bright tip
    ctx.fillStyle = '#8fd48a'; ctx.fillRect(X - dx * len - u * 0.8, Y - dy * len - u * 0.8, u * 1.4, u * 1.4);                    // fletching
    ctx.globalAlpha = 1;
  }
  /** a rising smoke column: X,Y = chimney mouth (device px), S = px per tile, k = intensity (0.5 small / 1 big), dark = burning.
   *  16 baked animation frames per (kind, variant); one drawImage per column. */
  const SMK_N = 16, SMK_W = 28, SMK_H = 40, SMK_AX = 10, SMK_AY = 34;
  const smkCache = new Map();
  function smokePeriod(vi) { return 2200 + hf(vi * 37 + 5) * 600; }
  function bakeSmoke(kind, vi, fi) {
    const g = new SoftCtx(SMK_W, SMK_H), seed = vi * 37 + 5, k = kind === 0 ? 0.5 : kind === 1 ? 0.7 : 1, dark = kind === 1 || kind === 2;
    const n = k > 0.7 ? 5 : 3, u = 1, S = 16, X = SMK_AX, Y = SMK_AY, ph = (fi + 0.5) / SMK_N;
    SNAP = true;
    for (let i = 0; i < n; i++) {
      const t = (ph + i / n + hf(seed + 3)) % 1;
      const sz = u * (1.6 + t * 3.2 * k), x = X + Math.sin(t * 5 + seed + i) * u * 1.4 * (0.4 + t) + t * u * 2.2, y = Y - t * S * (0.55 + 0.35 * k);
      g.globalAlpha = Math.sin(Math.min(1, t * 1.15) * Math.PI) * (dark ? 0.7 : 0.55);
      g.fillStyle = dark ? '#3c3a40' : '#b8b8c4'; FR(g, x - sz / 2, y - sz / 2, sz, sz);
      g.fillStyle = dark ? '#5c5a62' : '#e4e4ee'; FR(g, x - sz / 2, y - sz / 2, sz * 0.55, sz * 0.55);
    }
    SNAP = false;
    return g.toCanvas();
  }
  function drawSmoke(ctx, X, Y, S, now, seed, k, dark) {
    const kind = dark ? (k > 0.85 ? 2 : 1) : (k > 0.7 ? 3 : 0), vi = seed & 1;
    let ph = (now / smokePeriod(vi) + hf(seed)) % 1; if (ph < 0) ph += 1;
    const fi = (ph * SMK_N) | 0, key = ((kind * 2 + vi) * SMK_N) + fi;
    let cv = smkCache.get(key);
    if (cv === undefined) {
      if (now !== fxBudNow) { fxBudNow = now; fxBud = 10; }
      if (fxBud <= 0) return;
      fxBud--;
      cv = bakeSmoke(kind, vi, fi); smkCache.set(key, cv);
    }
    const sc = S / 16, dw = Math.round(SMK_W * sc), dh = Math.round(SMK_H * sc);
    if (dw < 1 || dh < 1) return;
    ctx.drawImage(cv, Math.round(X - SMK_AX * sc), Math.round(Y - SMK_AY * sc), dw, dh);
  }
  const CHIM = [];                                        // [type*9 + race*3 + level-1] -> [x,y] smoke mouth on the 16x16 sprite
  (function () {
    const B = Const.B;
    const set = (t, r, l, x, y) => { CHIM[t * 9 + r * 3 + l - 1] = [x, y]; };
    set(B.HOUSE, 0, 2, 11, 0); set(B.HOUSE, 0, 3, 12, 0); set(B.HOUSE, 1, 1, 8, 1); set(B.HOUSE, 1, 2, 8, 0);
    set(B.STORAGE, 0, 1, 8, 5); set(B.TOWNHALL, 0, 1, 10, 4);
  })();
  /** smoke mouth [x,y] (16x16 sprite grid) for buildings with a chimney / smoke hole, else null (shared array, do not modify) */
  function chimney(type, race, level) { const c = CHIM[(type | 0) * 9 + (race | 0) * 3 + ((level | 0) - 1)]; return c === undefined ? null : c; }
  /** a small bird (flapping, 2 baked frames), X,Y = centre */
  const birdCache = [];
  function bakeBird(up) {
    const g = new SoftCtx(20, 12), R = (x, y, w, h) => g.fillRect((5 + x) * 2, (3 + y) * 2, w * 2, h * 2);
    g.fillStyle = '#2a2e3c';
    if (up) { R(-3, -1.5, 1, 1); R(-2, -0.5, 1, 1); R(-1, 0, 2, 1); R(1, -0.5, 1, 1); R(2, -1.5, 1, 1); }
    else { R(-3, 0.5, 1, 1); R(-2, 0, 1, 1); R(-1, -0.5, 2, 1); R(1, 0, 1, 1); R(2, 0.5, 1, 1); }
    g.fillStyle = '#e8ecf4'; R(-0.5, (up ? 0 : -0.5) + 0.4, 1, 0.6);
    return g.toCanvas();
  }
  function drawBird(ctx, X, Y, S, now, seed) {
    const u = Math.max(1, S / 12), up = (((now / 150) | 0) + seed) & 1;
    ctx.globalAlpha = 0.18; ctx.fillStyle = '#10141c'; ctx.fillRect(X - u * 2, Y + S * 0.9, u * 4, u * 1.2);
    ctx.globalAlpha = 1;
    const cv = birdCache[up] || (birdCache[up] = bakeBird(up));
    ctx.drawImage(cv, Math.round(X - 5 * u), Math.round(Y - 3 * u), Math.round(10 * u), Math.round(6 * u));
  }
  /** a fish leaping out of the water: p = 0..1 over the jump, X,Y = water surface point (8 baked frames) */
  const fishCache = [];
  function bakeFish(fi) {
    const g = new SoftCtx(28, 24), S = 32, u = S / 14, p = (fi + 0.5) / 8, X = 14, Y = 16, a = p > 0.8 ? (1 - p) / 0.2 : 1;
    const fx = X + (p - 0.5) * S * 0.7, fy = Y - Math.sin(p * Math.PI) * S * 0.5, ang = (0.5 - p) * 2.4;
    SNAP = true;
    g.globalAlpha = a; g.fillStyle = '#9fd0f4';
    for (let i = -2; i <= 2; i++) FR(g, fx + i * u * Math.cos(ang), fy - i * u * Math.sin(ang), u * 1.4, u * 1.4);
    g.fillStyle = '#e8f6ff'; FR(g, fx - u, fy - u * 0.4, u * 1.6, u * 0.9);
    g.fillStyle = '#4a86c8'; FR(g, fx - u * 2.6 * Math.cos(ang), fy + u * 2.6 * Math.sin(ang), u * 1.4, u * 1.4);
    g.fillStyle = '#e4f4ff';
    for (const e of [0, 1]) { const q = e ? Math.max(0, (p - 0.75) / 0.25) : Math.min(1, p / 0.25); if (q <= 0 || q >= 1) continue; g.globalAlpha = (1 - q) * 0.85; ringRows(g, X + (e ? S * 0.35 : -S * 0.35), Y + u, S * (0.05 + 0.18 * q), Math.max(u, 1.2), u); }
    SNAP = false;
    return g.toCanvas();
  }
  function drawFishJump(ctx, X, Y, S, p) {
    p = p < 0 ? 0 : p > 1 ? 1 : p;
    let fi = (p * 8) | 0; if (fi > 7) fi = 7;
    const cv = fishCache[fi] || (fishCache[fi] = bakeFish(fi)), sc = S / 32;
    ctx.drawImage(cv, Math.round(X - 14 * sc), Math.round(Y - 16 * sc), Math.round(28 * sc), Math.round(24 * sc));
  }

  /* ---------------- persistent effects (S.eff) ---------------- */
  function drawMeteor(ctx, e, X, Y, S, u, now) {
    let p = e.p;
    if (p === undefined) { const t0 = e.t0 || 0, span = (e.eta || 1) - t0; p = span > 0 ? (S_tick() - t0) / span : 0.5; }
    p = p < 0 ? 0 : p > 1 ? 1 : p;
    const r = e.r > 0 ? e.r : 2, rr = r * S, pulse = 0.55 + 0.35 * Math.sin(now / 110);
    // impact marker
    ctx.globalAlpha = 0.2 * (0.4 + p); ctx.fillStyle = '#ff3a20'; discRows(ctx, X, Y, rr, ps14(rr, u));
    ctx.globalAlpha = pulse; ctx.fillStyle = '#ff5a30'; ringRows(ctx, X, Y, rr, Math.max(u * 1.4, 1.6), ps14(rr, u));
    ctx.globalAlpha = 0.6 * pulse; ctx.fillStyle = '#ffd0a0'; R4(ctx, X, Y, u, -5, -0.5, 10, 1); R4(ctx, X, Y, u, -0.5, -5, 1, 10);
    // ground shadow
    ctx.globalAlpha = 0.3 * p; ctx.fillStyle = '#000'; discRows(ctx, X, Y, S * (0.25 + 0.6 * p), ps14(S, u));
    // rock + trail along the incoming direction (from the upper right)
    const dirx = 0.42, diry = -0.91, h = Math.pow(1 - p, 1.5) * S * 15, mx = X + dirx * h, my = Y + diry * h;
    const rad = S * (0.35 + 0.7 * p) * (0.85 + 0.1 * Math.min(r, 4)), ps = ps14(rad * 1.8, u);
    for (let i = 12; i >= 1; i--) {
      const t = i / 12, d = t * S * (3 + 6 * (1 - p)), tx = mx + dirx * d + Math.sin(now / 90 + i) * u * 1.2, ty = my + diry * d;
      ctx.globalAlpha = (1 - t) * 0.9; ctx.fillStyle = t < 0.3 ? '#ffe070' : t < 0.55 ? '#ffa030' : t < 0.8 ? '#ff5a1e' : '#6a2a20';
      discRows(ctx, tx, ty, rad * (1.05 - t * 0.6), ps);
    }
    ctx.globalAlpha = 0.65; ctx.fillStyle = '#ff7a1e'; discRows(ctx, mx, my, rad * 1.45, ps);
    ctx.globalAlpha = 1; ctx.fillStyle = '#ffb030'; discRows(ctx, mx, my, rad * 1.18, ps);
    ctx.fillStyle = '#4e3228'; discRows(ctx, mx - rad * 0.08, my - rad * 0.08, rad * 0.92, ps);
    ctx.fillStyle = '#7a4c38'; discRows(ctx, mx - rad * 0.3, my - rad * 0.3, rad * 0.45, ps);
    ctx.fillStyle = '#ffe070'; discRows(ctx, mx + rad * 0.5, my + rad * 0.55, rad * 0.3, ps);
  }
  function S_tick() { return (typeof S !== 'undefined' && S) ? S.tick : 0; }

  function drawTornado(ctx, e, X, Y, S, u, now) {
    const seed = ((e.x * 37 + e.y * 11) * 10) | 0, H = 34;
    ctx.globalAlpha = 0.28; ctx.fillStyle = '#000'; discRows(ctx, X, Y + u * 1.5, S * 0.65, ps14(S, u));
    ctx.globalAlpha = 0.3; ctx.fillStyle = '#b89c78'; ringRows(ctx, X, Y + u, S * (0.5 + 0.1 * Math.sin(now / 200)), Math.max(u * 2, 1.6), ps14(S, u));
    for (let k = 0; k < H; k += 2) {
      const t = k / H, hw = 2.4 + 11.5 * Math.pow(t, 0.8), cx = Math.sin(now / 230 + k * 0.26 + seed) * (1 + 3.4 * t), gy = -k - 2;
      ctx.globalAlpha = 0.97; ctx.fillStyle = '#5a5046'; R4(ctx, X, Y, u, cx - hw, gy, hw * 2, 2);
      const ph = now / 90 + k * 0.8 + seed;
      for (let q = 0; q < 3; q++) {
        const a0 = ((ph / TAU) + q / 3) % 1, sx = cx - hw + a0 * hw * 2, w = hw * 0.62;
        const x0 = Math.max(cx - hw, sx - w / 2), x1 = Math.min(cx + hw, sx + w / 2), sh = Math.sin(a0 * Math.PI);
        ctx.fillStyle = sh > 0.7 ? '#d6c8b2' : sh > 0.35 ? '#a29480' : '#776b5c';
        if (x1 > x0) R4(ctx, X, Y, u, x0, gy, x1 - x0, 2);
      }
      ctx.fillStyle = '#3a322a'; R4(ctx, X, Y, u, cx - hw - 0.6, gy, 1.4, 2); R4(ctx, X, Y, u, cx + hw - 0.8, gy, 1.4, 2);
    }
    for (let i = 0; i < 9; i++) {                         // debris orbiting the funnel
      const t = hf(seed + i * 3) * 0.85 + 0.08, an = now / 140 + i * 2.1, hw = 2.4 + 11.5 * Math.pow(t, 0.8) + 3, gy = -t * H;
      ctx.globalAlpha = 1; ctx.fillStyle = i % 3 === 0 ? '#3c2c1c' : i & 1 ? '#7a5a38' : '#2f7a30';
      R4(ctx, X, Y, u, Math.cos(an) * hw, gy + Math.sin(an) * 1.6, 2, 2);
    }
    ctx.globalAlpha = 0.5; ctx.fillStyle = '#c4a880';
    for (let i = 0; i < 6; i++) { const an = now / 280 + i * 1.05; R4(ctx, X, Y, u, Math.cos(an) * 9, Math.sin(an) * 2.2 + 1, 3, 2); }
    ctx.globalAlpha = 1;
  }

  const CLOUD = [[-1.1, 0.2, 0.7], [-0.6, -0.15, 0.85], [0, -0.35, 1.0], [0.6, -0.12, 0.9], [1.1, 0.22, 0.65], [-0.25, 0.22, 0.8], [0.45, 0.28, 0.7]];
  function cloud(ctx, cx, cy, s, u, alpha) {
    const ps = ps14(s * 2, u);
    ctx.globalAlpha = alpha; ctx.fillStyle = '#394258';
    for (let i = 0; i < CLOUD.length; i++) { const q = CLOUD[i]; discRows(ctx, cx + q[0] * s, cy + q[1] * s, q[2] * s, ps); }
    ctx.fillStyle = '#586279';
    for (let i = 0; i < CLOUD.length; i++) { const q = CLOUD[i]; discRows(ctx, cx + q[0] * s - s * 0.06, cy + q[1] * s - s * 0.1, q[2] * s * 0.8, ps); }
    ctx.fillStyle = '#838ea6';
    for (let i = 0; i < CLOUD.length; i++) { const q = CLOUD[i]; if (q[1] < 0.1) discRows(ctx, cx + q[0] * s - s * 0.16, cy + q[1] * s - s * 0.26, q[2] * s * 0.45, ps); }
  }
  function drawRain(ctx, e, X, Y, S, u, now) {
    const r = e.r > 0 ? e.r : 3, rr = r * S, seed = ((e.x * 19 + e.y * 7) * 10) | 0;
    ctx.globalAlpha = 0.2; ctx.fillStyle = '#243a66'; discRows(ctx, X, Y, rr, ps14(rr, u));
    ctx.globalAlpha = 0.3; ctx.fillStyle = '#7a9ad0'; ringRows(ctx, X, Y, rr, Math.max(u, 1.2), ps14(rr, u));
    const n = Math.max(10, Math.min(70, Math.round(r * r * 1.6)));
    for (let i = 0; i < n; i++) {
      const an = hf(seed + i * 1.7) * TAU, d = Math.sqrt(hf(seed + i * 2.9)) * rr * 0.95;
      const f = ((now / (330 + hf(seed + i) * 160)) + hf(seed + i * 5.3)) % 1;
      const bx = X + Math.cos(an) * d, by = Y + Math.sin(an) * d * 0.92;
      if (f < 0.88) {
        const fy = -(0.88 - f) * S * 0.9, fx0 = (0.88 - f) * S * 0.25;
        ctx.globalAlpha = 0.9; ctx.fillStyle = '#9ccaff'; R4(ctx, bx + fx0, by + fy, u, 0, 0, 1.2, 3); R4(ctx, bx + fx0 + u * 0.6, by + fy + u * 3, u, 0, 0, 1.2, 1.5);
        ctx.fillStyle = '#e8f4ff'; R4(ctx, bx + fx0, by + fy, u, 0, 0, 1.2, 1.5);
      } else { ctx.globalAlpha = (1 - f) * 6; ctx.fillStyle = '#d4eaff'; R4(ctx, bx, by, u, -1.5, 0, 3, 1.2); }
    }
    const cs = S * (0.62 + 0.13 * Math.min(r, 6)), drift = Math.sin(now / 2600 + seed) * cs * 0.12;   // dark clouds over the circle
    cloud(ctx, X + drift, Y - rr * 0.68, cs, u, 0.72);
    if (r >= 4) { cloud(ctx, X - rr * 0.55 - drift, Y - rr * 0.4, cs * 0.65, u, 0.6); cloud(ctx, X + rr * 0.55 + drift, Y - rr * 0.42, cs * 0.6, u, 0.6); }
    ctx.globalAlpha = 1;
  }

  function drawQuakeEff(ctx, e, X, Y, S, u, now) {
    const r = e.r > 0 ? e.r : 2, rr = r * S, seed = ((e.x * 23 + e.y * 5) * 10) | 0;
    const sx = (((now / 45) | 0) % 3 - 1) * u * 0.8, sy = ((((now / 45) | 0) + 1) % 3 - 1) * u * 0.8;
    ctx.globalAlpha = 0.12; ctx.fillStyle = '#000'; discRows(ctx, X + sx, Y + sy, rr, ps14(rr, u));
    ctx.globalAlpha = 1; crackSet(ctx, X + sx, Y + sy, S, u, rr, 1, seed, true, now);
    for (let i = 0; i < 10; i++) {
      const an = hf(seed + i * 2.2) * TAU, d = Math.sqrt(hf(seed + i * 4.1)) * rr * 0.9, t = ((now / 900) + hf(seed + i)) % 1;
      ctx.globalAlpha = Math.sin(t * Math.PI) * 0.7; ctx.fillStyle = i & 1 ? '#c8aa80' : '#8e7452';
      R4(ctx, X + Math.cos(an) * d, Y + Math.sin(an) * d * 0.8 - t * S * 0.45, u, 0, 0, 2.2, 2.2);
    }
    ctx.globalAlpha = 1;
  }
  function drawEffect(ctx, kind, e, px, py, scale, now) {
    now = now || 0;
    const u = scale / 16;
    switch (kind) {
      case 'meteor': drawMeteor(ctx, e, px, py, scale, u, now); break;
      case 'tornado': drawTornado(ctx, e, px, py, scale, u, now); break;
      case 'rain': drawRain(ctx, e, px, py, scale, u, now); break;
      case 'quake': drawQuakeEff(ctx, e, px, py, scale, u, now); break;
    }
  }

  /* ===============================================================
   * public API
   * =============================================================== */
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    buildAtlas();                    // 9 tile types x 8 looks x 2 frames, a few ms
  }
  function stats() { return { units: unitCache.size, buildings: bldCache.size + lmCache.size, features: featCache.size, tints: tintCount }; }

  return {
    init, drawTile, tileAtlas, feature, decal, unit, building, landmark, flag, icon, drawFx, drawEffect, drawArrow, drawSmoke, drawBird, drawFishJump, chimney, stats,
    /** test hooks: FX cache descriptors and a bake of one cached frame (used by tests/sprites_sheet bounds check) */
    fxCache: { desc: FXC, bake(type, fi, vi, color) { return bakeFx(FXC[type], { color, n: undefined }, fi, vi); }, smoke(kind, vi, fi) { return bakeSmoke(kind, vi, fi); }, SMK: { n: SMK_N, w: SMK_W, h: SMK_H } },
    LOOKS, TILE_PX: TS,
    /** all icon keys known to the sprite sheet */
    iconKeys() { return Object.keys(IFN).concat(Object.keys(ICONS).filter(k => ICONS[k] && ICONS[k].length && !IFN[k])); },
  };
})();
