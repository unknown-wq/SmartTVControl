// Powers tests (plain node + assert).   node tests/powers.test.mjs
// Uses the real World / Buildings / Cities / Units / Sim; Kingdoms / Diplomacy / War are spied where their answer matters.
import assert from 'node:assert/strict';
import { loadSim, stepN, newWorld, pad } from './harness.mjs';

const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 74)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 12).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

// ------------------------------------------------------------------ plumbing
function mkCtx(seed = 3, stub = []) {
  const ctx = loadSim({ stub });
  newWorld(ctx, seed, 96, 96);
  ctx.deaths = [];
  ctx.Bus.on('unitDied', (u, cause) => { ctx.deaths.push({ id: u.id, cause, x: u.x, y: u.y }); });
  return ctx;
}
/** advance n ticks AND let the Fx queue age (Sim does not touch Fx) */
function step(ctx, n) { for (let i = 0; i < n; i++) { stepN(ctx, 1); ctx.Fx.update(0.1); } }
/** square [cx-half, cx+half] of one tile type, flat, resources / buildings / fire cleared */
function arena(ctx, cx, cy, half, tile) {
  const { World, S, Const, Tiles } = ctx;
  const t = tile === undefined ? Const.T.GRASS : tile;
  for (let y = cy - half; y <= cy + half; y++) for (let x = cx - half; x <= cx + half; x++) {
    if (S.bld[y * S.w + x]) ctx.Buildings.destroyAt(x, y, 'test');
    S.fire[y * S.w + x] = 0; S.res[y * S.w + x] = 0; S.amt[y * S.w + x] = 0;
    World.setTile(x, y, t, { elev: Tiles.midElev(t) });
  }
}
function house(ctx, cityId, x, y) { return ctx.Buildings.place(cityId, ctx.Const.B.HOUSE, x, y, { instant: true }); }
/** a city with its founders on an (already prepared) arena */
function mkCity(ctx, x, y, n = 3) {
  const us = [];
  for (let i = 0; i < n; i++) us.push(ctx.Units.spawn(0, x + 0.5 + (i - 1) * 0.6, y + 1.5, {}));
  const c = ctx.Cities.found(0, x, y, us);
  assert.ok(c, 'city founded');
  return c;
}
/** a living village: 14 humans on the best site near the middle, 600 ticks of real simulation */
function village(seed = 3) {
  const ctx = mkCtx(seed);
  const { Cities, Units, R, S, World } = ctx;
  const site = Cities.findSite(0, 48, 48, 80) || { x: 48, y: 48 };
  let n = 0, guard = 0;
  while (n < 14 && guard++ < 500) {
    const x = site.x + 0.5 + R.between(-2, 2), y = site.y + 0.5 + R.between(-2, 2);
    if (World.walkable(x, y) && Units.spawn(0, x, y, { sex: n % 2 })) n++;
  }
  step(ctx, 600);
  if (S.cities.size === 0) {                      // fall back to a hand-made city so the powers still have a target
    const us = [...S.units.values()].slice(0, 4);
    Cities.found(0, site.x, site.y, us);
  }
  return ctx;
}
const firstCity = (ctx) => [...ctx.S.cities.values()][0];
const count = (ctx, pred) => { let n = 0; for (let i = 0; i < ctx.S.tile.length; i++) if (pred(i)) n++; return n; };
const burning = (ctx) => ctx.World.fireCount();
const kinds = (ctx, type) => ctx.Fx.list.filter((f) => f.type === type).length;
function spawnAt(ctx, race, x, y, o) { const u = ctx.Units.spawn(race, x, y, o || {}); assert.ok(u, 'spawn'); return u; }
function checkEff(ctx, label) {
  const e = ctx.S.eff;
  assert.deepEqual(JSON.parse(JSON.stringify(e)), e, label + ': S.eff must survive a JSON round trip unchanged');
  assert.ok(e.tornados.length <= 3 && e.rains.length <= 12 && e.meteors.length <= 8 && e.quakes.length <= 4, label + ': effect caps');
}
function patch(obj, key, fn) { const orig = obj[key]; obj[key] = fn; return () => { obj[key] = orig; }; }

console.log('powers tests');

// ================================================================== coverage
section('every ToolDefs id is implemented: no exception, boolean result, message', () => {
  const ctx = village();
  const { Powers, ToolDefs, S } = ctx;
  const c = firstCity(ctx);
  for (const t of ToolDefs) {
    for (const ph of ['tap', 'start', 'move', 'end']) {
      const r = Powers.apply(t.id, c.x + 0.5, c.y + 0.5, 3, ph);
      assert.equal(typeof r, 'boolean', `${t.id}/${ph} returns boolean`);
    }
    assert.equal(typeof Powers.lastMessage, 'string');
  }
  step(ctx, 150);
  assert.equal(Powers.errors, 0, 'no swallowed exceptions: ' + (Powers.lastError && Powers.lastError.stack));
  assert.equal(Powers.apply('nonsense', 10, 10, 2, 'tap'), false);
  assert.equal(Powers.apply('lightning', 10, 10, 2, 'weird'), false);
  assert.ok(ToolDefs.length >= 25);
  checkEff(ctx, 'after all tools');
});

section('out-of-bounds / NaN / Infinity / missing arguments never throw', () => {
  const ctx = village();
  const { Powers, ToolDefs, S } = ctx;
  const pts = [[-5, -5], [-0.2, 10], [1e9, 4], [S.w + 3, S.h + 3], [NaN, 5], [5, NaN], [Infinity, 5], [undefined, undefined], ['a', 'b'], [S.w, S.h], [-1e12, 0]];
  for (const t of ToolDefs) for (const [x, y] of pts) for (const ph of ['tap', 'start', 'move', 'end', undefined]) {
    assert.doesNotThrow(() => Powers.apply(t.id, x, y, undefined, ph), `${t.id} ${x},${y} ${ph}`);
    assert.doesNotThrow(() => Powers.apply(t.id, x, y, NaN, ph));
    assert.doesNotThrow(() => Powers.apply(t.id, x, y, 99, ph));
  }
  for (const [x, y] of pts) assert.equal(Powers.pick(x, y), null, `pick(${x},${y}) null`);
  assert.doesNotThrow(() => { Powers.lightning(NaN, 1); Powers.meteor(1, NaN, 2); Powers.fire(-1, -1, 3); Powers.earthquake(500, 5, 3); Powers.plague(0, 0, NaN); Powers.tornado(-9, 9); Powers.rain(1e9, 1, 2); Powers.heal(NaN, 1, 1); Powers.bless(-1, 1, 1); });
  assert.doesNotThrow(() => Powers.apply('raise', 0.2, 0.2, 8, 'start'), 'brush on the very edge');
  step(ctx, 50);
  assert.equal(Powers.errors, 0);
  // a tool tapped on an empty sea / empty ground must report false, not throw
  for (const id of ['war_whisper', 'peace', 'split', 'plague', 'bless', 'heal', 'erase']) {
    const ctx2 = mkCtx(); arena(ctx2, 48, 48, 6, ctx2.Const.T.DEEP);
    assert.equal(ctx2.Powers.apply(id, 48.5, 48.5, 2, 'tap'), false, id + ' on an empty sea');
    assert.ok(ctx2.Powers.lastMessage.length > 0, id + ' explains itself');
  }
});

section('result protocol: lastMessage is non-empty for real outcomes and "" for silently ignored calls', () => {
  const ctx = mkCtx();
  const { Powers, S, Const } = ctx; const T = Const.T;
  arena(ctx, 48, 48, 10, T.GRASS);
  assert.equal(Powers.apply('raise', 48.5, 48.5, 2, 'start'), true);
  assert.ok(Powers.lastMessage.length > 0);
  assert.equal(Powers.apply('raise', 48.52, 48.5, 2, 'move'), false);
  assert.equal(Powers.lastMessage, '', 'a throttled move is silent');
  assert.equal(Powers.apply('raise', 48.52, 48.5, 2, 'end'), false);
  assert.equal(Powers.lastMessage, '', 'end is silent');
  assert.equal(Powers.apply('meteor', 48.5, 48.5, 2, 'move'), false);
  assert.equal(Powers.lastMessage, '', 'a move of a one-shot tool is silent');
  assert.equal(Powers.apply('lightning', -10, 3, 2, 'tap'), false);
  assert.ok(Powers.lastMessage.length > 0, 'failures explain themselves');
  assert.equal(typeof Powers.lastMessage, 'string');
});

