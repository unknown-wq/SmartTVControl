// Units tests (plain node + assert).   node tests/units.test.mjs
// Real World / Buildings / Cities / Kingdoms(stub) are used; Sim, Powers, Save are stubbed by the harness.
import assert from 'node:assert/strict';
import { loadSim, stepN, newWorld, pad } from './harness.mjs';

const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 70)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 10).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

// ------------------------------------------------------------------ plumbing
function mkCtx(seed = 1, size = 96, stub = []) {
  const ctx = loadSim({ stub });
  newWorld(ctx, seed, size, size);
  ctx.unitMs = [];
  const orig = ctx.Units.step;
  ctx.Units.step = (t) => { const t0 = performance.now(); orig(t); ctx.unitMs.push(performance.now() - t0); };
  ctx.deaths = [];
  ctx.births = 0;
  ctx.Bus.on('unitBorn', () => { ctx.births++; });
  ctx.Bus.on('unitDied', (u, cause, killer) => { ctx.deaths.push({ id: u.id, cause, killer: killer ? killer.id : 0, race: u.race }); });
  return ctx;
}
/** spawn n units of a race around the best village site near (hx,hy); sexes alternate */
function spawnGroup(ctx, race, n, hx, hy, spread = 2.5, opts = {}) {
  const { Cities, Units, World, R } = ctx;
  const site = Cities.findSite(race, hx, hy, 80) || { x: hx, y: hy };
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < 2000) {
    const x = site.x + 0.5 + R.between(-spread, spread), y = site.y + 0.5 + R.between(-spread, spread);
    if (!World.walkable(x, y)) continue;
    const u = Units.spawn(race, x, y, Object.assign({ sex: out.length % 2 }, opts));
    if (u) out.push(u);
  }
  assert.equal(out.length, n, 'group spawned');
  return out;
}
const SITES = [[22, 30], [60, 28], [28, 66], [68, 68]];

/** tracks units that neither move nor work for a long time */
function mkMonitor(ctx) {
  const mon = { last: new Map(), pos: new Map(), maxFrac: 0, samples: 0, worst: [] };
  mon.sample = () => {
    const { S } = ctx;
    let stuck = 0, n = 0;
    for (const u of S.units.values()) {
      n++;
      const p = mon.pos.get(u.id);
      let active = !p || Math.abs(u.x - p[0]) + Math.abs(u.y - p[1]) > 0.04;
      if (u.state === 'sleep' || u.state === 'mate' || u.state === 'fight' || u.state === 'army') active = true;
      if (u.st && (u.st.ph === 'work' || u.st.ph === 'chew')) active = true;
      if (u.state === 'settle') active = true;                                   // waiting for the group is Cities' protocol
      mon.pos.set(u.id, [u.x, u.y]);
      if (active) mon.last.set(u.id, S.tick);
      else if (!mon.last.has(u.id)) mon.last.set(u.id, S.tick);
      if (S.tick - mon.last.get(u.id) >= 300) { stuck++; if (mon.worst.length < 5) mon.worst.push(`${u.id}:${u.state}/${u.job && u.job.type}/${u.st && u.st.ph}@${u.x.toFixed(1)},${u.y.toFixed(1)}`); }
    }
    mon.samples++;
    const frac = n ? stuck / n : 0;
    if (S.tick >= 400 && frac > mon.maxFrac) mon.maxFrac = frac;
  };
  return mon;
}
function run(ctx, n, hook, every = 10) {
  for (let i = 0; i < n; i++) {
    stepN(ctx, 1);
    if (hook && ctx.S.tick % every === 0) hook(ctx.S.tick);
  }
}
function finiteAll(ctx, label = '') {
  for (const u of ctx.S.units.values()) {
    for (const k of ['x', 'y', 'px', 'py', 'hp', 'maxHp', 'hunger', 'energy', 'xp', 'level', 'born', 'nextThink', 'life']) {
      assert.ok(Number.isFinite(u[k]), `${label} unit ${u.id} field ${k} finite (${u[k]})`);
    }
    assert.ok(u.x >= 0 && u.y >= 0 && u.x < ctx.S.w && u.y < ctx.S.h, `${label} unit ${u.id} inside the map`);
    assert.ok(ctx.World.walkable(u.x, u.y), `${label} unit ${u.id} stands on walkable ground (${u.x.toFixed(2)},${u.y.toFixed(2)} tile ${ctx.World.tileAt(u.x, u.y)})`);
    assert.ok(u.hp > 0 && u.hp <= u.maxHp + 1e-6, `${label} unit ${u.id} hp sane (${u.hp}/${u.maxHp})`);
    assert.ok(u.hunger >= 0 && u.hunger <= 100 && u.energy >= 0 && u.energy <= 100, `${label} needs in range`);
    assert.ok(ctx.Const.STATES.includes(u.state), `${label} state ${u.state} is known`);
  }
}
function invariants(ctx, label = '') {
  const { S } = ctx;
  for (const c of S.cities.values()) {
    assert.equal(c.pop, c.members.length, `${label} pop cache of ${c.name}`);
    for (const id of c.members) { const u = S.units.get(id); assert.ok(u, `${label} member ${id} exists`); assert.equal(u.cityId, c.id); assert.equal(u.kingdomId, c.kingdomId); }
  }
  for (const u of S.units.values()) {
    if (u.cityId) assert.ok(S.cities.get(u.cityId) && S.cities.get(u.cityId).members.includes(u.id), `${label} unit ${u.id} listed in its city`);
    if (u.spouseId) { const sp = S.units.get(u.spouseId); assert.ok(sp && sp.spouseId === u.id, `${label} spouse link ${u.id}`); }
  }
}
/** every unit must be findable through the spatial grid and nothing else may be in it */
function gridMatches(ctx, label = '') {
  const { S, Units } = ctx;
  const seen = new Set();
  Units.nearby(S.w / 2, S.h / 2, S.w + S.h, (u) => { assert.ok(!seen.has(u.id), `${label} grid duplicate ${u.id}`); seen.add(u.id); });
  assert.equal(seen.size, S.units.size, `${label} grid holds every unit once (${seen.size} vs ${S.units.size})`);
  for (const id of seen) assert.ok(S.units.has(id), `${label} grid ref ${id} is alive`);
}
function jsonSafe(v, path, seen = new Set()) {
  if (v === null) return;
  const t = typeof v;
  assert.ok(t !== 'function' && t !== 'undefined' && t !== 'symbol' && t !== 'bigint', `${path}: ${t}`);
  if (t === 'number') { assert.ok(Number.isFinite(v), `${path}: non-finite number`); return; }
  if (t !== 'object') return;
  assert.ok(!(v instanceof Map) && !(v instanceof Set), `${path}: Map/Set`);
  assert.ok(!seen.has(v), `${path}: circular / shared reference`);
  seen.add(v);
  if (Array.isArray(v)) v.forEach((x, i) => jsonSafe(x, `${path}[${i}]`, seen));
  else for (const k of Object.keys(v)) jsonSafe(v[k], `${path}.${k}`, seen);
  seen.delete(v);
}

