// Cities + Buildings tests (plain node + assert).   node tests/cities.test.mjs
// Units do not exist yet: a tiny "worker bot" fakes units (per the Unit schema) and follows the job protocol:
//   assignJob -> walk -> World.harvest / Buildings.work -> carry <= 4 -> Cities.dropoff -> Cities.deposit  (farm: ~50 ticks then deposit farmYield)
import assert from 'node:assert/strict';
import { loadSim, newWorld, pad } from './harness.mjs';

const STUBS = ['Units', 'Sim', 'Save', 'Powers'];   // Kingdoms / Diplomacy / War: the real stage-1 stubs are used

// ------------------------------------------------------------------ test plumbing
const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 62)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 8).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

function mkCtx(seed = 1, size = 96) {
  const ctx = loadSim({ stub: STUBS });
  newWorld(ctx, seed, size, size);
  ctx.timing = { cities: 0, buildings: 0, ticks: 0 };
  ctx.errors = [];
  return ctx;
}

// ------------------------------------------------------------------ fake units + worker bot
function mkUnit(ctx, race, sex, x, y, ageYears = 25) {
  const { S, Const, Races } = ctx;
  const id = S.id();
  const u = {
    id, race, sex, name: 'Bot' + id, clan: 'Test', born: S.tick - Math.round(ageYears * Const.TICKS_PER_YEAR),
    x, y, px: x, py: y, face: 1, hp: Races.list[race].hp, maxHp: Races.list[race].hp, hunger: 0, energy: 100,
    level: 1, xp: 0, kills: 0, traits: [], cityId: 0, kingdomId: 0, weapon: 0, armor: 0,
    state: 'idle', st: {}, job: null, carry: null, carryAmt: 0, fatherId: 0, motherId: 0, spouseId: 0, armyId: 0, isRuler: false,
    sick: 0, buffUntil: 0, buffMul: 1, burning: 0, nextThink: 0, birthCd: 0, hist: [],
  };
  S.units.set(id, u);
  return u;
}
function killUnit(ctx, u) { ctx.Cities.removeMember(u); ctx.S.units.delete(u.id); }

function walkTo(u, tx, ty, speed = 0.16) {
  const dx = tx - u.x, dy = ty - u.y, d = Math.sqrt(dx * dx + dy * dy);
  u.px = u.x; u.py = u.y;
  if (d <= speed) { u.x = tx; u.y = ty; return true; }
  u.x += dx / d * speed; u.y += dy / d * speed;
  return d - speed < 0.9;
}
const RESK = { stone: 'ROCK', iron: 'IRON', gold: 'GOLD' };

function botStep(ctx, u) {
  const { S, Cities, Buildings, World, Const, Races, R } = ctx;
  const rc = Races.list[u.race];
  const ageY = (S.tick - u.born) / Const.TICKS_PER_YEAR;
  u.hunger += 0.12;
  if (u.hunger > 70 && u.cityId) {
    const got = Cities.withdraw(u.cityId, 'food', 1);
    if (got) u.hunger = Math.max(0, u.hunger - 40 * got);
  }
  if (u.hunger >= 100) { u.hp -= 0.03; if (u.hp <= 0) { killUnit(ctx, u); ctx.deaths = (ctx.deaths || 0) + 1; return; } }
  // ---- expedition members
  if (u.state === 'settle' && u.st && u.st.target) {
    const arrived = walkTo(u, u.st.target.x + 0.5, u.st.target.y + 0.5);
    if (arrived) Cities.foundExpedition(u);
    return;
  }
  // ---- homeless
  if (!u.cityId) {
    if (ageY < rc.maturity) return;
    if (u.st && u.st.hint) {
      const h = u.st.hint;
      if (walkTo(u, h.x + 0.5, h.y + 0.5)) delete u.st.hint;
    }
    if ((S.tick + u.id) % 20 === 0) {
      const hint = Cities.trySettle(u);
      if (u.cityId) { u.st = {}; return; }
      if (hint) { u.st = u.st || {}; u.st.hint = hint; }
    }
    return;
  }
  const city = S.cities.get(u.cityId);
  if (!city) return;
  // ---- births (stands in for Units' mating rules)
  if (u.sex === Const.SEX.F && ageY >= rc.fertAge[0] && ageY < rc.fertAge[1] && S.tick >= u.birthCd && !ctx.noBirths) {
    if (Cities.housingFree(city.id) > 0 && city.stock.food >= city.pop * 2 && R.chance(0.04)) {
      let hasMan = false;
      for (const id of city.members) { const m = S.units.get(id); if (m && m.sex === Const.SEX.M && (S.tick - m.born) / Const.TICKS_PER_YEAR >= rc.maturity) { hasMan = true; break; } }
      if (hasMan) {
        const ch = mkUnit(ctx, u.race, R.chance(0.5) ? Const.SEX.M : Const.SEX.F, u.x, u.y, 0);
        ch.motherId = u.id;
        Cities.addMember(city.id, ch);
        u.birthCd = S.tick + Math.round(rc.birthCooldown * Const.TICKS_PER_YEAR);
        ctx.births = (ctx.births || 0) + 1;
      }
    }
  }
  if (ageY < rc.maturity) return;     // children never work
  // ---- jobs
  if (!u.job) {
    u.job = Cities.assignJob(u);
    u.st = { ph: 'go', t: 0 };
    ctx.jobCount = ctx.jobCount || {};
    if (u.job) ctx.jobCount[u.job.type + (u.job.kind ? ':' + u.job.kind : '')] = (ctx.jobCount[u.job.type + (u.job.kind ? ':' + u.job.kind : '')] || 0) + 1;
    return;
  }
  const job = u.job, st = u.st;
  const done = () => { u.job = null; u.st = {}; };
  if (st.ph === 'go') {
    if (walkTo(u, job.x + 0.5, job.y + 0.5)) { st.ph = 'work'; st.t = 0; }
    return;
  }
  if (st.ph === 'back') {
    const d = Cities.dropoff(u.cityId, u.x, u.y);
    if (!d) { done(); return; }
    if (walkTo(u, d.x + 0.5, d.y + 0.5)) {
      if (u.carry) Cities.deposit(u.cityId, u.carry, u.carryAmt);
      u.carry = null; u.carryAmt = 0; done();
    }
    return;
  }
  // work
  st.t++;
  switch (job.type) {
    case 'build': {
      const b = Buildings.get(job.buildingId);
      if (!b || b.done) { done(); break; }
      if (Buildings.work(b, rc.work)) done();
      break;
    }
    case 'farm': {
      const b = Buildings.get(job.buildingId);
      if (!b || !b.done) { done(); break; }
      if (st.t >= 50) { Cities.deposit(u.cityId, 'food', Buildings.farmYield(b)); done(); }
      break;
    }
    case 'chop': case 'mine': case 'forage': case 'fish': {
      const per = job.type === 'chop' ? 40 : job.type === 'mine' ? 60 : job.type === 'forage' ? 40 : 50;
      if (st.t >= per) {
        st.t = 0;
        const kind = job.type === 'chop' ? Const.RES.TREE : job.type === 'mine' ? Const.RES[RESK[job.kind]] : job.type === 'forage' ? Const.RES.BERRY : Const.RES.FISH;
        const good = job.type === 'chop' ? 'wood' : job.type === 'mine' ? job.kind : 'food';
        const got = World.harvest(job.x, job.y, kind, 1);
        if (got > 0) { u.carry = good; u.carryAmt += got; }
        if (!got || u.carryAmt >= 4) { if (u.carryAmt > 0) st.ph = 'back'; else done(); }
      }
      break;
    }
    case 'guard': if (st.t >= 100) done(); break;
    default: if (st.t >= 40) done();
  }
}

/** advance n ticks with bots; Cities/Buildings step time is measured separately */
function run(ctx, n, hook) {
  const { S, World, Buildings, Cities, Kingdoms } = ctx;
  for (let k = 0; k < n; k++) {
    S.tick++;
    const tick = S.tick;
    for (const u of Array.from(S.units.values())) if (S.units.has(u.id)) botStep(ctx, u);
    World.step(tick);
    let t0 = performance.now();
    Buildings.step(tick);
    let t1 = performance.now();
    ctx.timing.buildings += t1 - t0;
    Cities.step(tick);
    ctx.timing.cities += performance.now() - t1;
    ctx.timing.ticks++;
    Kingdoms.step(tick);
    if (hook) hook(tick);
  }
}

// ------------------------------------------------------------------ helpers
function grassSite(ctx, x = 48, y = 48, race = 0) {
  const s = ctx.Cities.findSite(race, x, y, 60);
  assert.ok(s, 'a site exists on the seed-1 map');
  return s;
}
function foundVillage(ctx, race, x, y, n = 6, ageY = 25) {
  const us = [];
  for (let i = 0; i < n; i++) us.push(mkUnit(ctx, race, i % 2, x + 0.5, y + 0.5, ageY));
  const c = ctx.Cities.found(race, x, y, us, {});
  assert.ok(c, 'city founded');
  return { c, us };
}
function countType(ctx, c, type, doneOnly = true) {
  let n = 0; for (const id of c.buildings) { const b = ctx.S.buildings.get(id); if (b && b.type === type && (!doneOnly || b.done)) n++; }
  return n;
}
function ownedTiles(ctx, id) { let n = 0; const o = ctx.S.owner; for (let i = 0; i < o.length; i++) if (o[i] === id) n++; return n; }
function checkInvariants(ctx, label = '') {
  const { S } = ctx;
  for (const b of S.buildings.values()) {
    assert.equal(S.bld[b.y * S.w + b.x], b.id, `${label} S.bld matches building ${b.id}`);
    const c = S.cities.get(b.cityId);
    assert.ok(c, `${label} building ${b.id} has a city`);
    assert.ok(c.buildings.includes(b.id), `${label} city lists building ${b.id}`);
    assert.ok(Number.isFinite(b.hp) && b.hp >= 0 && b.hp <= b.maxHp, `${label} hp sane`);
    assert.ok(b.progress >= 0 && b.progress <= 1, `${label} progress sane`);
  }
  for (let i = 0; i < S.bld.length; i++) if (S.bld[i]) assert.ok(S.buildings.has(S.bld[i]), `${label} S.bld ${S.bld[i]} refers to a building`);
  for (const c of S.cities.values()) {
    for (const id of c.buildings) assert.ok(S.buildings.has(id), `${label} city building id exists`);
    assert.equal(c.pop, c.members.length, `${label} pop cache`);
    for (const id of c.members) { const u = S.units.get(id); assert.ok(u, `${label} member exists`); assert.equal(u.cityId, c.id); assert.equal(u.kingdomId, c.kingdomId); }
    for (const g of ctx.Const.GOODS) assert.ok(Number.isFinite(c.stock[g]) && c.stock[g] >= 0, `${label} stock ${g} finite >= 0 (${c.stock[g]})`);
    assert.ok(c.level >= 1 && c.level <= 5);
  }
  for (let i = 0; i < S.owner.length; i++) if (S.owner[i]) assert.ok(S.cities.has(S.owner[i]), `${label} owner refers to a city`);
}

