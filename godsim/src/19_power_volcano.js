/* =====================================================================
 * 19_power_volcano.js — god power «Вулкан» (volcano).  Plugin of docs/CONTRACT.md section 10.  DOM-free (runs headless in node).
 *
 *  Tool 'volcano' (tab Силы, group destroy, brush = size of the cone: base radius 3 + r/2, crater 1.1 / 1.5 / 2.05 tiles).
 *  A tap raises a volcano; a tap on a live volcano (or on an extinct cone) lets it erupt again. Lifecycle, all state in S.eff.volcanoes:
 *    phase 0  RUMBLE   ~60 ticks (30 when an extinct cone wakes up): shake pulses + dust, the cone RISES from the outside in
 *                      (<= ~4 tiles per tick): HILL foothills, MOUNTAIN slopes, a raised rim. Everything built on the footprint is
 *                      destroyed, units nearby are scared away. Last tick: the crater opens (LAVA, flash, big shake, first heavy burst).
 *    phase 1  ERUPT    500-800 ticks: a burst every 25-70 ticks throws 3-8 lava bombs (arc projectiles: units within 1.3 tiles are
 *                      hurt, buildings damaged, flammables ignited, a LAVA tile is left that cools into MOUNTAIN / HILL), the crater is
 *                      kept open, and between bursts a lava tongue creeps downhill (1 tile per ~12 ticks, <= 40 live flow tiles, the
 *                      oldest tile cools first; it burns forests and razes buildings it touches).
 *    phase 2  COOL     150 ticks: the plume fades, crater and lava cool (ring of MOUNTAIN, core of HILL = an extinct cone), the entry
 *                      is removed and the cone is remembered in S.mod.volcano.cones (so another tap re-erupts it).
 *  Caps: <= 3 entries (a 4th tap replaces the oldest, which is calmed down at once), <= 24 bombs in flight, <= 56 tracked lava tiles per
 *  volcano. Terrain edits per tick: <= ~4 during the rumble, ~1 per ~12 ticks (+ bomb tiles) afterwards.
 *
 *  Entry (JSON-safe; Render/gfx read x,y,r,rb,rc,phase,t0,rum,t1,t2,until,lb,lbg,bombs,wd,cr):
 *    {id, x, y (centre of the cone tile), r, rb, rc, phase, t0, rum, until, t1, t2, next, nb (bursts), bl (bombs landed), lb (last burst tick), lbg (1 = it was the big opening blast),
 *     bombs:[[sx,sy,tx,ty,launchTick,landTick,height]...], lav:[idx, coolTick, kind(0 bomb,1 flow), elevBefore]..., cr:[crater tile indices, outer first],
 *     bs (tile indices still to rise during the rumble, outer first),
 *     fa (flow azimuth), fn (next flow tick), fs (stalls), cc (crater tiles cooled), old (1 = woke an extinct cone), wd (wind -1..1), rs (private PRNG state),
 *     cb:[cityId, buildingsBefore...], lg:[cityId logged...]}
 *  Extinct cones: S.mod.volcano.cones = [[cx, cy, r, tick]...] (<= 24).
 *
 *  Determinism across a save / load (CONTRACT 10.2): the World keeps its fire / lava lists in an order that is rebuilt (by tile index) on load, so
 *  its own random fire / cooling draws no longer line up with the original run and the global R stream drifts. Therefore (1) every random choice
 *  of a volcano comes from ITS OWN stream (mulberry32 in entry.rs, seeded once from R when it is created), (2) tracked lava tiles that the World's
 *  slow random cooling turned into HILL before their time are put back at once (the schedule is ours), crater tiles are re-asserted every tick,
 *  (3) unit lists are sorted by id / distance before anything order dependent happens (the spatial grid order differs after a load).
 *  So S.eff.volcanoes, S.mod.volcano and the terrain the volcano made continue identically; what the World does with fire is its own business.
 * ===================================================================== */