// ================================================================== terrain
section('terrain brushes: raise / lower / grass / sand / forest / hill / mountain / snow / lava', () => {
  const ctx = mkCtx();
  const { Powers, S, Const } = ctx; const T = Const.T;
  const W = S.w;
  const sumElev = () => { let s = 0; for (let y = 38; y <= 58; y++) for (let x = 38; x <= 58; x++) s += S.elev[y * W + x]; return s; };
  arena(ctx, 48, 48, 14, T.GRASS);
  let e0 = sumElev();
  assert.equal(Powers.apply('raise', 48.5, 48.5, 4, 'start'), true);
  const e1 = sumElev();
  assert.ok(e1 > e0 + 100, `raise adds height (${e0} -> ${e1})`);
  for (let i = 0; i < 6; i++) Powers.apply('raise', 48.5, 48.5, 4, 'tap');
  assert.ok(count(ctx, (i) => S.tile[i] === T.HILL || S.tile[i] === T.MOUNTAIN) > 5, 'repeated raising makes hills / mountains');
  arena(ctx, 48, 48, 14, T.GRASS);
  e0 = sumElev();
  assert.equal(Powers.apply('lower', 48.5, 48.5, 4, 'start'), true);
  assert.ok(sumElev() < e0 - 100, 'lower removes height');
  for (let i = 0; i < 8; i++) Powers.apply('lower', 48.5, 48.5, 4, 'tap');
  assert.ok(count(ctx, (i) => S.tile[i] === T.SHALLOW || S.tile[i] === T.DEEP) > 5, 'repeated lowering floods the land');
  const paint = { grass: [T.GRASS, T.SAND], sand: [T.SAND, T.GRASS], forest: [T.FOREST, T.GRASS], hill: [T.HILL, T.GRASS], mountain: [T.MOUNTAIN, T.GRASS], snow: [T.SNOW, T.GRASS], lava: [T.LAVA, T.GRASS] };
  for (const id in paint) {
    arena(ctx, 48, 48, 14, paint[id][1]);
    const ok = Powers.apply(id, 48.5, 48.5, 2, 'start');
    assert.equal(ok, true, id);
    assert.equal(S.tile[48 * W + 48], paint[id][0], id + ' centre tile');
    const inside = count(ctx, (i) => { const x = i % W, y = (i / W) | 0; return Math.hypot(x - 48, y - 48) <= 2 && S.tile[i] === paint[id][0]; });
    assert.ok(inside >= 9, `${id} fills the brush (${inside} tiles)`);
    assert.equal(S.tile[(48 + 9) * W + 48], paint[id][1], id + ' leaves the surroundings alone');
  }
  // big brush works and is bounded
  arena(ctx, 48, 48, 14, T.GRASS);
  assert.equal(Powers.apply('sand', 48.5, 48.5, 8, 'tap'), true);
  assert.ok(count(ctx, (i) => S.tile[i] === T.SAND) > 100);
  assert.ok(kinds(ctx, 'dust') + kinds(ctx, 'smoke') + kinds(ctx, 'fire') > 0, 'terrain tools show feedback');
  assert.equal(Powers.errors, 0);
});

section('drag throttle: a move acts after 0.5 tile OR 3 ticks, fast strokes are filled in', () => {
  const ctx = mkCtx();
  const { Powers, S, World, Const } = ctx; const T = Const.T;
  arena(ctx, 48, 48, 20, T.GRASS);
  let calls = 0;
  const orig = World.brush;
  World.brush = (...a) => { calls++; return orig(...a); };
  try {
    assert.equal(Powers.apply('raise', 40.5, 40.5, 2, 'start'), true);
    assert.equal(calls, 1);
    for (let k = 0; k < 10; k++) assert.equal(Powers.apply('raise', 40.5 + 0.03 * k, 40.5, 2, 'move'), false, 'tiny moves in the same tick are ignored');
    assert.equal(calls, 1, 'no brush calls while throttled');
    assert.equal(Powers.apply('raise', 41.5, 40.5, 2, 'move'), true, '1 tile away acts');
    assert.equal(calls, 2);
    assert.equal(Powers.apply('raise', 41.52, 40.5, 2, 'move'), false, 'right after: throttled');
    S.tick += 3;
    assert.equal(Powers.apply('raise', 41.52, 40.5, 2, 'move'), true, '3 ticks later it acts even without moving');
    assert.equal(calls, 3);
    const before = calls;
    Powers.apply('raise', 60.5, 40.5, 2, 'move');                      // 19 tiles in one go
    const stamps = calls - before;
    assert.ok(stamps >= 3 && stamps <= 6, `a long stroke is interpolated but bounded (${stamps} stamps)`);
    assert.equal(Powers.apply('raise', 60.5, 40.5, 2, 'end'), false, 'end does nothing');
    // a tap ends the gesture: a stray move afterwards starts a fresh stroke (no streak from the old tap)
    Powers.apply('raise', 20.5, 20.5, 2, 'tap');
    const b3 = calls;
    S.tick += 5;
    Powers.apply('raise', 70.5, 20.5, 2, 'move');
    assert.equal(calls, b3 + 1, 'one stamp, not a 50-tile streak');
    Powers.apply('raise', 70.5, 20.5, 2, 'end');
    // a move without a start begins a stroke right there
    const b2 = calls;
    assert.equal(Powers.apply('raise', 30.5, 30.5, 2, 'move'), true);
    assert.equal(calls, b2 + 1);
    // non-drag tools ignore moves completely
    for (const id of ['lightning', 'meteor', 'earthquake', 'plague', 'tornado', 'bless', 'war_whisper', 'peace', 'split']) {
      Powers.apply(id, 50.5, 50.5, 2, 'start');                         // (may or may not do something)
      const act = Powers.active();
      S.tick += 10;
      assert.equal(Powers.apply(id, 52.5, 50.5, 2, 'move'), false, id + ' ignores move');
      assert.deepEqual(Powers.active(), act, id + ' move changed nothing');
    }
  } finally { World.brush = orig; }
});

// ================================================================== creatures
section('creatures: counts, placement, cap, water, drag rate limit', () => {
  const ctx = mkCtx();
  const { Powers, S, Const, Units } = ctx; const T = Const.T;
  arena(ctx, 48, 48, 14, T.GRASS);
  const races = { human: Const.RACE.HUMAN, orc: Const.RACE.ORC, elf: Const.RACE.ELF };
  for (const id in races) {
    const n0 = S.units.size;
    assert.equal(Powers.apply(id, 48.5, 48.5, 1, 'tap'), true, id);
    const n1 = S.units.size - n0;
    assert.ok(n1 >= 1 && n1 <= 3, `${id} r=1 gives ${n1}`);
    const added = [...S.units.values()].slice(n0);
    assert.ok(added.every((u) => u.race === races[id]), id + ' race');
    assert.ok(added.every((u) => Math.hypot(u.x - 48.5, u.y - 48.5) <= 1.3), id + ' inside the brush');
    Powers.apply(id, 40.5, 40.5, 3, 'tap');
    assert.ok(S.units.size - n0 - n1 >= 5 && S.units.size - n0 - n1 <= 6, `${id} big brush is capped at 6`);
  }
  assert.ok(kinds(ctx, 'spark') > 0, 'spark feedback');
  // drag: one per 4 ticks
  const n0 = S.units.size;
  assert.equal(Powers.apply('human', 30.5, 30.5, 2, 'start'), true);
  const afterStart = S.units.size;
  for (let k = 0; k < 8; k++) Powers.apply('human', 30.5 + 0.3 * k, 30.5, 2, 'move');
  assert.equal(S.units.size, afterStart, 'no extra spawns within the same 4 ticks');
  S.tick += 4;
  assert.equal(Powers.apply('human', 33.5, 30.5, 2, 'move'), true);
  assert.equal(S.units.size, afterStart + 1, 'exactly one per 4 ticks');
  S.tick += 4;
  Powers.apply('human', 34.5, 30.5, 2, 'move');
  assert.equal(S.units.size, afterStart + 2);
  // never spawns on water / lava
  arena(ctx, 70, 70, 6, T.DEEP);
  const w0 = S.units.size;
  assert.equal(Powers.apply('orc', 70.5, 70.5, 3, 'tap'), false, 'cannot spawn on deep water');
  assert.equal(S.units.size, w0);
  arena(ctx, 70, 70, 6, T.LAVA);
  assert.equal(Powers.apply('elf', 70.5, 70.5, 3, 'tap'), false, 'cannot spawn on lava');
  // unit cap -> false with an explanation
  S.perf.unitCap = S.units.size;
  assert.equal(Powers.apply('human', 48.5, 48.5, 3, 'tap'), false);
  assert.match(Powers.lastMessage, /предел/);
  S.perf.unitCap = Const.MAX_UNITS;
  assert.equal(Powers.errors, 0);
});

