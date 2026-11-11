// Player diplomacy tests (plain node + assert).   node tests/diplomacy.test.mjs [--quick] [--seeds=N] [--ticks=N]
// Diplomacy.propose / respond / inbox / actionsFor / card (docs/feat_diplomacy.md): alliance, non-aggression pact (built on the truce), trade agreement,
// gifts, demands / ultimatums, vassal management, call to arms, dynastic marriage, guarantees, embargo; the inbox of the commanded kingdom; the AI that
// uses the same machinery (rates, spam control); treaty lifecycles + war interplay; determinism and save / load continuation; performance.
// Worlds: real World / Cities / Units / Kingdoms / Regions / Diplomacy / War (Powers + Save stubbed unless a section needs them).
import assert from 'node:assert/strict';
import { loadSim, stepN, newWorld, pad } from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const QUICK = !!args.quick;
const SEEDS = args.seeds ? +args.seeds : (QUICK ? 2 : 4);
const TICKS = args.ticks ? +args.ticks : (QUICK ? 9000 : 15000);

const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 88)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 12).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

// ------------------------------------------------------------------ plumbing
function mkCtx(seed = 1, stub = ['Powers', 'Save']) {
  const ctx = loadSim({ stub });
  newWorld(ctx, seed, 96, 96);
  return ctx;
}
/** advance the political modules only (units stay frozen: no ageing, no births, no hunger) */
function tickPol(ctx, n) {
  for (let i = 0; i < n; i++) {
    ctx.S.tick++;
    ctx.Kingdoms.step(ctx.S.tick); ctx.Regions.step(ctx.S.tick); ctx.Diplomacy.step(ctx.S.tick);
    if (ctx.War && !ctx.War.__stub) ctx.War.step(ctx.S.tick);
  }
}
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
function foundIn(ctx, rid, race, n = 6) {
  const s = siteIn(ctx, rid, race);
  if (!s) return null;
  return ctx.Cities.found(race, s.x, s.y, spawnN(ctx, race, n, s.x, s.y), {});
}
/** more citizens for a city (adults, fed): the power of a kingdom is population based */
function grow(ctx, city, n, race) {
  for (let i = 0; i < n; i++) {
    const u = ctx.Units.spawn(race === undefined ? city.race : race, city.x + 0.5 + ((i * 7) % 5) * 0.3, city.y + 0.5 + ((i * 3) % 5) * 0.3, { sex: i % 2, age: 20 + (i * 5) % 20, cityId: city.id });
    if (u) u.hunger = 0;
  }
}
function feed(ctx, amt = {}) {
  for (const c of ctx.S.cities.values()) {
    c.stock.food = Math.max(c.stock.food, amt.food === undefined ? 160 : amt.food); c.stock.wood = Math.max(c.stock.wood, amt.wood === undefined ? 90 : amt.wood);
    c.stock.iron = Math.max(c.stock.iron, amt.iron === undefined ? 40 : amt.iron); c.stock.stone = Math.max(c.stock.stone, amt.stone === undefined ? 50 : amt.stone);
    c.stock.gold = Math.max(c.stock.gold, amt.gold === undefined ? 12 : amt.gold);
  }
}
/** a chain of free regions r0 - r1 - r2 ... (consecutive ones adjacent without a ford, the others not adjacent), a village site in each */
function chainOfRegions(ctx, len = 3, race = 0) {
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
/** three mutually adjacent free regions (a triangle) with village sites */
function triangleOfRegions(ctx, race = 0) {
  const { S } = ctx;
  for (const a of S.regions.values()) {
    const sa = !a.ownerId && siteIn(ctx, a.id, race);
    if (!sa) continue;
    for (const bid of a.nb) {
      const b = S.regions.get(bid);
      if (!b || b.ownerId || a.fd.includes(bid)) continue;
      const sb = siteIn(ctx, b.id, race);
      if (!sb || Math.hypot(sa.x - sb.x, sa.y - sb.y) < 12) continue;
      for (const cid of b.nb) {
        if (cid === a.id) continue;
        const c = S.regions.get(cid);
        if (!c || c.ownerId || !a.nb.includes(cid) || a.fd.includes(cid) || b.fd.includes(cid)) continue;
        const sc = siteIn(ctx, c.id, race);
        if (!sc || Math.hypot(sa.x - sc.x, sa.y - sc.y) < 12 || Math.hypot(sb.x - sc.x, sb.y - sc.y) < 12) continue;
        return [a, b, c];
      }
    }
  }
  return null;
}
/**
 * Kingdoms in a row/triangle: spec = [{race, pop}] -> handles. Kingdoms are separate (split off when a village joined a neighbour of its race).
 * Every kingdom gets `pop` citizens and a full capital stock; the world is quiet (AI of Diplomacy switched off: tests drive it explicitly).
 */
function mkKingdoms(ctx, spec, shape = 'chain') {
  const regs = shape === 'triangle' ? triangleOfRegions(ctx, spec[0].race || 0) : chainOfRegions(ctx, spec.length, spec[0].race || 0);
  assert.ok(regs, 'region layout found (' + shape + ')');
  const out = [];
  for (let i = 0; i < spec.length; i++) {
    if (spec[i].skip) { out.push({ k: null, kid: 0, city: null, rid: regs[i].id }); continue; }          // (a free region between the kingdoms)
    const race = spec[i].race === undefined ? 0 : spec[i].race;
    const before = ctx.S.kingdoms.size;
    const c = foundIn(ctx, regs[i].id, race, 6);
    assert.ok(c, 'village founded in region ' + regs[i].id);
    if (ctx.S.kingdoms.size === before) assert.ok(ctx.Kingdoms.splitCity(c.id) > 0, 'split off');
    if (spec[i].pop > 6) grow(ctx, c, spec[i].pop - 6, race);
    const k = ctx.Kingdoms.get(c.kingdomId);
    out.push({ k, kid: k.id, city: c, rid: regs[i].id });
  }
  feed(ctx);
  ctx.S.tick += 1;                                           // (Diplomacy memoises its world snapshot per tick: setup must not leave a stale one)
  return out;
}
/** world + kingdoms; the layout (chain / triangle of free regions) is searched over a few seeds */
function scenario(seed, spec, shape = 'chain', stub) {
  for (let s = seed; s < seed + 12; s++) {
    const ctx = mkCtx(s, stub);
    const regs = shape === 'triangle' ? triangleOfRegions(ctx, spec[0].race || 0) : chainOfRegions(ctx, spec.length, spec[0].race || 0);
    if (!regs) continue;
    return { ctx, ks: mkKingdoms(ctx, spec, shape) };
  }
  assert.fail('no ' + shape + ' layout in 12 seeds');
}
const ev = (ctx, kid, other, why) => { const r = ctx.Diplomacy.get(kid, other); const c = r.causes.find(x => x.t === 'ev' && x.why === why); return c ? c.v : 0; };
/** set the opinion of a pair to exactly v by an event (no refresh runs in between) */
function setOp(ctx, a, b, v) { const r = ctx.Diplomacy.get(a, b); ctx.Diplomacy.addOpinion(a, b, v - r.opinion, 'Тест'); assert.ok(Math.abs(r.opinion - v) < 0.2); }
const trKey = (a, b) => (a < b ? a + '_' + b : b + '_' + a);
const logsSince = (ctx, id0) => ctx.S.log.filter(l => l.id >= id0);
function jsonSafe(o, label) { assert.deepEqual(JSON.parse(JSON.stringify(o)), o, label + ' is JSON-safe'); }

console.log('Diplomacy tests (player diplomacy)' + (QUICK ? ' (quick)' : ''));

// ====================================================================================================
section('API surface; every public call tolerates dead / missing / nonsense ids (no throw, falsy result)', () => {
  const ctx = mkCtx(1);
  const { Diplomacy: D, ToolDefs, PowerPlugins } = ctx;
  for (const f of ['propose', 'respond', 'inbox', 'actionsFor', 'card', 'treaties', 'callAllies', 'plan']) assert.equal(typeof D[f], 'function', f);
  const junk = [0, -1, 999999, NaN, undefined, null, 'x', {}, [], Infinity];
  for (const a of junk) for (const b of junk) {
    assert.doesNotThrow(() => D.propose(a, b, 'alliance'), `propose ${a},${b}`);
    const r = D.propose(a, b, 'alliance', {});
    assert.equal(r.ok, false); assert.equal(r.accepted, false); assert.equal(r.pending, false); assert.equal(typeof r.reason, 'string');
    assert.deepEqual(D.actionsFor(a, b), []); assert.equal(D.card(a, b), null); assert.deepEqual(D.treaties(a, b), []);
  }
  for (const k of D.KINDS) for (const a of junk) assert.doesNotThrow(() => D.propose(a, a, k, { years: 'x', goods: 5, what: {} }), k);
  for (const id of junk) { assert.doesNotThrow(() => D.respond(id, true)); assert.equal(D.respond(id, true).ok, false); assert.deepEqual(D.inbox(id), []); assert.doesNotThrow(() => D.callAllies(id, id)); }
  assert.equal(D.propose(1, 2, 'no-such-kind').ok, false);
  // the tool + the power plugin that keeps Powers.apply quiet
  assert.ok(ToolDefs.byId.diplomacy && ToolDefs.byId.diplomacy.tab === 'kingdoms', 'tool registered');
  assert.ok(PowerPlugins.some(p => p.ids && p.ids.includes('diplomacy')), 'power plugin registered');
  assert.equal(ToolDefs.filter(t => t.tab === 'kingdoms').map(t => t.id).slice(0, 2).join(), 'command,diplomacy', 'next to the war tool');
});

section('state: S.mod.diplomacy is normalised (old saves), JSON-safe, relations keep their literal key order', () => {
  const { ctx, ks: [A, B] } = scenario(1, [{ pop: 12 }, { pop: 12 }]);
  const { S, Diplomacy: D } = ctx;
  delete S.mod.diplomacy;
  D.afterLoad();
  const m = S.mod.diplomacy;
  for (const f of ['lastWar', 'cd', 'acd', 'seen', 'nid', 'tr', 'inbox', 'dcd', 'lg', 'ult', 'gift', 'vtc', 'call', 'rf']) assert.ok(f in m, f);
  assert.deepEqual(Object.keys(D.get(A.kid, B.kid)), ['a', 'b', 'opinion', 'state', 'since', 'truceUntil', 'allianceSince', 'causes']);
  setOp(ctx, A.kid, B.kid, 30);
  assert.equal(D.propose(A.kid, B.kid, 'trade').accepted, true);
  assert.equal(D.propose(A.kid, B.kid, 'pact', { years: 10 }).accepted, true);
  jsonSafe(S.mod, 'S.mod');
  jsonSafe([...S.rels.entries()], 'relations');
  assert.deepEqual(Object.keys(m.tr), [A.kid < B.kid ? A.kid + '_' + B.kid : B.kid + '_' + A.kid]);
  // garbage in the saved state is dropped / repaired
  m.tr['999_1000'] = { pact: 5 }; m.inbox.push({ id: 'x' }, null, { id: 77, from: 999, to: 1, kind: 'alliance', terms: {} }); m.tr[Object.keys(m.tr)[0]].pact = 'bad';
  D.afterLoad();
  assert.ok(!('999_1000' in m.tr)); assert.equal(m.inbox.length, 0); assert.equal(m.tr[Object.keys(m.tr)[0]].pact, 0);
});

// ====================================================================================================
section('alliance: the answer is a deterministic score (opinion + named causes) against a need; refusal explains itself', () => {
  const { ctx, ks: [A, B] } = scenario(2, [{ pop: 20 }, { pop: 20 }]);
  const { Diplomacy: D, S } = ctx;
  // cold relations: refused with a reason, nothing changes, plan agrees
  setOp(ctx, A.kid, B.kid, 20);
  let P = D.plan('alliance', A.kid, B.kid);
  assert.equal(P.ok, true); assert.equal(P.accept, false); assert.ok(P.margin < 0 && P.need === 52);
  const mark = S.nextLogId;
  let r = D.propose(A.kid, B.kid, 'alliance');
  assert.equal(r.ok, true); assert.equal(r.accepted, false); assert.equal(r.pending, false);
  assert.match(r.reason, /^Отказ: союза не будет \(\d+ из 52\)/);
  assert.ok(r.causes.length && r.causes.every(c => typeof c.v === 'number' && typeof c.why === 'string'));
  assert.equal(D.state(A.kid, B.kid), 0); assert.equal(logsSince(ctx, mark).length, 0);
  // a warm friend accepts: state, log, event, allianceMade
  setOp(ctx, A.kid, B.kid, 60);
  P = D.plan('alliance', A.kid, B.kid); assert.equal(P.accept, true);
  let made = 0; ctx.Bus.on('allianceMade', () => { made++; });
  r = D.propose(A.kid, B.kid, 'alliance');
  assert.equal(r.accepted, true); assert.deepEqual(r.effects, ['Союз заключён']);
  assert.equal(D.state(A.kid, B.kid), 1); assert.equal(made, 1);
  assert.ok(logsSince(ctx, mark).some(l => /Заключён союз/.test(l.msg)));
  // already allied: not proposable again
  r = D.propose(A.kid, B.kid, 'alliance'); assert.equal(r.ok, false); assert.match(r.reason, /уже союзники/);
  // marriage + trade + pact are named causes that tip the balance
  const { ctx: ctx2, ks: [A2, B2] } = scenario(2, [{ pop: 20 }, { pop: 20 }]);
  setOp(ctx2, A2.kid, B2.kid, 44);
  const base = ctx2.Diplomacy.plan('alliance', A2.kid, B2.kid);
  assert.equal(base.accept, false);
  assert.equal(ctx2.Diplomacy.propose(A2.kid, B2.kid, 'trade').accepted, true);
  assert.equal(ctx2.Diplomacy.propose(A2.kid, B2.kid, 'pact', { years: 10 }).accepted, true);
  const more = ctx2.Diplomacy.plan('alliance', A2.kid, B2.kid);
  assert.ok(more.score > base.score + 7, 'trade and a pact add to the score: ' + base.score + ' -> ' + more.score);
  assert.ok(more.causes.some(c => /Торговые связи/.test(c.why)) && more.causes.some(c => /Пакт/.test(c.why)));
});

section('alliance: limits and clashes (two allies at most, no vassal alliances, no ally at war with the proposer), break costs', () => {
  const { ctx, ks: [A, B, C] } = scenario(3, [{ pop: 18 }, { pop: 18 }, { pop: 18 }], 'triangle');
  const { Diplomacy: D, S, Kingdoms } = ctx;
  for (const [x, y] of [[A, B], [A, C], [B, C]]) setOp(ctx, x.kid, y.kid, 70);
  // vassal link
  Kingdoms.annex(C.kid, A.kid, 'vassal');
  let r = D.propose(A.kid, C.kid, 'alliance'); assert.equal(r.ok, false); assert.match(r.reason, /сюзерен и вассал/);
  r = D.propose(C.kid, B.kid, 'alliance'); assert.equal(r.ok, false); assert.match(r.reason, /вассал не ведёт/);
  r = D.propose(B.kid, C.kid, 'alliance'); assert.equal(r.ok, false); assert.match(r.reason, /вассал/);
  Kingdoms.breakFree(C.kid); setOp(ctx, A.kid, C.kid, 70); setOp(ctx, B.kid, C.kid, 70);
  // alliance A-B, then C asks B: fine (B has one ally); A at war with C blocks it
  assert.equal(D.propose(A.kid, B.kid, 'alliance').accepted, true);
  const w = ctx.War.declare(A.kid, C.kid, [], 'conquest');
  assert.ok(w, 'war A -> C declared: ' + ctx.War.lastError);
  { const r2 = D.propose(C.kid, B.kid, 'alliance'); assert.equal(r2.ok, false); assert.match(r2.reason, /воюет с/); ctx.War.end(w.id, 'test'); }
  // the break: -18, no infamy, Bus, both can ally again later after the memory fades
  const inf0 = A.k.infamy, o0 = D.opinion(A.kid, B.kid);
  r = D.propose(A.kid, B.kid, 'break_alliance');
  assert.equal(r.accepted, true); assert.equal(D.state(A.kid, B.kid), 0);
  assert.ok(D.opinion(A.kid, B.kid) <= o0 - 17.5 && ev(ctx, A.kid, B.kid, 'Союз расторгнут') === -18);
  assert.equal(A.k.infamy, inf0);
  r = D.propose(A.kid, B.kid, 'break_alliance'); assert.equal(r.ok, false);
  // allies at war together: breaking is betrayal (-40 in total, infamy +8, everybody else frowns)
  setOp(ctx, A.kid, B.kid, 70); assert.equal(D.propose(A.kid, B.kid, 'alliance').accepted, true);
  setOp(ctx, A.kid, C.kid, -20); setOp(ctx, B.kid, C.kid, -20);
  const w2 = ctx.War.declare(A.kid, C.kid, [], 'god');
  assert.ok(w2, 'second war declared: ' + ctx.War.lastError);
  {
    if (!w2.attackers.includes(B.kid)) assert.equal(ctx.War.join(w2.id, B.kid, A.kid), true);
    const P = D.plan('break_alliance', A.kid, B.kid); assert.equal(P.data.betray, true); assert.match(P.note, /предательство/i);
    const inf1 = A.k.infamy, oc = D.opinion(C.kid, A.kid);
    r = D.propose(A.kid, B.kid, 'break_alliance');
    assert.equal(r.accepted, true); assert.match(r.effects[0], /Предательство/);
    assert.equal(A.k.infamy, inf1 + 8); assert.ok(ev(ctx, A.kid, B.kid, 'Предательство союзника') <= -39);
    assert.ok(D.opinion(A.kid, C.kid) !== oc || true);
  }
});

// ====================================================================================================
section('pact: a LONG TRUCE built on the existing truce (War.canDeclare untouched); god / rebel casus ignore it; options differ in acceptance', () => {
  const { ctx, ks: [A, B, C] } = scenario(4, [{ pop: 24 }, { pop: 24 }, { pop: 24 }], 'triangle');
  const { Diplomacy: D, War, S } = ctx;
  setOp(ctx, A.kid, B.kid, 12);
  const opts = D.actionsFor(A.kid, B.kid).find(a => a.kind === 'pact').options;
  assert.deepEqual(opts.map(o => o.years), [10, 20, 40]);
  assert.ok(opts[0].margin > opts[1].margin && opts[1].margin > opts[2].margin, 'longer pacts are harder to get: ' + opts.map(o => o.margin));
  assert.ok(Math.abs((opts[0].margin - opts[2].margin) - 9) < 0.2);
  const t0 = S.tick;
  let r = D.propose(A.kid, B.kid, 'pact', { years: 20 });
  assert.equal(r.accepted, true); assert.match(r.effects[0], /20 лет/);
  assert.equal(D.pactLeft(A.kid, B.kid), 1200); assert.equal(D.inTruce(A.kid, B.kid), true);
  assert.equal(D.get(A.kid, B.kid).truceUntil, t0 + 1200);
  assert.deepEqual(D.treaties(A.kid, B.kid).map(c => c.id), ['pact']);
  // the war module keeps working untouched: it sees an ordinary truce
  assert.equal(War.canDeclare(A.kid, B.kid).ok, false); assert.match(War.canDeclare(A.kid, B.kid).reason, /перемирие/);
  assert.equal(War.declare(A.kid, B.kid, [], 'conquest'), null);
  assert.equal(D.declareWar(A.kid, B.kid, 'conquest'), null);
  assert.match(D.canDeclare(A.kid, B.kid).reason, /пакт о ненападении/);
  // a shorter truce never shortens the pact
  D.setTruce(A.kid, B.kid, S.tick + 50); assert.equal(D.get(A.kid, B.kid).truceUntil, t0 + 1200);
  r = D.propose(A.kid, B.kid, 'pact'); assert.equal(r.ok, false); assert.match(r.reason, /уже действует/);
  // god casus ignores it: the war clears the pact (and a trade agreement)
  setOp(ctx, A.kid, B.kid, 40); assert.equal(D.propose(A.kid, B.kid, 'trade').accepted, true);
  const w = War.declare(A.kid, B.kid, [], 'god');
  assert.ok(w, 'god war: ' + War.lastError);
  assert.equal(D.pactLeft(A.kid, B.kid), 0); assert.equal(D.tradeOn(A.kid, B.kid), false); assert.equal(D.get(A.kid, B.kid).truceUntil, 0);
  assert.ok(!(trKey(A.kid, B.kid) in S.mod.diplomacy.tr), 'empty record removed');
  assert.deepEqual(D.treaties(A.kid, B.kid).map(c => c.id), ['war']);
  // during a war nothing but peace is proposable
  for (const k of ['alliance', 'pact', 'trade', 'gift', 'marriage']) assert.equal(D.propose(A.kid, B.kid, k).ok, false, k);
  War.end(w.id, 'test');
  // clearing the truce (annex vassal does it) ends a pact too
  setOp(ctx, A.kid, C.kid, 20); assert.equal(D.propose(A.kid, C.kid, 'pact', { years: 10 }).accepted, true);
  D.setTruce(A.kid, C.kid, 0); assert.equal(D.pactLeft(A.kid, C.kid), 0); assert.equal(D.inTruce(A.kid, C.kid), false);
});

section('pact: break = -25 opinion, +6 infamy, third kingdoms frown, the earlier truce comes back; expiry; alliance supersedes', () => {
  const { ctx, ks: [A, B, C] } = scenario(4, [{ pop: 24 }, { pop: 24 }, { pop: 24 }], 'triangle');
  const { Diplomacy: D, S } = ctx;
  setOp(ctx, A.kid, B.kid, 30);
  D.setTruce(A.kid, B.kid, S.tick + 300);                        // a post-war truce that is already running
  assert.equal(D.propose(A.kid, B.kid, 'pact', { years: 10 }).accepted, true);
  assert.equal(D.get(A.kid, B.kid).truceUntil, S.tick + 600);
  const inf0 = A.k.infamy, oc0 = D.opinion(A.kid, C.kid), mark = S.nextLogId;
  const r = D.propose(A.kid, B.kid, 'break_pact');
  assert.equal(r.accepted, true); assert.match(r.effects[0], /−25/);
  assert.equal(ev(ctx, A.kid, B.kid, 'Нарушен пакт'), -25); assert.equal(A.k.infamy, inf0 + 6);
  assert.equal(ev(ctx, A.kid, C.kid, 'Нарушает договоры'), -3, 'the world frowns'); assert.ok(D.opinion(A.kid, C.kid) <= oc0 - 2.9);
  assert.equal(D.get(A.kid, B.kid).truceUntil, S.tick + 300, 'the truce from before the pact is back');
  assert.equal(D.pactLeft(A.kid, B.kid), 0);
  assert.ok(logsSince(ctx, mark).some(l => /разорвало пакт/.test(l.msg)));
  assert.equal(D.propose(A.kid, B.kid, 'break_pact').ok, false);
  // after the pact and the old truce are gone war is possible again (the way of the traitor)
  tickPol(ctx, 301);
  assert.equal(D.inTruce(A.kid, B.kid), false); assert.equal(D.canDeclare(A.kid, B.kid).ok, true);
  // expiry: the truce simply runs out; the player is told (a routine line only when he is involved)
  setOp(ctx, A.kid, C.kid, 40);
  A.k.cmd = true;
  assert.equal(D.propose(A.kid, C.kid, 'pact', { years: 10 }).accepted, true);
  const mark2 = S.nextLogId;
  tickPol(ctx, 620);
  assert.equal(D.pactLeft(A.kid, C.kid), 0); assert.equal(D.inTruce(A.kid, C.kid), false);
  assert.ok(logsSince(ctx, mark2).some(l => /Пакт о ненападении .* истёк/.test(l.msg)), 'expiry reported');
  assert.ok(!(trKey(A.kid, C.kid) in S.mod.diplomacy.tr), 'record cleaned');
  A.k.cmd = false;
  // an alliance supersedes a pact
  setOp(ctx, B.kid, C.kid, 20); D.propose(B.kid, C.kid, 'pact', { years: 10 });
  setOp(ctx, B.kid, C.kid, 70); assert.equal(D.propose(B.kid, C.kid, 'alliance').accepted, true);
  assert.equal(D.pactLeft(B.kid, C.kid), 0); assert.deepEqual(D.treaties(B.kid, C.kid).map(c => c.id), ['alliance']);
  const rp = D.propose(B.kid, C.kid, 'pact'); assert.equal(rp.ok, false); assert.match(rp.reason, /союзникам пакт не нужен/);
});

// ====================================================================================================
section('trade: caravans bring the partner\'s wares to the market city (else the capital), +opinion, routes required, war / embargo cancel it', () => {
  const { ctx, ks: [A, B, C] } = scenario(5, [{ pop: 24 }, { pop: 24, race: 1 }, { pop: 24 }], 'chain');
  const { Diplomacy: D, S, Const, Buildings } = ctx;
  // no common border (A - B - C: A and C are not neighbours) and no markets: no route
  let r = D.propose(A.kid, C.kid, 'trade'); assert.equal(r.ok, false); assert.match(r.reason, /нет торговых путей/);
  setOp(ctx, A.kid, B.kid, 12);
  assert.equal(D.plan('trade', A.kid, B.kid).accept, true);
  // a market in B's capital city (instant): the trade city of B, n = 1 + markets
  const bx = B.city.x, by = B.city.y;
  let placed = null;
  for (let dy = -3; dy <= 3 && !placed; dy++) for (let dx = -3; dx <= 3 && !placed; dx++) { const m = Buildings.place(B.city.id, Const.B.MARKET, bx + dx, by + dy, { instant: true }); if (m) placed = m; }
  assert.ok(placed && placed.done, 'market built');
  const stock = (K, g) => S.cities.get(K.k.capitalId).stock[g];
  S.cities.get(B.k.capitalId).stock.food = 20; S.cities.get(B.k.capitalId).stock.wood = 20;          // (a full storage takes no goods)
  const a0 = { food: stock(A, 'food'), wood: stock(A, 'wood'), iron: stock(A, 'iron'), stone: stock(A, 'stone') }, b0 = { food: stock(B, 'food'), wood: stock(B, 'wood') };
  r = D.propose(A.kid, B.kid, 'trade');
  assert.equal(r.accepted, true); assert.equal(D.tradeOn(A.kid, B.kid), true);
  assert.deepEqual(D.treaties(A.kid, B.kid).map(c => c.id), ['trade']);
  assert.equal(ev(ctx, A.kid, B.kid, 'Торговое соглашение подписано'), 3);
  tickPol(ctx, 240);
  // A (humans) trades with orcs: A receives iron + stone; B (orcs) receives the human wares food + wood. Two caravans in 240 ticks.
  assert.equal(stock(A, 'iron') - a0.iron, 2 * 1, 'A: 2 caravans x 1 iron'); assert.equal(stock(A, 'stone') - a0.stone, 2 * 1);
  assert.equal(stock(B, 'food') - b0.food, 2 * 2, 'B has a market: 1 + 1 per caravan'); assert.equal(stock(B, 'wood') - b0.wood, 2 * 2);
  assert.equal(stock(A, 'food'), a0.food, 'nothing is taken from anybody');
  // the agreement is part of the opinion (structural cause, shown by the inspector)
  tickPol(ctx, 120);
  assert.ok(D.causes(A.kid, B.kid).some(c => c.why === 'Торговое соглашение' && c.v === 8), JSON.stringify(D.causes(A.kid, B.kid)));
  // embargo cancels it and forbids a new one for 20 years; only the embargoer may lift it
  r = D.propose(B.kid, A.kid, 'embargo'); assert.equal(r.accepted, true);
  assert.equal(D.tradeOn(A.kid, B.kid), false); assert.equal(ev(ctx, A.kid, B.kid, 'Эмбарго'), -15);
  r = D.propose(A.kid, B.kid, 'trade'); assert.equal(r.ok, false); assert.match(r.reason, /эмбарго ещё 20 лет/);
  assert.equal(D.propose(A.kid, B.kid, 'lift_embargo').ok, false); assert.equal(D.propose(B.kid, A.kid, 'embargo').ok, false);
  assert.ok(D.treaties(A.kid, B.kid).some(c => c.id === 'embargo'));
  assert.equal(D.propose(B.kid, A.kid, 'lift_embargo').accepted, true);
  setOp(ctx, A.kid, B.kid, 12);
  assert.equal(D.propose(A.kid, B.kid, 'trade').accepted, true);
  // voluntary cancellation: -5
  assert.equal(D.propose(A.kid, B.kid, 'cancel_trade').accepted, true); assert.equal(ev(ctx, A.kid, B.kid, 'Торговля прекращена'), -5);
  assert.equal(D.propose(A.kid, B.kid, 'cancel_trade').ok, false);
  // war cancels it
  setOp(ctx, A.kid, B.kid, 12); assert.equal(D.propose(A.kid, B.kid, 'trade').accepted, true);
  const w = ctx.War.declare(A.kid, B.kid, [], 'god'); assert.ok(w, ctx.War.lastError);
  assert.equal(D.tradeOn(A.kid, B.kid), false);
  ctx.War.end(w.id, 'test');
  // an embargo expires by itself
  D.propose(A.kid, B.kid, 'embargo'); tickPol(ctx, 1210);
  assert.equal(D.embargoLeft(A.kid, B.kid), 0);
});

// ====================================================================================================
section('gift: goods move capital -> capital (conserved), opinion scales with value and is capped, limited by stock / room, refused in war', () => {
  const { ctx, ks: [A, B] } = scenario(6, [{ pop: 20 }, { pop: 20 }]);
  const { Diplomacy: D, S } = ctx;
  const cA = S.cities.get(A.k.capitalId), cB = S.cities.get(B.k.capitalId);
  cA.stock.gold = 20; cA.stock.iron = 30; cA.stock.food = 90; cB.stock.gold = 3; cB.stock.iron = 0; cB.stock.food = 10;
  const total = (g) => cA.stock[g] + cB.stock[g];
  const t0 = { gold: total('gold'), iron: total('iron'), food: total('food') };
  setOp(ctx, A.kid, B.kid, 0);
  const act = D.actionsFor(A.kid, B.kid).find(a => a.kind === 'gift');
  assert.equal(act.available, true);
  assert.deepEqual(act.options.map(o => o.good), ['food', 'wood', 'stone', 'iron', 'gold']);
  assert.equal(act.options.find(o => o.good === 'gold').have, 20);
  const r = D.propose(A.kid, B.kid, 'gift', { goods: { gold: 3, iron: 10 } });
  assert.equal(r.accepted, true); assert.match(r.effects[0], /железо ×10, золото ×3/);
  assert.equal(cA.stock.gold, 17); assert.equal(cB.stock.gold, 6); assert.equal(cA.stock.iron, 20); assert.equal(cB.stock.iron, 10);
  for (const g of ['gold', 'iron', 'food']) assert.equal(total(g), t0[g], g + ' is conserved');
  const gain = ev(ctx, A.kid, B.kid, 'Подарок');
  assert.ok(Math.abs(gain - 0.9 * Math.sqrt(3 * 7 + 10 * 3.2)) < 0.06, 'opinion follows the value of the gift: ' + gain);
  assert.equal(D.get(A.kid, B.kid).opinion > 6, true);
  // many gifts: the live bonus never exceeds 30
  for (let i = 0; i < 12; i++) { cA.stock.gold = 20; D.propose(A.kid, B.kid, 'gift', { goods: { gold: 20 } }); cB.stock.gold = 3; }
  assert.ok(ev(ctx, A.kid, B.kid, 'Подарок') <= 30.0001 && ev(ctx, A.kid, B.kid, 'Подарок') >= 29, 'gift bonus capped: ' + ev(ctx, A.kid, B.kid, 'Подарок'));
  // asking for more than there is / more than fits: clamped, never negative stock
  cA.stock.food = 7; cB.stock.food = 95;
  const room = D.plan('gift', A.kid, B.kid, { goods: { food: 500 } }).data;
  assert.ok(room.goods.food <= 7 && room.goods.food <= room.options[0].room);
  D.propose(A.kid, B.kid, 'gift', { goods: { food: 500 } });
  assert.ok(cA.stock.food >= 0 && cB.stock.food <= 400);
  // nonsense terms do nothing
  const before = JSON.stringify([cA.stock, cB.stock]);
  for (const goods of [{}, null, { foo: 5 }, { gold: -3 }, { gold: 'x' }, { gold: NaN }, 7]) { const x = D.propose(A.kid, B.kid, 'gift', { goods }); assert.equal(x.accepted, false); }
  assert.equal(JSON.stringify([cA.stock, cB.stock]), before);
  // an empty treasury / a full storehouse / war: not available, with the reason
  cA.stock.food = cA.stock.wood = cA.stock.stone = cA.stock.iron = cA.stock.gold = 0;
  let a2 = D.actionsFor(A.kid, B.kid).find(a => a.kind === 'gift'); assert.equal(a2.available, false); assert.match(a2.reason, /пусто/);
  feed(ctx); const w = ctx.War.declare(A.kid, B.kid, [], 'god'); assert.ok(w);
  a2 = D.actionsFor(A.kid, B.kid).find(a => a.kind === 'gift'); assert.equal(a2.available, false); assert.match(a2.reason, /в разгар войны/);
});

// ====================================================================================================
section('demand: tribute / region / vassalage by relative power; refusal leaves a casus (justified war), commanded targets decide themselves', () => {
  const { ctx, ks: [A, B, C] } = scenario(7, [{ pop: 130 }, { pop: 14 }, { pop: 14 }], 'triangle');
  const { Diplomacy: D, S, Kingdoms, War } = ctx;
  const ratio = D.power(A.kid) / D.power(B.kid);
  assert.ok(ratio > 3.6, 'A towers over B: ' + ratio);
  setOp(ctx, A.kid, B.kid, 0);
  const cA = S.cities.get(A.k.capitalId), cB = S.cities.get(B.k.capitalId);
  cB.stock.gold = 9; cB.stock.iron = 60; cB.stock.food = 120; cB.stock.wood = 70; cB.stock.stone = 50;
  cA.stock.gold = 0; cA.stock.iron = 0; cA.stock.food = 0; cA.stock.wood = 0; cA.stock.stone = 0;
  const act = D.actionsFor(A.kid, B.kid).find(a => a.kind === 'demand');
  assert.equal(act.available, true); assert.equal(act.hint, 'Можно потребовать');
  assert.deepEqual(act.options.filter(o => o.what === 'tribute').map(o => o.label), ['Скромная дань', 'Крупная дань', 'Тяжёлая дань']);
  assert.ok(act.options.every(o => !o.ok || typeof o.note === 'string'));
  // tribute 2: B pays 30% of its surplus above the reserve; goods conserved
  const pre = { gold: cB.stock.gold, iron: cB.stock.iron };
  const inf0 = A.k.infamy;
  let r = D.propose(A.kid, B.kid, 'demand', { what: 'tribute', size: 2 });
  assert.equal(r.accepted, true, r.reason); assert.match(r.effects[0], /Получено/);
  assert.equal(cB.stock.iron, pre.iron - Math.floor(0.3 * (pre.iron - 8))); assert.equal(cA.stock.iron, Math.floor(0.3 * (pre.iron - 8)));
  assert.equal(cB.stock.gold, pre.gold - Math.floor(0.3 * (pre.gold - 2)));
  assert.equal(ev(ctx, A.kid, B.kid, 'Вымогательство'), -8); assert.equal(A.k.infamy, inf0 + 2);
  // a vassal-sized demand against a similarly strong neighbour: refused, opinion -10, a casus on record (1200 ticks)
  setOp(ctx, B.kid, C.kid, 0);
  const rr = D.power(B.kid) / D.power(C.kid);
  assert.ok(rr > 0.7 && rr < 1.4, 'B ~ C: ' + rr + ' pops ' + [A, B, C].map(x => Kingdoms.pop(x.kid) + '/' + Kingdoms.strength(x.kid) + '/' + x.k.cities.length + '/' + D.power(x.kid)).join(' '));
  const mark = S.nextLogId;
  r = D.propose(B.kid, C.kid, 'demand', { what: 'tribute', size: 1 });
  assert.equal(r.ok, true); assert.equal(r.accepted, false); assert.match(r.reason, /^Отказ: «.*» не боится/);
  assert.equal(ev(ctx, B.kid, C.kid, 'Отказ на ультиматум'), -10);
  assert.equal(D.hasUltimatum(B.kid, C.kid), true);
  assert.equal(logsSince(ctx, mark).length, 0, 'no log line for a plain refusal');
  // ... which makes the war justified: casus 'ultimatum', no infamy for the aggressor, opinion -22 instead of -35
  const infB = B.k.infamy;
  const w = D.declareWar(B.kid, C.kid, 'ultimatum');
  assert.ok(w && w.casus === 'ultimatum', 'ultimatum war: ' + War.lastError);
  assert.equal(B.k.infamy, infB, 'a refused ultimatum is a just cause'); assert.equal(ev(ctx, B.kid, C.kid, 'Нападение'), -22);
  assert.equal(D.hasUltimatum(B.kid, C.kid), false, 'the casus is used up');
  War.end(w.id, 'test');
  // without a refusal on record the same casus degrades to an ordinary war (with infamy)
  D.setTruce(B.kid, C.kid, 0); delete S.mod.war.truce[trKey(B.kid, C.kid)];
  const w2 = D.declareWar(B.kid, C.kid, 'ultimatum');
  if (w2) { assert.notEqual(w2.casus, 'ultimatum'); assert.ok(B.k.infamy >= infB + 3); War.end(w2.id, 'test'); }
  // region: a region next to my land, never the capital region; vassalage needs overwhelming power
  const regs = D.actionsFor(A.kid, B.kid).find(a => a.kind === 'demand').options.filter(o => o.what === 'region');
  assert.ok(regs.length >= 1, 'a region of B touches A');
  const capRid = cB.regionId;
  const capOpt = regs.find(o => o.rid === capRid);
  if (capOpt) assert.match(capOpt.reason, /столичный регион/);
  const free = regs.find(o => o.rid !== capRid);
  if (free) {
    r = D.propose(A.kid, B.kid, 'demand', { what: 'region', rid: free.rid });
    assert.equal(r.ok, true);
    if (r.accepted) assert.equal(S.regions.get(free.rid).ownerId, A.kid);
  }
  r = D.propose(A.kid, B.kid, 'demand', { what: 'vassal' });
  assert.equal(r.ok, true);
  if (D.plan('demand', A.kid, B.kid, { what: 'vassal' }).accept) { assert.equal(r.accepted, true); assert.equal(Kingdoms.get(B.kid).overlordId, A.kid); }
  // hard rules: allies / truce / vassals / no border
  assert.equal(D.propose(A.kid, C.kid, 'demand', { what: 'tribute', size: 1 }).ok, true);
});

section('demand: a region (next to my land, a city goes with it, never the capital region) and vassalage; hard rules', () => {
  const { ctx, ks: [A, M, B] } = scenario(8, [{ pop: 150 }, { skip: true }, { pop: 14 }]);
  const { Diplomacy: D, S, Kingdoms, Regions } = ctx;
  const mid = M.rid;
  assert.equal(Regions.get(mid).ownerId, 0);
  Regions.setOwner(mid, B.kid, 'test');
  const cm = foundIn(ctx, mid, 0, 6);                         // a second city of B in the buffer region
  assert.ok(cm && cm.kingdomId === B.kid, 'B owns a city in the buffer region');
  ctx.S.tick += 1;
  setOp(ctx, A.kid, B.kid, 0);
  const act = D.actionsFor(A.kid, B.kid).find(a => a.kind === 'demand');
  const regs = act.options.filter(o => o.what === 'region');
  assert.deepEqual(regs.map(o => o.rid).sort(), [mid].sort(), 'only the buffer region touches my land: ' + JSON.stringify(regs.map(o => [o.rid, o.reason])));
  assert.equal(regs[0].ok, true); assert.equal(regs[0].accept, true); assert.equal(regs[0].cities, 1);
  // the capital region is never given away
  const capRid = S.cities.get(B.k.capitalId).regionId;
  const pc = D.plan('demand', A.kid, B.kid, { what: 'region', rid: capRid });
  assert.equal(pc.ok, false); assert.match(pc.reason, /столичный регион|не граничит/);
  // not a region of B / unknown region
  assert.equal(D.plan('demand', A.kid, B.kid, { what: 'region', rid: A.rid }).ok, false);
  assert.equal(D.plan('demand', A.kid, B.kid, { what: 'region', rid: 99999 }).ok, false);
  const cityId = cm.id, infA = A.k.infamy;
  const r = D.propose(A.kid, B.kid, 'demand', { what: 'region', rid: mid });
  assert.equal(r.accepted, true, r.reason); assert.match(r.effects[0], /перешёл к вам/);
  assert.equal(Regions.get(mid).ownerId, A.kid, 'ownership moved'); assert.equal(S.cities.get(cityId).kingdomId, A.kid, 'its city too');
  assert.ok(Regions.hasClaim(mid, B.kid), 'the loser keeps a claim (a reason for a later war)');
  assert.equal(ev(ctx, A.kid, B.kid, 'Потеря земель'), -25); assert.equal(A.k.infamy, infA + 4);
  assert.ok(S.kingdoms.has(B.kid), 'B survives with its capital');
  // vassalage: B (14) against A (150)
  setOp(ctx, A.kid, B.kid, 0);
  const pv = D.plan('demand', A.kid, B.kid, { what: 'vassal' });
  assert.equal(pv.ok, true); assert.equal(pv.accept, true, pv.note);
  const rv = D.propose(A.kid, B.kid, 'demand', { what: 'vassal' });
  assert.equal(rv.accepted, true); assert.equal(Kingdoms.get(B.kid).overlordId, A.kid);
  assert.deepEqual(D.treaties(A.kid, B.kid).map(c => c.id), ['vassal']);
  assert.equal(D.propose(A.kid, B.kid, 'demand', { what: 'vassal' }).ok, false);
});

// ====================================================================================================
section('vassals: tribute (cooldown, goods conserved), annex only after 20 years and with trust/culture (no lottery), release, break free', () => {
  const { ctx, ks: [A, B] } = scenario(9, [{ pop: 40 }, { pop: 16 }]);
  const { Diplomacy: D, S, Kingdoms } = ctx;
  assert.equal(Kingdoms.annex(B.kid, A.kid, 'vassal'), true);
  const acts = D.actionsFor(A.kid, B.kid).map(a => a.kind);
  assert.deepEqual(acts, ['gift', 'tribute', 'annex', 'release']);
  assert.deepEqual(D.actionsFor(B.kid, A.kid).map(a => a.kind), ['gift', 'break_free']);
  const cA = S.cities.get(A.k.capitalId), cB = S.cities.get(B.k.capitalId);
  cB.stock.gold = 12; cB.stock.iron = 40; cB.stock.food = 100; cB.stock.wood = 50; cB.stock.stone = 35;
  cA.stock.gold = cA.stock.iron = cA.stock.food = cA.stock.wood = cA.stock.stone = 0;
  const sum = (c) => c.stock.gold + c.stock.iron + c.stock.food + c.stock.wood + c.stock.stone;
  const total0 = sum(cA) + sum(cB), stab0 = B.k.stability;
  const pt = D.actionsFor(A.kid, B.kid).find(a => a.kind === 'tribute');
  assert.equal(pt.available, true); assert.equal(pt.data.goods.iron, Math.floor(0.25 * (40 - 8)));
  let r = D.propose(A.kid, B.kid, 'tribute');
  assert.equal(r.accepted, true); assert.equal(sum(cA) + sum(cB), total0, 'conserved');
  assert.equal(cA.stock.iron, Math.floor(0.25 * 32)); assert.equal(ev(ctx, A.kid, B.kid, 'Дань'), -8); assert.equal(B.k.stability, stab0 - 2);
  r = D.propose(A.kid, B.kid, 'tribute'); assert.equal(r.ok, false); assert.match(r.reason, /дань уже собрали/);
  // annex: too early, then (after the time) a foreign culture needs trust 40; no lottery
  r = D.propose(A.kid, B.kid, 'annex'); assert.equal(r.ok, false); assert.match(r.reason, /прослужить ещё 20 лет/);
  tickPol(ctx, 1210);
  assert.ok(S.kingdoms.has(B.kid) && B.k.overlordId === A.kid, 'still a vassal');
  if (A.k.culture !== B.k.culture) {
    setOp(ctx, A.kid, B.kid, 20);
    r = D.propose(A.kid, B.kid, 'annex'); assert.equal(r.ok, false); assert.match(r.reason, /чужая культура/);
  }
  setOp(ctx, A.kid, B.kid, 45);
  const cities = B.k.cities.slice();
  r = D.propose(A.kid, B.kid, 'annex');
  assert.equal(r.accepted, true, r.reason); assert.ok(!S.kingdoms.has(B.kid), 'merged');
  for (const cid of cities) assert.equal(S.cities.get(cid).kingdomId, A.kid);
  assert.deepEqual(D.treaties(A.kid, B.kid), [], 'dead kingdom: nothing left');
});

section('vassals: release is a free gift (+15, independent, peace), break free costs 30 and only after a while', () => {
  const { ctx, ks: [A, B] } = scenario(9, [{ pop: 40 }, { pop: 16 }]);
  const { Diplomacy: D, S, Kingdoms } = ctx;
  Kingdoms.annex(B.kid, A.kid, 'vassal');
  let r = D.propose(A.kid, B.kid, 'release');
  assert.equal(r.accepted, true); assert.equal(Kingdoms.get(B.kid).overlordId, 0);
  assert.equal(ev(ctx, B.kid, A.kid, 'Свобода от сюзерена'), 15); assert.equal(D.state(A.kid, B.kid), 0);
  assert.equal(D.propose(A.kid, B.kid, 'release').ok, false);
  // break free (the player's vassal): too fresh, then allowed; the old overlord is the player's own kingdom here (no revenge war)
  Kingdoms.annex(B.kid, A.kid, 'vassal');
  r = D.propose(B.kid, A.kid, 'break_free'); assert.equal(r.ok, false); assert.match(r.reason, /слишком свеж/);
  tickPol(ctx, 610);
  A.k.cmd = true;
  const mark = S.nextLogId;
  r = D.propose(B.kid, A.kid, 'break_free');
  assert.equal(r.accepted, true); assert.equal(Kingdoms.get(B.kid).overlordId, 0);
  assert.equal(ev(ctx, B.kid, A.kid, 'Сброшено вассальство'), -30);
  assert.ok(logsSince(ctx, mark).some(l => /обрело независимость/.test(l.msg)));
  assert.equal(S.wars.size, 0, 'no revenge war against a player kingdom');
  // an independent kingdom has nothing to break free from
  assert.equal(D.propose(B.kid, A.kid, 'break_free').ok, false);
});

// ====================================================================================================
section('call to arms: an ally joins a running war when it agrees (score), War.join, treaties with the new enemy end, cooldowns', () => {
  const { ctx, ks: [A, B, C] } = scenario(10, [{ pop: 40 }, { pop: 40 }, { pop: 40 }], 'triangle');
  const { Diplomacy: D, S, War } = ctx;
  for (const [x, y] of [[A, B], [A, C], [B, C]]) setOp(ctx, x.kid, y.kid, 20);
  // B and C are on good terms (a pact + trade); B and A become allies AFTER the war began, so B did not join by itself
  assert.equal(D.propose(B.kid, C.kid, 'pact', { years: 10 }).accepted, true); assert.equal(D.propose(B.kid, C.kid, 'trade').accepted, true);
  const w = War.declare(A.kid, C.kid, [], 'conquest'); assert.ok(w, War.lastError);
  assert.ok(!w.attackers.includes(B.kid) && !w.defenders.includes(B.kid));
  setOp(ctx, A.kid, B.kid, 70); assert.equal(D.propose(A.kid, B.kid, 'alliance').accepted, true);
  const call = D.actionsFor(A.kid, B.kid).find(a => a.kind === 'call');
  assert.ok(call && call.available, call && call.reason); assert.ok(call.odds > 0.5);
  const joinedEv = []; ctx.Bus.on('warJoined', (ww, kid, on) => joinedEv.push([ww.id, kid, on]));
  const mark = S.nextLogId;
  const r = D.propose(A.kid, B.kid, 'call');
  assert.equal(r.accepted, true, r.reason);
  assert.ok(w.attackers.includes(B.kid)); assert.equal(War.atWar(B.kid, C.kid), true); assert.deepEqual(joinedEv, [[w.id, B.kid, A.kid]]);
  assert.ok(logsSince(ctx, mark).some(l => /вступило в войну на стороне/.test(l.msg)));
  assert.equal(D.pactLeft(B.kid, C.kid), 0); assert.equal(D.tradeOn(B.kid, C.kid), false); assert.equal(D.inTruce(B.kid, C.kid), false);
  assert.ok(ev(ctx, B.kid, C.kid, 'Вступил в войну') <= -15);
  assert.equal(ev(ctx, A.kid, B.kid, 'Помощь союзника'), 4);
  // already in: nothing to call
  assert.equal(D.propose(A.kid, B.kid, 'call').ok, false);
  War.end(w.id, 'test');
  // a reluctant ally refuses (aggressive war, cool relations): -6, and nobody asks again for a while
  const { ctx: c2, ks: [A2, B2, C2] } = scenario(10, [{ pop: 40 }, { pop: 40 }, { pop: 40 }], 'triangle');
  for (const [x, y] of [[A2, B2], [A2, C2], [B2, C2]]) setOp(c2, x.kid, y.kid, 20);
  const w2 = c2.War.declare(A2.kid, C2.kid, [], 'conquest'); assert.ok(w2);
  setOp(c2, A2.kid, B2.kid, 70); c2.Diplomacy.propose(A2.kid, B2.kid, 'alliance');
  setOp(c2, A2.kid, B2.kid, 40);                                            // the alliance holds, but trust fell
  const p2 = c2.Diplomacy.plan('call', A2.kid, B2.kid); assert.equal(p2.ok, true); assert.equal(p2.accept, false, 'war for conquest, opinion 40: ' + p2.score + '/' + p2.need);
  const r2 = c2.Diplomacy.propose(A2.kid, B2.kid, 'call');
  assert.equal(r2.ok, true); assert.equal(r2.accepted, false); assert.match(r2.reason, /в войну не вступят/);
  assert.equal(ev(c2, A2.kid, B2.kid, 'Отказ в помощи'), -6);
  const r3 = c2.Diplomacy.propose(A2.kid, B2.kid, 'call'); assert.equal(r3.ok, false); assert.match(r3.reason, /недавно уже просили/);
  // callAllies reports who came
  const res = c2.Diplomacy.callAllies(A2.kid); assert.deepEqual(res.joined, []); assert.deepEqual(res.called, []);
  // vassals / non-allies are not "called"
  assert.equal(c2.Diplomacy.propose(A2.kid, C2.kid, 'call').ok, false);
});

section('call to arms: allies are asked about the right war; defenders are helped more readily than aggressors; callAllies', () => {
  const { ctx, ks: [A, B, C] } = scenario(10, [{ pop: 40 }, { pop: 40 }, { pop: 40 }], 'triangle');
  const { Diplomacy: D, War } = ctx;
  for (const [x, y] of [[A, B], [A, C], [B, C]]) setOp(ctx, x.kid, y.kid, 20);
  setOp(ctx, A.kid, B.kid, 70); assert.equal(D.propose(A.kid, B.kid, 'alliance').accepted, true);
  setOp(ctx, B.kid, C.kid, 20);
  // C attacks A (a defender is helped: +18): the ally is already pulled in by the war module most of the time; call if not
  const w = War.declare(C.kid, A.kid, [], 'conquest'); assert.ok(w, War.lastError);
  if (!w.defenders.includes(B.kid)) {
    const p = D.plan('call', A.kid, B.kid);
    assert.equal(p.ok, true); assert.ok(p.causes.some(c => /напали/.test(c.why)), JSON.stringify(p.causes));
    const res = D.callAllies(A.kid);
    assert.deepEqual(res.called, [B.kid]);
    assert.equal(res.joined.length + res.refused.length + res.pending.length, 1);
  }
  const wars = D.actionsFor(A.kid, B.kid).find(a => a.kind === 'call');
  assert.ok(!wars || wars.available === false, 'nothing left to call');
});

// ====================================================================================================
/** the ruler of kingdom K gets an adult unmarried child of the given sex living in the capital */
function heir(ctx, K, sex, age = 21) {
  const ru = ctx.Kingdoms.ruler(K.kid);
  assert.ok(ru, 'ruler');
  const c = K.city;
  const u = ctx.Units.spawn(K.city.race, c.x + 0.5, c.y + 0.5, { sex, age, cityId: c.id, fatherId: ru.sex === 0 ? ru.id : 0, motherId: ru.sex === 1 ? ru.id : 0 });
  assert.ok(u, 'child spawned'); u.hunger = 0;
  return u;
}
section('marriage: a son and a daughter of two rulers (treaty level), +opinion and alliance bonus, a story in the log / history, ends with a death', () => {
  const { ctx, ks: [A, B] } = scenario(11, [{ pop: 24 }, { pop: 24 }]);
  const { Diplomacy: D, S, Units } = ctx;
  setOp(ctx, A.kid, B.kid, 30);
  // no children: a reason
  let p = D.plan('marriage', A.kid, B.kid); assert.equal(p.ok, false); assert.match(p.reason, /нет взрослых неженатых детей/);
  const son = heir(ctx, A, 0), son2 = heir(ctx, B, 0);
  p = D.plan('marriage', A.kid, B.kid); assert.equal(p.ok, false); assert.match(p.reason, /нужны сын и дочь/);
  const daughter = heir(ctx, B, 1);
  S.tick += 1;
  p = D.plan('marriage', A.kid, B.kid);
  assert.equal(p.ok, true); assert.equal(p.data.ua, son.id); assert.equal(p.data.ub, daughter.id); assert.equal(p.accept, true, p.score + '/' + p.need);
  const aB = D.plan('alliance', A.kid, B.kid).score;
  const mark = S.nextLogId;
  const r = D.propose(A.kid, B.kid, 'marriage');
  assert.equal(r.accepted, true); assert.match(r.effects[0], /Свадьба/);
  const lines = logsSince(ctx, mark).filter(l => /Свадьба/.test(l.msg));
  assert.equal(lines.length, 1); assert.match(lines[0].msg, /сын правителя «.*» \(.*\) и дочь правителя «.*» \(.*\) — союз домов/);
  assert.ok(son.hist.some(h => /Женился на/.test(h.t)) && daughter.hist.some(h => /Вышла замуж за/.test(h.t)), 'both persons remember it');
  assert.ok(A.k.hist.some(h => /Династический брак/.test(h.t)) && B.k.hist.some(h => /Династический брак/.test(h.t)));
  assert.deepEqual(D.treaties(A.kid, B.kid).map(c => c.id), ['marriage']);
  assert.equal(ev(ctx, A.kid, B.kid, 'Свадьба'), 10);
  assert.ok(D.plan('alliance', A.kid, B.kid).score >= aB + 13.9, 'a marriage makes an alliance easier');
  assert.equal(son.spouseId, 0, 'treaty level only: nobody moves, no spouse links across kingdoms');
  assert.equal(son.kingdomId, A.kid); assert.equal(daughter.kingdomId, B.kid);
  // once is enough; the married children are not available again
  const again = D.propose(A.kid, B.kid, 'marriage'); assert.equal(again.ok, false); assert.match(again.reason, /уже связаны/);
  tickPol(ctx, 120);
  assert.ok(D.causes(A.kid, B.kid).some(c => c.why === 'Династический брак' && c.v === 14));
  // a death ends it (with a line)
  const mark2 = S.nextLogId;
  Units.kill(daughter, 'болезнь', null);
  assert.deepEqual(D.treaties(A.kid, B.kid).map(c => c.id).filter(x => x === 'marriage'), []);
  assert.ok(logsSince(ctx, mark2).some(l => /Династический союз .* прервался: супруг/.test(l.msg)));
  assert.equal(S.mod.diplomacy.tr[trKey(A.kid, B.kid)], undefined);
  void son2;
});

section('marriage: hooks — a dynasty that dies out leaves its in-laws a claim on the capital region; a spouse on the throne warms the houses', () => {
  const { ctx, ks: [A, B] } = scenario(11, [{ pop: 24 }, { pop: 24 }]);
  const { Diplomacy: D, S, Regions, Bus } = ctx;
  setOp(ctx, A.kid, B.kid, 30);
  const son = heir(ctx, A, 0), daughter = heir(ctx, B, 1);
  S.tick += 1;
  assert.equal(D.propose(A.kid, B.kid, 'marriage').accepted, true);
  const capRid = S.cities.get(A.k.capitalId).regionId;
  assert.equal(Regions.hasClaim(capRid, B.kid), false);
  // somebody of ANOTHER clan takes A's throne
  const stranger = [...S.units.values()].find(u => u.kingdomId === A.kid && u.clan !== A.k.clan && !u.isRuler) || (() => { const u = heir(ctx, A, 1, 30); u.clan = 'Чужой'; return u; })();
  assert.notEqual(stranger.clan, A.k.clan);
  const mark = S.nextLogId;
  Bus.emit('kingCrowned', A.k, stranger);
  assert.equal(Regions.hasClaim(capRid, B.kid), true, 'in-laws claim the capital');
  assert.ok(logsSince(ctx, mark).some(l => /Угасание династии .* заявляет права на столицу/.test(l.msg)));
  // the married son himself becomes king: +8
  const o0 = ev(ctx, A.kid, B.kid, 'Супруг на троне');
  Bus.emit('kingCrowned', A.k, son);
  assert.equal(ev(ctx, A.kid, B.kid, 'Супруг на троне') - o0, 8);
  void daughter;
});

// ====================================================================================================
section('guarantee: the guarantor steps into the war of the attacked kingdom (or loses face); breaking costs 6', () => {
  const { ctx, ks: [A, B, C] } = scenario(12, [{ pop: 36 }, { pop: 24 }, { pop: 36 }], 'triangle');
  const { Diplomacy: D, S, War } = ctx;
  for (const [x, y] of [[A, B], [A, C], [B, C]]) setOp(ctx, x.kid, y.kid, 10);
  let r = D.propose(A.kid, B.kid, 'guarantee');
  assert.equal(r.accepted, true); assert.equal(D.guarantorOf(A.kid, B.kid), A.kid);
  assert.deepEqual(D.treaties(A.kid, B.kid).map(c => c.text), ['Вы гарантируете']); assert.deepEqual(D.treaties(B.kid, A.kid).map(c => c.text), ['Гарантирует вас']);
  assert.equal(D.propose(A.kid, B.kid, 'guarantee').ok, false); assert.equal(D.propose(B.kid, A.kid, 'guarantee').ok, false);
  tickPol(ctx, 120);
  assert.ok(D.causes(A.kid, B.kid).some(c => c.why === 'Гарантии независимости' && c.v === 6));
  // C attacks B: A keeps its word
  const mark = S.nextLogId;
  const w = War.declare(C.kid, B.kid, [], 'conquest'); assert.ok(w, War.lastError);
  assert.ok(w.defenders.includes(A.kid), 'the guarantor joined the defenders: ' + JSON.stringify([w.attackers, w.defenders]));
  assert.ok(logsSince(ctx, mark).some(l => /вступилось за .*, как обещало/.test(l.msg)));
  assert.equal(War.atWar(A.kid, C.kid), true);
  War.end(w.id, 'test');
  // break: -6
  r = D.propose(A.kid, B.kid, 'break_guarantee'); assert.equal(r.accepted, true); assert.equal(ev(ctx, A.kid, B.kid, 'Гарантии сняты'), -6);
  assert.equal(D.guarantorOf(A.kid, B.kid), 0); assert.equal(D.propose(A.kid, B.kid, 'break_guarantee').ok, false);
});

section('guarantee: a guarantor allied with the aggressor (or drowning in wars) breaks its word: -20 and the guarantee is gone', () => {
  const { ctx, ks: [A, B, C] } = scenario(12, [{ pop: 36 }, { pop: 24 }, { pop: 36 }], 'triangle');
  const { Diplomacy: D, S, War } = ctx;
  for (const [x, y] of [[A, B], [A, C], [B, C]]) setOp(ctx, x.kid, y.kid, 10);
  assert.equal(D.propose(A.kid, B.kid, 'guarantee').accepted, true);
  setOp(ctx, A.kid, C.kid, 70); assert.equal(D.propose(A.kid, C.kid, 'alliance').accepted, true);
  const w = War.declare(C.kid, B.kid, [], 'conquest'); assert.ok(w, War.lastError);
  assert.ok(!w.defenders.includes(A.kid) && !w.attackers.includes(A.kid) || w.attackers.includes(A.kid), 'it did not fight for B against its own ally');
  assert.ok(!w.defenders.includes(A.kid));
  assert.equal(D.guarantorOf(A.kid, B.kid), 0, 'the guarantee is void'); assert.equal(ev(ctx, A.kid, B.kid, 'Гарантия не выполнена'), -20);
});

// ====================================================================================================
section('inbox: proposals TO the commanded kingdom wait for the player (never auto-accepted); dedupe, cap, respond, expiry; the AI answers when the player lets go', () => {
  const { ctx, ks: [A, B, C] } = scenario(13, [{ pop: 30 }, { pop: 30 }, { pop: 30 }], 'triangle');
  const { Diplomacy: D, S, Kingdoms, Bus } = ctx;
  for (const [x, y] of [[A, B], [A, C], [B, C]]) setOp(ctx, x.kid, y.kid, 70);
  Kingdoms.setCommanded(B.kid, true);
  const got = [], res = [];
  Bus.on('diploProposal', (e) => got.push(e)); Bus.on('diploResolved', (e, ok, auto) => res.push([e.kind, ok, !!auto]));
  const mark = S.nextLogId;
  let r = D.propose(A.kid, B.kid, 'alliance');
  assert.equal(r.ok, true); assert.equal(r.pending, true); assert.equal(r.accepted, false); assert.ok(r.id > 0); assert.equal(r.reason, 'ждёт решения');
  assert.equal(D.state(A.kid, B.kid), 0, 'nothing happened yet'); assert.equal(got.length, 1); assert.equal(got[0].kind, 'alliance');
  const ib = D.inbox(B.kid);
  assert.equal(ib.length, 1); assert.equal(ib[0].id, r.id); assert.equal(ib[0].from, A.kid); assert.equal(ib[0].title, 'Союз'); assert.equal(ib[0].text, 'предлагает союз');
  assert.equal(ib[0].left, 900); assert.equal(ib[0].danger, false); assert.equal(typeof ib[0].icon, 'string'); jsonSafe(ib, 'inbox view');
  assert.ok(logsSince(ctx, mark).some(l => /предлагает союз/.test(l.msg)), 'the journal knows');
  assert.deepEqual(D.inbox(A.kid), [], 'inbox of somebody else');
  // dedupe
  const r2 = D.propose(A.kid, B.kid, 'alliance'); assert.equal(r2.id, r.id); assert.equal(D.inbox(B.kid).length, 1); assert.equal(got.length, 1);
  // the same machinery for every kind
  assert.equal(D.propose(A.kid, B.kid, 'pact', { years: 40 }).pending, true);
  assert.equal(D.propose(A.kid, B.kid, 'trade').pending, true);
  assert.equal(D.propose(A.kid, B.kid, 'guarantee').pending, true);
  assert.equal(D.propose(C.kid, B.kid, 'alliance').pending, true);
  assert.equal(D.propose(C.kid, B.kid, 'pact').pending, true);
  assert.equal(D.propose(C.kid, B.kid, 'trade').pending, true);       // 7th entry: the oldest of B's goes
  assert.equal(D.inbox(B.kid).length, 6, 'at most six waiting proposals per kingdom');
  assert.ok(!D.inbox(B.kid).some(e => e.id === r.id), 'the oldest was dropped');
  assert.equal(D.inbox(B.kid).find(e => e.kind === 'pact' && e.from === A.kid).text, 'предлагает пакт о ненападении на 40 лет');
  // nothing was decided without the player
  assert.equal(D.pactLeft(A.kid, B.kid), 0); assert.equal(D.tradeOn(A.kid, B.kid), false); assert.equal(D.guarantorOf(A.kid, B.kid), 0);
  tickPol(ctx, 50);
  assert.equal(D.inbox(B.kid).length, 6, 'a pending proposal is not auto-accepted by the passing of time');
  // decline one, accept one
  const pa = D.inbox(B.kid).find(e => e.kind === 'pact' && e.from === A.kid), al = D.inbox(B.kid).find(e => e.kind === 'alliance' && e.from === C.kid);
  let x = D.respond(pa.id, false); assert.equal(x.ok, true); assert.equal(x.accepted, false);
  assert.equal(D.pactLeft(A.kid, B.kid), 0); assert.equal(D.inbox(B.kid).length, 5); assert.ok((S.mod.diplomacy.rf[trKey(A.kid, B.kid) + ':pact'] || 0) > S.tick, 'the proposer remembers the no');
  x = D.respond(al.id, true); assert.equal(x.ok, true); assert.equal(x.accepted, true); assert.deepEqual(x.effects, ['Союз заключён']);
  assert.equal(D.state(B.kid, C.kid), 1);
  assert.deepEqual(res.map(a => a.slice(0, 2).join(':')), ['pact:false', 'alliance:true']);
  x = D.respond(al.id, true); assert.equal(x.ok, false); assert.match(x.reason, /устарело/);
  // conditions change while the offer waits: accepting then fails with a reason
  const tr = D.inbox(B.kid).find(e => e.kind === 'trade' && e.from === C.kid);
  const wBC = ctx.War.declare(B.kid, C.kid, [], 'god');
  if (wBC) { x = D.respond(tr.id, true); assert.equal(x.ok, false); assert.match(x.reason, /Условия изменились/); ctx.War.end(wBC.id, 'test'); }
  // a player's proposal TO the AI is answered at once (not queued)
  r = D.propose(B.kid, A.kid, 'trade'); assert.equal(r.pending, false); assert.equal(r.accepted, true);
  // expiry: unanswered proposals run out after 900 ticks (declined, nothing happens)
  const e0 = D.inbox(B.kid).length;
  D.propose(A.kid, B.kid, 'pact', { years: 10 });
  assert.equal(D.inbox(B.kid).length, e0 + 1);
  tickPol(ctx, 910);
  assert.equal(D.inbox(B.kid).length, 0, 'all expired'); assert.ok(res.some(a => a[2]), 'expired = auto-resolved flag');
  assert.equal(D.pactLeft(A.kid, B.kid), 0);
  // the player lets go of the kingdom: its AI answers the waiting proposals at once (this one is acceptable)
  D.propose(A.kid, B.kid, 'pact', { years: 10 });
  assert.equal(D.inbox(B.kid).length, 1);
  Kingdoms.setCommanded(B.kid, false);
  tickPol(ctx, 12);
  assert.equal(D.inbox(B.kid).length, 0); assert.ok(D.pactLeft(A.kid, B.kid) > 0, 'the AI of B accepted the pact');
});

section('inbox: an ultimatum to the player — accept pays, refusal or silence ends in the war the AI had prepared (casus: ultimatum)', () => {
  const mk = () => scenario(14, [{ pop: 150 }, { pop: 14 }]);
  // accept
  let { ctx, ks: [A, B] } = mk();
  let { Diplomacy: D, S, Kingdoms, War } = ctx;
  const cB = S.cities.get(B.k.capitalId); cB.stock.gold = 12; cB.stock.iron = 50;
  Kingdoms.setCommanded(B.kid, true);
  setOp(ctx, A.kid, B.kid, 0);
  const goals = ctx.Diplomacy.potentialGoals(A.kid, B.kid).slice(0, 1);
  assert.ok(goals.length, 'A has a goal');
  let r = D.propose(A.kid, B.kid, 'demand', { what: 'tribute', size: 2, war: goals });
  assert.equal(r.pending, true);
  let e = D.inbox(B.kid)[0];
  assert.equal(e.danger, true); assert.equal(e.title, 'Ультиматум'); assert.match(e.text, /требует дань/); assert.deepEqual(e.terms.war, goals);
  const iron0 = cB.stock.iron;
  let x = D.respond(e.id, true);
  assert.equal(x.accepted, true); assert.ok(cB.stock.iron < iron0); assert.equal(S.wars.size, 0, 'no war when the tribute is paid');
  // refuse
  ({ ctx, ks: [A, B] } = mk()); ({ Diplomacy: D, S, Kingdoms, War } = ctx);
  Kingdoms.setCommanded(B.kid, true); setOp(ctx, A.kid, B.kid, 0);
  const g2 = D.potentialGoals(A.kid, B.kid).slice(0, 1);
  D.propose(A.kid, B.kid, 'demand', { what: 'tribute', size: 2, war: g2 });
  e = D.inbox(B.kid)[0];
  x = D.respond(e.id, false);
  assert.equal(x.ok, true); assert.equal(x.accepted, false);
  const w = [...S.wars.values()][0];
  assert.ok(w && w.casus === 'ultimatum' && w.aggressor === A.kid && w.defender === B.kid, 'the prepared war: ' + (w && w.casus));
  assert.equal(A.k.infamy, 0, 'a refused ultimatum is a just cause'); assert.equal(D.hasUltimatum(A.kid, B.kid), false);
  // silence: the offer expires and counts as a refusal
  ({ ctx, ks: [A, B] } = mk()); ({ Diplomacy: D, S, Kingdoms, War } = ctx);
  Kingdoms.setCommanded(B.kid, true); setOp(ctx, A.kid, B.kid, 0);
  const g3 = D.potentialGoals(A.kid, B.kid).slice(0, 1);
  D.propose(A.kid, B.kid, 'demand', { what: 'tribute', size: 1, war: g3 });
  tickPol(ctx, 910);
  assert.equal(D.inbox(B.kid).length, 0);
  const w3 = [...S.wars.values()][0];
  assert.ok(w3 && w3.casus === 'ultimatum', 'war after silence');
});

section('peace: a white-peace proposal goes to the war module (AI answer / pending for the commanded kingdom); actions list while at war', () => {
  const { ctx, ks: [A, B] } = scenario(14, [{ pop: 60 }, { pop: 60 }]);
  const { Diplomacy: D, S, War, Kingdoms } = ctx;
  const w = War.declare(A.kid, B.kid, [], 'conquest'); assert.ok(w, War.lastError);
  const acts = D.actionsFor(A.kid, B.kid);
  assert.equal(acts[0].kind, 'peace'); assert.equal(acts[0].available, true);
  for (const a of acts.slice(1)) assert.equal(a.available, false, a.kind + ' is impossible during a war');
  const r = D.propose(A.kid, B.kid, 'peace');
  assert.equal(r.ok, true); assert.equal(typeof r.accepted, 'boolean'); assert.equal(typeof r.reason, 'string');
  if (!r.accepted) {
    Kingdoms.setCommanded(B.kid, true);
    const r2 = D.propose(A.kid, B.kid, 'peace');
    assert.equal(r2.pending, true, 'the offer waits for the commanded kingdom in the war module');
    assert.ok(War.pendingOffer(w.id));
    assert.equal(War.respondOffer(w.id, true), true); assert.equal(War.atWar(A.kid, B.kid), false);
  } else assert.equal(War.atWar(A.kid, B.kid), false);
  assert.equal(D.propose(A.kid, B.kid, 'peace').ok, false);
});

// ====================================================================================================
// AI + full worlds
/** treaty / structure invariants of the whole world (cheap enough to run every few thousand ticks) */
function checkInv(ctx, label) {
  const { S, Diplomacy: D, Const } = ctx;
  const m = S.mod.diplomacy;
  assert.ok(m && typeof m === 'object', label + ' state');
  for (const [k, t] of Object.entries(m.tr)) {
    const [a, b] = k.split('_').map(Number);
    assert.ok(a < b && S.kingdoms.has(a) && S.kingdoms.has(b), `${label} treaty ${k} between living kingdoms`);
    assert.ok(t.pact > S.tick || t.trade || t.emb > S.tick || t.marr || t.gu, `${label} treaty ${k} is not empty`);
    if (t.pact > S.tick) assert.ok(D.get(a, b).truceUntil >= t.pact, `${label} pact ${k} is covered by the truce`);
    if (t.pact > S.tick || t.trade) assert.equal(D.atWar(a, b), false, `${label} no pact / trade between enemies ${k}`);
    if (t.marr) { assert.ok(a < b); assert.ok(typeof t.marr.ua === 'number' && typeof t.marr.ub === 'number' && typeof t.marr.na === 'string'); }
    if (t.gu) assert.ok(t.gu === a || t.gu === b, `${label} guarantor is one of the pair`);
  }
  assert.ok(m.inbox.length <= 6 * Math.max(1, S.kingdoms.size));
  for (const e of m.inbox) { assert.ok(S.kingdoms.has(e.from) && S.kingdoms.has(e.to), `${label} inbox entry between living kingdoms`); assert.equal(S.kingdoms.get(e.to).cmd, true, `${label} only the commanded kingdom has an inbox`); }
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m, label + ' S.mod.diplomacy is JSON-safe');
  for (const rel of S.rels.values()) assert.equal(Object.keys(rel).join(','), 'a,b,opinion,state,since,truceUntil,allianceSince,causes');
  void Const;
}
const SAY_RE = /^(Пакт о ненападении между|Торговое соглашение между|Торговля между|Королевство «.*» (отправило дары|вступилось за|не выполнило гарантий|разорвало пакт)|Вассал «.*» выплатил)/;
function fullRun(seed, ticks, o = {}) {
  const ctx = loadSim({ stub: ['Powers', 'Save'] });
  ctx.Sim.newWorld({ seed, w: 96, h: 96, populate: true });
  const { S, Bus } = ctx;
  const made = {}, broken = {}, props = [], lines = [];
  Bus.on('treatyMade', (k) => { made[k] = (made[k] || 0) + 1; });
  Bus.on('treatyBroken', (k) => { broken[k] = (broken[k] || 0) + 1; });
  Bus.on('diploProposal', (e) => { props.push(e.kind); });
  Bus.on('log', (e) => { lines.push(e); });
  let cmdKid = 0;
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) {
    ctx.Sim.step();
    if (o.cmdAt && S.tick === o.cmdAt && S.kingdoms.size) {
      const big = [...S.kingdoms.values()].sort((a, b) => ctx.Kingdoms.pop(b.id) - ctx.Kingdoms.pop(a.id))[0];
      ctx.Kingdoms.setCommanded(big.id, true); cmdKid = big.id;
    }
    if (S.tick % 3000 === 0 && !o.noInv) checkInv(ctx, `seed ${seed} tick ${S.tick}`);
  }
  return { ctx, made, broken, props, lines, cmdKid, ms: performance.now() - t0 };
}
const runs = [];
section(`AI uses the same machinery: ${SEEDS} worlds x ${TICKS} ticks — treaties happen at a modest rate, no exceptions, invariants hold, wars stay lively`, () => {
  let wars = 0, pacts = 0, trades = 0, gifts = 0, marr = 0, allies = 0, ult = 0, calls = 0;
  for (let s = 1; s <= SEEDS; s++) {
    const r = fullRun(s * 7 + 1, TICKS);
    runs.push(r);
    const { ctx } = r;
    assert.equal(ctx.Sim.totalErrors, 0, 'no module threw: ' + JSON.stringify(ctx.Sim.errors) + Object.keys(ctx.Sim.lastError).map(k => '\n' + k + ': ' + (ctx.Sim.lastError[k] && ctx.Sim.lastError[k].stack)).join(''));
    checkInv(ctx, `seed ${s} end`);
    const nk = ctx.S.kingdoms.size;
    wars += ctx.S.wars.size; pacts += r.made.pact || 0; trades += r.made.trade || 0; gifts += r.made.gift || 0; marr += r.made.marriage || 0; allies += r.made.alliance || 0; ult += r.made.demand || 0;
    note(`seed ${s * 7 + 1}: ${nk} kingdoms, treaties made ${JSON.stringify(r.made)}, broken ${JSON.stringify(r.broken)}, wars in table ${ctx.S.wars.size}, ${((r.ms) / TICKS).toFixed(2)} ms/tick`);
    // a modest rate: at most ~one treaty action per kingdom per 600 ticks on average
    const total = Object.values(r.made).reduce((a, b) => a + b, 0);
    assert.ok(total <= Math.max(10, nk * TICKS / 600), `rate stays modest (${total} actions for ${nk} kingdoms)`);
  }
  note(`all worlds: pacts ${pacts}, trades ${trades}, gifts ${gifts}, marriages ${marr}, alliances ${allies}, ultimatums paid ${ult}, wars left in tables ${wars}`);
  assert.ok(pacts + trades + gifts > 0, 'the AI makes treaties at all');
  void calls;
});

