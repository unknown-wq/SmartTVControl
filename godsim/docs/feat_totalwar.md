# Feature: TOTAL WAR («Вся страна») + capitulation + annexation

Status: implemented on branch `worktree-agent-ab1b9a81091fe27ce` (ready to merge). Owner files: `src/10_war.js`, `src/35_gfx_totalwar.js`, `tests/war.test.mjs`, `tests/ui2.test.mjs`,
`tests/totalwar.test.mjs` (+ helper `tests/twlib.mjs`), this file. Small edits: `src/21_render.js` (`Render.cmd.deep`), `src/23_ui.js` (war card / HUD / banner /
capitulation sheet only), `src/style.css` («TOTAL WAR» section at the end). `08_kingdoms.js`, `09_diplomacy.js`, `12_sim.js` were **not** touched.

## 1. What the player gets

A second kind of war next to the unchanged limited war («Регион»). On the war card of an enemy region there is a segmented toggle
**[ Регион | Вся страна ]** (default «Регион», nothing changes for the old flow).

* **Вся страна** = a war against the whole country. The border band of the victim stays lit bright; the rest of its land (the *deep* regions) is lit dimmer with a
  dashed rim (`Render.cmd.deep`), the capital region carries the star. The card shows the honest costs: how many regions / cities / people, strength ratio and
  odds, who joins whom, **infamy +25** (+8 when we hold a claim; none for `god`/`rebel`/`ally` casus), opinion «Тотальная война», weariness ×1.5, mobilisation
  (35–50 % of the adults, ≤ 10 armies / kingdom, ≤ 80 per army, ≤ 600 soldiers). The button is red; the first tap arms it («Подтвердить войну»), the second declares.
* **During the war** the armies do not stop after one region: a *frontier chain* of goals (every ~20 ticks: every enemy region next to land our side controls or our
  armies stand in; the capital first) keeps them advancing. Supply, retreat and exhaustion rules are the old ones; the old auto-HOLD does not kick in while a
  reachable goal remains. A captured region is consolidated for `TW_REST + 3 × cost` ticks before the army moves on; the strongest army stays in a captured capital
  while the timer runs; held regions are defended against partisans.
* **HUD chip** (and the drawer row): «Столица ✗ · 3/12 регионов · до капитуляции 35 %» with two bars (regions, capitulation). **Banner «ТОТАЛЬНАЯ ВОЙНА»** for every
  total war that starts, AI wars included. The defender (also a commanded one) sees the same chip, red.
* **Capitulation.** A meter 0..100 per war: capital held, share of the regions occupied, the defender's armies destroyed, stability of the state. When the *capital
  is held and ≥ 60 % of the regions are occupied* the government's «will to resist» timer (`CAP_HOLD`) fills (0.8× … 2× per tick, depending on the share; a lapse eats
  it twice as fast); at the end the lead defender **capitulates**. The war ends for **both sides**: the defender's allies get a white peace + truce, vassals follow
  their overlord. (A manpower collapse of the defender capitulates too; a state in revolt alone does not.)
* **Annexation, three outcomes**, chosen by the winner:
  * **Присоединить** (merge): all regions, cities, units, vassals of the loser go to the winner (`Kingdoms.annex(…, 'merge')`); the loser disappears.
  * **Сделать вассалом**: the loser keeps its land and serves (stability floor 45 so it does not break free at once); regions revert, truce.
  * **Взять занятые регионы**: only the occupied regions change hands (cities included); the loser keeps the rest; claims for the loser; truce.
  The **AI** chooses by culture and size (same people & small → merge, much bigger foreign → vassal, otherwise regions). A **commanded** winner gets the
  **capitulation sheet** (the three buttons, suggestion marked) — the loser's armies are already at home and nobody attacks while it waits; the AI decides after
  `CAP_ASK` = 1800 ticks, or at once when the player's command is released. No stuck state: back/«X» keeps the decision open on the HUD («Решить»).
