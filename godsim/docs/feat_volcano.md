# «Вулкан» (volcano) — god power plugin

Tool `volcano` (tab **Силы**, group **Разрушение**, brush = size of the cone, no drag). A plugin in the sense of `docs/CONTRACT.md` §10: nothing in
Powers / Sprites / Render / UI / Save / core was edited for it (see "Plumbing" at the end for the one question I have for the lead).

| file | what |
|---|---|
| `src/19_power_volcano.js` | sim plugin `PowerVolcano` (DOM-free; tool def, `apply`, `step`, `newWorld`, `afterLoad`) |
| `src/34_gfx_volcano.js` | graphics plugin `GfxVolcano` (14x14 icon, persistent effect `volcanoes`, custom Fx `volc_impact`) |
| `tests/power_volcano.test.mjs` | 17 headless sections + browser part (screenshots, draw cost, save/load, real touch tap) + opt-in `--perf` full-game A/B |
| `tests/fixtures/volcano_hooks.js` | two lines that expose `window.__volc` to the browser tests (appended with `build.mjs --extra=`; not part of the shipped game) |

## What the player sees

* **Tap** on the map (land or sea; the brush slider 1..8 sets the size): the ground trembles for ~60 ticks (shake pulses, dust, smoke, a red glow in
  the crater-to-be) while a **cone rises from the outside in** (foothills → slopes → rim; at most ~4 tiles change per tick; whatever was built on the
  footprint is destroyed, people nearby run away). In the last tick the **crater opens**: flash, big shake, first heavy burst.
* **Eruption**, 500..800 ticks: every 25..70 ticks the crater throws 3..8 **lava bombs** (arcs in the air with a glowing fireball, impact splash with
  sparks). A bomb hurts units within 1.3 tiles, damages buildings, ignites what burns, and leaves a **lava puddle** (60 %) that cools into rock.
  Between the bursts a **lava tongue** creeps downhill from a breach in the rim (~1 tile per 12 ticks, at most 40 live flow tiles, follows the lowest
  ground, stops at water, burns forest, razes buildings; the oldest flow tile cools first). Above the cone a **ash plume** rises and leans with the wind;
  ash flecks drift down; the crater glows (additive glow at close zoom).
* **Cooling**, 150 ticks: the plume fades, crater and lava turn to rock — the **extinct cone** stays (MOUNTAIN ring, HILL core). The entry is removed
  from `S.eff.volcanoes` and remembered in `S.mod.volcano.cones`.
* **Tap on a live volcano** (or on its extinct cone) makes it erupt again (a reopened extinct cone rumbles 30 ticks instead of 60). A cone that somebody
  flattened meanwhile is simply rebuilt from scratch.
* **Caps**: at most 3 live volcanoes — the 4th tap calms the OLDEST one down at once (toast «Старый вулкан затих — просыпается новый»). A volcano can rise from
  the sea (island with a shallow shelf); bombs that fall into water only splash.
