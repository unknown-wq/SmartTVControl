// God power «Ядерная бомба» (tool 'nuke', src/18_power_nuke.js + src/33_gfx_nuke.js)     node tests/power_nuke.test.mjs [--quick] [--nobrowser]
// Headless: registration, cooldown, timeline, damage by ring, buildings, terrain, cities / kingdoms / log, fallout, wave cost, save / load continuation,
// chaos run with every other power, memory, stubbed neighbours; gfx plugin against a fake DOM (icon, draw functions, caps, bake budget).
// Browser part (unless --nobrowser): the built game in Chromium, 390x844 @2x — tool button, one bomb through the real UI path, no page errors.
// The long screenshot / perf walkthrough lives in tests/power_nuke_visual.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadSim, stepN, newWorld, pad } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const QUICK = !!args.quick;
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 82)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 14).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

// ------------------------------------------------------------------ plumbing
function mkCtx(seed = 3, opts = {}) { const ctx = loadSim(opts); newWorld(ctx, seed, 96, 96); return ctx; }
/** advance n ticks AND let the Fx queue age (Sim does not touch Fx) */
function step(ctx, n) { for (let i = 0; i < n; i++) { stepN(ctx, 1); ctx.Fx.update(0.1); } }
function arena(ctx, cx, cy, half, tile) {
  const { World, S, Const, Tiles } = ctx;
  const t = tile === undefined ? Const.T.GRASS : tile;
  for (let y = Math.max(0, cy - half); y <= Math.min(S.h - 1, cy + half); y++) for (let x = Math.max(0, cx - half); x <= Math.min(S.w - 1, cx + half); x++) {
    if (S.bld[y * S.w + x]) ctx.Buildings.destroyAt(x, y, 'test');
    S.fire[y * S.w + x] = 0; S.res[y * S.w + x] = 0; S.amt[y * S.w + x] = 0;
    World.setTile(x, y, t, { elev: Tiles.midElev(t) });
  }
}
const CX = 48.5, CY = 48.5;
/** n adults spread area-uniformly over the distance band [fLo, fHi] * R around (CX, CY); returns [{id, f, x, y}] */
function ring(ctx, R, fLo, fHi, n, race) {
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 30) {
    const f = Math.sqrt(fLo * fLo + ctx.R.f() * (fHi * fHi - fLo * fLo)), a = ctx.R.f() * Math.PI * 2;
    const x = CX + Math.cos(a) * f * R, y = CY + Math.sin(a) * f * R;
    if (x < 0.6 || y < 0.6 || x > ctx.S.w - 0.6 || y > ctx.S.h - 0.6 || !ctx.World.walkable(x, y)) continue;
    const u = ctx.Units.spawn(race === undefined ? 0 : race, x, y, { age: 25 });             // humans: orcs and elves would fight each other and blur the statistics
    if (u) { u.hunger = 0; u.energy = 100; out.push({ id: u.id, f: Math.hypot(u.x - CX, u.y - CY) / R, x: u.x, y: u.y }); }
  }
  return out;
}
/** keep units where they were put (the wave reads positions; a tile of drift would blur the ring statistics) */
function pin(ctx, list) { for (const p of list) { const u = ctx.S.units.get(p.id); if (u) { u.x = u.px = p.x; u.y = u.py = p.y; } } }
function stepPinned(ctx, n, list) { for (let i = 0; i < n; i++) { stepN(ctx, 1); ctx.Fx.update(0.1); pin(ctx, list); } }
function mkCity(ctx, x, y, n = 3, race = 0, opts) {
  const us = [];
  for (let i = 0; i < n; i++) us.push(ctx.Units.spawn(race, x + 0.5 + (i - 1) * 0.6, y + 1.5, {}));
  const c = ctx.Cities.found(race, x, y, us, opts);
  assert.ok(c, 'city founded');
  return c;
}
function house(ctx, cityId, x, y) { return ctx.Buildings.place(cityId, ctx.Const.B.HOUSE, x, y, { instant: true }); }
const nukeLogs = (ctx) => ctx.S.log.filter(l => l.msg.indexOf('Ядерный удар') >= 0);
const checkEff = (ctx, label) => {
  const e = ctx.S.eff;
  assert.deepEqual(JSON.parse(JSON.stringify(e)), e, label + ': S.eff must survive a JSON round trip unchanged');
  for (const k of Object.keys(e)) assert.ok(Array.isArray(e[k]), label + ': S.eff.' + k + ' is an array');
  assert.ok(e.nukes.length <= 3 && e.mushrooms.length <= 6 && e.fallout.length <= 6, label + ': caps');
  for (const l of Object.values(e)) for (const r of l) for (const k in r) if (typeof r[k] === 'number') assert.ok(Number.isFinite(r[k]), label + ': finite ' + k);
};
const fingerprint = (c) => c.Save.serialize({ savedAt: 0 });
/** a populated, grown world with real cities / kingdoms (fast: the sim runs ~10k ticks a second) */
function grown(seed = 7, ticks = 6000) {
  const ctx = loadSim();
  ctx.Sim.newWorld({ seed, w: 96, h: 96, populate: true });
  stepN(ctx, ticks);
  return ctx;
}
const biggest = (ctx) => [...ctx.S.cities.values()].sort((a, b) => b.pop - a.pop)[0];

const PN = loadSim().PowerNuke;
const C0 = PN.consts, ringR = PN.ringR;
const END = C0.FALL_TICKS + C0.WAVE_TICKS - 1;                 // ticks after arming at which the last ring has just been resolved

console.log('nuke power tests');

// ================================================================== registration + arming + timeline
section('tool registration: group «Арсенал» after «Разрушение», icon, brush, no drag; idempotent', () => {
  const ctx = mkCtx();
  const { ToolDefs, PowerPlugins } = ctx;
  const d = ToolDefs.byId.nuke;
  assert.ok(d, 'nuke tool exists');
  assert.equal(d.tab, 'powers'); assert.equal(d.group, 'arsenal'); assert.equal(d.name, 'Ядерная бомба'); assert.equal(d.short, 'Ядерка');
  assert.equal(d.icon, 'nuke'); assert.equal(d.brush, true); assert.equal(d.drag, false);
  assert.ok(/[а-яё]/i.test(d.hint));
  assert.equal(ToolDefs.groupLabels.arsenal, 'Арсенал');
  const ids = ToolDefs.filter(t => t.tab === 'powers').map(t => t.id);
  const iN = ids.indexOf('nuke'), lastDestroy = Math.max(...ids.map((id, i) => ToolDefs.byId[id].group === 'destroy' ? i : -1)), firstBless = ids.findIndex(id => ToolDefs.byId[id].group === 'bless');
  assert.ok(iN > lastDestroy && iN < firstBless, 'between Разрушение и Благословение: ' + ids.join(','));
  const again = ToolDefs.add({ id: 'nuke', tab: 'powers', group: 'arsenal', name: 'x' });
  assert.equal(again, d); assert.equal(ToolDefs.filter(t => t.id === 'nuke').length, 1);
  assert.ok(PowerPlugins.some(p => p.name === 'nuke' && p.ids.includes('nuke')));
});

section('arming: tap = alarm record, cooldown 120 ticks («Бомба ещё не готова»), R = 5 + brush, bad input never throws', () => {
  const ctx = mkCtx();
  const { Powers, S } = ctx;
  arena(ctx, 48, 48, 10);
  assert.deepEqual(Object.keys(S.eff).slice(-3), ['nukes', 'mushrooms', 'fallout'], 'plugin arrays are created by newWorld, in a fixed order');
  assert.equal(Powers.apply('nuke', CX, CY, 3, 'tap'), true);
  assert.ok(/Тревога/.test(Powers.lastMessage), Powers.lastMessage);
  assert.equal(S.eff.nukes.length, 1);
  const b = S.eff.nukes[0];
  assert.equal(b.r, 8, 'brush 3 -> R 8'); assert.equal(b.eta - b.t0, C0.FALL_TICKS); assert.equal(b.w, 0); assert.deepEqual(b.hit, []);
  assert.equal(Powers.apply('nuke', 20.5, 20.5, 3, 'tap'), false);
  assert.equal(Powers.lastMessage, 'Бомба ещё не готова');
  assert.equal(S.eff.nukes.length, 1, 'a refused tap leaves no second bomb');
  step(ctx, C0.COOLDOWN - 1);
  assert.equal(Powers.apply('nuke', 20.5, 20.5, 1, 'tap'), false, 'still cooling down 1 tick early');
  step(ctx, 1);
  assert.equal(Powers.apply('nuke', 20.5, 20.5, 1, 'tap'), true, 'ready again after exactly COOLDOWN ticks');
  assert.equal(S.eff.nukes[S.eff.nukes.length - 1].r, 6, 'brush 1 -> R 6');
  step(ctx, C0.COOLDOWN);
  assert.equal(Powers.apply('nuke', 60.5, 60.5, 8, 'tap'), true);
  assert.equal(S.eff.nukes[S.eff.nukes.length - 1].r, 13, 'brush 8 -> R 13');
  step(ctx, C0.COOLDOWN);
  Powers.apply('nuke', 60.5, 60.5, 99, 'tap'); assert.equal(S.eff.nukes[S.eff.nukes.length - 1].r, 13, 'brush clamped to 8');
  step(ctx, C0.COOLDOWN);
  Powers.apply('nuke', 60.5, 60.5, NaN, 'tap'); assert.equal(S.eff.nukes[S.eff.nukes.length - 1].r, 5 + 2, 'default brush 2');
  step(ctx, C0.COOLDOWN);
  assert.equal(Powers.apply('nuke', 30.5, 30.5, 3, 'move'), false); assert.equal(Powers.lastMessage, '', 'a drag phase of a one-shot tool is silent');
  assert.equal(Powers.apply('nuke', 30.5, 30.5, 3, 'end'), false); assert.equal(Powers.lastMessage, '');
  const n0 = S.eff.nukes.length;
  for (const [x, y] of [[-3, 5], [5, -0.5], [S.w + 1, 4], [NaN, 4], [4, Infinity], [undefined, undefined], ['a', 'b']]) { assert.equal(Powers.apply('nuke', x, y, 3, 'tap'), false); assert.ok(Powers.lastMessage.length > 0); }
  assert.equal(S.eff.nukes.length, n0);
  assert.equal(Powers.apply('nuke', 0.2, 0.2, 8, 'tap'), true, 'the very corner is a legal target');
  step(ctx, 60);
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
  checkEff(ctx, 'arming');
});