* **AI total wars are rare**: ≥ tick 9000, kingdom ≥ 3000 old, stable (≥ 55), ≥ 60 people, a warlike ruler (`policy.war − 0.7·policy.peace ≥ 0.1`: an
  aggressive / brave human, almost any orc), a **land neighbour on the same landmass** that is ≥ 2.5× weaker (joiners counted), no other war, ≥ 1500 ticks of
  peace, per-kingdom cooldown 6000 and a world cooldown 5000, and a dice roll on top (p = 0.13 … 0.59, one look per kingdom every 400 ticks). The AI never starts a
  total war from a commanded kingdom, a vassal, or against an ally / overlord / vassal / truce partner.

## 2. API (sim side, `War`)

```
War.declare(aggKid, defKid, goals, casus, {total:true})       // general entry; goals ignored for total (chain)
War.declareTotal(aggKid, defKid, casus?) -> war | null         // War.lastError says why not
War.canDeclareTotal(a, d) -> {ok, reason, info}                // read-only; info = preview for the card (regions/cities/pop/band/deep/ratio/odds/allies/infamy/…)
War.isTotal(warId) -> bool        War.totalInfo(warId) -> {progress, own, occ, capital:'held'|'free'|'none', hold, holdLeft, pending, left, …} | null
War.capitulation(warId) -> {kid, to, left, total, suggest, options:{merge,vassal,regions}, country} | null     // pending decision of a COMMANDED winner
War.resolveCapitulation(warId, 'merge'|'vassal'|'regions') -> bool
War.aiConsiderTotal(kid, force?) -> war | null                  // called from War.step; `force` skips the dice (tests)
War.aiTotalWhy(kid) -> ''|reason   War.aiTotalInfo(kid) -> {why,best,ratio,p,aggr}      // read-only diagnostics of the AI rule
War.TOTAL = { MAX_ARMIES_K, MAX_ARMIES_WAR, MAX_ARMY, MAX_SOLDIERS, FRAC, WEAR, INFAMY, INFAMY_CLAIM, CAP_SHARE, CAP_ASK, CAP_HOLD, REST, AI_MIN_TICK, AI_COOLDOWN, AI_RATIO }
War.targetsFor(kid)[i].total  // war entries carry the flag; war.total === true and war.tw = {cap, own, occ, fell, fellLog, peak, sure, pend, out, base, why, dn, an}
Bus 'capitulation' (war, loserKid, winnerKid)                   // a commanded winner must decide;  'warDeclared' / 'warEnded'(war, 'capitulation') as before
```
Limited wars keep `w.total === false`, no `w.tw`, caps 6 armies / 60 per army / 350 soldiers. Old saves load as limited wars (`normalizeWar`); `tw` is JSON-safe and
saved with the war; the whole thing is deterministic through `R` (save/load mid-march, mid-chain, with the timer running and with a pending decision is bit-identical).

## 3. Knobs (top of `src/10_war.js`)

| const | value | meaning |
|---|---|---|
| `TW_MAX_ARMIES_K / _WAR / TW_MAX_ARMY / TW_MAX_SOLDIERS` | 10 / 8 / 80 / 600 | caps (limited: 6 / 4 / 60 / 350) |
| `TW_FRAC_MIN/MAX/HARD` | 0.35 / 0.50 / 0.60 | share of a city's adults that may be conscripted (limited 0.20–0.35) |
| `TW_WEAR` | 1.5 | weariness speed |
| `TW_CHAIN` | 20 | ticks between two chain passes |
| `TW_PAUSE` / `TW_REST` | 800 / 120 | offensive pause after a bloodbath / consolidation after a capture (+3×cost) |
| `TW_STALEMATE` | 6000 | stalemate before autoPeace ends a total war |
| `CAP_SHARE` | 0.6 | share of the regions that must be occupied (with the capital) |
| `CAP_HOLD` | 8000 | **the duration knob**: the government's will-to-resist timer (see §1); 2:1 attacker vs a 6-region country ends after ~4600-8500 ticks |
| `CAP_ASK` | 1800 | ticks a commanded winner may think |
| `TW_INFAMY / _CLAIM` | 25 / 8 | infamy for a total war without / with a claim |
| `TW_AI_*` | see the source | AI rule: `MIN_TICK 9000, COOLDOWN 6000, GLOBAL 5000, RATIO 2.5, AGGR 0.1, CHANCE 0.3, PEACE 1500` |

