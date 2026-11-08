# GODSIM — module contract (read this fully before writing code)

A mobile-first "god simulator" (WorldBox-like). Final deliverable is ONE self-contained `godsim/index.html`
(inline JS + CSS, zero external assets, procedural pixel-art, UI language: **Russian**).
Source lives in `godsim/src/NN_name.js`; `node build.mjs` concatenates them (sorted by filename) into one
`(function(){'use strict'; ... })()` scope. **All files share one scope**, so:

* Each module exposes exactly one top-level `const Name = (() => { ...private...; return {...public}; })();`
  Keep all helpers private inside the IIFE (top-level name collisions break the build).
* **No module may touch another module at load time** (only inside functions that run after boot).
  The only things you may use at load time are the core globals: `Const, R, Util, Bus, Log, Hist, Fx, S, Tiles, Races, Traits, Gear, Palette, Tabs, ToolDefs, Names`.
* Sim modules (`00`–`13`) are **DOM-free** (no `window/document/localStorage` except `Save` via an injectable storage) so they run headless in node tests.
* Client modules (`20+`): Sprites, Render, Input, UI, Main. Never call them from sim modules (use `Fx.add`, `Log.add`, `Bus.emit`).
* Targets Safari iOS 15+: ES2020 max (no `??=`/`||=`, no regex lookbehind, no top-level await, no `Array.prototype.at`, no `structuredClone`, no `OffscreenCanvas` without fallback).
* JSON-safe entities: every field of units/cities/buildings/kingdoms/armies/wars/relations must survive `JSON.stringify` (no functions, no object references — use ids, no Set/Map inside entities; arrays and plain objects only). `Save` serializes `S.units.values()` etc. directly.
* Use `R` (seeded RNG, state saved with the world) for ALL gameplay randomness. `Math.random()` only in client visuals.
* Randomness/time: never use `Date.now()` in sim code; time is `S.tick`. 1 year = `Const.TICKS_PER_YEAR` (60) ticks; 10 ticks/s at ×1.
* Every public function must tolerate dead/missing ids (return null/false/0, never throw). Sim code that throws is caught per-module by Sim but is a bug.
* UI strings are Russian. Log messages wrap names in «guillemets» (`Names.ref(k)`), no declension of names.
* Performance budget: 1500 units at ×4 speed (up to ~40 ticks/s) on an iPhone. No allocation in per-tick hot loops (reuse arrays/objects), stagger work (`tick % N`), use the unit spatial grid.

## 0. Files & ownership

| file | module | stage | notes |
|---|---|---|---|
| 00_core.js | Const, R, Util, Bus, Log, Hist, Fx, S | arch | **read-only** |
| 01_tiles.js | Tiles | arch | read-only |
| 02_data.js | Races, Traits, Gear, Palette, Tabs, ToolDefs | arch | read-only |
| 03_names.js | Names | arch | read-only |
| 04_world.js | World | 1 | terrain gen, brushes, growth, fire, pathfinding |
| 05_buildings.js | Buildings | 1 | |
| 06_cities.js | Cities | 1 | |
| 07_units.js | Units | 1 | |
| 08_kingdoms.js | Kingdoms | 1 stub → 2 full | |
| 09_diplomacy.js | Diplomacy | 1 stub → 2 full | |
| 10_war.js | War | 1 stub → 2 full | |
| 11_powers.js | Powers | 1 (+2 diplomacy tools) | |
| 12_sim.js | Sim | 1 | tick orchestrator, stats, perf degradation, populate |
| 13_save.js | Save | 1 | |
| 20_sprites.js | Sprites | 1 | procedural pixel art |
| 21_render.js | Render | 1 | canvas renderer |
| 22_input.js | Input | 1 | touch camera + tap/paint |
| 23_ui.js, style.css, template.html | UI | 1 | DOM UI |
| 99_main.js | Main | 1 | boot, game loop, debug hook |

**Only edit the files you own.** If you need a change in a read-only file or another module's API, append a short entry to `docs/REQUESTS.md`
(`- [from Module → to Module] what/why`) and work around it (e.g. use `S.mod.yourModule` for private persistent state).
Private persistent module state goes in `S.mod.<moduleName>` (JSON-safe, auto-saved); non-persistent caches must be rebuilt in `afterLoad()`.

### Lifecycle hooks (all optional, every sim module may export them)
`newWorld()` — a fresh world was created (S.reset + terrain done): reset private caches / init `S.mod.x`.
`afterLoad()` — a save was loaded into S: rebuild caches (grids, lookup tables).
`step(tick)` — called once per sim tick; self-throttle with `tick % N`.

