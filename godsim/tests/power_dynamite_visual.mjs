// Dynamite («Динамит») — browser integration + visual test (Playwright, headless Chromium, iPhone 390x844 @2x).
//   node tests/power_dynamite_visual.mjs [--shots=/tmp/godsim-dynamite-shots] [--seed=4] [--zooms=8,14,24] [--perf] [--nobuild]
// Builds the REAL game (plus tests/fixtures/dynamite_probe.js) into /tmp/godsim-dynamite.html (never index.html), then:
//   1. dock: tool button «Динамит» in the Силы tab with a drawn icon, group label «Арсенал», hint, brush slider
//   2. real touches: a tap (pan mode) and a finger drag (brush mode) through UI -> Input -> Powers lay charges, toast «Динамит заложен»
//   3. a staged scene (village, forest, mountain with ore, units) at zoom 8 / 14 / 24: laid, fuse, armed ring, bang frames, chain, aftermath, scars
//      (Fx are aged by hand at x1 pace so every screenshot is deterministic; PNGs + montages land in --shots, LOOK at them)
//   4. --perf: draw cost (Render.stats.drawMs) at zoom 8 / 14 on a 1500-unit world with 80 live charges, armed rings, 12 live blast Fx: budget <= 0.5 ms
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const SHOTS = String(args.shots || '/tmp/godsim-dynamite-shots'), SEED = +(args.seed || 4), ZOOMS = String(args.zooms || '8,14,24').split(',').map(Number);
const HTML = '/tmp/godsim-dynamite.html';
fs.mkdirSync(SHOTS, { recursive: true });
if (!args.nobuild) execFileSync('node', [path.join(root, 'build.mjs'), '--out=' + HTML, '--extra=tests/fixtures/dynamite_probe.js', '--check'], { cwd: root, stdio: 'pipe' });

let pass = 0, fail = 0;
const check = (name, cond, info) => { if (cond) { pass++; console.log('  ok   ' + name + (info !== undefined ? '  (' + info + ')' : '')); } else { fail++; console.log('  FAIL ' + name + (info !== undefined ? '  (' + info + ')' : '')); } };

const b = await launch({ url: 'file://' + HTML, width: 390, height: 844, dpr: 2 });
const E = (fn, arg) => b.eval(fn, arg);
for (let i = 0; i < 100; i++) { if (await E(() => !!(window.__god && window.__dynProbe && document.querySelector('.tab')))) break; await b.sleep(100); }
await b.sleep(900);

