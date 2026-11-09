// World module tests (plain node + assert).   node tests/world.test.mjs
// Isolates World from every other sim module (Buildings/Units are replaced by recording test doubles).
import assert from 'node:assert/strict';
import { loadSim, pad } from './harness.mjs';

const STUBS = ['Buildings', 'Cities', 'Units', 'Kingdoms', 'Diplomacy', 'War', 'Powers', 'Sim', 'Save'];

// ------------------------------------------------------------------ harness bits
const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 58)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 6).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

function mkCtx() {
  const ctx = loadSim({ stub: STUBS });
  const calls = { units: 0, unitsLog: [], bld: 0, bldLog: [], destroy: 0, destroyLog: [], record: false };
  const fake = new Map();             // id -> {type, flam}
  ctx.fakeBuildings = fake;
  ctx.calls = calls;
  ctx.Units.damageAt = (x, y, d, c) => { calls.units++; if (calls.record) calls.unitsLog.push([x, y, d, c]); return 0; };
  ctx.Buildings.get = (id) => fake.get(id) || null;
  ctx.Buildings.damageAt = (x, y, d, c) => { calls.bld++; if (calls.record) calls.bldLog.push([x, y, d, c]); return false; };
  ctx.Buildings.destroyAt = (x, y, c) => {
    calls.destroy++; if (calls.record) calls.destroyLog.push([x, y, c]);
    const i = y * ctx.S.w + x; if (ctx.S.bld[i]) { fake.delete(ctx.S.bld[i]); ctx.S.bld[i] = 0; }
    return true;
  };
  return ctx;
}
function addBuilding(ctx, x, y, flam = 0.8) {
  const id = ctx.S.id(); ctx.fakeBuildings.set(id, { id, type: 1, flam }); ctx.S.bld[y * ctx.S.w + x] = id; return id;
}
/** blank controlled world filled with one tile type */
function blank(ctx, w, h, t = ctx.Const.T.DEEP, seed = 1) {
  const { S, Tiles, World } = ctx;
  S.reset(w, h, seed);
  S.tile.fill(t); S.elev.fill(Tiles.midElev(t));
  World.newWorld();
  return S;
}
function fillRect(ctx, x0, y0, x1, y1, t) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ctx.World.setTile(x, y, t);
}
function count(ctx, t) { let c = 0; const a = ctx.S.tile; for (let i = 0; i < a.length; i++) if (a[i] === t) c++; return c; }
function tick(ctx, n) { for (let k = 0; k < n; k++) { ctx.S.tick++; ctx.World.step(ctx.S.tick); } }
function hashLayers(ctx) {
  const { S } = ctx; let h = 2166136261;
  for (const a of [S.tile, S.elev, S.res, S.amt, S.fire]) for (let i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
function largestLand(ctx) {      // 4-connected components of land tiles
  const { S, Tiles } = ctx; const n = S.w * S.h; const seen = new Uint8Array(n); const st = new Int32Array(n); let best = 0;
  for (let s = 0; s < n; s++) {
    if (seen[s] || !Tiles.isLand(S.tile[s])) continue;
    let sp = 0, size = 0; st[sp++] = s; seen[s] = 1;
    while (sp) {
      const i = st[--sp]; size++; const x = i % S.w, y = (i / S.w) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < S.w - 1 ? i + 1 : -1, y > 0 ? i - S.w : -1, y < S.h - 1 ? i + S.w : -1];
      for (const j of nb) if (j >= 0 && !seen[j] && Tiles.isLand(S.tile[j])) { seen[j] = 1; st[sp++] = j; }
    }
    if (size > best) best = size;
  }
  return best;
}

console.log('World tests');

// ====================================================================================================
// A. GENERATION
// ====================================================================================================
section('generation: 20 seeds @96 (land %, landmass, bands, resources, border, validity)', () => {
  const ctx = mkCtx(); const { S, World, Tiles, Const } = ctx; const T = Const.T, RES = Const.RES;
  World.generate({ seed: 1000, w: 96, h: 96 });   // warm-up
  const times = []; let bigOK = 0; const landPct = [], forestPct = [], berryPct = [];
  let goldSeeds = 0, ironSeeds = 0, rockSeeds = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const t0 = performance.now(); World.generate({ seed, w: 96, h: 96 }); times.push(performance.now() - t0);
    assert.equal(S.w, 96); assert.equal(S.h, 96); assert.equal(S.seed, seed);
    assert.ok(S.allDirty && S.landDirty, 'dirty flags');
    const n = S.w * S.h; const c = new Array(Const.TILE_COUNT).fill(0);
    let grass = 0, berries = 0, golds = 0, irons = 0, rocks = 0;
    for (let i = 0; i < n; i++) {
      const t = S.tile[i], e = S.elev[i];
      assert.ok(t < Const.TILE_COUNT, 'valid tile id');
      assert.ok(Number.isFinite(e) && e >= 0 && e <= 255, 'elev finite');
      if (t === T.FOREST) { assert.ok(e >= 112 && e < 160, `forest elev ${e}`); assert.ok(S.amt[i] >= 80 && S.amt[i] <= 200, 'forest amt'); assert.equal(S.res[i], 0); }
      else assert.equal(t, Tiles.fromElev(e), `tile/elev mismatch at ${i}`);
      c[t]++;
      const rk = S.res[i];
      if (rk) {
        const a = S.amt[i];
        if (rk === RES.TREE) { assert.equal(t, T.GRASS); assert.ok(a >= 10 && a <= 60); }
        else if (rk === RES.BERRY) { assert.equal(t, T.GRASS); assert.ok(a >= 30 && a <= 120); berries++; }
        else if (rk === RES.ROCK) { assert.ok(t === T.GRASS || t === T.HILL || t === T.MOUNTAIN); assert.ok(a >= 30); rocks++; }
        else if (rk === RES.IRON) { assert.ok(t === T.HILL || t === T.MOUNTAIN, 'iron tile'); irons++; }
        else if (rk === RES.GOLD) { assert.equal(t, T.MOUNTAIN === t ? T.MOUNTAIN : t, ''); assert.ok(t === T.MOUNTAIN || t === T.HILL); golds++; }
        else assert.fail('unexpected res ' + rk);
      } else if (t !== T.FOREST) assert.equal(S.amt[i], 0);
      assert.equal(S.owner[i], 0); assert.equal(S.bld[i], 0); assert.equal(S.fire[i], 0);
    }
    const land = n - c[T.DEEP] - c[T.SHALLOW] - c[T.LAVA];
    const lp = land / n; landPct.push(lp);
    assert.ok(lp >= 0.33 && lp <= 0.50, `seed ${seed}: land fraction ${lp.toFixed(3)}`);
    forestPct.push(c[T.FOREST] / land); grass = c[T.GRASS] + c[T.FOREST]; berryPct.push(berries / Math.max(1, c[T.GRASS]));
    assert.ok(c[T.FOREST] / land >= 0.10 && c[T.FOREST] / land <= 0.24, `seed ${seed}: forest share ${(c[T.FOREST] / land).toFixed(3)}`);
    assert.ok(c[T.SAND] > 60, 'beaches exist'); assert.ok(c[T.SHALLOW] > 150, 'shallow ring exists'); assert.ok(c[T.HILL] > 100, 'hills'); assert.ok(c[T.MOUNTAIN] > 50, 'mountains');
    assert.ok(c[T.SNOW] > 0 && c[T.SNOW] < land * 0.06, 'snow caps are small clusters: ' + c[T.SNOW]);
    assert.ok(c[T.MOUNTAIN] + c[T.SNOW] < land * 0.16, 'peaks do not cover half the land');
    assert.ok(c[T.GRASS] > land * 0.35, 'grass is the widest band');
    assert.equal(c[T.LAVA], 0);
    if (largestLand(ctx) >= 700) bigOK++;
    if (golds) goldSeeds++; if (irons) ironSeeds++; if (rocks) rockSeeds++;
    // border is water
    for (let k = 0; k < 96; k++) for (const [x, y] of [[k, 0], [k, 1], [k, 94], [k, 95], [0, k], [1, k], [94, k], [95, k]]) assert.ok(Tiles.isWater(S.tile[y * 96 + x]), 'border water');
  }
  assert.ok(bigOK >= 18, `landmass >= 700 tiles in ${bigOK}/20 seeds`);
  assert.equal(goldSeeds, 20); assert.equal(ironSeeds, 20); assert.equal(rockSeeds, 20);
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const berry = avg(berryPct);
  assert.ok(berry > 0.008 && berry < 0.04, 'berry share of grass ' + berry);
  times.sort((a, b) => a - b);
  assert.ok(times[times.length - 1] < 150, 'generation max ' + times[times.length - 1]);
  note(`land% min/avg/max ${(100 * Math.min(...landPct)).toFixed(1)}/${(100 * avg(landPct)).toFixed(1)}/${(100 * Math.max(...landPct)).toFixed(1)}  forest%land avg ${(100 * avg(forestPct)).toFixed(1)}  berries%grass ${(100 * berry).toFixed(2)}  big landmass ${bigOK}/20`);
  note(`gen 96x96 ms: median ${times[10].toFixed(1)} max ${times[19].toFixed(1)}`);
});

section('generation: 128x128 timing + 64x64 + non-square', () => {
  const ctx = mkCtx(); const { S, World, Tiles } = ctx;
  World.generate({ seed: 5, w: 128, h: 128 });
  const ts = [];
  for (let seed = 1; seed <= 10; seed++) { const t0 = performance.now(); World.generate({ seed, w: 128, h: 128 }); ts.push(performance.now() - t0); assert.equal(S.tile.length, 128 * 128); }
  ts.sort((a, b) => a - b);
  assert.ok(ts[9] < 300, 'gen 128 max ' + ts[9]);
  note(`gen 128x128 ms: median ${ts[5].toFixed(1)} max ${ts[9].toFixed(1)}`);
  for (const [w, h] of [[64, 64], [80, 112], [128, 96]]) {
    World.generate({ seed: 9, w, h });
    assert.equal(S.w, w); assert.equal(S.h, h);
    let land = 0; for (let i = 0; i < S.tile.length; i++) if (Tiles.isLand(S.tile[i])) land++;
    assert.ok(land / S.tile.length > 0.30 && land / S.tile.length < 0.52, `${w}x${h} land ${land / S.tile.length}`);
  }
});

