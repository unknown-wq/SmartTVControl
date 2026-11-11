// «Ядерная бомба»: screenshot walkthrough + cost numbers in Chromium (390x844 @2x).   node tests/power_nuke_visual.mjs [--shots=/tmp/godsim-nuke-shots] [--seed=4] [--noperf] [--nobuild]
//  1. Screenshots at zoom 8 / 14 / 24 of the whole sequence from the SAME saved world: alarm, bomb falling, flash, wave, cloud rising / full / cooling, aftermath.
//     (read them: this is how the art was reviewed and iterated on)
//  2. Draw cost of the effects in a 1500-unit world: Render.draw called in a loop, alternating A/B rounds (effects on / off), MINIMUM over rounds (robust against a shared CPU).
//     Views: zoom 6 culture, zoom 8 political, zoom 14 city. Budget from CONTRACT 10.3: <= 0.6 ms per frame for a mushroom + fallout in view; the assertions here are looser
//     (software-GL canvas on a shared machine) and the exact numbers are printed.
//  3. Sim cost per tick through the blast at R = 13 in the same world (idle fall ticks, the 8 wave ticks, then the fallout).
// Builds to /tmp/godsim-nuke-visual.html (never touches index.html).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const SHOTS = String(args.shots || '/tmp/godsim-nuke-shots'), SEED = +(args.seed || 4), HTML = '/tmp/godsim-nuke-visual.html';
fs.mkdirSync(SHOTS, { recursive: true });
if (!args.nobuild) execFileSync('node', [path.join(root, 'build.mjs'), '--out=' + HTML, '--extra=tests/fixtures/nuke_hook.js'], { cwd: root, stdio: 'pipe' });

let pass = 0, fail = 0;
const check = (name, cond, info) => { if (cond) { pass++; console.log('  ok   ' + name + (info !== undefined ? '  (' + info + ')' : '')); } else { fail++; console.log('  FAIL ' + name + (info !== undefined ? '  (' + info + ')' : '')); } };
const loadRunnable = () => { try { return parseInt(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[3].split('/')[0], 10); } catch (e) { return 0; } };
async function quiet(b, maxMs = 60000) { const t0 = Date.now(); let ok = 0; while (Date.now() - t0 < maxMs) { if (loadRunnable() <= 3) { if (++ok >= 3) return true; } else ok = 0; await b.sleep(500); } return false; }

const b = await launch({ file: HTML, width: 390, height: 844, dpr: 2 });
const E = (fn, a) => b.eval(fn, a);
const frame = () => b.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
for (let i = 0; i < 100; i++) { if (await E(() => !!(window.__god && window.__gfxNuke))) break; await b.sleep(100); }

// ------------------------------------------------------------------ 1. screenshots
console.log('# screenshots (world seed ' + SEED + ', blast radius 8 = brush 3)');
const world = await E(async ({ seed }) => {
  const g = window.__god;
  g.Main.newWorld({ seed, w: 96, h: 96, populate: true }); g.setSpeed(0);
  let n = 0; while (n < 4500) { g.step(250); n += 250; await new Promise(r => setTimeout(r, 0)); }
  const c = [...g.S.cities.values()].sort((a, b) => b.pop - a.pop)[0];
  window.__snap = g.Save.serialize();
  return { x: c.x, y: c.y, name: c.name, pop: c.pop, units: g.S.units.size };
}, { seed: SEED });
console.log('world:', JSON.stringify(world));
const cam = (zoom, dy = 0) => E(({ x, y, zoom, dy }) => { const g = window.__god; g.Render.setMode(0); g.Render.setCamera(x + 0.5, y + 0.5 + dy, zoom); }, { x: world.x, y: world.y, zoom, dy });
const shot = async (name) => { await frame(); await b.sleep(180); await b.shot(`${SHOTS}/${name}.png`); };
for (const zoom of [8, 14, 24]) {
  await E(() => { const g = window.__god; g.Fx.clear(); g.Save.deserialize(window.__snap); g.Main.worldReplaced('load'); g.setSpeed(0); });
  await cam(zoom); await b.sleep(300);
  const z = 'z' + String(zoom).padStart(2, '0');
  await E(({ x, y }) => window.__god.Powers.apply('nuke', x + 0.5, y + 0.5, 3, 'tap'), world);
  await E(() => window.__god.step(5)); await shot(`${z}_1_alarm`);
  await E(() => window.__god.step(18)); await shot(`${z}_2_bomb`);
  await E(() => { const g = window.__god; window.__fxUpdate = g.Fx.update; g.Fx.update = () => {}; g.step(2); });       // freeze the Fx clock: the flash at its peak
  await shot(`${z}_3_flash`);
  await E(() => { const g = window.__god; g.Fx.update = window.__fxUpdate; g.Fx.clear(); g.step(5); });
  await shot(`${z}_4_wave`);
  await cam(zoom, zoom >= 24 ? -7 : 0);                                         // at zoom 24 the cloud is taller than the screen: look a little north
  await E(() => window.__god.step(20)); await shot(`${z}_5_rising`);
  await E(() => window.__god.step(40)); await shot(`${z}_6_full`);
  await E(() => window.__god.step(80)); await shot(`${z}_7_cooling`);
  await cam(zoom);
  await E(() => window.__god.step(120)); await shot(`${z}_8_aftermath`);
  console.log('  shots for zoom ' + zoom + ' saved');
}
check('screenshots taken without page errors', b.errors.length === 0, b.errors[0] || '');

