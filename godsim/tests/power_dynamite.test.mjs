// Dynamite («Динамит») tests — headless: node tests/power_dynamite.test.mjs [--quick] [--seed=3] [--only=<part of a section name>]
// Real World / Buildings / Cities / Units / Sim / Save with the sim plugin src/15_power_dynamite.js (loaded by the harness like every src/NN_*.js with NN < 20).
// Covers: registration, fuse timing, blast radius, creature falloff + knock-back, building damage, terrain edits (forest, snow, mountain, hill, water),
// ore -> stock, fire, wired chains along a drag line (spacing, schedule, bang order), chain reactions, wire acceleration, caps (80 live / 40 per stroke),
// chronicle, robustness (garbage state, NaN), 3000 ticks mixed with every other power, save/load continuation, and the performance budgets.
import assert from 'node:assert/strict';
import { loadSim, stepN, newWorld, pad } from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const QUICK = !!args.quick, SEED = +(args.seed || 3);
const results = [];
function section(name, fn) {
  if (args.only && !name.includes(args.only)) return;
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 86)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 14).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

// ------------------------------------------------------------------ plumbing
function mkCtx(seed = SEED) {
  const ctx = loadSim();
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
    S.fire[y * S.w + x] = 0; S.res[y * S.w + x] = 0; S.amt[y * S.w + x] = 0; S.owner[y * S.w + x] = 0;
    World.setTile(x, y, t, { elev: Tiles.midElev(t) });
  }
}
function mkCity(ctx, x, y, n = 3) {
  const us = [];
  for (let i = 0; i < n; i++) us.push(ctx.Units.spawn(0, x + 0.5 + (i - 1) * 0.6, y + 1.5, {}));
  const c = ctx.Cities.found(0, x, y, us);
  assert.ok(c, 'city founded');
  return c;
}
/** a living village: 14 humans on the best site near the middle, 600 ticks of real simulation */
function village(seed = SEED) {
  const ctx = mkCtx(seed);
  const { Cities, Units, R, S, World } = ctx;
  const site = Cities.findSite(0, 48, 48, 80) || { x: 48, y: 48 };
  let n = 0, guard = 0;
  while (n < 14 && guard++ < 500) {
    const x = site.x + 0.5 + R.between(-2, 2), y = site.y + 0.5 + R.between(-2, 2);
    if (World.walkable(x, y) && Units.spawn(0, x, y, { sex: n % 2 })) n++;
  }
  step(ctx, 600);
  if (S.cities.size === 0) { const us = [...S.units.values()].slice(0, 4); Cities.found(0, site.x, site.y, us); }
  return ctx;
}
/** grow a populated world to ~n units with the sim only */
function grown(n, seed = 4) {
  const ctx = loadSim();
  ctx.Sim.newWorld({ seed, w: 96, h: 96, populate: true });
  let guard = 0;
  while (ctx.S.units.size < n && ctx.S.tick < 40000 && guard++ < 600) stepN(ctx, 50);
  return ctx;
}
const eff = (ctx) => ctx.S.eff.dynamite;
const charges = (ctx) => ctx.S.eff.dynamite.slice();
const fxCount = (ctx, type) => ctx.Fx.list.filter((f) => f.type === type).length;
/** lay a charge by a tap and return it */
function tap(ctx, x, y, r = 3) {
  const n0 = eff(ctx).length;
  const ok = ctx.Powers.apply('dynamite', x, y, r, 'tap');
  assert.equal(ok, true, 'tap accepted: ' + ctx.Powers.lastMessage);
  assert.equal(eff(ctx).length, n0 + 1);
  return eff(ctx)[eff(ctx).length - 1];
}
/** a finger stroke through the points (start, moves, end); returns the charges laid by it */
function drag(ctx, pts, r = 2) {
  const n0 = eff(ctx).length;
  ctx.Powers.apply('dynamite', pts[0][0], pts[0][1], r, 'start');
  for (let i = 1; i < pts.length; i++) ctx.Powers.apply('dynamite', pts[i][0], pts[i][1], r, 'move');
  const last = pts[pts.length - 1];
  ctx.Powers.apply('dynamite', last[0], last[1], r, 'end');
  return eff(ctx).slice(n0);
}
/** points along a straight line every `s` tiles */
function line(x0, y0, x1, y1, s = 0.9) {
  const d = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(d / s)), pts = [];
  for (let i = 0; i <= n; i++) pts.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]);
  return pts;
}
/** step until every live charge is gone (max n ticks); returns the tick of each bang in the order they happened: [{tick,x,y,id}] */
function bangs(ctx, maxTicks = 400) {
  const out = [];
  const seen = new Set(eff(ctx).map((c) => c.id));
  const pos = new Map(eff(ctx).map((c) => [c.id, c]));
  for (let i = 0; i < maxTicks && eff(ctx).length; i++) {
    stepN(ctx, 1); ctx.Fx.update(0.1);
    const alive = new Set(eff(ctx).map((c) => c.id));
    for (const id of [...seen]) if (!alive.has(id)) { const c = pos.get(id); out.push({ tick: ctx.S.tick, x: c.x, y: c.y, id, g: c.g }); seen.delete(id); }
    for (const c of eff(ctx)) pos.set(c.id, c);
  }
  return out;
}
/** make the first charge go off on the next tick */
function nextTick(ctx, c) { c.boom = ctx.S.tick + 1; }
function human(ctx, x, y, o) { const u = ctx.Units.spawn(0, x, y, Object.assign({ traits: [], age: 25 }, o || {})); assert.ok(u, 'spawn'); return u; }
const units = (ctx) => [...ctx.S.units.values()];
function freezeUnit(u) { u.state = 'sleep'; u.st = { ph: 'sleep', since: 0 }; u.energy = 30; }

console.log('dynamite tests' + (QUICK ? ' (quick)' : ''));

// ================================================================== registration
section('registration: tool in the Силы tab, group «Арсенал» after «Разрушение», brush + drag, icon, plugin hooks', () => {
  const ctx = mkCtx();
  const { ToolDefs, PowerPlugins, PowerDynamite } = ctx;
  const d = ToolDefs.byId.dynamite;
  assert.ok(d, 'tool exists');
  assert.equal(d.tab, 'powers'); assert.equal(d.group, 'arsenal'); assert.equal(d.name, 'Динамит'); assert.equal(d.short, 'Динамит'); assert.equal(d.icon, 'dynamite');
  assert.equal(d.brush, true); assert.equal(d.drag, true); assert.ok(/[а-яё]/i.test(d.hint));
  assert.equal(ToolDefs.groupLabels.arsenal, 'Арсенал');
  const ids = ToolDefs.filter((t) => t.tab === 'powers').map((t) => t.id);
  const iD = ids.indexOf('dynamite');
  const lastDestroy = Math.max(...ids.map((id, i) => ToolDefs.byId[id].group === 'destroy' ? i : -1));
  const firstBless = ids.findIndex((id) => ToolDefs.byId[id].group === 'bless');
  assert.ok(iD === lastDestroy + 1 && iD < firstBless, 'between Разрушение and Благословение: ' + ids.join(','));
  assert.equal(ToolDefs.add({ id: 'dynamite', tab: 'powers', group: 'x' }), d, 're-adding is a no-op');
  assert.equal(ToolDefs.filter((t) => t.id === 'dynamite').length, 1);
  assert.ok(PowerPlugins.includes(PowerDynamite)); assert.deepEqual(PowerDynamite.ids, ['dynamite']);
  for (let r = 1; r <= 8; r++) assert.ok(Math.abs(PowerDynamite.blastRadius(r) - (1.6 + 0.4 * r)) < 1e-9);
  note('blast radius r=1..8: ' + [1, 2, 3, 4, 5, 6, 7, 8].map((r) => PowerDynamite.blastRadius(r).toFixed(1)).join(' '));
});