section('timeline: quiet fall, ring by ring over 8 ticks, flash + shake, mushroom + fallout records, bomb record removed', () => {
  const ctx = mkCtx();
  const { Powers, S, Fx } = ctx;
  arena(ctx, 48, 48, 22);
  const us = ring(ctx, 13, 0, 0.9, 80);
  Powers.apply('nuke', CX, CY, 8, 'tap');
  const b = S.eff.nukes[0];
  assert.equal(b.eta, S.tick + C0.FALL_TICKS);
  while (S.tick < b.eta - 1) stepPinned(ctx, 1, us);
  assert.equal(S.units.size, us.length, 'nobody dies while the bomb falls');
  assert.equal(S.eff.mushrooms.length, 0); assert.equal(S.eff.fallout.length, 0);
  assert.equal(Fx.list.filter(f => f.type === 'flash').length, 0, 'no flash before the detonation');
  stepPinned(ctx, 1, us);                                  // tick eta: first ring
  assert.equal(S.tick, b.eta); assert.equal(b.w, 1, 'first ring resolved at the detonation tick');
  assert.equal(S.eff.mushrooms.length, 1); assert.equal(S.eff.fallout.length, 1);
  const flashes = Fx.list.filter(f => f.type === 'flash'), shakes = Fx.list.filter(f => f.type === 'shake');
  assert.ok(flashes.length >= 1 && flashes[0].a === 1 && Math.abs(flashes[0].ttl - 1.6) < 1e-9 && flashes[0].color === '#ffffff', 'white flash a=1 ttl=1.6');
  assert.ok(shakes.length === 1 && shakes[0].amp === 10 && Math.abs(shakes[0].ttl - 1.2) < 1e-9, 'shake amp 10 ttl 1.2');
  const m = S.eff.mushrooms[0], f = S.eff.fallout[0];
  assert.deepEqual([m.x, m.y, m.r, m.t0, m.until - m.t0], [CX, CY, 13, b.eta, C0.MUSH_LIFE]);
  assert.deepEqual([f.x, f.y, f.R, f.t0, f.until - f.t0], [CX, CY, 13, b.eta, C0.FALLOUT_LIFE]);
  assert.ok(Math.abs(f.r - 0.7 * 13) < 0.01, 'fallout radius 0.7 R');
  let prev = us.length - S.units.size;
  const dead = [prev];
  for (let k = 2; k <= C0.WAVE_TICKS; k++) { stepPinned(ctx, 1, us); const d = us.length - S.units.size; assert.ok(d >= prev, 'the death toll only grows'); prev = d; dead.push(d); }
  assert.equal(S.eff.nukes.length, 0, 'bomb record gone once the last ring was resolved');
  assert.ok(dead[0] > 0 && dead[0] < dead[dead.length - 1], 'the kills are spread over the rings: ' + dead.join(','));
  // a unit is killed exactly when the front passes it: nobody inside the front radius of ring k survives while k < 4 (lethal disc 0.45 R)
  for (const p of us) if (p.f < 0.4) assert.ok(!S.units.has(p.id), 'inner disc dead');
  assert.ok(Math.abs(ringR(13, C0.WAVE_TICKS) - 13) < 1e-9 && ringR(13, 0) === 0 && ringR(13, 4) > 6.5 && ringR(13, 4) < 13, 'front radius: 0 -> R, decelerating');
  checkEff(ctx, 'after the wave');
  assert.equal(Powers.errors, 0);
  note('toll per ring: ' + dead.join(' '));
});

// ================================================================== damage by ring
section('units by ring: all dead < 0.45 R, falling death chance 0.45..0.8 (survivors hurt + burning), 0.8..1.0 hurt, outside untouched', () => {
  const ctx = mkCtx(5);
  const { Powers, S } = ctx;
  arena(ctx, 48, 48, 24);
  const bands = [[0, 0.15], [0.15, 0.42], [0.48, 0.55], [0.55, 0.67], [0.67, 0.8], [0.8, 1.0], [1.08, 1.5]];      // (a little margin at the zone edges: units stir by a step or two while the bomb falls)
  const groups = bands.map(([a, b]) => ring(ctx, 13, a, b, 90));
  const all = [].concat(...groups);
  Powers.apply('nuke', CX, CY, 8, 'tap');
  stepPinned(ctx, END, all);
  const st = groups.map(g => {
    let dead = 0, hurt = 0, burn = 0;
    for (const p of g) { const u = S.units.get(p.id); if (!u) dead++; else { if (u.hp < u.maxHp - 1e-9) hurt++; if (u.burning > S.tick) burn++; } }
    return { n: g.length, dead, hurt, burn, alive: g.length - dead };
  });
  note(bands.map((b, i) => `${b[0]}-${b[1]}: dead ${st[i].dead}/${st[i].n} hurt ${st[i].hurt} burning ${st[i].burn}`).join(' | '));
  assert.equal(st[0].dead, st[0].n, 'ground zero'); assert.equal(st[1].dead, st[1].n, 'annihilation zone');
  const dr = st.map(s => s.dead / s.n);
  assert.ok(dr[2] >= 0.8, 'inner firestorm band mostly dead ' + dr[2]);
  assert.ok(dr[2] > dr[3] && dr[3] > dr[4], 'death chance falls off with distance: ' + dr.slice(2, 5).map(v => v.toFixed(2)).join(' > '));
  assert.ok(dr[4] > 0.05 && dr[4] < 0.6, 'outer firestorm band: some live ' + dr[4]);
  for (const i of [2, 3, 4]) { assert.equal(st[i].hurt, st[i].alive, 'every survivor of the firestorm is hurt (band ' + i + ')'); assert.ok(st[i].burn >= st[i].alive * 0.7, 'and burning (band ' + i + ')'); }
  assert.ok(dr[5] < 0.2, 'the heat flash band: only the unlucky die (damage + flames): ' + dr[5].toFixed(2)); assert.ok(st[5].hurt >= st[5].alive * 0.85, 'the rest is hurt');
  assert.ok(dr[6] <= 0.03, 'beyond R practically nobody dies: ' + dr[6].toFixed(2)); assert.ok(st[6].hurt <= st[6].n * 0.06, 'and nobody is hurt: ' + st[6].hurt);
  // the dead carry the nuke death cause (unit statistics)
  const causes = ctx.Units.totals().causes;
  assert.ok(causes['ядерный взрыв'] >= st[0].n + st[1].n, 'death cause is recorded: ' + JSON.stringify(causes));
});

section('buildings by ring: razed < 0.4 R, falling chance of survival beyond, heat damage up to R, intact outside', () => {
  const ctx = mkCtx(6);
  const { Powers, S, Buildings } = ctx;
  arena(ctx, 48, 48, 24);
  const far = mkCity(ctx, 25, 25, 4);
  const bands = [[0, 0.38], [0.52, 0.7], [0.84, 0.98], [1.12, 1.6]];
  const placed = bands.map(() => []);
  for (let y = 24; y < 73; y++) for (let x = 24; x < 73; x++) {
    const f = Math.hypot(x + 0.5 - CX, y + 0.5 - CY) / 13;
    const bi = bands.findIndex(([a, b]) => f >= a && f < b);
    if (bi < 0 || (x * 7 + y * 3) % 3 !== 0 || placed[bi].length >= 18) continue;
    const b = house(ctx, far.id, x, y);
    if (b) placed[bi].push(b.id);
  }
  placed.forEach((l, i) => assert.ok(l.length >= 8, 'placed enough buildings in band ' + i + ': ' + l.length));
  Powers.apply('nuke', CX, CY, 8, 'tap');
  step(ctx, END);
  const res = placed.map(l => { let gone = 0, hurt = 0, ok = 0; for (const id of l) { const b = Buildings.get(id); if (!b) gone++; else if (b.hp < b.maxHp - 1e-9) hurt++; else ok++; } return { n: l.length, gone, hurt, ok }; });
  note(bands.map((b, i) => `${b[0]}-${b[1]}: razed ${res[i].gone}/${res[i].n} damaged ${res[i].hurt} intact ${res[i].ok}`).join(' | '));
  assert.equal(res[0].gone, res[0].n, 'everything within 0.4 R is razed');
  assert.ok(res[1].gone >= 1 && res[1].gone < res[1].n && res[1].gone + res[1].hurt === res[1].n, 'middle band: part razed, the rest damaged');
  assert.ok(res[2].gone + res[2].hurt === res[2].n && res[2].hurt >= 1, 'heat flash band: damaged (or burnt down)');
  assert.equal(res[3].ok, res[3].n, 'outside R everything stands');
  assert.ok(S.fire.reduce((n, v) => n + (v ? 1 : 0), 0) > 20, 'the ring is burning');
  assert.equal(Powers.errors, 0);
});

