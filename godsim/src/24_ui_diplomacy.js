/* =====================================================================
 * 24_ui_diplomacy.js — DiploUI: the player-diplomacy tool «Дипломатия» (ToolDefs id 'diplomacy'). Client module, Russian strings.
 * Owned by the player-diplomacy feature (docs/feat_diplomacy.md). UI (23_ui.js) calls DiploUI.init(kit) once and routes taps / keys / updates here;
 * everything the sheet needs from UI's private helpers comes through that `kit` (el, btn, ico, flagEl, toast, refs, state, camera helpers ...).
 *
 *  FLOW (mirrors the war tool): 1) tap your country (it becomes the actor = Kingdoms.setCommanded; a slim HUD replaces the dock: contacts strip,
 *  inbox badge, ✕ releases)  2) tap another country on the map (or a flag chip of the strip): the PAIR CARD — both flags, opinion bar with its causes,
 *  status chips (Мир / Союз / Пакт / Торговля / Брак / Вассал / Война / Перемирие ...) and every action from Diplomacy.actionsFor as a big button with the
 *  forecast of the answer, the cost, or the reason why it is unavailable  3) a tap answers at once: result strip + small animation, the card refreshes.
 *  Actions with terms open an inline panel (pact length, gift goods, demand terms, call-to-arms war); breaking a treaty needs a second tap.
 *  INBOX: proposals TO the commanded kingdom (Diplomacy.inbox) arrive as a toast + a badge (HUD button and a floating ✉ button on the map) and are answered
 *  in a modal list with [Принять] [Отклонить].
 *  No sim rules live here: availability / odds / costs / reasons all come from Diplomacy (actionsFor / card / propose / respond / inbox).
 *  State that must never get stuck: body classes dip / dip-card, Render.cmd, #sheet classes, popups, toasts — release / yield / reset clean them all.
 * ===================================================================== */