* **Log** (only notable things): «Проснулся вулкан» / «Проснулся вулкан близ города «X»» (DISASTER, on the tap) and «Лава уничтожила город «X»» (once per
  city and volcano, when the town hall is gone and 3/4 of the buildings are; the city's history gets «Уничтожен извержением вулкана»). Toasts:
  «Вулкан просыпается!», «Вулкан извергается снова!», «Вулкан уже просыпается», «Вне карты».

### Cone geometry (pure function of the brush radius `r`; `PowerVolcano.geom(r)`)

Base radius `3 + r/2`, crater radius 1.1 (r 1..2) / 1.5 (r 3..5) / 2.05 (r 6..8). Elevation: crater floor 204, rim 232, MOUNTAIN down to 192 over the
first 62 % of the slope, then HILL foothills down to 164 at the foot (± 3 per-tile jitter). Final shape on flat grass (`tests` section 2, numbers from
`volc-geom-table`):

| r | base | crater | footprint tiles | MOUNTAIN | HILL | LAVA (crater) | peak elev |
|--:|--:|--:|--:|--:|--:|--:|--:|
| 1 | 3.5 | 1.1 | 37 | 16 | 16 | 5 | 227 |
| 2 | 4.0 | 1.1 | 49 | 21 | 23 | 5 | 228 |
| 3 | 4.5 | 1.5 | 69 | 28 | 32 | 9 | 224 |
| 4 | 5.0 | 1.5 | 81 | 34 | 38 | 9 | 226 |
| 5 | 5.5 | 1.5 | 97 | 39 | 49 | 9 | 227 |
| 6 | 6.0 | 2.05 | 113 | 53 | 47 | 13 | 231 |
| 7 | 6.5 | 2.05 | 137 | 56 | 68 | 13 | 231 |
| 8 | 7.0 | 2.05 | 149 | 71 | 65 | 13 | 231 |

## State (all JSON-safe, in `S.eff` / `S.mod` — nothing else is kept)

`S.eff.volcanoes` = array of entries (≤ 3):

```
{id, x, y (centre of the cone tile + .5), r (brush), rb (base radius), rc (crater radius), phase (0 rumble / 1 eruption / 2 cooling),
 t0 (tick it started), rum (rumble length), until (tick the current phase ends), t1, t2 (eruption / cooling start), next (next burst tick),
 nb (bursts so far), bl (bombs landed), lb (last burst tick), lbg (1 = that burst was the big opening one),
 bombs: [[sx, sy, tx, ty, launchTick, landTick, height] ...]       (<= 24 in flight)
 lav:   [tileIndex, coolTick, kind (0 bomb / 1 flow), elevBefore ...]  (4 numbers per tile, <= 56 tiles)
 cr:    [crater tile indices, outer first]    bs: [tile indices still to rise during the rumble, outer first]
 fa (flow azimuth), fn (next flow tick), fs (stalls), cc (crater tiles cooled), old (1 = woke an extinct cone), wd (wind -1..1),
 rs (the volcano's private PRNG state), cb: [cityId, buildingsBefore ...], lg: [cityIds already announced]}
```

`S.mod.volcano = {cones: [[cx, cy, r, tick] ...]}` (extinct cones, ≤ 24, oldest dropped). `afterLoad()` sanitises everything (NaN, wrong types,
out-of-range indices, too many entries) and survives garbage.

## How it touches the rest of the game (public APIs only)

* **World**: terrain only through `World.setTile(x, y, t, {elev})` (so shading / shore / `tileChanged` / building destruction on non-buildable tiles
  work as for brushes), fire through `World.ignite`. Lava tiles are real `T.LAVA`: World's own rules (units next to lava take damage, lava cools
  slowly by chance, wet lava turns to MOUNTAIN at once) keep working; the volcano puts a tile back if World cooled it before its schedule.
* **Buildings / Cities / Hist / Log**: `Buildings.destroy` / `damage(b, dmg, 0, 'volcano')`, `Log.add(..., LOG.DISASTER, x, y, kingdomId)`, `Hist.add`.
* **Units**: scared units use the same state a fire panic does (`Units.actFlee` walks to `st.tx/st.ty`); the nearest ≤ 40 civilians within `rb + 4..5` tiles run when it wakes (army members and expedition settlers keep their orders); a bomb
  hurts every unit within 1.3 tiles with `Units.damage(u, 22 .. 14 by distance, 'volcano')` and sets it burning (`u.burning`, 25 ticks). Every unit list is
  sorted (by id / distance) before anything order-dependent happens (the spatial grid order differs after a load).
* **Fx** (built-in types only, plus one custom): `shake`, `flash`, `dust`, `smoke`, `ash`, `splash`, and the plugin type `volc_impact`.
* **Randomness**: each volcano owns a mulberry32 stream (`e.rs`, seeded once from `R.int` when it is created), so its behaviour does not depend on how
  many other consumers draw from the global `R` between ticks (this is what makes save/load continuation identical, see below).

## Determinism and save / load (CONTRACT 10.2)