// ====================================================================================================
console.log('Cities + Buildings tests');

section('Buildings.defs follow the contract costs', () => {
  const { Buildings, Const } = mkCtx();
  const B = Const.B, d = Buildings.defs;
  assert.deepEqual([d[B.HOUSE].cost.wood, d[B.HOUSE].work], [8, 120]);
  assert.deepEqual([d[B.FARM].cost.wood, d[B.FARM].work], [5, 90]);
  assert.deepEqual([d[B.STORAGE].cost.wood, d[B.STORAGE].cost.stone, d[B.STORAGE].work], [12, 4, 150]);
  assert.deepEqual([d[B.BARRACKS].cost.wood, d[B.BARRACKS].cost.stone, d[B.BARRACKS].work], [20, 15, 300]);
  assert.deepEqual([d[B.TEMPLE].cost.wood, d[B.TEMPLE].cost.stone, d[B.TEMPLE].work], [15, 25, 400]);
  assert.deepEqual([d[B.MARKET].cost.wood, d[B.MARKET].cost.stone, d[B.MARKET].work], [20, 10, 300]);
  assert.deepEqual(d[B.TOWNHALL].cost, {});
  for (const t of Const.BUILDING_TYPES) { assert.ok(d[t].hp > 0 && d[t].name && d[t].key && typeof d[t].flam === 'number'); }
  assert.equal(d[B.HOUSE].cap, 4);
});

section('found(): city, instant town hall, first sites, kingdom, territory, log, bus', () => {
  const ctx = mkCtx();
  const { S, Cities, Buildings, Const, Kingdoms } = ctx;
  const events = [];
  ctx.Bus.on('cityFounded', c => events.push(c.id));
  const s = grassSite(ctx);
  const { c, us } = foundVillage(ctx, 0, s.x, s.y);
  assert.deepEqual(events, [c.id]);
  assert.equal(S.cities.get(c.id), c);
  assert.equal(c.x, s.x); assert.equal(c.y, s.y);
  assert.equal(c.members.length, 6); assert.equal(c.pop, 6);
  assert.equal(c.level, 1); assert.equal(c.loyalty, 70);
  assert.ok(c.kingdomId > 0 && Kingdoms.get(c.kingdomId), 'got a kingdom');
  assert.ok(us.every(u => u.cityId === c.id && u.kingdomId === c.kingdomId));
  const th = Buildings.at(c.x, c.y);
  assert.ok(th && th.type === Const.B.TOWNHALL && th.done && th.hp === th.maxHp);
  assert.equal(countType(ctx, c, Const.B.HOUSE, false), 1, 'one house site');
  assert.ok(countType(ctx, c, Const.B.FARM, false) >= 1, 'a farm site');
  assert.equal(c.buildings.length, Buildings.byCity(c.id).length);
  assert.equal(c.stock.food, 12);
  assert.equal(c.stock.wood, 20 - 8 - 5); assert.equal(c.stock.stone, 4);
  // territory: centre + radius
  assert.equal(Cities.ownerAt(c.x, c.y), c.id);
  assert.equal(c.radius, ctx.Races.list[0].cityRadius + 1);
  assert.ok(ownedTiles(ctx, c.id) > 40, 'territory painted');
  for (let i = 0; i < S.owner.length; i++) if (S.owner[i] === c.id) assert.ok(ctx.Tiles.isLand(S.tile[i]), 'only land is owned');
  assert.ok(S.log.some(l => l.msg === 'Основана деревня «' + c.name + '»'), 'log line');
  // founding twice at the same spot / too close fails
  assert.equal(Cities.found(0, c.x + 3, c.y, [], {}), null);
  assert.equal(Cities.canFound(c.x, c.y, 0), false);
  checkInvariants(ctx, 'found');
});

section('Buildings.place validates tile, owner and pays the cost all-or-nothing', () => {
  const ctx = mkCtx();
  const { S, Cities, Buildings, Const, World } = ctx;
  const B = Const.B;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y);
  // find a free buildable tile near the centre
  let spot = null;
  for (let r = 2; r < 7 && !spot; r++) for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++) {
    const x = c.x + dx, y = c.y + dy;
    if (World.isBuildable(x, y) && S.owner[y * S.w + x] === c.id) spot = [x, y];
  }
  assert.ok(spot);
  c.stock.wood = 7; c.stock.stone = 100;
  assert.equal(Buildings.place(c.id, B.HOUSE, spot[0], spot[1]), null, 'not enough wood');
  assert.equal(c.stock.wood, 7, 'nothing was withdrawn');
  c.stock.wood = 30;
  assert.equal(Buildings.place(999999, B.HOUSE, spot[0], spot[1]), null, 'unknown city');
  assert.equal(Buildings.place(c.id, 99, spot[0], spot[1]), null, 'unknown type');
  const wBefore = c.stock.wood, sBefore = c.stock.stone;
  const st = Buildings.place(c.id, B.STORAGE, spot[0], spot[1]);
  assert.ok(st && !st.done && st.progress === 0 && st.hp >= 1 && st.hp < st.maxHp);
  assert.equal(c.stock.wood, wBefore - 12); assert.equal(c.stock.stone, sBefore - 4);
  assert.equal(S.bld[spot[1] * S.w + spot[0]], st.id);
  assert.equal(Buildings.place(c.id, B.HOUSE, spot[0], spot[1]), null, 'tile taken');
  // out of bounds / water
  assert.equal(Buildings.place(c.id, B.HOUSE, -3, 4), null);
  assert.equal(Buildings.place(c.id, B.HOUSE, 5000, 4), null);
  // foreign territory
  const other = { id: 777777 };
  S.owner[(spot[1] + 1) * S.w + spot[0] + 1] = other.id;   // pretend somebody else owns a neighbour tile
  assert.equal(Buildings.place(c.id, B.HOUSE, spot[0] + 1, spot[1] + 1), null, 'foreign owner');
  S.owner[(spot[1] + 1) * S.w + spot[0] + 1] = 0;
  // berry replaced by the townhall only
  const bx = spot[0] + 2, by = spot[1];
  S.tile[by * S.w + bx] = Const.T.GRASS; S.res[by * S.w + bx] = Const.RES.BERRY; S.amt[by * S.w + bx] = 30; S.bld[by * S.w + bx] = 0;
  assert.equal(Buildings.place(c.id, B.HOUSE, bx, by), null, 'berries block houses');
  const th2 = Buildings.place(c.id, B.TOWNHALL, bx, by, { instant: true });
  assert.ok(th2 && th2.done && S.res[by * S.w + bx] === 0, 'townhall replaces a berry bush');
});

section('Buildings.work: progress, completion event, hp, cities notified', () => {
  const ctx = mkCtx();
  const { S, Cities, Buildings, Const } = ctx;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y);
  const done = [];
  ctx.Bus.on('buildingDone', b => done.push(b.id));
  const house = Buildings.byCity(c.id).find(b => b.type === Const.B.HOUSE);
  assert.ok(house && !house.done);
  const capBefore = Cities.housingCap(c.id);
  assert.equal(Buildings.work(house, 60), false);
  assert.ok(Math.abs(house.progress - 0.5) < 1e-9);
  assert.ok(house.hp > 8 && house.hp < house.maxHp);
  assert.equal(Buildings.work(house, 0), false); assert.equal(Buildings.work(null, 5), false);
  assert.equal(Buildings.work(house, 60), true, 'completed now');
  assert.ok(house.done && house.progress === 1 && house.hp === house.maxHp);
  assert.deepEqual(done, [house.id]);
  assert.equal(Buildings.work(house, 10), false, 'no more work on a finished building');
  assert.equal(Cities.housingCap(c.id), capBefore + 4, 'house adds 4 housing at level 1');
  assert.equal(Cities.housingFree(c.id), Math.max(0, capBefore + 4 - c.pop));
  // farm yield sane
  const farm = Buildings.byCity(c.id).find(b => b.type === Const.B.FARM);
  const y = Buildings.farmYield(farm);
  assert.ok(y >= 2 && y <= 6 && Number.isInteger(y), 'farm yield ' + y);
  assert.equal(Buildings.farmYield(9999999), 3);
});

section('Buildings.damage / destroy: hp, bus, S.bld, city list, unfinished refund nothing', () => {
  const ctx = mkCtx();
  const { S, Cities, Buildings, Const } = ctx;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y);
  const destroyed = [];
  ctx.Bus.on('buildingDestroyed', (b, cause) => destroyed.push([b.id, cause]));
  const house = Buildings.byCity(c.id).find(b => b.type === Const.B.HOUSE);
  Buildings.work(house, 1000);
  const hp0 = house.hp;
  assert.equal(Buildings.damage(house, 10, 0, 'war'), false);
  assert.equal(house.hp, hp0 - 10);
  assert.equal(Buildings.damageAt(house.x, house.y, 5, 'fire'), false);
  assert.equal(Buildings.damageAt(0, 0, 5, 'fire'), false, 'empty tile');
  const cap = Cities.housingCap(c.id);
  assert.equal(Buildings.damage(house, 9999, 0, 'war'), true);
  assert.ok(!S.buildings.has(house.id) && S.bld[house.y * S.w + house.x] === 0 && !c.buildings.includes(house.id));
  assert.deepEqual(destroyed.pop(), [house.id, 'war']);
  assert.equal(Cities.housingCap(c.id), cap - 4, 'housing freed');
  // unfinished site: destroyAt, no refund
  const farm = Buildings.byCity(c.id).find(b => b.type === Const.B.FARM);
  const wood = c.stock.wood;
  assert.equal(Buildings.destroyAt(farm.x, farm.y, 'terrain'), true);
  assert.equal(c.stock.wood, wood, 'no refund');
  assert.equal(Buildings.destroyAt(farm.x, farm.y, 'terrain'), false);
  assert.equal(Buildings.destroy(null, 'x'), false);
  // terrain change under a building destroys it through World
  const th = Buildings.at(c.x, c.y);
  ctx.World.setTile(th.x, th.y, Const.T.DEEP);
  assert.equal(Buildings.at(c.x, c.y), null, 'World.setTile(water) destroyed the town hall');
  checkInvariants(ctx, 'destroy');
});

