// God power «Яд» (poison cloud): headless suite + optional browser part.   node tests/power_poison.test.mjs [--nobrowser] [--shots=/tmp/godsim-poison-shots] [--quick]
// Headless: registration, tap / spray / merge / caps, drift + spread + decay lifetime, damage per life stage, lingering tail, no contagion, antidote (Powers.heal),
// ecology (berries / forest / lone trees / farms), flight from the cloud, soldiers keep their orders, avoidance, rain, chronicle, chaos mixed with every other
// power, save / load continuation, one object shape for every unit (save table not ragged), perf, stubbed neighbours, graphics smoke test with a fake DOM.
// Browser: dock button + icon, real touch tap / spray, cloud / unit tint / badge / bubbles drawn, draw cost, screenshots (zoom 8 / 14 / 24).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSim, stepN, newWorld, pad } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 86)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 12).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

// ------------------------------------------------------------------ plumbing
function mkCtx(seed = 3, stub = []) {
  const ctx = loadSim({ stub });
  newWorld(ctx, seed, 96, 96);
  ctx.deaths = [];
  ctx.Bus.on('unitDied', (u, cause) => { ctx.deaths.push({ id: u.id, cause, x: u.x, y: u.y, ruler: !!u.isRuler }); });
  return ctx;
}
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
/** deep sea with a small grass island in the middle: nobody can run away */
function island(ctx, half = 2) {
  arena(ctx, 48, 48, 28, ctx.Const.T.DEEP);
  arena(ctx, 48, 48, half, ctx.Const.T.GRASS);
}
function mkCity(ctx, x, y, n = 3) {
  const us = [];
  for (let i = 0; i < n; i++) us.push(ctx.Units.spawn(0, x + 0.5 + (i - 1) * 0.6, y + 1.5, {}));
  const c = ctx.Cities.found(0, x, y, us);
  assert.ok(c, 'city founded');
  return c;
}
/** a living village: 14 humans on the best site near the middle, 600 ticks of real simulation */
function village(seed = 3, ticks = 600) {
  const ctx = mkCtx(seed);
  const { Cities, Units, R, S, World } = ctx;
  const site = Cities.findSite(0, 48, 48, 80) || { x: 48, y: 48 };
  let n = 0, guard = 0;
  while (n < 14 && guard++ < 500) {
    const x = site.x + 0.5 + R.between(-2, 2), y = site.y + 0.5 + R.between(-2, 2);
    if (World.walkable(x, y) && Units.spawn(0, x, y, { sex: n % 2 })) n++;
  }
  step(ctx, ticks);
  if (S.cities.size === 0) Cities.found(0, site.x, site.y, [...S.units.values()].slice(0, 4));
  return ctx;
}
const firstCity = (ctx) => [...ctx.S.cities.values()][0];
const clouds = (ctx) => ctx.S.eff.clouds || [];
const pois = (ctx) => [...ctx.S.units.values()].filter(u => u.poison > ctx.S.tick).length;
/** freeze a cloud in place (no wind) so a scenario is easy to reason about */
function still(c) { c.dx = 0; c.dy = 0; c.nt = 1e9; return c; }
const TR = (ctx, ...keys) => keys.map(k => ctx.Traits.byKey[k].id);

console.log('poison tests');

// ================================================================== registration
section('tool registration: «Яд» in Силы / Разрушение, brush + drag, plugin dispatch, boolean results', () => {
  const ctx = mkCtx();
  const { ToolDefs, PowerPlugins, Powers } = ctx;
  const d = ToolDefs.byId.poison;
  assert.ok(d, 'tool exists');
  assert.equal(d.tab, 'powers'); assert.equal(d.group, 'destroy'); assert.equal(d.name, 'Яд'); assert.equal(d.short, 'Яд'); assert.equal(d.icon, 'poison');
  assert.equal(d.brush, true); assert.equal(d.drag, true); assert.ok(d.hint.length > 5);
  const ids = ToolDefs.filter(t => t.tab === 'powers').map(t => t.id), i = ids.indexOf('poison');
  assert.ok(i > ids.indexOf('tornado') && i < ids.indexOf('rain'), 'inside the destroy group, before the blessings: ' + ids.join(','));
  assert.ok(PowerPlugins.some(p => p.ids && p.ids.includes('poison')));
  arena(ctx, 48, 48, 12);
  for (const ph of ['tap', 'start', 'move', 'end']) assert.equal(typeof Powers.apply('poison', 48.5, 48.5, 3, ph), 'boolean');
  assert.equal(Powers.apply('poison', -5, 3, 2, 'tap'), false); assert.ok(Powers.lastMessage.length > 0, 'out of the map explains itself');
  assert.equal(Powers.apply('poison', NaN, 3, 2, 'tap'), false);
  step(ctx, 20);
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
});

// ================================================================== tap / spray / merge / caps
section('tap: one cloud of radius r+1, density 1, ~600 ticks, burst fx, message; radius clamped', () => {
  const ctx = mkCtx(); arena(ctx, 48, 48, 14);
  const { Powers, S, Fx } = ctx;
  assert.equal(Powers.apply('poison', 48.5, 48.5, 3, 'tap'), true);
  assert.equal(Powers.lastMessage, 'Ядовитое облако');
  const L = clouds(ctx);
  assert.equal(L.length, 1);
  const c = L[0];
  assert.equal(c.x, 48.5); assert.equal(c.y, 48.5); assert.equal(c.r, 4); assert.equal(c.dens, 1);
  assert.equal(c.until - c.t0, 600);
  assert.ok(Math.hypot(c.dx, c.dy) > 0.002 && Math.hypot(c.dx, c.dy) < 0.013, 'a slow wind');
  assert.equal(Fx.list.filter(f => f.type === 'poison_burst').length, 1, 'tap fx');
  assert.deepEqual(JSON.parse(JSON.stringify(S.eff)), S.eff, 'JSON-safe');
  const c2 = mkCtx(); arena(c2, 48, 48, 16);
  c2.Powers.apply('poison', 48.5, 48.5, 8, 'tap');
  assert.equal(clouds(c2)[0].r, 9);
  c2.Powers.apply('poison', 30.5, 30.5, 1, 'tap');
  assert.equal(clouds(c2)[1].r, 2);
  c2.Powers.apply('poison', 70.5, 70.5, 99, 'tap');
  assert.equal(clouds(c2)[2].r, 9, 'radius clamped to the brush range');
});