section('generation: many sizes and seeds never throw and stay in the land-fraction band', () => {
  const ctx = mkCtx(); const { S, World, Tiles } = ctx; let n = 0; let minLand = 1, maxLand = 0;
  for (const [w, h] of [[32, 32], [48, 48], [64, 64], [96, 96], [112, 80], [128, 128], [160, 160]]) {
    for (let seed = 100; seed < 100 + (w >= 128 ? 4 : 10); seed++) {
      World.generate({ seed, w, h }); n++;
      let land = 0; for (let i = 0; i < S.tile.length; i++) if (Tiles.isLand(S.tile[i])) land++;
      const f = land / S.tile.length; minLand = Math.min(minLand, f); maxLand = Math.max(maxLand, f);
      assert.ok(f > 0.30 && f < 0.52, `${w}x${h} seed ${seed}: land ${f.toFixed(3)}`);
      assert.ok(largestLand(ctx) >= Math.min(700, 0.05 * w * h), `${w}x${h} seed ${seed}: largest landmass ${largestLand(ctx)}`);
    }
  }
  assert.doesNotThrow(() => { World.generate({}); World.generate({ seed: 0, w: 40, h: 40 }); World.generate({ seed: -5, w: 40, h: 40 }); World.generate({ seed: 2 ** 31 + 5, w: 40, h: 40 }); });
  note(`${n} worlds, land ${(100 * minLand).toFixed(1)}%..${(100 * maxLand).toFixed(1)}%`);
});

section('generation: deterministic per seed, different across seeds, does not consume R', () => {
  const a = mkCtx(), b = mkCtx();
  a.World.generate({ seed: 77, w: 96, h: 96 }); b.World.generate({ seed: 77, w: 96, h: 96 });
  assert.equal(hashLayers(a), hashLayers(b));
  const h1 = hashLayers(a);
  a.World.generate({ seed: 78, w: 96, h: 96 });
  assert.notEqual(hashLayers(a), h1);
  a.World.generate({ seed: 77, w: 96, h: 96 });
  assert.equal(hashLayers(a), h1);
  assert.equal(a.R.getState(), (() => { const c = mkCtx(); c.S.reset(96, 96, 77); return c.R.getState(); })(), 'generate leaves R at its seeded state');
  // no NaN / Infinity anywhere across several sizes
  for (const sz of [48, 96, 128]) { a.World.generate({ seed: 31337, w: sz, h: sz }); for (const arr of [a.S.tile, a.S.elev, a.S.res, a.S.amt]) for (let i = 0; i < arr.length; i++) assert.ok(Number.isFinite(arr[i])); }
});

// ====================================================================================================
// B. BRUSHES
// ====================================================================================================
function findArea(ctx, pred, r = 6) {       // a centre whose (2r+1)^2 box satisfies pred for every tile
  const { S } = ctx;
  for (let y = r + 1; y < S.h - r - 1; y += 2) for (let x = r + 1; x < S.w - r - 1; x += 2) {
    let ok = true;
    for (let yy = y - r; yy <= y + r && ok; yy++) for (let xx = x - r; xx <= x + r; xx++) if (!pred(S.tile[yy * S.w + xx], yy * S.w + xx)) { ok = false; break; }
    if (ok) return [x, y];
  }
  return null;
}

section('brush: raise / lower (elev, retype, forest band, lava rules, falloff)', () => {
  const ctx = mkCtx(); const { S, World, Tiles, Const } = ctx; const T = Const.T;
  blank(ctx, 40, 40, T.GRASS);
  // raise on flat grass (elev 136): centre gains more than the rim; returns > 0
  const e0 = S.elev[20 * 40 + 20];
  const n1 = World.brush('raise', 20, 20, 5);
  assert.ok(n1 > 40, 'raise changed tiles ' + n1);
  const c = S.elev[20 * 40 + 20];
  assert.ok(c >= e0 + 8 && c <= e0 + 28, `centre delta ${c - e0}`);
  let core = 0, cn = 0, rim = 0, rn = 0;
  for (let y = 14; y <= 26; y++) for (let x = 14; x <= 26; x++) { const d = Math.hypot(x - 20, y - 20), de = S.elev[y * 40 + x] - e0; if (d <= 2) { core += de; cn++; } else if (d >= 4.2 && d <= 5.5) { rim += de; rn++; } }
  assert.ok(core / cn > rim / rn + 6, `soft edge: core avg +${(core / cn).toFixed(1)} rim avg +${(rim / rn).toFixed(1)}`);
  for (let i = 0; i < S.tile.length; i++) if (S.tile[i] !== T.FOREST) assert.equal(S.tile[i], Tiles.fromElev(S.elev[i]));
  // repeated raise -> hills -> mountains -> snow in the middle
  for (let k = 0; k < 12; k++) World.brush('raise', 20, 20, 5);
  assert.equal(S.tile[20 * 40 + 20], T.SNOW);
  assert.equal(S.elev[20 * 40 + 20] <= 255, true);
  // lower back down to deep water (and more)
  for (let k = 0; k < 30; k++) World.brush('lower', 20, 20, 5);
  assert.equal(S.tile[20 * 40 + 20], T.DEEP);
  assert.ok(S.landDirty);
  // raise from the sea floor creates land
  blank(ctx, 40, 40, T.DEEP);
  let steps = 0; while (S.tile[20 * 40 + 20] !== T.GRASS && steps++ < 40) World.brush('raise', 20, 20, 4);
  assert.ok(steps < 20, 'sea -> grass in ' + steps + ' strokes');
  // raise keeps forests in the grass band, removes them above the band
  blank(ctx, 40, 40, T.GRASS); fillRect(ctx, 10, 10, 30, 30, T.FOREST);
  S.elev.fill(120);
  World.brush('raise', 20, 20, 3);                     // 120 + 8..28 stays < 160
  assert.equal(S.tile[20 * 40 + 20], T.FOREST);
  assert.ok(S.amt[20 * 40 + 20] >= 80);
  for (let k = 0; k < 10 && S.tile[20 * 40 + 20] === T.FOREST; k++) World.brush('raise', 20, 20, 3);
  assert.equal(S.tile[20 * 40 + 20], T.HILL);
  assert.equal(S.amt[20 * 40 + 20], 0, 'forest removed above band');
  // lowering a forest below the band also removes it
  blank(ctx, 40, 40, T.GRASS); fillRect(ctx, 10, 10, 30, 30, T.FOREST); S.elev.fill(115);
  for (let k = 0; k < 3; k++) World.brush('lower', 20, 20, 3);
  assert.notEqual(S.tile[20 * 40 + 20], T.FOREST);
  // lava: raise => mountain, lower => hill
  blank(ctx, 40, 40, T.GRASS); World.setTile(20, 20, T.LAVA); World.setTile(25, 25, T.LAVA);
  World.brush('raise', 20, 20, 1); assert.equal(S.tile[20 * 40 + 20], T.MOUNTAIN);
  World.brush('lower', 25, 25, 1); assert.equal(S.tile[25 * 40 + 25], T.HILL);
  // resources that no longer fit are cleared when the tile retypes
  blank(ctx, 40, 40, T.HILL); S.res[20 * 40 + 20] = ctx.Const.RES.IRON; S.amt[20 * 40 + 20] = 50;
  for (let k = 0; k < 8; k++) World.brush('raise', 20, 20, 1);          // hill -> mountain (iron ok) -> snow (cleared)
  assert.equal(S.tile[20 * 40 + 20], T.SNOW); assert.equal(S.res[20 * 40 + 20], 0); assert.equal(S.amt[20 * 40 + 20], 0);
  // edges / bad input never throw
  assert.equal(World.brush('nope', 5, 5, 3), 0);
  assert.doesNotThrow(() => { World.brush('raise', -3, -3, 8); World.brush('lower', 39, 39, 8); World.brush('raise', NaN, 3, 3); World.brush('raise', 1e9, 5, 5); });
});