section('terrain: lava core, glassed sand + hill rim, forests -> grass, water stays, lava next to water cools to rock, fires', () => {
  const ctx = mkCtx(8);
  const { Powers, S, World, Const } = ctx;
  const T = Const.T;
  arena(ctx, 48, 48, 24);
  for (let y = 24; y < 73; y++) for (let x = 24; x < 73; x++) if ((x + y) % 3 !== 0) World.setTile(x, y, T.FOREST);
  for (let y = 44; y < 53; y++) for (let x = 56; x < 64; x++) World.setTile(x, y, x > 60 ? T.DEEP : T.SHALLOW);       // a lake at the east (0.6 .. 1.2 R)
  World.setTile(50, 48, T.SHALLOW); World.setTile(50, 49, T.SHALLOW);                                                  // a pond right beside the crater
  const before = Uint8Array.from(S.tile);
  Powers.apply('nuke', CX, CY, 8, 'tap');
  step(ctx, END);
  const R = 13, f = (x, y) => Math.hypot(x + 0.5 - CX, y + 0.5 - CY) / R;
  const count = { lava: 0, lavaOutside: 0 }, sandHill = { bad: 0, n: 0 }, forestB = { n: 0 }, forestFar = { n: 0, kept: 0 }, water = { n: 0, changed: 0 };
  for (let y = 22; y < 75; y++) for (let x = 22; x < 75; x++) {
    const i = y * S.w + x, ff = f(x, y), t = S.tile[i], t0 = before[i];
    if (t0 === T.SHALLOW || t0 === T.DEEP) { if (ff <= 1) { water.n++; if (t !== t0) water.changed++; } continue; }
    if (ff < 0.12 && t === T.LAVA) count.lava++;
    if (ff > 0.17 && t === T.LAVA) count.lavaOutside++;
    if (ff > 0.17 && ff < 0.4) { sandHill.n++; if (t !== T.SAND && t !== T.HILL) sandHill.bad++; }
    if (ff > 0.5 && ff < 0.73 && t === T.FOREST) forestB.n++;
    if (ff > 1.15 && ff < 1.6 && t0 === T.FOREST) { forestFar.n++; if (t === T.FOREST) forestFar.kept++; }
  }
  const lavaCore = (() => { let n = 0, tot = 0; for (let y = 22; y < 75; y++) for (let x = 22; x < 75; x++) if (f(x, y) < 0.12 && before[y * S.w + x] !== T.SHALLOW) { tot++; if (S.tile[y * S.w + x] === T.LAVA) n++; } return { n, tot }; })();
  note(`lava core ${lavaCore.n}/${lavaCore.tot}, lava outside ${count.lavaOutside}, glass ring bad ${sandHill.bad}/${sandHill.n}, forest left in firestorm ${forestB.n}, far forest kept ${forestFar.kept}/${forestFar.n}, water changed ${water.changed}/${water.n}, fires ${World.fireCount()}`);
  assert.ok(lavaCore.tot >= 4 && lavaCore.n === lavaCore.tot, 'ground zero is lava');
  assert.equal(count.lavaOutside, 0, 'no lava outside the core');
  assert.equal(sandHill.bad, 0, 'the glassed ring is sand / hill rubble');
  assert.equal(forestB.n, 0, 'no forest survives in the firestorm band');
  assert.equal(forestFar.kept, forestFar.n, 'forests beyond 1.15 R are untouched');
  assert.equal(water.changed, 0, 'water stays water');
  assert.ok(World.fireCount() > 80, 'the firestorm and heat flash ignite the surroundings: ' + World.fireCount());
  // lava touching water cools to rock quickly (existing World rule)
  const lavaNextToPond = [[49, 48], [49, 49]].filter(([x, y]) => S.tile[y * S.w + x] === T.LAVA).length;
  assert.ok(lavaNextToPond >= 1, 'crater lava beside the pond');
  step(ctx, 250);
  const cooled = [[49, 48], [49, 49]].filter(([x, y]) => S.tile[y * S.w + x] === T.MOUNTAIN).length;
  assert.ok(cooled >= 1, 'lava beside water became rock');
  assert.equal(Powers.errors, 0);
});

// ================================================================== cities, kingdoms, log
section('city in the blast: one headline, city destroyed (Cities.destroy), kingdom falls when it was the last city, refugees are homeless', () => {
  const ctx = mkCtx(9);
  const { Powers, S, Cities, Kingdoms, Units } = ctx;
  arena(ctx, 48, 48, 24);
  const c = mkCity(ctx, 48, 48, 6);
  for (let i = 0; i < 30; i++) { const a = i * 2.4, d = 1 + (i % 7) * 0.8; const u = Units.spawn(0, 48.5 + Math.cos(a) * d, 48.5 + Math.sin(a) * d, { age: 25 }); if (u) Cities.addMember(c.id, u); }
  for (let i = 0; i < 16; i++) { const a = i * 2.1, d = 2 + (i % 5); house(ctx, c.id, Math.round(48 + Math.cos(a) * d), Math.round(48 + Math.sin(a) * d)); }
  const refugee = Units.spawn(0, 48.5 + 12, 48.5, { age: 25 }); Cities.addMember(c.id, refugee);          // member standing beyond the blast
  const name = c.name, pop0 = c.pop, kid = c.kingdomId;
  assert.ok(S.kingdoms.has(kid) && pop0 >= 30);
  Powers.apply('nuke', CX, CY, 3, 'tap');
  step(ctx, END);
  assert.ok(!S.cities.has(c.id), 'city destroyed');
  assert.ok(!S.kingdoms.has(kid), 'its kingdom (single city) fell');
  const logs = nukeLogs(ctx);
  assert.equal(logs.length, 1, 'ONE headline: ' + logs.map(l => l.msg).join(' || '));
  const m = /^Ядерный удар: «(.+)» уничтожен, погибло (\d+)$/.exec(logs[0].msg);
  assert.ok(m && m[1] === name, 'headline names the city: ' + logs[0].msg);
  assert.ok(+m[2] >= 20 && +m[2] <= pop0, 'death toll in the headline: ' + m[2] + ' of ' + pop0);
  assert.equal(logs[0].kind, 'disaster');
  const r = S.units.get(refugee.id);
  assert.ok(r && r.cityId === 0 && r.kingdomId === 0, 'the survivor beyond the blast is now homeless');
  for (const u of S.units.values()) assert.ok(!u.cityId || S.cities.has(u.cityId), 'no unit points at a dead city');
  for (const b of S.buildings.values()) assert.ok(S.cities.has(b.cityId), 'no orphan building');
  assert.equal(Powers.errors, 0);
});

section('capital bombed: succession / capital moves to the other city, only the bombed city gets a headline', () => {
  const ctx = mkCtx(10);
  const { Powers, S, Kingdoms, Units, Cities } = ctx;
  arena(ctx, 48, 48, 30);
  const a = mkCity(ctx, 48, 48, 6);
  const bb = mkCity(ctx, 48, 74, 6, 0, { parentCityId: a.id });
  assert.equal(a.kingdomId, bb.kingdomId, 'same kingdom');
  const k = S.kingdoms.get(a.kingdomId);
  for (let i = 0; i < 12; i++) { const u = Units.spawn(0, 48.5 + (i % 4) * 0.7, 49.5 + (i % 3) * 0.7, { age: 25 }); if (u) Cities.addMember(a.id, u); }
  assert.equal(k.capitalId, a.id);
  const popB = bb.pop;
  Powers.apply('nuke', CX, CY, 3, 'tap');
  step(ctx, END);
  assert.ok(!S.cities.has(a.id) && S.cities.has(bb.id), 'only the bombed city fell');
  assert.ok(S.kingdoms.has(k.id) && k.capitalId === bb.id && !k.cities.includes(a.id), 'capital moved');
  assert.equal(bb.pop, popB, 'the other city is untouched');
  const logs = nukeLogs(ctx);
  assert.equal(logs.length, 1, logs.map(l => l.msg).join(' || '));
  assert.ok(logs[0].msg.includes(a.name) && !logs[0].msg.includes(bb.name));
  assert.ok(S.log.some(l => /перенесена/.test(l.msg)), 'the kingdom reports the new capital');
  step(ctx, 300);                                                                // throne is refilled by the existing succession rules
  assert.ok(S.units.has(k.rulerId) || k.cities.length === 0, 'a new ruler took the throne');
  assert.equal(Powers.errors, 0);
});

