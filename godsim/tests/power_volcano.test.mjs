// «Вулкан» (volcano) power: node tests/power_volcano.test.mjs [--nobrowser] [--shots=/tmp/godsim-volcano-shots] [--quick]
// Headless sections use the real sim (World / Buildings / Cities / Units / Sim / Save + src/19_power_volcano.js, loaded by the harness like every plugin);
// the browser section builds the real game (+ tests/fixtures/volcano_hooks.js) to /tmp/godsim-volcano.html and looks at it at zoom 8 / 14 / 24.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSim, stepN, newWorld, pad } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const QUICK = !!args.quick;
const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 92)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 12).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

// ------------------------------------------------------------------ plumbing
function mkCtx(seed = 3) {
  const ctx = loadSim();
  newWorld(ctx, seed, 96, 96);
  return ctx;
}
/** advance n ticks AND age the Fx queue (Sim does not touch Fx) */
function step(ctx, n) { for (let i = 0; i < n; i++) { stepN(ctx, 1); ctx.Fx.update(0.1); } }
/** flat grass square [cx-half, cx+half]: no resources, fire or buildings, gentle elevation noise (130..138) */
function arena(ctx, cx, cy, half, tile) {
  const { World, S, Const } = ctx;
  const t = tile === undefined ? Const.T.GRASS : tile;
  for (let y = cy - half; y <= cy + half; y++) for (let x = cx - half; x <= cx + half; x++) {
    const i = y * S.w + x;
    if (S.bld[i]) ctx.Buildings.destroyAt(x, y, 'test');
    S.fire[i] = 0; S.res[i] = 0; S.amt[i] = 0;
    World.setTile(x, y, t, { elev: 130 + ((x * 7 + y * 13) % 9) });
  }
}
const vols = (ctx) => ctx.S.eff.volcanoes || [];
const countTiles = (ctx, t, cx, cy, R0) => { let n = 0; for (let y = cy - R0; y <= cy + R0; y++) for (let x = cx - R0; x <= cx + R0; x++) if (ctx.S.tile[y * ctx.S.w + x] === t) n++; return n; };
function house(ctx, cityId, x, y) { return ctx.Buildings.place(cityId, ctx.Const.B.HOUSE, x, y, { instant: true }); }
function mkCity(ctx, x, y, n = 3) {
  const us = [];
  for (let i = 0; i < n; i++) us.push(ctx.Units.spawn(0, x + 0.5 + (i - 1) * 0.6, y + 1.5, {}));
  const c = ctx.Cities.found(0, x, y, us);
  assert.ok(c, 'city founded');
  return c;
}
/** a compact digest of everything the simulation produced (terrain layers, units, effects, rng) */
function digest(ctx) {
  const { S, R } = ctx;
  let h = 2166136261 >>> 0;
  const mix = (v) => { h = Math.imul(h ^ (v | 0), 16777619) >>> 0; };
  for (const a of [S.tile, S.elev, S.res, S.amt, S.fire, S.bld]) for (let i = 0; i < a.length; i++) mix(a[i]);
  const us = [...S.units.values()].sort((a, b) => a.id - b.id).map((u) => [u.id, +u.x.toFixed(4), +u.y.toFixed(4), +u.hp.toFixed(3), u.state, u.burning]);
  return JSON.stringify({ tick: S.tick, grid: h, eff: S.eff, vol: S.mod.volcano, rng: R.getState(), n: S.units.size, us, log: S.log.length, b: S.buildings.size });
}
const finiteDeep = (o) => JSON.stringify(o, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? '__BAD__' : v)).indexOf('__BAD__') < 0;
const Q = 4;                                                                    // numbers per tracked lava tile in entry.lav: [tile, coolTick, kind, elevBefore]
/** the part of the world a volcano owns: its effect + registry + the terrain layers inside a square (hashed) - what a save / load must continue identically */
function volcanoDigest(ctx, cx, cy, half) {
  const { S } = ctx;
  let h = 2166136261 >>> 0;
  const mix = (v) => { h = Math.imul(h ^ (v | 0), 16777619) >>> 0; };
  for (let y = cy - half; y <= cy + half; y++) for (let x = cx - half; x <= cx + half; x++) { const i = y * S.w + x; mix(S.tile[i]); mix(S.elev[i]); }
  return JSON.stringify({ tick: S.tick, eff: S.eff.volcanoes, mod: S.mod.volcano, grid: h });
}

console.log('volcano power tests');
const geomOf = (ctx, r) => ctx.PowerVolcano.geom(r);

// ================================================================== registration + the tap
section('registration: tool def (group destroy, brush, no drag), plugin list, Powers.apply dispatch + feedback', () => {
  const ctx = mkCtx();
  const { ToolDefs, Powers, S, Fx, Log } = ctx;
  const def = ToolDefs.byId.volcano;
  assert.ok(def, 'ToolDefs.byId.volcano');
  assert.equal(def.tab, 'powers'); assert.equal(def.group, 'destroy'); assert.equal(def.name, 'Вулкан'); assert.equal(def.short, 'Вулкан');
  assert.equal(def.icon, 'volcano'); assert.equal(def.brush, true); assert.equal(def.drag, false);
  const ids = ToolDefs.filter((t) => t.tab === 'powers').map((t) => t.id);
  const iV = ids.indexOf('volcano');
  assert.ok(iV > ids.indexOf('lightning') && iV < ids.indexOf('rain'), 'inside the disasters, before the blessings: ' + ids.join(','));
  assert.ok(ctx.PowerPlugins.includes(ctx.PowerVolcano), 'registered in PowerPlugins');
  arena(ctx, 48, 48, 10);
  const ok = Powers.apply('volcano', 48.5, 48.5, 3, 'tap');
  assert.equal(ok, true); assert.ok(/Вулкан/.test(Powers.lastMessage), Powers.lastMessage);
  assert.equal(vols(ctx).length, 1);
  const e = vols(ctx)[0];
  assert.equal(e.phase, 0); assert.equal(e.rb, 4.5); assert.equal(e.rc, 1.5); assert.equal(e.until - e.t0, 60);
  assert.ok(Fx.list.some((f) => f.type === 'shake') && Fx.list.some((f) => f.type === 'dust'), 'tap feedback: shake + dust');
  const lines = S.log.filter((l) => /^Проснулся вулкан/.test(l.msg));
  assert.equal(lines.length, 1, 'exactly one «Проснулся вулкан» line'); assert.equal(lines[0].kind, 'disaster');
  // robustness of the tap itself
  assert.equal(Powers.apply('volcano', -5, 5, 3, 'tap'), false);
  assert.equal(Powers.apply('volcano', NaN, 5, 3, 'tap'), false);
  assert.equal(Powers.apply('volcano', 10, 10, 3, 'end'), false);
  assert.equal(Powers.apply('volcano', 10, 10, 3, 'move'), false, 'drag:false -> a move without a start is ignored');
  const c2 = mkCtx(); arena(c2, 30, 30, 9); c2.Powers.apply('volcano', 30.5, 30.5, 99, 'tap'); assert.equal(vols(c2)[0].r, 8, 'radius clamped to 8');
  const c3 = mkCtx(); arena(c3, 30, 30, 9); c3.Powers.apply('volcano', 30.5, 30.5, 0, 'tap'); assert.equal(vols(c3)[0].r, 1, 'radius clamped to 1');
  assert.equal(Powers.errors, 0);
});