section('brush: painting tools (every tool, hooks, dirty list, events, resources, buildings)', () => {
  const ctx = mkCtx(); const { S, World, Tiles, Const, Bus } = ctx; const T = Const.T, RES = Const.RES;
  const tools = { grass: T.GRASS, sand: T.SAND, hill: T.HILL, snow: T.SNOW, lava: T.LAVA, mountain: T.MOUNTAIN, forest: T.FOREST };
  for (const [tool, tt] of Object.entries(tools)) {
    blank(ctx, 40, 40, tool === 'grass' ? T.SAND : T.GRASS);
    const events = []; const fn = (x, y, o, n) => events.push([x, y, o, n]); Bus.on('tileChanged', fn);
    S.dirtyList.length = 0; S.dirty.fill(0);
    ctx.calls.units = 0;
    const n = World.brush(tool, 20, 20, 5);
    Bus.off('tileChanged', fn);
    assert.ok(n >= 50 && n <= 140, `${tool}: changed ${n}`);
    let c = 0; for (let i = 0; i < S.tile.length; i++) if (S.tile[i] === tt) c++;
    const skirt = tool === 'mountain' ? count(ctx, T.HILL) : 0;                  // mountain adds a hill skirt
    assert.ok(c + skirt >= n * 0.9, `${tool}: tiles of type ${c}+${skirt} vs changed ${n}`);
    assert.equal(S.tile[20 * 40 + 20], tt, `${tool}: centre`);
    assert.ok(S.tile[20 * 40 + 20 + 5] === tt || S.tile[20 * 40 + 20 + 6] !== tt, `${tool}: radius respected`);
    assert.equal(S.tile[20 * 40 + 27], tool === 'grass' ? T.SAND : T.GRASS, `${tool}: outside the brush untouched`);
    assert.equal(events.length, n, `${tool}: one tileChanged per changed tile (${events.length} vs ${n})`);
    for (const e of events) { assert.equal(e[2], tool === 'grass' ? T.SAND : T.GRASS); assert.ok(S.tile[e[1] * 40 + e[0]] === e[3]); }
    for (const e of events) assert.ok(S.dirty[e[1] * 40 + e[0]] === 1, 'changed tile marked dirty');
    for (let i = 0; i < S.tile.length; i++) if (S.tile[i] !== T.FOREST && S.tile[i] !== T.LAVA) assert.equal(S.tile[i], Tiles.fromElev(S.elev[i]), `${tool}: elev/type consistency`);
    if (tool === 'forest') { for (let i = 0; i < S.tile.length; i++) if (S.tile[i] === T.FOREST) assert.ok(S.amt[i] >= 80 && S.amt[i] <= 200, 'forest amt'); }
    if (tool === 'lava') assert.ok(ctx.calls.units >= n, 'lava hurts whatever stands on it');
  }
  // painting land on water: becomes land, deep water around gets a shallow shelf, landDirty
  blank(ctx, 40, 40, T.DEEP); S.landDirty = false;
  const n = World.brush('grass', 20, 20, 3);
  assert.ok(n > 25 && S.landDirty); assert.equal(S.tile[20 * 40 + 20], T.GRASS);
  assert.equal(S.tile[20 * 40 + 24], T.SHALLOW, 'shelf next to painted island');
  assert.ok(World.landId(20, 20) > 0);
  // mountain brush: centre mountain, soft hill skirt
  blank(ctx, 40, 40, T.GRASS); World.brush('mountain', 20, 20, 6);
  assert.equal(S.tile[20 * 40 + 20], T.MOUNTAIN); let hills = count(ctx, T.HILL); assert.ok(hills > 15, 'hill skirt ' + hills);
  // forest brush: skips buildings, refreshes thin forest, converts any terrain
  blank(ctx, 40, 40, T.GRASS); addBuilding(ctx, 20, 20); World.brush('forest', 20, 20, 3);
  assert.equal(S.tile[20 * 40 + 20], T.GRASS, 'building tile not turned into forest'); assert.ok(S.bld[20 * 40 + 20]);
  blank(ctx, 40, 40, T.MOUNTAIN); World.brush('forest', 20, 20, 3); assert.equal(S.tile[20 * 40 + 20], T.FOREST);
  blank(ctx, 40, 40, T.DEEP); World.brush('forest', 20, 20, 3); assert.equal(S.tile[20 * 40 + 20], T.FOREST);
  // resource clearing rules per painted tile
  blank(ctx, 40, 40, T.GRASS);
  const put = (x, y, k, a) => { S.res[y * 40 + x] = k; S.amt[y * 40 + x] = a; };
  put(10, 10, RES.ROCK, 80); put(12, 10, RES.BERRY, 50); put(14, 10, RES.TREE, 30); put(16, 10, RES.IRON, 70);
  World.brush('sand', 12, 10, 8);
  for (const x of [10, 12, 14, 16]) { assert.equal(S.res[10 * 40 + x], 0, 'sand holds no resources @' + x); assert.equal(S.amt[10 * 40 + x], 0); }
  blank(ctx, 40, 40, T.GRASS); put(10, 10, RES.ROCK, 80); put(12, 10, RES.BERRY, 50); put(14, 10, RES.TREE, 30);
  World.brush('hill', 12, 10, 8);
  assert.equal(S.res[10 * 40 + 10], RES.ROCK, 'rock survives on hill'); assert.equal(S.res[10 * 40 + 12], 0, 'berry cleared on hill'); assert.equal(S.res[10 * 40 + 14], 0, 'tree cleared on hill');
  blank(ctx, 40, 40, T.GRASS); put(12, 10, RES.BERRY, 50); put(14, 10, RES.TREE, 30);
  World.brush('forest', 13, 10, 6); assert.equal(S.res[10 * 40 + 12], 0); assert.equal(S.res[10 * 40 + 14], 0);
  blank(ctx, 40, 40, T.GRASS); put(12, 10, RES.BERRY, 50); World.brush('grass', 12, 10, 3); assert.equal(S.res[10 * 40 + 12], RES.BERRY, 'painting grass over grass keeps berries');
  // buildings are destroyed when water/lava/mountain arrive, kept for grass/sand/hill
  blank(ctx, 40, 40, T.GRASS); addBuilding(ctx, 20, 20); ctx.calls.destroy = 0; ctx.calls.record = true; ctx.calls.destroyLog.length = 0;
  World.brush('hill', 20, 20, 2); assert.equal(ctx.calls.destroy, 0); World.brush('sand', 20, 20, 2); assert.equal(ctx.calls.destroy, 0);
  World.brush('lava', 20, 20, 2); assert.ok(ctx.calls.destroy >= 1); assert.deepEqual(ctx.calls.destroyLog[0], [20, 20, 'terrain']);
  blank(ctx, 40, 40, T.GRASS); addBuilding(ctx, 20, 20); ctx.calls.destroy = 0;
  for (let k = 0; k < 12; k++) World.brush('lower', 20, 20, 2); assert.ok(ctx.calls.destroy >= 1, 'lowered into the sea'); ctx.calls.record = false;
  // fire is extinguished by water / lava
  blank(ctx, 40, 40, T.GRASS); World.ignite(20, 20); assert.ok(World.isBurning(20, 20)); World.brush('lower', 20, 20, 2);
  for (let k = 0; k < 10; k++) World.brush('lower', 20, 20, 2);
  assert.ok(!World.isBurning(20, 20));
  // brush storm keeps invariants
  blank(ctx, 64, 64, T.GRASS); const names = ['raise', 'lower', 'grass', 'sand', 'forest', 'hill', 'mountain', 'snow', 'lava'];
  for (let k = 0; k < 600; k++) World.brush(names[ctx.R.i(names.length)], ctx.R.i(64), ctx.R.i(64), 1 + ctx.R.i(8));
  for (let i = 0; i < S.tile.length; i++) {
    const t = S.tile[i], e = S.elev[i];
    if (t === T.FOREST) { assert.ok(e >= 112 && e < 160); assert.equal(S.res[i], 0); }
    else if (t === T.LAVA) assert.ok(e >= 192 && e < 228);
    else assert.equal(t, Tiles.fromElev(e), 'storm: tile/elev');
    if (S.res[i]) assert.ok(t === T.GRASS || t === T.HILL || t === T.MOUNTAIN, 'storm: res on ' + t);
    if (t !== T.FOREST && !S.res[i]) assert.equal(S.amt[i], 0);
  }
});

section('brush: performance (r=8 < 1 ms)', () => {
  const ctx = mkCtx(); const { S, World, Const } = ctx; const T = Const.T;
  World.generate({ seed: 4, w: 96, h: 96 });
  const names = ['raise', 'lower', 'grass', 'sand', 'forest', 'hill', 'mountain', 'snow', 'lava'];
  const out = [];
  for (const nm of names) {
    for (let k = 0; k < 30; k++) World.brush(nm, 48, 48, 8);       // warm
    const N = 300; const t0 = performance.now();
    for (let k = 0; k < N; k++) World.brush(nm, 30 + (k % 30), 30 + ((k * 7) % 30), 8);
    const per = (performance.now() - t0) / N; out.push(`${nm} ${per.toFixed(3)}`);
    assert.ok(per < 1, `${nm} brush r=8 took ${per.toFixed(3)} ms`);
  }
  note('r=8 ms/call: ' + out.join(', '));
});

// ====================================================================================================
// C. setTile
// ====================================================================================================
section('setTile: hooks, elev rules, resources, fire, buildings, landDirty', () => {
  const ctx = mkCtx(); const { S, World, Const, Bus, Tiles } = ctx; const T = Const.T, RES = Const.RES;
  blank(ctx, 32, 32, T.GRASS); S.landDirty = false;
  const ev = []; const fn = (x, y, o, n) => ev.push([x, y, o, n]); Bus.on('tileChanged', fn);
  S.dirty.fill(0); S.dirtyList.length = 0;
  assert.equal(World.setTile(5, 6, T.HILL), true);
  assert.deepEqual(ev, [[5, 6, T.GRASS, T.HILL]]);
  assert.equal(S.tile[6 * 32 + 5], T.HILL); assert.equal(S.elev[6 * 32 + 5], Tiles.midElev(T.HILL));
  assert.equal(S.dirty[6 * 32 + 5], 1); assert.ok(S.dirtyList.includes(6 * 32 + 5));
  assert.ok(!S.landDirty, 'grass->hill does not change land layout');
  assert.equal(World.setTile(5, 6, T.HILL), false, 'no-op returns false'); assert.equal(ev.length, 1);
  // explicit elev
  World.setTile(7, 7, T.MOUNTAIN, { elev: 199 }); assert.equal(S.elev[7 * 32 + 7], 199);
  // water <-> land sets landDirty; grass <-> forest does not
  S.landDirty = false; World.setTile(9, 9, T.FOREST); assert.ok(!S.landDirty);
  World.setTile(9, 9, T.SHALLOW); assert.ok(S.landDirty); S.landDirty = false; World.setTile(9, 9, T.DEEP); assert.ok(S.landDirty, 'shallow->deep changes walkability'); S.landDirty = false; World.setTile(9, 9, T.DEEP, { elev: 20 }); assert.ok(!S.landDirty, 'deep->deep');
  World.setTile(9, 9, T.SAND); assert.ok(S.landDirty);
  S.landDirty = false; World.setTile(10, 10, T.LAVA); assert.ok(S.landDirty, 'lava is not walkable');
  // forest gets amt 80..200 and drops resources; leaving forest zeroes amt
  S.res[11 * 32 + 11] = RES.BERRY; S.amt[11 * 32 + 11] = 40;
  World.setTile(11, 11, T.FOREST); assert.equal(S.res[11 * 32 + 11], 0); assert.ok(S.amt[11 * 32 + 11] >= 80 && S.amt[11 * 32 + 11] <= 200);
  const keep = S.amt[11 * 32 + 11]; World.setTile(11, 11, T.FOREST, { elev: 150 }); assert.equal(S.amt[11 * 32 + 11], keep, 'forest->forest keeps density'); assert.equal(S.elev[11 * 32 + 11], 150);
  World.setTile(11, 11, T.GRASS); assert.equal(S.amt[11 * 32 + 11], 0);
  // keepRes
  S.res[12 * 32 + 12] = RES.BERRY; S.amt[12 * 32 + 12] = 40;
  World.setTile(12, 12, T.SAND, { keepRes: true }); assert.equal(S.res[12 * 32 + 12], RES.BERRY); assert.equal(S.amt[12 * 32 + 12], 40);
  World.setTile(13, 13, T.SAND); World.setTile(13, 13, T.GRASS);
  S.res[13 * 32 + 13] = RES.ROCK; S.amt[13 * 32 + 13] = 40; World.setTile(13, 13, T.HILL); assert.equal(S.res[13 * 32 + 13], RES.ROCK);
  World.setTile(13, 13, T.SAND); assert.equal(S.res[13 * 32 + 13], 0);
  // fire + building on water/lava
  World.setTile(14, 14, T.GRASS); World.ignite(14, 14); assert.ok(World.isBurning(14, 14)); World.setTile(14, 14, T.SHALLOW); assert.ok(!World.isBurning(14, 14));
  World.setTile(15, 15, T.GRASS); World.ignite(15, 15); World.setTile(15, 15, T.LAVA); assert.ok(!World.isBurning(15, 15));
  World.setTile(16, 16, T.GRASS); addBuilding(ctx, 16, 16); ctx.calls.record = true; ctx.calls.destroyLog.length = 0;
  World.setTile(16, 16, T.DEEP); assert.deepEqual(ctx.calls.destroyLog, [[16, 16, 'terrain']]); assert.equal(S.bld[16 * 32 + 16], 0);
  World.setTile(17, 17, T.GRASS); addBuilding(ctx, 17, 17); ctx.calls.destroyLog.length = 0; World.setTile(17, 17, T.LAVA); assert.equal(ctx.calls.destroyLog.length, 1);
  World.setTile(18, 18, T.GRASS); addBuilding(ctx, 18, 18); ctx.calls.destroyLog.length = 0; World.setTile(18, 18, T.SAND); assert.equal(ctx.calls.destroyLog.length, 0, 'sand keeps the building');
  ctx.calls.record = false;
  // out of bounds is harmless
  assert.equal(World.setTile(-1, 0, T.GRASS), false); assert.equal(World.setTile(32, 5, T.GRASS), false); assert.equal(World.setTile(5, 5, 99), false);
  Bus.off('tileChanged', fn);
});

