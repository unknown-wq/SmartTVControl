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
node tests/power_volcano.test.mjs --perf [--seconds=10] [--seed=4] [--html=<other build>] [--control]   # full game A/B, two Chromium pages at once
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

## Numbers (this container, Node 22 / headless Chromium, software GL; the machine was shared with other agents: load average 8-11 on 4 cores, so every figure is pessimistic and noisy)

Headless (CPU time per tick, minimum of 3 identical replays of a deterministic 903-unit living world with 25 cities, three r=8 volcanoes):

| what | avg | p99 / worst |
|---|--:|--:|
| the tap itself (`Powers.apply`, builds the rise list, logs, scares) | 0.24 .. 0.55 ms | worst 0.43 .. 1.25 ms |
| plugin step while three r=8 cones rise (≤ 4 tile edits per tick) | 0.044 .. 0.055 ms | worst 0.34 .. 0.38 ms (whole sim tick worst 1.5 .. 3.4 ms) |
| plugin step during three eruptions | 0.016 .. 0.022 ms | p99 0.15 .. 0.17, worst 0.18 .. 0.26 ms (whole sim tick avg 0.74 .. 0.86 ms) |
| idle plugin (no volcano alive) | one `L.length === 0` test per tick | - |

Browser (390x844 @2x, plugin draw functions timed from inside the page; a whole eruption in view):

| view | plugin draw per frame |
|---|---|
| zoom 8, one eruption (13-unit test world) | +0.07 ms over the same frame without it (worst frame 2.3 ms) |
| zoom 14, one eruption | +0.01 .. 0.17 ms (worst frame 1.9 ms) |
| 1500-unit game, THREE eruptions around the biggest city, zoom 8 / 14 / 6 | 0.28 .. 0.54 ms (≈ 0.1 .. 0.18 ms per eruption), the first frame after a tap bakes ≤ 3 sprites (no hitch) |
