// Frame-cost comparison for the poison power, same scenes as tests/perf.mjs (1500 units, 3 wars, x4, iPhone viewport, software GL), parametrised by build:
//   node tests/power_poison_perf.mjs [--html=/tmp/godsim-poison-perf.html] [--clouds=0|14] [--seconds=8] [--seed=4] [--label=name] [--json=/tmp/x.json]
//   without --html the CURRENT sources are built to /tmp/godsim-poison-perf.html (never index.html). Pass --html=<build of the original sources> to get the "before" numbers.
//   --world=/tmp/x.json  generates the 1500-unit world once, saves it there and loads the SAME save in every later run / build (identical scenes; the sim's perf adaptation is wall-clock dependent, so a fresh world differs per run)
//   --micro  contention-proof mode: freezes the page's own loops, then times 200 single Render.draw calls and 200 single Sim.step ticks per scene and reports min / p10 / median
//            (on a shared machine wall-clock averages are useless; low percentiles of short calls approximate the uncontended cost)
//   --clouds=N puts N long-lived clouds in view in every scene (the sim runs them too: exposure scans, damage, ecology) -> "with the effect in view".
// Prints one line per scene; with --json the numbers for scripts/compare. The comparison itself (within +10 %) is done by the caller (see docs/feat_poison.md).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

// machine-wide CPU busy fraction between two samples (the box is shared with other agents: a scene is only trustworthy when the others are quiet)
const cpuSample = () => { const l = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number); return { idle: l[3] + (l[4] || 0), total: l.reduce((a, c) => a + c, 0) }; };
const busyBetween = (a, c) => 1 - (c.idle - a.idle) / Math.max(1, c.total - a.total);
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
async function waitQuiet(maxMs = 15000, limit = 0.4) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) { const a = cpuSample(); await sleepMs(1500); if (busyBetween(a, cpuSample()) < limit) return true; await sleepMs(2000); }
  return false;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const SEC = +(args.seconds || 8), SEED = +(args.seed || 4), NCL = +(args.clouds || 0), LABEL = String(args.label || (NCL ? NCL + ' clouds' : 'no clouds'));
let html = args.html ? String(args.html) : '/tmp/godsim-poison-perf.html';
if (!args.html) execFileSync('node', [path.join(root, 'build.mjs'), '--out=' + html], { cwd: root, stdio: 'pipe' });

const b = await launch({ url: 'file://' + html, width: 390, height: 844, dpr: 2 });
const E = (fn, arg) => b.eval(fn, arg);
await b.cdp.send('Performance.enable');
/** CDP counters of the page's main thread: ThreadTime = CPU seconds actually used by the thread (unlike wall-clock frame times it does not grow when other processes steal the CPU) */
const cdpMetrics = async () => { const { metrics } = await b.cdp.send('Performance.getMetrics'); const o = {}; for (const m of metrics) o[m.name] = m.value; return o; };
for (let i = 0; i < 80; i++) { if (await E(() => !!window.__god)) break; await b.sleep(100); }
const hasPoison = await E(() => !!window.__poisonGfx);
if (NCL && !hasPoison) { console.log('this build has no poison plugin: --clouds ignored'); }

const worldFile = args.world ? String(args.world) : '';
let setup;
if (worldFile && fs.existsSync(worldFile)) {
  setup = await E((d) => { const g = window.__god; g.setSpeed(0); const ok = g.Save.deserialize(d); g.Main.worldReplaced('load'); g.setSpeed(0); return { loaded: ok, tick: g.S.tick, units: g.S.units.size, wars: g.War.active().length, cities: g.S.cities.size }; }, fs.readFileSync(worldFile, 'utf8'));
} else {
  setup = await E(async ({ seed }) => {
    const g = window.__god;
    g.Main.newWorld({ seed, w: 96, h: 96, populate: true }); g.setSpeed(0);
    let guard = 0;
    while (g.S.units.size < 1480 && g.S.tick < 30000 && guard++ < 400) { g.step(100); await new Promise(r => setTimeout(r, 0)); }
    const ks = [...g.S.kingdoms.values()].filter(k => k.alive !== false);
    for (const k of ks) { if (g.War.active().length >= 3) break; if (g.War.warsOf(k.id).length) continue; try { g.Diplomacy.godWhisperWar(k.id); } catch (e) { /* ignore */ } }
    g.step(40);
    return { tick: g.S.tick, units: g.S.units.size, wars: g.War.active().length, cities: g.S.cities.size };
  }, { seed: SEED });
  if (worldFile) fs.writeFileSync(worldFile, await E(() => window.__god.Save.serialize()));
}
console.log(`[${LABEL}] ${path.basename(html)} world: ${JSON.stringify(setup)}`);

