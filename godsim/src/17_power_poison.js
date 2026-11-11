/* =====================================================================
 * 17_power_poison.js — god power «Яд»: drifting toxic clouds (CONTRACT section 10 sim plugin). DOM-free.
 *
 *  Tool: id 'poison', Силы / Разрушение, brush radius 1..8 = cloud size, drag = spray a trail of smaller clouds.
 *
 *  State (all JSON-safe, saved with the world)
 *   S.eff.clouds  [{id, x, y, r, r0, dens, d0, t0, until, dx, dy, nt, k}]   <= CFG.cap live clouds
 *        r / dens are the CURRENT radius (tiles) and density (0..1.6), derived every tick from r0 / d0 and the age: the cloud
 *        spreads (radius grows by CFG.grow = 40 % over its life) and thins out ((1-p)^0.75) until it vanishes. dx,dy = wind
 *        (tiles per tick, re-rolled rarely, bounces at the map edge), nt = next wind change, k = victims (for the chronicle).
 *   S.mod.poison  {nid, vic}                                                 id counter / total victims
 *   u.poison      tick until which the unit is poisoned (every unit carries the field, 0 = healthy, so Save keeps one table shape)
 *
 *  Rules (every number lives in CFG)
 *   - Every CFG.scan (5) ticks a unit inside a cloud (local density = dens * (1 - 0.5 d^2/r^2) >= 0.1) gets
 *     u.poison = tick + CFG.tail (120). Poison is NOT contagious. Powers.heal clears it (one line in 11_powers.js).
 *   - Every CFG.dot (8) ticks every poisoned unit takes (tailDmg * taper + inDmg * densityHere) * vulnerability damage ('poison'),
 *     taper = remaining/tail (the lingering poison fades). Children x1.35, elders x1.25, sickly x1.2, strong x0.85.
 *   - Units try to leave: a unit in a cloud (not a soldier, not settling / giving birth / fighting) switches to state 'flee' with a
 *     target outside every cloud (Units' own flee code walks it), and civilians that are about to walk INTO a cloud (destination
 *     inside, unit within CFG.ring tiles of it) are sent back to idle for a while. Soldiers (u.armyId) keep their orders.
 *   - Ecology (every 10 ticks per cloud): forest tiles lose wood (World.harvest: dead forest -> grass), lone trees and berry bushes
 *     wither, farms lose hp (Buildings.damage 'poison': a field under a dense cloud for its whole life is destroyed).
 *   - Rain over a cloud washes it out (it ages 3x faster).
 *   - Chronicle: a ruler killed by poison and a cloud that killed >= 4 people get one Log line each (never one per victim).
 *
 *  Cost: no cloud and nobody poisoned = one pass over S.units every 8 ticks (field check) ~ 5 us/tick.
 *  Randomness only through R, only when something happens (wind, bush kill), so worlds without poison keep their RNG stream.
 * ===================================================================== */