// ====================================================================================================
// D. QUERIES
// ====================================================================================================
section('queries: tileAt/walkable/moveCost/isBuildable/resAt', () => {
  const ctx = mkCtx(); const { S, World, Const, Tiles, Races } = ctx; const T = Const.T, RES = Const.RES;
  blank(ctx, 20, 20, T.DEEP);
  fillRect(ctx, 5, 5, 14, 14, T.GRASS);
  World.setTile(5, 5, T.SAND); World.setTile(6, 5, T.SHALLOW); World.setTile(7, 5, T.FOREST); World.setTile(8, 5, T.HILL); World.setTile(9, 5, T.MOUNTAIN); World.setTile(10, 5, T.SNOW); World.setTile(11, 5, T.LAVA);
  assert.equal(World.tileAt(-1, 3), T.DEEP); assert.equal(World.tileAt(3, 999), T.DEEP); assert.equal(World.tileAt(7, 5), T.FOREST); assert.equal(World.tileAt(7.9, 5.2), T.FOREST);
  assert.equal(World.walkable(0, 0), false); assert.equal(World.walkable(6, 5), true); assert.equal(World.walkable(11, 5), false); assert.equal(World.walkable(9, 5), true); assert.equal(World.walkable(-5, 5), false);
  // moveCost = Tiles speed * Races terrain multiplier (0 if blocked)
  for (let race = 0; race < 3; race++) for (let t = 0; t < Const.TILE_COUNT; t++) {
    const tmp = 5 + (t % 10); World.setTile(tmp, 8, t);
    const mult = Races.get(race).terrain[t] ?? 1;
    assert.ok(Math.abs(World.moveCost(tmp, 8, race) - Tiles.defs[t].speed * mult) < 1e-6, `moveCost race ${race} tile ${t}`);
  }
  assert.equal(World.moveCost(0, 0, 0), 0); assert.equal(World.moveCost(-1, -1, 0), 0); assert.equal(World.moveCost(11, 5, 0), 0);
  // isBuildable
  fillRect(ctx, 5, 10, 14, 14, T.GRASS);
  assert.equal(World.isBuildable(8, 12), true); assert.equal(World.isBuildable(5, 5), true, 'sand is buildable');
  assert.equal(World.isBuildable(7, 5), false, 'forest'); assert.equal(World.isBuildable(9, 5), false, 'mountain'); assert.equal(World.isBuildable(8, 5), true, 'hill'); assert.equal(World.isBuildable(0, 0), false);
  S.res[12 * 20 + 8] = RES.ROCK; S.amt[12 * 20 + 8] = 10; assert.equal(World.isBuildable(8, 12), false, 'feature blocks');
  S.res[12 * 20 + 8] = 0; S.amt[12 * 20 + 8] = 0; addBuilding(ctx, 8, 12); assert.equal(World.isBuildable(8, 12), false, 'building blocks');
  S.bld[12 * 20 + 8] = 0; World.ignite(8, 12); assert.equal(World.isBurning(8, 12), true); assert.equal(World.isBuildable(8, 12), false, 'burning blocks');
  assert.equal(World.isBuildable(-1, 0), false); assert.equal(World.isBuildable(99, 99), false);
  // resAt
  S.res[11 * 20 + 6] = RES.GOLD; S.amt[11 * 20 + 6] = 33;
  assert.deepEqual(World.resAt(6, 11), { kind: RES.GOLD, amt: 33 });
  assert.equal(World.resAt(7, 5).kind, RES.TREE); assert.equal(World.resAt(7, 5).amt, S.amt[5 * 20 + 7]);
  assert.deepEqual(World.resAt(8, 13), { kind: RES.NONE, amt: 0 }); assert.deepEqual(World.resAt(-4, 2), { kind: RES.NONE, amt: 0 });
});

section('queries: findNearestRes (brute-force cross-check), pred, FISH, nearestTile, randomLand', () => {
  const ctx = mkCtx(); const { S, World, Const, Tiles, R } = ctx; const T = Const.T, RES = Const.RES;
  World.generate({ seed: 12, w: 96, h: 96 });
  const W = S.w;
  const matches = (kind, i) => {
    const x = i % W, y = (i / W) | 0;
    switch (kind) {
      case RES.TREE: return S.tile[i] === T.FOREST || (S.res[i] === RES.TREE && S.amt[i] > 0);
      case RES.BERRY: return S.res[i] === RES.BERRY && S.amt[i] >= 5;
      case RES.FISH: return Tiles.isLand(S.tile[i]) && ((x > 0 && S.tile[i - 1] === T.SHALLOW) || (x < W - 1 && S.tile[i + 1] === T.SHALLOW) || (y > 0 && S.tile[i - W] === T.SHALLOW) || (y < S.h - 1 && S.tile[i + W] === T.SHALLOW));
      default: return S.res[i] === kind && S.amt[i] > 0;
    }
  };
  let t0 = performance.now(), calls = 0;
  for (const kind of [RES.TREE, RES.ROCK, RES.IRON, RES.GOLD, RES.BERRY, RES.FISH]) {
    for (let q = 0; q < 60; q++) {
      const x = R.i(96), y = R.i(96), maxR = 6 + R.i(40);
      const got = World.findNearestRes(x, y, kind, maxR); calls++;
      let best = Infinity;
      for (let i = 0; i < S.tile.length; i++) if (matches(kind, i)) { const dx = i % W - x, dy = ((i / W) | 0) - y; if (Math.max(Math.abs(dx), Math.abs(dy)) <= maxR) best = Math.min(best, dx * dx + dy * dy); }
      if (best === Infinity) assert.equal(got, null, `kind ${kind}: should find nothing`);
      else { assert.ok(got, `kind ${kind} expected a result`); const d = (got[0] - x) ** 2 + (got[1] - y) ** 2; assert.equal(d, best, `kind ${kind}: not the nearest (${d} vs ${best})`); assert.ok(matches(kind, got[1] * W + got[0])); }
    }
  }
  note(`findNearestRes: ${((performance.now() - t0) / calls).toFixed(3)} ms/call incl. brute-force check`);
  // timing of the query alone
  t0 = performance.now(); for (let q = 0; q < 2000; q++) World.findNearestRes(R.i(96), R.i(96), RES.IRON, 40); const per = (performance.now() - t0) / 2000;
  note(`findNearestRes(IRON, r=40): ${per.toFixed(4)} ms/call`);
  // pred and thresholds
  const berry = World.findNearestRes(48, 48, RES.BERRY, 60); assert.ok(berry);
  S.amt[berry[1] * W + berry[0]] = 4; const berry2 = World.findNearestRes(berry[0], berry[1], RES.BERRY, 60);
  assert.ok(!(berry2[0] === berry[0] && berry2[1] === berry[1]), 'berries need amt >= 5');
  const only = World.findNearestRes(48, 48, RES.TREE, 60, (x, y) => x > 60); assert.ok(only && only[0] > 60);
  assert.equal(World.findNearestRes(48, 48, RES.TREE, 60, () => false), null);
  assert.equal(World.findNearestRes(-100, -100, RES.TREE, 5), null); assert.equal(World.findNearestRes(5, 5, 99, 20), null);
  // nearestTile
  const nt = World.nearestTile(48, 48, T.SAND, 80); assert.ok(nt && S.tile[nt[1] * W + nt[0]] === T.SAND);
  let bestD = Infinity; for (let i = 0; i < S.tile.length; i++) if (S.tile[i] === T.SAND) bestD = Math.min(bestD, (i % W - 48) ** 2 + ((i / W | 0) - 48) ** 2);
  assert.equal((nt[0] - 48) ** 2 + (nt[1] - 48) ** 2, bestD); assert.equal(World.nearestTile(48, 48, T.LAVA, 90), null);
  // randomLand
  for (let k = 0; k < 200; k++) { const p = World.randomLand(); assert.ok(p && Tiles.isLand(S.tile[p[1] * W + p[0]])); }
  const hp = World.randomLand((x, y) => S.tile[y * W + x] === T.HILL); assert.ok(hp && S.tile[hp[1] * W + hp[0]] === T.HILL);
  blank(ctx, 16, 16, T.DEEP); assert.equal(World.randomLand(), null); assert.equal(World.randomLand(null, 10), null);
  World.setTile(3, 3, T.GRASS); assert.deepEqual(World.randomLand(), [3, 3], 'fallback scan finds the only land tile');
  assert.equal(World.randomLand(() => false), null);
});

section('queries: nearestWalkable / inBounds / landSize helpers', () => {
  const ctx = mkCtx(); const { S, World, Const, R } = ctx; const T = Const.T;
  blank(ctx, 30, 30, T.DEEP); fillRect(ctx, 10, 10, 14, 14, T.GRASS);
  assert.deepEqual(World.nearestWalkable(12, 12), [12, 12]);
  const p = World.nearestWalkable(8, 12); assert.deepEqual(p, [10, 12]);
  assert.equal(World.nearestWalkable(1, 1, 3), null); assert.ok(World.nearestWalkable(1, 1, 30));
  for (let k = 0; k < 200; k++) {                               // brute force cross-check from random water tiles
    const x = R.i(30), y = R.i(30); const got = World.nearestWalkable(x, y, 40); let best = Infinity;
    for (let yy = 10; yy <= 14; yy++) for (let xx = 10; xx <= 14; xx++) best = Math.min(best, (xx - x) ** 2 + (yy - y) ** 2);
    assert.equal((got[0] - x) ** 2 + (got[1] - y) ** 2, best);
  }
  assert.equal(World.inBounds(0, 0), true); assert.equal(World.inBounds(29.9, 29.9), true); assert.equal(World.inBounds(30, 0), false); assert.equal(World.inBounds(-0.5, 3), false);
  assert.equal(World.landSize(12, 12), 25); assert.equal(World.landSize(0, 0), 0);
});

