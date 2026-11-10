/* =====================================================================
 * 16_power_rocket.js — god power «Ракеты» (rocket volley). Sim plugin, CONTRACT section 10.   DOM-free (runs headless in node).
 * OWNER: rocket power. Graphics: src/31_gfx_rocket.js. Tests: tests/power_rocket.test.mjs. Notes: docs/feat_rocket.md.
 *
 *  Tool 'rocket' (tab Силы, group «Арсенал»), brush: true (radius r = size of the salvo and its scatter), one tap = one salvo.
 *   - salvo size N = 3 + r rockets (cap 9). Aim points are scattered inside a disc of 0.8 * r tiles around the tap (the first rocket
 *     lands on the tap itself) and lean toward units / buildings inside the circle, so a salvo feels targeted.
 *   - launch rule: the NEAREST MAP EDGE to the tap (ties: south, north, west, east). The whole salvo starts in a small battery just beyond
 *     that edge (1.2 .. 4 tiles outside the map, spread along the edge), so the player always sees rockets come in from the sea side.
 *   - flight: 14..26 ticks (longer for farther targets), a curved arc (a quadratic Bezier with a small sideways bend + a ballistic altitude
 *     hump that only the renderer shows), each rocket launches 0..10 ticks late (random stagger) so the salvo arrives as a ripple.
 *   - impact: blast radius 1.8 tiles. Creatures: falloff damage (90 in the 0.75 core, ~34 at 1.25, ~7 at 1.6), survivors in the ring are
 *     shoved outwards and the closest ones catch fire. Buildings: heavy falloff damage (160 * (1 - d/2)^0.9). Every flammable tile in the
 *     blast ignites with 45 % (World.ignite -> the existing burnt-ground decals). Forest inside radius 1.0 is felled (-> grass), lone trees /
 *     berries inside 1.3 are cleared. Mountains / snow / lava / water tiles are never changed. A small camera shake per impact.
 *     More than 3 impacts in one tick: the 4th and later are merged into ONE bigger burst (cost protection), damage is still applied each.
 *   - launcher cooldown 12 ticks (a tap during it fails with «Пусковые устройства перезаряжаются»), at most 54 rockets alive.
 *   - feedback: toast «Залп: N ракет» (Bus 'rocketVolley' -> the graphics plugin toasts it, plain host.msg only toasts failures);
 *     the event feed gets ONE aggregated line per salvo for notable results (>= 3 dead or >= 2 buildings razed) and a line for a killed ruler.
 *
 *  State (all JSON-safe, created lazily so worlds that never fire a rocket stay byte-identical):
 *   S.eff.rockets = [{x, y,                // CURRENT ground position (refreshed every tick: the renderer culls by it)
 *                     x0, y0, x1, y1,      // launch point (beyond the edge) and impact point
 *                     t0, eta,             // launch tick (may lie in the future = stagger), impact tick
 *                     r,                   // blast radius (tiles)
 *                     b, h, v, l}]         // private: sideways bend (fraction of the length), arc height (tiles), visual seed, launched flag
 *   S.mod.rocket  = {cd, a}                // cd = tick the launchers are ready again, a = aggregation of the current salvo for the log line
 *  Path (shared with the renderer through PowerRocket.path): ground position = quadratic Bezier with eased time (accelerating),
 *  altitude = h * 4 s (1 - s); a rocket sits at its launch point until t0 and impacts in the step of tick eta.
 *  All randomness goes through R (apply and impacts); impacts process creatures sorted by id so a loaded save continues identically.
 *  Fx used: rocket_launch / rocket_boom / rocket_smoke / rocket_trail (31_gfx_rocket.js), shake, splash.
 * ===================================================================== */

