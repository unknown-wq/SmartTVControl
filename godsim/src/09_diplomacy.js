/* =====================================================================
 * 09_diplomacy.js — Diplomacy: opinions, alliances, truces, AI war declaration, god whispers, voluntary unification.
 * OWNER: Kingdoms+Diplomacy agent. API: docs/CONTRACT.md §3 + §8.3 + §8.6.   DOM-free, deterministic (all randomness through R).
 *
 *  Relation (S.rels, key "a_b" with a<b): {a,b,opinion -100..100,state Const.REL (PEACE|ALLIANCE; WAR is derived from War.atWar),
 *            since,truceUntil,allianceSince,causes:[{t,v,why}]}.  Every relation is created by ONE literal (mkRel).
 *  Opinion = drift toward the sum of its causes (every ~100 ticks per pair):
 *      structural causes (recomputed): race, culture, border, threat, trade, claim, ruler, ally, vassal, friends, infamy, war, peace
 *      event causes (t:'ev', decaying x0.96 per refresh): attacks, broken alliances, rebellions, god interventions, past wars.
 *  Private persistent state S.mod.diplomacy = {lastWar, cd:{kid:tick}, acd:{kid:tick}, seen:[warId]}.
 *  War truth lives in War (S.wars): atWar() forwards to War.atWar (O(1)), alliances & truces live here.
 *
 *  AI (per kingdom, staggered):  war every 200 ticks  (neighbour by border contact, desire from ruler / opinion / claims / race /
 *      relative power; a global governor keeps the world at a lively but not constant rate of ~1 new war per 3-6 game minutes),
 *      alliance every 200 ticks (offset), voluntary unification of tiny kingdoms every 400 ticks.
 *  Vassals: alliesOf(k) includes the overlord and the vassals, so wars are shared; allyWillJoin() is the participation rule for War.
 * ===================================================================== */

