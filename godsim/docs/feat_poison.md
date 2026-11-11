# God power «Яд» (poison cloud)

A CONTRACT §10 power plugin: drifting toxic clouds that poison, hurt and drive away the living, wither forests, berries and fields, and are washed out by rain.
Tool `poison` (Силы / Разрушение, short label «Яд», icon `poison` = a skull flask), `brush: true` (radius 1..8 = cloud size), `drag: true` (spray).

## What the player sees

* **Tap** = one cloud of radius `r + 1` (brush 3 -> 4 tiles), density 1, ~600 ticks (60 s at x1). A pale flash, a violet shock ring and droplets pop out of the tap point.
* **Drag** (brush mode) = a trail of smaller puffs (radius `0.55 r + 0.5`, density 0.6, ~420 ticks). The first move of a stroke turns the stroke's start cloud into a normal puff (a pure tap stays a big cloud). A lingering finger thickens the puff under it, puffs that land on each other add their densities (cap 1.6), at most **14 live clouds** (the one that would end first is dropped).
* **The cloud** drifts slowly (a wind vector re-rolled every 150-300 ticks, bounces at the map edge), spreads (radius up to +40 %) and thins out (`density = d0 (1-p)^0.75`) until it vanishes. Rain over it washes it out three times faster.
* **Units** inside a cloud get the status *Отравлен* (violet-tinted sprite, green bubbles above them, red chip in the unit card, state label «Убегает»): civilians run to a spot outside every cloud and do not walk back into it while it is there; soldiers keep their orders and suffer. Poison is **not contagious**; the healing power (Исцеление) is the antidote.
* **Ecology**: forests thin out and die into grass, lone trees and berries wither (a bush in the dense heart dies for good), farms lose hp and are destroyed under a dense cloud (their workers are poisoned like everybody else).
* **Chronicle** (never one line per victim): «Король X («К») отравлен ядовитым облаком» for a killed ruler, «Ядовитое облако у «Город» рассеялось: погибло N» when a cloud killed >= 4. A pale skull wisp rises from each victim (<= one per 2 ticks).
* Feedback of a tap is the burst fx; `Powers.lastMessage` = «Ядовитое облако» (the UI only toasts failures, like for every other power).

## Files

| file | contents |
|---|---|
| `src/17_power_poison.js` | `PowerPoison`: tool registration, `apply`, `step`, lifecycle, all rules (DOM-free, loaded by the node harness and the build) |
| `src/32_gfx_poison.js` | `GfxPoison`: icon, fx `poison_burst` / `poison_soul`, the cloud effect (`GfxPlugins.addEffect({key:'clouds'})`), unit tint + badge (browser build only) |
| `tests/power_poison.test.mjs` | headless suite (22 sections) + browser part (5 sections, screenshots in `/tmp/godsim-poison-shots`) |
| `tests/power_poison_perf.mjs` | frame-cost comparison on the `tests/perf.mjs` scenes for any build, with N clouds in view |
| `src/11_powers.js` | **ONE line** in `healTool`: `... || u.poison > S.tick; if (u.poison) u.poison = 0;` (the antidote; a poisoned unit with full hp counts as healed) |
| `tests/ui.test.mjs` | the powers tab count is no longer a fixed 9: it must equal `ToolDefs` and be >= 9 (plugin powers add buttons) |

No other shared file (Units, World, Sprites, Render, UI, Save, core) was touched. Everything the plugin needed was reachable through public APIs (`Units.nearby / damage / stage`, `World.harvest / sameLand / walkable`, `Buildings.get / damage`, `Powers.host`).

## State and API

```
S.eff.clouds  [{id, x, y, r, r0, dens, d0, t0, until, dx, dy, nt, k, f}]   <= 14, JSON-safe, saved (Save keeps unknown S.eff arrays)
S.mod.poison  {nid, vic}                                                  cloud id counter, victims so far
u.poison      tick until which the unit is poisoned (0 = healthy); EVERY unit has the field
```

