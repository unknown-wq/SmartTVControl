# Player diplomacy — actions, treaties, proposals (tool «Дипломатия»)

Mirrors the war flow («Выбираешь страну, затем …»): **pick your country → tap another → a compact pair card → every tap answers at once.**
The same acceptance code answers for the player and for the AI; nothing in the UI re-derives a rule.

Files: `src/09_diplomacy.js` (sim, DOM-free, deterministic via `R`), `src/24_ui_diplomacy.js` (`DiploUI`), `src/36_gfx_diplomacy.js` (13 icons through the
`GfxPlugins.icons` registry; `20_sprites.js` is untouched), small hooks in `src/23_ui.js` + `src/style.css`, two tiny API additions (`Kingdoms.release`, `War.join`).
Tests: `tests/diplomacy.test.mjs` (sim, 25 sections), `tests/ui_diplo.test.mjs` (real browser, 227 checks), `tests/politics.test.mjs` / `ui.test.mjs` / `ui2.test.mjs` adapted.

## 1. The player flow (UI)

1. **Kingdoms tab → tool «Дипломатия»** (5th tool of the tab; the war tool «Война» stays the default of the tab). Hint: «Выберите свою страну, затем другую».
2. **Tap your country** (a chip of the Kingdoms strip, a tap on its land / city / unit, or the button «Дипломатия» in the kingdom inspector) = the ACTOR
   (`Kingdoms.setCommanded`, exactly one commanded kingdom; the AI no longer plays it). The dock is replaced by a slim HUD: flag + name, ✉ badge,
   «О королевстве», ✕ (release), a **contacts strip** (flag chips: opinion pip, status icons: war / vassal / ally / pact / trade / marriage) and a hint.
   The map switches to the political view (restored on release); the actor's land is outlined.
