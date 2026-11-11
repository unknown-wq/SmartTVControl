// God power «Ракеты» (rocket volley): node tests/power_rocket.test.mjs [--nobrowser] [--shots=/tmp/godsim-rocket-shots] [--seconds=..]
// Headless part: registration, salvo size / scatter / bias, launch rule, timing, impact (units / buildings / trees / fire / water / mountains),
// caps + cooldown + merge, log lines, 3000-tick chaos with every other power, save / load in mid-flight, perf.
// Browser part (needs Playwright + Chromium): icon, tool button, toast, reticles, trails, impacts at zoom 8 / 14 / 24 (screenshots), draw budget.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSim, stepN, newWorld, pad } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 92)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 10).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

// ------------------------------------------------------------------ plumbing
function mkCtx(seed = 3) {
  const ctx = loadSim();
  newWorld(ctx, seed, 96, 96);
  ctx.deaths = [];
  ctx.Bus.on('unitDied', (u, cause) => { ctx.deaths.push({ id: u.id, cause, x: u.x, y: u.y }); });
  ctx.volleys = [];
  ctx.Bus.on('rocketVolley', (n, x, y) => { ctx.volleys.push({ n, x, y }); });
  return ctx;
}
function step(ctx, n) { for (let i = 0; i < n; i++) { stepN(ctx, 1); ctx.Fx.update(0.1); } }
/** square [cx-half, cx+half] of one tile type, flat, resources / buildings / fire cleared */
function arena(ctx, cx, cy, half, tile) {
  const { World, S, Const, Tiles } = ctx;
  const t = tile === undefined ? Const.T.GRASS : tile;
  for (let y = cy - half; y <= cy + half; y++) for (let x = cx - half; x <= cx + half; x++) {
    if (y < 0 || x < 0 || y >= S.h || x >= S.w) continue;
    if (S.bld[y * S.w + x]) ctx.Buildings.destroyAt(x, y, 'test');
    S.fire[y * S.w + x] = 0; S.res[y * S.w + x] = 0; S.amt[y * S.w + x] = 0;
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
const house = (ctx, cityId, x, y) => ctx.Buildings.place(cityId, ctx.Const.B.HOUSE, x, y, { instant: true });
/** a unit with a fixed, known hp (damage can then be read back exactly) */
function dummy(ctx, race, x, y, hp = 200) { const u = ctx.Units.spawn(race, x, y, { age: 25 }); assert.ok(u, 'spawn'); u.maxHp = u.hp = hp; return u; }
/** put one rocket into the air by hand: it lands at (x1,y1) in the step of tick eta */
function inject(ctx, x1, y1, eta, o = {}) {
  const { S } = ctx;
  if (!Array.isArray(S.eff.rockets)) S.eff.rockets = [];
  const e = Object.assign({ x: x1, y: -3, x0: x1, y0: -3, x1, y1, t0: eta - 14, eta, r: 1.8, b: 0, h: 2, v: 1, l: 1 }, o);
  S.eff.rockets.push(e);
  return e;
}
/** land one rocket right now (calls the plugin step directly: nothing else moves) */
function boom(ctx, x, y) {
  const { S, PowerRocket, Powers } = ctx;
  inject(ctx, x, y, S.tick + 1);
  S.tick++;
  PowerRocket.step(S.tick, Powers.host);
}
const fxCount = (ctx, type) => ctx.Fx.list.filter(f => f.type === type).length;
const eachRocketAll = (ctx) => ctx.S.eff.rockets || [];
const dist = (a, b, c, d) => Math.hypot(a - c, b - d);
function volley(ctx, x, y, r) { ctx.S.mod.rocket && (ctx.S.mod.rocket.cd = 0); const ok = ctx.Powers.apply('rocket', x, y, r, 'tap'); return ok; }
function clearSky(ctx) { ctx.S.eff.rockets = []; if (ctx.S.mod.rocket) { ctx.S.mod.rocket.cd = 0; ctx.S.mod.rocket.a = null; } }
const jsonSafe = (o, label) => assert.deepEqual(JSON.parse(JSON.stringify(o)), o, label + ': JSON round trip must be identical');
function finiteDeep(o, label) { for (const k in o) { const v = o[k]; if (typeof v === 'number') assert.ok(Number.isFinite(v), label + '.' + k + ' finite'); else if (v && typeof v === 'object') finiteDeep(v, label + '.' + k); } }

console.log('rocket power tests');

// ================================================================== registration
section('registration: tool def, group «Арсенал» after «Разрушение», plugin ids, idempotent', () => {
  const ctx = mkCtx();
  const { ToolDefs, PowerPlugins, PowerRocket } = ctx;
  const d = ToolDefs.byId.rocket;
  assert.ok(d, 'tool registered');
  assert.equal(d.tab, 'powers'); assert.equal(d.group, 'arsenal'); assert.equal(d.name, 'Ракеты'); assert.equal(d.short, 'Ракеты');
  assert.equal(d.icon, 'rocket'); assert.equal(d.brush, true); assert.equal(d.drag, false);
  assert.ok(d.hint && /[а-яё]/i.test(d.hint), 'Russian hint');
  assert.equal(ToolDefs.groupLabels.arsenal, 'Арсенал');
  const ids = ToolDefs.filter(t => t.tab === 'powers').map(t => t.id);
  const iR = ids.indexOf('rocket'), lastDestroy = Math.max(...ids.map((id, i) => ToolDefs.byId[id].group === 'destroy' ? i : -1)), iBless = ids.findIndex(id => ToolDefs.byId[id].group === 'bless');
  assert.ok(iR === lastDestroy + 1 || ToolDefs.byId[ids[iR - 1]].group === 'arsenal', 'right after the destroy group (or after other arsenal tools): ' + ids.join(','));
  assert.ok(iR < iBless, 'before the blessings');
  assert.equal(PowerPlugins.filter(p => p.name === 'rocket').length, 1);
  assert.equal(ToolDefs.add({ id: 'rocket', tab: 'powers', group: 'x' }), d, 're-adding is a no-op');
  assert.equal(ToolDefs.filter(t => t.id === 'rocket').length, 1);
  assert.deepEqual([PowerRocket.params.BLAST_R, PowerRocket.params.COOLDOWN, PowerRocket.params.N_MAX, PowerRocket.params.LIVE_CAP], [1.8, 12, 9, 54], 'documented numbers');
});

// ================================================================== salvo
section('salvo size = 3 + brush radius (cap 9), toast text with Russian plural, Bus event, state is JSON-safe', () => {
  const ctx = mkCtx();
  const { S, Powers } = ctx;
  arena(ctx, 48, 48, 14);
  const want = { 1: 4, 2: 5, 3: 6, 4: 7, 5: 8, 6: 9, 7: 9, 8: 9 };
  for (const r of [1, 2, 3, 4, 5, 6, 7, 8]) {
    clearSky(ctx);
    assert.equal(Powers.apply('rocket', 48.5, 48.5, r, 'tap'), true, 'r=' + r);
    assert.equal(S.eff.rockets.length, want[r], 'r=' + r + ' rockets');
    const n = want[r];
    assert.equal(Powers.lastMessage, 'Залп: ' + n + ' ' + (n === 4 ? 'ракеты' : 'ракет'), 'toast text');
    assert.deepEqual(ctx.volleys[ctx.volleys.length - 1], { n, x: 48.5, y: 48.5 }, 'Bus rocketVolley');
    jsonSafe(S.eff, 'eff r=' + r); jsonSafe(S.mod, 'mod r=' + r);
    for (const e of S.eff.rockets) {
      assert.equal(e.r, 1.8); assert.equal(e.l === 1 || e.l === 0, true);
      for (const k of ['x', 'y', 'x0', 'y0', 'x1', 'y1', 't0', 'eta', 'b', 'h', 'v']) assert.ok(Number.isFinite(e[k]), 'finite ' + k);
      assert.ok(!Object.is(e.x0, -0) && !Object.is(e.y0, -0) && !Object.is(e.x, -0) && !Object.is(e.y, -0), 'no -0');
    }
  }
  clearSky(ctx);
  assert.equal(Powers.apply('rocket', 48.5, 48.5, 99, 'tap'), true, 'radius is clamped');
  assert.equal(S.eff.rockets.length, 9);
  clearSky(ctx);
  assert.equal(Powers.apply('rocket', 48.5, 48.5, NaN, 'tap'), true, 'NaN radius -> default');
  assert.equal(S.eff.rockets.length, 5);
});

section('aim: scatter within 0.8 * r (first rocket on the tap), minimum spacing, always inside the map', () => {
  const ctx = mkCtx();
  const { S, Powers } = ctx;
  arena(ctx, 48, 48, 20);
  for (const r of [1, 2, 4, 8]) {
    let maxD = 0, first = 0, minSep = 99, cnt = 0;
    for (let k = 0; k < 40; k++) {
      clearSky(ctx);
      Powers.apply('rocket', 48.5, 48.5, r, 'tap');
      const L = S.eff.rockets;
      first = Math.max(first, dist(L[0].x1, L[0].y1, 48.5, 48.5));
      for (let i = 0; i < L.length; i++) {
        maxD = Math.max(maxD, dist(L[i].x1, L[i].y1, 48.5, 48.5));
        for (let j = 0; j < i; j++) { const d = dist(L[i].x1, L[i].y1, L[j].x1, L[j].y1); minSep = Math.min(minSep, d); if (d < 0.6) cnt++; }
      }
    }
    assert.ok(first <= 0.36, `first rocket on the tap (r=${r}): ${first.toFixed(2)}`);
    assert.ok(maxD <= 0.8 * r + 0.4, `scatter radius r=${r}: ${maxD.toFixed(2)} <= ${(0.8 * r + 0.4).toFixed(2)}`);
    if (r >= 4) assert.ok(maxD > 0.8 * r * 0.6, `the scatter really uses the disc (r=${r}): ${maxD.toFixed(2)}`);
    note(`r=${r}: farthest aim ${maxD.toFixed(2)} tiles (limit ${(0.8 * r).toFixed(1)}), closest pair ${minSep.toFixed(2)}`);
  }
  // near the map corner: aim points are clamped into the map
  clearSky(ctx);
  Powers.apply('rocket', 0.4, 0.4, 8, 'tap');
  for (const e of S.eff.rockets) assert.ok(e.x1 >= 0.3 - 1e-9 && e.y1 >= 0.3 - 1e-9 && e.x1 <= S.w && e.y1 <= S.h, 'aim inside the map');
});

section('aim bias: rockets lean toward units / buildings inside the circle (statistically)', () => {
  const ctx = mkCtx();
  const { S, Powers } = ctx;
  arena(ctx, 48, 48, 20);
  const spots = [];
  for (let i = 0; i < 8; i++) spots.push([48.5 + Math.cos(i * 0.785 + 0.3) * 3.6, 48.5 + Math.sin(i * 0.785 + 0.3) * 3.6]);
  const nearest = (x, y, pts) => Math.min(...pts.map(p => dist(x, y, p[0], p[1])));
  const mean = (pts) => {
    let sum = 0, n = 0;
    for (let k = 0; k < 60; k++) { clearSky(ctx); Powers.apply('rocket', 48.5, 48.5, 6, 'tap'); for (const e of S.eff.rockets.slice(1)) { sum += nearest(e.x1, e.y1, pts); n++; } }
    return sum / n;
  };
  const control = mean(spots);                                         // nothing there: plain scatter
  for (const [x, y] of spots) ctx.Units.spawn(0, x, y, {});             // eight creatures inside the circle (r = 6 -> 4.8 + 0.5)
  const withUnits = mean(spots);
  for (const u of [...S.units.values()]) ctx.Units.kill(u, 'test');
  const c = mkCity(ctx, 40, 40, 2);                                     // buildings count as targets as well
  const bpts = [];
  for (let i = 0; i < 8; i++) { const x = Math.floor(48.5 + Math.cos(i * 0.785 + 0.3) * 3.6), y = Math.floor(48.5 + Math.sin(i * 0.785 + 0.3) * 3.6); if (house(ctx, c.id, x, y)) bpts.push([x + 0.5, y + 0.5]); }
  assert.ok(bpts.length >= 6, 'houses placed: ' + bpts.length);
  for (const u of [...S.units.values()]) ctx.Units.kill(u, 'test');
  const withB = mean(bpts), controlB = mean(bpts.map(([x, y]) => [x + 30, y + 30]).map(([x, y]) => [x - 60, y - 60]));
  note(`mean distance of an aim point to the nearest spot: nothing ${control.toFixed(2)} | 8 units ${withUnits.toFixed(2)} | 8 houses ${withB.toFixed(2)}`);
  assert.ok(withUnits < control * 0.85, 'units attract the volley: ' + withUnits.toFixed(2) + ' vs ' + control.toFixed(2));
  assert.ok(withB < control * 0.85, 'houses attract the volley: ' + withB.toFixed(2) + ' vs ' + control.toFixed(2));
  // but it is only a lean: without a target within 3 tiles the scatter is plain uniform (a lone unit far from the disc changes nothing)
  const far = mkCtx(); arena(far, 48, 48, 20); far.Units.spawn(0, 48.5 + 5.9, 48.5, {});
  let maxD = 0; for (let k = 0; k < 40; k++) { clearSky(far); far.Powers.apply('rocket', 48.5, 48.5, 2, 'tap'); for (const e of far.S.eff.rockets) maxD = Math.max(maxD, dist(e.x1, e.y1, 48.5, 48.5)); }
  assert.ok(maxD <= 0.8 * 2 + 0.4, 'a unit outside the magnet range does not stretch the volley: ' + maxD.toFixed(2));
});

section('launch rule: the NEAREST map edge (S, N, W, E), the whole salvo from one battery just beyond it', () => {
  const ctx = mkCtx();
  const { S, Powers, PowerRocket } = ctx;
  const cases = [
    { at: [48.5, 80.5], edge: 3, inside: (e) => e.y0 > S.h + 1 && e.y0 < S.h + 4.1 },
    { at: [48.5, 10.5], edge: 1, inside: (e) => e.y0 < -1 && e.y0 > -4.1 },
    { at: [8.5, 48.5], edge: 0, inside: (e) => e.x0 < -1 && e.x0 > -4.1 },
    { at: [88.5, 48.5], edge: 2, inside: (e) => e.x0 > S.w + 1 && e.x0 < S.w + 4.1 },
  ];
  for (const c of cases) {
    assert.equal(PowerRocket.nearestEdge(c.at[0], c.at[1]), c.edge);
    clearSky(ctx);
    assert.equal(Powers.apply('rocket', c.at[0], c.at[1], 6, 'tap'), true);
    const L = S.eff.rockets;
    for (const e of L) assert.ok(c.inside(e), `edge ${c.edge}: launch point ${e.x0},${e.y0}`);
    const along = L.map(e => (c.edge === 1 || c.edge === 3) ? e.x0 : e.y0), tap = (c.edge === 1 || c.edge === 3) ? c.at[0] : c.at[1];
    assert.ok(Math.max(...along) - Math.min(...along) < 14, 'a compact battery');
    assert.ok(Math.abs(along.reduce((a, b) => a + b, 0) / along.length - tap) < 4, 'centred on the tap');
  }
  // ties: south wins, then north, west, east
  assert.equal(PowerRocket.nearestEdge(48, 48), 3);
  assert.equal(PowerRocket.nearestEdge(30, 30), 1);   // N and W tie -> north
  assert.equal(PowerRocket.nearestEdge(40, 30), 1);
  assert.equal(PowerRocket.nearestEdge(10, 40), 0);
  assert.equal(PowerRocket.nearestEdge(86, 40), 2);
});

// ================================================================== timing
section('timing: flight 14..26 ticks (longer for far targets), launch stagger 0..10 with one at 0, impact exactly at eta, x/y refreshed every tick', () => {
  const ctx = mkCtx();
  const { S, Powers, PowerRocket } = ctx;
  arena(ctx, 48, 48, 20);
  let minDur = 99, maxDur = 0, minSt = 99, maxSt = -1;
  for (let k = 0; k < 30; k++) {
    clearSky(ctx);
    Powers.apply('rocket', 20 + (k % 6) * 11, 15 + (k % 5) * 16, 1 + (k % 8), 'tap');
    const L = S.eff.rockets;
    assert.equal(L.filter(e => e.t0 === S.tick).length >= 1, true, 'the first rocket flies at once');
    for (const e of L) { minDur = Math.min(minDur, e.eta - e.t0); maxDur = Math.max(maxDur, e.eta - e.t0); minSt = Math.min(minSt, e.t0 - S.tick); maxSt = Math.max(maxSt, e.t0 - S.tick); }
  }
  assert.ok(minDur >= 14 && maxDur <= 26, `durations ${minDur}..${maxDur}`);
  assert.ok(maxDur >= 24 && minDur <= 15, 'the whole range is used');
  assert.ok(minSt === 0 && maxSt <= 10 && maxSt >= 9, `stagger ${minSt}..${maxSt}`);
  // near vs far target
  const dur = (x, y) => { clearSky(ctx); Powers.apply('rocket', x, y, 1, 'tap'); return S.eff.rockets.reduce((a, e) => a + e.eta - e.t0, 0) / S.eff.rockets.length; };
  const near = dur(48.5, 90.5), far = dur(48.5, 48.5);
  assert.ok(far > near + 5, `a farther target takes longer: ${near.toFixed(1)} vs ${far.toFixed(1)}`);
  // impact exactly at eta; position tracks PowerRocket.path every tick; monotone approach
  clearSky(ctx);
  Powers.apply('rocket', 48.5, 60.5, 5, 'tap');
  const track = S.eff.rockets.map(e => ({ e, land: -1, d0: dist(e.x0, e.y0, e.x1, e.y1), lastD: 1e9, mono: true }));
  const out = { x: 0, y: 0 };
  for (let i = 0; i < 40; i++) {
    stepN(ctx, 1); ctx.Fx.update(0.1);
    for (const t of track) {
      if (t.land >= 0) continue;
      if (!S.eff.rockets.includes(t.e)) { t.land = S.tick; continue; }
      PowerRocket.path(t.e, S.tick, out);
      assert.ok(Math.abs(t.e.x - out.x) < 0.001 && Math.abs(t.e.y - out.y) < 0.001, 'x,y follow the path every tick');
      const d = dist(t.e.x, t.e.y, t.e.x1, t.e.y1);
      if (d > t.lastD + 1e-6) t.mono = false;
      t.lastD = d;
      if (S.tick < t.e.t0) assert.ok(dist(t.e.x, t.e.y, t.e.x0, t.e.y0) < 1e-6, 'waits at the launch point');
    }
  }
  for (const t of track) { assert.equal(t.land, t.e.eta, 'lands in the step of its eta'); assert.ok(t.mono, 'monotone approach'); }
  assert.equal(S.eff.rockets.length, 0, 'sky is clear');
  assert.ok(fxCount(ctx, 'rocket_launch') >= 0);
  // path endpoints
  const e = { x0: 10, y0: 100, x1: 30, y1: 40, t0: 100, eta: 120, b: 0.05, h: 3 };
  PowerRocket.path(e, 100, out); assert.ok(Math.abs(out.x - 10) < 1e-9 && Math.abs(out.y - 100) < 1e-9 && out.alt === 0);
  PowerRocket.path(e, 120, out); assert.ok(Math.abs(out.x - 30) < 1e-9 && Math.abs(out.y - 40) < 1e-9 && Math.abs(out.alt) < 1e-9);
  PowerRocket.path(e, 50, out); assert.equal(out.x, 10);
  PowerRocket.path(e, 999, out); assert.equal(out.x, 30);
  PowerRocket.path(e, 110, out); assert.ok(out.alt > 1 && out.u === 0.5);
});

// ================================================================== impact
section('impact on creatures: lethal core, falloff, nobody outside 1.8, survivors shoved outwards, close ones burn', () => {
  const ctx = mkCtx();
  const { S, Units } = ctx;
  arena(ctx, 48, 48, 12);
  const cx = 48.5, cy = 48.5;
  const ds = [0, 0.4, 0.75, 1.0, 1.25, 1.5, 1.7, 1.85, 2.5];
  const us = ds.map((d, i) => { const a = i * 0.9; return { d, u: dummy(ctx, i % 3, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 200) }; });
  const pos0 = us.map(o => ({ x: o.u.x, y: o.u.y }));
  boom(ctx, cx, cy);
  for (let i = 0; i < us.length; i++) {
    const { d, u } = us[i], lost = 200 - u.hp, want = ctx.PowerRocket.unitDamage(d);
    if (d >= 1.8) { assert.equal(u.hp, 200, `d=${d} untouched`); assert.ok(Math.abs(u.x - pos0[i].x) < 1e-9, 'not shoved'); continue; }
    assert.ok(Math.abs(lost - want) < 1e-6, `d=${d}: lost ${lost.toFixed(2)} want ${want.toFixed(2)}`);
    if (d <= 1.2 && d > 0.0) assert.ok(u.burning > S.tick, `d=${d} burning`);
    if (d >= 0.3) { const moved = dist(u.x, u.y, pos0[i].x, pos0[i].y); assert.ok(moved > 0.2 && dist(u.x, u.y, cx, cy) > d, `d=${d} thrown outwards (moved ${moved.toFixed(2)})`); }
  }
  note('damage by distance: ' + ds.map(d => d + ':' + ctx.PowerRocket.unitDamage(d).toFixed(0)).join('  '));
  assert.ok(ctx.PowerRocket.unitDamage(0) >= 90 && ctx.PowerRocket.unitDamage(0.75) >= 90 && ctx.PowerRocket.unitDamage(1.25) > 25 && ctx.PowerRocket.unitDamage(1.7) < 8);
  // normal units: everything in the core dies, the outskirts survive
  const ctx2 = mkCtx(); arena(ctx2, 48, 48, 12);
  const core = [], rim = [];
  for (let i = 0; i < 12; i++) { core.push(ctx2.Units.spawn(i % 3, 48.5 + Math.cos(i) * 0.55, 48.5 + Math.sin(i) * 0.55, { age: 25 })); rim.push(ctx2.Units.spawn(i % 3, 48.5 + Math.cos(i) * 1.65, 48.5 + Math.sin(i) * 1.65, { age: 25 })); }
  boom(ctx2, 48.5, 48.5);
  assert.ok(core.every(u => !ctx2.S.units.has(u.id)), 'the core is lethal for every race');
  assert.ok(rim.filter(u => ctx2.S.units.has(u.id)).length >= 11, 'the rim survives: ' + rim.filter(u => ctx2.S.units.has(u.id)).length + '/12');
  assert.ok(ctx2.deaths.filter(d => d.cause === 'rocket').length === 12 + rim.filter(u => !ctx2.S.units.has(u.id)).length, 'death cause "rocket"');
});

section('impact on buildings: heavy falloff damage, sturdy ones survive one hit and fall to two, far ones untouched', () => {
  const ctx = mkCtx();
  const { S, Buildings, Const } = ctx;
  arena(ctx, 48, 48, 12);
  const c = mkCity(ctx, 40, 40, 2);
  const B = Const.B;
  const mk = (t, x, y) => Buildings.place(c.id, t, x, y, { instant: true });
  const near = mk(B.HOUSE, 48, 48), mid = mk(B.STORAGE, 49, 49), edge = mk(B.HOUSE, 49, 50), far = mk(B.HOUSE, 52, 48), farm = mk(B.FARM, 47, 49);
  const hall = mk(B.TOWNHALL, 46, 46), temple = mk(B.TEMPLE, 50, 46);
  assert.ok(near && mid && edge && far && farm && hall && temple, 'buildings placed');
  const hp0 = (b) => b.hp;
  const ids = { near: near.id, mid: mid.id, edge: edge.id, far: far.id, farm: farm.id, hall: hall.id, temple: temple.id };
  boom(ctx, 48.5, 48.5);
  assert.ok(!S.buildings.has(ids.near), 'house under the rocket destroyed');
  assert.ok(!S.buildings.has(ids.farm), 'farm one tile away destroyed');
  assert.ok(S.buildings.has(ids.far) && S.buildings.get(ids.far).hp === S.buildings.get(ids.far).maxHp, 'a house 3.5 tiles away is untouched');
  // sturdy ones: hit directly twice
  boom(ctx, 46.5, 46.5);
  const h1 = S.buildings.get(ids.hall);
  assert.ok(h1 && h1.hp < h1.maxHp * 0.5, 'a town hall survives one direct hit badly damaged: ' + (h1 && h1.hp));
  boom(ctx, 46.5, 46.5);
  assert.ok(!S.buildings.has(ids.hall), 'two direct hits raze the town hall');
  boom(ctx, 50.5, 46.5);
  assert.ok(!S.buildings.has(ids.temple), 'a temple (140 hp) falls to one direct hit');
  note('house at the centre, farm 1 tile away, storage, temple, town hall: handled; far house hp intact');
});

section('impact on the ground: forest felled in the core, lone trees cleared, ~45% of land tiles ignite, mountains / snow / water untouched', () => {
  const ctx = mkCtx();
  const { S, T, World } = Object.assign({}, ctx, { T: ctx.Const.T });
  arena(ctx, 48, 48, 12, T.FOREST);
  for (let y = 36; y <= 60; y++) for (let x = 36; x <= 60; x++) { S.amt[y * S.w + x] = 120; }
  boom(ctx, 48.5, 48.5);
  const w = S.w;
  let felled = 0, kept = 0, burning = 0, inBlast = 0;
  for (let y = 44; y <= 52; y++) for (let x = 44; x <= 52; x++) {
    const d = dist(x + 0.5, y + 0.5, 48.5, 48.5), i = y * w + x;
    if (d <= 1.0) { assert.notEqual(S.tile[i], T.FOREST, `forest at d=${d.toFixed(2)} felled`); felled++; }
    else if (d > 1.8) assert.equal(S.fire[i], 0, 'nothing burns outside the blast at once');
    if (d > 1.0 && d <= 1.8) { assert.equal(S.tile[i], T.FOREST, 'forest outside the core stays'); kept++; }
    if (d <= 1.8) { inBlast++; if (S.fire[i] > 0) burning++; }
  }
  assert.ok(felled >= 3 && kept >= 3, `felled ${felled} kept ${kept}`);
  // statistics: 150 impacts on bare grass: ignition share inside the blast
  const g = mkCtx(); arena(g, 48, 48, 14, g.Const.T.GRASS);
  let tiles = 0, lit = 0;
  for (let k = 0; k < 150; k++) {
    for (let i = 0; i < g.S.fire.length; i++) g.S.fire[i] = 0;
    const cx = 44.5 + (k % 5) * 0.37, cy = 44.5 + ((k / 5) | 0) % 6 * 0.41;
    boom(g, cx, cy);
    for (let y = 40; y <= 50; y++) for (let x = 40; x <= 50; x++) if (dist(x + 0.5, y + 0.5, cx, cy) <= 1.8) { tiles++; if (g.S.fire[y * g.S.w + x] > 0) lit++; }
  }
  const p = lit / tiles;
  note(`ignition share ${(p * 100).toFixed(1)} % of ${tiles} grass tiles inside the blast (target 45 %)`);
  assert.ok(p > 0.38 && p < 0.52, 'about 45 %');
  // lone trees / berries
  const t2 = mkCtx(); arena(t2, 48, 48, 8, t2.Const.T.GRASS);
  t2.S.res[48 * 96 + 48] = t2.Const.RES.TREE; t2.S.amt[48 * 96 + 48] = 80; t2.S.res[48 * 96 + 49] = t2.Const.RES.BERRY; t2.S.amt[48 * 96 + 49] = 5; t2.S.res[48 * 96 + 53] = t2.Const.RES.TREE; t2.S.amt[48 * 96 + 53] = 80;
  boom(t2, 48.5, 48.5);
  assert.equal(t2.S.res[48 * 96 + 48], 0); assert.equal(t2.S.res[48 * 96 + 49], 0); assert.equal(t2.S.res[48 * 96 + 53], t2.Const.RES.TREE, 'a tree 5 tiles away stays');
  // mountains / snow / lava / water: not changed, not burning, rocket still harmless to them
  const m = mkCtx();
  arena(m, 48, 48, 6, m.Const.T.MOUNTAIN);
  for (let x = 40; x <= 46; x++) for (let y = 44; y <= 52; y++) m.World.setTile(x, y, m.Const.T.SNOW);
  for (let x = 51; x <= 56; x++) for (let y = 44; y <= 52; y++) m.World.setTile(x, y, m.Const.T.LAVA);
  const before = Array.from(m.S.tile);
  boom(m, 48.5, 48.5); boom(m, 45.5, 48.5); boom(m, 53.5, 48.5);
  assert.deepEqual(Array.from(m.S.tile), before, 'terrain of mountains / snow / lava is untouched');
  assert.equal(m.World.fireCount(), 0, 'no fire on rock');
  step(m, 5);
});

section('impact in water: splash, no fire, creatures in the blast still hurt, no exception; at the very edge of the map too', () => {
  const ctx = mkCtx();
  const { S, Const } = ctx;
  arena(ctx, 48, 48, 10, Const.T.DEEP);
  for (let x = 46; x <= 50; x++) ctx.World.setTile(x, 48, Const.T.GRASS);
  const u = ctx.Units.spawn(0, 48.5, 48.5, { age: 25 }); u.maxHp = u.hp = 100;
  const before = ctx.Fx.list.length;
  boom(ctx, 44.5, 48.5);
  assert.ok(fxCount(ctx, 'splash') >= 1 && fxCount(ctx, 'rocket_boom') === 1, 'splash + burst');
  assert.equal(ctx.Fx.list.find(f => f.type === 'rocket_boom').w, 1, 'burst is flagged as a water hit');
  assert.equal(fxCount(ctx, 'rocket_smoke'), 0, 'no smoke column over water');
  assert.equal(ctx.World.fireCount(), 0);
  boom(ctx, 49.5, 48.5);                                              // lands next to the unit (on the strip of land): hurts, ignition possible on the strip
  assert.ok(!S.units.has(u.id) || u.hp < 100, 'a creature on the shore is hurt');
  for (const [x, y] of [[0.3, 0.3], [95.7, 95.7], [0.3, 95.7], [95.7, 0.3], [48, 0.2], [0.2, 48]]) assert.doesNotThrow(() => boom(ctx, x, y), `edge ${x},${y}`);
  assert.equal(ctx.Powers.errors, 0, String(ctx.Powers.lastError && ctx.Powers.lastError.stack));
});

section('crowd: 150 creatures + 40 houses in the blast area -> casualties by distance, cost per impact stays small', () => {
  // (timing on a shared machine: up to 3 identical worlds, the fastest impact counts)
  let best = 1e9, dead = 0, razed = 0, n0 = 0;
  for (let k = 0; k < 3 && best >= 8; k++) {
    const ctx = mkCtx();
    const { S } = ctx;
    arena(ctx, 48, 48, 14);
    const c = mkCity(ctx, 40, 40, 2);
    for (let i = 0; i < 40; i++) house(ctx, c.id, 44 + (i % 8), 44 + ((i / 8) | 0));
    for (let i = 0; i < 150; i++) { const a = i * 2.39996, d = Math.sqrt((i + 0.5) / 150) * 3.2; const u = ctx.Units.spawn(i % 3, 48.5 + Math.cos(a) * d, 48.5 + Math.sin(a) * d, { age: 25 }); assert.ok(u); }
    n0 = S.units.size; const b0 = S.buildings.size;
    const t0 = performance.now();
    boom(ctx, 48.5, 48.5);
    best = Math.min(best, performance.now() - t0);
    dead = n0 - S.units.size; razed = b0 - S.buildings.size;
    assert.equal(ctx.Powers.errors, 0);
  }
  note(`one impact on a crowd: ${dead} creatures dead of ${n0}, ${razed} buildings razed, ${best.toFixed(2)} ms`);
  assert.ok(dead > 10 && dead < n0, 'casualties inside the blast only');
  assert.ok(razed >= 5, 'houses razed');
  assert.ok(best < 8, 'an impact is cheap: ' + best.toFixed(2) + ' ms');
});

// ================================================================== caps, cooldown, merge, log
section('launcher cooldown 12 ticks («перезаряжаются»), rocket cap 54, nothing silently lost', () => {
  const ctx = mkCtx();
  const { S, Powers } = ctx;
  arena(ctx, 48, 48, 14);
  assert.equal(Powers.apply('rocket', 48.5, 48.5, 3, 'tap'), true);
  const t0 = S.tick;
  assert.equal(S.mod.rocket.cd, t0 + 12);
  for (let i = 0; i < 11; i++) {
    assert.equal(Powers.apply('rocket', 48.5, 48.5, 3, 'tap'), false, 'tick +' + i);
    assert.equal(Powers.lastMessage, 'Пусковые устройства перезаряжаются');
    S.tick++;
  }
  assert.equal(S.tick, t0 + 11);
  assert.equal(Powers.apply('rocket', 48.5, 48.5, 3, 'tap'), false, 'still reloading at +11');
  S.tick++;
  assert.equal(Powers.apply('rocket', 48.5, 48.5, 3, 'tap'), true, 'ready at +12');
  assert.equal(S.eff.rockets.length, 12);
  // cap: 54 rockets alive at once
  clearSky(ctx);
  let fired = 0, n;
  for (let k = 0; k < 10; k++) { S.mod.rocket.cd = 0; if (Powers.apply('rocket', 48.5, 48.5, 8, 'tap')) fired += 9; else break; }
  assert.equal(fired, 54); assert.equal(S.eff.rockets.length, 54);
  S.mod.rocket.cd = 0;
  assert.equal(Powers.apply('rocket', 48.5, 48.5, 1, 'tap'), false); assert.equal(Powers.lastMessage, 'Небо уже в огне');
  assert.equal(S.eff.rockets.length, 54, 'a refused salvo adds nothing');
  // wrong phases / bad input
  clearSky(ctx);
  for (const ph of ['move', 'end', 'weird', undefined]) assert.equal(Powers.apply('rocket', 48.5, 48.5, 3, ph), ph === undefined ? true : false, 'phase ' + ph);
  clearSky(ctx);
  for (const [x, y] of [[-1, 5], [5, -1], [96, 5], [5, 96], [NaN, 4], [4, NaN], [Infinity, 4], ['a', 'b'], [undefined, undefined]]) {
    assert.equal(Powers.apply('rocket', x, y, 3, 'tap'), false, `${x},${y} refused`); assert.ok(Powers.lastMessage.length > 0);
  }
  assert.equal(S.eff.rockets.length, 0);
  assert.equal(Powers.errors, 0);
});

section('merge: the 4th and later impacts of one tick make ONE bigger burst, every impact still applies its damage', () => {
  const ctx = mkCtx();
  const { S, Powers, PowerRocket } = ctx;
  arena(ctx, 48, 48, 20);
  const spots = [];
  for (let i = 0; i < 12; i++) spots.push([30 + (i % 4) * 9, 36 + ((i / 4) | 0) * 9]);
  const us = spots.map(([x, y]) => dummy(ctx, 0, x, y, 30));
  const eta = S.tick + 1;
  for (const [x, y] of spots) inject(ctx, x, y, eta);
  S.tick++;
  ctx.Fx.clear();
  PowerRocket.step(S.tick, Powers.host);
  assert.ok(us.every(u => !S.units.has(u.id)), 'all 12 impacts killed their creature');
  const booms = ctx.Fx.list.filter(f => f.type === 'rocket_boom');
  assert.equal(booms.length, 4, 'three full bursts + one merged');
  assert.equal(booms.filter(f => f.m === 1).length, 3); assert.equal(booms.filter(f => f.m > 1).length, 1);
  assert.equal(booms.find(f => f.m > 1).m, 9, 'the merged burst counts its 9 impacts');
  assert.equal(fxCount(ctx, 'rocket_smoke'), 3, 'smoke columns only for the full bursts');
  assert.equal(fxCount(ctx, 'shake'), 1, 'one camera shake per tick');
  assert.ok(ctx.Fx.list.length < 16, 'Fx entries per tick stay small: ' + ctx.Fx.list.length);
  assert.equal(S.eff.rockets.length, 0);
});

section('Fx caps: a barrage never piles up more than 14 smoke columns / 18 lingering trails / 40 bursts; the burst itself is always shown', () => {
  const ctx = mkCtx();
  const { S, Fx, PowerRocket } = ctx;
  arena(ctx, 48, 48, 20);
  const P = PowerRocket.params;
  assert.deepEqual([P.SMOKE_CAP, P.TRAIL_CAP, P.BOOM_CAP], [14, 18, 40]);
  // below the caps: every full burst brings its smoke column and trail
  boom(ctx, 40.5, 40.5);
  assert.equal(fxCount(ctx, 'rocket_boom'), 1); assert.equal(fxCount(ctx, 'rocket_smoke'), 1); assert.equal(fxCount(ctx, 'rocket_trail'), 1);
  // at the caps: the burst still comes, the optional extras do not
  Fx.clear();
  for (let i = 0; i < 14; i++) Fx.add('rocket_smoke', 10 + i, 10, { ttl: 2.3 });
  for (let i = 0; i < 18; i++) Fx.add('rocket_trail', 10 + i, 12, { ttl: 0.9 });
  boom(ctx, 50.5, 50.5);
  assert.equal(fxCount(ctx, 'rocket_boom'), 1, 'the burst is always drawn');
  assert.equal(fxCount(ctx, 'rocket_smoke'), 14, 'no 15th smoke column'); assert.equal(fxCount(ctx, 'rocket_trail'), 18, 'no 19th trail');
  // one tick with 12 impacts at the caps: still 3 full bursts + 1 merged, nothing else piles up
  Fx.clear();
  for (let i = 0; i < 14; i++) Fx.add('rocket_smoke', 10 + i, 10, { ttl: 2.3 });
  for (let i = 0; i < 18; i++) Fx.add('rocket_trail', 10 + i, 12, { ttl: 0.9 });
  const eta = S.tick + 1;
  for (let i = 0; i < 12; i++) inject(ctx, 30 + (i % 4) * 5, 30 + ((i / 4) | 0) * 5, eta);
  S.tick++; PowerRocket.step(S.tick, ctx.Powers.host);
  assert.equal(fxCount(ctx, 'rocket_boom'), 4); assert.equal(fxCount(ctx, 'rocket_smoke'), 14); assert.equal(fxCount(ctx, 'rocket_trail'), 18);
  // the burst cap
  Fx.clear();
  for (let i = 0; i < 40; i++) Fx.add('rocket_boom', 5 + (i % 30), 5 + ((i / 30) | 0), { ttl: 1 });
  boom(ctx, 60.5, 60.5);
  assert.equal(fxCount(ctx, 'rocket_boom'), 40, 'bursts are capped as well');
  assert.equal(ctx.Powers.errors, 0);
});

section('log: ONE aggregated line per salvo (>= 3 dead or >= 2 buildings razed), a line for a killed ruler, silence otherwise', () => {
  const quiet = mkCtx();
  arena(quiet, 48, 48, 14);
  quiet.Powers.apply('rocket', 48.5, 48.5, 5, 'tap');
  step(quiet, 50);
  assert.equal(quiet.S.log.filter(l => /Ракетный залп/.test(l.msg)).length, 0, 'an empty field: nothing to report');
  const ctx = mkCtx();
  const { S, Powers } = ctx;
  arena(ctx, 48, 48, 14);
  const c = mkCity(ctx, 46, 46, 2);
  for (let i = 0; i < 10; i++) house(ctx, c.id, 44 + (i % 5) * 2, 44 + ((i / 5) | 0) * 2);
  for (let i = 0; i < 14; i++) ctx.Units.spawn(i % 3, 47 + (i % 7) * 0.5, 47 + ((i / 7) | 0) * 0.8, { age: 25 });
  const n0 = S.log.length;
  Powers.apply('rocket', 48.5, 48.5, 6, 'tap');
  step(ctx, 50);
  const lines = S.log.filter(l => /Ракетный залп/.test(l.msg));
  assert.equal(lines.length, 1, 'exactly one aggregated line: ' + lines.map(l => l.msg).join(' | '));
  assert.ok(/погибло: \d+/.test(lines[0].msg) || /разрушено построек: \d+/.test(lines[0].msg));
  assert.equal(lines[0].kind, ctx.Const.LOG.DISASTER);
  assert.ok(S.log.length - n0 <= 14, 'no log spam: ' + (S.log.length - n0) + ' lines');
  note(lines[0].msg);
  // a ruler is killed: one dedicated line
  const king = [...S.units.values()].find(u => u.isRuler);
  if (king) {
    const k = S.kingdoms.get(king.kingdomId);
    arena(ctx, 70, 70, 4);
    king.x = 70.5; king.y = 70.5; king.px = king.x; king.py = king.y; ctx.Units.rebuildGrid();
    const nl = S.log.length;
    boom(ctx, 70.5, 70.5);
    const rl = S.log.slice(nl).filter(l => /ракетным ударом/.test(l.msg));
    assert.equal(rl.length, 1, 'ruler line'); assert.ok(rl[0].msg.indexOf(king.name) >= 0 && (!k || rl[0].msg.indexOf(k.name) >= 0));
    note(rl[0].msg);
  } else note('(no ruler in this world: ruler line not exercised)');
});

// ================================================================== determinism, save, chaos
section('JSON-safety: S.eff / S.mod stay identical after a JSON round trip, afterLoad repairs damaged entries, new worlds are clean', () => {
  const ctx = mkCtx();
  const { S, Powers, PowerRocket } = ctx;
  arena(ctx, 48, 48, 14);
  Powers.apply('rocket', 48.5, 48.5, 8, 'tap');
  step(ctx, 7);
  jsonSafe(S.eff, 'eff'); jsonSafe(S.mod, 'mod'); finiteDeep(S.eff, 'eff');
  // damaged entries
  S.eff.rockets.push({ nonsense: 1 }, null, { x0: NaN, y0: 1, x1: 2, y1: 3, t0: 1, eta: 2 }, { x0: 1, y0: 1, x1: 2, y1: 3, t0: 5, eta: 2 });
  S.eff.rockets.push({ x0: 1, y0: 1, x1: 2, y1: 3, t0: S.tick - 3, eta: S.tick + 5 });
  PowerRocket.afterLoad();
  assert.ok(S.eff.rockets.every(e => Number.isFinite(e.x) && Number.isFinite(e.b) && e.h > 0 && (e.l === 0 || e.l === 1)), 'repaired');
  assert.equal(S.eff.rockets.length, 9 - 0 + 1 - (7 > 0 ? S.eff.rockets.length - 10 : 0) || true);
  assert.doesNotThrow(() => step(ctx, 40));
  // a fresh world has no rocket state at all (nothing is created until the first volley)
  const w = mkCtx(9);
  assert.equal(w.S.eff.rockets, undefined); assert.equal(w.S.mod.rocket, undefined);
  step(w, 30);
  assert.equal(w.S.eff.rockets, undefined); assert.equal(w.S.mod.rocket, undefined, 'idle plugin leaves no trace');
  assert.equal(w.Powers.errors, 0);
});

section('save / load in the middle of a salvo: the continuation is identical (rockets, impacts, damage, log, RNG)', () => {
  const ctx = mkCtx(5);
  ctx.Sim.populate && ctx.Sim.populate();
  step(ctx, 500);
  const c = [...ctx.S.cities.values()][0] || { x: 48, y: 48 };
  ctx.Powers.apply('rocket', c.x + 0.5, c.y + 0.5, 7, 'tap');
  step(ctx, 9);
  ctx.S.mod.rocket.cd = 0;
  ctx.Powers.apply('rocket', c.x + 3.5, c.y - 2.5, 4, 'tap');
  step(ctx, 4);
  assert.ok(ctx.S.eff.rockets.length >= 8, 'rockets in the air at the save: ' + ctx.S.eff.rockets.length);
  const landed0 = ctx.deaths.filter(d => d.cause === 'rocket').length;
  const json = ctx.Save.serialize();
  const ctx2 = loadSim();
  assert.ok(ctx2.Save.deserialize(json), 'deserialize');
  assert.deepEqual(ctx2.S.eff.rockets, ctx.S.eff.rockets, 'rockets survive the save');
  assert.deepEqual(ctx2.S.mod.rocket, ctx.S.mod.rocket, 'S.mod.rocket survives the save');
  for (let t = 0; t < 70; t++) {
    stepN(ctx, 1); stepN(ctx2, 1);
    if (t % 7 === 0 || t === 69) {
      assert.equal(JSON.stringify(ctx.S.eff), JSON.stringify(ctx2.S.eff), 'S.eff identical at +' + t);
      assert.equal(JSON.stringify(ctx.S.mod.rocket), JSON.stringify(ctx2.S.mod.rocket), 'S.mod.rocket identical at +' + t);
      assert.equal(ctx.R.getState(), ctx2.R.getState(), 'RNG state identical at +' + t);
      assert.equal(ctx.S.units.size, ctx2.S.units.size, 'population identical at +' + t);
    }
  }
  assert.equal(JSON.stringify([...ctx.S.units.values()]), JSON.stringify([...ctx2.S.units.values()]), 'every unit identical');
  assert.equal(JSON.stringify(ctx.S.log.slice(-20)), JSON.stringify(ctx2.S.log.slice(-20)), 'log identical');
  assert.equal(ctx.S.eff.rockets.length, 0, 'everything landed');
  note(`${ctx.deaths.filter(d => d.cause === 'rocket').length - landed0} creatures killed after the save point; both worlds identical over 70 ticks`);
  // a second salvo after the load behaves identically as well (apply uses sorted candidates, not the grid order)
  ctx.S.mod.rocket.cd = 0; ctx2.S.mod.rocket.cd = 0;
  ctx.Powers.apply('rocket', c.x + 1.5, c.y + 1.5, 6, 'tap'); ctx2.Powers.apply('rocket', c.x + 1.5, c.y + 1.5, 6, 'tap');
  assert.equal(JSON.stringify(ctx.S.eff.rockets), JSON.stringify(ctx2.S.eff.rockets), 'a salvo fired after the load aims identically');
  step(ctx, 40); step(ctx2, 40);
  assert.equal(JSON.stringify(ctx.S.eff), JSON.stringify(ctx2.S.eff)); assert.equal(ctx.R.getState(), ctx2.R.getState());
});

section('chaos: 3000 ticks, rockets mixed with every other power (random taps, radii, phases, bad coordinates): no exceptions, caps, JSON-safe', () => {
  const ctx = mkCtx(5);
  const { S, Powers, ToolDefs, Const } = ctx;
  step(ctx, 300);
  let rs = 987654;
  const rnd = () => { rs = (Math.imul(rs, 1664525) + 1013904223) | 0; return (rs >>> 0) / 4294967296; };
  const ids = ToolDefs.map(t => t.id), phases = ['tap', 'tap', 'start', 'move', 'end'];
  const cities = () => [...S.cities.values()];
  let fired = 0, maxAir = 0, x = 48, y = 48;
  const errs0 = ctx.Sim.errors ? JSON.stringify(ctx.Sim.errors) : '';
  for (let tk = 0; tk < 3000; tk++) {
    const k = (rnd() * 3) | 0;
    for (let j = 0; j <= k; j++) {
      const rocket = rnd() < 0.35, id = rocket ? 'rocket' : ids[(rnd() * ids.length) | 0];
      if (rnd() < 0.7) { x = Math.max(-3, Math.min(S.w + 3, x + (rnd() - 0.5) * 8)); y = Math.max(-3, Math.min(S.h + 3, y + (rnd() - 0.5) * 8)); }
      else { const cs = cities(); if (cs.length && rnd() < 0.6) { const c = cs[(rnd() * cs.length) | 0]; x = c.x + 0.5; y = c.y + 0.5; } else { x = rnd() * S.w; y = rnd() * S.h; } }
      if (Powers.apply(id, x, y, 1 + ((rnd() * 8) | 0), phases[(rnd() * phases.length) | 0]) && id === 'rocket') fired++;
    }
    stepN(ctx, 1); ctx.Fx.update(0.1);
    if (S.eff.rockets) maxAir = Math.max(maxAir, S.eff.rockets.length);
    assert.ok(!S.eff.rockets || S.eff.rockets.length <= 54, 'cap at tick ' + tk);
    if (tk % 500 === 0) { jsonSafe(S.eff, 'eff@' + tk); jsonSafe(S.mod, 'mod@' + tk); }
    assert.ok(ctx.Fx.list.length <= 401, 'Fx list bounded: ' + ctx.Fx.list.length);
  }
  step(ctx, 100);
  assert.equal(Powers.errors, 0, String(Powers.lastError && Powers.lastError.stack));
  jsonSafe(S.eff, 'eff end'); jsonSafe(S.mod, 'mod end'); finiteDeep(S.eff, 'eff');
  for (const u of S.units.values()) assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y) && u.x >= 0 && u.y >= 0 && u.x < S.w && u.y < S.h && Number.isFinite(u.hp), 'unit sane');
  for (let i = 0; i < S.tile.length; i++) assert.ok(S.tile[i] < Const.TILE_COUNT);
  assert.ok(S.log.length <= 300);
  assert.equal(S.eff.rockets.length, 0, 'sky clear at the end');
  assert.ok(fired > 100, 'rockets were really fired: ' + fired);
  note(`${fired} salvos fired, max ${maxAir} rockets in the air, ${ctx.deaths.filter(d => d.cause === 'rocket').length} creatures killed by rockets, ${S.units.size} alive, ${S.cities.size} cities`);
});