const PowerPoison = (() => {
  const T = Const.T, RES = Const.RES, LOG = Const.LOG, TAU = Math.PI * 2;

  ToolDefs.add({ id: 'poison', tab: 'powers', group: 'destroy', name: 'Яд', short: 'Яд', icon: 'poison', brush: true, drag: true,
                 hint: 'Ядовитое облако: тап или шлейф' });

  // ------------------------------------------------------------------ tunables
  const CFG = {
    cap: 14,                 // live clouds
    tapLife: 600, sprayLife: 420,
    tapDens: 1.0, sprayDens: 0.6, densMax: 1.6,
    grow: 0.4,               // radius grows by up to 40 % while the cloud ages
    maxR: 10,                // cap of the initial radius (also after merges)
    scan: 5,                 // ticks between exposure / avoidance passes
    dot: 8,                  // ticks between damage passes
    tail: 120,               // poison lasts this long after the last exposure
    tailDmg: 0.7, inDmg: 1.3,
    minDens: 0.1,            // local density below which a cloud does nothing
    ring: 4.5,               // tiles around a cloud inside which civilians refuse to walk into it
    fleeBudget: 64,          // units that start running per scan (a bigger crowd panics over a few scans, lowest ids first)
    eco: 10,                 // ticks between ecology passes per cloud
    farmDmg: 0.9,            // farm hp per ecology pass at density 1 (a field under a dense cloud for its whole life is destroyed)
    wash: 2,                 // extra ticks of ageing per tick under rain
  };

  // ------------------------------------------------------------------ state helpers
  function clouds() { const e = S.eff; if (!Array.isArray(e.clouds)) e.clouds = []; return e.clouds; }
  function mod() {
    let m = S.mod.poison;
    if (!m || typeof m !== 'object') m = S.mod.poison = { nid: 1, vic: 0 };
    if (!(m.nid >= 1)) m.nid = 1;
    if (!(m.vic >= 0)) m.vic = 0;
    return m;
  }
  const fin = (v) => typeof v === 'number' && v === v && v > -1e7 && v < 1e7;

  /** current density of a cloud (0 once it is over) */
  function densOf(c, tick) {
    const span = c.until - c.t0;
    if (!(span > 0)) return 0;
    const p = (tick - c.t0) / span;
    if (p >= 1) return 0;
    return c.d0 * Math.pow(1 - (p < 0 ? 0 : p), 0.75);
  }
  /** summed local density of every cloud at a point (0 outside) */
  function localDens(x, y) {
    const L = S.eff && S.eff.clouds;
    if (!L) return 0;
    let d = 0;
    for (let k = 0; k < L.length; k++) {
      const c = L[k], dx = x - c.x, dy = y - c.y, r2 = c.r * c.r, d2 = dx * dx + dy * dy;
      if (d2 <= r2) d += c.dens * (1 - 0.5 * d2 / r2);
    }
    return d;
  }
  function nearestCloud(x, y, extra) {
    const L = S.eff && S.eff.clouds;
    if (!L) return null;
    let best = null, bd = 1e9;
    for (let k = 0; k < L.length; k++) {
      const c = L[k], dx = x - c.x, dy = y - c.y, d = Math.sqrt(dx * dx + dy * dy) - c.r;
      if (d < bd && d <= extra) { bd = d; best = c; }
    }
    return best;
  }

  // ------------------------------------------------------------------ creating / merging clouds
  function windOf(c, speed) {
    const a = R.f() * TAU;
    c.dx = Math.cos(a) * speed; c.dy = Math.sin(a) * speed;
    c.nt = S.tick + 150 + R.i(150);
  }
  /** a cloud at (x,y): merges (sums the density) into a cloud that is nearly in the same place, otherwise creates one (the weakest is dropped at the cap) */
  function addCloud(x, y, r, dens, life, mergeFrac) {
    const L = clouds(), tick = S.tick, m = mod();
    r = Math.max(0.8, Math.min(CFG.maxR, r));
    let hit = null, hd = 1e9;
    for (let k = 0; k < L.length; k++) {
      const c = L[k], d = Math.sqrt((c.x - x) * (c.x - x) + (c.y - y) * (c.y - y));
      if (d < mergeFrac * Math.max(c.r, r) && d < hd) { hd = d; hit = c; }
    }
    if (hit) {
      const cd = densOf(hit, tick), nd = Math.min(CFG.densMax, cd + dens), w = dens / (cd + dens + 1e-6);
      hit.x += (x - hit.x) * w * 0.5; hit.y += (y - hit.y) * w * 0.5;      // the heavier input pulls the centre a little
      hit.r0 = Math.min(CFG.maxR, Math.max(hit.r, r));
      hit.r = hit.r0;
      hit.d0 = nd; hit.dens = nd;
      hit.t0 = tick;
      if (hit.until < tick + life) hit.until = tick + life;
      return hit;
    }
    if (L.length >= CFG.cap) {                        // drop the cloud that would end first
      let oi = 0;
      for (let k = 1; k < L.length; k++) if (L[k].until < L[oi].until) oi = k;
      L.splice(oi, 1);
    }
    const c = { id: m.nid++, x, y, r, r0: r, dens, d0: dens, t0: tick, until: tick + life, dx: 0, dy: 0, nt: tick + 200, k: 0 };
    windOf(c, R.between(0.003, 0.010));
    L.push(c);
    return c;
  }

  // ------------------------------------------------------------------ units: exposure, flight, avoidance
  let vc = null, vTick = 0;                           // scratch of the current cloud / tick for the nearby() callback (no closures per call)
  const OFFS = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9, 3.1416];

  function okSpot(u, x, y) {
    if (!(x >= 0.5 && y >= 0.5 && x < S.w - 0.5 && y < S.h - 0.5)) return false;
    const i = (y | 0) * S.w + (x | 0);
    if (!Tiles.isLand(S.tile[i]) || S.fire[i] > 0) return false;
    if (!World.walkable(x, y) || !World.sameLand(u.x, u.y, x, y)) return false;
    return localDens(x, y) < CFG.minDens * 0.5;
  }
  /** civilian in a cloud: run to a spot outside every cloud (Units' flee state walks it there) */
  function startFlee(u, cx, cy, cr) {
    const ax = u.x - cx, ay = u.y - cy, d = Math.sqrt(ax * ax + ay * ay);
    const base = d < 0.05 ? (u.id * 2.399963229728653) % TAU : Math.atan2(ay, ax);
    const need = Math.max(0, cr - d) + 3.5 + (u.id % 3) * 0.7;
    for (let k = 0; k < OFFS.length; k++) {
      const a = base + OFFS[k], ca = Math.cos(a), sa = Math.sin(a);
      for (let f = 1; f > 0.5; f -= 0.225) {
        const tx = u.x + ca * need * f, ty = u.y + sa * need * f;
        if (!okSpot(u, tx, ty)) continue;
        u.job = null;
        u.state = 'flee';
        u.st = { ph: 'go', since: vTick, tx, ty, rg: 0.8, then: '', rest: 0, until: vTick + 70 + Math.round(need * f * 6), pz: 1 };
        u.nextThink = vTick + 3;
        return true;
      }
    }
    return false;
  }
  const fleeU = [], fleeC = [];                        // units that want to run this pass (+ the cloud they stand in); reused, not reallocated
  function poisonUnit(u) {
    const until = vTick + CFG.tail;
    if (!(u.poison >= until)) u.poison = until;
    if (u.armyId) return;                              // soldiers keep their orders
    const s = u.state;
    if (s === 'flee' || s === 'settle' || s === 'mate' || s === 'fight') return;
    fleeU.push(u); fleeC.push(vc);                     // decided after the scan, in id order and within a budget (a crowd panics over a few scans)
  }
  function runFlee() {
    const n = fleeU.length;
    if (n === 0) return;
    if (n <= CFG.fleeBudget) {
      for (let i = 0; i < n; i++) { const u = fleeU[i]; if (u.state !== 'flee') startFlee(u, fleeC[i].x, fleeC[i].y, fleeC[i].r); }
    } else {                                           // a mass panic: the lowest ids go first (independent of the grid order, so a load continues identically)
      const idx = [];
      for (let i = 0; i < n; i++) idx.push(i);
      idx.sort((a, b) => fleeU[a].id - fleeU[b].id || a - b);
      for (let k = 0, done = 0; k < n && done < CFG.fleeBudget; k++) {
        const i = idx[k], u = fleeU[i];
        if (u.state === 'flee') continue;
        startFlee(u, fleeC[i].x, fleeC[i].y, fleeC[i].r); done++;
      }
    }
    fleeU.length = 0; fleeC.length = 0;
  }
  /** a civilian walking toward a spot inside the current cloud (vc) turns back: it waits a while instead (the next job roll usually picks another place) */
  function avoid(u) {
    const s = u.state;
    if (s !== 'walk' && s !== 'wander' && s !== 'gather' && s !== 'carry' && s !== 'farm' && s !== 'build') return;
    const st = u.st;
    if (!st || u.armyId || !fin(st.tx) || !fin(st.ty) || st.then === 'sleep' || u.hunger > 85) return;
    const ex = st.tx - vc.x, ey = st.ty - vc.y, e2 = ex * ex + ey * ey, r2 = vc.r * vc.r;
    if (e2 > r2 || vc.dens * (1 - 0.5 * e2 / r2) < CFG.minDens) return;
    u.job = null;
    u.state = 'idle';
    u.st = { ph: '', since: vTick, until: vTick + 50 + (u.id % 40) };
    u.nextThink = vTick + 2;
  }
  function visit(u) {                                   // Units.nearby callback for the current cloud (vc)
    const dx = u.x - vc.x, dy = u.y - vc.y, d2 = dx * dx + dy * dy, r2 = vc.r * vc.r;
    if (d2 <= r2 && vc.dens * (1 - 0.5 * d2 / r2) >= CFG.minDens) poisonUnit(u);
    else avoid(u);
  }
  function exposePass(tick) {
    const L = S.eff.clouds;
    vTick = tick;
    for (let k = 0; k < L.length; k++) {
      vc = L[k];
      if (!(vc.dens >= 0.05)) continue;
      Units.nearby(vc.x, vc.y, vc.r + CFG.ring, visit);
    }
    vc = null;
    runFlee();
  }

  function vulnerability(u) {
    let m = 1;
    const st = Units.stage(u);
    if (st === 'child') m = 1.15; else if (st === 'elder') m = 1.2;
    if (Traits.mul(u, 'sick') > 1) m *= 1.2;
    if (Traits.has(u, 'strong')) m *= 0.85;
    return m;
  }
  /** damage over time of every poisoned unit; also gives units that were born without the field their `poison = 0` */
  function dotPass(tick) {
    for (const u of S.units.values()) {
      const pu = u.poison;
      if (pu === undefined) { u.poison = 0; continue; }
      if (!(pu > tick)) continue;
      const rem = pu - tick, taper = rem >= CFG.tail ? 1 : rem / CFG.tail;
      const dmg = (CFG.tailDmg * taper + CFG.inDmg * localDens(u.x, u.y)) * vulnerability(u);
      if (dmg > 0.02) Units.damage(u, dmg, 'poison');
    }
  }

  // ------------------------------------------------------------------ ecology
  function ecology(c, tick) {
    const w = S.w, h = S.h, r = c.r, r2 = r * r, B = Const.B;
    const x0 = Math.max(0, Math.floor(c.x - r)), x1 = Math.min(w - 1, Math.floor(c.x + r));
    const y0 = Math.max(0, Math.floor(c.y - r)), y1 = Math.min(h - 1, Math.floor(c.y + r));
    let fxLeft = 2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x, t = S.tile[i], rk = S.res[i], bid = S.bld[i];
        if (t !== T.FOREST && rk === 0 && bid === 0) continue;
        const dx = x + 0.5 - c.x, dy = y + 0.5 - c.y, d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const dl = c.dens * (1 - 0.5 * d2 / r2);
        if (dl < 0.12) continue;
        const take = 1 + Math.round(dl * 2);            // wood lost per pass: 1 (faint) .. 3 (dense); lone trees x2, berries x3
        if (t === T.FOREST) {
          World.harvest(x, y, RES.TREE, take);            // thins the wood; at 0 the tile turns into grass (World.harvest)
          if (S.tile[i] !== T.FOREST && fxLeft > 0 && Fx.list.length < 100) { fxLeft--; Fx.add('dust', x + 0.5, y + 0.5, { ttl: 0.8, color: '#7a8a30' }); }
        } else if (rk === RES.TREE) {
          World.harvest(x, y, RES.TREE, take * 2);
        } else if (rk === RES.BERRY) {
          if (S.amt[i] > 0) World.harvest(x, y, RES.BERRY, take * 3);
          else if (dl > 0.45 && R.chance(0.2)) { S.res[i] = 0; S.amt[i] = 0; S.markDirty(x, y); }       // a dead bush
        }
        if (bid !== 0) {
          const b = Buildings.get(bid);
          if (b && b.type === B.FARM && b.done) Buildings.damage(b, CFG.farmDmg * dl, 0, 'poison');
        }
      }
    }
  }

  // ------------------------------------------------------------------ chronicle (victims)
  let soulAt = -9;
  Bus.on('unitDied', (u, cause) => {
    if (cause !== 'poison' || !u) return;
    const m = mod();
    m.vic++;
    const c = nearestCloud(u.x, u.y, 6);
    if (c) c.k++;
    if (S.tick - soulAt >= 2 && Fx.list.length < 120) { soulAt = S.tick; Fx.add('poison_soul', u.x, u.y, { ttl: 1.7 }); }
    if (u.isRuler) {
      const k = S.kingdoms.get(u.kingdomId), f = u.sex === Const.SEX.F;
      Log.add(Names.ruler(u.race, u.sex) + ' ' + u.name + (k ? ' («' + k.name + '»)' : '') + (f ? ' отравлена' : ' отравлен') + ' ядовитым облаком', LOG.DISASTER, u.x | 0, u.y | 0, u.kingdomId | 0);
    }
  });
  Bus.on('unitBorn', (u) => { if (u && u.poison === undefined) u.poison = 0; });     // one object shape for every unit (a ragged save table loads slowly)

  function endOfCloud(c, host) {
    if (!(c.k >= 4)) return;
    const city = host && host.nearestCity ? host.nearestCity(c.x, c.y, c.r + 12) : null;
    Log.add('Ядовитое облако' + (city ? ' у «' + city.name + '»' : '') + ' рассеялось: погибло ' + c.k, LOG.DISASTER, c.x | 0, c.y | 0, city ? city.kingdomId : 0);
  }

  // ------------------------------------------------------------------ per tick
  function advance(c, tick) {
    const span = c.until - c.t0;
    const p = span > 0 ? (tick - c.t0) / span : 1;
    if (p >= 1) return false;
    const q = p < 0 ? 0 : p;
    c.dens = c.d0 * Math.pow(1 - q, 0.75);
    c.r = c.r0 * (1 + CFG.grow * q);
    if (c.dens < 0.04) return false;
    if (tick >= c.nt) {                               // the wind turns a little
      const sp = Util.clamp(Math.sqrt(c.dx * c.dx + c.dy * c.dy) * R.between(0.8, 1.25), 0.002, 0.012);
      const a = Math.atan2(c.dy, c.dx) + R.gauss() * 0.9;
      c.dx = Math.cos(a) * sp; c.dy = Math.sin(a) * sp;
      c.nt = tick + 150 + R.i(150);
    }
    let nx = c.x + c.dx, ny = c.y + c.dy;
    if (nx < 1) { c.dx = Math.abs(c.dx); nx = 1; } else if (nx > S.w - 1) { c.dx = -Math.abs(c.dx); nx = S.w - 1; }
    if (ny < 1) { c.dy = Math.abs(c.dy); ny = 1; } else if (ny > S.h - 1) { c.dy = -Math.abs(c.dy); ny = S.h - 1; }
    c.x = nx; c.y = ny;
    const rn = S.eff.rains;
    if (rn && rn.length) {                            // rain washes the poison out of the air
      for (let k = 0; k < rn.length; k++) {
        const e = rn[k];
        if (e.until > tick && Math.abs(e.x - c.x) < e.r + c.r * 0.5 && Math.abs(e.y - c.y) < e.r + c.r * 0.5) { c.until -= CFG.wash; break; }
      }
    }
    return true;
  }

  function step(tick, host) {
    const L = S.eff.clouds;
    if (L && L.length) {
      let wr = 0;
      for (let k = 0; k < L.length; k++) {
        const c = L[k];
        if (advance(c, tick)) L[wr++] = c; else endOfCloud(c, host);
      }
      L.length = wr;
      if (wr) {
        if (tick % CFG.scan === 0) exposePass(tick);
        for (let k = 0; k < wr; k++) if ((tick + L[k].id) % CFG.eco === 0) ecology(L[k], tick);
      }
    }
    if (tick % CFG.dot === 0 && S.units.size) dotPass(tick);
  }

  // ------------------------------------------------------------------ the tool
  function apply(id, x, y, r, first, lx, ly, host) {
    if (!(x >= 0 && y >= 0 && x < S.w && y < S.h)) return host.msg('Вне карты', false);
    r = host.rInt(r, 1, 8, 2);
    if (first) {                                       // a tap (or the start of a stroke): one proper cloud
      const rad = r + 1;
      addCloud(x, y, rad, CFG.tapDens, CFG.tapLife, 0.5);
      host.fx('poison_burst', x, y, { ttl: 1.1, r: rad });
      return host.msg('Ядовитое облако', true);
    }
    // spraying: a small puff whenever the finger has left the last one behind (the nearest cloud), thicker when it lingers
    const rs = 0.55 * r + 0.5, L = clouds();
    let near = null, nd = 1e9;
    for (let k = 0; k < L.length; k++) { const c = L[k], d = Math.sqrt((c.x - x) * (c.x - x) + (c.y - y) * (c.y - y)); if (d < nd) { nd = d; near = c; } }
    const spacing = rs * (L.length >= CFG.cap - 3 ? 1.6 : 1.1);
    if (near && nd < spacing) {
      if (nd < 0.45 * rs) {                           // the finger stays: the puff under it gets denser
        near.d0 = Math.min(CFG.densMax, near.d0 + 0.03); near.dens = Math.min(CFG.densMax, near.dens + 0.03);
        if (near.until < S.tick + 60) near.until = S.tick + 60;
      }
      return host.msg('', false);                     // nothing new (not an error: no toast)
    }
    addCloud(x, y, rs, CFG.sprayDens, CFG.sprayLife, 0.4);
    host.fx('poison_burst', x, y, { ttl: 0.7, r: rs });
    return host.msg('Ядовитое облако', true);
  }

  // ------------------------------------------------------------------ lifecycle
  function sanitize() {
    const e = S.eff, m = mod();
    const L = Array.isArray(e.clouds) ? e.clouds : [];
    const out = [];
    for (let k = 0; k < L.length; k++) {
      const c = L[k];
      if (!c || typeof c !== 'object' || !fin(c.x) || !fin(c.y) || !fin(c.until) || !fin(c.t0)) continue;
      if (!(c.r0 > 0)) c.r0 = fin(c.r) && c.r > 0 ? c.r : 2;
      if (!(c.d0 > 0)) c.d0 = fin(c.dens) && c.dens > 0 ? c.dens : 1;
      if (!fin(c.dx)) c.dx = 0;
      if (!fin(c.dy)) c.dy = 0;
      if (!fin(c.nt)) c.nt = c.t0 + 200;
      if (!(c.k >= 0)) c.k = 0;
      if (!(c.id >= 1)) c.id = m.nid++;
      c.r0 = Math.min(CFG.maxR, c.r0);
      c.d0 = Math.min(CFG.densMax, c.d0);
      if (!(c.dens >= 0)) c.dens = densOf(c, S.tick);             // stored values are kept (a load must continue bit-identically)
      if (!(c.r > 0)) c.r = c.r0 * (1 + CFG.grow * Math.min(1, Math.max(0, (S.tick - c.t0) / Math.max(1, c.until - c.t0))));
      out.push(c);
    }
    while (out.length > CFG.cap) out.shift();
    for (let k = 0; k < out.length; k++) if (out[k].id >= m.nid) m.nid = out[k].id + 1;
    e.clouds = out;
    for (const u of S.units.values()) if (u.poison === undefined) u.poison = 0;
  }

  const api = {
    name: 'poison', ids: ['poison'], cfg: CFG,
    apply, step,
    newWorld() { mod(); clouds(); },
    afterLoad() { sanitize(); },
    // helpers for tests / graphics
    addCloud: (x, y, r, dens, life) => addCloud(x, y, r, dens === undefined ? CFG.tapDens : dens, life || CFG.tapLife, 0.5),
    densityAt: localDens, densOf,
    count() { const L = S.eff && S.eff.clouds; return L ? L.length : 0; },
  };
  PowerPlugins.push(api);
  return api;
})();
