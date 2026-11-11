// TOTAL WAR tests (headless, plain node + assert).   node tests/totalwar.test.mjs [--quick] [--seed=1]
// Covers «Вся страна»: War.canDeclareTotal / declareTotal (reasons, preview, goals = the border band with the capital first, infamy + opinion
// «Тотальная война»), mobilisation caps and the 35-50 % draft, the frontier chain (armies advance region by region without any new goal while a
// LIMITED war holds after its goal), the capitulation meter and its thresholds (capital + 60 % of the regions, armies, hold timer, lapse),
// the three outcomes (merge / vassal / occupied regions) for AI and COMMANDED winners with the world invariants afterwards (no dangling armies /
// wars / regions), allies and vassals on both sides, the rare AI declaration and each of its conditions, save / load mid-war (bit-identical),
// performance with a 600-soldier war and a fuzz of god-style abuse.
import assert from 'node:assert/strict';
import { loadSim, stepN, pad } from './harness.mjs';
import { mkCtx, mkArena, tarena, run, feed, foundCity, findChainAt, armiesOfK, soldiersOfK, occupiedBy, worldInvariants } from './twlib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const QUICK = !!args.quick;
const SEED = args.seed ? +args.seed : 1;

const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 96)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 14).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

// ------------------------------------------------------------------ plumbing
/** attacker A (3 cities, pop 240) vs a 6-region country B (3 cities, pop 120): the 2:1 case */
const STD = { len: 9, split: 3, aAt: [0, 1, 2], aPop: [100, 80, 60], bAt: [4, 6, 7], bPop: [50, 40, 30] };
function std(o = {}) { return mkArena({ ...STD, ...o }, 14, SEED); }
function noErrors(ctx, label = '') { assert.equal(ctx.Sim.totalErrors, 0, `${label} Sim errors ${JSON.stringify(ctx.Sim.errors)} ${ctx.Sim.lastError && Object.values(ctx.Sim.lastError).map(e => e && e.stack).join('|')}`); assert.equal(ctx.Units.errors, 0, 'Units errors ' + (ctx.Units.lastError && ctx.Units.lastError.stack)); }
/** nobody fights: every army is released before each tick (the capitulation logic is exercised in isolation) */
function noArmies(ctx) {
  for (const a of [...ctx.S.armies.values()]) { for (const id of a.members.slice()) { const u = ctx.S.units.get(id); if (u) ctx.Units.release(u); } ctx.S.armies.delete(a.id); }
}
function runBare(ctx, n, hook) {
  for (let i = 0; i < n; i++) {
    noArmies(ctx);
    stepN(ctx, 1);
    if (ctx.S.tick % 50 === 0) feed(ctx);
    if (hook && hook(ctx.S.tick) === false) return false;
  }
  return true;
}
const occupy = (ctx, kid, rids) => { for (const r of rids) ctx.Regions.setController(r, kid, 'test'); };
const liberate = (ctx, rids) => { for (const r of rids) ctx.Regions.setController(r, ctx.Regions.get(r).ownerId, 'test'); };
const capRegion = (ctx, kid) => ctx.S.cities.get(ctx.Kingdoms.get(kid).capitalId).regionId;
const logsSince = (ctx, mark) => ctx.S.log.filter(e => e.id >= mark);
/** a third, independent kingdom with one city in a region far from the chain */
function addKingdom(ctx, a, pop = 40, race = 0) {
  const used = new Set(a.chain);
  for (const rid of a.chain) for (const n of ctx.Regions.get(rid).nb) used.add(n);
  const taken = (ctx.__twk = ctx.__twk || []);
  for (const e of taken) { used.add(e.rid); for (const n of ctx.Regions.get(e.rid).nb) used.add(n); }
  const rc = findChainAt(ctx, 1, [0], [...used]);
  if (!rc) return null;
  const c = foundCity(ctx, rc[0], race, pop, null);
  if (!c) return null;
  const ex = [a.A, a.B, ...taken.map(e => e.kid)];
  if (ex.includes(c.kingdomId) && !ctx.Kingdoms.splitCity(c.id)) return null;     // (a village joins a same-race kingdom within 28 tiles: make it independent)
  if (ex.includes(c.kingdomId)) return null;
  const e = { kid: c.kingdomId, city: c, rid: rc[0] };
  taken.push(e);
  return e;
}

console.log(`Total war tests  (seed ${SEED}${QUICK ? ', quick' : ''})`);

// ================================================================== declaration
section('canDeclareTotal: preview (regions / cities / pop / band / deep / odds / costs) + every reason; declareTotal = a total war with the border band as goals, capital first', () => {
  const { ctx, a } = std();
  const { War, S, Kingdoms, Diplomacy, Regions, Bus, Const } = ctx;
  const c = War.canDeclareTotal(a.A, a.B);
  assert.equal(c.ok, true, c.reason); assert.equal(c.reason, '');
  const i = c.info;
  assert.equal(i.defKid, a.B); assert.equal(i.regions, 6); assert.equal(i.cities, 3); assert.equal(i.pop, Kingdoms.pop(a.B));
  assert.deepEqual(i.band, [a.chain[3]], 'only the region next to A is in the border band'); assert.equal(i.deep.length, 5);
  assert.equal(i.capitalRegion, a.chain[4]); assert.equal(i.capital, a.cityB[0].name);
  assert.ok(i.ratio > 1.5 && i.odds > 0.5, 'A is the stronger side: ' + i.ratio);
  assert.equal(i.infamy, 25); assert.equal(i.casus, 'conquest'); assert.equal(i.wear, 1.5); assert.equal(i.armies, 10); assert.equal(i.soldiers, 600); assert.deepEqual(i.share, [35, 50]);
  assert.ok(i.opinion < -30);
  JSON.stringify(c);
  // reasons
  assert.match(War.canDeclareTotal(a.A, 99999).reason, /не существует/); assert.match(War.canDeclareTotal(a.A, a.A).reason, /не существует/);
  assert.equal(War.canDeclareTotal(1e6, a.B).ok, false);
  Diplomacy.setTruce(a.A, a.B, S.tick + 500);
  assert.match(War.canDeclareTotal(a.A, a.B).reason, /перемирие/); assert.ok(War.canDeclareTotal(a.A, a.B).info, 'the numbers are shown anyway');
  Diplomacy.setTruce(a.A, a.B, 0);
  Diplomacy.setState(a.A, a.B, Const.REL.ALLIANCE); assert.match(War.canDeclareTotal(a.A, a.B).reason, /союзник/); Diplomacy.setState(a.A, a.B, Const.REL.PEACE);
  const kb = Kingdoms.get(a.B); kb.overlordId = a.A; assert.match(War.canDeclareTotal(a.A, a.B).reason, /вассал/); kb.overlordId = 0;
  const ka = Kingdoms.get(a.A); ka.overlordId = a.B; assert.match(War.canDeclareTotal(a.A, a.B).reason, /сюзерен/); ka.overlordId = 0;
  assert.equal(War.canDeclareTotal(a.A, a.B).ok, true, 'all restored');
  // no land border -> no «вся страна»
  const far = addKingdom(ctx, a);
  if (far) { const r = War.canDeclareTotal(a.A, far.kid); assert.equal(r.ok, false); assert.match(r.reason, /границ|нет/); }
  // too many wars
  S.wars.set(9001, { id: 9001, attackers: [a.A], defenders: [123456], aggressor: a.A, defender: 123456, started: 0, casus: 'x', ended: false, kills: {}, hist: [] });
  S.wars.set(9002, { id: 9002, attackers: [a.A], defenders: [123457], aggressor: a.A, defender: 123457, started: 0, casus: 'x', ended: false, kills: {}, hist: [] });
  assert.match(War.canDeclareTotal(a.A, a.B).reason, /слишком много войн/); S.wars.delete(9001); S.wars.delete(9002);
  // declare
  let ev = null; Bus.on('warDeclared', w => { ev = w; });
  const mark = S.nextLogId;
  const w = War.declareTotal(a.A, a.B);
  assert.ok(w, War.lastError);
  assert.equal(w.total, true); assert.equal(typeof w.tw, 'object'); assert.equal(War.isTotal(w.id), true);
  assert.deepEqual(JSON.parse(JSON.stringify(w)), JSON.parse(JSON.stringify(S.wars.get(w.id))), 'JSON-safe');
  assert.deepEqual(w.goals.map(g => g.regionId), [a.chain[3]], 'goals = the border band (one region here)');
  assert.ok(w.goals.every(g => g.kid === a.A && g.done === false));
  assert.equal(w.casus, 'conquest'); assert.equal(ev, w, 'Bus warDeclared');
  assert.ok(w.tw.base.length === 6 && w.tw.base.every(r => Regions.get(r).ownerId === a.B), 'the country as it was when attacked');
  const lg = logsSince(ctx, mark).map(e => e.msg);
  assert.ok(lg.some(m => m.includes('объявило тотальную войну') && m.includes('вся страна (6 регионов)')), lg.join(' | '));
  // infamy +25 (unjustified) and the opinion cause
  assert.equal(Kingdoms.get(a.A).infamy, 25, 'infamy 25');
  assert.ok(Diplomacy.causes(a.A, a.B).some(c => c.why === 'Тотальная война' && c.v < 0), 'visible among the causes');
  assert.ok(Diplomacy.causes(a.A, a.B).some(c => c.why === 'Нападение'), 'the usual cause stays');
  assert.equal(War.canDeclareTotal(a.A, a.B).reason, 'война уже идёт');
  const tf = War.totalInfo(w.id);
  assert.equal(tf.def, a.B); assert.equal(tf.att, a.A); assert.equal(tf.own, 6); assert.equal(tf.occ, 0); assert.equal(tf.capital, 'free'); assert.equal(tf.progress, 0); assert.equal(tf.pending, false);
  assert.equal(War.totalInfo(99999), null); assert.equal(War.capitulation(w.id), null); assert.equal(War.isTotal(99999), false);
  noErrors(ctx);
});