/** put n long-lived clouds in the current view (around cities / the camera) */
const place = (n) => E((n) => {
  const g = window.__god, S = g.S, V = g.Render.visibleRect();
  if (!window.__poisonGfx || n <= 0) { if (S.eff.clouds) S.eff.clouds.length = 0; return 0; }
  S.eff.clouds = [];
  const cities = [...S.cities.values()].filter(c => c.x >= V.x0 && c.x <= V.x1 && c.y >= V.y0 && c.y <= V.y1).sort((a, c) => c.pop - a.pop);
  const t = S.tick;
  for (let i = 0; i < n; i++) {
    const c = cities[i % Math.max(1, cities.length)];
    const r = 2.5 + (i % 4), a = i * 2.4;
    const x = c ? c.x + 0.5 + Math.cos(a) * (1 + (i >> 1) % 4) : V.x0 + 2 + (i * 5.3) % Math.max(1, V.x1 - V.x0 - 4);
    const y = c ? c.y + 0.5 + Math.sin(a) * (1 + (i >> 1) % 4) : V.y0 + 2 + (i * 3.7) % Math.max(1, V.y1 - V.y0 - 4);
    S.eff.clouds.push({ id: i + 1, x, y, r, r0: r, dens: 1, d0: 1, t0: t, until: t + 40000, dx: 0.004 * Math.cos(a), dy: 0.004 * Math.sin(a), nt: t + 100000, k: 0, f: 0 });
  }
  return S.eff.clouds.length;
}, n);