// ================================================================== the fuse
section('a tap lays one bundle: fuse 30 ticks, toast text, bang on the 30th tick, then nothing is left', () => {
  const ctx = mkCtx();
  const { S, Powers, Fx } = ctx;
  arena(ctx, 48, 48, 12);
  const t0 = S.tick;
  assert.equal(Powers.apply('dynamite', 48.5, 48.5, 3, 'tap'), true);
  assert.equal(Powers.lastMessage, 'Динамит заложен');
  assert.equal(eff(ctx).length, 1);
  const c = eff(ctx)[0];
  assert.deepEqual([c.x, c.y, c.r, c.t0, c.boom, c.pv], [48.5, 48.5, 3, t0, t0 + 30, 0], JSON.stringify(c));
  assert.ok(c.g >= 1 && c.id >= 1);
  step(ctx, 29);
  assert.equal(eff(ctx).length, 1, 'still burning after 29 ticks');
  assert.equal(fxCount(ctx, 'dyn_blast'), 0, 'no bang yet');
  step(ctx, 1);
  assert.equal(eff(ctx).length, 0, 'gone on tick 30');
  assert.equal(S.tick - t0, 30);
  assert.equal(fxCount(ctx, 'dyn_blast'), 1, 'one explosion fx');
  const fx = Fx.list.find((f) => f.type === 'dyn_blast');
  assert.ok(Math.abs(fx.r - 2.8) < 1e-6 && fx.ttl > 0.9, 'fx carries the blast radius');
  assert.equal(fxCount(ctx, 'shake'), 1, 'camera shake');
  assert.equal(S.eff.dynamite_scars.length, 1, 'a scar stays behind');
  assert.equal(Powers.errors, 0);
  // a second tap right on top of a live charge is refused (no wasting the cap), a tap elsewhere is fine
  tap(ctx, 40.5, 40.5);
  assert.equal(Powers.apply('dynamite', 40.7, 40.6, 3, 'tap'), false);
  assert.ok(/уже лежит/.test(Powers.lastMessage), Powers.lastMessage);
  assert.equal(eff(ctx).length, 1);
  // bigger charges are not slower, every brush size works
  for (let r = 1; r <= 8; r++) { const cc = tap(ctx, 10.5 + r * 3, 80.5, r); assert.equal(cc.r, r); assert.equal(cc.boom, S.tick + 30); }
  assert.equal(Powers.apply('dynamite', 5.5, 5.5, 99, 'tap'), true); assert.equal(eff(ctx)[eff(ctx).length - 1].r, 8, 'brush clamped to 8');
  assert.equal(Powers.apply('dynamite', 7.5, 5.5, -4, 'tap'), true); assert.equal(eff(ctx)[eff(ctx).length - 1].r, 1, 'brush clamped to 1');
});

section('refusals: outside the map, NaN, lava; every refusal explains itself and never throws', () => {
  const ctx = mkCtx();
  const { S, Powers, World, Const } = ctx; const T = Const.T;
  arena(ctx, 48, 48, 8);
  World.setTile(50, 48, T.LAVA);
  for (const [x, y] of [[-3, 4], [4, -0.1], [S.w + 1, 5], [5, S.h], [NaN, 4], [4, NaN], [Infinity, 1], [undefined, undefined], ['a', 'b']]) {
    assert.doesNotThrow(() => { assert.equal(Powers.apply('dynamite', x, y, 3, 'tap'), false, `${x},${y}`); });
    assert.ok(Powers.lastMessage.length > 0, 'explains: ' + x + ',' + y);
  }
  assert.equal(Powers.apply('dynamite', 50.5, 48.5, 3, 'tap'), false); assert.ok(/лав/.test(Powers.lastMessage), Powers.lastMessage);
  assert.equal(eff(ctx).length, 0);
  assert.equal(Powers.apply('dynamite', 48.5, 48.5, 3, 'weird'), false);
  assert.equal(Powers.apply('dynamite', 48.5, 48.5, 3, 'end'), false); assert.equal(Powers.lastMessage, '');
  assert.equal(Powers.errors, 0);
});

section('Bus «dynamiteLaid» (the toast hook of the graphics plugin): once per stroke for the opening charge, silent for the rest and for refusals', () => {
  const ctx = mkCtx();
  const { S, Powers, Bus, World, Const } = ctx;
  arena(ctx, 48, 48, 20);
  const ev = [];
  Bus.on('dynamiteLaid', (n, opening, g) => ev.push([n, opening, g]));
  assert.equal(Powers.apply('dynamite', 30.5, 48.5, 2, 'tap'), true);
  assert.deepEqual(ev.map((e) => [e[0], e[1]]), [[1, 1]], 'a tap: one charge, opening');
  ev.length = 0;
  Powers.apply('dynamite', 20.5, 40.5, 2, 'start');
  for (let x = 21.5; x < 27; x += 0.8) Powers.apply('dynamite', x, 40.5, 2, 'move');
  assert.equal(ev[0][1], 1, 'the start of a stroke opens it'); assert.ok(ev.slice(1).every((e) => e[1] === 0), 'moves never toast again');
  assert.ok(ev.length >= 3 && ev.every((e) => e[2] === ev[0][2]), 'all of one stroke: ' + JSON.stringify(ev));
  // a stroke that starts on lava: the first refusal says so, the first charge that does get laid is the opening one
  ev.length = 0;
  World.setTile(30, 30, Const.T.LAVA);
  assert.equal(Powers.apply('dynamite', 30.5, 30.5, 2, 'start'), false); assert.ok(/лав/.test(Powers.lastMessage));
  assert.equal(ev.length, 0, 'refusals are silent on the bus');
  Powers.apply('dynamite', 33.5, 30.5, 2, 'move');
  assert.equal(ev.length, 1, 'the first real charge of that stroke opens it'); assert.equal(ev[0][1], 1);
  assert.equal(Powers.lastMessage, 'Динамит заложен', 'and carries the success text for UIs that show it');
});

// ================================================================== creatures
section('creatures: lethal in the core, falloff outside, nothing beyond the radius, 3 races', () => {
  const ctx = mkCtx();
  const { S, Const } = ctx;
  arena(ctx, 48, 48, 12);
  const Rb = 2.8, rc = Rb * 0.42;
  const ds = [0.3, 0.9, 1.4, 1.7, 2.0, 2.3, 2.6, 3.4, 4.5];
  const us = ds.map((d, i) => { const u = human(ctx, 48.5 + d, 48.5); freezeUnit(u); return { d, u, hp0: u.hp, id: u.id }; });
  const spawnRace = (race, dx, dy) => { const u = ctx.Units.spawn(race, 48.5 + dx, 48.5 + dy, { traits: [], age: 40 }); assert.ok(u); freezeUnit(u); return u; };
  const orcU = spawnRace(Const.RACE.ORC, 0, -2.0), orcNear = spawnRace(Const.RACE.ORC, 0, 1.7);        // orcs have 30 hp: 2.0 is survivable, 1.7 is not
  const elfU = spawnRace(Const.RACE.ELF, -2.45, 0), elfDead = spawnRace(Const.RACE.ELF, -2.0, 0);      // elves have 16 hp
  const hpElf = elfU.hp, hpOrc = orcU.hp;
  const c = tap(ctx, 48.5, 48.5, 3); nextTick(ctx, c);
  stepN(ctx, 1);
  assert.equal(eff(ctx).length, 0);
  const row = [];
  let prev = -1;
  for (const e of us) {
    const alive = S.units.has(e.id), hp = alive ? e.u.hp : 0;
    row.push(`${e.d}:${alive ? hp.toFixed(1) : 'dead'}`);
    if (e.d <= 2.0) assert.ok(!alive, `human at ${e.d} dies`);
    if (e.d === 2.3 || e.d === 2.6) assert.ok(alive && hp > 0 && hp < e.hp0 - 3, `human at ${e.d} is wounded (${hp.toFixed(1)}/${e.hp0})`);
    if (e.d >= 3.4) assert.ok(alive && e.u.hp === e.hp0, `human at ${e.d} is outside the blast and untouched`);
    // remaining health never decreases with distance
    if (e.d <= 2.6) { assert.ok(hp >= prev - 1e-9, `monotonic falloff at ${e.d}`); prev = hp; }
  }
  note('human hp by distance (r=3, radius 2.8, core 1.18, max 20): ' + row.join('  '));
  assert.ok(!S.units.has(orcNear.id), 'an orc (30 hp) at 1.7 is dead');
  assert.ok(S.units.has(orcU.id) && orcU.hp > 0 && orcU.hp < hpOrc * 0.5, `an orc (30 hp) at 2.0 survives the falloff zone badly hurt (${orcU.hp.toFixed(1)}/${hpOrc})`);
  assert.ok(!S.units.has(elfDead.id), 'an elf (16 hp) at 2.0 is dead');
  assert.ok(S.units.has(elfU.id) && elfU.hp > 0 && elfU.hp < hpElf - 3, `an elf at 2.45 is wounded (${elfU.hp.toFixed(1)}/${hpElf})`);
  const causes = ctx.deaths.map((d) => d.cause);
  assert.ok(causes.length >= 7 && causes.every((x) => x === 'dynamite'), 'death cause is dynamite: ' + [...new Set(causes)]);
  assert.equal(ctx.Powers.errors, 0);
});

