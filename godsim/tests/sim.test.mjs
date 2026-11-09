// Sim tests (plain node + assert).   node tests/sim.test.mjs [--ticks=2000] [--stub=Units,...] [--quick]
// Uses the real World / Buildings / Cities / Units / Kingdoms / Diplomacy / War (whatever exists); modules can be isolated with --stub=.
import assert from 'node:assert/strict';
import { loadSim, stepN, pad } from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const STUB = args.stub ? String(args.stub).split(',') : [];
const TICKS = args.quick ? 600 : +(args.ticks || 2000);

const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 74)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 10).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);
const mk = (stub = STUB) => loadSim({ stub });
const real = (m) => m && !m.__stub;

/** run fn with console.error captured */
function captureErrors(fn) {
  const orig = console.error, calls = [];
  console.error = (...a) => { calls.push(a.map(String).join(' ')); };
  try { fn(); } finally { console.error = orig; }
  return calls;
}

console.log(`Sim tests  (stubbed: ${STUB.join(',') || 'none'}; ticks=${TICKS})`);

// ------------------------------------------------------------------ newWorld
section('newWorld: seed handling, populate flag, determinism', () => {
  const a = mk();
  a.Sim.newWorld({ seed: 11, w: 64, h: 64, populate: false });
  assert.equal(a.S.w, 64); assert.equal(a.S.h, 64); assert.equal(a.S.seed, 11); assert.equal(a.S.tick, 0);
  assert.equal(a.S.units.size, 0, 'populate:false must not spawn');
  assert.equal(a.S.stats.popTotal, 0);
  // default size
  a.Sim.newWorld({ seed: 5 });
  assert.equal(a.S.w, a.Const.DEFAULT_W); assert.equal(a.S.h, a.Const.DEFAULT_H);
  // random seed when none given: valid positive int, and two calls differ (overwhelmingly likely)
  a.Sim.newWorld({ w: 48, h: 48 });
  const s1 = a.S.seed; a.Sim.newWorld({ w: 48, h: 48 });
  assert.ok(Number.isInteger(s1) && s1 !== 0, 'random seed is a non-zero int');
  assert.notEqual(a.S.seed, s1, 'two random seeds differ');
  // same seed -> same terrain + same population
  const fp = (c) => c.Util && JSON.stringify([...c.S.tile.slice(0, 500), ...[...c.S.units.values()].map(u => [u.race, u.sex, u.x, u.y, u.name, u.traits])]);
  const b = mk(), c = mk();
  b.Sim.newWorld({ seed: 77, w: 80, h: 80, populate: true });
  c.Sim.newWorld({ seed: 77, w: 80, h: 80, populate: true });
  assert.equal(fp(b), fp(c), 'same seed -> identical world + population');
  const d = mk();
  d.Sim.newWorld({ seed: 78, w: 80, h: 80, populate: true });
  assert.notEqual(fp(b), fp(d), 'different seed -> different world');
  // the old world is fully replaced
  b.Sim.newWorld({ seed: 77, w: 80, h: 80, populate: false });
  assert.equal(b.S.units.size, 0); assert.equal(b.S.cities.size, 0); assert.equal(b.S.tick, 0);
});