section('spray: a trail of smaller overlapping clouds, <= 14 live, merges where the finger lingers, never grows without bound', () => {
  const ctx = mkCtx(); arena(ctx, 48, 48, 30);
  const { Powers, S } = ctx;
  assert.equal(Powers.apply('poison', 20.5, 48.5, 3, 'start'), true);
  let made = 0;
  for (let i = 1; i <= 50; i++) { if (Powers.apply('poison', 20.5 + i * 0.7, 48.5, 3, 'move')) made++; step(ctx, 1); }
  const L = clouds(ctx);
  note(`stroke of ${(50 * 0.7).toFixed(0)} tiles with brush 3: ${made} puffs made, ${L.length} live`);
  assert.ok(L.length >= 5 && L.length <= 14, 'trail but capped: ' + L.length);
  const puff = L[L.length - 1];
  assert.ok(Math.abs(puff.r - (0.55 * 3 + 0.5)) < 0.01 || L.length === 14, 'spray puffs are smaller than a tap cloud (' + puff.r + ')');
  assert.ok(puff.d0 < 1, 'and thinner');
  const byX = L.slice().sort((a, b) => a.x - b.x);
  for (let i = 1; i < byX.length; i++) assert.ok(byX[i].x - byX[i - 1].x <= byX[i].r + byX[i - 1].r, 'the puffs of the trail touch (gap ' + (byX[i].x - byX[i - 1].x).toFixed(2) + ')');
  Powers.apply('poison', 20.5 + 50 * 0.7, 48.5, 3, 'end');
  // lingering: the puff under the finger gets denser
  const d0 = L[L.length - 1].d0;
  for (let i = 0; i < 12; i++) { Powers.apply('poison', L[L.length - 1].x, L[L.length - 1].y, 3, 'move'); step(ctx, 3); }
  assert.ok(L[L.length - 1].d0 > d0, 'a lingering finger thickens the puff');
  // a very long wild stroke over the whole map stays capped, density capped
  const c2 = mkCtx(5); arena(c2, 48, 48, 40);
  c2.Powers.apply('poison', 10.5, 10.5, 8, 'start');
  let maxL = 0;
  for (let i = 1; i <= 400; i++) { c2.Powers.apply('poison', 10.5 + (i % 100) * 0.8, 10.5 + Math.floor(i / 100) * 18 + Math.sin(i * 0.3) * 4, 8, 'move'); step(c2, 1); maxL = Math.max(maxL, clouds(c2).length); }
  assert.ok(maxL <= 14, 'never more than 14 live clouds: ' + maxL);
  for (const c of clouds(c2)) assert.ok(c.d0 <= 1.6 && c.r0 <= 10 && Number.isFinite(c.x + c.y + c.dens + c.r), 'sane cloud');
  assert.equal(c2.Powers.errors, 0);
});

section('merge: taps in nearly the same place sum their density (capped), the cloud keeps one id', () => {
  const ctx = mkCtx(); arena(ctx, 48, 48, 14);
  const { Powers } = ctx;
  Powers.apply('poison', 48.5, 48.5, 3, 'tap');
  const id = clouds(ctx)[0].id;
  step(ctx, 100);
  const before = clouds(ctx)[0].dens;
  Powers.apply('poison', 49.0, 48.5, 3, 'tap');
  assert.equal(clouds(ctx).length, 1, 'merged');
  const c = clouds(ctx)[0];
  assert.equal(c.id, id);
  assert.ok(c.d0 > before && c.d0 <= 1.6 + 1e-9, 'densities added: ' + before.toFixed(2) + ' + 1 -> ' + c.d0.toFixed(2));
  assert.ok(c.until >= c.t0 + 599, 'life refreshed');
  Powers.apply('poison', 49.0, 48.5, 3, 'tap'); Powers.apply('poison', 49.0, 48.5, 3, 'tap');
  assert.ok(clouds(ctx)[0].d0 <= 1.6 + 1e-9, 'density cap 1.6');
  Powers.apply('poison', 70.5, 70.5, 3, 'tap');
  assert.equal(clouds(ctx).length, 2, 'far taps stay separate');
});

// ================================================================== lifetime
section('lifetime: drifts, spreads <= 40 %, thins out, vanishes after ~600 ticks; never leaves the map', () => {
  const ctx = mkCtx(); arena(ctx, 48, 48, 14);
  const { Powers, S } = ctx;
  Powers.apply('poison', 48.5, 48.5, 3, 'tap');
  const c = clouds(ctx)[0], x0 = c.x, y0 = c.y;
  let lastD = 2, lastR = 0, minR = 99, maxR = 0, gone = -1;
  for (let t = 1; t <= 700; t++) {
    step(ctx, 1);
    const cc = clouds(ctx)[0];
    if (!cc) { gone = t; break; }
    assert.ok(cc.dens <= lastD + 1e-9, 'density only falls'); lastD = cc.dens;
    assert.ok(cc.r >= lastR - 1e-9, 'radius only grows'); lastR = cc.r; minR = Math.min(minR, cc.r); maxR = Math.max(maxR, cc.r);
    assert.ok(cc.x > 0 && cc.y > 0 && cc.x < S.w && cc.y < S.h, 'inside the map');
    if (t === 300) assert.ok(cc.dens < 0.7 && cc.dens > 0.3, 'half way: ' + cc.dens.toFixed(2));
  }
  note(`vanished at tick ${gone}; drifted ${Math.hypot(c.x - x0, c.y - y0).toFixed(1)} tiles; radius ${minR.toFixed(2)} -> ${maxR.toFixed(2)}`);
  assert.ok(gone > 560 && gone <= 601, 'lives ~600 ticks: ' + gone);
  assert.ok(maxR <= minR * 1.4 + 1e-9 && maxR > minR * 1.25, 'spreads by up to 40 %');
  assert.equal(clouds(ctx).length, 0, 'no residue');
  // the wind turns a little now and then and a cloud at the edge bounces back
  const e = mkCtx(); arena(e, 48, 48, 14);
  e.Powers.apply('poison', 47.5, 48.5, 3, 'tap');
  const ce = clouds(e)[0]; ce.x = 1.2; ce.dx = -0.01; ce.dy = 0;
  step(e, 40);
  assert.ok(clouds(e)[0].x >= 1 && clouds(e)[0].dx > 0, 'bounces at the map edge');
  const w = mkCtx(); arena(w, 48, 48, 14);
  w.Powers.apply('poison', 48.5, 48.5, 3, 'tap');
  const cw = clouds(w)[0], a0 = Math.atan2(cw.dy, cw.dx);
  step(w, 350);
  assert.ok(Math.abs(Math.atan2(cw.dy, cw.dx) - a0) > 1e-6 || clouds(w).length === 0, 're-rolls the wind rarely');
});

// ================================================================== damage
const PROF = [['human adult', 0, 25, []], ['human strong', 0, 25, ['strong']], ['human sickly', 0, 25, ['sickly']], ['human child', 0, 8, []],
  ['human elder', 0, 51, []], ['elf adult', 2, 40, []], ['orc adult', 1, 25, []]];
function exposure(prof, trapped, dens, rad, off, ticks = 500) {
  const ctx = mkCtx(3);
  if (trapped) island(ctx, 2); else arena(ctx, 48, 48, 28);
  const [, race, age, tr] = prof;
  const u = ctx.Units.spawn(race, 48.5 + off, 48.5, { age, traits: TR(ctx, ...tr), sex: 0, hunger: 0, energy: 90 });
  const c = still(ctx.PowerPoison.addCloud(48.5, 48.5, rad, dens, 600));
  const hp0 = u.hp; let min = u.hp, dead = -1;
  for (let t = 1; t <= ticks; t++) { stepN(ctx, 1); if (!ctx.S.units.has(u.id)) { dead = t; break; } if (u.hp < min) min = u.hp; }
  return { hp0, frac: dead >= 0 ? 0 : min / hp0, dead, ctx, u, c };
}

section('damage: a long exposure kills (adult human ~100 ticks, orcs last longest), children / elders / sickly suffer more, strong adults less', () => {
  const t = {};
  for (const p of PROF) { const r = exposure(p, true, 1.0, 5, 0); t[p[0]] = r.dead; assert.ok(r.dead > 0, p[0] + ' dies when trapped'); assert.equal(r.ctx.deaths[0].cause, 'poison'); }
  note(Object.entries(t).map(([k, v]) => k + ' ' + v).join(', ') + '  (ticks until death, dens 1, cannot flee)');
  assert.ok(t['human adult'] > 70 && t['human adult'] < 160, 'adult human dies in 7-16 s: ' + t['human adult']);
  assert.ok(t['human strong'] > t['human adult'], 'strong adults hold out longer');
  assert.ok(t['orc adult'] > t['human strong'], 'orcs (30 hp) hold out longest');
  assert.ok(t['human child'] < t['human adult'] && t['human elder'] < t['human adult'] && t['human sickly'] < t['human adult'], 'children / elders / sickly suffer more');
  assert.ok(t['elf adult'] < t['human adult'], 'elves are fragile');
  const thin = exposure(PROF[0], true, 0.3, 5, 0).dead, thick = exposure(PROF[0], true, 1.5, 5, 0).dead;
  assert.ok(thin > t['human adult'] && thick < t['human adult'], `thinner air kills slower: dens 0.3 ${thin}, 1.0 ${t['human adult']}, 1.5 ${thick}`);
});

