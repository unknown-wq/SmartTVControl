/* =====================================================================
 * 14_regions.js — Regions: the land is partitioned into ~60-90 tile "states" (HOI4 style).
 * OWNER: Regions agent. API: docs/CONTRACT.md §8.1 + §8.3.  DOM-free, deterministic (all randomness through R).
 *
 *  S.region[i]            region id of every non-water tile (0 = water, or a landmass smaller than 12 tiles)
 *  S.regions              Map id -> Region  (saved by Save as a table; see the Region schema in the contract)
 *  Region                 {id,name,cx,cy,tiles,ownerId,controllerId,cityIds,nb,fd,claims,cores,value,since,occSince,terrain}
 *    nb                   neighbouring region ids: land contact (4-neighbour) + fords (regions separated by 1-2 shallow tiles)
 *    fd                   the subset of nb that is ONLY reachable over a ford (peaceful expansion ignores them, armies do not)
 *  S.mod.regions          persistent private state: {next, cd:{kid:tick}, pend:[tile idx], pt0, pt1, full}
 *
 * Build:   farthest-point seeds (geodesic 4-neighbour distance over land, ~Const.REGION_SPACING apart, random pick among the best
 *          candidates) -> multi-source growth (weighted BFS over the 8-neighbourhood with smooth noise, terrain cost and a per-seed
 *          speed: organic, roundish regions whose borders like to follow ridges) -> every label keeps its largest 4-connected piece
 *          (the rest joins the neighbour it touches most) -> merge fragments < 14 tiles -> compact ids -> stats.  2-5 ms at 96x96.
 * Edits:   Bus 'tileChanged' only records the tile (debounced, JSON-safe in S.mod.regions.pend); step() processes the batch once
 *          the brush stroke is quiet: sunk tiles leave their region, new land joins the majority neighbour, orphan landmasses
 *          >= 12 tiles become new regions, regions cut in two are split, empty regions vanish.
 * Owner vs controller: setOwner() is the legal owner (peace deals, expansion, god); setController() is the occupier (War).
 *          Cities inside get occupy()/liberate() automatically (Cities owns the economic effects).
 * Determinism: every cache is rebuilt from S.region / S.cities in afterLoad(); nothing time-dependent lives outside S.mod.
 * ===================================================================== */