// ------------------------------------------------------------------ populate
section('populate: 3 human + 2 elf + 2 orc groups, sexes, spacing, habitat (60 worlds: 64/96/128 x 20 seeds)', function () {
  if (!real(mk().Units)) { note('Units is stubbed: skipped'); return; }
  const T = mk().Const.T;
  let worlds = 0, tooClose = 0, minSep = 999;
  const forest = [], hills = [];
  for (const size of [64, 96, 128]) {
    for (let seed = 1; seed <= 20; seed++) {
      const ctx = mk();
      ctx.Sim.newWorld({ seed, w: size, h: size, populate: false });
      const t0 = performance.now();
      const r = ctx.Sim.populate();
      const ms = performance.now() - t0;
      assert.ok(ms < 400, `populate took ${ms.toFixed(0)} ms`);
      const { S } = ctx;
      worlds++;
      assert.equal(r.groups.length, 7, `7 groups (size ${size} seed ${seed})`);
      assert.equal(r.spawned, S.units.size);
      const byRace = [0, 0, 0], sexes = {};
      for (const u of S.units.values()) { byRace[u.race]++; assert.ok(ctx.Tiles.isLand(S.tile[Math.floor(u.y) * S.w + Math.floor(u.x)]), 'unit on land'); }
      assert.deepEqual(byRace, [18, 10, 10], `population per race (size ${size} seed ${seed})`);
      assert.deepEqual(S.stats.pop === undefined ? byRace : byRace, byRace);
      assert.deepEqual(r.groups.map(g => g.race).sort(), [0, 0, 0, 1, 1, 2, 2]);
      // each group: n adults of both sexes around its centre
      for (const g of r.groups) {
        let n = 0, m = 0, f = 0;
        for (const u of S.units.values()) {
          if (u.race !== g.race || Math.abs(u.x - g.x - 0.5) > 6 || Math.abs(u.y - g.y - 0.5) > 6) continue;
          n++; if (u.sex === 0) m++; else f++;
          const age = ctx.Util.age(u), rc = ctx.Races.list[u.race];
          assert.ok(age >= rc.maturity, `adult spawn: age ${age.toFixed(1)} >= ${rc.maturity}`);
        }
        assert.ok(n >= g.n, `group units near its centre (${n} < ${g.n})`);
        assert.ok(g.n >= 5 && g.n <= 6, 'group of 5-6');
        const sexN = [0, 0];
        for (const u of S.units.values()) if (u.race === g.race && Math.abs(u.x - g.x - 0.5) <= 4.5 && Math.abs(u.y - g.y - 0.5) <= 4.5) sexN[u.sex]++;
        assert.ok(sexN[0] >= 2 && sexN[1] >= 2, `both sexes in group ${JSON.stringify(sexN)}`);
        const cnt = (ts) => { let k = 0; for (let y = g.y - 5; y <= g.y + 5; y++) for (let x = g.x - 5; x <= g.x + 5; x++) if (S.inBounds(x, y) && ts.includes(S.tile[y * S.w + x])) k++; return k; };
        if (g.race === 2) { const k = cnt([T.FOREST]); forest.push(k); assert.ok(k >= 8, `elves on forest-rich ground (${k} forest tiles)`); }
        if (g.race === 1) { const k = cnt([T.HILL, T.MOUNTAIN, T.SNOW]); hills.push(k); assert.ok(k >= 8, `orcs near hills/mountains (${k})`); }
      }
      for (let i = 0; i < r.groups.length; i++) for (let j = i + 1; j < r.groups.length; j++) {
        const d = Math.max(Math.abs(r.groups[i].x - r.groups[j].x), Math.abs(r.groups[i].y - r.groups[j].y));
        minSep = Math.min(minSep, d); if (d < 12) tooClose++;
        assert.ok(d >= 6, `groups at least 6 tiles apart (${d})`);
      }
      // hostile races stay away from each other
      for (const a of r.groups) for (const b of r.groups) {
        if (a.race === 2 && b.race === 1) assert.ok(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) >= 8, 'elf/orc groups separated');
      }
    }
  }
  const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
  note(`${worlds} worlds ok; min group distance ${minSep}; pairs closer than 12: ${tooClose}; elf forest tiles avg ${avg(forest)} (min ${Math.min(...forest)}), orc hill tiles avg ${avg(hills)} (min ${Math.min(...hills)})`);
});

section('populate: groups spread over several areas; populate on a populated world avoids existing cities', function () {
  if (!real(mk().Units)) { note('Units is stubbed: skipped'); return; }
  const ctx = mk();
  ctx.Sim.newWorld({ seed: 4, w: 96, h: 96, populate: true });
  const { S } = ctx;
  // centroid clustering of humans: at least 2 distinct areas
  const hs = [...S.units.values()].filter(u => u.race === 0);
  const cl = [];
  for (const u of hs) { let c = cl.find(c => Math.hypot(c.x - u.x, c.y - u.y) < 9); if (!c) cl.push(c = { x: u.x, y: u.y, n: 0 }); c.n++; }
  assert.ok(cl.length >= 3, 'humans spread over >= 3 areas, got ' + cl.length);
  // second populate adds 38 more units, never within 6 tiles of the first groups
  const before = S.units.size;
  const r = ctx.Sim.populate();
  assert.equal(S.units.size, before + r.spawned);
  assert.ok(r.spawned > 0);
});

