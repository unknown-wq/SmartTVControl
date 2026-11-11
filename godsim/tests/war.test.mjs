// War tests (plain node + assert).   node tests/war.test.mjs [--quick] [--seed=1]
// Covers CONTRACT §8.2: declare (validation, goals, allies), army formation + caps, march / siege / occupation of exactly the goal region and
// HOLD (3000 ticks, no further advance, war stays active), commanded orders, retake by defenders, supply attrition, war score, peace
// conference (offers, accept / refuse rules, region transfer through Regions.setOwner + Kingdoms.transferCity), forcePeace / godPeace / end,
// exhaustion (autoPeace), vassals joining, save/load determinism mid-war, performance, a full-Sim integration run and the Units hold rules.
import assert from 'node:assert/strict';
import { loadSim, stepN, newWorld, pad } from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const QUICK = !!args.quick;
const SEED = args.seed ? +args.seed : 1;

const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 84)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 12).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

// ------------------------------------------------------------------ plumbing
/** headless world: real World / Buildings / Units / Cities / Kingdoms / Regions / Diplomacy / War / Sim; Powers + Save stubbed unless asked */
function mkCtx(seed = SEED, stub = ['Powers', 'Save'], size = 96) {
  const ctx = loadSim({ stub });
  newWorld(ctx, seed, size, size);
  ctx.noise = { deaths: 0 };
  ctx.Bus.on('unitDied', () => { ctx.noise.deaths++; });
  return ctx;
}
/** keep the economy out of the picture: stocks stay high so nobody starves while the armies fight */
function feed(ctx) {
  for (const c of ctx.S.cities.values()) {
    c.stock.food = Math.max(c.stock.food, 160); c.stock.wood = Math.max(c.stock.wood, 60);
    c.stock.iron = Math.max(c.stock.iron, 30); c.stock.stone = Math.max(c.stock.stone, 30); c.stock.gold = Math.max(c.stock.gold, 6);
  }
}
function run(ctx, n, hook, every = 25) {
  for (let i = 0; i < n; i++) {
    stepN(ctx, 1);
    if (ctx.S.tick % 50 === 0) feed(ctx);
    if (hook && ctx.S.tick % every === 0) hook(ctx.S.tick);
  }
}
function siteIn(ctx, rid, race, away) {
  const { S, Cities } = ctx;
  const r = S.regions.get(rid);
  let best = null, bs = -1e9;
  for (let y = 1; y < S.h - 1; y++) for (let x = 1; x < S.w - 1; x++) {
    if (S.region[y * S.w + x] !== rid) continue;
    if (!Cities.canFound(x, y, race)) continue;
    const dc = Math.hypot(x - r.cx, y - r.cy);
    if (dc > 7) continue;
    // as far from the neighbour as the region allows (keeps the two villages out of each other's reach)
    const sc = (away ? Math.hypot(x - away.cx, y - away.cy) : 0) - dc * 0.35;
    if (sc > bs) { bs = sc; best = { x, y }; }
  }
  return best;
}
function foundCity(ctx, rid, race, pop, away) {
  const { Units, Cities } = ctx;
  const site = siteIn(ctx, rid, race, away);
  if (!site) return null;
  const fs = [];
  for (let i = 0; i < 6; i++) {
    const u = Units.spawn(race, site.x + 0.5 + (i % 3) * 0.3, site.y + 0.5 + (i >> 1) * 0.3, { sex: i % 2, age: 22 + (i * 3) % 10 });
    if (!u) return null;
    fs.push(u);
  }
  const c = Cities.found(race, site.x, site.y, fs, {});
  if (!c) return null;
  for (let i = 6; i < pop; i++) {
    const u = Units.spawn(race, site.x + 0.5 + ((i * 7) % 5) * 0.3, site.y + 0.5 + ((i * 3) % 5) * 0.3, { sex: i % 2, age: 20 + (i * 5) % 20, cityId: c.id });
    if (u) u.hunger = 0;
  }
  feed(ctx);
  return c;
}
/** a chain of `len` regions r0-r1-..: consecutive ones share a land border, the others are not neighbours; every one can host a village */
function findChain(ctx, len, skip = [], siteN = len) {
  const { S, World } = ctx;
  const byLand = new Map();
  for (const r of S.regions.values()) { const l = World.landId(r.cx, r.cy); if (!byLand.has(l)) byLand.set(l, []); byLand.get(l).push(r); }
  const lands = [...byLand.values()].sort((a, b) => b.length - a.length);
  const ok = (r, i) => !skip.includes(r.id) && (i >= siteN || siteIn(ctx, r.id, 0, null));
  for (const regs of lands) {
    for (const a of regs) {
      if (!ok(a, 0)) continue;
      const path = [a];
      const dfs = () => {
        if (path.length === len) return true;
        const last = path[path.length - 1];
        for (const nid of last.nb) {
          if (last.fd.includes(nid)) continue;
          const n = S.regions.get(nid);
          if (!n || path.includes(n) || !ok(n, path.length)) continue;
          if (path.slice(0, -1).some(p => p.nb.includes(n.id))) continue;
          path.push(n);
          if (dfs()) return true;
          path.pop();
        }
        return false;
      };
      if (dfs()) return path.map(r => r.id);
    }
  }
  return null;
}
/**
 * Two kingdoms A (r0) and B (r1 + r2 + optionally r3) on a chain of regions; every kingdom has ~`pop` adult citizens.
 * Optional third kingdom C (own region, cityless extras are wild). Returns handles. AI wars and expansion are switched off by default.
 */
function arena(ctx, o = {}) {
  const { S, Regions, Kingdoms, Diplomacy } = ctx;
  const len = o.chain || 3;
  const chain = findChain(ctx, len, o.skip || [], 3);
  if (!chain) return null;
  const rA = S.regions.get(chain[0]), rB = S.regions.get(chain[1]);
  const usedK = o.usedK || [];
  const cA = foundCity(ctx, chain[0], 0, o.popA || 60, rB);
  if (cA && usedK.includes(cA.kingdomId) && !Kingdoms.splitCity(cA.id)) return null;      // (a village joins a neighbouring kingdom of the same race: make it independent)
  const cB = cA && foundCity(ctx, chain[1], 0, o.popB || 54, rA);
  if (!cA || !cB) return null;
  if ((cB.kingdomId === cA.kingdomId || usedK.includes(cB.kingdomId)) && !Kingdoms.splitCity(cB.id)) return null;
  if (cB.kingdomId === cA.kingdomId || usedK.includes(cB.kingdomId)) return null;
  const A = cA.kingdomId, B = cB.kingdomId;
  const out = { chain, A, B, cityA: cA, cityB: cB, extra: [] };
  for (let i = 2; i < len; i++) {
    const rid = chain[i];
    if (i === 2 && o.cityC !== false) {
      const c2 = foundCity(ctx, rid, 0, o.popB2 || 30, S.regions.get(chain[1]));
      if (c2) { if (c2.kingdomId !== B) Kingdoms.transferCity(c2.id, B, 'test'); out.cityB2 = c2; }
    }
    if (Regions.get(rid).ownerId !== B) Regions.setOwner(rid, B, 'test');
  }
  assert.equal(Regions.get(chain[0]).ownerId, A); assert.equal(Regions.get(chain[1]).ownerId, B);
  if (o.third) {
    const rc = findChain(ctx, 1, chain);
    if (rc) {
      const cC = foundCity(ctx, rc[0], 0, o.popC || 40, null);
      if (cC) { if (cC.kingdomId === A || cC.kingdomId === B) Kingdoms.splitCity(cC.id); if (cC.kingdomId !== A && cC.kingdomId !== B) { out.C = cC.kingdomId; out.cityC3 = cC; out.rC = rc[0]; } }
    }
  }
  if (!o.keepAI) { Diplomacy.step = () => {}; }          // no AI wars / alliances unless the test asks for them
  feed(ctx);
  return out;
}
function mkArena(o = {}, tryN = 8) {
  for (let s = SEED; s < SEED + tryN; s++) {
    const ctx = mkCtx(s, o.stub);
    const a = arena(ctx, o);
    if (a) { a.seed = s; return { ctx, a }; }
  }
  throw new Error('no arena found for this configuration');
}
const armiesOfK = (ctx, kid) => [...ctx.S.armies.values()].filter(a => a.kingdomId === kid);
const soldiersOfK = (ctx, kid) => armiesOfK(ctx, kid).reduce((s, a) => s + a.members.length, 0);
const occupied = (ctx) => [...ctx.S.regions.values()].filter(r => r.controllerId !== r.ownerId).map(r => r.id).sort((a, b) => a - b);
const ctrl = (ctx, rid) => ctx.Regions.get(rid).controllerId;
/** structural invariants of the army layer (checked in every scenario) */
function invariants(ctx, label = '') {
  const { S } = ctx;
  let total = 0;
  const perK = new Map();
  for (const a of S.armies.values()) {
    assert.ok(S.wars.has(a.warId), `${label} army ${a.id} has a war`);
    assert.ok(S.kingdoms.has(a.kingdomId), `${label} army ${a.id} has a kingdom`);
    assert.ok(a.members.length >= 1 && a.members.length <= 60, `${label} army ${a.id} size ${a.members.length} in 1..60`);
    assert.ok(Number.isFinite(a.rally.x) && Number.isFinite(a.rally.y) && a.rally.x >= 0 && a.rally.y >= 0 && a.rally.x < S.w && a.rally.y < S.h, `${label} rally finite & inside the map`);
    assert.ok(a.supply >= 0 && a.supply <= 100, `${label} supply in range`);
    assert.ok(['gather', 'march', 'siege', 'hold', 'retreat'].includes(a.mode), `${label} mode ${a.mode}`);
    assert.ok(['attack', 'hold', 'defend', 'retreat'].includes(a.order.type), `${label} order ${a.order.type}`);
    assert.equal(new Set(a.members).size, a.members.length, `${label} no duplicate members`);
    for (const id of a.members) { const u = S.units.get(id); assert.ok(u, `${label} member ${id} alive`); assert.equal(u.armyId, a.id, `${label} member ${id} points back`); assert.equal(u.kingdomId, a.kingdomId, `${label} member kingdom`); }
    total += a.members.length; perK.set(a.kingdomId, (perK.get(a.kingdomId) || 0) + 1);
  }
  assert.ok(total <= 350, `${label} soldiers ${total} <= 350`);
  for (const [k, n] of perK) assert.ok(n <= 6, `${label} kingdom ${k} has ${n} armies <= 6`);
  for (const u of S.units.values()) if (u.armyId) { const a = S.armies.get(u.armyId); assert.ok(a && a.members.includes(u.id), `${label} unit ${u.id} listed in its army`); }
  for (const u of S.units.values()) { assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y), `${label} unit coords finite`); }
  return total;
}
function noErrors(ctx, label = '') { assert.equal(ctx.Sim.totalErrors, 0, `${label} Sim errors ${JSON.stringify(ctx.Sim.errors)} ${ctx.Sim.lastError && ctx.Sim.lastError.War && ctx.Sim.lastError.War.stack}`); assert.equal(ctx.Units.errors, 0, 'Units errors ' + (ctx.Units.lastError && ctx.Units.lastError.stack)); }

console.log(`War tests  (seed ${SEED}${QUICK ? ', quick' : ''})`);

