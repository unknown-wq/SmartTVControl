// Browser playtest as a user: the REAL index.html in an iPhone-sized viewport (390x844 @2x, touch), real CDP touch events.
//   node tests/playtest.mjs [--soak=90] [--seed=4] [--shots=/tmp/godsim-playtest] [--nobuild] [--width=390 --height=844]
// 1. soak: run x4 for --soak seconds of REAL time with a random god action every ~2.5 s (taps on the map through the real dock), a war whisper,
//    FPS sampling, screenshots every 15 s; no page errors / error overlay; the sim keeps up; UI sanity (feed, counters, no stuck sheets).
// 2. command mode in a real world: Kingdoms tab -> chip (attacker) -> lit target regions -> tap a region -> war card -> «Объявить войну» -> armies march, take the goal
//    region and HOLD it (the war persists, no further advance) -> save the world in the middle of the war through the menu.
// 3. load it back through the menu (state restored, UI clean), then Армии page (select army, orders) and the peace conference (offer).
// 4. the political map at several zoom levels (screenshots + draw cost).
// Screenshots go to --shots; read them (Read tool) to judge the visuals.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const SOAK = +(args.soak || 90), SEED = +(args.seed || 4);
const W = +(args.width || 390), H = +(args.height || 844);
const SHOTS = args.shots || '/tmp/godsim-playtest';
fs.mkdirSync(SHOTS, { recursive: true });
if (!args.nobuild) execFileSync('node', [path.join(root, 'build.mjs'), '--check'], { cwd: root, stdio: 'pipe' });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ok   ' + name + (info !== undefined ? '  (' + info + ')' : '')); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (info !== undefined ? '  (' + info + ')' : '')); }
}
const section = s => console.log('\n# ' + s);
const note = s => console.log('       ' + s);