World rebuilds its fire / lava lists in tile-index order after a load, so its own random draws no longer line up with the original run (known; `save.test.mjs`
prints it as KNOWN ISSUE). The volcano is built so that this does not matter for what it owns: (1) private PRNG per volcano, (2) tracked lava tiles that
World's random cooling turned to rock early are put back (the schedule is the volcano's), the crater is re-asserted every tick, wet lava is solidified at
placement, (3) unit lists sorted. Test: save at tick 25 (rumble), 290 (bombs in the air, lava on the ground), 830 (cooling), load into a fresh sim,
continue 1200 ticks, compare `S.eff.volcanoes`, `S.mod.volcano` and the terrain of the arena every 50 ticks — identical; plus a living world with villages,
forest fires and fleeing people (800 ticks identical).

## Graphics (`src/34_gfx_volcano.js`)

Everything is baked once into small offscreen sprites and drawn with `drawImage` (no per-frame gradients, no per-pixel work):
puffs (smoke discs), crater halo and heat glow, cone shade, fire-fountain burst frames (big and small), impact splash frames. The persistent effect
`volcanoes` (drawn by Render after the Fx list, so it covers/uses the ground effects correctly) draws per volcano: shade → crater glow → ash plume
(ring of 22 puff slots, 12 below scale 10, leaning with the wind, rising with the eruption strength) → burst fountain → bomb arcs (shadow on the ground +
fireball) → ash flecks. Additive (`lighter`) glows only at scale ≥ 9 px/tile. Baking is limited to 3 sprites per frame (no hitch on the first tap).
Icon: 14x14 pixel art — grey smoke discs top right, 4-tone cone, lava crater and streams.

## Tests

```
node tests/power_volcano.test.mjs                  # headless (17 sections, ~10 s) + browser part (builds /tmp/godsim-volcano.html, screenshots)
node tests/power_volcano.test.mjs --nobrowser      # headless only
node tests/power_volcano.test.mjs --nohead         # browser part only (visual iteration);  --shots=<dir> (default /tmp/godsim-volcano-shots)
node tests/power_volcano.test.mjs --perf [--frames=240] [--reps=2] [--seed=4] [--world=<file>] [--html=<other build>] [--base=<build without the plugin>]   # whole-game cost, fixed work, CPU time (see Numbers)
```

Headless sections: registration + dispatch; cone geometry for every brush size (base, crater, elevation profile, MOUNTAIN/HILL bands, nothing outside
changes); outside-in rise (≤ 8 edits/tick, no lava before the crater opens, shake + dust + flash); lifecycle timings (rumble 60, eruption 500..800,
bursts 25..70 ticks apart, 3..8 bombs, cooling 150, entry removed, extinct cone, no lava left); bombs (units hurt and burning, buildings damaged,
flammables ignited, puddle left and cooled); water / caps / crater splash; lava flow (rate, direction, cap, oldest cools first; razes buildings and
forest, water stops it); footprint destruction + the one city log line + crater kills; people flee; caps / replacement / re-erupt / reopen; island
on the sea + flattened cone rebuilt; 3000 ticks mixed with every other power (no exceptions, caps hold, JSON-safe); garbage `afterLoad`; strict save/load
identity (rumble, eruption, cooling) and in a living world; CPU cost (see Numbers).

Browser part: tool button + icon, screenshots of rumble / blast / eruption / flow / cooling / extinct cone at zoom 8, 14 and 24
(`/tmp/godsim-volcano-shots`), pixel checks (glow, plume, bomb colours), draw cost with / without a volcano, save/load in the page, a real touch tap.

## Numbers (this container: Node 22 / headless Chromium 390x844 @2x with a SOFTWARE canvas; the box was shared with other agents, load average 8-15 on 4 cores)

Headless, CPU time per tick (minimum of 3 identical replays of a deterministic 903-unit living world with 25 cities and three r=8 volcanoes; range over three runs, quiet .. loaded box):

| what | avg | worst |
|---|--:|--:|
| the tap itself (`Powers.apply`; the cone is built over the next 60 ticks) | 0.24 .. 1.14 ms | 0.43 .. 2.9 ms |
| plugin step while three r=8 cones rise (<= 4 tile edits per tick) | 0.044 .. 0.065 ms | 0.34 .. 0.52 ms (whole sim tick worst 1.5 .. 6.6 ms) |
| plugin step during three eruptions | 0.016 .. 0.022 ms (p99 0.14 .. 0.17) | 0.18 .. 0.26 ms (whole sim tick avg 0.74 .. 0.86 ms) |
| idle plugin (no volcano alive) | one `L.length === 0` test per tick | - |