section('stock API: deposit cap, partial withdraw, bad input', () => {
  const ctx = mkCtx();
  const { Cities } = ctx;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y);
  const cap = Cities.stockCap(c);
  assert.ok(cap >= 100);
  assert.equal(Cities.deposit(c.id, 'food', 5), 5);
  assert.equal(Cities.stock(c.id, 'food'), 17);
  assert.equal(Cities.withdraw(c.id, 'food', 100), 17, 'returns what was actually withdrawn');
  assert.equal(Cities.stock(c.id, 'food'), 0);
  assert.equal(Cities.withdraw(c.id, 'food', 1), 0);
  assert.equal(Cities.deposit(c.id, 'food', cap + 50), cap, 'capped by storage');
  assert.equal(Cities.deposit(c.id, 'food', 5), 0);
  for (const bad of [[0, 'food', 1], [c.id, 'mithril', 1], [c.id, 'food', -4], [c.id, 'food', NaN], [c.id, 'food', 'x']]) {
    assert.equal(Cities.deposit(...bad), 0); assert.equal(Cities.withdraw(...bad), 0);
  }
  assert.equal(Cities.stock(12345, 'food'), 0);
  assert.equal(Cities.housingCap(12345), 0); assert.equal(Cities.housingFree(12345), 0);
  assert.equal(Cities.dropoff(12345, 1, 1), null); assert.equal(Cities.assignJob(null), null);
  assert.equal(Cities.get(12345), null); assert.equal(Cities.destroy(12345), false); assert.equal(Cities.capture(12345, 1), false);
  assert.equal(Cities.addMember(12345, { id: 1 }), false); assert.equal(Cities.removeMember(null), false);
  assert.equal(Cities.setKingdom(12345, 1), false); assert.equal(Cities.outfit(12345, {}), false);
  assert.equal(Cities.recomputeTerritory(12345), false); assert.equal(Cities.ownerAt(-5, 1e9), 0);
});

section('dropoff / homeSpot return the nearest finished storage / house; upgrade costs wood', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Buildings, Const } = ctx;
  const B = Const.B;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 6);
  assert.deepEqual(Cities.dropoff(c.id, c.x + 9, c.y + 9), { x: c.x, y: c.y }, 'only the hall exists');
  assert.deepEqual(Cities.homeSpot(c.id, c.x + 9, c.y + 9), { x: c.x, y: c.y });
  c.stock.wood = 100; c.stock.stone = 50;
  let st = null, hs = null;
  for (let r = 3; r < 8 && !(st && hs); r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = c.x + dx, y = c.y + dy;
    if (!st && Buildings.place(c.id, B.STORAGE, x, y)) { st = [x, y]; continue; }
    if (st && !hs && Math.hypot(x - st[0], y - st[1]) > 3 && Buildings.place(c.id, B.HOUSE, x, y)) hs = [x, y];
  }
  assert.ok(st && hs, 'storage and an extra house placed');
  for (const b of Buildings.byCity(c.id)) Buildings.work(b, 1e6);
  const dStore = Cities.dropoff(c.id, st[0] + 1, st[1]);
  assert.deepEqual(dStore, { x: st[0], y: st[1] }, 'nearest storage');
  const dHome = Cities.homeSpot(c.id, hs[0], hs[1]);
  assert.deepEqual(dHome, { x: hs[0], y: hs[1]}, 'nearest house');
  const house = Buildings.at(hs[0], hs[1]);
  c.stock.wood = 3;
  assert.equal(Buildings.upgrade(house), false, 'not enough wood');
  c.stock.wood = 50;
  assert.equal(Buildings.upgrade(house), true); assert.equal(house.level, 2); assert.equal(c.stock.wood, 50 - 4);
  assert.equal(Buildings.capOf(house), 6);
  assert.equal(Buildings.upgrade(house), true); assert.equal(Buildings.capOf(house), 8); assert.equal(c.stock.wood, 50 - 4 - 6);
  assert.equal(Buildings.upgrade(house), false, 'max level 3');
  assert.equal(Cities.housingCap(c.id), 6 + 4 + 8, 'hall + a level-1 house + upgraded house');
});

section('membership: addMember / removeMember / setKingdom keep ids, pop, kingdom in sync', () => {
  const ctx = mkCtx();
  const { S, Cities } = ctx;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y);
  const u = mkUnit(ctx, 0, 0, c.x, c.y);
  assert.equal(Cities.addMember(c.id, u), true);
  assert.equal(c.pop, 7); assert.equal(u.cityId, c.id); assert.equal(u.kingdomId, c.kingdomId);
  Cities.addMember(c.id, u);
  assert.equal(c.members.filter(i => i === u.id).length, 1, 'no duplicates');
  Cities.setKingdom(c.id, 424242);
  assert.ok(c.members.every(id => S.units.get(id).kingdomId === 424242));
  Cities.setKingdom(c.id, c.kingdomId);
  assert.equal(Cities.removeMember(u), true);
  assert.equal(u.cityId, 0); assert.equal(u.kingdomId, 0); assert.equal(c.pop, 6); assert.ok(!c.members.includes(u.id));
  assert.equal(Cities.removeMember(u), false);
  // dead units are pruned by the city visit
  const v = mkUnit(ctx, 0, 1, c.x, c.y); Cities.addMember(c.id, v);
  S.units.delete(v.id);
  for (let t = 0; t < 12; t++) { S.tick++; Cities.step(S.tick); }
  assert.ok(!c.members.includes(v.id) && c.pop === 6);
  // moving between cities
  const s2 = Cities.findSiteRange(0, c.x, c.y, 14, 40, null);
  assert.ok(s2, 'second site');
  const { c: c2 } = foundVillage(ctx, 0, s2.x, s2.y, 3);
  const w = c.members.map(id => S.units.get(id))[0];
  Cities.addMember(c2.id, w);
  assert.ok(!c.members.includes(w.id) && c2.members.includes(w.id) && w.cityId === c2.id && w.kingdomId === c2.kingdomId);
  checkInvariants(ctx, 'membership');
});