// ------------------------------------------------------------------ page-side helpers
await E(() => {
  const g = window.__god, S = g.S, T = g.Const.T, B = g.Const.B, RES = g.Const.RES;
  const T0 = { fx: null };
  window.__fxFreeze = (on) => { if (on && !T0.fx) { T0.fx = g.Fx.update; g.Fx.update = () => {}; } else if (!on && T0.fx) { g.Fx.update = T0.fx; T0.fx = null; } };
  /** advance n sim ticks at x1 pace: every tick ages the Fx by 0.1 s (what Main does at speed 1) */
  window.__adv = (n) => { const upd = T0.fx || g.Fx.update; for (let i = 0; i < n; i++) { g.step(1); upd.call(g.Fx, 0.1); } return g.S.tick; };
  window.__stage = () => {
    const W = S.w, N = 33;
    let best = null, bs = 1e18;
    for (let y0 = 4; y0 <= S.h - N - 4; y0 += 2) for (let x0 = 4; x0 <= S.w - N - 4; x0 += 2) {
      let water = 0;
      for (let y = y0; y < y0 + N; y += 3) for (let x = x0; x < x0 + N; x += 3) { const t = S.tile[y * W + x]; if (t === T.DEEP || t === T.SHALLOW || t === T.LAVA) water++; }
      const sc = water * 1000 + Math.hypot(x0 + N / 2 - W / 2, y0 + N / 2 - S.h / 2);
      if (sc < bs) { bs = sc; best = [x0, y0]; }
    }
    const cx = best[0] + (N >> 1), cy = best[1] + (N >> 1);
    for (const c of [...S.cities.values()]) if (Math.hypot(c.x - cx, c.y - cy) < 24) g.Cities.destroy(c.id, 'stage');       // a clean arena: no other village within reach
    g.Units.eraseInRadius(cx, cy, 30);
    for (let y = best[1]; y < best[1] + N; y++) for (let x = best[0]; x < best[0] + N; x++) {
      const i = y * W + x;
      if (S.bld[i]) g.Buildings.destroyAt(x, y, 'stage');
      S.fire[i] = 0; S.res[i] = 0; S.amt[i] = 0;
      g.World.setTile(x, y, T.GRASS, { elev: 134 });
    }
    // forest on the west side, rocks / mountain / snow on the east side
    for (let y = cy - 5; y <= cy + 4; y++) for (let x = cx - 17; x <= cx - 11; x++) g.World.setTile(x, y, T.FOREST);
    for (let y = cy - 7; y <= cy + 2; y++) for (let x = cx + 7; x <= cx + 14; x++) {
      const dx = x - (cx + 10.5), dy = y - (cy - 2.5), d = Math.hypot(dx, dy);
      g.World.setTile(x, y, d < 1.3 ? T.SNOW : d < 3.2 ? T.MOUNTAIN : T.HILL);
    }
    const ore = (x, y, k, a) => { S.res[y * W + x] = k; S.amt[y * W + x] = a; };
    ore(cx + 7, cy - 4, RES.ROCK, 120); ore(cx + 7, cy - 2, RES.IRON, 100); ore(cx + 8, cy - 3, RES.GOLD, 60); ore(cx + 8, cy - 1, RES.ROCK, 90);
    // a village in the middle
    const founders = [];
    for (let i = 0; i < 6; i++) { const u = g.Units.spawn(0, cx + 0.5 + (i - 2.5) * 0.5, cy + 1.6, { sex: i & 1 }); if (u) founders.push(u); }
    const city = g.Cities.found(0, cx, cy, founders);
    const houses = [[-4, -2], [-2, -3], [2, -3], [4, -1], [-5, 1], [-3, 3], [1, 3], [3, 2], [-1, 5], [5, 4], [0, -5]];
    let placed = 0;
    if (city) for (const [dx, dy] of houses) if (g.Buildings.place(city.id, dy > 3 ? B.FARM : B.HOUSE, cx + dx, cy + dy, { instant: true })) placed++;
    for (let i = 0; i < 12; i++) { const u = g.Units.spawn(i % 5 === 4 ? 1 : 0, cx + 0.5 + ((i * 7) % 11) - 5, cy + 0.5 + ((i * 5) % 9) - 4, { cityId: city ? city.id : 0, age: 22 }); if (u) { u.state = 'idle'; u.st = { ph: '', since: S.tick, until: S.tick + 100000 }; } }
    g.Fx.list.length = 0; S.eff.dynamite = []; S.eff.dynamite_scars = [];
    return { cx, cy, city: city ? city.id : 0, houses: placed, units: S.units.size, tick: S.tick };
  };
  window.__view = (x, y, zoom) => { g.UI.focusVisible(x, y, zoom, true); };
  window.__scene = () => ({ buildings: S.buildings.size, units: S.units.size, live: S.eff.dynamite.length, scars: S.eff.dynamite_scars.length, fx: g.Fx.list.length, forest: (() => { let n = 0; for (let i = 0; i < S.tile.length; i++) if (S.tile[i] === T.FOREST) n++; return n; })(),
    fires: g.World.fireCount(), log: S.log.slice(-4).map(l => l.msg), stock: S.cities.size ? [...S.cities.values()][0].stock : null });
});

// ------------------------------------------------------------------ 0. world
const world = await E(async (seed) => {
  const g = window.__god;
  g.Main.newWorld({ seed, w: 96, h: 96, populate: true }); g.setSpeed(0);
  for (let i = 0; i < 6; i++) { g.step(100); await new Promise(r => setTimeout(r, 0)); }
  return { tick: g.S.tick, units: g.S.units.size };
}, SEED);
console.log('world', JSON.stringify(world));

