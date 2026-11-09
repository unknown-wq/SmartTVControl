// Long-run headless simulation library (shared by tests/long.mjs CLI and tests/system.test.mjs).
//   runSeed({seed, ticks, size, window, populate}) -> report   (one full world, windows of `window` ticks)
//   runSeeds(seeds, opts, par) -> Promise<report[]>            (worker threads, `par` at a time)
// A report holds per-window metrics, wars/kingdom/rebellion logs, anomalies (NaN / non-JSON-safe / unbounded) and timing.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { loadSim, stepN } from './harness.mjs';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const RACES = ['human', 'orc', 'elf'];

/** first non-JSON-safe thing inside v (function / symbol / Map / Set / NaN / Infinity / cycle) or null */
export function findBad(v, path = '', depth = 0, seen = null) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? null : `${path}=${v}`;
  if (t === 'string' || t === 'boolean') return null;
  if (t === 'function' || t === 'symbol' || t === 'bigint') return `${path}:${t}`;
  if (depth > 7) return `${path}:too deep`;
  if (v instanceof Map || v instanceof Set) return `${path}:${v.constructor.name}`;
  if (ArrayBuffer.isView(v)) return `${path}:typed array`;
  seen = seen || new Set();
  if (seen.has(v)) return `${path}:cycle`;
  seen.add(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const b = findBad(v[i], path + '[' + i + ']', depth + 1, seen); if (b) return b; }
  } else {
    for (const k of Object.keys(v)) { const b = findBad(v[k], path + '.' + k, depth + 1, seen); if (b) return b; }
  }
  seen.delete(v);
  return null;
}

function newMetrics() {
  return {
    wars: 0, warsEnded: 0, ends: {}, occ: 0, lib: 0, transfers: 0, transferWhy: {}, rebel: 0, merge: 0, vassal: 0, fall: 0, kcreated: 0,
    foundCity: 0, destroyCity: 0, log: 0, logKinds: {}, logMaxPerBucket: 0, ticks: 0, ms: 0, worst: 0, msSmall: 0, nSmall: 0, maxUnits: 0, alliances: 0,
  };
}