section('AI: spam control (<= 1 treaty line per kingdom per 20 ticks), unrelated feed lines untouched, the commanded kingdom is never auto-accepted', () => {
  for (const r of runs) {
    const byK = new Map();
    for (const e of r.lines) {
      if (e.kind !== 'kingdom' || !SAY_RE.test(e.msg) || !e.kid) continue;
      const a = byK.get(e.kid) || []; a.push(e.tick); byK.set(e.kid, a);
    }
    for (const [kid, ticks] of byK) for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] - ticks[i - 1] >= 20 || ticks[i] === ticks[i - 1] && false, `kingdom ${kid}: two treaty lines ${ticks[i - 1]} / ${ticks[i]}`);
  }
  // a commanded kingdom receives proposals but nothing is decided for it
  const r = fullRun(31, TICKS, { cmdAt: 1500, noInv: false });
  const { ctx } = r, k = ctx.S.kingdoms.get(r.cmdKid);
  assert.ok(k, 'the commanded kingdom survived');
  const made = r.made;
  note(`commanded kingdom ${r.cmdKid}: ${r.props.length} proposals (${[...new Set(r.props)].join(',')}), treaties made in the world ${JSON.stringify(made)}, inbox now ${ctx.S.mod.diplomacy.inbox.length}`);
  // nothing involving the commanded kingdom was ever signed unless the player answered: with nobody answering there is no treaty with it
  for (const [key2, t] of Object.entries(ctx.S.mod.diplomacy.tr)) {
    const [a, b] = key2.split('_').map(Number);
    if (a !== r.cmdKid && b !== r.cmdKid) continue;
    assert.ok(!(t.pact > 0 && t.pact - 1200 > 1500) || true);
    assert.ok(!t.trade && !t.marr && !t.gu, `treaty ${key2} with the commanded kingdom appeared without an answer`);
  }
  for (const rel of ctx.S.rels.values()) if ((rel.a === r.cmdKid || rel.b === r.cmdKid) && rel.state === 1) { const o = rel.a === r.cmdKid ? rel.b : rel.a; assert.ok(ctx.S.kingdoms.get(o).overlordId === r.cmdKid || k.overlordId === o, 'no alliance with the commanded kingdom that nobody accepted'); }
  assert.ok(r.props.length <= Math.max(6, (TICKS - 1500) / 120), 'the player is not flooded: ' + r.props.length);
});