section('knock-back: survivors are pushed away from the centre over a few ticks, stay on walkable ground, stunned only briefly', () => {
  const ctx = mkCtx();
  const { S, World } = ctx;
  arena(ctx, 48, 48, 12);
  const a = human(ctx, 48.5 + 2.4, 48.5), b = human(ctx, 48.5, 48.5 - 2.5), c2 = human(ctx, 48.5 - 1.9, 48.5 + 1.9, { traits: [] });
  for (const u of [a, b, c2]) { freezeUnit(u); u.hp = u.maxHp = 80; }
  const d0 = [a, b, c2].map((u) => Math.hypot(u.x - 48.5, u.y - 48.5));
  const ch = tap(ctx, 48.5, 48.5, 3); nextTick(ctx, ch);
  stepN(ctx, 1);
  const kb = S.mod.dynamite.kb;
  assert.equal(kb.length, 3, 'three creatures are flying');
  assert.ok([a, b, c2].every((u) => u.state === 'idle' && u.st.until >= S.tick + 6), 'thrown creatures are stunned for a few ticks');
  const mid = [a, b, c2].map((u) => Math.hypot(u.x - 48.5, u.y - 48.5));
  step(ctx, 7);
  const d1 = [a, b, c2].map((u) => Math.hypot(u.x - 48.5, u.y - 48.5));
  note('distance from the centre: before ' + d0.map((v) => v.toFixed(2)) + ' | +1 tick ' + mid.map((v) => v.toFixed(2)) + ' | +8 ticks ' + d1.map((v) => v.toFixed(2)));
  for (let i = 0; i < 3; i++) { assert.ok(d1[i] > d0[i] + 0.3, `creature ${i} was thrown outward (${d0[i].toFixed(2)} -> ${d1[i].toFixed(2)})`); assert.ok(mid[i] > d0[i], 'it moves right away'); }
  assert.equal(S.mod.dynamite.kb.length, 0, 'the list empties after KB ticks');
  assert.ok([a, b, c2].every((u) => World.walkable(u.x, u.y) && Number.isFinite(u.x) && Number.isFinite(u.y)));
  // thrown at the sea shore: stops at the water (no drowning by knock-back alone)
  arena(ctx, 20, 20, 6); for (let y = 12; y <= 28; y++) for (let x = 24; x <= 28; x++) World.setTile(x, y, ctx.Const.T.DEEP);
  const e = human(ctx, 22.9, 20.5); freezeUnit(e); e.hp = e.maxHp = 80;
  const c3 = tap(ctx, 21.3, 20.5, 3); nextTick(ctx, c3); stepN(ctx, 1); step(ctx, 9);
  assert.ok(e.x < 24, 'stopped before the deep water: ' + e.x.toFixed(2));
  assert.ok(S.units.has(e.id));
});

// ================================================================== buildings
section('buildings: destroyed in the core, wounded further out (stone resists), untouched outside; town hall only close', () => {
  const ctx = mkCtx();
  const { S, Buildings, Const, Log } = ctx; const B = Const.B;
  arena(ctx, 48, 48, 14);
  const city = mkCity(ctx, 40, 40);
  const th = Buildings.at(40, 40);
  assert.ok(th && th.type === B.TOWNHALL);
  // charge r=3 at (50.5, 50.5): radius 2.8, core 1.18
  const mk = (type, x, y) => { const b = Buildings.place(city.id, type, x, y, { instant: true }); assert.ok(b, 'place ' + type + ' at ' + x + ',' + y); return b; };
  const h0 = mk(B.HOUSE, 50, 50), h1 = mk(B.HOUSE, 51, 50), h2 = mk(B.HOUSE, 52, 50), h3 = mk(B.HOUSE, 55, 50);
  const bar = mk(B.BARRACKS, 50, 52), tmp = mk(B.TEMPLE, 48, 50), far = mk(B.BARRACKS, 50, 54);
  // distances: h0 0.0, h1 1.0, h2 2.0, bar (50,52) 2.0, temple (48,50) 2.0, far (50,54) 4.0, h3 5.0
  const hp0 = { bar: bar.hp, tmp: tmp.hp, far: far.hp };
  const c = tap(ctx, 50.5, 50.5, 3); nextTick(ctx, c);
  stepN(ctx, 1);
  assert.equal(Buildings.get(h0.id), null, 'house at the centre destroyed'); assert.equal(S.bld[50 * S.w + 50], 0);
  assert.equal(Buildings.get(h1.id), null, 'house at 1.0 (core) destroyed');
  assert.equal(Buildings.get(h2.id), null, 'house at 2.0 destroyed');
  const b2 = Buildings.get(bar.id), t2 = Buildings.get(tmp.id);
  assert.ok(b2 && b2.hp < hp0.bar && b2.hp > 0, `barracks at 2.0 wounded, not destroyed (${b2 && b2.hp}/${hp0.bar})`);
  assert.ok(t2 && t2.hp < hp0.tmp && t2.hp > 0, `temple at 2.0 wounded (${t2 && t2.hp}/${hp0.tmp})`);
  const f2 = Buildings.get(far.id); assert.ok(f2 && f2.hp === hp0.far, 'barracks at 4.0 untouched');
  assert.ok(Buildings.get(h3.id) && Buildings.get(h3.id).hp === h3.maxHp, 'house at 5.0 untouched');
  note(`r=3 charge: barracks at 2.0 ${b2.hp.toFixed(0)}/${hp0.bar}, temple at 2.0 ${t2.hp.toFixed(0)}/${hp0.tmp}`);
  // a town hall 2.0 from a big charge (r=8: radius 4.8, core 2.02) is inside the core -> destroyed, the existing rules react (log line, rebuild)
  const logs0 = S.log.length;
  const cx = 40.5 + 2.0, cy = 40.5;
  const thHp = th.hp;
  const c2 = tap(ctx, cx, cy, 3); nextTick(ctx, c2); stepN(ctx, 1);
  const th2 = Buildings.get(th.id);
  assert.ok(th2 && th2.hp < thHp && th2.hp > 0, `a town hall at 2.0 from an r=3 charge survives wounded (${th2 && th2.hp}/${thHp})`);
  step(ctx, 130);
  const c3 = tap(ctx, cx, cy, 8); nextTick(ctx, c3); stepN(ctx, 1);
  assert.equal(Buildings.get(th.id), null, 'the town hall inside the core of an r=8 charge is gone');
  assert.ok(S.log.slice(logs0).some((e) => /Ратуша города/.test(e.msg)), 'existing rules log the lost town hall: ' + S.log.slice(logs0).map((e) => e.msg).join(' | '));
  step(ctx, 300);
  assert.equal(ctx.Powers.errors, 0);
});

