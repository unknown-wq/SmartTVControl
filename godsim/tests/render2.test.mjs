// Render stage 2 (political map + war overlays, CONTRACT section 8.4) browser test.
//   node tests/render2.test.mjs [--shots=/tmp/godsim-render2-shots] [--only=a,b]
// Builds a HERMETIC page: only the files this test needs (core 00-03, World 04, Sprites / Render / Input from the working tree,
// every other module is a no-op stub) + tests/boot_render2.js, which fabricates regions, kingdoms, cities, wars and armies from the
// CONTRACT data layout, so the test does not depend on the Regions / War / Kingdoms modules other agents are writing.
// Drives headless Chromium with iPhone emulation (390x844 @2x), checks pixels, caches, picking, arrows, banners, performance,
// and writes screenshots to review with an image viewer.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const SHOTS = args.shots || '/tmp/godsim-render2-shots';
const only = args.only ? String(args.only).split(',') : null;
fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- hermetic build
const BUILD_DIR = '/tmp/godsim-render2-build';
const HTML = '/tmp/godsim-render2.html';
fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(BUILD_DIR, 'src'), { recursive: true });
for (const f of ['00_core.js', '01_tiles.js', '02_data.js', '03_names.js', '04_world.js', '20_sprites.js', '21_render.js', '22_input.js', 'template.html', 'style.css']) fs.copyFileSync(path.join(root, 'src', f), path.join(BUILD_DIR, 'src', f));
fs.copyFileSync(path.join(root, 'build.mjs'), path.join(BUILD_DIR, 'build.mjs'));
execFileSync('node', [path.join(BUILD_DIR, 'build.mjs'), '--stubs', '--no-main', '--extra=' + path.join(root, 'tests/boot_render2.js'), `--out=${HTML}`], { cwd: BUILD_DIR, stdio: 'pipe' });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ok   ' + name + (info !== undefined ? '  (' + info + ')' : '')); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (info !== undefined ? '  (' + info + ')' : '')); }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const section = s => console.log('\n# ' + s);
const want = name => !only || only.includes(name);