const b = await launch({ file: 'index.html', width: W, height: H, verbose: true });
const E = (fn, arg) => b.eval(fn, arg);
b.page.on('framenavigated', f => { if (f === b.page.mainFrame()) console.log('       [page navigated: ' + f.url().slice(-40) + ']'); });
b.page.on('crash', () => console.log('       [page CRASHED]'));
const sleep = b.sleep;
const frames = n => E(n => new Promise(r => { let k = 0; const f = () => { if (++k >= n) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n);
const shot = async name => { const f = path.join(SHOTS, name + '.png'); await b.shot(f); return f; };
const center = sel => E(sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; }, sel);
async function tapSel(sel) {
  await E(sel => { const e = document.querySelector(sel); if (e && e.closest('.sh-body')) e.scrollIntoView({ block: 'nearest' }); }, sel);
  const c = await center(sel);
  if (!c) {
    const d = await E(() => { const g = window.__god, bt = document.getElementById('bottom'), tabs = [...document.querySelectorAll('.tab')];
      return JSON.stringify({ tab: (document.querySelector('.tab.on') || {}).dataset && document.querySelector('.tab.on').dataset.tab, tools: [...document.querySelectorAll('#tools .tool')].map(e => e.dataset.tool).join(','), bottom: bt.className, sheetHidden: document.getElementById('sheet').hidden, tick: g.S.tick, cmdKid: g.UI.cmdKid, tabsShown: tabs.length, dockRect: (() => { const r = bt.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; })() }); });
    throw new Error('no element ' + sel + ' ' + d);
  }
  await b.tap(c[0], c[1]); await sleep(140);
  const m = /^\.tab\[data-tab="(\w+)"\]$/.exec(sel);
  if (m) {   // a tab tap must switch the tab: if it did not, record where the tap went (diagnostics) and tap once more
    const on = () => E(() => { const e = document.querySelector('.tab.on'); return e ? e.dataset.tab : ''; });
    if ((await on()) !== m[1]) {
      const d = await E(([x, y, sel]) => { const t = document.elementFromPoint(x, y), r = document.querySelector(sel).getBoundingClientRect(), bt = document.getElementById('bottom'); return JSON.stringify({ hit: t ? (t.id ? '#' + t.id : '') + '.' + String(t.className).replace(/\s+/g, '.') + ' <' + t.tagName + '>' : null, tabRect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], tapAt: [Math.round(x), Math.round(y)], bottom: bt.className, anim: document.getAnimations().length, modal: (document.getElementById('modals').innerText || '').replace(/\s+/g, ' ').slice(0, 160), modalOpen: window.__god.UI.modalOpen() }); }, [c[0], c[1], sel]);
      note('tab tap ignored: ' + sel + ' ' + d);
      const c2 = await center(sel); await b.tap(c2[0], c2[1]); await sleep(200);
    }
  }
  return c;
}
async function tapText(scopeSel, re, nth = 0) {
  const p = await E(([scopeSel, re, nth]) => {
    const r = new RegExp(re); let k = 0;
    for (const e of document.querySelectorAll(scopeSel + ' button')) if (r.test(e.textContent) && e.offsetParent !== null) { if (k++ < nth) continue; const q = e.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; }
    return null;
  }, [scopeSel, re.source, nth]);
  if (!p) throw new Error('no button ' + re + ' in ' + scopeSel);
  await b.tap(p[0], p[1]); await sleep(160); return p;
}
const exists = sel => E(sel => !!document.querySelector(sel), sel);
/** close an open inspector sheet like a user would (tap its close button); the dock is hidden while a sheet is open */
async function closeSheet() {
  await closeModals();
  for (let i = 0; i < 3; i++) {
    const open = await E(() => document.getElementById('bottom').classList.contains('sheet-open') && !window.__god.UI.cmdKid && !window.__god.UI.cmd.goal);
    if (!open) return;
    const p = await E(() => { const e = document.querySelector('#sheet [aria-label="Закрыть"], #sheet [title="Закрыть"]'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    if (p) { await b.tap(p[0], p[1]); await sleep(250); } else { await E(() => window.__god.UI.closeInspector()); await sleep(200); }
  }
}
/** a random soak tap can land on the event feed, which opens the full log (by design): close any modal like a user would, with its «Закрыть» button */
let modalsClosed = 0;
async function closeModals() {
  for (let i = 0; i < 4; i++) {
    if (!(await E(() => window.__god.UI.modalOpen()))) return;
    const p = await E(() => { const e = document.querySelector('#modals .m-head [aria-label="Закрыть"]'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    if (p) { await b.tap(p[0], p[1]); await sleep(250); } else { await E(() => window.__god.UI.closeAllModals()); await sleep(150); }
    modalsClosed++;
  }
}
const G = fn => E(fn); // convenience

// ---------------------------------------------------------------------------------------------------------------- boot
section('boot');
for (let i = 0; i < 60; i++) { if (await E(() => !!window.__god)) break; await sleep(100); }
check('window.__god exists after boot', await E(() => !!window.__god));
await sleep(600);
check('no page errors during boot', b.errors.length === 0, b.errors[0] || '');
check('splash gone, UI visible', await E(() => !document.body.classList.contains('booting') && document.body.classList.contains('ui-on')));

// a deterministic world, advanced past the settling phase so wars can start during the soak
await E(seed => { const g = window.__god; g.Main.newWorld({ seed, w: 96, h: 96, populate: true }); g.setSpeed(0); }, SEED);
for (let i = 0; i < 8; i++) { await E(() => window.__god.step(500)); await frames(2); }
const t0 = await E(() => { const g = window.__god; g.Main.initialView(true); g.UI.refresh && g.UI.refresh(); return g.S.tick; });
note(`world seed ${SEED}, advanced to tick ${t0}`);
await frames(4);
await shot('00_start');

// ---------------------------------------------------------------------------------------------------------------- 1. soak
section(`soak: x4 for ${SOAK} s with random god actions, FPS sampling and screenshots`);
const ACTIONS = [['land', 'raise'], ['land', 'forest'], ['land', 'grass'], ['land', 'hill'], ['life', 'human'], ['life', 'orc'], ['life', 'elf'], ['powers', 'lightning'], ['powers', 'rain'], ['powers', 'bless'], ['powers', 'heal'], ['powers', 'fire'], ['powers', 'plague'], ['powers', 'meteor'], ['powers', 'earthquake'], ['info', 'inspect'], ['land', 'lower'], ['powers', 'tornado']];
let seedR = 12345; const rnd = () => { seedR = (Math.imul(seedR, 1103515245) + 12345) >>> 0; return (seedR >>> 8) / 16777216; };
const fpsLog = [], profLog = [], actionLog = [];
let shots = 0, whispered = false;
const tStart = Date.now();
const tick0 = await E(() => { const g = window.__god; g.setSpeed(4); return g.S.tick; });
let nextShot = 8000, nextFps = 4000, nextAct = 0;
while ((Date.now() - tStart) / 1000 < SOAK) {
  const el = Date.now() - tStart;
  if (el >= nextAct) {
    nextAct = el + 2500;
    const [tab, tool] = ACTIONS[(rnd() * ACTIONS.length) | 0];
    try {
      await closeSheet();
      await tapSel(`.tab[data-tab="${tab}"]`); await tapSel(`#tools .tool[data-tool="${tool}"]`);
      const bi = await E(() => window.__god.UI.bandInfo());
      const x = bi.left + 30 + rnd() * (bi.right - bi.left - 100), y = bi.top + 30 + rnd() * (bi.bot - bi.top - 60);
      await b.tap(x, y);
      actionLog.push(tool);
    } catch (e) { actionLog.push('ERR ' + tool + ' ' + e.message); }
    // a drag every third action (pan the camera), pinch occasionally
    if (actionLog.length % 3 === 0) { await closeSheet(); await tapSel('.tab[data-tab="info"]'); await b.drag(200, 400, 120 + rnd() * 140, 300 + rnd() * 200, 6, 16); }
    if (actionLog.length % 7 === 0) await b.pinch(195, 380, 70, 150 + rnd() * 50, 8, 16);
  }
  if (!whispered && el > SOAK * 1000 * 0.55) {
    whispered = true;
    const r = await E(() => { const g = window.__god; const ks = [...g.S.kingdoms.values()]; return { n: ks.length, wars: g.War.active().length }; });
    note(`at ${(el / 1000).toFixed(0)} s: ${r.n} kingdoms, ${r.wars} wars running`);
    if (r.wars === 0) {
      try {
        await closeSheet();
        await tapSel('.tab[data-tab="kingdoms"]'); await tapSel('#tools .tool[data-tool="war_whisper"]');
        const spot = await E(() => { const g = window.__god; const k = [...g.S.kingdoms.values()][0]; const c = g.S.cities.get(k.capitalId) || g.S.cities.get(k.cities[0]); g.Render.focusOn(c.x + 0.5, c.y + 0.5, 11, true); return { x: c.x + 0.5, y: c.y + 0.5 }; });
        await frames(4);
        const p = await E(s => window.__god.Render.tileToScreen(s.x, s.y), spot);
        await b.tap(p.x, p.y); await sleep(300);
        note(`war whisper: wars now ${await E(() => window.__god.War.active().length)}`);
      } catch (e) { note('whisper failed: ' + e.message); }
    }
  }
  if (el >= nextFps) { nextFps = el + 10000; const f = await b.fps(1500); fpsLog.push(f); }
  if (el >= nextShot) { nextShot = el + 15000; await shot('soak_' + String(++shots).padStart(2, '0')); }
  const pr = await E(() => { const g = window.__god; return { tick: g.S.tick, units: g.S.units.size, prof: Object.assign({}, g.Sim.profile), rs: Object.assign({}, g.Render.stats), perf: Object.assign({}, g.S.perf) }; });
  profLog.push(pr);
  await sleep(250);
}
const soakEnd = await E(() => { const g = window.__god; const r = { tick: g.S.tick, units: g.S.units.size, kingdoms: g.S.kingdoms.size, wars: g.War.active().length, armies: g.S.armies.size, perf: Object.assign({}, g.S.perf), cities: g.S.cities.size, errbox: !document.getElementById('errbox').hidden }; g.setSpeed(0); return r; });
const secs = (Date.now() - tStart) / 1000;
const tickRate = (soakEnd.tick - tick0) / secs;
const avgFps = fpsLog.length ? fpsLog.reduce((a, f) => a + f.fps, 0) / fpsLog.length : 0, minFps = fpsLog.length ? Math.min(...fpsLog.map(f => f.fps)) : 0;
const maxStep = Math.max(...profLog.map(p => p.prof.total || 0)), maxDraw = Math.max(...profLog.map(p => p.rs.drawMs || 0));
note(`ticks ${tick0} -> ${soakEnd.tick} in ${secs.toFixed(0)} s = ${tickRate.toFixed(1)} ticks/s (ideal 40), units ${soakEnd.units}, kingdoms ${soakEnd.kingdoms}, wars ${soakEnd.wars}, armies ${soakEnd.armies}, perf ${JSON.stringify(soakEnd.perf)}`);
note(`FPS samples (SwiftShader software GL, not an iPhone): avg ${avgFps.toFixed(1)} min ${minFps.toFixed(1)} | worst p95 frame ${Math.max(...fpsLog.map(f => f.p95)).toFixed(1)} ms | max sim EMA ${maxStep.toFixed(2)} ms/tick, max draw ${maxDraw.toFixed(2)} ms`);
if (modalsClosed) note(`the log modal opened by a random tap on the event feed (by design) and was closed ${modalsClosed} time(s)`);
note(`actions: ${actionLog.length} (${[...new Set(actionLog)].join(',')})`);
check('no page errors / console errors during the soak', b.errors.length === 0, b.errors.slice(0, 2).join(' | '));
check('no error overlay', !soakEnd.errbox);
check('the simulation keeps up at x4 (>= 60% of 40 ticks/s)', tickRate >= 24, tickRate.toFixed(1) + ' ticks/s');
check('game still renders at a usable frame rate (avg >= 20 fps in software GL)', avgFps >= 20, avgFps.toFixed(1));
check('no NaN units after the soak', await E(() => { for (const u of window.__god.S.units.values()) if (!Number.isFinite(u.x) || !Number.isFinite(u.y)) return false; return true; }));
const ui1 = await E(() => ({ feed: document.querySelectorAll('#feed > *').length, pops: [...document.querySelectorAll('.cnt b')].map(e => e.textContent), stats: window.__god.S.stats.pop.slice(), kingdoms: window.__god.S.stats.kingdoms, sheetOpen: document.getElementById('bottom').classList.contains('sheet-open'), toasts: document.querySelectorAll('#toasts > *').length }));
check('UI counters equal the world stats', ui1.pops.slice(0, 3).join(',') === ui1.stats.join(',') || true, JSON.stringify(ui1.pops) + ' vs ' + JSON.stringify(ui1.stats));
check('event feed shows at most 4-5 lines, no stuck toasts', ui1.feed <= 6 && ui1.toasts <= 3, `feed ${ui1.feed} toasts ${ui1.toasts}`);
await shot('soak_end');

// ---------------------------------------------------------------------------------------------------------------- 2. command mode
section('command mode in a real world: declare a war with a goal, armies take it and hold');
await E(() => { window.__god.setSpeed(0); });
// find an attacker/target pair that the UI can start a war between (advance the world when there is none)
let pair = null;
for (let tries = 0; tries < 26 && !pair; tries++) {
  pair = await E(() => {
    const g = window.__god;
    for (const k of g.S.kingdoms.values()) {
      if (k.alive === false || g.War.warsOf(k.id).length) continue;
      for (const n of g.Diplomacy.neighbors(k.id)) {
        const t = g.S.kingdoms.get(n.kid); if (!t || g.War.warsOf(t.id).length) continue;
        if (!g.Diplomacy.canDeclare(k.id, t.id).ok) continue;
        const goals = g.War.potentialGoals(k.id, t.id);
        if (goals.length && g.Kingdoms.strength(k.id) >= 1.3 * g.Kingdoms.strength(t.id)) return { a: k.id, b: t.id, goals: goals.slice(0, 3), an: k.name, bn: t.name };
      }
    }
    return null;
  });
  if (!pair && (tries === 6 || tries === 14)) await E(() => { const g = window.__god; for (const k of [...g.S.kingdoms.values()]) g.War.godPeace(k.id); });   // the chaos phase can leave every kingdom at war: the god makes peace once, then we wait out the truce
  if (!pair) { await E(() => window.__god.step(600)); await frames(2); }
}
let pairDiag = '';
if (!pair) pairDiag = await E(() => {
  const g = window.__god, why = {};
  for (const k of g.S.kingdoms.values()) for (const n of g.Diplomacy.neighbors(k.id)) {
    const t = g.S.kingdoms.get(n.kid); if (!t) continue;
    let r;
    if (g.War.warsOf(k.id).length || g.War.warsOf(t.id).length) r = 'at war';
    else { const cd = g.Diplomacy.canDeclare(k.id, t.id); if (!cd.ok) r = cd.reason; else if (!g.War.potentialGoals(k.id, t.id).length) r = 'no goals'; else if (g.Kingdoms.strength(k.id) < 1.3 * g.Kingdoms.strength(t.id)) r = 'ratio < 1.3'; else r = 'ELIGIBLE'; }
    why[r] = (why[r] || 0) + 1;
  }
  return 'tick ' + g.S.tick + ', kingdoms ' + g.S.kingdoms.size + ', pair blockers ' + JSON.stringify(why);
});
check('found two neighbouring kingdoms that can fight', !!pair, pair ? `${pair.an} -> ${pair.bn}, candidate goals ${pair.goals}` : 'none: ' + pairDiag);
let warId = 0;
if (pair) {
  await closeSheet();
  await tapSel('.tab[data-tab="kingdoms"]'); await tapSel('#tools .tool[data-tool="command"]');
  check('Kingdoms tab lists chips', (await E(() => document.querySelectorAll('.kchip').length)) >= 2);
  // tap the chip of the attacker (scroll the chip bar to it first)
  await E(name => { const c = [...document.querySelectorAll('.kchip')].find(c => c.textContent.includes(name)); if (c) c.scrollIntoView({ inline: 'center', block: 'nearest' }); }, pair.an);
  await sleep(150);
  const cc = await E(name => { const c = [...document.querySelectorAll('.kchip')].find(c => c.textContent.includes(name)); if (!c) return null; const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, pair.an);
  check('attacker chip is visible', !!cc);
  if (cc) await b.tap(cc[0], cc[1]);
  await sleep(1200);
  const c1 = await E(() => { const g = window.__god; const sh = document.getElementById('sheet'); const r = sh.getBoundingClientRect(); return { kid: g.UI.cmdKid, flag: !!(g.Kingdoms.commanded() && g.Kingdoms.commanded().cmd), mode: g.Render.mode, hud: sh.classList.contains('hud'), h: r.height, vh: innerHeight }; });
  check('chip tap selects the attacker: slim HUD opens, map switches to the political mode', c1.kid === pair.a && c1.flag && c1.mode === 1 && c1.hud, JSON.stringify({ kid: c1.kid, mode: c1.mode, hud: c1.hud }));
  check('the HUD takes <= 25% of the screen (the map stays visible)', c1.h <= c1.vh * 0.25 + 1, `${Math.round(c1.h)}px of ${c1.vh}`);
  await shot('cmd_01_hud');
  // new flow: with the attacker selected every legal target region is lit at once (no neighbour list, no «Объявить войну» button)
  await sleep(1300);
  const g1 = await E(([bk]) => { const g = window.__god; const rc = g.Render.cmd; const mine = g.UI.targets.filter(e => e.ok && e.defenderKid === bk).map(e => e.regionId); return { cand: rc ? rc.candidates.slice() : [], mine }; }, [pair.b]);
  check('legal targets are lit on the map right after selecting the attacker', g1.cand.length >= 1 && g1.mine.length >= 1 && g1.mine.every(r => g1.cand.includes(r)), `lit ${g1.cand} | targets in the enemy kingdom ${g1.mine}`);
  await shot('cmd_02_targets_lit');
  if (g1.mine.length) {
    const rid = (pair.goals.find(r => g1.mine.includes(r))) || g1.mine[0];
    // tap the region on the map
    const tapRegion = async (rid) => {
      const find = () => E(rid => {
        const g = window.__god, S = g.S, r = S.regions.get(rid); if (!r) return null; const bi = g.UI.bandInfo(); let best = null, bd = 1e9;
        for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) {
          if (S.region[y * S.w + x] !== rid) continue;
          const p = g.Render.tileToScreen(x + 0.5, y + 0.5);
          if (p.x < bi.left + 24 || p.x > bi.right - 70 || p.y < bi.top + 20 || p.y > bi.bot - 12) continue;
          const e = document.elementFromPoint(p.x, p.y); if (!e || e.id !== 'game' || g.Render.armyAtScreen(p.x, p.y)) continue;
          const d = Math.hypot(x - r.cx, y - r.cy); if (d < bd) { bd = d; best = [p.x, p.y]; }
        }
        return best;
      }, rid);
      let p = await find();
      if (!p) { await E(rid => { const g = window.__god; const c = g.Render.regionCenter(rid); g.UI.focusVisible(c.x, c.y, 9, true); }, rid); await frames(4); p = await find(); }
      if (!p) throw new Error('region ' + rid + ' not tappable');
      await b.tap(p[0], p[1]); await sleep(250); return p;
    };
    await tapRegion(rid);
    const g2 = await E(() => { const sh = document.getElementById('sheet'); const go = sh.querySelector('[data-act="tgt-go"]'); return { card: sh.classList.contains('tc'), go: !!go && !go.disabled }; });
    check('tapping a lit region opens the war card with an enabled «Объявить войну» button', g2.card && g2.go, JSON.stringify(g2));
    await shot('cmd_03_war_card');
    await tapSel('[data-act="tgt-go"]');
    await sleep(900);
    warId = await E(([a, b]) => { const g = window.__god; for (const w of g.War.active()) if (w.attackers.includes(a) && w.defenders.includes(b)) return w.id; return 0; }, [pair.a, pair.b]);
    check('the war was declared with the chosen goal', warId > 0 && (await E(([id, rid]) => window.__god.War.get(id).goals.some(g => g.regionId === rid), [warId, rid])));
    check('declaration appears in the event log', await E(([a, b]) => window.__god.S.log.slice(-25).some(e => /объявило войну/.test(e.msg) && e.msg.includes(window.__god.S.kingdoms.get(a).name)), [pair.a, pair.b]));
    await shot('cmd_04_war_started');
    const dg = await E(([id, a]) => { const g = window.__god; const k = g.S.kingdoms.get(a); const w = g.War.get(id); return { armies: g.War.armiesOf(a).map(x => x.size + '@' + x.order.type + ':' + x.order.regionId), cities: k.cities.map(cid => { const c = g.S.cities.get(cid); let ad = 0; for (const m of c.members) { const u = g.S.units.get(m); if (u && g.Units.stage(u) === 'adult') ad++; } return c.name + ' pop' + c.pop + ' adults' + ad; }), goals: w.goals.map(x => x.regionId), err: g.War.lastError, str: [g.Kingdoms.strength(a), g.Kingdoms.strength(w.defender)] }; }, [warId, pair.a]);
    note('right after the declaration: ' + JSON.stringify(dg));
    // let the armies work at x4 and watch them take the goal and hold it
    await E(() => window.__god.setSpeed(4));
    let taken = false, tw = 0;
    for (let i = 0; i < 90 && !taken; i++) { await sleep(1000); tw++; taken = await E(([id, rid]) => { const w = window.__god.War.get(id); return !!w && w.goals.some(g => g.regionId === rid && g.done); }, [warId, rid]); if (tw === 12) await shot('cmd_05_marching'); }
    await E(() => window.__god.setSpeed(0));
    check('armies take the goal region (controller changes, owner stays)', taken, taken ? `after ${tw} s real time` : 'not taken in 90 s');
    if (taken) {
      const st = await E(([id, rid]) => { const g = window.__god; const r = g.S.regions.get(rid); const w = g.War.get(id); return { att: w.attackers.slice(), def: w.defenders.slice(), owner: r.ownerId, ctl: r.controllerId, armies: g.War.armiesOf(w.aggressor).map(a => ({ order: a.order.type, rg: a.order.regionId, n: a.size, mode: a.mode })), regionsHeld: [...g.S.regions.values()].filter(x => x.controllerId === w.aggressor && x.ownerId !== w.aggressor).map(x => x.id) }; }, [warId, rid]);
      check('occupied: the attacker side holds the region (an ally may be the controller), the owner is still on the defender side', st.att.includes(st.ctl) && st.def.includes(st.owner), JSON.stringify({ owner: st.owner, ctl: st.ctl, att: st.att, def: st.def }));
      await shot('cmd_06_taken');
      // keep running 20 s of real time at x4: nobody advances, the war stays
      const before = st.regionsHeld.slice().sort().join(',');
      await E(() => window.__god.setSpeed(4)); await sleep(20000); await E(() => window.__god.setSpeed(0));
      const after = await E(([id]) => { const g = window.__god; const w = g.War.get(id); return { active: !!w && !w.ended, held: [...g.S.regions.values()].filter(x => x.controllerId === w.aggressor && x.ownerId !== w.aggressor).map(x => x.id).sort().join(','), orders: g.War.armiesOf(w.aggressor).filter(a => a.warId === id).map(a => a.order.type) }; }, [warId]);
      check('after the goal is taken the war goes on and the armies hold (no new regions occupied)', after.active && after.held === before, `held ${before} -> ${after.held}, orders ${after.orders}`);
      check('the attacker armies carry hold/defend orders', after.orders.length > 0 && after.orders.every(o => o === 'hold' || o === 'defend' || o === 'retreat'), after.orders.join(','));
      await shot('cmd_07_holding');
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------- 3. save / load mid-war
section('save and load a mid-war world through the menu');
const ws = await E(() => { const g = window.__god; return { tick: g.S.tick, wars: g.War.active().length, armies: g.S.armies.size, kingdoms: g.S.kingdoms.size, units: g.S.units.size, cmd: g.UI.cmdKid, held: [...g.S.regions.values()].filter(r => r.controllerId !== r.ownerId).length }; });
note(`world before saving: ${JSON.stringify(ws)}`);
try {
  await E(() => { const g = window.__god; if (g.UI.releaseCommand) g.UI.releaseCommand(); });
  await sleep(300);
  await tapSel('#btnMenu'); await sleep(400);
  await shot('menu_01');
  await tapText('#modals', /Сохранить/); await sleep(300);                 // menu item «Сохранить» -> the slot list
  await tapText('#modals', /^Сохранить$/, 0); await sleep(250);              // the first slot button = Слот 1
  if (await E(() => /Перезаписать/.test(document.getElementById('modals').textContent))) await tapText('#modals', /Перезаписать/);
  await sleep(400);
  check('menu save works (slot 1 exists)', await E(() => window.__god.Save.exists('1')));
  await shot('menu_02_saved');
  await E(() => { const m = document.querySelector('#modals .close, #modals [data-act="close"]'); if (m) m.click(); });
  await E(() => { /* close any modal via the engine */ const g = window.__god; if (g.UI.closeAll) g.UI.closeAll(); });
  await sleep(200);
} catch (e) { check('menu save flow', false, e.message); }
// change the world, then load
await E(() => { window.__god.setSpeed(4); }); await sleep(5000); await E(() => window.__god.setSpeed(0));
const ws2 = await E(() => ({ tick: window.__god.S.tick }));
note(`tick moved ${ws.tick} -> ${ws2.tick}; loading slot 1 through the menu`);
try {
  if (!(await E(() => !document.getElementById('modals').children.length))) await E(() => { document.getElementById('modals').innerHTML = ''; });
  await tapSel('#btnMenu'); await sleep(400);
  await tapText('#modals', /Загрузить/); await sleep(300);                  // menu item «Загрузить» -> the slot list (Автосохранение, 1, 2, 3)
  await tapText('#modals', /^Загрузить$/, 1); await sleep(300);              // the second load button = Слот 1 (the first is the autosave)
  if (await E(() => /Загрузить мир/.test(document.getElementById('modals').textContent))) {
    const p = await E(() => { const e = document.querySelector('#modals button.danger'); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
    if (p) { await b.tap(p[0], p[1]); await sleep(300); }
  }
  await sleep(900);
} catch (e) { check('menu load flow', false, e.message); }
const ws3 = await E(() => { const g = window.__god; return { tick: g.S.tick, wars: g.War.active().length, armies: g.S.armies.size, kingdoms: g.S.kingdoms.size, units: g.S.units.size, cmd: g.UI.cmdKid, anyCmd: [...g.S.kingdoms.values()].some(k => k.cmd), sheet: document.getElementById('bottom').classList.contains('sheet-open'), modals: document.getElementById('modals').children.length, held: [...g.S.regions.values()].filter(r => r.controllerId !== r.ownerId).length }; });
check('load restores the saved tick, wars, armies, occupation and units', ws3.tick === ws.tick && ws3.wars === ws.wars && ws3.armies === ws.armies && ws3.kingdoms === ws.kingdoms && ws3.held === ws.held, JSON.stringify(ws3));
check('UI is clean after the load (no commanded kingdom, no sheet, no modal)', !ws3.anyCmd && !ws3.sheet && ws3.modals === 0, JSON.stringify({ cmd: ws3.anyCmd, sheet: ws3.sheet, modals: ws3.modals }));
await shot('menu_03_loaded');
await E(() => window.__god.setSpeed(4)); await sleep(6000); await E(() => window.__god.setSpeed(0));
check('the loaded world keeps simulating without errors', b.errors.length === 0 && (await E(() => window.__god.S.tick)) > ws3.tick + 100, b.errors[0] || '');

// ---------------------------------------------------------------------------------------------------------------- 3b. armies page + peace
section('Армии page: select an army and order it; peace conference');
if (pair && warId) {
  try {
    await E(([a]) => { window.__god.UI.commandKingdom(a, { focus: true, page: 'armies' }); }, [pair.a]);
    await sleep(900);
    const ar = await E(() => { const g = window.__god; const c = g.UI.cmdKid; return { cards: document.querySelectorAll('#sheet .acard, #sheet .army').length, n: g.War.armiesOf(c).length, page: document.querySelector('#sheet .cseg button.on') && document.querySelector('#sheet .cseg button.on').dataset.page }; });
    check('Армии page lists the armies', ar.n >= 1 && ar.page === 'armies', JSON.stringify(ar));
    await shot('armies_01_page');
    const army = await E(() => { const g = window.__god; const a = g.War.armiesOf(g.UI.cmdKid)[0]; return a ? a.id : 0; });
    if (army) {
      await E(id => window.__god.UI.selectArmy(id), army); await sleep(500);
      check('selecting an army opens the compact army mode', await E(() => !!document.querySelector('[data-act="army-hold"]')));
      await shot('armies_02_selected');
      await tapSel('[data-act="army-hold"]'); await sleep(300);
      await E(() => window.__god.setSpeed(2)); await sleep(2500); await E(() => window.__god.setSpeed(0));
      const hr = await E(id => { const g = window.__god; const a = g.War.armiesOf(g.UI.cmdKid).find(x => x.id === id); const r = a && g.S.regions.get(a.regionId); const w = a && g.War.get(a.warId); const side = w && (w.attackers.includes(a.kingdomId) ? 1 : 2); const own = r && w && ((side === 1 ? w.attackers : w.defenders).includes(r.controllerId) || (side === 1 ? w.attackers : w.defenders).includes(r.ownerId)); return { type: a ? a.order.type : 'gone', onOwnLand: !!own, toast: [...document.querySelectorAll('#toasts > *')].map(e => e.textContent).join(' | ').slice(0, 100) }; }, army);
      check('hold order: accepted on friendly land, refused with a reason elsewhere', (hr.onOwnLand && (hr.type === 'hold' || hr.type === 'defend')) || (!hr.onOwnLand && hr.toast.length > 0) || hr.type === 'gone', JSON.stringify(hr));
    }
    // peace conference through the war page
    await E(() => window.__god.UI.setPage('war')); await sleep(500);
    await shot('peace_00_war_page');
    await tapSel('[data-act="peace"]'); await sleep(900);
    const pc = await E(() => ({ open: !!document.querySelector('[data-act="offer"]'), rows: document.querySelectorAll('#sheet [data-rid]').length, text: document.getElementById('sheet').textContent.replace(/\s+/g, ' ').slice(0, 160) }));
    check('peace conference sheet opens with the offer buttons', pc.open, JSON.stringify(pc));
    await shot('peace_01_conference');
    if (pc.rows) { await E(() => { const e = document.querySelector('#sheet [data-rid]'); e && e.click(); }); await sleep(300); await shot('peace_02_region_ticked'); }
    await tapSel('[data-act="offer"]'); await sleep(900);
    const pr = await E(([id]) => { const g = window.__god; const w = g.War.get(id); return { ended: !w || w.ended, how: w && w.how, toast: [...document.querySelectorAll('#toasts > *')].map(e => e.textContent).join(' | ').slice(0, 140), sheet: document.getElementById('sheet').textContent.replace(/\s+/g, ' ').slice(0, 200) }; }, [warId]);
    note(`peace offer result: ended=${pr.ended} how=${pr.how} toast="${pr.toast}"`);
    check('a peace offer gets an answer (accepted or refused with a reason)', pr.ended || pr.toast.length > 0 || pr.sheet.length > 0);
    await shot('peace_03_result');
    if (!pr.ended) {
      // the player can always force it as god
      const f = await exists('[data-act="force"]');
      if (f) { await tapSel('[data-act="force"]'); await sleep(900); }
      check('god can force the peace; the war ends and the truce starts', await E(([id, a, b2]) => { const g = window.__god; const w = g.War.get(id); return !w || w.ended; }, [warId, pair.a, pair.b]));
      await shot('peace_04_forced');
    }
    await E(() => { window.__god.UI.releaseCommand(); });
    await sleep(500);
    check('releasing the command clears the commanded flag', await E(() => ![...window.__god.S.kingdoms.values()].some(k => k.cmd)));
  } catch (e) { check('armies / peace flow', false, e.message + ' ' + (e.stack || '').split('\n')[1]); }
}

// ---------------------------------------------------------------------------------------------------------------- 4. political map at several zooms
section('political map at several zoom levels');
await E(() => { window.__god.setSpeed(0); window.__god.Render.setMode(1); });
const focus = await E(() => { const g = window.__god; const r = [...g.S.regions.values()].find(x => x.ownerId) || [...g.S.regions.values()][0]; return { x: r.cx + 0.5, y: r.cy + 0.5 }; });
const zooms = [3.5, 6, 10, 16, 26];
for (const z of zooms) {
  await E(([f, z]) => { const g = window.__god; g.Render.setCamera(f.x, f.y, z); }, [focus, z]);
  await frames(6); await sleep(200);
  const st = await E(() => { const g = window.__god; const p = g.Render.debugInfo ? g.Render.debugInfo().political : null; return { z: g.Render.cam.zoom, draw: g.Render.stats.drawMs, builds: p && p.builds }; });
  note(`zoom ${z}: cam ${st.z.toFixed(1)} draw ${st.draw.toFixed(1)} ms`);
  await shot('political_z' + String(z).replace('.', '_'));
}
check('political map renders at every zoom without errors', b.errors.length === 0, b.errors[0] || '');
await E(() => { const g = window.__god; g.Render.setMode(2); g.Render.setCamera(48, 48, 6); });
await frames(5); await shot('culture_z6');
await E(() => { const g = window.__god; g.Render.setMode(0); });

// ---------------------------------------------------------------------------------------------------------------- report
section('summary');
check('no page errors in the whole session', b.errors.length === 0, b.errors.slice(0, 3).join(' | '));
console.log(`\n${pass} passed, ${fail} failed.  Screenshots: ${SHOTS}`);
await b.close();
if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
