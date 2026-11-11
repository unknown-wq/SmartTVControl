// War-tool UI test (map first): the REAL index.html driven with real touch events (CDP).
//   node tests/ui2.test.mjs [--shots=/tmp/godsim-ui2-shots] [--nobuild] [--quick] [--only=390,small,tiny,land,lands,big,fuzz,perf] [--fuzz=N --seed=S]
// Scenario (390x844): a hand-built world with two adjacent kingdoms (a chain of regions: A | B, B | B2), then entirely through the UI:
//   Kingdoms tab -> war tool -> tap a country chip = ATTACKER (slim HUD, outline, the regions it may attack lit = War.targetsFor) ->
//   a truce dims the neighbour (a tap explains why) -> tap a lit region = war card (defender, odds, cost vs allowance, casus) -> cancel ->
//   again -> «Объявить войну» = exactly one war with exactly that goal -> «ВОЙНА» banner -> war HUD -> armies take the goal region and HOLD it ->
//   drawer (Войны | Армии | Регионы) -> select an army (card / banner), hold / defend popup, tap the next enemy region = attack card ->
//   «Атаковать» = goal + attack order -> sea tap steps back -> «+ Цель» -> peace conference (budget, refusal reason, offer, god force) ->
//   inspectors («Дипломатия» section) -> release (no stuck state) -> map taps (land / city / unit / neighbour / wild / sea) -> an AI war gets
//   the same banner (and no duplicate feed line) -> Info tool, menu «Авто‑мир», log focus.
// Then: every state at 360x640, 320x568, 844x390, 667x375, 430x932 (no overflow, no overlap of the floating buttons with the top bar / panels),
// robustness (save / load / new world / kingdom death while selected), a random-tap fuzz, and the cost of the live refresh.
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
      const c = await H.center(sel); if (!c) throw new Error('no element ' + sel); await b.tap(c[0], c[1]); await b.wait(160); return c;
    },
    exists: sel => E(sel => !!document.querySelector(sel), sel),
    count: sel => E(sel => document.querySelectorAll(sel).length, sel),
    text: sel => E(sel => { const e = document.querySelector(sel); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }, sel),
    cmd: () => E(() => window.__god.UI.cmd),
    /** a free canvas pixel (not covered by the UI, no army banner) inside region rid; null when none is visible */
    regionPoint: rid => E(rid => {
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
    }, rid),
    async tapRegion(rid) {
      await E(() => { document.querySelectorAll('.toast').forEach(t => t.remove()); });          // toasts sit over the map; they never take taps, but keep the points free
      let p = await H.regionPoint(rid);
      if (!p) { await E(rid => { const g = window.__god; const c = g.Render.regionCenter(rid); g.UI.focusVisible(c.x, c.y, 9, true); }, rid); await H.frames(4); p = await H.regionPoint(rid); }
      if (!p) throw new Error('region ' + rid + ' has no tappable point');
      await b.tap(p[0], p[1]); await b.wait(220);
      return p;
    },
    async focusRegion(rid, z = 8.5) { await E(([rid, z]) => { const g = window.__god; const c = g.Render.regionCenter(rid); g.UI.focusVisible(c.x, c.y, z, true); }, [rid, z]); await H.frames(4); },
    step: n => E(n => { const g = window.__god; g.step(n); return g.S.tick; }, n),
    seaPoint: () => E(() => { const g = window.__god, S = g.S; const bi = g.UI.bandInfo(); for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) { if (S.tile[y * S.w + x] !== g.Const.T.DEEP) continue; let land = false; for (let j = -2; j <= 2 && !land; j++) for (let i = -2; i <= 2; i++) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < S.w && yy < S.h && S.region[yy * S.w + xx]) { land = true; break; } } if (land) continue; const p = g.Render.tileToScreen(x + 0.5, y + 0.5); if (p.x > bi.left + 30 && p.x < bi.right - 90 && p.y > bi.top + 40 && p.y < bi.bot - 20) { const e = document.elementFromPoint(p.x, p.y); if (e && e.id === 'game') return [p.x, p.y]; } } return null; }),
    /** everything the war tool may leave behind */
    state: () => E(() => {
      const g = window.__god, bc = document.body.classList;
      return { kid: g.UI.cmdKid, cmd: bc.contains('cmd'), pick: bc.contains('cmd-pick'), drawer: bc.contains('cmd-drawer'), rc: g.Render.cmd, hl: g.Render.highlight, pop: !!document.querySelector('.cpop'),
        sheetOpen: document.getElementById('bottom').classList.contains('sheet-open'), feedVis: getComputedStyle(document.getElementById('feed')).visibility, paint: getComputedStyle(document.querySelector('.fab.paint')).display,
        dock: getComputedStyle(document.getElementById('dock')).display, anyCmd: [...g.S.kingdoms.values()].some(k => k.cmd), mode: g.Render.mode };
    }),
  };
  return H;
}
const isClean = s => s.kid === 0 && !s.cmd && !s.pick && !s.drawer && s.rc === null && s.hl === null && !s.pop && !s.sheetOpen && s.feedVis === 'visible' && s.paint !== 'none' && s.dock !== 'none' && !s.anyCmd;
async function buildArena(H, opts) {
  const { E } = H;
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
    const a = await E(([seed, fn, o]) => { const g = window.__god; g.Main.newWorld({ seed, w: 96, h: 96, populate: false }); g.setSpeed(0); return eval('(' + fn + ')')(o); }, [seed, arenaInPage.toString(), opts || {}]);
    if (a) { a.seed = seed; await E(() => { const g = window.__god; g.step(150); g.Main.initialView(true); }); await H.frames(3); return a; }
  }
  return null;
}
const truceKey = (A, B) => (A < B ? A + '_' + B : B + '_' + A);
const overflowCheck = (H) => H.E(() => {
  const bad = [];
  const sh = document.getElementById('sheet').getBoundingClientRect();
  for (const e of document.querySelectorAll('#sheet *')) {
    if (!e.getClientRects().length) continue;
    const r = e.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > sh.right + 1 || r.left < sh.left - 1) { if (!e.closest('.sh-body') && !e.closest('.hscroll') || r.width < sh.width) { if (!e.closest('.hscroll')) bad.push((e.className || e.tagName) + ' ' + Math.round(r.left) + '-' + Math.round(r.right)); } }
    if (bad.length > 5) break;
  }
  return bad;
});
/** floating buttons vs top bar / panel / each other, horizontal overflow, banner inside the screen */
const layoutCheck = (H) => H.E(() => {
  const rect = e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const ov = (a, c) => a.x < c.r - 1 && c.x < a.r - 1 && a.y < c.b - 1 && c.y < a.b - 1;
  const top = rect(document.getElementById('top'));
  const sh = document.getElementById('sheet'), s = vis(sh) && document.getElementById('bottom').classList.contains('sheet-open') ? rect(sh) : null;
  const fabs = [...document.querySelectorAll('#fabs .fab, #fabs .zoom')].filter(vis).map(rect);
  const feed = [...document.querySelectorAll('#feed .fl')].filter(vis).map(rect);
  const banner = [...document.querySelectorAll('.wb-card')].map(rect);
  let fabFab = false;
  for (let i = 0; i < fabs.length; i++) for (let j = i + 1; j < fabs.length; j++) if (ov(fabs[i], fabs[j])) fabFab = true;
  return { fabTop: fabs.some(f => ov(f, top)), fabSheet: !!s && fabs.some(f => ov(f, s)), fabFab, feedSheet: !!s && feed.some(f => ov(f, s)),
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sheet: s, vh: innerHeight, vw: innerWidth, banner: banner.every(b => b.x >= -1 && b.r <= innerWidth + 1) };
});
const smallButtons = (H) => H.E(() => [...document.querySelectorAll('#sheet button, .cpop button, .wb-card')].filter(e => { const r = e.getBoundingClientRect(); return e.getClientRects().length && r.width > 0 && (r.height < 44 || r.width < 30) && !e.classList.contains('link'); }).map(e => (e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)));

