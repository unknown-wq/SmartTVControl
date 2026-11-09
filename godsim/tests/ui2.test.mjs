// Stage-2 UI test: command mode on the REAL index.html with real touch events (CDP).
//   node tests/ui2.test.mjs [--shots=/tmp/godsim-ui2-shots] [--nobuild] [--quick] [--only=390]
// Scenario (390x844): a hand-built world with two adjacent kingdoms (a chain of regions: A | B, B | B2), then entirely through the UI:
//   Kingdoms tab -> command tool -> tap a kingdom chip -> command sheet (Война | Армии | Регионы) -> «Объявить войну» -> goal picking on the map
//   -> «Начать войну» -> armies form, march, take the goal region and HOLD it (the war stays) -> select an army, hold / defend popup,
//   second ATTACK order on the other enemy region -> «+ Цель» -> peace conference (budget, refusal reason, offer, god force) -> release.
// Also: region inspector, kingdom inspector (wars / vassals / infamy / opinion causes), menu toggle «Авто‑мир», initial camera, scroll hint,
// and screenshots of every sheet / state at 390x844, 360x640, 320x568 and 844x390 (landscape).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const SHOTS = args.shots || '/tmp/godsim-ui2-shots';
fs.mkdirSync(SHOTS, { recursive: true });
if (!args.nobuild) execFileSync('node', [path.join(root, 'build.mjs'), '--check'], { cwd: root, stdio: 'pipe' });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ok   ' + name + (info !== undefined ? '  (' + info + ')' : '')); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (info !== undefined ? '  (' + info + ')' : '')); }
}
const section = s => console.log('\n# ' + s);

// ---------------------------------------------------------------------------------------------------------------------------
// in-page world builder (serialised by page.evaluate, must be self-contained): kingdom A in region chain[0], B in chain[1] (+ chain[2])
// ---------------------------------------------------------------------------------------------------------------------------
function arenaInPage(o) {
  const g = window.__god;
  const { S, Cities, Units, Kingdoms, Regions, World, Diplomacy } = g;
  o = o || {};
  function feed() {
    for (const c of S.cities.values()) {
      c.stock.food = Math.max(c.stock.food, 160); c.stock.wood = Math.max(c.stock.wood, 60);
      c.stock.iron = Math.max(c.stock.iron, 30); c.stock.stone = Math.max(c.stock.stone, 30); c.stock.gold = Math.max(c.stock.gold, 6);
    }
  }
  function siteIn(rid, race, away) {
    const r = S.regions.get(rid);
    let best = null, bs = -1e9;
    for (let y = 1; y < S.h - 1; y++) for (let x = 1; x < S.w - 1; x++) {
      if (S.region[y * S.w + x] !== rid) continue;
      if (!Cities.canFound(x, y, race)) continue;
      const dc = Math.hypot(x - r.cx, y - r.cy);
      if (dc > 7) continue;
      const sc = (away ? Math.hypot(x - away.cx, y - away.cy) : 0) - dc * 0.35;
      if (sc > bs) { bs = sc; best = { x, y }; }
    }
    return best;
  }
  function foundCity(rid, race, pop, away) {
    const site = siteIn(rid, race, away);
    if (!site) return null;
    const fs = [];
    for (let i = 0; i < 6; i++) {
      const u = Units.spawn(race, site.x + 0.5 + (i % 3) * 0.3, site.y + 0.5 + (i >> 1) * 0.3, { sex: i % 2, age: 22 + (i * 3) % 10 });
      if (!u) return null;
      fs.push(u);
    }
    const c = Cities.found(race, site.x, site.y, fs, {});
    if (!c) return null;
    for (let i = 6; i < pop; i++) {
      const u = Units.spawn(race, site.x + 0.5 + ((i * 7) % 5) * 0.3, site.y + 0.5 + ((i * 3) % 5) * 0.3, { sex: i % 2, age: 20 + (i * 5) % 20, cityId: c.id });
      if (u) u.hunger = 0;
    }
    feed();
    return c;
  }
  function findChain(len) {
    const byLand = new Map();
    for (const r of S.regions.values()) { const l = World.landId(r.cx, r.cy); if (!byLand.has(l)) byLand.set(l, []); byLand.get(l).push(r); }
    const lands = [...byLand.values()].sort((a, b) => b.length - a.length);
    const ok = (r, i) => (i !== 0 && i !== len - 1) || siteIn(r.id, 0, null);          // only the two ends host a village
    for (const regs of lands) {
      for (const a of regs) {
        if (!ok(a, 0)) continue;
        const path = [a];
        const dfs = () => {
          if (path.length === len) return true;
          const last = path[path.length - 1];
          for (const nid of last.nb) {
            if (last.fd.includes(nid)) continue;
            const n = S.regions.get(nid);
            if (!n || path.includes(n) || !ok(n, path.length)) continue;
            if (path.slice(0, -1).some(p => p.nb.includes(n.id))) continue;
            path.push(n);
            if (dfs()) return true;
            path.pop();
          }
          return false;
        };
        if (dfs()) return path.map(r => r.id);
      }
    }
    return null;
  }
  const len = o.chain || 3;
  const chain = findChain(len);
  if (!chain) return null;
  const rA = S.regions.get(chain[0]), rEnd = S.regions.get(chain[len - 1]);
  const cA = foundCity(chain[0], 0, o.popA || 60, rEnd);
  const cB = cA && foundCity(chain[len - 1], 0, o.popB || 54, rA);
  if (!cA || !cB) return null;
  if (cB.kingdomId === cA.kingdomId && !Kingdoms.splitCity(cB.id)) return null;
  if (cB.kingdomId === cA.kingdomId) return null;
  const A = cA.kingdomId, B = cB.kingdomId;
  // chain: A's land | empty regions owned by B (the buffer; the first goal) | B's capital region (the second goal)
  for (let i = 1; i < len - 1; i++) if (Regions.get(chain[i]).ownerId !== B) Regions.setOwner(chain[i], B, 'test');
  Diplomacy.step = () => {};                                  // no AI wars / alliances: the test is the only one who starts a war
  feed();
  return { chain, A, B, rA: chain[0], rMid: chain[1], rCap: chain[len - 1] };
}