const Diplomacy = (() => {
  const REL = Const.REL, LOG = Const.LOG, TPY = Const.TICKS_PER_YEAR;

  // ---------------------------------------------------------------- tunables
  const MIN_WAR_TICK = 4200;        // no AI wars while the world is still settling (young kingdoms and small peoples need time to grow)
  const MIN_AGGRESSOR_POP = 40;     // a kingdom needs this many subjects before its ruler thinks of conquest
  const MIN_TARGET_POP = 24;        // ... and AI rulers do not bother with tiny hamlets
  const ENDANGERED_RACE = 120;      // the AI never starts a war against a kingdom of a people this small (the world does not wipe out a race by itself)
  const TRUCE_AFTER_WAR = 1800;     // fallback truce when the War module did not set one
  const WAR_BASE_CHANCE = 0.07;     // per consideration at desire 0.8, governor 1
  const MAX_CAUSES = 14;

  // ---------------------------------------------------------------- helpers
  function key(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function r1(v) { return (Math.round(v * 10) / 10) || 0; }                     // (|| 0: never -0, JSON would turn it into 0)
  function kget(id) { const k = S.kingdoms.get(id); return k && k.alive !== false ? k : null; }
  function peek(a, b) { return S.rels.get(key(a, b)) || null; }
  function dmod() {
    let m = S.mod.diplomacy;
    if (!m || typeof m !== 'object' || Array.isArray(m)) m = S.mod.diplomacy = { lastWar: 0, cd: {}, acd: {}, seen: [] };
    if (typeof m.lastWar !== 'number') m.lastWar = 0;
    if (!m.cd || typeof m.cd !== 'object') m.cd = {};
    if (!m.acd || typeof m.acd !== 'object') m.acd = {};
    if (!Array.isArray(m.seen)) m.seen = [];
    return m;
  }
  function rgOn() { return typeof Regions !== 'undefined' && !Regions.__stub && Regions.active(); }
  function warOn() { return typeof War !== 'undefined' && War && typeof War.declare === 'function'; }
  function atWar(a, b) {
    if (a === b || !a || !b) return false;
    return typeof War !== 'undefined' && War && War.atWar ? !!War.atWar(a, b) : false;
  }
  function mkRel(a, b) {
    return { a: a < b ? a : b, b: a < b ? b : a, opinion: 0, state: REL.PEACE, since: S.tick, truceUntil: 0, allianceSince: 0, causes: [] };
  }
  function warsOf(kid) {
    let n = 0;
    for (const w of S.wars.values()) if (!w.ended && (w.attackers.indexOf(kid) >= 0 || w.defenders.indexOf(kid) >= 0)) n++;
    return n;
  }
  function activeWars() { let n = 0; for (const w of S.wars.values()) if (!w.ended) n++; return n; }
  function traitsOf(k) {
    const r = S.units.get(k.rulerId);
    return r ? { war: Traits.sum(r, 'war'), peace: Traits.sum(r, 'peace') } : { war: 0, peace: 0 };
  }

  // ---------------------------------------------------------------- per-tick world snapshot (pure function of the state)
  let memo = { tick: -1, rv: -1, nk: -1, nc: -1, info: new Map() };
  function mkInfo() { return { str: 0, markets: 0, contacts: new Map() }; }
  /** {kid -> {str, markets, contacts: Map(otherKid -> number of bordering region pairs)}} */
  function infos() {
    if (memo.tick === S.tick && memo.rv === S.regionVer && memo.nk === S.kingdoms.size && memo.nc === S.cities.size) return memo.info;
    const map = memo.info;
    map.clear();
    for (const k of S.kingdoms.values()) {
      const i = mkInfo();
      i.str = Kingdoms.strength(k.id);
      for (let j = 0; j < k.cities.length; j++) {
        const c = S.cities.get(k.cities[j]);
        if (!c) continue;
        for (let q = 0; q < c.buildings.length; q++) { const b = S.buildings.get(c.buildings[q]); if (b && b.done && b.type === Const.B.MARKET) i.markets++; }
      }
      map.set(k.id, i);
    }
    if (rgOn()) {
      for (const r of S.regions.values()) {
        if (!r.ownerId) continue;
        const ia = map.get(r.ownerId);
        if (!ia) continue;
        for (let j = 0; j < r.nb.length; j++) {
          const b = S.regions.get(r.nb[j]);
          if (!b || !b.ownerId || b.ownerId === r.ownerId || !map.has(b.ownerId)) continue;
          ia.contacts.set(b.ownerId, (ia.contacts.get(b.ownerId) || 0) + 1);
        }
      }
    } else {
      // no regions (hand-made test worlds): kingdoms whose cities are within 20 tiles border each other
      const ks = Array.from(S.kingdoms.values());
      for (let a = 0; a < ks.length; a++) for (let b = a + 1; b < ks.length; b++) {
        if (cityDist(ks[a], ks[b]) <= 20) { map.get(ks[a].id).contacts.set(ks[b].id, 1); map.get(ks[b].id).contacts.set(ks[a].id, 1); }
      }
    }
    memo.tick = S.tick; memo.rv = S.regionVer; memo.nk = S.kingdoms.size; memo.nc = S.cities.size;
    return map;
  }
  function info(kid) { return infos().get(kid) || mkInfo(); }
  function cityDist(a, b) {
    let best = Infinity;
    for (let i = 0; i < a.cities.length; i++) {
      const c = S.cities.get(a.cities[i]);
      if (!c) continue;
      for (let j = 0; j < b.cities.length; j++) {
        const o = S.cities.get(b.cities[j]);
        if (!o) continue;
        const d = Util.dist(c.x, c.y, o.x, o.y);
        if (d < best) best = d;
      }
    }
    return best;
  }
  function contactOf(a, b) { return info(a).contacts.get(b) || 0; }
  /** effective power: own strength plus half of the strength of the allies (and vassals) */
  function power(kid) {
    let p = info(kid).str;
    const al = alliesOf(kid);
    for (let i = 0; i < al.length; i++) p += 0.5 * info(al[i]).str;
    return p;
  }

  // ---------------------------------------------------------------- alliances & queries
  function isAllied(a, b) {
    if (a === b) return false;
    const r = peek(a, b);
    if (r && r.state === REL.ALLIANCE) return true;
    const ka = S.kingdoms.get(a), kb = S.kingdoms.get(b);
    return !!(ka && kb && (ka.overlordId === b || kb.overlordId === a));
  }
  function alliesOf(kid) {
    const out = [];
    for (const r of S.rels.values()) {
      if (r.state !== REL.ALLIANCE) continue;
      if (r.a === kid) { if (S.kingdoms.has(r.b)) out.push(r.b); } else if (r.b === kid) { if (S.kingdoms.has(r.a)) out.push(r.a); }
    }
    const me = S.kingdoms.get(kid);
    if (me && me.overlordId && S.kingdoms.has(me.overlordId) && out.indexOf(me.overlordId) < 0) out.push(me.overlordId);
    for (const k of S.kingdoms.values()) if (k.overlordId === kid && out.indexOf(k.id) < 0) out.push(k.id);
    return out;
  }
  function claimCount(holder, owner) {
    if (!rgOn()) return 0;
    let n = 0;
    for (const r of S.regions.values()) if (r.ownerId === owner && r.claims.indexOf(holder) >= 0) n++;
    return n;
  }

  // ---------------------------------------------------------------- opinion model
  function push(out, t, v, why) { if (Math.abs(v) >= 1) out.push({ t, v: r1(v), why }); return Math.abs(v) >= 1 ? v : 0; }
  /** structural opinion causes between two kingdoms (appended to `out`), returns their sum */
  function structural(ka, kb, rel, out) {
    let sum = 0;
    const ia = info(ka.id), ib = info(kb.id);
    const contact = ia.contacts.get(kb.id) || 0;
    const war = atWar(ka.id, kb.id);
    const rr = ((Races.rel[ka.race] ? Races.rel[ka.race][kb.race] : 0) + (Races.rel[kb.race] ? Races.rel[kb.race][ka.race] : 0)) / 2;
    sum += push(out, 'race', Math.round(rr) || 0, ka.race === kb.race ? 'Родственные народы' : rr < 0 ? 'Вражда народов' : 'Дружба народов');
    sum += ka.culture === kb.culture ? push(out, 'culture', 20, 'Одна культура') : push(out, 'culture', -10, 'Разные культуры');
    if (contact > 0) sum += push(out, 'border', -Math.min(12, 4 * contact), 'Пограничные трения');
    if (contact > 0) {
      const hi = Math.max(ia.str, ib.str), lo = Math.max(1, Math.min(ia.str, ib.str)), ratio = hi / lo;
      if (ratio > 1.8) sum += push(out, 'threat', -Math.min(12, (ratio - 1.8) * 5), 'Неравенство сил');
    }
    if (contact > 0 && ia.markets > 0 && ib.markets > 0) sum += push(out, 'trade', Math.min(10, 3 + 2 * Math.min(ia.markets, ib.markets)), 'Торговля');
    if (rgOn()) {
      const ca = claimCount(ka.id, kb.id), cb = claimCount(kb.id, ka.id);
      if (ca) sum += push(out, 'claim', -10, 'Притязания «' + ka.name + '»');
      if (cb) sum += push(out, 'claim', -10, 'Притязания «' + kb.name + '»');
    }
    const ta = traitsOf(ka), tb = traitsOf(kb);
    sum += push(out, 'ruler', clamp(((ta.peace + tb.peace) - (ta.war + tb.war)) * 8, -10, 10), 'Характер правителей');
    if (rel.state === REL.ALLIANCE) sum += push(out, 'ally', 15, 'Союзники');
    if (ka.overlordId === kb.id || kb.overlordId === ka.id) sum += push(out, 'vassal', 20, 'Сюзерен и вассал');
    // third parties: common enemies, allies at war with the other side, shared allies
    let common = false, against = false, shared = false;
    for (const c of S.kingdoms.values()) {
      if (c.id === ka.id || c.id === kb.id) continue;
      const wa = atWar(ka.id, c.id), wb = atWar(kb.id, c.id);
      if (wa && wb) common = true;
      const aa = isAllied(ka.id, c.id), ab = isAllied(kb.id, c.id);
      if ((aa && wb) || (ab && wa)) against = true;
      if (aa && ab) shared = true;
    }
    // a third kingdom bordering both and much stronger than either: a shared threat pushes them together
    let threat = false;
    for (const [o, n] of ia.contacts) {
      if (o === kb.id || n <= 0 || !ib.contacts.has(o)) continue;
      const io = infos().get(o);
      if (io && io.str > 1.6 * Math.max(ia.str, ib.str) && io.str > 20) { threat = true; break; }
    }
    if (common) sum += push(out, 'friends', 12, 'Общий враг');
    if (threat) sum += push(out, 'friends', 10, 'Общая угроза');
    if (against) sum += push(out, 'friends', -12, 'Союзник воюет против');
    if (shared) sum += push(out, 'friends', 6, 'Общий союзник');
    const inf = Math.max(ka.infamy || 0, kb.infamy || 0);
    if (inf > 20 && rel.state !== REL.ALLIANCE) sum += push(out, 'infamy', -Math.min(10, (inf - 20) * 0.2), 'Репутация агрессора');
    if (war) sum += push(out, 'war', -40, 'Идёт война');
    else {
      const yrs = (S.tick - rel.since) / TPY;
      if (yrs >= 5) sum += push(out, 'peace', Math.min(10, yrs * 0.35), 'Долгий мир');
    }
    return sum;
  }
  function refreshRel(rel, init) {
    const ka = kget(rel.a), kb = kget(rel.b);
    if (!ka || !kb) return false;
    const out = [];
    let sum = structural(ka, kb, rel, out);
    const ev = [];
    for (let i = 0; i < rel.causes.length; i++) {
      const c = rel.causes[i];
      if (c.t !== 'ev') continue;
      const v = init ? c.v : c.v * 0.96;
      if (Math.abs(v) < 1) continue;
      ev.push({ t: 'ev', v: r1(v), why: c.why });
      sum += v;
    }
    const all = ev.concat(out);
    all.sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
    if (all.length > MAX_CAUSES) all.length = MAX_CAUSES;
    rel.causes = all;
    const target = clamp(sum, -100, 100);
    rel.opinion = init ? r1(target) : r1(clamp(rel.opinion + clamp(target - rel.opinion, -5, 3), -100, 100));
    return true;
  }
  function get(a, b) {
    if (!a || !b || a === b) return null;
    const ka = kget(a), kb = kget(b);
    if (!ka || !kb) return null;
    const k = key(a, b);
    let rel = S.rels.get(k);
    if (!rel) { rel = mkRel(a, b); S.rels.set(k, rel); refreshRel(rel, true); }
    return rel;
  }
  function addOpinion(a, b, delta, why) {
    const rel = get(a, b);
    if (!rel || !(typeof delta === 'number') || delta !== delta) return false;
    const w = why || 'Событие';
    let c = null;
    for (let i = 0; i < rel.causes.length; i++) if (rel.causes[i].t === 'ev' && rel.causes[i].why === w) { c = rel.causes[i]; break; }
    if (c) c.v = r1(c.v + delta);
    else {
      rel.causes.unshift({ t: 'ev', v: r1(delta), why: w });
      if (rel.causes.length > MAX_CAUSES) {
        let wi = -1, wv = Infinity;
        for (let i = 0; i < rel.causes.length; i++) if (rel.causes[i].t === 'ev' && Math.abs(rel.causes[i].v) < wv) { wv = Math.abs(rel.causes[i].v); wi = i; }
        if (wi >= 0) rel.causes.splice(wi, 1);
      }
    }
    rel.opinion = r1(clamp(rel.opinion + delta, -100, 100));
    return true;
  }

  // ---------------------------------------------------------------- state / truce / alliance
  function state(a, b) {
    if (atWar(a, b)) return REL.WAR;
    const r = peek(a, b);
    if (r && r.state === REL.ALLIANCE) return REL.ALLIANCE;
    return REL.PEACE;
  }
  function inTruce(a, b) { const r = peek(a, b); return !!r && r.truceUntil > S.tick; }
  function setTruce(a, b, until) {
    const rel = get(a, b);
    if (!rel) return false;
    rel.truceUntil = until > 0 ? Math.floor(until) : 0;
    return true;
  }
  function setState(a, b, st) {
    const rel = get(a, b);
    if (!rel) return false;
    if (st === REL.ALLIANCE) {
      if (rel.state !== REL.ALLIANCE) { rel.state = REL.ALLIANCE; rel.allianceSince = S.tick; rel.since = S.tick; }
      return true;
    }
    if (st === REL.PEACE) {
      if (rel.state !== REL.PEACE) { rel.state = REL.PEACE; rel.allianceSince = 0; rel.since = S.tick; }
      return true;
    }
    return st === REL.WAR;                                   // war is War's business (derived from War.atWar)
  }
  function makeAlliance(a, b) {
    const ka = kget(a), kb = kget(b);
    if (!ka || !kb || a === b || atWar(a, b)) return false;
    if (ka.overlordId === b || kb.overlordId === a) return false;
    const rel = get(a, b);
    if (!rel || rel.state === REL.ALLIANCE) return false;
    rel.state = REL.ALLIANCE; rel.allianceSince = S.tick; rel.since = S.tick; rel.truceUntil = 0;
    addOpinion(a, b, 12, 'Союз заключён');
    Log.add('Заключён союз между «' + ka.name + '» и «' + kb.name + '»', LOG.KINGDOM, -1, -1, ka.id);
    Hist.add(ka, 'Союз с «' + kb.name + '»'); Hist.add(kb, 'Союз с «' + ka.name + '»');
    Bus.emit('allianceMade', ka, kb);
    return true;
  }
  function breakAlliance(a, b, why) {
    const ka = S.kingdoms.get(a), kb = S.kingdoms.get(b);
    const rel = peek(a, b);
    if (!rel || rel.state !== REL.ALLIANCE) return false;
    rel.state = REL.PEACE; rel.allianceSince = 0; rel.since = S.tick;
    if (ka && kb) {
      addOpinion(a, b, -18, why || 'Союз расторгнут');
      Log.add('Союз между «' + ka.name + '» и «' + kb.name + '» распался', LOG.KINGDOM, -1, -1, ka.id);
      Hist.add(ka, 'Союз с «' + kb.name + '» распался'); Hist.add(kb, 'Союз с «' + ka.name + '» распался');
      Bus.emit('allianceBroken', ka, kb);
    }
    return true;
  }

  // ---------------------------------------------------------------- neighbours
  function neighbors(kid) {
    const k = kget(kid);
    if (!k) return [];
    const out = [];
    const ia = info(kid);
    for (const [o, n] of ia.contacts) {
      const ko = kget(o);
      if (!ko || o === kid) continue;
      out.push({ kid: o, dist: r1(cityDist(k, ko)), contact: n });
    }
    out.sort((x, y) => y.contact - x.contact || x.dist - y.dist || x.kid - y.kid);
    return out;
  }
  function relationsOf(kid) {
    const out = [];
    const k = kget(kid);
    if (!k) return out;
    const ia = info(kid);
    for (const o of S.kingdoms.values()) {
      if (o.id === kid || o.alive === false) continue;
      const rel = peek(kid, o.id);
      const warring = atWar(kid, o.id);
      const left = rel && rel.truceUntil > S.tick ? rel.truceUntil - S.tick : 0;
      out.push({
        other: o.id, opinion: Math.round(rel ? rel.opinion : 0) || 0, state: warring ? REL.WAR : (rel && rel.state === REL.ALLIANCE ? REL.ALLIANCE : REL.PEACE),
        truce: left > 0, truceLeft: left, contact: ia.contacts.get(o.id) || 0,
        vassal: k.overlordId === o.id ? 'overlord' : o.overlordId === kid ? 'vassal' : '',
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- wars
  function goalIds(list) {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      const id = typeof g === 'number' ? g : g && typeof g === 'object' ? (g.regionId !== undefined ? g.regionId : g.rid !== undefined ? g.rid : g.id) : 0;
      if (id > 0 && out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }
  function potentialGoals(a, b) {
    if (typeof War === 'undefined' || !War || typeof War.potentialGoals !== 'function') return [];
    try { return goalIds(War.potentialGoals(a, b)); } catch (e) { return []; }
  }
  /** potentialGoals an army can really reach (route stays inside supplied land) — used by the AI only */
  function feasibleGoals(a, b) {
    if (typeof War === 'undefined' || !War) return [];
    let r;
    if (typeof War.feasibleGoals === 'function') { try { r = War.feasibleGoals(a, b); } catch (e) { r = undefined; } }
    if (!Array.isArray(r)) return potentialGoals(a, b);                 // (another War implementation / a test double without the route check)
    return goalIds(r);
  }
  function racePop(race) {
    const st = S.stats, p = st && st.pop;
    if (!p || p[race] === undefined || !(st.popTotal >= 100)) return 1e9;        // (sandbox worlds with a handful of units are not "protected")
    return p[race];
  }
  function canDeclare(a, b) {
    const ka = kget(a), kb = kget(b);
    if (!ka || !kb) return { ok: false, reason: 'королевство не существует' };
    if (a === b) return { ok: false, reason: 'нельзя воевать с самим собой' };
    if (atWar(a, b)) return { ok: false, reason: 'война уже идёт' };
    if (ka.overlordId === b) return { ok: false, reason: 'нельзя воевать с сюзереном' };
    if (kb.overlordId === a) return { ok: false, reason: 'нельзя воевать с вассалом' };
    if (isAllied(a, b)) return { ok: false, reason: 'это ваш союзник' };
    if (inTruce(a, b)) return { ok: false, reason: 'действует перемирие' };
    if (warsOf(a) >= 3) return { ok: false, reason: 'слишком много войн' };
    if (contactOf(a, b) <= 0) return { ok: false, reason: 'нет общей границы' };
    if (warOn() && typeof War.potentialGoals === 'function' && potentialGoals(a, b).length === 0) return { ok: false, reason: 'нет доступных целей' };
    return { ok: true, reason: '' };
  }
  function pickCasus(a, b, goals) {
    if (rgOn()) {
      if (goals && goals.length) { let all = true; for (let i = 0; i < goals.length; i++) if (!Regions.hasClaim(goals[i], a)) { all = false; break; } if (all) return 'claim'; }
      else if (claimCount(a, b) > 0) return 'claim';
    }
    const rel = peek(a, b);
    return contactOf(a, b) >= 2 && rel && rel.opinion < 0 ? 'border' : 'conquest';
  }
  function regionNames(ids) {
    if (!rgOn() || !ids || !ids.length) return '';
    const n = [];
    for (let i = 0; i < ids.length && i < 3; i++) { const r = Regions.get(ids[i]); if (r) n.push('«' + r.name + '»'); }
    return n.join(', ');
  }
  /** all the diplomatic consequences of a declared war (idempotent per war id; reached through Bus 'warDeclared' or declareWar) */
  function onWarDeclared(w) {
    if (!w || typeof w !== 'object') return;
    const m = dmod();
    if (m.seen.indexOf(w.id) >= 0) return;
    m.seen.push(w.id);
    if (m.seen.length > 60) m.seen.shift();
    m.lastWar = S.tick;
    const A = w.aggressor, D = w.defender;
    const ka = S.kingdoms.get(A), kd = S.kingdoms.get(D);
    // enemies cannot stay allies / keep a truce
    for (let i = 0; i < w.attackers.length; i++) {
      for (let j = 0; j < w.defenders.length; j++) {
        const x = w.attackers[i], y = w.defenders[j];
        const rel = peek(x, y);
        if (!rel) continue;
        if (rel.state === REL.ALLIANCE) breakAlliance(x, y, 'Союз против союзника');
        rel.truceUntil = 0; rel.since = S.tick;
      }
    }
    if (ka && kd) {
      const justified = w.casus === 'claim' || w.casus === 'rebel' || w.casus === 'ally' || w.casus === 'god';
      addOpinion(A, D, justified ? -22 : -35, 'Нападение');
      if (!justified) {
        ka.infamy = Math.min(100, (ka.infamy || 0) + 10);
        for (const o of S.kingdoms.values()) if (o.id !== A && o.id !== D) addOpinion(A, o.id, -3, 'Агрессор');
      } else if (w.casus === 'claim') ka.infamy = Math.min(100, (ka.infamy || 0) + 3);
      // the defender's allies resent the attack
      for (let i = 0; i < w.defenders.length; i++) if (w.defenders[i] !== D && w.defenders[i] !== A) addOpinion(A, w.defenders[i], -10, 'Напал на союзника');
      Hist.add(ka, 'Объявило войну «' + kd.name + '»'); Hist.add(kd, 'Королевство «' + ka.name + '» напало');
    }
  }
  function onWarEnded(w) {
    if (!w || typeof w !== 'object' || !w.attackers) return;
    for (let i = 0; i < w.attackers.length; i++) {
      for (let j = 0; j < w.defenders.length; j++) {
        const x = w.attackers[i], y = w.defenders[j];
        const rel = get(x, y);
        if (!rel) continue;
        rel.since = S.tick;
        if (rel.truceUntil < S.tick + 600) rel.truceUntil = S.tick + TRUCE_AFTER_WAR;
        let has = false;
        for (let q = 0; q < rel.causes.length; q++) if (rel.causes[q].why === 'Недавняя война') { has = true; break; }
        if (!has && (x === w.aggressor || y === w.aggressor || x === w.defender || y === w.defender)) addOpinion(x, y, -12, 'Недавняя война');
      }
    }
  }
  Bus.on('warDeclared', (w) => { try { onWarDeclared(w); } catch (e) { if (typeof console !== 'undefined') console.error('Diplomacy.warDeclared', e); } });
  Bus.on('warEnded', (w) => { try { onWarEnded(w); } catch (e) { if (typeof console !== 'undefined') console.error('Diplomacy.warEnded', e); } });

  function declareWar(aggressor, defender, casus, goals) {
    const ka = kget(aggressor), kd = kget(defender);
    if (!ka || !kd || !warOn()) return null;
    const forced = casus === 'god' || casus === 'rebel';
    if (forced) {
      if (aggressor === defender || atWar(aggressor, defender)) return null;
      if (kd.overlordId === aggressor && casus !== 'rebel') return null;
      if (ka.overlordId === defender && typeof Kingdoms.breakFree === 'function') Kingdoms.breakFree(aggressor);   // a vassal that attacks its overlord is free by definition
      const rel = get(aggressor, defender);
      if (rel) { rel.truceUntil = 0; if (rel.state === REL.ALLIANCE) breakAlliance(aggressor, defender, 'Союз против союзника'); }
    } else if (!canDeclare(aggressor, defender).ok) return null;
    let gl = goalIds(goals);
    if (!gl.length) gl = potentialGoals(aggressor, defender).slice(0, 2);
    if (!casus) casus = pickCasus(aggressor, defender, gl);
    const logMark = S.nextLogId;
    let w = null;
    try { w = War.declare(aggressor, defender, gl, casus); } catch (e) { if (typeof console !== 'undefined') console.error('Diplomacy.declareWar', e); w = null; }
    if (typeof w === 'number') w = S.wars.get(w) || null;
    if (!w || typeof w !== 'object') return null;
    onWarDeclared(w);
    // the declaration must show in the feed exactly once (War normally writes it)
    let logged = false;
    for (let i = S.log.length - 1; i >= 0 && S.log[i].id >= logMark; i--) {
      const e = S.log[i];
      if (e.kind === LOG.WAR && e.msg.indexOf('объявил') >= 0 && e.msg.indexOf(ka.name) >= 0 && e.msg.indexOf(kd.name) >= 0) { logged = true; break; }
    }
    if (!logged) {
      const gn = regionNames(gl);
      const cap = S.cities.get(ka.capitalId);
      Log.add('Королевство «' + ka.name + '» объявило войну королевству «' + kd.name + '»' + (gn ? ' (цель: ' + gn + ')' : ''), LOG.WAR, cap ? cap.x : -1, cap ? cap.y : -1, ka.id);
    }
    return w;
  }
  function godWhisperWar(kid) {
    const k = kget(kid);
    if (!k || !warOn()) return false;
    const nb = neighbors(kid);
    // a free neighbour first (not a vassal link, not already at war), allies last; the closest border wins
    const cands = [];
    for (let i = 0; i < nb.length; i++) {
      const o = kget(nb[i].kid);
      if (!o || atWar(kid, o.id) || o.overlordId === kid || k.overlordId === o.id) continue;
      cands.push({ k: o, ally: isAllied(kid, o.id) ? 1 : 0, n: nb[i] });
    }
    cands.sort((x, y) => x.ally - y.ally || y.n.contact - x.n.contact || x.n.dist - y.n.dist);
    for (let i = 0; i < cands.length; i++) {
      const o = cands[i].k;
      const gl = potentialGoals(kid, o.id).slice(0, 2);
      if (!gl.length && typeof War.potentialGoals === 'function') continue;
      const w = declareWar(kid, o.id, 'god', gl);
      if (w) return w;
    }
    return false;
  }
  function godPeace(kid) {
    const k = kget(kid);
    if (!k) return false;
    const foes = [];
    for (const w of S.wars.values()) {
      if (w.ended) continue;
      const inA = w.attackers.indexOf(kid) >= 0, inD = w.defenders.indexOf(kid) >= 0;
      if (!inA && !inD) continue;
      const other = inA ? w.defenders : w.attackers;
      for (let i = 0; i < other.length; i++) if (foes.indexOf(other[i]) < 0) foes.push(other[i]);
    }
    if (!foes.length) return false;
    if (typeof War !== 'undefined' && War && typeof War.godPeace === 'function') { try { War.godPeace(kid); } catch (e) { if (typeof console !== 'undefined') console.error('Diplomacy.godPeace', e); } }
    for (const w of Array.from(S.wars.values())) {
      if (w.ended || (w.attackers.indexOf(kid) < 0 && w.defenders.indexOf(kid) < 0)) continue;
      if (typeof War !== 'undefined' && War && typeof War.end === 'function') { try { War.end(w.id, 'god'); } catch (e) { /* ignore */ } }
    }
    let ended = false;
    for (let i = 0; i < foes.length; i++) {
      if (atWar(kid, foes[i])) continue;
      ended = true;
      const rel = get(kid, foes[i]);
      if (rel && rel.truceUntil < S.tick + 1200) rel.truceUntil = S.tick + 1200;
      addOpinion(kid, foes[i], 8, 'Мир, принесённый богом');
    }
    if (ended) Hist.add(k, 'Бог принёс мир');
    return ended;
  }
  /** participation rule for allies / vassals when `side` goes to war with `enemy` (War calls it for every candidate) */
  function allyWillJoin(ally, side, enemy, defending) {
    const a = kget(ally), s = kget(side), e = kget(enemy);
    if (!a || !s || !e || ally === side || ally === enemy) return false;
    if (a.overlordId === side || s.overlordId === ally) return true;                 // vassals follow the overlord, overlords protect vassals
    if (!isAllied(ally, side) || isAllied(ally, enemy) || atWar(ally, side)) return false;
    if (warsOf(ally) >= 2) return false;
    const rel = peek(ally, enemy);
    if (defending) return R.chance(0.85);
    return !!rel && rel.opinion < -10 && R.chance(0.6);
  }

  // ---------------------------------------------------------------- AI
  /** war desire of a towards b (roughly -0.5 .. 1.5) */
  function desire(a, b, pa, pb) {
    const pol = Kingdoms.policy(a.id);
    const rel = peek(a.id, b.id);
    const op = rel ? rel.opinion : 0;
    let d = pol.war * 0.9 - pol.peace * 0.7;
    if (claimCount(a.id, b.id) > 0) d += 0.35;
    d += clamp(-op / 100, -0.3, 0.5) * 0.9;
    const rr = Races.rel[a.race] ? Races.rel[a.race][b.race] : 0;
    if (rr <= -50) d += 0.28; else if (rr <= -25) d += 0.1;
    d += pol.greed * 0.2;
    d += clamp((pa / Math.max(1, pb) - 1) * 0.35, -0.4, 0.35);
    if ((b.infamy || 0) > 50) d += 0.2;
    if (warsOf(b.id) > 0) d += 0.08;                                  // an opportunity: the neighbour is busy
    if (a.stability < 50) d -= (50 - a.stability) * 0.01;
    if ((a.infamy || 0) > 40) d -= 0.15;
    const calm = S.tick - dmod().lastWar;                              // history is not peaceful for ever: a long calm slowly wears the rulers' patience down
    if (calm > 5000) d += Math.min(0.35, (calm - 5000) / 25000);
    return d;
  }
  /** global pacing: 1 = normal; quiet right after a war started, rising the longer the world stays calm; capped by the number of wars */
  function governor(tick) {
    const m = dmod();
    const since = tick - m.lastWar;
    let g = since < 700 ? 0.1 : 1 + Math.min(3, (since - 700) / 1600);
    const nk = S.kingdoms.size;
    if (activeWars() >= Math.max(2, Math.floor(nk / 2.5))) g *= 0.15;          // enough wars going on: the rest of the world keeps the peace
    return g;
  }
  function aiWar(k, tick) {
    if (k.cmd || k.overlordId) return;
    if (tick < MIN_WAR_TICK || tick - k.born < 900) return;
    const m = dmod();
    if ((m.cd[k.id] || 0) > tick) return;
    if (!S.units.has(k.rulerId) || k.stability < 35 || Kingdoms.pop(k.id) < MIN_AGGRESSOR_POP) return;
    const nWars = warsOf(k.id);
    const myStr = info(k.id).str;
    let avg = 0, cnt = 0;
    for (const v of infos().values()) { avg += v.str; cnt++; }
    avg = cnt ? avg / cnt : 0;
    const maxWars = myStr > avg * 1.6 ? 2 : 1;
    if (nWars >= maxWars) return;
    const gov = governor(tick);
    if (gov <= 0.001) return;
    const pa = power(k.id);
    const cands = [];
    const nb = neighbors(k.id);
    for (let i = 0; i < nb.length; i++) {
      const b = kget(nb[i].kid);
      if (!b || atWar(k.id, b.id) || isAllied(k.id, b.id) || inTruce(k.id, b.id) || b.overlordId === k.id || k.overlordId === b.id) continue;
      if (warsOf(b.id) >= 2) continue;
      if (Kingdoms.pop(b.id) < MIN_TARGET_POP || racePop(b.race) < ENDANGERED_RACE) continue;
      const pb = power(b.id);
      if (pa < pb * 0.85) continue;                                    // never attack a much stronger neighbour
      cands.push({ b, d: desire(k, b, pa, pb) });
    }
    if (!cands.length) return;
    cands.sort((x, y) => y.d - x.d || x.b.id - y.b.id);
    const bd = cands[0].d;
    const p = WAR_BASE_CHANCE * gov * clamp((bd - 0.2) / 0.6, 0, 1.5);
    if (p <= 0 || !R.chance(p)) return;
    for (let i = 0; i < cands.length && i < 3; i++) {
      const best = cands[i].b;
      const gl = feasibleGoals(k.id, best.id).slice(0, pa > power(best.id) * 1.6 ? 2 : 1);
      if (!gl.length) continue;
      const w = declareWar(k.id, best.id, pickCasus(k.id, best.id, gl), gl);
      if (!w) m.cd[k.id] = tick + 400;
      return;
    }
    m.cd[k.id] = tick + 600;
  }
  function aiAlliance(k, tick) {
    if (k.cmd || k.overlordId) return;
    const m = dmod();
    if ((m.acd[k.id] || 0) > tick) return;
    if (alliesOf(k.id).length >= 2 || (k.infamy || 0) > 40 || !S.units.has(k.rulerId)) return;
    const pol = Kingdoms.policy(k.id);
    if (pol.war > 0.45) return;
    let best = null, bo = 0;
    for (const b of S.kingdoms.values()) {
      if (b.id === k.id || b.cmd || b.overlordId || atWar(k.id, b.id) || isAllied(k.id, b.id)) continue;
      const rel = peek(k.id, b.id);
      if (!rel || rel.opinion < 42 || rel.opinion <= bo) continue;
      if (alliesOf(b.id).length >= 2 || (b.infamy || 0) > 40) continue;
      if (Kingdoms.policy(b.id).war > 0.45) continue;
      // no alliance with someone at war with our ally (or with us)
      let clash = false;
      const al = alliesOf(k.id);
      for (let i = 0; i < al.length && !clash; i++) if (atWar(al[i], b.id)) clash = true;
      const bl = alliesOf(b.id);
      for (let i = 0; i < bl.length && !clash; i++) if (atWar(bl[i], k.id)) clash = true;
      if (clash) continue;
      // partners must be relevant to each other: close neighbours (opinion >= 55), or united by a shared enemy / threat (opinion >= 42)
      let need = 55;
      for (let i = 0; i < rel.causes.length; i++) if (rel.causes[i].t === 'friends' && rel.causes[i].v > 0 && rel.causes[i].why !== 'Общий союзник') need = 42;
      if (rel.opinion < need) continue;
      if (need === 55 && (info(k.id).contacts.get(b.id) || 0) <= 0) {
        let near = false;
        for (const [o] of info(k.id).contacts) if (info(b.id).contacts.has(o)) { near = true; break; }
        if (!near) continue;
      }
      bo = rel.opinion; best = b;
    }
    if (!best) return;
    if (R.chance(0.4)) { if (makeAlliance(k.id, best.id)) m.acd[k.id] = tick + 1200; }
    else m.acd[k.id] = tick + 300;
  }
  function aiAllianceBreak(tick) {
    for (const rel of Array.from(S.rels.values())) {
      if (rel.state !== REL.ALLIANCE || rel.opinion >= 20) continue;
      const ka = kget(rel.a), kb = kget(rel.b);
      if (!ka || !kb || ka.overlordId === kb.id || kb.overlordId === ka.id) continue;
      if (tick - rel.allianceSince > 300 && R.chance(0.4)) breakAlliance(rel.a, rel.b, 'Союз распался');
    }
  }
  /** tiny same-culture kingdoms next to a much bigger friend join it (merge) — rare */
  function aiUnify(k, tick) {
    if (k.cmd || k.overlordId || atWarAnyKid(k.id)) return;
    if (k.cities.length > 2 || Kingdoms.pop(k.id) > 28) return;
    const si = info(k.id);
    let best = null, bo = 34;
    for (const [o] of si.contacts) {
      const b = kget(o);
      if (!b || b.overlordId === k.id || atWarAnyKid(b.id) || b.stability < 45) continue;
      const rel = peek(k.id, o);
      if (!rel || rel.opinion <= bo) continue;
      if (info(o).str < si.str * 2.2) continue;
      if (!(b.culture === k.culture || (b.race === k.race && rel.opinion >= 45))) continue;
      bo = rel.opinion; best = b;
    }
    if (!best) return;
    if (R.chance(0.18)) Kingdoms.annex(k.id, best.id, 'merge');
  }
  function atWarAnyKid(kid) { return warsOf(kid) > 0; }

  function aiTick(tick) {
    const s20 = tick / 20;
    for (const k of Array.from(S.kingdoms.values())) {
      if (k.alive === false || !S.kingdoms.has(k.id)) continue;
      const ph = (s20 + k.id) % 20;
      if (ph % 10 === 0) aiWar(k, tick);
      else if (ph % 10 === 5) aiAlliance(k, tick);
      else if (ph === 7) aiUnify(k, tick);
    }
    if (s20 % 15 === 0) aiAllianceBreak(tick);
  }

  // ---------------------------------------------------------------- hooks / lifecycle
  function onKingdomCreated(k) {
    if (!k) return;
    for (const o of S.kingdoms.values()) if (o.id !== k.id && o.alive !== false) get(k.id, o.id);
  }
  function onKingdomDestroyed(kid) {
    for (const [k, r] of Array.from(S.rels.entries())) if (r.a === kid || r.b === kid) S.rels.delete(k);
    const m = dmod();
    delete m.cd[kid]; delete m.acd[kid];
  }
  function newWorld() { S.mod.diplomacy = { lastWar: 0, cd: {}, acd: {}, seen: [] }; memo.tick = -1; }
  function afterLoad() {
    dmod();
    memo.tick = -1;
    for (const [k, r] of Array.from(S.rels.entries())) {
      if (!r || typeof r !== 'object' || !S.kingdoms.has(r.a) || !S.kingdoms.has(r.b) || r.a >= r.b) { S.rels.delete(k); continue; }
      if (!Array.isArray(r.causes)) r.causes = [];
      if (r.state !== REL.ALLIANCE) r.state = REL.PEACE;
      if (typeof r.opinion !== 'number' || r.opinion !== r.opinion) r.opinion = 0;
    }
    // old saves: every pair of kingdoms has a relation
    const ks = Array.from(S.kingdoms.values());
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) if (!S.rels.has(key(ks[i].id, ks[j].id))) get(ks[i].id, ks[j].id);
  }

  function step(tick) {
    if (tick === undefined) tick = S.tick;
    if (tick % 10 !== 0 || S.kingdoms.size < 2) return;
    const slot = tick / 10;
    for (const rel of S.rels.values()) if ((slot + rel.a * 3 + rel.b) % 10 === 0) refreshRel(rel, false);
    if (slot % 2 === 0) aiTick(tick);
  }

  return {
    get, opinion(a, b) { const r = peek(a, b); return r ? r.opinion : 0; },
    state, atWar, allied(a, b) { return state(a, b) === REL.ALLIANCE || isAllied(a, b); }, alliesOf, inTruce, setTruce, setState, canDeclare,
    addOpinion, declareWar, makeAlliance, breakAlliance, godWhisperWar, godPeace, neighbors, relationsOf,
    onKingdomCreated, onKingdomDestroyed, step, newWorld, afterLoad,
    // extras
    allyWillJoin, power, overlordOf(kid) { const k = kget(kid); return k && k.overlordId && kget(k.overlordId) ? k.overlordId : 0; },
    vassalsOf(kid) { const out = []; for (const k of S.kingdoms.values()) if (k.overlordId === kid) out.push(k.id); return out; },
    causes(a, b) { const r = peek(a, b); return r ? r.causes.map((c) => ({ t: c.t, v: c.v, why: c.why })) : []; },
    desire(a, b) { const ka = kget(a), kb = kget(b); return ka && kb ? desire(ka, kb, power(a), power(b)) : 0; },
    governor, potentialGoals, onWarDeclared, onWarEnded,
    contact: contactOf,
  };
})();
