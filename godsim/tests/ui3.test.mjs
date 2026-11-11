// Notification filter button («Войны» / «Все»): node tests/ui3.test.mjs [--shots=/tmp/godsim-ui3-shots]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const shots = args.shots || '/tmp/godsim-ui3-shots';
fs.mkdirSync(shots, { recursive: true });
const out = '/tmp/godsim-ui3.html';
execFileSync('node', [path.join(root, 'build.mjs'), '--out=' + out, '--extra=tests/boot_ui3.js'], { cwd: root, stdio: 'pipe' });

let pass = 0, fail = 0;
function check(name, ok, info = '') { if (ok) { pass++; console.log('  ok   ' + name + (info ? '  (' + info + ')' : '')); } else { fail++; console.log('  FAIL ' + name + (info ? '  (' + info + ')' : '')); } }

async function boot(opts = {}) {
  const b = await launch({ file: out, ...opts });
  await b.page.waitForFunction(() => window.__god && window.__dbg && document.querySelector('.fab.feedfab'), null, { timeout: 15000 });
  await b.wait(400);
  return b;
}
const emit = (b, kind, msg) => b.eval(([k, m]) => { window.__dbg.Log.add(m, k, -1, -1, 0); }, [kind, msg]);
const feedLines = b => b.eval(() => [...document.querySelectorAll('#feed .fl')].map(n => n.textContent));
const fabInfo = b => b.eval(() => { const f = document.querySelector('.fab.feedfab'); const r = f.getBoundingClientRect(); return { label: f.textContent.trim(), on: f.classList.contains('on'), pressed: f.getAttribute('aria-pressed'), aria: f.getAttribute('aria-label'), x: r.x, y: r.y, w: r.width, h: r.height, vis: f.offsetParent !== null }; });
async function tapFab(b) { const i = await fabInfo(b); await b.tap(i.x + i.w / 2, i.y + i.h / 2); await b.wait(350); }

console.log('# default state (filter on), kinds');
let b = await boot();
let info = await fabInfo(b);
check('feed filter button exists and is visible', info.vis);
check('default: only wars & peace (label «Войны», highlighted, aria-pressed)', info.label === 'Войны' && info.on && info.pressed === 'true', JSON.stringify(info));
check('touch target >= 44 px', info.w >= 44 && info.h >= 44, Math.round(info.w) + 'x' + Math.round(info.h));
await b.eval(() => { /* clear boot noise */ document.querySelector('#feed').innerHTML = ''; });
// Replace feed state by reloading messages: use fresh unique texts
const msgs = [['birth', 'T1 родился ребёнок'], ['info', 'T2 просто инфо'], ['city', 'T3 основана деревня'], ['kingdom', 'T4 союз заключён'], ['disaster', 'T5 метеорит'], ['god', 'T6 шёпот бога'], ['rebel', 'T7 город восстал'], ['death', 'T8 умер король'], ['war', 'T9 объявлена война'], ['peace', 'T10 заключён мир']];
for (const [k, m] of msgs) await emit(b, k, m);
await b.wait(500);
let lines = await feedLines(b);
check('feed shows the war and peace lines', lines.some(t => t.includes('T9')) && lines.some(t => t.includes('T10')), JSON.stringify(lines));
check('feed hides birth/info/city/kingdom/disaster/god/rebel/death lines', !lines.some(t => /T[1-8] /.test(t)), JSON.stringify(lines));
await b.shot(shots + '/01_default_filtered_390.png');

console.log('# toggle off: everything shows');
await tapFab(b);
info = await fabInfo(b);
check('after tap: label «Все», not highlighted, aria-pressed false', info.label === 'Все' && !info.on && info.pressed === 'false', JSON.stringify(info));
const toast1 = await b.eval(() => (document.querySelector('#toasts') || {}).textContent || '');
check('toast announces the mode', /все события/i.test(toast1), toast1);
for (const [k, m] of [['birth', 'U1 родился ребёнок'], ['city', 'U2 основана деревня'], ['war', 'U3 началась война']]) await emit(b, k, m);
await b.wait(500);
lines = await feedLines(b);
check('all kinds appear again', lines.some(t => t.includes('U1')) && lines.some(t => t.includes('U2')) && lines.some(t => t.includes('U3')), JSON.stringify(lines));
await b.shot(shots + '/02_all_390.png');