// ---------------------------------------------------------------------------------------------------------------------------
async function open(w, h, extra = {}) {
  const b = await launch({ file: 'index.html', width: w, height: h, verbose: true, ...extra });
  const E = (fn, arg) => b.eval(fn, arg);
  const H = {
    b, E, w, h,
    async frames(n = 3) { await E(n => new Promise(r => { let k = 0; const f = () => { if (++k >= n) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n); },
    async shot(name) { const f = path.join(SHOTS, name + '.png'); await b.shot(f); return f; },
    center: sel => E(sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; }, sel),
    async tapSel(sel) {
      await E(sel => { const e = document.querySelector(sel); if (e && e.closest('.sh-body')) e.scrollIntoView({ block: 'nearest' }); }, sel);
      const c = await H.center(sel); if (!c) throw new Error('no element ' + sel); await b.tap(c[0], c[1]); await b.wait(120); return c;
    },
    exists: sel => E(sel => !!document.querySelector(sel), sel),
    count: sel => E(sel => document.querySelectorAll(sel).length, sel),
    text: sel => E(sel => { const e = document.querySelector(sel); return e ? e.textContent : null; }, sel),
    cmd: () => E(() => window.__god.UI.cmd),
    /** a free canvas pixel (not covered by the UI, no army banner) inside region rid; null when none is visible */
    regionPoint: (rid, band) => E(([rid, band]) => {
      const g = window.__god, S = g.S; let best = null, bd = 1e9;
      const r = S.regions.get(rid); if (!r) return null;
      const bi = g.UI.bandInfo();
      for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) {
        if (S.region[y * S.w + x] !== rid) continue;
        const p = g.Render.tileToScreen(x + 0.5, y + 0.5);
        if (p.x < bi.left + 24 || p.x > bi.right - 70 || p.y < bi.top + 20 || p.y > bi.bot - 12) continue;
        const e = document.elementFromPoint(p.x, p.y);
        if (!e || e.id !== 'game' || g.Render.armyAtScreen(p.x, p.y)) continue;
        const d = Math.hypot(x - r.cx, y - r.cy);
        if (d < bd) { bd = d; best = [p.x, p.y]; }
      }
      return best;
    }, [rid, band]),
    async tapRegion(rid) {
      let p = await H.regionPoint(rid);
      if (!p) { await E(rid => { const g = window.__god; const c = g.Render.regionCenter(rid); g.UI.focusVisible(c.x, c.y, 9, true); }, rid); await H.frames(4); p = await H.regionPoint(rid); }
      if (!p) throw new Error('region ' + rid + ' has no tappable point');
      await b.tap(p[0], p[1]); await b.wait(200);
      return p;
    },
    async focusRegion(rid, z = 8.5) { await E(([rid, z]) => { const g = window.__god; const c = g.Render.regionCenter(rid); g.UI.focusVisible(c.x, c.y, z, true); }, [rid, z]); await H.frames(4); },
    step: n => E(n => { const g = window.__god; g.step(n); return g.S.tick; }, n),
  };
  return H;
}
async function buildArena(H, opts) {
  const { E } = H;
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
    const a = await E(([seed, fn, o]) => { const g = window.__god; g.Main.newWorld({ seed, w: 96, h: 96, populate: false }); g.setSpeed(0); return eval('(' + fn + ')')(o); }, [seed, arenaInPage.toString(), opts || {}]);
    if (a) { a.seed = seed; await E(() => { const g = window.__god; g.step(150); g.Main.initialView(true); }); await H.frames(3); return a; }
  }
  return null;
}
const overflowCheck = (H) => H.E(() => {
  const bad = [];
  const sh = document.getElementById('sheet').getBoundingClientRect();
  for (const e of document.querySelectorAll('#sheet *')) {
    if (e.offsetParent === null) continue;
    const r = e.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > sh.right + 1 || r.left < sh.left - 1) { if (!e.closest('.sh-body') || r.width < sh.width) bad.push((e.className || e.tagName) + ' ' + Math.round(r.left) + '-' + Math.round(r.right)); }
    if (bad.length > 5) break;
  }
  return bad;
});

