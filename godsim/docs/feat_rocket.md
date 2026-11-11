# God power «Ракеты» (rocket volley) — feature notes

Tool `rocket`, tab «Силы», new group «Арсенал» (right after «Разрушение»), name/short «Ракеты», icon `rocket`, `brush: true`, `drag: false`.
One tap = one salvo from the nearest map edge. Brush radius `r` (1..8) = size and scatter of the salvo.

Files (all new, nothing in the core / Powers / Sprites / Render / UI / Save files was touched):

| file | what |
|---|---|
| `src/16_power_rocket.js` | sim plugin `PowerRocket` (aiming, flights, impacts, log, state) |
| `src/31_gfx_rocket.js` | graphics plugin `GfxRocket` (icon, rocket sprites, trails, reticles, bursts, toast) |
| `tests/power_rocket.test.mjs` | headless test (20 sections) + imports the browser part |
| `tests/power_rocket_browser.mjs` | browser part: UI, visuals at zoom 8 / 14 / 24 with pixel probes + screenshots, draw budget (paired A/B) |
| `docs/feat_rocket.md` | this file |

`node tests/power_rocket.test.mjs [--nobrowser] [--noperf] [--shots=/tmp/godsim-rocket-shots]` (browser part builds to `/tmp/godsim-rocket.html`, never touches `index.html`).

## Rules (sim)

* **Salvo**: `N = min(9, 3 + r)` rockets (r = 1 → 4 … r ≥ 6 → 9). Toast `Залп: N ракет` (Russian plural: «4 ракеты»).
* **Aiming**: the first rocket lands on the tap (±0.25), the others are scattered in a disc of `0.8 * r` tiles (min spacing 0.9 / 0.6 for r = 1). With probability 0.75 a scattered
  point is pulled 70 % toward the *nearest* unit / building when one is within 3 tiles («magnet»): a village gets razed, an empty field is just scattered. Candidates are sorted by id
  (a loaded save must aim identically).
* **Launch rule**: the NEAREST map edge to the tap (ties: south, north, west, east). The whole salvo starts in one small battery 1.2 .. 4 tiles beyond that edge, spread along it
  (σ ≈ 0.5·(0.9 + 0.32 N) tiles). Camera clamping keeps the sea beyond the edge off screen, so the player simply sees rockets enter from the sea side.
* **Flight**: 14 … 26 ticks (`13 + 0.26 · distance`, ±1.5, clamped: farther targets take longer), launch stagger 0 … 10 ticks (rocket 0 flies at once, the rest random) → a ripple.
  Path = quadratic Bezier with a small sideways bend (`b`, ±8 % of the length) + eased time (accelerates 0.6× → 1.4×) + a ballistic altitude hump `h` that only the renderer shows
  (`PowerRocket.path(e, T, out)` / `pathS(e, s, out)` are shared with the renderer).
* **Impact** (blast radius 1.8 tiles), in the sim step of tick `eta`:
  creatures: `90` in the core (d ≤ 0.75), `90·k^1.5` outside (k = (1.8 − d)/1.05): ≈ 34 at 1.25, 7 at 1.6; survivors are shoved outwards (0.25 … 1.35 tiles, glide via `px/py`), those within 1.2 burn;
  buildings: `160 · (1 − d/2)^0.9` (house ≤ 1.6 tiles dies, storage / market ≤ 1.0, barracks / temple only on a direct hit, a town hall needs two);
  every land tile in the blast ignites with 45 % (`World.ignite` → the existing burnt-ground decals), forest within 1.0 is felled (→ grass), lone trees / berries within 1.3 are cleared;
  mountains / snow / lava / water tiles are never changed; a water hit makes a geyser burst, no fire.
* **Merge**: the 4th and later impacts of one tick are merged into ONE bigger burst (`rocket_boom` with `m` = count, drawn as up to 5 copies); their damage is still applied one by one.
* **Caps / cooldown**: launcher cooldown 12 ticks (`S.mod.rocket.cd`; a tap during it fails with «Пусковые устройства перезаряжаются»), at most 54 rockets alive («Небо уже в огне»).
  The cooldown counts *ticks*, so a tap while the game is paused is refused too.
* **Fx caps** (a continuous barrage at ×4 must not pile up hundreds of sprites): live `rocket_smoke` ≤ 14, `rocket_trail` ≤ 18, full `rocket_boom` ≤ 40 (`SMOKE_CAP` / `TRAIL_CAP` / `BOOM_CAP`,
  counted once per impact tick by walking `Fx.list`); the merged burst of a tick is always shown, damage never depends on any cap.
* **Log**: one aggregated line per salvo when ≥ 3 died or ≥ 2 buildings fell («Ракетный залп по «X» (погибло: 7, разрушено построек: 4)»), plus one line for a killed ruler of a living
  kingdom («Королева Имя («Королевство») погибла под ракетным ударом»). Never one line per victim.
