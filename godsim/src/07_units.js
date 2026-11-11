/* =====================================================================
 * 07_units.js — Units: spawn/kill, spatial grid, movement + pathing, AI state machine, needs, work cycles,
 *               reproduction, ageing, disease, combat, armies.
 * OWNER: Units agent. API: docs/CONTRACT.md §3 Units, behaviour §5.
 *
 * Design
 *  - MOVEMENT + WORK COUNTERS run every tick (Units.step -> tickUnit -> act). DECISIONS (think) run every S.perf.thinkEvery
 *    ticks per unit (staggered through u.nextThink). act() drives an activity to its end (job done / failed -> idle),
 *    think() only handles interrupts (fire, enemies, hunger, tiredness), spare-time choices and watchdogs.
 *  - u.st is the activity scratch. Cities may replace it at any time (join / found / expedition), so every function
 *    tolerates a fresh `{}` (all fields are read with defaults). Movement fields inside st: tx,ty (target), rg (reach),
 *    path (flat [x0,y0,x1,y1...] tile list), pi (next waypoint), pgx,pgy (path goal tile), blk (blocked score), mv (last tick moved).
 *  - Extra unit fields (JSON-safe numbers): life (natural lifespan, years), immune (tick until which infection is impossible),
 *    cd (attack ready at tick), ec (eat retry at tick), pt (last findPath tick), tt (last Cities.trySettle tick), cell (spatial grid cell).
 *  - Spatial grid: 8x8-tile cells holding unit refs, maintained incrementally. Units.rebuildGrid() (also from afterLoad).
 *  - Private persistent state: S.mod.units = {births, deaths, causes:{}}.
 * Deviations from the task text are listed at the end of docs/REQUESTS.md (Units section).
 * ===================================================================== */