// ================================================================== cone geometry
section('cone geometry for every brush size: base radius 3 + r/2, crater, elevation profile, tile bands, nothing outside the cone changes', () => {
  const rows = [];
  for (let r = 1; r <= 8; r++) {
    const ctx = mkCtx(11), { S, Const, Powers } = ctx, T = Const.T, g = geomOf(ctx, r);
    arena(ctx, 48, 48, 14);
    const tile0 = S.tile.slice(), elev0 = S.elev.slice();
    Powers.apply('volcano', 48.5, 48.5, r, 'tap');
    step(ctx, 60);
    const e = vols(ctx)[0];
    assert.equal(e.phase, 1, 'r=' + r + ': the crater opens at the end of the rumble');
    assert.equal(g.rb, 3 + r / 2);
    let nCrater = 0, nM = 0, nH = 0;
    const shell = new Map();
    for (let y = 48 - 14; y <= 48 + 14; y++) {
      for (let x = 48 - 14; x <= 48 + 14; x++) {
        const i = y * S.w + x, d = Math.hypot(x - 48, y - 48), t = S.tile[i], el = S.elev[i];
        if (d > g.rb) { assert.equal(t, tile0[i], `r=${r}: tile outside the base changed at ${x},${y}`); assert.equal(el, elev0[i], `r=${r}: elevation outside the base changed`); continue; }
        if (d <= g.rc) { assert.equal(t, T.LAVA, `r=${r}: crater tile ${x},${y} is lava`); assert.equal(el, g.floor); nCrater++; continue; }
        assert.ok(t === T.HILL || t === T.MOUNTAIN, `r=${r}: cone tile ${x},${y} is HILL or MOUNTAIN, got ${t}`);
        const E = g.elevAt(d);
        assert.ok(Math.abs(el - E) <= 3.6, `r=${r}: elevation ${el} vs profile ${E.toFixed(1)} at d=${d.toFixed(2)}`);
        if (E - 3.6 >= g.mtnLo) assert.equal(t, T.MOUNTAIN, `r=${r}: high slope tile is MOUNTAIN (d=${d.toFixed(2)}, E=${E.toFixed(1)})`);
        if (E + 3.6 < g.mtnLo) assert.equal(t, T.HILL, `r=${r}: foothill tile is HILL (d=${d.toFixed(2)}, E=${E.toFixed(1)})`);
        if (t === T.MOUNTAIN) nM++; else nH++;
        const k = Math.floor(d); const s = shell.get(k) || { n: 0, sum: 0 }; s.n++; s.sum += el; shell.set(k, s);
      }
    }
    assert.equal(nCrater, r <= 2 ? 5 : r <= 5 ? 9 : 13, `r=${r}: crater size`);
    assert.equal(countTiles(ctx, T.LAVA, 48, 48, 14), nCrater, 'no lava outside the crater yet');
    assert.ok(nM > 0 && nH > 0, `r=${r}: both MOUNTAIN slopes and HILL foothills exist (${nM}/${nH})`);
    // the cone falls monotonically from the rim to the foot (mean elevation per one-tile shell)
    const ks = [...shell.keys()].filter((k) => shell.get(k).n >= 3).sort((a, b) => a - b);
    for (let q = 1; q < ks.length; q++) assert.ok(shell.get(ks[q]).sum / shell.get(ks[q]).n < shell.get(ks[q - 1]).sum / shell.get(ks[q - 1]).n, `r=${r}: shell ${ks[q]} is lower than shell ${ks[q - 1]}`);
    let peak = 0; for (let y = 40; y <= 56; y++) for (let x = 40; x <= 56; x++) if (S.tile[y * S.w + x] === T.MOUNTAIN) peak = Math.max(peak, S.elev[y * S.w + x]);
    assert.ok(peak >= 224, `r=${r}: rim peak ${peak}`);
    rows.push(`r=${r}: base ${g.rb} crater ${nCrater} tiles, ${nM} MOUNTAIN + ${nH} HILL`);
    assert.equal(Powers.errors, 0);
  }
  note(rows.join(' | '));
});

section('the cone rises from the outside in (<= 8 tile edits per tick), no lava before the crater opens, shake pulses + dust + flash', () => {
  const ctx = mkCtx(5), { S, Const, Powers, Fx, Bus } = ctx, T = Const.T;
  arena(ctx, 48, 48, 12);
  const edits = new Map();
  Bus.on('tileChanged', () => { edits.set(S.tick, (edits.get(S.tick) || 0) + 1); });
  Powers.apply('volcano', 48.5, 48.5, 8, 'tap');                               // the biggest cone: 154 tiles
  const t0 = S.tick, seen = new Set(), shakes = [], dust = new Set(), flashes = [];
  const peakAt = [];
  for (let k = 1; k <= 60; k++) {
    step(ctx, 1);
    for (const f of Fx.list) { if (seen.has(f)) continue; seen.add(f); if (f.type === 'shake') shakes.push([k, f.amp]); else if (f.type === 'dust') dust.add(f); else if (f.type === 'flash') flashes.push(k); }
    if (k < 60) assert.equal(countTiles(ctx, T.LAVA, 48, 48, 12), 0, 'no lava before the crater opens (tick ' + k + ')');
    // outside-in: the foot ring is built before the rim
    if (k === 12) peakAt.push(S.elev[(48 + 2) * S.w + 48 + 6], S.elev[(48 + 1) * S.w + 48]);
  }
  assert.ok(peakAt[0] > 150 && peakAt[1] < 150, `at tick 12 the foothills (d=6.3) already rose (${peakAt[0]}) but the rim (d=1) did not (${peakAt[1]})`);
  let worst = 0, total = 0; for (let k = t0 + 1; k <= t0 + 59; k++) { worst = Math.max(worst, edits.get(k) || 0); total += edits.get(k) || 0; }
  const opening = edits.get(t0 + 60) || 0;
  note(`terrain edits per tick while the r=8 cone rises: worst ${worst} (${total} edits in 59 ticks); the crater opening edits ${opening} tiles in its tick`);
  assert.ok(worst <= 6, 'terrain edits per tick during the rumble: ' + worst);
  assert.ok(opening <= 13, 'the crater opens in one tick: ' + opening);
  assert.ok(shakes.length >= 9, 'shake pulses during the rumble: ' + shakes.length);
  const early = shakes.filter((s) => s[0] < 20).map((s) => s[1]), late = shakes.filter((s) => s[0] >= 40 && s[0] < 60).map((s) => s[1]);
  assert.ok(Math.max(...late) > Math.max(...early), 'the pulses grow stronger');
  assert.ok(dust.size >= 12, 'dust while the ground rises: ' + dust.size);
  assert.equal(flashes.length, 1, 'one flash when the crater opens'); assert.ok(flashes[0] >= 59);
  assert.ok(shakes.some((s) => s[1] >= 6), 'big shake with the opening blast');
  assert.equal(vols(ctx)[0].phase, 1);
});

// ================================================================== lifecycle
section('lifecycle: rumble 60 -> eruption 500..800 (bursts every 25..70 ticks, 3..8 bombs) -> cooling 150 -> entry removed, extinct cone (MOUNTAIN ring, HILL core), no lava left', () => {
  const ctx = mkCtx(7), { S, Const, Powers, Fx } = ctx, T = Const.T;
  arena(ctx, 48, 48, 14);
  Powers.apply('volcano', 48.5, 48.5, 3, 'tap');
  const e0 = vols(ctx)[0], t0 = e0.t0;
  let phaseAt = { 0: t0 }, lastNb = 0, lb = [], bombsPer = [], launched = 0, maxBombs = 0, maxLav = 0, maxFlow = 0, ended = 0, guard = 0;
  while (vols(ctx).length && guard++ < 1600) {
    step(ctx, 1);
    const e = vols(ctx)[0];
    if (!e) { ended = S.tick; break; }
    if (phaseAt[e.phase] === undefined) phaseAt[e.phase] = S.tick;
    if (e.nb !== lastNb) {                                                      // a burst fired this tick
      lastNb = e.nb; lb.push(S.tick);
      const n = e.bombs.filter((b) => b[4] >= S.tick && b[4] <= S.tick + 6).length;
      bombsPer.push(n); launched += n;
    }
    maxBombs = Math.max(maxBombs, e.bombs.length); maxLav = Math.max(maxLav, e.lav.length / Q);
    let fl = 0; for (let q = 2; q < e.lav.length; q += Q) if (e.lav[q] === 1) fl++;
    maxFlow = Math.max(maxFlow, fl);
    if (S.tick % 150 === 0) assert.ok(finiteDeep(S.eff) && JSON.stringify(JSON.parse(JSON.stringify(S.eff))) === JSON.stringify(S.eff), 'S.eff stays JSON-safe');
  }
  assert.ok(ended > 0, 'the volcano ends by itself');
  assert.equal(phaseAt[1] - t0, 60, 'rumble 60 ticks');
  const erupt = phaseAt[2] - phaseAt[1];
  assert.ok(erupt >= 500 && erupt <= 800, 'eruption length ' + erupt);
  assert.equal(ended - phaseAt[2], 150, 'cooling 150 ticks, then the entry is removed');
  assert.ok(lb.length >= 8, 'bursts: ' + lb.length);
  const iv = []; for (let k = 1; k < lb.length; k++) iv.push(lb[k] - lb[k - 1]);
  assert.ok(iv.every((d) => d >= 25 && d <= 70), 'burst intervals within 25..70: ' + iv.join(','));
  assert.equal(bombsPer[0], 8, 'the opening blast throws 8');
  assert.ok(bombsPer.every((n) => n >= 3 && n <= 8), 'bombs per burst 3..8: ' + bombsPer.join(','));
  assert.ok(maxBombs <= 24, 'bombs in flight <= 24: ' + maxBombs);
  assert.ok(maxLav <= 56 && maxFlow <= 40, `tracked lava <= 56 (${maxLav}), live flow tiles <= 40 (${maxFlow})`);
  // the extinct cone
  assert.equal(countTiles(ctx, T.LAVA, 48, 48, 25), 0, 'no lava left anywhere near the cone');
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const t = S.tile[(48 + dy) * S.w + 48 + dx], d = Math.hypot(dx, dy);
    assert.equal(t, d <= 1.05 ? T.HILL : T.MOUNTAIN, `crater tile ${dx},${dy}: HILL core inside a MOUNTAIN ring`);
  }
  assert.deepEqual(S.mod.volcano.cones, [[48, 48, 3, ended]], 'the extinct cone is remembered');
  assert.equal(vols(ctx).length, 0);
  assert.ok(Fx.list.length <= 401);
  assert.equal(Powers.errors, 0); assert.equal(ctx.Sim.totalErrors, 0);
  note(`rumble 60, eruption ${erupt}, cooling 150; ${lb.length} bursts every ${Math.min(...iv)}..${Math.max(...iv)} ticks, ${launched} bombs (${bombsPer.join('')}), max ${maxBombs} in flight, <= ${maxLav} tracked lava tiles (<= ${maxFlow} flow)`);
});

