/* =====================================================================
 * 10_war.js — War: HOI4-style wars with regional goals, armies with orders, occupation, supply, war score, peace conferences.
 * OWNER: War agent. API: docs/CONTRACT.md §8.2 / §8.6.  DOM-free, deterministic (all randomness through R, time = S.tick).
 *
 *  War   {id, attackers[], defenders[], aggressor, defender, started, casus, ended, goals[{kid,regionId,done}], score{kid}, kills{kid},
 *         lastChange, hist[]  + private: losses{kid}, wear{kid} (war weariness 0..100), ev{kid} (score events), occ{rid:{x,n}} (occupation timers),
 *         low{kid} / mp{kid} (exhaustion timers), endedAt, how}
 *  Army  {id, kingdomId, cityId, warId, leaderId, members[], order{type,regionId}, mode, rally{x,y}, target{regionId,x,y,cityId}|null, supply,
 *         strength0, born  + private: race, path (flat tile list), pi, gx/gy (goal of the path), since, auto (orders given by the AI / system, not
 *         the player), lock (AI hands off until), coh (cohesion 0..1), pow, fail, dis (disbanding), att (next attrition tick), badRid/badT}
 *  Persistent module state: S.mod.war = {autoPeace, truce{"a_b":tick}, offers{warId:{...}}, form{"warId:kid":tick}}.
 *  Caches (rebuilt in afterLoad): the O(1) "at war" pair map only.
 *
 *  Flow of a war:  declare (goals = enemy-owned regions next to our land; allies / vassals join; every belligerent musters) -> armies are
 *  raised in the cities (20-35 % of the adults, <= 6 armies per kingdom, <= 60 men each, <= 350 in the world) -> gather at home -> the army's
 *  RALLY point marches along a World.findPath route at army speed (soldiers follow it, Units own the fighting) -> siege / hold in the goal
 *  region -> OCCUPATION (>= 3 soldiers of an army ordered to the region and standing in it, no armed enemy soldier inside for 30 ticks) flips
 *  the region's CONTROLLER -> the order becomes HOLD: the army stays, the AI never advances without a NEW goal and the war goes on until a
 *  peace is signed (conference / god / exhaustion).  Ownership changes only in finishWar() through Regions.setOwner + Kingdoms.transferCity.
 *  AI (every 10 ticks per war): one goal at a time, defend / retake threatened own regions, pull back below 15 supply, re-muster when needed;
 *  a commanded kingdom (k.cmd) only gets automatic defence (and the goal assignment on declare / addGoal) - the player's orders are never overridden.
 * ===================================================================== */