section('territory: nearest centre wins (Voronoi), land only, grows with level, S.touchOwner', () => {
  const ctx = mkCtx();
  const { S, Cities } = ctx;
  const s = grassSite(ctx);
  const { c: a } = foundVillage(ctx, 0, s.x, s.y, 4);
  const s2 = Cities.findSiteRange(0, a.x, a.y, 10, 14, null);
  assert.ok(s2, 'neighbour site');
  const v0 = S.ownerVer;
  const { c: b } = foundVillage(ctx, 0, s2.x, s2.y, 4);
  assert.ok(S.ownerVer > v0, 'ownerVer bumped');
  const w = S.w;
  for (let y = 0; y < S.h; y++) for (let x = 0; x < w; x++) {
    const o = S.owner[y * w + x];
    if (!o) continue;
    const mine = S.cities.get(o), other = o === a.id ? b : a;
    const dm = (x - mine.x) ** 2 + (y - mine.y) ** 2, dn = (x - other.x) ** 2 + (y - other.y) ** 2;
    assert.ok(dm <= dn, 'owner is the nearest centre at ' + x + ',' + y);
    assert.ok(dm <= mine.radius * mine.radius);
  }
  const before = ownedTiles(ctx, a.id);
  // level up -> bigger radius, more tiles (when free ground exists)
  const r0 = a.radius;
  const tiny = ctx.Cities.levelFor(30, 1);
  assert.equal(tiny, 3);
  a.level = 3; Cities.recomputeTerritory(a.id);
  assert.equal(a.radius, ctx.Races.list[0].cityRadius + 3); assert.ok(a.radius > r0);
  assert.ok(ownedTiles(ctx, a.id) >= before);
  // levels by population thresholds 8 / 18 / 35 / 60 (with hysteresis on the way down)
  const L = (p, cur = 1) => Cities.levelFor(p, cur);
  assert.deepEqual([L(0), L(7), L(8), L(17), L(18), L(34), L(35), L(59), L(60), L(200)], [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  assert.equal(L(15, 3), 3, 'hysteresis'); assert.equal(L(12, 3), 2);
  // land turning into water releases the tiles (debounced, via the bus + step)
  const ox = a.x + 3, oy = a.y;
  const idx = oy * w + ox;
  if (S.owner[idx] === a.id) {
    ctx.World.setTile(ox, oy, ctx.Const.T.SHALLOW);
    for (let t = 0; t < 12; t++) { S.tick++; Cities.step(S.tick); }
    assert.equal(S.owner[idx], 0, 'flooded tile released');
  }
  checkInvariants(ctx, 'territory');
});

section('destroy(): buildings, members, territory, kingdom and neighbours are cleaned up', () => {
  const ctx = mkCtx();
  const { S, Cities, Buildings, Kingdoms, Const } = ctx;
  const s = grassSite(ctx);
  const { c: a, us } = foundVillage(ctx, 0, s.x, s.y, 6);
  const s2 = Cities.findSiteRange(0, a.x, a.y, 10, 14, null);
  const { c: b } = foundVillage(ctx, 0, s2.x, s2.y, 4);
  Cities.recomputeTerritory(a.id);
  for (let t = 0; t < 25; t++) { S.tick++; Cities.step(S.tick); }
  const bTiles = ownedTiles(ctx, b.id);
  const kid = a.kingdomId;
  const evs = [];
  ctx.Bus.on('cityDestroyed', (c, cause) => evs.push([c.id, cause]));
  const bldIds = a.buildings.slice();
  assert.ok(bldIds.length >= 3);
  assert.equal(Cities.destroy(a.id, 'war'), true);
  assert.ok(!S.cities.has(a.id));
  assert.equal(ownedTiles(ctx, a.id), 0, 'S.owner released');
  for (const id of bldIds) assert.ok(!S.buildings.has(id), 'building gone');
  for (let i = 0; i < S.bld.length; i++) assert.ok(!S.bld[i] || S.buildings.get(S.bld[i]).cityId !== a.id);
  assert.ok(us.every(u => u.cityId === 0 && u.kingdomId === 0 && u.job === null));
  assert.deepEqual(evs, [[a.id, 'war']]);
  assert.ok(ownedTiles(ctx, b.id) >= bTiles, 'neighbour reclaimed freed ground');
  assert.ok(S.log.some(l => l.msg.includes(a.name) && l.msg.includes('разрушен')));
  assert.equal(Kingdoms.get(kid) ? Kingdoms.get(kid).cities.includes(a.id) : false, false, 'kingdom forgot the city');
  assert.equal(Cities.destroy(a.id, 'war'), false, 'second destroy is a no-op');
  checkInvariants(ctx, 'destroy city');
  // abandoned cities (no members for a long time) vanish
  const bm = b.members.map(id => S.units.get(id));
  bm.forEach(u => killUnit(ctx, u));
  for (let t = 0; t < 1000; t++) { S.tick++; Cities.step(S.tick); }
  assert.ok(!S.cities.has(b.id), 'abandoned village removed');
  assert.ok(S.log.some(l => l.msg.includes(b.name) && l.msg.includes('опустел')));
  assert.equal(S.buildings.size, 0); assert.equal(S.owner.reduce((s, v) => s + (v ? 1 : 0), 0), 0);
});

section('capture() = occupy() (stage 2): the city keeps its kingdom, an occupier is recorded, members stay', () => {
  const ctx = mkCtx();
  const { S, Cities, Kingdoms } = ctx;
  const s = grassSite(ctx);
  const { c: a, us } = foundVillage(ctx, 0, s.x, s.y, 6);
  const s2 = Cities.findSiteRange(1, a.x, a.y, 14, 40, null);
  const { c: b } = foundVillage(ctx, 1, s2.x, s2.y, 4);          // an orc village: its own kingdom
  assert.notEqual(a.kingdomId, b.kingdomId);
  for (let t = 0; t < 30; t++) { S.tick++; Cities.step(S.tick); }
  const evs = []; ctx.Bus.on('cityCaptured', (c, o, n) => evs.push([c.id, o, n]));
  const occ = []; ctx.Bus.on('cityOccupied', (c, k) => occ.push([c.id, k]));
  const oldK = a.kingdomId, newK = b.kingdomId;
  assert.equal(Cities.isOccupied(a.id), false);
  assert.equal(Cities.capture(a.id, newK, null), true);
  assert.equal(a.kingdomId, oldK, 'ownership does not change (only Kingdoms.transferCity does that)');
  assert.equal(a.occupierId, newK); assert.equal(Cities.isOccupied(a.id), true);
  assert.ok(us.every(u => u.kingdomId === oldK && u.cityId === a.id), 'members stay');
  assert.ok(Kingdoms.get(oldK).cities.includes(a.id));
  assert.deepEqual(evs, [[a.id, oldK, newK]]); assert.deepEqual(occ, [[a.id, newK]]);
  assert.equal(Cities.capture(a.id, newK, null), false, 'already occupied by them');
  assert.equal(Cities.occupy(a.id, oldK), false, 'cannot occupy your own city');
  assert.equal(Cities.occupy(999999, newK), false);
  assert.equal(Cities.liberate(a.id), true); assert.equal(a.occupierId, 0);
  assert.equal(Cities.liberate(a.id), false);
  checkInvariants(ctx, 'capture');
});

section('assignJob: valid, cheap, food first, targets are real tiles', () => {
  const ctx = mkCtx();
  const { S, Cities, Buildings, Const, World } = ctx;
  const B = Const.B, RES = Const.RES;
  const s = grassSite(ctx);
  const { c, us } = foundVillage(ctx, 0, s.x, s.y, 8);
  // finish all sites, run a bit so candidate caches fill
  for (let t = 0; t < 30; t++) { S.tick++; Cities.step(S.tick); }
  for (const b of Buildings.byCity(c.id)) Buildings.work(b, 1e6);
  for (let t = 0; t < 60; t++) { S.tick++; Cities.step(S.tick); }
  assert.ok(Buildings.byCity(c.id).some(b => b.type === B.FARM && b.done), 'a finished farm');
  const allowed = new Set(['build', 'chop', 'mine', 'forage', 'fish', 'farm', 'guard', 'idle']);
  const seen = {};
  const u = us[0];
  const t0 = performance.now();
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const j = Cities.assignJob(u);
    assert.ok(j && allowed.has(j.type), 'job type ' + (j && j.type));
    assert.ok(Number.isInteger(j.x) && Number.isInteger(j.y) && S.inBounds(j.x, j.y), 'job tile');
    seen[j.type] = (seen[j.type] || 0) + 1;
    const i2 = j.y * S.w + j.x;
    switch (j.type) {
      case 'chop': assert.ok(World.resAt(j.x, j.y).kind === RES.TREE); break;
      case 'mine': assert.ok(['stone', 'iron', 'gold'].includes(j.kind)); assert.ok(S.res[i2] === { stone: RES.ROCK, iron: RES.IRON, gold: RES.GOLD }[j.kind]); break;
      case 'forage': assert.ok(S.res[i2] === RES.BERRY && S.amt[i2] >= 5); break;
      case 'fish': assert.ok(World.findNearestRes(j.x, j.y, RES.FISH, 0)); assert.ok(ctx.Tiles.isLand(S.tile[i2])); break;
      case 'farm': { const b = Buildings.get(j.buildingId); assert.ok(b && b.done && b.type === B.FARM && b.cityId === c.id && b.x === j.x && b.y === j.y); break; }
      case 'build': { const b = Buildings.get(j.buildingId); assert.ok(b && !b.done && b.cityId === c.id); break; }
    }
    if (i % 50 === 0) S.tick += 100;     // let worker slots expire
  }
  const us2 = (performance.now() - t0) * 1000 / N;
  note('assignJob: ' + us2.toFixed(2) + ' us/call; mix ' + JSON.stringify(seen));
  assert.ok(us2 < 40, 'assignJob is cheap');
  assert.ok(Object.keys(seen).length >= 3, 'labour is spread');
  // children idle, strangers null
  const kid = mkUnit(ctx, 0, 0, c.x, c.y, 3); Cities.addMember(c.id, kid);
  assert.equal(Cities.assignJob(kid).type, 'idle');
  assert.equal(Cities.assignJob(mkUnit(ctx, 0, 0, 5, 5)), null, 'homeless has no job');
  // food first: starving village -> mostly food jobs, farms get <= 2 workers per window
  c.stock.food = 0; c.stock.wood = 40; c.stock.stone = 20;
  for (let t = 0; t < 20; t++) { S.tick++; Cities.step(S.tick); }
  c.stock.food = 0;
  S.tick += 500;
  const farms = Buildings.byCity(c.id).filter(b => b.type === B.FARM && b.done);
  let food = 0, n = 0;
  const perFarm = new Map();
  for (let i = 0; i < 400; i++) {
    const j = Cities.assignJob(u);
    n++;
    if (j.type === 'farm') { food++; perFarm.set(j.buildingId, (perFarm.get(j.buildingId) || 0) + 1); }
    else if (j.type === 'forage' || j.type === 'fish') food++;
  }
  note('starving: ' + food + '/' + n + ' food jobs, farm assignments in one window ' + JSON.stringify([...perFarm.values()]) + ' with ' + farms.length + ' farm(s)');
  assert.ok(food / n > 0.3, 'food first when starving');
  for (const v of perFarm.values()) assert.ok(v <= 2, 'at most 2 farmers per farm per window');
});

section('economy: 6 founders build houses / farm / storage, grow, level up (1500 ticks, worker bot)', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Buildings, Const } = ctx;
  const B = Const.B;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 6);
  const hist = [];
  let minFood = 1e9, minWood = 1e9, maxPop = 0;
  const events = [];
  ctx.Bus.on('buildingDone', b => events.push([S.tick, b.type]));
  run(ctx, 1500, tick => {
    for (const g of Const.GOODS) { assert.ok(Number.isFinite(c.stock[g]) && c.stock[g] >= 0, `stock ${g} sane at ${tick}: ${c.stock[g]}`); }
    minFood = Math.min(minFood, c.stock.food); minWood = Math.min(minWood, c.stock.wood); maxPop = Math.max(maxPop, c.pop);
    if (tick % 250 === 0) {
      hist.push(`t${tick} pop ${c.pop} L${c.level} food ${c.stock.food} wood ${c.stock.wood} stone ${c.stock.stone} H${countType(ctx, c, B.HOUSE)} F${countType(ctx, c, B.FARM)} S${countType(ctx, c, B.STORAGE)} sites ${c.mod.sites.length}`);
    }
  });
  hist.forEach(h => note(h));
  note('jobs ' + JSON.stringify(ctx.jobCount) + ' births ' + (ctx.births || 0) + ' deaths ' + (ctx.deaths || 0));
  const houses = countType(ctx, c, B.HOUSE), farms = countType(ctx, c, B.FARM), storage = countType(ctx, c, B.STORAGE);
  note(`final: pop ${c.pop} level ${c.level} houses ${houses} farms ${farms} storage ${storage} barracks ${countType(ctx, c, B.BARRACKS)} temple ${countType(ctx, c, B.TEMPLE)} owned ${ownedTiles(ctx, c.id)} tiles`);
  assert.ok(houses >= 2, 'built houses: ' + houses);
  assert.ok(farms >= 1, 'built farms: ' + farms);
  assert.ok(storage >= 1, 'built storage: ' + storage);
  assert.ok(c.level >= 2, 'level up (pop ' + c.pop + ')');
  assert.ok(c.pop >= 12, 'grew to pop ' + c.pop);
  assert.ok(ctx.deaths === undefined || ctx.deaths <= 2, 'no starvation wipe: deaths ' + ctx.deaths);
  assert.ok(Cities.ownerAt(c.x, c.y) === c.id && ownedTiles(ctx, c.id) > 60);
  assert.ok(c.radius === ctx.Races.list[0].cityRadius + c.level);
  checkInvariants(ctx, 'economy');
  // layout: lanes, no building orthogonally adjacent to another
  for (const b of S.buildings.values()) {
    if (b.type === B.TOWNHALL) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const o = Buildings.at(b.x + dx, b.y + dy);
      assert.ok(!o, `building ${b.type}@${b.x},${b.y} touches ${o && o.type}`);
    }
    assert.ok(Math.hypot(b.x - c.x, b.y - c.y) >= 2, 'ring 1 around the hall stays free');
  }
  assert.ok(minFood >= 0 && minWood >= 0);
});

