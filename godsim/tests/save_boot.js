// Bootstrap for tests/save.browser.mjs. Appended INSIDE the game scope by
//   node build.mjs --stubs --no-main --extra=tests/save_boot.js --out=/tmp/godsim-save.html
// Exposes window.__sv with the sim modules so the page can be driven with page.evaluate (real localStorage, real TextEncoder, real JIT).
(function () {
  function stepN(n) { for (let i = 0; i < n; i++) Sim.step(); }
  function hash(str) { let h = 0x811c9dc5 | 0; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return (h >>> 0).toString(16); }
  function state() {
    return hash(JSON.stringify([S.tick, S.stats, R.getState(), [...S.units.values()], [...S.cities.values()], [...S.kingdoms.values()], [...S.buildings.values()], [...S.rels.entries()], S.eff, S.mod,
      Array.from(S.tile), Array.from(S.owner), Array.from(S.bld), Array.from(S.fire), Array.from(S.res), Array.from(S.amt)]));
  }
  window.__sv = { S, Sim, Save, Units, World, Cities, Util, Const, R, stepN, hash, state };
})();
