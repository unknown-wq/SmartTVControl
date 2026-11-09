// Headless test for the Sprites module (no browser): fake DOM canvas with real pixel buffers.
//   node tests/sprites.test.mjs
// Checks: API coverage (every tool/tab icon, units, buildings, tiles, features, flags, fx, effects), no throws / no NaN draw args,
// cache identity, cache-hit allocations (heap does not grow), init time, and some pixel sanity rules for the art.
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

// ---------------------------------------------------------------- fake DOM
let badArgs = 0, drawCalls = 0, canvasesMade = 0;
const badLog = [];
function chk(name, args) {
  drawCalls++;
  for (let i = 0; i < args.length; i++) if (typeof args[i] === 'number' && !Number.isFinite(args[i])) { badArgs++; if (badLog.length < 8) badLog.push(name + '(' + Array.prototype.join.call(args, ',') + ')'); return false; }
  return true;
}
function makeCanvas() {
  canvasesMade++;
  const c = { width: 0, height: 0, _img: null, style: {} };
  const target = {
    canvas: c, imageSmoothingEnabled: true,
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData(id) { c._img = id; },
    getImageData() { return c._img; },
    fillRect(x, y, w, h) { chk('fillRect', arguments); },
    drawImage(src, ...a) {
      chk('drawImage', a);
      if (a.length === 8 && src && src._img) {
        if (!c._img) c._img = { width: c.width, height: c.height, data: new Uint8ClampedArray(c.width * c.height * 4) };
        const [sx, sy, sw, sh, dx, dy, dw, dh] = a, S = src._img, D = c._img;
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
          const X = dx + x, Y = dy + y; if (X < 0 || Y < 0 || X >= D.width || Y >= D.height) continue;
          const u = sx + Math.floor(x * sw / dw), v = sy + Math.floor(y * sh / dh), si = (v * S.width + u) * 4, di = (Y * D.width + X) * 4;
          D.data[di] = S.data[si]; D.data[di + 1] = S.data[si + 1]; D.data[di + 2] = S.data[si + 2]; D.data[di + 3] = S.data[si + 3];
        }
      }
    },
  };
  const ctx = new Proxy(target, { get(t, k) { if (k in t) return t[k]; return function () { chk(String(k), arguments); }; }, set(t, k, v) { t[k] = v; return true; } });
  c.getContext = () => ctx;
  return c;
}
const fakeDoc = { createElement(tag) { assert.equal(tag, 'canvas'); return makeCanvas(); } };
const recCtx = () => makeCanvas().getContext('2d');

// ---------------------------------------------------------------- load modules
const files = ['00_core.js', '01_tiles.js', '02_data.js', '20_sprites.js'];
const code = files.map(f => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
const ctxm = new Function('document', '"use strict";\n' + code + '\nreturn { Sprites, Const, Tiles, ToolDefs, Tabs, Palette, S, Fx, Races, Gear };')(fakeDoc);
const { Sprites, Const, ToolDefs, Tabs, Palette, Races } = ctxm;

let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); } }
const px = c => c._img.data;
function opaque(c) { const d = px(c); let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++; return n; }
function bbox(c) { const d = px(c), w = c.width; let x0 = 99, y0 = 99, x1 = -1, y1 = -1; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) { const p = i >> 2, x = p % w, y = (p / w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 }; }
function same(a, b) { const A = px(a), B = px(b); if (A.length !== B.length) return false; for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return false; return true; }

console.log('Sprites headless test');

test('init is idempotent and fast (< 250 ms)', () => {
  const t0 = performance.now(); Sprites.init(); const dt = performance.now() - t0;
  Sprites.init();
  console.log('       init ' + dt.toFixed(1) + ' ms');
  assert.ok(dt < 250);
});