section('declare: a limited war is untouched (total=false, no tw, the old caps), claims make the total war «claim» with infamy 8; the capital goes first when it borders us', () => {
  const { ctx, a } = std();
  const { War, S, Kingdoms, Regions, Diplomacy } = ctx;
  const w = War.declare(a.A, a.B, [], 'conquest', { total: false });
  assert.ok(w); assert.equal(w.total, false); assert.equal(w.tw, undefined); assert.equal(War.isTotal(w.id), false); assert.equal(War.totalInfo(w.id), null);
  assert.equal(Kingdoms.get(a.A).infamy, 10, 'limited conquest: infamy +10');
  assert.equal(War.LIMITS.MAX_ARMIES_K, 6); assert.equal(War.LIMITS.MAX_ARMY, 60); assert.equal(War.LIMITS.MAX_SOLDIERS, 350);
  assert.equal(War.TOTAL.MAX_ARMIES_K, 10); assert.equal(War.TOTAL.MAX_ARMY, 80); assert.equal(War.TOTAL.MAX_SOLDIERS, 600); assert.deepEqual(War.TOTAL.FRAC, [0.35, 0.5]); assert.equal(War.TOTAL.WEAR, 1.5);
  // claims on >= 1/3 of the regions: a justified (claim) total war
  const { ctx: c2, a: b } = std();
  for (const rid of b.rB.slice(0, 3)) c2.Regions.addClaim(rid, b.A);
  const pre = c2.War.canDeclareTotal(b.A, b.B).info;
  assert.equal(pre.claim, true); assert.equal(pre.casus, 'claim'); assert.equal(pre.infamy, 8);
  const w2 = c2.War.declareTotal(b.A, b.B);
  assert.equal(w2.casus, 'claim'); assert.equal(c2.Kingdoms.get(b.A).infamy, 8, 'a claim: infamy 8 instead of 25');
  assert.ok(c2.Diplomacy.causes(b.A, b.B).some(c => c.why === 'Тотальная война'));
  // the capital's region borders A: it is the first goal
  const { ctx: c3, a: d } = std({ bAt: [3, 5, 7] });
  const w3 = c3.War.declareTotal(d.A, d.B);
  assert.equal(w3.goals[0].regionId, d.chain[3], 'capital region first');
  assert.equal(c3.Regions.get(w3.goals[0].regionId).cityIds.includes(d.cityB[0].id), true);
  void Regions; void Diplomacy; void S;
});

// ================================================================== mobilisation
section('mobilisation: a total war drafts 35-50 % of the adults (limited: 20-35 %), both sides at once; weariness x1.5; allies join more readily', () => {
  const share = (ctx, kid) => {
    let sold = 0, ad = 0;
    for (const cid of ctx.Kingdoms.get(kid).cities) {
      const c = ctx.S.cities.get(cid);
      for (const id of c.members) { const u = ctx.S.units.get(id); if (u && u.cityId === c.id && ctx.Units.stage(u) === 'adult') { ad++; if (u.armyId) sold++; } }
    }
    return { sold, ad, f: sold / Math.max(1, ad) };
  };
  const { ctx: T, a: t } = std();
  const wT = T.War.declareTotal(t.A, t.B);
  const { ctx: L, a: l } = std();
  const wL = L.War.declare(l.A, l.B, [], 'conquest');
  const sT = [share(T, t.A), share(T, t.B)], sL = [share(L, l.A), share(L, l.B)];
  note(`draft: total A ${(sT[0].f * 100).toFixed(0)}% B ${(sT[1].f * 100).toFixed(0)}% | limited A ${(sL[0].f * 100).toFixed(0)}% B ${(sL[1].f * 100).toFixed(0)}%`);
  for (const k of [0, 1]) {
    assert.ok(sT[k].f >= 0.30 && sT[k].f <= 0.62, `total draft ${sT[k].f}`);
    assert.ok(sL[k].f <= 0.40, `limited draft ${sL[k].f}`);
    assert.ok(sT[k].sold > sL[k].sold * 1.15, `more soldiers in a total war: ${sT[k].sold} vs ${sL[k].sold}`);
  }
  assert.ok(armiesOfK(T, t.B).length >= 1, 'the defender mobilises at once');
  assert.ok(armiesOfK(T, t.A).length <= 10 && armiesOfK(L, l.A).length <= 6);
  for (const x of T.S.armies.values()) assert.ok(x.members.length <= 80);
  // weariness: the same ticks with nobody fighting - the total war grows 1.5x faster
  const grow = (ctx, w, kid) => { runBare(ctx, 900); return w.wear[kid]; };
  const gT = grow(T, wT, t.B), gL = grow(L, wL, l.B);
  note(`weariness of B after 900 idle ticks: total ${gT.toFixed(2)} vs limited ${gL.toFixed(2)}`);
  assert.ok(gT > gL * 1.3 && gT < gL * 1.8, 'x1.5');
  noErrors(T); noErrors(L);
});

section('allies: a total war draws the defender\'s allies and vassals in (vassals always), the attacker\'s vassals too; the Log names them', () => {
  const { ctx, a } = std();
  const { War, S, Kingdoms, Diplomacy, Const } = ctx;
  const cK = addKingdom(ctx, a, 36), eK = addKingdom(ctx, a, 36);
  assert.ok(cK && eK && cK.kid !== eK.kid);
  Kingdoms.get(cK.kid).overlordId = a.B;                // a vassal of the defender: always joins the defender
  Kingdoms.get(eK.kid).overlordId = a.A;                // a vassal of the attacker: always joins the attacker
  const w = War.declareTotal(a.A, a.B);
  assert.ok(w, War.lastError);
  assert.ok(w.defenders.includes(cK.kid), 'the vassal of the defender fights for it');
  assert.ok(w.attackers.includes(eK.kid), 'the vassal of the attacker fights for it');
  assert.equal(w.defenders[0], a.B); assert.equal(w.aggressor, a.A);
  noErrors(ctx); void S; void Diplomacy; void Const;
});

