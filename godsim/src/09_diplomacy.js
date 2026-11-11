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
  function freshMod() { return { lastWar: 0, cd: {}, acd: {}, seen: [], nid: 1, tr: {}, inbox: [], dcd: {}, lg: {}, ult: {}, gift: {}, vtc: {}, call: {}, rf: {} }; }
  function dmod() {
    let m = S.mod.diplomacy;
    if (!m || typeof m !== 'object' || Array.isArray(m)) m = S.mod.diplomacy = freshMod();
    if (typeof m.lastWar !== 'number') m.lastWar = 0;
    if (!m.cd || typeof m.cd !== 'object') m.cd = {};
    if (!m.acd || typeof m.acd !== 'object') m.acd = {};
    if (!Array.isArray(m.seen)) m.seen = [];
    // player diplomacy (docs/feat_diplomacy.md): treaties per pair, the inbox of the commanded kingdom, AI cooldowns / memory
    if (typeof m.nid !== 'number' || !(m.nid >= 1)) m.nid = 1;
    if (!m.tr || typeof m.tr !== 'object' || Array.isArray(m.tr)) m.tr = {};
    if (!Array.isArray(m.inbox)) m.inbox = [];
    for (const f of ['dcd', 'lg', 'ult', 'gift', 'vtc', 'call', 'rf']) if (!m[f] || typeof m[f] !== 'object' || Array.isArray(m[f])) m[f] = {};
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
    sum += treatyCauses(ka.id, kb.id, out);                    // pact / trade agreement / marriage / guarantee / embargo (player diplomacy)
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
    const u = until > 0 ? Math.floor(until) : 0;
    const t = tr(a, b);
    if (t && t.pact) {                                       // a non-aggression pact is a long truce: a shorter truce never shortens it, clearing the truce ends the pact
      if (u === 0) { t.pact = 0; t.pb = 0; trClean(a, b); }
      else if (t.pact > S.tick && u < t.pact) return true;
    }
    rel.truceUntil = u;
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
    const t = tr(a, b); if (t && t.pact) { t.pact = 0; t.pb = 0; trClean(a, b); }          // an alliance supersedes a non-aggression pact
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
        // treaties (player diplomacy): pact = ticks left, guarantee = 1 (we guarantee them) | 2 (they guarantee us)
        pact: pactLeft(kid, o.id), trade: tradeOn(kid, o.id), marriage: !!marriageOf(kid, o.id), embargo: embLeft(kid, o.id),
        guarantee: guarantorOf(kid, o.id) === kid ? 1 : guarantorOf(kid, o.id) === o.id ? 2 : 0,
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
    if (inTruce(a, b)) return { ok: false, reason: pactLeft(a, b) > 0 ? 'действует пакт о ненападении' : 'действует перемирие' };
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
        warEndsTreaties(x, y);                                 // pact void, trade agreement cancelled, embargo is moot
        const rel = peek(x, y);
        if (!rel) continue;
        if (rel.state === REL.ALLIANCE) breakAlliance(x, y, 'Союз против союзника');
        rel.truceUntil = 0; rel.since = S.tick;
      }
    }
    if (ka && kd) {
      const justified = w.casus === 'claim' || w.casus === 'rebel' || w.casus === 'ally' || w.casus === 'god' || (w.casus === 'ultimatum' && ultimatumFresh(A, D));
      addOpinion(A, D, justified ? -22 : -35, 'Нападение');
      if (!justified) {
        ka.infamy = Math.min(100, (ka.infamy || 0) + 10);
        for (const o of S.kingdoms.values()) if (o.id !== A && o.id !== D) addOpinion(A, o.id, -3, 'Агрессор');
      } else if (w.casus === 'claim') ka.infamy = Math.min(100, (ka.infamy || 0) + 3);
      // the defender's allies resent the attack
      for (let i = 0; i < w.defenders.length; i++) if (w.defenders[i] !== D && w.defenders[i] !== A) addOpinion(A, w.defenders[i], -10, 'Напал на союзника');
      Hist.add(ka, 'Объявило войну «' + kd.name + '»'); Hist.add(kd, 'Королевство «' + ka.name + '» напало');
    }
    delete m.ult[A + '>' + D];                                 // the casus is used up
    honourGuarantees(w);                                       // guarantors of the attacked side step in (War.join), or break their word
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
    if (!gl.length && casus === 'ultimatum') gl = goalIds(dmod().ult[aggressor + '>' + defender] ? dmod().ult[aggressor + '>' + defender].goals : []);
    if (!gl.length) gl = potentialGoals(aggressor, defender).slice(0, 2);
    if (casus === 'ultimatum' && !ultimatumFresh(aggressor, defender)) casus = '';        // no refused ultimatum on record: an ordinary war
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
      let casus = pickCasus(k.id, best.id, gl);
      const ult = aiUltimatum(k, best, gl, pa);
      if (ult === 'done') { m.cd[k.id] = tick + 700; return; }                 // tribute paid, or the commanded kingdom has to answer first
      if (ult === 'refused') casus = 'ultimatum';
      const w = declareWar(k.id, best.id, casus, gl);
      if (!w) m.cd[k.id] = tick + 400;
      return;
    }
    m.cd[k.id] = tick + 600;
  }
  /** a strong AI sometimes demands tribute before it attacks: 'done' (paid / waiting for the player), 'refused' (a just war follows), '' (no ultimatum) */
  function aiUltimatum(k, b, gl, pa) {
    const ratio = pa / Math.max(1, power(b.id));
    if (ratio < 1.4 || !R.chance(0.25)) return '';
    const size = ratio >= 2.5 ? 3 : ratio >= 1.8 ? 2 : 1;
    const res = propose(k.id, b.id, 'demand', { what: 'tribute', size, war: gl });
    if (!res.ok) return '';
    return res.pending || res.accepted ? 'done' : 'refused';
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
      if (b.id === k.id || b.overlordId || atWar(k.id, b.id) || isAllied(k.id, b.id)) continue;
      if (b.cmd && ((m.rf[key(k.id, b.id) + ':alliance'] || 0) > tick || inboxHas(k.id, b.id, 'alliance'))) continue;      // the player is not nagged
      const rel = peek(k.id, b.id);
      if (!rel || rel.opinion < 42 || rel.opinion <= bo) continue;
      if (alliesOf(b.id).length >= 2 || (b.infamy || 0) > 40) continue;
      if (Kingdoms.policy(b.id).war > 0.45) continue;
      // would the other side accept? (the same judgement the player's proposals get; it also rules out wars of allies against each other)
      const P = plan('alliance', k.id, b.id, null);
      if (!P.ok || !P.accept) continue;
      // partners must be relevant to each other: close neighbours (opinion >= 55), or united by a shared enemy / threat (opinion >= 42)
      let friends = false;
      for (let i = 0; i < rel.causes.length; i++) if (rel.causes[i].t === 'friends' && rel.causes[i].v > 0 && rel.causes[i].why !== 'Общий союзник') friends = true;
      if (!friends && (info(k.id).contacts.get(b.id) || 0) <= 0) {
        let near = false;
        for (const [o] of info(k.id).contacts) if (info(b.id).contacts.has(o)) { near = true; break; }
        if (!near) continue;
      }
      bo = rel.opinion; best = b;
    }
    if (!best) return;
    if (R.chance(0.4)) {
      const res = propose(k.id, best.id, 'alliance', null);
      m.acd[k.id] = tick + (res.accepted ? 1200 : res.pending ? 1500 : 600);
    } else m.acd[k.id] = tick + 300;
  }
  function inboxHas(from, to, kind) {
    const ib = dmod().inbox;
    for (let i = 0; i < ib.length; i++) if (ib[i].from === from && ib[i].to === to && ib[i].kind === kind) return true;
    return false;
  }
  /** goods an AI kingdom can spare for a gift: its biggest surplus above twice the reserve, a tenth of it */
  function aiGiftGoods(k) {
    const c = capCity(k);
    if (!c) return null;
    let bg = '', bs = 0;
    for (let i = 0; i < GOODS.length; i++) { const g = GOODS[i], s = (stockIn(c, g) - 2 * RESERVE[g]) * GIFT_VALUE[g]; if (s > bs) { bs = s; bg = g; } }
    if (!bg) return null;
    const n = clamp(Math.floor(0.12 * (stockIn(c, bg) - 2 * RESERVE[bg])), 3, 25);
    if (n * GIFT_VALUE[bg] < 6) return null;
    const out = {}; out[bg] = n;
    return out;
  }
  /** treaties and gifts: at most one proposal per kingdom per ~600-1200 ticks; the same plan() that answers the player judges beforehand, so the AI mostly proposes what will be accepted */
  function aiDiplo(k, tick) {
    if (k.cmd || k.overlordId || !S.units.has(k.rulerId)) return;
    if (tick < AI_DIPLO_FROM || tick - k.born < 400) return;                // young kingdoms and a world that is still settling make no treaties yet
    const m = dmod();
    if ((m.dcd[k.id] || 0) > tick) return;
    const cands = [];
    const pol = Kingdoms.policy(k.id);
    if (warsOf(k.id) > 0) {
      const ps = partnersOf(k.id);
      for (let i = 0; i < ps.length; i++) { const P = plan('call', k.id, ps[i], {}); if (P.ok && P.accept) cands.push({ kind: 'call', to: ps[i], terms: { warId: P.data.warId }, w: 4 }); }
    }
    for (const b of S.kingdoms.values()) {
      if (b.id === k.id || b.overlordId || atWar(k.id, b.id)) continue;
      const rel = peek(k.id, b.id);
      if (!rel) continue;
      const rfk = key(k.id, b.id) + ':', pending = (kind) => (m.rf[rfk + kind] || 0) > tick || (b.cmd && inboxHas(k.id, b.id, kind));
      const contact = contactOf(k.id, b.id), op = rel.opinion, allied = rel.state === REL.ALLIANCE;
      if (!tradeOn(k.id, b.id) && !pending('trade') && op >= 5) {
        const P = plan('trade', k.id, b.id, null);
        if (P.ok && P.accept) cands.push({ kind: 'trade', to: b.id, terms: null, w: 3 });
      }
      if (contact > 0 && !allied && pactLeft(k.id, b.id) === 0 && !inTruce(k.id, b.id) && !pending('pact') && op >= 10 && desire(k, b, power(k.id), power(b.id)) < 0.3) {
        const P = plan('pact', k.id, b.id, { years: 20 });
        if (P.ok && P.accept) cands.push({ kind: 'pact', to: b.id, terms: { years: 20 }, w: 2 });
      }
      if (contact > 0 && op >= -5 && op < 42 && !allied && pol.war < 0.3 && tick - (m.gift[key(k.id, b.id)] || -9999) >= 1800) {
        const goods = aiGiftGoods(k);
        if (goods) cands.push({ kind: 'gift', to: b.id, terms: { goods }, w: 1 });
      }
      if (op >= 25 && !marriageOf(k.id, b.id) && !pending('marriage')) {
        const P = plan('marriage', k.id, b.id, null);
        if (P.ok && P.accept) cands.push({ kind: 'marriage', to: b.id, terms: null, w: 1 });
      }
    }
    if (!cands.length) { m.dcd[k.id] = tick + 200; return; }
    let tot = 0;
    for (let i = 0; i < cands.length; i++) tot += cands[i].w;
    let x = R.f() * tot, pick = cands[cands.length - 1];
    for (let i = 0; i < cands.length; i++) { x -= cands[i].w; if (x < 0) { pick = cands[i]; break; } }
    const res = propose(k.id, pick.to, pick.kind, pick.terms);
    m.dcd[k.id] = tick + (res.accepted ? 500 + R.i(400) : res.pending ? 1200 : 800);
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
      else if (ph % 10 === 3) aiDiplo(k, tick);
      else if (ph === 7) aiUnify(k, tick);
    }
    if (s20 % 15 === 0) aiAllianceBreak(tick);
  }

  // =====================================================================================================================
  // PLAYER DIPLOMACY — treaties, proposals, the inbox of the commanded kingdom, AI use of the same machinery.  docs/feat_diplomacy.md
  //   propose(from, to, kind, terms) -> {ok, accepted, pending, reason, effects[], causes[], id, margin}   the SAME code answers for the
  //       player's kingdom (k.cmd) and for the AI; a proposal made TO the commanded kingdom waits in S.mod.diplomacy.inbox until respond(id, accept).
  //   actionsFor(from, to) -> [{kind, label, icon, group, available, reason, hint, tone, odds, cost, options?}]  (the UI never re-derives a rule)
  //   Treaties live in S.mod.diplomacy.tr["a_b"] (a < b, sparse):  {pact, pb, trade, emb, eby, marr, gu}
  //       pact  tick the non-aggression pact ends — a pact is a LONG TRUCE: rel.truceUntil = max(truce, pact), so War.canDeclare is untouched
  //       pb    truce end before the pact was signed (restored when the pact is broken early)
  //       trade 1 + the tick the trade agreement was signed (0 none);   emb tick the embargo ends, eby = who imposed it
  //       marr  {t, ua, na, ub, nb} dynastic marriage of two rulers' adult children (ua = unit of the kingdom with the smaller id), treaty level only
  //       gu    kingdom that guarantees the independence of the other one (0 none)
  //   Acceptance is DETERMINISTIC: the target accepts when score >= need (opinion + named causes), so the hint shown before the tap is the answer.
  // =====================================================================================================================
  const GOODS = Const.GOODS;
  const PACT_YEARS = [10, 20, 40];
  const TRADE_PERIOD = 120;                   // ticks between two caravans of a trade agreement
  const EMBARGO_TICKS = 20 * TPY;
  const GIFT_VALUE = { food: 1, wood: 1.4, stone: 1.8, iron: 3.2, gold: 7 };
  const GIFT_TOTAL = 30;                      // the live opinion bonus of gifts never exceeds this
  const GOOD_NAME = { food: 'еда', wood: 'дерево', stone: 'камень', iron: 'железо', gold: 'золото' };
  const RESERVE = { food: 40, wood: 30, stone: 15, iron: 8, gold: 2 };      // what a tribute / an AI gift leaves in the capital
  const RACE_GOODS = [['food', 'wood'], ['iron', 'stone'], ['wood', 'gold']];    // what a people sells: humans, orcs, elves
  const TRIBUTE = [
    { size: 1, name: 'Скромная дань', frac: 0.15, need: 1.35 },
    { size: 2, name: 'Крупная дань', frac: 0.30, need: 1.8 },
    { size: 3, name: 'Тяжёлая дань', frac: 0.55, need: 2.5 },
  ];
  const NEED = { alliance: 52, pact: 5, trade: -10, marriage: 28, guarantee: -20, call: 40 };
  const AI_DIPLO_FROM = 900;                  // the AI starts treaties after this tick (and 400 ticks after its kingdom was founded)
  const INBOX_TTL = 900, INBOX_MAX = 6;
  const VASSAL_ANNEX_AFTER = 1200, VASSAL_FREE_AFTER = 600, VASSAL_TRIBUTE_CD = 1200, ULT_TTL = 1200;
  const KIND = {
    alliance:        { label: 'Союз', icon: 'alliance', group: 'treaty', cost: 'Союзники помогают в войнах' },
    break_alliance:  { label: 'Разорвать союз', icon: 'alliance', group: 'break', cost: 'Отношения −18', danger: true },
    pact:            { label: 'Пакт', icon: 'pact', group: 'treaty', cost: 'Нападать друг на друга нельзя' },
    break_pact:      { label: 'Разорвать пакт', icon: 'pact', group: 'break', cost: 'Отношения −25, дурная слава +6', danger: true },
    trade:           { label: 'Торговля', icon: 'trade', group: 'treaty', cost: 'Товары каждые 2 года, отношения +' },
    cancel_trade:    { label: 'Прекратить торговлю', icon: 'trade', group: 'break', cost: 'Отношения −5', danger: true },
    marriage:        { label: 'Брак', icon: 'marriage', group: 'treaty', cost: 'Дети правителей: связь династий' },
    guarantee:       { label: 'Гарантия', icon: 'guarantee', group: 'treaty', cost: 'Вы вступитесь, если на них нападут' },
    break_guarantee: { label: 'Снять гарантию', icon: 'guarantee', group: 'break', cost: 'Отношения −6', danger: true },
    gift:            { label: 'Подарок', icon: 'gift', group: 'give', cost: 'Товары из вашей столицы' },
    demand:          { label: 'Требование', icon: 'demand', group: 'force', cost: 'Отказ — повод для войны' },
    call:            { label: 'Позвать в войну', icon: 'call', group: 'war', cost: 'Союзник вступит в вашу войну' },
    peace:           { label: 'Белый мир', icon: 'peace', group: 'war', cost: 'Война прекращается без потерь' },
    release:         { label: 'Освободить', icon: 'release', group: 'vassal', cost: 'Вассал станет независимым' },
    tribute:         { label: 'Дань', icon: 'tribute', group: 'vassal', cost: 'Забрать часть запасов, отношения −8' },
    annex:           { label: 'Присоединить', icon: 'vassal', group: 'vassal', cost: 'Вассал войдёт в состав королевства' },
    break_free:      { label: 'Выйти из подчинения', icon: 'release', group: 'vassal', cost: 'Отношения −30, сюзерен может напасть', danger: true },
    embargo:         { label: 'Эмбарго', icon: 'embargo', group: 'break', cost: 'Отношения −15, торговля невозможна', danger: true },
    lift_embargo:    { label: 'Снять эмбарго', icon: 'embargo', group: 'break', cost: 'Торговлю можно будет возобновить' },
  };
  const NEEDS_ANSWER = { alliance: 1, pact: 1, trade: 1, marriage: 1, guarantee: 1, call: 1, demand: 1 };       // the other side decides (the rest is unilateral)
  const marriedIds = new Set();               // unit ids inside a marriage record (cache, rebuilt in afterLoad / newWorld)

  // ---------------------------------------------------------------- treaty records
  function tr(a, b) { return dmod().tr[key(a, b)] || null; }
  function trw(a, b) {
    const m = dmod(), k = key(a, b);
    return m.tr[k] || (m.tr[k] = { pact: 0, pb: 0, trade: 0, emb: 0, eby: 0, marr: null, gu: 0 });
  }
  function trClean(a, b) {
    const m = dmod(), k = key(a, b), t = m.tr[k];
    if (t && !(t.pact > S.tick) && !t.trade && !(t.emb > S.tick) && !t.marr && !t.gu) delete m.tr[k];
  }
  function pactLeft(a, b) { const t = tr(a, b); return t && t.pact > S.tick ? t.pact - S.tick : 0; }
  function tradeOn(a, b) { const t = tr(a, b); return !!(t && t.trade); }
  function embLeft(a, b) { const t = tr(a, b); return t && t.emb > S.tick ? t.emb - S.tick : 0; }
  function marriageOf(a, b) { const t = tr(a, b); return t && t.marr ? t.marr : null; }
  function guarantorOf(a, b) { const t = tr(a, b); return t && t.gu ? t.gu : 0; }
  function linked(ka, kb) { return ka.overlordId === kb.id || kb.overlordId === ka.id; }
  function ultimatumFresh(a, b) { const u = dmod().ult[a + '>' + b]; return !!u && u.until > S.tick; }
  function yearsText(ticks) { const y = Math.max(1, Math.round(ticks / TPY)); return y + ' ' + Util.plural(y, 'год', 'года', 'лет'); }
  function nm(k) { return '«' + (k ? k.name : '?') + '»'; }
  /** structural opinion causes of the treaties between two kingdoms */
  function treatyCauses(a, b, out) {
    const t = tr(a, b);
    if (!t) return 0;
    let sum = 0;
    if (t.pact > S.tick) sum += push(out, 'treaty', 6, 'Пакт о ненападении');
    if (t.trade) sum += push(out, 'treaty', 8, 'Торговое соглашение');
    if (t.marr) sum += push(out, 'treaty', 14, 'Династический брак');
    if (t.gu) sum += push(out, 'treaty', 6, 'Гарантии независимости');
    if (t.emb > S.tick) sum += push(out, 'treaty', -12, 'Эмбарго');
    return sum;
  }
  /** a routine line of the journal: at most one per kingdom per 20 ticks (force: events the player takes part in are always written) */
  function say(k, msg, force) {
    if (!k) return false;
    const m = dmod();
    if (!force) { const last = m.lg[k.id]; if (last !== undefined && S.tick >= last && S.tick - last < 20) return false; }
    m.lg[k.id] = S.tick;
    const c = capCity(k);
    Log.add(msg, LOG.KINGDOM, c ? c.x : -1, c ? c.y : -1, k.id);
    return true;
  }
  function involvesPlayer(ka, kb) { return !!((ka && ka.cmd) || (kb && kb.cmd)); }
  function bump(k, d) { if (k) k.infamy = clamp((k.infamy || 0) + d, 0, 100); }
  /** every other kingdom frowns on a treaty-breaker / traitor (events decay like all opinion events) */
  function frown(ka, kb, d, why) {
    for (const o of S.kingdoms.values()) if (o.id !== ka.id && o.id !== kb.id) addOpinion(ka.id, o.id, d, why);
  }
  /** war between two kingdoms ends their pact / trade agreement / embargo / guarantee (marriages stay) */
  function warEndsTreaties(x, y) {
    const t = tr(x, y);
    if (!t) return;
    const ka = S.kingdoms.get(x), kb = S.kingdoms.get(y);
    if (t.trade && ka && kb) say(ka, 'Торговля между «' + ka.name + '» и «' + kb.name + '» прекращена: война', involvesPlayer(ka, kb));
    t.pact = 0; t.pb = 0; t.trade = 0; t.emb = 0; t.eby = 0; t.gu = 0;
    trClean(x, y);
  }

  // ---------------------------------------------------------------- goods (the capital's stock is the treasury)
  function capCity(k) { return k ? (S.cities.get(k.capitalId) || (k.cities.length ? S.cities.get(k.cities[0]) : null) || null) : null; }
  /** the city of k that receives goods: the capital unless it is occupied (an occupied city keeps only a part of its income) */
  function freeCity(k) {
    const c = capCity(k);
    if (c && !c.occupierId) return c;
    if (k) for (let i = 0; i < k.cities.length; i++) { const o = S.cities.get(k.cities[i]); if (o && !o.occupierId) return o; }
    return c;
  }
  function stockIn(c, g) { return c && c.stock && c.stock[g] > 0 ? Math.floor(c.stock[g]) : 0; }
  function roomIn(c, g) {
    if (!c || !c.stock) return 0;
    let cap = 0;
    try { cap = typeof Cities.stockCap === 'function' ? Cities.stockCap(c) : 0; } catch (e) { cap = 0; }
    if (!(cap > 0)) cap = 400;
    return Math.max(0, Math.floor(cap - (c.stock[g] > 0 ? c.stock[g] : 0)));
  }
  function goodsText(goods) {
    const out = [];
    for (let i = 0; i < GOODS.length; i++) { const g = GOODS[i]; if (goods[g] > 0) out.push(GOOD_NAME[g] + ' ×' + goods[g]); }
    return out.join(', ');
  }
  function goodsValue(goods) { let v = 0; for (let i = 0; i < GOODS.length; i++) { const g = GOODS[i]; if (goods[g] > 0) v += goods[g] * GIFT_VALUE[g]; } return v; }
  function giftGain(value) { return value > 0 ? clamp(0.9 * Math.sqrt(value), 1, 14) : 0; }
  /** sanitise a {good: n} map: known goods, positive integers */
  function cleanGoods(g) {
    const out = {};
    if (!g || typeof g !== 'object') return out;
    for (let i = 0; i < GOODS.length; i++) { const k = GOODS[i], n = Math.floor(+g[k]); if (n > 0 && n === n && n < 1e6) out[k] = n; }
    return out;
  }
  /** what a demand for tribute would take from `src` (surplus above the reserve), limited by the room in the receiver's treasury */
  function tributeGoods(src, dst, frac) {
    const sc = capCity(src), dc = freeCity(dst), out = {};
    if (!sc || !dc) return out;
    for (let i = 0; i < GOODS.length; i++) {
      const g = GOODS[i];
      const n = Math.min(Math.floor(frac * Math.max(0, stockIn(sc, g) - RESERVE[g])), roomIn(dc, g));
      if (n > 0) out[g] = n;
    }
    return out;
  }
  function moveGoods(src, dst, goods) {
    const sc = capCity(src), dc = freeCity(dst), sent = {};
    if (!sc || !dc) return sent;
    for (let i = 0; i < GOODS.length; i++) {
      const g = GOODS[i], want = goods[g] | 0;
      if (want <= 0) continue;
      const take = Cities.withdraw(sc.id, g, Math.min(want, roomIn(dc, g)));
      if (!(take > 0)) continue;
      const put = Cities.deposit(dc.id, g, take);
      if (put < take) Cities.deposit(sc.id, g, take - put);            // (the receiver's storage was full after all: give the rest back)
      if (put > 0) sent[g] = put;
    }
    return sent;
  }

  // ---------------------------------------------------------------- dynastic marriage: the rulers' adult, unmarried children
  function isAdultUnit(u) {
    const r = Races.list[u.race] || Races.list[0], age = Util.age(u);
    return age >= r.maturity && age < r.lifespan[0] * 0.6 && u.hp > 0;
  }
  function heirsOf(k) {
    const out = [];
    const r = S.units.get(k.rulerId);
    if (!r) return out;
    for (let i = 0; i < k.cities.length; i++) {
      const c = S.cities.get(k.cities[i]);
      if (!c) continue;
      for (let j = 0; j < c.members.length; j++) {
        const u = S.units.get(c.members[j]);
        if (!u || u.id === r.id || u.isRuler || (u.fatherId !== r.id && u.motherId !== r.id)) continue;
        if (u.spouseId || marriedIds.has(u.id) || !isAdultUnit(u)) continue;
        out.push(u);
      }
    }
    out.sort((x, y) => x.born - y.born || x.id - y.id);
    return out;
  }
  /** a son and a daughter (closest in age) -> {ua, ub} of kingdoms ka / kb, or null with a reason in `why` */
  function marriagePair(ka, kb, why) {
    const ha = heirsOf(ka), hb = heirsOf(kb);
    if (!S.units.has(ka.rulerId) || !S.units.has(kb.rulerId)) { if (why) why.t = 'у одного из королевств нет правителя'; return null; }
    if (!ha.length || !hb.length) { if (why) why.t = !ha.length ? 'у правителя «' + ka.name + '» нет взрослых неженатых детей' : 'у правителя «' + kb.name + '» нет взрослых неженатых детей'; return null; }
    let best = null, bd = 1e9;
    for (let i = 0; i < ha.length; i++) for (let j = 0; j < hb.length; j++) {
      if (ha[i].sex === hb[j].sex) continue;
      const d = Math.abs(Util.age(ha[i]) - Util.age(hb[j]));
      if (d < bd) { bd = d; best = { ua: ha[i], ub: hb[j] }; }
    }
    if (!best && why) why.t = 'нужны сын и дочь: у наследников один пол';
    return best;
  }
  function childWord(u) { return u.sex === Const.SEX.F ? 'дочь' : 'сын'; }
  function dissolveMarriage(a, b, why) {
    const t = tr(a, b);
    if (!t || !t.marr) return;
    const mr = t.marr;
    marriedIds.delete(mr.ua); marriedIds.delete(mr.ub);
    t.marr = null;
    const ka = S.kingdoms.get(a), kb = S.kingdoms.get(b);
    if (ka && kb) {
      Hist.add(ka, 'Брак с домом «' + kb.name + '» завершён: ' + why); Hist.add(kb, 'Брак с домом «' + ka.name + '» завершён: ' + why);
      say(ka, 'Династический союз «' + ka.name + '» и «' + kb.name + '» прервался: ' + why, involvesPlayer(ka, kb));
    }
    trClean(a, b);
  }
  Bus.on('unitDied', (u) => {
    if (!u || marriedIds.size === 0 || !marriedIds.has(u.id)) return;
    try {
      const m = dmod();
      for (const k in m.tr) {
        const t = m.tr[k];
        if (t.marr && (t.marr.ua === u.id || t.marr.ub === u.id)) { const ab = k.split('_'); dissolveMarriage(+ab[0], +ab[1], 'супруг ' + (u.sex === Const.SEX.F ? 'умерла' : 'умер')); break; }
      }
    } catch (e) { if (typeof console !== 'undefined') console.error('Diplomacy.unitDied', e); }
  });
  /** a dynasty that dies out leaves its in-laws a claim on the capital region; a married spouse on the throne warms the houses further */
  Bus.on('kingCrowned', (k, u) => {
    if (!k || !u || marriedIds.size === 0) return;
    try {
      const m = dmod();
      for (const key2 in m.tr) {
        const t = m.tr[key2];
        if (!t.marr) continue;
        const ab = key2.split('_'), a = +ab[0], b = +ab[1];
        if (a !== k.id && b !== k.id) continue;
        const other = kget(a === k.id ? b : a), mine = a === k.id ? t.marr.ua : t.marr.ub;
        if (!other) continue;
        if (u.id === mine) { addOpinion(a, b, 8, 'Супруг на троне'); say(k, 'Супруг(а) из дома «' + other.name + '» взошёл(ла) на трон «' + k.name + '»: союз домов', involvesPlayer(k, other)); continue; }
        if (u.clan && k.clan && u.clan !== k.clan && rgOn()) {
          const cap = S.cities.get(k.capitalId), rid = cap ? cap.regionId : 0;
          if (rid && !Regions.hasClaim(rid, other.id)) { Regions.addClaim(rid, other.id); say(other, 'Угасание династии «' + k.clan + '»: «' + other.name + '» заявляет права на столицу «' + k.name + '»', true); }
        }
      }
    } catch (e) { if (typeof console !== 'undefined') console.error('Diplomacy.kingCrowned', e); }
  });

  // ---------------------------------------------------------------- queries shared by judges
  function partnersOf(kid) {
    const out = [], me = S.kingdoms.get(kid);
    for (const r of S.rels.values()) {
      if (r.state !== REL.ALLIANCE || (r.a !== kid && r.b !== kid)) continue;
      const o = r.a === kid ? r.b : r.a, ko = S.kingdoms.get(o);
      if (!ko || !me || linked(me, ko)) continue;
      out.push(o);
    }
    return out;
  }
  function commonWar(a, b) {
    for (const w of S.wars.values()) {
      if (w.ended) continue;
      const sa = w.attackers.indexOf(a) >= 0 ? 1 : w.defenders.indexOf(a) >= 0 ? 2 : 0, sb = w.attackers.indexOf(b) >= 0 ? 1 : w.defenders.indexOf(b) >= 0 ? 2 : 0;
      if (sa && sa === sb) return w;
    }
    return null;
  }
  function warBetween(a, b) {
    for (const w of S.wars.values()) {
      if (w.ended) continue;
      const sa = w.attackers.indexOf(a) >= 0 ? 1 : w.defenders.indexOf(a) >= 0 ? 2 : 0, sb = w.attackers.indexOf(b) >= 0 ? 1 : w.defenders.indexOf(b) >= 0 ? 2 : 0;
      if (sa && sb && sa !== sb) return w;
    }
    return null;
  }
  /** an ally of one side fights the other side: no new alliance (text of the problem, '' = none) */
  function clashOf(ka, kb) {
    const al = alliesOf(ka.id);
    for (let i = 0; i < al.length; i++) if (atWar(al[i], kb.id)) return '«' + (S.kingdoms.get(al[i]) || { name: '?' }).name + '» (ваш союзник) воюет с «' + kb.name + '»';
    const bl = alliesOf(kb.id);
    for (let i = 0; i < bl.length; i++) if (atWar(bl[i], ka.id)) return '«' + (S.kingdoms.get(bl[i]) || { name: '?' }).name + '» (союзник «' + kb.name + '») воюет с «' + ka.name + '»';
    return '';
  }
  function scorer() { return { s: 0, L: [], add(v, why) { v = r1(v); if (v === 0) return; this.s += v; this.L.push({ v, why }); } }; }
  function tone(margin) { return margin >= 4 ? 'good' : margin >= 0 ? 'warn' : 'bad'; }
  function words(margin) { return margin >= 14 ? 'Охотно согласятся' : margin >= 4 ? 'Согласятся' : margin >= 0 ? 'Согласятся с трудом' : margin >= -10 ? 'Почти согласны' : 'Откажут'; }

  // ---------------------------------------------------------------- judges: would `kb` accept? (score, named causes)
  function judgeAlliance(ka, kb) {
    const rel = get(ka.id, kb.id), sc = scorer();
    sc.add(rel.opinion, 'Отношения');
    let friends = false;
    for (let i = 0; i < rel.causes.length; i++) if (rel.causes[i].t === 'friends' && rel.causes[i].v > 0 && rel.causes[i].why !== 'Общий союзник') friends = true;
    if (friends) sc.add(10, 'Общий враг или общая угроза');
    if (marriageOf(ka.id, kb.id)) sc.add(14, 'Династический брак');
    if (tradeOn(ka.id, kb.id)) sc.add(4, 'Торговые связи');
    if (pactLeft(ka.id, kb.id) > 0) sc.add(4, 'Пакт о ненападении');
    const inf = ka.infamy || 0;
    if (inf > 20) sc.add(-Math.min(20, (inf - 20) * 0.6), 'Дурная слава «' + ka.name + '»');
    if (Kingdoms.policy(kb.id).war > 0.45) sc.add(-20, 'Воинственный правитель «' + kb.name + '»');
    return sc;
  }
  function judgePact(ka, kb) {
    const rel = get(ka.id, kb.id), sc = scorer();
    sc.add(rel.opinion * 0.8, 'Отношения');
    const pa = power(ka.id), pb = power(kb.id);
    if (pa > pb * 1.25) sc.add(10, 'Сильный сосед: безопаснее договориться');
    if (warsOf(kb.id) > 0) sc.add(8, '«' + kb.name + '» занято другой войной');
    if (marriageOf(ka.id, kb.id)) sc.add(10, 'Династический брак');
    if (tradeOn(ka.id, kb.id)) sc.add(4, 'Торговые связи');
    if (claimCount(kb.id, ka.id) > 0) sc.add(-25, '«' + kb.name + '» претендует на земли «' + ka.name + '»');
    if (desire(kb, ka, pb, pa) > 0.5) sc.add(-20, 'Правитель «' + kb.name + '» жаждет войны');
    return sc;
  }
  function judgeTrade(ka, kb) {
    const rel = get(ka.id, kb.id), sc = scorer();
    sc.add(rel.opinion, 'Отношения');
    if (rel.state === REL.ALLIANCE) sc.add(8, 'Союзники');
    if (pactLeft(ka.id, kb.id) > 0) sc.add(4, 'Пакт о ненападении');
    if (info(ka.id).markets > 0 && info(kb.id).markets > 0) sc.add(6, 'Рынки по обе стороны');
    return sc;
  }
  function judgeMarriage(ka, kb) {
    const rel = get(ka.id, kb.id), sc = scorer();
    sc.add(rel.opinion, 'Отношения');
    if (rel.state === REL.ALLIANCE) sc.add(8, 'Союзники');
    if (pactLeft(ka.id, kb.id) > 0) sc.add(5, 'Пакт о ненападении');
    if (tradeOn(ka.id, kb.id)) sc.add(3, 'Торговые связи');
    if (ka.race !== kb.race) sc.add(-6, 'Разные народы');
    return sc;
  }
  function judgeGuarantee(ka, kb) {
    const rel = get(ka.id, kb.id), sc = scorer();
    sc.add(rel.opinion, 'Отношения');
    if (claimCount(ka.id, kb.id) > 0) sc.add(-15, '«' + ka.name + '» претендует на земли «' + kb.name + '»');
    return sc;
  }
  /** `ally` decides whether to join the war of `caller` */
  function judgeCall(ally, caller, w) {
    const rel = get(ally.id, caller.id), sc = scorer();
    sc.add(rel.opinion, 'Отношения');
    const defending = w.defenders.indexOf(caller.id) >= 0;
    if (defending) sc.add(18, 'На союзника напали');
    else if (w.casus === 'claim' || w.casus === 'ultimatum' || w.casus === 'ally' || w.casus === 'rebel') sc.add(4, 'У войны есть законный повод');
    else sc.add(-14, 'Война ради захвата');
    const foes = defending ? w.attackers : w.defenders;
    let hate = 0;
    for (let i = 0; i < foes.length; i++) { const r2 = peek(ally.id, foes[i]); if (r2 && r2.opinion < 0) hate += -r2.opinion * 0.25; }
    if (hate >= 1) sc.add(Math.min(12, hate), 'Неприязнь к врагам');
    const pol = Kingdoms.policy(ally.id);
    sc.add(clamp(pol.war * 10 - pol.peace * 8, -10, 10), 'Нрав правителя');
    if (ally.stability < 35) sc.add(-12, 'Смута в стране «' + ally.name + '»');
    return sc;
  }
  /** power ratio needed for the target to bow to a demand (and a few words about it) */
  function demandNeed(ka, kb, what, size, rid) {
    let need;
    if (what === 'tribute') need = TRIBUTE[(size | 0) - 1] ? TRIBUTE[(size | 0) - 1].need : 2.5;
    else if (what === 'region') {
      const r = Regions.get(rid);
      need = 2.0 + 0.35 * (r ? r.cityIds.length : 0) + 0.08 * (r ? r.value || 0 : 0);
    } else need = 3.2 + 0.4 * Math.max(0, kb.cities.length - 1);
    const pol = Kingdoms.policy(kb.id);
    need *= 1 + 0.35 * clamp(pol.war, -0.5, 1) - 0.2 * clamp(pol.peace, -0.5, 1);
    if (warsOf(kb.id) > 0) need *= 0.85;                      // fighting somebody else: cannot afford a second front
    const op = get(ka.id, kb.id).opinion;
    if (op > 30) need *= 0.85; else if (op < -30) need *= 1.15;
    return need;
  }

  // ---------------------------------------------------------------- plan: availability + the target's answer for ONE action (pure, no side effects)
  //   -> {kind, ok (can be proposed), reason (why not), needs (the other side answers), score, need, margin, accept, causes[], note, data}
  function plan(kind, fromKid, toKid, terms) {
    const P = { kind, ok: false, reason: '', needs: false, score: 0, need: 0, margin: 0, accept: false, causes: [], note: '', data: null };
    const ka = kget(fromKid), kb = kget(toKid);
    if (!ka || !kb || fromKid === toKid) { P.reason = 'королевство недоступно'; return P; }
    const rel = get(fromKid, toKid);
    if (!rel) { P.reason = 'нет связи между королевствами'; return P; }
    terms = terms && typeof terms === 'object' ? terms : {};
    const war = atWar(fromKid, toKid), lk = linked(ka, kb), allied = rel.state === REL.ALLIANCE && !lk;
    const fail = (r) => { P.ok = false; P.reason = r; return P; };
    const good = () => { P.ok = true; return P; };
    const judged = (sc, need) => {
      P.needs = true; P.need = need; P.score = r1(sc.s); P.margin = r1(P.score - need); P.accept = P.margin >= 0;
      P.causes = sc.L.slice().sort((x, y) => Math.abs(y.v) - Math.abs(x.v));
    };
    switch (kind) {
      case 'alliance': {
        if (war) return fail('идёт война');
        if (lk) return fail('сюзерен и вассал уже связаны');
        if (allied) return fail('вы уже союзники');
        if (ka.overlordId) return fail('вассал не ведёт самостоятельной политики');
        if (kb.overlordId) return fail('«' + kb.name + '» — вассал и не заключает союзов');
        const bad = clashOf(ka, kb); if (bad) return fail(bad);
        if (partnersOf(kb.id).length >= 2) return fail('у «' + kb.name + '» уже два союзника');
        judged(judgeAlliance(ka, kb), NEED.alliance);
        return good();
      }
      case 'break_alliance': {
        if (!allied) return fail('союза нет');
        const cw = commonWar(fromKid, toKid);
        P.data = { betray: !!cw };
        P.note = cw ? 'Вы воюете вместе: это предательство — отношения −40, дурная слава +8' : '';
        return good();
      }
      case 'pact': {
        const years = PACT_YEARS.indexOf(terms.years | 0) >= 0 ? terms.years | 0 : 20;
        P.data = { years };
        if (war) return fail('идёт война');
        if (lk) return fail('сюзерен и вассал уже связаны');
        if (allied) return fail('союзникам пакт не нужен');
        if (ka.overlordId || kb.overlordId) return fail('вассал не заключает пактов');
        if (pactLeft(fromKid, toKid) > 0) return fail('пакт уже действует');
        judged(judgePact(ka, kb), NEED.pact + (years - 10) * 0.3);
        return good();
      }
      case 'break_pact': {
        if (!(pactLeft(fromKid, toKid) > 0)) return fail('пакта нет');
        return good();
      }
      case 'trade': {
        if (war) return fail('идёт война');
        if (tradeOn(fromKid, toKid)) return fail('торговля уже идёт');
        const e = embLeft(fromKid, toKid);
        if (e > 0) return fail('эмбарго ещё ' + yearsText(e));
        if (contactOf(fromKid, toKid) <= 0 && !(info(fromKid).markets > 0 && info(toKid).markets > 0)) return fail('нет торговых путей: нужна общая граница или рынки у обоих');
        judged(judgeTrade(ka, kb), NEED.trade);
        return good();
      }
      case 'cancel_trade': {
        if (!tradeOn(fromKid, toKid)) return fail('торговли нет');
        return good();
      }
      case 'gift': {
        if (war) return fail('в разгар войны подарки не принимают');
        const c = capCity(ka), r = freeCity(kb);
        if (!c || !r) return fail('нет столицы');
        const opts = [];
        for (let i = 0; i < GOODS.length; i++) {
          const g = GOODS[i], have = stockIn(c, g), room = roomIn(r, g);
          opts.push({ good: g, name: GOOD_NAME[g], have, room, max: Math.min(have, room), value: GIFT_VALUE[g] });
        }
        if (!opts.some((o) => o.have > 0)) return fail('в вашей столице пусто');
        if (!opts.some((o) => o.max > 0)) return fail('склады получателя переполнены');
        const want = cleanGoods(terms.goods), fixed = {};
        for (let i = 0; i < opts.length; i++) { const o = opts[i], n = Math.min(want[o.good] | 0, o.max); if (n > 0) fixed[o.good] = n; }
        const value = goodsValue(fixed);
        P.data = { options: opts, goods: fixed, value: r1(value), gain: r1(giftGain(value)) };
        return good();
      }
      case 'demand': {
        const what = terms.what === 'region' || terms.what === 'vassal' ? terms.what : 'tribute';
        const size = what === 'tribute' ? clamp(terms.size | 0 || 1, 1, 3) : 0;
        P.data = { what, size, rid: 0 };
        if (war) return fail('идёт война: условия обсуждают за столом мира');
        if (lk) return fail('сюзерен и вассал уже связаны');
        if (allied) return fail('это ваш союзник');
        if (ka.overlordId) return fail('вассал не предъявляет требований');
        if (inTruce(fromKid, toKid)) return fail(pactLeft(fromKid, toKid) > 0 ? 'действует пакт о ненападении: угрожать войной нельзя' : 'действует перемирие: угрожать войной нельзя');
        if (contactOf(fromKid, toKid) <= 0) return fail('нет общей границы: угрожать нечем');
        if (warsOf(fromKid) >= 3) return fail('вы уже воюете слишком много');
        const ratio = power(fromKid) / Math.max(1, power(toKid));
        let need;
        if (what === 'tribute') {
          const goods = tributeGoods(kb, ka, TRIBUTE[size - 1].frac);
          if (!Object.keys(goods).length) return fail('у «' + kb.name + '» нечего взять');
          P.data.goods = goods; P.data.value = r1(goodsValue(goods));
          need = demandNeed(ka, kb, 'tribute', size, 0);
        } else if (what === 'region') {
          if (!rgOn()) return fail('нет карты регионов');
          const rid = terms.rid | 0, r = Regions.get(rid);
          if (!r || r.ownerId !== toKid) return fail('регион не принадлежит «' + kb.name + '»');
          const cap = S.cities.get(kb.capitalId);
          if (cap && cap.regionId === rid) return fail('столичный регион не отдают');
          if (Regions.attackable(fromKid, toKid).indexOf(rid) < 0) return fail('регион не граничит с вашими землями');
          P.data.rid = rid;
          need = demandNeed(ka, kb, 'region', 0, rid);
        } else {
          if (kb.overlordId) return fail('«' + kb.name + '» уже вассал');
          need = demandNeed(ka, kb, 'vassal', 0, 0);
        }
        P.needs = true; P.score = r1(ratio); P.need = r1(need);
        P.margin = r1((ratio - need) / need * 25); P.accept = ratio >= need;
        P.note = 'Ваша сила ×' + r1(ratio) + ', нужно ×' + r1(need);
        P.causes = [{ v: r1(ratio - need), why: 'Сила против требуемой' }];
        return good();
      }
      case 'marriage': {
        if (war) return fail('идёт война');
        if (marriageOf(fromKid, toKid)) return fail('браком дома уже связаны');
        const why = { t: '' }, pr = marriagePair(ka, kb, why);
        if (!pr) return fail(why.t || 'нет подходящих наследников');
        P.data = { ua: pr.ua.id, na: pr.ua.name, sa: pr.ua.sex, aa: Math.floor(Util.age(pr.ua)), ub: pr.ub.id, nb: pr.ub.name, sb: pr.ub.sex, ab: Math.floor(Util.age(pr.ub)) };
        judged(judgeMarriage(ka, kb), NEED.marriage);
        return good();
      }
      case 'guarantee': {
        if (war) return fail('идёт война');
        if (lk) return fail('сюзерен и вассал уже связаны');
        if (kb.overlordId) return fail('вассал не нуждается в гарантиях');
        if (guarantorOf(fromKid, toKid) === fromKid) return fail('вы уже гарантируете её независимость');
        if (guarantorOf(fromKid, toKid) === toKid) return fail('«' + kb.name + '» уже гарантирует вашу независимость');
        judged(judgeGuarantee(ka, kb), NEED.guarantee);
        return good();
      }
      case 'break_guarantee': {
        if (guarantorOf(fromKid, toKid) !== fromKid) return fail('вы ничего не гарантируете');
        return good();
      }
      case 'call': {
        // from = the kingdom at war, to = its ally who is asked to join
        if (!allied) return fail(lk ? 'вассалы и сюзерены вступают в войну сами' : 'это не ваш союзник');
        const mine = [];
        for (const w of S.wars.values()) {
          if (w.ended) continue;
          const s = w.attackers.indexOf(fromKid) >= 0 ? 1 : w.defenders.indexOf(fromKid) >= 0 ? 2 : 0;
          if (!s) continue;
          if (w.attackers.indexOf(toKid) >= 0 || w.defenders.indexOf(toKid) >= 0) continue;
          mine.push(w);
        }
        if (!mine.length) return fail(warsOfKid(fromKid) ? 'союзник уже участвует во всех ваших войнах' : 'вы ни с кем не воюете');
        let w = terms.warId ? S.wars.get(terms.warId | 0) : null;
        if (w && mine.indexOf(w) < 0) w = null;
        if (!w) w = mine[mine.length - 1];
        P.data = { warId: w.id, wars: mine.map((x) => x.id) };
        if (typeof War === 'undefined' || !War || typeof War.join !== 'function') return fail('эта версия войн не принимает союзников');
        const foes = w.attackers.indexOf(fromKid) >= 0 ? w.defenders : w.attackers;
        for (let i = 0; i < foes.length; i++) {
          if (foes[i] === toKid) return fail('союзник воюет против вас');
          if (isAllied(toKid, foes[i])) return fail('«' + kb.name + '» связан союзом с «' + (S.kingdoms.get(foes[i]) || { name: '?' }).name + '»');
        }
        if (warsOf(toKid) >= 2) return fail('«' + kb.name + '» увяз в других войнах');
        const cd = dmod().call[w.id + ':' + toKid];
        if (cd > S.tick) return fail('недавно уже просили: ещё ' + yearsText(cd - S.tick));
        judged(judgeCall(kb, ka, w), NEED.call);
        return good();
      }
      case 'peace': {
        if (!war) return fail('войны нет');
        const w = warBetween(fromKid, toKid);
        if (!w) return fail('войны нет');
        if (typeof War === 'undefined' || !War || typeof War.peaceOffer !== 'function') return fail('мир сейчас невозможен');
        P.data = { warId: w.id };
        P.needs = true; P.accept = false;
        return good();
      }
      case 'release': {
        if (kb.overlordId !== fromKid) return fail('это не ваш вассал');
        return good();
      }
      case 'tribute': {
        if (kb.overlordId !== fromKid) return fail('это не ваш вассал');
        const cd = dmod().vtc[toKid];
        if (cd > S.tick) return fail('дань уже собрали: ещё ' + yearsText(cd - S.tick));
        const goods = tributeGoods(kb, ka, 0.25);
        if (!Object.keys(goods).length) return fail('казна вассала пуста');
        P.data = { goods, value: r1(goodsValue(goods)) };
        return good();
      }
      case 'annex': {
        if (kb.overlordId !== fromKid) return fail('это не ваш вассал');
        const served = S.tick - (kb.vassalSince || 0);
        if (served < VASSAL_ANNEX_AFTER) return fail('вассал должен прослужить ещё ' + yearsText(VASSAL_ANNEX_AFTER - served));
        if (kb.culture !== ka.culture && rel.opinion < 40) return fail('чужая культура: нужны отношения не ниже 40 (сейчас ' + Math.round(rel.opinion) + ')');
        P.data = { cities: kb.cities.length };
        P.note = 'Города вассала станут вашими (' + kb.cities.length + '), в стране будет смута';
        return good();
      }
      case 'break_free': {
        if (ka.overlordId !== toKid) return fail('вы не вассал этого королевства');
        const served = S.tick - (ka.vassalSince || 0);
        if (served < VASSAL_FREE_AFTER) return fail('вассалитет слишком свеж: ещё ' + yearsText(VASSAL_FREE_AFTER - served));
        return good();
      }
      case 'embargo': {
        if (war) return fail('и так идёт война');
        if (lk) return fail('сюзерен и вассал уже связаны');
        if (allied) return fail('союзникам эмбарго не объявляют');
        if (embLeft(fromKid, toKid) > 0) return fail('эмбарго уже наложено');
        return good();
      }
      case 'lift_embargo': {
        const t = tr(fromKid, toKid);
        if (!(t && t.emb > S.tick && t.eby === fromKid)) return fail('вы не накладывали эмбарго');
        return good();
      }
      default: return fail('неизвестное действие');
    }
  }
  function warsOfKid(kid) { return warsOf(kid); }

  // ---------------------------------------------------------------- effects (what really happens once the other side said yes)
  function cancelTrade(a, b, byChoice) {
    const t = tr(a, b);
    if (!t || !t.trade) return false;
    t.trade = 0;
    trClean(a, b);
    const ka = S.kingdoms.get(a), kb = S.kingdoms.get(b);
    if (byChoice && ka && kb) { addOpinion(a, b, -5, 'Торговля прекращена'); say(ka, 'Торговое соглашение между «' + ka.name + '» и «' + kb.name + '» расторгнуто', involvesPlayer(ka, kb)); }
    return true;
  }
  function execute(kind, fromKid, toKid, P) {
    const out = { ok: true, reason: '', effects: [] };
    const ka = kget(fromKid), kb = kget(toKid), fx = out.effects;
    if (!ka || !kb) { out.ok = false; out.reason = 'королевство недоступно'; return out; }
    const pl = involvesPlayer(ka, kb), rel = get(fromKid, toKid);
    const bad = (r) => { out.ok = false; out.reason = r; return out; };
    switch (kind) {
      case 'alliance': {
        if (!makeAlliance(fromKid, toKid)) return bad('союз не удалось заключить');
        fx.push('Союз заключён');
        Bus.emit('treatyMade', 'alliance', ka, kb);
        break;
      }
      case 'break_alliance': {
        const betray = !!(P && P.data && P.data.betray);
        if (!breakAlliance(fromKid, toKid, betray ? 'Предательство союзника' : 'Союз расторгнут')) return bad('союза нет');
        if (betray) { addOpinion(fromKid, toKid, -22, 'Предательство союзника'); bump(ka, 8); frown(ka, kb, -3, 'Предатель союзников'); fx.push('Предательство союзника: отношения −40, дурная слава +8'); }
        else fx.push('Союз расторгнут: отношения −18');
        Bus.emit('treatyBroken', 'alliance', ka, kb);
        break;
      }
      case 'pact': {
        const years = P.data.years, until = S.tick + years * TPY, t = trw(fromKid, toKid);
        t.pb = rel.truceUntil > S.tick ? rel.truceUntil : 0;
        t.pact = until;
        rel.truceUntil = Math.max(rel.truceUntil, until);
        addOpinion(fromKid, toKid, 4, 'Пакт подписан');
        say(ka, 'Пакт о ненападении между «' + ka.name + '» и «' + kb.name + '» на ' + yearsText(years * TPY), pl);
        Hist.add(ka, 'Пакт о ненападении с «' + kb.name + '»'); Hist.add(kb, 'Пакт о ненападении с «' + ka.name + '»');
        fx.push('Пакт о ненападении на ' + yearsText(years * TPY));
        Bus.emit('treatyMade', 'pact', ka, kb);
        break;
      }
      case 'break_pact': {
        const t = tr(fromKid, toKid);
        if (!t || !(t.pact > S.tick)) return bad('пакта нет');
        if (rel.truceUntil <= t.pact) rel.truceUntil = t.pb > S.tick ? t.pb : 0;
        t.pact = 0; t.pb = 0; trClean(fromKid, toKid);
        addOpinion(fromKid, toKid, -25, 'Нарушен пакт'); bump(ka, 6); frown(ka, kb, -3, 'Нарушает договоры');
        say(ka, 'Королевство «' + ka.name + '» разорвало пакт о ненападении с «' + kb.name + '»', true);
        Hist.add(ka, 'Разорван пакт с «' + kb.name + '»'); Hist.add(kb, 'Королевство «' + ka.name + '» разорвало пакт');
        fx.push('Пакт разорван: отношения −25, дурная слава +6');
        Bus.emit('treatyBroken', 'pact', ka, kb);
        break;
      }
      case 'trade': {
        trw(fromKid, toKid).trade = S.tick + 1;                    // (+1: tick 0 must stay truthy)
        addOpinion(fromKid, toKid, 3, 'Торговое соглашение подписано');
        say(ka, 'Торговое соглашение между «' + ka.name + '» и «' + kb.name + '»', pl);
        Hist.add(ka, 'Торговля с «' + kb.name + '»'); Hist.add(kb, 'Торговля с «' + ka.name + '»');
        fx.push('Торговое соглашение: караваны раз в 2 года');
        Bus.emit('treatyMade', 'trade', ka, kb);
        break;
      }
      case 'cancel_trade': {
        if (!cancelTrade(fromKid, toKid, true)) return bad('торговли нет');
        fx.push('Торговля прекращена: отношения −5');
        Bus.emit('treatyBroken', 'trade', ka, kb);
        break;
      }
      case 'gift': {
        const goods = P.data.goods;
        if (!goods || !Object.keys(goods).length) return bad('выберите товары для подарка');
        const sent = moveGoods(ka, kb, goods);
        if (!Object.keys(sent).length) return bad('передать нечего');
        const value = goodsValue(sent), gain = giftGain(value);
        let cur = 0;
        for (let i = 0; i < rel.causes.length; i++) if (rel.causes[i].t === 'ev' && rel.causes[i].why === 'Подарок') cur = rel.causes[i].v;
        const add = Math.min(gain, Math.max(0, GIFT_TOTAL - cur));
        if (add >= 0.5) addOpinion(fromKid, toKid, add, 'Подарок');
        dmod().gift[key(fromKid, toKid)] = S.tick;
        const text = goodsText(sent);
        if (pl) say(ka, 'Королевство «' + ka.name + '» отправило дары королевству «' + kb.name + '»: ' + text, true);
        Hist.add(ka, 'Дары для «' + kb.name + '»: ' + text); Hist.add(kb, 'Дары от «' + ka.name + '»: ' + text);
        fx.push('Отправлено: ' + text);
        if (add >= 0.5) fx.push('Отношения +' + r1(add));
        out.sent = sent;
        Bus.emit('treatyMade', 'gift', ka, kb, sent);
        break;
      }
      case 'demand': {
        const d = P.data;
        if (d.what === 'tribute') {
          const sent = moveGoods(kb, ka, d.goods);
          if (!Object.keys(sent).length) return bad('платить нечем');
          addOpinion(fromKid, toKid, -8, 'Вымогательство'); bump(ka, 2);
          say(ka, 'Королевство «' + kb.name + '» выплатило дань королевству «' + ka.name + '»: ' + goodsText(sent), true);
          fx.push('Получено: ' + goodsText(sent)); out.sent = sent;
        } else if (d.what === 'region') {
          const r = Regions.get(d.rid);
          if (!r || r.ownerId !== toKid) return bad('регион уже не принадлежит «' + kb.name + '»');
          const cities = r.cityIds.slice(), rn = r.name;
          Regions.setOwner(d.rid, fromKid, 'transfer');
          for (let i = 0; i < cities.length; i++) {
            const c = S.cities.get(cities[i]);
            if (c && c.kingdomId !== fromKid && kget(fromKid)) { try { Kingdoms.transferCity(c.id, fromKid, 'peace'); } catch (e) { /* keep going */ } }
          }
          if (kget(toKid)) addOpinion(fromKid, toKid, -25, 'Потеря земель'); bump(ka, 4);
          say(ka, 'Королевство «' + kb.name + '» уступило регион «' + rn + '» королевству «' + ka.name + '» под угрозой войны', true);
          fx.push('Регион «' + rn + '» перешёл к вам'); out.rid = d.rid;
        } else {
          if (!Kingdoms.annex(toKid, fromKid, 'vassal')) return bad('вассалитет не удался');
          if (kget(toKid)) addOpinion(fromKid, toKid, -10, 'Принуждение к вассалитету'); bump(ka, 3);
          fx.push('«' + kb.name + '» стало вашим вассалом');
        }
        Bus.emit('treatyMade', 'demand', ka, kb);
        break;
      }
      case 'marriage': {
        const d = P.data, ua = S.units.get(d.ua), ub = S.units.get(d.ub);
        if (!ua || !ub) return bad('наследник недоступен');
        const small = fromKid < toKid, t = trw(fromKid, toKid);
        t.marr = { t: S.tick, ua: small ? d.ua : d.ub, na: small ? d.na : d.nb, ub: small ? d.ub : d.ua, nb: small ? d.nb : d.na };
        marriedIds.add(d.ua); marriedIds.add(d.ub);
        addOpinion(fromKid, toKid, 10, 'Свадьба');
        const cap = capCity(ka);
        Log.add('Свадьба: ' + childWord(ua) + ' правителя «' + ka.name + '» (' + ua.name + ') и ' + childWord(ub) + ' правителя «' + kb.name + '» (' + ub.name + ') — союз домов', LOG.KINGDOM, cap ? cap.x : -1, cap ? cap.y : -1, ka.id);
        dmod().lg[ka.id] = S.tick;
        Hist.add(ka, 'Династический брак с домом «' + kb.name + '»'); Hist.add(kb, 'Династический брак с домом «' + ka.name + '»');
        Hist.add(ua, (ua.sex === Const.SEX.F ? 'Вышла замуж за ' : 'Женился на ') + ub.name + ' из «' + kb.name + '»');
        Hist.add(ub, (ub.sex === Const.SEX.F ? 'Вышла замуж за ' : 'Женился на ') + ua.name + ' из «' + ka.name + '»');
        fx.push('Свадьба: ' + ua.name + ' и ' + ub.name);
        Bus.emit('treatyMade', 'marriage', ka, kb);
        break;
      }
      case 'guarantee': {
        trw(fromKid, toKid).gu = fromKid;
        addOpinion(fromKid, toKid, 3, 'Гарантии независимости');
        say(ka, 'Королевство «' + ka.name + '» гарантирует независимость королевства «' + kb.name + '»', pl);
        Hist.add(ka, 'Гарантия независимости «' + kb.name + '»'); Hist.add(kb, 'Гарантии «' + ka.name + '»');
        fx.push('Вы гарантируете независимость «' + kb.name + '»');
        Bus.emit('treatyMade', 'guarantee', ka, kb);
        break;
      }
      case 'break_guarantee': {
        const t = tr(fromKid, toKid);
        if (!t || t.gu !== fromKid) return bad('гарантии нет');
        t.gu = 0; trClean(fromKid, toKid);
        addOpinion(fromKid, toKid, -6, 'Гарантии сняты');
        say(ka, 'Королевство «' + ka.name + '» сняло гарантии с королевства «' + kb.name + '»', pl);
        fx.push('Гарантии сняты');
        Bus.emit('treatyBroken', 'guarantee', ka, kb);
        break;
      }
      case 'call': {
        const w = S.wars.get(P.data.warId);
        if (!w || w.ended) return bad('война окончена');
        dmod().call[w.id + ':' + toKid] = S.tick + 600;
        let joined = false;
        try { joined = !!War.join(w.id, toKid, fromKid); } catch (e) { joined = false; }
        if (!joined) return bad('союзник не смог вступить в войну');
        addOpinion(fromKid, toKid, 4, 'Помощь союзника');
        fx.push('«' + kb.name + '» вступает в войну');
        break;
      }
      case 'release': {
        if (!Kingdoms.release(toKid)) return bad('вассал уже свободен');
        fx.push('«' + kb.name + '» теперь независимо');
        Bus.emit('treatyBroken', 'vassal', ka, kb);
        break;
      }
      case 'tribute': {
        const sent = moveGoods(kb, ka, P.data.goods);
        if (!Object.keys(sent).length) return bad('вассалу нечем платить');
        dmod().vtc[toKid] = S.tick + VASSAL_TRIBUTE_CD;
        addOpinion(fromKid, toKid, -8, 'Дань');
        kb.stability = clamp(kb.stability - 2, 0, 100);
        say(ka, 'Вассал «' + kb.name + '» выплатил дань королевству «' + ka.name + '»: ' + goodsText(sent), pl);
        fx.push('Получено: ' + goodsText(sent)); out.sent = sent;
        break;
      }
      case 'annex': {
        if (!Kingdoms.annex(toKid, fromKid, 'merge')) return bad('присоединение не удалось');
        fx.push('«' + kb.name + '» вошло в состав королевства');
        break;
      }
      case 'break_free': {
        const hadStrength = Kingdoms.strength(toKid) >= Kingdoms.strength(fromKid) * 0.8;
        if (!Kingdoms.breakFree(fromKid)) return bad('вы уже свободны');
        fx.push('Вы вышли из подчинения «' + kb.name + '»: отношения −30');
        // the old crown may try to take its vassal back (a just war: the vassal rebelled)
        if (!kb.cmd && hadStrength && R.chance(0.5)) {
          const gl = potentialGoals(toKid, fromKid).slice(0, 1);
          if (gl.length) declareWar(toKid, fromKid, 'rebel', gl);
        }
        break;
      }
      case 'embargo': {
        const t = trw(fromKid, toKid);
        t.emb = S.tick + EMBARGO_TICKS; t.eby = fromKid; t.trade = 0;
        addOpinion(fromKid, toKid, -15, 'Эмбарго');
        say(ka, 'Королевство «' + ka.name + '» объявило эмбарго королевству «' + kb.name + '»', pl);
        fx.push('Эмбарго на ' + yearsText(EMBARGO_TICKS) + ': отношения −15');
        Bus.emit('treatyBroken', 'trade', ka, kb);
        break;
      }
      case 'lift_embargo': {
        const t = tr(fromKid, toKid);
        if (!t || t.eby !== fromKid) return bad('эмбарго нет');
        t.emb = 0; t.eby = 0; trClean(fromKid, toKid);
        fx.push('Эмбарго снято');
        break;
      }
      default: return bad('неизвестное действие');
    }
    return out;
  }

  // ---------------------------------------------------------------- propose / respond / inbox
  const REFUSE = { alliance: 'союза не будет', pact: 'пакта не будет', trade: 'торговля не интересна', marriage: 'брака не будет', guarantee: 'гарантий не примут', call: 'в войну не вступят', demand: 'требование отвергнуто' };
  function refusalText(kind, P, kb) {
    let worst = null;
    for (let i = 0; i < P.causes.length; i++) if (P.causes[i].v <= -8 && (!worst || P.causes[i].v < worst.v)) worst = P.causes[i];
    if (kind === 'demand') return 'Отказ: «' + kb.name + '» не боится — ' + P.note.charAt(0).toLowerCase() + P.note.slice(1);
    return 'Отказ: ' + REFUSE[kind] + ' (' + Math.round(P.score) + ' из ' + Math.round(P.need) + ')' + (worst ? '. ' + worst.why : '');
  }
  /** what a refusal leaves behind: a casus for an ultimatum, a bad mood after a refused call, a memory so that the AI does not nag */
  function refuse(kind, ka, kb, P, terms, expired) {
    const m = dmod();
    if (kind === 'demand') {
      const d = P.data || {};
      const goals = d.what === 'region' && d.rid ? [d.rid] : potentialGoals(ka.id, kb.id).slice(0, 2);
      m.ult[ka.id + '>' + kb.id] = { until: S.tick + ULT_TTL, goals };
      addOpinion(ka.id, kb.id, -10, 'Отказ на ультиматум');
    } else if (kind === 'call') {
      if (P.data) m.call[P.data.warId + ':' + kb.id] = S.tick + 600;
      addOpinion(ka.id, kb.id, -6, 'Отказ в помощи');
    } else m.rf[key(ka.id, kb.id) + ':' + kind] = S.tick + 900;
    void terms; void expired;
  }
  function cleanTerms(kind, terms, P) {
    const t = terms && typeof terms === 'object' ? terms : {};
    if (kind === 'pact') return { years: P.data.years };
    if (kind === 'demand') return { what: P.data.what, size: P.data.size, rid: P.data.rid, war: Array.isArray(t.war) ? goalIds(t.war) : [] };
    if (kind === 'call') return { warId: P.data.warId };
    return {};
  }
  /** a proposal to the COMMANDED kingdom waits for the player */
  function enqueue(fromKid, toKid, kind, terms) {
    const m = dmod();
    for (let i = 0; i < m.inbox.length; i++) { const e = m.inbox[i]; if (e.from === fromKid && e.to === toKid && e.kind === kind) return e; }
    const e = { id: m.nid++, from: fromKid, to: toKid, kind, terms: terms || {}, at: S.tick, until: S.tick + INBOX_TTL };
    m.inbox.push(e);
    let n = 0, oldest = -1;
    for (let i = 0; i < m.inbox.length; i++) if (m.inbox[i].to === toKid) { n++; if (oldest < 0) oldest = i; }
    if (n > INBOX_MAX && oldest >= 0) m.inbox.splice(oldest, 1);
    const ka = kget(fromKid), kb = kget(toKid);
    if (ka && kb) {
      const t = proposalView(e);
      const cap = capCity(ka);
      Log.add('Королевство «' + ka.name + '» ' + t.text + ' (для «' + kb.name + '»)', LOG.KINGDOM, cap ? cap.x : -1, cap ? cap.y : -1, ka.id);
    }
    Bus.emit('diploProposal', e);
    return e;
  }
  function declineEffects(e, ka, kb, expired) {
    const pd = e.kind === 'call' ? { warId: e.terms.warId } : e.kind === 'demand' ? { what: e.terms.what, rid: e.terms.rid } : null;
    refuse(e.kind, ka, kb, { data: pd, causes: [] }, e.terms, expired);
    if (e.kind === 'demand' && Array.isArray(e.terms.war) && e.terms.war.length && ultimatumFresh(e.from, e.to) && canDeclare(e.from, e.to).ok) {
      declareWar(e.from, e.to, 'ultimatum', e.terms.war);        // the ultimatum was refused: the war the AI had prepared begins
    }
  }
  function resolveByAI(e, ka, kb) {
    const P = plan(e.kind, e.from, e.to, e.terms);
    if (P.ok && (P.accept || !P.needs)) { const x = execute(e.kind, e.from, e.to, P); Bus.emit('diploResolved', e, x.ok, true); return; }
    declineEffects(e, ka, kb, false);
    Bus.emit('diploResolved', e, false, true);
  }
  function inboxStep(tick) {
    const m = dmod();
    for (let i = m.inbox.length - 1; i >= 0; i--) {
      const e = m.inbox[i], ka = kget(e.from), kb = kget(e.to);
      if (!ka || !kb) { m.inbox.splice(i, 1); continue; }
      if (!kb.cmd) { m.inbox.splice(i, 1); resolveByAI(e, ka, kb); continue; }          // the player let go of the kingdom: its AI answers
      if (tick >= e.until) { m.inbox.splice(i, 1); declineEffects(e, ka, kb, true); Bus.emit('diploResolved', e, false, true); }
    }
  }
  /** one proposal as the UI shows it */
  function proposalView(e) {
    const ka = S.kingdoms.get(e.from), t = e.terms || {};
    let title = '', text = '', danger = false, icon = KIND[e.kind] ? KIND[e.kind].icon : 'scroll';
    switch (e.kind) {
      case 'alliance': title = 'Союз'; text = 'предлагает союз'; break;
      case 'pact': title = 'Пакт о ненападении'; text = 'предлагает пакт о ненападении на ' + yearsText((t.years || 20) * TPY); break;
      case 'trade': title = 'Торговое соглашение'; text = 'предлагает торговое соглашение'; break;
      case 'marriage': title = 'Династический брак'; text = 'предлагает династический брак'; break;
      case 'guarantee': title = 'Гарантии'; text = 'предлагает гарантии вашей независимости'; break;
      case 'call': {
        const w = S.wars.get(t.warId), foes = w ? (w.attackers.indexOf(e.from) >= 0 ? w.defenders : w.attackers) : [];
        const f = foes.length ? S.kingdoms.get(foes[0]) : null;
        title = 'Просьба о помощи'; text = 'просит помощи в войне' + (f ? ' с «' + f.name + '»' : ''); break;
      }
      case 'demand': {
        danger = true; icon = 'demand'; title = 'Ультиматум';
        if (t.what === 'region') text = 'требует отдать регион «' + (S.regions.get(t.rid) ? S.regions.get(t.rid).name : '?') + '»';
        else if (t.what === 'vassal') text = 'требует признать его сюзереном';
        else text = 'требует дань («' + (TRIBUTE[(t.size | 0) - 1] ? TRIBUTE[(t.size | 0) - 1].name.toLowerCase() : 'дань') + '»)';
        break;
      }
      default: title = e.kind; text = 'делает предложение';
    }
    return { id: e.id, from: e.from, to: e.to, kind: e.kind, icon, title, text, danger, at: e.at, left: Math.max(0, e.until - S.tick), terms: JSON.parse(JSON.stringify(t)), fromName: ka ? ka.name : '?' };
  }
  function inbox(kid) {
    const out = [], m = dmod();
    for (let i = 0; i < m.inbox.length; i++) if (m.inbox[i].to === kid && kget(m.inbox[i].from)) out.push(proposalView(m.inbox[i]));
    return out;
  }
  function respond(id, accept) {
    const res = { ok: false, accepted: false, pending: false, reason: '', kind: '', effects: [] };
    try {
      const m = dmod();
      let i = -1;
      for (let q = 0; q < m.inbox.length; q++) if (m.inbox[q].id === id) { i = q; break; }
      if (i < 0) { res.reason = 'предложение устарело'; return res; }
      const e = m.inbox[i];
      m.inbox.splice(i, 1);
      res.kind = e.kind;
      const ka = kget(e.from), kb = kget(e.to);
      if (!ka || !kb) { res.reason = 'королевство пало'; return res; }
      res.ok = true;
      if (!accept) { declineEffects(e, ka, kb, false); Bus.emit('diploResolved', e, false, false); res.reason = 'Предложение отклонено'; return res; }
      const P = plan(e.kind, e.from, e.to, e.terms);
      if (!P.ok) { res.ok = false; res.reason = 'Условия изменились: ' + P.reason; Bus.emit('diploResolved', e, false, true); return res; }
      const x = execute(e.kind, e.from, e.to, P);
      res.accepted = x.ok; res.effects = x.effects; res.reason = x.ok ? 'Принято' : x.reason; res.ok = x.ok || res.ok;
      Bus.emit('diploResolved', e, x.ok, false);
    } catch (err) { res.ok = false; res.reason = 'ошибка дипломатии'; if (typeof console !== 'undefined') console.error('Diplomacy.respond', err); }
    return res;
  }
  function proposePeace(P, fromKid, res) {
    let r = null;
    try { r = War.peaceOffer(P.data.warId, fromKid, { regions: [], vassalize: false }); } catch (e) { r = null; }
    if (!r) { res.ok = false; res.reason = 'мир сейчас невозможен'; return res; }
    res.ok = !!r.ok; res.accepted = !!r.accepted; res.pending = !!r.pending; res.reason = r.reason || '';
    if (res.accepted) res.effects.push('Мир заключён');
    return res;
  }
  /** Diplomacy.propose(from, to, kind, terms) — see the header of this section. Never throws. */
  function propose(fromKid, toKid, kind, terms) {
    const res = { ok: false, accepted: false, pending: false, reason: '', kind: String(kind || ''), effects: [], causes: [], margin: 0, id: 0 };
    try {
      const P = plan(kind, fromKid, toKid, terms);
      if (!P.ok) { res.reason = P.reason; return res; }
      res.ok = true; res.causes = P.causes.slice(0, 6); res.margin = P.margin;
      const ka = kget(fromKid), kb = kget(toKid);
      if (kind === 'peace') return proposePeace(P, fromKid, res);
      if (!NEEDS_ANSWER[kind]) {
        const x = execute(kind, fromKid, toKid, P);
        res.accepted = x.ok; res.ok = x.ok; res.reason = x.reason; res.effects = x.effects;
        return res;
      }
      if (kb.cmd && !ka.cmd) {                                  // the player answers
        const e = enqueue(fromKid, toKid, kind, cleanTerms(kind, terms, P));
        res.pending = true; res.id = e ? e.id : 0; res.reason = 'ждёт решения';
        return res;
      }
      if (P.accept) {
        const x = execute(kind, fromKid, toKid, P);
        res.accepted = x.ok; res.ok = x.ok; res.reason = x.reason; res.effects = x.effects;
      } else {
        refuse(kind, ka, kb, P, terms, false);
        res.reason = refusalText(kind, P, kb);
      }
    } catch (e) {
      res.ok = false; res.accepted = false; res.reason = 'ошибка дипломатии';
      if (typeof console !== 'undefined') console.error('Diplomacy.propose', e);
    }
    return res;
  }

  // ---------------------------------------------------------------- wars: call to arms, guarantees, late joiners
  /** ask every ally to join the war (warId omitted: the latest war each of them is missing in) */
  function callAllies(kid, warId) {
    const out = { called: [], joined: [], refused: [], pending: [] };
    const ps = partnersOf(kid);
    for (let i = 0; i < ps.length; i++) {
      const r = propose(kid, ps[i], 'call', warId ? { warId } : {});
      if (!r.ok) continue;
      out.called.push(ps[i]);
      if (r.accepted) out.joined.push(ps[i]); else if (r.pending) out.pending.push(ps[i]); else out.refused.push({ kid: ps[i], reason: r.reason });
    }
    return out;
  }
  /** the guarantors of an attacked kingdom step in (War.join) or lose face */
  function honourGuarantees(w) {
    const m = dmod();
    for (const k in m.tr) {
      const t = m.tr[k];
      if (!t.gu) continue;
      const ab = k.split('_'), guaranteed = t.gu === +ab[0] ? +ab[1] : +ab[0], guarantor = t.gu;
      if (w.defenders.indexOf(guaranteed) < 0 || w.attackers.indexOf(guaranteed) >= 0) continue;
      if (w.attackers.indexOf(guarantor) >= 0 || w.defenders.indexOf(guarantor) >= 0) continue;
      const kg = kget(guarantor), kd = kget(guaranteed);
      if (!kg || !kd) continue;
      if (typeof War === 'undefined' || !War || typeof War.join !== 'function') continue;
      if (isAllied(guarantor, w.aggressor) || warsOf(guarantor) >= 2) {
        t.gu = 0;
        addOpinion(guarantor, guaranteed, -20, 'Гарантия не выполнена');
        say(kg, 'Королевство «' + kg.name + '» не выполнило гарантий независимости «' + kd.name + '»', involvesPlayer(kg, kd));
        trClean(guarantor, guaranteed);
        continue;
      }
      let joined = false;
      try { joined = !!War.join(w.id, guarantor, guaranteed); } catch (e) { joined = false; }
      if (joined) say(kg, 'Королевство «' + kg.name + '» вступилось за «' + kd.name + '», как обещало', true);
    }
  }
  /** a kingdom joined a running war (called to arms, honoured guarantee): the same cleaning of treaties as at a declaration */
  function onWarJoined(w, kid, onKid) {
    if (!w || !S.kingdoms.has(kid)) return;
    const foes = w.attackers.indexOf(onKid) >= 0 ? w.defenders : w.attackers;
    for (let i = 0; i < foes.length; i++) {
      const y = foes[i];
      warEndsTreaties(kid, y);
      const rel = peek(kid, y);
      if (!rel) continue;
      if (rel.state === REL.ALLIANCE) breakAlliance(kid, y, 'Союз против союзника');
      rel.truceUntil = 0; rel.since = S.tick;
      addOpinion(kid, y, -15, 'Вступил в войну');
    }
  }
  Bus.on('warJoined', (w, kid, onKid) => { try { onWarJoined(w, kid, onKid); } catch (e) { if (typeof console !== 'undefined') console.error('Diplomacy.warJoined', e); } });

  // ---------------------------------------------------------------- treaty upkeep (every 10 ticks: pacts expire, caravans roll, broken conditions cancel)
  function marketsIn(c) {
    let n = 0;
    for (let i = 0; i < c.buildings.length; i++) { const b = S.buildings.get(c.buildings[i]); if (b && b.done && b.type === Const.B.MARKET) n++; }
    return n;
  }
  function tradeCity(k, partner) {
    const pc = capCity(partner);
    let best = null, bs = -1e9;
    for (let i = 0; i < k.cities.length; i++) {
      const c = S.cities.get(k.cities[i]);
      if (!c || c.occupierId) continue;
      const sc = marketsIn(c) * 1000 - (pc ? Util.dist(c.x, c.y, pc.x, pc.y) : 0);
      if (sc > bs) { bs = sc; best = c; }
    }
    return best || freeCity(k);
  }
  /** one caravan: the partner's wares arrive in the trade city (the one with markets, else the capital) */
  function caravan(k, partner, allied) {
    const c = tradeCity(k, partner);
    if (!c) return 0;
    const n = 1 + Math.min(3, marketsIn(c)) + (allied ? 1 : 0), goods = RACE_GOODS[partner.race] || RACE_GOODS[0];
    let got = 0;
    for (let i = 0; i < goods.length; i++) got += Cities.deposit(c.id, goods[i], n) || 0;
    return got;
  }
  function treatyStep(tick) {
    const m = dmod();
    if (m.inbox.length) inboxStep(tick);
    for (const k in m.tr) {
      const t = m.tr[k];
      const ab = k.split('_'), a = +ab[0], b = +ab[1];
      const ka = kget(a), kb = kget(b);
      if (!ka || !kb) { if (t.marr) { marriedIds.delete(t.marr.ua); marriedIds.delete(t.marr.ub); } delete m.tr[k]; continue; }
      if (t.pact && t.pact <= tick) {
        t.pact = 0; t.pb = 0;
        if (involvesPlayer(ka, kb)) say(ka, 'Пакт о ненападении между «' + ka.name + '» и «' + kb.name + '» истёк', true);
        Bus.emit('treatyBroken', 'pact', ka, kb, true);
      }
      if (t.emb && t.emb <= tick) { t.emb = 0; t.eby = 0; }
      if (t.gu && (!kget(t.gu) || atWar(a, b))) t.gu = 0;
      if (t.trade) {
        if (atWar(a, b) || t.emb > tick) { t.trade = 0; }
        else if (contactOf(a, b) <= 0 && !(info(a).markets > 0 && info(b).markets > 0)) {
          t.trade = 0;
          say(ka, 'Торговля между «' + ka.name + '» и «' + kb.name + '» прекратилась: нет торговых путей', involvesPlayer(ka, kb));
          Bus.emit('treatyBroken', 'trade', ka, kb, true);
        } else if (((tick / 10) + a * 3 + b) % (TRADE_PERIOD / 10) === 0) {
          const al = ka.overlordId === b || kb.overlordId === a || (peek(a, b) && peek(a, b).state === REL.ALLIANCE);
          caravan(ka, kb, al); caravan(kb, ka, al);
        }
      }
      trClean(a, b);
    }
    if (tick % 600 === 0) {                                      // memories that ran out
      for (const key2 of Object.keys(m.ult)) if (m.ult[key2].until <= tick) delete m.ult[key2];
      for (const key2 of Object.keys(m.rf)) if (m.rf[key2] <= tick) delete m.rf[key2];
      for (const key2 of Object.keys(m.call)) if (m.call[key2] <= tick) delete m.call[key2];
      for (const key2 of Object.keys(m.vtc)) if (m.vtc[key2] <= tick || !S.kingdoms.has(+key2)) delete m.vtc[key2];
      for (const key2 of Object.keys(m.gift)) if (tick - m.gift[key2] > 3000) delete m.gift[key2];
    }
  }

  // ---------------------------------------------------------------- presentation for the UI: actionsFor / card / treaties
  function present(kind, P, extra) {
    const K = KIND[kind] || { label: kind, icon: 'scroll', group: 'treaty', cost: '' };
    const a = { kind, label: K.label, icon: K.icon, group: K.group, available: !!P.ok, reason: P.ok ? '' : P.reason, hint: '', tone: '', odds: null, cost: K.cost, danger: !!K.danger };
    if (P.ok) {
      if (kind === 'peace') { a.hint = 'Решит противник'; a.tone = ''; }
      else if (P.needs) { a.odds = clamp(0.5 + P.margin / 20, 0.02, 0.98); a.hint = words(P.margin); a.tone = tone(P.margin); a.margin = P.margin; a.score = P.score; a.need = P.need; }
      else a.hint = '';
      if (P.note) a.note = P.note;
      if (P.causes && P.causes.length) a.causes = P.causes.slice(0, 6);
      if (P.data && (kind === 'marriage' || kind === 'tribute' || kind === 'annex' || kind === 'break_alliance')) a.data = P.data;
      if (kind === 'gift' && P.data) a.options = P.data.options;
    }
    if (extra) for (const k2 in extra) a[k2] = extra[k2];
    return a;
  }
  function pactOptions(fromKid, toKid) {
    const out = [];
    for (let i = 0; i < PACT_YEARS.length; i++) {
      const p = plan('pact', fromKid, toKid, { years: PACT_YEARS[i] });
      out.push({ years: PACT_YEARS[i], label: PACT_YEARS[i] + ' лет', ok: p.ok, reason: p.reason, accept: p.accept, margin: p.margin, hint: p.ok ? words(p.margin) : p.reason, tone: p.ok ? tone(p.margin) : 'bad' });
    }
    return out;
  }
  function demandVariants(fromKid, toKid) {
    const out = [], ka = kget(fromKid), kb = kget(toKid);
    for (let s = 1; s <= TRIBUTE.length; s++) {
      const p = plan('demand', fromKid, toKid, { what: 'tribute', size: s });
      out.push({ what: 'tribute', size: s, label: TRIBUTE[s - 1].name, ok: p.ok, reason: p.reason, accept: p.accept, margin: p.margin, ratio: p.score, need: p.need, note: p.note, goods: p.data && p.data.goods ? p.data.goods : {}, value: p.data && p.data.value ? p.data.value : 0, hint: p.ok ? (p.accept ? 'Уступят' : 'Откажут') : p.reason, tone: p.ok ? (p.accept ? 'good' : 'bad') : 'bad' });
    }
    if (rgOn() && ka && kb) {
      const ids = Regions.attackable(fromKid, toKid).slice(0, 8);
      const cap = S.cities.get(kb.capitalId);
      for (let i = 0; i < ids.length; i++) {
        const r = Regions.get(ids[i]);
        if (!r || r.ownerId !== toKid) continue;
        const p = plan('demand', fromKid, toKid, { what: 'region', rid: r.id });
        out.push({ what: 'region', rid: r.id, label: r.name, cities: r.cityIds.length, value: r.value || 0, capital: !!(cap && cap.regionId === r.id), ok: p.ok, reason: p.reason, accept: p.accept, margin: p.margin, ratio: p.score, need: p.need, note: p.note, hint: p.ok ? (p.accept ? 'Уступят' : 'Откажут') : p.reason, tone: p.ok ? (p.accept ? 'good' : 'bad') : 'bad' });
      }
    }
    const pv = plan('demand', fromKid, toKid, { what: 'vassal' });
    out.push({ what: 'vassal', label: 'Вассалитет', ok: pv.ok, reason: pv.reason, accept: pv.accept, margin: pv.margin, ratio: pv.score, need: pv.need, note: pv.note, hint: pv.ok ? (pv.accept ? 'Покорятся' : 'Откажут') : pv.reason, tone: pv.ok ? (pv.accept ? 'good' : 'bad') : 'bad' });
    return out;
  }
  /** every action the kingdom `fromKid` can take towards `toKid` — available or not (with the reason), with the forecast of the answer */
  function actionsFor(fromKid, toKid) {
    const ka = kget(fromKid), kb = kget(toKid), out = [];
    if (!ka || !kb || fromKid === toKid) return out;
    const rel = get(fromKid, toKid);
    if (!rel) return out;
    const war = atWar(fromKid, toKid), lk = linked(ka, kb), allied = rel.state === REL.ALLIANCE && !lk;
    const add = (kind, terms, extra) => { const P = plan(kind, fromKid, toKid, terms); const a = present(kind, P, extra); out.push(a); return a; };
    if (war) {
      add('peace');
      for (const k2 of ['alliance', 'pact', 'trade', 'gift', 'demand']) add(k2);
      return out;
    }
    if (lk) {
      if (kb.overlordId === fromKid) { add('gift'); add('tribute'); add('annex'); add('release'); }
      else { add('gift'); add('break_free'); }
      return out;
    }
    if (allied) add('break_alliance'); else add('alliance');
    if (pactLeft(fromKid, toKid) > 0) add('break_pact'); else add('pact', { years: 20 }, { options: pactOptions(fromKid, toKid) });
    if (tradeOn(fromKid, toKid)) add('cancel_trade'); else add('trade');
    add('gift');
    // a demand has three kinds of terms (tribute / region / vassalage): the action is available when at least one of them can be put forward
    const dv = demandVariants(fromKid, toKid), dOk = dv.filter((o) => o.ok), dWin = dOk.filter((o) => o.accept);
    out.push(present('demand', { ok: dOk.length > 0, reason: dOk.length ? '' : (dv[0] ? dv[0].reason : 'требовать нечего'), needs: false, causes: [], note: '' },
      { options: dv, hint: dOk.length ? (dWin.length ? 'Можно потребовать' : 'Слабовато для требований') : '', tone: dOk.length ? (dWin.length ? 'good' : 'warn') : '' }));
    if (!marriageOf(fromKid, toKid)) add('marriage');
    if (guarantorOf(fromKid, toKid) === fromKid) add('break_guarantee'); else add('guarantee');
    if (allied && warsOf(fromKid) > 0) add('call', {}, callOptions(fromKid, toKid));
    const te = tr(fromKid, toKid);
    if (te && te.emb > S.tick && te.eby === fromKid) add('lift_embargo'); else if (!allied) add('embargo');
    return out;
  }
  /** which of my wars the ally could be called into (only when there is a choice) */
  function callOptions(fromKid, toKid) {
    const c = plan('call', fromKid, toKid, {});
    if (!c.ok || !c.data || c.data.wars.length < 2) return null;
    return {
      options: c.data.wars.map((wid) => {
        const p = plan('call', fromKid, toKid, { warId: wid }), w = S.wars.get(wid);
        const foes = w ? (w.attackers.indexOf(fromKid) >= 0 ? w.defenders : w.attackers) : [], f = foes.length ? S.kingdoms.get(foes[0]) : null;
        return { warId: wid, label: 'Война с «' + (f ? f.name : '?') + '»', ok: p.ok, reason: p.reason, accept: p.accept, margin: p.margin, hint: p.ok ? words(p.margin) : p.reason, tone: p.ok ? tone(p.margin) : 'bad' };
      }),
    };
  }
  /** chips for the pair: [{id, text, tone, left}] */
  function treatiesOf(a, b) {
    const ka = kget(a), kb = kget(b), out = [];
    if (!ka || !kb || a === b) return out;
    const rel = peek(a, b), t = tr(a, b);
    if (atWar(a, b)) out.push({ id: 'war', text: 'Война', tone: 'bad' });
    if (ka.overlordId === b) out.push({ id: 'overlord', text: 'Сюзерен', tone: 'purple' });
    else if (kb.overlordId === a) out.push({ id: 'vassal', text: 'Вассал', tone: 'purple' });
    else if (rel && rel.state === REL.ALLIANCE) out.push({ id: 'alliance', text: 'Союз', tone: 'good' });
    if (pactLeft(a, b) > 0) out.push({ id: 'pact', text: 'Пакт', tone: 'good', left: pactLeft(a, b) });
    else if (rel && rel.truceUntil > S.tick && !atWar(a, b)) out.push({ id: 'truce', text: 'Перемирие', tone: 'warn', left: rel.truceUntil - S.tick });
    if (t && t.trade) out.push({ id: 'trade', text: 'Торговля', tone: 'gold' });
    if (t && t.marr) out.push({ id: 'marriage', text: 'Брак', tone: 'gold' });
    if (t && t.gu) out.push({ id: 'guarantee', text: t.gu === a ? 'Вы гарантируете' : 'Гарантирует вас', tone: 'blue' });
    if (t && t.emb > S.tick) out.push({ id: 'embargo', text: 'Эмбарго', tone: 'bad', left: t.emb - S.tick });
    if (!out.length) out.push({ id: 'peace', text: 'Мир', tone: '' });
    return out;
  }
  /** everything the UI card of a pair needs in one call */
  function card(aKid, bKid) {
    const ka = kget(aKid), kb = kget(bKid);
    if (!ka || !kb || aKid === bKid) return null;
    const rel = get(aKid, bKid);
    if (!rel) return null;
    const pa = power(aKid), pb = power(bKid);
    return {
      a: aKid, b: bKid, opinion: Math.round(rel.opinion) || 0,
      mood: rel.opinion >= 60 ? 'Дружба' : rel.opinion >= 25 ? 'Тепло' : rel.opinion > -25 ? 'Нейтрально' : rel.opinion > -60 ? 'Неприязнь' : 'Вражда',
      causes: rel.causes.map((c) => ({ t: c.t, v: c.v, why: c.why })).sort((x, y) => Math.abs(y.v) - Math.abs(x.v)),
      chips: treatiesOf(aKid, bKid), contact: contactOf(aKid, bKid),
      power: { a: Math.round(pa), b: Math.round(pb), ratio: r1(pb / Math.max(1, pa)) },
      actions: actionsFor(aKid, bKid),
    };
  }

  // ---------------------------------------------------------------- hooks / lifecycle
  function onKingdomCreated(k) {
    if (!k) return;
    for (const o of S.kingdoms.values()) if (o.id !== k.id && o.alive !== false) get(k.id, o.id);
  }
  function onKingdomDestroyed(kid) {
    for (const [k, r] of Array.from(S.rels.entries())) if (r.a === kid || r.b === kid) S.rels.delete(k);
    const m = dmod();
    delete m.cd[kid]; delete m.acd[kid]; delete m.dcd[kid]; delete m.lg[kid]; delete m.vtc[kid];
    for (const k of Object.keys(m.tr)) {
      const ab = k.split('_');
      if (+ab[0] === kid || +ab[1] === kid) { const t = m.tr[k]; if (t.marr) { marriedIds.delete(t.marr.ua); marriedIds.delete(t.marr.ub); } delete m.tr[k]; }
    }
    for (let i = m.inbox.length - 1; i >= 0; i--) if (m.inbox[i].from === kid || m.inbox[i].to === kid) m.inbox.splice(i, 1);
    for (const k of Object.keys(m.ult)) { const ab = k.split('>'); if (+ab[0] === kid || +ab[1] === kid) delete m.ult[k]; }
    for (const k of Object.keys(m.rf)) { const ab = k.split(':')[0].split('_'); if (+ab[0] === kid || +ab[1] === kid) delete m.rf[k]; }
    for (const k of Object.keys(m.gift)) { const ab = k.split('_'); if (+ab[0] === kid || +ab[1] === kid) delete m.gift[k]; }
  }
  function newWorld() { S.mod.diplomacy = freshMod(); marriedIds.clear(); memo.tick = -1; }
  function afterLoad() {
    const m = dmod();
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
    // treaties and the inbox: drop what points at nothing; rebuild the marriage cache
    marriedIds.clear();
    for (const k of Object.keys(m.tr)) {
      const t = m.tr[k], ab = k.split('_');
      if (!t || typeof t !== 'object' || !S.kingdoms.has(+ab[0]) || !S.kingdoms.has(+ab[1])) { delete m.tr[k]; continue; }
      for (const f of ['pact', 'pb', 'trade', 'emb', 'eby', 'gu']) if (typeof t[f] !== 'number' || t[f] !== t[f]) t[f] = 0;
      if (t.marr && (typeof t.marr !== 'object' || typeof t.marr.ua !== 'number' || typeof t.marr.ub !== 'number')) t.marr = null;
      if (!t.marr) t.marr = null; else { marriedIds.add(t.marr.ua); marriedIds.add(t.marr.ub); }
      trClean(+ab[0], +ab[1]);
    }
    m.inbox = m.inbox.filter((e) => e && typeof e === 'object' && typeof e.id === 'number' && S.kingdoms.has(e.from) && S.kingdoms.has(e.to) && typeof e.kind === 'string' && e.terms && typeof e.terms === 'object');
    for (const e of m.inbox) { if (e.id >= m.nid) m.nid = e.id + 1; if (typeof e.until !== 'number') e.until = S.tick + INBOX_TTL; }
  }

  function step(tick) {
    if (tick === undefined) tick = S.tick;
    if (tick % 10 !== 0 || S.kingdoms.size < 2) return;
    const slot = tick / 10;
    for (const rel of S.rels.values()) if ((slot + rel.a * 3 + rel.b) % 10 === 0) refreshRel(rel, false);
    treatyStep(tick);
    if (slot % 2 === 0) aiTick(tick);
  }

  // ---------------------------------------------------------------- the tool «Дипломатия» (UI-only: taps never reach Powers; this plugin just keeps Powers.apply from erroring)
  ToolDefs.add({ id: 'diplomacy', tab: 'kingdoms', group: 'command', name: 'Дипломатия', short: 'Дипломатия', icon: 'handshake', brush: false, drag: false, hint: 'Выберите свою страну, затем другую: договоры, подарки, требования' });
  PowerPlugins.push({ name: 'diplomacy', ids: ['diplomacy'], apply(id, x, y, r, first, lx, ly, host) { return host.msg('', false); } });

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
    // player diplomacy (docs/feat_diplomacy.md)
    propose, respond, inbox, actionsFor, card, treaties: treatiesOf, callAllies, plan,
    pactLeft, tradeOn, embargoLeft: embLeft, marriageOf, guarantorOf, hasUltimatum: ultimatumFresh,
    KINDS: Object.keys(KIND), PACT_YEARS: PACT_YEARS.slice(),
  };
})();