// ================================================================== performance
// ================================================================== graphics (DOM-free baking)
section('graphics plugin: registrations, every baked sprite / frame has content and is not clipped by its canvas, headings and colours are right', () => {
  // the gfx file is client code: load it into the sim scope next to the sim files (its baking works on plain pixel buffers, only PB.toCanvas touches the DOM)
  const srcDir = path.join(root, 'src');
  const files = fs.readdirSync(srcDir).filter(f => /^\d\d_.*\.js$/.test(f) && (parseInt(f.slice(0, 2), 10) < 20 || f === '31_gfx_rocket.js'));
  const ctx = loadSim({ clientToo: true, files });
  const { GfxPlugins, GfxRocket, Const } = ctx;
  assert.ok(GfxRocket && GfxRocket.bake, 'GfxRocket loaded');
  assert.equal(typeof GfxPlugins.icons.rocket, 'function', 'icon registered');
  for (const t of ['rocket_boom', 'rocket_smoke', 'rocket_trail', 'rocket_launch']) assert.equal(typeof GfxPlugins.fx[t], 'function', t + ' fx registered');
  assert.ok(GfxPlugins.effects.some(e => e.key === 'rockets' && typeof e.draw === 'function' && e.margin >= 30), 'persistent effect "rockets" registered with a margin that covers a whole flight');
  const D = GfxRocket.dims, { bake } = GfxRocket;
  const bbox = (pb) => { let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0; for (let y = 0; y < pb.h; y++) for (let x = 0; x < pb.w; x++) if ((pb.d[y * pb.w + x] >>> 24) > 0) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { x0, y0, x1, y1, n }; };
  const inside = (pb, b, label, margin = 1) => assert.ok(b.n > 0 && b.x0 >= margin && b.y0 >= margin && b.x1 <= pb.w - 1 - margin && b.y1 <= pb.h - 1 - margin, `${label}: content ${b.n} px, box ${b.x0},${b.y0}..${b.x1},${b.y1} in ${pb.w}x${pb.h}`);
  const count = (pb, pred) => { let n = 0; for (let i = 0; i < pb.d.length; i++) { const c = pb.d[i]; if ((c >>> 24) > 200 && pred(c & 255, (c >>> 8) & 255, (c >>> 16) & 255)) n++; } return n; };
  const isRed = (r, g, b) => r > 150 && r - g > 60 && r - b > 50, isWhite = (r, g, b) => r > 215 && g > 215 && b > 215, isFlame = (r, g, b) => r > 235 && g > 130 && b < 170 && r - b > 90;
  // rocket sprites: 32 headings x 3 flame frames
  for (let ai = 0; ai < D.ANG_N; ai++) for (let fi = 0; fi < D.FLAME_N; fi++) {
    const pb = bake.rocket(ai, fi);
    inside(pb, bbox(pb), `rocket ${ai}/${fi}`);
    assert.ok(count(pb, isRed) >= 6 && count(pb, isWhite) >= 6 && count(pb, isFlame) >= 5, `rocket ${ai}/${fi}: red nose + fins, white body, flame`);
    // the red nose sits ahead of the centre (heading = angle ai * 360 / 32 degrees, 0 = right, clockwise on screen), the flame behind it
    const th = ai / D.ANG_N * Math.PI * 2, ux = Math.cos(th), uy = Math.sin(th);
    let rn = 0, rs = 0, fn = 0, fs_ = 0;
    for (let y = 0; y < pb.h; y++) for (let x = 0; x < pb.w; x++) {
      const c = pb.d[y * pb.w + x]; if ((c >>> 24) < 200) continue;
      const r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255, along = (x + 0.5 - D.SPR_C) * ux + (y + 0.5 - D.SPR_C) * uy;
      if (isRed(r, g, b) && along > 0) { rn++; rs += along; }
      if (isFlame(r, g, b) && along < -5) { fn++; fs_ += along; }
    }
    assert.ok(rn >= 4 && fn >= 4, `rocket ${ai}/${fi}: nose ahead (${rn}) and flame behind (${fn}) the centre`);
  }
  // trail strips: 64 headings x 4 kinds; puff sprites; reticle phases
  for (let kind = 0; kind < 4; kind++) for (let ai = 0; ai < D.STRIP_N; ai++) { const pb = bake.strip(ai, kind); inside(pb, bbox(pb), `strip ${kind}/${ai}`); }
  for (let cls = 0; cls < 5; cls++) for (let tone = 0; tone < 3; tone++) for (let lvl = 0; lvl < 4; lvl++) { const pb = bake.puff(cls, tone, lvl); assert.ok(bbox(pb).n > 0, `puff ${cls}/${tone}/${lvl}`); }
  for (let ph = 0; ph < 4; ph++) { const pb = bake.reticle(ph); inside(pb, bbox(pb), `reticle ${ph}`); assert.ok(count(pb, (r, g, b) => r > 120 && g < 130 && b < 120) > 30 || bbox(pb).n > 200, 'reticle ring'); }
  // bursts: land (2 variants) and water, every frame; the fireball frames really glow, the late ones are smoke / stipple
  for (const [kind, v] of [[0, 0], [0, 1], [1, 0]]) {
    let glow = 0;
    for (let fi = 0; fi < D.BOOM_N; fi++) {
      const pb = bake.boom(kind, v, fi);
      inside(pb, bbox(pb), `boom ${kind}/${v}/${fi}`);
      if (fi < 6) glow += count(pb, (r, g, b) => r > 240 && g > 150 && b < 200);
    }
    assert.ok(glow > (kind ? 20 : 400), `boom ${kind}/${v}: the first frames glow (${glow} hot px)`);        // the water burst only flashes briefly under the geyser
  }
  for (let v = 0; v < 2; v++) for (let fi = 0; fi < D.SMK_N; fi++) { const pb = bake.smoke(v, fi); inside(pb, bbox(pb), `smoke ${v}/${fi}`); }
  // the icon: fits the 14x14 inner glyph area of the 16x16 icon canvas and shows the rocket's colours
  const IP = { y: 0xff3cd8ff, o: 0xff309aff, r: 0xff444aee, w: 0xffffffff }, pbI = new GfxRocket.PB(16, 16), cells = [];
  bake.icon({ set: (x, y, c) => { pbI.set(x, y, c); cells.push([x, y]); }, get: (x, y) => pbI.get(x, y) }, IP);
  const bi = bbox(pbI);
  assert.ok(bi.n > 45 && bi.x1 - bi.x0 + 1 <= 14 && bi.y1 - bi.y0 + 1 <= 14, `icon ${bi.x1 - bi.x0 + 1}x${bi.y1 - bi.y0 + 1}, ${bi.n} px`);
  assert.ok(count(pbI, isRed) >= 8 && count(pbI, isWhite) >= 8, 'icon: red + white');
  note(`${D.ANG_N * D.FLAME_N} rocket sprites, ${D.STRIP_N * 4} trail strips, ${3 * D.BOOM_N} burst frames, ${2 * D.SMK_N} smoke frames, ${bi.x1 - bi.x0 + 1}x${bi.y1 - bi.y0 + 1} icon: all inside their canvases`);
});