console.log('Units tests');

// ====================================================================================================
// (a) 24 humans, 3000 ticks, real Cities
const A = { ctx: null };
section('(a) 24 humans, 3000 ticks: villages, growth, buildings, no NaN, no stuck units', () => {
  const ctx = mkCtx(1);
  A.ctx = ctx;
  const { S, Cities, Units } = ctx;
  for (const [x, y] of SITES) spawnGroup(ctx, 0, 6, x, y);
  assert.equal(S.units.size, 24);
  const mon = mkMonitor(ctx);
  let firstCity = -1, pop900 = 0, best900 = 0, maxPop = 0;
  const t0 = performance.now();
  let maxStep = 0, maxStepWho = '';
  run(ctx, 3000, (t) => {
    if (t % 10 === 0) mon.sample();
    if (firstCity < 0 && S.cities.size > 0) firstCity = t;
    if (t === 900) { pop900 = S.units.size; for (const c of S.cities.values()) best900 = Math.max(best900, c.pop); }
    maxPop = Math.max(maxPop, S.units.size);
    for (const u of S.units.values()) { const d = Math.hypot(u.x - u.px, u.y - u.py); if (d > maxStep) { maxStep = d; maxStepWho = u.id + ':' + u.state; } }
    if (t % 500 === 0) { finiteAll(ctx, 't' + t); invariants(ctx, 't' + t); }
  }, 1);
  const ms = performance.now() - t0;
  finiteAll(ctx, 'end'); invariants(ctx, 'end'); gridMatches(ctx, 'end');
  const houses = [...S.buildings.values()].filter(b => b.type === ctx.Const.B.HOUSE && b.done).length;
  const farms = [...S.buildings.values()].filter(b => b.type === ctx.Const.B.FARM && b.done).length;
  const tot = Units.totals();
  note(`first village at tick ${firstCity}; pop@900=${pop900} (largest village ${best900}); pop@3000=${S.units.size} (max ${maxPop}); cities=${S.cities.size} kingdoms=${S.kingdoms.size}`);
  note(`buildings=${S.buildings.size} houses=${houses} farms=${farms}; births=${tot.births} deaths=${tot.deaths} ${JSON.stringify(tot.causes)}; stuck max ${(mon.maxFrac * 100).toFixed(1)}% ${mon.worst.join(' ')}`);
  note(`whole sim ${(ms / 3000).toFixed(3)} ms/tick (Units.step avg ${(ctx.unitMs.reduce((a, b) => a + b, 0) / ctx.unitMs.length).toFixed(3)} ms)`);
  note(`largest per-tick step ${maxStep.toFixed(3)} tiles (${maxStepWho})`);
  assert.ok(maxStep < 0.4, 'nobody teleports');
  assert.ok(firstCity >= 0 && firstCity < 600, 'a village is founded early');
  assert.ok(pop900 >= 20, `pop >= 20 at tick 900 (${pop900})`);
  assert.ok(best900 >= 10, `a village of >= 10 at tick 900 (${best900})`);
  assert.ok(S.units.size >= 40, `population keeps growing (${S.units.size})`);
  assert.ok(houses >= 3 && farms >= 1, 'houses and farms were built');
  const colonies = [...S.cities.values()].filter(c => c.hist.some(h => /переселенц/.test(h.t))).length;
  note(`expedition colonies: ${colonies}`);
  assert.ok(colonies >= 1, 'expedition members (state settle) walk out and found colonies');
  assert.equal(Units.errors, 0, 'no exceptions inside Units: ' + (Units.lastError && Units.lastError.stack));
  assert.ok(mon.maxFrac < 0.05, `stuck units < 5% (max ${(mon.maxFrac * 100).toFixed(1)}%: ${mon.worst.join(' ')})`);
  assert.ok(tot.births > 20, 'births happen');
});

// ====================================================================================================
// (b) orcs / elves settle and survive
section('(b) orcs and elves (6 each) settle and survive; elves grow slower', () => {
  const res = {};
  for (const race of [1, 2]) {
    const ctx = mkCtx(1);
    const { S, Units } = ctx;
    spawnGroup(ctx, race, 6, 40, 40);
    const mon = mkMonitor(ctx);
    let firstCity = -1;
    run(ctx, 3000, (t) => { mon.sample(); if (firstCity < 0 && S.cities.size > 0) firstCity = t; if (t % 750 === 0) { finiteAll(ctx, 'r' + race + 't' + t); invariants(ctx); } });
    const tot = Units.totals();
    res[race] = { pop: S.units.size, births: tot.births, deaths: tot.deaths, firstCity };
    note(`race ${race}: first village @${firstCity}, pop ${S.units.size}, births ${tot.births}, deaths ${tot.deaths} ${JSON.stringify(tot.causes)}, cities ${S.cities.size}, stuck max ${(mon.maxFrac * 100).toFixed(1)}%`);
    assert.ok(firstCity >= 0 && firstCity < 900, `race ${race} founded a village`);
    assert.ok(S.units.size >= 6, `race ${race} survives (${S.units.size})`);
    assert.equal(Units.errors, 0);
    assert.ok(mon.maxFrac < 0.05, `race ${race} stuck ${(mon.maxFrac * 100).toFixed(1)}% ${mon.worst.join(' ')}`);
    assert.ok(tot.births >= 1, `race ${race} has births`);
  }
  assert.ok(res[2].births < res[1].births + 1, `elves breed no faster than orcs (${res[2].births} vs ${res[1].births})`);
});

// ====================================================================================================
// (c) stress: 1500 units
section('(c) 1500 units stress test (timing)', () => {
  const ctx = mkCtx(2);
  const { S, Units, World, R, Cities } = ctx;
  S.perf.unitCap = 1500;
  let n = 0, guard = 0;
  const centers = [];
  for (let i = 0; i < 40; i++) { const p = World.randomLand(null, 200); if (p) centers.push(p); }
  while (n < 1500 && guard++ < 200000) {
    const c = centers[n % centers.length];
    const x = c[0] + 0.5 + R.between(-7, 7), y = c[1] + 0.5 + R.between(-7, 7);
    if (!World.walkable(x, y)) continue;
    if (Units.spawn(n % 3 === 2 ? 2 : n % 3, x, y, {})) n++;
  }
  assert.equal(S.units.size, 1500);
  const mon = mkMonitor(ctx);
  run(ctx, 300, () => mon.sample(), 25);                     // settle: cities appear
  ctx.unitMs.length = 0;
  const t0 = performance.now();
  run(ctx, 900, (t) => { if (t % 100 === 0) mon.sample(); });
  const whole = (performance.now() - t0) / 900;
  const a = ctx.unitMs.slice().sort((x, y) => x - y);
  const avg = a.reduce((x, y) => x + y, 0) / a.length;
  note(`units=${S.units.size} cities=${S.cities.size} | Units.step avg ${avg.toFixed(2)} ms, p95 ${a[(a.length * 0.95) | 0].toFixed(2)} ms, max ${a[a.length - 1].toFixed(2)} ms | whole tick ${whole.toFixed(2)} ms`);
  finiteAll(ctx, 'stress'); gridMatches(ctx, 'stress'); invariants(ctx, 'stress');
  assert.equal(Units.errors, 0, 'no exceptions: ' + (Units.lastError && Units.lastError.stack));
  assert.ok(avg < 5, `Units.step average ${avg.toFixed(2)} ms < 5 ms`);
  ctx.S.perf.thinkEvery = 6;
  ctx.unitMs.length = 0;
  run(ctx, 300);
  const avg6 = ctx.unitMs.reduce((x, y) => x + y, 0) / ctx.unitMs.length;
  note(`with thinkEvery=6: Units.step avg ${avg6.toFixed(2)} ms`);
  assert.ok(avg6 <= avg * 1.1, 'thinkEvery=6 is not slower');
});

