// Regression test for the per-frame cost of cosmetic effects + sprite warm-up (the art pass once made battles / births 1.5-5x slower).
//   node tests/fxperf.mjs [--nobuild] [--seed=4]
// Builds the REAL game to /tmp/godsim-fxperf.html (never touches index.html), grows a 1500-unit world with the sim only, then for three views
// (zoom 6 culture, zoom 8 political, zoom 14 city) compares Render.stats.drawMs with an empty Fx list against ~100 mixed live Fx
// (hearts, souls, level-ups, banners, hits, sparks, dust, ash, smoke, fire spread over the visible map, animated every frame).
// Budgets are generous (software GL, shared CPU): the baked-frame cache makes ~100 Fx cost well under 1.5 ms; the old per-pixel code cost 15-20 ms.
// Also checks the cold start (first 60 frames after loading a big world) and that nothing logs errors.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const HTML = '/tmp/godsim-fxperf.html';
if (!args.nobuild) execFileSync('node', [path.join(root, 'build.mjs'), `--out=${HTML}`, '--check'], { cwd: root, stdio: 'pipe' });

let pass = 0, fail = 0;
const check = (name, cond, info) => { if (cond) { pass++; console.log('  ok   ' + name + (info !== undefined ? '  (' + info + ')' : '')); } else { fail++; console.log('  FAIL ' + name + (info !== undefined ? '  (' + info + ')' : '')); } };

const b = await launch({ url: 'file://' + HTML, width: 390, height: 844, dpr: 2 });
const E = (fn, arg) => b.eval(fn, arg);
for (let i = 0; i < 60; i++) { if (await E(() => !!window.__god)) break; await b.sleep(100); }

const setup = await E(async ({ seed }) => {
  const g = window.__god;
  g.Main.newWorld({ seed, w: 96, h: 96, populate: true }); g.setSpeed(0);
  let guard = 0;
  while (g.S.units.size < 1450 && g.S.tick < 30000 && guard++ < 400) { g.step(100); await new Promise(r => setTimeout(r, 0)); }
  g.Fx.list.length = 0;
  return { tick: g.S.tick, units: g.S.units.size, cities: g.S.cities.size };
}, { seed: +(args.seed || 4) });
console.log('world:', JSON.stringify(setup));
check('world has ~1500 units', setup.units >= 1300, String(setup.units));

// ---- cold start: save the grown world, reload it in a fresh page-state and time the first frames at a busy view
const world = await E(() => window.__god.Save.serialize());
await E((d) => { const g = window.__god; g.setSpeed(0); g.Save.deserialize(d); g.Main.worldReplaced('load'); g.setSpeed(0); const c = g.Main.largestSettlement() || { x: 48, y: 48 }; g.Render.setMode(1); g.Render.setCamera(c.x, c.y, 8); }, world);
const cold = await E(() => new Promise(res => { const ms = []; let n = 0; function f() { ms.push(window.__god.Render.stats.drawMs || 0); if (++n < 60) requestAnimationFrame(f); else res({ avg: ms.reduce((a, x) => a + x, 0) / ms.length, worst: Math.max(...ms) }); } requestAnimationFrame(f); }));
console.log(`cold start, first 60 frames at zoom 8 political: avg ${cold.avg.toFixed(2)} ms  worst ${cold.worst.toFixed(1)} ms`);
check('cold start: first 60 frames average < 12 ms (was 19 ms with eager sprite building)', cold.avg < 12, cold.avg.toFixed(2));

// ---- mixed Fx load
const MIX = [['heart', 14, 1.7], ['soul', 8, 2], ['levelup', 6, 1.3], ['flagraise', 2, 2.4], ['blood', 22, 0.4], ['spark', 10, 0.3], ['dust', 8, 0.7], ['ash', 6, 1.4], ['smoke', 12, 1], ['fire', 12, 0.6]];
await E((mix) => {
  const g = window.__god, F = g.Fx;
  g.setSpeed(0);
  F.update = () => {};                                    // we animate the list ourselves
  window.__fxLoad = { on: false, mix };
  const mkList = () => { const r = g.Render.visibleRect(), L = []; let k = 0; for (const [type, n, ttl] of mix) for (let i = 0; i < n; i++, k++) L.push({ type, x: r.x0 + 1 + ((k * 7.31) % Math.max(1, r.x1 - r.x0 - 2)), y: r.y0 + 1 + ((k * 3.77) % Math.max(1, r.y1 - r.y0 - 2)), ttl, age: (k * 0.137) % ttl, color: type === 'flagraise' ? ['#e53935', '#1e88e5', '#43a047'][k % 3] : undefined }); return L; };
  (function tick() {
    const s = window.__fxLoad;
    if (s.on) { if (!s.list || s.list.length !== F.list.length || !F.list.length) { s.list = mkList(); F.list.length = 0; for (const f of s.list) F.list.push(f); } for (const f of s.list) { f.age += 0.03; if (f.age >= f.ttl) f.age -= f.ttl; } }
    else F.list.length = 0;
    requestAnimationFrame(tick);
  })();
}, MIX);
const measure = (n = 150) => E((n) => new Promise(res => { let i = 0, sum = 0, worst = 0; function f() { const d = window.__god.Render.stats.drawMs || 0; sum += d; if (d > worst) worst = d; if (++i < n) requestAnimationFrame(f); else res({ avg: sum / i, worst, fx: window.__god.Fx.list.length }); } requestAnimationFrame(f); }), n);
const views = [['zoom 6 culture', 2, 6], ['zoom 8 political', 1, 8], ['zoom 14 city', 0, 14]];
for (const [label, mode, zoom] of views) {
  await E(({ mode, zoom }) => { const g = window.__god; const c = g.Main.largestSettlement() || { x: 48, y: 48 }; g.Render.setMode(mode); g.Render.setCamera(c.x, c.y, zoom); window.__fxLoad.on = false; }, { mode, zoom });
  await b.sleep(1200);
  const off = await measure();
  await E(() => { window.__fxLoad.on = true; window.__fxLoad.list = null; });
  await b.sleep(1500);                                      // lets every animation frame get baked once
  const on = await measure();
  const delta = on.avg - off.avg;
  console.log(`${label.padEnd(18)} Fx off ${off.avg.toFixed(2)} ms | ${on.fx} live Fx ${on.avg.toFixed(2)} ms (worst ${on.worst.toFixed(1)}) | delta ${delta.toFixed(2)} ms`);
  check(label + ': ~100 live Fx add < 2.5 ms/frame (baked frames, one drawImage each)', delta < 2.5, delta.toFixed(2) + ' ms');
  check(label + ': draw with ~100 Fx < 2x the draw without + 1 ms', on.avg < off.avg * 2 + 1, on.avg.toFixed(2) + ' vs ' + off.avg.toFixed(2));
}
check('no page errors', b.errors.length === 0, b.errors[0] || '');
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