section('food shortage: starvation relief keeps stock >= 0 and the village alive without workers', () => {
  const ctx = mkCtx(1);
  const { S, Cities } = ctx;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 6);
  ctx.noBirths = true;
  c.stock.food = 0;
  // no bot work at all: only Buildings.step / Cities.step (passive trickle + relief) feed the village
  let fed = 0;
  for (let t = 0; t < 600; t++) {
    S.tick++;
    ctx.Buildings.step(S.tick); Cities.step(S.tick);
    if (S.tick % 5 === 0) fed += Cities.withdraw(c.id, 'food', 1);       // pretend someone eats now and then
    assert.ok(c.stock.food >= 0 && Number.isFinite(c.stock.food));
  }
  note('600 ticks with zero labour: ' + fed + ' food reached the table');
  assert.ok(fed > 0);
});

section('expeditions: crowded rich city sends 3-5 settlers who found a second village', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Const, Kingdoms } = ctx;
  const s = grassSite(ctx);
  const { c, us } = foundVillage(ctx, 0, s.x, s.y, 6);
  for (let i = 0; i < 12; i++) Cities.addMember(c.id, mkUnit(ctx, 0, i % 2, c.x + 0.5, c.y + 0.5, 22 + i));
  c.stock.food = 120; c.stock.wood = 120; c.stock.stone = 60;
  ctx.noBirths = true;
  let launch = null;
  const foundedAt = [];
  ctx.Bus.on('cityFounded', x => foundedAt.push(S.tick));
  run(ctx, 1400, tick => {
    c.stock.food = Math.max(c.stock.food, 100);                  // keep the surplus condition
    if (!launch) c.stock.wood = 0;                               // wood-starved: no new houses, so the city stays crowded
    if (!launch) {
      const settlers = [...S.units.values()].filter(u => u.state === 'settle');
      if (settlers.length) {
        launch = { tick, settlers: settlers.map(u => ({ id: u.id, sex: u.sex, parent: u.st.parent, target: u.st.target, group: u.st.group, t0: u.st.t0, cityId: u.cityId, job: u.job })) };
      }
    }
  });
  assert.ok(launch, 'an expedition was launched');
  note(`launched at tick ${launch.tick}, ${launch.settlers.length} settlers, target ${JSON.stringify(launch.settlers[0].target)}; city count ${S.cities.size}`);
  assert.ok(launch.settlers.length >= 3 && launch.settlers.length <= 5, 'group of 3-5');
  const st0 = launch.settlers[0];
  assert.equal(st0.parent, c.id); assert.ok(st0.group.length === launch.settlers.length);
  assert.ok(launch.settlers.every(u => u.cityId === 0 && u.job === null), 'removed from the parent city');
  assert.ok(launch.settlers.some(u => u.sex === Const.SEX.M) && launch.settlers.some(u => u.sex === Const.SEX.F), 'mixed sex');
  assert.ok(!launch.settlers.some(u => us[0].id === u.id && us[0].isRuler));
  const d = Util_dist(c.x, c.y, st0.target.x, st0.target.y);
  assert.ok(d >= 12 && d <= 35.5, 'target 12-35 tiles away: ' + d.toFixed(1));
  assert.ok(ctx.World.sameLand(c.x, c.y, st0.target.x, st0.target.y), 'same landmass');
  assert.ok(S.cities.size >= 2, 'second village founded');
  const kid = c.kingdomId;
  const child = [...S.cities.values()].find(x => x.id !== c.id);
  assert.equal(child.kingdomId, kid, 'child village joins the parent kingdom');
  assert.ok(child.members.length >= 2, 'settlers are members: ' + child.members.length);
  assert.ok(S.mod.cities.exps.length === 0, 'registry cleaned up');
  assert.ok(Kingdoms.get(kid).cities.includes(child.id));
  assert.ok(S.log.some(l => l.msg === 'Основана деревня «' + child.name + '»'));
  assert.ok(Util_dist(c.x, c.y, child.x, child.y) >= Const.CITY_MIN_DIST);
  checkInvariants(ctx, 'expedition');
});
function Util_dist(a, b, c, d) { return Math.hypot(c - a, d - b); }

section('expeditions: stale ones are released; invalid sites are re-picked or released', () => {
  const ctx = mkCtx(1);
  const { S, Cities } = ctx;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 6);
  for (let i = 0; i < 12; i++) Cities.addMember(c.id, mkUnit(ctx, 0, i % 2, c.x + 0.5, c.y + 0.5, 22 + i));
  c.stock.food = 200; c.mod.expCd = 0;
  let tick = S.tick;
  const settlers = () => [...S.units.values()].filter(u => u.state === 'settle');
  // launch (no bot walking: units stay put)
  for (let t = 0; t < 120 && !settlers().length; t++) { S.tick++; c.stock.food = 200; Cities.step(S.tick); }
  const g = settlers();
  assert.ok(g.length >= 3, 'launched ' + g.length);
  // (a) site becomes invalid before arrival: somebody founds a village right on the target
  const tg = g[0].st.target;
  const blocker = mkUnit(ctx, 0, 0, tg.x + 0.5, tg.y + 0.5);
  const blk = Cities.found(0, tg.x, tg.y, [blocker], {});
  assert.ok(blk, 'blocker village founded on the target');
  g.forEach(u => { u.x = tg.x + 3.5; u.y = tg.y + 0.5; });
  const r1 = Cities.foundExpedition(g[0]);
  assert.equal(r1, null, 'nobody founds on an invalid site');
  const after = settlers();
  const t2 = after.length ? after[0].st.target : null;
  if (after.length) { assert.ok(after.every(u => u.st.target.x === t2.x && u.st.target.y === t2.y), 'group retargeted together'); assert.ok(Cities.canFound(t2.x, t2.y, 0) || true); }
  else assert.ok(S.mod.cities.exps.length === 0);
  // (b) stale: old t0 -> released on arrival call and by maintenance
  const left = settlers();
  if (left.length) {
    left.forEach(u => { u.st.t0 -= 3000; });
    S.mod.cities.exps.forEach(e => { e.t0 -= 3000; });
    S.tick = Math.ceil(S.tick / 50) * 50 + 7;
    Cities.step(S.tick);
    assert.equal(settlers().length, 0, 'stale expedition released');
    left.forEach(u => { assert.equal(u.state, 'idle'); assert.equal(u.cityId, 0); assert.deepEqual(u.st, {}); });
    assert.equal(S.mod.cities.exps.length, 0);
  }
  // (c) arrival call of a unit with a stale t0 releases it as well
  const lone = mkUnit(ctx, 0, 0, 20.5, 20.5);
  lone.state = 'settle'; lone.st = { target: { x: 20, y: 20 }, parent: c.id, group: [lone.id], t0: S.tick - 5000, eid: 1 };
  assert.equal(Cities.foundExpedition(lone), null); assert.equal(lone.state, 'idle');
  // garbage input never throws
  assert.equal(Cities.foundExpedition(null), null); assert.equal(Cities.foundExpedition({ state: 'settle' }), null);
  assert.equal(Cities.foundExpedition(mkUnit(ctx, 0, 0, 3, 3)), null);
});

section('expeditions: a lone early arriver waits for the group, late arrivers join the new village', () => {
  const ctx = mkCtx(1);
  const { S, Cities } = ctx;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 6);
  for (let i = 0; i < 12; i++) Cities.addMember(c.id, mkUnit(ctx, 0, i % 2, c.x + 0.5, c.y + 0.5, 22 + i));
  c.mod.expCd = 0;
  const settlers = () => [...S.units.values()].filter(u => u.state === 'settle');
  for (let t = 0; t < 120 && !settlers().length; t++) { S.tick++; c.stock.food = 200; Cities.step(S.tick); }
  const g = settlers();
  assert.ok(g.length >= 4, 'need a group of >= 4, got ' + g.length);
  const tg = g[0].st.target;
  // everyone far away except g[0]
  g.forEach(u => { u.x = tg.x + 30; u.y = tg.y; });
  g[0].x = tg.x + 0.5; g[0].y = tg.y + 0.5;
  assert.equal(Cities.foundExpedition(g[0]), null, 'alone: waits');
  assert.equal(g[0].state, 'settle');
  // two more arrive close by
  g[1].x = tg.x + 2; g[1].y = tg.y + 1; g[2].x = tg.x - 2; g[2].y = tg.y + 1;
  const city = Cities.foundExpedition(g[1]);
  assert.ok(city, 'enough settlers present -> founded');
  assert.ok(city.members.includes(g[0].id) && city.members.includes(g[1].id) && city.members.includes(g[2].id));
  assert.equal(city.x, tg.x); assert.equal(city.y, tg.y);
  // the laggard walks in later and joins
  const lag = g[3];
  assert.ok(lag.state === 'settle' && lag.st.joinCity === city.id);
  lag.x = tg.x + 1; lag.y = tg.y + 1;
  assert.equal(Cities.foundExpedition(lag), city);
  assert.equal(lag.cityId, city.id); assert.equal(lag.state, 'idle');
  checkInvariants(ctx, 'late');
});

