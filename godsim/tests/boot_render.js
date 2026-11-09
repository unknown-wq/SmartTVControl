// Bootstrap for the Render + Input browser tests. Appended INSIDE the game scope by
//   node build.mjs --stubs --no-main --extra=tests/boot_render.js --out=/tmp/godsim-render.html
// Generates a real world (World.generate), fabricates Kingdom / City / Building / Unit objects straight into S
// (per CONTRACT section 2 schemas), animates fake unit movement + fires + Fx + S.eff, and runs Render.draw in rAF.
// URL params: size=96 seed=7 units=160 still=1 (no tick animation) fx=0
// Exposes window.__rt for tests/render.test.mjs.
(function () {
  const q = new URLSearchParams(location.search);
  const SIZE = +(q.get('size') || 96), SEED = +(q.get('seed') || 7), NU = +(q.get('units') || 160);
  const STILL = q.get('still') === '1', FXON = q.get('fx') !== '0';
  const B = Const.B, T = Const.T;

  Sprites.init();
  const tg0 = performance.now();
  World.generate({ seed: SEED, w: SIZE, h: SIZE });
  const genMs = performance.now() - tg0;

  // ---- tiny deterministic RNG for the fake content (not the sim R) ----
  let rs = SEED * 7919 + 13;
  const rnd = () => { rs = (rs + 0x6D2B79F5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ri = n => (rnd() * n) | 0;
  const W = S.w, H = S.h;
  const isGrass = (x, y) => x >= 0 && y >= 0 && x < W && y < H && S.tile[y * W + x] === T.GRASS && !S.res[y * W + x];

  // ---- cultures, kingdoms, cities ----
  S.cultures = [
    { id: 0, name: 'Культура 1', color: Palette.culture[0], race: 0 },
    { id: 1, name: 'Культура 2', color: Palette.culture[1], race: 1 },
    { id: 2, name: 'Культура 3', color: Palette.culture[2], race: 2 },
  ];
  const sites = [];
  const want = +(q.get('cities') || 7);
  for (let tries = 0; tries < 4000 && sites.length < want; tries++) {
    const x = 6 + ri(W - 12), y = 6 + ri(H - 12);
    if (!isGrass(x, y)) continue;
    if (sites.some(s => Math.hypot(s[0] - x, s[1] - y) < 13)) continue;
    // want some land around
    let land = 0; for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) if (S.tile[(y + dy) * W + x + dx] >= T.SAND) land++;
    if (land < 55) continue;
    sites.push([x, y]);
  }
  const kingdoms = [];
  const kdef = [{ race: 0, name: 'Аран' }, { race: 1, name: 'Орда Гор' }, { race: 2, name: 'Лотлориэн' }];
  for (let k = 0; k < Math.min(3, sites.length); k++) {
    const id = S.id(), c1 = Palette.kingdom[k * 3 % 16];
    const kd = { id, name: kdef[k].name, race: kdef[k].race, color: c1, flag: { pattern: (k * 2 + 1) % 6, symbol: (k * 3 + 2) % 10, c1, c2: '#ffffff', c3: '#f2c230' },
      capitalId: 0, rulerId: 0, cities: [], culture: k, stability: 70, born: 0, alive: true, clan: 'Дом ' + (k + 1), hist: [] };
    S.kingdoms.set(id, kd); kingdoms.push(kd);
  }
  const cities = [];
  const CN = ['Вестград', 'Дорвен', 'Грушмок', 'Эрилтон', 'Сильвин', 'Тарбург', 'Мирхолм', 'Каллин'];
  sites.forEach((s, i) => {
    const kd = kingdoms[i % kingdoms.length];
    const id = S.id();
    const c = { id, name: CN[i % CN.length], race: kd.race, kingdomId: kd.id, x: s[0], y: s[1], pop: 5 + ri(40), members: [], stock: { food: 20, wood: 20, stone: 5, iron: 0, gold: 0 },
      radius: 8, level: 1 + (i % 3), loyalty: 80, culture: kd.culture, founded: 0, buildings: [], hist: [], mod: {} };
    S.cities.set(id, c); cities.push(c); kd.cities.push(id); if (!kd.capitalId) kd.capitalId = id;
  });
  // territories: nearest city centre within radius wins, land only
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (S.tile[y * W + x] < T.SAND || S.tile[y * W + x] === T.LAVA) continue;
    let best = 0, bd = 1e9;
    for (const c of cities) { const d = Math.hypot(c.x - x, c.y - y); if (d < c.radius + 0.5 && d < bd) { bd = d; best = c.id; } }
    S.owner[y * W + x] = best;
  }
  S.touchOwner();

  // ---- buildings ----
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
    const types = [B.HOUSE, B.HOUSE, B.HOUSE, B.HOUSE, B.HOUSE, B.FARM, B.FARM, B.STORAGE, B.BARRACKS, B.TEMPLE, B.MARKET, B.HOUSE];
    let placed = 0;
    for (let tries = 0; tries < 200 && placed < types.length; tries++) {
      const x = c.x + ri(11) - 5, y = c.y + ri(11) - 5;
      if (Math.abs(x - c.x) + Math.abs(y - c.y) < 2) continue;
      const done = placed < 9;
      const b = placeB(c, types[placed], x, y, done, 0.2 + rnd() * 0.6);
      if (b) {
        if (placed === 3) { b.hp = 12; }                    // damaged house
        placed++;
      }
    }
  }

  // ---- units ----
  const units = [];
  const way = [];
  function walkable(x, y) { x |= 0; y |= 0; return x >= 0 && y >= 0 && x < W && y < H && Tiles.walkable(S.tile[y * W + x]) && S.tile[y * W + x] !== T.SHALLOW; }
  function randLand() { for (let t = 0; t < 400; t++) { const x = ri(W), y = ri(H); if (walkable(x, y)) return [x + 0.5, y + 0.5]; } return [W / 2, H / 2]; }
  const STATES = ['idle', 'wander', 'walk', 'gather', 'carry', 'build', 'farm', 'sleep'];
  function spawn(n) {
    for (let k = 0; k < n; k++) {
      const c = cities.length ? cities[ri(cities.length)] : null;
      let pos = null;
      if (c && rnd() < 0.8) { for (let t = 0; t < 30; t++) { const x = c.x + (rnd() - 0.5) * 16, y = c.y + (rnd() - 0.5) * 16; if (walkable(x, y)) { pos = [x, y]; break; } } }
      if (!pos) pos = randLand();
      const race = c && rnd() < 0.85 ? c.race : ri(3);
      const id = S.id();
      const adult = rnd() < 0.75, elder = !adult && rnd() < 0.4;
      const u = { id, race, sex: ri(2), name: 'U' + id, clan: 'К', born: S.tick - (adult ? 25 : elder ? 70 : 6) * Const.TICKS_PER_YEAR, x: pos[0], y: pos[1], px: pos[0], py: pos[1], face: rnd() < 0.5 ? -1 : 1,
        hp: 20, maxHp: 20, hunger: 10, energy: 80, level: 1, xp: 0, kills: 0, traits: [0, 6], cityId: c ? c.id : 0, kingdomId: c ? c.kingdomId : 0,
        weapon: ri(4), armor: ri(4), state: STATES[ri(STATES.length)], st: {}, job: null, carry: rnd() < 0.15 ? Const.GOODS[ri(5)] : null, carryAmt: 1,
        fatherId: 0, motherId: 0, spouseId: 0, armyId: 0, isRuler: false, sick: 0, buffUntil: 0, buffMul: 1, burning: 0, nextThink: 0, birthCd: 0, hist: [] };
      if (rnd() < 0.12) u.hp = 4 + ri(14);
      if (rnd() < 0.04) u.sick = S.tick + 100000;
      if (rnd() < 0.03) u.burning = S.tick + 100000;
      if (rnd() < 0.04) u.buffUntil = S.tick + 100000;
      S.units.set(id, u); units.push(u); way.push(randWay(u));
    }
  }
  function randWay(u) {
    for (let t = 0; t < 12; t++) { const x = u.x + (rnd() - 0.5) * 14, y = u.y + (rnd() - 0.5) * 14; if (walkable(x, y)) return [x, y, 0.07 + rnd() * 0.12, S.tick + 20 + ri(80)]; }
    return [u.x, u.y, 0, S.tick + 30];
  }
  spawn(NU);
  // rulers
  for (const kd of kingdoms) { const u = units.find(v => v.kingdomId === kd.id && Util.age(v) > 20); if (u) { u.isRuler = true; kd.rulerId = u.id; } }

  // ---- fires ----
  const fires = [];
  function addFire(cx, cy, r) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (dx * dx + dy * dy > r * r + 1 || rnd() < 0.25) continue;
      const i = y * W + x; if (S.tile[i] < T.SAND || S.tile[i] === T.LAVA) continue;
      S.fire[i] = 255; fires.push(i);
    }
  }
  if (cities.length) addFire(cities[0].x + 6, cities[0].y - 5, 2);
  addFire(W >> 1, H >> 1, 1);

  // ---- tick (fake sim) ----
  function step() {
    S.tick++;
    for (let k = 0; k < units.length; k++) {
      const u = units[k], wv = way[k];
      u.px = u.x; u.py = u.y;
      if (u.state === 'sleep' && rnd() < 0.98) continue;
      if (S.tick > wv[3] || wv[2] === 0) { way[k] = randWay(u); continue; }
      const dx = wv[0] - u.x, dy = wv[1] - u.y, d = Math.hypot(dx, dy);
      if (d < 0.1) { way[k] = randWay(u); continue; }
      const sp = Math.min(wv[2], d), nx = u.x + dx / d * sp, ny = u.y + dy / d * sp;
      if (!walkable(nx, ny)) { way[k] = randWay(u); continue; }
      u.x = nx; u.y = ny;
      if (Math.abs(dx) > 0.05) u.face = dx < 0 ? -1 : 1;
    }
  }
  window.__rtStep = step;

  // ---- fx / effects demo ----
  const FXTYPES = ['explosion', 'lightning', 'fire', 'smoke', 'heal', 'bless', 'plague', 'quake', 'dust', 'spark', 'splash', 'blood', 'whisper', 'ash'];
  let fxT = 0;
  function demoEffects() {
    const cx = W / 2, cy = H / 2;
    S.eff.meteors.push({ x: cx - 5, y: cy + 4, r: 3, t0: S.tick, eta: S.tick + 60 });
    S.eff.tornados.push({ x: cx + 6, y: cy - 5, dx: 0.05, dy: 0, until: S.tick + 1e6, r: 2 });
    S.eff.rains.push({ x: cx - 8, y: cy - 6, r: 4, until: S.tick + 1e6 });
    S.eff.quakes.push({ x: cx + 7, y: cy + 7, r: 3, until: S.tick + 1e6 });
  }

  // ---- DOM + render loop ----
  document.documentElement.style.cssText = 'margin:0;height:100%;background:#000';
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;height:100%;overflow:hidden;background:#000;touch-action:none;-webkit-user-select:none;user-select:none';
  const canvas = document.createElement('canvas');
  canvas.id = 'game';
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;display:block';
  document.body.appendChild(canvas);

  const rt = window.__rt = { S, Render, Input, taps: [], paints: [], hovers: [], genMs, cities, kingdoms, units, buildings, frames: 0, still: STILL, tickAcc: 0, demoEffects, spawn, addFire, step, brushOn: true, autoHighlight: true, Fx, World, Const, Sprites, Util };
  Render.init(canvas);
  Render.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  Input.init(canvas, {
    onTap(tx, ty) {
      rt.taps.push([tx, ty]);
      if (!rt.autoHighlight) return;
      let best = null, bd = 1.2;
      for (const u of S.units.values()) { const d = Math.hypot(u.x - tx, u.y - ty); if (d < bd) { bd = d; best = { type: 'unit', id: u.id, x: u.x, y: u.y }; } }
      if (!best) for (const b of S.buildings.values()) if (Math.abs(b.x + 0.5 - tx) < 0.7 && Math.abs(b.y + 0.5 - ty) < 0.7) best = { type: 'building', id: b.id, x: b.x, y: b.y };
      Render.highlight = best || { type: 'tile', id: 0, x: Math.floor(tx), y: Math.floor(ty) };
    },
    onPaint(tx, ty, phase) { rt.paints.push([tx, ty, phase]); if (rt.brushOn) Render.brush = phase === 'end' ? null : { x: tx, y: ty, r: 3 }; },
    onHover(tx, ty) { rt.hovers.push([tx, ty]); if (rt.brushOn && Input.mode === 'paint') Render.brush = { x: tx, y: ty, r: 3 }; },
  });
  window.addEventListener('resize', () => Render.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1));

  let last = 0, acc = 0;
  const TICK_MS = 100;
  function frame(now) {
    if (!last) last = now;
    const dt = Math.min(250, now - last); last = now;
    if (!rt.still) {
      acc += dt;
      let n = 0;
      while (acc >= TICK_MS && n++ < 6) { step(); acc -= TICK_MS; }
      if (acc > TICK_MS) acc = 0;
      Fx.update(dt / 1000);
      if (FXON) {
        fxT += dt;
        if (fxT > 700) {
          fxT = 0;
          const t = FXTYPES[ri(FXTYPES.length)], cx = W / 2 + (rnd() - 0.5) * 24, cy = H / 2 + (rnd() - 0.5) * 24;
          Fx.add(t, cx, cy, { ttl: 1.2, r: 2 });
        }
      }
    }
    const a = acc / TICK_MS;
    Render.draw(a, now);
    rt.frames++;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.__rtReady = true;
})();