const Regions = (() => {
  const T = Const.T;
  const MIN_COMP = 12;            // smaller landmasses stay region 0
  const MIN_FRAG = 14;            // regions smaller than this are merged into the neighbour with the longest border
  const INF16 = 65535;
  const SPACING_K = 1.05;         // geodesic (4-neighbour) seed distance = round(REGION_SPACING * SPACING_K)
  const QUIET = 3, MAXWAIT = 30;  // edit debounce (ticks)
  const PEND_CAP = 2500;          // more pending tiles than this => full rescan
  const EXPAND_RANGE = 16;        // a city of the kingdom must be this close to the region centre
  const POP_PER_REGION = 6;
  const EXTRA_COST = [0, 0, 0, 0, 0.15, 0.3, 1.1, 1.5, 1.5];   // growth cost on top of 1 per tile, by tile type (borders follow ridges)

  // ---------------------------------------------------------------- non-persistent caches (all rebuilt in afterLoad)
  const bbox = new Map();         // rid -> [x0,y0,x1,y1]
  const lmOf = new Map();         // rid -> landmass component (over nb)
  let pmark = null;               // Uint8Array: tile already queued in S.mod.regions.pend
  let scratchN = 0, qbuf = null, stamp = null, stampCtr = 0;
  let flCache = [], flVer = -1, flSig = 0;

  // ---------------------------------------------------------------- small helpers
  function isLandT(t) { return t !== T.DEEP && t !== T.SHALLOW; }
  function round(v, k) { const p = k === 3 ? 1000 : 100; return Math.round(v * p) / p; }
  function mod() {
    let m = S.mod.regions;
    if (!m || typeof m !== 'object') m = S.mod.regions = { next: 1, cd: {}, pend: [], pt0: 0, pt1: 0, full: 0 };
    if (!m.cd || typeof m.cd !== 'object') m.cd = {};
    if (!Array.isArray(m.pend)) m.pend = [];
    if (!(m.next >= 1)) { let mx = 0; for (const id of S.regions.keys()) if (id > mx) mx = id; m.next = mx + 1; }
    if (typeof m.pt0 !== 'number') m.pt0 = 0;
    if (typeof m.pt1 !== 'number') m.pt1 = 0;
    if (!m.full) m.full = 0;
    return m;
  }
  function active() { return !!(S.regions && S.regions.size > 0 && S.region); }
  function get(id) { return S.regions ? (S.regions.get(id) || null) : null; }
  function aliveK(kid) { if (!(kid > 0)) return false; const k = S.kingdoms.get(kid); return !!k && k.alive !== false; }
  function idxOf(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.region || !(x >= 0 && y >= 0 && x < S.w && y < S.h)) return -1;
    return y * S.w + x;
  }
  function at(x, y) { const i = idxOf(x, y); return i < 0 ? 0 : S.region[i]; }
  function ensureScratch(n) {
    if (scratchN !== n || !qbuf) { scratchN = n; qbuf = new Int32Array(n); stamp = new Int32Array(n); stampCtr = 0; }
  }
  function ensureMarks() {
    const n = S.w * S.h;
    if (!pmark || pmark.length !== n) pmark = new Uint8Array(n);
    return pmark;
  }
  function clearMarks() { if (pmark) pmark.fill(0); }
  function newRegion(id, name) {
    return {
      id, name, cx: 0, cy: 0, tiles: 0, ownerId: 0, controllerId: 0, cityIds: [], nb: [], fd: [], claims: [], cores: [],
      value: 0, since: 0, occSince: 0, terrain: { forest: 0, hill: 0, mountain: 0, sand: 0, snow: 0 },
    };
  }
  function placeName() { return Names.place(R.i(3)); }

  // ================================================================ BUILD
  /**
   * Partition S.region from the terrain. Returns the region count. Uses R (seeded) so the layout varies per world but is reproducible;
   * the R state is restored afterwards, so generating regions never shifts the gameplay random stream of an existing world / test.
   */
  function build() {
    const rs = R.getState();
    try { return buildImpl(); } finally { R.setState(rs); }
  }
  function buildImpl() {
    if (!S.tile) return 0;
    const w = S.w, h = S.h, n = w * h, tile = S.tile;
    if (!S.region || S.region.length !== n) S.region = new Int32Array(n); else S.region.fill(0);
    if (!S.regions) S.regions = new Map(); else S.regions.clear();
    S.mod.regions = { next: 1, cd: {}, pend: [], pt0: 0, pt1: 0, full: 0 };
    clearMarks(); bbox.clear(); lmOf.clear(); flVer = -1;
    const rg = S.region;
    ensureScratch(n);

    // ---- 1. land components (4-neighbour); components below MIN_COMP are ignored
    const comp = new Int32Array(n), stack = qbuf;
    const csize = [0];
    let nc = 0;
    for (let s = 0; s < n; s++) {
      if (comp[s] !== 0 || !isLandT(tile[s])) continue;
      nc++;
      let sp = 0, size = 0;
      stack[sp++] = s; comp[s] = nc;
      while (sp > 0) {
        const i = stack[--sp];
        size++;
        const x = i % w;
        if (x > 0 && comp[i - 1] === 0 && isLandT(tile[i - 1])) { comp[i - 1] = nc; stack[sp++] = i - 1; }
        if (x < w - 1 && comp[i + 1] === 0 && isLandT(tile[i + 1])) { comp[i + 1] = nc; stack[sp++] = i + 1; }
        if (i >= w && comp[i - w] === 0 && isLandT(tile[i - w])) { comp[i - w] = nc; stack[sp++] = i - w; }
        if (i < n - w && comp[i + w] === 0 && isLandT(tile[i + w])) { comp[i + w] = nc; stack[sp++] = i + w; }
      }
      csize.push(size);
    }
    let L = 0;
    for (let i = 0; i < n; i++) if (comp[i] > 0 && csize[comp[i]] >= MIN_COMP) L++;
    if (L === 0) { S.touchRegions(); return 0; }
    const land = new Int32Array(L);
    for (let i = 0, k = 0; i < n; i++) if (comp[i] > 0 && csize[comp[i]] >= MIN_COMP) land[k++] = i;

    // ---- 2. seeds: farthest-point sampling on the geodesic distance, random among the ~best candidates
    const D = Math.max(4, Math.round(Const.REGION_SPACING * SPACING_K));
    const dist = new Uint16Array(n);                    // 0 for tiles that are not candidates (water / specks / seeds)
    for (let k = 0; k < L; k++) dist[land[k]] = INF16;
    const queue = new Int32Array(n);
    const seeds = [];
    const addSeed = (s) => {
      dist[s] = 0;
      let qh = 0, qt = 0;
      queue[qt++] = s;
      while (qh < qt) {
        const i = queue[qh++];
        const d = dist[i] + 1, x = i % w;
        if (x > 0 && dist[i - 1] > d) { dist[i - 1] = d; queue[qt++] = i - 1; }
        if (x < w - 1 && dist[i + 1] > d) { dist[i + 1] = d; queue[qt++] = i + 1; }
        if (i >= w && dist[i - w] > d) { dist[i - w] = d; queue[qt++] = i - w; }
        if (i < n - w && dist[i + w] > d) { dist[i + w] = d; queue[qt++] = i + w; }
      }
    };
    for (let guard = 0; guard < 600; guard++) {
      let mx = 0;
      for (let k = 0; k < L; k++) { const d = dist[land[k]]; if (d > mx) mx = d; }
      if (mx < D) break;
      const thr = mx === INF16 ? INF16 : Math.max(D, Math.ceil(mx * 0.82));
      let c = 0;
      for (let k = 0; k < L; k++) if (dist[land[k]] >= thr) c++;
      let pick = R.i(c), s = -1;
      for (let k = 0; k < L; k++) if (dist[land[k]] >= thr) { if (pick-- === 0) { s = land[k]; break; } }
      if (s < 0) break;
      seeds.push(s);
      addSeed(s);
    }

    // ---- 3. multi-source growth (weighted BFS = Dijkstra over the 8-neighbourhood, no corner cutting across water) with smooth noise,
    //         terrain cost and a per-seed speed -> organic, roughly round regions; 4-connectivity is repaired right after
    const cost = new Float32Array(n);
    const ns = R.i(0x3fffffff);
    const CELL = 6;
    for (let k = 0; k < L; k++) {
      const i = land[k], x = i % w, y = (i - x) / w;
      const gx = x / CELL, gy = y / CELL, x0 = Math.floor(gx), y0 = Math.floor(gy);
      let fx = gx - x0, fy = gy - y0;
      fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
      const a = Util.hash2(x0, y0, ns) / 4294967296, b = Util.hash2(x0 + 1, y0, ns) / 4294967296;
      const c = Util.hash2(x0, y0 + 1, ns) / 4294967296, d = Util.hash2(x0 + 1, y0 + 1, ns) / 4294967296;
      const vn = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
      const wn = Util.hash2(x, y, ns ^ 0x5bd1e995) / 4294967296;
      cost[i] = 1 + 0.9 * vn + 0.1 * wn + EXTRA_COST[tile[i]];
    }
    const speed = new Float32Array(seeds.length + 1);
    for (let s = 1; s <= seeds.length; s++) speed[s] = 0.88 + 0.26 * R.f();
    const cap = 8 * L + seeds.length + 16;
    const hk = new Float32Array(cap), hv = new Int32Array(cap);
    let hn = 0;
    const hpush = (key, v) => {
      let c = hn++;
      while (c > 0) { const p = (c - 1) >> 1; if (hk[p] <= key) break; hk[c] = hk[p]; hv[c] = hv[p]; c = p; }
      hk[c] = key; hv[c] = v;
    };
    const best = new Float32Array(n).fill(Infinity);
    const ok = (j) => comp[j] > 0 && csize[comp[j]] >= MIN_COMP;
    for (let s = 0; s < seeds.length; s++) { best[seeds[s]] = 0; rg[seeds[s]] = s + 1; hpush(0, seeds[s]); }
    const SQ2 = 1.4142;
    while (hn > 0) {
      const key = hk[0], i = hv[0];
      hn--;
      if (hn > 0) {
        const lk = hk[hn], lv = hv[hn];
        let c = 0;
        for (;;) {
          let l = 2 * c + 1;
          if (l >= hn) break;
          if (l + 1 < hn && hk[l + 1] < hk[l]) l++;
          if (hk[l] >= lk) break;
          hk[c] = hk[l]; hv[c] = hv[l]; c = l;
        }
        hk[c] = lk; hv[c] = lv;
      }
      if (key > best[i]) continue;
      const lab = rg[i], x = i % w, sp = 1 / speed[lab];
      const hasL = x > 0, hasR = x < w - 1, hasU = i >= w, hasD = i < n - w;
      let okL = false, okR = false, okU = false, okD = false;
      if (hasL && ok(i - 1)) { okL = true; const j = i - 1, nk = key + cost[j] * sp; if (nk < best[j]) { best[j] = nk; rg[j] = lab; hpush(nk, j); } }
      if (hasR && ok(i + 1)) { okR = true; const j = i + 1, nk = key + cost[j] * sp; if (nk < best[j]) { best[j] = nk; rg[j] = lab; hpush(nk, j); } }
      if (hasU && ok(i - w)) { okU = true; const j = i - w, nk = key + cost[j] * sp; if (nk < best[j]) { best[j] = nk; rg[j] = lab; hpush(nk, j); } }
      if (hasD && ok(i + w)) { okD = true; const j = i + w, nk = key + cost[j] * sp; if (nk < best[j]) { best[j] = nk; rg[j] = lab; hpush(nk, j); } }
      if (okL && okU && ok(i - w - 1)) { const j = i - w - 1, nk = key + cost[j] * sp * SQ2; if (nk < best[j]) { best[j] = nk; rg[j] = lab; hpush(nk, j); } }
      if (okR && okU && ok(i - w + 1)) { const j = i - w + 1, nk = key + cost[j] * sp * SQ2; if (nk < best[j]) { best[j] = nk; rg[j] = lab; hpush(nk, j); } }
      if (okL && okD && ok(i + w - 1)) { const j = i + w - 1, nk = key + cost[j] * sp * SQ2; if (nk < best[j]) { best[j] = nk; rg[j] = lab; hpush(nk, j); } }
      if (okR && okD && ok(i + w + 1)) { const j = i + w + 1, nk = key + cost[j] * sp * SQ2; if (nk < best[j]) { best[j] = nk; rg[j] = lab; hpush(nk, j); } }
    }
    // 8-connected growth can leave a diagonal-only neck: every label keeps its largest 4-connected piece, the rest joins the
    // neighbouring label it touches most (the receiving label stays connected because the piece touches it)
    {
      const stp = ++stampCtr;
      const comps = [];                                   // per component: array of tile indices
      const byLabel = new Map();
      for (let q = 0; q < L; q++) {
        const s0 = land[q];
        if (stamp[s0] === stp) continue;
        const lab = rg[s0], cl = [];
        let spn = 0;
        stack[spn++] = s0; stamp[s0] = stp;
        while (spn > 0) {
          const i = stack[--spn];
          cl.push(i);
          const x = i % w;
          if (x > 0 && stamp[i - 1] !== stp && rg[i - 1] === lab) { stamp[i - 1] = stp; stack[spn++] = i - 1; }
          if (x < w - 1 && stamp[i + 1] !== stp && rg[i + 1] === lab) { stamp[i + 1] = stp; stack[spn++] = i + 1; }
          if (i >= w && stamp[i - w] !== stp && rg[i - w] === lab) { stamp[i - w] = stp; stack[spn++] = i - w; }
          if (i < n - w && stamp[i + w] !== stp && rg[i + w] === lab) { stamp[i + w] = stp; stack[spn++] = i + w; }
        }
        comps.push(cl);
        const prev = byLabel.get(lab);
        if (prev === undefined || cl.length > comps[prev].length) byLabel.set(lab, comps.length - 1);
      }
      for (let ci = 0; ci < comps.length; ci++) {
        const cl = comps[ci], lab = rg[cl[0]];
        if (byLabel.get(lab) === ci) continue;
        const votes = new Map();
        for (let j = 0; j < cl.length; j++) {
          const i = cl[j], x = i % w;
          if (x > 0 && rg[i - 1] !== lab && rg[i - 1] !== 0) votes.set(rg[i - 1], (votes.get(rg[i - 1]) || 0) + 1);
          if (x < w - 1 && rg[i + 1] !== lab && rg[i + 1] !== 0) votes.set(rg[i + 1], (votes.get(rg[i + 1]) || 0) + 1);
          if (i >= w && rg[i - w] !== lab && rg[i - w] !== 0) votes.set(rg[i - w], (votes.get(rg[i - w]) || 0) + 1);
          if (i < n - w && rg[i + w] !== lab && rg[i + w] !== 0) votes.set(rg[i + w], (votes.get(rg[i + w]) || 0) + 1);
        }
        let pick = 0, pc = 0;
        for (const [v, c] of votes) if (c > pc) { pc = c; pick = v; }
        if (pick) for (let j = 0; j < cl.length; j++) rg[cl[j]] = pick;
      }
    }

    // ---- 4. merge fragments < MIN_FRAG into the neighbour with the longest shared border
    const K = seeds.length, W1 = K + 1;
    const cnt = new Int32Array(W1), bord = new Int32Array(W1 * W1), parent = new Int32Array(W1);
    for (let k = 0; k <= K; k++) parent[k] = k;
    for (let k = 0; k < L; k++) {
      const i = land[k], a = rg[i], x = i % w;
      cnt[a]++;
      if (x < w - 1) { const b = rg[i + 1]; if (b !== 0 && b !== a) { bord[a * W1 + b]++; bord[b * W1 + a]++; } }
      if (i < n - w) { const b = rg[i + w]; if (b !== 0 && b !== a) { bord[a * W1 + b]++; bord[b * W1 + a]++; } }
    }
    for (let guard = 0; guard < K + 5; guard++) {
      let a = 0;
      for (let k = 1; k <= K; k++) {
        if (cnt[k] === 0 || cnt[k] >= MIN_FRAG || (a !== 0 && cnt[k] >= cnt[a])) continue;
        let has = false;
        for (let j = 1; j <= K; j++) if (bord[k * W1 + j] > 0) { has = true; break; }
        if (has) a = k;
      }
      if (a === 0) break;
      let b = 0, bb = 0;
      for (let j = 1; j <= K; j++) {
        const v = bord[a * W1 + j];
        if (v > bb || (v === bb && v > 0 && cnt[j] > cnt[b])) { bb = v; b = j; }
      }
      // merge a into b
      for (let j = 1; j <= K; j++) {
        if (j === a || j === b) continue;
        bord[b * W1 + j] += bord[a * W1 + j]; bord[j * W1 + b] += bord[j * W1 + a];
        bord[a * W1 + j] = 0; bord[j * W1 + a] = 0;
      }
      bord[a * W1 + b] = 0; bord[b * W1 + a] = 0;
      cnt[b] += cnt[a]; cnt[a] = 0; parent[a] = b;
    }
    const fin = (k) => { while (parent[k] !== k) k = parent[k]; return k; };

    // ---- 5. compact relabel in scan order + entities
    const remap = new Int32Array(W1);
    let nr = 0;
    const ent = [];
    for (let i = 0; i < n; i++) {
      const a = rg[i];
      if (a === 0) continue;
      const f = fin(a);
      if (remap[f] === 0) { remap[f] = ++nr; ent.push(newRegion(nr, '')); }
      rg[i] = remap[f];
    }
    for (let k = 0; k < ent.length; k++) { ent[k].name = placeName(); S.regions.set(ent[k].id, ent[k]); }
    S.mod.regions.next = nr + 1;
    computeStats(true);
    S.touchRegions();
    return S.regions.size;
  }

  // ================================================================ STATS (adjacency, centres, cities)
  /**
   * Recompute everything that is a pure function of S.region / S.cities: tiles, nb/fd, cityIds, value, city.regionId and the bbox /
   * landmass caches.  full=true additionally refreshes the terrain-dependent fields (centre tile, terrain fractions) — afterLoad passes
   * false so a load never changes a saved value that the live run would not have changed at that tick.
   * Regions without tiles are deleted (Bus 'regionRemoved').
   */
  function computeStats(full) {
    const w = S.w, h = S.h, n = w * h, rg = S.region, tile = S.tile, regs = S.regions;
    let maxId = 0;
    for (const id of regs.keys()) if (id > maxId) maxId = id;
    const dense = new Int32Array(maxId + 1).fill(-1);
    const ids = [];
    for (const id of regs.keys()) { dense[id] = ids.length; ids.push(id); }
    const K = ids.length;
    // repair pass: water / unknown ids never keep a region
    for (let i = 0; i < n; i++) {
      const r = rg[i];
      if (r !== 0 && (r < 0 || r > maxId || dense[r] < 0 || !isLandT(tile[i]))) rg[i] = 0;
    }
    const cnt = new Int32Array(K), sx = new Float64Array(K), sy = new Float64Array(K), tc = new Int32Array(K * 5);
    const bx0 = new Int32Array(K).fill(w), by0 = new Int32Array(K).fill(h), bx1 = new Int32Array(K).fill(-1), by1 = new Int32Array(K).fill(-1);
    const adj = new Uint8Array(K * K);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, rid = rg[i];
        if (rid === 0) continue;
        const k = dense[rid];
        cnt[k]++; sx[k] += x; sy[k] += y;
        if (x < bx0[k]) bx0[k] = x; if (x > bx1[k]) bx1[k] = x; if (y < by0[k]) by0[k] = y; if (y > by1[k]) by1[k] = y;
        const t = tile[i];
        if (t === T.FOREST) tc[k * 5]++; else if (t === T.HILL) tc[k * 5 + 1]++; else if (t === T.MOUNTAIN) tc[k * 5 + 2]++;
        else if (t === T.SAND) tc[k * 5 + 3]++; else if (t === T.SNOW) tc[k * 5 + 4]++;
        if (x < w - 1) {
          const r2 = rg[i + 1];
          if (r2 !== 0 && r2 !== rid) { const k2 = dense[r2]; adj[k * K + k2] = 1; adj[k2 * K + k] = 1; }
          else if (r2 === 0 && x + 2 < w && tile[i + 1] === T.SHALLOW) {              // ford: land, 1-2 shallow tiles, land
            let r3 = rg[i + 2];
            if (r3 === 0 && tile[i + 2] === T.SHALLOW && x + 3 < w) r3 = rg[i + 3];
            if (r3 !== 0 && r3 !== rid) { const k2 = dense[r3]; if (adj[k * K + k2] === 0) { adj[k * K + k2] = 2; adj[k2 * K + k] = 2; } }
          }
        }
        if (y < h - 1) {
          const r2 = rg[i + w];
          if (r2 !== 0 && r2 !== rid) { const k2 = dense[r2]; adj[k * K + k2] = 1; adj[k2 * K + k] = 1; }
          else if (r2 === 0 && y + 2 < h && tile[i + w] === T.SHALLOW) {
            let r3 = rg[i + 2 * w];
            if (r3 === 0 && tile[i + 2 * w] === T.SHALLOW && y + 3 < h) r3 = rg[i + 3 * w];
            if (r3 !== 0 && r3 !== rid) { const k2 = dense[r3]; if (adj[k * K + k2] === 0) { adj[k * K + k2] = 2; adj[k2 * K + k] = 2; } }
          }
        }
      }
    }
    // centre tile (terrain dependent -> only when asked): walkable & not a slow mountain/snow/lava tile if possible, closest to the centroid
    let bd = null, bi = null;
    if (full) {
      bd = new Float64Array(K * 3).fill(Infinity); bi = new Int32Array(K * 3).fill(-1);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x, rid = rg[i];
          if (rid === 0) continue;
          const k = dense[rid], t = tile[i];
          const cls = t === T.LAVA ? 2 : (t === T.MOUNTAIN || t === T.SNOW) ? 1 : 0;
          const dx = x - sx[k] / cnt[k], dy = y - sy[k] / cnt[k], d2 = dx * dx + dy * dy;
          const q = k * 3 + cls;
          if (d2 < bd[q]) { bd[q] = d2; bi[q] = i; }
        }
      }
    }
    const dead = [];
    bbox.clear();
    for (let k = 0; k < K; k++) {
      const r = regs.get(ids[k]);
      if (cnt[k] === 0) { dead.push(r); continue; }
      r.tiles = cnt[k];
      if (full) {
        let c = bi[k * 3];
        if (c < 0) c = bi[k * 3 + 1]; if (c < 0) c = bi[k * 3 + 2];
        r.cx = c % w; r.cy = (c - r.cx) / w;
        const tn = cnt[k];
        r.terrain = { forest: round(tc[k * 5] / tn, 3), hill: round(tc[k * 5 + 1] / tn, 3), mountain: round(tc[k * 5 + 2] / tn, 3), sand: round(tc[k * 5 + 3] / tn, 3), snow: round(tc[k * 5 + 4] / tn, 3) };
      }
      const nb = [], fd = [];
      for (let k2 = 0; k2 < K; k2++) {
        const a = adj[k * K + k2];
        if (a === 0 || cnt[k2] === 0) continue;
        nb.push(ids[k2]);
        if (a === 2) fd.push(ids[k2]);
      }
      nb.sort((a, b) => a - b); fd.sort((a, b) => a - b);
      r.nb = nb; r.fd = fd;
      bbox.set(r.id, [bx0[k], by0[k], bx1[k], by1[k]]);
    }
    for (let d = 0; d < dead.length; d++) {
      regs.delete(dead[d].id);
      Bus.emit('regionRemoved', dead[d]);
    }
    // cities <-> regions
    for (const r of regs.values()) r.cityIds.length = 0;
    for (const c of S.cities.values()) {
      let rid = rg[c.y * w + c.x];
      if (!rid) rid = nearestRegion(c.x, c.y, 4);
      c.regionId = rid;
      const r = rid ? regs.get(rid) : null;
      if (r) r.cityIds.push(c.id);
    }
    for (const r of regs.values()) {
      if (r.cityIds.length > 1) r.cityIds.sort((a, b) => a - b);
      r.value = round(r.tiles / 60 + 2 * r.cityIds.length, 2);
    }
    // landmass components over nb (fords included): armies can walk them, peaceful expansion only uses land contact
    lmOf.clear();
    let lc = 0;
    const seen = new Uint8Array(K), st = [];
    for (let k = 0; k < K; k++) {
      if (seen[k] || cnt[k] === 0) continue;
      lc++; seen[k] = 1; st.length = 0; st.push(k);
      while (st.length) {
        const a = st.pop();
        lmOf.set(ids[a], lc);
        for (let b = 0; b < K; b++) if (!seen[b] && adj[a * K + b] !== 0 && cnt[b] > 0) { seen[b] = 1; st.push(b); }
      }
    }
    flVer = -1;
  }

  function nearestRegion(x, y, maxR) {
    const w = S.w, h = S.h, rg = S.region;
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const v = rg[yy * w + xx];
          if (v) return v;
        }
      }
    }
    return 0;
  }

  // ================================================================ TERRAIN EDITS (debounced)
  Bus.on('tileChanged', (x, y, o, nw) => {
    const m = S.mod.regions;
    if (!m || !S.region || isLandT(o) === isLandT(nw)) return;
    m.pt1 = S.tick;
    if (m.full) return;
    const i = y * S.w + x;
    const pm = ensureMarks();
    if (pm[i]) return;
    pm[i] = 1;
    if (m.pend.length === 0) m.pt0 = S.tick;
    m.pend.push(i);
    if (m.pend.length > PEND_CAP) { m.full = 1; m.pend.length = 0; pm.fill(0); }
  });

  function growRegion(proto, tiles) {
    const m = mod();
    const id = m.next++;
    const r = newRegion(id, placeName());
    if (proto) {
      r.ownerId = proto.ownerId; r.controllerId = proto.controllerId; r.claims = proto.claims.slice(); r.cores = proto.cores.slice();
      r.since = proto.since; r.occSince = proto.occSince;
    }
    S.regions.set(id, r);
    for (let k = 0; k < tiles.length; k++) S.region[tiles[k]] = id;
    return r;
  }

  /** apply the queued land/water changes to S.region. Cheap (a brush stroke touches a few hundred tiles). */
  function processEdits() {
    const m = mod();
    const w = S.w, h = S.h, n = w * h, rg = S.region, tile = S.tile;
    ensureScratch(n);
    const touched = new Set();
    const work = [];
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    const note = (i) => { const x = i % w, y = (i - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    const visit = (i) => {
      if (!(i >= 0 && i < n)) return;
      const rid = rg[i];
      if (isLandT(tile[i])) { if (rid === 0) work.push(i); }
      else if (rid !== 0) { touched.add(rid); rg[i] = 0; note(i); }
    };
    if (m.full) { for (let i = 0; i < n; i++) visit(i); }
    else { const p = m.pend; for (let j = 0; j < p.length; j++) { visit(p[j]); if (p[j] >= 0 && p[j] < n) note(p[j]); } }
    // new land joins the majority neighbour; the work list grows as tiles get assigned (a new peninsula fills in order)
    for (let q = 0; q < work.length; q++) {
      const i = work[q];
      if (rg[i] !== 0 || !isLandT(tile[i])) continue;
      const x = i % w;
      const a = x > 0 ? rg[i - 1] : 0, b = x < w - 1 ? rg[i + 1] : 0, c = i >= w ? rg[i - w] : 0, d = i < n - w ? rg[i + w] : 0;
      let pick = 0, pc = 0;
      const cand = [a, b, c, d];
      for (let k = 0; k < 4; k++) {
        const v = cand[k];
        if (v === 0) continue;
        let k2 = 0;
        for (let j = 0; j < 4; j++) if (cand[j] === v) k2++;
        if (k2 > pc) { pc = k2; pick = v; }
      }
      if (pick === 0) continue;
      rg[i] = pick; note(i);
      if (x > 0 && rg[i - 1] === 0 && isLandT(tile[i - 1])) work.push(i - 1);
      if (x < w - 1 && rg[i + 1] === 0 && isLandT(tile[i + 1])) work.push(i + 1);
      if (i >= w && rg[i - w] === 0 && isLandT(tile[i - w])) work.push(i - w);
      if (i < n - w && rg[i + w] === 0 && isLandT(tile[i + w])) work.push(i + w);
    }
    // what is left unassigned is an orphan landmass: >= MIN_COMP tiles become a region of their own, specks stay 0
    const stk = qbuf;
    let sid = ++stampCtr;
    const comp = [];
    for (let q = 0; q < work.length; q++) {
      const s = work[q];
      if (rg[s] !== 0 || !isLandT(tile[s]) || stamp[s] === sid) continue;
      comp.length = 0;
      let sp = 0;
      stk[sp++] = s; stamp[s] = sid;
      while (sp > 0) {
        const i = stk[--sp];
        comp.push(i);
        const x = i % w;
        if (x > 0 && rg[i - 1] === 0 && stamp[i - 1] !== sid && isLandT(tile[i - 1])) { stamp[i - 1] = sid; stk[sp++] = i - 1; }
        if (x < w - 1 && rg[i + 1] === 0 && stamp[i + 1] !== sid && isLandT(tile[i + 1])) { stamp[i + 1] = sid; stk[sp++] = i + 1; }
        if (i >= w && rg[i - w] === 0 && stamp[i - w] !== sid && isLandT(tile[i - w])) { stamp[i - w] = sid; stk[sp++] = i - w; }
        if (i < n - w && rg[i + w] === 0 && stamp[i + w] !== sid && isLandT(tile[i + w])) { stamp[i + w] = sid; stk[sp++] = i + w; }
      }
      if (comp.length >= MIN_COMP) { growRegion(null, comp); for (let k = 0; k < comp.length; k++) note(comp[k]); }
    }
    // regions that lost tiles may have been cut in two
    for (const rid of touched) {
      const r = S.regions.get(rid);
      if (!r) continue;
      const bb = bbox.get(rid);
      let ax0 = Math.max(0, (bb ? bb[0] : x0) - 1), ay0 = Math.max(0, (bb ? bb[1] : y0) - 1), ax1 = Math.min(w - 1, (bb ? bb[2] : x1) + 1), ay1 = Math.min(h - 1, (bb ? bb[3] : y1) + 1);
      if (x1 >= 0) { ax0 = Math.min(ax0, x0); ay0 = Math.min(ay0, y0); ax1 = Math.max(ax1, x1); ay1 = Math.max(ay1, y1); }
      sid = ++stampCtr;
      const comps = [];
      for (let y = ay0; y <= ay1; y++) {
        for (let x = ax0; x <= ax1; x++) {
          const s = y * w + x;
          if (rg[s] !== rid || stamp[s] === sid) continue;
          const cl = [];
          let sp = 0;
          stk[sp++] = s; stamp[s] = sid;
          while (sp > 0) {
            const i = stk[--sp];
            cl.push(i);
            const xx = i % w;
            if (xx > 0 && rg[i - 1] === rid && stamp[i - 1] !== sid) { stamp[i - 1] = sid; stk[sp++] = i - 1; }
            if (xx < w - 1 && rg[i + 1] === rid && stamp[i + 1] !== sid) { stamp[i + 1] = sid; stk[sp++] = i + 1; }
            if (i >= w && rg[i - w] === rid && stamp[i - w] !== sid) { stamp[i - w] = sid; stk[sp++] = i - w; }
            if (i < n - w && rg[i + w] === rid && stamp[i + w] !== sid) { stamp[i + w] = sid; stk[sp++] = i + w; }
          }
          comps.push(cl);
        }
      }
      if (comps.length < 2) continue;
      let bi = 0;
      for (let k = 1; k < comps.length; k++) if (comps[k].length > comps[bi].length) bi = k;
      for (let k = 0; k < comps.length; k++) {
        if (k === bi) continue;
        const cl = comps[k];
        if (cl.length >= MIN_COMP) { growRegion(r, cl); continue; }
        // a small cut-off piece joins the region it touches most, else becomes unassigned land
        const votes = new Map();
        for (let j = 0; j < cl.length; j++) {
          const i = cl[j], xx = i % w;
          const nbs = [xx > 0 ? rg[i - 1] : 0, xx < w - 1 ? rg[i + 1] : 0, i >= w ? rg[i - w] : 0, i < n - w ? rg[i + w] : 0];
          for (let q = 0; q < 4; q++) if (nbs[q] !== 0 && nbs[q] !== rid) votes.set(nbs[q], (votes.get(nbs[q]) || 0) + 1);
        }
        let pick = 0, pc = 0;
        for (const [v, c] of votes) if (c > pc) { pc = c; pick = v; }
        for (let j = 0; j < cl.length; j++) { rg[cl[j]] = pick; note(cl[j]); }
      }
    }
    // done: clear the queue, refresh the derived data, give cities near the edit a fresh sphere
    const p = m.pend;
    const pm = ensureMarks();
    for (let j = 0; j < p.length; j++) if (p[j] >= 0 && p[j] < n) pm[p[j]] = 0;
    if (m.full) pm.fill(0);
    p.length = 0; m.full = 0;
    computeStats(true);
    S.touchRegions();
    if (x1 >= 0) {
      for (const c of S.cities.values()) {
        const pad = (c.radius || 8) + 2;
        if (c.x >= x0 - pad && c.x <= x1 + pad && c.y >= y0 - pad && c.y <= y1 + pad) recomputeCity(c.id);
      }
    }
  }

  // ================================================================ OWNERSHIP
  function removeFrom(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); return i >= 0; }

  function recomputeCity(id, full) {
    if (typeof Cities === 'undefined' || Cities.__stub || !Cities.recomputeTerritory) return;
    Cities.recomputeTerritory(id, !full);
  }
  /** territories of the cities whose sphere can reach the region */
  function recomputeAround(r) {
    const bb = bbox.get(r.id);
    for (const c of S.cities.values()) {
      const pad = (c.radius || 8) + 2;
      if (bb && (c.x < bb[0] - pad || c.x > bb[2] + pad || c.y < bb[1] - pad || c.y > bb[3] + pad)) continue;
      recomputeCity(c.id);
    }
  }

  /** occupation flags of the cities inside the region follow the controller */
  function syncCities(r) {
    if (typeof Cities === 'undefined' || Cities.__stub || !Cities.occupy) return;
    for (let i = 0; i < r.cityIds.length; i++) {
      const c = S.cities.get(r.cityIds[i]);
      if (!c) continue;
      const want = (r.controllerId !== 0 && r.controllerId !== r.ownerId && r.controllerId !== c.kingdomId) ? r.controllerId : 0;
      if (want !== 0) { if (c.occupierId !== want) Cities.occupy(c.id, want); }
      else if (c.occupierId) Cities.liberate(c.id);
    }
  }

  function addClaim(rid, kid) {
    const r = get(rid);
    kid = kid | 0;
    if (!r || !aliveK(kid) || r.ownerId === kid || r.claims.indexOf(kid) >= 0) return false;
    r.claims.push(kid);
    if (r.claims.length > 6) r.claims.shift();
    S.touchRegions();
    return true;
  }
  function hasClaim(rid, kid) { const r = get(rid); return !!r && r.claims.indexOf(kid | 0) >= 0; }
  function claimsOf(kid) {
    const out = [];
    kid = kid | 0;
    for (const r of S.regions.values()) if (r.claims.indexOf(kid) >= 0) out.push(r.id);
    return out;
  }

  /** legal owner of the region (peace deal, expansion, god, annexation). Resets the controller to the new owner. */
  function setOwner(rid, kid, why) {
    const r = get(rid);
    if (!r) return false;
    kid = kid | 0;
    if (kid < 0 || (kid > 0 && !aliveK(kid))) return false;
    const old = r.ownerId, oldC = r.controllerId;
    if (old === kid && oldC === kid) return false;
    r.ownerId = kid; r.controllerId = kid;
    r.occSince = 0;
    if (old !== kid) {
      r.since = S.tick;
      if (old && aliveK(old)) addClaim(rid, old);
      if (kid) removeFrom(r.claims, kid);
    }
    S.touchRegions();
    flVer = -1;
    syncCities(r);
    recomputeAround(r);
    if (old !== kid) Bus.emit('regionOwner', r, old, kid, why);
    if (oldC !== kid) Bus.emit('regionControl', r, oldC, kid, why);
    return true;
  }

  /** who holds the region right now (War). kid 0 / the owner = back to normal. */
  function setController(rid, kid, why) {
    const r = get(rid);
    if (!r) return false;
    kid = kid | 0;
    if (kid <= 0) kid = r.ownerId;
    if (kid > 0 && !aliveK(kid)) return false;
    const old = r.controllerId;
    if (old === kid) return false;
    r.controllerId = kid;
    r.occSince = (kid !== r.ownerId && kid !== 0) ? S.tick : 0;
    S.touchRegions();
    flVer = -1;
    syncCities(r);
    Bus.emit('regionControl', r, old, kid, why);
    return true;
  }

  // ---------------------------------------------------------------- city hooks
  function regionIdOfCity(city) {
    let rid = at(city.x, city.y);
    if (!rid) rid = nearestRegion(city.x, city.y, 4);
    return rid;
  }
  /** call after the city has its kingdom. Idempotent. Unowned region -> the city's kingdom takes it. */
  function onCityFounded(city) {
    if (!city || !active()) return false;
    const rid = regionIdOfCity(city);
    city.regionId = rid;
    const r = get(rid);
    if (!r) return false;
    if (r.cityIds.indexOf(city.id) < 0) {
      r.cityIds.push(city.id);
      if (r.cityIds.length > 1) r.cityIds.sort((a, b) => a - b);
      r.value = round(r.tiles / 60 + 2 * r.cityIds.length, 2);
      S.touchRegions();
    }
    if ((r.ownerId === 0 || !aliveK(r.ownerId)) && aliveK(city.kingdomId)) setOwner(rid, city.kingdomId, 'city');
    else syncCities(r);
    return true;
  }
  function onCityRemoved(city) {
    if (!city || !S.regions) return false;
    let found = false;
    for (const r of S.regions.values()) {
      const i = r.cityIds.indexOf(city.id);
      if (i < 0) continue;
      r.cityIds.splice(i, 1);
      r.value = round(r.tiles / 60 + 2 * r.cityIds.length, 2);
      found = true;
    }
    if (found) S.touchRegions();
    return found;
  }
  /** the city changed kingdom: the region follows it when the city was the last one of the old owner in that region */
  function onCityTransferred(city, oldKid, newKid) {
    if (!city || !active()) return false;
    if (!city.regionId || !get(city.regionId)) onCityFounded(city);
    const r = get(city.regionId);
    if (!r) return false;
    if (city.occupierId && city.occupierId === newKid && typeof Cities !== 'undefined' && Cities.liberate) Cities.liberate(city.id);
    if (aliveK(newKid) && r.ownerId !== newKid && (r.ownerId === oldKid || r.ownerId === 0)) {
      let remaining = 0;
      for (let i = 0; i < r.cityIds.length; i++) {
        const o = S.cities.get(r.cityIds[i]);
        if (o && o.id !== city.id && o.kingdomId === oldKid && oldKid) remaining++;
      }
      if (remaining === 0) setOwner(r.id, newKid, 'transfer');
    }
    syncCities(r);
    recomputeCity(city.id, true);
    return true;
  }

  // a fallen kingdom releases its land (immediately: nothing may keep pointing at a dead id)
  function releaseKingdom(kid) {
    if (!S.regions || !kid) return;
    for (const r of S.regions.values()) {
      if (r.ownerId === kid) setOwner(r.id, 0, 'fall');
      else if (r.controllerId === kid) setController(r.id, r.ownerId, 'fall');
      removeFrom(r.claims, kid); removeFrom(r.cores, kid);
    }
    delete mod().cd[kid];
  }
  Bus.on('kingdomDestroyed', (k) => { if (k && S.regions && S.regions.size) releaseKingdom(k.id); });

  // ================================================================ QUERIES
  function ownerAt(x, y) { const rid = at(x, y); if (!rid) return 0; const r = S.regions.get(rid); return r ? r.ownerId : 0; }
  function controllerAt(x, y) { const rid = at(x, y); if (!rid) return 0; const r = S.regions.get(rid); return r ? r.controllerId : 0; }
  function ofKingdom(kid) { const out = []; kid = kid | 0; for (const r of S.regions.values()) if (r.ownerId === kid) out.push(r); return out; }
  function controlledBy(kid) { const out = []; kid = kid | 0; for (const r of S.regions.values()) if (r.controllerId === kid) out.push(r); return out; }
  function isNeighbor(a, b) { const r = get(a); return !!r && r.nb.indexOf(b | 0) >= 0; }
  function landmass(rid) { return lmOf.get(rid) || 0; }

  function warBetween(ka, kb) {
    for (const w of S.wars.values()) {
      if (w.ended) continue;
      if ((w.attackers.indexOf(ka) >= 0 && w.defenders.indexOf(kb) >= 0) || (w.attackers.indexOf(kb) >= 0 && w.defenders.indexOf(ka) >= 0)) return w.id;
    }
    return 0;
  }
  function warSig() {
    let s = 0;
    for (const w of S.wars.values()) if (!w.ended) s = (Math.imul(s, 31) + w.id * 7 + w.attackers.length * 3 + w.defenders.length) | 0;
    return s;
  }
  function atWar(a, b) { return typeof War !== 'undefined' && War && War.atWar ? !!War.atWar(a, b) : false; }

  /** adjacent region pairs whose controllers are at war. Cached; rebuilt only when regions / wars change (deterministic). */
  function frontlines() {
    if (!S.regions) return flCache;
    const sig = warSig();
    if (flVer === S.regionVer && flSig === sig) return flCache;
    flVer = S.regionVer; flSig = sig;
    const out = [];
    if (sig !== 0 || S.wars.size) {
      for (const a of S.regions.values()) {
        const ka = a.controllerId;
        if (!ka) continue;
        for (let i = 0; i < a.nb.length; i++) {
          const bid = a.nb[i];
          if (bid <= a.id) continue;
          const b = S.regions.get(bid);
          if (!b) continue;
          const kb = b.controllerId;
          if (!kb || kb === ka || !atWar(ka, kb)) continue;
          out.push({ a: a.id, b: bid, ka, kb, war: warBetween(ka, kb) });
        }
      }
    }
    flCache = out;
    return flCache;
  }

  const armyRegs = new Set();
  /** enemy-owned regions the attacker can march into now: adjacent to land it controls (or armies it has there), same landmass */
  function attackable(ka, kd) {
    const out = [];
    ka = ka | 0; kd = kd | 0;
    if (!ka || !kd || ka === kd || !S.regions) return out;
    armyRegs.clear();
    for (const a of S.armies.values()) {
      if (a.kingdomId !== ka || !a.rally) continue;
      const rid = at(a.rally.x, a.rally.y);
      if (rid) armyRegs.add(rid);
    }
    let allies = null;
    if (typeof Diplomacy !== 'undefined' && Diplomacy && Diplomacy.alliesOf) { try { allies = Diplomacy.alliesOf(ka); } catch (e) { allies = null; } }
    const mine = (r) => r.controllerId === ka || armyRegs.has(r.id) || (allies && allies.length > 0 && r.controllerId !== 0 && allies.indexOf(r.controllerId) >= 0);
    for (const r of S.regions.values()) {
      if (r.ownerId !== kd) continue;
      let ok = mine(r);
      for (let i = 0; i < r.nb.length && !ok; i++) { const b = S.regions.get(r.nb[i]); if (b && mine(b)) ok = true; }
      if (ok) out.push(r.id);
    }
    return out;
  }

  // ================================================================ STEP
  function expansionPass(tick) {
    const m = mod();
    const regs = S.regions;
    for (const k of S.kingdoms.values()) {
      if (k.alive === false) continue;
      const until = m.cd[k.id];
      if (until && tick < until) continue;
      if (k.stability !== undefined && k.stability < 35) continue;
      let owned = 0;
      for (const r of regs.values()) if (r.ownerId === k.id) owned++;
      if (owned === 0) continue;
      const kc = k.cities || [];
      let pop = 0;
      for (let i = 0; i < kc.length; i++) { const c = S.cities.get(kc[i]); if (c) pop += c.pop || 0; }
      if (pop < POP_PER_REGION * owned) continue;
      const rc = Races.list[k.race] || Races.list[0];
      if (!R.chance(0.22 * (rc.expansion || 1))) continue;
      // wild regions touching our land (not over a ford) with one of our cities close to their centre
      let bestR = null, tot = 0;
      const cands = [], wts = [];
      for (const o of regs.values()) {
        if (o.ownerId !== k.id) continue;
        for (let i = 0; i < o.nb.length; i++) {
          const b = regs.get(o.nb[i]);
          if (!b || b.ownerId !== 0 || o.fd.indexOf(b.id) >= 0 || cands.indexOf(b) >= 0) continue;
          let d = 1e9;
          for (let j = 0; j < kc.length; j++) {
            const c = S.cities.get(kc[j]);
            if (!c) continue;
            const dd = Util.dist(c.x, c.y, b.cx, b.cy);
            if (dd < d) d = dd;
          }
          if (d > EXPAND_RANGE) continue;
          const bad = b.terrain.mountain + b.terrain.snow;
          const wt = (1.2 - d / (EXPAND_RANGE + 2)) * (1 - 0.75 * Math.min(1, bad * 1.4)) * (0.5 + Math.min(1, b.tiles / 60));
          if (wt <= 0.02) continue;
          cands.push(b); wts.push(wt); tot += wt;
        }
      }
      if (!cands.length) { m.cd[k.id] = tick + 120; continue; }
      let pick = R.f() * tot;
      for (let i = 0; i < cands.length; i++) { pick -= wts[i]; if (pick <= 0) { bestR = cands[i]; break; } }
      if (!bestR) bestR = cands[cands.length - 1];
      if (setOwner(bestR.id, k.id, 'expand')) {
        m.cd[k.id] = tick + 300 + 25 * owned + R.i(120);
        Hist.add(k, 'Освоен регион «' + bestR.name + '»');
        if (owned + 1 === 2 || (owned + 1) % 3 === 0) {
          Log.add('Королевство «' + k.name + '» расширило границы: регион «' + bestR.name + '»', Const.LOG.INFO, bestR.cx, bestR.cy, k.id);
        }
      }
    }
  }

  function upkeep(tick) {
    const m = mod();
    for (const r of S.regions.values()) {
      if (r.ownerId && !aliveK(r.ownerId)) setOwner(r.id, 0, 'fall');
      if (r.controllerId && r.controllerId !== r.ownerId && !aliveK(r.controllerId)) setController(r.id, r.ownerId, 'fall');
      for (let i = r.claims.length - 1; i >= 0; i--) if (!aliveK(r.claims[i]) || r.claims[i] === r.ownerId) r.claims.splice(i, 1);
      for (let i = r.cores.length - 1; i >= 0; i--) if (!aliveK(r.cores[i])) r.cores.splice(i, 1);
      if (r.ownerId && r.cores.indexOf(r.ownerId) < 0 && tick - r.since >= Const.TICKS_PER_YEAR) r.cores.push(r.ownerId);
    }
    for (const id in m.cd) if (!aliveK(+id)) delete m.cd[id];
  }

  function step(tick) {
    if (tick === undefined) tick = S.tick;
    const m = S.mod.regions;
    if (!m || !S.region || !S.regions) return;
    if ((m.pend.length > 0 || m.full) && (tick - m.pt1 >= QUIET || tick - m.pt0 >= MAXWAIT)) processEdits();
    if (tick % 30 === 7) expansionPass(tick);
    if (tick % 60 === 23) upkeep(tick);
    if (tick % 600 === 0) computeStats(true);              // centres / terrain fractions follow terrain painted by the god (no overlay change)
  }

  // ================================================================ LIFECYCLE
  function resetCaches() {
    bbox.clear(); lmOf.clear(); pmark = null; scratchN = 0; qbuf = null; stamp = null; stampCtr = 0;
    flCache = []; flVer = -1; flSig = 0;
  }
  function newWorld() {
    resetCaches();
    if (!S.mod.regions || !S.regions || S.regions.size === 0) build();
  }

  /** stage-1 save (no regions): build them and let every kingdom keep the ground its cities already dominated */
  function migrate() {
    build();
    for (const c of S.cities.values()) {
      const r = get(c.regionId);
      if (r && r.ownerId === 0 && aliveK(c.kingdomId)) { r.ownerId = c.kingdomId; r.controllerId = c.kingdomId; r.since = S.tick; }
    }
    // regions mostly covered by one kingdom's old city spheres
    const tally = new Map();
    for (const r of S.regions.values()) if (r.ownerId === 0) tally.set(r.id, new Map());
    if (tally.size) {
      for (let i = 0, n = S.w * S.h; i < n; i++) {
        const rid = S.region[i], o = S.owner[i];
        if (!rid || !o) continue;
        const t = tally.get(rid);
        if (!t) continue;
        const c = S.cities.get(o);
        if (c && c.kingdomId) t.set(c.kingdomId, (t.get(c.kingdomId) || 0) + 1);
      }
      for (const [rid, t] of tally) {
        const r = S.regions.get(rid);
        let bk = 0, bc = 0;
        for (const [kid, c] of t) if (c > bc) { bc = c; bk = kid; }
        if (bk && bc >= r.tiles * 0.4 && aliveK(bk)) { r.ownerId = bk; r.controllerId = bk; r.since = S.tick; }
      }
    }
    for (const c of S.cities.values()) recomputeCity(c.id);
    S.touchRegions();
  }

  function afterLoad() {
    resetCaches();
    if (!S.regions) S.regions = new Map();
    const n = S.w * S.h;
    if (!S.tile) return;
    if (!S.region || S.region.length !== n) S.region = new Int32Array(n);
    let anyLand = false;
    for (let i = 0; i < n; i++) if (isLandT(S.tile[i])) { anyLand = true; break; }
    if (!S.mod.regions || S.regions.size === 0) {
      if (anyLand) migrate(); else mod();
      return;
    }
    const m = mod();
    // normalise entities (hand-edited / older saves): every field the code relies on
    for (const r of S.regions.values()) {
      if (!Array.isArray(r.cityIds)) r.cityIds = [];
      if (!Array.isArray(r.nb)) r.nb = [];
      if (!Array.isArray(r.fd)) r.fd = [];
      if (!Array.isArray(r.claims)) r.claims = [];
      if (!Array.isArray(r.cores)) r.cores = [];
      if (!r.terrain || typeof r.terrain !== 'object') r.terrain = { forest: 0, hill: 0, mountain: 0, sand: 0, snow: 0 };
      r.ownerId = r.ownerId | 0; r.controllerId = r.controllerId | 0;
      if (r.ownerId && !r.controllerId) r.controllerId = r.ownerId;
      if (typeof r.since !== 'number') r.since = 0;
      if (typeof r.occSince !== 'number') r.occSince = 0;
      if (typeof r.name !== 'string') r.name = placeName();
      if (!(r.cx >= 0 && r.cx < S.w && r.cy >= 0 && r.cy < S.h)) { r.cx = Math.min(S.w - 1, Math.max(0, r.cx | 0)); r.cy = Math.min(S.h - 1, Math.max(0, r.cy | 0)); }
    }
    // a pending edit queue must survive: re-arm the de-dup marks, drop junk, and notice a layer that disagrees with the terrain
    const pm = ensureMarks();
    const keep = [];
    for (let j = 0; j < m.pend.length; j++) { const i = m.pend[j]; if (i >= 0 && i < n && !pm[i]) { pm[i] = 1; keep.push(i); } }
    m.pend = keep;
    if (!m.full && m.pend.length === 0) {                // (a non-empty queue already covers the tiles that disagree)
      for (let i = 0; i < n; i++) if (S.region[i] !== 0 && !isLandT(S.tile[i])) { m.full = 1; m.pt0 = m.pt1 = S.tick - MAXWAIT; break; }
    }
    computeStats(false);
    S.touchRegions();
  }

  return {
    build, newWorld, afterLoad, step,
    get, at, ownerAt, controllerAt, setOwner, setController, addClaim, hasClaim, claimsOf,
    list() { return S.regions ? Array.from(S.regions.values()) : []; },
    neighbors(rid) { const r = get(rid); return r ? r.nb : []; },
    centroid(rid) { const r = get(rid); return r ? { x: r.cx, y: r.cy } : null; },
    ofKingdom, controlledBy,
    cityCount(rid) { const r = get(rid); if (!r) return 0; let n = 0; for (let i = 0; i < r.cityIds.length; i++) if (S.cities.has(r.cityIds[i])) n++; return n; },
    frontlines, attackable,
    onCityFounded, onCityRemoved, onCityTransferred,
    // extras
    isNeighbor, landmass, sameLandmass(a, b) { const x = lmOf.get(a); return !!x && x === lmOf.get(b); },
    active, computeStats, processEdits, releaseKingdom,
    /** apply queued terrain edits right now (callers that need an up-to-date S.region, e.g. founding a village on freshly raised land) */
    flush() { const m = S.mod.regions; if (m && S.region && S.regions && (m.pend.length > 0 || m.full)) { processEdits(); return true; } return false; },
    bbox(rid) { const b = bbox.get(rid); return b ? { x0: b[0], y0: b[1], x1: b[2], y1: b[3] } : null; },
    get pending() { const m = S.mod.regions; return m ? (m.full ? -1 : m.pend.length) : 0; },
    MIN_COMP, MIN_FRAG,
  };
})();