section('queries: harvest semantics (forest / lone tree / ore / berry / fish)', () => {
  const ctx = mkCtx(); const { S, World, Const } = ctx; const T = Const.T, RES = Const.RES;
  blank(ctx, 20, 20, T.GRASS); const W = 20;
  // forest
  World.setTile(5, 5, T.FOREST); S.amt[5 * W + 5] = 100;
  assert.equal(World.harvest(5, 5, RES.TREE, 30), 30); assert.equal(S.amt[5 * W + 5], 70); assert.equal(S.tile[5 * W + 5], T.FOREST);
  assert.equal(World.harvest(5, 5, RES.ROCK, 10), 0);
  assert.equal(World.harvest(5, 5, RES.TREE, 500), 70); assert.equal(S.tile[5 * W + 5], T.GRASS); assert.equal(S.amt[5 * W + 5], 0); assert.equal(S.res[5 * W + 5], 0);
  assert.equal(World.harvest(5, 5, RES.TREE, 5), 0);
  // lone tree vanishes
  S.res[6 * W + 6] = RES.TREE; S.amt[6 * W + 6] = 12; assert.equal(World.harvest(6, 6, RES.TREE, 8), 8); assert.equal(S.res[6 * W + 6], RES.TREE);
  assert.equal(World.harvest(6, 6, RES.TREE, 8), 4); assert.equal(S.res[6 * W + 6], 0); assert.equal(S.amt[6 * W + 6], 0);
  // ore: depleted -> cleared
  World.setTile(8, 8, T.HILL); S.res[8 * W + 8] = RES.IRON; S.amt[8 * W + 8] = 5;
  assert.equal(World.harvest(8, 8, RES.IRON, 3), 3); assert.equal(World.harvest(8, 8, RES.IRON, 3), 2); assert.equal(S.res[8 * W + 8], 0);
  // berry: depleted bush stays with amt 0 and regrows
  S.res[9 * W + 9] = RES.BERRY; S.amt[9 * W + 9] = 6; assert.equal(World.harvest(9, 9, RES.BERRY, 10), 6);
  assert.equal(S.res[9 * W + 9], RES.BERRY); assert.equal(S.amt[9 * W + 9], 0); assert.equal(World.findNearestRes(9, 9, RES.BERRY, 5), null);
  // fractional requests round stochastically and never exceed the stock
  S.res[10 * W + 10] = RES.ROCK; S.amt[10 * W + 10] = 200; let got = 0; for (let k = 0; k < 400; k++) got += World.harvest(10, 10, RES.ROCK, 0.5);
  assert.ok(Number.isInteger(got) && got > 150 && got < 250, 'stochastic rounding ' + got); assert.equal(S.amt[10 * W + 10], 200 - got);
  // fish is infinite; only valid next to shallow water
  World.setTile(12, 12, T.SHALLOW); assert.equal(World.harvest(11, 12, RES.FISH, 3), 3); assert.equal(World.harvest(11, 12, RES.FISH, 3), 3); assert.equal(World.harvest(3, 3, RES.FISH, 3), 0);
  assert.equal(World.harvest(-1, 3, RES.TREE, 3), 0); assert.equal(World.harvest(3, 3, RES.TREE, 0), 0); assert.equal(World.harvest(3, 3, RES.TREE, NaN), 0);
});

// ====================================================================================================
// E. LAND LABELS + PATHFINDING
// ====================================================================================================
section('landId / sameLand: lazy relabel, bridges, lava, shallows', () => {
  const ctx = mkCtx(); const { S, World, Const } = ctx; const T = Const.T;
  blank(ctx, 30, 30, T.DEEP);
  fillRect(ctx, 2, 2, 8, 8, T.GRASS); fillRect(ctx, 20, 20, 26, 26, T.GRASS);
  assert.ok(World.landId(3, 3) > 0); assert.notEqual(World.landId(3, 3), World.landId(21, 21)); assert.equal(World.landId(15, 15), 0); assert.equal(World.landId(-1, 2), 0);
  assert.equal(World.sameLand(3, 3, 7, 7), true); assert.equal(World.sameLand(3, 3, 21, 21), false); assert.equal(World.sameLand(15, 15, 15, 15), false);
  // a 1-wide bridge built after the labels were computed: relabelled lazily on query
  fillRect(ctx, 8, 8, 20, 8, T.GRASS); fillRect(ctx, 20, 8, 20, 20, T.GRASS);
  assert.ok(S.landDirty); assert.equal(World.sameLand(3, 3, 21, 21), true); assert.ok(!S.landDirty);
  // lava / deep water cut the bridge, shallow water does not
  World.setTile(14, 8, T.LAVA); assert.equal(World.sameLand(3, 3, 21, 21), false, 'lava cuts');
  World.setTile(14, 8, T.SHALLOW); assert.equal(World.sameLand(3, 3, 21, 21), true, 'shallows are walkable');
  World.setTile(14, 8, T.DEEP); assert.equal(World.sameLand(3, 3, 21, 21), false);
  World.setTile(14, 8, T.MOUNTAIN); assert.equal(World.sameLand(3, 3, 21, 21), true, 'mountains are walkable (slowly)');
  assert.ok(World.landSize(3, 3) > 100); assert.equal(World.landSize(0, 0), 0);
  // diagonal-only contact is NOT a connection (paths cannot cut corners)
  blank(ctx, 10, 10, T.DEEP); World.setTile(2, 2, T.GRASS); World.setTile(3, 3, T.GRASS);
  assert.equal(World.sameLand(2, 2, 3, 3), false); assert.equal(World.findPath(2, 2, 3, 3, 0, 100), null);
});

// reference Dijkstra with the same cost model (8-neighbour, no corner cutting)
function dijkstra(ctx, sx, sy, race) {
  const { S, World } = ctx; const w = S.w, n = w * S.h; const dist = new Float64Array(n).fill(Infinity); const cost = (i) => World.moveCost(i % w, (i / w) | 0, race);
  const heap = [[0, sy * w + sx]]; dist[sy * w + sx] = 0;
  const push = (it) => { heap.push(it); let c = heap.length - 1; while (c > 0) { const p = (c - 1) >> 1; if (heap[p][0] <= heap[c][0]) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
  const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let c = 0; for (;;) { let l = 2 * c + 1; if (l >= heap.length) break; if (l + 1 < heap.length && heap[l + 1][0] < heap[l][0]) l++; if (heap[l][0] >= heap[c][0]) break; [heap[l], heap[c]] = [heap[c], heap[l]]; c = l; } } return top; };
  while (heap.length) {
    const [d, i] = pop(); if (d > dist[i]) continue; const x = i % w, y = (i / w) | 0;
    for (let k = 0; k < 8; k++) {
      const dx = [1, -1, 0, 0, 1, 1, -1, -1][k], dy = [0, 0, 1, -1, 1, -1, 1, -1][k]; const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= S.h) continue; const c = cost(ny * w + nx); if (c <= 0) continue;
      if (k >= 4 && (cost(y * w + nx) <= 0 || cost(ny * w + x) <= 0)) continue;
      const nd = d + (k >= 4 ? Math.SQRT2 : 1) / c; if (nd < dist[ny * w + nx]) { dist[ny * w + nx] = nd; push([nd, ny * w + nx]); }
    }
  }
  return dist;
}
function checkPath(ctx, sx, sy, gx, gy, path, race) {
  const { World, S } = ctx; let px = sx, py = sy, cost = 0;
  for (const [x, y] of path) {
    assert.ok(Number.isInteger(x) && Number.isInteger(y));
    const dx = x - px, dy = y - py; assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (dx || dy), 'steps are adjacent');
    const c = World.moveCost(x, y, race); assert.ok(c > 0, 'path tile walkable');
    if (dx && dy) { assert.ok(World.moveCost(px + dx, py, race) > 0 && World.moveCost(px, py + dy, race) > 0, 'no corner cutting'); cost += Math.SQRT2 / c; } else cost += 1 / c;
    px = x; py = y;
  }
  return cost;
}

section('findPath: validity, optimality vs Dijkstra, water, adjacent, budget, timing', () => {
  const ctx = mkCtx(); const { S, World, Const, R } = ctx; const T = Const.T;
  let queries = 0, ratioSum = 0, ratioMax = 0, found = 0, nullDiffLand = 0, noPathButReachable = 0, totalMs = 0, longestMs = 0;
  for (const seed of [2, 7, 21, 33]) {
    World.generate({ seed, w: 96, h: 96 });
    for (let race = 0; race < 3; race++) {
      for (let q = 0; q < 12; q++) {
        const a = World.randomLand(), b = World.randomLand(); if (!a || !b) continue;
        const dist = dijkstra(ctx, a[0], a[1], race); const opt = dist[b[1] * 96 + b[0]];
        const t0 = performance.now(); const p = World.findPath(a[0], a[1], b[0], b[1], race, 1500); const dt = performance.now() - t0; totalMs += dt; longestMs = Math.max(longestMs, dt); queries++;
        const sameLand = World.sameLand(a[0], a[1], b[0], b[1]);
        assert.equal(Number.isFinite(opt), sameLand, 'landId agrees with Dijkstra reachability');
        if (!sameLand) { assert.equal(p, null); nullDiffLand++; continue; }
        if (a[0] === b[0] && a[1] === b[1]) { assert.deepEqual(p, []); continue; }
        if (!p) { noPathButReachable++; continue; }                  // budget exceeded (allowed, but must be rare)
        const c = checkPath(ctx, a[0], a[1], b[0], b[1], p, race);
        assert.deepEqual(p[p.length - 1], [b[0], b[1]]);
        assert.ok(c >= opt - 1e-6, `path cheaper than optimal?! ${c} < ${opt}`);
        const ratio = c / opt; ratioSum += ratio; ratioMax = Math.max(ratioMax, ratio); found++;
      }
    }
  }
  assert.ok(found > 60, 'enough path samples ' + found);
  assert.ok(ratioMax < 1.35, 'worst path / optimal = ' + ratioMax.toFixed(3));
  assert.ok(ratioSum / found < 1.06, 'mean path / optimal = ' + (ratioSum / found).toFixed(3));
  assert.ok(noPathButReachable <= Math.max(3, queries * 0.08), `budget failures ${noPathButReachable}/${queries}`);
  note(`${queries} queries: ${found} paths, ratio mean ${(ratioSum / found).toFixed(3)} max ${ratioMax.toFixed(3)}, cross-land nulls ${nullDiffLand}, budget fails ${noPathButReachable}`);
  note(`avg ${(totalMs / queries).toFixed(3)} ms/query, slowest ${longestMs.toFixed(2)} ms`);

  // 100 random same-land queries timing on one map
  World.generate({ seed: 5, w: 96, h: 96 });
  const pairs = []; while (pairs.length < 100) { const a = World.randomLand(), b = World.randomLand(); if (World.sameLand(a[0], a[1], b[0], b[1])) pairs.push([a, b]); }
  for (const [a, b] of pairs) World.findPath(a[0], a[1], b[0], b[1], 0, 1500);     // warm
  const t0 = performance.now(); let ok = 0; for (const [a, b] of pairs) if (World.findPath(a[0], a[1], b[0], b[1], 0, 1500)) ok++; const per = (performance.now() - t0) / 100;
  note(`100 same-land queries: ${per.toFixed(3)} ms avg, ${ok}/100 within 1500 nodes`);
  assert.ok(per < 2, 'avg path time ' + per);
  // cross-water: instant null
  blank(ctx, 60, 60, T.DEEP); fillRect(ctx, 2, 2, 20, 20, T.GRASS); fillRect(ctx, 30, 30, 50, 50, T.GRASS);
  const t1 = performance.now(); for (let k = 0; k < 1000; k++) assert.equal(World.findPath(5, 5, 40, 40, 0, 1500), null); const nullPer = (performance.now() - t1) / 1000;
  assert.ok(nullPer < 0.05, 'cross-water null is quick: ' + nullPer); note(`cross-water reject: ${(nullPer * 1000).toFixed(1)} us`);
  // blocked goal / blocked start
  assert.equal(World.findPath(5, 5, 25, 25, 0, 1500), null); assert.equal(World.findPath(25, 25, 5, 5, 0, 1500), null);
  assert.deepEqual(World.findPath(5, 5, 5, 5, 0), []);
  assert.equal(World.findPath(-1, 5, 5, 5, 0), null); assert.equal(World.findPath(5, 5, 500, 5, 0), null);
  // adjacent mode for blocked goals (mountain-locked building, water target...)
  World.setTile(12, 12, T.LAVA);
  const pa = World.findPath(3, 3, 12, 12, 0, 1500, { adjacent: true }); assert.ok(pa && pa.length > 0);
  const last = pa[pa.length - 1]; assert.ok(Math.max(Math.abs(last[0] - 12), Math.abs(last[1] - 12)) === 1);
  assert.equal(World.findPath(3, 3, 12, 12, 0, 1500), null, 'lava goal without adjacent');
  assert.deepEqual(World.findPath(11, 11, 12, 12, 0, 1500, { adjacent: true }), [], 'already adjacent');
  assert.equal(World.findPath(3, 3, 40, 40, 0, 1500, { adjacent: true }), null, 'adjacent but other island');
  World.setTile(31, 40, T.DEEP); assert.ok(World.findPath(5, 5, 25, 40, 0, 1500, { adjacent: true }) === null);
  // diagonal / no corner cutting around a lava diagonal pair
  blank(ctx, 12, 12, T.GRASS); World.setTile(5, 6, T.LAVA); World.setTile(6, 5, T.LAVA);
  const pc = World.findPath(5, 5, 6, 6, 0, 500); assert.ok(pc.length > 2, 'must walk around the diagonal wall (no corner cutting): ' + JSON.stringify(pc)); checkPath(ctx, 5, 5, 6, 6, pc, 0);
  // budget: tiny maxNodes -> null; partial option returns a usable prefix
  blank(ctx, 90, 90, T.GRASS);
  assert.equal(World.findPath(2, 2, 85, 85, 0, 20), null); const part = World.findPath(2, 2, 85, 85, 0, 20, { partial: true }); assert.ok(part && part.length > 5);
  const full = World.findPath(2, 2, 85, 85, 0, 1500); assert.ok(full, 'open grass diagonal within the default budget'); assert.equal(full.length, 83);
  // prefers grass over shallows, wades only when needed
  blank(ctx, 30, 12, T.GRASS); for (let y = 0; y < 12; y++) World.setTile(15, y, T.SHALLOW); World.setTile(15, 0, T.GRASS);
  const pw = World.findPath(2, 6, 28, 6, 0, 1500); assert.ok(pw.some(([x, y]) => x === 15 && y === 0) === false || pw.length < 40);
  // moving worlds: path after the land changed (bridge built) uses the new layout
  blank(ctx, 30, 10, T.DEEP); fillRect(ctx, 1, 1, 8, 8, T.GRASS); fillRect(ctx, 20, 1, 28, 8, T.GRASS);
  assert.equal(World.findPath(3, 3, 25, 3, 0, 1500), null); fillRect(ctx, 8, 4, 20, 4, T.GRASS); assert.ok(World.findPath(3, 3, 25, 3, 0, 1500));
  fillRect(ctx, 12, 4, 12, 4, T.DEEP); assert.equal(World.findPath(3, 3, 25, 3, 0, 1500), null);
});