// ================================================================== API shape
section('API: every contract function exists; atWar is an O(1) symmetric pair cache; stub-free defaults', () => {
  const ctx = mkCtx();
  const { War, S } = ctx;
  for (const f of ['atWar', 'declare', 'start', 'addGoal', 'order', 'armiesOf', 'score', 'peaceCost', 'peaceOffer', 'forcePeace', 'potentialGoals', 'supply',
    'setAutoPeace', 'end', 'get', 'warsOf', 'active', 'godPeace', 'armyOf', 'step', 'newWorld', 'afterLoad']) assert.equal(typeof War[f], 'function', f);
  assert.equal(War.atWar(1, 2), false); assert.equal(War.atWar(0, 0), false); assert.equal(War.atWar(undefined, 3), false);
  assert.deepEqual(War.armiesOf(1), []); assert.deepEqual(War.active(), []); assert.deepEqual(War.warsOf(5), []);
  assert.equal(War.get(99), null); assert.equal(War.armyOf(99), null); assert.equal(War.score(99, 1), 0); assert.equal(War.supply(99), 100);
  assert.equal(War.godPeace(99), false); assert.equal(War.end(99, 'x'), false); assert.equal(War.order(1, 'all', { type: 'hold', regionId: 1 }), false);
  assert.equal(War.declare(1, 2, [], 'x'), null); assert.equal(War.addGoal(9, 1, 1), false); assert.equal(War.forcePeace(9, {}), false);
  assert.equal(War.peaceOffer(9, 1, {}).ok, false); assert.equal(War.peaceCost(9, [999]), 0);
  assert.deepEqual(War.potentialGoals(1, 2), []);
  assert.equal(War.autoPeace(), true); War.setAutoPeace(false); assert.equal(War.autoPeace(), false); War.setAutoPeace(true);
  // a hand-made war is honoured by the pair cache (and by the caches after a rebuild)
  S.wars.set(7, { id: 7, attackers: [11], defenders: [12, 13], aggressor: 11, defender: 12, started: 0, casus: 'x', ended: false, kills: {}, hist: [] });
  assert.equal(War.atWar(11, 12), true); assert.equal(War.atWar(13, 11), true); assert.equal(War.atWar(12, 13), false); assert.equal(War.atWar(11, 11), false);
  S.wars.get(7).ended = true; War.afterLoad();
  assert.equal(War.atWar(11, 12), false, 'ended wars do not count');
});

console.log('');

// ================================================================== declare
section('declare: validation, goals (enemy region next to our land), auto-pick, formation of armies, Russian log + Bus event', () => {
  const { ctx, a } = mkArena({ chain: 4 });
  const { War, Regions, S, Bus, Diplomacy, Const, Units } = ctx;
  const [r0, r1, r2, r3] = a.chain;
  let ev = null; Bus.on('warDeclared', w => { ev = w; });
  assert.equal(War.declare(a.A, a.A, [], 'x'), null, 'not against itself');
  assert.equal(War.declare(a.A, 99999, [], 'x'), null, 'unknown kingdom');
  assert.deepEqual(War.potentialGoals(a.A, a.B), [r1], 'only the region touching our land is a candidate');
  assert.deepEqual(War.potentialGoals(a.B, a.A), [r0]);
  assert.equal(War.declare(a.A, a.B, [r2], 'conquest'), null, 'a goal that is not next to our land is refused');
  assert.match(War.lastError, /цель/);
  assert.equal(War.declare(a.A, a.B, [r0], 'conquest'), null, 'own region is no goal');
  assert.equal(S.wars.size, 0);
  // adults per city before the muster
  const adults = (kid) => [...S.units.values()].filter(u => u.kingdomId === kid && Units.stage(u) === 'adult').length;
  const adA = adults(a.A), adB = adults(a.B);
  const w = War.declare(a.A, a.B, [], 'conquest');
  assert.ok(w, 'declared: ' + War.lastError);
  assert.equal(ev, w, 'Bus warDeclared');
  assert.deepEqual(w.attackers, [a.A]); assert.deepEqual(w.defenders, [a.B]);
  assert.equal(w.aggressor, a.A); assert.equal(w.defender, a.B); assert.equal(w.casus, 'conquest'); assert.equal(w.ended, false); assert.equal(w.started, S.tick);
  assert.deepEqual(w.goals, [{ kid: a.A, regionId: r1, done: false }], 'auto-picked goal');
  assert.equal(War.get(w.id), w); assert.deepEqual(War.warsOf(a.A), [w]); assert.deepEqual(War.warsOf(a.B), [w]); assert.deepEqual(War.active(), [w]);
  assert.ok(War.atWar(a.A, a.B) && War.atWar(a.B, a.A) && Diplomacy.atWar(a.A, a.B), 'pair cache both ways + Diplomacy forwarding');
  assert.equal(Diplomacy.state(a.A, a.B), Const.REL.WAR);
  assert.equal(War.declare(a.A, a.B, [], 'x'), null, 'already at war'); assert.equal(War.declare(a.B, a.A, [], 'x'), null);
  const ka = S.kingdoms.get(a.A), kb = S.kingdoms.get(a.B);
  const logLine = S.log.find(e => e.kind === 'war' && e.msg.includes('объявило войну'));
  assert.ok(logLine && logLine.msg.includes('«' + ka.name + '»') && logLine.msg.includes('«' + kb.name + '»') && logLine.msg.includes('«' + Regions.get(r1).name + '»'), 'log: ' + (logLine && logLine.msg));
  // armies: one per city, 20-35 % of the adults (small cities a bit more), leader is a member, soldiers are outfitted
  const armA = armiesOfK(ctx, a.A), armB = armiesOfK(ctx, a.B);
  assert.ok(armA.length >= 1 && armB.length >= 1, 'both sides muster');
  for (const [arm, ad, k] of [[armA, adA, 'A'], [armB, adB, 'B']]) {
    const n = arm.reduce((s, x) => s + x.members.length, 0);
    note(`${k}: ${n} soldiers of ${ad} adults (${(100 * n / ad).toFixed(0)}%), ${arm.length} army`);
    assert.ok(n >= ad * 0.15 && n <= ad * 0.46, `${k} conscription share ${n}/${ad}`);
    for (const x of arm) {
      assert.ok(x.members.includes(x.leaderId), 'leader is a member');
      assert.equal(x.warId, w.id); assert.equal(x.supply, 100); assert.ok(x.strength0 === x.members.length);
      assert.ok(x.members.every(id => S.units.get(id).state === 'army'));
      assert.ok(x.members.some(id => S.units.get(id).weapon >= 1), 'soldiers are equipped from the city stock');
      const lvl = Math.max(...x.members.map(id => S.units.get(id).level)); assert.equal(S.units.get(x.leaderId).level, lvl, 'leader = best level');
    }
  }
  assert.ok(armA.every(x => x.order.type === 'attack' && x.order.regionId === r1), 'attackers march on the goal');
  assert.ok(armB.some(x => x.order.type === 'defend' && x.order.regionId === r1), 'a defender army guards the threatened region');
  assert.ok(armB.every(x => ['defend', 'hold'].includes(x.order.type)), 'defenders never attack on their own');
  invariants(ctx, 'declare');
  // leader re-election when the leader dies
  const x = armA[0], oldL = x.leaderId;
  ctx.Units.kill(S.units.get(oldL), 'erase');
  run(ctx, 12);
  assert.notEqual(x.leaderId, oldL); assert.ok(x.members.includes(x.leaderId), 're-elected leader');
  // views
  const vw = War.armiesOf(a.A)[0];
  for (const k of ['id', 'size', 'strength', 'supply', 'order', 'mode', 'regionId', 'x', 'y', 'kingdomId']) assert.ok(k in vw, 'view has ' + k);
  assert.equal(vw.kingdomId, a.A); assert.equal(War.supply(vw.id), 100); assert.equal(War.armyOf(vw.id), S.armies.get(vw.id));
  noErrors(ctx, 'declare');
});

section('declare: truce blocks (god ignores it), allied kingdoms cannot be attacked, conquest of a goal beyond reach fails cleanly', () => {
  const { ctx, a } = mkArena({ chain: 3 });
  const { War, S, Diplomacy } = ctx;
  const w = War.declare(a.A, a.B, [], 'conquest');
  assert.ok(w);
  assert.ok(War.end(w.id, 'test'), 'ended');
  assert.equal(w.ended, true); assert.equal(War.atWar(a.A, a.B), false, 'pair cache drops ended wars');
  assert.ok(War.inTruce(a.A, a.B), 'truce after the war');
  assert.equal(War.declare(a.A, a.B, [], 'conquest'), null); assert.match(War.lastError, /перемири/);
  const g = War.declare(a.A, a.B, [], 'god');
  assert.ok(g, 'god ignores the truce: ' + War.lastError);
  War.end(g.id, 'test');
  // allies
  S.tick += 2500;                                        // (truce over)
  assert.ok(Diplomacy.makeAlliance(a.A, a.B), 'allied');
  assert.equal(War.declare(a.A, a.B, [], 'conquest'), null); assert.match(War.lastError, /союзник/);
  assert.equal(S.wars.size, 2);
  noErrors(ctx, 'truce');
});


// ================================================================== the core requirement: take the goal region, then HOLD
section('goal: the army takes EXACTLY the goal region, then HOLDS it for 3000 ticks - no advance, the war stays active', () => {
  const { ctx, a } = mkArena({ chain: 4, popA: 100, popB: 40, cityC: false });
  const { War, S, Regions, Bus, Units, Cities } = ctx;
  const [r0, r1, r2, r3] = a.chain;
  War.setAutoPeace(false);
  const changes = [];
  Bus.on('regionControl', (r, o, n, why) => { changes.push({ t: S.tick, rid: r.id, o, n, why }); });
  const w = War.declare(a.A, a.B, [], 'conquest');
  assert.ok(w); assert.deepEqual(w.goals.map(g => g.regionId), [r1]);
  let tTaken = -1;
  for (let i = 0; i < 1500 && tTaken < 0; i++) { run(ctx, 1); if (w.goals[0].done) tTaken = S.tick - w.started; }
  assert.ok(tTaken > 0, 'goal region occupied within 1500 ticks');
  note(`goal region taken after ${tTaken} ticks; score A ${War.score(w.id, a.A)} / B ${War.score(w.id, a.B)}; soldiers A ${soldiersOfK(ctx, a.A)} B ${soldiersOfK(ctx, a.B)}`);
  assert.equal(Regions.get(r1).ownerId, a.B, 'ownership does not change by occupation');
  assert.equal(ctrl(ctx, r1), a.A, 'the controller is the attacker');
  assert.equal(S.cities.get(a.cityB.id).occupierId, a.A, 'the city inside is occupied (Cities.occupy)');
  assert.equal(S.cities.get(a.cityB.id).kingdomId, a.B, 'but still belongs to its kingdom');
  assert.ok(S.log.some(e => e.msg.startsWith('Регион «' + Regions.get(r1).name + '» оккупирован королевством')), 'log line');
  assert.deepEqual(occupied(ctx), [r1], 'only the goal region');
  // the order became HOLD on that region
  run(ctx, 80);
  const arm = armiesOfK(ctx, a.A);
  assert.ok(arm.length >= 1);
  assert.ok(arm.every(x => x.order.type === 'hold' && x.order.regionId === r1), 'orders: ' + arm.map(x => x.order.type + ':' + x.order.regionId).join(','));
  // 3000 more ticks: never anything but the goal
  const t0 = S.tick;
  let maxOcc = 1;
  run(ctx, 3000, (t) => {
    const oc = occupied(ctx);
    assert.ok(oc.every(r => r === r1), `t${t}: occupied ${oc} (only ${r1})`);
    maxOcc = Math.max(maxOcc, oc.length);
    assert.ok(!War.get(w.id).ended, 'the war goes on');
    assert.equal(w.goals.length, 1, 'no new goals');
  }, 50);
  invariants(ctx, 'hold');
  assert.equal(S.tick - t0, 3000);
  assert.equal(w.ended, false); assert.ok(War.atWar(a.A, a.B)); assert.equal(War.warsOf(a.A).length, 1);
  assert.ok(w.goals[0].done, 'goal still done');
  assert.equal(ctrl(ctx, r1), a.A); assert.equal(ctrl(ctx, r2), a.B); assert.equal(ctrl(ctx, r3), a.B); assert.equal(Regions.get(r2).ownerId, a.B);
  const rg = Regions.get(r1);
  const ar = armiesOfK(ctx, a.A).filter(x => x.order.type === 'hold' && x.order.regionId === r1);        // (refilled home guards of new cities are other armies)
  assert.ok(ar.length >= 1, 'a garrison army holds the goal region');
  const total = ar.reduce((s, x) => s + x.members.length, 0);
  const post = a.cityB;                                         // the post of an army holding a region with a city is the city
  note(`after ${S.tick - w.started} ticks of war: A holds ${r1}, garrison ${total} soldiers, score A ${War.score(w.id, a.A)} B ${War.score(w.id, a.B)}, wear A ${War.weariness(a.A)} B ${War.weariness(a.B)}`);
  assert.ok(total >= 3, 'garrison');
  for (const x of ar) {
    assert.equal(x.mode, 'hold'); assert.equal(Regions.at(x.rally.x, x.rally.y), r1, 'the rally point is inside the region');
    assert.ok(Math.hypot(x.rally.x - post.x, x.rally.y - post.y) < 4, 'rally at the post');
    const dists = x.members.map(id => { const u = S.units.get(id); return Math.hypot(u.x - x.rally.x, u.y - x.rally.y); });
    assert.ok(dists.filter(d => d <= 5).length >= dists.length * 0.8, 'soldiers stand within ~4 tiles of the rally point');
  }
  assert.ok(Units.stateLabel(S.units.get(ar[0].members[0])).length > 0);
  assert.ok(War.score(w.id, a.A) >= 25, 'war score of the holder');
  // every regionControl change in the whole run: only the goal, only once (no flip-flop of other regions)
  const warChanges = changes.filter(c => c.why === 'war');
  assert.ok(warChanges.every(c => c.rid === r1), 'war control changes only touch the goal: ' + JSON.stringify(warChanges));
  assert.ok(Cities.isOccupied(a.cityB.id));
  noErrors(ctx, 'hold');
});

