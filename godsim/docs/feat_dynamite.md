# God power «Динамит» (dynamite)

Tool id `dynamite`, tab «Силы», new group «Арсенал» (inserted after «Разрушение»), name/short «Динамит», icon `dynamite`, `brush: true` (radius slider 1..8 = size of the charge), `drag: true`.
Plugin files (CONTRACT section 10): `src/15_power_dynamite.js` (sim), `src/30_gfx_dynamite.js` (graphics), `tests/power_dynamite.test.mjs` (headless),
`tests/power_dynamite_visual.mjs` + `tests/fixtures/dynamite_probe.js` (browser). No core / Powers / Sprites / Render / UI / Save file was edited.

## How it plays

* **Tap** lays one bundle (3 / 5 / 7 sticks for brush 1-2 / 3-5 / 6-8). The fuse burns **30 ticks** (3 s at ×1): sparks run up the fuse, it burns down, the bundle blinks in the last 1.4 s
  and a dashed red ring (damage radius) with a dotted yellow ring (lethal core) shows what is about to blow (last 1.2 s). A freshly laid bundle (and the head of a line) shows the ring for a moment too:
  the UI's brush preview circle is the *brush* radius, the real blast radius is `1.6 + 0.4·r` tiles (r = 1..8 → 2.0 … 4.8).
* **Drag** (brush mode) lays a line of bundles, one per 1.3 tiles of finger travel (≤ 12 per call, ≤ **40 per stroke**, ≤ **80 live** in the world). The charges of a stroke are **wired** (a cord is drawn between them):
  the first one burns the fuse, every next one goes off **2-4 ticks after its predecessor** — a running bang-bang-bang chain along the line. The whole schedule is written into the charges when they are laid.
* **Chain reaction**: a live charge of *another* stroke inside a blast goes off 2-3 ticks later (charges of the same wire follow their wire, so a dense line keeps its rhythm).
  A predecessor that goes off *early* (hit by another stroke) pulls the rest of its wire along: successor = bang tick + 2..4.
* Feedback: toast «Динамит заложен» (once per stroke), camera shake scaled by size, scars that stay for 1500 ticks (2.5 minutes at ×1, ≤ 48 alive), **one** chronicle line per stroke when it mattered
  («Цепь взрывов у «X» (погибло: 12, разрушено построек: 7) — убит король «Y»»; never one line per victim; a destroyed town hall / city / killed ruler are also reported by the existing modules).
* Refusals explain themselves once per stroke: outside the map, 80 live, 40 per stroke, lava («В лаве динамит сгорает»), a bundle already lies there.

## The blast (`R = 1.6 + 0.4·r`, core `0.42 R`, inner zone `0.72 R`)

| target | rule |
|---|---|
| creatures | `d <= core`: killed. Outside: `5 + 55·f^1.5` damage with `f = 1 - (d-core)/(R-core)` (r=3: humans die up to 2.0 tiles, orcs up to 1.8, elves up to 2.1; the rim only hurts). Survivors within `0.6 R` burn for 2 s. Cause `'dynamite'`. Everything is processed in unit-id order |
| knock-back | survivors are thrown away from the centre `0.5 + 1.0·(1-d/R)` tiles over 6 ticks (decaying speed, stops at water / walls), idle + stunned for 9 ticks (armies and settlers keep their orders). State in `S.mod.dynamite.kb` |
| buildings | `d <= core`: destroyed. Outside: `20 + 230·(1-t)^1.4` damage (house 40 hp, storage 70, barracks 130, temple 140, **town hall 220**: only just outside the core). Destruction goes through `Buildings.damage` so rubble marks, `buildingDestroyed`, the «Ратуша … разрушена» line and the rebuild rules of Cities all apply |
| forest | inner zone: FOREST → GRASS (`World.setTile`) |
| rock («взрывные работы») | inner zone, one step, dithered rim: SNOW → MOUNTAIN → HILL → GRASS (a second blast takes the next step) |
| ore | ROCK / IRON / GOLD veins in the inner zone are blown apart; the city that owns the tile gets stone `12 %` / iron `10 %` / gold `8 %` of the vein (`Cities.deposit`), an icon pops out (`dyn_ore`, ≤ 4 per blast). Outside every territory the vein is just destroyed |
| lone trees / berries | destroyed in the inner zone (trees also 50 % in the outer ring) |
| fire | 25 % of the flammable tiles within `R + 0.5` catch fire (`World.ignite`; the base game spreads it) |
| water / lava | splashes only (≤ 3 `splash` fx), never edited |

## State (JSON-safe, saved with the world)