section('city at the edge of the blast: survives, one «по» headline with the toll, nothing destroyed outside', () => {
  const ctx = mkCtx(11);
  const { Powers, S, Units, Cities } = ctx;
  arena(ctx, 48, 48, 30);
  const c = mkCity(ctx, 48, 55, 6);
  for (let i = 0; i < 24; i++) { const a = i * 2.4, d = 1 + (i % 6) * 0.9; const u = Units.spawn(0, 48.5 + Math.cos(a) * d, 55.5 + Math.sin(a) * d, { age: 25 }); if (u) Cities.addMember(c.id, u); }
  const hs = []; for (let i = 0; i < 14; i++) { const a = i * 2.3, d = 2 + (i % 5); const b = house(ctx, c.id, Math.round(48 + Math.cos(a) * d), Math.round(55 + Math.sin(a) * d)); if (b) hs.push(b.id); }
  const farHouse = house(ctx, c.id, 48, 63);
  Powers.apply('nuke', CX, 51.5, 3, 'tap');                                      // R = 8, centre 4 tiles north of the town hall: the hall is at 0.44 R .. hit
  step(ctx, END);
  const logs = nukeLogs(ctx);
  assert.ok(logs.length <= 1, logs.map(l => l.msg).join(' || '));
  if (S.cities.has(c.id)) {
    assert.ok(logs.length === 1 && /^Ядерный удар по «.+»: погибло \d+, разрушено построек: \d+/.test(logs[0].msg), logs.map(l => l.msg).join(' || '));
    assert.ok(S.buildings.has(farHouse.id), 'a house outside the blast stands');
  } else assert.ok(/уничтожен/.test(logs[0].msg));
  assert.equal(Powers.errors, 0);
});

// ================================================================== fallout
section('fallout: dose by distance, quick death at ground zero, no healing inside, heal cures (u.rad = 0), zone decays and ends', () => {
  const ctx = mkCtx(12);
  const { Powers, S, Units, Const } = ctx;
  arena(ctx, 48, 48, 24);
  Powers.apply('nuke', CX, CY, 8, 'tap');
  step(ctx, END);
  S.fire.fill(0);                                                              // the blast fires would burn the victims: this test is about radiation
  assert.equal(S.eff.fallout.length, 1);
  const z = S.eff.fallout[0], t0 = z.t0;
  // fresh victims after the blast, one per distance; one far outside
  const at = (d, race = 0) => { const u = Units.spawn(race, CX + d, CY, { age: 25 }); assert.ok(u, 'spawn at ' + d); u.hunger = 0; u.energy = 100; u.hp = u.maxHp; u.x = u.px = CX + d; u.y = u.py = CY; return u; };
  const near = at(2.4), mid = at(5), edge = at(8.5), out = at(12);          // (the lava core, radius ~2, is not walkable)
  const all = [near, mid, edge, out].map(u => ({ id: u.id, x: u.x, y: u.y }));
  const hp0 = new Map([near, mid, edge, out].map(u => [u.id, u.hp]));
  stepPinned(ctx, 12, all);
  for (const u of [near, mid, edge]) assert.ok(u.rad > S.tick, 'irradiated status until a later tick');
  assert.ok(!(out.rad > S.tick), 'outside the zone: not irradiated'); assert.equal(out.hp, hp0.get(out.id), 'and unhurt');
  const loss = (u) => hp0.get(u.id) - u.hp;
  stepPinned(ctx, 30, all);
  assert.ok(loss(near) > loss(mid) && loss(mid) > loss(edge) && loss(edge) > 0, 'damage scales with the dose: ' + [near, mid, edge].map(u => loss(u).toFixed(2)).join(' > '));
  // no healing: the edge unit sleeps (natural regeneration at its fastest); hp right after every radiation tick (tick % 10 == 0) must only fall,
  // while a sleeping control unit outside the zone does regenerate
  const ctl = at(12); ctl.hp = ctl.maxHp * 0.4; const ctlp = { id: ctl.id, x: ctl.x, y: ctl.y }; all.push(ctlp);
  for (const u of [edge, ctl]) { u.state = 'sleep'; u.st = { ph: 'sleep', since: S.tick }; u.energy = 0; }
  while (S.tick % 10 !== 0) stepPinned(ctx, 1, all);
  let last = edge.hp, rose = false, samples = 0;
  const ctl0 = ctl.hp;
  for (let k = 0; k < 14; k++) { stepPinned(ctx, 10, all); for (const u of [edge, ctl]) { u.energy = 0; if (u.state !== 'sleep') { u.state = 'sleep'; u.st = { ph: 'sleep', since: S.tick }; } } if (S.units.has(edge.id)) { samples++; if (edge.hp > last + 1e-9) rose = true; last = edge.hp; } }
  assert.ok(samples >= 10 && !rose, 'hp never rises while irradiated (' + samples + ' samples)');
  assert.ok(ctl.hp > ctl0 + 1, 'the same unit outside the zone does regenerate: ' + ctl0.toFixed(1) + ' -> ' + ctl.hp.toFixed(1));
  // ground zero kills quickly
  stepPinned(ctx, 150, all);
  assert.ok(!S.units.has(near.id), 'a strong dose is lethal within ~200 ticks');
  assert.ok(S.units.has(out.id), 'the unit outside is fine');
  // heal: antidote
  const victim = at(6); victim.hp = victim.maxHp * 0.5;
  const vp = [{ id: victim.id, x: victim.x, y: victim.y }];
  stepPinned(ctx, 12, vp);
  assert.ok(victim.rad > S.tick);
  assert.equal(Powers.apply('heal', victim.x, victim.y, 1, 'tap'), true);
  assert.equal(victim.rad, 0, 'heal clears the radiation status'); assert.equal(victim.hp, victim.maxHp);
  stepPinned(ctx, 11, vp);
  assert.ok(victim.rad > S.tick && victim.hp < victim.maxHp && victim.hp > victim.maxHp * 0.8, 'still inside the zone: irradiated again, but healed hp was not clamped back');
  // intensity decays and the zone ends
  const probe = (tick0) => { const u = at(7); const before = u.hp; const p = [{ id: u.id, x: u.x, y: u.y }]; stepPinned(ctx, 20, p); const d = before - (S.units.get(u.id) ? S.units.get(u.id).hp : 0); Units.kill(u, 'test'); return d; };
  const early = probe();
  step(ctx, 1000 - (S.tick - t0));
  const late = probe();
  assert.ok(late < early * 0.6 && late > 0, `dose decays with time: early ${early.toFixed(3)} -> late ${late.toFixed(3)}`);
  step(ctx, z.until - S.tick + 2);
  assert.equal(S.eff.fallout.length, 0, 'zone expired');
  const probeUnit = at(3), hpU = probeUnit.hp;
  stepPinned(ctx, 40, [{ id: probeUnit.id, x: probeUnit.x, y: probeUnit.y }]);
  assert.ok(!(probeUnit.rad > S.tick) && probeUnit.hp >= hpU - 1e-9, 'no radiation after the zone is gone');
  assert.equal(Powers.errors, 0);
});

section('fallout: vegetation thins slowly (a few forest tiles per 100 ticks), never runs wild', () => {
  const ctx = mkCtx(13);
  const { Powers, S, World, Const } = ctx;
  const T = Const.T;
  arena(ctx, 48, 48, 24);
  Powers.apply('nuke', CX, CY, 8, 'tap');
  step(ctx, END + 100);
  S.fire.fill(0);                                                              // the blast fires (and a wandering grass fire) would burn the new forest: isolate the fallout
  const z = S.eff.fallout[0];
  const inZone = []; for (let y = 30; y < 68; y++) for (let x = 30; x < 68; x++) { const d = Math.hypot(x + 0.5 - CX, y + 0.5 - CY); if (d < z.r - 0.5 && d > 4) inZone.push(y * S.w + x); }
  for (const i of inZone) World.setTile(i % S.w, (i / S.w) | 0, T.FOREST);
  const forests = () => inZone.reduce((n, i) => n + (S.tile[i] === T.FOREST ? 1 : 0), 0);
  const n0 = forests();
  step(ctx, 300);
  const n1 = forests();
  note(`forest tiles in the zone ${n0} -> ${n1} after 300 ticks`);
  assert.ok(n0 - n1 >= 3 && n0 - n1 <= 14, 'a handful of tiles per 100 ticks: ' + (n0 - n1));
  assert.equal(Powers.errors, 0);
});