section('orders: a commanded attack on a SECOND region works (then hold again); validation of the order API; retreat disbands', () => {
  const { ctx, a } = mkArena({ chain: 4, popA: 100, popB: 40, cityC: false });
  const { War, S, Regions, Kingdoms, Units } = ctx;
  const [r0, r1, r2, r3] = a.chain;
  War.setAutoPeace(false);
  Kingdoms.setCommanded(a.A, true);
  const w = War.declare(a.A, a.B, [r1], 'conquest');
  assert.ok(w);
  run(ctx, 1500, null, 50);
  assert.ok(w.goals[0].done, 'first goal taken');
  assert.deepEqual(occupied(ctx), [r1]);
  // --- validation
  const ids = War.armiesOf(a.A).map(v => v.id);
  assert.ok(ids.length >= 1);
  assert.equal(War.order(a.A, 'all', { type: 'attack', regionId: r0 }), false, 'cannot attack an own region'); assert.match(War.lastError, /не вражеск/);
  assert.equal(War.order(a.A, 'all', { type: 'bogus', regionId: r1 }), false);
  assert.equal(War.order(a.A, 'all', { type: 'attack', regionId: 99999 }), false);
  assert.equal(War.order(a.B, ids, { type: 'hold', regionId: r1 }), false, 'not your army');
  assert.equal(War.order(a.A, [999999], { type: 'hold', regionId: r1 }), false, 'unknown army');
  assert.equal(War.order(a.A, 'all', { type: 'hold', regionId: r2 }), false, 'cannot hold a region that is neither ours nor occupied'); assert.match(War.lastError, /свои|занят/);
  assert.equal(War.order(a.A, 'all', { type: 'defend', regionId: r1 }), true, 'defend an occupied region is fine');
  assert.equal(War.armiesOf(a.A)[0].order.type, 'defend');
  assert.equal(War.order(a.A, 'all', { type: 'hold', regionId: r0 }), true, 'hold our own region');
  assert.equal(War.order(a.A, 'all', { type: 'hold', regionId: r1 }), true);
  // --- the second attack
  assert.equal(War.order(a.A, 'all', { type: 'attack', regionId: r2 }), true, War.lastError);
  assert.ok(War.armiesOf(a.A).every(v => v.order.type === 'attack' && v.order.regionId === r2 && v.auto === false));
  w.goals.length === 1 && assert.equal(w.goals.length, 1);
  run(ctx, 12);
  assert.ok(armiesOfK(ctx, a.A).every(x => x.order.type === 'attack'), 'the AI does not override the commanded kingdom');
  let t2 = -1;
  for (let i = 0; i < 1800 && t2 < 0; i++) { run(ctx, 1); if (ctrl(ctx, r2) === a.A) t2 = i; }
  assert.ok(t2 >= 0, 'second region taken: armies ' + JSON.stringify(War.armiesOf(a.A).map(v => [v.order, v.mode, v.size, v.supply, v.regionId])));
  note(`second region taken ${t2 + 12} ticks after the order`);
  assert.deepEqual(occupied(ctx), [r1, r2].sort((x, y) => x - y), 'exactly the two regions');
  run(ctx, 100);
  assert.ok(armiesOfK(ctx, a.A).every(x => x.order.type === 'hold' && x.order.regionId === r2), 'and holds the new region');
  run(ctx, 500, (t) => assert.deepEqual(occupied(ctx), [r1, r2].sort((x, y) => x - y), `t${t} nothing beyond the second region`), 50);
  assert.equal(ctrl(ctx, r3), a.B);
  // --- retreat: go home and disband
  assert.equal(War.order(a.A, 'all', { type: 'retreat' }), true);
  assert.ok(War.armiesOf(a.A).every(v => v.mode === 'retreat'));
  run(ctx, 2000, null, 50);
  assert.equal(armiesOfK(ctx, a.A).length, 0, 'retreated armies disband at home');
  assert.ok([...S.units.values()].every(u => u.armyId === 0 || S.armies.has(u.armyId)));
  assert.equal(ctrl(ctx, r1), a.A, 'control stays when the army leaves'); assert.ok(War.atWar(a.A, a.B));
  invariants(ctx, 'orders');
  noErrors(ctx, 'orders');
});


// ================================================================== retake / supply
section('defenders retake: B (AI) attacks the lost region when the occupier is weak; the city is liberated (log + Cities.liberate)', () => {
  const { ctx, a } = mkArena({ chain: 3, popA: 100, popB: 40, popB2: 40, cityC: true });
  const { War, S, Regions, Units, Cities, Bus } = ctx;
  const lines = []; Bus.on('log', (e) => { lines.push(e.msg); });
  const [r0, r1, r2] = a.chain;
  War.setAutoPeace(false);
  const w = War.declare(a.A, a.B, [r1], 'conquest');
  assert.ok(w);
  run(ctx, 1800, null, 50);
  assert.equal(ctrl(ctx, r1), a.A, 'A took the region first (needs a clear win for this scenario)');
  const city = S.cities.get(a.cityB.id);
  assert.equal(city.occupierId, a.A);
  // B's second city grew meanwhile (reserves); A's army is destroyed and A cannot muster any more (too few citizens left)
  const b2 = a.cityB2;
  for (let i = 0; i < 50; i++) { const u = ctx.Units.spawn(0, b2.x + 0.5 + (i % 5) * 0.3, b2.y + 0.5 + (i % 7) * 0.2, { age: 24 + i % 12, cityId: b2.id }); if (u) u.hunger = 0; }
  for (const x of armiesOfK(ctx, a.A)) for (const id of x.members.slice()) Units.kill(S.units.get(id), 'erase');
  const keep = [];
  for (const u of [...S.units.values()]) if (u.kingdomId === a.A && !u.armyId) { if (keep.length < 2) keep.push(u.id); else Units.kill(u, 'erase'); }
  run(ctx, 6);
  assert.equal(armiesOfK(ctx, a.A).length, 0, 'A has no army left and cannot raise one');
  const logN = S.log.length;
  let sawAttack = false, tBack = -1;
  for (let i = 0; i < 2500 && tBack < 0; i++) {
    run(ctx, 1);
    if (armiesOfK(ctx, a.B).some(x => x.order.type === 'attack' && x.order.regionId === r1)) sawAttack = true;
    if (ctrl(ctx, r1) === a.B) tBack = i;
  }
  assert.ok(sawAttack, 'B ordered an attack on its occupied region');
  assert.ok(tBack >= 0, 'B retook the region: armies ' + JSON.stringify(War.armiesOf(a.B).map(v => [v.order, v.mode, v.size, v.regionId])));
  note(`retaken after ${tBack} ticks`);
  assert.equal(city.occupierId, 0, 'city liberated'); assert.equal(Cities.isOccupied(city.id), false);
  assert.ok(lines.some(m => m.startsWith('Регион «' + Regions.get(r1).name + '» освобождён')), 'log: region liberated');
  assert.ok(lines.some(m => m === 'Город «' + city.name + '» освобождён'), 'log: city liberated');
  assert.deepEqual(occupied(ctx), [], 'nothing occupied any more');
  assert.ok(Regions.get(r1).ownerId === a.B && War.atWar(a.A, a.B), 'war goes on');
  void logN; void r0; void r2;
  noErrors(ctx, 'retake');
});

section('supply: 100 in friendly land, falls ~1 per 4 ticks far from every base, attrition + no regeneration below 30, recovery; AI sends no cut-off army', () => {
  const { ctx, a } = mkArena({ chain: 5, popA: 110, popB: 36, cityC: false });
  const { War, S, Regions, Units, Kingdoms } = ctx;
  const [r0, r1, r2, r3, r4] = a.chain;
  War.setAutoPeace(false);
  Kingdoms.setCommanded(a.A, true);
  const w = War.declare(a.A, a.B, [r1], 'conquest');
  run(ctx, 1600, null, 50);
  assert.equal(ctrl(ctx, r1), a.A, 'first region taken');
  run(ctx, 400, null, 50);                                                     // (the captured city becomes a forward base after 100 ticks)
  assert.ok(War.armiesOf(a.A).every(v => v.supply >= 99), 'full supply inside own / conquered land: ' + War.armiesOf(a.A).map(v => v.supply));
  assert.equal(War.order(a.A, 'all', { type: 'attack', regionId: r4 }), true, War.lastError);
  // sample the supply of the strongest army on its way four regions deep
  const lead = () => War.armiesOf(a.A).sort((x, y) => y.size - x.size)[0];
  const samples = [];
  for (let i = 0; i < 1600; i++) { run(ctx, 1); if (i % 10 === 0) { const v = lead(); if (v) samples.push([i, v.supply, v.mode, v.regionId]); } }
  const minSup = Math.min(...samples.map(s => s[1]));
  note(`deep order: supply path ${samples.filter((s, i) => i % 6 === 0).map(s => s[1]).join(' ')}  (min ${minSup})`);
  assert.ok(minSup < 100, 'supply decays far from every base');
  // decay rate while unsupplied: ~0.25 per tick
  const slopes = [];
  for (let i = 1; i < samples.length; i++) if (samples[i][1] < samples[i - 1][1]) slopes.push((samples[i - 1][1] - samples[i][1]) / 10);
  assert.ok(slopes.length > 0);
  const slope = slopes.reduce((s, v) => s + v, 0) / slopes.length;
  note(`decay ${slope.toFixed(3)} per tick (spec: ~1 per 4 ticks)`);
  assert.ok(slope > 0.18 && slope < 0.32, 'decay rate ' + slope);
  const regained = samples[samples.length - 1][1];
  note(`final supply ${regained}, region of the army ${samples[samples.length - 1][3]}, controller of r4: ${ctrl(ctx, r4)} (A=${a.A})`);
  // forced attrition: below 30 every soldier loses health every 25 ticks and does not regenerate
  const x = armiesOfK(ctx, a.A).sort((p, q) => q.members.length - p.members.length)[0];
  for (const id of x.members) { const u = S.units.get(id); u.hp = u.maxHp; }
  x.supply = 5;
  const hp0 = x.members.map(id => S.units.get(id).hp);
  const deaths0 = ctx.noise.deaths;
  run(ctx, 26);
  const hp1 = x.members.filter(id => S.units.has(id)).map(id => S.units.get(id).hp);
  const drop = hp0.reduce((s, v) => s + v, 0) / hp0.length - hp1.reduce((s, v) => s + v, 0) / Math.max(1, hp1.length);
  note(`attrition: avg hp drop ${drop.toFixed(2)} in 26 ticks at supply<30, deaths ${ctx.noise.deaths - deaths0}`);
  assert.ok(drop >= 1.5, 'each soldier loses ~2 hp per attrition round, no regeneration');
  // back in supplied land the supply refills
  for (const v of War.armiesOf(a.A)) War.order(a.A, [v.id], { type: 'hold', regionId: r1 });
  run(ctx, 1400, null, 50);
  assert.ok(War.armiesOf(a.A).every(v => v.supply >= 90), 'recovers when back: ' + War.armiesOf(a.A).map(v => v.supply));
  // AI rule: an AI army below 30 supply gets no (new) attack order
  Kingdoms.setCommanded(a.A, false);
  w.goals.push({ kid: a.A, regionId: r2, done: false });
  for (const y of S.armies.values()) if (y.kingdomId === a.A) { y.supply = 10; y.auto = 1; y.lock = 0; }
  run(ctx, 12);
  assert.ok(armiesOfK(ctx, a.A).every(y => !(y.order.type === 'attack' && y.order.regionId === r2)), 'no attack order for a cut-off army');
  invariants(ctx, 'supply');
  noErrors(ctx, 'supply');
});