// ====================================================================================================
// F. SIMULATION: growth, rain, berries
// ====================================================================================================
section('growth: forest share stays sane over 6000 ticks on several seeds', () => {
  const ctx = mkCtx(); const { S, World, Const } = ctx; const T = Const.T, RES = Const.RES;
  const out = [];
  for (const seed of [3, 8, 15, 40]) {
    World.generate({ seed, w: 96, h: 96 });
    const f0 = World.forestShare(); let trees0 = 0; for (let i = 0; i < S.res.length; i++) if (S.res[i] === RES.TREE) trees0++;
    const t0 = performance.now(); tick(ctx, 6000); const ms = (performance.now() - t0) / 6000;
    const f1 = World.forestShare(); let trees1 = 0; for (let i = 0; i < S.res.length; i++) if (S.res[i] === RES.TREE) trees1++;
    assert.ok(f1 > f0 * 0.6 && f1 < f0 * 1.6 && f1 < 0.32, `seed ${seed}: forest share ${f0.toFixed(3)} -> ${f1.toFixed(3)}`);
    assert.ok(trees1 > 0 && trees1 < S.tile.length * 0.1, 'saplings exist, bounded: ' + trees1);
    for (let i = 0; i < S.tile.length; i++) { if (S.tile[i] === T.FOREST) assert.ok(S.amt[i] > 0 && S.res[i] === 0); if (S.res[i] === RES.TREE) assert.equal(S.tile[i], T.GRASS); if (S.fire[i]) assert.fail('fire out of nowhere'); }
    out.push(`seed ${seed}: forest ${(100 * f0).toFixed(1)}% -> ${(100 * f1).toFixed(1)}%, saplings ${trees0} -> ${trees1}, ${ms.toFixed(4)} ms/tick`);
  }
  out.forEach(note);
  // hard saturation: a world that is almost all forest does not keep spreading; a tiny grove grows a bit but stays bounded
  blank(ctx, 64, 64, T.GRASS); fillRect(ctx, 28, 28, 33, 33, T.FOREST);
  const a0 = count(ctx, T.FOREST); tick(ctx, 30000);
  const a1 = count(ctx, T.FOREST); const share = World.forestShare();
  assert.ok(a1 >= a0 * 0.9 && share < 0.34, `grove ${a0} -> ${a1} share ${share.toFixed(3)}`);
  note(`isolated 6x6 grove after 30000 ticks: ${a0} -> ${a1} forest tiles (share ${(100 * share).toFixed(1)}%)`);
});

section('growth: forests regrow wood, saplings mature near forests, berries regrow, rain boosts', () => {
  const ctx = mkCtx(); const { S, World, Const } = ctx; const T = Const.T, RES = Const.RES; const W = 64;
  blank(ctx, W, W, T.GRASS); fillRect(ctx, 20, 20, 43, 43, T.FOREST);
  for (let y = 20; y <= 43; y++) for (let x = 20; x <= 43; x++) S.amt[y * W + x] = 20;
  tick(ctx, 6000);
  let sum = 0, n = 0; for (let y = 20; y <= 43; y++) for (let x = 20; x <= 43; x++) if (S.tile[y * W + x] === T.FOREST) { sum += S.amt[y * W + x]; n++; }
  assert.ok(sum / n > 40, 'wood regrew: mean ' + (sum / n).toFixed(1)); note(`forest wood regrowth: 20 -> ${(sum / n).toFixed(1)} avg amt after 6000 ticks`);
  // saplings next to forest mature; lone saplings far away stay lone
  blank(ctx, W, W, T.GRASS); fillRect(ctx, 10, 10, 14, 14, T.FOREST);
  const near = []; for (let k = 0; k < 8; k++) near.push([15, 10 + (k % 5)]);
  for (let y = 10; y <= 14; y++) { S.res[y * W + 15] = RES.TREE; S.amt[y * W + 15] = 40; }
  S.res[50 * W + 50] = RES.TREE; S.amt[50 * W + 50] = 40;
  tick(ctx, 6000);
  let matured = 0; for (let y = 10; y <= 14; y++) if (S.tile[y * W + 15] === T.FOREST) matured++;
  assert.ok(matured >= 3, 'saplings beside a forest matured: ' + matured);
  assert.equal(S.tile[50 * W + 50], T.GRASS, 'lone tree stays lone'); assert.equal(S.res[50 * W + 50], RES.TREE); assert.ok(S.amt[50 * W + 50] <= 70);
  // berries regrow slowly
  blank(ctx, W, W, T.GRASS); const bushes = []; for (let k = 0; k < 40; k++) { const x = 5 + (k % 8) * 6, y = 5 + ((k / 8) | 0) * 10; S.res[y * W + x] = RES.BERRY; S.amt[y * W + x] = 0; bushes.push(y * W + x); }
  tick(ctx, 3000); const grown = bushes.filter(i => S.amt[i] >= 5).length; assert.ok(grown >= 8 && grown <= 40, 'berries regrown ' + grown + '/40');
  assert.ok(bushes.every(i => S.res[i] === RES.BERRY));
  tick(ctx, 20000); assert.ok(bushes.every(i => S.amt[i] <= 120)); note(`berries >= 5 after 3000 ticks: ${grown}/40`);
  // rain boost: same world twice (same seed), rain over the east half for 1500 ticks
  const measure = (rain) => {
    blank(ctx, W, W, T.GRASS, 99); fillRect(ctx, 8, 8, 55, 55, T.FOREST);
    for (let i = 0; i < S.amt.length; i++) if (S.tile[i] === T.FOREST) S.amt[i] = 30;
    for (let k = 0; k < 40; k++) { const x = 8 + ((k * 7) % 48), y = 8 + ((k * 13) % 48); } // (forest only)
    if (rain) S.eff.rains.push({ x: 32, y: 32, r: 20, until: 1e9 });
    tick(ctx, 1500);
    let amt = 0, c = 0; for (let y = 12; y <= 52; y++) for (let x = 12; x <= 52; x++) if ((x - 32) ** 2 + (y - 32) ** 2 <= 16 * 16 && S.tile[y * W + x] === T.FOREST) { amt += S.amt[y * W + x]; c++; }
    return amt / c;
  };
  const dry = measure(false), wet = measure(true);
  assert.ok(wet - 30 > (dry - 30) * 2, `rain boosts wood regrowth: dry ${dry.toFixed(1)} wet ${wet.toFixed(1)}`);
  note(`rain boost over 1500 ticks: avg amt dry ${dry.toFixed(1)} vs rain ${wet.toFixed(1)} (start 30)`);
  // expired rains do nothing
  blank(ctx, W, W, T.GRASS, 99); fillRect(ctx, 8, 8, 55, 55, T.FOREST); for (let i = 0; i < S.amt.length; i++) if (S.tile[i] === T.FOREST) S.amt[i] = 30;
  S.eff.rains.push({ x: 32, y: 32, r: 20, until: -1 }); tick(ctx, 1500);
  let amt = 0, c = 0; for (let y = 12; y <= 52; y++) for (let x = 12; x <= 52; x++) if ((x - 32) ** 2 + (y - 32) ** 2 <= 16 * 16 && S.tile[y * W + x] === T.FOREST) { amt += S.amt[y * W + x]; c++; }
  assert.ok(Math.abs(amt / c - dry) < 6, 'expired rain behaves like no rain: ' + (amt / c).toFixed(1));
});

// ====================================================================================================
// G. FIRE
// ====================================================================================================
function runFire(ctx, maxTicks, onTick) { let t = 0; while (ctx.World.fireCount() > 0 && t < maxTicks) { tick(ctx, 1); t++; if (onTick) onTick(t); } return t; }