const PowerRocket = (() => {
  const T = Const.T, RES = Const.RES, LOG = Const.LOG, TAU = Math.PI * 2;

  // ------------------------------------------------------------------ tunables
  const N_BASE = 3, N_MAX = 9;                    // salvo = 3 + brush radius, at most 9 rockets
  const COOLDOWN = 12;                            // ticks between salvos
  const LIVE_CAP = 54;                            // rockets alive at once (6 full salvos)
  const SPREAD_K = 0.8;                           // aim scatter radius = SPREAD_K * brush radius (tiles)
  const BIAS = 0.75, PULL = 0.7, MAGNET_R = 3;    // chance that a scattered rocket leans toward the nearest unit / building (within MAGNET_R tiles), and how far (0..1)
  const FLIGHT_MIN = 14, FLIGHT_MAX = 26, STAGGER_MAX = 10;
  const BLAST_R = 1.8, CORE_R = 0.75, FELL_R = 1.0, TREE_R = 1.3, BLD_R = 1.9;
  const UNIT_DMG = 90, BLD_DMG = 160;
  const IGNITE_P = 0.45;
  const FULL_FX = 3;                              // impacts per tick with the full effect set; later ones are merged into one burst
  const HIT_CAP = 120;                            // creatures processed per impact
  const AGG_WINDOW = 40;                          // ticks after which the aggregated log line is written even if rockets are still in the air
  const RETICLE_TICKS = 10;                       // (renderer) the warning reticle shows during the last ticks of a flight

  // ------------------------------------------------------------------ small helpers
  function num(v, d) { return (typeof v === 'number' && v === v && v > -1e7 && v < 1e7) ? v : d; }
  function r3(v) { const q = Math.round(v * 1000) / 1000; return q === 0 ? 0 : q; }       // 3 decimals, never -0 (JSON round trips stay identical)
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function byId(a, b) { return a.id - b.id; }
  function isWaterT(t) { return t === T.DEEP || t === T.SHALLOW; }
  function inMap(x, y) { return x >= 0 && y >= 0 && x < S.w && y < S.h; }
  function mod() {
    let m = S.mod.rocket;
    if (!m || typeof m !== 'object') m = S.mod.rocket = { cd: 0, a: null };
    return m;
  }
  function list() {
    if (!S.eff || typeof S.eff !== 'object') S.eff = {};
    if (!Array.isArray(S.eff.rockets)) S.eff.rockets = [];
    return S.eff.rockets;
  }
  function goodEntry(e) {
    return !!e && typeof e === 'object' && num(e.x0, NaN) === e.x0 && num(e.y0, NaN) === e.y0 && num(e.x1, NaN) === e.x1 && num(e.y1, NaN) === e.y1 &&
      num(e.t0, NaN) === e.t0 && num(e.eta, NaN) === e.eta && e.eta >= e.t0;
  }

  /** flight path of rocket e at time T (ticks, may be fractional): out.x / out.y = ground position, out.alt = altitude in tiles,
   *  out.u = time fraction 0..1, out.s = eased distance fraction 0..1. A rocket waits at its launch point until t0 and stays at the target after eta. */
  function path(e, T0, out) {
    const dur = e.eta - e.t0;
    let u = dur > 0 ? (T0 - e.t0) / dur : 1;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const s = u * (0.6 + 0.4 * u), q = 1 - s;
    const dx = e.x1 - e.x0, dy = e.y1 - e.y0, b = e.b || 0;
    const cx = (e.x0 + e.x1) * 0.5 - dy * b, cy = (e.y0 + e.y1) * 0.5 + dx * b;          // chord midpoint pushed sideways by b * length
    out.x = q * q * e.x0 + 2 * q * s * cx + s * s * e.x1;
    out.y = q * q * e.y0 + 2 * q * s * cy + s * s * e.y1;
    out.alt = (e.h > 0 ? e.h : 1.5) * 4 * s * q;
    out.u = u; out.s = s;
    return out;
  }

  // ------------------------------------------------------------------ aiming
  const cand = [];                                 // scratch: x,y pairs of units / buildings inside the circle
  const cuUnits = [];                              // scratch: units inside the circle
  const pt = { x: 0, y: 0, alt: 0, u: 0, s: 0 };
  function collectUnit(u) { if (cuUnits.length < 48) cuUnits.push(u); }
  function candidates(x, y, r) {
    cand.length = 0; cuUnits.length = 0;
    Units.nearby(x, y, r + 0.5, collectUnit);
    if (cuUnits.length > 1) cuUnits.sort(byId);   // canonical order: the same save must aim identically
    for (let i = 0; i < cuUnits.length; i++) cand.push(cuUnits[i].x, cuUnits[i].y);
    cuUnits.length = 0;
    const rr = (r + 0.5) * (r + 0.5), w = S.w;
    const y0 = Math.max(0, Math.floor(y - r - 0.5)), y1 = Math.min(S.h - 1, Math.floor(y + r + 0.5));
    const x0 = Math.max(0, Math.floor(x - r - 0.5)), x1 = Math.min(w - 1, Math.floor(x + r + 0.5));
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        if (S.bld[yy * w + xx] === 0 || cand.length >= 96) continue;
        const dx = xx + 0.5 - x, dy = yy + 0.5 - y;
        if (dx * dx + dy * dy <= rr) cand.push(xx + 0.5, yy + 0.5);
      }
    }
    return cand.length >> 1;
  }
  /** nearest map edge to (x,y): 0 west, 1 north, 2 east, 3 south (ties: south, north, west, east) */
  function nearestEdge(x, y) {
    let edge = 3, best = S.h - y;
    if (y < best) { best = y; edge = 1; }
    if (x < best) { best = x; edge = 0; }
    if (S.w - x < best) { best = S.w - x; edge = 2; }
    return edge;
  }

  function apply(id, x, y, r, first, lx, ly, host) {
    if (!first) return false;
    x = num(x, NaN); y = num(y, NaN);
    if (!(x === x) || !(y === y) || !S.tile || !inMap(x, y)) return host.msg('Вне карты', false);
    r = host.rInt(r, 1, 8, 2);
    const m = mod();
    if (S.tick < m.cd) return host.msg('Пусковые устройства перезаряжаются', false);
    const L = list();
    const n = Math.min(N_MAX, N_BASE + r);
    if (L.length + n > LIVE_CAP) return host.msg('Небо уже в огне', false);
    const nc = candidates(x, y, r);
    const spread = SPREAD_K * r, sep = r >= 2 ? 0.9 : 0.6;
    // launch battery: beyond the nearest edge, spread along it
    const edge = nearestEdge(x, y), horiz = edge === 1 || edge === 3;       // horiz: the edge runs left-right
    const along0 = horiz ? x : y, alongMax = horiz ? S.w : S.h, wid = 0.9 + 0.32 * n;
    const ax = [], ay = [], sx = [], sy = [], st = [];
    for (let k = 0; k < n; k++) {
      let px = x, py = y, tries = 0;
      do {
        if (k === 0) { px = x + R.between(-0.25, 0.25); py = y + R.between(-0.25, 0.25); }
        else {
          const a = R.f() * TAU, d = Math.sqrt(R.f()) * spread;
          px = x + Math.cos(a) * d; py = y + Math.sin(a) * d;
          if (nc > 0 && R.f() < BIAS) {                                         // magnet: lean toward the nearest unit / building (if one is close)
            let bj = -1, bd = MAGNET_R * MAGNET_R;
            for (let j = 0; j < nc; j++) { const dx = cand[j * 2] - px, dy = cand[j * 2 + 1] - py, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; bj = j; } }
            if (bj >= 0) { px += (cand[bj * 2] - px) * PULL; py += (cand[bj * 2 + 1] - py) * PULL; }
          }
        }
        px = clamp(px, 0.3, S.w - 0.3); py = clamp(py, 0.3, S.h - 0.3);
        let ok = true;
        for (let j = 0; j < k && ok; j++) { const dx = px - ax[j], dy = py - ay[j]; if (dx * dx + dy * dy < sep * sep) ok = false; }
        if (ok) break;
      } while (++tries < 6);
      ax.push(px); ay.push(py);
      const along = clamp(along0 + R.gauss() * wid, -2, alongMax + 2), out = 1.2 + R.f() * 2.8;
      if (edge === 3) { sx.push(along); sy.push(S.h + out); }
      else if (edge === 1) { sx.push(along); sy.push(-out); }
      else if (edge === 0) { sx.push(-out); sy.push(along); }
      else { sx.push(S.w + out); sy.push(along); }
      st.push(k === 0 ? 0 : R.int(0, STAGGER_MAX));
    }
    let due = 0;
    for (let k = 0; k < n; k++) {
      const dx = ax[k] - sx[k], dy = ay[k] - sy[k], len = Math.sqrt(dx * dx + dy * dy);
      const dur = clamp(Math.round(13 + len * 0.26 + R.between(-1.5, 1.5)), FLIGHT_MIN, FLIGHT_MAX);
      const e = {
        x: r3(sx[k]), y: r3(sy[k]), x0: r3(sx[k]), y0: r3(sy[k]), x1: r3(ax[k]), y1: r3(ay[k]),
        t0: S.tick + st[k], eta: S.tick + st[k] + dur, r: BLAST_R,
        b: r3(R.between(-0.08, 0.08)), h: r3(clamp(len * 0.11, 1, 5.5) * R.between(0.85, 1.15)), v: R.i(65536), l: 0,
      };
      L.push(e);
      if (st[k] === 0) due++;
    }
    m.cd = S.tick + COOLDOWN;
    if (due > 0) launchDue(S.tick);
    Bus.emit('rocketVolley', n, x, y);
    return host.msg('Залп: ' + n + ' ' + Util.plural(n, 'ракета', 'ракеты', 'ракет'), true);
  }

  // ------------------------------------------------------------------ flight
  function launchFx(e) {
    const dx = e.x1 - e.x0, dy = e.y1 - e.y0, len = Math.sqrt(dx * dx + dy * dy) || 1;
    Fx.add('rocket_launch', e.x0, e.y0, { ttl: 0.9, dx: dx / len, dy: dy / len, r: 4, _s: e.v });
  }
  function launchDue(tick) {
    const L = list();
    for (let i = 0; i < L.length; i++) { const e = L[i]; if (e.l !== 1 && tick >= e.t0) { e.l = 1; launchFx(e); } }
  }

  // ------------------------------------------------------------------ impact
  const hit = [];                                  // scratch: creatures inside the blast
  function collectHit(u) { if (hit.length < HIT_CAP) hit.push(u); }
  function unitDamage(d) {
    if (d <= CORE_R) return UNIT_DMG;
    const k = (BLAST_R - d) / (BLAST_R - CORE_R);
    return k <= 0 ? 0 : UNIT_DMG * k * Math.sqrt(k);
  }
  /** survivors are thrown away from the blast (their px / py stay, so the renderer glides them through the air) */
  function shove(u, cx, cy, d) {
    let a;
    if (d < 0.05) a = (u.id % 16) * (TAU / 16);
    else a = Math.atan2(u.y - cy, u.x - cx);
    const k = 0.25 + (1 - d / BLAST_R) * 1.1;
    const nx = u.x + Math.cos(a) * k, ny = u.y + Math.sin(a) * k;
    if (inMap(nx, ny) && World.walkable(nx, ny)) { u.x = nx; u.y = ny; }
    if (u.nextThink > S.tick + 1) u.nextThink = S.tick + 1;
  }
  function rulerLine(u, k) {
    const f = u.sex === Const.SEX.F;
    Log.add(Names.ruler(u.race, u.sex) + ' ' + u.name + ' («' + k.name + '»)' + (f ? ' погибла' : ' погиб') + ' под ракетным ударом', LOG.DEATH, u.x | 0, u.y | 0, k.id);
  }

  /** one rocket hits the ground; tallies go into m.a (the aggregated log line). full = false: the effects are left to the merged burst of this tick.
   *  Returns true when it landed on water. */
  function impact(e, full, m) {
    const cx = clamp(e.x1, 0, S.w - 0.001), cy = clamp(e.y1, 0, S.h - 0.001), tx = Math.floor(cx), ty = Math.floor(cy), w = S.w, h = S.h;
    const water = isWaterT(S.tile[ty * w + tx]);
    let dead = 0, razed = 0;
    // 1) creatures: lethal core, falloff, survivors are shoved and the closest ones catch fire
    hit.length = 0;
    Units.nearby(cx, cy, BLAST_R, collectHit);
    if (hit.length > 1) hit.sort(byId);
    for (let i = 0; i < hit.length; i++) {
      const u = hit[i];
      if (S.units.get(u.id) !== u) continue;
      const d = Util.dist(u.x, u.y, cx, cy), dmg = unitDamage(d);
      if (!(dmg > 0)) continue;
      const ruler = u.isRuler ? S.kingdoms.get(u.kingdomId) : null;
      if (Units.damage(u, dmg, 'rocket') === true) {
        dead++;
        if (ruler) rulerLine(u, ruler);
      } else if (S.units.get(u.id) === u) {
        if (d <= 1.2) u.burning = Math.max(u.burning | 0, S.tick + 20);
        if (d >= 0.3) shove(u, cx, cy, d);
      }
    }
    hit.length = 0;
    // 2) ground: buildings, trees, fire (never touches mountains / snow / lava / water)
    if (!water) {
      const x0 = Math.max(0, tx - 2), x1 = Math.min(w - 1, tx + 2), y0 = Math.max(0, ty - 2), y1 = Math.min(h - 1, ty + 2);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const d = Util.dist(xx + 0.5, yy + 0.5, cx, cy);
          if (d > BLD_R) continue;
          const i = yy * w + xx, t = S.tile[i];
          if (isWaterT(t) || t === T.MOUNTAIN || t === T.SNOW || t === T.LAVA) continue;
          if (S.bld[i] !== 0 && Buildings.damageAt(xx, yy, BLD_DMG * Math.pow(1 - d / 2.0, 0.9), 'rocket') === true) razed++;
          if (d > BLAST_R) continue;
          if (t === T.FOREST) { if (d <= FELL_R) World.harvest(xx, yy, RES.TREE, 999); }
          else if ((S.res[i] === RES.TREE || S.res[i] === RES.BERRY) && d <= TREE_R) { S.res[i] = 0; S.amt[i] = 0; S.markDirty(xx, yy); }
          if (R.f() < IGNITE_P) World.ignite(xx, yy);
        }
      }
    }
    // 3) tally for the log line
    let a = m.a;
    if (!a) a = m.a = { t: S.tick, sx: 0, sy: 0, n: 0, dead: 0, razed: 0 };
    a.sx = r3(a.sx + cx); a.sy = r3(a.sy + cy); a.n++; a.dead += dead; a.razed += razed;
    // 4) show
    if (full) {
      Fx.add('rocket_boom', cx, cy, { ttl: 1.0, w: water ? 1 : 0, m: 1, r: 3, _s: e.v });
      if (Fx.list.length < 320) {
        if (!water) Fx.add('rocket_smoke', cx, cy, { ttl: 2.3, r: 4, _s: e.v + 7 });
        Fx.add('rocket_trail', cx, cy, { ttl: 0.9, r: 14, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1, b: e.b, h: e.h, _s: e.v + 3 });
      }
      if (water) Fx.add('splash', cx, cy, { ttl: 0.7 });
    }
    return water;
  }

  function flush(m, host) {
    const a = m.a;
    m.a = null;
    if (!a || !(a.dead >= 3 || a.razed >= 2) || !(a.n > 0)) return;
    const cx = a.sx / a.n, cy = a.sy / a.n, c = host.nearestCity(cx, cy, 14);
    const parts = [];
    if (a.dead > 0) parts.push('погибло: ' + a.dead);
    if (a.razed > 0) parts.push('разрушено построек: ' + a.razed);
    Log.add('Ракетный залп' + (c ? ' по «' + c.name + '»' : '') + ' (' + parts.join(', ') + ')', LOG.DISASTER, cx | 0, cy | 0, c ? c.kingdomId : 0);
  }

  // ------------------------------------------------------------------ lifecycle
  function step(tick, host) {
    const e0 = S.eff, L = e0 && e0.rockets;
    const m = S.mod.rocket;
    if (!Array.isArray(L) || L.length === 0) { if (m && m.a) flush(m, host); return; }
    let wr = 0, nImp = 0, mx = 0, my = 0, mn = 0, mw = 0, mv = 0;
    const mm = mod();
    for (let k = 0; k < L.length; k++) {
      const e = L[k];
      if (!goodEntry(e)) continue;
      if (tick >= e.eta) {
        nImp++;
        const full = nImp <= FULL_FX;
        const water = impact(e, full, mm);
        if (!full) { mx += e.x1; my += e.y1; mn++; mv = e.v; if (water) mw++; }
        continue;
      }
      if (e.l !== 1 && tick >= e.t0) { e.l = 1; launchFx(e); }
      path(e, tick, pt);
      e.x = r3(pt.x); e.y = r3(pt.y);
      L[wr++] = e;
    }
    L.length = wr;
    if (nImp > 0) {
      if (mn > 0) Fx.add('rocket_boom', mx / mn, my / mn, { ttl: 1.1, w: mw * 2 > mn ? 1 : 0, m: mn, r: 4, _s: mv });     // the merged burst
      Fx.add('shake', 0, 0, { amp: Math.min(6, 2 + nImp), ttl: 0.28 });
    }
    if (mm.a && (L.length === 0 || tick - mm.a.t >= AGG_WINDOW)) flush(mm, host);
  }

  function afterLoad() {
    const L = S.eff && S.eff.rockets;
    if (Array.isArray(L)) {
      let w = 0;
      for (let i = 0; i < L.length; i++) {
        const e = L[i];
        if (!goodEntry(e)) continue;
        if (!(num(e.x, NaN) === e.x)) e.x = e.x0;
        if (!(num(e.y, NaN) === e.y)) e.y = e.y0;
        if (!(e.r > 0)) e.r = BLAST_R;
        if (typeof e.b !== 'number' || e.b !== e.b) e.b = 0;
        if (typeof e.h !== 'number' || !(e.h > 0)) e.h = 1.5;
        if (typeof e.v !== 'number' || e.v !== e.v) e.v = 0;
        if (e.l !== 0 && e.l !== 1) e.l = S.tick >= e.t0 ? 1 : 0;
        L[w++] = e;
      }
      L.length = Math.min(w, LIVE_CAP * 2);
    }
    hit.length = 0; cand.length = 0; cuUnits.length = 0;
  }
  function newWorld() { hit.length = 0; cand.length = 0; cuUnits.length = 0; }

  ToolDefs.groupLabels.arsenal = 'Арсенал';
  ToolDefs.add({ id: 'rocket', tab: 'powers', group: 'arsenal', afterGroup: 'destroy', name: 'Ракеты', short: 'Ракеты', icon: 'rocket', brush: true, drag: false, hint: 'Ракетный залп с края карты (кисть = размер залпа)' });
  const api = {
    name: 'rocket', ids: ['rocket'], apply, step, afterLoad, newWorld,
    // shared with the renderer / tests
    path, nearestEdge,
    params: { N_BASE, N_MAX, COOLDOWN, LIVE_CAP, SPREAD_K, FLIGHT_MIN, FLIGHT_MAX, STAGGER_MAX, BLAST_R, CORE_R, FELL_R, IGNITE_P, FULL_FX, RETICLE_TICKS },
    unitDamage,
  };
  PowerPlugins.push(api);
  return api;
})();
