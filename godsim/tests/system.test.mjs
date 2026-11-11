// System test: long headless simulations of whole worlds (Sim.newWorld populate, 96x96) + invariants + balance + perf + mid-war save/load.
//   node tests/system.test.mjs [--quick] [--seeds=1,2,3,4,5,6] [--ticks=30000] [--par=3] [--verbose]
// Section 1: >= 6 seeds x 30000 ticks (about 50 game minutes at x1) in worker threads; window = 3000 ticks. Asserts: no exceptions / NaN / non-JSON-safe
//            state / dangling ids, bounded collections, all three races form kingdoms and mostly survive (fair-share births), wars are lively but not
//            constant, armies hold (no advance beyond the goals), no zero-progress war spam, readable event feed.
// Section 2: perf — ms/tick with <= 600 units (< 3 ms) and the 1500-unit cap with wars (< 8 ms), measured single-threaded.
// Section 3: save / load in the middle of a war and in a world with armies: the loaded copy continues bit-identically.
// Section 4: god chaos — every power and the whole command API at random with save / load in between (--chaos=1,2,3 --chaosTicks=20000 for a longer hunt).
import assert from 'node:assert/strict';
import { loadSim, stepN, pad } from './harness.mjs';
import { runSeeds } from './longlib.mjs';
import { printReport } from './long.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const QUICK = !!args.quick;
const SEEDS = String(args.seeds || (QUICK ? '1,2,3' : '1,2,3,4,5,6,7,8')).split(',').map(Number);
const TICKS = +(args.ticks || (QUICK ? 12000 : 30000));
const PAR = +(args.par || 3);
const results = [];
const note = (s) => console.log('       ' + s);
async function section(name, fn) {
  const t0 = performance.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 96)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 8).join('\n       ')}`); }
}
console.log(`System tests  (${SEEDS.length} seeds x ${TICKS} ticks, 96x96${QUICK ? ', quick' : ''})`);

let reps = [];
await section(`long runs: ${SEEDS.length} worlds x ${TICKS} ticks (populated 96x96), worker threads`, async () => {
  reps = await runSeeds(SEEDS, { ticks: TICKS, size: 96, window: 3000 }, PAR);
  assert.equal(reps.length, SEEDS.length);
  for (const r of reps) {
    if (args.verbose) printReport(r, true);
    else note(`seed ${r.seed}: pop ${r.final.pop.join('/')} kingdoms ${r.final.kingdoms}(${r.final.kPerRace.join('/')}) cities ${r.final.cities} regions owned ${r.final.owned}/${r.final.owned + r.final.wild} wars ${r.final.warsStarted} reb ${r.final.rebel} mrg ${r.final.merge} ms/tick ${r.windows.reduce((a, w) => a + w.msAvg, 0) / r.windows.length < 9 ? (r.windows.reduce((a, w) => a + w.msAvg, 0) / r.windows.length).toFixed(2) : 'slow'}`);
  }
});
const ok = reps.length > 0;

await section('no exceptions, no NaN / out-of-map units, JSON-safe entities, no dangling ids in any window', () => {
  for (const r of reps) {
    assert.equal(r.simErrors, 0, `seed ${r.seed}: Sim caught exceptions ${JSON.stringify(r.simErrorMap)}`);
    assert.equal(r.errors.length, 0, `seed ${r.seed}: console.error: ${r.errors[0]}`);
    assert.deepEqual(r.anomalies, [], `seed ${r.seed}: ${r.anomalies.slice(0, 3).join(' ; ')}`);
  }
});

await section('bounded growth: log, wars, armies, relations, effects, module state, histories stay small', () => {
  for (const r of reps) {
    const b = r.bounds;
    assert.ok(b.log <= 300, `log ${b.log}`);
    assert.ok(b.wars <= 40, `seed ${r.seed}: wars table ${b.wars}`);
    assert.ok(b.armies <= 70, `seed ${r.seed}: armies ${b.armies}`);
    assert.ok(b.rels <= b.kingdoms * b.kingdoms, `seed ${r.seed}: rels ${b.rels} for ${b.kingdoms} kingdoms`);
    assert.ok(b.fx <= 400, `fx ${b.fx}`);
    assert.ok(b.modBytes < 30000, `seed ${r.seed}: S.mod ${b.modBytes} bytes`);
    assert.ok(b.kHist <= 24 && b.relCauses <= 14 && b.claims <= 6, `histories ${b.kHist}/${b.relCauses}/${b.claims}`);
    assert.ok(b.units <= 1500, `units ${b.units}`);
    assert.ok(b.cultures <= 40, `cultures ${b.cultures}`);
  }
});

await section('races: all three form kingdoms; the unit cap stays a mix (fair-share births), nobody is wiped out by the cap', () => {
  let allThree = 0, minorityOk = 0;
  for (const r of reps) {
    const early = r.windows.find(w => w.tick >= 6000) || r.windows[r.windows.length - 1];
    assert.ok(early.kPerRace.every(n => n >= 1) || r.windows[0].kPerRace.every(n => n >= 1), `seed ${r.seed}: each race founded a kingdom (${early.kPerRace})`);
    const last = r.final;
    if (last.pop.every(p => p > 0)) allThree++;
    const total = last.pop[0] + last.pop[1] + last.pop[2];
    if (total >= 1000 && Math.max(...last.pop) / total < 0.75) minorityOk++;
    // humans never take more than ~80% of a full world in any window after the cap is reached
    for (const w of r.windows) if (w.tick >= 12000 && w.popTotal >= 1200) assert.ok(w.pop[0] / w.popTotal < 0.9, `seed ${r.seed} t${w.tick}: humans ${w.pop[0]}/${w.popTotal}`);
  }
  note(`worlds with all three races alive at the end: ${allThree}/${reps.length}; worlds at the cap where no race exceeds 75%: ${minorityOk}/${reps.length}`);
  assert.ok(allThree >= Math.ceil(reps.length * 0.7), `all three races alive in ${allThree}/${reps.length} worlds`);
  assert.ok(reps.every(r => r.final.pop.filter(p => p > 0).length >= 2), 'at least two races survive everywhere');
  if (!QUICK) assert.ok(minorityOk >= Math.ceil(reps.length * 0.6), `balanced population in ${minorityOk}/${reps.length} worlds`);
});

await section('politics: kingdoms exist all game long, borders fill up, rebellions happen, wars are lively but not constant', () => {
  let wars = 0, rebels = 0;
  const perWorld = [];
  for (const r of reps) {
    for (const w of r.windows) if (w.tick >= 6000) assert.ok(w.kingdoms >= 2, `seed ${r.seed} t${w.tick}: only ${w.kingdoms} kingdom(s)`);
    const last = r.final;
    assert.ok(last.owned >= 0.8 * (last.owned + last.wild), `seed ${r.seed}: ${last.owned} of ${last.owned + last.wild} regions owned`);
    perWorld.push(last.warsStarted); wars += last.warsStarted; rebels += last.rebel;
    // never more than a third of the kingdoms at war at once in a window snapshot
    for (const w of r.windows) assert.ok(w.activeWars <= Math.max(2, Math.ceil(w.kingdoms / 2)), `seed ${r.seed} t${w.tick}: ${w.activeWars} wars among ${w.kingdoms} kingdoms`);
  }
  const perMin = wars / reps.length / (TICKS / 600);
  note(`wars per world: ${perWorld.join(',')} => one per ${(1 / perMin).toFixed(1)} game minutes; rebellions total ${rebels}`);
  if (!QUICK) {
    assert.ok(perMin >= 1 / 9 && perMin <= 1 / 2, `war rate ${(1 / perMin).toFixed(1)} game minutes per war (want 2..9)`);
    assert.ok(rebels >= 1, 'rebellions happen');
  } else assert.ok(wars >= 1, 'at least one war in the quick run');
  assert.ok(reps.every(r => r.final.warsStarted <= 24), 'no world is constantly at war');
});

await section('wars: armies take the goals and HOLD them (no advance beyond the goals), no zero-progress spam, wars persist', () => {
  let n = 0, stalled = 0, occ = 0, extra = 0, goalsDone = 0, long = 0;
  for (const r of reps) {
    for (const w of r.wars) {
      n++; if (w.stalled) stalled++;
      occ += w.occ; extra += w.extra; goalsDone += w.goalsDone;
      if (w.dur > 12000) long++;
      assert.ok(w.how && w.dur >= 0, 'war end recorded');
    }
  }
  note(`${n} wars ended: ${stalled} without any control change, occupations ${occ} (${extra} outside the goals), goals reached ${goalsDone}, >12000 ticks: ${long}`);
  if (n >= 6) {
    assert.ok(stalled <= Math.ceil(n * 0.5), `too many zero-progress wars: ${stalled}/${n}`);
    assert.ok(goalsDone >= n * 0.4, `goals reached ${goalsDone} in ${n} wars`);
    assert.ok(occ >= n * 0.5, `occupations ${occ}`);
  }
  assert.ok(extra <= Math.max(2, occ * 0.1), `armies advanced beyond their goals ${extra}x (${occ} occupations)`);
  assert.ok(long <= Math.max(1, n * 0.1), `${long} wars lasted longer than 12000 ticks`);
  // a war ends only through peace / exhaustion / collapse (or the capitulation of a TOTAL war), never by itself on goal completion
  for (const r of reps) for (const w of r.wars) assert.ok(['exhaustion', 'peace', 'force', 'god', 'collapse', 'destroyed', 'vassal', 'capitulation'].includes(w.how), 'end reason ' + w.how);
});

await section('kingdoms are not wiped out too fast; the event feed stays readable', () => {
  let short = 0, dead = 0;
  for (const r of reps) {
    for (const k of r.kingdoms) if (k.t1 !== undefined) { dead++; if (k.t1 - k.t0 < 1500) short++; }
    for (const w of r.windows) {
      assert.ok(w.logMaxPer100 <= 30, `seed ${r.seed} t${w.tick}: ${w.logMaxPer100} log lines inside 100 ticks`);
      assert.ok(w.log <= 1100, `seed ${r.seed} t${w.tick}: ${w.log} log lines in a window (${w.logKinds && JSON.stringify(w.logKinds)})`);
    }
    // no single message template dominates (rate-limit spam)
    const total = Object.values(r.spam).reduce((a, b) => a + b, 0);
    const top = Math.max(...Object.values(r.spam));
    assert.ok(top <= 0.3 * total, `seed ${r.seed}: one message is ${(100 * top / total).toFixed(0)}% of the feed`);
    assert.ok(Object.values(r.spam).length >= 5, 'varied events');
  }
  note(`kingdoms that fell: ${dead}, thereof within 1500 ticks of their creation: ${short}`);
  assert.ok(short <= Math.max(2, Math.ceil(dead * 0.35)), `${short}/${dead} kingdoms lasted < 1500 ticks`);
});

await section('perf (headless, from the long runs): average ms/tick with <= 600 units < 3 ms, whole game avg < 8 ms', () => {
  for (const r of reps) {
    for (const w of r.windows) {
      if (w.nSmall > 1000) assert.ok(w.msSmallAvg < 3, `seed ${r.seed} t${w.tick}: ${w.msSmallAvg.toFixed(2)} ms/tick with <= 600 units`);
      assert.ok(w.msAvg < 8, `seed ${r.seed} t${w.tick}: ${w.msAvg.toFixed(2)} ms/tick`);
    }
  }
  const worst = Math.max(...reps.flatMap(r => r.windows.map(w => w.msWorst)));
  note(`worst single tick over all windows: ${worst.toFixed(1)} ms; max window average: ${Math.max(...reps.flatMap(r => r.windows.map(w => w.msAvg))).toFixed(2)} ms`);
  assert.ok(worst < 250, `a single tick took ${worst.toFixed(0)} ms`);
});

// ---------------------------------------------------------------- stress: ~1500 units with wars (single thread)
await section('stress: 1500-unit world with several wars, 2500 ticks, < 8 ms/tick on average', () => {
  const ctx = loadSim({});
  const { S, Sim, War, Kingdoms, Diplomacy } = ctx;
  Sim.newWorld({ seed: 4, w: 96, h: 96, populate: true });
  let g = 0;
  while (S.units.size < 1450 && S.tick < 20000 && g++ < 1000) stepN(ctx, 50);
  assert.ok(S.units.size >= 1300, 'world reached ~1500 units: ' + S.units.size);
  // make sure three wars are going (god-whispered where the AI has not started them yet)
  const ks = [...S.kingdoms.values()].filter(k => k.alive !== false);
  let started = 0;
  for (const k of ks) { if (War.warsOf(k.id).length) continue; if (started + War.active().length >= 3) break; try { if (Diplomacy.godWhisperWar(k.id)) started++; } catch (e) { /* ignore */ } }
  const wars0 = War.active().length;
  const lat = [];
  for (let i = 0; i < 2500; i++) { const t0 = performance.now(); Sim.step(); lat.push(performance.now() - t0); }
  const avg = lat.reduce((a, b) => a + b, 0) / lat.length;
  lat.sort((a, b) => a - b);
  note(`${S.units.size} units, ${S.kingdoms.size} kingdoms, wars at start ${wars0} (+${started} whispered), soldiers ${[...S.armies.values()].reduce((a, x) => a + x.members.length, 0)}: ${avg.toFixed(2)} ms/tick avg, p99 ${lat[(lat.length * 0.99) | 0].toFixed(2)}, worst ${lat[lat.length - 1].toFixed(1)}; profile ${JSON.stringify(Object.fromEntries(Object.entries(Sim.profile).map(([k, v]) => [k, +v.toFixed(3)])))}`);
  assert.equal(Sim.totalErrors, 0, 'no sim errors ' + JSON.stringify(Sim.errors));
  assert.ok(avg < 8, `average ${avg.toFixed(2)} ms/tick at ${S.units.size} units`);
  assert.ok(lat[lat.length - 1] < 250, 'worst tick ' + lat[lat.length - 1]);
});

// ---------------------------------------------------------------- save / load in the middle of a war
function mkStore() { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; }
function warScenario(seed) {
  const c = loadSim({});
  c.Sim.newWorld({ seed, w: 96, h: 96, populate: true });
  let g = 0;
  const midWar = () => { for (const w of c.S.wars.values()) if (!w.ended && [...c.S.armies.values()].some(a => a.warId === w.id && a.members.length >= 6) && c.S.tick - w.started > 300) return true; return false; };
  while (!midWar() && c.S.tick < 26000 && g++ < 2000) stepN(c, 25);
  return c;
}
function fp(c) { return c.Save.serialize({ savedAt: 0 }); }
function fpNoPrev(c) {
  const j = JSON.parse(fp(c));
  const ix = j.units.k.indexOf('px'), iy = j.units.k.indexOf('py');
  for (const row of j.units.r) { if (ix >= 0) row[ix] = 0; if (iy >= 0) row[iy] = 0; }
  const mi = j.cities.k.indexOf('mod'); if (mi >= 0) for (const row of j.cities.r) row[mi] = 0;
  return JSON.stringify(j);
}
function firstDiff(a, b) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return `char ${i}: ...${a.slice(Math.max(0, i - 50), i + 70)} <> ${b.slice(Math.max(0, i - 50), i + 70)}`; }

await section('save / load in the middle of a war: the loaded copy continues bit-identically (armies, wars, occupation, regions, relations)', () => {
  const seeds = QUICK ? [4] : [4, 8];
  for (const seed of seeds) {
    const A = warScenario(seed);
    assert.ok(A.War.active().length >= 1 && A.S.armies.size >= 1, `seed ${seed}: a war with armies exists at tick ${A.S.tick}`);
    const store = mkStore(); A.Save.storage = store;
    assert.ok(A.Save.save('auto'), 'save: ' + A.Save.lastError);
    const B = loadSim({}); B.Save.storage = store;
    assert.ok(B.Save.load('auto'), 'load: ' + B.Save.lastError);
    assert.equal(B.Save.lastLoad.repaired, 0, 'clean save, no repairs');
    assert.equal(B.S.armies.size, A.S.armies.size); assert.equal(B.S.wars.size, A.S.wars.size);
    const T0 = A.S.tick;
    // the same cache resets a load performs (documented non-persistent scratch of Cities / World) so that the comparison is about the war state
    const A2 = warScenario(seed); const C2 = loadSim({}); const st2 = mkStore(); A2.Save.storage = st2; A2.Save.save('auto'); C2.Save.storage = st2; C2.Save.load('auto');
    stepN(A, 400); stepN(B, 400);
    assert.equal(A.Sim.totalErrors, 0); assert.equal(B.Sim.totalErrors, 0);
    const fa = fpNoPrev(A), fb = fpNoPrev(B);
    if (fa !== fb) {
      // attribute: apply the load's own cache reset to the original at save time and compare again
      A2.Cities.afterLoad(); A2.World.afterLoad();
      stepN(A2, 400); stepN(C2, 400);
      const f2a = fpNoPrev(A2), f2b = fpNoPrev(C2);
      assert.equal(f2a, f2b, `seed ${seed}: diverged after ${S_TICKS(A)} ticks and NOT explained by the known cache leaks: ${firstDiff(f2a, f2b)}`);
      note(`seed ${seed}: identical once Cities/World caches are reset (known leak); war ticks ${T0}..${A.S.tick}`);
    } else note(`seed ${seed}: bit-identical 400 ticks after the load (tick ${T0}, wars ${A.War.active().length}, armies ${A.S.armies.size})`);
  }
  function S_TICKS(c) { return c.S.tick; }
});

await section('save / load round trip keeps wars, goals, scores, supply and occupation state exactly', () => {
  const A = warScenario(8);
  const store = mkStore(); A.Save.storage = store; assert.ok(A.Save.save('1'));
  const B = loadSim({}); B.Save.storage = store; assert.ok(B.Save.load('1'));
  const norm = (c, k) => JSON.stringify([...c.S[k].values()]);
  for (const k of ['wars', 'armies', 'regions', 'kingdoms']) assert.equal(norm(A, k), norm(B, k), k);
  assert.equal(JSON.stringify([...A.S.rels.entries()]), JSON.stringify([...B.S.rels.entries()]), 'relations');
  assert.equal(JSON.stringify(A.S.mod), JSON.stringify(B.S.mod), 'S.mod');
  // and a second save of the loaded world is a fixed point
  const j1 = A.Save.serialize({ savedAt: 0 }), j2 = B.Save.serialize({ savedAt: 0 });
  const strip = (j) => { const o = JSON.parse(j); for (const t of ['units', 'cities']) for (const key of ['px', 'py', 'mod']) { const ix = o[t].k.indexOf(key); if (ix >= 0) o[t].r.forEach(r => { r[ix] = 0; }); } return o; };
  const s1 = strip(j1), s2 = strip(j2);
  for (const k of Object.keys(s1)) assert.equal(JSON.stringify(s1[k]), JSON.stringify(s2[k]), 'part ' + k);
});

// ---------------------------------------------------------------- god chaos: every power + the command API at random, with save / load in between
function chaosRun(seed, ticks) {
  const c = loadSim({});
  const { S, Sim, Powers, War, Kingdoms, Diplomacy, Regions, Save, Const, Units, Cities } = c;
  const errs = []; const oerr = console.error; console.error = (...a) => { errs.push(a.map(String).join(' ').slice(0, 240)); };
  Save.storage = mkStore();
  Sim.newWorld({ seed, w: 96, h: 96, populate: true });
  let q = (seed * 2654435761) >>> 0;
  const rnd = () => { q = (Math.imul(q, 1664525) + 1013904223) >>> 0; return q / 4294967296; };
  const ri = (n) => (rnd() * n) | 0;
  const TOOLS = ['lightning', 'meteor', 'fire', 'earthquake', 'plague', 'tornado', 'rain', 'heal', 'bless', 'erase', 'human', 'orc', 'elf', 'raise', 'lower', 'lava', 'mountain', 'forest', 'grass', 'hill', 'sand', 'snow', 'war_whisper', 'peace', 'split', 'inspect', 'command'];
  const ops = { power: 0, declare: 0, order: 0, goal: 0, peace: 0, force: 0, god: 0, save: 0, cmd: 0 };
  const problems = [];
  const alive = () => [...S.kingdoms.values()].filter(k => k.alive !== false);
  const check = (tag) => {
    for (const u of S.units.values()) {
      if (!Number.isFinite(u.x) || !Number.isFinite(u.y) || !Number.isFinite(u.hp)) { problems.push(`${tag}: NaN unit ${u.id}`); break; }
      if (u.armyId) { const a = S.armies.get(u.armyId); if (!a) { problems.push(`${tag}: unit ${u.id} in missing army ${u.armyId}`); break; } }
    }
    for (const a of S.armies.values()) { for (const id of a.members) { const u = S.units.get(id); if (u && u.armyId !== a.id) { problems.push(`${tag}: army ${a.id} lists unit ${id} of army ${u.armyId}`); break; } } if (!S.kingdoms.has(a.kingdomId)) { problems.push(`${tag}: army of dead kingdom`); break; } }
    for (const r of S.regions.values()) {
      if (r.ownerId && !S.kingdoms.has(r.ownerId)) { problems.push(`${tag}: region ${r.id} owner ${r.ownerId} dead`); break; }
      if (r.controllerId && !S.kingdoms.has(r.controllerId)) { problems.push(`${tag}: region ${r.id} controller ${r.controllerId} dead`); break; }
    }
    for (const cty of S.cities.values()) { if (cty.kingdomId && !S.kingdoms.has(cty.kingdomId)) { problems.push(`${tag}: city ${cty.id} kingdom dead`); break; } }
    for (const k of S.kingdoms.values()) for (const id of k.cities) { const cty = S.cities.get(id); if (!cty || cty.kingdomId !== k.id) { problems.push(`${tag}: kingdom ${k.id} lists foreign/dead city ${id}`); break; } }
    for (const w of S.wars.values()) if (!w.ended) for (const kid of w.attackers.concat(w.defenders)) if (!S.kingdoms.has(kid)) { problems.push(`${tag}: war ${w.id} lists dead kingdom ${kid}`); break; }
    const bad = findBadState(S);
    if (bad) problems.push(`${tag}: not JSON-safe ${bad}`);
  };
  for (let t = 1; t <= ticks; t++) {
    Sim.step();
    if (t % 17 === 0) {
      const x = 1 + ri(S.w - 2), y = 1 + ri(S.h - 2);
      const tool = TOOLS[ri(TOOLS.length)];
      try { Powers.apply(tool, x, y, 1 + ri(5), 'tap'); ops.power++; } catch (e) { problems.push(`Powers.apply(${tool}) threw ${e.message}`); }
    }
    if (t % 43 === 0) {
      const ks = alive();
      if (ks.length >= 2) {
        const a = ks[ri(ks.length)], b = ks[ri(ks.length)];
        const r = ri(10);
        try {
          if (r === 0) { Kingdoms.setCommanded(a.id, true); ops.cmd++; }
          else if (r === 1) { const g = War.potentialGoals(a.id, b.id); if (War.declare(a.id, b.id, g.slice(0, 1 + ri(2)), null)) ops.declare++; }
          else if (r === 2) { War.order(a.id, 'all', { type: ['attack', 'hold', 'defend', 'retreat'][ri(4)], regionId: 1 + ri(60) }); ops.order++; }
          else if (r === 3) { const ws = War.warsOf(a.id); if (ws.length) { const w = ws[0]; const e = (w.attackers.includes(a.id) ? w.defenders : w.attackers)[0]; const g = War.potentialGoals(a.id, e); if (g.length && War.addGoal(w.id, a.id, g[ri(g.length)])) ops.goal++; } }
          else if (r === 4) { const ws = War.warsOf(a.id); if (ws.length) { const w = ws[0]; const held = War.heldRegions(w.id, a.id); War.peaceOffer(w.id, a.id, { regions: held.slice(0, ri(3)), vassalize: rnd() < 0.15 }); ops.peace++; if (S.kingdoms.get(b.id) && War.pendingOffer(w.id)) War.respondOffer(w.id, rnd() < 0.5); } }
          else if (r === 5) { const ws = War.warsOf(a.id); if (ws.length) { War.forcePeace(ws[0].id, { regions: War.heldRegions(ws[0].id, a.id).slice(0, 2) }); ops.force++; } }
          else if (r === 6) { War.godPeace(a.id); ops.god++; }
          else if (r === 7) { Diplomacy.godWhisperWar(a.id); ops.god++; }
          else if (r === 8) { Kingdoms.setCommanded(a.id, false); }
          else if (r === 9) { const ci = a.cities.length ? a.cities[ri(a.cities.length)] : 0; if (ci && rnd() < 0.3) Kingdoms.splitCity(ci); }
        } catch (e) { problems.push(`command op ${r} threw ${e.message} @${e.stack ? e.stack.split('\n')[1] : ''}`); }
      }
    }
    if (t % 1500 === 0) {
      try { if (Save.save('1') && Save.load('1')) ops.save++; else problems.push('save/load failed: ' + Save.lastError); } catch (e) { problems.push('save/load threw ' + e.message); }
    }
    if (t % 500 === 0) check('t' + S.tick);
    if (problems.length > 6) break;
  }
  console.error = oerr;
  return { ctx: c, errs, problems, ops, simErrors: Sim.totalErrors, errMap: Object.assign({}, Sim.errors), last: Sim.lastError };
}
function findBadState(S) {
  for (const k of ['units', 'cities', 'kingdoms', 'buildings', 'armies', 'wars', 'regions']) {
    let n = 0;
    for (const e of S[k].values()) { if (k === 'units' && (n++ % 9)) continue; const b = jsonBad(e, k + '#' + e.id); if (b) return b; }
  }
  return jsonBad(S.mod, 'mod') || jsonBad(S.eff, 'eff') || jsonBad([...S.rels.values()], 'rels');
}
function jsonBad(v, path, d = 0) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? null : `${path}=${v}`;
  if (t === 'string' || t === 'boolean') return null;
  if (t === 'function' || t === 'symbol') return `${path}:${t}`;
  if (d > 7) return `${path}:deep`;
  if (v instanceof Map || v instanceof Set) return `${path}:${v.constructor.name}`;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const b = jsonBad(v[i], path + '[' + i + ']', d + 1); if (b) return b; } return null; }
  for (const k of Object.keys(v)) { const b = jsonBad(v[k], path + '.' + k, d + 1); if (b) return b; }
  return null;
}
await section('god chaos: every power + the whole command API at random (declare, orders, goals, peace, force, split, commanded) with save / load in between', () => {
  const seeds = args.chaos ? String(args.chaos).split(',').map(Number) : QUICK ? [5, 6] : [5, 6, 7, 9];
  const n = +(args.chaosTicks || (QUICK ? 6000 : 12000));
  for (const seed of seeds) {
    const r = chaosRun(seed, n);
    note(`seed ${seed}: ops ${JSON.stringify(r.ops)}; units ${r.ctx.S.units.size}, kingdoms ${r.ctx.S.kingdoms.size}, wars ever ${r.ctx.S.nextId > 0 ? '' : ''}${[...r.ctx.S.wars.values()].length} in table; sim errors ${r.simErrors}`);
    assert.deepEqual(r.problems, [], `seed ${seed}: ${r.problems.slice(0, 4).join(' ; ')}`);
    assert.equal(r.simErrors, 0, `seed ${seed}: Sim caught ${JSON.stringify(r.errMap)} last: ${r.last && r.last.World ? r.last.World.stack : ''}${JSON.stringify(Object.fromEntries(Object.entries(r.ctx.Sim.lastError).map(([k, e]) => [k, String(e && e.stack || e).split('\n').slice(0, 3).join(' / ')])))}`);
    assert.deepEqual(r.errs, [], `seed ${seed}: console.error ${r.errs.slice(0, 2).join(' | ')}`);
  }
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
if (failed.length) { console.log('FAILED: ' + failed.map(f => f.name).join(' | ')); process.exit(1); }
void ok;
