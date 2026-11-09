# GODSIM — status after the integration pass (stage 3)

One self-contained `index.html` (≈1.0 MB, vanilla JS + canvas 2D, zero external assets, procedural pixel art, Russian UI, iPhone Safari portrait first).
Source: `src/NN_*.js` (20 files, one shared scope) + `style.css` + `template.html`; `node build.mjs --check` builds and syntax-checks `index.html`.

## What is implemented, per requirement

| area | state | notes |
|---|---|---|
| **World / tools** | done | 96×96 (64..260) procedural continents, biomes, ores, lakes; 9 terrain brushes (raise, lower, grass, sand, forest, hill, mountain, snow, lava), live shading, fire spread, rain, lava cooling. 9 powers (lightning, meteor, fire, earthquake, plague, tornado, rain, heal, bless), creature spawners (human / orc / elf) and eraser, inspector for units / buildings / cities / regions / kingdoms, journal, world panel. |
| **Races** | done | Humans, orcs, elves: own stats, lifespans, fertility, terrain speed, habitat, sprites, names, gear (elves shoot). Traits (2–3 per unit) drive work, fertility, war / peace policy. Density-dependent births keep the three races a mix at the unit cap (fair share, see below). |
| **Cities / kingdoms** | done | Founding, housing, jobs (farm / chop / mine / forage / fish / build / guard), buildings (house, farm, storage, barracks, town hall, temple, market), levels, territory spheres clipped to owned regions, expeditions. Kingdoms: ruler + dynasty + succession (child → sibling → clan → best citizen), culture, stability, loyalty per city, rebellions (city + region secede), vassals, voluntary merges, peaceful expansion into wild regions. |
| **Diplomacy / wars / unification / rebellions** | done | Symmetric opinions with explained causes, alliances, truces, AI war declaration (neighbours, claims, ruler policy, relative power), allies / vassals join, rebel wars, god whisper / god peace / split. 3–13 wars per world per 50 game minutes, 2–11 rebellions, 0–3 merges. |
| **HOI4 mechanics** | done | ~50 regions (states) with owner vs controller (occupation), claims and cores, fronts, supply (attrition below 30), war goals per region, armies with orders (attack / hold / defend / retreat), armies take the goal region and HOLD it — the war never ends because a goal was taken —, war score, war weariness, peace conference with region transfer (price per region, white peace, vassalisation, god force), auto-peace on stalemate (4800 ticks, menu toggle), truce after peace. |
| **UI** | done | Dock with 5 tabs, brush slider, kingdom chips, event feed, inspectors, war tool «Война» (map first: tap a country = attacker with a slim HUD and its targets lit, tap a lit region = compact war card with odds / cost / casus / allies and one «Объявить войну» button; the same tap at war = attack card; a «ВОЙНА» banner for every declaration, AI wars too; pull-up drawer Войны / Армии / Регионы, army selection by banner or card, hold / defend popup, peace conference), political map (borders, occupation stripes, fronts, army banners, order arrows, goal stars), culture map, menu (4 save slots + autosave, new world, auto-peace toggle), toasts, safe-area layout, landscape support. |
| **Save / load** | done | Versioned, RLE + LZ packed, typed layers + column tables, checksum, rollback; loads are bit-identical (also in the middle of a war). |

## Notification filter («Войны» / «Все»)
A floating button at the top of the right-hand button column hides the noise: **«Войны»** (default) keeps only `war` and `peace` log kinds in the event feed (war declarations, occupations/liberations, peace deals, vassalisation by treaty); **«Все»** shows every event. The choice is stored in `localStorage` key `godsim.ui` (field `feedWar`) and the full log panel opens on the matching chip («Войны» / «Все»). Alliances are logged as `kingdom` (diplomacy), not as `peace`. Test: `tests/ui3.test.mjs`.

## Approximated / simplified

* Armies are a rally point that walks along an A* route; soldiers follow it with a formation offset. No unit micro, no naval invasions (landmass = connected via ≤ 2 tiles of shallows).
* Supply is a flat 0..100 value per army (friendly land or ≤ 14 tiles from a friendly / captured city), not a logistics network.
* War score is an estimate (occupied value, kills, losses, capital) smoothed over time, not a battle-by-battle HOI4 model. The AI peace judge is rule based.
* The AI always attacks one goal at a time and never advances beyond its goals; commanded kingdoms only get automatic defence.
* Culture spreads by neighbouring cities and temples; religion, trade routes, tech, diplomacy actions beyond alliance / truce / vassal do not exist.

## Integration pass: what changed (details in CONTRACT §9 and REQUESTS "STAGE 3")

* Bug: army race was rewritten on load (`War.normalizeArmy`) → save determinism sweep failed on seed 33. Fixed.
* Race balance: humans took every slot at the unit cap; orcs / elves died out in every 30000-tick world. `Units.updateBalance` (density dependent births) fixed it: all three races alive in 8 / 8 worlds, no race above 75 % of a full world.
* Wars: AI starts at tick 4200 (not 1500), needs 40 / 24 subjects, never attacks a people below 120 units, long calm raises war desire; goals must be reachable inside supply; muster by route; assault gate; offensive pause after bleeding; retreat when outnumbered; doom stacks are not diverted by raiders; goals held by a third kingdom are skipped; a commanded kingdom whose armies were destroyed can re-muster once. Zero-progress wars dropped from ~45 % to ~30 %, extra advances beyond goals: 0.
* Feed: one line per ruler death (the succession line).