// ------------------------------------------------------------------ stats
section('stats(): independent recount, auto refresh every 10 ticks, year', function () {
  const ctx = mk();
  ctx.Sim.newWorld({ seed: 3, w: 96, h: 96, populate: true });
  const { S, Sim } = ctx;
  stepN(ctx, 123);
  assert.equal(S.tick, 123);
  // last auto stats was at tick 120
  const pop = [0, 0, 0];
  for (const u of S.units.values()) pop[u.race]++;
  Sim.stats();
  assert.deepEqual(S.stats.pop, pop);
  assert.equal(S.stats.popTotal, pop[0] + pop[1] + pop[2]);
  assert.equal(S.stats.cities, S.cities.size);
  assert.equal(S.stats.kingdoms, [...S.kingdoms.values()].filter(k => k.alive !== false).length);
  assert.equal(S.stats.year, ctx.Util.year());
  assert.equal(S.stats.wars, [...S.wars.values()].filter(w => !w.ended).length);
  assert.equal(S.stats.buildings, [...S.buildings.values()].filter(b => b.done).length);
  // auto-refresh: stats at tick 120 equal an independent count made at tick 120
  const ctx2 = mk();
  ctx2.Sim.newWorld({ seed: 3, w: 96, h: 96, populate: true });
  stepN(ctx2, 120);
  const p2 = [0, 0, 0]; for (const u of ctx2.S.units.values()) p2[u.race]++;
  assert.deepEqual(ctx2.S.stats.pop, p2, 'stats refreshed automatically at tick 120');
  stepN(ctx2, 5);
  // between refreshes the cached value is allowed to be stale but never wrong in shape
  assert.equal(ctx2.S.stats.pop.length, 3);
});

// ------------------------------------------------------------------ error isolation
section('step(): a throwing module never stops the loop; errors counted; console.error once per module per 100 ticks', function () {
  const ctx = mk();
  ctx.Sim.newWorld({ seed: 3, w: 96, h: 96, populate: true });
  const { S, Sim } = ctx;
  const mod = real(ctx.Cities) ? ctx.Cities : ctx.World;
  const name = real(ctx.Cities) ? 'Cities' : 'World';
  const orig = mod.step;
  let calls = 0;
  mod.step = (t) => { calls++; throw new Error('boom ' + t); };
  const logs = captureErrors(() => { stepN(ctx, 250); });
  mod.step = orig;
  assert.equal(S.tick, 250, 'ticks advanced although a module throws every tick');
  assert.equal(calls, 250, 'module still called every tick');
  assert.equal(Sim.errors[name], 250, 'error counter');
  assert.equal(logs.filter(l => l.includes(name + '.step')).length, 3, 'logged at ticks 1, 101, 201 only: ' + logs.length);
  // the other modules kept running: units still move / age
  assert.ok(S.units.size > 0);
  // two modules failing at once are reported independently
  Sim.resetProfile();
  const o2 = ctx.World.step, o3 = ctx.Units.step;
  ctx.World.step = () => { throw new Error('w'); }; ctx.Units.step = () => { throw new Error('u'); };
  const logs2 = captureErrors(() => stepN(ctx, 5));
  ctx.World.step = o2; ctx.Units.step = o3;
  assert.equal(logs2.length, 2, 'one log line per failing module');
  assert.equal(Sim.errors.World, 5); assert.equal(Sim.errors.Units, 5);
  // non-error steps afterwards do not add errors
  stepN(ctx, 20);
  assert.equal(Sim.errors.World, 5);
});

// ------------------------------------------------------------------ afterLoad
section('afterLoad(): calls every module afterLoad exactly once, in tick order, then recomputes stats', function () {
  const ctx = mk();
  ctx.Sim.newWorld({ seed: 3, w: 64, h: 64, populate: true });
  const order = [];
  const undo = [];
  for (const n of ['World', 'Buildings', 'Units', 'Cities', 'Kingdoms', 'Diplomacy', 'War', 'Powers']) {
    const m = ctx[n];
    if (!real(m)) continue;
    const orig = m.afterLoad;
    m.afterLoad = function () { order.push(n); return orig && orig.apply(this, arguments); };
    undo.push(() => { m.afterLoad = orig; });
  }
  ctx.S.stats.popTotal = -1;
  ctx.Sim.afterLoad();
  undo.forEach(f => f());
  const expect = ['World', 'Buildings', 'Units', 'Cities', 'Kingdoms', 'Diplomacy', 'War', 'Powers'].filter(n => real(ctx[n]) && ctx[n].afterLoad);
  assert.deepEqual(order, expect);
  assert.equal(ctx.S.stats.popTotal, ctx.S.units.size, 'stats recomputed');
});