section('erase: removes creatures in the brush only, with blood', () => {
  const ctx = mkCtx();
  const { Powers, S, Const } = ctx; const T = Const.T;
  arena(ctx, 48, 48, 14, T.GRASS);
  const inside = [], outside = [];
  for (let i = 0; i < 8; i++) inside.push(spawnAt(ctx, i % 3, 48.5 + Math.cos(i) * 1.5, 48.5 + Math.sin(i) * 1.5));
  for (let i = 0; i < 5; i++) outside.push(spawnAt(ctx, 0, 56.5 + i * 0.5, 56.5));
  assert.equal(Powers.apply('erase', 48.5, 48.5, 2, 'tap'), true);
  assert.ok(inside.every((u) => !S.units.has(u.id)), 'inside erased');
  assert.ok(outside.every((u) => S.units.has(u.id)), 'outside kept');
  assert.ok(kinds(ctx, 'blood') >= 1, 'blood feedback');
  assert.ok(ctx.deaths.every((d) => d.cause === 'erase'));
  assert.equal(Powers.apply('erase', 48.5, 48.5, 2, 'tap'), false, 'nothing left to erase');
  // drag erases along the stroke, even across a big jump
  const line = []; for (let i = 0; i < 6; i++) line.push(spawnAt(ctx, 0, 40.5 + i * 3, 30.5));
  Powers.apply('erase', 40.5, 30.5, 1, 'start');
  Powers.apply('erase', 58.5, 30.5, 1, 'move');
  assert.ok(line.every((u) => !S.units.has(u.id)), 'a fast erase stroke leaves no gaps');
});

// ================================================================== lightning
section('lightning: kills, burns, razes, kills saplings, logs ruler kills', () => {
  const ctx = mkCtx();
  const { Powers, S, Const, World, Buildings, Units } = ctx; const T = Const.T, RES = Const.RES;
  arena(ctx, 48, 48, 16, T.GRASS);
  const victim = spawnAt(ctx, 0, 50.5, 50.5), bystander = spawnAt(ctx, 0, 53.5, 50.5), rim = spawnAt(ctx, 2, 51.0, 50.5);
  assert.equal(Powers.apply('lightning', 50.5, 50.5, 5, 'tap'), true);
  assert.ok(!S.units.has(victim.id), 'victim dead');
  assert.ok(!S.units.has(rim.id), 'unit 0.5 tile away dead too');
  assert.ok(S.units.has(bystander.id) && bystander.hp === bystander.maxHp, 'bystander 3 tiles away untouched');
  assert.ok(ctx.deaths.some((d) => d.id === victim.id && d.cause === 'lightning'));
  assert.ok(kinds(ctx, 'lightning') === 1 && kinds(ctx, 'explosion') >= 1 && kinds(ctx, 'quake') >= 1, 'bolt + flash + tiny shake');
  // buildings: a house is razed, a town hall only hurt
  arena(ctx, 20, 20, 6, T.GRASS);
  const c = mkCity(ctx, 20, 20);
  const h = house(ctx, c.id, 24, 20), h2 = house(ctx, c.id, 24, 24);
  assert.ok(h && h2);
  Powers.apply('lightning', 24.5, 20.5, 1, 'tap');
  assert.ok(!Buildings.get(h.id), 'house destroyed by a direct hit');
  assert.ok(Buildings.get(h2.id), 'a house elsewhere survives');
  const th = Buildings.at(20, 20);
  const hp0 = th.hp;
  Powers.apply('lightning', 20.5, 20.5, 1, 'tap');
  assert.ok(th.hp < hp0, 'town hall is damaged but stands (hp ' + hp0 + ' -> ' + th.hp + ')');
  // fire: forest strikes ignite most of the time, bare sand never
  arena(ctx, 70, 30, 10, T.FOREST);
  let lit = 0;
  for (let i = 0; i < 30; i++) { const x = 62 + (i % 6) * 3, y = 22 + ((i / 6) | 0) * 3; Powers.apply('lightning', x + 0.5, y + 0.5, 1, 'tap'); if (World.isBurning(x, y)) lit++; }
  assert.ok(lit >= 18, `forest ignites (${lit}/30)`);
  arena(ctx, 70, 70, 6, T.SAND);
  const f0 = burning(ctx);
  for (let i = 0; i < 10; i++) Powers.apply('lightning', 68.5 + (i % 5), 68.5 + ((i / 5) | 0) * 3, 1, 'tap');
  assert.equal(burning(ctx), f0, 'sand does not burn');
  // grass catches fire about 60% of the time
  arena(ctx, 20, 80, 12, T.GRASS);
  let litGrass = 0;
  for (let i = 0; i < 100; i++) { const x = 10 + (i % 10) * 2, y = 70 + ((i / 10) | 0) * 2; Powers.apply('lightning', x + 0.5, y + 0.5, 1, 'tap'); if (World.isBurning(x, y)) litGrass++; }
  assert.ok(litGrass >= 40 && litGrass <= 80, `grass ignites ~60% (${litGrass}/100)`);
  ctx.World.extinguish(20, 80, 30);
  // saplings die
  arena(ctx, 80, 80, 3, T.GRASS);
  S.res[80 * S.w + 80] = RES.TREE; S.amt[80 * S.w + 80] = 30;
  Powers.apply('lightning', 80.5, 80.5, 1, 'tap');
  assert.equal(S.res[80 * S.w + 80], RES.NONE, 'sapling killed');
  // a ruler struck by lightning is written into the chronicle (and only rulers are)
  arena(ctx, 30, 70, 5, T.GRASS);
  const king = spawnAt(ctx, 0, 30.5, 70.5); king.isRuler = true;
  const peasant = spawnAt(ctx, 0, 30.5, 74.5);
  const log0 = S.log.length;
  Powers.apply('lightning', 30.5, 70.5, 1, 'tap');
  Powers.apply('lightning', 30.5, 74.5, 1, 'tap');
  const fresh = S.log.slice(log0);
  assert.ok(fresh.some((e) => /молни/i.test(e.msg)), 'ruler death by lightning is logged: ' + JSON.stringify(fresh.map((e) => e.msg)));
  assert.equal(fresh.length, 1, 'killing a peasant is not logged');
  assert.ok(!S.units.has(peasant.id));
  assert.equal(Powers.apply('lightning', -3, 4, 1, 'tap'), false);
  assert.equal(Powers.errors, 0);
});

// ================================================================== meteor
section('meteor: delayed impact, lava core, rim, fires, casualties, buildings, clamps', () => {
  const ctx = mkCtx();
  const { Powers, S, Const, World, Buildings } = ctx; const T = Const.T;
  const W = S.w;
  arena(ctx, 48, 48, 18, T.GRASS);
  const c = mkCity(ctx, 34, 34);
  const hCore = house(ctx, c.id, 50, 50), hRim = house(ctx, c.id, 53, 50), hFar = house(ctx, c.id, 62, 50);
  const core = spawnAt(ctx, 0, 50.5, 50.5), mid = spawnAt(ctx, 0, 54.5, 50.5), far = spawnAt(ctx, 0, 62.5, 56.5);
  const hp0 = mid.hp;
  const t0 = S.tick;
  assert.equal(Powers.apply('meteor', 50.5, 50.5, 4, 'tap'), true);
  assert.equal(S.eff.meteors.length, 1);
  const m = S.eff.meteors[0];
  assert.deepEqual([m.x, m.y, m.r, m.t0, m.eta], [50.5, 50.5, 4, t0, t0 + 8]);
  step(ctx, 7);
  assert.equal(S.eff.meteors.length, 1, 'still in the air after 7 ticks');
  assert.equal(count(ctx, (i) => S.tile[i] === T.LAVA), 0, 'no crater before the impact');
  assert.ok(S.units.has(core.id));
  step(ctx, 1);
  assert.equal(S.eff.meteors.length, 0, 'impact consumes the meteor');
  const lava = count(ctx, (i) => S.tile[i] === T.LAVA);
  const rim = count(ctx, (i) => S.tile[i] === T.HILL || S.tile[i] === T.MOUNTAIN);
  assert.ok(lava >= 4, `lava core (${lava} tiles)`);
  assert.ok(rim >= 8, `rim of hills / mountains (${rim} tiles)`);
  assert.equal(S.tile[50 * W + 50], T.LAVA, 'impact tile is lava');
  assert.ok(!S.units.has(core.id), 'unit at the core is dead');
  assert.ok(ctx.deaths.some((d) => d.id === core.id && d.cause === 'meteor'));
  assert.ok(!Buildings.get(hCore.id), 'house in the core destroyed');
  assert.ok(!Buildings.get(hRim.id), 'house inside the crater radius destroyed');
  assert.ok(Buildings.get(hFar.id), 'distant house stands');
  assert.ok(!S.units.has(mid.id) || mid.hp < hp0, 'blast-wave casualty or damage 4 tiles out');
  assert.ok(S.units.has(far.id) && far.hp === far.maxHp, 'unit 12 tiles away unharmed');
  assert.ok(burning(ctx) > 0, 'surroundings are ignited');
  assert.ok(kinds(ctx, 'explosion') >= 1 && kinds(ctx, 'ash') >= 1 && kinds(ctx, 'smoke') >= 1 && kinds(ctx, 'quake') >= 1, 'impact feedback');
  assert.ok(S.log.some((e) => /Метеорит/.test(e.msg)), 'a deadly impact is chronicled');
  // lava slowly turns to rock, the fire burns out; the world stays consistent
  step(ctx, 300);
  assert.equal(Powers.errors, 0);
  // radius clamps and active cap
  S.eff.meteors.length = 0;
  Powers.apply('meteor', 20.5, 20.5, 0, 'tap'); Powers.apply('meteor', 24.5, 20.5, 99, 'tap'); Powers.apply('meteor', 28.5, 20.5, 1, 'tap');
  assert.deepEqual(S.eff.meteors.map((e) => e.r), [2, 6, 2], 'r = clamp(brush, 2, 6)');
  for (let i = 0; i < 5; i++) assert.equal(Powers.apply('meteor', 10.5 + i, 10.5, 3, 'tap'), true);
  assert.equal(Powers.apply('meteor', 10.5, 14.5, 3, 'tap'), false, 'at most 8 meteors in the sky');
  assert.equal(S.eff.meteors.length, 8);
  checkEff(ctx, 'meteors in flight');
  step(ctx, 10);
  assert.equal(S.eff.meteors.length, 0);
  assert.equal(Powers.errors, 0);
});