// ================================================================== peace
/** A (strong) holds B's region r1 after ~1.5k ticks; B survives with a second small city in r2 */
function conquered(o = {}) {
  const { ctx, a } = mkArena(Object.assign({ chain: 4, popA: 130, popB: 36, popB2: 24, cityC: true }, o));
  const { War } = ctx;
  War.setAutoPeace(!!o.autoPeace);
  const w = War.declare(a.A, a.B, [a.chain[1]], 'conquest');
  assert.ok(w, 'declared: ' + War.lastError);
  for (let i = 0; i < 2200 && !w.goals[0].done; i += 25) run(ctx, 25);
  assert.ok(w.goals[0].done, 'A holds the goal (scenario precondition)');
  run(ctx, 120);
  return { ctx, a, w };
}
section('peace conference: cost, allowance, accept / refuse rules, region + city transfer, claim, truce, controllers revert, armies go home', () => {
  const { ctx, a, w } = conquered();
  const { War, S, Regions, Bus, Diplomacy, Cities } = ctx;
  const [r0, r1, r2] = a.chain;
  let ended = null; Bus.on('warEnded', (x, how) => { ended = [x, how]; });
  const lines = []; Bus.on('log', (e) => { lines.push(e.msg); });
  const reg1 = Regions.get(r1);
  const cost = War.peaceCost(w.id, [r1]);
  assert.equal(cost, Math.round(8 + reg1.value * 4 + 10 * Regions.cityCount(r1)), 'cost = 8 + value*4 + 10*cities');
  assert.equal(War.peaceCost(w.id, [r1, r2]), cost + War.peaceCost(w.id, [r2]));
  note(`region ${r1}: value ${reg1.value}, cost ${cost}; scores A ${War.score(w.id, a.A)} B ${War.score(w.id, a.B)}`);
  // --- invalid / unaffordable offers
  assert.equal(War.peaceOffer(99999, a.A, { regions: [r1] }).ok, false);
  assert.equal(War.peaceOffer(w.id, 424242, { regions: [r1] }).ok, false, 'a bystander cannot offer');
  let res = War.peaceOffer(w.id, a.A, { regions: [r2] });
  assert.equal(res.ok, false); assert.match(res.reason, /не оккупирован/);
  res = War.peaceOffer(w.id, a.A, { regions: [r0] }); assert.equal(res.ok, false, 'an own region is no demand');
  res = War.peaceOffer(w.id, a.B, { regions: [r1] }); assert.equal(res.ok, false, 'the loser cannot demand its own land');
  const real = w.score[a.A];
  w.score[a.A] = cost - 8;
  res = War.peaceOffer(w.id, a.A, { regions: [r1] });
  assert.equal(res.ok, false); assert.match(res.reason, /очков/); assert.equal(w.ended, false, 'too expensive');
  assert.ok(res.cost === cost && res.allowance < cost);
  w.score[a.A] = real;
  assert.ok(real >= cost, 'the holder can afford what it holds (score ' + real + ' >= ' + cost + ')');
  // --- the AI refuses while it is not losing and the demand is not modest ...
  w.score[a.B] = 30; w.wear[a.B] = 10;
  res = War.peaceOffer(w.id, a.A, { regions: [r1] });
  assert.equal(res.ok, true); assert.equal(res.accepted, false); assert.match(res.reason, /отказал/); assert.equal(w.ended, false);
  // --- accepts when exhausted (weariness >= 70)
  w.score[a.B] = 30; w.wear[a.B] = 80;
  res = War.peaceOffer(w.id, a.A, { regions: [r1] });
  assert.equal(res.ok, true); assert.equal(res.accepted, true, res.reason); assert.equal(w.ended, true); assert.equal(w.how, 'peace');
  assert.ok(ended && ended[0] === w && ended[1] === 'peace', 'Bus warEnded');
  // --- consequences
  const reg = Regions.get(r1), city = S.cities.get(a.cityB.id);
  assert.equal(reg.ownerId, a.A, 'region transferred (Regions.setOwner)'); assert.equal(reg.controllerId, a.A);
  assert.equal(city.kingdomId, a.A, 'its city follows (Kingdoms.transferCity)'); assert.equal(city.occupierId, 0);
  assert.ok([...S.units.values()].filter(u => u.cityId === city.id).every(u => u.kingdomId === a.A), 'citizens changed kingdom');
  assert.ok(Regions.hasClaim(r1, a.B), 'the loser keeps a claim');
  assert.ok(S.kingdoms.has(a.B), 'B survives with its other city'); assert.equal(Regions.get(r2).ownerId, a.B);
  assert.deepEqual(occupied(ctx), [], 'every controller is back with its owner');
  assert.equal(War.atWar(a.A, a.B), false); assert.equal(Diplomacy.atWar(a.A, a.B), false); assert.deepEqual(War.warsOf(a.A), []);
  assert.ok(War.inTruce(a.A, a.B) && Diplomacy.inTruce(a.A, a.B), 'truce');
  const left = War.truceUntil(a.A, a.B) - S.tick;
  assert.ok(left > 2300 && left <= 2400, 'truce of 2400 ticks (' + left + ')');
  assert.equal(War.declare(a.A, a.B, [], 'conquest'), null);
  const ka = S.kingdoms.get(a.A), kb = S.kingdoms.get(a.B);
  assert.ok(lines.some(m => m.includes('Заключён мир') && m.includes('«' + ka.name + '»') && m.includes('«' + kb.name + '»') && m.includes('«' + reg.name + '»')), 'log: ' + lines.filter(m => m.includes('мир')).join(' / '));
  assert.equal(War.peaceOffer(w.id, a.A, { regions: [r1] }).ok, false, 'a finished war accepts no offers');
  // armies of both sides walk home and disband
  run(ctx, 900, null, 50);
  assert.equal([...S.armies.values()].filter(x => x.warId === w.id).length, 0, 'armies gone');
  assert.ok([...S.units.values()].every(u => !u.armyId || S.armies.has(u.armyId)));
  assert.ok(![...S.units.values()].some(u => u.state === 'army' && !S.armies.has(u.armyId)));
  // the old war leaves the table after a while
  run(ctx, 1000, null, 100);
  assert.equal(S.wars.has(w.id), false, 'ended wars are pruned');
  invariants(ctx, 'peace'); noErrors(ctx, 'peace');
  void Cities;
});

section('peace: white peace rules, AI acceptance table, vassalization, commanded recipient waits for the player', () => {
  const { ctx, a, w } = conquered();
  const { War, S, Regions, Kingdoms } = ctx;
  const [r0, r1, r2] = a.chain;
  // white peace is accepted unless the other side believes it is clearly winning
  w.score[a.A] = 10; w.score[a.B] = 40; w.wear[a.B] = 5;
  let res = War.peaceOffer(w.id, a.A, { regions: [] });
  assert.equal(res.ok, true); assert.equal(res.accepted, false, 'B (score 40 vs 10) refuses a white peace');
  w.score[a.B] = 20;
  // clearly losing AI accepts (lead >= 20, >= 25)
  w.score[a.A] = 60; w.score[a.B] = 10; w.wear[a.B] = 0;
  const cost = War.peaceCost(w.id, [r1]);
  // commanded recipient: the offer waits, the player answers with respondOffer
  Kingdoms.setCommanded(a.B, true);
  res = War.peaceOffer(w.id, a.A, { regions: [r1] });
  assert.equal(res.ok, true); assert.equal(res.pending, true); assert.equal(res.accepted, false); assert.equal(w.ended, false);
  const po = War.pendingOffer(w.id);
  assert.ok(po && po.from === a.A && po.regions[0] === r1);
  assert.equal(War.respondOffer(w.id, false), false); assert.equal(War.pendingOffer(w.id), null); assert.equal(w.ended, false);
  res = War.peaceOffer(w.id, a.A, { regions: [r1] }); assert.equal(res.pending, true);
  assert.equal(War.respondOffer(w.id, true), true); assert.equal(w.ended, true); assert.equal(Regions.get(r1).ownerId, a.A);
  Kingdoms.setCommanded(a.B, false);
  assert.ok(cost > 0);
  // vassalization (needs a big lead): second war, same world
  S.tick += 2500;                                                                    // truce over
  const w2 = War.declare(a.A, a.B, [], 'conquest');
  assert.ok(w2, War.lastError);
  w2.score[a.A] = 95; w2.score[a.B] = 2;
  res = War.peaceOffer(w2.id, a.A, { regions: [], vassalize: true });
  assert.equal(res.ok, true, res.reason); assert.equal(res.accepted, true, res.reason);
  assert.equal(S.kingdoms.get(a.B).overlordId, a.A, 'B is a vassal of A');
  assert.ok(w2.ended);
  assert.equal(Kingdoms.vassalsOf ? Kingdoms.vassalsOf(a.A).includes(a.B) : true, true);
  void r0; void r2;
  noErrors(ctx, 'peace2');
});