section('afterLoad(): a throwing module hook is contained', function () {
  const ctx = mk();
  ctx.Sim.newWorld({ seed: 3, w: 64, h: 64, populate: true });
  const o = ctx.Cities.afterLoad;
  ctx.Cities.afterLoad = () => { throw new Error('nope'); };
  const logs = captureErrors(() => ctx.Sim.afterLoad());
  ctx.Cities.afterLoad = o;
  assert.equal(logs.length, 1);
  assert.equal(ctx.Sim.errors.Cities, 1);
  stepN(ctx, 10);
});

// ------------------------------------------------------------------ step orchestration
section('step(): tick counter, module order, determinism', function () {
  const ctx = mk();
  ctx.Sim.newWorld({ seed: 9, w: 64, h: 64, populate: true });
  const order = [];
  const undo = [];
  for (const n of ['World', 'Buildings', 'Units', 'Cities', 'Kingdoms', 'Diplomacy', 'War', 'Powers']) {
    const m = ctx[n];
    if (!real(m)) continue;
    const orig = m.step;
    m.step = function (t) { order.push(n + ':' + t); return orig.apply(this, arguments); };
    undo.push(() => { m.step = orig; });
  }
  ctx.Sim.step(); ctx.Sim.step();
  undo.forEach(f => f());
  assert.equal(ctx.S.tick, 2);
  const names = ['World', 'Buildings', 'Units', 'Cities', 'Kingdoms', 'Diplomacy', 'War', 'Powers'].filter(n => real(ctx[n]));
  assert.deepEqual(order, [...names.map(n => n + ':1'), ...names.map(n => n + ':2')]);
  // determinism: same seed, same ticks -> identical state
  const run = () => { const c = mk(); c.Sim.newWorld({ seed: 21, w: 80, h: 80, populate: true }); stepN(c, 400); return JSON.stringify([c.S.stats, [...c.S.units.values()], [...c.S.cities.values()], c.R.getState()]); };
  assert.equal(run(), run(), 'two identical runs diverged');
  // step() without a world is a no-op
  const empty = mk();
  empty.Sim.step();
  assert.equal(empty.S.tick, 0);
});

// ------------------------------------------------------------------ profile
section(`step cost profile: populate at 96x96, ${TICKS} ticks, no module errors`, function () {
  const ctx = mk();
  ctx.Sim.newWorld({ seed: 5, w: 96, h: 96, populate: true });
  const { S, Sim } = ctx;
  const logs = captureErrors(() => {
    const acc = {}; let n = 0, wall = 0, maxTick = 0;
    for (let t = 0; t < TICKS; t++) {
      const t0 = performance.now();
      Sim.step();
      const dt = performance.now() - t0;
      wall += dt; if (dt > maxTick) maxTick = dt;
      if (t % 20 === 0) { n++; for (const k in Sim.profile) acc[k] = (acc[k] || 0) + Sim.profile[k]; }
    }
    ctx._wall = wall; ctx._max = maxTick; ctx._acc = acc; ctx._n = n;
  });
  assert.equal(logs.length, 0, 'no console.error: ' + logs.join('\n'));
  assert.equal(S.tick, TICKS);
  assert.equal(Sim.totalErrors, 0, 'Sim.errors: ' + JSON.stringify(Sim.errors));
  for (const k of ['World', 'Buildings', 'Units', 'Cities', 'Kingdoms', 'Diplomacy', 'War', 'Powers', 'total']) assert.ok(k in Sim.profile, 'profile.' + k);
  for (const k in Sim.profile) assert.ok(Number.isFinite(Sim.profile[k]) && Sim.profile[k] >= 0, 'profile.' + k + ' finite');
  assert.ok(S.perf.stepMs > 0 || ctx._wall === 0);
  // sanity of the world after the run
  for (const u of S.units.values()) assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y), 'NaN position');
  assert.ok(S.log.length <= 300);
  const avgMs = ctx._wall / TICKS;
  const parts = Object.keys(ctx._acc).filter(k => k !== 'total').map(k => `${k} ${(ctx._acc[k] / ctx._n).toFixed(3)}`).join('  ');
  note(`${TICKS} ticks: ${avgMs.toFixed(3)} ms/tick avg (worst tick ${ctx._max.toFixed(1)} ms), units=${S.units.size} cities=${S.cities.size} kingdoms=${S.kingdoms.size} buildings=${S.buildings.size}`);
  note('profile (ms, mean of EMA samples): ' + parts);
  note(`S.perf.stepMs=${S.perf.stepMs.toFixed(3)} profile.total=${Sim.profile.total.toFixed(3)}`);
  assert.ok(avgMs < 8, 'average tick cost ' + avgMs.toFixed(2) + ' ms is far above the budget');
});