console.log('# toggle on again: visible non-war lines vanish at once');
await tapFab(b);
lines = await feedLines(b);
check('only war/peace lines remain after enabling the filter', lines.length > 0 ? lines.every(t => /U3|T9|T10/.test(t)) : true, JSON.stringify(lines));
check('war line U3 survived', lines.some(t => t.includes('U3')), JSON.stringify(lines));

console.log('# log panel follows the filter');
await b.eval(() => window.__god.UI.openLog());
await b.wait(400);
let lp = await b.eval(() => ({ on: [...document.querySelectorAll('.filters button.on')].map(n => n.textContent), rows: [...document.querySelectorAll('.log-item .lt')].map(n => n.textContent).slice(0, 40) }));
check('log panel opens on the «Войны» chip when the filter is on', lp.on.length === 1 && lp.on[0] === 'Войны', JSON.stringify(lp.on));
check('log panel rows are only war/peace', lp.rows.length > 0 && lp.rows.every(t => /войн|мир|оккуп|освобожд|цель|вступил/i.test(t)), JSON.stringify(lp.rows.slice(0, 6)));
await b.shot(shots + '/03_log_war_390.png');
await b.eval(() => window.__god.UI.closeAllModals && window.__god.UI.closeAllModals());
await b.wait(300);

console.log('# persistence');
await tapFab(b);               // -> «Все»
await b.page.reload();
await b.page.waitForFunction(() => window.__god && window.__dbg && document.querySelector('.fab.feedfab'), null, { timeout: 15000 });
await b.wait(500);
info = await fabInfo(b);
check('«Все» survives a reload (localStorage)', info.label === 'Все' && !info.on, JSON.stringify(info));
await b.eval(() => window.__god.UI.openLog());
await b.wait(300);
lp = await b.eval(() => [...document.querySelectorAll('.filters button.on')].map(n => n.textContent));
check('log panel opens on «Все» when the filter is off', lp.length === 1 && lp[0] === 'Все', JSON.stringify(lp));
await b.eval(() => window.__god.UI.closeAllModals && window.__god.UI.closeAllModals());
check('no page errors', b.errors.length === 0, b.errors.join(' | ').slice(0, 300));
await b.close();

console.log('# layout on other screens');
for (const [name, w, h] of [['tiny', 320, 568], ['small', 360, 640], ['big', 430, 932], ['landscape', 844, 390], ['landscape_small', 667, 375]]) {
  const bb = await boot({ width: w, height: h });
  const r = await bb.eval(() => {
    const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }; };
    const top = rect(document.querySelector('#top'));
    const items = [...document.querySelectorAll('#fabs .fab, #fabs .zoom')].filter(e => e.offsetParent !== null).map(e => ({ cls: e.className, ...rect(e) }));
    const feed = document.querySelector('.fab.feedfab');
    return { top, items, feedVis: !!feed && feed.offsetParent !== null, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, vh: innerHeight };
  });
  const minTop = Math.min(...r.items.map(i => i.y));
  const overlapTop = r.items.some(i => i.b > r.top.y && i.y < r.top.b && i.r > r.top.x && i.x < r.top.r);
  let overlaps = false;
  for (let i = 0; i < r.items.length; i++) for (let j = i + 1; j < r.items.length; j++) { const a = r.items[i], c = r.items[j]; if (a.x < c.r - 1 && c.x < a.r - 1 && a.y < c.b - 1 && c.y < a.b - 1) overlaps = true; }
  check(`${name} ${w}x${h}: filter button visible, no page overflow`, r.feedVis && r.sw <= r.cw, `sw=${r.sw} cw=${r.cw}`);
  check(`${name}: floating buttons do not overlap the top bar or each other`, !overlapTop && !overlaps, `top bar bottom=${Math.round(r.top.b)}, buttons start at y=${Math.round(minTop)}`);
  await bb.shot(`${shots}/10_layout_${name}.png`);
  if (bb.errors.length) check(`${name}: no page errors`, false, bb.errors.join(' | ').slice(0, 200));
  await bb.close();
}
console.log(`\n${pass} passed, ${fail} failed.  Screenshots: ${shots}`);
process.exit(fail ? 1 : 0);