## 4. Tests

| command | what it covers |
|---|---|
| `node tests/totalwar.test.mjs [--quick] [--seed=N]` | **24 sections, 24 / 24 in 56 s** (`--quick` = one populated world / shorter runs): `canDeclareTotal` preview + every refusal reason; limited war untouched (flag, caps, infamy 8 with a claim, capital first); mobilisation (draft 37 % / 47 % vs 24 % / 33 %, weariness ×1.5); allies / vassals; the frontier chain (goals grow 1 → 8 by themselves, capital first, a limited war still holds); chain details (no foreign goals, supply attrition); capitulation thresholds (capital + 60 %, rate 0.8× … 2×) and timer (lapse eats twice as fast, both sides get peace, Log + `warEnded how=capitulation`); manpower collapse (stability alone does not end it); a capital-less state + the stalemate exemption; outcomes merge / vassal / regions (invariants after each); commanded winner (pending + `Bus 'capitulation'`, the three answers, timeout 1800, release); commanded defender merged away; allies + third parties + a second war; AI rule (every negative probe, the dice, rarity in populated worlds); natural deaths are no losses; save / load bit-identical (march, chain, timer, pending); performance; fuzz (erase, destroy, peace, annex, commands, answers, save-load) |
| `node tests/war.test.mjs [--quick]` | 22 / 22 sections = the old 20 + 2 new: a limited war is untouched by the feature (flag, no `tw`, caps 6 / 60 / 350, one goal that never grows, old saves load as limited), the new API is safe on junk ids (read-only, no RNG roll) |
| `node tests/ui2.test.mjs [--only=total]` | browser, 390×844 + 320×568 + 844×390: new block «total war» (57 checks, 0 failed): the toggle [Регион \| Вся страна] (default Регион, the old flow unchanged), lit band vs dimmer deep regions, honest costs, red button + second tap, HUD chip / drawer rows, banner (own and AI wars), capitulation sheet with the three answers, no stuck state, back / release; screenshots of every state |
| `node tests/system.test.mjs --quick` | 12 / 12 (one word added to its list of valid war ends: `capitulation`) |
| `node tests/long.mjs --seeds=1,2,5 --ticks=30000` | 0 sim errors; limited-war statistics unchanged (median 4850-4970 ticks, base 4900-5050) |

Helper: `tests/twlib.mjs` (arena builder `tarena` / `mkArena`, `feed`, `run`, `worldInvariants`, ...). `--seed=N` moves the arenas to other maps.

## 5. Balance and performance

**Duration** (`CAP_HOLD`): a 2:1 attacker (strength 137 vs 67) against a 6-region country in a controlled arena, 8 maps: **4720, 4810, 4930, 4990, 5080, 5170, 5590,
7749 ticks** (median ~5000 = 83 game years; target 4000-9000), every war ended by capitulation (5 × «regions», 3 × «vassal»), the capital falls after 265-485 ticks, the
rest is the conquest of the other regions (~1500-2000 ticks) and the government's will-to-resist timer. Real populated worlds (a total war forced at tick 9000 on the
best pair): ratio 5.3 vs 6 regions 5148 ticks, ratio 7.2 vs 4 regions 6521, ratio 2.25 vs 9 regions 6491 (all «vassal»); a ratio-2.2 attacker against a **20-region**
empire never gets past 2 regions and the war ends by exhaustion after 11000 ticks; a pair whose victim had two allies ended by exhaustion (the attacker, spread over
10 small armies, was beaten piecemeal) - a total war is **not** a guaranteed win. Tune the length with `CAP_HOLD` (duration ≈ conquest time + CAP_HOLD / rate, rate 0.8 … 2).