section('meteor into the sea: splash, no lava, no exception; at the map edge too', () => {
  const ctx = mkCtx();
  const { Powers, S, Const } = ctx; const T = Const.T;
  arena(ctx, 48, 48, 10, T.DEEP);
  const lava0 = count(ctx, (i) => S.tile[i] === T.LAVA);
  Powers.apply('meteor', 48.5, 48.5, 5, 'tap');
  step(ctx, 9);
  assert.equal(count(ctx, (i) => S.tile[i] === T.LAVA), lava0, 'water stays water');
  assert.ok(kinds(ctx, 'explosion') >= 1);
  for (const [x, y] of [[0.5, 0.5], [S.w - 0.5, S.h - 0.5], [0.5, 40.5], [40.5, S.h - 0.5]]) { Powers.apply('meteor', x, y, 6, 'tap'); }
  step(ctx, 10);
  assert.equal(Powers.errors, 0);
});

// ================================================================== fire & rain
section('fire: ignites flammables inside the brush, spreads over forest, never on sand / water', () => {
  const ctx = mkCtx();
  const { Powers, S, Const, World } = ctx; const T = Const.T;
  arena(ctx, 48, 48, 16, T.FOREST);
  assert.equal(burning(ctx), 0);
  assert.equal(Powers.apply('fire', 48.5, 48.5, 3, 'tap'), true);
  const b0 = burning(ctx);
  assert.ok(b0 >= 8, `a wide brush lights many tiles (${b0})`);
  for (let i = 0; i < S.tile.length; i++) if (S.fire[i]) {
    const x = i % S.w, y = (i / S.w) | 0;
    assert.ok(Math.hypot(x + 0.5 - 48.5, y + 0.5 - 48.5) <= 3.6, 'fire stays inside the circle');
  }
  const forest0 = count(ctx, (i) => S.tile[i] === T.FOREST);
  step(ctx, 120);
  assert.ok(count(ctx, (i) => S.tile[i] === T.FOREST) < forest0 - 15, 'the forest burns down further than the brush');
  // creatures in the flames catch fire
  const vic = spawnAt(ctx, 0, 70.5, 70.5); arena(ctx, 70, 70, 4, T.GRASS);
  Powers.apply('fire', 70.5, 70.5, 1, 'tap');
  // small brush always lights something on a flammable tile
  arena(ctx, 20, 20, 4, T.GRASS);
  assert.equal(Powers.apply('fire', 20.5, 20.5, 1, 'tap'), true, 'r=1 on grass lights at least one tile');
  // sand / water: nothing to burn
  arena(ctx, 80, 20, 5, T.SAND);
  assert.equal(Powers.apply('fire', 80.5, 20.5, 3, 'tap'), false);
  assert.match(Powers.lastMessage, /гореть/);
  arena(ctx, 80, 50, 5, T.DEEP);
  assert.equal(Powers.apply('fire', 80.5, 50.5, 3, 'tap'), false);
  // drag throttle: tiny moves in the same tick do not re-ignite
  let calls = 0;
  const orig = World.ignite; World.ignite = (x, y) => { calls++; return orig(x, y); };
  try {
    arena(ctx, 48, 80, 8, T.GRASS);
    Powers.apply('fire', 48.5, 80.5, 2, 'start');
    const c1 = calls;
    for (let k = 0; k < 8; k++) Powers.apply('fire', 48.5 + 0.04 * k, 80.5, 2, 'move');
    assert.equal(calls, c1, 'throttled');
    Powers.apply('fire', 52.5, 80.5, 2, 'move');
    assert.ok(calls > c1, 'a real move lights more');
  } finally { World.ignite = orig; }
  assert.equal(Powers.errors, 0);
});

section('rain: extinguishes at once, merges duplicates, caps at 12, expires, JSON-safe', () => {
  const ctx = mkCtx();
  const { Powers, S, Const, World } = ctx; const T = Const.T;
  arena(ctx, 48, 48, 14, T.FOREST);
  Powers.apply('fire', 48.5, 48.5, 5, 'tap');
  step(ctx, 4);
  const lit = burning(ctx);
  assert.ok(lit > 10, 'fire is going (' + lit + ')');
  assert.equal(Powers.apply('rain', 48.5, 48.5, 6, 'tap'), true);
  let still = 0;
  for (let i = 0; i < S.tile.length; i++) if (S.fire[i]) { const x = i % S.w, y = (i / S.w) | 0; if (Math.hypot(x + 0.5 - 48.5, y + 0.5 - 48.5) <= 5.5) still++; }
  assert.equal(still, 0, 'every flame inside the cloud is out');
  assert.equal(S.eff.rains.length, 1);
  assert.deepEqual(Object.keys(S.eff.rains[0]).sort(), ['r', 'until', 'x', 'y']);
  assert.equal(S.eff.rains[0].until, S.tick + 200);
  // refreshing the same cloud
  step(ctx, 50);
  Powers.apply('rain', 48.9, 48.5, 3, 'tap');
  Powers.apply('rain', 48.5, 49.0, 3, 'tap');
  assert.equal(S.eff.rains.length, 1, 'duplicates merge');
  assert.equal(S.eff.rains[0].until, S.tick + 200, 'merging refreshes the timer');
  assert.equal(S.eff.rains[0].r, 6, 'merging keeps the bigger radius');
  // cap
  for (let i = 0; i < 20; i++) Powers.apply('rain', 5.5 + i * 4, 10.5, 2, 'tap');
  assert.equal(S.eff.rains.length, 12, 'at most 12 clouds');
  checkEff(ctx, 'rains');
  // clouds that stop earlier are dropped first
  const newest = S.eff.rains[S.eff.rains.length - 1];
  assert.equal(newest.x, 5.5 + 19 * 4, 'the newest cloud is kept');
  // rain boosts growth through World (S.eff.rains is the contract), expires, never blocks
  step(ctx, 205);
  assert.equal(S.eff.rains.length, 0, 'clouds expire');
  // drag: a stroke lays a trail of clouds, throttled
  Powers.apply('rain', 30.5, 30.5, 3, 'start');
  for (let k = 0; k < 6; k++) Powers.apply('rain', 30.5 + 0.05 * k, 30.5, 3, 'move');
  assert.equal(S.eff.rains.length, 1);
  Powers.apply('rain', 40.5, 30.5, 3, 'move');
  assert.ok(S.eff.rains.length >= 2 && S.eff.rains.length <= 7, 'a long move adds a few clouds (' + S.eff.rains.length + ')');
  // burning creatures are put out
  const u = spawnAt(ctx, 0, 70.5, 70.5); arena(ctx, 70, 70, 3, T.GRASS);
  u.burning = S.tick + 100;
  Powers.apply('rain', 70.5, 70.5, 3, 'tap');
  step(ctx, 6);
  assert.ok(!(u.burning > S.tick), 'rain puts out a burning creature');
  assert.equal(Powers.errors, 0);
});