// ================================================================== cost
section('wave cost: R = 13 over a dense city (1500 units), per tick of the wave < 2 ms on average', () => {
  const ctx = grown(7, 9000);
  const { S, Powers, Units } = ctx;
  const c = biggest(ctx);
  let guard = 0;
  while (S.units.size < 1500 && guard++ < 4000) { const a = ctx.R.f() * 6.283, d = Math.sqrt(ctx.R.f()) * 15; const u = Units.spawn(guard % 3, c.x + 0.5 + Math.cos(a) * d, c.y + 0.5 + Math.sin(a) * d, { age: 25 }); if (!u && S.units.size >= 1500) break; }
  const inBlast = [...S.units.values()].filter(u => Math.hypot(u.x - c.x - 0.5, u.y - c.y - 0.5) <= 13).length;
  const bldBlast = [...S.buildings.values()].filter(b => Math.hypot(b.x - c.x, b.y - c.y) <= 13).length;
  const ms = [], orig = Powers.step;
  Powers.step = (t) => { const t0 = performance.now(); orig(t); ms.push(performance.now() - t0); };
  ctx.Sim.refresh && ctx.Sim.refresh();
  Powers.apply('nuke', c.x + 0.5, c.y + 0.5, 8, 'tap');
  step(ctx, C0.FALL_TICKS - 1);
  const idle = ms.slice(); ms.length = 0;
  step(ctx, C0.WAVE_TICKS + 2);
  Powers.step = orig;
  const wave = ms.slice(0, C0.WAVE_TICKS), avg = wave.reduce((s, v) => s + v, 0) / wave.length, max = Math.max(...wave);
  note(`${S.units.size} units (${inBlast} in the blast), ${bldBlast} buildings in the blast; wave ticks ms: ${wave.map(v => v.toFixed(2)).join(' ')}  avg ${avg.toFixed(2)} max ${max.toFixed(2)}; fall ticks avg ${(idle.reduce((s, v) => s + v, 0) / idle.length).toFixed(4)}`);
  assert.ok(avg < 2, 'wave tick average < 2 ms: ' + avg.toFixed(2));
  assert.ok(max < 9, 'worst wave tick < 9 ms: ' + max.toFixed(2));
  assert.ok(Math.max(...idle) < 0.2, 'nothing but a counter runs while the bomb falls');
  // fallout bookkeeping stays cheap with the zone active
  const f = []; Powers.step = (t) => { const t0 = performance.now(); orig(t); f.push(performance.now() - t0); };
  step(ctx, 300); Powers.step = orig;
  const favg = f.reduce((s, v) => s + v, 0) / f.length;
  note(`fallout + cloud active, ${S.units.size} units: Powers.step avg ${favg.toFixed(4)} ms, max ${Math.max(...f).toFixed(3)} ms`);
  assert.ok(favg < 0.3, 'Powers.step < 0.3 ms on average with a fallout zone: ' + favg.toFixed(3));
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
});

// ================================================================== determinism / save / load
for (const [label, offset] of [['mid-fall', 12], ['mid-wave', C0.FALL_TICKS + 3], ['mid-fallout', C0.FALL_TICKS + C0.WAVE_TICKS + 140]]) {
  section(`save / load ${label}: the continuation is identical (world, rng, S.eff, S.mod)`, () => {
    const a = grown(7, 5000);
    const c = biggest(a);
    a.Powers.apply('nuke', c.x + 0.5, c.y + 0.5, 4, 'tap');
    step(a, offset);
    // A running world keeps units in spatial-grid cells and burning tiles in a list in history order; a loaded one rebuilds both in table order.
    // Fire damage kills several units on one tile in that order, which reorders city member lists (and then matchmaking dice), and fire spread rolls
    // dice in list order: a save taken while fires burn would diverge for those pre-existing reasons alone, with or without this plugin.
    // Running the load hooks on the live world (Sim.afterLoad) puts it in exactly the state a load produces, which isolates what this test is
    // about: the plugin's own state, effects and RNG use.
    a.Sim.afterLoad();
    const snap = fingerprint(a);
    const eff0 = JSON.stringify(a.S.eff);
    const b = loadSim();
    assert.ok(b.Save.deserialize(snap), 'deserialize');
    assert.equal(JSON.stringify(b.S.eff), eff0, 'S.eff survives the round trip');
    assert.equal(b.R.getState(), a.R.getState());
    step(a, 300); step(b, 300);
    assert.equal(b.R.getState(), a.R.getState(), 'rng in lock step');
    const fa = fingerprint(a), fb = fingerprint(b);
    if (fa !== fb) { let i = 0; while (i < fa.length && fa[i] === fb[i]) i++; assert.fail('worlds diverged at char ' + i + ': ' + fa.slice(Math.max(0, i - 80), i + 80) + '  <>  ' + fb.slice(Math.max(0, i - 80), i + 80)); }
    assert.equal(JSON.stringify(a.S.eff), JSON.stringify(b.S.eff));
    assert.equal(a.Powers.errors, 0); assert.equal(b.Powers.errors, 0);
    note(`${a.S.units.size} units, eff ${eff0.length} chars, ${nukeLogs(a).length} headline(s)`);
  });
}

// ================================================================== chaos, memory, stubs
section('chaos: 3000 ticks, a random god action every tick (all tools incl. nukes), no exceptions, sane state, effects drain', () => {
  const ctx = grown(5, 800);
  const { Powers, ToolDefs, S, Const } = ctx;
  let rs = 987654;
  const rnd = () => { rs = (Math.imul(rs, 1664525) + 1013904223) | 0; return (rs >>> 0) / 4294967296; };
  const ids = ToolDefs.map(t => t.id), phases = ['tap', 'start', 'move', 'end'];
  let x = 48, y = 48, nukes = 0;
  const nk = ids.indexOf('nuke');
  const TICKS = QUICK ? 1500 : 3000;
  for (let i = 0; i < TICKS; i++) {
    const id = rnd() < 0.08 ? 'nuke' : ids[(rnd() * ids.length) | 0];
    if (rnd() < 0.7) { x = Math.max(-3, Math.min(S.w + 3, x + (rnd() - 0.5) * 8)); y = Math.max(-3, Math.min(S.h + 3, y + (rnd() - 0.5) * 8)); } else { x = rnd() * S.w; y = rnd() * S.h; }
    if (Powers.apply(id, x, y, 1 + ((rnd() * 8) | 0), phases[(rnd() * 4) | 0]) && id === 'nuke') nukes++;
    step(ctx, 1);
    if (i % 500 === 0) checkEff(ctx, 'chaos ' + i);
  }
  checkEff(ctx, 'chaos end');
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
  assert.equal(ctx.Sim.totalErrors || 0, 0, 'no module threw: ' + JSON.stringify(ctx.Sim.errors));
  assert.ok(nukes >= 6, 'enough bombs were dropped: ' + nukes);
  for (const u of S.units.values()) assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y) && Number.isFinite(u.hp) && u.x >= 0 && u.y >= 0 && u.x < S.w && u.y < S.h, 'unit sane');
  for (let i = 0; i < S.tile.length; i++) assert.ok(S.tile[i] < Const.TILE_COUNT);
  // everything ends: no immortal records (the chaos stopped, so no new bomb comes)
  step(ctx, C0.FALLOUT_LIFE + C0.FALL_TICKS + 10);
  assert.equal(S.eff.nukes.length + S.eff.mushrooms.length + S.eff.fallout.length, 0, 'all records expired after the chaos');
  for (const u of S.units.values()) assert.ok(!(u.rad > S.tick + 40), 'no radiation status outlives the zones');
  note(`${nukes} bombs dropped, ${S.units.size} units, ${S.cities.size} cities left, S.eff ${JSON.stringify(Object.fromEntries(Object.entries(S.eff).map(([k, v]) => [k, v.length])))}`);
});

section('every record expires: nothing is immortal (bombs, clouds, fallout, unit status)', () => {
  const ctx = mkCtx(14);
  const { Powers, S } = ctx;
  arena(ctx, 48, 48, 24);
  const us = ring(ctx, 13, 0.5, 0.65, 30);
  Powers.apply('nuke', CX, CY, 8, 'tap');
  step(ctx, 40);
  assert.ok(S.eff.mushrooms.length === 1 && S.eff.fallout.length === 1);
  step(ctx, C0.MUSH_LIFE + 2);
  assert.equal(S.eff.mushrooms.length, 0, 'cloud gone after ' + C0.MUSH_LIFE + ' ticks'); assert.equal(S.eff.fallout.length, 1);
  step(ctx, C0.FALLOUT_LIFE - C0.MUSH_LIFE + 40);
  assert.equal(S.eff.fallout.length, 0); assert.equal(S.eff.nukes.length, 0);
  for (const u of S.units.values()) assert.ok(!(u.rad > S.tick + 40), 'no status outlives the zone');
});

