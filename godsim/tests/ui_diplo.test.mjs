// Player-diplomacy UI test (tool «Дипломатия», src/24_ui_diplomacy.js): the REAL game driven with real touch events (CDP).
//   node tests/ui_diplo.test.mjs [--shots=/tmp/godsim-diplo-ui-shots] [--html=/tmp/godsim-diplo-ui-test.html] [--nobuild] [--only=main,alli,war,vassal,inbox,inspect,stuck,fuzz,perf,small,tiny,land] [--fuzz=N --seed=S]
// Flow (390x844), a hand-built world with three kingdoms A | B | C (A, B: one people, C: another):
//   Kingdoms tab -> tool «Дипломатия» -> tap a country chip = ACTOR (slim HUD with the contacts strip) -> tap another country on the map (or a flag chip)
//   = the PAIR CARD (both flags, opinion bar + causes, status chips, every action as a big button with the forecast / the reason why not) ->
//   a tap answers at once (strip: Принято / Отказ + why), the card refreshes; terms panels (pact length, gift goods, demand, marriage); breaking a treaty needs
//   a second tap; a refused demand offers «Объявить войну»; vassal management; the INBOX (badge + modal [Принять] [Отклонить]); the kingdom inspector keeps working.
// Then: nothing may stay stuck (release / tool switch / actor switch / sea tap / new world / save+load / kingdom death), the same states at 320x568 and
// 844x390 (no overflow, floating buttons clear of the panels, thumb-sized buttons), a random-tap fuzz and the cost of the live refresh.
// The page is built into a PRIVATE html (never index.html): `node build.mjs --out=<html>`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const SHOTS = args.shots || '/tmp/godsim-diplo-ui-shots';
const HTML = args.html || '/tmp/godsim-diplo-ui-test.html';
fs.mkdirSync(SHOTS, { recursive: true });
if (!args.nobuild) execFileSync('node', [path.join(root, 'build.mjs'), '--out=' + HTML, '--check'], { cwd: root, stdio: 'pipe' });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ok   ' + name + (info !== undefined ? '  (' + info + ')' : '')); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (info !== undefined ? '  (' + info + ')' : '')); }
}
const section = s => console.log('\n# ' + s);
/** a scenario never aborts the whole run: an exception is one failed check */
let lastH = null;
async function scenario(name, fn) {
  section(name);
  try { await fn(); }
  catch (e) {
    check('scenario «' + name.slice(0, 40) + '» finished without an exception', false, String(e && e.message || e).split('\n')[0].slice(0, 700));
    try { if (lastH) console.log('  (screenshot of the failure: ' + await lastH.shot('FAIL_' + name.slice(0, 2).replace(/\W/g, '')) + ')'); } catch (e2) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// in-page world builder (serialised by page.evaluate, must be self-contained): three kingdoms in three mutually adjacent regions
// ---------------------------------------------------------------------------------------------------------------------------
function arenaInPage(o) {
  const g = window.__god;
  const { S, Cities, Units, Kingdoms } = g;
  o = o || {};
  function feed() { for (const c of S.cities.values()) { c.stock.food = Math.max(c.stock.food, 160); c.stock.wood = Math.max(c.stock.wood, 90); c.stock.iron = Math.max(c.stock.iron, 40); c.stock.stone = Math.max(c.stock.stone, 50); c.stock.gold = Math.max(c.stock.gold, 12); } }
  function siteIn(rid, race) {
    const r = S.regions.get(rid); let best = null, bd = 1e9;
    for (let y = 1; y < S.h - 1; y++) for (let x = 1; x < S.w - 1; x++) {
      if (S.region[y * S.w + x] !== rid) continue;
      if (!Cities.canFound(x, y, race)) continue;
      const d = (x - r.cx) ** 2 + (y - r.cy) ** 2;
      if (d < bd) { bd = d; best = { x, y }; }
    }
    return best;
  }
  function found(rid, race, pop) {
    const s = siteIn(rid, race); if (!s) return null;
    const fs = [];
    for (let i = 0; i < 6; i++) { const u = Units.spawn(race, s.x + 0.5 + (i % 3) * 0.3, s.y + 0.5 + (i >> 1) * 0.3, { sex: i % 2, age: 22 + (i * 3) % 10 }); if (!u) return null; fs.push(u); }
    const c = Cities.found(race, s.x, s.y, fs, {}); if (!c) return null;
    for (let i = 6; i < pop; i++) { const u = Units.spawn(race, s.x + 0.5 + ((i * 7) % 5) * 0.3, s.y + 0.5 + ((i * 3) % 5) * 0.3, { sex: i % 2, age: 20 + (i * 5) % 20, cityId: c.id }); if (u) u.hunger = 0; }
    return c;
  }
  function triangle() {
    for (const a of S.regions.values()) {
      if (a.ownerId || !siteIn(a.id, 0)) continue;
      for (const bid of a.nb) {
        const b = S.regions.get(bid); if (!b || b.ownerId || a.fd.includes(bid) || !siteIn(b.id, 0)) continue;
        for (const cid of b.nb) {
          if (cid === a.id) continue; const c = S.regions.get(cid);
          if (!c || c.ownerId || !a.nb.includes(cid) || a.fd.includes(cid) || b.fd.includes(cid) || !siteIn(c.id, 0)) continue;
          return [a, b, c];
        }
      }
    }
    return null;
  }
  const tri = triangle(); if (!tri) return null;
  const spec = [[0, o.popA || 70], [0, o.popB || 44], [1, o.popC || 36]];
  const ks = [];
  for (let i = 0; i < 3; i++) {
    const before = S.kingdoms.size;
    const c = found(tri[i].id, spec[i][0], spec[i][1]); if (!c) return null;
    if (S.kingdoms.size === before && !Kingdoms.splitCity(c.id)) return null;
    ks.push({ kid: c.kingdomId, city: c.id });
  }
  feed();
  const m = S.mod.diplomacy;
  for (const k of S.kingdoms.values()) { m.dcd[k.id] = 1e9; m.acd[k.id] = 1e9; m.cd[k.id] = 1e9; }        // the test decides who proposes what
  return { A: ks[0].kid, B: ks[1].kid, C: ks[2].kid, ra: tri[0].id, rb: tri[1].id, rc: tri[2].id, cA: ks[0].city, cB: ks[1].city, cC: ks[2].city };
}
/** after the rulers are crowned: a grown-up son for A's ruler, a grown-up daughter for B's (dynastic marriage), then one tick so every memo is fresh */
function afterInPage(ar) {
  const g = window.__god, { S, Units, Kingdoms } = g;
  const heir = (kid, sex) => {
    const ru = Kingdoms.ruler(kid), k = S.kingdoms.get(kid), c = k && S.cities.get(k.capitalId || k.cities[0]);
    if (!ru || !c) return 0;
    const u = Units.spawn(c.race, c.x + 0.5, c.y + 0.5, { sex, age: 21, cityId: c.id, fatherId: ru.sex === 0 ? ru.id : 0, motherId: ru.sex === 1 ? ru.id : 0 });
    if (u) u.hunger = 0;
    return u ? u.id : 0;
  };
  const out = { son: heir(ar.A, 0), daughter: heir(ar.B, 1) };
  for (const c of S.cities.values()) { c.stock.food = Math.max(c.stock.food, 160); c.stock.wood = Math.max(c.stock.wood, 90); c.stock.iron = Math.max(c.stock.iron, 40); c.stock.stone = Math.max(c.stock.stone, 50); c.stock.gold = Math.max(c.stock.gold, 12); }
  g.step(1);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
async function open(w, h) {
  const b = await launch({ url: 'file://' + HTML, width: w, height: h, verbose: true });
  const E = (fn, arg) => b.eval(fn, arg);
  try { await b.page.waitForFunction(() => window.__god && window.__god.UI && window.__god.UI.ready, null, { timeout: 20000 }); }
  catch (e) { console.log('BOOT FAILED', JSON.stringify(b.errors)); await b.close(); process.exit(1); }
  await b.wait(500);
  const H = {
    b, E, w, h,
    async frames(n = 3) { await E(n => new Promise(r => { let k = 0; const f = () => { if (++k >= n) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n); },
    async shot(name) { const f = path.join(SHOTS, w + 'x' + h + '_' + name + '.png'); await b.shot(f); return f; },
    center: sel => E(sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; }, sel),
    async tapSel(sel, wait = 220) {
      await E(sel => { const e = document.querySelector(sel); if (e && e.closest('.sh-body')) e.scrollIntoView({ block: 'nearest' }); }, sel);
      const c = await H.center(sel); if (!c) throw new Error('no element ' + sel);
      await b.tap(c[0], c[1]); await b.wait(wait); return c;
    },
    exists: sel => E(sel => { const e = document.querySelector(sel); return !!e && e.getClientRects().length > 0; }, sel),
    count: sel => E(sel => document.querySelectorAll(sel).length, sel),
    text: sel => E(sel => { const e = document.querySelector(sel); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; }, sel),
    texts: sel => E(sel => [...document.querySelectorAll(sel)].map(e => e.textContent.replace(/\s+/g, ' ').trim()), sel),
    d: () => E(() => window.__god.UI.diplo),
    async until(fn, arg, ms = 3000) { const t0 = Date.now(); for (;;) { const v = await E(fn, arg); if (v) return v; if (Date.now() - t0 > ms) return v; await b.wait(80); } },
    step: n => E(n => { const g = window.__god; g.step(n); return g.S.tick; }, n),
    setOp: (x, y, v) => E(([x, y, v]) => { const g = window.__god, D = g.Diplomacy; D.addOpinion(x, y, v - D.opinion(x, y), 'Тест'); D.addOpinion(y, x, v - D.opinion(y, x), 'Тест'); g.step(1); }, [x, y, v]),
    /** the player's view of the relation (a -> b) from the sim */
    rel: (x, y) => E(([x, y]) => { const r = window.__god.Diplomacy.relationsOf(x).find(q => q.other === y); return r ? JSON.parse(JSON.stringify(r)) : null; }, [x, y]),
    chipPoint: kid => E(kid => { const g = window.__god; const nm = g.S.kingdoms.get(kid).name; const c = [...document.querySelectorAll('.kchip')].find(x => x.textContent.includes(nm)); if (!c) return null; c.scrollIntoView({ inline: 'nearest' }); const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, kid),
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
      await E(() => { document.querySelectorAll('.toast').forEach(t => t.remove()); });
      let p = await H.regionPoint(rid);
      if (!p) { await E(rid => { const g = window.__god; const c = g.Render.regionCenter(rid); g.UI.focusVisible(c.x, c.y, 9, true); }, rid); await H.frames(4); p = await H.regionPoint(rid); }
      if (!p) throw new Error('region ' + rid + ' has no tappable point');
      await b.tap(p[0], p[1]); await b.wait(260);
      return p;
    },
    seaPoint: () => E(() => { const g = window.__god, S = g.S; const bi = g.UI.bandInfo(); for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) { if (S.tile[y * S.w + x] !== g.Const.T.DEEP) continue; let land = false; for (let j = -2; j <= 2 && !land; j++) for (let i = -2; i <= 2; i++) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < S.w && yy < S.h && S.region[yy * S.w + xx]) { land = true; break; } } if (land) continue; const p = g.Render.tileToScreen(x + 0.5, y + 0.5); if (p.x > bi.left + 30 && p.x < bi.right - 90 && p.y > bi.top + 40 && p.y < bi.bot - 20) { const e = document.elementFromPoint(p.x, p.y); if (e && e.id === 'game') return [p.x, p.y]; } } return null; }),
    /** everything the diplomacy tool may leave behind */
    state: () => E(() => {
      const g = window.__god, bc = document.body.classList, sh = document.getElementById('sheet').classList;
      return {
        diplo: g.UI.diplo.kid, bodyDip: bc.contains('dip'), bodyCard: bc.contains('dip-card'), cmdBody: bc.contains('cmd') || bc.contains('cmd-pick') || bc.contains('cmd-drawer'),
        sheetDip: ['dip', 'dh', 'dc', 'dsub'].some(c => sh.contains(c)), rc: g.Render.cmd, hl: g.Render.highlight, anyCmd: [...g.S.kingdoms.values()].some(k => k.cmd === true), modal: bc.contains('modal-open'),
        sheetOpen: document.getElementById('bottom').classList.contains('sheet-open'), dock: getComputedStyle(document.getElementById('dock')).display, feed: getComputedStyle(document.getElementById('feed')).visibility,
        paint: getComputedStyle(document.querySelector('.fab.paint')).display, pop: !!document.querySelector('.cpop'), mapMode: g.UI.state.mapMode, cmdKid: g.UI.cmdKid,
        fab: [...document.querySelectorAll('.dipfab')].some(f => f.getClientRects().length > 0 && !f.classList.contains('hide')),
      };
    }),
  };
  lastH = H;
  return H;
}
const isClean = s => s.diplo === 0 && !s.bodyDip && !s.bodyCard && !s.cmdBody && !s.sheetDip && s.rc === null && !s.anyCmd && !s.modal && !s.sheetOpen && s.dock !== 'none' && s.feed === 'visible' && s.paint !== 'none' && !s.pop && !s.fab && s.cmdKid === 0;
const SEEDS = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
async function buildArena(H, o) {
  const { E } = H;
  for (const seed of SEEDS) {
    const a = await E(([seed, fn, o]) => { const g = window.__god; g.UI.closeAllModals(); g.Main.newWorld({ seed, w: 96, h: 96, populate: false }); g.setSpeed(0); return eval('(' + fn + ')')(o); }, [seed, arenaInPage.toString(), o || {}]);
    if (!a) continue;
    a.seed = seed;
    await E(() => { const g = window.__god; g.step(150); g.Main.initialView(true); });
    const h = await E(([fn, ar]) => eval('(' + fn + ')')(ar), [afterInPage.toString(), a]);
    a.heirs = h;
    await H.frames(3);
    return a;
  }
  return null;
}
/** floating buttons vs top bar / sheet / each other, horizontal overflow */
const layoutCheck = (H) => H.E(() => {
  const rect = e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
  const vis = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.classList.contains('hide');
  const ov = (a, c) => a.x < c.r - 1 && c.x < a.r - 1 && a.y < c.b - 1 && c.y < a.b - 1;
  const top = rect(document.getElementById('top'));
  const sh = document.getElementById('sheet'), s = vis(sh) && document.getElementById('bottom').classList.contains('sheet-open') ? rect(sh) : null;
  const fabs = [...document.querySelectorAll('#fabs .fab, #fabs .zoom')].filter(vis).map(rect);
  let fabFab = false;
  for (let i = 0; i < fabs.length; i++) for (let j = i + 1; j < fabs.length; j++) if (ov(fabs[i], fabs[j])) fabFab = true;
  return { fabTop: fabs.some(f => ov(f, top)), fabSheet: !!s && fabs.some(f => ov(f, s)), fabFab, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sheet: s, vh: innerHeight, vw: innerWidth, top };
});
/** anything inside the sheet / the modal that sticks out sideways */
const overflowCheck = (H) => H.E(() => {
  const bad = [];
  for (const root of [document.getElementById('sheet'), document.querySelector('.m-card')]) {
    if (!root || !root.getClientRects().length) continue;
    const sh = root.getBoundingClientRect();
    for (const e of root.querySelectorAll('*')) {
      if (!e.getClientRects().length || e.closest('.hscroll')) continue;
      const r = e.getBoundingClientRect(); if (r.width === 0) continue;
      if (r.right > sh.right + 1 || r.left < sh.left - 1) bad.push((e.className && e.className.baseVal === undefined ? e.className : e.tagName) + ' ' + Math.round(r.left) + '-' + Math.round(r.right));
      if (bad.length > 5) break;
    }
  }
  return bad;
});
/** controls that are too small for a thumb (the diplomacy ones: every real button, not the tiny chips) */
const smallButtons = (H, minH = 40) => H.E((minH) => [...document.querySelectorAll('#sheet button, .m-card button, .dipfab')].filter(e => { const r = e.getBoundingClientRect(); return e.getClientRects().length && r.width > 0 && (r.height < minH || r.width < 36) && !e.classList.contains('link'); }).map(e => (e.dataset.act || e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)), minH);
/** the actions the sheet shows, with their text */
const actionRows = (H) => H.E(() => [...document.querySelectorAll('#sheet .dbtn')].map(e => ({ kind: e.dataset.kind, off: e.classList.contains('off'), armed: e.classList.contains('armed'), danger: e.classList.contains('danger'), title: (e.querySelector('b') || {}).textContent || '', hint: (e.querySelector('.dh') || {}).textContent || '', h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) })));
const kinds = rows => rows.map(r => r.kind);

const only = args.only ? String(args.only).split(',') : null;
const want = n => !only || only.includes(n);

/** everything the pair card shows, read from the DOM */
const cardInfo = (H) => H.E(() => {
  const g = window.__god, q = s => document.querySelector(s), sh = document.getElementById('sheet');
  const txt = s => { const e = q(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : null; };
  return {
    d: g.UI.diplo, sheet: [...sh.classList].join(' '), bodyCard: document.body.classList.contains('dip-card'),
    names: [...document.querySelectorAll('#sheet .tc-side b')].map(e => e.textContent), flags: document.querySelectorAll('#sheet .tc-side canvas.flag').length,
    op: txt('#sheet .dip-bar .txt'), mood: txt('#sheet .dip-mood'), top: [...document.querySelectorAll('#sheet .dip-top .chip')].map(e => e.textContent.replace(/\s+/g, ' ').trim()),
    chips: [...document.querySelectorAll('#sheet .dip-chips .chip')].map(e => e.dataset.chip), chipText: [...document.querySelectorAll('#sheet .dip-chips .chip')].map(e => e.textContent.trim()),
    sub: txt('#sheet .tc-sub'), cand: g.Render.cmd ? Array.from(g.Render.cmd.candidates) : null, rcKid: g.Render.cmd ? g.Render.cmd.kid : 0, rcRegion: g.Render.cmd ? g.Render.cmd.regionId : 0,
    res: (() => { const r = q('#sheet .dip-res'); return r && !r.classList.contains('hide') ? { cls: r.className, text: r.textContent.replace(/\s+/g, ' ').trim() } : null; })(),
    h: Math.round(sh.getBoundingClientRect().height), vh: innerHeight,
  };
});
/** clean slate before a scenario: nothing selected, no modal, no inspector */
const cleanSlate = (H) => H.E(() => { const g = window.__god; g.UI.closeAllModals(); g.UI.closeInspector(); g.UI.DiploUI.release(true); g.UI.releaseCommand(true); });
/** real taps: Kingdoms tab -> tool «Дипломатия» -> the country chip */
async function pickActor(H, kid) {
  const { b, E } = H;
  await cleanSlate(H); await b.wait(150);
  if ((await E(() => window.__god.UI.state.tab)) !== 'kingdoms') await H.tapSel('.tab[data-tab="kingdoms"]', 320);
  if ((await E(() => window.__god.UI.state.tool)) !== 'diplomacy') await H.tapSel('#tools .tool[data-tool="diplomacy"]', 260);
  await H.until(kid => { const g = window.__god; const k = g.S.kingdoms.get(kid); return !!k && [...document.querySelectorAll('.kchip')].some(x => x.textContent.includes(k.name)); }, kid, 4000);      // the strip refreshes once a second
  const cp = await H.chipPoint(kid); if (!cp) throw new Error('no chip for kingdom ' + kid);
  await b.tap(cp[0], cp[1]);
  if (!(await H.until(kid => window.__god.UI.diplo.kid === kid, kid, 2500))) throw new Error('the chip tap did not select kingdom ' + kid + ': ' + JSON.stringify(await E(kid => { const g = window.__god; return { d: g.UI.diplo, tool: g.UI.state.tool, tab: g.UI.state.tab, kingdoms: [...g.S.kingdoms.keys()], rels: g.Diplomacy.relationsOf(kid).map(r => r.other), tick: g.S.tick, cmd: [...g.S.kingdoms.values()].filter(k => k.cmd).map(k => k.id), modal: document.body.className }; }, kid)));
  await b.wait(500);
}
async function openCard(H, kid) { await H.tapSel('.dchip[data-kid="' + kid + '"]', 600); }
const resStrip = (H) => H.E(() => { const r = document.querySelector('#sheet .dip-res'); return r && !r.classList.contains('hide') && r.getClientRects().length ? { cls: r.className, text: r.textContent.replace(/\s+/g, ' ').trim(), war: !!r.querySelector('.dr-war') } : null; });
const stockOf = (H, cid) => H.E(cid => { const c = window.__god.S.cities.get(cid); return c ? Object.assign({}, c.stock) : null; }, cid);

// ===========================================================================================================================
// 390x844: the whole flow
// ===========================================================================================================================
if (['main', 'alli', 'war', 'vassal', 'inbox', 'inspect', 'stuck', 'fuzz', 'perf'].some(want)) {
  const H = await open(390, 844);
  const { b, E } = H;
  await b.wait(1400);

  if (want('main')) await scenario('1. tool «Дипломатия», actor (chip), pair card (map tap), refusal, pact, gift, trade, marriage, armed break', async () => {
    const ar = await buildArena(H);
    check('arena: three kingdoms A | B | C, a grown-up heir in A and B', !!ar && ar.heirs.son > 0 && ar.heirs.daughter > 0, ar ? JSON.stringify(ar) : 'none');
    if (!ar) throw new Error('no arena');
    const { A, B, C } = ar;
    await H.tapSel('.tab[data-tab="kingdoms"]', 350);
    const tools = await E(() => [...document.querySelectorAll('#tools .tool')].map(t => ({ id: t.dataset.tool, text: t.textContent.trim(), icon: !!t.querySelector('canvas'), over: t.scrollWidth > t.clientWidth + 1 })));
    check('Kingdoms tab: 5 tools, the new one «Дипломатия» has an icon and a label that fits', tools.length === 5 && tools.some(t => t.id === 'diplomacy' && t.text === 'Дипломатия' && t.icon && !t.over), JSON.stringify(tools.map(t => t.id + ':' + t.text)));
    check('the war tool is still the default of the tab', await E(() => window.__god.UI.state.tool === 'command'));
    await H.shot('01_kingdoms_tab');
    await H.tapSel('#tools .tool[data-tool="diplomacy"]', 300);
    const t1 = await E(() => ({ tool: window.__god.UI.state.tool, hint: document.getElementById('hint').textContent, anyCmd: [...window.__god.S.kingdoms.values()].some(k => k.cmd), chips: document.querySelectorAll('.kchip').length }));
    check('selecting the tool commands nobody; the hint teaches «Выберите свою страну, затем другую»', t1.tool === 'diplomacy' && !t1.anyCmd && /Выберите свою страну, затем другую/.test(t1.hint), t1.hint);
    check('three country chips to pick from', t1.chips === 3, t1.chips);
    await H.shot('02_tool_selected');

    // --- the actor: a chip tap
    const cp = await H.chipPoint(A); await b.tap(cp[0], cp[1]); await b.wait(900);
    const hud = await E(([A]) => { const g = window.__god, sh = document.getElementById('sheet'); return { d: g.UI.diplo, cmd: g.S.kingdoms.get(A).cmd === true, one: [...g.S.kingdoms.values()].filter(k => k.cmd).length, rcKid: g.Render.cmd && g.Render.cmd.kid, body: document.body.classList.contains('dip'), sheet: [...sh.classList].join(' '), dock: getComputedStyle(document.getElementById('dock')).display, chips: [...document.querySelectorAll('.dchip')].map(c => +c.dataset.kid).sort((x, y) => x - y), hint: (document.querySelector('.dip-hint') || {}).textContent, head: (document.querySelector('.dip-head .sh-title b') || {}).textContent, mm: g.UI.state.mapMode, h: sh.getBoundingClientRect().height, name: g.S.kingdoms.get(A).name }; }, [A]);
    check('chip tap = the actor: Kingdoms.setCommanded (exactly one commanded kingdom), HUD, outline on the map', hud.d.kid === A && hud.d.mode === 'hud' && hud.d.owns && hud.cmd && hud.one === 1 && hud.rcKid === A, JSON.stringify(hud.d));
    check('slim HUD replaces the dock (sheet «dip dh», body «dip»), title = the kingdom', hud.body && /\bdip\b/.test(hud.sheet) && /\bdh\b/.test(hud.sheet) && hud.dock === 'none' && hud.head === hud.name && hud.h < 190, `${hud.sheet} dock=${hud.dock} h=${hud.h}`);
    check('contacts strip: a flag chip per other kingdom', JSON.stringify(hud.chips) === JSON.stringify([B, C].sort((x, y) => x - y)), JSON.stringify(hud.chips));
    check('HUD hint says what to do next; the map switches to the political view', /Тапните другую страну/.test(hud.hint || '') && hud.mm === 1, hud.hint);
    await H.shot('03_hud');

    // --- the pair: a tap on the other country on the map
    await H.tapRegion(ar.rb); await b.wait(500);
    let ci = await cardInfo(H);
    check('map tap on another country opens its pair card (the actor stays)', ci.d.kid === A && ci.d.other === B && ci.d.mode === 'card' && /\bdc\b/.test(ci.sheet) && ci.bodyCard, JSON.stringify(ci.d).slice(0, 160));
    const nm = await E(([A, B]) => [window.__god.S.kingdoms.get(A).name, window.__god.S.kingdoms.get(B).name], [A, B]);
    check('card header: both flags and both names', ci.flags === 2 && ci.names[0] === nm[0] && ci.names[1] === nm[1], JSON.stringify(ci.names) + ' flags=' + ci.flags);
    const op = await E(([A, B]) => window.__god.Diplomacy.card(A, B).opinion, [A, B]);
    check('opinion bar shows the sim value; the mood word and up to 3 top causes with signs', ci.op === (op > 0 ? '+' : '') + op && !!ci.mood && ci.top.length >= 1 && ci.top.length <= 3 && ci.top.every(t => /^[+−]/.test(t)), `${ci.op} ${ci.mood} ${JSON.stringify(ci.top)}`);
    check('status chips: peace', JSON.stringify(ci.chips) === '["peace"]' && ci.chipText[0] === 'Мир', JSON.stringify(ci.chipText));
    check('the partner\'s land is selectable on the map (Render.cmd.candidates)', ci.rcKid === A && ci.cand && ci.cand.includes(ar.rb), JSON.stringify(ci.cand));
    check('the card is compact (sheet ≤ 62% of the screen)', ci.h <= ci.vh * 0.62 + 2, ci.h + ' of ' + ci.vh);
    let rows = await actionRows(H);
    const sim = await E(([A, B]) => window.__god.Diplomacy.actionsFor(A, B).map(a => ({ kind: a.kind, available: a.available, reason: a.reason })), [A, B]);
    check('the card lists exactly the actions of Diplomacy.actionsFor', JSON.stringify(kinds(rows).sort()) === JSON.stringify(sim.map(a => a.kind).sort()), kinds(rows).join(','));
    const firstOff = rows.findIndex(r => r.off);
    check('available actions first, unavailable ones dimmed at the end under «Сейчас недоступно»', firstOff < 0 || (rows.slice(firstOff).every(r => r.off) && rows.slice(0, firstOff).every(r => !r.off) && (await H.texts('#sheet .dip-cap')).includes('Сейчас недоступно')), rows.map(r => r.kind + (r.off ? '-' : '+')).join(' '));
    check('every unavailable action says why (a reason on the button)', rows.filter(r => r.off).every(r => r.hint.length > 6), JSON.stringify(rows.filter(r => r.off).map(r => r.hint)));
    check('every available action shows a forecast / cost', rows.filter(r => !r.off).every(r => r.hint.length > 3), JSON.stringify(rows.filter(r => !r.off).map(r => r.kind + ':' + r.hint)));
    check('buttons are thumb-sized (≥ 52 px high)', rows.every(r => r.h >= 52), 'min ' + Math.min(...rows.map(r => r.h)));
    await H.shot('04_card');
    // a tap on a dimmed one: explains, nothing happens
    const off = rows.find(r => r.off);
    if (off) {
      await H.tapSel('.dbtn[data-kind="' + off.kind + '"]', 350);
      const rs = await resStrip(H);
      check('tap on an unavailable action: «Недоступно» + the reason, no change', !!rs && /^Недоступно/.test(rs.text) && rs.text.length > 20, rs && rs.text);
    }

    // --- alliance: refused (the button said so)
    check('alliance button forecasts a refusal', /Откажут/.test(rows.find(r => r.kind === 'alliance').hint), rows.find(r => r.kind === 'alliance').hint);
    await H.tapSel('.dbtn[data-kind="alliance"]', 450);
    let rs = await resStrip(H);
    check('refusal: red strip «Отказ» with the reason, once (no doubled prefix)', !!rs && /\bno\b/.test(rs.cls) && /^Отказ/.test(rs.text) && !/Отказ.*Отказ/.test(rs.text) && rs.text.length > 14, rs && rs.text);
    check('the sim agrees: still peace', (await H.rel(A, B)).state === 0);
    await H.shot('05_refused');

    // --- demand panel: look around, send nothing
    await H.tapSel('.dbtn[data-kind="demand"]', 400);
    let pan = await E(() => ({ sub: window.__god.UI.diplo.sub, cls: document.getElementById('sheet').className, seg: [...document.querySelectorAll('.dip-seg button')].map(x => x.dataset.page), rows: document.querySelectorAll('.dopt').length, foot: [...document.querySelectorAll('.dip-foot button')].map(x => x.dataset.act), go: (document.querySelector('[data-act="dip-sub-go"]') || {}).textContent }));
    check('demand: terms panel (Дань | Регион | Вассалитет), variants with forecasts, [Назад] [Предъявить]', pan.sub === 'demand' && /\bdsub\b/.test(pan.cls) && pan.seg.join() === 'tribute,region,vassal' && pan.rows >= 2 && pan.foot.join() === 'dip-sub-back,dip-sub-go', JSON.stringify(pan));
    await H.shot('06_demand_panel');
    await H.tapSel('[data-act="dip-what"][data-page="vassal"]', 250);
    check('the vassalage page: one variant', (await H.count('.dopt')) === 1);
    await H.tapSel('[data-act="dip-sub-back"]', 350);
    pan = await E(() => ({ sub: window.__god.UI.diplo.sub, cls: document.getElementById('sheet').className, grid: document.querySelectorAll('.dip-grid .dbtn').length, foot: document.querySelector('.dip-foot') && !document.querySelector('.dip-foot').classList.contains('hide') }));
    check('[Назад]: the action list is back, nothing was sent', !pan.sub && !/\bdsub\b/.test(pan.cls) && pan.grid >= 6 && !pan.foot && (await H.rel(A, B)).state === 0 && !(await E(([A, B]) => window.__god.S.wars.size, [A, B])));

    // --- pact: length is part of the deal
    await H.tapSel('.dbtn[data-kind="pact"]', 400);
    pan = await E(() => ({ sub: window.__god.UI.diplo.sub, opts: [...document.querySelectorAll('.dopt')].map(o => ({ t: o.textContent.replace(/\s+/g, ' ').trim(), on: o.classList.contains('on') })), go: (document.querySelector('[data-act="dip-sub-go"]') || {}).textContent }));
    check('pact: three lengths (10 / 20 / 40 years) with forecasts, one is chosen, [Предложить пакт]', pan.sub === 'pact' && pan.opts.length === 3 && pan.opts.filter(o => o.on).length === 1 && /10 л|20 л|40 л/.test(pan.opts.map(o => o.t).join(' ')) && /пакт/i.test(pan.go), JSON.stringify(pan));
    await H.shot('07_pact_panel');
    await H.tapSel('[data-act="dip-sub-go"]', 650);
    rs = await resStrip(H);
    const pl = await E(([A, B]) => window.__god.Diplomacy.pactLeft(A, B), [A, B]);
    ci = await cardInfo(H);
    check('pact sent: green strip «Принято», the pact is in the sim, the panel closed', !!rs && /\bok\b/.test(rs.cls) && /^Принято/.test(rs.text) && pl > 0 && !ci.d.sub, rs && rs.text);
    check('chip «Пакт · N л.» on the card, the pact action is replaced by the break', ci.chips.includes('pact') && /Пакт · \d+ л\./.test(ci.chipText.join('|')) && kinds(await actionRows(H)).includes('break_pact') && !kinds(await actionRows(H)).includes('pact'), JSON.stringify(ci.chipText));
    await H.shot('08_pact_done');

    // --- gift: goods from the capital stock
    const capA = await E(A => window.__god.S.kingdoms.get(A).capitalId, A), capB = await E(B => window.__god.S.kingdoms.get(B).capitalId, B);
    const sA0 = await stockOf(H, capA), sB0 = await stockOf(H, capB), op0 = await E(([A, B]) => window.__god.Diplomacy.opinion(B, A), [A, B]);
    await H.tapSel('.dbtn[data-kind="gift"]', 400);
    check('gift panel: goods with steppers, the send button waits for an amount', (await H.count('.dgood')) >= 3 && await E(() => document.querySelector('[data-act="dip-sub-go"]').disabled));
    await H.tapSel('[data-act="gift-plus"][data-good="gold"]', 120); await H.tapSel('[data-act="gift-plus"][data-good="gold"]', 120); await H.tapSel('[data-act="gift-plus"][data-good="wood"]', 120);
    const gv = await E(() => ({ gold: +document.querySelector('[data-good="gold"]').closest('.dgood').querySelector('.dsv').textContent, wood: +document.querySelector('[data-good="wood"]').closest('.dgood').querySelector('.dsv').textContent, sum: document.querySelector('.dgsum').textContent, go: !document.querySelector('[data-act="dip-sub-go"]').disabled }));
    check('steppers: +gold ×2, +wood; the total shows the value and the expected opinion gain; the send button wakes up', gv.gold === 2 && gv.wood === 5 && /Ценность дара/.test(gv.sum) && /\+\d/.test(gv.sum) && gv.go, JSON.stringify(gv));
    await H.tapSel('[data-act="gift-minus"][data-good="wood"]', 120);
    check('«−» takes it back', (await E(() => +document.querySelector('[data-good="wood"]').closest('.dgood').querySelector('.dsv').textContent)) === 0);
    await H.shot('09_gift_filled');
    await H.tapSel('[data-act="dip-sub-go"]', 650);
    rs = await resStrip(H);
    const sA1 = await stockOf(H, capA), sB1 = await stockOf(H, capB), op1 = await E(([A, B]) => window.__god.Diplomacy.opinion(B, A), [A, B]);
    check('gift sent: «Принято», 2 gold left the capital of A and reached B, opinion grew', !!rs && /\bok\b/.test(rs.cls) && sA1.gold === sA0.gold - 2 && sB1.gold >= sB0.gold + 1 && op1 > op0, `${rs && rs.text} | A.gold ${sA0.gold}->${sA1.gold} B.gold ${sB0.gold}->${sB1.gold} op ${op0}->${op1}`);
    await H.shot('10_gift_done');

    // --- trade: a simple one-tap treaty
    await H.setOp(A, B, 60);
    await H.until(() => { const e = document.querySelector('.dbtn[data-kind="trade"] .dh'); return e && !/Откажут/.test(e.textContent); }, null, 2500);
    await H.tapSel('.dbtn[data-kind="trade"]', 600);
    rs = await resStrip(H); ci = await cardInfo(H);
    check('trade: one tap, «Принято», chip «Торговля», the button turns into «Прекратить торговлю»', !!rs && /\bok\b/.test(rs.cls) && ci.chips.includes('trade') && kinds(await actionRows(H)).includes('cancel_trade') && (await E(([A, B]) => window.__god.Diplomacy.tradeOn(A, B), [A, B])), rs && rs.text);

    // --- marriage: the two heirs
    await H.until(() => { const e = document.querySelector('.dbtn[data-kind="marriage"]'); return e && !e.classList.contains('off'); }, null, 2500);
    await H.tapSel('.dbtn[data-kind="marriage"]', 450);
    pan = await E(() => ({ sub: window.__god.UI.diplo.sub, pers: [...document.querySelectorAll('.dmar .dpers b')].map(e => e.textContent), note: (document.querySelector('.dip-note') || {}).textContent }));
    check('marriage panel: both heirs by name, a verdict line', pan.sub === 'marriage' && pan.pers.length === 2 && pan.pers.every(n => n && n !== '?') && !!pan.note, JSON.stringify(pan));
    await H.shot('11_marriage_panel');
    await H.tapSel('[data-act="dip-sub-go"]', 650);
    rs = await resStrip(H); ci = await cardInfo(H);
    check('wedding: «Принято», chip «Брак», a marriage record in the sim', !!rs && /\bok\b/.test(rs.cls) && ci.chips.includes('marriage') && !!(await E(([A, B]) => window.__god.Diplomacy.marriageOf(A, B), [A, B])), rs && rs.text);

    // --- breaking a treaty needs a second tap; the armed state fades
    const opB0 = await E(([A, B]) => window.__god.Diplomacy.opinion(B, A), [A, B]);
    await H.tapSel('.dbtn[data-kind="break_pact"]', 350);
    rows = await actionRows(H);
    let br = rows.find(r => r.kind === 'break_pact');
    check('first tap only arms the button («Точно? …»), nothing is broken yet', !!br && br.armed && /^Точно\?/.test(br.title) && (await H.d()).armed === 'break_pact' && (await E(([A, B]) => window.__god.Diplomacy.pactLeft(A, B), [A, B])) > 0, br && br.title);
    await H.shot('12_break_armed');
    await b.wait(3900);
    br = (await actionRows(H)).find(r => r.kind === 'break_pact');
    check('an armed button relaxes by itself after ~3.5 s', !!br && !br.armed && (await H.d()).armed === '', br && br.title);
    await H.tapSel('.dbtn[data-kind="break_pact"]', 300); await H.tapSel('.dbtn[data-kind="break_pact"]', 650);
    rs = await resStrip(H); ci = await cardInfo(H);
    const opB1 = await E(([A, B]) => window.__god.Diplomacy.opinion(B, A), [A, B]);
    check('second tap breaks the pact: no pact chip, opinion fell (price paid), the strip says what happened', !!rs && !ci.chips.includes('pact') && (await E(([A, B]) => window.__god.Diplomacy.pactLeft(A, B), [A, B])) === 0 && opB1 < opB0 - 10, `${rs && rs.text} | op ${opB0}->${opB1}`);
    await H.shot('13_break_done');
    check('no page errors in the pair flow', b.errors.length === 0, b.errors.slice(0, 2).join(' || '));
  });
  if (want('alli')) await scenario('2. alliance, guarantee, embargo (second tap) and lifting it, breaking an alliance (second tap)', async () => {
    const ar = await buildArena(H);
    if (!ar) throw new Error('no arena');
    const { A, B, C } = ar;
    await pickActor(H, A); await openCard(H, B);
    await H.setOp(A, B, 85);
    await H.until(() => { const e = document.querySelector('.dbtn[data-kind="alliance"] .dh'); return e && !/Откажут/.test(e.textContent); }, null, 2500);
    let rows = await actionRows(H);
    check('after the opinion rose the alliance button no longer forecasts a refusal', !/Откажут/.test(rows.find(r => r.kind === 'alliance').hint), rows.find(r => r.kind === 'alliance').hint);
    await H.tapSel('.dbtn[data-kind="alliance"]', 650);
    let rs = await resStrip(H), ci = await cardInfo(H);
    check('alliance: «Принято», chip «Союз», the sim says ALLIANCE', !!rs && /\bok\b/.test(rs.cls) && ci.chips.includes('alliance') && (await H.rel(A, B)).state === 1, rs && rs.text);
    rows = await actionRows(H);
    check('allies: «Разорвать союз» is offered, no embargo against an ally', kinds(rows).includes('break_alliance') && !rows.some(r => r.kind === 'embargo' && !r.off), JSON.stringify(rows.filter(r => /embargo|break_alliance/.test(r.kind)).map(r => r.kind + ':' + r.hint)));
    await H.shot('17_allies');
    await H.tapSel('.dbtn[data-kind="guarantee"]', 650);
    ci = await cardInfo(H);
    check('guarantee: chip «Вы гарантируете», the button turns into «Снять гарантию»', ci.chips.includes('guarantee') && /Вы гарантируете/.test(ci.chipText.join('|')) && kinds(await actionRows(H)).includes('break_guarantee'), JSON.stringify(ci.chipText));
    await H.tapSel('.dbtn[data-kind="break_alliance"]', 350);
    check('«Разорвать союз»: armed after the first tap, the alliance stands', (await actionRows(H)).find(r => r.kind === 'break_alliance').armed && (await H.rel(A, B)).state === 1);
    await H.tapSel('.dbtn[data-kind="break_alliance"]', 650);
    rs = await resStrip(H); ci = await cardInfo(H);
    check('second tap: the alliance is over (peace), the strip tells it', !!rs && (await H.rel(A, B)).state === 0 && !ci.chips.includes('alliance'), rs && rs.text);
    // embargo against C
    await H.tapSel('[data-act="dip-close"]', 450);
    await openCard(H, C);
    await H.tapSel('.dbtn[data-kind="embargo"]', 350);
    check('embargo: armed first', (await actionRows(H)).find(r => r.kind === 'embargo').armed);
    await H.tapSel('.dbtn[data-kind="embargo"]', 650);
    ci = await cardInfo(H);
    check('embargo: chip «Эмбарго · N л.», «Снять эмбарго» appears', ci.chips.includes('embargo') && kinds(await actionRows(H)).includes('lift_embargo'), JSON.stringify(ci.chipText));
    await H.shot('18_embargo');
    await H.tapSel('.dbtn[data-kind="lift_embargo"]', 650);
    ci = await cardInfo(H);
    check('lifting the embargo needs one tap and removes the chip', !ci.chips.includes('embargo') && (await E(([A, C]) => window.__god.Diplomacy.embargoLeft(A, C), [A, C])) === 0);
  });

  if (want('war')) await scenario('3. a refused demand: «Объявить войну» (casus: ultimatum), the war chip on the card, white peace', async () => {
    const ar = await buildArena(H);
    if (!ar) throw new Error('no arena');
    const { A, B, C } = ar;
    await pickActor(H, C); await openCard(H, A);                      // the weaker people demands: refused for sure
    const dem = await E(([C, A]) => window.__god.Diplomacy.actionsFor(C, A).find(a => a.kind === 'demand').options, [C, A]);
    const reg = dem.find(o => o.what === 'region' && o.ok);
    await H.tapSel('.dbtn[data-kind="demand"]', 400);
    if (reg) {
      await H.tapSel('[data-act="dip-what"][data-page="region"]', 300);
      const row = await E(() => [...document.querySelectorAll('.dopt')].map(o => ({ on: o.classList.contains('on'), t: o.textContent.replace(/\s+/g, ' ').trim() })));
      check('region page: the chosen region is lit on the map (Render.cmd.regionId) and the verdict is shown', (await cardInfo(H)).rcRegion === reg.rid && row.some(r => r.on), JSON.stringify(row));
      await H.shot('14_demand_region');
    } else console.log('  note no region variant in this seed: the region highlight is not exercised');
    await H.tapSel('[data-act="dip-what"][data-page="tribute"]', 300);
    const go = await E(() => { const e = document.querySelector('[data-act="dip-sub-go"]'); return { t: e.textContent.trim(), danger: e.classList.contains('danger') }; });
    check('a demand the forecast says will be refused is a red «Рискнуть: …» button', /Рискнуть/.test(go.t) && go.danger, JSON.stringify(go));
    await H.tapSel('[data-act="dip-sub-go"]', 700);
    const rs = await resStrip(H);
    check('refused: «Отказ» and a red «Объявить войну» button right in the strip', !!rs && /^Отказ/.test(rs.text) && rs.war, rs && rs.text);
    check('the region highlight is gone after sending', (await cardInfo(H)).rcRegion === 0);
    check('no war yet: the player decides', (await E(() => window.__god.S.wars.size)) === 0);
    await H.shot('15_ultimatum_refused');
    await H.tapSel('.dr-war', 800);
    const w = await E(() => { const ws = [...window.__god.S.wars.values()]; return { n: ws.length, atk: ws[0] && ws[0].attackers.slice(), def: ws[0] && ws[0].defenders.slice(), casus: ws[0] && ws[0].casus }; });
    check('«Объявить войну»: exactly one war, C attacks A, casus «ultimatum»', w.n === 1 && w.atk.includes(C) && w.def.includes(A) && w.casus === 'ultimatum', JSON.stringify(w));
    let ci = await cardInfo(H), rows = await actionRows(H);
    check('the card shows the «Война» chip; peace becomes the thing to discuss', ci.chips.includes('war') && kinds(rows).includes('peace'), JSON.stringify(ci.chips) + ' ' + kinds(rows).join(','));
    await H.shot('16_war_card');
    const peace = rows.find(r => r.kind === 'peace');
    if (peace && !peace.off) {
      await H.tapSel('.dbtn[data-kind="peace"]', 700);
      const ps = await resStrip(H);
      check('«Белый мир»: a clear answer in the strip (accepted or refused with a reason)', !!ps && /^(Принято|Отказ|Отправлено)/.test(ps.text) && ps.text.length > 10, ps && ps.text);
    } else check('«Белый мир» is explained when unavailable (reason on the button)', !!peace && peace.hint.length > 6, peace && peace.hint);
    await H.tapSel('[data-act="dip-close"]', 450);
    const chip = await E(A => { const c = document.querySelector('.dchip[data-kid="' + A + '"]'); return c ? { war: c.classList.contains('war'), icons: c.querySelectorAll('.dc-st canvas').length } : null; }, A);
    check('contacts strip: the chip of the enemy (or the ended war) is up to date', !!chip, JSON.stringify(chip));
    await H.tapSel('[data-act="release"]', 500);
    check('release in a war: everything clean, the AI plays on', isClean(await H.state()), JSON.stringify(await H.state()));
  });

  if (want('vassal')) await scenario('4. vassal management: tribute, release, annexation (conditions, no lottery)', async () => {
    const ar = await buildArena(H);
    if (!ar) throw new Error('no arena');
    const { A, B } = ar;
    await E(([A, B]) => { const g = window.__god, kb = g.S.kingdoms.get(B); kb.overlordId = A; kb.vassalSince = g.S.tick - 1300; g.step(1); }, [A, B]);
    await pickActor(H, A); await openCard(H, B);
    let ci = await cardInfo(H), rows = await actionRows(H);
    check('vassal card: chip «Вассал»; «Освободить», «Дань», «Присоединить» are available', ci.chips.includes('vassal') && ['release', 'tribute', 'annex'].every(k => rows.some(r => r.kind === k && !r.off)), kinds(rows).join(',') + ' ' + JSON.stringify(ci.chips));
    check('the vassal group has its own caption', (await H.texts('#sheet .dip-cap')).includes('Вассал'));
    await H.shot('19_vassal_card');
    const capA = await E(A => window.__god.S.kingdoms.get(A).capitalId, A), capB = await E(B => window.__god.S.kingdoms.get(B).capitalId, B);
    const a0 = await stockOf(H, capA), b0 = await stockOf(H, capB);
    await H.tapSel('.dbtn[data-kind="tribute"]', 700);
    let rs = await resStrip(H);
    const a1 = await stockOf(H, capA), b1 = await stockOf(H, capB);
    const sum = s => s.food + s.wood + s.stone + s.iron + s.gold;
    check('tribute: «Принято», goods moved from the vassal\'s capital to the overlord\'s', !!rs && /\bok\b/.test(rs.cls) && sum(b1) < sum(b0) && sum(a1) > sum(a0), `${rs && rs.text} | A ${sum(a0)}->${sum(a1)} B ${sum(b0)}->${sum(b1)}`);
    rows = await actionRows(H);
    check('tribute can be taken only once in a while: the button explains', rows.find(r => r.kind === 'tribute').off && rows.find(r => r.kind === 'tribute').hint.length > 6, rows.find(r => r.kind === 'tribute').hint);
    await H.tapSel('.dbtn[data-kind="release"]', 700);
    rs = await resStrip(H); ci = await cardInfo(H);
    check('«Освободить»: B is independent again (no vassal chip, no overlord in the sim)', !!rs && !ci.chips.includes('vassal') && (await E(B => window.__god.S.kingdoms.get(B).overlordId, B)) === 0, rs && rs.text);
    await E(([A, B]) => { const g = window.__god, kb = g.S.kingdoms.get(B); kb.overlordId = A; kb.vassalSince = g.S.tick - 1300; g.step(1); }, [A, B]);
    await H.until(() => { const e = document.querySelector('.dbtn[data-kind="annex"]'); return e && !e.classList.contains('off'); }, null, 2500);
    await H.tapSel('.dbtn[data-kind="annex"]', 900);
    const gone = await E(B => !window.__god.S.kingdoms.has(B) || window.__god.S.kingdoms.get(B).alive === false, B);
    const after = await H.d();
    check('«Присоединить»: the vassal joins the kingdom at once, the card closes, the HUD stays', gone && after.kid === A && after.mode === 'hud', JSON.stringify(after).slice(0, 120));
    check('a toast says what happened', (await H.texts('.toast')).some(t => /состав|присоедин/i.test(t)), (await H.texts('.toast')).join(' | '));
    await H.shot('20_annexed');
  });

  if (want('inbox')) await scenario('5. inbox: proposals to the commanded kingdom are never auto-accepted — toast, badges, modal [Принять] [Отклонить]', async () => {
    const ar = await buildArena(H);
    if (!ar) throw new Error('no arena');
    const { A, B, C } = ar;
    await pickActor(H, A);
    check('no proposals yet: badges hidden', (await H.d()).inbox === 0 && !(await E(() => !!document.querySelector('.dipmail:not(.hide)'))) && !(await H.state()).fab);
    await H.setOp(B, A, 80); await H.setOp(C, A, 80);
    const pr = await E(([A, B, C]) => { const D = window.__god.Diplomacy; return [D.propose(B, A, 'alliance'), D.propose(C, A, 'trade')].map(r => ({ ok: r.ok, pending: r.pending, accepted: r.accepted })); }, [A, B, C]);
    check('AI-to-player proposals wait for the player (pending, not accepted)', pr.every(r => r.ok && r.pending && !r.accepted), JSON.stringify(pr));
    await b.wait(700);
    const badge = await E(() => ({ n: (document.querySelector('.dipmail .dn') || {}).textContent, mailVis: !!document.querySelector('.dipmail:not(.hide)'), fabN: (document.querySelector('.dipfab .dn') || {}).textContent, fabVis: [...document.querySelectorAll('.dipfab')].some(f => f.getClientRects().length > 0 && !f.classList.contains('hide')), toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent), hint: (document.querySelector('.dip-hint') || {}).textContent, inbox: window.__god.UI.diplo.inbox }));
    check('badge «2» on the HUD button and on the floating ✉; the HUD hint mentions it', badge.inbox === 2 && badge.n === '2' && badge.mailVis && badge.fabN === '2' && badge.fabVis && /Ждут ответа/.test(badge.hint), JSON.stringify(badge));
    check('a toast announced the proposal', badge.toasts.length >= 1, badge.toasts.join(' | '));
    await H.shot('21_proposals_arrived');
    await H.tapSel('[data-act="dip-fab"]', 600);
    const mod = await E(() => ({ cards: [...document.querySelectorAll('.m-card .dmail')].map(c => ({ kind: c.dataset.kind, yes: !!c.querySelector('[data-act="dip-accept"]'), no: !!c.querySelector('[data-act="dip-decline"]'), text: c.textContent.replace(/\s+/g, ' ').trim(), h: Math.round(c.querySelector('[data-act="dip-accept"]').getBoundingClientRect().height) })), title: (document.querySelector('.m-head h2') || {}).textContent }));
    check('modal «Предложения»: one card per proposal, each with [Принять] [Отклонить], the offer and the opinion', mod.title === 'Предложения' && mod.cards.length === 2 && mod.cards.every(c => c.yes && c.no && /отношения \+/.test(c.text) && c.h >= 40), JSON.stringify(mod.cards.map(c => c.kind + ':' + c.h)));
    await H.shot('22_inbox_modal');
    await H.tapSel('.dmail[data-kind="alliance"] [data-act="dip-accept"]', 120);
    const ans = await E(() => { const c = document.querySelector('.dmail[data-kind="alliance"]'); return c ? { res: (c.querySelector('.dm-res') || {}).textContent, cls: c.className, buttons: c.querySelectorAll('.dm-acts button').length } : null; });
    check('[Принять] on the alliance: the alliance exists, the card shows the answer instead of the buttons', (await H.rel(A, B)).state === 1 && !!ans && /Союз|Принято/.test(ans.res || '') && /\byes\b/.test(ans.cls) && ans.buttons === 0, JSON.stringify(ans));
    await H.shot('23_inbox_answered');
    await H.tapSel('.dmail[data-kind="trade"] [data-act="dip-decline"]', 700);
    check('[Отклонить] on the trade offer: no trade with C', !(await E(([A, C]) => window.__god.Diplomacy.tradeOn(A, C), [A, C])));
    const closed = await H.until(() => !document.querySelector('.m-card') && !document.body.classList.contains('modal-open'), null, 3000);
    const after = await H.state(); const d = await H.d();
    check('the modal closes by itself when the list is empty; badges are gone; the sim inbox is empty', !!closed && d.inbox === 0 && !after.fab && !(await E(() => !!document.querySelector('.dipmail:not(.hide)'))) && (await E(() => window.__god.S.mod.diplomacy.inbox.length)) === 0, JSON.stringify(d).slice(0, 100));
    // a proposal left unanswered when the player lets go: the AI answers it, nothing dangles
    await E(([A, C]) => { const D = window.__god.Diplomacy; D.propose(C, A, 'pact'); }, [A, C]);
    await b.wait(500);
    check('a new proposal arrives (badge)', (await H.d()).inbox === 1);
    await H.tapSel('[data-act="release"]', 500);
    await H.step(60);
    check('release with a proposal waiting: the sim resolves it (inbox empty), nothing stuck', (await E(() => window.__god.S.mod.diplomacy.inbox.length)) === 0 && isClean(await H.state()), JSON.stringify(await H.state()).slice(0, 160));
  });

  if (want('inspect')) await scenario('6. kingdom inspector: treaty chips and the «Дипломатия» button, both with and without an actor', async () => {
    const ar = await buildArena(H);
    if (!ar) throw new Error('no arena');
    const { A, B, C } = ar;
    const made = await E(([A, B]) => { const g = window.__god, D = g.Diplomacy; D.addOpinion(B, A, 70 - D.opinion(B, A), 'Тест'); g.step(1); return [D.propose(A, B, 'pact', { years: 20 }).accepted, D.propose(A, B, 'trade').accepted]; }, [A, B]);
    check('treaties A–B made through the player API (pact, trade)', made[0] && made[1], JSON.stringify(made));
    // no actor: Info tab -> kingdom inspector -> «Дипломатия» makes the actor
    await cleanSlate(H); await H.tapSel('.tab[data-tab="info"]', 350);
    await E(A => window.__god.UI.openInspector('kingdom', A, { focus: false }), A); await b.wait(500);
    const sec = await E(B => { const w = [...document.querySelectorAll('#sheet .relwrap')].find(x => x.textContent.includes(window.__god.S.kingdoms.get(B).name)); return w ? { chips: [...w.querySelectorAll('.rel-chips .chip')].map(c => c.textContent), text: w.textContent.replace(/\s+/g, ' ') } : null; }, B);
    check('inspector «Дипломатия»: the neighbour shows chips «Пакт» and «Торговля»', !!sec && sec.chips.includes('Пакт') && sec.chips.includes('Торговля'), JSON.stringify(sec));
    await H.shot('24_inspector_chips');
    const btn = await E(() => { const e = document.querySelector('#sheet [data-act="diplomacy"]'); return e ? { t: e.textContent.trim(), vis: e.getClientRects().length > 0 } : null; });
    check('the inspector offers «Дипломатия» for a kingdom nobody commands', !!btn && btn.vis && /Дипломатия/.test(btn.t), JSON.stringify(btn));
    await H.tapSel('#sheet [data-act="diplomacy"]', 800);
    let d = await H.d();
    check('…and a tap makes that kingdom the actor (HUD, inspector closed)', d.kid === A && d.mode === 'hud' && d.owns && !(await E(() => !!window.__god.UI.inspector)), JSON.stringify(d).slice(0, 100));
    // with an actor: the other kingdom's inspector says «Договоры» and opens the pair card
    await E(B => window.__god.UI.openInspector('kingdom', B, { focus: false }), B); await b.wait(500);
    const btn2 = await E(() => { const e = document.querySelector('#sheet [data-act="diplomacy"]'); return e ? { t: e.textContent.trim(), vis: e.getClientRects().length > 0 } : null; });
    check('with an actor the other kingdom\'s inspector offers «Договоры»', !!btn2 && btn2.vis && /Договоры/.test(btn2.t), JSON.stringify(btn2));
    await H.tapSel('#sheet [data-act="diplomacy"]', 800);
    d = await H.d();
    check('…it opens the pair card (inspector closed, the actor stays)', d.kid === A && d.other === B && d.mode === 'card' && !(await E(() => !!window.__god.UI.inspector)), JSON.stringify(d).slice(0, 100));
    // card -> «О стране» -> inspector -> close -> the card is back
    await H.tapSel('[data-act="dip-info"]', 700);
    check('«О стране» on the card opens the inspector of that kingdom', (await E(() => window.__god.UI.inspector && window.__god.UI.inspector.type)) === 'kingdom' && (await E(() => window.__god.UI.inspector.id)) === B);
    await H.shot('25_inspector_from_card');
    await E(() => window.__god.UI.closeInspector()); await b.wait(500);
    d = await H.d(); const ci = await cardInfo(H);
    check('closing the inspector brings the same pair card back', d.kid === A && d.other === B && d.mode === 'card' && /\bdc\b/.test(ci.sheet), JSON.stringify(d).slice(0, 100));
    await cleanSlate(H); await b.wait(200);
    check('clean slate afterwards', isClean(await H.state()), JSON.stringify(await H.state()));
  });
  // @@PART3@@
  await b.close();
}
