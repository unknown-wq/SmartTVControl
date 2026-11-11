/* =====================================================================
 * 04_world.js — World: terrain generation, god brushes, growth, fire, lava, land labels, pathfinding
 * OWNER: World agent. API: docs/CONTRACT.md §3 World.
 *
 * Notes / conventions
 *  - All gameplay randomness goes through R (brush dithering, growth, fire). Terrain generation uses a private
 *    seeded PRNG + own noise so it never consumes R.
 *  - findNearestRes / randomLand predicates are called as pred(x, y).
 *  - S.landDirty is owned by World: it is set whenever walkability of any tile changes and cleared by the relabel.
 *  - Depleted BERRY bushes stay on the map (S.res = BERRY, S.amt = 0) and regrow; depleted ore is removed.
 *  - Extra helpers: nearestWalkable, inBounds, forestShare, landSize, brushCount (see return object).
 * ===================================================================== */

const World = (() => {
  const T = Const.T, RES = Const.RES;
  const NT = Const.TILE_COUNT;
  const defs = Tiles.defs;

  // ------------------------------------------------------------------ static tile tables
  const SPEED = new Float32Array(NT), FLAM = new Float32Array(NT);
  const WALK = new Uint8Array(NT), ISWATER = new Uint8Array(NT), BUILD = new Uint8Array(NT), ISLANDT = new Uint8Array(NT);
  for (let t = 0; t < NT; t++) {
    const d = defs[t];
    SPEED[t] = d.speed; FLAM[t] = d.flam;
    WALK[t] = d.speed > 0 ? 1 : 0; ISWATER[t] = d.water ? 1 : 0; BUILD[t] = d.build ? 1 : 0;
    ISLANDT[t] = (t !== T.DEEP && t !== T.SHALLOW && t !== T.LAVA) ? 1 : 0;
  }
  // which resource kinds may live on which tile type (index t*8+kind)
  const RES_OK = new Uint8Array(NT * 8);
  (function () {
    const allow = (t, ks) => { for (let i = 0; i < ks.length; i++) RES_OK[t * 8 + ks[i]] = 1; };
    allow(T.GRASS, [RES.TREE, RES.ROCK, RES.IRON, RES.GOLD, RES.BERRY]);
    allow(T.HILL, [RES.ROCK, RES.IRON, RES.GOLD]);
    allow(T.MOUNTAIN, [RES.ROCK, RES.IRON, RES.GOLD]);
  })();

  // ------------------------------------------------------------------ tunables
  const FIRE_SPREAD = 0.07;        // per burning tile, per tick, per 4-neighbour, times neighbour flammability
  const FOREST_MAX_SHARE = 0.30;   // forests stop spreading when they cover this share of all land
  const FOREST_DENSITY_CAP = 0.70; // local (7x7) density at which spreading stops
  const PATH_WEIGHT = 1.5;         // A* heuristic weight (1 = optimal, slower on twisty terrain)
  const LAVA_HILL_P = 10 / 3000;   // per lava check (every 10 ticks) => avg ~3000 ticks to solidify

  // ------------------------------------------------------------------ private caches (rebuilt in initCaches)
  let cKey = null;                 // the S.tile array the caches belong to
  let W = 0, Hh = 0, NN = 0;
  let fireList = null, fireN = 0, inFire = null;
  let lavaList = null, lavaN = 0;
  let lbl = null, lblSizes = [0], lblCount = 0, lastRelabel = -999;
  let stack = null;                // Int32Array scratch (flood fill)
  let scr = null, scrN = 0;        // Int32Array scratch (brush bookkeeping)
  let pg = null, pPar = null, pStamp = null, pGen = 0;
  let hK = null, hI = null, hGv = null, hN = 0, hCap = 0;
  let forestCount = 0, landCount = 0, forestG = 1;
  let fxBudget = 0;

  function initCaches() {
    W = S.w | 0; Hh = S.h | 0; NN = W * Hh;
    cKey = S.tile;
    if (!cKey) return;
    fireList = new Int32Array(NN); fireN = 0; inFire = new Uint8Array(NN);
    lavaList = new Int32Array(NN); lavaN = 0;
    lbl = new Int32Array(NN); lblSizes = [0]; lblCount = 0; lastRelabel = -999;
    stack = new Int32Array(NN + 8);
    scr = new Int32Array(NN + 8); scrN = 0;
    pg = new Float64Array(NN); pPar = new Int32Array(NN); pStamp = new Uint32Array(NN); pGen = 0;
    if (!hK) { hCap = 16384; hK = new Float64Array(hCap); hI = new Int32Array(hCap); hGv = new Float64Array(hCap); }
    hN = 0;
    for (let i = 0; i < NN; i++) if (S.fire[i]) { inFire[i] = 1; fireList[fireN++] = i; }
    scanState(S.tick, true);
    S.landDirty = true;
  }
  function ensure() { if (cKey !== S.tile || W !== S.w || Hh !== S.h) initCaches(); }

  // ------------------------------------------------------------------ tiny helpers
  function inb(x, y) { return x >= 0 && y >= 0 && x < W && y < Hh; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
  function dmgUnits(x, y, d, cause) { if (typeof Units !== 'undefined') Units.damageAt(x, y, d, cause); }
  function dmgBld(x, y, d, cause) { if (typeof Buildings !== 'undefined') Buildings.damageAt(x, y, d, cause); }
  function killBld(x, y, cause) { if (typeof Buildings !== 'undefined') Buildings.destroyAt(x, y, cause); }
  function markAround(x, y) {
    S.markDirty(x, y);
    S.markDirty(x - 1, y); S.markDirty(x + 1, y); S.markDirty(x, y - 1); S.markDirty(x, y + 1);
    S.markDirty(x - 1, y - 1); S.markDirty(x + 1, y - 1); S.markDirty(x - 1, y + 1); S.markDirty(x + 1, y + 1);
  }
  function nearWater(i, x, y) {
    const tile = S.tile;
    return (x > 0 && ISWATER[tile[i - 1]] === 1) || (x < W - 1 && ISWATER[tile[i + 1]] === 1) ||
           (y > 0 && ISWATER[tile[i - W]] === 1) || (y < Hh - 1 && ISWATER[tile[i + W]] === 1);
  }

  // ====================================================================================================
  //  TERRAIN GENERATION
  // ====================================================================================================
  function mulberry(seed) {
    let s = seed | 0;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeNoise(seed) {
    const s0 = (Math.imul(seed | 0, 0x9E3779B1) ^ 0x7F4A7C15) | 0;
    const GX = new Float32Array([1, -1, 0, 0, 0.70710678, -0.70710678, 0.70710678, -0.70710678]);
    const GY = new Float32Array([0, 0, 1, -1, 0.70710678, 0.70710678, -0.70710678, -0.70710678]);
    function hash(xi, yi, salt) {
      let h = (Math.imul(xi, 0x27D4EB2D) ^ Math.imul(yi, 0x165667B1) ^ Math.imul(salt + 1, 0x9E3779B1) ^ s0) | 0;
      h = Math.imul(h ^ (h >>> 15), 0x85EBCA6B);
      h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
      return (h ^ (h >>> 16)) & 7;
    }
    // gradient noise, roughly [-1, 1]
    function n2(x, y, salt) {
      const xi = Math.floor(x), yi = Math.floor(y);
      const fx = x - xi, fy = y - yi;
      const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
      const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
      let g = hash(xi, yi, salt);
      const a = GX[g] * fx + GY[g] * fy;
      g = hash(xi + 1, yi, salt);
      const b = GX[g] * (fx - 1) + GY[g] * fy;
      g = hash(xi, yi + 1, salt);
      const c = GX[g] * fx + GY[g] * (fy - 1);
      g = hash(xi + 1, yi + 1, salt);
      const d = GX[g] * (fx - 1) + GY[g] * (fy - 1);
      const ab = a + u * (b - a), cd = c + u * (d - c);
      return (ab + v * (cd - ab)) * 1.4;
    }
    function fbm(x, y, oct, salt) {
      let sum = 0, amp = 1, norm = 0, f = 1;
      for (let o = 0; o < oct; o++) {
        sum += amp * n2(x * f + o * 31.7, y * f - o * 17.3, salt + o * 7);
        norm += amp; amp *= 0.5; f *= 2.02;
      }
      return sum / norm;
    }
    return { n2, fbm };
  }

  /** two-pass chamfer distance (orthogonal 1, diagonal 1.414) from tiles where src[i] !== 0 */
  function chamfer(src, w, h, out) {
    const INF = 1e4, D = 1.41421356;
    const n = w * h;
    for (let i = 0; i < n; i++) out[i] = src[i] ? 0 : INF;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        let v = out[i];
        if (x > 0) { const a = out[i - 1] + 1; if (a < v) v = a; }
        if (y > 0) {
          let a = out[i - w] + 1; if (a < v) v = a;
          if (x > 0) { a = out[i - w - 1] + D; if (a < v) v = a; }
          if (x < w - 1) { a = out[i - w + 1] + D; if (a < v) v = a; }
        }
        out[i] = v;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let v = out[i];
        if (x < w - 1) { const a = out[i + 1] + 1; if (a < v) v = a; }
        if (y < h - 1) {
          let a = out[i + w] + 1; if (a < v) v = a;
          if (x < w - 1) { a = out[i + w + 1] + D; if (a < v) v = a; }
          if (x > 0) { a = out[i + w - 1] + D; if (a < v) v = a; }
        }
        out[i] = v;
      }
    }
  }

  /** 4-connected labelling of tiles with mask[i] === val. Returns {lbl, sizes, border} (index 0 unused). */
  function labelMask(mask, val, w, h, stk) {
    const n = w * h;
    const lab = new Int32Array(n);
    const sizes = [0], border = [0];
    let c = 0;
    for (let s = 0; s < n; s++) {
      if (mask[s] !== val || lab[s] !== 0) continue;
      c++;
      let sp = 0, size = 0, touches = 0;
      stk[sp++] = s; lab[s] = c;
      while (sp > 0) {
        const i = stk[--sp];
        size++;
        const y = (i / w) | 0, x = i - y * w;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = 1;
        if (x > 0 && mask[i - 1] === val && lab[i - 1] === 0) { lab[i - 1] = c; stk[sp++] = i - 1; }
        if (x < w - 1 && mask[i + 1] === val && lab[i + 1] === 0) { lab[i + 1] = c; stk[sp++] = i + 1; }
        if (y > 0 && mask[i - w] === val && lab[i - w] === 0) { lab[i - w] = c; stk[sp++] = i - w; }
        if (y < h - 1 && mask[i + w] === val && lab[i + w] === 0) { lab[i + w] = c; stk[sp++] = i + w; }
      }
      sizes[c] = size; border[c] = touches;
    }
    return { lab, sizes, border, count: c };
  }

  /** value at fraction q (0..1) of the sorted values given as a histogram */
  function histQuantile(hist, bins, lo, hi, total, q) {
    const target = q * total;
    let acc = 0;
    for (let b = 0; b < bins; b++) {
      acc += hist[b];
      if (acc >= target) return lo + (hi - lo) * (b + 1) / bins;
    }
    return hi;
  }

  function genTerrain(w, h, seed) {
    const n = w * h;
    const N = makeNoise(seed);
    const gr = mulberry((seed ^ 0x5BD1E995) | 0);
    const area = n / 9216;
    const msz = Math.min(w, h);
    const tile = S.tile, elev = S.elev, res = S.res, amt = S.amt;
    const tmpStack = new Int32Array(n + 8);

    // ---------------------------------------------------------------- 1. continent / island blobs
    const landFrac = 0.385 + gr() * 0.07;
    const landTiles = landFrac * n;
    const blobs = [];
    const roll = gr();
    let nC = roll < 0.08 ? 1 : roll < 0.5 ? 2 : 3;
    if (area > 1.5) nC++;
    const shares = [];
    let shareSum = 0;
    for (let k = 0; k < nC; k++) { const s = (k === 0 ? 0.85 : 0.5) + gr() * 0.5; shares.push(s); shareSum += s; }
    const conts = [];
    for (let k = 0; k < nC; k++) {
      const rad = Math.sqrt((shares[k] / shareSum) * 0.9 * landTiles / Math.PI) * 1.3;
      let bx = 0, by = 0, bestScore = -1;
      for (let tries = 0; tries < 60; tries++) {
        const cx = msz * 0.2 + gr() * (w - msz * 0.4), cy = msz * 0.2 + gr() * (h - msz * 0.4);
        let mind = 1e9;
        for (let j = 0; j < conts.length; j++) {
          const d = Math.hypot(cx - conts[j].x, cy - conts[j].y) / (rad + conts[j].r);
          if (d < mind) mind = d;
        }
        if (mind > bestScore) { bestScore = mind; bx = cx; by = cy; }
        if (mind > 0.9) break;
      }
      const aspect = 1 + gr() * 0.5, ang = gr() * Math.PI;
      conts.push({ x: bx, y: by, r: rad });
      blobs.push({ x: bx, y: by, rx: rad * Math.sqrt(aspect), ry: rad / Math.sqrt(aspect), c: Math.cos(ang), s: Math.sin(ang) });
    }
    const nI = 3 + Math.floor(gr() * 4 * Math.max(1, area * 0.8));
    for (let k = 0; k < nI; k++) {
      const rad = (2.6 + gr() * 4.6) * 1.35;
      let placed = false;
      for (let tries = 0; tries < 30 && !placed; tries++) {
        const cx = 8 + gr() * (w - 16), cy = 8 + gr() * (h - 16);
        let ok = true;
        for (let j = 0; j < conts.length; j++) if (Math.hypot(cx - conts[j].x, cy - conts[j].y) < conts[j].r * 0.95 + rad * 0.9) { ok = false; break; }
        if (!ok) continue;
        placed = true;
        blobs.push({ x: cx, y: cy, rx: rad, ry: rad * (0.8 + gr() * 0.4), c: 1, s: 0 });
      }
    }

    // ---------------------------------------------------------------- 2. height field
    const Hf = new Float32Array(n), Rg = new Float32Array(n);
    let hmin = 1e9, hmax = -1e9;
    const WA = 9;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        const wx = x + WA * N.fbm(x * 0.035, y * 0.035, 3, 101);
        const wy = y + WA * N.fbm(x * 0.035 + 50, y * 0.035 + 50, 3, 202);
        const base = N.fbm(wx * 0.04, wy * 0.04, 5, 1);                // ~[-1,1]
        let inv = 1;
        for (let k = 0; k < blobs.length; k++) {
          const b = blobs[k];
          const dx = wx - b.x, dy = wy - b.y;
          const u = (dx * b.c + dy * b.s) / b.rx, v = (-dx * b.s + dy * b.c) / b.ry;
          const d2 = u * u + v * v;
          if (d2 < 1) { const m = 1 - d2; inv *= 1 - m * m * (3 - 2 * m); }
        }
        const mask = 1 - inv;
        const bd = Math.min(x, y, w - 1 - x, h - 1 - y);
        const pull = 1 - smooth(1.5, 0.2 * msz, bd);          // wide soft pull towards the sea at the map border
        const v = mask + base * 0.7 - 1.0 * pull;
        Hf[i] = v;
        if (v < hmin) hmin = v;
        if (v > hmax) hmax = v;
        const rr = 1 - Math.abs(N.fbm(wx * 0.05, wy * 0.05, 3, 33)) * 2.4;
        Rg[i] = rr > 0 ? rr * rr : 0;
      }
    }

    // ---------------------------------------------------------------- 3. sea level by percentile
    const BINS = 2048;
    const hist = new Int32Array(BINS);
    const span = hmax - hmin + 1e-6;
    for (let i = 0; i < n; i++) hist[Math.min(BINS - 1, ((Hf[i] - hmin) / span * BINS) | 0)]++;
    const sea = histQuantile(hist, BINS, hmin, hmax, n, 1 - landFrac);
    const land = new Uint8Array(n);
    for (let i = 0; i < n; i++) land[i] = Hf[i] > sea ? 1 : 0;
    // hard border
    for (let x = 0; x < w; x++) for (let k = 0; k < 2; k++) { land[k * w + x] = 0; land[(h - 1 - k) * w + x] = 0; }
    for (let y = 0; y < h; y++) for (let k = 0; k < 2; k++) { land[y * w + k] = 0; land[y * w + w - 1 - k] = 0; }

    // ---------------------------------------------------------------- 4. clean coast: majority smoothing, specks, pockets
    const tmp = new Uint8Array(n);
    for (let pass = 0; pass < 2; pass++) {
      tmp.set(land);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const c4 = land[i - 1] + land[i + 1] + land[i - w] + land[i + w];
          if (land[i] && c4 <= 1) tmp[i] = 0;
          else if (!land[i] && c4 >= 3) tmp[i] = 1;
        }
      }
      land.set(tmp);
    }
    {
      const L = labelMask(land, 1, w, h, tmpStack);
      for (let i = 0; i < n; i++) if (land[i] && L.sizes[L.lab[i]] < 8) land[i] = 0;
      const Wt = labelMask(land, 0, w, h, tmpStack);
      for (let i = 0; i < n; i++) if (!land[i] && !Wt.border[Wt.lab[i]] && Wt.sizes[Wt.lab[i]] < 4) land[i] = 1;
    }

    // ---------------------------------------------------------------- 5. distance fields
    const dLand = new Float32Array(n), dWater = new Float32Array(n);
    const waterSrc = new Uint8Array(n);
    for (let i = 0; i < n; i++) waterSrc[i] = land[i] ? 0 : 1;
    chamfer(land, w, h, dLand);          // distance from land (0 on land)
    chamfer(waterSrc, w, h, dWater);     // distance from water (0 on water)

    // ---------------------------------------------------------------- 6. water elevation (continuous: shallow ring ~2-3 tiles)
    function waterElev(dd, jitter) {
      dd += jitter;
      if (dd < 1) dd = 1;
      if (dd <= 2.75) return 99 - (dd - 1) * 16;              // 99 .. 71
      const e = 70.5 - (dd - 2.75) * 5.5;                      // deep, gets deeper offshore
      return e < 6 ? 6 : e;
    }
    // ---------------------------------------------------------------- 7. land elevation by quantiles of a "relief" value
    let landN = 0, hLandMax = -1e9;
    for (let i = 0; i < n; i++) if (land[i]) { landN++; if (Hf[i] > hLandMax) hLandMax = Hf[i]; }
    const Lv = new Float32Array(n);
    const LB = 1024;
    const lh = new Int32Array(LB);
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue;
      const hn = clamp((Hf[i] - sea) / (hLandMax - sea + 1e-6), 0, 1);
      const v = hn * 0.58 + 0.5 * Rg[i] * smooth(0.12, 0.5, hn);
      Lv[i] = v;
      lh[Math.min(LB - 1, (v / 1.1 * LB) | 0)]++;
    }
    const sandF = 0.035;
    const snowF = 0.012 + gr() * 0.02;
    const mountF = 0.05 + gr() * 0.045;
    const hillF = 0.11 + gr() * 0.06;
    const r1 = sandF, r4 = 1 - snowF, r3 = r4 - mountF, r2 = r3 - hillF;
    const cdf = new Float32Array(LB);
    {
      let acc = 0;
      for (let b = 0; b < LB; b++) { cdf[b] = (acc + lh[b] * 0.5) / Math.max(1, landN); acc += lh[b]; }
    }
    function bandElev(r) {
      if (r < r1) return 100 + 11.9 * (r / r1);
      if (r < r2) return 112 + 47.8 * ((r - r1) / (r2 - r1));
      if (r < r3) return 160 + 31.8 * ((r - r2) / (r3 - r2));
      if (r < r4) return 192 + 35.8 * ((r - r3) / (r4 - r3));
      return 228 + 26 * ((r - r4) / (1 - r4));
    }
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        if (land[i]) {
          const r = cdf[Math.min(LB - 1, (Lv[i] / 1.1 * LB) | 0)];
          let e = bandElev(r);
          const dw = dWater[i];
          const nb = N.n2(x * 0.31, y * 0.31, 77);
          if (dw <= 1.5) {                                   // coastal ring: beach unless rocky
            if (e < 150 && nb > -0.3) e = 100 + (nb + 1) * 5.4;
            else if (e < 112) e = 112 + (e - 100);
          } else if (dw <= 2.1 && e < 128 && N.n2(x * 0.17, y * 0.17, 79) > 0.45) {
            e = 101 + (nb + 1) * 4.5;                         // occasionally wider beach
          } else if (e < 112) {
            e = 112 + (e - 100) * 0.9 + 1;                    // no inland sand
          }
          // small texture noise within the band
          const t0 = Tiles.fromElev(e | 0);
          const ne = e + N.n2(x * 0.5, y * 0.5, 55) * 2.5;
          const d0 = defs[t0];
          e = clamp(ne, d0.lo + 0.5, d0.hi - 0.5);
          elev[i] = clamp(e, 0, 255) | 0;
        } else {
          elev[i] = clamp(waterElev(dLand[i], N.n2(x * 0.22, y * 0.22, 91) * 0.75), 4, 99) | 0;
        }
        tile[i] = Tiles.fromElev(elev[i]);
      }
    }

    // ---------------------------------------------------------------- 8. lakes
    const nLakes = Math.floor(gr() * (3.2 + area));
    for (let k = 0; k < nLakes; k++) {
      let lx = -1, ly = -1;
      for (let tries = 0; tries < 60; tries++) {
        const x = 6 + Math.floor(gr() * (w - 12)), y = 6 + Math.floor(gr() * (h - 12));
        const i = y * w + x;
        if (tile[i] === T.GRASS && dWater[i] >= 7) { lx = x; ly = y; break; }
      }
      if (lx < 0) continue;
      const rad = 1.7 + gr() * 1.8;
      const R2 = Math.ceil(rad + 2);
      for (let y = ly - R2; y <= ly + R2; y++) {
        for (let x = lx - R2; x <= lx + R2; x++) {
          if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
          const i = y * w + x;
          const tt = tile[i];
          if (!ISLANDT[tt] || tt === T.MOUNTAIN || tt === T.SNOW) continue;
          const d = Math.hypot(x - lx, y - ly) + N.n2(x * 0.4, y * 0.4, 123) * 0.9;
          if (d <= rad) {
            const deep = rad >= 2.8 && d < rad - 1.2;
            elev[i] = deep ? 60 - (rad - d) * 2 : 84 + (d / rad) * 12;
            tile[i] = deep ? T.DEEP : T.SHALLOW;
          }
        }
      }
    }
    // beaches around lakes
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (tile[i] !== T.GRASS || land[i] === 0) continue;
        if (ISWATER[tile[i - 1]] || ISWATER[tile[i + 1]] || ISWATER[tile[i - w]] || ISWATER[tile[i + w]]) {
          if (dWater[i] > 1.01 && N.n2(x * 0.4, y * 0.4, 130) > -0.2) { elev[i] = 101 + ((N.n2(x * 0.7, y * 0.7, 131) + 1) * 5) | 0; tile[i] = T.SAND; }
        }
      }
    }
    // refresh water distance after lakes
    for (let i = 0; i < n; i++) waterSrc[i] = ISWATER[tile[i]] ? 1 : 0;
    chamfer(waterSrc, w, h, dWater);

    // ---------------------------------------------------------------- 9. forests (moisture noise, clumped)
    let grassN = 0, landCnt = 0;
    const Mo = new Float32Array(n);
    const MB = 512;
    const mh = new Int32Array(MB);
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        const t = tile[i];
        if (ISLANDT[t]) landCnt++;
        if (t !== T.GRASS) continue;
        grassN++;
        let m = 0.5 + 0.5 * (0.7 * N.fbm(x * 0.052 + 11, y * 0.052 + 7, 4, 301) + 0.3 * N.fbm(x * 0.13, y * 0.13, 2, 311));
        m += 0.07 * (1 - clamp(dWater[i] / 9, 0, 1));          // a bit more forest near water
        m = clamp(m, 0, 1.2);
        Mo[i] = m;
        mh[Math.min(MB - 1, (m / 1.2 * MB) | 0)]++;
      }
    }
    const forestFrac = 0.145 + gr() * 0.05;
    let fTarget = Math.round(landCnt * forestFrac);
    if (fTarget > grassN * 0.5) fTarget = Math.floor(grassN * 0.5);
    const thr = grassN > 0 ? histQuantile(mh, MB, 0, 1.2, grassN, 1 - fTarget / Math.max(1, grassN)) : 2;
    for (let i = 0; i < n; i++) if (tile[i] === T.GRASS && Mo[i] > thr) tile[i] = T.FOREST;
    // smoothing: lone forest tiles vanish, 3-sided grass holes fill
    tmp.fill(0);
    for (let i = 0; i < n; i++) tmp[i] = tile[i] === T.FOREST ? 1 : 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const c4 = tmp[i - 1] + tmp[i + 1] + tmp[i - w] + tmp[i + w];
        if (tile[i] === T.FOREST && c4 === 0) tile[i] = T.GRASS;
        else if (tile[i] === T.GRASS && c4 >= 3) tile[i] = T.FOREST;
      }
    }
    for (let i = 0; i < n; i++) if (tile[i] === T.FOREST) { amt[i] = 80 + Math.floor(gr() * 121); }

    // ---------------------------------------------------------------- 10. resources
    // forest proximity (within 2 tiles) and mountain proximity (within 2 tiles), cheap box scan
    const nearForest = new Uint8Array(n), nearMtn = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = tile[y * w + x];
        if (t !== T.FOREST && t !== T.MOUNTAIN && t !== T.SNOW) continue;
        const y0 = Math.max(0, y - 2), y1 = Math.min(h - 1, y + 2), x0 = Math.max(0, x - 2), x1 = Math.min(w - 1, x + 2);
        for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
          if (t === T.FOREST) nearForest[yy * w + xx] = 1; else nearMtn[yy * w + xx] = 1;
        }
      }
    }
    const hillTiles = [], mtnTiles = [];
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        const t = tile[i];
        if (res[i]) continue;
        if (t === T.GRASS) {
          const nf = nearForest[i], wd = dWater[i] <= 3.1;
          let p = 0.010 + (nf ? 0.050 : 0);                         // lone trees: more at forest edges
          const q = gr();
          if (q < p) { res[i] = RES.TREE; amt[i] = 10 + Math.floor(gr() * 51); continue; }
          const pb = 0.008 + (nf ? 0.022 : 0) + (wd ? 0.016 : 0);   // berries near forest / water
          if (q < p + pb) { res[i] = RES.BERRY; amt[i] = 30 + Math.floor(gr() * 91); continue; }
          if (nearMtn[i] && q < p + pb + 0.012) { res[i] = RES.ROCK; amt[i] = 40 + Math.floor(gr() * 61); continue; }
          if (q < p + pb + 0.012 + 0.002) { res[i] = RES.ROCK; amt[i] = 30 + Math.floor(gr() * 51); }
        } else if (t === T.HILL || t === T.MOUNTAIN) {
          (t === T.HILL ? hillTiles : mtnTiles).push(i);
          const vein = N.fbm(x * 0.33 + 5, y * 0.33 + 9, 2, 401);          // ore veins: small clusters
          const vein2 = N.fbm(x * 0.29 + 40, y * 0.29 + 3, 2, 431);
          const q = gr();
          if (vein > 0.30 && q < 0.7) { res[i] = RES.ROCK; amt[i] = 60 + Math.floor(gr() * 141); }
          else if (vein2 > 0.36 && (nearMtn[i] || t === T.MOUNTAIN) && q < 0.75) { res[i] = RES.IRON; amt[i] = 50 + Math.floor(gr() * 111); }
          else if (t === T.MOUNTAIN && q > 0.985) { res[i] = RES.GOLD; amt[i] = 25 + Math.floor(gr() * 56); }
          else if (q < 0.025) { res[i] = RES.ROCK; amt[i] = 50 + Math.floor(gr() * 100); }
        }
      }
    }
    // guarantee a few rare ores whenever the terrain can hold them
    function sprinkle(list, kind, want, lo, span) {
      let have = 0;
      for (let k = 0; k < list.length; k++) if (res[list[k]] === kind) have++;
      let guard = 0;
      while (have < want && list.length && guard++ < 400) {
        const i = list[Math.floor(gr() * list.length)];
        if (res[i] === RES.GOLD || res[i] === RES.IRON) continue;
        res[i] = kind; amt[i] = lo + Math.floor(gr() * span); have++;
      }
    }
    const ores = mtnTiles.length ? mtnTiles : hillTiles;
    if (ores.length >= 6) sprinkle(ores, RES.GOLD, Math.max(2, Math.min(6, Math.round(ores.length * 0.012))), 25, 56);
    if (hillTiles.length + mtnTiles.length >= 10) sprinkle(hillTiles.length ? hillTiles : mtnTiles, RES.IRON, 4, 50, 111);
  }

  function generate(opts) {
    opts = opts || {};
    const w = (opts.w | 0) || Const.DEFAULT_W, h = (opts.h | 0) || Const.DEFAULT_H;
    const seed = (opts.seed === undefined || opts.seed === null) ? (S.seed || 1) : opts.seed;
    S.reset(w, h, seed);
    genTerrain(S.w, S.h, S.seed);
    S.allDirty = true; S.landDirty = true;
    initCaches();
    return S;
  }

  // ====================================================================================================
  //  TILE ACCESS & MUTATION
  // ====================================================================================================
  function tileAt(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.tile || x < 0 || y < 0 || x >= S.w || y >= S.h) return T.DEEP;
    return S.tile[y * S.w + x];
  }
  function walkable(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.tile || x < 0 || y < 0 || x >= S.w || y >= S.h) return false;
    return WALK[S.tile[y * S.w + x]] === 1;
  }
  function inBounds(x, y) { x = Math.floor(x); y = Math.floor(y); return x >= 0 && y >= 0 && x < S.w && y < S.h; }

  /** flammability of the thing standing on tile i (0 = cannot burn) */
  function bldFlam(id) {
    if (typeof Buildings === 'undefined') return 0.8;
    const b = Buildings.get(id);
    if (!b) return 0.8;
    if (typeof b.flam === 'number') return b.flam;
    const d = Buildings.defs && Buildings.defs[b.type];
    return d && typeof d.flam === 'number' ? d.flam : 0.8;
  }
  function flamIdx(i) {
    let f = FLAM[S.tile[i]];
    const rk = S.res[i];
    if (rk === RES.TREE) { if (f < 0.7) f = 0.7; }
    else if (rk === RES.BERRY) { if (f < 0.35) f = 0.35; }
    const b = S.bld[i];
    if (b) { const bf = bldFlam(b); if (bf > f) f = bf; }
    return f;
  }

  /** core tile mutation used by setTile / brush / growth / fire. i = y*w+x. elev undefined => keep if in band else mid. */
  function put(i, x, y, t, elev, keepRes) {
    const tile = S.tile;
    const old = tile[i];
    const oldE = S.elev[i];
    let e;
    if (elev !== undefined && elev !== null) e = elev < 0 ? 0 : elev > 255 ? 255 : elev | 0;
    else { const d = defs[t]; e = (oldE >= d.lo && oldE < d.hi) ? oldE : d.mid; }
    if (old === t && e === oldE) return false;
    tile[i] = t; S.elev[i] = e;
    if (!keepRes) {
      if (t === T.FOREST) {
        if (old !== T.FOREST) { S.res[i] = 0; S.amt[i] = 80 + R.i(121); }
      } else {
        const rk = S.res[i];
        if (rk && RES_OK[t * 8 + rk] === 0) { S.res[i] = 0; S.amt[i] = 0; }
        else if (!rk) S.amt[i] = 0;
      }
    }
    if (WALK[old] !== WALK[t] || ISWATER[old] !== ISWATER[t]) S.landDirty = true;
    if (S.fire[i] && flamIdx(i) <= 0) S.fire[i] = 0;
    if (S.bld[i] && BUILD[t] === 0) killBld(x, y, 'terrain');
    if (t === T.LAVA) dmgUnits(x, y, 40, 'lava');
    markAround(x, y);
    if (old !== t) Bus.emit('tileChanged', x, y, old, t);
    return true;
  }

  function setTile(x, y, t, opts) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.tile || x < 0 || y < 0 || x >= S.w || y >= S.h) return false;
    if (!(t >= 0 && t < NT)) return false;
    ensure();
    return put(y * W + x, x, y, t, opts ? opts.elev : undefined, !!(opts && opts.keepRes));
  }

  // ---------------------------------------------------------------- brushes
  const TOOL = { raise: 1, lower: 2, grass: 3, sand: 4, forest: 5, hill: 6, mountain: 7, snow: 8, lava: 9 };

  /** returns the number of tiles changed */
  function brush(toolId, cx, cy, r) {
    if (!S.tile) return 0;
    const tool = TOOL[toolId];
    if (!tool) return 0;
    ensure();
    cx = Math.floor(cx); cy = Math.floor(cy);
    if (cx !== cx || cy !== cy) return 0;
    r = Math.round(r);
    if (!(r >= 1)) r = 1;
    if (r > 16) r = 16;
    const rr = r + 0.5, rr2 = rr * rr, core = rr * 0.7, inv = 1 / (rr - core);
    const x0 = Math.max(0, cx - r), x1 = Math.min(W - 1, cx + r), y0 = Math.max(0, cy - r), y1 = Math.min(Hh - 1, cy + r);
    const tile = S.tile;
    let changed = 0;
    scrN = 0;
    const lift = tool === 1;
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 > rr2) continue;
        const d = Math.sqrt(d2);
        const fall = d <= core ? 1 : (rr - d) * inv;
        const i = y * W + x;
        const t0 = tile[i];
        if (tool <= 2) {
          // ---- raise / lower: elevation change, retype by band
          const s = fall * fall * (3 - 2 * fall);
          let delta = ((8 + R.f() * 20) * s + 0.5) | 0;
          if (delta < 1) { if (s < 0.12) continue; delta = 1; }
          if (t0 === T.LAVA) { if (put(i, x, y, lift ? T.MOUNTAIN : T.HILL, lift ? 210 : 176)) changed++; continue; }
          const e = S.elev[i];
          let ne = lift ? e + delta : e - delta;
          if (ne < 0) ne = 0; else if (ne > 255) ne = 255;
          if (ne === e) continue;
          let nt = Tiles.fromElev(ne);
          if (t0 === T.FOREST && ne >= 112 && ne < 160) nt = T.FOREST;
          if (put(i, x, y, nt, ne)) changed++;
          continue;
        }
        // ---- painting tools
        if (fall < 1 && R.f() > fall) continue;      // dithered soft rim
        let nt;
        switch (tool) {
          case 3: nt = T.GRASS; break;
          case 4: nt = T.SAND; break;
          case 5: nt = T.FOREST; break;
          case 6: nt = T.HILL; break;
          case 7: nt = T.MOUNTAIN; break;
          case 8: nt = T.SNOW; break;
          default: nt = T.LAVA; break;
        }
        if (tool === 5) {
          if (S.bld[i]) continue;
          if (t0 === T.FOREST) {
            if (S.amt[i] < 100) { S.amt[i] = 100 + R.i(100); S.markDirty(x, y); changed++; }
            continue;
          }
        } else if (tool === 7 && r >= 3 && d > rr * 0.55) {
          if (t0 === T.HILL || t0 === T.MOUNTAIN || t0 === T.SNOW || t0 === T.LAVA) continue;
          nt = T.HILL;                                // soft foothills around a painted mountain
        }
        if (t0 === nt) continue;
        if (ISWATER[t0] === 1 && ISWATER[nt] === 0 && nt !== T.LAVA) scr[scrN++] = i;
        if (put(i, x, y, nt)) changed++;
      }
    }
    // land painted over deep water gets a shallow shelf so it does not stand on a cliff
    for (let k = 0; k < scrN; k++) {
      const i = scr[k];
      const y = (i / W) | 0, x = i - y * W;
      for (let ddy = -1; ddy <= 1; ddy++) {
        const yy = y + ddy;
        if (yy < 0 || yy >= Hh) continue;
        for (let ddx = -1; ddx <= 1; ddx++) {
          const xx = x + ddx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (tile[j] === T.DEEP && put(j, xx, yy, T.SHALLOW, 84)) changed++;
        }
      }
    }
    return changed;
  }

  // ====================================================================================================
  //  QUERIES
  // ====================================================================================================
  function costTabFor(race) {
    race = race | 0;
    if (race < 0 || race >= Const.RACE_COUNT) race = Const.RACE_COUNT;
    let tb = costTabs[race];
    if (!tb) {
      tb = new Float32Array(NT);
      const rc = Races.get(race);
      const terr = rc && rc.terrain;
      for (let t = 0; t < NT; t++) {
        let m = 1;
        if (terr && terr[t] !== undefined) m = terr[t];
        tb[t] = SPEED[t] * m;
      }
      costTabs[race] = tb;
    }
    return tb;
  }
  const costTabs = [];

  function moveCost(x, y, race) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.tile || x < 0 || y < 0 || x >= S.w || y >= S.h) return 0;
    return costTabFor(race)[S.tile[y * S.w + x]];
  }

  function isBuildable(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.tile || x < 0 || y < 0 || x >= S.w || y >= S.h) return false;
    const i = y * S.w + x;
    return BUILD[S.tile[i]] === 1 && S.bld[i] === 0 && S.fire[i] === 0 && S.res[i] === 0;
  }

  function resAt(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.tile || x < 0 || y < 0 || x >= S.w || y >= S.h) return { kind: RES.NONE, amt: 0 };
    const i = y * S.w + x;
    if (S.tile[i] === T.FOREST) return { kind: RES.TREE, amt: S.amt[i] };
    const k = S.res[i];
    return k ? { kind: k, amt: S.amt[i] } : { kind: RES.NONE, amt: 0 };
  }

  function fishSpot(i, x, y) {
    const t = S.tile[i];
    if (WALK[t] === 0 || ISWATER[t] === 1) return false;
    const tile = S.tile;
    return (x > 0 && tile[i - 1] === T.SHALLOW) || (x < W - 1 && tile[i + 1] === T.SHALLOW) ||
           (y > 0 && tile[i - W] === T.SHALLOW) || (y < Hh - 1 && tile[i + W] === T.SHALLOW);
  }

  // ring search state (module-level so a search allocates nothing)
  let qBest = -1, qD = 0, qCx = 0, qCy = 0, qMode = 0, qA = 0, qPred = null;
  function qMatch(i, x, y) {
    if (qMode === 0) return S.tile[i] === qA;
    switch (qA) {
      case RES.TREE: return S.tile[i] === T.FOREST || (S.res[i] === RES.TREE && S.amt[i] > 0);
      case RES.ROCK: case RES.IRON: case RES.GOLD: return S.res[i] === qA && S.amt[i] > 0;
      case RES.BERRY: return S.res[i] === RES.BERRY && S.amt[i] >= 5;
      case RES.FISH: return fishSpot(i, x, y);
    }
    return false;
  }
  function qCell(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= Hh) return;
    const dx = x - qCx, dy = y - qCy, d = dx * dx + dy * dy;
    if (d >= qD) return;
    const i = y * W + x;
    if (!qMatch(i, x, y)) return;
    if (qPred !== null && !qPred(x, y)) return;
    qD = d; qBest = i;
  }
  function ringSearch(cx, cy, maxR, mode, a, pred) {
    ensure();
    cx = Math.floor(cx); cy = Math.floor(cy);
    if (!S.tile || cx !== cx || cy !== cy) return null;
    if (!(maxR > 0)) maxR = 24;
    if (maxR > W + Hh) maxR = W + Hh;
    qBest = -1; qD = 1e12; qCx = cx; qCy = cy; qMode = mode; qA = a; qPred = typeof pred === 'function' ? pred : null;
    for (let r = 0; r <= maxR; r++) {
      if (qBest >= 0 && r * r > qD) break;
      if (r === 0) { qCell(cx, cy); continue; }
      const x0 = cx - r, x1 = cx + r, y0 = cy - r, y1 = cy + r;
      if (y0 >= 0 || y1 < Hh) {
        const xa = Math.max(0, x0), xb = Math.min(W - 1, x1);
        if (y0 >= 0) for (let x = xa; x <= xb; x++) qCell(x, y0);
        if (y1 < Hh) for (let x = xa; x <= xb; x++) qCell(x, y1);
      }
      const ya = Math.max(0, y0 + 1), yb = Math.min(Hh - 1, y1 - 1);
      if (x0 >= 0) for (let y = ya; y <= yb; y++) qCell(x0, y);
      if (x1 < W) for (let y = ya; y <= yb; y++) qCell(x1, y);
    }
    qPred = null;
    if (qBest < 0) return null;
    const by = (qBest / W) | 0;
    return [qBest - by * W, by];
  }
  function findNearestRes(x, y, kind, maxR, pred) { return ringSearch(x, y, maxR, 1, kind, pred); }
  function nearestTile(x, y, tileId, maxR) { return ringSearch(x, y, maxR || 32, 0, tileId, null); }

  /** nearest walkable tile (any kind of walkable, incl. shallows) -> [x,y] | null */
  function nearestWalkable(x, y, maxR) {
    ensure();
    x = Math.floor(x); y = Math.floor(y);
    if (!S.tile) return null;
    if (inb(x, y) && WALK[S.tile[y * W + x]]) return [x, y];
    let best = -1, bd = 1e12;
    maxR = maxR > 0 ? maxR : 12;
    for (let r = 1; r <= maxR; r++) {
      if (best >= 0 && r * r > bd) break;
      for (let yy = y - r; yy <= y + r; yy++) {
        if (yy < 0 || yy >= Hh) continue;
        const edge = (yy === y - r || yy === y + r);
        for (let xx = x - r; xx <= x + r; xx += (edge ? 1 : 2 * r)) {
          if (xx < 0 || xx >= W) continue;
          const i = yy * W + xx;
          if (!WALK[S.tile[i]]) continue;
          const d = (xx - x) * (xx - x) + (yy - y) * (yy - y);
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    if (best < 0) return null;
    const by = (best / W) | 0;
    return [best - by * W, by];
  }

  function randomLand(pred, tries) {
    ensure();
    if (!S.tile) return null;
    const explicit = tries > 0;
    const n = explicit ? tries : 80;
    for (let k = 0; k < n; k++) {
      const x = R.i(W), y = R.i(Hh);
      const t = S.tile[y * W + x];
      if (WALK[t] === 1 && ISWATER[t] === 0 && (!pred || pred(x, y))) return [x, y];
    }
    if (explicit) return null;
    const start = R.i(NN);
    for (let k = 0; k < NN; k++) {
      let i = start + k; if (i >= NN) i -= NN;
      const t = S.tile[i];
      if (WALK[t] === 1 && ISWATER[t] === 0) {
        const y = (i / W) | 0, x = i - y * W;
        if (!pred || pred(x, y)) return [x, y];
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- harvesting
  /** returns the amount actually taken (integer >= 0). Fractional requests are rounded stochastically. */
  function harvest(x, y, kind, amount) {
    x = Math.floor(x); y = Math.floor(y);
    amount = +amount;
    if (!S.tile || !(amount > 0) || x < 0 || y < 0 || x >= S.w || y >= S.h) return 0;
    ensure();
    const i = y * W + x;
    if (kind === RES.FISH) {
      const ok = fishSpot(i, x, y) || S.tile[i] === T.SHALLOW;
      return ok ? Math.floor(amount) + (R.f() < amount - Math.floor(amount) ? 1 : 0) : 0;
    }
    let need = Math.floor(amount);
    const fr = amount - need;
    if (fr > 0 && R.f() < fr) need++;
    if (need <= 0) return 0;
    if (S.tile[i] === T.FOREST) {
      if (kind && kind !== RES.TREE) return 0;
      const a = S.amt[i];
      const take = need < a ? need : a;
      if (a - take <= 0) put(i, x, y, T.GRASS, S.elev[i]);
      else { S.amt[i] = a - take; if ((a >> 5) !== ((a - take) >> 5)) S.markDirty(x, y); }
      return take;
    }
    const rk = S.res[i];
    if (!rk || (kind && kind !== rk)) return 0;
    const a = S.amt[i];
    const take = need < a ? need : a;
    if (take <= 0) return 0;
    const left = a - take;
    S.amt[i] = left;
    if (left <= 0) {
      if (rk !== RES.BERRY) S.res[i] = 0;          // ore / lone tree vanish; berry bushes stay and regrow
      S.markDirty(x, y);
    }
    return take;
  }

  // ====================================================================================================
  //  FIRE
  // ====================================================================================================
  function startFire(i, fl) {
    const t = S.tile[i];
    let dur;
    if (S.bld[i]) dur = 70 + R.i(30);
    else if (t === T.FOREST) dur = 38 + R.i(26);
    else if (S.res[i] === RES.TREE) dur = 22 + R.i(8);
    else if (t === T.GRASS) dur = 16 + R.i(10);
    else dur = 8 + R.i(6);
    S.fire[i] = dur;
    if (!inFire[i]) { inFire[i] = 1; fireList[fireN++] = i; }
  }

  function ignite(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.tile || x < 0 || y < 0 || x >= S.w || y >= S.h) return false;
    ensure();
    const i = y * W + x;
    if (S.fire[i]) return false;
    const fl = flamIdx(i);
    if (fl <= 0) return false;
    startFire(i, fl);
    return true;
  }
  function extinguish(x, y, r) {
    if (!S.tile) return 0;
    ensure();
    x = Math.floor(x); y = Math.floor(y);
    r = r > 0 ? r : 0;
    const R2 = r * r + 0.25, ri = Math.ceil(r);
    let n = 0;
    for (let yy = Math.max(0, y - ri); yy <= Math.min(Hh - 1, y + ri); yy++) {
      for (let xx = Math.max(0, x - ri); xx <= Math.min(W - 1, x + ri); xx++) {
        const dx = xx - x, dy = yy - y;
        if (dx * dx + dy * dy > R2) continue;
        const i = yy * W + xx;
        if (S.fire[i]) { S.fire[i] = 0; n++; }
      }
    }
    return n;
  }
  function isBurning(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.tile || x < 0 || y < 0 || x >= S.w || y >= S.h) return false;
    return S.fire[y * S.w + x] > 0;
  }

  function rainAt(rains, x, y, tick) {
    for (let k = 0; k < rains.length; k++) {
      const rn = rains[k];
      if (rn.until !== undefined && rn.until <= tick) continue;
      const dx = x + 0.5 - rn.x, dy = y + 0.5 - rn.y;
      if (dx * dx + dy * dy <= rn.r * rn.r) return true;
    }
    return false;
  }

  function burnOut(i, x, y) {
    const t = S.tile[i];
    if (t === T.FOREST) {
      put(i, x, y, T.GRASS, S.elev[i]);
      if (fxBudget > 0) { fxBudget--; Fx.add('ash', x + 0.5, y + 0.5, { ttl: 1.4 }); }
    } else {
      const rk = S.res[i];
      if (rk === RES.TREE || rk === RES.BERRY) { S.res[i] = 0; S.amt[i] = 0; S.markDirty(x, y); }
      if (fxBudget > 0 && R.f() < 0.5) { fxBudget--; Fx.add('smoke', x + 0.5, y + 0.5, { ttl: 1.0 }); }
    }
  }

  function tryCatch(j, jx, jy, tick) {
    const fire = S.fire;
    if (fire[j]) return;
    const fl = flamIdx(j);
    if (fl <= 0) return;
    const p = FIRE_SPREAD * fl;
    const rv = R.f();
    if (rv >= p) return;
    if (rv >= p * 0.45 && nearWater(j, jx, jy)) return;       // water next to the tile slows the fire
    startFire(j, fl);
  }

  function stepFire(tick) {
    const n0 = fireN;
    if (n0 === 0) return;
    const fire = S.fire, bld = S.bld;
    const rains = (S.eff && S.eff.rains && S.eff.rains.length) ? S.eff.rains : null;
    let wr = 0, fxFire = 2;
    for (let k = 0; k < n0; k++) {
      const i = fireList[k];
      const f = fire[i];
      if (f === 0) { inFire[i] = 0; continue; }
      const y = (i / W) | 0, x = i - y * W;
      if (rains !== null && rainAt(rains, x, y, tick) && R.f() < 0.3) {
        fire[i] = 0; inFire[i] = 0;
        if (fxBudget > 0) { fxBudget--; Fx.add('smoke', x + 0.5, y + 0.5, { ttl: 0.9 }); }
        continue;
      }
      if (((tick + i) % 5) === 0) {
        dmgUnits(x, y, 3, 'fire');
        if (bld[i]) dmgBld(x, y, 4, 'fire');
        if (fxFire > 0 && R.f() < 0.35) { fxFire--; Fx.add('fire', x + 0.5, y + 0.5, { ttl: 0.6 }); }
      }
      if (x > 0) tryCatch(i - 1, x - 1, y, tick);
      if (x < W - 1) tryCatch(i + 1, x + 1, y, tick);
      if (y > 0) tryCatch(i - W, x, y - 1, tick);
      if (y < Hh - 1) tryCatch(i + W, x, y + 1, tick);
      if (f === 1) {
        fire[i] = 0; inFire[i] = 0;
        burnOut(i, x, y);
        continue;
      }
      fire[i] = f - 1;
      fireList[wr++] = i;
    }
    // append fires that were started during this pass
    for (let k = n0; k < fireN; k++) fireList[wr++] = fireList[k];
    fireN = wr;
  }

  // ====================================================================================================
  //  LAVA
  // ====================================================================================================
  function stepLava(tick) {
    if (lavaN === 0) return;
    const tile = S.tile;
    const phase = tick % 10;
    for (let k = phase; k < lavaN; k += 10) {
      const i = lavaList[k];
      if (tile[i] !== T.LAVA) continue;
      const y = (i / W) | 0, x = i - y * W;
      const l = x > 0 ? i - 1 : -1, r = x < W - 1 ? i + 1 : -1, u = y > 0 ? i - W : -1, d = y < Hh - 1 ? i + W : -1;
      const wet = (l >= 0 && ISWATER[tile[l]]) || (r >= 0 && ISWATER[tile[r]]) || (u >= 0 && ISWATER[tile[u]]) || (d >= 0 && ISWATER[tile[d]]);
      if (wet) {
        if (R.f() < 0.5) {
          put(i, x, y, T.MOUNTAIN);
          if (fxBudget > 0) { fxBudget--; Fx.add('smoke', x + 0.5, y + 0.5, { ttl: 1.3, n: 3 }); }
          continue;
        }
      } else if (R.f() < LAVA_HILL_P) {
        put(i, x, y, T.HILL);
        if (fxBudget > 0) { fxBudget--; Fx.add('smoke', x + 0.5, y + 0.5, { ttl: 1.0 }); }
        continue;
      }
      // heat: ignites flammable neighbours, hurts creatures standing next to the lava
      for (let q = 0; q < 4; q++) {
        const j = q === 0 ? l : q === 1 ? r : q === 2 ? u : d;
        if (j < 0) continue;
        const jt = tile[j];
        if (WALK[jt] === 1) {
          const jy = (j / W) | 0, jx = j - jy * W;
          dmgUnits(jx, jy, 2, 'lava');
          if (S.fire[j] === 0) {
            const fl = flamIdx(j);
            if (fl > 0 && R.f() < 0.12 * fl) startFire(j, fl);
          }
        }
      }
    }
  }

  // ====================================================================================================
  //  GROWTH
  // ====================================================================================================
  function localForestDensity(x, y) {
    const tile = S.tile;
    const x0 = Math.max(0, x - 3), x1 = Math.min(W - 1, x + 3), y0 = Math.max(0, y - 3), y1 = Math.min(Hh - 1, y + 3);
    let c = 0, tot = 0;
    for (let yy = y0; yy <= y1; yy++) {
      const row = yy * W;
      for (let xx = x0; xx <= x1; xx++) { tot++; if (tile[row + xx] === T.FOREST) c++; }
    }
    return c / tot;
  }
  function forestNeighbours(i, x, y) {
    const tile = S.tile;
    let c = 0;
    const x0 = x > 0 ? -1 : 0, x1 = x < W - 1 ? 1 : 0, y0 = y > 0 ? -W : 0, y1 = y < Hh - 1 ? W : 0;
    for (let dy = y0; dy <= y1; dy += W) for (let dx = x0; dx <= x1; dx++) {
      if ((dy !== 0 || dx !== 0) && tile[i + dy + dx] === T.FOREST) c++;
    }
    return c;
  }

  function growTile(i, tick, rains, forceRain) {
    const tile = S.tile;
    const t = tile[i];
    if (t !== T.FOREST && t !== T.GRASS) return;
    const rk = t === T.GRASS ? S.res[i] : 0;
    if (t === T.GRASS && rk !== RES.TREE && rk !== RES.BERRY) return;
    if (S.fire[i]) return;
    const y = (i / W) | 0, x = i - y * W;
    const m = (forceRain || (rains !== null && rainAt(rains, x, y, tick))) ? 3 : 1;
    if (t === T.FOREST) {
      const a = S.amt[i];
      if (a < 200) {
        const na = a + 3 * m > 200 ? 200 : a + 3 * m;
        S.amt[i] = na;
        if ((na >> 5) !== (a >> 5)) S.markDirty(x, y);
      }
      if (forestG > 0 && R.f() < 0.15 * m * forestG) spreadFrom(i, x, y);
    } else if (rk === RES.TREE) {
      let a = S.amt[i] + (3 + R.i(4)) * m;
      if (a > 70) a = 70;
      S.amt[i] = a;
      if (a >= 60 && forestG > 0 && R.f() < forestG) {
        if (forestNeighbours(i, x, y) >= 1 && localForestDensity(x, y) < FOREST_DENSITY_CAP) {
          put(i, x, y, T.FOREST, S.elev[i]);       // sapling matured into woodland (res cleared, amt 80..200)
        }
      }
    } else {
      const a = S.amt[i];
      if (a < 120) {
        let na = a + (3 + R.i(3)) * m; if (na > 120) na = 120;
        S.amt[i] = na;
        if (a === 0 || na >= 120) S.markDirty(x, y);
      }
    }
  }

  function spreadFrom(i, x, y) {
    const dens = localForestDensity(x, y);
    if (dens >= FOREST_DENSITY_CAP) return;
    if (R.f() >= clamp((FOREST_DENSITY_CAP - dens) / 0.5, 0, 1)) return;
    const q = R.i(4), far = R.f() < 0.15 ? 2 : 1;
    let tx = x, ty = y;
    if (q === 0) tx += far; else if (q === 1) tx -= far; else if (q === 2) ty += far; else ty -= far;
    if (tx < 0 || ty < 0 || tx >= W || ty >= Hh) return;
    const j = ty * W + tx;
    if (S.tile[j] !== T.GRASS || S.res[j] !== 0 || S.bld[j] !== 0 || S.fire[j] !== 0) return;
    if (S.owner[j] !== 0 && R.f() < 0.7) return;   // keep settlements breathing room
    S.res[j] = RES.TREE; S.amt[j] = 10 + R.i(10);
    S.markDirty(tx, ty);
  }

  function stepGrowth(tick) {
    const rains = (S.eff && S.eff.rains && S.eff.rains.length) ? S.eff.rains : null;
    let samples = (NN / 250) | 0;
    if (samples < 8) samples = 8;
    for (let s = 0; s < samples; s++) growTile((R.f() * NN) | 0, tick, rains, false);
    if (rains !== null) {
      for (let k = 0; k < rains.length; k++) {
        const rn = rains[k];
        if (rn.until !== undefined && rn.until <= tick) continue;
        const a = R.f() * 6.2831853, d = Math.sqrt(R.f()) * rn.r;
        const x = Math.floor(rn.x + Math.cos(a) * d), y = Math.floor(rn.y + Math.sin(a) * d);
        if (x >= 0 && y >= 0 && x < W && y < Hh) growTile(y * W + x, tick, rains, true);
      }
    }
  }

  /** periodic bookkeeping scan: forest/land counts, lava list, fires lit by someone who bypassed World.ignite */
  function scanState(tick, silent) {
    const tile = S.tile, fire = S.fire;
    let fc = 0, lc = 0, ln = 0;
    for (let i = 0; i < NN; i++) {
      const t = tile[i];
      if (ISLANDT[t]) { lc++; if (t === T.FOREST) fc++; }
      else if (t === T.LAVA) lavaList[ln++] = i;
      if (fire[i] !== 0 && inFire[i] === 0) { inFire[i] = 1; fireList[fireN++] = i; }
    }
    lavaN = ln; forestCount = fc; landCount = lc;
    forestG = lc > 0 ? clamp((FOREST_MAX_SHARE - fc / lc) / 0.12, 0, 1) : 0;
  }

  // ====================================================================================================
  //  LANDMASS LABELS
  // ====================================================================================================
  function relabel() {
    ensure();
    if (!lbl) return;
    lbl.fill(0);
    const tile = S.tile;
    let c = 0;
    lblSizes = [0];
    for (let s = 0; s < NN; s++) {
      if (lbl[s] !== 0 || WALK[tile[s]] === 0) continue;
      c++;
      let sp = 0, size = 0;
      stack[sp++] = s; lbl[s] = c;
      while (sp > 0) {
        const i = stack[--sp];
        size++;
        const y = (i / W) | 0, x = i - y * W;
        if (x > 0 && lbl[i - 1] === 0 && WALK[tile[i - 1]] === 1) { lbl[i - 1] = c; stack[sp++] = i - 1; }
        if (x < W - 1 && lbl[i + 1] === 0 && WALK[tile[i + 1]] === 1) { lbl[i + 1] = c; stack[sp++] = i + 1; }
        if (y > 0 && lbl[i - W] === 0 && WALK[tile[i - W]] === 1) { lbl[i - W] = c; stack[sp++] = i - W; }
        if (y < Hh - 1 && lbl[i + W] === 0 && WALK[tile[i + W]] === 1) { lbl[i + W] = c; stack[sp++] = i + W; }
      }
      lblSizes[c] = size;
    }
    lblCount = c;
    S.landDirty = false;
    lastRelabel = S.tick;
  }
  /** id of the walkable component containing the tile (0 = not walkable / out of bounds). Ids are only valid until the next relabel. */
  function landId(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.tile || x < 0 || y < 0 || x >= S.w || y >= S.h) return 0;
    ensure();
    if (S.landDirty) relabel();
    return lbl[y * W + x];
  }
  function sameLand(x0, y0, x1, y1) {
    const a = landId(x0, y0);
    return a !== 0 && a === landId(x1, y1);
  }
  function landSize(x, y) { const id = landId(x, y); return id ? lblSizes[id] : 0; }

  // ====================================================================================================
  //  PATHFINDING (bounded A*)
  // ====================================================================================================
  const DX8 = [1, -1, 0, 0, 1, 1, -1, -1], DY8 = [0, 0, 1, -1, 1, -1, 1, -1];

  function heapPush(key, idx, g) {
    if (hN === hCap) {
      const nc = hCap * 2;
      const k2 = new Float64Array(nc), i2 = new Int32Array(nc), g2 = new Float64Array(nc);
      k2.set(hK); i2.set(hI); g2.set(hGv);
      hK = k2; hI = i2; hGv = g2; hCap = nc;
    }
    let c = hN++;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (hK[p] <= key) break;
      hK[c] = hK[p]; hI[c] = hI[p]; hGv[c] = hGv[p];
      c = p;
    }
    hK[c] = key; hI[c] = idx; hGv[c] = g;
  }
  let popIdx = 0, popG = 0;
  function heapPop() {
    popIdx = hI[0]; popG = hGv[0];
    const n = --hN;
    if (n > 0) {
      const key = hK[n], idx = hI[n], g = hGv[n];
      let c = 0;
      for (;;) {
        let ch = 2 * c + 1;
        if (ch >= n) break;
        if (ch + 1 < n && hK[ch + 1] < hK[ch]) ch++;
        if (hK[ch] >= key) break;
        hK[c] = hK[ch]; hI[c] = hI[ch]; hGv[c] = hGv[ch];
        c = ch;
      }
      hK[c] = key; hI[c] = idx; hGv[c] = g;
    }
  }

  /**
   * Bounded 8-neighbour A*, no corner cutting. Returns [[x,y],...] (start excluded, goal included) or null.
   * opts: {adjacent: true} accepts any tile within 1 (Chebyshev) of the goal; {partial: true} returns the best
   * reached prefix when the node budget is exhausted instead of null.
   */
  function findPath(x0, y0, x1, y1, race, maxNodes, opts) {
    if (!S.tile) return null;
    ensure();
    x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.floor(x1); y1 = Math.floor(y1);
    if (!inb(x0, y0) || !inb(x1, y1)) return null;
    const adj = !!(opts && opts.adjacent), partial = !!(opts && opts.partial);
    const tile = S.tile, w = W, hgt = Hh;
    const tb = costTabFor(race);
    const s = y0 * w + x0, g = y1 * w + x1;
    if (tb[tile[s]] <= 0) return null;
    if (S.landDirty) relabel();
    const sl = lbl[s];
    if (adj) {
      if (Math.abs(x0 - x1) <= 1 && Math.abs(y0 - y1) <= 1) return [];
      let ok = false;
      for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x1 + dx, yy = y1 + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < hgt && lbl[yy * w + xx] === sl) { ok = true; break; }
      }
      if (!ok) return null;
    } else {
      if (lbl[g] !== sl) return null;
      if (s === g) return [];
    }
    if (!(maxNodes > 0)) maxNodes = 1500;
    if (++pGen >= 4294967295) { pStamp.fill(0); pGen = 1; }
    const gen = pGen;
    const base = tb[T.GRASS] > 0.3 ? tb[T.GRASS] : 1;
    const hs = PATH_WEIGHT / base;                      // weighted A*: ~3% longer paths on average, far fewer expansions
    const off = adj ? 1.5 : 0;
    hN = 0;
    pg[s] = 0; pPar[s] = -1; pStamp[s] = gen;
    let dxs = Math.abs(x0 - x1), dys = Math.abs(y0 - y1);
    let h0 = (dxs > dys ? dxs + 0.41421356 * dys : dys + 0.41421356 * dxs) - off; if (h0 < 0) h0 = 0;
    heapPush(h0 * hs, s, 0);
    let expanded = 0, found = -1, best = s, bestH = h0;
    while (hN > 0) {
      heapPop();
      const cur = popIdx, gc = popG;
      if (gc > pg[cur] + 1e-9) continue;               // stale entry
      const cy = (cur / w) | 0, cx = cur - cy * w;
      if (adj ? (Math.abs(cx - x1) <= 1 && Math.abs(cy - y1) <= 1) : cur === g) { found = cur; break; }
      if (++expanded > maxNodes) break;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX8[d], ny = cy + DY8[d];
        if (nx < 0 || ny < 0 || nx >= w || ny >= hgt) continue;
        const j = ny * w + nx;
        const c = tb[tile[j]];
        if (c <= 0) continue;
        let step;
        if (d >= 4) {
          if (tb[tile[cy * w + nx]] <= 0 || tb[tile[ny * w + cx]] <= 0) continue;
          step = 1.41421356 / c;
        } else step = 1 / c;
        const ng = gc + step;
        if (pStamp[j] === gen && ng >= pg[j] - 1e-9) continue;
        pStamp[j] = gen; pg[j] = ng; pPar[j] = cur;
        const ddx = Math.abs(nx - x1), ddy = Math.abs(ny - y1);
        let hh = (ddx > ddy ? ddx + 0.41421356 * ddy : ddy + 0.41421356 * ddx) - off; if (hh < 0) hh = 0;
        if (hh < bestH) { bestH = hh; best = j; }
        heapPush(ng + hh * hs, j, ng);
      }
    }
    if (found < 0) {
      if (!partial || best === s) return null;
      found = best;
    }
    let len = 0;
    for (let k = found; k !== s; k = pPar[k]) len++;
    const path = new Array(len);
    for (let k = found, p = len - 1; k !== s; k = pPar[k], p--) {
      const ky = (k / w) | 0;
      path[p] = [k - ky * w, ky];
    }
    return path;
  }

  // ====================================================================================================
  //  LIFECYCLE
  // ====================================================================================================
  function newWorld() { cKey = null; ensure(); }
  function afterLoad() { cKey = null; ensure(); }

  function step(tick) {
    if (!S.tile) return;
    ensure();
    if (tick === undefined) tick = S.tick;
    fxBudget = 3;
    if (tick % 10 === 0) scanState(tick, false);
    stepGrowth(tick);
    stepFire(tick);
    stepLava(tick);
    if (S.landDirty && tick - lastRelabel >= 10) relabel();
  }

  return {
    generate, tileAt, setTile, brush, walkable, moveCost, findPath, landId, sameLand, isBuildable,
    findNearestRes, harvest, resAt, ignite, extinguish, isBurning, randomLand, nearestTile, step,
    newWorld, afterLoad,
    // extras
    inBounds, nearestWalkable, landSize,
    forestShare() { ensure(); return landCount ? forestCount / landCount : 0; },
    fireCount() { ensure(); return fireN; },
    landmassCount() { ensure(); if (S.landDirty) relabel(); return lblCount; },
  };
})();