section('fire: ignite rules, forest burn-out -> grass, spreading, barriers, extinguish', () => {
  const ctx = mkCtx(); const { S, World, Const } = ctx; const T = Const.T, RES = Const.RES; const W = 50;
  blank(ctx, W, W, T.GRASS); World.setTile(3, 3, T.SHALLOW); World.setTile(4, 3, T.SAND); World.setTile(5, 3, T.MOUNTAIN); World.setTile(6, 3, T.SNOW); World.setTile(7, 3, T.LAVA); World.setTile(8, 3, T.FOREST); World.setTile(9, 3, T.HILL);
  for (const x of [3, 4, 5, 6, 7]) assert.equal(World.ignite(x, 3), false, 'not flammable ' + x);
  assert.equal(World.ignite(8, 3), true); assert.equal(World.ignite(8, 3), false, 'already burning'); assert.equal(World.ignite(9, 3), true, 'hill is flammable (low)');
  assert.equal(World.ignite(-1, 3), false); assert.equal(World.ignite(500, 3), false);
  assert.ok(S.fire[3 * W + 8] >= 38 && S.fire[3 * W + 8] <= 63, 'forest burns long');
  // lone tree + berry bush are flammable, ore is not
  S.res[10 * W + 10] = RES.TREE; S.amt[10 * W + 10] = 30; S.res[10 * W + 12] = RES.BERRY; S.amt[10 * W + 12] = 30; World.setTile(14, 10, T.HILL); S.res[10 * W + 14] = RES.ROCK; S.amt[10 * W + 14] = 20;
  assert.ok(World.ignite(10, 10) && World.ignite(12, 10)); assert.ok(World.ignite(14, 10), 'hill itself can burn'); World.extinguish(14, 10, 0);
  runFire(ctx, 500); assert.equal(S.res[10 * W + 10], 0, 'burnt tree gone'); assert.equal(S.res[10 * W + 12], 0, 'burnt bush gone'); assert.equal(S.res[10 * W + 14], RES.ROCK);
  assert.equal(World.fireCount(), 0);
  // forest burns out to GRASS (amt 0), ash fx, tileChanged events
  blank(ctx, W, W, T.GRASS); fillRect(ctx, 10, 10, 20, 20, T.FOREST);
  const ev = []; const fn = (x, y, o, n) => ev.push([x, y, o, n]); ctx.Bus.on('tileChanged', fn); ctx.Fx.clear();
  World.ignite(15, 15);
  const ticks = runFire(ctx, 3000);
  ctx.Bus.off('tileChanged', fn);
  const burnt = ev.filter(e => e[2] === T.FOREST && e[3] === T.GRASS).length;
  assert.ok(burnt >= 60, 'forest fire spreads widely: ' + burnt + '/121 tiles'); assert.ok(ticks > 40 && ticks < 1500, 'fire duration ' + ticks);
  for (let y = 10; y <= 20; y++) for (let x = 10; x <= 20; x++) { const i = y * W + x; if (S.tile[i] === T.GRASS) { assert.equal(S.amt[i], 0); assert.equal(S.res[i], 0); } assert.equal(S.fire[i], 0); }
  assert.ok(ctx.Fx.list.some(f => f.type === 'ash' || f.type === 'smoke' || f.type === 'fire'), 'fx emitted');
  note(`forest 11x11 fire: ${burnt}/121 tiles burnt, fire lasted ${ticks} ticks`);
  // fire never enters sand / water: 1-tile sand strip is a firebreak; mountains too
  blank(ctx, W, W, T.GRASS); fillRect(ctx, 5, 5, 20, 40, T.FOREST); fillRect(ctx, 21, 5, 21, 40, T.SAND); fillRect(ctx, 22, 5, 38, 40, T.FOREST);
  World.ignite(10, 20); runFire(ctx, 4000);
  for (let y = 5; y <= 40; y++) { assert.equal(S.tile[y * W + 21], T.SAND); assert.equal(S.tile[y * W + 30], T.FOREST, 'east side untouched'); }
  assert.ok(count(ctx, T.FOREST) < 16 * 36 + 17 * 36 - 100);
  // extinguish
  blank(ctx, W, W, T.GRASS); fillRect(ctx, 10, 10, 30, 30, T.FOREST); World.ignite(20, 20); tick(ctx, 20); const burning = World.fireCount(); assert.ok(burning > 1);
  const ext = World.extinguish(20, 20, 40); assert.ok(ext >= burning - 2); tick(ctx, 2); assert.equal(World.fireCount(), 0); assert.equal(S.fire.reduce((a, b) => a + b, 0), 0);
  // grass fires fizzle out or stay small compared with a forest fire
  let total = 0; const trials = 60;
  for (let k = 0; k < trials; k++) { blank(ctx, 40, 40, T.GRASS, k + 1); World.ignite(20, 20); const ev2 = []; let seen = new Set(); seen.add(20 * 40 + 20); runFire(ctx, 800, () => { for (let i = 0; i < S.fire.length; i++) if (S.fire[i]) seen.add(i); }); total += seen.size; }
  note(`single grass-tile fire in open grass: mean ${(total / trials).toFixed(1)} tiles touched (40x40 field)`);
  assert.ok(total / trials < 120, 'grass fire stays local');
});

section('fire: damage to units/buildings, buildings burn, rain extinguishes, water slows', () => {
  const ctx = mkCtx(); const { S, World, Const } = ctx; const T = Const.T; const W = 40;
  blank(ctx, W, W, T.GRASS); fillRect(ctx, 10, 10, 20, 20, T.FOREST);
  ctx.calls.units = 0; ctx.calls.bld = 0; ctx.calls.record = true; ctx.calls.unitsLog.length = 0; ctx.calls.bldLog.length = 0;
  addBuilding(ctx, 25, 15, 0.8); World.ignite(25, 15);
  let burningTileTicks = 0; World.ignite(15, 15);
  runFire(ctx, 2000, () => { burningTileTicks += World.fireCount(); });
  ctx.calls.record = false;
  assert.ok(ctx.calls.unitsLog.every(c => c[2] === 3 && c[3] === 'fire'));
  assert.ok(ctx.calls.units >= burningTileTicks / 5 * 0.8, `units damaged every ~5 ticks per burning tile: ${ctx.calls.units} vs ${(burningTileTicks / 5).toFixed(0)}`);
  assert.ok(ctx.calls.bldLog.length >= 10 && ctx.calls.bldLog.every(c => c[0] === 25 && c[1] === 15 && c[2] === 4 && c[3] === 'fire'), 'building damaged by fire ' + ctx.calls.bldLog.length);
  note(`burning tile-ticks ${burningTileTicks}: Units.damageAt ${ctx.calls.units}x, Buildings.damageAt ${ctx.calls.bldLog.length}x`);
  assert.ok(S.bld[15 * W + 25], 'building survives (it has hp left in this double)');
  // a burning house lights its flammable neighbours: ring of houses
  blank(ctx, W, W, T.GRASS); for (let x = 10; x <= 14; x++) addBuilding(ctx, x, 10, 0.9); World.ignite(10, 10); runFire(ctx, 2000);
  // rain extinguishes (high probability)
  const burntWith = (rain) => { blank(ctx, W, W, T.GRASS, 5); fillRect(ctx, 5, 5, 34, 34, T.FOREST); if (rain) S.eff.rains.push({ x: 20, y: 20, r: 30, until: 1e9 }); World.ignite(20, 20); let seen = new Set(); runFire(ctx, 3000, () => { for (let i = 0; i < S.fire.length; i++) if (S.fire[i]) seen.add(i); }); return seen.size; };
  let dry = 0, wet = 0; for (let k = 0; k < 6; k++) { dry += burntWith(false); } for (let k = 0; k < 6; k++) { wet += burntWith(true); }
  assert.ok(wet < dry * 0.15, `rain stops forest fires: dry ${dry / 6} wet ${wet / 6}`); note(`avg burning tiles: dry ${(dry / 6).toFixed(0)} vs rain ${(wet / 6).toFixed(0)}`);
  // water adjacent slows the fire: strip of forest, one side lined with shallow water
  const spreadTime = (wet) => {
    let sum = 0; const runs = 40;
    for (let k = 0; k < runs; k++) {
      blank(ctx, 60, 6, T.GRASS, 100 + k); fillRect(ctx, 5, 1, 54, 4, T.FOREST);
      if (wet) { fillRect(ctx, 5, 0, 54, 0, T.SHALLOW); fillRect(ctx, 5, 5, 54, 5, T.SHALLOW); fillRect(ctx, 4, 0, 4, 5, T.SHALLOW); fillRect(ctx, 55, 0, 55, 5, T.SHALLOW); }
      World.ignite(6, 2); let t = 0; let reached = -1; while (World.fireCount() > 0 && t < 3000) { tick(ctx, 1); t++; if (reached < 0 && S.fire[2 * 60 + 40] || S.tile[2 * 60 + 40] === T.GRASS && reached < 0) reached = t; }
      sum += reached < 0 ? 3000 : reached;
    }
    return sum / runs;
  };
  const tDry = spreadTime(false), tWet = spreadTime(true); note(`time to cross 35 forest tiles: ${tDry.toFixed(0)} ticks (no water) vs ${tWet.toFixed(0)} ticks (water-lined)`);
  assert.ok(tWet >= tDry * 1.05, 'water slows the fire');
});

section('fire: step cost with ~50 burning tiles (< 0.15 ms) + idle cost', () => {
  const ctx = mkCtx(); const { S, World, Const } = ctx; const T = Const.T;
  World.generate({ seed: 6, w: 96, h: 96 });
  // idle
  tick(ctx, 500); let t0 = performance.now(); tick(ctx, 4000); const idle = (performance.now() - t0) / 4000;
  assert.ok(idle < 0.1, 'idle step ' + idle); note(`idle World.step: ${idle.toFixed(4)} ms/tick`);
  // sustained ~50 burning tiles (clumps re-lit when fewer than 30 burn): isolated 5x5 forest clumps (sand moats) that are re-lit as soon as they burn out
  blank(ctx, 96, 96, T.GRASS); fillRect(ctx, 0, 0, 95, 95, T.SAND);
  const clumps = []; for (let cy = 4; cy < 90; cy += 9) for (let cx = 4; cx < 90; cx += 9) clumps.push([cx, cy]);
  const regrow = (c) => fillRect(ctx, c[0], c[1], c[0] + 4, c[1] + 4, T.FOREST);
  const lit = (c) => World.ignite(c[0] + 2, c[1] + 2);
  clumps.forEach(regrow); let ci = 0;
  let samples = 0, sumMs = 0, sumFire = 0, maxMs = 0;
  for (let k = 0; k < 2500; k++) {
    while (World.fireCount() < 30) { const c = clumps[ci++ % clumps.length]; if (S.tile[(c[1] + 2) * 96 + c[0] + 2] !== T.FOREST) regrow(c); if (!lit(c)) break; }
    const f = World.fireCount(); S.tick++; const t = performance.now(); World.step(S.tick); const dt = performance.now() - t;
    samples++; sumMs += dt; sumFire += f; if (dt > maxMs) maxMs = dt;
    if (S.tick % 7 === 0) ctx.Fx.update(0.1);
  }
  const avg = sumMs / samples; assert.ok(sumFire / samples > 40, 'enough burning tiles ' + (sumFire / samples));
  assert.ok(avg < 0.15, `step with fire ${avg.toFixed(4)} ms`);
  note(`World.step with ~${(sumFire / samples).toFixed(0)} burning tiles: ${avg.toFixed(4)} ms/tick avg, ${maxMs.toFixed(3)} ms worst (n=${samples})`);
});

