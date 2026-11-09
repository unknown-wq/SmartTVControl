/* =====================================================================
 * 21_render.js — Render: cached terrain layer, camera, entities, overlays, effects
 * OWNER: Render+Input agent. API: docs/CONTRACT.md §4 Render.
 *
 * Design
 *  - Terrain (+ lone trees / ore / berries) is baked into two offscreen canvases (water frame 0 / 1, S.w*16 x S.h*16)
 *    plus two half-resolution "mip" canvases used while zoomed far out. Baking is incremental from S.dirtyList.
 *    Per-tile touches: shore foam (animated through the two frames), deep/shallow gradient, ragged edges between land
 *    types, slope shading from S.elev, cliff shadows under mountains, soft meadow tint, forest thinning.
 *  - Everything is drawn in DEVICE pixels with an identity transform (dpr clamped to 2); sprite positions are
 *    snapped to whole device pixels so nothing shimmers while panning.
 *  - Entities are culled to the view, bucket-sorted by y (no comparator sort, no per-frame allocation).
 *  - Extras beyond the contract: Render.pad (css px of extra scroll margin for UI chrome), Render.panBy / zoomAt /
 *    setCamera / minZoom / maxZoom / visibleRect / invalidate / canvas / size, focusOn(x,y,zoom,instant).
 * ===================================================================== */

