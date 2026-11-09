// Bootstrap for the Render stage-2 (political map + war overlays) browser tests. Appended INSIDE the game scope by
//   node build.mjs --stubs --no-main --extra=tests/boot_render2.js --out=/tmp/godsim-render2.html
// The real Regions / War modules may not exist yet, so this file FABRICATES everything from the CONTRACT section 8 data layout:
//   World.generate -> multi-source BFS "Voronoi" regions (~10 tile spacing) in S.region / S.regions (Region schema 8.1)
//   -> 3..5 fabricated kingdoms (owner / controller, occupation), cities, buildings, civilians
//   -> wars with goals (8.2), armies with orders + fake soldier units standing in the world, simple animation.
// URL params: size=96 seed=11 kingdoms=4 units=120 still=1 regionsapi=1 (install a fake Regions API: get/centroid/frontlines)
//             view=icons (icon contact sheet instead of the game) nowars=1 (no wars/armies) noregions=1 (stage-1 style world)
// Exposes window.__r2 for tests/render2.test.mjs.
(function () {
  const q = new URLSearchParams(location.search);
  const SIZE = +(q.get('size') || 96), SEED = +(q.get('seed') || 11), NK = Math.max(2, Math.min(6, +(q.get('kingdoms') || 4))), NU = +(q.get('units') || 120);
  const STILL = q.get('still') === '1', API = q.get('regionsapi') === '1', NOWARS = q.get('nowars') === '1', NOREG = q.get('noregions') === '1';
  const T = Const.T, B = Const.B;

  Sprites.init();

  // ------------------------------------------------------------------ icon contact sheet (view=icons)
  if (q.get('view') === 'icons') {
    const keys = 'command region army shield arrow star supply war flag_goal handshake sword crown peace focus'.split(' ');
    const cw = 152, rows = Math.ceil(keys.length / 5);
    const c = document.createElement('canvas'); c.width = 5 * cw + 20; c.height = rows * 150 + 20;
    const x = c.getContext('2d'); x.fillStyle = '#2c3347'; x.fillRect(0, 0, c.width, c.height); x.imageSmoothingEnabled = false;
    keys.forEach((k, i) => {
      const X = 10 + (i % 5) * cw, Y = 10 + ((i / 5) | 0) * 150;
      x.fillStyle = '#3a4560'; x.fillRect(X, Y, cw - 6, 144);
      x.drawImage(Sprites.icon(k, 96), X + 4, Y + 4, 96, 96);
      x.drawImage(Sprites.icon(k, 32), X + 106, Y + 4); x.drawImage(Sprites.icon(k, 16), X + 106, Y + 44);
      x.drawImage(Sprites.icon(k, 48), X + 4, Y + 100, 40, 40);
      x.fillStyle = '#fff'; x.font = '10px sans-serif'; x.fillText(k, X + 52, Y + 134);
    });
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;background:#14161c';
    c.style.cssText = 'display:block;image-rendering:pixelated';
    document.body.appendChild(c);
    window.__r2 = { sheet: { w: c.width, h: c.height, keys, known: Sprites.iconKeys() } };
    window.__r2Ready = true;
    return;
  }

  const tg0 = performance.now();
  World.generate({ seed: SEED, w: SIZE, h: SIZE });
  const genMs = performance.now() - tg0;
  const W = S.w, H = S.h, N = W * H;

  let rs = SEED * 7919 + 13;
  const rnd = () => { rs = (rs + 0x6D2B79F5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ri = n => (rnd() * n) | 0;
  const isLand = i => { const t = S.tile[i]; return t >= T.SAND && t !== T.LAVA; };

  // ------------------------------------------------------------------ regions: BFS Voronoi over land
  const comp = new Int32Array(N); let nComp = 0; const compTiles = [null];
  for (let i = 0; i < N; i++) {
    if (comp[i] || !isLand(i)) continue;
    const id = ++nComp, list = [i]; comp[i] = id;
    for (let h = 0; h < list.length; h++) {
      const p = list[h], x = p % W, y = (p / W) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const n of nb) if (n >= 0 && !comp[n] && isLand(n)) { comp[n] = id; list.push(n); }
    }
    compTiles.push(list);
  }
  const SPACING = +(q.get('spacing') || 10), TARGET = Math.PI * (SPACING / 2) * (SPACING / 2) * 0.9;
  const seeds = [];
  const dist = new Int32Array(N);
  function bfsDist(list, from) {
    for (const p of list) dist[p] = -1;
    const qu = from.slice(); for (const p of qu) dist[p] = 0;
    for (let h = 0; h < qu.length; h++) {
      const p = qu[h], x = p % W, y = (p / W) | 0, d = dist[p] + 1;
      if (x > 0 && dist[p - 1] === -1 && comp[p - 1] === comp[p]) { dist[p - 1] = d; qu.push(p - 1); }
      if (x < W - 1 && dist[p + 1] === -1 && comp[p + 1] === comp[p]) { dist[p + 1] = d; qu.push(p + 1); }
      if (y > 0 && dist[p - W] === -1 && comp[p - W] === comp[p]) { dist[p - W] = d; qu.push(p - W); }
      if (y < H - 1 && dist[p + W] === -1 && comp[p + W] === comp[p]) { dist[p + W] = d; qu.push(p + W); }
    }
  }
  for (let c = 1; c <= nComp; c++) {
    const list = compTiles[c];
    if (list.length < 12) continue;
    let sx = 0, sy = 0; for (const p of list) { sx += p % W; sy += (p / W) | 0; }
    sx /= list.length; sy /= list.length;
    let first = list[0], bd = 1e9;
    for (const p of list) { const d = Math.hypot(p % W - sx, ((p / W) | 0) - sy); if (d < bd) { bd = d; first = p; } }
    const mine = [first], want = Math.max(1, Math.round(list.length / TARGET));
    while (mine.length < want) {
      bfsDist(list, mine);
      let best = -1, bv = -1; for (const p of list) if (dist[p] > bv) { bv = dist[p]; best = p; }
      if (best < 0 || bv < 3) break;
      mine.push(best);
    }
    for (const p of mine) seeds.push(p);
  }
  S.region.fill(0);
  const regions = [];
  const RN = ['Эриндор', 'Вельмарк', 'Тарвик', 'Силона', 'Грейнхолм', 'Кальбрюк', 'Озёрный край', 'Каменная Долина', 'Ясный Берег', 'Дальние Луга', 'Северная Марка', 'Лесная Земля', 'Железный Кряж', 'Рассветное', 'Туманный Предел', 'Стальные Холмы', 'Волчий Лог', 'Белая Гавань', 'Старый Брод', 'Три Холма', 'Янтарный Берег', 'Серые Пустоши', 'Золотая Нива', 'Орлиное Гнездо'];
  const qu = [];
  seeds.forEach((p, k) => {
    const id = S.id();
    const r = { id, name: RN[k % RN.length] + (k >= RN.length ? ' ' + (1 + (k / RN.length | 0)) : ''), cx: p % W, cy: (p / W) | 0, tiles: 0, ownerId: 0, controllerId: 0, cityIds: [], nb: [], claims: [], cores: [], value: 1, since: 0, occSince: 0, terrain: { forest: 0, hill: 0, mountain: 0, sand: 0, snow: 0 } };
    S.regions.set(id, r); regions.push(r); S.region[p] = id; qu.push(p);
  });
  for (let h = 0; h < qu.length; h++) {
    const p = qu[h], x = p % W, y = (p / W) | 0, id = S.region[p];
    for (const n of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) if (n >= 0 && !S.region[n] && isLand(n)) { S.region[n] = id; qu.push(n); }
  }
  const byId = id => S.regions.get(id);
  for (const r of regions) { r.tiles = 0; }
  const acc = new Map(); for (const r of regions) acc.set(r.id, { sx: 0, sy: 0 });
  for (let i = 0; i < N; i++) {
    const id = S.region[i]; if (!id) continue;
    const r = byId(id); r.tiles++; const a = acc.get(id); a.sx += i % W; a.sy += (i / W) | 0;
    const t = S.tile[i];
    if (t === T.FOREST) r.terrain.forest++; else if (t === T.HILL) r.terrain.hill++; else if (t === T.MOUNTAIN) r.terrain.mountain++; else if (t === T.SAND) r.terrain.sand++; else if (t === T.SNOW) r.terrain.snow++;
    const x = i % W, y = (i / W) | 0;
    for (const n of [x < W - 1 ? i + 1 : -1, y < H - 1 ? i + W : -1]) if (n >= 0 && S.region[n] && S.region[n] !== id) {
      const o = byId(S.region[n]);
      if (r.nb.indexOf(o.id) < 0) r.nb.push(o.id);
      if (o.nb.indexOf(r.id) < 0) o.nb.push(r.id);
    }
  }
  for (const r of regions) {
    const a = acc.get(r.id), mx = a.sx / r.tiles, my = a.sy / r.tiles;
    let bd = 1e9; for (let i = 0; i < N; i++) if (S.region[i] === r.id) { const d = Math.hypot(i % W - mx, ((i / W) | 0) - my); if (d < bd) { bd = d; r.cx = i % W; r.cy = (i / W) | 0; } }
    for (const k in r.terrain) r.terrain[k] = +(r.terrain[k] / r.tiles).toFixed(2);
    r.value = +(r.tiles / 60).toFixed(1);
  }
  S.touchRegions();

  // ------------------------------------------------------------------ kingdoms + ownership
  S.cultures = [];
  for (let k = 0; k < 6; k++) S.cultures.push({ id: k, name: 'Культура ' + (k + 1), color: Palette.culture[(k * 2) % 12], race: k % 3 });
  const KN = ['Аран', 'Орда Гор', 'Лотлориэн', 'Дорвен', 'Скальдия', 'Теневой Предел'];
  const kingdoms = [];
  const cpick = [0, 1, 2, 5, 6, 9];   // kingdom palette indices (red, blue, green, orange, teal, lime)
  for (let k = 0; k < NK; k++) {
    const id = S.id(), c1 = Palette.kingdom[cpick[k]];
    const kd = { id, name: KN[k], race: k % 3, color: c1, flag: { pattern: (k * 2 + 1) % 6, symbol: (k * 3 + 2) % 10, c1, c2: ['#ffffff', '#f2c230', '#111111'][k % 3], c3: '#f2c230' },
      capitalId: 0, rulerId: 0, cities: [], culture: k, stability: 70, born: 0, alive: true, clan: 'Дом ' + (k + 1), hist: [], cmd: false, overlordId: 0 };
    S.kingdoms.set(id, kd); kingdoms.push(kd);
  }
  // capitals: farthest point over region centres, then round-robin growth over region adjacency
  const owned = new Set();
  const capRegs = [];
  { let first = regions[(regions.length / 3) | 0]; capRegs.push(first);
    while (capRegs.length < NK) {
      let best = null, bv = -1;
      for (const r of regions) { let m = 1e9; for (const c of capRegs) m = Math.min(m, Math.hypot(r.cx - c.cx, r.cy - c.cy)); if (m > bv) { bv = m; best = r; } }
      capRegs.push(best);
    } }
  kingdoms.forEach((kd, k) => { const r = capRegs[k]; r.ownerId = r.controllerId = kd.id; owned.add(r.id); kd.capReg = r.id; });
  const wantOwned = Math.round(regions.length * 0.72);
  for (let guard = 0; guard < 400 && owned.size < wantOwned; guard++) {
    for (const kd of kingdoms) {
      const mine = regions.filter(r => r.ownerId === kd.id);
      const cand = []; for (const r of mine) for (const n of r.nb) { const o = byId(n); if (!o.ownerId) cand.push(o); }
      if (cand.length) { const o = cand[ri(cand.length)]; o.ownerId = o.controllerId = kd.id; owned.add(o.id); }
    }
  }

  // ------------------------------------------------------------------ cities / territory / buildings
  const cities = [];
  const CN = ['Вестград', 'Дорвен', 'Грушмок', 'Эрилтон', 'Сильвин', 'Тарбург', 'Мирхолм', 'Каллин', 'Нортвик', 'Рифстон', 'Альдвик', 'Хорбург'];
  function nearGrass(r) {
    let best = -1, bd = 1e9;
    for (let i = 0; i < N; i++) {
      if (S.region[i] !== r.id) continue;
      const t = S.tile[i]; if (t !== T.GRASS || S.res[i]) continue;
      const d = Math.hypot(i % W - r.cx, ((i / W) | 0) - r.cy); if (d < bd) { bd = d; best = i; }
    }
    return best < 0 ? r.cy * W + r.cx : best;
  }
  let cn = 0;
  for (const r of regions) {
    if (!r.ownerId) continue;
    const isCap = capRegs.indexOf(r) >= 0;
    if (!isCap && rnd() < 0.3) continue;
    const kd = S.kingdoms.get(r.ownerId), p = nearGrass(r), id = S.id();
    const c = { id, name: CN[cn++ % CN.length], race: kd.race, kingdomId: kd.id, x: p % W, y: (p / W) | 0, pop: isCap ? 40 + ri(30) : 6 + ri(34), members: [], stock: { food: 20, wood: 20, stone: 5, iron: 0, gold: 0 },
      radius: 8, level: isCap ? 3 : 1 + ri(2), loyalty: 80, culture: kd.culture, founded: 0, buildings: [], hist: [], mod: {}, regionId: r.id, occupierId: 0 };
    S.cities.set(id, c); cities.push(c); kd.cities.push(id); r.cityIds.push(id);
    if (isCap) kd.capitalId = id;
  }
  for (const kd of kingdoms) if (!kd.capitalId && kd.cities.length) kd.capitalId = kd.cities[0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, rid = S.region[i]; if (!rid) continue;
    const r = byId(rid); let best = 0, bd = 1e9;
    for (const c of cities) { if (c.kingdomId !== r.ownerId) continue; const d = Math.hypot(c.x - x, c.y - y); if (d < c.radius + 0.5 && d < bd) { bd = d; best = c.id; } }
    S.owner[i] = best;
  }
  S.touchOwner();
  const buildings = [];
  function placeB(c, type, x, y, done, progress) {
    const i = y * W + x;
    if (x < 0 || y < 0 || x >= W || y >= H || S.bld[i] || !Tiles.buildable(S.tile[i]) || S.res[i]) return null;
    const id = S.id();
    const b = { id, type, cityId: c.id, x, y, hp: 40, maxHp: 40, progress: done ? 1 : progress, done, level: 1 + ((x + y) % 3), born: 0, data: {} };
    S.buildings.set(id, b); S.bld[i] = id; c.buildings.push(id); buildings.push(b);
    return b;
  }
  for (const c of cities) {
    placeB(c, B.TOWNHALL, c.x, c.y, true, 1);
    const types = [B.HOUSE, B.HOUSE, B.FARM, B.HOUSE, B.STORAGE, B.HOUSE, B.BARRACKS, B.HOUSE];
    let placed = 0;
    for (let tries = 0; tries < 120 && placed < types.length; tries++) {
      const x = c.x + ri(9) - 4, y = c.y + ri(9) - 4;
      if (Math.abs(x - c.x) + Math.abs(y - c.y) < 2) continue;
      if (placeB(c, types[placed], x, y, true, 1)) placed++;
    }
  }

  // ------------------------------------------------------------------ units (civilians + soldiers)
  const units = [], way = [];
  function walkable(x, y) { x |= 0; y |= 0; return x >= 0 && y >= 0 && x < W && y < H && Tiles.walkable(S.tile[y * W + x]) && S.tile[y * W + x] !== T.SHALLOW; }
  const STATES = ['idle', 'wander', 'walk', 'gather', 'carry', 'build', 'farm'];
  function mkUnit(c, kid, x, y, armyId) {
    const id = S.id();
    const u = { id, race: c ? c.race : 0, sex: ri(2), name: 'U' + id, clan: 'К', born: S.tick - 25 * Const.TICKS_PER_YEAR, x, y, px: x, py: y, face: rnd() < 0.5 ? -1 : 1,
      hp: 20, maxHp: 20, hunger: 10, energy: 80, level: 1 + ri(5), xp: 0, kills: 0, traits: [0, 6], cityId: c ? c.id : 0, kingdomId: kid || 0,
      weapon: armyId ? 1 + ri(3) : ri(2), armor: armyId ? 1 + ri(2) : ri(2), state: armyId ? 'army' : STATES[ri(STATES.length)], st: {}, job: null, carry: null, carryAmt: 1,
      fatherId: 0, motherId: 0, spouseId: 0, armyId: armyId || 0, isRuler: false, sick: 0, buffUntil: 0, buffMul: 1, burning: 0, nextThink: 0, birthCd: 0, hist: [] };
    S.units.set(id, u); units.push(u);
    return u;
  }
  function randWay(u) {
    for (let t = 0; t < 12; t++) { const x = u.x + (rnd() - 0.5) * 12, y = u.y + (rnd() - 0.5) * 12; if (walkable(x, y)) return [x, y, 0.06 + rnd() * 0.1, S.tick + 20 + ri(80)]; }
    return [u.x, u.y, 0, S.tick + 30];
  }
  const civ = [];
  for (let k = 0; k < NU && cities.length; k++) {
    const c = cities[ri(cities.length)];
    let pos = null; for (let t = 0; t < 30; t++) { const x = c.x + (rnd() - 0.5) * 12, y = c.y + (rnd() - 0.5) * 12; if (walkable(x, y)) { pos = [x, y]; break; } }
    if (!pos) continue;
    const u = mkUnit(c, c.kingdomId, pos[0], pos[1], 0); civ.push(u); way.push(randWay(u));
  }
  for (const kd of kingdoms) { const u = civ.find(v => v.kingdomId === kd.id); if (u) { u.isRuler = true; kd.rulerId = u.id; } }

  // ------------------------------------------------------------------ wars, goals, occupation, armies
  const wars = [], armies = [];
  const adjacentEnemy = (a, b) => regions.filter(r => r.ownerId === b.id && r.nb.some(n => byId(n).ownerId === a.id));
  function setCtrl(r, kid) { r.controllerId = kid; r.occSince = kid === r.ownerId ? 0 : S.tick; for (const cid of r.cityIds) { const c = S.cities.get(cid); if (c) c.occupierId = kid === r.ownerId ? 0 : kid; } }
  function makeArmy(kd, war, regionId, orderType, mode, nSold, supply, offX) {
    const id = S.id(), home = S.cities.get(kd.capitalId) || cities[0];
    const reg = byId(regionId);
    let sx = home.x + 0.5 + (offX || 0), sy = home.y + 0.5;
    const a = { id, kingdomId: kd.id, cityId: home.id, warId: war.id, leaderId: 0, members: [], order: { type: orderType, regionId }, mode, rally: { x: sx, y: sy }, target: reg ? { regionId, x: reg.cx + 0.5, y: reg.cy + 0.5 } : null, supply, strength0: nSold, born: S.tick };
    S.armies.set(id, a); armies.push(a);
    return a;
  }
  function fillArmy(a, n, cx, cy) {
    const kd = S.kingdoms.get(a.kingdomId), home = S.cities.get(a.cityId);
    let best = null;
    for (let k = 0; k < n; k++) {
      let x = cx + (rnd() - 0.5) * 2.4, y = cy + (rnd() - 0.5) * 2.4;
      if (!walkable(x, y)) { x = cx; y = cy; if (!walkable(x, y)) continue; }
      const u = mkUnit(home, kd.id, x, y, a.id);
      u.level = 1 + ri(4); a.members.push(u.id);
      if (!best || u.level > best.level) best = u;
    }
    if (best) { a.leaderId = best.id; best.level += 3; }
    a.rally.x = cx; a.rally.y = cy;
  }
  const scen = {};
  if (!NOWARS) {
    // war 1: kingdoms[0] attacks kingdoms[1]; war 2: kingdoms[2] attacks kingdoms[3] (when they touch)
    const pairs = [[0, 1], [2, 3]];
    for (const [ia, ib] of pairs) {
      const A = kingdoms[ia], D = kingdoms[ib]; if (!A || !D) continue;
      let front = adjacentEnemy(A, D);
      if (!front.length) { // no common border: pick the nearest enemy region instead (island map)
        let bd = 1e9, br = null; for (const r of regions) if (r.ownerId === D.id) for (const m of regions) if (m.ownerId === A.id) { const d = Math.hypot(r.cx - m.cx, r.cy - m.cy); if (d < bd) { bd = d; br = r; } }
        if (br) front = [br];
      }
      if (!front.length) continue;
      const war = { id: S.id(), attackers: [A.id], defenders: [D.id], aggressor: A.id, defender: D.id, started: 0, casus: 'claim', ended: false, goals: [], score: { [A.id]: 62, [D.id]: 38 }, kills: {}, lastChange: 0, hist: [] };
      S.wars.set(war.id, war); wars.push(war);
      const g1 = front[0];
      // g2: a D region next to g1 (deeper in the enemy land), else another border region
      const deeper = g1.nb.map(byId).filter(r => r.ownerId === D.id && r !== g1);
      const g2 = deeper[0] || front[1] || null;
      war.goals.push({ kid: A.id, regionId: g1.id, done: true });
      if (g2) war.goals.push({ kid: A.id, regionId: g2.id, done: false });
      setCtrl(g1, A.id);                                 // occupied goal region (stripes of A over D)
      const extra = g1.nb.map(byId).filter(r => r.ownerId === D.id && r !== g1 && r !== g2);
      if (extra[0] && ia === 0) setCtrl(extra[0], A.id); // a second occupied region that is not a goal
      // counter-occupation: one region of A next to D is held by D
      const back = regions.filter(r => r.ownerId === A.id && r.nb.some(n => byId(n).ownerId === D.id));
      if (back.length && ia === 0) setCtrl(back[back.length - 1], D.id);
      // reserve region of A next to g1 (for the hold army)
      const reserve = g1.nb.map(byId).find(r => r.ownerId === A.id) || back[0] || g1;
      const dReg = (g2 ? g2.nb.map(byId).find(r => r.ownerId === D.id && r !== g1 && r !== g2) : null) || D.cities.length && byId(S.cities.get(D.capitalId).regionId) || g1;
      // armies
      const a1 = makeArmy(A, war, g2 ? g2.id : g1.id, 'attack', 'march', 22, ia === 0 ? 74 : 80, -2);
      const a2 = makeArmy(A, war, g1.id, 'hold', 'hold', 14, 100, 2);
      const a3 = makeArmy(A, war, (extra[1] || g2 || g1).id, 'attack', 'march', 30, 18, 0);
      const d1 = makeArmy(D, war, g2 ? g2.id : g1.id, 'defend', 'hold', 18, 90, 0);
      const d2 = makeArmy(D, war, g1.id, 'retreat', 'retreat', 6, 70, 3);
      const cap = S.cities.get(A.capitalId);
      fillArmy(a1, 22, g1.cx + 0.5 - 1, g1.cy + 0.5 + 1);
      fillArmy(a2, 14, reserve.cx + 0.5, reserve.cy + 0.5);
      fillArmy(a3, 30, cap.x + 0.5, cap.y + 2.5);
      fillArmy(d1, 18, dReg.cx + 0.5, dReg.cy + 0.5);
      const dc = S.cities.get(D.capitalId);
      fillArmy(d2, 6, dc.x + 0.5, dc.y + 2.5);
      a1.target = { regionId: a1.order.regionId, x: g2 ? g2.cx + 0.5 : g1.cx + 0.5, y: g2 ? g2.cy + 0.5 : g1.cy + 0.5 };
      a3.target = { regionId: a3.order.regionId, x: byId(a3.order.regionId).cx + 0.5, y: byId(a3.order.regionId).cy + 0.5 };
      if (ia === 0) Object.assign(scen, { A, D, war, g1, g2, a1, a2, a3, d1, d2, reserve, extra: extra[0] || null, counter: back.length ? back[back.length - 1] : null });
    }
  }
  S.touchRegions();
  const cmdKid = kingdoms[0].id;

  // ------------------------------------------------------------------ fake Regions API (regionsapi=1)
  const apiCalls = { frontlines: 0, centroid: 0, get: 0 };
  if (API) {
    const fakeFront = () => {
      apiCalls.frontlines++;
      const out = [];
      const atWar = (a, b) => { for (const w of S.wars.values()) { if (w.ended) continue; if ((w.attackers.includes(a) && w.defenders.includes(b)) || (w.attackers.includes(b) && w.defenders.includes(a))) return w; } return null; };
      for (const r of S.regions.values()) for (const n of r.nb) {
        if (n < r.id) continue; const o = S.regions.get(n);
        const ka = r.controllerId || r.ownerId, kb = o.controllerId || o.ownerId;
        if (!ka || !kb || ka === kb) continue;
        const w = atWar(ka, kb); if (w) out.push({ a: r.id, b: o.id, ka, kb, war: w.id });
      }
      return out;
    };
    Regions.get = id => { apiCalls.get++; return S.regions.get(id) || null; };
    Regions.centroid = rid => { apiCalls.centroid++; const r = S.regions.get(rid); return r ? { x: r.cx, y: r.cy } : null; };
    Regions.frontlines = fakeFront;
    Regions.__stub = false;
  }

  // ------------------------------------------------------------------ tick (fake sim): civilians wander, armies march
  function step() {
    S.tick++;
    for (let k = 0; k < civ.length; k++) {
      const u = civ[k], wv = way[k];
      u.px = u.x; u.py = u.y;
      if (S.tick > wv[3] || wv[2] === 0) { way[k] = randWay(u); continue; }
      const dx = wv[0] - u.x, dy = wv[1] - u.y, d = Math.hypot(dx, dy);
      if (d < 0.1) { way[k] = randWay(u); continue; }
      const sp = Math.min(wv[2], d), nx = u.x + dx / d * sp, ny = u.y + dy / d * sp;
      if (!walkable(nx, ny)) { way[k] = randWay(u); continue; }
      u.x = nx; u.y = ny; if (Math.abs(dx) > 0.05) u.face = dx < 0 ? -1 : 1;
    }
    for (const a of armies) {
      if (!a.members.length) continue;
      let tx = a.rally.x, ty = a.rally.y;
      if (a.mode === 'march' && a.target) { tx = a.target.x; ty = a.target.y; }
      const dx = tx - a.rally.x, dy = ty - a.rally.y, d = Math.hypot(dx, dy);
      if (a.mode === 'march' && d > 0.4) { const sp = Math.min(d, 0.07); a.rally.x += dx / d * sp; a.rally.y += dy / d * sp; }
      for (let m = 0; m < a.members.length; m++) {
        const u = S.units.get(a.members[m]); if (!u) continue;
        u.px = u.x; u.py = u.y;
        const ox = ((u.id * 37) % 7 - 3) * 0.28, oy = ((u.id * 53) % 7 - 3) * 0.28;
        const wx = a.rally.x + ox, wy = a.rally.y + oy, ddx = wx - u.x, ddy = wy - u.y, dd = Math.hypot(ddx, ddy);
        if (dd > 0.05 && walkable(wx, wy)) { const sp = Math.min(dd, 0.09); u.x += ddx / dd * sp; u.y += ddy / dd * sp; if (Math.abs(ddx) > 0.03) u.face = ddx < 0 ? -1 : 1; }
      }
    }
  }
  window.__r2Step = step;

  // ------------------------------------------------------------------ DOM + loop
  document.documentElement.style.cssText = 'margin:0;height:100%;background:#000';
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;height:100%;overflow:hidden;background:#000;touch-action:none;-webkit-user-select:none;user-select:none';
  const canvas = document.createElement('canvas');
  canvas.id = 'game';
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;display:block';
  document.body.appendChild(canvas);

  const r2 = window.__r2 = {
    scen, S, Render, Input, Const, Sprites, World, regions, kingdoms, cities, units, armies, wars, civ, buildings, genMs, apiCalls, cmdKid, frames: 0, still: STILL, step, byId, setCtrl,
    /** change ownership of a region (and its cities) + touch */
    setOwner(rid, kid) { const r = byId(rid); r.ownerId = kid; r.controllerId = kid; for (const cid of r.cityIds) { const c = S.cities.get(cid); if (c) { c.kingdomId = kid; c.occupierId = 0; } } S.touchRegions(); },
    setController(rid, kid) { setCtrl(byId(rid), kid); S.touchRegions(); },
    touch() { S.touchRegions(); },
    regionOf(x, y) { return S.region[(y | 0) * W + (x | 0)]; },
  };
  Render.init(canvas);
  Render.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  Render.setMode(Const.MODE.BORDERS);
  if (!NOWARS && !NOREG) Render.cmd = { kid: cmdKid, regionId: 0, armyId: 0, goals: [], candidates: [], targetKid: 0 };
  Input.init(canvas, { onTap(tx, ty) { r2.taps = (r2.taps || 0) + 1; r2.lastTap = [tx, ty]; }, onPaint() {}, onHover() {} });
  window.addEventListener('resize', () => Render.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1));
  if (NOREG) { S.regions.clear(); S.region.fill(0); }

  let last = 0, accT = 0;
  const TICK_MS = 100;
  function frame(now) {
    if (!last) last = now;
    const dt = Math.min(250, now - last); last = now;
    if (!r2.still) {
      accT += dt;
      let n = 0;
      while (accT >= TICK_MS && n++ < 6) { step(); accT -= TICK_MS; }
      if (accT > TICK_MS) accT = 0;
    }
    Render.draw(accT / TICK_MS, now);
    r2.frames++;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.__r2Ready = true;
})();