section('performance: ms/tick of the plugin with several salvos in flight at ~1500 creatures; one impact on a crowd', () => {
  // timings on a shared machine: the whole measurement is repeated (up to 3 times) and the best attempt counts
  const attempt = () => {
    const ctx = mkCtx(4);
    const { S, Powers } = ctx;
    arena(ctx, 48, 48, 30);
    for (let i = 0; i < 1500; i++) { const a = i * 2.39996, d = Math.sqrt((i + 0.5) / 1500) * 28; ctx.Units.spawn(i % 3, 48.5 + Math.cos(a) * d, 48.5 + Math.sin(a) * d, { age: 25 }); }
    step(ctx, 20);
    const ms = [];
    // Powers calls PowerPlugins[i].step: time the registered object itself
    const reg = ctx.PowerPlugins.find(p => p.name === 'rocket'), origReg = reg.step;
    reg.step = (t, h) => { const t0 = performance.now(); origReg(t, h); ms.push(performance.now() - t0); };
    let air = 0, salvos = 0;
    for (let tk = 0; tk < 400; tk++) {
      if (tk % 12 === 0) { const a = tk * 0.9; if (Powers.apply('rocket', 48.5 + Math.cos(a) * 12, 48.5 + Math.sin(a) * 12, 8, 'tap')) salvos++; }
      stepN(ctx, 1); ctx.Fx.update(0.1);
      air = Math.max(air, (S.eff.rockets || []).length);
    }
    reg.step = origReg;
    const sorted = ms.slice().sort((a, b) => a - b);
    assert.equal(Powers.errors, 0);
    return { avg: ms.reduce((a, b) => a + b, 0) / ms.length, p99: sorted[(sorted.length * 0.99) | 0], max: sorted[sorted.length - 1], n: ms.length, air, salvos, left: S.units.size, creatures: 1500 };
  };
  let best = null;
  for (let k = 0; k < 3; k++) {
    const r = attempt();
    if (!best || r.p99 + r.avg < best.p99 + best.avg) best = r;
    if (r.avg < 0.3 && r.p99 < 2 && r.max < 30) break;
  }
  note(`rocket plugin step at ${best.creatures} creatures: avg ${best.avg.toFixed(4)} ms, p99 ${best.p99.toFixed(3)} ms, max ${best.max.toFixed(2)} ms over ${best.n} ticks; ${best.salvos} salvos of 9, up to ${best.air} rockets in the air, ${best.left} creatures left`);
  assert.ok(best.avg < 0.3, 'budget: step < 0.3 ms average');
  assert.ok(best.p99 < 2, 'rare spikes only');
  assert.ok(best.max < 30, 'no hitch: the worst single tick stays far below a frame budget (the one-off impact cost itself is asserted < 8 ms in the crowd section; a single tick can also be a scheduler stall on a shared machine)');
  // apply() itself
  const big = mkCtx(2); arena(big, 48, 48, 20);
  for (let i = 0; i < 600; i++) big.Units.spawn(i % 3, 48.5 + Math.cos(i) * (i % 20) * 0.8, 48.5 + Math.sin(i) * (i % 20) * 0.8, { age: 25 });
  let d = 1e9;
  for (let k = 0; k < 3 && d >= 5; k++) { const t0 = performance.now(); big.S.mod.rocket && (big.S.mod.rocket.cd = 0); big.S.eff.rockets = []; big.Powers.apply('rocket', 48.5, 48.5, 8, 'tap'); d = Math.min(d, performance.now() - t0); }
  note(`apply (9 rockets, 600 creatures around): ${d.toFixed(2)} ms`);
  assert.ok(d < 5);
});

// ------------------------------------------------------------------ browser part
let bfail = 0;
if (!args.nobrowser) {
  let browserMod = null;
  try { browserMod = await import('./browser.mjs'); } catch (e) { console.log('  (browser part skipped: ' + e.message.split('\n')[0] + ')'); }
  if (browserMod) {
    const { runBrowserPart } = await import('./power_rocket_browser.mjs');
    bfail = await runBrowserPart({ root, args, browserMod, section: null });
  }
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} headless sections passed${args.nobrowser ? '' : `, browser part: ${bfail ? bfail + ' failed' : 'ok'}`}`);
if (failed.length || bfail) process.exit(1);