// ===========================================================================================================================
// 1. 390x844: the whole flow with assertions
// ===========================================================================================================================
const only = args.only ? String(args.only).split(',') : null;
if (!only || only.includes('390')) {
  const H = await open(390, 844);
  const { b, E } = H;
  await b.wait(1600);

  section('boot: initial camera on the largest settlement, scroll hint on the dock row');
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

  const arena = await buildArena(H, { popA: 110 });
  check('built a two-kingdom arena (A | B + B2)', !!arena, arena ? JSON.stringify(arena) : 'none');
  if (!arena) { console.log('cannot continue'); process.exit(1); }
  const { A, B, rA, rMid, rCap } = arena;
  await b.wait(300);

  section('Kingdoms tab: the war tool («Война») is preselected, chips list both kingdoms, one-time hint teaches the flow');
  await H.tapSel('.tab[data-tab="kingdoms"]');
  const tab = await E(() => ({ tool: window.__god.UI.state.tool, chips: document.querySelectorAll('.kchip').length, on: document.querySelector('#tools .tool.on') && document.querySelector('#tools .tool.on').textContent.trim(), tools: document.querySelectorAll('#tools .tool').length, hint: document.getElementById('hint').textContent, toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join('|') }));
  check('the war tool is selected by default on the Kingdoms tab (label «Война»)', tab.tool === 'command' && tab.on === 'Война', JSON.stringify(tab));
  check('kingdoms tab shows 5 tools (war + 3 diplomacy powers + the player «Дипломатия» tool)', tab.tools === 5, tab.tools);
  check('both kingdoms are listed as chips', tab.chips === 2, tab.chips);
  check('the hint teaches the flow: «Выберите страну, затем регион, куда она нападёт»', /Выберите страну, затем регион, куда она нападёт/.test(tab.hint + '|' + tab.toast), tab.hint);
  check('no war icon on the chips in peace time', (await H.count('.kchip .wi:not(.hide)')) === 0);
  await H.shot('02_kingdoms_tab_war_tool');

  section('1. select the attacker (chip tap): slim HUD, outline, targets lit = War.targetsFor = War.potentialGoals');
  const kA = await E(A => { const k = window.__god.S.kingdoms.get(A); return { name: k.name }; }, A);
  const chipA = await E(A => { const g = window.__god; return [...document.querySelectorAll('.kchip')].findIndex(c => c.textContent.includes(g.S.kingdoms.get(A).name)); }, A);
  const cc = await E(i => { const r = document.querySelectorAll('.kchip')[i].getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, chipA);
  await b.tap(cc[0], cc[1]);
  await b.wait(1100);
  const c1 = await E(() => { const g = window.__god; const sh = document.getElementById('sheet').getBoundingClientRect(); const k = g.Kingdoms.commanded(); return { cmd: g.UI.cmd, cmdKid: g.UI.cmdKid, flag: k && k.cmd, rc: g.Render.cmd && { kid: g.Render.cmd.kid, sel: g.Render.cmd.sel, tgt: g.Render.cmd.tgt, cand: g.Render.cmd.candidates.slice(), ckids: g.Render.cmd.ckids.slice(), goals: g.Render.cmd.goals.length, target: g.Render.cmd.targetKid }, mode: g.Render.mode, hud: document.getElementById('sheet').classList.contains('hud'), dockHidden: getComputedStyle(document.getElementById('dock')).display === 'none', h: sh.height, vh: innerHeight, title: document.querySelector('#sheet .sh-title b') && document.querySelector('#sheet .sh-title b').textContent, sub: document.querySelector('#sheet .sh-title small') && document.querySelector('#sheet .sh-title small').textContent, hint: document.querySelector('.hud-hint') && document.querySelector('.hud-hint').textContent }; });
  check('UI.cmdKid is the tapped kingdom; Kingdoms.setCommanded(kid) took effect', c1.cmdKid === A && c1.flag === true && c1.cmd.kid === A, JSON.stringify({ cmdKid: c1.cmdKid, flag: c1.flag }));
  check('Render.cmd: attacker outlined (sel), targets in target style (tgt)', c1.rc && c1.rc.kid === A && c1.rc.sel === 1 && c1.rc.tgt === 1 && c1.rc.goals === 0 && c1.rc.target === 0, JSON.stringify(c1.rc));
  check('map switched to the political mode (borders)', c1.mode === 1);
  check('a slim HUD replaces the dock (no tall sheet): <= 20% of the screen', c1.hud && c1.dockHidden && c1.h <= c1.vh * 0.2, Math.round(c1.h) + 'px of ' + c1.vh);
  check('HUD: flag, name, ruler + key numbers, a hint what to do next', c1.title === kA.name && /жит\./.test(c1.sub) && /рег\./.test(c1.sub) && /подсвеченный регион/.test(c1.hint), c1.sub + ' | ' + c1.hint);
  const legal = await E(([A]) => { const g = window.__god; const t = g.War.targetsFor(A); return { ok: t.filter(e => e.ok).map(e => e.regionId).sort((x, y) => x - y), pot: [...new Set(g.S.kingdoms.size ? [...g.S.kingdoms.keys()].filter(k => k !== A).flatMap(k => g.War.potentialGoals(A, k)) : [])].sort((x, y) => x - y), kids: t.filter(e => e.ok).map(e => e.defenderKid) }; }, [A]);
  check('targets lit immediately: Render.cmd.candidates non-empty and equal to the legal set (War.targetsFor ok = War.potentialGoals)', c1.rc.cand.length > 0 && JSON.stringify(c1.rc.cand.slice().sort((x, y) => x - y)) === JSON.stringify(legal.ok) && JSON.stringify(legal.ok) === JSON.stringify(legal.pot), JSON.stringify({ cand: c1.rc.cand, legal: legal.ok, pot: legal.pot }));
  check('each lit region carries its defender for the marker flag (Render.cmd.ckids)', c1.rc.ckids.length === c1.rc.cand.length && c1.rc.ckids.every(k => k === B));
  check('the neighbouring region of B is a target; B\'s far capital region is not', c1.rc.cand.includes(rMid) && !c1.rc.cand.includes(rCap));
  check('paint button hidden in the war tool', await E(() => getComputedStyle(document.querySelector('.fab.paint')).display === 'none'));
  const rd = await E(() => window.__god.Render.debugInfo().political);
  check('the map draws the target markers (render debug alive)', rd && rd.hasRegions === true);
  await H.shot('03_attacker_selected_targets_lit');

  section('an illegal target is dimmed and explains why in one short line (truce)');
  await E(([A, B, k]) => { const g = window.__god; g.S.mod.war.truce[k] = g.S.tick + 900; }, [A, B, truceKey(A, B)]);
  await b.wait(1400);
  const tr = await E(() => { const g = window.__god; return { cand: g.Render.cmd.candidates.slice(), dim: g.Render.cmd.dim.slice(), hint: document.querySelector('.hud-hint').textContent, snap: g.UI.cmd.dim }; });
  check('during a truce the neighbour region is not lit but dimmed (Render.cmd.dim)', !tr.cand.includes(rMid) && tr.dim.includes(rMid) && tr.snap.includes(rMid), JSON.stringify(tr));
  check('the HUD says there is nobody to attack and why', /перемирие/.test(tr.hint), tr.hint);
  await H.tapRegion(rMid);
  const why = await E(() => { const p = document.querySelector('.cpop.why'); return p && { txt: p.textContent, btns: [...p.querySelectorAll('.cp-btn')].map(x => x.textContent.trim()), r: p.getBoundingClientRect().toJSON() }; });
  const card0 = (await H.cmd()).target;
  check('tapping the dimmed region explains: «Перемирие с «B» до N года» (no war card)', why && /Перемирие с «[^»]+» до \d+ года/.test(why.txt) && !card0, why && why.txt);
  check('the popup offers to switch the attacker or open the region card', why && why.btns.length === 2 && /Выбрать страну/.test(why.btns[0]) && /О регионе/.test(why.btns[1]), why && JSON.stringify(why.btns));
  check('popup stays inside the screen', why && why.r.left >= 0 && why.r.right <= 390 && why.r.top >= 0);
  await H.shot('04_dimmed_region_why');
  await E(([k]) => { delete window.__god.S.mod.war.truce[k]; }, [truceKey(A, B)]);
  const sea0 = await H.seaPoint();
  if (sea0) { await b.tap(sea0[0], sea0[1]); await b.wait(200); }
  check('a sea tap only closes the popup (the attacker stays selected)', (await E(() => window.__god.UI.cmdKid)) === A && !(await H.exists('.cpop')));
  await b.wait(1400);
  check('after the truce the region is lit again', (await E(() => window.__god.Render.cmd.candidates.slice())).includes(rMid));
  // a far region of B (not adjacent): explained, never switches the attacker silently
  await H.focusRegion(rCap, 8);
  await H.tapRegion(rCap);
  const far = await E(() => { const p = document.querySelector('.cpop.why'); return { txt: p && p.textContent, kid: window.__god.UI.cmdKid }; });
  check('a far region of the neighbour explains «не граничит…» and keeps the attacker', far.kid === A && /не граничит/i.test(far.txt || ''), far.txt);
  await E(() => { const g = window.__god; const p = document.querySelector('.cpop'); if (p) p.remove(); });

  section('2. tap a lit region: compact war card — defender implied, odds, cost vs allowance, casus, attack arrow');
  await H.focusRegion(rMid, 8);
  await H.tapRegion(rMid);
  const tc = await E(([A, B, rMid]) => { const g = window.__god; const c = g.UI.cmd; const sh = document.getElementById('sheet'); const r = sh.getBoundingClientRect(); const info = g.War.targetInfo(A, rMid);
    return { mode: c.mode, target: c.target, rc: { goals: g.Render.cmd.goals.slice(), target: g.Render.cmd.targetKid, arrows: g.Render.cmd.arrows.length }, names: [...sh.querySelectorAll('.tc-side b')].map(x => x.textContent), sub: sh.querySelector('.tc-sub').textContent, odds: sh.querySelector('.tc-odds b').textContent, cost: sh.querySelector('.tc-cost .txt').textContent, lines: [...sh.querySelectorAll('.tc-line')].map(x => x.textContent), go: sh.querySelector('[data-act="tgt-go"]').textContent.trim(), h: r.height, vh: innerHeight, feed: getComputedStyle(document.getElementById('feed')).visibility,
      exp: { cost: g.War.regionCost(rMid), allow: g.War.allowance(A, B), ratio: info.ratio, nameA: g.S.kingdoms.get(A).name, nameB: g.S.kingdoms.get(B).name, region: g.S.regions.get(rMid).name } }; }, [A, B, rMid]);
  check('the card opens for that region; the defender is its owner (B)', tc.mode === 'tc' && tc.target && tc.target.defKid === B && tc.target.goals.length === 1 && tc.target.goals[0] === rMid && !tc.target.atWar, JSON.stringify(tc.target));
  check('header «A ⚔ B» and «Цель — регион «R»»', tc.names[0] === tc.exp.nameA && tc.names[1] === tc.exp.nameB && tc.sub.includes(tc.exp.region), tc.names.join(' vs ') + ' | ' + tc.sub);
  const rt = tc.exp.ratio >= 1 ? tc.exp.ratio.toFixed(1) + ' : 1' : '1 : ' + (1 / tc.exp.ratio).toFixed(1);
  check('odds = War.targetInfo ratio, with honest words', tc.odds.startsWith(rt) && /перевес|равны|сильнее/.test(tc.odds), tc.odds + ' expected ' + rt);
  check('cost vs allowance = War.regionCost / War.allowance', tc.cost === tc.exp.cost + ' / ' + tc.exp.allow, tc.cost + ' expected ' + tc.exp.cost + ' / ' + tc.exp.allow);
  check('justification line (no claim => infamy +10)', tc.lines.some(l => /дурная слава \+10/.test(l) || /Законное притязание/.test(l)), tc.lines.join(' | '));
  check('ONE primary button «Объявить войну»', /Объявить войну/.test(tc.go));
  check('map: the goal is starred, the defender\'s border pulses, an attack arrow grows from our land', tc.rc.goals.length === 1 && tc.rc.goals[0] === rMid && tc.rc.target === B && tc.rc.arrows >= 1, JSON.stringify(tc.rc));
  check('the card is compact (the map stays visible) and the feed is hidden meanwhile', tc.h < tc.vh * 0.5 && tc.feed === 'hidden', Math.round(tc.h) + 'px');
  await H.shot('05_war_card');
  // cancel -> back to the attacker, no war
  await H.tapSel('[data-act="tgt-cancel"]'); await b.wait(250);
  const cx = await E(() => ({ c: window.__god.UI.cmd, wars: window.__god.War.active().length, rc: window.__god.Render.cmd.goals.length, arrows: window.__god.Render.cmd.arrows.length, cand: window.__god.Render.cmd.candidates.length }));
  check('«Отмена» closes the card: no war, attacker still selected, targets lit again', cx.c.target === null && cx.c.mode === 'hud' && cx.wars === 0 && cx.rc === 0 && cx.arrows === 0 && cx.cand > 0, JSON.stringify(cx));
  // tap the target again, then the same region once more = toggle off (card closes)
  await H.tapRegion(rMid);
  check('the card again', (await H.cmd()).mode === 'tc');
  await H.tapRegion(rMid);
  check('tapping the only goal again removes it and closes the card', (await H.cmd()).target === null);
  await H.tapRegion(rMid);

  section('3. «Объявить войну» -> exactly one war with exactly that goal; «ВОЙНА» banner; camera glide; war HUD');
  await E(() => { document.getElementById('feed').innerHTML = ''; });
  await H.tapSel('[data-act="tgt-go"]');
  await b.wait(300);
  const w1 = await E(() => { const g = window.__god; const ws = g.War.active(); const w = ws[0]; return { n: ws.length, id: w && w.id, att: w && w.attackers, def: w && w.defenders, agg: w && w.aggressor, goals: w && w.goals.map(x => [x.kid, x.regionId]), casus: w && w.casus, mode: g.UI.cmd.mode, armies: g.War.armiesOf(g.UI.cmdKid).length, banner: g.UI.banner, bannerTxt: document.querySelector('.wb-card') && document.querySelector('.wb-card').textContent, feed: [...document.querySelectorAll('#feed .fl')].map(x => x.textContent) }; });
  check('exactly one war, declared by the attacker on the region owner', w1.n === 1 && w1.agg === A && w1.att[0] === A && w1.def[0] === B, JSON.stringify(w1));
  check('with exactly that goal', w1.goals.length === 1 && w1.goals[0][0] === A && w1.goals[0][1] === rMid, JSON.stringify(w1.goals));
  check('casus: conquest (no claim) / claim', w1.casus === 'conquest' || w1.casus === 'claim', w1.casus);
  check('the «ВОЙНА» banner shows both kingdoms and the target region', w1.banner && w1.banner.warId === w1.id && /ВОЙНА/.test(w1.bannerTxt) && w1.bannerTxt.includes(kA.name) && w1.bannerTxt.includes(tc.exp.nameB) && w1.bannerTxt.includes(tc.exp.region), w1.bannerTxt);
  check('no duplicate feed line for the declaration', !w1.feed.some(t => /объявило войну/.test(t)), JSON.stringify(w1.feed));
  check('back to the HUD; armies were mustered', w1.mode === 'hud' && w1.armies >= 1, w1.mode + ' / ' + w1.armies);
  await H.shot('06_war_banner');
  await b.wait(3200);
  const w2 = await E(() => ({ banner: window.__god.UI.banner, nodes: document.querySelectorAll('.wb-card').length, chips: [...document.querySelectorAll('.hud-wars .hwc')].map(x => x.textContent.replace(/\s+/g, ' ').trim()), hint: document.querySelector('.hud-hint').textContent, wcnt: !document.getElementById('counters').querySelector('.cnt.war').classList.contains('hide') }));
  check('the banner dismisses itself', w2.banner === null && w2.nodes === 0);
  check('war HUD: a war chip with the score and the goals, an army chip', w2.chips.length >= 2 && /\d+ : \d+/.test(w2.chips[0]) && /★ 0\/1/.test(w2.chips[0]) && /арми/.test(w2.chips[1]), JSON.stringify(w2.chips));
  check('top bar shows the war counter', w2.wcnt);
  await H.shot('07_war_hud');

  section('armies take the goal region and HOLD it; the war does NOT end');
  await E(() => { window.__god.setSpeed(4); }); await b.wait(1800); await E(() => { window.__god.setSpeed(0); });
  let taken = false, tk = 0;
  for (let i = 0; i < 30 && !taken; i++) { tk = await H.step(100); taken = await E(([rid, A]) => window.__god.S.regions.get(rid).controllerId === A, [rMid, A]); }
  check('the goal region is taken (controller = attacker, owner unchanged)', taken && (await E(([rid, B]) => window.__god.S.regions.get(rid).ownerId === B, [rMid, B])), 'tick ' + tk);
  await H.step(60); await H.frames(3); await b.wait(400);
  const h1 = await E(([A]) => { const g = window.__god; const arms = g.War.armiesOf(A); return { arms: arms.map(a => [a.order.type, a.order.regionId, a.mode]), wars: g.War.active().length, goalDone: g.War.active()[0].goals[0].done }; }, [A]);
  check('the army order turned into «hold» on that region', h1.arms.length >= 1 && h1.arms.every(a => a[0] === 'hold' && a[1] === rMid), JSON.stringify(h1.arms));
  check('goal is marked done and the war is still active', h1.goalDone === true && h1.wars === 1);
  await H.step(600);
  const h2 = await E(([rCap]) => { const g = window.__god; const r2 = g.S.regions.get(rCap); return { wars: g.War.active().length, r2ctl: r2.controllerId, r2own: r2.ownerId }; }, [rCap]);
  check('600 ticks later: war still on, the army did not advance to the next enemy region', h2.wars === 1 && h2.r2ctl === h2.r2own, JSON.stringify(h2));
  await b.wait(1300);
  check('the next enemy region is lit as a war target', await E(([rCap]) => { const g = window.__god; return g.Render.cmd.candidates.includes(rCap) && g.UI.targets.some(e => e.regionId === rCap && e.atWar && e.ok); }, [rCap]));
  await H.shot('08_region_held');

  section('the drawer (pull up): Войны | Армии | Регионы — war card with score, goal, «+ Цель» / «Фронт» / «Мир»');
  await H.tapSel('[data-act="drawer"]'); await b.wait(400);
  const dr = await E(() => { const g = window.__god; const c = document.querySelector('.wcard'); return { mode: g.UI.cmd.mode, tabs: [...document.querySelectorAll('#sheet .cseg button')].map(x => x.textContent.trim()), on: document.querySelector('#sheet .cseg button.on') && document.querySelector('#sheet .cseg button.on').dataset.page, card: c && { bars: c.querySelectorAll('.bar').length, btns: [...c.querySelectorAll('.cbtn')].map(x => x.textContent.trim()), done: c.querySelector('.chip.good') && c.querySelector('.chip.good').textContent, info: c.textContent.replace(/\s+/g, ' ') }, h: document.getElementById('sheet').getBoundingClientRect().height, vh: innerHeight }; });
  check('drawer opens on «Войны» with 3 pages', dr.mode === 'dr' && dr.tabs.length === 3 && /Войны/.test(dr.tabs[0]) && /Армии/.test(dr.tabs[1]) && /Регионы/.test(dr.tabs[2]) && dr.on === 'war', JSON.stringify(dr.tabs));
  check('war card: 2 score bars, the goal «взят», what we hold, «+ Цель» / «Фронт» / «Мир»', dr.card && dr.card.bars === 2 && /взят/.test(dr.card.done || '') && /удерживаете: 1/.test(dr.card.info) && /Цель/.test(dr.card.btns[0]) && /Фронт/.test(dr.card.btns[1]) && /Мир/.test(dr.card.btns[2]), dr.card && dr.card.btns.join(','));
  check('the drawer is at most 60% of the screen', dr.h <= dr.vh * 0.6 + 1, Math.round(dr.h) + 'px');
  await H.shot('09_drawer_wars');
  await H.tapSel('[data-act="collapse"]'); await b.wait(250);
  check('«свернуть» returns to the HUD', (await H.cmd()).mode === 'hud');

  section('armies: select by list and by map banner, own region = hold / defend popup, enemy region = attack card');
  await H.tapSel('[data-act="hud-armies"]'); await b.wait(400);
  const card = await E(() => { const c = document.querySelector('.acard'); return c && { id: +c.dataset.army, txt: c.textContent.replace(/\s+/g, ' '), page: window.__god.UI.cmd.page }; });
  check('the HUD army chip opens the Армии page; army card: size, strength, supply, order', card && card.page === 'armies' && /солдат/.test(card.txt) && /Снабжение/.test(card.txt) && /Удерживает/.test(card.txt), card && card.txt);
  await H.tapSel('.acard .ac-head'); await b.wait(700);
  const sel = await E(() => ({ cmd: window.__god.UI.cmd, rc: window.__god.Render.cmd.armyId, cand: window.__god.Render.cmd.candidates.slice(), am: document.getElementById('sheet').classList.contains('am'), h: document.getElementById('sheet').getBoundingClientRect().height, actions: !!document.querySelector('.acard.sel [data-act="army-hold"]') }));
  check('tap on the card selects the army (UI + Render.cmd.armyId), compact army mode', sel.cmd.armyId === card.id && sel.rc === card.id && sel.am && sel.actions && sel.h < 844 * 0.46, Math.round(sel.h) + 'px');
  check('with an army selected the war targets of its war stay lit', sel.cand.includes(rCap), JSON.stringify(sel.cand));
  await H.shot('10_army_selected');
  await H.tapSel('[data-act="army-list"]'); await b.wait(250);
  check('«Список» deselects the army (back to the list)', (await H.cmd()).armyId === 0);
  await H.tapSel('[data-act="show-orders"]'); await b.wait(150);
  check('«Приказы всех армий на карте» toggles Render.showAllOrders', await E(() => window.__god.Render.showAllOrders === true));
  await H.tapSel('[data-act="show-orders"]');
  check('...and back', await E(() => window.__god.Render.showAllOrders === false));
  await H.tapSel('[data-act="collapse"]'); await b.wait(250);
  let banner = await E(id => { const r = window.__god.Render.armyBannerRect(id); return r && [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]; }, card.id);
  if (!banner) { await E(id => { const g = window.__god; const a = g.War.armiesOf(g.UI.cmdKid).find(x => x.id === id); g.UI.focusVisible(a.x, a.y, 8, true); }, card.id); await H.frames(4); banner = await E(id => { const r = window.__god.Render.armyBannerRect(id); return r && [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]; }, card.id); }
  check('the army banner is on the map', !!banner);
  if (banner) { await b.tap(banner[0], banner[1]); await b.wait(300); }
  check('tapping the banner selects the army (Render army hit-test)', (await H.cmd()).armyId === card.id);
  await H.focusRegion(rA, 8);
  await H.tapRegion(rA);
  const pop = await E(() => { const p = document.querySelector('.cpop'); return p && { btns: [...p.querySelectorAll('.cp-btn')].map(x => x.textContent.trim()), r: p.getBoundingClientRect().toJSON() }; });
  check('own region with an army selected: popup Удерживать / Оборонять', pop && pop.btns.length === 2 && /Удерживать/.test(pop.btns[0]) && /Оборонять/.test(pop.btns[1]), pop && JSON.stringify(pop.btns));
  check('popup stays inside the screen', pop && pop.r.left >= 0 && pop.r.right <= 390 && pop.r.top >= 0);
  await H.shot('11_order_popup');
  await H.tapSel('.cpop [data-act="pop-defend"]'); await b.wait(300);
  const o1 = await E(id => { const a = window.__god.S.armies.get(id); return a && { t: a.order.type, r: a.order.regionId, auto: a.auto }; }, card.id);
  check('«Оборонять» issued War.order defend on that region (player order)', o1 && o1.t === 'defend' && o1.r === rA && !o1.auto, JSON.stringify(o1));
  // the selected army attacks the next enemy region through the attack card
  await H.focusRegion(rCap, 8);
  await H.tapRegion(rCap);
  const ac = await E(() => { const g = window.__god; const sh = document.getElementById('sheet'); return { c: g.UI.cmd, go: sh.querySelector('[data-act="tgt-go"]') && sh.querySelector('[data-act="tgt-go"]').textContent.trim(), goal: !!sh.querySelector('[data-act="tgt-goal"]'), lines: [...sh.querySelectorAll('.tc-line')].map(x => x.textContent), odds: sh.querySelector('.tc-odds b') && sh.querySelector('.tc-odds b').textContent, arrows: g.Render.cmd.arrows.length }; });
  check('a tap on an enemy region we are at war with opens the ATTACK card (atWar, the war id, «Атаковать»)', ac.c.mode === 'tc' && ac.c.target.atWar && ac.c.target.warId === w1.id && ac.c.target.armyId === card.id && /Атаковать/.test(ac.go) && ac.goal, JSON.stringify(ac.c.target));
  check('attack card: local odds, the army that goes, the peace price of the region, an arrow from the army', /:/.test(ac.odds) && ac.lines.some(l => /Пойдёт армия/.test(l)) && ac.lines.some(l => /На переговорах регион стоит/.test(l)) && ac.arrows >= 1, ac.lines.join(' | '));
  await H.shot('12_attack_card');
  await H.tapSel('[data-act="tgt-go"]'); await b.wait(300);
  const o2 = await E(([id, rCap, wid]) => { const g = window.__god; const a = g.S.armies.get(id); const w = g.War.get(wid); return { a: a && { t: a.order.type, r: a.order.regionId, auto: a.auto }, goal: w.goals.some(x => x.regionId === rCap), toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent), sel: g.UI.cmd.armyId, mode: g.UI.cmd.mode }; }, [card.id, rCap, w1.id]);
  check('«Атаковать» = attack order for the selected army + the region became a war goal', o2.a && o2.a.t === 'attack' && o2.a.r === rCap && !o2.a.auto && o2.goal, JSON.stringify(o2));
  check('toast confirms; the army stays selected (army mode)', o2.toasts.some(t => /Атака на/.test(t)) && o2.sel === card.id && o2.mode === 'am', o2.toasts.join(' | '));
  let t2 = false;
  for (let i = 0; i < 40 && !t2; i++) { await H.step(100); t2 = await E(([rid, A]) => window.__god.S.regions.get(rid).controllerId === A, [rCap, A]); }
  check('the second region is taken after the attack order', t2);
  await H.step(80);
  const o3 = await E(id => { const a = window.__god.S.armies.get(id); return a && { t: a.order.type, r: a.order.regionId }; }, card.id);
  check('the army holds the second region (order turned into hold again)', o3 && o3.t === 'hold' && o3.r === rCap, JSON.stringify(o3));

  section('sea tap = one step back (army -> drawer -> ...), bulk orders');
  const sea = await H.seaPoint();
  if (sea) {
    const anyArmy = await E(A => { const g = window.__god; if (!g.UI.cmdKid) g.UI.commandKingdom(A, { focus: false }); const a = g.War.armiesOf(A)[0]; return a ? a.id : 0; }, A);
    if (!(await H.cmd()).armyId && anyArmy) { await E(id => window.__god.UI.selectArmy(id, { focus: false }), anyArmy); await b.wait(300); }
    await b.tap(sea[0], sea[1]); await b.wait(250);
    const s1 = await H.cmd();
    check('with an army selected a sea tap deselects only the army', s1.armyId === 0 && s1.kid === A && s1.mode === 'hud', JSON.stringify({ a: s1.armyId, m: s1.mode }));
  } else check('open sea visible for the step-back test', false);
  await H.tapSel('[data-act="hud-armies"]'); await b.wait(300);
  await H.tapSel('[data-act="hold-all"]'); await b.wait(250);
  check('«Все: удерживать» gives hold orders to the armies standing on their land', (await E(A => window.__god.War.armiesOf(A).every(a => a.order.type === 'hold'), A)));
  await H.shot('13_armies_hold_all');

  section('«+ Цель» back on the map: the enemy regions of that war stay lit, a tap = card with «Цель» / «Атаковать»');
  await H.tapSel('.cseg button[data-page="war"]'); await b.wait(300);
  const more = await E(([A]) => window.__god.War.targetsFor(A).filter(e => e.ok && e.atWar && !e.goal).length, [A]);
  await H.tapSel('[data-act="addgoal"]'); await b.wait(500);
  const ag = await E(() => ({ c: window.__god.UI.cmd, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent) }));
  check('«+ Цель» collapses to the HUD and tells what to do (or that nothing is left)', ag.c.mode === 'hud' && ag.toasts.some(t => (more ? /станет новой целью/ : /Новых целей рядом нет/).test(t)), ag.toasts.join(' | '));

  section('peace conference: occupied regions, budget bar, refusal reason, offer, god force');
  await H.tapSel('[data-act="drawer"]'); await b.wait(300);
  await H.tapSel('.cseg button[data-page="war"]'); await b.wait(200);
  await H.tapSel('[data-act="peace"]'); await b.wait(1100);
  const pc = await E(() => ({ cmd: window.__god.UI.cmd.peace, chips: [...document.querySelectorAll('.pchip')].map(c => c.textContent.replace(/\s+/g, ' ').trim()), bar: document.querySelector('.gb-bar .txt') && document.querySelector('.gb-bar .txt').textContent, btns: [...document.querySelectorAll('.pc-foot .cbtn, .pc-force .cbtn')].map(x => x.textContent.trim()), scores: document.querySelectorAll('.pc-scores .bar').length }));
  check('peace sheet: both occupied regions are listed as toggle chips with costs', pc.cmd && pc.cmd.held.length === 2 && pc.chips.filter(c => /цена/.test(c)).length >= 2, pc.chips.join(' | '));
  check('peace sheet: budget bar vs war score, white peace / offer / god-force buttons', /\/ \d+ очков/.test(pc.bar) && pc.btns.length === 3 && pc.scores === 2, JSON.stringify(pc.btns) + ' ' + pc.bar);
  await H.shot('14_peace_sheet');
  const rids = pc.cmd.held;
  const pick = async (rid) => { await H.tapSel('.pchip[data-rid="' + rid + '"]'); };
  for (const rid of rids) { const on = await E(rid => window.__god.UI.cmd.peace.picks.includes(rid), rid); if (!on) await pick(rid); }
  const both = await E(() => ({ picks: window.__god.UI.cmd.peace.picks.length, offerDis: document.querySelector('[data-act="offer"]').disabled, rc: window.__god.Render.cmd.goals.length }));
  check('chips toggle the demanded regions (and the Render goals)', both.picks === 2 && both.rc === 2, JSON.stringify(both));
  const ov = await E(() => { const t = document.querySelector('.gb-bar .txt').textContent.match(/(\d+) \/ (\d+)/); return +t[1] > +t[2]; });
  if (ov) { check('over budget: «Предложить» is disabled', both.offerDis === true); await pick(rids[0]); await pick(rids[1]); await pick(rids[0]); }
  else check('budget allows both regions', true);
  await E(() => { const W = window.__god.War; window.__peaceOrig = W.peaceOffer; W.peaceOffer = () => ({ ok: true, accepted: false, pending: false, reason: 'противник отказался: требования слишком велики', cost: 99, allowance: 10 }); });
  await H.tapSel('[data-act="offer"]'); await b.wait(300);
  const rf = await E(() => ({ res: document.querySelector('.pc-res') ? document.querySelector('.pc-res').textContent : '', hidden: document.querySelector('.pc-res').classList.contains('hide'), peace: !!window.__god.UI.cmd.peace }));
  check('a refusal shows the reason text and keeps the conference open', !rf.hidden && /отказался: требования слишком велики/.test(rf.res) && rf.peace, JSON.stringify(rf));
  await H.shot('15_peace_refused');
  await E(() => { window.__god.War.peaceOffer = window.__peaceOrig; });
  const picks0 = await E(() => window.__god.UI.cmd.peace.picks.slice());
  if (picks0.includes(rCap)) await pick(rCap);
  if (!(await E(rid => window.__god.UI.cmd.peace.picks.includes(rid), rMid))) await pick(rMid);
  const keep = await E(() => window.__god.UI.cmd.peace.picks.slice());
  check('one region left in the demand (the first goal)', keep.length === 1 && keep[0] === rMid, JSON.stringify(keep));
  await H.tapSel('[data-act="offer"]'); await b.wait(600);
  const end = await E(([A, B, rMid, rCap]) => { const g = window.__god; return { wars: g.War.active().length, own1: g.S.regions.get(rMid).ownerId, own2: g.S.regions.get(rCap).ownerId, ctl2: g.S.regions.get(rCap).controllerId, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent), peace: g.UI.cmd.peace, mode: g.UI.cmd.mode, truce: g.War.truceUntil(A, B) > g.S.tick }; }, [A, B, rMid, rCap]);
  check('the offer was accepted and the war is over (back to the HUD)', end.wars === 0 && end.peace === null && end.mode === 'hud', JSON.stringify(end));
  check('the demanded region changed its OWNER through the peace deal; the other one returned to B', end.own1 === A && end.own2 === B && end.ctl2 === B);
  check('a truce follows the peace; toast reports the peace', end.truce && end.toasts.some(t => /Мир заключён/.test(t)), end.toasts.join(' | '));
  await b.wait(1300);
  check('after the peace B is dimmed (truce), nothing is lit', await E(([B]) => { const g = window.__god; return g.Render.cmd.candidates.length === 0 && g.UI.targets.some(e => e.defenderKid === B && !e.ok && /перемирие/.test(e.reason)); }, [B]));
  // god force: a new war (casus god ignores the truce), conference, «Принудить (бог)»
  await E(([A, B, rCap]) => { window.__god.War.declare(A, B, [rCap], 'god'); }, [A, B, rCap]);
  await b.wait(1600);
  check('a war declared from code also shows the banner (and then the HUD war chip)', (await H.count('.hud-wars .hwc[data-war]')) === 1);
  await H.tapSel('[data-act="drawer"]'); await b.wait(300);
  await H.tapSel('.cseg button[data-page="war"]'); await b.wait(200);
  await H.tapSel('[data-act="peace"]'); await b.wait(900);
  await H.tapSel('[data-act="force"]'); await b.wait(600);
  const fo = await E(() => ({ wars: window.__god.War.active().length, peace: window.__god.UI.cmd.peace, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent) }));
  check('«Принудить (бог)» ends the war at once (War.forcePeace)', fo.wars === 0 && fo.peace === null && fo.toasts.some(t => /Бог навязал/.test(t)), JSON.stringify(fo));

  section('Регионы page, region inspector, kingdom inspector with the «Дипломатия» section');
  await H.tapSel('[data-act="drawer"]'); await b.wait(300);
  await H.tapSel('.cseg button[data-page="info"]'); await b.wait(300);
  check('regions page lists own regions with the capital marked', await E(() => document.querySelectorAll('.rrow').length >= 2 && /Столица/.test(document.querySelector('.rlist').textContent)));
  await H.shot('16_regions_page');
  await H.tapSel('.rrow .rr-i'); await b.wait(500);
  const ri = await E(() => ({ insp: window.__god.UI.inspector, rows: [...document.querySelectorAll('.sh-body .kv')].map(k => k.textContent.replace(/\s+/g, ' ').trim()), hl: window.__god.Render.cmd && window.__god.Render.cmd.regionId, secs: [...document.querySelectorAll('.sh-body .sec-h')].map(x => x.textContent) }));
  check('region inspector opens (info button on the regions page)', ri.insp && ri.insp.type === 'region', JSON.stringify(ri.insp));
  check('region card: owner, controller, value, terrain, cities, claims, neighbours', ri.rows.some(r => /Владелец/.test(r)) && ri.rows.some(r => /Контроль/.test(r)) && ri.rows.some(r => /Ценность/.test(r)) && ri.secs.includes('Города') && ri.secs.includes('Притязания') && ri.secs.includes('Соседи') && ri.secs.includes('Рельеф'), ri.secs.join(','));
  check('the region is highlighted on the map (pulsing outline)', ri.hl === ri.insp.id);
  await H.tapSel('.sh-btn:last-child'); await b.wait(400);
  check('closing the inspector returns to the war drawer', await E(() => !!document.querySelector('#sheet .cseg') && window.__god.UI.inspector === null));
  await E(() => { document.querySelector('.sh-body').scrollTop = 0; });
  await H.tapSel('[data-act="kingdom-card"]'); await b.wait(500);
  const ki = await E(() => ({ insp: window.__god.UI.inspector, secs: [...document.querySelectorAll('.sh-body .sec-h')].map(x => x.textContent), kv: [...document.querySelectorAll('.sh-body .kv')].map(k => k.textContent.replace(/\s+/g, ' ').trim()), bars: [...document.querySelectorAll('.sh-body .bar > label')].map(x => x.textContent), sub: [...document.querySelectorAll('.sh-body .relsub')].map(x => x.textContent) }));
  check('kingdom card: stability + infamy bars, regions, overlord / vassals, wars', ki.bars.includes('Стабильность') && ki.bars.includes('Дурная слава') && ki.kv.some(k => /^Регионов/.test(k)) && ki.kv.some(k => /^Сюзерен/.test(k)) && ki.kv.some(k => /^Вассалы/.test(k)) && ki.secs.includes('Войны'), ki.bars.join(','));
  check('«Дипломатия» (information only): neighbours with border, truce and strength ratio', ki.secs.includes('Дипломатия') && ki.sub.some(s => /общая граница/.test(s) && /перемирие/.test(s) && /сила ×/.test(s)), JSON.stringify(ki.sub));
  await H.tapSel('.relwrap .bar.mid'); await b.wait(250);
  check('tapping the opinion bar shows its causes (Diplomacy.causes)', await E(() => { const c = document.querySelector('.relwrap .causes'); return !!c && !c.classList.contains('hide') && c.textContent.length > 5; }));
  await H.shot('17_kingdom_diplomacy');
  await H.tapSel('.sh-btn:last-child'); await b.wait(300);

  section('release (✕): AI resumes, nothing stuck (body classes, Render.cmd / highlight, popups, feed, paint button, map mode)');
  await H.tapSel('[data-act="collapse"]'); await b.wait(200);
  await H.tapSel('[data-act="release"]'); await b.wait(400);
  const rl = await H.state();
  check('✕ releases the country and leaves no stuck UI state', isClean(rl) && rl.mode === 0, JSON.stringify(rl));

  section('map taps: land / city / unit select; a neighbour explains + switches by the popup button; wild land; sea deselects');
  await H.tapSel('.tab[data-tab="kingdoms"]'); await b.wait(200);
  check('the war tool is still the Kingdoms tab tool', (await E(() => window.__god.UI.state.tool)) === 'command');
  const kid0 = () => E(() => window.__god.UI.cmdKid);
  await H.focusRegion(rA, 8);
  await H.tapRegion(rA);
  check('tap on the land of a kingdom selects it', (await kid0()) === A);
  await H.tapSel('[data-act="release"]'); await b.wait(300);
  const capB = await E(B => { const g = window.__god; const k = g.S.kingdoms.get(B); const c = g.S.cities.get(k.capitalId) || g.S.cities.get(k.cities[0]); return c && { x: c.x + 0.5, y: c.y + 0.5 }; }, B);
  await E(c => window.__god.UI.focusVisible(c.x, c.y, 11, true), capB); await H.frames(4);
  const cp = await E(c => { const p = window.__god.Render.tileToScreen(c.x, c.y); return [p.x, p.y]; }, capB);
  await b.tap(cp[0], cp[1]); await b.wait(400);
  check('tap on a city selects its kingdom', (await kid0()) === B);
  await H.tapSel('[data-act="release"]'); await b.wait(300);
  const un = await E(A => { const g = window.__god; for (const u of g.S.units.values()) if (u.kingdomId === A && !u.armyId && u.cityId && !u.isRuler) return { id: u.id }; return null; }, A);
  await E(id => { const g = window.__god; const u = g.S.units.get(id); g.UI.focusVisible(u.x, u.y, 14, true); }, un.id); await H.frames(4);
  const up = await E(id => { const g = window.__god; const u = g.S.units.get(id); const p = g.Render.tileToScreen(u.x, u.y - 0.3); return [p.x, p.y]; }, un.id);
  await b.tap(up[0], up[1]); await b.wait(400);
  check('tap on a unit selects its kingdom', (await kid0()) === A);
  await E(() => window.__god.UI.closeInspector());
  await H.focusRegion(rCap, 8);
  await H.tapRegion(rCap);
  const nb = await E(() => { const p = document.querySelector('.cpop'); return p && [...p.querySelectorAll('.cp-btn')].map(x => x.textContent.trim()); });
  check('B\'s land while A is selected (truce): explanation popup with «Выбрать страну» / «О регионе»', nb && nb.length === 2 && /Выбрать страну/.test(nb[0]), JSON.stringify(nb));
  await H.shot('18_neighbour_popup');
  await H.tapSel('.cpop [data-act="pop-select"]'); await b.wait(900);
  const sw = await E(([A, B]) => ({ cmd: window.__god.UI.cmdKid, a: window.__god.S.kingdoms.get(A).cmd, b: window.__god.S.kingdoms.get(B).cmd, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent) }), [A, B]);
  check('«Выбрать страну» switches the attacker (only one kingdom commanded at a time)', sw.cmd === B && sw.b === true && sw.a === false, JSON.stringify(sw));
  const wild = await E(() => { const g = window.__god; const r = [...g.S.regions.values()].find(r => !r.ownerId); return r && r.id; });
  if (wild) {
    await H.focusRegion(wild, 8);
    await H.tapRegion(wild);
    check('wild land: a hint, the selection stays', (await kid0()) === B && (await E(() => [...document.querySelectorAll('.toast')].some(t => /Ничья земля/.test(t.textContent)))));
  } else check('wild region exists', false);
  const sea2 = await H.seaPoint();
  if (sea2) {
    await b.tap(sea2[0], sea2[1]); await b.wait(350);
    const st = await H.state();
    check('sea tap with only a country selected deselects it — nothing stuck', isClean(st), JSON.stringify(st));
    await b.tap(sea2[0], sea2[1]); await b.wait(250);
    check('another sea tap with nothing selected does nothing', (await kid0()) === 0);
  } else check('open sea visible', false);
  await E(() => window.__god.UI.setMode('paint')); await b.wait(100);
  const e0 = await E(() => { const g = window.__god; let s = 0; for (let i = 0; i < g.S.tile.length; i += 7) s += g.S.tile[i] + g.S.elev[i]; return s; });
  await H.focusRegion(rA, 8);
  const pp = await H.regionPoint(rA);
  await b.drag(pp[0] - 40, pp[1], pp[0] + 40, pp[1] + 10, 8, 30); await b.wait(200);
  const e1 = await E(() => { const g = window.__god; let s = 0; for (let i = 0; i < g.S.tile.length; i += 7) s += g.S.tile[i] + g.S.elev[i]; return s; });
  check('a drag with the war tool never paints terrain (paint mode or not)', e0 === e1);
  await E(() => window.__god.UI.setMode('pan'));
  await E(() => window.__god.UI.releaseCommand(true));

  section('AI-declared war: the same banner, no duplicate feed line; the «Войны» / «Все» filter keeps working');
  await E(() => { document.getElementById('feed').innerHTML = ''; });
  const aiw = await E(([A, B, k]) => { const g = window.__god; delete g.S.mod.war.truce[k]; try { const r = g.Diplomacy.get(A, B); if (r) r.truceUntil = 0; } catch (e) {} const w = g.Diplomacy.declareWar(B, A, 'conquest'); return w ? w.id : 0; }, [A, B, truceKey(A, B)]);
  await b.wait(400);
  const ab = await E(() => ({ banner: window.__god.UI.banner, txt: document.querySelector('.wb-card') && document.querySelector('.wb-card').textContent, feed: [...document.querySelectorAll('#feed .fl')].map(x => x.textContent), log: window.__god.S.log.slice(-6).map(e => e.msg) }));
  check('an AI declaration (Diplomacy.declareWar) shows the «ВОЙНА» banner with both names', aiw > 0 && ab.banner && ab.banner.warId === aiw && /ВОЙНА/.test(ab.txt), ab.txt);
  check('...the feed does not repeat it, the journal keeps the line', !ab.feed.some(t => /объявило войну/.test(t)) && ab.log.some(m => /объявило войну/.test(m)), JSON.stringify(ab.feed));
  await H.shot('19_ai_war_banner');
  await b.wait(3000);
  check('the AI banner dismisses itself', (await E(() => window.__god.UI.banner)) === null);
  const ff = await E(() => { const f = document.querySelector('.fab.feedfab'); return { label: f.textContent.trim(), on: f.classList.contains('on') }; });
  check('the notification filter button is untouched («Войны» on)', ff.label === 'Войны' && ff.on, JSON.stringify(ff));
  await E(([A]) => { const g = window.__god; for (const w of g.War.active()) g.War.forcePeace(w.id, {}); }, [A]);

  section('Info tool: region inspector on a tap; menu toggle «Авто‑мир»; log focus on a region');
  await H.tapSel('.tab[data-tab="info"]'); await b.wait(200);
  await H.focusRegion(rA, 8);
  await H.tapRegion(rA);
  await b.wait(400);
  const it = await E(() => window.__god.UI.inspector);
  check('Info tool tap opens an inspector', it && ['region', 'city', 'unit', 'building'].includes(it.type), JSON.stringify(it));
  await H.tapSel('.sh-btn:last-child'); await b.wait(200);
  await H.tapSel('#btnMenu'); await b.wait(300);
  const ap0 = await E(() => ({ on: document.querySelector('[data-act="autopeace"]').classList.contains('on'), war: window.__god.War.autoPeace(), items: document.querySelectorAll('.mbtn').length }));
  check('menu has the «Авто‑мир при истощении» toggle matching War.autoPeace()', ap0.on === ap0.war && ap0.items === 6, JSON.stringify(ap0));
  await H.tapSel('[data-act="autopeace"]'); await b.wait(150);
  const ap1 = await E(() => ({ on: document.querySelector('[data-act="autopeace"]').classList.contains('on'), war: window.__god.War.autoPeace() }));
  check('toggle calls War.setAutoPeace', ap1.on === !ap0.on && ap1.war === !ap0.war, JSON.stringify(ap1));
  await H.tapSel('[data-act="autopeace"]'); await b.wait(100);
  await E(() => window.__god.UI.closeAllModals());
  await E(() => { const g = window.__god; g.Render.setCamera(3, 3, 4); g.UI.openLog(); });
  await b.wait(300);
  const li = await E(() => { const items = [...document.querySelectorAll('.log-item')]; const i = items.findIndex(e => e.querySelector('canvas.go') && /войн|оккупир|мир/i.test(e.textContent)); return { i, n: items.length }; });
  check('the log lists war lines with a map focus icon', li.i >= 0, JSON.stringify(li));
  if (li.i >= 0) {
    await E(i => document.querySelectorAll('.log-item')[i].click(), li.i); await b.wait(900);
    const lf = await E(() => ({ z: window.__god.Render.cam.zoom, hl: window.__god.Render.cmd && window.__god.Render.cmd.regionId, modal: !!document.querySelector('.m-card') }));
    check('log entry focuses the camera and pulses its region', lf.z >= 10 && lf.hl > 0 && !lf.modal, JSON.stringify(lf));
  }
  check('no page errors in the whole flow', b.errors.length === 0, b.errors.slice(0, 3).join(' || '));
  await b.close();
}