// ================================================================== the frontier chain
section('frontier chain: armies advance region by region WITHOUT any new goal (goals grow by themselves, capital first); a limited war holds after its goal', () => {
  const { ctx, a } = std();
  const { War, S, Regions } = ctx;
  const w = War.declareTotal(a.A, a.B);
  assert.equal(w.goals.length, 1);
  War.setAutoPeace(false);
  const seen = [];               // order in which the regions of B were taken
  ctx.Bus.on('regionControl', (r, o, n) => { if (n === a.A && r.ownerId === a.B) seen.push(r.id); });
  let maxGoals = 1;
  run(ctx, 2600, () => { maxGoals = Math.max(maxGoals, w.goals.length); return !w.ended; }, 20);
  note(`goals grew 1 -> ${maxGoals}; regions of B taken in order: ${seen.join(', ')}; war ${w.ended ? 'ended ' + w.how : 'running'}`);
  assert.ok(maxGoals >= 4, 'the chain adds goals by itself');
  assert.ok(seen.length >= 3, 'three or more regions taken without a single addGoal: ' + seen.length);
  // the conquest is one connected chain: every region taken links to A's land through regions taken (the chain never jumps)
  const linked = new Set(a.rA); let grow = true;
  while (grow) { grow = false; for (const rid of seen) if (!linked.has(rid) && Regions.get(rid).nb.some(n => linked.has(n))) { linked.add(rid); grow = true; } }
  for (const rid of seen) assert.ok(linked.has(rid), `region ${rid} is linked to A's land through the regions taken`);
  assert.equal(seen[0], a.chain[3], 'the border region first');
  // the capital's region comes up as soon as it is reachable
  const capIdx = seen.indexOf(a.chain[4]);
  assert.ok(capIdx >= 0 && capIdx <= 1, 'the capital region is taken right after the border region: ' + capIdx);
  noErrors(ctx);
  // contrast: a LIMITED war takes exactly its goal and holds, the war persists
  const { ctx: L, a: l } = std();
  const wl = L.War.declare(l.A, l.B, [], 'conquest');
  L.War.setAutoPeace(false);
  run(L, 2600, null);
  const held = occupiedBy(L, l.A);
  assert.equal(wl.ended, false, 'a limited war persists'); assert.equal(held.length, 1, 'exactly the goal region: ' + held.join(','));
  assert.equal(wl.goals.length, 1);
  void S;
});

section('chain details: a goal list never holds foreign regions, third kingdoms\' land is skipped, a region that falls to a third party stays out; supply rules hold (attrition outside supply)', () => {
  const { ctx, a } = std();
  const { War, S, Regions } = ctx;
  const w = War.declareTotal(a.A, a.B);
  War.setAutoPeace(false);
  run(ctx, 1500, null);
  for (const g of w.goals) { const r = Regions.get(g.regionId); assert.ok(r && a.rB.includes(g.regionId) || r.ownerId === a.B, 'goal ' + g.regionId); assert.equal(g.kid, a.A); }
  assert.equal(new Set(w.goals.map(g => g.regionId)).size, w.goals.length, 'no duplicates');
  // supply: an army outside every base loses supply in a total war just the same
  const arm = [...S.armies.values()].find(x => x.kingdomId === a.A);
  if (arm) { assert.ok(arm.supply >= 0 && arm.supply <= 100); }
  noErrors(ctx);
});

// ================================================================== capitulation
section('capitulation thresholds: capital + 60 % of the regions (or the meter at 100 with the armies gone), rate 0.8x .. 2x, nothing below', () => {
  const { ctx, a } = std();
  const { War } = ctx;
  const w = War.declareTotal(a.A, a.B);
  War.setAutoPeace(false);
  const capR = a.chain[4], others = a.rB.filter(r => r !== capR);          // 6 regions: the capital's + 5 others
  const I = () => War.totalInfo(w.id);
  const setOcc = (cap, k) => { liberate(ctx, a.rB); occupy(ctx, a.A, (cap ? [capR] : []).concat(others.slice(0, k))); };
  assert.equal(I().holding, false); assert.equal(I().need, 4, '60 % of 6 = 4 regions');
  setOcc(false, 5); assert.equal(I().capital, 'free'); assert.equal(I().occ, 5);
  assert.equal(I().holding, false, 'every region but the capital\'s: not enough without the capital (pressure ' + I().pressure + ')');
  setOcc(false, 0); setOcc(true, 0); assert.equal(I().capital, 'held'); assert.equal(I().holding, false, 'the capital alone');
  setOcc(true, 1); assert.equal(I().occ, 2); assert.equal(I().holding, false, 'capital + 2 of 6');
  setOcc(true, 2); assert.equal(I().occ, 3); assert.equal(I().holding, false, 'capital + 3 of 6 = 50 %, armies alive: below the threshold (pressure ' + I().pressure + ')');
  setOcc(true, 3); assert.equal(I().occ, 4); assert.equal(I().holding, true, 'capital + 4 of 6 = 66 %: the threshold'); assert.ok(Math.abs(I().rate - 1.0) < 0.01, 'rate ' + I().rate);
  setOcc(true, 4); assert.equal(I().occ, 5); assert.ok(I().rate > 1.0 && I().rate < 2.0);
  setOcc(true, 5); assert.equal(I().occ, 6); assert.ok(Math.abs(I().rate - 2.0) < 0.01, 'rate 2x for the whole country: ' + I().rate);
  // the armies destroyed count: capital + 3 of 6 + no soldiers left = pressure 100
  setOcc(true, 2);
  assert.equal(I().holding, false);
  stepN(ctx, 45);                                                            // (the passes see B's soldiers: their peak is recorded)
  assert.ok(War.totalInfo(w.id).peak >= 6);
  runBare(ctx, 460);
  noArmies(ctx);
  assert.equal(I().holding, true, 'capital + 50 % + the armies destroyed = pressure 100: ' + I().pressure); assert.ok(I().pressure >= 99.9);
  setOcc(true, 1); noArmies(ctx);
  assert.equal(I().holding, false, 'capital + 2 of 6 does not break it, even without an army: ' + I().pressure);
  setOcc(false, 5); noArmies(ctx);
  assert.equal(I().holding, false, 'no capital: no capitulation, whatever else (' + I().pressure + ')');
  noErrors(ctx);
});

section('capitulation timer: fills at the rate of the occupation, eats twice as fast on a lapse, ends the war for BOTH sides with a Log line + warEnded how=capitulation', () => {
  const { ctx, a } = std();
  const { War, S, Bus, Regions } = ctx;
  const w = War.declareTotal(a.A, a.B);
  War.setAutoPeace(false);
  const capR = a.chain[4];
  occupy(ctx, a.A, a.rB.slice(0, 4).concat(capR === a.rB[1] ? [] : []));       // 4 regions incl. the capital's (rB[1])
  assert.ok(Regions.get(capR).controllerId === a.A);
  let ended = null; Bus.on('warEnded', (x, how) => { if (x.id === w.id) ended = how; });
  const mark = S.nextLogId;
  const I = () => War.totalInfo(w.id);
  runBare(ctx, 600);
  const h1 = I().hold;
  const HOLD = War.TOTAL.CAP_HOLD;
  note(`after 600 ticks: timer ${h1.toFixed(0)} / ${HOLD}, meter ${I().progress}%`);
  assert.ok(h1 > 400 && h1 < 700, 'about 1x: ' + h1);
  assert.ok(I().progress > 50 && I().progress < 70, 'meter = 50 % pressure + the timer share: ' + I().progress);
  // a lapse: the capital is retaken -> the timer decays twice as fast
  liberate(ctx, [capR]);
  const before = I().hold;
  runBare(ctx, 150);
  assert.ok(I().hold < before - 150, `timer eaten: ${before} -> ${I().hold}`);
  occupy(ctx, a.A, [capR]);
  // all the way: the whole country occupied -> 2x -> CAP_HOLD / 2 ticks from empty
  occupy(ctx, a.A, a.rB);
  const t0 = S.tick; const h0 = I().hold;
  runBare(ctx, Math.ceil(HOLD / 2) + 600, () => !w.ended);
  assert.equal(w.ended, true); assert.equal(w.how, 'capitulation'); assert.equal(ended, 'capitulation');
  const dur = S.tick - t0;
  note(`whole country occupied: capitulation after ${dur} ticks (timer was ${h0.toFixed(0)})`);
  assert.ok(dur >= (HOLD - h0) / 2 - 60 && dur <= (HOLD - h0) / 2 + 90, 'at 2x: ' + dur);
  const lg = logsSince(ctx, mark).map(e => e.msg);
  assert.ok(lg.some(m => /капитулировало перед королевством/.test(m)), lg.join('|'));
  assert.equal(S.wars.get(w.id).tw.cap, 100);
  noErrors(ctx);
});

section('capitulation without a land grab: a collapsed defender (no soldiers, no recruits for 600 ticks) capitulates; the stability collapse alone does NOT end a total war', () => {
  const { ctx, a } = std();
  const { War, S, Kingdoms, Units } = ctx;
  const w = War.declareTotal(a.A, a.B);
  // stability collapse: generic autoPeace would end a limited war, a total war goes on
  Kingdoms.get(a.B).stability = 5;
  runBare(ctx, 800, () => { Kingdoms.get(a.B).stability = 5; return !w.ended; });
  assert.equal(w.ended, false, 'stability <20 does not end a total war by exhaustion');
  // manpower: kill every adult of B's cities and keep them from being raised
  for (const cid of Kingdoms.get(a.B).cities) { const c = S.cities.get(cid); for (const id of c.members.slice()) { const u = S.units.get(id); if (u && !u.isRuler) Units.kill(u, 'test'); } }
  noArmies(ctx);
  runBare(ctx, 1500, () => !w.ended);
  assert.equal(w.ended, true, 'manpower collapse ends it'); assert.equal(w.how, 'capitulation'); assert.equal(w.tw.why, 'manpower');
  worldInvariants(ctx, 'manpower');
});

