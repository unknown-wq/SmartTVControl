/* =====================================================================
 * 02_data.js — shared static game data: Races, Traits, Gear, palettes, God tools
 * OWNER: architect. Read-only for other modules (propose changes in docs/REQUESTS.md).
 * ===================================================================== */

const Races = (() => {
  const T = Const.T;
  const list = [
    {
      id: 0, key: 'human', name: 'Люди', one: 'Человек', color: '#4aa3ff',
      lifespan: [62, 88],      // natural death window, years
      maturity: 16,            // adulthood age (years)
      fertAge: [16, 45],       // fertile window
      birthCooldown: 3,        // years between births for a mother (before modifiers)
      hp: 20, atk: 3, def: 1,
      speed: 1.6,              // tiles/second on a speed=1 tile
      work: 1.0,               // gathering/building efficiency
      fertility: 1.0,          // birth chance multiplier
      range: 1.2,              // attack reach in tiles (melee); elves get range from Gear.range()
      aggression: 0.30,        // 0..1 baseline for hostility toward foreign-race wanderers / king war propensity
      expansion: 1.0,          // how eagerly the race founds new villages
      cityRadius: 7,           // base territory radius (tiles) of a village
      // extra speed multiplier by terrain (default 1)
      terrain: { [T.GRASS]: 1.1, [T.SAND]: 1, [T.FOREST]: 0.9, [T.HILL]: 0.9, [T.MOUNTAIN]: 0.7, [T.SNOW]: 0.8, [T.SHALLOW]: 0.9 },
      // preference weights for choosing a village site (higher better); nearWater/nearForest/nearMountain 0..1 weights
      habitat: { [T.GRASS]: 1.0, [T.SAND]: 0.3, [T.FOREST]: 0.4, [T.HILL]: 0.5, nearWater: 0.6, nearForest: 0.4, nearMountain: 0.2 },
    },
    {
      id: 1, key: 'orc', name: 'Орки', one: 'Орк', color: '#6fbf3a',
      lifespan: [45, 65], maturity: 12, fertAge: [12, 38], birthCooldown: 4.5,
      hp: 30, atk: 5, def: 2, speed: 1.6, work: 0.9, fertility: 0.6, range: 1.2,
      aggression: 0.75, expansion: 0.8, cityRadius: 7,
      terrain: { [T.GRASS]: 1, [T.SAND]: 1, [T.FOREST]: 0.8, [T.HILL]: 1.15, [T.MOUNTAIN]: 1.0, [T.SNOW]: 0.9, [T.SHALLOW]: 0.8 },
      habitat: { [T.GRASS]: 0.5, [T.SAND]: 0.2, [T.FOREST]: 0.2, [T.HILL]: 1.0, nearWater: 0.2, nearForest: 0.1, nearMountain: 1.0, nearLava: 0.8 },
    },
    {
      id: 2, key: 'elf', name: 'Эльфы', one: 'Эльф', color: '#c78bff',
      lifespan: [140, 220], maturity: 24, fertAge: [24, 120], birthCooldown: 9,
      hp: 16, atk: 3, def: 1, speed: 1.8, work: 1.0, fertility: 0.35, range: 1.2,
      aggression: 0.25, expansion: 0.6, cityRadius: 8,
      terrain: { [T.GRASS]: 1, [T.SAND]: 0.9, [T.FOREST]: 1.4, [T.HILL]: 0.9, [T.MOUNTAIN]: 0.6, [T.SNOW]: 0.7, [T.SHALLOW]: 0.8 },
      habitat: { [T.GRASS]: 0.5, [T.SAND]: 0.1, [T.FOREST]: 1.0, [T.HILL]: 0.2, nearWater: 0.4, nearForest: 1.0, nearMountain: 0.0 },
    },
  ];
  // Base inter-race opinion, -100..100. rel[a][b] = how race a feels about race b.
  const rel = [
    /* human */ [30, -30, 40],
    /* orc   */ [-30, 20, -70],
    /* elf   */ [40, -70, 50],
  ];
  return {
    list, rel,
    get(r) { return list[r]; },
    isHostileBase(a, b) { return rel[a][b] <= -50; },
  };
})();