// ===========================================================================================================================
// 2. other viewports: every state, no overflow, no overlap
// ===========================================================================================================================
async function states(w, h, name) {
  section(`viewport ${w}x${h} (${name}): HUD, card, banner, war HUD, drawer, army, popup, peace, inspectors`);
  const H = await open(w, h);
  const { b, E } = H;
  await b.wait(1500);
  const arena = await buildArena(H);
  check(`${name}: arena built`, !!arena);
  if (!arena) { await b.close(); return; }
  const { A, B, rMid, rA } = arena;
  const land = w > h;
  const ok = async (label) => {
    const r = await layoutCheck(H);
    const bad = await overflowCheck(H);
    const s = r.sheet;
    check(`${name} ${label}: inside the screen, no horizontal overflow`, r.sw <= r.cw && bad.length === 0 && (!s || (s.x >= -1 && s.r <= r.vw + 1 && s.b <= r.vh + 1)) && r.banner, bad.join('; ') || (s ? `${Math.round(s.y)}-${Math.round(s.b)} of ${r.vh}` : 'no sheet'));
    check(`${name} ${label}: floating buttons clear of the top bar, the panel and each other; feed clear of the panel`, !r.fabTop && !r.fabSheet && !r.fabFab && !r.feedSheet, JSON.stringify({ t: r.fabTop, s: r.fabSheet, f: r.fabFab, feed: r.feedSheet }));
    const sm = await smallButtons(H);
    check(`${name} ${label}: touch targets >= 44 px`, sm.length === 0, sm.slice(0, 4).join('; '));
    return r;
  };
  await H.tapSel('.tab[data-tab="kingdoms"]'); await H.shot(`${name}_01_kingdoms_tab`);
  await E(A => window.__god.UI.commandKingdom(A, {}), A); await b.wait(1100);
  const r1 = await ok('HUD');
  if (!land) check(`${name}: HUD <= 22% of the screen`, r1.sheet && r1.sheet.h <= r1.vh * 0.22, r1.sheet && Math.round(r1.sheet.h) + 'px');
  await H.shot(`${name}_02_attacker_hud`);
  await H.focusRegion(rMid, 7.5);
  await H.tapRegion(rMid);
  check(`${name}: tap on the lit region opens the war card`, (await H.cmd()).mode === 'tc');
  const r2 = await ok('war card');
  if (!land) check(`${name}: war card <= 60% of the screen`, r2.sheet && r2.sheet.h <= r2.vh * 0.6 + 1, r2.sheet && Math.round(r2.sheet.h) + 'px');
  await H.shot(`${name}_03_war_card`);
  await H.tapSel('[data-act="tgt-go"]'); await b.wait(350);
  check(`${name}: war declared`, (await E(() => window.__god.War.active().length)) === 1);
  await ok('banner'); await H.shot(`${name}_04_banner`);
  await b.wait(3000);
  await H.step(250); await H.frames(3); await b.wait(300);
  await ok('war HUD'); await H.shot(`${name}_05_war_hud`);
  await H.tapSel('[data-act="drawer"]'); await b.wait(400);
  await ok('drawer'); await H.shot(`${name}_06_drawer`);
  await H.tapSel('.cseg button[data-page="armies"]'); await b.wait(300);
  await H.tapSel('.acard .ac-head'); await b.wait(800);
  await ok('army selected'); await H.shot(`${name}_07_army_selected`);
  let taken = false;
  for (let i = 0; i < 30 && !taken; i++) { await H.step(100); taken = await E(([rid, A]) => window.__god.S.regions.get(rid).controllerId === A, [rMid, A]); }
  await H.step(80);
  await H.focusRegion(rA, 7.5);
  await H.tapRegion(rA);
  await H.shot(`${name}_08_popup`);
  await ok('popup');
  await H.tapSel('.cpop .cp-btn:nth-child(1)'); await b.wait(200);
  await E(() => window.__god.UI.openDrawer('war')); await b.wait(300);
  await H.tapSel('[data-act="peace"]'); await b.wait(1100);
  await ok('peace'); await H.shot(`${name}_09_peace`);
  await H.tapSel('.sh-btn.back'); await b.wait(300);
  await H.tapSel('[data-act="release"]'); await b.wait(400);
  const st = await H.state();
  check(`${name}: release leaves nothing behind`, isClean(st), JSON.stringify(st));
  await E(() => window.__god.UI.openInspector('region', [...window.__god.S.regions.values()][3].id)); await b.wait(500);
  await H.shot(`${name}_10_region_inspector`);
  await E(A => window.__god.UI.openInspector('kingdom', A), A); await b.wait(500);
  await H.shot(`${name}_11_kingdom_inspector`);
  await E(() => { window.__god.UI.closeInspector(); window.__god.UI.openMenu(); }); await b.wait(300);
  const mc = await E(() => { const c = document.querySelector('.m-card').getBoundingClientRect(); return [c.top, c.bottom, innerHeight]; });
  check(`${name}: menu card fits`, mc[0] >= 0 && mc[1] <= mc[2] + 1, mc.map(Math.round).join(','));
  check(`${name}: no page errors`, b.errors.length === 0, b.errors.slice(0, 3).join(' || '));
  await b.close();
}
if (!only || only.includes('small')) await states(360, 640, 'small');
if (!args.quick) {
  if (!only || only.includes('tiny')) await states(320, 568, 'tiny');
  if (!only || only.includes('land')) await states(844, 390, 'land');
  if (!only || only.includes('lands')) await states(667, 375, 'lands');
  if (!only || only.includes('big')) await states(430, 932, 'big');
}