// ================================================================== earthquake
section('earthquake: ~30 ticks of cracks: lava / lowered land / flooding, buildings fall, units hurt', () => {
  const ctx = mkCtx();
  const { Powers, S, Const, Buildings } = ctx; const T = Const.T;
  const W = S.w;
  arena(ctx, 50, 50, 20, T.GRASS);
  const c = mkCity(ctx, 34, 34);
  const hs = [];
  for (let a = 0; a < 14; a++) {
    const x = 50 + Math.round(Math.cos(a * 0.9) * (2 + (a % 5))), y = 50 + Math.round(Math.sin(a * 0.9) * (2 + (a % 5)));
    if ((x !== 50 || y !== 50) && Buildings.at(x, y) === null) { const b = house(ctx, c.id, x, y); if (b) hs.push(b); }
  }
  assert.ok(hs.length >= 8, 'test buildings placed (' + hs.length + ')');
  const us = []; for (let i = 0; i < 12; i++) us.push(spawnAt(ctx, 0, 50.5 + Math.cos(i) * 3, 50.5 + Math.sin(i) * 3));
  const hp0 = us.map((u) => u.hp);
  const before = Uint8Array.from(S.tile), elevBefore = Uint8Array.from(S.elev);
  assert.equal(Powers.apply('earthquake', 50.5, 50.5, 5, 'tap'), true);
  assert.equal(S.eff.quakes.length, 1);
  const q = S.eff.quakes[0];
  assert.equal(q.until, S.tick + 30);
  assert.ok(q.r >= 5 * 1.4, 'displayed radius covers the cracks');
  assert.ok(kinds(ctx, 'quake') >= 1 && kinds(ctx, 'dust') >= 1, 'feedback at the epicentre');
  checkEff(ctx, 'quake at start');
  step(ctx, 15);
  checkEff(ctx, 'quake mid-way');
  assert.equal(S.eff.quakes.length, 1, 'still shaking after 15 ticks');
  step(ctx, 20);
  assert.equal(S.eff.quakes.length, 0, 'over after ~30 ticks');
  let changed = 0, lava = 0, water = 0, maxDist = 0;
  for (let i = 0; i < S.tile.length; i++) {
    const d = Math.hypot((i % W) - 50, ((i / W) | 0) - 50);
    if (d < 24 && (S.tile[i] !== before[i] || S.elev[i] !== elevBefore[i])) {
      changed++;
      if (d > maxDist) maxDist = d;
    }
    if (S.tile[i] === T.LAVA && before[i] !== T.LAVA) lava++;
    if ((S.tile[i] === T.SHALLOW || S.tile[i] === T.DEEP) && before[i] !== S.tile[i]) water++;
  }
  note(`quake r=5: ${changed} tiles changed, ${lava} lava, ${water} flooded, farthest crack ${maxDist.toFixed(1)}, houses left ${hs.filter((b) => Buildings.get(b.id)).length}/${hs.length}`);
  assert.ok(changed >= 25, `cracks reshape the land (${changed})`);
  assert.ok(lava >= 2, `some cracks turn to lava (${lava})`);
  assert.ok(water >= 1, `low land floods (${water})`);
  assert.ok(maxDist <= 5 * 2 && maxDist >= 5 * 0.8, 'cracks reach about the brush radius and no further (' + maxDist.toFixed(1) + ')');
  assert.ok(hs.filter((b) => !Buildings.get(b.id)).length >= 2, 'cracks swallow houses');
  assert.ok(us.some((u, i) => !S.units.has(u.id) || u.hp < hp0[i]), 'units near the cracks are hurt');
  assert.equal(Powers.errors, 0);
  // several quakes at once: capped
  for (let i = 0; i < 6; i++) Powers.apply('earthquake', 10.5 + i * 12, 10.5, 2, 'tap');
  assert.equal(S.eff.quakes.length, 4);
  step(ctx, 40);
  assert.equal(S.eff.quakes.length, 0);
  assert.equal(Powers.errors, 0);
});

// ================================================================== plague / heal / bless
section('plague infects ~60% in the radius (not outside), heal cures, immunity blocks reinfection', () => {
  const ctx = mkCtx();
  const { Powers, S, Const, Units } = ctx; const T = Const.T;
  arena(ctx, 48, 48, 16, T.GRASS);
  const inside = [], outside = [];
  for (let i = 0; i < 60; i++) inside.push(spawnAt(ctx, i % 3, 48.5 + Math.cos(i * 2.3) * Math.sqrt(i % 20) * 0.55, 48.5 + Math.sin(i * 2.3) * Math.sqrt(i % 20) * 0.55));
  for (let i = 0; i < 6; i++) outside.push(spawnAt(ctx, 0, 62.5, 40.5 + i * 0.5));
  assert.equal(Powers.apply('plague', 48.5, 48.5, 3, 'tap'), true);
  const sick = inside.filter((u) => u.sick > S.tick);
  const frac = sick.length / inside.length;
  assert.ok(frac > 0.4 && frac < 0.8, `~60% infected (${sick.length}/${inside.length})`);
  assert.ok(sick.every((u) => u.sick >= S.tick + 600 && u.sick <= S.tick + 900), 'sickness lasts 600+ ticks');
  assert.ok(outside.every((u) => !(u.sick > S.tick)), 'outside untouched');
  assert.ok(kinds(ctx, 'plague') >= 2, 'plague feedback');
  assert.ok(S.log.some((e) => /чум/i.test(e.msg)), 'a big outbreak is chronicled');
  // damage them a little, then heal
  for (const u of inside) u.hp = Math.max(1, u.hp - 5);
  assert.equal(Powers.apply('heal', 48.5, 48.5, 4, 'tap'), true);
  assert.ok(inside.every((u) => u.hp === u.maxHp), 'healed fully');
  assert.ok(inside.every((u) => !(u.sick > S.tick)), 'sickness cured');
  assert.ok(sick.every((u) => u.immune > S.tick), 'cured units are immune for a while');
  assert.equal(Powers.apply('plague', 48.5, 48.5, 3, 'tap') && sick.filter((u) => u.sick > S.tick).length, 0, 'immune units cannot be re-infected');
  assert.ok(kinds(ctx, 'heal') >= 1);
  // nothing to heal -> false; a stroke heals along its whole path
  Powers.apply('heal', 48.5, 48.5, 4, 'tap');
  assert.equal(Powers.apply('heal', 48.5, 48.5, 4, 'tap'), false, 'all healthy already');
  const line = []; for (let i = 0; i < 5; i++) { const u = spawnAt(ctx, 0, 30.5 + i * 3, 70.5); u.hp = 1; line.push(u); }
  Powers.apply('heal', 30.5, 70.5, 1, 'start');
  Powers.apply('heal', 42.5, 70.5, 1, 'move');
  assert.ok(line.every((u) => u.hp === u.maxHp), 'heal stroke has no gaps');
  assert.equal(Powers.errors, 0);
});

section('bless: 900 ticks, x1.4, +50% hp, real combat bonus; expires', () => {
  const ctx = mkCtx();
  const { Powers, S, Const, Units } = ctx; const T = Const.T;
  arena(ctx, 48, 48, 12, T.GRASS);
  const u = spawnAt(ctx, 0, 48.5, 48.5), v = spawnAt(ctx, 0, 58.5, 48.5);
  u.hp = u.maxHp * 0.2;
  const atk0 = Units.stats(u).atk, spd0 = Units.stats(u).speed;
  assert.equal(Powers.apply('bless', 48.5, 48.5, 3, 'tap'), true);
  assert.equal(u.buffUntil, S.tick + 900);
  assert.equal(u.buffMul, 1.4);
  assert.ok(Math.abs(u.hp - u.maxHp * 0.7) < 1e-6, 'heals half of the max hp');
  assert.ok(Units.stats(u).atk > atk0 * 1.35 && Units.stats(u).speed > spd0 * 1.35, 'buff reaches the unit stats');
  assert.equal(v.buffUntil, 0, 'outside is unchanged');
  assert.ok(kinds(ctx, 'bless') >= 1);
  assert.equal(Powers.apply('bless', 20.5, 20.5, 3, 'tap'), false, 'empty ground');
  S.tick += 901;
  assert.ok(Math.abs(Units.stats(u).atk - atk0) < 1e-9, 'buff has worn off');
});