// ---------------------------------------------------------------- page helpers
async function open(query, opts = {}) {
  const b = await launch({ url: 'file://' + HTML + '?' + query, verbose: true, ...opts });
  await b.wait(1100);
  const E = (fn, arg) => b.eval(fn, arg);
  const h = {
    b, E, sleep: b.sleep,
    frames: n => E(n => new Promise(r => { let k = 0; const f = () => { if (++k >= n) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n),
    cam: (x, y, z) => E(([x, y, z]) => window.__r2.Render.setCamera(x, y, z), [x, y, z]),
    mode: m => E(m => window.__r2.Render.setMode(m), m),
    dbg: () => E(() => window.__r2.Render.debugInfo()),
    pol: () => E(() => window.__r2.Render.debugInfo().political),
    shot: async name => { const f = path.join(SHOTS, name + '.png'); await b.shot(f); return f; },
    /** mean colour of a small box around css point (x,y) */
    px: (x, y, r = 2) => E(([x, y, r]) => {
      const c = window.__r2.Render.canvas, g = c.getContext('2d'), d = window.__r2.Render.size.dpr, n = Math.round(r * d) * 2 + 1;
      const a = g.getImageData(Math.round(x * d) - Math.round(r * d), Math.round(y * d) - Math.round(r * d), n, n).data;
      let R = 0, G = 0, B = 0, k = 0; for (let i = 0; i < a.length; i += 4) { R += a[i]; G += a[i + 1]; B += a[i + 2]; k++; }
      return [Math.round(R / k), Math.round(G / k), Math.round(B / k)];
    }, [x, y, r]),
    /** count pixels matching `test` (source string of (r,g,b)=>bool) inside a css-px rectangle */
    count: (x0, y0, w, hh, test) => E(([x0, y0, w, hh, src]) => {
      const f = new Function('r', 'g', 'b', 'return (' + src + ')'), c = window.__r2.Render.canvas, g = c.getContext('2d'), d = window.__r2.Render.size.dpr;
      const X = Math.max(0, Math.round(x0 * d)), Y = Math.max(0, Math.round(y0 * d));
      const a = g.getImageData(X, Y, Math.min(c.width - X, Math.round(w * d)), Math.min(c.height - Y, Math.round(hh * d))).data;
      let n = 0; for (let i = 0; i < a.length; i += 4) if (f(a[i], a[i + 1], a[i + 2])) n++;
      return n;
    }, [x0, y0, w, hh, test]),
    tile2s: (x, y) => E(([x, y]) => window.__r2.Render.tileToScreen(x, y), [x, y]),
  };
  return h;
}
const dist3 = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
const hexRgb = s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

// ---------------------------------------------------------------- icons
if (want('icons')) {
  section('new icons (contact sheet)');
  const h = await open('view=icons', { width: 800, height: 520, dpr: 1 });
  const sh = await h.E(() => window.__r2.sheet);
  const NEW = 'command region army shield arrow star supply war flag_goal handshake'.split(' ');
  check('all 10 new icon keys are known to Sprites.iconKeys()', NEW.every(k => sh.known.includes(k)), NEW.filter(k => !sh.known.includes(k)).join(',') || 'ok');
  await h.b.page.setViewportSize({ width: sh.w, height: sh.h });
  await h.sleep(100);
  await h.b.shot(path.join(SHOTS, '00_icons.png'), { clip: { x: 0, y: 0, width: sh.w, height: sh.h } });
  // every icon cell must contain opaque, non-background pixels: sample the 96px render of each key
  const cells = await h.E(() => {
    const c = document.querySelector('canvas'), g = c.getContext('2d'), keys = window.__r2.sheet.keys, out = {};
    keys.forEach((k, i) => {
      const X = 10 + (i % 5) * 152, Y = 10 + ((i / 5) | 0) * 150, a = g.getImageData(X + 4, Y + 4, 96, 96).data;
      let n = 0, colours = new Set();
      for (let j = 0; j < a.length; j += 4) if (Math.abs(a[j] - 0x3a) + Math.abs(a[j + 1] - 0x45) + Math.abs(a[j + 2] - 0x60) > 24) { n++; colours.add((a[j] >> 4) + ',' + (a[j + 1] >> 4) + ',' + (a[j + 2] >> 4)); }
      out[k] = { n, colours: colours.size };
    });
    return out;
  });
  check('every new icon draws a real glyph (>= 700 px of 96x96, >= 3 colours)', NEW.every(k => cells[k].n >= 700 && cells[k].colours >= 3), NEW.map(k => k + ':' + cells[k].n).join(' '));
  check('no console errors', h.b.errors.length === 0, h.b.errors[0] || '');
  await h.b.close();
}

// ---------------------------------------------------------------- main scenario
const h = await open('still=1&seed=11');
const { E, b } = h;
const info = await E(() => { const r = window.__r2; return { regions: r.regions.length, kingdoms: r.kingdoms.length, armies: r.armies.length, wars: r.wars.length, cities: r.cities.length, cmd: r.cmdKid, size: r.Render.size, units: r.units.length, ready: window.__r2Ready }; });
section('boot');
check('fabricated world: >= 30 regions, 4 kingdoms, 2 wars, >= 8 armies', info.regions >= 30 && info.kingdoms === 4 && info.wars === 2 && info.armies >= 8, JSON.stringify({ regions: info.regions, armies: info.armies, cities: info.cities }));
check('no console errors during boot', b.errors.length === 0, b.errors[0] || '');
const sc = await E(() => {
  const s = window.__r2.scen;
  return { g1: s.g1.id, g2: s.g2.id, g1c: [s.g1.cx + 0.5, s.g1.cy + 0.5], g2c: [s.g2.cx + 0.5, s.g2.cy + 0.5], A: s.A.id, D: s.D.id, a1: s.a1.id, a2: s.a2.id, a3: s.a3.id, d1: s.d1.id, d2: s.d2.id, extra: s.extra && s.extra.id, counter: s.counter && s.counter.id, ac: s.A.color, dc: s.D.color };
});
const front = { x: (sc.g1c[0] + sc.g2c[0]) / 2, y: (sc.g1c[1] + sc.g2c[1]) / 2 };

// --------------------------------------------------------------- screenshots at three zoom levels
if (want('shots')) {
  section('screenshots (political map)');
  await h.mode(1);
  await h.cam(48, 48, 4.063); await h.frames(3); await h.shot('01_borders_overview_z4');
  await h.cam(front.x, front.y, 9); await h.frames(3); await h.shot('02_borders_front_z9');
  await h.cam(front.x, front.y, 16); await h.frames(3); await h.shot('03_borders_front_z16');
  await E(id => { window.__r2.Render.cmd.armyId = id; }, sc.a1);
  await h.cam(front.x, front.y, 12); await h.frames(3); await h.shot('04_borders_selected_army_z12');
  await E(() => { window.__r2.Render.cmd.armyId = 0; });
  await E(() => { window.__r2.Render.showAllOrders = true; });
  await h.cam(48, 48, 4.063); await h.frames(3); await h.shot('04b_borders_show_all_orders_overview');
  await E(() => { window.__r2.Render.showAllOrders = false; });
  await h.mode(2); await h.cam(48, 48, 4.063); await h.frames(3); await h.shot('05_culture_overview');
  await h.cam(front.x, front.y, 9); await h.frames(3); await h.shot('06_culture_front_z9');
  await h.mode(0); await h.cam(front.x, front.y, 9); await h.frames(3); await h.shot('07_normal_with_banners_z9');
  check('screenshots written', true);
}

// --------------------------------------------------------------- political fill / outlines / stripes / fronts
if (want('political')) {
  section('political map: fill, outlines, thin lines, stripes, fronts');
  // a plain grass tile deep inside a region of kingdom K (not occupied) and one in an unowned region
  const spots = await E(() => {
    const r2 = window.__r2, S = r2.S, W = S.w, H = S.h, out = {};
    const plain = (x, y, rid) => { for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= W || yy >= H) return false; const k = yy * W + xx; if (S.region[k] !== rid || S.bld[k] || S.res[k] || S.tile[k] !== 3) return false; } return true; };
    const solid = (x, y, rid) => { for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= W || yy >= H || S.region[yy * W + xx] !== rid) return false; } return true; };
    for (const r of r2.regions) {
      for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
        if (S.region[y * W + x] !== r.id || !plain(x, y, r.id)) continue;
        if (r.ownerId && r.controllerId === r.ownerId && !out.owned && r.ownerId === r2.scen.A.id) out.owned = { x, y, kid: r.ownerId, rid: r.id };
        if (!r.ownerId && !out.wild) out.wild = { x, y, rid: r.id };
      }
      if (r.ownerId && r.controllerId !== r.ownerId && r.ownerId === r2.scen.D.id && !out.occ) {
        for (let y = 2; y < H - 2 && !out.occ; y++) for (let x = 2; x < W - 2; x++) if (S.region[y * W + x] === r.id && solid(x, y, r.id)) { out.occ = { x, y, kid: r.ownerId, ctrl: r.controllerId, rid: r.id }; break; }
      }
    }
    return out;
  });
  check('found sample tiles (owned / unowned / occupied)', !!(spots.owned && spots.wild && spots.occ), JSON.stringify(spots));
  const colA = hexRgb(sc.ac);
  await h.mode(0);
  const sample = async (t, z = 6) => { await h.cam(t.x + 0.5, t.y + 0.5, z); await h.frames(2); const s = await h.tile2s(t.x + 0.5, t.y + 0.5); return h.px(s.x, s.y, 1); };
  const nOwned = await sample(spots.owned), nWild = await sample(spots.wild);
  await h.mode(1);
  const bOwned = await sample(spots.owned), bWild = await sample(spots.wild);
  const expect = nOwned.map((v, i) => Math.round(v * 0.7 + colA[i] * 0.3));
  check('owner fill = kingdom colour at alpha 0.30 over the terrain', dist3(bOwned, expect) <= 12, `normal ${nOwned} -> ${bOwned}, expected ${expect}`);
  check('unowned ("wild") region has no fill', dist3(bWild, nWild) <= 10, `normal ${nWild} -> ${bWild}`);
  await h.mode(2);
  const cOwned = await sample(spots.owned);
  check('CULTURE mode fills the region with the owner culture colour (differs from the kingdom fill)', dist3(cOwned, nOwned) > 20 && dist3(cOwned, bOwned) > 12, `kingdom ${bOwned} culture ${cOwned}`);
  await h.mode(1); await h.frames(3);
  const p = await h.pol();
  check('kingdom outlines, thin region lines, wild lines and front lines are built', p.outlineRuns > 40 && p.thinRuns > 40 && p.wildRuns > 4 && p.frontRuns > 0, JSON.stringify({ o: p.outlineRuns, t: p.thinRuns, w: p.wildRuns, f: p.frontRuns }));
  check('occupied tiles (controller != owner) are striped', p.stripeTiles > 20, p.stripeTiles + ' tiles');

  // stripes: along a row through the occupied region the controller colour (kingdom A, red-ish) alternates with the owner colour (D, blue)
  const rowCount = async (t, z) => {
    await h.cam(t.x + 0.5, t.y + 0.5, z); await h.frames(3);
    const s = await h.tile2s(t.x + 0.5, t.y + 0.5);
    const redish = `r > 170 && g < 120 && b < 120`;
    return h.count(s.x - 22, s.y - 6, 44, 12, redish);
  };
  const occStripes = await rowCount(spots.occ, 16);
  const ownStripes = await rowCount(spots.owned, 16);
  check('stripes: the occupied region shows many controller-coloured pixels, a normal region none', occStripes > 60 && ownStripes < occStripes / 4, `occupied ${occStripes}px vs owned ${ownStripes}px`);

  // front line: a boundary between two regions whose controllers are at war must be dark with red dashes
  const fl = await E(() => {
    const r2 = window.__r2, S = r2.S, W = S.w, H = S.h;
    const wars = [...S.wars.values()];
    const atWar = (a, b) => wars.some(w => !w.ended && ((w.attackers.includes(a) && w.defenders.includes(b)) || (w.attackers.includes(b) && w.defenders.includes(a))));
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const a = S.region[y * W + x], c = S.region[y * W + x + 1];
      if (!a || !c || a === c) continue;
      const ra = r2.byId(a), rc = r2.byId(c);
      if (ra.controllerId && rc.controllerId && ra.controllerId !== rc.controllerId && atWar(ra.controllerId, rc.controllerId)) {
        // need a long straight-ish vertical run so a window of 24 css px around it is mostly boundary
        return { x: x + 1, y: y + 0.5 };
      }
    }
    return null;
  });
  check('a front edge exists in the fabricated war', !!fl, JSON.stringify(fl));
  if (fl) {
    await h.cam(fl.x, fl.y, 20); await h.frames(3);
    const s = await h.tile2s(fl.x, fl.y);
    const dark = await h.count(s.x - 12, s.y - 12, 24, 24, 'r < 40 && g < 30 && b < 30');
    let red = 0; for (let k = 0; k < 6; k++) { red = Math.max(red, await h.count(s.x - 12, s.y - 12, 24, 24, 'r > 200 && g < 90 && b < 80')); await h.sleep(70); }
    check('front line = black base with red dashes', dark > 12 && red > 6, `dark ${dark}px red ${red}px`);
    await h.mode(2); await h.frames(3);
    const darkC = await h.count(s.x - 12, s.y - 12, 24, 24, 'r < 40 && g < 30 && b < 30');
    check('CULTURE mode shows no front lines', darkC < dark / 3, `dark ${darkC}px`);
    await h.mode(1);
  }
  // occupied cities carry the occupier's flag next to the city flag / label
  const occCities = await E(() => window.__r2.cities.filter(c => c.occupierId).length);
  await h.cam(sc.g1c[0], sc.g1c[1], 6); await h.frames(3);
  const o6 = (await h.pol()).occupierFlags;
  await h.cam(sc.g1c[0], sc.g1c[1], 12); await h.frames(3);
  const o12 = (await h.pol()).occupierFlags;
  await E(() => { const r2 = window.__r2; r2.__armies = new Map(r2.S.armies); r2.S.armies.clear(); }); await h.frames(3);
  await h.shot('14_occupied_city_z12');
  await E(() => { const r2 = window.__r2; for (const [id, a] of r2.__armies) r2.S.armies.set(id, a); });
  check('occupied cities get the occupier\'s flag (both label styles)', occCities >= 1 && o6 >= 1 && o12 >= 1, `${occCities} occupied cities; flags drawn ${o6} (z6) / ${o12} (z12)`);
  // region names appear at zoom >= 7, kingdom names (overview) below it
  const labels = async z => { await h.cam(48, 48, z); await h.frames(3); const p = await h.pol(); return [p.regionLabels, p.kingdomLabels]; };
  const [rl6, kl6] = await labels(6.5), [rl9, kl9] = await labels(9);
  check('region names are drawn at zoom >= 7 only; kingdom names only below it', rl6 === 0 && kl6 >= 2 && rl9 >= 3 && kl9 === 0, `z6.5: ${rl6} region / ${kl6} kingdom labels, z9: ${rl9} / ${kl9}`);
  const rcen = await E(rid => { const R = window.__r2.byId(rid); return { cx: R.cx, cy: R.cy }; }, spots.wild.rid);
  await h.cam(rcen.cx + 0.5, rcen.cy + 0.5, 9); await h.frames(3);
  const sL9 = await h.tile2s(rcen.cx + 0.5, rcen.cy + 0.5);
  const l9 = await h.count(sL9.x - 70, sL9.y - 40, 140, 80, 'r > 190 && g > 195 && b > 195');
  check('the unowned region\'s name is visible as light text', l9 > 80, l9 + ' light px');
  check('no console errors', b.errors.length === 0, b.errors[0] || '');
}