// ===========================================================================================================================
// 2b. robustness: world replacement / kingdom death / save-load while selected; cancel / switch / deselect leave nothing stuck; random taps
// ===========================================================================================================================
if (!only || only.includes('fuzz')) {
  section('robustness: world replaced, kingdom destroyed, save/load while selected; random taps');
  const H = await open(390, 844);
  const { b, E } = H;
  await b.wait(1500);
  const arena = await buildArena(H);
  if (arena) {
    const { A, B } = arena;
    await E(A => window.__god.UI.commandKingdom(A, {}), A); await b.wait(500);
    await E(() => { window.__god.Save.save('2'); });
    check('Kingdom.cmd is true while the country is selected', await E(A => window.__god.S.kingdoms.get(A).cmd === true, A));
    await E(() => { const g = window.__god; g.Save.load('2'); g.Main.worldReplaced('load'); });
    await b.wait(300);
    const afterLoad = await H.state();
    check('after a load: released everywhere, nothing stuck', isClean(afterLoad), JSON.stringify(afterLoad));
    // card open, then the world is replaced
    const a1 = await buildArena(H);
    await E(A => window.__god.UI.commandKingdom(A, {}), a1.A); await b.wait(400);
    await E(rid => window.__god.UI.pickTarget(rid), a1.rMid); await b.wait(300);
    check('a card is open', (await H.cmd()).mode === 'tc');
    await E(() => { window.__god.Main.newWorld({ seed: 5, w: 64, h: 64, populate: true }); });
    await b.wait(300);
    const nw = await H.state();
    check('a new world with an open war card: everything closed', isClean(nw), JSON.stringify(nw));
    // switch attacker with an open card, then cancel / deselect paths
    const a2 = await buildArena(H);
    await E(A => window.__god.UI.commandKingdom(A, {}), a2.A); await b.wait(300);
    await E(rid => window.__god.UI.pickTarget(rid), a2.rMid); await b.wait(200);
    await E(B => window.__god.UI.commandKingdom(B, { focus: false }), a2.B); await b.wait(300);
    const s2 = await E(([A, B]) => ({ kid: window.__god.UI.cmdKid, c: window.__god.UI.cmd, a: window.__god.S.kingdoms.get(A).cmd, rc: window.__god.Render.cmd && window.__god.Render.cmd.kid, arrows: window.__god.Render.cmd.arrows.length, pick: document.body.classList.contains('cmd-pick') }), [a2.A, a2.B]);
    check('switching the attacker with an open card: card closed, new attacker, old one released', s2.kid === a2.B && s2.c.target === null && s2.c.mode === 'hud' && !s2.a && s2.rc === a2.B && s2.arrows === 0 && !s2.pick, JSON.stringify(s2));
    await E(() => window.__god.UI.releaseCommand(true)); await b.wait(200);
    check('release after a switch: nothing stuck', isClean(await H.state()));
    // the commanded kingdom dies
    await E(A => window.__god.UI.commandKingdom(A, {}), a2.A); await b.wait(300);
    await E(A => { window.__god.Kingdoms.destroy(A, 'test'); }, a2.A);
    await b.wait(600);
    const kd = await H.state();
    check('a destroyed selected kingdom: released, nothing stuck', isClean(kd), JSON.stringify(kd));
    // random fuzz in a fresh war
    const a3 = await buildArena(H);
    await E(A => window.__god.UI.commandKingdom(A, {}), a3.A); await b.wait(300);
    await E(([A, B]) => { window.__god.War.declare(A, B, [], undefined); }, [a3.A, a3.B]);
    await E(() => window.__god.step(200));
    let seed = args.seed ? +args.seed : 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    let taps = 0;
    for (let i = 0; i < (args.fuzz ? +args.fuzz : 200); i++) {
      const r = rnd();
      if (r < 0.4) {
        const sel = await E((q) => { const bs = [...document.querySelectorAll('#sheet button, .cpop button, #sheet .grab, .wb-card')].filter(x => x.getClientRects().length && !x.disabled && !x.matches('[data-act="retreat-all"]')); if (!bs.length) return null; const e = bs[Math.floor(q * bs.length)]; e.scrollIntoView({ block: 'nearest' }); const z = e.getBoundingClientRect(); return [z.left + z.width / 2, z.top + z.height / 2]; }, rnd());
        if (sel) { await b.tap(sel[0], sel[1]); taps++; }
      } else if (r < 0.85) { await b.tap(20 + rnd() * 350, 120 + rnd() * 330); taps++; }
      else if (r < 0.9) await E(() => window.__god.step(30));
      else if (r < 0.94) await b.drag(100 + rnd() * 150, 200 + rnd() * 150, 100 + rnd() * 150, 200 + rnd() * 150, 5, 15);
      else if (r < 0.97) await E(k => { const g = window.__god; if (!g.UI.cmdKid && g.S.kingdoms.has(k)) g.UI.commandKingdom(k, { focus: false }); }, a3.A);
      else await E(() => { const g = window.__god; const t = g.UI.targets.find(e => e.ok); if (t) g.UI.pickTarget(t.regionId); });
      if (i % 40 === 39) await b.wait(250);
    }
    await b.wait(400);
    const st = await E(() => ({ err: document.getElementById('errbox').hidden }));
    check(`${taps} random taps / drags over the war tool: no page errors, error box hidden`, b.errors.length === 0 && st.err, b.errors.slice(0, 2).join(' || '));
    await E(() => { window.__god.UI.releaseCommand(true); window.__god.UI.closeInspector(); window.__god.UI.closeAllModals(); }); await b.wait(300);
    check('after the fuzz a release leaves nothing stuck', isClean(await H.state()), JSON.stringify(await H.state()));
    await H.shot('25_after_fuzz');
  } else check('arena for the robustness test', false);
  await b.close();
}

