/* =====================================================================
 * 11_powers.js — Powers: every god tool in ToolDefs + the persistent effects in S.eff
 * OWNER: Powers agent. API: docs/CONTRACT.md §3 Powers.   DOM-free (runs headless in node).
 *
 *  - Powers.apply(toolId, tx, ty, radius, phase) -> boolean   handles EVERY ToolDefs id (terrain brushes, creatures, erase,
 *    lightning, meteor, fire, earthquake, plague, tornado, rain, heal, bless, war_whisper, peace, split, inspect).
 *    `phase`: 'tap' | 'start' | 'move' | 'end'. Non-drag tools act on tap/start only; drag tools are rate-limited on 'move'
 *    (a move acts only after the finger travelled >= 0.5 tile or 3 ticks passed; brushes fill the gap with interpolated stamps).
 *    Returns true when the power took effect, false when it was throttled / had no target / failed.
 *    Powers.lastMessage = short Russian text about the last apply() (success text, or the reason of a failure for a toast);
 *    '' when the call was silently ignored (throttled move, 'end', move of a non-drag tool).
 *  - Powers.pick(tx, ty) -> {type:'unit'|'building'|'city'|'region'|'tile', id, x, y} | null (null = outside the map).
 *    Stage 2: empty LAND inside a region (owned or wild) is {type:'region', id: regionId}; water / specks without a region stay 'tile'.
 *  - Persistent effects live in S.eff (JSON-safe, saved with the world), advanced by Powers.step(tick):
 *      meteors [{x,y,r,eta,t0}]   tornados [{x,y,dx,dy,until,r, nt}]   rains [{x,y,r,until}]   quakes [{x,y,r,until, t0,b,n,m,h}]
 *    (extra fields are private to this module; Render only reads x,y,r,eta,t0).
 *  - Private non-persistent state: the drag throttle (cleared on newWorld/afterLoad). All randomness goes through R.
 * ===================================================================== */