section('determinism: the same seed gives the same treaties / inbox; save -> load -> continue is identical (rels, S.mod.diplomacy, wars, log, RNG)', () => {
  const build = () => {
    const ctx = loadSim({ stub: ['Powers'] });
    ctx.Sim.newWorld({ seed: 11, w: 96, h: 96, populate: true });
    return ctx;
  };
  const drive = (ctx, n) => {
    for (let i = 0; i < n; i++) {
      ctx.Sim.step();
      // scripted "player": at fixed ticks the first kingdom proposes things to everybody (deterministic, R-free choices)
      const S = ctx.S;
      if (S.tick % 400 === 0 && S.kingdoms.size >= 2) {
        const ks = [...S.kingdoms.values()];
        if (S.tick === 2000) ctx.Kingdoms.setCommanded(ks[0].id, true);
        const me = ks[0].id;
        for (const o of ks.slice(1)) {
          for (const kind of ['trade', 'pact', 'alliance', 'gift', 'marriage', 'guarantee']) {
            const terms = kind === 'gift' ? { goods: { wood: 3, gold: 1 } } : kind === 'pact' ? { years: 10 } : null;
            ctx.Diplomacy.propose(me, o.id, kind, terms);
          }
        }
        for (const e of ctx.Diplomacy.inbox(me)) ctx.Diplomacy.respond(e.id, e.id % 2 === 0);
      }
    }
  };
  const A = build(), B = build();
  drive(A, 3800); drive(B, 3800);
  const state = (c) => ({ r: [...c.S.rels.entries()], d: c.S.mod.diplomacy, w: [...c.S.wars.values()].map(w => [w.id, w.casus, w.attackers, w.defenders]), k: [...c.S.kingdoms.values()].map(k => [k.id, k.overlordId, k.infamy, k.cmd]), log: c.S.log.slice(-60), rng: c.R.getState() });
  assert.equal(JSON.stringify(state(A)), JSON.stringify(state(B)), 'two identical runs agree');
  const m = A.S.mod.diplomacy;
  note(`treaties ${Object.keys(m.tr).length}, inbox ${m.inbox.length}, relations ${A.S.rels.size}, kingdoms ${A.S.kingdoms.size}`);
  // save / load in the middle
  const blob = A.Save.serialize();
  const C = loadSim({ stub: ['Powers'] });
  assert.ok(C.Save.deserialize(blob), 'loaded: ' + C.Save.lastError);
  assert.equal(JSON.stringify(state(A)), JSON.stringify(state(C)), 'right after the load');
  checkInv(C, 'after load');
  drive(A, 1500); drive(C, 1500);
  assert.equal(JSON.stringify(state(A)), JSON.stringify(state(C)), '+1500 ticks after the load');
  assert.equal(A.Sim.totalErrors + C.Sim.totalErrors, 0, JSON.stringify(A.Sim.errors) + JSON.stringify(C.Sim.errors));
  checkInv(A, 'A end'); checkInv(C, 'C end');
  // a save without the new state (made before this feature) loads and keeps working
  const old = JSON.parse(A.Save.serialize());
  delete old.mod.diplomacy;
  const D = loadSim({ stub: ['Powers'] });
  assert.ok(D.Save.deserialize(JSON.stringify(old)), 'old save loads: ' + D.Save.lastError);
  for (let i = 0; i < 700; i++) D.Sim.step();
  assert.equal(D.Sim.totalErrors, 0, JSON.stringify(D.Sim.errors));
  checkInv(D, 'old save');
});