// ====================================================================================================
// H. LAVA
// ====================================================================================================
section('lava: cools next to water, lone lava solidifies to hill, ignites forest, hurts neighbours', () => {
  const ctx = mkCtx(); const { S, World, Const } = ctx; const T = Const.T; const W = 40;
  // next to water -> mountain, quickly (with a hissing smoke fx)
  blank(ctx, W, W, T.GRASS); fillRect(ctx, 10, 10, 14, 14, T.SHALLOW); World.setTile(15, 12, T.LAVA);
  ctx.Fx.clear(); let t = 0; while (S.tile[12 * W + 15] === T.LAVA && t < 400) { tick(ctx, 1); t++; }
  assert.equal(S.tile[12 * W + 15], T.MOUNTAIN); assert.ok(t < 150, 'cooled in ' + t);
  assert.ok(ctx.Fx.list.some(f => f.type === 'smoke'), 'hiss');
  // a lava pool on the sea shore cools from the water inwards, whole pool within a few hundred ticks only at the shore
  blank(ctx, W, W, T.GRASS); fillRect(ctx, 0, 0, W - 1, 3, T.DEEP); fillRect(ctx, 10, 4, 20, 9, T.LAVA);
  tick(ctx, 400); let lava = count(ctx, T.LAVA), mtn = count(ctx, T.MOUNTAIN);
  for (let x = 10; x <= 20; x++) assert.equal(S.tile[4 * W + x], T.MOUNTAIN, 'shore row cooled');
  assert.ok(mtn >= 11 && lava > 0, 'inner lava still molten after 400 ticks: lava ' + lava + ' mountain ' + mtn);
  // lone lava solidifies to HILL, average ~3000 ticks
  blank(ctx, 64, 64, T.GRASS); fillRect(ctx, 5, 5, 24, 24, T.LAVA); const l0 = count(ctx, T.LAVA);
  tick(ctx, 3000); const l1 = count(ctx, T.LAVA); const solid = 1 - l1 / l0;
  assert.ok(solid > 0.4 && solid < 0.85, 'about 63% of lone lava solidified after ~3000 ticks: ' + solid.toFixed(2));
  assert.ok(count(ctx, T.HILL) >= l0 - l1 - 5, 'solidified lava became hills (or mountain via water)');
  note('lone lava after 3000 ticks: ' + (100 * solid).toFixed(0) + '% solidified');
  tick(ctx, 45000); assert.equal(count(ctx, T.LAVA), 0, 'every lava tile eventually solidifies');
  // lava ignites adjacent forest, burns, damages creatures next to it
  blank(ctx, W, W, T.GRASS); fillRect(ctx, 10, 10, 16, 16, T.FOREST); World.setTile(9, 13, T.LAVA);
  ctx.calls.units = 0; ctx.calls.record = true; ctx.calls.unitsLog.length = 0;
  let lit = -1; for (let k = 1; k <= 1500 && lit < 0; k++) { tick(ctx, 1); if (World.fireCount() > 0) lit = k; }
  assert.ok(lit > 0 && lit < 1500, 'lava lit the forest after ' + lit + ' ticks');
  ctx.calls.record = false;
  assert.ok(ctx.calls.unitsLog.some(c => c[3] === 'lava' && c[2] > 0), 'Units.damageAt(...,"lava") for neighbours');
  assert.ok(ctx.calls.unitsLog.filter(c => c[3] === 'lava').every(c => Math.abs(c[0] - 9) + Math.abs(c[1] - 13) === 1), 'only tiles next to the lava');
  runFire(ctx, 5000); assert.ok(count(ctx, T.FOREST) < 49);
  // cooling lava never leaves S.fire / res / amt garbage
  for (let i = 0; i < S.tile.length; i++) if (S.tile[i] === T.LAVA) { assert.equal(S.res[i], 0); assert.equal(S.fire[i], 0); }
});

// ====================================================================================================
// I. LIFECYCLE / DETERMINISM
// ====================================================================================================
section('step: land relabel is throttled (<= once / 10 ticks) and happens without queries', () => {
  const ctx = mkCtx(); const { S, World, Const } = ctx; const T = Const.T;
  blank(ctx, 30, 30, T.DEEP); fillRect(ctx, 2, 2, 8, 8, T.GRASS); fillRect(ctx, 20, 20, 26, 26, T.GRASS);
  S.tick = 100; World.step(S.tick); assert.ok(!S.landDirty);
  S.tick = 101; fillRect(ctx, 8, 8, 20, 8, T.GRASS); fillRect(ctx, 20, 8, 20, 20, T.GRASS); assert.ok(S.landDirty);
  World.step(S.tick); assert.ok(S.landDirty, 'throttled: relabelled less than 10 ticks ago');
  for (let k = 0; k < 10; k++) { S.tick++; World.step(S.tick); } assert.ok(!S.landDirty, 'relabelled by step');
  assert.ok(World.sameLand(3, 3, 22, 22));
});

section('lifecycle: afterLoad rebuilds the fire list, newWorld resets, caches follow S.reset', () => {
  const ctx = mkCtx(); const { S, World, Const } = ctx; const T = Const.T; const W = 48;
  blank(ctx, W, W, T.GRASS); fillRect(ctx, 10, 10, 30, 30, T.FOREST); World.ignite(20, 20); tick(ctx, 25);
  const nf = World.fireCount(); assert.ok(nf > 3);
  // "save": copy raw layers; "load": reset + fill + afterLoad
  const snap = { tile: S.tile.slice(), elev: S.elev.slice(), res: S.res.slice(), amt: S.amt.slice(), fire: S.fire.slice(), tick: S.tick, rng: ctx.R.getState() };
  S.reset(W, W, 1); S.tile.set(snap.tile); S.elev.set(snap.elev); S.res.set(snap.res); S.amt.set(snap.amt); S.fire.set(snap.fire); S.tick = snap.tick; ctx.R.setState(snap.rng);
  World.afterLoad();
  let lit = 0; for (let i = 0; i < S.fire.length; i++) if (S.fire[i]) lit++;
  assert.equal(World.fireCount(), lit); assert.equal(lit, nf);
  assert.ok(S.landDirty); assert.ok(World.landId(20, 20) > 0);
  runFire(ctx, 3000); assert.equal(World.fireCount(), 0); assert.ok(count(ctx, T.FOREST) < 441);
  // a world that was reset behind World's back is picked up lazily (no throw, correct sizes)
  S.reset(20, 20, 3); S.tile.fill(T.GRASS); S.elev.fill(130);
  assert.doesNotThrow(() => { tick(ctx, 3); World.ignite(5, 5); World.findPath(1, 1, 10, 10, 0, 500); });
  assert.ok(World.isBurning(5, 5)); assert.ok(World.findPath(1, 1, 10, 10, 0, 500));
  // fires lit by someone writing S.fire directly are adopted by the periodic scan
  blank(ctx, 30, 30, T.GRASS); fillRect(ctx, 5, 5, 20, 20, T.FOREST); S.fire[10 * 30 + 10] = 40; tick(ctx, 12); assert.ok(World.fireCount() > 0);
  runFire(ctx, 2000); assert.equal(World.fireCount(), 0);
  // newWorld / generate fully reset the private state
  World.generate({ seed: 2, w: 96, h: 96 }); assert.equal(World.fireCount(), 0); World.newWorld(); assert.equal(World.fireCount(), 0); assert.ok(World.landId(48, 48) >= 0);
});

section('determinism: same seed + same ignitions -> identical world after 2000 ticks', () => {
  const run = () => {
    const ctx = mkCtx(); const { S, World, Const } = ctx;
    World.generate({ seed: 4242, w: 96, h: 96 });
    S.eff.rains.push({ x: 60, y: 30, r: 9, until: 500 });
    for (let k = 0; k < 2000; k++) {
      if (k % 100 === 0) { for (let j = 0; j < 4; j++) World.ignite(20 + ((k / 100 * 13 + j * 17) % 56), 20 + ((k / 100 * 7 + j * 23) % 56)); }
      if (k === 300) { World.brush('lava', 30, 30, 4); World.brush('forest', 60, 60, 6); }
      if (k === 700) World.brush('raise', 50, 50, 8);
      if (k % 400 === 0) World.harvest(48, 48, Const.RES.TREE, 5);
      S.tick++; World.step(S.tick);
    }
    return { hash: hashLayers(ctx), rng: ctx.R.getState(), fires: World.fireCount(), forest: World.forestShare() };
  };
  const a = run(), b = run();
  assert.equal(a.hash, b.hash, 'layers identical'); assert.equal(a.rng, b.rng, 'R state identical'); assert.equal(a.fires, b.fires);
  note(`hash ${a.hash.toString(16)} rng ${a.rng} forest ${(100 * a.forest).toFixed(1)}%`);
});

section('headless smoke: 3000 ticks on a fresh world, no exceptions, bounded dirty list', () => {
  const ctx = mkCtx(); const { S, World, Const } = ctx; const T = Const.T;
  World.generate({ seed: 99, w: 96, h: 96 });
  let worst = 0; const t0 = performance.now();
  for (let k = 0; k < 3000; k++) {
    if (k % 250 === 0) { const p = World.randomLand(); World.ignite(p[0], p[1]); }
    if (k % 500 === 0) { World.brush('lava', 40, 40, 3); S.dirtyList.length = 0; S.dirty.fill(0); }
    S.tick++; const t = performance.now(); World.step(S.tick); worst = Math.max(worst, performance.now() - t); if (k % 5 === 0) ctx.Fx.update(0.1);
  }
  assert.ok(S.dirtyList.length < S.tile.length * 2, 'dirty list is deduplicated');
  for (let i = 0; i < S.tile.length; i++) assert.ok(S.tile[i] < Const.TILE_COUNT);
  note(`3000 ticks: ${((performance.now() - t0) / 3000).toFixed(4)} ms/tick avg, worst ${worst.toFixed(3)} ms`);
});

// ------------------------------------------------------------------------------------------------
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
if (failed.length) { console.log('FAILED: ' + failed.map(f => f.name).join('; ')); process.exit(1); }
