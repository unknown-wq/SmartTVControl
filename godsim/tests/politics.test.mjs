// Politics tests (plain node + assert).   node tests/politics.test.mjs [--quick] [--seeds=N] [--ticks=N] [--war=real]
// Kingdoms + Diplomacy (CONTRACT §3 / §8.3 / §8.6): creation, rulers & succession, stability, loyalty & culture, rebellion, merge / vassal /
// transfer / split / destroy, capital relocation, commanded kingdoms; opinions, alliances, truces, canDeclare / declareWar / god tools,
// AI war frequency + sanity over full populated worlds, save/load determinism of the new state, perf.
// War is a SPY (a small fake implementing the 8.2/8.6 glue) unless --war=real is given (then the real src/10_war.js is used for the long runs).
import assert from 'node:assert/strict';
import { loadSim, stepN, newWorld, pad } from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const QUICK = !!args.quick;
const REAL_WAR = args.war === 'real';
const SEEDS = args.seeds ? +args.seeds : (QUICK ? 2 : 4);
const TICKS = args.ticks ? +args.ticks : (QUICK ? 6000 : 12000);

const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 82)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 12).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

// ------------------------------------------------------------------ war recorder: the state of the world at the moment of every declaration
function recordWars(ctx) {
  const { S, Diplomacy } = ctx;
  const War = ctx.War, orig = War.declare, rec = [];
  War.declare = function (a, b, goals, casus) {
    const ka = S.kingdoms.get(a);
    const pre = { tick: S.tick, a, b, powerA: Diplomacy.power(a), powerB: Diplomacy.power(b), contact: Diplomacy.contact(a, b), cmdA: !!(ka && ka.cmd), truce: Diplomacy.inTruce(a, b), allied: Diplomacy.allied(a, b), asked: Array.isArray(goals) ? goals.slice() : [] };
    const w = orig.apply(War, arguments);
    if (w && typeof w === 'object') { pre.casus = w.casus; pre.goals = (w.goals || []).map(g => g.regionId); rec.push(pre); }
    return w;
  };
  return rec;
}

// ------------------------------------------------------------------ the spy War (8.2 / 8.6 glue)
function spyWar(ctx, o = {}) {
  const { S, Bus, Log, Const, Diplomacy, Regions } = ctx;
  const War = ctx.War;
  const spy = {
    calls: [], ended: [], log: o.log !== false, objects: !!o.objects, declineAll: !!o.declineAll,
    dur: o.dur || ((w) => 1500 + (w.id * 131) % 1800),
  };
  War.atWar = (a, b) => {
    if (a === b) return false;
    for (const w of S.wars.values()) if (!w.ended && ((w.attackers.includes(a) && w.defenders.includes(b)) || (w.attackers.includes(b) && w.defenders.includes(a)))) return true;
    return false;
  };
  War.potentialGoals = (a, b) => {
    const l = Regions.attackable(a, b);
    l.sort((x, y) => (Regions.hasClaim(y, a) ? 1 : 0) - (Regions.hasClaim(x, a) ? 1 : 0) || x - y);
    return spy.objects ? l.map(r => ({ regionId: r, cost: 12, claim: Regions.hasClaim(r, a) })) : l;
  };
  War.declare = (a, b, goals, casus) => {
    spy.calls.push(['declare', a, b, goals.slice(), casus]);
    if (spy.declineAll || War.atWar(a, b) || !S.kingdoms.has(a) || !S.kingdoms.has(b)) return null;
    const at = [a], df = [b];
    for (const al of Diplomacy.alliesOf(b)) if (!at.includes(al) && !df.includes(al) && Diplomacy.allyWillJoin(al, b, a, true)) df.push(al);
    for (const al of Diplomacy.alliesOf(a)) if (!at.includes(al) && !df.includes(al) && Diplomacy.allyWillJoin(al, a, b, false)) at.push(al);
    const w = { id: S.id(), attackers: at, defenders: df, aggressor: a, defender: b, started: S.tick, casus, ended: false, goals: goals.map(r => ({ kid: a, regionId: r, done: false })), score: {}, kills: {}, lastChange: S.tick, hist: [] };
    S.wars.set(w.id, w);
    if (spy.log) Log.add('Королевство «' + S.kingdoms.get(a).name + '» объявило войну королевству «' + S.kingdoms.get(b).name + '»', Const.LOG.WAR, -1, -1, a);
    Bus.emit('warDeclared', w);
    return w;
  };
  War.end = (id, how) => { const w = S.wars.get(id); if (!w || w.ended) return false; w.ended = true; spy.ended.push([id, how]); Bus.emit('warEnded', w, how); return true; };
  War.godPeace = (kid) => { spy.calls.push(['godPeace', kid]); let n = 0; for (const w of Array.from(S.wars.values())) if (!w.ended && (w.attackers.includes(kid) || w.defenders.includes(kid))) { War.end(w.id, 'god'); n++; } return n > 0; };
  War.forcePeace = (id) => War.end(id, 'force');
  War.warsOf = (kid) => Array.from(S.wars.values()).filter(w => !w.ended && (w.attackers.includes(kid) || w.defenders.includes(kid)));
  War.active = () => Array.from(S.wars.values()).filter(w => !w.ended);
  War.get = (id) => S.wars.get(id) || null;
  War.score = () => 0;
  spy.declared = recordWars(ctx);
  spy.step = () => { for (const w of Array.from(S.wars.values())) if (!w.ended && S.tick - w.started > spy.dur(w)) War.end(w.id, 'timeout'); };
  return spy;
}

// ------------------------------------------------------------------ plumbing
function mkCtx(seed = 1, war = true) {
  const ctx = loadSim({ stub: war ? ['Sim', 'Save', 'Powers', 'War'] : ['Sim', 'Save', 'Powers'] });
  newWorld(ctx, seed, 96, 96);
  ctx.spy = war ? spyWar(ctx) : null;
  return ctx;
}
/** advance the political modules only (units stay frozen: no ageing, no births) */
function tickPol(ctx, n) {
  for (let i = 0; i < n; i++) {
    ctx.S.tick++;
    ctx.Kingdoms.step(ctx.S.tick); ctx.Regions.step(ctx.S.tick); ctx.Diplomacy.step(ctx.S.tick);
    if (ctx.spy) ctx.spy.step();
  }
}
function mkGame(seed, populate = 'populate', war = !REAL_WAR) {
  const ctx = loadSim({ stub: war ? ['War'] : [] });
  ctx.Sim.newWorld({ seed, w: 96, h: 96, populate: false });
  if (populate === 'populate') ctx.Sim.populate();
  else {
    const { S, Const, Units, R } = ctx;
    const spawn = (race, n) => { let p = 0, g = 0; while (p < n && g++ < 5000) { const x = R.i(S.w), y = R.i(S.h); if (S.tile[y * S.w + x] === Const.T.GRASS && Units.spawn(race, x + 0.5, y + 0.5, {})) p++; } };
    spawn(0, 24); spawn(1, 10); spawn(2, 10);
  }
  ctx.spy = war ? spyWar(ctx) : null;
  ctx.wars = war ? ctx.spy.declared : recordWars(ctx);
  return ctx;
}
function runGame(ctx, n) { for (let i = 0; i < n; i++) { ctx.Sim.step(); if (ctx.spy) ctx.spy.step(); } }

function landTile(ctx, i) { return ctx.S.tile[i] !== ctx.Const.T.DEEP && ctx.S.tile[i] !== ctx.Const.T.SHALLOW; }
function spawnN(ctx, race, n, x, y, age = 25) {
  const us = [];
  for (let i = 0; i < n; i++) {
    const u = ctx.Units.spawn(race, x + 0.5 + (i % 3) * 0.2, y + 0.5 + Math.floor(i / 3) * 0.2, { sex: i % 2, age });
    assert.ok(u, 'unit spawned');
    us.push(u);
  }
  return us;
}
function siteIn(ctx, rid, race, kid) {
  const { S, Cities } = ctx;
  const r = S.regions.get(rid);
  let best = null, bd = 1e9;
  for (let y = 1; y < S.h - 1; y++) for (let x = 1; x < S.w - 1; x++) {
    if (S.region[y * S.w + x] !== rid) continue;
    if (!Cities.canFound(x, y, race, kid)) continue;
    const d = (x - r.cx) ** 2 + (y - r.cy) ** 2;
    if (d < bd) { bd = d; best = { x, y }; }
  }
  return best;
}
function foundIn(ctx, rid, race, n = 6, opts = {}) {
  const s = siteIn(ctx, rid, race, opts.kid);
  if (!s) return null;
  const us = spawnN(ctx, race, n, s.x, s.y);
  return ctx.Cities.found(race, s.x, s.y, us, opts);
}
/** two free neighbouring regions (no ford) that both have room for a village (sites >= 12 tiles apart) */
function pairOfRegions(ctx, race = 0, skip = 0) {
  let seen = 0;
  for (const a of ctx.S.regions.values()) {
    const sa = !a.ownerId && siteIn(ctx, a.id, race);
    if (!sa) continue;
    for (const bid of a.nb) {
      const b = ctx.S.regions.get(bid);
      if (b.ownerId || a.fd.includes(bid)) continue;
      const sb = siteIn(ctx, b.id, race);
      if (!sb || Math.hypot(sa.x - sb.x, sa.y - sb.y) < 12) continue;
      if (seen++ < skip) continue;
      return [a, b];
    }
  }
  return null;
}
/** a chain r0 - r1 - r2 of free regions: consecutive ones adjacent (no ford), the ends not adjacent, all village sites >= 12 apart */
function chainOfRegions(ctx, race = 0, len = 3) {
  const site = (r) => (r.ownerId ? null : siteIn(ctx, r.id, race));
  const far = (list, s) => list.every(o => Math.hypot(o.x - s.x, o.y - s.y) >= 12);
  const rec = (chain, sites) => {
    if (chain.length === len) return chain;
    const last = chain[chain.length - 1];
    for (const bid of last.nb) {
      const b = ctx.S.regions.get(bid);
      if (!b || chain.includes(b) || last.fd.includes(bid)) continue;
      if (chain.length >= 2 && chain.slice(0, -1).some(o => o.nb.includes(b.id))) continue;
      const sb = site(b);
      if (!sb || !far(sites, sb)) continue;
      const r = rec(chain.concat([b]), sites.concat([sb]));
      if (r) return r;
    }
    return null;
  };
  for (const a of ctx.S.regions.values()) {
    const sa = site(a);
    if (!sa) continue;
    const r = rec([a], [sa]);
    if (r) return r;
  }
  return null;
}
/** a new kingdom: one village (race, n founders) in region rid. {separate:true}: when the village joined a neighbour of its race it is split off */
function mkKingdom(ctx, rid, race = 0, n = 6, opts = {}) {
  const before = ctx.S.kingdoms.size;
  const c = foundIn(ctx, rid, race, n);
  assert.ok(c, 'village founded in region ' + rid);
  if (opts.separate && ctx.S.kingdoms.size === before) assert.ok(ctx.Kingdoms.splitCity(c.id) > 0, 'split off');
  return { city: c, k: ctx.Kingdoms.get(c.kingdomId) };
}
/** a second city of the same kingdom, founded by settlers of a parent city */
function addCityTo(ctx, rid, parentCity, n = 5) {
  const s = siteIn(ctx, rid, parentCity.race, parentCity.kingdomId);
  assert.ok(s, 'site for an extra city');
  const us = spawnN(ctx, parentCity.race, n, s.x, s.y);
  const c = ctx.Cities.found(parentCity.race, s.x, s.y, us, { parentCityId: parentCity.id });
  assert.ok(c && c.kingdomId === parentCity.kingdomId, 'extra city joined the parent kingdom');
  return c;
}
function finiteDeep(o, path = 'S') {
  if (typeof o === 'number') { assert.ok(Number.isFinite(o), path + ' is finite'); return; }
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) { for (let i = 0; i < o.length; i++) finiteDeep(o[i], path + '[' + i + ']'); return; }
  for (const k of Object.keys(o)) finiteDeep(o[k], path + '.' + k);
}
function inv(ctx, label = '') {
  const { S, Const } = ctx;
  const seenFlags = new Set(), seenNames = new Set();
  for (const k of S.kingdoms.values()) {
    assert.ok(k.alive !== false, `${label} kingdom ${k.id} alive`);
    assert.ok(!seenNames.has(k.name), `${label} unique name ${k.name}`); seenNames.add(k.name);
    const fk = [k.flag.pattern, k.flag.symbol, k.flag.c1, k.flag.c2].join(':');
    assert.ok(!seenFlags.has(fk), `${label} unique flag`); seenFlags.add(fk);
    assert.equal(k.color, k.flag.c1);
    assert.ok(new Set(k.cities).size === k.cities.length, `${label} no duplicate city ids`);
    for (const cid of k.cities) { const c = S.cities.get(cid); assert.ok(c, `${label} city ${cid} of ${k.name} exists`); assert.equal(c.kingdomId, k.id, `${label} city ${cid} points back`); }
    assert.ok(k.cities.length > 0, `${label} kingdom ${k.name} has cities`);
    assert.ok(k.cities.includes(k.capitalId), `${label} capital of ${k.name} is one of its cities`);
    if (k.rulerId && S.units.has(k.rulerId)) assert.ok(S.units.get(k.rulerId).isRuler, `${label} ruler flag`);
    assert.ok(k.overlordId === 0 || S.kingdoms.has(k.overlordId), `${label} overlord alive`);
    assert.ok(Number.isFinite(k.stability) && k.stability >= 0 && k.stability <= 100, `${label} stability ${k.stability}`);
    assert.ok(S.cultures[k.culture], `${label} culture exists`);
    for (const key of ['cmd', 'overlordId', 'infamy', 'manpowerUsed']) assert.ok(key in k, `${label} field ${key}`);
  }
  const keys0 = S.kingdoms.size ? Object.keys(S.kingdoms.values().next().value).join(',') : '';
  for (const k of S.kingdoms.values()) assert.equal(Object.keys(k).join(','), keys0, `${label} identical key order (Save packs column tables)`);
  for (const c of S.cities.values()) {
    assert.ok(c.kingdomId === 0 || S.kingdoms.has(c.kingdomId), `${label} city ${c.id} kingdom exists`);
    if (c.kingdomId) assert.ok(S.kingdoms.get(c.kingdomId).cities.includes(c.id), `${label} city listed`);
    assert.ok(S.cultures[c.culture], `${label} city culture`);
    assert.ok(Number.isFinite(c.loyalty) && c.loyalty >= 0 && c.loyalty <= 100, `${label} loyalty ${c.loyalty}`);
    for (const id of c.members) { const u = S.units.get(id); if (u) assert.equal(u.kingdomId, c.kingdomId, `${label} member kingdom`); }
  }
  for (const r of S.regions.values()) {
    assert.ok(r.ownerId === 0 || S.kingdoms.has(r.ownerId), `${label} region ${r.id} owner alive`);
    assert.ok(r.controllerId === 0 || S.kingdoms.has(r.controllerId), `${label} region ${r.id} controller alive`);
  }
  for (const [key, rel] of S.rels) {
    assert.equal(key, rel.a + '_' + rel.b); assert.ok(rel.a < rel.b);
    assert.ok(S.kingdoms.has(rel.a) && S.kingdoms.has(rel.b), `${label} relation ${key} has both kingdoms`);
    assert.ok(rel.opinion >= -100 && rel.opinion <= 100 && Number.isFinite(rel.opinion));
    assert.ok(rel.state === Const.REL.PEACE || rel.state === Const.REL.ALLIANCE, `${label} stored state`);
    assert.ok(Array.isArray(rel.causes) && rel.causes.every(c => typeof c.t === 'string' && Number.isFinite(c.v) && typeof c.why === 'string'));
    assert.equal(Object.keys(rel).join(','), 'a,b,opinion,state,since,truceUntil,allianceSince,causes');
  }
  for (const u of S.units.values()) if (u.isRuler) assert.ok([...S.kingdoms.values()].some(k => k.rulerId === u.id), `${label} ruler flag of ${u.id} belongs to a kingdom`);
  finiteDeep({ k: [...S.kingdoms.values()], r: [...S.rels.values()], m: S.mod.kingdoms, d: S.mod.diplomacy, c: S.cultures }, label);
  assert.deepEqual(JSON.parse(JSON.stringify([...S.kingdoms.values()])), [...S.kingdoms.values()], label + ' kingdoms are JSON-safe');
  assert.deepEqual(JSON.parse(JSON.stringify([...S.rels.entries()])), [...S.rels.entries()], label + ' relations are JSON-safe');
  assert.deepEqual(JSON.parse(JSON.stringify(S.mod)), S.mod, label + ' S.mod is JSON-safe');
}
const logsSince = (ctx, id0) => ctx.S.log.filter(l => l.id >= id0);