// ================================================================== bombs
section('bombs: units within 1.3 tiles are hurt (and burn), buildings damaged, flammables ignited, a lava tile is left and cools into HILL', () => {
  const ctx = mkCtx(9), { S, Const, Powers, Units, Buildings, World } = ctx, T = Const.T;
  arena(ctx, 48, 48, 14); arena(ctx, 22, 48, 6);
  const c = mkCity(ctx, 22, 48), cid = c.id;                                    // a city far away: its houses are bomb food (the impact zone is 12 tiles east of the cone)
  Powers.apply('volcano', 48.5, 48.5, 3, 'tap'); step(ctx, 60);
  const e = vols(ctx)[0];
  e.next = 1e9; e.fn = 1e9; e.bombs.length = 0;                                  // no random bursts, no tongue and not the opening salvo: only the bombs this test throws
  const hx = 60, hy = 48;                                                        // impact tile (12 tiles from the crater: outside the scare radius)
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const i = (hy + dy) * S.w + hx + dx; if (S.bld[i]) Buildings.destroyAt(hx + dx, hy + dy, 'test'); S.fire[i] = 0; }
  const h0 = house(ctx, cid, hx, hy), h1 = house(ctx, cid, hx + 1, hy), h2 = house(ctx, cid, hx - 3, hy);
  assert.ok(h0 && h1 && h2, 'houses placed');
  const un = (hp, maxHp, dx, dy) => { const u = Units.spawn(1, hx + 0.5 + dx, hy + 0.5 + dy, {}); u.hp = hp; u.maxHp = maxHp; u.state = 'idle'; u.nextThink = 1e9; return u; };
  const uA = un(12, 30, 0.2, 0), uB = un(26, 30, 0, 1.0), uC = un(30, 30, 2.4, 0);
  for (const [dx, dy] of [[0, -1], [-1, -1], [-1, 1], [0, 1]]) World.setTile(hx + dx, hy + dy, T.FOREST);
  const hpB0 = uB.hp, hpC0 = uC.hp, houseHp1 = h1.hp;
  e.bombs.push([e.x, e.y, hx + 0.5, hy + 0.5, S.tick, S.tick + 1, 3]);
  step(ctx, 1);
  assert.equal(S.units.has(uA.id), false, 'a direct hit kills a hurt unit');
  assert.ok(S.units.has(uB.id) && uB.hp < hpB0 - 8 && uB.hp > 0, 'a unit 1 tile away is hurt: ' + uB.hp);
  assert.ok(uB.burning > S.tick, 'and set on fire');
  assert.equal(uC.hp, hpC0, 'a unit 2.4 tiles away is untouched');
  assert.equal(Buildings.get(h0.id), null, 'the house under the bomb is destroyed');
  assert.ok(Buildings.get(h1.id) && Buildings.get(h1.id).hp === houseHp1 - 30, 'the neighbour house is damaged: ' + (Buildings.get(h1.id) && Buildings.get(h1.id).hp));
  assert.ok(Buildings.get(h2.id) && Buildings.get(h2.id).hp === h2.maxHp, 'a house 3 tiles away is untouched');
  let burning = 0; for (const [dx, dy] of [[0, -1], [-1, -1], [-1, 1], [0, 1]]) if (S.fire[(hy + dy) * S.w + hx + dx] > 0) burning++;
  assert.ok(burning >= 1, 'forest next to the impact is ignited: ' + burning);
  assert.ok(e.bl >= 1 && e.bombs.length === 0);
  // a salvo on plain grass: most bombs leave lava, which cools into hills
  const spots = [];
  for (let k = 0; k < 20; k++) { const x = 49 + (k % 5) * 2, y = 53 + Math.floor(k / 5) * 2; spots.push(y * S.w + x); e.bombs.push([e.x, e.y, x + 0.5, y + 0.5, S.tick, S.tick + 1, 3]); }
  step(ctx, 1);
  const lava = spots.filter((i) => S.tile[i] === T.LAVA);
  assert.ok(lava.length >= 9 && lava.length <= 20, 'lava puddles after 20 bombs: ' + lava.length);
  assert.equal(e.lav.length / Q >= lava.length, true);
  step(ctx, 330);
  for (const i of spots) assert.notEqual(S.tile[i], T.LAVA, 'bomb lava cools within ~300 ticks');
  for (const i of lava) assert.equal(S.tile[i], T.HILL, 'cooled lava on the plain becomes HILL');
  assert.equal(Powers.errors, 0);
  note(`${lava.length} of 20 bombs left a puddle; all solid again after 330 ticks`);
});

section('bombs never land on water as lava; the cap of 56 tracked lava tiles holds; a bomb on the crater only splashes', () => {
  const ctx = mkCtx(9), { S, Const, Powers, World } = ctx, T = Const.T;
  arena(ctx, 48, 48, 14);
  for (let y = 60; y <= 62; y++) for (let x = 40; x <= 50; x++) World.setTile(x, y, T.SHALLOW, { elev: 86 });
  Powers.apply('volcano', 48.5, 40.5, 3, 'tap'); step(ctx, 60);
  const e = vols(ctx)[0]; e.next = 1e9; e.fn = 1e9;
  e.bombs.push([e.x, e.y, 45.5, 61.5, S.tick, S.tick + 1, 3], [e.x, e.y, e.x, e.y, S.tick, S.tick + 1, 3]);
  step(ctx, 1);
  assert.equal(S.tile[61 * S.w + 45], T.SHALLOW, 'water stays water');
  assert.equal(S.tile[40 * S.w + 48], T.LAVA, 'the crater is still lava'); assert.equal(e.lav.length, 0);
  assert.ok(ctx.Fx.list.some((f) => f.type === 'splash'), 'a splash on the water');
  for (let round = 0; round < 12; round++) {                                    // flood it with bombs: the cap holds
    for (let k = 0; k < 20; k++) { const x = 36 + ((round * 7 + k * 3) % 26), y = 44 + ((round * 5 + k * 2) % 14); e.bombs.push([e.x, e.y, x + 0.5, y + 0.5, S.tick, S.tick + 1, 3]); }
    step(ctx, 1);
    assert.ok(e.lav.length / Q <= 56, 'tracked lava <= 56: ' + e.lav.length / Q);
  }
  assert.equal(Powers.errors, 0);
});

