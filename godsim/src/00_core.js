/* =====================================================================
 * 00_core.js — constants, RNG, event bus, log, FX queue, global state S
 * OWNER: architect. Other modules must NOT edit this file (see docs/CONTRACT.md).
 * ===================================================================== */

const Const = (() => {
  const T = { DEEP: 0, SHALLOW: 1, SAND: 2, GRASS: 3, FOREST: 4, HILL: 5, MOUNTAIN: 6, SNOW: 7, LAVA: 8 };
  return {
    TICKS_PER_SEC: 10,
    TICKS_PER_YEAR: 60,      // 1 world year = 6 s at x1
    START_YEAR: 1,
    DEFAULT_W: 96,
    DEFAULT_H: 96,
    TILE_PX: 16,             // native sprite / atlas tile size in pixels
    MAX_UNITS: 1500,
    CITY_MIN_DIST: 10,       // min distance between city centers (tiles)
    T,                       // tile ids
    TILE_COUNT: 9,
    RACE: { HUMAN: 0, ORC: 1, ELF: 2 },
    RACE_COUNT: 3,
    SEX: { M: 0, F: 1 },
    // resource kinds living in S.res (FOREST tiles hold wood implicitly)
    RES: { NONE: 0, TREE: 1, ROCK: 2, IRON: 3, GOLD: 4, BERRY: 5, FISH: 6 /* virtual: land tile next to shallow water */ },
    // building types
    B: { HOUSE: 1, FARM: 2, STORAGE: 3, BARRACKS: 4, TOWNHALL: 5, TEMPLE: 6, MARKET: 7 },
    BUILDING_TYPES: [1, 2, 3, 4, 5, 6, 7],
    GOODS: ['food', 'wood', 'stone', 'iron', 'gold'],
    // diplomacy relation state
    REL: { PEACE: 0, ALLIANCE: 1, WAR: 2 },
    // map render modes
    MODE: { NORMAL: 0, BORDERS: 1 /* political: region owners/controllers, fronts */, CULTURE: 2 },
    // army orders (HOI4-style)
    ORDER: { ATTACK: 'attack', HOLD: 'hold', DEFEND: 'defend', RETREAT: 'retreat' },
    REGION_SPACING: 10,      // target distance between region seeds (tiles) -> ~60-90 tiles per region
    // unit AI states (strings, JSON-safe). UI maps them to Russian labels.
    STATES: ['idle', 'wander', 'walk', 'gather', 'carry', 'build', 'farm', 'eat', 'sleep', 'flee', 'fight', 'army', 'mate', 'settle'],
    // log kinds (feed colors in UI)
    LOG: { INFO: 'info', WAR: 'war', PEACE: 'peace', BIRTH: 'birth', DEATH: 'death', DISASTER: 'disaster', CITY: 'city', KINGDOM: 'kingdom', REBEL: 'rebel', GOD: 'god' },
    SAVE_VERSION: 1,
  };
})();

/* ---------- Seeded RNG (mulberry32). State is saved with the world. ---------- */
const R = (() => {
  let s = 1;
  function next() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    seed(n) { s = (n | 0) || 1; },
    getState() { return s; },
    setState(v) { s = v | 0; },
    f: next,                                         // [0,1)
    i(n) { return (next() * n) | 0; },               // int in [0,n)
    int(a, b) { return a + ((next() * (b - a + 1)) | 0); },   // int in [a,b] inclusive
    between(a, b) { return a + next() * (b - a); },  // float in [a,b)
    chance(p) { return next() < p; },
    pick(arr) { return arr[(next() * arr.length) | 0]; },
    gauss() { return (next() + next() + next() + next() - 2) * 0.8660254; }, // ~N(0,~0.58)... bell-ish in [-1.7,1.7]
    shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = (next() * (i + 1)) | 0; const t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; },
  };
})();