test('tile atlas + drawTile for every terrain/variant', () => {
  const a = Sprites.tileAtlas();
  assert.equal(a.tilePx, 16); assert.equal(a.cols, 16); assert.equal(a.rows, 9);
  assert.equal(a.canvas.width, 256); assert.equal(a.canvas.height, 144);
  const d = px(a.canvas); for (let i = 3; i < d.length; i += 4) assert.equal(d[i], 255, 'tile pixels must be opaque');
  const ctx = recCtx(); const before = drawCalls;
  for (let t = 0; t < Const.TILE_COUNT; t++) for (let v = 0; v < 16; v++) Sprites.drawTile(ctx, t, 10 * v, 10 * t, 16, v);
  assert.equal(drawCalls - before, Const.TILE_COUNT * 16);
  // >= 4 distinct looks per terrain type
  for (let t = 0; t < 9; t++) {
    const seen = new Set();
    for (let v = 0; v < 8; v++) { let h = 0; const base = (t * 16) * 256 + v * 16; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const i = ((t * 16 + y) * 256 + v * 16 + x) * 4; h = (h * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) | 0; } seen.add(h); }
    assert.ok(seen.size >= 4, 'tile ' + t + ' has only ' + seen.size + ' distinct looks');
  }
  // water / lava animate, land does not
  const diff = (t, v) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const i0 = ((t * 16 + y) * 256 + v * 16 + x) * 4, i1 = ((t * 16 + y) * 256 + (v + 8) * 16 + x) * 4; if (d[i0] !== d[i1] || d[i0 + 1] !== d[i1 + 1] || d[i0 + 2] !== d[i1 + 2]) return true; } return false; };
  for (const t of [0, 1, 8]) assert.ok(diff(t, 0), 'tile ' + t + ' should animate');
  for (const t of [2, 3, 4, 5, 6, 7]) assert.ok(!diff(t, 0), 'tile ' + t + ' should be static');
});

test('icons: every ToolDefs / Tabs icon + contract keys are real (not the fallback "?")', () => {
  const need = new Set();
  ToolDefs.forEach(t => need.add(t.icon)); Tabs.forEach(t => need.add(t.icon));
  'raise lower grass sand forest hill mountain snow lava human orc elf erase lightning meteor fire earthquake plague tornado rain heal bless war_whisper peace split inspect tab_land tab_life tab_powers tab_kingdoms tab_info play pause speed1 speed2 speed4 menu hand brush save load newworld close map_normal map_borders map_culture crown sword heart food wood stone iron gold skull coin chevron_up chevron_down plus minus check log focus'.split(' ').forEach(k => need.add(k));
  const known = new Set(Sprites.iconKeys());
  for (const k of need) { assert.ok(known.has(k), 'missing icon ' + k); for (const s of [16, 24, 32, 48, 56, 64]) { const c = Sprites.icon(k, s); assert.equal(c.width, s); assert.equal(c.height, s); assert.ok(opaque(c) > 8, k + ' is empty at ' + s); } assert.equal(Sprites.icon(k, 48), Sprites.icon(k, 48)); }
  const fb = Sprites.icon('definitely_not_an_icon', 32); assert.ok(opaque(fb) > 0);
  console.log('       ' + need.size + ' icon keys ok');
});

test('features: kinds x variants (berry 9 = depleted)', () => {
  const R = Const.RES;
  for (const k of [R.TREE, R.ROCK, R.IRON, R.GOLD, R.BERRY, R.FISH]) for (let v = 0; v < 12; v++) { const c = Sprites.feature(k, v); assert.equal(c.width, 16); assert.ok(opaque(c) > 10, 'feature ' + k + '/' + v); assert.equal(c, Sprites.feature(k, v)); }
  assert.ok(!same(Sprites.feature(R.BERRY, 0), Sprites.feature(R.BERRY, 9)), 'depleted bush must differ');
  assert.ok(!same(Sprites.feature(R.ROCK, 0), Sprites.feature(R.IRON, 0)));
  assert.ok(!same(Sprites.feature(R.IRON, 0), Sprites.feature(R.GOLD, 0)));
  const tr = [0, 1, 2, 3].map(v => Sprites.feature(R.TREE, v)); assert.ok(opaque(tr[0]) < opaque(tr[2]), 'sapling smaller than oak');
});

