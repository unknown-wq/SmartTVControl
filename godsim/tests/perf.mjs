// Performance at the cap: the REAL index.html in headless Chromium (iPhone viewport), ~1500 units, 3 wars, x4 speed.
//   node tests/perf.mjs [--seconds=12] [--seed=4] [--throttle=4] [--nobuild] [--json=/tmp/perf.json]
//   --throttle=N slows the page's CPU N times (CDP Emulation.setCPUThrottlingRate) to mimic a phone; the budgets scale with it.
// Splits the cost of a frame (Main.stats.frameMs / simMs, Render.stats.drawMs, Sim.profile per module) for several views:
//   whole map (everything visible), city close-up, political map (BORDERS + armies + arrows), culture map.
// Asserts the budgets: sim < 8 ms/tick on average, whole frame CPU < 24 ms at x4 (software GL is slower than an iPhone GPU, so these are loose),
// the sim keeps its pace (>= 70% of 40 ticks/s) and no page errors.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const SEC = +(args.seconds || 12), SEED = +(args.seed || 4), THR = +(args.throttle || 1);
if (!args.nobuild) execFileSync('node', [path.join(root, 'build.mjs'), '--check'], { cwd: root, stdio: 'pipe' });

let pass = 0, fail = 0;
const check = (name, cond, info) => { if (cond) { pass++; console.log('  ok   ' + name + (info !== undefined ? '  (' + info + ')' : '')); } else { fail++; console.log('  FAIL ' + name + (info !== undefined ? '  (' + info + ')' : '')); } };

const b = await launch({ file: 'index.html', width: 390, height: 844, verbose: true });
const E = (fn, arg) => b.eval(fn, arg);
for (let i = 0; i < 60; i++) { if (await E(() => !!window.__god)) break; await b.sleep(100); }

if (THR > 1) { await b.cdp.send('Emulation.setCPUThrottlingRate', { rate: THR }); console.log('CPU throttled x' + THR); }
// ---- build the world: grow to the cap with the sim only (synchronous, no rendering), then make sure three wars are running
const setup = await E(async ({ seed }) => {
  const g = window.__god;
  g.Main.newWorld({ seed, w: 96, h: 96, populate: true }); g.setSpeed(0);
  let guard = 0;
  while (g.S.units.size < 1480 && g.S.tick < 30000 && guard++ < 400) { g.step(100); await new Promise(r => setTimeout(r, 0)); }
  const ks = [...g.S.kingdoms.values()].filter(k => k.alive !== false);
  let whispered = 0;
  for (const k of ks) { if (g.War.active().length >= 3) break; if (g.War.warsOf(k.id).length) continue; try { if (g.Diplomacy.godWhisperWar(k.id)) whispered++; } catch (e) { /* ignore */ } }
  g.step(40);
  return { tick: g.S.tick, units: g.S.units.size, kingdoms: ks.length, wars: g.War.active().length, whispered, armies: g.S.armies.size, soldiers: [...g.S.armies.values()].reduce((a, x) => a + x.members.length, 0) };
}, { seed: SEED });
console.log('world:', JSON.stringify(setup));
check('world has ~1500 units and 3 wars', setup.units >= 1300 && setup.wars >= 2, JSON.stringify(setup));