// ================================================================== tornado
section('tornado: wanders, bounces, flings and hurts, razes forest and houses, cap 3, expires', () => {
  const ctx = mkCtx();
  const { Powers, S, Const, Buildings } = ctx; const T = Const.T;
  arena(ctx, 12, 12, 5, T.GRASS);
  const c = mkCity(ctx, 12, 12);
  arena(ctx, 50, 50, 16, T.FOREST);
  arena(ctx, 50, 50, 3, T.GRASS);
  const hs = [house(ctx, c.id, 49, 50), house(ctx, c.id, 51, 51), house(ctx, c.id, 53, 53)];
  const us = []; for (let i = 0; i < 10; i++) us.push(spawnAt(ctx, 0, 50.5 + Math.cos(i) * 1.2, 50.5 + Math.sin(i) * 1.2));
  const hp0 = us.map((u) => u.hp), pos0 = us.map((u) => [u.x, u.y]);
  // a stationary funnel makes the effect deterministic to inspect
  S.eff.tornados.push({ x: 50.5, y: 50.5, dx: 0, dy: 0, until: S.tick + 450, r: 2, nt: S.tick + 9999 });
  const forest0 = count(ctx, (i) => S.tile[i] === T.FOREST);
  step(ctx, 6);
  const hurt = us.filter((u, i) => !S.units.has(u.id) || u.hp < hp0[i]).length;
  assert.ok(hurt >= 7, `the funnel hurts creatures (${hurt}/10)`);
  const flung = us.filter((u, i) => S.units.has(u.id) && Math.hypot(u.x - pos0[i][0], u.y - pos0[i][1]) > 1.2).length;
  assert.ok(flung >= 4, `and throws them about (${flung} moved >1.2 tiles)`);
  assert.ok(us.every((u) => !S.units.has(u.id) || ctx.World.walkable(u.x, u.y)), 'flung units land on walkable ground');
  step(ctx, 26);
  assert.ok(!Buildings.get(hs[0].id) && !Buildings.get(hs[1].id), 'houses under the funnel fall');
  assert.ok(Buildings.get(hs[2].id), 'far house stays');
  // trees: pull a forest next to the funnel
  S.eff.tornados[0].x = 58.5; S.eff.tornados[0].y = 58.5;
  const f1 = count(ctx, (i) => S.tile[i] === T.FOREST);
  step(ctx, 80);
  const f2 = count(ctx, (i) => S.tile[i] === T.FOREST);
  assert.ok(f2 < f1 - 3, `forest is torn up (${f1} -> ${f2})`);
  S.eff.tornados.length = 0;
  // natural flight: leaves, wanders (heading changes), stays on the map, lives 450 ticks
  arena(ctx, 80, 20, 4, T.GRASS);
  assert.equal(Powers.apply('tornado', 80.5, 20.5, 5, 'tap'), true);
  const t = S.eff.tornados[0];
  assert.deepEqual(Object.keys(t).filter((k) => ['x', 'y', 'dx', 'dy', 'until', 'r'].includes(k)).sort(), ['dx', 'dy', 'r', 'until', 'x', 'y']);
  assert.equal(t.until, S.tick + 450);
  assert.equal(t.r, 2);
  const heads = [], start = [t.x, t.y];
  let far = 0;
  for (let k = 0; k < 440; k++) {
    step(ctx, 1);
    if (!S.eff.tornados.length) break;
    const e = S.eff.tornados[0];
    assert.ok(e.x >= 1.4 && e.x <= S.w - 1.4 && e.y >= 1.4 && e.y <= S.h - 1.4, `stays on the map (${e.x.toFixed(1)},${e.y.toFixed(1)})`);
    if (k % 25 === 0) heads.push(Math.atan2(e.dy, e.dx));
    far = Math.max(far, Math.hypot(e.x - start[0], e.y - start[1]));
  }
  assert.ok(far >= 8, `travels (${far.toFixed(1)} tiles)`);
  const turned = heads.filter((a, i) => i > 0 && Math.abs(Math.atan2(Math.sin(a - heads[i - 1]), Math.cos(a - heads[i - 1]))) > 0.15).length;
  assert.ok(turned >= 3, `changes direction now and then (${turned} turns)`);
  step(ctx, 20);
  assert.equal(S.eff.tornados.length, 0, 'tornado dissipates after 450 ticks');
  // edge bounce
  S.eff.tornados.push({ x: 2.0, y: 40.5, dx: -0.15, dy: 0, until: S.tick + 450, r: 2, nt: S.tick + 9999 });
  step(ctx, 40);
  assert.ok(S.eff.tornados[0].x >= 1.5 && S.eff.tornados[0].dx > 0, 'bounces off the map edge');
  S.eff.tornados.length = 0;
  // cap of three: the oldest gives way
  for (let i = 0; i < 5; i++) Powers.apply('tornado', 10.5 + i * 10, 80.5, 1, 'tap');
  assert.equal(S.eff.tornados.length, 3);
  assert.deepEqual(S.eff.tornados.map((e) => Math.round(e.x)), [31, 41, 51].map((v) => v), 'newest three kept');
  checkEff(ctx, 'tornados');
  // over deep water it fades much sooner
  S.eff.tornados.length = 0;
  arena(ctx, 20, 60, 12, T.DEEP);
  S.eff.tornados.push({ x: 20.5, y: 60.5, dx: 0, dy: 0, until: S.tick + 450, r: 2, nt: S.tick + 9999 });
  step(ctx, 100);
  assert.equal(S.eff.tornados.length, 1, 'still alive after 100 ticks over water');
  step(ctx, 70);
  assert.equal(S.eff.tornados.length, 0, 'over water the funnel dies in ~150 ticks');
  assert.equal(Powers.errors, 0);
});

// ================================================================== pick
section('pick: unit (kings easier) > building > city > tile; outside = null', () => {
  const ctx = mkCtx();
  const { Powers, S, Const, Buildings } = ctx; const T = Const.T;
  arena(ctx, 48, 48, 20, T.GRASS);
  const c = mkCity(ctx, 34, 34);
  for (const f of [...S.units.values()]) ctx.Units.kill(f, 'test');   // founders wander about; clear the stage
  const h = house(ctx, c.id, 45, 45);
  const u = spawnAt(ctx, 0, 45.5, 45.5);                              // stands on the house tile
  let p = Powers.pick(45.5, 45.5);
  assert.deepEqual([p.type, p.id], ['unit', u.id], 'a unit beats the building under it');
  assert.ok(Math.abs(p.x - u.x) < 1e-9 && Math.abs(p.y - u.y) < 1e-9);
  p = Powers.pick(45.5, 45.5 - 0.3);                                  // the sprite body is a little above its feet
  assert.equal(p.type, 'unit');
  p = Powers.pick(45.5 + 1.0, 45.5);                                  // > 0.9 from the unit: the neighbour tile is empty
  assert.notEqual(p.type, 'unit');
  const king = spawnAt(ctx, 0, 55.5, 55.5); king.isRuler = true;
  const peon = spawnAt(ctx, 0, 60.5, 55.5);
  assert.equal(Powers.pick(55.5 + 1.4, 55.5).type, 'unit', 'a king is picked from 1.4 tiles');
  assert.equal(Powers.pick(55.5 + 1.4, 55.5).id, king.id);
  assert.notEqual(Powers.pick(60.5 + 1.4, 55.5).type, 'unit', 'a commoner is not');
  assert.equal(Powers.pick(60.5 + 0.8, 55.5).id, peon.id);
  // nearest wins
  const a = spawnAt(ctx, 0, 30.2, 60.5), b = spawnAt(ctx, 0, 30.9, 60.5);
  assert.equal(Powers.pick(30.7, 60.2).id, b.id);
  // buildings and cities
  arena(ctx, 20, 20, 0, T.GRASS);
  const h2 = house(ctx, c.id, 38, 34);
  p = Powers.pick(38.5, 34.5);
  assert.deepEqual([p.type, p.id, p.x, p.y], ['building', h2.id, 38, 34]);
  p = Powers.pick(c.x + 1.2, c.y + 0.5);                              // beside the town hall
  assert.deepEqual([p.type, p.id], ['city', c.id], 'near the centre -> the city');
  p = Powers.pick(c.x + 0.5, c.y + 0.5);
  assert.equal(p.type, 'building', 'the town hall itself is a building');
  // owned territory far from the centre -> city
  let owned = null;
  for (let i = 0; i < S.owner.length && !owned; i++) if (S.owner[i] === c.id && Math.hypot((i % S.w) - c.x, ((i / S.w) | 0) - c.y) > 4 && !S.bld[i]) owned = [i % S.w, (i / S.w) | 0];
  assert.ok(owned, 'territory exists');
  p = Powers.pick(owned[0] + 0.5, owned[1] + 0.5);
  assert.deepEqual([p.type, p.id], ['city', c.id], 'inside the borders -> city');
  // free land
  p = Powers.pick(80.5, 80.5);
  assert.deepEqual([p.type, p.x, p.y], ['tile', 80, 80]);
  assert.equal(typeof p.id, 'number');
  // dead units are never picked
  ctx.Units.kill(u, 'test');
  assert.notEqual(Powers.pick(45.5, 45.5).type, 'unit');
  assert.equal(Powers.pick(NaN, 1), null);
  assert.equal(Powers.pick(-0.5, 3), null);
});

