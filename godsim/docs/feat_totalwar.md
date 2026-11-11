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
War.TOTAL = { MAX_ARMIES_K, MAX_ARMIES_WAR, MAX_ARMY, MAX_SOLDIERS, FRAC, WEAR, INFAMY, INFAMY_CLAIM, CAP_SHARE, CAP_ASK, CAP_HOLD, REST, AI_* }
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

@@TESTS@@

## 5. Balance and performance

@@BALANCE@@

## 6. Known issues / notes

@@NOTES@@