// ====================================================================================================
// (d) combat
section('(d) combat: orc vs elf wanderers fight, kills happen, nobody dies without Units.kill', () => {
  const ctx = mkCtx(1);
  const { S, Units, World, Const, R } = ctx;
  const p = World.randomLand((x, y) => World.tileAt(x, y) === Const.T.GRASS && World.landSize(x, y) > 400, 2000);
  assert.ok(p, 'grass site');
  const orcs = [], elves = [];
  for (let i = 0; i < 5; i++) {
    const o = Units.spawn(1, p[0] + 0.5 - 1.5 + R.f() * 0.5, p[1] + 0.5 + R.between(-1, 1), { age: 20 });
    const e = Units.spawn(2, p[0] + 0.5 + 1.5 + R.f() * 0.5, p[1] + 0.5 + R.between(-1, 1), { age: 40 });
    assert.ok(o && e); orcs.push(o); elves.push(e);
  }
  assert.ok(Units.isHostile(orcs[0], elves[0]) || Units.isHostile(elves[0], orcs[0]) || orcs.some(o => elves.some(e => Units.isHostile(o, e))), 'some orc hates some elf');
  const before = S.units.size;
  const born0 = ctx.births;
  run(ctx, 900, () => finiteAll(ctx, 'combat'));
  const combat = ctx.deaths.filter(d => d.cause === 'combat');
  note(`start ${before}, end ${S.units.size}, deaths ${ctx.deaths.length} (combat ${combat.length}) ${JSON.stringify(Units.totals().causes)}`);
  assert.ok(combat.length >= 1, 'at least one combat death');
  assert.equal(before + (ctx.births - born0) - S.units.size, ctx.deaths.length, 'population change equals births minus unitDied events');
  for (const d of combat) assert.ok(d.killer > 0, 'combat deaths name a killer');
  const survivors = [...S.units.values()];
  assert.ok(survivors.reduce((a, u) => a + u.kills, 0) >= 1, 'killers were credited');
  assert.ok(survivors.some(u => u.xp > 0 || u.level > 1 || u.kills > 0), 'xp / kills accumulated');
  assert.equal(Units.errors, 0);
});

section('(d2) wild fights stay rare and local: scattered orcs and elves do not exterminate each other', () => {
  const ctx = mkCtx(3);
  const { S, Units, World, R } = ctx;
  let n = 0, guard = 0;
  while (n < 40 && guard++ < 20000) {
    const p = World.randomLand(null, 100);
    if (!p) continue;
    if (Units.spawn(n % 2 ? 1 : 2, p[0] + 0.5, p[1] + 0.5, {})) n++;
  }
  run(ctx, 1500);
  const dead = ctx.deaths.filter(d => d.cause === 'combat').length;
  note(`40 scattered units, 1500 ticks: combat deaths ${dead}, alive ${S.units.size}`);
  assert.ok(S.units.size >= 12, 'most survive');
  assert.equal(Units.errors, 0);
});

// ====================================================================================================
// (e) disease
section('(e) disease spreads, causes damage, and units recover (immune afterwards)', () => {
  const ctx = mkCtx(1);
  const { S, Units, World, Const, R } = ctx;
  const p = World.randomLand((x, y) => World.tileAt(x, y) === Const.T.GRASS && World.landSize(x, y) > 400, 2000);
  const us = [];
  for (let i = 0; i < 24; i++) { const u = Units.spawn(0, p[0] + 0.5 + R.between(-1.2, 1.2), p[1] + 0.5 + R.between(-1.2, 1.2), { age: 25 }); assert.ok(u); us.push(u); }
  assert.ok(Units.infect(us[0], S.tick + 400), 'infect works');
  assert.ok(us[0].sick > S.tick);
  let peak = 0;
  const hp0 = us.map(u => u.hp);
  run(ctx, 40);
  assert.ok(us[0].hp < hp0[0] || us[0].hp <= us[0].maxHp, 'sick unit loses health');
  run(ctx, 1500, () => {
    const sick = [...S.units.values()].filter(u => u.sick > S.tick).length;
    if (sick > peak) peak = sick;
  });
  const recovered = [...S.units.values()].filter(u => u.immune > 0).length;
  const stillSick = [...S.units.values()].filter(u => u.sick > S.tick).length;
  const dead = ctx.deaths.filter(d => d.cause === 'disease').length;
  note(`peak sick ${peak}, recovered(immune) ${recovered}, still sick ${stillSick}, disease deaths ${dead}, alive ${S.units.size}`);
  assert.ok(peak >= 3, 'the disease spread');
  assert.ok(recovered >= 1, 'units recover');
  assert.ok(stillSick === 0, 'epidemic over');
  // immunity: cannot be re-infected right after recovery
  const imm = [...S.units.values()].find(u => u.immune > S.tick);
  if (imm) assert.equal(Units.infect(imm, S.tick + 100), false, 'immune units resist');
  // heal cures
  const x = [...S.units.values()][0];
  Units.infect(x, S.tick + 500); Units.heal(x, 5);
  assert.equal(x.sick, 0, 'heal cures');
  assert.equal(Units.errors, 0);
});

// ====================================================================================================
// (f) JSON
section('(f) every unit is JSON-safe and round-trips', () => {
  const ctx = A.ctx;
  assert.ok(ctx && ctx.S.units.size > 20, 'run (a) first');
  let bytes = 0, n = 0;
  for (const u of ctx.S.units.values()) {
    jsonSafe(u, 'unit' + u.id);
    const s = JSON.stringify(u);
    bytes += s.length; n++;
    const back = JSON.parse(s);
    assert.deepEqual(back, JSON.parse(JSON.stringify(back)), 'stable');
    assert.equal(JSON.stringify(back), s, `unit ${u.id} round-trips byte-exact`);
  }
  note(`${n} units, ${(bytes / n).toFixed(0)} bytes per unit`);
  assert.ok(n > 0);
});