const Render = (() => {
  const T = Const.T, RES = Const.RES, MODE = Const.MODE;
  const MINZ_ABS = 2, MAXZ = 48;
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const BG = '#07101c';
  const TAU = Math.PI * 2;

  // ------------------------------------------------------------------ state
  let canvas = null, ctx = null;
  let cssW = 390, cssH = 844, dpr = 1, cw = 390, ch = 844;
  const pad = { t: 0, b: 0, l: 0, r: 0 };
  let glide = null;
  let lastNow = 0, fpsEma = 60, drawEma = 0;
  const warned = {};
  let useUnitsStage = -1;

  // world cache state
  let W = 0, H = 0, P = 16, seedV = 1;
  let tileArr = null, elevArr = null, resArr = null, amtArr = null, fireArr = null;
  const terr = [null, null], tc = [null, null], mip = [null, null], mc = [null, null];
  let glint = null, atlasCv = null;
  let scrCv = null, scr = null;
  const ocean = [null, null], oceanMip = [null, null];   // 32x32-tile seamless blocks of open sea drawn behind / around the map
  let needFull = true;

  // view (recomputed every frame)
  let Z = 16, ox = 0, oy = 0, vx0 = 0, vy0 = 0, vx1 = 0, vy1 = 0, zoomCss = 8, texel = 1;
  let curAlpha = 1, curNow = 0;

  function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function report(where, e) { if (!warned[where]) { warned[where] = 1; if (typeof console !== 'undefined') console.error('Render.' + where, e); } }

  // ------------------------------------------------------------------ colour tables (strings built once)
  const FOAM = ['rgba(255,255,255,0.92)', 'rgba(235,248,255,0.5)', 'rgba(220,240,255,0.22)'];
  const DEEP_TO_SHALLOW = ['rgba(70,150,215,0.42)', 'rgba(70,150,215,0.24)', 'rgba(70,150,215,0.10)'];
  const SHALLOW_TO_DEEP = ['rgba(14,48,110,0.36)', 'rgba(14,48,110,0.2)', 'rgba(14,48,110,0.08)'];
  const SH_L = [], SH_D = [], VN_L = [], VN_D = [], WN_L = [], WN_D = [], SHD = [];
  for (let k = 0; k <= 8; k++) {
    SH_L[k] = 'rgba(255,248,214,' + (k * 0.04).toFixed(2) + ')';
    SH_D[k] = 'rgba(16,10,48,' + (k * 0.04).toFixed(2) + ')';
  }
  for (let k = 0; k <= 8; k++) {
    VN_L[k] = 'rgba(255,255,170,' + (k * 0.02).toFixed(2) + ')';
    VN_D[k] = 'rgba(8,48,70,' + (k * 0.02).toFixed(2) + ')';
    WN_L[k] = 'rgba(150,215,255,' + (k * 0.02).toFixed(2) + ')';
    WN_D[k] = 'rgba(0,10,48,' + (k * 0.02).toFixed(2) + ')';
  }
  for (let k = 0; k <= 60; k++) SHD[k] = 'rgba(14,10,44,' + (k / 100).toFixed(2) + ')';
  // ragged-edge colours (dark, mid, light) of a neighbouring terrain bleeding into a lower-priority tile
  const BLEED = [];
  BLEED[T.GRASS] = ['#4a8a32', '#5a9e3e', '#6cb04a'];
  BLEED[T.FOREST] = ['#154a24', '#1f5e2e', '#2a7238'];
  BLEED[T.HILL] = ['#86744a', '#9c8a58', '#b4a06c'];
  BLEED[T.MOUNTAIN] = ['#625e72', '#827e92', '#a4a0b4'];
  BLEED[T.SNOW] = ['#d2dff0', '#e8f0fa', '#ffffff'];
  BLEED[T.LAVA] = ['#9a2408', '#d84a12', '#ff9a2a'];
  const PRIO = [0, 0, 1, 2, 3, 4, 5, 6, 7];            // by tile id: who bleeds into whom (higher wins)
  const BLEED_DEPTH = [0, 1, 1, 2];
  const SHORE0 = [], SHORE1 = [];
  for (let t = 0; t < 9; t++) { SHORE0[t] = 'rgba(40,52,30,0.34)'; SHORE1[t] = 'rgba(40,52,30,0.14)'; }
  SHORE0[T.SAND] = 'rgba(150,118,60,0.34)'; SHORE1[T.SAND] = 'rgba(150,118,60,0.15)';
  SHORE0[T.MOUNTAIN] = SHORE0[T.HILL] = 'rgba(30,26,40,0.34)'; SHORE1[T.MOUNTAIN] = SHORE1[T.HILL] = 'rgba(30,26,40,0.14)';
  SHORE0[T.SNOW] = 'rgba(90,110,150,0.36)'; SHORE1[T.SNOW] = 'rgba(90,110,150,0.15)';
  const SHADE_K = [0, 0, 0.8, 1, 0.8, 0.7, 0.55, 0.8, 0];  // slope shading strength per tile type
  const CASTER = [0, 0, 0, 0, 0, 0.7, 1, 1, 0];             // cliff-shadow strength cast by a tile
  const RECEIVER = [0, 0, 1, 1, 1, 0.5, 0, 0, 0];            // how much of a cliff shadow a tile shows
  const sgv = new Float32Array(9);

  // ------------------------------------------------------------------ terrain bake
  function tAt(x, y, self) { return (x < 0 || y < 0 || x >= W || y >= H) ? self : tileArr[y * W + x]; }
  function ihash(a, b, c) {
    let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function vlat(ix, iy, s) { return (ihash(ix, iy, s) & 1023) / 1023; }
  function vnoise(x, y, s, cell, wrap) {            // smooth value noise, lattice spacing `cell`, optional lattice period `wrap`
    const fx = x / cell, fy = y / cell, ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    let ix1 = ix + 1, iy1 = iy + 1, ix0 = ix, iy0 = iy;
    if (wrap) { ix0 = ((ix % wrap) + wrap) % wrap; iy0 = ((iy % wrap) + wrap) % wrap; ix1 = (ix0 + 1) % wrap; iy1 = (iy0 + 1) % wrap; }
    const a = vlat(ix0, iy0, s), b = vlat(ix1, iy0, s), c = vlat(ix0, iy1, s), d = vlat(ix1, iy1, s);
    const top = a + (b - a) * tx, bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  }
  // rectangle hugging one side of a tile: side 0 N, 1 E, 2 S, 3 W; d = depth from the edge, k..k+len along it, th thick
  function rectSide(c, px, py, side, d, k, len, th) {
    switch (side) {
      case 0: c.fillRect(px + k, py + d, len, th); break;
      case 1: c.fillRect(px + 16 - d - th, py + k, th, len); break;
      case 2: c.fillRect(px + k, py + 16 - d - th, len, th); break;
      default: c.fillRect(px + d, py + k, th, len); break;
    }
  }
  function foamSide(c, px, py, side, shift) {
    for (let layer = 0; layer < 3; layer++) {
      c.fillStyle = FOAM[layer];
      const runLen = 6 - layer * 2;
      for (let p = -1; p < 3; p++) {
        let a = p * 8 - shift + layer, b = a + runLen;
        if (a < 0) a = 0;
        if (b > 16) b = 16;
        if (b > a) rectSide(c, px, py, side, layer, a, b - a, 1);
      }
    }
  }
  function softSide(c, px, py, side, cols) {
    c.fillStyle = cols[0]; rectSide(c, px, py, side, 0, 0, 16, 2);
    c.fillStyle = cols[1]; rectSide(c, px, py, side, 2, 0, 16, 2);
    c.fillStyle = cols[2]; rectSide(c, px, py, side, 4, 0, 16, 2);
  }
  function bleedSide(c, px, py, x, y, side, bt) {
    const cols = BLEED[bt];
    if (!cols) return;
    const hs = ihash(x * 4 + side, y, 7771);
    for (let k = 0; k < 16; k++) {
      const hh = (Math.imul(hs ^ Math.imul(k + 1, 0x9E3779B1), 0x85EBCA6B) >>> 12) & 255;
      const d = BLEED_DEPTH[hh & 3];
      if (d === 0) continue;
      c.fillStyle = cols[(hh >> 2) % 3];
      rectSide(c, px, py, side, 0, k, 1, d);
    }
  }
  function shadeAtTile(x, y) {
    const xl = x > 0 ? x - 1 : x, xr = x < W - 1 ? x + 1 : x, yu = y > 0 ? y - 1 : y, yd = y < H - 1 ? y + 1 : y;
    const e = elevArr;
    return (e[y * W + xr] - e[y * W + xl] + e[yd * W + x] - e[yu * W + x]) * 0.5;
  }
  // 4x4 px blocks of light/dark from the elevation field, bilinear between tile centres so tile seams vanish
  function shadeBlocks(c, px, py, x, y, t) {
    const k = SHADE_K[t] * 0.0065;
    if (k === 0) return;
    let mx = 0;
    for (let j = -1; j <= 1; j++) {
      const yy = clamp(y + j, 0, H - 1);
      for (let i = -1; i <= 1; i++) {
        const v = shadeAtTile(clamp(x + i, 0, W - 1), yy) * k;
        sgv[(j + 1) * 3 + i + 1] = v;
        if (v > mx) mx = v; else if (-v > mx) mx = -v;
      }
    }
    if (mx < 0.02) return;
    for (let bj = 0; bj < 4; bj++) {
      const v = (bj + 0.5) / 4 - 0.5, wt = v < 0 ? -v : 0, wb = v > 0 ? v : 0, wc = 1 - wt - wb;
      for (let bi = 0; bi < 4; bi++) {
        const u = (bi + 0.5) / 4 - 0.5, wl = u < 0 ? -u : 0, wr = u > 0 ? u : 0, wm = 1 - wl - wr;
        const r0 = sgv[0] * wl + sgv[1] * wm + sgv[2] * wr;
        const r1 = sgv[3] * wl + sgv[4] * wm + sgv[5] * wr;
        const r2 = sgv[6] * wl + sgv[7] * wm + sgv[8] * wr;
        const a = r0 * wt + r1 * wc + r2 * wb;
        const q = Math.round((a < 0 ? -a : a) * 25);
        if (q === 0) continue;
        c.fillStyle = a > 0 ? SH_L[q > 5 ? 5 : q] : SH_D[q > 5 ? 5 : q];
        c.fillRect(px + bi * 4, py + bj * 4, 4, 4);
      }
    }
  }

  // Tiles are composed on a tiny scratch canvas and blitted into the big caches: reading from a big canvas that is
  // being modified forces a full-surface copy per drawImage (seconds for a whole map), reading from a 16x16 one is free.
  function paintTo(f, x, y, i, t, h) {
    const c = scr, px = 0, py = 0;
    const look = h & 7;
    Sprites.drawTile(c, t, px, py, 16, look | (f << 3));
    const nN = tAt(x, y - 1, t), nE = tAt(x + 1, y, t), nS = tAt(x, y + 1, t), nW = tAt(x - 1, y, t);

    if (t <= T.SHALLOW) {
      // ---------------- water
      const vn = vnoise(x + 0.5, y + 0.5, seedV + 17, 6, 0);
      const q = Math.round((vn - 0.5) * 0.2 * 50);
      if (q !== 0) { c.fillStyle = q > 0 ? WN_L[Math.min(8, q)] : WN_D[Math.min(8, -q)]; c.fillRect(px, py, 16, 16); }
      const fs = f * 3;
      const sN = nN >= T.SAND && nN !== T.LAVA, sE = nE >= T.SAND && nE !== T.LAVA, sS = nS >= T.SAND && nS !== T.LAVA, sW = nW >= T.SAND && nW !== T.LAVA;
      if (t === T.DEEP) {
        if (nN === T.SHALLOW) softSide(c, px, py, 0, DEEP_TO_SHALLOW);
        if (nE === T.SHALLOW) softSide(c, px, py, 1, DEEP_TO_SHALLOW);
        if (nS === T.SHALLOW) softSide(c, px, py, 2, DEEP_TO_SHALLOW);
        if (nW === T.SHALLOW) softSide(c, px, py, 3, DEEP_TO_SHALLOW);
      } else {
        if (nN === T.DEEP) softSide(c, px, py, 0, SHALLOW_TO_DEEP);
        if (nE === T.DEEP) softSide(c, px, py, 1, SHALLOW_TO_DEEP);
        if (nS === T.DEEP) softSide(c, px, py, 2, SHALLOW_TO_DEEP);
        if (nW === T.DEEP) softSide(c, px, py, 3, SHALLOW_TO_DEEP);
      }
      if (sN) foamSide(c, px, py, 0, (fs + (ihash(y, 0, seedV) & 7)) & 7);
      if (sS) foamSide(c, px, py, 2, (fs + (ihash(y + 1, 0, seedV) & 7)) & 7);
      if (sE) foamSide(c, px, py, 1, (fs + (ihash(x + 1, 1, seedV) & 7)) & 7);
      if (sW) foamSide(c, px, py, 3, (fs + (ihash(x, 1, seedV) & 7)) & 7);
      // diagonal-only shore: little foam corner
      c.fillStyle = FOAM[0];
      if (!sN && !sE) { const d = tAt(x + 1, y - 1, t); if (d >= T.SAND && d !== T.LAVA) c.fillRect(px + 14, py, 2, 2); }
      if (!sS && !sE) { const d = tAt(x + 1, y + 1, t); if (d >= T.SAND && d !== T.LAVA) c.fillRect(px + 14, py + 14, 2, 2); }
      if (!sS && !sW) { const d = tAt(x - 1, y + 1, t); if (d >= T.SAND && d !== T.LAVA) c.fillRect(px, py + 14, 2, 2); }
      if (!sN && !sW) { const d = tAt(x - 1, y - 1, t); if (d >= T.SAND && d !== T.LAVA) c.fillRect(px, py, 2, 2); }
      return;
    }
    if (t === T.LAVA) {
      if (nN !== T.LAVA && nN <= T.SHALLOW) { c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(px, py, 16, 1); }
      return;
    }

    // ---------------- land
    if (t === T.GRASS || t === T.SAND || t === T.FOREST) {
      const vn = vnoise(x + 0.5, y + 0.5, seedV + 5, 6, 0);
      const q = Math.round((vn - 0.5) * 0.17 * 50);
      if (q !== 0) { c.fillStyle = q > 0 ? VN_L[Math.min(8, q)] : VN_D[Math.min(8, -q)]; c.fillRect(px, py, 16, 16); }
    }
    if (t === T.FOREST) {                                  // thinning forest shows clearings of grass
      const band = amtArr[i] >> 5;                         // World re-marks the tile whenever this band changes
      const n = band >= 2 ? 0 : band === 1 ? 2 : 4;
      for (let q = 0; q < n; q++) {
        const hq = ihash(x, y, 31 + q), bx = hq % 11, by = (hq >>> 8) % 11, sz = 4 + ((hq >>> 16) & 1);
        c.drawImage(atlasCv, ((h >> 3) & 7) * 16 + bx, T.GRASS * 16 + by, sz, sz, px + bx, py + by, sz, sz);
      }
    }
    if (PRIO[nN] > PRIO[t] && nN >= T.GRASS) bleedSide(c, px, py, x, y, 0, nN);
    if (PRIO[nE] > PRIO[t] && nE >= T.GRASS) bleedSide(c, px, py, x, y, 1, nE);
    if (PRIO[nS] > PRIO[t] && nS >= T.GRASS) bleedSide(c, px, py, x, y, 2, nS);
    if (PRIO[nW] > PRIO[t] && nW >= T.GRASS) bleedSide(c, px, py, x, y, 3, nW);
    shadeBlocks(c, px, py, x, y, t);
    // coast line on the land side
    if (nN <= T.SHALLOW) { c.fillStyle = SHORE0[t]; rectSide(c, px, py, 0, 0, 0, 16, 1); c.fillStyle = SHORE1[t]; rectSide(c, px, py, 0, 1, 0, 16, 1); }
    if (nE <= T.SHALLOW) { c.fillStyle = SHORE0[t]; rectSide(c, px, py, 1, 0, 0, 16, 1); c.fillStyle = SHORE1[t]; rectSide(c, px, py, 1, 1, 0, 16, 1); }
    if (nS <= T.SHALLOW) { c.fillStyle = SHORE0[t]; rectSide(c, px, py, 2, 0, 0, 16, 1); c.fillStyle = SHORE1[t]; rectSide(c, px, py, 2, 1, 0, 16, 1); }
    if (nW <= T.SHALLOW) { c.fillStyle = SHORE0[t]; rectSide(c, px, py, 3, 0, 0, 16, 1); c.fillStyle = SHORE1[t]; rectSide(c, px, py, 3, 1, 0, 16, 1); }
    // tiny cliff shadows: light from the top-left, so shade falls on the tile south / east of a mountain
    const rw = RECEIVER[t];
    if (rw > 0) {
      let s = CASTER[nN] * rw;
      if (s > 0.05 && !(nN === t)) {
        c.fillStyle = SHD[Math.round(44 * s)]; rectSide(c, px, py, 0, 0, 0, 16, 1);
        c.fillStyle = SHD[Math.round(28 * s)]; rectSide(c, px, py, 0, 1, 0, 16, 1);
        c.fillStyle = SHD[Math.round(14 * s)]; rectSide(c, px, py, 0, 2, 0, 16, 1);
        c.fillStyle = SHD[Math.round(6 * s)]; rectSide(c, px, py, 0, 3, 0, 16, 1);
      }
      s = CASTER[nW] * rw * 0.6;
      if (s > 0.05 && !(nW === t)) {
        c.fillStyle = SHD[Math.round(44 * s)]; rectSide(c, px, py, 3, 0, 0, 16, 1);
        c.fillStyle = SHD[Math.round(22 * s)]; rectSide(c, px, py, 3, 1, 0, 16, 1);
        c.fillStyle = SHD[Math.round(8 * s)]; rectSide(c, px, py, 3, 2, 0, 16, 1);
      }
    }
    // baked features
    const rk = resArr[i];
    if (rk !== 0 && rk !== RES.FISH) {
      const hh = h >>> 3;
      let v;
      if (rk === RES.TREE) { const a = amtArr[i]; v = a < 24 ? 0 : a < 44 ? 1 : ((hh & 1) ? 3 : 2); }
      else if (rk === RES.BERRY) v = amtArr[i] === 0 ? 9 : (hh & 3);
      else v = hh & 3;
      c.drawImage(Sprites.feature(rk, v), px, py);
    }
  }

  function blit(f, x, y, doMip) {
    tc[f].drawImage(scrCv, 0, 0, 16, 16, x * P, y * P, P, P);
    if (doMip) { const hp = P >> 1; mc[f].drawImage(scrCv, 0, 0, 16, 16, x * hp, y * hp, hp, hp); }
  }
  function paintTile(x, y, doMip) {
    const i = y * W + x, t = tileArr[i];
    const h = Util.hash2(x, y, seedV);                    // per-tile look variant
    paintTo(0, x, y, i, t, h);
    blit(0, x, y, doMip);
    if (t === T.DEEP || t === T.SHALLOW || t === T.LAVA) paintTo(1, x, y, i, t, h);
    blit(1, x, y, doMip);
    glint[i] = (t <= T.SHALLOW && (h >>> 9) % 9 === 0) ? 1 + ((h >>> 13) % 250) : 0;
  }

  let allocW = 0, allocH = 0;
  function allocWorld() {
    W = S.w; H = S.h;
    const same = allocW === W && allocH === H && terr[0] && terr[1] && mip[0] && mip[1] && ocean[0];
    for (let attempt = 0; attempt < 2 && !same; attempt++) {
      P = (W * 16 > 4096 || H * 16 > 4096 || W * H * 256 > 14e6 || attempt === 1) ? 8 : 16;
      try {
        const hp = P >> 1;
        for (let f = 0; f < 2; f++) {
          terr[f] = mk(W * P, H * P);
          tc[f] = terr[f].getContext('2d', { alpha: false });
          tc[f].imageSmoothingEnabled = P !== 16;
          mip[f] = mk(W * hp, H * hp);
          mc[f] = mip[f].getContext('2d', { alpha: false });
          mc[f].imageSmoothingEnabled = true;
          try { mc[f].imageSmoothingQuality = 'high'; } catch (e) { /* ignore */ }
        }
        if (tc[0] && tc[1] && mc[0] && mc[1]) break;
      } catch (e) { report('alloc', e); }
    }
    if (!same) {                                           // a world of a different size: start from a centred overview
      const cam = api.cam;
      cam.x = W / 2; cam.y = H / 2; cam.zoom = Math.max(minZoom() * 1.6, 7); glide = null; camSerial++;
      clampCam();
    }
    allocW = W; allocH = H;
    glint = new Uint8Array(W * H);
    if (!scrCv) { scrCv = mk(16, 16); scr = scrCv.getContext('2d', { alpha: false }); scr.imageSmoothingEnabled = false; }
    tileArr = S.tile;
    if (!same || !ocean[0]) { try { buildOcean(); } catch (e) { report('ocean', e); ocean[0] = ocean[1] = null; } }
    ovl.ver = -1; ovl.key = null;
    needFull = true;
  }

  function buildOcean() {
    const sd = (S.seed | 0) + 17, bp = 32 * P;
    for (let f = 0; f < 2; f++) {
      const cv = mk(bp, bp), g = cv.getContext('2d', { alpha: false });
      g.imageSmoothingEnabled = P !== 16;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
        const h = ihash(x, y, sd + 99);
        Sprites.drawTile(g, T.DEEP, x * P, y * P, P, (h & 7) | (f << 3));
        const q = Math.round((vnoise(x + 0.5, y + 0.5, sd, 8, 4) - 0.5) * 0.2 * 50);
        if (q !== 0) { g.fillStyle = q > 0 ? WN_L[Math.min(8, q)] : WN_D[Math.min(8, -q)]; g.fillRect(x * P, y * P, P, P); }
      }
      ocean[f] = cv;
      const hp = P >> 1, mc2 = mk(32 * hp, 32 * hp), mg = mc2.getContext('2d', { alpha: false });   // half-res copy for far zoom-outs
      mg.imageSmoothingEnabled = true;
      try { mg.imageSmoothingQuality = 'high'; } catch (e) { /* ignore */ }
      mg.drawImage(cv, 0, 0, bp, bp, 0, 0, 32 * hp, 32 * hp);
      oceanMip[f] = mc2;
    }
  }
  function drawOcean(now) {
    const f = ((now / 480) | 0) & 1, cv = Z < P * 0.7 ? oceanMip[f] : ocean[f];
    if (!cv) return;
    if (ox <= 0 && oy <= 0 && ox + W * Z >= cw && oy + H * Z >= ch) return;      // the map already covers the screen
    const bz = 32 * Z;
    const k0x = Math.floor(-ox / bz), k0y = Math.floor(-oy / bz), k1x = Math.ceil((cw - ox) / bz), k1y = Math.ceil((ch - oy) / bz);
    ctx.imageSmoothingEnabled = Z < P;
    for (let ky = k0y; ky < k1y; ky++) for (let kx = k0x; kx < k1x; kx++) {
      const dx = ox + kx * bz, dy = oy + ky * bz;
      // skip blocks fully hidden behind the map
      if (dx >= ox && dy >= oy && dx + bz <= ox + W * Z && dy + bz <= oy + H * Z) continue;
      ctx.drawImage(cv, dx, dy, bz, bz);
    }
  }

  function bakeAll() {
    atlasCv = Sprites.tileAtlas().canvas;
    elevArr = S.elev; resArr = S.res; amtArr = S.amt; seedV = S.seed | 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) paintTile(x, y, false);
    const hp = P >> 1;
    for (let f = 0; f < 2; f++) {
      mc[f].imageSmoothingEnabled = true;
      mc[f].drawImage(terr[f], 0, 0, W * P, H * P, 0, 0, W * hp, H * hp);
    }
  }

  function syncWorld() {
    if (!S.tile || !S.w || !S.h) return false;
    if (tileArr !== S.tile || W !== S.w || H !== S.h) allocWorld();
    elevArr = S.elev; resArr = S.res; amtArr = S.amt; fireArr = S.fire;
    if (S.allDirty || needFull) {
      bakeAll();
      needFull = false; S.allDirty = false;
      S.dirty.fill(0); S.dirtyList.length = 0;
      return true;
    }
    const L = S.dirtyList, n = L.length;
    if (n > 0) {
      atlasCv = atlasCv || Sprites.tileAtlas().canvas;
      const t0 = performance.now();
      let k = 0;
      while (k < n) {
        const i = L[k++];
        S.dirty[i] = 0;
        const y = (i / W) | 0;
        paintTile(i - y * W, y, true);
        if ((k & 15) === 0 && performance.now() - t0 > 7) break;
      }
      if (k >= n) L.length = 0; else L.splice(0, k);
    }
    return true;
  }

  // ------------------------------------------------------------------ small sprite helpers (flip / tint variants)
  const flipMap = new WeakMap(), darkMap = new WeakMap(), greenMap = new WeakMap();
  function variantOf(cv, kind) {
    const map = kind === 0 ? flipMap : kind === 1 ? darkMap : greenMap;
    let v = map.get(cv);
    if (v) return v;
    v = mk(cv.width, cv.height);
    const g = v.getContext('2d');
    g.imageSmoothingEnabled = false;
    if (kind === 0) { g.translate(cv.width, 0); g.scale(-1, 1); g.drawImage(cv, 0, 0); }
    else {
      g.drawImage(cv, 0, 0);
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = kind === 1 ? 'rgba(40,12,10,0.42)' : 'rgba(60,230,70,0.5)';
      g.fillRect(0, 0, cv.width, cv.height);
    }
    map.set(cv, v);
    return v;
  }

  // flame frames (16x16 pixel art, 4 frames)
  let flames = null;
  function buildFlames() {
    flames = [];
    for (let f = 0; f < 4; f++) {
      const c = mk(16, 16), g = c.getContext('2d');
      const tg = [
        { x: 4.5 + (f === 1 ? 1 : f === 3 ? -1 : 0), w: 3.4, h: 8 + (f & 1) * 2 },
        { x: 8 + (f === 2 ? 1 : f === 0 ? -1 : 0), w: 4.6, h: 13 - (f & 1) * 2 - (f === 3 ? 1 : 0) },
        { x: 11.5 + (f === 0 ? 1 : f === 2 ? -1 : 0), w: 3.4, h: 9 - (f & 1) * 2 + (f === 3 ? 1 : 0) },
      ];
      g.fillStyle = 'rgba(255,120,30,0.28)'; g.fillRect(1, 11, 14, 5);
      for (let x = 1; x < 15; x++) {
        let hh = 0, ax = 8;
        for (let k = 0; k < 3; k++) {
          const d = Math.abs(x + 0.5 - tg[k].x) / tg[k].w;
          if (d < 1) { const hv = tg[k].h * (1 - d * d * 0.85); if (hv > hh) { hh = hv; ax = tg[k].x; } }
        }
        const top = Math.round(15 - hh);
        for (let y = top; y < 16; y++) {
          const yh = (15 - y) / Math.max(1, hh), dx = Math.abs(x + 0.5 - ax) / 3;
          let col;
          if (yh > 0.78) col = '#c8281a';
          else if (dx < 0.45 && yh < 0.5) col = '#ffe680';
          else if (dx < 0.8 && yh < 0.72) col = '#ffb02a';
          else col = '#f0641c';
          if (y === top && ((x + f) & 1)) continue;
          g.fillStyle = col; g.fillRect(x, y, 1, 1);
        }
      }
      g.fillStyle = '#ffd23c'; g.fillRect(2 + f * 3, 2 + (f & 1) * 3, 1, 1); g.fillRect(12 - f * 2, 1 + ((f + 1) & 1) * 2, 1, 1);
      flames.push(c);
    }
  }

  // ------------------------------------------------------------------ camera
  const api = {
    cam: { x: 48, y: 48, zoom: 8 },
    mode: MODE.NORMAL,
    highlight: null,
    brush: null,
    stats: { fps: 60, drawMs: 0, visibleUnits: 0, visibleTiles: 0 },
    pad,
  };

  function minZoom() {
    if (!S.w || !S.h) return MINZ_ABS;
    return Math.max(MINZ_ABS, Math.min(cssW / S.w, cssH / S.h));
  }
  function clampCam() {
    const cam = api.cam;
    if (!(cam.zoom > 0)) cam.zoom = 8;
    cam.zoom = clamp(cam.zoom, minZoom(), MAXZ);
    if (!S.w || !S.h) return;
    const vw = cssW / cam.zoom, vh = cssH / cam.zoom;
    const pl = pad.l / cam.zoom, pr = pad.r / cam.zoom, pt = pad.t / cam.zoom, pb = pad.b / cam.zoom;
    let lo = vw / 2 - pl, hi = S.w + pr - vw / 2;
    cam.x = lo > hi ? S.w / 2 + (pr - pl) / 2 : clamp(cam.x, lo, hi);
    lo = vh / 2 - pt; hi = S.h + pb - vh / 2;
    cam.y = lo > hi ? S.h / 2 + (pb - pt) / 2 : clamp(cam.y, lo, hi);
  }
  function screenToTile(sx, sy) {
    const cam = api.cam;
    return { x: cam.x + (sx - cssW / 2) / cam.zoom, y: cam.y + (sy - cssH / 2) / cam.zoom };
  }
  function tileToScreen(tx, ty) {
    const cam = api.cam;
    return { x: (tx - cam.x) * cam.zoom + cssW / 2, y: (ty - cam.y) * cam.zoom + cssH / 2 };
  }
  let camSerial = 0;     // bumped by programmatic camera changes (Input drops its inertia when it changes)
  function setCamera(x, y, zoom) {
    const cam = api.cam;
    glide = null; camSerial++;
    if (x === x) cam.x = x;
    if (y === y) cam.y = y;
    if (zoom === zoom && zoom > 0) cam.zoom = zoom;
    clampCam();
  }
  function panBy(dx, dy) {   // css px: the map content follows the finger
    const cam = api.cam;
    glide = null;
    cam.x -= dx / cam.zoom; cam.y -= dy / cam.zoom;
    const x0 = cam.x, y0 = cam.y;
    clampCam();
    return Math.abs(cam.x - x0) + Math.abs(cam.y - y0) < 1e-9;   // true when nothing was clamped
  }
  function zoomAt(newZoom, sx, sy) {   // keep the tile under (sx,sy) fixed
    const cam = api.cam;
    glide = null;
    const wx = cam.x + (sx - cssW / 2) / cam.zoom, wy = cam.y + (sy - cssH / 2) / cam.zoom;
    cam.zoom = clamp(newZoom, minZoom(), MAXZ);
    cam.x = wx - (sx - cssW / 2) / cam.zoom;
    cam.y = wy - (sy - cssH / 2) / cam.zoom;
    clampCam();
  }
  function focusOn(x, y, zoom, instant) {
    const cam = api.cam;
    const z1 = zoom > 0 ? clamp(zoom, minZoom(), MAXZ) : cam.zoom;
    camSerial++;
    if (instant || !ctx) { glide = null; cam.x = x; cam.y = y; cam.zoom = z1; clampCam(); return; }
    glide = { x0: cam.x, y0: cam.y, z0: cam.zoom, x1: x, y1: y, z1, t0: performance.now(), dur: 380 };
  }
  function stepGlide() {
    if (!glide) return;
    const cam = api.cam, g = glide;
    let p = (performance.now() - g.t0) / g.dur;
    if (p >= 1) { p = 1; glide = null; }
    const e = 1 - Math.pow(1 - p, 3);
    cam.zoom = g.z0 * Math.pow(g.z1 / g.z0, e);
    if (g.anchor) {                                    // zoom-only glide: keep the tile under (sx,sy) fixed
      cam.x = g.wx - (g.sx - cssW / 2) / cam.zoom;
      cam.y = g.wy - (g.sy - cssH / 2) / cam.zoom;
    } else {
      cam.x = g.x0 + (g.x1 - g.x0) * e;
      cam.y = g.y0 + (g.y1 - g.y0) * e;
    }
    clampCam();
  }
  // Pixel art is only perfectly even when one texel is a whole number of device pixels (or the 8px mip at 1:1).
  // After a gesture ends, a zoom within ~9% of such a value eases onto it.
  function crispZoom(z) {
    const m = z * dpr / 16, cands = [0.5, 1, 2, 3, 4, 5, 6];
    let best = 0, bd = 1e9;
    for (let i = 0; i < cands.length; i++) { const r = Math.abs(m - cands[i]) / cands[i]; if (r < bd) { bd = r; best = cands[i]; } }
    if (bd > 0.09) return 0;
    const zc = best * 16 / dpr;
    return (zc < minZoom() - 1e-6 || zc > MAXZ + 1e-6) ? 0 : zc;
  }
  function settleZoom(sx, sy) {
    const cam = api.cam, z1 = crispZoom(cam.zoom);
    if (!z1 || Math.abs(z1 - cam.zoom) < 0.005 || glide) return false;
    if (sx === undefined) sx = cssW / 2;
    if (sy === undefined) sy = cssH / 2;
    const w = screenToTile(sx, sy);
    glide = { anchor: true, z0: cam.zoom, z1, sx, sy, wx: w.x, wy: w.y, t0: performance.now(), dur: 150 };
    return true;
  }

  function init(c) {
    canvas = c;
    ctx = canvas.getContext('2d', { alpha: false });
    Sprites.init();
    if (!flames) buildFlames();
    const r = canvas.getBoundingClientRect();
    resize((r && r.width) || window.innerWidth || 390, (r && r.height) || window.innerHeight || 844, window.devicePixelRatio || 1);
    if (S.w) { const cam = api.cam; cam.x = S.w / 2; cam.y = S.h / 2; cam.zoom = Math.max(minZoom() * 1.6, 7); clampCam(); }
    else { api.cam.zoom = 7; }
  }
  function resize(w, h, ratio) {
    w = +w; h = +h; ratio = +ratio;
    if (!(w > 0) || !(h > 0)) return;
    cssW = w; cssH = h;
    dpr = clamp(ratio > 0 ? ratio : 1, 1, 2);
    cw = Math.max(1, Math.round(cssW * dpr)); ch = Math.max(1, Math.round(cssH * dpr));
    if (canvas) {
      if (canvas.width !== cw) canvas.width = cw;
      if (canvas.height !== ch) canvas.height = ch;
      canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
      ctx = canvas.getContext('2d', { alpha: false });
    }
    clampCam();
    labelCache.clear();
  }
  function setMode(m) { api.mode = m; ovl.ver = -1; }
  function invalidate() { needFull = true; ovl.ver = -1; }

  // ------------------------------------------------------------------ overlay (territory / culture)
  const ovl = { fill: null, fctx: null, ver: -1, key: null, mode: -1, built: 0, groups: [], inner: null, w: 0, h: 0 };
  let regA = null;
  const packCache = new Map();
  function packColor(str, alpha) {
    const key = str + alpha;
    let v = packCache.get(key);
    if (v !== undefined) return v;
    let r = 128, g = 128, b = 128;
    if (typeof str === 'string' && str.charCodeAt(0) === 35 && str.length >= 7) { r = parseInt(str.slice(1, 3), 16); g = parseInt(str.slice(3, 5), 16); b = parseInt(str.slice(5, 7), 16); }
    v = ((Math.round(alpha * 255) << 24) | (b << 16) | (g << 8) | r) >>> 0;
    packCache.set(key, v);
    return v;
  }
  function darken(str, f) {
    if (typeof str !== 'string' || str.charCodeAt(0) !== 35 || str.length < 7) return '#333';
    const r = Math.round(parseInt(str.slice(1, 3), 16) * f), g = Math.round(parseInt(str.slice(3, 5), 16) * f), b = Math.round(parseInt(str.slice(5, 7), 16) * f);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  function addRun(map, key, x0, y0, x1, y1, nx, ny) {
    let a = map.get(key);
    if (!a) { a = []; map.set(key, a); }
    a.push(x0, y0, x1, y1, nx, ny);
  }
  function buildOverlay(mode) {
    const w = W, h = H, n = w * h;
    if (!ovl.fill || ovl.w !== w || ovl.h !== h) { ovl.fill = mk(w, h); ovl.fctx = ovl.fill.getContext('2d'); ovl.w = w; ovl.h = h; }
    if (!regA || regA.length !== n) regA = new Int32Array(n);
    const img = ovl.fctx.createImageData(w, h);
    const px = new Uint32Array(img.data.buffer);
    const own = S.owner, reg = regA;
    const keyColor = new Map();
    const cityEntry = new Map();
    const alpha = mode === MODE.CULTURE ? 0.4 : 0.3;
    let lastO = -1, lastKey = 0, lastPx = 0;
    for (let i = 0; i < n; i++) {
      const o = own[i];
      if (o === 0) { reg[i] = 0; continue; }
      if (o !== lastO) {
        let e = cityEntry.get(o);
        if (e === undefined) {
          const city = S.cities.get(o);
          let key = 0, col = null;
          if (city) {
            if (mode === MODE.CULTURE) { const cu = S.cultures[city.culture | 0]; key = (city.culture | 0) + 1; col = cu ? cu.color : '#b0b8c0'; }
            else { const k = S.kingdoms.get(city.kingdomId); if (k) { key = k.id; col = k.color; } else { key = 1000000 + city.id; col = '#a8b0b8'; } }
          }
          e = { key, p: col ? packColor(col, alpha) : 0 };
          if (col && !keyColor.has(key)) keyColor.set(key, col);
          cityEntry.set(o, e);
        }
        lastO = o; lastKey = e.key; lastPx = e.p;
      }
      reg[i] = lastKey; px[i] = lastPx;
    }
    ovl.fctx.putImageData(img, 0, 0);

    // outer borders (per side of the owning region, inward normal) merged into runs
    const runs = new Map();
    for (let y = 0; y <= h; y++) {
      let curT = 0, stT = 0, curB = 0, stB = 0;
      for (let x = 0; x <= w; x++) {
        let kt = 0, kb = 0;
        if (x < w) {
          const top = y > 0 ? reg[(y - 1) * w + x] : 0, bot = y < h ? reg[y * w + x] : 0;
          if (top !== bot) { kt = top; kb = bot; }
        }
        if (kt !== curT) { if (curT) addRun(runs, curT, stT, y, x, y, 0, -1); curT = kt; stT = x; }
        if (kb !== curB) { if (curB) addRun(runs, curB, stB, y, x, y, 0, 1); curB = kb; stB = x; }
      }
    }
    for (let x = 0; x <= w; x++) {
      let curL = 0, stL = 0, curR = 0, stR = 0;
      for (let y = 0; y <= h; y++) {
        let kl = 0, kr = 0;
        if (y < h) {
          const left = x > 0 ? reg[y * w + x - 1] : 0, right = x < w ? reg[y * w + x] : 0;
          if (left !== right) { kl = left; kr = right; }
        }
        if (kl !== curL) { if (curL) addRun(runs, curL, x, stL, x, y, -1, 0); curL = kl; stL = y; }
        if (kr !== curR) { if (curR) addRun(runs, curR, x, stR, x, y, 1, 0); curR = kr; stR = y; }
      }
    }
    const groups = [];
    runs.forEach((arr, key) => { groups.push({ key, color: keyColor.get(key) || '#ffffff', dark: darken(keyColor.get(key), 0.62), seg: new Float32Array(arr) }); });
    ovl.groups = groups;
    // dashed lines between cities of one kingdom
    ovl.inner = null;
    if (mode === MODE.BORDERS) {
      const inn = [];
      for (let y = 1; y < h; y++) {
        let st = -1;
        for (let x = 0; x <= w; x++) {
          let ok = false;
          if (x < w) { const a = own[(y - 1) * w + x], b = own[y * w + x]; ok = a !== b && a !== 0 && b !== 0 && reg[(y - 1) * w + x] === reg[y * w + x] && reg[y * w + x] !== 0; }
          if (ok && st < 0) st = x; else if (!ok && st >= 0) { inn.push(st, y, x, y); st = -1; }
        }
      }
      for (let x = 1; x < w; x++) {
        let st = -1;
        for (let y = 0; y <= h; y++) {
          let ok = false;
          if (y < h) { const a = own[y * w + x - 1], b = own[y * w + x]; ok = a !== b && a !== 0 && b !== 0 && reg[y * w + x - 1] === reg[y * w + x] && reg[y * w + x] !== 0; }
          if (ok && st < 0) st = y; else if (!ok && st >= 0) { inn.push(x, st, x, y); st = -1; }
        }
      }
      if (inn.length) ovl.inner = new Float32Array(inn);
    }
    ovl.ver = S.ownerVer; ovl.key = S.owner; ovl.mode = mode; ovl.built = performance.now();
  }
  function ensureOverlay(mode) {
    const now = performance.now();
    const stale = ovl.mode !== mode || ovl.key !== S.owner || ovl.w !== W || ovl.h !== H || !ovl.fill;
    if (!stale && ovl.ver === S.ownerVer) return;
    if (!stale && now - ovl.built < 260) return;         // throttle rebuilds while territory keeps changing
    buildOverlay(mode);
  }
  function strokeRuns(arr, lw, offMul, culture) {
    const off = lw * offMul;
    ctx.beginPath();
    let any = false;
    for (let k = 0; k < arr.length; k += 6) {
      const x0 = arr[k], y0 = arr[k + 1], x1 = arr[k + 2], y1 = arr[k + 3];
      if (x1 < vx0 - 1 || x0 > vx1 + 1 || y1 < vy0 - 1 || y0 > vy1 + 1) continue;
      const nx = arr[k + 4] * off, ny = arr[k + 5] * off;
      ctx.moveTo(ox + x0 * Z + nx, oy + y0 * Z + ny);
      ctx.lineTo(ox + x1 * Z + nx, oy + y1 * Z + ny);
      any = true;
    }
    if (any) ctx.stroke();
  }
  function drawOverlay(mode) {
    if (vx1 <= vx0 || vy1 <= vy0) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(ovl.fill, vx0, vy0, vx1 - vx0, vy1 - vy0, ox + vx0 * Z, oy + vy0 * Z, (vx1 - vx0) * Z, (vy1 - vy0) * Z);
    const culture = mode === MODE.CULTURE;
    const lw = (culture ? 1.5 : 2) * dpr;
    ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
    const gs = ovl.groups;
    for (let g = 0; g < gs.length; g++) {
      const gr = gs[g];
      ctx.strokeStyle = gr.color;
      ctx.globalAlpha = culture ? 0.16 : 0.2; ctx.lineWidth = lw * 3.4; strokeRuns(gr.seg, lw * 3.4, 0.5, culture);
      ctx.globalAlpha = 1; ctx.lineWidth = lw; strokeRuns(gr.seg, lw, 0.5, culture);
    }
    if (ovl.inner) {
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.lineCap = 'butt';
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5 * dpr;
      const arr = ovl.inner;
      ctx.beginPath();
      let any = false;
      for (let k = 0; k < arr.length; k += 4) {
        const x0 = arr[k], y0 = arr[k + 1], x1 = arr[k + 2], y1 = arr[k + 3];
        if (x1 < vx0 - 1 || x0 > vx1 + 1 || y1 < vy0 - 1 || y0 > vy1 + 1) continue;
        ctx.moveTo(ox + x0 * Z, oy + y0 * Z); ctx.lineTo(ox + x1 * Z, oy + y1 * Z); any = true;
      }
      if (any) ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.lineCap = 'butt';
  }

  // ------------------------------------------------------------------ entity queue (bucket sorted by y)
  let itCap = 2048, itObj = new Array(itCap), itKind = new Uint8Array(itCap), itX = new Float32Array(itCap), itY = new Float32Array(itCap), itNext = new Int32Array(itCap);
  let itN = 0, bandHead = new Int32Array(1024), bandTop = 0, bandN = 0;
  function growItems() {
    const nc = itCap * 2;
    const k = new Uint8Array(nc); k.set(itKind); itKind = k;
    const xs = new Float32Array(nc); xs.set(itX); itX = xs;
    const ys = new Float32Array(nc); ys.set(itY); itY = ys;
    const nx = new Int32Array(nc); nx.set(itNext); itNext = nx;
    itObj.length = nc;
    itCap = nc;
  }
  // (queue insertion is written out inline in drawEntities: passing float arguments to a helper boxes them)

  const RACE_COL = ['#4aa3ff', '#6fbf3a', '#c78bff'];
  const CARRY_COL = { food: '#ff6a5a', wood: '#b07a40', stone: '#c4ccd8', iron: '#8aa0c8', gold: '#ffd23c' };

  function stageOf(u) {
    if (useUnitsStage === -1) useUnitsStage = (typeof Units !== 'undefined' && Units && !Units.__stub && typeof Units.stage === 'function') ? 1 : 0;
    if (useUnitsStage === 1) { const s = Units.stage(u); if (s === 'child' || s === 'adult' || s === 'elder') return s; }
    const r = Races.list[u.race];
    if (!r) return 'adult';
    const age = (S.tick - u.born) / Const.TICKS_PER_YEAR;
    return age < r.maturity ? 'child' : age > r.lifespan[0] * 0.82 ? 'elder' : 'adult';
  }

  let crownCv = null;
  function crownIcon() { return crownCv || (crownCv = Sprites.icon('crown', 16)); }
  function drawFlame(cx, bottom, size, phase) {
    const f = flames[phase & 3];
    ctx.drawImage(f, Math.round(cx - size / 2), Math.round(bottom - size), size, size);
  }

  function drawZ(x, y, s, now, seed) {                     // little floating "z z" (3x3 pixel glyph with a dark rim)
    for (let k = 0; k < 2; k++) {
      const p = ((now / 1500) + seed * 0.37 + k * 0.5) % 1;
      const zs = Math.max(2, Math.round(s * (0.9 + k * 0.5))), zx = Math.round(x + p * s * 3 + k * s * 2), zy = Math.round(y - p * s * 6);
      ctx.globalAlpha = Math.sin(p * Math.PI);
      ctx.fillStyle = '#1b2a4a';
      ctx.fillRect(zx - 1, zy - 1, zs * 3 + 2, zs * 3 + 2);
      ctx.fillStyle = '#eaf4ff';
      ctx.fillRect(zx, zy, zs * 3, zs);
      ctx.fillRect(zx + zs, zy + zs, zs, zs);
      ctx.fillRect(zx, zy + zs * 2, zs * 3, zs);
    }
    ctx.globalAlpha = 1;
  }

  function drawUnitSprite(u, k) {
    const ix = itX[k], iy = itY[k] - 0.4;
    const kd = u.kingdomId ? S.kingdoms.get(u.kingdomId) : null;
    const moving = (u.x - u.px) * (u.x - u.px) + (u.y - u.py) * (u.y - u.py) > 1e-6;
    const frame = moving ? (((curNow / 180 + u.id) | 0) & 1) : 0;
    const stage = stageOf(u);
    let spr = Sprites.unit(u.race, stage, frame, kd ? kd.color : null, u.weapon, u.armor, u.id & 3);
    const sick = u.sick > S.tick;
    if (u.face < 0) spr = variantOf(spr, 0);
    if (sick) spr = variantOf(spr, 2);
    const sz = 16 * texel;
    const sx = Math.round(ox + ix * Z), sy = Math.round(oy + (iy + 0.55) * Z);
    const left = sx - (sz >> 1), top = sy - sz;
    ctx.drawImage(spr, left, top, sz, sz);
    if (zoomCss >= 9 && u.carry) {
      const c = CARRY_COL[u.carry];
      if (c) { ctx.fillStyle = c; const s2 = Math.max(2, texel * 2); ctx.fillRect(sx + (u.face < 0 ? -5 : 3) * texel, sy - 7 * texel, s2, s2); }
    }
    if (u.burning > S.tick && flames) drawFlame(sx, sy - 2 * texel, Math.max(8, Math.round(sz * 0.8)), ((curNow / 110) | 0) + u.id);
    if (u.state === 'sleep') drawZ(sx + 3 * texel, top + 3 * texel, Math.max(1, Math.round(texel * 0.8)), curNow, u.id);
    if (u.hp < u.maxHp && zoomCss >= 12) {
      const bw = Math.round(sz * 0.8), bh = Math.max(2, Math.round(texel * 1.2)), bx = sx - (bw >> 1), by = top - bh - 2;
      const f = u.hp > 0 ? u.hp / u.maxHp : 0;
      ctx.fillStyle = 'rgba(8,8,16,0.8)'; ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = f > 0.55 ? '#5be05a' : f > 0.28 ? '#f2c230' : '#ee4a44';
      ctx.fillRect(bx, by, Math.max(1, Math.round(bw * f)), bh);
    }
    if (u.isRuler && zoomCss >= 6) {
      const cs = Math.max(6, Math.round(texel * 8)), cv = crownIcon();
      ctx.drawImage(cv, sx - (cs >> 1), top - Math.round(cs * 0.55) - (u.hp < u.maxHp && zoomCss >= 12 ? Math.max(2, Math.round(texel * 1.2)) + 3 : 0), cs, cs);
    }
    if (u.buffUntil > S.tick && zoomCss >= 8) {
      const tw = (curNow / 160 + u.id) % 4;
      ctx.fillStyle = '#ffe36e';
      const s2 = Math.max(1, Math.round(texel));
      ctx.fillRect(sx + Math.round((tw - 2) * texel * 2), top + Math.round((tw & 1) * texel * 2), s2, s2 * 2);
      ctx.fillRect(sx + Math.round((tw - 1) * texel * 2), top + Math.round((1 - (tw & 1)) * texel * 3), s2, s2 * 2);
    }
  }

  function drawBuildingSprite(b) {
    const city = S.cities.get(b.cityId);
    const kd = city && city.kingdomId ? S.kingdoms.get(city.kingdomId) : null;
    let spr = Sprites.building(b.type, city ? city.race : 0, b.level || 1, !!b.done, kd ? kd.color : null);
    const dmg = b.maxHp > 0 ? b.hp / b.maxHp : 1;
    if (b.done && dmg < 0.55) spr = variantOf(spr, 1);
    const sx = Math.round(ox + b.x * Z), sy = Math.round(oy + b.y * Z);
    const sz = Math.round(ox + (b.x + 1) * Z) - sx, sh = Math.round(oy + (b.y + 1) * Z) - sy;
    ctx.drawImage(spr, sx, sy, sz, sh);
    if (!b.done && zoomCss >= 7) {
      const bw = Math.round(sz * 0.76), bh = Math.max(2, Math.round(Z * 0.09)), bx = sx + ((sz - bw) >> 1), by = sy + sh - bh - Math.max(1, Math.round(Z * 0.04));
      ctx.fillStyle = 'rgba(8,8,16,0.75)'; ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = '#ffd23c'; ctx.fillRect(bx, by, Math.max(1, Math.round(bw * clamp(b.progress || 0, 0, 1))), bh);
    }
  }

  function drawEntities() {
    const rows = vy1 - vy0 + 8;
    bandN = rows * 4; bandTop = vy0 - 3;
    if (bandHead.length < bandN) bandHead = new Int32Array(bandN * 2);
    bandHead.fill(-1, 0, bandN);
    itN = 0;
    const dots = zoomCss < 4.6;
    const a = curAlpha;
    const x0 = vx0 - 2, x1 = vx1 + 2, y0 = vy0 - 3, y1 = vy1 + 2;
    for (const b of S.buildings.values()) {
      if (b.x < x0 || b.x > x1 || b.y < y0 || b.y > y1) continue;
      if (itN >= itCap) growItems();
      const n = itN++;
      itObj[n] = b; itKind[n] = 1; itX[n] = b.x; itY[n] = b.y + 0.95;
      let bd = ((b.y + 0.95 - bandTop) * 4) | 0;
      if (bd < 0) bd = 0; else if (bd >= bandN) bd = bandN - 1;
      itNext[n] = bandHead[bd]; bandHead[bd] = n;
    }
    let nu = 0;
    for (const u of S.units.values()) {
      let ix = u.px + (u.x - u.px) * a, iy = u.py + (u.y - u.py) * a;
      if (ix !== ix) ix = u.x;                             // px/py missing on a brand-new unit
      if (iy !== iy) iy = u.y;
      if (!(ix >= x0 && ix <= x1 && iy >= y0 && iy <= y1)) continue;
      if (itN >= itCap) growItems();
      const n = itN++;
      itObj[n] = u; itKind[n] = 0; itX[n] = ix; itY[n] = iy + 0.4;
      let bd = ((iy + 0.4 - bandTop) * 4) | 0;
      if (bd < 0) bd = 0; else if (bd >= bandN) bd = bandN - 1;
      itNext[n] = bandHead[bd]; bandHead[bd] = n;
      nu++;
    }
    api.stats.visibleUnits = nu;
    ctx.imageSmoothingEnabled = texel < 1;
    const dsz = Math.max(2, Math.round(Z * 0.24));
    for (let b = 0; b < bandN; b++) {
      for (let k = bandHead[b]; k >= 0; k = itNext[k]) {
        if (itKind[k] === 1) { drawBuildingSprite(itObj[k]); continue; }
        const u = itObj[k];
        if (dots) {
          const kd = u.kingdomId ? S.kingdoms.get(u.kingdomId) : null;
          const col = kd ? kd.color : RACE_COL[u.race] || '#fff';
          const sx = Math.round(ox + itX[k] * Z) - (dsz >> 1), sy = Math.round(oy + itY[k] * Z) - dsz;
          ctx.fillStyle = '#10141c'; ctx.fillRect(sx - 1, sy - 1, dsz + 2, dsz + 2);
          ctx.fillStyle = col;
          ctx.fillRect(sx, sy, dsz, dsz);
        } else drawUnitSprite(u, k);
      }
    }
  }

  // ------------------------------------------------------------------ fire + water glints (visible tile scan)
  let fireList = new Int32Array(512), fireN = 0;
  function drawTileLayer(now) {                 // scorch marks + water sparkles; burning tiles are queued for drawFlames()
    const showGlint = zoomCss >= 8;
    const fire = fireArr, gl = glint;
    const fz = Math.max(1, Z / 16);
    fireN = 0;
    for (let y = vy0; y < vy1; y++) {
      let i = y * W + vx0;
      for (let x = vx0; x < vx1; x++, i++) {
        if (fire[i]) {
          const sx = Math.round(ox + x * Z), sy = Math.round(oy + y * Z), sz = Math.round(ox + (x + 1) * Z) - sx;
          ctx.fillStyle = 'rgba(24,8,0,0.3)'; ctx.fillRect(sx, sy, sz, sz);
          if (fireN >= fireList.length) { const nl = new Int32Array(fireList.length * 2); nl.set(fireList); fireList = nl; }
          fireList[fireN++] = i;
        } else if (showGlint) {
          const g = gl[i];
          if (g !== 0) {
            const p = ((now / 900) + g * 0.0617) % 1;
            if (p < 0.22) {
              ctx.globalAlpha = Math.sin(p / 0.22 * Math.PI) * 0.9;
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(Math.round(ox + (x + ((g & 15) / 16)) * Z), Math.round(oy + (y + ((g >> 4) / 16)) * Z), Math.max(2, Math.round(fz * 2)), Math.max(1, Math.round(fz)));
            }
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }
  function drawFlames(now) {                    // on top of buildings / units standing in the fire
    ctx.imageSmoothingEnabled = Z < 16;
    for (let k = 0; k < fireN; k++) {
      const i = fireList[k], y = (i / W) | 0, x = i - y * W;
      const sx = Math.round(ox + x * Z), sy = Math.round(oy + y * Z), sz = Math.round(ox + (x + 1) * Z) - sx;
      const ph = ((i * 7) ^ (i >> 3)) & 3;
      drawFlame(sx + (sz >> 1), sy + sz, sz, ((now / 120) | 0) + ph);
      if (sz >= 28) drawFlame(sx + (sz >> 1) + Math.round(sz * 0.22), sy + sz - Math.round(sz * 0.05), Math.round(sz * 0.62), ((now / 95) | 0) + ph + 2);
    }
  }

  // ------------------------------------------------------------------ effects
  const NONE = [];
  function drawEffects(now) {
    const fl = Fx.list;
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i], m = (f.r || 2) + 3;
      if (f.x < vx0 - m || f.x > vx1 + m || f.y < vy0 - m - 3 || f.y > vy1 + m) continue;
      Sprites.drawFx(ctx, f, ox + f.x * Z, oy + f.y * Z, Z, now);
    }
    const eff = S.eff;
    if (!eff) return;
    let a = eff.quakes || NONE;
    for (let i = 0; i < a.length; i++) { const e = a[i], m = (e.r || 2) + 3; if (e.x < vx0 - m || e.x > vx1 + m || e.y < vy0 - m || e.y > vy1 + m) continue; Sprites.drawEffect(ctx, 'quake', e, ox + e.x * Z, oy + e.y * Z, Z, now); }
    a = eff.rains || NONE;
    for (let i = 0; i < a.length; i++) { const e = a[i], m = (e.r || 3) * 1.6 + 3; if (e.x < vx0 - m || e.x > vx1 + m || e.y < vy0 - m - 2 || e.y > vy1 + m) continue; Sprites.drawEffect(ctx, 'rain', e, ox + e.x * Z, oy + e.y * Z, Z, now); }
    a = eff.tornados || NONE;
    for (let i = 0; i < a.length; i++) { const e = a[i]; if (e.x < vx0 - 6 || e.x > vx1 + 6 || e.y < vy0 - 6 || e.y > vy1 + 6) continue; Sprites.drawEffect(ctx, 'tornado', e, ox + e.x * Z, oy + e.y * Z, Z, now); }
    a = eff.meteors || NONE;
    for (let i = 0; i < a.length; i++) { const e = a[i], m = (e.r || 2) + 16; if (e.x < vx0 - m || e.x > vx1 + m || e.y < vy0 - m || e.y > vy1 + m) continue; Sprites.drawEffect(ctx, 'meteor', e, ox + e.x * Z, oy + e.y * Z, Z, now); }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ city labels
  const labelCache = new Map();
  function labelFor(city, kd, cap) {
    if (labelCache.size > 96) labelCache.clear();
    let e = labelCache.get(city.id);
    const fl = kd ? kd.flag : null;
    if (e && e.name === city.name && e.pop === city.pop && e.cap === cap && e.dpr === dpr && e.kid === (kd ? kd.id : 0) &&
        (!fl || (e.fp === fl.pattern && e.fs === fl.symbol && e.f1 === fl.c1 && e.f2 === fl.c2 && e.f3 === fl.c3))) return e;
    if (!e) { e = { cv: null, w: 0, h: 0 }; labelCache.set(city.id, e); }
    e.name = city.name; e.pop = city.pop; e.cap = cap; e.dpr = dpr; e.kid = kd ? kd.id : 0;
    if (fl) { e.fp = fl.pattern; e.fs = fl.symbol; e.f1 = fl.c1; e.f2 = fl.c2; e.f3 = fl.c3; }
    const d = dpr;
    const fh = Math.round(10 * d), fw = Math.round(16 * d), ch2 = Math.round(11 * d), gap = Math.round(3 * d), pad2 = Math.round(3 * d);
    const tmp = mk(4, 4).getContext('2d');
    tmp.font = 'bold ' + Math.round(12 * d) + 'px ' + FONT;
    const nameW = Math.ceil(tmp.measureText(String(city.name)).width);
    tmp.font = '600 ' + Math.round(10 * d) + 'px ' + FONT;
    const popTxt = String(city.pop | 0);
    const popW = Math.ceil(tmp.measureText(popTxt).width);
    const w = pad2 * 2 + (cap ? ch2 + gap : 0) + (fl ? fw + gap : 0) + nameW + gap + popW;
    const h = Math.round(17 * d);
    if (!e.cv) e.cv = mk(w, h); else { e.cv.width = w; e.cv.height = h; }
    e.w = w; e.h = h;
    const g = e.cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.imageSmoothingEnabled = false;
    let x = pad2;
    if (cap) { g.drawImage(Sprites.icon('crown', 16), x, Math.round((h - ch2) / 2), ch2, ch2); x += ch2 + gap; }
    if (fl) {
      const fy = Math.round((h - fh) / 2);
      g.drawImage(Sprites.flag(fl, fw, fh), x, fy, fw, fh);
      x += fw + gap;
    }
    g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.font = 'bold ' + Math.round(12 * d) + 'px ' + FONT;
    g.lineWidth = 3 * d; g.strokeStyle = 'rgba(8,10,20,0.9)';
    g.strokeText(String(city.name), x, h / 2 + d * 0.5);
    g.fillStyle = '#ffffff'; g.fillText(String(city.name), x, h / 2 + d * 0.5);
    x += nameW + gap;
    g.font = '600 ' + Math.round(10 * d) + 'px ' + FONT;
    g.lineWidth = 2.6 * d; g.strokeText(popTxt, x, h / 2 + d * 0.5);
    g.fillStyle = '#bfe8ff'; g.fillText(popTxt, x, h / 2 + d * 0.5);
    return e;
  }
  function drawLabels(mode) {
    const big = zoomCss >= 9;
    if (!big && mode === MODE.NORMAL) return;
    ctx.imageSmoothingEnabled = false;
    for (const c of S.cities.values()) {
      if (c.x < vx0 - 8 || c.x > vx1 + 8 || c.y < vy0 - 3 || c.y > vy1 + 4) continue;
      const kd = c.kingdomId ? S.kingdoms.get(c.kingdomId) : null;
      const cap = !!(kd && kd.capitalId === c.id);
      const cx = ox + (c.x + 0.5) * Z, top = oy + c.y * Z;
      if (big) {
        const e = labelFor(c, kd, cap);
        ctx.drawImage(e.cv, Math.round(cx - e.w / 2), Math.round(top - e.h - 2 * dpr), e.w, e.h);
      } else if (kd) {
        const fw = Math.round(12 * dpr), fh = Math.round(8 * dpr);
        const fx = Math.round(cx - fw / 2), fy = Math.round(top - fh - 3 * dpr);
        ctx.fillStyle = 'rgba(8,10,20,0.85)'; ctx.fillRect(fx - 1, fy - 1, fw + 2, fh + 2);
        ctx.drawImage(Sprites.flag(kd.flag, fw, fh), fx, fy, fw, fh);
        if (cap) { const cs = Math.round(9 * dpr); ctx.drawImage(Sprites.icon('crown', 16), Math.round(cx - cs / 2), fy - cs + 1, cs, cs); }
      }
    }
  }

  // ------------------------------------------------------------------ selection + brush
  function bracket(cx, cy, half, th, col) {
    const L = Math.max(4, half * 0.5);
    ctx.fillStyle = col;
    ctx.fillRect(cx - half, cy - half, L, th); ctx.fillRect(cx - half, cy - half, th, L);
    ctx.fillRect(cx + half - L, cy - half, L, th); ctx.fillRect(cx + half - th, cy - half, th, L);
    ctx.fillRect(cx - half, cy + half - th, L, th); ctx.fillRect(cx - half, cy + half - L, th, L);
    ctx.fillRect(cx + half - L, cy + half - th, L, th); ctx.fillRect(cx + half - th, cy + half - L, th, L);
  }
  function tileBracket(tx, ty, wTiles, now) {
    const pulse = Math.sin(now / 230) * 0.05;
    const half = Math.round((wTiles / 2 + pulse) * Z), th = Math.max(2, Math.round(dpr * 1.6));
    const cx = Math.round(ox + (tx + 0.5) * Z), cy = Math.round(oy + (ty + 0.5) * Z);
    bracket(cx, cy, half + 2, th + 2, 'rgba(8,10,20,0.75)');
    bracket(cx, cy, half, th, '#ffe36e');
  }
  function drawHighlight(now) {
    const hl = api.highlight;
    if (!hl) return;
    let handled = false;
    if (hl.type === 'unit') {
      const u = S.units.get(hl.id);
      if (u) {
        const ix = u.px + (u.x - u.px) * curAlpha, iy = u.py + (u.y - u.py) * curAlpha;
        const sx = ox + ix * Z, sy = oy + (iy + 0.46) * Z, pr = 1 + Math.sin(now / 200) * 0.08;
        ctx.lineWidth = Math.max(2, 2.2 * dpr);
        ctx.strokeStyle = 'rgba(8,10,20,0.7)'; ctx.beginPath(); ctx.ellipse(sx, sy, Z * 0.5 * pr + 1.5, Z * 0.24 * pr + 1, 0, 0, TAU); ctx.stroke();
        ctx.strokeStyle = '#ffe36e'; ctx.lineWidth = Math.max(1.5, 1.6 * dpr); ctx.beginPath(); ctx.ellipse(sx, sy, Z * 0.5 * pr, Z * 0.24 * pr, 0, 0, TAU); ctx.stroke();
        handled = true;
      }
    } else if (hl.type === 'building') {
      const b = S.buildings.get(hl.id);
      if (b) { tileBracket(b.x, b.y, 1.15, now); handled = true; }
    } else if (hl.type === 'city') {
      const c = S.cities.get(hl.id);
      if (c) { tileBracket(c.x, c.y, 1.4, now); handled = true; }
    } else if (hl.type === 'kingdom') {
      const k = S.kingdoms.get(hl.id);
      if (k) {
        for (let i = 0; i < k.cities.length; i++) { const c = S.cities.get(k.cities[i]); if (c) tileBracket(c.x, c.y, k.cities[i] === k.capitalId ? 1.5 : 1.2, now); }
        handled = k.cities.length > 0;
      }
    }
    if (!handled && hl.x !== undefined && hl.y !== undefined) tileBracket(Math.floor(hl.x), Math.floor(hl.y), 1.1, now);
  }
  function drawBrush(now) {
    const b = api.brush;
    if (!b || !(b.r > 0)) return;
    const cx = ox + (Math.floor(b.x) + 0.5) * Z, cy = oy + (Math.floor(b.y) + 0.5) * Z, r = (b.r + 0.45) * Z;
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    ctx.globalAlpha = 0.1 + 0.07 * pulse; ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.55; ctx.strokeStyle = '#0a0e1a'; ctx.lineWidth = 3.4 * dpr;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
    ctx.globalAlpha = 0.65 + 0.3 * pulse; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.8 * dpr;
    ctx.setLineDash([6 * dpr, 5 * dpr]); ctx.lineDashOffset = -now / 55 * dpr;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0;
    ctx.globalAlpha = 0.8; ctx.fillStyle = '#ffffff';
    const m = Math.max(2, Math.round(dpr * 2));
    ctx.fillRect(Math.round(cx) - m, Math.round(cy) - m, m * 2, m * 2);
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ main draw
  function draw(alpha, now) {
    if (!ctx) return;
    const t0 = performance.now();
    curNow = (now === undefined || now === null) ? t0 : now;
    curAlpha = alpha > 0 ? (alpha < 1 ? alpha : 1) : 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    let ok = false;
    try { ok = syncWorld(); } catch (e) { report('bake', e); }
    if (!ok) { ctx.fillStyle = BG; ctx.fillRect(0, 0, cw, ch); updateStats(t0); return; }
    stepGlide();
    clampCam();
    const cam = api.cam;
    zoomCss = cam.zoom;
    Z = cam.zoom * dpr;
    const tz = Z * 0.85 / 16;                     // units are drawn at ~85% of a tile; whole texels when big
    texel = tz >= 4 ? Math.round(tz) : tz;
    ox = Math.round(cw / 2 - cam.x * Z); oy = Math.round(ch / 2 - cam.y * Z);
    vx0 = Math.max(0, Math.floor(-ox / Z)); vy0 = Math.max(0, Math.floor(-oy / Z));
    vx1 = Math.min(W, Math.ceil((cw - ox) / Z)); vy1 = Math.min(H, Math.ceil((ch - oy) / Z));
    ctx.fillStyle = BG; ctx.fillRect(0, 0, cw, ch);
    try { drawOcean(curNow); } catch (e) { report('ocean', e); }
    api.stats.visibleTiles = Math.max(0, vx1 - vx0) * Math.max(0, vy1 - vy0);
    if (vx1 > vx0 && vy1 > vy0) {
      try { drawTerrain(curNow); } catch (e) { report('terrain', e); }
      const mode = api.mode;
      if (mode !== MODE.NORMAL) { try { ensureOverlay(mode); drawOverlay(mode); } catch (e) { report('overlay', e); } }
      try { drawTileLayer(curNow); } catch (e) { report('tiles', e); }
      try { drawEntities(); } catch (e) { report('entities', e); }
      try { drawFlames(curNow); } catch (e) { report('fire', e); }
      try { drawEffects(curNow); } catch (e) { report('effects', e); }
      try { drawLabels(mode); } catch (e) { report('labels', e); }
      try { drawHighlight(curNow); drawBrush(curNow); } catch (e) { report('overlays', e); }
    }
    ctx.globalAlpha = 1;
    updateStats(t0);
  }
  function drawTerrain(now) {
    const f = ((now / 480) | 0) & 1;
    const useMip = Z < P * 0.7;
    const src = useMip ? mip[f] : terr[f], sp = useMip ? P / 2 : P;
    ctx.imageSmoothingEnabled = Z < P;
    ctx.drawImage(src, vx0 * sp, vy0 * sp, (vx1 - vx0) * sp, (vy1 - vy0) * sp, ox + vx0 * Z, oy + vy0 * Z, (vx1 - vx0) * Z, (vy1 - vy0) * Z);
  }
  function updateStats(t0) {
    const t1 = performance.now();
    const st = api.stats;
    drawEma = drawEma ? drawEma * 0.9 + (t1 - t0) * 0.1 : (t1 - t0);
    if (lastNow) { const d = curNow - lastNow; if (d > 0 && d < 1000) fpsEma = fpsEma * 0.92 + (1000 / d) * 0.08; }
    lastNow = curNow;
    st.fps = Math.round(fpsEma * 10) / 10; st.drawMs = Math.round(drawEma * 100) / 100;
  }

  function visibleRect() { return { x0: vx0, y0: vy0, x1: vx1, y1: vy1 }; }
  /** diagnostics for tests / the debug console */
  function debugInfo() {
    let seg = 0;
    for (let i = 0; i < ovl.groups.length; i++) seg += ovl.groups[i].seg.length / 6;
    return { P, W, H, dpr, Z, ox, oy, texel, overlayMode: ovl.mode, overlayVer: ovl.ver, borderSegments: seg, innerSegments: ovl.inner ? ovl.inner.length / 4 : 0,
      dirty: S.dirtyList ? S.dirtyList.length : 0, glide: !!glide, labels: labelCache.size, items: itN };
  }

  Object.assign(api, {
    init, resize, draw, screenToTile, tileToScreen, focusOn, setMode, invalidate,
    setCamera, panBy, zoomAt, settleZoom, crispZoom, clampCam, minZoom, maxZoom() { return MAXZ; }, visibleRect, debugInfo,
    cancelGlide() { glide = null; },
  });
  Object.defineProperty(api, 'canvas', { get() { return canvas; } });
  Object.defineProperty(api, 'camSerial', { get() { return camSerial; } });
  Object.defineProperty(api, 'size', { get() { return { w: cssW, h: cssH, dpr }; } });
  return api;
})();
