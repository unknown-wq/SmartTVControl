# «Ядерная бомба» (`nuke`) — god power

Tab «Силы», new group «Арсенал» (between «Разрушение» and «Благословение»), button «Ядерка». One tap on the map arms a bomb: a red alarm reticle with the blast
radius and a countdown, a bomb falls for 2.5 s, the blast resolves as an expanding wave over 0.8 s, then a mushroom cloud rises over a radioactive, scorched crater.

Sim plugin `src/18_power_nuke.js` (DOM-free) + graphics plugin `src/33_gfx_nuke.js` (client only), CONTRACT section 10. Nothing in Powers / Sprites / Render / UI / Save / core
was edited, except **one line in `Powers.heal`** (`src/11_powers.js`: `if (u.rad) u.rad = 0;`, so the heal power cures radiation sickness).

## Use

* Tool `nuke` (`tab: 'powers'`, `group: 'arsenal'`, `afterGroup: 'destroy'`), `brush: true`, `drag: false`. Hint «Ядерный удар (радиус = кисть + 5)».
* **Blast radius R = 5 + brush** (brush 1..8 gives 6..13 tiles). The reticle on the map shows the real R (the generic brush preview circle shows the brush radius only, see known issues).
* **Global cooldown 120 ticks** counted from the tap (12 s at x1, 3 s at x4). A second tap before that gives the toast «Бомба ещё не готова» (`ok = false`); so does a full bomb queue (3 in flight).
* A tap outside the map gives «Вне карты». A tap gives the toast «Тревога! Ядерный удар через 2.5 с».

## Timeline of one bomb (sim ticks, 10 ticks = 1 s at x1)

| tick | what |
|---|---|
| tap (t0) | record in `S.eff.nukes`, cooldown starts. Drawn: pulsing hazard disc + zone rings + crosshair + label «ТРЕВОГА n» + the bomb falling on a near-vertical path with a fiery trail and a growing shadow |
| t0 + 25 | detonation: Fx `flash` (white, ttl 1.6, a 1) + `flash` (orange afterglow, ttl 2.6, a 0.28) + `shake` (amp 10, ttl 1.2); the mushroom record (`S.eff.mushrooms`) and the fallout zone (`S.eff.fallout`) are created; the cities near the blast are snapshotted for the headline |
| +1 .. +8 | the blast is resolved ring by ring, ring k reaches radius `R * (1 - (1 - k/8)^1.5)` (fast at first, then slowing): **units first** (so that lava / razing cannot hide the kills), then buildings / terrain / fire of the same ring |
| +8 | headlines (one per bombed city), `Cities.destroy` for cities whose core is gone, the bomb record is removed |
| +8 .. +220 | mushroom cloud (stem rises, cap spreads, hot white -> orange -> brown -> grey, embers and ash fall, fades out) |
| +8 .. +1500 | fallout zone, decaying linearly |

## Blast zones (d = distance from ground zero, R = blast radius)

Tile zone borders are ragged: the tile distance is scaled by `0.92 + 0.16 * noise(x, y, bomb seed)`. Units use the exact distance.

| d / R | units | buildings | terrain / vegetation | fire |
|---|---|---|---|---|
| < 0.15 | die | razed | **LAVA** (molten glass, cools through the normal World lava rules; next to water it turns to rock quickly) | |
| 0.15 .. 0.36 | die | razed | grass / forest / sand -> **SAND** (glassed ground) | |
| 0.36 .. 0.45 | die | razed | ~55 % **HILL** rubble ring, the rest SAND; trees and berries gone everywhere inside 0.45 R | |
| 0.45 .. 0.8 | die with p = 0.95 - 0.8 t (t: 0 at the inner edge .. 1 at the outer edge); survivors lose 40..80 % of max HP and burn 6..10 s | razed with p = 0.85 - 0.55 t, otherwise 60..85 % damage | trees and berries gone, **FOREST -> GRASS** | ignites with p = 0.78 - 0.25 t |
| 0.8 .. 1.0 | damage (0.5 - 0.35 t) x (0.7..1.3) of max HP, 60 %..10 % of them catch fire | 45 %..15 % damage | trees removed with p = 0.6 - 0.4 t | everything flammable ignites (forest p 0.85, else 0.5, scaled by 1 - 0.4 t) |
| water | untouched (a little splash / steam Fx only) | | | |

Death causes shown in the unit history: «ядерный взрыв» (blast), «радиация» (fallout). Cosmetic Fx per ring are capped (7 per wave tick, 56 per bomb).