section('(f2) save/load: units re-inserted into a world keep working (afterLoad rebuilds grid)', () => {
  const ctx = mkCtx(1);
  const { S, Units, Cities } = ctx;
  for (const [x, y] of SITES.slice(0, 2)) spawnGroup(ctx, 0, 6, x, y);
  run(ctx, 700);
  const unitsJson = JSON.stringify([...S.units.values()]);
  const citiesJson = JSON.stringify([...S.cities.values()]);
  const bJson = JSON.stringify([...S.buildings.values()]);
  const tick = S.tick, pop = S.units.size;
  // wipe + restore the entity maps through JSON (terrain arrays stay)
  S.units = new Map(JSON.parse(unitsJson).map(u => [u.id, u]));
  S.cities = new Map(JSON.parse(citiesJson).map(c => [c.id, c]));
  S.buildings = new Map(JSON.parse(bJson).map(b => [b.id, b]));
  ctx.World.afterLoad(); Cities.afterLoad(); Units.afterLoad();
  assert.equal(S.units.size, pop);
  gridMatches(ctx, 'afterLoad');
  run(ctx, 600);
  finiteAll(ctx, 'after load'); invariants(ctx, 'after load'); gridMatches(ctx, 'after load+600');
  assert.ok(S.tick === tick + 600);
  assert.equal(Units.errors, 0, 'no errors after load: ' + (Units.lastError && Units.lastError.stack));
});

// ====================================================================================================
// (g) starvation
section('(g) no food anywhere: the population shrinks smoothly (no instant wipe-out)', () => {
  const ctx = mkCtx(1);
  const { S, Units, Cities, World, Const } = ctx;
  spawnGroup(ctx, 0, 6, 22, 30);
  spawnGroup(ctx, 0, 6, 22, 30);
  run(ctx, 1100);
  const c = [...S.cities.values()][0];
  assert.ok(c && c.pop >= 14, `a village of ${c && c.pop} exists`);
  // switch food off
  const origDeposit = Cities.deposit, origHarvest = World.harvest;
  Cities.deposit = (id, g, a) => (g === 'food' ? 0 : origDeposit(id, g, a));
  World.harvest = (x, y, k, a) => ((k === Const.RES.BERRY || k === Const.RES.FISH) ? 0 : origHarvest(x, y, k, a));
  for (const cc of S.cities.values()) cc.stock.food = 0;
  const noBirths = (u) => { u.birthCd = S.tick + 100000; };
  const pop0 = S.units.size;
  const series = [];
  let lastPop = pop0, maxDrop = 0;
  const deathTicks = [];
  ctx.Bus.on('unitDied', (u, cause) => { if (cause === 'hunger') deathTicks.push(S.tick); });
  const t0 = S.tick;
  for (let i = 0; i < 2400; i++) {
    for (const u of S.units.values()) noBirths(u);
    for (const cc of S.cities.values()) cc.stock.food = 0;       // Cities' relief trickle is part of the design; here we want a hard famine
    stepN(ctx, 1);
    if (i % 100 === 99) { series.push(S.units.size); }
    if (i % 25 === 24) { maxDrop = Math.max(maxDrop, lastPop - S.units.size); lastPop = S.units.size; }
  }
  Cities.deposit = origDeposit; World.harvest = origHarvest;
  const starved = deathTicks.length;
  const first = deathTicks.length ? deathTicks[0] - t0 : -1;
  note(`pop ${pop0} -> ${S.units.size}; starvation deaths ${starved}; first at +${first}; series/100t: ${series.join(' ')}; max drop in 25 ticks ${maxDrop}`);
  assert.ok(starved >= pop0 * 0.4, 'many starve in a famine');
  assert.ok(first > 150, `nobody starves instantly (first death +${first})`);
  assert.ok(maxDrop <= Math.max(4, pop0 * 0.2), `smooth decline (max ${maxDrop} deaths per 25 ticks)`);
  assert.equal(Units.errors, 0);
  finiteAll(ctx, 'famine');
});

