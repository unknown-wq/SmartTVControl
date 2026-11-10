/* =====================================================================
 * 18_power_nuke.js — god power «Ядерная бомба» (tool 'nuke', group «Арсенал»). Sim plugin, CONTRACT section 10. DOM-free.
 * OWNER: nuke power agent. Graphics live in 33_gfx_nuke.js; docs in docs/feat_nuke.md; tests in tests/power_nuke.test.mjs.
 *
 * Timeline of one bomb (all in sim ticks, 10 ticks = 1 s at x1)
 *   tap            -> «Тревога»: a bomb record is pushed to S.eff.nukes (reticle + hazard ring + falling bomb are drawn from it); global cooldown
 *   +FALL_TICKS    -> detonation: white flash + shake (Fx), the mushroom-cloud record (S.eff.mushrooms) and the fallout zone (S.eff.fallout) are created
 *   +1 .. +WAVE    -> the blast is resolved as an expanding ring (radius R*(1-(1-k/WAVE)^1.5)): units first, then buildings / terrain / fire of that ring
 *   +WAVE          -> headlines (ONE Log line per bombed city), Cities.destroy for cities whose centre was wiped out, bomb record removed
 *   afterwards     -> mushroom cloud (MUSH_LIFE ticks), fallout zone (FALLOUT_LIFE ticks, decaying): radiation every 10 ticks, no healing inside, vegetation thins
 *
 * Blast scale R = 5 + brush (6..13 tiles). Distance d/R:
 *   < 0.45      everything dies, buildings razed; < 0.15 LAVA (molten glass, cools through the World lava rules), 0.15..0.36 SAND (glassed ground),
 *               0.36..0.45 HILL / SAND rubble rim; trees and berries gone
 *   0.45..0.8   units die with a probability falling off with distance (survivors are badly hurt and burning), buildings destroyed or heavily damaged,
 *               FOREST -> GRASS, fires (the renderer leaves scorch marks)
 *   0.8..1.0    damage, flammables ignite (forests burn on by themselves)
 *   water       stays water (steam / splash Fx only)
 *
 * State (all JSON-safe, saved with the world; the continuation after Save.load is identical):
 *   S.eff.nukes     [{x,y,r,t0,eta,s,w,hit:[{i,n,k,p,b,d,z}]}]   bombs in flight / being resolved (r = R, s = noise seed, w = rings resolved, hit = per-city tally: id, name, kingdom, pop, buildings, dead, razed)
 *   S.eff.mushrooms [{x,y,r,t0,until}]                          cloud records (r = R)
 *   S.eff.fallout   [{x,y,r,R,t0,until}]                        radiation zones (r = 0.7 R)
 *   S.mod.nuke      {cd, n, lr}                                 cooldown (tick until the next bomb may be armed), bombs dropped, last radiation tick
 *   unit fields: u.rad = status until tick («Облучён», pale-green tint), u.radHp = hp after the last dose (no healing while irradiated)
 * Powers.heal clears u.rad (one line in 11_powers.js). All gameplay randomness goes through R; cosmetic Fx placement uses hash noise only.
 * ===================================================================== */