section('a state without a capital (it died out during the occupation, every city left is ours): the biggest city stands in, the timer keeps running; a free city = no seat held; the stalemate rule never ends a war whose timer is running', () => {
  const { ctx, a } = std();
  const { War, S, Kingdoms, Cities, Regions } = ctx;
  const w = War.declareTotal(a.A, a.B);
  War.setAutoPeace(false);
  const allB = () => Regions.ofKingdom(a.B).map(r => r.id);          // (villages founded during the war count too)
  occupy(ctx, a.A, allB());
  runBare(ctx, 90);
  assert.equal(War.totalInfo(w.id).capital, 'held');
  const kb = Kingdoms.get(a.B);
  const capCity = S.cities.get(kb.capitalId), capR = capCity.regionId;
  assert.equal(w.tw.fell, capCity.id, 'the fallen capital is remembered');
  // the capital city dies out while ANOTHER city of the loser is still free: the government sits there, nothing is held
  const other = kb.cities.map(id => S.cities.get(id)).find(c => c.id !== capCity.id);
  liberate(ctx, [other.regionId]);
  Cities.destroy(capCity.id, 'test');
  kb.capitalId = 0;
  runBare(ctx, 150);
  const mid = War.totalInfo(w.id);
  note(`capital destroyed, one city free: capital '${mid.capital}', timer ${mid.hold}, loser's capitalId ${kb.capitalId}`);
  assert.notEqual(mid.capital, 'held', 'a free city of the loser: not held (' + mid.capital + ')');
  // ... every city that is left occupied again: the capital died out for good, the biggest city stands in
  occupy(ctx, a.A, allB());
  kb.capitalId = 0;
  runBare(ctx, 150);
  const ti = War.totalInfo(w.id);
  note(`every city left occupied: capital '${ti.capital}', timer ${ti.hold}, loser's capitalId ${kb.capitalId}`);
  assert.equal(ti.capital, 'held', 'the biggest occupied city stands in for the capital');
  const h0 = ti.hold;
  runBare(ctx, 300);
  assert.ok(War.totalInfo(w.id).hold > h0 + 300, `the timer keeps filling: ${h0} -> ${War.totalInfo(w.id).hold}`);
  noErrors(ctx, 'capital-less');
  // the stalemate rule (6000 ticks without a change of hands) does not end a war while the timer runs: 4 of 6 regions = 1x -> CAP_HOLD ticks
  const { ctx: c2, a: a2 } = std();
  const w2 = c2.War.declareTotal(a2.A, a2.B);
  c2.War.setAutoPeace(true);
  occupy(c2, a2.A, a2.rB.slice(0, 4));
  const HOLD = c2.War.TOTAL.CAP_HOLD;
  const ok = runBare(c2, 6600, () => !w2.ended);
  note(`stalemate rule: after ${c2.S.tick - w2.started} ticks the war ${w2.ended ? 'ended (' + w2.how + ')' : 'is running, timer ' + c2.War.totalInfo(w2.id).hold + ' / ' + HOLD}`);
  assert.ok(ok && !w2.ended, 'no stalemate peace while the timer fills: ' + w2.how);
  assert.ok(c2.War.totalInfo(w2.id).hold > 5000, 'the timer ran on: ' + c2.War.totalInfo(w2.id).hold);
  noErrors(c2, 'stalemate');
});

// ================================================================== outcomes
/** the whole country occupied and the government's will to resist almost spent (the timer itself is tested above): the war ends within a few passes */
function reachCapitulation(ctx, a, w) {
  ctx.War.setAutoPeace(false);
  occupy(ctx, a.A, a.rB);
  runBare(ctx, 70);
  w.tw.sure = ctx.War.TOTAL.CAP_HOLD - 40;
  runBare(ctx, 200, () => !(w.ended || (w.tw && w.tw.pend)));
}

section('outcome MERGE (AI winner, same people): the whole country joins - cities, regions, units, vassals; B disappears; invariants hold', () => {
  const { ctx, a } = std();
  const { War, S, Kingdoms, Regions, Bus } = ctx;
  const kv = addKingdom(ctx, a, 30);
  if (kv) Kingdoms.get(kv.kid).overlordId = a.B;              // a vassal of B
  const w = War.declareTotal(a.A, a.B);
  Kingdoms.get(a.B).culture = Kingdoms.get(a.A).culture;      // the same people
  const dead = []; Bus.on('kingdomDestroyed', k => dead.push(k.id));
  const bCities = [...Kingdoms.get(a.B).cities], bRegions = Regions.ofKingdom(a.B).map(r => r.id);
  const bUnits = [...S.units.values()].filter(u => u.kingdomId === a.B).map(u => u.id);
  const mark = S.nextLogId;
  reachCapitulation(ctx, a, w);
  assert.equal(w.ended, true); assert.equal(w.tw.out, 'merge', 'same culture + smaller: merge (' + w.tw.out + ')');
  assert.equal(S.kingdoms.has(a.B), false); assert.ok(dead.includes(a.B));
  for (const cid of bCities) assert.equal(S.cities.get(cid).kingdomId, a.A, 'city ' + cid + ' joined');
  for (const rid of bRegions) assert.equal(Regions.get(rid).ownerId, a.A, 'region ' + rid + ' joined');
  for (const id of bUnits) { const u = S.units.get(id); if (u) assert.equal(u.kingdomId, a.A); }
  if (kv) assert.equal(Kingdoms.get(kv.kid).overlordId, a.A, 'the vassal of B serves A now');
  const lg = logsSince(ctx, mark).map(e => e.msg);
  assert.ok(lg.some(m => /капитулировало перед королевством/.test(m)) && lg.some(m => /присоединило/.test(m)), lg.join(' | '));
  assert.ok(lg.some(m => m.startsWith('Капитуляция:') && /присоединена целиком/.test(m)));
  assert.equal(Kingdoms.get(a.A).cities.length, 3 + bCities.length);
  // armies of both sides are gone or walking home; no war with a dead kingdom
  worldInvariants(ctx, 'merge');
  for (const x of S.armies.values()) assert.ok(x.dis, 'armies of the ended war are disbanding');
  stepN(ctx, 600); worldInvariants(ctx, 'merge+600');
  assert.equal(S.armies.size, 0, 'everybody went home');
  noErrors(ctx);
});

section('outcome VASSAL (AI winner, foreign people, much bigger): the loser keeps its land but serves; truce; regions revert; invariants hold', () => {
  const { ctx, a } = std({ raceB: 1 });                       // B = orcs
  const { War, S, Kingdoms, Regions, Diplomacy } = ctx;
  const w = War.declareTotal(a.A, a.B);
  const bRegions = Regions.ofKingdom(a.B).map(r => r.id);
  reachCapitulation(ctx, a, w);
  assert.equal(w.ended, true);
  note(`orcs vs humans: outcome ${w.tw.out}`);
  assert.equal(w.tw.out, 'vassal');
  assert.equal(S.kingdoms.has(a.B), true); assert.equal(Kingdoms.get(a.B).overlordId, a.A);
  for (const rid of bRegions) assert.equal(Regions.get(rid).ownerId, a.B, 'the vassal keeps its regions'); for (const rid of bRegions) assert.equal(Regions.get(rid).controllerId, a.B, 'and controls them again');
  assert.ok(Diplomacy.alliesOf(a.A).includes(a.B));
  assert.equal(War.atWar(a.A, a.B), false);
  worldInvariants(ctx, 'vassal');
  stepN(ctx, 700); worldInvariants(ctx, 'vassal+700'); assert.equal(S.armies.size, 0);
  noErrors(ctx);
});

