/* =====================================================================
 * 15_power_dynamite.js — god power «Динамит» (sim plugin, CONTRACT section 10). DOM-free (runs headless in node).
 *
 * Tool 'dynamite' (tab Силы, new group «Арсенал»), brush = size of the charge, drag = lays a wired line of charges.
 *
 *  - A tap lays one bundle. It burns FUSE (30) ticks, then explodes. Blast radius = 1.6 + 0.4 * r tiles (r = brush 1..8).
 *  - DRAGGING lays a line of bundles (one per SPACING = 1.3 tiles, <= 40 per stroke, <= 80 live in the world). The charges of a stroke are
 *    WIRED: the first one burns the fuse, every next one goes off 2..4 ticks after its predecessor (a running bang-bang-bang chain).
 *    The schedule is written into the charges when they are laid (`boom`), a predecessor that goes off EARLY (chain reaction) drags the
 *    rest of its wire along (the successor is moved up to "predecessor + 2..4").
 *  - Chain reaction: a live charge of ANOTHER stroke inside the blast goes off 2..3 ticks later (charges of the same wire follow the wire).
 *  - Blast: creatures take falloff damage (lethal in the core 0.42 R, ~5 at the rim) and are thrown away from the centre over a few ticks;
 *    buildings take heavy damage (destroyed in the core; a town hall only close to the centre); forests inside 0.72 R are felled (FOREST -> GRASS);
 *    quarrying in the same zone: SNOW -> MOUNTAIN, MOUNTAIN -> HILL, HILL -> GRASS (one step, dithered rim, through World.setTile); ore features
 *    (ROCK / IRON / GOLD) are blown apart and their yield goes into the stock of the city that owns the tile («взрывные работы»);
 *    lone trees / berries are destroyed; 25 % of the flammable tiles around the blast catch fire; water only splashes.
 *  - Feedback: toast «Динамит заложен» (client side, via Bus 'dynamiteLaid'), Fx 'dyn_blast' (baked by src/30_gfx_dynamite.js) + shake + smoke,
 *    one chronicle line per stroke when something notable happened (never one per victim).
 *
 * State (all JSON-safe, saved with the world; no private caches that influence the simulation):
 *   S.eff.dynamite       [{id, x, y, r, t0, boom, g, pv, wx, wy}]  live charges: boom = tick it goes off, g = stroke id, pv = id of the
 *                                                                  charge it is wired to (0 = none / burnt), wx,wy = that charge's position
 *   S.eff.dynamite_scars [{x, y, r, t0}]                            cosmetic blast scars (drawn by the graphics plugin, expire after SCAR_LIFE)
 *   S.mod.dynamite       {n, g, cnt, last, lx, ly, told, tal:{g:{...}}, kb:[[unitId,vx,vy,left]], stat:{...}}   (stroke bookkeeping, chronicle tallies, thrown creatures, counters)
 * All randomness goes through R; creatures are processed in id order, so a save/load continuation is bit-identical.
 * ===================================================================== */