// ================================================================== flow
section('lava flow: starts at the rim, creeps away from the crater ~1 tile per 12 ticks, <= 40 live tiles, oldest cools first', () => {
  const ctx = mkCtx(13), { S, Const, Powers } = ctx, T = Const.T;
  arena(ctx, 48, 48, 14);
  Powers.apply('volcano', 48.5, 48.5, 3, 'tap'); step(ctx, 60);
  const e = vols(ctx)[0], t1 = S.tick;
  e.next = 1e9;                                                                  // flow only (bombs would add lava tiles of their own)
  const born = new Map(), order = [];
  let maxFlow = 0, maxD = 0;
  for (let k = 0; k < 420; k++) {
    step(ctx, 1);
    let fl = 0;
    for (let q = 0; q + 2 < e.lav.length; q += Q) {
      if (e.lav[q + 2] !== 1) continue;
      fl++;
      const i = e.lav[q];
      if (!born.has(i)) { born.set(i, S.tick); order.push(i); }
    }
    maxFlow = Math.max(maxFlow, fl);
  }
  assert.ok(maxFlow <= 40, 'live flow tiles <= 40: ' + maxFlow);
  assert.ok(order.length >= 25, 'the tongue keeps growing: ' + order.length + ' tiles in 420 ticks');
  const rate = 420 / order.length;
  assert.ok(rate >= 9 && rate <= 18, 'about one new tile per 12 ticks (' + rate.toFixed(1) + ')');
  const first = order[0], fx = first % S.w, fy = (first - fx) / S.w;
  assert.ok(Math.hypot(fx + 0.5 - e.x, fy + 0.5 - e.y) <= e.rc + 1.6, 'the first tongue tile is a breach in the rim next to the crater');
  for (const i of order) { const x = i % S.w, y = (i - x) / S.w; maxD = Math.max(maxD, Math.hypot(x + 0.5 - e.x, y + 0.5 - e.y)); }
  assert.ok(maxD > e.rb + 3, 'the tongue leaves the cone: reach ' + maxD.toFixed(1));
  assert.ok(maxD <= e.rb + 11 + 1.5, 'but never farther than the reach limit: ' + maxD.toFixed(1));
  // downhill: no tongue tile lies inside the crater (the rim ring is the closest it gets)
  for (const i of order) { const x = i % S.w, y = (i - x) / S.w; assert.ok(Math.hypot(x + 0.5 - e.x, y + 0.5 - e.y) > e.rc, 'no flow tile inside the crater'); }
  // each new tile touches the tongue (or the crater) and lies at least as far out as that neighbour
  const seenSet = new Set(e.cr); let backwards = 0;
  for (const i of order) {
    const x = i % S.w, y = (i - x) / S.w, d = Math.hypot(x + 0.5 - e.x, y + 0.5 - e.y);
    let fedFromInside = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const j = (y + dy) * S.w + x + dx; if (seenSet.has(j) && Math.hypot((x + dx) + 0.5 - e.x, (y + dy) + 0.5 - e.y) <= d + 0.051) fedFromInside = true; }
    if (!fedFromInside) backwards++;
    seenSet.add(i);
  }
  assert.equal(backwards, 0, 'every tongue tile grows out of a neighbour that is not farther from the crater: ' + backwards + ' violations');
  // the oldest tiles solidify (their tile is no longer lava) while the newest still glow
  const oldest = order.slice(0, 5).filter((i) => S.tile[i] !== T.LAVA).length, newest = order.slice(-5).filter((i) => S.tile[i] === T.LAVA).length;
  assert.ok(oldest >= 3, 'the oldest flow tiles cooled: ' + oldest + '/5');
  assert.ok(newest >= 3, 'the newest flow tiles are still molten: ' + newest + '/5');
  assert.equal(Powers.errors, 0);
  note(`${order.length} flow tiles in 420 ticks (one per ${rate.toFixed(1)}), reach ${maxD.toFixed(1)} tiles, <= ${maxFlow} live`);
});

section('lava flow follows the lowest ground and razes buildings / burns forest on its way; water stops it', () => {
  const ctx = mkCtx(13), { S, Const, Powers, Buildings, World, Bus } = ctx, T = Const.T;
  arena(ctx, 48, 48, 14);
  // a gentle slope falling to the east: the tongue must go east
  for (let y = 34; y <= 62; y++) for (let x = 34; x <= 62; x++) World.setTile(x, y, T.GRASS, { elev: 150 - (x - 34) });
  arena(ctx, 22, 48, 5);
  const c = mkCity(ctx, 22, 48);
  const hx = [], fo = [];
  for (let y = 44; y <= 52; y++) { hx.push(house(ctx, c.id, 55, y)); World.setTile(56, y, T.FOREST); fo.push(y * S.w + 56); }
  for (let y = 36; y <= 60; y++) World.setTile(62, y, T.SHALLOW, { elev: 90 });
  Powers.apply('volcano', 48.5, 48.5, 3, 'tap'); step(ctx, 60);
  const e = vols(ctx)[0]; e.next = 1e9; e.bombs.length = 0; e.fa = 0;
  const razed = []; Bus.on('buildingDestroyed', (b, cause) => { if (cause === 'volcano') razed.push(b.id); });
  let molten = 0, eastmost = 0;
  for (let k = 0; k < 520; k++) {
    step(ctx, 1);
    for (let q = 0; q + 2 < e.lav.length; q += Q) { const i = e.lav[q]; const x = i % S.w; eastmost = Math.max(eastmost, x); }
  }
  molten = fo.filter((i) => S.tile[i] !== T.FOREST).length;
  assert.ok(eastmost >= 54, 'the tongue runs east, down the slope: ' + eastmost);
  assert.ok(razed.length >= 1, 'a house on the path was razed by lava: ' + razed.length);
  assert.ok(molten >= 1, 'forest tiles on the path became lava / rock: ' + molten);
  assert.ok(eastmost <= 61, 'water at x=62 stops the tongue: ' + eastmost);
  for (let y = 36; y <= 60; y++) assert.equal(S.tile[y * S.w + 62], T.SHALLOW, 'water stays water');
  assert.equal(Powers.errors, 0);
  note(`tongue reached x=${eastmost}, razed ${razed.length} houses, ${molten} forest tiles turned to lava / rock`);
});

// ================================================================== destruction
section('footprint: every building on the cone is destroyed, the lost city is announced once, units on the crater die, far things are untouched', () => {
  const ctx = mkCtx(17), { S, Const, Powers, Units, Buildings, Cities, Log } = ctx, T = Const.T;
  arena(ctx, 48, 48, 14);
  const c = mkCity(ctx, 48, 48, 4);
  const near = [], far = [];
  for (const [dx, dy] of [[2, 0], [-2, 1], [0, -2], [3, 2], [-3, -2], [1, 3], [-2, -3], [4, 0]]) { const b = house(ctx, c.id, 48 + dx, 48 + dy); if (b) near.push([b.id, dx, dy]); }
  arena(ctx, 22, 22, 6);
  const c2 = mkCity(ctx, 22, 22, 3); const farHouse = house(ctx, c2.id, 24, 22);
  assert.ok(near.length >= 6 && farHouse, 'setup');
  const farUnit = Units.spawn(0, 20.5, 80.5, {});
  const th0 = [...S.buildings.values()].filter((b) => b.type === Const.B.TOWNHALL && b.cityId === c.id).length;
  assert.equal(th0, 1, 'the city has its town hall');
  const total0 = c.buildings.length;
  Powers.apply('volcano', 48.5, 48.5, 4, 'tap'); step(ctx, 59);
  const onCrater = Units.spawn(1, 48.5, 48.5, {}); onCrater.hp = 10; onCrater.state = 'idle'; onCrater.nextThink = 1e9;      // standing where the crater is about to open
  step(ctx, 1);
  const rb = 3 + 4 / 2;
  for (const b of S.buildings.values()) if (b.cityId === c.id) assert.ok(Math.hypot(b.x - 48, b.y - 48) > rb, 'a building survived on the cone: ' + b.type + ' at ' + b.x + ',' + b.y);
  for (const [id, dx, dy] of near) if (Math.hypot(dx, dy) <= rb) assert.equal(Buildings.get(id), null, 'house inside the cone destroyed');
  assert.equal(S.units.has(onCrater.id), false, 'a unit in the crater dies in the lava');
  assert.ok(S.units.has(farUnit.id) && farUnit.hp > 0);
  const lines = S.log.filter((l) => /^Лава уничтожила город/.test(l.msg));
  assert.equal(lines.length, 1, 'the destroyed city is announced exactly once: ' + JSON.stringify(lines.map((l) => l.msg)));
  assert.ok(lines[0].msg.includes('«' + c.name + '»'));
  assert.equal(S.log.filter((l) => /Лава уничтожила/.test(l.msg)).length, 1);
  step(ctx, 900);                                                                // the whole eruption: far things stay (the bombs reach 9 tiles)
  assert.ok(Buildings.get(farHouse.id), 'the other city, 36 tiles away, is untouched');
  assert.equal(S.log.filter((l) => /Лава уничтожила город/.test(l.msg)).length, 1, 'still one line');
  const noisy = S.log.filter((l) => l.tick > 0 && /(Проснулся|Лава)/.test(l.msg)).length;
  assert.ok(noisy <= 2, 'only the notable lines are logged: ' + noisy);
  assert.equal(Powers.errors, 0);
  note('city of ' + total0 + ' buildings razed; log: ' + lines[0].msg);
});

section('people run: units near the volcano flee when it wakes (not soldiers), and keep away from the bursts', () => {
  const ctx = mkCtx(19), { S, Const, Powers, Units } = ctx;
  arena(ctx, 48, 48, 14);
  const us = [];
  for (let k = 0; k < 14; k++) { const a = k / 14 * Math.PI * 2, d = 2 + (k % 4); us.push(Units.spawn(k % 3, 48.5 + Math.cos(a) * d, 48.5 + Math.sin(a) * d, {})); }
  const soldier = Units.spawn(0, 53.5, 48.5, {}); soldier.armyId = 99999; soldier.state = 'army';
  const d0 = us.map((u) => Math.hypot(u.x - 48.5, u.y - 48.5));
  Powers.apply('volcano', 48.5, 48.5, 3, 'tap');
  const fleeing = us.filter((u) => u.state === 'flee' && u.st && u.st.pk > S.tick).length;
  assert.ok(fleeing >= 11, 'most civilians panic at once: ' + fleeing + '/14');
  assert.equal(soldier.state, 'army', 'soldiers keep their orders');
  step(ctx, 45);
  const alive = us.filter((u) => S.units.has(u.id));
  const d1 = alive.map((u) => Math.hypot(u.x - 48.5, u.y - 48.5));
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(alive.length >= 12, 'nobody died while the ground was rising: ' + alive.length);
  assert.ok(mean(d1) > mean(d0) + 3, 'they ran away: ' + mean(d0).toFixed(1) + ' -> ' + mean(d1).toFixed(1));
  assert.equal(Powers.errors, 0);
});