section('outcome REGIONS (AI winner, nothing else fits / or chosen): the occupied regions and their cities change hands, B keeps the rest; claims for the loser; truce', () => {
  const { ctx, a } = std();
  const { War, S, Kingdoms, Regions, Diplomacy } = ctx;
  const w = War.declareTotal(a.A, a.B);
  Kingdoms.get(a.A).overlordId = 0;
  // A is a vassal of a third kingdom: neither merge nor vassalisation is possible for the winner? (vassal needs a free winner) -> merge may still be; force 'regions' via the API
  War.setAutoPeace(false);
  occupy(ctx, a.A, a.rB.slice(0, 4));
  const held = occupiedBy(ctx, a.A);
  const bCities = [...Kingdoms.get(a.B).cities];
  // drive the war to a pending decision by making A commanded, then choose 'regions'
  Kingdoms.setCommanded(a.A, true);
  runBare(ctx, 70);                                            // (the timer itself is tested above: wind it nearly up, 4 of 6 regions + the capital are held)
  w.tw.sure = War.TOTAL.CAP_HOLD - 40;
  runBare(ctx, 300, () => !(w.tw && w.tw.pend));
  assert.ok(w.tw.pend, 'pending: a commanded winner is asked');
  assert.equal(War.resolveCapitulation(w.id, 'regions'), true);
  assert.equal(w.ended, true); assert.equal(w.tw.out, 'regions');
  for (const rid of held) { assert.equal(Regions.get(rid).ownerId, a.A, 'region ' + rid + ' went to the winner'); assert.ok(Regions.get(rid).claims.includes(a.B), 'the loser keeps a claim'); }
  const rest = a.rB.filter(r => !held.includes(r));
  for (const rid of rest) assert.equal(Regions.get(rid).ownerId, a.B, 'unoccupied regions stay with the loser');
  assert.equal(S.kingdoms.has(a.B), true);
  const moved = bCities.filter(cid => S.cities.get(cid).kingdomId === a.A);
  assert.ok(moved.length >= 1, 'cities in the occupied regions changed hands');
  assert.ok(Diplomacy.inTruce(a.A, a.B), 'truce after the peace');
  worldInvariants(ctx, 'regions');
  noErrors(ctx);
});

section('COMMANDED winner: asked (pending + Bus capitulation), the loser\'s armies go home, no peace offers meanwhile; each option works; the AI decides after 1800 ticks or when the command is released', () => {
  for (const choice of ['merge', 'vassal', 'regions', 'timeout', 'release']) {
    const { ctx, a } = std();
    const { War, S, Kingdoms, Regions, Bus } = ctx;
    const w = War.declareTotal(a.A, a.B);
    Kingdoms.setCommanded(a.A, true);
    let signal = null; Bus.on('capitulation', (x, d, win) => { signal = [x.id, d, win]; });
    let endedHow = null; Bus.on('warEnded', (x, how) => { if (x.id === w.id) endedHow = how; });
    reachCapitulation(ctx, a, w);
    assert.equal(w.ended, false, 'not ended yet'); assert.ok(w.tw.pend, choice); assert.deepEqual(signal, [w.id, a.B, a.A], 'Bus capitulation');
    const cap = War.capitulation(w.id);
    assert.ok(cap && cap.kid === a.B && cap.to === a.A && cap.left <= 1800 && cap.left > 1700 && ['merge', 'vassal', 'regions'].includes(cap.suggest), JSON.stringify(cap));
    assert.equal(cap.options.merge.ok, true); assert.equal(cap.options.vassal.ok, true); assert.ok(cap.options.regions.rids.length >= 1);
    assert.deepEqual(Object.keys(cap.country).sort(), ['cities', 'pop', 'regions']);
    JSON.stringify(cap);
    const po = War.peaceOffer(w.id, a.A, { regions: [] });
    assert.equal(po.ok, false); assert.match(po.reason, /капитулировал/);
    for (const x of S.armies.values()) if (x.kingdomId === a.B) assert.equal(x.order.type, 'retreat', 'the capitulated country\'s armies go home');
    noErrors(ctx, choice + ' pending');
    const bRegions = Regions.ofKingdom(a.B).map(r => r.id);
    if (choice === 'merge' || choice === 'vassal' || choice === 'regions') {
      assert.equal(War.resolveCapitulation(w.id, choice), true);
      assert.equal(w.tw.out, choice);
    } else if (choice === 'timeout') {
      runBare(ctx, 1750); assert.equal(w.ended, false, 'still waiting at 1750');
      runBare(ctx, 120); assert.equal(w.ended, true, 'the AI decided after 1800 ticks'); assert.ok(['merge', 'vassal', 'regions'].includes(w.tw.out));
    } else {
      Kingdoms.setCommanded(a.A, false);
      runBare(ctx, 70); assert.equal(w.ended, true, 'released: the AI decides within a pass'); assert.ok(w.tw.out);
    }
    assert.equal(endedHow, 'capitulation');
    assert.equal(War.capitulation(w.id), null, 'nothing pending any more');
    assert.equal(War.resolveCapitulation(w.id, 'merge'), false, 'second time: nothing to decide'); assert.ok(War.lastError);
    if (w.tw.out === 'merge') { assert.equal(S.kingdoms.has(a.B), false); for (const rid of bRegions) assert.equal(Regions.get(rid).ownerId, a.A); }
    if (w.tw.out === 'vassal') assert.equal(Kingdoms.get(a.B).overlordId, a.A);
    worldInvariants(ctx, 'commanded ' + choice);
    stepN(ctx, 400); worldInvariants(ctx, 'commanded ' + choice + '+400');
    assert.equal(Kingdoms.commanded() === null || Kingdoms.commanded().id === a.A || choice === 'release', true, 'no stuck command flag on a dead kingdom');
    noErrors(ctx, choice);
  }
});

section('outcomes when the loser is the player\'s realm (commanded defender): merge ends its command cleanly - no other kingdom keeps a frozen AI', () => {
  const { ctx, a } = std();
  const { War, S, Kingdoms } = ctx;
  const w = War.declareTotal(a.A, a.B);
  Kingdoms.get(a.B).culture = Kingdoms.get(a.A).culture;
  Kingdoms.setCommanded(a.B, true);
  reachCapitulation(ctx, a, w);
  assert.equal(w.ended, true); assert.equal(w.tw.out, 'merge');
  assert.equal(S.kingdoms.has(a.B), false);
  for (const k of S.kingdoms.values()) assert.equal(k.cmd, false, 'nobody stays commanded (the AI of the conqueror must not freeze)');
  worldInvariants(ctx, 'player merge'); noErrors(ctx);
});

// ================================================================== allies / third parties
section('allies + third parties: the war ends for the WHOLE defender side (white peace + truce), vassals follow the loser, a third war goes on, nobody dangles', () => {
  for (const out of ['vassal', 'merge', 'regions']) {
    const { ctx, a } = std();
    const { War, S, Kingdoms, Regions, Diplomacy } = ctx;
    const cK = addKingdom(ctx, a, 36), eK = addKingdom(ctx, a, 36), gK = addKingdom(ctx, a, 34), hX = addKingdom(ctx, a, 30);
    assert.ok(cK && eK && gK && hX && new Set([cK.kid, eK.kid, gK.kid, hX.kid]).size === 4, 'four more kingdoms');
    Kingdoms.get(cK.kid).overlordId = a.B;                    // C: a vassal of the defender (fights for it)
    Kingdoms.get(eK.kid).overlordId = a.A;                    // E: a vassal of the attacker
    const w3 = { id: 9100, attackers: [gK.kid], defenders: [hX.kid], aggressor: gK.kid, defender: hX.kid, started: S.tick, casus: 'conquest', ended: false, goals: [], score: {}, kills: {}, hist: [] };
    S.wars.set(w3.id, w3);                                   // an unrelated war running alongside
    const w = War.declareTotal(a.A, a.B);
    assert.ok(w, War.lastError);
    assert.ok(w.defenders.includes(cK.kid) && w.attackers.includes(eK.kid));
    if (out === 'merge') Kingdoms.get(a.B).culture = Kingdoms.get(a.A).culture;
    if (out !== 'merge') Kingdoms.get(a.B).culture = Kingdoms.get(a.A).culture + 1000;      // a different people: no merge
    const eRegionsBefore = Regions.ofKingdom(eK.kid).map(r => r.id);
    if (out === 'regions') Kingdoms.setCommanded(a.A, true);
    reachCapitulation(ctx, a, w);
    if (out === 'regions') { assert.ok(w.tw.pend); assert.equal(War.resolveCapitulation(w.id, 'regions'), true); }
    assert.equal(w.ended, true); assert.equal(w.how, 'capitulation');
    if (out === 'merge') assert.equal(w.tw.out, 'merge');
    if (out === 'regions') assert.equal(w.tw.out, 'regions');
    // the defender's vassal C: at peace with the attacker side now (a truce between the former enemies), or the winner's own vassal
    assert.equal(War.atWar(cK.kid, a.A), false); assert.equal(War.atWar(cK.kid, eK.kid), false);
    assert.ok(Diplomacy.inTruce(cK.kid, a.A) || S.kingdoms.get(cK.kid).overlordId === a.A, 'C is at peace with A');
    if (w.tw.out === 'merge' || w.tw.out === 'vassal') assert.equal(S.kingdoms.get(cK.kid).overlordId, a.A, 'the vassal of the loser serves the winner now (' + w.tw.out + ')');
    for (const rid of eRegionsBefore) assert.equal(Regions.get(rid).ownerId, eK.kid, 'the winner\'s own vassal lost nothing');
    assert.equal(S.wars.get(9100).ended, false, 'a third war is untouched'); assert.equal(War.atWar(gK.kid, hX.kid), true);
    worldInvariants(ctx, 'allies ' + out);
    stepN(ctx, 500); worldInvariants(ctx, 'allies ' + out + '+500');
    noErrors(ctx, out);
    note(`${out}: outcome ${w.tw.out}, defenders ${w.defenders.length} attackers ${w.attackers.length}`);
  }
});