Whole game, `node tests/power_volcano.test.mjs --perf` (1471-unit world, 3 wars, x4; FIXED work per run = 120 warm-up + 240 frames, 2 ticks per 3 frames, synthetic clock, the canvas flushed
every frame, cost = renderer main-thread CPU time from CDP `ThreadTime`, median of 2 interleaved runs; wall-clock A / B runs were useless on the busy box: two IDENTICAL pages differed by +-50%).
Three volcanoes erupting around the biggest city (136 burning tiles, 1162 of 1473 units left), CPU ms per frame:

| scene | control | eruptions | what the eruptions do to the world (fires, lava, territory) | the plugin's drawing (incl. the software rasteriser) | plugin JS draw time, median / p90 |
|---|--:|--:|--:|--:|--:|
| whole map | 8.56 | 11.12 | +2.04 | +0.52 (0.17 per eruption) | 0.10 / 0.30 ms |
| whole map, political | 9.73 | 13.35 | +3.12 | +0.49 | 0.10 / 0.20 ms |
| zoom 8 political | 10.19 | 14.13 | +2.19 | +1.75 (0.58 per eruption) | 0.20 / 0.30 ms |
| zoom 14 city | 5.86 | 10.35 | +1.66 | +2.83 (0.94 per eruption) | 0.20 / 0.30 ms |
| zoom 6 culture | 14.56 | 18.96 | +2.88 | +1.51 (0.50 per eruption) | 0.20 / 0.30 ms |

* The plugin's own JS work is <= 0.2 ms per frame for all three eruptions (budget 0.6 per eruption). A software canvas rasterises lazily and pays for every translucent pixel, so the
  drawing costs ~1 ms per eruption at zoom 14 in this headless run; on a GPU canvas (iPhone) that part is off the main thread. The plume (a column of overlapping smoke puffs) was ~80% of it; its slots are
  packed toward the base (`(slot / N) ^ 1.5`, 18 slots) which keeps the dense body and costs 32% fewer pixels than the first version (22 uniform slots; 3.9 -> 3.0 ms at zoom 14).