**AI total wars** (plain AI, nothing forced; 8 worlds × 30000 ticks): 3 total wars (ticks 10361, 22661, 22761; durations 4106, 4515, 4651; all by capitulation: 2 × vassal,
1 × merge), 0 sim errors, 5-13 wars per world, 4-9 kingdoms left; the victims were small neighbours (27-39 people, 1-2 regions). Funnel behind it (5468 kingdom-looks since tick 9000, 8 worlds):
54 % of the kingdoms are at war, 18 % (985) are free to start one, but only 4 of those had an aggression ≥ 0.3 *and* a ≥ 2.5× weaker land neighbour (28 with aggression ≥ 0.1) -
hence the warlike threshold 0.1 and dice 0.3 (with the first values: 0 AI total wars in 8 worlds, with these: 3).

**Performance** (budget: War.step + army logic < 1 ms / tick on average with 3 wars; quiet machine): a total war with 465 soldiers among 700 units: `War.step` **0.057 ms/tick**
avg (worst tick 1.7 ms), the army logic about **0.6 ms/tick** (Units.step 0.90 ms with armies vs 0.29 without); `war.test` (8 kingdoms, 3 wars, ~300 soldiers): `War.step` 0.048 ms,
army logic 0.47 ms. On a machine loaded to ~15 the same runs show 0.10-0.23 ms / 0.9-2.6 ms - the performance assertions are timing-based and flake there. `aiTotalCheck` runs for
one kingdom in eight every 50 ticks (~free). `system.test --quick`: 12 / 12, max window average 0.96 ms/tick.

## 6. Known issues / notes

* **Weariness and natural deaths.** In a total war the soldiers who die of old age / plague (`cause` `age`, `disease`, `erase`, `lost`) are not war losses: a war of
  5000+ ticks (80+ years) used to wear both sides out to 95 and end in an «exhaustion» peace before the capitulation timer finished. Limited wars count everything as before.
* **Stalemate vs the timer.** `TW_STALEMATE` (6000 ticks without a change of hands) does not end a total war while the capitulation timer is running (`tw.sure > 0`): once
  the whole country is held nothing changes hands any more.
* **Capital-less state.** `tw.fell` keeps «the capital is held» after the government fled; if the capital city dies out (an occupied city can starve to 0 people) and every
  city that is left is held, the biggest one stands in. Otherwise the timer would drain and the war would end by exhaustion although the country is conquered.
* A **commanded** attacker is asked once; while the sheet is open the war is frozen (the loser's armies go home, nobody attacks), so there is no stuck state; the AI decides
  after 1800 ticks or when the player's command is released (`resolveCapitulation` is also callable from tests / scripts).
* `Kingdoms.annex(…, 'merge')` still moves the player's command to the winner; `resolveCap` clears `cmd` of a commanded loser first (the realm simply falls).
* The merge of a country is `Kingdoms.annex` (not changed); the vassal outcome raises the loser's stability to ≥ 45 so `vassalCheck` does not free it again within minutes.
* Known limits: the AI does not concentrate its armies (a wide empire raises up to 10 small armies, one per city, and can lose them piecemeal against a defender with allies);
  the AI picks on small neighbours (victim ≥ 24 people), which makes AI total wars «annexations of dwarfs»; timing-based assertions in other suites (`cities`
  performance, `world` / `regions` generation speed, `units` stress) flake when the machine is loaded - `cities` does so on the untouched base too.
* Merge notes: `src/23_ui.js` (war card / HUD / banner / capitulation sheet code, new functions only plus hooks in `updateCmd` / `cmdTap` / `stepBack`), `src/21_render.js`
  (+22 lines, `Render.cmd.deep` and the capital star), `src/style.css` (appended section), `tests/system.test.mjs` (one word). New files: `src/35_gfx_totalwar.js`,
  `tests/totalwar.test.mjs`, `tests/twlib.mjs`, this file.