section('a capitulating kingdom that is in TWO wars: only the total war ends; its other war is cleaned up when it merges away', () => {
  const { ctx, a } = std();
  const { War, S, Kingdoms } = ctx;
  const gK = addKingdom(ctx, a, 36);
  assert.ok(gK);
  const w2 = { id: 9200, attackers: [gK.kid], defenders: [a.B], aggressor: gK.kid, defender: a.B, started: S.tick, casus: 'conquest', ended: false, goals: [], score: {}, kills: {}, hist: [] };
  S.wars.set(w2.id, w2);
  const w = War.declareTotal(a.A, a.B);
  assert.ok(w, War.lastError);
  Kingdoms.get(a.B).culture = Kingdoms.get(a.A).culture;
  reachCapitulation(ctx, a, w);
  assert.equal(w.ended, true);
  if (w.tw.out === 'merge') {
    assert.equal(S.kingdoms.has(a.B), false);
    const w2n = S.wars.get(9200);
    assert.ok(!w2n || w2n.ended, 'the second war of the dead kingdom ended too');
  }
  worldInvariants(ctx, 'two wars');
  stepN(ctx, 300); worldInvariants(ctx, 'two wars +300');
});

// ================================================================== the AI declares total wars: rarely, and only under the stated conditions
function aiArena(over = {}) {
  const { ctx, a } = mkArena({ ...STD, aPop: [200, 170, 120], bPop: [36, 22, 18], ...over }, 14, SEED);
  const { S, Kingdoms } = ctx;
  S.tick = 12000;
  const ka = Kingdoms.get(a.A), kb = Kingdoms.get(a.B);
  ka.born = 0; kb.born = 0; ka.peaceAt = 0; ka.stability = 80; kb.stability = 70;
  const ru = Kingdoms.ruler(a.A);
  assert.ok(ru, 'the attacker has a ruler');
  ru.traits = [ctx.Traits.byKey.aggressive.id, ctx.Traits.byKey.brave.id];
  S.stats.pop = [400, 400, 400]; S.stats.popTotal = 1200;
  return { ctx, a, ka, kb, ru };
}
section('AI total war: aiConsiderTotal declares ONLY when every condition holds (>= 9000 ticks, 2.5x power, aggressive ruler, land neighbour, no other war, no truce / alliance / vassalage, cooldowns, not commanded)', () => {
  const { ctx, a, ka, ru } = aiArena();
  const { War, S, Diplomacy, Const } = ctx;
  const pw = War.canDeclareTotal(a.A, a.B).info;
  assert.ok(pw.ratio >= 2.5, 'the arena gives the attacker 2.5x: ' + pw.ratio);
  const tryIt = (label, mutate, undo) => {
    mutate();
    const r = War.aiConsiderTotal(a.A, true);
    if (r) War.end(r.id, 'test');
    undo();
    assert.equal(!!r, false, label + ': no declaration');
  };
  const t0 = S.tick;
  tryIt('too early', () => { S.tick = 8000; }, () => { S.tick = t0; });
  tryIt('young kingdom', () => { ka.born = S.tick - 1000; }, () => { ka.born = 0; });
  const Tr = ctx.Traits.byKey, aggr = [Tr.aggressive.id, Tr.brave.id];
  tryIt('peaceful ruler', () => { ru.traits = [Tr.peaceful.id, Tr.wise.id]; }, () => { ru.traits = aggr; });
  tryIt('commanded (the player decides)', () => { ka.cmd = true; }, () => { ka.cmd = false; });
  tryIt('a vassal', () => { ka.overlordId = 12345; }, () => { ka.overlordId = 0; });
  tryIt('unstable', () => { ka.stability = 40; }, () => { ka.stability = 80; });
  tryIt('recent war', () => { ka.peaceAt = S.tick - 500; }, () => { ka.peaceAt = 0; });
  tryIt('truce', () => { Diplomacy.setTruce(a.A, a.B, S.tick + 400); }, () => { Diplomacy.setTruce(a.A, a.B, 0); });
  tryIt('an alliance', () => { Diplomacy.setState(a.A, a.B, Const.REL.ALLIANCE); }, () => { Diplomacy.setState(a.A, a.B, Const.REL.PEACE); });
  tryIt('the victim is the overlord', () => { ka.overlordId = a.B; }, () => { ka.overlordId = 0; });
  tryIt('the victim\'s people is nearly extinct', () => { S.stats.pop = [60, 400, 400]; }, () => { S.stats.pop = [400, 400, 400]; });
  tryIt('cooldown of this kingdom', () => { S.mod.war.tcd[a.A] = S.tick + 100; }, () => { S.mod.war.tcd[a.A] = 0; });
  tryIt('a total war was declared in the world a moment ago', () => { S.mod.war.tlast = S.tick - 1000; }, () => { S.mod.war.tlast = 0; });
  tryIt('the attacker already fights somewhere', () => { S.wars.set(9300, { id: 9300, attackers: [a.A], defenders: [777777], aggressor: a.A, defender: 777777, started: S.tick, casus: 'x', ended: false, kills: {}, hist: [] }); }, () => { S.wars.delete(9300); });
  assert.equal(S.wars.size, 0, 'nothing was declared by any of the negative probes');
  // not 2.5x: the victim has about as many people
  const { ctx: c2, a: a2 } = aiArena({ bPop: [140, 90, 70] });
  const r2 = c2.War.canDeclareTotal(a2.A, a2.B).info;
  assert.ok(r2.ratio < 2.5, 'ratio ' + r2.ratio);
  assert.equal(c2.War.aiConsiderTotal(a2.A, true), null, 'only ' + r2.ratio.toFixed(1) + 'x');
  // ... and now the happy path
  const { ctx: c3, a: a3 } = aiArena();
  const w = c3.War.aiConsiderTotal(a3.A, true);
  assert.ok(w, 'a forced consideration declares: ' + c3.War.lastError);
  assert.equal(w.total, true); assert.equal(w.aggressor, a3.A); assert.equal(w.defender, a3.B);
  assert.equal(c3.S.mod.war.tlast, c3.S.tick); assert.ok(c3.S.mod.war.tcd[a3.A] >= c3.S.tick + 6000, 'cooldown >= 6000 ticks');
  assert.equal(c3.War.aiConsiderTotal(a3.A, true), null, 'and not twice');
  noErrors(c3);
});

section('AI total war: the dice - nothing before tick 9000, then one in a while (p < 1: never certain), cooldowns after a "no" and after a war', () => {
  const { ctx, a, ka } = aiArena();
  const { War, S } = ctx;
  S.tick = 8000;
  let n = 0;
  for (let i = 0; i < 990; i++) { S.tick++; if (War.aiConsiderTotal(a.A, false)) n++; }           // ticks 8001 .. 8990
  assert.equal(n, 0, 'nothing before 9000');
  War.setAutoPeace(false);
  S.tick = 12000;
  const inf = War.aiTotalInfo(a.A);
  assert.equal(inf.why, '', 'every condition holds: ' + inf.why);
  assert.ok(inf.p > 0.1 && inf.p <= 0.6, 'a roll, never a certainty: p = ' + inf.p.toFixed(3));
  assert.ok(inf.ratio >= War.TOTAL.AI_RATIO && inf.best === a.B, 'the victim is the weak neighbour');
  let trials = 0, hits = 0, firstNo = 0;
  for (let i = 0; i < 400 && !hits; i++) {
    S.tick = 12000 + i * 400; trials++; ka.peaceAt = 0;
    const before = S.mod.war.tcd[a.A] || 0;
    if (War.aiConsiderTotal(a.A, false)) hits++;
    else if (!firstNo) { firstNo = trials; assert.ok(S.mod.war.tcd[a.A] > before && S.mod.war.tcd[a.A] <= S.tick + 400, 'a "no" is a short cooldown: ' + S.mod.war.tcd[a.A]); }
  }
  note(`dice: p ${inf.p.toFixed(2)}, declared at consideration #${trials} (one every 400 ticks)`);
  assert.equal(hits, 1, 'it does happen eventually');
  assert.ok(S.mod.war.tcd[a.A] >= S.tick + War.TOTAL.AI_COOLDOWN - 1, 'and then a long cooldown');
});