// ================================================================== diplomacy tools (neighbours are spied)
section('war_whisper / peace / split: resolve the kingdom, call the API, log, fail politely', () => {
  const ctx = village();
  const { Powers, S, Diplomacy, War, Kingdoms, Const } = ctx;
  const k = [...S.kingdoms.values()][0];
  assert.ok(k, 'a kingdom exists');
  let ruler = S.units.get(k.rulerId);
  if (!ruler) { ruler = [...S.units.values()].find((u) => u.kingdomId === k.id); Kingdoms.setRuler(k.id, ruler); }
  const city = S.cities.get(k.cities[0]);
  const restore = [];
  const calls = { ww: [], dp: [], wp: [], sp: [] };
  let wwRes = true, dpRes = true, wpRes = false, spRes = 77;
  restore.push(patch(Diplomacy, 'godWhisperWar', (kid) => { calls.ww.push(kid); return wwRes; }));
  restore.push(patch(Diplomacy, 'godPeace', (kid) => { calls.dp.push(kid); return dpRes; }));
  restore.push(patch(War, 'godPeace', (kid) => { calls.wp.push(kid); return wpRes; }));
  restore.push(patch(Kingdoms, 'splitCity', (cid) => { calls.sp.push(cid); return spRes; }));
  try {
    const log0 = S.log.length;
    // war whisper on the king
    assert.equal(Powers.apply('war_whisper', ruler.x + 0.8, ruler.y, 1, 'tap'), true);
    assert.deepEqual(calls.ww, [k.id]);
    let e = S.log.slice(log0).find((l) => l.kind === Const.LOG.GOD);
    assert.ok(e && /Шёпот бога склонил/.test(e.msg) && e.msg.includes('«' + ruler.name + '»') && /к войне/.test(e.msg), 'log: ' + (e && e.msg));
    assert.equal(e.kid, k.id);
    assert.ok(kinds(ctx, 'whisper') >= 1);
    // ... on a building / territory of the kingdom
    calls.ww.length = 0;
    const b = ctx.Buildings.byCity(city.id)[0];
    assert.equal(Powers.apply('war_whisper', b.x + 0.5, b.y + 0.5, 1, 'tap'), true);
    assert.deepEqual(calls.ww, [k.id], 'a building resolves to its kingdom');
    calls.ww.length = 0;
    // failure: the API says no
    wwRes = false;
    const l1 = S.log.length;
    assert.equal(Powers.apply('war_whisper', ruler.x, ruler.y, 1, 'tap'), false);
    assert.match(Powers.lastMessage, /нет соседей/);
    assert.ok(!S.log.slice(l1).some((l) => l.kind === Const.LOG.GOD), 'failures are not chronicled');
    wwRes = { aggressor: k.id, defender: 9999 };                       // a War object naming the enemy
    calls.ww.length = 0;
    assert.equal(Powers.apply('war_whisper', ruler.x, ruler.y, 1, 'tap'), true);
    // nothing there
    calls.ww.length = 0;
    assert.equal(Powers.apply('war_whisper', 3.5, 3.5, 1, 'tap'), false);
    assert.deepEqual(calls.ww, [], 'not called without a target');
    assert.equal(Powers.apply('war_whisper', -4, 3.5, 1, 'tap'), false);
    // peace: both APIs are called, either success counts
    const l2 = S.log.length;
    assert.equal(Powers.apply('peace', city.x + 0.5, city.y + 0.5, 1, 'tap'), true);
    assert.deepEqual([calls.dp, calls.wp], [[k.id], [k.id]]);
    assert.ok(S.log.slice(l2).some((l) => l.kind === Const.LOG.GOD && /мир/i.test(l.msg)));
    dpRes = false; wpRes = true;
    assert.equal(Powers.apply('peace', city.x + 0.5, city.y + 0.5, 1, 'tap'), true, 'War.godPeace alone is enough');
    wpRes = false;
    assert.equal(Powers.apply('peace', city.x + 0.5, city.y + 0.5, 1, 'tap'), false);
    assert.match(Powers.lastMessage, /ни с кем не воюет/);
    assert.equal(Powers.apply('peace', 3.5, 3.5, 1, 'tap'), false);
    // split
    const l3 = S.log.length;
    assert.equal(Powers.apply('split', city.x + 0.5, city.y + 0.5, 1, 'tap'), true);
    assert.deepEqual(calls.sp, [city.id]);
    assert.ok(S.log.slice(l3).some((l) => l.kind === Const.LOG.GOD && l.msg.includes('«' + city.name + '»')));
    calls.sp.length = 0;
    const b2 = ctx.Buildings.byCity(city.id).find((x) => x.x !== city.x || x.y !== city.y);
    if (b2) { assert.equal(Powers.apply('split', b2.x + 0.5, b2.y + 0.5, 1, 'tap'), true); assert.deepEqual(calls.sp, [city.id], 'tapping a building of the city splits that city'); }
    calls.sp.length = 0;
    spRes = 0;
    assert.equal(Powers.apply('split', city.x + 1.2, city.y + 0.5, 1, 'tap'), false);
    assert.match(Powers.lastMessage, /нельзя отделить/);
    calls.sp.length = 0;
    assert.equal(Powers.apply('split', 3.5, 3.5, 1, 'tap'), false);
    assert.deepEqual(calls.sp, [], 'no city, no call');
    assert.equal(Powers.errors, 0);
  } finally { restore.forEach((r) => r()); }
});

section('diplomacy tools with the real (or stub) Diplomacy / War / Kingdoms do not throw', () => {
  const ctx = village();
  const { Powers, S } = ctx;
  const k = [...S.kingdoms.values()][0];
  const c = S.cities.get(k.cities[0]);
  for (const id of ['war_whisper', 'peace', 'split', 'inspect']) {
    assert.equal(typeof Powers.apply(id, c.x + 0.5, c.y + 0.5, 1, 'tap'), 'boolean');
  }
  step(ctx, 100);
  assert.equal(Powers.errors, 0);
});

// ================================================================== persistence / determinism / robustness
section('S.eff JSON round trip with every effect active; afterLoad repairs damaged data; sim continues', () => {
  const ctx = village();
  const { Powers, S, Const } = ctx; const T = Const.T;
  const c = firstCity(ctx);
  Powers.apply('meteor', c.x + 8.5, c.y + 0.5, 4, 'tap');
  Powers.apply('earthquake', c.x - 8.5, c.y + 0.5, 4, 'tap');
  Powers.apply('tornado', c.x + 0.5, c.y + 8.5, 1, 'tap');
  Powers.apply('rain', c.x + 0.5, c.y - 8.5, 5, 'tap');
  assert.deepEqual(Powers.active(), { meteors: 1, tornados: 1, rains: 1, quakes: 1 });
  step(ctx, 5);
  checkEff(ctx, 'mid-flight');
  const saved = JSON.stringify(S.eff);
  const snapshot = JSON.parse(saved);
  S.eff = JSON.parse(saved);
  Powers.afterLoad();
  assert.deepEqual(S.eff, snapshot, 'afterLoad keeps good data as it is');
  step(ctx, 700);
  assert.equal(Powers.errors, 0);
  assert.deepEqual(Powers.active(), { meteors: 0, tornados: 0, rains: 0, quakes: 0 });
  // damaged data (old / hand-edited saves)
  S.eff = { meteors: [{ x: 'a', y: 1 }, { x: 5, y: 5, r: 3, eta: S.tick + 3, t0: S.tick }], tornados: [{ x: 5, y: 5, until: S.tick + 10 }, null], rains: [{ x: NaN, y: 3, r: 2, until: 5 }], quakes: [{ x: 10, y: 10, r: 3, until: S.tick + 20 }, { x: 1 }] };
  Powers.afterLoad();
  assert.deepEqual(Powers.active(), { meteors: 1, tornados: 1, rains: 0, quakes: 1 });
  step(ctx, 40);
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
  // effects pushed by other modules (e.g. a demo) without the private bookkeeping still behave and never produce NaN
  S.eff = { meteors: [], tornados: [{ x: 20, y: 20, until: S.tick + 30 }], rains: [{ x: 30, y: 30, r: 3, until: S.tick + 30 }], quakes: [{ x: 60, y: 60, r: 3, until: S.tick + 20 }] };
  step(ctx, 35);
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
  assert.deepEqual(Powers.active(), { meteors: 0, tornados: 0, rains: 0, quakes: 0 });
  S.eff = {};                                                          // a save from before S.eff existed
  Powers.afterLoad();
  assert.deepEqual(Powers.active(), { meteors: 0, tornados: 0, rains: 0, quakes: 0 });
  assert.doesNotThrow(() => { Powers.step(S.tick); Powers.apply('rain', 20.5, 20.5, 3, 'tap'); });
  assert.equal(S.eff.rains.length, 1);
  // new world clears everything
  ctx.Sim.newWorld({ seed: 5, w: 96, h: 96, populate: false });
  assert.deepEqual(Powers.active(), { meteors: 0, tornados: 0, rains: 0, quakes: 0 });
});