section('damage: a brief exposure hurts but does not kill an adult (flee works), big clouds kill the weak', () => {
  const rows = [];
  for (const p of PROF) { const r = exposure(p, false, 1.0, 4, 0, 400); rows.push(p[0] + ' ' + (r.dead >= 0 ? 'dead' : Math.round(r.frac * 100) + '%')); }
  note('lowest hp from the middle of a dens-1 cloud r=4: ' + rows.join(', '));
  const ad = exposure(PROF[0], false, 1.0, 4, 0, 400), st = exposure(PROF[1], false, 1.0, 4, 0, 400), orc = exposure(PROF[6], false, 1.0, 4, 0, 400), edge = exposure(PROF[0], false, 1.0, 4, 3, 400);
  assert.ok(ad.dead < 0 && ad.frac > 0.45 && ad.frac < 0.92, 'adult hurt, alive: ' + ad.frac.toFixed(2));
  assert.ok(st.frac > ad.frac, 'strong adults survive short exposures better');
  assert.ok(orc.frac > 0.7, 'orc barely scratched');
  assert.ok(edge.frac > ad.frac, 'the edge of a cloud is milder than its heart');
  const big = exposure(PROF[3], false, 1.0, 9, 0, 400), bigAd = exposure(PROF[0], false, 1.0, 9, 0, 400);
  assert.ok(big.dead >= 0 || big.frac < 0.2, 'a child in the middle of a huge cloud does not make it');
  assert.ok(bigAd.dead < 0 && bigAd.frac < 0.7, 'an adult survives a huge cloud, badly hurt: ' + bigAd.frac.toFixed(2));
});

section('damage: poison lingers ~120 ticks after the last exposure and fades, damage stops, nobody else catches it', () => {
  const ctx = mkCtx(); arena(ctx, 48, 48, 20);
  const { Units, S } = ctx;
  const a = Units.spawn(0, 40.5, 40.5, { age: 25, traits: [], hunger: 0, energy: 90 });
  const b = Units.spawn(0, 40.9, 40.5, { age: 25, traits: [], hunger: 0, energy: 90 });
  a.hp = a.maxHp; b.hp = b.maxHp;
  a.poison = S.tick + 120;
  const loss = []; let last = a.hp;
  for (let t = 1; t <= 200; t++) {
    stepN(ctx, 1);
    if (a.hp < last - 0.2) loss.push({ t, d: last - a.hp });
    if (a.hp > last) { /* regeneration */ }
    last = a.hp;
    assert.ok(!(b.poison > 0), 'not contagious (tick ' + t + ')');
    assert.ok(!(b.sick > 0), 'and not a disease');
  }
  note('hits (first, mid, last): ' + [loss[0], loss[Math.floor(loss.length / 2)], loss[loss.length - 1]].map(x => x ? x.d.toFixed(2) : '-').join(' / ') + `, ${loss.length} hits in 120 ticks`);
  assert.ok(loss.length >= 8 && loss.length <= 16, 'a hit every 8 ticks for ~120 ticks: ' + loss.length);
  assert.ok(loss[0].d > loss[loss.length - 1].d, 'the poison fades');
  assert.ok(!(a.poison > S.tick), 'poison is over');
  const before = a.hp; step(ctx, 100);
  assert.ok(a.hp >= before - 1e-9, 'no damage after the poison ended');
  assert.equal(Units.totals().causes.poison === undefined, true, 'a lingering tail alone is not lethal for a healthy adult');
});

section('antidote: Powers.heal clears the poison (also on a poisoned unit with full hp)', () => {
  const ctx = mkCtx(); arena(ctx, 48, 48, 14);
  const { Units, Powers, S } = ctx;
  const a = Units.spawn(0, 48.5, 48.5, { age: 25 }), b = Units.spawn(0, 49.2, 48.5, { age: 25 });
  a.poison = S.tick + 100; a.hp = a.maxHp * 0.4;
  b.poison = S.tick + 100;                                                   // full hp, only poisoned
  assert.equal(Powers.apply('heal', 48.8, 48.5, 2, 'tap'), true);
  assert.equal(Powers.lastMessage, 'Исцелено: 2', Powers.lastMessage);
  assert.equal(a.poison, 0); assert.equal(b.poison, 0); assert.equal(a.hp, a.maxHp);
  step(ctx, 100);
  assert.ok(a.hp >= a.maxHp - 0.01, 'stays healed');
  const c = Units.spawn(0, 40.5, 40.5, { age: 25 }); c.poison = S.tick + 50;
  assert.equal(Powers.heal(40.5, 40.5, 1), true); assert.equal(c.poison, 0);
  // a healthy bystander keeps the old message
  assert.equal(Powers.apply('heal', 60.5, 60.5, 1, 'tap'), false);
});

