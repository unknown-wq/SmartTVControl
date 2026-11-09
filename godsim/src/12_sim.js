/* =====================================================================
 * 12_sim.js — Sim: tick orchestrator, per-module cost profile, stats, performance degradation,
 *             world creation + initial population.
 * OWNER: Sim+Save agent. API: docs/CONTRACT.md §3 Sim.  DOM-free (runs headless in node).
 *
 *  - Sim.step()        one tick: S.tick++ -> World -> Buildings -> Units -> Cities -> Kingdoms -> Diplomacy -> War -> Powers.
 *                      Every module call is wrapped in try/catch; a failing module is reported with console.error at most once per
 *                      100 ticks per module (counters stay in Sim.errors) and never stops the loop.
 *  - Sim.profile       {World:ms,...,total:ms} exponential moving average of the cost of each module step (wall clock, ms/tick).
 *  - Sim.stats()       recompute S.stats (auto every 10 ticks inside step).
 *  - Sim.adaptPerf(ms) graceful degradation: S.perf.thinkEvery 3..6, S.perf.lod 0..2, S.perf.unitCap.
 *  - Sim.newWorld / Sim.populate / Sim.afterLoad (see contract).
 *
 * Nothing here influences gameplay randomness except populate()/newWorld(), which only use R (seeded). Wall-clock measurements
 * (profile, adaptPerf) feed S.perf (a performance hint) only — the simulation outcome for a given perf level is deterministic.
 * ===================================================================== */