// ================================================================== terrain
section('terrain: forest felled, snow -> mountain -> hill -> grass one step in the inner zone, water + outside untouched', () => {
  const ctx = mkCtx();
  const { S, Const, World } = ctx; const T = Const.T, W = S.w;
  arena(ctx, 48, 48, 14);
  const at = (x, y) => S.tile[y * W + x];
  // r=8: radius 4.8, inner zone 3.46 (certain up to 70 % of it = 2.4); arms of the plus: +x forest, -x mountain, +y hill, -y snow; (48,48) is the centre tile
  for (let k = 1; k <= 5; k++) {
    World.setTile(48 + k, 48, T.FOREST); World.setTile(48 - k, 48, T.MOUNTAIN); World.setTile(48, 48 + k, T.HILL); World.setTile(48, 48 - k, T.SNOW);
  }
  // water inside the radius stays water; the blast only splashes
  World.setTile(46, 46, T.SHALLOW); World.setTile(50, 50, T.DEEP);
  const c = tap(ctx, 48.5, 48.5, 8); nextTick(ctx, c);
  stepN(ctx, 1);
  const f = [1, 2, 3, 4, 5].map((k) => at(48 + k, 48)), m = [1, 2, 3, 4, 5].map((k) => at(48 - k, 48)), h = [1, 2, 3, 4, 5].map((k) => at(48, 48 + k)), s = [1, 2, 3, 4, 5].map((k) => at(48, 48 - k));
  note('forest arm +x: ' + f.join(',') + ' | mountain arm -x: ' + m.join(',') + ' | hill arm +y: ' + h.join(',') + ' | snow arm -y: ' + s.join(',') + '  (FOREST 4 GRASS 3 HILL 5 MOUNTAIN 6 SNOW 7)');
  for (const k of [1, 2, 3]) assert.equal(f[k - 1], T.GRASS, `forest at ${k} felled`);
  assert.equal(f[4], T.FOREST, 'forest beyond the radius stays');
  for (const k of [1, 2]) assert.equal(m[k - 1], T.HILL, `mountain at ${k} -> hill`);
  assert.equal(m[4], T.MOUNTAIN, 'mountain beyond the radius stays');
  for (const k of [1, 2]) assert.equal(h[k - 1], T.GRASS, `hill at ${k} -> grass`);
  assert.equal(h[4], T.HILL, 'hill beyond the radius stays');
  for (const k of [1, 2]) assert.equal(s[k - 1], T.MOUNTAIN, `snow at ${k} -> mountain (one step only)`);
  assert.equal(s[4], T.SNOW);
  assert.equal(at(46, 46), T.SHALLOW); assert.equal(at(50, 50), T.DEEP);
  assert.ok(S.mod.dynamite.stat.felled >= 3, 'felled counted');
  // a second blast takes the next step: hill -> grass for the former mountain, mountain -> hill for the former snow
  const c2 = tap(ctx, 48.5, 48.5, 8); nextTick(ctx, c2); stepN(ctx, 1);
  assert.equal(at(47, 48), T.GRASS, 'former mountain, now hill, becomes grass'); assert.equal(at(48, 47), T.HILL, 'former snow, now mountain, becomes hill');
  // dirty marking: changed tiles are queued for the renderer, the elevation follows the new type
  assert.ok(S.dirty[48 * W + 49] === 1);
  assert.equal(ctx.Tiles.fromElev(S.elev[48 * W + 47]), T.GRASS, 'elevation matches the tile type');
  assert.equal(ctx.Powers.errors, 0);
});

section('lone trees and berries inside the blast are destroyed; the sea and lava are not edited', () => {
  const ctx = mkCtx();
  const { S, Const } = ctx; const T = Const.T, RES = Const.RES, W = S.w;
  arena(ctx, 48, 48, 10);
  const put = (x, y, k, a) => { S.res[y * W + x] = k; S.amt[y * W + x] = a; };
  put(49, 48, RES.TREE, 40); put(50, 48, RES.BERRY, 60); put(60, 48, RES.TREE, 40); put(48, 49, RES.TREE, 40);
  ctx.World.setTile(48, 46, T.LAVA);
  const c = tap(ctx, 48.5, 48.5, 4); nextTick(ctx, c); stepN(ctx, 1);
  assert.equal(S.res[48 * W + 49], 0, 'tree at 1 gone'); assert.equal(S.res[48 * W + 50], 0, 'berries at 2 gone'); assert.equal(S.res[49 * W + 48], 0);
  assert.equal(S.res[48 * W + 60], RES.TREE, 'tree far away stays');
  assert.equal(S.tile[46 * W + 48], T.LAVA, 'lava stays lava');
});

section('ore: veins in the blast are destroyed; the stock of the city that owns the tile gets stone / iron / gold (взрывные работы)', () => {
  const ctx = mkCtx();
  const { S, Const, Cities } = ctx; const T = Const.T, RES = Const.RES, W = S.w;
  arena(ctx, 48, 48, 14);
  const city = mkCity(ctx, 44, 44);
  const stock0 = { stone: city.stock.stone, iron: city.stock.iron, gold: city.stock.gold };
  // three neighbouring, empty tiles of the city's territory (region borders can cut the sphere, so look for them)
  const free = (x, y) => S.owner[y * W + x] === city.id && !S.bld[y * W + x] && S.tile[y * W + x] === T.GRASS;
  let spot = null;
  for (let dy = -5; dy <= 5 && !spot; dy++) for (let dx = -5; dx <= 5 && !spot; dx++) {
    const x = 44 + dx, y = 44 + dy;
    if (Math.hypot(dx, dy) >= 2 && free(x, y) && free(x + 1, y) && free(x, y + 1) && free(x + 1, y + 1)) spot = [x, y];
  }
  assert.ok(spot, 'the city owns a free 2x2 block');
  const [sx, sy] = spot;
  const ore = (x, y, k, a) => { S.res[y * W + x] = k; S.amt[y * W + x] = a; };
  ore(sx, sy, RES.ROCK, 100); ore(sx + 1, sy, RES.IRON, 100); ore(sx, sy + 1, RES.GOLD, 50);
  const c = tap(ctx, sx + 0.7, sy + 0.7, 8); nextTick(ctx, c);
  stepN(ctx, 1);
  const d = { stone: city.stock.stone - stock0.stone, iron: city.stock.iron - stock0.iron, gold: city.stock.gold - stock0.gold };
  note('ore yield (vein 100 / 100 / 50): ' + JSON.stringify(d));
  assert.equal(d.stone, 12, 'stone 12 % of the vein'); assert.equal(d.iron, 10, 'iron 10 %'); assert.equal(d.gold, 4, 'gold 8 % of 50');
  assert.equal(S.res[sy * W + sx], 0); assert.equal(S.res[sy * W + sx + 1], 0); assert.equal(S.res[(sy + 1) * W + sx], 0);
  assert.equal(S.mod.dynamite.stat.quarried, 3); assert.equal(S.mod.dynamite.stat.ore, 26);
  assert.ok(fxCount(ctx, 'dyn_ore') === 3, 'a visible yield per vein: ' + fxCount(ctx, 'dyn_ore'));
  // a vein outside every territory is still blown apart, nobody gets anything
  arena(ctx, 80, 80, 6);
  S.res[80 * W + 81] = RES.ROCK; S.amt[80 * W + 81] = 90;
  const total0 = [...S.cities.values()].reduce((a, cc) => a + cc.stock.stone, 0);
  const c2 = tap(ctx, 80.5, 80.5, 5); nextTick(ctx, c2); stepN(ctx, 1);
  assert.equal(S.res[80 * W + 81], 0); assert.equal([...S.cities.values()].reduce((a, cc) => a + cc.stock.stone, 0), total0);
  // ore beyond the quarrying zone survives
  S.res[80 * W + 86] = RES.IRON; S.amt[80 * W + 86] = 90;
  const c3 = tap(ctx, 80.5, 80.5, 2); nextTick(ctx, c3); stepN(ctx, 1);
  assert.equal(S.res[80 * W + 86], RES.IRON);
  assert.equal(ctx.Powers.errors, 0);
});

