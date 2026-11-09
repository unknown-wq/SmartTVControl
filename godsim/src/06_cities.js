/* =====================================================================
 * 06_cities.js — Cities: founding, territory, stock, housing, construction planning, job assignment,
 *                expeditions, homeless settling, capture / destruction.
 * OWNER: Cities+Buildings agent. API: docs/CONTRACT.md §3 Cities.
 *
 * Protocols shared with Units (see the task text / REQUESTS.md):
 *  JOBS   Cities.assignJob(u) -> {type, x, y, buildingId?, kind?} | null. Types: build, chop, mine(kind stone|iron|gold),
 *         forage, fish, farm, guard, idle. Stateless; weights are computed in Cities.step and cached in city.mod.w.
 *         Candidate tiles are cached per city in city.mod.c and refreshed every ~50 ticks, so assignJob never scans the map.
 *         Farm cycle: the unit works ~50 ticks, then deposits Buildings.farmYield(b) food directly. Other gatherers carry up
 *         to 4 units to Cities.dropoff(...) and call Cities.deposit.
 *  EXPEDITIONS  Cities.step sends 3-5 adults (state 'settle', u.st = {target, parent, group, t0, eid}); on arrival every member
 *         calls Cities.foundExpedition(u). Registry: S.mod.cities.exps.
 *  HOMELESS     Cities.trySettle(u): join / found with >= 3 nearby homeless adults / return a {x,y} hint.
 *
 * Private persistent state: city.mod (plain data) and S.mod.cities = {exps:[...]}. Non-persistent caches: seekers, dirtyTerr.
 * ===================================================================== */

