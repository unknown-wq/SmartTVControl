/* =====================================================================
 * 09_diplomacy.js — STAGE-1 STUB (replaced by the full module in stage 2). API: docs/CONTRACT.md §3 + §8
 * ===================================================================== */

const Diplomacy = (() => {
  return {
    get(a, b) { return { a: Math.min(a, b), b: Math.max(a, b), opinion: 0, state: Const.REL.PEACE, since: 0, truceUntil: 0, causes: [] }; },
    opinion(a, b) { return 0; },
    state(a, b) { return this.atWar(a, b) ? Const.REL.WAR : Const.REL.PEACE; },
    /** truth about wars lives in War (S.wars); Diplomacy just forwards */
    atWar(a, b) { return War.atWar ? !!War.atWar(a, b) : false; },
    allied(a, b) { return false; },
    alliesOf(kid) { return []; },
    inTruce(a, b) { return false; },
    setTruce(a, b, untilTick) {},
    setState(a, b, state) {},
    canDeclare(a, b) { return { ok: true, reason: '' }; },
    addOpinion(a, b, delta, why) {},
    declareWar(aggressor, defender, casus, goals) { return War.declare ? War.declare(aggressor, defender, goals, casus) : null; },
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