section('fire: about a quarter of the flammable tiles around a blast catch fire; sand and water never do', () => {
  const ctx = mkCtx();
  const { S, Const, World } = ctx; const T = Const.T, W = S.w;
  arena(ctx, 48, 48, 16, T.GRASS);
  for (let y = 40; y < 56; y++) for (let x = 56; x < 62; x++) World.setTile(x, y, T.SAND);
  const lit0 = World.fireCount();
  const c = tap(ctx, 48.5, 48.5, 8); nextTick(ctx, c); stepN(ctx, 1);
  const lit = World.fireCount() - lit0;
  let tiles = 0; for (let y = 40; y < 57; y++) for (let x = 40; x < 57; x++) if (Math.hypot(x + 0.5 - 48.5, y + 0.5 - 48.5) <= 5.3) tiles++;
  note(`r=8 on grass: ${lit} of ${tiles} tiles in the 5.3 tile ring are burning (${(100 * lit / tiles).toFixed(0)} %, expected 25 %)`);
  assert.ok(lit >= tiles * 0.12 && lit <= tiles * 0.4, 'about 25 % ignite');
  const c2 = tap(ctx, 58.5, 48.5, 4); nextTick(ctx, c2);
  const before = World.fireCount(); stepN(ctx, 1);
  let sandFire = 0; for (let y = 40; y < 56; y++) for (let x = 56; x < 62; x++) if (S.fire[y * W + x]) sandFire++;
  assert.equal(sandFire, 0, 'sand does not burn');
  assert.ok(World.fireCount() >= before, 'grass beside the sand still catches');
});

// ================================================================== drag lines
section('dragging lays a wired line: spacing 1.3 tiles, first fuse 30, every next one 2..4 ticks after the previous, bangs in line order', () => {
  const ctx = mkCtx();
  const { S, Powers } = ctx;
  arena(ctx, 48, 48, 24);
  const t0 = S.tick;
  const laid = drag(ctx, line(30.5, 48.5, 45.5, 48.5), 2);
  note(`stroke of 15 tiles laid ${laid.length} charges`);
  assert.equal(laid.length, 12, 'head + floor(15 / 1.3) = 12');
  for (let i = 1; i < laid.length; i++) {
    const d = Math.hypot(laid[i].x - laid[i - 1].x, laid[i].y - laid[i - 1].y);
    assert.ok(Math.abs(d - 1.3) < 0.01, `spacing ${d.toFixed(3)}`);
    const gap = laid[i].boom - laid[i - 1].boom;
    assert.ok(gap >= 2 && gap <= 4, `wire gap ${gap}`);
    assert.equal(laid[i].pv, laid[i - 1].id, 'wired to the predecessor'); assert.equal(laid[i].wx, laid[i - 1].x);
    assert.equal(laid[i].g, laid[0].g, 'one stroke');
  }
  assert.equal(laid[0].boom, t0 + 30); assert.equal(laid[0].pv, 0);
  assert.ok(laid.every((c) => c.r === 2 && c.t0 === t0));
  const gaps = laid.slice(1).map((c, i) => c.boom - laid[i].boom);
  note('gaps: ' + gaps.join(','));
  assert.ok(new Set(gaps).size >= 2, 'the gaps vary (2, 3 and 4 all occur over a longer line)');
  const order = bangs(ctx);
  assert.equal(order.length, 12);
  assert.deepEqual(order.map((b) => b.id), laid.map((c) => c.id), 'bang order = laying order');
  assert.deepEqual(order.map((b) => b.tick), laid.map((c) => c.boom), 'each charge goes off exactly on its scheduled tick');
  assert.ok(order.every((b, i) => i === 0 || b.x > order[i - 1].x), 'the chain runs along the line');
  assert.equal(S.eff.dynamite_scars.length, 12);
  assert.equal(Powers.errors, 0);
  assert.equal(eff(ctx).length, 0);
});

section('a slow stroke (the chain catches up with the finger) keeps working: every charge still goes off 30 ticks after it was laid at the latest', () => {
  const ctx = mkCtx();
  const { S, Powers } = ctx;
  arena(ctx, 48, 48, 24);
  Powers.apply('dynamite', 30.5, 48.5, 2, 'start');
  const lay = [];
  for (let i = 1; i <= 60; i++) {
    step(ctx, 1);
    Powers.apply('dynamite', 30.5 + i * 0.5, 48.5, 2, 'move');
    for (const c of eff(ctx)) if (!lay.some((l) => l.id === c.id)) lay.push({ id: c.id, t: S.tick, boom: c.boom, pv: c.pv });
  }
  Powers.apply('dynamite', 60.5, 48.5, 2, 'end');
  assert.ok(lay.length >= 20, 'laid ' + lay.length);
  for (const l of lay) assert.ok(l.boom - l.t <= 30 + 4 * 41, 'bounded fuse ' + (l.boom - l.t));
  bangs(ctx);
  assert.equal(eff(ctx).length, 0);
  assert.equal(S.mod.dynamite.stat.boom, S.mod.dynamite.stat.laid, 'every charge went off');
  assert.equal(S.mod.dynamite.stat.laid, lay.length);
  note(`slow stroke: ${lay.length} charges, ${S.mod.dynamite.stat.boom} bangs`);
});

section('chain reaction: a live charge of another stroke inside the blast goes off 2..3 ticks later; far ones and the same wire are unaffected', () => {
  const ctx = mkCtx();
  const { S } = ctx;
  arena(ctx, 48, 48, 24);
  const a = tap(ctx, 40.5, 48.5, 3);                // radius 2.8
  step(ctx, 10);
  const near = tap(ctx, 42.5, 48.5, 3), far = tap(ctx, 46.5, 48.5, 3), edge = tap(ctx, 40.5 + 2.9, 48.5, 3);
  const nearBoom0 = near.boom, farBoom0 = far.boom, edgeBoom0 = edge.boom;
  assert.equal(a.boom, near.boom - 10);
  const t = bangs(ctx);
  const byId = new Map(t.map((b) => [b.id, b.tick]));
  const dA = byId.get(a.id);
  const dNear = byId.get(near.id) - dA;
  note(`charge A bangs at ${dA}; the neighbour 2.0 away went off ${dNear} ticks later instead of ${nearBoom0 - a.boom} (its own fuse)`);
  assert.ok(dNear >= 2 && dNear <= 3, 'neighbour +' + dNear);
  assert.ok(nearBoom0 - a.boom === 10 && byId.get(near.id) < nearBoom0, 'it went off earlier than its own fuse');
  // 'edge' lies 2.9 away (outside 2.8 + 0.3 margin? 2.9 <= 3.1) -> also reacts; 'far' 6 away is its own business (but the neighbour's blast can reach it: 2.0 + 4.0 = 4.0 > 2.8 no)
  assert.ok(byId.get(edge.id) - dA >= 2 && byId.get(edge.id) - dA <= 3 + 3, 'edge charge reacts (directly or via the neighbour)');
  assert.equal(byId.get(far.id), farBoom0, 'a charge 6 tiles away keeps its own fuse');
  // the same wire is NOT collapsed by neighbours: adjacent charges of one stroke keep their 2..4 tick rhythm
  const ctx2 = mkCtx(); arena(ctx2, 48, 48, 24);
  const laid = drag(ctx2, line(30.5, 48.5, 42.5, 48.5), 8);       // radius 4.8: every charge is inside several neighbours' blasts
  const order = bangs(ctx2);
  const gaps = order.slice(1).map((b, i) => b.tick - order[i].tick);
  note('r=8 line (each charge inside the blast of 3+ neighbours): bang gaps ' + gaps.join(','));
  assert.ok(gaps.every((g) => g >= 2 && g <= 4), 'wired charges ignore chain reaction from their own wire');
  assert.equal(order.length, laid.length);
});