const War = (() => {
  const REL = Const.REL, LOG = Const.LOG, ORD = Const.ORDER;

  // ------------------------------------------------------------------ tunables
  const MAX_ARMIES_K = 6;            // armies per kingdom (all wars)
  const MAX_ARMIES_WAR = 4;          // armies per kingdom per war
  const MAX_ARMY = 60;               // soldiers per army
  const MIN_ARMY = 3;                // smaller armies are not worth raising
  const MAX_SOLDIERS = 350;          // soldiers in the world's armies at once
  const FRAC_MIN = 0.20, FRAC_MAX = 0.35, FRAC_HARD = 0.45;   // share of a city's adults that may be conscripted
  const TRUCE = 2400;                // ticks of truce after a peace
  const ARMY_PERIOD = 5;             // army brain
  const OCC_PERIOD = 10;             // occupation check (also the dt of the timers)
  const AI_PERIOD = 10;
  const SCORE_PERIOD = 30;
  const WAR_PERIOD = 60;
  const REFILL_PERIOD = 100;
  const OCC_TICKS = 30, OCC_MIN = 3, RETAKE_MIN = 2, OCC_RATIO = 1.3;
  const SUPPLY_RANGE = 14, SUPPLY_LOW = 30, SUPPLY_DOWN = 1.25, SUPPLY_UP = 2.5, BASE_AFTER = 100, ATTRITION_EVERY = 25;
  const GATHER_MAX = 160;            // ticks an army waits for stragglers before marching
  const ARRIVE = 2.6;                // rally distance counted as "arrived"
  const STALEMATE = 4800;            // ticks without a controller change before autoPeace ends the war
  const ENDED_KEEP = 900, ENDED_MAX = 10;
  const PATH_NODES = 4000;
  const PARTIAL = { partial: true };

  // ------------------------------------------------------------------ transient state
  let pairs = new Map(), pairsFor = null, pairsSize = -1;
  let pathBudget = 0;
  let autoPref = true;
  let lastError = '';
  let pres1 = null, pres2 = null, eli1 = null, eli2 = null;
  const presList = [];
  const scratchRelease = [];
  // occupation-fighter scan scratch
  let cfW = null, cfRid = 0, cfSide = 0, cfN = 0;

  // ------------------------------------------------------------------ small helpers
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function kget(id) { const k = S.kingdoms.get(id); return k && k.alive !== false ? k : null; }
  function reg(id) { return S.regions ? (S.regions.get(id) || null) : null; }
  function rgOn() { return !!(S.regions && S.regions.size > 0 && S.region && typeof Regions !== 'undefined' && !Regions.__stub); }
  function rname(rid) { const r = reg(rid); return r ? '«' + r.name + '»' : '«?»'; }
  function kname(kid) { const k = S.kingdoms.get(kid); return k ? '«' + k.name + '»' : '«?»'; }
  function fail(msg) { lastError = msg; return null; }
  function mod() {
    let m = S.mod.war;
    if (!m || typeof m !== 'object' || Array.isArray(m)) m = S.mod.war = { autoPeace: autoPref, truce: {}, offers: {}, form: {} };
    if (typeof m.autoPeace !== 'boolean') m.autoPeace = true;
    if (!m.truce || typeof m.truce !== 'object') m.truce = {};
    if (!m.offers || typeof m.offers !== 'object') m.offers = {};
    if (!m.form || typeof m.form !== 'object') m.form = {};
    if (!m.wiped || typeof m.wiped !== 'object') m.wiped = {};
    return m;
  }
  function regionAtPos(x, y) {
    if (!(x >= 0 && y >= 0 && x < S.w && y < S.h)) return 0;
    return S.region[(y | 0) * S.w + (x | 0)];
  }
  function cityCountOf(r) { let n = 0; for (let i = 0; i < r.cityIds.length; i++) if (S.cities.has(r.cityIds[i])) n++; return n; }
  function regionCost(r) { return Math.round(8 + (r.value || 0) * 4 + 10 * cityCountOf(r)); }
  function normRegions(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      const id = typeof g === 'number' ? g : g && typeof g === 'object' ? (g.regionId !== undefined ? g.regionId : g.id) : 0;
      if (id > 0 && out.indexOf(id) < 0 && reg(id)) out.push(id);
    }
    return out;
  }

  // ------------------------------------------------------------------ O(1) war pairs (the single truth, Diplomacy forwards here)
  function addPair(a, b) { let m = pairs.get(a); if (!m) { m = new Map(); pairs.set(a, m); } m.set(b, (m.get(b) || 0) + 1); }
  function rebuildPairs() {
    pairs = new Map(); pairsFor = S.wars; pairsSize = S.wars.size;
    for (const w of S.wars.values()) {
      if (w.ended || !w.attackers || !w.defenders) continue;
      for (let i = 0; i < w.attackers.length; i++) for (let j = 0; j < w.defenders.length; j++) { addPair(w.attackers[i], w.defenders[j]); addPair(w.defenders[j], w.attackers[i]); }
    }
  }
  function atWar(a, b) {
    if (pairsFor !== S.wars || pairsSize !== S.wars.size) rebuildPairs();
    const m = pairs.get(a);
    return m !== undefined && m.get(b) > 0;
  }

  // ------------------------------------------------------------------ sides
  function sideOf(w, kid) { return w.attackers.indexOf(kid) >= 0 ? 1 : (w.defenders.indexOf(kid) >= 0 ? 2 : 0); }
  function sideArr(w, s) { return s === 1 ? w.attackers : w.defenders; }
  function leadOf(w, s) {
    const p = s === 1 ? w.aggressor : w.defender, arr = sideArr(w, s);
    if (arr.indexOf(p) >= 0 && kget(p)) return p;
    for (let i = 0; i < arr.length; i++) if (kget(arr[i])) return arr[i];
    return 0;
  }
  function warBetween(a, b) {
    for (const w of S.wars.values()) {
      if (w.ended) continue;
      const sa = sideOf(w, a), sb = sideOf(w, b);
      if (sa && sb && sa !== sb) return w;
    }
    return null;
  }
  function isGoal(w, side, rid) {
    for (let i = 0; i < w.goals.length; i++) { const g = w.goals[i]; if (g.regionId === rid && sideOf(w, g.kid) === side) return true; }
    return false;
  }
  function armiesOfWar(w, kid) {
    const out = [];
    for (const a of S.armies.values()) if (a.warId === w.id && (kid === undefined || a.kingdomId === kid)) out.push(a);
    return out;
  }
  function armyCountK(kid) { let n = 0; for (const a of S.armies.values()) if (a.kingdomId === kid) n++; return n; }
  function soldierCount() { let n = 0; for (const a of S.armies.values()) n += a.members.length; return n; }

  // ------------------------------------------------------------------ diplomacy glue (guarded: the module may be a stub)
  function dipOn() { return typeof Diplomacy !== 'undefined' && Diplomacy && !Diplomacy.__stub; }
  function alliedTo(a, b) { try { return dipOn() && !!Diplomacy.allied(a, b); } catch (e) { return false; } }
  function tkey(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
  function inTruce(a, b) {
    const u = mod().truce[tkey(a, b)];
    if (u > S.tick) return true;
    try { return dipOn() && !!Diplomacy.inTruce(a, b); } catch (e) { return false; }
  }
  function truceUntil(a, b) {
    let u = mod().truce[tkey(a, b)] || 0;
    try { if (dipOn()) { const r = Diplomacy.get(a, b); if (r && r.truceUntil > u) u = r.truceUntil; } } catch (e) { /* ignore */ }
    return u > S.tick ? u : 0;
  }
  function setTruce(a, b, until) {
    mod().truce[tkey(a, b)] = until;
    try { if (dipOn()) Diplomacy.setTruce(a, b, until); } catch (e) { /* ignore */ }
  }
  function dipState(a, b, st) { try { if (dipOn()) Diplomacy.setState(a, b, st); } catch (e) { /* ignore */ } }
  function alliesOf(kid) { try { if (dipOn()) { const r = Diplomacy.alliesOf(kid); if (Array.isArray(r)) return r; } } catch (e) { /* ignore */ } return []; }
  function willJoin(ally, side, enemy, defending) {
    try {
      if (dipOn() && typeof Diplomacy.allyWillJoin === 'function') return !!Diplomacy.allyWillJoin(ally, side, enemy, defending);
    } catch (e) { /* ignore */ }
    return defending ? R.chance(0.8) : R.chance(0.35);
  }
  function milPower(kid) {
    try { if (typeof Kingdoms !== 'undefined' && !Kingdoms.__stub && typeof Kingdoms.strength === 'function') { const v = Kingdoms.strength(kid); if (v === v) return v; } } catch (e) { /* ignore */ }
    let s = 0; const k = S.kingdoms.get(kid);
    if (k) for (let i = 0; i < k.cities.length; i++) { const c = S.cities.get(k.cities[i]); if (c) s += c.pop; }
    return s;
  }

  // ================================================================== ARMIES: formation
  function stageAdult(u) { return Units.stage(u) === 'adult'; }
  function conscriptFrac(k, defending) {
    const r = S.units.get(k.rulerId);
    let f = 0.27 + (defending ? 0.04 : 0);
    if (r) f += Traits.sum(r, 'war') * 0.15 - Traits.sum(r, 'peace') * 0.08;
    return clamp(f, FRAC_MIN, FRAC_MAX);
  }
  /** fighting value of one soldier; archers get a bonus for their range (they shoot while the enemy walks up) */
  function unitPow(u) { return Units.atkOf(u) * (u.hp + 4 * Units.defOf(u)) * (Units.rangeOf(u) > 2 ? 1.5 : 1); }
  function rate(u) { return (u.level | 0) * 3 + (u.weapon | 0) * 2 + (u.armor | 0) + u.hp / (u.maxHp || 1) + (u.kills | 0) * 0.1 - u.id * 1e-7; }
  function byRate(a, b) { return rate(b) - rate(a); }
  /** adults (not elders) of the city: total, already soldiers, and the list of those who can still be conscripted */
  let recAdults = 0, recInArmy = 0;
  function recruitsOf(c, out) {
    out.length = 0; recAdults = 0; recInArmy = 0;
    for (let i = 0; i < c.members.length; i++) {
      const u = S.units.get(c.members[i]);
      if (!u || u.cityId !== c.id || !stageAdult(u)) continue;
      recAdults++;
      if (u.armyId) { recInArmy++; continue; }
      if (u.isRuler || u.state === 'settle' || u.hp < u.maxHp * 0.5) continue;
      out.push(u);
    }
    out.sort(byRate);
    return out;
  }
  function wantFromCity(c, frac, recs) {
    let n = Math.round(recAdults * frac) - recInArmy;
    if (n < MIN_ARMY && recAdults >= 7) n = MIN_ARMY - recInArmy;      // tiny villages can still raise a small band
    n = Math.min(n, Math.floor(recAdults * FRAC_HARD) - recInArmy, recs.length, MAX_ARMY);
    return n > 0 ? n : 0;
  }
  function electLeader(a) {
    let best = null, bl = -1, bk = -1;
    for (let i = 0; i < a.members.length; i++) {
      const u = S.units.get(a.members[i]);
      if (!u || u.armyId !== a.id) continue;
      const l = u.level | 0, k = u.kills | 0;
      if (best === null || l > bl || (l === bl && (k > bk || (k === bk && u.id < best.id)))) { best = u; bl = l; bk = k; }
    }
    a.leaderId = best ? best.id : 0;
  }
  function mkArmy(kid, city, w) {
    return {
      id: S.id(), kingdomId: kid, cityId: city.id, warId: w.id, leaderId: 0, members: [],
      order: { type: ORD.HOLD, regionId: city.regionId | 0 }, mode: 'gather',
      rally: { x: city.x + 0.5, y: city.y + 0.5 }, target: null, supply: 100, strength0: 0, born: S.tick,
      race: city.race, path: null, pi: 0, gx: 0, gy: 0, since: S.tick, auto: 1, lock: 0, coh: 1, pow: 0, fail: 0, dis: 0, att: 0, badRid: 0, badT: 0,
    };
  }
  function formArmy(w, kid, city, recs, n) {
    const a = mkArmy(kid, city, w);
    S.armies.set(a.id, a);
    let got = 0;
    for (let i = 0; i < recs.length && got < n; i++) if (Units.conscript(recs[i], a.id)) got++;
    if (got < MIN_ARMY && got < n) { disband(a); return null; }
    a.strength0 = a.members.length;
    electLeader(a);
    let pw = 0;                                  // (known from the first tick: the assault gate compares armies before their first brain pass)
    for (let i = 0; i < a.members.length; i++) { const u = S.units.get(a.members[i]); if (u) pw += unitPow(u); }
    a.pow = Math.round(pw);
    return a;
  }
  const recBuf = [];
  /** raise new armies for `kid` in war `w` (one per city that can spare >= MIN_ARMY soldiers). Returns the number of new armies. */
  function raiseFor(w, kid, maxNew) {
    const k = kget(kid);
    if (!k) return 0;
    const side = sideOf(w, kid);
    const have = armiesOfWar(w, kid);
    let slots = Math.min(MAX_ARMIES_WAR - have.length, MAX_ARMIES_K - armyCountK(kid));
    if (maxNew !== undefined) slots = Math.min(slots, maxNew);
    let budget = MAX_SOLDIERS - soldierCount();
    if (slots <= 0 || budget < MIN_ARMY) return 0;
    const frac = conscriptFrac(k, side === 2);
    const cand = [];
    for (let i = 0; i < k.cities.length; i++) {
      const c = S.cities.get(k.cities[i]);
      if (!c || c.kingdomId !== kid || c.occupierId) continue;
      let dup = false;
      for (let j = 0; j < have.length; j++) if (have[j].cityId === c.id) { dup = true; break; }
      if (dup) continue;
      const recs = recruitsOf(c, recBuf);
      const n = wantFromCity(c, frac, recs);
      if (n >= MIN_ARMY) cand.push({ c, n });
    }
    // staging: with a goal pending, muster in the cities that are closest to it BY ROUTE (a bay in between can make the nearest city by air the farthest by land)
    const gRid = cand.length > 1 ? pendingGoal(w, kid, side) : 0, grg = gRid ? reg(gRid) : null;
    if (grg) {
      cand.sort((x, y) => Util.dist2(x.c.x, x.c.y, grg.cx, grg.cy) - Util.dist2(y.c.x, y.c.y, grg.cx, grg.cy) || x.c.id - y.c.id);
      for (let i = 0; i < cand.length; i++) {
        if (i < 4) { routeUnsupplied(cand[i].c.x, cand[i].c.y, grg.cx + 0.5, grg.cy + 0.5, cand[i].c.race, w, side); cand[i].rl = routeLen; }
        else cand[i].rl = 9999;
        cand[i].sc = cand[i].rl - 0.4 * Math.min(cand[i].n, 20);
      }
      cand.sort((x, y) => x.sc - y.sc || x.c.id - y.c.id);
    } else cand.sort((x, y) => y.n - x.n || x.c.id - y.c.id);
    let made = 0;
    for (let i = 0; i < cand.length && made < slots && budget >= MIN_ARMY; i++) {
      const c = cand[i].c;
      const recs = recruitsOf(c, recBuf);
      const n = Math.min(cand[i].n, budget, recs.length);
      if (n < MIN_ARMY) continue;
      const a = formArmy(w, kid, c, recs, n);
      if (a) { made++; budget -= a.members.length; }
    }
    return made;
  }
  /** top the army up from its home city (reinforcements walk to the rally point on their own); armies grow with their city */
  function refillArmy(a, w) {
    const k = kget(a.kingdomId);
    const c = S.cities.get(a.cityId);
    if (!k || !c || c.kingdomId !== a.kingdomId || c.occupierId) return 0;
    if (a.dis || a.mode === 'retreat' || a.order.type === ORD.RETREAT) return 0;
    // reinforcements only walk to a front that is not absurdly far away
    if (Util.dist(a.rally.x, a.rally.y, c.x, c.y) > 70) return 0;
    const recs = recruitsOf(c, recBuf);
    const desired = Math.round(recAdults * conscriptFrac(k, sideOf(w, a.kingdomId) === 2));
    const target = Math.min(MAX_ARMY, Math.max(a.strength0, desired));
    const need = target - a.members.length;
    if (need < 2) return 0;
    const budget = MAX_SOLDIERS - soldierCount();
    if (budget <= 0) return 0;
    const n = Math.min(need, 6, budget, Math.floor(recAdults * FRAC_HARD) - recInArmy, recs.length);
    let got = 0;
    for (let i = 0; i < n; i++) if (Units.conscript(recs[i], a.id)) got++;
    return got;
  }
  function disband(a) {
    const m = a.members.slice();
    for (let i = 0; i < m.length; i++) {
      const u = S.units.get(m[i]);
      if (u && u.armyId === a.id) Units.release(u);
    }
    S.armies.delete(a.id);
  }
  function pruneMembers(a) {
    const m = a.members;
    let wi = 0;
    scratchRelease.length = 0;
    for (let i = 0; i < m.length; i++) {
      const u = S.units.get(m[i]);
      if (!u) continue;
      if (u.armyId !== a.id) continue;
      if (u.kingdomId !== a.kingdomId) { scratchRelease.push(u); continue; }
      m[wi++] = m[i];
    }
    m.length = wi;
    for (let i = 0; i < scratchRelease.length; i++) Units.release(scratchRelease[i]);
    scratchRelease.length = 0;
  }

  // ================================================================== ARMIES: movement, supply, brain
  function homeOf(a) {
    let c = S.cities.get(a.cityId);
    if (c && c.kingdomId === a.kingdomId && !c.occupierId) return c;
    const k = kget(a.kingdomId);
    if (!k) return null;
    let best = null, bd = 1e12, anyC = null;
    for (let i = 0; i < k.cities.length; i++) {
      c = S.cities.get(k.cities[i]);
      if (!c) continue;
      anyC = c;
      if (c.occupierId) continue;
      const d = Util.dist2(c.x, c.y, a.rally.x, a.rally.y);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) best = anyC;
    if (best) a.cityId = best.id;
    return best;
  }
  function setMode(a, m, tick) { if (a.mode !== m) { a.mode = m; a.since = tick; } }
  function rallySpeed(a) {
    const rc = Races.list[a.race] || Races.list[0];
    let mul = World.moveCost(a.rally.x, a.rally.y, a.race);
    if (!(mul > 0)) mul = 0.5;
    let f = a.mode === 'retreat' ? 1 : (a.coh >= 0.55 ? 1 : a.coh >= 0.3 ? 0.5 : 0.22);
    if (a.mode === 'gather') f = 0;
    return rc.speed / Const.TICKS_PER_SEC * 0.85 * mul * f;
  }
  function moveRally(a) {
    const p = a.path;
    if (!p) return;
    const i = a.pi, n = p.length >> 1;
    if (i >= n) { a.path = null; return; }
    const sp = rallySpeed(a);
    if (sp <= 0) return;
    const rl = a.rally;
    const tx = p[2 * i] + 0.5, ty = p[2 * i + 1] + 0.5;
    const dx = tx - rl.x, dy = ty - rl.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d <= sp) { rl.x = tx; rl.y = ty; a.pi = i + 1; if (a.pi >= n) a.path = null; }
    else { rl.x += dx / d * sp; rl.y += dy / d * sp; }
  }
  /** plan the rally route to (tx,ty). Returns false when no route exists. */
  function planPath(a, tx, ty) {
    let sx = a.rally.x | 0, sy = a.rally.y | 0;
    let p = World.findPath(sx, sy, tx | 0, ty | 0, a.race, PATH_NODES, PARTIAL);
    if (!p) {
      const q = World.nearestWalkable(a.rally.x, a.rally.y, 3);
      if (q) { a.rally.x = q[0] + 0.5; a.rally.y = q[1] + 0.5; sx = q[0]; sy = q[1]; p = World.findPath(sx, sy, tx | 0, ty | 0, a.race, PATH_NODES, PARTIAL); }
    }
    if (!p || p.length === 0) return false;
    const flat = new Array(p.length * 2);
    for (let i = 0; i < p.length; i++) { flat[2 * i] = p[i][0]; flat[2 * i + 1] = p[i][1]; }
    a.path = flat; a.pi = 0; a.gx = tx; a.gy = ty;
    return true;
  }
  function wantPath(a, tx, ty, tick) {
    if (a.path && Math.abs(a.gx - tx) <= 3 && Math.abs(a.gy - ty) <= 3) return;
    if (pathBudget <= 0) return;
    pathBudget--;
    if (planPath(a, tx, ty)) { a.fail = 0; return; }
    a.path = null;
    if (++a.fail >= 3) {                       // unreachable for this army: stop trying, the AI will not pick this region for a while
      const rg = a.order.regionId;
      a.badRid = rg; a.badT = tick + 600;
      a.order = { type: ORD.HOLD, regionId: regionAtPos(a.rally.x, a.rally.y) };
      a.auto = 1; a.fail = 0; a.lock = tick + 120; a.target = null;
    }
  }
  /** is the point (x,y) in land that `side` controls, or within SUPPLY_RANGE of a base city (own city not held by the enemy, or a captured one held >= BASE_AFTER) */
  function suppliedAt(x, y, w, side) {
    const r = reg(regionAtPos(x, y));
    if (r && sideOf(w, r.controllerId) === side) return true;
    const R2 = SUPPLY_RANGE * SUPPLY_RANGE;
    for (let s = 1; s <= 2; s++) {
      const arr = sideArr(w, s);
      for (let i = 0; i < arr.length; i++) {
        const k = S.kingdoms.get(arr[i]);
        if (!k) continue;
        for (let j = 0; j < k.cities.length; j++) {
          const c = S.cities.get(k.cities[j]);
          if (!c) continue;
          const dx = c.x - x, dy = c.y - y;
          if (dx * dx + dy * dy > R2) continue;
          if (s === side) { if (!c.occupierId || sideOf(w, c.occupierId) === side) return true; }
          else if (c.occupierId && sideOf(w, c.occupierId) === side) {
            const cr = reg(c.regionId);
            if (cr && S.tick - cr.occSince >= BASE_AFTER) return true;
          }
        }
      }
    }
    return false;
  }
  function supplied(a, w, side) { return suppliedAt(a.rally.x, a.rally.y, w, side); }
  const FEAS_PATH = { partial: true };
  const feasW = { attackers: [0], defenders: [0] };
  /**
   * Can an army starting at (sx,sy) reach (tx,ty) without running out of supply on the way? An army loses ~0.25 supply per tick outside
   * friendly land (attrition below 30) and walks ~0.09 tiles per tick, so only ~14 unsupplied tiles are affordable (the rally point also slows down when the men straggle). Returns the number of
   * unsupplied path tiles (0..), or 9999 when there is no (complete) route / it is absurdly long.
   */
  function routeUnsupplied(sx, sy, tx, ty, race, w, side) {
    routeLen = 9999;
    const p = World.findPath(sx | 0, sy | 0, tx | 0, ty | 0, race, PATH_NODES, FEAS_PATH);
    if (!p || !p.length) return 9999;
    const e = p[p.length - 1];
    if (Math.abs(e[0] - (tx | 0)) > 2 || Math.abs(e[1] - (ty | 0)) > 2) return 9999;
    routeLen = p.length;
    if (p.length > MAX_ROUTE) return 9999;
    let u = 0;
    for (let i = 0; i < p.length; i += 2) if (!suppliedAt(p[i][0] + 0.5, p[i][1] + 0.5, w, side)) u += 2;
    return u;
  }
  const MAX_UNSUP = 14, MAX_ROUTE = 100;
  const ASSAULT_RATIO = 0.85;      // our strike power must be at least this much of the defence before the AI attacks
  let routeLen = 9999, feasLeft = 0;
  /** where the army's order wants its rally point: sets tgt{x,y,cityId} */
  const tgt = { x: 0, y: 0, cityId: 0 };
  function pickTarget(a, w, o, rg, side) {
    tgt.x = rg.cx + 0.5; tgt.y = rg.cy + 0.5; tgt.cityId = 0;
    let best = null, bd = 1e12;
    for (let i = 0; i < rg.cityIds.length; i++) {
      const c = S.cities.get(rg.cityIds[i]);
      if (!c) continue;
      if (o.type === ORD.ATTACK && sideOf(w, c.occupierId || c.kingdomId) === side) continue;      // already ours: nothing to besiege
      const d = Util.dist2(c.x, c.y, a.rally.x, a.rally.y);
      if (d < bd) { bd = d; best = c; }
    }
    if (best) {
      tgt.x = best.x + 0.5; tgt.y = best.y + 0.5;
      if (o.type === ORD.ATTACK) tgt.cityId = best.id;
    }
    if (o.type === ORD.DEFEND) {                 // intercept an enemy army that entered the region
      let ib = null, id2 = 18 * 18;
      for (const e of S.armies.values()) {
        if (e.warId !== w.id || e.dis || e.mode === 'retreat' || sideOf(w, e.kingdomId) === side || e.members.length === 0) continue;
        if (regionAtPos(e.rally.x, e.rally.y) !== rg.id) continue;
        const d = Util.dist2(e.rally.x, e.rally.y, a.rally.x, a.rally.y);
        if (d < id2 && d > 36) { id2 = d; ib = e; }
      }
      if (ib) { tgt.x = ib.rally.x; tgt.y = ib.rally.y; tgt.cityId = -1; }
    }
    return tgt;
  }

  /** the army brain (every ARMY_PERIOD ticks): membership, leader, cohesion, supply, attrition, order -> mode / route */
  function armyThink(a, w, tick) {
    pruneMembers(a);
    const n = a.members.length;
    if (n === 0) { S.armies.delete(a.id); mod().wiped[a.kingdomId] = tick; return; }
    const side = sideOf(w, a.kingdomId);
    if (!side || !kget(a.kingdomId)) { disband(a); return; }
    let ld = S.units.get(a.leaderId);
    if (!ld || ld.armyId !== a.id) electLeader(a);
    // ---- cohesion + power
    let near = 0, pow = 0;
    const rx = a.rally.x, ry = a.rally.y;
    for (let i = 0; i < n; i++) {
      const u = S.units.get(a.members[i]);
      const dx = u.x - rx, dy = u.y - ry;
      if (dx * dx + dy * dy <= 30) near++;
      pow += unitPow(u);
    }
    a.coh = near / n;
    a.pow = Math.round(pow);
    // ---- supply + attrition
    if (supplied(a, w, side)) a.supply = Math.min(100, a.supply + SUPPLY_UP);
    else a.supply = Math.max(0, a.supply - SUPPLY_DOWN);
    if (a.supply < SUPPLY_LOW && tick >= a.att) {
      a.att = tick + ATTRITION_EVERY;
      const dmg = a.supply < 10 ? 2 : 1;
      for (let i = a.members.length - 1; i >= 0; i--) { if (i >= a.members.length) continue; const u = S.units.get(a.members[i]); if (u) Units.damage(u, dmg, 'attrition'); }
      if (a.members.length === 0) return;
    }
    // ---- a shattered army (fewer than MIN_ARMY left) goes home; its soldiers can muster again in a proper army
    if (n < MIN_ARMY && tick - a.born > 150 && !a.dis && a.order.type !== ORD.RETREAT) {
      a.order = { type: ORD.RETREAT, regionId: 0 }; a.auto = 1; a.path = null; a.target = null; a.lock = tick + 100;
    }
    // ---- order -> mode / route
    let o = a.order;
    if (o.type === ORD.RETREAT && !o.regionId) {
      const home = homeOf(a);
      if (!home) { disband(a); return; }
      setMode(a, 'retreat', tick);
      const tx = home.x + 0.5, ty = home.y + 0.5;
      const d = Math.sqrt((tx - rx) * (tx - rx) + (ty - ry) * (ty - ry));
      if (d <= 4.5 || tick - a.since > 2400) { disband(a); return; }
      wantPath(a, tx, ty, tick);
      return;
    }
    let rg = o.regionId ? reg(o.regionId) : null;
    if (!rg) {                                                 // the region is gone: stand where we are
      const here = regionAtPos(rx, ry);
      a.order = { type: ORD.HOLD, regionId: here }; a.path = null; a.target = null;
      setMode(a, 'hold', tick);
      return;
    }
    if (o.type === ORD.ATTACK) {
      const cs = sideOf(w, rg.controllerId);
      if (cs === side) {                                       // region taken: HOLD it (never advance on its own)
        a.order = { type: ORD.HOLD, regionId: rg.id }; o = a.order; a.lock = Math.max(a.lock, tick + 60);
      } else if (cs !== 3 - side && sideOf(w, rg.ownerId) !== 3 - side) {   // no longer an enemy region (peace deal, collapse): hold here
        a.order = { type: ORD.HOLD, regionId: regionAtPos(rx, ry) }; a.path = null; a.target = null;
        setMode(a, 'hold', tick);
        return;
      }
    }
    if (o.type === ORD.RETREAT) {                              // retreat to a region: go, then hold there
      a.order = { type: ORD.HOLD, regionId: o.regionId }; o = a.order;
    }
    const T = pickTarget(a, w, o, rg, side);
    const tx = T.x, ty = T.y, cityId = T.cityId;
    if (!a.target) a.target = { regionId: rg.id, x: tx, y: ty, cityId: cityId > 0 ? cityId : 0 };
    else { a.target.regionId = rg.id; a.target.x = tx; a.target.y = ty; a.target.cityId = cityId > 0 ? cityId : 0; }
    if (a.mode === 'gather') {
      if (a.coh >= 0.7 || tick - a.since >= GATHER_MAX || n <= 2) setMode(a, 'march', tick);
      else return;
    } else if (a.mode === 'retreat') setMode(a, 'march', tick);
    const d = Math.sqrt((tx - rx) * (tx - rx) + (ty - ry) * (ty - ry));
    const inside = regionAtPos(rx, ry) === rg.id;
    const arrived = d <= ARRIVE && (inside || cityId === -1);        // (a post next to the border: keep walking until the rally point is INSIDE the region)
    if (arrived) a.path = null;
    else if (a.mode !== 'gather') wantPath(a, tx, ty, tick);
    let mode;
    if (o.type === ORD.ATTACK) {
      if (cityId > 0 && (arrived || (inside && d <= 9))) mode = 'siege';
      else mode = arrived ? 'hold' : 'march';
    } else mode = arrived && cityId !== -1 ? 'hold' : 'march';          // (cityId -1 = intercepting an enemy army inside the region)
    setMode(a, mode, tick);
  }

  // ================================================================== ORDERS (shared by AI and the player)
  function issue(a, type, rid, auto, tick) {
    const o = a.order;
    if (o && o.type === type && o.regionId === (rid | 0)) { a.auto = auto ? 1 : 0; return false; }
    a.order = { type, regionId: rid | 0 };
    a.auto = auto ? 1 : 0;
    a.path = null; a.pi = 0; a.fail = 0; a.target = null;
    if (a.mode === 'retreat' && type !== ORD.RETREAT) a.mode = 'march';
    if (type !== ORD.RETREAT) a.dis = 0;
    a.lock = tick !== undefined ? tick : 0;
    return true;
  }
  /** same walkable landmass (fords count: shallow water is walkable). World.sameLand instead of Regions.sameLandmass: that cache is empty until tick 600 */
  function reachable(a, rid) {
    const r = reg(rid);
    if (!r) return false;
    return World.sameLand(a.rally.x | 0, a.rally.y | 0, r.cx, r.cy);
  }
  /** validate an order for one army: returns '' when fine, else a reason (Russian) */
  function orderProblem(a, w, type, rid) {
    if (!w || w.ended) return 'война окончена';
    if (a.dis) return 'армия распускается';
    const side = sideOf(w, a.kingdomId);
    if (type === ORD.RETREAT) return '';
    const r = reg(rid);
    if (!r) return 'нет такого региона';
    if (type === ORD.ATTACK) {
      if (sideOf(w, r.ownerId) !== 3 - side && sideOf(w, r.controllerId) !== 3 - side) return 'это не вражеский регион';
      if (!reachable(a, rid)) return 'регион недостижим по суше';
      return '';
    }
    if (type === ORD.HOLD || type === ORD.DEFEND) {
      if (sideOf(w, r.ownerId) !== side && sideOf(w, r.controllerId) !== side) return 'можно держать только свои или занятые регионы';
      if (!reachable(a, rid)) return 'регион недостижим по суше';
      return '';
    }
    return 'неизвестный приказ';
  }

  // ================================================================== AI
  function presenceMap() {
    const need = ((S.mod.regions && S.mod.regions.next) || 0) + 40;
    if (!pres1 || pres1.length < need) { pres1 = new Int32Array(need); pres2 = new Int32Array(need); eli1 = new Int32Array(need); eli2 = new Int32Array(need); presList.length = 0; }
    for (let i = 0; i < presList.length; i++) { const r = presList[i]; pres1[r] = 0; pres2[r] = 0; eli1[r] = 0; eli2[r] = 0; }
    presList.length = 0;
  }
  function addPres(rid, side, k) {
    if (!rid || rid >= pres1.length) return;
    if (pres1[rid] === 0 && pres2[rid] === 0) presList.push(rid);
    if (side === 1) pres1[rid] += k; else pres2[rid] += k;
  }
  /** soldiers of an army that is ORDERED to this region and stands in it: only those can occupy it */
  function addElig(rid, side, k) { if (rid && rid < eli1.length) { if (side === 1) eli1[rid] += k; else eli2[rid] += k; } }
  /** first undone goal a kingdom (or its side's leader) works on, 0 when none */
  function pendingGoal(w, kid, side) {
    let fb = 0;
    for (let i = 0; i < w.goals.length; i++) {
      const g = w.goals[i];
      if (g.done) continue;
      const gr = reg(g.regionId);
      if (gr && gr.controllerId && gr.controllerId !== gr.ownerId && !sideOf(w, gr.controllerId)) continue;      // a third kingdom holds it (another war): nothing to besiege here
      if (g.kid === kid) return g.regionId;
      if (!fb && sideOf(w, g.kid) === side) fb = g.regionId;
    }
    return fb;
  }
  /** a goal of `side` on that region that is not done yet */
  function openGoal(w, side, rid) {
    for (let i = 0; i < w.goals.length; i++) { const g = w.goals[i]; if (g.regionId === rid && !g.done && sideOf(w, g.kid) === side) return true; }
    return false;
  }
  function isCapitalRegion(r) {
    for (let i = 0; i < r.cityIds.length; i++) { const c = S.cities.get(r.cityIds[i]); if (c) { const k = S.kingdoms.get(c.kingdomId); if (k && k.capitalId === c.id) return true; } }
    return false;
  }
  const thr = [];
  /** own-side regions in danger: enemy armies inside, enemy-held (to retake) or the enemy's declared goals */
  function computeThreats(w, side, out) {
    out.length = 0;
    const enemy = 3 - side;
    for (const r of S.regions.values()) {
      if (sideOf(w, r.ownerId) !== side) continue;
      const lost = sideOf(w, r.controllerId) === enemy;
      const pr = enemy === 1 ? pres1[r.id] : pres2[r.id];
      const goal = !lost && openGoal(w, enemy, r.id);
      if (!lost && !pr && !goal) continue;
      let prio = (lost ? 3 : 0) + (pr ? 2 : 0) + (goal ? 1.5 : 0) + cityCountOf(r) * 1.5;
      if (isCapitalRegion(r)) prio += 3;
      out.push({ rid: r.id, prio, lost, pres: pr, kid: r.ownerId });
    }
    out.sort((x, y) => y.prio - x.prio || x.rid - y.rid);
  }
  function enemyPowerIn(w, side, rid) { return powerIn(w, 3 - side, rid); }
  /** fighting power of the armies of side `s` standing in region `rid` */
  function powerIn(w, s, rid) {
    let p = 0;
    for (const e of S.armies.values()) {
      if (e.warId !== w.id || sideOf(w, e.kingdomId) !== s || e.dis || e.mode === 'retreat') continue;
      if (regionAtPos(e.rally.x, e.rally.y) === rid) p += e.pow;
    }
    return p;
  }
  /** power the enemy side can bring to bear on a region: its armies standing in it or ordered to defend / hold it */
  function defencePower(w, side, rid) {
    let p = 0;
    for (const e of S.armies.values()) {
      if (e.warId !== w.id || sideOf(w, e.kingdomId) === side || e.dis || e.mode === 'retreat' || e.members.length === 0) continue;
      if (e.order.regionId === rid || regionAtPos(e.rally.x, e.rally.y) === rid) p += e.pow;
    }
    return p;
  }
  /** power of our side's armies that are able to take part in an offensive (not retreating, in supply) */
  function strikePower(w, side) {
    let p = 0;
    for (const e of S.armies.values()) {
      if (e.warId !== w.id || sideOf(w, e.kingdomId) !== side || e.dis || e.mode === 'retreat' || e.supply < SUPPLY_LOW || e.members.length === 0) continue;
      p += e.pow;
    }
    return p;
  }
  function covered(w, side, rid, except) {
    for (const o of S.armies.values()) {
      if (o === except || o.warId !== w.id || o.dis || sideOf(w, o.kingdomId) !== side) continue;
      if (o.order.regionId === rid && o.order.type !== ORD.RETREAT && o.members.length >= MIN_ARMY) return true;
    }
    return false;
  }
  /**
   * Orders for the armies of one kingdom in one war. AI kingdoms: always. Commanded kingdoms (k.cmd): `force` (declare / new goal) gives
   * idle armies (hold / defend, or finished attacks) the pending goal; the periodic pass only defends their own regions, and never touches
   * armies the player has ordered himself (auto === 0) unless they stand idle on `force`.
   */
  function aiKingdom(w, kid, tick, force) {
    const k = kget(kid);
    if (!k) return;
    const side = sideOf(w, kid);
    const cmd = k.cmd === true;
    const mine = armiesOfWar(w, kid);
    if (!mine.length) return;
    mine.sort((x, y) => y.pow - x.pow || x.id - y.id);
    const goalRid = pendingGoal(w, kid, side);
    computeThreats(w, side, thr);
    let freeAttackers = 0;
    for (let i = 0; i < mine.length; i++) if (mine[i].order.type === ORD.ATTACK && isGoal(w, side, mine[i].order.regionId)) freeAttackers++;
    for (let i = 0; i < mine.length; i++) {
      const a = mine[i];
      if (a.dis) continue;
      const o = a.order;
      const idle = o.type === ORD.HOLD || o.type === ORD.DEFEND || (o.type === ORD.ATTACK && sideOf(w, (reg(o.regionId) || {}).controllerId) === side);
      if (!a.auto && !idle) continue;                           // an order given from outside (player / god) that is still in progress is never overridden
      if (cmd && !(a.auto || (force && idle))) continue;       // a commanded kingdom: only its automatic armies are managed (idle ones when a goal is added)
      if (tick < a.lock && !force) continue;
      const here = regionAtPos(a.rally.x, a.rally.y);
      const hr = reg(here);
      // 1. cut off deep in enemy land: pull back
      if (!cmd && a.supply < 15 && hr && sideOf(w, hr.controllerId) !== side) {
        if (issue(a, ORD.RETREAT, 0, true, tick + 200)) a.lock = tick + 200;
        continue;
      }
      // 1b. crushed in the field: an attacking army that is outnumbered 2:1 where it stands falls back instead of dying to the last man
      if (!cmd && o.type === ORD.ATTACK && hr && hr.id === o.regionId && a.members.length >= MIN_ARMY) {
        const ep = powerIn(w, 3 - side, hr.id);
        if (ep > 0 && ep > 2 * powerIn(w, side, hr.id)) {
          if (issue(a, ORD.RETREAT, 0, true, tick + 300)) a.lock = tick + 300;
          continue;
        }
      }
      // 2. defend / retake threatened own regions
      let did = false;
      for (let t = 0; t < thr.length && t < 6 && !did; t++) {
        const th = thr[t];
        if (cmd && th.kid !== kid) continue;                                  // a commanded kingdom only guards its own land
        if (covered(w, side, th.rid, a)) continue;
        const tr = reg(th.rid);
        if (!tr || !reachable(a, th.rid)) continue;
        if (a.badRid === th.rid && tick < a.badT) continue;
        const dist = Util.dist(a.rally.x, a.rally.y, tr.cx, tr.cy);
        if (dist > 60) continue;
        // an attacker with a pending goal keeps at least one army on the offensive unless a capital / city is lost
        if (!cmd && goalRid && freeAttackers <= 1 && o.type === ORD.ATTACK && isGoal(w, side, o.regionId) && !(th.lost && (th.prio >= 4.5))) continue;
        const ep = th.lost ? enemyPowerIn(w, side, th.rid) : 0;
        if (th.lost && ep > a.pow * 1.4) continue;                            // too weak to retake it now: wait for reinforcements / merges
        // a doom stack on the offensive is not pulled back by a raiding party: small armies (or fresh recruits) answer small threats
        if (!cmd && !th.lost && o.type === ORD.ATTACK && isGoal(w, side, o.regionId) && a.pow > 2.5 * Math.max(enemyPowerIn(w, side, th.rid), 500)) continue;
        const type = th.lost ? ORD.ATTACK : ORD.DEFEND;
        if (o.type === ORD.ATTACK && isGoal(w, side, o.regionId)) freeAttackers--;
        if (issue(a, type, th.rid, true, tick)) a.lock = tick + 150;
        did = true;
      }
      if (did) continue;
      // 3. the war goal (one at a time)
      if (goalRid && (!cmd || force) && !(!cmd && !force && tick < ((w.pz && w.pz[kid]) || 0))) {
        const gr = reg(goalRid);
        if (gr && a.supply >= SUPPLY_LOW && reachable(a, goalRid) && !(a.badRid === goalRid && tick < a.badT) && a.coh > 0.4 &&
            (sideOf(w, gr.controllerId) !== side) && (!cmd || idle)) {
          if (o.type === ORD.ATTACK && o.regionId === goalRid) continue;
          if (o.type === ORD.ATTACK && !idle) continue;
          if (!cmd) {
            // never feed an army piecemeal into a stronger defence: wait until the whole side can match it
            const dp = defencePower(w, side, goalRid);
            if (dp > 0 && strikePower(w, side) < dp * ASSAULT_RATIO) { a.lock = tick + 100; continue; }
            // never march into a supply desert: the route must stay (mostly) inside land we feed
            if (feasLeft <= 0) continue;
            feasLeft--;
            const T = pickTarget(a, w, { type: ORD.ATTACK, regionId: goalRid }, gr, side);
            if (routeUnsupplied(a.rally.x, a.rally.y, T.x, T.y, a.race, w, side) > MAX_UNSUP) { a.badRid = goalRid; a.badT = tick + 900; continue; }
          }
          if (issue(a, ORD.ATTACK, goalRid, true, tick)) { a.lock = tick + 60; if (a.mode === 'hold') a.mode = 'march'; }
          continue;
        }
      }
      // 4. nothing to do: make sure the order points somewhere sensible
      if (o.type === ORD.RETREAT) continue;
      const rg = o.regionId ? reg(o.regionId) : null;
      if (!rg) { const home = S.cities.get(a.cityId); issue(a, ORD.HOLD, home ? home.regionId : here, true, tick); }
    }
  }
  const LOSS_LIMIT = 28, OFFENSIVE_PAUSE = 2400;
  /**
   * An offensive that bleeds without gaining ground is called off: after LOSS_LIMIT deaths with no region changing hands the kingdom stops
   * attacking its goals for a while (its armies fall back to hold at home and are refilled), instead of feeding fresh recruits into the meat grinder.
   */
  function checkPause(w, kid, tick) {
    const cur = w.losses[kid] || 0;
    if (!w.lm || !w.lt || !w.pz) { w.lm = w.lm || {}; w.lt = w.lt || {}; w.pz = w.pz || {}; }
    if (w.lt[kid] !== w.lastChange) { w.lt[kid] = w.lastChange; w.lm[kid] = cur; return; }       // progress: the loss budget starts anew
    if (cur - (w.lm[kid] || 0) < LOSS_LIMIT + 0.7 * soldiersOf(w, kid) || tick < (w.pz[kid] || 0)) return;       // (bigger armies can afford bigger losses)
    w.pz[kid] = tick + OFFENSIVE_PAUSE; w.lm[kid] = cur;
    for (const a of S.armies.values()) {
      if (a.warId !== w.id || a.kingdomId !== kid || a.dis || a.order.type !== ORD.ATTACK || !isGoal(w, sideOf(w, kid), a.order.regionId)) continue;
      const home = homeOf(a);
      if (home && issue(a, ORD.HOLD, home.regionId | 0, true, tick)) a.lock = tick + OFFENSIVE_PAUSE;
    }
  }
  function aiWar(w, tick) {
    presenceMap();
    for (const a of S.armies.values()) {
      if (a.warId !== w.id || a.dis || a.members.length === 0) continue;
      const s = sideOf(w, a.kingdomId);
      if (!s || a.mode === 'retreat') continue;
      addPres(regionAtPos(a.rally.x, a.rally.y), s, 1);
    }
    for (let s = 1; s <= 2; s++) {
      const arr = sideArr(w, s).slice();
      for (let i = 0; i < arr.length; i++) { const k = kget(arr[i]); if (k && k.cmd !== true) checkPause(w, arr[i], tick); aiKingdom(w, arr[i], tick, false); }
    }
  }

  // ================================================================== OCCUPATION
  function cbFighters(u) {
    if (u.armyId || u.state !== 'fight' || u.hp <= 0 || !(u.weapon > 0)) return;       // armed AND fighting right now (a villager's last stand does not block the occupation)
    if (sideOf(cfW, u.kingdomId) !== cfSide) return;
    if (S.region[(u.y | 0) * S.w + (u.x | 0)] === cfRid) cfN++;
  }
  /** armed resistance of `side` inside the region: army members (counted by the caller) + armed non-army citizens that are fighting right now */
  function fighters(w, r, side) {
    cfW = w; cfRid = r.id; cfSide = side; cfN = 0;
    Units.nearby(r.cx + 0.5, r.cy + 0.5, Math.sqrt(r.tiles) * 1.1 + 4, cbFighters);      // (Regions.bbox is empty until tick 600)
    return cfN;
  }
  function takeRegion(w, r, X, tick) {
    const os = sideOf(w, r.ownerId);
    let newCtl = 0;
    if (os === X) newCtl = r.ownerId;                            // retaking our own land
    else {
      // the kingdom of side X with the most soldiers in the region
      let bk = 0, bn = -1;
      const arr = sideArr(w, X);
      for (let i = 0; i < arr.length; i++) {
        let nn = 0;
        for (const a of S.armies.values()) {
          if (a.warId !== w.id || a.kingdomId !== arr[i] || a.dis || a.mode === 'retreat') continue;
          for (let j = 0; j < a.members.length; j++) { const u = S.units.get(a.members[j]); if (u && regionAtPos(u.x, u.y) === r.id) nn++; }
        }
        if (nn > bn) { bn = nn; bk = arr[i]; }
      }
      newCtl = bk;
    }
    if (!newCtl || !kget(newCtl)) return false;
    const was = [];
    for (let i = 0; i < r.cityIds.length; i++) { const c = S.cities.get(r.cityIds[i]); if (c && c.occupierId) was.push(c); }
    const cost = regionCost(r);
    if (!Regions.setController(r.id, newCtl, 'war')) return false;
    w.lastChange = tick;
    const retake = os === X;
    if (retake) {
      Log.add('Регион ' + rname(r.id) + ' освобождён королевством ' + kname(newCtl), LOG.WAR, r.cx, r.cy, newCtl);
      for (let i = 0; i < was.length; i++) if (!was[i].occupierId) Log.add('Город «' + was[i].name + '» освобождён', LOG.WAR, was[i].x, was[i].y, newCtl);
      w.ev[newCtl] = clamp((w.ev[newCtl] || 0) + cost * 0.4, -30, 40);
    } else {
      Log.add('Регион ' + rname(r.id) + ' оккупирован королевством ' + kname(newCtl), LOG.WAR, r.cx, r.cy, newCtl);
      w.ev[newCtl] = clamp((w.ev[newCtl] || 0) + cost * 0.15, -30, 40);
      Hist.add(S.kingdoms.get(newCtl), 'Оккупировано: «' + r.name + '»');
    }
    // the loser of the region feels it
    const lose = retake ? 0 : r.ownerId;
    if (lose && w.wear[lose] !== undefined) w.wear[lose] = Math.min(100, w.wear[lose] + 1.5);
    updateGoals(w);
    return true;
  }
  function updateGoals(w) {
    for (let i = 0; i < w.goals.length; i++) {
      const g = w.goals[i], r = reg(g.regionId);
      const side = sideOf(w, g.kid);
      g.done = !!(r && side && (sideOf(w, r.controllerId) === side));
    }
  }
  function processOccupation(w, tick) {
    presenceMap();
    let any = false;
    for (const a of S.armies.values()) {
      if (a.warId !== w.id || a.dis || a.mode === 'retreat') continue;
      const s = sideOf(w, a.kingdomId);
      if (!s) continue;
      const orid = a.order.type !== ORD.RETREAT ? a.order.regionId : 0;
      const eligible = orid > 0 && regionAtPos(a.rally.x, a.rally.y) === orid;
      if (eligible) addPres(orid, s, 0);
      for (let j = 0; j < a.members.length; j++) {
        const u = S.units.get(a.members[j]);
        if (!u) continue;
        const rid = regionAtPos(u.x, u.y);
        if (rid) { addPres(rid, s, 1); any = true; }
        // the garrison of a post inside the region occupies it (a post at the border has soldiers standing on the other side of the line)
        if (eligible) { const dx = u.x - a.rally.x, dy = u.y - a.rally.y; if (dx * dx + dy * dy <= 36) { addElig(orid, s, 1); any = true; } }
      }
    }
    if (!any && !hasOcc(w)) return;
    // running timers need soldiers who can still occupy
    for (const rid in w.occ) { if (!(eli1[rid] > 0 || eli2[rid] > 0)) delete w.occ[rid]; }
    for (let q = 0; q < presList.length; q++) {
      const rid = presList[q], r = reg(rid);
      if (!r) continue;
      const os = sideOf(w, r.ownerId), cs = sideOf(w, r.controllerId);
      let taken = false;
      for (let X = 1; X <= 2 && !taken; X++) {
        const nX = X === 1 ? eli1[rid] : eli2[rid];
        const Y = 3 - X;
        const rec = w.occ[rid];
        if (nX === 0 || cs !== Y) { if (rec && rec.x === X) delete w.occ[rid]; continue; }           // only land held by the ENEMY side can be taken (a third party's occupation is left alone)
        const need = os === X ? RETAKE_MIN : OCC_MIN;
        const nY = Y === 1 ? pres1[rid] : pres2[rid];           // every armed soldier of the other side in the region resists, whatever its orders
        const D = nY + (nY === 0 ? fighters(w, r, Y) : 0);
        if (nX >= need && D === 0 && nX >= OCC_RATIO * D) {
          const rr = w.occ[rid] && w.occ[rid].x === X ? w.occ[rid] : (w.occ[rid] = { x: X, n: 0 });
          rr.n += OCC_PERIOD;
          if (rr.n >= OCC_TICKS) { delete w.occ[rid]; if (takeRegion(w, r, X, tick)) taken = true; }
        } else if (rec && rec.x === X) delete w.occ[rid];
      }
    }
  }
  function hasOcc(w) { for (const k in w.occ) { void k; return true; } return false; }

  // ================================================================== SCORE, WEARINESS, EXHAUSTION
  function weariness(kid) {
    let m = 0;
    for (const w of S.wars.values()) { if (w.ended) continue; const v = w.wear[kid]; if (v > m) m = v; }
    return Math.round(m * 10) / 10;
  }
  function scoreWar(w, tick) {
    updateGoals(w);
    for (let s = 1; s <= 2; s++) {
      const arr = sideArr(w, s);
      const lead = leadOf(w, s), enemyLead = leadOf(w, 3 - s);
      for (let i = 0; i < arr.length; i++) {
        const kid = arr[i];
        if (!kget(kid)) continue;
        let occ = 0, hold = 0, lostOwn = 0;
        for (const r of S.regions.values()) {
          const os = sideOf(w, r.ownerId), cs = sideOf(w, r.controllerId);
          if (os === 3 - s && cs === s) {
            const cost = regionCost(r);
            const share = (kid === lead || r.controllerId === kid) ? 1 : 0.5;
            occ += cost * (isGoal(w, s, r.id) ? 1 : 0.55) * share;
          } else if (s === 2 && os === 2 && cs === 2 && isGoal(w, 1, r.id)) hold += regionCost(r) * 0.25;
          if (os === s && cs === 3 - s && r.ownerId === kid) lostOwn++;
        }
        let cap = 0;
        const ek = S.kingdoms.get(enemyLead), cc = ek ? S.cities.get(ek.capitalId) : null;
        if (cc && cc.occupierId && sideOf(w, cc.occupierId) === s) cap = 20;
        const target = clamp(occ + hold + cap + (w.ev[kid] || 0), 0, 100);
        let cur = w.score[kid] || 0;
        cur += (target - cur) * 0.2;
        if (Math.abs(target - cur) < 0.05) cur = target;
        w.score[kid] = Math.round(cur * 100) / 100;
        w.ev[kid] = Math.round((w.ev[kid] || 0) * 0.997 * 100) / 100;
        // weariness: slow with time, faster with lost land (casualties add instantly in onUnitDied)
        const wv = (w.wear[kid] || 0) + 0.09 + lostOwn * 0.05;
        w.wear[kid] = Math.round(Math.min(100, wv) * 100) / 100;
      }
    }
  }
  function soldiersOf(w, kid) { let n = 0; for (const a of S.armies.values()) if (a.warId === w.id && a.kingdomId === kid) n += a.members.length; return n; }
  function recruitable(kid) {
    const k = S.kingdoms.get(kid); let n = 0;
    if (!k) return 0;
    for (let i = 0; i < k.cities.length; i++) { const c = S.cities.get(k.cities[i]); if (!c) continue; recruitsOf(c, recBuf); n += recBuf.length; }
    return n;
  }
  function exhaustCheck(w, tick) {
    if (!mod().autoPeace) return;
    if (tick - w.started >= STALEMATE && tick - w.lastChange >= STALEMATE) { exhaust(w, 'stalemate', 0); return; }
    for (let s = 1; s <= 2; s++) {
      const p = leadOf(w, s), k = kget(p);
      if (!k) continue;
      if (typeof k.stability === 'number' && k.stability < 20) {
        if (!w.low[p]) w.low[p] = tick;
        else if (tick - w.low[p] >= 120) { exhaust(w, 'stability', s); return; }
      } else if (w.low[p]) delete w.low[p];
      if (tick - w.started > 600 && soldiersOf(w, p) === 0 && recruitable(p) < MIN_ARMY) {
        if (!w.mp[p]) w.mp[p] = tick;
        else if (tick - w.mp[p] >= 600) { exhaust(w, 'manpower', s); return; }
      } else if (w.mp[p]) delete w.mp[p];
    }
    const a = leadOf(w, 1), d = leadOf(w, 2);
    if ((w.wear[a] || 0) >= 95 && (w.wear[d] || 0) >= 95) exhaust(w, 'weary', 0);
  }
  /** value of the enemy land a side holds right now */
  function heldValue(w, s) { let v = 0; const h = heldRegions(w, s); for (let i = 0; i < h.length; i++) v += regionCost(reg(h[i])); return v; }
  /**
   * autoPeace: the war runs out of steam. The side that holds more enemy land wins (a collapsed side loses; equal / nothing held: the score
   * decides when the lead is >= 12, else a white peace). The winner gets the goal regions it holds, plus other held regions as far as its score pays.
   */
  function exhaust(w, why, loserSide) {
    const sa = w.score[leadOf(w, 1)] || 0, sd = w.score[leadOf(w, 2)] || 0;
    const ha = heldValue(w, 1), hd = heldValue(w, 2);
    let winSide = 0;
    if (loserSide) winSide = 3 - loserSide;
    else if (ha !== hd) winSide = ha > hd ? 1 : 2;
    else if (sa - sd >= 12) winSide = 1;
    else if (sd - sa >= 12) winSide = 2;
    let winner = 0, regions = [];
    if (winSide) {
      winner = leadOf(w, winSide);
      const held = heldRegions(w, winSide);
      const allow = allowanceOf(w, winner, held) + 4;
      held.sort((x, y) => (isGoal(w, winSide, y) ? 1 : 0) - (isGoal(w, winSide, x) ? 1 : 0) || regionCost(reg(y)) - regionCost(reg(x)) || x - y);
      let sum = 0;
      for (let i = 0; i < held.length; i++) {
        const c = regionCost(reg(held[i]));
        if (isGoal(w, winSide, held[i]) || sum + c <= allow) { regions.push(held[i]); sum += c; }       // the goals are the winner's by right
      }
      if (!regions.length) winner = 0;
    }
    const text = why === 'stalemate' ? 'затянувшаяся война затихла' : why === 'stability' ? 'страну охватила смута' : why === 'manpower' ? 'армия исчерпана' : 'обе стороны истощены';
    finishWar(w, 'exhaustion', { winner, regions, vassal: false, note: text, why });
  }
  /** regions controlled by side `s` and owned by the other side */
  function heldRegions(w, s) {
    const out = [];
    for (const r of S.regions.values()) if (sideOf(w, r.ownerId) === 3 - s && sideOf(w, r.controllerId) === s) out.push(r.id);
    out.sort((a, b) => a - b);
    return out;
  }
  function allowanceOf(w, kid, rids) {
    const side = sideOf(w, kid);
    let a = w.score[kid] || 0;
    for (let i = 0; i < rids.length; i++) {
      const r = reg(rids[i]);
      if (!r) continue;
      if (isGoal(w, side, r.id) || (Regions.hasClaim(r.id, kid))) a += regionCost(r) * 0.25;
    }
    return a;
  }

  // ================================================================== PEACE
  function revertControllers() {
    for (const r of S.regions.values()) {
      if (!r.controllerId || !r.ownerId || r.controllerId === r.ownerId) continue;
      if (!atWar(r.controllerId, r.ownerId)) Regions.setController(r.id, r.ownerId, 'peace');
    }
  }
  /**
   * End a war. cfg: {winner kid|0, regions [rid] (transferred to the winner's side), vassal bool, note, quiet, truce ticks}.
   * Order matters: mark ended first (Kingdoms.transferCity may destroy a kingdom -> it calls War.end / godPeace for the same war).
   */
  function finishWar(w, how, cfg) {
    if (!w || w.ended) return false;
    cfg = cfg || {};
    w.ended = true; w.endedAt = S.tick; w.how = how;
    rebuildPairs();
    const regs = cfg.regions || [];
    const winner = cfg.winner | 0;
    const names = [];
    const nA = kname(w.aggressor), nD = kname(w.defender), nW = winner ? kname(winner) : '';       // (a kingdom may fall while its last region changes hands)
    for (let i = 0; i < regs.length; i++) {
      const r = reg(regs[i]);
      if (!r || !winner || !kget(winner)) continue;
      const ctl = r.controllerId && sideOf(w, r.controllerId) === sideOf(w, winner) ? r.controllerId : winner;
      const newOwner = kget(ctl) ? ctl : winner;
      const cities = r.cityIds.slice();
      names.push('«' + r.name + '»');
      Regions.setOwner(r.id, newOwner, 'transfer');
      for (let j = 0; j < cities.length; j++) {
        const c = S.cities.get(cities[j]);
        if (c && c.kingdomId !== newOwner && kget(newOwner)) {
          try { Kingdoms.transferCity(c.id, newOwner, 'peace'); } catch (e) { /* keep going */ }
        }
      }
    }
    if (cfg.vassal && winner && w) {
      const ws = sideOf(w, winner);
      const loser = ws ? leadOf(w, 3 - ws) : 0;
      if (loser && kget(loser) && kget(winner)) {
        let ok = false;
        try { ok = !!Kingdoms.annex(loser, winner, 'vassal'); } catch (e) { ok = false; }
        if (!ok) { const lk = kget(loser); if (lk && !lk.overlordId) { lk.overlordId = winner; lk.vassalSince = S.tick; Log.add('Королевство ' + kname(loser) + ' стало вассалом королевства ' + kname(winner), LOG.KINGDOM, -1, -1, winner); } }
      }
    }
    revertControllers();
    // armies of this war go home and disband (or disband on the spot when already close)
    for (const a of Array.from(S.armies.values())) {
      if (a.warId !== w.id) continue;
      const home = homeOf(a);
      if (!home || Util.dist(a.rally.x, a.rally.y, home.x, home.y) <= 14) { disband(a); continue; }
      a.dis = 1; a.order = { type: ORD.RETREAT, regionId: 0 }; a.mode = 'retreat'; a.since = S.tick; a.path = null; a.target = null; a.auto = 1;
    }
    // truce + state for every pair of the two sides
    const until = S.tick + (cfg.truce !== undefined ? cfg.truce : TRUCE);
    for (let i = 0; i < w.attackers.length; i++) for (let j = 0; j < w.defenders.length; j++) {
      const x = w.attackers[i], y = w.defenders[j];
      if (!S.kingdoms.has(x) || !S.kingdoms.has(y)) continue;
      if (!atWar(x, y)) { setTruce(x, y, until); dipState(x, y, REL.PEACE); }
    }
    delete mod().offers[w.id];
    const ka = S.kingdoms.get(w.aggressor), kd = S.kingdoms.get(w.defender);
    if (!cfg.quiet) {
      let msg;
      if (cfg.note && !names.length) msg = 'Заключён мир между ' + nA + ' и ' + nD + ': ' + cfg.note;
      else if (names.length) msg = 'Заключён мир между ' + nA + ' и ' + nD + ': ' + nW + ' получает ' + (names.length > 1 ? 'регионы ' : 'регион ') + names.join(', ');
      else msg = 'Заключён мир между ' + nA + ' и ' + nD + ': белый мир';
      const c0 = ka ? S.cities.get(ka.capitalId) : null;
      Log.add(msg, LOG.PEACE, c0 ? c0.x : -1, c0 ? c0.y : -1, w.aggressor);
    }
    if (ka) Hist.add(ka, 'Мир с ' + nD);
    if (kd) Hist.add(kd, 'Мир с ' + nA);
    w.hist.push({ t: S.tick, how, regions: regs.slice(), winner, why: cfg.why || '' });
    if (w.hist.length > 12) w.hist.shift();
    S.touchRegions();
    Bus.emit('warEnded', w, how);
    return true;
  }
  function peaceOffer(warId, fromKid, terms) {
    const w = S.wars.get(warId);
    terms = terms || {};
    const res = { ok: false, accepted: false, pending: false, reason: '', cost: 0, allowance: 0 };
    if (!w || w.ended) { res.reason = 'война окончена'; return res; }
    const X = sideOf(w, fromKid);
    if (!X) { res.reason = 'это королевство не участвует в войне'; return res; }
    const Y = 3 - X;
    const wanted = normRegions(terms.regions);
    const rids = [];
    for (let i = 0; i < wanted.length; i++) {
      const r = reg(wanted[i]);
      if (sideOf(w, r.ownerId) !== Y) { res.reason = 'регион ' + rname(r.id) + ' не принадлежит противнику'; return res; }
      if (sideOf(w, r.controllerId) !== X) { res.reason = 'регион ' + rname(r.id) + ' не оккупирован вами'; return res; }
      rids.push(r.id);
    }
    const cost = peaceCost(warId, rids);
    const allow = allowanceOf(w, fromKid, rids);
    let vassalCost = 0;
    if (terms.vassalize) {
      const loser = leadOf(w, Y);
      const lk = kget(loser);
      if (!lk || lk.overlordId) { res.reason = 'нельзя сделать вассалом'; return res; }
      vassalCost = 50 + 4 * Regions.ofKingdom(loser).length;
    }
    res.cost = cost + vassalCost; res.allowance = Math.round(allow * 10) / 10;
    if (res.cost > allow + 1e-9) { res.reason = 'не хватает очков войны: нужно ' + Math.ceil(res.cost) + ', есть ' + Math.floor(allow); return res; }
    res.ok = true;
    const rcv = leadOf(w, Y), rk = kget(rcv);
    if (!rk) { res.accepted = true; finishWar(w, 'peace', { winner: fromKid, regions: rids, vassal: !!terms.vassalize }); return res; }
    if (rk.cmd === true) {                                        // a human decides: the offer waits
      mod().offers[w.id] = { from: fromKid, to: rcv, regions: rids, vassal: !!terms.vassalize, tick: S.tick };
      res.pending = true; res.reason = 'ждёт решения командующего';
      return res;
    }
    const verdict = judge(w, fromKid, rcv, res.cost, rids.length, !!terms.vassalize);
    res.reason = verdict.reason;
    if (verdict.accept) { res.accepted = true; finishWar(w, 'peace', { winner: rids.length || terms.vassalize ? fromKid : 0, regions: rids, vassal: !!terms.vassalize }); }
    return res;
  }
  /** will the AI kingdom `to` accept `from`'s demand? */
  function judge(w, from, to, cost, nRegions, vassal) {
    const sx = w.score[from] || 0, sy = w.score[to] || 0, wy = w.wear[to] || 0;
    if (cost === 0 && !vassal) {
      if (sy > sx + 20 && wy < 60) return { accept: false, reason: 'противник считает, что побеждает, и отказывается' };
      return { accept: true, reason: 'белый мир принят' };
    }
    if (vassal) {
      if (wy >= 80 || sx - sy >= 40) return { accept: true, reason: 'вынужденно согласился на вассалитет' };
      return { accept: false, reason: 'противник отказался стать вассалом' };
    }
    if (wy >= 70) return { accept: true, reason: 'противник истощён и согласился' };
    if (sx - sy >= 20 && sx >= 25) return { accept: true, reason: 'противник проигрывает и согласился' };
    if (cost <= 0.5 * sy + 6) return { accept: true, reason: 'требования скромны, мир принят' };
    return { accept: false, reason: 'противник отказался: требования слишком велики' };
  }
  function peaceCost(warId, regionIds) {
    let c = 0;
    const list = normRegions(regionIds);
    for (let i = 0; i < list.length; i++) c += regionCost(reg(list[i]));
    void warId;
    return c;
  }
  function respondOffer(warId, accept) {
    const m = mod(), o = m.offers[warId], w = S.wars.get(warId);
    if (!o || !w || w.ended) { delete m.offers[warId]; return false; }
    delete m.offers[warId];
    if (!accept) return false;
    return finishWar(w, 'peace', { winner: o.from, regions: o.regions, vassal: !!o.vassal });
  }
  function forcePeace(warId, terms) {
    const w = S.wars.get(warId);
    if (!w || w.ended) return false;
    terms = terms || {};
    const wanted = normRegions(terms.regions);
    let winner = terms.winner | 0;
    if (!winner || !sideOf(w, winner)) {
      const sa = w.score[leadOf(w, 1)] || 0, sd = w.score[leadOf(w, 2)] || 0;
      winner = wanted.length || terms.vassalize ? (sa >= sd ? leadOf(w, 1) : leadOf(w, 2)) : 0;
    }
    const ws = winner ? sideOf(w, winner) : 0;
    const rids = [];
    for (let i = 0; i < wanted.length; i++) {
      const r = reg(wanted[i]);
      if (ws && sideOf(w, r.ownerId) === 3 - ws && sideOf(w, r.controllerId) === ws) rids.push(r.id);
    }
    return finishWar(w, 'force', { winner, regions: rids, vassal: !!terms.vassalize });
  }
  function end(warId, how) {
    const w = S.wars.get(warId);
    if (!w || w.ended) return false;
    return finishWar(w, how || 'end', { winner: 0, regions: [], quiet: how === 'destroyed' || how === 'vassal' || how === 'god' });
  }
  function godPeace(kid) {
    let any = false;
    for (const w of Array.from(S.wars.values())) {
      if (w.ended) continue;
      const s = sideOf(w, kid);
      if (!s) continue;
      const lead = leadOf(w, s);
      if (lead === kid || (w.attackers.length + w.defenders.length) <= 2 || !kget(kid) || sideArr(w, s).length <= 1) {
        any = finishWar(w, 'god', { winner: 0, regions: [], truce: 1800, quiet: true }) || any;      // (Powers / Kingdoms write the headline themselves)
      } else {
        leaveWar(w, kid);
        any = true;
      }
    }
    return any;
  }
  /** an ally leaves the war (its armies go home); the others fight on */
  function leaveWar(w, kid) {
    const s = sideOf(w, kid);
    if (!s) return;
    const arr = sideArr(w, s);
    arr.splice(arr.indexOf(kid), 1);
    for (const a of Array.from(S.armies.values())) if (a.warId === w.id && a.kingdomId === kid) disband(a);
    rebuildPairs();
    for (const o of sideArr(w, 3 - s)) { if (S.kingdoms.has(o) && S.kingdoms.has(kid) && !atWar(o, kid)) { setTruce(o, kid, S.tick + 1200); dipState(o, kid, REL.PEACE); } }
    revertControllers();
    S.touchRegions();
  }

  // ================================================================== DECLARATION
  function canDeclare(aggKid, defKid, casus) {
    const ka = kget(aggKid), kd = kget(defKid);
    if (!ka || !kd) return { ok: false, reason: 'королевство не существует' };
    if (aggKid === defKid) return { ok: false, reason: 'нельзя воевать с самим собой' };
    if (atWar(aggKid, defKid)) return { ok: false, reason: 'война уже идёт' };
    if (!rgOn()) return { ok: false, reason: 'нет карты регионов' };
    if (casus !== 'god' && casus !== 'rebel') {
      if (ka.overlordId === defKid) return { ok: false, reason: 'нельзя воевать с сюзереном' };
      if (kd.overlordId === aggKid) return { ok: false, reason: 'нельзя воевать с вассалом' };
      if (alliedTo(aggKid, defKid)) return { ok: false, reason: 'это ваш союзник' };
      if (inTruce(aggKid, defKid)) return { ok: false, reason: 'действует перемирие' };
    }
    return { ok: true, reason: '' };
  }
  function goalRank(aggKid, defKid) {
    const ids = Regions.attackable(aggKid, defKid);
    const ka = S.kingdoms.get(aggKid), kd = S.kingdoms.get(defKid);
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      const r = reg(ids[i]);
      if (!r || r.ownerId !== defKid) continue;
      if (r.controllerId && r.controllerId !== defKid && r.controllerId !== aggKid && !alliedTo(aggKid, r.controllerId)) continue;       // occupied by a third kingdom
      let dist = 1e9;
      if (ka) for (let j = 0; j < ka.cities.length; j++) { const c = S.cities.get(ka.cities[j]); if (c) dist = Math.min(dist, Util.dist(c.x, c.y, r.cx, r.cy)); }
      if (dist > 1e8) dist = 40;
      let sc = (Regions.hasClaim(r.id, aggKid) ? 5 : 0) + cityCountOf(r) * 3 + Math.min(3, r.value * 0.4) - dist * 0.08;
      if (kd && isCapitalRegion(r)) sc -= 4;
      out.push({ rid: r.id, sc });
    }
    out.sort((x, y) => y.sc - x.sc || x.rid - y.rid);
    return out;
  }
  function potentialGoals(aggKid, defKid) {
    if (!rgOn() || !kget(aggKid) || !kget(defKid) || aggKid === defKid) return [];
    return goalRank(aggKid, defKid).map(o => o.rid);
  }
  /** potentialGoals that an army can actually reach: the route from one of our nearest cities must stay (mostly) inside supplied land (AI wars only take these) */
  function feasibleGoals(aggKid, defKid) {
    if (!rgOn() || !kget(aggKid) || !kget(defKid) || aggKid === defKid) return [];
    const ranked = goalRank(aggKid, defKid), ka = kget(aggKid);
    const out = [];
    feasW.attackers[0] = aggKid; feasW.defenders[0] = defKid;
    for (let i = 0; i < ranked.length && i < 6; i++) {
      const r = reg(ranked[i].rid);
      if (!r) continue;
      const near = [];
      for (let j = 0; j < ka.cities.length; j++) {
        const c = S.cities.get(ka.cities[j]);
        if (c) near.push({ c, d: Util.dist2(c.x, c.y, r.cx, r.cy) });
      }
      near.sort((x, y) => x.d - y.d || x.c.id - y.c.id);
      let best = 9999;
      for (let j = 0; j < near.length && j < 3; j++) {
        const u = routeUnsupplied(near[j].c.x, near[j].c.y, r.cx + 0.5, r.cy + 0.5, near[j].c.race, feasW, 1);
        if (u < best) best = u;
      }
      if (best <= MAX_UNSUP) out.push(r.id);
    }
    return out;
  }
  /** budget the AI / the UI counter treats as "comfortable" for a war of a against b */
  function allowance(aggKid, defKid) {
    const pa = milPower(aggKid), pb = Math.max(1, milPower(defKid));
    return Math.round(clamp(22 + 30 * Math.pow(pa / pb, 0.7), 20, 95));
  }
  function mkWar(aggKid, defKid, casus) {
    return {
      id: S.id(), attackers: [aggKid], defenders: [defKid], aggressor: aggKid, defender: defKid, started: S.tick, casus, ended: false,
      goals: [], score: {}, kills: {}, lastChange: S.tick, hist: [],
      losses: {}, wear: {}, ev: {}, occ: {}, low: {}, mp: {}, lm: {}, lt: {}, pz: {}, endedAt: 0, how: '',
    };
  }
  function addMemberToWar(w, side, kid) {
    const arr = sideArr(w, side);
    if (arr.indexOf(kid) < 0) arr.push(kid);
    if (w.score[kid] === undefined) w.score[kid] = 0;
    if (w.kills[kid] === undefined) w.kills[kid] = 0;
    if (w.losses[kid] === undefined) w.losses[kid] = 0;
    if (w.wear[kid] === undefined) w.wear[kid] = 0;
    if (w.ev[kid] === undefined) w.ev[kid] = 0;
  }
  function declare(aggKid, defKid, goalRegionIds, casus) {
    lastError = '';
    const chk = canDeclare(aggKid, defKid, casus);
    if (!chk.ok) return fail(chk.reason);
    // goals: enemy-owned regions next to our land
    const allowed = Regions.attackable(aggKid, defKid);
    const goals = [];
    const want = normRegions(goalRegionIds);
    for (let i = 0; i < want.length; i++) if (allowed.indexOf(want[i]) >= 0 && reg(want[i]).ownerId === defKid && goals.indexOf(want[i]) < 0) goals.push(want[i]);
    if (want.length && !goals.length) return fail('цель недоступна: нужен регион противника рядом с вашими землями');
    if (!goals.length) {
      let ranked = feasibleGoals(aggKid, defKid);
      if (!ranked.length) ranked = potentialGoals(aggKid, defKid);
      if (ranked.length) {
        goals.push(ranked[0]);
        if (ranked.length > 1 && !(want.length) && milPower(aggKid) > milPower(defKid) * 1.6 && regionCost(reg(ranked[0])) + regionCost(reg(ranked[1])) <= allowance(aggKid, defKid)) goals.push(ranked[1]);
      }
    }
    if (!goals.length) return fail('нет достижимых целей: нужен регион противника рядом с вашими землями');
    if (!casus) casus = Regions.hasClaim(goals[0], aggKid) ? 'claim' : 'conquest';
    const w = mkWar(aggKid, defKid, casus);
    addMemberToWar(w, 1, aggKid); addMemberToWar(w, 2, defKid);
    // allies / vassals: the defender's side first, then the attacker's
    const dAllies = alliesOf(defKid), aAllies = alliesOf(aggKid);
    for (let i = 0; i < dAllies.length; i++) {
      const al = dAllies[i];
      if (al === aggKid || w.attackers.indexOf(al) >= 0 || !kget(al)) continue;
      if (willJoin(al, defKid, aggKid, true)) addMemberToWar(w, 2, al);
    }
    for (let i = 0; i < aAllies.length; i++) {
      const al = aAllies[i];
      if (al === defKid || w.defenders.indexOf(al) >= 0 || !kget(al)) continue;
      if (willJoin(al, aggKid, defKid, false)) addMemberToWar(w, 1, al);
    }
    for (let i = 0; i < goals.length; i++) w.goals.push({ kid: aggKid, regionId: goals[i], done: false });
    S.wars.set(w.id, w);
    rebuildPairs();
    for (let i = 0; i < w.attackers.length; i++) for (let j = 0; j < w.defenders.length; j++) dipState(w.attackers[i], w.defenders[j], REL.WAR);
    // feed
    const ka = S.kingdoms.get(aggKid), kd = S.kingdoms.get(defKid);
    const gn = goals.map(rname).join(', ');
    const g0 = reg(goals[0]);
    Log.add('Королевство «' + ka.name + '» объявило войну королевству «' + kd.name + '»: ' + (goals.length > 1 ? 'цели — регионы ' : 'цель — регион ') + gn +
      (w.attackers.length + w.defenders.length > 2 ? ' (с союзниками)' : ''), LOG.WAR, g0.cx, g0.cy, aggKid);
    Hist.add(ka, 'Начало войны с «' + kd.name + '»'); Hist.add(kd, 'Нападение «' + ka.name + '»');
    for (let i = 1; i < w.attackers.length; i++) Log.add('Королевство ' + kname(w.attackers[i]) + ' вступило в войну на стороне ' + kname(aggKid), LOG.WAR, -1, -1, w.attackers[i]);
    for (let i = 1; i < w.defenders.length; i++) Log.add('Королевство ' + kname(w.defenders[i]) + ' вступило в войну на стороне ' + kname(defKid), LOG.WAR, -1, -1, w.defenders[i]);
    Bus.emit('warDeclared', w);
    // armies: every belligerent musters; orders follow the goals
    const all = w.attackers.concat(w.defenders);
    for (let i = 0; i < all.length; i++) raiseFor(w, all[i]);
    presenceMap();
    feasLeft = 8;
    for (let i = 0; i < all.length; i++) aiKingdom(w, all[i], S.tick, true);
    S.touchRegions();
    return w;
  }
  function addGoal(warId, kid, regionId) {
    lastError = '';
    const w = S.wars.get(warId);
    if (!w || w.ended) { lastError = 'война окончена'; return false; }
    const side = sideOf(w, kid);
    if (!side || !kget(kid)) { lastError = 'королевство не участвует в войне'; return false; }
    const r = reg(regionId);
    if (!r) { lastError = 'нет такого региона'; return false; }
    if (sideOf(w, r.ownerId) !== 3 - side) { lastError = 'цель должна принадлежать противнику'; return false; }
    for (let i = 0; i < w.goals.length; i++) if (w.goals[i].kid === kid && w.goals[i].regionId === regionId) { lastError = 'цель уже добавлена'; return false; }
    // reachable: already held by our side, or next to land our side controls / our armies stand in
    let ok = sideOf(w, r.controllerId) === side;
    const mates = sideArr(w, side);
    for (let i = 0; i < mates.length && !ok; i++) if (Regions.attackable(mates[i], r.ownerId).indexOf(regionId) >= 0) ok = true;
    if (!ok) { lastError = 'регион не граничит с вашими землями'; return false; }
    w.goals.push({ kid, regionId, done: sideOf(w, r.controllerId) === side });
    Log.add('Королевство ' + kname(kid) + ' поставило новую цель войны: регион ' + rname(regionId), LOG.WAR, r.cx, r.cy, kid);
    S.touchRegions();
    presenceMap();
    for (const a of S.armies.values()) if (a.warId === w.id && a.members.length) { const s = sideOf(w, a.kingdomId); if (s) addPres(regionAtPos(a.rally.x, a.rally.y), s, 1); }
    feasLeft = 4;
    aiKingdom(w, kid, S.tick, true);
    for (const al of sideArr(w, side)) if (al !== kid) aiKingdom(w, al, S.tick, false);
    return true;
  }

  // ================================================================== PLAYER COMMANDS
  function armiesForOrder(kid, ids) {
    const out = [];
    if (ids === 'all' || ids === undefined || ids === null) {
      for (const a of S.armies.values()) if (a.kingdomId === kid) out.push(a);
    } else {
      const list = Array.isArray(ids) ? ids : [ids];
      for (let i = 0; i < list.length; i++) { const a = S.armies.get(list[i]); if (a && a.kingdomId === kid && out.indexOf(a) < 0) out.push(a); }
    }
    return out;
  }
  function order(kid, armyIds, ord) {
    lastError = '';
    if (!kget(kid) || !ord) { lastError = 'нет такого королевства'; return false; }
    const type = ord.type;
    if (type !== ORD.ATTACK && type !== ORD.HOLD && type !== ORD.DEFEND && type !== ORD.RETREAT) { lastError = 'неизвестный приказ'; return false; }
    const list = armiesForOrder(kid, armyIds);
    if (!list.length) { lastError = 'нет армий'; return false; }
    let n = 0, first = '';
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const w = S.wars.get(a.warId);
      const why = orderProblem(a, w, type, ord.regionId | 0);
      if (why) { if (!first) first = why; continue; }
      if (type === ORD.RETREAT && ord.regionId) {
        const r = reg(ord.regionId);
        if (!r || (sideOf(w, r.ownerId) !== sideOf(w, kid) && sideOf(w, r.controllerId) !== sideOf(w, kid))) { if (!first) first = 'можно отступить только на свою землю'; continue; }
      }
      issue(a, type, type === ORD.RETREAT ? (ord.regionId | 0) : (ord.regionId | 0), false, S.tick);
      a.lock = S.tick + 60;
      if (a.mode === 'gather' && type !== ORD.RETREAT) a.since = S.tick - GATHER_MAX + 20;       // do not wait around: go
      if (type === ORD.RETREAT && !ord.regionId) { a.mode = 'retreat'; a.since = S.tick; }
      n++;
    }
    if (!n) lastError = first || 'приказ не принят';
    return n > 0;
  }
  function viewArmy(a) {
    const ld = S.units.get(a.leaderId);
    const x = ld ? ld.x : a.rally.x, y = ld ? ld.y : a.rally.y;
    return {
      id: a.id, size: a.members.length, strength: Math.round(a.pow / 100), supply: Math.round(a.supply),
      order: { type: a.order.type, regionId: a.order.regionId }, mode: a.mode, regionId: regionAtPos(a.rally.x, a.rally.y),
      x, y, kingdomId: a.kingdomId, warId: a.warId, cityId: a.cityId, leaderId: a.leaderId, auto: !!a.auto,
    };
  }
  function armiesOf(kid) {
    const out = [];
    for (const a of S.armies.values()) if (a.kingdomId === kid) out.push(viewArmy(a));
    return out;
  }
  /** detach `n` soldiers (the weakest first) into a new army of the same war; returns the new army id or 0 */
  function split(armyId, n) {
    const a = S.armies.get(armyId);
    if (!a || a.dis) return 0;
    const w = S.wars.get(a.warId);
    if (!w || w.ended) return 0;
    n = n | 0;
    if (n < MIN_ARMY || a.members.length - n < MIN_ARMY) return 0;
    if (armyCountK(a.kingdomId) >= MAX_ARMIES_K) return 0;
    const home = S.cities.get(a.cityId);
    if (!home) return 0;
    const b = mkArmy(a.kingdomId, home, w);
    b.rally = { x: a.rally.x, y: a.rally.y }; b.mode = a.mode === 'gather' ? 'gather' : 'march'; b.order = { type: a.order.type, regionId: a.order.regionId };
    b.auto = a.auto; b.supply = a.supply; b.race = a.race;
    S.armies.set(b.id, b);
    const ms = [];
    for (let i = 0; i < a.members.length; i++) { const u = S.units.get(a.members[i]); if (u) ms.push(u); }
    ms.sort((x, y) => rate(x) - rate(y));
    let got = 0;
    for (let i = 0; i < ms.length && got < n; i++) if (Units.conscript(ms[i], b.id)) got++;
    if (got < MIN_ARMY) { for (const id of b.members.slice()) { const u = S.units.get(id); if (u) Units.conscript(u, a.id); } S.armies.delete(b.id); return 0; }
    b.strength0 = got; electLeader(b); electLeader(a);
    return b.id;
  }
  /** move all soldiers of `b` into `a` (same kingdom & war) */
  function merge(aId, bId) {
    const a = S.armies.get(aId), b = S.armies.get(bId);
    if (!a || !b || a === b || a.kingdomId !== b.kingdomId || a.warId !== b.warId) return false;
    if (a.members.length + b.members.length > MAX_ARMY) return false;
    for (const id of b.members.slice()) { const u = S.units.get(id); if (u) Units.conscript(u, a.id); }
    a.strength0 = Math.max(a.strength0, a.members.length);
    S.armies.delete(b.id);
    electLeader(a);
    return true;
  }
  /** weak neighbours of the same kingdom, war and order merge (less clutter, stronger stacks) */
  function mergePass(w) {
    const list = armiesOfWar(w);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!S.armies.has(a.id) || a.dis || a.mode === 'gather') continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (!S.armies.has(b.id) || b.dis || b.kingdomId !== a.kingdomId || b.mode === 'gather') continue;
        if (a.order.type !== b.order.type || a.order.regionId !== b.order.regionId) continue;
        if (Util.dist(a.rally.x, a.rally.y, b.rally.x, b.rally.y) > 6) continue;
        if (a.members.length + b.members.length > MAX_ARMY) continue;
        if (a.members.length >= b.members.length) merge(a.id, b.id); else merge(b.id, a.id);
      }
    }
  }

  // ================================================================== EVENTS
  function onUnitDied(u, cause, killer) {
    if (!u || !u.kingdomId || S.wars.size === 0) return;
    const vk = u.kingdomId;
    let w = null;
    if (killer && killer.kingdomId && killer.kingdomId !== vk) w = warBetween(killer.kingdomId, vk);
    if (!w && u.armyId) { const a = S.armies.get(u.armyId); if (a) w = S.wars.get(a.warId) || null; }
    if (!w || w.ended || !w.losses || !w.wear || !w.ev || !w.kills) return;
    const soldier = u.armyId > 0;
    if (w.losses[vk] === undefined) return;
    w.losses[vk] += 1;
    w.wear[vk] = Math.min(100, (w.wear[vk] || 0) + (soldier ? 0.12 : 0.04));
    w.ev[vk] = clamp((w.ev[vk] || 0) - (soldier ? 0.4 : 0.15), -30, 40);
    if (killer && killer.kingdomId && killer.kingdomId !== vk && w.kills[killer.kingdomId] !== undefined) {
      w.kills[killer.kingdomId] += 1;
      w.ev[killer.kingdomId] = clamp((w.ev[killer.kingdomId] || 0) + (soldier ? 0.8 : 0.25), -30, 40);
    }
  }
  function onKingdomDestroyed(k) {
    if (!k) return;
    const kid = k.id;
    for (const w of Array.from(S.wars.values())) {
      if (w.ended) continue;
      const s = sideOf(w, kid);
      if (!s) continue;
      const arr = sideArr(w, s);
      arr.splice(arr.indexOf(kid), 1);
      for (const a of Array.from(S.armies.values())) if (a.warId === w.id && a.kingdomId === kid) disband(a);
      w.goals = w.goals.filter(g => g.kid !== kid);
      if (w.aggressor === kid && w.attackers.length) w.aggressor = w.attackers[0];
      if (w.defender === kid && w.defenders.length) w.defender = w.defenders[0];
      if (!arr.length) finishWar(w, 'collapse', { winner: 0, regions: [], quiet: false, note: 'противник пал' });
    }
    for (const a of Array.from(S.armies.values())) if (a.kingdomId === kid) disband(a);
    rebuildPairs();
  }
  Bus.on('unitDied', (u, cause, killer) => { onUnitDied(u, cause, killer); });
  Bus.on('kingdomDestroyed', (k) => { onKingdomDestroyed(k); });

  // ================================================================== STEP
  const stepList = [];
  function step(tick) {
    if (tick === undefined) tick = S.tick;
    if (S.wars.size === 0 && S.armies.size === 0) return;
    if (pairsFor !== S.wars || pairsSize !== S.wars.size) rebuildPairs();
    pathBudget = 3; feasLeft = 2;
    // armies: the rally point moves every tick, the brain thinks every ARMY_PERIOD ticks
    for (const a of S.armies.values()) {
      if (a.order === undefined || a.supply === undefined) normalizeArmy(a);
      if (a.members.length === 0) { S.armies.delete(a.id); mod().wiped[a.kingdomId] = tick; continue; }         // wiped out
      moveRally(a);
      if ((tick + a.id) % ARMY_PERIOD === 0) stepList.push(a);
    }
    for (let i = 0; i < stepList.length; i++) {
      const a = stepList[i];
      if (S.armies.get(a.id) !== a) continue;
      const w = S.wars.get(a.warId);
      if (!w || w.ended) { if (!a.dis || !w) { disband(a); continue; } }
      armyThink(a, w, tick);
    }
    stepList.length = 0;
    for (const w of S.wars.values()) {
      if (w.ended) continue;
      if (!w.ev || !w.wear || !w.occ) normalizeWar(w);
      const ph = tick + w.id;
      if (ph % OCC_PERIOD === 0) processOccupation(w, tick);
      if (ph % AI_PERIOD === 3) aiWar(w, tick);
      if (ph % SCORE_PERIOD === 7) scoreWar(w, tick);
      if (ph % WAR_PERIOD === 11) { exhaustCheck(w, tick); if (!w.ended) mergePass(w); }
      if (ph % REFILL_PERIOD === 17 && !w.ended) refillWar(w, tick);
    }
    if (tick % 120 === 5) housekeeping(tick);
  }
  /** does the kingdom need another army right now? (AI: no army left / a goal waits / an own region is in danger; commanded: only the danger) */
  function needArmy(w, kid, mine, cmd) {
    const side = sideOf(w, kid);
    computeThreats(w, side, thr);
    for (let i = 0; i < thr.length && i < 4; i++) {
      const th = thr[i];
      if (th.kid !== kid) continue;
      if (!covered(w, side, th.rid, null) && (th.lost || th.pres)) return true;
    }
    // (a commanded kingdom whose armies were all destroyed in battle recruits one new army while a goal waits, otherwise the player is stuck in his war;
    //  an army the player sent home himself is never re-raised)
    if (cmd) return mine.length === 0 && S.tick - (mod().wiped[kid] || -99999) < 1500 && pendingGoal(w, kid, side) > 0;
    if (mine.length === 0) return true;
    const gr = pendingGoal(w, kid, side);
    if (gr) {
      let atk = false;
      for (let i = 0; i < mine.length; i++) if (mine[i].order.type === ORD.ATTACK) atk = true;
      if (!atk) return true;
      // an offensive that is clearly too weak for the defence gets another army (the next city in line), as long as slots remain
      const dp = defencePower(w, side, gr);
      return dp > 0 && strikePower(w, side) < dp * 1.2 && S.tick >= ((w.pz && w.pz[kid]) || 0);
    }
    return false;
  }
  function refillWar(w, tick) {
    const m = mod();
    presenceMap();
    for (const a of S.armies.values()) {
      if (a.warId !== w.id || a.dis || a.members.length === 0 || a.mode === 'retreat') continue;
      const s = sideOf(w, a.kingdomId);
      if (s) addPres(regionAtPos(a.rally.x, a.rally.y), s, 1);
    }
    for (let s = 1; s <= 2; s++) {
      const arr = sideArr(w, s);
      for (let i = 0; i < arr.length; i++) {
        const kid = arr[i], k = kget(kid);
        if (!k) continue;
        const mine = armiesOfWar(w, kid);
        for (let j = 0; j < mine.length; j++) refillArmy(mine[j], w);
        const key = w.id + ':' + kid;
        if (mine.length < MAX_ARMIES_WAR && tick >= (m.form[key] || 0) && needArmy(w, kid, mine, k.cmd === true)) {
          m.form[key] = tick + 300;
          if (raiseFor(w, kid, 1) > 0) aiKingdom(w, kid, tick, k.cmd === true);
        }
      }
    }
  }
  function housekeeping(tick) {
    const m = mod();
    for (const k in m.truce) if (!(m.truce[k] > tick)) delete m.truce[k];
    for (const k in m.offers) { const o = m.offers[k]; if (!S.wars.has(+k) || tick - o.tick > 900) delete m.offers[k]; }
    for (const k in m.form) { const wid = +k.split(':')[0]; if (!S.wars.has(wid)) delete m.form[k]; }
    // finished wars leave the table after a while
    let ended = 0;
    for (const w of Array.from(S.wars.values())) {
      if (!w.ended) continue;
      ended++;
      if (tick - w.endedAt > ENDED_KEEP) { S.wars.delete(w.id); ended--; }
    }
    if (ended > ENDED_MAX) {
      for (const w of Array.from(S.wars.values())) { if (w.ended && ended > ENDED_MAX) { S.wars.delete(w.id); ended--; } }
    }
    // armies without a live war
    for (const a of Array.from(S.armies.values())) {
      const w = S.wars.get(a.warId);
      if (!w || (w.ended && !a.dis)) disband(a);
    }
  }

  // ================================================================== LIFECYCLE
  function newWorld() {
    pairs = new Map(); pairsFor = null; pairsSize = -1;
    S.mod.war = { autoPeace: autoPref, truce: {}, offers: {}, form: {}, wiped: {} };
  }
  /** wars built by hand (tests, old saves) get every field the module relies on */
  function normalizeWar(w) {
    if (!Array.isArray(w.goals)) w.goals = [];
    if (!w.score || typeof w.score !== 'object') w.score = {};
    if (!w.kills || typeof w.kills !== 'object') w.kills = {};
    if (!Array.isArray(w.hist)) w.hist = [];
    for (const k of ['losses', 'wear', 'ev', 'occ', 'low', 'mp', 'lm', 'lt', 'pz']) if (!w[k] || typeof w[k] !== 'object') w[k] = {};
    if (typeof w.lastChange !== 'number') w.lastChange = w.started || 0;
    if (typeof w.endedAt !== 'number') w.endedAt = 0;
    if (typeof w.how !== 'string') w.how = '';
    for (const kid of w.attackers.concat(w.defenders)) {
      if (w.score[kid] === undefined) w.score[kid] = 0;
      if (w.kills[kid] === undefined) w.kills[kid] = 0;
      if (w.losses[kid] === undefined) w.losses[kid] = 0;
      if (w.wear[kid] === undefined) w.wear[kid] = 0;
      if (w.ev[kid] === undefined) w.ev[kid] = 0;
    }
  }
  /** armies built by hand (tests, old saves) get every field the module relies on */
  function normalizeArmy(a) {
    if (!Array.isArray(a.members)) a.members = [];
    if (!a.rally) { const c = S.cities.get(a.cityId); a.rally = { x: c ? c.x + 0.5 : 1, y: c ? c.y + 0.5 : 1 }; }
    if (!a.order) a.order = { type: ORD.HOLD, regionId: regionAtPos(a.rally.x, a.rally.y) };
    const d = { race: 0, path: null, pi: 0, gx: 0, gy: 0, since: S.tick, auto: 1, lock: 0, coh: 1, pow: 0, fail: 0, dis: 0, att: 0, badRid: 0, badT: 0, supply: 100, strength0: a.members.length, target: null, mode: 'gather' };
    const noRace = a.race === undefined;      // only hand-built armies lack a race; race 0 (human) is a legitimate saved value
    for (const k in d) if (a[k] === undefined) a[k] = d[k];
    if (noRace && a.leaderId) { const u = S.units.get(a.leaderId); if (u) a.race = u.race; }
  }
  function afterLoad() {
    pairs = new Map(); pairsFor = null; pairsSize = -1;
    const m = mod();
    autoPref = m.autoPeace;
    for (const w of S.wars.values()) normalizeWar(w);
    for (const a of Array.from(S.armies.values())) {
      const w = S.wars.get(a.warId);
      if (!w || w.ended) { disband(a); continue; }
      normalizeArmy(a);
    }
    rebuildPairs();
  }

  return {
    atWar, declare, canDeclare,
    start(attackerKid, defenderKid, casus) { return declare(attackerKid, defenderKid, null, casus); },
    addGoal, order, armiesOf, potentialGoals, feasibleGoals, peaceCost, peaceOffer, forcePeace, godPeace, end, respondOffer,
    score(warId, kid) { const w = S.wars.get(warId); return w ? Math.round((w.score[kid] || 0) * 10) / 10 : 0; },
    supply(armyId) { const a = S.armies.get(armyId); return a ? Math.round(a.supply) : 100; },
    setAutoPeace(on) { autoPref = !!on; mod().autoPeace = autoPref; },
    get(id) { return S.wars.get(id) || null; },
    warsOf(kid) { const out = []; for (const w of S.wars.values()) if (!w.ended && sideOf(w, kid)) out.push(w); return out; },
    active() { const out = []; for (const w of S.wars.values()) if (!w.ended) out.push(w); return out; },
    armyOf(armyId) { return S.armies.get(armyId) || null; },
    step, newWorld, afterLoad,
    // extras
    autoPeace() { return !!mod().autoPeace; },
    weariness, allowance, split, merge, truceUntil, inTruce,
    allowanceFor(warId, kid, regionIds) { const w = S.wars.get(warId); return w ? Math.round(allowanceOf(w, kid, normRegions(regionIds)) * 10) / 10 : 0; },
    heldRegions(warId, kid) { const w = S.wars.get(warId); return w && sideOf(w, kid) ? heldRegions(w, sideOf(w, kid)) : []; },
    regionCost(rid) { const r = reg(rid); return r ? regionCost(r) : 0; },
    pendingOffer(warId) { const o = mod().offers[warId]; return o ? { from: o.from, to: o.to, regions: o.regions.slice(), vassal: !!o.vassal } : null; },
    goalsOf(warId) { const w = S.wars.get(warId); return w ? w.goals.map(g => ({ kid: g.kid, regionId: g.regionId, done: g.done })) : []; },
    get lastError() { return lastError; },
    LIMITS: { MAX_ARMIES_K, MAX_ARMIES_WAR, MAX_ARMY, MAX_SOLDIERS, TRUCE, STALEMATE },
  };
})();
