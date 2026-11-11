// Helpers for the TOTAL WAR tests / experiments (headless): hand-built worlds with an attacker A and a defender country B on a chain of regions.
//   import { mkCtx, run, feed, tarena, ... } from './twlib.mjs';
import { loadSim, stepN, newWorld } from './harness.mjs';

/** headless world: real World / Buildings / Units / Cities / Kingdoms / Regions / Diplomacy / War / Sim; Powers + Save stubbed unless asked */
export function mkCtx(seed = 1, stub = ['Powers', 'Save'], size = 96) {
  const ctx = loadSim({ stub });
  newWorld(ctx, seed, size, size);
  return ctx;
}
/** keep the economy out of the picture: stocks stay high so nobody starves while the armies fight */
export function feed(ctx) {
  for (const c of ctx.S.cities.values()) {
    c.stock.food = Math.max(c.stock.food, 160); c.stock.wood = Math.max(c.stock.wood, 60);
    c.stock.iron = Math.max(c.stock.iron, 30); c.stock.stone = Math.max(c.stock.stone, 30); c.stock.gold = Math.max(c.stock.gold, 6);
  }
}
export function run(ctx, n, hook, every = 25) {
  for (let i = 0; i < n; i++) {
    stepN(ctx, 1);
    if (ctx.S.tick % 50 === 0) feed(ctx);
    if (hook && ctx.S.tick % every === 0) { const r = hook(ctx.S.tick); if (r === false) return false; }
  }
  return true;
}
export function siteIn(ctx, rid, race, away) {
  const { S, Cities } = ctx;
  const r = S.regions.get(rid);
  let best = null, bs = -1e9;
  for (let y = 1; y < S.h - 1; y++) for (let x = 1; x < S.w - 1; x++) {
    if (S.region[y * S.w + x] !== rid) continue;
    if (!Cities.canFound(x, y, race)) continue;
    const dc = Math.hypot(x - r.cx, y - r.cy);
    if (dc > 7) continue;
    const sc = (away ? Math.hypot(x - away.cx, y - away.cy) : 0) - dc * 0.35;
    if (sc > bs) { bs = sc; best = { x, y }; }
  }
  return best;
}
export function foundCity(ctx, rid, race, pop, away) {
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
/** a chain of `len` regions r0-r1-..: consecutive ones share a land border, the others are not neighbours; the indices in `siteIdx` can host a village */
export function findChainAt(ctx, len, siteIdx, skip = []) {
  const { S, World } = ctx;
  const byLand = new Map();
  for (const r of S.regions.values()) { const l = World.landId(r.cx, r.cy); if (!byLand.has(l)) byLand.set(l, []); byLand.get(l).push(r); }
  const lands = [...byLand.values()].sort((a, b) => b.length - a.length);
  const ok = (r, i) => !skip.includes(r.id) && (!siteIdx.includes(i) || siteIn(ctx, r.id, 0, null));
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
 * TOTAL-WAR arena on a chain of regions. Attacker A owns chain[0..split-1] with cities at the indices `aAt` (default [0], populations `aPop`);
 * defender B owns chain[split..len-1] with cities at `bAt` (default [split+1, split+3]; the FIRST is its capital), populations `bPop`.
 * Returns {chain, A, B, cityA:[city], cityB:[city], rB:[region ids]} or null when the world has no suitable chain.
 */
export function tarena(ctx, o = {}) {
  const { S, Regions, Kingdoms, Diplomacy } = ctx;
  const aAt = o.aAt || [0];
  const split = o.split || Math.max(1, Math.max(...aAt) + 1);
  const len = o.len || split + 7;
  const bAt = o.bAt || [split + 1, split + 3];
  const aPop = o.aPop || [o.popA || 70, 50, 40, 30], bPop = o.bPop || [54, 34, 26, 20];
  const chain = findChainAt(ctx, len, [...aAt, ...bAt], o.skip || []);
  if (!chain) return null;
  const rB0 = S.regions.get(chain[bAt[0]]);
  const cityA = [];
  let A = 0, B = 0;
  for (let i = 0; i < aAt.length; i++) {
    const c = foundCity(ctx, chain[aAt[i]], o.raceA === undefined ? 0 : o.raceA, aPop[i] || 30, i === 0 ? rB0 : null);
    if (!c) return null;
    if (i === 0) A = c.kingdomId; else if (c.kingdomId !== A) Kingdoms.transferCity(c.id, A, 'test');
    cityA.push(c);
  }
  const cityB = [];
  for (let i = 0; i < bAt.length; i++) {
    const c = foundCity(ctx, chain[bAt[i]], o.raceB === undefined ? 0 : o.raceB, bPop[i] || 20, S.regions.get(chain[Math.max(0, bAt[i] - 1)]));
    if (!c) return null;
    if (i === 0) {
      if (c.kingdomId === A && !Kingdoms.splitCity(c.id)) return null;
      if (c.kingdomId === A) return null;
      B = c.kingdomId;
    } else if (c.kingdomId !== B) Kingdoms.transferCity(c.id, B, 'test');
    cityB.push(c);
  }
  if (!A || !B || A === B) return null;
  for (let i = 0; i < len; i++) { const want = i < split ? A : B; if (Regions.get(chain[i]).ownerId !== want) Regions.setOwner(chain[i], want, 'test'); }
  const ka = Kingdoms.get(A), kb = Kingdoms.get(B);
  if (!ka || !kb || cityB[0].kingdomId !== B || cityA[0].kingdomId !== A) return null;
  kb.capitalId = cityB[0].id; ka.capitalId = cityA[0].id;
  if (!o.keepClaims) for (const r of S.regions.values()) r.claims.length = 0;          // (splitting / handing over the cities gave A claims; the tests start from a clean slate)
  if (!o.keepAI) { Diplomacy.step = () => {}; }          // no AI wars / alliances unless the test asks for them
  feed(ctx);
  return { chain, A, B, cityA, cityB, rA: chain.slice(0, split), rB: chain.slice(split), split };
}
export function mkArena(o = {}, tryN = 10, seed0 = 1) {
  for (let s = seed0; s < seed0 + tryN; s++) {
    const ctx = mkCtx(s, o.stub);
    const a = tarena(ctx, o);
    if (a) { a.seed = s; return { ctx, a }; }
  }
  throw new Error('no total-war arena found for this configuration');
}
export const armiesOfK = (ctx, kid) => [...ctx.S.armies.values()].filter(a => a.kingdomId === kid);
export const soldiersOfK = (ctx, kid) => armiesOfK(ctx, kid).reduce((s, a) => s + a.members.length, 0);
export const ctrl = (ctx, rid) => ctx.Regions.get(rid).controllerId;
export const occupiedBy = (ctx, kid) => [...ctx.S.regions.values()].filter(r => r.controllerId === kid && r.ownerId !== kid).map(r => r.id).sort((a, b) => a - b);

/** structural invariants of the whole political layer (after annex / peace / capitulation): nothing may point at a dead kingdom or a missing war */
export function worldInvariants(ctx, label = '') {
  const { S } = ctx;
  const bad = (m) => { throw new Error(`${label} invariant: ${m}`); };
  for (const r of S.regions.values()) {
    if (r.ownerId && !S.kingdoms.has(r.ownerId)) bad(`region ${r.id} has a dead owner ${r.ownerId}`);
    if (r.controllerId && !S.kingdoms.has(r.controllerId)) bad(`region ${r.id} has a dead controller ${r.controllerId}`);
    for (const k of r.claims) if (!S.kingdoms.has(k)) bad(`region ${r.id} has a claim of dead ${k}`);
    for (const k of r.cores) if (!S.kingdoms.has(k)) bad(`region ${r.id} has a core of dead ${k}`);
    for (const cid of r.cityIds) { const c = S.cities.get(cid); if (!c) bad(`region ${r.id} lists a missing city ${cid}`); }
  }
  for (const c of S.cities.values()) {
    if (c.kingdomId && !S.kingdoms.has(c.kingdomId)) bad(`city ${c.id} has a dead kingdom ${c.kingdomId}`);
    if (c.occupierId && !S.kingdoms.has(c.occupierId)) bad(`city ${c.id} is occupied by a dead kingdom ${c.occupierId}`);
    if (c.kingdomId) { const k = S.kingdoms.get(c.kingdomId); if (k && !k.cities.includes(c.id)) bad(`city ${c.id} is missing from kingdom ${k.id}`); }
  }
  for (const k of S.kingdoms.values()) {
    for (const cid of k.cities) { const c = S.cities.get(cid); if (!c || c.kingdomId !== k.id) bad(`kingdom ${k.id} lists foreign/missing city ${cid}`); }
    if (k.overlordId && !S.kingdoms.has(k.overlordId)) bad(`kingdom ${k.id} has a dead overlord`);
    if (k.cities.length && !k.cities.includes(k.capitalId)) bad(`kingdom ${k.id} capital ${k.capitalId} is not one of its cities`);
  }
  for (const a of S.armies.values()) {
    if (!S.kingdoms.has(a.kingdomId)) bad(`army ${a.id} belongs to a dead kingdom ${a.kingdomId}`);
    const w = S.wars.get(a.warId);
    if (!w) bad(`army ${a.id} has no war`);
    if (w.ended && !a.dis) bad(`army ${a.id} of an ended war is not disbanding`);
  }
  for (const w of S.wars.values()) {
    if (w.ended) continue;
    for (const k of w.attackers.concat(w.defenders)) if (!S.kingdoms.has(k)) bad(`war ${w.id} lists dead kingdom ${k}`);
    if (!w.attackers.length || !w.defenders.length) bad(`war ${w.id} has an empty side`);
  }
  for (const u of S.units.values()) {
    if (u.kingdomId && !S.kingdoms.has(u.kingdomId)) bad(`unit ${u.id} has a dead kingdom ${u.kingdomId}`);
    if (u.armyId && !S.armies.has(u.armyId)) bad(`unit ${u.id} is in a missing army ${u.armyId}`);
  }
  for (const rel of S.rels.values()) if (!S.kingdoms.has(rel.a) || !S.kingdoms.has(rel.b)) bad(`relation ${rel.a}_${rel.b} has a dead side`);
  JSON.stringify(Array.from(S.wars.values())); JSON.stringify(Array.from(S.armies.values())); JSON.stringify(S.mod);
}
