/* =====================================================================
 * 08_kingdoms.js — Kingdoms: creation, rulers & succession, stability, per-city loyalty, culture, rebellion,
 *                  merge / vassal / secession, capital relocation, strength.
 * OWNER: Kingdoms+Diplomacy agent. API: docs/CONTRACT.md §3 + §8.3.   DOM-free, deterministic (all randomness through R).
 *
 *  Kingdom  {id,name,race,color,flag,capitalId,rulerId,cities[],culture,stability,born,alive,hist,clan,
 *            cmd,overlordId,infamy,manpowerUsed /*War*\/, rebels,lastRebel,succAt,crisis,reigns,vassalSince,peaceAt,consortId}
 *           Every kingdom is created by ONE object literal (makeKingdom): Save packs entities as column tables, so the key order
 *           must be identical for all of them; never add keys later, only assign.
 *  Private persistent state: S.mod.kingdoms = {logAt:{kid:tick}, dead:{kid:{...}}, low:{cityId:tick}, retry:{kid:tick}}.
 *
 *  Schedule (Kingdoms.step):  every tick  throne check per kingdom (O(K));
 *                             every 30 ticks per kingdom (staggered by id)  stability, infamy / rebel decay, ruler sanity;
 *                             every 120 ticks per city (staggered by id)  loyalty, culture assimilation / diffusion, rebellion roll;
 *                             every 240 ticks per kingdom  culture majority, capital relocation, vassal break-free.
 *  Ruler death: a Bus 'unitDied' listener records the dead ruler's family ids in S.mod.kingdoms.dead; step() crowns the heir
 *               (eldest adult child -> sibling -> clan member -> best citizen of the capital -> best citizen anywhere).
 *  Ownership of land is NOT implied by city.kingdomId: whenever a city moves, Regions.setOwner / onCityTransferred is called here.
 * ===================================================================== */