### Build / test commands (run from `godsim/`)
```
node build.mjs --check                       # build index.html + syntax check
node tests/run.mjs --ticks=1200 --seed=3     # headless smoke scenario (stubs any module whose file is missing)
node tests/run.mjs --stub=Cities,War ...     # force-stub modules (isolates your module from a broken neighbour)
```
`tests/harness.mjs` exports `loadSim({stub:[...]})` → object with every top-level name; `stepN(ctx,n)`, `newWorld(ctx,seed)`. Write your own
`tests/<module>.test.mjs` (plain node, `assert`, print a summary, exit code ≠ 0 on failure).
Browser testing: `tests/browser.mjs` (Playwright, iPhone emulation, touch helpers, console-error capture, screenshots). You CAN view PNG screenshots with the Read tool — do so to check visuals.

## 1. Core reference (already written — do not reimplement)

* `S` — global state. Terrain layers (index `i = y*S.w + x`): `S.tile` (Const.T ids), `S.elev` (0..255), `S.res` (Const.RES kind), `S.amt` (resource amount; for FOREST tiles = wood density),
  `S.owner` (city id), `S.bld` (building id), `S.fire` (burn ticks left). Collections (Maps by id): `S.units, S.cities, S.kingdoms, S.buildings, S.armies, S.wars`; `S.rels` (diplomacy), `S.cultures` (array), `S.eff` (god effects), `S.log`, `S.stats`, `S.perf`, `S.mod`.
  `S.id()` unique id; `S.markDirty(x,y)` after any visual change of a tile (terrain/res/amt); `S.touchOwner()` after territory/kingdom/culture changes; `S.landDirty = true` when land/water layout changed.
* `Const` — see file: tile ids `Const.T`, races `Const.RACE`, `Const.RES`, building types `Const.B`, `Const.GOODS = ['food','wood','stone','iron','gold']`, `Const.REL`, `Const.MODE`, `Const.STATES`, `Const.LOG`.
* `Tiles.defs[t]` — `{speed, build, fert, flam, water, color, mid, ...}`; `Tiles.fromElev(e)`, `Tiles.isWater/isLand/walkable/buildable`.
* `Races.list[r]` / `Races.get(r)` (stats, lifespan, habitat…), `Races.rel[a][b]` base opinion matrix; `Traits.mul(u,key)`, `Traits.sum(u,key)`, `Traits.roll()`; `Gear.*` (weapon/armor tiers, costs, `Gear.range`).
* `Names.person(race,sex)`, `Names.clan(race)`, `Names.place(race)`, `Names.kingdom(race)`, `Names.ref(ent)`, `Names.title(race)`, `Names.ruler(race,sex)`, `Names.cityWord(pop)`.
* `Log.add(msg, kind, x, y, kid)`, `Hist.add(entity, text)`, `Fx.add(type,x,y,opts)`, `Bus.on/emit` (see §6 events), `R.*`.
* `ToolDefs` / `Tabs` — the single list of god tools; `Powers.apply(id,…)` must implement every id; UI renders from it.

## 2. Entity schemas (plain JSON-safe objects)

```js
Unit = {
  id, race, sex /*Const.SEX*/, name, clan /*string*/,
  born,                       // tick of birth (negative allowed for initial adults). age(years) = Util.age(u)
  x, y, px, py,               // float tile coords (tile = floor(x), floor(y)); px,py = previous tick position (render interpolation)
  face,                       // -1 | 1 (sprite flip)
  hp, maxHp, hunger /*0 fed..100 starving*/, energy /*0 exhausted..100 rested*/,
  level /*1+*/, xp, kills,
  traits: [traitId...],       // 2-3 of Traits.list
  cityId /*home city, 0 none*/, kingdomId /*mirror of city.kingdomId, 0 none*/,
  weapon, armor,              // gear tiers 0..3 (Gear)
  state /*one of Const.STATES*/, st: {} /*state scratch, JSON-safe*/, job: null | {type,...},
  carry: null | 'food'|'wood'|'stone'|'iron'|'gold', carryAmt,
  fatherId, motherId, spouseId, armyId /*0*/, isRuler /*bool*/,
  sick /*tick until, 0*/, buffUntil, buffMul, burning /*tick until*/,
  nextThink /*tick*/, birthCd /*tick until may give birth*/,
  hist: [{y,t}],
}
City = {
  id, name, race, kingdomId, x, y /*center tile ints*/, pop /*cached*/, members: [unitIds],
  stock: {food,wood,stone,iron,gold}, radius /*territory radius*/, level /*1..5*/,
  loyalty /*0..100*/, culture /*cultureId*/, founded /*tick*/, buildings: [ids],
  hist: [], mod: {}            // `mod` = Cities' private scratch
}
Building = { id, type /*Const.B*/, cityId, x, y, hp, maxHp, progress /*0..1*/, done /*bool*/, level, born, data: {} }
Kingdom = {
  id, name, race, color /*'#rrggbb' = flag.c1*/, flag: {pattern 0..5, symbol 0..9, c1, c2, c3 /*hex*/},
  capitalId, rulerId, cities: [cityIds], culture /*cultureId*/, stability /*0..100*/, born, alive, clan /*dynasty name*/, hist: []
}
Army = { id, kingdomId, cityId /*home*/, warId, leaderId, members: [unitIds], target: {cityId,x,y}|null, rally: {x,y}, mode: 'gather'|'march'|'siege'|'retreat', born }
War = { id, attackers: [kids], defenders: [kids], aggressor, defender, started /*tick*/, casus, ended: false, kills: {kid: n}, hist: [] }
Relation = { a, b /*a<b*/, opinion /*-100..100 symmetric*/, state /*Const.REL*/, since, truceUntil, allianceSince, causes: [{t,v,why}] }
Culture = { id, name, color, race }   // S.cultures[id]
```

