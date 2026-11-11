// Demo plugin used by tests/plugins.test.mjs: exercises every plugin hook (CONTRACT section 10). Not part of the game build.
// Appended in the same scope as the game code (harness opts.extra / build.mjs --extra), so core globals are visible.
const PowerDemo = (() => {
  ToolDefs.groupLabels.arsenal = 'Арсенал';
  ToolDefs.add({ id: 'demo_blast', tab: 'powers', group: 'arsenal', afterGroup: 'destroy', name: 'Демо-взрыв', short: 'Демо', icon: 'demo_blast', brush: true, drag: false, hint: 'Тестовая сила' });
  const counts = GfxPlugins.__counts = { icon: 0, fx: 0, effect: 0 };
  if (typeof window !== 'undefined') window.__demoCounts = counts;
  function list() { const e = S.eff; if (!Array.isArray(e.demo_blast)) e.demo_blast = []; return e.demo_blast; }
  const api = {
    name: 'demo',
    ids: ['demo_blast'],
    apply(id, x, y, r, first, lx, ly, host) {
      list().push({ x, y, r, t0: S.tick, until: S.tick + 30 });
      host.fx('demo_fx', x, y, { ttl: 0.6, r });
      Fx.add('shake', x, y, { amp: 8, ttl: 0.5 });
      Fx.add('flash', x, y, { ttl: 1.5, a: 1, color: '#ffffff' });
      Units.nearby(x, y, r, (u) => { u.demoMark = S.tick + 50; });
      return host.msg('Демо-взрыв', true);
    },
    step(tick, host) {
      const m = S.mod.demo || (S.mod.demo = { steps: 0 });
      m.steps++;
      const L = list();
      let w = 0;
      for (let i = 0; i < L.length; i++) if (L[i].until > tick) L[w++] = L[i];
      L.length = w;
    },
    newWorld() { S.mod.demo = { steps: 0 }; },
    afterLoad() { if (!S.mod.demo) S.mod.demo = { steps: 0 }; },
  };
  PowerPlugins.push(api);
  // a second plugin whose step throws: must be isolated (Powers.errors) and must not stop other plugins
  if (typeof window === 'undefined') PowerPlugins.push({ name: 'demo_bad', ids: [], step() { throw new Error('demo plugin failure'); } });   // headless only (the browser test must see no console errors)
  // ---- graphics
  GfxPlugins.icons.demo_blast = (b, IP, H) => { b.rect(3, 3, 9, 9, IP.r); b.rect(5, 5, 5, 5, IP.y); b.set(7, 7, IP.w); counts.icon++; };
  GfxPlugins.fx.demo_fx = (ctx, fx, px, py, scale, u, p, now, HH) => { counts.fx++; ctx.fillStyle = 'rgba(255,120,40,' + (1 - p).toFixed(2) + ')'; ctx.beginPath(); ctx.arc(px, py, scale * (1 + 2 * p), 0, Math.PI * 2); ctx.fill(); };
  GfxPlugins.addEffect({ key: 'demo_blast', margin: 4, draw(ctx, e, px, py, scale, now, H, alpha) { counts.effect++; ctx.fillStyle = 'rgba(255,0,200,0.6)'; ctx.fillRect(px - scale * 0.5, py - scale * 0.5, scale, scale); } });
  GfxPlugins.addUnitTint('demoMark', 'rgba(255,0,255,0.55)');
  UIPlugins.unitBadges.push((u) => (u.demoMark > S.tick ? { t: 'Демо', cls: 'warn' } : null));
  return api;
})();