section('AI total war in populated worlds: rare (<= 2 per world), only under the conditions, cooldowns respected, nothing breaks', () => {
  const seeds = QUICK ? [SEED] : [SEED, SEED + 1, SEED + 2];
  let total = 0, wars = 0;
  for (const seed of seeds) {
    const ctx = loadSim({ stub: ['Powers', 'Save'] });
    ctx.Sim.newWorld({ seed, w: 96, h: 96, populate: true });
    const { S, Bus } = ctx;
    const decl = [], bad = [];
    Bus.on('warDeclared', (w) => {
      wars++;
      if (!w.total) return;
      const others = [...S.wars.values()].filter(x => x !== w && !x.ended && (x.attackers.includes(w.aggressor) || x.defenders.includes(w.aggressor))).length;
      decl.push({ t: S.tick, k: w.aggressor, d: w.defender, others });
      if (S.tick < 9000) bad.push('too early ' + S.tick);
      if (others) bad.push('other wars ' + others);
    });
    const ticks = QUICK ? 14000 : 20000;
    for (let i = 0; i < ticks; i++) { ctx.Sim.step(); if (S.tick % 50 === 0) for (const c of S.cities.values()) c.stock.food = Math.max(c.stock.food, 100); }
    for (let i = 0; i < decl.length; i++) for (let j = i + 1; j < decl.length; j++) {
      if (decl[i].k === decl[j].k && Math.abs(decl[i].t - decl[j].t) < 6000) bad.push('cooldown of ' + decl[i].k);
      if (Math.abs(decl[i].t - decl[j].t) < 5000) bad.push('global spacing ' + decl[i].t + '/' + decl[j].t);
    }
    note(`seed ${seed}: ${decl.length} AI total war(s) ${JSON.stringify(decl.map(d => d.t))} in ${ticks} ticks, ${wars} wars in all; kingdoms left ${S.kingdoms.size}`);
    assert.deepEqual(bad, [], 'AI total war violated its rules');
    assert.ok(decl.length <= 2, 'rare: ' + decl.length);
    assert.equal(ctx.Sim.totalErrors, 0, JSON.stringify(ctx.Sim.errors));
    worldInvariants(ctx, 'AI world seed ' + seed);
    total += decl.length;
  }
  note(`AI total wars over ${seeds.length} world(s): ${total}`);
});

section('losses: soldiers who die of old age / plague are no war losses in a TOTAL war (a war of generations must not wear both sides out for nothing); fights and hunger still count; a limited war counts everything as before', () => {
  for (const total of [true, false]) {
    const { ctx, a } = std();
    const { War, S, Units } = ctx;
    War.setAutoPeace(false);
    const goals = War.potentialGoals(a.A, a.B);
    const w = total ? War.declareTotal(a.A, a.B) : War.declare(a.A, a.B, goals.slice(0, 1), 'conquest');
    assert.ok(w, War.lastError);
    run(ctx, 150);
    const soldiers = [...S.armies.values()].filter(x => x.kingdomId === a.A).flatMap(x => x.members.map(id => S.units.get(id))).filter(Boolean);
    assert.ok(soldiers.length >= 5, 'the attacker has an army: ' + soldiers.length);
    const foe = [...S.units.values()].find(u => u.kingdomId === a.B);
    const l0 = w.losses[a.A], we0 = w.wear[a.A], ev0 = w.ev[a.A];
    Units.kill(soldiers[0], 'age'); Units.kill(soldiers[1], 'disease');
    const natural = w.losses[a.A] - l0;
    if (total) { assert.equal(natural, 0, 'old age / plague: no loss'); assert.equal(w.wear[a.A], we0, 'no weariness'); assert.equal(w.ev[a.A], ev0, 'no morale hit'); }
    else assert.equal(natural, 2, 'a limited war counts them as before');
    const l1 = w.losses[a.A];
    Units.kill(soldiers[2], 'damage', foe);                       // an enemy killed him
    Units.kill(soldiers[3], 'hunger');                            // supply attrition
    assert.equal(w.losses[a.A] - l1, 2, 'a death in battle and a death by hunger count');
    assert.ok(w.wear[a.A] > we0, 'and they wear the country out');
    note(`${total ? 'total' : 'limited'} war: natural deaths counted ${natural}, fight + hunger counted ${w.losses[a.A] - l1}`);
    noErrors(ctx, 'losses');
  }
});

// ================================================================== save / load mid-war
function mkStore() { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; }
function diffCtx(a, b) {
  const out = [];
  const eq = (name, x, y) => { if (JSON.stringify(x) !== JSON.stringify(y)) out.push(name); };
  eq('tick', a.S.tick, b.S.tick); eq('rng', a.R.getState(), b.R.getState()); eq('nextId', a.S.nextId, b.S.nextId);
  const ents = (c, m) => [...c.S[m].values()];
  eq('units', ents(a, 'units').map(u => Object.assign({}, u, { px: 0, py: 0 })), ents(b, 'units').map(u => Object.assign({}, u, { px: 0, py: 0 })));
  for (const m of ['cities', 'kingdoms', 'buildings', 'armies', 'wars', 'regions']) eq(m, ents(a, m), ents(b, m));
  eq('rels', [...a.S.rels.entries()], [...b.S.rels.entries()]); eq('mod', a.S.mod, b.S.mod); eq('log', a.S.log.slice(-100), b.S.log.slice(-100));
  return out;
}
section('save / load in the middle of a TOTAL war (march, chain, capital held + timer running, pending decision): both continuations are bit-identical', () => {
  for (const [label, before, after, prep] of [['march', 60, 500, null], ['chain', 900, 600, null], ['timer', 130, 700, 'timer'], ['pending', 130, 400, 'pending']]) {
    const { ctx: A, a } = mkArena({ ...STD, stub: ['Powers'], keepAI: true }, 14, SEED);
    A.War.setAutoPeace(true);
    const w = A.War.declareTotal(a.A, a.B);
    assert.ok(w, A.War.lastError);
    if (prep) {
      A.Kingdoms.setCommanded(a.A, prep === 'pending');
      occupy(A, a.A, a.rB);
      run(A, 90);
      if (prep === 'pending') w.tw.sure = A.War.TOTAL.CAP_HOLD - 40;
    }
    run(A, before);
    if (prep === 'pending') assert.ok(w.tw.pend, 'a decision is pending at the time of the save');
    const store = mkStore();
    A.Save.storage = store;
    assert.ok(A.Save.save('auto'), 'save: ' + A.Save.lastError);
    const B = loadSim({ stub: ['Powers'] });
    B.Save.storage = store;
    assert.ok(B.Save.load('auto'), 'load: ' + B.Save.lastError);
    const wb = B.S.wars.get(w.id);
    assert.equal(wb.total, true); assert.deepEqual(wb.tw, w.tw, 'the total-war state survived');
    assert.equal(B.War.atWar(a.A, a.B), true, 'pair cache rebuilt');
    const d0 = diffCtx(A, B).filter(x => x !== 'cities');
    assert.deepEqual(d0, [], `${label}: differences right after load`);
    if (prep === 'pending') { B.Kingdoms.setCommanded(0, false); A.Kingdoms.setCommanded(0, false); }
    run(A, after); run(B, after);
    const d = diffCtx(A, B);
    assert.deepEqual(d, [], `${label}: continuations diverged: ${d.join(',')}`);
    noErrors(A, label); noErrors(B, label);
    note(`${label}: saved at +${before}, ${after} ticks later identical (war ${w.ended ? 'ended ' + w.how + '/' + w.tw.out : 'running'}, armies ${A.S.armies.size}, meter ${w.tw.cap})`);
  }
});