## 3. Sim-module APIs

### World (04_world.js)
```
World.generate({seed, w, h})   // S.reset(w,h,seed) then fill layers. Continents/islands (fbm noise + radial falloff), ~35-45% land, beaches,
                               // biome belts (forest clusters, hills, mountains w/ snow caps, a few lakes), ore (ROCK/IRON/GOLD) in hills/mountains,
                               // BERRY on grass. S.elev drives shading. Must take < 150 ms for 96x96. Marks allDirty. Calls nothing else.
World.tileAt(x,y)              // tile id, out of bounds -> DEEP
World.setTile(x,y,t,opts)      // opts {elev, keepRes}. Sets S.tile (+ S.elev to Tiles.midElev unless given), clears incompatible S.res/S.amt (FOREST gets amt 80-200),
                               // extinguishes fire on water/lava, S.markDirty, S.landDirty when water<->land, Bus.emit('tileChanged',x,y,old,new). Becoming water/lava destroys
                               // the building there via Buildings.destroyAt(x,y,'terrain').
World.brush(toolId,cx,cy,r)    // toolIds 'raise','lower','grass','sand','forest','hill','mountain','snow','lava'; r = radius in tiles (1..8), circular w/ soft edge.
                               // raise/lower change S.elev by ±(10..30)*falloff then retype via Tiles.fromElev (FOREST stays FOREST while elev stays in grass band; LAVA->raise => MOUNTAIN).
                               // painting tools set tile directly (forest: tile FOREST only on land-non-mountain tiles; hill/mountain/snow raise elev to band). Returns tiles changed.
World.walkable(x,y)            // not DEEP/LAVA
World.moveCost(x,y,race)       // speed multiplier (Tiles.defs[t].speed * Races.terrain[t]) ; 0 if blocked
World.findPath(x0,y0,x1,y1,race,maxNodes)  // bounded 8-neighbour A* (no corner cutting), returns [[x,y],...] excluding start including goal, or null. Quick-rejects via landId.
World.landId(x,y) / World.sameLand(x0,y0,x1,y1)   // lazily recomputed flood-fill labels (walkable components) when S.landDirty
World.isBuildable(x,y)         // tile buildable, no building, not burning, no S.res feature
World.findNearestRes(x,y,kind,maxR,pred)   // ring search -> [tx,ty]|null. kind: Const.RES.TREE (FOREST tile or lone tree), ROCK, IRON, GOLD, BERRY, FISH (land tile adjacent to SHALLOW)
World.harvest(x,y,kind,amount) // returns amount actually taken (>=0); depletes S.amt; depleted FOREST->GRASS, depleted ore/berry -> res cleared (berries regrow later); FISH infinite
World.resAt(x,y)               // effective {kind, amt} (FOREST => {TREE, amt})
World.ignite(x,y) / World.extinguish(x,y,r) / World.isBurning(x,y)
World.randomLand(pred, tries)  // random walkable land tile [x,y]|null
World.nearestTile(x,y,tileId,maxR)
World.step(tick)               // every tick cheap; heavy work staggered: tree growth+spread (lone saplings S.res=TREE spread from FOREST and mature into FOREST; rain boosts via S.eff.rains),
                               // berry regrowth, fire spreading/burn-out (forest/grass/buildings; damages units via Units.damageAt and buildings via Buildings.damageAt every ~5 ticks;
                               // rain in S.eff.rains extinguishes), lava cooling (next to water -> MOUNTAIN quickly; otherwise rare -> HILL), land relabel when S.landDirty.
```
### Buildings (05_buildings.js)
```
Buildings.defs[type] = {key, name, cost:{wood,stone,iron,gold}, work /*total work units*/, hp, cap /*housing for HOUSE*/, flam, ...}
Buildings.place(cityId,type,x,y,opts{instant}) // validate tile via World.isBuildable (townhall may replace a berry), pay cost via Cities.withdraw (fail -> null), create unfinished site, S.bld, markDirty
Buildings.get(id) / Buildings.at(x,y) / Buildings.byCity(cityId) /*array*/
Buildings.work(b,amount)      // add progress, returns true when it just completed (hp full, Bus 'buildingDone', Cities notified through the bus)
Buildings.damage(b,dmg,byKingdomId,cause) // returns true if destroyed
Buildings.damageAt(x,y,dmg,cause) / Buildings.destroy(b,cause) / Buildings.destroyAt(x,y,cause)  // destroy removes from city.buildings, S.bld, may free housing; unfinished sites refund nothing
Buildings.step(tick)          // farm food output into the city's stock (only if a worker is attached or small passive trickle), repairs, etc.
```
### Cities (06_cities.js)
```
Cities.get(id) / Cities.list() /*array*/ / Cities.nearest(x,y,maxD,pred)
Cities.canFound(x,y,race)     // buildable, ≥ Const.CITY_MIN_DIST from every city, land
Cities.findSite(race,x,y,maxR)// best site by Races.habitat + water/forest/mountain proximity; {x,y,score}|null
Cities.found(race,x,y,founders /*units*/,opts{parentCityId}) // creates city, instant TOWNHALL (done) + 1 house site, members set, calls Kingdoms.onCityFounded(city,parentCityId),
                                // territory, Log "Основана деревня «X»", Bus 'cityFounded'. Returns city|null.
Cities.trySettle(u)           // homeless adult asks: may JOIN a same/friendly-race city with free housing (sets membership, returns null), or FOUND a village together with ≥3 nearby homeless
                              // adults (≥2 incl. one M and one F is enough for elves), or return a {x,y} hint to walk toward (settlement site/group). Never throws.
Cities.foundExpedition(u)     // called by Units when an 'settle' expedition member arrives (u.st.target, u.st.parent); founds city with the group, returns city|null
Cities.addMember(cityId,u) / Cities.removeMember(u)   // maintain city.members, city.pop, u.cityId, u.kingdomId
Cities.setKingdom(cityId,kid) // also updates kingdomId of every member
Cities.assignJob(u)           // -> job {type:'build'|'chop'|'mine'|'forage'|'fish'|'farm'|'guard'|'idle', x,y, buildingId?, kind?}; balances labor by city needs (food first, then housing, storage, military)
Cities.dropoff(cityId,x,y)    // {x,y} nearest storage/townhall
Cities.deposit(cityId,good,amt) / Cities.withdraw(cityId,good,amt) /*returns actually withdrawn*/ / Cities.stock(cityId,good)
Cities.housingCap(cityId) / Cities.housingFree(cityId)
Cities.outfit(cityId,u)       // equips u with the best affordable weapon/armor tier from the city stock (Gear costs), returns true if changed
Cities.recomputeTerritory(cityId) // S.owner within radius (nearest-centre wins, land only), S.touchOwner(); radius grows with level
Cities.ownerAt(x,y)           // S.owner lookup
Cities.destroy(cityId,cause)  // buildings destroyed, members homeless (kingdomId 0), territory released, Kingdoms.onCityLost, Log
Cities.capture(cityId,newKid,army) // flips kingdom (Kingdoms.transferCity), loyalty low, some buildings damaged, members keep living there; Log + Bus 'cityCaptured'
Cities.step(tick)             // staggered per city: pop/housing/needs, construction planning (houses when housing is short, farms when food is short, storage, barracks≥pop 12,
                              // temple≥20, market≥30), territory growth, level, expeditions (pop≥14 & housing full & food surplus), starvation relief
```
### Units (07_units.js)
```
Units.get(id) / Units.count()
Units.spawn(race,x,y,opts{sex,age /*years, default adult 16-30 for god-spawn*/,cityId,fatherId,motherId,name,traits}) -> unit|null (respects S.perf.unitCap; tile must be walkable)
Units.kill(u,cause,killer)    // removes from S.units & city/army/grid, spouse cleared, ruler death -> Kingdoms.step handles succession, Bus 'unitDied', Log for kings/notable
Units.damage(u,dmg,cause,attacker) / Units.damageAt(x,y,dmg,cause) / Units.heal(u,amount)
Units.nearby(x,y,r,fn)        // calls fn(u) for units within r tiles (uses spatial grid, NO allocation); fn returning true stops
Units.inRadius(x,y,r) /*array*/ / Units.nearest(x,y,r,pred) / Units.eraseInRadius(x,y,r) /*count*/
Units.stage(u)                // 'child'|'adult'|'elder'
Units.stats(u)                // effective {atk,def,range,speed,maxHp} from race, traits, level, gear, buff
Units.isHostile(a,b)          // rules in §5
Units.setCity(u,cityId)       // wrapper over Cities.addMember/removeMember
Units.conscript(u,armyId) / Units.release(u)   // army membership (state 'army')
Units.infect(u,untilTick)
Units.stateLabel(u)           // Russian label for inspector
Units.step(tick)              // see §5; spatial grid = private; must expose Units.rebuildGrid() used by afterLoad
```
### Kingdoms (08_kingdoms.js) — stub exists now; stage 2 = full
```
Kingdoms.get(id) / Kingdoms.ruler(kid) / Kingdoms.cities(kid) /*array of city objects*/ / Kingdoms.pop(kid) / Kingdoms.strength(kid) / Kingdoms.ofUnit(u) / Kingdoms.at(x,y)
Kingdoms.onCityFounded(city,parentCityId) // assign to parent's kingdom, or nearest same-race kingdom ≤28 tiles, else new kingdom (the FIRST village of a race = capital); returns kingdom
Kingdoms.onCityLost(city,oldKid) / Kingdoms.destroy(kid,cause)
Kingdoms.setRuler(kid,u) / Kingdoms.succession(kid)   // heir: eldest adult child → sibling → clan member → best citizen of capital; Log
Kingdoms.transferCity(cityId,toKid,cause) / Kingdoms.annex(smallKid,bigKid,how) / Kingdoms.splitCity(cityId) /*new kid*/ / Kingdoms.rebel(cityId)
Kingdoms.newCulture(race)
Kingdoms.step(tick)   // stability, culture spread, loyalty, rebellion rolls, voluntary joins, ruler checks
```
### Diplomacy (09_diplomacy.js) — stub now; stage 2 = full
```
Diplomacy.get(a,b) /*Relation, created lazily from base opinion*/ / opinion(a,b) / state(a,b) / atWar(a,b) / allied(a,b)
Diplomacy.addOpinion(a,b,delta,why) / declareWar(aggressor,defender,casus) /*-> War|null*/ / makeAlliance(a,b) / breakAlliance(a,b)
Diplomacy.godWhisperWar(kid) / Diplomacy.godPeace(kid) / Diplomacy.neighbors(kid) /*[{kid,dist,contact}]*/ / Diplomacy.relationsOf(kid) /*[{other,opinion,state}]*/
Diplomacy.onKingdomCreated(k) / onKingdomDestroyed(kid) / step(tick)
```
### War (10_war.js) — stub now; stage 2 = full
```
War.start(attackerKid,defenderKid,casus) /*allies join*/ / War.end(warId,how) / War.get(id) / War.warsOf(kid) / War.active() / War.godPeace(kid) / War.armyOf(armyId) / War.step(tick)
```
### Powers (11_powers.js)
```
Powers.apply(toolId,tx,ty,radius,phase /*'tap'|'start'|'move'|'end'*/) -> boolean   // implements EVERY ToolDefs id. Drag-capable tools are rate-limited internally on 'move'.
Powers.pick(tx,ty) -> {type:'unit'|'building'|'city'|'kingdom'|'tile', id, x, y}   // tap resolution used by the inspector and diplomacy tools (kings get a larger pick radius)
Powers.lightning(x,y) / meteor(x,y,r) / fire(x,y,r) / earthquake(x,y,r) / plague(x,y,r) / tornado(x,y) / rain(x,y,r) / heal(x,y,r) / bless(x,y,r)
Powers.step(tick)   // advances S.eff.{meteors,tornados,rains,quakes}
```
`S.eff` shapes (Render draws them): `meteors:[{x,y,r,eta /*impact tick*/,t0}]`, `tornados:[{x,y,dx,dy,until,r}]`, `rains:[{x,y,r,until}]`, `quakes:[{x,y,r,until}]`.
### Sim (12_sim.js)
```
Sim.newWorld({seed,w,h,populate}) // World.generate → every module.newWorld() → optionally Sim.populate()
Sim.populate()                    // seeds life: several small groups of each race on suitable biomes (humans 3 groups×6, elves 2×5, orcs 2×5) so a fresh world is alive
Sim.step()                        // ONE tick: S.tick++, World→Buildings→Units→Cities→Kingdoms→Diplomacy→War→Powers (each in try/catch, errors logged once per module), Fx not touched
Sim.stats()                       // recompute S.stats (pop per race, kingdoms, cities, wars, buildings) — also auto every 10 ticks
Sim.adaptPerf(frameMs)            // degradation: when units > 900 or step too slow raise S.perf.thinkEvery (3→6), lod; cap births at S.perf.unitCap
Sim.afterLoad()                   // calls every module.afterLoad(), stats
```
### Save (13_save.js)
```
Save.save(slot) -> bool   // slot 'auto'|'1'|'2'|'3' → localStorage `godsim.v1.<slot>`; JSON with typed arrays as base64, entities as arrays, S.rngState, version
Save.load(slot) -> bool   // validate version, S.reset(w,h,seed) then fill, Sim.afterLoad()
Save.exists(slot) / Save.info(slot) /*{year,pop,w,h,savedAt}|null*/ / Save.remove(slot) / Save.serialize()->string / Save.deserialize(str)->bool
Save.storage                      // injectable (defaults to window.localStorage when available) for headless tests
```