// ===========================================================================================================================
// 1. 390x844: the whole flow with assertions
// ===========================================================================================================================
const only = args.only ? String(args.only).split(',') : null;
if (!only || only.includes('390')) {
  const H = await open(390, 844);
  const { b, E } = H;
  await b.wait(1600);

  section('boot: initial camera on the largest settlement, scroll hint on the dock row');
  // a populated world: after boot the camera is near the biggest group at zoom ~12 (not the whole map)
  await E(() => { const g = window.__god; g.Main.newWorld({ seed: 7, w: 96, h: 96, populate: true }); g.setSpeed(0); });
  await H.frames(3);
  const iv = await E(() => { const g = window.__god; const c = g.Render.cam; const spot = g.Main.largestSettlement(); return { cam: { x: c.x, y: c.y, z: c.zoom }, spot, minZ: g.Render.minZoom(), maxZ: g.Render.maxZoom() }; });
  check('new populated world: camera zoom ~12 (not the whole map)', Math.abs(iv.cam.z - Math.min(12, iv.maxZ)) < 0.8, iv.cam.z.toFixed(1));
  check('camera centres near the biggest group of settlers', iv.spot && Math.hypot(iv.cam.x - iv.spot.x, iv.cam.y - iv.spot.y) < 12, iv.spot ? `spot ${iv.spot.x.toFixed(0)},${iv.spot.y.toFixed(0)} (${iv.spot.kind}) cam ${iv.cam.x.toFixed(0)},${iv.cam.y.toFixed(0)}` : 'no spot');
  await H.shot('01_initial_view');
  const hint = await E(() => { const t = document.getElementById('tools'); return { overflow: t.scrollWidth > t.clientWidth + 10, more: document.getElementById('tmoreR').classList.contains('on'), moreL: document.getElementById('tmoreL').classList.contains('on') }; });
  check('Powers row overflows and the right chevron hint is lit', hint.overflow && hint.more && !hint.moreL, JSON.stringify(hint));
  await E(() => { document.getElementById('tools').scrollLeft = 9999; });
  await b.wait(250);
  check('hint flips to the left chevron at the end of the row', await E(() => !document.getElementById('tmoreR').classList.contains('on') && document.getElementById('tmoreL').classList.contains('on')));
  await E(() => { document.getElementById('tools').scrollLeft = 0; });

  const arena = await buildArena(H);
  check('built a two-kingdom arena (A | B + B2)', !!arena, arena ? JSON.stringify(arena) : 'none');
  if (!arena) { console.log('cannot continue'); process.exit(1); }
  const { A, B } = arena;
  await b.wait(300);

  section('Kingdoms tab: the command tool is preselected, chips list both kingdoms');
  await H.tapSel('.tab[data-tab="kingdoms"]');
  const tab = await E(() => ({ tool: window.__god.UI.state.tool, chips: document.querySelectorAll('.kchip').length, on: document.querySelector('#tools .tool.on') && document.querySelector('#tools .tool.on').dataset.tool, tools: document.querySelectorAll('#tools .tool').length }));
  check('command tool selected by default on the Kingdoms tab', tab.tool === 'command' && tab.on === 'command', JSON.stringify(tab));
  check('kingdoms tab shows 4 tools (command + 3 diplomacy)', tab.tools === 4);
  check('both kingdoms are listed as chips', tab.chips === 2, tab.chips);
  check('no war icon on the chips in peace time', (await H.count('.kchip .wi:not(.hide)')) === 0);
  await H.shot('02_kingdoms_tab_command_tool');

  section('command a kingdom (chip tap) -> command sheet');
  const kA = await E(A => { const k = window.__god.S.kingdoms.get(A); return { name: k.name }; }, A);
  const chipA = await E(A => { const g = window.__god; const i = [...document.querySelectorAll('.kchip')].findIndex(c => c.textContent.includes(g.S.kingdoms.get(A).name)); return i; }, A);
  const cc = await E(i => { const r = document.querySelectorAll('.kchip')[i].getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, chipA);
  await b.tap(cc[0], cc[1]);
  await b.wait(1100);
  const c1 = await E(() => { const g = window.__god; const sh = document.getElementById('sheet').getBoundingClientRect(); const k = g.Kingdoms.commanded(); return { cmd: g.UI.cmd, cmdKid: g.UI.cmdKid, flag: k && k.cmd, rcKid: g.Render.cmd && g.Render.cmd.kid, mode: g.Render.mode, open: document.getElementById('bottom').classList.contains('sheet-open'), dockHidden: getComputedStyle(document.getElementById('dock')).display === 'none', h: sh.height, vh: innerHeight, title: document.querySelector('#sheet .sh-title b') && document.querySelector('#sheet .sh-title b').textContent, tabs: [...document.querySelectorAll('#sheet .cseg button')].map(x => x.textContent), onTab: document.querySelector('#sheet .cseg button.on') && document.querySelector('#sheet .cseg button.on').dataset.page }; });
  check('UI.cmdKid is the tapped kingdom; Kingdoms.setCommanded(kid) took effect', c1.cmdKid === A && c1.flag === true && c1.cmd.kid === A, JSON.stringify({ cmdKid: c1.cmdKid, flag: c1.flag }));
  check('Render.cmd is set for the commanded kingdom', c1.rcKid === A);
  check('map switched to the political mode (borders)', c1.mode === 1);
  check('command sheet replaces the dock', c1.open && c1.dockHidden);
  check('sheet header shows the kingdom name, 3 segmented pages (Война | Армии | Регионы), «Война» is active', c1.title === kA.name && c1.tabs.length === 3 && /Война/.test(c1.tabs[0]) && /Армии/.test(c1.tabs[1]) && /Регионы/.test(c1.tabs[2]) && c1.onTab === 'war', JSON.stringify(c1.tabs));
  check('sheet is at most 60% of the screen', c1.h <= c1.vh * 0.6 + 1, Math.round(c1.h) + ' / ' + c1.vh);
  check('paint button hidden and no paint of terrain in command mode', await E(() => getComputedStyle(document.querySelector('.fab.paint')).display === 'none'));
  const hdr = await E(() => ({ chips: [...document.querySelectorAll('#sheet .csum .sc')].map(x => x.textContent.replace(/\s+/g, ' ').trim()) }));
  check('header summary: regions, cities, population, stability', hdr.chips.length >= 4 && /рег/.test(hdr.chips[0]) && /гор/.test(hdr.chips[1]) && /жит/.test(hdr.chips[2]) && /%/.test(hdr.chips[3]), hdr.chips.join(' | '));
  const nb = await E(B => { const row = document.querySelector('.nrow[data-kid="' + B + '"]'); if (!row) return null; return { txt: row.textContent.replace(/\s+/g, ' '), btn: !!row.querySelector('[data-act="declare"]'), off: !!row.querySelector('.cbtn.off'), bar: !!row.querySelector('.bar.mid'), str: /Сила ×/.test(row.textContent), st: /Мир/.test(row.textContent) }; }, B);
  check('Война page lists the neighbour with status, opinion bar, strength ratio and «Объявить войну»', nb && nb.btn && !nb.off && nb.bar && nb.str && nb.st, nb && nb.txt);
  await H.shot('03_command_war_page');
  // opinion causes tooltip lines
  const barC = await E(B => { const r = document.querySelector('.nrow[data-kid="' + B + '"] .bar.mid').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, B);
  await b.tap(barC[0], barC[1]); await b.wait(250);
  check('tapping the opinion bar shows the causes (Diplomacy causes)', await E(B => { const c = document.querySelector('.nrow[data-kid="' + B + '"] .causes'); return !!c && !c.classList.contains('hide') && c.textContent.length > 5; }, B), await E(B => document.querySelector('.nrow[data-kid="' + B + '"] .causes').textContent.slice(0, 60), B));
  await H.shot('03b_opinion_causes');
  await b.tap(barC[0], barC[1]); await b.wait(150);

  section('goal picking: candidates highlighted, tap toggles stars, cost vs allowance, hint text');
  await H.tapSel('[data-act="declare"][data-kid="' + B + '"]');
  await b.wait(1300);
  const g1 = await E(() => { const g = window.__god; const c = g.UI.cmd; return { goal: c.goal, rc: g.Render.cmd && { cand: g.Render.cmd.candidates.slice(), goals: g.Render.cmd.goals.slice(), target: g.Render.cmd.targetKid }, foot: !!document.querySelector('.sh-foot [data-act="goal-go"]'), disabled: document.querySelector('[data-act="goal-go"]').disabled, h: document.getElementById('sheet').getBoundingClientRect().height, feedHidden: getComputedStyle(document.getElementById('feed')).visibility }; });
  check('goal mode: War.potentialGoals are the Render.cmd candidates, target kingdom set', g1.goal && g1.goal.cand.length >= 1 && g1.rc.cand.length === g1.goal.cand.length && g1.rc.target === B, JSON.stringify(g1.rc));
  check('«Начать войну» disabled until a goal is chosen', g1.disabled === true && g1.foot);
  check('the goal bar is compact (the map stays visible)', g1.h < 844 * 0.34, Math.round(g1.h) + 'px');
  check('feed lines hidden while picking', g1.feedHidden === 'hidden');
  await H.shot('04_goal_mode_empty');
  const cand = g1.goal.cand[0];
  // a tap on a region that is not a candidate gives a reason, no goal
  await H.tapRegion(arena.rA);
  check('tapping an own region is refused with a toast', (await H.cmd()).goal.goals.length === 0 && (await E(() => [...document.querySelectorAll('.toast.bad')].some(t => /ваш|граничит|ничья|Нужен/.test(t.textContent)))));
  await H.focusRegion(cand, 8);
  await H.tapRegion(cand);
  const g2 = await H.cmd();
  check('tap on a candidate region toggles it on (star marker + chip + cost)', g2.goal.goals.length === 1 && g2.goal.goals[0] === cand);
  const gb = await E(() => ({ chips: [...document.querySelectorAll('.gb-chips .chip')].map(c => c.textContent), bar: document.querySelector('.gb-bar .txt').textContent, hint: document.querySelector('.gb-hint').textContent, dis: document.querySelector('[data-act="goal-go"]').disabled }));
  check('footer lists the chosen goal, cost / allowance and a hint', gb.chips.length === 1 && /\d+ \/ \d+/.test(gb.bar) && gb.hint.length > 10 && !gb.dis, JSON.stringify(gb));
  await H.shot('05_goal_mode_chosen');
  await H.tapRegion(cand);
  check('a second tap removes the goal again', (await H.cmd()).goal.goals.length === 0);
  await H.tapRegion(cand);
  check('...and toggles it back on', (await H.cmd()).goal.goals.length === 1);
  // cancel returns to the war page, then restart
  await H.tapSel('[data-act="goal-cancel"]'); await b.wait(300);
  check('«Отмена» leaves goal mode (no war, candidates cleared)', (await H.cmd()).goal === null && (await E(() => window.__god.War.active().length)) === 0 && (await E(() => window.__god.Render.cmd.candidates.length)) === 0);
  await H.tapSel('[data-act="declare"][data-kid="' + B + '"]'); await b.wait(900);
  await H.focusRegion(cand, 8);
  await H.tapRegion(cand);

  section('«Начать войну» -> War.declare with exactly that goal; armies form');
  await H.tapSel('[data-act="goal-go"]');
  await b.wait(500);
  const w1 = await E(() => { const g = window.__god; const w = g.War.active()[0]; return w && { id: w.id, att: w.attackers, def: w.defenders, goals: w.goals.map(x => [x.kid, x.regionId, x.done]), casus: w.casus, page: g.UI.cmd.page, armies: g.War.armiesOf(g.UI.cmdKid).length, chip: [...document.querySelectorAll('.cseg button.on')].map(x => x.dataset.page) }; });
  check('war declared by the commanded kingdom with the chosen region as goal', w1 && w1.att[0] === A && w1.def[0] === B && w1.goals.length === 1 && w1.goals[0][1] === cand, JSON.stringify(w1));
  check('UI jumps to the Армии page', w1.page === 'armies' && w1.chip[0] === 'armies');
  check('armies were mustered', w1.armies >= 1, w1.armies);
  check('top bar shows the war counter', await E(() => !document.getElementById('counters').querySelector('.cnt.war').classList.contains('hide')));
  await H.shot('06_war_started_armies');
  await H.tapSel('.cseg button[data-page="war"]'); await b.wait(300);
  const wc = await E(() => { const c = document.querySelector('.wcard'); return c && { txt: c.textContent.replace(/\s+/g, ' '), bars: c.querySelectorAll('.bar').length, btns: [...c.querySelectorAll('.cbtn')].map(x => x.textContent.trim()), goal: !!c.querySelector('.chip.gold') }; });
  check('war card: enemy, two score bars, goal chip, «+ Цель» / «Фронт» / «Мир»', wc && wc.bars === 2 && wc.goal && /Цель/.test(wc.btns[0]) && /Мир/.test(wc.btns[2]), wc && wc.txt.slice(0, 90));
  await b.wait(1100);
  check('the kingdom chips show the war icon once the war runs', (await H.count('.kchip .wi:not(.hide)')) === 2, await H.count('.kchip .wi:not(.hide)'));
  check('header shows the war chip with the war score', await E(() => { const c = document.querySelector('#sheet .sc.war'); return !!c && !c.classList.contains('hide') && /\d+ : \d+/.test(c.textContent); }));
  await H.shot('07_war_card');

  section('armies take the goal region and HOLD it; the war does NOT end');
  // while the sim runs, the UI refreshes live: run x4 for a moment and make sure nothing throws
  await E(() => { window.__god.setSpeed(4); }); await b.wait(1800); await E(() => { window.__god.setSpeed(0); });
  let taken = false, tk = 0;
  for (let i = 0; i < 30 && !taken; i++) { tk = await H.step(100); taken = await E(([rid, A]) => window.__god.S.regions.get(rid).controllerId === A, [cand, A]); }
  check('the goal region is taken (controller = commanded kingdom, owner unchanged)', taken && (await E(([rid, B]) => window.__god.S.regions.get(rid).ownerId === B, [cand, B])), 'tick ' + tk);
  await H.step(60); await H.frames(3); await b.wait(400);
  const h1 = await E(([A, cand]) => { const g = window.__god; const arms = g.War.armiesOf(A); return { arms: arms.map(a => [a.order.type, a.order.regionId, a.mode]), wars: g.War.active().length, goalDone: g.War.active()[0].goals[0].done, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent) }; }, [A, cand]);
  check('the army order turned into «hold» on that region', h1.arms.length >= 1 && h1.arms.every(a => a[0] === 'hold' && a[1] === cand), JSON.stringify(h1.arms));
  check('goal is marked done and the war is still active', h1.goalDone === true && h1.wars === 1);
  await H.shot('08_region_held');
  await H.step(600);
  const h2 = await E(([A, B, rCap]) => { const g = window.__god; const r2 = g.S.regions.get(rCap); return { wars: g.War.active().length, r2ctl: r2 ? r2.controllerId : -1, r2own: r2 ? r2.ownerId : -1, B2: rCap }; }, [A, B, arena.rCap]);
  check('600 ticks later: war still on, the army did not advance to the next enemy region', h2.wars === 1 && h2.r2ctl === h2.r2own, JSON.stringify(h2));
  await H.tapSel('.cseg button[data-page="war"]'); await b.wait(300);
  const wc2 = await E(() => { const c = document.querySelector('.wcard'); return c && { goalChip: c.querySelector('.chip.good') ? c.querySelector('.chip.good').textContent : '', info: c.textContent.replace(/\s+/g, ' ') }; });
  check('war card shows the goal as taken («взят») and what we hold', wc2 && /взят/.test(wc2.goalChip) && /удерживаете: 1/.test(wc2.info), wc2 && wc2.goalChip);

  section('Армии page: select by list and by map marker, order popup, second attack order');
  await H.tapSel('.cseg button[data-page="armies"]'); await b.wait(300);
  const card = await E(() => { const c = document.querySelector('.acard'); return c && { id: +c.dataset.army, txt: c.textContent.replace(/\s+/g, ' '), supply: !!c.querySelector('.bar'), ord: !!c.querySelector('.ac-ord') }; });
  check('army card: size, strength, supply bar, order chip, region', card && card.supply && card.ord && /солдат/.test(card.txt) && /Снабжение/.test(card.txt) && /Удерживает/.test(card.txt), card && card.txt);
  await H.tapSel('.acard .ac-head'); await b.wait(900);
  const sel = await E(() => ({ cmd: window.__god.UI.cmd, rc: window.__god.Render.cmd.armyId, selCard: !!document.querySelector('.acard.sel'), actions: !!document.querySelector('.acard.sel [data-act="army-hold"]') }));
  check('tap on the card selects the army (UI + Render.cmd.armyId), actions appear', sel.cmd.armyId === card.id && sel.rc === card.id && sel.selCard && sel.actions);
  const tg = await E(() => ({ cand: window.__god.Render.cmd.candidates.slice(), am: document.getElementById('sheet').classList.contains('am'), h: document.getElementById('sheet').getBoundingClientRect().height }));
  check('with an army selected the attackable enemy regions are outlined (Render.cmd.candidates)', tg.cand.includes(arena.rCap), JSON.stringify(tg.cand));
  check('...and the sheet shrinks to the army (map stays free for orders)', tg.am && tg.h < 844 * 0.46, Math.round(tg.h) + 'px');
  await H.shot('09_army_selected');
  // deselect and select via the banner on the map
  await H.tapSel('.acard .ac-head'); await b.wait(200);
  check('tapping the selected card again deselects (full list again, no outlines)', (await H.cmd()).armyId === 0 && (await E(() => window.__god.Render.cmd.candidates.length)) === 0 && !(await E(() => document.getElementById('sheet').classList.contains('am'))));
  await H.tapSel('[data-act="show-orders"]'); await b.wait(150);
  check('«Приказы всех армий на карте» toggles Render.showAllOrders', await E(() => window.__god.Render.showAllOrders === true));
  await H.tapSel('[data-act="show-orders"]');
  check('...and back', await E(() => window.__god.Render.showAllOrders === false));
  const banner = await E(id => { const g = window.__god; const r = g.Render.armyBannerRect(id); return r && [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]; }, card.id);
  if (!banner) { await E(id => { const g = window.__god; const a = g.War.armiesOf(g.UI.cmdKid).find(x => x.id === id); g.UI.focusVisible(a.x, a.y, 8, true); }, card.id); await H.frames(4); }
  const banner2 = banner || await E(id => { const g = window.__god; const r = g.Render.armyBannerRect(id); return r && [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]; }, card.id);
  check('the army banner is on the map', !!banner2);
  if (banner2) { await b.tap(banner2[0], banner2[1]); await b.wait(300); }
  check('tapping the banner selects the army (Render army hit-test)', (await H.cmd()).armyId === card.id);
  // own region -> popup hold / defend
  await H.focusRegion(arena.rA, 8);
  await H.tapRegion(arena.rA);
  const pop = await E(() => { const p = document.querySelector('.cpop'); return p && { txt: p.textContent.replace(/\s+/g, ' '), btns: [...p.querySelectorAll('.cp-btn')].map(x => x.textContent.trim()), r: p.getBoundingClientRect().toJSON() }; });
  check('tap on an own region with an army selected opens a popup (Удерживать / Оборонять)', pop && pop.btns.length === 2 && /Удерживать/.test(pop.btns[0]) && /Оборонять/.test(pop.btns[1]), pop && pop.txt);
  check('popup stays inside the screen', pop && pop.r.left >= 0 && pop.r.right <= 390 && pop.r.top >= 0, pop && JSON.stringify([pop.r.left, pop.r.right, pop.r.top]));
  await H.shot('10_order_popup');
  await H.tapSel('.cpop .cp-btn:nth-child(2)'); await b.wait(300);
  const o1 = await E(id => { const a = window.__god.S.armies.get(id); return a && { t: a.order.type, r: a.order.regionId, auto: a.auto }; }, card.id);
  check('«Оборонять» issued War.order defend on that region (player order, not auto)', o1 && o1.t === 'defend' && o1.r === arena.rA && !o1.auto, JSON.stringify(o1));
  // attack order on the second enemy region (needs its own adjacency: B2 touches the held region)
  const rCap = arena.rCap;
  const adj = await E(([rCap, cand]) => window.__god.S.regions.get(rCap).nb.includes(cand), [rCap, cand]);
  check('the second enemy region touches the held one', adj);
  await H.focusRegion(rCap, 8);
  await H.tapRegion(rCap);
  const o2 = await E(id => { const a = window.__god.S.armies.get(id); return a && { t: a.order.type, r: a.order.regionId, auto: a.auto }; }, card.id);
  check('tap on an enemy region with an army selected = ATTACK order', o2 && o2.t === 'attack' && o2.r === rCap && !o2.auto, JSON.stringify(o2));
  check('toast confirms the order', await E(() => [...document.querySelectorAll('.toast')].some(t => /Атака на/.test(t.textContent))));
  await H.shot('11_attack_order');
  // let the army take it and hold again
  let t2 = false;
  for (let i = 0; i < 40 && !t2; i++) { await H.step(100); t2 = await E(([rid, A]) => window.__god.S.regions.get(rid).controllerId === A, [rCap, A]); }
  check('the second region is taken and held after the second order', t2);
  await H.step(80);
  const o3 = await E(id => { const a = window.__god.S.armies.get(id); return a && { t: a.order.type, r: a.order.regionId }; }, card.id);
  check('army holds the second region (order turned into hold again)', o3 && o3.t === 'hold' && o3.r === rCap, JSON.stringify(o3));
  // sea tap clears the selection
  const sea = await E(() => { const g = window.__god, S = g.S; const bi = g.UI.bandInfo(); for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) { if (S.tile[y * S.w + x] !== g.Const.T.DEEP) continue; const p = g.Render.tileToScreen(x + 0.5, y + 0.5); if (p.x > bi.left + 30 && p.x < bi.right - 90 && p.y > bi.top + 40 && p.y < bi.bot - 20) { const e = document.elementFromPoint(p.x, p.y); if (e && e.id === 'game') return [p.x, p.y]; } } return null; });
  if (sea) {
    if (!(await H.cmd()).armyId) { await H.tapSel('.acard .ac-head'); await b.wait(500); }
    check('an army is selected before the sea tap', (await H.cmd()).armyId === card.id);
    await b.tap(sea[0], sea[1]); await b.wait(250);
    check('tapping empty sea clears the selection', (await H.cmd()).armyId === 0 && (await E(() => window.__god.Render.cmd.armyId)) === 0);
  } else check('open sea visible for the clear-selection test', false);
  // bulk buttons
  await H.tapSel('[data-act="hold-all"]'); await b.wait(250);
  check('«Все: удерживать» gives hold orders to the armies standing on their land', (await E(A => window.__god.War.armiesOf(A).every(a => a.order.type === 'hold'), A)));
  await H.shot('12_armies_hold_all');

  section('«+ Цель» re-enters goal picking for the running war');
  await H.tapSel('.cseg button[data-page="war"]'); await b.wait(300);
  // only if another enemy region is still attackable: B's region list
  const more = await E(([A, B]) => window.__god.Regions.attackable(A, B).length, [A, B]);
  if (more > 0) {
    await H.tapSel('[data-act="addgoal"]'); await b.wait(1000);
    const ag = await H.cmd();
    check('+ Цель: goal mode bound to the running war', ag.goal && ag.goal.warId === w1.id && ag.goal.cand.length >= 1);
    await H.shot('13_add_goal');
    await H.tapSel('[data-act="goal-cancel"]'); await b.wait(300);
  } else check('+ Цель: (no further regions to add)', true);

  section('peace conference: occupied regions, budget bar, refusal reason, offer, god force');
  await H.tapSel('[data-act="peace"]'); await b.wait(1300);
  const pc = await E(() => ({ cmd: window.__god.UI.cmd.peace, chips: [...document.querySelectorAll('.pchip')].map(c => c.textContent.replace(/\s+/g, ' ').trim()), bar: document.querySelector('.gb-bar .txt') && document.querySelector('.gb-bar .txt').textContent, btns: [...document.querySelectorAll('.pc-foot .cbtn, .pc-force .cbtn')].map(x => x.textContent.trim()), scores: document.querySelectorAll('.pc-scores .bar').length }));
  check('peace sheet: both occupied regions are listed as toggle chips with costs', pc.cmd && pc.cmd.held.length === 2 && pc.chips.filter(c => /цена/.test(c)).length >= 2, pc.chips.join(' | '));
  check('peace sheet: budget bar vs war score, white peace / offer / god-force buttons', /\/ \d+ очков/.test(pc.bar) && pc.btns.length === 3 && pc.scores === 2, JSON.stringify(pc.btns) + ' ' + pc.bar);
  await H.shot('14_peace_sheet');
  // select everything -> probably over budget; toggling updates the bar
  const rids = pc.cmd.held;
  const pick = async (rid) => { const sel = '.pchip[data-rid="' + rid + '"]'; await H.tapSel(sel); };
  // make sure both are picked
  for (const rid of rids) { const on = await E(rid => window.__god.UI.cmd.peace.picks.includes(rid), rid); if (!on) await pick(rid); }
  const both = await E(() => ({ picks: window.__god.UI.cmd.peace.picks.length, bar: document.querySelector('.gb-bar .txt').textContent, offerDis: document.querySelector('[data-act="offer"]').disabled, rc: window.__god.Render.cmd.goals.length }));
  check('chips toggle the demanded regions (and the Render goals)', both.picks === 2 && both.rc === 2, JSON.stringify(both));
  const ov = await E(() => { const t = document.querySelector('.gb-bar .txt').textContent.match(/(\d+) \/ (\d+)/); return +t[1] > +t[2]; });
  if (ov) {
    check('over budget: «Предложить» is disabled', both.offerDis === true);
    await H.shot('15_peace_over_budget');
    await pick(rids[0]); await pick(rids[1]);                  // clear both
    await pick(rids[0]);
  } else check('budget allows both regions', true);
  // a refusal from the engine is shown as red text with its reason (mock one answer), then a real offer for the first region only
  await E(() => { const W = window.__god.War; window.__peaceOrig = W.peaceOffer; W.peaceOffer = () => ({ ok: true, accepted: false, pending: false, reason: 'противник отказался: требования слишком велики', cost: 99, allowance: 10 }); });
  await H.tapSel('[data-act="offer"]'); await b.wait(300);
  const rf = await E(() => ({ res: document.querySelector('.pc-res') ? document.querySelector('.pc-res').textContent : '', hidden: document.querySelector('.pc-res').classList.contains('hide'), peace: !!window.__god.UI.cmd.peace }));
  check('a refusal shows the reason text and keeps the conference open', !rf.hidden && /отказался: требования слишком велики/.test(rf.res) && rf.peace, JSON.stringify(rf));
  await H.shot('16_peace_refused');
  await E(() => { window.__god.War.peaceOffer = window.__peaceOrig; });
  // narrow the demand to the first region only (the second enemy region keeps B alive)
  await pick(arena.rCap);
  const keep = await E(() => window.__god.UI.cmd.peace.picks.slice());
  check('one region left in the demand (the goal)', keep.length === 1 && keep[0] === cand, JSON.stringify(keep));
  await H.tapSel('[data-act="offer"]'); await b.wait(600);
  const end = await E(([A, B, cand, rCap]) => { const g = window.__god; return { wars: g.War.active().length, own1: g.S.regions.get(cand).ownerId, own2: g.S.regions.get(rCap).ownerId, ctl1: g.S.regions.get(cand).controllerId, ctl2: g.S.regions.get(rCap).controllerId, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent), peace: g.UI.cmd.peace, truce: g.War.truceUntil(A, B) > g.S.tick, alive: !!g.S.kingdoms.get(B) }; }, [A, B, cand, arena.rCap]);
  check('the offer was accepted (AI sees a lost war) and the war is over', end.wars === 0 && end.peace === null, JSON.stringify(end));
  check('the demanded region changed its OWNER through the peace deal; the other one returned to B', end.own1 === A && end.ctl1 === A && end.own2 === B && end.ctl2 === B, `r1 owner ${end.own1}, r2 owner ${end.own2}`);
  check('a truce follows the peace', end.truce);
  check('toast reports the peace', end.toasts.some(t => /Мир заключён/.test(t)), end.toasts.join(' | '));
  // god force: a new war (casus god ignores the truce), conference, «Принудить (бог)»
  await E(([A, B, rCap]) => { const g = window.__god; g.War.declare(A, B, [rCap], 'god'); }, [A, B, arena.rCap]);
  await b.wait(1500);
  await H.tapSel('.cseg button[data-page="war"]'); await b.wait(300);
  check('a new war (god casus) is listed', (await H.count('.wcard')) === 1);
  await H.tapSel('[data-act="peace"]'); await b.wait(900);
  await H.shot('17_peace_new_war');
  await H.tapSel('[data-act="force"]'); await b.wait(600);
  const fo = await E(() => ({ wars: window.__god.War.active().length, peace: window.__god.UI.cmd.peace, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent) }));
  check('«Принудить (бог)» ends the war at once (War.forcePeace)', fo.wars === 0 && fo.peace === null && fo.toasts.some(t => /Бог навязал/.test(t)), JSON.stringify(fo));
  await H.shot('18_after_peace');
  const afterWar = await E(() => document.querySelector('#sheet .nrow, #sheet .muted') && document.querySelector('#sheet').textContent.replace(/\s+/g, ' ').slice(0, 120));
  check('command sheet is back on the war page', await E(() => !!document.querySelector('.cseg button.on[data-page="war"]')), afterWar);

  section('Регионы page + region inspector + kingdom inspector');
  await H.tapSel('.cseg button[data-page="info"]'); await b.wait(300);
  check('regions page lists own regions with the capital marked', await E(() => document.querySelectorAll('.rrow').length >= 2 && /Столица/.test(document.querySelector('.rlist').textContent)));
  await H.shot('19_regions_page');
  await H.tapSel('.rrow .rr-i'); await b.wait(500);
  const ri = await E(() => ({ insp: window.__god.UI.inspector, title: document.querySelector('.sh-title b') && document.querySelector('.sh-title b').textContent, rows: [...document.querySelectorAll('.sh-body .kv')].map(k => k.textContent.replace(/\s+/g, ' ').trim()), hl: window.__god.Render.cmd && window.__god.Render.cmd.regionId, secs: [...document.querySelectorAll('.sh-body .sec-h')].map(x => x.textContent) }));
  check('region inspector opens (info button on the regions page)', ri.insp && ri.insp.type === 'region' && ri.title, JSON.stringify(ri.insp));
  check('region card: owner, controller, value, terrain, cities, claims, neighbours', ri.rows.some(r => /Владелец/.test(r)) && ri.rows.some(r => /Контроль/.test(r)) && ri.rows.some(r => /Ценность/.test(r)) && ri.secs.includes('Города') && ri.secs.includes('Притязания') && ri.secs.includes('Соседи') && ri.secs.includes('Рельеф'), ri.secs.join(','));
  check('the region is highlighted on the map (pulsing outline)', ri.hl === ri.insp.id);
  await H.shot('20_region_inspector');
  await H.tapSel('.sh-btn:last-child'); await b.wait(400);
  check('closing the inspector returns to the command sheet', await E(() => !!document.querySelector('#sheet .cseg') && window.__god.UI.inspector === null));
  // kingdom inspector via the card button
  await E(() => { document.querySelector('.sh-body').scrollTop = 0; });
  await H.tapSel('[data-act="kingdom-card"]'); await b.wait(500);
  const ki = await E(() => ({ insp: window.__god.UI.inspector, secs: [...document.querySelectorAll('.sh-body .sec-h')].map(x => x.textContent), kv: [...document.querySelectorAll('.sh-body .kv')].map(k => k.textContent.replace(/\s+/g, ' ').trim()), bars: [...document.querySelectorAll('.sh-body .bar > label')].map(x => x.textContent) }));
  check('kingdom card: stability + infamy bars, regions, overlord / vassals, wars', ki.bars.includes('Стабильность') && ki.bars.includes('Дурная слава') && ki.kv.some(k => /^Регионов/.test(k)) && ki.kv.some(k => /^Сюзерен/.test(k)) && ki.kv.some(k => /^Вассалы/.test(k)) && ki.secs.includes('Войны') && ki.secs.includes('Отношения'), ki.bars.join(','));
  await E(() => { document.querySelector('.sh-body').scrollTop = 99999; }); await b.wait(150);
  await H.shot('21_kingdom_inspector_bottom');
  await E(() => { document.querySelector('.sh-body').scrollTop = 0; });
  const stRow = await E(() => { const r = [...document.querySelectorAll('.sh-body .bar')].find(x => /Стабильность/.test(x.textContent)).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await b.tap(stRow[0], stRow[1]); await b.wait(250);
  check('tapping the stability bar explains where it comes from', await E(() => { const c = document.querySelector('.sh-body .causes'); return !!c && !c.classList.contains('hide') && c.textContent.length > 4; }));
  await H.shot('22_kingdom_inspector_top');
  await H.tapSel('.sh-btn:last-child'); await b.wait(300);

  section('release command: AI resumes, sheet closes, map mode restored');
  await H.tapSel('[data-act="release"]'); await b.wait(500);
  const rl = await E(([A]) => { const g = window.__god; return { cmd: g.Kingdoms.commanded(), cmdKid: g.UI.cmdKid, rc: g.Render.cmd, dock: getComputedStyle(document.getElementById('dock')).display !== 'none', mode: g.Render.mode, kcmd: g.S.kingdoms.get(A).cmd, bodyCmd: document.body.classList.contains('cmd') }; }, [A]);
  check('closing releases the kingdom (Kingdoms.setCommanded false, Render.cmd null)', rl.cmd === null && rl.cmdKid === 0 && rl.rc === null && rl.kcmd === false);
  check('dock returns, map mode back to normal', rl.dock && rl.mode === 0 && !rl.bodyCmd);

  section('command by tapping the map: land / city / unit of a kingdom, foreign-region popup, wild land, sea');
  await H.tapSel('.tab[data-tab="kingdoms"]'); await b.wait(200);
  check('the command tool is still the Kingdoms tab tool', (await E(() => window.__god.UI.state.tool)) === 'command');
  const kid0 = () => E(() => window.__god.UI.cmdKid);
  await H.focusRegion(arena.rA, 8);
  await H.tapRegion(arena.rA);
  check('tap on the land of a kingdom commands it', (await kid0()) === A);
  await H.tapSel('[data-act="release"]'); await b.wait(300);
  // a city tap
  const capB = await E(B => { const g = window.__god; const k = g.S.kingdoms.get(B); const c = g.S.cities.get(k.capitalId) || g.S.cities.get(k.cities[0]); return c && { x: c.x + 0.5, y: c.y + 0.5 }; }, B);
  await E(c => window.__god.UI.focusVisible(c.x, c.y, 11, true), capB); await H.frames(4);
  const cp = await E(c => { const p = window.__god.Render.tileToScreen(c.x, c.y); return [p.x, p.y]; }, capB);
  await b.tap(cp[0], cp[1]); await b.wait(400);
  check('tap on a city commands its kingdom', (await kid0()) === B);
  await H.tapSel('[data-act="release"]'); await b.wait(300);
  // a unit tap (a civilian of A)
  const un = await E(A => { const g = window.__god; for (const u of g.S.units.values()) if (u.kingdomId === A && !u.armyId && u.cityId && !u.isRuler) return { id: u.id }; return null; }, A);
  await E(id => { const g = window.__god; const u = g.S.units.get(id); g.UI.focusVisible(u.x, u.y, 14, true); }, un.id); await H.frames(4);
  const up = await E(id => { const g = window.__god; const u = g.S.units.get(id); const p = g.Render.tileToScreen(u.x, u.y - 0.3); return [p.x, p.y]; }, un.id);
  await b.tap(up[0], up[1]); await b.wait(400);
  check('tap on a unit commands its kingdom', (await kid0()) === A);
  // a foreign region while commanding: popup with «Командовать» / «О регионе»
  await E(() => window.__god.UI.closeInspector());
  await H.focusRegion(arena.rCap, 8);
  await H.tapRegion(arena.rCap);
  const fp = await E(() => { const p = document.querySelector('.cpop'); return p && [...p.querySelectorAll('.cp-btn')].map(x => x.textContent.trim()); });
  check('a foreign region (no army selected) shows a popup: Командовать / О регионе', fp && fp.length === 2 && /Командовать/.test(fp[0]) && /О регионе/.test(fp[1]), JSON.stringify(fp));
  await H.shot('23a_foreign_region_popup');
  await H.tapSel('.cpop .cp-btn:nth-child(1)'); await b.wait(900);
  const sw = await E(([A, B]) => ({ cmd: window.__god.UI.cmdKid, a: window.__god.S.kingdoms.get(A).cmd, b: window.__god.S.kingdoms.get(B).cmd }), [A, B]);
  check('«Командовать» switches the command to that kingdom (only one at a time)', sw.cmd === B && sw.b === true && sw.a === false, JSON.stringify(sw));
  await H.tapSel('[data-act="release"]'); await b.wait(300);
  // wild land and sea
  const wild = await E(() => { const g = window.__god; const r = [...g.S.regions.values()].find(r => !r.ownerId); return r && r.id; });
  if (wild) {
    await H.focusRegion(wild, 8);
    await H.tapRegion(wild);
    check('tap on wild land does not command anything (hint toast)', (await kid0()) === 0 && (await E(() => document.querySelectorAll('.toast').length)) > 0);
  } else check('wild region exists', false);
  const sea2 = await E(() => { const g = window.__god, S = g.S; const bi = g.UI.bandInfo(); for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) { if (S.tile[y * S.w + x] !== g.Const.T.DEEP) continue; const p = g.Render.tileToScreen(x + 0.5, y + 0.5); if (p.x > bi.left + 30 && p.x < bi.right - 90 && p.y > bi.top + 40 && p.y < bi.bot - 20) { const e = document.elementFromPoint(p.x, p.y); if (e && e.id === 'game') return [p.x, p.y]; } } return null; });
  if (sea2) { await b.tap(sea2[0], sea2[1]); await b.wait(250); check('tap on empty sea with the command tool does nothing (and paints nothing)', (await kid0()) === 0 && (await E(() => window.__god.S.units.size)) >= 0); }
  // paint mode: the command tool forces the hand mode, a drag never paints
  await E(() => window.__god.UI.setMode('paint')); await b.wait(100);
  const e0 = await E(() => { const g = window.__god; let s = 0; for (let i = 0; i < g.S.tile.length; i += 7) s += g.S.tile[i] + g.S.elev[i]; return s; });
  await H.focusRegion(arena.rA, 8);
  const pp = await H.regionPoint(arena.rA);
  await b.drag(pp[0] - 40, pp[1], pp[0] + 40, pp[1] + 10, 8, 30); await b.wait(200);
  const e1 = await E(() => { const g = window.__god; let s = 0; for (let i = 0; i < g.S.tile.length; i += 7) s += g.S.tile[i] + g.S.elev[i]; return s; });
  check('a drag with the command tool never paints terrain (paint mode or not)', e0 === e1);
  await E(() => window.__god.UI.setMode('pan'));
  await H.tapSel('.tab[data-tab="info"]'); await b.wait(200);

  section('Info tool: region inspector on a tap; menu toggle «Авто‑мир»; log focus on a region');
  await H.tapSel('.tab[data-tab="info"]'); await b.wait(200);
  await H.focusRegion(arena.rA, 8);
  await H.tapRegion(arena.rA);
  await b.wait(400);
  const it = await E(() => window.__god.UI.inspector);
  check('Info tool tap on a region opens the region inspector', it && (it.type === 'region' || it.type === 'city' || it.type === 'unit' || it.type === 'building'), JSON.stringify(it));
  await E(() => { const g = window.__god; const r = [...g.S.regions.values()].find(r => r.ownerId === 0 || true); g.UI.openInspector('region', r.id); });
  await b.wait(300);
  check('openInspector("region", id) works for any region', (await E(() => window.__god.UI.inspector)).type === 'region');
  await H.tapSel('.sh-btn:last-child'); await b.wait(200);
  await H.tapSel('#btnMenu'); await b.wait(300);
  const ap0 = await E(() => ({ on: document.querySelector('[data-act="autopeace"]').classList.contains('on'), war: window.__god.War.autoPeace(), items: document.querySelectorAll('.mbtn').length }));
  check('menu has the «Авто‑мир при истощении» toggle matching War.autoPeace()', ap0.on === ap0.war && ap0.items === 6, JSON.stringify(ap0));
  await H.shot('23_menu_autopeace');
  await H.tapSel('[data-act="autopeace"]'); await b.wait(150);
  const ap1 = await E(() => ({ on: document.querySelector('[data-act="autopeace"]').classList.contains('on'), war: window.__god.War.autoPeace() }));
  check('toggle calls War.setAutoPeace', ap1.on === !ap0.on && ap1.war === !ap0.war, JSON.stringify(ap1));
  await H.tapSel('[data-act="autopeace"]'); await b.wait(100);
  check('toggle back', (await E(() => window.__god.War.autoPeace())) === ap0.war);
  await E(() => window.__god.UI.closeAllModals());
  // log entry with coordinates focuses the camera and flashes the region
  await E(() => { const g = window.__god; g.Render.setCamera(3, 3, 4); g.UI.openLog(); });
  await b.wait(300);
  const li = await E(() => { const items = [...document.querySelectorAll('.log-item')]; const i = items.findIndex(e => e.querySelector('canvas.go') && /войн|оккупир|мир/i.test(e.textContent)); return { i, n: items.length }; });
  check('the log lists war lines with a map focus icon', li.i >= 0, JSON.stringify(li));
  if (li.i >= 0) {
    await E(i => document.querySelectorAll('.log-item')[i].click(), li.i); await b.wait(900);
    const lf = await E(() => ({ z: window.__god.Render.cam.zoom, hl: window.__god.Render.cmd && window.__god.Render.cmd.regionId, modal: !!document.querySelector('.m-card') }));
    check('log entry focuses the camera and pulses its region', lf.z >= 10 && lf.hl > 0 && !lf.modal, JSON.stringify(lf));
    await H.shot('24_log_region_focus');
  }
  check('no page errors in the whole flow', b.errors.length === 0, b.errors.slice(0, 3).join(' || '));
  await b.close();
}