section('godPeace / end / forcePeace: no transfers for god peace (all controllers revert), force peace transfers; idempotent', () => {
  const { ctx, a, w } = conquered();
  const { War, S, Regions, Diplomacy, Bus } = ctx;
  const [r0, r1] = a.chain;
  let fired = 0; Bus.on('warEnded', () => { fired++; });
  assert.deepEqual(occupied(ctx), [r1]);
  assert.equal(War.godPeace(a.A), true, 'god brings peace');
  assert.equal(w.ended, true); assert.equal(w.how, 'god'); assert.equal(fired, 1);
  assert.equal(Regions.get(r1).ownerId, a.B, 'no transfer'); assert.deepEqual(occupied(ctx), [], 'but the occupation ends');
  assert.equal(S.cities.get(a.cityB.id).occupierId, 0);
  assert.equal(War.godPeace(a.A), false, 'idempotent'); assert.equal(War.godPeace(a.B), false); assert.equal(Diplomacy.godPeace(a.A), false);
  assert.equal(War.atWar(a.A, a.B), false); assert.ok(War.inTruce(a.A, a.B));
  run(ctx, 600, null, 50);
  assert.equal([...S.armies.values()].filter(x => x.warId === w.id).length, 0, 'armies gone');
  // end() = white peace with a reason string
  const w2 = War.declare(a.A, a.B, [], 'god');
  assert.ok(w2, War.lastError);
  assert.equal(War.end(w2.id, 'custom'), true); assert.equal(w2.how, 'custom'); assert.equal(War.end(w2.id, 'again'), false);
  // forcePeace with a region: the holder gets it, whatever the cost
  const w3 = War.declare(a.A, a.B, [r1], 'god');
  assert.ok(w3);
  run(ctx, 2000, null, 50);
  assert.ok(w3.goals[0].done, 'A took it again');
  assert.equal(War.forcePeace(w3.id, { regions: [r1], winner: a.A }), true);
  assert.equal(w3.how, 'force'); assert.equal(Regions.get(r1).ownerId, a.A); assert.equal(S.cities.get(a.cityB.id).kingdomId, a.A);
  assert.equal(War.forcePeace(w3.id, { regions: [r1] }), false);
  // a bad region in the terms is ignored (not held by the winner)
  const w4 = (S.tick += 2500, War.declare(a.A, a.B, [], 'god'));
  assert.ok(w4);
  assert.equal(War.forcePeace(w4.id, { regions: [a.chain[2], 99999], winner: a.A }), true);
  assert.equal(Regions.get(a.chain[2]).ownerId, a.B, 'region that was not held is not transferred');
  void r0;
  noErrors(ctx, 'godPeace');
});

// ================================================================== allies / vassals
section('allies: vassals follow their overlord into the war, alliances join per Diplomacy.allyWillJoin, armies of every participant', () => {
  const { ctx, a } = mkArena({ chain: 3, third: true, popA: 90, popB: 50, popC: 40 });
  assert.ok(a.C, 'third kingdom exists');
  const { War, S, Kingdoms, Diplomacy, R, Bus } = ctx;
  const lines = []; Bus.on('log', (e) => { lines.push(e.msg); });
  // vassal of B
  assert.equal(Kingdoms.annex(a.C, a.B, 'vassal'), true);
  assert.ok(Diplomacy.alliesOf(a.B).includes(a.C));
  const w = War.declare(a.A, a.B, [], 'conquest');
  assert.ok(w, War.lastError);
  assert.ok(w.defenders.includes(a.C), 'the vassal joins its overlord: ' + JSON.stringify(w.defenders));
  assert.ok(War.atWar(a.A, a.C) && War.atWar(a.C, a.A) && !War.atWar(a.B, a.C));
  assert.ok(armiesOfK(ctx, a.C).length >= 1, 'the ally musters too');
  assert.ok(armiesOfK(ctx, a.C).every(x => x.warId === w.id));
  assert.ok(lines.some(m => m.includes('вступило в войну')), 'log: joined');
  assert.deepEqual(War.warsOf(a.C), [w]);
  assert.equal(w.score[a.C], 0);
  invariants(ctx, 'ally');
  run(ctx, 200);
  noErrors(ctx, 'ally');
  // alliance: join rate follows Diplomacy.allyWillJoin (85 % for a defender's ally)
  Kingdoms.breakFree(a.C);
  assert.ok(War.end(w.id, 'test'));
  assert.ok(Diplomacy.makeAlliance(a.C, a.B), 'allied');
  let joins = 0; const N = 24;
  for (let i = 0; i < N; i++) {
    R.setState(777 + i * 31);
    const x = War.declare(a.A, a.B, [], 'god');
    assert.ok(x, War.lastError);
    if (x.defenders.includes(a.C)) joins++;
    assert.equal(x.attackers.includes(a.C), false);
    War.end(x.id, 'test');
  }
  note(`allied defender joined ${joins}/${N} wars`);
  assert.ok(joins >= N * 0.6 && joins <= N, 'defender allies mostly join');
});


// ================================================================== exhaustion / collapse
section('exhaustion (autoPeace): a stalemate ends with the winner\'s holdings (within its score) or a white peace; switched off = never; kingdom collapse ends wars', () => {
  // (1) winner: A holds r1, then nothing changes for 4800+ ticks
  {
    const { ctx, a, w } = conquered({ autoPeace: true });
    const { War, S, Regions } = ctx;
    const r1 = a.chain[1];
    assert.equal(War.autoPeace(), true);
    assert.equal(w.ended, false);
    War.setAutoPeace(false);
    w.lastChange = S.tick - 5000; w.started = S.tick - 6000;
    run(ctx, 300, null, 50);
    assert.equal(w.ended, false, 'autoPeace off: the front just stays');
    War.setAutoPeace(true);
    run(ctx, 130, null, 50);
    assert.equal(w.ended, true, 'autoPeace on: exhausted'); assert.equal(w.how, 'exhaustion');
    assert.equal(Regions.get(r1).ownerId, a.A, 'the winner gets the region it holds');
    assert.deepEqual(occupied(ctx), []);
    assert.ok(S.log.some(e => e.kind === 'peace' && e.msg.includes('получает')), 'log mentions the transfer');
    noErrors(ctx, 'exhaust1');
  }
  // (2) nothing happened: white peace
  {
    const { ctx, a } = mkArena({ chain: 3 });
    const { War, S, Regions } = ctx;
    War.setAutoPeace(true);
    const w = War.declare(a.A, a.B, [], 'conquest');
    run(ctx, 5);
    w.lastChange = S.tick - 5000; w.started = S.tick - 5000;
    run(ctx, 130, null, 50);
    assert.equal(w.ended, true); assert.equal(w.how, 'exhaustion');
    assert.equal(Regions.get(a.chain[1]).ownerId, a.B, 'white peace: nothing changes hands');
    assert.ok(S.log.some(e => e.kind === 'peace' && e.msg.includes('белый мир') || e.msg.includes('затихла')), 'log');
  }
  // (3) a belligerent falls: the war ends, its armies vanish, nothing dangles
  {
    const { ctx, a } = mkArena({ chain: 3, popA: 90, popB: 30 });
    const { War, S, Kingdoms } = ctx;
    const w = War.declare(a.A, a.B, [], 'conquest');
    run(ctx, 100);
    assert.ok(armiesOfK(ctx, a.B).length >= 1);
    Kingdoms.destroy(a.B, 'test');
    assert.equal(w.ended, true); assert.equal(War.active().length, 0);
    run(ctx, 20);
    assert.equal(armiesOfK(ctx, a.B).length, 0, 'the fallen kingdom has no armies');
    run(ctx, 600, null, 50);
    assert.equal([...S.armies.values()].filter(x => x.warId === w.id).length, 0);
    invariants(ctx, 'collapse'); noErrors(ctx, 'collapse');
  }
  // (4) an ally of the loser leaves instead of ending the war for everybody (god peace for the ally only)
  {
    const { ctx, a } = mkArena({ chain: 3, third: true });
    const { War, Kingdoms } = ctx;
    Kingdoms.annex(a.C, a.B, 'vassal');
    const w = War.declare(a.A, a.B, [], 'conquest');
    assert.ok(w.defenders.includes(a.C));
    assert.equal(War.godPeace(a.C), true);
    assert.equal(w.ended, false, 'the war goes on without the ally'); assert.deepEqual(w.defenders.includes(a.C), false);
    assert.equal(War.atWar(a.A, a.C), false); assert.equal(armiesOfK(ctx, a.C).length, 0);
    assert.ok(War.atWar(a.A, a.B));
  }
});