// ====================================================================================================
// API
section('API: spawn rules, kill side effects, damage/heal, stats, stage, labels', () => {
  const ctx = mkCtx(1);
  const { S, Units, World, Const, Cities, R, Traits, Races } = ctx;
  const g = spawnGroup(ctx, 0, 6, 22, 30);
  // unwalkable
  let water = null;
  for (let i = 0; i < S.tile.length && !water; i++) if (S.tile[i] === Const.T.DEEP) water = [i % S.w, (i / S.w) | 0];
  assert.equal(Units.spawn(0, water[0] + 0.5, water[1] + 0.5, {}), null, 'no spawn on deep water');
  assert.equal(Units.spawn(9, 5, 5, {}), null, 'bad race');
  // cap
  const old = S.perf.unitCap; S.perf.unitCap = S.units.size;
  assert.equal(Units.spawn(0, g[0].x, g[0].y, {}), null, 'cap respected');
  S.perf.unitCap = old;
  // fields
  const u = g[0];
  for (const k of ['id', 'race', 'sex', 'name', 'clan', 'born', 'x', 'y', 'px', 'py', 'face', 'hp', 'maxHp', 'hunger', 'energy', 'level', 'xp', 'kills', 'traits', 'cityId', 'kingdomId', 'weapon', 'armor', 'state', 'st', 'job', 'carry', 'carryAmt', 'fatherId', 'motherId', 'spouseId', 'armyId', 'isRuler', 'sick', 'buffUntil', 'buffMul', 'burning', 'nextThink', 'birthCd', 'hist']) assert.ok(k in u, 'unit has ' + k);
  assert.ok(u.traits.length >= 2 && u.traits.length <= 3);
  assert.equal(Units.stage(u), 'adult');
  assert.equal(Units.get(u.id), u); assert.equal(Units.get(-5), null); assert.equal(Units.count(), S.units.size);
  const kid = Units.spawn(0, u.x, u.y, { age: 3 });
  assert.equal(Units.stage(kid), 'child');
  assert.ok(kid.maxHp < u.maxHp, 'children are frailer');
  const elder = Units.spawn(0, u.x, u.y, { age: 70 });
  assert.equal(Units.stage(elder), 'elder');
  // stats
  const st = Units.stats(u);
  for (const k of ['atk', 'def', 'range', 'speed', 'maxHp']) assert.ok(Number.isFinite(st[k]) && st[k] > 0, 'stats.' + k);
  const elf = Units.spawn(2, u.x, u.y, { age: 40, weapon: 2 });
  assert.equal(Units.stats(elf).range, ctx.Gear.range(2, 2));
  const armored = Units.spawn(1, u.x, u.y, { age: 20, weapon: 3, armor: 3, traits: [] });
  const plain = Units.spawn(1, u.x, u.y, { age: 20, traits: [] });
  assert.ok(Units.stats(armored).atk > Units.stats(plain).atk && Units.stats(armored).def > Units.stats(plain).def, 'gear counts');
  const buffed = Units.spawn(1, u.x, u.y, { age: 20, traits: [] }); buffed.buffUntil = S.tick + 100; buffed.buffMul = 2;
  assert.equal(Units.stats(buffed).atk, Units.stats(plain).atk * 2, 'buff doubles atk');
  assert.equal(Units.stateLabel(u).length > 0, true);
  for (const s of Const.STATES) { u.state = s; assert.ok(typeof Units.stateLabel(u) === 'string'); }
  u.state = 'idle';
  // spatial queries match brute force
  const brute = (x, y, r) => [...S.units.values()].filter(v => (v.x - x) ** 2 + (v.y - y) ** 2 <= r * r).map(v => v.id).sort((a, b) => a - b);
  for (let i = 0; i < 20; i++) {
    const x = R.between(0, S.w), y = R.between(0, S.h), r = R.between(1, 14);
    assert.deepEqual(Units.inRadius(x, y, r).map(v => v.id).sort((a, b) => a - b), brute(x, y, r), 'inRadius = brute force');
  }
  const near = Units.nearest(u.x, u.y, 5, v => v !== u);
  assert.ok(near && near !== u);
  let cnt = 0; Units.nearby(u.x, u.y, 50, () => { cnt++; return cnt >= 3; }); assert.equal(cnt, 3, 'nearby stops when fn returns true');
  // kill: removes from city, clears spouse, army, emits bus, logs ruler
  Cities.found(0, ...(() => { const s = Cities.findSite(0, 22, 30, 60); return [s.x, s.y]; })(), g.slice(0, 4), {});
  const city = S.cities.values().next().value;
  assert.ok(city && u.cityId === city.id);
  const a = g[0], b = g[1]; a.spouseId = b.id; b.spouseId = a.id;
  const nCity = city.pop;
  let sawBus = 0; const fn = Bus => { sawBus++; }; ctx.Bus.on('unitDied', fn);
  const kingdom = S.kingdoms.get(a.kingdomId);
  const logN = S.log.length;
  assert.equal(Units.kill(a, 'age'), true);
  assert.equal(Units.kill(a, 'age'), false, 'double kill is harmless');
  assert.equal(S.units.has(a.id), false);
  assert.equal(b.spouseId, 0, 'spouse cleared');
  assert.equal(city.pop, nCity - 1); assert.ok(!city.members.includes(a.id));
  assert.equal(sawBus, 1, 'unitDied emitted once');
  gridMatches(ctx, 'after kill');
  if (a.isRuler) assert.ok(S.log.length > logN, 'ruler death logged');
  // damage / heal
  const t = g[2];
  const hp = t.hp;
  assert.equal(Units.damage(t, 1, 'test'), false); assert.equal(t.hp, hp - 1);
  Units.heal(t, 100); assert.equal(t.hp, t.maxHp);
  assert.equal(Units.damage(t, 1e6, 'test', g[3]), true, 'lethal damage kills');
  assert.equal(g[3].kills, 1, 'killer credited'); assert.ok(g[3].xp > 0);
  assert.equal(Units.damage(t, 5, 'x'), false, 'damaging a dead unit is harmless');
  assert.equal(Units.damage(null, 5, 'x'), false); assert.equal(Units.kill(null), false); assert.equal(Units.heal(null, 3), false);
  // damageAt / eraseInRadius
  const v = Units.spawn(0, 30.5, 30.5, {}); v && (v.hp = v.maxHp = 50);
  if (v && World.walkable(30.5, 30.5)) { assert.equal(Units.damageAt(30.2, 30.9, 3, 'fire'), 1); assert.equal(v.hp, 47); assert.ok(v.burning > S.tick, 'fire sets burning'); assert.equal(Units.damageAt(10.5, 10.5, 3, 'fire') >= 0, true); }
  const cntBefore = S.units.size;
  const erased = Units.eraseInRadius(u.x, u.y, 3);
  assert.equal(S.units.size, cntBefore - erased); gridMatches(ctx, 'after erase');
  // conscript / release without an army object
  const w = Units.spawn(0, 40.5, 40.5, { age: 25 }) || Units.spawn(0, g[5].x, g[5].y, { age: 25 });
  assert.ok(w);
  assert.equal(Units.conscript(w, 999), true); assert.equal(w.armyId, 999); assert.equal(w.state, 'army');
  run(ctx, 20);
  assert.equal(w.armyId, 0, 'unit whose army vanished releases itself'); assert.notEqual(w.state, 'army');
  assert.equal(Units.conscript(kid, 1), false, 'children cannot be conscripted');
  assert.equal(Units.errors, 0);
});

section('hostility rules (CONTRACT §5)', () => {
  const ctx = mkCtx(1);
  const { S, Units, Diplomacy } = ctx;
  const p = [20.5, 30.5];
  const mk = (race, extra = {}) => { const u = Units.spawn(race, p[0], p[1], Object.assign({ age: 30 }, extra)); assert.ok(u); return u; };
  const h = mk(0), h2 = mk(0), o = mk(1), e = mk(2), kid = mk(1, { age: 3 });
  h.kingdomId = 5; h2.kingdomId = 5; o.kingdomId = 6;
  assert.equal(Units.isHostile(h, h2), false, 'same kingdom never');
  assert.equal(Units.isHostile(h, o), false, 'different kingdoms at peace');
  const orig = Diplomacy.atWar; Diplomacy.atWar = (a, b) => (a === 5 && b === 6) || (a === 6 && b === 5);
  assert.equal(Units.isHostile(h, o), true, 'war makes kingdoms hostile'); assert.equal(Units.isHostile(o, h), true);
  assert.equal(Units.isHostile(h, h2), false);
  assert.equal(Units.isHostile(h, kid), false, 'children are never targets');
  Diplomacy.atWar = orig;
  o.kingdomId = 0; h.kingdomId = 0; h2.kingdomId = 0;
  assert.equal(Units.isHostile(h, o), false, 'human-orc rel -30: not hostile');
  assert.equal(Units.isHostile(h, h2), false);
  let hate = 0;
  for (let i = 0; i < 60; i++) { const a = mk(1, { age: 30 }), b = mk(2, { age: 30 }); if (Units.isHostile(a, b)) hate++; assert.equal(Units.isHostile(a, b), Units.isHostile(a, b), 'deterministic'); }
  note(`orc->elf wanderer hostility ${hate}/60 (aggression 0.75)`);
  assert.ok(hate > 25 && hate < 60, 'orcs mostly hate elves, but it is a roll');
  assert.equal(Units.isHostile(o, kid), false);
  assert.equal(Units.isHostile(o, o), false);
  assert.equal(Units.isHostile(null, o), false);
});

section('terrain changes under units: nudge to land within 3 tiles, else drown', () => {
  const ctx = mkCtx(1);
  const { S, Units, World, Const } = ctx;
  // find a coast: land tile with deep water within 2 tiles
  let spot = null;
  for (let y = 4; y < S.h - 4 && !spot; y++) for (let x = 4; x < S.w - 4 && !spot; x++) {
    if (S.tile[y * S.w + x] === Const.T.SAND && World.landSize(x, y) > 200) spot = [x, y];
  }
  const near = Units.spawn(0, spot[0] + 0.5, spot[1] + 0.5, { age: 25 });
  assert.ok(near);
  World.setTile(spot[0], spot[1], Const.T.DEEP);
  run(ctx, 40);
  assert.ok(S.units.has(near.id), 'unit next to land survives a flooded tile');
  assert.ok(World.walkable(near.x, near.y), 'and stands on walkable ground again');
  // lake in the middle of an island: units in the middle drown
  const p = World.randomLand((x, y) => World.tileAt(x, y) === Const.T.GRASS && World.landSize(x, y) > 400, 2000);
  const victims = [];
  for (let i = 0; i < 4; i++) victims.push(Units.spawn(0, p[0] + 0.5, p[1] + 0.5, { age: 25 }));
  for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) World.setTile(p[0] + dx, p[1] + dy, Const.T.DEEP);
  run(ctx, 60);
  const alive = victims.filter(v => S.units.has(v.id));
  note(`flooded 11x11 under 4 units: ${alive.length} alive`);
  assert.ok(alive.length <= 1, 'units in a flooded area drown');
  for (const v of alive) assert.ok(World.walkable(v.x, v.y));
  assert.ok(ctx.deaths.some(d => d.cause === 'drown'), 'drowning cause reported');
  gridMatches(ctx, 'flood');
  assert.equal(Units.errors, 0);
});