const Cities = (() => {
  const T = Const.T, B = Const.B, RES = Const.RES, GOODS = Const.GOODS;
  const LEVEL_POP = [0, 8, 18, 35, 60];     // pop needed for level 1..5
  const MAX_CITIES = 40;                    // soft cap for AI expansion
  const MIN_LAND = 9;                       // a village needs a landmass of at least this size
  const STALE_EXP = 1500;                   // ticks after which an expedition is abandoned
  const NJ = 10;                            // job kinds
  const J_BUILD = 0, J_FARM = 1, J_FORAGE = 2, J_FISH = 3, J_CHOP = 4, J_STONE = 5, J_IRON = 6, J_GOLD = 7, J_GUARD = 8, J_IDLE = 9;
  const NB = 8;                             // building type slots (1..7)

  let lastError = null;
  const seekers = new Map();                // homeless unit id -> last tick it asked trySettle (non-persistent)
  const dirtyTerr = new Set();              // city ids whose territory must be recomputed (land/water changed)
  const siteCache = new Map();              // coarse (race, cell) -> {t, site}
  const wScratch = new Float64Array(NJ);
  let destroying = false;

  // ------------------------------------------------------------------ small helpers
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function get(id) { return S.cities.get(id) || null; }
  function state() { return S.mod.cities || (S.mod.cities = { exps: [] }); }
  function rc(race) { return Races.list[race] || Races.list[0]; }
  function age(u) { return (S.tick - u.born) / Const.TICKS_PER_YEAR; }
  function isAdult(u) { return age(u) >= rc(u.race).maturity; }
  function isElder(u) { return age(u) > rc(u.race).lifespan[0] * 0.8; }
  function tileAt(x, y) { return (x < 0 || y < 0 || x >= S.w || y >= S.h) ? T.DEEP : S.tile[y * S.w + x]; }
  function isWaterT(t) { return t === T.DEEP || t === T.SHALLOW; }
  function jitter(x, y, salt) { return Util.hash2(x, y, salt) / 4294967296; }
  function fem(word) { return word === 'Деревня' ? 'а' : ''; }   // ending for "разрушен(а)"

  function initMod(c) {
    let m = c.mod;
    if (!m) m = c.mod = {};
    if (!m.init) {
      m.init = 1;
      m.c = { t: -999, tree: [], stone: [], iron: [], gold: [], berry: [], fish: [] };
      m.w = new Array(NJ).fill(0);
      m.sites = []; m.farms = []; m.drop = []; m.homes = [];
      m.bc = new Array(NB).fill(0); m.pc = new Array(NB).fill(0);
      m.hc = 0; m.pcap = 0; m.ns = 0; m.rem = 0;
      m.expCd = S.tick + 300; m.lastExp = S.tick; m.tr = 0; m.rel = 0; m.empty = 0; m.dw = 0; m.ds = 0; m.skip = {}; m.lvlLog = 1;
    }
    return m;
  }

  // ------------------------------------------------------------------ stock
  function stockCap(c) {
    const m = initMod(c);
    return 80 + 80 * m.ns + 20 * c.level;
  }
  function stock(cityId, good) {
    const c = S.cities.get(cityId);
    if (!c) return 0;
    if (good === undefined) return c.stock;
    const v = c.stock[good];
    return v > 0 ? v : 0;
  }
  function deposit(cityId, good, amt) {
    const c = S.cities.get(cityId);
    if (!c || !(amt > 0) || !(good in c.stock)) return 0;
    const cap = stockCap(c);
    const room = cap - c.stock[good];
    const add = amt < room ? amt : (room > 0 ? room : 0);
    if (add > 0) c.stock[good] += add;
    return add;
  }
  function withdraw(cityId, good, amt) {
    const c = S.cities.get(cityId);
    if (!c || !(amt > 0) || !(good in c.stock)) return 0;
    const have = c.stock[good];
    const take = amt < have ? amt : (have > 0 ? have : 0);
    if (take > 0) c.stock[good] = have - take;
    return take;
  }
  function affordable(c, cost, reserveWood) {
    for (let i = 0; i < GOODS.length; i++) {
      const g = GOODS[i], n = cost[g] || 0;
      if (n > 0 && c.stock[g] < n + (g === 'wood' ? (reserveWood || 0) : 0)) return false;
    }
    return true;
  }
  function pay(c, cost) { for (let i = 0; i < GOODS.length; i++) { const g = GOODS[i], n = cost[g] || 0; if (n > 0) c.stock[g] -= n; } }

  // ------------------------------------------------------------------ caches over the city's buildings
  /** Recount buildings: done / pending per type, open sites, farms, drop-off points, housing. O(buildings). */
  function recalc(c) {
    const m = initMod(c);
    if (!m.homes) m.homes = [];
    const bc = m.bc, pc = m.pc;
    for (let k = 0; k < NB; k++) { bc[k] = 0; pc[k] = 0; }
    m.sites.length = 0; m.farms.length = 0; m.drop.length = 0; m.homes.length = 0;
    let hc = 0, pcap = 0, rem = 0, ns = 0, wI = 0;
    const ids = c.buildings;
    for (let i = 0; i < ids.length; i++) {
      const b = S.buildings.get(ids[i]);
      if (!b) continue;
      ids[wI++] = ids[i];
      if (b.done) {
        bc[b.type]++;
        hc += Buildings.capOf(b);
        if (b.type === B.FARM) m.farms.push(b.id);
        else if (b.type === B.STORAGE) { ns++; m.drop.push(b.x, b.y); }
        else if (b.type === B.TOWNHALL) { m.drop.push(b.x, b.y); m.homes.push(b.x, b.y); }
        else if (b.type === B.HOUSE) m.homes.push(b.x, b.y);
      } else {
        pc[b.type]++;
        m.sites.push(b.id);
        rem += (1 - b.progress) * Buildings.defs[b.type].work;
        if (b.type === B.HOUSE) pcap += Buildings.HOUSE_CAP[0];
      }
    }
    ids.length = wI;
    m.hc = hc; m.pcap = pcap; m.ns = ns; m.rem = rem;
  }

  function housingCap(cityId) {
    const c = S.cities.get(cityId);
    if (!c) return 0;
    const m = initMod(c);
    return m.hc;
  }
  function housingFree(cityId) {
    const c = S.cities.get(cityId);
    if (!c) return 0;
    const f = initMod(c).hc - c.members.length;
    return f > 0 ? f : 0;
  }

  // ------------------------------------------------------------------ membership
  function addMember(cityId, u) {
    const c = S.cities.get(cityId);
    if (!c || !u) return false;
    if (u.cityId === cityId) {
      if (c.members.indexOf(u.id) < 0) c.members.push(u.id);
    } else {
      if (u.cityId) removeMember(u);
      c.members.push(u.id);
      u.job = null;
    }
    u.cityId = cityId;
    u.kingdomId = c.kingdomId;
    c.pop = c.members.length;
    seekers.delete(u.id);
    return true;
  }
  function removeMember(u) {
    if (!u) return false;
    const c = S.cities.get(u.cityId);
    if (c) {
      const k = c.members.indexOf(u.id);
      if (k >= 0) { const last = c.members.pop(); if (k < c.members.length) c.members[k] = last; }
      c.pop = c.members.length;
    }
    const had = u.cityId !== 0;
    u.cityId = 0; u.kingdomId = 0;
    if (had) u.job = null;
    return had;
  }
  function setKingdom(cityId, kid) {
    const c = S.cities.get(cityId);
    if (!c) return false;
    c.kingdomId = kid | 0;
    for (let i = 0; i < c.members.length; i++) { const u = S.units.get(c.members[i]); if (u) u.kingdomId = c.kingdomId; }
    S.touchOwner();
    return true;
  }
  function pruneMembers(c) {
    const m = c.members;
    let w = 0;
    for (let i = 0; i < m.length; i++) {
      const u = S.units.get(m[i]);
      if (u && u.cityId === c.id) m[w++] = m[i];
    }
    m.length = w;
    c.pop = w;
  }

  // ------------------------------------------------------------------ territory
  /** S.owner within radius = Races.cityRadius + level; nearest centre wins; land tiles only. */
  function recomputeTerritory(cityId, noNeighbours) {
    const c = S.cities.get(cityId);
    if (!c || !S.owner) return false;
    const m = initMod(c);
    const r = rc(c.race).cityRadius + c.level;
    const prev = m.tr || r;
    const R0 = Math.max(prev, r) + 1;
    c.radius = r; m.tr = r;
    const w = S.w, h = S.h, owner = S.owner, tile = S.tile, rr = r * r;
    const y0 = Math.max(0, c.y - R0), y1 = Math.min(h - 1, c.y + R0), x0 = Math.max(0, c.x - R0), x1 = Math.min(w - 1, c.x + R0);
    let changed = false, released = false;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        const dx = x - c.x, dy = y - c.y, d2 = dx * dx + dy * dy;
        const inside = d2 <= rr && Tiles.isLand(tile[i]);
        const o = owner[i];
        if (o === c.id) {
          if (!inside && !(S.bld[i] !== 0 && Tiles.isLand(tile[i]))) { owner[i] = 0; changed = true; released = true; }
        } else if (inside) {
          if (o === 0) { owner[i] = c.id; changed = true; continue; }
          const oc = S.cities.get(o);
          if (!oc) { owner[i] = c.id; changed = true; continue; }
          const ox = x - oc.x, oy = y - oc.y, od = ox * ox + oy * oy;
          if (d2 < od || (d2 === od && c.id < o)) { owner[i] = c.id; changed = true; }
        }
      }
    }
    if (changed) S.touchOwner();
    if (released && !noNeighbours) {
      for (const o of S.cities.values()) {
        if (o.id !== c.id && Math.abs(o.x - c.x) <= R0 + o.radius + 1 && Math.abs(o.y - c.y) <= R0 + o.radius + 1) recomputeTerritory(o.id, true);
      }
    }
    return changed;
  }
  function ownerAt(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.owner || x < 0 || y < 0 || x >= S.w || y >= S.h) return 0;
    return S.owner[y * S.w + x];
  }
  function cityAt(x, y) { const id = ownerAt(x, y); return id ? (S.cities.get(id) || null) : null; }

  // ------------------------------------------------------------------ sites
  function canFound(x, y, race) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.tile || !(x >= 1 && y >= 1 && x < S.w - 1 && y < S.h - 1)) return false;
    const i = y * S.w + x;
    const t = S.tile[i];
    if (!Tiles.isLand(t) || !Tiles.buildable(t)) return false;
    if (S.bld[i] || S.fire[i]) return false;
    const rk = S.res[i];
    if (rk && rk !== RES.BERRY) return false;
    const D2 = Const.CITY_MIN_DIST * Const.CITY_MIN_DIST;
    for (const c of S.cities.values()) {
      const dx = c.x - x, dy = c.y - y;
      if (dx * dx + dy * dy < D2) return false;
    }
    if (World.landSize(x, y) < MIN_LAND) return false;
    return true;
  }

  /** attractiveness of a village site for the race (higher is better; -99 = unusable) */
  function siteScore(race, x, y) {
    const hab = rc(race).habitat;
    let hs = 0, land = 0, build = 0, water = 0, forest = 0, mountain = 0, lava = 0;
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const t = tileAt(x + dx, y + dy);
        if (isWaterT(t)) { water++; continue; }
        if (t === T.LAVA) { lava++; continue; }
        land++;
        hs += hab[t] || 0;
        if (Tiles.buildable(t)) build++;
        if (t === T.FOREST) forest++;
        else if (t === T.MOUNTAIN || t === T.SNOW) mountain++;
      }
    }
    if (build < 14) return -99;
    // wood access matters to every race: sample a 15x15 neighbourhood (every other tile)
    let wood = 0;
    for (let dy = -7; dy <= 7; dy += 2) for (let dx = -7; dx <= 7; dx += 2) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= S.w || yy >= S.h) continue;
      const i = yy * S.w + xx;
      if (S.tile[i] === T.FOREST || S.res[i] === RES.TREE) wood++;
    }
    let sc = 4 * hs / 81 + 1.2 * Math.min(1, wood / 10);
    sc += 1.6 * (hab.nearWater || 0) * Math.min(1, water / 8);
    sc += 1.6 * (hab.nearForest || 0) * Math.min(1, forest / 10);
    sc += 1.4 * (hab.nearMountain || 0) * Math.min(1, mountain / 6);
    sc += 1.4 * (hab.nearLava || 0) * (lava > 0 ? 1 : 0);
    if (build < 40) sc -= (40 - build) * 0.05;
    return sc;
  }

  /**
   * Best site for a village with min <= distance <= max from (x,y) on the same landmass as (x,y).
   * opts: {anyScore} accept low-quality sites (founders on poor land must still succeed).
   */
  function findSiteRange(race, x, y, minR, maxR, opts) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.tile) return null;
    maxR = Math.min(maxR, S.w + S.h);
    const step = maxR > 16 ? 3 : 2;
    const anyScore = !!(opts && opts.anyScore);
    const min2 = minR * minR, max2 = maxR * maxR;
    const needLand = World.landId(x, y) > 0;          // an origin in deep water cannot share a landmass with anything
    let best = null, bs = -1e9;
    const consider = (xx, yy, step1) => {
      const dx = xx - x, dy = yy - y, d2 = dx * dx + dy * dy;
      if (d2 > max2 || d2 < min2) return;
      if (!canFound(xx, yy, race)) return;
      if (needLand && !World.sameLand(x, y, xx, yy)) return;
      let sc = siteScore(race, xx, yy);
      if (sc < -50 && !(anyScore && step1)) return;
      if (minR > 0) sc -= 0.03 * Math.abs(Math.sqrt(d2) - (minR + 8));
      else sc -= 0.02 * Math.sqrt(d2);
      if (S.owner[yy * S.w + xx] !== 0) sc -= 0.4;       // prefer unclaimed ground
      if (sc > bs) { bs = sc; best = { x: xx, y: yy, score: sc }; }
    };
    // coarse grid (offset by a hash so repeated queries do not always hit the same lattice)
    const off = Util.hash2(x, y, 7) % step;
    for (let yy = y - maxR + off; yy <= y + maxR; yy += step) {
      if (yy < 1 || yy >= S.h - 1) continue;
      for (let xx = x - maxR + off; xx <= x + maxR; xx += step) {
        if (xx < 1 || xx >= S.w - 1) continue;
        consider(xx, yy, false);
      }
    }
    if (best) {
      // refine locally around the best coarse sample
      const bx = best.x, by = best.y;
      for (let yy = by - step; yy <= by + step; yy++) for (let xx = bx - step; xx <= bx + step; xx++) if (xx !== bx || yy !== by) consider(xx, yy, false);
    } else if (anyScore) {
      for (let yy = y - maxR; yy <= y + maxR; yy++) for (let xx = x - maxR; xx <= x + maxR; xx++) consider(xx, yy, true);
    }
    return best;
  }
  function findSite(race, x, y, maxR) { return findSiteRange(race, x, y, 0, maxR > 0 ? maxR : 30, null); }

  // ------------------------------------------------------------------ founding
  function found(race, x, y, founders, opts) {
    opts = opts || {};
    x = Math.floor(x); y = Math.floor(y);
    if (!canFound(x, y, race)) return null;
    const id = S.id();
    const c = {
      id, name: opts.name || Names.place(race), race, kingdomId: 0, x, y, pop: 0, members: [],
      stock: { food: 12, wood: 20, stone: 4, iron: 0, gold: 0 },
      radius: rc(race).cityRadius + 1, level: 1, loyalty: 70, culture: 0, founded: S.tick, buildings: [], hist: [], mod: {},
    };
    S.cities.set(id, c);
    initMod(c);
    const th = Buildings.place(id, B.TOWNHALL, x, y, { instant: true });
    if (!th) { S.cities.delete(id); return null; }
    if (founders) {
      for (let i = 0; i < founders.length; i++) {
        const u = founders[i];
        if (!u) continue;
        addMember(id, u);
        if (u.state === 'settle' || u.state === 'wander' || u.state === 'walk') u.state = 'idle';
        u.st = {}; u.job = null;
      }
    }
    recalc(c);
    recomputeTerritory(id);
    const parent = opts.parentCityId ? S.cities.get(opts.parentCityId) : null;
    const k = Kingdoms.onCityFounded(c, parent ? parent.id : 0);
    if (k && typeof k === 'object' && k.id && c.kingdomId !== k.id) c.kingdomId = k.id;
    setKingdom(id, c.kingdomId);
    c.mod.expCd = S.tick + 350;
    Hist.add(c, parent ? 'Основан переселенцами из «' + parent.name + '»' : 'Основан');
    Log.add('Основана деревня «' + c.name + '»', Const.LOG.CITY, x, y, c.kingdomId);
    // first constructions: one house and one farm
    placeBuilding(c, B.HOUSE);
    placeBuilding(c, B.FARM);
    recalc(c);
    scanCands(c, c.mod);
    computeWeights(c, c.mod);       // jobs can be assigned right away
    Bus.emit('cityFounded', c);
    return c;
  }

  // ------------------------------------------------------------------ building placement
  /** pick a tile index for a new building of `type` around the city centre (or -1) */
  function findSpot(c, type) {
    const w = S.w, h = S.h, bld = S.bld, tile = S.tile, owner = S.owner;
    const maxR = Math.max(5, c.radius - 1);
    const radii = [6, 9, 12];
    for (let ri = 0; ri < radii.length; ri++) {
      const R0 = Math.min(radii[ri], maxR);
      let best = -1, bs = 1e9;
      for (let y = c.y - R0; y <= c.y + R0; y++) {
        if (y < 1 || y >= h - 1) continue;
        for (let x = c.x - R0; x <= c.x + R0; x++) {
          if (x < 1 || x >= w - 1) continue;
          const dx = x - c.x, dy = y - c.y, d2 = dx * dx + dy * dy;
          if (d2 < 4 || d2 > R0 * R0) continue;
          const i = y * w + x;
          if (bld[i] !== 0) continue;
          const o = owner[i];
          if (o !== 0 && o !== c.id) continue;
          if (bld[i - 1] || bld[i + 1] || bld[i - w] || bld[i + w]) continue;          // keep 1-tile walking lanes
          if (!World.isBuildable(x, y)) continue;
          const diag = (bld[i - w - 1] ? 1 : 0) + (bld[i - w + 1] ? 1 : 0) + (bld[i + w - 1] ? 1 : 0) + (bld[i + w + 1] ? 1 : 0);
          if (diag > 2) continue;
          const d = Math.sqrt(d2), jit = jitter(x, y, c.id);
          let sc;
          if (type === B.FARM) {
            let g = 0, wat = false;
            for (let ny = -1; ny <= 1; ny++) for (let nx = -1; nx <= 1; nx++) {
              if (!nx && !ny) continue;
              const t = tile[i + ny * w + nx];
              if (t === T.GRASS) g++;
              else if ((nx === 0 || ny === 0) && isWaterT(t)) wat = true;
            }
            sc = Math.abs(d - 4.5) * 0.6 - g * 0.3 - (wat ? 1.5 : 0) - Tiles.defs[tile[i]].fert * 1.5 + jit * 0.8 - Math.min(diag, 1) * 0.4;
          } else if (type === B.HOUSE) {
            sc = d + jit * 1.4 - 0.3 * Math.min(diag, 2) + (tile[i] === T.GRASS ? 0.25 : 0);
          } else if (type === B.STORAGE) {
            sc = d + jit * 0.6;
          } else {
            sc = Math.abs(d - 5) + jit * 1.5 - 0.3 * Math.min(diag, 2);
          }
          if (sc < bs && World.sameLand(c.x, c.y, x, y)) { bs = sc; best = i; }
        }
      }
      if (best >= 0) return best;
      if (R0 >= maxR) break;
    }
    return -1;
  }
  function placeBuilding(c, type) {
    if (type === B.TOWNHALL) {
      // re-build at the centre (or the closest free tile next to it)
      for (let r = 0; r <= 2; r++) {
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const b = Buildings.place(c.id, B.TOWNHALL, c.x + dx, c.y + dy, { cost: Buildings.TOWNHALL_REBUILD });
          if (b) return b;
        }
      }
      return null;
    }
    const i = findSpot(c, type);
    if (i < 0) return null;
    const y = (i / S.w) | 0, x = i - y * S.w;
    return Buildings.place(c.id, type, x, y);
  }

  /** decide the next construction of a city. At most one new site per visit. Sets m.dw / m.ds (deficits for labour weights). */
  function plan(c, m, tick) {
    m.dw = 0; m.ds = 0;
    const pop = c.pop;
    if (pop <= 0) return;
    const st = c.stock, bc = m.bc, pc = m.pc;
    // a destroyed town hall comes first
    if (bc[B.TOWNHALL] + pc[B.TOWNHALL] === 0) {
      const cost = Buildings.TOWNHALL_REBUILD;
      if (affordable(c, cost, 0)) placeBuilding(c, B.TOWNHALL);
      else { m.dw = Math.max(0, cost.wood - st.wood); m.ds = Math.max(0, cost.stone - st.stone); }
      return;
    }
    const maxOpen = c.level >= 3 ? 4 : c.level >= 2 ? 3 : 2;
    if (m.sites.length >= maxOpen) return;
    const free = m.hc + m.pcap - pop;
    const farmCount = bc[B.FARM] + pc[B.FARM];
    const want = [];
    const needHouse = free < 3 + Math.floor(pop * 0.15) && pc[B.HOUSE] < 2;
    const needFarm = farmCount < Math.max(1, Math.ceil(pop / 10)) && (farmCount < 1 || st.food < pop * 8 + 10) && pc[B.FARM] < 2;
    if (needFarm && st.food < pop * 3) { want.push(B.FARM); if (needHouse) want.push(B.HOUSE); }
    else { if (needHouse) want.push(B.HOUSE); if (needFarm) want.push(B.FARM); }
    if (pop >= 8 && bc[B.STORAGE] + pc[B.STORAGE] < 1 + Math.floor(pop / 30)) want.push(B.STORAGE);
    if (pop >= 12 && bc[B.BARRACKS] + pc[B.BARRACKS] < 1 + Math.floor(pop / 60)) want.push(B.BARRACKS);
    if (pop >= 20 && bc[B.TEMPLE] + pc[B.TEMPLE] < 1 + Math.floor(pop / 80)) want.push(B.TEMPLE);
    if (pop >= 30 && bc[B.MARKET] + pc[B.MARKET] < 1 + Math.floor(pop / 90)) want.push(B.MARKET);
    let deficitSet = false;
    for (let k = 0; k < want.length; k++) {
      const type = want[k];
      if (m.skip[type] && m.skip[type] > tick) continue;
      const cost = Buildings.defs[type].cost;
      if (affordable(c, cost, 0)) {
        if (placeBuilding(c, type)) { recalc(c); return; }
        m.skip[type] = tick + 300;                 // no room: try again later
        continue;
      }
      // not affordable: remember what is missing (the first one wins) unless it can never be obtained
      if ((cost.stone || 0) > st.stone && m.c.stone.length === 0) continue;
      if ((cost.wood || 0) > st.wood && m.c.tree.length === 0) continue;
      if (!deficitSet) { deficitSet = true; m.dw = Math.max(0, (cost.wood || 0) - st.wood); m.ds = Math.max(0, (cost.stone || 0) - st.stone); }
    }
  }

  /** bring building levels in line with the city level (houses pay a little wood, the rest is free) */
  function syncLevels(c, m) {
    const target = Math.min(3, c.level);
    let upgraded = 0;
    for (let i = 0; i < c.buildings.length; i++) {
      const b = S.buildings.get(c.buildings[i]);
      if (!b || !b.done || b.level >= target) continue;
      if (b.type === B.HOUSE) {
        if (upgraded < 1 && c.stock.wood >= 12 && Buildings.upgrade(b)) upgraded++;
      } else { b.level = target; S.markDirty(b.x, b.y); }
    }
    if (upgraded) recalc(c);
  }

  // ------------------------------------------------------------------ candidate resource tiles
  const CAP_TREE = 30, CAP_ORE = 12, CAP_BERRY = 14, CAP_FISH = 14;
  function scanCands(c, m) {
    const cd = m.c;
    cd.t = S.tick;
    const tree = [], stone = [], iron = [], gold = [], berry = [], fish = [];
    const w = S.w, h = S.h, tile = S.tile, res = S.res, amt = S.amt;
    const cx = c.x, cy = c.y;
    const MAXR = 22;
    let rr = 0;
    for (let r = 0; r <= MAXR; r++) {
      const y0 = cy - r, y1 = cy + r, x0 = cx - r, x1 = cx + r;
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= h) continue;
        const edge = (y === y0 || y === y1);
        const sx = edge ? 1 : (x1 - x0);
        for (let x = x0; x <= x1; x += sx) {
          if (x < 0 || x >= w) continue;
          const i = y * w + x;
          const t = tile[i];
          if (t === T.DEEP || t === T.SHALLOW || t === T.LAVA) continue;
          const rk = res[i];
          if (r <= 14 && tree.length < CAP_TREE && (t === T.FOREST || (rk === RES.TREE && amt[i] > 0))) {
            if (World.sameLand(cx, cy, x, y)) tree.push(i);
          } else if (rk === RES.ROCK || rk === RES.IRON || rk === RES.GOLD) {
            if (amt[i] > 0) {
              const L = rk === RES.ROCK ? stone : rk === RES.IRON ? iron : gold;
              if (L.length < CAP_ORE && World.sameLand(cx, cy, x, y)) L.push(i);
            }
          } else if (rk === RES.BERRY) {
            if (r <= 12 && berry.length < CAP_BERRY && amt[i] >= 5 && World.sameLand(cx, cy, x, y)) berry.push(i);
          }
          if (r <= 14 && fish.length < CAP_FISH && t !== T.FOREST && isFishSpot(i, x, y) && World.sameLand(cx, cy, x, y)) fish.push(i);
        }
      }
      rr = r;
      if (tree.length >= CAP_TREE && stone.length >= CAP_ORE && iron.length >= CAP_ORE && gold.length >= CAP_ORE && berry.length >= CAP_BERRY && fish.length >= CAP_FISH) break;
    }
    void rr;
    cd.tree = tree; cd.stone = stone; cd.iron = iron; cd.gold = gold; cd.berry = berry; cd.fish = fish;
  }
  function isFishSpot(i, x, y) {
    const tile = S.tile, w = S.w;
    return (x > 0 && tile[i - 1] === T.SHALLOW) || (x < w - 1 && tile[i + 1] === T.SHALLOW) ||
           (y > 0 && tile[i - w] === T.SHALLOW) || (y < S.h - 1 && tile[i + w] === T.SHALLOW);
  }
  // candidate kinds for validation
  const CK_TREE = 0, CK_STONE = 1, CK_IRON = 2, CK_GOLD = 3, CK_BERRY = 4, CK_FISH = 5;
  function candValid(kind, i) {
    switch (kind) {
      case CK_TREE: return S.tile[i] === T.FOREST || (S.res[i] === RES.TREE && S.amt[i] > 0);
      case CK_STONE: return S.res[i] === RES.ROCK && S.amt[i] > 0;
      case CK_IRON: return S.res[i] === RES.IRON && S.amt[i] > 0;
      case CK_GOLD: return S.res[i] === RES.GOLD && S.amt[i] > 0;
      case CK_BERRY: return S.res[i] === RES.BERRY && S.amt[i] >= 5;
      case CK_FISH: { const w = S.w, y = (i / w) | 0; return S.tile[i] !== T.FOREST && Tiles.isLand(S.tile[i]) && isFishSpot(i, i - y * w, y); }
    }
    return false;
  }
  /** random valid candidate, biased to the nearest ones (lists are nearest-first); stale entries are dropped. Returns tile index or -1. */
  function pickCand(list, kind) {
    for (let tries = 0; tries < 4 && list.length > 0; tries++) {
      const k = (R.f() * R.f() * list.length) | 0;
      const i = list[k];
      if (candValid(kind, i)) return i;
      list[k] = list[list.length - 1]; list.pop();
    }
    return -1;
  }

  // ------------------------------------------------------------------ labour weights & jobs
  function computeWeights(c, m) {
    const w = m.w, st = c.stock, pop = c.pop, cd = m.c, bc = m.bc;
    const cap = stockCap(c);
    // food first
    const F = st.food, r = F / (pop * 3 + 1);          // r < 1: food < pop*3 -> food jobs preferred, ever more strongly as the larder empties
    let fw;
    if (r >= 1) fw = r < 2 ? 0.5 - 0.38 * (r - 1) : 0.12;
    else { const u = 1 - r; fw = 0.5 + 8.5 * u * u; }  // 9 when empty
    if (F >= cap * 0.9 || r >= 6) fw = 0;
    const sf = m.farms.length ? 0.62 : 0, sb = cd.berry.length ? 0.24 : 0, sh = cd.fish.length ? 0.14 : 0;
    const ss = sf + sb + sh;
    w[J_FARM] = ss > 0 ? fw * sf / ss : 0;
    w[J_FORAGE] = ss > 0 ? fw * sb / ss : 0;
    w[J_FISH] = ss > 0 ? fw * sh / ss : 0;
    // construction
    w[J_BUILD] = m.sites.length ? Math.min(8, 1.5 + m.rem / 50) : 0;
    // materials
    const wishW = 14 + pop * 0.8 + m.dw;
    w[J_CHOP] = cd.tree.length && st.wood < cap * 0.95 && st.wood < wishW * 2.5 ? clamp(4.5 * (wishW - st.wood) / wishW, 0.2, 4.5) : 0;
    const wishS = 4 + m.ds;                            // mine only for what the planned buildings lack
    w[J_STONE] = cd.stone.length && st.stone < cap * 0.95 && st.stone < wishS * 3 ? clamp(2.5 * (wishS - st.stone) / wishS, 0.1, 2.5) : 0;
    const mil = bc[B.BARRACKS] > 0;                    // iron / gold only matter for gear, which needs a barracks
    const wishI = 6 + pop * 0.3;
    w[J_IRON] = cd.iron.length && mil && st.iron < cap * 0.95 && st.iron < wishI * 3 ? clamp(1.2 * (wishI - st.iron) / wishI, 0.05, 1.2) : 0;
    const wishG = 4 + pop * 0.1;
    w[J_GOLD] = cd.gold.length && mil && pop >= 20 && st.gold < cap * 0.95 && st.gold < wishG * 3 ? clamp(0.6 * (wishG - st.gold) / wishG, 0.03, 0.6) : 0;
    w[J_IDLE] = 0.35;
    // the garrison is a share of the labour (~12% with a barracks, ~4% without), never a sink when everything else is satisfied
    let others = 0;
    for (let k = 0; k < NJ; k++) if (k !== J_GUARD) others += w[k];
    w[J_GUARD] = pop >= 8 ? (mil ? 0.16 : 0.04) * others : 0;
  }

  function takeSlot(b, n, dur) {
    const d = b.data;
    let u = d.u;
    if (!u) u = d.u = [];
    for (let k = 0; k < n; k++) {
      if (!(u[k] > S.tick)) { u[k] = S.tick + dur; return true; }
    }
    return false;
  }
  function spotNear(cx, cy, r) {
    for (let k = 0; k < 4; k++) {
      const x = cx + R.int(-r, r), y = cy + R.int(-r, r);
      if (World.walkable(x, y) && !isWaterT(tileAt(x, y))) return { x, y };
    }
    return { x: cx, y: cy };
  }
  function idleJob(c) { const p = spotNear(c.x, c.y, 3); return { type: 'idle', x: p.x, y: p.y }; }
  function tileJob(type, i, kind) {
    const y = (i / S.w) | 0;
    const job = { type, x: i - y * S.w, y };
    if (kind) job.kind = kind;
    return job;
  }

  function makeJob(c, m, k) {
    const cd = m.c;
    switch (k) {
      case J_BUILD: {
        const s = m.sites;
        const farmFirst = m.bc[B.FARM] === 0 && c.stock.food < c.pop * 1.5;
        for (let pass = 0; pass < (farmFirst ? 2 : 1); pass++) {
          for (let q = 0; q < s.length; q++) {
            const b = S.buildings.get(s[q]);
            if (!b || b.done || (farmFirst && pass === 0 && b.type !== B.FARM)) continue;
            const slots = clamp(Math.ceil(Buildings.defs[b.type].work / 60), 2, 4);
            if (takeSlot(b, slots, 140)) return { type: 'build', x: b.x, y: b.y, buildingId: b.id };
          }
        }
        return null;
      }
      case J_FARM: {
        const f = m.farms; const n = f.length;
        if (!n) return null;
        const s0 = R.i(n);
        for (let q = 0; q < n; q++) {
          const b = S.buildings.get(f[(s0 + q) % n]);
          if (!b || !b.done) continue;
          if (takeSlot(b, 2, 90)) return { type: 'farm', x: b.x, y: b.y, buildingId: b.id };
        }
        return null;
      }
      case J_FORAGE: { const i = pickCand(cd.berry, CK_BERRY); return i < 0 ? null : tileJob('forage', i); }
      case J_FISH: { const i = pickCand(cd.fish, CK_FISH); return i < 0 ? null : tileJob('fish', i); }
      case J_CHOP: { const i = pickCand(cd.tree, CK_TREE); return i < 0 ? null : tileJob('chop', i); }
      case J_STONE: { const i = pickCand(cd.stone, CK_STONE); return i < 0 ? null : tileJob('mine', i, 'stone'); }
      case J_IRON: { const i = pickCand(cd.iron, CK_IRON); return i < 0 ? null : tileJob('mine', i, 'iron'); }
      case J_GOLD: { const i = pickCand(cd.gold, CK_GOLD); return i < 0 ? null : tileJob('mine', i, 'gold'); }
      case J_GUARD: {
        let bx = c.x, by = c.y;
        if (m.bc[B.BARRACKS] > 0 && R.chance(0.6)) {
          for (let q = 0; q < c.buildings.length; q++) {
            const b = S.buildings.get(c.buildings[q]);
            if (b && b.done && b.type === B.BARRACKS) { bx = b.x; by = b.y; break; }
          }
        }
        const p = spotNear(bx, by, 2);
        return { type: 'guard', x: p.x, y: p.y };
      }
      case J_IDLE: return idleJob(c);
    }
    return null;
  }

  function assignJob(u) {
    if (!u) return null;
    const c = S.cities.get(u.cityId);
    if (!c) return null;
    const m = initMod(c);
    if (!isAdult(u)) return idleJob(c);
    const w = wScratch, mw = m.w, cd = m.c;
    w[J_BUILD] = m.sites.length ? mw[J_BUILD] : 0;
    w[J_FARM] = m.farms.length ? mw[J_FARM] : 0;
    w[J_FORAGE] = cd.berry.length ? mw[J_FORAGE] : 0;
    w[J_FISH] = cd.fish.length ? mw[J_FISH] : 0;
    w[J_CHOP] = cd.tree.length ? mw[J_CHOP] : 0;
    w[J_STONE] = cd.stone.length ? mw[J_STONE] : 0;
    w[J_IRON] = cd.iron.length ? mw[J_IRON] : 0;
    w[J_GOLD] = cd.gold.length ? mw[J_GOLD] : 0;
    w[J_GUARD] = mw[J_GUARD];
    w[J_IDLE] = mw[J_IDLE] > 0 ? mw[J_IDLE] : 0.35;
    for (let attempt = 0; attempt < 5; attempt++) {
      let sum = 0;
      for (let k = 0; k < NJ; k++) sum += w[k];
      if (!(sum > 0)) break;
      let r = R.f() * sum, k = 0;
      for (; k < NJ - 1; k++) { r -= w[k]; if (r <= 0) break; }
      const job = makeJob(c, m, k);
      if (job) return job;
      w[k] = 0;
    }
    return idleJob(c);
  }

  function dropoff(cityId, x, y) {
    const c = S.cities.get(cityId);
    if (!c) return null;
    const d = initMod(c).drop;
    if (!d.length) return { x: c.x, y: c.y };
    let bx = c.x, by = c.y, bd = 1e12;
    for (let i = 0; i < d.length; i += 2) {
      const dx = d[i] - x, dy = d[i + 1] - y, dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; bx = d[i]; by = d[i + 1]; }
    }
    return { x: bx, y: by };
  }

  /** nearest finished house / town hall of the city to (x,y) -> {x,y} (where a unit can sleep) or null */
  function homeSpot(cityId, x, y) {
    const c = S.cities.get(cityId);
    if (!c) return null;
    const h = initMod(c).homes;
    if (!h || !h.length) return { x: c.x, y: c.y };
    let bx = c.x, by = c.y, bd = 1e12;
    for (let i = 0; i < h.length; i += 2) {
      const dx = h[i] - x, dy = h[i + 1] - y, dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; bx = h[i]; by = h[i + 1]; }
    }
    return { x: bx, y: by };
  }

  // ------------------------------------------------------------------ gear
  function outfit(cityId, u) {
    const c = S.cities.get(cityId);
    if (!c || !u) return false;
    const m = initMod(c);
    const maxTier = m.bc[B.BARRACKS] > 0 ? 3 : 1;
    let changed = false;
    for (let t = maxTier; t > (u.weapon | 0); t--) {
      const cost = Gear.weaponCost[t];
      if (affordable(c, cost, 12)) { pay(c, cost); u.weapon = t; changed = true; break; }
    }
    for (let t = maxTier; t > (u.armor | 0); t--) {
      const cost = Gear.armorCost[t];
      if (affordable(c, cost, 12)) { pay(c, cost); u.armor = t; changed = true; break; }
    }
    return changed;
  }

  // ------------------------------------------------------------------ expeditions
  function releaseUnit(u) { u.state = 'idle'; u.st = {}; u.job = null; }
  /** v is a living, homeless member of expedition `eid` */
  function isSettler(v, eid) { return !!v && !v.cityId && !!v.st && (v.st.eid | 0) === (eid | 0); }

  function launchExpedition(c, m, tick) {
    if (S.cities.size >= MAX_CITIES) return false;
    const stt = state();
    for (let i = 0; i < stt.exps.length; i++) if (stt.exps[i].parent === c.id) return false;   // one at a time
    const cand = [];
    for (let i = 0; i < c.members.length; i++) {
      const u = S.units.get(c.members[i]);
      if (!u || u.isRuler || u.armyId || u.state === 'settle' || u.state === 'army' || u.state === 'fight') continue;
      if (!isAdult(u) || isElder(u)) continue;
      cand.push(u);
    }
    if (cand.length < 3) return false;
    const site = findSiteRange(c.race, c.x, c.y, 12, 35, null);
    if (!site) { m.expCd = tick + 400; return false; }
    R.shuffle(cand);
    const n = clamp(Math.floor(c.pop / 4), 3, Math.min(5, cand.length));
    const group = [];
    // one man and one woman first (when available), then anyone
    const mi = cand.findIndex(u => u.sex === Const.SEX.M), fi = cand.findIndex(u => u.sex === Const.SEX.F);
    if (mi >= 0) group.push(cand[mi]);
    if (fi >= 0) group.push(cand[fi]);
    for (let i = 0; i < cand.length && group.length < n; i++) if (group.indexOf(cand[i]) < 0) group.push(cand[i]);
    const ids = group.map(u => u.id);
    const eid = S.id();
    stt.exps.push({ id: eid, parent: c.id, x: site.x, y: site.y, t0: tick, group: ids.slice() });
    for (let i = 0; i < group.length; i++) {
      const u = group[i];
      if (u.carry && u.carryAmt > 0) { deposit(c.id, u.carry, u.carryAmt); }
      u.carry = null; u.carryAmt = 0;
      removeMember(u);
      u.state = 'settle'; u.job = null;
      u.st = { target: { x: site.x, y: site.y }, parent: c.id, group: ids.slice(), t0: tick, eid };
    }
    m.expCd = tick + Math.round((700 + R.i(500)) / Math.max(0.3, rc(c.race).expansion));
    Hist.add(c, 'Отправил переселенцев');
    return true;
  }

  function maybeExpedition(c, m, tick) {
    if (tick < m.expCd) return;
    const pop = c.pop;
    if (pop < 14) return;
    const free = m.hc - pop;
    const crowded = free <= Math.max(2, Math.round(pop * 0.12)) || pop >= 24;
    if (!crowded) return;
    if (c.stock.food < pop * 4 + 8) return;
    launchExpedition(c, m, tick);
  }

  function removeExp(eid) {
    const e = state().exps;
    for (let i = 0; i < e.length; i++) if (e[i].id === eid) { e.splice(i, 1); return; }
  }

  /** a 'settle' expedition member arrived at u.st.target. Returns the founded / joined city or null. */
  function foundExpedition(u) {
    if (!u || u.cityId || !u.st || !u.st.target) return null;
    const st = u.st;
    // a late arriver joins the village its group already founded
    if (st.joinCity) {
      const c = S.cities.get(st.joinCity);
      if (c) { addMember(c.id, u); releaseUnit(u); return c; }
      releaseUnit(u); return null;
    }
    if (S.tick - st.t0 > STALE_EXP) { releaseUnit(u); return null; }
    const tx = st.target.x, ty = st.target.y;
    if (Util.dist(u.x, u.y, tx, ty) > 8) return null;
    if (!st.arr) st.arr = S.tick;
    const ids = st.group || [u.id];
    const present = [];
    let alive = 0;
    for (let i = 0; i < ids.length; i++) {
      const v = S.units.get(ids[i]);
      if (!isSettler(v, st.eid)) continue;
      alive++;
      if (Util.dist(v.x, v.y, tx, ty) <= 6.5) present.push(v);
    }
    if (present.indexOf(u) < 0) { present.push(u); if (alive < present.length) alive = present.length; }
    const waited = S.tick - st.arr;
    const need = Math.max(2, Math.ceil(alive * 0.6));
    if (present.length < need && !(waited > 300 && present.length >= 2)) {
      if (waited > 700) { for (let i = 0; i < present.length; i++) releaseUnit(present[i]); removeExp(st.eid); }
      return null;
    }
    // site still valid? otherwise re-pick close to the original target
    if (!canFound(tx, ty, u.race)) {
      st.retry = (st.retry || 0) + 1;
      const ns = st.retry <= 3 ? findSiteRange(u.race, tx, ty, 0, 9, { anyScore: true }) : null;
      if (!ns) {
        for (let i = 0; i < ids.length; i++) { const v = S.units.get(ids[i]); if (isSettler(v, st.eid)) releaseUnit(v); }
        removeExp(st.eid);
        return null;
      }
      for (let i = 0; i < ids.length; i++) {
        const v = S.units.get(ids[i]);
        if (isSettler(v, st.eid)) { v.st.target = { x: ns.x, y: ns.y }; v.st.retry = st.retry; v.st.arr = 0; }
      }
      const e = state().exps; for (let i = 0; i < e.length; i++) if (e[i].id === st.eid) { e[i].x = ns.x; e[i].y = ns.y; }
      return null;
    }
    const parent = S.cities.get(st.parent);
    const c = found(u.race, tx, ty, present, { parentCityId: parent ? parent.id : 0 });
    if (!c) return null;
    removeExp(st.eid);
    for (let i = 0; i < ids.length; i++) {
      const v = S.units.get(ids[i]);
      if (isSettler(v, st.eid)) v.st.joinCity = c.id;
    }
    return c;
  }

  // ------------------------------------------------------------------ homeless settling
  function eligibleSeeker(v, race) {
    return v && v.cityId === 0 && v.race === race && v.state !== 'settle' && !v.armyId && isAdult(v);
  }
  function bestJoin(u, maxD) {
    let best = null, bs = 1e9;
    if (!maxD) maxD = 30;
    for (const c of S.cities.values()) {
      if (c.race !== u.race && Races.rel[u.race][c.race] < 20) continue;
      if (housingFree(c.id) <= 0) continue;
      const d = Util.dist(u.x, u.y, c.x, c.y);
      if (d > maxD) continue;
      const sc = d - (c.race === u.race ? 6 : 0);
      if (sc < bs && World.sameLand(u.x, u.y, c.x, c.y)) { bs = sc; best = c; }
    }
    return best;
  }
  function landNear(x, y, ref) {
    x = Math.floor(x); y = Math.floor(y);
    for (let r = 0; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const xx = x + dx, yy = y + dy;
        if (!S.inBounds(xx, yy)) continue;
        const t = S.tile[yy * S.w + xx];
        if (Tiles.isLand(t) && World.sameLand(ref.x, ref.y, xx, yy)) return { x: xx, y: yy };
      }
    }
    return null;
  }

  function trySettle(u) {
    try { return trySettleImpl(u); } catch (e) { lastError = e; return null; }
  }
  function trySettleImpl(u) {
    if (!u || u.cityId || u.state === 'settle' || u.armyId) return null;
    if (!(u.x >= 0 && u.y >= 0)) return null;
    if (!isAdult(u)) return null;
    const race = u.race;
    // 1. join an existing city with free housing
    const j = bestJoin(u);
    if (j) {
      addMember(j.id, u);
      u.job = null; u.st = {};
      if (u.state !== 'army') u.state = 'idle';
      return null;
    }
    seekers.set(u.id, S.tick);
    // 2. found a village with the homeless adults of the same race standing close by
    const grp = [];
    let men = 0, women = 0, sx = 0, sy = 0, others = 0, ox = 0, oy = 0;
    for (const [id, t] of seekers) {
      if (S.tick - t > 240) continue;
      const v = S.units.get(id);
      if (!eligibleSeeker(v, race) || !World.sameLand(u.x, u.y, v.x, v.y)) continue;
      const d = Util.dist(u.x, u.y, v.x, v.y);
      if (d <= 6) {
        if (grp.length < 12) { grp.push(v); sx += v.x; sy += v.y; if (v.sex === Const.SEX.M) men++; else women++; }
      } else if (d <= 28) { others++; ox += v.x; oy += v.y; }
    }
    if (grp.indexOf(u) < 0) { grp.push(u); sx += u.x; sy += u.y; if (u.sex === Const.SEX.M) men++; else women++; }
    const n = grp.length;
    const enough = n >= 3 || (race === Const.RACE.ELF && n >= 2 && men >= 1 && women >= 1);
    if (enough) {
      const cx = sx / n, cy = sy / n;
      const fk = -1 - (race * 100000 + Math.floor(cx / 8) * 400 + Math.floor(cy / 8));   // negative cache: no room here
      const fe = siteCache.get(fk);
      if (!fe || S.tick - fe.t > 120) {
        const base = landNear(cx, cy, u) || { x: Math.floor(u.x), y: Math.floor(u.y) };
        let site = findSiteRange(race, base.x, base.y, 0, 9, { anyScore: false });
        if (!site) site = findSiteRange(race, base.x, base.y, 0, 14, { anyScore: true });
        if (site) {
          const c = found(race, site.x, site.y, grp, {});
          if (c) return null;
        }
        if (siteCache.size > 200) siteCache.clear();
        siteCache.set(fk, { t: S.tick, site: null });
      }
    }
    // 3. hint: gather with the other homeless of the race, else walk to a good site
    if (others > 0) {
      const mx = (sx + ox) / (n + others), my = (sy + oy) / (n + others);
      const p = landNear(mx, my, u);
      if (p && Util.dist(u.x, u.y, p.x, p.y) > 2.5) return p;
      return null;
    }
    const far = bestJoin(u, 80);                      // a friendly city with room, further away than the join range
    if (far) return { x: far.x, y: far.y };
    const key = race * 100000 + Math.floor(u.x / 8) * 400 + Math.floor(u.y / 8);
    let ent = siteCache.get(key);
    if (!ent || S.tick - ent.t > 150) {
      if (siteCache.size > 200) siteCache.clear();
      ent = { t: S.tick, site: findSiteRange(race, u.x, u.y, 0, 30, null) };
      siteCache.set(key, ent);
    }
    if (ent.site && canFound(ent.site.x, ent.site.y, race) && Util.dist(u.x, u.y, ent.site.x, ent.site.y) > 3) return { x: ent.site.x, y: ent.site.y };
    return null;
  }

  // ------------------------------------------------------------------ destruction / capture
  function destroy(cityId, cause) {
    const c = S.cities.get(cityId);
    if (!c) return false;
    destroying = true;
    const oldKid = c.kingdomId;
    const pop0 = c.members.length;
    // members become homeless
    for (let i = 0; i < c.members.length; i++) {
      const u = S.units.get(c.members[i]);
      if (!u || u.cityId !== c.id) continue;
      u.cityId = 0; u.kingdomId = 0; u.job = null;
      if (u.state !== 'army' && u.state !== 'fight' && u.state !== 'flee' && u.state !== 'settle') { u.state = 'idle'; u.st = {}; }
    }
    c.members.length = 0; c.pop = 0;
    // buildings
    const ids = c.buildings.slice();
    for (let i = 0; i < ids.length; i++) { const b = S.buildings.get(ids[i]); if (b) Buildings.destroy(b, 'city'); }
    c.buildings.length = 0;
    // territory
    const m = initMod(c);
    const R0 = Math.max(m.tr || 0, c.radius) + 2;
    for (let y = Math.max(0, c.y - R0); y <= Math.min(S.h - 1, c.y + R0); y++) {
      for (let x = Math.max(0, c.x - R0); x <= Math.min(S.w - 1, c.x + R0); x++) { const i = y * S.w + x; if (S.owner[i] === c.id) S.owner[i] = 0; }
    }
    S.cities.delete(c.id);
    dirtyTerr.delete(c.id);
    destroying = false;
    // neighbours reclaim the freed ground
    for (const o of S.cities.values()) {
      if (Math.abs(o.x - c.x) <= R0 + o.radius + 2 && Math.abs(o.y - c.y) <= R0 + o.radius + 2) recomputeTerritory(o.id, true);
    }
    S.touchOwner();
    if (oldKid) Kingdoms.onCityLost(c, oldKid);
    const word = Names.cityWord(pop0 > 0 ? pop0 : Math.max(1, c.pop));
    const msg = cause === 'abandoned'
      ? word + ' «' + c.name + '» опустел' + fem(word)
      : word + ' «' + c.name + '» разрушен' + fem(word);
    Log.add(msg, Const.LOG.CITY, c.x, c.y, oldKid);
    Fx.add('explosion', c.x + 0.5, c.y + 0.5, { ttl: 1.0, r: 2 });
    Bus.emit('cityDestroyed', c, cause);
    return true;
  }

  function capture(cityId, newKid, army) {
    const c = S.cities.get(cityId);
    if (!c) return false;
    const oldKid = c.kingdomId;
    if (oldKid === newKid) return false;
    const r = Kingdoms.transferCity(cityId, newKid, 'capture');
    if (r === false) return false;
    setKingdom(cityId, newKid);
    c.loyalty = 25;
    const m = initMod(c);
    // looting and battle damage
    for (let i = 0; i < GOODS.length; i++) c.stock[GOODS[i]] = Math.floor(c.stock[GOODS[i]] * 0.7);
    const ids = c.buildings.slice();
    for (let i = 0; i < ids.length; i++) {
      const b = S.buildings.get(ids[i]);
      if (!b) continue;
      if (b.type !== B.TOWNHALL && R.chance(0.08)) { Buildings.destroy(b, 'war'); continue; }
      if (R.chance(0.4)) { b.hp = Math.max(1, Math.floor(b.hp * R.between(0.3, 0.7))); b.data.hit = S.tick; }
    }
    recalc(c);
    m.expCd = S.tick + 600;
    const nk = Kingdoms.get(newKid);
    Hist.add(c, 'Захвачен' + (nk ? ' королевством «' + nk.name + '»' : ''));
    Log.add('Город «' + c.name + '» захвачен' + (nk ? ': «' + nk.name + '»' : ''), Const.LOG.WAR, c.x, c.y, newKid);
    Fx.add('explosion', c.x + 0.5, c.y + 0.5, { ttl: 0.9, r: 1.5 });
    S.touchOwner();
    Bus.emit('cityCaptured', c, oldKid, newKid);
    void army;
    return true;
  }

  // ------------------------------------------------------------------ per-city visit (every ~10 ticks, staggered)
  function levelFor(pop, cur) {
    let l = 1;
    for (let k = 1; k < 5; k++) if (pop >= LEVEL_POP[k]) l = k + 1;
    if (l < cur && pop >= LEVEL_POP[cur - 1] * 0.8) l = cur;      // hysteresis
    return l;
  }
  function setLevel(c, l) {
    const old = c.level;
    c.level = l;
    recomputeTerritory(c.id);
    if (l > old) {
      Hist.add(c, 'Достиг уровня ' + l);
      const m = initMod(c);
      if (l > m.lvlLog) {
        m.lvlLog = l;
        if (l === 2) Log.add('Деревня «' + c.name + '» выросла в посёлок', Const.LOG.CITY, c.x, c.y, c.kingdomId);
        else if (l === 4) Log.add('Посёлок «' + c.name + '» стал городом', Const.LOG.CITY, c.x, c.y, c.kingdomId);
        else if (l === 5) Log.add('Город «' + c.name + '» стал крупным городом', Const.LOG.CITY, c.x, c.y, c.kingdomId);
      }
    }
  }

  function visit(c, tick) {
    const m = initMod(c);
    pruneMembers(c);
    const pop = c.pop;
    if (pop === 0) {
      if (!m.empty) m.empty = tick;
      else if (tick - m.empty > 900) { return 'abandon'; }
    } else m.empty = 0;
    recalc(c);
    const lv = levelFor(pop, c.level);
    if (lv !== c.level) setLevel(c, lv);
    const sinceScan = tick - m.c.t;
    if (sinceScan >= 50 || (sinceScan >= 20 && (m.c.tree.length < 3 || (m.c.berry.length + m.c.fish.length + m.farms.length) === 0))) scanCands(c, m);
    if (pop > 0) {
      plan(c, m, tick);
      syncLevels(c, m);
      // stale sites that nobody ever worked on give their materials back
      if (m.sites.length) {
        for (let i = 0; i < m.sites.length; i++) {
          const b = S.buildings.get(m.sites[i]);
          if (b && b.progress === 0 && tick - b.born > 2400) { Buildings.cancel(b); recalc(c); break; }
        }
      }
    }
    computeWeights(c, m);
    // starvation relief: townsfolk gather a little emergency food so a hungry village shrinks gently instead of vanishing
    if (pop > 0 && c.stock.food < pop * 0.6) {
      m.rel += pop * 0.012;
      if (m.rel >= 1) { const n = Math.floor(m.rel); m.rel -= n; deposit(c.id, 'food', n); }
    }
    if (pop > 0 && tick - m.lastExp >= 50) { m.lastExp = tick; maybeExpedition(c, m, tick); }
    return null;
  }

  function maintenance(tick) {
    const stt = state();
    // stale / finished expeditions
    for (let i = stt.exps.length - 1; i >= 0; i--) {
      const e = stt.exps[i];
      let aliveSettlers = 0;
      for (let k = 0; k < e.group.length; k++) {
        const v = S.units.get(e.group[k]);
        if (isSettler(v, e.id)) aliveSettlers++;
      }
      if (tick - e.t0 > STALE_EXP) {
        for (let k = 0; k < e.group.length; k++) {
          const v = S.units.get(e.group[k]);
          if (isSettler(v, e.id)) releaseUnit(v);
        }
        stt.exps.splice(i, 1);
      } else if (aliveSettlers === 0) stt.exps.splice(i, 1);
    }
    // seekers
    for (const [id, t] of seekers) {
      const v = S.units.get(id);
      if (!v || v.cityId || tick - t > 400) seekers.delete(id);
    }
  }

  const pendingDestroy = [];
  function step(tick) {
    if (tick === undefined) tick = S.tick;
    for (const c of S.cities.values()) {
      if ((tick + c.id) % 10 !== 0) continue;
      if (visit(c, tick) === 'abandon') pendingDestroy.push(c.id);
    }
    if (pendingDestroy.length) { for (const id of pendingDestroy) destroy(id, 'abandoned'); pendingDestroy.length = 0; }
    if (dirtyTerr.size && tick % 10 === 3) {
      for (const id of dirtyTerr) recomputeTerritory(id);
      dirtyTerr.clear();
    }
    if (tick % 50 === 7) maintenance(tick);
  }

  // ------------------------------------------------------------------ events
  const DONE_LOG = { [B.TEMPLE]: 'построен храм', [B.MARKET]: 'построен рынок', [B.BARRACKS]: 'построены казармы' };
  Bus.on('buildingDone', b => {
    const c = S.cities.get(b.cityId);
    if (!c || destroying) return;
    recalc(c);
    if (DONE_LOG[b.type]) Log.add('В «' + c.name + '» ' + DONE_LOG[b.type], Const.LOG.CITY, b.x, b.y, c.kingdomId);
  });
  Bus.on('buildingChanged', b => { const c = S.cities.get(b.cityId); if (c && !destroying) recalc(c); });
  Bus.on('buildingDestroyed', b => { const c = S.cities.get(b.cityId); if (c && !destroying) recalc(c); });
  Bus.on('tileChanged', (x, y, o, n) => {
    if (!S.cities.size || Tiles.isLand(o) === Tiles.isLand(n)) return;
    for (const c of S.cities.values()) {
      const r = c.radius + 1;
      if (Math.abs(x - c.x) <= r && Math.abs(y - c.y) <= r) dirtyTerr.add(c.id);
    }
  });

  function resetCaches() { seekers.clear(); dirtyTerr.clear(); siteCache.clear(); destroying = false; }
  function newWorld() { resetCaches(); S.mod.cities = { exps: [] }; }
  function afterLoad() {
    resetCaches();
    state();
    for (const c of S.cities.values()) { initMod(c); recalc(c); }
  }

  return {
    get, step, newWorld, afterLoad,
    list() { return Array.from(S.cities.values()); },
    nearest(x, y, maxD, pred) {
      let best = null, bd = maxD > 0 ? maxD * maxD : 1e12;
      for (const c of S.cities.values()) {
        const dx = c.x - x, dy = c.y - y, d = dx * dx + dy * dy;
        if (d <= bd && (!pred || pred(c))) { bd = d; best = c; }
      }
      return best;
    },
    canFound, findSite, found, trySettle, foundExpedition, addMember, removeMember, setKingdom, assignJob, dropoff,
    deposit, withdraw, stock, housingCap, housingFree, outfit, recomputeTerritory, ownerAt, destroy, capture,
    // extras
    cityAt, findSiteRange, levelFor, stockCap, recalc, homeSpot,
    get lastError() { return lastError; },
    LEVEL_POP,
  };
})();