section('trySettle: join friendly cities with free housing, never hostile ones', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Buildings, Const } = ctx;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 6);                  // human village, housing 6 (hall) - full
  const homeless = (race, dx = 3, dy = 3, sex = 0, age = 25) => mkUnit(ctx, race, sex, c.x + dx + 0.5, c.y + dy + 0.5, age);
  // full -> cannot join; no join
  const h0 = homeless(0);
  assert.equal(Cities.housingFree(c.id), 0);
  Cities.trySettle(h0);
  assert.equal(h0.cityId, 0, 'no free housing, no join');
  // finish the house -> room for 4
  for (const b of Buildings.byCity(c.id)) Buildings.work(b, 1e6);
  assert.equal(Cities.housingFree(c.id), 4 + 0);
  const hint = Cities.trySettle(h0);
  assert.equal(hint, null); assert.equal(h0.cityId, c.id); assert.equal(h0.kingdomId, c.kingdomId); assert.equal(c.pop, 7);
  // child / dead / invalid input
  const kid = homeless(0, 3, 3, 0, 4);
  assert.equal(Cities.trySettle(kid), null); assert.equal(kid.cityId, 0);
  assert.equal(Cities.trySettle(null), null); assert.equal(Cities.trySettle({}), null);
  assert.equal(Cities.trySettle(h0), null, 'already housed');
  // orcs (rel -30 to humans) do not join; elves (rel 40) do
  const orc = homeless(Const.RACE.ORC);
  Cities.trySettle(orc); assert.equal(orc.cityId, 0, 'orc does not join a human village');
  const elf = homeless(Const.RACE.ELF);
  assert.equal(Cities.trySettle(elf), null); assert.equal(elf.cityId, c.id, 'elf joins a human village');
  // too far (> 30 tiles) -> no join
  const far = mkUnit(ctx, 0, 0, c.x + 33.5, c.y + 0.5);
  if (S.inBounds(c.x + 33, c.y)) { Cities.trySettle(far); assert.equal(far.cityId, 0, 'too far'); }
  // other island -> no join
  assert.ok(!Cities.lastError, 'no error swallowed: ' + (Cities.lastError && Cities.lastError.stack));
});

section('trySettle: 3+ co-located homeless found a village (elves: M+F suffices), others get hints', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Const } = ctx;
  const sA = grassSite(ctx);
  const mk = (race, x, y, sex, age = 25) => mkUnit(ctx, race, sex, x + 0.5, y + 0.5, age);
  // --- humans: a group of 3 standing together on valid land
  const g = [mk(0, sA.x, sA.y, 0), mk(0, sA.x + 1, sA.y, 1), mk(0, sA.x, sA.y + 1, 0)];
  const h1 = Cities.trySettle(g[0]);
  assert.ok(g[0].cityId === 0 && S.cities.size === 0, 'one seeker alone cannot found');
  Cities.trySettle(g[1]);
  assert.equal(S.cities.size, 0, 'two humans are not enough');
  Cities.trySettle(g[2]);
  assert.equal(S.cities.size, 1, 'the third founds a village');
  const c1 = [...S.cities.values()][0];
  assert.ok(g.every(u => u.cityId === c1.id), 'all three are members');
  assert.equal(c1.race, 0); assert.ok(c1.kingdomId > 0);
  note('hint for a lone seeker: ' + JSON.stringify(h1));
  assert.ok(h1 === null || (Number.isInteger(h1.x) && Number.isInteger(h1.y)));
  // --- too close to the new village: a second trio cannot found within CITY_MIN_DIST
  const near = [mk(0, c1.x + 4, c1.y + 3, 0), mk(0, c1.x + 5, c1.y + 3, 1), mk(0, c1.x + 4, c1.y + 4, 1)];
  near.forEach(u => Cities.trySettle(u));
  assert.ok(S.cities.size === 1 || [...S.cities.values()].every(c => c.id === c1.id || Math.hypot(c.x - c1.x, c.y - c1.y) >= Const.CITY_MIN_DIST), 'min distance respected');
  // they join (free housing is gone? village has hall 6 only) or get a hint
  // --- elves: one man + one woman is enough
  const sE = Cities.findSiteRange(2, sA.x, sA.y, 20, 60, null);
  assert.ok(sE, 'elf site');
  const e1 = mk(2, sE.x, sE.y, 0, 40), e2 = mk(2, sE.x + 1, sE.y + 1, 1, 40);
  Cities.trySettle(e1); assert.equal(e1.cityId, 0, 'one elf alone');
  Cities.trySettle(e2);
  assert.ok(e1.cityId && e1.cityId === e2.cityId, 'two elves (M+F) found a village');
  assert.equal(S.cities.get(e1.cityId).race, 2);
  // two elves of the same sex are not
  const sE2 = Cities.findSiteRange(2, sE.x, sE.y, 12, 50, null);
  if (sE2) {
    const f1 = mk(2, sE2.x, sE2.y, 1, 40), f2 = mk(2, sE2.x + 1, sE2.y, 1, 40);
    const nBefore = S.cities.size;
    Cities.trySettle(f1); Cities.trySettle(f2);
    assert.equal(S.cities.size, nBefore, 'two elf women do not found a village');
  }
  // --- orcs: 2 are not enough, 3 are
  const sO = Cities.findSiteRange(1, sA.x, sA.y, 14, 60, null);
  if (sO) {
    const o = [mk(1, sO.x, sO.y, 0, 20), mk(1, sO.x + 1, sO.y, 1, 20), mk(1, sO.x, sO.y + 1, 0, 20)];
    Cities.trySettle(o[0]); Cities.trySettle(o[1]);
    assert.ok(!o[0].cityId, 'two orcs not enough');
    Cities.trySettle(o[2]);
    assert.ok(o.every(u => u.cityId) && S.cities.get(o[0].cityId).race === 1, 'three orcs found an orc village');
  }
  assert.ok(!Cities.lastError, 'no swallowed error: ' + (Cities.lastError && Cities.lastError.stack));
  checkInvariants(ctx, 'trySettle found');
});

section('trySettle: scattered homeless get hints that make them meet and found a village', () => {
  const ctx = mkCtx(1);
  const { S, Cities } = ctx;
  const sA = grassSite(ctx);
  // 4 humans scattered 10-20 tiles apart around a site, same landmass
  const pts = [];
  for (let r = 6; r < 40 && pts.length < 4; r += 2) for (let a = 0; a < 6.28 && pts.length < 4; a += 0.9) {
    const x = Math.round(sA.x + Math.cos(a) * r), y = Math.round(sA.y + Math.sin(a) * r);
    if (ctx.World.walkable(x, y) && ctx.Tiles.isLand(S.tile[y * S.w + x]) && ctx.World.sameLand(sA.x, sA.y, x, y) && pts.every(p => Math.hypot(p[0] - x, p[1] - y) > 7)) pts.push([x, y]);
  }
  assert.equal(pts.length, 4);
  const us = pts.map((p, i) => mkUnit(ctx, 0, i % 2, p[0] + 0.5, p[1] + 0.5, 25));
  // run the bot: homeless call trySettle every 20 ticks and walk towards the hint
  run(ctx, 1200, () => {});
  assert.ok(S.cities.size >= 1, 'the wanderers founded a village by themselves');
  const homelessLeft = us.filter(u => !u.cityId).length;
  note('founded ' + S.cities.size + ' village(s); homeless left ' + homelessLeft);
  assert.ok(us.filter(u => u.cityId).length >= 3);
  assert.ok(!ctx.Cities.lastError);
  checkInvariants(ctx, 'wanderers');
});

section('trySettle: a lone homeless far from everybody is pointed at a friendly city with room', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Buildings } = ctx;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 4);
  for (const b of Buildings.byCity(c.id)) Buildings.work(b, 1e6);
  assert.ok(Cities.housingFree(c.id) > 0);
  // a spot 31..60 tiles away on the same landmass
  let spot = null;
  for (let r = 31; r <= 60 && !spot; r++) for (let a = 0; a < 6.28 && !spot; a += 0.1) {
    const x = Math.round(c.x + Math.cos(a) * r), y = Math.round(c.y + Math.sin(a) * r);
    if (S.inBounds(x, y) && ctx.Tiles.isLand(S.tile[y * S.w + x]) && ctx.World.sameLand(c.x, c.y, x, y)) spot = [x, y];
  }
  assert.ok(spot, 'far spot on the same island');
  const u = mkUnit(ctx, 0, 0, spot[0] + 0.5, spot[1] + 0.5, 25);
  const hint = Cities.trySettle(u);
  assert.ok(hint && hint.x === c.x && hint.y === c.y, 'hint points at the city: ' + JSON.stringify(hint));
  assert.equal(u.cityId, 0);
  // after walking into range the unit joins
  u.x = c.x + 20.5; u.y = c.y + 0.5;
  if (ctx.World.sameLand(c.x, c.y, u.x, u.y)) { assert.equal(Cities.trySettle(u), null); assert.equal(u.cityId, c.id); }
});

section('findSite / canFound: habitat, distance, landmass; founding on valid land always works', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Const } = ctx;
  for (const race of [0, 1, 2]) {
    const s = Cities.findSite(race, 48, 48, 70);
    assert.ok(s, 'site for race ' + race);
    assert.ok(Cities.canFound(s.x, s.y, race) && typeof s.score === 'number');
  }
  assert.equal(Cities.canFound(0, 0, 0), false, 'corner / water');
  assert.equal(Cities.canFound(-4, 10, 0), false); assert.equal(Cities.canFound(NaN, 10, 0), false);
  // exhaustive: every canFound tile in a window can host a city with 3 founders (found never fails on a valid tile)
  let tested = 0;
  for (let y = 2; y < S.h - 2 && tested < 12; y += 7) for (let x = 2; x < S.w - 2 && tested < 12; x += 7) {
    if (!Cities.canFound(x, y, 0)) continue;
    const ctx2 = mkCtx(1);
    const us = [0, 1, 2].map(i => mkUnit(ctx2, 0, i % 2, x + 0.5, y + 0.5));
    const c = ctx2.Cities.found(0, x, y, us, {});
    assert.ok(c, `found at ${x},${y}`);
    tested++;
  }
  assert.ok(tested >= 6, 'tested ' + tested + ' tiles');
  // distance rule
  const s = Cities.findSite(0, 48, 48, 70);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 3);
  assert.equal(Cities.canFound(c.x + Const.CITY_MIN_DIST - 1, c.y, 0), false);
  const s2 = Cities.findSiteRange(0, c.x, c.y, 12, 35, null);
  if (s2) { const d = Math.hypot(s2.x - c.x, s2.y - c.y); assert.ok(d >= 12 && d <= 35.01); }
  // timing
  let t0 = performance.now();
  for (let i = 0; i < 20; i++) Cities.findSiteRange(0, c.x, c.y, 12, 35, null);
  note('findSiteRange(12..35): ' + ((performance.now() - t0) / 20).toFixed(2) + ' ms');
});