/* ---------- Utilities ---------- */
const Util = (() => {
  return {
    clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
    lerp(a, b, t) { return a + (b - a) * t; },
    dist(x0, y0, x1, y1) { const dx = x1 - x0, dy = y1 - y0; return Math.sqrt(dx * dx + dy * dy); },
    dist2(x0, y0, x1, y1) { const dx = x1 - x0, dy = y1 - y0; return dx * dx + dy * dy; },
    cheb(x0, y0, x1, y1) { return Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); },
    manh(x0, y0, x1, y1) { return Math.abs(x1 - x0) + Math.abs(y1 - y0); },
    /** current world year (integer, starts at Const.START_YEAR) */
    year() { return Const.START_YEAR + Math.floor(S.tick / Const.TICKS_PER_YEAR); },
    /** age in years (float) of anything having `born` (tick). */
    age(e) { return (S.tick - e.born) / Const.TICKS_PER_YEAR; },
    /** deterministic hash of 2 ints -> uint32 (for per-tile visual variants etc.) */
    hash2(x, y, seed) {
      let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return (h ^ (h >>> 16)) >>> 0;
    },
    hsl(h, s, l) { return `hsl(${h | 0},${s | 0}%,${l | 0}%)`; },
    /** 'rgb' array [r,g,b] -> '#rrggbb' */
    hex(rgb) { return '#' + rgb.map(v => (v | 0).toString(16).padStart(2, '0')).join(''); },
    plural(n, one, few, many) {            // Russian plural: 1 год, 2 года, 5 лет
      n = Math.abs(n) % 100; const n1 = n % 10;
      if (n > 10 && n < 20) return many;
      if (n1 > 1 && n1 < 5) return few;
      if (n1 === 1) return one;
      return many;
    },
  };
})();