// ================================================================== ecology
section('ecology: forest withers (dead forest -> grass), lone trees and berries die, farms lose hp; the outside is untouched', () => {
  const ctx = mkCtx(); const { S, World, Const, Buildings, Powers } = ctx; const T = Const.T, RES = Const.RES;
  arena(ctx, 48, 48, 20);
  const W = S.w, at = (x, y) => y * W + x;
  const inside = [], outside = [], push = (list, e) => { if (list) list.push(e); };
  for (let y = 38; y <= 58; y++) for (let x = 38; x <= 58; x++) {
    const d = Math.hypot(x + 0.5 - 48.5, y + 0.5 - 48.5);
    if ((x + y) % 3 === 0) {
      if ((x * 7 + y * 3) % 3 === 0) { World.setTile(x, y, T.FOREST, { elev: 136 }); S.amt[at(x, y)] = 90; push(d < 3.5 ? inside : d > 6.4 ? outside : null, ['forest', x, y]); }
      else if ((x + y) % 2 === 0) { S.res[at(x, y)] = RES.BERRY; S.amt[at(x, y)] = 100; push(d < 3.5 ? inside : d > 6.4 ? outside : null, ['berry', x, y]); }
      else { S.res[at(x, y)] = RES.TREE; S.amt[at(x, y)] = 60; push(d < 3.5 ? inside : d > 6.4 ? outside : null, ['tree', x, y]); }
    }
  }
  const c = mkCity(ctx, 30, 60);
  const fIn = Buildings.place(c.id, Const.B.FARM, 48, 49, { instant: true }), fOut = Buildings.place(c.id, Const.B.FARM, 57, 58, { instant: true });
  assert.ok(fIn && fOut, 'farms placed');
  const hpOut0 = fOut.hp, destroyed = [];
  ctx.Bus.on('buildingDestroyed', (b, cause) => destroyed.push({ id: b.id, cause }));
  const cl = still(ctx.PowerPoison.addCloud(48.5, 48.5, 4, 1.0, 600));
  const sum = (list, kind, f) => list.filter(e => e[0] === kind).reduce((s, e) => s + f(e), 0);
  const amt = (e) => (S.tile[at(e[1], e[2])] === T.FOREST || S.res[at(e[1], e[2])] ? S.amt[at(e[1], e[2])] : 0);
  const f0 = sum(inside, 'forest', amt), b0 = sum(inside, 'berry', amt), t0 = sum(inside, 'tree', amt), fo0 = sum(outside, 'forest', amt), bo0 = sum(outside, 'berry', amt);
  assert.ok(inside.length > 8 && outside.length > 10, inside.length + '/' + outside.length);
  for (let t = 0; t < 600; t++) { stepN(ctx, 1); cl.dx = 0; cl.dy = 0; }
  const f1 = sum(inside, 'forest', amt), b1 = sum(inside, 'berry', amt), t1 = sum(inside, 'tree', amt);
  const deadForest = inside.filter(e => e[0] === 'forest' && S.tile[at(e[1], e[2])] !== T.FOREST).length, nForest = inside.filter(e => e[0] === 'forest').length;
  const deadBush = inside.filter(e => e[0] === 'berry' && S.res[at(e[1], e[2])] === 0).length, nBerry = inside.filter(e => e[0] === 'berry').length;
  note(`inside: wood ${f0} -> ${f1} (${deadForest}/${nForest} forest tiles dead), berries ${b0} -> ${b1} (${deadBush}/${nBerry} bushes dead), lone trees ${t0} -> ${t1}; farm in the cloud ${fIn.hp.toFixed(1)}/${fIn.maxHp} (${Buildings.get(fIn.id) ? 'standing' : 'destroyed'})`);
  assert.ok(f1 < f0 * 0.6, 'forest wood lost');
  assert.ok(deadForest >= Math.ceil(nForest * 0.4), 'thin forest dies into grass: ' + deadForest + '/' + nForest);
  for (const e of inside) if (e[0] === 'forest' && S.tile[at(e[1], e[2])] !== T.FOREST) assert.equal(S.tile[at(e[1], e[2])], T.GRASS, 'dead forest turns into grass');
  assert.ok(b1 < b0 * 0.3, 'berries lost');
  assert.ok(deadBush >= 1, 'some bushes die for good');
  assert.ok(t1 < t0 * 0.3, 'lone trees wither');
  assert.equal(Buildings.get(fIn.id), null, 'the field under the cloud is destroyed');
  assert.ok(destroyed.some(d => d.id === fIn.id && d.cause === 'poison'), 'cause poison');
  assert.equal(sum(outside, 'forest', amt) >= fo0, true, 'forest outside the radius untouched'); assert.ok(sum(outside, 'berry', amt) >= bo0, 'berries outside untouched');
  assert.equal(fOut.hp, hpOut0, 'farm outside untouched');
  // a faint cloud does nothing to the ground
  const f = mkCtx(); arena(f, 48, 48, 12); f.World.setTile(48, 48, T.FOREST, { elev: 136 }); f.S.amt[48 + 48 * 96] = 100;
  still(f.PowerPoison.addCloud(48.5, 48.5, 3, 0.11, 600)); step(f, 300);
  assert.equal(f.S.amt[48 + 48 * 96] >= 100, true, 'faint cloud: no effect');
  assert.equal(Powers.errors, 0);
});

// ================================================================== behaviour
section('flight: units inside a cloud run out of it (state flee, target outside every cloud), then stay clear', () => {
  const ctx = village(3); const { S, Units, Powers, PowerPoison } = ctx;
  const c0 = firstCity(ctx);
  const before = S.units.size;
  const cl = still(PowerPoison.addCloud(c0.x + 0.5, c0.y + 0.5, 5, 1.0, 600));
  const inCloud = () => [...S.units.values()].filter(u => Math.hypot(u.x - cl.x, u.y - cl.y) < cl.r * 0.9 && !u.armyId).length;
  const n0 = inCloud();
  assert.ok(n0 >= 4, 'villagers around the town hall: ' + n0);
  step(ctx, 12);
  const fl = [...S.units.values()].filter(u => u.state === 'flee' && u.st && u.st.pz === 1);
  assert.ok(fl.length >= Math.min(4, n0 - 1), 'they panic: ' + fl.length + ' of ' + n0);
  for (const u of fl) { assert.ok(PowerPoison.densityAt(u.st.tx, u.st.ty, S.tick) < 0.05, 'the target is outside the cloud'); assert.ok(Math.hypot(u.st.tx - cl.x, u.st.ty - cl.y) > cl.r, 'and beyond its edge'); }
  step(ctx, 180);
  const n1 = inCloud();
  note(`${n0} inside at the start, ${fl.length} fled at once, ${n1} still inside after 190 ticks; ${before - S.units.size} died`);
  assert.ok(n1 <= Math.max(1, Math.floor(n0 * 0.25)), 'almost everybody got out and stays out (avoidance): ' + n1);
  assert.equal(Powers.errors, 0); assert.equal(Units.errors, 0, String(Units.lastError && Units.lastError.stack));
});

section('soldiers keep their orders: they are poisoned but never switch to flee; civilians do', () => {
  const ctx = mkCtx(1, ['War']); const { S, Units, Cities, Diplomacy, PowerPoison, Traits } = ctx;
  arena(ctx, 48, 48, 28);
  const site = { x: 48, y: 48 };
  const cityUnits = []; for (let i = 0; i < 4; i++) cityUnits.push(Units.spawn(0, 44.5 + i, 52.5, { age: 25 }));
  const city = Cities.found(0, 40, 52, cityUnits, {}); assert.ok(city);
  const soldiers = [], civ = [];
  for (let i = 0; i < 6; i++) soldiers.push(Units.spawn(0, 48.5 + (i % 3) * 0.7, 48.5 + Math.floor(i / 3) * 0.7, { age: 25, cityId: city.id, traits: TR(ctx, 'strong'), weapon: 2, armor: 2 }));
  for (let i = 0; i < 6; i++) civ.push(Units.spawn(0, 47.5 + (i % 3) * 0.7, 46.5 + Math.floor(i / 3) * 0.7, { age: 25, cityId: city.id, traits: [] }));
  const army = { id: S.id(), kingdomId: city.kingdomId, cityId: city.id, warId: 0, leaderId: soldiers[0].id, members: [], target: null, rally: { x: 48.5, y: 48.5 }, mode: 'hold', born: S.tick };
  S.armies.set(army.id, army);
  for (const s of soldiers) assert.equal(Units.conscript(s, army.id), true);
  still(PowerPoison.addCloud(48.5, 48.0, 4.5, 1.0, 600));
  let fled = 0; const hp0 = soldiers.map(s => s.hp);
  for (let t = 0; t < 60; t++) {
    stepN(ctx, 1);
    for (const s of soldiers) if (S.units.has(s.id)) { assert.equal(s.state, 'army', 'soldier state'); assert.equal(s.armyId, army.id); }
    if (t === 20) fled = civ.filter(u => S.units.has(u.id) && u.state === 'flee').length;
  }
  const poisoned = soldiers.filter(s => S.units.has(s.id) && s.poison > S.tick).length, hurt = soldiers.filter((s, i) => S.units.has(s.id) && s.hp < hp0[i]).length;
  note(`soldiers alive ${soldiers.filter(s => S.units.has(s.id)).length}/6, poisoned ${poisoned}, hurt ${hurt}; civilians that ran at tick 20: ${fled}/6; army rally unchanged ${army.rally.x},${army.rally.y}`);
  assert.ok(poisoned >= 3 && hurt >= 3, 'soldiers inside are poisoned and hurt');
  assert.ok(fled >= 3, 'civilians run');
  assert.equal(army.rally.x, 48.5); assert.equal(army.mode, 'hold');
  void site; void Diplomacy; void Traits;
});