/* ---------- Character traits (2–3 per unit) ---------- */
const Traits = (() => {
  // mul keys (default 1): atk hp work fertility xp speed sick
  // add keys (default 0): flee war peace greed loyalty
  const list = [
    { key: 'brave',       name: 'Храбрый',        atk: 1.1, flee: -0.3, war: 0.15 },
    { key: 'coward',      name: 'Трусливый',      atk: 0.9, flee: 0.4, war: -0.2 },
    { key: 'greedy',      name: 'Жадный',         greed: 1, war: 0.1 },
    { key: 'wise',        name: 'Мудрый',         xp: 1.3, peace: 0.25, war: -0.1 },
    { key: 'aggressive',  name: 'Агрессивный',    atk: 1.15, war: 0.3, peace: -0.2 },
    { key: 'peaceful',    name: 'Миролюбивый',    atk: 0.95, war: -0.3, peace: 0.3 },
    { key: 'strong',      name: 'Сильный',        hp: 1.2, atk: 1.1 },
    { key: 'lazy',        name: 'Ленивый',        work: 0.75 },
    { key: 'diligent',    name: 'Трудолюбивый',   work: 1.25 },
    { key: 'fertile',     name: 'Плодовитый',     fertility: 1.4 },
    { key: 'sickly',      name: 'Болезненный',    hp: 0.8, sick: 1.5 },
    { key: 'charismatic', name: 'Харизматичный',  loyalty: 10 },
    { key: 'cruel',       name: 'Жестокий',       loyalty: -10, war: 0.1 },
    { key: 'kind',        name: 'Добрый',         loyalty: 8, peace: 0.1 },
    { key: 'fast',        name: 'Быстрый',        speed: 1.2 },
    { key: 'curious',     name: 'Любознательный', xp: 1.15 },
  ];
  const byKey = {};
  list.forEach((t, i) => { t.id = i; byKey[t.key] = t; });
  return {
    list, byKey,
    get(id) { return list[id]; },
    /** product of multiplicative modifiers `key` over unit/ruler traits (u.traits = [ids]) */
    mul(u, key) { let m = 1; const a = u.traits; if (a) for (let i = 0; i < a.length; i++) { const v = list[a[i]][key]; if (v !== undefined) m *= v; } return m; },
    /** sum of additive modifiers `key` */
    sum(u, key) { let m = 0; const a = u.traits; if (a) for (let i = 0; i < a.length; i++) { const v = list[a[i]][key]; if (v !== undefined) m += v; } return m; },
    has(u, key) { const a = u.traits; if (!a) return false; const id = byKey[key].id; return a.indexOf(id) >= 0; },
    /** pick 2-3 distinct random trait ids, avoiding contradictory pairs. Uses R. */
    roll() {
      const n = R.chance(0.45) ? 3 : 2;
      const bad = [[0, 1], [4, 5], [7, 8]];
      const out = [];
      let guard = 0;
      while (out.length < n && guard++ < 30) {
        const id = R.i(list.length);
        if (out.indexOf(id) >= 0) continue;
        if (bad.some(p => (p[0] === id && out.indexOf(p[1]) >= 0) || (p[1] === id && out.indexOf(p[0]) >= 0))) continue;
        out.push(id);
      }
      return out;
    },
  };
})();

/* ---------- Equipment tiers (weapon / armor 0..3) ---------- */
const Gear = {
  weaponAtk: [0, 2, 4, 7],
  armorDef: [0, 1, 3, 5],
  weaponNames: {
    human: ['Кулаки', 'Дубина', 'Меч', 'Стальной меч'],
    orc: ['Кулаки', 'Дубина', 'Топор', 'Боевой топор'],
    elf: ['Кулаки', 'Короткий лук', 'Длинный лук', 'Эльфийский лук'],
  },
  armorNames: ['Нет', 'Кожаная', 'Кольчуга', 'Латы'],
  // resources a city spends to equip one unit with the tier (tier 0 is free)
  weaponCost: [{}, { wood: 2 }, { iron: 2 }, { iron: 4, gold: 1 }],
  armorCost: [{}, { wood: 1 }, { iron: 3 }, { iron: 6, gold: 1 }],
  /** attack reach in tiles */
  range(race, weaponTier) { return race === Const.RACE.ELF && weaponTier >= 1 ? 3 + weaponTier : 1.2; },
  isRanged(race, weaponTier) { return race === Const.RACE.ELF && weaponTier >= 1; },
};

/* ---------- Palettes ---------- */
const Palette = {
  kingdom: ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#00acc1', '#d81b60',
            '#6d4c41', '#7cb342', '#3949ab', '#f4511e', '#00897b', '#c0ca33', '#5e35b1', '#ec407a'],
  // culture colors (12 cultures); Kingdoms assigns S.cultures entries using these
  culture: ['#ef9a9a', '#90caf9', '#a5d6a7', '#fff59d', '#ce93d8', '#ffcc80', '#80deea', '#f48fb1', '#bcaaa4', '#c5e1a5', '#9fa8da', '#b0bec5'],
};

/* ---------- God tools (single source of truth for UI + Powers) ----------
 * brush: radius slider applies; drag: may be applied continuously while painting
 * Powers.apply(id, tx, ty, radius, phase) implements every id.
 * `icon` keys must be drawable by Sprites.icon(key, size).
 */
const Tabs = [
  { id: 'land',     name: 'Ландшафт',   icon: 'tab_land' },
  { id: 'life',     name: 'Существа',   icon: 'tab_life' },
  { id: 'powers',   name: 'Силы',       icon: 'tab_powers' },
  { id: 'kingdoms', name: 'Королевства', icon: 'tab_kingdoms' },
  { id: 'info',     name: 'Инфо',       icon: 'tab_info' },
];