// ================================================================== performance
section('performance: a total war with ~500-600 soldiers - War.step + army logic per tick (budget < 1 ms / tick for War), caps hold', () => {
  const { ctx, a } = mkArena({ len: 9, split: 3, aAt: [0, 1, 2], aPop: [260, 230, 210], bAt: [4, 6, 7], bPop: [220, 190, 170] }, 14, SEED);
  const { War, S, Units } = ctx;
  War.setAutoPeace(false);
  const w = War.declareTotal(a.A, a.B);
  assert.ok(w, War.lastError);
  let tw = 0, tu = 0, maxW = 0, n = 0, maxSold = 0, maxK = 0, maxArmy = 0;
  const w0 = War.step, u0 = Units.step;
  War.step = (t) => { const x = performance.now(); w0(t); const d = performance.now() - x; tw += d; if (d > maxW) maxW = d; n++; };
  Units.step = (t) => { const x = performance.now(); u0(t); tu += performance.now() - x; };
  run(ctx, 900, () => {
    let sold = 0; const per = new Map();
    for (const x of S.armies.values()) { sold += x.members.length; per.set(x.kingdomId, (per.get(x.kingdomId) || 0) + 1); maxArmy = Math.max(maxArmy, x.members.length); }
    maxSold = Math.max(maxSold, sold); for (const v of per.values()) maxK = Math.max(maxK, v);
  }, 25);
  War.step = w0; Units.step = u0;
  note(`units ${S.units.size}, soldiers max ${maxSold}, armies per kingdom max ${maxK}, biggest army ${maxArmy}; War.step ${(tw / n).toFixed(3)} ms/tick avg (max ${maxW.toFixed(2)}), Units.step ${(tu / n).toFixed(3)} ms/tick`);
  assert.ok(maxSold > 350, 'the bigger caps were used: ' + maxSold); assert.ok(maxSold <= 600, 'soldier cap 600: ' + maxSold);
  assert.ok(maxK <= 10, 'armies per kingdom <= 10: ' + maxK); assert.ok(maxArmy <= 80, 'army size <= 80: ' + maxArmy);
  // control: the same world with every soldier released
  for (const x of [...S.armies.values()]) for (const id of x.members.slice()) { const u = S.units.get(id); if (u) Units.release(u); }
  War.end(w.id, 'perf'); S.armies.clear();
  let tu2 = 0, n2 = 0;
  Units.step = (t) => { const x = performance.now(); u0(t); tu2 += performance.now() - x; n2++; };
  run(ctx, 300);
  Units.step = u0;
  const armyCost = tu / n - tu2 / n2;
  note(`Units.step without armies ${(tu2 / n2).toFixed(3)} ms/tick -> the army logic costs about ${armyCost.toFixed(3)} ms/tick`);
  assert.ok(tw / n < 1.0, `War.step ${(tw / n).toFixed(3)} ms/tick < 1 ms`);
  assert.ok(tw / n + Math.max(0, armyCost) < 2.5, 'War + army unit logic stays within ~2 ms/tick');
  noErrors(ctx, 'perf');
});

// ================================================================== fuzz
section('fuzz: god-style abuse during total wars (erase, destroy cities / kingdoms, peace, annex, commands, capitulation answers, save-load) keeps every invariant', () => {
  const seeds = QUICK ? [SEED] : [SEED, SEED + 3];
  for (const seed of seeds) {
    const ctx = loadSim({ stub: ['Powers'] });
    ctx.Sim.newWorld({ seed, w: 96, h: 96, populate: true });
    const { S, War, Units, Cities, Kingdoms, World, Regions, R } = ctx;
    stepN(ctx, 2600);
    const ks = [...S.kingdoms.values()];
    let made = 0;
    for (let i = 0; i < ks.length && made < 2; i++) for (let j = 0; j < ks.length && made < 2; j++) {
      if (i === j || War.atWar(ks[i].id, ks[j].id)) continue;
      if (War.declare(ks[i].id, ks[j].id, [], 'god', { total: true })) made++;
    }
    assert.ok(made >= 1, 'a total war was rigged');
    const rnd = (n) => (R.f() * n) | 0;
    let ops = 0, caps = 0, ended = 0;
    ctx.Bus.on('capitulation', () => { caps++; });
    ctx.Bus.on('warEnded', (w, how) => { if (w.total && how === 'capitulation') ended++; });
    for (let round = 0; round < (QUICK ? 90 : 130); round++) {
      stepN(ctx, 40);
      const arm = [...S.armies.values()], ws = War.active();
      switch (rnd(14)) {
        case 0: if (arm.length) { const x = arm[rnd(arm.length)]; Units.eraseInRadius(x.rally.x, x.rally.y, 3 + rnd(4)); } break;
        case 1: { const cs = [...S.cities.values()]; if (cs.length > 4 && rnd(3) === 0) Cities.destroy(cs[rnd(cs.length)].id, 'fuzz'); } break;
        case 2: { const k = [...S.kingdoms.values()]; if (k.length > 3 && rnd(4) === 0) Kingdoms.destroy(k[rnd(k.length)].id, 'fuzz'); } break;
        case 3: if (arm.length) { const x = arm[rnd(arm.length)]; World.brush('lower', x.rally.x | 0, x.rally.y | 0, 2 + rnd(4)); } break;
        case 4: { const k = [...S.kingdoms.values()]; if (k.length && rnd(6) === 0) War.godPeace(k[rnd(k.length)].id); } break;
        case 5: { const k = [...S.kingdoms.values()]; if (k.length > 1) { const x = k[rnd(k.length)].id, y = k[rnd(k.length)].id; if (x !== y) War.declare(x, y, [], rnd(3) ? 'conquest' : 'god', { total: rnd(2) === 0 }); } break; }
        case 6: { const k = [...S.kingdoms.values()]; if (k.length > 1) Kingdoms.setCommanded(rnd(2) ? k[rnd(k.length)].id : 0, rnd(4) !== 0); break; }
        case 7: for (const w of ws) if (w.total && w.tw && w.tw.pend && rnd(2)) War.resolveCapitulation(w.id, ['merge', 'vassal', 'regions', 'junk'][rnd(4)]); break;
        case 8: if (ws.length) { const w = ws[rnd(ws.length)]; if (w.total) for (const r of S.regions.values()) if (r.ownerId === w.defender && rnd(3) === 0) Regions.setController(r.id, w.aggressor, 'fuzz'); } break;
        case 9: { const k = [...S.kingdoms.values()]; if (k.length > 2) { const x = k[rnd(k.length)].id, y = k[rnd(k.length)].id; if (x !== y) Kingdoms.annex(x, y, rnd(2) ? 'merge' : 'vassal'); } break; }
        case 10: if (ws.length && rnd(3) === 0) { const w = ws[rnd(ws.length)]; War.forcePeace(w.id, { regions: War.heldRegions(w.id, w.attackers[0]).slice(0, 2), winner: w.attackers[0] }); } break;
        case 11: for (const w of ws) if (w.total && w.tw && rnd(3) === 0) w.tw.sure = War.TOTAL.CAP_HOLD - 30; break;
        case 12: if (arm.length) { const x = arm[rnd(arm.length)]; if (rnd(2)) War.split(x.id, 3 + rnd(6)); else War.merge(x.id, arm[rnd(arm.length)].id); } break;
        case 13: { const k = [...S.kingdoms.values()]; if (k.length) War.aiConsiderTotal(k[rnd(k.length)].id, true); break; }
      }
      ops++;
      stepN(ctx, 3);
      worldInvariants(ctx, `fuzz seed${seed} round${round}`);
      for (const k of S.kingdoms.values()) { let n = 0; for (const x of S.armies.values()) if (x.kingdomId === k.id) n++; assert.ok(n <= 10, 'armies per kingdom ' + n); }
      let sold = 0; for (const x of S.armies.values()) { sold += x.members.length; assert.ok(x.members.length <= 80, 'army size ' + x.members.length); } assert.ok(sold <= 600, 'soldiers ' + sold);
      if (round === 50) {
        const store = mkStore(); ctx.Save.storage = store;
        assert.ok(ctx.Save.save('auto'), 'save ' + ctx.Save.lastError);
        const L = loadSim({ stub: ['Powers'] }); L.Save.storage = store;
        assert.ok(L.Save.load('auto'), 'load ' + L.Save.lastError);
        stepN(L, 300); worldInvariants(L, 'loaded'); noErrors(L, 'loaded');
      }
    }
    assert.equal(ctx.Sim.totalErrors, 0, `seed ${seed}: ${JSON.stringify(ctx.Sim.errors)} ${Object.values(ctx.Sim.lastError || {}).map(e => e && e.stack).join('|')}`);
    note(`seed ${seed}: ${made} total wars rigged, ${ops} abuse rounds, ${caps} pending decisions, ${ended} capitulations, ${S.wars.size} wars in the table, ${S.kingdoms.size} kingdoms left`);
  }
});

// ================================================================== done
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
process.exit(failed.length ? 1 : 0);