* "World" is what a burning forest, lava tiles and fleeing people cost the existing machinery (Render's terrain repaints, flames, scorch decals, overlay rebuilds; sim +0.2..0.4 ms per tick).
  It is not draw code of the plugin. With the political / culture overlay on, part of it is the Cities lava rule (see REQUESTS below).
* IDLE plugin vs a build of the previous commit without it (`--base=`), same world, control runs: ratio 0.975 / 0.977 / 0.979 / 0.983 / 0.948 on the five scenes (no regression; the difference is noise).
* Every `tests/perf.mjs` / `tests/fxperf.mjs` scene is unaffected while no volcano exists (no per-frame work, no per-tick work beyond the empty-list test); I did NOT re-run those two suites after the last
  tuning (coordinator's request); `fxperf.mjs` printed one cold-start threshold failure (22.8 ms vs 12 ms) while the box ran at load 13, `plugins.test.mjs` fails its «flash paints the canvas» pixel threshold
  (239 vs > 240) on the pristine base commit too.

## For the lead (merge into the shared docs)

### STATUS.md, suggested text (section "God powers (plugins)")
* **Вулкан (volcano)**: plugin power (`src/19_power_volcano.js`, `src/34_gfx_volcano.js`, `docs/feat_volcano.md`). A tap raises a cone from the outside in (rumble 60 ticks, buildings on the footprint destroyed, people flee),
  the crater opens and erupts for 500..800 ticks (lava bombs every 25..70 ticks hurt units, damage buildings, ignite forests; a lava tongue creeps downhill <= 40 live tiles and razes what it meets), then cools into an extinct
  cone (a tap on it re-erupts). <= 3 live volcanoes, the 4th replaces the oldest. State only in `S.eff.volcanoes` / `S.mod.volcano`, save / load continues IDENTICALLY (private PRNG per volcano). Plugin step 0.02 ms per tick
  (worst 0.26), plugin JS draw <= 0.2 ms per frame for three eruptions. Tests: `node tests/power_volcano.test.mjs` (17 headless + 13 browser), `--perf` for the whole-game cost.

### REQUESTS.md, suggested lines
* [from Volcano -> Cities (06_cities.js) / Regions (14_regions.js)] **Lava is non-land for territory in Cities (`Tiles.isLand`) but land in Regions (`isLandT` = anything except DEEP / SHALLOW).** Every lava tile inside a city's
  sphere releases its owner (`S.owner[i] = 0`, `S.ownerVer++`) and reclaims it when it cools, so a volcano (or the lava brush) next to a city makes Render rebuild the political / culture overlay (~30 ms in software GL,
  throttled to one per 150 ms) all the time: measured on the same world (counters, deterministic), `ownerVer` bumps in 10 s 80 -> 2..3 and political rebuilds 31 -> 2..3 with the change below; the frame cost of the overlay scenes dropped from 1.15 / 1.88 / 1.76 x
  the control (whole-map political / zoom 8 political / culture, early wall-clock A / B, noisy) to about 1.0-1.1 x in the same kind of run. Proposed patch (4 lines, validated: `cities.test` 32/32, `regions.test` 20/20, `war.test --quick` 20/20): add
  `const ownable = (t) => t !== T.DEEP && t !== T.SHALLOW;` next to the other helpers of 06_cities.js and use it instead of `Tiles.isLand(...)` in `recomputeTerritory` (`inside` test and the release condition) and in the `tileChanged`
  handler (`ownable(o) === ownable(n)`). NOT applied by me (not my module).
* [from Volcano -> tests/plugins.test.mjs] The check «built-in full-screen flash (Fx type flash) paints the canvas» needs a pixel > 240 two frames after the call; it reads 229..239 on the pristine base commit as well (the flash
  fades in those two frames, more so under load). Suggest `> 220`.
* [from Volcano -> World] After a load World rebuilds its fire / lava lists in tile-index order, so its own random fire / lava-cooling draws differ from the uninterrupted run (already printed as KNOWN ISSUE by `save.test.mjs`).
  The volcano does not depend on it (own PRNG, lava schedule re-asserted); other plugins that draw from `R` between ticks will see the same drift.
* [from Volcano -> Render] Observation, no action: the cost of a translucent sprite is mostly paid at the (lazy) raster flush, not in `Render.stats.drawMs`; the JS timings of `perf.mjs` / `fxperf.mjs` do not see it.
  `--perf` of the volcano test measures it with `ThreadTime` + a 1 px `getImageData` flush per frame (a reusable recipe for load-proof frame-cost A / B tests).

### Merge notes
* My branch was based on an old main without `godsim/`; I fast-forwarded it to your 36e3f75 (`git merge --ff-only claude/relaxed-keller-n4fq7q`), so the 5 commits sit directly on top of it. Files touched: only the 5 new ones listed at the top
  (nothing in shared / core / generated files; `godsim/index.html` is not committed).
* `tests/fixtures/volcano_hooks.js` is only used with `build.mjs --extra=`; it is not part of the shipped game.

## Known issues
* Eruptions near a city with the political / culture overlay on rebuild the overlay far more often than needed until the Cities patch above is applied.
* An eruption in a forest starts large fires (136 burning tiles in the test world); they are World's normal fire rules (the flammables of the cone's surroundings are ignited by bombs and by the lava tongue), and every burning tile costs Render flames,
  scorch decals and terrain repaints. Grass catches fire with 20% (forest 85%) to keep that bounded; tell me if you want a global knob.
* The lava tongue steps to one of the 4 neighbours of its newest tiles, always away from the crater (within 11 tiles of the cone), preferring low ground and its azimuth; it never enters water or a tile next to water, and when it finds no
  way it picks another azimuth and waits 12 (later 40) ticks (`fs` counts the stalls), so on a basin it simply stops and cools.
* Units on a tile that turns into LAVA take World's 40 damage (as for the lava brush); fleeing people are sent to a safe spot but can still be caught by a bomb.
* The browser test uses a small hand-built world (13 units); the whole-game cost is measured only by the opt-in `--perf`.