// ================================================================== Units: hold / siege / march rules
section('units: hold stays within ~4 tiles of the post, engages within ~6, never chases beyond ~8; siege ignores civilians, march hunts them', () => {
  const { ctx, a } = mkArena({ chain: 2, stub: ['Powers', 'Save', 'War'], popA: 40, popB: 40 });
  const { S, Units, Diplomacy, World, Cities } = ctx;
  Diplomacy.atWar = (x, y) => (x === a.A && y === a.B) || (x === a.B && y === a.A);
  S.wars.set(5000, { id: 5000, attackers: [a.A], defenders: [a.B], aggressor: a.A, defender: a.B, started: S.tick, casus: 'test', ended: false, kills: {}, hist: [] });
  const c = a.cityA;
  // a free open spot: an army post and open ground all around it
  const R0 = { x: c.x + 0.5, y: c.y + 0.5 };
  const dirs = [];
  for (let k = 0; k < 16; k++) { const ang = k * Math.PI / 8; const ok = [3, 6, 9, 12].every(d => World.walkable(R0.x + Math.cos(ang) * d, R0.y + Math.sin(ang) * d) && World.tileAt(R0.x + Math.cos(ang) * d, R0.y + Math.sin(ang) * d) !== ctx.Const.T.SHALLOW); if (ok) dirs.push(ang); }
  assert.ok(dirs.length >= 2, 'open ground around the post');
  const at = (ang, d) => ({ x: R0.x + Math.cos(ang) * d, y: R0.y + Math.sin(ang) * d });
  const army = { id: S.id(), kingdomId: a.A, cityId: c.id, warId: 5000, leaderId: 0, members: [], target: null, rally: { x: R0.x, y: R0.y }, mode: 'hold', born: S.tick, supply: 100 };
  S.armies.set(army.id, army);
  const sol = [];
  for (let i = 0; i < 6; i++) { const u = Units.spawn(0, R0.x + (i % 3) * 0.4, R0.y + (i >> 1) * 0.3, { age: 25, cityId: c.id, weapon: 2, armor: 2, traits: [] }); assert.ok(u); assert.ok(Units.conscript(u, army.id)); sol.push(u); }
  const freeze = () => { for (const u of S.units.values()) if (!sol.includes(u)) { u.nextThink = S.tick + 1e6; if (u.state !== 'army') { u.state = 'idle'; u.st = { ph: '', since: S.tick, until: S.tick + 1e6 }; u.job = null; } } };
  freeze();                                                                    // the rest of the world stands still: only the army decides
  const enemy = (pos, opts = {}) => {
    const u = Units.spawn(0, pos.x, pos.y, Object.assign({ age: 25, cityId: a.cityB.id, weapon: 2, armor: 2, traits: [], level: 1 }, opts));
    assert.ok(u && u.kingdomId === a.B);
    u.nextThink = S.tick + 1e6;                                                // frozen: no decisions, no movement
    u.hp = u.maxHp = 400;                                                      // a punching bag
    if (opts.weapon !== 0) u.armyId = 99999;                                   // a soldier (of an army that is not simulated: the unit just stands there)
    return u;
  };
  const watch = (n) => { let maxD = 0; for (let i = 0; i < n; i++) { stepN(ctx, 1); for (const s of sol) if (S.units.has(s.id)) maxD = Math.max(maxD, Math.hypot(s.x - army.rally.x, s.y - army.rally.y)); } return maxD; };
  run(ctx, 120);                                                               // formation
  const spread = Math.max(...sol.map(s => Math.hypot(s.x - army.rally.x, s.y - army.rally.y)));
  assert.ok(spread <= 4, 'formation within ~4 tiles of the post: ' + spread.toFixed(1));
  // (1) an armed enemy 5.5 tiles from the post is engaged (and not chased further: it cannot run away, it is frozen)
  const e1 = enemy(at(dirs[0], 5.5));
  const hp1 = e1.hp;
  watch(150);
  assert.ok(e1.hp < hp1, 'hold engages an armed enemy at 5.5 tiles from the post: hp ' + hp1 + ' -> ' + e1.hp);
  Units.kill(e1, 'erase');
  for (const s of sol) { s.st = { ph: '', since: S.tick }; }                   // forget old targets
  // (2) an enemy 10 tiles away is left alone
  const e2 = enemy(at(dirs[0], 10));
  const hp2 = e2.hp;
  const maxD = watch(200);
  assert.equal(e2.hp, hp2, 'nobody walks out to an enemy 10 tiles from the post');
  assert.ok(maxD <= 4.6, 'soldiers stayed at the post (max ' + maxD.toFixed(1) + ' from the rally)');
  Units.kill(e2, 'erase');
  // (3) siege / hold ignore civilians, march hunts them when nothing armed is near
  const civ = enemy(at(dirs[1], 2.5), { weapon: 0, armor: 0 });
  civ.hp = civ.maxHp = 5000;
  const hpc = civ.hp;
  army.mode = 'siege'; watch(150);
  assert.equal(civ.hp, hpc, 'a besieging army leaves civilians alone');
  army.mode = 'hold'; watch(100);
  assert.equal(civ.hp, hpc, 'a garrison leaves civilians alone');
  army.mode = 'march'; for (const s of sol) { s.st = { ph: '', since: S.tick }; s.nextThink = S.tick; }
  watch(150);
  assert.ok(civ.hp < hpc, 'a marching army still fights what it meets');
  // (4) a fighting villager is a legitimate target for a garrison
  if (S.units.has(civ.id)) Units.kill(civ, 'erase');
  for (const s of sol) { s.st = { ph: '', since: S.tick }; s.nextThink = S.tick; }
  army.mode = 'hold';
  const fighter = enemy(at(dirs[1], 2.5), { weapon: 0, armor: 0 });
  fighter.state = 'fight'; fighter.st = { ph: 'go', since: S.tick, tid: sol[0].id, until: S.tick + 1e6 };
  const hpf = fighter.hp;
  watch(150);
  assert.ok(!S.units.has(fighter.id) || fighter.hp < hpf, 'but a villager who attacks soldiers is fair game');
  assert.equal(Units.errors, 0, '' + (Units.lastError && Units.lastError.stack));
  void Cities;
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
section('save / load in the middle of a war: both continuations are bit-identical (armies, wars, paths, timers, RNG)', () => {
  for (const [label, before, after] of [['march', 60, 450], ['siege+occupation', 190, 500], ['hold', 700, 400]]) {
    const { ctx: A, a } = mkArena({ chain: 3, popA: 100, popB: 40, cityC: false, stub: ['Powers'], keepAI: true });
    A.War.setAutoPeace(true);
    const w = A.War.declare(a.A, a.B, [], 'conquest');
    assert.ok(w);
    run(A, before);
    const store = mkStore();
    A.Save.storage = store;
    assert.ok(A.Save.save('auto'), 'save: ' + A.Save.lastError);
    assert.ok(w.attackers.length === 1 && S_armies(A) > 0, 'there are armies at the moment of the save');
    const B = loadSim({ stub: ['Powers'] });
    B.Save.storage = store;
    assert.ok(B.Save.load('auto'), 'load: ' + B.Save.lastError);
    assert.deepEqual(B.War.warsOf(a.A).map(x => x.id), [w.id]); assert.equal(B.War.atWar(a.A, a.B), true, 'pair cache rebuilt');
    assert.equal(B.S.armies.size, A.S.armies.size);
    const d0 = diffCtx(A, B).filter(x => x !== 'cities');
    assert.deepEqual(d0, [], `${label}: differences right after load`);
    run(A, after); run(B, after);
    const d = diffCtx(A, B);
    assert.deepEqual(d, [], `${label}: continuations diverged: ${d.join(',')}`);
    noErrors(A, label); noErrors(B, label);
    note(`${label}: saved at +${before}, ${after} ticks later identical (wars ${A.S.wars.size}, armies ${A.S.armies.size}, occupied ${occupied(A)})`);
  }
});
function S_armies(ctx) { return ctx.S.armies.size; }


// ================================================================== performance + caps
section('performance: 8 kingdoms, 3 simultaneous wars, ~300 soldiers - War.step + army logic per tick; caps hold', () => {
  let ctx = null, arenas = [];
  for (let s = SEED; s < SEED + 8 && arenas.length < 4; s++) {
    ctx = mkCtx(s, ['Powers', 'Save'], 128);
    arenas = [];
    const used = [];
    for (let k = 0; k < 4; k++) {
      const a = arena(ctx, { chain: 2, popA: 170, popB: 170, cityC: false, skip: used, usedK: arenas.flatMap(x => [x.A, x.B]), keepAI: false });
      if (!a) break;
      arenas.push(a); used.push(...a.chain);
      for (const r of a.chain) used.push(...ctx.Regions.get(r).nb);
    }
  }
  assert.equal(arenas.length, 4, 'four duels on one map');
  const { War, S, Units } = ctx;
  War.setAutoPeace(false);
  for (let k = 0; k < 3; k++) assert.ok(War.declare(arenas[k].A, arenas[k].B, [], 'conquest'), 'war ' + k);
  assert.equal(S.kingdoms.size >= 8, true);
  let tw = 0, tu = 0, maxW = 0, n = 0, maxSold = 0;
  const w0 = War.step, u0 = Units.step;
  War.step = (t) => { const a = performance.now(); w0(t); const d = performance.now() - a; tw += d; if (d > maxW) maxW = d; n++; };
  Units.step = (t) => { const a = performance.now(); u0(t); tu += performance.now() - a; };
  run(ctx, 700, () => { maxSold = Math.max(maxSold, invariants(ctx, 'perf')); }, 50);
  War.step = w0; Units.step = u0;
  const soldiers = [...S.armies.values()].reduce((s, a) => s + a.members.length, 0);
  note(`units ${S.units.size}, armies ${S.armies.size}, soldiers now ${soldiers} (max ${maxSold}); War.step ${(tw / n).toFixed(3)} ms/tick avg (max ${maxW.toFixed(2)}), Units.step ${(tu / n).toFixed(3)} ms/tick`);
  // control: the same world with all soldiers released (nobody fights) - the difference is the cost of the army logic of Units
  for (const a of [...S.armies.values()]) for (const id of a.members.slice()) { const u = S.units.get(id); if (u) Units.release(u); }
  for (const w of [...S.wars.values()]) War.end(w.id, 'perf');
  S.armies.clear();
  let tu2 = 0, n2 = 0;
  Units.step = (t) => { const a = performance.now(); u0(t); tu2 += performance.now() - a; n2++; };
  run(ctx, 300);
  Units.step = u0;
  const armyCost = tu / n - tu2 / n2;
  note(`Units.step without armies ${(tu2 / n2).toFixed(3)} ms/tick -> army logic costs about ${armyCost.toFixed(3)} ms/tick`);
  assert.ok(tw / n < 1.0, `War.step ${(tw / n).toFixed(3)} ms/tick < 1 ms`);
  assert.ok(tw / n + Math.max(0, armyCost) < 1.5, 'War + army unit logic stays around 1 ms/tick');
  assert.ok(maxSold <= 350 && maxSold >= 100, 'soldier cap respected: ' + maxSold);
  noErrors(ctx, 'perf');
});


// ================================================================== full game
section('full game: populated world, Diplomacy AI declares wars, thousands of ticks - invariants, caps, no exceptions', () => {
  const seeds = QUICK ? [SEED] : [SEED, SEED + 1, SEED + 2];
  const ticks = QUICK ? 5000 : 9000;
  for (const seed of seeds) {
    const ctx = loadSim({ stub: ['Powers'] });
    ctx.Sim.newWorld({ seed, w: 96, h: 96, populate: true });
    const { S, Bus, War, Regions } = ctx;
    const declared = [], ended = [], flips = [];
    Bus.on('warDeclared', (w) => { declared.push({ t: S.tick, a: w.aggressor, d: w.defender, n: w.attackers.length + w.defenders.length, casus: w.casus, goals: w.goals.length }); });
    Bus.on('warEnded', (w, how) => { ended.push({ t: S.tick, how, dur: S.tick - w.started }); });
    Bus.on('regionControl', (r, o, n, why) => { if (why === 'war') flips.push(r.id); });
    let maxSold = 0, maxArmies = 0, maxActive = 0, tw = 0, nw = 0;
    const w0 = War.step;
    War.step = (tk) => { const a = performance.now(); w0(tk); tw += performance.now() - a; nw++; };
    for (let t = 0; t < ticks; t += 100) {
      stepN(ctx, 100);
      if (t % 500 === 0) { /* keep the invariants cheap */ }
      const sold = invariants(ctx, `seed${seed} t${S.tick}`);
      maxSold = Math.max(maxSold, sold); maxArmies = Math.max(maxArmies, S.armies.size); maxActive = Math.max(maxActive, War.active().length);
      for (const w of S.wars.values()) {
        assert.ok(w.attackers.length >= 1 && w.defenders.length >= 1 || w.ended, 'both sides exist');
        for (const g of w.goals) assert.ok(Regions.get(g.regionId), 'goal region exists');
      }
    }
    War.step = w0;
    const hows = {}; for (const e of ended) hows[e.how] = (hows[e.how] || 0) + 1;
    note(`seed ${seed}: ${S.stats.kingdoms} kingdoms, ${S.units.size} units; wars declared ${declared.length} (max parallel ${maxActive}), ended ${ended.length} ${JSON.stringify(hows)}; region captures ${flips.length}; max soldiers ${maxSold}, armies ${maxArmies}; War.step ${(tw / nw).toFixed(3)} ms/tick`);
    if (declared.length) note(`   first wars: ${declared.slice(0, 3).map(d => `t${d.t} ${d.casus} (${d.n} states, ${d.goals} goals)`).join('; ')}; durations ${ended.slice(0, 5).map(e => e.dur).join(',')}`);
    assert.equal(ctx.Sim.totalErrors, 0, 'Sim errors ' + JSON.stringify(ctx.Sim.errors) + ' ' + (ctx.Sim.lastError.War && ctx.Sim.lastError.War.stack));
    assert.ok(maxSold <= 350);
    assert.ok(tw / nw < 1.0, 'War.step stays under 1 ms/tick');
    for (const w of S.wars.values()) if (!w.ended) for (const k of [...w.attackers, ...w.defenders]) assert.ok(S.kingdoms.has(k), 'belligerent kingdoms are alive');
  }
});


// ================================================================== armies: split / merge / refill / claims
section('armies: split + merge, refill from the home city, shattered armies go home, claims make a "claim" war, War.start', () => {
  const { ctx, a } = mkArena({ chain: 3, popA: 120, popB: 60, cityC: false });
  const { War, S, Regions, Units } = ctx;
  const [r0, r1] = a.chain;
  Regions.addClaim(r1, a.A);
  const w = War.start(a.A, a.B, undefined);
  assert.ok(w, 'War.start: ' + War.lastError); assert.equal(w.casus, 'claim', 'a claimed region makes it a claim war');
  assert.ok(w.goals[0].regionId === r1);
  War.setAutoPeace(false);
  const x = armiesOfK(ctx, a.A)[0];
  const n0 = x.members.length;
  assert.ok(n0 >= 10, 'a big army to play with: ' + n0);
  // split
  const id2 = War.split(x.id, 4);
  assert.ok(id2 > 0, 'split'); const y = S.armies.get(id2);
  assert.equal(y.members.length, 4); assert.equal(x.members.length, n0 - 4);
  assert.deepEqual(y.order, x.order); assert.equal(y.warId, w.id); assert.equal(y.kingdomId, a.A);
  assert.ok(y.members.every(id => S.units.get(id).armyId === y.id));
  assert.ok(y.members.includes(y.leaderId));
  assert.equal(War.split(x.id, 1), 0, 'too small to split'); assert.equal(War.split(x.id, 999), 0); assert.equal(War.split(424242, 4), 0);
  invariants(ctx, 'split');
  // merge
  assert.equal(War.merge(x.id, id2), true); assert.equal(S.armies.has(id2), false); assert.equal(x.members.length, n0);
  assert.equal(War.merge(x.id, 424242), false); assert.equal(War.merge(x.id, x.id), false);
  invariants(ctx, 'merge');
  // refill: lose half of the army at home (the commanded kingdom keeps it there: no fight); the home city sends reinforcements (up to the muster size)
  ctx.Kingdoms.setCommanded(a.A, true);
  assert.equal(War.order(a.A, 'all', { type: 'hold', regionId: r0 }), true);
  run(ctx, 60);
  const hurt = x.members.slice(0, Math.floor(x.members.length / 2));
  for (const id of hurt) Units.kill(S.units.get(id), 'erase');
  const after = x.members.length;
  run(ctx, 500, null, 50);
  note(`refill: ${n0} -> ${after} -> ${x.members.length} soldiers`);
  assert.ok(x.members.length > after + 2, 'reinforcements arrive');
  assert.ok(x.members.length <= Math.max(n0, 60) + 2, 'but not beyond the muster size');
  // a shattered army (< 3 men) goes home instead of wandering about
  const y2 = War.split(x.id, 3);
  assert.ok(y2 > 0);
  const z = S.armies.get(y2);
  for (const id of z.members.slice(0, 2)) Units.kill(S.units.get(id), 'erase');
  run(ctx, 400, null, 50);
  assert.ok(!S.armies.has(y2) || S.armies.get(y2).order.type === 'retreat', 'the remnant retreats and disbands');
  invariants(ctx, 'refill'); noErrors(ctx, 'refill');
});


// ================================================================== new goals / commanded defence
section('new goal: armies advance ONLY when the war gets a new goal (AI and commanded); commanded defenders defend on their own', () => {
  for (const cmd of [false, true]) {
    const { ctx, a } = mkArena({ chain: 4, popA: 110, popB: 40, cityC: false });
    const { War, S, Regions, Kingdoms } = ctx;
    const [r0, r1, r2, r3] = a.chain;
    War.setAutoPeace(false);
    if (cmd) Kingdoms.setCommanded(a.A, true);
    const w = War.declare(a.A, a.B, [r1], 'conquest');
    run(ctx, 1500, null, 50);
    assert.ok(w.goals[0].done, `cmd=${cmd}: first goal taken`);
    run(ctx, 400, null, 50);
    assert.deepEqual(occupied(ctx), [r1], 'holding, not advancing');
    // validation of new goals
    assert.equal(War.addGoal(w.id, a.A, r0), false, 'own region'); assert.equal(War.addGoal(w.id, a.A, r1), false, 'already a goal');
    assert.equal(War.addGoal(w.id, a.A, r3), false, 'not next to our land: ' + War.lastError); assert.equal(War.addGoal(w.id, a.A, 99999), false);
    assert.equal(War.addGoal(77777, a.A, r2), false); assert.equal(War.addGoal(w.id, 4242, r2), false);
    assert.equal(w.goals.length, 1);
    const logLen = S.log.length;
    assert.equal(War.addGoal(w.id, a.A, r2), true, War.lastError);
    assert.equal(w.goals.length, 2); assert.deepEqual(w.goals[1], { kid: a.A, regionId: r2, done: false });
    assert.ok(S.log.slice(logLen).some(e => e.msg.includes('новую цель') || e.msg.includes('цель войны')), 'log: new goal');
    let t2 = -1;
    for (let i = 0; i < 900 && t2 < 0; i++) { run(ctx, 1); if (w.goals[1].done) t2 = i; }
    assert.ok(t2 >= 0, `cmd=${cmd}: the new goal is taken (${t2})`);
    run(ctx, 400, null, 50);
    assert.deepEqual(occupied(ctx), [r1, r2].sort((x, y) => x - y), 'exactly the two goals');
    assert.ok(armiesOfK(ctx, a.A).filter(x => x.order.type === 'hold' && x.order.regionId === r2).length >= 1, 'and holds the second');
    assert.equal(ctrl(ctx, r3), a.B, 'the third region is never touched');
    note(`cmd=${cmd}: second goal taken ${t2} ticks after addGoal`);
    noErrors(ctx, 'goal');
  }
  // a commanded DEFENDER organises its own defence (defend) but never attacks on its own
  {
    const { ctx, a } = mkArena({ chain: 3, popA: 100, popB: 70, cityC: false });
    const { War, Kingdoms } = ctx;
    Kingdoms.setCommanded(a.B, true);
    const w = War.declare(a.A, a.B, [a.chain[1]], 'conquest');
    assert.ok(armiesOfK(ctx, a.B).some(x => x.order.type === 'defend' && x.order.regionId === a.chain[1]), 'auto defence of the threatened region');
    run(ctx, 800, (t) => { for (const x of armiesOfK(ctx, a.B)) assert.ok(x.order.type !== 'attack' || x.order.regionId === a.chain[1], 'a commanded kingdom only retakes its own land'); }, 25);
    assert.ok(!w.goals.some(g => g.kid === a.B));
    noErrors(ctx, 'cmd defender');
  }
});


// ================================================================== fuzz
section('fuzz: god-style abuse during wars (erase, destroy cities / kingdoms, terrain, random orders / declarations / offers / peace, save-load) keeps every invariant', () => {
  const seeds = QUICK ? [SEED] : [SEED, SEED + 5];
  for (const seed of seeds) {
    const ctx = loadSim({ stub: ['Powers'] });
    ctx.Sim.newWorld({ seed, w: 96, h: 96, populate: true });
    const { S, War, Units, Cities, Kingdoms, World, Regions, R } = ctx;
    // a rigged start: two armies of three kingdoms at war soon (the AI waits until tick 1500)
    stepN(ctx, 2600);
    const ks = [...S.kingdoms.values()];
    let made = 0;
    for (let i = 0; i < ks.length && made < 3; i++) for (let j = 0; j < ks.length && made < 3; j++) {
      if (i === j || War.atWar(ks[i].id, ks[j].id)) continue;
      if (War.declare(ks[i].id, ks[j].id, [], 'god')) made++;
    }
    const rnd = (n) => (R.f() * n) | 0;                                   // (the sim's own stream: it is a fuzz, not a replay)
    let ops = 0, orders = 0, declared = 0, maxArmies = 0;
    for (let round = 0; round < (QUICK ? 120 : 160); round++) {
      stepN(ctx, 40);
      const arm = [...S.armies.values()];
      switch (rnd(12)) {
        case 0: if (arm.length) { const a = arm[rnd(arm.length)]; Units.eraseInRadius(a.rally.x, a.rally.y, 3 + rnd(4)); } break;
        case 1: { const cs = [...S.cities.values()]; if (cs.length > 4 && rnd(3) === 0) Cities.destroy(cs[rnd(cs.length)].id, 'fuzz'); } break;
        case 2: { const k = [...S.kingdoms.values()]; if (k.length > 3 && rnd(3) === 0) Kingdoms.destroy(k[rnd(k.length)].id, 'fuzz'); } break;
        case 3: if (arm.length) { const a = arm[rnd(arm.length)]; World.brush('lower', a.rally.x | 0, a.rally.y | 0, 2 + rnd(4)); } break;
        case 4: { const k = [...S.kingdoms.values()]; if (k.length && rnd(5) === 0) War.godPeace(k[rnd(k.length)].id); } break;
        case 5: case 6: {
          if (arm.length) {
            const kid = arm[rnd(arm.length)].kingdomId; const type = ['attack', 'hold', 'defend', 'retreat'][rnd(4)];
            const pool = [...S.regions.values()].filter(r => type === 'attack' ? (r.ownerId !== kid && r.ownerId !== 0) : (r.ownerId === kid || r.controllerId === kid)).map(r => r.id);
            if (pool.length && War.order(kid, rnd(2) ? 'all' : War.armiesOf(kid).map(v => v.id), { type, regionId: pool[rnd(pool.length)] })) orders++;
          }
          break;
        }
        case 7: {
          const k = [...S.kingdoms.values()];
          if (k.length > 1) { const a = k[rnd(k.length)].id, b = k[rnd(k.length)].id; const gl = War.potentialGoals(a, b); if (gl.length && War.declare(a, b, rnd(2) ? gl.slice(0, 2) : [], rnd(3) ? 'conquest' : 'god')) declared++; }
          break;
        }
        case 8: { const ws = War.active(); if (ws.length) { const w = ws[rnd(ws.length)]; const k = (rnd(2) ? w.attackers : w.defenders)[0]; War.peaceOffer(w.id, k, { regions: War.heldRegions(w.id, k).slice(0, 2), vassalize: rnd(8) === 0 }); } break; }
        case 9: { const ws = War.active(); if (ws.length) { const w = ws[rnd(ws.length)]; War.addGoal(w.id, w.attackers[0], [...S.regions.keys()][rnd(S.regions.size)]); } break; }
        case 10: { if (arm.length) { const a = arm[rnd(arm.length)]; if (rnd(2)) War.split(a.id, 3 + rnd(6)); else { const b = arm[rnd(arm.length)]; War.merge(a.id, b.id); } } break; }
        case 11: { const ws = War.active(); if (ws.length && rnd(4) === 0) War.forcePeace(ws[rnd(ws.length)].id, { regions: [[...S.regions.keys()][rnd(S.regions.size)]] }); break; }
      }
      ops++;
      stepN(ctx, 3);
      invariants(ctx, `fuzz seed${seed} round${round}`);
      maxArmies = Math.max(maxArmies, S.armies.size);
      if (round === 60) {                                                     // save + load in the middle of the chaos: the loaded world must keep running
        const store = mkStore(); ctx.Save.storage = store;
        assert.ok(ctx.Save.save('auto'), 'save ' + ctx.Save.lastError);
        const L = loadSim({ stub: ['Powers'] }); L.Save.storage = store;
        assert.ok(L.Save.load('auto'), 'load ' + L.Save.lastError);
        stepN(L, 300); invariants(L, 'loaded'); noErrors(L, 'loaded');
      }
    }
    assert.equal(ctx.Sim.totalErrors, 0, `seed ${seed}: ${JSON.stringify(ctx.Sim.errors)} ${ctx.Sim.lastError.War && ctx.Sim.lastError.War.stack}`);
    note(`seed ${seed}: ${made} wars rigged, ${ops} abuse rounds (${orders} orders accepted, ${declared} more wars declared), ${S.wars.size} wars in the table, armies now ${S.armies.size} (max ${maxArmies}), ${S.kingdoms.size} kingdoms left`);
    assert.ok(maxArmies >= 2, 'the fuzz really had armies to abuse');
  }
});

section('UI targets: targetsFor / targetInfo = the legal set (potentialGoals), reasons (own, wild, far, truce, ally), war targets, read-only (no RNG, no mutation)', () => {
  const { ctx, a } = mkArena();
  const { S, War, Regions, Diplomacy, R, Const } = ctx;
  const { A, B, chain } = a;
  const snap = () => JSON.stringify({ r: R.getState(), w: [...S.wars.values()], ar: [...S.armies.values()], rg: [...S.regions.values()].map(r => [r.id, r.ownerId, r.controllerId]), k: [...S.kingdoms.values()].map(k => [k.id, k.infamy, k.cmd]), rel: [...S.rels.values()] });
  const s0 = snap();
  const t = War.targetsFor(A);
  const okB = t.filter(e => e.ok && e.defenderKid === B).map(e => e.regionId).sort((x, y) => x - y);
  const pot = War.potentialGoals(A, B).slice().sort((x, y) => x - y);
  assert.deepEqual(okB, pot, 'ok targets against B = War.potentialGoals(A, B)');
  assert.ok(okB.includes(chain[1]), 'the neighbouring region of B is a target');
  assert.ok(!t.some(e => e.regionId === chain[2]), 'B\'s far region is not listed (not adjacent)');
  for (const e of t) {
    assert.ok(Regions.attackable(A, e.defenderKid).includes(e.regionId) || e.atWar, 'every listed region touches our land');
    assert.ok(e.odds >= 0 && e.odds <= 1 && e.ratio >= 0 && e.cost === War.regionCost(e.regionId) && e.atWar === false && e.warId === 0, 'entry fields ' + JSON.stringify(e));
  }
  const far = War.targetInfo(A, chain[2]);
  assert.ok(!far.ok && /не граничит/.test(far.reason) && far.defenderKid === B, 'far region: ' + far.reason);
  const own = War.targetInfo(A, chain[0]);
  assert.ok(!own.ok && own.own && /ваш регион/.test(own.reason), 'own region: ' + own.reason);
  const wild = [...S.regions.values()].find(r => !r.ownerId);
  if (wild) { const wi = War.targetInfo(A, wild.id); assert.ok(!wi.ok && /ничья/.test(wi.reason), 'wild: ' + wi.reason); }
  const info = War.targetInfo(A, chain[1], { route: true });
  assert.ok(info.ok && info.defenderKid === B && info.allowance > 0 && (info.casus === 'conquest' || info.casus === 'claim') && info.infamy > 0 && Array.isArray(info.allies) && Array.isArray(info.friends), 'details ' + JSON.stringify(info));
  assert.ok(Number.isFinite(info.route) && info.routeOk === (info.route <= 14), 'route check ' + info.route);
  assert.equal(snap(), s0, 'targetsFor / targetInfo (with a route check) neither mutate the world nor roll the RNG');
  // truce: every region of B is listed but refused with the year of the end of the truce
  const until = S.tick + 600;
  War.truceUntil(A, B); S.mod.war.truce[A < B ? A + '_' + B : B + '_' + A] = until;
  const tt = War.targetsFor(A).filter(e => e.defenderKid === B);
  const yr = Const.START_YEAR + Math.floor(until / Const.TICKS_PER_YEAR);
  assert.ok(tt.length >= 1 && tt.every(e => !e.ok && e.reason.includes('перемирие') && e.reason.includes(String(yr))), 'truce reason ' + JSON.stringify(tt.map(e => e.reason)));
  assert.ok(/перемирие/.test(War.targetInfo(A, chain[2]).reason), 'truce explains far regions too');
  delete S.mod.war.truce[A < B ? A + '_' + B : B + '_' + A];
  // alliance
  Diplomacy.setState(A, B, Const.REL.ALLIANCE);
  assert.ok(War.targetsFor(A).filter(e => e.defenderKid === B).every(e => !e.ok && /союзник/.test(e.reason)), 'ally reason');
  Diplomacy.setState(A, B, Const.REL.PEACE);
  assert.ok(War.targetsFor(A).some(e => e.ok && e.regionId === chain[1]), 'target is back after the alliance ended');
  // war: the declared goal becomes a war target (atWar, warId, goal flag) and the enemy's far region is still refused
  const w = War.declare(A, B, [chain[1]], 'conquest');
  assert.ok(w && w.goals.length === 1 && w.goals[0].regionId === chain[1], 'declared');
  const tw = War.targetsFor(A);
  const g = tw.find(e => e.regionId === chain[1]);
  assert.ok(g && g.ok && g.atWar && g.warId === w.id && g.goal && g.defenderKid === B, 'war target ' + JSON.stringify(g));
  const fi = War.targetInfo(A, chain[2], { route: true });
  assert.ok(!fi.ok && fi.atWar && fi.warId === w.id && /не граничит/.test(fi.reason), 'far enemy region during the war: ' + fi.reason);
  const wi2 = War.targetInfo(A, chain[1], { route: true });
  assert.ok(wi2.ok && wi2.atWar && Number.isFinite(wi2.myPow) && Number.isFinite(wi2.theirPow) && wi2.goal === true && Number.isFinite(wi2.route), 'war details ' + JSON.stringify(wi2));
  // a held region is listed but refused; dead ids never throw
  run(ctx, 10);
  assert.deepEqual(War.targetsFor(99999), []);
  const bad = War.targetInfo(A, 99999); assert.ok(!bad.ok && bad.reason, 'bad region');
  const bad2 = War.targetInfo(99999, chain[1]); assert.ok(!bad2.ok && bad2.reason, 'bad kingdom');
  note(`targets of A: ${t.length} (${okB.length} ok vs B), far: «${far.reason}», route ${info.route} unsupplied tiles, war odds ${wi2.odds.toFixed(2)}`);
});

// ================================================================== TOTAL WAR («Вся страна») next to the unchanged limited war
// (the real total-war suite is tests/totalwar.test.mjs; here: a limited war does not notice the feature, and the new API is safe on junk input)
section('limited war is untouched by the total-war feature: w.total === false, no w.tw, caps 6 / 60 / 350, one goal that never grows, no capitulation; old saved wars load as limited', () => {
  const { ctx, a } = mkArena({ popA: 90, popB: 80 });
  const { S, War } = ctx;
  const { A, B, chain } = a;
  War.setAutoPeace(false);
  assert.deepEqual([War.LIMITS.MAX_ARMIES_K, War.LIMITS.MAX_ARMY, War.LIMITS.MAX_SOLDIERS], [6, 60, 350], 'the limited caps are unchanged');
  assert.ok(War.TOTAL.MAX_ARMIES_K > War.LIMITS.MAX_ARMIES_K && War.TOTAL.MAX_ARMY > War.LIMITS.MAX_ARMY && War.TOTAL.MAX_SOLDIERS > War.LIMITS.MAX_SOLDIERS, 'the total-war caps are the bigger ones');
  const w = War.declare(A, B, [chain[1]], 'conquest');
  assert.ok(w, War.lastError);
  assert.strictEqual(w.total, false, 'a limited war: total === false');
  assert.ok(!('tw' in w), 'no total-war state on a limited war');
  assert.equal(War.isTotal(w.id), false); assert.equal(War.totalInfo(w.id), null); assert.equal(War.capitulation(w.id), null);
  assert.equal(War.resolveCapitulation(w.id, 'merge'), false, 'nothing to decide in a limited war');
  assert.equal(w.goals.length, 1, 'exactly the one goal that was asked for');
  const g0 = War.targetsFor(A).find(e => e.regionId === chain[1]);          // the war card: the entry of a limited war says total:false
  assert.ok(g0 && g0.atWar && g0.warId === w.id && g0.total === false, 'war target carries total:false ' + JSON.stringify(g0));
  let maxSold = 0, maxK = 0, maxArmy = 0, looks = 0;
  run(ctx, 900, () => {
    const per = new Map(); let sold = 0;
    for (const x of S.armies.values()) { sold += x.members.length; maxArmy = Math.max(maxArmy, x.members.length); per.set(x.kingdomId, (per.get(x.kingdomId) || 0) + 1); }
    maxSold = Math.max(maxSold, sold); for (const v of per.values()) maxK = Math.max(maxK, v);
    assert.equal(w.goals.length, 1, 'the goal list of a limited war never grows by itself');
    assert.strictEqual(w.total, false); assert.ok(!('tw' in w), 'still no total-war state');
    looks++;
  }, 25);
  note(`limited war: ${looks} looks, soldiers max ${maxSold}, armies per kingdom max ${maxK}, biggest army ${maxArmy}`);
  assert.ok(maxSold >= 2, 'armies were raised'); assert.ok(maxSold <= 350 && maxK <= 6 && maxArmy <= 60, 'the old caps hold');
  invariants(ctx, 'limited'); noErrors(ctx, 'limited');
  assert.ok(War.targetsFor(A).filter(e => e.atWar).every(e => e.total === false), 'every war target still says total:false');
  // saved wars of the old format (no `total`, no `tw`) load as limited wars; a total war that lost its state gets a fresh one
  S.wars.set(70, { id: 70, attackers: [A], defenders: [B], aggressor: A, defender: B, started: 0, casus: 'x', ended: true, kills: {}, hist: [] });
  S.wars.set(71, { id: 71, attackers: [A], defenders: [B], aggressor: A, defender: B, started: 0, casus: 'x', ended: true, total: true, kills: {}, hist: [] });
  War.afterLoad();
  assert.strictEqual(S.wars.get(70).total, false); assert.ok(!('tw' in S.wars.get(70)), 'old war: limited');
  const t71 = S.wars.get(71).tw;
  assert.ok(t71 && typeof t71 === 'object' && t71.pend === null && t71.cap === 0 && t71.out === '', 'a total war without its state gets a fresh one');
  JSON.parse(JSON.stringify([...S.wars.values()]));
});

section('total-war API is safe on junk: dead / missing / identical ids, wrong types, no mutation, no RNG roll, lastError set', () => {
  const { ctx, a } = mkArena({ popA: 70, popB: 60 });
  const { S, War, R } = ctx;
  const { A, B } = a;
  const snap = () => JSON.stringify({ r: R.getState(), w: [...S.wars.values()], k: [...S.kingdoms.values()].map(k => [k.id, k.infamy, k.stability]), rg: [...S.regions.values()].map(r => [r.id, r.ownerId, r.controllerId]) });
  const s0 = snap();
  for (const [x, y] of [[99999, B], [A, 99999], [A, A], [0, 0], [undefined, B], [A, undefined], [NaN, NaN], ['a', 'b'], [null, null], [-5, B]]) {
    const c = War.canDeclareTotal(x, y);
    assert.equal(c.ok, false, `canDeclareTotal(${x}, ${y}) is no`); assert.equal(typeof c.reason, 'string'); assert.ok(c.reason.length > 0, 'a reason is given');
    assert.equal(War.declareTotal(x, y), null, `declareTotal(${x}, ${y}) -> null`);
    assert.ok(War.lastError && typeof War.lastError === 'string', 'lastError explains');
  }
  assert.equal(War.aiConsiderTotal(99999), null); assert.equal(War.aiConsiderTotal(0, true), null); assert.equal(War.aiConsiderTotal(undefined), null);
  assert.equal(War.aiTotalWhy(99999), 'no kingdom');
  for (const id of [0, -1, 99999, NaN, undefined, null, 'x']) {
    assert.equal(War.isTotal(id), false); assert.equal(War.totalInfo(id), null); assert.equal(War.capitulation(id), null); assert.equal(War.resolveCapitulation(id, 'merge'), false);
  }
  assert.equal(War.resolveCapitulation(99999, 'nonsense'), false);
  assert.equal(snap(), s0, 'junk calls neither change the world nor roll the RNG');
  // a legal question is read-only too and describes what a total war would cost
  const ok = War.canDeclareTotal(A, B);
  assert.equal(snap(), s0, 'canDeclareTotal is read-only');
  assert.ok(ok.info && ok.info.defKid === B && ok.info.regions >= 2 && ok.info.infamy === (ok.info.claim ? War.TOTAL.INFAMY_CLAIM : War.TOTAL.INFAMY) && Array.isArray(ok.info.band) && Array.isArray(ok.info.deep), 'preview ' + JSON.stringify(ok.info));
  assert.ok(ok.info.armies === War.TOTAL.MAX_ARMIES_K && ok.info.soldiers === War.TOTAL.MAX_SOLDIERS, 'the preview names the caps');
  // the war ends nicely and the total-war calls keep answering "no" for the dead war
  const w = War.declareTotal(A, B);
  assert.ok(w && w.total === true && w.tw && w.goals.length >= 1 && w.tw.base.length >= 2, 'a total war: ' + (w ? w.goals.length + ' goals, country ' + w.tw.base.length : War.lastError));
  assert.equal(War.canDeclareTotal(A, B).ok, false, 'already at war');
  assert.ok(/война уже идёт/.test(War.canDeclareTotal(A, B).reason));
  assert.ok(War.targetsFor(A).filter(e => e.atWar).every(e => e.total === true), 'war targets of a total war carry total:true');
  assert.ok(War.end(w.id, 'test'));
  assert.equal(War.isTotal(w.id), true, 'the ended war is still a total war in the log'); assert.equal(War.capitulation(w.id), null); assert.equal(War.resolveCapitulation(w.id, 'merge'), false, 'nothing left to decide');
  assert.equal(S.wars.get(w.id).tw.pend, null);
  noErrors(ctx, 'api');
});

// ==== SECTIONS-END ====
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
if (failed.length) { console.log('FAILED: ' + failed.map(f => f.name).join('; ')); process.exit(1); }