if (!args.noperf) {
  // ---------------------------------------------------------------- 2 + 3. cost in a 1500-unit world
  console.log('# cost with ~1500 units (software-GL Chromium on a shared machine; the SAME scene is drawn with the nuke layers on / off, CPU time of the renderer + GPU processes and wall minimum over alternating rounds)');
  const bcdp = await b.browser.newBrowserCDPSession();
  const cpu = async () => { try { const r = await bcdp.send('SystemInfo.getProcessInfo'); return r.processInfo.filter(p => p.type === 'renderer' || p.type === 'gpu').reduce((s, p) => s + p.cpuTime, 0); } catch (e) { return 0; } };
  const setup = await E(async ({ seed }) => {
    const g = window.__god;
    g.Main.newWorld({ seed, w: 96, h: 96, populate: true }); g.setSpeed(0);
    let guard = 0;
    while (g.S.units.size < 1450 && g.S.tick < 30000 && guard++ < 400) { g.step(100); await new Promise(r => setTimeout(r, 0)); }
    g.Fx.clear();
    const c = g.Main.largestSettlement() || { x: 48, y: 48 };
    window.__snap2 = g.Save.serialize();
    return { tick: g.S.tick, units: g.S.units.size, c: { x: c.x, y: c.y } };
  }, { seed: SEED });
  console.log('world:', JSON.stringify(setup));
  await E(() => {
    const defs = window.__gfxPlugins.effects.filter(d => ['fallout', 'nukes', 'mushrooms'].includes(d.key));
    defs.forEach(d => { d.__draw = d.draw; });
    window.__layers = (on) => { defs.forEach(d => { d.draw = on ? d.__draw : () => {}; }); };
    window.__now = 900000;
    window.__set = (kind, R, c) => {
      const g = window.__god, S = g.S, e = S.eff;
      e.nukes.length = 0; e.mushrooms.length = 0; e.fallout.length = 0;
      const x = c.x + 0.5, y = c.y + 0.5, t = S.tick;
      if (kind === 'cloud+fallout') { e.mushrooms.push({ x, y, r: R, t0: t - 70, until: t + 150 }); e.fallout.push({ x, y, r: R * 0.7, R, t0: t - 70, until: t + 1430 }); }
      if (kind === 'blast') { e.mushrooms.push({ x, y, r: R, t0: t - 5, until: t + 215 }); e.fallout.push({ x, y, r: R * 0.7, R, t0: t - 5, until: t + 1495 }); }
      if (kind === 'alarm') e.nukes.push({ x, y, r: R, t0: t - 12, eta: t + 13, s: 1, w: 0, hit: [] });
      window.__layers(true);
      for (let i = 0; i < 6; i++) window.__god.Render.draw(0.5, window.__now += 16);        // bakes whatever is missing
    };
    window.__run = (n) => { const t0 = performance.now(); for (let i = 0; i < n; i++) window.__god.Render.draw(0.5, window.__now += 16); return performance.now() - t0; };
  });
  const views = [['zoom 6 culture', 2, 6], ['zoom 8 political', 1, 8], ['zoom 14 city', 0, 14], ['zoom 24 city', 0, 24]];
  const worst = {};
  for (const R of [13, 9]) {
    for (const [label, mode, zoom] of views) {
      await E(({ mode, zoom, c, R }) => { const g = window.__god; g.Render.setMode(mode); g.Render.setCamera(c.x + 0.5, c.y + 0.5, zoom); window.__gfxNuke.parts(R); }, { mode, zoom, c: setup.c, R });
      await b.sleep(300);
      await quiet(b, 15000);
      const row = [];
      for (const kind of ['cloud+fallout', 'blast', 'alarm']) {
        await E(({ kind, R, c }) => window.__set(kind, R, c), { kind, R, c: setup.c });
        const m = { on: { cpu: 1e9, wall: 1e9 }, off: { cpu: 1e9, wall: 1e9 } };
        for (let round = 0; round < 7; round++) for (const on of [true, false]) {
          await E((on) => window.__layers(on), on);
          const c0 = await cpu();
          const wall = await E(() => window.__run(60));
          const c1 = await cpu();
          const key = on ? 'on' : 'off';
          m[key].cpu = Math.min(m[key].cpu, (c1 - c0) * 1000 / 60); m[key].wall = Math.min(m[key].wall, wall / 60);
        }
        await E(() => window.__layers(true));
        const dc = Math.max(0, m.on.cpu - m.off.cpu), dw = Math.max(0, m.on.wall - m.off.wall);
        row.push(`${kind} ${dc.toFixed(2)} cpu / ${dw.toFixed(2)} wall`);
        if (R === 13 && kind === 'cloud+fallout') worst[label] = Math.min(dc || dw, dw || dc);
      }
      console.log(`  R=${String(R).padEnd(2)} ${label.padEnd(17)} nuke layers add (ms per frame): ${row.join(' | ')}`);
    }
  }
  await E(() => { window.__set('none', 8, { x: 1, y: 1 }); });
  for (const [label, v] of Object.entries(worst)) check(label + ': a mushroom + fallout (R = 13) add < 1.0 ms per frame (CONTRACT target 0.6 on a quiet machine)', v < 1.0, v.toFixed(2) + ' ms');
  console.log('  gfx caches:', JSON.stringify(await E(() => window.__gfxNuke.stats())));

  // sim cost per tick through the blast
  await E(() => { const g = window.__god; g.Fx.clear(); g.Save.deserialize(window.__snap2); g.Main.worldReplaced('load'); g.setSpeed(0); });
  await quiet(b, 15000);
  const sim = await E(({ c }) => {
    const g = window.__god;
    const city = [...g.S.cities.values()].sort((a, b) => b.pop - a.pop)[0] || { x: c.x, y: c.y };
    const inBlast = [...g.S.units.values()].filter(u => Math.hypot(u.x - city.x - 0.5, u.y - city.y - 0.5) <= 13).length;
    g.Powers.apply('nuke', city.x + 0.5, city.y + 0.5, 8, 'tap');
    const t = (n) => { const out = []; for (let i = 0; i < n; i++) { const a = performance.now(); g.step(1); out.push(performance.now() - a); } return out; };
    const idle = t(24), wave = t(8), after = t(60);
    const stat = (a) => ({ avg: a.reduce((s, v) => s + v, 0) / a.length, max: Math.max(...a) });
    return { inBlast, units: g.S.units.size, idle: stat(idle), wave: wave.map(v => +v.toFixed(2)), waveStat: stat(wave), after: stat(after) };
  }, { c: setup.c });
  console.log(`  sim ticks (whole Sim.step, ${sim.units} units, ${sim.inBlast} inside R = 13): fall avg ${sim.idle.avg.toFixed(2)} max ${sim.idle.max.toFixed(2)} ms | wave ticks ${sim.wave.join(' ')} | after avg ${sim.after.avg.toFixed(2)} max ${sim.after.max.toFixed(2)} ms`);
  const second = sim.wave.slice().sort((a, b) => b - a)[1];
  check('the 8 wave ticks stay below 25 ms each (whole sim step incl. kills / razing; second-worst, shared machine)', second < 25, second.toFixed(1) + ' ms');
  check('no page errors during the cost runs', b.errors.length === 0, b.errors[0] || '');
}
console.log(`\n${pass} passed, ${fail} failed; screenshots in ${SHOTS}`);
await b.close();
process.exit(fail ? 1 : 0);
