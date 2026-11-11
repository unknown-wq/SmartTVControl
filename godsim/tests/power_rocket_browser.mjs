// Browser part of tests/power_rocket.test.mjs (Playwright + headless Chromium, iPhone 390x844 @2x). Not run on its own: the headless file imports it.
// 1. UI: dock button with a drawn icon, group label «Арсенал», selecting the tool, taps through the real UI (toast «Залп: N ракет», cooldown toast)
// 2. visuals at zoom 8 / 14 / 24 with deterministic time (paused game, manual Fx ageing, forced sub-tick alpha): launch, mid-flight with trails,
//    warning reticles, impacts (fireball + smoke), merged burst, water burst; pixel probes + screenshots (LOOK at them: /tmp/godsim-rocket-shots)
// 3. draw budget at ~1500 creatures: a full 9-rocket volley in flight and 9 bursts in view cost <= 0.5 ms per frame at zoom 8 and 14
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export async function runBrowserPart({ root, args, browserMod }) {
  const { launch } = browserMod;
  let pass = 0, fail = 0;
  const check = (name, cond, info) => { if (cond) { pass++; console.log('  ok   ' + name + (info !== undefined ? '  (' + info + ')' : '')); } else { fail++; console.log('  FAIL ' + name + (info !== undefined ? '  (' + info + ')' : '')); } };
  const shots = String(args.shots || '/tmp/godsim-rocket-shots');
  fs.mkdirSync(shots, { recursive: true });
  const html = '/tmp/godsim-rocket.html';
  execFileSync('node', [path.join(root, 'build.mjs'), '--out=' + html, '--check'], { cwd: root, stdio: 'pipe' });
  console.log('# browser: dock button, icon, toasts, flight / reticles / impacts at zoom 8 / 14 / 24, merged + water bursts, draw budget');
  const b = await launch({ url: 'file://' + html, width: 390, height: 844, dpr: 2 });
  const E = (fn, arg) => b.eval(fn, arg);
  for (let i = 0; i < 80; i++) { if (await E(() => !!window.__god && !!document.querySelector('.tab'))) break; await b.sleep(100); }
  await b.wait(500);

  // ---------------------------------------------------------------- 1. UI
  await E(() => window.__god.UI.selectTab('powers'));
  await b.wait(300);
  const tool = await E(() => {
    const btn = document.querySelector('.tool[data-tool="rocket"]');
    if (!btn) return null;
    btn.scrollIntoView({ inline: 'center' });
    const cv = btn.querySelector('canvas'); let lit = 0, red = 0, white = 0;
    if (cv) { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) { lit++; if (d[i] > 200 && d[i + 1] < 110 && d[i + 2] < 110) red++; if (d[i] > 225 && d[i + 1] > 225 && d[i + 2] > 225) white++; } }
    return { label: btn.textContent.trim(), lit, red, white, groups: [...document.querySelectorAll('.grp-lbl')].map(x => x.textContent.trim()) };
  });
  check('dock button «Ракеты» with a drawn rocket icon (white body, red nose / fins)', !!tool && tool.label === 'Ракеты' && tool.lit > 120 && tool.red > 8 && tool.white > 8, JSON.stringify(tool));
  check('group label «Арсенал» between Разрушение and Благословение', !!tool && tool.groups.join('|') === 'Разрушение|Арсенал|Благословение', tool && tool.groups.join('|'));
  await b.wait(300);
  await b.shot(shots + '/rocket_00_dock.png', { clip: { x: 0, y: 560, width: 390, height: 284 } });
  await E(() => document.querySelector('.tool[data-tool="rocket"]').click());
  await b.wait(250);
  const sel = await E(() => ({ tool: window.__god.UI.state.tool, hint: (document.querySelector('#hint, .hint') || {}).textContent || '' }));
  check('tapping the dock button selects the tool', sel.tool === 'rocket', JSON.stringify(sel));
  await b.tap(195, 330);
  await b.wait(160);
  const t1 = await E(() => ({ rockets: (window.__god.S.eff.rockets || []).length, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent) }));
  check('a tap fires a salvo and toasts «Залп: N ракет» (brush 3 -> 6)', t1.rockets === 6 && t1.toasts.some(s => /Залп: 6 ракет/.test(s)), JSON.stringify(t1));
  await b.tap(200, 340);
  await b.wait(160);
  const t2 = await E(() => ({ rockets: (window.__god.S.eff.rockets || []).length, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent) }));
  check('a second tap during the reload is refused with «Пусковые устройства перезаряжаются»', t2.rockets === 6 && t2.toasts.some(s => /Пусковые устройства перезаряжаются/.test(s)), JSON.stringify(t2));
  await b.shot(shots + '/rocket_01_ui_taps.png');

  // ---------------------------------------------------------------- 2. visuals with deterministic time
  const setup = await E(async () => {
    const g = window.__god;
    g.Main.newWorld({ seed: 4, w: 96, h: 96, populate: true }); g.setSpeed(0);
    let guard = 0;
    while (g.S.tick < 1800 && guard++ < 100) { g.step(60); await new Promise(r => setTimeout(r, 0)); }
    g.Fx.list.length = 0;
    g.Fx.__update = g.Fx.update; g.Fx.update = () => {};                         // we age Fx ourselves
    const od = g.Render.draw; g.Render.draw = (a, t) => od(window.__alpha != null ? window.__alpha : a, window.__nowFix != null ? window.__nowFix : t);
    window.__ageFx = (s) => g.Fx.__update(s);
    window.__alpha = 0.5;
    const c = g.Main.largestSettlement() || { x: 48, y: 48 };
    return { c, units: g.S.units.size, cities: g.S.cities.size };
  });
  const c = setup.c;
  const frames = (n = 3) => E((n) => new Promise(res => { let i = 0; const f = () => { if (++i >= n) res(); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), n);
  const look = (x, y, z) => E(({ x, y, z }) => { const g = window.__god; g.Render.setMode(0); g.Render.setCamera(x, y, z); }, { x, y, z });
  const adv = async (ticks, alpha = 0.5) => { await E(({ ticks, alpha }) => { const g = window.__god; for (let i = 0; i < ticks; i++) { g.step(1); window.__ageFx(0.1); } window.__alpha = alpha; }, { ticks, alpha }); await frames(3); };
  const fire = (x, y, r) => E(({ x, y, r }) => { const g = window.__god; if (g.S.mod.rocket) g.S.mod.rocket.cd = 0; const ok = g.Powers.apply('rocket', x, y, r, 'tap'); return { ok, n: (g.S.eff.rockets || []).length }; }, { x, y, r });
  /** how many pixels around tile (tx,ty) are painted by OUR graphics: the same frame is redrawn with the rocket Fx hidden (fx), with the rockets hidden (rk), and the
   *  pixels that differ are counted; retRed = of the rocket-only pixels, those that look like the reticle red (#ff5040). Robust against any scene content. */
  const paint = (tx, ty, half) => E(async ({ tx, ty, half }) => {
    const g = window.__god, cv = document.getElementById('game'), ctx = cv.getContext('2d');
    const p = g.Render.tileToScreen(tx, ty), dpr = cv.width / cv.clientWidth, z = g.Render.cam.zoom * dpr;
    const x0 = Math.max(0, Math.round(p.x * dpr - half * z)), y0 = Math.max(0, Math.round(p.y * dpr - half * z)), w = Math.max(1, Math.min(cv.width - x0, Math.round(half * 2 * z))), h = Math.max(1, Math.min(cv.height - y0, Math.round(half * 2 * z)));
    const raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const grab = () => ctx.getImageData(x0, y0, w, h).data;
    window.__nowFix = 100000; await raf(); const A = grab();                              // the render time is frozen: ambient animation is identical in every capture
    const fx0 = g.Fx.list, rk0 = g.S.eff.rockets;
    window.__nowFix = 100000.001; g.Fx.list = fx0.filter(f => !/^rocket_/.test(f.type)); await raf(); const Bf = grab(); g.Fx.list = fx0;
    window.__nowFix = 100000.002; g.S.eff.rockets = []; await raf(); const Br = grab(); g.S.eff.rockets = rk0;
    window.__nowFix = null; await raf();
    let fx = 0, rk = 0, retRed = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (Math.abs(A[i] - Bf[i]) + Math.abs(A[i + 1] - Bf[i + 1]) + Math.abs(A[i + 2] - Bf[i + 2]) > 30) fx++;
      if (Math.abs(A[i] - Br[i]) + Math.abs(A[i + 1] - Br[i + 1]) + Math.abs(A[i + 2] - Br[i + 2]) > 30) { rk++; if (A[i] > 185 && A[i] - A[i + 1] > 85 && A[i] - A[i + 2] > 75) retRed++; }
    }
    return { fx, rk, retRed };
  }, { tx, ty, half });

  for (const zoom of [8, 14, 24]) {
    await look(c.x, c.y, zoom);
    await frames(2);
    const tx = c.x + 0.5, ty = c.y + 0.5;
    const f = await fire(tx, ty, 6);
    check(`zoom ${zoom}: the salvo is fired at the settlement (9 rockets)`, f.ok === true && f.n === 9, JSON.stringify(f));
    await E(() => { window.__alpha = 0.0; });
    await b.sleep(900);                                                                         // paused: the frame loop keeps drawing, the baking queue empties
    await adv(1, 0.5);
    await b.shot(shots + `/rocket_z${zoom}_a_launch.png`);
    const etas = await E(() => window.__god.S.eff.rockets.map(e => e.eta - window.__god.S.tick));
    const minEta = Math.min(...etas), maxEta = Math.max(...etas);
    let t = 1;
    await adv(minEta - 14 - t, 0.5); t = minEta - 14;
    const early = await paint(tx, ty, 3.4);                                                     // before any reticle is up
    await adv(7, 0.5); t += 7;
    await b.shot(shots + `/rocket_z${zoom}_b_incoming.png`);
    await adv(2, 0.5); t += 2;
    const ret = await paint(tx, ty, 3.4);                                                       // 5 ticks before the first impact
    await b.shot(shots + `/rocket_z${zoom}_c_reticles.png`);
    await adv(minEta + 2 - t, 0.5); t = minEta + 2;
    const boom = await paint(tx, ty, 3.4);
    await b.shot(shots + `/rocket_z${zoom}_d_first_hits.png`);
    await adv(Math.round((maxEta - t) / 2) + 2, 0.5);
    await b.shot(shots + `/rocket_z${zoom}_e_barrage.png`);
    await adv(maxEta + 3 - (t + Math.round((maxEta - t) / 2) + 2), 0.5);
    await E(() => window.__ageFx(0.2)); await frames(3);
    await b.shot(shots + `/rocket_z${zoom}_f_smoke.png`);
    check(`zoom ${zoom}: warning reticles (red rings + crosses) are on the impact points 5 ticks before the first hit`, ret.rk > 150 && ret.retRed > 25 && ret.retRed > early.retRed + 15, `rocket-layer px ${early.rk} -> ${ret.rk}, reticle red px ${early.retRed} -> ${ret.retRed}`);
    check(`zoom ${zoom}: the first impacts paint fireballs (burst Fx pixels)`, boom.fx > 250 && early.fx < 25, `burst px ${early.fx} -> ${boom.fx}`);
    const left = await E(() => ({ rockets: (window.__god.S.eff.rockets || []).length, fx: window.__god.Fx.list.filter(f => /^rocket_/.test(f.type)).length, fires: window.__god.World.fireCount() }));
    check(`zoom ${zoom}: sky clear after the salvo, burst Fx alive, fires started`, left.rockets === 0 && left.fx > 0 && left.fires > 0, JSON.stringify(left));
    await E(() => { const g = window.__god; g.Fx.list.length = 0; g.World.extinguish(48, 48, 70); });
    await adv(40, 0.5);
  }

  // merged burst (12 impacts in one tick) and water bursts
  await look(c.x, c.y, 14);
  await E(({ x, y }) => { const g = window.__god, S = g.S; S.eff.rockets = S.eff.rockets || [];
    for (let i = 0; i < 12; i++) { const ax = x + ((i % 4) - 1.5) * 1.6, ay = y + (((i / 4) | 0) - 1) * 1.6; S.eff.rockets.push({ x: ax, y: -3, x0: ax, y0: -3, x1: ax, y1: ay, t0: S.tick - 13, eta: S.tick + 1, r: 1.8, b: 0, h: 2, v: 5 + i, l: 1 }); } }, { x: c.x + 0.5, y: c.y + 0.5 });
  await adv(1, 0.0);
  const merged = await E(() => window.__god.Fx.list.filter(f => f.type === 'rocket_boom').map(f => f.m));
  await b.sleep(80);
  await adv(0, 0.0); await E(() => window.__ageFx(0.25)); await frames(3);
  await b.shot(shots + '/rocket_z14_c_merged.png');
  check('merged burst: 3 full bursts + 1 merged burst (9 impacts) are drawn without errors', merged.length === 4 && merged.filter(m => m > 1).length === 1, JSON.stringify(merged));
  // water: find a sea tile near the settlement
  const sea = await E(() => { const g = window.__god, S = g.S; for (let r = 4; r < 40; r++) for (let a = 0; a < 6.28; a += 0.3) { const x = Math.floor(48 + Math.cos(a) * r * 0.8), y = Math.floor(48 + Math.sin(a) * r * 0.8); if (x > 3 && y > 3 && x < S.w - 3 && y < S.h - 3 && S.tile[y * S.w + x] === 0 && S.tile[(y + 2) * S.w + x + 2] === 0 && S.tile[(y - 2) * S.w + x - 2] === 0) return { x: x + 0.5, y: y + 0.5 }; } return null; });
  if (sea) {
    await look(sea.x, sea.y, 14);
    await E(({ x, y }) => { const g = window.__god, S = g.S; g.Fx.list.length = 0; for (let i = 0; i < 3; i++) { const ax = x + (i - 1) * 2.2, ay = y + (i % 2) * 1.5; S.eff.rockets.push({ x: ax, y: -3, x0: ax, y0: -3, x1: ax, y1: ay, t0: S.tick - 13, eta: S.tick + 1, r: 1.8, b: 0, h: 2, v: 9 + i, l: 1 }); } }, sea);
    await adv(1, 0.0); await E(() => window.__ageFx(0.28)); await frames(3);
    await b.shot(shots + '/rocket_z14_d_water.png');
    const wf = await E(() => window.__god.Fx.list.filter(f => f.type === 'rocket_boom').map(f => f.w));
    check('water bursts are flagged and drawn (geyser + rings)', wf.length >= 3 && wf.every(w => w === 1), JSON.stringify(wf));
  }

  check('no page errors during the visual run', b.errors.length === 0, b.errors.slice(0, 2).join(' | ').slice(0, 300));

  // ---------------------------------------------------------------- 3. draw budget at ~1500 creatures
  if (!args.noperf) {
    const grown = await E(async () => {
      const g = window.__god;
      g.Main.newWorld({ seed: 4, w: 96, h: 96, populate: true }); g.setSpeed(0);
      let guard = 0;
      while (g.S.units.size < 1450 && g.S.tick < 30000 && guard++ < 400) { g.step(100); await new Promise(r => setTimeout(r, 0)); }
      g.Fx.list.length = 0;
      window.__draws = { t: 0, n: 0 };
      const od = g.Render.draw; g.Render.draw = (a, tt) => { const t0 = performance.now(); od(window.__alpha != null ? window.__alpha : a, tt); window.__draws.t += performance.now() - t0; window.__draws.n++; };
      g.Fx.__update = g.Fx.update; g.Fx.update = () => {};
      window.__alpha = 0.5;
      const c = g.Main.largestSettlement() || { x: 48, y: 48 };
      return { units: g.S.units.size, tick: g.S.tick, c };
    });
    check('perf world has ~1500 creatures', grown.units >= 1300, String(grown.units));
    const measure = async (n = 200) => { await frames(2); await E(() => { window.__draws.t = 0; window.__draws.n = 0; }); await frames(n); return E(() => window.__draws.t / window.__draws.n); };
    const injectFlight = (x, y) => E(({ x, y }) => {
      const g = window.__god, S = g.S; S.eff.rockets = [];
      for (let i = 0; i < 9; i++) {                                                           // 9 rockets, ~60 % of their flight, all inside the view, reticles on
        const a = i * 0.7, ax = x + Math.cos(a) * (2 + i * 0.35), ay = y + Math.sin(a) * (2 + i * 0.35), sx = ax - 12 - (i % 3), sy = ay + (i - 4) * 1.1;
        S.eff.rockets.push({ x: sx + (ax - sx) * 0.6, y: sy + (ay - sy) * 0.6, x0: sx, y0: sy, x1: ax, y1: ay, t0: S.tick - 10, eta: S.tick + 6 + (i % 3), r: 1.8, b: 0.05, h: 2.5, v: 3 + i * 17, l: 1 });
      }
      window.__alpha = 0.5;
    }, { x, y });
    const injectBursts = (x, y) => E(({ x, y }) => {
      const g = window.__god; g.Fx.list.length = 0;
      for (let i = 0; i < 9; i++) {
        const a = i * 0.7, ax = x + Math.cos(a) * (1.5 + i * 0.3), ay = y + Math.sin(a) * (1.5 + i * 0.3), age = 0.1 + (i % 5) * 0.14;
        g.Fx.list.push({ type: 'rocket_boom', x: ax, y: ay, ttl: 1.0, age, r: 3, w: 0, m: 1, _s: 7 + i });
        g.Fx.list.push({ type: 'rocket_smoke', x: ax, y: ay, ttl: 2.3, age: age * 2, r: 4, _s: 3 + i });
        g.Fx.list.push({ type: 'rocket_trail', x: ax, y: ay, ttl: 0.9, age: age * 0.8, r: 14, x0: ax - 14, y0: ay + 1, x1: ax, y1: ay, b: 0.05, h: 2.5, _s: 5 + i });
      }
    }, { x, y });
    const worst = {};
    for (const zoom of [8, 14]) {
      await E(({ x, y, z }) => { const g = window.__god; g.Render.setMode(0); g.Render.setCamera(x, y, z); g.S.eff.rockets = []; g.Fx.list.length = 0; }, { x: grown.c.x, y: grown.c.y, z: zoom });
      await b.sleep(500);
      await E(() => window.__god.Bus.emit('rocketVolley', 9, 0, 0));                       // warm-up of the baked frames
      await injectFlight(grown.c.x + 0.5, grown.c.y + 0.5);
      await b.sleep(1800);
      await E(() => { window.__god.S.eff.rockets = []; });
      await injectBursts(grown.c.x + 0.5, grown.c.y + 0.5);
      await b.sleep(400);
      const rounds = [];
      for (let k = 0; k < 3; k++) {
        await E(({ x, y }) => { const g = window.__god; g.S.eff.rockets = []; g.Fx.list.length = 0; }, { x: grown.c.x, y: grown.c.y });
        const off = await measure();
        await injectFlight(grown.c.x + 0.5, grown.c.y + 0.5);
        const fl = await measure();
        if (k === 1) await b.shot(shots + `/rocket_perf_flight_z${zoom}.png`);
        await E(() => { window.__god.S.eff.rockets = []; });
        await injectBursts(grown.c.x + 0.5, grown.c.y + 0.5);
        const bu = await measure();
        if (k === 1) await b.shot(shots + `/rocket_perf_bursts_z${zoom}.png`);
        rounds.push({ off, fl, bu });
      }
      const med = (a) => a.slice().sort((p, q) => p - q)[1];
      const off = med(rounds.map(r => r.off)), fl = med(rounds.map(r => r.fl)), bu = med(rounds.map(r => r.bu));
      worst[zoom] = { off, dFlight: fl - off, dBurst: bu - off };
      console.log(`       zoom ${zoom}: draw ${off.toFixed(2)} ms without | + 9 rockets in flight (trails, reticles) ${(fl - off).toFixed(2)} ms | + 9 bursts (boom, smoke column, lingering trail) ${(bu - off).toFixed(2)} ms`);
      check(`zoom ${zoom}: a full 9-rocket salvo in view costs <= 0.5 ms per frame`, fl - off <= 0.5, (fl - off).toFixed(2) + ' ms');
      check(`zoom ${zoom}: 9 impact bursts (boom + smoke + trail) cost <= 0.5 ms per frame`, bu - off <= 0.5, (bu - off).toFixed(2) + ' ms');
    }
    check('no page errors during the perf run', b.errors.length === 0, b.errors.slice(0, 2).join(' | ').slice(0, 300));
  }

  await b.close();
  console.log(`       browser part: ${pass} passed, ${fail} failed`);
  return fail;
}