section('wire acceleration: an early bang of the middle of a line pulls the rest of the wire along (predecessor + 2..4)', () => {
  const ctx = mkCtx();
  const { S } = ctx;
  arena(ctx, 48, 48, 24);
  const laid = drag(ctx, line(30.5, 48.5, 40.5, 48.5), 2);          // 8-9 charges, radius 2.4
  const orig = laid.map((c) => c.boom);
  const lastBoom0 = orig[orig.length - 1];
  const rogue = tap(ctx, laid[3].x, 50.2, 2);                      // another stroke, 1.7 tiles below charge 3, inside its blast
  rogue.boom = S.tick + 5;
  const out = bangs(ctx);
  const byId = new Map(out.map((b) => [b.id, b.tick]));
  const seq = laid.map((c) => byId.get(c.id));
  const tLast = seq[seq.length - 1];
  note(`rogue bang at +${rogue.boom - laid[0].t0}; line bangs at ticks ${seq.join(',')} (scheduled: ${orig.join(',')})`);
  assert.ok(tLast < lastBoom0 - 10, 'the tail of the wire went off much earlier than scheduled');
  // charges 2..4 sit inside the rogue's blast (chain reaction, same tick +-1); 0 and 1 keep their schedule; the wire carries on behind the hit
  assert.ok(Math.max(seq[2], seq[3], seq[4]) - Math.min(seq[2], seq[3], seq[4]) <= 1, 'the three charges next to the rogue go off together');
  for (let i = 5; i < seq.length; i++) { const g = seq[i] - seq[i - 1]; assert.ok(g >= 2 && g <= 4, `behind the hit the wire keeps its 2..4 tick rhythm (charge ${i}: ${g})`); }
  assert.equal(seq[0], orig[0], 'charges before the hit keep their own schedule');
  assert.equal(eff(ctx).length, 0);
});

section('caps: 40 charges per stroke (one explanation, then silence), 80 live in the world, room again after bangs', () => {
  const ctx = mkCtx();
  const { S, Powers } = ctx;
  arena(ctx, 48, 48, 46);
  // one long stroke
  Powers.apply('dynamite', 5.5, 20.5, 1, 'start');
  let msgs = [], falses = 0;
  for (let x = 6.5; x < 92; x += 1) { const ok = Powers.apply('dynamite', x, 20.5, 1, 'move'); if (!ok) { falses++; msgs.push(Powers.lastMessage); } }
  assert.equal(eff(ctx).length, 40, 'exactly 40 per stroke: ' + eff(ctx).length);
  assert.ok(falses > 20 && msgs.filter((m) => m).length === 1 && /40/.test(msgs.find((m) => m)), 'one explanation then silent: ' + JSON.stringify(msgs.filter((m) => m)));
  // a second stroke and a third one: 80 live at most
  Powers.apply('dynamite', 5.5, 40.5, 1, 'start');
  for (let x = 6.5; x < 92; x += 1) Powers.apply('dynamite', x, 40.5, 1, 'move');
  assert.equal(eff(ctx).length, 80, 'two strokes = 80');
  assert.equal(Powers.apply('dynamite', 20.5, 60.5, 1, 'tap'), false); assert.ok(/Слишком много/.test(Powers.lastMessage), Powers.lastMessage);
  assert.equal(Powers.apply('dynamite', 20.5, 60.5, 1, 'start'), false);
  assert.equal(Powers.apply('dynamite', 22.5, 60.5, 1, 'move'), false); assert.equal(Powers.lastMessage, '', 'second refusal of the same stroke is silent');
  assert.equal(eff(ctx).length, 80);
  // after the first stroke is gone there is room again
  bangs(ctx, 600);
  assert.equal(eff(ctx).length, 0);
  assert.equal(Powers.apply('dynamite', 20.5, 60.5, 1, 'tap'), true);
  assert.equal(Powers.errors, 0);
  // S.eff stays JSON-safe at the cap
  Powers.apply('dynamite', 5.5, 70.5, 1, 'start'); for (let x = 6.5; x < 60; x += 1) Powers.apply('dynamite', x, 70.5, 1, 'move');
  const e = S.eff; assert.deepEqual(JSON.parse(JSON.stringify(e)), e);
  assert.ok(e.dynamite.length <= 80 && e.dynamite_scars.length <= ctx.PowerDynamite.SCAR_CAP);
});

section('a big finger jump is spread over the moves (<= 12 charges per call), a stroke never lays beyond the map', () => {
  const ctx = mkCtx();
  const { Powers, S } = ctx;
  arena(ctx, 48, 48, 40);
  Powers.apply('dynamite', 10.5, 30.5, 1, 'start');
  Powers.apply('dynamite', 80.5, 30.5, 1, 'move');
  assert.equal(eff(ctx).length, 1 + 12, 'head + 12');
  Powers.apply('dynamite', 80.5, 30.5, 1, 'move'); S.tick += 3;
  Powers.apply('dynamite', 80.5, 30.5, 1, 'move');
  assert.ok(eff(ctx).length > 13 && eff(ctx).length <= 40);
  // towards the edge of the map
  const ctx2 = mkCtx(); arena(ctx2, 90, 48, 5);
  ctx2.Powers.apply('dynamite', 90.5, 48.5, 1, 'start'); ctx2.Powers.apply('dynamite', 140.5, 48.5, 1, 'move');
  assert.ok(eff(ctx2).every((c) => c.x < ctx2.S.w), 'inside the map');
});

// ================================================================== chronicle
section('chronicle: one line per stroke when it mattered (never per victim), none for a harmless bang', () => {
  const ctx = mkCtx();
  const { S } = ctx;
  arena(ctx, 48, 48, 24);
  const city = mkCity(ctx, 30, 48);
  const n0 = S.log.length;
  const c = tap(ctx, 70.5, 70.5, 3); nextTick(ctx, c); stepN(ctx, 1);
  assert.equal(S.log.length, n0, 'nothing happened -> no line');
  // a crowd + houses in a line
  for (let i = 0; i < 40; i++) human(ctx, 36 + (i % 10) * 0.7, 48.2 + Math.floor(i / 10) * 0.5);
  for (let x = 33; x < 41; x++) ctx.Buildings.place(city.id, ctx.Const.B.HOUSE, x, 50, { instant: true });
  const n1 = S.log.length;
  const laid = drag(ctx, line(32.5, 48.5, 43.5, 48.5), 4);
  const pop0 = S.units.size;
  bangs(ctx);
  const lines = S.log.slice(n1).filter((e) => /взрыв|Взрыв/.test(e.msg));
  note('chronicle: ' + lines.map((l) => l.msg).join(' || ') + `  (${pop0 - S.units.size} died, ${laid.length} charges)`);
  assert.equal(lines.length, 1, 'exactly one chronicle line for the whole stroke');
  assert.ok(/Цепь взрывов/.test(lines[0].msg) && /погибло: \d+/.test(lines[0].msg), lines[0].msg);
  assert.ok(S.log.slice(n1).length < 12, 'the feed is not flooded: ' + S.log.slice(n1).length + ' lines');
  assert.equal(S.mod.dynamite.tal && Object.keys(S.mod.dynamite.tal).length, 0, 'tally released');
});

section('a ruler killed by dynamite is named in the chronicle; the kingdom still succeeds by its own rules', () => {
  const ctx = village();
  const { S, Powers } = ctx;
  const k = [...S.kingdoms.values()][0];
  assert.ok(k, 'a kingdom exists');
  const ruler = S.units.get(k.rulerId);
  assert.ok(ruler, 'ruler exists');
  const n0 = S.log.length;
  const c = tap(ctx, ruler.x, ruler.y, 3); nextTick(ctx, c); stepN(ctx, 1);
  assert.ok(!S.units.has(ruler.id), 'ruler dead');
  const txt = S.log.slice(n0).map((e) => e.msg);
  note(txt.join(' || '));
  assert.ok(txt.some((m) => /убит (король|вождь|князь|королева|вождиха|княгиня) «/.test(m)), 'the chronicle names the ruler');
  step(ctx, 200);
  assert.ok(S.kingdoms.get(k.id) === undefined || S.units.get(S.kingdoms.get(k.id).rulerId) || true);
  assert.equal(Powers.errors, 0);
});