## Numbers (this container, Node 22 / headless Chromium)

* `tests/system.test.mjs`: 8 worlds × 30000 ticks (≈50 game minutes each): 0 exceptions, 0 NaN, JSON-safe, bounded collections; 3–12 wars per world (one per 6.3 game minutes), 52 wars ended (16 without a control change, 78 occupations, 0 outside the goals, 1 longer than 12000 ticks), 44 rebellions, 28 kingdoms fell (3 within 1500 ticks of creation); event feed ≤ 9 lines per 100 ticks, no message above 30 % of the feed.
* Sim cost: 0.4–0.7 ms/tick average (≤ 600 units 0.2–0.4 ms), worst tick 15 ms; 1500 units + 3 wars: 0.75 ms/tick average, p99 1.5 ms (Units 0.53, War 0.03, Cities 0.03).
* Chromium, 390×844 @2×, software GL, 1500 units + 3 wars at ×4: 60 fps, frame CPU 1.8–3.6 ms (sim 0.5–0.8 + draw 1.2–2.9), sim keeps 40 ticks/s. With the CPU throttled ×4 (phone-like): 12–18 fps on the whole-map views, 35 fps at city zoom (sim ≈ 4–5 ms/tick, draw 6–15 ms); `Sim.adaptPerf` lowers thinking / effects automatically. Rare single frames of 30–65 ms when the political cache rebuilds after a region change.
* `tests/playtest.mjs`: 90 s at ×4 (40.0 ticks/s, 59.9 fps avg), 20+ random god actions through the real dock, war whisper, then the full command flow in a real world: declare → goal tap → armies take and hold the region → menu save → menu load (state restored, UI clean) → army orders → peace conference → release; political map at 5 zoom levels; no page errors. 36 / 36 checks.

## Art pass (procedural pixel art, still zero external assets)
Units: 8 looks per race (bit 2 = female), faction colour on shields / pauldrons + war banner / cloaks for armoured units, poses (attack lunge, chop / mine / farm / build / fish / forage, sleep), carried goods (wood, stone, food, iron, gold), hit flash, level-up sparkle, visible arrows. Buildings: 16x24 landmarks (town hall, temple L2+, barracks L3), 3 construction stages, damaged / burnt / ruin looks, roof and colour variants, chimney smoke. Terrain: 5 new tree kinds, burnt-ground decals, reeds, lily pads, pebbles, water glints. FX: slash, hearts, soul wisps, banner raise, birds and leaping fish (`Render.ambient = false` turns the ambient set off). Perf rules: small FX are baked once per animation frame into bitmaps (one `drawImage` each), only the newest ~16 tiny / 32 fire+smoke FX are drawn, tiny cosmetic FX hide below zoom 7-9, carried goods appear from zoom 9, poses from zoom 7. Measured draw cost per frame at 1500 units + 3 wars (software GL): whole map 1.9 ms, zoom 8 political 3.4, zoom 14 city 2.2, zoom 6 culture 3.8 (the first art pass had 5.3 / 3.4 / 9.8 before this fix). Guard test: `node tests/fxperf.mjs`.

## Known issues

* About half of all founded villages die out after 3000–9000 ticks (small expedition villages stop growing); harmless, but 25–32 «опустела» lines per world in the feed (stage-1 city logic).
* ~30 % of wars end without any region changing hands (balanced forces, the offensive pause, or goals out of reach); they end by exhaustion after 4800 ticks.
* Worlds without orcs (their first group failing to settle, ~1 in 12) have few wars, because humans and elves like each other.
* The political overlay is rebuilt in one frame (≈ 30 ms in software GL) when a region changes hands; not time-sliced.
* Wars that the player declares with a much weaker kingdom are lost (the UI shows the strength ratio, nothing prevents it).
* Touch-only: no keyboard shortcuts; mouse support exists for desktop testing.

## How to run the tests (from `godsim/`)

```
node build.mjs --check                              # build index.html + syntax check
# headless (each < 25 s, system 80 s):
node tests/world.test.mjs ; node tests/cities.test.mjs ; node tests/units.test.mjs ; node tests/sim.test.mjs
node tests/save.test.mjs  ; node tests/powers.test.mjs ; node tests/sprites.test.mjs
node tests/regions.test.mjs ; node tests/politics.test.mjs [--war=real] ; node tests/war.test.mjs
node tests/system.test.mjs [--quick] [--verbose] [--seeds=1,2,3] [--chaos=1,2,3 --chaosTicks=20000]
node tests/long.mjs --seeds=1,2,3,4,5 --ticks=30000 [--par=3] [--json=/tmp/long]     # per-3000-tick tables of every world
# browser (Playwright + headless Chromium; run ONE at a time, they are CPU sensitive):
node tests/render.test.mjs ; node tests/render2.test.mjs ; node tests/ui.test.mjs ; node tests/ui2.test.mjs ; node tests/ui3.test.mjs ; node tests/fxperf.mjs ; node tests/save.browser.mjs
node tests/playtest.mjs [--soak=90]                 # screenshots in /tmp/godsim-playtest
node tests/perf.mjs [--seconds=12] [--throttle=4]   # frame cost split at 1500 units / 3 wars / x4
```