async function measure(label, prep) {
  await E(prep);
  await place(NCL);
  const quiet = await waitQuiet();
  await b.sleep(900);
  const c0 = cpuSample(), m0 = await cdpMetrics();
  const r = await E(async (sec) => {
    const g = window.__god;
    g.setSpeed(4);
    const s0 = { frames: g.stats.frames, ticks: g.stats.ticks };
    const t0 = performance.now();
    const samples = [], frameTimes = [];
    let last = performance.now();
    await new Promise(res => {
      const f = () => {
        const now = performance.now(); frameTimes.push(now - last); last = now;
        if (frameTimes.length % 20 === 0) samples.push({ frameMs: g.stats.frameMs, simMs: g.stats.simMs, draw: g.Render.stats.drawMs, prof: Object.assign({}, g.Sim.profile), perf: Object.assign({}, g.S.perf) });
        if (now - t0 < sec * 1000) requestAnimationFrame(f); else res();
      };
      requestAnimationFrame(f);
    });
    const dtSec = (performance.now() - t0) / 1000;
    const out = { secs: dtSec, frames: g.stats.frames - s0.frames, ticks: g.stats.ticks - s0.ticks, units: g.S.units.size, clouds: g.S.eff.clouds ? g.S.eff.clouds.length : 0, samples, frameTimes };
    g.setSpeed(0);
    return out;
  }, SEC);
  const m1 = await cdpMetrics(), busy = busyBetween(c0, cpuSample());
  const cpuFrame = (m1.ThreadTime - m0.ThreadTime) * 1000 / Math.max(1, r.frames), scriptFrame = (m1.ScriptDuration - m0.ScriptDuration) * 1000 / Math.max(1, r.frames);
  const avg = (k) => r.samples.reduce((a, s) => a + s[k], 0) / r.samples.length;
  const prof = {}; for (const k of Object.keys(r.samples[0].prof)) prof[k] = +(r.samples.reduce((a, s) => a + s.prof[k], 0) / r.samples.length).toFixed(3);
  const ft = r.frameTimes.slice(5).sort((a, c) => a - c);
  const res = { label, fps: +(r.frames / r.secs).toFixed(1), tickRate: +(r.ticks / r.secs).toFixed(1), frameCpu: +avg('frameMs').toFixed(2), sim: +avg('simMs').toFixed(2), draw: +avg('draw').toFixed(2), powers: prof.Powers, simTick: prof.total, p95: +ft[(ft.length * 0.95) | 0].toFixed(1), units: r.units, clouds: r.clouds, busy: +busy.toFixed(2), quiet, cpuFrame: +cpuFrame.toFixed(2), scriptFrame: +scriptFrame.toFixed(2) };
  console.log(`[${LABEL}] ${label.padEnd(18)} main-thread CPU ${String(res.cpuFrame).padStart(5)} ms/frame (script ${res.scriptFrame}) | wall: fps ${String(res.fps).padStart(5)} | ticks/s ${String(res.tickRate).padStart(5)} | frame ${String(res.frameCpu).padStart(5)} ms = sim ${res.sim} + draw ${res.draw} | sim ${res.simTick} ms/tick (Powers ${res.powers}) | rAF p95 ${res.p95} | clouds ${res.clouds}, units ${res.units} | machine busy ${Math.round(busy * 100)}%${busy > 0.8 ? ' NOISY' : ''}`);
  return res;
}
const SCENES = [
  ['whole map', () => { const g = window.__god; g.Render.setMode(0); g.Render.setCamera(48, 48, g.Render.minZoom()); }],
  ['whole, political', () => { const g = window.__god; g.Render.setMode(1); g.Render.setCamera(48, 48, g.Render.minZoom()); g.Render.showAllOrders = true; }],
  ['zoom 8 political', () => { const g = window.__god; const c = g.Main.largestSettlement() || { x: 48, y: 48 }; g.Render.setMode(1); g.Render.setCamera(c.x, c.y, 8); }],
  ['zoom 14 city', () => { const g = window.__god; const c = g.Main.largestSettlement() || { x: 48, y: 48 }; g.Render.setMode(0); g.Render.setCamera(c.x, c.y, 14); }],
  ['zoom 6 culture', () => { const g = window.__god; const c = g.Main.largestSettlement() || { x: 48, y: 48 }; g.Render.setMode(2); g.Render.setCamera(c.x, c.y, 6); }],
];
if (args.micro) {
  await E(() => { window.requestAnimationFrame = () => 0; });          // the page's own loop stops after its current frame: no background load, we drive Render.draw / Sim.step ourselves
  await b.sleep(500);
  const micro = [];
  for (const [label, prep] of SCENES) {
    await E(prep);
    await place(NCL);
    const r = await E(() => {
      const g = window.__god, draws = [], sims = [];
      const q = (a, p) => { const c = a.slice().sort((x, y) => x - y); return c[Math.min(c.length - 1, Math.floor(c.length * p))]; };
      for (let i = 0; i < 40; i++) g.Render.draw(0.5, performance.now());
      for (let i = 0; i < 200; i++) { const t0 = performance.now(); g.Render.draw(0.5, performance.now()); draws.push(performance.now() - t0); }
      for (let i = 0; i < 60; i++) g.Sim.step();
      for (let i = 0; i < 200; i++) { const t0 = performance.now(); g.Sim.step(); sims.push(performance.now() - t0); }
      return { draw: [q(draws, 0), q(draws, 0.1), q(draws, 0.5)], sim: [q(sims, 0), q(sims, 0.1), q(sims, 0.5)], powers: g.Sim.profile.Powers, clouds: g.S.eff.clouds ? g.S.eff.clouds.length : 0, units: g.S.units.size };
    });
    const f = (a) => a.map(x => x.toFixed(2)).join(' / ');
    console.log(`[${LABEL}] ${label.padEnd(18)} Render.draw min/p10/median ${f(r.draw)} ms | Sim.step min/p10/median ${f(r.sim)} ms (Powers EMA ${r.powers.toFixed(4)}) | clouds ${r.clouds}, units ${r.units}`);
    micro.push({ label, ...r });
  }
  console.log(`[${LABEL}] page errors: ${b.errors.length}`);
  if (args.json) fs.writeFileSync(String(args.json), JSON.stringify({ label: LABEL, html, micro }, null, 1));
  await b.close();
  process.exit(b.errors.length ? 1 : 0);
}
const results = [];
results.push(await measure('whole map', () => { const g = window.__god; g.Render.setMode(0); g.Render.setCamera(48, 48, g.Render.minZoom()); }));
results.push(await measure('whole, political', () => { const g = window.__god; g.Render.setMode(1); g.Render.setCamera(48, 48, g.Render.minZoom()); g.Render.showAllOrders = true; }));
results.push(await measure('zoom 8 political', () => { const g = window.__god; const c = g.Main.largestSettlement() || { x: 48, y: 48 }; g.Render.setMode(1); g.Render.setCamera(c.x, c.y, 8); }));
results.push(await measure('zoom 14 city', () => { const g = window.__god; const c = g.Main.largestSettlement() || { x: 48, y: 48 }; g.Render.setMode(0); g.Render.setCamera(c.x, c.y, 14); }));
results.push(await measure('zoom 6 culture', () => { const g = window.__god; const c = g.Main.largestSettlement() || { x: 48, y: 48 }; g.Render.setMode(2); g.Render.setCamera(c.x, c.y, 6); }));
console.log(`[${LABEL}] page errors: ${b.errors.length}${b.errors.length ? ' ' + b.errors[0].slice(0, 200) : ''}`);
if (args.json) fs.writeFileSync(String(args.json), JSON.stringify({ label: LABEL, html, setup, results }, null, 1));
await b.close();
process.exit(b.errors.length ? 1 : 0);