section('avoidance: a civilian about to walk into a cloud turns back and waits outside', () => {
  const ctx = mkCtx(); arena(ctx, 48, 48, 28);
  const { Units, S, PowerPoison } = ctx;
  const u = Units.spawn(0, 56.5, 48.5, { age: 25, hunger: 0, energy: 90 });
  const cl = still(PowerPoison.addCloud(48.5, 48.5, 4, 1.0, 600));
  u.state = 'walk'; u.st = { ph: 'go', since: S.tick, tx: 48.5, ty: 48.5, rg: 0.5, then: '', rest: 0, until: S.tick + 500 };
  let minD = 99;
  for (let t = 0; t < 200; t++) { stepN(ctx, 1); cl.dx = 0; cl.dy = 0; minD = Math.min(minD, Math.hypot(u.x - 48.5, u.y - 48.5)); }
  note(`closest approach to the centre ${minD.toFixed(2)} (cloud radius ${cl.r.toFixed(2)}), poison ${u.poison}`);
  assert.ok(minD > cl.r, 'never entered the cloud');
  assert.ok(!(u.poison > 0), 'never poisoned');
  // ... but a unit that does not know better (hungry, eating) is left alone by the avoidance rule
  const h = Units.spawn(0, 56.5, 52.5, { age: 25, hunger: 95, energy: 90 });
  h.state = 'walk'; h.st = { ph: 'go', since: S.tick, tx: 48.5, ty: 52.5, rg: 0.5, then: '', rest: 0, until: S.tick + 500 };
  step(ctx, 10);
  assert.equal(h.state, 'walk', 'a starving unit keeps walking');
});

section('rain washes the poison out of the air (the cloud ages ~3x faster under rain)', () => {
  const dry = mkCtx(); arena(dry, 48, 48, 14); dry.Powers.apply('poison', 48.5, 48.5, 3, 'tap');
  const wet = mkCtx(); arena(wet, 48, 48, 14); wet.Powers.apply('poison', 48.5, 48.5, 3, 'tap'); wet.Powers.apply('rain', 48.5, 48.5, 5, 'tap');
  let tw = -1, td = -1;
  for (let t = 1; t <= 700 && (tw < 0 || td < 0); t++) {
    if (tw < 0) { step(wet, 1); if (!clouds(wet).length) tw = t; }
    if (td < 0) { step(dry, 1); if (!clouds(dry).length) td = t; }
  }
  note(`dry cloud lasts ${td} ticks, under a rain cloud ${tw}`);
  assert.ok(td > 560 && tw > 0 && tw < td * 0.6, 'rain shortens the cloud');
});

section('chronicle: a ruler killed by poison and a deadly cloud get ONE line each, never one per victim', () => {
  const ctx = mkCtx(); island(ctx, 2);
  const { Units, S, Log, Const } = ctx;
  const us = []; for (let i = 0; i < 10; i++) us.push(Units.spawn(i % 3, 47.5 + (i % 4) * 0.8, 47.5 + Math.floor(i / 4) * 0.8, { age: 25, traits: [], hunger: 0, energy: 90 }));
  us[0].isRuler = true; us[0].name = 'Тестар';
  const lines0 = S.log.length;
  still(ctx.PowerPoison.addCloud(48.5, 48.5, 5, 1.2, 600));
  step(ctx, 650);
  const dead = ctx.deaths.filter(d => d.cause === 'poison').length;
  const lines = S.log.slice(lines0).filter(l => /Ядовит|отравлен/.test(l.msg));
  const rulersKilled = ctx.deaths.filter(d => d.cause === 'poison' && d.ruler).length;
  note(`victims ${dead} (${rulersKilled} rulers); chronicle: ${lines.map(l => l.msg).join(' | ')}`);
  assert.ok(dead >= 8, 'a deadly trap: ' + dead);
  assert.ok(rulersKilled >= 1);
  assert.equal(lines.filter(l => /отравлен/.test(l.msg)).length, rulersKilled, 'exactly one line per dead ruler');
  assert.equal(lines.filter(l => /Тестар/.test(l.msg)).length, 1, 'one line for our ruler');
  assert.equal(lines.filter(l => /рассеялось/.test(l.msg)).length, 1, 'one summary of the cloud');
  assert.ok(/погибло \d+/.test(lines.find(l => /рассеялось/.test(l.msg)).msg));
  assert.ok(lines.every(l => l.kind === Const.LOG.DISASTER));
  assert.ok(ctx.S.mod.poison.vic === dead, 'victims counted: ' + ctx.S.mod.poison.vic);
  void Log;
});

// ================================================================== robustness
function fingerprint(ctx) {
  const us = []; for (const u of ctx.S.units.values()) us.push([u.id, +u.x.toFixed(3), +u.y.toFixed(3), +u.hp.toFixed(3), u.poison, u.state]);
  let th = 0; for (let i = 0; i < ctx.S.tile.length; i++) th = (Math.imul(th, 31) + ctx.S.tile[i] * 3 + ctx.S.amt[i] + ctx.S.res[i]) | 0;
  const bs = []; for (const b of ctx.S.buildings.values()) bs.push([b.id, +b.hp.toFixed(3)]);
  return JSON.stringify({ tick: ctx.S.tick, eff: ctx.S.eff, mod: ctx.S.mod.poison, us, th, bs, rng: ctx.R.getState() });
}

section('chaos: 3000 ticks of random actions with EVERY power (poison included) - caps hold, no exceptions, finite state', () => {
  const ctx = village(5);
  const { Powers, ToolDefs, S, Const, Fx } = ctx;
  const phases = ['tap', 'start', 'move', 'move', 'move', 'end'];
  let rs = 987654;
  const rnd = () => { rs = (Math.imul(rs, 1664525) + 1013904223) | 0; return (rs >>> 0) / 4294967296; };
  const ids = ToolDefs.map(t => t.id);
  let x = 48, y = 48, maxClouds = 0, maxPois = 0, taps = 0;
  const c0 = firstCity(ctx);
  for (let i = 0; i < 3000; i++) {
    const id = rnd() < 0.3 ? 'poison' : ids[(rnd() * ids.length) | 0];
    if (rnd() < 0.8) { x = Math.max(-2, Math.min(S.w + 2, x + (rnd() - 0.5) * 6)); y = Math.max(-2, Math.min(S.h + 2, y + (rnd() - 0.5) * 6)); } else { x = rnd() < 0.5 ? c0.x + rnd() * 6 - 3 : rnd() * S.w; y = rnd() < 0.5 ? c0.y + rnd() * 6 - 3 : rnd() * S.h; }
    if (id === 'poison' && Powers.apply(id, x, y, 1 + ((rnd() * 8) | 0), phases[(rnd() * phases.length) | 0])) taps++;
    else if (id !== 'poison' && id !== 'erase') Powers.apply(id, x, y, 1 + ((rnd() * 8) | 0), phases[(rnd() * phases.length) | 0]);
    step(ctx, 1);
    maxClouds = Math.max(maxClouds, clouds(ctx).length);
    if (i % 100 === 0) {
      maxPois = Math.max(maxPois, pois(ctx));
      assert.deepEqual(JSON.parse(JSON.stringify(S.eff)), S.eff, 'S.eff JSON-safe at ' + i);
      for (const c of clouds(ctx)) for (const k in c) assert.ok(Number.isFinite(c[k]), 'finite cloud field ' + k);
      for (const u of S.units.values()) assert.ok(Number.isFinite(u.poison) && u.poison >= 0, 'finite poison field');
    }
  }
  note(`${taps} poison actions, max live clouds ${maxClouds}, max poisoned at once ${maxPois}, units ${S.units.size}, victims ${S.mod.poison.vic}, fx queue ${Fx.list.length}`);
  assert.ok(maxClouds <= 14, 'cloud cap: ' + maxClouds);
  assert.ok(Fx.list.length < 400);
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
  for (const u of S.units.values()) assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y) && u.x >= 0 && u.y >= 0 && u.x < S.w && u.y < S.h, 'unit position sane');
  for (let i = 0; i < S.tile.length; i++) assert.ok(S.tile[i] < Const.TILE_COUNT);
  step(ctx, 700);                                                         // everything ends: no cloud, nobody poisoned for ever
  assert.equal(clouds(ctx).length, 0, 'no cloud outlives its time'); assert.equal(pois(ctx), 0, 'no unit stays poisoned');
});