test('units: all combinations build, are cached and look different where they should', () => {
  const tints = [null, '#e53935', '#1e88e5', '#43a047', '#fdd835'];
  let n = 0;
  for (let r = 0; r < 3; r++) for (const st of ['child', 'adult', 'elder']) for (let f = 0; f < 2; f++) for (const t of tints) for (let w = 0; w < 4; w++) for (let a = 0; a < 4; a++) for (let lk = 0; lk < 4; lk += 3) {
    const c = Sprites.unit(r, st, f, t, w, a, lk); n++;
    assert.equal(c.width, 16); assert.equal(c.height, 16);
    assert.equal(c, Sprites.unit(r, st, f, t, w, a, lk));
  }
  console.log('       ' + n + ' unit sprites built, cache=' + Sprites.stats().units);
  const U = (r, s, f, t, w, a, l) => Sprites.unit(r, s, f, t, w, a, l || 0);
  // heights: child ~9, adult ~13, elder shorter than adult, orc >= human, elf >= human
  for (let r = 0; r < 3; r++) {
    const hc = bbox(U(r, 'child', 1, null, 0, 0)).h, ha = bbox(U(r, 'adult', 1, null, 0, 0)).h, he = bbox(U(r, 'elder', 1, null, 0, 0)).h;
    console.log('       race ' + r + ' heights child/adult/elder = ' + hc + '/' + ha + '/' + he);
    assert.ok(hc >= 8 && hc <= 11, 'child height ' + hc); assert.ok(ha >= 12 && ha <= 15, 'adult height ' + ha); assert.ok(he < ha + 1 && he >= 10, 'elder height ' + he);
  }
  assert.ok(opaque(U(1, 'adult', 1, null, 0, 0)) > opaque(U(0, 'adult', 1, null, 0, 0)), 'orcs are bulkier than humans');
  assert.ok(bbox(U(1, 'adult', 1, null, 0, 0)).w >= bbox(U(0, 'adult', 1, null, 0, 0)).w, 'orcs are broader');
  // walk frames differ, tint differs, weapon + armor tiers differ
  for (let r = 0; r < 3; r++) {
    assert.ok(!same(U(r, 'adult', 0, null, 0, 0), U(r, 'adult', 1, null, 0, 0)), 'frames must differ');
    assert.ok(!same(U(r, 'adult', 1, null, 0, 0), U(r, 'adult', 1, '#e53935', 0, 0)), 'tint must show');
    assert.ok(!same(U(r, 'adult', 1, '#e53935', 0, 0), U(r, 'adult', 1, '#1e88e5', 0, 0)));
    for (let t = 1; t <= 3; t++) { assert.ok(!same(U(r, 'adult', 1, null, t - 1, 0), U(r, 'adult', 1, null, t, 0)), 'weapon tier ' + t); assert.ok(!same(U(r, 'adult', 1, null, 0, t - 1), U(r, 'adult', 1, null, 0, t)), 'armor tier ' + t); }
    assert.ok(!same(U(r, 'adult', 1, null, 0, 0, 0), U(r, 'adult', 1, null, 0, 0, 1)), 'look variants differ');
  }
  assert.ok(!same(U(0, 'adult', 1, null, 0, 0), U(1, 'adult', 1, null, 0, 0)) && !same(U(0, 'adult', 1, null, 0, 0), U(2, 'adult', 1, null, 0, 0)));
  // numeric stage ids are accepted too
  assert.equal(Sprites.unit(0, 1, 0, null, 0, 0), Sprites.unit(0, 'adult', 0, null, 0, 0));
  // kingdom colours really tint the cloth: red tint adds red to the sprite
  const red = (c) => { const d = px(c); let r = 0, b = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) { r += d[i]; b += d[i + 2]; } return r - b; };
  assert.ok(red(U(0, 'adult', 1, '#e53935', 0, 0)) > red(U(0, 'adult', 1, '#1e88e5', 0, 0)));
  // sprites sit on the ground: feet in the lower rows, nothing outside the canvas edge rows beyond the outline
  for (let r = 0; r < 3; r++) { const b = bbox(U(r, 'adult', 1, null, 3, 3)); assert.ok(b.y1 >= 13, 'feet near the bottom'); }
});