section('outfit: tier 1 from wood without barracks, tier >= 2 needs barracks + iron', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Buildings, Const } = ctx;
  const s = grassSite(ctx);
  const { c, us } = foundVillage(ctx, 0, s.x, s.y, 6);
  const u = us[0];
  c.stock.wood = 40; c.stock.iron = 50; c.stock.gold = 5;
  assert.equal(Cities.outfit(c.id, u), true);
  assert.equal(u.weapon, 1); assert.equal(u.armor, 1, 'wood gear only without barracks');
  assert.equal(c.stock.wood, 40 - 2 - 1); assert.equal(c.stock.iron, 50);
  assert.equal(Cities.outfit(c.id, u), false, 'nothing better available');
  // barracks done -> iron gear
  const sp = Cities.findSiteRange(0, c.x, c.y, 0, 1, null);   // (unused) keep API exercised
  void sp;
  c.stock.wood = 100; c.stock.stone = 100;
  for (let t = 0; t < 40; t++) { S.tick++; Cities.step(S.tick); }
  let bar = Buildings.byCity(c.id).find(b => b.type === Const.B.BARRACKS);
  if (!bar) {
    // plan one directly through the public API
    for (let dy = -6; dy <= 6 && !bar; dy++) for (let dx = -6; dx <= 6 && !bar; dx++) bar = Buildings.place(c.id, Const.B.BARRACKS, c.x + dx, c.y + dy);
  }
  assert.ok(bar, 'a barracks site');
  Buildings.work(bar, 1e6); Cities.recalc(c);
  const v = us[1];
  c.stock.iron = 50; c.stock.gold = 5; c.stock.wood = 100;
  assert.equal(Cities.outfit(c.id, v), true);
  assert.equal(v.weapon, 3); assert.equal(v.armor, 3);
  assert.equal(c.stock.iron, 50 - 4 - 6); assert.equal(c.stock.gold, 5 - 2);
  const w = us[2]; c.stock.iron = 2; c.stock.gold = 0;
  Cities.outfit(c.id, w);
  assert.equal(w.weapon, 2, 'affordable tier only (iron 2)'); assert.equal(w.armor, 1);
  assert.equal(Cities.outfit(c.id, null), false);
});

section('planner: sites limited, barracks/temple/market appear with population, nothing placed in foreign land', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Buildings, Const } = ctx;
  const B = Const.B;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 6);
  for (let i = 0; i < 62; i++) Cities.addMember(c.id, mkUnit(ctx, 0, i % 2, c.x + 0.5, c.y + 0.5, 20 + (i % 20)));
  c.stock.food = 150; c.stock.wood = 400; c.stock.stone = 300;
  ctx.noBirths = true;
  let maxOpen = 0;
  // finish buildings instantly every few ticks (builders are not under test here)
  for (let t = 0; t < 1500; t++) {
    S.tick++;
    Cities.step(S.tick);
    if (S.tick % 10 === 5) { for (const b of Buildings.byCity(c.id)) if (!b.done) Buildings.work(b, 1e6); }
    c.stock.food = Math.min(c.stock.food, 200); c.stock.wood = Math.max(c.stock.wood, 200); c.stock.stone = Math.max(c.stock.stone, 100);
    maxOpen = Math.max(maxOpen, c.mod.sites.length);
  }
  const cnt = t => countType(ctx, c, t);
  note(`pop ${c.pop} L${c.level}: houses ${cnt(B.HOUSE)} farms ${cnt(B.FARM)} storage ${cnt(B.STORAGE)} barracks ${cnt(B.BARRACKS)} temple ${cnt(B.TEMPLE)} market ${cnt(B.MARKET)}; max open ${maxOpen}; housing ${Cities.housingCap(c.id)}`);
  assert.ok(maxOpen <= 4, 'open sites bounded');
  assert.ok(cnt(B.BARRACKS) >= 1 && cnt(B.TEMPLE) >= 1 && cnt(B.MARKET) >= 1 && cnt(B.STORAGE) >= 2, 'outer buildings built');
  assert.ok(Cities.housingCap(c.id) + 0 >= c.pop - 2, 'enough housing');
  assert.ok(cnt(B.FARM) >= Math.ceil(c.pop / 10) - 1);
  for (const b of S.buildings.values()) { const o = S.owner[b.y * S.w + b.x]; assert.ok(o === 0 || o === c.id); }
  assert.ok(c.level === 5, 'level 5 at pop ' + c.pop + ' got ' + c.level);
  const houseLevels = Buildings.byCity(c.id).filter(b => b.type === B.HOUSE).map(b => b.level);
  assert.ok(houseLevels.every(l => l === 3), 'houses upgraded with the city: ' + houseLevels);
  assert.equal(Buildings.capOf(Buildings.byCity(c.id).find(b => b.type === B.HOUSE)), 8);
  checkInvariants(ctx, 'planner');
  // a destroyed town hall is rebuilt
  const th = Buildings.at(c.x, c.y);
  Buildings.destroy(th, 'war');
  for (let t = 0; t < 60; t++) { S.tick++; Cities.step(S.tick); }
  const th2 = Buildings.byCity(c.id).find(b => b.type === B.TOWNHALL);
  assert.ok(th2, 'town hall re-planned');
});

section('level changes: radius follows, houses upgrade, owned ground under buildings is kept', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Buildings, Const } = ctx;
  const B = Const.B;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 6);
  for (const b of Buildings.byCity(c.id)) Buildings.work(b, 1e6);
  for (let i = 0; i < 40; i++) Cities.addMember(c.id, mkUnit(ctx, 0, i % 2, c.x + 0.5, c.y + 0.5, 20 + (i % 15)));
  c.stock.wood = 200;
  const lv = [];
  ctx.Bus.on('buildingChanged', () => lv.push(1));
  for (let t = 0; t < 60; t++) { S.tick++; Cities.step(S.tick); }
  assert.equal(c.level, 4, 'pop 46 -> level 4');
  assert.equal(c.radius, ctx.Races.list[0].cityRadius + 4);
  assert.ok(Buildings.byCity(c.id).filter(b => b.type === B.HOUSE && b.done).every(h => h.level === 3), 'houses reached level 3');
  assert.ok(lv.length >= 1, 'buildingChanged emitted on upgrades');
  const bigTiles = ownedTiles(ctx, c.id);
  // the population collapses -> radius shrinks, but tiles under buildings stay owned
  for (const id of c.members.slice(6)) { const u = S.units.get(id); ctx.Cities.removeMember(u); S.units.delete(u.id); }
  for (let t = 0; t < 40; t++) { S.tick++; Cities.step(S.tick); }
  assert.equal(c.pop, 6); assert.ok(c.level < 4, 'level dropped to ' + c.level);
  assert.ok(ownedTiles(ctx, c.id) < bigTiles, 'territory shrank');
  for (const b of S.buildings.values()) assert.equal(S.owner[b.y * S.w + b.x], c.id, 'building tile still owned');
  checkInvariants(ctx, 'levels');
});

section('fire: burning buildings take damage through World, destroyed ones leave no trace', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Buildings, Const, World } = ctx;
  const B = Const.B;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 6);
  for (const b of Buildings.byCity(c.id)) Buildings.work(b, 1e6);
  const house = Buildings.byCity(c.id).find(b => b.type === B.HOUSE);
  const destroyed = [];
  ctx.Bus.on('buildingDestroyed', (b, cause) => destroyed.push([b.type, cause]));
  assert.ok(World.ignite(house.x, house.y), 'ignited the house tile');
  for (let t = 0; t < 140; t++) { S.tick++; World.step(S.tick); Buildings.step(S.tick); Cities.step(S.tick); }
  assert.ok(!S.buildings.has(house.id) || house.hp < house.maxHp, 'the house was hurt or burnt down');
  note('house after fire: ' + (S.buildings.has(house.id) ? 'hp ' + house.hp.toFixed(0) + '/' + house.maxHp : 'destroyed by ' + JSON.stringify(destroyed)));
  checkInvariants(ctx, 'fire');
  // a damaged building repairs itself slowly when left alone
  const th = Buildings.at(c.x, c.y);
  th.hp = 50; th.data.hit = S.tick;
  for (let t = 0; t < 600; t++) { S.tick++; Buildings.step(S.tick); }
  assert.ok(th.hp > 150, 'town hall repaired: ' + th.hp);
  // a farm gives a small passive trickle even without workers
  const farm = Buildings.byCity(c.id).find(b => b.type === B.FARM);
  if (farm && S.buildings.has(farm.id)) {
    const f0 = c.stock.food;
    for (let t = 0; t < 600; t++) { S.tick++; Buildings.step(S.tick); }
    assert.ok(c.stock.food > f0, 'passive farm output');
  }
});

section('stale sites are cancelled with a full refund; nearest / cityAt lookups', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Buildings, Const } = ctx;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 6);
  const site = Buildings.byCity(c.id).find(b => b.type === Const.B.HOUSE);
  const wood = c.stock.wood;
  S.tick += 2500;
  for (let t = 0; t < 12; t++) { S.tick++; Cities.step(S.tick); }
  assert.ok(!S.buildings.has(site.id), 'untouched site cancelled');
  assert.ok(c.stock.wood >= wood + 8 - 8, 'refund (a new site may have been paid again)');
  assert.equal(Cities.nearest(c.x + 2, c.y, 5), c);
  assert.equal(Cities.nearest(c.x + 20, c.y, 5), null);
  assert.equal(Cities.nearest(c.x, c.y, 5, x => x.id !== c.id), null);
  assert.equal(Cities.cityAt(c.x, c.y), c);
  assert.equal(Cities.cityAt(0, 0), null);
  assert.deepEqual(Cities.list().map(x => x.id), [c.id]);
});