section('memory: a dozen bombs do not grow the heap or the shared lists', () => {
  const ctx = grown(5, 600);
  const { Powers, S } = ctx;
  const bomb = (i) => { const a = i * 2.4; Powers.apply('nuke', 48 + Math.cos(a) * 20, 48 + Math.sin(a) * 20, 1 + (i % 8), 'tap'); step(ctx, C0.COOLDOWN + 1); };
  for (let i = 0; i < 3; i++) bomb(i);                                    // warm-up (JIT, caches)
  step(ctx, 300); gc(); gc();
  const h0 = process.memoryUsage().heapUsed;
  const n = QUICK ? 6 : 12;
  for (let i = 3; i < 3 + n; i++) bomb(i);
  step(ctx, 1700);
  gc(); gc();
  const h1 = process.memoryUsage().heapUsed;
  note(`heap ${(h0 / 1048576).toFixed(1)} -> ${(h1 / 1048576).toFixed(1)} MB after ${n} bombs; Fx.list ${ctx.Fx.list.length}, S.log ${S.log.length}, units ${S.units.size}`);
  assert.ok(h1 - h0 < 12 * 1048576, 'heap growth below 12 MB: ' + ((h1 - h0) / 1048576).toFixed(1));
  assert.ok(ctx.Fx.list.length <= 401 && S.log.length <= 300);
  assert.equal(S.eff.nukes.length + S.eff.mushrooms.length + S.eff.fallout.length, 0, 'all records expired');
  assert.equal(Powers.errors, 0);
});

section('robust against stubbed neighbours (Units / Cities / Buildings / Kingdoms / Diplomacy / War / Sim missing)', () => {
  const ctx = loadSim({ stub: ['Units', 'Cities', 'Buildings', 'Kingdoms', 'Diplomacy', 'War', 'Sim'] });
  newWorld(ctx, 3, 96, 96);
  const { Powers, S, World } = ctx;
  arena({ ...ctx, Buildings: { destroyAt() {} } }, 48, 48, 22, ctx.Const.T.FOREST);
  assert.equal(Powers.apply('nuke', 48.5, 48.5, 8, 'tap'), true);
  for (let i = 0; i < 2400; i++) { S.tick++; World.step(S.tick); Powers.step(S.tick); if (i === 700) Powers.apply('nuke', 30.5, 30.5, 2, 'tap'); }
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
  assert.ok(S.eff.mushrooms.length === 0 && S.eff.fallout.length === 0, 'records expired');
});

section('loading an old / damaged save: missing or malformed plugin lists are repaired', () => {
  const ctx = mkCtx(15);
  const { Powers, S } = ctx;
  arena(ctx, 48, 48, 20);
  Powers.apply('nuke', CX, CY, 3, 'tap');
  step(ctx, 10);
  S.eff.nukes.push({ x: NaN, y: 3, r: 8, t0: 0, eta: 9 }, { x: 5, y: 5 }, null, { x: 6, y: 6, r: 8, t0: S.tick, eta: S.tick + 5, hit: 'bad', w: -3, s: 'x' });
  S.eff.mushrooms.push({ x: 1, y: 1 }, { x: 2, y: 2, r: 8, t0: S.tick, until: S.tick + 20 });
  S.eff.fallout.push({ x: 3, y: 3, r: 5, t0: S.tick, until: S.tick + 40 });
  delete S.mod.nuke;
  Powers.afterLoad();
  assert.equal(S.eff.nukes.length, 2, 'only well-formed bombs survive'); assert.ok(Array.isArray(S.eff.nukes[1].hit) && S.eff.nukes[1].w === 0 && Number.isFinite(S.eff.nukes[1].s));
  assert.equal(S.eff.mushrooms.length, 1); assert.ok(S.eff.fallout.every(z => Number.isFinite(z.R)));
  assert.equal(S.mod.nuke.cd, 0);
  step(ctx, 60);
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
});