// ================================================================== caps, replacement, re-eruption
section('caps: <= 3 volcanoes (the 4th replaces the oldest), a tap on a live cone re-erupts it, a tap on an extinct cone reopens it', () => {
  const ctx = mkCtx(21), { S, Const, Powers } = ctx, T = Const.T;
  const spots = [[20, 20], [48, 20], [76, 20], [20, 60]];
  for (const [x, y] of spots) arena(ctx, x, y, 8);
  const ids = [];
  for (let k = 0; k < 3; k++) { Powers.apply('volcano', spots[k][0] + 0.5, spots[k][1] + 0.5, 2, 'tap'); ids.push(vols(ctx)[k].id); step(ctx, 5); }
  assert.equal(vols(ctx).length, 3);
  step(ctx, 70);                                                                 // the oldest is erupting now
  const oldest = vols(ctx)[0];
  assert.ok(oldest.phase === 1);
  const ok = Powers.apply('volcano', spots[3][0] + 0.5, spots[3][1] + 0.5, 2, 'tap');
  assert.equal(ok, true); assert.ok(/затих/.test(Powers.lastMessage), 'toast about the replaced volcano: ' + Powers.lastMessage);
  assert.equal(vols(ctx).length, 3, 'still 3');
  assert.ok(!vols(ctx).some((e) => e.id === ids[0]), 'the oldest was replaced');
  assert.ok(vols(ctx).some((e) => e.id === ids[1]) && vols(ctx).some((e) => e.id === ids[2]));
  assert.equal(countTiles(ctx, T.LAVA, spots[0][0], spots[0][1], 14), 0, 'the replaced volcano is calmed down: no lava left');
  assert.deepEqual(S.mod.volcano.cones.map((c) => [c[0], c[1]]), [[spots[0][0], spots[0][1]]], 'and remembered as an extinct cone');
  assert.equal(S.tile[spots[0][1] * S.w + spots[0][0]], T.HILL, 'the extinct cone has its HILL core');
  // a tap on a live cone: no new entry, the eruption is renewed
  const live = vols(ctx).find((e) => e.id === ids[1]);
  step(ctx, 100);
  const until0 = live.until, nb0 = live.nb;
  Powers.apply('volcano', spots[1][0] + 2.3, spots[1][1] + 0.5, 5, 'tap');
  assert.equal(vols(ctx).length, 3); assert.ok(live.until >= until0 && live.nb === nb0 + 1, 're-erupt: a fresh burst, the eruption is renewed');
  assert.ok(/снова/.test(Powers.lastMessage), Powers.lastMessage);
  const early = vols(ctx).find((e) => e.id === ids[2]);
  // a tap on a volcano that is still rumbling only shakes
  const ctx2 = mkCtx(21); arena(ctx2, 48, 48, 8); ctx2.Powers.apply('volcano', 48.5, 48.5, 2, 'tap'); step(ctx2, 10);
  ctx2.Powers.apply('volcano', 49.5, 48.5, 2, 'tap'); assert.equal(vols(ctx2).length, 1); assert.ok(/уже просыпается/.test(ctx2.Powers.lastMessage));
  // an extinct cone wakes up again: short rumble, no new cone built
  const ctx3 = mkCtx(23); arena(ctx3, 48, 48, 12); ctx3.Powers.apply('volcano', 48.5, 48.5, 3, 'tap');
  let g = 0; while (vols(ctx3).length && g++ < 1600) step(ctx3, 1);
  assert.equal(vols(ctx3).length, 0); assert.equal(ctx3.S.mod.volcano.cones.length, 1);
  const snap = ctx3.S.tile.slice(), snapE = ctx3.S.elev.slice();
  ctx3.Powers.apply('volcano', 49.5, 49.5, 8, 'tap');                            // another brush size: the old cone is reused as it is
  assert.equal(vols(ctx3).length, 1); const e3 = vols(ctx3)[0];
  assert.equal(e3.old, 1); assert.equal(e3.r, 3, 'the cone keeps its size'); assert.equal(e3.until - e3.t0, 30, 'short rumble'); assert.equal(ctx3.S.mod.volcano.cones.length, 0);
  step(ctx3, 29);
  for (let y = 36; y <= 60; y++) for (let x = 36; x <= 60; x++) { const i = y * ctx3.S.w + x; if (snap[i] !== ctx3.S.tile[i] || snapE[i] !== ctx3.S.elev[i]) assert.fail('terrain changed during the rumble of an existing cone at ' + x + ',' + y); }
  step(ctx3, 1); assert.equal(e3.phase, 1); assert.equal(countTiles(ctx3, T.LAVA, 48, 48, 3), 9, 'the crater reopens');
  assert.equal(Powers.errors, 0); assert.equal(ctx3.Powers.errors, 0);
});

section('a volcano on the sea raises an island with a shallow shelf; flattened extinct cones are rebuilt from scratch', () => {
  const ctx = mkCtx(3), { S, Const, Powers, World } = ctx, T = Const.T;
  let spot = null;
  for (let y = 12; y < 84 && !spot; y += 2) for (let x = 12; x < 84 && !spot; x += 2) { let ok = true; for (let dy = -7; dy <= 7 && ok; dy++) for (let dx = -7; dx <= 7; dx++) if (S.tile[(y + dy) * S.w + x + dx] !== T.DEEP) { ok = false; break; } if (ok) spot = [x, y]; }
  assert.ok(spot, 'deep ocean found');
  const [cx, cy] = spot;
  Powers.apply('volcano', cx + 0.5, cy + 0.5, 3, 'tap'); step(ctx, 61);
  assert.equal(S.tile[cy * S.w + cx], T.LAVA);
  const rb = 4.5; let land = 0, deepNextToLand = 0;
  for (let y = cy - 8; y <= cy + 8; y++) for (let x = cx - 8; x <= cx + 8; x++) {
    const t = S.tile[y * S.w + x], d = Math.hypot(x - cx, y - cy);
    if (d <= rb) { assert.ok(t === T.HILL || t === T.MOUNTAIN || t === T.LAVA, 'island tile at d=' + d.toFixed(1)); land++; }
    if (t === T.DEEP) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const u = S.tile[(y + dy) * S.w + x + dx]; if (u === T.HILL || u === T.MOUNTAIN || u === T.LAVA) deepNextToLand++; }
  }
  assert.ok(land >= 60, 'island area ' + land);
  assert.equal(deepNextToLand, 0, 'deep water never touches the new land: a shallow shelf surrounds it');
  assert.ok(S.landDirty === true || World.landId(cx, cy + 2) > 0, 'land labels know about the island');
  step(ctx, 300);
  assert.equal(Powers.errors, 0); assert.equal(ctx.Sim.totalErrors, 0);
  // flatten an extinct cone: a tap there builds a new volcano (no reopen of a cone that is gone)
  const c2 = mkCtx(23); arena(c2, 48, 48, 12); c2.Powers.apply('volcano', 48.5, 48.5, 3, 'tap');
  let g = 0; while (vols(c2).length && g++ < 1600) step(c2, 1);
  arena(c2, 48, 48, 10);
  c2.Powers.apply('volcano', 48.5, 48.5, 3, 'tap');
  assert.equal(vols(c2)[0].old, 0, 'a flattened cone is rebuilt'); assert.equal(vols(c2)[0].until - vols(c2)[0].t0, 60);
});