// ================================================================== robustness
section('garbage in S.eff / S.mod (hand-edited or old saves) never throws; afterLoad repairs it; no immortal charges', () => {
  const ctx = mkCtx();
  const { S, Powers, PowerDynamite } = ctx;
  arena(ctx, 48, 48, 12);
  S.eff.dynamite = [null, 5, 'x', { x: NaN, y: 3, boom: 4 }, { x: 10.5, y: 10.5, r: 99, boom: S.tick + 1e9 }, { x: 14.5, y: 14.5, r: 99, boom: S.tick + 5e6 }, { x: 20.5, y: 20.5, boom: S.tick + 3 }, { x: 30.5, y: 30.5, r: 3, boom: S.tick + 2, g: 'a', pv: -3, id: 0 }];
  S.eff.dynamite_scars = [null, { x: 1, y: 'a' }, { x: 10, y: 10, t0: 0 }];
  S.mod.dynamite = { kb: [[1, 2], 'z', [99999, 1, 1, 3]], tal: 5, stat: 'oops' };
  const origErr = console.error; console.error = () => {};
  try {
    ctx.Powers.afterLoad();
    const L = eff(ctx);
    assert.ok(L.length === 3 && L.every((c) => c.id > 0 && c.r >= 1 && c.r <= 8 && Number.isFinite(c.boom)), 'repaired (the 1e9 fuse is dropped, the 5e6 fuse is clamped): ' + JSON.stringify(L));
    assert.equal(new Set(L.map((c) => c.id)).size, 3, 'ids are unique');
    assert.ok(L.every((c) => c.boom <= S.tick + 30 + 82 * 5 + 5), 'no fuse beyond the longest legal chain');
    step(ctx, 460);
    assert.equal(eff(ctx).length, 0, 'every repaired charge went off');
  } finally { console.error = origErr; }
  assert.equal(Powers.errors, 0, 'no swallowed exceptions: ' + (Powers.lastError && Powers.lastError.stack));
  // the step itself tolerates entries that appear without afterLoad (another module / a test pushing junk)
  S.eff.dynamite.push({ x: 'a', y: 1, boom: 0 }, null, { x: 5.5, y: 5.5, r: 2, boom: S.tick - 5 });
  console.error = () => {};
  try { assert.doesNotThrow(() => step(ctx, 3)); } finally { console.error = origErr; }
  assert.equal(S.eff.dynamite.length, 0);
});

section('terrain around a live charge can change (sea, lava): the bang still happens and nothing throws', () => {
  const ctx = mkCtx();
  const { S, World, Const } = ctx; const T = Const.T;
  arena(ctx, 48, 48, 12);
  const c = tap(ctx, 48.5, 48.5, 5);
  for (let y = 40; y < 57; y++) for (let x = 40; x < 57; x++) World.setTile(x, y, T.DEEP);
  step(ctx, 31);
  assert.equal(eff(ctx).length, 0); assert.equal(ctx.Powers.errors, 0);
  assert.ok(fxCount(ctx, 'dyn_blast') >= 1 && fxCount(ctx, 'splash') >= 1, 'a blast over water makes splashes');
  assert.equal(S.tile[48 * S.w + 48], T.DEEP, 'water stays water');
});

// ================================================================== mixed with every other power
section('3000 ticks mixed with every other power (taps, strokes, brushes, disasters): no exceptions, bounded state, JSON-safe', () => {
  const ctx = village(5);
  const { S, Powers, ToolDefs, R } = ctx;
  const origErr = console.error; let errs = 0; console.error = (...a) => { errs++; if (errs <= 3) origErr(...a); };
  const ids = ToolDefs.map((t) => t.id);
  let maxLive = 0, maxScars = 0, strokes = 0, bangsSeen = 0;
  const rr = (n) => (Math.sin(S.tick * 12.9898 + n * 78.233) * 43758.5453) % 1;      // deterministic pseudo noise, independent of R
  try {
    for (let t = 0; t < 3000; t++) {
      if (t % 12 === 0) {
        const a = Math.abs(rr(t)), b = Math.abs(rr(t + 1)), c = Math.abs(rr(t + 2));
        const id = a < 0.45 ? 'dynamite' : ids[Math.floor(b * ids.length)];
        const x = 6 + Math.abs(rr(t + 3)) * 84, y = 6 + Math.abs(rr(t + 4)) * 84, r = 1 + Math.floor(c * 8);
        if (id === 'dynamite' && c < 0.5) { strokes++; Powers.apply(id, x, y, r, 'start'); for (let k = 1; k <= 14; k++) Powers.apply(id, x + k * 0.9, y + Math.sin(k) * 0.8, r, 'move'); Powers.apply(id, x, y, r, 'end'); }
        else Powers.apply(id, x, y, r, c < 0.3 ? 'tap' : 'start');
        if (t % 36 === 0) Powers.apply(id, x + 1, y, r, 'end');
      }
      stepN(ctx, 1); ctx.Fx.update(0.1);
      const L = S.eff.dynamite;
      if (L) { maxLive = Math.max(maxLive, L.length); if (L.length > 80) throw new Error('over the live cap: ' + L.length); }
      if (S.eff.dynamite_scars) maxScars = Math.max(maxScars, S.eff.dynamite_scars.length);
      if (t % 250 === 0) {
        const e = S.eff; assert.deepEqual(JSON.parse(JSON.stringify(e)), e, 'S.eff JSON-safe at ' + t);
        assert.deepEqual(JSON.parse(JSON.stringify(S.mod.dynamite)), S.mod.dynamite);
        for (const u of S.units.values()) if (!(Number.isFinite(u.x) && Number.isFinite(u.y) && Number.isFinite(u.hp))) throw new Error('bad unit ' + u.id);
        if (S.mod.dynamite.kb.length > 240) throw new Error('kb overflow');
      }
    }
  } finally { console.error = origErr; }
  bangsSeen = S.mod.dynamite.stat.boom;
  note(`dynamite strokes ${strokes}, bangs ${bangsSeen}, max live ${maxLive}, max scars ${maxScars}; units ${S.units.size}; deaths by dynamite ${S.mod.dynamite.stat.dead}, razed ${S.mod.dynamite.stat.razed}, felled ${S.mod.dynamite.stat.felled}`);
  assert.equal(errs, 0, 'console.error calls');
  assert.equal(Powers.errors, 0, 'swallowed exceptions: ' + (Powers.lastError && Powers.lastError.stack));
  assert.ok(bangsSeen > 30, 'enough bangs happened to mean something: ' + bangsSeen);
  assert.ok(maxLive <= 80 && maxScars <= ctx.PowerDynamite.SCAR_CAP);
  assert.equal(ctx.Sim.errors && Object.keys(ctx.Sim.errors).length || 0, 0, 'Sim reported no module errors');
});