section('Save.serialize / deserialize in the middle of every effect: the run continues identically', () => {
  const build = () => {
    const ctx = village(3);
    const { Powers } = ctx;
    const c = firstCity(ctx);
    Powers.apply('earthquake', c.x + 2.5, c.y + 0.5, 4, 'tap');
    Powers.apply('tornado', c.x - 4.5, c.y + 0.5, 1, 'tap');
    Powers.apply('rain', c.x + 0.5, c.y - 5.5, 4, 'tap');
    Powers.apply('meteor', c.x + 6.5, c.y + 5.5, 3, 'tap');
    step(ctx, 4);
    return ctx;
  };
  const sig = (ctx) => { const { S } = ctx; let h = 0; for (let i = 0; i < S.tile.length; i++) h = (Math.imul(h, 31) + S.tile[i] * 7 + S.elev[i] + S.fire[i]) | 0; return JSON.stringify([h, S.units.size, S.buildings.size, ctx.R.getState(), S.eff]); };
  const a = build(), b = build();
  assert.deepEqual(a.Powers.active(), { meteors: 1, tornados: 1, rains: 1, quakes: 1 });
  assert.equal(b.Save.deserialize(b.Save.serialize()), true);
  assert.deepEqual(b.S.eff, a.S.eff, 'effects survive a save / load unchanged');
  // the reference run rebuilds the same private caches a load rebuilds (World's fire / lava lists are re-ordered by a load)
  a.World.afterLoad(); a.Units.afterLoad(); a.Cities.afterLoad(); a.Buildings.afterLoad(); a.Powers.afterLoad();
  step(a, 160); step(b, 160);
  assert.equal(sig(a), sig(b), 'identical world after reload');
  assert.equal(a.Powers.errors + b.Powers.errors, 0);
});

section('determinism: same seed + same god actions -> identical world', () => {
  const run = () => {
    const ctx = village(4);
    const { Powers, S } = ctx;
    const c = firstCity(ctx);
    for (let i = 0; i < 400; i++) {
      if (i % 40 === 0) Powers.apply('meteor', c.x + 0.5 + (i % 3) * 3, c.y + 0.5, 3, 'tap');
      if (i % 90 === 0) Powers.apply('tornado', c.x + 0.5, c.y + 0.5, 1, 'tap');
      if (i % 70 === 0) Powers.apply('earthquake', c.x + 0.5, c.y - 3.5, 3, 'tap');
      if (i % 50 === 0) Powers.apply('fire', c.x + 4.5, c.y + 0.5, 3, 'tap');
      if (i % 60 === 0) Powers.apply('rain', c.x + 4.5, c.y + 0.5, 4, 'tap');
      if (i % 80 === 0) Powers.apply('plague', c.x + 0.5, c.y + 0.5, 3, 'tap');
      step(ctx, 1);
    }
    let h = 0;
    for (let i = 0; i < S.tile.length; i++) h = (Math.imul(h, 31) + S.tile[i] * 7 + S.elev[i] + S.fire[i]) | 0;
    return { h, units: S.units.size, rng: ctx.R.getState(), eff: JSON.stringify(S.eff) };
  };
  const a = run(), b = run();
  assert.deepEqual(a, b);
});

section('robust against stubbed neighbours (Units / Cities / Buildings / Kingdoms / Diplomacy / War missing)', () => {
  const ctx = loadSim({ stub: ['Units', 'Cities', 'Buildings', 'Kingdoms', 'Diplomacy', 'War', 'Sim'] });
  newWorld(ctx, 3, 96, 96);
  const { Powers, ToolDefs, S, World } = ctx;
  arena({ ...ctx, Buildings: { destroyAt() {} } }, 48, 48, 10, ctx.Const.T.FOREST);
  for (const t of ToolDefs) for (const ph of ['tap', 'start', 'move', 'end']) assert.doesNotThrow(() => Powers.apply(t.id, 48.5, 48.5, 3, ph), t.id);
  for (let i = 0; i < 80; i++) { S.tick++; World.step(S.tick); Powers.step(S.tick); }
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
});

section('fuzz: 3000 random god actions (all tools / phases / radii / bad coordinates) while the sim runs', () => {
  const ctx = village(5);
  const { Powers, ToolDefs, S, Const, R } = ctx;
  const phases = ['tap', 'start', 'move', 'move', 'move', 'end'];
  let rs = 12345;
  const rnd = () => { rs = (Math.imul(rs, 1664525) + 1013904223) | 0; return (rs >>> 0) / 4294967296; };
  const ids = ToolDefs.map((t) => t.id);
  let x = 48, y = 48, trues = 0;
  for (let i = 0; i < 3000; i++) {
    const id = ids[(rnd() * ids.length) | 0];
    if (rnd() < 0.8) { x = Math.max(-3, Math.min(S.w + 3, x + (rnd() - 0.5) * 6)); y = Math.max(-3, Math.min(S.h + 3, y + (rnd() - 0.5) * 6)); }
    else { x = rnd() * S.w; y = rnd() * S.h; }
    const ph = phases[(rnd() * phases.length) | 0];
    if (Powers.apply(id, x, y, 1 + ((rnd() * 8) | 0), ph)) trues++;
    if (i % 3 === 0) step(ctx, 1);
    if (i % 500 === 0) checkEff(ctx, 'fuzz ' + i);
  }
  step(ctx, 500);
  checkEff(ctx, 'fuzz end');
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
  for (const u of S.units.values()) assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y) && u.x >= 0 && u.y >= 0 && u.x < S.w && u.y < S.h, 'unit position sane');
  for (let i = 0; i < S.tile.length; i++) assert.ok(S.tile[i] < Const.TILE_COUNT);
  for (const l of Object.values(S.eff)) for (const e of l) for (const k in e) if (typeof e[k] === 'number') assert.ok(Number.isFinite(e[k]), 'finite effect field ' + k);
  note(`${trues} of 3000 actions took effect; ${S.units.size} units, ${S.cities.size} cities, ${S.kingdoms.size} kingdoms alive`);
  assert.ok(trues > 300);
});

// ================================================================== performance
section('performance: 600 ticks with every power active', () => {
  const ctx = village(3);
  const { Powers, S, Sim } = ctx;
  const c = firstCity(ctx);
  const stepMs = [];
  const orig = Powers.step;
  Powers.step = (t) => { const t0 = performance.now(); orig(t); stepMs.push(performance.now() - t0); };
  Sim.refresh && Sim.refresh();
  // pile up units so the area powers have crowds to chew on
  for (let i = 0; i < 200; i++) { const a = i * 2.4, d = 2 + (i % 17); ctx.Units.spawn(i % 3, c.x + 0.5 + Math.cos(a) * d, c.y + 0.5 + Math.sin(a) * d, {}); }
  const tot0 = performance.now();
  for (let i = 0; i < 600; i++) {
    const a = i * 0.37, x = c.x + 0.5 + Math.cos(a) * 10, y = c.y + 0.5 + Math.sin(a) * 10;
    if (i % 30 === 0) Powers.apply('meteor', x, y, 4, 'tap');
    if (i % 25 === 0) Powers.apply('tornado', x, y, 1, 'tap');
    if (i % 20 === 0) Powers.apply('earthquake', x, y, 5, 'tap');
    if (i % 10 === 0) Powers.apply('rain', x, y, 4, 'tap');
    if (i % 15 === 0) Powers.apply('fire', x, y, 3, 'tap');
    if (i % 45 === 0) Powers.apply('plague', x, y, 4, 'tap');
    if (i % 40 === 0) Powers.apply('lightning', x, y, 1, 'tap');
    if (i % 35 === 0) Powers.apply('heal', x, y, 4, 'tap');
    if (i % 3 === 0) Powers.apply('grass', x, y, 3, i % 30 === 0 ? 'start' : 'move');
    step(ctx, 1);
    if (i % 100 === 0) checkEff(ctx, 'perf run tick ' + i);
  }
  Powers.step = orig;
  const total = performance.now() - tot0;
  stepMs.sort((p, q) => p - q);
  const avg = stepMs.reduce((s, v) => s + v, 0) / stepMs.length, p99 = stepMs[(stepMs.length * 0.99) | 0], max = stepMs[stepMs.length - 1];
  note(`Powers.step: avg ${avg.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms, max ${max.toFixed(2)} ms over ${stepMs.length} ticks; whole sim+powers ${(total / 600).toFixed(2)} ms/tick; units ${S.units.size}`);
  assert.ok(avg < 0.6, 'Powers.step stays cheap on average');
  assert.ok(p99 < 4, 'and rarely spikes');
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
  // single-call costs
  const timeOf = (label, fn) => { const t0 = performance.now(); fn(); const d = performance.now() - t0; note(`${pad(label, 28)} ${d.toFixed(2)} ms`); return d; };
  const big = mkCtx(); arena(big, 48, 48, 25, big.Const.T.GRASS);
  for (let i = 0; i < 400; i++) big.Units.spawn(i % 3, 48.5 + Math.cos(i) * (i % 20) * 0.7, 48.5 + Math.sin(i) * (i % 20) * 0.7, {});
  assert.ok(timeOf('brush r=8 (raise)', () => big.Powers.apply('raise', 48.5, 48.5, 8, 'tap')) < 15);
  assert.ok(timeOf('meteor r=6 impact', () => { big.Powers.apply('meteor', 48.5, 48.5, 6, 'tap'); step(big, 9); }) < 30);
  assert.ok(timeOf('erase r=8 (crowd of 400)', () => big.Powers.apply('erase', 48.5, 48.5, 8, 'tap')) < 15);
  assert.equal(big.Powers.errors, 0);
});

// ------------------------------------------------------------------ summary
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
if (failed.length) process.exit(1);
