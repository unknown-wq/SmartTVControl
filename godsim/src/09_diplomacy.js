/* =====================================================================
 * 09_diplomacy.js — STAGE-1 STUB (no-ops). Replaced in stage 2. API: docs/CONTRACT.md §Diplomacy
 * ===================================================================== */

const Diplomacy = (() => {
  return {
    get(a, b) { return { a: Math.min(a, b), b: Math.max(a, b), opinion: 0, state: Const.REL.PEACE, since: 0, truceUntil: 0, causes: [] }; },
    opinion(a, b) { return 0; },
    state(a, b) { return Const.REL.PEACE; },
    atWar(a, b) { return false; },
    allied(a, b) { return false; },
    addOpinion(a, b, delta, why) {},
    declareWar(aggressor, defender, casus) { return null; },
    makeAlliance(a, b) { return false; },
    breakAlliance(a, b) { return false; },
    godWhisperWar(kid) { return false; },
    godPeace(kid) { return false; },
    neighbors(kid) { return []; },
    relationsOf(kid) { return []; },
    onKingdomCreated(k) {}, onKingdomDestroyed(kid) {},
    step(tick) {}, newWorld() {}, afterLoad() {},
  };
})();