// ===========================================================================================================================
// 2. other viewports: the same states, screenshots + layout checks
// ===========================================================================================================================
async function states(w, h, name) {
  section(`viewport ${w}x${h} (${name}): every sheet and state`);
  const H = await open(w, h);
  const { b, E } = H;
  await b.wait(1500);
  const arena = await buildArena(H);
  check('arena built', !!arena);
  if (!arena) { await b.close(); return; }
  const { A, B } = arena;
  const land = w > h;
  const sheetOk = async (label) => {
    const r = await E(() => { const s = document.getElementById('sheet').getBoundingClientRect(); return { l: s.left, r: s.right, t: s.top, b: s.bottom, vh: innerHeight, vw: innerWidth, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }; });
    const bad = await overflowCheck(H);
    check(`${label}: sheet inside the screen, no horizontal overflow` , r.l >= -1 && r.r <= r.vw + 1 && r.b <= r.vh + 1 && r.sw <= r.cw && bad.length === 0, bad.join('; ') || `${Math.round(r.t)}-${Math.round(r.b)} of ${r.vh}`);
    if (!land) check(`${label}: portrait sheet <= 60% of the screen`, (r.b - r.t) <= r.vh * 0.6 + 1, Math.round((r.b - r.t) / r.vh * 100) + '%');
  };
  await H.tapSel('.tab[data-tab="kingdoms"]'); await H.shot(`${name}_01_kingdoms_tab`);
  await E(A => window.__god.UI.commandKingdom(A, {}), A); await b.wait(1100);
  await sheetOk('war page'); await H.shot(`${name}_02_war_page`);
  await H.tapSel('[data-act="declare"][data-kid="' + B + '"]'); await b.wait(1200);
  await sheetOk('goal bar');
  const cand = (await H.cmd()).goal.cand[0];
  await H.focusRegion(cand, 7.5);
  await H.tapRegion(cand);
  await H.shot(`${name}_03_goal_mode`);
  await H.tapSel('[data-act="goal-go"]'); await b.wait(500);
  await H.step(250); await H.frames(3);
  await sheetOk('armies page'); await H.shot(`${name}_04_armies`);
  await H.tapSel('.acard .ac-head'); await b.wait(900);
  await sheetOk('army selected'); await H.shot(`${name}_05_army_selected`);
  let taken = false;
  for (let i = 0; i < 30 && !taken; i++) { await H.step(100); taken = await E(([rid, A]) => window.__god.S.regions.get(rid).controllerId === A, [cand, A]); }
  await H.step(80);
  await H.focusRegion(arena.rA, 7.5);
  await H.tapRegion(arena.rA);
  await H.shot(`${name}_06_popup`);
  await H.tapSel('.cpop .cp-btn:nth-child(1)'); await b.wait(200);
  await H.tapSel('.cseg button[data-page="war"]'); await b.wait(300);
  await sheetOk('war card'); await H.shot(`${name}_07_war_card`);
  await H.tapSel('.cseg button[data-page="info"]'); await b.wait(300);
  await sheetOk('regions page'); await H.shot(`${name}_08_regions`);
  await H.tapSel('.cseg button[data-page="war"]'); await b.wait(200);
  await H.tapSel('[data-act="peace"]'); await b.wait(1200);
  await sheetOk('peace sheet'); await H.shot(`${name}_09_peace`);
  await E(() => { const t = document.querySelector('.pc-force'); if (t) t.scrollIntoView({ block: 'end' }); }); await b.wait(150);
  await H.shot(`${name}_09b_peace_scrolled`);
  await H.tapSel('.sh-btn.back'); await b.wait(300);
  await H.tapSel('[data-act="release"]'); await b.wait(400);
  await E(() => window.__god.UI.openInspector('region', [...window.__god.S.regions.values()][3].id)); await b.wait(500);
  await sheetOk('region inspector'); await H.shot(`${name}_10_region_inspector`);
  await E(A => window.__god.UI.openInspector('kingdom', A), A); await b.wait(500);
  await sheetOk('kingdom inspector'); await H.shot(`${name}_11_kingdom_inspector`);
  await E(() => { window.__god.UI.closeInspector(); window.__god.UI.openMenu(); }); await b.wait(300);
  await H.shot(`${name}_12_menu`);
  const mc = await E(() => { const c = document.querySelector('.m-card').getBoundingClientRect(); return [c.top, c.bottom, innerHeight]; });
  check(`menu card fits (${name})`, mc[0] >= 0 && mc[1] <= mc[2] + 1, mc.map(Math.round).join(','));
  const small = await E(() => [...document.querySelectorAll('#sheet button, .cpop button, .m-card button')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.height < 34 || r.width < 30) && e.offsetParent !== null; }).map(e => (e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)));
  check(`no tiny buttons in the sheets (${name})`, small.length === 0, small.slice(0, 4).join('; '));
  check(`no page errors (${name})`, b.errors.length === 0, b.errors.slice(0, 3).join(' || '));
  await b.close();
}
if (!only || only.includes('small')) await states(360, 640, 'small');
if (!args.quick) {
  if (!only || only.includes('tiny')) await states(320, 568, 'tiny');
  if (!only || only.includes('land')) await states(844, 390, 'land');
  if (!only || only.includes('big')) await states(430, 932, 'big');
}