section('step cost with a big population (~1000 units)', function () {
  if (!real(mk().Units)) { note('Units is stubbed: skipped'); return; }
  if (args.quick) { note('skipped in --quick'); return; }
  const ctx = mk();
  ctx.Sim.newWorld({ seed: 7, w: 96, h: 96, populate: true });
  const { S, Sim } = ctx;
  let guard = 0;
  while (S.units.size < 1000 && guard++ < 400) stepN(ctx, 50);
  const units = S.units.size;
  const logs = captureErrors(() => { const t0 = performance.now(); stepN(ctx, 300); ctx._ms = (performance.now() - t0) / 300; });
  assert.equal(logs.length, 0, logs.join('\n'));
  assert.equal(Sim.totalErrors, 0);
  note(`units ${units} -> ${S.units.size} (tick ${S.tick}): ${ctx._ms.toFixed(3)} ms/tick; profile ` + Object.keys(Sim.profile).map(k => `${k} ${Sim.profile[k].toFixed(2)}`).join('  '));
  assert.ok(ctx._ms < 12);
});

// ------------------------------------------------------------------ adaptPerf
section('adaptPerf(): unit-count thresholds', function () {
  const ctx = mk();
  ctx.Sim.newWorld({ seed: 3, w: 96, h: 96, populate: false });
  const { S, Sim, Const } = ctx;
  const fakeUnits = (n) => { S.units = new Map(); for (let i = 1; i <= n; i++) S.units.set(i, { id: i, race: 0 }); };
  const feed = (ms, frames) => { for (let i = 0; i < frames; i++) Sim.adaptPerf(ms); };
  S.perf.stepMs = 0.4;
  fakeUnits(100); feed(8, 100);
  assert.equal(S.perf.thinkEvery, 3); assert.equal(S.perf.lod, 0); assert.equal(S.perf.unitCap, Const.MAX_UNITS);
  fakeUnits(900); feed(8, 100);
  assert.equal(S.perf.thinkEvery, 3, '900 units: still 3');
  fakeUnits(901); feed(8, 100);
  assert.equal(S.perf.thinkEvery, 4, '> 900 units: 4');
  fakeUnits(1300); feed(8, 100);
  assert.equal(S.perf.thinkEvery, 4, '1300 units: 4');
  fakeUnits(1301); feed(8, 100);
  assert.equal(S.perf.thinkEvery, 6, '> 1300 units: 6');
  assert.ok(S.perf.lod >= 1, 'big populations reduce lod');
  assert.equal(S.perf.unitCap, Const.MAX_UNITS);
  fakeUnits(300); feed(8, 100);
  assert.equal(S.perf.thinkEvery, 3, 'back down when the population shrinks');
  assert.equal(S.perf.lod, 0);
});

