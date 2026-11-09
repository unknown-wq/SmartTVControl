/* =====================================================================
 * 22_input.js — Input: touch-first camera control + tap / paint
 * OWNER: Render+Input agent. API: docs/CONTRACT.md §4 Input.
 *
 *  Input.init(canvas, {onTap(tx,ty), onPaint(tx,ty,phase), onHover?(tx,ty)})   tx,ty = float tile coords
 *  Input.mode = 'pan' | 'paint'  (Input.setMode(m))
 *
 *  pan mode   : 1 finger drag = pan (with inertia), tap (<10 px, <350 ms) = onTap
 *  paint mode : 1 finger = onPaint('start'|'move'|'end') with interpolated points (no gaps), no camera movement
 *  both modes : 2 fingers = pinch zoom about the midpoint + pan with the midpoint
 *  mouse      : drag = pan, wheel = zoom, click = tap, Shift+drag = paint (in paint mode: drag = paint, Shift+drag = pan)
 *
 *  Implementation notes: Pointer Events do the work (pointer capture, touch-action:none); touch / gesture / dblclick /
 *  contextmenu listeners only call preventDefault so iOS never scrolls, zooms the page or shows the callout.
 * ===================================================================== */

const Input = (() => {
  const TAP_DIST = 10, TAP_MS = 350, PAN_SLOP = 3, PAINT_DELAY = 70, PAINT_SLOP = 6;
  const STEP = 0.45;                         // max distance (tiles) between interpolated paint points
  let canvas = null, H = {};
  let rect = { left: 0, top: 0 };
  const ptrs = new Map();                    // pointerId -> {id,x,y,sx,sy,t0,type,shift}
  let gesture = null;                        // null | 'tap' (undecided) | 'pan' | 'paint' | 'pinch' | 'idle'
  let pending = null;                        // pending paint start (touch, short delay)
  let painting = false, lastPx = 0, lastPy = 0;
  let pinch = null, pinchMidX = 0, pinchMidY = 0, settleTimer = 0, afterPinch = false;
  let downTile = null;                       // tile under the first finger at touch-down (for taps)
  let moved = false;                         // finger travelled beyond the tap distance
  let panActive = false, suppressTap = false;
  // velocity samples (px, ms)
  const vs = new Float64Array(24); let vn = 0;
  let inertia = null, inertiaRaf = 0;

  const api = {
    mode: 'pan',
    setMode(m) {
      if (m !== 'pan' && m !== 'paint') return;
      if (m === api.mode) return;
      endPaint();
      api.mode = m;
    },
    init, cancel, destroy,
    get gesturing() { return ptrs.size > 0; },
    get painting() { return painting; },
  };

  // ------------------------------------------------------------------ helpers
  function cssPos(e, out) { out.x = e.clientX - rect.left; out.y = e.clientY - rect.top; return out; }
  const tmp = { x: 0, y: 0 };
  function toTile(x, y) { return Render.screenToTile(x, y); }
  function refreshRect() { const r = canvas.getBoundingClientRect(); rect.left = r.left; rect.top = r.top; }
  function now() { return performance.now(); }

  function stopInertia() { inertia = null; if (inertiaRaf) { cancelAnimationFrame(inertiaRaf); inertiaRaf = 0; } }
  function inertiaStep(t) {
    inertiaRaf = 0;
    if (!inertia) return;
    if (inertia.serial !== Render.camSerial) { inertia = null; return; }       // camera was set programmatically meanwhile
    let dt = t - inertia.t; inertia.t = t;
    if (dt > 64) dt = 64;
    if (dt <= 0) { inertiaRaf = requestAnimationFrame(inertiaStep); return; }
    const free = Render.panBy(inertia.vx * dt, inertia.vy * dt);
    const k = Math.exp(-dt / 210);
    inertia.vx *= k; inertia.vy *= k;
    if (!free) { inertia.vx *= 0.35; inertia.vy *= 0.35; }
    if (Math.abs(inertia.vx) + Math.abs(inertia.vy) < 0.02) { inertia = null; return; }
    inertiaRaf = requestAnimationFrame(inertiaStep);
  }
  function startInertia() {      // -> true when a glide was started
    // velocity from the samples of the last ~90 ms
    if (vn < 2) return false;
    const last = vn - 1, tEnd = vs[last * 3 + 2];
    if (now() - tEnd > 90) return false;                        // finger rested before lifting
    let i0 = last;
    while (i0 > 0 && tEnd - vs[(i0 - 1) * 3 + 2] < 90) i0--;
    const dt = tEnd - vs[i0 * 3 + 2];
    if (dt < 12) return false;
    let vx = (vs[last * 3] - vs[i0 * 3]) / dt, vy = (vs[last * 3 + 1] - vs[i0 * 3 + 1]) / dt;
    const sp = Math.sqrt(vx * vx + vy * vy);
    if (sp < 0.12) return false;
    const max = 3.2;
    if (sp > max) { vx *= max / sp; vy *= max / sp; }
    inertia = { vx, vy, t: now(), serial: Render.camSerial };
    inertiaRaf = requestAnimationFrame(inertiaStep);
    return true;
  }
  function sample(x, y) {
    if (vn >= 8) { vs.copyWithin(0, 3, vn * 3); vn--; }
    vs[vn * 3] = x; vs[vn * 3 + 1] = y; vs[vn * 3 + 2] = now(); vn++;
  }

  function emitPaint(x, y, phase) {
    if (!H.onPaint) return;
    const t = toTile(x, y);
    H.onPaint(t.x, t.y, phase);
  }
  function beginPaint(x, y) {
    if (painting) return;
    painting = true;
    lastPx = x; lastPy = y;
    emitPaint(x, y, 'start');
  }
  function movePaint(x, y) {
    if (!painting || (x === lastPx && y === lastPy)) return;
    const a = toTile(lastPx, lastPy), b = toTile(x, y);
    const dx = b.x - a.x, dy = b.y - a.y, dist = Math.sqrt(dx * dx + dy * dy);
    if (H.onPaint) {
      const n = Math.min(64, Math.ceil(dist / STEP));
      for (let i = 1; i < n; i++) H.onPaint(a.x + dx * i / n, a.y + dy * i / n, 'move');
      H.onPaint(b.x, b.y, 'move');
    }
    lastPx = x; lastPy = y;
  }
  function endPaint() {
    if (pending) { clearTimeout(pending.timer); pending = null; }
    if (!painting) return;
    painting = false;
    emitPaint(lastPx, lastPy, 'end');
  }

  function startPinch() {
    let a = null, b = null;
    for (const p of ptrs.values()) { if (!a) a = p; else { b = p; break; } }
    if (!a || !b) return;
    const d = Math.max(8, Math.hypot(b.x - a.x, b.y - a.y));
    const w = toTile((a.x + b.x) / 2, (a.y + b.y) / 2);
    pinch = { a, b, d0: d, zoom0: Render.cam.zoom, wx: w.x, wy: w.y };
    gesture = 'pinch';
    panActive = false;
  }
  function updatePinch() {
    if (!pinch) return;
    const a = pinch.a, b = pinch.b;
    const d = Math.max(8, Math.hypot(b.x - a.x, b.y - a.y));
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    pinchMidX = mx; pinchMidY = my;
    const size = Render.size;
    const z = Math.min(Render.maxZoom(), Math.max(Render.minZoom(), pinch.zoom0 * d / pinch.d0));
    Render.setCamera(pinch.wx - (mx - size.w / 2) / z, pinch.wy - (my - size.h / 2) / z, z);
  }

  // ------------------------------------------------------------------ pointer handlers
  function paintWanted(p) {
    if (p.type === 'mouse') return api.mode === 'paint' ? !p.shift : p.shift;
    return api.mode === 'paint';
  }
  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
    if (e.isPrimary && ptrs.size > 0) cancel();            // a lost pointerup left stale pointers behind: start clean
    const wasGliding = !!inertia;
    stopInertia();
    Render.cancelGlide();
    refreshRect();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const p = { id: e.pointerId, x: 0, y: 0, sx: 0, sy: 0, t0: now(), type: e.pointerType || 'touch', shift: !!e.shiftKey };
    cssPos(e, tmp); p.x = p.sx = tmp.x; p.y = p.sy = tmp.y;
    ptrs.set(e.pointerId, p);
    if (e.cancelable) e.preventDefault();
    if (ptrs.size === 1) {
      moved = false; panActive = false; vn = 0; afterPinch = false; suppressTap = wasGliding;   // a touch that stops a glide is not a tap
      downTile = toTile(p.x, p.y);
      if (e.pointerType === 'mouse' && e.button === 1) { gesture = 'pan'; sample(p.x, p.y); return; }
      if (paintWanted(p)) {
        gesture = 'paint';
        if (p.type === 'mouse') beginPaint(p.x, p.y);
        else pending = { timer: setTimeout(() => { pending = null; if (gesture === 'paint' && ptrs.size === 1) { const q = firstPtr(); if (q) beginPaint(q.x, q.y); } }, PAINT_DELAY) };
      } else { gesture = 'tap'; sample(p.x, p.y); }
    } else if (ptrs.size === 2) {
      // second finger: abandon any single-finger action and pinch
      if (pending) { clearTimeout(pending.timer); pending = null; }
      endPaint();
      startPinch();
    }
    // 3+ pointers are ignored
  }
  function firstPtr() { for (const p of ptrs.values()) return p; return null; }

  function onMove(e) {
    const p = ptrs.get(e.pointerId);
    if (!p) {
      if (e.pointerType === 'mouse' && H.onHover && ptrs.size === 0) {
        refreshRect(); cssPos(e, tmp);
        const t = toTile(tmp.x, tmp.y); H.onHover(t.x, t.y);
      }
      return;
    }
    if (e.cancelable) e.preventDefault();
    cssPos(e, tmp);
    const px = p.x, py = p.y;
    p.x = tmp.x; p.y = tmp.y;
    if (gesture === 'pinch') { updatePinch(); return; }
    if (ptrs.size > 1) return;
    const dxs = p.x - p.sx, dys = p.y - p.sy;
    if (!moved && dxs * dxs + dys * dys >= TAP_DIST * TAP_DIST) moved = true;
    if (gesture === 'paint') {
      if (pending) {
        if (dxs * dxs + dys * dys >= PAINT_SLOP * PAINT_SLOP) { clearTimeout(pending.timer); pending = null; beginPaint(p.sx, p.sy); movePaint(p.x, p.y); }
      } else movePaint(p.x, p.y);
      return;
    }
    if (gesture === 'tap' || gesture === 'pan') {
      if (!panActive) {
        if (dxs * dxs + dys * dys < PAN_SLOP * PAN_SLOP) return;
        panActive = true; gesture = 'pan';
        Render.panBy(p.x - p.sx, p.y - p.sy);
      } else Render.panBy(p.x - px, p.y - py);
      sample(p.x, p.y);
    }
  }

  function finish(e, cancelled) {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    cssPos(e, tmp);
    if (!cancelled) { p.x = tmp.x; p.y = tmp.y; }
    ptrs.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (e.cancelable) e.preventDefault();
    const was = gesture;
    if (was === 'pinch') {
      pinch = null;
      if (ptrs.size >= 2) startPinch();                    // a third finger takes over
      else if (ptrs.size === 1) {                          // one finger stays: continue as a pan from here
        const q = firstPtr();
        gesture = 'pan'; panActive = true; moved = true; vn = 0; afterPinch = true;
        q.sx = q.x; q.sy = q.y; sample(q.x, q.y);
      } else { gesture = null; Render.settleZoom(pinchMidX, pinchMidY); }
      return;
    }
    if (ptrs.size > 0) return;
    gesture = null;
    if (was === 'paint') {
      if (pending) { clearTimeout(pending.timer); pending = null; if (!cancelled) { beginPaint(p.x, p.y); } }
      if (painting) { if (!cancelled) movePaint(p.x, p.y); endPaint(); }
      return;
    }
    if (cancelled) { if (was === 'pan') startInertia(); return; }
    if ((was === 'tap' || was === 'pan') && !moved && !suppressTap && now() - p.t0 < TAP_MS) {    // a few px of drift still counts as a tap
      if (H.onTap && downTile) H.onTap(downTile.x, downTile.y);
      return;
    }
    if (was === 'pan') {
      const ap = afterPinch; afterPinch = false;
      if (!startInertia() && ap) Render.settleZoom(p.x, p.y);
    }
  }

  function onWheel(e) {
    e.preventDefault();
    Render.cancelGlide();
    refreshRect();
    stopInertia();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= 400;
    const k = e.ctrlKey ? 0.012 : 0.0016;
    const f = Math.exp(-Math.max(-300, Math.min(300, dy)) * k);
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    Render.zoomAt(Render.cam.zoom * f, mx, my);
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { settleTimer = 0; Render.settleZoom(mx, my); }, 180);
  }

  function block(e) { if (e.cancelable) e.preventDefault(); }

  // ------------------------------------------------------------------ lifecycle
  const bound = [];
  function on(target, type, fn, opts) { target.addEventListener(type, fn, opts); bound.push([target, type, fn, opts]); }

  function init(c, handlers) {
    destroy();
    canvas = c;
    H = handlers || {};
    refreshRect();
    const st = canvas.style;
    st.touchAction = 'none'; st.userSelect = 'none'; st.webkitUserSelect = 'none'; st.webkitTouchCallout = 'none';
    st.webkitTapHighlightColor = 'transparent'; st.msTouchAction = 'none';
    const pf = { passive: false };
    on(canvas, 'pointerdown', onDown, pf);
    on(canvas, 'pointermove', onMove, pf);
    on(canvas, 'pointerup', e => finish(e, false), pf);
    on(canvas, 'pointercancel', e => finish(e, true), pf);
    on(canvas, 'wheel', onWheel, pf);
    on(canvas, 'contextmenu', block);
    on(canvas, 'dblclick', block);
    on(canvas, 'dragstart', block);
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) on(canvas, t, block, pf);
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) { on(canvas, t, block, pf); on(document, t, block, pf); }
    on(window, 'blur', cancel);
    on(window, 'resize', refreshRect);
    on(window, 'scroll', refreshRect);
  }
  function cancel() {
    stopInertia();
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = 0; }
    if (pending) { clearTimeout(pending.timer); pending = null; }
    endPaint();
    ptrs.clear(); gesture = null; pinch = null; moved = false; panActive = false;
  }
  function destroy() {
    cancel();
    for (const b of bound) b[0].removeEventListener(b[1], b[2], b[3]);
    bound.length = 0;
  }

  return api;
})();
