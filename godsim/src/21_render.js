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
 *
 * STAGE 2 (CONTRACT §8.4) — political map + war overlays, section "STAGE 2" below:
 *  - MODE.BORDERS with regions (S.regions non-empty): owner fill + inner edge shade, crisp kingdom outlines, thin region lines,
 *    occupation stripes (controller != owner), front lines (Regions.frontlines() or S.wars), region / kingdom names. All of it is cached
 *    (1 px/tile fill, stripe cache, border runs) and rebuilt when S.regionVer / S.ownerVer / the war set change (>= 150 ms apart);
 *    while the camera rests the finished layer is blitted from a screen-sized cache. MODE.CULTURE: same per region, coloured by the
 *    owner's capital culture (city fallback). Without regions the stage-1 city-sphere overlay is used unchanged.
 *  - All modes: army banners (zoom >= 5; below only the commanded kingdom's), order arrows of Render.cmd.kid's armies (+ everybody's
 *    with Render.showAllOrders on the political map), war-goal stars, Render.cmd highlights (selected / candidates / goals / targetKid).
 *  - API: Render.cmd, Render.showAllOrders, Render.regionAt(tx,ty), Render.regionCenter(rid), Render.armyAt(tx,ty),
 *    Render.armyAtScreen(sx,sy), Render.armyBannerRect(id), Render.debugInfo().political.
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
      if (rk === RES.TREE) {
        const a = amtArr[i];
        if (a < 24) v = 0; else if (a < 44) v = 1;
        else {                                             // mature tree: species by surroundings + hash (palm on the coast, snowy pine in the cold, birch / autumn / dead mixed in)
          const q = hh & 15, cold = nN === T.MOUNTAIN || nE === T.MOUNTAIN || nS === T.MOUNTAIN || nW === T.MOUNTAIN || nN === T.SNOW || nE === T.SNOW || nS === T.SNOW || nW === T.SNOW, shore = nN === T.SAND || nE === T.SAND || nS === T.SAND || nW === T.SAND || nN === T.SHALLOW || nE === T.SHALLOW || nS === T.SHALLOW || nW === T.SHALLOW;
          if (cold && q < 10) v = 7;
          else if (shore && q < 9) v = 5;
          else if (t === T.HILL && q > 12) v = 6;
          else v = q < 6 ? 2 : q < 9 ? 3 : q < 12 ? 4 : q < 13 ? 8 : (q & 1) ? 3 : 2;
        }
      }
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
  const flipMap = new WeakMap(), darkMap = new WeakMap(), greenMap = new WeakMap(), whiteMap = new WeakMap();
  function variantOf(cv, kind) {
    const map = kind === 0 ? flipMap : kind === 1 ? darkMap : kind === 3 ? whiteMap : greenMap;
    let v = map.get(cv);
    if (v) return v;
    v = mk(cv.width, cv.height);
    const g = v.getContext('2d');
    g.imageSmoothingEnabled = false;
    if (kind === 0) { g.translate(cv.width, 0); g.scale(-1, 1); g.drawImage(cv, 0, 0); }
    else {
      g.drawImage(cv, 0, 0);
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = kind === 1 ? 'rgba(40,12,10,0.42)' : kind === 3 ? 'rgba(255,255,255,0.72)' : 'rgba(60,230,70,0.5)';
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
    cmd: null,                 // stage 2: {kid, regionId, armyId, goals:[rid], candidates:[rid], targetKid} set by UI (CONTRACT 8.4)
    showAllOrders: false,      // stage 2: draw the order arrows / goal stars of every kingdom (political map only)
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
    hookBus();
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
  function setMode(m) { api.mode = m; ovl.ver = -1; pol.ver = -1; }
  function invalidate() { needFull = true; ovl.ver = -1; pol.ver = -1; }

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

  const lvId = new Int32Array(4096), lvLv = new Uint8Array(4096), hpLast = new Float32Array(4096), hitUntil = new Float64Array(4096);
  function drawUnitSprite(u, k) {
    const ix = itX[k], iy = itY[k] - 0.4;
    const kd = u.kingdomId ? S.kingdoms.get(u.kingdomId) : null;
    const moving = (u.x - u.px) * (u.x - u.px) + (u.y - u.py) * (u.y - u.py) > 1e-6;
    let frame = moving ? (((curNow / 180 + u.id) | 0) & 1) : 1;       // idle = the upright "passing" pose
    const stage = stageOf(u);
    // pose (attack / work / sleep) + carried goods from the unit state; all cheap numeric compares
    let pose = 0, carry = 0, el = 99;
    const stt = u.state;
    if (stt === 'sleep') pose = 6;
    else {
      const cdl = u.cd - S.tick;                                         // > 0 for a few ticks after a strike
      if (cdl > 0 && (stt === 'fight' || stt === 'army')) {
        el = (u.race === 2 && u.weapon > 0 ? 12 : 8) - cdl;             // ticks since the blow
        if (el < 5) { pose = 1; frame = el < 2 ? 1 : 0; }
      }
      if (pose === 0) {
        if ((stt === 'gather' || stt === 'build' || stt === 'farm') && u.st && u.st.ph === 'work') {
          const jt = u.job ? u.job.type : '';
          pose = jt === 'chop' ? 2 : jt === 'mine' ? 3 : jt === 'farm' ? 4 : jt === 'build' ? 5 : jt === 'fish' ? 7 : jt === 'forage' ? 8 : 0;
          if (pose) frame = ((curNow / 300 + u.id) | 0) & 1;
        }
        if (pose === 0 && u.carry) { const cr = u.carry; carry = cr === 'wood' ? 1 : cr === 'stone' ? 2 : cr === 'food' ? 3 : cr === 'iron' ? 4 : cr === 'gold' ? 5 : 0; }
      }
    }
    const li = u.id & 4095;                                            // level-up sparkle: remembers the last level seen per (hashed) unit id
    if (lvId[li] === u.id) { if (u.hp < hpLast[li] - 0.01) hitUntil[li] = curNow + 130; hpLast[li] = u.hp; const lv = u.level | 0; if (lv > lvLv[li]) { lvLv[li] = lv; if (zoomCss >= 9 && ambientOn && Fx.list.length < 160) Fx.add('levelup', u.x, u.y, { ttl: 1.3 }); } else lvLv[li] = lv; }
    else { lvId[li] = u.id; lvLv[li] = u.level | 0; hpLast[li] = u.hp; hitUntil[li] = 0; }
    // fewer sprite variants when zoomed out (every distinct sprite is a separate texture for the browser): carried goods from zoom 9, poses from 7, women's hair / skirts from 8
    const act = pose;
    if (zoomCss < 9) carry = 0;
    if (zoomCss < 7 && pose !== 6) pose = 0;
    let spr = Sprites.unit(u.race, stage, frame, kd ? kd.color : null, u.weapon, u.armor, (u.id & 3) | (zoomCss >= 8 && u.sex === 1 ? 4 : 0), pose, carry);
    if (u.face < 0) spr = variantOf(spr, 0);
    if (u.sick > S.tick) spr = variantOf(spr, 2);
    if (hitUntil[li] > curNow) spr = variantOf(spr, 3);                // hit flash
    const sz = 16 * texel;
    const sx = Math.round(ox + ix * Z), sy = Math.round(oy + (iy + 0.55) * Z);
    const left = sx - (sz >> 1), top = sy - sz;
    ctx.drawImage(spr, left, top, sz, sz);
    if (act === 1 && el < 4 && u.race === 2 && u.weapon > 0 && u.st && zoomCss >= 6) {        // archers: the arrow flies to the target
      const foe = S.units.get(u.st.tid);
      if (foe && foe !== u) Sprites.drawArrow(ctx, sx + (u.face < 0 ? -4 : 4) * texel, sy - 8 * texel, ox + foe.x * Z, oy + (foe.y + 0.1) * Z - 6 * texel, (el + curAlpha) / 4, Z);
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

  let ambientOn = true;                                      // chimney smoke, birds, jumping fish (Render.ambient = false switches them off)
  function drawBuildingSprite(b) {
    const city = S.cities.get(b.cityId);
    const kd = city && city.kingdomId ? S.kingdoms.get(city.kingdomId) : null;
    const done = !!b.done, bcol = kd ? kd.color : null, brace = city ? city.race : 0;
    let blvl = b.level || 1;
    if (b.type === Const.B.FARM) blvl = 1 + (((S.tick / 420) | 0) + b.id) % 3;                // crop growth stage cycles: sprouts -> green -> ripe
    // sprite state: finished -> 0 normal / 1 damaged / 2 burning; unfinished -> construction stage 0..2 from the progress
    let bmode = 0, dmg = 1;
    if (done) { dmg = b.maxHp > 0 ? b.hp / b.maxHp : 1; bmode = (fireArr && fireArr[b.y * W + b.x] > 0) ? 2 : dmg < 0.55 ? 1 : 0; }
    else { const pr = b.progress || 0; bmode = pr < 0.34 ? 0 : pr < 0.67 ? 1 : 2; }
    const sx = Math.round(ox + b.x * Z), sy = Math.round(oy + b.y * Z);
    const sz = Math.round(ox + (b.x + 1) * Z) - sx, sh = Math.round(oy + (b.y + 1) * Z) - sy;
    const flipH = b.type === Const.B.HOUSE && ((b.id >> 2) & 1) !== 0;
    const lm = (done && (b.type === Const.B.TOWNHALL || b.type === Const.B.TEMPLE || b.type === Const.B.BARRACKS)) ? Sprites.landmark(b.type, brace, blvl, bcol, bmode) : null;     // town halls / temples / castles are 1.5 tiles tall
    if (lm) { const lh = Math.round(sh * 1.5); ctx.drawImage(lm, sx, sy + sh - lh, sz, lh); }
    else {
      let spr = Sprites.building(b.type, brace, blvl, done, bcol, bmode, b.id % 3);          // houses / markets: 3 colour looks by id, half of them mirrored
      if (flipH) spr = variantOf(spr, 0);
      ctx.drawImage(spr, sx, sy, sz, sh);
    }
    if (done && ambientOn && zoomCss >= 9) {                 // chimney smoke, smouldering / burning damage
      if (bmode === 0) { const ch = Sprites.chimney(b.type, brace, blvl); if (ch !== null && (b.id % 5) < 3) Sprites.drawSmoke(ctx, sx + (flipH ? 15 - ch[0] : ch[0]) / 16 * sz, sy + ch[1] / 16 * sh, Z, curNow, b.id, 0.5, false); }
      else { Sprites.drawSmoke(ctx, sx + sz * 0.5, sy + sh * (lm ? 0.05 : 0.25), Z, curNow, b.id, bmode === 2 ? 1 : 0.7, true); if (dmg < 0.3 && flames) drawFlame(sx + (sz >> 1) + Math.round(sz * 0.15), sy + sh - Math.round(sh * 0.25), Math.round(sz * 0.5), ((curNow / 120) | 0) + b.id); }
    }
    if (!b.done && zoomCss >= 7) {
      const bw = Math.round(sz * 0.76), bh = Math.max(2, Math.round(Z * 0.09)), bx = sx + ((sz - bw) >> 1), by = sy + sh - bh - Math.max(1, Math.round(Z * 0.04));
      ctx.fillStyle = 'rgba(8,8,16,0.75)'; ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
      ctx.fillStyle = '#ffd23c'; ctx.fillRect(bx, by, Math.max(1, Math.round(bw * clamp(b.progress || 0, 0, 1))), bh);
    }
  }

  // ------------------------------------------------------------------ cosmetic events (hearts at births, wisps at deaths, banners at occupation / founding)
  let busHooked = false;
  function hookBus() {
    if (busHooked || typeof Bus === 'undefined' || !Bus || typeof Bus.on !== 'function') return;
    busHooked = true;
    const seen = (x, y) => ambientOn && zoomCss >= 9 && x >= vx0 - 2 && x <= vx1 + 2 && y >= vy0 - 2 && y <= vy1 + 2 && Fx.list.length < 120;
    let heartAt = 0, soulAt = 0;                             // throttles: at most ~6 hearts / 5 wisps a second
    Bus.on('unitBorn', u => { try { if (u && (u.motherId | 0) > 0 && curNow - heartAt > 160 && seen(u.x, u.y)) { heartAt = curNow; Fx.add('heart', u.x, u.y, { ttl: 1.7 }); } } catch (e) { /* cosmetic only */ } });
    Bus.on('unitDied', (u, cause) => { try { if (u && (cause === 'age' || cause === 'disease' || cause === 'hunger') && curNow - soulAt > 200 && seen(u.x, u.y)) { soulAt = curNow; Fx.add('soul', u.x, u.y, { ttl: 2.0 }); } } catch (e) { /* cosmetic only */ } });
    const flag = (c, kid) => { try { if (c && seen(c.x, c.y)) { const kd = kid ? S.kingdoms.get(kid) : null; Fx.add('flagraise', c.x + 0.5, c.y + 0.5, { ttl: 2.4, color: kd ? kd.color : '#e53935' }); } } catch (e) { /* cosmetic only */ } };
    Bus.on('buildingDestroyed', (b, cause) => { try { if (b && b.done && S.tile && b.x >= 0 && b.y >= 0 && b.x < S.w && b.y < S.h && cause !== 'terrain') { ensureScorch(); const i = b.y * S.w + b.x; if (ruinT[i] === 0) markN++; ruinT[i] = (((S.tick >> 3) + 1) & 0xffff) || 1; ruinV[i] = ((b.id & 3) << 1) | (cause === 'fire' || b.race === 1 ? 1 : 0); } } catch (e) { /* cosmetic only */ } });
    Bus.on('cityOccupied', (c, byKid) => flag(c, byKid));
    Bus.on('cityLiberated', c => flag(c, c && c.kingdomId));
    Bus.on('cityFounded', c => flag(c, c && c.kingdomId));
  }

  // ------------------------------------------------------------------ ambient life: birds crossing the map, fish leaping out of the sea (pure functions of time, no state)
  function drawAmbient(now) {
    if (!ambientOn || zoomCss < 8) return;
    const t = now / 1000, tile = tileArr;
    ctx.imageSmoothingEnabled = false;
    for (let k = 0; k < 6; k++) {
      const wx = ((t * (0.8 + (k % 3) * 0.3) + k * 41.7) % (W + 30)) - 15, wy = H * (0.1 + 0.8 * ((k * 0.6180339) % 1)) + Math.sin(t * 0.3 + k * 2.1) * 3;
      const bx = ox + wx * Z, by = oy + wy * Z;
      if (bx < -30 || by < -30 || bx > cw + 30 || by > ch + 30) continue;
      Sprites.drawBird(ctx, Math.round(bx), Math.round(by), Z, now, k);
    }
    if (!tile) return;
    const cx0 = (vx0 / 6) | 0, cx1 = (vx1 / 6) | 0, cy0 = (vy0 / 6) | 0, cy1 = (vy1 / 6) | 0, tb = Math.floor(t / 2.4), pc = (t / 2.4) - tb;
    if (pc < 0.3 && (cx1 - cx0 + 1) * (cy1 - cy0 + 1) < 160) {
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const h = ihash(cx, cy, tb + 977);
        if ((h & 15) !== 0) continue;
        const fx = cx * 6 + ((h >>> 4) % 6), fy = cy * 6 + ((h >>> 10) % 6);
        if (fx < vx0 || fx >= vx1 || fy < vy0 || fy >= vy1 || tile[fy * W + fx] !== T.DEEP) continue;
        Sprites.drawFishJump(ctx, ox + (fx + 0.5) * Z, oy + (fy + 0.5) * Z, Z, pc / 0.3);
      }
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
  let ruinT = null, ruinV = null, markN = 0;      // markN = tiles carrying a scorch / rubble mark (0 -> the per-tile mark checks are skipped)
  let scorch = null, scorchFor = null;            // Uint16 per tile: (tick >> 3) + 1 of the last time the tile was seen burning (burnt ground fades after ~3 min of game time)
  function ensureScorch() { const n = S.w * S.h; if (scorchFor !== S.tile || !scorch || scorch.length !== n) { scorch = new Uint16Array(n); ruinT = new Uint16Array(n); ruinV = new Uint8Array(n); scorchFor = S.tile; markN = 0; } }
  function drawTileLayer(now) {                 // scorch marks + water sparkles; burning tiles are queued for drawFlames()
    const showGlint = zoomCss >= 8;
    const fire = fireArr, gl = glint;
    const fz = Math.max(1, Z / 16);
    ensureScorch();
    const sc = scorch, rT = ruinT, rV = ruinV, bldA = S.bld, st8 = (S.tick >> 3) + 1;
    fireN = 0;
    for (let y = vy0; y < vy1; y++) {
      let i = y * W + vx0;
      for (let x = vx0; x < vx1; x++, i++) {
        if (fire[i]) {
          const sx = Math.round(ox + x * Z), sy = Math.round(oy + y * Z), sz = Math.round(ox + (x + 1) * Z) - sx;
          ctx.fillStyle = 'rgba(24,8,0,0.3)'; ctx.fillRect(sx, sy, sz, sz);
          if (fireN >= fireList.length) { const nl = new Int32Array(fireList.length * 2); nl.set(fireList); fireList = nl; }
          fireList[fireN++] = i;
          if (sc[i] === 0) markN++;
          sc[i] = (st8 & 0xffff) || 1;
        } else {
          if (markN > 0) {
          const sv = sc[i];
          if (sv !== 0) {                                     // burnt ground: soot decal that fades out
            const age = (st8 - sv) & 0xffff;
            if (age < 480) {
              const sx = Math.round(ox + x * Z), sy = Math.round(oy + y * Z), sz = Math.round(ox + (x + 1) * Z) - sx;
              ctx.globalAlpha = age < 40 ? 1 : 1 - (age - 40) / 440;
              ctx.drawImage(Sprites.decal('scorch', (x * 7 + y * 13) & 3), sx, sy, sz, sz);
              ctx.globalAlpha = 1;
            } else { sc[i] = 0; markN--; }
          }
          const rr = rT[i];
          if (rr !== 0) {                                      // rubble of a destroyed building, fades after ~8 game minutes
            const age = (st8 - rr) & 0xffff;
            if (age < 600) {
              if (!bldA[i]) {
                const sx = Math.round(ox + x * Z), sy = Math.round(oy + y * Z), sz = Math.round(ox + (x + 1) * Z) - sx;
                ctx.globalAlpha = age < 300 ? 1 : 1 - (age - 300) / 300;
                ctx.drawImage(Sprites.decal('ruin', rV[i]), sx, sy, sz, sz);
                ctx.globalAlpha = 1;
              }
            } else { rT[i] = 0; markN--; }
          }
          }
          if (showGlint) {
            const g = gl[i];
            if (g !== 0) {
              const p = ((now / 900) + g * 0.0617) % 1;
              if (p < 0.22) {
                const k = Math.sin(p / 0.22 * Math.PI), gx = Math.round(ox + (x + ((g & 15) / 16)) * Z), gy = Math.round(oy + (y + ((g >> 4) / 16)) * Z);
                ctx.globalAlpha = k * 0.9;
                ctx.fillStyle = '#ffffff';
                const u1 = Math.max(1, Math.round(fz));
                ctx.fillRect(gx, gy, Math.max(2, Math.round(fz * 2)), u1);
                if (zoomCss >= 12 && k > 0.55) {                 // 4-point star at the peak of the twinkle
                  ctx.fillRect(gx + (u1 >> 1), gy - u1, u1, u1 * 3);
                  ctx.globalAlpha = k * 0.45; ctx.fillRect(gx - u1, gy, u1 * 4, u1);
                }
              }
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
  // small cosmetic effects come from baked frames (Sprites.drawFx): hidden when zoomed far out, and only the newest few are drawn (1 = tiny cosmetics, 2 = fire / smoke)
  const FX_SMALL = { blood: 1, spark: 1, dust: 1, splash: 1, ash: 1, heart: 3, soul: 3, levelup: 3, whisper: 1, rain_drop: 1, smoke: 2, fire: 2 };
  function drawEffects(now) {
    const fl = Fx.list, far = zoomCss < 7, far3 = zoomCss < 9;
    let c1 = 0, c2 = 0;
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i], cls = FX_SMALL[f.type];
      if (cls === undefined || (far && cls === 1) || (far3 && cls === 3) || f.x < vx0 - 4 || f.x > vx1 + 4 || f.y < vy0 - 6 || f.y > vy1 + 4) continue;
      if (cls === 2) c2++; else c1++;
    }
    let skip1 = c1 - 16, skip2 = c2 - 32;
    ctx.imageSmoothingEnabled = Z < 16;                     // baked frames: crisp when magnified, smooth when shrunk (Sprites.drawFx never touches the flag)
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i], m = (f.r || 2) + 3, cls = FX_SMALL[f.type];
      if (f.x < vx0 - m || f.x > vx1 + m || f.y < vy0 - m - 3 || f.y > vy1 + m) continue;
      if (cls !== undefined) { if ((far && cls === 1) || (far3 && cls === 3)) continue; if (cls === 2 ? skip2-- > 0 : skip1-- > 0) continue; }
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
    occFlagsDrawn = 0;
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
        if (c.occupierId) drawOccupier(c, cx, top - 2 * dpr - e.h / 2, true, e);
      } else if (kd) {
        const fw = Math.round(12 * dpr), fh = Math.round(8 * dpr);
        const fx = Math.round(cx - fw / 2), fy = Math.round(top - fh - 3 * dpr);
        ctx.fillStyle = 'rgba(8,10,20,0.85)'; ctx.fillRect(fx - 1, fy - 1, fw + 2, fh + 2);
        ctx.drawImage(Sprites.flag(kd.flag, fw, fh), fx, fy, fw, fh);
        if (cap) { const cs = Math.round(9 * dpr); ctx.drawImage(Sprites.icon('crown', 16), Math.round(cx - cs / 2), fy - cs + 1, cs, cs); }
        if (c.occupierId) drawOccupier(c, cx, top, false, null);
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

  // ==================================================================================================================
  // STAGE 2 — political map (regions) and war overlays (CONTRACT §8.4)
  //   data read (all optional, every access is guarded): S.region / S.regions (Region 8.1), S.armies (Army 8.2), S.wars (War 8.2),
  //   S.kingdoms, S.cities, Regions.get/centroid/frontlines (only when the real module exists), Render.cmd / Render.showAllOrders.
  //   The expensive part (fill, stripes, border runs) is cached and rebuilt when S.regionVer / S.ownerVer / the war set change
  //   (throttled to >= POL_THROTTLE ms); per frame only blits + clipped line strokes + a handful of overlay sprites run.
  // ==================================================================================================================
  const POL_THROTTLE = 150;           // ms between rebuilds while the political data keeps changing
  let SP = 8;                         // pixels per tile of the occupation-stripe cache (shrinks on very large maps)
  const pol = {
    ver: -1, ownerVer: -1, warSig: 0, mode: -1, key: null, w: 0, h: 0, built: 0, builds: 0, buildMs: 0,
    fill: null, fctx: null, img: null, u32: null, stripe: null, sctx: null, patterns: new Map(), stripeTiles: 0,
    groups: [], thin: null, wild: null, front: null, infos: new Map(), frontPairs: null, usedApi: false, stripeBox: null, tileInfo: null,
  };
  const polLayer = { cv: null, cx: null, ox: 0, oy: 0, Z: 0, mode: -1, political: false, builds: -1, key: null, draws: 0, blits: 0, direct: 0, fOx: 0, fOy: 0, fZ: 0, fCw: 0, fCh: 0 };   // screen-sized cache of the whole political layer
  const geom = { key: null, ver: -1, bbox: null, cache: new Map() };
  const centers = { key: null, ver: -1, map: new Map() };
  function hasRegions() { return !!(S.regions && S.regions.size > 0 && S.region && W > 0 && S.region.length === W * H); }
  function regionsApi() { return (typeof Regions !== 'undefined' && Regions && !Regions.__stub) ? Regions : null; }
  function regionOf(rid) { return rid ? (S.regions && S.regions.get(rid)) || null : null; }
  function kingdomOf(kid) { return kid && S.kingdoms ? S.kingdoms.get(kid) || null : null; }
  function colorOf(kid) { const k = kingdomOf(kid); return k && typeof k.color === 'string' ? k.color : '#a8b0b8'; }

  /** tile (float, centre of the tile) of a region's centre; Regions.centroid when the real module exists, else Region.cx/cy */
  function regionCenter(rid) {
    if (centers.key !== S.region || centers.ver !== S.regionVer) { centers.map.clear(); centers.key = S.region; centers.ver = S.regionVer; }
    let c = centers.map.get(rid);
    if (c !== undefined) return c;
    const r = regionOf(rid);
    if (!r) { centers.map.set(rid, null); return null; }
    let x = r.cx, y = r.cy;
    const api2 = regionsApi();
    if (api2 && typeof api2.centroid === 'function') { try { const p = api2.centroid(rid); if (p && p.x === p.x && p.y === p.y) { x = p.x; y = p.y; } } catch (e) { report('centroid', e); } }
    c = (x === x && y === y) ? { x: x + 0.5, y: y + 0.5 } : null;
    centers.map.set(rid, c);
    return c;
  }
  /** region id under a tile position (float tile coords); sea tiles right next to the coast snap to the adjacent land region */
  function regionAt(tx, ty) {
    if (!S.region || !(S.w > 0)) return 0;
    const x = Math.floor(tx), y = Math.floor(ty);
    if (x < -1 || y < -1 || x > S.w || y > S.h) return 0;
    if (x >= 0 && y >= 0 && x < S.w && y < S.h) { const r = S.region[y * S.w + x]; if (r) return r; }
    let best = 0, bd = 1e9;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const xx = x + i, yy = y + j;
      if (xx < 0 || yy < 0 || xx >= S.w || yy >= S.h) continue;
      const r = S.region[yy * S.w + xx]; if (!r) continue;
      const d = (xx + 0.5 - tx) * (xx + 0.5 - tx) + (yy + 0.5 - ty) * (yy + 0.5 - ty);
      if (d < bd) { bd = d; best = r; }
    }
    return best;
  }

  // ------------------------------------------------------------------ cache build
  function warSignature() {
    let sig = S.wars ? S.wars.size : 0;
    if (S.wars) for (const w of S.wars.values()) sig = (Math.imul(sig, 31) + w.id * 2 + (w.ended ? 1 : 0) + (w.attackers ? w.attackers.length * 7 : 0) + (w.defenders ? w.defenders.length * 13 : 0)) | 0;
    return sig;
  }
  function pairKey(a, b) { return a < b ? a * 67108864 + b : b * 67108864 + a; }
  function cultureOfRegion(r, k) {
    const cap = k ? S.cities.get(k.capitalId) : null;
    if (cap && cap.culture !== undefined && S.cultures[cap.culture | 0]) return cap.culture | 0;
    let best = -1, bp = -1;                                  // city-based fallback: the most populous city of the region (else of the kingdom)
    const ids = r.cityIds && r.cityIds.length ? r.cityIds : (k ? k.cities : null);
    if (ids) for (let i = 0; i < ids.length; i++) { const c = S.cities.get(ids[i]); if (c && S.cultures[c.culture | 0] && (c.pop | 0) > bp) { bp = c.pop | 0; best = c.culture | 0; } }
    if (best >= 0) return best;
    return k && S.cultures[k.culture | 0] ? k.culture | 0 : -1;
  }
  function stripePattern(color) {
    let p = pol.patterns.get(color);
    if (p) return p;
    const cv = mk(SP, SP), g = cv.getContext('2d'), id = g.createImageData(SP, SP), d = new Uint32Array(id.data.buffer);
    const c = packColor(color, 0.92), e = packColor('#0a0c18', 0.55), bw = Math.max(1, Math.round(SP * 0.375));
    for (let y = 0; y < SP; y++) for (let x = 0; x < SP; x++) { const t = (x + y) % SP; d[y * SP + x] = t < bw ? c : t === bw ? e : 0; }
    g.putImageData(id, 0, 0);
    p = pol.sctx.createPattern(cv, 'repeat');
    pol.patterns.set(color, p);
    return p;
  }

  function buildPolitical(mode, sig) {
    const t0 = performance.now();
    const w = W, h = H, n = w * h, reg = S.region, culture = mode === MODE.CULTURE;
    if (!pol.fill || pol.w !== w || pol.h !== h) {
      pol.fill = mk(w, h); pol.fctx = pol.fill.getContext('2d');
      pol.img = pol.fctx.createImageData(w, h); pol.u32 = new Uint32Array(pol.img.data.buffer);
      pol.stripe = null; pol.sctx = null; pol.patterns.clear();
      SP = Math.max(2, Math.min(8, Math.floor(Math.sqrt(8e6 / Math.max(1, w * h))) & ~1));
      pol.w = w; pol.h = h;
    }
    const px = pol.u32; px.fill(0);
    // ---- war pairs (S.wars is the truth; Regions.frontlines() is used when the real module provides it)
    const warPairs = new Set();
    for (const wr of S.wars.values()) {
      if (wr.ended || !wr.attackers || !wr.defenders) continue;
      for (let i = 0; i < wr.attackers.length; i++) for (let j = 0; j < wr.defenders.length; j++) warPairs.add(pairKey(wr.attackers[i], wr.defenders[j]));
    }
    let frontPairs = null;
    const rg = regionsApi();
    if (!culture && rg && typeof rg.frontlines === 'function') {
      try {
        const fl = rg.frontlines();
        if (fl && typeof fl.length === 'number') { frontPairs = new Set(); for (let i = 0; i < fl.length; i++) { const f = fl[i]; if (f && f.a && f.b) frontPairs.add(pairKey(f.a, f.b)); } }
      } catch (e) { report('frontlines', e); frontPairs = null; }
    }
    pol.usedApi = !!frontPairs; pol.frontPairs = frontPairs;
    // ---- per-region info
    const infos = pol.infos; infos.clear();
    const keyColor = new Map();
    const alpha = culture ? 0.4 : 0.3;
    for (const r of S.regions.values()) {
      const owner = r.ownerId | 0, k = owner ? S.kingdoms.get(owner) : null;
      let ctrl = r.controllerId | 0; if (!ctrl) ctrl = owner;
      let key = 0, col = null;
      if (culture) {
        if (owner || (r.cityIds && r.cityIds.length)) {
          const ci = cultureOfRegion(r, k);
          if (ci >= 0) { key = ci + 1; col = S.cultures[ci].color; }
        }
      } else if (owner) { key = owner; col = k ? k.color : '#a8b0b8'; }
      if (col && !keyColor.has(key)) keyColor.set(key, col);
      const occ = !culture && owner && ctrl && ctrl !== owner && S.kingdoms.has(ctrl);
      infos.set(r.id, { id: r.id, owner, ctrl, key, px: col ? packColor(col, alpha) : 0, pxEdge: col ? packColor(col, alpha + 0.13) : 0, lab: null, labPx: 0, labName: '', stripe: occ ? colorOf(ctrl) : null, x0: w, y0: h, x1: -1, y1: -1 });
    }
    // ---- fill (1 px per tile) + occupation stripes + bounding boxes
    let lastR = -1, lastI = null, hasStripes = false;
    if (!culture) for (const inf of infos.values()) if (inf.stripe) { hasStripes = true; break; }
    if (hasStripes) {
      if (!pol.stripe) { pol.stripe = mk(w * SP, h * SP); pol.sctx = pol.stripe.getContext('2d'); pol.patterns.clear(); }
      pol.sctx.clearRect(0, 0, w * SP, h * SP);
    }
    pol.stripeTiles = 0; pol.stripeBox = null;
    let sbx0 = w, sby0 = h, sbx1 = -1, sby1 = -1;
    if (!pol.tileInfo || pol.tileInfo.length !== n) pol.tileInfo = new Array(n);
    const ti = pol.tileInfo;
    for (let y = 0; y < h; y++) {
      let runStart = -1, runCol = null;
      for (let x = 0; x <= w; x++) {
        const i = y * w + x;
        let col = null;
        if (x < w) {
          const rr = reg[i];
          ti[i] = null;
          if (rr) {
            if (rr !== lastR) { lastR = rr; lastI = infos.get(rr) || null; }
            if (lastI) {
              px[i] = lastI.px; col = lastI.stripe; ti[i] = lastI;
              if (x < lastI.x0) lastI.x0 = x; if (x > lastI.x1) lastI.x1 = x; if (y < lastI.y0) lastI.y0 = y; if (y > lastI.y1) lastI.y1 = y;
              if (col) { if (x < sbx0) sbx0 = x; if (x > sbx1) sbx1 = x; if (y < sby0) sby0 = y; if (y > sby1) sby1 = y; }
            }
          }
        }
        if (col !== runCol) {
          if (runCol && hasStripes) { pol.sctx.fillStyle = stripePattern(runCol); pol.sctx.fillRect(runStart * SP, y * SP, (x - runStart) * SP, SP); pol.stripeTiles += x - runStart; }
          runCol = col; runStart = x;
        }
      }
    }
    if (pol.stripeTiles > 0) pol.stripeBox = [sbx0, sby0, sbx1 + 1, sby1 + 1];
    // inner edge shading: tiles on the rim of a territory (key changes to the next tile) get a stronger tint, like a soft glow inside the border
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, a0 = ti[i];
        if (!a0 || !a0.key) continue;
        const k0 = a0.key;
        let edge = false;
        if (x > 0) { const o = ti[i - 1]; if (!o || o.key !== k0) edge = true; } else edge = true;
        if (!edge && x < w - 1) { const o = ti[i + 1]; if (!o || o.key !== k0) edge = true; } else if (!edge) edge = true;
        if (!edge && y > 0) { const o = ti[i - w]; if (!o || o.key !== k0) edge = true; } else if (!edge) edge = true;
        if (!edge && y < h - 1) { const o = ti[i + w]; if (!o || o.key !== k0) edge = true; } else if (!edge) edge = true;
        if (edge) px[i] = a0.pxEdge;
      }
    }
    pol.fctx.putImageData(pol.img, 0, 0);

    // ---- boundary runs between regions
    const groups = new Map();
    const thin = [], wild = [], front = [];
    let cA = -1, cB = -1, eKa = 0, eKb = 0, eThin = 0, eFront = 0;
    function classify(ra, rb) {
      if (ra === cA && rb === cB) return;
      cA = ra; cB = rb;
      eKa = eKb = eThin = eFront = 0;
      if (ra === rb) return;
      const ia = ra ? infos.get(ra) : null, ib = rb ? infos.get(rb) : null;
      const ka = ia ? ia.key : 0, kb = ib ? ib.key : 0;
      if (ka !== kb) { eKa = ka; eKb = kb; }
      if (ia && ib) {
        if (ka === kb) eThin = ka ? 1 : 2;
        if (!culture && ia.ctrl && ib.ctrl && ia.ctrl !== ib.ctrl) {
          const pk = pairKey(ia.ctrl, ib.ctrl);
          eFront = (frontPairs ? frontPairs.has(pairKey(ra, rb)) : warPairs.has(pk)) ? 1 : 0;
        }
      }
    }
    for (let y = 0; y <= h; y++) {                              // horizontal edges (between rows y-1 and y)
      let cT = 0, sT = 0, cBt = 0, sB = 0, cTh = 0, sTh = 0, cF = 0, sF = 0;
      for (let x = 0; x <= w; x++) {
        let kt = 0, kb = 0, th = 0, fr = 0;
        if (x < w) { classify(y > 0 ? reg[(y - 1) * w + x] : 0, y < h ? reg[y * w + x] : 0); kt = eKa; kb = eKb; th = eThin; fr = eFront; }
        if (kt !== cT) { if (cT) addRun(groups, cT, sT, y, x, y, 0, -1); cT = kt; sT = x; }
        if (kb !== cBt) { if (cBt) addRun(groups, cBt, sB, y, x, y, 0, 1); cBt = kb; sB = x; }
        if (th !== cTh) { if (cTh) (cTh === 1 ? thin : wild).push(sTh, y, x, y); cTh = th; sTh = x; }
        if (fr !== cF) { if (cF) front.push(sF, y, x, y); cF = fr; sF = x; }
      }
    }
    cA = -1; cB = -1;
    for (let x = 0; x <= w; x++) {                              // vertical edges (between columns x-1 and x)
      let cL = 0, sL = 0, cR = 0, sR = 0, cTh = 0, sTh = 0, cF = 0, sF = 0;
      for (let y = 0; y <= h; y++) {
        let kl = 0, kr = 0, th = 0, fr = 0;
        if (y < h) { classify(x > 0 ? reg[y * w + x - 1] : 0, x < w ? reg[y * w + x] : 0); kl = eKa; kr = eKb; th = eThin; fr = eFront; }
        if (kl !== cL) { if (cL) addRun(groups, cL, x, sL, x, y, -1, 0); cL = kl; sL = y; }
        if (kr !== cR) { if (cR) addRun(groups, cR, x, sR, x, y, 1, 0); cR = kr; sR = y; }
        if (th !== cTh) { if (cTh) (cTh === 1 ? thin : wild).push(x, sTh, x, y); cTh = th; sTh = y; }
        if (fr !== cF) { if (cF) front.push(x, sF, x, y); cF = fr; sF = y; }
      }
    }
    const gl = [];
    groups.forEach((arr, key) => { const c = keyColor.get(key) || '#ffffff'; gl.push({ key, color: c, seg: new Float32Array(arr) }); });
    pol.groups = gl;
    pol.thin = thin.length ? new Float32Array(thin) : null;
    pol.wild = wild.length ? new Float32Array(wild) : null;
    pol.front = front.length ? new Float32Array(front) : null;
    pol.ver = S.regionVer; pol.ownerVer = S.ownerVer; pol.warSig = sig; pol.mode = mode; pol.key = reg;
    pol.built = performance.now(); pol.builds++;
    pol.buildMs = pol.built - t0;
  }
  function ensurePolitical(mode) {
    const sig = warSignature();
    const stale = pol.mode !== mode || pol.key !== S.region || pol.w !== W || pol.h !== H || !pol.fill;
    if (!stale && pol.ver === S.regionVer && pol.ownerVer === S.ownerVer && pol.warSig === sig) return;
    if (!stale && performance.now() - pol.built < POL_THROTTLE) return;
    buildPolitical(mode, sig);
  }

  // ------------------------------------------------------------------ per-frame drawing of the cached layer
  function strokeSegs(arr, off, stride) {                      // arr: [x0,y0,x1,y1(,nx,ny)] in tile coords, view-culled, one stroke() call
    ctx.beginPath();
    let any = false;
    for (let k = 0; k < arr.length; k += stride) {
      const x0 = arr[k], y0 = arr[k + 1], x1 = arr[k + 2], y1 = arr[k + 3];
      if (x1 < vx0 - 1 || x0 > vx1 + 1 || y1 < vy0 - 1 || y0 > vy1 + 1) continue;
      const nx = stride === 6 ? arr[k + 4] * off : 0, ny = stride === 6 ? arr[k + 5] * off : 0;
      ctx.moveTo(ox + x0 * Z + nx, oy + y0 * Z + ny); ctx.lineTo(ox + x1 * Z + nx, oy + y1 * Z + ny);
      any = true;
    }
    if (any) ctx.stroke();
  }
  function drawPolitical(mode) {
    if (vx1 <= vx0 || vy1 <= vy0) return;
    const culture = mode === MODE.CULTURE;
    const dx = ox + vx0 * Z, dy = oy + vy0 * Z, dw = (vx1 - vx0) * Z, dh = (vy1 - vy0) * Z;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pol.fill, vx0, vy0, vx1 - vx0, vy1 - vy0, dx, dy, dw, dh);
    const sb = pol.stripeBox;
    if (sb && pol.stripe && !culture) {                      // occupation stripes: only the part of the cache that holds striped tiles
      const x0 = Math.max(vx0, sb[0]), y0 = Math.max(vy0, sb[1]), x1 = Math.min(vx1, sb[2]), y1 = Math.min(vy1, sb[3]);
      if (x1 > x0 && y1 > y0) {
        ctx.imageSmoothingEnabled = Z < SP;
        ctx.drawImage(pol.stripe, x0 * SP, y0 * SP, (x1 - x0) * SP, (y1 - y0) * SP, ox + x0 * Z, oy + y0 * Z, (x1 - x0) * Z, (y1 - y0) * Z);
        ctx.imageSmoothingEnabled = false;
      }
    }
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    if (pol.wild) { ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = Math.max(1, dpr); strokeSegs(pol.wild, 0, 4); }
    if (pol.thin) { ctx.strokeStyle = 'rgba(255,255,255,0.42)'; ctx.lineWidth = Math.max(1, dpr); strokeSegs(pol.thin, 0, 4); }
    const lw = (culture ? 1.6 : 2) * dpr, gs = pol.groups;
    ctx.lineCap = 'square';
    if (gs.length) {
      if (zoomCss >= 5.5) { ctx.strokeStyle = 'rgba(8,10,24,0.5)'; ctx.lineWidth = lw * 2 + dpr * 1.6; for (let g = 0; g < gs.length; g++) strokeSegs(gs[g].seg, 0, 6); }   // shared dark casing under both sides of a border
      ctx.globalAlpha = 1; ctx.lineWidth = lw;
      for (let g = 0; g < gs.length; g++) { ctx.strokeStyle = gs[g].color; strokeSegs(gs[g].seg, lw, 6); }
    }
    if (pol.front && !culture) {                                                                 // front lines: black base + red dashes
      ctx.lineCap = 'butt';
      ctx.strokeStyle = 'rgba(8,4,6,0.97)'; ctx.lineWidth = 6 * dpr; strokeSegs(pol.front, 0, 4);
      ctx.strokeStyle = '#ee3a2e'; ctx.lineWidth = 4 * dpr;
      const dash = Math.max(3, Math.min(7, Z * 0.32));
      ctx.setLineDash([dash, dash]);
      strokeSegs(pol.front, 0, 4);
      ctx.setLineDash([]);
    }
    ctx.lineCap = 'butt';
  }
  /** fill + stripes + lines + fronts + names only depend on the camera and the cached data: while the camera is at rest they are rendered once
   *  into a screen-sized layer and blitted (1 drawImage per idle frame); while it moves (pan / pinch / glide) they are drawn directly. */
  function drawPoliticalLayer(mode, political) {
    const L = polLayer;
    const rest = L.fOx === ox && L.fOy === oy && L.fZ === Z && L.fCw === cw && L.fCh === ch;
    L.fOx = ox; L.fOy = oy; L.fZ = Z; L.fCw = cw; L.fCh = ch;
    const fresh = L.cv && L.cv.width === cw && L.cv.height === ch && L.builds === pol.builds && L.ox === ox && L.oy === oy && L.Z === Z && L.mode === mode && L.political === political && L.key === pol.key;
    ctx.globalAlpha = 1;
    if (fresh) { blitLayer(L); L.blits++; return; }
    if (!rest) { drawPolitical(mode); drawRegionLabels(mode); if (political) drawKingdomLabels(); L.direct++; return; }
    if (!L.cv || L.cv.width !== cw || L.cv.height !== ch) { L.cv = mk(cw, ch); L.cx = L.cv.getContext('2d'); }
    const main = ctx;
    ctx = L.cx;
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.clearRect(0, 0, cw, ch);
      drawPolitical(mode);
      drawRegionLabels(mode);
      if (political) drawKingdomLabels();
    } finally { ctx = main; }
    L.builds = pol.builds; L.ox = ox; L.oy = oy; L.Z = Z; L.mode = mode; L.political = political; L.key = pol.key; L.draws++;
    blitLayer(L);
  }
  function blitLayer(L) {                                  // only the part of the screen that shows map (+ a margin for names) can hold anything
    const m = Math.round(48 * dpr);
    const x0 = Math.max(0, Math.floor(ox + vx0 * Z - m)), y0 = Math.max(0, Math.floor(oy + vy0 * Z - m));
    const x1 = Math.min(cw, Math.ceil(ox + vx1 * Z + m)), y1 = Math.min(ch, Math.ceil(oy + vy1 * Z + m));
    ctx.imageSmoothingEnabled = false;
    if (x1 > x0 && y1 > y0) ctx.drawImage(L.cv, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  }

  // ------------------------------------------------------------------ text labels (cached bitmaps)
  const textCache = new Map();
  let measCtx = null;
  function measure(font, text) { if (!measCtx) measCtx = mk(4, 4).getContext('2d'); measCtx.font = font; return measCtx.measureText(text).width; }
  /** spaced upper-case label with dark outline; key = cache key; px = font size in device px */
  function textLabel(key, text, px, fill, spacing, weight) {
    let e = textCache.get(key);
    if (e) return e;
    if (textCache.size > 220) textCache.clear();
    const font = (weight || 'bold') + ' ' + px + 'px ' + FONT, chars = Array.from(text);
    const sp = spacing * px;
    let tw = 0; const ws = [];
    for (let i = 0; i < chars.length; i++) { const cw2 = measure(font, chars[i]); ws.push(cw2); tw += cw2 + (i < chars.length - 1 ? sp : 0); }
    const pad2 = Math.ceil(px * 0.3) + 2, w = Math.ceil(tw) + pad2 * 2, h = Math.ceil(px * 1.35) + pad2 * 2;
    const cv = mk(w, h), g = cv.getContext('2d');
    g.font = font; g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineWidth = Math.max(2, px * 0.3); g.strokeStyle = 'rgba(8,10,24,0.88)'; g.fillStyle = fill;
    let x = pad2;
    for (let i = 0; i < chars.length; i++) { g.strokeText(chars[i], x, h / 2 + 0.5); g.fillText(chars[i], x, h / 2 + 0.5); x += ws[i] + sp; }
    e = { cv, w, h };
    textCache.set(key, e);
    return e;
  }
  function drawRegionLabels(mode) {
    regLabelsDrawn = 0;
    if (zoomCss < 7) return;
    const px = Math.max(8, Math.min(13, Math.round((6.4 + zoomCss * 0.34))));              // css px
    const dpx = Math.round(px * dpr);
    ctx.imageSmoothingEnabled = false;
    const culture = mode === MODE.CULTURE;
    for (const r of S.regions.values()) {
      if (!r.name) continue;
      const c = regionCenter(r.id); if (!c) continue;
      if (c.x < vx0 - 6 || c.x > vx1 + 6 || c.y < vy0 - 4 || c.y > vy1 + 4) continue;
      const inf = pol.infos.get(r.id);
      const owned = inf && inf.owner;
      let e = inf ? inf.lab : null;
      if (!e || inf.labPx !== dpx || inf.labName !== r.name) {                  // per-region label bitmap, looked up once per rebuild / font size
        const tint = owned && !culture ? lighten(colorOf(inf.owner), 0.8) : (owned ? '#fff8e6' : '#d5dde6');
        e = textLabel('r' + r.id + '|' + r.name + '|' + dpx + '|' + tint, String(r.name).toUpperCase(), dpx, tint, 0.08, '600');
        if (inf) { inf.lab = e; inf.labPx = dpx; inf.labName = r.name; }
      }
      // shrink long names so they stay inside the region
      const regW = Math.sqrt(r.tiles || 60) * Z * 1.15;
      const sc = e.w > regW ? Math.max(0.62, regW / e.w) : 1;
      if (sc < 0.7 && e.w > regW * 1.6) continue;
      const hasCity = r.cityIds && r.cityIds.length > 0;
      const sx = ox + c.x * Z, sy = oy + (c.y + (hasCity ? 0.1 : 0)) * Z + (hasCity ? Z * 1.7 + e.h * 0.25 : 0);
      ctx.globalAlpha = (owned ? 0.9 : 0.68) * (zoomCss > 16 ? Math.max(0.55, 1 - (zoomCss - 16) * 0.03) : 1);
      ctx.drawImage(e.cv, Math.round(sx - e.w * sc / 2), Math.round(sy - e.h * sc / 2), Math.round(e.w * sc), Math.round(e.h * sc));
      regLabelsDrawn++;
    }
    ctx.globalAlpha = 1;
  }
  function drawKingdomLabels() {                              // zoomed-out overview: kingdom names under their capitals
    kingLabelsDrawn = 0;
    if (zoomCss >= 7) return;
    const dpx = Math.round(Math.max(9, Math.min(15, 5 + zoomCss * 1.5)) * dpr);
    ctx.imageSmoothingEnabled = false;
    for (const k of S.kingdoms.values()) {
      if (k.alive === false || !k.name) continue;
      let c = k.capitalId ? S.cities.get(k.capitalId) : null;
      if (!c && k.cities && k.cities.length) c = S.cities.get(k.cities[0]);
      if (!c) continue;
      if (c.x < vx0 - 10 || c.x > vx1 + 10 || c.y < vy0 - 4 || c.y > vy1 + 6) continue;
      const e = textLabel('k' + k.id + '|' + k.name + '|' + dpx, String(k.name).toUpperCase(), dpx, '#ffffff', 0.12, 'bold');
      ctx.globalAlpha = 0.95;
      ctx.drawImage(e.cv, Math.round(ox + (c.x + 0.5) * Z - e.w / 2), Math.round(oy + (c.y + 1) * Z + 1 * dpr + e.h * 0.1), e.w, e.h);
      kingLabelsDrawn++;
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ region geometry (highlights)
  function geomOf(rid) {
    if (geom.key !== S.region || geom.ver !== S.regionVer) { geom.key = S.region; geom.ver = S.regionVer; geom.cache.clear(); geom.bbox = null; }
    let g = geom.cache.get(rid);
    if (g !== undefined) return g;
    if (!geom.bbox) {                                          // one pass over the map gives the bounding box of every region
      const bb = new Map(), reg = S.region; let lastR = 0, cur = null;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const r = reg[y * W + x]; if (!r) continue;
        if (r !== lastR) { lastR = r; cur = bb.get(r); if (!cur) { cur = [x, y, x, y]; bb.set(r, cur); } }
        if (x < cur[0]) cur[0] = x; if (x > cur[2]) cur[2] = x; if (y < cur[1]) cur[1] = y; if (y > cur[3]) cur[3] = y;
      }
      geom.bbox = bb;
    }
    const b = geom.bbox.get(rid);
    if (!b) { geom.cache.set(rid, null); return null; }
    if (geom.cache.size > 48) geom.cache.clear();
    const reg = S.region, runs = [], edges = [];
    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? -1 : reg[y * W + x];
    for (let y = b[1]; y <= b[3]; y++) {
      let s = -1;
      for (let x = b[0]; x <= b[2] + 1; x++) {
        const inn = x <= b[2] && reg[y * W + x] === rid;
        if (inn && s < 0) s = x; else if (!inn && s >= 0) { runs.push(y, s, x - 1); s = -1; }
      }
      let sT = -1, sB = -1;                                    // horizontal boundary pieces above / below this row
      for (let x = b[0]; x <= b[2] + 1; x++) {
        const inn = x <= b[2] && reg[y * W + x] === rid;
        const t = inn && at(x, y - 1) !== rid, bt = inn && at(x, y + 1) !== rid;
        if (t && sT < 0) sT = x; else if (!t && sT >= 0) { edges.push(sT, y, x, y); sT = -1; }
        if (bt && sB < 0) sB = x; else if (!bt && sB >= 0) { edges.push(sB, y + 1, x, y + 1); sB = -1; }
      }
    }
    for (let x = b[0]; x <= b[2]; x++) {
      let sL = -1, sR = -1;
      for (let y = b[1]; y <= b[3] + 1; y++) {
        const inn = y <= b[3] && reg[y * W + x] === rid;
        const l = inn && at(x - 1, y) !== rid, r = inn && at(x + 1, y) !== rid;
        if (l && sL < 0) sL = y; else if (!l && sL >= 0) { edges.push(x, sL, x, y); sL = -1; }
        if (r && sR < 0) sR = y; else if (!r && sR >= 0) { edges.push(x + 1, sR, x + 1, y); sR = -1; }
      }
    }
    g = { x0: b[0], y0: b[1], x1: b[2], y1: b[3], runs: new Int32Array(runs), edges: new Float32Array(edges) };
    geom.cache.set(rid, g);
    return g;
  }
  function fillRegion(g, style) {
    ctx.fillStyle = style;
    const r = g.runs;
    for (let k = 0; k < r.length; k += 3) {
      const y = r[k];
      if (y < vy0 - 1 || y > vy1) continue;
      const xa = Math.round(ox + r[k + 1] * Z), xb = Math.round(ox + (r[k + 2] + 1) * Z), ya = Math.round(oy + y * Z), yb = Math.round(oy + (y + 1) * Z);
      ctx.fillRect(xa, ya, xb - xa, yb - ya);
    }
  }
  function strokeRegion(g, color, width, casing, dash) {
    const e = g.edges;
    if (casing) { ctx.strokeStyle = casing; ctx.lineWidth = width + 2.6 * dpr; strokeSegs(e, 0, 4); }
    ctx.strokeStyle = color; ctx.lineWidth = width;
    if (dash) { ctx.setLineDash(dash); ctx.lineDashOffset = -curNow / 90 * dpr; }
    strokeSegs(e, 0, 4);
    if (dash) { ctx.setLineDash([]); ctx.lineDashOffset = 0; }
  }

  // ------------------------------------------------------------------ marker sprites (cached)
  const markCache = new Map();
  const STAR = ['....y....', '....y....', '...yyy...', 'yyyyyyyyy', '.yyyyyyy.', '..yyyyy..', '..yyyyy..', '.yyy.yyy.', '.yy...yy.'];
  function starSprite(color, done, scale) {
    const key = 's' + color + done + '|' + scale;
    let c = markCache.get(key);
    if (c) return c;
    const S0 = 9, pad3 = 1, sz = (S0 + pad3 * 2 + (done ? 3 : 0)) * scale;
    c = mk(sz, sz);
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    const dk = darken(color, 0.45), lt = lighten(color, 0.55);
    for (let pass = 0; pass < 3; pass++) {                    // 0 = dark outline, 1 = fill, 2 = highlights
      for (let y = 0; y < S0; y++) for (let x = 0; x < S0; x++) {
        if (STAR[y][x] !== 'y') continue;
        if (pass === 0) { g.fillStyle = '#0b0e1c'; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) g.fillRect((pad3 + x + i) * scale, (pad3 + y + j) * scale, scale, scale); }
        else if (pass === 1) { g.fillStyle = (x + y > 9 || y > 6) ? dk : color; g.fillRect((pad3 + x) * scale, (pad3 + y) * scale, scale, scale); }
        else if (x + y < 7 && y > 0 && y < 6 && (x + y) % 2 === 1) { g.fillStyle = lt; g.fillRect((pad3 + x) * scale, (pad3 + y) * scale, scale, scale); }
      }
    }
    if (done) {                                               // small green check badge
      const bx = (pad3 + 6) * scale, by = (pad3 + 5) * scale;
      g.fillStyle = '#0b0e1c'; g.fillRect(bx - scale, by - scale, 5 * scale, 5 * scale);
      g.fillStyle = '#3fcf5a'; g.fillRect(bx, by, 3 * scale, 3 * scale);
      g.fillStyle = '#ffffff'; g.fillRect(bx, by + scale, scale, scale); g.fillRect(bx + scale, by + 2 * scale, scale, scale); g.fillRect(bx + 2 * scale, by, scale, scale);
    }
    markCache.set(key, c);
    return c;
  }
  function lighten(str, t) {
    if (typeof str !== 'string' || str.charCodeAt(0) !== 35 || str.length < 7) return '#ffffff';
    const f = v => Math.round(v + (255 - v) * t);
    return 'rgb(' + f(parseInt(str.slice(1, 3), 16)) + ',' + f(parseInt(str.slice(3, 5), 16)) + ',' + f(parseInt(str.slice(5, 7), 16)) + ')';
  }
  function iconScaled(key, scale) {                           // icon at an integer multiple of its native 16 px (crisp)
    return Sprites.icon(key, 16 * scale);
  }

  // ------------------------------------------------------------------ command overlay: highlights + goal stars
  function drawGoalMarker(rid, color, done, now, pending) {
    const c = regionCenter(rid); if (!c) return;
    if (c.x < vx0 - 3 || c.x > vx1 + 3 || c.y < vy0 - 3 || c.y > vy1 + 3) return;
    goalsDrawn++; if (done) goalsDoneDrawn++;
    const scale = Math.max(1, Math.min(4, Math.round(Z * 0.62 / 9 + 0.35)));
    const sp = starSprite(color, done ? 1 : 0, scale);
    const bob = Math.sin(now / 420 + rid) * 1.5 * dpr * (done ? 0 : 1);
    const sx = Math.round(ox + c.x * Z - sp.width / 2), sy = Math.round(oy + c.y * Z - Z * 1.15 - sp.height / 2 + bob);
    if (pending) {                                            // pulsing ring on the ground under the star
      const pr = 0.5 + 0.5 * Math.sin(now / 300 + rid);
      ctx.globalAlpha = 0.25 + 0.2 * pr; ctx.strokeStyle = color; ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.ellipse(ox + c.x * Z, oy + (c.y + 0.35) * Z, Z * (0.55 + 0.15 * pr), Z * (0.27 + 0.07 * pr), 0, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sp, sx, sy);
  }
  function drawCommandLayer(now, political) {
    const cmd = api.cmd;
    goalsDrawn = 0; goalsDoneDrawn = 0;
    // war goals as star markers (commanded kingdom's, or everyone's with showAllOrders) — political map only
    if (political && S.wars) {
      const cid = cmd && cmd.kid ? cmd.kid : 0;
      for (const w of S.wars.values()) {
        if (w.ended || !w.goals) continue;
        for (let i = 0; i < w.goals.length; i++) {
          const gl = w.goals[i];
          if (!gl || !gl.regionId) continue;
          if (!api.showAllOrders && gl.kid !== cid) continue;
          drawGoalMarker(gl.regionId, colorOf(gl.kid), !!gl.done, now, false);
        }
      }
    }
    if (!cmd) return;
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);
    const kcol = cmd.kid ? colorOf(cmd.kid) : '#ffd23c';
    // target kingdom: red pulsing outer border
    if (cmd.targetKid && pol.groups.length && political) {
      for (let g = 0; g < pol.groups.length; g++) {
        if (pol.groups[g].key !== cmd.targetKid) continue;
        ctx.lineCap = 'square';
        ctx.globalAlpha = 0.45 + 0.35 * pulse; ctx.strokeStyle = '#ff4a3c'; ctx.lineWidth = 3.4 * dpr;
        strokeSegs(pol.groups[g].seg, 3.4 * dpr * 0.5, 6);
        ctx.globalAlpha = 1; ctx.lineCap = 'butt';
      }
    }
    // UI war flow (optional fields): sel = outline the selected attacker, dim = unavailable neighbour regions,
    // tgt = candidates are attack targets (red pulse + crosshair with the defender flag from ckids[i]), arrows = attack preview
    if (cmd.sel && cmd.kid && pol.groups.length && political) {
      for (let g = 0; g < pol.groups.length; g++) {
        if (pol.groups[g].key !== cmd.kid) continue;
        ctx.lineCap = 'square'; ctx.lineJoin = 'round';
        ctx.globalAlpha = 0.28 + 0.14 * pulse; ctx.strokeStyle = lighten(kcol, 0.35); ctx.lineWidth = 7 * dpr;
        strokeSegs(pol.groups[g].seg, 0, 6);
        ctx.globalAlpha = 0.95; ctx.strokeStyle = 'rgba(6,10,22,0.9)'; ctx.lineWidth = 4.2 * dpr;
        strokeSegs(pol.groups[g].seg, 0, 6);
        ctx.strokeStyle = '#fff6d8'; ctx.lineWidth = 2.2 * dpr;
        strokeSegs(pol.groups[g].seg, 0, 6);
        ctx.globalAlpha = 1; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
      }
    }
    const dims = cmd.dim;
    if (dims && dims.length) {
      for (let i = 0; i < dims.length; i++) {
        const g = geomOf(dims[i]); if (!g) continue;
        if (g.x1 < vx0 - 1 || g.x0 > vx1 + 1 || g.y1 < vy0 - 1 || g.y0 > vy1 + 1) continue;
        fillRegion(g, 'rgba(5,8,18,0.42)');
        strokeRegion(g, 'rgba(170,180,200,0.55)', 1.2 * dpr, null, [3 * dpr, 4 * dpr]);
      }
    }
    const cands = cmd.candidates;
    if (cands && cands.length) {
      for (let i = 0; i < cands.length; i++) {
        const g = geomOf(cands[i]); if (!g) continue;
        if (g.x1 < vx0 - 1 || g.x0 > vx1 + 1 || g.y1 < vy0 - 1 || g.y0 > vy1 + 1) continue;
        if (cmd.tgt) {
          fillRegion(g, 'rgba(255,72,48,' + (0.08 + 0.09 * pulse).toFixed(3) + ')');
          ctx.lineJoin = 'round';
          strokeRegion(g, '#ff5a3c', (2.2 + 0.9 * pulse) * dpr, 'rgba(30,4,4,0.85)', null);
          ctx.lineJoin = 'miter';
          continue;
        }
        fillRegion(g, 'rgba(235,250,255,' + (0.13 + 0.09 * pulse).toFixed(3) + ')');
        strokeRegion(g, '#ffffff', 2.4 * dpr, 'rgba(4,14,34,0.85)', [6 * dpr, 4 * dpr]);
      }
      if (cmd.tgt) for (let i = 0; i < cands.length; i++) drawTargetMark(cands[i], cmd.ckids ? cmd.ckids[i] : 0, now);
    }
    const gls = cmd.goals;
    if (gls && gls.length) {
      for (let i = 0; i < gls.length; i++) {
        const g = geomOf(gls[i]); if (!g) continue;
        if (g.x1 >= vx0 - 1 && g.x0 <= vx1 + 1 && g.y1 >= vy0 - 1 && g.y0 <= vy1 + 1) {
          fillRegion(g, 'rgba(255,205,60,' + (0.16 + 0.08 * pulse).toFixed(3) + ')');
          strokeRegion(g, '#ffd23c', 2.6 * dpr, 'rgba(40,24,0,0.75)', null);
        }
        drawGoalMarker(gls[i], kcol, false, now, true);
      }
    }
    if (cmd.regionId) {
      const g = geomOf(cmd.regionId);
      if (g && g.x1 >= vx0 - 1 && g.x0 <= vx1 + 1 && g.y1 >= vy0 - 1 && g.y0 <= vy1 + 1) {
        fillRegion(g, 'rgba(255,240,160,' + (0.14 + 0.1 * pulse).toFixed(3) + ')');
        ctx.globalAlpha = 0.35 + 0.25 * pulse; ctx.lineJoin = 'round';
        strokeRegion(g, '#ffe46a', (6 + pulse * 2) * dpr, null, null);                      // soft outer glow
        ctx.globalAlpha = 0.8 + 0.2 * pulse;
        strokeRegion(g, '#fff3b0', (2.8 + pulse * 1.4) * dpr, 'rgba(10,8,0,0.85)', null);
        ctx.globalAlpha = 1;
      }
    }
    const arr = cmd.arrows;                                    // attack preview (tile coords), grows in from arrowT0
    if (arr && arr.length) {
      const p0 = Math.max(0, Math.min(1, (now - (cmd.arrowT0 || 0)) / 420)), p = 1 - (1 - p0) * (1 - p0) * (1 - p0);
      const w = dpr * 4.2 * Math.max(0.8, Math.min(1.25, zoomCss / 10));
      for (let i = 0; i < arr.length && i < 6; i++) {
        const a = arr[i]; if (!a) continue;
        const x0 = ox + a.x0 * Z, y0 = oy + a.y0 * Z, x1 = ox + a.x1 * Z, y1 = oy + a.y1 * Z;
        drawArrow(x0, y0, x0 + (x1 - x0) * p, y0 + (y1 - y0) * p, w, 'attack', kcol, now, true);
      }
    }
  }
  /** attack target marker at a region centre: pulsing crosshair ring + the defender's flag on a small post */
  function drawTargetMark(rid, kid, now) {
    const c = regionCenter(rid); if (!c) return;
    if (c.x < vx0 - 2 || c.x > vx1 + 2 || c.y < vy0 - 2 || c.y > vy1 + 2) return;
    const sx = ox + c.x * Z, sy = oy + c.y * Z, pr = 0.5 + 0.5 * Math.sin(now / 240 + rid);
    const R0 = Math.max(7, Math.min(13, zoomCss * 0.95)) * dpr * (0.94 + 0.12 * pr);
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.9; ctx.strokeStyle = 'rgba(22,4,4,0.9)'; ctx.lineWidth = 4.4 * dpr;
    ctx.beginPath(); ctx.arc(sx, sy, R0, 0, TAU); ctx.stroke();
    ctx.strokeStyle = '#ff5a3c'; ctx.lineWidth = 2.2 * dpr;
    ctx.beginPath(); ctx.arc(sx, sy, R0, 0, TAU); ctx.stroke();
    const t0 = R0 * 0.45, t1 = R0 * 1.45;
    ctx.beginPath();
    ctx.moveTo(sx - t1, sy); ctx.lineTo(sx - t0, sy); ctx.moveTo(sx + t0, sy); ctx.lineTo(sx + t1, sy);
    ctx.moveTo(sx, sy - t1); ctx.lineTo(sx, sy - t0); ctx.moveTo(sx, sy + t0); ctx.lineTo(sx, sy + t1);
    ctx.strokeStyle = 'rgba(22,4,4,0.9)'; ctx.lineWidth = 4 * dpr; ctx.stroke();
    ctx.strokeStyle = '#ffe2d8'; ctx.lineWidth = 1.8 * dpr; ctx.stroke();
    ctx.fillStyle = '#ff5a3c'; ctx.fillRect(Math.round(sx - dpr), Math.round(sy - dpr), Math.round(2 * dpr), Math.round(2 * dpr));
    ctx.globalAlpha = 1; ctx.lineCap = 'butt';
    const k = kid ? kingdomOf(kid) : null;
    if (k && k.flag) {                                         // defender flag up-right of the ring
      const fw = Math.round(14 * dpr), fh = Math.round(9 * dpr);
      const fx = Math.round(sx + R0 * 0.7), fy = Math.round(sy - R0 * 0.7 - fh);
      ctx.fillStyle = 'rgba(8,10,20,0.95)'; ctx.fillRect(fx - Math.round(dpr), fy - Math.round(dpr), fw + Math.round(2 * dpr), fh + Math.round(2 * dpr));
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(Sprites.flag(k.flag, fw, fh), fx, fy, fw, fh);
    }
  }

  // ------------------------------------------------------------------ armies: banners + order arrows
  const armyPos = new Map();
  const hits = [];                                  // banner hit boxes of the last frame: id, x0,y0,x1,y1 (css px)
  let hitN = 0, bannersDrawn = 0, arrowsDrawn = 0, armyGc = 0, regLabelsDrawn = 0, kingLabelsDrawn = 0, goalsDrawn = 0, goalsDoneDrawn = 0, occFlagsDrawn = 0;
  const bannerCache = new Map();
  const ARM_ICON = { attack: 'sword', defend: 'shield', hold: 'shield' };
  function armyIconKey(a) {
    const t = a.order ? a.order.type : '';
    if (a.mode === 'retreat' || t === 'retreat') return '';
    if (t === 'attack' || a.mode === 'siege' || a.mode === 'march') return 'sword';
    if (t === 'hold' || t === 'defend' || a.mode === 'hold') return 'shield';
    return '';
  }
  function flagSig(f) { return f ? f.pattern + '.' + f.symbol + f.c1 + f.c2 + f.c3 : ''; }
  /** HOI4-style unit counter: team-coloured plate with the kingdom flag, soldier count, order glyph and a pointer; anchor = bottom centre */
  function bannerSprite(k, count, iconKey, bs, retreat) {
    const key = (k ? k.id + flagSig(k.flag) + k.color : 'x') + '|' + count + '|' + iconKey + '|' + bs + '|' + dpr + (retreat ? 'r' : '');
    let e = bannerCache.get(key);
    if (e) return e;
    if (bannerCache.size > 160) bannerCache.clear();
    const u = dpr * bs / 20;                                  // bs is stored in 1/20 steps
    const fw = Math.round(15 * u), fh = Math.round(10 * u), pd = Math.max(1, Math.round(1.6 * u)), gap = Math.max(2, Math.round(3 * u)), bd = Math.max(1, Math.round(1.6 * u));
    const fpx = Math.round(10.5 * u), font = 'bold ' + fpx + 'px ' + FONT, txt = String(count);
    const tw = Math.ceil(measure(font, txt));
    const isz = iconKey ? Math.max(8, Math.round(9.5 * u / 8) * 8) : 0;                // 8 / 16 / 24 px native-ish multiples
    const ph = Math.round(14 * u) + bd * 2, stem = Math.max(2, Math.round(3.5 * u));
    const pw = bd * 2 + pd * 2 + fw + gap + tw + (isz ? gap + isz : 0);
    const cv = mk(pw, ph + stem + 1), g = cv.getContext('2d');
    const col = k && typeof k.color === 'string' ? k.color : '#a8b0b8';
    g.fillStyle = '#080b16'; g.fillRect(0, 0, pw, ph);
    g.fillStyle = retreat ? '#8a94a8' : col; g.fillRect(1, 1, pw - 2, ph - 2);
    g.fillStyle = '#10162a'; g.fillRect(bd + 1, bd + 1, pw - 2 * bd - 2, ph - 2 * bd - 2);
    // pointer
    g.fillStyle = '#080b16'; g.beginPath(); g.moveTo(pw / 2 - stem - 1, ph - 1); g.lineTo(pw / 2 + stem + 1, ph - 1); g.lineTo(pw / 2, ph + stem + 1); g.closePath(); g.fill();
    g.fillStyle = retreat ? '#8a94a8' : col; g.beginPath(); g.moveTo(pw / 2 - stem, ph - 1); g.lineTo(pw / 2 + stem, ph - 1); g.lineTo(pw / 2, ph + stem); g.closePath(); g.fill();
    g.imageSmoothingEnabled = false;
    let x = bd + pd + 1;
    const fy = Math.round((ph - fh) / 2);
    g.fillStyle = '#05070f'; g.fillRect(x - 1, fy - 1, fw + 2, fh + 2);
    if (k && k.flag) g.drawImage(Sprites.flag(k.flag, fw, fh), x, fy, fw, fh);
    x += fw + gap;
    g.font = font; g.textBaseline = 'middle'; g.fillStyle = '#ffffff'; g.fillText(txt, x, ph / 2 + 0.5 * dpr);
    x += tw + gap;
    if (isz) g.drawImage(Sprites.icon(iconKey, 16), x, Math.round((ph - isz) / 2), isz, isz);
    e = { cv, w: pw, h: ph + stem + 1, ph, stem };
    bannerCache.set(key, e);
    return e;
  }
  function leaderOf(a) {
    let u = a.leaderId ? S.units.get(a.leaderId) : null;
    if (!u && a.members && a.members.length) for (let i = 0; i < a.members.length && !u; i++) u = S.units.get(a.members[i]) || null;
    return u;
  }
  function armyAnchor(a, now) {                      // tile position (smoothed) of the army marker
    let tx, ty;
    const u = leaderOf(a);
    if (u && u.x === u.x) {
      tx = u.px + (u.x - u.px) * curAlpha; ty = u.py + (u.y - u.py) * curAlpha;
      if (tx !== tx) tx = u.x; if (ty !== ty) ty = u.y;
    } else if (a.rally && a.rally.x === a.rally.x) { tx = a.rally.x; ty = a.rally.y; }
    else return null;
    let st = armyPos.get(a.id);
    if (!st) { st = { x: tx, y: ty, t: now }; armyPos.set(a.id, st); return st; }
    const dxx = tx - st.x, dyy = ty - st.y;
    if (dxx * dxx + dyy * dyy > 9) { st.x = tx; st.y = ty; } else { const f = Math.min(1, Math.max(0.1, (now - st.t) / 50)); st.x += dxx * f; st.y += dyy * f; }
    st.t = now;
    return st;
  }
  function armyVisible(a) { return !!(a && a.members && a.members.length > 0); }
  function drawArrow(x0, y0, x1, y1, w, kind, kcol, now, sel) {
    // kind: 'attack' | 'hold' | 'retreat'
    const dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx * dx + dy * dy);
    if (len < 4 * dpr) return false;
    const ux = dx / len, uy = dy / len, nx = uy, ny = -ux;         // left normal in screen space
    const cur = kind === 'hold' ? 0.1 : 0.2;
    const cx = (x0 + x1) / 2 + nx * len * cur, cy = (y0 + y1) / 2 + ny * len * cur;
    let tx = x1 - cx, ty = y1 - cy; const tl = Math.sqrt(tx * tx + ty * ty) || 1; tx /= tl; ty /= tl;   // tangent at the end
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (kind === 'attack') {
      const hl = Math.max(11 * dpr, w * 2.7), hw = Math.max(7.5 * dpr, w * 1.65);
      const ex = x1 - tx * hl * 0.78, ey = y1 - ty * hl * 0.78;
      const path = () => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cx, cy, ex, ey); };
      ctx.globalAlpha = sel ? 1 : 0.93;
      path(); ctx.strokeStyle = kcol; ctx.lineWidth = w + 5 * dpr; ctx.stroke();
      path(); ctx.strokeStyle = 'rgba(26,4,6,0.95)'; ctx.lineWidth = w + 2.4 * dpr; ctx.stroke();
      path(); ctx.strokeStyle = '#e8402f'; ctx.lineWidth = w; ctx.stroke();
      path(); ctx.strokeStyle = 'rgba(255,200,176,0.5)'; ctx.lineWidth = Math.max(1, w * 0.2); ctx.setLineDash([9 * dpr, 9 * dpr]); ctx.lineDashOffset = -now / 34 * dpr; ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
      const head = (grow) => {
        const bx = x1 - tx * hl, by = y1 - ty * hl, px2 = -ty, py2 = tx, hg = grow;
        ctx.beginPath(); ctx.moveTo(x1 + tx * hg, y1 + ty * hg); ctx.lineTo(bx + px2 * (hw + hg), by + py2 * (hw + hg)); ctx.lineTo(bx - px2 * (hw + hg), by - py2 * (hw + hg)); ctx.closePath();
      };
      head(2.6 * dpr); ctx.fillStyle = kcol; ctx.fill();
      head(1.3 * dpr); ctx.fillStyle = 'rgba(26,4,6,0.95)'; ctx.fill();
      head(0); ctx.fillStyle = '#ee4a38'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(x1 - tx * hl * 0.15 + 0, y1 - ty * hl * 0.15); ctx.lineTo(x1 - tx * hl * 0.8 - ty * hw * 0.6, y1 - ty * hl * 0.8 + tx * hw * 0.6); ctx.strokeStyle = 'rgba(255,210,190,0.6)'; ctx.lineWidth = Math.max(1, dpr); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (kind === 'hold') {
      ctx.globalAlpha = sel ? 0.95 : 0.75;
      const path = () => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cx, cy, x1, y1); };
      ctx.lineCap = 'butt';
      ctx.setLineDash([8 * dpr, 5 * dpr]); ctx.lineDashOffset = -now / 40 * dpr;
      path(); ctx.strokeStyle = 'rgba(4,12,38,0.95)'; ctx.lineWidth = Math.max(3 * dpr, w * 0.7) + 2.8 * dpr; ctx.stroke();
      path(); ctx.strokeStyle = '#74c6ff'; ctx.lineWidth = Math.max(3 * dpr, w * 0.7); ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.globalAlpha = 1;
    } else {                                                      // retreat: dotted, with a small open head
      ctx.globalAlpha = sel ? 0.95 : 0.8;
      const path = () => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(cx, cy, x1 - tx * 5 * dpr, y1 - ty * 5 * dpr); };
      ctx.setLineDash([0.1, 5.5 * dpr]); ctx.lineDashOffset = now / 60 * dpr;
      path(); ctx.strokeStyle = 'rgba(8,10,22,0.9)'; ctx.lineWidth = 5 * dpr; ctx.stroke();
      path(); ctx.strokeStyle = '#dfe6f2'; ctx.lineWidth = 3 * dpr; ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
      const hl = 7 * dpr, hw = 4.6 * dpr, bx = x1 - tx * hl, by = y1 - ty * hl;
      ctx.beginPath(); ctx.moveTo(bx - ty * hw, by + tx * hw); ctx.lineTo(x1, y1); ctx.lineTo(bx + ty * hw, by - tx * hw);
      ctx.strokeStyle = 'rgba(8,10,22,0.9)'; ctx.lineWidth = 4.4 * dpr; ctx.stroke(); ctx.strokeStyle = '#dfe6f2'; ctx.lineWidth = 2.2 * dpr; ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    return true;
  }
  function drawOrderMarker(rid, kind, now) {          // shield (hold / defend) or red ring (attack) at the region centre
    const c = regionCenter(rid); if (!c) return;
    const sx = ox + c.x * Z, sy = oy + c.y * Z;
    if (kind === 'hold') {
      const scale = Math.max(1, Math.min(3, Math.round(Z * 0.9 / 16 + 0.2)));
      const ic = iconScaled('shield', scale), pr = 0.5 + 0.5 * Math.sin(now / 340 + rid);
      ctx.globalAlpha = 0.28 + 0.22 * pr; ctx.fillStyle = '#58b0ff';
      ctx.beginPath(); ctx.ellipse(sx, sy + ic.height * 0.15, ic.width * 0.78, ic.height * 0.5, 0, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = false;
      ctx.drawImage(ic, Math.round(sx - ic.width / 2), Math.round(sy - ic.height * 0.62));
    } else if (kind === 'attack') {
      const pr = 0.5 + 0.5 * Math.sin(now / 220 + rid);
      ctx.globalAlpha = 0.5 + 0.4 * pr; ctx.strokeStyle = '#ff4a3c'; ctx.lineWidth = 2.4 * dpr;
      ctx.beginPath(); ctx.ellipse(sx, sy, Z * (0.7 + 0.12 * pr), Z * (0.42 + 0.08 * pr), 0, 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  function targetOf(a) {                           // tile point + kind of an army's order
    const o = a.order;
    if (!o) return null;
    const t = o.type;
    if (t === 'retreat') {
      const home = a.cityId ? S.cities.get(a.cityId) : null;
      if (o.regionId) { const c = regionCenter(o.regionId); if (c) return { x: c.x, y: c.y, kind: 'retreat', rid: o.regionId }; }
      if (home) return { x: home.x + 0.5, y: home.y + 0.5, kind: 'retreat', rid: 0 };
      return null;
    }
    if (!o.regionId) return null;
    const c = regionCenter(o.regionId);
    if (!c) return null;
    return { x: c.x, y: c.y, kind: t === 'attack' ? 'attack' : 'hold', rid: o.regionId };
  }
  function drawArmyOrders(now, political) {
    arrowsDrawn = 0;
    const cmd = api.cmd, cid = cmd && cmd.kid ? cmd.kid : 0, all = political && api.showAllOrders;
    if (!cid && !all) return;
    for (const a of S.armies.values()) {
      if (!armyVisible(a)) continue;
      const mine = a.kingdomId === cid;
      if (!mine && !all) continue;
      const tg = targetOf(a); if (!tg) continue;
      const st = armyPos.get(a.id); if (!st) continue;
      const x0 = ox + st.x * Z, y0 = oy + (st.y + 0.45) * Z, x1 = ox + tg.x * Z, y1 = oy + tg.y * Z;
      const minx = Math.min(x0, x1) - 40, maxx = Math.max(x0, x1) + 40, miny = Math.min(y0, y1) - 40, maxy = Math.max(y0, y1) + 40;
      if (maxx < 0 || minx > cw || maxy < 0 || miny > ch) continue;
      const sel = !!(cmd && cmd.armyId === a.id);
      const n = a.members.length;
      const zs = Math.max(0.75, Math.min(1.2, zoomCss / 12));
      const w = dpr * Math.max(3, Math.min(7.5, 1.9 + Math.sqrt(n) * 0.75)) * zs * (sel ? 1.15 : 1);
      const kcol = colorOf(a.kingdomId);
      if (tg.kind !== 'retreat') drawOrderMarker(tg.rid, tg.kind, now);
      if (drawArrow(x0, y0, x1, y1, w, tg.kind, kcol, now, sel)) arrowsDrawn++;
    }
  }
  function prepareArmies(now) {                      // smoothed anchors of every army that has soldiers (arrows may start off-screen)
    if (!S.armies || S.armies.size === 0) { armyPos.clear(); return; }
    if (++armyGc > 300) { armyGc = 0; for (const id of armyPos.keys()) if (!S.armies.has(id)) armyPos.delete(id); }
    for (const a of S.armies.values()) { if (armyVisible(a)) armyAnchor(a, now); }
  }
  function drawBanners(now, political) {
    hitN = 0; bannersDrawn = 0;
    if (!S.armies || S.armies.size === 0) return;
    const cmd = api.cmd, cid = cmd && cmd.kid ? cmd.kid : 0, low = zoomCss < 5;
    const bs = Math.round(Math.max(0.72, Math.min(1.12, 0.62 + zoomCss * 0.04)) * 20);
    const list = drawList; list.length = 0;
    for (const a of S.armies.values()) {
      if (!armyVisible(a)) continue;
      if (low && a.kingdomId !== cid && !(political && api.showAllOrders)) continue;
      const st = armyPos.get(a.id); if (!st) continue;
      if (st.x < vx0 - 4 || st.x > vx1 + 4 || st.y < vy0 - 5 || st.y > vy1 + 4) continue;
      list.push(a);
    }
    if (!list.length) return;
    list.sort(byAnchorY);
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < list.length; i++) {
      const a = list[i], st = armyPos.get(a.id), k = S.kingdoms.get(a.kingdomId) || null;
      const sel = !!(cmd && cmd.armyId === a.id);
      const retreat = a.mode === 'retreat' || (a.order && a.order.type === 'retreat');
      const e = bannerSprite(k, a.members.length, armyIconKey(a), bs, retreat);
      const sz = 16 * texel;
      const gx = Math.round(ox + st.x * Z), gy = Math.round(oy + (st.y + 0.55) * Z);
      const lift = zoomCss >= 5 ? sz + 3 * dpr : 3 * dpr;
      const bx = Math.round(gx - e.w / 2);
      let by = Math.round(gy - lift - e.h), stacked = false;
      for (let tries = 0; tries < 4; tries++) {                     // fan overlapping banners upwards instead of stacking them on top of each other
        let moved = false;
        for (let j = 0; j < hitN; j++) {
          const o = j * 5, jx0 = hits[o + 1] * dpr, jy0 = hits[o + 2] * dpr, jx1 = hits[o + 3] * dpr, jy1 = hits[o + 4] * dpr - (e.h - e.ph);
          if (bx < jx1 - 2 && bx + e.w > jx0 + 2 && by < jy1 - 1 && by + e.ph > jy0 + 1) { by = Math.round(jy0 - e.ph - 2 * dpr); moved = true; stacked = true; break; }
        }
        if (!moved) break;
      }
      if (stacked) {                                                // thin stem from the banner down to its army
        ctx.fillStyle = '#080b16'; ctx.fillRect(Math.round(gx - 1.5 * dpr), by + e.ph, Math.round(3 * dpr), Math.max(0, gy - lift - (by + e.ph)));
        ctx.fillStyle = k ? k.color : '#a8b0b8'; ctx.fillRect(Math.round(gx - 0.5 * dpr), by + e.ph, Math.max(1, Math.round(dpr)), Math.max(0, gy - lift - (by + e.ph)));
      }
      if (sel) {                                                   // ring on the ground + glowing frame
        const pr = 1 + Math.sin(now / 200) * 0.08;
        ctx.lineWidth = Math.max(2, 2.2 * dpr);
        ctx.strokeStyle = 'rgba(8,10,20,0.75)'; ctx.beginPath(); ctx.ellipse(gx, gy - 0.05 * Z, Z * 0.62 * pr + 1.5, Z * 0.3 * pr + 1, 0, 0, TAU); ctx.stroke();
        ctx.strokeStyle = '#ffe36e'; ctx.lineWidth = Math.max(1.5, 1.8 * dpr); ctx.beginPath(); ctx.ellipse(gx, gy - 0.05 * Z, Z * 0.62 * pr, Z * 0.3 * pr, 0, 0, TAU); ctx.stroke();
        ctx.fillStyle = 'rgba(255,227,110,0.55)'; ctx.fillRect(bx - 3 * dpr, by - 3 * dpr, e.w + 6 * dpr, e.ph + 6 * dpr);
      }
      ctx.drawImage(e.cv, bx, by);
      if (a.supply < 30) {                                         // supply warning: pulsing red crate badge
        const pr = 0.5 + 0.5 * Math.sin(now / 180 + a.id);
        const sc = Math.max(1, Math.round(dpr * 0.8 * bs / 20)), ic = iconScaled('supply', sc), bsz = ic.width + 4 * dpr;
        const wx = bx + e.w - bsz * 0.55, wy = by - bsz * 0.7;
        ctx.fillStyle = 'rgba(214,40,32,' + (0.75 + 0.2 * pr).toFixed(2) + ')'; ctx.fillRect(Math.round(wx), Math.round(wy), Math.round(bsz), Math.round(bsz));
        ctx.fillStyle = '#080b16'; ctx.fillRect(Math.round(wx), Math.round(wy), Math.round(bsz), Math.max(1, Math.round(dpr)));
        ctx.drawImage(ic, Math.round(wx + 2 * dpr), Math.round(wy + 2 * dpr));
      }
      bannersDrawn++;
      if (hits.length < (hitN + 1) * 5) hits.length = (hitN + 1) * 5 + 20;
      hits[hitN * 5] = a.id; hits[hitN * 5 + 1] = bx / dpr; hits[hitN * 5 + 2] = by / dpr; hits[hitN * 5 + 3] = (bx + e.w) / dpr; hits[hitN * 5 + 4] = (by + e.h) / dpr;
      hitN++;
    }
  }
  const drawList = [];
  function byAnchorY(a, b) { const pa = armyPos.get(a.id), pb = armyPos.get(b.id); return pa.y - pb.y; }
  /** army id whose banner covers the css-px point (sx,sy), 0 if none (topmost first) */
  function armyAtScreen(sx, sy) {
    for (let i = hitN - 1; i >= 0; i--) {
      const o = i * 5;
      if (sx >= hits[o + 1] - 3 && sx <= hits[o + 3] + 3 && sy >= hits[o + 2] - 3 && sy <= hits[o + 4] + 6) return hits[o];
    }
    return 0;
  }
  function armyAt(tx, ty) { const s = tileToScreen(tx, ty); return armyAtScreen(s.x, s.y); }
  /** css-px rectangle of an army's banner in the last frame ({x0,y0,x1,y1}) or null when it was not drawn */
  function armyBannerRect(id) {
    for (let i = 0; i < hitN; i++) { const o = i * 5; if (hits[o] === id) return { x0: hits[o + 1], y0: hits[o + 2], x1: hits[o + 3], y1: hits[o + 4] }; }
    return null;
  }

  // ------------------------------------------------------------------ occupation marker next to city labels
  function drawOccupier(c, cx, top, big, e) {
    if (!c.occupierId) return;
    const ok = S.kingdoms.get(c.occupierId); if (!ok || !ok.flag) return;
    occFlagsDrawn++;
    const fw = Math.round(11 * dpr), fh = Math.round(7.5 * dpr);
    const fx = big && e ? Math.round(cx + e.w / 2 + 2 * dpr) : Math.round(cx + 7 * dpr);
    const fy = big && e ? Math.round(top - e.h / 2 - fh / 2 - 2 * dpr) : Math.round(top - fh - 3 * dpr);
    ctx.fillStyle = '#e9382e'; ctx.fillRect(fx - 2, fy - 2, fw + 4, fh + 4);
    ctx.fillStyle = 'rgba(8,10,20,0.95)'; ctx.fillRect(fx - 1, fy - 1, fw + 2, fh + 2);
    ctx.drawImage(Sprites.flag(ok.flag, fw, fh), fx, fy, fw, fh);
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
    ambientOn = api.ambient !== false;
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
      const reg = hasRegions(), political = reg && mode === MODE.BORDERS;
      if (mode !== MODE.NORMAL) {
        try { if (reg) { ensurePolitical(mode); drawPoliticalLayer(mode, political); } else { ensureOverlay(mode); drawOverlay(mode); } } catch (e) { report('overlay', e); }
      }
      try { drawTileLayer(curNow); } catch (e) { report('tiles', e); }
      try { drawEntities(); } catch (e) { report('entities', e); }
      try { drawAmbient(curNow); } catch (e) { report('ambient', e); }
      try { drawFlames(curNow); } catch (e) { report('fire', e); }
      try { drawEffects(curNow); } catch (e) { report('effects', e); }
      try { drawLabels(mode); } catch (e) { report('labels', e); }
      try {
        if (reg) drawCommandLayer(curNow, political);
        prepareArmies(curNow);
        if (reg) drawArmyOrders(curNow, political);
        drawBanners(curNow, political);
      } catch (e) { report('war', e); }
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
      dirty: S.dirtyList ? S.dirtyList.length : 0, glide: !!glide, labels: labelCache.size, items: itN,
      political: { builds: pol.builds, ver: pol.ver, ownerVer: pol.ownerVer, mode: pol.mode, buildMs: Math.round(pol.buildMs * 100) / 100, outlineRuns: pol.groups.reduce((n, g) => n + g.seg.length / 6, 0),
        thinRuns: pol.thin ? pol.thin.length / 4 : 0, wildRuns: pol.wild ? pol.wild.length / 4 : 0, frontRuns: pol.front ? pol.front.length / 4 : 0, stripeTiles: pol.stripeTiles, usedFrontApi: pol.usedApi,
        layerDraws: polLayer.draws, layerBlits: polLayer.blits, layerDirect: polLayer.direct, banners: bannersDrawn, arrows: arrowsDrawn, regionLabels: regLabelsDrawn, kingdomLabels: kingLabelsDrawn, goalMarkers: goalsDrawn, goalMarkersDone: goalsDoneDrawn, occupierFlags: occFlagsDrawn, regions: S.regions ? S.regions.size : 0, hasRegions: hasRegions() } };
  }

  Object.assign(api, {
    init, resize, draw, screenToTile, tileToScreen, focusOn, setMode, invalidate,
    setCamera, panBy, zoomAt, settleZoom, crispZoom, clampCam, minZoom, maxZoom() { return MAXZ; }, visibleRect, debugInfo,
    cancelGlide() { glide = null; },
    regionAt, regionCenter, armyAt, armyAtScreen, armyBannerRect,
  });
  Object.defineProperty(api, 'canvas', { get() { return canvas; } });
  Object.defineProperty(api, 'camSerial', { get() { return camSerial; } });
  Object.defineProperty(api, 'size', { get() { return { w: cssW, h: cssH, dpr }; } });
  return api;
})();