* `S.eff.dynamite = [{id, x, y, r, t0, boom, g, pv, wx, wy}]` — live charges: `boom` = tick it goes off, `g` = stroke id, `pv` = id of the charge it is wired to (0 = head / burnt), `wx,wy` = that charge's position (for the cord).
* `S.eff.dynamite_scars = [{x, y, r, t0}]` — cosmetic blast scars (≤ 48, 1500 ticks).
* `S.mod.dynamite = {n, g, cnt, last, lx, ly, told, tal, kb, stat}` — stroke bookkeeping, per-stroke chronicle tallies, creatures in flight, counters (`stat.laid/boom/dead/razed/felled/quarried/ore`).
* All randomness through `R`; creatures are processed in id order, so the continuation after `Save.deserialize` is bit-identical (tested mid-fuse with the whole chain, and mid-chain with creatures in flight).
  `afterLoad` drops malformed entries and clamps every fuse (no immortal charges). `step` is a no-op when nothing is live.

## Graphics (`src/30_gfx_dynamite.js`, everything cached, no DOM at load time)

* icon `dynamite` (14×14: three red sticks with gaps, tan band, curling fuse + spark; icon palette + the automatic outline); fx `dyn_blast` (the explosion), `dyn_ore` (rising stone / iron / gold icon over a quarried vein);
  effects `dynamite` (bundles, cords, rings) and `dynamite_scars`; Bus `dynamiteLaid` → `UI.toast` (the UI only toasts *failures* of `Powers.apply`, so the success text of the contract is shown from here).
* Bundles: 3 sizes × 4 fuse stages × 5 spark frames × normal / blink, baked once, 1 `drawImage` each; far away (zoom < 7) a charge is a blinking dot.
  The cord between two wired charges is a **baked rope texture** stretched and rotated by one transform (a spark glints along it while it is hot) and trimmed so it only shows between the bundles:
  path strokes cost ≈ 1.3 ms per frame for 80 cords in a 1500-unit scene, the baked rope ≈ 0.2 ms.
* Explosion `dyn_blast`: 12 frames × 4 radius buckets × 2 variants, trimmed to their content, baked lazily **one per rendered frame** (shared token) and warmed in the background as soon as a charge of that
  size is on screen (the first bang of a size never hitches): white flash core + star, ragged fireball (built-in explosion palette), shock ring, dust ring, hot sparks, 3×3 / 4×4 debris on arcs, smoke cloud.
  One `drawImage` per bang. The built-in procedural `explosion` fx (≈ 60 `fillRect` per frame and per bang) was not reused: a 40-charge chain at ×4 has 10-20 bangs alive at once
  (12 built-in explosions in view: +1.4 ms at zoom 8 / +0.8 ms at zoom 14, 12 baked ones: +0.13 / +0.05 ms).
* Scars: soot crater with a dirt lip, rays and rubble, 4 radius buckets × 3 variants (trimmed canvases), fade over their second half.
* Fx budget per bang: one `dyn_blast`, one `shake` (global), ≤ 2 `smoke` (none at `S.perf.lod >= 2`; `lod` only ever trims this cosmetic part), ≤ 3 `splash`, ≤ 2 `fire`, ≤ 4 `dyn_ore`.

## Tests

`node tests/power_dynamite.test.mjs [--quick] [--only=<part of a section name>] [--seed=N]` — 24 sections, ~10 s: registration, fuse timing, refusals, Bus event, creature falloff for 3 races, knock-back, buildings, terrain steps, trees / berries,
ore → city stock, fire share, drag line wiring (spacing / gaps / order), slow strokes, chain reaction, wire acceleration, caps, big finger jumps, chronicle, a killed ruler, garbage in `S.eff` / `S.mod`, terrain change under a live charge,
3000 ticks mixed with every other power (bounded + JSON-safe state), save / load mid-fuse and mid-chain (identical continuation), performance.

`node tests/power_dynamite_visual.mjs [--zooms=8,14,24] [--perf] [--shots=/tmp/godsim-dynamite-shots] [--nobuild]` — builds the real game with `tests/fixtures/dynamite_probe.js` into `/tmp/godsim-dynamite.html`
(never `index.html`), checks the dock button / icon / group label / hint, a real touch tap and finger drag (toast), staged scenes at zoom 8 / 14 / 24 with hand-aged Fx
(laid → fuse → armed rings → bang frames → chain → aftermath; PNG crops and montages in `/tmp/godsim-dynamite-shots`), forest felling + quarry with ore pops and the city's stock, draw counters, no page errors; `--perf` adds the draw-cost A/B.

### Numbers (this machine: 4 shared cores, load average 8-11, software GL; iPhone numbers are better)