// ================================================================== robustness
section('3000 ticks mixed with every other power on a living world: no exceptions, caps hold, state stays JSON-safe', () => {
  const ctx = mkCtx(31), { S, Const, Powers, ToolDefs, Sim, Units, R } = ctx;
  Sim.populate();
  step(ctx, 500);
  const tools = ToolDefs.filter((t) => t.tab === 'land' || t.tab === 'life' || t.tab === 'powers').map((t) => t.id);
  const calls = {}; let maxVol = 0, maxBombs = 0, maxLav = 0, maxFx = 0;
  const rnd = (a, b) => a + R.f() * (b - a);
  for (let k = 0; k < 120; k++) {
    // 25 ticks of play between god actions; the volcano gets a third of them
    const id = R.f() < 0.35 ? 'volcano' : tools[R.i(tools.length)];
    const x = rnd(4, 92), y = rnd(4, 92), r = 1 + R.i(8);
    for (const ph of ['tap']) { try { Powers.apply(id, x, y, r, ph); calls[id] = (calls[id] || 0) + 1; } catch (e) { assert.fail('Powers.apply threw for ' + id + ': ' + e.stack); } }
    step(ctx, 25);
    maxVol = Math.max(maxVol, vols(ctx).length);
    for (const e of vols(ctx)) { maxBombs = Math.max(maxBombs, e.bombs.length); maxLav = Math.max(maxLav, e.lav.length / Q); }
    maxFx = Math.max(maxFx, ctx.Fx.list.length);
    if (k % 20 === 0) {
      assert.ok(finiteDeep(S.eff) && finiteDeep(S.mod), 'finite numbers only');
      assert.equal(JSON.stringify(JSON.parse(JSON.stringify(S.eff))), JSON.stringify(S.eff), 'S.eff JSON round trip');
      for (const u of S.units.values()) assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y) && Number.isFinite(u.hp), 'unit state finite');
    }
  }
  assert.ok((calls.volcano || 0) >= 25, 'volcano taps: ' + calls.volcano);
  assert.ok(maxVol <= 3, 'never more than 3 volcanoes: ' + maxVol);
  assert.ok(maxBombs <= 24 && maxLav <= 56 && maxFx <= 401, `caps: bombs ${maxBombs}, lava ${maxLav}, fx ${maxFx}`);
  assert.equal(Powers.errors, 0, 'Powers errors: ' + (Powers.lastError && Powers.lastError.stack));
  assert.equal(ctx.Sim.totalErrors, 0, 'Sim errors: ' + (ctx.Sim.lastError && JSON.stringify(Object.keys(ctx.Sim.errors))));
  note(`${calls.volcano} volcano taps among ${Object.values(calls).reduce((a, b) => a + b, 0)} god actions; max ${maxVol} live volcanoes, ${maxBombs} bombs in flight, ${maxLav} lava tiles per volcano; ${S.units.size} units alive`);
});

section('afterLoad survives garbage in S.eff.volcanoes / S.mod.volcano (NaN, missing arrays, foreign entries)', () => {
  const ctx = mkCtx(3), { S, Powers } = ctx;
  arena(ctx, 48, 48, 10);
  S.eff.volcanoes = [null, 7, { x: NaN, y: 3 }, { x: 10.5, y: 10.5, t0: 0, until: 99 }, { x: 500, y: 1, t0: 0, until: 5 },
    { x: 48.5, y: 48.5, r: 'big', phase: 9, t0: 0, until: 5, bombs: [[1, 2], 'x', [0, 0, 5, 5, 0, 3, 2]], lav: [3, 4, 1, 130, 99999999, 1, 1, 130, 7, 8, 0], cr: ['a'], cb: [1], lg: ['z'], wd: 'x', rs: 'q' }];
  S.mod.volcano = { cones: [[1, 2], [48, 48, 3, 0], 'junk'] };
  Powers.afterLoad();
  assert.ok(vols(ctx).length >= 2 && vols(ctx).length <= 3);
  for (const e of vols(ctx)) { assert.ok(e.bombs.every((b) => b.length === 7)); assert.equal(e.lav.length % Q, 0); assert.ok(e.cr.length > 0); assert.ok(e.phase === 0 || e.phase === 1 || e.phase === 2); assert.ok(Number.isInteger(e.rs)); }
  assert.deepEqual(S.mod.volcano.cones, [[48, 48, 3, 0]]);
  step(ctx, 400);
  assert.equal(Powers.errors, 0); assert.equal(ctx.Sim.totalErrors, 0);
  // a world without S.mod.volcano / S.eff.volcanoes at all (old save) works too
  const c2 = mkCtx(3); delete c2.S.eff.volcanoes; delete c2.S.mod.volcano; c2.Powers.afterLoad(); step(c2, 5);
  arena(c2, 30, 30, 8); assert.equal(c2.Powers.apply('volcano', 30.5, 30.5, 3, 'tap'), true);
});

// ================================================================== save / load
section('save / load in the middle of an eruption: S.eff, S.mod and the terrain continue IDENTICALLY (rumble, eruption, cooling, extinct cone)', () => {
  // The part of the world a volcano owns is compared exactly. (The World's own random fire draws run in a different order after a load - its fire / lava lists are
  // rebuilt by tile index - so S.fire / units are not part of this digest; the volcano must not depend on them: private PRNG, lava re-asserted, sorted unit lists.)
  for (const [label, ticksBefore] of [['during the rumble', 25], ['mid-eruption (bombs in the air, lava on the ground)', 60 + 230], ['in the cooling phase', -1]]) {
    const ctx = mkCtx(41), { S, Powers, Save } = ctx;
    arena(ctx, 48, 48, 20, ctx.Const.T.SAND);
    Powers.apply('volcano', 48.5, 48.5, 4, 'tap');
    if (ticksBefore >= 0) step(ctx, ticksBefore); else { let g = 0; while (vols(ctx).length && vols(ctx)[0].phase !== 2 && g++ < 1200) step(ctx, 1); step(ctx, 20); }
    const e = vols(ctx)[0];
    assert.ok(e, 'the volcano is alive when saved (' + label + ')');
    if (ticksBefore > 100) assert.ok(e.phase === 1 && e.bombs.length > 0 && e.lav.length > 0, 'mid-eruption state: ' + JSON.stringify({ ph: e.phase, b: e.bombs.length, l: e.lav.length }));
    const ctx2 = loadSim();
    assert.ok(ctx2.Save.deserialize(Save.serialize()), 'deserialize');
    assert.equal(volcanoDigest(ctx2, 48, 48, 20), volcanoDigest(ctx, 48, 48, 20), label + ': identical right after the load');
    for (let blk = 0; blk < 24; blk++) {
      step(ctx, 50); step(ctx2, 50);
      assert.equal(volcanoDigest(ctx2, 48, 48, 20), volcanoDigest(ctx, 48, 48, 20), label + ': identical after ' + (blk + 1) * 50 + ' more ticks (tick ' + S.tick + ')');
    }
    assert.equal(vols(ctx).length, 0, 'the eruption ran to its end in both worlds'); assert.equal(ctx.S.mod.volcano.cones.length, 1);
    assert.equal(Powers.errors, 0); assert.equal(ctx2.Powers.errors, 0);
    note(label + ': saved at tick ' + (S.tick - 1200) + ' (+1200 ticks compared, 25 snapshots)');
  }
});

section('save / load in a living world (villages, forest fires, people fleeing): the volcano and the elevation field continue identically', () => {
  const ctx = mkCtx(41), { S, Powers, Sim, Save } = ctx;
  Sim.populate(); step(ctx, 600);
  let spot = null; for (const c of S.cities.values()) { spot = [c.x + 6, c.y + 2]; break; }
  if (!spot) { const u = [...S.units.values()][0]; spot = [Math.floor(u.x) + 4, Math.floor(u.y)]; }
  spot[0] = Math.max(8, Math.min(87, spot[0])); spot[1] = Math.max(8, Math.min(87, spot[1]));
  Powers.apply('volcano', spot[0] + 0.5, spot[1] + 0.5, 4, 'tap');
  step(ctx, 60 + 200);
  const e = vols(ctx)[0];
  assert.ok(e && e.phase === 1 && e.bombs.length > 0 && e.lav.length > 0, 'mid-eruption: ' + JSON.stringify({ ph: e && e.phase, b: e && e.bombs.length, l: e && e.lav.length }));
  const ctx2 = loadSim();
  assert.ok(ctx2.Save.deserialize(Save.serialize()), 'deserialize');
  const live = (c) => {                                                         // what depends on the volcano only (no city book-keeping, no fire)
    let h = 2166136261 >>> 0; for (let i = 0; i < c.S.elev.length; i++) h = Math.imul(h ^ c.S.elev[i], 16777619) >>> 0;
    return JSON.stringify({ tick: c.S.tick, v: vols(c).map((q) => { const o = { ...q }; delete o.cb; delete o.lg; return o; }), mod: c.S.mod.volcano, elev: h });
  };
  assert.equal(live(ctx2), live(ctx), 'identical right after the load');
  for (let blk = 0; blk < 16; blk++) { step(ctx, 50); step(ctx2, 50); assert.equal(live(ctx2), live(ctx), 'identical after ' + (blk + 1) * 50 + ' more ticks'); }
  assert.equal(Powers.errors, 0); assert.equal(ctx2.Powers.errors, 0); assert.equal(ctx2.Sim.totalErrors, 0);
  note(`${S.units.size} units, ${S.cities.size} cities, ${ctx.World.fireCount()} fires burning at the end; 800 ticks identical`);
});