const DiploUI = (() => {
  let kit = null, ready = false;
  const dm = {
    kid: 0, other: 0, mode: 'hud', sub: null, owns: false, mapPrev: -1, rc: null, region: 0,
    causesOpen: false, armed: '', armedT: 0, view: null, tick: 0, sig: '', stripSig: '', fab: null, fabN: -1, mailBtn: null, modal: null,
  };
  const NONE = Object.freeze([]);
  const GROUP_ORDER = ['treaty', 'give', 'force', 'war', 'vassal', 'break'];
  const TONE_CLS = { good: 'good', warn: 'warn', bad: 'bad', gold: 'gold', blue: 'blue', purple: 'purple' };
  const GOODS = ['food', 'wood', 'stone', 'iron', 'gold'];
  const GOOD_LABEL = { food: 'Еда', wood: 'Дерево', stone: 'Камень', iron: 'Железо', gold: 'Золото' };
  const STEP = { food: 10, wood: 5, stone: 5, iron: 5, gold: 1 };

  // ------------------------------------------------------------------ helpers
  const K = (kid) => { const k = S.kingdoms.get(kid); return k && k.alive !== false ? k : null; };
  function safe(fn, dflt) { try { const r = fn(); return r === undefined || r === null ? dflt : r; } catch (e) { return dflt; } }
  function yrs(ticks) { return Math.max(1, Math.round(ticks / Const.TICKS_PER_YEAR)) + ' л.'; }
  function sgn(v) { const a = Math.abs(v), s = a < 10 ? String(Math.round(a * 10) / 10) : String(Math.round(a)); return (v < 0 ? '−' : '+') + s; }
  function commandedKid() { for (const k of S.kingdoms.values()) if (k.cmd === true && k.alive !== false) return k.id; return 0; }
  function opColor(o) { return o <= -60 ? '#ff4b4b' : o < -15 ? '#ff9a3a' : o <= 15 ? '#c7cfe3' : o < 60 ? '#8be28f' : '#35d672'; }
  function toneOf(t) { return TONE_CLS[t] || ''; }
  function active() { return dm.kid > 0; }
  function sheet() { return kit.refs.sheet; }

  // ------------------------------------------------------------------ Render.cmd (the actor's outline, the partner's regions as pale selectable land)
  function rcSync() {
    if (!dm.kid) return;
    const rc = dm.rc || (dm.rc = { kid: dm.kid, regionId: 0, armyId: 0, goals: NONE, candidates: NONE, targetKid: 0, sel: 1, tgt: 0, ckids: NONE, dim: NONE, arrows: NONE, arrowT0: 0 });
    rc.kid = dm.kid; rc.sel = 1; rc.tgt = 0; rc.regionId = dm.region || 0;
    rc.candidates = dm.other ? kit.ownRegionIds(dm.other) : NONE;
    Render.cmd = rc;
  }
  function clearRc() { if (dm.rc && Render.cmd === dm.rc) Render.cmd = null; dm.rc = null; }
  function pulseRegion(rid) { dm.region = rid | 0; rcSync(); }

  // ------------------------------------------------------------------ select / release
  function enterMapView() {
    const st = kit.state;
    dm.mapPrev = st.mapMode;
    if (st.mapMode === 0) kit.setMapMode(1);
    if (st.mode === 'paint') kit.setPan();
  }
  function leaveMapView() {
    if (dm.mapPrev === 0 && kit.state.mapMode === 1) kit.setMapMode(0);
    dm.mapPrev = -1;
  }
  /** the player takes over a kingdom as the diplomatic actor */
  function select(kid, opts) {
    opts = opts || {};
    if (!ready) return false;
    const k = K(kid);
    if (!k) { kit.toast('Королевство недоступно', 'bad'); return false; }
    if (dm.kid === kid) {
      if (dm.other) closeCard();
      if (opts.focus !== false) focusActor();
      return true;
    }
    kit.releaseWar();
    let ok = false;
    try { ok = Kingdoms.setCommanded(kid, true); } catch (e) { ok = false; }
    if (!ok) { kit.toast('Не удалось выбрать это королевство', 'bad'); return false; }
    kit.closeInspector();
    const was = dm.kid;
    dm.kid = kid; dm.other = 0; dm.mode = 'hud'; dm.sub = null; dm.region = 0; dm.armed = ''; dm.causesOpen = false; dm.sig = ''; dm.stripSig = '';
    if (!was) enterMapView();
    rcSync();
    showSheet();
    if (opts.focus !== false) kit.defer(() => { if (dm.kid === kid && !dm.other) focusActor(); });
    if (was) kit.toast('Выбрана страна «' + k.name + '»');
    else kit.hintOnce('dipflow', 'Тапните другую страну на карте (или флажок внизу): договоры, подарки, требования');
    refreshFab();
    return true;
  }
  function release(quiet) {
    if (!dm.kid) return;
    const kid = dm.kid;
    closeInboxModal();
    safe(() => Kingdoms.setCommanded(kid, false), 0);
    const owned = dm.owns;
    clearRc();
    dm.kid = 0; dm.other = 0; dm.sub = null; dm.region = 0; dm.armed = ''; dm.view = null; dm.owns = false; dm.sig = ''; dm.stripSig = '';
    leaveMapView();
    document.body.classList.remove('dip', 'dip-card');
    if (owned) closeSheetDom();
    const k = K(kid);
    if (!quiet) kit.toast(k ? 'Выбор снят: «' + k.name + '» снова решает само' : 'Выбор снят');
    refreshFab();
  }
  function closeSheetDom() {
    const sh = sheet();
    sh.classList.remove('dip', 'dh', 'dc', 'dsub');
    sh._mode = '';
    if (!kit.inspectorOpen()) {
      kit.refs.bottom.classList.remove('sheet-open');
      kit.clear(sh);
      kit.layoutSoon();
    }
  }
  /** the inspector (or the war sheet) takes the bottom sheet: forget our classes, keep the state */
  function yieldSheet() {
    if (!dm.owns) return;
    dm.owns = false; dm.view = null;
    const sh = sheet();
    sh.classList.remove('dip', 'dh', 'dc', 'dsub');
    document.body.classList.remove('dip-card');
  }
  /** the inspector closed: our sheet comes back */
  function resume() {
    if (!dm.kid) return false;
    rcSync();
    showSheet();
    return true;
  }
  function focusActor() {
    const ids = kit.ownRegionIds(dm.kid);
    if (ids.length && kit.fitRegions(ids, 5, 10, true)) return;
    const k = K(dm.kid), c = k && (S.cities.get(k.capitalId) || S.cities.get(k.cities[0]));
    if (c) kit.focusVisible(c.x + 0.5, c.y + 0.5, Math.max(Render.cam.zoom, 8));
  }
  function focusPair() {
    const ids = kit.ownRegionIds(dm.kid).concat(kit.ownRegionIds(dm.other));
    if (ids.length) kit.fitRegions(ids, 4, 9, true);
  }

  // ------------------------------------------------------------------ the pair card
  function openPair(other, opts) {
    opts = opts || {};
    if (!dm.kid || !K(other) || other === dm.kid) return false;
    dm.other = other; dm.mode = 'card'; dm.sub = null; dm.region = 0; dm.armed = ''; dm.causesOpen = false; dm.sig = '';
    rcSync();
    showSheet();
    if (opts.focus !== false) kit.defer(() => { if (dm.other === other) focusPair(); });
    kit.hintOnce('dipcard', 'Кнопки показывают ответ заранее. Серые — недоступны: причина написана на кнопке.');
    return true;
  }
  function closeCard() {
    if (!dm.other) return;
    dm.other = 0; dm.mode = 'hud'; dm.sub = null; dm.region = 0; dm.armed = ''; dm.sig = '';
    rcSync();
    showSheet();
  }
  /** one step back: panel -> card -> HUD -> release */
  function back() {
    if (!dm.kid) return;
    if (dm.sub) { back2(); return; }
    if (dm.other) { closeCard(); return; }
    release();
  }

  // ------------------------------------------------------------------ sheet frame
  function showSheet() {
    if (!dm.kid) return;
    const k = K(dm.kid);
    if (!k) { release(true); return; }
    const sh = sheet(), mode = dm.other ? 'dc' : 'dh';
    kit.clear(sh);
    if (!dm.owns || sh._mode !== 'dip' + mode) { sh.style.animation = 'none'; void sh.offsetWidth; sh.style.animation = ''; }
    sh._mode = 'dip' + mode;
    dm.owns = true;
    ['cmd', 'gm', 'pm', 'am', 'hud', 'tc', 'dr'].forEach((c) => sh.classList.remove(c));
    sh.classList.add('dip'); sh.classList.toggle('dh', mode === 'dh'); sh.classList.toggle('dc', mode === 'dc'); sh.classList.toggle('dsub', !!dm.sub && mode === 'dc');
    document.body.classList.add('dip');
    document.body.classList.toggle('dip-card', mode === 'dc');
    document.body.classList.remove('cmd', 'cmd-pick', 'cmd-drawer');
    kit.refs.bottom.classList.add('sheet-open');
    dm.view = null; dm.sig = ''; dm.stripSig = '';
    if (mode === 'dc') buildCard(sh, k); else buildHud(sh, k);
    kit.layoutSoon();
  }

  // ------------------------------------------------------------------ HUD: the actor + the contacts strip + the inbox badge
  function mailButton() {
    const b = kit.btn('sh-btn dipmail hide', 'Предложения', () => openInbox());
    b.dataset.act = 'dip-inbox';
    b.appendChild(kit.ico('mail', 24));
    const n = kit.el('i', 'dn', '0'); b.appendChild(n);
    dm.mailBtn = { b, n };
    return b;
  }
  function buildHud(sh, k) {
    const v = { ups: [] };
    dm.view = v;
    const head = kit.el('div', 'sh-head cm-head hud-head dip-head');
    const ava = kit.el('div', 'sh-ava'); const fl = kit.flagEl(k.flag, 32); ava.appendChild(fl); head.appendChild(ava);
    const tt = kit.el('div', 'sh-title'); const t1 = kit.el('b'); const t2 = kit.el('small'); tt.appendChild(t1); tt.appendChild(t2); head.appendChild(tt);
    head.appendChild(mailButton());
    const info = kit.btn('sh-btn', 'О королевстве', () => { kit.openInspector('kingdom', dm.kid, { focus: true }); }); info.dataset.act = 'dip-info'; info.appendChild(kit.ico('crown', 24));
    const cb = kit.btn('sh-btn', 'Снять выбор страны', () => release()); cb.dataset.act = 'release'; cb.appendChild(kit.ico('close', 24));
    head.appendChild(info); head.appendChild(cb);
    sh.appendChild(head);
    const strip = kit.el('div', 'dip-strip hscroll'); sh.appendChild(strip);
    const hint = kit.el('div', 'hud-hint dip-hint'); sh.appendChild(hint);
    v.ups.push(() => {
      const kk = K(dm.kid); if (!kk) return;
      kit.drawFlag(fl, kk.flag);
      kit.setText(t1, kk.name);
      const st = kit.kStats(dm.kid), u = S.units.get(kk.rulerId);
      kit.setText(t2, st.pop + ' жит. · ' + st.regions + ' рег. · ' + (u ? Names.ruler(u.race, u.sex) + ' ' + u.name : 'трон пуст'));
      updateStrip(strip);
      const nIn = inboxList().length;
      kit.setText(hint, nIn ? 'Ждут ответа предложения: ' + nIn + '. Нажмите ✉.' : 'Тапните другую страну на карте или флажок выше — откроется дипломатия.');
      kit.setCls(hint, 'idle', !nIn);
      updateMail();
    });
    runUps(v.ups);
  }
  function runUps(list) { for (let i = 0; i < list.length; i++) { try { list[i](); } catch (e) { reportOnce('dip.up', e); } } }
  const warned = {};
  function reportOnce(key, e) { if (!warned[key]) { warned[key] = 1; console.error(key, e); } }

  /** every other kingdom as a flag chip: opinion pip + the status icons; sorted: neighbours first, then by opinion */
  function updateStrip(strip) {
    const rels = safe(() => Diplomacy.relationsOf(dm.kid), []).filter((r) => K(r.other));
    rels.sort((a, b) => (b.contact > 0) - (a.contact > 0) || (b.state === 2) - (a.state === 2) || b.opinion - a.opinion || a.other - b.other);
    let sig = '';
    for (const r of rels) sig += r.other + ':' + r.opinion + ':' + r.state + (r.pact ? 'p' : '') + (r.trade ? 't' : '') + (r.marriage ? 'm' : '') + (r.vassal || '') + (r.embargo ? 'e' : '') + (r.guarantee || '') + ';';
    if (sig === dm.stripSig) return;
    dm.stripSig = sig;
    kit.clear(strip);
    if (!rels.length) { strip.appendChild(kit.el('span', 'muted dip-none', 'Других королевств пока нет')); return; }
    for (const r of rels) {
      const ok = K(r.other); if (!ok) continue;
      const c = kit.btn('dchip', 'Дипломатия с «' + ok.name + '»', () => openPair(r.other));
      c.dataset.act = 'dip-chip'; c.dataset.kid = r.other;
      c.appendChild(kit.flagEl(ok.flag, 24));
      const tx = kit.el('span', 'dc-t'); tx.appendChild(kit.el('b', '', ok.name));
      const sm = kit.el('small', '');
      const pip = kit.el('i', 'dc-pip'); pip.style.backgroundColor = opColor(r.opinion);
      sm.appendChild(pip); sm.appendChild(document.createTextNode((r.opinion > 0 ? '+' : '') + r.opinion));
      tx.appendChild(sm); c.appendChild(tx);
      const st = kit.el('span', 'dc-st');
      if (r.state === 2) st.appendChild(kit.ico('sword', 16));
      else if (r.vassal) st.appendChild(kit.ico('crown', 16));
      else if (r.state === 1) st.appendChild(kit.ico('heart', 16));
      else if (r.pact) st.appendChild(kit.ico('pact', 16));
      if (r.trade && r.state !== 2) st.appendChild(kit.ico('trade', 16));
      if (r.marriage) st.appendChild(kit.ico('marriage', 16));
      if (st.children.length) c.appendChild(st);
      c.classList.toggle('war', r.state === 2);
      c.classList.toggle('ally', r.state === 1 && !r.vassal);
      strip.appendChild(c);
    }
  }

  // ------------------------------------------------------------------ the pair card
  function chipEl(c) {
    const e = kit.el('span', 'chip ' + toneOf(c.tone));
    const ic = { war: 'sword', alliance: 'heart', pact: 'pact', truce: 'peace', trade: 'trade', marriage: 'marriage', guarantee: 'guarantee', embargo: 'embargo', overlord: 'crown', vassal: 'crown' }[c.id];
    if (ic) e.appendChild(kit.ico(ic, 16));
    e.appendChild(document.createTextNode(c.text + (c.left ? ' · ' + yrs(c.left) : '')));
    e.dataset.chip = c.id;
    return e;
  }
  function buildCard(sh, ka) {
    const kb = K(dm.other);
    const v = { ups: [], card: null };
    dm.view = v;
    const head = kit.el('div', 'sh-head tc-head dip-head');
    const vs = kit.el('div', 'tc-vs dip-vs');
    const a1 = kit.el('span', 'tc-side a'); const fa = kit.flagEl(ka.flag, 24); a1.appendChild(fa); a1.appendChild(kit.el('b', '', ka.name));
    const x = kit.el('span', 'tc-x dip-x'); x.appendChild(kit.ico('handshake', 16)); v.x = x;
    const d1 = kit.el('span', 'tc-side d'); const fb = kit.flagEl(kb.flag, 24); d1.appendChild(fb); d1.appendChild(kit.el('b', '', kb.name));
    vs.appendChild(a1); vs.appendChild(x); vs.appendChild(d1);
    v.fa = fa; v.fb = fb; v.d1 = d1; v.a1 = a1;
    const ttl = kit.el('div', 'tc-tt'); ttl.appendChild(vs);
    const sub = kit.el('small', 'tc-sub'); ttl.appendChild(sub);
    head.appendChild(ttl);
    const cb = kit.btn('sh-btn', 'Закрыть карточку', () => closeCard()); cb.dataset.act = 'dip-close'; cb.appendChild(kit.ico('close', 24));
    head.appendChild(cb);
    sh.appendChild(head);
    const body = kit.el('div', 'sh-body dip-body'); sh.appendChild(body); v.body = body;
    const res = kit.el('div', 'dip-res hide'); body.appendChild(res); v.res = res;
    // opinion
    const op = kit.el('div', 'dip-op');
    const bar = kit.el('div', 'bar mid tapc dip-bar'); bar.dataset.act = 'dip-causes';
    const lb = kit.el('label', '', 'Отношения'); bar.appendChild(lb);
    const tr = kit.el('div', 'track'), fill = kit.el('div', 'fill'), tx = kit.el('div', 'txt'); tr.appendChild(fill); tr.appendChild(tx); bar.appendChild(tr);
    const mood = kit.el('span', 'dip-mood'); bar.appendChild(mood);
    op.appendChild(bar);
    const top = kit.el('div', 'chips dip-top'); op.appendChild(top);
    const all = kit.el('div', 'causes hide dip-causes'); op.appendChild(all);
    bar.addEventListener('click', () => { dm.causesOpen = !dm.causesOpen; kit.setCls(all, 'hide', !dm.causesOpen); });
    body.appendChild(op);
    const chipRow = kit.el('div', 'dip-chiprow'); body.appendChild(chipRow);
    const chips = kit.el('div', 'chips dip-chips'); chipRow.appendChild(chips);
    const more = kit.btn('dip-more', 'О королевстве «' + kb.name + '»', () => { kit.openInspector('kingdom', dm.other, { focus: true }); }); more.dataset.act = 'dip-info';
    more.appendChild(kit.ico('crown', 16)); more.appendChild(kit.el('span', '', 'О стране')); chipRow.appendChild(more);
    const grid = kit.el('div', 'dip-grid'); body.appendChild(grid); v.grid = grid;
    const foot = kit.el('div', 'sh-foot dip-foot hide'); sh.appendChild(foot); v.foot = foot;
    kit.refs.sheetBody = body;
    let chipSig = '', topSig = '', allSig = '';
    v.ups.push(() => {
      const c = safe(() => Diplomacy.card(dm.kid, dm.other), null);
      if (!c) { closeCard(); return; }
      v.card = c;
      kit.drawFlag(fa, ka.flag); kit.drawFlag(fb, kb.flag);
      const o = Util.clamp(c.opinion, -100, 100);
      kit.setStyle(fill, 'left', o < 0 ? (50 + o / 2) + '%' : '50%');
      kit.setStyle(fill, 'width', Math.abs(o) / 2 + '%');
      kit.setStyle(fill, 'backgroundColor', opColor(o));
      kit.setText(tx, (o > 0 ? '+' : '') + o);
      kit.setText(mood, c.mood);
      const ratio = c.power.ratio, rcls = ratio <= 0.75 ? 'good' : ratio >= 1.35 ? 'bad' : 'warn';
      kit.setText(sub, 'Сила ×' + (ratio < 10 ? ratio.toFixed(1) : Math.round(ratio)) + (rcls === 'good' ? ' · слабее' : rcls === 'bad' ? ' · сильнее' : ' · равны') + (c.contact > 0 ? ' · соседи' : ' · не граничат'));
      const cs = c.chips.map((q) => q.id + (q.left ? Math.round(q.left / 60) : '')).join(',');
      if (cs !== chipSig) { chipSig = cs; kit.clear(chips); c.chips.forEach((q) => chips.appendChild(chipEl(q))); }
      const lines = c.causes.filter((q) => Math.abs(q.v) >= 0.5);
      const ts = lines.slice(0, 3).map((q) => q.why + q.v).join('|');
      if (ts !== topSig) {
        topSig = ts; kit.clear(top);
        lines.slice(0, 3).forEach((q) => { const e = kit.el('span', 'chip ' + (q.v < 0 ? 'bad' : 'good')); e.appendChild(kit.el('b', '', sgn(q.v))); e.appendChild(document.createTextNode(' ' + q.why)); top.appendChild(e); });
        if (!lines.length) top.appendChild(kit.el('span', 'muted', 'Причин для отношений пока нет'));
      }
      const as = lines.map((q) => q.why + q.v).join('|');
      if (as !== allSig) {
        allSig = as; kit.clear(all);
        lines.forEach((q) => { const l = kit.el('div', 'cz'); l.appendChild(kit.el('b', q.v < 0 ? 'neg' : 'pos', sgn(q.v))); l.appendChild(kit.el('span', '', q.why)); all.appendChild(l); });
      }
      kit.setCls(all, 'hide', !dm.causesOpen);
      if (!dm.sub) renderActions(v, c);
    });
    runUps(v.ups);
    if (dm.sub) openSubPanel(dm.sub.kind, dm.sub.preset);
  }

  // ------------------------------------------------------------------ actions grid
  function actionSig(a) { return a.kind + '|' + (a.available ? 1 : 0) + '|' + (a.hint || '') + '|' + (a.reason || '') + '|' + (a.tone || '') + '|' + (a.odds === null || a.odds === undefined ? '' : Math.round(a.odds * 20)) + (dm.armed === a.kind ? '!' : ''); }
  function renderActions(v, c) {
    const acts = c.actions.slice();
    const rank = (a) => (a.available ? 0 : 100) + GROUP_ORDER.indexOf(a.group);
    acts.sort((x, y) => rank(x) - rank(y));
    const sig = acts.map(actionSig).join('||');
    if (sig === dm.sig && v.grid.children.length) return;
    dm.sig = sig;
    kit.clear(v.grid);
    if (!acts.length) { v.grid.appendChild(kit.el('div', 'muted', 'С этой страной сейчас нечего обсуждать')); return; }
    let lastGroup = '', sawOff = false;
    acts.forEach((a) => {
      if (a.available && (a.group === 'break' || a.group === 'vassal') && a.group !== lastGroup) v.grid.appendChild(kit.el('div', 'dip-cap', a.group === 'vassal' ? 'Вассал' : 'Разрыв'));
      if (!a.available && !sawOff) { sawOff = true; v.grid.appendChild(kit.el('div', 'dip-cap', 'Сейчас недоступно')); }
      lastGroup = a.group;
      v.grid.appendChild(actionButton(a));
    });
  }
  function actionButton(a) {
    const armed = dm.armed === a.kind;
    const b = kit.btn('dbtn' + (a.available ? '' : ' off') + (a.danger ? ' danger' : '') + (armed ? ' armed' : ''), a.label, () => onAction(a));
    b.dataset.act = 'dip-act'; b.dataset.kind = a.kind;
    b.appendChild(kit.ico(a.icon, 32));
    const t = kit.el('span', 'dt');
    t.appendChild(kit.el('b', '', armed ? 'Точно? ' + a.label : a.label));
    if (!a.available) t.appendChild(kit.el('i', 'dh off', cap1(a.reason)));
    else {
      t.appendChild(kit.el('i', 'dh ' + toneOf(a.tone), armed ? a.cost : (a.hint || (a.kind === 'gift' ? 'Дар не отвергают' : 'Решаете вы'))));
      if (!armed && a.cost) t.appendChild(kit.el('small', '', a.cost));
    }
    b.appendChild(t);
    if (a.odds !== null && a.odds !== undefined && a.available) {
      const od = kit.el('span', 'dodds ' + toneOf(a.tone)); const f = kit.el('i'); f.style.width = Math.round(a.odds * 100) + '%'; od.appendChild(f); b.appendChild(od);
    }
    return b;
  }
  function cap1(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /** the answer of a tap: simple kinds act at once, kinds with terms open a panel, breaking things needs a second tap */
  function onAction(a) {
    if (!dm.kid || !dm.other) return;
    if (!a.available) { showResult({ ok: false, accepted: false, pending: false, reason: cap1(a.reason) }, a, true); return; }
    if (a.kind === 'pact' || a.kind === 'gift' || a.kind === 'demand' || a.kind === 'marriage' || (a.kind === 'call' && a.options && a.options.length > 1)) { openSubPanel(a.kind); return; }
    if (a.danger) {
      if (dm.armed !== a.kind) {
        dm.armed = a.kind; clearTimeout(dm.armedT); dm.armedT = setTimeout(() => { if (dm.armed === a.kind) { dm.armed = ''; dm.sig = ''; refreshCard(); } }, 3500);
        dm.sig = ''; refreshCard();
        return;
      }
      dm.armed = ''; clearTimeout(dm.armedT);
    }
    run(a.kind, null, a);
  }
  /** Diplomacy.propose + the feedback */
  function run(kind, terms, a) {
    const res = safe(() => Diplomacy.propose(dm.kid, dm.other, kind, terms), { ok: false, accepted: false, pending: false, reason: 'Ошибка дипломатии' });
    dm.sig = '';
    showResult(res, a || { kind, label: kind, icon: 'scroll' }, false);
    afterAction(res, kind);
    refreshCard();
    return res;
  }
  function afterAction(res, kind) {
    const v = dm.view; if (!v) return;
    const cls = res.accepted ? 'bump' : (res.ok && !res.pending ? 'shake' : '');
    if (cls && v.x) { v.x.classList.remove('bump', 'shake', 'okr', 'nor'); void v.x.offsetWidth; v.x.classList.add(res.accepted ? 'bump' : 'shake', res.accepted ? 'okr' : 'nor'); }
    const tgt = res.accepted ? v.a1 : v.d1;
    if (cls && tgt) { tgt.classList.remove('hop', 'shk'); void tgt.offsetWidth; tgt.classList.add(res.accepted ? 'hop' : 'shk'); }
    const btnEl = v.grid ? v.grid.querySelector('.dbtn[data-kind="' + kind + '"]') : null;
    if (btnEl) { btnEl.classList.remove('flash-ok', 'flash-no'); void btnEl.offsetWidth; btnEl.classList.add(res.accepted ? 'flash-ok' : 'flash-no'); }
  }
  /** the strip at the top of the card: accepted / refused / waiting + why, optionally with a war button after a refused ultimatum */
  function showResult(res, a, plain) {
    const v = dm.view; if (!v || !v.res) return;
    const r = v.res;
    kit.clear(r);
    let cls = 'no', icon = 'close', text = res.reason || 'Не получилось';
    if (res.pending) { cls = 'wait'; icon = 'log'; text = 'Предложение отправлено: ждёт ответа'; }
    else if (res.accepted) { cls = 'ok'; icon = 'check'; text = (res.effects && res.effects.length ? res.effects.join('. ') : 'Принято'); }
    else if (plain) { cls = 'no'; icon = 'close'; }
    else if (!res.ok) { cls = 'no'; icon = 'close'; text = cap1(res.reason || 'Нельзя'); }
    else { cls = 'no'; icon = 'close'; text = cap1(String(res.reason || 'Отказ').replace(/^Отказ:\s*/, '')); }
    r.className = 'dip-res ' + cls;
    r.appendChild(kit.ico(icon, 24));
    const t = kit.el('div', 'dr-t'); t.appendChild(kit.el('b', '', res.accepted ? 'Принято' : res.pending ? 'Отправлено' : plain ? 'Недоступно' : 'Отказ')); t.appendChild(kit.el('span', '', text));
    r.appendChild(t);
    if (!res.accepted && !res.pending && !plain && res.kind === 'demand' && safe(() => Diplomacy.hasUltimatum(dm.kid, dm.other), false)) {
      const war = kit.btn('cbtn danger dr-war', 'Объявить войну', () => declareUltimatumWar());
      war.dataset.act = 'dip-war';
      war.appendChild(kit.ico('war', 16)); war.appendChild(kit.el('span', '', 'Объявить войну'));
      r.appendChild(war);
    }
    clearTimeout(v.resT);
    if (!r.querySelector('.dr-war')) v.resT = setTimeout(() => { if (dm.view === v && v.res === r) r.classList.add('hide'); }, 7000);
    if (v.body) v.body.scrollTop = 0;
    // a nudge for the eye: restart the slide-in
    r.style.animation = 'none'; void r.offsetWidth; r.style.animation = '';
    if (res.accepted) kit.hintOnce('dipdone', 'Договор действует: проверьте значки состояния под отношениями');
  }
  function declareUltimatumWar() {
    const kid = dm.kid, other = dm.other;
    const w = safe(() => Diplomacy.declareWar(kid, other, 'ultimatum'), null);
    if (!w) { kit.toast(cap1(safe(() => War.lastError, '') || 'Не удалось объявить войну'), 'bad'); return; }
    kit.toast('Война началась: повод — отвергнутый ультиматум', 'good');
    dm.sig = ''; refreshCard();
    const r = dm.view && dm.view.res; if (r) r.classList.add('hide');
  }
  function refreshCard() {
    const v = dm.view; if (!v || dm.mode !== 'card') return;
    runUps(v.ups);
  }

  // ------------------------------------------------------------------ inline panels (terms): pact / gift / demand / marriage / call
  function setFoot(buttons) {
    const v = dm.view; if (!v || !v.foot) return;
    kit.clear(v.foot);
    kit.setCls(v.foot, 'hide', !buttons.length);
    buttons.forEach((b) => v.foot.appendChild(b));
  }
  function panelHead(title, sub) {
    const h = kit.el('div', 'dip-ph');
    h.appendChild(kit.el('b', '', title));
    if (sub) h.appendChild(kit.el('small', '', sub));
    return h;
  }
  function actionOf(kind) { const c = dm.view && dm.view.card; return c ? c.actions.find((a) => a.kind === kind) : null; }
  function openSubPanel(kind, preset) {
    const v = dm.view; if (!v) return;
    const a = actionOf(kind) || safe(() => Diplomacy.actionsFor(dm.kid, dm.other).find((x) => x.kind === kind), null);
    if (!a) return;
    dm.sub = { kind, preset: preset || null };
    dm.armed = '';
    sheet().classList.add('dsub');
    if (v.res) { clearTimeout(v.resT); v.res.classList.add('hide'); }
    kit.clear(v.grid);
    const built = kind === 'pact' ? panelPact(a) : kind === 'gift' ? panelGift(a) : kind === 'demand' ? panelDemand(a) : kind === 'marriage' ? panelMarriage(a) : panelCall(a);
    v.grid.appendChild(built.node);
    const bk = kit.btn('cbtn', 'Назад', () => back2()); bk.dataset.act = 'dip-sub-back'; bk.appendChild(kit.el('span', '', 'Назад'));
    const go = kit.btn('cbtn primary', built.goLabel, () => built.go()); go.dataset.act = 'dip-sub-go'; go.appendChild(kit.ico(a.icon, 16)); go.appendChild(kit.el('span', '', built.goLabel));
    built.setGo = (label, enabled, cls) => { go.disabled = !enabled; go.className = 'cbtn ' + (cls || 'primary'); go.lastChild.textContent = label; };
    if (built.init) built.init();
    setFoot([bk, go]);
    if (v.body) v.body.scrollTop = 0;
    dm.sig = 'sub';
  }
  function closeSub() { dm.sub = null; dm.sig = ''; sheet().classList.remove('dsub'); setFoot([]); refreshCard(); }
  function back2() { dm.sub = null; dm.sig = ''; dm.region = 0; sheet().classList.remove('dsub'); rcSync(); const v = dm.view; if (v) setFoot([]); refreshCard(); }
  function choiceRow(label, hint, tone, on, onTap, extra) {
    const b = kit.btn('dopt' + (on ? ' on' : ''), label, onTap);
    const box = kit.el('span', 'dobox'); b.appendChild(box);
    const t = kit.el('span', 'dt'); t.appendChild(kit.el('b', '', label));
    if (extra) t.appendChild(kit.el('small', '', extra));
    b.appendChild(t);
    b.appendChild(kit.el('i', 'dh ' + toneOf(tone), hint));
    return b;
  }
  // -- pact: the length is part of the deal
  function panelPact(a) {
    const node = kit.el('div', 'dip-panel');
    node.appendChild(panelHead('Пакт о ненападении', 'Пока он действует, воевать нельзя ни вам, ни им. Нарушение: отношения −25, дурная слава +6.'));
    const opts = a.options || [];
    let pick = (dm.sub && dm.sub.preset) || 0;
    if (!pick) { const good = opts.filter((o) => o.ok && o.accept); pick = good.length ? good[good.length - 1].years : (opts[1] ? opts[1].years : 20); if (opts.find((o) => o.years === 20 && o.ok && o.accept)) pick = 20; }
    const rows = kit.el('div', 'dopts'); node.appendChild(rows);
    const draw = () => {
      kit.clear(rows);
      opts.forEach((o) => rows.appendChild(choiceRow(o.label, o.ok ? o.hint : o.reason, o.ok ? o.tone : 'bad', pick === o.years, () => { pick = o.years; dm.sub.preset = pick; draw(); sync(); }, o.ok ? '' : '')));
    };
    const api = { node, goLabel: 'Предложить пакт', go() { run('pact', { years: pick }, a); closeSub(); }, init() { draw(); sync(); } };
    function sync() { const o = opts.find((x) => x.years === pick); api.setGo(o && o.ok && !o.accept ? 'Всё равно предложить' : 'Предложить пакт', !!(o && o.ok), o && o.ok && !o.accept ? '' : 'primary'); }
    return api;
  }
  // -- gift: goods + amounts from the capital stock
  function panelGift(a) {
    const node = kit.el('div', 'dip-panel');
    node.appendChild(panelHead('Подарок', 'Товары уйдут из вашей столицы в столицу получателя. Чем ценнее дар, тем теплее отношения (не больше +30 всего).'));
    const opts = (a.options || []).filter((o) => o.have > 0);
    const amt = {}; GOODS.forEach((g) => { amt[g] = 0; });
    if (dm.sub && dm.sub.preset) Object.assign(amt, dm.sub.preset);
    const list = kit.el('div', 'dgoods'); node.appendChild(list);
    const sum = kit.el('div', 'dgsum'); node.appendChild(sum);
    const refs = {};
    opts.forEach((o) => {
      const row = kit.el('div', 'dgood');
      row.appendChild(kit.ico(o.good, 24));
      const t = kit.el('span', 'dt'); t.appendChild(kit.el('b', '', GOOD_LABEL[o.good])); t.appendChild(kit.el('small', '', 'в столице ' + o.have + (o.room < o.have ? ' · примут ' + o.room : '')));
      row.appendChild(t);
      const st = kit.el('span', 'dstep');
      const minus = kit.btn('dstb', 'Меньше ' + GOOD_LABEL[o.good], () => set(o, amt[o.good] - STEP[o.good])); minus.appendChild(kit.ico('minus', 16)); minus.dataset.act = 'gift-minus'; minus.dataset.good = o.good;
      const val = kit.el('b', 'dsv', '0');
      const plus = kit.btn('dstb', 'Больше ' + GOOD_LABEL[o.good], () => set(o, amt[o.good] + STEP[o.good])); plus.appendChild(kit.ico('plus', 16)); plus.dataset.act = 'gift-plus'; plus.dataset.good = o.good;
      const all = kit.btn('dstb all', 'Всё', () => set(o, amt[o.good] >= o.max ? 0 : o.max)); all.textContent = 'всё'; all.dataset.act = 'gift-all'; all.dataset.good = o.good;
      st.appendChild(minus); st.appendChild(val); st.appendChild(plus); st.appendChild(all);
      row.appendChild(st);
      list.appendChild(row);
      refs[o.good] = { val, minus, plus, o };
    });
    function set(o, n) { amt[o.good] = Util.clamp(Math.round(n), 0, o.max); if (dm.sub) dm.sub.preset = Object.assign({}, amt); sync(); }
    const api = { node, goLabel: 'Отправить дар', go() { const goods = {}; GOODS.forEach((g) => { if (amt[g] > 0) goods[g] = amt[g]; }); run('gift', { goods }, a); closeSub(); }, init() { sync(); } };
    function sync() {
      let value = 0, any = false;
      opts.forEach((o) => { const r = refs[o.good]; r.val.textContent = amt[o.good]; r.minus.disabled = amt[o.good] <= 0; r.plus.disabled = amt[o.good] >= o.max; value += amt[o.good] * o.value; if (amt[o.good] > 0) any = true; });
      const gain = value > 0 ? Math.min(14, Math.max(1, 0.9 * Math.sqrt(value))) : 0;
      kit.setText(sum, any ? 'Ценность дара: ' + Math.round(value) + ' · отношения примерно +' + (Math.round(gain * 10) / 10) : 'Выберите, что подарить');
      api.setGo('Отправить дар', any, 'primary');
    }
    return api;
  }
  // -- demand: tribute / region / vassalage
  function panelDemand(a) {
    const node = kit.el('div', 'dip-panel');
    node.appendChild(panelHead('Требование', 'Если откажут, у вас будет законный повод для войны — «Объявить войну» появится сразу.'));
    const variants = a.options || [];
    let what = (dm.sub && dm.sub.preset && dm.sub.preset.what) || '', pickKey = (dm.sub && dm.sub.preset && dm.sub.preset.key) || '';
    const seg = kit.el('div', 'cseg dip-seg'); node.appendChild(seg);
    const rows = kit.el('div', 'dopts'); node.appendChild(rows);
    const note = kit.el('div', 'tc-note dip-note hide'); node.appendChild(note);
    const kinds = [['tribute', 'Дань', 'coin'], ['region', 'Регион', 'region'], ['vassal', 'Вассалитет', 'crown']];
    const keyOf = (o) => o.what + ':' + (o.rid || o.size || 0);
    const firstOk = () => { for (const kd of kinds) { const o = variants.find((x) => x.what === kd[0] && x.ok); if (o) return kd[0]; } return 'tribute'; };
    if (!what) what = firstOk();
    const segBtns = {};
    kinds.forEach(([id, label, icon]) => {
      const b = kit.btn('', label, () => { what = id; pickKey = ''; draw(); sync(); }); b.dataset.page = id; b.dataset.act = 'dip-what';
      b.appendChild(kit.ico(icon, 16)); b.appendChild(kit.el('span', '', label)); seg.appendChild(b); segBtns[id] = b;
    });
    function current() { return variants.find((o) => keyOf(o) === pickKey) || null; }
    function draw() {
      kinds.forEach(([id]) => segBtns[id].classList.toggle('on', id === what));
      kit.clear(rows);
      const list = variants.filter((o) => o.what === what);
      if (!pickKey || !list.find((o) => keyOf(o) === pickKey)) { const f = list.find((o) => o.ok && o.accept) || list.find((o) => o.ok) || list[0]; pickKey = f ? keyOf(f) : ''; }
      if (!list.length) rows.appendChild(kit.el('div', 'muted', what === 'region' ? 'Нет регионов рядом с вашими землями' : 'Нет вариантов'));
      list.forEach((o) => {
        let extra = '';
        if (o.what === 'tribute') extra = Object.keys(o.goods || {}).length ? GOODS.filter((g) => o.goods[g] > 0).map((g) => GOOD_LABEL[g].toLowerCase() + ' ×' + o.goods[g]).join(', ') : 'нечего взять';
        else if (o.what === 'region') extra = (o.cities ? o.cities + ' ' + Util.plural(o.cities, 'город', 'города', 'городов') : 'без городов') + (o.capital ? ' · столица' : '');
        else extra = 'Страна станет вашим вассалом';
        rows.appendChild(choiceRow(o.label, o.ok ? o.hint : o.reason, o.ok ? o.tone : 'bad', pickKey === keyOf(o), () => { pickKey = keyOf(o); if (o.what === 'region') pulseRegion(o.rid); draw(); sync(); }, extra));
      });
      const o = current();
      if (o && o.what === 'region' && o.ok) pulseRegion(o.rid); else pulseRegion(0);
    }
    const api = {
      node, goLabel: 'Предъявить требование',
      go() {
        const o = current(); if (!o) return;
        const terms = o.what === 'tribute' ? { what: 'tribute', size: o.size } : o.what === 'region' ? { what: 'region', rid: o.rid } : { what: 'vassal' };
        const res = run('demand', terms, a);
        dm.region = 0; rcSync(); closeSub();
      },
      init() { draw(); sync(); },
    };
    function sync() {
      const o = current();
      if (o && o.ok && o.note) { note.className = 'tc-note dip-note ' + (o.accept ? 'good' : 'warn'); note.textContent = o.note + (o.accept ? ': уступят' : ': откажут — это ваш повод для войны'); }
      else if (o && !o.ok) { note.className = 'tc-note dip-note bad'; note.textContent = cap1(o.reason); }
      else note.className = 'tc-note dip-note hide';
      api.setGo(o && o.ok && !o.accept ? 'Рискнуть: предъявить' : 'Предъявить требование', !!(o && o.ok), o && o.ok && !o.accept ? 'danger' : 'primary');
    }
    return api;
  }
  // -- marriage: the two heirs
  function panelMarriage(a) {
    const node = kit.el('div', 'dip-panel');
    node.appendChild(panelHead('Династический брак', 'Дети правителей женятся — дома связаны: отношения +14, союз получить легче, угасшая династия оставит родне право на престол.'));
    const d = a.data || {};
    const box = kit.el('div', 'dmar');
    const person = (name, sex, age, kid) => {
      const p = kit.el('div', 'dpers'); const k = K(kid);
      if (k) p.appendChild(kit.flagEl(k.flag, 24));
      const t = kit.el('span', 'dt'); t.appendChild(kit.el('b', '', name)); t.appendChild(kit.el('small', '', (sex === Const.SEX.F ? 'дочь правителя' : 'сын правителя') + ' · ' + age + ' ' + Util.plural(age, 'год', 'года', 'лет')));
      p.appendChild(t); return p;
    };
    box.appendChild(person(d.na || '?', d.sa, d.aa | 0, dm.kid));
    const hrt = kit.el('span', 'dmh'); hrt.appendChild(kit.ico('marriage', 24)); box.appendChild(hrt);
    box.appendChild(person(d.nb || '?', d.sb, d.ab | 0, dm.other));
    node.appendChild(box);
    if (a.hint) { const n = kit.el('div', 'tc-note dip-note ' + (a.tone === 'bad' ? 'bad' : a.tone === 'warn' ? 'warn' : 'good')); n.textContent = a.hint + (a.margin !== undefined ? ' (' + Math.round(a.score) + ' из ' + Math.round(a.need) + ')' : ''); node.appendChild(n); }
    const api = { node, goLabel: 'Сыграть свадьбу', go() { run('marriage', null, a); closeSub(); }, init() { api.setGo('Сыграть свадьбу', true, a.tone === 'bad' ? '' : 'primary'); } };
    return api;
  }
  // -- call to arms: which war?
  function panelCall(a) {
    const node = kit.el('div', 'dip-panel');
    node.appendChild(panelHead('Позвать союзника в войну', 'Выберите войну: союзник сам решит, вступать ли.'));
    const opts = a.options || [];
    let pick = (dm.sub && dm.sub.preset) || (opts.find((o) => o.ok) || opts[0] || {}).warId || 0;
    const rows = kit.el('div', 'dopts'); node.appendChild(rows);
    const draw = () => { kit.clear(rows); opts.forEach((o) => rows.appendChild(choiceRow(o.label, o.ok ? o.hint : o.reason, o.ok ? o.tone : 'bad', pick === o.warId, () => { pick = o.warId; if (dm.sub) dm.sub.preset = pick; draw(); sync(); }))); };
    const api = { node, goLabel: 'Позвать', go() { run('call', { warId: pick }, a); closeSub(); }, init() { draw(); sync(); } };
    function sync() { const o = opts.find((x) => x.warId === pick); api.setGo('Позвать', !!(o && o.ok), 'primary'); }
    return api;
  }

  // ------------------------------------------------------------------ inbox (proposals to the commanded kingdom)
  function inboxList() { const kid = commandedKid(); return kid ? safe(() => Diplomacy.inbox(kid), []) : []; }
  function ensureFab() {
    if (dm.fab || !kit || !kit.refs.fabs) return;
    const b = kit.btn('fab dipfab hide', 'Предложения', () => openInbox());
    b.dataset.act = 'dip-fab';
    const fi = kit.el('span', 'fi'); fi.appendChild(kit.ico('mail', 24)); b.appendChild(fi);
    b.appendChild(kit.el('span', '', 'Почта'));
    const n = kit.el('i', 'dn', '0'); b.appendChild(n);
    kit.refs.fabs.appendChild(b);
    dm.fab = { b, n };
  }
  function updateMail() {
    const n = inboxList().length;
    if (dm.mailBtn && dm.mailBtn.b.isConnected) { kit.setCls(dm.mailBtn.b, 'hide', n === 0); kit.setText(dm.mailBtn.n, n); }
  }
  function refreshFab() {
    ensureFab();
    if (!dm.fab) return;
    const n = inboxList().length;
    if (n !== dm.fabN) {
      const grew = n > dm.fabN && dm.fabN >= 0;
      dm.fabN = n;
      kit.setCls(dm.fab.b, 'hide', n === 0);
      kit.setText(dm.fab.n, n);
      if (grew) { dm.fab.b.classList.remove('ping'); void dm.fab.b.offsetWidth; dm.fab.b.classList.add('ping'); }
    }
    updateMail();
    if (dm.modal) renderInbox();
  }
  function closeInboxModal() { if (dm.modal) { const m = dm.modal; dm.modal = null; m.m.close(); } }
  function openInbox() {
    if (!ready) return;
    if (dm.modal) { renderInbox(); return; }
    const list = inboxList();
    if (!list.length) { kit.toast('Новых предложений нет'); return; }
    const m = kit.openModal({ title: 'Предложения', onClose: () => { dm.modal = null; refreshFab(); } });
    dm.modal = { m, rows: new Map() };
    m.body.classList.add('dip-inbox');
    renderInbox();
  }
  function mailCard(e) {
    const from = K(e.from);
    const card = kit.el('div', 'dmail' + (e.danger ? ' danger' : '')); card.dataset.id = e.id; card.dataset.kind = e.kind;
    const head = kit.el('div', 'dm-head');
    if (from) head.appendChild(kit.flagEl(from.flag, 32));
    const t = kit.el('div', 'dm-t'); t.appendChild(kit.el('b', '', from ? from.name : '?')); t.appendChild(kit.el('small', '', e.title));
    head.appendChild(t);
    const left = kit.el('span', 'dm-left', yrs(e.left)); head.appendChild(left);
    card.appendChild(head);
    const row = kit.el('div', 'dm-text'); row.appendChild(kit.ico(e.icon, 24)); row.appendChild(kit.el('span', '', cap1(e.text) + '.')); card.appendChild(row);
    const info = kit.el('div', 'dm-info'); card.appendChild(info);
    const r = safe(() => Diplomacy.relationsOf(e.to).find((q) => q.other === e.from), null);
    const bits = [];
    if (r) bits.push('отношения ' + (r.opinion > 0 ? '+' : '') + r.opinion);
    if (e.danger) bits.push(e.terms && e.terms.war && e.terms.war.length ? 'отказ — война' : 'отказ — повод для войны');
    info.textContent = bits.join(' · ');
    const acts = kit.el('div', 'dm-acts');
    const yes = kit.btn('cbtn primary', 'Принять', () => answer(e, true, card)); yes.dataset.act = 'dip-accept'; yes.appendChild(kit.ico('check', 16)); yes.appendChild(kit.el('span', '', 'Принять'));
    const no = kit.btn('cbtn' + (e.danger ? ' danger' : ''), 'Отклонить', () => answer(e, false, card)); no.dataset.act = 'dip-decline'; no.appendChild(kit.ico('close', 16)); no.appendChild(kit.el('span', '', 'Отклонить'));
    acts.appendChild(yes); acts.appendChild(no); card.appendChild(acts);
    card._left = left;
    return card;
  }
  function renderInbox() {
    const md = dm.modal; if (!md) return;
    const list = inboxList();
    const body = md.m.body;
    const seen = new Set();
    list.forEach((e) => {
      seen.add(e.id);
      let c = md.rows.get(e.id);
      if (!c) { c = mailCard(e); md.rows.set(e.id, c); body.appendChild(c); }
      kit.setText(c._left, yrs(e.left));
    });
    for (const [id, c] of md.rows) if (!seen.has(id) && !c.classList.contains('gone')) { c.classList.add('gone'); setTimeout(() => { if (c.parentNode) c.parentNode.removeChild(c); }, 400); md.rows.delete(id); }
    if (!list.length) { setTimeout(() => { if (dm.modal === md && !inboxList().length) closeInboxModal(); }, 450); }
  }
  function answer(e, accept, card) {
    const res = safe(() => Diplomacy.respond(e.id, accept), { ok: false, reason: 'Ошибка' });
    card.classList.add(accept && res.accepted ? 'yes' : 'no');
    const acts = card.querySelector('.dm-acts');
    if (acts) { kit.clear(acts); acts.appendChild(kit.el('div', 'dm-res ' + (accept && res.accepted ? 'ok' : 'no'), accept ? (res.accepted ? (res.effects && res.effects[0] ? res.effects[0] : 'Принято') : cap1(res.reason || 'Не удалось')) : 'Отклонено')); }
    kit.toast(accept ? (res.accepted ? (res.effects && res.effects[0] ? res.effects[0] : 'Принято') : cap1(res.reason || 'Не удалось')) : 'Предложение отклонено', accept && res.accepted ? 'good' : undefined);
    dm.sig = '';
    refreshCard();
    setTimeout(refreshFab, 450);
  }
  /** Bus: a proposal reached the commanded kingdom */
  function onProposal(e) {
    if (!ready || !e) return;
    const to = K(e.to);
    if (!to || !to.cmd) return;
    const v = safe(() => Diplomacy.inbox(e.to).find((q) => q.id === e.id), null), from = K(e.from);
    if (v && from) kit.toast('«' + from.name + '» ' + v.text, v.danger ? 'bad' : undefined);
    refreshFab();
  }
  function onResolved(e, ok, auto) {
    if (!ready || !e) return;
    refreshFab();
    if (auto && ok === false) { const to = K(e.to), from = K(e.from); if (to && to.cmd && from) kit.toast('Предложение «' + from.name + '» осталось без ответа', undefined); }
  }
  function onTreaty(kind, ka, kb, sent) {
    if (!ready || kind !== 'gift' || !ka || !kb || !kb.cmd) return;
    kit.toast('«' + ka.name + '» прислало дары: ' + GOODS.filter((g) => sent && sent[g] > 0).map((g) => GOOD_LABEL[g].toLowerCase() + ' ×' + sent[g]).join(', '), 'good');
  }

  // ------------------------------------------------------------------ map taps
  function kingdomAtTap(tx, ty) {
    const sp = Render.tileToScreen(tx, ty);
    const aid = safe(() => Render.armyAtScreen(sp.x, sp.y), 0);
    if (aid) { const a = S.armies.get(aid); if (a && K(a.kingdomId)) return a.kingdomId; }
    const t = safe(() => Powers.kingdomAt(tx, ty), null);
    return t && t.kid && K(t.kid) ? t.kid : 0;
  }
  function tap(tx, ty) {
    if (!ready || kit.modalOpen()) return;
    if (kit.inspectorOpen()) { kit.closeInspector(); if (dm.kid) return; }
    const kid = kingdomAtTap(tx, ty);
    if (!dm.kid) {
      if (kid) select(kid);
      else if (safe(() => Render.regionAt(tx, ty), 0)) kit.toast('Это ничья земля. Тапните по стране — она станет вашей стороной переговоров.');
      return;
    }
    if (kid && kid !== dm.kid) { if (dm.other !== kid) openPair(kid); return; }
    if (kid === dm.kid) { if (dm.other) closeCard(); else focusActor(); return; }
    if (safe(() => Render.regionAt(tx, ty), 0) && !dm.other) { kit.toast('Ничья земля: там нет государства, с которым можно договориться'); return; }
    back();
  }
  function paint(tx, ty, phase) {
    if (phase === 'start') { paint.moved = false; paint.x = tx; paint.y = ty; }
    else if (phase === 'move') paint.moved = true;
    else if (phase === 'end' && !paint.moved) tap(paint.x, paint.y);
  }

  // ------------------------------------------------------------------ live refresh
  function update() {
    if (!ready) return;
    dm.tick++;
    refreshFab();
    if (!dm.kid) return;
    const k = K(dm.kid);
    if (!k) { kit.toast('Выбранная страна пала', 'bad'); release(true); return; }
    if (!k.cmd) { try { Kingdoms.setCommanded(dm.kid, true); } catch (e) { /* ignore */ } }      // something (a load, the war tool) dropped the flag
    if (!dm.owns || kit.inspectorOpen()) return;
    if (dm.other && !K(dm.other)) { kit.toast('Эта страна пала', undefined); closeCard(); return; }
    const v = dm.view; if (!v) return;
    runUps(v.ups);
  }
  function reset() {
    closeInboxModal();
    clearTimeout(dm.armedT);
    clearRc();
    dm.kid = 0; dm.other = 0; dm.mode = 'hud'; dm.sub = null; dm.region = 0; dm.armed = ''; dm.view = null; dm.owns = false; dm.sig = ''; dm.stripSig = ''; dm.mapPrev = -1; dm.fabN = -1;
    document.body.classList.remove('dip', 'dip-card');
    const sh = kit && kit.refs && kit.refs.sheet; if (sh) { sh.classList.remove('dip', 'dh', 'dc', 'dsub'); }
    if (dm.fab) kit.setCls(dm.fab.b, 'hide', true);
  }
  function init(k) {
    kit = k;
    ready = true;
    Bus.on('diploProposal', (e) => { try { onProposal(e); } catch (er) { reportOnce('dip.prop', er); } });
    Bus.on('diploResolved', (e, ok, auto) => { try { onResolved(e, ok, auto); } catch (er) { reportOnce('dip.res', er); } });
    Bus.on('treatyMade', (kind, ka, kb, sent) => { try { onTreaty(kind, ka, kb, sent); } catch (er) { reportOnce('dip.trt', er); } });
    ensureFab();
  }

  return {
    init, select, release, openPair, closeCard, back, tap, paint, update, reset, openInbox, active, resume, yieldSheet,
    owns() { return dm.owns; },
    get kid() { return dm.kid; },
    get snapshot() {
      return {
        kid: dm.kid, other: dm.other, mode: dm.kid ? (dm.other ? 'card' : 'hud') : '', sub: dm.sub ? dm.sub.kind : '', owns: dm.owns, inbox: dm.kid ? inboxList().length : 0,
        armed: dm.armed, modal: !!dm.modal, causesOpen: dm.causesOpen,
        actions: dm.view && dm.view.card ? dm.view.card.actions.map((a) => ({ kind: a.kind, available: a.available, hint: a.hint, reason: a.reason, tone: a.tone, odds: a.odds })) : [],
        result: dm.view && dm.view.res && !dm.view.res.classList.contains('hide') ? dm.view.res.textContent : '',
      };
    },
  };
})();