// --------------------------------------------------------------- caching
if (want('cache')) {
  section('cache: rebuild only on S.regionVer / ownerVer / war-set change, throttled >= 150 ms');
  await h.mode(1); await h.cam(48, 48, 6); await h.frames(5);
  const p0 = await h.pol();
  await h.frames(40); await h.sleep(300);
  const p1 = await h.pol();
  check('no rebuild while nothing changes (40+ frames)', p1.builds === p0.builds, `${p0.builds} -> ${p1.builds}`);
  await E(() => window.__r2.touch()); await h.sleep(300); await h.frames(2);
  const p2 = await h.pol();
  check('S.touchRegions() triggers exactly one rebuild', p2.builds === p1.builds + 1 && p2.ver !== p1.ver, `${p1.builds} -> ${p2.builds}, ver ${p1.ver} -> ${p2.ver}`);
  // storm of changes in a few frames: throttled
  const st = await E(async () => {
    const R = window.__r2.Render, r2 = window.__r2, b0 = R.debugInfo().political.builds, t0 = performance.now();
    let frames = 0;
    await new Promise(res => { const f = () => { r2.touch(); frames++; if (performance.now() - t0 < 560) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    const b1 = R.debugInfo().political.builds;
    return { builds: b1 - b0, ms: performance.now() - t0, frames };
  });
  check('a change storm (touch every frame for 0.56 s) is throttled to <= 1 rebuild per 150 ms', st.builds >= 1 && st.builds <= Math.ceil(st.ms / 150) + 1, `${st.builds} rebuilds in ${st.ms.toFixed(0)} ms / ${st.frames} frames`);
  await h.sleep(300); await h.frames(3);
  // ownership change repaints the fill
  const t = await E(() => {
    const r2 = window.__r2, S = r2.S, g = r2.scen;
    for (const r of r2.regions) if (r.ownerId === g.A.id && r.controllerId === g.A.id && r.id !== g.g1.id) {
      for (let y = 2; y < S.h - 2; y++) for (let x = 2; x < S.w - 2; x++) {
        let ok = true; for (let j = -1; j <= 1 && ok; j++) for (let i = -1; i <= 1; i++) { const k = (y + j) * S.w + x + i; if (S.region[k] !== r.id || S.bld[k] || S.res[k] || S.tile[k] !== 3) { ok = false; break; } }
        if (ok) return { x, y, rid: r.id };
      }
    }
    return null;
  });
  await h.cam(t.x + 0.5, t.y + 0.5, 6); await h.frames(3);
  const s = await h.tile2s(t.x + 0.5, t.y + 0.5);
  const before = await h.px(s.x, s.y, 1);
  const bld = await h.pol();
  await E(([rid, kid]) => window.__r2.setOwner(rid, kid), [t.rid, sc.D]);
  await h.sleep(350); await h.frames(3);
  const after = await h.px(s.x, s.y, 1);
  const aft = await h.pol();
  check('changing a region owner repaints it in the new kingdom colour', dist3(before, after) > 25 && aft.builds === bld.builds + 1, `${before} -> ${after}`);
  await E(([rid, kid]) => window.__r2.setOwner(rid, kid), [t.rid, sc.A]);
  await h.sleep(350); await h.frames(2);
  // war end => fronts vanish without a regionVer bump
  const w0 = await h.pol();
  await E(() => { for (const w of window.__r2.wars) w.ended = true; });
  await h.sleep(300); await h.frames(3);
  const w1 = await h.pol();
  check('ending every war removes the front lines (war-set signature)', w0.frontRuns > 0 && w1.frontRuns === 0 && w1.builds === w0.builds + 1, `front runs ${w0.frontRuns} -> ${w1.frontRuns}`);
  await E(() => { for (const w of window.__r2.wars) w.ended = false; });
  await h.sleep(300); await h.frames(3);
  const w2 = await h.pol();
  check('a new war brings them back', w2.frontRuns > 0, 'front runs ' + w2.frontRuns);
  // mode switch rebuilds at once
  const m0 = await h.pol(); await h.mode(2); await h.frames(2); const m1 = await h.pol();
  check('switching BORDERS -> CULTURE rebuilds immediately', m1.builds === m0.builds + 1 && m1.mode === 2, `${m0.builds} -> ${m1.builds}`);
  await h.mode(0); await h.frames(40); await h.sleep(300);
  const n0 = await h.pol(); await E(() => window.__r2.touch()); await h.sleep(300); await h.frames(5); const n1 = await h.pol();
  check('NORMAL mode builds nothing', n1.builds === n0.builds, `${n0.builds} -> ${n1.builds}`);
  await h.mode(1); await h.frames(3);
  check('no console errors', b.errors.length === 0, b.errors[0] || '');
}

// --------------------------------------------------------------- picking
if (want('pick')) {
  section('Render.regionAt + real taps');
  const r = await E(() => {
    const r2 = window.__r2, R = r2.Render, S = r2.S, out = { centres: 0, ok: 0, water: [], coast: null, outside: [] };
    for (const g of r2.regions) { out.centres++; if (R.regionAt(g.cx + 0.5, g.cy + 0.5) === g.id) out.ok++; }
    // a deep-sea tile far from land
    for (let y = 0; y < S.h && !out.water.length; y++) for (let x = 0; x < S.w; x++) if (S.tile[y * S.w + x] === 0) { let far = true; for (let j = -3; j <= 3 && far; j++) for (let i = -3; i <= 3; i++) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < S.w && yy < S.h && S.region[yy * S.w + xx]) { far = false; break; } } if (far) { out.water = [x + 0.5, y + 0.5, R.regionAt(x + 0.5, y + 0.5)]; break; } }
    // a sea tile that touches the coast: must snap to the neighbour region
    for (let y = 1; y < S.h - 1 && !out.coast; y++) for (let x = 1; x < S.w - 1; x++) if (!S.region[y * S.w + x] && S.region[y * S.w + x + 1]) { out.coast = [x + 0.5, y + 0.5, R.regionAt(x + 0.5, y + 0.5), S.region[y * S.w + x + 1]]; break; }
    out.outside = [R.regionAt(-5, 3), R.regionAt(3, -5), R.regionAt(1e6, 1e6), R.regionAt(NaN, 4)];
    out.api = typeof R.regionAt;
    return out;
  });
  check('regionAt(centre of every region) returns that region', r.ok === r.centres, `${r.ok}/${r.centres}`);
  check('open sea is region 0', r.water.length === 3 && r.water[2] === 0, JSON.stringify(r.water));
  check('a sea tile right next to the coast snaps to the adjacent land region', r.coast && r.coast[2] === r.coast[3], JSON.stringify(r.coast));
  check('outside the map / NaN => 0 and never throws', r.outside.every(v => v === 0), JSON.stringify(r.outside));
  // a real touch tap on a region centre: onTap -> regionAt
  await h.mode(1); await h.cam(48, 48, 8); await h.frames(3);
  const g = await E(() => { const r2 = window.__r2; const rg = r2.scen.D && r2.scen.g2; return { id: rg.id, cx: rg.cx + 0.5, cy: rg.cy + 0.5 }; });
  await h.cam(g.cx, g.cy, 8); await h.frames(3);
  const s = await h.tile2s(g.cx, g.cy);
  await E(() => { window.__r2.taps = 0; });
  await b.tap(s.x, s.y);
  const tapped = await E(() => ({ n: window.__r2.taps, rid: window.__r2.Render.regionAt(window.__r2.lastTap[0], window.__r2.lastTap[1]) }));
  check('tapping a region centre on the phone resolves to that region', tapped.n === 1 && tapped.rid === g.id, JSON.stringify(tapped));
}

// --------------------------------------------------------------- command highlights
if (want('cmd')) {
  section('Render.cmd highlights');
  const gx = (sc.g1c[0] + sc.g2c[0]) / 2, gy = (sc.g1c[1] + sc.g2c[1]) / 2;
  await h.mode(1); await h.cam(gx, gy, 11); await h.frames(3);
  const view = await E(() => { const v = window.__r2.Render.visibleRect(); return v; });
  const box = async () => { const a = await h.tile2s(view.x0, view.y0), z = await h.tile2s(view.x1, view.y1); return { x: a.x, y: a.y, w: z.x - a.x, h: z.y - a.y }; };
  const bx0 = await box();
  // candidates are measured inside the candidate region g2 (inland, so no animated foam / glints disturb the white-pixel count)
  const a2s = await h.tile2s(sc.g2c[0] - 5, sc.g2c[1] - 5), b2s = await h.tile2s(sc.g2c[0] + 5, sc.g2c[1] + 5);
  const bx = { x: a2s.x, y: a2s.y, w: b2s.x - a2s.x, h: b2s.y - a2s.y };
  const bxAll = bx0;
  const cy = 'r > 232 && g > 232 && b > 232';                     // bright white dashes
  const gold = 'r > 235 && g > 185 && g < 225 && b < 100';        // gold outline #ffd23c
  const sel = 'r > 240 && g > 230 && b > 150 && b < 215';         // pale yellow #fff3b0
  const base = async (src, bb = bxAll) => h.count(bb.x, bb.y, bb.w, bb.h, src);
  await E(() => { const c = window.__r2.Render.cmd; c.candidates = []; c.goals = []; c.regionId = 0; c.armyId = 0; c.targetKid = 0; });
  await h.frames(3);
  const c0 = await base(cy, bx), g0 = await base(gold), s0 = await base(sel);
  await E(ids => { window.__r2.Render.cmd.candidates = ids; }, [sc.g2, sc.extra].filter(Boolean));
  await h.frames(4);
  const c1 = await base(cy, bx);
  await h.shot('08_cmd_candidates');
  check('candidates get a bright dashed outline', c1 > c0 + 80, `${c0} -> ${c1} cyan px`);
  await E(() => { window.__r2.Render.cmd.candidates = []; window.__r2.Render.cmd.goals = []; });
  await E(id => { window.__r2.Render.cmd.goals = [id]; }, sc.g2);
  await h.frames(4);
  const g1 = await base(gold);
  await h.shot('09_cmd_goal');
  check('goal regions get a gold outline + star', g1 > g0 + 80, `${g0} -> ${g1} gold px`);
  await E(id => { const c = window.__r2.Render.cmd; c.goals = []; c.regionId = id; }, sc.g2);
  await h.frames(4);
  let s1 = 0; for (let k = 0; k < 8; k++) { s1 = Math.max(s1, await base(sel)); await h.sleep(60); }
  await h.shot('10_cmd_selected_region');
  check('the selected region gets a pulsing pale outline', s1 > s0 + 60, `${s0} -> ${s1} px`);
  await E(() => { window.__r2.Render.cmd.regionId = 0; });
  await h.frames(4);
  const s2 = await base(sel), c2 = await base(cy, bx), g2 = await base(gold);
  check('clearing Render.cmd removes all highlights', s2 <= s0 + 15 && c2 <= c0 + 80 && g2 <= g0 + 15, `${s2} ${c2} ${g2}`);
  // target kingdom border
  const red = 'r > 235 && g < 110 && b < 100 && r - g > 140';
  await h.cam(48, 48, 5); await h.frames(3);
  const full = { x: 0, y: 0, w: 390, h: 844 };
  const t0 = await h.count(full.x, full.y, full.w, full.h, red);
  await E(id => { window.__r2.Render.cmd.targetKid = id; }, sc.D);
  await h.frames(4);
  let t1 = 0; for (let k = 0; k < 6; k++) { t1 = Math.max(t1, await h.count(full.x, full.y, full.w, full.h, red)); await h.sleep(60); }
  check('targetKid draws a red pulsing border around that kingdom', t1 > t0 + 40, `${t0} -> ${t1} px`);
  await E(() => { window.__r2.Render.cmd.targetKid = 0; });
  check('no console errors', b.errors.length === 0, b.errors[0] || '');
}

// --------------------------------------------------------------- armies: banners, supply, selection, interpolation
if (want('armies')) {
  section('army banners');
  await h.mode(1); await h.cam(front.x, front.y, 10); await h.frames(4);
  const vis = await E(() => {
    const r2 = window.__r2, v = r2.Render.visibleRect();
    return r2.armies.filter(a => { const u = r2.S.units.get(a.leaderId); return u && u.x >= v.x0 - 4 && u.x <= v.x1 + 4 && u.y >= v.y0 - 5 && u.y <= v.y1 + 4; }).length;
  });
  const p = await h.pol();
  check('every army with soldiers in view gets a banner (zoom >= 5)', p.banners === vis && vis >= 3, `${p.banners} banners / ${vis} armies in view`);
  const rects = await E(() => window.__r2.armies.map(a => ({ id: a.id, r: window.__r2.Render.armyBannerRect(a.id), n: a.members.length })));
  const rr = rects.find(x => x.r);
  check('banner hit boxes are reported (armyBannerRect / armyAtScreen)', !!rr && (await E(([id, x, y]) => window.__r2.Render.armyAtScreen(x, y) === id, [rr.id, (rr.r.x0 + rr.r.x1) / 2, (rr.r.y0 + rr.r.y1) / 2])), JSON.stringify(rr));
  // banner shows the soldier count: kill a soldier, the count text changes (sprite cache key)
  const a1 = rects.find(x => x.id === sc.a1);
  const before = await h.count(a1.r.x0, a1.r.y0, a1.r.x1 - a1.r.x0, a1.r.y1 - a1.r.y0, 'r > 240 && g > 240 && b > 240');
  await E(id => { const a = window.__r2.S.armies.get(id); for (let k = 0; k < 12; k++) { const uid = a.members.pop(); window.__r2.S.units.delete(uid); } }, sc.a1);
  await h.frames(3);
  const a1b = await E(id => window.__r2.Render.armyBannerRect(id), sc.a1);
  const after = await h.count(a1b.x0, a1b.y0, a1b.x1 - a1b.x0, a1b.y1 - a1b.y0, 'r > 240 && g > 240 && b > 240');
  check('the banner redraws with the new soldier count', before !== after || a1b.x1 - a1b.x0 !== a1.r.x1 - a1.r.x0, `white px ${before} -> ${after}`);
  // army without soldiers: no banner
  await E(id => { const a = window.__r2.S.armies.get(id); a._m = a.members.slice(); a.members.length = 0; }, sc.a2);
  await h.frames(3);
  const gone = await E(id => window.__r2.Render.armyBannerRect(id), sc.a2);
  check('an army with 0 soldiers has no banner', gone === null);
  await E(id => { const a = window.__r2.S.armies.get(id); a.members = a._m; }, sc.a2);
  // supply warning
  await h.cam(48, 48, 6); await h.frames(3);
  const lowSup = await E(id => { const a = window.__r2.S.armies.get(id); return { s: a.supply, u: window.__r2.S.units.get(a.leaderId) && [window.__r2.S.units.get(a.leaderId).x, window.__r2.S.units.get(a.leaderId).y] }; }, sc.a3);
  await h.cam(lowSup.u[0], lowSup.u[1], 10); await h.frames(3);
  const rc = await E(id => window.__r2.Render.armyBannerRect(id), sc.a3);
  const badge = async () => { let m = 0; for (let k = 0; k < 8; k++) { m = Math.max(m, await h.count(rc.x0 - 4, rc.y0 - 22, rc.x1 - rc.x0 + 12, 24, 'r > 190 && g < 70 && b < 70')); await h.sleep(50); } return m; };
  const withBadge = await badge();
  await E(id => { window.__r2.S.armies.get(id).supply = 90; }, sc.a3); await h.frames(3);
  const noBadge = await badge();
  check('supply < 30 shows a pulsing red warning badge, healthy supply does not', withBadge > noBadge + 25, `${noBadge} -> ${withBadge} red px`);
  await E(id => { window.__r2.S.armies.get(id).supply = 18; }, sc.a3);
  // selected ring
  await h.cam(front.x, front.y, 12); await h.frames(3);
  const yellow = 'r > 240 && g > 205 && b > 70 && b < 150';
  const rb = await E(id => window.__r2.Render.armyBannerRect(id), sc.a1);
  const ring = async () => { let m = 0; for (let k = 0; k < 6; k++) { m = Math.max(m, await h.count(rb.x0 - 20, rb.y0 - 8, rb.x1 - rb.x0 + 40, rb.y1 - rb.y0 + 70, yellow)); await h.sleep(40); } return m; };
  const r0 = await ring();
  await E(id => { window.__r2.Render.cmd.armyId = id; }, sc.a1); await h.frames(3);
  const r1 = await ring();
  check('the selected army gets a ring + glowing banner frame', r1 > r0 + 60, `${r0} -> ${r1} yellow px`);
  await E(() => { window.__r2.Render.cmd.armyId = 0; });
  // movement: banner follows the leader interpolated between ticks
  const mv = await E(() => {
    const r2 = window.__r2, R = r2.Render, a = r2.S.armies.get(r2.scen.a2.id), u = r2.S.units.get(a.leaderId);
    const x0 = u.x, y0 = u.y;
    u.px = x0; u.py = y0; u.x = x0 + 1.5; u.y = y0;                    // one tick of movement = 1.5 tiles
    let t = performance.now() + 1000;
    const rect = al => { R.draw(al, t); t += 300; const r = R.armyBannerRect(a.id); return r ? (r.x0 + r.x1) / 2 : null; };
    const xs = [rect(0), rect(0.5), rect(1)];
    u.x = x0; u.y = y0; u.px = x0; u.py = y0;
    return { xs, z: R.cam.zoom };
  });
  check('banner position is interpolated between ticks (alpha 0 -> 0.5 -> 1)', mv.xs.every(v => v !== null) && near(mv.xs[1] - mv.xs[0], 0.75 * mv.z, 1.2) && near(mv.xs[2] - mv.xs[0], 1.5 * mv.z, 1.5), JSON.stringify(mv.xs.map(v => Math.round(v * 10) / 10)) + ' zoom ' + mv.z);
  // no leader units at all: marker falls back to army.rally
  const fb = await E(() => {
    const r2 = window.__r2, R = r2.Render, a = r2.S.armies.get(r2.scen.d1.id);
    const saved = a.members.map(id => r2.S.units.get(id)); a.members.forEach(id => r2.S.units.delete(id));
    a.rally.x += 0.01; let t = performance.now() + 5000;
    R.draw(0.5, t); R.draw(0.5, t + 300);
    const rect = R.armyBannerRect(a.id), s = R.tileToScreen(a.rally.x, a.rally.y);
    saved.forEach(u => r2.S.units.set(u.id, u));
    return { rect, s };
  });
  check('without leader units the banner sits on army.rally', fb.rect && near((fb.rect.x0 + fb.rect.x1) / 2, fb.s.x, 3), JSON.stringify(fb.rect) + ' vs ' + JSON.stringify(fb.s));
  // zoom < 5: only the commanded kingdom's banners
  await h.cam(48, 48, 4.063); await h.frames(3);
  const low = await E(() => { const r2 = window.__r2, ids = r2.armies.filter(a => r2.Render.armyBannerRect(a.id)).map(a => a.kingdomId); return { ids: [...new Set(ids)], cmd: r2.cmdKid, n: ids.length }; });
  check('below zoom 5 only the commanded kingdom\'s armies get banners', low.n >= 2 && low.ids.length === 1 && low.ids[0] === low.cmd, JSON.stringify(low));
  await E(() => { window.__r2.Render.showAllOrders = true; }); await h.frames(3);
  const low2 = await E(() => { const r2 = window.__r2; return r2.armies.filter(a => r2.Render.armyBannerRect(a.id)).length; });
  check('showAllOrders shows every kingdom\'s banners at the overview zoom too', low2 > low.n, `${low.n} -> ${low2}`);
  await E(() => { window.__r2.Render.showAllOrders = false; });
  check('no console errors', b.errors.length === 0, b.errors[0] || '');
}

// --------------------------------------------------------------- order arrows
if (want('arrows')) {
  section('order arrows');
  await h.mode(1); await h.cam(48, 48, 4.063); await h.frames(4);
  // armies whose order target is farther than 4 device px from the army (closer ones are already "there": no arrow, only the marker)
  const expectArrows = (all) => E(all => {
    const r2 = window.__r2, R = r2.Render, S = r2.S, Z = R.cam.zoom * R.size.dpr; let n = 0;
    for (const a of r2.armies) {
      if (!a.members.length || !a.order || (!all && a.kingdomId !== r2.cmdKid)) continue;
      const u = S.units.get(a.leaderId); let tc = null;
      if (a.order.type === 'retreat') { const hc = S.cities.get(a.cityId); tc = a.order.regionId ? R.regionCenter(a.order.regionId) : (hc ? { x: hc.x + 0.5, y: hc.y + 0.5 } : null); } else tc = R.regionCenter(a.order.regionId);
      if (u && tc && Math.hypot((tc.x - u.x) * Z, (tc.y - (u.y + 0.45)) * Z) >= 4 * R.size.dpr) n++;
    }
    return n;
  }, all);
  const cmdArmies = await expectArrows(false);
  let p = await h.pol();
  check('political map: one arrow per army of the commanded kingdom', p.arrows === cmdArmies && cmdArmies >= 3, `${p.arrows} arrows, ${cmdArmies} armies`);
  await E(() => { window.__r2.Render.showAllOrders = true; }); await h.frames(3);
  p = await h.pol();
  const allArmies = await expectArrows(true);
  check('showAllOrders draws the arrows of every kingdom', p.arrows === allArmies && allArmies > cmdArmies, `${p.arrows} / ${allArmies}`);
  await E(() => { window.__r2.Render.showAllOrders = false; });
  for (const [m, name] of [[2, 'culture'], [0, 'normal']]) {
    await h.mode(m); await h.frames(4); p = await h.pol();
    check(`${name} mode: arrows of the commanded kingdom only (showAllOrders ignored)`, p.arrows === cmdArmies, `${p.arrows}`);
  }
  await E(() => { window.__r2.Render.showAllOrders = true; }); await h.frames(3);
  p = await h.pol();
  check('normal mode ignores showAllOrders', p.arrows === cmdArmies, `${p.arrows}`);
  await E(() => { window.__r2.Render.showAllOrders = false; });
  await E(() => { window.__r2.Render.cmd = null; }); await h.frames(3);
  p = await h.pol();
  check('Render.cmd = null: no arrows, banners still drawn', p.arrows === 0, `${p.arrows} arrows`);
  await E(id => { window.__r2.Render.cmd = { kid: id, regionId: 0, armyId: 0, goals: [], candidates: [], targetKid: 0 }; }, sc.A);
  await h.mode(1); await h.frames(3);

  // pixel checks: attack arrow body is red with a dark casing; hold gets a shield marker; retreat is dotted light
  await h.cam(front.x, front.y, 9); await h.frames(3);
  const geo = await E(() => {
    const r2 = window.__r2, R = r2.Render, g = r2.scen, a = g.a1;
    const u = r2.S.units.get(a.leaderId), tc = R.regionCenter(a.order.regionId);
    return { from: [u.x, u.y], to: [tc.x, tc.y] };
  });
  // sample the quadratic bezier midpoint like Render does (control point left of the travel direction, 20 % of the length)
  const f = await h.tile2s(geo.from[0], geo.from[1] + 0.45), t = await h.tile2s(geo.to[0], geo.to[1]);
  const dx = t.x - f.x, dy = t.y - f.y, len = Math.hypot(dx, dy), nx = dy / len, ny = -dx / len;
  const cx = (f.x + t.x) / 2 + nx * len * 0.2, cy = (f.y + t.y) / 2 + ny * len * 0.2;
  const mx = 0.25 * f.x + 0.5 * cx + 0.25 * t.x, my = 0.25 * f.y + 0.5 * cy + 0.25 * t.y;
  const midCol = await h.px(mx, my, 1);
  check('attack arrow: red body on the curve (control point left of travel)', midCol[0] > 110 && midCol[0] - midCol[1] > 70 && midCol[0] - midCol[2] > 70, `rgb ${midCol} at ${mx.toFixed(0)},${my.toFixed(0)}`);
  await h.shot('11_arrows_attack');
  // arrowhead: the head is wider than the body just before the tip
  const headW = await h.count(t.x - 30, t.y - 40, 60, 60, 'r > 200 && g < 100 && b < 90');
  check('attack arrow has a filled arrowhead at the target region', headW > 150, headW + ' red px near the tip');
  // hold marker: reserve army hold order -> blue shield near region centre
  const hold = await E(() => { const r2 = window.__r2, R = r2.Render, a = r2.scen.a2, c = R.regionCenter(a.order.regionId); return { c: [c.x, c.y] }; });
  await h.cam(hold.c[0], hold.c[1], 12); await h.frames(3);
  const hs = await h.tile2s(hold.c[0], hold.c[1]);
  let shield = 0; for (let k = 0; k < 6; k++) { shield = Math.max(shield, await h.count(hs.x - 20, hs.y - 26, 40, 44, 'b > 190 && r < 120 && g > 100 && g < 200')); await h.sleep(50); }
  check('hold order: blue shield marker at the region centre', shield > 25, shield + ' blue px');
  // retreat: the enemy's army d2 (grey banner) draws a dotted light line when everybody's orders are shown
  const rt = await E(() => { const r2 = window.__r2, R = r2.Render, a = r2.scen.d2, u = r2.S.units.get(a.leaderId), tc = R.regionCenter(a.order.regionId); return { u: [u.x, u.y], to: [tc.x, tc.y] }; });
  await h.cam((rt.u[0] + rt.to[0]) / 2, (rt.u[1] + rt.to[1]) / 2, 5); await h.frames(3);
  const rf = await h.tile2s(rt.u[0], rt.u[1] + 0.45), rto = await h.tile2s(rt.to[0], rt.to[1]);
  const lx = Math.min(rf.x, rto.x) - 6, ly = Math.min(rf.y, rto.y) - 6, lw = Math.abs(rto.x - rf.x) + 12, lh = Math.abs(rto.y - rf.y) + 12;
  const light = 'r > 180 && g > 190 && b > 200';
  const dotsOff = await h.count(lx, ly, lw, lh, light);
  await E(() => { window.__r2.Render.showAllOrders = true; }); await h.frames(3);
  const dotsOn = await h.count(lx, ly, lw, lh, light);
  await h.shot('11b_arrows_retreat_all_orders');
  check('retreat order: a dotted light line is drawn toward the destination', dotsOn > dotsOff + 150, `${dotsOff} -> ${dotsOn} light px`);
  await E(() => { window.__r2.Render.showAllOrders = false; });
  check('no console errors', b.errors.length === 0, b.errors[0] || '');
}

// --------------------------------------------------------------- goal stars from S.wars
if (want('goals')) {
  section('war goal star markers');
  await h.mode(1); await h.cam(48, 48, 4.063); await h.frames(3);
  const nGoals = await E(() => { const r2 = window.__r2; let mine = 0, all = 0; for (const w of r2.wars) for (const g of w.goals) { all++; if (g.kid === r2.cmdKid) mine++; } return { mine, all }; });
  let p = await h.pol();
  check('only the commanded kingdom\'s war goals get star markers', p.goalMarkers === nGoals.mine && nGoals.mine >= 2, `${p.goalMarkers} markers / ${nGoals.mine} goals`);
  await E(() => { window.__r2.Render.showAllOrders = true; }); await h.frames(3);
  p = await h.pol();
  check('showAllOrders shows every kingdom\'s goals', p.goalMarkers === nGoals.all && nGoals.all > nGoals.mine, `${p.goalMarkers} / ${nGoals.all}`);
  await E(() => { window.__r2.Render.showAllOrders = false; });
  await h.mode(0); await h.frames(3); p = await h.pol();
  check('no goal stars outside the political map', p.goalMarkers === 0);
  await h.mode(2); await h.frames(3); p = await h.pol();
  check('no goal stars in CULTURE mode either', p.goalMarkers === 0);
  await h.mode(1); await h.frames(3); p = await h.pol();
  check('finished goals are flagged done (green check badge)', p.goalMarkersDone >= 1, p.goalMarkersDone + ' done');
  // pixels: star in the kingdom colour above the goal region centre (armies hidden so a banner cannot cover it)
  await E(() => { const r2 = window.__r2; r2.__armies = new Map(r2.S.armies); r2.S.armies.clear(); });
  await h.cam(sc.g2c[0], sc.g2c[1], 12); await h.frames(3);
  const s = await h.tile2s(sc.g2c[0], sc.g2c[1] - 1.15), aCol = hexRgb(sc.ac);
  const countCol = async (cc, x, y) => { let m = 0; for (let k = 0; k < 5; k++) { m = Math.max(m, await h.count(x - 22, y - 24, 44, 44, `(Math.abs(r-${cc[0]})+Math.abs(g-${cc[1]})+Math.abs(b-${cc[2]})) < 60`)); await h.sleep(40); } return m; };
  const withStar = await countCol(aCol, s.x, s.y);
  await E(() => { for (const w of window.__r2.wars) w._g = w.goals.splice(0); }); await h.sleep(300); await h.frames(3);
  const noStar = await countCol(aCol, s.x, s.y);
  await E(() => { for (const w of window.__r2.wars) w.goals = w._g; }); await h.sleep(300); await h.frames(3);
  check('the star is drawn in the kingdom colour at the goal region', withStar > noStar + 20, `${noStar} -> ${withStar} px`);
  await h.cam(sc.g1c[0], sc.g1c[1], 14); await h.frames(3);
  const sd = await h.tile2s(sc.g1c[0], sc.g1c[1] - 1.15);
  const green = await h.count(sd.x - 24, sd.y - 26, 48, 48, 'g > 190 && r < 90 && b < 120 && g - r > 110');
  check('a completed goal shows the green check badge', green > 6, green + ' green px');
  await h.shot('13_goal_markers_z14');
  await E(() => { const r2 = window.__r2; for (const [id, a] of r2.__armies) r2.S.armies.set(id, a); });
  check('no console errors', b.errors.length === 0, b.errors[0] || '');
}

// --------------------------------------------------------------- performance
if (want('perf')) {
  section('performance (headless Chromium, software rasteriser)');
  await h.mode(1);
  const results = {};
  for (const z of [4.063, 8, 16]) {
    await h.cam(z < 5 ? 48 : front.x, z < 5 ? 48 : front.y, z); await h.frames(3);
    const t = await E(() => {
      const R = window.__r2.Render, N = 90;
      const run = pan => { const c0 = { ...R.cam }; const t0 = performance.now(); for (let i = 0; i < N; i++) { if (pan) R.setCamera(c0.x + Math.sin(i / 7) * 0.9, c0.y + Math.cos(i / 9) * 0.9, c0.zoom); R.draw((i % 10) / 10, performance.now() + i * 16); } const d = (performance.now() - t0) / N; R.setCamera(c0.x, c0.y, c0.zoom); return d; };
      R.setMode(1); const polStatic = run(false), polPan = run(true);
      R.setMode(0); const normStatic = run(false), normPan = run(true);
      R.setMode(1); const cmd = R.cmd; R.cmd = null; const noWar = run(false); R.cmd = cmd;
      return { polStatic, polPan, normStatic, normPan, noWar, stats: { ...R.stats } };
    });
    results[z] = t;
    console.log(`  zoom ${String(z).padEnd(6)} static camera: BORDERS+war ${t.polStatic.toFixed(2)} ms vs NORMAL ${t.normStatic.toFixed(2)} ms (+${(t.polStatic - t.normStatic).toFixed(2)})   panning: BORDERS+war ${t.polPan.toFixed(2)} ms vs NORMAL ${t.normPan.toFixed(2)} ms (+${(t.polPan - t.normPan).toFixed(2)})`);
  }
  check('static camera: the whole political layer + arrows + banners add < 1.5 ms/frame', Object.values(results).every(t => t.polStatic - t.normStatic < 1.5), Object.keys(results).map(z => (results[z].polStatic - results[z].normStatic).toFixed(2)).join(' / ') + ' ms');
  check('panning (layer re-rendered every frame): < 4.5 ms/frame over NORMAL (software canvas)', Object.values(results).every(t => t.polPan - t.normPan < 4.5), Object.keys(results).map(z => (results[z].polPan - results[z].normPan).toFixed(2)).join(' / ') + ' ms');
  check('total BORDERS frame < 12 ms at every zoom, even while panning', Object.values(results).every(t => t.polPan < 12), Object.values(results).map(t => t.polPan.toFixed(1)).join(' / '));
  {
    await h.frames(4); const L0 = await h.pol(); await h.frames(30); const L1 = await h.pol();
    check('an idle camera blits the cached political layer (no re-render)', L1.layerDraws === L0.layerDraws && L1.layerBlits >= L0.layerBlits + 20, `draws ${L0.layerDraws} -> ${L1.layerDraws}, blits ${L0.layerBlits} -> ${L1.layerBlits}`);
    await E(() => { const R = window.__r2.Render; for (let i = 0; i < 6; i++) { R.panBy(7, 0); R.draw(0.5, performance.now() + i * 16); } }); const L2 = await h.pol();
    check('while the camera moves the layer is drawn directly (no stale blit), then cached again once it rests', L2.layerDirect >= L1.layerDirect + 4 && (await h.frames(4), (await h.pol()).layerDraws > L1.layerDraws), `direct ${L1.layerDirect} -> ${L2.layerDirect}`);
  }
  // rebuild cost on the 96x96 test map + a big world
  const rb = await E(() => { const R = window.__r2.Render; R.setMode(1); const out = []; for (let k = 0; k < 8; k++) { R.invalidate(); R.draw(0.5, performance.now()); out.push(R.debugInfo().political.buildMs); } return out; });
  const avg = rb.reduce((a, c) => a + c, 0) / rb.length;
  console.log(`  political cache rebuild 96x96: ${avg.toFixed(2)} ms avg (${Math.max(...rb).toFixed(2)} max)`);
  check('cache rebuild < 12 ms on 96x96', avg < 12, avg.toFixed(2) + ' ms');
  // steady state: no allocation churn is hard to prove in a page, but frames with nothing changing must not rebuild
  const pp = await h.pol(); await h.frames(60); const pq = await h.pol();
  check('60 steady frames, 0 rebuilds', pq.builds === pp.builds);
  // 1500 civilians + armies: stage-1 budget still holds
  await E(() => { const r2 = window.__r2, S = r2.S; let n = 0; const cs = r2.cities; while (S.units.size < 1500 && cs.length) { const c = cs[n++ % cs.length], id = S.id(); const u = { ...r2.civ[0], id, x: c.x + 0.5 + (n % 7) * 0.4, y: c.y + 0.5 + (n % 5) * 0.4, px: c.x + 0.5, py: c.y + 0.5, cityId: c.id, kingdomId: c.kingdomId, isRuler: false, armyId: 0 }; S.units.set(id, u); } });
  await h.cam(front.x, front.y, 8); await h.frames(5);
  const st = await E(() => { const R = window.__r2.Render; const N = 90, t0 = performance.now(); for (let i = 0; i < N; i++) R.draw(0.5, performance.now() + i * 16); return { avg: (performance.now() - t0) / N, stats: { ...R.stats }, units: window.__r2.S.units.size }; });
  console.log(`  1500 units, zoom 8, BORDERS + armies: ${st.avg.toFixed(2)} ms/frame, Render.stats.drawMs ${st.stats.drawMs}`);
  check('1500 units + political map: Render.stats.drawMs < 8 ms', st.units >= 1500 && st.stats.drawMs < 8, st.stats.drawMs + ' ms');
  const fps = await b.fps(1500);
  check('rAF holds ~60 fps in BORDERS mode with armies and arrows', fps.fps > 45, fps.fps.toFixed(1) + ' fps, p95 ' + fps.p95.toFixed(1) + ' ms');
  check('no console errors', b.errors.length === 0, b.errors[0] || '');
}
await b.close();

// --------------------------------------------------------------- fallbacks: Regions API / no regions / dpr 1 / big map
if (want('modes')) {
  section('Regions.* guarded access');
  {
    const a = await open('still=1&seed=11&regionsapi=1');
    await a.mode(1); await a.cam(48, 48, 5); await a.frames(4);
    const p = await a.pol();
    const calls = await a.E(() => window.__r2.apiCalls);
    check('with a (fake) real Regions API, Render uses Regions.frontlines() and Regions.centroid()', p.usedFrontApi && calls.frontlines >= 1 && calls.centroid >= 3, JSON.stringify(calls));
    const fr = p.frontRuns;
    await a.b.close();
    const f = await open('still=1&seed=11');
    await f.mode(1); await f.cam(48, 48, 5); await f.frames(4);
    const p2 = await f.pol();
    check('without the API (stub) the fallback finds the same front lines from S.wars', !p2.usedFrontApi && p2.frontRuns === fr && fr > 0, `${p2.frontRuns} vs ${fr} runs`);
    check('no console errors', a.b.errors.length === 0 && f.b.errors.length === 0, (a.b.errors[0] || f.b.errors[0] || ''));
    await f.b.close();
  }
  section('stage-1 fallback: world without regions');
  {
    const n = await open('still=1&seed=11&noregions=1');
    await n.mode(1); await n.cam(48, 48, 6); await n.frames(5);
    const d = await n.dbg();
    check('S.regions empty => legacy city-sphere overlay (borderSegments built, no political layer)', !d.political.hasRegions && d.borderSegments > 10 && d.political.builds === 0, `${d.borderSegments} runs`);
    await n.mode(2); await n.frames(3);
    check('CULTURE falls back too', (await n.dbg()).overlayMode === 2);
    check('regionAt without regions is 0', await n.E(() => window.__r2.Render.regionAt(40, 40) === 0));
    check('no console errors', n.b.errors.length === 0, n.b.errors[0] || '');
    await n.b.close();
  }
  section('orientation change');
  {
    const o = await open('still=1&seed=11');
    await o.mode(1); await o.cam(48, 48, 6); await o.frames(4);
    await o.b.page.setViewportSize({ width: 844, height: 390 }); await o.sleep(300); await o.frames(4);
    await o.E(() => window.__r2.Render.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio));
    await o.cam(48, 48, 7); await o.frames(4);
    const p = await o.pol(), sz = await o.E(() => ({ ...window.__r2.Render.size, cw: window.__r2.Render.canvas.width }));
    await o.shot('16_landscape_borders');
    check('landscape: political layer + banners re-render at the new canvas size', sz.w === 844 && p.layerDraws >= 2 && p.banners >= 1 && o.b.errors.length === 0, `${sz.w}x${sz.h}, ${p.banners} banners, ` + (o.b.errors[0] || ''));
    await o.b.close();
  }
  section('dpr 1 and a large map');
  {
    const d1 = await open('still=1&seed=5', { dpr: 1 });
    await d1.mode(1); await d1.cam(48, 48, 9); await d1.frames(4);
    const s = await d1.pol();
    await d1.shot('12_dpr1_borders_z9');
    check('dpr 1: political layer renders (banners, arrows, outlines)', s.banners >= 1 && s.arrows >= 1 && s.outlineRuns > 20 && d1.b.errors.length === 0, JSON.stringify({ b: s.banners, a: s.arrows }) + (d1.b.errors[0] || ''));
    await d1.b.close();
    const big = await open('still=1&seed=3&size=200&units=300');
    await big.mode(1); await big.cam(100, 100, 6); await big.frames(5);
    const s2 = await big.pol();
    const fps = await big.b.fps(800);
    check('200x200 map: cache rebuild < 40 ms, still 40+ fps', s2.buildMs < 40 && fps.fps > 40 && big.b.errors.length === 0, `${s2.buildMs} ms, ${s2.regions} regions, ${fps.fps.toFixed(0)} fps ` + (big.b.errors[0] || ''));
    await big.b.close();
  }
}