* `u.poison` exists on every unit (set by a `unitBorn` listener, by `afterLoad` and by the 8-tick damage pass). **This matters for performance**: `Save.packTable` builds a *ragged* table when only some units have a key, and a ragged table is loaded through the slow key-by-key path (the "3.5x slower Units.step after a load" trap documented in `13_save.js`). With a uniform field the units table stays flat (tested: `JSON.parse(Save.serialize()).units.m === undefined`, also after loading an old save without the field).
* `r`, `dens` are the current values (recomputed every tick from `r0`, `d0`, `t0`, `until`); the renderer only reads `x, y, r, r0, dens, id`. `k` = victims (chronicle), `f` = `tick + 1` of a fresh tap cloud (stroke-start conversion).
* Public helpers (tests / graphics): `PowerPoison.addCloud(x, y, r, dens, life)`, `densityAt(x, y)`, `densOf(cloud, tick)`, `count()`, `cfg` (all tunables).
* Randomness: only `R`, only when something happens (new cloud, wind turn, a dead bush). Worlds without poison keep their RNG stream. Save/load mid-cloud continues identically (tested through `Save.serialize` -> fresh context -> 400 ticks, comparing clouds, every unit's position / hp / poison / state, tiles, buildings and the RNG state).

## Rules and numbers (`PowerPoison.cfg`)

| rule | value |
|---|---|
| exposure pass | every 5 ticks (`Units.nearby` around each cloud, radius `r + 4.5`): a unit with local density `dens (1 - 0.5 d²/r²) >= 0.1` gets `u.poison = tick + 120` |
| damage pass | every 8 ticks over every poisoned unit: `(0.7 · taper + 1.3 · densityHere) · vuln`, `taper = remaining/120` (the lingering poison fades), cause `'poison'` |
| vulnerability | child ×1.15, elder ×1.2, sickly ×1.2, strong ×0.85 (races differ through their hp: orc 30, human 20, elf 16) |
| flight | state `flee` (`u.st = {ph:'go', tx, ty, rg:0.8, until, pz:1}`), target ≥ 3.5 tiles beyond the cloud edge on the same landmass and outside every cloud; skipped for soldiers (`u.armyId`) and units that are `flee` / `settle` / `mate` / `fight`; at most 64 starts per scan, lowest unit ids first |
| avoidance | a civilian whose destination (`st.tx, st.ty`) lies inside a cloud and who is within `r + 4.5` of it goes idle for 50-90 ticks (not when starving, not on the way to bed, not soldiers) |
| ecology | every 10 ticks per cloud, tiles inside with local density ≥ 0.12: forest `World.harvest(1 + round(2 dl))` wood, lone trees ×2, berries ×3 (an empty bush at `dl > 0.45` dies with 20 %), farms `Buildings.damage(0.9 dl)` (farms never repair while hit) |
| rain | a cloud overlapped by an active rain ages 3x faster |
| clouds | cap 14; tap life 600 / density 1; spray life 420 / density 0.6; density cap 1.6; initial radius cap 10; spread +40 %; wind 0.003-0.012 tiles/tick |

### Damage per life stage (measured, `tests/power_poison.test.mjs`)

Trapped in the middle of a cloud (an island, cannot flee), ticks until death at density 1 / 0.6 / 0.3:

| unit | hp | dens 1 | dens 0.6 | dens 0.3 |
|---|---|---|---|---|
| human adult | 20 | 104 | 144 | 208 |
| human strong | 24 | 152 | 232 | 352 |
| human sickly | 16 | 64 | 88 | 120 |
| human child (8 y) | 15 | 64 | 88 | 128 |
| human elder (51 y) | 20 | 80 | 112 | 160 |
| elf adult | 16 | 80 | 112 | 152 |
| orc adult | 30 | 168 | 248 | 392 |

A *brief exposure* (free to flee, standing in the middle of a density-1 cloud of radius 4): lowest hp reached = adult 72 %, strong 83 %, sickly 51 %, child 26 %, elder 59 %, elf 61 %, orc 85 %; at the cloud's edge an adult keeps 81 %; in a huge cloud (radius 9) an adult drops to ~50 %, a child dies. A lingering poison without any further exposure costs a healthy adult ~4 hp over its 120 ticks (10 hits, the first 0.65, the last 0.23) and never kills one.

## Graphics (`src/32_gfx_poison.js`)

Pixel art in the style of the game (chunky pixels, dark outlines, light from the top-left), all baked lazily, nothing allocated per frame:

* **Zone haze**: a stippled green disc with violet spores and a dashed violet/lime rim, exactly the radius where the poison acts (one `drawImage`; a 48 px version below 9 device px per tile).
* **Cloud body**: ONE baked sprite per cloud: many puffs of mixed sizes (a few big, many medium and small) on a golden-angle spiral, painted back to front, cel-shaded (5 tones, ordered dithering), only the silhouette of the whole mass outlined in violet, translucent fill (per-pixel alpha). 8 radius buckets (1.4 .. 12.5 tiles, the bucket of the cloud's initial radius, scaled to its current one) × 2 layouts × 4 "boiling" frames (3.8 fps) × 2 density levels (full / thin: fewer, smaller puffs). One body is baked per frame at most (0.2-0.6 ms of JS in node; all 128 bodies = ~7 MB if every one were ever used, a test session bakes 21).
* Rising **bubbles** (3-12 per cloud, zoom ≥ 11 px/tile) and an occasional **skull wisp** (every 6-9 s per cloud), small green **bubbles above poisoned units** (≤ 40 units, drawn once per frame by the first cloud of that frame).
* Unit tint `rgba(150,70,210,0.5)` (violet; the disease tint is green) and the `Отравлен` chip via `UIPlugins.unitBadges`.
* Draw budget: ≤ ~15 `drawImage` per cloud (+ 2 per poisoned unit in view); measured in Chromium with software GL: 14 clouds in view add 0.3-0.4 ms per frame at zoom 8 / 14, one cloud 0.1-0.2 ms (see Performance).
* `window.__poisonGfx = {drawCloud, buckets, stats()}` is a test / debug hook (the tests read the baked-sprite stats from it).

## Tests

```
node tests/power_poison.test.mjs [--nobrowser] [--shots=/tmp/godsim-poison-shots]      # 22 headless + 5 browser sections
node tests/power_poison_perf.mjs [--micro] [--html=<build>] [--clouds=14] [--world=/tmp/w.json]  # frame cost on the tests/perf.mjs scenes
```

Before / after comparison (what the Performance table was made with): extract the original sources (`git archive 36e3f75 godsim | tar -x -C /tmp/base`), `node build.mjs --out=/tmp/base.html` there, then run `node tests/power_poison_perf.mjs --micro --world=/tmp/w.json --html=/tmp/base.html` (the first run creates and saves the world, later runs load the same save), the same with `--html=` omitted (current sources) and `--clouds=0` / `--clouds=14`. Without `--micro` the script measures like `tests/perf.mjs` (x4, real time) and prints the machine-wide CPU busy percentage per scene so disturbed runs are recognisable.

Headless: registration and dispatch; tap / spray / merge / the 14-cloud cap (400-move wild stroke); stroke-start conversion; drift + spread + decay lifetime and the edge bounce; damage per life stage (trapped and free); lingering tail without contagion; antidote through `Powers.heal`; ecology (forest, lone trees, berries, farms inside vs outside); flight (targets outside every cloud, ≥ 75 % out after 190 ticks); soldiers keep `state 'army'` and their rally point while being poisoned and hurt; avoidance; rain; chronicle (one line per dead ruler, one summary per cloud); 3000-tick chaos with every power (cap, finite fields, no stuck clouds / poisoned units); save/load continuation; the unit shape; plugin cost; stubbed neighbours; graphics smoke test with a fake DOM (draw-call budget, finite arguments, steady-state allocation, bake cost).

Browser (390×844 @2x, real touch): the dock button and icon, a tap and a brush-mode stroke through the real input, the unit card chip and the antidote, zoom 8 / 14 / 24 screenshots, the draw cost with 14 clouds.

## Performance

Measured in this container (Node 22, headless Chromium with software GL, 390×844 @2×). The 4-core box was shared with other agents the whole time (load average 8-13, "machine busy" 90-100 %), so wall-clock averages are meaningless (the same untouched build varied 3x between runs). The browser comparison therefore uses `tests/power_poison_perf.mjs --micro`: the page's own loops are frozen, then 200 single `Render.draw` calls and 200 single `Sim.step` ticks are timed per scene on the SAME saved world (1476 units, 3 wars, tick 12740) in every build, and the minimum / 10th percentile are reported (short calls often fit into one scheduler slice, so low percentiles approximate the quiet-machine cost). Two interleaved rounds, best of both:

| scene | `Render.draw` original (min / p10) | mine, no clouds | mine, 14 clouds in view |
|---|---|---|---|
| whole map | 1.30 / 1.40 ms | 1.30 / 1.50 | 1.40 / 1.50 |
| whole, political | 1.60 / 1.70 | 1.60 / 1.80 | 1.60 / 1.80 |
| zoom 8 political | 2.50 / 2.70 | 2.60 / 2.80 | 2.70 / 2.90 |
| zoom 14 city | 1.30 / 1.40 | 1.20 / 1.40 | 1.60 / 1.70 |
| zoom 6 culture | 2.90 / 3.10 | 3.10 / 3.40 | 3.10 / 3.20 |

* **No clouds** (what a player has 99 % of the time): within noise of the original on every scene (min: 0, 0, +4, -8, +7 %), `Sim.step` identical (min 0.4-0.5, p10 0.5-0.6 ms in both). The plugin's own tick cost is 0.0012-0.0021 ms in node (a field check over the units every 8 ticks), 0.002-0.014 ms in the browser sim profile (`Powers` EMA).
* **14 clouds in view** (each one longer-lived than a real one, with the sim running them: exposure scans, damage, ecology, fleeing crowds): at most +0.3 ms per frame (zoom 14); in the software-GL test of `power_poison.test.mjs` 14 clouds add 0.3-0.4 ms at zoom 8 / 14, a single cloud 0.1-0.2 ms (budget: ≤ 0.4 ms per cloud, ≤ 1.5 ms for 14).
* `node tests/perf.mjs` (official, 1500 units, 3 wars, x4): all 4 checks pass even under that load (sim ≤ 3.1 ms/tick, whole frame ≤ 15.1 ms, ≥ 31 ticks/s). `node tests/fxperf.mjs`: 9/9 (the first run under load failed two timing checks of the *built-in* Fx whose own "Fx off" baseline was already 3x its quiet value; passes on rerun).
* **Sim, plugin step** (`tests/power_poison.test.mjs`, ~600 units): 14 clouds, steady state avg 0.01-0.09 ms per tick, p99 ≤ 0.07 ms; the artificial worst case of 14 clouds landing on ~900 units at once costs one 6-25 ms tick (cold code, spread over scans by the flee budget), one tap on a dense crowd of 150-300 units 0.06-4 ms in its worst tick (the contract's one-off budget is 8 ms).
* Memory: the cloud bodies are baked lazily, one per frame; a test session bakes 21 of the 128 possible ones (~0.7 MB), all 128 would be ~7 MB.
* The existing timing assertions of `tests/powers.test.mjs` ("performance: 600 ticks with every power active": `Powers.step` p99 < 4 ms, meteor impact < 30 ms) flake on this overloaded box for the **original** sources too (1 of 3 runs failed on the untouched base at the same moment); with and without my plugin step the per-tick medians are identical (0.009-0.028 ms).

## Known limits / ideas

* A cloud parked on a village makes its civilians wait outside for its whole life (by design: they "try to leave"); soldiers do not retreat (they keep their orders by the brief) and can die in the cloud.
* The UI toasts only failed actions, so the success text «Ядовитое облако» lives in `Powers.lastMessage` only; the visual feedback is the burst fx.
* Very long strokes lose their start (14-cloud cap, the cloud that ends first is dropped).
* Poison over water or mountains has no ecology effect (nothing grows there) but still poisons whoever stands there.
* Tornados do not scatter clouds (rain is the only counter-play besides healing); possible extension.
* The translucent body dims units inside it; their violet tint, hp bars and the bubbles above them stay readable.
* Per-victim death texts for rulers are the generic Units ones («погиб»); the poison chronicle line adds the cause.

## For the lead (merge notes)

* New globals: `PowerPoison` (17), `GfxPoison` (32); `S.eff.clouds`, `S.mod.poison`, `u.poison`; GfxPlugins effect key `clouds`; Fx types `poison_burst`, `poison_soul`; icon key `poison`; `window.__poisonGfx`.
* Shared files touched: `src/11_powers.js` (one line, see above), `tests/ui.test.mjs` (line ~105 / ~109: the powers tab button count is dynamic; **every power agent needs the same change, expect a trivial conflict there**).
* Proposed `docs/STATUS.md` section («God powers»): *Яд: drifting toxic clouds (tap = cloud, drag = trail, ≤ 14 live), poison status with tail damage that depends on life stage and race, civilians flee and avoid, soldiers do not, forests / berries / farms wither, rain washes the poison out, Исцеление is the antidote; `docs/feat_poison.md`, `tests/power_poison.test.mjs`.*
* Proposed `docs/REQUESTS.md` line: *[from Poison → Units] none needed: flight and avoidance use the public `u.state / u.st / u.job` fields like `Powers.tornado`'s `fling`; every unit carries `u.poison` (a ragged save table is a perf trap, see feat_poison.md). [from Poison → Save/UI] the UI could toast successful power messages (`Powers.lastMessage`) for non-visual tools; not needed by poison.*