const Units = (() => {
  const TPS = Const.TICKS_PER_SEC, TPY = Const.TICKS_PER_YEAR;
  const RES = Const.RES, SEX = Const.SEX, T = Const.T;
  const NT = Const.TILE_COUNT, NR = Const.RACE_COUNT;

  // ------------------------------------------------------------------ static tables
  const WALK = new Uint8Array(NT);
  for (let t = 0; t < NT; t++) WALK[t] = Tiles.defs[t].speed > 0 ? 1 : 0;
  const COST = [];                                  // COST[race][tile] = tile speed * race terrain multiplier (same as World.moveCost)
  const SPD = new Float32Array(NR);                 // tiles per tick at multiplier 1
  const MAT = new Float64Array(NR);                 // adulthood age in ticks
  const ELD = new Float64Array(NR);                 // elder age in ticks (same definition as Cities: 80% of the lower lifespan bound)
  for (let r = 0; r < NR; r++) {
    const rc = Races.list[r];
    const tb = new Float32Array(NT);
    for (let t = 0; t < NT; t++) {
      const m = rc.terrain && rc.terrain[t] !== undefined ? rc.terrain[t] : 1;
      tb[t] = Tiles.defs[t].speed * m;
    }
    COST.push(tb);
    SPD[r] = rc.speed / TPS;
    MAT[r] = rc.maturity * TPY;
    ELD[r] = rc.lifespan[0] * 0.8 * TPY;
  }
  const MINE_RES = { stone: RES.ROCK, iron: RES.IRON, gold: RES.GOLD };
  const STAGE_NAMES = ['child', 'adult', 'elder'];

  // ------------------------------------------------------------------ tunables
  const HUNGER_RATE = 0.12, HUNGER_SLEEP = 0.04, ENERGY_DRAIN = 0.03, ENERGY_SLEEP = 0.4;
  const EAT_VALUE = 40;                             // hunger removed by 1 food
  const THREAT_R = 6;                               // enemy detection radius (tiles)
  const PATH_BUDGET = 6;                            // findPath calls per tick (global)
  const PATH_NODES = 1200;
  const PATH_COOLDOWN = 20;                         // per unit
  const SETTLE_BUDGET = 6;                          // Cities.trySettle calls per tick (global)
  const BUILD_RATE = 5;                             // Buildings.work amount per 5 ticks = eff * BUILD_RATE (1 work/tick/builder)
  const BIRTH_ATTEMPT = 0.8;                        // chance per attempt (attempt every ~20 ticks), scaled by fertility
  // race balance (density-dependent births): once the world fills up, a race above its fair share of the population breeds slower and a
  // race below it breeds faster, so ~1500 units stay a mix instead of one race taking every free slot (see updateBalance)
  const BAL_FROM = 140, BAL_RAMP = 330, BAL_UNDER_MAX = 3.2, BAL_UNDER_EXP = 0.6, BAL_OVER_EXP = 2.2;
  const MAX_LEVEL = 30;
  // watchdog: max ticks an activity may last (0 = unlimited)
  const LIMIT = { idle: 0, wander: 600, walk: 900, gather: 900, carry: 700, build: 900, farm: 700, eat: 500, sleep: 700, flee: 300, fight: 500, army: 0, mate: 200, settle: 1700 };

  // ------------------------------------------------------------------ private runtime state (non-persistent)
  let gMap = null, GW = 0, GH = 0, cells = [];
  let pathBudget = 0, settleBudget = 0, fxBudget = 0;
  let lastSlid = false;
  let errCount = 0, lastError = null, errLogged = 0;
  let spX = 0, spY = 0;                             // scratch result of aroundSpot
  // threat scan scratch
  let sFoe = null, sFoeD2 = 0, sEnemyPow = 0, sFriendPow = 0, sOnlyMine = false, sForceWar = false;
  let sArmedPref = false, sArmFoe = null, sArmD2 = 0;   // army scans: nearest hostile that is a combatant (soldier or already fighting)
  // threat gating: census of the previous tick + kingdoms that are at war (so peaceful units never scan)
  const HR = new Uint8Array(NR * NR);                // HR[a*NR+b] = 1 when a wanderer rule (rel <= -50) can make a/b hostile
  for (let a = 0; a < NR; a++) for (let b = 0; b < NR; b++) HR[a * NR + b] = (Races.rel[a][b] <= -50 || Races.rel[b][a] <= -50) ? 1 : 0;
  let cntAll = new Int32Array(NR), cntWand = new Int32Array(NR), nxtAll = new Int32Array(NR), nxtWand = new Int32Array(NR);
  const warSet = new Set();
  let warAll = false;
  const pairM = [], pairF = [];
  const PARTIAL = { partial: true };

  // ------------------------------------------------------------------ small helpers
  function RC(u) { return Races.list[u.race] || Races.list[0]; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function hash(a, b, c) { return Util.hash2(a, b, c); }
  function resolve(u) { return typeof u === 'number' ? (S.units.get(u) || null) : (u || null); }
  function stageIdx(u) { const a = S.tick - u.born; return a < MAT[u.race] ? 0 : a > ELD[u.race] ? 2 : 1; }
  function isChild(u) { return S.tick - u.born < MAT[u.race]; }
  function modState() { return S.mod.units || (S.mod.units = { births: 0, deaths: 0, causes: {} }); }
  const balPop = new Int32Array(NR);
  /** birth-rate multiplier of a race (1 = neutral). Persisted in S.mod.units.bal, refreshed every 20 ticks by updateBalance. */
  function balOf(race) { const b = modState().bal; return b && b[race] > 0 ? b[race] : 1; }
  function updateBalance() {
    const pop = balPop;
    pop.fill(0);
    for (const u of S.units.values()) if (u.race >= 0 && u.race < NR) pop[u.race]++;
    let total = 0, present = 0;
    for (let r = 0; r < NR; r++) { total += pop[r]; if (pop[r] > 0) present++; }
    const m = modState();
    if (!Array.isArray(m.bal) || m.bal.length !== NR) m.bal = new Array(NR).fill(1);
    const crowd = clamp((total - BAL_FROM) / BAL_RAMP, 0, 1);
    for (let r = 0; r < NR; r++) {
      let v = 1;
      if (present > 1 && pop[r] > 0 && crowd > 0) {
        const ratio = total / (present * pop[r]);                  // fair share / actual share
        v = ratio >= 1 ? Math.min(BAL_UNDER_MAX, Math.pow(ratio, BAL_UNDER_EXP)) : Math.pow(ratio, BAL_OVER_EXP);
        v = 1 + (v - 1) * crowd;
      }
      m.bal[r] = Math.round(v * 1000) / 1000;
    }
  }
  function buffOf(u) { return u.buffUntil > S.tick ? (u.buffMul || 1) : 1; }
  function walkAt(x, y) {
    if (!(x >= 0 && y >= 0 && x < S.w && y < S.h)) return false;
    return WALK[S.tile[(y | 0) * S.w + (x | 0)]] === 1;
  }
  function waterAt(x, y) {
    const t = S.tile[(y | 0) * S.w + (x | 0)];
    return t === T.DEEP || t === T.SHALLOW;
  }
  function lifeFor(race) { const l = Races.list[race].lifespan; return R.between(l[0], l[1]); }

  /** Make sure foreign-made units (tests, other modules) carry every field Units relies on. */
  function normalize(u) {
    if (u.life === undefined) u.life = lifeFor(u.race);
    if (u.immune === undefined) u.immune = 0;
    if (u.cd === undefined) u.cd = 0;
    if (u.ec === undefined) u.ec = 0;
    if (u.pt === undefined) u.pt = 0;
    if (u.tt === undefined) u.tt = 0;
    if (!u.st) u.st = {};
    if (!u.traits) u.traits = [];
    if (u.hist === undefined) u.hist = [];
    if (u.sick === undefined) u.sick = 0;
    if (u.burning === undefined) u.burning = 0;
    if (u.buffUntil === undefined) { u.buffUntil = 0; u.buffMul = 1; }
    if (u.carryAmt === undefined) { u.carry = null; u.carryAmt = 0; }
    if (u.level === undefined) { u.level = 1; u.xp = 0; u.kills = 0; }
    if (!(u.nextThink >= 0)) u.nextThink = 0;
    if (u.px === undefined) { u.px = u.x; u.py = u.y; }
    if (!u.face) u.face = 1;
    if (!u.state) u.state = 'idle';
    if (u.armyId === undefined) u.armyId = 0;
    if (u.spouseId === undefined) u.spouseId = 0;
    if (u.birthCd === undefined) u.birthCd = 0;
  }

  // ------------------------------------------------------------------ spatial grid (8x8 tile cells)
  function cellOf(x, y) {
    let cx = (x * 0.125) | 0, cy = (y * 0.125) | 0;
    if (cx < 0) cx = 0; else if (cx >= GW) cx = GW - 1;
    if (cy < 0) cy = 0; else if (cy >= GH) cy = GH - 1;
    return cy * GW + cx;
  }
  function rebuildGrid() {
    gMap = S.units;
    GW = Math.max(1, (S.w + 7) >> 3); GH = Math.max(1, (S.h + 7) >> 3);
    cells = new Array(GW * GH);
    for (let i = 0; i < cells.length; i++) cells[i] = [];
    for (const u of S.units.values()) {
      normalize(u);
      if (!(u.x >= 0 && u.y >= 0)) { u.x = 0.5; u.y = 0.5; u.px = u.x; u.py = u.y; }
      const ci = cellOf(u.x, u.y);
      u.cell = ci;
      cells[ci].push(u);
    }
  }
  function ensureGrid() {
    if (gMap !== S.units || GW !== Math.max(1, (S.w + 7) >> 3) || GH !== Math.max(1, (S.h + 7) >> 3)) rebuildGrid();
  }
  function gridRemove(u) {
    const arr = cells[u.cell];
    if (!arr) return;
    const i = arr.indexOf(u);
    if (i >= 0) { const last = arr.pop(); if (i < arr.length) arr[i] = last; }
  }
  function gridInsert(u) {
    const ci = cellOf(u.x, u.y);
    u.cell = ci;
    cells[ci].push(u);
  }
  function gridSweep() {
    // drop refs of units that were deleted from S.units behind our back
    for (let c = 0; c < cells.length; c++) {
      const arr = cells[c];
      for (let i = arr.length - 1; i >= 0; i--) {
        const u = arr[i];
        if (S.units.get(u.id) !== u) { const last = arr.pop(); if (i < arr.length) arr[i] = last; }
      }
    }
  }

  /** calls fn(u) for every unit within r tiles (no allocation); fn returning true stops. Do not kill units inside fn. */
  function nearby(x, y, r, fn) {
    ensureGrid();
    const r2 = r * r;
    let cx0 = ((x - r) * 0.125) | 0, cx1 = ((x + r) * 0.125) | 0, cy0 = ((y - r) * 0.125) | 0, cy1 = ((y + r) * 0.125) | 0;
    if (x - r < 0) cx0 = 0; if (y - r < 0) cy0 = 0;
    if (cx1 >= GW) cx1 = GW - 1; if (cy1 >= GH) cy1 = GH - 1;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const arr = cells[cy * GW + cx];
        for (let i = 0; i < arr.length; i++) {
          const u = arr[i];
          const dx = u.x - x, dy = u.y - y;
          if (dx * dx + dy * dy <= r2 && fn(u) === true) return;
        }
      }
    }
  }
  function inRadius(x, y, r) {
    const out = [];
    nearby(x, y, r, (u) => { out.push(u); });
    return out;
  }
  function nearest(x, y, r, pred) {
    let best = null, bd = r * r;
    nearby(x, y, r, (u) => {
      const dx = u.x - x, dy = u.y - y, d = dx * dx + dy * dy;
      if (d <= bd && (!pred || pred(u))) { bd = d; best = u; }
    });
    return best;
  }

  // ------------------------------------------------------------------ stats / combat math
  function atkOf(u) {
    const r = RC(u);
    let a = (r.atk + Gear.weaponAtk[(u.weapon | 0) & 3]) * Traits.mul(u, 'atk') * (1 + 0.08 * ((u.level || 1) - 1)) * buffOf(u);
    if (isChild(u)) a *= 0.4;
    return a;
  }
  function defOf(u) { return RC(u).def + Gear.armorDef[(u.armor | 0) & 3]; }
  function isRanged(u) { return Gear.isRanged(u.race, (u.weapon | 0) & 3); }
  function rangeOf(u) { return isRanged(u) ? Gear.range(u.race, (u.weapon | 0) & 3) : RC(u).range; }
  function maxHpOf(u) {
    let m = RC(u).hp * Traits.mul(u, 'hp') * (1 + 0.1 * ((u.level || 1) - 1));
    const a = S.tick - u.born, mt = MAT[u.race];
    if (a < mt) m *= 0.45 + 0.55 * (a > 0 ? a / mt : 0);
    return Math.max(4, Math.round(m));
  }
  function stats(u) {
    u = resolve(u);
    if (!u) return null;
    return {
      atk: atkOf(u), def: defOf(u), range: rangeOf(u),
      speed: RC(u).speed * Traits.mul(u, 'speed') * buffOf(u), maxHp: maxHpOf(u),
    };
  }
  /** cheap combat strength estimate (no trait loops) */
  function powerOf(v) {
    const r = Races.list[v.race] || Races.list[0];
    return (r.atk + Gear.weaponAtk[(v.weapon | 0) & 3]) * (v.hp + 4 * (r.def + Gear.armorDef[(v.armor | 0) & 3]));
  }
  function stage(u) { u = resolve(u); return u ? STAGE_NAMES[stageIdx(u)] : 'adult'; }

  /** Hostility rules (CONTRACT §5). Deterministic per (a,b) pair; children never fight or get attacked. */
  function isHostile(a, b) {
    if (!a || !b || a === b || !(a.hp > 0) || !(b.hp > 0)) return false;
    const ka = a.kingdomId | 0, kb = b.kingdomId | 0;
    if (ka !== 0 && ka === kb) return false;
    const now = S.tick;
    if (now - a.born < MAT[a.race] || now - b.born < MAT[b.race]) return false;
    if (ka !== 0 && kb !== 0) return Diplomacy.atWar(ka, kb) === true;
    if (Races.rel[a.race][b.race] > -50) return false;
    let ag = Races.list[a.race].aggression + Traits.sum(a, 'war');
    ag = ag < 0 ? 0 : ag > 1 ? 1 : ag;
    return hash(a.id, b.id, 91) * 2.3283064365386963e-10 < ag;
  }

  // ------------------------------------------------------------------ spawn / kill / damage
  function mixTraits(f, m) {
    const out = [];
    const bad = [[0, 1], [4, 5], [7, 8]];
    const ok = (id) => {
      if (out.indexOf(id) >= 0) return false;
      for (let i = 0; i < bad.length; i++) if ((bad[i][0] === id && out.indexOf(bad[i][1]) >= 0) || (bad[i][1] === id && out.indexOf(bad[i][0]) >= 0)) return false;
      return true;
    };
    const parents = [f, m];
    for (let i = 0; i < 2; i++) {
      const p = parents[i];
      if (p && p.traits && p.traits.length && R.chance(0.5)) {
        const id = R.pick(p.traits);
        if (ok(id)) out.push(id);
      }
    }
    for (let guard = 0; guard < 20 && out.length < 3; guard++) {
      const id = R.i(Traits.list.length);
      if (ok(id)) { out.push(id); if (out.length >= 2 && guard >= 0) break; }
    }
    while (out.length < 2) { const id = R.i(Traits.list.length); if (ok(id)) out.push(id); }
    return out;
  }

  /** random sex, nudged toward balance inside a group of the same race (so painted groups can start families) */
  function pickSex(race, x, y) {
    let m = 0, f = 0;
    nearby(x, y, 8, (v) => { if (v.race === race) { if (v.sex === SEX.F) f++; else m++; } });
    if (m === f) return R.chance(0.5) ? SEX.F : SEX.M;
    return m > f ? SEX.F : SEX.M;
  }

  function spawn(race, x, y, opts) {
    opts = opts || {};
    if (!S.tile || !Races.list[race]) return null;
    if (S.units.size >= (S.perf.unitCap || Const.MAX_UNITS)) return null;
    if (!walkAt(x, y)) return null;
    ensureGrid();
    const rc = Races.list[race];
    const sex = opts.sex !== undefined ? opts.sex : pickSex(race, x, y);
    const ageY = opts.age !== undefined ? opts.age : rc.maturity + R.between(0, 14);
    const id = S.id();
    const u = {
      id, race, sex,
      name: opts.name || Names.person(race, sex),
      clan: opts.clan !== undefined ? opts.clan : Names.clan(race),
      born: S.tick - Math.round(ageY * TPY),
      x, y, px: x, py: y, face: R.chance(0.5) ? 1 : -1,
      hp: 1, maxHp: 1, hunger: opts.hunger !== undefined ? opts.hunger : (ageY < rc.maturity ? 0 : R.i(25)),
      energy: opts.energy !== undefined ? opts.energy : (ageY < rc.maturity ? 100 : R.int(65, 100)),
      level: opts.level || 1, xp: 0, kills: 0,
      traits: opts.traits ? opts.traits.slice() : Traits.roll(),
      cityId: 0, kingdomId: 0, weapon: opts.weapon | 0, armor: opts.armor | 0,
      state: 'idle', st: {}, job: null, carry: null, carryAmt: 0,
      fatherId: opts.fatherId | 0, motherId: opts.motherId | 0, spouseId: 0, armyId: 0, isRuler: false,
      sick: 0, buffUntil: 0, buffMul: 1, burning: 0,
      nextThink: S.tick + 1 + (id % 6), birthCd: 0, hist: [],
      life: lifeFor(race), immune: 0, cd: 0, ec: 0, pt: 0, tt: S.tick - 30, cell: 0,
    };
    u.maxHp = maxHpOf(u);
    u.hp = u.maxHp;
    S.units.set(id, u);
    gridInsert(u);
    if (opts.cityId) Cities.addMember(opts.cityId, u);
    Bus.emit('unitBorn', u);
    return u;
  }

  function addXp(u, amt) {
    u.xp += amt * Traits.mul(u, 'xp');
    let guard = 0;
    while (u.xp >= 20 * u.level && u.level < MAX_LEVEL && guard++ < 5) {
      u.xp -= 20 * u.level;
      u.level++;
      const m = maxHpOf(u);
      u.hp = Math.min(m, u.hp + (m - u.maxHp) + 2);
      u.maxHp = m;
      if (u.level >= 3 && u.level % 2 === 1) Hist.add(u, 'Достиг уровня ' + u.level);
    }
  }

  const DEATH_TXT = {
    age: ['скончался от старости', 'скончалась от старости'],
    combat: ['пал в бою', 'пала в бою'],
    hunger: ['умер от голода', 'умерла от голода'],
    disease: ['умер от болезни', 'умерла от болезни'],
    fire: ['сгорел заживо', 'сгорела заживо'],
    lava: ['погиб в лаве', 'погибла в лаве'],
    drown: ['утонул', 'утонула'],
    lightning: ['убит молнией', 'убита молнией'],
    meteor: ['погиб под метеоритом', 'погибла под метеоритом'],
  };

  function kill(u, cause, killer) {
    u = resolve(u);
    if (!u || S.units.get(u.id) !== u) return false;
    cause = cause || 'unknown';
    u.hp = 0;
    gridRemove(u);
    const cityId = u.cityId, kid = u.kingdomId;
    if (u.spouseId) {
      const sp = S.units.get(u.spouseId);
      if (sp && sp.spouseId === u.id) sp.spouseId = 0;
      u.spouseId = 0;
    }
    if (u.armyId) {
      const a = S.armies.get(u.armyId);
      if (a && a.members) { const i = a.members.indexOf(u.id); if (i >= 0) a.members.splice(i, 1); }
    }
    S.units.delete(u.id);
    Cities.removeMember(u);
    u.cityId = cityId; u.kingdomId = kid;               // dead copy keeps its ids for event listeners
    const ms = modState();
    ms.deaths++;
    ms.causes[cause] = (ms.causes[cause] || 0) + 1;
    killer = resolve(killer);
    if (killer && killer !== u && S.units.get(killer.id) === killer) {
      killer.kills++;
      addXp(killer, 6 + 3 * (u.level || 1));
    }
    if (cause === 'combat' && fxBudget > 0) { fxBudget--; Fx.add('blood', u.x, u.y, { ttl: 0.5 }); }
    // (a ruler of a living kingdom is reported once, by the succession line of Kingdoms: "В «X» умер король «Y», на трон взошёл «Z»")
    if (u.isRuler && cause !== 'erase' && !(typeof Kingdoms !== 'undefined' && !Kingdoms.__stub && S.kingdoms.get(kid))) {
      const k = S.kingdoms.get(kid);
      const t = DEATH_TXT[cause];
      const f = u.sex === SEX.F ? 1 : 0;
      const how = t ? t[f] : (f ? 'погибла' : 'погиб');
      Log.add(Names.ruler(u.race, u.sex) + ' ' + u.name + (k ? ' («' + k.name + '»)' : '') + ' ' + how, Const.LOG.DEATH, u.x | 0, u.y | 0, kid);
    }
    Bus.emit('unitDied', u, cause, killer);
    return true;
  }

  function damage(u, dmg, cause, attacker) {
    u = resolve(u);
    if (!u || !(dmg > 0) || !(u.hp > 0)) return false;
    if (S.units.get(u.id) !== u) return false;
    u.hp -= dmg;
    if (cause === 'fire') u.burning = S.tick + 25;
    if (u.hp <= 0) { kill(u, cause || 'damage', attacker); return true; }
    if (u.nextThink > S.tick + 1) u.nextThink = S.tick + 1;     // react soon
    return false;
  }
  function damageAt(x, y, dmg, cause) {
    if (!S.tile) return 0;
    ensureGrid();
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= S.w || yi >= S.h) return 0;
    const arr = cells[cellOf(xi, yi)];
    let n = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      const u = arr[i];
      if (u && (u.x | 0) === xi && (u.y | 0) === yi) { damage(u, dmg, cause); n++; }
    }
    return n;
  }
  function heal(u, amount) {
    u = resolve(u);
    if (!u) return false;
    if (amount > 0) u.hp = Math.min(u.maxHp, u.hp + amount);
    if (u.sick) { u.sick = 0; u.immune = Math.max(u.immune | 0, S.tick + 300); }
    u.burning = 0;
    return true;
  }
  function infect(u, untilTick) {
    u = resolve(u);
    if (!u || !(u.hp > 0)) return false;
    if ((u.immune | 0) > S.tick) return false;
    if (!(untilTick > S.tick)) untilTick = S.tick + 300;
    if (u.sick < untilTick) u.sick = untilTick;
    return true;
  }
  function eraseInRadius(x, y, r) {
    const list = inRadius(x, y, r);
    let n = 0;
    for (let i = 0; i < list.length; i++) if (kill(list[i], 'erase')) n++;
    return n;
  }
  function setCity(u, cityId) {
    u = resolve(u);
    if (!u) return false;
    if (!cityId) { Cities.removeMember(u); return true; }
    if (!S.cities.has(cityId)) return false;
    return Cities.addMember(cityId, u);
  }

  // ------------------------------------------------------------------ armies
  function conscript(u, armyId) {
    u = resolve(u);
    if (!u || S.units.get(u.id) !== u || !armyId) return false;
    if (stageIdx(u) === 0) return false;
    if (u.armyId && u.armyId !== armyId) release(u);
    const a = S.armies.get(armyId);
    u.armyId = armyId;
    u.state = 'army'; u.job = null;
    u.st = { ph: '', since: S.tick };
    if (a && a.members && a.members.indexOf(u.id) < 0) a.members.push(u.id);
    if (u.cityId) Cities.outfit(u.cityId, u);
    u.nextThink = S.tick;
    return true;
  }
  function release(u) {
    u = resolve(u);
    if (!u) return false;
    const had = u.armyId;
    if (had) {
      const a = S.armies.get(had);
      if (a && a.members) { const i = a.members.indexOf(u.id); if (i >= 0) a.members.splice(i, 1); }
    }
    u.armyId = 0;
    if (u.state === 'army') toIdle(u, 0);
    return !!had;
  }

  // ------------------------------------------------------------------ activity helpers
  function mkSt(ph) { return { ph, since: S.tick, tx: 0, ty: 0, rg: 0.3 }; }
  function toIdle(u, rest) {
    u.state = 'idle';
    u.st = { ph: '', since: S.tick, until: rest > 0 ? S.tick + rest : 0 };
  }
  function endJob(u) { u.job = null; toIdle(u, 0); u.nextThink = S.tick + 1; }
  function failJob(u) { u.job = null; toIdle(u, 30 + (hash(u.id, S.tick, 3) % 40)); }
  /** position on a ring around (cx,cy) that is stable per unit (units spread out instead of stacking) */
  function aroundSpot(u, cx, cy, rad) {
    const a = (u.id * 2.399963229728653) % 6.283185307179586;
    const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
    if (walkAt(x, y) && !waterAt(x, y)) { spX = x; spY = y; } else { spX = cx; spY = cy; }
  }
  function homePoint(u) {
    const c = S.cities.get(u.cityId);
    if (!c) return null;
    return Cities.homeSpot(c.id, u.x, u.y) || { x: c.x, y: c.y };
  }
  /** random walkable, non-water spot within rad of (cx,cy) on the unit's landmass; sets spX/spY, returns false if none */
  function pickSpot(u, cx, cy, rad) {
    for (let k = 0; k < 6; k++) {
      const a = R.f() * 6.283185307179586, d = 1 + R.f() * rad;
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
      if (!walkAt(x, y) || waterAt(x, y)) continue;
      if (!World.sameLand(u.x, u.y, x, y)) continue;
      spX = x; spY = y;
      return true;
    }
    return false;
  }
  function startWalk(u, tx, ty, rg, state, then, rest, timeout) {
    u.state = state;
    const st = mkSt('go');
    st.tx = tx; st.ty = ty; st.rg = rg; st.then = then || '';
    st.rest = rest | 0;
    st.until = S.tick + (timeout || 500);
    u.st = st;
  }
  function startWander(u, cx, cy, rad) {
    if (!pickSpot(u, cx, cy, rad)) { toIdle(u, 20 + R.i(30)); return; }
    startWalk(u, spX, spY, 0.3, 'wander', '', 15 + R.i(50), 400);
  }

  // ------------------------------------------------------------------ movement
  const MV_MOVING = 0, MV_ARRIVED = 1, MV_BLOCKED = 2, MV_NOPATH = 3;
  const C45 = 0.7071067811865476;

  function speedOf(u, sm) {
    const c = COST[u.race][S.tile[(u.y | 0) * S.w + (u.x | 0)]];
    let s = SPD[u.race] * (c > 0 ? c : 0.5) * Traits.mul(u, 'speed') * sm;
    if (u.buffUntil > S.tick) s *= (u.buffMul || 1);
    const a = S.tick - u.born;
    if (a < MAT[u.race]) s *= 0.8; else if (a > ELD[u.race]) s *= 0.85;
    return s;
  }

  /** one step toward (tx,ty); no allocation. Sets lastSlid when the straight step was blocked. */
  function moveStep(u, tx, ty, sm) {
    lastSlid = false;
    const dx = tx - u.x, dy = ty - u.y;
    const step = speedOf(u, sm);
    const d2 = dx * dx + dy * dy;
    if (d2 <= step * step) {
      if (!walkAt(tx, ty)) return MV_BLOCKED;
      u.x = tx; u.y = ty;
      if (dx > 0.01) u.face = 1; else if (dx < -0.01) u.face = -1;
      return MV_ARRIVED;
    }
    const d = Math.sqrt(d2), ux = dx / d, uy = dy / d;
    let nx = u.x + ux * step, ny = u.y + uy * step;
    if (!walkAt(nx, ny)) {
      lastSlid = true;
      const ax = ux * step, ay = uy * step;
      let ok = false;
      if (Math.abs(ax) >= Math.abs(ay)) {
        if (ax !== 0 && walkAt(u.x + ax, u.y)) { nx = u.x + ax; ny = u.y; ok = true; }
        else if (ay !== 0 && walkAt(u.x, u.y + ay)) { nx = u.x; ny = u.y + ay; ok = true; }
      } else {
        if (ay !== 0 && walkAt(u.x, u.y + ay)) { nx = u.x; ny = u.y + ay; ok = true; }
        else if (ax !== 0 && walkAt(u.x + ax, u.y)) { nx = u.x + ax; ny = u.y; ok = true; }
      }
      if (!ok) {
        const px = (ux - uy) * C45 * step, py = (ux + uy) * C45 * step;           // +45 deg
        if (walkAt(u.x + px, u.y + py)) { nx = u.x + px; ny = u.y + py; ok = true; }
        else {
          const qx = (ux + uy) * C45 * step, qy = (uy - ux) * C45 * step;         // -45 deg
          if (walkAt(u.x + qx, u.y + qy)) { nx = u.x + qx; ny = u.y + qy; ok = true; }
          else if (walkAt(u.x - uy * step, u.y + ux * step)) { nx = u.x - uy * step; ny = u.y + ux * step; ok = true; }   // +90
          else if (walkAt(u.x + uy * step, u.y - ux * step)) { nx = u.x + uy * step; ny = u.y - ux * step; ok = true; }   // -90
        }
      }
      if (!ok) return MV_BLOCKED;
    }
    if (nx > u.x + 0.002) u.face = 1; else if (nx < u.x - 0.002) u.face = -1;
    u.x = nx; u.y = ny;
    return MV_MOVING;
  }

  function lineClear(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const n = Math.ceil(Math.sqrt(dx * dx + dy * dy) / 0.25);
    for (let s = 1; s < n; s++) {
      const f = s / n;
      if (!walkAt(x0 + dx * f, y0 + dy * f)) return false;
    }
    return true;
  }

  /** 1 = path stored in st.path, 0 = throttled (try greedy), -1 = unreachable */
  function requestPath(u, st, tx, ty) {
    if (pathBudget <= 0 || S.tick - u.pt < PATH_COOLDOWN) return 0;
    pathBudget--;
    u.pt = S.tick;
    const p = World.findPath(u.x, u.y, tx, ty, u.race, PATH_NODES, PARTIAL);
    if (!p) return -1;
    const n = p.length;
    if (n === 0) { st.path = null; return 1; }
    const flat = new Array(n * 2);
    for (let i = 0; i < n; i++) { flat[2 * i] = p[i][0]; flat[2 * i + 1] = p[i][1]; }
    st.path = flat; st.pi = 0; st.pgx = tx | 0; st.pgy = ty | 0; st.blk = 0;
    return 1;
  }

  function follow(u, st, p, sm) {
    let i = st.pi | 0;
    const n = p.length >> 1;
    if (i >= n) { st.path = null; return MV_MOVING; }
    const m = moveStep(u, p[i * 2] + 0.5, p[i * 2 + 1] + 0.5, sm);
    if (m === MV_ARRIVED) {
      i++;
      if (i < n) {                                    // string pulling: skip waypoints that are in direct sight
        for (let k = (i + 2 < n ? i + 2 : n - 1); k > i; k--) {
          if (lineClear(u.x, u.y, p[k * 2] + 0.5, p[k * 2 + 1] + 0.5)) { i = k; break; }
        }
      }
      st.pi = i;
      if (i >= n) st.path = null;
    } else if (m === MV_BLOCKED || lastSlid) {
      st.path = null; st.blk = (st.blk | 0) + 3;      // terrain changed under the route: recompute
    }
    return MV_MOVING;
  }

  /** Walk toward (tx,ty) until within `reach` tiles. Long trips and blocked units use World.findPath. */
  function goTo(u, tx, ty, reach, sm) {
    const dx = tx - u.x, dy = ty - u.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= reach * reach) return MV_ARRIVED;
    const st = u.st;
    st.mv = S.tick;
    let p = st.path;
    if (p) {
      if (st.pgx !== (tx | 0) || st.pgy !== (ty | 0)) { st.path = null; p = null; }
      else return follow(u, st, p, sm);
    }
    let blk = st.blk | 0;
    if (d2 > 100 || blk >= 6) {
      const r = requestPath(u, st, tx, ty);
      if (r === -1) return MV_NOPATH;
      if (r === 1 && st.path) return follow(u, st, st.path, sm);
    }
    const m = moveStep(u, tx, ty, sm);
    if (lastSlid || m === MV_BLOCKED) blk += m === MV_BLOCKED ? 3 : 2; else if (blk > 0) blk--;
    st.blk = blk > 40 ? 40 : blk;
    return MV_MOVING;
  }

  // ------------------------------------------------------------------ per-tick activities (act)
  function eff(u) {
    let e = RC(u).work * Traits.mul(u, 'work');
    if (u.energy < 40) e *= 0.6 + u.energy / 100;
    if (u.hunger > 80) e *= 0.75;
    if (S.tick - u.born > ELD[u.race]) e *= 0.75;
    return e > 0.15 ? e : 0.15;
  }

  function act(u, tick) {
    switch (u.state) {
      case 'idle': case 'sleep': return;
      case 'wander': case 'walk': return actWalk(u, tick);
      case 'gather': return actGather(u, tick);
      case 'carry': return actCarry(u, tick);
      case 'build': return actBuild(u, tick);
      case 'farm': return actFarm(u, tick);
      case 'eat': return actEat(u, tick);
      case 'flee': return actFlee(u, tick);
      case 'fight': return actFight(u, tick);
      case 'army': return actArmy(u, tick);
      case 'mate': return actMate(u, tick);
      case 'settle': return actSettle(u, tick);
    }
  }

  function arrive(u, tick) {
    const st = u.st;
    switch (st.then) {
      case 'sleep': lieDown(u); return;
      case 'guard': case 'idle': {
        const rest = st.rest > 0 ? st.rest : 40;
        toIdle(u, rest);                              // the job stays: think ends it after the rest
        return;
      }
      default: toIdle(u, st.rest | 0);
    }
  }

  function actWalk(u, tick) {
    const st = u.st;
    const r = goTo(u, st.tx, st.ty, st.rg, 1);
    if (r === MV_ARRIVED) arrive(u, tick);
    else if (r === MV_NOPATH) { if (u.job) failJob(u); else toIdle(u, 20 + (hash(u.id, tick, 4) % 30)); }
    else if (st.until > 0 && tick >= st.until) { if (u.job) failJob(u); else toIdle(u, 10); }
  }

  const GATHER_BASE = { chop: 25, mine: 40, forage: 20, fish: 30 };

  function actGather(u, tick) {
    const job = u.job, st = u.st;
    if (!job) { toIdle(u, 0); return; }
    if (st.ph === 'go') {
      const r = goTo(u, st.tx, st.ty, st.rg, 1);
      if (r === MV_ARRIVED) { st.ph = 'work'; st.t = 0; st.dur = Math.max(6, Math.round(GATHER_BASE[job.type] / eff(u))); }
      else if (r === MV_NOPATH) failJob(u);
      return;
    }
    st.t++;
    if (st.t < st.dur) return;
    st.t = 0;
    const type = job.type;
    let kind, good;
    if (type === 'chop') { kind = RES.TREE; good = 'wood'; }
    else if (type === 'mine') { kind = MINE_RES[job.kind] || RES.ROCK; good = job.kind || 'stone'; }
    else if (type === 'forage') { kind = RES.BERRY; good = 'food'; }
    else { kind = RES.FISH; good = 'food'; }
    const got = World.harvest(job.x, job.y, kind, 1);
    if (got > 0) {
      if (u.carry && u.carry !== good) { Cities.deposit(u.cityId, u.carry, u.carryAmt); u.carryAmt = 0; }
      u.carry = good; u.carryAmt += got;
      addXp(u, 0.25);
      if (good === 'food' && u.hunger >= 55) {         // snack from the harvest
        u.carryAmt--; u.hunger = Math.max(0, u.hunger - EAT_VALUE);
        if (u.carryAmt <= 0) { u.carry = null; u.carryAmt = 0; }
      }
    }
    if (!got || u.carryAmt >= 4) {
      if (u.carryAmt > 0 && u.cityId) startCarry(u);
      else { u.carry = null; u.carryAmt = 0; endJob(u); }
    }
  }

  function startCarry(u) {
    const d = Cities.dropoff(u.cityId, u.x, u.y);
    if (!d) { u.carry = null; u.carryAmt = 0; endJob(u); return; }
    u.state = 'carry';
    const st = mkSt('go');
    st.tx = d.x + 0.5; st.ty = d.y + 0.5; st.rg = 1.3; st.until = S.tick + 600;
    u.st = st;
  }
  function actCarry(u, tick) {
    const st = u.st;
    if (!u.cityId || !u.carry) { u.carry = null; u.carryAmt = 0; endJob(u); return; }
    const r = goTo(u, st.tx, st.ty, st.rg, 1);
    if (r === MV_ARRIVED) {
      Cities.deposit(u.cityId, u.carry, u.carryAmt);
      u.carry = null; u.carryAmt = 0;
      endJob(u);
    } else if (r === MV_NOPATH || (st.until > 0 && tick >= st.until)) {
      u.carry = null; u.carryAmt = 0; failJob(u);       // cannot deliver: drop the load rather than deadlock
    }
  }

  function actBuild(u, tick) {
    const job = u.job, st = u.st;
    if (!job) { toIdle(u, 0); return; }
    if (st.ph === 'go') {
      const r = goTo(u, st.tx, st.ty, st.rg, 1);
      if (r === MV_ARRIVED) { st.ph = 'work'; st.t = 0; }
      else if (r === MV_NOPATH) failJob(u);
      return;
    }
    if ((++st.t % 5) !== 0) return;
    const b = Buildings.get(job.buildingId);
    if (!b || b.done) { endJob(u); return; }
    const done = Buildings.work(b, eff(u) * BUILD_RATE);
    if (done || b.done) { addXp(u, 0.8); endJob(u); return; }
    if (st.t > 600) endJob(u);                        // re-evaluate after a long shift
  }

  function actFarm(u, tick) {
    const job = u.job, st = u.st;
    if (!job) { toIdle(u, 0); return; }
    if (st.ph === 'go') {
      const r = goTo(u, st.tx, st.ty, st.rg, 1);
      if (r === MV_ARRIVED) { st.ph = 'work'; st.t = 0; st.dur = Math.max(10, Math.round(50 / eff(u))); }
      else if (r === MV_NOPATH) failJob(u);
      return;
    }
    if (++st.t < st.dur) return;
    const b = Buildings.get(job.buildingId);
    if (b && b.done && u.cityId) {
      Cities.deposit(u.cityId, 'food', Buildings.farmYield(b) || 3);
      addXp(u, 0.25);
    }
    endJob(u);
  }

  function actMate(u, tick) {
    const st = u.st;
    st.t = (st.t | 0) + 1;
    if (st.t >= 14) finishBirth(u, tick);
  }

  function actSettle(u, tick) {
    const st = u.st, tg = st.target;
    if (!tg) { toIdle(u, 0); return; }
    const r = goTo(u, tg.x + 0.5, tg.y + 0.5, 2.2, 1);
    if (r === MV_NOPATH) u.pt = tick + 80;             // unreachable for now: back off (Cities releases stale expeditions)
  }

  // ---- eating
  function findFood(u) {
    // nearest berry bush, else a fishing spot; returns true and sets spX,spY,spK
    const bx = World.findNearestRes(u.x, u.y, RES.BERRY, 12);
    if (bx) { spX = bx[0] + 0.5; spY = bx[1] + 0.5; spK = RES.BERRY; return true; }
    const fx = World.findNearestRes(u.x, u.y, RES.FISH, 10);
    if (fx) { spX = fx[0] + 0.5; spY = fx[1] + 0.5; spK = RES.FISH; return true; }
    return false;
  }
  let spK = 0;
  function startEat(u, tick) {
    if (u.cityId) {
      const c = S.cities.get(u.cityId);
      if (c && c.stock.food >= 1) {
        const d = Cities.dropoff(u.cityId, u.x, u.y);
        if (d) {
          u.state = 'eat'; u.job = null;
          const st = mkSt('go');
          st.tx = d.x + 0.5; st.ty = d.y + 0.5; st.rg = 1.3; st.fk = 0; st.until = tick + 500;
          u.st = st;
          return true;
        }
      }
    }
    if (findFood(u)) {
      u.state = 'eat'; u.job = null;
      const st = mkSt('go');
      st.tx = spX; st.ty = spY; st.rg = 0.5; st.fk = spK; st.until = tick + 500;
      u.st = st;
      return true;
    }
    return false;
  }
  function actEat(u, tick) {
    const st = u.st;
    if (st.ph === 'go') {
      const r = goTo(u, st.tx, st.ty, st.rg, 1);
      if (r === MV_ARRIVED) {
        if (st.fk) {
          const got = World.harvest(st.tx | 0, st.ty | 0, st.fk, 1);
          if (got > 0) { u.hunger = Math.max(0, u.hunger - EAT_VALUE); st.ph = 'chew'; st.t = 0; }
          else { u.ec = tick + 120; toIdle(u, 0); }
        } else {
          let n = 0;
          while (u.hunger > 25 && n < 3) {
            const g = u.cityId ? Cities.withdraw(u.cityId, 'food', 1) : 0;
            if (g <= 0) break;
            u.hunger = Math.max(0, u.hunger - EAT_VALUE * g); n++;
          }
          if (n > 0) { st.ph = 'chew'; st.t = 0; }
          else { u.ec = tick + 100; toIdle(u, 0); }     // somebody ate the last bite
        }
      } else if (r === MV_NOPATH || (st.until > 0 && tick >= st.until)) { u.ec = tick + 120; toIdle(u, 0); }
      return;
    }
    if (++st.t >= 10) { toIdle(u, 0); u.nextThink = tick + 1; }
  }

  // ---- sleeping
  function lieDown(u) { u.state = 'sleep'; u.st = { ph: 'sleep', since: S.tick }; }
  function startSleep(u, tick) {
    u.job = null;
    if (u.cityId) {
      const h = homePoint(u);
      if (h && Util.dist(u.x, u.y, h.x + 0.5, h.y + 0.5) > 2.2) {
        startWalk(u, h.x + 0.5, h.y + 0.5, 1.0, 'walk', 'sleep', 0, 450);
        return;
      }
    }
    lieDown(u);
  }

  // ---- fire
  /** flames or lava on the unit's tile or any of the 8 around it */
  function onFire(u) {
    const x = u.x | 0, y = u.y | 0, w = S.w, f = S.fire, tl = S.tile;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= S.h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const i = yy * w + xx;
        if (f[i] > 0 || tl[i] === T.LAVA) return true;
      }
    }
    return false;
  }
  function fireFree(x, y) {
    if (!walkAt(x, y) || waterAt(x, y)) return false;
    const xi = x | 0, yi = y | 0, w = S.w;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = xi + dx, yy = yi + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < S.h && (S.fire[yy * w + xx] > 0 || S.tile[yy * w + xx] === T.LAVA)) return false;
    }
    return true;
  }
  function startFleeFire(u, tick) {
    // direction away from the burning neighbourhood
    const x = u.x | 0, y = u.y | 0, w = S.w;
    let ax = 0, ay = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < S.h && (S.fire[yy * w + xx] > 0 || S.tile[yy * w + xx] === T.LAVA)) { ax -= dx; ay -= dy; }
    }
    if (ax === 0 && ay === 0) { const a = R.f() * 6.283185307179586; ax = Math.cos(a); ay = Math.sin(a); }
    const base = Math.atan2(ay, ax);
    const offs = [0, 0.7, -0.7, 1.4, -1.4, 2.1, -2.1, 3.14];
    for (let dist = 5; dist >= 2; dist -= 3) {
      for (let k = 0; k < offs.length; k++) {
        const a = base + offs[k];
        const tx = u.x + Math.cos(a) * dist, ty = u.y + Math.sin(a) * dist;
        if (fireFree(tx, ty) && World.sameLand(u.x, u.y, tx, ty)) {
          u.job = null;
          startWalk(u, tx, ty, 0.6, 'flee', '', 0, 80);
          return true;
        }
      }
    }
    return false;
  }

  // ---- flee / fight
  function startFlee(u, foe, tick) {
    let ax = u.x - foe.x, ay = u.y - foe.y;
    const al = Math.sqrt(ax * ax + ay * ay) || 1;
    ax /= al; ay /= al;
    let tx = 0, ty = 0, set = false;
    const h = u.cityId ? homePoint(u) : null;
    if (h) {
      const hx = h.x + 0.5 - u.x, hy = h.y + 0.5 - u.y, hl = Math.sqrt(hx * hx + hy * hy);
      if (hl > 3 && (hx * ax + hy * ay) / hl > -0.2) { tx = h.x + 0.5; ty = h.y + 0.5; set = true; }
    }
    if (!set) {
      const base = Math.atan2(ay, ax);
      const offs = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9];
      for (let k = 0; k < offs.length && !set; k++) {
        const a = base + offs[k];
        for (let dist = 8; dist >= 4; dist -= 2) {
          const x = u.x + Math.cos(a) * dist, y = u.y + Math.sin(a) * dist;
          if (walkAt(x, y) && !waterAt(x, y) && World.sameLand(u.x, u.y, x, y)) { tx = x; ty = y; set = true; break; }
        }
      }
    }
    if (!set) { startFight(u, foe, tick); return; }        // cornered: fight
    u.job = null;
    startWalk(u, tx, ty, 0.8, 'flee', '', 0, 70);
  }
  function actFlee(u, tick) {
    const st = u.st;
    const r = goTo(u, st.tx, st.ty, st.rg, 1.25);
    if (r === MV_ARRIVED || r === MV_NOPATH || (st.until > 0 && tick >= st.until)) toIdle(u, 12);
  }
  function startFight(u, foe, tick) {
    u.job = null;
    u.state = 'fight';
    const st = mkSt('go');
    st.tid = foe.id; st.until = tick + 220;
    u.st = st;
  }
  function strike(u, foe, tick, ranged) {
    let dmg = atkOf(u) * (0.8 + R.f() * 0.4) - defOf(foe) * 0.5;
    if (dmg < 1) dmg = 1;
    u.cd = tick + (ranged ? 12 : 8);
    if (fxBudget > 0 && S.perf.lod < 2) { fxBudget--; Fx.add(ranged ? 'spark' : 'blood', foe.x, foe.y, { ttl: 0.3 }); }
    damage(foe, dmg, 'combat', u);
  }
  /** approach + attack one tick; used by fight and army states */
  function combatStep(u, foe, tick) {
    const dx = foe.x - u.x, dy = foe.y - u.y, d2 = dx * dx + dy * dy;
    const ranged = isRanged(u);
    const reach = ranged ? Gear.range(u.race, (u.weapon | 0) & 3) : RC(u).range;
    if (d2 <= reach * reach) {
      if (dx > 0.05) u.face = 1; else if (dx < -0.05) u.face = -1;
      if (tick >= u.cd) strike(u, foe, tick, ranged);
    } else {
      goTo(u, foe.x, foe.y, reach * 0.8, 1);
    }
  }
  function actFight(u, tick) {
    const st = u.st;
    const foe = S.units.get(st.tid);
    if (!foe || !(foe.hp > 0)) { toIdle(u, 8); return; }
    const dx = foe.x - u.x, dy = foe.y - u.y;
    if (dx * dx + dy * dy > 196 || (st.until > 0 && tick >= st.until)) {       // lost it / gave up
      toIdle(u, 10);
      u.st.nohunt = tick + 140;
      return;
    }
    combatStep(u, foe, tick);
  }

  // ---- armies
  function occupiedCity(cityId) { const c = S.cities.get(cityId); return !!c && c.occupierId > 0; }
  /** a soldier of an army that is cut off from its supply does not recover (War applies the attrition) */
  function armyStarved(u) { const a = S.armies.get(u.armyId); return !!a && a.supply < 30; }
  function enemyBuildingNear(u, army, x, y, rad) {
    // enemy building within rad tiles of (x,y) (3x3 for rad<=1.5), kingdom of its city at war with u's kingdom
    const xi = x | 0, yi = y | 0, r = Math.ceil(rad);
    let best = null, bd = 1e9;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = xi + dx, yy = yi + dy;
      if (xx < 0 || yy < 0 || xx >= S.w || yy >= S.h) continue;
      const bid = S.bld[yy * S.w + xx];
      if (!bid) continue;
      const b = S.buildings.get(bid);
      if (!b) continue;
      const c = S.cities.get(b.cityId);
      if (!c || !c.kingdomId || c.kingdomId === u.kingdomId) continue;
      if (Diplomacy.atWar(u.kingdomId, c.kingdomId) !== true) continue;
      const d = (xx + 0.5 - x) * (xx + 0.5 - x) + (yy + 0.5 - y) * (yy + 0.5 - y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }
  function nearestEnemyBuilding(u, army) {
    // from the target city's buildings (siege goal)
    const tc = army.target && army.target.cityId ? S.cities.get(army.target.cityId) : null;
    if (!tc || !tc.kingdomId || Diplomacy.atWar(u.kingdomId, tc.kingdomId) !== true) return null;
    let best = null, bd = 1e9;
    for (let i = 0; i < tc.buildings.length; i++) {
      const b = S.buildings.get(tc.buildings[i]);
      if (!b) continue;
      const d = (b.x + 0.5 - u.x) * (b.x + 0.5 - u.x) + (b.y + 0.5 - u.y) * (b.y + 0.5 - u.y);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }
  function actArmy(u, tick) {
    const army = S.armies.get(u.armyId);
    if (!army) { release(u); return; }
    const st = u.st;
    if (st.tid) {
      const foe = S.units.get(st.tid);
      if (foe && foe.hp > 0 && army.mode !== 'retreat') {
        const dx = foe.x - u.x, dy = foe.y - u.y;
        let ok = dx * dx + dy * dy < 100;
        if (ok && (army.mode === 'hold' || army.mode === 'siege') && !foe.armyId && foe.state !== 'fight') ok = false;   // civilians that stopped fighting are left alone
        if (ok && army.mode === 'hold' && army.rally) {          // garrison: never chase further than ~8 tiles from the post
          const fx = foe.x - army.rally.x, fy = foe.y - army.rally.y, ux = u.x - army.rally.x, uy = u.y - army.rally.y;
          ok = fx * fx + fy * fy <= 64 && ux * ux + uy * uy <= 100;
        }
        if (ok) { combatStep(u, foe, tick); return; }
      }
      st.tid = 0;
    }
    if (st.bid) {
      const b = S.buildings.get(st.bid);
      if (!b || army.mode !== 'siege') st.bid = 0;
      else {
        const dx = b.x + 0.5 - u.x, dy = b.y + 0.5 - u.y;
        if (dx * dx + dy * dy <= 2.25) {
          if (tick >= u.cd) {
            u.cd = tick + 8;
            if (fxBudget > 0 && S.perf.lod < 2) { fxBudget--; Fx.add('spark', b.x + 0.5, b.y + 0.5, { ttl: 0.3 }); }
            if (Buildings.damage(b, Math.max(1, atkOf(u) * 0.8), u.kingdomId, 'war')) st.bid = 0;
          }
          if (dx > 0.05) u.face = 1; else if (dx < -0.05) u.face = -1;
        } else if (goTo(u, b.x + 0.5, b.y + 0.5, 1.1, 1) === MV_NOPATH) st.bid = 0;
        return;
      }
    }
    // follow the rally point with a small formation offset (stays within ~3 tiles of it: a garrison "holds" within ~4)
    const rally = army.rally;
    if (!rally) return;
    const a = (u.id * 2.399963229728653) % 6.283185307179586;
    const rad = 0.8 + ((u.id * 7) % 11) * 0.22;
    const tx = rally.x + Math.cos(a) * rad, ty = rally.y + Math.sin(a) * rad;
    const r = goTo(u, tx, ty, 0.5, 1);
    if (r === MV_NOPATH) u.pt = tick + 60;
  }
  function thinkArmy(u, tick, te) {
    const army = S.armies.get(u.armyId);
    if (!army) { release(u); return false; }
    if (u.state !== 'army') { u.state = 'army'; u.job = null; u.st = { ph: '', since: tick }; }
    const st = u.st;
    if (u.hunger > 80 && tick >= u.ec && u.cityId && !(army.supply < 30)) {      // supply line: rations from the home city (cut off when out of supply)
      u.ec = tick + 60;
      const g = Cities.withdraw(u.cityId, 'food', 1);
      if (g > 0) u.hunger = Math.max(0, u.hunger - EAT_VALUE * g);
    }
    const mode = army.mode;
    if (mode === 'retreat') { st.tid = 0; st.bid = 0; return true; }
    const siege = mode === 'siege', hold = mode === 'hold';
    if (!st.tid) {
      sOnlyMine = true; sForceWar = true; sArmedPref = true;
      scan(u, siege || hold ? 6 : 3.5);
      sOnlyMine = false; sForceWar = false; sArmedPref = false;
      // soldiers prefer combatants; civilians are only hunted while marching / gathering (never by a garrison or a besieging army)
      let f = sArmFoe;
      if (!f && !siege && !hold) f = sFoe;
      if (f && hold && army.rally) {
        const fx = f.x - army.rally.x, fy = f.y - army.rally.y;
        if (fx * fx + fy * fy > 64) f = null;                                // hold: engage within ~6 tiles of the soldier, never beyond ~8 of the post
      }
      if (f) { st.tid = f.id; st.bid = 0; }
    }
    if (!st.tid && siege && !st.bid) {
      let b = enemyBuildingNear(u, army, u.x, u.y, 1.5);
      if (!b) b = nearestEnemyBuilding(u, army);
      if (b) st.bid = b.id;
    }
    return true;
  }

  // ------------------------------------------------------------------ threat scan
  function refreshWars() {
    warSet.clear(); warAll = false;
    if (S.wars.size === 0) return;
    for (const w of S.wars.values()) {
      if (w.ended) continue;
      if (!w.attackers || !w.defenders) { warAll = true; continue; }
      for (let i = 0; i < w.attackers.length; i++) warSet.add(w.attackers[i]);
      for (let i = 0; i < w.defenders.length; i++) warSet.add(w.defenders[i]);
    }
  }
  /** can u meet anybody hostile right now? (cheap census test; false for peaceful units, which skip scanning entirely) */
  function threatPossible(u) {
    const k = u.kingdomId | 0;
    if (k !== 0 && (warAll || warSet.has(k))) return true;
    const base = u.race * NR;
    for (let x = 0; x < NR; x++) {
      if (HR[base + x] === 1 && (k === 0 ? cntAll[x] > 0 : cntWand[x] > 0)) return true;
    }
    return false;
  }
  /** fills sFoe (nearest hostile), sEnemyPow, sFriendPow (allies; incl. nothing for self) within r tiles of u */
  function scan(u, r) {
    sFoe = null; sFoeD2 = 1e9; sEnemyPow = 0; sFriendPow = 0; sArmFoe = null; sArmD2 = 1e9;
    const x = u.x, y = u.y, r2 = r * r;
    let cx0 = ((x - r) * 0.125) | 0, cx1 = ((x + r) * 0.125) | 0, cy0 = ((y - r) * 0.125) | 0, cy1 = ((y + r) * 0.125) | 0;
    if (x - r < 0) cx0 = 0; if (y - r < 0) cy0 = 0;
    if (cx1 >= GW) cx1 = GW - 1; if (cy1 >= GH) cy1 = GH - 1;
    const myK = u.kingdomId | 0, now = S.tick, base = u.race * NR;
    const warMode = sForceWar || (myK !== 0 && (warAll || warSet.has(myK)));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const arr = cells[cy * GW + cx];
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i];
          if (myK !== 0 && myK === (v.kingdomId | 0)) continue;           // same kingdom: never hostile
          if (!warMode && HR[base + v.race] === 0) continue;               // no wanderer rule can apply to this race pair
          if (v === u) continue;
          const dx = v.x - x, dy = v.y - y, d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          if (isHostile(u, v) || (!sOnlyMine && isHostile(v, u))) {
            sEnemyPow += powerOf(v);
            if (d2 < sFoeD2) { sFoeD2 = d2; sFoe = v; }
            if (sArmedPref && d2 < sArmD2 && (v.armyId > 0 || v.state === 'fight')) { sArmD2 = d2; sArmFoe = v; }
          }
        }
      }
    }
    if (sFoe === null) return;
    // an enemy is near: count the friends around (same kingdom, or free people of the same race)
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const arr = cells[cy * GW + cx];
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i];
          if (v === u || v.race !== u.race && myK === 0) continue;
          if ((v.kingdomId | 0) !== myK) continue;
          const dx = v.x - x, dy = v.y - y;
          if (dx * dx + dy * dy > r2 || now - v.born < MAT[v.race]) continue;
          if (myK === 0 && (isHostile(u, v) || isHostile(v, u))) continue;
          sFriendPow += powerOf(v);
        }
      }
    }
  }

  // ------------------------------------------------------------------ jobs / spare time
  function startJob(u, job, tick) {
    u.job = job;
    const jx = job.x + 0.5, jy = job.y + 0.5;
    switch (job.type) {
      case 'build': {
        const b = Buildings.get(job.buildingId);
        if (!b || b.done) { u.job = null; return false; }
        u.state = 'build';
        const st = mkSt('go');
        aroundSpot(u, b.x + 0.5, b.y + 0.5, 0.9);
        st.tx = spX; st.ty = spY; st.rg = 0.3; st.until = tick + 900;
        u.st = st;
        return true;
      }
      case 'farm': {
        const b = Buildings.get(job.buildingId);
        if (!b || !b.done) { u.job = null; return false; }
        u.state = 'farm';
        const st = mkSt('go');
        aroundSpot(u, b.x + 0.5, b.y + 0.5, 0.45);
        st.tx = spX; st.ty = spY; st.rg = 0.3; st.until = tick + 900;
        u.st = st;
        return true;
      }
      case 'chop': case 'mine': case 'forage': case 'fish': {
        u.state = 'gather';
        const st = mkSt('go');
        aroundSpot(u, jx, jy, 0.3);
        st.tx = spX; st.ty = spY; st.rg = 0.3; st.until = tick + 900;
        u.st = st;
        return true;
      }
      case 'guard':
        Cities.outfit(u.cityId, u);
        startWalk(u, jx, jy, 0.4, 'walk', 'guard', 90 + (hash(u.id, tick, 2) % 60), 500);
        return true;
      default:
        startWalk(u, jx, jy, 0.4, 'walk', 'idle', 30 + (hash(u.id, tick, 6) % 50), 500);
        return true;
    }
  }

  function related(a, b) {
    if (a.id === b.fatherId || a.id === b.motherId || b.id === a.fatherId || b.id === a.motherId) return true;
    if (a.fatherId && a.fatherId === b.fatherId) return true;
    if (a.motherId && a.motherId === b.motherId) return true;
    return false;
  }

  function canBirth(u, tick, r) {
    if (u.sex !== SEX.F || !u.spouseId || tick < u.birthCd || u.armyId) return false;
    const a = (tick - u.born) / TPY;
    if (a < r.fertAge[0] || a > r.fertAge[1]) return false;
    if (u.hunger > 75) return false;
    if (S.units.size >= (S.perf.unitCap || Const.MAX_UNITS)) return false;
    const c = S.cities.get(u.cityId);
    if (!c) return false;
    if (Cities.housingFree(c.id) <= 0) return false;
    if (c.stock.food < Math.max(4, c.pop * 1.2)) return false;
    const sp = S.units.get(u.spouseId);
    if (!sp || sp.spouseId !== u.id) return false;
    return true;
  }
  function tryStartMate(u, tick, r, dt) {
    if (!canBirth(u, tick, r)) return false;
    const c = S.cities.get(u.cityId);
    let p = BIRTH_ATTEMPT * (dt / 20) * Math.min(1.6, Traits.mul(u, 'fertility')) * Math.sqrt(Math.min(1, r.fertility)) * balOf(u.race);
    if (c.pop < 12) p *= 1.4;                           // small villages grow faster
    if (!R.chance(p)) return false;
    u.job = null;
    u.state = 'mate'; u.st = { ph: 'mate', since: tick, t: 0 };
    return true;
  }
  /** (men - women) / (men + women + 2) among the adults of a city, -1..1 */
  function sexSkew(c) {
    let m = 0, f = 0;
    const now = S.tick;
    for (let i = 0; i < c.members.length; i++) {
      const v = S.units.get(c.members[i]);
      if (!v || now - v.born < MAT[v.race]) continue;
      if (v.sex === SEX.F) f++; else m++;
    }
    return (m - f) / (m + f + 2);
  }
  function finishBirth(u, tick) {
    toIdle(u, 0);
    const r = RC(u);
    if (!canBirth(u, tick, r)) return;
    const c = S.cities.get(u.cityId);
    const sp = S.units.get(u.spouseId);
    const fertF = Math.max(0.2, r.fertility * Traits.mul(u, 'fertility'));
    const bal = balOf(u.race);
    u.birthCd = tick + Math.round(r.birthCooldown * TPY / fertF * (c.pop < 16 ? 0.75 : 1) / (bal > 1 ? Math.min(1.8, bal) : 1));   // small villages recover faster, so do races below their fair share
    const sex = R.chance(0.5 + 0.3 * sexSkew(c)) ? SEX.F : SEX.M;     // mild homeostasis: the scarcer sex is born more often
    const child = spawn(u.race, u.x, u.y, {
      sex, age: 0, fatherId: sp.id, motherId: u.id, traits: mixTraits(sp, u),
      clan: sp.clan || u.clan, hunger: 0, energy: 100,
    });
    if (!child) return;
    Cities.addMember(c.id, child);
    Hist.add(child, 'Родился в «' + c.name + '»');
    modState().births++;
    if (u.isRuler || sp.isRuler) {
      const k = S.kingdoms.get(c.kingdomId);
      const ruler = u.isRuler ? u : sp;
      Log.add('В семье правителя ' + ruler.name + (k ? ' («' + k.name + '»)' : '') + ' родил' + (sex === SEX.F ? 'ась дочь ' : 'ся сын ') + child.name,
        Const.LOG.BIRTH, u.x | 0, u.y | 0, c.kingdomId);
    }
  }

  function pairCity(c, tick) {
    pairM.length = 0; pairF.length = 0;
    const mem = c.members;
    for (let i = 0; i < mem.length; i++) {
      const u = S.units.get(mem[i]);
      if (!u || u.spouseId || tick - u.born < MAT[u.race] || u.armyId) continue;
      (u.sex === SEX.F ? pairF : pairM).push(u);
    }
    if (!pairM.length || !pairF.length) return;
    let made = 0;
    for (let i = 0; i < pairF.length && made < 3 && pairM.length; i++) {
      const f = pairF[i];
      const fa = (tick - f.born) / TPY;
      let bi = -1, bs = 1e9;
      const tries = Math.min(pairM.length, 8);
      for (let k = 0; k < tries; k++) {
        const j = R.i(pairM.length);
        const m = pairM[j];
        if (related(f, m)) continue;
        const sc = Math.abs(fa - (tick - m.born) / TPY);
        if (sc < bs) { bs = sc; bi = j; }
      }
      if (bi < 0) continue;
      const m = pairM[bi];
      pairM[bi] = pairM[pairM.length - 1]; pairM.pop();
      f.spouseId = m.id; m.spouseId = f.id;
      if (f.birthCd < tick + 20) f.birthCd = tick + R.int(20, 100);
      if (f.isRuler || m.isRuler || (f.hist.length < 6 && m.hist.length < 6)) { Hist.add(f, 'Вышла замуж за ' + m.name); Hist.add(m, 'Женился на ' + f.name); }
      made++;
    }
  }

  function pickChild(u, tick) {
    const m = S.units.get(u.motherId);
    if (m && m.hp > 0 && m.cityId === u.cityId && R.chance(0.6)) {
      const a = R.f() * 6.283185307179586, d = 0.8 + R.f() * 1.8;
      const x = m.x + Math.cos(a) * d, y = m.y + Math.sin(a) * d;
      if (walkAt(x, y) && !waterAt(x, y)) { startWalk(u, x, y, 0.4, 'wander', '', 15 + R.i(40), 300); return; }
    }
    const h = homePoint(u);
    if (h) startWander(u, h.x + 0.5, h.y + 0.5, 4); else toIdle(u, 30);
  }

  function pickCitizen(u, tick, stg) {
    for (let k = 0; k < 4; k++) {
      const job = Cities.assignJob(u);
      if (!job) continue;
      if (stg === 2 && (job.type === 'chop' || job.type === 'mine') && k < 3) continue;     // elders: light work only (asked again)
      if (stg === 2 && (job.type === 'chop' || job.type === 'mine')) break;
      if (startJob(u, job, tick)) return;
    }
    const c = S.cities.get(u.cityId);
    if (c) startWander(u, c.x + 0.5, c.y + 0.5, 4); else toIdle(u, 30);
  }

  function pickHomeless(u, tick, stg) {
    if (stg !== 0 && tick - u.tt >= 50 && settleBudget > 0) {
      settleBudget--;
      u.tt = tick;
      const hint = Cities.trySettle(u);
      if (u.cityId) { if (u.state !== 'army') { u.state = 'idle'; } u.nextThink = tick + 1; return; }
      if (hint && Util.dist(u.x, u.y, hint.x + 0.5, hint.y + 0.5) > 2.5) {
        startWalk(u, hint.x + 0.5, hint.y + 0.5, 1.5, 'walk', '', 20, 500);
        return;
      }
    }
    startWander(u, u.x, u.y, 6);
  }

  function pickActivity(u, tick, stg) {
    u.job = null;
    if (u.carry && u.carryAmt > 0) {
      if (u.cityId) { startCarry(u); return; }
      u.carry = null; u.carryAmt = 0;
    }
    if (!u.cityId) { pickHomeless(u, tick, stg); return; }
    if (stg === 0) { pickChild(u, tick); return; }
    pickCitizen(u, tick, stg);
  }

  // ------------------------------------------------------------------ think (decisions every few ticks)
  function thinkSettle(u, tick) {
    const st = u.st, tg = st && st.target;
    if (!tg) { toIdle(u, 0); return; }
    if (u.hunger >= 80 && tick >= u.ec && st.parent) {      // travel rations from the parent city
      u.ec = tick + 60;
      const g = Cities.withdraw(st.parent, 'food', 1);
      if (g > 0) u.hunger = Math.max(0, u.hunger - EAT_VALUE * g);
    }
    if (Util.dist(u.x, u.y, tg.x + 0.5, tg.y + 0.5) <= 3.5) {
      Cities.foundExpedition(u);
    }
  }

  function watchdog(u, tick) {
    const st = u.st, s = u.state;
    if (st.since === undefined) st.since = tick;
    const lim = LIMIT[s];
    if (lim && tick - st.since > lim) {
      if (s === 'settle') return;
      u.job = null; toIdle(u, 20);
      return;
    }
    if (st.mv > tick - 8) {                              // trying to move: make sure we do get somewhere
      if (!(st.lt > 0)) { st.lt = tick; st.lx = u.x; st.ly = u.y; st.sk = 0; }
      else if (tick - st.lt >= 60) {
        const dx = u.x - st.lx, dy = u.y - st.ly;
        st.lt = tick; st.lx = u.x; st.ly = u.y;
        if (dx * dx + dy * dy < 0.36) {
          st.sk = (st.sk | 0) + 1;
          if (st.sk === 1) { st.path = null; st.blk = 8; u.pt = 0; }          // first time: force a path
          else if (s === 'settle' || s === 'army') { st.path = null; st.blk = 8; u.pt = 0; if (st.sk > 4) nudge(u); }
          else { u.job = null; toIdle(u, 20); if (st.sk > 2) nudge(u); }
        } else st.sk = 0;
      }
    }
  }
  function nudge(u) {
    const p = World.nearestWalkable(u.x, u.y, 3);
    if (p) { u.x = p[0] + 0.5; u.y = p[1] + 0.5; u.px = u.x; u.py = u.y; }
  }

  function think(u, tick, te) {
    const dt = te + 1;
    const r = RC(u);
    const age = tick - u.born;
    const stg = age < MAT[u.race] ? 0 : age > ELD[u.race] ? 2 : 1;
    const sleeping = u.state === 'sleep';

    // ---- ageing: hazard rises after 85% of the natural lifespan
    const lifeT = u.life * TPY;
    if (age > lifeT * 0.85) {
      const f = (age - lifeT * 0.85) / (lifeT * 0.15);
      const hz = f <= 1 ? 0.0004 + 0.008 * f : 0.0084 + 0.05 * (f - 1);
      if (R.f() < hz * dt) { kill(u, 'age'); return; }
    }
    // ---- growth / health
    const mh = maxHpOf(u);
    if (mh !== u.maxHp) {
      if (mh > u.maxHp) u.hp = Math.min(mh, u.hp + (mh - u.maxHp)); else if (u.hp > mh) u.hp = mh;
      u.maxHp = mh;
    }
    if (u.sick) {
      if (u.sick <= tick) { u.sick = 0; u.immune = tick + 600; }
      else {
        if (R.f() < 0.01 * dt / 3 * (Traits.mul(u, 'sick') > 1 || stg === 2 ? 0.5 : 1)) { u.sick = 0; u.immune = tick + 600; }
        else spreadDisease(u, tick);
      }
    }
    if (u.hp < u.maxHp && u.hunger < 70 && !u.sick && u.burning <= tick && !(u.armyId && armyStarved(u))) {
      u.hp = Math.min(u.maxHp, u.hp + (sleeping ? 0.08 : 0.025) * dt * (u.maxHp / 20));
    }
    if (u.burning > tick && S.tile[(u.y | 0) * S.w + (u.x | 0)] === T.SHALLOW) u.burning = 0;

    const state = u.state;
    // ---- expedition travellers are driven by Cities; armies by their rally point
    if (state === 'settle') { thinkSettle(u, tick); watchdog(u, tick); return; }
    if (u.armyId) { if (thinkArmy(u, tick, te)) { watchdog(u, tick); return; } }

    // ---- fire
    if ((u.burning > tick || onFire(u)) && state !== 'flee') {
      if (startFleeFire(u, tick)) return;
    }

    // ---- enemies (units already in a fight / flight only re-evaluate every ~8 ticks: keeps big battles cheap)
    let foe = null;
    if ((state === 'fight' || state === 'flee') && ((tick + u.id) & 7) >= te) { watchdog(u, tick); return; }
    if (threatPossible(u)) {
      const kc = u.kingdomId > 0;
      sArmedPref = kc;
      scan(u, THREAT_R);
      sArmedPref = false;
      foe = sFoe;
      // stage 2: wars are fought by armies. Citizens of warring kingdoms tolerate each other's citizens and only react to soldiers / aggressors
      if (kc && foe !== null && foe.kingdomId > 0 && !foe.armyId && foe.state !== 'fight') { foe = sArmFoe; sFoeD2 = sArmD2; }
    }
    // citizens of a city held by an enemy army keep their heads down: no panic, no last stand against the garrison (War/occupation, stage 2)
    if (foe !== null && foe.armyId > 0 && u.cityId && occupiedCity(u.cityId)) foe = null;
    if (foe) {
      const st0 = u.st;
      if (!(st0.nohunt > tick && sFoeD2 > 6)) {
        if (stg === 0) { if (state !== 'flee') startFlee(u, foe, tick); return; }
        const c = u.cityId ? S.cities.get(u.cityId) : null;
        let need = 0.8 + Traits.sum(u, 'flee');
        if (u.hp < u.maxHp * 0.35) need += 0.6;
        if (c && Cities.ownerAt(foe.x, foe.y) === c.id) need *= 0.5;          // defending the home territory
        const ratio = (sFriendPow + powerOf(u)) / (sEnemyPow + 0.01);
        // unarmed villagers do not take on soldiers (no massacre of a defenceless population; guards with weapons still do)
        if (ratio >= need && !(foe.armyId > 0 && !(u.weapon > 0))) {
          if (!(state === 'fight' && st0.tid === foe.id)) startFight(u, foe, tick);
        } else if (state !== 'flee') startFlee(u, foe, tick);
        return;
      }
    }
    if (state === 'fight' || state === 'flee') { watchdog(u, tick); return; }

    // ---- sleeping: wake up when rested / starving
    if (sleeping) {
      if (u.energy >= 90 || u.hunger >= 95) toIdle(u, 0);
      watchdog(u, tick);
      return;
    }

    // ---- needs
    const idleish = state === 'idle' || !u.job;
    const goingToBed = state === 'walk' && u.st.then === 'sleep';
    if (state !== 'eat' && tick >= u.ec && (goingToBed ? u.hunger >= 90 : (u.hunger >= 75 || (u.hunger >= 50 && idleish)))) {
      if (startEat(u, tick)) return;
      u.ec = tick + 90;
    }
    if (u.energy < 20 && state !== 'eat' && !goingToBed) { startSleep(u, tick); return; }

    // ---- family: pregnancy is abstracted into a birth roll
    if (u.spouseId && u.sex === SEX.F && tick >= u.birthCd && state !== 'eat' && state !== 'mate' && tryStartMate(u, tick, r, dt)) return;

    // ---- spare time: choose the next activity
    if (state === 'idle') {
      const st = u.st;
      if (st.until > 0 && tick < st.until) return;
      pickActivity(u, tick, stg);
      return;
    }
    watchdog(u, tick);
  }

  function spreadDisease(u, tick) {
    nearby(u.x, u.y, 1.5, (v) => {
      if (v !== u && !v.sick && (v.immune | 0) <= tick && R.f() < 0.02 * Traits.mul(v, 'sick')) infect(v, tick + 200 + R.i(200));
    });
  }

  // ------------------------------------------------------------------ per-tick
  function rescue(u, tick) {
    // standing on an unwalkable tile (terrain changed): step to the nearest walkable tile within 3, else drown / burn
    const t = S.tile[(u.y | 0) * S.w + (u.x | 0)];
    const lava = t === T.LAVA;
    const st = u.st;
    if (u.state !== 'flee' || st.rs !== 1) {
      const p = World.nearestWalkable(u.x, u.y, 3);
      if (p) {
        u.job = null; u.state = 'flee';
        u.st = { ph: 'go', since: tick, rs: 1, tx: p[0] + 0.5, ty: p[1] + 0.5, rg: 0.2, until: tick + 60 };
      } else {
        damage(u, lava ? 6 : 2, lava ? 'lava' : 'drown');
        return;
      }
    }
    const s = u.st;
    const dx = s.tx - u.x, dy = s.ty - u.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d <= 0.2) { u.x = s.tx; u.y = s.ty; toIdle(u, 5); return; }
    const step = 0.16;
    u.x += dx / d * step; u.y += dy / d * step;
    if (u.x < 0.01) u.x = 0.01; else if (u.x > S.w - 0.01) u.x = S.w - 0.01;
    if (u.y < 0.01) u.y = 0.01; else if (u.y > S.h - 0.01) u.y = S.h - 0.01;
    if (lava) damage(u, 3, 'lava'); else if (t === T.DEEP) damage(u, 0.4, 'drown');
  }

  function tickUnit(u, tick, te) {
    u.px = u.x; u.py = u.y;
    nxtAll[u.race]++; if (!u.kingdomId) nxtWand[u.race]++;
    if (u.cell === undefined) { normalize(u); gridInsert(u); }
    if (!(u.x >= 0 && u.y >= 0 && u.x < S.w && u.y < S.h)) {          // NaN / out of the map: put back on land
      const p = World.nearestWalkable(isNaN(u.x) ? 0 : clamp(u.x, 0, S.w - 1), isNaN(u.y) ? 0 : clamp(u.y, 0, S.h - 1), 12);
      if (p) { u.x = p[0] + 0.5; u.y = p[1] + 0.5; u.px = u.x; u.py = u.y; } else { kill(u, 'lost'); return; }
    }
    // ---- needs (exact per tick)
    if (u.state === 'sleep') {
      u.hunger += HUNGER_SLEEP;
      u.energy += ENERGY_SLEEP; if (u.energy > 100) u.energy = 100;
    } else {
      u.hunger += HUNGER_RATE;
      u.energy -= ENERGY_DRAIN; if (u.energy < 0) u.energy = 0;
    }
    if (u.hunger >= 100) {
      u.hunger = 100;
      u.hp -= 0.1;
      if (u.hp <= 0) { kill(u, 'hunger'); return; }
    }
    if (u.sick > tick) {
      const hi = Traits.mul(u, 'sick') > 1 || S.tick - u.born > ELD[u.race];
      if ((tick + u.id) % (hi ? 6 : 12) === 0) { if (damage(u, 1, 'disease')) return; }
    }
    if (u.burning > tick) {
      u.hp -= 0.12;
      if (u.hp <= 0) { kill(u, 'fire'); return; }
    }
    // ---- terrain under the feet / activity
    if (WALK[S.tile[(u.y | 0) * S.w + (u.x | 0)]] === 0) { rescue(u, tick); if (!(u.hp > 0)) return; }
    else act(u, tick);
    // ---- grid
    const ci = cellOf(u.x, u.y);
    if (ci !== u.cell) { gridRemove(u); u.cell = ci; cells[ci].push(u); }
    // ---- decisions
    if (tick >= u.nextThink) {
      u.nextThink = tick + te + ((u.id + tick) % 3);
      think(u, tick, te);
      if (S.units.get(u.id) !== u) return;
    }
  }

  function reportError(e, u) {
    errCount++; lastError = e;
    if (errLogged < 5 && typeof console !== 'undefined') { errLogged++; console.error('Units error', e && e.stack || e); }
    if (u && S.units.get(u.id) === u) { u.job = null; u.state = 'idle'; u.st = { ph: '', since: S.tick, until: S.tick + 30 }; u.nextThink = S.tick + 10; }
  }

  function step(tick) {
    if (tick === undefined) tick = S.tick;
    if (!S.tile) return;
    ensureGrid();
    pathBudget = PATH_BUDGET; settleBudget = SETTLE_BUDGET; fxBudget = 8;
    const te = S.perf.thinkEvery > 0 ? S.perf.thinkEvery : 3;
    refreshWars();
    if (tick % 20 === 0) updateBalance();
    nxtAll.fill(0); nxtWand.fill(0);
    for (const u of S.units.values()) {
      try { tickUnit(u, tick, te); } catch (e) { reportError(e, u); }
    }
    { const a = cntAll, w = cntWand; cntAll = nxtAll; cntWand = nxtWand; nxtAll = a; nxtWand = w; }   // census for next tick
    // city-level pairing (throttled)
    for (const c of S.cities.values()) {
      if ((tick + c.id) % 20 === 0) { try { pairCity(c, tick); } catch (e) { reportError(e, null); } }
    }
    if (tick % 100 === 17) gridSweep();
  }

  // ------------------------------------------------------------------ labels
  function stateLabel(u) {
    u = resolve(u);
    if (!u) return '';
    const j = u.job, jt = j ? j.type : '';
    const stg = stageIdx(u);
    switch (u.state) {
      case 'idle':
        if (stg === 0) return 'Играет';
        if (jt === 'guard') return 'Охраняет';
        return u.cityId ? 'Отдыхает' : 'Бездельничает';
      case 'wander': return u.cityId ? (stg === 0 ? 'Играет' : 'Прогуливается') : 'Бродит';
      case 'walk':
        if (jt === 'guard') return 'Идёт на пост';
        if (u.st && u.st.then === 'sleep') return 'Идёт спать';
        return u.cityId ? 'Идёт' : 'Ищет место для жизни';
      case 'gather':
        if (jt === 'chop') return 'Рубит лес';
        if (jt === 'mine') return j.kind === 'iron' ? 'Добывает железо' : j.kind === 'gold' ? 'Добывает золото' : 'Добывает камень';
        if (jt === 'forage') return 'Собирает ягоды';
        if (jt === 'fish') return 'Ловит рыбу';
        return 'Добывает ресурсы';
      case 'carry': return 'Несёт добычу';
      case 'build': return 'Строит';
      case 'farm': return 'Работает на ферме';
      case 'eat': return 'Ест';
      case 'sleep': return 'Спит';
      case 'flee': return 'Убегает';
      case 'fight': return 'Сражается';
      case 'army': {
        const a = S.armies.get(u.armyId);
        if (u.st && (u.st.tid || u.st.bid)) return u.st.bid && !u.st.tid ? 'Штурмует' : 'Сражается';
        if (a && a.mode === 'march') return 'Марширует';
        if (a && a.mode === 'siege') return 'Осаждает';
        if (a && a.mode === 'hold') return 'Держит позицию';
        if (a && a.mode === 'retreat') return 'Отступает';
        return 'Собирается в армию';
      }
      case 'mate': return 'Рожает';
      case 'settle': return 'Идёт основать поселение';
    }
    return '';
  }

  // ------------------------------------------------------------------ lifecycle
  Bus.on('cityFounded', (c) => { try { pairCity(c, S.tick); } catch (e) { reportError(e, null); } });
  function newWorld() { gMap = null; S.mod.units = { births: 0, deaths: 0, causes: {} }; errCount = 0; lastError = null; errLogged = 0; rebuildGrid(); }
  function afterLoad() { modState(); rebuildGrid(); for (const u of S.units.values()) { u.px = u.x; u.py = u.y; } }

  return {
    get(id) { return S.units.get(id) || null; },
    count() { return S.units.size; },
    spawn, kill, damage, damageAt, heal, nearby, inRadius, nearest, eraseInRadius,
    stage, stats, isHostile, setCity, conscript, release, infect, stateLabel, step,
    rebuildGrid, newWorld, afterLoad,
    // extras
    totals() { const m = modState(); return { births: m.births, deaths: m.deaths, causes: Object.assign({}, m.causes) }; },
    get errors() { return errCount; },
    get lastError() { return lastError; },
    atkOf, defOf, maxHpOf, rangeOf,
  };
})();