/** Run one world. Pure function of its options except for timing. */
export function runSeed(o) {
  const seed = o.seed | 0, TICKS = o.ticks || 30000, SIZE = o.size || 96, WIN = o.window || 3000;
  const ctx = loadSim({});
  const { S, Sim, Bus, Const, Util, Kingdoms, Regions, War, Units, Save } = ctx;
  const errs = [];
  const oerr = console.error;
  console.error = (...a) => { errs.push(a.map(String).join(' ').slice(0, 300)); };
  const rep = { seed, ticks: TICKS, size: SIZE, windows: [], wars: [], kingdoms: [], rebellions: [], anomalies: [], errors: errs, spam: {}, bounds: {}, final: null };
  let m = newMetrics();
  const warInfo = new Map();
  const kinfo = new Map();
  let bucketN = 0, bucketT = 0;

  const sideOf = (w, k) => w.attackers.indexOf(k) >= 0 ? 1 : w.defenders.indexOf(k) >= 0 ? 2 : 0;
  Bus.on('warDeclared', (w) => {
    m.wars++;
    warInfo.set(w.id, { id: w.id, t0: S.tick, casus: w.casus, agg: w.aggressor, def: w.defender, goals: w.goals.length, occ: 0, extra: 0, lib: 0, att: w.attackers.length, dfn: w.defenders.length });
  });
  Bus.on('warEnded', (w, how) => {
    m.warsEnded++; m.ends[how] = (m.ends[how] || 0) + 1;
    const i = warInfo.get(w.id) || { id: w.id, t0: w.started, occ: 0, extra: 0, lib: 0 };
    i.t1 = S.tick; i.how = how; i.dur = S.tick - i.t0;
    i.goalsDone = w.goals.filter(g => g.done).length; i.goalsTotal = w.goals.length;
    i.lastChange = w.lastChange; i.stalled = !(w.lastChange > w.started + 1);
    i.kills = Object.values(w.kills || {}).reduce((a, b) => a + b, 0);
    i.losses = Object.values(w.losses || {}).reduce((a, b) => a + b, 0);
    rep.wars.push(i); warInfo.delete(w.id);
  });
  Bus.on('regionControl', (r, oldK, newK) => {
    if (!newK || !r.ownerId) { if (newK === 0 || newK === r.ownerId) m.lib++; return; }
    if (newK !== r.ownerId) {
      m.occ++;
      for (const w of S.wars.values()) {
        if (w.ended) continue;
        const a = sideOf(w, newK), b = sideOf(w, r.ownerId);
        if (a && b && a !== b) {
          const i = warInfo.get(w.id); if (!i) continue;
          i.occ++;
          if (!w.goals.some(g => g.regionId === r.id)) i.extra++;
        }
      }
    } else m.lib++;
  });
  Bus.on('regionOwner', (r, o, n, why) => { m.transferWhy[why] = (m.transferWhy[why] || 0) + 1; if (why === 'peace' || why === 'transfer' || why === 'force' || why === 'war') m.transfers++; });
  Bus.on('cityRebelled', (c, ok, nk) => { m.rebel++; rep.rebellions.push({ t: S.tick, city: c.id, from: ok && ok.id, to: nk && nk.id }); });
  Bus.on('vassalCreated', () => { m.vassal++; });
  Bus.on('allianceMade', () => { m.alliances++; });
  Bus.on('cityFounded', () => { m.foundCity++; });
  Bus.on('cityDestroyed', () => { m.destroyCity++; });
  Bus.on('kingdomCreated', (k) => { m.kcreated++; kinfo.set(k.id, { id: k.id, race: k.race, t0: S.tick, name: k.name }); });
  Bus.on('kingdomDestroyed', (k) => {
    const merged = k.hist && k.hist.length && k.hist[k.hist.length - 1].t === 'Присоединено';
    if (merged) m.merge++; else m.fall++;
    const i = kinfo.get(k.id) || { id: k.id, race: k.race, t0: 0 };
    i.t1 = S.tick; i.how = merged ? 'merge' : 'fall'; rep.kingdoms.push(i); kinfo.delete(k.id);
  });
  Bus.on('log', (e) => {
    m.log++; m.logKinds[e.kind] = (m.logKinds[e.kind] || 0) + 1;
    if (e.tick - bucketT >= 100) { bucketT = e.tick - (e.tick % 100); bucketN = 0; }
    bucketN++; if (bucketN > m.logMaxPerBucket) m.logMaxPerBucket = bucketN;
    const key = e.msg.replace(/«[^»]*»/g, '«»').replace(/\d+/g, '#');
    rep.spam[key] = (rep.spam[key] || 0) + 1;
  });

  Sim.newWorld({ seed, w: SIZE, h: SIZE, populate: o.populate !== false });
  for (const k of S.kingdoms.values()) kinfo.set(k.id, { id: k.id, race: k.race, t0: 0, name: k.name });

  const snap = (tick) => {
    Sim.stats();
    const st = S.stats;
    let owned = 0, wild = 0, ownedByRace = [0, 0, 0], soldiers = 0;
    for (const r of S.regions.values()) { if (r.ownerId) { owned++; const k = S.kingdoms.get(r.ownerId); if (k) ownedByRace[k.race]++; } else wild++; }
    for (const a of S.armies.values()) soldiers += a.members.length;
    const kPerRace = [0, 0, 0];
    for (const k of S.kingdoms.values()) if (k.alive !== false) kPerRace[k.race]++;
    let occupied = 0;
    for (const r of S.regions.values()) if (r.ownerId && r.controllerId && r.controllerId !== r.ownerId) occupied++;
    let activeWars = 0; for (const w of S.wars.values()) if (!w.ended) activeWars++;
    const row = {
      tick, year: Util.year(), pop: st.pop.slice(), popTotal: st.popTotal, cities: S.cities.size, kingdoms: kPerRace.reduce((a, b) => a + b, 0), kPerRace,
      owned, wild, occupied, activeWars, armies: S.armies.size, soldiers,
      warsStarted: m.wars, warsEnded: m.warsEnded, occ: m.occ, lib: m.lib, transfers: m.transfers, rebel: m.rebel, merge: m.merge, fall: m.fall, vassal: m.vassal, alliances: m.alliances,
      maxUnits: m.maxUnits, msAvg: m.ticks ? m.ms / m.ticks : 0, msWorst: m.worst, msSmallAvg: m.nSmall ? m.msSmall / m.nSmall : 0, nSmall: m.nSmall,
      log: m.log, logMaxPer100: m.logMaxPerBucket, logKinds: Object.assign({}, m.logKinds), errors: Sim.totalErrors + errs.length,
      wars: S.wars.size, rels: S.rels.size, fx: ctx.Fx.list.length, logLen: S.log.length, buildings: S.buildings.size,
    };
    return row;
  };

  const checkSane = (tick) => {
    // NaN / infinite positions
    for (const u of S.units.values()) {
      if (!Number.isFinite(u.x) || !Number.isFinite(u.y) || !Number.isFinite(u.hp) || !Number.isFinite(u.hunger)) { rep.anomalies.push(`t${tick} unit ${u.id} non-finite x/y/hp/hunger`); break; }
      if (u.x < 0 || u.y < 0 || u.x >= S.w || u.y >= S.h) { rep.anomalies.push(`t${tick} unit ${u.id} out of the map (${u.x},${u.y})`); break; }
    }
    const groups = { cities: S.cities, kingdoms: S.kingdoms, buildings: S.buildings, armies: S.armies, wars: S.wars, regions: S.regions };
    for (const g of Object.keys(groups)) {
      for (const e of groups[g].values()) { const b = findBad(e, g + '#' + e.id); if (b) { rep.anomalies.push(`t${tick} not JSON-safe: ${b}`); break; } }
    }
    let n = 0;
    for (const u of S.units.values()) { if ((n++ % 7) === 0) { const b = findBad(u, 'unit#' + u.id); if (b) { rep.anomalies.push(`t${tick} not JSON-safe: ${b}`); break; } } }
    for (const [k, r] of S.rels) { const b = findBad(r, 'rel ' + k); if (b) { rep.anomalies.push(`t${tick} not JSON-safe: ${b}`); break; } }
    const b = findBad(S.mod, 'mod'); if (b) rep.anomalies.push(`t${tick} not JSON-safe: ${b}`);
    const b2 = findBad(S.eff, 'eff'); if (b2) rep.anomalies.push(`t${tick} not JSON-safe: ${b2}`);
    // dangling ids
    for (const c of S.cities.values()) if (c.kingdomId && !S.kingdoms.has(c.kingdomId)) { rep.anomalies.push(`t${tick} city ${c.id} has dead kingdom ${c.kingdomId}`); break; }
    for (const a of S.armies.values()) { const w = S.wars.get(a.warId); if ((!w || w.ended) && !a.dis) { rep.anomalies.push(`t${tick} army ${a.id} of a missing/ended war (not disbanding)`); break; } }
    for (const r of S.regions.values()) {
      if (r.ownerId && !S.kingdoms.has(r.ownerId)) { rep.anomalies.push(`t${tick} region ${r.id} owned by dead kingdom ${r.ownerId}`); break; }
      if (r.controllerId && !S.kingdoms.has(r.controllerId)) { rep.anomalies.push(`t${tick} region ${r.id} controlled by dead kingdom ${r.controllerId}`); break; }
    }
    // bounds
    const bd = rep.bounds;
    const upd = (k, v) => { if (!(bd[k] >= v)) bd[k] = v; };
    upd('log', S.log.length); upd('wars', S.wars.size); upd('armies', S.armies.size); upd('rels', S.rels.size); upd('fx', ctx.Fx.list.length);
    upd('units', S.units.size); upd('buildings', S.buildings.size); upd('cities', S.cities.size); upd('kingdoms', S.kingdoms.size);
    upd('modBytes', JSON.stringify(S.mod).length); upd('cultures', S.cultures.length);
    let hist = 0; for (const k of S.kingdoms.values()) if (k.hist && k.hist.length > hist) hist = k.hist.length; upd('kHist', hist);
    let causes = 0; for (const r of S.rels.values()) if (r.causes && r.causes.length > causes) causes = r.causes.length; upd('relCauses', causes);
    let claims = 0; for (const r of S.regions.values()) { if (r.claims.length > claims) claims = r.claims.length; } upd('claims', claims);
    let members = 0; for (const c of S.cities.values()) if (c.members.length > members) members = c.members.length; upd('cityMembers', members);
  };

  const t0all = performance.now();
  let next = WIN;
  for (let t = 1; t <= TICKS; t++) {
    const a = performance.now();
    Sim.step();
    ctx.Fx.update(0.1);                         // (the client drains the effect queue every frame)
    const dt = performance.now() - a;
    m.ticks++; m.ms += dt; if (dt > m.worst) m.worst = dt;
    const n = S.units.size;
    if (n > m.maxUnits) m.maxUnits = n;
    if (n <= 600) { m.msSmall += dt; m.nSmall++; }
    if (t % 100 === 0 && S.armies.size) {
      for (const w of S.wars.values()) {
        if (w.ended) continue;
        const i = warInfo.get(w.id); if (!i) continue;
        let a = 0, d = 0;
        for (const ar of S.armies.values()) { if (ar.warId !== w.id) continue; if (w.attackers.indexOf(ar.kingdomId) >= 0) a += ar.members.length; else d += ar.members.length; }
        if (a > (i.maxA || 0)) i.maxA = a; if (d > (i.maxD || 0)) i.maxD = d;
      }
    }
    if (t === next || t === TICKS) {
      const row = snap(t);
      checkSane(t);
      rep.windows.push(row);
      m.ticks = 0; m.ms = 0; m.worst = 0; m.msSmall = 0; m.nSmall = 0; m.logMaxPerBucket = 0;
      next += WIN;
    }
  }
  console.error = oerr;
  rep.wallMs = performance.now() - t0all;
  for (const k of kinfo.values()) rep.kingdoms.push(Object.assign({ alive: true }, k));
  const last = rep.windows[rep.windows.length - 1];
  rep.final = last;
  rep.simErrors = Sim.totalErrors; rep.simErrorMap = Object.assign({}, Sim.errors);
  // alive kingdom details at the end
  rep.endKingdoms = [...S.kingdoms.values()].map(k => ({ id: k.id, race: k.race, regions: Regions.ofKingdom(k.id).length, cities: k.cities.length, pop: Kingdoms.pop(k.id), vassal: !!k.overlordId }));
  return rep;
}

/** run seeds on worker threads, `par` at a time */
export function runSeeds(seeds, opts = {}, par = 3) {
  return new Promise((resolve, reject) => {
    const out = new Array(seeds.length);
    let idx = 0, active = 0, done = 0;
    const launch = () => {
      while (active < par && idx < seeds.length) {
        const i = idx++;
        active++;
        const w = new Worker(SELF, { workerData: { longJob: Object.assign({}, opts, { seed: seeds[i] }) } });
        w.on('message', (r) => { out[i] = r; });
        w.on('error', reject);
        w.on('exit', () => { active--; done++; if (done === seeds.length) resolve(out); else launch(); });
      }
    };
    if (!seeds.length) resolve([]); else launch();
  });
}

if (!isMainThread && workerData && workerData.longJob) {
  parentPort.postMessage(runSeed(workerData.longJob));
}

export { stepN, RACES };