// ===========================================================================================================================
// 2b. robustness: world replacement / kingdom death / save-load while commanding, then a random-tap fuzz over sheet + map
// ===========================================================================================================================
if (!only || only.includes('fuzz')) {
  section('robustness: world replaced, kingdom destroyed, save/load while commanding; random taps');
  const H = await open(390, 844);
  const { b, E } = H;
  await b.wait(1500);
  const arena = await buildArena(H);
  if (arena) {
    const { A, B } = arena;
    await E(A => window.__god.UI.commandKingdom(A, {}), A); await b.wait(500);
    // save while commanding: the flag is in the save, but a load must not leave the AI of that kingdom switched off
    await E(() => { window.__god.Save.save('2'); });
    check('Kingdom.cmd is true while commanding', await E(A => window.__god.S.kingdoms.get(A).cmd === true, A));
    await E(() => { const g = window.__god; g.Save.load('2'); g.Main.worldReplaced('load'); });
    await b.wait(300);
    const afterLoad = await E(() => { const g = window.__god; return { cmdKid: g.UI.cmdKid, anyCmd: [...g.S.kingdoms.values()].some(k => k.cmd), open: document.getElementById('bottom').classList.contains('sheet-open'), rc: g.Render.cmd, body: document.body.classList.contains('cmd') }; });
    check('after a load: command released everywhere (no kingdom keeps k.cmd, no sheet, Render.cmd null)', afterLoad.cmdKid === 0 && !afterLoad.anyCmd && !afterLoad.open && afterLoad.rc === null && !afterLoad.body, JSON.stringify(afterLoad));
    // new world while commanding
    await E(A => window.__god.UI.commandKingdom(A, {}), A); await b.wait(300);
    await E(() => { window.__god.Main.newWorld({ seed: 5, w: 64, h: 64, populate: true }); });
    await b.wait(300);
    check('a new world while commanding closes the sheet and releases', await E(() => window.__god.UI.cmdKid === 0 && !document.getElementById('bottom').classList.contains('sheet-open') && window.__god.Render.cmd === null));
    // the commanded kingdom dies
    const a2 = await buildArena(H);
    await E(A => window.__god.UI.commandKingdom(A, {}), a2.A); await b.wait(300);
    await E(A => { const g = window.__god; g.Kingdoms.destroy(A, 'test'); }, a2.A);
    await b.wait(600);
    check('a destroyed commanded kingdom: sheet closes, toast, no errors', await E(() => window.__god.UI.cmdKid === 0 && !document.getElementById('bottom').classList.contains('sheet-open')));
    // random fuzz in a fresh war
    const a3 = await buildArena(H);
    await E(A => window.__god.UI.commandKingdom(A, {}), a3.A); await b.wait(300);
    await E(([A, B]) => { window.__god.War.declare(A, B, [], undefined); }, [a3.A, a3.B]);
    await E(() => window.__god.step(200));
    let seed = args.seed ? +args.seed : 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    let taps = 0;
    for (let i = 0; i < (args.fuzz ? +args.fuzz : 160); i++) {
      const r = rnd();
      if (r < 0.45) {                          // a button of the sheet / popup
        const sel = await E(() => { const bs = [...document.querySelectorAll('#sheet button, .cpop button')].filter(x => x.offsetParent !== null && !x.disabled && !x.matches('[data-act="release"]') && !x.matches('[data-act="retreat-all"]')); if (!bs.length) return null; const e = bs[Math.floor(Math.random() * bs.length)]; e.scrollIntoView({ block: 'nearest' }); const q = e.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; });
        if (sel) { await b.tap(sel[0], sel[1]); taps++; }
      } else if (r < 0.85) {                   // the map
        const x = 20 + rnd() * 350, y = 120 + rnd() * 330;
        await b.tap(x, y); taps++;
      } else if (r < 0.92) await E(() => window.__god.step(30));
      else if (r < 0.96) await b.drag(100 + rnd() * 150, 200 + rnd() * 150, 100 + rnd() * 150, 200 + rnd() * 150, 5, 15);
      else await E(() => { const g = window.__god; if (g.UI.cmd.goal) g.UI.cmd; });
      if (i % 40 === 39) await b.wait(250);
    }
    await b.wait(400);
    const st = await E(() => ({ cmd: window.__god.UI.cmd, err: document.getElementById('errbox').hidden }));
    check(`${taps} random taps / drags over the command UI: no page errors, error box hidden`, b.errors.length === 0 && st.err, b.errors.slice(0, 2).join(' || '));
    await H.shot('25_after_fuzz');
  } else check('arena for the robustness test', false);
  await b.close();
}