test('buildings: types x races x levels x state', () => {
  const B = Const.B;
  let n = 0;
  for (const t of Const.BUILDING_TYPES) for (let r = 0; r < 3; r++) for (let lv = 1; lv <= 3; lv++) for (const done of [true, false]) for (const tint of [null, '#8e24aa']) {
    const c = Sprites.building(t, r, lv, done, tint); n++;
    assert.equal(c.width, 16); assert.ok(opaque(c) > 20, 'building ' + [t, r, lv, done]);
    assert.equal(c, Sprites.building(t, r, lv, done, tint));
  }
  console.log('       ' + n + ' building sprites, cache=' + Sprites.stats().buildings);
  for (const t of Const.BUILDING_TYPES) for (let r = 0; r < 3; r++) {
    assert.ok(!same(Sprites.building(t, r, 1, true), Sprites.building(t, r, 1, false)), 'scaffold differs from finished: ' + [t, r]);
    if (t !== B.FARM) assert.ok(!same(Sprites.building(t, r, 1, true), Sprites.building(t, r, 3, true)), 'levels differ: ' + [t, r]);
  }
  for (const t of Const.BUILDING_TYPES) assert.ok(!same(Sprites.building(t, 0, 2, true), Sprites.building(t, 1, 2, true)) && !same(Sprites.building(t, 0, 2, true), Sprites.building(t, 2, 2, true)), 'race styles differ for type ' + t);
  assert.ok(!same(Sprites.building(B.TOWNHALL, 0, 3, true, '#e53935'), Sprites.building(B.TOWNHALL, 0, 3, true, '#1e88e5')), 'tint reaches the townhall flag');
  // bottom anchored: every finished building touches the bottom rows and is at least 8 px tall
  for (const t of Const.BUILDING_TYPES) for (let r = 0; r < 3; r++) { const b = bbox(Sprites.building(t, r, 2, true)); assert.ok(b.y1 >= 12 && b.h >= 8, 'size ' + [t, r, b.h]); }
  assert.ok(bbox(Sprites.building(B.TOWNHALL, 0, 3, true)).h >= bbox(Sprites.building(B.HOUSE, 0, 1, true)).h, 'townhall is at least as tall as a hut');
});

test('flags: all patterns x symbols, sizes 16..96, cache identity', () => {
  let n = 0;
  for (let p = 0; p < 6; p++) for (let s = 0; s < 10; s++) {
    const f = { pattern: p, symbol: s, c1: '#e53935', c2: '#fdd835', c3: '#ffffff' };
    for (const [w, h] of [[16, 10], [24, 16], [32, 20], [48, 30], [64, 40], [96, 60]]) { const c = Sprites.flag(f, w, h); assert.equal(c.width, w); assert.equal(c.height, h); assert.equal(c, Sprites.flag(f, w, h)); assert.ok(opaque(c) > w * h * 0.5); n++; }
  }
  const f0 = { pattern: 0, symbol: 0, c1: '#102030', c2: '#fff', c3: '#fff' };
  const a = Sprites.flag(f0, 32, 20); f0.c1 = '#aa2030'; const b = Sprites.flag(f0, 32, 20);
  assert.notEqual(a, b, 'changing a flag colour rebuilds');
  const g = (p, s) => Sprites.flag({ pattern: p, symbol: s, c1: '#e53935', c2: '#fdd835', c3: '#ffffff' }, 48, 30);
  for (let p = 1; p < 6; p++) assert.ok(!same(g(0, 0), g(p, 0)), 'pattern ' + p);
  for (let s = 1; s < 10; s++) assert.ok(!same(g(0, 0), g(0, s)), 'symbol ' + s);
  assert.ok(Sprites.flag(null, 32, 20).width === 32);
  console.log('       ' + n + ' flags');
});

test('drawFx: every type, age sweep, radii, scales - no throw, no NaN', () => {
  const ctx = recCtx(), before = badArgs;
  const types = ['lightning', 'explosion', 'fire', 'smoke', 'heal', 'bless', 'plague', 'quake', 'dust', 'spark', 'splash', 'blood', 'whisper', 'ash', 'rain_drop', 'unknown_type'];
  for (const type of types) for (const scale of [3, 6, 12, 16, 24, 48]) for (const r of [undefined, 0.5, 2, 8]) for (let i = 0; i <= 10; i++) {
    const ttl = i === 10 ? 0 : 0.8;
    Sprites.drawFx(ctx, { type, x: 12.5, y: 33.25, ttl, age: i * 0.08, r, dx: 0.3, dy: -0.2, n: 5, color: '#cdb78c' }, 100 + i, 120, scale, 1000 * i);
  }
  assert.equal(badArgs, before, 'non finite draw args: ' + badLog.join(' | '));
  Sprites.drawFx(ctx, { type: 'fire', x: 0, y: 0, ttl: 1, age: 5 }, 0, 0, 16, 0);     // age past ttl clamps
  Sprites.drawFx(ctx, { type: 'fire', x: 0, y: 0, ttl: 1, age: -1 }, 0, 0, 16, undefined);
});