## 4. Client APIs

### Sprites (20_sprites.js) — all art is code-generated (ASCII/pixel-grid templates + palette → canvas), 16×16 base resolution, crisp pixels
```
Sprites.init()                                         // build atlases; idempotent
Sprites.drawTile(ctx,t,x,y,size,variant)               // terrain tile (≥4 variants/type, shaded; deep water/shallow/sand/grass/forest(dense trees)/hill/mountain/snow/lava, animated-looking via 2 frames optional)
Sprites.tileAtlas()                                    // {canvas, cols, tilePx} optional fast path for Render
Sprites.feature(kind,variant)                          // canvas for Const.RES kinds TREE (lone tree), ROCK, IRON, GOLD, BERRY
Sprites.unit(race,stage /*'child'|'adult'|'elder'*/,frame /*0|1*/,tint /*kingdom hex or null*/,weapon,armor) -> canvas   // cached by key; ≥2 walk frames; cloth region tinted by kingdom color; weapon/armor visible; elves w/ bow; orcs bulky green
Sprites.building(type,race,level,done) -> canvas       // per race style; unfinished = scaffold look; sizes 16×16 (townhall may be 16×16 but richer)
Sprites.flag(flag,w,h) -> canvas                       // kingdom flag: pattern 0..5 (plain,halves,stripes,cross,diagonal,chevron) × symbol 0..9 (procedural glyphs) cached
Sprites.icon(key,size) -> canvas                       // UI icons incl. every ToolDefs[].icon, Tabs[].icon, and: play,pause,speed1,speed2,speed4,menu,hand,brush,save,load,newworld,close,
                                                       //   map_normal,map_borders,map_culture,crown,sword,heart,food,wood,stone,iron,gold,human,orc,elf,skull,coin, plus races as small heads
Sprites.drawFx(ctx,fx,px,py,scale,now)                 // draws one Fx entry (Fx.list item) at screen position: lightning,explosion,fire,smoke,heal,bless,plague,quake,dust,spark,splash,blood,whisper,ash
Sprites.drawEffect(ctx,kind,e,px,py,scale,now)         // persistent S.eff items: 'meteor','tornado','rain','quake'
```
### Render (21_render.js)
```
Render.init(canvas) / Render.resize(cssW,cssH,dpr)           // dpr is clamped to ≤2 internally
Render.cam = {x,y,zoom}   // x,y = tile coords at screen center, zoom = CSS px per tile (≈ 3 … 48); clamp so the map never leaves the view entirely
Render.screenToTile(sx,sy) -> {x,y} floats / Render.tileToScreen(tx,ty) -> {x,y} / Render.focusOn(x,y,zoom?)
Render.setMode(Const.MODE.*) / Render.mode
Render.highlight = null | {type,id,x,y} ; Render.brush = null | {x,y,r}   // selection ring, brush preview circle
Render.draw(alpha,now)    // alpha 0..1 interpolation between ticks (use u.px→u.x), now = ms; draws ONLY visible tiles/units/buildings. 60 FPS target.
Render.stats = {fps, drawMs, visibleUnits, visibleTiles}
```
Design: terrain (+ lone trees/ore/berries baked) cached in an offscreen canvas of S.w*16 × S.h*16 updated incrementally from `S.dirtyList` (consume + clear; if `S.allDirty` rebuild fully);
shading from S.elev and neighbours (hill-shade), shore foam/edges, simple 2-frame water shimmer. Borders overlay cached and rebuilt when `S.ownerVer` changes. Units/buildings/fx drawn per frame for the visible region only (sorted by y), `imageSmoothingEnabled=false`.
Map modes: NORMAL (nothing), BORDERS (kingdom-colored translucent territory + outlines, city names/flags at high zoom), CULTURE (tint by city.culture color). City labels/flags drawn in all modes when zoom ≥ ~10.
Burning tiles (S.fire) get flame animation; S.eff effects drawn via Sprites.drawEffect; Fx via Sprites.drawFx. Optional day/night tint is NOT required.