3. **Tap another country** on the map (or a flag chip) = the **pair card**: both flags + names, strength ratio («Сила ×0.6 · слабее · соседи»), opinion bar with the
   mood word and the 3 strongest causes (tap the bar for all of them), **status chips** (Мир / Союз / Пакт · N л. / Перемирие / Торговля / Брак / Вассал / Сюзерен /
   Гарантии / Эмбарго / Война), «О стране» (opens that kingdom's inspector; closing it brings the same card back), and the **actions as big buttons** (≥ 66 px):
   title, the forecast of the answer («Охотно согласятся / Согласятся / С трудом / Почти согласны / Откажут» with a colour and a bar), the cost, or — dimmed, at the end under
   «Сейчас недоступно» — the reason why not («Идёт война», «Пакт уже действует», …). Available actions first; groups: treaty / give / force / war / vassal / break.
4. **A tap answers immediately.** A strip at the top of the card: green «Принято» + what happened, red «Отказ» + the reason, yellow «Отправлено» (the proposal waits). The flag
   hops / shakes, the ⇄ pair icon bumps. Actions with terms open an inline panel: **Пакт** (10 / 20 / 40 years), **Подарок** (goods from the capital with − / + / «всё» steppers,
   total value and the expected opinion gain), **Требование** (Дань ×3 sizes | Регион (lit on the map) | Вассалитет; the go button turns into a red «Рискнуть: …» when the
   forecast is a refusal), **Брак** (the two heirs by name), **Позвать в войну** (which war, when there are several). **Breaking a treaty needs a second tap** («Точно? …», relaxes after
   3.5 s). A refused demand shows «Объявить войну» inside the strip (casus `ultimatum`).
5. **INBOX.** A proposal *to the commanded kingdom* (`Diplomacy.inbox(kid)`) is never auto-accepted: a toast, a badge on the HUD ✉ and a floating «Почта» button (visible in
   the card too). Tap → modal «Предложения»: one card per proposal (sender, offer, opinion, years left, «отказ — повод для войны» for ultimatums) with **[Принять] [Отклонить]**; the modal
   closes by itself when the list is empty.
6. **Back / release never leaves stuck UI state**: panel → card → HUD → release (✕, Esc, a tap on the sea). Switching tool, the war tool taking over, switching actor,
   a new world, a load, the death of the actor or of the partner, an open modal — all end clean (`UI.diplo` snapshot, tested).
   War-tool tap semantics are unchanged; the two tools are mutually exclusive (one commanded kingdom).
7. **Kingdom inspector «Дипломатия»** keeps working (neighbours, bars, causes) and gains **treaty chips** per neighbour and a «Дипломатия» / «Договоры» button.
   Kingdoms-tab hints updated; the powers' group formerly called «Дипломатия» is now «Воля бога» (Шёпот войны, Мир, Раскол) so the names do not clash.

`UI.diplo` (read-only snapshot for tests): `{kid, other, mode:'hud'|'card'|'', sub, owns, inbox, armed, modal, causesOpen, actions[], result}`;
`UI.DiploUI.select(kid) / openPair(kid) / closeCard() / back() / release() / openInbox()`.

## 2. Sim API (`Diplomacy`)

| call | returns / does |
|---|---|
| `propose(from, to, kind, terms)` | `{ok, accepted, pending, reason, effects[], causes[], id, margin, kind}`. Works for the player and the AI. A proposal that needs an answer and goes **to** a commanded kingdom is queued (`pending:true`); everything else is decided at once. |
| `respond(id, accept)` | answers an inbox entry (same `plan()` check again: things may have changed). |
| `inbox(kid)` | `[{id, from, to, kind, terms, left, title, text, icon, danger}]` — only for the commanded kingdom; TTL 900 ticks, ≤ 6 per recipient, resolved by the AI when the player lets the kingdom go. |
| `actionsFor(from, to)` | `[{kind, label, icon, group, available, reason, hint, tone, odds, cost, danger, options?, data?}]` — everything the card shows. |
| `card(a, b)` | `{opinion, mood, causes[], chips[], contact, power{a,b,ratio}, actions[]}` — one call per UI refresh (≈ 0.08 ms). |
| `plan(kind, from, to, terms)` | pure availability + acceptance evaluator `{ok, reason, accept, score, need, margin, causes[], note, data}` used by `propose`, `actionsFor` and the AI. |
| `callAllies(kid, warId)` | asks every ally to join a war (same judge as the `call` action). |
| `treaties(a, b)`, `pactLeft`, `tradeOn`, `embargoLeft`, `marriageOf`, `guarantorOf`, `hasUltimatum` | read-only queries. `relationsOf(kid)` gained `pact, trade, marriage, embargo, guarantee`. |

Kinds: `alliance, break_alliance, pact, break_pact, trade, cancel_trade, marriage, guarantee, break_guarantee, gift, demand, call, peace, release, tribute, annex,
break_free, embargo, lift_embargo`. Bus events: `diploProposal(entry)`, `diploResolved(entry, ok, auto)`, `treatyMade(kind, ka, kb, sent)`, `treatyBroken(kind, ka, kb, expired)`;
`War` emits `warJoined(war, kid, onKid)`, `Kingdoms` emits `vassalFree(vassal, overlord)`.

**Acceptance is deterministic**: the target accepts when `score >= need` (opinion plus named causes), so the hint shown before the tap *is* the answer. Randomness (`R`) is used only by the AI.
`margin = score − need` → words / colours: ≥ 14 «Охотно согласятся» · ≥ 4 «Согласятся» · ≥ 0 «С трудом» · ≥ −10 «Почти согласны» (warn) · else «Откажут».

## 3. Treaties — rules, costs, constants

State is sparse and JSON-safe in `S.mod.diplomacy` (`tr["a_b"]` with a < b, `inbox[]`, AI cooldowns `dcd/acd/cd`, `lg` log throttle, `ult` ultimatums, `gift`, `vtc`, `call`, `rf` refusal memory); old saves
load (`dmod()` normalises). Relations (`S.rels`) keep their literal key order — treaties are *not* stored on `Relation`.
`tr`: `{pact, pb, trade, emb, eby, marr:{t,ua,na,ub,nb}, gu}`.

| kind | available when | target accepts when `score ≥ need` | effect / cost |
|---|---|---|---|
| **alliance** | no war / vassal link / clash of allies | score = opinion (+10 common enemy, +14 marriage, +4 trade, +4 pact, −min(20,(infamy−20)·0.6), −20 warlike ruler) ≥ **52** | alliance; `break_alliance`: opinion −18; **betrayal** (breaking while in a common war): −40, infamy +8 |
| **pact** (non-aggression, 10/20/40 y) | no war, not allied / vassal | 0.8·opinion (+10 weaker proposer, +8 target busy, +10 marriage, +4 trade, −25 claims, −20 hungry ruler) ≥ **5 + (years−10)·0.3** | a **long truce on the existing mechanism** (`rel.truceUntil = max(truce, pact)`, `pb` restores the old truce): `War.canDeclare` is untouched; god / `rebel` casus ignore it. Opinion +4, structural cause +6 while it lasts. Break: opinion −25, infamy +6, truce restored. Expiry is logged for the player. |
| **trade** | no war, no embargo, a border or both sides have markets | opinion (+8 allies, +4 pact, +6 markets both sides) ≥ **−10** | a caravan every **120 ticks** into a border/market city: `1 + min(3, markets) (+1 allies/vassal)` of each of the people's goods (humans food/wood, orcs iron/stone, elves wood/gold); structural opinion +8; war, embargo or lost routes cancel it. `cancel_trade`: −5. |
| **gift** | not at war; always accepted | — | goods from the capital stock (`Cities.withdraw` → `deposit`, limited by the receiver's room, reserve 40/30/15/8/2 stays); value food 1 · wood 1.4 · stone 1.8 · iron 3.2 · gold 7; opinion `+clamp(0.9·√value, 1, 14)`, total live bonus ≤ **30**. |
| **demand** (ultimatum) | no war / truce / pact, a common border, not allied or vassal-linked, you fight < 3 wars; tribute needs a surplus to take, a region must border your land and is never the capital | the **power ratio** `power(you)/power(them)` vs `need` (not opinion): tribute ×1.35 / 1.8 / 2.5 (takes 15 / 30 / 55 % of the surplus), region 2.0 + 0.35·cities + 0.08·value (capital never), vassalage 3.2 + 0.4·(cities−1); ×(1 + 0.35·war − 0.2·peace) of the target's policy, ×0.85 if it is at war / opinion > 30, ×1.15 if opinion < −30 | accepted → goods / region (`Regions.setOwner`) / vassal (`overlordId`); refused → opinion −10 «Отказ на ультиматум» and a fresh **casus `ultimatum`** for 1200 ticks, offered as «Объявить войну» (`declareWar(…, 'ultimatum')`; the AI judges it as justified only while fresh). |
| **marriage** | both rulers have an unmarried adult child | opinion (+8 allies, +5 pact, +3 trade, −6 different peoples) ≥ **28** | the heirs are married (treaty level; unit `spouseId` untouched), story in `Hist` + log, opinion +14 (structural), alliance score +14, pact +10; the record dissolves when a spouse dies; a dying dynasty leaves the relatives a claim. |
| **guarantee** | not at war, not vassal | opinion (−15 if the guarantor has claims) ≥ **−20** | opinion +6; when the guaranteed kingdom is attacked and the guarantor is free (not allied to the aggressor, < 2 wars) it **joins the war** (`War.join`); otherwise the guarantee is void: −20 «Гарантия не выполнена». `break_guarantee`: −6. |
| **call** (allies into a war) | the target is your ally, a war of yours is running that it is not in, it is not allied to your foes, fights < 2 wars, was not asked recently | opinion (+18 defending, +4 just casus, −14 grab, +≤12 hatred of the foes, ±10 ruler's nature, −12 unstable) ≥ **40** | the ally joins (`War.join`), treaties with the new enemies are cleaned like at a declaration. A refusal costs a little opinion and is remembered (`rf`) so the AI does not nag. |
| **peace** (white) | at war | `War` peace judge (`proposePeace`) | white peace through the existing war machinery. |
| **embargo / lift** | not at war, not allied / vassal | unilateral | opinion −15, trade cancelled, 20 years, structural −12; `lift_embargo` is free. |
| **vassal management** | you are the overlord | conditions, **no lottery** | `release` (opinion +15 from the freed, no penalty), `tribute` (25 % of the surplus, opinion −8, stability −2, cooldown 1200 ticks), `annex` (after **1200** ticks of vassalage; a different culture needs opinion ≥ 40; the cities join, unrest). `break_free` (vassal side): after 600 ticks, opinion −30, a rebel war may follow. |

Interplay: a declaration / a `War.join` cancels pact, trade and the guarantee with the new enemies (`warEndsTreaties`); alliances clear a pact; a vassal does not sign pacts; embargoes cancel trade;
`setTruce` is pact-aware; the casus `ultimatum` is treated like a claim by the war score and the call judge. The total-war agent's `War` code is not modified beyond `War.join`.

## 4. AI

`aiTick` phase `ph % 10 === 3`: a kingdom (not commanded, not a vassal, ruler alive, tick ≥ **900** and ≥ 400 ticks old) picks **one** weighted candidate: call allies (4), trade (3), pact (2), gift (1), marriage (1)
— each only if `plan()` says the target accepts —, then waits 500–900 ticks (800 after a refusal, 1200 when pending, 200 with nothing to do). Alliances use the rewritten `aiAlliance` through the same `plan()`; a bad alliance is broken
with 40 % per check. A strong AI may issue an ultimatum before a war (`aiUltimatum`: paid / refused = a just war / waits for the player). Proposals to the commanded kingdom go to the inbox, never auto-accepted.
**Spam control**: routine journal lines are throttled to ≤ 1 per kingdom per 20 ticks (`say()`); events the player takes part in are always written.
Measured (4 worlds × 15 000 ticks): pacts 41, trades 38, gifts 6, marriages 29, alliances 13, wars stay lively, ≤ 1 line / 20 ticks / kingdom.

## 5. Tests and numbers (quiet machine)

* `node tests/diplomacy.test.mjs` — **25/25**: state shape + old saves, every action (available / reasons / acceptance / effects), pact-as-truce vs `War.canDeclare`, trade caravans, gifts, demands + ultimatum casus, vassals, marriage, guarantee,
  call to arms, inbox (TTL, cap, release), AI use + spam control, determinism (same seed, save → load → identical continuation), invariants. Perf: `Diplomacy.step` **0.03 ms/tick** (best-window worst tick ≈ 1 ms, 1500 units / 7 kingdoms),
  `card(a,b)` with all actions **0.08 ms**.
* `node tests/politics.test.mjs` — **30/30** (adapted: allowed casus `ultimatum`; the drift loop commands the two kingdoms so the new AI treaties do not mask the opinion drift it measures). `--quick` "wars do happen" is a pre-existing flake of that suite.
* `node tests/ui_diplo.test.mjs` — **227 checks** in a real Chromium with CDP touches: 390×844@2×, 360×640, 320×568, 844×390 (HUD, card, strip, panels, inbox modal, inspector: no sideways overflow, floating buttons clear of the top bar / sheet / each other,
  thumb-sized controls, footer on screen), the whole flow of §1, vassals, war via ultimatum, ✕ / Esc / sea tap / tool switch / war tool / actor switch / new world / save+load / deaths all leave no stuck state, 164-step random fuzz, `UI.update` ≤ 0.2 ms with HUD / card / panel / inbox.
  Screenshots: `--shots=DIR` (default `/tmp/godsim-diplo-ui-shots`).
* `ui.test` expects 5 tools in the Kingdoms tab; `ui2.test` too (war tool semantics untouched: 289/290 — the one failure «tap on a city selects its kingdom» fails identically on the baseline).

## 6. Known issues / limits

* The AI gifts rarely (weight 1, once per 1800 ticks per pair). Alliances/vassals interplay with total wars is rule-based, not simulated in depth.
* The horn icon of «Позвать в войну» is code-drawn and plain; icons are 14×14 glyphs through the registry.
* The «call to arms» panel (several wars at once) cannot be reached with fewer than 4 kingdoms in a real game; it is covered by the sim test and the single-war direct path by the UI test.
* Kingdoms strip in the dock refreshes once a second (existing behaviour), so a chip of a just-founded kingdom may appear a moment later.
* Existing perf-type suites (`cities`, `powers`, `war`, `render2`, `politics`) are timing-sensitive: under a loaded box (load ≥ 10) they fail at random, also on the baseline.

## 7. Merge notes

* Branch is based on the lead's plugin-infrastructure commit (`36e3f75`); `godsim/` came from `main` fast-forwarded to `claude/relaxed-keller-n4fq7q` — merge as an ordinary branch (no history rewriting).
* **Shared files, all small and localised** (another agent edits them too):
  * `src/23_ui.js` (~16 hunks, insertions at hook points): `GROUP_LABEL.diplomacy` → «Воля бога» and the Kingdoms hint text (lines ≈ 37–42); `selectTool` (release when leaving the tool + the tool hint); chip tap in the Kingdoms strip (`state.tool === 'diplomacy'`);
    kingdom inspector (`kbtns` class, «Дипломатия» button, `treatyChips`, longer slot signature); `renderSheet` / `closeInspector` (`DiploUI.yieldSheet()` / `resume()`, extra classes removed); `handleTap` / `handlePaint` (route to `DiploUI`);
    `commandKingdom` (releases the diplomacy actor); Esc handler; `DiploUI.init({...kit})` after `initCommandHooks()`; `DiploUI.update()` in the 250 ms refresh; `DiploUI.reset()` in `onWorldReplaced`; getters `UI.DiploUI` / `UI.diplo`.
    `DiploUI` is defined *after* `UI` (file order), so `UI` only touches it inside functions / getters — never at load time.
  * `src/style.css`: one block appended at the end («DIPLOMACY TOOL»), plus nothing else.
  * `src/10_war.js`: `joinWar()` after `addGoal` + `join: joinWar` in the export (21 lines, no existing code changed). `src/08_kingdoms.js`: `release(vassalKid)` + export (18 lines).
  * `src/09_diplomacy.js`: ~1400 added lines in one block «PLAYER DIPLOMACY» plus small edits of `setTruce`, `canDeclare`, `onWarDeclared`, `declareWar`, `relationsOf`, `aiAlliance`, `aiTick`, lifecycle hooks. The total-war agent's `War` logic is not touched.
* Tests touched: `politics.test.mjs` (6 lines), `ui.test.mjs` / `ui2.test.mjs` (tool count 5). `docs/CONTRACT.md`, `STATUS.md`, `REQUESTS.md` are **not** edited — suggested STATUS line: «Player diplomacy: tool «Дипломатия», pair card, 19 actions, inbox; see docs/feat_diplomacy.md».
* `index.html` is generated and not committed; rebuild with `node build.mjs`.