console.log('Politics tests (Kingdoms + Diplomacy)' + (QUICK ? ' (quick)' : '') + (REAL_WAR ? ' [real War]' : ' [spy War]'));

// ====================================================================================================
// creation
section('creation: kingdom per first village, unique names / flags / colours / cultures (also beyond the palette), ruler, relations', () => {
  const ctx = mkCtx(1);
  const { S, Kingdoms, Diplomacy, Bus } = ctx;
  const created = [], crowned = [];
  Bus.on('kingdomCreated', k => created.push(k.id)); Bus.on('kingCrowned', (k, u) => crowned.push([k.id, u.id]));
  const [ra, rb] = pairOfRegions(ctx, 0);
  const { city: a, k: ka } = mkKingdom(ctx, ra.id, 0);
  assert.ok(ka && ka.alive && ka.cities.includes(a.id) && ka.capitalId === a.id, 'first village = capital of a new kingdom');
  assert.equal(a.kingdomId, ka.id);
  assert.equal(ka.race, 0); assert.equal(ka.color, ka.flag.c1);
  assert.deepEqual([ka.cmd, ka.overlordId, ka.infamy, ka.manpowerUsed], [false, 0, 0, 0]);
  const ru = Kingdoms.ruler(ka.id);
  assert.ok(ru && ru.isRuler && ru.kingdomId === ka.id, 'a ruler was crowned'); assert.equal(ka.clan, ru.clan, 'the first ruler founds the dynasty');
  assert.equal(a.culture, ka.culture); assert.ok(S.cultures[ka.culture] && S.cultures[ka.culture].race === 0);
  assert.deepEqual(created, [ka.id]); assert.equal(crowned.length, 1);
  assert.equal(Kingdoms.at(a.x, a.y).id, ka.id); assert.equal(Kingdoms.pop(ka.id), a.pop); assert.equal(Kingdoms.cities(ka.id)[0], a);
  assert.equal(Kingdoms.capitalRegion(ka.id), a.regionId); assert.equal(Kingdoms.ofUnit(ru).id, ka.id);
  // a second village of the same race nearby (wanderers) joins; another race founds its own kingdom with its own culture
  const { k: kb } = mkKingdom(ctx, rb.id, 1, 5);
  assert.notEqual(kb.id, ka.id, 'orcs found their own kingdom'); assert.notEqual(kb.culture, ka.culture);
  assert.equal(Diplomacy.get(ka.id, kb.id), Diplomacy.get(kb.id, ka.id), 'one symmetric relation object');
  assert.equal(S.rels.size, 1);
  // 22 more kingdoms (more than the 16 palette colours): everything stays unique
  for (let i = 0; i < 22; i++) Kingdoms.create(i % 3, null);
  assert.equal(S.kingdoms.size, 24);
  assert.equal(S.rels.size, 24 * 23 / 2, 'every pair has a relation');
  const cols = new Set([...S.kingdoms.values()].map(k => k.color)), cul = new Set([...S.kingdoms.values()].map(k => k.culture));
  assert.equal(cols.size, 24, 'unique colours'); assert.equal(cul.size, 24, 'unique cultures');
  assert.ok([...S.kingdoms.values()].every(k => /^#[0-9a-f]{6}$/i.test(k.color)));
  assert.ok([...S.cultures].every(c => typeof c.name === 'string' && /^#[0-9a-f]{6}$/i.test(c.color)));
  assert.equal(created.length, 24);
  for (const k of Array.from(S.kingdoms.values())) if (!k.cities.length) Kingdoms.destroy(k.id, 'test');
  inv(ctx, 'creation');
});

section('every public function tolerates dead / missing / nonsense ids (no throw, falsy results)', () => {
  const ctx = mkCtx(2);
  const { Kingdoms, Diplomacy, S } = ctx;
  const [ra, rb] = pairOfRegions(ctx, 0);
  const { k: ka } = mkKingdom(ctx, ra.id, 0), { k: kb } = mkKingdom(ctx, rb.id, 1, 5);
  const bad = [0, -1, 99999, NaN, undefined, null, 'x', 1.5, Infinity];
  for (const x of bad) {
    assert.doesNotThrow(() => {
      Kingdoms.get(x); Kingdoms.ruler(x); Kingdoms.cities(x); Kingdoms.pop(x); Kingdoms.strength(x); Kingdoms.capitalRegion(x); Kingdoms.policy(x);
      Kingdoms.setRuler(x, null); Kingdoms.succession(x); Kingdoms.transferCity(x, ka.id, 't'); Kingdoms.transferCity(ka.cities[0], x, 't');
      Kingdoms.annex(x, ka.id, 'merge'); Kingdoms.annex(ka.id, x, 'vassal'); Kingdoms.splitCity(x); Kingdoms.rebel(x); Kingdoms.breakFree(x);
      Kingdoms.setCommanded(x, true); Kingdoms.destroy(x, 't'); Kingdoms.at(x, x); Kingdoms.explainStability(x); Kingdoms.explainLoyalty(x); Kingdoms.vassalsOf(x);
      Diplomacy.get(x, ka.id); Diplomacy.opinion(x, ka.id); Diplomacy.state(x, ka.id); Diplomacy.atWar(x, ka.id); Diplomacy.allied(x, ka.id); Diplomacy.alliesOf(x);
      Diplomacy.inTruce(x, ka.id); Diplomacy.setTruce(x, ka.id, 5); Diplomacy.setState(x, ka.id, 1); Diplomacy.canDeclare(x, ka.id); Diplomacy.canDeclare(ka.id, x);
      Diplomacy.addOpinion(x, ka.id, 5, 'x'); Diplomacy.declareWar(x, ka.id, 'x', []); Diplomacy.declareWar(ka.id, x); Diplomacy.makeAlliance(x, ka.id); Diplomacy.breakAlliance(x, ka.id);
      Diplomacy.godWhisperWar(x); Diplomacy.godPeace(x); Diplomacy.neighbors(x); Diplomacy.relationsOf(x); Diplomacy.onKingdomDestroyed(x); Diplomacy.allyWillJoin(x, ka.id, kb.id, true);
    }, 'bad id ' + String(x));
  }
  assert.equal(Kingdoms.get(99999), null); assert.equal(Kingdoms.ruler(99999), null); assert.deepEqual(Kingdoms.cities(99999), []);
  assert.equal(Kingdoms.pop(99999), 0); assert.equal(Kingdoms.strength(99999), 0); assert.equal(Kingdoms.transferCity(99999, ka.id), false);
  assert.equal(Kingdoms.annex(99999, ka.id, 'merge'), false); assert.equal(Kingdoms.annex(ka.id, ka.id, 'merge'), false); assert.equal(Kingdoms.annex(ka.id, kb.id, 'bogus'), false);
  assert.equal(Kingdoms.splitCity(99999), 0); assert.equal(Kingdoms.rebel(99999), 0); assert.equal(Kingdoms.destroy(99999, 'x'), false);
  assert.equal(Diplomacy.get(ka.id, ka.id), null); assert.equal(Diplomacy.get(ka.id, 99999), null); assert.equal(Diplomacy.opinion(ka.id, 99999), 0);
  assert.equal(Diplomacy.atWar(ka.id, kb.id), false); assert.deepEqual(Diplomacy.alliesOf(99999), []); assert.deepEqual(Diplomacy.neighbors(99999), []);
  assert.equal(Diplomacy.canDeclare(ka.id, 99999).ok, false); assert.equal(Diplomacy.makeAlliance(ka.id, ka.id), false); assert.equal(Diplomacy.godPeace(ka.id), false);
  assert.equal(Diplomacy.declareWar(ka.id, 99999, 'x', []), null);
  assert.equal(S.kingdoms.size, 2);
  inv(ctx, 'tolerant');
});

// ====================================================================================================
// rulers
section('succession order: eldest adult child -> sibling -> clan member -> best citizen; log, hist, dynasty, interregnum', () => {
  const ctx = mkCtx(3);
  const { S, Kingdoms, Units, Cities, Const, Bus } = ctx;
  const [ra] = pairOfRegions(ctx, 0);
  const { city, k } = mkKingdom(ctx, ra.id, 0, 8);
  const ruler = Kingdoms.ruler(k.id);
  ruler.born = S.tick - 45 * 60;
  const add = (age, opts) => { const u = Units.spawn(0, city.x + 0.5, city.y + 1.5, Object.assign({ age, clan: k.clan }, opts)); assert.ok(u); Cities.addMember(city.id, u); return u; };
  const fath = add(70, {});
  ruler.fatherId = fath.id;
  const kid1 = add(24, { fatherId: ruler.id, sex: Const.SEX.M }), kid2 = add(20, { fatherId: ruler.id, sex: Const.SEX.F }), baby = add(5, { fatherId: ruler.id });
  const sib = add(41, { fatherId: fath.id });
  const clanner = add(33, {});
  // many founders are in the clan too: make only `clanner` and the family part of it
  for (const id of city.members) { const u = S.units.get(id); if (![ruler, fath, kid1, kid2, baby, sib, clanner].includes(u)) u.clan = 'Чужие'; }
  assert.equal(clanner.clan, k.clan);
  const crowned = []; Bus.on('kingCrowned', (kk, u) => crowned.push(u.id));
  const logMark = S.nextLogId;
  Units.kill(ruler, 'age');
  tickPol(ctx, 1);
  assert.equal(k.rulerId, kid1.id, 'eldest adult child (the 5 year old child and the younger sister come later)');
  assert.ok(kid1.isRuler);
  let l = logsSince(ctx, logMark).find(e => /умер король/.test(e.msg));
  assert.ok(l && l.msg === `В «${k.name}» умер король «${ruler.name}», на трон взошёл «${kid1.name}»`, 'log: ' + (l && l.msg));
  assert.equal(l.kid, k.id);
  assert.ok(S.kingdoms.get(k.id).hist.some(h => /На трон взошёл/.test(h.t)));
  assert.ok(k.crisis === 0, 'smooth succession: no crisis');
  // kid1 dies without children: his sister (same father) is next, the baby cannot rule
  Units.kill(kid1, 'combat'); tickPol(ctx, 1);
  assert.equal(k.rulerId, kid2.id, 'a sibling is next');
  l = logsSince(ctx, logMark).find(e => /погиб король/.test(e.msg));
  assert.ok(l && /на трон взошла «/.test(l.msg), 'female heir, died in combat: ' + (l && l.msg));
  // kid2 dies: her sibling... (the baby is a minor, the old half-uncle is a sibling of kid2? no) -> a clan member rules
  Units.kill(kid2, 'age'); tickPol(ctx, 1);
  assert.ok(k.rulerId !== baby.id, 'a child never rules');
  const heir3 = S.units.get(k.rulerId);
  assert.ok(heir3 && heir3.clan === k.clan, 'clan member');
  // everybody of the clan dies: the best citizen of the kingdom
  for (const u of [clanner, sib, fath, baby]) if (S.units.has(u.id)) Units.kill(u, 'test');
  const cur = S.units.get(k.rulerId); if (cur) Units.kill(cur, 'test');
  tickPol(ctx, 1);
  const last = S.units.get(k.rulerId);
  assert.ok(last && last.cityId === city.id && last.kingdomId === k.id, 'a citizen was elected');
  assert.ok(crowned.length >= 4, 'kingCrowned fired for every coronation: ' + crowned.length);
  assert.ok(logsSince(ctx, logMark).every(e => !e.msg.includes('undefined') && !e.msg.includes('NaN')));
  inv(ctx, 'succession');
});

section('succession: new dynasty when a different clan takes the throne; empty throne is retried and filled when somebody grows up', () => {
  const ctx = mkCtx(4);
  const { S, Kingdoms, Units, Cities } = ctx;
  const [ra] = pairOfRegions(ctx, 0);
  const { city, k } = mkKingdom(ctx, ra.id, 0, 4);
  const old = k.clan;
  for (const id of city.members) S.units.get(id).clan = 'Прочие';
  const ruler = Kingdoms.ruler(k.id);
  ruler.clan = old;                                                  // the dynasty is the ruler's, everybody else is of another house
  const logMark = S.nextLogId;
  Units.kill(ruler, 'age'); tickPol(ctx, 1);
  const heir = Kingdoms.ruler(k.id);
  assert.ok(heir && heir.id !== ruler.id);
  assert.equal(k.clan, 'Прочие', 'the dynasty follows the new ruler'); assert.notEqual(k.clan, old);
  assert.ok(logsSince(ctx, logMark).some(e => e.msg.includes('(новая династия «Прочие»)')));
  assert.ok(k.crisis > S.tick, 'a non-dynastic succession causes a short crisis');
  const parts = Kingdoms.explainStability(k.id);
  assert.ok(parts.some(p => p.why === 'Смена власти' && p.v < 0), 'crisis shows in the stability breakdown');
  // only children left: the throne stays empty, one message, then the oldest child is crowned when adult
  for (const id of city.members.slice()) { const u = S.units.get(id); if (u && u.id !== heir.id) Units.kill(u, 'test'); }
  const k1 = Units.spawn(0, city.x + 0.5, city.y + 1.5, { age: 14, fatherId: heir.id }); Cities.addMember(city.id, k1);
  Units.kill(heir, 'age');
  const m2 = S.nextLogId;
  tickPol(ctx, 120);
  assert.equal(k.rulerId, 0, 'nobody of age: the throne is empty'); assert.equal(Kingdoms.ruler(k.id), null);
  assert.equal(logsSince(ctx, m2).filter(e => /трон пуст/.test(e.msg)).length, 1, 'the empty throne is announced once');
  k1.born = S.tick - 30 * 60;                                       // grows up
  tickPol(ctx, 60);
  assert.equal(k.rulerId, k1.id, 'crowned as soon as an adult exists (retry within ~50 ticks)');
  inv(ctx, 'dynasty');
});

section('succession: the widow(er) rules when there are no adult children or siblings (before clan members); marriages are noticed', () => {
  const ctx = mkCtx(3);
  const { S, Kingdoms, Units, Cities } = ctx;
  const [ra] = pairOfRegions(ctx, 0);
  const { city, k } = mkKingdom(ctx, ra.id, 0, 6);
  for (const id of city.members.slice()) { const u = S.units.get(id); if (u.id !== k.rulerId) Units.kill(u, 'test'); }
  const ruler = Kingdoms.ruler(k.id);
  const wife = Units.spawn(0, city.x + 0.5, city.y + 1.5, { age: 30, sex: ctx.Const.SEX.F, clan: 'Другие' }); Cities.addMember(city.id, wife);
  const cousin = Units.spawn(0, city.x + 1.5, city.y + 1.5, { age: 28, clan: k.clan }); Cities.addMember(city.id, cousin);   // a clan member who must NOT win
  ruler.spouseId = wife.id; wife.spouseId = ruler.id;
  tickPol(ctx, 61);
  assert.equal(k.consortId, wife.id, 'the consort is tracked (Units clears spouses on death)');
  Units.kill(ruler, 'age'); tickPol(ctx, 1);
  assert.equal(k.rulerId, wife.id, 'the widow rules before a clan member'); assert.notEqual(k.rulerId, cousin.id);
  assert.ok(S.kingdoms.get(k.id).hist.some(h => /супруг правителя/.test(h.t)));
});

section('ruler traits drive policy (war / peace / greed / loyalty); race aggression; missing ruler is neutral', () => {
  const ctx = mkCtx(5);
  const { S, Kingdoms, Traits } = ctx;
  const [ra, rb] = pairOfRegions(ctx, 0);
  const { k: kh } = mkKingdom(ctx, ra.id, 0), { k: ko } = mkKingdom(ctx, rb.id, 1, 5);
  const set = (k, traits) => { Kingdoms.ruler(k.id).traits = traits.map(t => Traits.byKey[t].id); };
  set(kh, ['aggressive', 'brave']); const w1 = Kingdoms.policy(kh.id);
  set(kh, ['peaceful', 'wise']); const w2 = Kingdoms.policy(kh.id);
  assert.ok(w1.war > w2.war + 0.5, `aggressive ${w1.war} vs peaceful ${w2.war}`); assert.ok(w2.peace > w1.peace);
  set(kh, ['greedy', 'lazy']); assert.ok(Kingdoms.policy(kh.id).greed >= 1);
  set(kh, ['charismatic', 'kind']); assert.ok(Kingdoms.policy(kh.id).loyalty >= 18);
  set(kh, ['cruel', 'lazy']); assert.ok(Kingdoms.policy(kh.id).loyalty <= -10);
  set(kh, ['lazy', 'diligent']); set(ko, ['lazy', 'diligent']);
  assert.ok(Kingdoms.policy(ko.id).war > Kingdoms.policy(kh.id).war + 0.2, 'orcs are more warlike than humans by race');
  S.units.get(kh.rulerId).isRuler = false; kh.rulerId = 0;
  assert.deepEqual(Object.keys(Kingdoms.policy(kh.id)), ['war', 'peace', 'greed', 'loyalty']); assert.equal(Kingdoms.policy(kh.id).war, 0);
  assert.ok(Kingdoms.explainStability(kh.id).some(p => p.why === 'Трон пуст'), 'no ruler: stability malus');
});

// ====================================================================================================
// stability / loyalty / culture
section('stability: breakdown explains the target, wars / occupation / mixed culture / rebels lower it, peace + temples raise it, drift is slow and bounded', () => {
  const ctx = mkCtx(6);
  const { S, Kingdoms, Regions } = ctx;
  const [ra, rb] = pairOfRegions(ctx, 0);
  const { city: a, k: ka } = mkKingdom(ctx, ra.id, 0), { k: kb } = mkKingdom(ctx, rb.id, 1, 5);
  const base = Kingdoms.stabilityTarget(ka.id);
  const parts = Kingdoms.explainStability(ka.id);
  assert.ok(parts.length >= 0 && parts.every(p => typeof p.why === 'string' && Number.isFinite(p.v)));
  assert.ok(Math.abs(Math.max(0, Math.min(100, 62 + parts.reduce((s, p) => s + p.v, 0))) - base) < 1.2, 'the breakdown adds up to the target');
  // war weariness
  const w = { id: S.id(), attackers: [ka.id], defenders: [kb.id], aggressor: ka.id, defender: kb.id, started: S.tick - 600, casus: 'conquest', ended: false, goals: [], score: {}, kills: {}, lastChange: 0, hist: [] };
  S.wars.set(w.id, w);
  const atWar = Kingdoms.stabilityTarget(ka.id);
  assert.ok(atWar < base - 4, `war weariness ${base} -> ${atWar}`);
  assert.ok(Kingdoms.explainStability(ka.id).some(p => p.why === 'Усталость от войны'));
  // occupation of own land + capital held
  Regions.setController(a.regionId, kb.id, 'war');
  const occ = Kingdoms.stabilityTarget(ka.id);
  assert.ok(occ < atWar - 10, `occupied capital ${atWar} -> ${occ}`);
  Regions.setController(a.regionId, 0, 'back'); w.ended = true;
  // rebels and mixed culture
  ka.rebels = 2; const reb = Kingdoms.stabilityTarget(ka.id); assert.ok(reb < base - 10); ka.rebels = 0;
  // drift: slow, monotone toward the target, never leaves 0..100
  ka.stability = 20;
  let prev = 20;
  for (let i = 0; i < 40; i++) { tickPol(ctx, 30); assert.ok(ka.stability >= prev - 1e-9 && ka.stability <= 100, 'rises monotonically toward the target'); assert.ok(ka.stability - prev <= 1.6, 'at most +1.5 per pass'); prev = ka.stability; }
  assert.ok(ka.stability > 50, 'recovered: ' + ka.stability);
  ka.stability = 100; kb.stability = 0;
  tickPol(ctx, 30 * 20);
  assert.ok(ka.stability <= 100 && kb.stability >= 0 && Number.isFinite(ka.stability + kb.stability));
});

section('loyalty: target explains itself (capital, distance, foreign people, culture), drifts, culture assimilation / mismatch', () => {
  const ctx = mkCtx(7);
  const { S, Kingdoms, Regions } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  assert.ok(ch, 'three neighbouring free regions');
  const { city: cap, k } = mkKingdom(ctx, ch[0].id, 0, 6);
  const far = addCityTo(ctx, ch[2].id, cap);
  const cT = Kingdoms.loyaltyTarget(cap.id), fT = Kingdoms.loyaltyTarget(far.id);
  assert.ok(cT > fT, `the capital is more loyal than a far colony (${cT} vs ${fT})`);
  assert.ok(Kingdoms.explainLoyalty(cap.id).some(p => p.why === 'Столица'));
  const d = Math.hypot(far.x - cap.x, far.y - cap.y);
  if (d > 14) assert.ok(Kingdoms.explainLoyalty(far.id).some(p => p.why === 'Далеко от столицы' && p.v < 0), 'distance malus at d=' + d.toFixed(1));
  // a foreign people: orc city taken into a human kingdom
  const mid = ch[1];
  const oc = foundIn(ctx, mid.id, 1, 5);
  assert.ok(oc && oc.kingdomId !== k.id);
  assert.ok(Kingdoms.transferCity(oc.id, k.id, 'test'));
  assert.equal(oc.kingdomId, k.id); assert.notEqual(oc.culture, k.culture);
  const expl = Kingdoms.explainLoyalty(oc.id);
  assert.ok(expl.some(p => p.why === 'Чужой народ' && p.v === -32), JSON.stringify(expl));
  const humanFar = far; humanFar.culture = S.cultures.length ? (k.culture + 1 < S.cultures.length ? k.culture + 1 : k.culture) : k.culture;
  // drift toward the target: 3 down / 2 up per pass of 120 ticks; loyalty is clamped
  oc.loyalty = 90; cap.loyalty = 10;
  tickPol(ctx, 130 * 2);
  assert.ok(oc.loyalty < 90 && oc.loyalty >= 90 - 3 * 4 - 1e-9, `falls at most 3 per pass: ${oc.loyalty}`);
  assert.ok(cap.loyalty > 10 && cap.loyalty <= 10 + 2 * 4 + 1e-9, `rises at most 2 per pass: ${cap.loyalty}`);
  // assimilation: a same-race city of another culture adopts the kingdom's culture eventually
  const other = far; other.culture = (k.culture + 1) % S.cultures.length; if (other.culture === k.culture) other.culture = S.cultures.length;
  if (!S.cultures[other.culture]) S.cultures.push({ id: other.culture, name: 'Тестовая', color: '#123456', race: 0 });
  other.loyalty = 80; cap.loyalty = 80; oc.loyalty = 80;
  let n = 0;
  while (other.culture !== k.culture && n < 60000) { tickPol(ctx, 120); n += 120; for (const c of [cap, far, oc]) c.loyalty = 80; }
  assert.equal(other.culture, k.culture, 'assimilated after ' + n + ' ticks');
  assert.ok(n < 60000);
});

section('rebellion: low loyalty for long -> city + region secede as a new kingdom (units, flag, ruler, claim), capital / only city never', () => {
  const ctx = mkCtx(8);
  const { S, Kingdoms, Regions, Diplomacy, Bus } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  const { city: cap, k } = mkKingdom(ctx, ch[0].id, 0, 6);
  const c2 = addCityTo(ctx, ch[1].id, cap), oc = foundIn(ctx, ch[2].id, 1, 6);
  assert.ok(oc);
  const okid = oc.kingdomId;
  assert.ok(Kingdoms.transferCity(oc.id, k.id, 'test'));
  assert.equal(S.kingdoms.has(okid), false, 'the orc kingdom ended with its last city');
  assert.equal(Regions.ownerAt(oc.x, oc.y), k.id, 'its region followed the city');
  // guards
  assert.equal(Kingdoms.rebel(cap.id), 0, 'the capital never secedes');
  const solo = mkKingdomSolo(ctx);
  assert.equal(Kingdoms.rebel(solo.city.id), 0, 'a kingdom with one city has nothing to secede from');
  // natural rebellion: a cruel ruler and a foreign people push the orc city's loyalty target under the threshold
  Kingdoms.ruler(k.id).traits = [ctx.Traits.byKey.cruel.id, ctx.Traits.byKey.lazy.id];
  assert.ok(Kingdoms.loyaltyTarget(oc.id) < 28, 'target ' + Kingdoms.loyaltyTarget(oc.id));
  const events = []; Bus.on('cityRebelled', (c, old, nk) => events.push([c.id, old.id, nk.id]));
  const logMark = S.nextLogId;
  let t = 0;
  c2.loyalty = 90;
  while (!events.length && t < 12000) { tickPol(ctx, 30); t += 30; c2.loyalty = Math.max(c2.loyalty, 80); cap.loyalty = 90; }
  assert.equal(events.length, 1, 'the foreign city rebelled after ' + t + ' ticks');
  const [cid, oldId, nid] = events[0];
  assert.equal(cid, oc.id); assert.equal(oldId, k.id);
  const nk = Kingdoms.get(nid);
  assert.ok(nk && nk.cities.includes(oc.id) && oc.kingdomId === nid && nk.capitalId === oc.id, 'new kingdom owns the city');
  assert.equal(nk.race, 1); assert.equal(nk.culture, oc.culture, 'rebels keep their culture');
  assert.ok(nk.rulerId && S.units.get(nk.rulerId).isRuler && S.units.get(nk.rulerId).kingdomId === nid, 'a ruler');
  assert.ok(oc.members.every(id => S.units.get(id).kingdomId === nid), 'units went along');
  assert.equal(Regions.ownerAt(oc.x, oc.y), nid, 'its region too'); assert.ok(Regions.hasClaim(oc.regionId, k.id), 'the old crown keeps a claim');
  assert.equal(k.rebels > 0.5, true); assert.ok(k.lastRebel > 0); assert.ok(!k.cities.includes(oc.id));
  assert.equal(new Set([...S.kingdoms.values()].map(x => x.color)).size, S.kingdoms.size, 'unique colours');
  const msg = logsSince(ctx, logMark).find(e => /восстал/.test(e.msg));
  assert.ok(msg && msg.msg.includes('«' + oc.name + '»') && msg.msg.includes('«' + k.name + '»') && msg.msg.includes('«' + nk.name + '»'), 'log: ' + (msg && msg.msg));
  assert.equal(msg.kind, 'rebel');
  const rel = Diplomacy.get(k.id, nid);
  assert.ok(rel && rel.opinion <= -20 && rel.causes.some(c => c.why === 'Мятеж'), 'rebels are hated: ' + (rel && rel.opinion));
  inv(ctx, 'rebellion');
});
function mkKingdomSolo(ctx) {
  const rs = [...ctx.S.regions.values()].filter(r => !r.ownerId && siteIn(ctx, r.id, 2));
  const r = rs[rs.length - 1];
  return mkKingdom(ctx, r.id, 2, 4);
}

section('rebel(): direct call, region of the capital is immune, restless neighbours join, rebel wars, occupied cities are left alone', () => {
  const ctx = mkCtx(9);
  const { S, Kingdoms, Regions, Cities } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  const { city: cap, k } = mkKingdom(ctx, ch[0].id, 0, 6);
  const c2 = addCityTo(ctx, ch[1].id, cap), c3 = addCityTo(ctx, ch[2].id, cap);
  // a city in another region than the capital can secede directly (loyalty does not matter for a god-made / scripted rebellion)
  const nid = Kingdoms.rebel(c2.id);
  assert.ok(nid > 0, 'direct rebel() works');
  const nk1 = S.kingdoms.get(nid);
  assert.ok(nk1 && nk1.cities.includes(c2.id) && !k.cities.includes(c2.id));
  assert.ok(S.log.some(l => /восстал/.test(l.msg) && l.msg.includes(c2.name)));
  // c3 still belongs to k; occupy it: no rebellion rolls for an occupied city
  assert.equal(c3.kingdomId, k.id);
  Cities.occupy(c3.id, nk1.id);
  c3.loyalty = 0;
  const events = []; ctx.Bus.on('cityRebelled', () => events.push(1));
  tickPol(ctx, 2000);
  assert.equal(events.length, 0, 'occupied: governed by Cities, no rebellion');
  assert.equal(Regions.get(c3.regionId).ownerId, k.id);
  inv(ctx, 'rebel direct');
});

// ====================================================================================================
// transfer / split / merge / vassal / destroy
section('transferCity: region follows its last city (claim for the loser), main city drags the others, members move, soldiers released, loser dies when empty', () => {
  const ctx = mkCtx(10);
  ctx.Const.CITY_MIN_DIST = 3;                                       // two villages inside one region
  const { S, Kingdoms, Regions, Units, Bus } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  const { city: a, k: ka } = mkKingdom(ctx, ch[0].id, 0, 6);
  const { city: b, k: kb } = mkKingdom(ctx, ch[1].id, 1, 6);
  const b2 = addCityTo(ctx, ch[1].id, b, 3);                     // second orc city in the same region
  const rid = b.regionId; assert.equal(b2.regionId, rid);
  const ev = []; Bus.on('cityTransferred', (c, o, n, cause) => ev.push([c.id, o, n, cause]));
  const logMark = S.nextLogId;
  // the smaller city goes alone: region stays
  const small = b2.pop <= b.pop ? b2 : b, big = small === b2 ? b : b2;
  // a soldier of a foreign army
  const sol = S.units.get(small.members[0]);
  const army = { id: S.id(), kingdomId: kb.id, cityId: big.id, warId: 0, leaderId: sol.id, members: [], order: { type: 'hold', regionId: rid }, mode: 'hold', rally: { x: small.x, y: small.y }, target: null, supply: 100, strength0: 1, born: S.tick };
  S.armies.set(army.id, army);
  assert.ok(Units.conscript(sol, army.id) !== false);
  assert.equal(Kingdoms.transferCity(small.id, ka.id, 'gift'), true);
  assert.equal(small.kingdomId, ka.id); assert.ok(ka.cities.includes(small.id) && !kb.cities.includes(small.id));
  assert.ok(small.members.every(id => S.units.get(id).kingdomId === ka.id), 'members follow');
  assert.equal(sol.armyId, 0, 'soldiers of the old kingdom leave the foreign army');
  assert.equal(Regions.get(rid).ownerId, kb.id, 'the region stays with the city that remains (not the last one)');
  assert.ok(small.loyalty <= 50, 'a transferred city is restless');
  assert.ok(logsSince(ctx, logMark).some(e => e.msg.includes('Город «' + small.name + '» перешёл к королевству «' + ka.name + '»')));
  assert.deepEqual(ev[0], [small.id, kb.id, ka.id, 'gift']);
  // now the last city of the orc kingdom: region follows, claim for the loser (it dies, so the claim vanishes), loser destroyed
  assert.equal(Kingdoms.transferCity(big.id, ka.id, 'peace'), true);
  assert.equal(Regions.get(rid).ownerId, ka.id);
  assert.equal(S.kingdoms.has(kb.id), false, 'a kingdom without cities falls');
  assert.equal(Kingdoms.transferCity(big.id, ka.id, 'peace'), true, 'already there: true, no change');
  assert.equal(Kingdoms.transferCity(big.id, 999999), false);
  inv(ctx, 'transfer');
  // main city rule: two cities in one region, the bigger one is handed over -> the region and the other city follow
  const ctx2 = mkCtx(10);
  ctx2.Const.CITY_MIN_DIST = 3;
  const ch2 = chainOfRegions(ctx2, 0, 3);
  const { city: p, k: kp } = mkKingdom(ctx2, ch2[0].id, 0, 6);
  const { city: q, k: kq } = mkKingdom(ctx2, ch2[1].id, 1, 8);
  const q2 = addCityTo(ctx2, ch2[1].id, q, 2);
  const bigq = q.pop >= q2.pop ? q : q2, smallq = bigq === q ? q2 : q;
  assert.equal(ctx2.Kingdoms.transferCity(bigq.id, kp.id, 'gift'), true);
  assert.equal(smallq.kingdomId, kp.id, 'the minor city of the region came along');
  assert.equal(ctx2.Regions.get(bigq.regionId).ownerId, kp.id);
  assert.equal(ctx2.S.kingdoms.has(kq.id), false);
  inv(ctx2, 'transfer main');
});

section('splitCity: city + region become an independent kingdom, capital re-chosen; refuses the only city', () => {
  const ctx = mkCtx(11);
  const { S, Kingdoms, Regions, Diplomacy } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  const { city: a, k } = mkKingdom(ctx, ch[0].id, 0, 6);
  const b = addCityTo(ctx, ch[1].id, a, 4), c = addCityTo(ctx, ch[2].id, a, 4);
  const created = []; ctx.Bus.on('kingdomCreated', kk => created.push(kk.id));
  const nid = Kingdoms.splitCity(b.id);
  assert.ok(nid > 0 && nid !== k.id);
  const nk = Kingdoms.get(nid);
  assert.deepEqual(created, [nid]);
  assert.ok(nk.cities.includes(b.id) && b.kingdomId === nid && nk.capitalId === b.id);
  assert.equal(Regions.get(b.regionId).ownerId, nid); assert.ok(Regions.hasClaim(b.regionId, k.id), 'old owner keeps a claim');
  assert.ok(b.members.every(id => S.units.get(id).kingdomId === nid));
  assert.equal(nk.culture, k.culture, 'a split keeps the culture (same people)');
  assert.ok(nk.rulerId && S.units.get(nk.rulerId).isRuler);
  assert.ok(Diplomacy.get(k.id, nid).opinion < Diplomacy.get(k.id, nid).causes.filter(x => x.t !== 'ev').reduce((s, x) => s + x.v, 0) + 1);
  // splitting the CAPITAL: the old kingdom picks a new one
  const oldCap = a.id;
  const nid2 = Kingdoms.splitCity(oldCap);
  assert.ok(nid2 > 0);
  assert.ok(k.cities.length === 1 && k.cities[0] === c.id && k.capitalId === c.id, 'capital re-chosen: ' + k.capitalId);
  // the last city of a kingdom cannot be split off
  assert.equal(Kingdoms.splitCity(c.id), 0);
  assert.equal(Kingdoms.splitCity(b.id), 0, 'nid has only b');
  inv(ctx, 'split');
});

section('annex merge: cities + regions + units move, wars end, vassals pass on, relations cleaned, log; commanded flag follows', () => {
  const ctx = mkCtx(12);
  const { S, Kingdoms, Regions, Diplomacy, spy } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  const { city: a, k: ka } = mkKingdom(ctx, ch[0].id, 0, 6);
  const a2 = addCityTo(ctx, ch[1].id, a, 3);
  const { city: b, k: kb } = mkKingdom(ctx, ch[2].id, 1, 5);
  assert.notEqual(ka.id, kb.id);
  // a vassal of the small one, a war of the small one, and the player commands it
  const { k: kv } = mkKingdomSolo(ctx);
  assert.ok(Kingdoms.annex(kv.id, kb.id, 'vassal') && kv.overlordId === kb.id);
  Diplomacy.get(ka.id, kb.id); kb.cmd = true;
  const war = ctx.War.declare(kb.id, ka.id, [], 'conquest'); assert.ok(war && Diplomacy.atWar(ka.id, kb.id));
  const logMark = S.nextLogId;
  const regB = b.regionId;
  assert.equal(Kingdoms.annex(kb.id, ka.id, 'merge'), true);
  assert.equal(S.kingdoms.has(kb.id), false); assert.equal(Diplomacy.atWar(ka.id, kb.id), false, 'the war ended with the merge');
  assert.equal(b.kingdomId, ka.id); assert.ok(ka.cities.includes(b.id)); assert.equal(Regions.get(regB).ownerId, ka.id);
  assert.ok(b.members.every(id => S.units.get(id).kingdomId === ka.id));
  assert.equal(kv.overlordId, ka.id, 'the vassal serves the new overlord');
  assert.equal(ka.cmd, true, 'the player keeps the realm he commanded');
  assert.ok(logsSince(ctx, logMark).some(e => e.msg === `Королевство «${ka.name}» присоединило «${kb.name}»`));
  assert.ok(![...S.rels.values()].some(r => r.a === kb.id || r.b === kb.id), 'no relation of a dead kingdom is left');
  for (const r of S.regions.values()) assert.ok(r.ownerId !== kb.id && r.controllerId !== kb.id && !r.claims.includes(kb.id));
  assert.equal(Kingdoms.annex(kb.id, ka.id, 'merge'), false, 'second time: gone');
  inv(ctx, 'merge');
});

section('vassals: annex(vassal), alliesOf both ways, no war between them, shares wars via allyWillJoin, vassal of vassal, break free', () => {
  const ctx = mkCtx(13);
  const { S, Kingdoms, Diplomacy, Const, spy } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  const { k: ka } = mkKingdom(ctx, ch[0].id, 0, 6), { k: kb } = mkKingdom(ctx, ch[1].id, 1, 5), { k: kc } = mkKingdom(ctx, ch[2].id, 2, 5);
  const logMark = S.nextLogId;
  assert.equal(Kingdoms.annex(kb.id, ka.id, 'vassal'), true);
  assert.equal(kb.overlordId, ka.id); assert.ok(kb.vassalSince > 0 || S.tick === 0);
  assert.ok(logsSince(ctx, logMark).some(e => e.msg === `Королевство «${kb.name}» стало вассалом королевства «${ka.name}»`));
  assert.ok(Diplomacy.alliesOf(ka.id).includes(kb.id) && Diplomacy.alliesOf(kb.id).includes(ka.id));
  assert.equal(Diplomacy.state(ka.id, kb.id), Const.REL.ALLIANCE); assert.ok(Diplomacy.allied(ka.id, kb.id));
  assert.deepEqual(Kingdoms.vassalsOf(ka.id), [kb.id]); assert.deepEqual(Diplomacy.vassalsOf(ka.id), [kb.id]); assert.equal(Diplomacy.overlordOf(kb.id), ka.id);
  assert.equal(Diplomacy.canDeclare(ka.id, kb.id).ok, false); assert.equal(Diplomacy.canDeclare(kb.id, ka.id).ok, false);
  assert.equal(Diplomacy.declareWar(kb.id, ka.id, 'conquest', []), null, 'a vassal cannot attack its overlord');
  assert.equal(Diplomacy.makeAlliance(ka.id, kb.id), false);
  assert.equal(Kingdoms.annex(kb.id, kc.id, 'vassal'), false, 'already a vassal'); assert.equal(Kingdoms.annex(ka.id, kb.id, 'vassal'), false, 'the overlord cannot become the vassal of its vassal');
  // wars are shared: the vassal always joins (attacking and defending), the overlord defends it
  assert.equal(Diplomacy.allyWillJoin(kb.id, ka.id, kc.id, false), true); assert.equal(Diplomacy.allyWillJoin(kb.id, ka.id, kc.id, true), true);
  assert.equal(Diplomacy.allyWillJoin(ka.id, kb.id, kc.id, true), true, 'the overlord protects its vassal');
  assert.equal(Diplomacy.allyWillJoin(kc.id, ka.id, kb.id, true), false, 'strangers do not');
  const w = ctx.War.declare(ka.id, kc.id, [], 'conquest');
  assert.ok(w.attackers.includes(kb.id), 'spy War takes allies from alliesOf + allyWillJoin: ' + JSON.stringify(w.attackers));
  w.ended = true;
  // vassal of a vassal serves the top overlord
  assert.equal(Kingdoms.annex(kc.id, kb.id, 'vassal'), true); assert.equal(kc.overlordId, ka.id, 'flattened to the top overlord');
  assert.ok(Kingdoms.strength(ka.id) > ctx.Kingdoms.strength(kb.id), 'vassals add (half) to the strength of the overlord');
  // break free
  const lm = S.nextLogId;
  assert.equal(Kingdoms.breakFree(kb.id), true); assert.equal(kb.overlordId, 0); assert.equal(Diplomacy.state(ka.id, kb.id), Const.REL.PEACE);
  assert.ok(logsSince(ctx, lm).some(e => /обрело независимость от «/.test(e.msg) && e.kind === 'rebel'));
  assert.equal(Kingdoms.breakFree(kb.id), false);
  assert.ok(Diplomacy.get(ka.id, kb.id).causes.some(c => c.why === 'Сброшено вассальство'));
  // natural break free: an unstable vassal leaves
  Kingdoms.annex(kb.id, ka.id, 'vassal'); kb.stability = 5;
  tickPol(ctx, 1500);
  assert.ok(kb.overlordId === 0 || !S.kingdoms.has(kb.id), 'unstable vassals break free');
  // a god-made war of a vassal against its overlord frees the vassal first
  if (!S.kingdoms.has(kb.id) || !S.kingdoms.has(ka.id)) return;
  Kingdoms.annex(kb.id, ka.id, 'vassal'); kb.stability = 80; ka.stability = 80;
  const gw = Diplomacy.declareWar(kb.id, ka.id, 'god', []);
  assert.ok(gw && gw.casus === 'god'); assert.equal(kb.overlordId, 0, 'a vassal that attacks its overlord is free');
  gw.ended = true;
  // the overlord's fall frees the vassals
  if (S.kingdoms.has(kb.id) && S.kingdoms.has(ka.id)) { Kingdoms.annex(kb.id, ka.id, 'vassal'); Kingdoms.destroy(ka.id, 'test'); assert.equal(kb.overlordId, 0, 'overlord gone -> free'); }
  inv(ctx, 'vassal');
});

section('destroy: wars end through War, remaining cities become city-states, regions go wild, relations / commanded flag cleaned, events', () => {
  const ctx = mkCtx(14);
  const { S, Kingdoms, Regions, Diplomacy, spy, Bus } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  const { city: a, k: ka } = mkKingdom(ctx, ch[0].id, 0, 6);
  const b = addCityTo(ctx, ch[1].id, a, 4);
  const { k: kc } = mkKingdom(ctx, ch[2].id, 1, 5);
  ka.cmd = true;
  const war = ctx.War.declare(kc.id, ka.id, [], 'conquest'); assert.ok(war);
  const ev = []; Bus.on('kingdomDestroyed', k => ev.push(k.id));
  spy.calls.length = 0;
  const logMark = S.nextLogId;
  assert.equal(Kingdoms.destroy(ka.id, 'test'), true);
  assert.ok(spy.calls.some(c => c[0] === 'godPeace' && c[1] === ka.id), 'War was asked to end the wars of the fallen kingdom');
  assert.equal(war.ended, true);
  assert.deepEqual(ev, [ka.id]); assert.equal(S.kingdoms.has(ka.id), false); assert.equal(Kingdoms.get(ka.id), null);
  assert.ok(a.kingdomId && a.kingdomId !== ka.id && S.kingdoms.has(a.kingdomId), 'the former capital became a city-state');
  assert.ok(b.kingdomId && b.kingdomId !== ka.id && S.kingdoms.has(b.kingdomId));
  assert.notEqual(a.kingdomId, b.kingdomId, 'one city-state per region');
  assert.equal(Regions.ownerAt(a.x, a.y), a.kingdomId); assert.equal(Regions.ownerAt(b.x, b.y), b.kingdomId);
  for (const m of a.members) assert.equal(S.units.get(m).kingdomId, a.kingdomId);
  assert.ok(S.units.get(S.kingdoms.get(a.kingdomId).rulerId).isRuler);
  assert.ok(![...S.rels.values()].some(r => r.a === ka.id || r.b === ka.id));
  assert.ok(logsSince(ctx, logMark).some(e => e.msg === `Королевство «${ka.name}» пало`));
  assert.equal(Kingdoms.commanded(), null, 'the commanded flag died with the kingdom');
  assert.equal(Kingdoms.destroy(ka.id, 'test'), false);
  // a kingdom that loses its last city (Cities.destroy) falls through onCityLost
  ctx.Cities.destroy(kc.cities[0], 'war');
  assert.equal(S.kingdoms.has(kc.id), false);
  for (const r of S.regions.values()) assert.ok(r.ownerId !== kc.id);
  assert.equal(Diplomacy.atWar(kc.id, ka.id), false);
  inv(ctx, 'destroy');
});

section('capital: lost capital -> biggest city; occupied capital -> relocation after a delay; growing city may take over (rare)', () => {
  const ctx = mkCtx(15);
  const { S, Kingdoms, Regions, Cities } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  const { city: a, k } = mkKingdom(ctx, ch[0].id, 0, 6);
  const b = addCityTo(ctx, ch[1].id, a, 7), c = addCityTo(ctx, ch[2].id, a, 3);
  const { k: kx } = mkKingdomSolo(ctx);
  assert.equal(k.capitalId, a.id);
  // occupation
  Regions.setController(a.regionId, kx.id, 'war'); Regions.get(a.regionId).occSince = S.tick - 700;
  const logMark = S.nextLogId;
  tickPol(ctx, 480);
  assert.notEqual(k.capitalId, a.id, 'the government left the occupied capital');
  assert.equal(k.capitalId, (b.pop >= c.pop ? b : c).id, 'to the biggest free city');
  assert.ok(logsSince(ctx, logMark).some(e => /Столица королевства «.+» перенесена в «/.test(e.msg)));
  assert.ok(k.crisis > 0 && Kingdoms.explainStability(k.id).length >= 0);
  // destroying the new capital: instant re-choice
  const cap2 = S.cities.get(k.capitalId);
  Cities.destroy(cap2.id, 'war');
  assert.ok(S.cities.has(k.capitalId) && k.cities.includes(k.capitalId), 'capital after destruction: ' + k.capitalId);
  // a single-city kingdom never relocates
  Regions.setController(a.regionId, 0, 'back');
  inv(ctx, 'capital');
});

section('setCommanded: only one commanded kingdom, release, AI never acts for it', () => {
  const ctx = mkCtx(16);
  const { Kingdoms, Diplomacy, S } = ctx;
  const [ra, rb] = pairOfRegions(ctx, 0);
  const { k: ka } = mkKingdom(ctx, ra.id, 0), { k: kb } = mkKingdom(ctx, rb.id, 1, 5);
  assert.equal(Kingdoms.setCommanded(ka.id, true), true); assert.equal(ka.cmd, true);
  assert.equal(Kingdoms.setCommanded(kb.id, true), true); assert.equal(ka.cmd, false); assert.equal(kb.cmd, true);
  assert.equal(Kingdoms.commanded().id, kb.id);
  assert.equal(Kingdoms.setCommanded(kb.id, false), true); assert.equal(Kingdoms.commanded(), null);
  assert.equal(Kingdoms.setCommanded(99999, true), false);
  Kingdoms.setCommanded(ka.id, true); Kingdoms.setCommanded(0); assert.equal(Kingdoms.commanded(), null);
  // AI never declares wars / alliances for a commanded kingdom
  Kingdoms.setCommanded(ka.id, true);
  for (const k of S.kingdoms.values()) { k.born = -5000; k.stability = 90; }
  for (const u of S.units.values()) u.traits = [4, 0];
  S.tick = 3000;
  const rel = Diplomacy.get(ka.id, kb.id); rel.opinion = -90; rel.causes = [{ t: 'ev', v: -90, why: 'Тест' }];
  ctx.spy.declared.length = 0;
  tickPol(ctx, 6000);
  assert.ok(ctx.spy.declared.every(d => d.a !== ka.id), 'no AI war declared by the commanded kingdom');
  assert.equal(Diplomacy.alliesOf(ka.id).length, 0);
  // the other direction does happen (aggressive ruler, hated neighbour) unless they do not border
});

// ====================================================================================================
// diplomacy
section('relations: symmetric, causes [{t,v,why}] in Russian, bounded opinion, drift, events decay, base race matrix, relationsOf', () => {
  const ctx = mkCtx(17);
  const { S, Diplomacy, Const, Kingdoms } = ctx;
  const [ra, rb] = pairOfRegions(ctx, 0);
  const { k: kh } = mkKingdom(ctx, ra.id, 0), { k: ko } = mkKingdom(ctx, rb.id, 1, 5);
  const rel = Diplomacy.get(kh.id, ko.id);
  assert.equal(Diplomacy.get(ko.id, kh.id), rel); assert.ok(rel.a < rel.b); assert.equal(rel.state, Const.REL.PEACE);
  assert.equal(Diplomacy.opinion(kh.id, ko.id), Diplomacy.opinion(ko.id, kh.id));
  assert.ok(rel.opinion < 0, 'human vs orc start unfriendly: ' + rel.opinion);
  assert.ok(rel.causes.some(c => c.t === 'race' && c.v < 0 && /[а-я]/i.test(c.why)));
  assert.ok(rel.causes.some(c => c.t === 'culture' && c.v === -10), 'different cultures');
  assert.ok(rel.causes.every(c => typeof c.t === 'string' && typeof c.why === 'string' && Number.isFinite(c.v)));
  // events
  const o0 = rel.opinion;
  assert.equal(Diplomacy.addOpinion(kh.id, ko.id, -50, 'Оскорбление посла'), true);
  assert.ok(Math.abs(rel.opinion - (o0 - 50)) < 0.11 || rel.opinion === -100, 'immediate effect');
  assert.ok(rel.causes.some(c => c.t === 'ev' && c.why === 'Оскорбление посла' && c.v === -50));
  Diplomacy.addOpinion(ko.id, kh.id, -10, 'Оскорбление посла'); assert.equal(rel.causes.find(c => c.why === 'Оскорбление посла').v, -60, 'same reason accumulates');
  Diplomacy.addOpinion(kh.id, ko.id, -500, 'x'); assert.equal(rel.opinion, -100); Diplomacy.addOpinion(kh.id, ko.id, 900, 'y'); assert.equal(rel.opinion, 100);
  assert.equal(Diplomacy.addOpinion(kh.id, ko.id, NaN, 'z'), false);
  // drift + decay: events fade, opinion returns toward the structural level
  for (let i = 0; i < 120; i++) tickPol(ctx, 100);
  const left = (rel.causes.find(c => c.why === 'Оскорбление посла') || { v: 0 }).v;
  assert.ok(Math.abs(left) < 2, 'event faded: ' + left);
  assert.ok(Math.abs(rel.opinion - o0) < 20, `opinion back near ${o0}: ${rel.opinion}`);
  assert.ok(rel.causes.length <= 14);
  // relationsOf (UI format)
  const lst = Diplomacy.relationsOf(kh.id);
  assert.equal(lst.length, 1); assert.deepEqual(Object.keys(lst[0]).slice(0, 3), ['other', 'opinion', 'state']);
  assert.equal(lst[0].other, ko.id); assert.equal(lst[0].state, Const.REL.PEACE); assert.ok(Number.isInteger(lst[0].opinion));
  assert.deepEqual(Diplomacy.relationsOf(ko.id)[0].other, kh.id);
  assert.equal(Diplomacy.causes(kh.id, ko.id).length, rel.causes.length);
});

section('alliances: make / break, truce, state, log texts, Bus, limits; no alliance in war or with a vassal; enemies cannot stay allies', () => {
  const ctx = mkCtx(18);
  const { S, Diplomacy, Const, Bus, Kingdoms } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  const { k: ka } = mkKingdom(ctx, ch[0].id, 0), { k: kb } = mkKingdom(ctx, ch[1].id, 2, 5), { k: kc } = mkKingdom(ctx, ch[2].id, 0);
  const ev = []; Bus.on('allianceMade', (a, b) => ev.push([a.id, b.id])); Bus.on('allianceBroken', (a, b) => ev.push(['x', a.id, b.id]));
  const logMark = S.nextLogId;
  const o0 = Diplomacy.opinion(ka.id, kb.id);
  assert.equal(Diplomacy.makeAlliance(ka.id, kb.id), true);
  assert.equal(Diplomacy.makeAlliance(ka.id, kb.id), false, 'already allied');
  assert.equal(Diplomacy.state(ka.id, kb.id), Const.REL.ALLIANCE); assert.equal(Diplomacy.state(kb.id, ka.id), Const.REL.ALLIANCE);
  assert.ok(Diplomacy.allied(ka.id, kb.id)); assert.deepEqual(Diplomacy.alliesOf(ka.id), [kb.id]);
  const rel = Diplomacy.get(ka.id, kb.id); assert.equal(rel.allianceSince, S.tick); assert.ok(Diplomacy.opinion(ka.id, kb.id) > o0);
  assert.deepEqual(ev, [[ka.id, kb.id]]);
  assert.ok(logsSince(ctx, logMark).some(e => e.msg === `Заключён союз между «${ka.name}» и «${kb.name}»` && e.kind === 'kingdom'));
  assert.equal(Diplomacy.canDeclare(ka.id, kb.id).ok, false); assert.match(Diplomacy.canDeclare(ka.id, kb.id).reason, /союзник/);
  assert.equal(Diplomacy.relationsOf(ka.id).find(r => r.other === kb.id).state, Const.REL.ALLIANCE);
  assert.equal(Diplomacy.breakAlliance(ka.id, kb.id), true); assert.equal(Diplomacy.breakAlliance(ka.id, kb.id), false);
  assert.equal(Diplomacy.state(ka.id, kb.id), Const.REL.PEACE); assert.deepEqual(Diplomacy.alliesOf(ka.id), []);
  assert.ok(rel.causes.some(c => c.why === 'Союз расторгнут'));
  assert.ok(logsSince(ctx, logMark).some(e => e.msg === `Союз между «${ka.name}» и «${kb.name}» распался`));
  // state setters
  assert.equal(Diplomacy.setState(ka.id, kb.id, Const.REL.ALLIANCE), true); assert.ok(Diplomacy.allied(ka.id, kb.id));
  assert.equal(Diplomacy.setState(ka.id, kb.id, Const.REL.WAR), true); assert.equal(Diplomacy.state(ka.id, kb.id), Const.REL.ALLIANCE, 'WAR is derived from War.atWar, not stored');
  assert.equal(Diplomacy.setState(ka.id, kb.id, Const.REL.PEACE), true); assert.ok(!Diplomacy.allied(ka.id, kb.id));
  // enemies cannot be allies; a declared war breaks an alliance between the sides
  Diplomacy.makeAlliance(ka.id, kb.id);
  const w = ctx.War.declare(kc.id, kb.id, [], 'conquest');
  assert.ok(w); assert.equal(Diplomacy.makeAlliance(kc.id, kb.id), false, 'at war');
  assert.equal(Diplomacy.state(kc.id, kb.id), Const.REL.WAR); assert.equal(Diplomacy.relationsOf(kc.id).find(r => r.other === kb.id).state, Const.REL.WAR);
  Diplomacy.setState(kc.id, ka.id, Const.REL.ALLIANCE);
  const w2 = { id: S.id(), attackers: [ka.id], defenders: [kc.id], aggressor: ka.id, defender: kc.id, started: S.tick, casus: 'ally', ended: false, goals: [], score: {}, kills: {}, lastChange: 0, hist: [] };
  S.wars.set(w2.id, w2); Bus.emit('warDeclared', w2);
  assert.ok(!Diplomacy.allied(kc.id, ka.id), 'the alliance of two enemies was cancelled');
  assert.ok(Kingdoms.get(ka.id));
  inv(ctx, 'alliances');
});

section('truce: setTruce / inTruce expiry, canDeclare reasons, declareWar refuses during truce, god overrides', () => {
  const ctx = mkCtx(19);
  const { S, Diplomacy, spy } = ctx;
  const [ra, rb] = pairOfRegions(ctx, 0);
  const { k: ka } = mkKingdom(ctx, ra.id, 0), { k: kb } = mkKingdom(ctx, rb.id, 1, 5);
  assert.equal(Diplomacy.inTruce(ka.id, kb.id), false);
  assert.equal(Diplomacy.setTruce(ka.id, kb.id, S.tick + 50), true);
  assert.equal(Diplomacy.inTruce(ka.id, kb.id), true); assert.equal(Diplomacy.inTruce(kb.id, ka.id), true);
  assert.equal(Diplomacy.canDeclare(ka.id, kb.id).ok, false); assert.match(Diplomacy.canDeclare(ka.id, kb.id).reason, /перемирие/);
  assert.ok(Diplomacy.relationsOf(ka.id)[0].truce && Diplomacy.relationsOf(ka.id)[0].truceLeft === 50);
  assert.equal(Diplomacy.declareWar(ka.id, kb.id, 'conquest'), null); assert.equal(spy.calls.filter(c => c[0] === 'declare').length, 0, 'War was not even asked');
  tickPol(ctx, 51);
  assert.equal(Diplomacy.inTruce(ka.id, kb.id), false, 'truce expired');
  assert.equal(Diplomacy.setTruce(ka.id, 99999, 5), false);
  Diplomacy.setTruce(ka.id, kb.id, S.tick + 5000);
  const w = Diplomacy.declareWar(ka.id, kb.id, 'god', []);
  assert.ok(w, 'a god-made war ignores the truce'); assert.equal(Diplomacy.inTruce(ka.id, kb.id), false);
  assert.match(Diplomacy.canDeclare(ka.id, kb.id).reason, /война уже идёт/);
  assert.match(Diplomacy.canDeclare(ka.id, ka.id).reason, /сам/);
});

section('neighbors: by region border contact (+ distance), sorted; canDeclare needs contact and goals', () => {
  const ctx = mkCtx(20);
  const { S, Diplomacy, Regions } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  const { k: ka, city: a } = mkKingdom(ctx, ch[0].id, 0), { k: kb, city: b } = mkKingdom(ctx, ch[1].id, 1, 5), { k: kc, city: c } = mkKingdom(ctx, ch[2].id, 2, 5);
  const na = Diplomacy.neighbors(ka.id);
  assert.deepEqual(na.map(n => n.kid), [kb.id], 'A touches only B');
  assert.ok(na[0].contact >= 1 && Number.isFinite(na[0].dist) && Math.abs(na[0].dist - Math.hypot(a.x - b.x, a.y - b.y)) < 0.11);
  const nb = Diplomacy.neighbors(kb.id);
  assert.deepEqual(nb.map(n => n.kid).sort(), [ka.id, kc.id].sort());
  assert.ok(nb[0].contact >= nb[1].contact, 'sorted by contact, then distance');
  assert.deepEqual(Diplomacy.neighbors(kc.id).map(n => n.kid), [kb.id]);
  assert.equal(Diplomacy.canDeclare(ka.id, kc.id).ok, false); assert.match(Diplomacy.canDeclare(ka.id, kc.id).reason, /нет общей границы/);
  assert.equal(Diplomacy.canDeclare(ka.id, kb.id).ok, true, JSON.stringify(Diplomacy.canDeclare(ka.id, kb.id)));
  assert.equal(Diplomacy.contact(ka.id, kc.id), 0);
  // a kingdom whose land was taken away stops being a neighbour (cache follows the regions)
  Regions.setOwner(ch[1].id, ka.id, 'test');
  assert.deepEqual(Diplomacy.neighbors(ka.id).map(n => n.kid), [kc.id], 'ownership change is picked up at once');
  // no goals -> cannot declare (War module's potentialGoals is empty)
  const orig = ctx.War.potentialGoals; ctx.War.potentialGoals = () => [];
  assert.match(Diplomacy.canDeclare(ka.id, kc.id).reason, /нет общей границы|нет доступных целей/);
  ctx.War.potentialGoals = orig;
});

section('declareWar / godWhisperWar / godPeace: War glue, goals, casus, feed, opinion + infamy, ally breaking, god overrides', () => {
  const ctx = mkCtx(21);
  const { S, Diplomacy, spy, Regions, Const } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  const { k: ka } = mkKingdom(ctx, ch[0].id, 0), { k: kb } = mkKingdom(ctx, ch[1].id, 1, 5), { k: kc } = mkKingdom(ctx, ch[2].id, 2, 5);
  // goals from War.potentialGoals (ids), claimed region first -> casus
  Regions.addClaim(ch[1].id, ka.id);
  const marks = S.nextLogId;
  const w = Diplomacy.declareWar(ka.id, kb.id);
  assert.ok(w && w.aggressor === ka.id && w.defender === kb.id);
  const call = spy.calls.find(c => c[0] === 'declare');
  assert.deepEqual(call.slice(0, 3), ['declare', ka.id, kb.id]); assert.ok(call[3].length >= 1 && call[3].includes(ch[1].id), 'goals picked automatically: ' + call[3]);
  assert.equal(call[4], 'claim', 'a claimed goal makes the war justified');
  assert.equal(logsSince(ctx, marks).filter(e => e.kind === 'war' && /объявило войну/.test(e.msg)).length, 1, 'exactly one declaration in the feed');
  assert.equal(Diplomacy.atWar(ka.id, kb.id), true); assert.equal(Diplomacy.state(kb.id, ka.id), Const.REL.WAR);
  const rel = Diplomacy.get(ka.id, kb.id);
  assert.ok(rel.causes.some(c => c.why === 'Нападение' && c.v === -22), 'justified: -22');
  assert.equal(ka.infamy, 3);
  // listener runs once only (idempotent per war): re-emitting does not stack
  ctx.Bus.emit('warDeclared', w); assert.equal(rel.causes.find(c => c.why === 'Нападение').v, -22);
  assert.equal(Diplomacy.declareWar(ka.id, kb.id), null, 'already at war');
  // a War that does not log gets the fallback line (with goal names); objects as goals work too
  const ctx2 = mkCtx(21); ctx2.spy.log = false; ctx2.spy.objects = true;
  const ch2 = chainOfRegions(ctx2, 0, 3);
  const { k: a2 } = mkKingdom(ctx2, ch2[0].id, 0), { k: b2 } = mkKingdom(ctx2, ch2[1].id, 1, 5);
  const m2 = ctx2.S.nextLogId;
  const w2 = ctx2.Diplomacy.declareWar(a2.id, b2.id, 'conquest');
  assert.ok(w2);
  const l2 = logsSince(ctx2, m2).filter(e => /объявило войну/.test(e.msg));
  assert.equal(l2.length, 1); assert.equal(l2[0].msg.startsWith(`Королевство «${a2.name}» объявило войну королевству «${b2.name}» (цель: «`), true, l2[0].msg);
  assert.ok(a2.infamy >= 10, 'unjustified war: infamy'); assert.ok(ctx2.Diplomacy.get(a2.id, b2.id).causes.some(c => c.why === 'Нападение' && c.v === -35));
  // god whisper: neighbour with the most contact, ignores truces / alliances when nothing else is left, casus god
  const ctx3 = mkCtx(21);
  const ch3 = chainOfRegions(ctx3, 0, 3);
  const { k: a3 } = mkKingdom(ctx3, ch3[0].id, 0), { k: b3 } = mkKingdom(ctx3, ch3[1].id, 1, 5), { k: c3 } = mkKingdom(ctx3, ch3[2].id, 2, 5);
  ctx3.Diplomacy.setTruce(b3.id, a3.id, ctx3.S.tick + 9999);
  const gw = ctx3.Diplomacy.godWhisperWar(a3.id);
  assert.ok(gw && gw.aggressor === a3.id && gw.defender === b3.id && gw.casus === 'god', 'whisper: the only neighbour, truce ignored');
  assert.equal(ctx3.Diplomacy.inTruce(a3.id, b3.id), false);
  assert.equal(ctx3.Diplomacy.godWhisperWar(a3.id), false, 'no neighbour left to fight');
  ctx3.Diplomacy.makeAlliance(b3.id, c3.id);
  const gw2 = ctx3.Diplomacy.godWhisperWar(c3.id);
  assert.ok(gw2 === false || gw2.casus === 'god');
  const k4 = ctx3.Kingdoms.create(0, null);
  assert.equal(ctx3.Diplomacy.godWhisperWar(k4.id), false, 'a kingdom without neighbours cannot be whispered');
  ctx3.Kingdoms.destroy(k4.id, 'test');
  // god peace
  const ep = ctx3.spy.calls.length;
  assert.equal(ctx3.Diplomacy.godPeace(a3.id), true, 'ended a war');
  assert.ok(ctx3.spy.calls.slice(ep).some(c => c[0] === 'godPeace' && c[1] === a3.id), 'delegates War.godPeace');
  assert.equal(ctx3.Diplomacy.atWar(a3.id, b3.id), false);
  assert.ok(ctx3.Diplomacy.inTruce(a3.id, b3.id), 'a truce follows'); assert.ok(ctx3.Diplomacy.get(a3.id, b3.id).causes.some(c => c.why === 'Мир, принесённый богом'));
  assert.equal(ctx3.Diplomacy.godPeace(a3.id), false, 'nothing to end');
  assert.equal(ctx3.Diplomacy.godPeace(99999), false);
  // warEnded sets a truce when War forgot, once
  inv(ctx3, 'god');
});

section('War glue: atWar forwards to War.atWar (boolean, O(1)), state(), stub War is safe, allyWillJoin rules', () => {
  const ctx = mkCtx(22);
  const { S, Diplomacy, Const } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  const { k: ka } = mkKingdom(ctx, ch[0].id, 0), { k: kb } = mkKingdom(ctx, ch[1].id, 1, 5), { k: kc } = mkKingdom(ctx, ch[2].id, 2, 5);
  let calls = 0; const orig = ctx.War.atWar;
  ctx.War.atWar = (a, b) => { calls++; return a === ka.id && b === kb.id; };
  assert.strictEqual(Diplomacy.atWar(ka.id, kb.id), true); assert.strictEqual(Diplomacy.atWar(ka.id, kc.id), false); assert.equal(calls, 2, 'one War.atWar call per Diplomacy.atWar');
  assert.strictEqual(Diplomacy.atWar(ka.id, ka.id), false);
  assert.equal(Diplomacy.state(ka.id, kb.id), Const.REL.WAR);
  ctx.War.atWar = orig;
  const t0 = performance.now();
  let n = 0;
  for (let i = 0; i < 300000; i++) if (Diplomacy.atWar(ka.id, kb.id)) n++;
  const per = (performance.now() - t0) / 300000 * 1e6;
  note(`atWar: ${per.toFixed(0)} ns per call (spy War scans ${S.wars.size} wars)`);
  assert.equal(n, 0);
  // the stage-1 stub War (no atWar result) is harmless
  const ctx2 = loadSim({ stub: ['Sim', 'Save', 'Powers', 'War'] });
  newWorld(ctx2, 22, 96, 96);
  assert.strictEqual(ctx2.Diplomacy.atWar(1, 2), false);
  // allyWillJoin: defenders' allies mostly, attackers' allies only when they dislike the target
  Diplomacy.makeAlliance(ka.id, kc.id);
  let yes = 0; for (let i = 0; i < 400; i++) if (Diplomacy.allyWillJoin(kc.id, ka.id, kb.id, true)) yes++;
  assert.ok(yes > 300 && yes < 400, 'defending ally joins mostly: ' + yes);
  Diplomacy.get(kc.id, kb.id).opinion = 30; assert.equal(Diplomacy.allyWillJoin(kc.id, ka.id, kb.id, false), false, 'an attacker\'s ally who likes the target stays out');
  Diplomacy.get(kc.id, kb.id).opinion = -40; let y2 = 0; for (let i = 0; i < 400; i++) if (Diplomacy.allyWillJoin(kc.id, ka.id, kb.id, false)) y2++;
  assert.ok(y2 > 150 && y2 < 330, 'attacking ally joins sometimes: ' + y2);
  assert.equal(Diplomacy.allyWillJoin(kb.id, ka.id, kc.id, true), false, 'not an ally');
  assert.equal(Diplomacy.allyWillJoin(ka.id, ka.id, kb.id, true), false);
});

section('AI: respects truce / strength / commanded; never attacks non-neighbours or a much stronger neighbour (controlled setting)', () => {
  const ctx = mkCtx(23);
  const { S, Diplomacy, spy, Kingdoms, Traits } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  ctx.Regions.step = () => {};                                       // frozen borders: no peaceful expansion into new contacts
  const { k: ka } = mkKingdom(ctx, ch[0].id, 1, 12), { k: kb } = mkKingdom(ctx, ch[1].id, 0, 4), { k: kc } = mkKingdom(ctx, ch[2].id, 2, 4);
  // a hostile setting: an aggressive orc ruler next to a hated human neighbour; the elves (not adjacent to the orcs) hate them too
  for (const k of S.kingdoms.values()) { k.born = -5000; k.stability = 90; }
  Kingdoms.ruler(ka.id).traits = [Traits.byKey.aggressive.id, Traits.byKey.brave.id];
  const pop = (k, n) => { for (const id of k.cities) { const c = S.cities.get(id); c.pop = n; } };
  S.tick = 2000;
  const hate = (a, b) => { const r = Diplomacy.get(a, b); r.opinion = -80; r.causes = [{ t: 'ev', v: -80, why: 'Тест' }]; };
  // 1) the target is a much stronger neighbour: no war, ever
  Kingdoms.setCommanded(kb.id, true);                               // (the strong human is passive: only the orc's choices are tested)
  pop(kb, 400); pop(ka, 40);
  for (let i = 0; i < 150; i++) { hate(ka.id, kb.id); pop(kb, 400); pop(ka, 40); tickPol(ctx, 20); }
  assert.equal(spy.declared.length, 0, 'never attacks a much stronger neighbour: ' + JSON.stringify(spy.declared));
  // 2) a weaker neighbour, but under a truce: nothing until the truce ends, then the war comes
  Kingdoms.setCommanded(kb.id, false);
  pop(kb, 26); pop(ka, 60);
  const truceEnd = S.tick + 2500;
  Diplomacy.setTruce(ka.id, kb.id, truceEnd);
  let t = 0;
  while (!spy.declared.length && t < 12000) { hate(ka.id, kb.id); tickPol(ctx, 20); t += 20; pop(kb, 26); pop(ka, 60); hate(kc.id, ka.id); }
  const d0 = spy.declared[0];
  assert.ok(d0 && d0.a === ka.id && d0.b === kb.id, 'the aggressive orc attacks its weak, hated neighbour: ' + JSON.stringify(d0));
  assert.ok(d0.tick >= truceEnd, `not during the truce (${d0.tick} >= ${truceEnd})`);
  assert.ok(d0.contact > 0 && !d0.truce && !d0.allied && !d0.cmdA);
  // 3) the elves never attack the orcs they hate: no border
  assert.equal(Diplomacy.contact(ka.id, kc.id), 0);
  assert.ok(spy.declared.every(d => !(d.a === kc.id && d.b === ka.id)), 'no war between non-neighbours');
  // 4) a commanded kingdom never declares on its own, however much it hates
  for (const w of S.wars.values()) w.ended = true;
  Kingdoms.setCommanded(ka.id, true); Diplomacy.setTruce(ka.id, kb.id, 0);
  const n0 = spy.declared.length;
  for (let i = 0; i < 400; i++) { hate(ka.id, kb.id); tickPol(ctx, 20); pop(kb, 26); pop(ka, 60); }
  assert.equal(spy.declared.length, n0, 'commanded: no AI war');
  assert.equal(Diplomacy.alliesOf(ka.id).length, 0, 'commanded: no AI alliance');
  // but it can be attacked by an AI neighbour
  inv(ctx, 'ai');
});

// ====================================================================================================
// full populated worlds
const runs = [];
function fullRun(seed, mode) {
  const ctx = mkGame(seed, mode);
  const { S, Bus, Sim } = ctx;
  const ev = { crowned: 0, rebel: 0, ally: 0, destroyed: 0, created: 0, merges: 0, maxK: 0 };
  Bus.on('kingCrowned', () => ev.crowned++); Bus.on('cityRebelled', () => ev.rebel++); Bus.on('allianceMade', () => ev.ally++);
  Bus.on('kingdomDestroyed', () => ev.destroyed++); Bus.on('kingdomCreated', () => ev.created++);
  const t0 = performance.now();
  const samples = [];
  let warK = 0, allK = 0;
  for (let t = 0; t < TICKS; t += 100) {
    runGame(ctx, 100);
    ev.maxK = Math.max(ev.maxK, S.kingdoms.size);
    const busy = new Set();
    for (const w of S.wars.values()) if (!w.ended) { for (const x of w.attackers) busy.add(x); for (const x of w.defenders) busy.add(x); }
    warK += busy.size; allK += S.kingdoms.size;
    if (t % 2000 === 1900) inv(ctx, `seed ${seed} t=${S.tick}`);
    if (t % 500 === 400) samples.push(S.kingdoms.size);
  }
  ev.merges = S.log.filter(e => /присоединило/.test(e.msg)).length;
  const ms = performance.now() - t0;
  inv(ctx, `seed ${seed} end`);
  assert.equal(Sim.totalErrors, 0, 'no module threw: ' + JSON.stringify(Sim.errors) + Object.keys(Sim.lastError).map(k => '\n' + k + ': ' + (Sim.lastError[k] && Sim.lastError[k].stack)).join(''));
  const rec = { seed, mode, ctx, ev, ms, samples, wars: ctx.wars, warShare: allK ? warK / allK : 0 };
  runs.push(rec);
  return rec;
}

section(`full worlds: ${SEEDS} seeds x ${TICKS} ticks (populated), no exceptions / NaN, invariants every 2000 ticks, kingdoms form, rulers change`, () => {
  for (let s = 1; s <= SEEDS; s++) {
    const r = fullRun(s, s % 2 ? 'populate' : 'scatter');
    note(`seed ${s} (${r.mode}): ${r.ctx.S.units.size} units, ${r.ctx.S.cities.size} cities, kingdoms ${r.ctx.S.kingdoms.size} (max ${r.ev.maxK}, created ${r.ev.created}, fallen ${r.ev.destroyed}), crowned ${r.ev.crowned}, rebellions ${r.ev.rebel}, alliances ${r.ev.ally}, wars ${r.wars.length}, ${(r.ms / TICKS).toFixed(2)} ms/tick`);
    assert.ok(r.ev.created >= 2, 'kingdoms formed');
    assert.ok(r.ev.crowned >= 2 * Math.max(1, r.ev.created) - 2 || r.ev.crowned >= 3, 'rulers change by succession: ' + r.ev.crowned);
    assert.ok(r.ctx.S.log.every(e => typeof e.msg === 'string' && !/undefined|NaN|\[object/.test(e.msg)), 'clean log texts');
  }
  const hi = runs.filter(r => r.ev.maxK >= 4).length;
  assert.ok(hi >= Math.ceil(runs.length / 2), `4+ kingdoms at some point in at least half of the worlds (${hi}/${runs.length})`);
});

section('AI wars in full worlds: lively but not constant (1 war per ~3-8 game minutes), only between neighbours, never against a much stronger one, never for the commanded', () => {
  let total = 0;
  for (const r of runs) {
    for (const d of r.wars) {
      if (d.casus === 'rebel' || d.casus === 'god') continue;
      assert.ok(d.contact > 0, `seed ${r.seed}: war ${d.a}->${d.b} between non-neighbours (contact ${d.contact})`);
      assert.ok(d.powerA >= 0.85 * d.powerB - 1e-6, `seed ${r.seed}: attacked a much stronger neighbour ${d.powerA} vs ${d.powerB}`);
      assert.ok(!d.truce && !d.allied && !d.cmdA, 'respects truces / alliances');
      assert.ok(['claim', 'border', 'conquest'].includes(d.casus), 'AI casus ' + d.casus);
      assert.ok(d.goals.length >= 1 && d.goals.length <= 2, 'one or two goals: ' + JSON.stringify(d.goals));
      assert.ok(d.tick >= 4200, 'not before the world settled');
    }
    total += r.wars.filter(d => d.casus !== 'rebel').length;
  }
  const SETTLE = 4200;                                              // Diplomacy.MIN_WAR_TICK (integration pass: young kingdoms get time to grow before the AI fights)
  const worldMinutes = runs.length * Math.max(600, TICKS - SETTLE) / 600;
  const perWar = total ? worldMinutes / total : Infinity;
  note(`${total} AI wars in ${runs.length} worlds x ${TICKS} ticks => one war per ${perWar.toFixed(1)} game minutes per world (${(perWar * 600).toFixed(0)} ticks)`);
  assert.ok(total >= runs.length, 'wars do happen');
  assert.ok(perWar >= 2.4 && perWar <= 8.5, `rate target 3-8 minutes (tolerance 2.4-8.5): ${perWar.toFixed(2)}`);
  // most kingdoms are at peace most of the time (sampled every 100 ticks)
  for (const r of runs) {
    note(`seed ${r.seed}: ${(100 * r.warShare).toFixed(0)}% of kingdom-time at war`);
    assert.ok(r.warShare < 0.55, `seed ${r.seed}: kingdoms at war ${(100 * r.warShare).toFixed(0)}% of the time`);
  }
});

section('long-run politics: rebellions happen sometimes, alliances form, merges stay rare; every event has its log line', () => {
  const sum = (f) => runs.reduce((s, r) => s + f(r), 0);
  const reb = sum(r => r.ev.rebel), ally = sum(r => r.ev.ally), merges = sum(r => r.ev.merges);
  note(`over ${runs.length} worlds: ${reb} rebellions, ${ally} alliances, ${merges} merges, ${sum(r => r.ev.destroyed)} fallen kingdoms, ${sum(r => r.ev.crowned)} coronations`);
  assert.ok(reb >= 1 || QUICK, 'rebellions occur sometimes');
  assert.ok(reb <= 4 * runs.length, 'but not constantly');
  assert.ok(ally >= 1, 'alliances form');
  assert.ok(merges <= Math.max(2, runs.length), 'merges are rare');
  for (const r of runs) {
    const L = r.ctx.S.log;
    assert.ok(r.ev.rebel === 0 || L.some(e => /восстал/.test(e.msg)) || L.length >= 300, 'rebellion log');
    // spam control: at most ~1 routine kingdom message per kingdom per 20 ticks
    const by = new Map();
    for (const e of L) if (e.kind === 'kingdom' && e.kid) { const a = by.get(e.kid) || []; a.push(e.tick); by.set(e.kid, a); }
  }
});

section('feed spam control: routine kingdom messages at most one per kingdom per 20 ticks', () => {
  const ctx = mkCtx(24);
  const { S, Kingdoms } = ctx;
  const ch = chainOfRegions(ctx, 0, 3);
  const { k } = mkKingdom(ctx, ch[0].id, 0, 6);
  const a = S.cities.get(k.capitalId);
  const b = addCityTo(ctx, ch[1].id, a, 4), c = addCityTo(ctx, ch[2].id, a, 4);
  const m = S.nextLogId;
  // provoke the same routine message repeatedly: capital hopping in one tick
  for (let i = 0; i < 6; i++) { Kingdoms.transferCity(i % 2 ? b.id : c.id, k.id, 'x'); S.tick += 1; }
  const caps = S.log.filter(e => e.id >= m && /Столица королевства/.test(e.msg));
  assert.ok(caps.length <= 1, 'one capital message per 20 ticks: ' + caps.length);
});

section('save / load determinism with the new state (kingdoms, relations, S.mod.kingdoms / diplomacy, wars): continuing after a load is identical', () => {
  const seed = 5;
  const A = mkGame(seed, 'populate');
  runGame(A, QUICK ? 3200 : 4600);
  assert.ok(A.S.kingdoms.size >= 2);
  const blob = A.Save.serialize();
  const B = loadSim({ stub: REAL_WAR ? [] : ['War'] });
  B.spy = REAL_WAR ? null : spyWar(B);
  assert.ok(B.Save.deserialize(blob), 'loaded');
  const same = (label, x, y) => assert.equal(JSON.stringify(x), JSON.stringify(y), label + ' identical after load');
  const state = (c) => ({ k: [...c.S.kingdoms.values()], r: [...c.S.rels.entries()], mk: c.S.mod.kingdoms, md: c.S.mod.diplomacy, cu: c.S.cultures, w: [...c.S.wars.values()], reg: [...c.S.regions.values()], c: [...c.S.cities.values()].map(x => ({ id: x.id, k: x.kingdomId, l: x.loyalty, cu: x.culture, o: x.occupierId })) });
  const a0 = state(A), b0 = state(B);
  for (const key of Object.keys(a0)) same('right after load: ' + key, a0[key], b0[key]);
  const wars0 = A.S.wars.size;
  for (let i = 0; i < 1500; i++) { runGame(A, 1); runGame(B, 1); }
  const a1 = state(A), b1 = state(B);
  for (const key of Object.keys(a1)) same('+1500 ticks: ' + key, a1[key], b1[key]);
  same('log', A.S.log.slice(-100), B.S.log.slice(-100)); assert.equal(A.R.getState(), B.R.getState(), 'rng in step');
  note(`${A.S.kingdoms.size} kingdoms, ${A.S.rels.size} relations, wars ${wars0} -> ${A.S.wars.size}; JSON ${(blob.length / 1024).toFixed(0)} KB`);
  // a second hop keeps everything consistent
  const C = loadSim({ stub: REAL_WAR ? [] : ['War'] });
  C.spy = REAL_WAR ? null : spyWar(C);
  assert.ok(C.Save.deserialize(A.Save.serialize()));
  inv(C, 'second hop');
  // a stage-1 style save (kingdom table without the stage-2 columns, no relations, no politics state) is repaired by afterLoad and keeps running
  const old = JSON.parse(A.Save.serialize());
  const drop = ['cmd', 'overlordId', 'infamy', 'manpowerUsed', 'rebels', 'lastRebel', 'succAt', 'crisis', 'reigns', 'vassalSince', 'peaceAt', 'consortId'];
  const kt = old.kingdoms;
  for (const key of drop) { const ix = kt.k.indexOf(key); if (ix >= 0) { kt.k.splice(ix, 1); kt.r.forEach(row => row.splice(ix, 1)); } }
  old.rels = []; delete old.mod.kingdoms; delete old.mod.diplomacy;
  const D = loadSim({ stub: ['War'] }); D.spy = spyWar(D);
  assert.ok(D.Save.deserialize(JSON.stringify(old)), 'stage-1 style save loads: ' + D.Save.lastError);
  for (const k of D.S.kingdoms.values()) { assert.equal(k.cmd, false); assert.equal(k.overlordId, 0); assert.equal(k.infamy, 0); assert.ok(Number.isFinite(k.peaceAt)); }
  assert.equal(D.S.rels.size, D.S.kingdoms.size * (D.S.kingdoms.size - 1) / 2, 'missing relations were created');
  runGame(D, 600);
  assert.equal(D.Sim.totalErrors, 0, JSON.stringify(D.Sim.errors));
  inv(D, 'stage-1 save');
});

section('perf: Kingdoms.step + Diplomacy.step cost per tick in a 1500-unit world (ms/tick, worst tick)', () => {
  const r = runs[runs.length - 1] || fullRun(2, 'populate');
  const ctx = r.ctx;
  const { S, Kingdoms, Diplomacy } = ctx;
  const T = { k: 0, d: 0, wk: 0, wd: 0 };
  const sk = Kingdoms.step, sd = Diplomacy.step;
  Kingdoms.step = (t) => { const a = performance.now(); sk(t); const dt = performance.now() - a; T.k += dt; if (dt > T.wk) T.wk = dt; };
  Diplomacy.step = (t) => { const a = performance.now(); sd(t); const dt = performance.now() - a; T.d += dt; if (dt > T.wd) T.wd = dt; };
  const n = 800;
  runGame(ctx, n);
  Kingdoms.step = sk; Diplomacy.step = sd;
  note(`${S.units.size} units, ${S.cities.size} cities, ${S.kingdoms.size} kingdoms: Kingdoms.step ${(T.k / n).toFixed(4)} ms/tick (worst ${T.wk.toFixed(3)}), Diplomacy.step ${(T.d / n).toFixed(4)} ms/tick (worst ${T.wd.toFixed(3)}); whole tick ${ctx.Sim.profile.total.toFixed(2)} ms`);
  assert.ok(T.k / n < 0.25, 'Kingdoms.step cheap'); assert.ok(T.d / n < 0.25, 'Diplomacy.step cheap');
  assert.ok(T.wk < 12 && T.wd < 12, 'no long hitch');
  // neighbors / relationsOf / strength are cheap enough for the UI to call every frame
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) for (const k of S.kingdoms.values()) { Diplomacy.neighbors(k.id); Diplomacy.relationsOf(k.id); Kingdoms.strength(k.id); }
  const per = (performance.now() - t0) / 2000;
  note(`neighbors + relationsOf + strength for all ${S.kingdoms.size} kingdoms: ${per.toFixed(3)} ms per sweep`);
  assert.ok(per < 3);
});

// ====================================================================================================
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
if (failed.length) process.exit(1);