const ToolDefs = [
  // ---- land ----
  { id: 'raise',    tab: 'land', group: 'terrain', name: 'Поднять',  icon: 'raise',    brush: true, drag: true, hint: 'Поднять землю' },
  { id: 'lower',    tab: 'land', group: 'terrain', name: 'Опустить', icon: 'lower',    brush: true, drag: true, hint: 'Опустить землю (вода)' },
  { id: 'grass',    tab: 'land', group: 'terrain', name: 'Трава',    icon: 'grass',    brush: true, drag: true, hint: 'Покрыть травой' },
  { id: 'sand',     tab: 'land', group: 'terrain', name: 'Песок',    icon: 'sand',     brush: true, drag: true, hint: 'Насыпать песок' },
  { id: 'forest',   tab: 'land', group: 'terrain', name: 'Лес',      icon: 'forest',   brush: true, drag: true, hint: 'Посадить лес' },
  { id: 'hill',     tab: 'land', group: 'terrain', name: 'Холмы',    icon: 'hill',     brush: true, drag: true, hint: 'Создать холмы' },
  { id: 'mountain', tab: 'land', group: 'terrain', name: 'Гора',     icon: 'mountain', brush: true, drag: true, hint: 'Поднять гору' },
  { id: 'snow',     tab: 'land', group: 'terrain', name: 'Снег',     icon: 'snow',     brush: true, drag: true, hint: 'Покрыть снегом' },
  { id: 'lava',     tab: 'land', group: 'terrain', name: 'Лава',     icon: 'lava',     brush: true, drag: true, hint: 'Пролить лаву' },
  // ---- life ----
  { id: 'human',    tab: 'life', group: 'creatures', name: 'Человек', icon: 'human', brush: true, drag: true, hint: 'Создать людей' },
  { id: 'orc',      tab: 'life', group: 'creatures', name: 'Орк',     icon: 'orc',   brush: true, drag: true, hint: 'Создать орков' },
  { id: 'elf',      tab: 'life', group: 'creatures', name: 'Эльф',    icon: 'elf',   brush: true, drag: true, hint: 'Создать эльфов' },
  { id: 'erase',    tab: 'life', group: 'creatures', name: 'Стереть', icon: 'erase', brush: true, drag: true, hint: 'Стереть существ' },
  // ---- powers: destruction ----
  { id: 'lightning',  tab: 'powers', group: 'destroy', name: 'Молния',      icon: 'lightning',  brush: false, drag: false, hint: 'Удар молнии' },
  { id: 'meteor',     tab: 'powers', group: 'destroy', name: 'Метеорит',    icon: 'meteor',     brush: true,  drag: false, hint: 'Метеорит (радиус = кисть)' },
  { id: 'fire',       tab: 'powers', group: 'destroy', name: 'Огонь',       icon: 'fire',       brush: true,  drag: true,  hint: 'Поджечь' },
  { id: 'earthquake', tab: 'powers', group: 'destroy', name: 'Землетрясение', icon: 'earthquake', brush: true, drag: false, hint: 'Трещины и лава' },
  { id: 'plague',     tab: 'powers', group: 'destroy', name: 'Чума',        icon: 'plague',     brush: true,  drag: false, hint: 'Заразная болезнь' },
  { id: 'tornado',    tab: 'powers', group: 'destroy', name: 'Торнадо',     icon: 'tornado',    brush: false, drag: false, hint: 'Выпустить торнадо' },
  // ---- powers: blessings ----
  { id: 'rain',  tab: 'powers', group: 'bless', name: 'Дождь',       icon: 'rain',  brush: true, drag: true,  hint: 'Дождь: тушит огонь, растит лес' },
  { id: 'heal',  tab: 'powers', group: 'bless', name: 'Исцеление',   icon: 'heal',  brush: true, drag: true,  hint: 'Исцелить' },
  { id: 'bless', tab: 'powers', group: 'bless', name: 'Благословение', icon: 'bless', brush: true, drag: false, hint: 'Временный буст' },
  // ---- kingdoms: command a country (HOI4-style) — handled by UI (no Powers.apply effect) ----
  { id: 'command', tab: 'kingdoms', group: 'command', name: 'Командовать', icon: 'command', brush: false, drag: false, hint: 'Тап по королевству: взять под командование (войны, приказы, мир)' },
  // ---- kingdoms: diplomacy powers (single tap on a king / unit / city / territory) ----
  { id: 'war_whisper', tab: 'kingdoms', group: 'diplomacy', name: 'Шёпот войны', icon: 'war_whisper', brush: false, drag: false, hint: 'Тапните по королю: королевство объявит войну соседу' },
  { id: 'peace',       tab: 'kingdoms', group: 'diplomacy', name: 'Мир',         icon: 'peace',       brush: false, drag: false, hint: 'Тапните по королевству: прекратить войны' },
  { id: 'split',       tab: 'kingdoms', group: 'diplomacy', name: 'Разделить',   icon: 'split',       brush: false, drag: false, hint: 'Тапните по городу: он станет независимым' },
  // ---- info ----
  { id: 'inspect', tab: 'info', group: 'info', name: 'Осмотр', icon: 'inspect', brush: false, drag: false, hint: 'Тап по существу, городу или королевству' },
];
ToolDefs.byId = {};
ToolDefs.forEach(t => { ToolDefs.byId[t.id] = t; });