* **Camera**: one `shake` Fx per impact tick (amp 3 … 6 css px, 0.28 s) — a rolling tremor during a salvo.

## State (JSON-safe, created lazily: a world that never fires a rocket stays byte-identical, also through save / load)

```
S.eff.rockets = [{x, y,            // CURRENT ground position, refreshed every tick (the renderer culls by it)
                  x0, y0, x1, y1,  // launch point (beyond the edge) / impact point
                  t0, eta, r,      // launch tick (future = stagger), impact tick, blast radius 1.8
                  b, h, v, l}]     // sideways bend, arc height (tiles), visual seed, launched flag
S.mod.rocket  = {cd, a}            // launchers ready at tick cd; a = tallies of the current salvo for the log line (or null)
```
Mid-flight save / load continues identically (rockets, impacts, damage, log, RNG): `tests/power_rocket.test.mjs` compares `S.eff`, `S.mod.rocket`, every unit and the RNG state.

## Graphics (`src/31_gfx_rocket.js`)

Everything is baked lazily into small cropped canvases (DOM-free pixel buffers, `PB`; only `toCanvas` touches the DOM), nothing is allocated per frame.

* **rocket**: 32 headings × 3 flame frames, white body / red nose + fins / window / outline, light from the top-left; rotates along the *screen-space* velocity (ground path + altitude hump).
  A ground shadow shrinks with altitude. Position = `PowerRocket.path(e, S.tick + alpha)`: the renderer runs one tick *ahead* of the units, so a rocket reaches its target exactly when the sim
  processes the impact in the next step (no explosion before arrival).
* **trail**: 2 baked strips per rocket (64 headings × near / far, puffs pre-arranged, dithered fade) laid along the flight curve; after the impact the same trail lingers as Fx `rocket_trail`
  (rising, growing, fading). A trail costs 2 `drawImage`, not ~11.
* **reticle**: dashed blast ring + lethal-core ring + crosshair (4 rotation phases, ONE sprite), shown during the last 10 ticks of a flight, drawn in a first pass so it lies under every rocket.
* **burst** `rocket_boom`: 14 frames, land (2 variants) / water: flash + star, cauliflower fireball that cools, shock ring, dust, sparks, debris, smoke; water = geyser + rings + droplets.
  `rocket_smoke` (18 frames) is the rising column; both fade with an ordered dither (opaque pixel stipple, no see-through outlines).
* **icon** `rocket` (14 × 14, drawn with the same rasteriser at 45°), **toast** (Bus `rocketVolley` → `UI.toast`, see below), **warm-up**: the burst frames are baked in the background
  (≤ 2.6 ms per frame) after the first salvo; rocket sprites / strips are baked on first use (tiny).