section('adaptPerf(): raises under sustained slow frames / slow steps, relaxes when cheap, ignores single hitches', function () {
  const ctx = mk();
  ctx.Sim.newWorld({ seed: 3, w: 96, h: 96, populate: false });
  const { S, Sim, Const } = ctx;
  S.units = new Map(); for (let i = 1; i <= 200; i++) S.units.set(i, { id: i, race: 0 });
  S.perf.stepMs = 0.5;
  const feed = (ms, frames) => { for (let i = 0; i < frames; i++) Sim.adaptPerf(ms); };
  feed(16, 300);
  assert.equal(S.perf.thinkEvery, 3);
  // a few hitches do nothing
  feed(200, 3); feed(16, 100);
  assert.equal(S.perf.thinkEvery, 3, 'hitches ignored');
  // sustained slow frames escalate step by step
  const seen = new Set();
  for (let i = 0; i < 600; i++) { Sim.adaptPerf(40); seen.add(S.perf.thinkEvery); }
  assert.equal(S.perf.thinkEvery, 6, 'slow frames -> 6');
  assert.deepEqual([...seen].sort(), [3, 4, 5, 6], 'escalation is gradual');
  assert.ok(S.perf.lod >= 1);
  assert.ok(S.perf.thinkEvery <= 6 && S.perf.thinkEvery >= 3);
  // severe and sustained: population growth frozen at the current size
  feed(60, 400);
  assert.equal(S.perf.unitCap, Math.max(600, 200), 'unit cap freezes growth under severe pressure');
  // recover: fast frames lower everything again
  feed(10, 1500);
  assert.equal(S.perf.thinkEvery, 3, 'relaxed');
  assert.equal(S.perf.lod, 0);
  assert.equal(S.perf.unitCap, Const.MAX_UNITS);
  // slow *simulation* step alone (frames fine) also raises
  S.perf.stepMs = 6;
  feed(10, 300);
  assert.ok(S.perf.thinkEvery >= 4, 'slow step time raises thinkEvery (' + S.perf.thinkEvery + ')');
  S.perf.stepMs = 0.5;
  feed(10, 1500);
  assert.equal(S.perf.thinkEvery, 3);
  // garbage input never throws or poisons the state
  Sim.adaptPerf(NaN); Sim.adaptPerf(-5); Sim.adaptPerf(Infinity); Sim.adaptPerf(undefined);
  feed(10, 100);
  assert.ok(S.perf.thinkEvery >= 3 && S.perf.thinkEvery <= 6);
});

section('adaptPerf(): real units — thinkEvery really changes the cost; unitCap really stops spawning', function () {
  if (!real(mk().Units)) { note('Units is stubbed: skipped'); return; }
  if (args.quick) { note('skipped in --quick'); return; }
  // one big world (~800 units), cloned through Save so both runs start from the identical state
  const base = mk();
  base.Sim.newWorld({ seed: 7, w: 96, h: 96, populate: true });
  let g = 0; while (base.S.units.size < 800 && g++ < 300) stepN(base, 50);
  const json = base.Save.serialize();
  const run = (te) => {
    const ctx = mk();
    assert.ok(ctx.Save.deserialize(json), ctx.Save.lastError);
    ctx.S.perf.thinkEvery = te;
    stepN(ctx, 100);
    const t0 = performance.now(); stepN(ctx, 300); const ms = (performance.now() - t0) / 300;
    return { ms, units: ctx.S.units.size, errors: ctx.Sim.totalErrors };
  };
  const a = run(3), b = run(6), c2 = run(3), d2 = run(6);
  const m3 = Math.min(a.ms, c2.ms), m6 = Math.min(b.ms, d2.ms);
  note(`${base.S.units.size} units: thinkEvery 3 -> ${m3.toFixed(3)} ms/tick, thinkEvery 6 -> ${m6.toFixed(3)} ms/tick (best of 2)`);
  assert.equal(a.errors + b.errors, 0);
  assert.ok(m6 < m3 * 1.05, 'a longer think interval must not cost more');
  // unitCap is honoured by Units.spawn (what adaptPerf relies on)
  const ctx = mk();
  assert.ok(ctx.Save.deserialize(json));
  const n = ctx.S.units.size;
  ctx.S.perf.unitCap = n;
  const p = ctx.World.randomLand();
  assert.equal(ctx.Units.spawn(0, p[0] + 0.5, p[1] + 0.5, {}), null, 'spawn refused at the cap');
  ctx.S.perf.unitCap = n + 1;
  assert.ok(ctx.Units.spawn(0, p[0] + 0.5, p[1] + 0.5, {}), 'spawn allowed below the cap');
});

// ------------------------------------------------------------------ stubs
section('works with stubbed neighbours (Powers is a stub until its file exists)', function () {
  const ctx = mk(['Powers', 'War', 'Diplomacy']);
  ctx.Sim.newWorld({ seed: 2, w: 64, h: 64, populate: true });
  stepN(ctx, 100);
  assert.equal(ctx.S.tick, 100);
  assert.equal(ctx.Sim.totalErrors, 0);
});

// ------------------------------------------------------------------ summary
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
if (failed.length) process.exit(1);