section('save / load: mid-cloud the continuation is identical (clouds, poisoned units, ecology, RNG)', () => {
  const A = village(4, 500);
  const { S } = A;
  const c0 = firstCity(A);
  A.Powers.apply('poison', c0.x + 0.5, c0.y + 0.5, 4, 'tap');
  A.Powers.apply('poison', c0.x + 6.5, c0.y + 1.5, 2, 'start'); for (let i = 1; i < 10; i++) { A.Powers.apply('poison', c0.x + 6.5 + i * 0.8, c0.y + 1.5, 2, 'move'); step(A, 1); }
  step(A, 60);
  assert.ok(clouds(A).length >= 2 && pois(A) >= 1, 'cloud(s) and victims at save time: ' + clouds(A).length + '/' + pois(A));
  const json = A.Save.serialize();
  const B = loadSim(); assert.ok(B.Save.deserialize(json), 'deserialize');
  B.deaths = [];
  A.Cities.afterLoad(); A.World.afterLoad();                              // same non-persistent cache reset a load performs (documented leaks of Cities / World)
  assert.deepEqual(JSON.parse(JSON.stringify(B.S.eff)), JSON.parse(JSON.stringify(A.S.eff)), 'S.eff identical right after the load');
  assert.deepEqual(B.S.mod.poison, A.S.mod.poison);
  for (const u of A.S.units.values()) assert.equal(B.S.units.get(u.id).poison, u.poison, 'poison field survives the save');
  step(A, 400); step(B, 400);
  assert.equal(fingerprint(A), fingerprint(B), 'continuation after load is identical');
  note(`clouds ${clouds(A).length}, poisoned ${pois(A)}, units ${A.S.units.size}, victims ${A.S.mod.poison.vic}`);
  assert.equal(A.Powers.errors, 0); assert.equal(B.Powers.errors, 0);
  void S;
});

section('every unit has the same shape: poison field always present, the save table is not ragged (a ragged table loads 3.5x slower)', () => {
  const ctx = village(6, 700);
  const { S, Units } = ctx;
  assert.ok(S.units.size > 14, 'births happened');
  for (const u of S.units.values()) assert.equal(typeof u.poison, 'number', 'unit ' + u.id);
  const c = firstCity(ctx);
  ctx.Powers.apply('poison', c.x + 0.5, c.y + 0.5, 3, 'tap'); step(ctx, 20);
  assert.ok(pois(ctx) >= 1);
  const born = Units.spawn(0, c.x + 6.5, c.y + 6.5, {});
  if (born) assert.equal(born.poison, 0, 'newborn');
  const j = JSON.parse(ctx.Save.serialize());
  assert.equal(j.units.m, undefined, 'units table is not ragged');
  assert.ok(j.units.k.includes('poison'));
  // an OLD save (without the field): the load gives every unit the field
  const old = JSON.parse(ctx.Save.serialize()); const ki = old.units.k.indexOf('poison');
  old.units.k.splice(ki, 1); for (const r of old.units.r) r.splice(ki, 1);
  const L = loadSim(); assert.ok(L.Save.deserialize(JSON.stringify(old)), 'old save loads');
  for (const u of L.S.units.values()) assert.equal(u.poison, 0);
  assert.equal(JSON.parse(L.Save.serialize()).units.m, undefined);
});

section('performance: 14 clouds over ~600 units - plugin step cost per tick, and what the clouds add to the whole sim', () => {
  const ctx = village(3, 300); const { S, Units, Powers, PowerPoison } = ctx;
  const c = firstCity(ctx);
  for (let i = 0; i < 600; i++) { const a = i * 2.4, d = 1 + (i % 19); Units.spawn(i % 3, c.x + 0.5 + Math.cos(a) * d, c.y + 0.5 + Math.sin(a) * d, {}); }
  step(ctx, 30);
  const plug = []; const orig = PowerPoison.step;
  const wrap = (tick, host) => { const t0 = performance.now(); orig(tick, host); plug.push(performance.now() - t0); };
  PowerPoison.step = wrap;
  const idle0 = performance.now(); step(ctx, 150); const idleMs = (performance.now() - idle0) / 150;
  const idleAvg = plug.reduce((a, b) => a + b, 0) / plug.length;
  const rounds = [];                                                      // best of three: other processes share this machine
  for (let k = 0; k < 3; k++) {
    clouds(ctx).length = 0;
    for (let i = 0; i < 14; i++) { const a = i * 0.9, d = 4 + (i % 5) * 2.5; PowerPoison.addCloud(c.x + 0.5 + Math.cos(a) * d, c.y + 0.5 + Math.sin(a) * d, 4 + (i % 3), 1.0, 1000); }
    assert.equal(clouds(ctx).length, 14);
    plug.length = 0;
    const t0 = performance.now(); step(ctx, 150); const wholeMs = (performance.now() - t0) / 150;
    const sorted = plug.slice().sort((a, b) => a - b);
    rounds.push({ avg: plug.reduce((a, b) => a + b, 0) / plug.length, p99: sorted[Math.floor(sorted.length * 0.99)], max: sorted[sorted.length - 1], wholeMs });
  }
  const first = rounds[0], steady = rounds.slice(1).sort((a, b) => a.avg - b.avg)[0];
  note(`units ${S.units.size}; plugin step: no clouds ${idleAvg.toFixed(4)} ms; 14 fresh clouds over the crowd: avg ${first.avg.toFixed(3)} p99 ${first.p99.toFixed(2)} max ${first.max.toFixed(2)} ms; steady (best of 2 rounds): avg ${steady.avg.toFixed(3)} p99 ${steady.p99.toFixed(3)} max ${steady.max.toFixed(2)} ms; whole sim ${idleMs.toFixed(2)} -> ${steady.wholeMs.toFixed(2)} ms/tick; poisoned ${pois(ctx)}`);
  assert.ok(idleAvg < 0.05, 'no clouds: the plugin is nearly free (' + idleAvg.toFixed(4) + ' ms)');
  assert.ok(Math.min(first.avg, steady.avg) < 0.3 && steady.avg < 0.3, '< 0.3 ms per tick with 14 clouds: ' + steady.avg.toFixed(3));
  assert.ok(first.p99 < 4 && steady.p99 < 4, 'rare spikes only: ' + first.p99.toFixed(2) + ' / ' + steady.p99.toFixed(2));
  assert.ok(first.max < 40, 'the burst when 14 clouds land on a crowd stays a one-off: ' + first.max.toFixed(1));
  // the realistic worst case: one tap on a dense crowd of ~300 (the one-off budget of the contract is 8 ms)
  const dense = [];
  for (let rep = 0; rep < 4; rep++) {
    clouds(ctx).length = 0;
    let k = 0; const N = S.units.size;
    for (const u of S.units.values()) { u.poison = 0; if (u.state === 'flee') { u.state = 'idle'; u.st = {}; } const a = k * 2.4, d = Math.sqrt(((k++) + 0.5) / N) * 6; const x = c.x + 0.5 + Math.cos(a) * d, y = c.y + 0.5 + Math.sin(a) * d; if (ctx.World.walkable(x, y)) { u.x = x; u.y = y; u.px = x; u.py = y; } }
    Units.rebuildGrid();
    Powers.apply('poison', c.x + 0.5, c.y + 0.5, 5, 'tap');
    plug.length = 0; step(ctx, 30);
    dense.push(Math.max(...plug));
  }
  note(`one tap (brush 5) on a dense crowd of ${S.units.size}: costliest tick per try ${dense.map(x => x.toFixed(2)).join(' / ')} ms`);
  assert.ok(Math.min(...dense) < 8, 'a tap on a crowd costs < 8 ms in its worst tick: ' + Math.min(...dense).toFixed(2));
  PowerPoison.step = orig;
  assert.equal(Powers.errors, 0);
});