const Sim = (() => {
  const RACE = Const.RACE, T = Const.T, SEX = Const.SEX;

  // ------------------------------------------------------------------ module table
  const ORDER = ['World', 'Buildings', 'Units', 'Cities', 'Kingdoms', 'Diplomacy', 'War', 'Powers'];
  let modsCache = null;                       // [{name, mod}] — resolved lazily (modules are not available at load time)

  function lookup(name) {
    try {
      switch (name) {
        case 'World': return typeof World !== 'undefined' ? World : null;
        case 'Buildings': return typeof Buildings !== 'undefined' ? Buildings : null;
        case 'Units': return typeof Units !== 'undefined' ? Units : null;
        case 'Cities': return typeof Cities !== 'undefined' ? Cities : null;
        case 'Kingdoms': return typeof Kingdoms !== 'undefined' ? Kingdoms : null;
        case 'Diplomacy': return typeof Diplomacy !== 'undefined' ? Diplomacy : null;
        case 'War': return typeof War !== 'undefined' ? War : null;
        case 'Powers': return typeof Powers !== 'undefined' ? Powers : null;
      }
    } catch (e) { /* TDZ / missing */ }
    return null;
  }
  function mods() {
    if (!modsCache) {
      modsCache = [];
      for (const name of ORDER) {
        const mod = lookup(name);
        if (mod && !mod.__stub) modsCache.push({ name, mod });
      }
    }
    return modsCache;
  }
  /** forget the resolved module list (tests that swap modules) */
  function refresh() { modsCache = null; }

  // ------------------------------------------------------------------ timing
  const now = (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') ? () => performance.now() : () => 0;
  const EMA = 0.03;                           // per tick smoothing of the profile (~33 tick window)

  const profile = { total: 0 };
  for (const n of ORDER) profile[n] = 0;
  let profPrimed = false;
  const errors = {};                          // module name -> total exceptions caught
  const lastLogged = {};                      // module name -> tick of the last console.error
  const lastError = {};                       // module name -> last exception
  let totalErrors = 0;

  function resetProfile() {
    for (const k in profile) profile[k] = 0;
    profPrimed = false;
    for (const k in errors) delete errors[k];
    for (const k in lastLogged) delete lastLogged[k];
    for (const k in lastError) delete lastError[k];
    totalErrors = 0;
  }

  function report(name, where, e) {
    errors[name] = (errors[name] || 0) + 1;
    totalErrors++;
    lastError[name] = e;
    const last = lastLogged[name];
    if (last === undefined || S.tick - last >= 100 || S.tick < last) {
      lastLogged[name] = S.tick;
      if (typeof console !== 'undefined' && console.error) {
        console.error('[Sim] ' + name + '.' + where + ' threw at tick ' + S.tick + ' (' + errors[name] + ' total): ' + (e && e.stack ? e.stack : e));
      }
    }
  }

  // ------------------------------------------------------------------ step
  function step() {
    if (!S.tile) return;
    const tick = ++S.tick;
    const list = mods();
    const t0 = now();
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const a = now();
      try { m.mod.step(tick); } catch (e) { report(m.name, 'step', e); }
      const dt = now() - a;
      profile[m.name] = profPrimed ? profile[m.name] + (dt - profile[m.name]) * EMA : dt;
    }
    if (tick % 10 === 0) {
      try { stats(); } catch (e) { report('Sim', 'stats', e); }
    }
    const tot = now() - t0;
    profile.total = profPrimed ? profile.total + (tot - profile.total) * EMA : tot;
    profPrimed = true;
    S.perf.stepMs = profile.total;
  }

  // ------------------------------------------------------------------ stats
  function stats() {
    const st = S.stats;
    if (!st.pop || st.pop.length !== Const.RACE_COUNT) st.pop = new Array(Const.RACE_COUNT).fill(0);
    const pop = st.pop;
    for (let i = 0; i < pop.length; i++) pop[i] = 0;
    for (const u of S.units.values()) {
      if (u.race >= 0 && u.race < pop.length) pop[u.race]++;
    }
    let total = 0;
    for (let i = 0; i < pop.length; i++) total += pop[i];
    st.popTotal = total;
    st.year = Util.year();
    st.tick = S.tick;
    let k = 0;
    for (const kd of S.kingdoms.values()) if (kd.alive !== false) k++;
    st.kingdoms = k;
    st.cities = S.cities.size;
    let wars = 0;
    for (const w of S.wars.values()) if (!w.ended) wars++;
    st.wars = wars;
    let b = 0, sites = 0;
    for (const bd of S.buildings.values()) { if (bd.done) b++; else sites++; }
    st.buildings = b;
    st.sites = sites;
    st.armies = S.armies.size;
    return st;
  }

  // ------------------------------------------------------------------ performance degradation
  const THINK_MIN = 3, THINK_MAX = 6;
  const STEP_HOT = 2.5, STEP_COOL = 1.2;      // ms per tick (EMA)
  const FRAME_HOT = 24, FRAME_COOL = 15;      // ms of work per frame (EMA)
  const FRAME_CLAMP = 120;                    // ignore single huge hitches (tab switch, GC) beyond this
  const ADAPT_EVERY = 20;                     // adaptPerf calls between pressure decisions (~1/3 s at 60 fps)
  const COOL_NEEDED = 6;                      // consecutive calm decisions before pressure is relaxed (~2 s)
  const P = { frameEma: 0, calls: 0, pressure: 0, calm: 0 };

  function resetPerfState() {
    P.frameEma = 0; P.calls = 0; P.pressure = 0; P.calm = 0;
    const pf = S.perf;
    pf.thinkEvery = THINK_MIN; pf.lod = 0; pf.unitCap = Const.MAX_UNITS;
  }

  /**
   * Called by Main once per rendered frame with the CPU cost of the last frame in ms (sim ticks + render + UI, i.e. the time
   * between the start and the end of the rAF callback — NOT the interval between two frames, which is 33 ms for a healthy
   * game on a 30 Hz low-power display).
   *  thinkEvery: 3 by default, 4 above 900 units, 6 above 1300; +1 per "pressure" step when the measured sim step time or the frame time stays high.
   *  lod:        0 normal, 1 reduced effects, 2 minimal effects (Render/Units hints).
   *  unitCap:    Const.MAX_UNITS; under severe sustained pressure the population is frozen at its current size (no new births).
   */
  function adaptPerf(frameMs) {
    const pf = S.perf;
    P.calls++;
    if (frameMs > 0 && isFinite(frameMs)) {
      const f = frameMs > FRAME_CLAMP ? FRAME_CLAMP : frameMs;
      P.frameEma = P.frameEma > 0 ? P.frameEma + (f - P.frameEma) * 0.08 : f;
    }
    const n = S.units.size;
    if (P.calls % ADAPT_EVERY === 0) {
      const stepMs = pf.stepMs || 0;
      const hot = stepMs > STEP_HOT || P.frameEma > FRAME_HOT;
      const cool = stepMs < STEP_COOL && P.frameEma < FRAME_COOL;
      if (hot) {
        P.calm = 0;
        if (P.pressure < 3) P.pressure++;
      } else if (cool) {
        if (++P.calm >= COOL_NEEDED && P.pressure > 0) { P.pressure--; P.calm = 0; }
      } else {
        P.calm = 0;
      }
    }
    let want = n > 1300 ? 6 : n > 900 ? 4 : THINK_MIN;
    want += P.pressure;
    pf.thinkEvery = want < THINK_MIN ? THINK_MIN : want > THINK_MAX ? THINK_MAX : want;
    let lod = n > 1100 ? 1 : 0;
    if (P.pressure >= 2) lod++;
    if (P.pressure >= 3) lod++;
    pf.lod = lod > 2 ? 2 : lod;
    pf.unitCap = (P.pressure >= 3 && P.frameEma > 40) ? Math.max(600, Math.min(Const.MAX_UNITS, n)) : Const.MAX_UNITS;
    return pf;
  }

  // ------------------------------------------------------------------ lifecycle
  function callLifecycle(name, hook) {
    const mod = lookup(name);
    if (!mod || mod.__stub || typeof mod[hook] !== 'function') return;
    try { mod[hook](); } catch (e) { report(name, hook, e); }
  }

  function newWorld(opts) {
    opts = opts || {};
    const w = (opts.w | 0) > 0 ? opts.w | 0 : Const.DEFAULT_W;
    const h = (opts.h | 0) > 0 ? opts.h | 0 : (opts.w | 0) > 0 ? opts.w | 0 : Const.DEFAULT_H;
    let seed = opts.seed;
    if (seed === undefined || seed === null || seed === '' || !isFinite(+seed)) {
      seed = 1 + Math.floor(Math.random() * 2147483646);     // the ONLY Math.random() use in the sim: picking a fresh seed
    }
    seed = (+seed | 0) || 1;
    refresh();
    resetProfile();
    const world = lookup('World');
    if (world && !world.__stub) world.generate({ seed, w, h });
    else S.reset(w, h, seed);
    resetPerfState();
    for (const name of ORDER) callLifecycle(name, 'newWorld');
    if (opts.populate) {
      try { populate(); } catch (e) { report('Sim', 'populate', e); }
    }
    stats();
    return S;
  }

  /** Rebuild every module's caches after the state in S was replaced by a save. */
  function afterLoad() {
    refresh();
    resetProfile();
    resetPerfState();
    for (const name of ORDER) callLifecycle(name, 'afterLoad');
    stats();
  }

  // ------------------------------------------------------------------ populate
  const GROUPS = [
    // most demanding races are placed first so they get the best spots; humans (flexible) fill what is left
    { race: RACE.ELF, n: 5, count: 2 },
    { race: RACE.ORC, n: 5, count: 2 },
    { race: RACE.HUMAN, n: 6, count: 3 },
  ];
  const WIN = 5;                              // half size of the scored window around a candidate spot
  const MIN_LAND = 90;                        // smallest landmass (tiles) that can hold a group

  /**
   * Habitat score of a candidate village spot for a race (higher is better, -Infinity = unusable).
   * Uses Races.habitat for tile preference + proximity bonuses and demands enough buildable / farmable land around.
   */
  function habitatScore(race, cx, cy) {
    const hab = Races.list[race].habitat;
    const w = S.w, h = S.h, tile = S.tile;
    let cells = 0, land = 0, water = 0, forest = 0, hills = 0, mount = 0, lava = 0, grass = 0, build = 0, sum = 0;
    for (let y = cy - WIN; y <= cy + WIN; y++) {
      for (let x = cx - WIN; x <= cx + WIN; x++) {
        cells++;
        if (x < 0 || y < 0 || x >= w || y >= h) { water++; continue; }
        const t = tile[y * w + x];
        switch (t) {
          case T.DEEP: case T.SHALLOW: water++; continue;
          case T.LAVA: lava++; land++; continue;
          case T.FOREST: forest++; break;
          case T.HILL: hills++; break;
          case T.MOUNTAIN: case T.SNOW: mount++; break;
          case T.GRASS: grass++; break;
        }
        land++;
        if (Tiles.defs[t].build) build++;
        sum += hab[t] || 0;
      }
    }
    if (land < cells * 0.5 || build < 28 || grass + hills < 14) return -Infinity;
    let sc = (sum / cells) * 2.2;
    sc += (hab.nearWater || 0) * Math.min(1, water / 6);
    sc += (hab.nearForest || 0) * Math.min(1, forest / 14);
    sc += (hab.nearMountain || 0) * Math.min(1, (mount + hills * 0.5) / 12);
    sc += (hab.nearLava || 0) * Math.min(1, lava / 3);
    if (race === RACE.ELF) sc += forest >= 12 ? 1.2 : -2.5;                       // forest-rich areas
    if (race === RACE.ORC) sc += (hills + mount) >= 10 ? 1.0 : -2.5;              // hills / mountains close by
    sc += Math.min(0.5, mount / 40) * -1;                                           // too many peaks = cramped
    return sc;
  }

  function hostileRaces(a, b) { return Races.rel[a][b] <= -50 || Races.rel[b][a] <= -50; }

  /**
   * Find a spot for one group. `placed` = [{x,y,race,land}] of everything already settled/seeded.
   * Constraint relaxation: stage 0 = 12 tiles from any group (22 from a hostile race), stage 1 = 9/14, stage 2 = 6/8, stage 3 = 3/3.
   */
  const SEP = [[12, 22], [9, 14], [6, 8], [3, 3]];
  function findGroupSpot(race, placed, sample) {
    const world = lookup('World');
    for (let stage = 0; stage < SEP.length; stage++) {
      const dMin = SEP[stage][0], dHost = SEP[stage][1];
      let best = null, bs = -Infinity;
      const okPlace = (x, y) => {
        const t = S.tile[y * S.w + x];
        if (!Tiles.defs[t].build) return false;
        if (S.res[y * S.w + x] !== 0 || S.bld[y * S.w + x] !== 0) return false;
        for (let i = 0; i < placed.length; i++) {
          const p = placed[i];
          const d = Math.max(Math.abs(p.x - x), Math.abs(p.y - y));
          if (d < dMin) return false;
          if (d < dHost && hostileRaces(race, p.race)) return false;
        }
        return true;
      };
      for (let k = 0; k < sample; k++) {
        const c = world.randomLand(okPlace, 14);
        if (!c) continue;
        const x = c[0], y = c[1];
        const land = world.landId(x, y);
        const size = world.landSize ? world.landSize(x, y) : 1000;
        if (size < MIN_LAND && stage < 3) continue;
        let sc = habitatScore(race, x, y);
        if (sc === -Infinity) continue;
        sc += Math.min(0.8, Math.log(size / MIN_LAND + 1) * 0.35);                 // bigger landmass = more room to grow
        let used = 0;
        for (let i = 0; i < placed.length; i++) if (placed[i].land === land) used++;
        sc -= used * 0.7;                                                          // spread over different landmasses / areas
        sc += R.f() * 0.25;                                                        // variety
        if (sc > bs) { bs = sc; best = { x, y, land, score: sc, dMin, dHost }; }
      }
      if (best) return best;
    }
    return null;
  }

  function pickGroupTile(cx, cy, land, used) {
    for (let a = 0; a < 40; a++) {
      const rr = a < 25 ? 2.4 : 4;
      const x = Math.floor(cx + 0.5 + R.between(-rr, rr)), y = Math.floor(cy + 0.5 + R.between(-rr, rr));
      if (!S.inBounds(x, y)) continue;
      const t = S.tile[y * S.w + x];
      if (!Tiles.isLand(t) || !Tiles.defs[t].speed) continue;
      if (used.has(y * S.w + x) && a < 30) continue;
      if (World.landId(x, y) !== land) continue;
      return [x, y];
    }
    return [cx, cy];
  }

  /**
   * Seed life: humans 3 groups x 6, elves 2 x 5, orcs 2 x 5 (adults of both sexes) on suitable, well separated spots,
   * preferably on different landmasses. Returns {spawned, groups:[{race,x,y,n}]}.
   */
  function populate() {
    const out = { spawned: 0, groups: [] };
    const world = lookup('World');
    if (!S.tile || !world || world.__stub) return out;
    const placed = [];
    for (const c of S.cities.values()) placed.push({ x: c.x, y: c.y, race: c.race, land: world.landId(c.x, c.y) });
    // interleave: round-robin over races (elf, orc, human, elf, orc, human, human) keeps big gaps between same-race groups
    const rounds = [];
    const left = GROUPS.map(g => g.count);
    for (let guard = 0; guard < 20; guard++) {
      let any = false;
      for (let gi = 0; gi < GROUPS.length; gi++) if (left[gi] > 0) { rounds.push(GROUPS[gi]); left[gi]--; any = true; }
      if (!any) break;
    }
    const sample = Math.max(120, Math.min(420, ((S.w * S.h) / 24) | 0));
    for (const g of rounds) {
      const rc = Races.list[g.race];
      let spot = findGroupSpot(g.race, placed, sample);
      if (!spot) continue;
      // snap to the best real village site nearby (same logic the settlers will use)
      try {
        if (typeof Cities !== 'undefined' && !Cities.__stub && Cities.findSite) {
          const s = Cities.findSite(g.race, spot.x, spot.y, 6);
          if (s && world.landId(s.x, s.y) === spot.land) {
            let ok = true;
            for (let i = 0; i < placed.length && ok; i++) {
              const d = Math.max(Math.abs(placed[i].x - s.x), Math.abs(placed[i].y - s.y));
              if (d < spot.dMin || (d < spot.dHost && hostileRaces(g.race, placed[i].race))) ok = false;
            }
            if (ok) spot = { x: s.x, y: s.y, land: spot.land, score: spot.score, dMin: spot.dMin, dHost: spot.dHost };
          }
        }
      } catch (e) { /* keep the raw spot */ }
      // sexes: both present, majority random
      const sexes = [];
      const fem = g.n >> 1, males = g.n - fem;
      const flip = R.chance(0.5);
      for (let i = 0; i < males; i++) sexes.push(flip ? SEX.F : SEX.M);
      for (let i = 0; i < fem; i++) sexes.push(flip ? SEX.M : SEX.F);
      R.shuffle(sexes);
      const lo = Math.max(18, rc.maturity), used = new Set();
      let n = 0;
      for (let i = 0; i < g.n; i++) {
        const tp = pickGroupTile(spot.x, spot.y, spot.land, used);
        used.add(tp[1] * S.w + tp[0]);
        const u = Units.spawn(g.race, tp[0] + 0.5, tp[1] + 0.5, { sex: sexes[i], age: R.between(lo, lo + 12) });
        if (u) n++;
      }
      out.spawned += n;
      out.groups.push({ race: g.race, x: spot.x, y: spot.y, n });
      placed.push({ x: spot.x, y: spot.y, race: g.race, land: spot.land });
    }
    return out;
  }

  return {
    step, stats, adaptPerf, newWorld, populate, afterLoad,
    profile,
    // extras
    refresh,
    get errors() { return errors; },
    get totalErrors() { return totalErrors; },
    get lastError() { return lastError; },
    get perfState() { return P; },
    resetProfile,
  };
})();
