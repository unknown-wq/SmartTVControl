/* =====================================================================
 * 99_main.js — Main: boot, fixed-step game loop, resize / visibility handling, autosave, error overlay, debug hook.
 * OWNER: UI+Main agent. CONTRACT §4 Main.  Loaded last; the boot call at the bottom runs after every module exists.
 *
 *  - fixed step: accumulator at 1000/(TICKS_PER_SEC*speed) ms per tick, speed in {0,1,2,4}, at most 6 ticks per frame and ~10 ms
 *    of sim time per frame (the backlog is dropped, the game just runs slower on a weak device); Render.draw gets the sub-tick alpha.
 *  - Sim.adaptPerf(frameMs) gets the CPU time of every frame (sim + render + UI).
 *  - autosave: every 60 s real time (only if the world advanced), on visibilitychange->hidden and pagehide.
 *  - window.__god = {S,Sim,World,...,setSpeed,getSpeed,step} for tests.
 * ===================================================================== */

const Main = (() => {
  const SPEEDS = [0, 1, 2, 4];
  const AUTOSAVE_MS = 60000;
  const MAX_TICKS_PER_FRAME = 6, SIM_BUDGET_MS = 10;

  let speed = 1, acc = 0, lastT = 0, rafId = 0, hidden = false, booted = false;
  let lastAutosaveAt = 0, lastAutosaveTick = -1;
  let canvas = null;
  let cssW = 0, cssH = 0, lastDpr = 0;
  const errs = { n: 0, last: '', count: 0 };
  const stats = { frames: 0, ticks: 0, frameMs: 0, simMs: 0 };

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ speed
  function setSpeed(s) {
    s = +s;
    if (!(s >= 0)) s = 1;
    if (SPEEDS.indexOf(s) < 0) { // snap to the nearest allowed speed
      let best = 1, bd = 1e9;
      for (const c of SPEEDS) { const d = Math.abs(c - s); if (d < bd) { bd = d; best = c; } }
      s = best;
    }
    speed = s;
    if (s === 0) acc = 0;
    return speed;
  }
  function getSpeed() { return speed; }

  // ------------------------------------------------------------------ viewport
  function measure() {
    const vv = window.visualViewport;
    let w = window.innerWidth, h = window.innerHeight;
    if (vv && vv.scale <= 1.02) { w = vv.width; h = vv.height; }
    return { w: Math.max(200, Math.round(w)), h: Math.max(200, Math.round(h)), dpr: window.devicePixelRatio || 1 };
  }
  function onResize(force) {
    const m = measure();
    const ae = document.activeElement;
    const typing = ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName);
    if (!force && typing && m.w === cssW) return;                  // soft keyboard: keep the map layout stable
    if (!force && m.w === cssW && m.h === cssH && m.dpr === lastDpr) return;
    cssW = m.w; cssH = m.h; lastDpr = m.dpr;
    document.documentElement.style.setProperty('--vh', (m.h * 0.01) + 'px');
    try { Render.resize(m.w, m.h, m.dpr); } catch (e) { console.error('resize', e); }
    if (UI.ready) UI.layout();
  }

  // ------------------------------------------------------------------ camera helpers
  function initialView(instant) {
    if (!S.w) return;
    let tx = S.w / 2, ty = S.h / 2, found = false;
    let bestPop = -1;
    for (const c of S.cities.values()) { if ((c.pop | 0) > bestPop) { bestPop = c.pop | 0; tx = c.x + 0.5; ty = c.y + 0.5; found = true; } }
    if (!found) { for (const u of S.units.values()) { tx = u.x; ty = u.y; found = true; break; } }
    const z = Util.clamp(found ? 9 : 6, Render.minZoom(), Render.maxZoom());
    if (UI.ready) UI.focusVisible(tx, ty, z, instant !== false); else Render.focusOn(tx, ty, z, true);
  }
  function resetView() {
    if (!S.w) return;
    const bi = UI.ready ? UI.bandInfo() : { w: cssW, h: cssH, top: 0, bot: cssH };
    const z = Util.clamp(Math.min(bi.w / S.w, (bi.bot - bi.top) / S.h) * 0.98, Render.minZoom(), Render.maxZoom());
    if (UI.ready) UI.focusVisible(S.w / 2, S.h / 2, z); else Render.focusOn(S.w / 2, S.h / 2, z);
  }
  function focusTile(x, y) {
    const z = Math.max(Render.cam.zoom, 12);
    if (UI.ready) UI.focusVisible(x + 0.5, y + 0.5, z); else Render.focusOn(x + 0.5, y + 0.5, z);
  }

  // ------------------------------------------------------------------ world replacement (new world / load)
  function worldReplaced(kind) {
    acc = 0; lastT = 0;
    lastAutosaveAt = performance.now(); lastAutosaveTick = S.tick;
    try { Input.cancel(); } catch (e) { /* ignore */ }
    try { UI.onWorldReplaced(); } catch (e) { console.error('UI.onWorldReplaced', e); }
    initialView(true);
    Bus.emit('worldReplaced', kind);
  }
  function newWorld(opts) {
    Sim.newWorld(Object.assign({ populate: true }, opts || {}));
    worldReplaced('new');
    return S;
  }

  // ------------------------------------------------------------------ autosave
  function autosave(why) {
    if (!S.tile || S.tick === lastAutosaveTick) { lastAutosaveAt = performance.now(); return false; }
    let ok = false;
    try { ok = Save.save('auto'); } catch (e) { ok = false; }
    lastAutosaveAt = performance.now();
    if (ok) lastAutosaveTick = S.tick;
    return ok;
  }

  // ------------------------------------------------------------------ frame
  function frame(t) {
    rafId = requestAnimationFrame(frame);
    const c0 = performance.now();
    let dt = lastT ? t - lastT : 16.7;
    lastT = t;
    if (!(dt >= 0)) dt = 0;
    if (dt > 250) dt = 250;
    let alpha = 1;
    if (!hidden && speed > 0 && S.tile) {
      const stepMs = 1000 / (Const.TICKS_PER_SEC * speed);
      acc += dt;
      let n = 0;
      const deadline = c0 + SIM_BUDGET_MS;
      while (acc >= stepMs && n < MAX_TICKS_PER_FRAME) {
        Sim.step(); acc -= stepMs; n++;
        if (performance.now() > deadline) break;
      }
      if (acc >= stepMs) acc = stepMs * 0.5;                    // drop the backlog
      stats.ticks += n;
      alpha = acc / stepMs;
      stats.simMs = performance.now() - c0;
    } else if (speed === 0) acc = 0;
    try { Fx.update(dt / 1000); } catch (e) { /* ignore */ }
    try { Render.draw(alpha, t); } catch (e) { reportError(e); }
    try { UI.update(dt); } catch (e) { reportError(e); }
    if (c0 - lastAutosaveAt >= AUTOSAVE_MS) autosave('timer');
    const cpu = performance.now() - c0;
    stats.frames++; stats.frameMs = stats.frameMs ? stats.frameMs * 0.94 + cpu * 0.06 : cpu;
    watchSmoothness(dt, cpu, t);
    try { Sim.adaptPerf(cpu); } catch (e) { /* ignore */ }
  }
  function start() { if (!rafId) { lastT = 0; rafId = requestAnimationFrame(frame); } }
  function stop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

  // Compositor-bound slowness (blur panels over the animated canvas) while the JS itself is cheap -> switch the glass off.
  const smooth = { ema: 16.7, slowSince: 0, lite: false };
  function watchSmoothness(dt, cpu, t) {
    if (smooth.lite || hidden || dt <= 0 || dt >= 250) return;
    smooth.ema += (dt - smooth.ema) * 0.05;
    if (smooth.ema > 26 && stats.frameMs < 12) {
      if (!smooth.slowSince) smooth.slowSince = t;
      else if (t - smooth.slowSince > 5000) { smooth.lite = true; document.body.classList.add('lite'); }
    } else smooth.slowSince = 0;
  }

  // ------------------------------------------------------------------ errors
  function showError(msg) {
    errs.n++;
    msg = String(msg || 'Ошибка').slice(0, 220);
    const box = $('errbox');
    if (!box) return;
    if (msg === errs.last) errs.count++; else { errs.last = msg; errs.count = 1; }
    box.innerHTML = '';
    const m = document.createElement('div'); m.className = 'em';
    m.textContent = 'Ошибка: ' + msg + (errs.count > 1 ? '  (×' + errs.count + ')' : '');
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Скрыть');
    x.addEventListener('click', () => { box.hidden = true; errs.last = ''; errs.count = 0; });
    box.appendChild(m); box.appendChild(x);
    box.hidden = false;
  }
  function reportError(e) {
    const msg = e && e.message ? e.message : String(e);
    if (reportError.last !== msg) { reportError.last = msg; console.error('[Main]', e); }
  }

  let guarded = false;
  function installGuards() {
    if (guarded) return;
    guarded = true;
    document.body.classList.add('booting');
    window.addEventListener('error', (ev) => { showError(ev && ev.message ? ev.message : 'Неизвестная ошибка'); });
    window.addEventListener('unhandledrejection', (ev) => { const r = ev && ev.reason; showError(r && r.message ? r.message : String(r)); });
    const oerr = console.error;
    console.error = function () {
      try { oerr.apply(console, arguments); } catch (e) { /* ignore */ }
      try {
        const a = arguments[0];
        let msg = typeof a === 'string' ? a : (a && a.message) || '';
        if (arguments.length > 1 && arguments[1] && arguments[1].message) msg += ' ' + arguments[1].message;
        showError(msg.split('\n')[0]);
      } catch (e) { /* ignore */ }
    };
    // iOS: no page zoom, no scroll / bounce outside the scrollable panels
    const free = 'input,.hscroll,.sh-body,.m-body,.filters';
    document.addEventListener('touchmove', (e) => {
      const t = e.target;
      if (t && t.closest && t.closest(free)) return;
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    document.addEventListener('dblclick', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    document.addEventListener('contextmenu', (e) => { if (e.cancelable) e.preventDefault(); });
    window.addEventListener('resize', () => onResize(false));
    window.addEventListener('orientationchange', () => { setTimeout(() => onResize(false), 120); setTimeout(() => onResize(false), 500); });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', () => onResize(false));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hidden = true; autosave('hidden'); }
      else { hidden = false; lastT = 0; acc = 0; onResize(false); }
    });
    window.addEventListener('pagehide', () => { autosave('pagehide'); });
    window.addEventListener('pageshow', () => { hidden = document.hidden; lastT = 0; acc = 0; });
  }

  // ------------------------------------------------------------------ debug hook
  function exposeDebug() {
    window.__god = {
      S, Sim, World, Units, Cities, Kingdoms, Diplomacy, War, Powers, Render, Save, UI, Const,
      setSpeed, getSpeed,
      step(n) { n = n === undefined ? 1 : n | 0; for (let i = 0; i < n; i++) Sim.step(); try { Sim.stats(); } catch (e) { /* ignore */ } return S.tick; },
      // extras for tests
      Main, Input, Sprites, Buildings, Fx, Log, Names, Tabs, ToolDefs, Races, Traits, Gear, Util, R, Bus, Tiles,
      stats, get errors() { return errs; },
    };
  }

  // ------------------------------------------------------------------ boot
  function boot() {
    if (booted) return;
    booted = true;
    const msg = $('splashMsg');
    try {
      installGuards();
      Sprites.init();
      let loaded = false;
      try { if (Save.exists('auto')) loaded = Save.load('auto'); } catch (e) { loaded = false; }
      if (!loaded) Sim.newWorld({ populate: true });
      canvas = $('game');
      Render.init(canvas);
      onResize(true);
      Input.init(canvas, { onTap: (x, y) => UI.handleTap(x, y), onPaint: (x, y, p) => UI.handlePaint(x, y, p) });
      UI.init();
      UI.layout();
      initialView(true);
      exposeDebug();
      lastAutosaveAt = performance.now(); lastAutosaveTick = S.tick;
      start();
      requestAnimationFrame(() => {
        const sp = $('splash');
        if (sp) { sp.classList.add('out'); setTimeout(() => { if (sp.parentNode) sp.parentNode.removeChild(sp); document.body.classList.remove('booting'); }, 600); }
      });
    } catch (e) {
      console.error('boot failed', e);
      if (msg) msg.textContent = 'Не удалось запустить игру: ' + (e && e.message ? e.message : e);
      showError(e && e.message ? e.message : e);
    }
  }

  return {
    boot, guard: installGuards, setSpeed, getSpeed, newWorld, worldReplaced, resetView, focusTile, initialView, autosave, onResize, start, stop,
    get hidden() { return hidden; },
  };
})();

// Boot after the first paint so the "Загрузка…" splash is really visible while the world is generated.
Main.guard();
if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(Main.boot, 0));
setTimeout(Main.boot, 400);        // safety net when rAF is throttled (boot is idempotent)