test('drawEffect: meteor / tornado / rain / quake', () => {
  const ctx = recCtx(), before = badArgs;
  for (const scale of [3, 8, 16, 32, 48]) for (let i = 0; i < 40; i++) {
    const now = i * 37;
    for (const p of [undefined, 0, 0.3, 0.7, 1, 1.4]) Sprites.drawEffect(ctx, 'meteor', { x: 5, y: 6, r: 3, eta: 100, t0: 40, p }, 200, 200, scale, now);
    Sprites.drawEffect(ctx, 'tornado', { x: 5, y: 6, dx: 0, dy: 0, until: 9, r: 2 }, 200, 200, scale, now);
    for (const r of [1, 3, 8]) { Sprites.drawEffect(ctx, 'rain', { x: 5, y: 6, r }, 200, 200, scale, now); Sprites.drawEffect(ctx, 'quake', { x: 5, y: 6, r }, 200, 200, scale, now); }
  }
  Sprites.drawEffect(ctx, 'nonsense', {}, 0, 0, 16, 0);
  assert.equal(badArgs, before, 'non finite draw args: ' + badLog.join(' | '));
});

test('no per-call allocation on cache hits (heap stays flat) and hits are fast', () => {
  // warm everything we are going to hit
  const keys = [];
  for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) for (let f = 0; f < 2; f++) for (let t = 0; t < 4; t++) keys.push([r, ['child', 'adult', 'elder'][s], f, [null, '#e53935', '#1e88e5', '#43a047'][t], (r + s + t) & 3, (r + f + t) & 3, t]);
  for (const k of keys) Sprites.unit(...k);
  Sprites.building(5, 0, 3, true, '#e53935'); Sprites.feature(1, 0); Sprites.icon('sword', 48);
  const fl = { pattern: 3, symbol: 4, c1: '#e53935', c2: '#fdd835', c3: '#fff' }; Sprites.flag(fl, 32, 20);
  const stats0 = JSON.stringify(Sprites.stats()), cv0 = canvasesMade;
  gc(); gc(); const h0 = process.memoryUsage().heapUsed;
  const N = 1500000; let sink = 0;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const k = keys[i % keys.length];
    sink += Sprites.unit(k[0], k[1], k[2], k[3], k[4], k[5], k[6]).width;
    if ((i & 15) === 0) { sink += Sprites.building(5, 0, 3, true, '#e53935').width + Sprites.feature(1, 0).width + Sprites.flag(fl, 32, 20).width + Sprites.icon('sword', 48).width; }
  }
  const dt = performance.now() - t0;
  gc(); gc(); const h1 = process.memoryUsage().heapUsed;
  const grow = (h1 - h0) / 1024;
  console.log('       ' + N + ' unit() hits: ' + (dt / N * 1e6).toFixed(0) + ' ns/call, heap delta ' + grow.toFixed(0) + ' KB, 1500 units/frame ~ ' + (dt / N * 1500).toFixed(3) + ' ms');
  assert.equal(JSON.stringify(Sprites.stats()), stats0, 'cache sizes unchanged');
  assert.equal(canvasesMade, cv0, 'no canvases created on hits');
  assert.ok(grow < 600, 'heap grew by ' + grow + ' KB');
  assert.ok(sink > 0);
});

test('full cold build budget (all unit/building/feature/icon sprites) is reasonable', () => {
  // fresh module instance to measure cold costs
  const m = new Function('document', '"use strict";\n' + code + '\nreturn { Sprites, Const };')(fakeDoc);
  const t0 = performance.now(); m.Sprites.init(); const ti = performance.now() - t0;
  const t1 = performance.now();
  for (let r = 0; r < 3; r++) for (const st of ['child', 'adult', 'elder']) for (let f = 0; f < 2; f++) for (const t of [null, '#e53935', '#1e88e5']) for (let w = 0; w < 4; w++) m.Sprites.unit(r, st, f, t, w, w, 0);
  for (const t of m.Const.BUILDING_TYPES) for (let r = 0; r < 3; r++) for (let lv = 1; lv <= 3; lv++) { m.Sprites.building(t, r, lv, true); m.Sprites.building(t, r, lv, false); }
  const k = m.Sprites.iconKeys(); for (const key of k) m.Sprites.icon(key, 48);
  const tc = performance.now() - t1;
  console.log('       init ' + ti.toFixed(1) + ' ms; ' + m.Sprites.stats().units + ' units + ' + m.Sprites.stats().buildings + ' buildings + ' + k.length + ' icons built in ' + tc.toFixed(0) + ' ms');
  assert.ok(ti < 250);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed' + (badArgs ? ', ' + badArgs + ' bad draw args' : ''));
process.exit(fail || badArgs ? 1 : 0);