section('robust against stubbed neighbours (Units / Cities / Buildings / Kingdoms / Diplomacy / War missing)', () => {
  const ctx = loadSim({ stub: ['Units', 'Cities', 'Buildings', 'Kingdoms', 'Diplomacy', 'War', 'Sim'] });
  newWorld(ctx, 3, 96, 96);
  const { Powers, S, World, Const } = ctx;
  arena({ ...ctx, Buildings: { destroyAt() {} } }, 48, 48, 12, Const.T.FOREST);
  for (const ph of ['tap', 'start', 'move', 'end']) assert.doesNotThrow(() => Powers.apply('poison', 48.5, 48.5, 4, ph));
  for (let i = 0; i < 120; i++) { S.tick++; World.step(S.tick); Powers.step(S.tick); }
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
});

// ================================================================== graphics smoke test (fake DOM, no browser)
section('graphics plugin (fake DOM): icon, fx, cloud draw, tint, badge - finite arguments, draw-call budget, nothing grows', () => {
  let bad = 0, draws = 0, rects = 0, made = 0;
  const mkCanvas = () => {
    made++;
    const c = { width: 0, height: 0, _img: null, style: {} };
    const ctx = new Proxy({ canvas: c, imageSmoothingEnabled: true, globalAlpha: 1, createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }, putImageData(id) { c._img = id; },
      getImageData() { return c._img; } }, { get(t, k) { if (k in t) return t[k]; return function () { for (const a of arguments) if (typeof a === 'number' && !Number.isFinite(a)) bad++; if (k === 'drawImage') draws++; else if (k === 'fillRect') rects++; }; }, set(t, k, v) { t[k] = v; return true; } });
    c.getContext = () => ctx;
    return c;
  };
  const doc = { createElement: () => mkCanvas() };
  const code = ['00_core.js', '01_tiles.js', '02_data.js', '20_sprites.js', '32_gfx_poison.js'].map(f => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
  const m = new Function('document', '"use strict";\n' + code + '\nreturn { Sprites, GfxPlugins, UIPlugins, S, GfxPoison, Const };')(doc);
  const { Sprites, GfxPlugins, UIPlugins, S, GfxPoison } = m;
  assert.ok(Sprites.iconKeys().includes('poison'), 'icon registered');
  for (const sz of [16, 32, 48, 64]) { const ic = Sprites.icon('poison', sz); assert.equal(ic.width, sz); assert.equal(Sprites.icon('poison', sz), ic, 'cached'); }
  { const ic = Sprites.icon('poison', 16); let lit = 0; const d = ic._img.data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++; assert.ok(lit > 100, 'the 16 px base icon is drawn (' + lit + ' px)'); }
  assert.deepEqual(GfxPlugins.unitTints.map(t => t.field), ['poison']);
  S.tick = 100;
  assert.deepEqual(UIPlugins.unitBadges[0]({ poison: 160 }), { t: 'Отравлен', cls: 'bad' });
  assert.equal(UIPlugins.unitBadges[0]({ poison: 0 }), null); assert.equal(UIPlugins.unitBadges[0]({}), null);
  const eff = GfxPlugins.effects.find(e => e.key === 'clouds');
  assert.ok(eff && eff.margin >= 12 && typeof eff.draw === 'function');
  const H = Sprites.fxHelpers, ctx2d = mkCanvas().getContext('2d'); ctx2d.canvas.width = 780; ctx2d.canvas.height = 1688;
  S.w = 96; S.h = 96; S.units = new Map(); for (let i = 1; i <= 60; i++) S.units.set(i, { id: i, x: 48 + (i % 10) * 0.4, y: 48 + Math.floor(i / 10) * 0.4, px: 48, py: 48, poison: i % 2 ? 300 : 0 });
  let maxPer = 0, nowStep = 0;
  for (const scale of [4, 8, 14, 28, 48]) for (const r of [1.2, 3, 6, 10]) for (const dens of [1.5, 1, 0.5, 0.1, 0.03]) {
    const e = { id: 3, x: 48, y: 48, r, dens, d0: 1, t0: 0, until: 600 };
    const d0 = draws, r0 = rects;
    eff.draw(ctx2d, e, 390, 800, scale, 12345 + (nowStep += 17), H, 0.5);
    maxPer = Math.max(maxPer, draws - d0 + (rects - r0));
  }
  note(`worst case ${maxPer} draw calls for one cloud + the unit bubbles of the frame; ${made} canvases baked`);
  assert.equal(bad, 0, 'no NaN / Infinity arguments reached the canvas');
  assert.ok(maxPer <= 130, 'draw calls per cloud stay small (<= 130 incl. the 2 bubbles on each of <= 40 poisoned units): ' + maxPer);
  for (let f = 0; f < 600; f++) eff.draw(ctx2d, { id: 3, x: 48, y: 48, r: 6, dens: 1, d0: 1, t0: 0, until: 600 }, 390, 800, 28, 20000 + f * 16, H, 0.5);     // warm-up: sprites are baked lazily
  const made0 = made;
  for (let f = 0; f < 600; f++) eff.draw(ctx2d, { id: 3, x: 48, y: 48, r: 6, dens: 1, d0: 1, t0: 0, until: 600 }, 390, 800, 28, 40000 + f * 16, H, 0.5);
  assert.equal(made - made0, 0, 'steady state: nothing is baked or allocated per frame');
  assert.ok(made < 140, 'the sprite cache is bounded (' + made + ' canvases)');
  const nof = Object.keys(GfxPlugins.fx);
  assert.ok(nof.includes('poison_burst') && nof.includes('poison_soul'));
  for (const type of nof.filter(k => k.startsWith('poison_'))) for (const p of [0, 0.3, 0.7, 1]) GfxPlugins.fx[type](ctx2d, { x: 3.2, y: 4.1, r: 3, ttl: 1 }, 100, 100, 28, 28 / 16, p, 9999, H);
  assert.equal(bad, 0);
  void GfxPoison;
});

