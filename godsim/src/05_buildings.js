/* =====================================================================
 * 05_buildings.js — Buildings: definitions, placement, construction progress, damage, passive farm trickle, repairs
 * OWNER: Cities+Buildings agent. API: docs/CONTRACT.md §3 Buildings.
 *
 * Notes / conventions
 *  - A building is a plain JSON-safe object {id,type,cityId,x,y,hp,maxHp,progress,done,level,born,data}; S.bld holds its id per tile.
 *  - place() pays the cost up-front through Cities.stock/withdraw (all-or-nothing); instant sites (founder townhall) are free and done.
 *  - Construction: Buildings.work(b, amount) adds `amount / def.work` to b.progress; completion emits Bus 'buildingDone'.
 *  - b.data is the building's private scratch: u (worker-slot expiry ticks, used by Cities.assignJob), acc (passive farm output), hit (last damage tick).
 *  - Extras beyond the contract: capOf, farmYield, upgrade, cancel, count, siteAt helpers (see return object).
 * ===================================================================== */

const Buildings = (() => {
  const B = Const.B, T = Const.T, RES = Const.RES;
  const HOUSE_CAP = [4, 6, 8];          // housing by house level 1..3
  const TOWNHALL_CAP = 6;               // the founders live in the town hall
  const PASSIVE_FARM = 0.15;            // food per farm per 10 ticks (safety net only; farmers deposit real yields)

  const defs = {};
  function def(type, o) { defs[type] = Object.assign({ type, size: 1, cap: 0 }, o); }
  //            key         name         cost                         work  hp   flam
  def(B.HOUSE,    { key: 'house',    name: 'Дом',      cost: { wood: 8 },                    work: 120, hp: 40,  cap: 4, flam: 0.85 });
  def(B.FARM,     { key: 'farm',     name: 'Ферма',    cost: { wood: 5 },                    work: 90,  hp: 24,  flam: 0.7 });
  def(B.STORAGE,  { key: 'storage',  name: 'Склад',    cost: { wood: 12, stone: 4 },         work: 150, hp: 70,  flam: 0.6 });
  def(B.BARRACKS, { key: 'barracks', name: 'Казармы',  cost: { wood: 20, stone: 15 },        work: 300, hp: 130, flam: 0.5 });
  def(B.TOWNHALL, { key: 'townhall', name: 'Ратуша',   cost: {},                             work: 200, hp: 220, cap: TOWNHALL_CAP, flam: 0.45 });
  def(B.TEMPLE,   { key: 'temple',   name: 'Храм',     cost: { wood: 15, stone: 25 },        work: 400, hp: 140, flam: 0.3 });
  def(B.MARKET,   { key: 'market',   name: 'Рынок',    cost: { wood: 20, gold: 0, stone: 10 }, work: 300, hp: 70, flam: 0.6 });
  // cost of re-building a destroyed town hall (founders get the first one for free)
  const TOWNHALL_REBUILD = { wood: 15, stone: 5 };

  const GOODS = Const.GOODS;

  function get(id) { return S.buildings.get(id) || null; }
  function resolve(b) { return typeof b === 'number' ? (S.buildings.get(b) || null) : (b && S.buildings.get(b.id) === b ? b : null); }
  function at(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (!S.bld || x < 0 || y < 0 || x >= S.w || y >= S.h) return null;
    const id = S.bld[y * S.w + x];
    return id ? (S.buildings.get(id) || null) : null;
  }
  function byCity(cityId) {
    const c = S.cities.get(cityId);
    const out = [];
    if (!c) return out;
    for (let i = 0; i < c.buildings.length; i++) { const b = S.buildings.get(c.buildings[i]); if (b) out.push(b); }
    return out;
  }
  /** number of buildings of `type` in the city (doneOnly: only finished ones) */
  function count(cityId, type, doneOnly) {
    const c = S.cities.get(cityId); let n = 0;
    if (!c) return 0;
    for (let i = 0; i < c.buildings.length; i++) { const b = S.buildings.get(c.buildings[i]); if (b && b.type === type && (!doneOnly || b.done)) n++; }
    return n;
  }

  /** housing provided by a (finished) building */
  function capOf(b) {
    if (!b || !b.done) return 0;
    if (b.type === B.HOUSE) return HOUSE_CAP[Math.min(3, Math.max(1, b.level | 0)) - 1];
    if (b.type === B.TOWNHALL) return TOWNHALL_CAP;
    return 0;
  }

  function costOf(type, opts) { return (opts && opts.cost) || (defs[type] && defs[type].cost) || {}; }
  function canPay(cityId, cost) {
    for (let i = 0; i < GOODS.length; i++) {
      const g = GOODS[i], n = cost[g] || 0;
      if (n > 0 && !(Cities.stock(cityId, g) >= n)) return false;
    }
    return true;
  }

  function isPlaceable(type, x, y) {
    const i = y * S.w + x;
    if (World.isBuildable(x, y)) return true;
    // the town hall may replace a berry bush
    return type === B.TOWNHALL && S.res[i] === RES.BERRY && S.bld[i] === 0 && S.fire[i] === 0 && Tiles.buildable(S.tile[i]);
  }

  /** place a building (site). Returns the building or null. opts: {instant, cost}. */
  function place(cityId, type, x, y, opts) {
    opts = opts || {};
    const d = defs[type], city = S.cities.get(cityId);
    if (!d || !city || !S.tile) return null;
    x = Math.floor(x); y = Math.floor(y);
    if (!(x >= 0 && y >= 0 && x < S.w && y < S.h)) return null;
    if (!isPlaceable(type, x, y)) return null;
    const i = y * S.w + x;
    if (!opts.instant) {
      const o = S.owner[i];
      if (o !== 0 && o !== cityId) return null;
    }
    const cost = opts.instant ? null : costOf(type, opts);
    if (cost) {
      if (!canPay(cityId, cost)) return null;
      for (let k = 0; k < GOODS.length; k++) { const g = GOODS[k], n = cost[g] || 0; if (n > 0) Cities.withdraw(cityId, g, n); }
    }
    if (S.res[i] === RES.BERRY) { S.res[i] = 0; S.amt[i] = 0; }
    const done = !!opts.instant;
    const b = {
      id: S.id(), type, cityId, x, y,
      hp: done ? d.hp : Math.max(1, Math.floor(d.hp * 0.2)), maxHp: d.hp,
      progress: done ? 1 : 0, done, level: Math.max(1, Math.min(3, city.level | 0 || 1)), born: S.tick, data: {},
    };
    S.buildings.set(b.id, b);
    S.bld[i] = b.id;
    city.buildings.push(b.id);
    S.markDirty(x, y);
    if (done) Bus.emit('buildingDone', b);
    return b;
  }

  /** add construction work; returns true when the building has just been completed */
  function work(b, amount) {
    b = resolve(b);
    if (!b || b.done || !(amount > 0)) return false;
    const d = defs[b.type];
    b.progress += amount / d.work;
    if (b.progress >= 1) { finish(b); return true; }
    const hp = Math.floor(d.hp * (0.2 + 0.8 * b.progress));
    if (hp > b.hp) b.hp = hp;
    // repaint the scaffold every 1/8 progress
    if (((b.progress * 8) | 0) !== ((((b.progress - amount / d.work)) * 8) | 0)) S.markDirty(b.x, b.y);
    return false;
  }

  function finish(b) {
    b.progress = 1; b.done = true; b.hp = b.maxHp;
    S.markDirty(b.x, b.y);
    Fx.add('dust', b.x + 0.5, b.y + 0.5, { ttl: 0.7 });
    Bus.emit('buildingDone', b);
  }

  /** damage a building; returns true when it was destroyed */
  function damage(b, dmg, byKingdomId, cause) {
    b = resolve(b);
    if (!b || !(dmg > 0)) return false;
    b.hp -= dmg;
    b.data.hit = S.tick;
    if (b.hp <= 0) { destroy(b, cause || 'damage'); return true; }
    return false;
  }
  function damageAt(x, y, dmg, cause) {
    const b = at(x, y);
    return b ? damage(b, dmg, 0, cause) : false;
  }

  /** remove a building completely (unfinished sites refund nothing) */
  function destroy(b, cause) {
    b = resolve(b);
    if (!b) return false;
    S.buildings.delete(b.id);
    const i = b.y * S.w + b.x;
    if (S.bld[i] === b.id) S.bld[i] = 0;
    const city = S.cities.get(b.cityId);
    if (city) { const k = city.buildings.indexOf(b.id); if (k >= 0) city.buildings.splice(k, 1); }
    S.markDirty(b.x, b.y);
    if (b.done) Fx.add(cause === 'fire' ? 'ash' : 'smoke', b.x + 0.5, b.y + 0.5, { ttl: 1.0 });
    if (b.done && b.type === B.TOWNHALL && city && cause !== 'city') {
      Log.add('Ратуша города «' + city.name + '» разрушена', Const.LOG.CITY, b.x, b.y, city.kingdomId);
    }
    Bus.emit('buildingDestroyed', b, cause);
    return true;
  }
  function destroyAt(x, y, cause) {
    const b = at(x, y);
    return b ? destroy(b, cause) : false;
  }

  /** abort an unfinished site and refund its cost (used for stale sites) */
  function cancel(b) {
    b = resolve(b);
    if (!b || b.done) return false;
    const cost = costOf(b.type, null);
    destroy(b, 'cancel');
    for (let k = 0; k < GOODS.length; k++) { const g = GOODS[k], n = cost[g] || 0; if (n > 0) Cities.deposit(b.cityId, g, n); }
    return true;
  }

  /** upgrade a finished building one level (cheap: wood 2*newLevel). Returns true on success. */
  function upgrade(b) {
    b = resolve(b);
    if (!b || !b.done || b.level >= 3) return false;
    if (b.type === B.HOUSE) {
      const cost = 2 * (b.level + 1);
      if (!(Cities.stock(b.cityId, 'wood') >= cost)) return false;
      Cities.withdraw(b.cityId, 'wood', cost);
    }
    b.level++;
    S.markDirty(b.x, b.y);
    Bus.emit('buildingChanged', b);   // lets Cities refresh its housing caches
    return true;
  }

  /** food delivered by one farm work cycle (default 3; water / grass around raise it, sand / hills lower it) */
  function farmYield(b) {
    b = typeof b === 'number' ? get(b) : b;
    if (!b) return 3;
    const w = S.w, h = S.h, x = b.x, y = b.y;
    let y0 = 3, grass = 0, water = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const t = S.tile[ny * w + nx];
        if (t === T.GRASS) grass++;
        else if ((t === T.SHALLOW || t === T.DEEP) && (dx === 0 || dy === 0)) water = true;
      }
    }
    if (water) y0++;
    if (grass >= 5) y0++;
    const own = Tiles.defs[S.tile[y * w + x]];
    if (own && own.fert < 0.5) y0--;
    if (b.level >= 3) y0++;
    return y0 < 2 ? 2 : y0 > 6 ? 6 : y0;
  }

  function step(tick) {
    if (tick === undefined) tick = S.tick;
    if (tick % 10 !== 0) return;
    for (const b of S.buildings.values()) {
      if (!b.done) continue;
      if (b.type === B.FARM && S.fire[b.y * S.w + b.x] === 0) {
        const d = b.data;
        d.acc = (d.acc || 0) + PASSIVE_FARM * b.level;
        if (d.acc >= 1) { const n = Math.floor(d.acc); d.acc -= n; Cities.deposit(b.cityId, 'food', n); }
      }
      if (b.hp < b.maxHp && tick - (b.data.hit || -999) > 40) {
        b.hp = Math.min(b.maxHp, b.hp + Math.max(1, b.maxHp * 0.02));
      }
    }
  }

  return {
    defs, get, at, byCity, place, work, damage, damageAt, destroy, destroyAt, step,
    // extras
    capOf, farmYield, upgrade, cancel, count, canPay, costOf, TOWNHALL_REBUILD, HOUSE_CAP, TOWNHALL_CAP,
    newWorld() {}, afterLoad() {},
  };
})();