const Powers = (() => {
  const T = Const.T, RES = Const.RES, LOG = Const.LOG, TAU = Math.PI * 2;

  // ------------------------------------------------------------------ tunables
  const METEOR_DELAY = 8, METEOR_CAP = 8;
  const TORNADO_LIFE = 450, TORNADO_CAP = 3, TORNADO_R = 2;
  const RAIN_LIFE = 200, RAIN_CAP = 12;
  const QUAKE_LIFE = 30, QUAKE_CAP = 4;
  const BLESS_TICKS = 900, BLESS_MUL = 1.4;
  const PLAGUE_P = 0.6;
  const MAX_STAMPS = 6;

  // ------------------------------------------------------------------ private runtime state (non-persistent)
  const drag = { tool: '', x: 0, y: 0, tick: -999, sx: 0, sy: 0, st: -999, n: 0 };
  let lastMessage = '';
  let errCount = 0, lastError = null;
  const buf = [];                                   // scratch list of units (tornado)
  const stX = new Float64Array(MAX_STAMPS), stY = new Float64Array(MAX_STAMPS);
  function pushBuf(u) { buf.push(u); }

  // ------------------------------------------------------------------ helpers
  function num(v, d) { return (typeof v === 'number' && v === v && v > -1e7 && v < 1e7) ? v : d; }
  function rInt(r, lo, hi, d) { r = Math.round(num(r, d)); return r < lo ? lo : r > hi ? hi : r; }
  function inMap(x, y) { return x >= 0 && y >= 0 && x < S.w && y < S.h; }
  function msg(text, ok) { lastMessage = text; return ok; }
  function report(e, where) {
    errCount++; lastError = e;
    if (errCount <= 5 && typeof console !== 'undefined') console.error('Powers ' + where + ':', e && e.stack || e);
  }
  function inRad(x, y, r) {
    const a = Units.inRadius(x, y, r);
    return Array.isArray(a) ? a : [];
  }
  function alive(u) { return !!u && S.units.get(u.id) === u; }
  function fx(type, x, y, o) { return Fx.add(type, x, y, o); }
  function eff() {
    let e = S.eff;
    if (!e || typeof e !== 'object') e = S.eff = {};
    if (!Array.isArray(e.meteors)) e.meteors = [];
    if (!Array.isArray(e.tornados)) e.tornados = [];
    if (!Array.isArray(e.rains)) e.rains = [];
    if (!Array.isArray(e.quakes)) e.quakes = [];
    return e;
  }
  function isWaterT(t) { return t === T.DEEP || t === T.SHALLOW; }
  function nearestCity(x, y, maxD) {
    let best = null, bd = maxD * maxD;
    for (const c of S.cities.values()) {
      const dx = c.x + 0.5 - x, dy = c.y + 0.5 - y, d = dx * dx + dy * dy;
      if (d <= bd) { bd = d; best = c; }
    }
    return best;
  }
  /** chance that a brush of fire / lightning sets this tile alight (World.ignite has the final word on flammability) */
  function burnChance(i, grassP) {
    if (S.bld[i]) return 0.8;
    const t = S.tile[i], rk = S.res[i];
    if (t === T.FOREST) return 0.85;
    if (rk === RES.TREE) return 0.8;
    if (rk === RES.BERRY) return 0.5;
    if (t === T.GRASS) return grassP || 0.45;
    if (t === T.HILL) return 0.12;
    return 0;
  }
  /** points of a stroke between the previous and the current finger position (fills stX/stY, returns the count) */
  function plan(x0, y0, x1, y1, spacing) {
    const dx = x1 - x0, dy = y1 - y0, len = Math.sqrt(dx * dx + dy * dy);
    let n = Math.ceil(len / spacing);
    if (n < 1) n = 1; else if (n > MAX_STAMPS) n = MAX_STAMPS;
    for (let k = 1; k <= n; k++) { const t = k / n; stX[k - 1] = x0 + dx * t; stY[k - 1] = y0 + dy * t; }
    return n;
  }
  function removeBuilding(x, y, cause) {
    const id = S.bld[y * S.w + x];
    if (!id) return false;
    return Buildings.destroyAt(x, y, cause) === true;
  }

  // ------------------------------------------------------------------ terrain brushes
  const TFX = { raise: '#a88a5c', lower: '#7a6444', grass: '#6fbf4a', sand: '#e6d49a', forest: '#3d8a3a', hill: '#9a8a5a', mountain: '#8a8688', snow: '#f2f7ff' };
  function fxTerrain(id, x, y, r) {
    if (id === 'lava') {
      fx('smoke', x, y, { ttl: 0.9 });
      fx('fire', x, y, { ttl: 0.6 });
      return;
    }
    fx('dust', x, y, { ttl: 0.55, color: TFX[id] });
    if (r >= 3) fx('dust', x + R.between(-r, r) * 0.6, y + R.between(-r, r) * 0.6, { ttl: 0.5, color: TFX[id] });
  }
  function brushAt(id, x, y, r) {
    const n = World.brush(id, x, y, r);
    return typeof n === 'number' && n === n ? n : 0;
  }
  function terrainTool(id, x, y, r, first, lx, ly) {
    let changed = 0;
    if (first) {
      changed = brushAt(id, x, y, r);
      fxTerrain(id, x, y, r);
    } else {
      const n = plan(lx, ly, x, y, Math.max(1, r * 0.8));
      for (let k = 0; k < n; k++) changed += brushAt(id, stX[k], stY[k], r);
      if ((drag.n++ & 1) === 0) fxTerrain(id, x, y, r);
    }
    return msg(changed > 0 ? 'Ландшафт изменён' : 'Ничего не изменилось', changed > 0);
  }

  // ------------------------------------------------------------------ creatures / erase
  const RACE_OF = { human: Const.RACE.HUMAN, orc: Const.RACE.ORC, elf: Const.RACE.ELF };
  function creatureTool(id, x, y, r, first) {
    let count;
    if (first) {
      count = Math.round(Math.PI * r * r / 2);
      if (count < 1) count = 1; else if (count > 6) count = 6;
    } else {
      // drag: one creature per 4 ticks (or per 2 tiles of travel when the clock is paused)
      if (S.tick - drag.st < 4 && Util.dist(x, y, drag.sx, drag.sy) < 2) return false;
      count = 1;
    }
    const race = RACE_OF[id];
    const rad = r + 0.25;
    let made = 0, tries = 0;
    while (made < count && tries < count * 14) {
      tries++;
      const a = R.f() * TAU, d = Math.sqrt(R.f()) * rad;
      const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      if (!inMap(px, py)) continue;
      const pi = (py | 0) * S.w + (px | 0), t = S.tile[pi];
      if (!Tiles.isLand(t) || S.fire[pi]) continue;
      const u = Units.spawn(race, px, py, {});
      if (!u) { if (S.units.size >= (S.perf.unitCap || Const.MAX_UNITS)) break; continue; }
      made++;
      fx('spark', px, py, { ttl: 0.6, n: 6 });
    }
    drag.st = S.tick; drag.sx = x; drag.sy = y;
    if (made > 0) return msg('Создано: ' + made, true);
    const capped = S.units.size >= (S.perf.unitCap || Const.MAX_UNITS);
    return msg(capped ? 'Достигнут предел населения' : 'Здесь нельзя создать существ', false);
  }

  function eraseTool(x, y, r, first, lx, ly) {
    let n = 0;
    const pts = first ? 1 : plan(lx, ly, x, y, Math.max(1, r * 0.8));
    for (let k = 0; k < pts; k++) {
      const px = first ? x : stX[k], py = first ? y : stY[k];
      const list = inRad(px, py, r + 0.5);
      for (let i = 0; i < list.length; i++) {
        if (i < 6) fx('blood', list[i].x, list[i].y, { ttl: 0.5 });
      }
      const c = Units.eraseInRadius(px, py, r + 0.5);
      if (typeof c === 'number') n += c;
    }
    return msg(n > 0 ? 'Стёрто существ: ' + n : 'Тут никого нет', n > 0);
  }

  // ------------------------------------------------------------------ lightning
  function lightning(x, y) {
    x = num(x, NaN); y = num(y, NaN);
    if (!(x === x) || !(y === y) || !S.tile || !inMap(x, y)) return msg('Вне карты', false);
    const tx = x | 0, ty = y | 0, w = S.w, i0 = ty * w + tx;
    const water = isWaterT(S.tile[i0]);
    fx('lightning', x, y, { ttl: 0.75 });
    fx('explosion', x, y, { ttl: 0.55, r: 1.2 });
    fx('spark', x, y, { ttl: 0.7, n: 10 });
    fx('quake', x, y, { ttl: 0.35, r: 1, shake: 0.25 });
    if (water) fx('splash', x, y, { ttl: 0.7 });
    // creatures (rulers' deaths are logged by Units itself)
    let killed = 0;
    const list = inRad(x, y, 1.2);
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (Units.damage(u, 40, 'lightning') === true) killed++;
      else if (alive(u)) u.burning = S.tick + 20;
    }
    // buildings, saplings and fire on the struck tile and its neighbours
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = tx + dx, yy = ty + dy;
        if (!inMap(xx, yy)) continue;
        const centre = dx === 0 && dy === 0;
        if (!centre && Util.dist(xx + 0.5, yy + 0.5, x, y) > 1.3) continue;
        const i = yy * w + xx;
        if (S.bld[i]) Buildings.damageAt(xx, yy, centre ? 60 : 30, 'lightning');
        if (S.res[i] === RES.TREE && (centre || R.chance(0.6))) {
          S.res[i] = 0; S.amt[i] = 0; S.markDirty(xx, yy);
          fx('smoke', xx + 0.5, yy + 0.5, { ttl: 0.8 });
        }
        const p = burnChance(i, 0.6) * (centre ? 1 : 0.4);               // a struck forest / house / grass tile (60%) catches fire
        if (p > 0 && R.f() < p && World.ignite(xx, yy)) fx('fire', xx + 0.5, yy + 0.5, { ttl: 0.7 });
      }
    }
    return msg(killed > 0 ? 'Молния убила: ' + killed : 'Молния!', true);
  }

  // ------------------------------------------------------------------ meteor
  function meteor(x, y, r) {
    x = num(x, NaN); y = num(y, NaN);
    if (!(x === x) || !(y === y) || !S.tile || !inMap(x, y)) return msg('Вне карты', false);
    r = rInt(r, 2, 6, 2);
    const L = eff().meteors;
    if (L.length >= METEOR_CAP) return msg('Небо уже в огне', false);
    L.push({ x, y, r, eta: S.tick + METEOR_DELAY, t0: S.tick });
    return msg('Метеорит летит!', true);
  }

  function impact(e) {
    const cx = e.x, cy = e.y, r = e.r > 0 ? e.r : 2, w = S.w, h = S.h;
    const tx = Math.floor(cx), ty = Math.floor(cy);
    if (!inMap(tx, ty)) return;
    const rc = r * 0.7, rl = Math.max(0.8, r * 0.38), rf = r * 1.15, blast = r * 1.9 + 1;
    const pop0 = S.units.size, bld0 = S.buildings.size;
    const city = nearestCity(cx, cy, r + 14);
    // 1) creatures: lethal in the crater, falloff in the blast wave
    const list = inRad(cx, cy, blast);
    for (let i = 0; i < list.length; i++) {
      const u = list[i], d = Util.dist(u.x, u.y, cx, cy);
      if (d <= rc + 0.4) Units.damage(u, 999, 'meteor');
      else Units.damage(u, 50 * (1 - (d - rc) / (blast - rc)), 'meteor');
    }
    // 2) terrain: lava core, hill / mountain rim, burning surroundings
    const ri = Math.ceil(rf) + 1;
    let lava = 0;
    for (let yy = Math.max(0, ty - ri); yy <= Math.min(h - 1, ty + ri); yy++) {
      for (let xx = Math.max(0, tx - ri); xx <= Math.min(w - 1, tx + ri); xx++) {
        const d = Util.dist(xx + 0.5, yy + 0.5, cx, cy);
        const centre = xx === tx && yy === ty;
        if (d > rf && !centre) continue;
        const i = yy * w + xx, t = S.tile[i];
        const water = isWaterT(t);
        if (d <= rc || centre) {
          if (S.bld[i]) removeBuilding(xx, yy, 'meteor');
          if (water) {
            if (R.f() < 0.3) fx('splash', xx + 0.5, yy + 0.5, { ttl: 0.7 });
            continue;
          }
          if (t === T.LAVA) continue;
          if (d <= rl || centre) {
            World.setTile(xx, yy, T.LAVA); lava++;
          } else if (r >= 3 && d > rc * 0.8 && R.chance(0.25)) {
            World.setTile(xx, yy, T.MOUNTAIN, { elev: 196 + R.i(14) });          // ridge of ejecta
          } else {
            World.setTile(xx, yy, T.HILL, { elev: 164 + R.i(20) });              // lowered, rubble-filled bowl
          }
        } else if (!water) {
          const bid = S.bld[i];
          if (bid) Buildings.damageAt(xx, yy, 70 * (1 - (d - rc) / (rf - rc + 0.01)), 'meteor');
          if (S.res[i] === RES.TREE || S.res[i] === RES.BERRY) { S.res[i] = 0; S.amt[i] = 0; S.markDirty(xx, yy); }
          if (R.f() < 0.65) World.ignite(xx, yy);
        }
      }
    }
    // 3) show
    fx('explosion', cx, cy, { ttl: 1.0, r: r * 1.35 });
    fx('explosion', cx + R.between(-0.6, 0.6) * r * 0.4, cy + R.between(-0.6, 0.6) * r * 0.4, { ttl: 0.8, r: r * 0.8 });
    fx('quake', cx, cy, { ttl: 0.9, r: r * 1.2, shake: Math.min(1, 0.3 + r * 0.1) });
    fx('dust', cx, cy, { ttl: 1.0 });
    for (let k = 0; k < 3; k++) {
      const a = R.f() * TAU, d = R.f() * rc + 0.5;
      fx('ash', cx + Math.cos(a) * d, cy + Math.sin(a) * d, { ttl: 1.4 });
      fx('smoke', cx + Math.cos(a + 1.7) * d, cy + Math.sin(a + 1.7) * d, { ttl: 1.2, n: 3 });
    }
    fx('spark', cx, cy, { ttl: 0.8, n: 12 });
    // 4) chronicle
    const dead = pop0 - S.units.size, razed = bld0 - S.buildings.size;
    if (dead >= 3 || razed >= 2) {
      const where = city ? ' рядом с «' + city.name + '»' : '';
      const parts = [];
      if (dead > 0) parts.push('погибло: ' + dead);
      if (razed > 0) parts.push('разрушено построек: ' + razed);
      Log.add('Метеорит упал' + where + ' (' + parts.join(', ') + ')', LOG.DISASTER, tx, ty, city ? city.kingdomId : 0);
    }
  }

  function stepMeteors(tick) {
    const L = eff().meteors;
    if (L.length === 0) return;
    let wr = 0;
    for (let k = 0; k < L.length; k++) {
      const e = L[k];
      if (!e || !(e.x === e.x) || !(e.y === e.y)) continue;
      if (tick >= e.eta) {
        try { impact(e); } catch (err) { report(err, 'meteor impact'); }
        continue;
      }
      L[wr++] = e;
    }
    L.length = wr;
  }

  // ------------------------------------------------------------------ fire
  function fireTool(x, y, r, first, lx, ly) {
    const pts = first ? 1 : plan(lx, ly, x, y, Math.max(1, r * 0.8));
    let lit = 0;
    for (let k = 0; k < pts; k++) {
      const px = first ? x : stX[k], py = first ? y : stY[k];
      lit += fireAt(px, py, r, k === pts - 1);
    }
    return msg(lit > 0 ? 'Огонь!' : 'Нечему гореть', lit > 0);
  }
  function fireAt(x, y, r, withFx) {
    const w = S.w, h = S.h, rr = r + 0.5, cx = Math.floor(x), cy = Math.floor(y);
    let lit = 0, fxLeft = 4;
    // creatures in the flames catch fire
    const list = inRad(x, y, rr);
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (R.f() < 0.5) Units.damage(u, 3, 'fire');
    }
    for (let yy = Math.max(0, cy - r); yy <= Math.min(h - 1, cy + r); yy++) {
      for (let xx = Math.max(0, cx - r); xx <= Math.min(w - 1, cx + r); xx++) {
        const d = Util.dist(xx + 0.5, yy + 0.5, x, y);
        if (d > rr) continue;
        const p = burnChance(yy * w + xx) * (1 - 0.35 * d / rr);
        if (p > 0 && R.f() < p && World.ignite(xx, yy)) {
          lit++;
          if (withFx && fxLeft > 0) { fxLeft--; fx('fire', xx + 0.5, yy + 0.5, { ttl: 0.7 }); }
        }
      }
    }
    if (lit === 0 && inMap(cx, cy)) {                   // always try the tile under the finger once
      for (let dy = -1; dy <= 1 && lit === 0; dy++) {
        for (let dx = -1; dx <= 1 && lit === 0; dx++) {
          const xx = cx + dx, yy = cy + dy;
          if (!inMap(xx, yy) || Util.dist(xx + 0.5, yy + 0.5, x, y) > rr) continue;
          if (burnChance(yy * w + xx) > 0 && World.ignite(xx, yy)) { lit++; if (withFx) fx('fire', xx + 0.5, yy + 0.5, { ttl: 0.7 }); }
        }
      }
    }
    if (withFx && lit > 0 && r >= 3) fx('smoke', x, y, { ttl: 1.0 });
    return lit;
  }

  // ------------------------------------------------------------------ earthquake
  function earthquake(x, y, r) {
    x = num(x, NaN); y = num(y, NaN);
    if (!(x === x) || !(y === y) || !S.tile || !inMap(x, y)) return msg('Вне карты', false);
    r = rInt(r, 1, 8, 2);
    const L = eff().quakes;
    while (L.length >= QUAKE_CAP) L.shift();             // the oldest tremor gives way
    const q = { x, y, r: Math.max(2, Math.round(r * 1.5 * 2) / 2), until: S.tick + QUAKE_LIFE, t0: S.tick, b: r, n: 0, m: 8 + 2 * r, h: [] };
    L.push(q);
    launchCracks(q, 2);
    fx('quake', x, y, { ttl: 1.2, r: q.r, shake: Math.min(1, 0.4 + r * 0.08) });
    fx('dust', x, y, { ttl: 0.8 });
    return msg('Земля содрогается!', true);
  }
  function launchCracks(q, n) {
    for (let k = 0; k < n && q.n < q.m; k++) {
      const a = q.n * 2.399963229728653 + R.f() * 0.7;                      // golden-angle fan so cracks do not pile up
      q.h.push([q.x, q.y, a, Math.round(q.b * 1.6) + R.i(3)]);
      q.n++;
    }
  }
  function crackAt(tx, ty, q) {
    if (!inMap(tx, ty)) return;
    const w = S.w, i = ty * w + tx, t = S.tile[i];
    if (S.bld[i]) removeBuilding(tx, ty, 'earthquake');
    const near = inRad(tx + 0.5, ty + 0.5, 1.0);
    for (let k = 0; k < near.length; k++) if (R.f() < 0.7) Units.damage(near[k], 2 + R.i(5), 'earthquake');
    if (isWaterT(t) || t === T.LAVA) return;
    const hard = t === T.MOUNTAIN || t === T.HILL || t === T.SNOW;
    if (R.f() < (hard ? 0.33 : 0.2)) {
      World.setTile(tx, ty, T.LAVA);
      fx('smoke', tx + 0.5, ty + 0.5, { ttl: 1.0 });
    } else {
      let ne = S.elev[i] - (16 + R.i(26));
      if (ne < 72) ne = 72;                              // lowered land sinks at most into shallow water, never into a bottomless pit
      World.setTile(tx, ty, Tiles.fromElev(ne), { elev: ne });
    }
    if (R.f() < 0.5) fx('dust', tx + 0.5, ty + 0.5, { ttl: 0.7, color: '#8e7452' });
  }
  /** quakes created by someone else (or an old save) get the private crack bookkeeping on first use */
  function fixQuake(q) {
    if (!(q.b > 0)) q.b = Math.max(1, Math.min(8, Math.round((q.r || 2) / 1.5)));
    if (!(q.t0 >= 0)) q.t0 = Math.min(S.tick, q.until - QUAKE_LIFE);
    if (!(q.n >= 0)) q.n = 0;
    if (!(q.m >= 0)) q.m = 8 + 2 * q.b;
    if (!Array.isArray(q.h)) q.h = [];
    return q;
  }
  function stepQuake(q, tick) {
    if (!(q.until > tick)) return false;
    if (!Array.isArray(q.h)) fixQuake(q);
    const age = tick - q.t0;
    if (q.n < q.m && age % 2 === 0) launchCracks(q, q.b >= 5 ? 2 : 1);
    const hs = q.h;
    let wr = 0;
    for (let k = 0; k < hs.length; k++) {
      const hd = hs[k];
      hd[0] += Math.cos(hd[2]); hd[1] += Math.sin(hd[2]);
      hd[2] += R.gauss() * 0.55;
      hd[3]--;
      crackAt(Math.floor(hd[0]), Math.floor(hd[1]), q);
      if (hd[3] > 0 && inMap(hd[0], hd[1])) hs[wr++] = hd;
    }
    hs.length = wr;
    if (age > 0 && age % 8 === 0) fx('quake', q.x, q.y, { ttl: 0.5, r: Math.max(1, q.b * 0.6), shake: 0.25 });
    return true;
  }

  // ------------------------------------------------------------------ plague
  function plague(x, y, r) {
    x = num(x, NaN); y = num(y, NaN);
    if (!(x === x) || !(y === y) || !S.tile || !inMap(x, y)) return msg('Вне карты', false);
    r = rInt(r, 1, 8, 2);
    const list = inRad(x, y, r + 0.5);
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (!R.chance(PLAGUE_P)) continue;
      if (Units.infect(u, S.tick + 600 + R.i(300)) === true) {
        n++;
        if (n <= 6) fx('plague', u.x, u.y, { ttl: 0.9, r: 0.8 });
      }
    }
    fx('plague', x, y, { ttl: 1.1, r: r + 0.5 });
    if (n >= 5) {
      const c = nearestCity(x, y, r + 12);
      Log.add(c ? 'Чума поразила город «' + c.name + '»: заражено ' + n : 'Вспыхнула чума: заражено ' + n, LOG.DISASTER, x | 0, y | 0, c ? c.kingdomId : 0);
    }
    return msg(n > 0 ? 'Заражено: ' + n : 'Некого заражать', n > 0);
  }

  // ------------------------------------------------------------------ tornado
  function tornado(x, y) {
    x = num(x, NaN); y = num(y, NaN);
    if (!(x === x) || !(y === y) || !S.tile || !inMap(x, y)) return msg('Вне карты', false);
    const L = eff().tornados;
    while (L.length >= TORNADO_CAP) {
      const old = L.shift();
      fx('dust', old.x, old.y, { ttl: 1.0 });
    }
    const a = R.f() * TAU, sp = 0.12 + R.f() * 0.04;
    L.push({ x, y, dx: Math.cos(a) * sp, dy: Math.sin(a) * sp, until: S.tick + TORNADO_LIFE, r: TORNADO_R, nt: S.tick + 24 + R.i(14) });
    fx('dust', x, y, { ttl: 0.9 });
    fx('quake', x, y, { ttl: 0.5, r: 1.5, shake: 0.2 });
    return msg('Торнадо!', true);
  }
  function fling(u, cx, cy) {
    const a = Math.atan2(u.y - cy, u.x - cx) + R.between(-1.2, 1.2);
    const dist = 2 + R.f() * 1.2, ca = Math.cos(a), sa = Math.sin(a);
    let nx = u.x, ny = u.y;
    for (let s = 0.5; s <= dist; s += 0.5) {
      const px = u.x + ca * s, py = u.y + sa * s;
      if (!World.walkable(px, py)) break;
      nx = px; ny = py;
    }
    u.x = nx; u.y = ny;                                   // px,py stay: the renderer glides the unit through the air
    if (!u.armyId) {
      u.job = null; u.state = 'idle';
      u.st = { ph: '', since: S.tick, until: S.tick + 8 };
    }
    u.nextThink = S.tick + 2;
  }
  function stepTornado(e, tick) {
    if (!(e.until > tick)) { fx('dust', e.x, e.y, { ttl: 1.0 }); return false; }
    if (!(e.dx === e.dx) || typeof e.dx !== 'number') e.dx = 0;                // pushed by someone else without a heading
    if (!(e.dy === e.dy) || typeof e.dy !== 'number') e.dy = 0;
    if (!(e.r > 0)) e.r = TORNADO_R;
    if (typeof e.nt !== 'number') e.nt = tick + 24;
    if (tick >= e.nt) {                                   // wander: turn a little, change speed a little
      const sp = Util.clamp(Math.sqrt(e.dx * e.dx + e.dy * e.dy) * R.between(0.9, 1.1), 0.09, 0.17);
      const a = Math.atan2(e.dy, e.dx) + R.gauss() * 1.0;
      e.dx = Math.cos(a) * sp; e.dy = Math.sin(a) * sp;
      e.nt = tick + 24 + R.i(14);
    }
    let nx = e.x + e.dx, ny = e.y + e.dy;
    const m = 1.5;
    if (nx < m) { e.dx = Math.abs(e.dx); nx = m; } else if (nx > S.w - m) { e.dx = -Math.abs(e.dx); nx = S.w - m; }
    if (ny < m) { e.dy = Math.abs(e.dy); ny = m; } else if (ny > S.h - m) { e.dy = -Math.abs(e.dy); ny = S.h - m; }
    e.x = nx; e.y = ny;
    const tx = Math.floor(nx), ty = Math.floor(ny), w = S.w;
    const under = S.tile[ty * w + tx];
    if (under === T.DEEP) e.until -= 2; else if (under === T.SHALLOW) e.until -= 1;   // loses strength over the sea
    // trees are torn up
    if ((tick & 1) === 0) {
      for (let k = 0; k < 2; k++) {
        const a = R.f() * TAU, d = Math.sqrt(R.f()) * e.r;
        const px = Math.floor(nx + Math.cos(a) * d), py = Math.floor(ny + Math.sin(a) * d);
        if (!inMap(px, py)) continue;
        const pi = py * w + px;
        if (S.tile[pi] === T.FOREST) {
          World.harvest(px, py, RES.TREE, 45 + R.i(60));
          if (R.f() < 0.3) fx('dust', px + 0.5, py + 0.5, { ttl: 0.6, color: '#5a7a3a' });
        } else if (S.res[pi] === RES.TREE && R.f() < 0.5) {
          World.harvest(px, py, RES.TREE, 80);
        }
      }
    }
    // creatures and buildings under the funnel
    if ((tick & 3) === 0) {
      buf.length = 0;
      Units.nearby(nx, ny, e.r + 0.4, pushBuf);
      for (let k = 0; k < buf.length; k++) {
        const u = buf[k];
        if (Units.damage(u, 6, 'tornado') === true) continue;
        if (alive(u)) fling(u, nx, ny);
      }
      buf.length = 0;
      const ri = Math.ceil(e.r + 0.5);
      for (let yy = ty - ri; yy <= ty + ri; yy++) {
        for (let xx = tx - ri; xx <= tx + ri; xx++) {
          if (!inMap(xx, yy) || !S.bld[yy * w + xx]) continue;
          if (Util.dist(xx + 0.5, yy + 0.5, nx, ny) <= e.r + 0.5) Buildings.damageAt(xx, yy, 8, 'tornado');
        }
      }
      if ((tick & 15) === 0) fx('dust', nx, ny, { ttl: 0.7, color: '#b89c78' });
    }
    return true;
  }

  // ------------------------------------------------------------------ rain
  function rain(x, y, r) {
    x = num(x, NaN); y = num(y, NaN);
    if (!(x === x) || !(y === y) || !S.tile || !inMap(x, y)) return msg('Вне карты', false);
    r = rInt(r, 2, 8, 3);
    const L = eff().rains, until = S.tick + RAIN_LIFE;
    let merged = false;
    for (let i = 0; i < L.length; i++) {                 // a cloud that is nearly in the same place just gets refreshed
      const e = L[i];
      if (Util.dist(e.x, e.y, x, y) < 0.6 * Math.max(e.r, r)) {
        if (e.until < until) e.until = until;
        if (e.r < r) e.r = r;
        merged = true;
        break;
      }
    }
    if (!merged) {
      if (L.length >= RAIN_CAP) {                         // drop the cloud that would end first
        let oi = 0;
        for (let i = 1; i < L.length; i++) if (L[i].until < L[oi].until) oi = i;
        L.splice(oi, 1);
      }
      L.push({ x, y, r, until });
    }
    const n = World.extinguish(x, y, r);
    if (n > 0) fx('smoke', x, y, { ttl: 0.9, n: 3 });
    return msg('Дождь', true);
  }
  let douseTick = 0;
  function douse(u) { if (u.burning > douseTick) u.burning = 0; }
  function stepRain(e, tick) {
    if (!(e.until > tick)) return false;
    if ((tick + (e.r | 0)) % 5 === 0) {
      World.extinguish(e.x, e.y, e.r);
      douseTick = tick;
      Units.nearby(e.x, e.y, e.r, douse);                 // creatures that burn in the rain are put out
    }
    return true;
  }

  // ------------------------------------------------------------------ heal / bless
  function healTool(x, y, r, first, lx, ly) {
    const pts = first ? 1 : plan(lx, ly, x, y, Math.max(1, r * 0.8));
    let n = 0, shown = 0;
    for (let k = 0; k < pts; k++) {
      const px = first ? x : stX[k], py = first ? y : stY[k];
      const list = inRad(px, py, r + 0.5);
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        const needs = u.hp < u.maxHp || u.sick > S.tick || u.burning > S.tick || u.poison > S.tick; if (u.poison) u.poison = 0;   // plugin «Яд» (17_power_poison.js): healing is the antidote
        if (u.sick > S.tick) { u.sick = 0; u.immune = Math.max(u.immune | 0, S.tick + 400); }
        Units.heal(u, u.maxHp);
        u.hp = u.maxHp;
        u.sick = 0;
        if (u.rad) u.rad = 0;                                 // radiation sickness (nuke fallout, src/18_power_nuke.js) is cured too
        if (needs) { n++; if (shown < 5) { shown++; fx('heal', u.x, u.y, { ttl: 0.9, r: 0.8 }); } }
      }
      if (k === pts - 1) fx('heal', px, py, { ttl: 0.9, r: r + 0.5 });
    }
    return msg(n > 0 ? 'Исцелено: ' + n : 'Все здоровы', n > 0);
  }
  function bless(x, y, r) {
    x = num(x, NaN); y = num(y, NaN);
    if (!(x === x) || !(y === y) || !S.tile || !inMap(x, y)) return msg('Вне карты', false);
    r = rInt(r, 1, 8, 2);
    const list = inRad(x, y, r + 0.5);
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      u.buffUntil = S.tick + BLESS_TICKS;
      u.buffMul = BLESS_MUL;
      u.hp = Math.min(u.maxHp, u.hp + u.maxHp * 0.5);
      n++;
      if (n <= 5) fx('bless', u.x, u.y, { ttl: 1.0, r: 0.8 });
    }
    fx('bless', x, y, { ttl: 1.1, r: r + 0.5 });
    return msg(n > 0 ? 'Благословлено: ' + n : 'Некого благословлять', n > 0);
  }

  // ------------------------------------------------------------------ picking
  /** {type:'unit'|'building'|'city'|'tile', id, x, y} for a tap (null outside the map) */
  function pick(tx, ty) {
    tx = num(tx, NaN); ty = num(ty, NaN);
    if (!(tx === tx) || !(ty === ty) || !S.tile || !inMap(tx, ty)) return null;
    const xi = Math.floor(tx), yi = Math.floor(ty), i = yi * S.w + xi;
    // 1) creatures (sprites stand on their feet, so the body is a little above u.y); rulers are easier to hit
    let best = null, bd = 1e9;
    const qy = ty + 0.3;
    const list = inRad(tx, qy, 1.6);
    for (let k = 0; k < list.length; k++) {
      const u = list[k], d = Util.dist(u.x, u.y, tx, qy);
      if (d <= (u.isRuler ? 1.6 : 0.9) && d < bd) { bd = d; best = u; }
    }
    if (best) return { type: 'unit', id: best.id, x: best.x, y: best.y };
    // 2) building on the tile
    const bid = S.bld[i];
    if (bid) {
      const b = S.buildings.get(bid);
      if (b) return { type: 'building', id: b.id, x: b.x, y: b.y };
    }
    // 3) city: centre within 1.5 tiles, else the owner of the tile
    let c = null, cd = 2.25;
    for (const cc of S.cities.values()) {
      const dx = cc.x + 0.5 - tx, dy = cc.y + 0.5 - ty, d2 = dx * dx + dy * dy;
      if (d2 <= cd) { cd = d2; c = cc; }
    }
    if (!c && S.owner[i]) c = S.cities.get(S.owner[i]) || null;
    if (c) return { type: 'city', id: c.id, x: c.x, y: c.y };
    // 4) stage 2: empty land belongs to a region (owned or wild)
    const rid = S.region ? S.region[i] : 0;
    if (rid && S.regions && S.regions.has(rid)) return { type: 'region', id: rid, x: xi, y: yi };
    return { type: 'tile', id: i, x: xi, y: yi };
  }

  // ------------------------------------------------------------------ diplomacy tools
  /** kingdom under a tap: a ruler within 2 tiles first, else whatever pick() finds (unit, building, city, territory) */
  function kingdomAt(x, y) {
    if (!S.tile || !inMap(x, y)) return null;
    const ruler = Units.nearest(x, y, 2, (u) => u.isRuler && u.kingdomId > 0 && S.kingdoms.has(u.kingdomId));
    if (ruler) return { kid: ruler.kingdomId, ruler, x: ruler.x, y: ruler.y };
    const p = pick(x, y);
    if (!p) return null;
    let kid = 0, px = p.x, py = p.y;
    if (p.type === 'unit') {
      const u = S.units.get(p.id);
      if (u) { const c = S.cities.get(u.cityId); kid = u.kingdomId || (c ? c.kingdomId : 0); }
    } else if (p.type === 'building') {
      const b = S.buildings.get(p.id), c = b ? S.cities.get(b.cityId) : null;
      if (c) kid = c.kingdomId;
    } else if (p.type === 'city') {
      const c = S.cities.get(p.id);
      if (c) kid = c.kingdomId;
    } else if (p.type === 'region') {
      const r = S.regions ? S.regions.get(p.id) : null;               // an owned region: its owner (wild land has none)
      if (r) kid = r.ownerId;
    } else if (p.type === 'tile') {
      const kk = Kingdoms.at(p.x, p.y);                               // shore / specks: whoever owns the ground
      if (kk) kid = kk.id;
    }
    if (!kid || !S.kingdoms.has(kid)) return null;
    const k = S.kingdoms.get(kid), r = S.units.get(k.rulerId) || null;
    return { kid, ruler: r, x: px, y: py };
  }
  function rulerAcc(u) {
    if (u.race === Const.RACE.ORC) return u.sex === Const.SEX.F ? 'вождиху' : 'вождя';
    if (u.race === Const.RACE.ELF) return u.sex === Const.SEX.F ? 'княгиню' : 'князя';
    return u.sex === Const.SEX.F ? 'королеву' : 'короля';
  }
  function otherSide(res, kid) {
    if (res && typeof res === 'object') {
      return S.kingdoms.get(res.aggressor === kid ? res.defender : res.aggressor) || null;
    }
    if (typeof res === 'number') return S.kingdoms.get(res) || null;
    return null;
  }

  function warWhisper(x, y) {
    x = num(x, NaN); y = num(y, NaN);
    const t = kingdomAt(x, y);
    if (!t) return msg('Тапните по королю, городу или земле королевства', false);
    const k = S.kingdoms.get(t.kid);
    fx('whisper', t.x, t.y, { ttl: 1.2 });
    const res = Diplomacy.godWhisperWar(t.kid);
    if (!res) return msg('У «' + k.name + '» нет соседей для войны', false);
    const foe = otherSide(res, t.kid);
    const tail = foe && foe.id !== k.id ? ' с «' + foe.name + '»' : '';
    const text = t.ruler
      ? 'Шёпот бога склонил ' + rulerAcc(t.ruler) + ' «' + t.ruler.name + '» к войне' + tail
      : 'Шёпот бога склонил «' + k.name + '» к войне' + tail;
    Log.add(text, LOG.GOD, t.x | 0, t.y | 0, k.id);
    Hist.add(k, 'Шёпот бога склонил правителя к войне' + tail);
    return msg(text, true);
  }
  function peace(x, y) {
    x = num(x, NaN); y = num(y, NaN);
    const t = kingdomAt(x, y);
    if (!t) return msg('Тапните по королевству', false);
    const k = S.kingdoms.get(t.kid);
    const a = Diplomacy.godPeace(t.kid), b = War.godPeace(t.kid);
    if (!a && !b) return msg('«' + k.name + '» ни с кем не воюет', false);
    fx('bless', t.x, t.y, { ttl: 1.2, r: 2.5 });
    const text = 'Бог принёс мир королевству «' + k.name + '»';
    Log.add(text, LOG.GOD, t.x | 0, t.y | 0, k.id);
    Hist.add(k, 'Бог принёс мир');
    return msg(text, true);
  }
  function cityAtTap(x, y) {
    if (!S.tile || !inMap(x, y)) return null;
    const xi = Math.floor(x), yi = Math.floor(y), i = yi * S.w + xi;
    if (S.bld[i]) { const b = S.buildings.get(S.bld[i]); if (b && S.cities.has(b.cityId)) return S.cities.get(b.cityId); }
    const c = nearestCity(x, y, 1.5);
    if (c) return c;
    if (S.owner[i] && S.cities.has(S.owner[i])) return S.cities.get(S.owner[i]);
    // stage 2: the biggest city of the tapped region
    const rid = S.region ? S.region[i] : 0, r = rid && S.regions ? S.regions.get(rid) : null;
    if (r) {
      let best = null;
      for (let k = 0; k < r.cityIds.length; k++) {
        const cc = S.cities.get(r.cityIds[k]);
        if (cc && (!best || cc.pop > best.pop)) best = cc;
      }
      if (best) return best;
    }
    return null;
  }
  function split(x, y) {
    x = num(x, NaN); y = num(y, NaN);
    const c = cityAtTap(x, y);
    if (!c) return msg('Тапните по городу', false);
    const old = S.kingdoms.get(c.kingdomId) || null;
    if (!old) return msg('Город «' + c.name + '» уже независим', false);
    fx('whisper', c.x + 0.5, c.y + 0.5, { ttl: 1.2 });
    const nk = Kingdoms.splitCity(c.id);
    if (!nk) return msg('Город «' + c.name + '» нельзя отделить', false);
    const text = 'Бог отделил город «' + c.name + '» от королевства «' + old.name + '»';
    Log.add(text, LOG.GOD, c.x, c.y, typeof nk === 'number' ? nk : old.id);
    Hist.add(c, 'Отделён богом от королевства «' + old.name + '»');
    return msg(text, true);
  }

  // direct entry points (contract: Powers.fire(x,y,r) / Powers.heal(x,y,r)); apply() goes through the same code
  function fire(x, y, r) {
    x = num(x, NaN); y = num(y, NaN);
    if (!(x === x) || !(y === y) || !S.tile || !inMap(x, y)) return msg('Вне карты', false);
    return fireTool(x, y, rInt(r, 1, 8, 2), true, x, y);
  }
  function heal(x, y, r) {
    x = num(x, NaN); y = num(y, NaN);
    if (!(x === x) || !(y === y) || !S.tile || !inMap(x, y)) return msg('Вне карты', false);
    return healTool(x, y, rInt(r, 1, 8, 2), true, x, y);
  }

  // ------------------------------------------------------------------ apply
  function apply(toolId, tx, ty, radius, phase) {
    try { return run(toolId, tx, ty, radius, phase); }
    catch (e) { report(e, 'apply(' + toolId + ')'); lastMessage = 'Ошибка'; return false; }
  }
  function run(id, tx, ty, radius, phase) {
    lastMessage = '';                                     // stays '' when a call is silently ignored (throttled move, end, ...)
    const def = ToolDefs.byId[id];
    if (!def) return msg('Неизвестный инструмент', false);
    if (!S.tile) return msg('Мира нет', false);
    phase = phase || 'tap';
    if (phase === 'end') { if (drag.tool === id) drag.tool = ''; return false; }
    if (phase !== 'tap' && phase !== 'start' && phase !== 'move') return false;
    const x = num(tx, NaN), y = num(ty, NaN);
    if (!(x === x) || !(y === y)) return msg('Некорректная цель', false);
    let first = phase !== 'move';
    if (!first) {
      if (!def.drag) return false;
      if (drag.tool !== id) first = true;                 // a move without a start: begin a stroke here
    }
    const r = def.brush ? rInt(radius, 1, 8, 2) : 1;
    const margin = def.group === 'terrain' ? r : 0;
    if (x < -margin || y < -margin || x >= S.w + margin || y >= S.h + margin) return msg('Вне карты', false);
    let lx = x, ly = y;
    if (first) {
      drag.tool = id; drag.x = x; drag.y = y; drag.tick = S.tick; drag.sx = x; drag.sy = y; drag.st = S.tick; drag.n = 0;
    } else {
      lx = drag.x; ly = drag.y;
      if (Util.dist(x, y, lx, ly) < 0.5 && S.tick - drag.tick < 3) return false;     // rate limit
      drag.x = x; drag.y = y; drag.tick = S.tick;
    }
    const ok = dispatch(id, x, y, r, first, lx, ly);
    if (phase === 'tap') drag.tool = '';                  // a tap is a complete gesture: a later stray move starts a new stroke
    return ok;
  }
  function dispatch(id, x, y, r, first, lx, ly) {
    switch (id) {
      case 'raise': case 'lower': case 'grass': case 'sand': case 'forest': case 'hill': case 'mountain': case 'snow': case 'lava':
        return terrainTool(id, x, y, r, first, lx, ly);
      case 'human': case 'orc': case 'elf': return creatureTool(id, x, y, r, first);
      case 'erase': return eraseTool(x, y, r, first, lx, ly);
      case 'lightning': return lightning(x, y);
      case 'meteor': return meteor(x, y, Math.max(2, r));
      case 'fire': return fireTool(x, y, r, first, lx, ly);
      case 'earthquake': return earthquake(x, y, r);
      case 'plague': return plague(x, y, r);
      case 'tornado': return tornado(x, y);
      case 'rain': return rainTool(x, y, r, first, lx, ly);
      case 'heal': return healTool(x, y, r, first, lx, ly);
      case 'bless': return bless(x, y, r);
      case 'war_whisper': return warWhisper(x, y);
      case 'peace': return peace(x, y);
      case 'split': return split(x, y);
      case 'command': return msg('', false);                 // command mode is handled by the UI (no god power behind it)
      case 'inspect': { const p = pick(x, y); return msg(p ? 'Осмотр' : 'Вне карты', !!p); }
    }
    const pl = pluginFor(id);                               // new powers live in plugin files (src/15..19_power_*.js, CONTRACT section 10)
    if (pl) return !!pl.apply(id, x, y, r, first, lx, ly, host);
    return msg('Неизвестный инструмент', false);
  }
  function pluginFor(id) {
    for (let i = 0; i < PowerPlugins.length; i++) { const p = PowerPlugins[i]; if (p && p.ids && p.ids.indexOf(id) >= 0 && typeof p.apply === 'function') return p; }
    return null;
  }
  /** helpers handed to plugin.apply (and available as Powers.host) */
  const host = { msg, fx, num, rInt, inMap, report, kingdomAt: (x, y) => kingdomAt(x, y), nearestCity, eff };
  function eachPlugin(fn, name, tick) {
    for (let i = 0; i < PowerPlugins.length; i++) {
      const p = PowerPlugins[i];
      if (!p || typeof p[fn] !== 'function') continue;
      try { p[fn](tick, host); } catch (err) { report(err, (p.name || (p.ids && p.ids[0]) || 'plugin') + ' ' + name); }
    }
  }
  function rainTool(x, y, r, first, lx, ly) {
    if (first) return rain(x, y, Math.max(2, r));
    const n = plan(lx, ly, x, y, Math.max(1.5, r * 0.9));
    let ok = false;
    for (let k = 0; k < n; k++) ok = rain(stX[k], stY[k], Math.max(2, r)) || ok;
    return ok;
  }

  // ------------------------------------------------------------------ lifecycle
  function step(tick) {
    if (!S.tile) return;
    if (tick === undefined) tick = S.tick;
    const e = eff();
    if (e.meteors.length) stepMeteors(tick);
    stepList(e.quakes, stepQuake, tick, 'quake');
    stepList(e.tornados, stepTornado, tick, 'tornado');
    stepList(e.rains, stepRain, tick, 'rain');
    if (PowerPlugins.length) eachPlugin('step', 'step', tick);
  }
  /** runs fn over every effect, drops finished (fn returned false) or broken ones (exceptions are logged once) */
  function stepList(L, fn, tick, name) {
    if (L.length === 0) return;
    let wr = 0;
    for (let k = 0; k < L.length; k++) {
      const q = L[k];
      let keep = false;
      try { keep = !!q && q.x === q.x && q.y === q.y && fn(q, tick) !== false; } catch (err) { report(err, name + ' step'); }
      if (keep) L[wr++] = q;
    }
    L.length = wr;
  }
  function clean() {
    const e = eff();
    const good = (q) => q && typeof q === 'object' && num(q.x, NaN) === q.x && num(q.y, NaN) === q.y;
    e.meteors = e.meteors.filter((m) => good(m) && num(m.eta, NaN) === m.eta);
    e.rains = e.rains.filter((m) => good(m) && num(m.until, NaN) === m.until);
    e.tornados = e.tornados.filter((m) => good(m) && num(m.until, NaN) === m.until).map((m) => {
      if (typeof m.dx !== 'number' || !(m.dx === m.dx)) m.dx = 0.1;
      if (typeof m.dy !== 'number' || !(m.dy === m.dy)) m.dy = 0;
      if (typeof m.nt !== 'number') m.nt = 0;
      if (!(m.r > 0)) m.r = TORNADO_R;
      return m;
    });
    e.quakes = e.quakes.filter((m) => good(m) && num(m.until, NaN) === m.until).map((m) => {
      fixQuake(m);
      m.h = m.h.filter((hd) => Array.isArray(hd) && hd.length === 4 && hd.every((v) => typeof v === 'number' && v === v));
      return m;
    });
  }
  function reset() {
    drag.tool = ''; drag.x = drag.y = drag.sx = drag.sy = 0; drag.tick = -999; drag.st = -999; drag.n = 0;
    lastMessage = '';
    buf.length = 0;
  }
  function newWorld() { reset(); eff(); eachPlugin('newWorld', 'newWorld', S.tick); }
  function afterLoad() { reset(); clean(); eachPlugin('afterLoad', 'afterLoad', S.tick); }

  return {
    apply, pick, step, newWorld, afterLoad,
    lightning, meteor, earthquake, plague, tornado, rain, bless, fire, heal,
    // extras
    kingdomAt, host,
    /** number of active persistent effects, for UI / tests */
    active() { const e = eff(); return { meteors: e.meteors.length, tornados: e.tornados.length, rains: e.rains.length, quakes: e.quakes.length }; },
    get lastMessage() { return lastMessage; },
    get errors() { return errCount; },
    get lastError() { return lastError; },
  };
})();