/* ---------- Event bus (synchronous) ---------- */
const Bus = (() => {
  const m = new Map();
  return {
    on(ev, fn) { let a = m.get(ev); if (!a) { a = []; m.set(ev, a); } a.push(fn); return fn; },
    off(ev, fn) { const a = m.get(ev); if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    emit(ev, a, b, c, d) { const l = m.get(ev); if (!l) return; for (let i = 0; i < l.length; i++) { try { l[i](a, b, c, d); } catch (e) { if (typeof console !== 'undefined') console.error('Bus handler error', ev, e); } } },
    clear() { m.clear(); },
  };
})();

/* ---------- Event feed ("лента событий") ---------- */
const Log = {
  /** Log.add('Королевство «Аран» объявило войну «Дорвену»', Const.LOG.WAR, x, y, kingdomId) */
  add(msg, kind, x, y, kid) {
    const e = { id: S.nextLogId++, tick: S.tick, year: Util.year(), msg, kind: kind || 'info', x: x === undefined ? -1 : x, y: y === undefined ? -1 : y, kid: kid || 0 };
    S.log.push(e);
    if (S.log.length > 300) S.log.splice(0, S.log.length - 300);
    Bus.emit('log', e);
    return e;
  },
};

/* ---------- Entity history helper ("история" in the inspector) ---------- */
const Hist = {
  add(ent, text) {
    if (!ent) return;
    if (!ent.hist) ent.hist = [];
    ent.hist.push({ y: Util.year(), t: text });
    if (ent.hist.length > 24) ent.hist.shift();
  },
};

/* ---------- Visual effect queue (data only; Render draws it, real-time seconds) ---------- */
const Fx = {
  list: [],
  /** types: 'lightning','explosion','fire','smoke','heal','bless','plague','quake','dust','spark','splash','blood','rain_drop','whisper','ash'
   *  opts: {ttl (sec, default 0.8), r (radius tiles), color, dx, dy, n, ...}. x,y in float tile coords. */
  add(type, x, y, opts) {
    if (this.list.length > 400) return null;
    const f = Object.assign({ type, x, y, ttl: 0.8, age: 0 }, opts || {});
    this.list.push(f);
    return f;
  },
  /** advance real-time by dt seconds, drop expired. Called once per rendered frame by Main. */
  update(dt) {
    const l = this.list;
    let w = 0;
    for (let i = 0; i < l.length; i++) { const f = l[i]; f.age += dt; if (f.age < f.ttl) l[w++] = f; }
    l.length = w;
  },
  clear() { this.list.length = 0; },
};

/* ---------- Global mutable game state ---------- */
const S = {
  w: 0, h: 0, seed: 1, tick: 0,
  // ---- terrain layers (length w*h, index = y*w + x) ----
  tile: null,   // Uint8Array  Const.T ids
  elev: null,   // Uint8Array  0..255 height (shading + raise/lower)
  res: null,    // Uint8Array  Const.RES kind on tile (0 none). FOREST tiles are implicitly wood.
  amt: null,    // Uint8Array  remaining amount of the resource (FOREST: wood density 1..255)
  owner: null,  // Int32Array  city id owning the tile (0 none)
  bld: null,    // Int32Array  building id on tile (0 none)
  fire: null,   // Uint8Array  remaining burn ticks (0 none)
  region: null, // Int32Array  region id of every LAND tile (0 = water / unassigned). Owned by Regions.
  // ---- render dirty tracking (see S.markDirty) ----
  dirty: null, dirtyList: [], allDirty: true,
  ownerVer: 0,    // bump when S.owner or city→kingdom/culture mapping changes (border overlay rebuild)
  regionVer: 0,   // bump when region owner/controller/claims/goals change (political overlay rebuild) — use S.touchRegions()
  landDirty: true, // landmass labels need recompute (World)
  // ---- entities (all JSON-safe plain objects; refer to each other by id) ----
  units: new Map(), cities: new Map(), kingdoms: new Map(), buildings: new Map(), armies: new Map(), wars: new Map(),
  rels: new Map(),       // diplomacy: key "a_b" (a<b) -> relation object (Diplomacy owns format)
  cultures: [],          // [{id,name,color:'#rrggbb',race}] (Kingdoms owns)
  nextId: 1, nextLogId: 1,
  log: [],               // event feed entries (see Log.add)
  eff: { meteors: [], tornados: [], rains: [], quakes: [] },   // persistent god-power effects (Powers owns; Render draws)
  mod: {},               // per-module persistent scratch: S.mod.units = {...} (JSON-safe, saved automatically)
  stats: { year: 1, pop: [0, 0, 0], popTotal: 0, kingdoms: 0, cities: 0, wars: 0, buildings: 0 },
  perf: { thinkEvery: 3, lod: 0, unitCap: Const.MAX_UNITS, stepMs: 0 }, // Sim updates; Units must respect

  reset(w, h, seed) {
    this.w = w | 0; this.h = h | 0; this.seed = (seed | 0) || 1; this.tick = 0;
    const n = this.w * this.h;
    this.tile = new Uint8Array(n); this.elev = new Uint8Array(n);
    this.res = new Uint8Array(n); this.amt = new Uint8Array(n);
    this.owner = new Int32Array(n); this.bld = new Int32Array(n); this.fire = new Uint8Array(n);
    this.region = new Int32Array(n); this.regions = new Map(); this.regionVer = 1;
    this.dirty = new Uint8Array(n); this.dirtyList = []; this.allDirty = true; this.ownerVer = 1; this.landDirty = true;
    this.units = new Map(); this.cities = new Map(); this.kingdoms = new Map(); this.buildings = new Map();
    this.armies = new Map(); this.wars = new Map(); this.rels = new Map();
    this.cultures = []; this.nextId = 1; this.nextLogId = 1; this.log = [];
    this.eff = { meteors: [], tornados: [], rains: [], quakes: [] };
    this.mod = {};
    this.stats = { year: Const.START_YEAR, pop: [0, 0, 0], popTotal: 0, kingdoms: 0, cities: 0, wars: 0, buildings: 0 };
    this.perf = { thinkEvery: 3, lod: 0, unitCap: Const.MAX_UNITS, stepMs: 0 };
    Fx.clear();
    R.seed(this.seed);
  },
  /** new unique id (shared counter for units/cities/kingdoms/buildings/armies/wars) */
  id() { return this.nextId++; },
  idx(x, y) { return y * this.w + x; },
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; },
  /** flag a tile for re-baking in the terrain cache. Safe to call anywhere (x,y ints, bounds-checked). */
  markDirty(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    if (!this.dirty[i]) { this.dirty[i] = 1; this.dirtyList.push(i); }
  },
  /** call after changing S.owner / city ownership / culture so the border overlay is rebuilt */
  touchOwner() { this.ownerVer++; },
  /** call after any change of region owner / controller / claims / war goals (also bumps ownerVer) */
  touchRegions() { this.regionVer++; this.ownerVer++; },
};