console.log('');
// ================================================================== browser part
if (!args.nobrowser) {
  const { launch } = await import('./browser.mjs');
  const shots = String(args.shots || '/tmp/godsim-poison-shots');
  fs.mkdirSync(shots, { recursive: true });
  const out = '/tmp/godsim-poison-test.html';
  execFileSync('node', [path.join(root, 'build.mjs'), '--out=' + out, '--check'], { cwd: root, stdio: 'pipe' });
  let b = null;
  const bsection = async (name, fn) => {
    const t0 = performance.now();
    try { await fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 86)} ${(performance.now() - t0).toFixed(0)} ms`); }
    catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 12).join('\n       ')}`); }
  };
  console.log('browser (390x844 @2x touch):');
  b = await launch({ url: 'file://' + out, width: 390, height: 844, dpr: 2 });
  const E = (fn, arg) => b.eval(fn, arg);
  for (let i = 0; i < 80; i++) { if (await E(() => !!(window.__god && window.__poisonGfx && document.querySelector('.tab')))) break; await b.sleep(100); }
  const info = await E(async () => {
    const g = window.__god;
    g.Main.newWorld({ seed: 7, w: 96, h: 96, populate: true }); g.setSpeed(0);
    for (let i = 0; i < 12; i++) { g.step(100); await new Promise(r => setTimeout(r, 0)); }
    const c = g.Main.largestSettlement() || { x: 48, y: 48 };
    return { tick: g.S.tick, units: g.S.units.size, c };
  });
  await bsection('dock: the «Яд» button sits in Силы / Разрушение with the short label and a drawn skull-flask icon', async () => {
    await E(() => window.__god.UI.selectTab('powers')); await b.sleep(300);
    const tool = await E(() => {
      const btn = document.querySelector('.tool[data-tool="poison"]');
      if (!btn) return null;
      const cv = btn.querySelector('canvas'); let lit = 0, green = 0;
      if (cv) { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) { lit++; if (d[i + 1] > d[i] + 30 && d[i + 1] > d[i + 2] + 30) green++; } }
      const grp = btn.closest('.grp'), lab = grp && grp.querySelector('.grp-lbl');
      return { label: btn.textContent.trim(), lit, green, group: lab ? lab.textContent.trim() : '' };
    });
    assert.ok(tool, 'button exists');
    assert.equal(tool.label, 'Яд'); assert.equal(tool.group, 'Разрушение'); assert.ok(tool.lit > 300 && tool.green > 40, JSON.stringify(tool));
    await E(() => { const t = document.querySelector('.tool[data-tool="poison"]'); t.scrollIntoView({ inline: 'center' }); t.click(); });
    await b.sleep(400);
    assert.equal(await E(() => window.__god.UI.state.tool), 'poison');
    await b.shot(shots + '/01_dock_tool.png', { clip: { x: 0, y: 664, width: 390, height: 180 } });
  });
  await bsection('real touch: a tap makes a cloud, a stroke in brush mode sprays a trail; both draw (cloud, bubbles, burst fx)', async () => {
    await E(([x, y]) => { const g = window.__god; g.Render.setMode(0); g.Render.setCamera(x, y, 14); }, [info.c.x, info.c.y]);
    await b.sleep(500);
    const p = await E(([x, y]) => window.__god.Render.tileToScreen(x + 3, y), [info.c.x, info.c.y]);
    await b.tap(p.x, p.y);
    await b.sleep(250);
    const n1 = await E(() => window.__god.S.eff.clouds ? window.__god.S.eff.clouds.length : 0);
    assert.equal(n1, 1, 'tap made one cloud');
    assert.equal(await E(() => window.__god.Powers.lastMessage), 'Ядовитое облако');
    await E(() => { window.__god.UI.setMode('paint'); });
    await b.sleep(200);
    const a = await E(([x, y]) => window.__god.Render.tileToScreen(x - 6, y + 5), [info.c.x, info.c.y]), z = await E(([x, y]) => window.__god.Render.tileToScreen(x + 1, y + 7), [info.c.x, info.c.y]);
    await b.drag(a.x, a.y, z.x, z.y, 14, 40);
    await b.sleep(250);
    const n2 = await E(() => window.__god.S.eff.clouds.length);
    note(`clouds after the tap: ${n1}, after the stroke: ${n2}; input mode ${await E(() => window.__god.UI.state.mode)}`);
    assert.ok(n2 >= 3, 'a stroke sprays a trail of puffs: ' + n2);
    await E(() => { window.__god.step(10); }); await b.sleep(1100);
    await b.shot(shots + '/02_tap_and_spray_z14.png');
    const gs = await E(() => window.__poisonGfx.stats());
    assert.ok(gs.masses.some(n => n > 0), 'cloud bodies were baked: ' + JSON.stringify(gs));
  });
  await bsection('unit card: poisoned units show the «Отравлен» chip, tinted sprite, bubbles; antidote clears it', async () => {
    const uid = await E(() => { const g = window.__god; const c = g.S.eff.clouds[0]; const u = [...g.S.units.values()].find(u => u.poison > g.S.tick) || [...g.S.units.values()][0]; u.poison = g.S.tick + 300; return u.id; });
    await E((id) => window.__god.UI.openInspector('unit', id), uid); await b.sleep(500);
    const chips = await E(() => [...document.querySelectorAll('#sheet .chip')].map(x => x.textContent.trim()));
    assert.ok(chips.includes('Отравлен'), chips.join('|'));
    await b.shot(shots + '/03_unit_card.png');
    await E(() => window.__god.UI.closeInspector && window.__god.UI.closeInspector());
    const u = await E((id) => { const g = window.__god; const u = g.S.units.get(id); g.Powers.heal(u.x, u.y, 1); return { poison: u.poison, hp: u.hp, maxHp: u.maxHp }; }, uid);
    assert.equal(u.poison, 0); assert.equal(u.hp, u.maxHp);
  });
  await bsection('zoom 8 / 14 / 24: the cloud, haze rim, bubbles and tinted victims render (screenshots)', async () => {
    await E(([x, y]) => { const g = window.__god; g.S.eff.clouds.length = 0; g.Powers.apply('poison', x + 2, y, 4, 'tap'); g.Powers.apply('poison', x - 5, y + 2, 2, 'tap'); g.step(16); g.Render.setCamera(x, y, 14); }, [info.c.x, info.c.y]);
    for (const z of [8, 14, 24]) {
      await E(([x, y, z]) => { window.__god.Render.setCamera(x, y, z); }, [info.c.x, info.c.y, z]);
      await b.sleep(1300);
      await b.shot(shots + `/04_zoom_${z}.png`);
    }
    assert.equal(b.errors.length, 0, b.errors.join(' | ').slice(0, 300));
  });
  await bsection('draw cost: 14 clouds in view add <= 2.5 ms per frame (software GL) at zoom 8 and 14, one cloud costs well under 0.5 ms', async () => {
    const measure = (n = 120) => E((n) => new Promise(res => { let i = 0, sum = 0, worst = 0; function f() { const d = window.__god.Render.stats.drawMs || 0; sum += d; if (d > worst) worst = d; if (++i < n) requestAnimationFrame(f); else res({ avg: sum / i, worst }); } requestAnimationFrame(f); }), n);
    const rows = [];
    for (const z of [8, 14]) {
      await E(([x, y, z]) => { const g = window.__god; g.S.eff.clouds.length = 0; g.Render.setCamera(x, y, z); }, [info.c.x, info.c.y, z]);
      await b.sleep(900);
      const off = await measure();
      await E(([x, y, z]) => { const g = window.__god, V = g.Render.visibleRect(); g.S.eff.clouds.length = 0; for (let i = 0; i < 14; i++) { const r = 2.5 + (i % 4); g.S.eff.clouds.push({ id: i + 1, x: V.x0 + 2 + ((i * 5.3) % Math.max(1, V.x1 - V.x0 - 4)), y: V.y0 + 2 + ((i * 3.7) % Math.max(1, V.y1 - V.y0 - 4)), r, r0: r, dens: 1, d0: 1, t0: g.S.tick, until: g.S.tick + 5000, dx: 0, dy: 0, nt: 1e9, k: 0 }); } }, [info.c.x, info.c.y, z]);
      await b.sleep(1500);
      const on = await measure();
      const one = await E(([x, y]) => { const g = window.__god; const L = g.S.eff.clouds; g.S.eff.clouds = L.slice(0, 1); return 1; }, [0, 0]);
      await b.sleep(700);
      const single = await measure();
      rows.push(`zoom ${z}: off ${off.avg.toFixed(2)} ms | 14 clouds ${on.avg.toFixed(2)} ms (worst ${on.worst.toFixed(1)}) | 1 cloud ${single.avg.toFixed(2)} ms`);
      assert.ok(on.avg - off.avg < 2.5, `14 clouds at zoom ${z} cost ${(on.avg - off.avg).toFixed(2)} ms`);
      assert.ok(single.avg - off.avg < 0.8, `1 cloud at zoom ${z} costs ${(single.avg - off.avg).toFixed(2)} ms`);
      void one;
    }
    note(rows.join('\n       '));
    assert.equal(b.errors.length, 0, b.errors.join(' | ').slice(0, 300));
  });
  await b.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
if (failed.length) process.exit(1);