const PowerDynamite = (() => {
  const T = Const.T, RES = Const.RES, LOG = Const.LOG, TAU = Math.PI * 2;

  ToolDefs.groupLabels.arsenal = 'Арсенал';
  ToolDefs.add({
    id: 'dynamite', tab: 'powers', group: 'arsenal', afterGroup: 'destroy', name: 'Динамит', short: 'Динамит', icon: 'dynamite',
    brush: true, drag: true, hint: 'Динамит: заряд или цепь',
  });

  // ------------------------------------------------------------------ tunables
  const FUSE = 30;                       // ticks from laying a (head) charge to its bang
  const GAP_LO = 2, GAP_N = 3;           // wired chain: the next charge goes off GAP_LO .. GAP_LO+GAP_N-1 (= 2..4) ticks after the previous one
  const REACT_LO = 2, REACT_N = 2;       // chain reaction: 2..3 ticks after the neighbour's bang
  const SPACING = 1.3;                   // tiles between the charges of a stroke
  const STROKE_CAP = 40, LIVE_CAP = 80;
  const CALL_CAP = 12;                   // charges laid by one apply() call (a huge finger jump is spread over the next moves)
  const SAME_SPOT = 0.55;                // no second bundle closer than this to a live one
  const SCAR_CAP = 48, SCAR_LIFE = 1500;
  const KB_CAP = 240, KB_TICKS = 6, KB_DECAY = 0.72;
  const CORE = 0.42, INNER = 0.72;       // lethal core / quarrying zone, as fractions of the blast radius
  const DMG_EDGE = 5, DMG_SPAN = 55;     // creature damage just outside the core = DMG_EDGE + DMG_SPAN, falls to DMG_EDGE at the rim
  const BLD_EDGE = 20, BLD_SPAN = 230;   // building damage just outside the core / at the rim
  const FIRE_P = 0.25;                   // chance that a flammable tile around the blast catches fire

  const blastR = (r) => 1.6 + 0.4 * r;

  // ------------------------------------------------------------------ state helpers
  function num(v, d) { return (typeof v === 'number' && v === v && v > -1e7 && v < 1e7) ? v : d; }
  function clampInt(v, lo, hi, d) { v = Math.round(num(v, d)); return v < lo ? lo : v > hi ? hi : v; }
  function list() { const e = S.eff; if (!Array.isArray(e.dynamite)) e.dynamite = []; return e.dynamite; }
  function scars() { const e = S.eff; if (!Array.isArray(e.dynamite_scars)) e.dynamite_scars = []; return e.dynamite_scars; }
  function mod() {
    let m = S.mod.dynamite;
    if (!m || typeof m !== 'object') m = S.mod.dynamite = {};
    if (!(m.n >= 0)) m.n = 0;
    if (!(m.g >= 0)) m.g = 0;
    if (!(m.cnt >= 0)) m.cnt = 0;
    if (!(m.last >= 0)) m.last = 0;
    if (typeof m.lx !== 'number' || m.lx !== m.lx) m.lx = 0;
    if (typeof m.ly !== 'number' || m.ly !== m.ly) m.ly = 0;
    if (!(m.told >= 0)) m.told = 0;
    if (!m.tal || typeof m.tal !== 'object' || Array.isArray(m.tal)) m.tal = {};
    if (!Array.isArray(m.kb)) m.kb = [];
    if (!m.stat || typeof m.stat !== 'object') m.stat = {};
    const st = m.stat;
    if (!(st.laid >= 0)) st.laid = 0;
    if (!(st.boom >= 0)) st.boom = 0;
    if (!(st.dead >= 0)) st.dead = 0;
    if (!(st.razed >= 0)) st.razed = 0;
    if (!(st.felled >= 0)) st.felled = 0;
    if (!(st.quarried >= 0)) st.quarried = 0;
    if (!(st.ore >= 0)) st.ore = 0;
    return m;
  }
  function find(L, id) { for (let i = 0; i < L.length; i++) if (L[i].id === id) return L[i]; return null; }
  function r3(v) { return Math.round(v * 1000) / 1000; }
  function isWater(t) { return t === T.DEEP || t === T.SHALLOW; }
  /** deterministic 0..1 noise for cosmetic jitter (never touches R) */
  function jit(a, b, c) { return Util.hash2(Math.round(a * 16), Math.round(b * 16), c | 0) * 2.3283064365386963e-10; }

  // ------------------------------------------------------------------ laying charges
  function lay(L, m, x, y, r, tick) {
    const prev = m.last > 0 ? find(L, m.last) : null;
    let boom, pv = 0, wx = 0, wy = 0;
    if (prev) { boom = prev.boom + GAP_LO + R.i(GAP_N); pv = prev.id; wx = prev.x; wy = prev.y; }
    else boom = tick + FUSE;
    const c = { id: ++m.n, x: r3(x), y: r3(y), r, t0: tick, boom, g: m.g, pv, wx, wy };
    L.push(c);
    m.last = c.id; m.cnt++; m.stat.laid++;
    return c;
  }
  function crowded(L, x, y) {
    for (let i = 0; i < L.length; i++) { const dx = L[i].x - x, dy = L[i].y - y; if (dx * dx + dy * dy < SAME_SPOT * SAME_SPOT) return true; }
    return false;
  }

  const PX = [], PY = [];                // scratch: positions of one apply() call
  function apply(id, x, y, r, first, lx, ly, host) {
    if (id !== 'dynamite') return false;
    x = num(x, NaN); y = num(y, NaN);
    if (!(x === x) || !(y === y) || !S.tile || x < 0 || y < 0 || x >= S.w || y >= S.h) return host.msg('Вне карты', false);
    r = clampInt(r, 1, 8, 2);
    const m = mod(), L = list(), tick = S.tick;
    if (first || m.g === 0) { m.g++; m.cnt = 0; m.last = 0; m.told = 0; first = true; m.lx = x; m.ly = y; }
    // positions to lay: the tap itself, or points every SPACING tiles along the finger path from the last laid point
    let n = 0;
    if (first) { PX[0] = x; PY[0] = y; n = 1; }
    else {
      const dx = x - m.lx, dy = y - m.ly, d = Math.sqrt(dx * dx + dy * dy);
      n = Math.min(CALL_CAP, Math.floor(d / SPACING));
      for (let k = 1; k <= n; k++) { PX[k - 1] = m.lx + dx / d * SPACING * k; PY[k - 1] = m.ly + dy / d * SPACING * k; }
    }
    let laid = 0, why = '', headFx = false;
    for (let k = 0; k < n; k++) {
      const px = PX[k], py = PY[k];
      if (!first) { m.lx = px; m.ly = py; }               // the logical path advances even when a point is skipped
      if (px < 0 || py < 0 || px >= S.w || py >= S.h) { why = why || 'edge'; break; }
      if (m.cnt >= STROKE_CAP) { why = 'stroke'; break; }
      if (L.length >= LIVE_CAP) { why = 'live'; break; }
      if (S.tile[(py | 0) * S.w + (px | 0)] === T.LAVA) { why = why || 'lava'; continue; }
      if (crowded(L, px, py)) { why = why || 'crowd'; continue; }
      const c = lay(L, m, px, py, r, tick);
      laid++;
      if (laid <= 6) host.fx('dust', px, py + 0.35, { ttl: 0.4 });
      if (!c.pv && !headFx) { headFx = true; host.fx('spark', px, py - 0.2, { ttl: 0.5, n: 6 }); }
    }
    if (laid > 0) {
      const opening = m.cnt === laid;                    // this call laid the first charge of the stroke (the tap itself, or the first one after a refused start)
      Bus.emit('dynamiteLaid', laid, opening ? 1 : 0, m.g);
      return opening ? host.msg('Динамит заложен', true) : true;
    }
    if (why === 'live' || why === 'stroke' || why === 'lava' || (first && why === 'crowd')) {
      if (m.told === 1 && !first) return host.msg('', false);        // one explanation per stroke
      m.told = 1;
      return host.msg(why === 'live' ? 'Слишком много динамита: подождите взрывов (' + LIVE_CAP + ')'
        : why === 'stroke' ? 'В одной цепи не больше ' + STROKE_CAP + ' зарядов'
        : why === 'lava' ? 'В лаве динамит сгорает' : 'Здесь уже лежит динамит', false);
    }
    return host.msg('', false);
  }

  // ------------------------------------------------------------------ the bang
  const UB = [], DUE = [], TOUCH = [];
  function pushUnit(u) { UB.push(u); }
  function byId(a, b) { return a.id - b.id; }

  function tallyOf(m, g) {
    let t = m.tal[g];
    if (!t) t = m.tal[g] = { dead: 0, razed: 0, n: 0, hall: 0, x: 0, y: 0, ruler: '' };
    return t;
  }

  function addKnock(m, id, vx, vy) {
    const kb = m.kb;
    for (let i = 0; i < kb.length; i++) {
      const e = kb[i];
      if (e[0] === id) { e[1] += vx; e[2] += vy; e[3] = KB_TICKS; return; }
    }
    if (kb.length < KB_CAP) kb.push([id, vx, vy, KB_TICKS]);
  }
  /** a survivor is thrown away from the centre over KB_TICKS ticks (decaying speed), stunned meanwhile */
  function throwUnit(m, u, cx, cy, d, Rb, tick) {
    let ax = u.x - cx, ay = u.y - cy, len = Math.sqrt(ax * ax + ay * ay);
    if (len < 0.08) { const a = R.f() * TAU; ax = Math.cos(a); ay = Math.sin(a); len = 1; }
    ax /= len; ay /= len;
    const push = 0.5 + 1.0 * (1 - d / Rb);
    const v0 = push * (1 - KB_DECAY) / (1 - Math.pow(KB_DECAY, KB_TICKS));
    addKnock(m, u.id, ax * v0, ay * v0);
    if (!(u.armyId > 0) && u.state !== 'settle') { u.job = null; u.state = 'idle'; u.st = { ph: '', since: tick, until: tick + KB_TICKS + 3 }; }
    u.nextThink = tick + 2;
  }
  function stepKnock(m) {
    const kb = m.kb;
    let w = 0;
    for (let i = 0; i < kb.length; i++) {
      const e = kb[i], u = S.units.get(e[0]);
      if (!u || !(u.hp > 0)) continue;
      const nx = u.x + e[1], ny = u.y + e[2];
      if (!(nx >= 0.05 && ny >= 0.05 && nx < S.w - 0.05 && ny < S.h - 0.05) || !World.walkable(nx, ny)) continue;   // hit a wall / the sea: stop
      u.x = nx; u.y = ny;
      e[1] *= KB_DECAY; e[2] *= KB_DECAY; e[3]--;
      if (e[3] > 0) kb[w++] = e;
    }
    kb.length = w;
  }

  /** a blasted ore vein is gone; the city that owns the tile gets a share of it (stone 12 %, iron 10 %, gold 8 % of the vein). Returns the stock added. */
  function quarry(m, i, x, y, rk) {
    const amt = S.amt[i];
    S.res[i] = 0; S.amt[i] = 0; S.markDirty(x, y);
    m.stat.quarried++;
    const cid = S.owner[i];
    if (!(cid > 0) || !S.cities.has(cid)) return 0;
    const good = rk === RES.IRON ? 'iron' : rk === RES.GOLD ? 'gold' : 'stone';
    const k = rk === RES.IRON ? 0.10 : rk === RES.GOLD ? 0.08 : 0.12;
    const got = Cities.deposit(cid, good, Math.max(rk === RES.GOLD ? 1 : 2, Math.round(amt * k)));
    if (got > 0) m.stat.ore += got;
    return got;
  }

  function blast(c, tick, L, host) {
    const m = mod(), r = clampInt(c.r, 1, 8, 2), Rb = blastR(r), rc = Rb * CORE, ri = Rb * INNER;
    const cx = c.x, cy = c.y, w = S.w, h = S.h, lod = S.perf.lod | 0;
    const tal = tallyOf(m, c.g);
    if (tal.n === 0) { tal.x = cx; tal.y = cy; }
    tal.n++; m.stat.boom++;

    // 1) creatures: lethal in the core, falloff outside, survivors are thrown back (id order = independent of the spatial grid layout)
    UB.length = 0;
    Units.nearby(cx, cy, Rb, pushUnit);
    if (UB.length > 1) UB.sort(byId);
    for (let k = 0; k < UB.length; k++) {
      const u = UB[k];
      if (S.units.get(u.id) !== u) continue;
      const d = Util.dist(u.x, u.y, cx, cy);
      const ruler = u.isRuler === true, title = ruler ? Names.ruler(u.race, u.sex).toLowerCase() + ' «' + u.name + '»' : '';
      let dead;
      if (d <= rc) dead = Units.damage(u, 9999, 'dynamite') === true;
      else { const f = 1 - (d - rc) / (Rb - rc); dead = Units.damage(u, DMG_EDGE + DMG_SPAN * f * Math.sqrt(f), 'dynamite') === true; }
      if (dead) { tal.dead++; m.stat.dead++; if (title) tal.ruler = title; }
      else if (S.units.get(u.id) === u) {
        throwUnit(m, u, cx, cy, d, Rb, tick);
        if (d <= Rb * 0.6) u.burning = tick + 20;
      }
    }
    UB.length = 0;

    // 2) buildings, vegetation, rock, fire — tile by tile in row-major order
    const x0 = Math.max(0, Math.floor(cx - Rb - 0.5)), x1 = Math.min(w - 1, Math.ceil(cx + Rb + 0.5));
    const y0 = Math.max(0, Math.floor(cy - Rb - 0.5)), y1 = Math.min(h - 1, Math.ceil(cy + Rb + 0.5));
    let splash = 0, flames = 0, ores = 0;
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx + 0.5 - cx, dy = yy + 0.5 - cy, d = Math.sqrt(dx * dx + dy * dy);
        if (d > Rb + 0.5) continue;
        const i = yy * w + xx;
        let t = S.tile[i];
        if (d <= Rb) {
          const bid = S.bld[i];
          if (bid) {
            const b = S.buildings.get(bid);
            if (b) {
              const hall = b.type === Const.B.TOWNHALL && b.done;
              const dmg = d <= rc ? 9999 : BLD_EDGE + BLD_SPAN * Math.pow(1 - (d - rc) / (Rb - rc), 1.4);
              if (Buildings.damage(b, dmg, 0, 'dynamite') === true) { tal.razed++; m.stat.razed++; if (hall) tal.hall++; }
            }
          }
          if (isWater(t)) {
            if (splash < 3 && R.f() < 0.4) { splash++; host.fx('splash', xx + 0.5, yy + 0.5, { ttl: 0.7 }); }
            continue;
          }
          if (t === T.LAVA) continue;
          const rk = S.res[i];
          if (rk === RES.ROCK || rk === RES.IRON || rk === RES.GOLD) {
            if (d <= ri && quarry(m, i, xx, yy, rk) > 0 && ores++ < 4) host.fx('dyn_ore', xx + 0.5, yy + 0.5, { ttl: 1.2, kind: rk === RES.IRON ? 'iron' : rk === RES.GOLD ? 'gold' : 'stone' });
          } else if (rk === RES.TREE) {
            if (d <= ri || R.f() < 0.5) { S.res[i] = 0; S.amt[i] = 0; S.markDirty(xx, yy); }
          } else if (rk === RES.BERRY) {
            if (d <= ri) { S.res[i] = 0; S.amt[i] = 0; S.markDirty(xx, yy); }
          }
          if (d <= ri) {
            if (t === T.FOREST) { World.setTile(xx, yy, T.GRASS, { elev: S.elev[i] }); m.stat.felled++; }
            else if (t === T.MOUNTAIN || t === T.HILL || t === T.SNOW) {
              const p = d <= ri * 0.7 ? 1 : Math.max(0.25, 1 - (d - ri * 0.7) / (ri * 0.3 + 0.01) * 0.75);
              if (R.f() < p) World.setTile(xx, yy, t === T.SNOW ? T.MOUNTAIN : t === T.MOUNTAIN ? T.HILL : T.GRASS);
            }
          }
        } else {
          t = S.tile[i];
          if (isWater(t) || t === T.LAVA) continue;
        }
        if (R.f() < FIRE_P && World.ignite(xx, yy) === true && flames < 2) { flames++; host.fx('fire', xx + 0.5, yy + 0.5, { ttl: 0.7 }); }
      }
    }

    // 3) the wire and the neighbours: the successor of this charge goes off 2..4 ticks later, charges of OTHER strokes inside the blast 2..3 ticks later
    for (let i = 0; i < L.length; i++) {
      const o = L[i];
      if (o.pv === c.id) {
        const t2 = tick + GAP_LO + R.i(GAP_N);
        if (t2 < o.boom) o.boom = t2;
        o.pv = 0;
      } else if (o.g !== c.g && o.boom > tick + 3) {
        const ox = o.x - cx, oy = o.y - cy;
        if (ox * ox + oy * oy <= (Rb + 0.3) * (Rb + 0.3)) o.boom = tick + REACT_LO + R.i(REACT_N);
      }
    }

    // 4) show: scar (persistent, cosmetic), fireball + debris (graphics plugin), shake, smoke
    const sc = scars();
    sc.push({ x: c.x, y: c.y, r: Math.round(Rb * 10) / 10, t0: tick });
    if (sc.length > SCAR_CAP) sc.splice(0, sc.length - SCAR_CAP);
    host.fx('dyn_blast', cx, cy, { ttl: 0.95 + 0.04 * r, r: Rb, v: c.id & 1, big: r });
    host.fx('shake', cx, cy, { amp: 1 + 0.4 * r, ttl: 0.26 + 0.02 * r });
    if (lod < 2 && r >= 2) {
      host.fx('smoke', cx + (jit(cx, cy, tick) - 0.5) * Rb * 0.6, cy - 0.15, { ttl: 1.1 + 0.08 * r });
      if (r >= 5 && lod < 1) host.fx('smoke', cx + (jit(cy, cx, tick + 7) - 0.5) * Rb * 0.8, cy + 0.1, { ttl: 1.3 });
    }
  }

  function chronicle(t, host) {
    if (!(t.dead >= 4 || t.razed >= 3 || t.hall > 0 || t.ruler)) return;
    const city = host.nearestCity(t.x, t.y, 16);
    const parts = [];
    if (t.dead > 0) parts.push('погибло: ' + t.dead);
    if (t.razed > 0) parts.push('разрушено построек: ' + t.razed);
    let text = (t.n > 1 ? 'Цепь взрывов' : 'Взрыв динамита') + (city ? ' у «' + city.name + '»' : '') + (parts.length ? ' (' + parts.join(', ') + ')' : '');
    if (t.ruler) text += ' — убит ' + t.ruler;
    Log.add(text, LOG.DISASTER, t.x | 0, t.y | 0, city ? city.kingdomId : 0);
  }

  function stepCharges(L, tick, host) {
    DUE.length = 0;
    let w = 0;
    for (let i = 0; i < L.length; i++) {
      const c = L[i];
      if (!c || typeof c !== 'object' || !(c.boom === c.boom) || !(c.x === c.x) || !(c.y === c.y)) continue;      // broken entry: drop
      if (c.boom <= tick) DUE.push(c); else L[w++] = c;
    }
    L.length = w;
    if (DUE.length === 0) return;
    TOUCH.length = 0;
    for (let k = 0; k < DUE.length; k++) {
      const c = DUE[k];
      try { blast(c, tick, L, host); } catch (err) { host.report(err, 'dynamite blast'); }
      if (TOUCH.indexOf(c.g) < 0) TOUCH.push(c.g);
    }
    DUE.length = 0;
    // a stroke whose last charge has gone off writes its chronicle line
    const m = mod();
    for (let k = 0; k < TOUCH.length; k++) {
      const g = TOUCH[k];
      let alive = false;
      for (let i = 0; i < L.length; i++) if (L[i].g === g) { alive = true; break; }
      if (alive) continue;
      const t = m.tal[g];
      delete m.tal[g];
      if (t) { try { chronicle(t, host); } catch (err) { host.report(err, 'dynamite chronicle'); } }
    }
    TOUCH.length = 0;
  }

  function stepScars(tick) {
    const sc = S.eff.dynamite_scars;
    if (!Array.isArray(sc) || sc.length === 0) return;
    let w = 0;
    for (let i = 0; i < sc.length; i++) { const s = sc[i]; if (s && tick - s.t0 < SCAR_LIFE) sc[w++] = s; }
    sc.length = w;
  }

  function step(tick, host) {
    if (tick === undefined) tick = S.tick;
    const e = S.eff;
    const L = e.dynamite;
    if (Array.isArray(L) && L.length) stepCharges(L, tick, host || Powers.host);
    const m = S.mod.dynamite;
    if (m && Array.isArray(m.kb) && m.kb.length) stepKnock(m);
    if ((tick & 7) === 0) stepScars(tick);
  }

  // ------------------------------------------------------------------ lifecycle
  function reset() { UB.length = 0; DUE.length = 0; TOUCH.length = 0; PX.length = 0; PY.length = 0; }
  function newWorld() { reset(); S.eff.dynamite = []; S.eff.dynamite_scars = []; S.mod.dynamite = null; mod(); }
  /** a loaded save may carry anything: keep only well-formed entries and make sure every fuse is finite (no immortal charges) */
  function afterLoad() {
    reset();
    const m = mod(), L = list(), maxBoom = S.tick + FUSE + (LIVE_CAP + 2) * (GAP_LO + GAP_N) + 5;
    let w = 0, maxId = m.n;
    for (let i = 0; i < L.length; i++) {
      const c = L[i];
      if (!c || typeof c !== 'object' || num(c.x, NaN) !== c.x || num(c.y, NaN) !== c.y || num(c.boom, NaN) !== c.boom) continue;
      c.r = clampInt(c.r, 1, 8, 2);
      if (!(c.id > 0)) c.id = ++maxId;
      if (!(c.g >= 0)) c.g = 0;
      if (!(c.pv >= 0)) c.pv = 0;
      if (num(c.wx, NaN) !== c.wx) c.wx = 0;
      if (num(c.wy, NaN) !== c.wy) c.wy = 0;
      if (!(c.t0 >= 0)) c.t0 = c.boom - FUSE;
      if (c.boom > maxBoom) c.boom = maxBoom;
      if (c.id > maxId) maxId = c.id;
      if (w < LIVE_CAP + 40) L[w++] = c;
    }
    L.length = w;
    if (maxId > m.n) m.n = maxId;
    const sc = scars();
    w = 0;
    for (let i = 0; i < sc.length; i++) { const s = sc[i]; if (s && num(s.x, NaN) === s.x && num(s.y, NaN) === s.y && num(s.t0, NaN) === s.t0) { if (!(s.r > 0)) s.r = 2.4; sc[w++] = s; } }
    sc.length = Math.min(w, SCAR_CAP);
    m.kb = m.kb.filter((e) => Array.isArray(e) && e.length === 4 && e.every((v) => typeof v === 'number' && v === v));
    if (m.kb.length > KB_CAP) m.kb.length = KB_CAP;
  }

  const api = {
    name: 'dynamite', ids: ['dynamite'], apply, step, newWorld, afterLoad,
    // read-only helpers for tests / the graphics plugin
    blastRadius: blastR,
    FUSE, SPACING, STROKE_CAP, LIVE_CAP, SCAR_CAP, SCAR_LIFE, GAP: [GAP_LO, GAP_LO + GAP_N - 1], REACT: [REACT_LO, REACT_LO + REACT_N - 1], CORE, INNER,
    live() { return list(); },
  };
  PowerPlugins.push(api);
  return api;
})();
