// Plugin infrastructure (CONTRACT section 10): node tests/plugins.test.mjs [--shots=/tmp/godsim-plugins-shots] [--nobrowser]
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSim, stepN } from './harness.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, 'tests', 'fixtures', 'plugin_demo.js');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
let pass = 0, fail = 0;
function check(name, ok, info = '') { if (ok) { pass++; console.log('  ok   ' + name + (info ? '  (' + info + ')' : '')); } else { fail++; console.log('  FAIL ' + name + (info ? '  (' + info + ')' : '')); } }
function load() { const ctx = loadSim({ extra: [fixture] }); ctx.Sim.newWorld({ seed: 5, w: 96, h: 96, populate: true }); return ctx; }

console.log('# headless: registration, dispatch, step, lifecycle, save');
{
  const ctx = load();
  const { S, Powers, ToolDefs, Fx } = ctx;
  const ids = ToolDefs.filter(t => t.tab === 'powers').map(t => t.id);
  const iDemo = ids.indexOf('demo_blast'), iLastDestroy = Math.max(...ids.map((id, i) => ToolDefs.byId[id].group === 'destroy' ? i : -1)), iBless = ids.findIndex(id => ToolDefs.byId[id].group === 'bless');
  const arsenal = ids.map((id, i) => (ToolDefs.byId[id].group === 'arsenal' ? i : -1)).filter(i => i >= 0);       // real arsenal plugins (src/15..19_power_*.js) share the group with the demo
  check('ToolDefs.add puts a new group after its afterGroup and before the next group (one contiguous group)', iDemo > iLastDestroy && iDemo < iBless && arsenal[0] === iLastDestroy + 1 && arsenal[arsenal.length - 1] === arsenal[0] + arsenal.length - 1 && arsenal.indexOf(iDemo) >= 0, ids.join(','));
  check('group label registered for the plugin group', ToolDefs.groupLabels.arsenal === 'Арсенал');
  check('re-adding an existing tool id is a no-op', ToolDefs.add({ id: 'demo_blast', tab: 'powers', group: 'x' }) === ToolDefs.byId.demo_blast && ToolDefs.filter(t => t.id === 'demo_blast').length === 1);
  let target = null; for (const u of S.units.values()) { target = u; break; }
  const tx = target.x, ty = target.y;
  const t0 = performance.now();
  const ok = Powers.apply('demo_blast', tx, ty, 3, 'tap');
  check('Powers.apply dispatches to the plugin and returns its result', ok === true && Powers.lastMessage === 'Демо-взрыв', Powers.lastMessage);
  check('plugin keeps its persistent effect in S.eff.<name>', Array.isArray(S.eff.demo_blast) && S.eff.demo_blast.length === 1);
  check('plugin touched nearby units (Units.nearby)', target.demoMark > S.tick);
  check('plugin queued shake + flash + fx through the host', Fx.list.filter(f => f.type === 'shake').length === 1 && Fx.list.filter(f => f.type === 'flash').length === 1 && Fx.list.filter(f => f.type === 'demo_fx').length === 1);
  check('unknown tool ids are still refused', Powers.apply('no_such_power', 10, 10, 2, 'tap') === false);
  const before = Powers.errors;
  const ce = console.error; console.error = () => {};      // the demo_bad plugin throws on purpose
  stepN(ctx, 40);
  console.error = ce;
  check('plugin step runs every tick, effect expires', S.mod.demo.steps >= 40 && S.eff.demo_blast.length === 0, 'steps ' + S.mod.demo.steps);
  check('a throwing plugin step is isolated (counted, other plugins still run)', Powers.errors > before && S.mod.demo.steps >= 40, 'errors ' + before + ' -> ' + Powers.errors);
  // save / load: plugin arrays in S.eff must survive, and the continuation must be identical
  Powers.apply('demo_blast', tx, ty, 2, 'tap');
  const json = ctx.Save.serialize();
  const ctx2 = loadSim({ extra: [fixture] });
  assert.ok(ctx2.Save.deserialize(json), 'deserialize');
  check('S.eff.<plugin> survives save/load', ctx2.S.eff.demo_blast && ctx2.S.eff.demo_blast.length === 1, JSON.stringify(ctx2.S.eff.demo_blast));
  check('plugin S.mod state survives save/load', ctx2.S.mod.demo && ctx2.S.mod.demo.steps === ctx.S.mod.demo.steps);
  console.error = () => {}; stepN(ctx, 40); stepN(ctx2, 40); console.error = ce;
  check('continuation after load is identical (S.eff + S.mod)', JSON.stringify(ctx.S.eff) === JSON.stringify(ctx2.S.eff) && JSON.stringify(ctx.S.mod.demo) === JSON.stringify(ctx2.S.mod.demo));
  check('500 plugin ticks stay cheap', (() => { console.error = () => {}; const a = performance.now(); stepN(ctx, 500); const dt = performance.now() - a; console.error = ce; return dt < 2000; })());
  check('no exceptions leaked from Powers.step', true);
}