### Input (22_input.js)
```
Input.init(canvas, {onTap(tx,ty), onPaint(tx,ty,phase), onHover?})   // tx,ty float tile coords; phase 'start'|'move'|'end'
Input.mode = 'pan' | 'paint'
```
`pan` mode: 1 finger drag = pan, tap (<10 px, <350 ms) = onTap; `paint` mode: 1 finger = onPaint start/move/end continuously (no pan); in BOTH modes 2 fingers = pinch-zoom (about the midpoint) + pan.
Mouse support for desktop testing (drag = pan, wheel = zoom, click = tap; Shift+drag = paint). `touch-action:none`, `preventDefault` on touch events (passive:false), block iOS gesture events. Inertia on pan release is a nice-to-have.

### UI (23_ui.js + style.css + template.html)
Portrait mobile layout, `viewport-fit=cover`, safe-area insets, dynamic height (`100dvh`/JS `innerHeight`), `touch-action`, no text selection, large touch targets (≥48 px; tool buttons 56 px).
* **Top bar:** world year, population per race (3 colored icons + numbers), kingdoms count, speed buttons (pause ⏸ / ×1 / ×2 / ×4), menu button. Map-mode switcher (normal/borders/culture) and the pan↔paint toggle as small floating buttons on the canvas edge.
* **Bottom dock:** tabs (`Tabs`) → horizontally scrollable row of tool buttons rendered from `ToolDefs` (icon from `Sprites.icon`, label), brush-size control (slider/steppers 1..8) shown for `brush:true` tools. Selected tool highlighted; tool hint text line.
  "Королевства" tab additionally shows a horizontally scrollable list of kingdom chips (flag, name, pop); tap → focus camera + open inspector. "Инфо" tab: inspect tool + buttons for world stats and full event log.
