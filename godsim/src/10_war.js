/* =====================================================================
 * 10_war.js — STAGE-1 STUB (replaced by the full module in stage 2). API: docs/CONTRACT.md §8.2
 * ===================================================================== */

const War = (() => {
  return {
    atWar(a, b) { return false; },
    declare(aggKid, defKid, goalRegionIds, casus) { return null; },
    start(attackerKid, defenderKid, casus) { return null; },
    addGoal(warId, kid, regionId) { return false; },
    order(kid, armyIds, order) { return false; },
    armiesOf(kid) { return []; },
    score(warId, kid) { return 0; },
    peaceCost(warId, regionIds) { return 0; },
    peaceOffer(warId, fromKid, terms) { return { ok: false, accepted: false, reason: 'stub' }; },
    forcePeace(warId, terms) { return false; },
    potentialGoals(aggKid, defKid) { return []; },
    supply(armyId) { return 100; },
    setAutoPeace(on) {},
    end(warId, how) {},
    get(id) { return S.wars.get(id) || null; },
    warsOf(kid) { return []; },
    active() { return []; },
    godPeace(kid) { return false; },
    armyOf(armyId) { return S.armies.get(armyId) || null; },
    step(tick) {}, newWorld() {}, afterLoad() {},
  };
})();