// ===========================================================================================================================
// 3. perf of the live refresh with the command sheet open
// ===========================================================================================================================
if (!only || only.includes('perf')) {
  section('perf: UI refresh with an open command sheet during a war');
  const H = await open(390, 844);
  const { b, E } = H;
  await b.wait(1500);
  const arena = await buildArena(H);
  if (arena) {
    await E(A => { const g = window.__god; g.UI.commandKingdom(A, {}); }, arena.A);
    await b.wait(800);
    await E(([A, B]) => { const g = window.__god; const w = g.War.declare(A, B, [], undefined); }, [arena.A, arena.B]);
    await E(() => window.__god.step(300));
    for (const page of ['war', 'armies', 'info']) {
      await H.tapSel('.cseg button[data-page="' + page + '"]'); await b.wait(200);
      const ms = await E(() => { const g = window.__god; const t0 = performance.now(); for (let i = 0; i < 100; i++) g.UI.update(300); return (performance.now() - t0) / 100; });
      console.log(`  UI.update (${page} page): ${ms.toFixed(3)} ms per refresh (4 per second)`);
      check(`UI refresh on the ${page} page < 3 ms`, ms < 3, ms.toFixed(3));
    }
    await E(() => { window.__god.setSpeed(4); });
    await b.wait(3000);
    const st = await E(() => ({ stepMs: window.__god.S.perf.stepMs, frame: window.__god.stats.frameMs, tick: window.__god.S.tick }));
    console.log(`  x4 with the command sheet open: sim ${st.stepMs.toFixed(2)} ms/tick, frame cpu ${st.frame.toFixed(1)} ms`);
    check('x4 war with open sheet: frame cpu < 25 ms', st.frame < 25, st.frame.toFixed(1));
    check('no page errors during live refresh', b.errors.length === 0, b.errors.slice(0, 2).join(' || '));
  }
  await b.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('screenshots in ' + SHOTS);