* `rocket_launch` (flash + smoke at the launch point) exists but is practically never on screen (the launch point lies beyond the map edge, the camera is clamped to the map).
* **Far-zoom gating** (`FAR_SC = 12` device px per tile, i.e. zoom < 6 on this 2× screen — the same threshold the game's own FX use): the smoke column, the lingering trail and the launch effect are skipped
  and a flying rocket draws only its near trail strip (1 `drawImage` instead of 2). The rocket sprite, the reticle and the burst are always drawn, so a salvo stays readable from the whole-map view.
* **Frame time**: the effect runs at `S.tick + min(alpha, 0.98)`; a paused game passes `alpha = 1`, the clamp keeps a rocket one tick from its impact visible until the sim processes it.

## Numbers (this container: Node 22, headless Chromium 390×844 @2×, software GL, **shared 4-core machine, load average 5 … 12 during the runs**)

* **sim** (last section of `tests/power_rocket.test.mjs`): plugin step avg **0.02 … 0.07 ms/tick**, p99 0.07 … 1.3 ms, max 0.2 … 6 ms (the high end is a JIT-cold first attempt; the test keeps the best of up to 3),
  over 400 ticks with 34 salvos of 9 (≈ 300 impacts, up to 26 rockets in the air) on 1500 creatures packed into a 28-tile disc, about half of them die. Thresholds: avg < 0.3, p99 < 2, max < 30 ms.
  No rocket alive = **~12 ns/tick** (one length check); `apply` 0.13 ms; one impact on a crowd of 150 + 40 houses ≈ 0.6 … 1.1 ms.
* **draw** (paired A/B: the page alternates frame by frame between «effects in view» and «none», so the machine load cancels; 1460 creatures, 400 frames per attempt, best of 2 attempts):
  zoom 8: baseline 4 … 5 ms, **9 rockets in flight +0.0 … 0.2 ms**, **9 simultaneous bursts (boom + smoke + lingering trail) +0.3 ms**;
  zoom 14: **+0.1 … 0.3 ms** / **+0.13 … 0.23 ms**; zoom 24: ≈ +0.1 / +0.2 ms (budget ≤ 0.5 ms for all of them). `drawImage` calls added per frame with 9 rockets: +36
  (before the strip / reticle / crop work it was +90 … 130, and the first sequential measurement gave 0.74 ms at zoom 8).
  With the CPU throttled ×4 (CDP, «slow phone») the worst case costs ≈ +1 ms per frame.
* **stress** (not a real play pattern): a continuous maximum-rate barrage at ×4 speed (the cooldown allows a tap every 12 ticks) → at most 54 rockets / 14 smoke / 18 trails / 40 bursts alive;
  +0.2 … 2.1 ms per frame on top of the scene (the 2.1 ms is the whole-map view, where everything is on screen at once).
* The 9-simultaneous-bursts case is a worst case: a real salvo spreads its 9 impacts over ~20 ticks.
* **Idle cost** (no rockets alive, effects list empty): main-thread CPU per frame at ×4, base commit `36e3f75` vs this branch, the five scenes of `tests/perf.mjs` measured as `Performance.ThreadTime`
  (so the other jobs on the machine cancel), median of 3 alternating rounds: whole map 102.0 %, whole map political 100.2 %, zoom 8 political 100.4 %, zoom 14 city 105.0 %, zoom 6 culture 103.7 %
  (all within the +10 % budget). The wall-clock numbers of `node tests/perf.mjs` itself swing ±40 % between two *identical* runs on this shared machine
  (the world it builds grows non-deterministically through `adaptPerf`), too noisy to resolve +10 %, so the CPU-time table above is the evidence.
* **`tests/fxperf.mjs`**: passes except, intermittently, its «cold start ≤ 12 ms» line when the machine is busy; the same line fails on the *base* commit under the same load
  (cold-start metric over alternating fresh pages: base median 9.03 ms, this branch 9.85 ms, no systematic difference).
* **First salvo in a fresh page**: the small sprites (rocket, strips, reticle) are baked on first use (forced, they are tiny); the 14 burst frames and the 18 smoke frames are queued by the
  `rocketVolley` Bus event and baked in the background with a budget of 2.6 ms per rendered frame (`pump()`), long before the first impact (flights last ≥ 14 ticks). A frame that is not baked yet
  is skipped for that frame instead of stalling it.

## Notes for the merge / things outside my files

* **Success toasts**: `host.msg(text, true)` is *not* shown by the UI (`UI.applyTool` only toasts failures). The «Залп: N ракет» toast is therefore emitted from the graphics plugin
  (`Bus 'rocketVolley'` → `UI.toast(text, 'good')`, looked up lazily). If the lead wants plugin success texts toasted generically, a one-line change in `UI.applyTool`
  (toast `Powers.lastMessage` when `ok && ToolDefs.byId[tool].group === 'arsenal'`) would do it for every arsenal power (the identical-text dedupe of `UI.toast` prevents doubles).
* **`tests/plugins.test.mjs`** had one expectation invalidated by design: «the demo tool sits directly after the last `destroy` tool». With any arsenal plugin loaded (the harness loads every
  `src/1N_power_*.js`) the demo tool correctly lands behind it; the check is now «after `destroy`, before `bless`, only `arsenal` tools in between». Every arsenal branch will hit this.
* **Group registration** is idempotent (`ToolDefs.groupLabels.arsenal = 'Арсенал'` + `ToolDefs.add({... group: 'arsenal', afterGroup: 'destroy'})`): five plugins can all do it.
* The camera is clamped so that the area beyond the map edge is (almost) never visible: launch effects at the battery are cosmetic only.
* Fx cap: `Fx.add` silently drops entries when the list holds > 400; a salvo uses ≤ ~6 Fx per impact tick (3 full bursts + 1 merged), optional ones (smoke, trail) are skipped above 320 entries.

## Known issues / ideas

* The reticles of a dense 9-rocket salvo overlap into a busy cluster over a village (by design: that *is* the warning); a thinner ring or a «nearest 4 only» rule would calm it.
* No custom crater decal: ground marks come from the existing fire / rubble decals only (non-flammable tiles such as sand / rock keep no mark). A decal would have to be drawn
  under the entities, which a plugin effect cannot do.
* Timing-based suites (`render.test.mjs` fps / drawMs, `fxperf.mjs`, `save.test.mjs` timings, `powers.test.mjs` «Powers.step p99 < 4 ms» — seen once at p99 4.2 ms with the load average at 8; that test never
  fires a rocket) flake when the machine is loaded by other jobs; the rocket test repeats its own timing checks (best of 3).
* The launcher cooldown counts ticks, so on a paused game only one salvo can be fired: the next tap is refused («Пусковые устройства перезаряжаются») until the game has run 12 ticks.
