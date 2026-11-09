// Render + Input browser test.   node tests/render.test.mjs [--shots=/tmp/godsim-render-shots] [--keep]
// Builds the bootstrap page (tests/boot_render.js appended to the real src/ modules, other modules stubbed), opens it in
// headless Chromium with iPhone emulation (390x844 @2x, touch), drives pan / pinch / tap / paint / mouse through real
// input events, checks camera maths, dirty-list baking, overlays, resize, performance, and writes screenshots for review.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const SHOTS = args.shots || '/tmp/godsim-render-shots';
const HTML = '/tmp/godsim-render.html';
fs.mkdirSync(SHOTS, { recursive: true });
execFileSync('node', [path.join(root, 'build.mjs'), '--stubs', '--no-main', '--extra=tests/boot_render.js', `--out=${HTML}`], { cwd: root, stdio: 'pipe' });

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ok   ' + name + (info !== undefined ? '  (' + info + ')' : '')); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (info !== undefined ? '  (' + info + ')' : '')); }
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const section = s => console.log('\n# ' + s);

const b = await launch({ url: 'file://' + HTML + '?still=0&units=160&seed=7', verbose: true });
const E = (fn, arg) => b.eval(fn, arg);
const sleep = b.sleep;
const touch = (type, pts) => b.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i })) });
const cam = () => E(() => ({ ...window.__rt.Render.cam }));
const setCam = (x, y, z) => E(([x, y, z]) => window.__rt.Render.setCamera(x, y, z), [x, y, z]);
const s2t = (x, y) => E(([x, y]) => window.__rt.Render.screenToTile(x, y), [x, y]);
const taps = () => E(() => window.__rt.taps.length);
const paints = () => E(() => window.__rt.paints.slice());
const clearEv = () => E(() => { window.__rt.taps.length = 0; window.__rt.paints.length = 0; window.__rt.hovers.length = 0; window.__rt.Render.brush = null; });
const setMode = m => E(m => window.__rt.Input.setMode(m), m);
/** fast single-finger drag with a given stepMs (no CDP latency padding) */
async function fastDrag(x0, y0, x1, y1, steps = 8, stepMs = 6, release = true) {
  await touch('touchStart', [[x0, y0]]);
  for (let i = 1; i <= steps; i++) { await sleep(stepMs); await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]]); }
  if (release) await touch('touchEnd', []);
}
async function shot(name) { const f = path.join(SHOTS, name + '.png'); await b.shot(f); return f; }
/** mean colour of a small box around css point (x,y) */
const px = (x, y, r = 3) => E(([x, y, r]) => { const c = window.__rt.Render.canvas, g = c.getContext('2d'), d = window.__rt.Render.size.dpr; const n = Math.round(r * d) * 2 + 1; const a = g.getImageData(Math.round(x * d) - Math.round(r * d), Math.round(y * d) - Math.round(r * d), n, n).data; let R = 0, G = 0, B = 0, k = 0; for (let i = 0; i < a.length; i += 4) { R += a[i]; G += a[i + 1]; B += a[i + 2]; k++; } return [Math.round(R / k), Math.round(G / k), Math.round(B / k)]; }, [x, y, r]);
const frames = n => E(n => new Promise(r => { let k = 0; const f = () => { if (++k >= n) r(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n);

await b.wait(1200);
const info0 = await E(() => ({ w: window.__rt.S.w, h: window.__rt.S.h, size: window.__rt.Render.size, cw: window.__rt.Render.canvas.width, ch: window.__rt.Render.canvas.height, gen: window.__rt.genMs, ready: window.__rtReady, frames: window.__rt.frames }));

// ------------------------------------------------------------------ boot
section('boot');
check('page ready, rAF loop running', info0.ready && info0.frames > 10, 'frames ' + info0.frames);
check('canvas is css size x dpr (dpr 2)', info0.cw === 780 && info0.ch === 1688 && info0.size.dpr === 2, info0.cw + 'x' + info0.ch);
check('no console errors during boot', b.errors.length === 0, b.errors[0] || '');
await shot('00_boot_default');

// ------------------------------------------------------------------ camera maths
section('camera');
{
  const r = await E(() => {
    const R = window.__rt.Render, S = window.__rt.S, out = { maxErr: 0, clampOk: true, notes: [] };
    for (const z of [R.minZoom(), 5, 8.3, 14, 31, 48]) {
      R.setCamera(S.w / 2 + Math.sin(z) * 9, S.h / 2 + Math.cos(z) * 9, z);
      for (let i = 0; i < 20; i++) {
        const sx = (i * 37.7) % 390, sy = (i * 91.3) % 844;
        const t = R.screenToTile(sx, sy), s = R.tileToScreen(t.x, t.y), t2 = R.screenToTile(s.x, s.y);
        out.maxErr = Math.max(out.maxErr, Math.abs(s.x - sx), Math.abs(s.y - sy), Math.abs(t2.x - t.x), Math.abs(t2.y - t.y));
      }
    }
    R.setCamera(-50, -50, 14);
    let c = R.cam, vw = 390 / c.zoom, vh = 844 / c.zoom;
    out.topLeft = [c.x - vw / 2, c.y - vh / 2];
    R.setCamera(500, 500, 14);
    c = R.cam; out.botRight = [c.x + vw / 2, c.y + vh / 2];
    R.setCamera(0, 0, 8); out.centredY = R.cam.y;       // view taller than the map: centred instead
    R.setCamera(48, 48, 0.5); out.minZ = R.cam.zoom; out.minExpected = Math.min(390 / S.w, 844 / S.h);
    R.setCamera(48, 48, 999); out.maxZ = R.cam.zoom;
    R.setCamera(48, 48, NaN); out.nanZ = R.cam.zoom;
    R.setCamera(48, 48, R.minZoom()); out.fitW = S.w * R.cam.zoom;
    return out;
  });
  check('screenToTile / tileToScreen are exact inverses', r.maxErr < 1e-6, 'max err ' + r.maxErr.toExponential(1));
  check('camera cannot leave the map (top-left)', r.topLeft[0] >= -1e-9 && r.topLeft[1] >= -1e-9, r.topLeft.map(v => v.toFixed(2)).join(','));
  check('camera cannot leave the map (bottom-right)', r.botRight[0] <= 96 + 1e-9 && r.botRight[1] <= 96 + 1e-9, r.botRight.map(v => v.toFixed(2)).join(','));
  check('min zoom fits the map width on a phone', near(r.minZ, r.minExpected, 1e-9) && r.fitW <= 390 + 1e-6, 'minZoom ' + r.minZ.toFixed(3));
  check('max zoom clamps at 48', r.maxZ === 48);
  check('view taller than the map => map is centred vertically', near(r.centredY, 48, 1e-9), String(r.centredY));
  check('NaN zoom is ignored', Number.isFinite(r.nanZ), String(r.nanZ));
}
{
  await E(() => window.__rt.Render.focusOn(30, 40, 16, true));
  const c = await cam();
  check('focusOn instant', near(c.x, 30, 1e-6) && near(c.y, 40, 1e-6) && c.zoom === 16, JSON.stringify(c));
  await E(() => window.__rt.Render.focusOn(60, 70, 20));
  await sleep(700);
  const c2 = await cam();
  check('focusOn glides to the target', near(c2.x, 60, 1e-6) && near(c2.y, 70, 1e-6) && c2.zoom === 20, JSON.stringify(c2));
  // draw without a world must not throw
  const ok = await E(() => { const S = window.__rt.S, R = window.__rt.Render, t = S.tile; S.tile = null; let ok = true; try { R.draw(0, performance.now()); } catch (e) { ok = false; } S.tile = t; return ok; });
  check('draw() without a world is harmless', ok);
}

// ------------------------------------------------------------------ touch: pan mode
section('touch input: pan mode');
await setMode('pan');
await clearEv();
await setCam(48, 48, 14);
{
  const t0 = await s2t(120, 300);
  const n0 = await taps();
  await b.tap(120, 300);
  const n1 = await taps(), tp = await E(() => window.__rt.taps[window.__rt.taps.length - 1]), c = await cam();
  check('tap -> onTap with exact tile coordinates', n1 === n0 + 1 && near(tp[0], t0.x, 1e-6) && near(tp[1], t0.y, 1e-6), tp.map(v => v.toFixed(2)).join(','));
  check('tap does not move the camera', near(c.x, 48, 1e-6) && near(c.y, 48, 1e-6));
}
{
  const n0 = await taps();
  await touch('touchStart', [[150, 300]]); await sleep(430); await touch('touchEnd', []); await sleep(60);
  check('long press (>350 ms) is not a tap', (await taps()) === n0);
  await touch('touchStart', [[150, 300]]); await sleep(20); await touch('touchMove', [[156, 304]]); await sleep(20); await touch('touchEnd', []); await sleep(60);
  check('tap with <10 px jitter still counts', (await taps()) === n0 + 1);
}
{
  await sleep(1200);                                   // let any inertia from the jitter test die first
  await setCam(48, 48, 14);
  const n0 = await taps();
  await fastDrag(260, 500, 160, 380, 8, 8, false);
  const c = await cam();
  check('1-finger drag pans the map with the finger (exact)', near(c.x, 48 + 100 / 14, 1e-6) && near(c.y, 48 + 120 / 14, 1e-6), c.x.toFixed(3) + ',' + c.y.toFixed(3));
  await touch('touchEnd', []);
  await sleep(260);
  const c2 = await cam();
  check('fast release keeps gliding (inertia)', Math.hypot(c2.x - c.x, c2.y - c.y) > 0.3, 'moved ' + Math.hypot(c2.x - c.x, c2.y - c.y).toFixed(2) + ' tiles');
  await sleep(900);
  const c3 = await cam(), c4 = await (async () => { await sleep(300); return cam(); })();
  check('inertia dies out', near(c3.x, c4.x, 1e-3) && near(c3.y, c4.y, 1e-3));
  check('drag is not a tap', (await taps()) === n0);
}
{
  // a touch that stops a glide is not a tap
  await sleep(1200);
  await setCam(48, 48, 14);
  await fastDrag(300, 500, 100, 500, 8, 6, true);
  const n0 = await taps();
  await b.tap(200, 300);                              // lands while the map is still gliding
  const n1 = await taps();
  check('touch that stops a glide is swallowed (no tap)', n1 === n0, `taps ${n0} -> ${n1}`);
  await sleep(300);
  await b.tap(200, 300);
  check('next tap works again', (await taps()) === n0 + 1);
}
{
  await sleep(900);
  await setCam(48, 48, 14);
  await touch('touchStart', [[250, 500]]);
  for (let i = 1; i <= 6; i++) { await sleep(10); await touch('touchMove', [[250 - i * 10, 500]]); }
  await sleep(220);                                    // finger rests before lifting -> no glide
  const c = await cam();
  await touch('touchEnd', []); await sleep(350);
  const c2 = await cam();
  check('resting finger => no inertia', near(c.x, c2.x, 1e-6) && near(c.y, c2.y, 1e-6));
}
{
  // pan clamps at the map edge without breaking
  await setCam(48, 48, 14);
  await fastDrag(100, 400, 380, 400, 6, 8, true);
  await sleep(1100);
  const c = await cam();
  const lim = 390 / 14 / 2;
  check('pan stops at the left map edge', c.x >= lim - 1e-6 && c.x < 48, c.x.toFixed(2));
}

// pinch
section('touch input: pinch');
{
  await setCam(48, 48, 10);
  const before = await s2t(195, 420);
  await b.pinch(195, 420, 60, 130, 10, 10);
  const c = await cam(), after = await s2t(195, 420);
  check('pinch zoom factor follows finger distance', near(c.zoom, 10 * 130 / 60, 0.02), 'zoom ' + c.zoom.toFixed(3));
  check('pinch keeps the tile under the midpoint fixed', near(before.x, after.x, 0.02) && near(before.y, after.y, 0.02), `${before.x.toFixed(3)},${before.y.toFixed(3)} -> ${after.x.toFixed(3)},${after.y.toFixed(3)}`);
  await setCam(48, 48, 30);
  await b.pinch(195, 420, 160, 40, 10, 10);
  await sleep(250);
  const c2 = await cam();
  check('pinch out zooms out (clamped to min)', c2.zoom < 30 && c2.zoom >= await E(() => window.__rt.Render.minZoom()), 'zoom ' + c2.zoom.toFixed(2));
  await setCam(48, 48, 40);
  await b.pinch(195, 420, 40, 400, 10, 10);
  const c3 = await cam();
  check('pinch in clamps at max zoom', c3.zoom <= 48 + 1e-9 && c3.zoom > 44, 'zoom ' + c3.zoom.toFixed(2));
}
{
  // two fingers travelling together = pan (zoom unchanged)
  await setCam(48, 48, 12);
  const pts = (dx, dy) => [[150 + dx, 400 + dy], [250 + dx, 400 + dy]];
  await touch('touchStart', pts(0, 0));
  for (let i = 1; i <= 8; i++) { await sleep(10); await touch('touchMove', pts(i * 5, i * 4)); }
  const c = await cam();
  await touch('touchEnd', []); await sleep(50);
  check('two-finger drag pans without changing zoom', near(c.zoom, 12, 1e-9) && near(c.x, 48 - 40 / 12, 1e-6) && near(c.y, 48 - 32 / 12, 1e-6), JSON.stringify(c));
  // pinch while travelling
  await setCam(48, 48, 12);
  const w0 = await s2t(200, 400);
  await touch('touchStart', [[150, 400], [250, 400]]);
  for (let i = 1; i <= 10; i++) { await sleep(10); await touch('touchMove', [[150 - i * 5 + i * 3, 400 + i * 2], [250 + i * 5 + i * 3, 400 + i * 2]]); }
  const cc = await cam(), mid = await E(() => window.__rt.Render.tileToScreen(0, 0));
  const w1 = await s2t(200 + 30, 400 + 20);
  await touch('touchEnd', []); await sleep(50);
  check('pinch + pan: tile under the midpoint follows the midpoint', near(w0.x, w1.x, 0.03) && near(w0.y, w1.y, 0.03) && cc.zoom > 12, `zoom ${cc.zoom.toFixed(2)} d=${Math.hypot(w0.x - w1.x, w0.y - w1.y).toFixed(3)}`);
  void mid;
}
{
  // crisp-zoom settle: 15 is within 9% of 16 (2 texels per device px at dpr 2) -> eases onto it after a gesture
  await setCam(48, 48, 15);
  await touch('touchStart', [[150, 400], [250, 400]]); await sleep(20); await touch('touchMove', [[150, 400], [250, 400]]); await sleep(20); await touch('touchEnd', []);
  await sleep(450);
  const c = await cam();
  check('zoom near a whole-texel value settles onto it', near(c.zoom, 16, 1e-6), 'zoom ' + c.zoom.toFixed(3));
  await setCam(48, 48, 12);
  await touch('touchStart', [[150, 400], [250, 400]]); await sleep(20); await touch('touchMove', [[150, 400], [250, 400]]); await sleep(20); await touch('touchEnd', []);
  await sleep(450);
  const c2 = await cam();
  check('zoom between crisp values is left alone', near(c2.zoom, 12, 1e-9), 'zoom ' + c2.zoom.toFixed(3));
}

// ------------------------------------------------------------------ touch: paint mode
section('touch input: paint mode');
await setMode('paint');
await clearEv();
await setCam(48, 48, 14);
{
  const c0 = await cam();
  await fastDrag(60, 300, 330, 560, 5, 12, true);
  await sleep(80);
  const ps = await paints(), c = await cam();
  let maxGap = 0, bad = 0;
  for (let i = 1; i < ps.length; i++) maxGap = Math.max(maxGap, Math.hypot(ps[i][0] - ps[i - 1][0], ps[i][1] - ps[i - 1][1]));
  for (let i = 0; i < ps.length; i++) if (i === 0 ? ps[i][2] !== 'start' : i === ps.length - 1 ? ps[i][2] !== 'end' : ps[i][2] !== 'move') bad++;
  const t0 = await s2t(60, 300);
  check('paint: start ... move ... end sequence', ps.length > 10 && bad === 0, ps.length + ' events');
  check('paint: first point is under the finger', near(ps[0][0], t0.x, 1e-6) && near(ps[0][1], t0.y, 1e-6));
  check('paint: no gaps on fast strokes (<=0.46 tile steps)', maxGap <= 0.46, 'max gap ' + maxGap.toFixed(3) + ' tiles');
  check('paint: camera does not move', near(c.x, c0.x, 1e-9) && near(c.y, c0.y, 1e-9));
}
{
  await clearEv();
  await b.tap(200, 400);
  const ps = await paints();
  check('paint: tap = start + end at the touched tile', ps.length === 2 && ps[0][2] === 'start' && ps[1][2] === 'end');
  await clearEv();
  await touch('touchStart', [[200, 400]]); await sleep(250); await touch('touchEnd', []); await sleep(50);
  const ps2 = await paints();
  check('paint: held finger = start (after the short delay) + end', ps2.length === 2 && ps2[0][2] === 'start' && ps2[1][2] === 'end');
}
{
  await clearEv();
  await setCam(48, 48, 12);
  await touch('touchStart', [[150, 400], [250, 400]]);
  for (let i = 1; i <= 8; i++) { await sleep(10); await touch('touchMove', [[150 - i * 4, 400], [250 + i * 4, 400]]); }
  await touch('touchEnd', []); await sleep(80);
  const ps = await paints(), c = await cam();
  check('paint mode: 2 fingers pinch-zoom and never paint', ps.length === 0 && c.zoom > 12, 'zoom ' + c.zoom.toFixed(2) + ', paints ' + ps.length);
  await clearEv();
  // stroke interrupted by a second finger ends cleanly
  await touch('touchStart', [[100, 300]]); await sleep(150); await touch('touchMove', [[130, 330]]); await sleep(20);
  await touch('touchStart', [[130, 330], [250, 500]]); await sleep(60); await touch('touchEnd', []); await sleep(60);
  const ps2 = await paints();
  check('paint: second finger ends the stroke exactly once', ps2.length > 0 && ps2[0][2] === 'start' && ps2.filter(p => p[2] === 'end').length === 1 && ps2[ps2.length - 1][2] === 'end', ps2.map(p => p[2][0]).join(''));
}
await setMode('pan');
await clearEv();

// ------------------------------------------------------------------ mouse
section('mouse input');
{
  await setCam(48, 48, 12);
  const m = b.page.mouse;
  await m.move(200, 400);
  await m.wheel(0, -400);
  await sleep(450);
  const c = await cam();
  check('wheel zooms in about the cursor', c.zoom > 14 && c.zoom < 26, 'zoom ' + c.zoom.toFixed(3));
  await setCam(48, 48, 14);
  await m.move(250, 450); await m.down(); await m.move(200, 400, { steps: 5 }); await m.up();
  const c2 = await cam();
  check('mouse drag pans', near(c2.x, 48 + 50 / 14, 0.6) && near(c2.y, 48 + 50 / 14, 0.6), c2.x.toFixed(3));
  await sleep(1200);                                   // let a possible drag glide finish (a click that stops a glide is swallowed)
  await clearEv();
  await m.click(100, 200);
  check('mouse click = tap', (await taps()) === 1);
  await b.page.keyboard.down('Shift');
  await m.move(100, 300); await m.down(); await m.move(180, 380, { steps: 4 }); await m.up();
  await b.page.keyboard.up('Shift');
  const ps = await paints();
  check('Shift+drag paints', ps.length > 3 && ps[0][2] === 'start' && ps[ps.length - 1][2] === 'end');
  const hv = await E(() => window.__rt.hovers.length);
  check('mouse move reports hover', hv > 0);
}

// ------------------------------------------------------------------ dirty-list baking
section('terrain cache / dirty list');
await setCam(48, 48, 24);
await frames(2);
{
  const spot = await E(() => {
    const S = window.__rt.S, R = window.__rt.Render, v = R.visibleRect();
    for (let y = v.y0 + 3; y < v.y1 - 3; y++) for (let x = v.x0 + 3; x < v.x1 - 3; x++) {
      const i = y * S.w + x;
      let ok = S.tile[i] === 3 && !S.res[i] && !S.bld[i];
      for (let d = 0; d < 9 && ok; d++) if (S.tile[i + (d % 3 - 1) + ((d / 3 | 0) - 1) * S.w] !== 3) ok = false;
      if (ok) return [x, y];
    }
    return null;
  });
  check('found a plain grass tile in view', !!spot, JSON.stringify(spot));
  if (spot) {
    const sc = await E(([x, y]) => window.__rt.Render.tileToScreen(x + 0.5, y + 0.5), spot);
    const before = await px(sc.x, sc.y);
    const queued = await E(([x, y]) => { const S = window.__rt.S; S.tile[y * S.w + x] = 8; S.elev[y * S.w + x] = 200; S.markDirty(x, y); S.markDirty(x - 1, y); S.markDirty(x + 1, y); S.markDirty(x, y - 1); S.markDirty(x, y + 1); return S.dirtyList.length; }, spot);
    await frames(3);
    const after = await px(sc.x, sc.y), left = await E(() => window.__rt.S.dirtyList.length);
    check('markDirty queues tiles and Render consumes + clears the list', queued === 5 && left === 0, queued + ' -> ' + left);
    check('dirty tile repainted (grass -> lava is now orange)', after[0] > 150 && after[2] < 110 && !(before[0] > 150 && before[2] < 110), `rgb ${before} -> ${after}`);
    await E(([x, y]) => { const S = window.__rt.S; S.tile[y * S.w + x] = 0; S.markDirty(x, y); }, spot);
    await frames(3);
    const deep = await px(sc.x, sc.y);
    check('dirty tile repainted (lava -> deep water is now blue)', deep[2] > deep[0] + 40, `rgb ${deep}`);
    await E(([x, y]) => { const S = window.__rt.S; S.tile[y * S.w + x] = 3; S.elev[y * S.w + x] = 134; S.markDirty(x, y); }, spot);
    await frames(2);
    await E(() => { window.__rt.still = false; });
  }
}
{
  const r = await E(async () => {
    const S = window.__rt.S, R = window.__rt.Render;
    const t0 = performance.now(); S.allDirty = true; R.draw(0, performance.now()); const full = performance.now() - t0;
    const flag = S.allDirty;
    // 600 dirty tiles: baked in time slices
    let n = 0; for (let i = 0; i < 600; i++) { const x = 10 + (i * 7) % 70, y = 10 + (i * 13) % 70; S.markDirty(x, y); n++; }
    const queued = S.dirtyList.length;
    const t1 = performance.now(); R.draw(0, performance.now()); const slice = performance.now() - t1;
    let fr = 1; while (S.dirtyList.length && fr < 40) { R.draw(0, performance.now()); fr++; }
    return { full, flag, queued, slice, fr, left: S.dirtyList.length };
  });
  check('allDirty => full re-bake, flag cleared', r.flag === false, r.full.toFixed(0) + ' ms for ' + 96 * 96 + ' tiles');
  check('full bake is fast enough (<600 ms, headless software canvas)', r.full < 600, r.full.toFixed(0) + ' ms');
  check('large dirty batches are time-sliced and fully drained', r.left === 0 && r.slice < 40, `first frame ${r.slice.toFixed(1)} ms, drained in ${r.fr} frames (${r.queued} queued)`);
}

// ------------------------------------------------------------------ fire
section('fire');
{
  await E(() => { window.__rt.still = true; });
  const f = await E(() => { const S = window.__rt.S; for (let i = 0; i < S.fire.length; i++) if (S.fire[i]) return [i % S.w, (i / S.w) | 0]; return null; });
  check('bootstrap has burning tiles', !!f);
  if (f) {
    await setCam(f[0] + 0.5, f[1] + 0.5, 20);
    await frames(3);
    const sc = await E(([x, y]) => window.__rt.Render.tileToScreen(x + 0.5, y + 0.5), f);
    const flamepx = () => E(([sx, sy]) => {
      const d = window.__rt.Render.size.dpr, g = window.__rt.Render.canvas.getContext('2d');
      const im = g.getImageData(Math.round((sx - 10) * d), Math.round((sy - 10) * d), Math.round(20 * d), Math.round(20 * d)).data;
      let n = 0; for (let i = 0; i < im.length; i += 4) if (im[i] > 225 && im[i + 1] > 110 && im[i + 1] < 235 && im[i + 2] < 90) n++;
      return n;
    }, [sc.x, sc.y]);
    const on = await flamepx();
    await E(([x, y]) => { const S = window.__rt.S; window.__fireSave = S.fire[y * S.w + x]; S.fire[y * S.w + x] = 0; }, f);
    await frames(3);
    const off = await flamepx();
    await E(([x, y]) => { const S = window.__rt.S; S.fire[y * S.w + x] = window.__fireSave; }, f);
    check('S.fire tiles show animated flames', on > 40 && off < on / 3, `flame px ${off} -> ${on}`);
    await shot('13_fire_z20');
  }
  await E(() => { window.__rt.still = false; });
}

// ------------------------------------------------------------------ overlays / entities / labels
section('overlays, highlight, brush, labels');
const c0 = await E(() => ({ x: window.__rt.cities[0].x, y: window.__rt.cities[0].y, id: window.__rt.cities[0].id }));
await E(() => { window.__rt.still = true; window.__rt.Fx.clear(); });
{
  // a grass tile owned by city 0, away from buildings, inside its territory
  const spot = await E(() => {
    const rt = window.__rt, S = rt.S, c = rt.cities[0];
    for (let r = 3; r < 7; r++) for (let a = 0; a < 16; a++) {
      const x = Math.round(c.x + Math.cos(a / 16 * 6.283) * r), y = Math.round(c.y + Math.sin(a / 16 * 6.283) * r), i = y * S.w + x;
      if (S.owner[i] === c.id && S.tile[i] === 3 && !S.res[i] && !S.bld[i]) return [x, y];
    }
    return null;
  });
  await setCam(spot[0] + 0.5, spot[1] + 0.5, 14);
  await frames(2);
  const sc = await E(([x, y]) => window.__rt.Render.tileToScreen(x + 0.5, y + 0.5), spot);
  await E(() => window.__rt.Render.setMode(0)); await frames(2);
  const p0 = await px(sc.x, sc.y);
  await E(() => window.__rt.Render.setMode(1)); await frames(3);
  const p1 = await px(sc.x, sc.y);
  await E(() => window.__rt.Render.setMode(2)); await frames(3);
  const p2 = await px(sc.x, sc.y);
  const d01 = Math.abs(p0[0] - p1[0]) + Math.abs(p0[1] - p1[1]) + Math.abs(p0[2] - p1[2]);
  const d02 = Math.abs(p0[0] - p2[0]) + Math.abs(p0[1] - p2[1]) + Math.abs(p0[2] - p2[2]);
  check('BORDERS mode tints owned tiles', d01 > 25, `normal ${p0} -> borders ${p1}`);
  check('CULTURE mode tints owned tiles differently', d02 > 25 && Math.abs(p1[0] - p2[0]) + Math.abs(p1[2] - p2[2]) > 15, `culture ${p2}`);
  await E(() => window.__rt.Render.setMode(1)); await frames(2);
  const dbg = await E(() => window.__rt.Render.debugInfo());
  check('border outline segments built', dbg.borderSegments > 20, dbg.borderSegments + ' runs');
  // territory change => overlay rebuilt (throttled)
  const before = await E(() => window.__rt.Render.debugInfo().overlayVer);
  await E(() => { const S = window.__rt.S; S.owner.fill(0); S.touchOwner(); });
  await sleep(500); await frames(2);
  const dbg2 = await E(() => window.__rt.Render.debugInfo());
  const p3 = await px(sc.x, sc.y);
  check('S.ownerVer change rebuilds the overlay', dbg2.overlayVer !== before && dbg2.borderSegments === 0, `ver ${before} -> ${dbg2.overlayVer}`);
  check('cleared territory shows no tint', Math.abs(p3[0] - p0[0]) + Math.abs(p3[1] - p0[1]) + Math.abs(p3[2] - p0[2]) < 30, `rgb ${p3}`);
  // restore territories (same recipe as the bootstrap)
  await E(() => {
    const rt = window.__rt, S = rt.S, T = rt.Const.T;
    for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) {
      if (S.tile[y * S.w + x] < T.SAND || S.tile[y * S.w + x] === T.LAVA) continue;
      let best = 0, bd = 1e9;
      for (const c of rt.cities) { const d = Math.hypot(c.x - x, c.y - y); if (d < c.radius + 0.5 && d < bd) { bd = d; best = c.id; } }
      S.owner[y * S.w + x] = best;
    }
    S.touchOwner();
  });
  await E(() => window.__rt.Render.setMode(0));
}
{
  // two neighbouring cities of one kingdom -> dashed separator
  const made = await E(() => {
    const rt = window.__rt, S = rt.S, c = rt.cities[0], k = S.kingdoms.get(c.kingdomId);
    const id = S.id();
    const c2 = { id, name: 'Соседград', race: c.race, kingdomId: k.id, x: c.x + 7, y: c.y, pop: 12, members: [], stock: {}, radius: 6, level: 1, loyalty: 80, culture: c.culture, founded: 0, buildings: [], hist: [], mod: {} };
    S.cities.set(id, c2); k.cities.push(id);
    for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) {
      const i = y * S.w + x;
      if (S.tile[i] < 2 || S.tile[i] === 8) continue;
      if (S.owner[i] === c.id && Math.hypot(x - c2.x, y - c2.y) < Math.hypot(x - c.x, y - c.y)) S.owner[i] = id;
      else if (!S.owner[i] && Math.hypot(x - c2.x, y - c2.y) < 6.5) S.owner[i] = id;
    }
    S.touchOwner();
    return { x: c2.x, y: c2.y };
  });
  await setCam(c0.x + 3.5, c0.y, 14);
  await E(() => window.__rt.Render.setMode(1));
  await sleep(400); await frames(3);
  const dbg = await E(() => window.__rt.Render.debugInfo());
  check('dashed separator between cities of one kingdom', dbg.innerSegments >= 1, dbg.innerSegments + ' inner runs');
  await shot('10_borders_dashed');
  void made;
}
{
  await E(() => window.__rt.Render.setMode(0));
  await setCam(c0.x, c0.y, 12);
  await frames(2);
  const a = await E(() => { const R = window.__rt.Render; R.highlight = null; return true; });
  const bld = await E(() => { const rt = window.__rt, b = rt.buildings.find(v => v.cityId === rt.cities[0].id && v.type === 1); return { id: b.id, x: b.x, y: b.y }; });
  const sc = await E(([x, y]) => window.__rt.Render.tileToScreen(x, y), [bld.x, bld.y]);
  await E(([id, x, y]) => { window.__rt.autoHighlight = false; window.__rt.Render.highlight = { type: 'building', id, x, y }; }, [bld.id, bld.x, bld.y]);
  await frames(2);
  // the ring is yellow (#ffe36e): scan a frame around the building tile
  const hit = await E(([sx, sy, z]) => {
    const d = window.__rt.Render.size.dpr, g = window.__rt.Render.canvas.getContext('2d');
    const x0 = Math.round((sx - z * 0.4) * d), y0 = Math.round((sy - z * 0.4) * d), w = Math.round(z * 1.8 * d), h = Math.round(z * 1.8 * d);
    const im = g.getImageData(Math.max(0, x0), Math.max(0, y0), w, h).data;
    let n = 0; for (let i = 0; i < im.length; i += 4) if (im[i] > 240 && im[i + 1] > 205 && im[i + 1] < 245 && im[i + 2] > 80 && im[i + 2] < 140) n++;
    return n;
  }, [sc.x, sc.y, 12]);
  check('selection bracket is drawn around the highlighted building', hit > 20, hit + ' yellow px');
  await shot('11_highlight_building');
  await E(() => { window.__rt.Render.highlight = null; });
  await frames(2);
  const hit0 = await E(([sx, sy, z]) => {
    const d = window.__rt.Render.size.dpr, g = window.__rt.Render.canvas.getContext('2d');
    const x0 = Math.round((sx - z * 0.4) * d), y0 = Math.round((sy - z * 0.4) * d), w = Math.round(z * 1.8 * d), h = Math.round(z * 1.8 * d);
    const im = g.getImageData(Math.max(0, x0), Math.max(0, y0), w, h).data;
    let n = 0; for (let i = 0; i < im.length; i += 4) if (im[i] > 240 && im[i + 1] > 205 && im[i + 1] < 245 && im[i + 2] > 80 && im[i + 2] < 140) n++;
    return n;
  }, [sc.x, sc.y, 12]);
  check('highlight = null removes the bracket', hit0 < hit / 3, hit0 + ' yellow px');
  // brush preview
  await E(() => { window.__rt.brushOn = false; window.__rt.Render.brush = { x: 40, y: 40, r: 4 }; });
  await setCam(40.5, 40.5, 12);
  await frames(2);
  const cnt = () => E(() => {
    const d = window.__rt.Render.size.dpr, g = window.__rt.Render.canvas.getContext('2d'), c = window.__rt.Render.canvas;
    const im = g.getImageData(0, Math.round(c.height / 2 - 60 * d), c.width, Math.round(120 * d)).data;
    let n = 0; for (let i = 0; i < im.length; i += 4) if (im[i] > 205 && im[i + 1] > 205 && im[i + 2] > 205) n++;
    return n;
  });
  const withBrush = await cnt();
  await E(() => { window.__rt.Render.brush = null; });
  await frames(2);
  const noBrush = await cnt();
  check('brush preview circle is drawn', withBrush > noBrush + 30, `white px ${noBrush} -> ${withBrush}`);
  await E(() => { window.__rt.Render.brush = { x: 40, y: 40, r: 4 }; });
  await frames(2);
  await shot('12_brush_preview');
  await E(() => { window.__rt.Render.brush = null; window.__rt.brushOn = true; window.__rt.autoHighlight = true; });
  // city labels need zoom >= 9
  await setCam(c0.x, c0.y, 12); await frames(3);
  const whiteLabel = async () => {
    const sc = await E(([x, y]) => window.__rt.Render.tileToScreen(x + 0.5, y), [c0.x, c0.y]);
    return E(([sx, sy]) => {
      const d = window.__rt.Render.size.dpr, g = window.__rt.Render.canvas.getContext('2d');
      const im = g.getImageData(Math.round((sx - 70) * d), Math.round((sy - 28) * d), Math.round(140 * d), Math.round(26 * d)).data;
      let n = 0; for (let i = 0; i < im.length; i += 4) if (im[i] > 250 && im[i + 1] > 250 && im[i + 2] > 250) n++;
      return n;
    }, [sc.x, sc.y]);
  };
  const lab12 = await whiteLabel();
  await setCam(c0.x, c0.y, 7); await frames(3);
  const lab7 = await whiteLabel();
  check('city label (white outlined text) drawn at zoom >= 9 only', lab12 > 40 && lab7 < lab12 / 4, `white px ${lab12} at z12, ${lab7} at z7`);
}
await E(() => { window.__rt.still = false; });

// ------------------------------------------------------------------ effects / entities visual set
section('effects & screenshots');
{
  await E(() => window.__rt.demoEffects());
  await setCam(48, 48, 14);
  await sleep(350);
  await shot('20_effects_z14');
  check('no console errors with S.eff + Fx drawing', b.errors.length === 0, b.errors[0] || '');
  await E(() => { const S = window.__rt.S; S.eff.meteors.length = 0; S.eff.tornados.length = 0; S.eff.rains.length = 0; S.eff.quakes.length = 0; });
  for (const z of [3, 6, 10, 16, 28, 48]) {
    await setCam(c0.x, c0.y, z);
    await sleep(350);
    await shot('30_zoom_' + z);
  }
  for (const [m, n] of [[0, 'normal'], [1, 'borders'], [2, 'culture']]) {
    await E(m => window.__rt.Render.setMode(m), m);
    await setCam(c0.x, c0.y, 9);
    await sleep(500);
    await shot('40_mode_' + n + '_z9');
    await setCam(48, 48, 4.2);
    await sleep(500);
    await shot('41_mode_' + n + '_overview');
  }
  await E(() => window.__rt.Render.setMode(0));
}

// ------------------------------------------------------------------ resize / orientation
section('resize');
{
  await setCam(48, 48, 14);
  await b.page.setViewportSize({ width: 844, height: 390 });
  await sleep(500);
  const r = await E(() => ({ size: window.__rt.Render.size, cw: window.__rt.Render.canvas.width, ch: window.__rt.Render.canvas.height, cam: { ...window.__rt.Render.cam } }));
  check('orientation change resizes the backing store', r.size.w === 844 && r.size.h === 390 && r.cw === 1688 && r.ch === 780, `${r.cw}x${r.ch}`);
  const fitZ = await E(() => window.__rt.Render.minZoom());
  check('min zoom adapts (whole map fits the short side)', near(fitZ, 390 / 96, 1e-6), fitZ.toFixed(3));
  await shot('50_landscape');
  // input still works after the resize
  await clearEv();
  await setCam(48, 48, 14);
  const t0 = await s2t(600, 200);
  await b.tap(600, 200);
  const tp = await E(() => window.__rt.taps[0]);
  check('tap coordinates correct after resize', tp && near(tp[0], t0.x, 1e-6) && near(tp[1], t0.y, 1e-6), tp ? tp.map(v => v.toFixed(2)).join(',') : 'none');
  await fastDrag(500, 200, 400, 150, 6, 8, false);
  const c = await cam();
  check('drag still pans after resize', near(c.x, 48 + 100 / 14, 1e-6) && near(c.y, 48 + 50 / 14, 1e-6));
  await touch('touchEnd', []);
  await b.page.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  const r2 = await E(() => ({ size: window.__rt.Render.size, cw: window.__rt.Render.canvas.width }));
  check('back to portrait', r2.size.w === 390 && r2.cw === 780);
  const dp = await E(() => { window.__rt.Render.resize(390, 844, 3); const d = window.__rt.Render.size.dpr; window.__rt.Render.resize(390, 844, 2); return d; });
  check('devicePixelRatio is clamped to 2', dp === 2, String(dp));
}

// ------------------------------------------------------------------ performance
section('performance (headless Chromium, software GL)');
{
  await E(() => { window.__rt.still = false; window.__rt.spawn(1500 - window.__rt.units.length); });
  const nUnits = await E(() => window.__rt.S.units.size);
  await E(() => {
    const rt = window.__rt, S = rt.S, R = rt.Render;
    R.setCamera(S.w / 2, S.h / 2, 8);
    const r = R.visibleRect();
    for (const u of rt.units) {
      for (let t = 0; t < 60; t++) {
        const x = r.x0 + Math.random() * (r.x1 - r.x0), y = r.y0 + Math.random() * (r.y1 - r.y0), tt = S.tile[(y | 0) * S.w + (x | 0)];
        if (tt >= 2 && tt !== 8) { u.x = u.px = x; u.y = u.py = y; break; }
      }
    }
  });
  await sleep(1800);
  const perf = {};
  for (const z of [8, 4, 16, 24]) {
    await setCam(48, 48, z);
    await sleep(2200);
    const st = await E(() => ({ ...window.__rt.Render.stats }));
    const f = await b.fps(2000);
    // CPU time of a draw call, measured around Render.draw directly
    const own = await E(() => { const R = window.__rt.Render; const ts = []; for (let i = 0; i < 90; i++) { const t0 = performance.now(); R.draw(0.5, performance.now()); ts.push(performance.now() - t0); } ts.sort((a, b) => a - b); return { avg: ts.reduce((a, b) => a + b, 0) / ts.length, p95: ts[Math.floor(ts.length * 0.95)] }; });
    perf[z] = { st, fps: f.fps, p95: f.p95, own };
    console.log(`  zoom ${String(z).padStart(2)}: visibleUnits ${String(st.visibleUnits).padStart(4)}  Render.stats.drawMs ${st.drawMs.toFixed(2)}  measured draw avg ${own.avg.toFixed(2)} p95 ${own.p95.toFixed(2)} ms  rAF ${f.fps.toFixed(1)} fps (p95 frame ${f.p95.toFixed(1)} ms)`);
  }
  check('1500 units alive in the test world', nUnits >= 1500, String(nUnits));
  check('~1500 units visible at zoom 8', perf[8].st.visibleUnits > 1100, String(perf[8].st.visibleUnits));
  check('Render.stats.drawMs < 8 ms with 1500 units at zoom 8', perf[8].st.drawMs < 8, perf[8].st.drawMs.toFixed(2) + ' ms');
  check('drawMs < 8 ms at the other zoom levels', [4, 16, 24].every(z => perf[z].st.drawMs < 8));
  // back-to-back synchronous draws also pay the software rasteriser (swiftshader), so this is a loose upper bound only
  check('back-to-back draw() loop stays reasonable even on the software rasteriser (<25 ms)', [8, 4, 16, 24].every(z => perf[z].own.avg < 25), [8, 4, 16, 24].map(z => perf[z].own.avg.toFixed(1)).join('/') + ' ms');
  check('Render.stats are populated', perf[8].st.fps > 20 && perf[8].st.visibleTiles > 1000, JSON.stringify(perf[8].st));
  check('holds ~60 fps (headless)', perf[8].fps > 50, perf[8].fps.toFixed(1) + ' fps');
  await setCam(48, 48, 8);
  await sleep(300);
  await shot('60_perf_1500_units_z8');
}

// ------------------------------------------------------------------ new world / save-load style reset
section('world replaced at runtime');
{
  await E(() => { window.__rt.still = true; });
  const r = await E(async () => {
    const rt = window.__rt, S = rt.S, R = rt.Render;
    S.units.clear(); S.buildings.clear(); S.cities.clear(); S.kingdoms.clear();
    window.__rt.World.generate({ seed: 3, w: 64, h: 64 });
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    return { w: S.w, allDirty: S.allDirty, minZ: R.minZoom(), cam: { ...R.cam }, dbg: R.debugInfo() };
  });
  check('smaller world: cache re-allocated, dirty flags consumed', r.w === 64 && r.allDirty === false && r.dbg.W === 64, JSON.stringify(r.dbg));
  check('camera re-clamped for the new world', r.cam.x <= 64 && r.cam.y <= 64 && r.cam.zoom >= r.minZ - 1e-9, JSON.stringify(r.cam));
  await shot('70_new_world_64');
  const r2 = await E(async () => {
    window.__rt.World.generate({ seed: 5, w: 64, h: 64 });
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    return { allDirty: window.__rt.S.allDirty };
  });
  check('same-size regeneration reuses canvases and re-bakes', r2.allDirty === false);
}
check('no console errors in the whole run', b.errors.length === 0, b.errors[0] || '');
await b.close();

// ------------------------------------------------------------------ big maps (separate page loads)
section('map sizes');
for (const size of [128, 260]) {
  const bb = await launch({ url: 'file://' + HTML + `?still=1&units=300&size=${size}&seed=11&cities=10`, verbose: true });
  await bb.wait(1500);
  const r = await bb.eval(() => { const R = window.__rt.Render, t0 = performance.now(); R.invalidate(); R.draw(0, performance.now()); return { ms: performance.now() - t0, dbg: R.debugInfo(), frames: window.__rt.frames, errs: 0 }; });
  await bb.eval(() => window.__rt.Render.setCamera(window.__rt.S.w / 2, window.__rt.S.h / 2, 6));
  await bb.wait(500);
  await bb.shot(path.join(SHOTS, `80_size_${size}.png`));
  check(`${size}x${size} map renders (tile cache ${r.dbg.P}px/tile), full bake ${r.ms.toFixed(0)} ms`, r.dbg.W === size && r.frames > 3 && bb.errors.length === 0 && r.ms < 4000, bb.errors[0] || '');
  await bb.close();
}

console.log(`\n${pass} passed, ${fail} failed.  Screenshots: ${SHOTS}`);
if (fail) { console.log('FAILED: ' + failures.join('; ')); process.exit(1); }
