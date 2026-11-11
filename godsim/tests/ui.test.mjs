// UI + Main browser test on the REAL index.html.   node tests/ui.test.mjs [--shots=/tmp/godsim-ui-shots] [--nofps] [--nobuild]
// iPhone 390x844 (full scenario: tabs, tools, inspector, menu, save/load/new world, FPS), plus 360x640 / 430x932 / 844x390 sanity shots.
// Real touch events (CDP) are used for every tap / drag, so Input + DOM click synthesis are exercised end to end.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const SHOTS = args.shots || '/tmp/godsim-ui-shots';
fs.mkdirSync(SHOTS, { recursive: true });
if (!args.nobuild) execFileSync('node', [path.join(root, 'build.mjs'), '--check'], { cwd: root, stdio: 'pipe' });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ok   ' + name + (info !== undefined ? '  (' + info + ')' : '')); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (info !== undefined ? '  (' + info + ')' : '')); }
}
const section = s => console.log('\n# ' + s);

/** open a page and return helper functions bound to it */
async function open(w, h, extra = {}) {
  const b = await launch({ file: 'index.html', width: w, height: h, verbose: true, ...extra });
  const E = (fn, arg) => b.eval(fn, arg);
  const H = {
    b, E,
    async frames(n = 3) { await E(n => new Promise(r => { let k = 0; const f = () => { if (++k >= n) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n); },
    async shot(name) { const f = path.join(SHOTS, name + '.png'); await b.shot(f); return f; },
    center: sel => E(sel => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width, r.height]; }, sel),
    async tapSel(sel) { const c = await H.center(sel); if (!c) throw new Error('no element ' + sel); await b.tap(c[0], c[1]); await b.wait(80); return c; },
    exists: sel => E(sel => !!document.querySelector(sel), sel),
    text: sel => E(sel => { const e = document.querySelector(sel); return e ? e.textContent : null; }, sel),
    god: fn => E(fn),
    /** screen position of a world point (css px) */
    s: (x, y) => E(([x, y]) => { const p = window.__god.Render.tileToScreen(x, y); return [p.x, p.y]; }, [x, y]),
    async tapTile(x, y) {
      const [sx, sy] = await H.s(x, y);
      const hit = await E(([sx, sy]) => { const e = document.elementFromPoint(sx, sy); return e ? (e.id || e.className || e.tagName) : null; }, [sx, sy]);
      if (hit !== 'game') console.log('  (!) tapTile: point', Math.round(sx), Math.round(sy), 'is covered by', hit);
      await b.tap(sx, sy); await b.wait(120); return [sx, sy];
    },
    async focus(x, y, z = 14) { await E(([x, y, z]) => { window.__god.UI.focusVisible(x, y, z, true); }, [x, y, z]); await H.frames(3); },
  };
  return H;
}

// ======================================================================================================================
// 1. iPhone 390x844 — full scenario
// ======================================================================================================================
{
  const H = await open(390, 844);
  const { b, E } = H;
  await b.wait(1500);

  section('boot');
  const boot = await E(() => ({
    god: !!window.__god, keys: window.__god ? Object.keys(window.__god) : [], splash: !!document.getElementById('splash'),
    tick: window.__god.S.tick, units: window.__god.S.units.size, w: window.__god.S.w,
    canvas: [document.getElementById('game').width, document.getElementById('game').height],
    speed: window.__god.getSpeed(), uiReady: window.__god.UI.ready,
    scrollY: window.scrollY, bodyH: document.body.scrollHeight,
  }));
  check('window.__god exposes the contract hooks', ['S', 'Sim', 'World', 'Units', 'Cities', 'Kingdoms', 'Diplomacy', 'War', 'Powers', 'Render', 'Save', 'UI', 'Const', 'setSpeed', 'getSpeed', 'step'].every(k => boot.keys.includes(k)), boot.keys.length + ' keys');
  check('splash removed after boot', boot.splash === false);
  check('world alive and loop running', boot.units > 20 && boot.tick > 0, `units ${boot.units} tick ${boot.tick}`);
  check('canvas is css size x dpr', boot.canvas[0] === 780 && boot.canvas[1] === 1688, boot.canvas.join('x'));
  check('speed x1 and UI ready', boot.speed === 1 && boot.uiReady);
  check('no page scroll / overflow', boot.scrollY === 0);
  check('no page errors on boot', b.errors.length === 0, b.errors[0] || '');
  await H.shot('01_boot_powers');

  // deterministic world (the boot world uses a random seed), then let it develop so that cities / kingdoms exist for the inspector tests
  await E(() => { window.__god.Main.newWorld({ seed: 7, w: 96, h: 96, populate: true }); window.__god.setSpeed(0); window.__god.step(1500); });
  await H.frames(3);
  const world = await E(() => { const g = window.__god; return { cities: g.S.cities.size, kingdoms: g.S.kingdoms.size, units: g.S.units.size, year: g.Util.year() }; });
  check('world developed (cities and kingdoms exist)', world.cities > 0 && world.kingdoms > 0, JSON.stringify(world));

  section('top bar');
  await b.wait(350);
  const top = await E(() => ({
    year: document.getElementById('yearVal').textContent,
    pops: [...document.querySelectorAll('.cnt b')].map(e => e.textContent),
    paused: document.body.classList.contains('is-paused'),
  }));
  check('year matches the world', top.year === String(world.year), top.year);
  check('race counters show S.stats', top.pops.slice(0, 3).join(',') === (await E(() => window.__god.S.stats.pop.join(','))), top.pops.join(','));
  check('pause state is shown', top.paused === true);
  // speed buttons
  for (const [i, s] of [[2, 1], [3, 2], [4, 4], [1, 0]]) {
    await H.tapSel(`#speeds button:nth-child(${i})`);
    const got = await E(() => window.__god.getSpeed());
    check('speed button ' + i + ' -> x' + s, got === s, 'got ' + got);
  }
  await H.tapSel('#speeds button:nth-child(2)');
  await b.wait(300);
  const on = await E(() => [...document.querySelectorAll('#speeds button')].map(e => e.classList.contains('on')));
  check('current speed highlighted', on[1] === true && on.filter(Boolean).length === 1, on.join(','));
  await H.tapSel('#speeds button:nth-child(1)');

  section('tabs and tools');
  const tabs = ['land', 'life', 'powers', 'kingdoms', 'info'];
  const expectCount = { land: 9, life: 4, powers: 9, kingdoms: 4, info: 4 };   // built-in tools; kingdoms: command + 3 diplomacy tools (stage 2). Plugin powers (CONTRACT section 10) add buttons to the powers tab: there the count must equal ToolDefs and be >= 9
  for (const t of tabs) {
    await H.tapSel(`.tab[data-tab="${t}"]`);
    await b.wait(120);
    const r = await E(() => ({ tab: window.__god.UI.state.tab, tools: document.querySelectorAll('#tools .tool').length, defs: window.__god.ToolDefs.filter(d => d.tab === window.__god.UI.state.tab).length, hint: document.getElementById('hint').textContent, brushVisible: !document.getElementById('brushbox').classList.contains('hide') }));
    check(`tab ${t}: ${r.tools} buttons`, r.tab === t && (t === 'powers' ? r.tools === r.defs && r.tools >= expectCount[t] : r.tools === expectCount[t]), r.hint.slice(0, 50));
    await H.shot('02_tab_' + t);
  }
  // tool sizes >= 56
  await H.tapSel('.tab[data-tab="land"]');
  const sizes = await E(() => [...document.querySelectorAll('#tools .tool')].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  check('tool buttons >= 56 px', sizes.every(s => s[0] >= 56 && s[1] >= 56), JSON.stringify(sizes[0]));
  const small = await E(() => [...document.querySelectorAll('button')].filter(e => { if (e.classList.contains('fl')) return false; const r = e.getBoundingClientRect(); return r.width > 0 && (r.width < 36 || r.height < 36); }).map(e => e.className + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)));
  check('no tiny buttons (< 36 px)', small.length === 0, small.join('; '));
  const touch = await E(() => ['#speeds button', '#btnMenu', '.fab', '.zoom button', '.tab'].map(sel => { const e = document.querySelector(sel); if (!e || e.offsetParent === null) return sel + ' (hidden)'; const r = e.getBoundingClientRect(); return (r.width >= 44 && r.height >= 44) ? null : sel + ' ' + Math.round(r.width) + 'x' + Math.round(r.height); }).filter(Boolean));
  check('speed / menu / fab / zoom / tab buttons >= 44 px', touch.length === 0, touch.join('; '));

  // brush stepper + preview
  await H.tapSel('#tools .tool[data-tool="raise"]');
  const stepSize = await E(() => { const r = document.querySelector('#brushbox .step').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
  check('brush stepper buttons >= 44 px', stepSize[0] >= 44 && stepSize[1] >= 44, stepSize.join('x'));
  const before = await E(() => window.__god.UI.state.brush);
  await H.tapSel('#brushbox .step:last-of-type');
  await b.wait(100);
  const afterB = await E(() => ({ brush: window.__god.UI.state.brush, preview: !!window.__god.Render.brush, r: window.__god.Render.brush && window.__god.Render.brush.r }));
  check('brush + stepper changes size and shows live preview', afterB.brush === before + 1 && afterB.preview && afterB.r === afterB.brush, JSON.stringify(afterB));
  await H.shot('03_brush_preview');
  await E(() => window.__god.UI.setBrush(3));

  section('tools on the map');
  // Lightning kills a unit
  await H.tapSel('.tab[data-tab="powers"]');
  await H.tapSel('#tools .tool[data-tool="lightning"]');
  const victim = await E(() => { const g = window.__god; for (const u of g.S.units.values()) { if (u.hp > 0 && !u.isRuler && g.Units.stage(u) === 'adult') return { id: u.id, x: u.x, y: u.y }; } return null; });
  await H.focus(victim.x, victim.y, 14);
  const vpos = await E(id => { const u = window.__god.S.units.get(id); return [u.x, u.y]; }, victim.id);
  await H.tapTile(vpos[0], vpos[1] - 0.3);
  await b.wait(150);
  const dead = await E(id => !window.__god.S.units.has(id), victim.id);
  check('Lightning tap kills the unit under the finger', dead);
  await H.shot('04_lightning');

  // Raise changes terrain (tap on shallow water -> elevation goes up)
  await H.tapSel('.tab[data-tab="land"]');
  await H.tapSel('#tools .tool[data-tool="raise"]');
  const water = await E(() => { const g = window.__god, S = g.S; let best = null, bd = 1e9; for (let y = 12; y < S.h - 12; y++) for (let x = 12; x < S.w - 12; x++) if (S.tile[y * S.w + x] === g.Const.T.DEEP) { const d = Math.hypot(x - S.w / 2, y - S.h / 2); if (d < bd) { bd = d; best = [x, y]; } } return best; });
  await H.focus(water[0] + 0.5, water[1] + 0.5, 12);
  const e0 = await E(([x, y]) => window.__god.S.elev[y * window.__god.S.w + x], water);
  await H.tapTile(water[0] + 0.5, water[1] + 0.5);
  const e1 = await E(([x, y]) => window.__god.S.elev[y * window.__god.S.w + x], water);
  check('Raise tool changes terrain', e1 > e0, `elev ${e0} -> ${e1}`);
  await H.shot('05_raise');

  // Human tool + paint mode drag spawns units
  await H.tapSel('.tab[data-tab="life"]');
  await H.tapSel('#tools .tool[data-tool="human"]');
  await E(() => window.__god.UI.setBrush(2));
  const land = await E(() => { const g = window.__god, S = g.S; for (let y = 10; y < S.h - 10; y++) for (let x = 10; x < S.w - 10; x++) { let ok = true; for (let dy = -3; dy <= 3 && ok; dy++) for (let dx = -3; dx <= 3; dx++) if (S.tile[(y + dy) * S.w + x + dx] !== g.Const.T.GRASS) { ok = false; break; } if (ok) return [x, y]; } return null; });
  check('found an open meadow for painting', !!land);
  await H.focus(land[0] + 0.5, land[1] + 0.5, 16);
  const mode0 = await E(() => window.__god.UI.state.mode);
  await H.tapSel('.fab.paint');
  const mode1 = await E(() => ({ ui: window.__god.UI.state.mode, input: window.__god.Input.mode, body: document.body.classList.contains('paint') }));
  check('paint toggle: pan -> paint (UI, Input, body class)', mode0 === 'pan' && mode1.ui === 'paint' && mode1.input === 'paint' && mode1.body, JSON.stringify(mode1));
  await H.shot('06_paint_mode');
  const n0 = await E(() => window.__god.S.units.size);
  const [px, py] = await H.s(land[0] + 0.5, land[1] + 0.5);
  await b.drag(px - 50, py, px + 50, py + 20, 14, 40);
  await b.wait(200);
  const n1 = await E(() => window.__god.S.units.size);
  check('drag in paint mode with the Human tool spawns units', n1 > n0 + 2, `${n0} -> ${n1}`);
  await H.shot('07_painted_units');
  await H.tapSel('.fab.paint');
  check('paint toggle back to pan', (await E(() => window.__god.Input.mode)) === 'pan');
  // pan mode drag pans the camera and does not spawn
  const cam0 = await E(() => ({ ...window.__god.Render.cam }));
  const n2 = await E(() => window.__god.S.units.size);
  await b.drag(px, py - 100, px + 60, py - 40, 8, 20);
  const cam1 = await E(() => ({ ...window.__god.Render.cam }));
  check('pan mode: drag moves the camera, spawns nothing', Math.abs(cam1.x - cam0.x) + Math.abs(cam1.y - cam0.y) > 0.5 && (await E(() => window.__god.S.units.size)) === n2);

  // map mode fab + zoom
  await H.tapSel('.fab:not(.paint)');
  const mm = await E(() => ({ m: window.__god.Render.mode, ui: window.__god.UI.state.mapMode }));
  check('map mode FAB cycles to borders', mm.m === 1 && mm.ui === 1);
  await H.shot('08_borders_mode');
  await H.tapSel('.fab:not(.paint)'); await H.tapSel('.fab:not(.paint)');
  check('map mode cycles back to normal', (await E(() => window.__god.Render.mode)) === 0);
  const z0 = await E(() => window.__god.Render.cam.zoom);
  await H.tapSel('.zoom button:first-child'); await b.wait(600);
  const z1 = await E(() => window.__god.Render.cam.zoom);
  await H.tapSel('.zoom button:last-child'); await b.wait(600);
  const z2 = await E(() => window.__god.Render.cam.zoom);
  check('zoom buttons zoom in and out', z1 > z0 * 1.2 && z2 < z1 * 0.85, `${z0.toFixed(1)} -> ${z1.toFixed(1)} -> ${z2.toFixed(1)}`);

  section('touch gestures on the chrome');
  // horizontal touch scroll of the tools row (touch-action: pan-x) and the brush slider (touch drag)
  await H.tapSel('.tab[data-tab="powers"]');
  const row = await H.center('#tools');
  const sl0 = await E(() => document.getElementById('tools').scrollLeft);
  await b.drag(row[0] + 120, row[1], row[0] - 120, row[1], 10, 20);
  await b.wait(400);
  const sl1 = await E(() => document.getElementById('tools').scrollLeft);
  check('tools row scrolls horizontally by touch', sl1 > sl0 + 30, `${sl0} -> ${sl1}`);
  await E(() => { document.getElementById('tools').scrollLeft = 0; });
  await H.tapSel('#tools .tool[data-tool="meteor"]');
  const sc = await H.center('#brushbox .slider');
  await E(() => window.__god.UI.setBrush(1));
  await b.drag(sc[0] - sc[2] / 2 + 6, sc[1], sc[0] + sc[2] / 2 - 4, sc[1], 10, 20);
  await b.wait(200);
  const bs = await E(() => window.__god.UI.state.brush);
  check('brush slider drags by touch (1 -> 8)', bs >= 7, 'brush ' + bs);
  await E(() => { window.__god.Render.brush = null; window.__god.UI.setBrush(3); });
  // pinch zoom through the DOM overlay
  const pz0 = await E(() => window.__god.Render.cam.zoom);
  await b.pinch(195, 330, 60, 170, 10, 20);
  await b.wait(500);
  const pz1 = await E(() => window.__god.Render.cam.zoom);
  check('two-finger pinch zooms the map', pz1 > pz0 * 1.4, `${pz0.toFixed(1)} -> ${pz1.toFixed(1)}`);
  // failure message toast: creating a human in deep water
  await H.tapSel('.tab[data-tab="life"]'); await H.tapSel('#tools .tool[data-tool="human"]');
  await E(() => window.__god.UI.setBrush(1));
  const deep = await E(() => { const g = window.__god, S = g.S; let best = null, bd = 1e9; for (let y = 12; y < S.h - 12; y++) for (let x = 12; x < S.w - 12; x++) { let all = true; for (let dy = -3; dy <= 3 && all; dy++) for (let dx = -3; dx <= 3; dx++) if (S.tile[(y + dy) * S.w + x + dx] !== g.Const.T.DEEP) { all = false; break; } if (all) { const d = Math.hypot(x - S.w / 2, y - S.h / 2); if (d < bd) { bd = d; best = [x, y]; } } } return best; });
  check('found open sea for the failure test', !!deep);
  await H.focus(deep[0] + 0.5, deep[1] + 0.5, 12);
  const nBefore = await E(() => window.__god.S.units.size);
  await H.tapTile(deep[0] + 0.5, deep[1] + 0.5);
  await b.wait(150);
  const failToast = await E(() => ({ n: window.__god.S.units.size, toasts: [...document.querySelectorAll('.toast.bad')].map(e => e.textContent) }));
  check('a tool that cannot act shows the reason as a toast', failToast.n === nBefore && failToast.toasts.length > 0, JSON.stringify(failToast.toasts));
  await E(() => window.__god.UI.setBrush(3));
  // diplomacy tools never throw with the stub kingdoms / diplomacy modules (and with real ones)
  await H.tapSel('.tab[data-tab="kingdoms"]');
  for (const t of ['war_whisper', 'peace', 'split']) {
    await H.tapSel(`#tools .tool[data-tool="${t}"]`);
    const city0 = await E(() => { const c = [...window.__god.S.cities.values()][0]; return c && [c.x + 0.5, c.y + 0.5]; });
    if (city0) { await H.focus(city0[0], city0[1], 12); await H.tapTile(city0[0], city0[1]); }
  }
  check('diplomacy tools work without errors', b.errors.length === 0, b.errors[0] || '');
  await H.tapSel('.tab[data-tab="info"]');

  section('inspector');
  await H.tapSel('.tab[data-tab="info"]');
  check('Info tab selects the inspect tool', (await E(() => window.__god.UI.state.tool)) === 'inspect');
  // unit inspector by tapping a unit
  const target = await E(() => { const g = window.__god; let best = null; for (const u of g.S.units.values()) { if (u.cityId && g.Units.stage(u) === 'adult' && (!best || u.isRuler)) { best = { id: u.id, x: u.x, y: u.y }; if (u.isRuler) break; } } return best; });
  await H.focus(target.x, target.y, 14);
  const tp = await E(id => { const u = window.__god.S.units.get(id); return [u.x, u.y]; }, target.id);
  await H.tapTile(tp[0], tp[1] - 0.3);
  await b.wait(500);
  const ui1 = await E(() => ({ insp: window.__god.UI.inspector, open: document.getElementById('bottom').classList.contains('sheet-open'), title: document.querySelector('.sh-title b') && document.querySelector('.sh-title b').textContent, hl: window.__god.Render.highlight && window.__god.Render.highlight.type, h: document.getElementById('sheet').getBoundingClientRect().height, vh: innerHeight }));
  check('tap on a unit with Inspect opens the unit sheet', ui1.insp && ui1.insp.type === 'unit' && ui1.open, JSON.stringify(ui1));
  check('sheet is at most 55% of the screen', ui1.h <= ui1.vh * 0.55 + 1, Math.round(ui1.h) + ' / ' + ui1.vh);
  check('selection ring set on the unit', ui1.hl === 'unit');
  await H.shot('09_inspector_unit');
  // scroll the body to see the rest
  await E(() => { const b = document.querySelector('.sh-body'); b.scrollTop = 9999; });
  await b.wait(200);
  await H.shot('09b_inspector_unit_scrolled');
  // follow a city link
  const hasCityLink = await H.exists('.sh-body .link');
  check('unit sheet has navigation links (city / kingdom / family)', hasCityLink);
  // city
  const city = await E(() => { const g = window.__god; let best = null; for (const c of g.S.cities.values()) if (!best || c.pop > best.pop) best = c; return best && { id: best.id, x: best.x, y: best.y, kid: best.kingdomId }; });
  await E(c => window.__god.UI.openInspector('city', c.id, { focus: true }), city);
  await b.wait(700);
  check('city sheet opens', (await E(() => window.__god.UI.inspector)).type === 'city');
  await H.shot('10_inspector_city');
  await E(() => { const b = document.querySelector('.sh-body'); b.scrollTop = 9999; });
  await H.shot('10b_inspector_city_scrolled');
  // kingdom via link in the city sheet
  const kLink = await E(() => { const l = [...document.querySelectorAll('.sh-body .kv .link')].find(e => e.querySelector('canvas.flag')); if (!l) return null; const r = l.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  await E(() => { document.querySelector('.sh-body').scrollTop = 0; });
  await b.wait(100);
  const kLink2 = await E(() => { const l = [...document.querySelectorAll('.sh-body .kv .link')].find(e => e.querySelector('canvas.flag')); if (!l) return null; const r = l.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  check('city sheet has a kingdom link', !!kLink2);
  if (kLink2) { await b.tap(kLink2[0], kLink2[1]); await b.wait(500); }
  const ki = await E(() => window.__god.UI.inspector);
  check('kingdom link opens the kingdom sheet', ki && ki.type === 'kingdom', JSON.stringify(ki));
  await H.shot('11_inspector_kingdom');
  const backBtn = await H.exists('.sh-btn.back');
  check('back button appears after navigating', backBtn);
  if (backBtn) { await H.tapSel('.sh-btn.back'); await b.wait(300); check('back returns to the city', (await E(() => window.__god.UI.inspector)).type === 'city'); }
  // show on map
  await E(() => { window.__god.Render.setCamera(5, 5, 5); });
  await H.tapSel('.sh-btn.primary');
  await b.wait(900);
  const camC = await E(() => ({ ...window.__god.Render.cam }));
  check('"На карте" glides the camera to the city', Math.abs(camC.x - (city.x + 0.5)) < 1.5 && camC.zoom >= 10, `cam ${camC.x.toFixed(1)},${camC.y.toFixed(1)} z ${camC.zoom.toFixed(1)} city ${city.x},${city.y}`);
  // building + tile
  const bld = await E(() => { const g = window.__god; for (const b of g.S.buildings.values()) if (b.done && b.type === g.Const.B.HOUSE) return b.id; return 0; });
  if (bld) { await E(id => window.__god.UI.openInspector('building', id), bld); await b.wait(300); await H.shot('12_inspector_building'); check('building sheet opens', (await E(() => window.__god.UI.inspector)).type === 'building'); }
  await E(() => window.__god.UI.openInspector('tile', 20 * window.__god.S.w + 20));
  await b.wait(300);
  await H.shot('13_inspector_tile');
  check('tile sheet opens', (await E(() => window.__god.UI.inspector)).type === 'tile');
  // live refresh: change hp of a unit, sheet text changes without rebuild
  const unitId = await E(() => { const g = window.__god; for (const u of g.S.units.values()) if (u.cityId) return u.id; return 0; });
  await E(id => window.__god.UI.openInspector('unit', id), unitId);
  await b.wait(300);
  const t0 = await E(() => document.querySelector('.bar .txt').textContent);
  await E(id => { const u = window.__god.S.units.get(id); u.hp = Math.max(1, u.hp - 5); }, unitId);
  await b.wait(700);
  const t1 = await E(() => document.querySelector('.bar .txt').textContent);
  check('inspector refreshes live (HP text changed)', t0 !== t1, `${t0} -> ${t1}`);
  // dead unit
  await E(id => window.__god.Units.kill(window.__god.S.units.get(id), 'test'), unitId);
  await b.wait(700);
  check('sheet shows a dead unit gracefully', (await E(() => document.querySelector('.sh-title small').textContent)).includes('Погиб'));
  await H.tapSel('.sh-btn:last-child');
  await b.wait(300);
  check('close button closes the sheet', (await E(() => window.__god.UI.inspector)) === null && !(await E(() => document.getElementById('bottom').classList.contains('sheet-open'))));

  section('kingdoms tab');
  await H.tapSel('.tab[data-tab="kingdoms"]');
  await b.wait(500);
  const chips = await E(() => document.querySelectorAll('.kchip').length);
  check('kingdom chips listed', chips === (await E(() => window.__god.S.kingdoms.size)), chips + ' chips');
  await H.shot('14_tab_kingdoms');
  if (chips) {
    await H.tapSel('.kchip');
    await b.wait(700);
    check('tapping a chip opens the kingdom sheet and focuses it', (await E(() => window.__god.UI.inspector)).type === 'kingdom');
    await H.shot('15_kingdom_from_chip');
    await H.tapSel('.sh-btn:last-child');
  }

  section('menu, save / load / new world');
  await H.tapSel('#btnMenu');
  await b.wait(350);
  check('menu opens', await H.exists('.m-card'));
  await H.shot('16_menu');
  const items = await E(() => [...document.querySelectorAll('.mbtn')].map(e => e.textContent));
  check('menu has save / load / new world / reset zoom / help / about', items.length === 6, items.join(' | '));
  // save page
  await E(() => { try { localStorage.clear(); } catch (e) {} });
  await H.tapSel('.mbtn:nth-child(1)');
  await b.wait(200);
  await H.shot('17_menu_save');
  const tickSaved = await E(() => window.__god.S.tick);
  await H.tapSel('.slot:nth-child(1) .btn');
  await b.wait(500);
  const sv = await E(() => ({ ex: window.__god.Save.exists('1'), info: window.__god.Save.info('1'), toast: [...document.querySelectorAll('.toast')].map(e => e.textContent) }));
  check('save to slot 1 works (toast + Save.exists)', sv.ex && sv.info && sv.info.year > 0, JSON.stringify(sv.toast));
  await H.shot('18_menu_save_done');
  // advance the world, then load slot 1 -> tick goes back
  await E(() => window.__god.step(200));
  const tickMoved = await E(() => window.__god.S.tick);
  await H.tapSel('.bk');          // back to main
  await H.tapSel('.mbtn:nth-child(2)');
  await b.wait(200);
  await H.shot('19_menu_load');
  const slotRows = await E(() => [...document.querySelectorAll('.slot')].map(e => e.textContent));
  check('load page lists auto + 3 slots with info', slotRows.length === 4 && /Год/.test(slotRows[1]), slotRows[1]);
  await H.tapSel('.slot:nth-child(2) .btn');
  await b.wait(300);
  check('load asks for confirmation', await H.exists('.m-back + .m-back'));
  await H.shot('20_confirm_load');
  await H.tapSel('.m-back:last-child .m-foot .btn:last-child');
  await b.wait(700);
  const tickLoaded = await E(() => window.__god.S.tick);
  check('load restores the saved tick', tickLoaded === tickSaved && tickMoved > tickSaved, `saved ${tickSaved}, moved ${tickMoved}, loaded ${tickLoaded}`);
  check('menu closes after loading', !(await H.exists('.m-card')));
  // reset zoom: shows the whole map
  await E(() => window.__god.Render.setCamera(40, 40, 20));
  await H.tapSel('#btnMenu'); await b.wait(300);
  await H.tapSel('.mbtn:nth-child(4)'); await b.wait(900);
  const rz = await E(() => ({ z: window.__god.Render.cam.zoom, w: window.__god.S.w, vw: innerWidth, modal: !!document.querySelector('.m-card') }));
  check('"Сброс масштаба" fits the whole map and closes the menu', rz.z * rz.w <= rz.vw + 2 && !rz.modal, `zoom ${rz.z.toFixed(2)} map ${rz.w} px-width ${(rz.z * rz.w).toFixed(0)} / ${rz.vw}`);
  await H.shot('20b_reset_zoom');
  // new world: size 64, seed 777, no population
  await H.tapSel('#btnMenu'); await b.wait(300);
  await H.tapSel('.mbtn:nth-child(3)'); await b.wait(200);
  await H.shot('21_menu_new');
  await H.tapSel('.segm button:nth-child(1)');
  await H.tapSel('.txtin');
  await b.page.keyboard.type('777');
  await H.tapSel('.check');
  await H.shot('22_menu_new_filled');
  await H.tapSel('.m-foot .btn');
  await b.wait(300);
  await H.tapSel('.m-back:last-child .m-foot .btn:last-child');
  await b.wait(900);
  const nw = await E(() => ({ w: window.__god.S.w, seed: window.__god.S.seed, units: window.__god.S.units.size, tick: window.__god.S.tick }));
  check('new world: size 64, seed 777, empty (populate off)', nw.w === 64 && nw.seed === 777 && nw.units === 0 && nw.tick < 50, JSON.stringify(nw));
  await H.shot('23_new_world_empty');
  // about
  await E(() => window.__god.UI.openMenu());
  await b.wait(250);
  await H.tapSel('.mbtn:nth-child(6)'); await b.wait(200);
  await H.shot('24_menu_about');
  await E(() => window.__god.UI.closeAllModals());
  // repopulate via menu (new world with populate default on)
  await E(() => window.__god.Main.newWorld({ seed: 11, w: 96, h: 96, populate: true }));
  await b.wait(400);

  section('log, world, help panels');
  await H.tapSel('.fab.feedfab');      // the feed defaults to «only wars & peace»; this part needs the ordinary feed («Все»), see tests/ui3.test.mjs for the filter itself
  await E(() => { window.__god.setSpeed(1); });
  await E(() => window.__god.step(700));
  await b.wait(500);
  const feedLines = await E(() => document.querySelectorAll('#feed .fl').length);
  check('event feed shows lines', feedLines > 0 && feedLines <= 4, feedLines + ' lines');
  await H.shot('25_feed');
  await H.tapSel('#feed .fl');
  await b.wait(300);
  check('tap on the feed opens the full log', await H.exists('.log-item'));
  await H.shot('26_log');
  const withPos = await E(() => { const items = [...document.querySelectorAll('.log-item')]; return items.findIndex(e => e.querySelector('canvas.go')); });
  if (withPos >= 0) {
    await E(i => window.__god.Main.setSpeed(0), 0);
    await E(() => window.__god.Render.setCamera(3, 3, 4));
    await E(i => { const e = document.querySelectorAll('.log-item')[i]; e.click(); }, withPos);
    await b.wait(900);
    const lc = await E(() => ({ ...window.__god.Render.cam, modal: !!document.querySelector('.m-card') }));
    check('log entry with coordinates focuses the camera and closes the log', lc.zoom >= 10 && !lc.modal, JSON.stringify(lc));
  } else { check('log has entries with coordinates', false, 'none found'); }
  await E(() => window.__god.UI.openWorld());
  await b.wait(350);
  await H.shot('27_world_panel');
  check('world panel opens', await H.exists('.stat-grid'));
  await E(() => window.__god.UI.closeAllModals());
  await E(() => window.__god.UI.openHelp());
  await b.wait(250);
  await H.shot('28_help');
  await E(() => window.__god.UI.closeAllModals());

  section('Main loop / robustness');
  const sp = await E(async () => { const g = window.__god; g.setSpeed(2); const t0 = g.S.tick; await new Promise(r => setTimeout(r, 2000)); const d = g.S.tick - t0; g.setSpeed(0); return d; });
  check('x2 speed advances ~40 ticks in 2 s', sp >= 25 && sp <= 55, sp + ' ticks');
  const paused = await E(async () => { const g = window.__god; g.setSpeed(0); const t0 = g.S.tick; await new Promise(r => setTimeout(r, 600)); return g.S.tick - t0; });
  check('pause stops the simulation', paused === 0);
  // autosave on hide
  await E(() => { try { localStorage.removeItem('godsim.v1.auto'); } catch (e) {} window.__god.setSpeed(1); });
  await b.wait(500);
  await E(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await b.wait(300);
  check('visibilitychange(hidden) autosaves', await E(() => window.__god.Save.exists('auto')));
  await E(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
  // reload -> boots from the autosave; corrupted autosave -> fresh world, no errors
  const keepTick = await E(() => { const g = window.__god; g.setSpeed(0); g.step(40); g.UI.openInspector('unit', [...g.S.units.values()][0].id); g.Save.save('auto'); return g.S.tick; });
  await b.page.reload(); await b.wait(1500);
  const rl = await E(() => ({ tick: window.__god.S.tick, units: window.__god.S.units.size, insp: window.__god.UI.inspector }));
  check('reload restores the world from the autosave', rl.tick >= keepTick && rl.tick < keepTick + 60 && rl.units > 0 && rl.insp === null, JSON.stringify(rl) + ' saved ' + keepTick);
  await b.page.addInitScript(() => { try { localStorage.setItem('godsim.v1.auto', 'GZ1:garbage-not-a-save'); } catch (e) {} });   // runs after pagehide wrote the good autosave
  const errsBefore = b.errors.length;
  await b.page.reload(); await b.wait(1500);
  const fresh = await E(() => ({ tick: window.__god.S.tick, units: window.__god.S.units.size, ui: window.__god.UI.ready }));
  check('corrupted autosave falls back to a new populated world', fresh.ui && fresh.tick < 60 && fresh.units > 20, JSON.stringify(fresh));
  check('...without page errors', b.errors.length === errsBefore, b.errors.slice(errsBefore).join(' || '));
  // opening the load menu while the sheet is open, then loading, closes the sheet
  await E(() => { const g = window.__god; g.setSpeed(0); g.step(30); g.Save.save('2'); g.UI.openInspector('unit', [...g.S.units.values()][0].id); });
  await E(() => window.__god.Main.worldReplaced('load'));
  check('world replacement closes the inspector and modals', await E(() => window.__god.UI.inspector === null && !document.querySelector('.m-card')));
  // error overlay
  await E(() => { setTimeout(() => { throw new Error('test boom'); }, 0); });
  await b.wait(300);
  check('uncaught error shows the dismissible overlay', await E(() => !document.getElementById('errbox').hidden && /test boom/.test(document.getElementById('errbox').textContent)));
  await H.shot('29_error_overlay');
  await H.tapSel('#errbox button');
  check('error overlay can be dismissed', await E(() => document.getElementById('errbox').hidden));
  const realErrors = b.errors.filter(e => !/test boom/.test(e));
  check('no unexpected page errors during the whole scenario', realErrors.length === 0, realErrors.slice(0, 3).join(' || '));
  await H.b.close();
}

// ======================================================================================================================
// 2. other viewports
// ======================================================================================================================
for (const [w, h, name] of [[360, 640, 'small'], [430, 932, 'big'], [320, 568, 'tiny'], [844, 390, 'landscape']]) {
  section(`viewport ${w}x${h} (${name})`);
  const H = await open(w, h);
  const { b, E } = H;
  await b.wait(1200);
  await E(() => { window.__god.setSpeed(0); window.__god.step(1200); });
  await H.frames(4);
  const lay = await E(() => {
    const r = id => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
    return { top: r('top'), dock: r('dock'), fabs: r('fabs'), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth };
  });
  check('top bar fits the width', lay.top.l >= 0 && lay.top.r <= w, JSON.stringify(lay.top));
  check('no horizontal overflow', lay.sw <= lay.cw);
  const overflow = await E(() => { const o = []; for (const sel of ['#top .top-row', '#counters', '#speeds', '#tabs', '#ctx']) { const e = document.querySelector(sel); if (e && e.scrollWidth > e.clientWidth + 1) o.push(sel + ' ' + e.scrollWidth + '>' + e.clientWidth); } return o; });
  check('no clipped top / tab / ctx rows', overflow.length === 0, overflow.join('; '));
  await H.shot(`30_${name}_powers`);
  await H.tapSel('.tab[data-tab="land"]'); await H.tapSel('#tools .tool[data-tool="mountain"]');
  await H.shot(`30_${name}_land`);
  await H.tapSel('.tab[data-tab="kingdoms"]'); await b.wait(300);
  await H.shot(`30_${name}_kingdoms`);
  const kid = await E(() => { const k = [...window.__god.S.kingdoms.values()][0]; return k && k.id; });
  if (kid) { await E(id => window.__god.UI.openInspector('kingdom', id, { focus: true }), kid); await b.wait(600); await H.shot(`30_${name}_inspector`); const sh = await E(() => { const s = document.getElementById('sheet').getBoundingClientRect(); return s.height / innerHeight; }); check('sheet <= 55% height (' + name + ')', sh <= 0.551 || name === 'landscape', sh.toFixed(2)); }
  await E(() => { window.__god.UI.closeInspector(); window.__god.UI.openMenu(); });
  await b.wait(300);
  await H.shot(`30_${name}_menu`);
  const mc = await E(() => { const c = document.querySelector('.m-card').getBoundingClientRect(); return [c.top, c.bottom, innerHeight]; });
  check('menu card fits the screen (' + name + ')', mc[0] >= 0 && mc[1] <= mc[2] + 1, mc.map(Math.round).join(','));
  check('no page errors (' + name + ')', b.errors.length === 0, b.errors[0] || '');
  await b.close();
}

// ======================================================================================================================
// 3. FPS with ~300 units
// ======================================================================================================================
if (!args.nofps) {
  section('FPS (390x844, ~300 units)');
  const H = await open(390, 844);
  const { b, E } = H;
  await b.wait(1000);
  await E(() => {
    const g = window.__god;
    g.setSpeed(0);
    g.step(800);
    let guard = 0;
    while (g.S.units.size < 300 && guard++ < 6000) {
      const x = g.R.i(g.S.w), y = g.R.i(g.S.h);
      if (g.S.tile[y * g.S.w + x] === g.Const.T.GRASS) g.Units.spawn(g.R.i(3), x + 0.5, y + 0.5, {});
    }
  });
  const units = await E(() => window.__god.S.units.size);
  console.log('  units:', units);
  for (const sp of [1, 4]) {
    await E(s => window.__god.setSpeed(s), sp);
    await b.wait(1500);
    const t0 = await E(() => window.__god.S.tick);
    const fps = await b.fps(5000);
    const t1 = await E(() => window.__god.S.tick);
    const st = await E(() => ({ stepMs: window.__god.S.perf.stepMs, drawMs: window.__god.Render.stats.drawMs, frameMs: window.__god.stats.frameMs, think: window.__god.S.perf.thinkEvery, units: window.__god.S.units.size }));
    console.log(`  x${sp}: ${fps.fps.toFixed(1)} fps (avg ${fps.avg.toFixed(1)} ms, p95 ${fps.p95.toFixed(1)} ms, max ${fps.max.toFixed(1)} ms), ${((t1 - t0) / 5).toFixed(1)} ticks/s, sim ${st.stepMs.toFixed(2)} ms/tick, draw ${st.drawMs} ms, frame cpu ${st.frameMs.toFixed(1)} ms, units ${st.units}`);
    check(`x${sp}: >= 20 fps with ${units} units (software rendering)`, fps.fps >= 20, fps.fps.toFixed(1));
    check(`x${sp}: tick rate close to ${10 * sp}/s`, (t1 - t0) / 5 >= 10 * sp * 0.7, ((t1 - t0) / 5).toFixed(1));
  }
  await H.shot('31_fps_scene');
  check('no page errors during the FPS run', b.errors.length === 0, b.errors[0] || '');
  await b.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
console.log('screenshots in ' + SHOTS);