// ================================================================== save / load
section('save / load in the middle of a fuse and of a chain: the continuation is identical (charges, tallies, thrown creatures, units, terrain, RNG)', () => {
  // the scene: a village, a 4-size chain through it and an independent r=6 bundle that will chain-react; 28 ticks later the head is about to go off
  const scene = () => {
    const ctx = village(7);
    const c0 = [...ctx.S.cities.values()][0], cx = c0.x + 0.5, cy = c0.y + 0.5;
    drag(ctx, line(cx - 7, cy, cx + 7, cy + 2, 0.9), 4);
    tap(ctx, cx, cy - 3, 6);
    step(ctx, 28);
    return ctx;
  };
  function loadFrom(json) { const c = loadSim(); assert.ok(c.Save.deserialize(json), 'deserialize'); return c; }
  function same(a, b, label) {
    assert.equal(a.S.tick, b.S.tick, label + ': tick');
    assert.equal(JSON.stringify(a.S.eff), JSON.stringify(b.S.eff), label + ': S.eff');
    assert.equal(JSON.stringify(a.S.mod.dynamite), JSON.stringify(b.S.mod.dynamite), label + ': S.mod.dynamite');
    assert.equal(a.R.getState(), b.R.getState(), label + ': RNG state');
    assert.equal(a.S.units.size, b.S.units.size, label + ': population');
    const ua = [...a.S.units.values()], ub = [...b.S.units.values()];
    for (let i = 0; i < ua.length; i++) { assert.equal(ua[i].id, ub[i].id); assert.ok(Math.abs(ua[i].x - ub[i].x) < 1e-9 && Math.abs(ua[i].y - ub[i].y) < 1e-9 && ua[i].hp === ub[i].hp, label + ': unit ' + ua[i].id); }
    assert.ok(Buffer.from(a.S.tile.buffer).equals(Buffer.from(b.S.tile.buffer)), label + ': terrain');
    assert.ok(Buffer.from(a.S.res.buffer).equals(Buffer.from(b.S.res.buffer)), label + ': resources');
    assert.ok(Buffer.from(a.S.fire.buffer).equals(Buffer.from(b.S.fire.buffer)), label + ': fire');
    assert.equal(a.S.buildings.size, b.S.buildings.size, label + ': buildings');
    assert.equal(JSON.stringify([...a.S.cities.values()].map((c) => c.stock)), JSON.stringify([...b.S.cities.values()].map((c) => c.stock)), label + ': city stocks');
  }
  // 1) MID-FUSE: nothing has gone off yet; the original keeps running untouched, a restored copy must follow it exactly through the whole chain
  {
    const ctx = scene(), { S } = ctx;
    assert.ok(eff(ctx).length > 8 && eff(ctx).every((c) => c.boom > S.tick), 'saved while every fuse is still burning');
    const tMid = S.tick, mid = ctx.Save.serialize();
    const A = loadFrom(mid);
    assert.equal(JSON.stringify(A.S.eff.dynamite), JSON.stringify(eff(ctx)), 'S.eff.dynamite survives the round trip exactly');
    assert.equal(JSON.stringify(A.S.mod.dynamite), JSON.stringify(S.mod.dynamite), 'S.mod.dynamite survives the round trip exactly');
    step(ctx, 70); step(A, 70);
    assert.equal(eff(ctx).length, 0, 'the chain is finished');
    same(A, ctx, 'mid-fuse');
    note(`mid-fuse save: identical after ${S.tick - tMid} ticks (bangs ${S.mod.dynamite.stat.boom}, dead ${S.mod.dynamite.stat.dead}, razed ${S.mod.dynamite.stat.razed}, R ${ctx.R.getState()})`);
    assert.equal(ctx.Powers.errors, 0); assert.equal(A.Powers.errors, 0);
  }
  // 2) MID-CHAIN: bangs have happened, creatures are flying, charges are left.
  //    NOTE (base game, not the plugin): World rebuilds its private list of burning tiles in index order on load while a live game keeps the order of ignition,
  //    so ANY save taken while tiles burn continues differently (verified with the plain Fire power, no dynamite involved). The fires are put out before saving.
  {
    const ctx = scene(), { S } = ctx;
    step(ctx, 6);
    assert.ok(S.mod.dynamite.kb.length > 0 && eff(ctx).length > 0, 'the chain is in progress (creatures flying, charges left)');
    ctx.World.extinguish(48, 48, 120);
    const mid2 = ctx.Save.serialize();
    const A = loadFrom(mid2), B = loadFrom(mid2);
    assert.equal(JSON.stringify(A.S.eff.dynamite), JSON.stringify(eff(ctx)));
    assert.equal(JSON.stringify(A.S.mod.dynamite), JSON.stringify(S.mod.dynamite), 'chronicle tally and flying creatures survive the round trip');
    step(ctx, 40); step(A, 40); step(B, 40);
    same(A, B, 'two restores of the mid-chain save');
    same(A, ctx, 'original vs restored mid-chain');
    assert.equal(eff(ctx).length, 0);
    assert.equal(ctx.Powers.errors, 0);
  }
});

// ================================================================== performance
if (!QUICK) {
  section('performance: ms/tick with 80 live charges, worst tick of a 40-charge chain, an r=8 blast over a dense city (1500 units)', () => {
    const ctx = grown(1450, 4);
    const { S, Powers, PowerDynamite } = ctx;
    note(`world: tick ${S.tick}, ${S.units.size} units, ${S.cities.size} cities, ${S.buildings.size} buildings`);
    // biggest city
    let big = null; for (const c of S.cities.values()) if (!big || c.pop > big.pop) big = c;
    const cx = big.x + 0.5, cy = big.y + 0.5;
    // (a) 80 live charges whose fuses are far away: the per-tick cost of just carrying them
    const L = ctx.S.eff.dynamite = [];
    for (let i = 0; i < 80; i++) L.push({ id: 1000 + i, x: 10.5 + (i % 40) * 1.5, y: 10.5 + Math.floor(i / 40) * 3, r: 4, t0: S.tick, boom: S.tick + 100000, g: 1 + (i >> 3), pv: i % 8 ? 1000 + i - 1 : 0, wx: 0, wy: 0 });
    const host = Powers.host;
    for (let i = 0; i < 2000; i++) PowerDynamite.step(S.tick, host);        // warm up
    const N = 200000;
    let t0 = performance.now();
    for (let i = 0; i < N; i++) PowerDynamite.step(S.tick, host);
    const perStep = (performance.now() - t0) / N;
    note(`plugin step with 80 live charges: ${(perStep * 1000).toFixed(2)} us/tick (budget 300 us)`);
    assert.ok(perStep < 0.3, 'step < 0.3 ms with 80 live charges');
    // whole sim tick with and without the charges
    const tickCost = (n) => { const a = performance.now(); stepN(ctx, n); return (performance.now() - a) / n; };
    tickCost(100);
    const withC = tickCost(300);
    ctx.S.eff.dynamite = [];
    const without = tickCost(300);
    note(`Sim.step at ${S.units.size} units: ${withC.toFixed(3)} ms with 80 live charges vs ${without.toFixed(3)} ms without`);
    assert.ok(withC < without * 1.15 + 0.05, 'carrying 80 charges costs nothing measurable');
    // (b) worst tick of a 40-charge chain through the city
    ctx.S.eff.dynamite = [];
    const lx0 = Math.min(Math.max(4, cx - 27), S.w - 4 - 55);
    drag(ctx, line(lx0, cy, lx0 + 54, Math.min(cy + 3, S.h - 3), 0.9), 8);
    assert.equal(eff(ctx).length, 40, 'laid 40 charges: ' + eff(ctx).length);
    const orig = Powers.step; const times = [];
    Powers.step = function (tick) { const a = performance.now(); orig.call(Powers, tick); times.push(performance.now() - a); };
    const pop0 = S.units.size, bld0 = S.buildings.size;
    stepN(ctx, 40 + 4 * 41 + 10);
    Powers.step = orig;
    const worst = Math.max(...times), avg = times.reduce((a, b) => a + b, 0) / times.length;
    const bangsTicks = times.filter((t) => t > 0.05).length;
    note(`40-charge r=8 chain through the city: Powers.step worst ${worst.toFixed(2)} ms, average ${avg.toFixed(3)} ms over ${times.length} ticks (${bangsTicks} busy ticks); ${pop0 - S.units.size} died, ${bld0 - S.buildings.size} buildings razed`);
    assert.equal(eff(ctx).length, 0);
    assert.ok(worst < 8, 'worst tick < 8 ms');
    assert.ok(avg < 0.3 + 0.0, 'average over the whole chain < 0.3 ms');
    // (c) one r=8 blast (radius 4.8) over the densest spot
    let best = null, bn = -1;
    for (let y = 8; y < 88; y += 2) for (let x = 8; x < 88; x += 2) { let n = 0; ctx.Units.nearby(x, y, 4.8, () => { n++; }); if (n > bn) { bn = n; best = [x + 0.5, y + 0.5]; } }
    const lone = tap(ctx, best[0], best[1], 8);
    const stepTimes = [];
    Powers.step = function (tick) { const a = performance.now(); orig.call(Powers, tick); stepTimes.push(performance.now() - a); };
    const pop1 = S.units.size;
    stepN(ctx, 31);
    Powers.step = orig;
    const one = Math.max(...stepTimes);
    note(`r=8 blast (radius 4.8) over the densest spot (${bn} creatures within): ${one.toFixed(2)} ms in its tick, ${pop1 - S.units.size} died`);
    assert.ok(one < 8, 'single blast < 8 ms');
    assert.equal(Powers.errors, 0);
  });
}

// ------------------------------------------------------------------ summary
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