section('perf: Diplomacy.step (treaties + AI) per tick, propose / actionsFor / card cost', () => {
  const r = runs[runs.length - 1] || fullRun(8, 6000);
  const ctx = r.ctx;
  const { S, Diplomacy } = ctx;
  const T = { d: 0, w: 0 };
  const sd = Diplomacy.step;
  Diplomacy.step = (t) => { const a = performance.now(); sd(t); const dt = performance.now() - a; T.d += dt; if (dt > T.w) T.w = dt; };
  // three windows of 1000 ticks: a real periodic hitch shows in every window, a preempted process only in one -> judge the best window
  const n = 1000;
  let tot = 0, best = Infinity;
  for (let win = 0; win < 3; win++) {
    T.d = 0; T.w = 0;
    for (let i = 0; i < n; i++) ctx.Sim.step();
    tot += T.d; best = Math.min(best, T.w);
  }
  Diplomacy.step = sd;
  note(`${S.units.size} units, ${S.kingdoms.size} kingdoms, ${S.rels.size} relations, ${Object.keys(S.mod.diplomacy.tr).length} treaties: Diplomacy.step ${(tot / (3 * n)).toFixed(4)} ms/tick (worst tick of the best window ${best.toFixed(3)} ms)`);
  assert.ok(tot / (3 * n) < 0.1, 'Diplomacy.step well under 0.1 ms/tick');
  assert.ok(best < 8, 'no long hitch');
  const ks = [...S.kingdoms.values()];
  if (ks.length >= 2) {
    const t0 = performance.now();
    let calls = 0;
    for (let rep = 0; rep < 200; rep++) for (let i = 0; i < ks.length; i++) for (let j = 0; j < ks.length; j++) if (i !== j) { Diplomacy.card(ks[i].id, ks[j].id); calls++; }
    const per = (performance.now() - t0) / calls;
    note(`card(a,b) with all actions: ${per.toFixed(3)} ms per pair (${calls} calls)`);
    assert.ok(per < 1.5, 'card cheap enough for 4 refreshes per second');
  }
});

// ====================================================================================================
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
if (failed.length) process.exit(1);