// ------------------------------------------------------------------ 1. dock
await E(() => window.__god.UI.selectTab('powers'));
await b.sleep(300);
const dock = await E(() => {
  const btn = document.querySelector('.tool[data-tool="dynamite"]');
  if (!btn) return null;
  btn.scrollIntoView({ inline: 'center', block: 'nearest' });
  const cv = btn.querySelector('canvas'); let lit = 0, red = 0;
  if (cv) { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) { lit++; if (d[i] > 180 && d[i + 1] < 110) red++; } }
  const r = btn.getBoundingClientRect();
  return { label: btn.textContent.trim(), lit, red, groups: [...document.querySelectorAll('.grp-lbl')].map(x => x.textContent.trim()), rect: [r.left, r.top, r.width, r.height], canvasPx: cv ? cv.width : 0 };
});
console.log('dock', JSON.stringify(dock));
check('tool button «Динамит» in the Силы tab with a drawn red icon', !!dock && dock.label === 'Динамит' && dock.lit > 100 && dock.red > 20, JSON.stringify(dock && { label: dock.label, lit: dock.lit, red: dock.red }));
check('group label «Арсенал» sits between «Разрушение» and «Благословение»', !!dock && dock.groups.join('|') === 'Разрушение|Арсенал|Благословение', dock && dock.groups.join('|'));
await E(() => window.__god.UI.selectTool('dynamite'));
await b.sleep(250);
await b.shot(SHOTS + '/01_dock.png', { clip: { x: 0, y: 674, width: 390, height: 170 } });
const hint = await E(() => ({ hint: document.querySelector('#hint, .hint') ? (document.querySelector('#hint, .hint').textContent || '') : '', brush: !document.querySelector('.brush, #brushbox') || !document.querySelector('.brush, #brushbox').classList.contains('hide') }));
check('hint line explains the tool', /Динамит/.test(hint.hint) && /заряд/.test(hint.hint), hint.hint);

// ------------------------------------------------------------------ 2. real touches (tap in pan mode, finger drag in brush mode)
const st0 = await E(() => window.__stage());
console.log('stage', JSON.stringify(st0));
await E(({ cx, cy }) => { window.__view(cx + 0.5, cy + 0.5, 14); window.__god.UI.setBrush(3); }, st0);
await b.sleep(400);
const scr = (tx, ty) => E(([x, y]) => window.__god.Render.tileToScreen(x, y), [tx, ty]);
let p = await scr(st0.cx - 8.5, st0.cy + 8.5);
await b.tap(p.x, p.y);
await b.sleep(250);
let r1 = await E(() => ({ live: window.__god.S.eff.dynamite.map(c => ({ x: c.x, y: c.y, r: c.r })), toast: [...document.querySelectorAll('.toast')].map(t => t.textContent) }));
check('a tap (hand mode) lays one bundle of the brush size and shows the toast «Динамит заложен»', r1.live.length === 1 && r1.live[0].r === 3 && r1.toast.some(t => t === 'Динамит заложен'), JSON.stringify(r1));
await E(() => window.__god.UI.setMode('paint', false));
await b.sleep(200);
const a0 = await scr(st0.cx - 6, st0.cy + 6.5), a1 = await scr(st0.cx + 6, st0.cy + 6.5);
await b.drag(a0.x, a0.y, a1.x, a1.y, 30, 16);
await b.sleep(200);
let r2 = await E(() => ({ n: window.__god.S.eff.dynamite.length, groups: new Set(window.__god.S.eff.dynamite.map(c => c.g)).size, wired: window.__god.S.eff.dynamite.filter(c => c.pv > 0).length }));
check('a finger drag (brush mode) lays a wired line of charges (12 tiles ~ 9-10 charges, one stroke)', r2.n >= 9 && r2.n <= 13 && r2.groups === 2 && r2.wired >= 8, JSON.stringify(r2));
await b.shot(SHOTS + '/02_touch_laid.png');
await E(() => window.__god.UI.setMode('pan', false));

