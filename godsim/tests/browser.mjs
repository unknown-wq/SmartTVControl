// Browser test helper (Playwright + headless Chromium, iPhone-like touch emulation).
//   import { launch } from './browser.mjs';
//   const b = await launch({ file: 'index.html' });   // or { url }
//   await b.wait(500); await b.tap(200, 400); await b.drag(200,400,100,300); await b.pinch(195,400,60,160);
//   await b.shot('/tmp/x.png'); console.log(b.errors); await b.close();
// Page-side debug hook: window.__god (see CONTRACT §4 Main).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function launch(opts = {}) {
  const w = opts.width || 390, h = opts.height || 844;           // iPhone 13/14 CSS viewport
  const browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({
    viewport: { width: w, height: h }, deviceScaleFactor: opts.dpr || 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();
  const errors = [], logs = [];
  page.on('pageerror', e => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', m => { const t = m.type(); if (t === 'error') errors.push('console.error: ' + m.text()); else if (opts.verbose) logs.push(t + ': ' + m.text()); });
  const url = opts.url || ('file://' + path.resolve(root, opts.file || 'index.html'));
  await page.goto(url);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i })) });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const api = {
    browser, ctx, page, cdp, errors, logs, sleep,
    wait: sleep,
    eval: (fn, arg) => page.evaluate(fn, arg),
    async shot(file, o = {}) { await page.screenshot({ path: file, ...o }); return file; },
    async tap(x, y) { await touch('touchStart', [[x, y]]); await sleep(40); await touch('touchEnd', []); await sleep(60); },
    async drag(x0, y0, x1, y1, steps = 8, stepMs = 16) {
      await touch('touchStart', [[x0, y0]]);
      for (let i = 1; i <= steps; i++) { await sleep(stepMs); await touch('touchMove', [[x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps]]); }
      await touch('touchEnd', []); await sleep(60);
    },
    async pinch(cx, cy, d0, d1, steps = 10, stepMs = 16) {
      const pts = d => [[cx - d / 2, cy], [cx + d / 2, cy]];
      await touch('touchStart', pts(d0));
      for (let i = 1; i <= steps; i++) { await sleep(stepMs); await touch('touchMove', pts(d0 + (d1 - d0) * i / steps)); }
      await touch('touchEnd', []); await sleep(60);
    },
    /** measure rAF frame times for `ms` milliseconds -> {fps, avg, p95, max} */
    async fps(ms = 3000) {
      return page.evaluate(ms => new Promise(res => {
        const ts = []; let t0 = performance.now();
        function f(t) { ts.push(t); if (t - t0 < ms) requestAnimationFrame(f); else { const d = []; for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]); d.sort((a, b) => a - b); const avg = d.reduce((a, b) => a + b, 0) / d.length; res({ fps: 1000 / avg, avg, p95: d[(d.length * 0.95) | 0], max: d[d.length - 1], frames: d.length }); } }
        requestAnimationFrame(f);
      }), ms);
    },
    async close() { await browser.close(); },
  };
  return api;
}