const Kingdoms = (() => {
  const LOG = Const.LOG, TPY = Const.TICKS_PER_YEAR;

  // ---------------------------------------------------------------- tunables
  const KPASS = 30;                 // ticks between stability passes of one kingdom
  const CPASS = 120;                // ticks between loyalty passes of one city
  const SLOW = 240;                 // ticks between culture / capital / vassal checks of one kingdom
  const LOW_LOYALTY = 30;           // below this a city is restless
  const REBEL_AFTER = 300;          // ticks of restlessness before a rebellion can start
  const REBEL_COOLDOWN = 1200;      // min ticks between two rebellions in one kingdom
  const FLAG_C2 = ['#ffffff', '#222222', '#f2c230', '#d0d0d0'];
  const FLAG_C3 = ['#ffffff', '#111111', '#f2c230'];
  const EXTRA_KEYS = ['cmd', 'overlordId', 'infamy', 'manpowerUsed', 'rebels', 'lastRebel', 'succAt', 'crisis', 'reigns', 'vassalSince', 'peaceAt', 'consortId'];

  // ---------------------------------------------------------------- small helpers
  function get(id) { return S.kingdoms.get(id) || null; }
  function alive(k) { return !!k && k.alive !== false && S.kingdoms.get(k.id) === k; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function rc(race) { return Races.list[race] || Races.list[0]; }
  function rgOn() { return typeof Regions !== 'undefined' && !Regions.__stub && Regions.active(); }
  function dipOn() { return typeof Diplomacy !== 'undefined' && !Diplomacy.__stub; }
  function mod() {
    let m = S.mod.kingdoms;
    if (!m || typeof m !== 'object' || Array.isArray(m)) m = S.mod.kingdoms = { logAt: {}, dead: {}, low: {}, retry: {} };
    if (!m.logAt || typeof m.logAt !== 'object') m.logAt = {};
    if (!m.dead || typeof m.dead !== 'object') m.dead = {};
    if (!m.low || typeof m.low !== 'object') m.low = {};
    if (!m.retry || typeof m.retry !== 'object') m.retry = {};
    return m;
  }
  /** feed spam control: routine events of one kingdom at most once per 20 ticks */
  function routine(k, msg, x, y) {
    const m = mod(), last = m.logAt[k.id];
    if (last !== undefined && S.tick >= last && S.tick - last < 20) return false;
    m.logAt[k.id] = S.tick;
    Log.add(msg, LOG.KINGDOM, x === undefined ? -1 : x, y === undefined ? -1 : y, k.id);
    return true;
  }
  function titleOf(u) { return Names.ruler(u.race, u.sex).toLowerCase(); }
  function isAdult(u) { return Util.age(u) >= rc(u.race).maturity; }
  function countB(c, type) {
    let n = 0;
    const ids = c.buildings;
    for (let i = 0; i < ids.length; i++) { const b = S.buildings.get(ids[i]); if (b && b.type === type && b.done) n++; }
    return n;
  }
  function warInvolving(kid, fn) {
    for (const w of S.wars.values()) {
      if (w.ended) continue;
      if (w.attackers.indexOf(kid) >= 0 || w.defenders.indexOf(kid) >= 0) fn(w);
    }
  }
  function atWarAny(kid) {
    for (const w of S.wars.values()) {
      if (!w.ended && (w.attackers.indexOf(kid) >= 0 || w.defenders.indexOf(kid) >= 0)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- cultures, colours, flags, names
  function newCulture(race, label) {
    const id = S.cultures.length;
    const used = new Set();
    for (const k of S.kingdoms.values()) { const cu = S.cultures[k.culture]; if (cu) used.add(cu.color); }
    for (const c of S.cities.values()) { const cu = S.cultures[c.culture]; if (cu) used.add(cu.color); }
    let color = null;
    for (let i = 0; i < Palette.culture.length; i++) { const col = Palette.culture[(id + i) % Palette.culture.length]; if (!used.has(col)) { color = col; break; } }
    if (!color) color = Palette.culture[id % Palette.culture.length];
    S.cultures.push({ id, name: label ? 'Культура «' + label + '»' : 'Культура ' + (id + 1), color, race });
    return id;
  }
  function hexColor(h, s, l) {   // hsl -> #rrggbb
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return Util.hex([f(0) * 255, f(8) * 255, f(4) * 255]);
  }
  function pickColor() {
    const used = new Set();
    for (const k of S.kingdoms.values()) used.add(k.color);
    for (const c of Palette.kingdom) if (!used.has(c)) return c;
    for (let i = 0; i < 40; i++) { const c = hexColor(R.i(360), 55 + R.i(30), 40 + R.i(20)); if (!used.has(c)) return c; }
    return Palette.kingdom[S.kingdoms.size % Palette.kingdom.length];
  }
  function flagKey(f) { return f.pattern + ':' + f.symbol + ':' + f.c1 + ':' + f.c2; }
  function randomFlag() {
    const taken = new Set();
    for (const k of S.kingdoms.values()) if (k.flag) taken.add(flagKey(k.flag));
    const c1 = pickColor();
    let f = null;
    for (let i = 0; i < 40; i++) {
      f = { pattern: R.i(6), symbol: R.i(10), c1, c2: R.pick(FLAG_C2), c3: R.pick(FLAG_C3) };
      if (!taken.has(flagKey(f))) break;
    }
    return f;
  }
  function uniqueName(race) {
    let n = '';
    for (let i = 0; i < 24; i++) {
      n = Names.kingdom(race);
      let clash = false;
      for (const k of S.kingdoms.values()) if (k.name === n) { clash = true; break; }
      if (!clash) return n;
    }
    let j = 2;
    for (;;) {
      const m = n + ' ' + j++;
      let clash = false;
      for (const k of S.kingdoms.values()) if (k.name === m) { clash = true; break; }
      if (!clash) return m;
    }
  }

  // ---------------------------------------------------------------- creation
  function makeKingdom(race, opts) {
    opts = opts || {};
    const id = S.id();
    const flag = randomFlag();
    const name = opts.name || uniqueName(race);
    const k = {
      id, name, race, color: flag.c1, flag, capitalId: 0, rulerId: 0, cities: [],
      culture: opts.culture !== undefined ? opts.culture : newCulture(race, name),
      stability: 70, born: S.tick, alive: true, hist: [], clan: Names.clan(race),
      cmd: false, overlordId: 0, infamy: 0, manpowerUsed: 0, rebels: 0, lastRebel: 0, succAt: 0, crisis: 0, reigns: 0, vassalSince: 0, peaceAt: S.tick, consortId: 0,
    };
    S.kingdoms.set(id, k);
    Hist.add(k, opts.hist || 'Основано');
    return k;
  }
  /** call once the kingdom owns its first city: relations, Bus event */
  function announce(k) {
    if (dipOn()) Diplomacy.onKingdomCreated(k);
    S.touchOwner();
    Bus.emit('kingdomCreated', k);
  }
  function addCity(k, city) {
    if (k.cities.indexOf(city.id) < 0) k.cities.push(city.id);
    city.kingdomId = k.id;
    if (!k.capitalId || !S.cities.has(k.capitalId)) k.capitalId = city.id;
    S.touchOwner();
  }
  function biggestCity(list, skipId) {
    let best = null, bp = -1;
    for (let i = 0; i < list.length; i++) {
      const c = typeof list[i] === 'number' ? S.cities.get(list[i]) : list[i];
      if (!c || c.id === skipId) continue;
      const sc = c.pop + (c.occupierId ? -1000 : 0) + c.level * 0.01;
      if (sc > bp) { bp = sc; best = c; }
    }
    return best;
  }
  /** drop the city from the kingdom's list; the capital moves to the biggest remaining city. Returns true when the capital changed. */
  function dropCity(k, cityId) {
    const i = k.cities.indexOf(cityId);
    if (i >= 0) k.cities.splice(i, 1);
    if (k.capitalId === cityId || !S.cities.has(k.capitalId)) {
      const was = k.capitalId;
      const nc = biggestCity(k.cities, cityId);
      k.capitalId = nc ? nc.id : 0;
      S.touchOwner();
      return was !== k.capitalId && !!nc;
    }
    return false;
  }

  // ---------------------------------------------------------------- rulers
  function policy(kid) {
    const k = get(kid), r = k ? S.units.get(k.rulerId) : null;
    if (!k || !r) return { war: 0, peace: 0, greed: 0, loyalty: k ? -5 : 0 };
    return {
      war: Traits.sum(r, 'war') + (rc(k.race).aggression - 0.35) * 0.9,
      peace: Traits.sum(r, 'peace'),
      greed: Traits.sum(r, 'greed'),
      loyalty: Traits.sum(r, 'loyalty'),
    };
  }
  function rulerScore(u, k, capId) {
    const r = rc(u.race);
    let s = u.level * 2.5;
    s += 6 - Math.abs(Util.age(u) / r.lifespan[0] - 0.38) * 14;                   // prime of life
    s += Traits.sum(u, 'loyalty') * 0.25 + Traits.sum(u, 'peace') * 2 + Traits.sum(u, 'war') * 1.2;
    if (Traits.has(u, 'wise')) s += 1.5;
    if (Traits.has(u, 'lazy')) s -= 2;
    if (Traits.has(u, 'coward')) s -= 1.5;
    if (u.cityId === capId) s += 4;
    if (u.race !== k.race) s -= 6;
    if (u.clan === k.clan) s += 3;
    return s + (u.id % 7) * 0.001;
  }
  const candBuf = [];
  const dying = new Set();                                  // kingdoms inside destroy() (re-entrancy guard)
  /** adult citizens of the kingdom (fit to rule) into candBuf */
  function collectCandidates(k, skipId) {
    candBuf.length = 0;
    for (let i = 0; i < k.cities.length; i++) {
      const c = S.cities.get(k.cities[i]);
      if (!c) continue;
      for (let j = 0; j < c.members.length; j++) {
        const u = S.units.get(c.members[j]);
        if (!u || u.id === skipId || u.cityId !== c.id || !isAdult(u) || u.hp <= 0) continue;
        candBuf.push(u);
      }
    }
    return candBuf;
  }
  function chooseRuler(k, skipId) {
    const cand = collectCandidates(k, skipId);
    const cap = S.cities.get(k.capitalId);
    let best = null, bs = -1e9;
    for (let i = 0; i < cand.length; i++) {
      const sc = rulerScore(cand[i], k, cap ? cap.id : 0);
      if (sc > bs) { bs = sc; best = cand[i]; }
    }
    return best;
  }
  function setRuler(kid, u) {
    const k = get(kid); if (!k) return false;
    const old = S.units.get(k.rulerId);
    if (old && (!u || old.id !== u.id)) old.isRuler = false;
    k.rulerId = u ? u.id : 0;
    if (u) {
      u.isRuler = true;
      if (k.reigns === 0 && typeof u.clan === 'string' && u.clan) k.clan = u.clan;       // the first ruler founds the dynasty
      k.reigns++;
      k.consortId = u.spouseId | 0;
      Hist.add(u, Names.ruler(u.race, u.sex) + ' «' + k.name + '»');
      Hist.add(k, 'Правит ' + u.name);
      Bus.emit('kingCrowned', k, u);
    }
    return true;
  }
  /** heir of a dead ruler: eldest adult child -> sibling -> widow(er) -> clan member -> best citizen of the capital -> best citizen anywhere */
  function findHeir(k, dead) {
    const cand = collectCandidates(k, dead ? dead.id : 0);
    if (!cand.length) return null;
    const cap = S.cities.get(k.capitalId);
    let best = null, kind = '';
    const eldest = (pred) => {
      let b = null;
      for (let i = 0; i < cand.length; i++) {
        const u = cand[i];
        if (!pred(u)) continue;
        if (!b || u.born < b.born || (u.born === b.born && u.id < b.id)) b = u;
      }
      return b;
    };
    if (dead && dead.id) {
      best = eldest((u) => u.fatherId === dead.id || u.motherId === dead.id);
      if (best) kind = 'child';
      if (!best && (dead.fid || dead.mid)) {
        best = eldest((u) => (dead.fid && u.fatherId === dead.fid) || (dead.mid && u.motherId === dead.mid));
        if (best) kind = 'sibling';
      }
    }
    if (!best && dead && dead.sp) {                                         // the widow / widower
      best = eldest((u) => u.id === dead.sp);
      if (best) kind = 'consort';
    }
    if (!best) {
      const clan = dead && dead.clan ? dead.clan : k.clan;
      let bs = -1e9;
      for (let i = 0; i < cand.length; i++) {
        if (cand[i].clan !== clan) continue;
        const sc = rulerScore(cand[i], k, cap ? cap.id : 0);
        if (sc > bs) { bs = sc; best = cand[i]; }
      }
      if (best) kind = 'clan';
    }
    if (!best) { best = chooseRuler(k, dead ? dead.id : 0); kind = 'citizen'; }
    return best ? { unit: best, kind } : null;
  }
  function succession(kid) {
    const k = get(kid); if (!k) return null;
    const m = mod();
    const dead = m.dead[kid] || null;
    const heir = findHeir(k, dead);
    if (!heir) {
      k.rulerId = 0;
      if (dead && !dead.told && dead.name) { dead.told = 1; Log.add('В «' + k.name + '» ' + (dead.sex === Const.SEX.F ? 'умерла ' : 'умер ') + Names.ruler(dead.race, dead.sex).toLowerCase() + ' «' + dead.name + '»: трон пуст', LOG.KINGDOM, -1, -1, k.id); }
      return null;
    }
    const u = heir.unit;
    const oldClan = k.clan;
    setRuler(kid, u);
    if (heir.kind === 'citizen' || heir.kind === 'clan') { if (heir.kind === 'citizen' && u.clan) k.clan = u.clan; k.crisis = S.tick + 360; }
    else k.crisis = 0;
    k.succAt = S.tick;
    delete m.dead[kid];
    delete m.retry[kid];
    const city = S.cities.get(u.cityId) || S.cities.get(k.capitalId);
    let msg;
    if (dead && dead.name) {
      const f = dead.sex === Const.SEX.F;
      const verb = (dead.cause === 'age' || dead.cause === 'disease' || dead.cause === 'hunger' || !dead.cause) ? (f ? 'умерла' : 'умер') : (f ? 'погибла' : 'погиб');
      const tt = Names.ruler(dead.race, dead.sex).toLowerCase();
      msg = 'В «' + k.name + '» ' + verb + ' ' + tt + ' «' + dead.name + '», на трон ' + (u.sex === Const.SEX.F ? 'взошла' : 'взошёл') + ' «' + u.name + '»';
    } else {
      msg = 'В «' + k.name + '» новый правитель: ' + Names.ruler(u.race, u.sex).toLowerCase() + ' «' + u.name + '»';
    }
    if (k.clan !== oldClan) msg += ' (новая династия «' + k.clan + '»)';
    Log.add(msg, LOG.KINGDOM, city ? city.x : -1, city ? city.y : -1, k.id);
    Hist.add(k, 'На трон ' + (u.sex === Const.SEX.F ? 'взошла ' : 'взошёл ') + u.name + (heir.kind === 'child' ? ' (наследник)' : heir.kind === 'sibling' ? ' (брат/сестра)' : heir.kind === 'consort' ? ' (супруг правителя)' : heir.kind === 'clan' ? ' (из рода)' : ' (избран'+ (u.sex === Const.SEX.F ? 'а' : '') +')'));
    return u;
  }
  Bus.on('unitDied', (u, cause) => {
    if (!u || !u.isRuler) return;
    for (const k of S.kingdoms.values()) {
      if (k.rulerId !== u.id) continue;
      mod().dead[k.id] = { id: u.id, name: u.name, sex: u.sex, race: u.race, clan: u.clan, fid: u.fatherId | 0, mid: u.motherId | 0, sp: k.consortId | 0, cause: cause || '', told: 0 };
      return;
    }
  });
  /** throne is empty: crown somebody (immediately after a ruler died, otherwise retried every ~50 ticks) */
  function fillThrone(k, tick) {
    const m = mod();
    if (!k.cities.length) return;
    const nxt = m.retry[k.id];
    if (nxt !== undefined && tick < nxt) return;             // a failed search is repeated every ~50 ticks only
    const u = succession(k.id);
    if (!u) {
      m.retry[k.id] = tick + 50;
      return;
    }
    delete m.retry[k.id];
  }

  // ---------------------------------------------------------------- strength
  function unitPower(race) {
    const r = rc(race);
    return Math.sqrt(r.hp * r.atk / 60) * (1 + (r.def - 1) * 0.1);
  }
  function ownStrength(k) {
    let s = 0;
    for (let i = 0; i < k.cities.length; i++) {
      const c = S.cities.get(k.cities[i]);
      if (!c) continue;
      let cs = c.pop * 0.62 * unitPower(c.race) * (1 + 0.05 * (c.level - 1));
      cs *= 1 + 0.12 * countB(c, Const.B.BARRACKS);
      if (c.occupierId) cs *= 0.4;
      s += cs;
    }
    return s * (0.75 + 0.25 * clamp(k.stability, 0, 100) / 100);
  }
  function strength(kid) {
    const k = get(kid); if (!k) return 0;
    let s = ownStrength(k);
    for (const v of S.kingdoms.values()) if (v.overlordId === kid && v.id !== kid) s += 0.5 * ownStrength(v);
    return Math.round(s * 10) / 10;
  }

  // ---------------------------------------------------------------- moving cities between kingdoms
  /** soldiers of the city serving an army of another kingdom are released (the army belongs to the old owner) */
  function releaseSoldiers(c, kidKeep) {
    if (typeof Units === 'undefined' || Units.__stub) return;
    for (let i = 0; i < c.members.length; i++) {
      const u = S.units.get(c.members[i]);
      if (!u || !u.armyId) continue;
      const a = S.armies.get(u.armyId);
      if (!a || a.kingdomId !== kidKeep) Units.release(u);
    }
  }
  /** pure ownership change of one city (lists, members, soldiers, sphere). Regions are the caller's business. */
  function relink(c, old, nk) {
    if (old) { const i = old.cities.indexOf(c.id); if (i >= 0) old.cities.splice(i, 1); }
    releaseSoldiers(c, nk.id);
    if (nk.cities.indexOf(c.id) < 0) nk.cities.push(c.id);
    c.kingdomId = nk.id;
    for (let i = 0; i < c.members.length; i++) { const u = S.units.get(c.members[i]); if (u) u.kingdomId = nk.id; }
    if (typeof Cities !== 'undefined' && !Cities.__stub && Cities.setKingdom) Cities.setKingdom(c.id, nk.id);
    if (!nk.capitalId || !S.cities.has(nk.capitalId)) nk.capitalId = c.id;
    if (c.culture === undefined || c.culture === null) c.culture = nk.culture;
    S.touchOwner();
  }
  function fixOldAfterLoss(old, why) {
    if (!old || !alive(old)) return;
    // capital moved away
    if (!S.cities.has(old.capitalId) || old.cities.indexOf(old.capitalId) < 0) {
      const nc = biggestCity(old.cities);
      old.capitalId = nc ? nc.id : 0;
      if (nc) routine(old, 'Столица королевства «' + old.name + '» перенесена в «' + nc.name + '»', nc.x, nc.y);
    }
    if (!old.cities.length) destroy(old.id, why || 'cities lost');
  }
  const BIG = 0.001;
  function transferCity(cityId, toKid, cause) {
    const c = S.cities.get(cityId); if (!c) return false;
    const nk = get(toKid); if (!nk) return false;
    const old = get(c.kingdomId);
    if (old && old.id === nk.id) return true;
    const rid = c.regionId;
    const withRegion = rgOn();
    // regions: the region follows when the city is the only (or the main) city of the old owner in it
    let followers = null;
    if (withRegion && old && rid) {
      const r = Regions.get(rid);
      if (r && r.ownerId === old.id && r.cityIds.length > 1) {
        let main = true;
        const others = [];
        for (let i = 0; i < r.cityIds.length; i++) {
          const o = S.cities.get(r.cityIds[i]);
          if (!o || o.id === c.id || o.kingdomId !== old.id) continue;
          others.push(o);
          if (o.pop > c.pop + BIG) main = false;
        }
        if (others.length && main) followers = others;
      }
    }
    relink(c, old, nk);
    c.loyalty = Math.min(c.loyalty, 50);
    if (followers) for (let i = 0; i < followers.length; i++) { relink(followers[i], old, nk); followers[i].loyalty = Math.min(followers[i].loyalty, 50); }
    if (withRegion) {
      if (followers) Regions.setOwner(rid, nk.id, 'transfer');
      Regions.onCityTransferred(c, old ? old.id : 0, nk.id);
      if (followers) for (let i = 0; i < followers.length; i++) Regions.onCityTransferred(followers[i], old ? old.id : 0, nk.id);
    }
    Hist.add(c, 'Перешёл к королевству «' + nk.name + '»');
    if (cause !== 'peace' && cause !== 'war' && cause !== 'merge') {
      Log.add('Город «' + c.name + '» перешёл к королевству «' + nk.name + '»' + (old ? ' от «' + old.name + '»' : ''), LOG.KINGDOM, c.x, c.y, nk.id);
    }
    fixOldAfterLoss(old, 'cities lost');
    S.touchOwner();
    Bus.emit('cityTransferred', c, old ? old.id : 0, nk.id, cause);
    return true;
  }

  /**
   * The given cities (all of one kingdom) leave it and form a new independent kingdom; their regions go with them.
   * why: 'rebel' | 'split' | 'fall'.  Returns the new kingdom or null.
   */
  function secede(cityList, why, opts) {
    opts = opts || {};
    const list = [];
    for (let i = 0; i < cityList.length; i++) if (cityList[i] && S.cities.has(cityList[i].id) && list.indexOf(cityList[i]) < 0) list.push(cityList[i]);
    if (!list.length) return null;
    const old = get(list[0].kingdomId);
    const lead = biggestCity(list) || list[0];
    const culture = lead.culture !== undefined && lead.culture !== null && S.cultures[lead.culture] ? lead.culture : undefined;
    const k = makeKingdom(lead.race, { culture, hist: why === 'rebel' ? 'Основано в результате мятежа' : why === 'split' ? 'Отделилось по воле бога' : 'Основано' });
    const regionIds = [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      relink(c, old, k);
      c.loyalty = Math.max(c.loyalty, 60);
      if (c.regionId && regionIds.indexOf(c.regionId) < 0) regionIds.push(c.regionId);
    }
    k.capitalId = lead.id;
    k.stability = 60;
    if (rgOn()) {
      for (let i = 0; i < regionIds.length; i++) {
        const r = Regions.get(regionIds[i]);
        if (r && (!old || r.ownerId === old.id || r.ownerId === 0)) Regions.setOwner(regionIds[i], k.id, 'split');
      }
      for (let i = 0; i < list.length; i++) Regions.onCityTransferred(list[i], old ? old.id : 0, k.id);
    }
    const rl = chooseRuler(k);
    if (rl) setRuler(k.id, rl);
    announce(k);
    if (old) fixOldAfterLoss(old, 'cities lost');
    return k;
  }

  // ---------------------------------------------------------------- destruction
  function destroy(kid, cause) {
    const k = get(kid); if (!k || k.alive === false) return false;
    if (dying.has(kid)) return false;
    dying.add(kid);
    try {
      // vassals are freed (or inherited by the overlord)
      for (const v of S.kingdoms.values()) if (v.overlordId === kid) { v.overlordId = k.overlordId && S.kingdoms.has(k.overlordId) && k.overlordId !== v.id ? k.overlordId : 0; v.vassalSince = v.overlordId ? S.tick : 0; }
      const ru = S.units.get(k.rulerId);                    // the old ruler is an ordinary citizen of a city-state from now on
      if (ru) ru.isRuler = false;
      k.rulerId = 0;
      // cities that are still ours become independent city-states (grouped by region)
      const rest = [];
      for (let i = 0; i < k.cities.length; i++) { const c = S.cities.get(k.cities[i]); if (c && c.kingdomId === kid) rest.push(c); }
      if (rest.length && cause !== 'merge') {
        const groups = new Map();
        for (let i = 0; i < rest.length; i++) {
          const key = rgOn() && rest[i].regionId ? rest[i].regionId : -rest[i].id;
          let g = groups.get(key); if (!g) { g = []; groups.set(key, g); }
          g.push(rest[i]);
        }
        k.cities.length = 0;
        // detach first so that the secession does not try to destroy us again
        k.alive = true;
        for (const g of groups.values()) {
          for (let i = 0; i < g.length; i++) g[i].kingdomId = 0;
          secedeFromFallen(g, k);
        }
      }
      k.alive = false;
      k.cmd = false;
      S.kingdoms.delete(kid);
      for (const u of S.units.values()) {
        if (u.kingdomId === kid) u.kingdomId = 0;
        if (u.armyId && typeof Units !== 'undefined' && !Units.__stub) { const a = S.armies.get(u.armyId); if (a && a.kingdomId === kid) Units.release(u); }
      }
      const m = mod();
      delete m.logAt[kid]; delete m.dead[kid]; delete m.retry[kid];
      if (dipOn()) Diplomacy.onKingdomDestroyed(kid);
      if (cause !== 'merge') Log.add('Королевство «' + k.name + '» пало', LOG.KINGDOM, -1, -1, kid);
      Hist.add(k, cause === 'merge' ? 'Присоединено' : 'Пало');
      S.touchOwner();
      Bus.emit('kingdomDestroyed', k);                      // War takes the fallen side out of its wars (and Regions frees the land)
      // ... and whatever war still lists the dead kingdom is ended through the War API (stub / foreign War implementations)
      if (typeof War !== 'undefined') {
        for (const w of Array.from(S.wars.values())) {
          if (w.ended || (w.attackers.indexOf(kid) < 0 && w.defenders.indexOf(kid) < 0)) continue;
          try { if (War.godPeace) War.godPeace(kid); } catch (e) { /* war module trouble must not block the fall */ }
          if (!w.ended && War.end) { try { War.end(w.id, 'destroyed'); } catch (e) { /* ignore */ } }
        }
      }
    } finally { dying.delete(kid); }
    return true;
  }
  /** cities of a fallen kingdom form a city-state of their own (no relation penalties, no logs) */
  function secedeFromFallen(group, fallen) {
    const lead = biggestCity(group) || group[0];
    const culture = lead.culture !== undefined && S.cultures[lead.culture] ? lead.culture : undefined;
    const nk = makeKingdom(lead.race, { culture, hist: 'Основано после падения королевства «' + fallen.name + '»' });
    const regionIds = [];
    for (let i = 0; i < group.length; i++) {
      const c = group[i];
      c.kingdomId = 0;
      relink(c, null, nk);
      c.loyalty = Math.max(c.loyalty, 55);
      if (c.regionId && regionIds.indexOf(c.regionId) < 0) regionIds.push(c.regionId);
    }
    nk.capitalId = lead.id;
    nk.stability = 55;
    if (rgOn()) {
      for (let i = 0; i < regionIds.length; i++) {
        const r = Regions.get(regionIds[i]);
        if (r && (r.ownerId === fallen.id || r.ownerId === 0)) Regions.setOwner(regionIds[i], nk.id, 'fall');
      }
      for (let i = 0; i < group.length; i++) Regions.onCityTransferred(group[i], fallen.id, nk.id);
    }
    const rl = chooseRuler(nk);
    if (rl) setRuler(nk.id, rl);
    announce(nk);
    routine(nk, 'Город «' + lead.name + '» провозгласил независимость: королевство «' + nk.name + '»', lead.x, lead.y);
  }

  // ---------------------------------------------------------------- merge / vassal / independence
  function canAnnex(smallKid, bigKid, how) {
    const s = get(smallKid), b = get(bigKid);
    if (!s || !b) return { ok: false, reason: 'королевство не существует' };
    if (s.id === b.id) return { ok: false, reason: 'то же королевство' };
    if (how === 'vassal' && s.overlordId) return { ok: false, reason: 'уже вассал' };
    if (b.overlordId === s.id) return { ok: false, reason: 'сюзерен не может стать вассалом вассала' };
    return { ok: true, reason: '' };
  }
  function annex(smallKid, bigKid, how) {
    how = how || 'merge';
    if (how !== 'merge' && how !== 'vassal') return false;
    if (!canAnnex(smallKid, bigKid, how).ok) return false;
    const s = get(smallKid);
    let b = get(bigKid);
    if (how === 'vassal') {
      if (b.overlordId && get(b.overlordId) && b.overlordId !== s.id) b = get(b.overlordId);   // vassals of vassals serve the top overlord
      if (b.id === s.id) return false;
      // a war between the two ends first
      for (const w of Array.from(S.wars.values())) {
        if (w.ended) continue;
        const a = w.attackers.indexOf(s.id) >= 0 ? 1 : w.defenders.indexOf(s.id) >= 0 ? 2 : 0, bb = w.attackers.indexOf(b.id) >= 0 ? 1 : w.defenders.indexOf(b.id) >= 0 ? 2 : 0;
        if (a && bb && a !== bb && typeof War !== 'undefined' && War.end) War.end(w.id, 'vassal');
      }
      s.overlordId = b.id;
      s.vassalSince = S.tick;
      for (const v of S.kingdoms.values()) if (v.overlordId === s.id) { v.overlordId = b.id; v.vassalSince = S.tick; }   // s's own vassals serve b now
      if (dipOn()) { Diplomacy.setTruce(s.id, b.id, 0); Diplomacy.setState(s.id, b.id, Const.REL.ALLIANCE); Diplomacy.addOpinion(s.id, b.id, 5, 'Вассальная клятва'); }
      Log.add('Королевство «' + s.name + '» стало вассалом королевства «' + b.name + '»', LOG.KINGDOM, -1, -1, b.id);
      Hist.add(s, 'Стало вассалом «' + b.name + '»'); Hist.add(b, 'Вассал: «' + s.name + '»');
      S.touchOwner();
      Bus.emit('vassalCreated', s, b);
      return true;
    }
    // merge: every city and region of the small kingdom goes to the big one
    const cs = [];
    for (let i = 0; i < s.cities.length; i++) { const c = S.cities.get(s.cities[i]); if (c) cs.push(c); }
    const regs = rgOn() ? Regions.ofKingdom(s.id).map((r) => r.id) : [];
    if (regs.length) for (let i = 0; i < regs.length; i++) Regions.setOwner(regs[i], b.id, 'merge');
    for (let i = 0; i < cs.length; i++) {
      relink(cs[i], s, b);
      cs[i].loyalty = Math.min(cs[i].loyalty, 60);
      if (rgOn()) Regions.onCityTransferred(cs[i], s.id, b.id);
    }
    for (const v of S.kingdoms.values()) if (v.overlordId === s.id) { v.overlordId = v.id === b.id ? 0 : b.id; v.vassalSince = v.overlordId ? S.tick : 0; }
    if (s.cmd) { s.cmd = false; b.cmd = true; }
    Log.add('Королевство «' + b.name + '» присоединило «' + s.name + '»', LOG.KINGDOM, -1, -1, b.id);
    Hist.add(b, 'Присоединило «' + s.name + '»');
    b.crisis = Math.max(b.crisis, S.tick + 240);
    destroy(s.id, 'merge');
    S.touchOwner();
    return true;
  }
  function breakFree(vassalKid) {
    const v = get(vassalKid); if (!v || !v.overlordId) return false;
    const o = get(v.overlordId);
    v.overlordId = 0; v.vassalSince = 0;
    if (o && dipOn()) {
      Diplomacy.setState(v.id, o.id, Const.REL.PEACE);
      Diplomacy.addOpinion(v.id, o.id, -30, 'Сброшено вассальство');
    }
    Log.add('Королевство «' + v.name + '» обрело независимость' + (o ? ' от «' + o.name + '»' : ''), LOG.REBEL, -1, -1, v.id);
    Hist.add(v, 'Обрело независимость'); if (o) Hist.add(o, 'Вассал «' + v.name + '» вышел из подчинения');
    S.touchOwner();
    Bus.emit('vassalFree', v, o);
    return true;
  }

  // ---------------------------------------------------------------- rebellion / split
  function rebel(cityId) {
    const c = S.cities.get(cityId); if (!c) return 0;
    const old = get(c.kingdomId);
    if (!old || old.cities.length < 2) return 0;
    const capital = S.cities.get(old.capitalId);
    if (!capital || capital.id === c.id) return 0;
    const rid = c.regionId;
    if (rgOn() && rid && capital.regionId === rid) return 0;                  // the capital's region never secedes
    // the city, the other cities of its region and restless neighbours join
    const group = [c];
    if (rid) for (const o of S.cities.values()) if (o.id !== c.id && o.kingdomId === old.id && o.regionId === rid && o.id !== capital.id) group.push(o);
    let extra = 0;
    for (const o of S.cities.values()) {
      if (extra >= 2 || group.indexOf(o) >= 0 || o.kingdomId !== old.id || o.id === capital.id || o.occupierId) continue;
      if (capital.regionId && o.regionId === capital.regionId) continue;
      if (o.loyalty < 38 && Util.dist(o.x, o.y, c.x, c.y) <= 16) { group.push(o); extra++; }
    }
    if (old.cities.length - group.length < 1) return 0;
    const oldRegion = rid;
    const nk = secede(group, 'rebel');
    if (!nk) return 0;
    old.rebels += 1; old.lastRebel = S.tick;
    old.stability = clamp(old.stability - 6, 0, 100);
    Log.add('Город «' + c.name + '» восстал против королевства «' + old.name + '»: основано королевство «' + nk.name + '»', LOG.REBEL, c.x, c.y, nk.id);
    Hist.add(old, 'Восстал город «' + c.name + '»'); Hist.add(c, 'Восстал против «' + old.name + '»');
    if (dipOn()) {
      Diplomacy.addOpinion(old.id, nk.id, -35, 'Мятеж');
      // the old crown often tries to take its rebels back
      if (!old.cmd && R.chance(0.45) && strength(old.id) >= strength(nk.id) * 0.8 && oldRegion) {
        Diplomacy.declareWar(old.id, nk.id, 'rebel', [oldRegion]);
      }
    }
    Bus.emit('cityRebelled', c, old, nk);
    return nk.id;
  }
  function splitCity(cityId) {
    const c = S.cities.get(cityId); if (!c) return 0;
    const old = get(c.kingdomId);
    if (!old) return 0;
    const rid = c.regionId;
    const group = [c];
    if (rgOn() && rid) for (const o of S.cities.values()) if (o.id !== c.id && o.kingdomId === old.id && o.regionId === rid) group.push(o);
    if (old.cities.length - group.length < 1) return 0;
    const nk = secede(group, 'split');
    if (!nk) return 0;
    Hist.add(old, 'Город «' + c.name + '» отделён'); Hist.add(c, 'Стал столицей королевства «' + nk.name + '»');
    if (dipOn()) Diplomacy.addOpinion(old.id, nk.id, -10, 'Раскол');
    return nk.id;
  }

  // ---------------------------------------------------------------- stability & loyalty
  function mixShare(k) {
    let tot = 0, bad = 0;
    for (let i = 0; i < k.cities.length; i++) {
      const c = S.cities.get(k.cities[i]);
      if (!c) continue;
      tot += c.pop;
      if (c.culture !== k.culture) bad += c.pop * (c.race !== k.race ? 1 : 0.5);
    }
    return tot > 0 ? bad / tot : 0;
  }
  function add(out, v, why) { if (out && Math.abs(v) >= 0.5) out.push({ t: v >= 0 ? 'up' : 'down', v: (Math.round(v * 10) / 10) || 0, why }); return v; }
  /** target stability (0..100). `out` (optional array) receives [{t,v,why}] for the inspector */
  function stabilityTarget(k, out) {
    let t = 62;
    const ru = S.units.get(k.rulerId);
    if (!ru) t += add(out, -12, 'Трон пуст');
    else t += add(out, Traits.sum(ru, 'loyalty') * 0.7, 'Характер правителя');
    // war weariness
    let weary = 0;
    warInvolving(k.id, (w) => {
      const yrs = (S.tick - w.started) / TPY;
      let sc = 0;
      if (typeof War !== 'undefined' && typeof War.score === 'function') { const v = War.score(w.id, k.id); if (typeof v === 'number' && v === v) sc = v; }
      weary += Math.max(0, Math.min(9, 2 + yrs * 1.6) - sc * 0.03);
    });
    if (weary > 0) t += add(out, -Math.min(24, weary), 'Усталость от войны');
    else {
      const yrs = (S.tick - k.peaceAt) / TPY;
      if (yrs > 1) t += add(out, Math.min(8, yrs * 2), 'Долгий мир');
    }
    // occupation
    if (rgOn()) {
      let occ = 0;
      for (const r of S.regions.values()) if (r.ownerId === k.id && r.controllerId !== k.id && r.controllerId !== 0) occ++;
      if (occ) t += add(out, -5 * Math.min(5, occ), 'Оккупированные земли');
      const cap = S.cities.get(k.capitalId);
      if (cap && cap.occupierId) t += add(out, -12, 'Столица захвачена');
    }
    const mix = mixShare(k);
    if (mix > 0.01) t += add(out, -22 * mix, 'Разнородное население');
    if (k.rebels > 0.05) t += add(out, -7 * Math.min(3, k.rebels), 'Недавние мятежи');
    if (k.cities.length > 6) t += add(out, -Math.min(14, 1.4 * (k.cities.length - 6)), 'Раздутое государство');
    if (S.tick < k.crisis) t += add(out, -8, 'Смена власти');
    let temples = 0;
    for (let i = 0; i < k.cities.length; i++) { const c = S.cities.get(k.cities[i]); if (c) temples += countB(c, Const.B.TEMPLE); }
    if (temples) t += add(out, Math.min(6, 2 * temples), 'Храмы');
    if (k.infamy > 5) t += add(out, -k.infamy * 0.08, 'Дурная слава');
    if (k.overlordId) t += add(out, -4, 'Вассальная зависимость');
    return clamp(t, 0, 100);
  }
  function loyaltyTarget(c, k, out) {
    let t = 62;
    t += add(out, (k.stability - 60) * 0.3, 'Стабильность королевства');
    const ru = S.units.get(k.rulerId);
    if (ru) t += add(out, Traits.sum(ru, 'loyalty') * 0.6, 'Правитель');
    if (c.culture !== k.culture) t += add(out, c.race !== k.race ? -32 : -16, c.race !== k.race ? 'Чужой народ' : 'Чужая культура');
    const cap = S.cities.get(k.capitalId);
    if (cap) {
      if (cap.id === c.id) t += add(out, 12, 'Столица');
      else {
        const d = Util.dist(c.x, c.y, cap.x, cap.y);
        if (d > 12) t += add(out, -Math.min(20, (d - 12) * 0.5), 'Далеко от столицы');
        if (cap.regionId && cap.regionId === c.regionId) t += add(out, 6, 'Рядом со столицей');
        if (d >= 20 && c.pop >= 25 && c.pop >= cap.pop * 0.6) t += add(out, -8, 'Своевольный город');
      }
    }
    if (k.cities.length > 5) t += add(out, -Math.min(24, 2.2 * (k.cities.length - 5)), 'Раздутое государство');
    const tp = countB(c, Const.B.TEMPLE), mk = countB(c, Const.B.MARKET);
    if (tp) t += add(out, 5, 'Храм');
    if (mk) t += add(out, 2, 'Рынок');
    if (rgOn() && c.regionId) {
      const r = Regions.get(c.regionId);
      if (r) {
        for (let i = 0; i < r.cores.length; i++) {
          const ck = r.cores[i];
          if (ck !== k.id && S.kingdoms.has(ck)) { t += add(out, -8, 'Земля предков другого королевства'); break; }
        }
      }
    }
    if (c.pop > 0 && c.stock.food < c.pop * 0.4) t += add(out, -8, 'Голод');
    for (let i = 0; i < c.members.length; i++) {
      const u = S.units.get(c.members[i]);
      if (u && u.buffUntil > S.tick) { t += add(out, 6, 'Благословение'); break; }
    }
    return clamp(t, 0, 100);
  }

  function cultureDominant(k) {
    const w = {};
    let tot = 0;
    for (let i = 0; i < k.cities.length; i++) {
      const c = S.cities.get(k.cities[i]);
      if (!c) continue;
      w[c.culture] = (w[c.culture] || 0) + c.pop; tot += c.pop;
    }
    let best = k.culture, bw = -1;
    for (const key in w) if (w[key] > bw) { bw = w[key]; best = +key; }
    return { culture: best, share: tot > 0 ? bw / tot : 0 };
  }

  function nearestForeign(c, maxD) {
    let best = null, bd = maxD * maxD;
    for (const o of S.cities.values()) {
      if (o.kingdomId === c.kingdomId || o.race !== c.race || o.culture === c.culture) continue;
      const d = Util.dist2(c.x, c.y, o.x, o.y);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  function cultureStep(c, k, tick) {
    if (c.culture !== k.culture && S.cultures[k.culture]) {
      // assimilation into the ruling culture: slower for foreign peoples, faster with a temple, slower in a restless kingdom
      let p = 0.05 * (c.race === k.race ? 1 : 0.3) * (1 + countB(c, Const.B.TEMPLE)) * (k.stability >= 40 ? 1 : 0.4);
      const cap = S.cities.get(k.capitalId);
      if (cap && Util.dist(c.x, c.y, cap.x, cap.y) < 14) p *= 1.5;
      if (R.chance(p)) {
        c.culture = k.culture;
        Hist.add(c, 'Принял культуру королевства');
        S.touchOwner();
      }
      return;
    }
    // diffusion over the border: a bigger neighbour of the same people with a temple pulls the city's culture
    const o = nearestForeign(c, 11);
    if (o && S.cultures[o.culture]) {
      const p = 0.006 * (1 + countB(o, Const.B.TEMPLE)) * clamp(o.pop / Math.max(1, c.pop), 0.4, 2);
      if (R.chance(p)) {
        c.culture = o.culture;
        Hist.add(c, 'Перенял культуру соседей');
        S.touchOwner();
      }
    }
  }

  function cityPass(c, k, tick) {
    const m = mod();
    // an occupied city is governed by Cities (loyalty drains while the enemy holds it, +10 on liberation): no drift, no rebellion
    if (!c.occupierId) {
      const target = loyaltyTarget(c, k, null);
      c.loyalty = clamp(c.loyalty + clamp(target - c.loyalty, -3, 2), 0, 100);
    }
    cultureStep(c, k, tick);
    // restlessness bookkeeping
    const thr = k.stability < 30 ? LOW_LOYALTY + 8 : LOW_LOYALTY;
    if (c.loyalty < thr && !c.occupierId) {
      if (m.low[c.id] === undefined) m.low[c.id] = tick;
      else if (tick - m.low[c.id] >= REBEL_AFTER && tick - k.lastRebel >= REBEL_COOLDOWN && c.pop >= 4 && k.cities.length >= 2 && c.id !== k.capitalId && !k.cmd) {
        if (R.chance(k.stability < 30 ? 0.5 : 0.3)) { delete m.low[c.id]; rebel(c.id); return; }
      }
    } else if (m.low[c.id] !== undefined) delete m.low[c.id];
  }

  function relocationPass(k, tick) {
    const cap = S.cities.get(k.capitalId);
    if (!cap) { const nc = biggestCity(k.cities); if (nc) k.capitalId = nc.id; return; }
    let target = null, why = '';
    if (cap.occupierId && k.cities.length > 1) {
      const r = rgOn() && cap.regionId ? Regions.get(cap.regionId) : null;
      if (!r || tick - r.occSince > 600) { target = biggestCity(k.cities, cap.id); why = 'Правительство бежало из захваченной столицы'; }
    } else if (k.cities.length > 1) {
      const big = biggestCity(k.cities, cap.id);
      if (big && !big.occupierId && big.pop >= cap.pop * 2.2 && big.pop >= 25 && R.chance(0.12)) { target = big; why = 'Центр жизни сместился'; }
    }
    if (target && target.id !== cap.id) {
      k.capitalId = target.id;
      k.crisis = Math.max(k.crisis, tick + 200);
      Hist.add(k, 'Столица перенесена в «' + target.name + '»');
      routine(k, 'Столица королевства «' + k.name + '» перенесена в «' + target.name + '»', target.x, target.y);
      void why;
      S.touchOwner();
    }
  }

  function kingdomPass(k, tick) {
    // ruler sanity: a ruler who left the kingdom (or died unnoticed) is replaced
    const ru = S.units.get(k.rulerId);
    if (ru && ru.kingdomId !== k.id && k.cities.length) {
      ru.isRuler = false; k.rulerId = 0;
    }
    if (atWarAny(k.id)) k.peaceAt = tick;
    const cur = S.units.get(k.rulerId);
    if (cur) k.consortId = cur.spouseId | 0;                                // remembered for the succession (Units clears spouses on death)
    // stability follows its target slowly
    const t = stabilityTarget(k, null);
    k.stability = clamp(k.stability + clamp(t - k.stability, -2.5, 1.5), 0, 100);
    if (k.infamy > 0) k.infamy = Math.max(0, k.infamy - 0.3);
    if (k.rebels > 0) k.rebels = k.rebels < 0.05 ? 0 : k.rebels * 0.985;
    // cities (staggered)
    const slot = Math.floor(tick / KPASS);
    const list = k.cities.slice();
    for (let i = 0; i < list.length; i++) {
      const c = S.cities.get(list[i]);
      if (!c || c.kingdomId !== k.id) continue;
      if ((slot + c.id) % (CPASS / KPASS) === 0) {
        cityPass(c, k, tick);
        if (!alive(k)) return;
      }
    }
    if ((slot + k.id) % (SLOW / KPASS) === 0) slowPass(k, tick);
  }
  function slowPass(k, tick) {
    const d = cultureDominant(k);
    if (d.culture !== k.culture && d.share >= 0.6 && S.cultures[d.culture]) {
      k.culture = d.culture;
      Hist.add(k, 'Сменилась господствующая культура');
      routine(k, 'В королевстве «' + k.name + '» господствующей стала новая культура', -1, -1);
      S.touchOwner();
    }
    relocationPass(k, tick);
    if (rgOn()) {                                                           // cities standing on wild ground (the land was released): the kingdom claims it again
      for (let i = 0; i < k.cities.length; i++) {
        const c = S.cities.get(k.cities[i]);
        const r = c && c.regionId ? Regions.get(c.regionId) : null;
        if (r && r.ownerId === 0) Regions.setOwner(r.id, k.id, 'city');
      }
    }
    if (k.overlordId) vassalCheck(k, tick);
  }
  function vassalCheck(v, tick) {
    const o = get(v.overlordId);
    if (!o) { v.overlordId = 0; v.vassalSince = 0; return; }
    const sv = ownStrength(v), so = strength(o.id);
    if (v.stability < 25 || o.stability < 20 || (so < sv * 0.9 && R.chance(0.3))) { breakFree(v.id); return; }
    // long-standing vassals of the same culture are folded into the realm
    if (tick - v.vassalSince > 3600 && v.culture === o.culture && v.cities.length <= 3 && R.chance(0.12)) annex(v.id, o.id, 'merge');
  }

  function handleThrones(tick) {
    for (const k of S.kingdoms.values()) {
      if (S.units.has(k.rulerId)) continue;
      fillThrone(k, tick);
    }
  }

  // ---------------------------------------------------------------- queries
  function citiesOf(kid) { const k = get(kid); if (!k) return []; const out = []; for (let i = 0; i < k.cities.length; i++) { const c = S.cities.get(k.cities[i]); if (c) out.push(c); } return out; }
  function at(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.owner || !(x >= 0 && y >= 0 && x < S.w && y < S.h)) return null;
    const rk = rgOn() ? Regions.ownerAt(x, y) : 0;                           // region owner first, city sphere as fallback
    if (rk) return get(rk);
    const c = S.cities.get(S.owner[S.idx(x, y)]);
    return c ? get(c.kingdomId) : null;
  }

  // ---------------------------------------------------------------- lifecycle
  function normalize(k) {
    if (!Array.isArray(k.cities)) k.cities = [];
    if (!Array.isArray(k.hist)) k.hist = [];
    if (typeof k.clan !== 'string') k.clan = Names.clan(k.race);
    if (typeof k.stability !== 'number' || k.stability !== k.stability) k.stability = 60;
    for (let i = 0; i < EXTRA_KEYS.length; i++) {
      const key = EXTRA_KEYS[i];
      if (k[key] === undefined) k[key] = key === 'cmd' ? false : key === 'peaceAt' ? S.tick : 0;
    }
    if (k.alive === undefined) k.alive = true;
  }
  function afterLoad() {
    mod();
    for (const k of S.kingdoms.values()) normalize(k);
    // consistency between the city lists and the cities (old saves / hand edits); nothing here touches the RNG
    for (const k of S.kingdoms.values()) {
      k.cities = k.cities.filter((id) => { const c = S.cities.get(id); return !!c && c.kingdomId === k.id; });
      if (!S.cities.has(k.capitalId) || k.cities.indexOf(k.capitalId) < 0) { const nc = biggestCity(k.cities); k.capitalId = nc ? nc.id : 0; }
    }
    for (const c of S.cities.values()) {
      if (c.culture === undefined || c.culture === null || !S.cultures[c.culture]) { const k = get(c.kingdomId); c.culture = k && S.cultures[k.culture] ? k.culture : 0; }
      if (typeof c.loyalty !== 'number' || c.loyalty !== c.loyalty) c.loyalty = 60;
      const k = get(c.kingdomId);
      if (k && k.cities.indexOf(c.id) < 0) k.cities.push(c.id);
    }
    for (const u of S.units.values()) if (u.isRuler) { let ok = false; for (const k of S.kingdoms.values()) if (k.rulerId === u.id) { ok = true; break; } if (!ok) u.isRuler = false; }
    // prune private state of things that no longer exist
    const m = mod();
    for (const key in m.low) if (!S.cities.has(+key)) delete m.low[key];
    for (const key in m.logAt) if (!S.kingdoms.has(+key)) delete m.logAt[key];
    for (const key in m.retry) if (!S.kingdoms.has(+key)) delete m.retry[key];
    for (const key in m.dead) if (!S.kingdoms.has(+key)) delete m.dead[key];
    dying.clear();
  }
  function newWorld() {
    S.mod.kingdoms = { logAt: {}, dead: {}, low: {}, retry: {} };
    dying.clear();
  }

  return {
    get, newCulture, ruler(kid) { const k = get(kid); return k ? (S.units.get(k.rulerId) || null) : null; },
    cities: citiesOf,
    pop(kid) { const k = get(kid); if (!k) return 0; let n = 0; for (let i = 0; i < k.cities.length; i++) { const c = S.cities.get(k.cities[i]); if (c) n += c.pop || 0; } return n; },
    ofUnit(u) { return u && u.kingdomId ? get(u.kingdomId) : null; },
    at, strength,
    capitalRegion(kid) { const k = get(kid), c = k ? S.cities.get(k.capitalId) : null; return c ? c.regionId | 0 : 0; },
    /** Called by Cities.found after the city object exists in S.cities. Returns the kingdom the village belongs to. */
    onCityFounded(city, parentCityId) {
      let k = null;
      const rk = rgOn() ? Regions.ownerAt(city.x, city.y) : 0;
      if (rk && S.kingdoms.has(rk)) k = S.kingdoms.get(rk);          // settlers in a foreign region become its subjects
      const parent = parentCityId ? S.cities.get(parentCityId) : null;
      if (!k && parent && S.kingdoms.has(parent.kingdomId)) k = S.kingdoms.get(parent.kingdomId);
      if (!k) {
        // wanderers join the nearest same-race kingdom on the same landmass within 28 tiles, else found a new one
        let bd = 28;
        for (const c of S.cities.values()) {
          if (c.id === city.id || !c.kingdomId) continue;
          const kk = S.kingdoms.get(c.kingdomId);
          if (!kk || kk.race !== city.race) continue;
          const d = Util.dist(c.x, c.y, city.x, city.y);
          if (d >= bd) continue;
          if (typeof World !== 'undefined' && !World.__stub && World.sameLand && !World.sameLand(c.x, c.y, city.x, city.y)) continue;
          bd = d; k = kk;
        }
      }
      let created = false;
      if (!k) { k = makeKingdom(city.race); created = true; }
      addCity(k, city);
      if (created) city.culture = k.culture;
      else if (parent && parent.culture !== undefined && S.cultures[parent.culture]) city.culture = parent.culture;
      else if (city.race === k.race) city.culture = k.culture;
      else {
        // a foreign people keeps its own culture (the culture of the nearest city of its race, else a new one)
        let cu = -1, bd2 = 900;
        for (const c of S.cities.values()) {
          if (c.id === city.id || c.race !== city.race || !S.cultures[c.culture]) continue;
          const d2 = Util.dist2(c.x, c.y, city.x, city.y);
          if (d2 < bd2) { bd2 = d2; cu = c.culture; }
        }
        city.culture = cu >= 0 ? cu : newCulture(city.race);
      }
      if (created || !S.units.has(k.rulerId)) { const r = chooseRuler(k); if (r) setRuler(k.id, r); }
      if (rgOn()) Regions.onCityFounded(city);                      // wild region -> owned by the city's kingdom
      if (created) announce(k);
      return k;
    },
    onCityLost(city, oldKid) {
      const k = get(oldKid); if (!k) return;
      const capChanged = dropCity(k, city.id);
      S.touchOwner();
      if (!k.cities.length) { destroy(k.id, 'cities lost'); return; }
      if (capChanged) { const nc = S.cities.get(k.capitalId); if (nc) routine(k, 'Столица королевства «' + k.name + '» перенесена в «' + nc.name + '»', nc.x, nc.y); }
    },
    destroy, setRuler, succession,
    /** extras */
    create(race, capitalCity) {
      const k = makeKingdom(race);
      if (capitalCity) { addCity(k, capitalCity); capitalCity.culture = k.culture; const r = chooseRuler(k); if (r) setRuler(k.id, r); }
      announce(k);
      return k;
    },
    transferCity, splitCity, rebel, annex, canAnnex, breakFree,
    setCommanded(kid, on) {
      if (on === undefined) on = true;
      if (!kid || on === false) {
        const k = get(kid);
        if (k) k.cmd = false; else if (!kid) for (const v of S.kingdoms.values()) v.cmd = false;
        return !!(k || !kid);
      }
      const k = get(kid); if (!k) return false;
      for (const v of S.kingdoms.values()) v.cmd = false;
      k.cmd = true;
      return true;
    },
    commanded() { for (const k of S.kingdoms.values()) if (k.cmd) return k; return null; },
    policy, loyaltyTarget(cityId, out) { const c = S.cities.get(cityId), k = c ? get(c.kingdomId) : null; return c && k ? loyaltyTarget(c, k, out || null) : 0; },
    stabilityTarget(kid, out) { const k = get(kid); return k ? stabilityTarget(k, out || null) : 0; },
    /** [{t,v,why}] of the current stability target, for the inspector */
    explainStability(kid) { const k = get(kid), out = []; if (k) stabilityTarget(k, out); return out; },
    explainLoyalty(cityId) { const c = S.cities.get(cityId), k = c ? get(c.kingdomId) : null, out = []; if (c && k) loyaltyTarget(c, k, out); return out; },
    mixShare(kid) { const k = get(kid); return k ? mixShare(k) : 0; },
    chooseRuler: (kid) => { const k = get(kid); return k ? chooseRuler(k) : null; },
    vassalsOf(kid) { const out = []; for (const k of S.kingdoms.values()) if (k.overlordId === kid) out.push(k.id); return out; },
    step(tick) {
      if (tick === undefined) tick = S.tick;
      if (S.kingdoms.size === 0) return;
      handleThrones(tick);
      if (tick % 10 !== 0) return;
      const slot = tick / 10;
      for (const k of Array.from(S.kingdoms.values())) {
        if (!alive(k)) continue;
        if ((slot + k.id) % (KPASS / 10) === 0) kingdomPass(k, tick);
      }
    },
    newWorld, afterLoad,
  };
})();