// ================================================================== perf
section('perf: plugin step cost during eruptions (3 volcanoes, living world), worst tick of a cone build and of the tap itself', () => {
  const base = mkCtx(51), { S, Sim } = base;
  Sim.populate();
  const target = QUICK ? 500 : 900;
  let guard = 0; while (S.units.size < target && S.tick < 14000 && guard++ < 400) step(base, 50);
  note('world for the perf run: ' + S.units.size + ' units, ' + S.cities.size + ' cities, tick ' + S.tick);
  const json = base.Save.serialize();
  // CPU time of this process (microsecond resolution), not wall clock: the machine is shared with other agents and wall clock numbers are polluted by their load.
  // The simulation is deterministic, so the same scenario is REPLAYED three times from the saved world (same work in the same tick every time) and the cost of
  // every tick is the minimum over the replays: noise (other processes, GC, JIT warm-up) only ever adds time and never hits the same tick three times.
  const clock = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  const stat = (a) => { const s = a.slice().sort((p, q) => p - q); return { avg: a.reduce((x, y) => x + y, 0) / a.length, p99: s[Math.floor(s.length * 0.99)], max: s[s.length - 1] }; };
  const NT = QUICK ? 300 : 450;
  const attempt = () => {
    const ctx = loadSim(); assert.ok(ctx.Save.deserialize(json), 'deserialize'); const { S: S2, Powers, PowerVolcano } = ctx;
    const dts = []; const orig = PowerVolcano.step;                              // the plugin step is timed through the plugin object (Powers calls p.step(tick, host) every tick)
    PowerVolcano.step = function (t, h) { const a = clock(); orig.call(this, t, h); dts.push(clock() - a); };
    const sites = [...S2.cities.values()].sort((a, b) => b.pop - a.pop).slice(0, 3).map((c) => [c.x + 3, c.y + 1]);     // the three biggest cones around the busiest places
    while (sites.length < 3) sites.push([20 + sites.length * 25, 40]);
    const tapMs = [];
    for (const [x, y] of sites) { const a = clock(); Powers.apply('volcano', Math.max(8, Math.min(87, x)) + 0.5, Math.max(8, Math.min(87, y)) + 0.5, 8, 'tap'); tapMs.push(clock() - a); step(ctx, 3); }
    dts.length = 0;
    const build = [];
    for (let k = 0; k < 60; k++) { const a = clock(); stepN(ctx, 1); ctx.Fx.update(0.1); build.push(clock() - a); }
    const buildStep = dts.slice(); dts.length = 0;
    const tickMs = [];
    for (let k = 0; k < NT; k++) { const a = clock(); stepN(ctx, 1); ctx.Fx.update(0.1); tickMs.push(clock() - a); }
    PowerVolcano.step = orig;
    assert.ok(vols(ctx).length === 3 && vols(ctx).every((e) => e.phase === 1), 'three erupting volcanoes during the measurement');
    return { tapMs, buildStep, build, erupt: dts.slice(), tickMs };
  };
  const runs = [attempt(), attempt(), attempt()];
  const mins = (key) => runs[0][key].map((_, k) => Math.min(...runs.map((r) => r[key][k])));
  const tp = stat(mins('tapMs')), sb = stat(mins('buildStep')), bd = stat(mins('build')), se = stat(mins('erupt')), tk = stat(mins('tickMs'));
  note(`CPU ms (per-tick minimum of 3 identical replays) - tap (the cone is built over time): avg ${tp.avg.toFixed(2)}, worst ${tp.max.toFixed(2)}`);
  note(`CPU ms - plugin step while three r=8 cones rise: avg ${sb.avg.toFixed(3)}, worst tick ${sb.max.toFixed(2)}   (whole sim tick worst ${bd.max.toFixed(2)})`);
  note(`CPU ms - plugin step during 3 eruptions: avg ${se.avg.toFixed(3)}, p99 ${se.p99.toFixed(2)}, worst ${se.max.toFixed(2)}   (whole sim tick: avg ${tk.avg.toFixed(2)}, p99 ${tk.p99.toFixed(2)})`);
  assert.ok(se.avg < 0.3, 'average plugin step < 0.3 ms: ' + se.avg.toFixed(3));
  assert.ok(sb.max < 8 && tp.max < 8, 'no hitch: worst cone-build tick ' + sb.max.toFixed(2) + ' ms, tap ' + tp.max.toFixed(2) + ' ms (< 8 ms)');
  assert.ok(se.max < 8, 'worst eruption tick < 8 ms: ' + se.max.toFixed(2));
});