* Sim, headless (1500-unit world): `step` with 80 live charges **4.9 µs/tick** (budget 300 µs); a 40-charge r=8 chain through a city: `Powers.step` average **0.055 ms** over the 214 ticks it lasts,
  worst tick 4.1 ms (several r=8 bangs on one tick: 156 creatures killed, 62 buildings razed); one r=8 blast over the densest spot (169 creatures in range): 0.34 ms.
* Draw, browser, 1500 units, zoom 8 / 14, median per frame of `Render.draw` with vs without the plugin (alternating frames, so load drift hits both alike) and JS time inside the plugin's draw functions:

  | scene in view | zoom 8: Render.draw delta / plugin JS | zoom 14: Render.draw delta / plugin JS |
  |---|---|---|
  | 40-charge chain half way (20 live, 6 armed, 20 scars, 6 bangs) | +0.20 ms / 0.20 ms | +0.20 ms / 0.20 ms |
  | everything at its cap (80 live, 24 armed, 48 scars, 12 bangs) | +0.70 ms / 0.50 ms | +0.60 ms / 0.60 ms |

* `tests/perf.mjs` (1500 units, 3 wars, ×4), untouched baseline (36e3f75) vs this branch, three alternating runs each at machine load 8-13. The scatter of ONE build between runs is ±50 % (baseline «whole map» frame CPU 4.96 / 7.75 / 11.04 ms),
  so the medians only show that nothing changes systematically: frame CPU base → plugin 7.75 → 8.51 (whole map), 12.29 → 11.85 (whole, political), 12.27 → 13.58 (zoom 8 political), 6.72 → 6.32 (zoom 14 city), 10.57 → 12.98 ms (zoom 6 culture),
  sim profile `Powers` 0.002 ms/tick in both. The plugin's idle cost, measured directly: **28 ns per tick** (`Powers.step` with nothing live); per frame Render skips the empty effect arrays (nothing drawn, nothing allocated).
  The «sim keeps pace ≥ 28 of 40 ticks/s» check of `perf.mjs` sits at its limit on this loaded machine for both builds (baseline 28.1 at load 13, plugin 27.4 once).
* Regression, this branch: powers 26/26, save 25/25, sim 14/14, units 23/23, world 24/24, sprites 17/17, plugins 21/21, render 85/85, fxperf 9/9, ui 112/112, cities 31/32 · system 11/12 (timing checks only, see the notes), politics 30/30, regions 20/20, war 20/20,
  power_dynamite 24/24, power_dynamite_visual 19/19 (with `--perf`).

## Notes for the merge / other agents

* `tests/plugins.test.mjs`: the position check of the demo tool assumed the demo is the only «Арсенал» tool; with any real arsenal plugin in the harness it failed. It now checks that the arsenal group is one contiguous block right after «Разрушение» and before «Благословение» (one line).
* `tests/ui.test.mjs`: one line — the expected number of powers in the dock now also counts the tools of the «Арсенал» group (`ToolDefs` with `group === 'arsenal'`), so every arsenal plugin keeps that test green.
* Plumbing gap (not fixed, worked around): `UI.applyTool` toasts `Powers.lastMessage` only when `apply` returned false, so the success text of `host.msg(text, true)` (CONTRACT 10.2 «Russian text for the toast») is never shown. Dynamite emits Bus `dynamiteLaid` and its graphics plugin toasts;
  a generic one-line fix in `UI.applyTool` would also work (the UI dedups equal toasts within 1.4 s, so both can coexist).
* Base game, not the plugin: `World` rebuilds its private burning-tile list in index order on load while a live game keeps ignition order, so a save taken **while tiles burn** does not continue bit-identically (reproduced with the plain Fire power: R state differs after one tick).
  The save/load test therefore puts fires out before the mid-chain save; the mid-fuse test (no fire yet) is bit-identical through the whole chain.
* Timing checks of the base suites flake on a loaded machine (load 8-13 here, shared with other agents) and do so on the untouched baseline tree too (checked side by side): `powers.test.mjs` «meteor r=6 impact < 30 ms» / p99 of `Powers.step`,
  `plugins.test.mjs` «built-in full-screen flash paints the canvas» (pixel read after the flash faded), `world.test.mjs` generation timing, `cities.test.mjs` «worst-case tick < 8 ms» (fails on every baseline run here, 12-31 ms),
  `system.test.mjs` «a single tick took 403 ms». All of them are pure timing checks and none exercises the plugin (a green re-run is enough, `cities` / `system` stayed red here because the whole machine was busy).
* The hint line next to the brush slider shows at most ~28 characters (2 lines clamp): hint = «Динамит: заряд или цепь».
* `index.html` is generated and is not part of this change: rebuild with `node build.mjs` after merging.
