/* =====================================================================
 * 08_kingdoms.js — STAGE-1 STUB (minimal but functional). Replaced by the full module in stage 2.
 * Keep the public API shape; see docs/CONTRACT.md §Kingdoms.
 * ===================================================================== */

const Kingdoms = (() => {
  function get(id) { return S.kingdoms.get(id) || null; }

  function newCulture(race) {
    const id = S.cultures.length;
    S.cultures.push({ id, name: 'Культура ' + (id + 1), color: Palette.culture[id % Palette.culture.length], race });
    return id;
  }

  function pickColor() {
    const usedC = new Set();
    for (const k of S.kingdoms.values()) usedC.add(k.color);
    for (const c of Palette.kingdom) if (!usedC.has(c)) return c;
    return Palette.kingdom[S.kingdoms.size % Palette.kingdom.length];
  }

  function randomFlag() {
    return { pattern: R.i(6), symbol: R.i(10), c1: pickColor(), c2: R.pick(['#ffffff', '#222222', '#f2c230', '#d0d0d0']), c3: R.pick(['#ffffff', '#111111', '#f2c230']) };
  }

  function create(race, capitalCity) {
    const id = S.id();
    const flag = randomFlag();
    const k = {
      id, name: Names.kingdom(race), race, color: flag.c1, flag, capitalId: capitalCity ? capitalCity.id : 0,
      rulerId: 0, cities: [], culture: newCulture(race), stability: 70, born: S.tick, alive: true, hist: [], clan: Names.clan(race),
    };
    S.kingdoms.set(id, k);
    Hist.add(k, 'Основано');
    S.touchOwner();
    Bus.emit('kingdomCreated', k);
    return k;
  }

  function addCity(k, city) {
    if (k.cities.indexOf(city.id) < 0) k.cities.push(city.id);
    city.kingdomId = k.id;
    if (!k.capitalId || !S.cities.has(k.capitalId)) k.capitalId = city.id;
    S.touchOwner();
  }

  function chooseRuler(k) {
    const cap = S.cities.get(k.capitalId);
    let best = null, bs = -1;
    for (const u of S.units.values()) {
      if (u.kingdomId !== k.id) continue;
      if (Util.age(u) < Races.list[u.race].maturity) continue;
      const sc = u.level * 3 + Util.age(u) * 0.1 + (cap && u.cityId === cap.id ? 5 : 0);
      if (sc > bs) { bs = sc; best = u; }
    }
    return best;
  }

  function setRuler(kid, u) {
    const k = get(kid); if (!k) return;
    const old = S.units.get(k.rulerId);
    if (old) old.isRuler = false;
    k.rulerId = u ? u.id : 0;
    if (u) {
      u.isRuler = true;
      Hist.add(u, Names.ruler(u.race, u.sex) + ' «' + k.name + '»');
      Hist.add(k, 'Правит ' + u.name);
      Bus.emit('kingCrowned', k, u);
    }
  }

  return {
    get, newCulture,
    ruler(kid) { const k = get(kid); return k ? (S.units.get(k.rulerId) || null) : null; },
    /** Called by Cities.found after the city object exists in S.cities. */
    onCityFounded(city, parentCityId) {
      let k = null;
      const parent = parentCityId ? S.cities.get(parentCityId) : null;
      if (parent && S.kingdoms.has(parent.kingdomId)) k = S.kingdoms.get(parent.kingdomId);
      if (!k) {
        // join nearest same-race kingdom within 28 tiles, else found a new one
        let bd = 28;
        for (const c of S.cities.values()) {
          if (c.id === city.id || !c.kingdomId) continue;
          const kk = S.kingdoms.get(c.kingdomId);
          if (!kk || kk.race !== city.race) continue;
          const d = Util.dist(c.x, c.y, city.x, city.y);
          if (d < bd) { bd = d; k = kk; }
        }
      }
      let created = false;
      if (!k) { k = create(city.race, city); created = true; }
      addCity(k, city);
      city.culture = k.culture;
      if (created || !S.units.has(k.rulerId)) { const r = chooseRuler(k); if (r) setRuler(k.id, r); }
      return k;
    },
    onCityLost(city, oldKid) {
      const k = get(oldKid); if (!k) return;
      const i = k.cities.indexOf(city.id); if (i >= 0) k.cities.splice(i, 1);
      if (k.capitalId === city.id) k.capitalId = k.cities[0] || 0;
      if (!k.cities.length) this.destroy(k.id, 'cities lost');
      S.touchOwner();
    },
    destroy(kid, cause) {
      const k = get(kid); if (!k) return;
      k.alive = false;
      S.kingdoms.delete(kid);
      for (const u of S.units.values()) { if (u.kingdomId === kid) u.kingdomId = 0; }
      Log.add('Королевство «' + k.name + '» пало', Const.LOG.KINGDOM, -1, -1, kid);
      Bus.emit('kingdomDestroyed', k);
      S.touchOwner();
    },
    setRuler,
    cities(kid) { const k = get(kid); return k ? k.cities.map(id => S.cities.get(id)).filter(Boolean) : []; },
    pop(kid) { let n = 0; for (const c of this.cities(kid)) n += c.pop || 0; return n; },
    ofUnit(u) { return u.kingdomId ? get(u.kingdomId) : null; },
    at(x, y) { const c = S.cities.get(S.owner[S.idx(x, y)]); return c ? get(c.kingdomId) : null; },
    transferCity(cityId, toKid, cause) {
      const c = S.cities.get(cityId); if (!c) return false;
      const old = get(c.kingdomId); if (old) this.onCityLost(c, old.id);
      const nk = get(toKid); if (!nk) return false;
      addCity(nk, c); c.culture = c.culture === undefined ? nk.culture : c.culture;
      for (const u of S.units.values()) if (u.cityId === c.id) u.kingdomId = nk.id;
      return true;
    },
    splitCity(cityId) {
      const c = S.cities.get(cityId); if (!c) return 0;
      const old = get(c.kingdomId);
      if (old && old.cities.length <= 1) return 0;
      if (old) this.onCityLost(c, old.id);
      const k = create(c.race, c);
      addCity(k, c); c.culture = k.culture;
      for (const u of S.units.values()) if (u.cityId === c.id) u.kingdomId = k.id;
      const r = chooseRuler(k); if (r) setRuler(k.id, r);
      return k.id;
    },
    annex() { return false; },
    rebel() { return 0; },
    step(tick) {
      if (tick % 30 !== 0) return;
      for (const k of S.kingdoms.values()) {
        if (!S.units.has(k.rulerId)) { const r = chooseRuler(k); if (r) setRuler(k.id, r); }
      }
    },
    newWorld() {}, afterLoad() {},
  };
})();