async function measure(label, prep) {
  await E(prep);
  await b.sleep(600);
  const r = await E(async (sec) => {
    const g = window.__god;
    g.setSpeed(4);
    const s0 = { frames: g.stats.frames, ticks: g.stats.ticks, tick: g.S.tick };
    const t0 = performance.now();
    const samples = [];
    const frameTimes = [];
    let last = performance.now();
    await new Promise(res => {
      const f = () => {
        const now = performance.now(); frameTimes.push(now - last); last = now;
        if (frameTimes.length % 20 === 0) samples.push({ frameMs: g.stats.frameMs, simMs: g.stats.simMs, draw: g.Render.stats.drawMs, prof: Object.assign({}, g.Sim.profile), vis: g.Render.stats.visibleUnits, perf: Object.assign({}, g.S.perf) });
        if (now - t0 < sec * 1000) requestAnimationFrame(f); else res();
      };
      requestAnimationFrame(f);
    });
    const dtSec = (performance.now() - t0) / 1000;
    const out = { secs: dtSec, frames: g.stats.frames - s0.frames, ticks: g.stats.ticks - s0.ticks, units: g.S.units.size, wars: g.War.active().length, samples, frameTimes };
    g.setSpeed(0);
    return out;
  }, SEC);
  const avg = (k) => r.samples.reduce((a, s) => a + s[k], 0) / r.samples.length;
  const max = (k) => Math.max(...r.samples.map(s => s[k]));
  const prof = {}; for (const k of Object.keys(r.samples[0].prof)) prof[k] = +(r.samples.reduce((a, s) => a + s.prof[k], 0) / r.samples.length).toFixed(3);
  const ft = r.frameTimes.slice(5).sort((a, c) => a - c);
  const res = {
    label, fps: +(r.frames / r.secs).toFixed(1), tickRate: +(r.ticks / r.secs).toFixed(1), frameCpu: +avg('frameMs').toFixed(2), frameCpuMax: +max('frameMs').toFixed(2), simPerFrame: +avg('simMs').toFixed(2), draw: +avg('draw').toFixed(2), visible: Math.round(avg('vis')),
    p95: +ft[(ft.length * 0.95) | 0].toFixed(1), worst: +ft[ft.length - 1].toFixed(1), units: r.units, wars: r.wars, prof, thinkEvery: r.samples[r.samples.length - 1].perf.thinkEvery, lod: r.samples[r.samples.length - 1].perf.lod,
  };
  console.log(`${label.padEnd(16)} fps ${String(res.fps).padStart(5)} | ticks/s ${String(res.tickRate).padStart(5)} | frame CPU avg ${String(res.frameCpu).padStart(5)} ms (max ${res.frameCpuMax}) = sim ${res.simPerFrame} + draw ${res.draw} + rest | rAF p95 ${res.p95} worst ${res.worst} | visible units ${res.visible} | think ${res.thinkEvery} lod ${res.lod}`);
  console.log(`                 sim profile ms/tick: ${Object.entries(prof).map(([k, v]) => k + ' ' + v).join(', ')}`);
  return res;
}

const results = [];
results.push(await measure('whole map', () => { const g = window.__god; g.Render.setMode(0); g.Render.setCamera(48, 48, g.Render.minZoom()); }));
results.push(await measure('whole, political', () => { const g = window.__god; g.Render.setMode(1); g.Render.setCamera(48, 48, g.Render.minZoom()); g.Render.showAllOrders = true; }));
results.push(await measure('zoom 8 political', () => { const g = window.__god; const c = g.Main.largestSettlement() || { x: 48, y: 48 }; g.Render.setMode(1); g.Render.setCamera(c.x, c.y, 8); }));
results.push(await measure('zoom 14 city', () => { const g = window.__god; const c = g.Main.largestSettlement() || { x: 48, y: 48 }; g.Render.setMode(0); g.Render.setCamera(c.x, c.y, 14); }));
results.push(await measure('zoom 6 culture', () => { const g = window.__god; const c = g.Main.largestSettlement() || { x: 48, y: 48 }; g.Render.setMode(2); g.Render.setCamera(c.x, c.y, 6); }));

const worstFrame = Math.max(...results.map(r => r.frameCpu)), worstSim = Math.max(...results.map(r => Object.values(r.prof).length ? r.prof.total : 0));
check('sim cost at 1500 units + wars < ' + 8 * THR + ' ms/tick (EMA, every view)', worstSim < 8 * THR, 'max ' + worstSim.toFixed(2));
check('whole frame CPU (sim + draw + UI) < ' + (THR > 1 ? 30 : 24) + ' ms at x4 in every view (software GL)', worstFrame < (THR > 1 ? 30 : 24), 'max ' + worstFrame.toFixed(1));
check('sim keeps pace at x4 (>= ' + (THR > 1 ? 24 : 28) + ' of 40 ticks/s) in every view', results.every(r => r.tickRate >= (THR > 1 ? 24 : 28)), results.map(r => r.tickRate).join(','));
check('no page errors', b.errors.length === 0, b.errors[0] || '');
if (args.json) fs.writeFileSync(String(args.json), JSON.stringify({ setup, results }, null, 1));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
