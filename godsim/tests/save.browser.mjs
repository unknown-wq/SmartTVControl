// Browser (Chromium, real localStorage) check of Save + Sim:  node tests/save.browser.mjs
//  1. world -> 1500 ticks -> Save.save -> 300 more ticks (hash A)
//  2. page reload (fresh JS context) -> Save.load -> 300 more ticks (hash B) -> A === B
//  3. real localStorage quota: fill storage, save must return false (no exception), old slot survives, works again after freeing
//  4. timings in a real JS engine
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { launch } from './browser.mjs';

const out = path.join(os.tmpdir(), 'godsim-save.html');
execFileSync('node', ['build.mjs', '--stubs', '--no-main', '--extra=tests/save_boot.js', '--out=' + out], { cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), stdio: 'inherit' });
const url = 'file://' + out;
const b = await launch({ url });
let failed = 0;
const ok = (name, extra) => console.log(`  ok   ${name}${extra ? '   ' + extra : ''}`);
try {
  await b.page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* ignore */ } });
  // ---- 1. run + save
  const A = await b.eval(() => {
    const sv = window.__sv;
    sv.Sim.newWorld({ seed: 7, w: 96, h: 96, populate: true });
    sv.stepN(1500);
    const t0 = performance.now();
    const saved = sv.Save.save('1');
    const saveMs = performance.now() - t0;
    const tickAtSave = sv.S.tick, units = sv.S.units.size;
    sv.stepN(300);
    return { saved, saveMs, tickAtSave, units, hash: sv.state(), size: localStorage.getItem('godsim.v1.1') ? localStorage.getItem('godsim.v1.1').length : 0, info: sv.Save.info('1'), errors: sv.Sim.totalErrors };
  });
  assert.ok(A.saved, 'save() true'); assert.equal(A.errors, 0);
  ok('saved in the page', `${A.units} units, ${(A.size / 1024).toFixed(1)} K chars, save() ${A.saveMs.toFixed(1)} ms, info ${JSON.stringify(A.info)}`);
  // ---- 2. fresh context
  await b.page.goto(url);
  const B = await b.eval(() => {
    const sv = window.__sv;
    const exists = sv.Save.exists('1'), info = sv.Save.info('1');
    const t0 = performance.now();
    const loaded = sv.Save.load('1');
    const loadMs = performance.now() - t0;
    const tick = sv.S.tick;
    sv.stepN(300);
    return { exists, info, loaded, loadMs, tick, hash: sv.state(), errors: sv.Sim.totalErrors, lastError: sv.Save.lastError };
  });
  assert.ok(B.exists && B.loaded, 'load() in a fresh page: ' + B.lastError);
  assert.equal(B.tick, A.tickAtSave);
  assert.equal(B.errors, 0);
  assert.equal(B.hash, A.hash, 'state after 300 ticks differs between the original page and the reloaded page');
  ok('fresh page loads the slot and continues bit-identically', `load() ${B.loadMs.toFixed(1)} ms, state hash ${B.hash}`);
  // ---- 3. quota
  const Q = await b.eval(() => {
    const sv = window.__sv;
    const res = {};
    // fill localStorage with 256 KB chunks until it refuses
    let n = 0; const chunk = 'x'.repeat(256 * 1024);
    try { for (; n < 200; n++) localStorage.setItem('filler' + n, chunk); } catch (e) { res.fillError = e.name; }
    res.filled = n;
    // shrink the free space further so that even small writes fail
    const small = 'y'.repeat(1024); let m = 0;
    try { for (; m < 4000; m++) localStorage.setItem('fine' + m, small); } catch (e) { /* full */ }
    res.fine = m;
    const before = localStorage.getItem('godsim.v1.1');
    sv.stepN(50);
    let threw = false, saved = null;
    try { saved = sv.Save.save('1'); } catch (e) { threw = true; }
    res.threw = threw; res.saved = saved; res.lastError = sv.Save.lastError;
    res.oldIntact = localStorage.getItem('godsim.v1.1') === before;
    res.stillLoads = sv.Save.load('1');
    for (let i = 0; i < n; i++) localStorage.removeItem('filler' + i);
    for (let i = 0; i < m; i++) localStorage.removeItem('fine' + i);
    res.savedAfterFree = sv.Save.save('2');
    return res;
  });
  assert.equal(Q.threw, false, 'save() must not throw on quota errors');
  assert.equal(Q.saved, false, 'save() over quota returns false');
  assert.match(String(Q.lastError), /Quota|quota/i);
  assert.ok(Q.oldIntact, 'old slot untouched by a failed save');
  assert.ok(Q.stillLoads, 'old slot still loads');
  assert.ok(Q.savedAfterFree, 'saving works again after space is freed');
  ok('real localStorage quota handled', `filled ${Q.filled} x 256K, lastError="${Q.lastError}"`);
  // ---- 4. timings: 400+ units
  const T = await b.eval(() => {
    const sv = window.__sv;
    sv.Sim.newWorld({ seed: 7, w: 96, h: 96, populate: true });
    let g = 0; while (sv.S.units.size < 400 && g++ < 400) sv.stepN(50);
    const t0 = performance.now(); const json = sv.Save.serialize(); const t1 = performance.now();
    const packed = sv.Save.pack(json); const t2 = performance.now();
    const un = sv.Save.unpack(packed); const t3 = performance.now();
    const okLoad = sv.Save.deserialize(packed); const t4 = performance.now();
    return { units: sv.S.units.size, json: json.length, packed: packed.length, serialize: t1 - t0, pack: t2 - t1, unpack: t3 - t2, deserialize: t4 - t3, same: un === json, okLoad };
  });
  assert.ok(T.same && T.okLoad);
  ok('timings (Chromium)', `${T.units} units: JSON ${(T.json / 1024).toFixed(0)} KB -> ${(T.packed / 1024).toFixed(0)} K chars; serialize ${T.serialize.toFixed(1)} ms, pack ${T.pack.toFixed(1)} ms, unpack ${T.unpack.toFixed(1)} ms, deserialize(packed) ${T.deserialize.toFixed(1)} ms`);
  assert.equal(b.errors.length, 0, 'page errors: ' + b.errors.join('\n'));
} catch (e) {
  failed++;
  console.log('  FAIL', e && e.stack || e);
  if (b.errors.length) console.log('page errors:\n' + b.errors.join('\n'));
} finally {
  await b.close();
}
console.log(failed ? '\nFAILED' : '\nbrowser save test passed');
process.exit(failed ? 1 : 0);