* **Event feed:** last ~4 log messages as translucent lines under the top bar, fading; tap opens the full scrollable log panel (color by `Log` kind; tap an entry with x,y → focus camera).
* **Inspector:** bottom sheet: unit (name, race, sex, age, hp bar, hunger, level/xp, traits, gear, state, city/kingdom, family, history), building, city (name, kingdom, pop, stock, buildings, loyalty, culture, history), kingdom (flag, ruler, capital, cities, pop, stability, culture, relations list with opinions/states, wars, history). Live-refreshes ~4×/s while open; has focus-camera + close buttons. Uses `Powers.pick`.
* **Menu:** modal: Save / Load (slots auto,1,2,3 with `Save.info`) / New world (size 64/96/128, seed, «Заселить» checkbox) / about. Toasts via `UI.toast(text)`.
* API: `UI.init()`, `UI.update(dtMs)` (cheap, called each frame), `UI.toast(text)`, `UI.state = {tab,tool,brush,mode}`, `UI.handleTap(tx,ty)`, `UI.handlePaint(tx,ty,phase)`, `UI.openInspector(type,id)`.
### Main (99_main.js)
Boot order: `Sprites.init(); Sim.newWorld({populate:true}) or Save.load('auto'); Render.init; Input.init; UI.init`. Fixed-step loop: accumulator at `1000/(Const.TICKS_PER_SEC*speed)` ms per tick, speed ∈ {0,1,2,4},
max 6 sim ticks per frame + time budget (~10 ms) then drop the backlog; `Render.draw(alpha)`; `Fx.update(dt)`; `UI.update`; autosave every 60 s real time; `visibilitychange` → pause + save. Exposes `window.__god = {S,Sim,World,Units,Cities,Kingdoms,Diplomacy,War,Powers,Render,Save,UI,Const,setSpeed,step}` for tests. Global `error` handler shows a small overlay.