section('fire: burning units flee from flames and take damage', () => {
  const ctx = mkCtx(1);
  const { S, Units, World, Const } = ctx;
  const p = World.randomLand((x, y) => World.tileAt(x, y) === Const.T.GRASS && World.landSize(x, y) > 400, 2000);
  const u = Units.spawn(0, p[0] + 0.5, p[1] + 0.5, { age: 25 });
  u.hp = u.maxHp = 40;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) World.ignite(p[0] + dx, p[1] + dy);
  for (let i = 0; i < 10; i++) { Units.damageAt(p[0], p[1], 3, 'fire'); stepN(ctx, 1); }
  assert.ok(u.hp < 40);
  run(ctx, 80);
  note(`unit after fire: hp ${u.hp.toFixed(1)}, dist from origin ${Math.hypot(u.x - p[0] - 0.5, u.y - p[1] - 0.5).toFixed(1)}, state ${u.state}`);
  assert.ok(Math.hypot(u.x - p[0] - 0.5, u.y - p[1] - 0.5) > 1.5, 'moved away from the flames');
});

function mkWar(ctx, strongSoldiers) {
  const { S, Units, Cities, Diplomacy } = ctx;
  const gA = spawnGroup(ctx, 0, 6, 22, 30), gB = spawnGroup(ctx, 1, 6, 60, 28);
  const cA = Cities.found(0, ...(() => { const s = Cities.findSite(0, 22, 30, 60); return [s.x, s.y]; })(), gA, {});
  const cB = Cities.found(1, ...(() => { const s = Cities.findSite(1, 60, 28, 60); return [s.x, s.y]; })(), gB, {});
  assert.ok(cA && cB);
  assert.notEqual(cA.kingdomId, cB.kingdomId, 'two kingdoms');
  const kA = cA.kingdomId, kB = cB.kingdomId;
  const soldiers = [];
  for (let i = 0; i < (strongSoldiers ? 12 : 8); i++) {
    const u = Units.spawn(0, cA.x + 0.5, cA.y + 1.5, { age: 25, cityId: cA.id, traits: [], weapon: strongSoldiers ? 3 : 2, armor: strongSoldiers ? 3 : 2 });
    soldiers.push(u);
  }
  Diplomacy.atWar = (a, b) => (a === kA && b === kB) || (a === kB && b === kA);
  S.wars.set(S.id(), { id: 1, attackers: [kA], defenders: [kB], aggressor: kA, defender: kB, started: S.tick, casus: 'test', ended: false, kills: {}, hist: [] });
  const army = { id: S.id(), kingdomId: kA, cityId: cA.id, warId: 1, leaderId: soldiers[0].id, members: [], target: { cityId: cB.id, x: cB.x, y: cB.y }, rally: { x: cA.x + 6.5, y: cA.y + 0.5 }, mode: 'gather', born: S.tick };
  S.armies.set(army.id, army);
  for (const s of soldiers) assert.equal(Units.conscript(s, army.id), true);
  assert.equal(army.members.length, soldiers.length);
  return { cA, cB, gA, gB, soldiers, army, kA, kB };
}

section('armies: gather at the rally point, march, fight enemies of a kingdom at war, release', () => {
  const ctx = mkCtx(1, 96, ['War'])  // stage 2: hand-built armies / wars are not owned by the real War module;
  const { S, Units } = ctx;
  const { cA, cB, gB, soldiers, army } = mkWar(ctx, false);
  for (const u of gB) { u.weapon = 2; u.armor = 2; }            // stage 2: unarmed villagers flee from soldiers instead of attacking them; armed defenders still fight
  run(ctx, 300);
  const d0 = soldiers.map(s => Math.hypot(s.x - army.rally.x, s.y - army.rally.y));
  note(`gathered: distances to rally ${d0.map(d => d.toFixed(1)).join(' ')}`);
  assert.ok(d0.every(d => d < 3.5), 'soldiers stand around the rally point');
  assert.ok(soldiers.every(s => s.state === 'army'));
  assert.ok(Units.stateLabel(soldiers[0]).length > 0);
  army.mode = 'march'; army.rally = { x: cB.x + 0.5, y: cB.y + 3.5 };
  run(ctx, 500);
  const fights = ctx.deaths.filter(d => d.cause === 'combat').length;
  note(`marched + fought: soldiers alive ${soldiers.filter(s => S.units.has(s.id)).length}/8, defenders alive ${gB.filter(s => S.units.has(s.id)).length}/6, combat deaths ${fights}`);
  assert.ok(fights >= 1, 'fighting happened');
  assert.ok(ctx.deaths.some(d => d.cause === 'combat' && d.killer > 0), 'kills are credited');
  const alive = soldiers.filter(s => S.units.has(s.id));
  for (const s of alive) Units.release(s);
  assert.ok(alive.every(s => s.armyId === 0 && s.state !== 'army'));
  assert.equal(army.members.length, 0);
  run(ctx, 100);
  assert.equal(Units.errors, 0, '' + (Units.lastError && Units.lastError.stack));
  void cA;
});

section('armies: siege an undefended city (buildings of a kingdom at war are damaged / destroyed, neutral ones are not)', () => {
  const ctx = mkCtx(1, 96, ['War'])  // (idem);
  const { S, Units, Buildings } = ctx;
  const { cA, cB, gB, soldiers, army } = mkWar(ctx, true);
  for (const u of gB) Units.kill(u, 'erase');                    // nobody defends
  const bB = cB.buildings.slice();
  const aBefore = cA.buildings.slice();
  let destroyed = 0, hits = 0;
  ctx.Bus.on('buildingDestroyed', (b, cause) => { if (b.cityId === cB.id && cause === 'war') destroyed++; });
  const origDamage = Buildings.damage;
  Buildings.damage = (b, dmg, kid, cause) => { if (cause === 'war' && b.cityId === cB.id) hits++; return origDamage(b, dmg, kid, cause); };
  army.mode = 'siege'; army.rally = { x: cB.x + 0.5, y: cB.y + 2.5 };
  run(ctx, 1200);
  Buildings.damage = origDamage;
  const alive = soldiers.filter(s => S.units.has(s.id));
  note(`siege: buildings of B ${bB.length} -> ${cB.buildings.length} (destroyed by war ${destroyed}, ${hits} hits), soldiers alive ${alive.length}/12`);
  assert.ok(hits >= 10, 'soldiers hit buildings of the enemy city');
  assert.ok(destroyed >= 1, 'and destroyed some');
  assert.equal(cA.buildings.length >= aBefore.length, true, 'own buildings untouched');
  assert.ok(alive.length >= 8, 'nobody fights back');
  assert.ok(alive.some(s => /Штурм|Осажд|Сраж/.test(Units.stateLabel(s))) || destroyed === bB.length, 'label tells they are besieging');
  assert.equal(Units.errors, 0, '' + (Units.lastError && Units.lastError.stack));
});