// ================================================================== graphics plugin against a fake DOM (no browser)
/** canvas with real pixel buffers for ImageData + a recording context: counts calls per method, flags non-finite numeric arguments */
const gfxStats = { calls: Object.create(null), bad: 0, badLog: [], canvases: 0 };
function gfxCtxFactory() {
  const makeCanvas = () => {
    gfxStats.canvases++;
    const c = { width: 0, height: 0, _img: null, style: {} };
    const target = {
      canvas: c, imageSmoothingEnabled: true, globalAlpha: 1, fillStyle: '#000',
      createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
      putImageData(id) { c._img = id; },
      getImageData() { return c._img; },
      drawImage(src, ...a) {                                    // nearest-neighbour pixel copy for the 9-argument form (Sprites.icon scales that way); counted + checked like every call
        gfxStats.calls.drawImage = (gfxStats.calls.drawImage || 0) + 1;
        for (let i = 0; i < a.length; i++) if (typeof a[i] === 'number' && !Number.isFinite(a[i])) { gfxStats.bad++; if (gfxStats.badLog.length < 6) gfxStats.badLog.push('drawImage(' + a.join(',') + ')'); }
        if (a.length === 8 && src && src._img) {
          if (!c._img) c._img = { width: c.width, height: c.height, data: new Uint8ClampedArray(c.width * c.height * 4) };
          const [sx, sy, sw, sh, dx, dy, dw, dh] = a, S0 = src._img, D = c._img;
          for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
            const X = dx + x, Y = dy + y; if (X < 0 || Y < 0 || X >= D.width || Y >= D.height) continue;
            const u = sx + Math.floor(x * sw / dw), v = sy + Math.floor(y * sh / dh), si = (v * S0.width + u) * 4, di = (Y * D.width + X) * 4;
            D.data[di] = S0.data[si]; D.data[di + 1] = S0.data[si + 1]; D.data[di + 2] = S0.data[si + 2]; D.data[di + 3] = S0.data[si + 3];
          }
        }
      },
    };
    const ctx = new Proxy(target, {
      get(t, k) {
        if (k in t) return t[k];
        return function () {
          gfxStats.calls[k] = (gfxStats.calls[k] || 0) + 1;
          for (let i = 0; i < arguments.length; i++) if (typeof arguments[i] === 'number' && !Number.isFinite(arguments[i])) { gfxStats.bad++; if (gfxStats.badLog.length < 6) gfxStats.badLog.push(String(k) + '(' + Array.prototype.join.call(arguments, ',') + ')'); }
        };
      },
      set(t, k, v) { t[k] = v; return true; },
    });
    c.getContext = () => ctx;
    return c;
  };
  return { createElement(tag) { assert.equal(tag, 'canvas'); return makeCanvas(); }, makeCanvas };
}
function loadGfx() {
  const doc = gfxCtxFactory();
  const code = ['00_core.js', '01_tiles.js', '02_data.js', '20_sprites.js', '33_gfx_nuke.js'].map(f => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
  const m = new Function('document', '"use strict";\n' + code + '\nreturn { Sprites, GfxPlugins, UIPlugins, GfxNuke, S, Fx, Const };')(doc);
  m.doc = doc;
  return m;
}

section('graphics plugin: icon, unit tint + badge, three effect layers in drawing order, margins cover the cloud', () => {
  const G = loadGfx();
  const { Sprites, GfxPlugins, UIPlugins, S } = G;
  assert.ok(Sprites.iconKeys().includes('nuke'), 'icon key known to the sprite sheet');
  const px = (c) => c._img.data;
  const opaque = (c) => { const d = px(c); let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++; return n; };
  for (const sz of [16, 24, 32, 48, 64]) { const c = Sprites.icon('nuke', sz); assert.equal(c.width, sz); assert.ok(opaque(c) > sz * sz * 0.2, 'icon not empty at ' + sz); }
  const fb = Sprites.icon('definitely_not_an_icon', 32), ic = Sprites.icon('nuke', 32);
  let diff = 0; const a = px(fb), b = px(ic); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert.ok(diff > 200, 'not the "?" fallback');
  assert.equal(Sprites.icon('nuke', 48), Sprites.icon('nuke', 48), 'icons are cached');
  assert.deepEqual(GfxPlugins.unitTints.filter(t => t.field === 'rad').map(t => t.color.indexOf('rgba') === 0), [true], 'one pale-green tint for u.rad');
  S.tick = 500;
  const badge = (u) => UIPlugins.unitBadges.map(f => f(u)).filter(Boolean);
  assert.deepEqual(badge({ rad: 501 }), [{ t: 'Облучён', cls: 'bad' }]);
  assert.deepEqual(badge({ rad: 500 }), []); assert.deepEqual(badge({}), []); assert.deepEqual(badge({ rad: 0 }), []);
  const keys = GfxPlugins.effects.map(d => d.key);
  assert.deepEqual(keys, ['fallout', 'nukes', 'mushrooms'], 'ground haze first, then the bomb, the cloud on top');
  for (const d of GfxPlugins.effects) assert.equal(typeof d.draw, 'function');
  const m = Object.fromEntries(GfxPlugins.effects.map(d => [d.key, d.margin]));
  assert.ok(m.fallout >= 14 && m.nukes >= 30 && m.mushrooms >= 30, 'culling margins (tiles) cover the largest blast: ' + JSON.stringify(m));
});

section('graphics plugin: every layer draws without throwing or NaN over zoom x radius x age (and leaves the context as it found it)', () => {
  const G = loadGfx();
  const { GfxPlugins, Sprites, S } = G, H = Sprites.fxHelpers;
  const eff = Object.fromEntries(GfxPlugins.effects.map(d => [d.key, d]));
  const cv = G.doc.makeCanvas(); cv.width = 780; cv.height = 1688;
  const ctx = cv.getContext('2d');
  gfxStats.bad = 0; gfxStats.badLog.length = 0;
  let draws = 0;
  for (const scale of [3, 6, 8, 12, 16, 28, 48, 96]) for (const R of [6, 7, 9, 11, 13]) {
    for (const k of [-1, 0, 3, 11, 24, 25.5]) {
      S.tick = 1000 + Math.floor(k); const alpha = k - Math.floor(k);
      for (const [px, py] of [[390, 840], [-200, 300], [900, 1800]]) {
        ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = true;
        eff.nukes.draw(ctx, { x: 30.5, y: 40.5, r: R, t0: 1000 - 12, eta: 1000 + 13, s: 7, w: 0, hit: [] }, px, py, scale, 123456 + k * 77, H, alpha);
        eff.nukes.draw(ctx, { x: 30.5, y: 40.5, r: R, t0: 1000, eta: 1000 + 25, s: 7, w: 3, hit: [] }, px, py, scale, 5, H, alpha);     // w > 0: nothing drawn
        draws += 2;
      }
    }
    for (const age of [-2, -0.5, 0, 1, 4, 7.5, 12, 20, 30, 45, 70, 100, 140, 170, 200, 219, 221, 260]) {
      S.tick = 5000 + Math.floor(age); const alpha = age - Math.floor(age);
      for (const [px, py] of [[390, 840], [-300, 100], [800, 2000]]) {
        ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = true;
        eff.mushrooms.draw(ctx, { x: 30.5, y: 40.5, r: R, t0: 5000, until: 5220 }, px, py, scale, 1e6 + age * 31, H, alpha);
        eff.fallout.draw(ctx, { x: 30.5, y: 40.5, r: R * 0.7, R, t0: 5000, until: 6500 }, px, py, scale, 3e5 + age * 13, H, alpha);
        draws += 2;
        assert.equal(ctx.globalAlpha, 1, 'alpha restored'); assert.equal(ctx.imageSmoothingEnabled, true, 'smoothing flag restored');
      }
    }
  }
  // fallout over its whole life, odd inputs
  for (const t of [0, 1, 10, 100, 700, 1499, 1500, 1600]) { S.tick = 5000 + t; eff.fallout.draw(ctx, { x: 10, y: 10, r: 6, R: 9, t0: 5000, until: 6500 }, 400, 800, 16, 99, H, 0.3); }
  eff.fallout.draw(ctx, { x: 10, y: 10, r: 6, t0: 5000, until: 6500 }, 400, 800, 16, 99, H, 0.3);               // record without R (old save)
  eff.mushrooms.draw(ctx, { x: 10, y: 10, t0: 5000, until: 5000 }, 400, 800, 16, 99, H, 0.3);                    // zero life / no radius
  eff.nukes.draw(ctx, { x: 10, y: 10, r: 0, t0: 5000, eta: 5000, w: 0, hit: [] }, 400, 800, 16, 99, H, 0.3);
  assert.equal(gfxStats.bad, 0, 'non-finite draw arguments: ' + gfxStats.badLog.join(' | '));
  note(`${draws} draw calls swept; ${gfxStats.canvases} canvases made; context calls: ${Object.entries(gfxStats.calls).map(([k, v]) => k + ' ' + v).join(', ')}`);
});

section('graphics plugin: draw-call budget per frame (cached sprites, no per-pixel loops), bake budget, bounded caches', () => {
  const G = loadGfx();
  const { GfxPlugins, Sprites, S, GfxNuke } = G, H = Sprites.fxHelpers;
  const eff = Object.fromEntries(GfxPlugins.effects.map(d => [d.key, d]));
  const cv = G.doc.makeCanvas(); cv.width = 780; cv.height = 1688;
  const ctx = cv.getContext('2d');
  const R = 13, cloud = { x: 30.5, y: 40.5, r: R, t0: 5000, until: 5220 }, zone = { x: 30.5, y: 40.5, r: 9.1, R, t0: 5000, until: 6500 };
  const calls = () => Object.values(gfxStats.calls).reduce((a, b) => a + b, 0);
  // warm up (the parts bake over a few frames)
  S.tick = 5070; for (let i = 0; i < 40; i++) { eff.mushrooms.draw(ctx, cloud, 390, 1000, 16, 1000 + i * 16, H, 0.5); eff.fallout.draw(ctx, zone, 390, 1000, 16, 1000 + i * 16, H, 0.5); }
  assert.equal(GfxNuke.stats().pending, 0, 'every part of the kit is baked after a few frames');
  const perFrame = (fn) => { const c0 = calls(); fn(); return calls() - c0; };
  const rows = [];
  for (const scale of [8, 16, 28, 48]) {
    S.tick = 5070;
    const steady = perFrame(() => { eff.mushrooms.draw(ctx, cloud, 390, 1000, scale, 777, H, 0.5); eff.fallout.draw(ctx, zone, 390, 1000, scale, 777, H, 0.5); });
    S.tick = 5004;
    const blast = perFrame(() => { eff.mushrooms.draw(ctx, cloud, 390, 1000, scale, 777, H, 0.5); eff.fallout.draw(ctx, zone, 390, 1000, scale, 777, H, 0.5); });
    S.tick = 1010;
    const alarm = perFrame(() => eff.nukes.draw(ctx, { x: 30.5, y: 40.5, r: R, t0: 1000, eta: 1025, s: 1, w: 0, hit: [] }, 390, 1000, scale, 777, H, 0.5));
    rows.push(`scale ${scale}: cloud + fallout ${steady} calls, first 22 ticks ${blast}, alarm ${alarm}`);
    assert.ok(steady <= 80, 'cloud + fallout stay a handful of calls per frame at scale ' + scale + ': ' + steady);
    assert.ok(blast <= 450, 'the 22-tick ring phase stays bounded: ' + blast);
    assert.ok(alarm <= 200, 'the alarm stays bounded: ' + alarm);
  }
  note(rows.join(' | '));
  // lazy bake: at most a few canvases per frame for a brand-new radius (no frame is stalled by baking a whole kit)
  const c0 = gfxStats.canvases;
  S.tick = 1002; eff.nukes.draw(ctx, { x: 30.5, y: 40.5, r: 9, t0: 1000, eta: 1025, s: 1, w: 0, hit: [] }, 390, 1000, 16, 5, H, 0.5);
  const first = gfxStats.canvases - c0;
  assert.ok(first <= 12, 'first frame of a new radius bakes only a few parts (shared ones included): ' + first);
  for (let i = 0; i < 30; i++) eff.nukes.draw(ctx, { x: 30.5, y: 40.5, r: 9, t0: 1000, eta: 1025, s: 1, w: 0, hit: [] }, 390, 1000, 16, 5 + i, H, 0.5);
  assert.equal(GfxNuke.stats().pending, 0, 'the kit finishes baking while the bomb falls (25 ticks)');
  // caches stay bounded however many radii come by
  for (let r = 3; r <= 20; r++) { S.tick = 5070; eff.mushrooms.draw(ctx, { x: 30.5, y: 40.5, r, t0: 5000, until: 5220 }, 390, 1000, 16, 5, H, 0.5); }
  const st = GfxNuke.stats();
  assert.ok(st.kits <= 9, 'at most 9 kits are kept: ' + st.kits);
  assert.ok(st.canvases < 400, 'canvas count bounded: ' + st.canvases);
});

// ================================================================== browser (390x844 @2x): the built game with the plugin, driven through the real UI
async function asection(name, fn) {
  const t0 = performance.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 82)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 10).join('\n       ')}`); }
}
if (!args.nobrowser) {
  const { launch } = await import('./browser.mjs');
  const { execFileSync } = await import('node:child_process');
  const shots = String(args.shots || '/tmp/godsim-nuke-shots');
  fs.mkdirSync(shots, { recursive: true });
  const out = '/tmp/godsim-nuke-test.html';
  execFileSync('node', [path.join(root, 'build.mjs'), '--out=' + out, '--extra=tests/fixtures/nuke_hook.js'], { cwd: root, stdio: 'pipe' });
  console.log('# browser: tool button, one bomb through the real UI path (tap, cooldown toast, alarm, flash, cloud, fallout, save / load), no page errors');
  const b = await launch({ file: out });
  const E = (fn, a) => b.eval(fn, a);
  const frame = () => b.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const centre = (sel) => E((s) => { const el = document.querySelector(s); if (!el) return null; el.scrollIntoView({ inline: 'center', block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; }, sel);
  const tapSel = async (sel) => { const c = await centre(sel); assert.ok(c, 'element ' + sel); await b.wait(120); const c2 = await centre(sel); await b.tap(c2.x, c2.y); return c2; };
  /** pixel statistics of a rectangle (css px) of the game canvas */
  const pixels = (x, y, w, h) => E(({ x, y, w, h }) => {
    const cv = document.getElementById('game'), d = cv.getContext('2d').getImageData(Math.round(x * 2), Math.round(y * 2), Math.round(w * 2), Math.round(h * 2)).data;
    let red = 0, orange = 0, green = 0, white = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { n++; const r = d[i], g = d[i + 1], bl = d[i + 2]; if (r > 190 && g < 110 && bl < 100) red++; if (r > 220 && g > 110 && g < 200 && bl < 90) orange++; if (g > 200 && r > 100 && r < 200 && bl < 120) green++; if (r > 240 && g > 205 && bl > 170) white++; }      // white = the (slightly warm) double flash
    return { red, orange, green, white, n };
  }, { x, y, w, h });
  try {
    await b.page.waitForFunction(() => window.__god && window.__gfxNuke && document.querySelector('.tab'), null, { timeout: 30000 });
    await b.wait(500);
    await asection('browser: «Ядерка» button with its icon in the Силы tab, group «Арсенал» between Разрушение and Благословение', async () => {
      await tapSel('.tab[data-tab="powers"]');
      await b.wait(300);
      const tool = await E(() => {
        const btn = document.querySelector('.tool[data-tool="nuke"]');
        if (!btn) return null;
        const cv = btn.querySelector('canvas'); let lit = 0;
        if (cv) { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++; }
        return { label: btn.textContent.trim(), lit, w: btn.getBoundingClientRect().width, groups: [...document.querySelectorAll('.grp-lbl')].map(x => x.textContent.trim()) };
      });
      assert.ok(tool, 'button exists');
      assert.equal(tool.label, 'Ядерка'); assert.ok(tool.lit > 250, 'icon drawn: ' + tool.lit); assert.ok(tool.w >= 48, 'touch target ' + tool.w);
      assert.ok(/^Разрушение\|Арсенал\|Благословение$/.test(tool.groups.join('|')), tool.groups.join('|'));
      await b.shot(shots + '/nuke_01_tool.png');
    });
    // a grown world, camera on its biggest city
    const city = await E(async () => {
      const g = window.__god;
      g.Main.newWorld({ seed: 4, w: 96, h: 96, populate: true }); g.setSpeed(0);
      let n = 0; while (n < 4500) { g.step(250); n += 250; await new Promise(r => setTimeout(r, 0)); }
      const c = [...g.S.cities.values()].sort((a, b) => b.pop - a.pop)[0];
      g.Render.setMode(0); g.Render.setCamera(c.x + 0.5, c.y + 0.5, 10);
      return { x: c.x, y: c.y, name: c.name, pop: c.pop };
    });
    await b.wait(400);
    let target = null, popBefore = 0;
    await asection('browser: tool + brush through the UI, a tap on the map arms the bomb («Тревога»), the cooldown refuses a second tap with a toast', async () => {
      await tapSel('.tab[data-tab="powers"]'); await b.wait(200);
      await tapSel('.tool[data-tool="nuke"]'); await b.wait(200);
      const st = await E(() => { window.__god.UI.setBrush(3); const g = window.__god; return { tool: g.UI.state.tool, brush: g.UI.state.brush, brushBox: !document.getElementById('brushbox').classList.contains('hide') }; });
      assert.equal(st.tool, 'nuke'); assert.equal(st.brush, 3); assert.ok(st.brushBox, 'the brush slider is shown for a brush tool');
      popBefore = await E(() => window.__god.S.units.size);
      target = await E(({ x, y }) => { const p = window.__god.Render.tileToScreen(x + 0.5, y + 0.5); return { sx: p.x, sy: p.y }; }, city);
      assert.ok(target.sy < 640 && target.sy > 100, 'target is on the visible map: ' + JSON.stringify(target));
      await b.tap(target.sx, target.sy);
      await frame();
      const armed = await E(() => { const g = window.__god; return { n: g.S.eff.nukes.length, b: g.S.eff.nukes[0] && { x: g.S.eff.nukes[0].x, y: g.S.eff.nukes[0].y, r: g.S.eff.nukes[0].r, eta: g.S.eff.nukes[0].eta, t0: g.S.eff.nukes[0].t0 }, msg: g.Powers.lastMessage }; });
      assert.equal(armed.n, 1, 'bomb armed: ' + JSON.stringify(armed)); assert.equal(armed.b.r, 8); assert.ok(Math.hypot(armed.b.x - city.x - 0.5, armed.b.y - city.y - 0.5) < 1.2, 'at the tap');
      assert.ok(/Тревога/.test(armed.msg), armed.msg);
      await b.tap(target.sx + 3, target.sy + 3);
      await b.wait(250);
      const toast = await E(() => [...document.querySelectorAll('.toast')].map(t => t.textContent));
      assert.ok(toast.includes('Бомба ещё не готова'), 'cooldown toast: ' + JSON.stringify(toast));
      assert.equal(await E(() => window.__god.S.eff.nukes.length), 1, 'no second bomb');
    });
    await asection('browser: the alarm is drawn (red hazard ring + disc + label + falling bomb), screenshot taken', async () => {
      await E(() => window.__god.step(12));
      await frame(); await b.wait(150);
      const ring = await pixels(target.sx - 160, target.sy - 160, 320, 320);
      assert.ok(ring.red > 300, 'hazard disc / rings are visible: ' + JSON.stringify(ring));
      await b.shot(shots + '/nuke_02_alarm.png');
      await E(() => window.__god.step(11));
      await frame();
      await b.shot(shots + '/nuke_03_bomb_close.png');
    });
    await asection('browser: detonation = full-screen white flash (Fx), the cloud + fallout records appear, ring phase draws', async () => {
      await E(() => { const g = window.__god; window.__fxUpdate = g.Fx.update; g.Fx.update = () => {}; });      // freeze the real-time Fx clock: deterministic flash pixels
      try {
        await E(() => window.__god.step(2));
        await frame();
        const fl = await pixels(2, 2, 12, 12);
        assert.ok(fl.white > fl.n * 0.5, 'the flash whitens the screen: ' + JSON.stringify(fl));
        const rec = await E(() => { const e = window.__god.S.eff; return { m: e.mushrooms.length, f: e.fallout.length, n: e.nukes.length, shake: window.__god.Fx.list.filter(x => x.type === 'shake').length, flash: window.__god.Fx.list.filter(x => x.type === 'flash').length }; });
        assert.equal(rec.m, 1); assert.equal(rec.f, 1); assert.equal(rec.shake, 1); assert.ok(rec.flash >= 1);
        await b.shot(shots + '/nuke_04_flash.png');
      } finally { await E(() => { const g = window.__god; g.Fx.update = window.__fxUpdate; g.Fx.clear(); }); }
      await E(() => window.__god.step(4));
      await frame(); await b.wait(150);
      await b.shot(shots + '/nuke_05_wave.png');
    });
    await asection('browser: the mushroom cloud rises (orange pixels above ground zero), then cools; the baked parts are all built', async () => {
      await E(() => window.__god.step(40));
      await frame(); await b.wait(300);
      const cloud = await pixels(target.sx - 130, target.sy - 330, 260, 260);
      assert.ok(cloud.orange > 800, 'cloud pixels: ' + JSON.stringify(cloud));
      await b.shot(shots + '/nuke_06_cloud.png');
      const st = await E(() => window.__gfxNuke.stats());
      assert.equal(st.pending, 0, 'every part is baked: ' + JSON.stringify(st));
      const pop = await E(() => window.__god.S.units.size);
      assert.ok(pop < popBefore - 20, 'the blast killed: ' + popBefore + ' -> ' + pop);
      const log = await E(() => window.__god.S.log.filter(l => l.msg.indexOf('Ядерный удар') >= 0).map(l => l.msg));
      assert.ok(log.length >= 1 && log.length <= 4, 'headline(s): ' + log.join(' | '));
      await E(() => window.__god.step(100));
      await frame(); await b.wait(200);
      await b.shot(shots + '/nuke_07_cloud_cooling.png');
    });
    await asection('browser: save / load in the middle of the cloud keeps the effects, no error; later the cloud ends and the fallout haze remains', async () => {
      const keep = await E(() => { const g = window.__god, d = g.Save.serialize(); g.Save.deserialize(d); g.Main.worldReplaced('load'); g.setSpeed(0); const e = g.S.eff; return { m: e.mushrooms.length, f: e.fallout.length }; });
      assert.equal(keep.m, 1); assert.equal(keep.f, 1);
      await frame(); await b.wait(300);
      await b.shot(shots + '/nuke_08_after_load.png');
      await E(() => window.__god.step(140));
      await frame(); await b.wait(300);
      const haze = await pixels(target.sx - 90, target.sy - 90, 180, 180);
      assert.ok(haze.green > 40, 'fallout haze / signs are drawn: ' + JSON.stringify(haze));
      const eff = await E(() => ({ m: window.__god.S.eff.mushrooms.length, f: window.__god.S.eff.fallout.length }));
      assert.equal(eff.m, 0, 'the cloud has ended'); assert.equal(eff.f, 1, 'the fallout lasts');
      await b.shot(shots + '/nuke_09_aftermath.png');
    });
    await asection('browser: no page errors, no console errors', async () => { assert.equal(b.errors.length, 0, b.errors.join(' | ').slice(0, 400)); });
  } finally { await b.close(); }
}

// ------------------------------------------------------------------ summary
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
if (failed.length) process.exit(1);