## 5. Behaviour rules

### Tick order (Sim.step)
`S.tick++ → World.step → Buildings.step → Units.step → Cities.step → Kingdoms.step → Diplomacy.step → War.step → Powers.step`. Heavy modules stagger work internally.

### Units AI (utility-style state machine, `u.state` ∈ Const.STATES)
Think at most every `S.perf.thinkEvery` ticks (spread via `u.nextThink`); **movement runs every tick** (cheap). Priorities: (1) burning/danger/hostile near → flee or fight by traits/strength, (2) starving (hunger>75) → eat (withdraw `food` at home/dropoff, else forage berries/fish), (3) tired (energy<20) → sleep at home/nearest house (energy recovers; sleeping near enemies is interrupted),
(4) army membership (`u.armyId`) → state `army`: follow `S.armies.get(armyId).rally` with small formation jitter, fight hostiles within reach, in `mode==='siege'` hit enemy buildings (`Buildings.damage`), (5) job from `Cities.assignJob(u)` (children never work; elders light work): walk → work (`World.harvest`, `Buildings.work`) → carry to `Cities.dropoff` → `Cities.deposit`,
(6) mate: adult couple in same city, woman fertile age & `birthCd` passed & `Cities.housingFree>0` & city food OK → child spawned (`Units.spawn` with parent ids, inherits city/kingdom/clan, trait mix); chance scaled by `Races.fertility`, `Traits.mul(u,'fertility')`. (7) homeless adults: wander, `Cities.trySettle(u)` every few seconds, 'settle' expedition state (walk to `u.st.target`, on arrival `Cities.foundExpedition(u)`).
Ageing: death by old age after race lifespan (random in window); starvation (hunger=100 → hp drain); disease (`u.sick`: hp drain, spreads to units within 1.5 tiles with probability; recovery chance); burning; drowning/lava if terrain changes under them (they try to step to nearest walkable tile first); xp/level from kills & work.
Stats formula: `atk = (race.atk + Gear.weaponAtk[weapon]) * Traits.mul(u,'atk') * (1+0.08*(level-1)) * buff`; `dmg = max(1, atk*(0.8..1.2) - def*0.5)`; `def = race.def + Gear.armorDef[armor]`; melee reach `race.range`, elf with bow `Gear.range`. Attack cooldown ~8 ticks (ranged 12).