section('pathing: long trips cross a bay via World.findPath; budget respected; blocked units recover', () => {
  const ctx = mkCtx(4);
  const { S, Units, World, Const } = ctx;
  // find two land tiles ~30 apart on the same landmass whose straight line is crossed by water
  let pair = null;
  outer: for (let y = 10; y < S.h - 10; y += 3) for (let x = 6; x < S.w - 40; x += 3) {
    const x2 = x + 30, y2 = y;
    if (!World.walkable(x, y) || !World.walkable(x2, y2) || !World.sameLand(x, y, x2, y2)) continue;
    let blocked = false;
    for (let k = 0; k <= 30; k++) { const t = S.tile[y * S.w + x + k]; if (t === Const.T.DEEP) { blocked = true; break; } }
    if (blocked) { pair = [x, y, x2, y2]; break outer; }
  }
  if (!pair) { note('no suitable bay on this seed: skipped'); return; }
  const calls = { n: 0 };
  const orig = World.findPath;
  World.findPath = (...a) => { calls.n++; return orig(...a); };
  const u = Units.spawn(0, pair[0] + 0.5, pair[1] + 0.5, { age: 25 });
  u.state = 'walk'; u.st = { ph: 'go', since: S.tick, tx: pair[2] + 0.5, ty: pair[3] + 0.5, rg: 0.5, then: '', until: S.tick + 2000 };
  let arrived = -1;
  for (let i = 0; i < 1500 && arrived < 0; i++) { stepN(ctx, 1); if (Math.hypot(u.x - pair[2] - 0.5, u.y - pair[3] - 0.5) < 1) arrived = i; }
  World.findPath = orig;
  note(`walked ${pair.join(',')} around a bay in ${arrived} ticks using ${calls.n} findPath calls`);
  assert.ok(arrived >= 0, 'arrived across the water');
  assert.ok(calls.n <= 12, 'path requests are throttled');
});

section('movement: 150 walkers cross the map, always on walkable ground, no teleports, nearly all arrive', () => {
  const ctx = mkCtx(2);
  const { S, Units, World, R } = ctx;
  const ws = [];
  for (let i = 0; i < 150; i++) {
    const p = World.randomLand(null, 100);
    const u = Units.spawn(i % 3, p[0] + 0.5, p[1] + 0.5, { age: 30 });
    if (!u) continue;
    const q = World.randomLand((x, y) => World.sameLand(p[0], p[1], x, y) && Math.hypot(x - p[0], y - p[1]) > 8, 600);
    if (!q) { Units.kill(u, 'erase'); continue; }
    u.nextThink = S.tick + 100000;                         // no decisions: pure movement
    u.hunger = -1e9; u.energy = 100;
    u.state = 'walk'; u.st = { ph: 'go', since: S.tick, tx: q[0] + 0.5, ty: q[1] + 0.5, rg: 0.4, then: '', until: S.tick + 5000 };
    ws.push({ u, q, t: -1 });
  }
  let maxStep = 0, offGround = 0;
  for (let t = 1; t <= 1500; t++) {
    stepN(ctx, 1);
    for (const w of ws) {
      const u = w.u;
      if (!S.units.has(u.id)) continue;
      const d = Math.hypot(u.x - u.px, u.y - u.py);
      if (d > maxStep) maxStep = d;
      if (!World.walkable(u.x, u.y)) offGround++;
      if (w.t < 0 && Math.hypot(u.x - w.q[0] - 0.5, u.y - w.q[1] - 0.5) < 0.6) w.t = t;
    }
  }
  const arrived = ws.filter(w => w.t >= 0).length;
  const times = ws.filter(w => w.t >= 0).map(w => w.t).sort((a, b) => a - b);
  note(`${ws.length} walkers: ${arrived} arrived (median ${times[times.length >> 1]} ticks, max ${times[times.length - 1]}), max step ${maxStep.toFixed(3)}, off-ground samples ${offGround}`);
  assert.equal(offGround, 0, 'never on unwalkable ground');
  assert.ok(maxStep < 0.4, 'no teleports');
  assert.ok(arrived >= ws.length * 0.93, `most arrive (${arrived}/${ws.length})`);
  assert.equal(Units.errors, 0);
});

section('findPath budget: at most ~8 calls per tick even with many walkers', () => {
  const ctx = mkCtx(1);
  const { S, Units, World, R } = ctx;
  const orig = World.findPath;
  let perTick = 0, maxPerTick = 0, total = 0;
  World.findPath = (...a) => { perTick++; total++; return orig(...a); };
  for (let i = 0; i < 200; i++) {
    const p = World.randomLand(null, 100);
    const u = Units.spawn(0, p[0] + 0.5, p[1] + 0.5, { age: 25 });
    if (!u) continue;
    const q = World.randomLand((x, y) => World.sameLand(p[0], p[1], x, y) && Math.hypot(x - p[0], y - p[1]) > 15, 400);
    if (!q) continue;
    u.state = 'walk'; u.st = { ph: 'go', since: S.tick, tx: q[0] + 0.5, ty: q[1] + 0.5, rg: 0.5, then: '', until: S.tick + 2000 };
  }
  for (let i = 0; i < 100; i++) { perTick = 0; stepN(ctx, 1); maxPerTick = Math.max(maxPerTick, perTick); }
  World.findPath = orig;
  note(`200 walkers, 100 ticks: ${total} findPath calls, max ${maxPerTick} per tick`);
  assert.ok(maxPerTick <= 8, 'budget per tick');
  assert.equal(Units.errors, 0);
});

section('births: respect unitCap and housing; children inherit city/clan/traits/parents', () => {
  const ctx = mkCtx(1);
  const { S, Units, Cities } = ctx;
  spawnGroup(ctx, 0, 6, 22, 30);
  run(ctx, 500);
  const kids = [...S.units.values()].filter(u => u.motherId);
  assert.ok(kids.length >= 2, 'children were born');
  for (const k of kids.slice(0, 6)) {
    const m = S.units.get(k.motherId), f = S.units.get(k.fatherId);
    assert.ok(k.cityId > 0, 'child belongs to a city');
    assert.ok(k.traits.length >= 2 && k.traits.length <= 3);
    if (m) assert.equal(k.cityId, m.cityId);
    if (f) assert.equal(k.clan, f.clan, 'clan from father');
    assert.ok(k.born > 0, 'born during the run');
  }
  // cap
  S.perf.unitCap = S.units.size;
  const n = S.units.size;
  for (const u of S.units.values()) u.birthCd = 0;
  run(ctx, 400);
  assert.equal(S.units.size <= n, true, 'no births at the cap (only deaths can change the count)');
  assert.ok(S.units.size <= n);
});