// ===========================================================================================================================
// 3. perf of the live refresh
// ===========================================================================================================================
if (!only || only.includes('perf')) {
  section('perf: UI refresh with the HUD / card / drawer open during a war');
  const H = await open(390, 844);
  const { b, E } = H;
  await b.wait(1500);
  const arena = await buildArena(H);
  if (arena) {
    await E(A => { window.__god.UI.commandKingdom(A, {}); }, arena.A);
    await b.wait(800);
    await E(([A, B]) => { window.__god.War.declare(A, B, [], undefined); }, [arena.A, arena.B]);
    await E(() => window.__god.step(300));
    const measure = () => E(() => { const g = window.__god; const t0 = performance.now(); for (let i = 0; i < 100; i++) g.UI.update(300); return (performance.now() - t0) / 100; });
    let ms = await measure();
    console.log(`  UI.update (HUD): ${ms.toFixed(3)} ms per refresh (4 per second)`);
    check('UI refresh with the HUD < 3 ms', ms < 3, ms.toFixed(3));
    for (const page of ['war', 'armies', 'info']) {
      await E(p => window.__god.UI.openDrawer(p), page); await b.wait(200);
      ms = await measure();
      console.log(`  UI.update (drawer ${page}): ${ms.toFixed(3)} ms per refresh`);
      check(`UI refresh on the ${page} page < 3 ms`, ms < 3, ms.toFixed(3));
    }
    await E(() => { const g = window.__god; const t = g.UI.targets.find(e => e.ok); if (t) g.UI.pickTarget(t.regionId); }); await b.wait(200);
    ms = await measure();
    console.log(`  UI.update (attack card): ${ms.toFixed(3)} ms per refresh`);
    check('UI refresh with the card < 3 ms', ms < 3, ms.toFixed(3));
    await E(() => window.__god.UI.cancelTarget());
    await E(() => { window.__god.setSpeed(4); });
    await b.wait(3000);
    const st = await E(() => ({ stepMs: window.__god.S.perf.stepMs, frame: window.__god.stats.frameMs, tick: window.__god.S.tick }));
    console.log(`  x4 with the war HUD: sim ${st.stepMs.toFixed(2)} ms/tick, frame cpu ${st.frame.toFixed(1)} ms`);
    check('x4 war with the HUD: frame cpu < 25 ms', st.frame < 25, st.frame.toFixed(1));
    check('no page errors during live refresh', b.errors.length === 0, b.errors.slice(0, 2).join(' || '));
  }
  await b.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('screenshots in ' + SHOTS);
