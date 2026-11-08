/* =====================================================================
 * 01_tiles.js — static tile definitions (data + tiny helpers)
 * OWNER: architect. Read-only for other modules.
 * ===================================================================== */

const Tiles = (() => {
  const T = Const.T;
  const defs = [];
  function def(id, key, name, o) { defs[id] = Object.assign({ id, key, name }, o); }

  // elev: [lo, hi) height band used when terrain is derived from S.elev; mid = representative height
  // speed: walking speed multiplier (0 = impassable); build: buildings allowed; fert: farm/forage fertility 0..1
  // flam: fire spread chance factor 0..1; color: average RGB (minimap / fallback)
  def(T.DEEP,     'deep',     'Глубокая вода', { color: [18, 54, 112],  lo: 0,   hi: 70,  mid: 40,  water: true,  speed: 0,    build: false, fert: 0,   flam: 0 });
  def(T.SHALLOW,  'shallow',  'Мелководье',    { color: [46, 120, 190], lo: 70,  hi: 100, mid: 86,  water: true,  speed: 0.45, build: false, fert: 0,   flam: 0 });
  def(T.SAND,     'sand',     'Песок',         { color: [222, 205, 140], lo: 100, hi: 112, mid: 106, water: false, speed: 0.85, build: true,  fert: 0.1, flam: 0 });
  def(T.GRASS,    'grass',    'Трава',         { color: [88, 160, 62],  lo: 112, hi: 160, mid: 134, water: false, speed: 1,    build: true,  fert: 1,   flam: 0.22 });
  def(T.FOREST,   'forest',   'Лес',           { color: [38, 104, 48],  lo: 112, hi: 160, mid: 136, water: false, speed: 0.6,  build: false, fert: 0.5, flam: 1 });
  def(T.HILL,     'hill',     'Холмы',         { color: [140, 128, 84], lo: 160, hi: 192, mid: 176, water: false, speed: 0.7,  build: true,  fert: 0.3, flam: 0.08 });
  def(T.MOUNTAIN, 'mountain', 'Горы',          { color: [112, 108, 108], lo: 192, hi: 228, mid: 210, water: false, speed: 0.35, build: false, fert: 0,   flam: 0 });
  def(T.SNOW,     'snow',     'Снег',          { color: [236, 242, 250], lo: 228, hi: 256, mid: 242, water: false, speed: 0.5,  build: false, fert: 0,   flam: 0 });
  def(T.LAVA,     'lava',     'Лава',          { color: [226, 84, 24],  lo: 192, hi: 228, mid: 200, water: false, speed: 0,    build: false, fert: 0,   flam: 0, lava: true });

  /** Terrain implied by a height value (never returns FOREST / LAVA). */
  function fromElev(e) {
    if (e < 70) return T.DEEP;
    if (e < 100) return T.SHALLOW;
    if (e < 112) return T.SAND;
    if (e < 160) return T.GRASS;
    if (e < 192) return T.HILL;
    if (e < 228) return T.MOUNTAIN;
    return T.SNOW;
  }

  return {
    defs,
    def(t) { return defs[t]; },
    fromElev,
    midElev(t) { return defs[t].mid; },
    isWater(t) { return t === T.DEEP || t === T.SHALLOW; },
    isLand(t) { return t !== T.DEEP && t !== T.SHALLOW && t !== T.LAVA; },
    /** generic walkability (race-specific cost lives in World.moveCost) */
    walkable(t) { return defs[t].speed > 0; },
    buildable(t) { return defs[t].build; },
  };
})();