const PowerVolcano = (() => {
  const T = Const.T, RES = Const.RES, LOG = Const.LOG, TAU = Math.PI * 2;
  const KEY = 'volcanoes';

  ToolDefs.add({ id: 'volcano', tab: 'powers', group: 'destroy', name: 'Вулкан', short: 'Вулкан', icon: 'volcano', brush: true, drag: false, hint: 'Тап: поднять вулкан (кисть = размер конуса). Тап по вулкану: новое извержение' });

  // ------------------------------------------------------------------ tunables
  const CAP = 3;                                   // live volcanoes
  const RUMBLE = 60, REOPEN_RUMBLE = 30;           // ticks
  const ERUPT_MIN = 500, ERUPT_MAX = 800;
  const COOL_TICKS = 150;
  const BURST_MIN = 25, BURST_MAX = 70, BOMBS_MIN = 3, BOMBS_MAX = 8, MAX_BOMBS = 24;
  const HIT_R = 1.3;                               // bomb blast radius against units (tiles)
  const FLOW_CAP = 40, LAVA_CAP = 56, FLOW_REACH = 11;   // live flow tiles / tracked lava tiles per volcano / tiles beyond the cone the tongue may travel
  const FLOW_LIFE = 300, BOMB_LAVA_LIFE = 120;
  const RIM = 232, BASE_E = 164, FLOOR = 204;      // cone profile: elevation of the crater rim, of the foot of the cone, of the crater floor
  const SM = 0.62;                                 // share of the slope (crater edge -> foot) that is MOUNTAIN
  const MTN_LO = 192;                              // MOUNTAIN from this elevation, HILL below
  const MAX_CONES = 24;
  const OFFS = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9, 2.6];
  const Q = 4;                                     // numbers per tracked lava tile in entry.lav

  // ------------------------------------------------------------------ small helpers
  function finite(v) { return typeof v === 'number' && v === v && v > -1e9 && v < 1e9; }
  function inMap(x, y) { return x >= 0 && y >= 0 && x < S.w && y < S.h; }
  function water(i) { const t = S.tile[i]; return t === T.DEEP || t === T.SHALLOW; }
  function wetAt(i) {
    const w = S.w, h = S.h, x = i % w, y = (i - x) / w;
    return (x > 0 && water(i - 1)) || (x < w - 1 && water(i + 1)) || (y > 0 && water(i - w)) || (y < h - 1 && water(i + w));
  }
  function list() { const e = S.eff; if (!Array.isArray(e[KEY])) e[KEY] = []; return e[KEY]; }
  function mod() {
    let m = S.mod.volcano;
    if (!m || typeof m !== 'object') m = S.mod.volcano = {};
    if (!Array.isArray(m.cones)) m.cones = [];
    return m;
  }
  function angDiff(a, b) { const d = Math.abs(a - b) % TAU; return d > Math.PI ? TAU - d : d; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function jitter(x, y) { return ((Util.hash2(x, y, S.seed) & 255) / 255 - 0.5) * 6; }
  function burnP(i) {
    if (S.bld[i]) return 0.8;
    const t = S.tile[i], rk = S.res[i];
    if (t === T.FOREST) return 0.85;
    if (rk === RES.TREE) return 0.8;
    if (rk === RES.BERRY) return 0.5;
    if (t === T.GRASS) return 0.4;
    if (t === T.HILL) return 0.1;
    return 0;
  }
  // the volcano's own random stream (mulberry32, state in e.rs): see the header
  function rf(e) {
    const s = e.rs = (e.rs + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function ri(e, n) { return (rf(e) * n) | 0; }
  function rint(e, a, b) { return a + ((rf(e) * (b - a + 1)) | 0); }

  // ------------------------------------------------------------------ geometry (pure functions of the brush radius)
  function baseR(r) { return 3 + r / 2; }
  function craterR(r) { return r <= 2 ? 1.1 : r <= 5 ? 1.5 : 2.05; }
  /** elevation of the cone surface at distance d tiles from the centre (without the per-tile jitter): the crater floor inside rc, then the rim
   *  (RIM) falling in two even slopes - MOUNTAIN down to MTN_LO at SM of the way to the foot, HILL foothills down to BASE_E at the foot (d = rb) */
  function profile(r, d) {
    const rb = baseR(r), rc = craterR(r);
    if (d <= rc) return FLOOR;
    const s = Math.min(1, (d - rc) / (rb - rc));
    if (s <= SM) return RIM - (RIM - MTN_LO) * Math.pow(s / SM, 1.1);
    return MTN_LO - (MTN_LO - BASE_E) * (s - SM) / (1 - SM);
  }
  /** the footprint in building order: the foothills first, the rim last, tiles of one shell one after the other (by angle). Saved in the entry (e.bs) while the cone rises:
   *  tile k of n rises at tick k * 46 / n, so every tick of the rumble gets the same number of tiles (a whole r=8 cone is ~3.3 per tick) */
  function buildList(e) {
    const cx = Math.floor(e.x), cy = Math.floor(e.y), R0 = Math.ceil(e.rb), out = [];
    for (let y = Math.max(0, cy - R0); y <= Math.min(S.h - 1, cy + R0); y++) {
      for (let x = Math.max(0, cx - R0); x <= Math.min(S.w - 1, cx + R0); x++) {
        const dx = x + 0.5 - e.x, dy = y + 0.5 - e.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d <= e.rb) out.push([d, Math.atan2(dy, dx), y * S.w + x]);
      }
    }
    out.sort((a, b) => (b[0] - a[0]) || (a[1] - b[1]) || (a[2] - b[2]));
    return out.map((a) => a[2]);
  }

  // ------------------------------------------------------------------ city bookkeeping for the one notable log line
  /** a building was destroyed by the volcano: remember how big the city was, log once when its heart and 3/4 of it are gone */
  function note(e, c) {
    const cb = e.cb;
    let k = -2;
    for (let i = 0; i < cb.length; i += 2) if (cb[i] === c.id) { k = i; break; }
    if (k < 0) {
      if (cb.length >= 16) cb.splice(0, 2);
      cb.push(c.id, c.buildings.length + 1);
      k = cb.length - 2;
    }
    const before = cb[k + 1];
    if (before >= 3 && c.buildings.length <= Math.floor(before * 0.25) && e.lg.indexOf(c.id) < 0 && Buildings.count(c.id, Const.B.TOWNHALL, true) === 0) {
      if (e.lg.length >= 12) e.lg.shift();
      e.lg.push(c.id);
      Log.add('Лава уничтожила город «' + c.name + '»', LOG.DISASTER, c.x, c.y, c.kingdomId);
      Hist.add(c, 'Уничтожен извержением вулкана');
    }
  }
  /** destroy (dmg undefined) or damage the building on a tile; returns true when it is gone */
  function hitBuilding(e, x, y, dmg) {
    const b = Buildings.at(x, y);
    if (!b) return false;
    const c = S.cities.get(b.cityId) || null;
    const gone = dmg > 0 ? Buildings.damage(b, dmg, 0, 'volcano') === true : Buildings.destroy(b, 'volcano') === true;
    if (gone && c) note(e, c);
    return gone;
  }

  // ------------------------------------------------------------------ units
  const scratch = [];
  let ox = 0, oy = 0;
  function pushU(u) { scratch.push(u); }
  function byId(a, b) { return a.id - b.id; }
  function byDist(a, b) { const da = (a.x - ox) * (a.x - ox) + (a.y - oy) * (a.y - oy), db = (b.x - ox) * (b.x - ox) + (b.y - oy) * (b.y - oy); return da - db || a.id - b.id; }
  function safeSpot(tx, ty) {
    if (!World.walkable(tx, ty)) return false;
    const x = tx | 0, y = ty | 0, w = S.w;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= S.h) continue;
      const i = yy * w + xx;
      if (S.tile[i] === T.LAVA || S.fire[i] > 0) return false;
    }
    return !water(y * w + x);
  }
  /** make a unit run away from the volcano (the same state a fire panic uses: Units.actFlee walks to st.tx / st.ty) */
  function scareUnit(u, e, tick) {
    const dx = u.x - e.x, dy = u.y - e.y, d = Math.sqrt(dx * dx + dy * dy);
    const base = d > 0.2 ? Math.atan2(dy, dx) : ((u.id * 2.399963229728653) % TAU);
    const run = 6 + Math.max(0, e.rb + 4 - d);
    for (let k = 0; k < OFFS.length; k++) {
      const a = base + OFFS[k];
      const tx = u.x + Math.cos(a) * run, ty = u.y + Math.sin(a) * run;
      if (tx < 0.5 || ty < 0.5 || tx > S.w - 0.5 || ty > S.h - 0.5) continue;
      if ((tx - e.x) * (tx - e.x) + (ty - e.y) * (ty - e.y) < (d + 2) * (d + 2)) continue;
      if (!safeSpot(tx, ty) || !World.sameLand(u.x, u.y, tx, ty)) continue;
      u.job = null; u.state = 'flee';
      u.st = { ph: 'go', since: tick, tx, ty, rg: 0.8, then: '', rest: 0, until: tick + 100, pk: tick + 100 };
      u.nextThink = tick + 20;
      return true;
    }
    return false;
  }
  /** scare the nearest `maxN` civilians within rad (soldiers and settlers keep their orders) */
  function scare(e, tick, rad, maxN) {
    scratch.length = 0;
    Units.nearby(e.x, e.y, rad, pushU);
    if (scratch.length === 0) return 0;
    ox = e.x; oy = e.y;
    scratch.sort(byDist);
    let n = 0;
    for (let k = 0; k < scratch.length && n < maxN; k++) {
      const u = scratch[k];
      if (!(u.hp > 0) || u.armyId || u.state === 'settle') continue;
      if (u.state === 'flee' && u.st && u.st.pk > tick) continue;
      if (scareUnit(u, e, tick)) n++;
    }
    scratch.length = 0;
    return n;
  }

  // ------------------------------------------------------------------ the cone
  function raiseTile(e, x, y, d) {
    const w = S.w, i = y * w + x, old = S.tile[i], oe = S.elev[i];
    let E = (d <= e.rc ? RIM - 4 : profile(e.r, d)) + jitter(x, y);
    E = Math.round(E);
    const fresh = old === T.DEEP || old === T.SHALLOW || old === T.LAVA;        // water / lava is replaced, land is only ever raised
    const ne = fresh ? E : Math.max(oe, E);
    const nt = ne >= MTN_LO ? T.MOUNTAIN : T.HILL;
    if (S.bld[i]) hitBuilding(e, x, y);
    if (old === nt && oe === ne) return false;
    World.setTile(x, y, nt, { elev: ne });
    if (old === T.DEEP || old === T.SHALLOW) {                                  // a shallow shelf so the new island does not stand on a cliff
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < S.h && S.tile[yy * w + xx] === T.DEEP) World.setTile(xx, yy, T.SHALLOW, { elev: 84 });
      }
    }
    return true;
  }
  /** the tiles that rise at relative tick `el` (each tile exactly once); the whole cone stands after tick rum - 14 */
  function buildStep(e, el) {
    const bs = e.bs, n = bs.length, span = e.rum - 14;
    if (n === 0 || el > span) return 0;
    const from = Math.floor((el - 1) * n / span), to = Math.floor(el * n / span);
    for (let k = from; k < to; k++) {
      const i = bs[k], x = i % S.w, y = (i - x) / S.w, dx = x + 0.5 - e.x, dy = y + 0.5 - e.y;
      raiseTile(e, x, y, Math.sqrt(dx * dx + dy * dy));
    }
    if (el >= span) e.bs = [];
    return to - from;
  }
  function completeCone(e) {
    const cx = Math.floor(e.x), cy = Math.floor(e.y), R0 = Math.ceil(e.rb);
    for (let y = Math.max(0, cy - R0); y <= Math.min(S.h - 1, cy + R0); y++) {
      for (let x = Math.max(0, cx - R0); x <= Math.min(S.w - 1, cx + R0); x++) {
        const dx = x + 0.5 - e.x, dy = y + 0.5 - e.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d <= e.rb) raiseTile(e, x, y, d);
      }
    }
  }
  function craterList(cx, cy, rc) {
    const out = [], R0 = Math.ceil(rc);
    for (let dy = -R0; dy <= R0; dy++) {
      for (let dx = -R0; dx <= R0; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy), x = cx + dx, y = cy + dy;
        if (d <= rc && inMap(x, y)) out.push([d, y * S.w + x]);
      }
    }
    out.sort((a, b) => (b[0] - a[0]) || (a[1] - b[1]));                           // outer ring first, the core last
    return out.map((a) => a[1]);
  }
  function openCrater(e) {
    for (let k = 0; k < e.cr.length; k++) lavaAt(e, e.cr[k]);
  }
  function lavaAt(e, i) {
    if (S.tile[i] === T.LAVA) return;
    const x = i % S.w, y = (i - x) / S.w;
    if (S.bld[i]) hitBuilding(e, x, y);
    World.setTile(x, y, T.LAVA, { elev: FLOOR });
  }
  /** keep the crater open (tiles that are not cooled yet): the World's slow random cooling must not make holes in it; every tick, so a tile is never seen cooled */
  function keepCrater(e) {
    for (let k = e.cc; k < e.cr.length; k++) {
      const i = e.cr[k];
      if (S.tile[i] === T.LAVA || wetAt(i)) continue;
      lavaAt(e, i);
    }
  }
  /** a crater tile solidifies (always to the same result): the core (d <= 1.05) becomes HILL, the ring MOUNTAIN */
  function coolCraterTile(e, i, quiet) {
    const x = i % S.w, y = (i - x) / S.w, dx = x + 0.5 - e.x, dy = y + 0.5 - e.y, d = Math.sqrt(dx * dx + dy * dy);
    if (S.bld[i]) hitBuilding(e, x, y);
    if (d <= 1.05) World.setTile(x, y, T.HILL, { elev: 178 });
    else World.setTile(x, y, T.MOUNTAIN, { elev: 214 });
    if (!quiet && ((i * 7 + S.tick) & 3) === 0) Fx.add('smoke', x + 0.5, y + 0.5, { ttl: 1.0 });
  }

  // ------------------------------------------------------------------ lava tiles (bombs and the tongue) and their cooling
  /** one lava tile: tracked in e.lav with its cooling tick and the elevation it had. Lava that meets water solidifies at once (the steam / basalt rule of the World). */
  function placeLava(e, x, y, life, tick, kind) {
    if (!inMap(x, y) || e.lav.length >= LAVA_CAP * Q) return false;
    const i = y * S.w + x, t = S.tile[i];
    if (t === T.LAVA || t === T.DEEP || t === T.SHALLOW) return false;
    const el = S.elev[i];
    if (S.bld[i]) hitBuilding(e, x, y);
    if (wetAt(i)) {
      World.setTile(x, y, T.MOUNTAIN, { elev: Math.max(el, MTN_LO + 2) });
      Fx.add('smoke', x + 0.5, y + 0.5, { ttl: 1.1, n: 3 });
      return false;
    }
    World.setTile(x, y, T.LAVA, { elev: el });
    if (S.tile[i] !== T.LAVA) return false;
    e.lav.push(i, tick + life, kind, el);
    return true;
  }
  /** one lava tile solidifies: basalt (MOUNTAIN) on the cone or next to water, HILL on the plain */
  function coolIdx(i) {
    if (S.tile[i] !== T.LAVA) return false;
    const x = i % S.w, el = S.elev[i], y = (i - x) / S.w;
    if (wetAt(i) || el >= 186) World.setTile(x, y, T.MOUNTAIN, { elev: Math.max(el, MTN_LO + 2) });
    else World.setTile(x, y, T.HILL, { elev: Math.max(el, 164) });
    if (((i * 5 + S.tick) & 3) === 0) Fx.add('smoke', x + 0.5, y + 0.5, { ttl: 1.0 });
    return true;
  }
  /** put back what the World's random cooling took early, cool the tiles whose time has come (<= 3 per tick), forget tiles somebody else changed */
  function stepLava(e, tick) {
    const lv = e.lav;
    if (lv.length === 0) return;
    const w = S.w;
    let wr = 0, cooled = 0;
    for (let k = 0; k < lv.length; k += Q) {
      const i = lv[k], due = lv[k + 1], kind = lv[k + 2], e0 = lv[k + 3];
      let t = S.tile[i];
      if (t !== T.LAVA) {
        if (t === T.HILL && (S.elev[i] === 176 || S.elev[i] === e0)) {            // the World's dry cooling (HILL, elevation 176 or unchanged) came before its time
          const x = i % w; World.setTile(x, (i - x) / w, T.LAVA, { elev: e0 }); t = S.tile[i];
        }
        if (t !== T.LAVA) continue;                                               // overwritten by something else (another volcano, the player): forget it
      }
      if (due <= tick && cooled < 3) { coolIdx(i); cooled++; continue; }
      lv[wr++] = i; lv[wr++] = due; lv[wr++] = kind; lv[wr++] = e0;
    }
    lv.length = wr;
  }
  function coolAll(e) {
    const lv = e.lav;
    for (let k = 0; k < lv.length; k += Q) coolIdx(lv[k]);
    lv.length = 0;
  }

  // ------------------------------------------------------------------ the lava tongue
  const DX4 = [1, -1, 0, 0], DY4 = [0, 0, 1, -1];
  function isCrater(e, i) { return e.cr.indexOf(i) >= 0; }
  function flowStep(e, tick) {
    const w = S.w, lv = e.lav, reach = e.rb + FLOW_REACH;
    let nf = 0;
    for (let k = 0; k < lv.length; k += Q) if (lv[k + 2] === 1) nf++;
    if (nf >= FLOW_CAP) {                                                         // keep the tongue short: the oldest tile solidifies first
      for (let k = 0; k < lv.length; k += Q) if (lv[k + 2] === 1) { lv[k + 1] = 0; break; }
    }
    let best = -1, bs = 1e9;
    const scan = (sx, sy, sd) => {
      for (let q = 0; q < 4; q++) {
        const nx = sx + DX4[q], ny = sy + DY4[q];
        if (!inMap(nx, ny)) continue;
        const n = ny * w + nx, t = S.tile[n];
        if (t === T.LAVA || t === T.DEEP || t === T.SHALLOW || isCrater(e, n) || wetAt(n)) continue;
        const ddx = nx + 0.5 - e.x, ddy = ny + 0.5 - e.y, nd = Math.sqrt(ddx * ddx + ddy * ddy);
        if (nd > reach || nd < sd - 0.05) continue;                              // downhill = away from the crater, never back
        const score = S.elev[n] + angDiff(Math.atan2(ddy, ddx), e.fa) * 9 + rf(e) * 5;
        if (score < bs) { bs = score; best = n; }
      }
    };
    if (nf === 0) {                                                               // breach in the rim
      for (let k = 0; k < e.cr.length; k++) { const c = e.cr[k], cx = c % w, cy = (c - cx) / w; scan(cx, cy, 0); }
    } else {
      let seen = 0;
      for (let k = lv.length - Q; k >= 0 && seen < 6; k -= Q) {
        if (lv[k + 2] !== 1) continue;
        seen++;
        const src = lv[k], sx = src % w, sy = (src - sx) / w, sdx = sx + 0.5 - e.x, sdy = sy + 0.5 - e.y;
        scan(sx, sy, Math.sqrt(sdx * sdx + sdy * sdy));
      }
    }
    if (best < 0) {                                                               // stuck: pick another direction, wait a bit
      e.fa = rf(e) * TAU; e.fs++;
      e.fn = tick + (e.fs > 3 ? 40 : 12);
      return false;
    }
    e.fs = 0;
    const x = best % w, y = (best - x) / w;
    const ok = placeLava(e, x, y, FLOW_LIFE + ri(e, 150), tick, 1);
    e.fn = tick + 10 + ri(e, 5);
    if (ok) {
      for (let q = 0; q < 4; q++) {                                               // the front sets fire to what it touches
        const nx = x + DX4[q], ny = y + DY4[q];
        if (!inMap(nx, ny)) continue;
        const p = burnP(ny * w + nx);
        if (p > 0 && rf(e) < p * 0.5) World.ignite(nx, ny);
      }
    }
    return ok;
  }

  // ------------------------------------------------------------------ bombs
  function burst(e, tick, big) {
    const prog = e.until > e.t1 ? (tick - e.t1) / (e.until - e.t1) : 1;
    let n = big ? BOMBS_MAX : rint(e, BOMBS_MIN, BOMBS_MAX);
    if (!big && prog > 0.8) n = Math.max(BOMBS_MIN, n - 2);
    const dmax = e.rb + 3.5 + e.r * 0.25, d0 = e.rc + 0.5;
    for (let k = 0; k < n && e.bombs.length < MAX_BOMBS; k++) {
      const d = d0 + (dmax - d0) * Math.pow(rf(e), 1.25), a = rf(e) * TAU;
      const tx = clamp(e.x + Math.cos(a) * d, 0.5, S.w - 0.5), ty = clamp(e.y + Math.sin(a) * d, 0.5, S.h - 0.5);
      const fl = 15 + Math.floor(d * 1.5) + ri(e, 4), delay = k === 0 ? 0 : ri(e, 7);
      e.bombs.push([e.x, e.y, tx, ty, tick + delay, tick + delay + fl, 2 + d * 0.42]);
    }
    e.lb = tick; e.lbg = big ? 1 : 0; e.nb++;                                     // the crater blast itself is drawn by the gfx plugin from lb / lbg
    let iv = rint(e, BURST_MIN, BURST_MAX);
    if (!big && prog > 0.8) iv = Math.round(iv * 0.5 + 35);
    e.next = tick + (big ? 30 : iv);
    Fx.add('shake', e.x, e.y, { amp: big ? 7 : 2.2, ttl: big ? 0.9 : 0.35 });
    if (big) Fx.add('flash', e.x, e.y, { ttl: 0.7, a: 0.5, color: '#ffd79a' });
    for (let k = 0; k < (big ? 5 : 3); k++) {                                     // ash flakes drifting down around the cone (cheap baked Fx)
      const hh = Util.hash2(tick, k + e.id * 7, 191), a = (hh & 1023) / 1023 * TAU, d = (1 + ((hh >>> 10) & 1023) / 1023 * (e.rb + 2));
      Fx.add('ash', e.x + Math.cos(a) * d, e.y + Math.sin(a) * d * 0.8 - 1, { ttl: 1.8 });
    }
    scare(e, tick, dmax + 1.5, big ? 60 : 30);
  }
  function landBombs(e, tick) {
    const bs = e.bombs;
    if (bs.length === 0) return;
    let wr = 0;
    for (let k = 0; k < bs.length; k++) {
      const b = bs[k];
      if (tick >= b[5]) impact(e, b, tick); else bs[wr++] = b;
    }
    bs.length = wr;
  }
  function impact(e, b, tick) {
    const tx = b[2], ty = b[3], ix = Math.floor(tx), iy = Math.floor(ty), w = S.w;
    if (!inMap(ix, iy)) return;
    e.bl++;
    Fx.add('volc_impact', tx, ty, { ttl: 0.6 });
    // creatures within the blast
    scratch.length = 0;
    Units.nearby(tx, ty, HIT_R, pushU);
    if (scratch.length > 0) {
      scratch.sort(byId);
      for (let k = 0; k < scratch.length; k++) {
        const u = scratch[k], d = Math.sqrt((u.x - tx) * (u.x - tx) + (u.y - ty) * (u.y - ty));
        if (Units.damage(u, 22 - 8 * (d / HIT_R), 'volcano') !== true && S.units.get(u.id) === u) u.burning = tick + 25;
      }
      scratch.length = 0;
    }
    // buildings and flammables on the tiles touched by the blast
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = ix + dx, yy = iy + dy;
        if (!inMap(xx, yy)) continue;
        const d = Math.sqrt((xx + 0.5 - tx) * (xx + 0.5 - tx) + (yy + 0.5 - ty) * (yy + 0.5 - ty));
        if (d > HIT_R + 0.3) continue;
        const i = yy * w + xx;
        if (S.bld[i]) hitBuilding(e, xx, yy, d < 0.8 ? 60 : 30);
        const p = burnP(i) * (1 - 0.35 * d / (HIT_R + 0.3));
        if (p > 0 && rf(e) < p) World.ignite(xx, yy);
      }
    }
    // the bomb leaves a lava puddle (not on water, not on the crater, never beyond the cap)
    const i = iy * w + ix, t = S.tile[i];
    if (t === T.DEEP || t === T.SHALLOW) { Fx.add('splash', tx, ty, { ttl: 0.7 }); return; }
    if (t !== T.LAVA && !isCrater(e, i) && rf(e) < 0.75) {
      const life = Math.min(BOMB_LAVA_LIFE + ri(e, 180), e.phase === 2 ? Math.max(5, e.until - tick - 5) : 1e6);
      placeLava(e, ix, iy, life, tick, 0);
    }
  }

  // ------------------------------------------------------------------ lifecycle
  function newEntry(cx, cy, r, tick, old) {
    const rb = baseR(r), rc = craterR(r), rum = old ? REOPEN_RUMBLE : RUMBLE;
    const e = {
      id: S.id(), x: cx + 0.5, y: cy + 0.5, r, rb, rc, phase: 0, t0: tick, rum, until: tick + rum, t1: 0, t2: 0, next: 0, nb: 0, bl: 0, lb: -999, lbg: 0,
      bombs: [], lav: [], cr: craterList(cx, cy, rc), bs: [], fa: 0, fn: 0, fs: 0, cc: 0, old: old ? 1 : 0, wd: 0, rs: R.int(1, 2147483000), cb: [], lg: [],
    };
    e.wd = Math.round((rf(e) * 2 - 1) * 1000) / 1000;
    if (!old) e.bs = buildList(e);
    return e;
  }
  function rumbleFx(e, el) {
    const k = Math.min(1, el / e.rum);
    if (el % 6 === 0) Fx.add('shake', e.x, e.y, { amp: 0.8 + 3.2 * k, ttl: 0.28 });
    if (el % 4 === 0) {
      const hh = Util.hash2(el, e.id, 77), a = (hh & 1023) / 1023 * TAU, d = ((hh >>> 10) & 1023) / 1023 * e.rb;
      Fx.add('dust', e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, { ttl: 0.7, color: '#8e7452' });
    }
  }
  function beginEruption(e, tick) {
    e.phase = 1; e.t1 = tick;
    e.until = tick + rint(e, ERUPT_MIN, ERUPT_MAX);
    e.fa = rf(e) * TAU; e.fn = tick + 14; e.fs = 0; e.cc = 0;
    openCrater(e);
    burst(e, tick, true);
  }
  function beginCooling(e, tick) {
    e.phase = 2; e.t2 = tick; e.until = tick + COOL_TICKS; e.cc = 0; e.next = 0;
    const lv = e.lav;
    for (let k = 0; k < lv.length; k += Q) lv[k + 1] = Math.min(lv[k + 1], tick + 15 + ri(e, 100));
  }
  function coolCrater(e, tick) {
    if (e.cc < e.cr.length && (tick - e.t2) % 5 === 0 && tick - e.t2 >= 10) coolCraterTile(e, e.cr[e.cc++], false);
  }
  function rememberCone(e) {
    const m = mod(), cx = Math.floor(e.x), cy = Math.floor(e.y);
    for (let k = m.cones.length - 1; k >= 0; k--) if (m.cones[k][0] === cx && m.cones[k][1] === cy) m.cones.splice(k, 1);
    m.cones.push([cx, cy, e.r, S.tick]);
    while (m.cones.length > MAX_CONES) m.cones.shift();
  }
  /** end of the life of an entry: everything solid, the cone is remembered */
  function endVolcano(e, tick) {
    for (let k = e.cc; k < e.cr.length; k++) coolCraterTile(e, e.cr[k], true);
    e.cc = e.cr.length;
    coolAll(e);
    e.bombs.length = 0;
    rememberCone(e);
    Fx.add('smoke', e.x, e.y, { ttl: 1.2, n: 3 });
  }
  /** calm a volcano down at once (it is replaced by a newer one) */
  function forceFinish(e, tick) {
    if (e.phase === 0 && !e.old) completeCone(e);
    endVolcano(e, tick);
  }
  function stepOne(e, tick) {
    if (e.phase !== 0) { keepCrater(e); stepLava(e, tick); }
    if (e.phase === 0) {
      const el = tick - e.t0;
      if (!e.old && el >= 1 && el <= e.rum) buildStep(e, el);
      rumbleFx(e, el);
      if (el === 30 && !e.old) scare(e, tick, e.rb + 4, 40);
      if (tick >= e.until) beginEruption(e, tick);
    } else if (e.phase === 1) {
      if (tick >= e.next) burst(e, tick, false);
      if (tick >= e.fn && tick < e.until - 60) flowStep(e, tick);
      if (tick >= e.until) beginCooling(e, tick);
    } else {
      coolCrater(e, tick);
      if (tick >= e.until) { endVolcano(e, tick); return false; }
    }
    landBombs(e, tick);
    return true;
  }

  // ------------------------------------------------------------------ the tap
  function reerupt(e, host) {
    const tick = S.tick;
    if (e.phase === 0) {
      Fx.add('shake', e.x, e.y, { amp: 2, ttl: 0.3 });
      return host.msg('Вулкан уже просыпается', true);
    }
    if (e.phase === 2) { e.phase = 1; e.t1 = tick; e.cc = 0; e.fn = tick + 14; e.fs = 0; openCrater(e); }
    e.until = Math.max(e.until, tick + rint(e, ERUPT_MIN, ERUPT_MAX));
    burst(e, tick, true);
    return host.msg('Вулкан извергается снова!', true);
  }
  function spawn(cx, cy, r, old, host) {
    const tick = S.tick, L = list();
    let replaced = false;
    if (L.length >= CAP) {                                                        // the oldest one gives way
      let oi = 0;
      for (let k = 1; k < L.length; k++) if (L[k].t0 < L[oi].t0 || (L[k].t0 === L[oi].t0 && L[k].id < L[oi].id)) oi = k;
      const dead = L.splice(oi, 1)[0];
      forceFinish(dead, tick);
      replaced = true;
    }
    const e = newEntry(cx, cy, r, tick, old);
    L.push(e);
    Fx.add('shake', e.x, e.y, { amp: 2.5, ttl: 0.4 });
    Fx.add('dust', e.x, e.y, { ttl: 0.8, color: '#8e7452' });
    scare(e, tick, e.rb + 5, 40);
    const c = host.nearestCity(e.x, e.y, 14);
    Log.add(c ? 'Проснулся вулкан близ города «' + c.name + '»' : 'Проснулся вулкан', LOG.DISASTER, cx, cy, c ? c.kingdomId : 0);
    return host.msg(replaced ? 'Старый вулкан затих — просыпается новый' : 'Вулкан просыпается!', true);
  }
  function tap(x, y, r, host) {
    const cx = Math.floor(x), cy = Math.floor(y), L = list();
    for (let k = 0; k < L.length; k++) {
      const e = L[k];
      if ((x - e.x) * (x - e.x) + (y - e.y) * (y - e.y) <= Math.pow(Math.max(e.rb, 2.5), 2)) return reerupt(e, host);
    }
    const m = mod();
    for (let k = 0; k < m.cones.length; k++) {
      const c = m.cones[k], ccx = c[0] + 0.5, ccy = c[1] + 0.5;
      if ((x - ccx) * (x - ccx) + (y - ccy) * (y - ccy) > Math.pow(Math.max(baseR(c[2]), 2.5), 2)) continue;
      m.cones.splice(k, 1);
      const t = inMap(c[0], c[1]) ? S.tile[c[1] * S.w + c[0]] : -1;
      if (t === T.HILL || t === T.MOUNTAIN) return spawn(c[0], c[1], c[2], true, host);       // the cone is still there: reopen it
      break;                                                                       // somebody flattened it: build a new one
    }
    return spawn(cx, cy, r, false, host);
  }

  // ------------------------------------------------------------------ sanitising loaded / foreign data
  function clean() {
    const L = list(), out = [];
    for (let k = 0; k < L.length; k++) {
      const e = L[k];
      if (!e || typeof e !== 'object' || !finite(e.x) || !finite(e.y) || !inMap(e.x, e.y) || !finite(e.t0) || !finite(e.until)) continue;
      e.r = clamp(Math.round(finite(e.r) ? e.r : 3), 1, 8);
      e.rb = baseR(e.r); e.rc = craterR(e.r);
      if (e.phase !== 0 && e.phase !== 1 && e.phase !== 2) e.phase = 1;
      if (!finite(e.id)) e.id = S.id();
      for (const f of ['rum', 't1', 't2', 'next', 'nb', 'bl', 'fa', 'fn', 'fs', 'cc']) if (!finite(e[f])) e[f] = 0;
      if (!(e.rum > 0)) e.rum = e.old ? REOPEN_RUMBLE : RUMBLE;
      if (!finite(e.lb)) e.lb = -999;
      e.lbg = e.lbg ? 1 : 0;
      if (!finite(e.wd)) e.wd = 0;
      if (!Number.isInteger(e.rs)) e.rs = 1 + (Math.abs(e.id | 0) % 1000003);
      e.old = e.old ? 1 : 0;
      e.bombs = (Array.isArray(e.bombs) ? e.bombs : []).filter((b) => Array.isArray(b) && b.length === 7 && b.every(finite)).slice(0, MAX_BOMBS);
      const nn = S.w * S.h;
      const lv = Array.isArray(e.lav) ? e.lav : [], lo = [];
      for (let q = 0; q + Q - 1 < lv.length; q += Q) if (Number.isInteger(lv[q]) && lv[q] >= 0 && lv[q] < nn && finite(lv[q + 1]) && (lv[q + 2] === 0 || lv[q + 2] === 1) && finite(lv[q + 3])) lo.push(lv[q], lv[q + 1], lv[q + 2], lv[q + 3]);
      e.lav = lo.slice(0, LAVA_CAP * Q);
      const cr = Array.isArray(e.cr) ? e.cr.filter((i) => Number.isInteger(i) && i >= 0 && i < nn) : [];
      e.cr = cr.length ? cr : craterList(Math.floor(e.x), Math.floor(e.y), e.rc);
      e.cc = clamp(Math.round(e.cc), 0, e.cr.length);
      e.bs = (Array.isArray(e.bs) ? e.bs : []).filter((i) => Number.isInteger(i) && i >= 0 && i < nn).slice(0, 400);
      if (e.phase === 0 && !e.old && e.bs.length === 0 && S.tick - e.t0 < e.rum - 14) e.bs = buildList(e);                        // a foreign / old entry in the middle of its rise
      e.cb = (Array.isArray(e.cb) ? e.cb : []).filter(finite).slice(0, 16);
      if (e.cb.length & 1) e.cb.pop();
      e.lg = (Array.isArray(e.lg) ? e.lg : []).filter(finite).slice(0, 12);
      out.push(e);
    }
    while (out.length > CAP) out.shift();
    S.eff[KEY] = out;
    const m = mod();
    m.cones = m.cones.filter((c) => Array.isArray(c) && c.length === 4 && c.every(finite) && inMap(c[0], c[1])).slice(-MAX_CONES);
  }

  // ------------------------------------------------------------------ plugin API
  const api = {
    name: 'volcano',
    ids: ['volcano'],
    apply(id, x, y, r, first, lx, ly, host) {
      if (id !== 'volcano') return false;
      if (!host.inMap(x, y)) return host.msg('Вне карты', false);
      return tap(x, y, host.rInt(r, 1, 8, 3), host);
    },
    step(tick, host) {
      const L = S.eff[KEY];
      if (!Array.isArray(L) || L.length === 0) return;
      let wr = 0;
      for (let k = 0; k < L.length; k++) {
        const e = L[k];
        let keep = false;
        try { keep = !!e && finite(e.x) && finite(e.y) && stepOne(e, tick) !== false; }
        catch (err) {
          host.report(err, 'volcano step');
          try { forceFinish(e, tick); } catch (err2) { /* the entry is dropped anyway */ }
        }
        if (keep) L[wr++] = e;
      }
      L.length = wr;
    },
    newWorld() { S.mod.volcano = { cones: [] }; list(); },
    afterLoad() { clean(); },
    // test / diagnostics helpers
    geom(r) { return { rb: baseR(r), rc: craterR(r), rim: RIM, base: BASE_E, floor: FLOOR, mtnLo: MTN_LO, mtnShare: SM, elevAt: (d) => profile(r, d) }; },
    limits: { CAP, RUMBLE, REOPEN_RUMBLE, ERUPT_MIN, ERUPT_MAX, COOL_TICKS, BURST_MIN, BURST_MAX, BOMBS_MIN, BOMBS_MAX, MAX_BOMBS, HIT_R, FLOW_CAP, LAVA_CAP, FLOW_REACH, Q },
    list,
  };
  PowerPlugins.push(api);
  return api;
})();