## Cities, kingdoms, log

* Buildings fall through `Buildings.destroy` / `Buildings.damage`, people through `Units.kill` / `Units.damage`: the existing rules do the rest (a razed town hall destroys the city, the capital moves
  by succession, a kingdom without cities falls, refugees become homeless).
* At detonation the plugin snapshots every city within R + 8 (at most 8 per bomb): `{id, name, kingdom, pop, buildings}` and tallies the dead / razed per city while the wave runs.
* At the end of the wave, per city: **destroyed** when nobody is left, or when the town hall is gone and either the population fell to <= 25 % (min 2) or <= 25 % of the buildings remain -> `Cities.destroy(id, 'nuke')`,
  kingdom history entry «Ядерный удар уничтожил город «X»», and ONE headline «Ядерный удар: «X» уничтожен, погибло N». (The engine's own «Город «X» разрушен» line from `Cities.destroy` stays: two lines in the journal for a destroyed city.)
  A city hit only on its edge survives and gets ONE headline «Ядерный удар по «X»: погибло N, разрушено построек: M» (only when N >= 5 or M >= 3; «, ратуша уничтожена» is appended when the town hall fell).
  A razed town hall is razed with cause `'city'` so that the engine does not add its own «Ратуша ... разрушена» line. All headlines are `LOG.DISASTER`.
* Never one line per victim.

## Fallout and radiation

* Zone: centre = ground zero, radius **0.7 R**, life **1500 ticks**, intensity `I = 1 - age / life`. Up to 6 zones at once (the oldest is dropped).
* Every 10 ticks each unit inside gets a dose `I * (1 - 0.65 * d / r)` (the strongest of overlapping zones, ignored below 0.015): status `u.rad = tick + 30` («Облучён», renewed while inside, ends 3 s after leaving),
  damage `maxHp * (0.004 + 0.07 * dose^2)` per dose, i.e. per second at x1 — a fresh zone kills at ground zero in about 14 s, its rim costs ~1.3 % of max HP per second, an old zone only a little.
* **No healing inside**: `u.radHp` remembers the HP after the last dose; natural regeneration above it is taken back at the next dose.
* **Antidote**: the `heal` power clears `u.rad` (and with it the no-heal rule).
* Vegetation thins slowly: every 100 ticks 4 random tiles per zone (while I >= 0.2) are tried, a burning-free FOREST tile turns to GRASS (the test sees 184 -> 175 forest tiles in a dense zone after 300 ticks).
* Look: unit badge «Облучён» (`UIPlugins.unitBadges`, class `bad`) and a pale-green tint (`GfxPlugins.addUnitTint('rad', ...)`); on the map a scorched ground decal with a pale-green haze, trefoil signs on the rim and rising motes, all fading with the zone.

## Graphics (`src/33_gfx_nuke.js`)

Registrations only at load time (no DOM): icon `nuke` (14x14 mushroom cloud glyph), unit tint `rad`, badge, and three persistent-effect layers drawn bottom to top by `Render`:

| layer (`S.eff.<key>`) | draws |
|---|---|
| `fallout` | one baked ground sprite (blackened earth with radial blast streaks and a glassy centre under the haze), trefoil signs, motes |
| `nukes` | alarm: hazard disc, zone rings (0.45 R, sparse 0.8 R, blast edge as marching white / red squares), pulsing crosshair, label «ТРЕВОГА» + countdown + sign, shadow, the bomb with its trail |
| `mushrooms` | ground flash + two shock rings (the real front of the sim), white-hot fireball with a soft glow, dust skirt, stem, cap (cross-fades between the 4 cooling stages), embers, ash |

Cost control: every sprite is baked once per blast radius (`kitFor(R)`: cap x 12, stem x 4, skirt x 4, ground, built lazily a few parts per frame while the bomb is falling; at most 9 radii kept, so memory is bounded) and
blitted **nearest-neighbour** (a smoothed `drawImage` costs ~6x more in a software canvas; smoothing is only on when a sprite is shrunk by more than 30 %). Dashed rings are chains of small squares (a dashed vector stroke is ~4x dearer).
No per-frame allocation, no gradients / shadows / filters. Canvas calls per frame (counted by the fake-DOM test): 50..58 for a steady cloud + fallout, about 320 in the first 22 ticks of a blast and about 370 for the alarm
(the chains of small squares), all of them cheap `fillRect`s.

## State (JSON-safe, saved with the world; the continuation after load is identical)

```
S.eff.nukes      [{x, y, r, t0, eta, s, w, hit: [{i, n, k, p, b, d, z}]}]   r = R, s = noise seed, w = rings already resolved, hit = per-city tally (id, name, kingdom, pop, buildings, dead, razed)
S.eff.mushrooms  [{x, y, r, t0, until}]                                    r = R
S.eff.fallout    [{x, y, r, R, t0, until}]                                 r = 0.7 R
S.mod.nuke       {cd, n, lr}                                               cooldown (tick), bombs dropped, last radiation tick
unit fields      u.rad = status until tick, u.radHp = hp after the last dose
```

`afterLoad()` repairs damaged / missing lists. All gameplay randomness goes through `R`; cosmetic placement uses `Util.hash2`. Units are processed in `S.units` Map order (the save order), never in spatial-grid order.
Caps: 3 bombs in flight, 6 clouds, 6 fallout zones, 8 cities tallied per bomb.

## Numbers

Headless (node, 96x96 world, `tests/power_nuke.test.mjs`, quiet machine; in brackets the same test while the shared 4-core box ran at load ~10):

* wave over a dense city, R = 13, 1021 units (640 inside), 65 buildings: the 8 wave ticks cost 0.41 0.48 0.25 0.21 0.17 0.34 0.14 0.40 ms (avg 0.30, max 0.48; loaded: avg 1.0, worst 4.5), fall ticks 0.004 ms,
  fallout + cloud active (882 units): `Powers.step` avg 0.009 ms (loaded 0.016..0.028; the radiation tick every 10th tick is the only spike: 0.4 ms quiet, <= 5.5 ms loaded).
* memory: 12 bombs in a row change the heap by < 1 MB (14.9 -> 14.7 MB), `Fx.list` empty afterwards, no immortal records (everything expires).
* chaos: 3000 ticks with a random action every tick (all tools, 23 bombs): no exceptions.
* in the browser, whole `Sim.step` through a blast at R = 13 (1194 units, 313 inside): 0.6..1.1 ms on most wave ticks, a few 7..14 ms spikes (first-run JIT / GC / periodic World work, not the plugin: its own cost is the 0.3 ms above); fall and after-blast ticks avg 1.1 ms.

Browser (headless Chromium, software canvas, 390x844 @2x, ~1500 units, `tests/power_nuke_visual.mjs`: per-frame `Render.draw` + canvas flush, layers on / off alternating, low quartile of 80 frames; ms added per frame, quiet machine):

| view (device px per tile) | mushroom + fallout, R = 13 | R = 9 | first ticks of the blast, R = 13 | alarm, R = 13 | frame without nuke |
|---|---|---|---|---|---|
| zoom 6 culture (12) | 0.2 | 0.2 | 0.8 | 0.4 | 11.1 |
| zoom 8 political (16) | 0.4 | 0.3 | 0.6 | 0.3 | 7.0 |
| zoom 14 city (28) | 0.9 | 0.6 | 1.4 | 0.7 | 4.1 |
| zoom 24 city (48) | 1.8 | 1.2 | 2.8 | 0.8 | 3.2 |

+-0.3 ms noise. R = 13 is the largest possible bomb (zoom 14: 0.9 ms against the CONTRACT 10.3 target of 0.5..0.6 ms); the default brush (3, R = 8) costs about half of it. At zoom 24 the cloud and the decal cover the whole screen: pure fill cost of the software
rasteriser (a GPU canvas does not care). Regression guards of the visual test are deliberately loose (1.6 ms, 3.5 ms at zoom 24) because the shared box is noisy; the exact numbers are printed. Not re-run by me at the end: `perf.mjs` baseline vs new
(first runs of both trees differed by far less than the run-to-run noise of the box: base 4.8 / 7.0 ms and new 6.9 ms in the same scene), `render.test.mjs` 85/85 and `fxperf.mjs` 9/9 (after one load-induced flake) were green on the final code.

## Files and tests

| file | |
|---|---|
| `src/18_power_nuke.js` | sim plugin |
| `src/33_gfx_nuke.js` | graphics plugin |
| `src/11_powers.js` | ONE added line in `healTool` (`if (u.rad) u.rad = 0;`) |
| `tests/power_nuke.test.mjs` | 30 sections: registration, arming / cooldown, timeline, units / buildings / terrain by ring, cities + succession + log, fallout + antidote, vegetation, wave cost, 3x save / load continuation (mid-fall, mid-wave, mid-fallout), chaos 3000 ticks with every other power, expiry, memory, stubbed neighbours, damaged saves, graphics plugin against a fake DOM (icon, tint, badge, layers, caps, draw-call budgets, context state), browser part (UI path, alarm, flash, cloud, save / load, screenshots `nuke_01..09`) |
| `tests/power_nuke_visual.mjs` | screenshot walkthrough at zoom 8 / 14 / 24 (alarm, bomb, flash, wave, rising, full, cooling, aftermath) from one saved world + the cost numbers above |
| `tests/fixtures/nuke_hook.js` | tests only: exposes `GfxNuke` / `GfxPlugins` to the page (`node build.mjs --extra=tests/fixtures/nuke_hook.js`) |

```
node tests/power_nuke.test.mjs [--nobrowser] [--quick] [--shots=DIR]       # 30 sections; --nobrowser = the 23 headless ones
node tests/power_nuke_visual.mjs [--shots=DIR] [--seed=4] [--noshots] [--noperf] [--nobuild]
```

Both build to private files (`/tmp/godsim-nuke-test.html`, `/tmp/godsim-nuke-visual.html`), never to `index.html`.

## Known issues / caveats

* **`tests/plugins.test.mjs`, check «ToolDefs.add puts a new group after its afterGroup and before the next group» fails once the nuke plugin is loaded**: it assumes the demo tool (group `arsenal`) lands right after the last
  `destroy` tool, but «Арсенал» already exists (nuke registered first) so the demo tool is appended to it. Any other arsenal plugin loaded before the fixture triggers the same. The test file is not mine; suggested fix:
  `iArsenal = ids.findIndex(id => ToolDefs.byId[id].group === 'arsenal')`, assert `iArsenal === iLastDestroy + 1 && ToolDefs.byId.demo_blast.group === 'arsenal' && iDemo < iBless`.
* The generic brush preview circle (Render / UI) shows the brush radius r, the blast radius is r + 5 (the alarm reticle shows the real one; the hint says «радиус = кисть + 5»). A `ToolDefs` field such as `radiusAdd` would let the preview match.
* Pre-existing, not caused by the plugin: after `Save.load` the continuation of a world with **burning tiles** is not bit-identical on its own (World's private fire list order and the Units spatial-grid order are not part of the save and
  change who dies / which member list comes first). The nuke test therefore calls `Sim.afterLoad()` on the live world before taking the snapshot (so both sides are in the canonical order) and compares world, RNG, `S.eff` and `S.mod`: identical.
* Fire spreads through connected forest beyond the blast (the existing fire model); big forests next to a bomb can burn for a long time.
* A bomb smaller than the city does not destroy it (e.g. R = 8 on a city of 80: heavy losses, the town hall may fall; a headline «Ядерный удар по «X»...» says so).
* The cooldown is global and counted in ticks, so it is shorter in real time at x4.
* Timing-sensitive checks (wave tick cost, per-frame draw cost) are measured against generous limits because the CI machine is shared; the exact numbers are printed by the tests.

## Merge notes for the lead

* `plugins.test.mjs` fix above (one assertion). `tests/powers.test.mjs` has a load-sensitive performance section (meteor impact bound 30 ms); it passed when the machine was calmer and failed once (59 ms) under load 12 — unrelated to the nuke.
* Ready-to-paste section for `docs/STATUS.md` («God powers»): **«Ядерная бомба» (`nuke`, «Арсенал»)** — tap = «Тревога» (2.5 s), blast radius = brush + 5 resolved as an expanding wave over 8 ticks (everything dies inside 0.45 R, lava
  core / glassed ring / hill rim, probabilistic deaths and burning to 0.8 R, heat flash to R, forests burn down), ONE journal headline per bombed city (destroyed city -> `Cities.destroy`, succession and kingdom fall by the existing
  rules), a mushroom cloud (220 ticks) and a decaying fallout zone (1500 ticks, status «Облучён», damage, no healing, cured by «Исцеление»). Global cooldown 120 ticks. Files: `src/18_power_nuke.js`, `src/33_gfx_nuke.js`,
  `tests/power_nuke*.mjs`, `docs/feat_nuke.md`.
* Ready-to-paste line for `docs/REQUESTS.md`: «nuke: (1) plugins.test.mjs arsenal-order assertion (see feat_nuke.md); (2) optional `ToolDefs` field so the brush preview circle can show brush + 5; (3) pre-existing: World fire list / Units grid order are not saved, so a save made while tiles burn does not continue bit-identically».