// ================================================================== browser
async function browserPart() {
  const { launch } = await import('./browser.mjs');
  const shots = args.shots || '/tmp/godsim-volcano-shots';
  fs.mkdirSync(shots, { recursive: true });
  const out = '/tmp/godsim-volcano.html';
  execFileSync('node', [path.join(root, 'build.mjs'), '--out=' + out, '--extra=tests/fixtures/volcano_hooks.js', '--check'], { cwd: root, stdio: 'pipe' });
  const b = await launch({ url: 'file://' + out, width: 390, height: 844, dpr: 2 });
  const E = (fn, arg) => b.eval(fn, arg);
  const check = (name, ok, info) => { if (ok) { results.push({ name, ok: true }); console.log('  ok   ' + name + (info !== undefined ? '  (' + info + ')' : '')); } else { results.push({ name, ok: false, e: new Error(info || '') }); console.log('  FAIL ' + name + (info !== undefined ? '  (' + info + ')' : '')); } };
  await b.page.waitForFunction(() => window.__god && window.__volc && document.querySelector('.tab'), null, { timeout: 20000 });
  await b.wait(500);
  // ---- the tool in the dock
  await E(() => window.__god.UI.selectTab('powers'));
  await b.wait(300);
  const tool = await E(() => {
    const btn = document.querySelector('.tool[data-tool="volcano"]');
    if (!btn) return null;
    const cv = btn.querySelector('canvas'); let lit = 0;
    if (cv) { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++; }
    const labels = [...document.querySelectorAll('.tool')].map((x) => x.getAttribute('data-tool'));
    return { label: btn.textContent.trim(), lit, order: labels.join(','), grp: [...document.querySelectorAll('.grp-lbl')].map((x) => x.textContent.trim()) };
  });
  check('tool button «Вулкан» is in the dock (disasters group) with a drawn icon', !!tool && tool.label === 'Вулкан' && tool.lit > 150, JSON.stringify(tool));
  // a large render of the icon for the eyes
  await E(() => { const c = window.__volc.Sprites.icon('volcano', 224); const el = document.createElement('div'); el.id = 'iconbig'; el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;background:#2a3550;padding:6px;border-radius:8px'; c.style.cssText = 'width:224px;height:224px;image-rendering:pixelated;display:block'; el.appendChild(c); document.body.appendChild(el); });
  await b.wait(200); await b.shot(shots + '/00_icon.png', { clip: { x: 0, y: 0, width: 260, height: 260 } });
  await E(() => document.getElementById('iconbig').remove());
  // ---- a world: flat arena, forest, a village
  const setup = await E(() => {
    const g = window.__god;
    g.Main.newWorld({ seed: 4, w: 96, h: 96, populate: false }); g.setSpeed(0);
    const S = g.S, T = g.Const.T, cx = 48, cy = 48, A = 20;
    for (let y = cy - A; y <= cy + A; y++) for (let x = cx - A; x <= cx + A; x++) { const i = y * S.w + x; S.fire[i] = 0; S.res[i] = 0; S.amt[i] = 0; g.World.setTile(x, y, T.GRASS, { elev: 130 + ((x * 7 + y * 13) % 9) }); }
    for (let k = 0; k < 90; k++) { const x = cx - 18 + ((k * 37) % 36), y = cy - 18 + ((k * 53) % 36); if (Math.hypot(x - cx, y - cy) > 8) g.World.setTile(x, y, T.FOREST); }
    // a village west of the cone
    const us = []; for (let i = 0; i < 5; i++) us.push(g.Units.spawn(0, cx - 9.5 + i * 0.4, cy + 0.5, {}));
    const c = g.Cities.found(0, cx - 9, cy, us);
    if (c) { for (const [dx, dy] of [[-2, -1], [2, -1], [-2, 2], [1, 2], [3, 0], [0, -3]]) g.Buildings.place(c.id, g.Const.B.HOUSE, c.x + dx, c.y + dy, { instant: true }); }
    for (let i = 0; i < 8; i++) g.Units.spawn(i % 3, cx - 8 + (i % 4), cy - 3 + (i >> 2) * 6, {});
    g.Render.setMode(0);
    return { city: c ? c.name : null, units: S.units.size };
  });
  check('test world built', setup.units >= 5, JSON.stringify(setup));
  const frames = (n = 2) => b.page.evaluate((n) => new Promise((r) => { let i = 0; const f = () => { if (++i >= n) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n);
  const view = (zoom, dx = 0, dy = -1.5) => E(({ zoom, dx, dy }) => { window.__god.Render.setCamera(48.5 + dx, 48.5 + dy, zoom); }, { zoom, dx, dy });
  const stepTo = async (n) => { await E((n) => window.__god.step(n), n); await frames(2); await b.wait(90); };
  const info = () => E(() => { const e = window.__god.S.eff.volcanoes[0]; return e ? { phase: e.phase, nb: e.nb, lav: e.lav.length / 3, bombs: e.bombs.length, until: e.until, t0: e.t0 } : null; });
  const pixelStats = (rect) => E((rect) => {
    const c = document.getElementById('game'), g = c.getContext('2d'), d = g.getImageData(rect.x, rect.y, rect.w, rect.h).data;
    let orange = 0, dark = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const r = d[i], gg = d[i + 1], bb = d[i + 2]; n++; if (r > 200 && gg > 80 && gg < 190 && bb < 90) orange++; if (r < 90 && gg < 80 && bb < 90 && Math.abs(r - gg) < 30) dark++; }
    return { orange: orange / n, dark: dark / n };
  }, rect);
  // device px of the crater for a given zoom (camera centre is 1.5 tiles north of the crater)
  const craterPx = (zoom) => E(({ zoom }) => { const p = window.__god.Render.tileToScreen(48.5, 48.5), d = window.__god.Render.size.dpr; return { x: p.x * d, y: p.y * d, z: zoom * d }; }, { zoom });
  await view(14);
  await E(() => window.__god.Powers.apply('volcano', 48.5, 48.5, 3, 'tap'));
  await frames(2); await b.wait(80);
  await b.shot(shots + '/10_tap_z14.png');
  const log1 = await E(() => window.__god.S.log.filter((l) => /Проснулся вулкан/.test(l.msg)).length);
  check('tap: the awakening is logged once', log1 === 1, String(log1));
  const marks = [[8, '11_rumble_early'], [30, '12_rumble_mid'], [56, '13_rumble_late']];
  let done = 0;
  for (const [t, name] of marks) { await stepTo(t - done); done = t; await b.shot(`${shots}/${name}_z14.png`); }
  let cp = await craterPx(14), ps = await pixelStats({ x: Math.max(0, Math.round(cp.x - 80)), y: Math.max(0, Math.round(cp.y - 60)), w: 160, h: 120 });
  check('rumble: the cone is drawn with a dark plume starting (smoke pixels above the crater)', ps.dark > 0.02, JSON.stringify(ps));
  await stepTo(64 - done); done = 64; await b.shot(shots + '/14_blast_z14.png');
  cp = await craterPx(14); ps = await pixelStats({ x: Math.round(cp.x - 60), y: Math.round(cp.y - 60), w: 120, h: 120 });
  check('opening blast + glowing crater: orange pixels around the crater', ps.orange > 0.08, JSON.stringify(ps));
  for (const z of [8, 24]) { await view(z); await frames(2); await b.wait(80); await b.shot(`${shots}/15_blast_z${z}.png`); }
  await view(14);
  await stepTo(120 - done); done = 120; await b.shot(shots + '/16_erupt_z14.png');
  await stepTo(260 - done); done = 260; await b.shot(shots + '/17_erupt_flow_z14.png');
  for (const z of [8, 24]) { await view(z); await frames(2); await b.wait(80); await b.shot(`${shots}/18_erupt_z${z}.png`); }
  const mid = await info();
  check('browser: eruption running with lava, bombs, burst counter', !!mid && mid.phase === 1 && mid.nb >= 3 && mid.lav > 5, JSON.stringify(mid));
  // ---- draw cost with a full eruption in view (zoom 8 and 14), against the same view without the volcano
  const measure = (n = 90) => E((n) => new Promise((res) => { let i = 0, sum = 0, worst = 0; function f() { const d = window.__god.Render.stats.drawMs || 0; sum += d; if (d > worst) worst = d; if (++i < n) requestAnimationFrame(f); else res({ avg: sum / i, worst }); } requestAnimationFrame(f); }), n);
  for (const z of [8, 14]) {
    await view(z); await b.wait(500);
    const withV = await measure();
    const saved = await E(() => { const g = window.__god; const v = g.S.eff.volcanoes; g.__held = v.slice(); v.length = 0; return v.length; });
    await b.wait(400);
    const without = await measure();
    await E(() => { const g = window.__god; for (const e of g.__held) g.S.eff.volcanoes.push(e); });
    await b.wait(300);
    const withV2 = await measure();
    const d = Math.min(withV.avg, withV2.avg) - without.avg;
    note(`zoom ${z}: draw ${without.avg.toFixed(2)} ms without the volcano, ${withV.avg.toFixed(2)} / ${withV2.avg.toFixed(2)} ms with it (delta ${d.toFixed(2)} ms, worst frame ${Math.max(withV.worst, withV2.worst).toFixed(1)} ms)`);
    check(`zoom ${z}: a full eruption in view costs <= 0.6 ms per frame (plume + glow + bombs; software GL)`, d <= 0.6, d.toFixed(2) + ' ms');
  }
  // ---- cooling, extinct cone
  await view(14);
  await E(() => { const e = window.__god.S.eff.volcanoes[0]; e.until = window.__god.S.tick + 2; });
  await stepTo(8); await b.shot(shots + '/20_cooling_begin_z14.png');
  await stepTo(60); await b.shot(shots + '/21_cooling_z14.png');
  await stepTo(120); await b.shot(shots + '/22_cooling_late_z14.png');
  await stepTo(60); await frames(3);
  const end = await E(() => ({ n: window.__god.S.eff.volcanoes.length, cones: window.__god.S.mod.volcano.cones.length }));
  await b.shot(shots + '/23_extinct_z14.png');
  check('the volcano went extinct by itself (entry removed, cone remembered)', end.n === 0 && end.cones === 1, JSON.stringify(end));
  for (const z of [8, 24]) { await view(z); await frames(2); await b.wait(80); await b.shot(`${shots}/24_extinct_z${z}.png`); }
  // ---- save / load keeps a running eruption (the plume is drawn right after the load)
  await view(14);
  await E(() => { window.__god.Powers.apply('volcano', 48.5, 48.5, 3, 'tap'); });
  await stepTo(150);
  const json = await E(() => window.__god.Save.serialize());
  await E((d) => { const g = window.__god; g.Save.deserialize(d); g.Main.worldReplaced('load'); g.setSpeed(0); g.Render.setMode(0); g.Render.setCamera(48.5, 47, 14); }, json);
  await frames(3); await b.wait(100);
  const after = await info();
  check('after a load the eruption goes on (state restored, drawn)', !!after && after.phase === 1, JSON.stringify(after));
  cp = await craterPx(14); ps = await pixelStats({ x: Math.round(cp.x - 60), y: Math.round(cp.y - 60), w: 120, h: 120 });
  check('...and the crater glows again right after the load', ps.orange > 0.05, JSON.stringify(ps));
  await b.shot(shots + '/25_after_load_z14.png');
  // ---- the real thing through the dock: select the tool and tap the map with touch events
  await E(() => { const g = window.__god; g.Main.newWorld({ seed: 6, w: 96, h: 96, populate: true }); g.setSpeed(0); });
  await b.wait(300);
  await E(() => { const g = window.__god; g.UI.selectTab('powers'); g.UI.selectTool('volcano'); const c = g.Main.largestSettlement() || { x: 48, y: 48 }; g.Render.setCamera(c.x + 8, c.y, 14); });
  await b.wait(400);
  await b.tap(195, 330);
  await b.wait(300);
  const tapped = await E(() => ({ n: window.__god.S.eff.volcanoes.length, tool: window.__god.UI.state.tool }));
  check('a real touch tap with the tool selected raises a volcano', tapped.n === 1 && tapped.tool === 'volcano', JSON.stringify(tapped));
  await E(() => window.__god.step(70)); await frames(2); await b.wait(100);
  await b.shot(shots + '/26_tap_in_game_z14.png');
  check('no page errors', b.errors.length === 0, b.errors.join(' | ').slice(0, 400));
  await b.close();
}

if (!args.nobrowser) { console.log('# browser: icon, tool button, rumble / blast / eruption / flow / cooling at zoom 8, 14, 24, draw cost, save / load, real touch tap'); try { await browserPart(); } catch (e) { results.push({ name: 'browser part', ok: false, e }); console.log('  FAIL browser part\n       ' + (e && e.stack || e).toString().split('\n').slice(0, 10).join('\n       ')); } }
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