### Hostility `Units.isHostile(a,b)`
Same kingdom (non-zero) → never. Both have kingdoms → `Diplomacy.atWar(ka,kb)`. Otherwise (a wanderer is involved or both homeless): hostile if `Races.rel[a.race][b.race] <= -50` and a's aggression roll (race.aggression + `Traits` aggressive/brave − peaceful) passes — and never against children. Wild fights must be rare and local, not genocidal.

### Economy guidance (tune with tests, keep stable)
Hunger +0.12/tick, eating 1 food = −40 hunger; a farm worker yields ~1 food / 80 ticks; wood 1 per ~40 ticks; forests deplete; berries regrow. A starting group of 6 humans on grass near water/forest must found a village, build houses and grow to ≥ 20 pop in ≈ 10–15 game years (600–900 ticks), then colonise. Orcs grow slower, elves slowest. Starvation must shrink pop smoothly (no instant wipe-outs). Pop ≥ 1500 total is capped by `S.perf.unitCap`.

### Territory & politics (stage 2 detail lives in the stage-2 prompts; stage-1 stubs only need the API shape)
City borders: radius `Races.cityRadius + level`, tiles owned by nearest city centre. Kingdom = group of cities. First village of a race = capital; opinions −100..100 symmetric per kingdom pair; states PEACE/ALLIANCE/WAR.

## 6. Bus events (all optional to listen to)
`tileChanged(x,y,old,new)`, `unitBorn(u)`, `unitDied(u,cause,killer)`, `buildingDone(b)`, `buildingDestroyed(b,cause)`, `cityFounded(c)`, `cityDestroyed(c,cause)`, `cityCaptured(c,oldKid,newKid)`, `kingdomCreated(k)`, `kingdomDestroyed(k)`, `kingCrowned(k,u)`, `warDeclared(w)`, `warEnded(w,how)`, `allianceMade(a,b)`, `log(entry)`.

## 7. Definition of done (every module)
1. Implements the API above (extra helpers allowed) and the lifecycle hooks it needs. 2. Own `tests/<module>.test.mjs` passes (`node tests/<module>.test.mjs`) and `node build.mjs --check` stays green.
3. No exceptions over a 3000-tick headless run with 24 humans (+ orcs/elves where relevant); no NaN positions; no unbounded growth of arrays/Maps; per-tick cost measured and reported (ms/tick).
4. Short final report: what exists, deviations from this contract (also add them to docs/REQUESTS.md), known issues.