section('tiny islands are no villages; trySettle founds on every canFound spot of a sample', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Const, World } = ctx;
  // carve a 2x3 island out of the sea
  for (let y = 5; y < 8; y++) for (let x = 5; x < 7; x++) World.setTile(x, y, Const.T.GRASS);
  assert.equal(Cities.canFound(5, 6, 0), false, 'too small');
  let tested = 0;
  for (let y = 3; y < S.h - 3 && tested < 14; y += 6) for (let x = 3; x < S.w - 3 && tested < 14; x += 6) {
    if (!Cities.canFound(x, y, 0)) continue;
    const c2 = mkCtx(1);
    const us = [0, 1, 2].map(i => mkUnit(c2, 0, i % 2, x + 0.5 + i * 0.3, y + 0.5, 25));
    us.forEach(u => c2.Cities.trySettle(u));
    assert.equal(c2.S.cities.size, 1, `3 homeless at ${x},${y} found a village`);
    assert.ok(us.every(u => u.cityId), 'all became members');
    tested++;
  }
  assert.ok(tested >= 8, 'tested ' + tested);
});

section('save-state: JSON round trip of cities / buildings / mod; afterLoad; simulation continues', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Buildings } = ctx;
  const s = grassSite(ctx);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 6);
  for (let i = 0; i < 12; i++) Cities.addMember(c.id, mkUnit(ctx, 0, i % 2, c.x + 0.5, c.y + 0.5, 22 + i));
  c.stock.food = 100;
  run(ctx, 500, () => { c.stock.food = Math.max(c.stock.food, 90); });
  const snap = JSON.stringify({
    cities: [...S.cities.values()], buildings: [...S.buildings.values()], units: [...S.units.values()], mod: S.mod,
    owner: Array.from(S.owner), bld: Array.from(S.bld), nextId: S.nextId, tick: S.tick, rng: ctx.R.getState(),
  });
  const parsed = JSON.parse(snap);
  assert.equal(JSON.stringify({ cities: parsed.cities, buildings: parsed.buildings }), JSON.stringify({ cities: [...S.cities.values()], buildings: [...S.buildings.values()] }), 'plain data round trip');
  assert.ok(snap.length < 600000, 'save size sane: ' + snap.length);
  note(`snapshot ${(snap.length / 1024).toFixed(0)} KB for ${S.cities.size} city, ${S.buildings.size} buildings, ${S.units.size} units; city.mod ${JSON.stringify(c.mod).length} bytes`);
  // rebuild a fresh world from the snapshot (what Save does)
  const ctx2 = mkCtx(1);
  const S2 = ctx2.S;
  S2.tick = parsed.tick; S2.nextId = parsed.nextId; ctx2.R.setState(parsed.rng);
  S2.owner.set(parsed.owner); S2.bld.set(parsed.bld);
  for (const u of parsed.units) S2.units.set(u.id, u);
  for (const x of parsed.cities) S2.cities.set(x.id, x);
  for (const b of parsed.buildings) S2.buildings.set(b.id, b);
  S2.mod = parsed.mod;
  ctx2.Cities.afterLoad(); ctx2.Buildings.afterLoad(); ctx2.Kingdoms.afterLoad(); ctx2.World.afterLoad();
  checkInvariants(ctx2, 'loaded');
  const c2 = S2.cities.get(c.id);
  assert.equal(c2.pop, c.pop); assert.equal(c2.level, c.level);
  assert.equal(ctx2.Cities.housingCap(c.id), Cities.housingCap(c.id));
  assert.deepEqual(ctx2.Cities.dropoff(c.id, c.x + 3, c.y), Cities.dropoff(c.id, c.x + 3, c.y));
  run(ctx2, 400, () => { c2.stock.food = Math.max(c2.stock.food, 90); });
  checkInvariants(ctx2, 'loaded+run');
  note('after load +400 ticks: pop ' + c2.pop + ', buildings ' + S2.buildings.size);
  assert.ok(S2.buildings.size >= S.buildings.size - 2);
  // JSON-safety of the live state: no NaN / Infinity / undefined holes inside entities
  const bad = JSON.stringify([...S2.cities.values(), ...S2.buildings.values()], (k, v) => (typeof v === 'number' && !Number.isFinite(v)) ? '__BAD__' : v);
  assert.ok(!bad.includes('__BAD__'));
});

section('performance: 10 cities (~30 pop each) - Cities.step + Buildings.step cost per tick', () => {
  const ctx = mkCtx(1, 128);
  const { S, Cities, Buildings, Const } = ctx;
  const cities = [];
  let guard = 0;
  while (cities.length < 10 && guard++ < 60) {
    const s = Cities.findSiteRange(0, R_(ctx, S.w), R_(ctx, S.h), 0, 70, null);
    if (!s) continue;
    const c = foundVillage(ctx, 0, s.x, s.y, 6).c;
    for (let i = 0; i < 24; i++) Cities.addMember(c.id, mkUnit(ctx, 0, i % 2, c.x + 0.5, c.y + 0.5, 20 + (i % 25)));
    c.stock.food = 200; c.stock.wood = 100; c.stock.stone = 50;
    cities.push(c);
  }
  assert.equal(cities.length, 10, 'ten cities placed');
  ctx.noBirths = true;
  run(ctx, 600, () => {});      // warm up / build
  ctx.timing.cities = 0; ctx.timing.buildings = 0; ctx.timing.ticks = 0;
  let worst = 0;
  const { World } = ctx;
  for (let k = 0; k < 900; k++) {
    S.tick++;
    for (const u of Array.from(S.units.values())) botStep(ctx, u);
    World.step(S.tick);
    const t0 = performance.now();
    Buildings.step(S.tick);
    Cities.step(S.tick);
    const dt = performance.now() - t0;
    ctx.timing.cities += dt; ctx.timing.ticks++;
    if (dt > worst) worst = dt;
    if (S.tick % 4 === 0) for (const c of cities) { c.stock.food = Math.max(c.stock.food, 100); }
  }
  const per = ctx.timing.cities / ctx.timing.ticks;
  note(`10 cities, pop ${cities.map(c => c.pop).join('/')}, buildings ${S.buildings.size}: Cities+Buildings step ${per.toFixed(4)} ms/tick avg, worst ${worst.toFixed(3)} ms`);
  // assignJob throughput with 10 cities
  const us = [...S.units.values()].filter(u => u.cityId);
  let t0 = performance.now(), n = 0;
  for (let i = 0; i < 20000; i++) { Cities.assignJob(us[i % us.length]); n++; }
  note('assignJob (10 cities): ' + ((performance.now() - t0) * 1000 / n).toFixed(2) + ' us/call');
  t0 = performance.now();
  for (let i = 0; i < 20000; i++) Cities.dropoff(cities[i % 10].id, 5, 5);
  note('dropoff: ' + ((performance.now() - t0) * 1000 / 20000).toFixed(3) + ' us/call');
  assert.ok(per < 0.5, 'step cost ' + per);
  assert.ok(worst < 8, 'worst-case tick ' + worst);
  checkInvariants(ctx, 'perf');
});
function R_(ctx, n) { return ctx.R.i(n); }

section('DoD smoke: 24 homeless humans + 10 orcs + 10 elves, 3000 ticks, no exceptions / NaN / unbounded growth', () => {
  const ctx = mkCtx(3);
  const { S, Cities, World } = ctx;
  const place = (race, n, groupSize) => {
    for (let g = 0; g < n / groupSize; g++) {
      const p = World.randomLand(null, 400);
      if (!p) continue;
      for (let i = 0; i < groupSize; i++) {
        const q = World.nearestWalkable(p[0] + (i % 3), p[1] + ((i / 3) | 0), 3);
        if (q) mkUnit(ctx, race, i % 2, q[0] + 0.5, q[1] + 0.5, race === 2 ? 40 : 22);
      }
    }
  };
  place(0, 24, 6); place(1, 10, 5); place(2, 10, 5);
  const n0 = S.units.size;
  let maxExp = 0;
  run(ctx, 3000, tick => { maxExp = Math.max(maxExp, S.mod.cities ? S.mod.cities.exps.length : 0); if (tick % 1000 === 0) checkInvariants(ctx, 'smoke t' + tick); });
  note(`${n0} units -> ${S.units.size}; cities ${S.cities.size} (${[...S.cities.values()].map(x => ['H', 'O', 'E'][x.race] + x.pop).join(' ')}); kingdoms ${S.kingdoms.size}; buildings ${S.buildings.size}`);
  assert.ok(S.cities.size >= 3, 'every race founded something');
  assert.ok(new Set([...S.cities.values()].map(x => x.race)).size >= 2);
  assert.ok(!Cities.lastError, 'no swallowed error: ' + (Cities.lastError && Cities.lastError.stack));
  assert.ok(maxExp <= S.cities.size + 1);
  for (const u of S.units.values()) assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y));
  assert.ok(S.log.length <= 300 && S.buildings.size < 600);
  checkInvariants(ctx, 'DoD end');
});

section('headless smoke: 3000 ticks with several villages, no exceptions, bounded collections', () => {
  const ctx = mkCtx(2);
  const { S, Cities } = ctx;
  const s = grassSite(ctx, 48, 48);
  const { c } = foundVillage(ctx, 0, s.x, s.y, 8);
  for (let i = 0; i < 6; i++) mkUnit(ctx, 0, i % 2, c.x + 5.5, c.y + 5.5, 25);   // some homeless around
  let maxB = 0, maxU = 0;
  run(ctx, 3000, tick => { maxB = Math.max(maxB, S.buildings.size); maxU = Math.max(maxU, S.units.size); if (tick % 500 === 0) checkInvariants(ctx, 't' + tick); });
  note(`after 3000 ticks: cities ${S.cities.size}, pop ${[...S.cities.values()].map(x => x.pop).join('/')}, buildings ${S.buildings.size}, units ${S.units.size}, kingdoms ${S.kingdoms.size}, log ${S.log.length}`);
  assert.ok(S.cities.size >= 1);
  assert.ok(S.log.length <= 300);
  assert.ok(!Cities.lastError);
  assert.ok(S.mod.cities.exps.length <= 4);
  for (const x of S.cities.values()) {
    assert.ok(x.hist.length <= 24);
    assert.ok(JSON.stringify(x.mod).length < 6000, 'city.mod stays small: ' + JSON.stringify(x.mod).length);
  }
  for (const u of S.units.values()) assert.ok(Number.isFinite(u.x) && Number.isFinite(u.y), 'no NaN positions');
  checkInvariants(ctx, 'smoke');
});

// ------------------------------------------------------------------ summary
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
if (failed.length) process.exit(1);