// ------------------------------------------------------------------ 3. staged scenes
async function crop(file, cx, cy, hCss = 430) {
  const q = await scr(cx, cy);
  const y = Math.max(0, Math.min(844 - hCss, Math.round(q.y - hCss / 2)));
  await b.shot(file, { clip: { x: 0, y, width: 390, height: hCss } });
  return file;
}
async function montage(files, out, cols = 2, scale = 1) {
  const imgs = files.map(f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'));
  const pg = await b.ctx.newPage();
  await pg.setViewportSize({ width: 10, height: 10 });
  await pg.setContent('<body style="margin:0;background:#101018"><div id="g" style="display:grid;gap:6px;padding:6px;grid-template-columns:repeat(' + cols + ',auto);width:max-content">' + imgs.map(s => '<img src="' + s + '" style="display:block;image-rendering:pixelated;width:' + (780 * scale) + 'px">').join('') + '</div></body>');
  await pg.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
  const box = await pg.evaluate(() => { const r = document.getElementById('g').getBoundingClientRect(); return { w: Math.ceil(r.width) + 12, h: Math.ceil(r.height) + 12 }; });
  await pg.setViewportSize({ width: box.w, height: box.h });
  await pg.screenshot({ path: out });
  await pg.close();
  return out;
}

const probe = () => E(() => JSON.parse(JSON.stringify(window.__dynProbe.stats)));
const lineScene = {};
for (const Z of ZOOMS) {
  const st = await E(() => window.__stage());
  const { cx, cy } = st;
  await E(({ cx, cy, Z }) => { window.__view(cx + 0.5, cy + 0.5, Z); window.__fxFreeze(true); window.__god.Render.setMode(0); }, { cx, cy, Z });
  const T0 = await E(() => window.__god.S.tick);
  // a wired line through the village (r=3), plus a big single bomb (r=8) south of it
  await E(({ cx, cy }) => {
    const P = window.__god.Powers;
    P.apply('dynamite', cx - 7.5, cy + 0.5, 3, 'start');
    for (let k = 1; k <= 26; k++) P.apply('dynamite', cx - 7.5 + k * 0.5, cy + 0.5 + Math.sin(k * 0.35) * 0.7, 3, 'move');
    P.apply('dynamite', cx + 5.5, cy + 0.5, 3, 'end');
    P.apply('dynamite', cx + 0.5, cy + 9.5, 8, 'tap');
  }, { cx, cy });
  const n0 = await E(() => window.__scene());
  await b.sleep(250);
  const f = {};
  const shot = async (name) => { await b.sleep(170); f[name] = await crop(`${SHOTS}/z${Z}_${name}.png`, cx + 0.5, cy + 1.5, Z >= 24 ? 520 : Z >= 14 ? 480 : 380); };
  await shot('1_laid');
  await E(() => window.__adv(14)); await shot('2_fuse');
  await E(() => window.__adv(10)); await shot('3_armed');            // 24 ticks in: the head has 6 ticks left
  await E(() => window.__adv(6));                                       // tick +30: the head and the big bomb go off
  await E(() => { for (const fx of window.__god.Fx.list) if (fx.type === 'dyn_blast') fx.age = fx.ttl * 0.04; });
  await shot('4_bang_a');
  await E(() => { for (const fx of window.__god.Fx.list) if (fx.type === 'dyn_blast') fx.age = fx.ttl * 0.16; });
  await shot('5_bang_b');
  await E(() => { for (const fx of window.__god.Fx.list) if (fx.type === 'dyn_blast') fx.age = fx.ttl * 0.36; });
  await shot('6_bang_c');
  await E(() => window.__adv(6)); await shot('7_chain_a');
  await E(() => window.__adv(7)); await shot('8_chain_b');
  const mid = await probe();
  await E(() => window.__adv(60));
  await shot('9_chain_end');
  await E(() => window.__adv(40));
  await E(() => { for (const fx of window.__god.Fx.list) fx.age = Math.max(fx.age, fx.ttl); window.__god.Fx.list.length = 0; });
  await shot('10_aftermath');
  const n1 = await E(() => window.__scene());
  lineScene[Z] = { n0, n1, mid };
  await E(() => window.__fxFreeze(false));
  await montage([f['1_laid'], f['3_armed'], f['4_bang_a'], f['6_bang_c'], f['7_chain_a'], f['10_aftermath']], `${SHOTS}/z${Z}_montage.png`, 2, 1);
  console.log(`zoom ${Z}: before ${JSON.stringify(n0)}\n         after  ${JSON.stringify(n1)}`);
  check(`zoom ${Z}: the scene ran its course (charges gone, scars left, buildings razed, no stuck state)`, n1.live === 0 && n1.scars >= 10 && n1.buildings < n0.buildings && n1.fx === 0, JSON.stringify({ live: n1.live, scars: n1.scars, buildings: [n0.buildings, n1.buildings] }));
}

// forest + quarry (zoom 14)
{
  const st = await E(() => window.__stage());
  const { cx, cy } = st;
  await E(({ cx, cy }) => { window.__view(cx - 11, cy - 1, 14); window.__fxFreeze(true); }, { cx, cy });
  await E(({ cx, cy }) => { const P = window.__god.Powers; P.apply('dynamite', cx - 14.5, cy - 0.5, 8, 'tap'); P.apply('dynamite', cx + 8.5, cy - 3.5, 5, 'tap'); }, { cx, cy });
  const s0 = await E(() => window.__scene());
  await E(() => window.__adv(31));
  await E(() => { for (const fx of window.__god.Fx.list) fx.age = fx.ttl * 0.3; });
  await b.sleep(200);
  const fa = await crop(SHOTS + '/f14_forest_bang.png', cx - 12, cy - 0.5, 480);
  await E(() => window.__adv(50));
  await E(() => { window.__god.Fx.list.length = 0; });
  await b.sleep(250);
  const fb = await crop(SHOTS + '/f14_forest_after.png', cx - 12, cy - 0.5, 480);
  await E(({ cx, cy }) => { window.__view(cx + 8, cy - 2.5, 14); }, { cx, cy });
  await b.sleep(250);
  const fc = await crop(SHOTS + '/f14_quarry_after.png', cx + 9, cy - 2.5, 480);
  const s1 = await E(() => window.__scene());
  console.log('forest/quarry: ' + JSON.stringify(s0) + ' -> ' + JSON.stringify(s1));
  check('forest bomb fells the forest, quarry bomb turns rock into hills and pays the city (stone / iron / gold)', s1.forest < s0.forest - 10 && s1.stock && (s1.stock.stone > (s0.stock ? s0.stock.stone : 0) || s1.stock.iron > (s0.stock ? s0.stock.iron : 0)), JSON.stringify({ forest: [s0.forest, s1.forest], stock0: s0.stock, stock1: s1.stock }));
  await montage([fa, fb, fc], SHOTS + '/f14_montage.png', 3, 0.7);
  await E(() => window.__fxFreeze(false));
}

// ------------------------------------------------------------------ 4. counters + errors
const stats = await probe();
console.log('draw counters', JSON.stringify(stats));
check('icon, bundles, wires, armed rings, scars and blasts were all drawn by the plugin', stats.icon > 0 && stats.bundles > 0 && stats.wires > 0 && stats.rings > 0 && stats.scars > 0 && stats.blasts > 0, JSON.stringify(stats));
check('no page errors', b.errors.length === 0, b.errors.join(' | ').slice(0, 300));

// ------------------------------------------------------------------ 5. draw cost (--perf)
if (args.perf) {
  console.log('# perf: 1500 units, 80 live charges, armed rings, 12 live blast Fx');
  const setup = await E(async (seed) => {
    const g = window.__god;
    g.Main.newWorld({ seed, w: 96, h: 96, populate: true }); g.setSpeed(0);
    let guard = 0;
    while (g.S.units.size < 1450 && g.S.tick < 30000 && guard++ < 400) { g.step(100); await new Promise(r => setTimeout(r, 0)); }
    return { tick: g.S.tick, units: g.S.units.size };
  }, SEED);
  console.log('world', JSON.stringify(setup));
  const measure = (n = 180) => E((n) => new Promise(res => { let i = 0, sum = 0, worst = 0; function f() { const d = window.__god.Render.stats.drawMs || 0; sum += d; if (d > worst) worst = d; if (++i < n) requestAnimationFrame(f); else res({ avg: sum / i, worst }); } requestAnimationFrame(f); }), n);
  for (const Z of [8, 14]) {
    await E((Z) => { const g = window.__god; const c = g.Main.largestSettlement() || { x: 48, y: 48 }; g.Render.setMode(0); g.Render.setCamera(c.x, c.y, Z); g.S.eff.dynamite = []; g.S.eff.dynamite_scars = []; g.Fx.list.length = 0; window.__fxFreeze(true); }, Z);
    await b.sleep(1200);
    const base = await measure();
    // 80 live charges (4 strokes of 20) in view, fuses far away (not armed), then all armed
    await E(() => {
      const g = window.__god, r = g.Render.visibleRect(), L = []; let id = 1;
      for (let s = 0; s < 4; s++) for (let k = 0; k < 20; k++) {
        const x = r.x0 + 2 + ((k * 1.3 + s * 3) % Math.max(4, r.x1 - r.x0 - 4)), y = r.y0 + 6 + s * Math.max(3, (r.y1 - r.y0 - 12) / 4) + (k % 2);
        L.push({ id: id, x, y, r: 2 + ((k + s) % 7), t0: g.S.tick, boom: g.S.tick + 100000, g: 10 + s, pv: k ? id - 1 : 0, wx: k ? L[L.length - 1].x : 0, wy: k ? L[L.length - 1].y : 0 }); id++;
      }
      g.S.eff.dynamite = L;
      for (let i = 0; i < 200; i++) g.S.eff.dynamite_scars.push({ x: r.x0 + 2 + (i * 7.3) % Math.max(4, r.x1 - r.x0 - 4), y: r.y0 + 2 + (i * 3.1) % Math.max(4, r.y1 - r.y0 - 4), r: 2.4 + (i % 5) * 0.6, t0: g.S.tick });
      g.S.eff.dynamite_scars.length = 56;
    });
    await b.sleep(900);
    const live = await measure();
    await E(() => { const g = window.__god; for (const c of g.S.eff.dynamite) c.boom = g.S.tick + 9; });
    await b.sleep(500);
    const armed = await measure();
    await E(() => {
      const g = window.__god, r = g.Render.visibleRect();
      window.__blastLoad = true;
      (function loop() {
        if (!window.__blastLoad) return;
        const F = g.Fx.list; for (let i = F.length - 1; i >= 0; i--) if (F[i].type === 'dyn_blast') F.splice(i, 1);
        for (let k = 0; k < 12; k++) F.push({ type: 'dyn_blast', x: r.x0 + 3 + (k * 4.1) % Math.max(4, r.x1 - r.x0 - 6), y: r.y0 + 4 + (k * 5.3) % Math.max(4, r.y1 - r.y0 - 8), ttl: 1.2, age: ((performance.now() / 1000) + k * 0.1) % 1.2, r: 2 + (k % 4) * 0.9, v: k & 1, _s: k * 7 });
        requestAnimationFrame(loop);
      })();
    });
    await b.sleep(1500);
    const blasts = await measure();
    await E(() => { window.__blastLoad = false; window.__god.Fx.list.length = 0; });
    const dLive = live.avg - base.avg, dArmed = armed.avg - base.avg, dBlast = blasts.avg - armed.avg;
    console.log(`zoom ${Z}: base ${base.avg.toFixed(2)} ms | +80 charges + 56 scars ${live.avg.toFixed(2)} (+${dLive.toFixed(2)}) | all armed (rings) ${armed.avg.toFixed(2)} (+${dArmed.toFixed(2)}) | + 12 blast Fx ${blasts.avg.toFixed(2)} (+${dBlast.toFixed(2)}, worst ${blasts.worst.toFixed(1)})`);
    check(`zoom ${Z}: 80 live charges (+ wires, 56 scars) cost <= 0.5 ms per frame`, dLive <= 0.5, dLive.toFixed(2) + ' ms');
    check(`zoom ${Z}: 80 armed charges (rings) cost <= 0.8 ms per frame`, dArmed <= 0.8, dArmed.toFixed(2) + ' ms');
    check(`zoom ${Z}: 12 live baked blast Fx cost <= 0.5 ms per frame`, dBlast <= 0.5, dBlast.toFixed(2) + ' ms');
    await E(() => { const g = window.__god; g.S.eff.dynamite = []; g.S.eff.dynamite_scars = []; window.__fxFreeze(false); });
  }
  check('no page errors during the perf run', b.errors.length === 0, b.errors.join(' | ').slice(0, 300));
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