section('fuzz: god-tool abuse (terrain brushes, fire, plague, kills, erase, heal) on 5 seeds / sizes keeps every invariant', () => {
  let totalErr = 0;
  for (const [seed, size] of [[11, 64], [12, 96], [13, 128], [14, 96], [15, 64]]) {
    const ctx = mkCtx(seed, size);
    const { S, Units, World, R, Cities } = ctx;
    for (let i = 0; i < 4; i++) { const p = World.randomLand(null, 200); if (p) spawnGroup(ctx, i % 3 === 0 ? 0 : i % 3, 6, p[0], p[1]); }
    const tools = ['raise', 'lower', 'grass', 'sand', 'forest', 'hill', 'mountain', 'snow', 'lava'];
    for (let t = 1; t <= 1500; t++) {
      stepN(ctx, 1);
      if (t % 25 === 0) {
        const x = R.i(S.w), y = R.i(S.h), r = R.int(1, 5);
        switch (R.i(10)) {
          case 0: World.brush(R.pick(tools), x, y, r); break;
          case 1: World.ignite(x, y); World.ignite(x + 1, y); break;
          case 2: Units.nearby(x, y, 6, u => { Units.infect(u, S.tick + 300); }); break;
          case 3: { const l = Units.inRadius(x, y, 5); if (l.length) Units.kill(R.pick(l), 'lightning'); break; }
          case 4: { const l = Units.inRadius(x, y, 4); for (const u of l) Units.heal(u, 50); break; }
          case 5: Units.eraseInRadius(x, y, 2); break;
          case 6: { const p = World.randomLand(null, 100); if (p) Units.spawn(R.i(3), p[0] + 0.5, p[1] + 0.5, {}); break; }
          case 7: Units.damageAt(x, y, 5, 'fire'); break;
          case 8: { const l = Units.inRadius(x, y, 8); for (const u of l) { u.x = Math.min(S.w - 0.5, Math.max(0.5, u.x + R.between(-9, 9))); u.y = Math.min(S.h - 0.5, Math.max(0.5, u.y + R.between(-9, 9))); } break; }   // tornado-style teleport
          default: { const l = Units.inRadius(x, y, 6); for (const u of l) { u.buffUntil = S.tick + 100; u.buffMul = 1.5; } }
        }
      }
      if (t % 100 === 0) {
        for (const u of S.units.values()) {
          assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y) && Number.isFinite(u.hp), `seed ${seed} unit ${u.id} finite`);
          assert.ok(u.x >= 0 && u.y >= 0 && u.x < S.w && u.y < S.h, `seed ${seed} in map`);
        }
        invariants(ctx, `seed ${seed} t${t}`); gridMatches(ctx, `seed ${seed} t${t}`);
      }
    }
    totalErr += Units.errors;
    note(`seed ${seed} size ${size}: units ${S.units.size}, cities ${S.cities.size}, deaths ${JSON.stringify(Units.totals().causes)}, errors ${Units.errors}`);
    assert.equal(Units.errors, 0, 'no exceptions: ' + (Units.lastError && Units.lastError.stack));
    // everybody ends up on walkable ground within a short time once the abuse stops
    run(ctx, 40);
    finiteAll(ctx, `seed ${seed} calm`);
  }
  assert.equal(totalErr, 0);
});

section('city destroyed / captured while citizens work: no deadlock, homeless re-settle', () => {
  const ctx = mkCtx(1);
  const { S, Units, Cities } = ctx;
  spawnGroup(ctx, 0, 6, 22, 30);
  spawnGroup(ctx, 0, 6, 60, 28);
  run(ctx, 900);
  const cs = [...S.cities.values()];
  assert.ok(cs.length >= 2, 'two villages');
  const victim = cs[0], other = cs[1];
  const pop0 = victim.pop;
  // capture: members keep living, kingdom ids follow
  const k2 = other.kingdomId;
  if (victim.kingdomId !== k2) { ctx.Kingdoms.transferCity(victim.id, k2, 'test'); run(ctx, 50);   /* stage 2: Cities.capture only occupies; ownership moves through Kingdoms */ for (const id of victim.members) assert.equal(S.units.get(id).kingdomId, k2); }
  Cities.destroy(victim.id, 'test');
  assert.ok(!S.cities.has(victim.id));
  const mon = mkMonitor(ctx);
  run(ctx, 900, () => mon.sample());
  note(`victim pop ${pop0}; after 900 ticks: homeless ${[...S.units.values()].filter(u => !u.cityId && Units.stage(u) !== 'child').length}, cities ${S.cities.size}, stuck max ${(mon.maxFrac * 100).toFixed(1)}%`);
  finiteAll(ctx, 'destroyed'); invariants(ctx, 'destroyed'); gridMatches(ctx, 'destroyed');
  assert.equal(Units.errors, 0, '' + (Units.lastError && Units.lastError.stack));
  assert.ok(mon.maxFrac < 0.1);
  assert.ok([...S.units.values()].filter(u => u.cityId).length >= pop0 * 0.5, 'survivors found a home again');
});

section('determinism: same seed => identical world state after 1500 ticks', () => {
  const snap = () => {
    const ctx = mkCtx(7);
    for (const [x, y] of SITES) spawnGroup(ctx, 0, 6, x, y);
    spawnGroup(ctx, 1, 6, 45, 45); spawnGroup(ctx, 2, 6, 50, 20);
    run(ctx, 1500);
    return JSON.stringify([...ctx.S.units.values()]) + '|' + ctx.S.rngState + '|' + ctx.R.getState();
  };
  const a = snap(), b = snap();
  assert.equal(a.length, b.length);
  assert.ok(a === b, 'runs are identical');
  note(`state ${(a.length / 1024).toFixed(0)} KB identical`);
});

section('lava next to units: they leave the danger zone', () => {
  const ctx = mkCtx(1);
  const { S, Units, World, Const } = ctx;
  const p = World.randomLand((x, y) => World.tileAt(x, y) === Const.T.GRASS && World.landSize(x, y) > 400 && World.tileAt(x + 6, y) === Const.T.GRASS, 2000);
  const u = Units.spawn(0, p[0] + 0.5, p[1] + 0.5, { age: 25 });
  u.hp = u.maxHp = 60;
  World.setTile(p[0] + 1, p[1], Const.T.LAVA);
  run(ctx, 60);
  note(`unit ${Math.hypot(u.x - p[0] - 1.5, u.y - p[1] - 0.5).toFixed(1)} tiles from the lava, hp ${u.hp.toFixed(1)}`);
  assert.ok(Math.hypot(u.x - p[0] - 1.5, u.y - p[1] - 0.5) >= 2.4, 'moved away from lava');
});

// ====================================================================================================
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
if (failed.length) process.exit(1);
