/* =====================================================================
 * 10_war.js — STAGE-1 STUB (no-ops). Replaced in stage 2. API: docs/CONTRACT.md §War
 * ===================================================================== */

const War = (() => {
  return {
    start(attackerKid, defenderKid, casus) { return null; },
    end(warId, how) {},
    get(id) { return S.wars.get(id) || null; },
    warsOf(kid) { return []; },
    active() { return []; },
    godPeace(kid) { return false; },
    armyOf(armyId) { return S.armies.get(armyId) || null; },
    step(tick) {}, newWorld() {}, afterLoad() {},
  };
})();