const PowerNuke = (() => {
  const T = Const.T, RES = Const.RES, LOG = Const.LOG, TAU = Math.PI * 2;
  ToolDefs.groupLabels.arsenal = 'Арсенал';
  ToolDefs.add({ id: 'nuke', tab: 'powers', group: 'arsenal', afterGroup: 'destroy', name: 'Ядерная бомба', short: 'Ядерка', icon: 'nuke', brush: true, drag: false,
    hint: 'Ядерный удар: тревога, бомба падает. Радиус взрыва = кисть + 5' });

  // ------------------------------------------------------------------ tunables
  const R_BASE = 5;                 // blast radius = R_BASE + brush (1..8) = 6..13 tiles
  const FALL_TICKS = 25;            // «Тревога»: tap -> detonation
  const WAVE_TICKS = 8;             // the blast is resolved ring by ring over this many ticks
  const COOLDOWN = 120;             // global cooldown (ticks, counted from the tap)
  const BOMB_CAP = 3, MUSH_CAP = 6, FALLOUT_CAP = 6;
  const MUSH_LIFE = 220, FALLOUT_LIFE = 1500;
  const FALLOUT_R = 0.7;            // fallout radius / blast radius
  const Z_LAVA = 0.15, Z_GLASS = 0.36, Z_ANN = 0.45, Z_B = 0.8;     // zone limits (d / R)
  const FX_PER_RING = 7;            // cosmetic Fx budget per wave tick (the Fx list is capped and the renderer draws the newest ones only)
  const DEATH = 'ядерный взрыв', DEATH_RAD = 'радиация';
  const MAX_HIT = 8;                // cities tallied per bomb

  // ------------------------------------------------------------------ helpers
  const buf = [], dbuf = [];                                   // scratch lists (units / doses), reset on every use
  let hostRef = null;
  function fin(v) { return typeof v === 'number' && v === v && v > -1e7 && v < 1e7; }
  function hz(a, b, c) { return Util.hash2(a, b, c) / 4294967296; }
  function report(e, where) { try { if (hostRef && hostRef.report) hostRef.report(e, where); } catch (e2) { /* never throw from a reporter */ } }
  function eff() {
    let e = S.eff;
    if (!e || typeof e !== 'object') e = S.eff = {};
    return e;
  }
  function list(key) {
    const e = eff();
    let a = e[key];
    if (!Array.isArray(a)) a = e[key] = [];
    return a;
  }
  function mod() {
    const m = S.mod.nuke;
    if (m && typeof m === 'object') { if (!fin(m.cd)) m.cd = 0; if (!fin(m.n)) m.n = 0; if (!fin(m.lr)) m.lr = 0; return m; }
    return (S.mod.nuke = { cd: 0, n: 0, lr: 0 });
  }
  /** radius of the shock front after k of WAVE_TICKS ticks: fast at first, slowing down */
  function ringR(rad, k) { if (k <= 0) return 0; if (k >= WAVE_TICKS) return rad; return rad * (1 - Math.pow(1 - k / WAVE_TICKS, 1.5)); }
  function fallIntensity(z, tick) {
    const life = z.until - z.t0;
    if (!(life > 0)) return 0;
    const I = 1 - (tick - z.t0) / life;
    return I < 0 ? 0 : I > 1 ? 1 : I;
  }

  // ------------------------------------------------------------------ arming (tap)
  function arm(x, y, r, host) {
    if (!fin(x) || !fin(y) || !S.tile || x < 0 || y < 0 || x >= S.w || y >= S.h) return host.msg('Вне карты', false);
    const m = mod();
    if (S.tick < m.cd) return host.msg('Бомба ещё не готова', false);
    const L = list('nukes');
    if (L.length >= BOMB_CAP) return host.msg('Бомба ещё не готова', false);
    const R0 = R_BASE + host.rInt(r, 1, 8, 2);
    const b = { x, y, r: R0, t0: S.tick, eta: S.tick + FALL_TICKS, s: Util.hash2(Math.floor(x * 16), Math.floor(y * 16), S.tick) >>> 1, w: 0, hit: [] };
    L.push(b);
    m.cd = S.tick + COOLDOWN;
    m.n++;
    return host.msg('Тревога! Ядерный удар через ' + Math.round(FALL_TICKS / Const.TICKS_PER_SEC * 10) / 10 + ' с', true);
  }

  // ------------------------------------------------------------------ detonation
  function tally(b, cid, kind) {
    if (!(cid > 0)) return;
    const H = b.hit;
    let h = null;
    for (let i = 0; i < H.length; i++) if (H[i].i === cid) { h = H[i]; break; }
    if (!h) {
      const c = S.cities.get(cid);
      if (!c || H.length >= MAX_HIT) return;
      h = { i: cid, n: c.name, k: c.kingdomId | 0, p: c.pop | 0, b: c.buildings.length, d: 0, z: 0 };
      H.push(h);
    }
    if (kind === 0) h.d++; else h.z++;
  }

  function detonate(b, tick) {
    // flashes + shake first: the Fx list is capped, the smoke of a hundred razed houses must not push them out
    Fx.add('flash', b.x, b.y, { ttl: 1.6, a: 1, color: '#ffffff' });
    Fx.add('flash', b.x, b.y, { ttl: 2.4, a: 0.5, color: '#ffa850' });
    Fx.add('shake', b.x, b.y, { ttl: 1.2, amp: 10 });
    const ms = list('mushrooms');
    while (ms.length >= MUSH_CAP) ms.shift();
    ms.push({ x: b.x, y: b.y, r: b.r, t0: tick, until: tick + MUSH_LIFE });
    const fl = list('fallout');
    while (fl.length >= FALLOUT_CAP) fl.shift();
    fl.push({ x: b.x, y: b.y, r: Math.round(b.r * FALLOUT_R * 100) / 100, R: b.r, t0: tick, until: tick + FALLOUT_LIFE });
    // population of the cities near the blast before it kills anybody (for the «destroyed» decision)
    for (const c of S.cities.values()) {
      if (b.hit.length >= MAX_HIT) break;
      if (Util.dist(c.x + 0.5, c.y + 0.5, b.x, b.y) <= b.r + 8) b.hit.push({ i: c.id, n: c.name, k: c.kingdomId | 0, p: c.pop | 0, b: c.buildings.length, d: 0, z: 0 });
    }
  }

  // ---- units of one ring
  function killU(b, u, cid) {
    if (Units.kill(u, DEATH, null) === true) tally(b, cid, 0);
  }
  function hurtU(b, u, mh, frac, burn) {
    const cid = u.cityId | 0;
    if (Units.damage(u, mh * frac, DEATH) === true) { tally(b, cid, 0); return; }
    if (burn > 0 && !(u.burning > S.tick + burn)) u.burning = S.tick + burn;
  }
  function ringUnits(b, r0, r1) {
    const cx = b.x, cy = b.y, BR = b.r, r02 = r0 > 0 ? r0 * r0 : -1, r12 = r1 * r1;
    buf.length = 0;
    for (const u of S.units.values()) {                              // Map order = save order: deterministic, independent of the spatial grid
      const dx = u.x - cx, dy = u.y - cy, d2 = dx * dx + dy * dy;
      if (d2 <= r12 && d2 > r02) buf.push(u);
    }
    for (let i = 0; i < buf.length; i++) {
      const u = buf[i];
      if (S.units.get(u.id) !== u) continue;
      const dx = u.x - cx, dy = u.y - cy, f = Math.sqrt(dx * dx + dy * dy) / BR, cid = u.cityId | 0;
      const mh = u.maxHp > 0 ? u.maxHp : 20;
      if (f < Z_ANN) killU(b, u, cid);
      else if (f < Z_B) {
        const t = (f - Z_ANN) / (Z_B - Z_ANN);                         // 0 inner edge .. 1 outer edge
        if (R.f() < 0.95 - 0.8 * t) killU(b, u, cid);
        else hurtU(b, u, mh, 0.7 - 0.3 * t + 0.1 * R.f(), 60 + R.i(40));
      } else {
        const t = (f - Z_B) / (1 - Z_B);
        hurtU(b, u, mh, (0.5 - 0.35 * t) * (0.7 + 0.6 * R.f()), R.f() < 0.6 - 0.5 * t ? 40 + R.i(30) : 0);
      }
    }
    buf.length = 0;
  }

  // ---- tiles of one ring
  function raze(b, bid) {
    const bd = S.buildings.get(bid);
    if (!bd) return;
    const cid = bd.cityId | 0;
    // a razed town hall is reported by the city headline: cause 'city' keeps Buildings from adding its own «Ратуша города ... разрушена» line
    if (Buildings.destroy(bd, bd.type === Const.B.TOWNHALL ? 'city' : 'nuke') === true) tally(b, cid, 1);
  }
  function hurtB(b, bid, frac) {
    const bd = S.buildings.get(bid);
    if (!bd) return;
    const cid = bd.cityId | 0;
    if (Buildings.damage(bd, (bd.maxHp > 0 ? bd.maxHp : 40) * frac, 0, bd.type === Const.B.TOWNHALL ? 'city' : 'nuke') === true) tally(b, cid, 1);
  }
  function clearTree(i, x, y) {
    const rk = S.res[i];
    if (rk === RES.TREE || rk === RES.BERRY) { S.res[i] = 0; S.amt[i] = 0; S.markDirty(x, y); return true; }
    return false;
  }
  let fxLeft = 0;
  function fx(type, x, y, ttl) { if (fxLeft > 0) { fxLeft--; Fx.add(type, x, y, { ttl }); } }

  function blastTile(b, x, y, i, fe, n) {
    const t = S.tile[i];
    if (t === T.DEEP || t === T.SHALLOW) {                            // water stays water: a little steam / spray only
      if (n < 0.06) fx(n < 0.03 ? 'splash' : 'smoke', x + 0.5, y + 0.5, 0.9);
      return;
    }
    const bid = S.bld[i];
    if (fe < Z_ANN) {                                                 // annihilation: nothing stands
      if (bid) raze(b, bid);
      if (fe < Z_LAVA) {
        if (t !== T.LAVA) World.setTile(x, y, T.LAVA, { elev: 118 + ((n * 10) | 0) });
      } else if (t === T.GRASS || t === T.FOREST || t === T.SAND) {
        if (fe < Z_GLASS) World.setTile(x, y, T.SAND, { elev: 101 + ((n * 8) | 0) });
        else if (n < 0.55) World.setTile(x, y, T.HILL, { elev: 166 + ((n * 28) | 0) });
        else World.setTile(x, y, T.SAND, { elev: 103 + ((n * 6) | 0) });
      } else clearTree(i, x, y);
      return;
    }
    if (fe < Z_B) {                                                   // firestorm: buildings fall, forests burn down to grass
      const tt = (fe - Z_ANN) / (Z_B - Z_ANN);
      if (bid) {
        if (R.f() < 0.85 - 0.55 * tt) raze(b, bid);
        else hurtB(b, bid, 0.6 + 0.25 * R.f());
      }
      clearTree(i, x, y);
      if (t === T.FOREST) World.setTile(x, y, T.GRASS, { elev: S.elev[i] });
      if (!S.fire[i] && R.f() < 0.78 - 0.25 * tt && World.ignite(x, y) && n < 0.3) fx('fire', x + 0.5, y + 0.5, 0.7);
      return;
    }
    const tt = (fe - Z_B) / (1 - Z_B);                                // heat flash: damage, everything flammable ignites
    if (bid) hurtB(b, bid, 0.45 - 0.3 * tt);
    if (S.res[i] === RES.TREE && R.f() < 0.6 - 0.4 * tt) clearTree(i, x, y);
    if (!S.fire[i] && R.f() < (t === T.FOREST ? 0.85 : 0.5) * (1 - 0.4 * tt) && World.ignite(x, y) && n < 0.25) fx('fire', x + 0.5, y + 0.5, 0.7);
  }
  function ringTiles(b, r0, r1) {
    const w = S.w, h = S.h, BR = b.r, cx = b.x, cy = b.y, seed = b.s | 0, r12 = r1 * r1, r02 = r0 > 0 ? r0 * r0 : -1;
    const x0 = Math.max(0, Math.floor(cx - r1 - 1)), x1 = Math.min(w - 1, Math.ceil(cx + r1 + 1));
    const y0 = Math.max(0, Math.floor(cy - r1 - 1)), y1 = Math.min(h - 1, Math.ceil(cy + r1 + 1));
    for (let yy = y0; yy <= y1; yy++) {
      const dy = yy + 0.5 - cy, dy2 = dy * dy;
      if (dy2 > r12) continue;
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx + 0.5 - cx, d2 = dx * dx + dy2;
        if (d2 > r12 || d2 <= r02) continue;
        const n = Util.hash2(xx, yy, seed) / 4294967296;
        blastTile(b, xx, yy, yy * w + xx, Math.sqrt(d2) / BR * (0.92 + 0.16 * n), n);   // noisy zone borders: a ragged crater, not a compass drawing
      }
    }
  }

  function waveRing(b, k, tick) {
    const r0 = ringR(b.r, k - 1), r1 = ringR(b.r, k);
    fxLeft = FX_PER_RING;
    ringUnits(b, r0, r1);                                             // creatures first: lava / razing below must not pre-empt (and hide) the kills
    ringTiles(b, r0, r1);
    // a few embers on the front itself
    for (let q = 0; q < 2; q++) {
      const a = hz(k, q, b.s) * TAU, d = (r0 + (r1 - r0) * hz(q, k, b.s + 3));
      const x = b.x + Math.cos(a) * d, y = b.y + Math.sin(a) * d;
      if (x >= 0 && y >= 0 && x < S.w && y < S.h) fx(q ? 'dust' : 'spark', x, y, 0.8);
    }
  }

  // ---- end of the wave: one headline per bombed city; a city whose core is gone goes through Cities.destroy (capital loss, succession, kingdom fall follow by themselves)
  function finish(b, tick) {
    for (let i = 0; i < b.hit.length; i++) {
      const h = b.hit[i];
      try {
        const c = S.cities.get(h.i);
        if (!c) { if (h.d >= 5 || h.z >= 3) Log.add('Ядерный удар по «' + h.n + '»: погибло ' + h.d + ', разрушено построек: ' + h.z, LOG.DISASTER, b.x | 0, b.y | 0, h.k); continue; }
        const pop = c.pop | 0, left = c.buildings.length;
        const hall = typeof Buildings.count === 'function' ? Buildings.count(c.id, Const.B.TOWNHALL, true) : -1;
        // destroyed: nobody is left, or the town hall fell and most of the people / houses went with it
        const gone = pop <= 0 || (hall === 0 && (pop <= Math.max(2, 0.25 * h.p) || left <= 0.25 * h.b));
        const cx = c.x, cy = c.y, kid = c.kingdomId | 0;
        if (gone) {
          const k = S.kingdoms.get(kid);
          if (k) Hist.add(k, 'Ядерный удар уничтожил город «' + c.name + '»');
          Cities.destroy(c.id, 'nuke');
          Log.add('Ядерный удар: «' + h.n + '» уничтожен, погибло ' + h.d, LOG.DISASTER, cx, cy, kid);
        } else if (h.d >= 5 || h.z >= 3) {
          Log.add('Ядерный удар по «' + h.n + '»: погибло ' + h.d + ', разрушено построек: ' + h.z + (hall === 0 ? ', ратуша уничтожена' : ''), LOG.DISASTER, cx, cy, kid);
        }
      } catch (e) { report(e, 'nuke headline'); }
    }
  }

  function stepBombs(tick) {
    const L = list('nukes');
    let wr = 0;
    for (let i = 0; i < L.length; i++) {
      const b = L[i];
      if (!b || !fin(b.x) || !fin(b.y) || !fin(b.eta) || !(b.r > 0)) continue;
      let keep = true;
      if (tick >= b.eta) {
        try {
          const target = Math.min(WAVE_TICKS, tick - b.eta + 1);
          if (b.w < target) {                                          // one ring per tick (catches up one by one if ticks were ever skipped)
            if (b.w === 0) detonate(b, tick);
            b.w++;
            waveRing(b, b.w, tick);
            if (b.w >= WAVE_TICKS) { finish(b, tick); keep = false; }
          }
        } catch (e) { report(e, 'nuke wave'); if (b.w >= WAVE_TICKS) keep = false; }
      }
      if (keep) L[wr++] = b;
    }
    L.length = wr;
  }

  // ------------------------------------------------------------------ fallout
  const zx = new Float64Array(FALLOUT_CAP + 2), zy = new Float64Array(FALLOUT_CAP + 2), zr = new Float64Array(FALLOUT_CAP + 2), zi = new Float64Array(FALLOUT_CAP + 2);
  function radiate(L, tick) {
    const n = L.length;
    for (let i = 0; i < n; i++) { const z = L[i]; zx[i] = z.x; zy[i] = z.y; zr[i] = z.r > 0 ? z.r : 1; zi[i] = fallIntensity(z, tick); }
    buf.length = 0; dbuf.length = 0;
    for (const u of S.units.values()) {
      let best = 0;
      for (let i = 0; i < n; i++) {
        const dx = u.x - zx[i], dy = u.y - zy[i], r = zr[i], d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        const dose = zi[i] * (1 - 0.65 * Math.sqrt(d2) / r);
        if (dose > best) best = dose;
      }
      if (best > 0.015) { buf.push(u); dbuf.push(best); }
    }
    for (let j = 0; j < buf.length; j++) {
      const u = buf[j], dose = dbuf[j];
      if (S.units.get(u.id) !== u) continue;
      if (u.rad > tick && u.radHp > 0 && u.hp > u.radHp) u.hp = u.radHp;      // no healing while irradiated (natural regeneration is taken back)
      u.rad = tick + 30;
      const mh = u.maxHp > 0 ? u.maxHp : 20;
      if (Units.damage(u, mh * (0.004 + 0.07 * dose * dose), DEATH_RAD) !== true) u.radHp = u.hp;
    }
    buf.length = 0; dbuf.length = 0;
  }
  function wither(L, tick) {
    const w = S.w;
    for (let k = 0; k < L.length; k++) {
      const z = L[k];
      if (fallIntensity(z, tick) < 0.2) continue;
      for (let q = 0; q < 4; q++) {
        const a = R.f() * TAU, d = Math.sqrt(R.f()) * z.r;
        const x = Math.floor(z.x + Math.cos(a) * d), y = Math.floor(z.y + Math.sin(a) * d);
        if (x < 0 || y < 0 || x >= w || y >= S.h) continue;
        const i = y * w + x;
        if (S.tile[i] === T.FOREST && !S.fire[i]) World.setTile(x, y, T.GRASS, { elev: S.elev[i] });
      }
    }
  }
  function stepFallout(tick) {
    const L = list('fallout');
    if (L.length === 0) return;
    let wr = 0;
    for (let i = 0; i < L.length; i++) { const z = L[i]; if (z && fin(z.x) && fin(z.y) && z.until > tick) L[wr++] = z; }
    L.length = wr;
    if (wr === 0) return;
    const m = mod();
    if (tick % 10 === 0 && tick > m.lr) { m.lr = tick; radiate(L, tick); }
    if (tick % 100 === 50) wither(L, tick);
  }
  function stepMushrooms(tick) {
    const L = list('mushrooms');
    if (L.length === 0) return;
    let wr = 0;
    for (let i = 0; i < L.length; i++) { const z = L[i]; if (z && fin(z.x) && fin(z.y) && z.until > tick) L[wr++] = z; }
    L.length = wr;
  }

  // ------------------------------------------------------------------ lifecycle
  function clean() {
    const okRec = (e, keys) => { if (!e || typeof e !== 'object' || !fin(e.x) || !fin(e.y)) return false; for (let i = 0; i < keys.length; i++) if (!fin(e[keys[i]])) return false; return true; };
    const e = eff();
    e.nukes = list('nukes').filter(b => okRec(b, ['r', 't0', 'eta'])).map(b => {
      if (!Array.isArray(b.hit)) b.hit = [];
      b.w = fin(b.w) && b.w > 0 ? b.w | 0 : 0;
      if (typeof b.s !== 'number' || b.s !== b.s || Math.abs(b.s) > 4294967296) b.s = 1;       // noise seed: any int (not limited like coordinates)
      return b;
    });
    e.mushrooms = list('mushrooms').filter(z => okRec(z, ['r', 't0', 'until']));
    e.fallout = list('fallout').filter(z => okRec(z, ['r', 't0', 'until'])).map(z => { if (!fin(z.R)) z.R = Math.round(z.r / FALLOUT_R * 100) / 100; return z; });
    mod();
  }
  const api = {
    name: 'nuke',
    ids: ['nuke'],
    apply(id, x, y, r, first, lx, ly, host) {
      hostRef = host || hostRef;
      if (id !== 'nuke') return false;
      return arm(x, y, r, host);
    },
    step(tick, host) {
      hostRef = host || hostRef;
      if (tick === undefined) tick = S.tick;
      const e = S.eff;
      if (!e) return;
      if (e.nukes && e.nukes.length) stepBombs(tick);
      if (e.mushrooms && e.mushrooms.length) stepMushrooms(tick);
      if (e.fallout && e.fallout.length) stepFallout(tick);
    },
    newWorld() { S.mod.nuke = { cd: 0, n: 0, lr: 0 }; list('nukes'); list('mushrooms'); list('fallout'); },
    afterLoad() { clean(); },
    // constants / helpers for tests and the graphics plugin (which keeps its own copies of the timing constants)
    consts: { R_BASE, FALL_TICKS, WAVE_TICKS, COOLDOWN, BOMB_CAP, MUSH_CAP, FALLOUT_CAP, MUSH_LIFE, FALLOUT_LIFE, FALLOUT_R, Z_LAVA, Z_GLASS, Z_ANN, Z_B, DEATH, DEATH_RAD },
    ringR,
  };
  PowerPlugins.push(api);
  return api;
})();