if (!args.nobrowser) {
  console.log('# browser: icon, tool button, group label, fx, persistent effect, tint, badge, flash, shake');
  const { launch } = await import('./browser.mjs');
  const shots = args.shots || '/tmp/godsim-plugins-shots';
  fs.mkdirSync(shots, { recursive: true });
  const out = '/tmp/godsim-plugins.html';
  execFileSync('node', [path.join(root, 'build.mjs'), '--out=' + out, '--extra=tests/fixtures/plugin_demo.js'], { cwd: root, stdio: 'pipe' });
  const b = await launch({ file: out });
  await b.page.waitForFunction(() => window.__god && window.__demoCounts && document.querySelector('.tab'), null, { timeout: 15000 });
  await b.wait(500);
  await b.eval(() => window.__god.UI.selectTab('powers'));
  await b.wait(300);
  const tool = await b.eval(() => {
    const btn = document.querySelector('.tool[data-tool="demo_blast"]');
    if (!btn) return null;
    const cv = btn.querySelector('canvas'); let lit = 0;
    if (cv) { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++; }
    return { label: btn.textContent.trim(), lit, groups: [...document.querySelectorAll('.grp-lbl')].map(x => x.textContent.trim()) };
  });
  check('tool button rendered in the Силы tab with the short label and a drawn icon', !!tool && tool.label === 'Демо' && tool.lit > 20, JSON.stringify(tool));
  check('plugin group label shown between Разрушение and Благословение', !!tool && tool.groups.join('|') === 'Разрушение|Арсенал|Благословение', tool && tool.groups.join('|'));
  // a unit to hit
  const uid = await b.eval(() => { const g = window.__god; const u = [...g.S.units.values()][0]; g.Render.focusOn(u.x, u.y, 14); return { id: u.id, x: u.x, y: u.y }; });
  await b.wait(400);
  await b.eval(([x, y]) => window.__god.Powers.apply('demo_blast', x, y, 3, 'tap'), [uid.x, uid.y]);
  await b.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const px = await b.eval(() => { const c = document.getElementById('game'); const d = c.getContext('2d').getImageData(8, 8, 1, 1).data; return [d[0], d[1], d[2]]; });
  check('built-in full-screen flash (Fx type flash) paints the canvas', px[0] > 240 && px[1] > 240 && px[2] > 240, px.join(','));
  await b.shot(shots + '/01_flash.png');
  await b.wait(1700);
  const c = await b.eval(() => ({ ...window.__demoCounts }));
  check('plugin icon, fx and persistent-effect draw functions were all called', c.icon > 0 && c.fx > 0 && c.effect > 0, JSON.stringify(c));
  await b.eval(([id]) => window.__god.UI.openInspector('unit', id), [uid.id]);
  await b.wait(400);
  const chips = await b.eval(() => [...document.querySelectorAll('#sheet .chip')].map(x => x.textContent.trim()));
  check('plugin unit badge shows in the unit card', chips.includes('Демо'), chips.join('|'));
  await b.shot(shots + '/02_inspector_badge.png');
  check('no page errors', b.errors.length === 0, b.errors.join(' | ').slice(0, 300));
  await b.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