// --------------------------------------------------------------- optional: the REAL game (all modules of the working tree, real Regions); run with --only=live
if (only && only.includes('live')) {
  section('live: real game build (working tree), political map with the real Regions module');
  const LIVE = '/tmp/godsim-render2-live.html';
  execFileSync('node', [path.join(root, 'build.mjs'), `--out=${LIVE}`], { cwd: root, stdio: 'pipe' });
  const b2 = await launch({ url: 'file://' + LIVE });
  await b2.wait(2500);
  const ok = await b2.eval(() => !!(window.__god && window.__god.S && window.__god.Render));
  check('real game boots', ok, b2.errors[0] || '');
  if (ok) {
    await b2.eval(() => { const g = window.__god; g.Render.setMode(1); g.step(600); });
    await b2.wait(800);
    const d = await b2.eval(() => { const g = window.__god; return { p: g.Render.debugInfo().political, k: g.S.kingdoms.size, r: g.S.regions.size }; });
    check('political layer builds from real regions (labels drawn, front lines from Regions.frontlines())', d.p.hasRegions && d.p.builds >= 1 && d.p.regionLabels >= 1 && d.p.usedFrontApi, JSON.stringify(d.p));
    await b2.eval(() => window.__god.Render.setMode(2)); await b2.wait(400);
    await b2.shot(path.join(SHOTS, '15_live_culture.png'));
    await b2.eval(() => window.__god.Render.setMode(1)); await b2.wait(400);
    await b2.shot(path.join(SHOTS, '15_live_borders.png'));
  }
  check('live: no console errors', b2.errors.length === 0, b2.errors[0] || '');
  await b2.close();
}

console.log(`\n${pass} passed, ${fail} failed.` + (fail ? '  FAILED: ' + failures.join(' | ') : '') + `  Screenshots: ${SHOTS}`);
process.exit(fail ? 1 : 0);
