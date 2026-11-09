/* =====================================================================
 * 23_ui.js — UI: top bar, dock (tabs + tools + brush), event feed, toasts, inspector sheet, menu / log / world / help modals.
 * OWNER: UI+Main agent. API: docs/CONTRACT.md §4 UI. Russian strings. DOM is built once; per-frame work only touches
 * text nodes whose value changed (see setText / sheet updaters).
 *
 *  UI.init()                    build everything (needs the template skeleton: #top #feed #bottom #dock #sheet ...)
 *  UI.update(dtMs)              cheap, called every frame
 *  UI.toast(text, kind?)        kind: 'good' | 'bad' | undefined
 *  UI.state                     {tab, tool, brush, mode ('pan'|'paint'), mapMode}
 *  UI.handleTap(tx,ty) / UI.handlePaint(tx,ty,phase)    Input callbacks
 *  UI.openInspector(type,id)    type: unit | building | city | kingdom | region | tile (tile id = y*S.w+x)
 *  UI.onWorldReplaced()         Main calls it after Sim.newWorld / Save.load
 *
 *  STAGE 2 (CONTRACT 8.5) — command mode ("Командовать"):
 *  UI.commandKingdom(kid,{focus,page}) / UI.releaseCommand()   UI.cmdKid, UI.cmd (read-only snapshot for tests)
 *  UI.startGoalMode(targetKid, warId) / UI.openPeace(warId) / UI.selectArmy(id) / UI.setRegionHL(rid, ms)
 *  The command sheet replaces the dock (like the inspector): header, three pages (Война | Армии | Регионы), goal-picking bar, peace conference.
 *  Everything the map must show goes through ONE object, Render.cmd = {kid, regionId, armyId, goals, candidates, targetKid};
 *  every list is a keyed list (listSlot): rows are rebuilt only when their structure changes, numbers are updated in place, so a tap
 *  is never lost to a refresh. Sim state touched: Kingdoms.setCommanded (k.cmd), War.declare / addGoal / order / peaceOffer / forcePeace /
 *  respondOffer / setAutoPeace. A world replacement or a load clears every k.cmd flag (a save made while commanding must not freeze the AI).
 * ===================================================================== */

const UI = (() => {
  const RACE_KEYS = ['human', 'orc', 'elf'];
  const SPEEDS = [0, 1, 2, 4];
  const SPEED_ICON = ['pause', 'speed1', 'speed2', 'speed4'];
  const SPEED_LABEL = ['Пауза', 'Скорость ×1', 'Скорость ×2', 'Скорость ×4'];
  const KIND_COLOR = {
    info: '#8fa5d6', war: '#ff5b5b', peace: '#58e08a', birth: '#ff9fd0', death: '#9aa3b5',
    disaster: '#ff9a3a', city: '#ffd24a', kingdom: '#c78bff', rebel: '#ff4fa3', god: '#58c7ff',
  };
  const SHORT = { earthquake: 'Землетр.', bless: 'Благосл.', war_whisper: 'Шёпот', lightning: 'Молния', split: 'Раскол', command: 'Командир' };
  const GROUP_LABEL = { terrain: 'Рельеф', creatures: 'Существа', destroy: 'Разрушение', bless: 'Благословение', diplomacy: 'Дипломатия', info: 'Осмотр', command: 'Война' };
  const DEFAULT_HINT = {
    land: 'Выберите кисть, затем тапните по карте. Режим кисти — рисовать пальцем.',
    life: 'Выберите существо и тапните по карте, чтобы создать его.',
    powers: 'Выберите силу и тапните по карте. Без силы тап — осмотр.',
    kingdoms: 'Выберите королевство в списке или инструмент дипломатии.',
    info: 'Тап по существу, зданию, городу или земле — карточка.',
  };
  const MAP_MODES = [
    { mode: 0, icon: 'map_normal', label: 'Карта', name: 'Обычная карта' },
    { mode: 1, icon: 'map_borders', label: 'Границы', name: 'Границы королевств' },
    { mode: 2, icon: 'map_culture', label: 'Культуры', name: 'Культуры' },
  ];
  const RES_NAMES = ['', 'Дерево', 'Камень', 'Железо', 'Золото', 'Ягоды', 'Рыба'];
  const GOOD_NAMES = { food: 'Еда', wood: 'Дерево', stone: 'Камень', iron: 'Железо', gold: 'Золото' };
  const LOG_FILTERS = [
    { id: 'all', name: 'Все', kinds: null },
    { id: 'war', name: 'Войны', kinds: ['war', 'peace'] },
    { id: 'pol', name: 'Государства', kinds: ['kingdom', 'rebel', 'city'] },
    { id: 'dis', name: 'Бедствия', kinds: ['disaster', 'god'] },
    { id: 'life', name: 'Жизнь', kinds: ['birth', 'death', 'info'] },
  ];

  const state = { tab: 'powers', tool: null, brush: 3, mode: 'pan', mapMode: 0 };
  const tabTool = {};                    // last selected tool per tab
  const refs = {};
  let ready = false;
  let insp = null;                       // open inspector {type,id,view,stack}
  const modals = [];                     // modal stack
  const feed = { items: [], pending: [], lastId: 0 };
  let brushTimer = 0, toastLast = '', toastLastAt = 0;
  let accFast = 0, accSlow = 0, accStats = 0;
  let chipMap = new Map(), chipSig = '';
  let logPanel = null, statsPanel = null;
  const dockCache = { speed: -1, paused: null, year: -1, pop: [-1, -1, -1], kingdoms: -1, wars: -1 };
  let prefs = { seen: {}, brush: 3 };

  // ------------------------------------------------------------------ tiny helpers
  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function btn(cls, label, onClick) {
    const b = el('button', cls);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function setText(node, s) { s = String(s); if (node._t !== s) { node._t = s; node.textContent = s; } }
  function setCls(node, cls, on) { on = !!on; if (node['_c' + cls] !== on) { node['_c' + cls] = on; node.classList.toggle(cls, on); } }
  function setStyle(node, prop, v) { if (node['_s' + prop] !== v) { node['_s' + prop] = v; node.style[prop] = v; } }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function dpr() { return Math.min(3, window.devicePixelRatio || 1); }
  function defer(fn) { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(fn)); else setTimeout(fn, 16); }
  function loadPrefs() {
    try {
      const raw = localStorage.getItem('godsim.ui');
      if (raw) { const p = JSON.parse(raw); if (p && typeof p === 'object') prefs = Object.assign(prefs, p); }
    } catch (e) { /* storage blocked */ }
    if (!prefs.seen || typeof prefs.seen !== 'object') prefs.seen = {};
    state.brush = Util.clamp(prefs.brush | 0 || 3, 1, 8);
  }
  function savePrefs() { try { localStorage.setItem('godsim.ui', JSON.stringify(prefs)); } catch (e) { /* ignore */ } }
  function seenOnce(key) { if (prefs.seen[key]) return false; prefs.seen[key] = 1; savePrefs(); return true; }

  /** crisp pixel-art icon as a <canvas> (size in CSS px, rounded to a whole multiple of the 16 px grid per device pixel) */
  function ico(key, css) {
    const d = dpr();
    const k = Math.max(1, Math.round(css * d / 16));
    const px = 16 * k;
    const c = document.createElement('canvas');
    c.width = c.height = px;
    c.className = 'ic';
    const s = (px / d) + 'px';
    c.style.width = s; c.style.height = s;
    try {
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(Sprites.icon(key, px), 0, 0);
    } catch (e) { /* sprite failure must never break the UI */ }
    return c;
  }
  function flagSig(f) { return f ? f.pattern + '.' + f.symbol + '.' + f.c1 + '.' + f.c2 + '.' + f.c3 : ''; }
  /** kingdom flag as a <canvas>; cssW should be ~16*k/dpr (24 → 24x15) */
  function flagEl(flag, cssW) {
    const d = dpr();
    const k = Math.max(1, Math.round(cssW * d / 16));
    const w = 16 * k, h = 10 * k;
    const c = document.createElement('canvas');
    c.width = w; c.height = h; c.className = 'ic flag';
    c.style.width = (w / d) + 'px'; c.style.height = (h / d) + 'px';
    c.style.borderRadius = '2px';
    c._k = k;
    drawFlag(c, flag);
    return c;
  }
  function drawFlag(c, flag) {
    const sig = flagSig(flag);
    if (c._sig === sig) return;
    c._sig = sig;
    try {
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(Sprites.flag(flag, c.width, c.height), 0, 0);
    } catch (e) { /* ignore */ }
  }
  function spriteEl(src, cssSize) {            // any 16x16-based canvas (building / tile) scaled by whole texels
    const d = dpr();
    const k = Math.max(1, Math.round(cssSize * d / 16));
    const px = 16 * k;
    const c = document.createElement('canvas');
    c.width = c.height = px; c.className = 'ic';
    c.style.width = c.style.height = (px / d) + 'px';
    try { const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(src, 0, 0, src.width, src.height, 0, 0, px, px); } catch (e) { /* ignore */ }
    return c;
  }
  function tileEl(t, x, y, cssSize) {
    const d = dpr();
    const k = Math.max(1, Math.round(cssSize * d / 16));
    const px = 16 * k;
    const c = document.createElement('canvas');
    c.width = c.height = px; c.className = 'ic';
    c.style.width = c.style.height = (px / d) + 'px';
    try { const g = c.getContext('2d'); g.imageSmoothingEnabled = false; Sprites.drawTile(g, t, 0, 0, px, Util.hash2(x, y, 7) & 7); } catch (e) { /* ignore */ }
    return c;
  }
  function pct(f) { return Math.round(Util.clamp(f, 0, 1) * 1000) / 10 + '%'; }
  function hpColor(f) { return f > 0.55 ? '#58e08a' : f > 0.28 ? '#ffc83d' : '#ff5b5b'; }
  function opinionColor(o) { return o <= -60 ? '#ff4b4b' : o < -15 ? '#ff9a3a' : o <= 15 ? '#c7cfe3' : o < 60 ? '#8be28f' : '#35d672'; }
  function ageText(e) { const y = Math.max(0, Math.floor(Util.age(e))); return y + ' ' + Util.plural(y, 'год', 'года', 'лет'); }
  function yearText(y) { return 'Год ' + y; }
  function num(n) { return String(Math.round(n)); }
  function rname(r) { return Races.list[r] ? Races.list[r].name : '?'; }

  // ------------------------------------------------------------------ toasts
  function toast(text, kind) {
    if (!ready || !text) return;
    const now = performance.now();
    if (text === toastLast && now - toastLastAt < 1400) return;
    toastLast = text; toastLastAt = now;
    const box = refs.toasts;
    while (box.children.length >= 3) box.removeChild(box.firstChild);
    const t = el('div', 'toast' + (kind ? ' ' + kind : ''), text);
    box.appendChild(t);
    setTimeout(() => t.classList.add('out'), 2600);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 3050);
  }
  function hintOnce(key, text) {
    if (prefs.seen[key] || !ready) return;
    if (refs.toasts.children.length) return;           // never stack hints on top of other toasts: show it next time
    seenOnce(key); toast(text);
  }

  // ------------------------------------------------------------------ top bar
  function buildTop() {
    const cn = refs.counters;
    clear(cn);
    refs.pop = [];
    for (let r = 0; r < 3; r++) {
      const c = el('span', 'cnt pop-' + r);
      c.appendChild(ico(RACE_KEYS[r], 16));
      const b = el('b', '', '0'); c.appendChild(b); refs.pop.push(b);
      cn.appendChild(c);
    }
    const k = el('span', 'cnt k sep'); k.appendChild(ico('crown', 16)); refs.kcnt = el('b', '', '0'); k.appendChild(refs.kcnt); cn.appendChild(k);
    refs.warBox = el('span', 'cnt war sep hide'); refs.warBox.appendChild(ico('sword', 16)); refs.wcnt = el('b', '', '0'); refs.warBox.appendChild(refs.wcnt); cn.appendChild(refs.warBox);
    cn.addEventListener('click', () => openWorld());

    const sp = refs.speeds;
    clear(sp);
    refs.speedBtns = [];
    SPEEDS.forEach((s, i) => {
      const b = btn('sp' + (s === 0 ? ' pause' : ''), SPEED_LABEL[i], () => { Main.setSpeed(s); });
      b.appendChild(ico(SPEED_ICON[i], 24));
      sp.appendChild(b); refs.speedBtns.push(b);
    });
    refs.menuBtn.appendChild(ico('menu', 24));
    refs.menuBtn.addEventListener('click', () => openMenu());
  }
  function updateTop() {
    const st = S.stats;
    const y = Util.year();
    if (y !== dockCache.year) { dockCache.year = y; setText(refs.yearVal, y); }
    for (let r = 0; r < 3; r++) {
      const v = (st.pop && st.pop[r]) | 0;
      if (v !== dockCache.pop[r]) { dockCache.pop[r] = v; setText(refs.pop[r], v); }
    }
    if (st.kingdoms !== dockCache.kingdoms) { dockCache.kingdoms = st.kingdoms; setText(refs.kcnt, st.kingdoms | 0); }
    if (st.wars !== dockCache.wars) { dockCache.wars = st.wars; setText(refs.wcnt, st.wars | 0); refs.warBox.classList.toggle('hide', !(st.wars > 0)); }
    const sp = Main.getSpeed();
    if (sp !== dockCache.speed) {
      dockCache.speed = sp;
      SPEEDS.forEach((s, i) => { refs.speedBtns[i].classList.toggle('on', s === sp); refs.speedBtns[i].setAttribute('aria-pressed', s === sp ? 'true' : 'false'); });
      document.body.classList.toggle('is-paused', sp === 0);
    }
  }

  // ------------------------------------------------------------------ dock: tabs, tools, brush
  function buildTabs() {
    const box = refs.tabs;
    clear(box);
    refs.tabBtns = {};
    Tabs.forEach((t) => {
      const b = btn('tab', t.name, () => selectTab(t.id));
      b.setAttribute('role', 'tab');
      b.dataset.tab = t.id;
      b.appendChild(ico(t.icon, 24));
      b.appendChild(el('span', '', t.name));
      box.appendChild(b);
      refs.tabBtns[t.id] = b;
    });
  }
  function toolBtn(def, label) {
    const b = btn('tool', def.name, null);
    b.dataset.tool = def.id;
    b.appendChild(ico(def.icon, 32));
    b.appendChild(el('span', '', label || SHORT[def.id] || def.name));
    return b;
  }
  function renderTools() {
    const box = refs.tools;
    clear(box);
    refs.toolBtns = {};
    const tab = state.tab;
    const defs = ToolDefs.filter((t) => t.tab === tab);
    const groups = [];
    defs.forEach((d) => {
      let g = groups.length ? groups[groups.length - 1] : null;
      if (!g || g.id !== d.group) { g = { id: d.group, defs: [] }; groups.push(g); }
      g.defs.push(d);
    });
    groups.forEach((g) => {
      const gb = el('div', 'grp');
      if (groups.length > 1) { const gl = el('div', 'grp-lbl'); gl.appendChild(el('span', '', GROUP_LABEL[g.id] || g.id)); gb.appendChild(gl); }
      g.defs.forEach((d) => {
        const b = toolBtn(d);
        b.addEventListener('click', () => selectTool(d.id));
        gb.appendChild(b);
        refs.toolBtns[d.id] = b;
      });
      box.appendChild(gb);
    });
    if (tab === 'info') {
      const gb = el('div', 'grp');
      const acts = [
        { icon: 'log', name: 'Журнал', fn: openLog },
        { icon: 'map_normal', name: 'Мир', fn: openWorld },
        { icon: 'help', name: 'Помощь', fn: openHelp },
      ];
      acts.forEach((a) => {
        const b = btn('tool act', a.name, () => a.fn());
        b.appendChild(ico(a.icon, 32));
        b.appendChild(el('span', '', a.name));
        gb.appendChild(b);
      });
      box.appendChild(gb);
    }
    box.scrollLeft = 0;
    syncToolSel();
    defer(updateToolsHint);
  }
  /** chevrons at the edges of the tool row show that it scrolls sideways */
  function updateToolsHint() {
    const t = refs.tools;
    if (!t || !refs.moreR) return;
    const maxL = t.scrollWidth - t.clientWidth;
    refs.moreR.classList.toggle('on', maxL > 6 && t.scrollLeft < maxL - 6);
    refs.moreL.classList.toggle('on', t.scrollLeft > 6);
  }
  /** one-time nudge: the row slides left and back so people notice that it scrolls (skipped when something else is on screen) */
  function peekTools() {
    const t = refs.tools;
    if (!t || insp || cm.kid || modals.length || document.hidden) return false;
    const maxL = t.scrollWidth - t.clientWidth;
    if (maxL < 20 || t.scrollLeft > 2 || Input.gesturing) return false;
    const dist = Math.min(64, maxL);
    let t0 = 0;
    const step = (ts) => {
      if (!t0) t0 = ts;
      const p = Math.min(1, (ts - t0) / 1000);
      t.scrollLeft = dist * Math.sin(p * Math.PI);
      if (p < 1) requestAnimationFrame(step); else t.scrollLeft = 0;
    };
    requestAnimationFrame(step);
    return true;
  }
  function renderKBar() {
    const kb = refs.kbar;
    chipMap = new Map(); chipSig = '';
    clear(kb);
    kb.style.display = state.tab === 'kingdoms' ? '' : 'none';
    if (state.tab === 'kingdoms') updateChips(true);
  }
  function syncToolSel() {
    if (!refs.toolBtns) return;
    for (const id in refs.toolBtns) refs.toolBtns[id].classList.toggle('on', id === state.tool);
    for (const id in refs.tabBtns) { refs.tabBtns[id].classList.toggle('on', id === state.tab); refs.tabBtns[id].setAttribute('aria-selected', id === state.tab ? 'true' : 'false'); }
    const def = state.tool ? ToolDefs.byId[state.tool] : null;
    clear(refs.hint);
    if (def) {
      const same = def.hint.toLowerCase().indexOf(def.name.toLowerCase().slice(0, 4)) === 0;
      if (same) refs.hint.appendChild(el('b', '', def.hint));
      else { refs.hint.appendChild(el('b', '', def.name)); refs.hint.appendChild(document.createTextNode(' — ' + def.hint)); }
    } else refs.hint.textContent = DEFAULT_HINT[state.tab] || '';
    const showBrush = !!(def && def.brush);
    refs.brushbox.classList.toggle('hide', !showBrush);
  }
  function selectTab(id) {
    if (state.tab === id && ready && refs.toolBtns) return;
    state.tab = id;
    const remembered = tabTool[id];
    state.tool = remembered && ToolDefs.byId[remembered] && ToolDefs.byId[remembered].tab === id ? remembered : (id === 'info' ? 'inspect' : id === 'kingdoms' ? 'command' : null);
    renderTools();
    renderKBar();
    layoutSoon();
    if (id === 'kingdoms' && state.tool === 'command') hintOnce('cmdtool', 'Тапните по королевству на карте или в списке — и командуйте им: войны, армии, мир');
  }
  function selectTool(id) {
    const def = ToolDefs.byId[id];
    if (!def) return;
    state.tool = id;
    tabTool[def.tab] = id;
    syncToolSel();
    Render.brush = null;
    if (id === 'command' && state.mode === 'paint') setMode('pan');
    if (def.brush) flashBrush(true);
    if (def.drag && def.brush && state.mode === 'pan') {
      if (seenOnce('brushmode')) {
        toast('Чтобы рисовать пальцем, включите «Режим кисти» — кнопка справа внизу');
        refs.paintFab.classList.add('nudge');
        setTimeout(() => refs.paintFab.classList.remove('nudge'), 3500);
      }
    }
  }
  function setBrush(n) {
    n = Util.clamp(Math.round(n), 1, 8);
    state.brush = n;
    prefs.brush = n; savePrefs();
    syncBrushUI();
    flashBrush(false);
  }
  function syncBrushUI() {
    refs.range.value = state.brush;
    refs.range.style.setProperty('--p', ((state.brush - 1) / 7 * 100) + '%');
    setText(refs.bval, state.brush);
    refs.minus.disabled = state.brush <= 1;
    refs.plus.disabled = state.brush >= 8;
  }
  function buildBrush() {
    const bb = refs.brushbox;
    clear(bb);
    refs.minus = btn('step', 'Меньше', () => setBrush(state.brush - 1));
    refs.minus.appendChild(ico('minus', 16));
    refs.plus = btn('step', 'Больше', () => setBrush(state.brush + 1));
    refs.plus.appendChild(ico('plus', 16));
    const r = el('input', 'slider');
    r.type = 'range'; r.min = 1; r.max = 8; r.step = 1; r.value = state.brush;
    r.setAttribute('aria-label', 'Размер кисти');
    r.addEventListener('input', () => setBrush(+r.value));
    refs.range = r;
    const v = el('div', 'bval'); v.appendChild(el('i')); refs.bval = el('span', '', String(state.brush)); v.appendChild(refs.bval);
    bb.appendChild(refs.minus); bb.appendChild(r); bb.appendChild(refs.plus); bb.appendChild(v);
    syncBrushUI();
  }
  function visibleCenter() {
    const bi = bandInfo();
    return { x: (bi.left + bi.right) / 2, y: (bi.top + bi.bot) / 2 };
  }
  function flashBrush(short) {
    const def = state.tool ? ToolDefs.byId[state.tool] : null;
    if (!def || !def.brush) return;
    const c = visibleCenter();
    const t = Render.screenToTile(c.x, c.y);
    Render.brush = { x: t.x, y: t.y, r: state.brush };
    clearTimeout(brushTimer);
    brushTimer = setTimeout(() => { if (!Input.painting) Render.brush = null; }, short ? 900 : 1300);
  }

  // ------------------------------------------------------------------ floating buttons
  function buildFabs() {
    const box = refs.fabs;
    clear(box);
    const zoom = el('div', 'zoom hit');
    const zi = btn('', 'Приблизить', () => zoomBy(1.45)); zi.appendChild(ico('plus', 24));
    const zo = btn('', 'Отдалить', () => zoomBy(1 / 1.45)); zo.appendChild(ico('minus', 24));
    zoom.appendChild(zi); zoom.appendChild(zo);
    box.appendChild(zoom);

    refs.mapFab = btn('fab', 'Режим карты', () => cycleMap());
    refs.mapFab.appendChild(el('span', 'fi'));
    refs.mapFabLbl = el('span', '', 'Карта');
    refs.mapFab.appendChild(refs.mapFabLbl);
    box.appendChild(refs.mapFab);

    refs.paintFab = btn('fab paint', 'Режим кисти', () => setMode(state.mode === 'paint' ? 'pan' : 'paint', true));
    refs.paintIcon = el('span', 'fi');
    refs.paintFab.appendChild(refs.paintIcon);
    refs.paintLbl = el('span', '', 'Рука');
    refs.paintFab.appendChild(refs.paintLbl);
    box.appendChild(refs.paintFab);
    syncMapFab();
    syncPaintFab();
  }
  let zoomTarget = 0, zoomTapAt = 0;
  function zoomBy(f) {
    const cam = Render.cam;
    const c = visibleCenter();
    const t = Render.screenToTile(c.x, c.y);
    const nowMs = performance.now();
    const base = nowMs - zoomTapAt < 500 && zoomTarget > 0 ? zoomTarget : cam.zoom;   // quick repeated taps build on the glide target
    const z = Util.clamp(base * f, Render.minZoom(), Render.maxZoom());
    zoomTarget = z; zoomTapAt = nowMs;
    // keep the tile under the visible centre fixed: shift camera accordingly
    const sz = Render.size;
    const nx = t.x - (c.x - sz.w / 2) / z, ny = t.y - (c.y - sz.h / 2) / z;     // (visible centre stays put)
    Render.focusOn(nx, ny, z);
  }
  function cycleMap() {
    state.mapMode = (state.mapMode + 1) % MAP_MODES.length;
    Render.setMode(MAP_MODES[state.mapMode].mode);
    syncMapFab();
    toast(MAP_MODES[state.mapMode].name);
  }
  function syncMapFab() {
    const m = MAP_MODES[state.mapMode];
    clear(refs.mapFab.firstChild);
    refs.mapFab.firstChild.appendChild(ico(m.icon, 24));
    setText(refs.mapFabLbl, m.label);
    refs.mapFab.classList.toggle('on', state.mapMode !== 0);
  }
  function setMode(m, announce) {
    if (m !== 'pan' && m !== 'paint') return;
    state.mode = m;
    Input.setMode(m);
    document.body.classList.toggle('paint', m === 'paint');
    syncPaintFab();
    if (announce) toast(m === 'paint' ? 'Режим кисти: рисуйте пальцем, карта — двумя пальцами' : 'Режим руки: двигайте карту одним пальцем');
  }
  function syncPaintFab() {
    const p = state.mode === 'paint';
    clear(refs.paintIcon);
    refs.paintIcon.appendChild(ico(p ? 'brush' : 'hand', 24));
    setText(refs.paintLbl, p ? 'Кисть' : 'Рука');
    refs.paintFab.classList.toggle('on', p);
    refs.paintFab.setAttribute('aria-pressed', p ? 'true' : 'false');
  }

  // ------------------------------------------------------------------ event feed
  const FEED_LIFE = { birth: 4500, death: 5500, info: 5500 };
  const BIG_KIND = { war: 1, peace: 1, disaster: 1, kingdom: 1, rebel: 1, god: 1 };
  function flushFeed(now) {
    if (!feed.pending.length) return;
    const list = feed.pending.splice(0, feed.pending.length);
    const from = Math.max(0, list.length - 4);
    for (let i = from; i < list.length; i++) addFeedLine(list[i], now);
  }
  function addFeedLine(e, now) {
    for (let i = 0; i < feed.items.length; i++) if (feed.items[i].msg === e.msg) { feed.items[i].born = now; return; }
    const line = el('button', 'fl' + (e.x >= 0 ? ' go' : '') + (BIG_KIND[e.kind] ? ' big' : ''));
    line.type = 'button';
    const dot = el('i'); dot.style.color = KIND_COLOR[e.kind] || KIND_COLOR.info;
    line.appendChild(dot);
    line.appendChild(el('span', '', e.msg));
    line.addEventListener('click', () => openLog());
    refs.feed.appendChild(line);
    feed.items.push({ node: line, born: now, msg: e.msg, life: FEED_LIFE[e.kind] || 8000 });
    while (feed.items.length > 4) { const old = feed.items.shift(); if (old.node.parentNode) old.node.parentNode.removeChild(old.node); }
  }
  function fadeFeed(now) {
    for (let i = feed.items.length - 1; i >= 0; i--) {
      const it = feed.items[i];
      const age = now - it.born;
      if (age > it.life + 900) { if (it.node.parentNode) it.node.parentNode.removeChild(it.node); feed.items.splice(i, 1); }
      else if (age > it.life && !it.fading) { it.fading = true; it.node.classList.add('fade'); }
      else if (it.fading && age <= it.life) { it.fading = false; it.node.classList.remove('fade'); }
    }
  }
  function clearFeed() {
    feed.pending.length = 0;
    for (const it of feed.items) if (it.node.parentNode) it.node.parentNode.removeChild(it.node);
    feed.items.length = 0;
  }

  // ------------------------------------------------------------------ modal manager
  function modalOpen() { return modals.length > 0; }
  /** opts: {title, tall, onClose, dismiss (default true), foot} -> {close, body, head, card, setTitle} */
  function openModal(opts) {
    opts = opts || {};
    Input.cancel();
    const back = el('div', 'm-back');
    const card = el('div', 'm-card' + (opts.tall ? ' tall' : ''));
    card.setAttribute('role', 'dialog');
    const head = el('div', 'm-head');
    const h2 = el('h2', '', opts.title || '');
    head.appendChild(h2);
    const closeBtn = btn('sh-btn', 'Закрыть', () => m.close());
    closeBtn.appendChild(ico('close', 24));
    const body = el('div', 'm-body');
    card.appendChild(head); card.appendChild(body);
    let foot = null;
    if (opts.foot) { foot = el('div', 'm-foot'); card.appendChild(foot); }
    back.appendChild(card);
    if (opts.dismiss !== false) {
      back.addEventListener('click', (ev) => { if (ev.target === back) m.close(); });
      head.appendChild(closeBtn);
    }
    refs.modals.appendChild(back);
    const m = {
      back, card, head, body, foot, h2, closeBtn,
      setTitle(t) { h2.textContent = t; },
      close() {
        const i = modals.indexOf(m);
        if (i < 0) return;
        modals.splice(i, 1);
        if (back.parentNode) back.parentNode.removeChild(back);
        if (!modals.length) document.body.classList.remove('modal-open');
        if (opts.onClose) opts.onClose();
      },
    };
    modals.push(m);
    document.body.classList.add('modal-open');
    return m;
  }
  function closeAllModals() { while (modals.length) modals[modals.length - 1].close(); }
  function confirmBox(o) {
    const m = openModal({ title: o.title || 'Подтверждение', foot: true });
    m.body.appendChild(el('p', 'confirm-text', o.text || ''));
    const cancel = btn('btn', '', () => m.close()); cancel.textContent = o.cancel || 'Отмена';
    const ok = btn('btn ' + (o.danger ? 'danger' : 'primary'), '', () => { m.close(); if (o.onOk) o.onOk(); }); ok.textContent = o.ok || 'Да';
    m.foot.appendChild(cancel); m.foot.appendChild(ok);
    return m;
  }

  // ------------------------------------------------------------------ menu
  const SLOT_NAMES = { auto: 'Автосохранение', 1: 'Слот 1', 2: 'Слот 2', 3: 'Слот 3' };
  function slotName(s) { return SLOT_NAMES[s] || ('Слот ' + s); }
  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p2 = (n) => (n < 10 ? '0' : '') + n;
    return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }
  function slotInfoText(info) {
    if (!info) return null;
    return yearText(info.year) + ' · ' + info.pop + ' жит. · ' + (info.kingdoms | 0) + ' кор. · ' + fmtDate(info.savedAt);
  }
  function saveErrorText() {
    const e = String(Save.lastError || '');
    if (/Quota/i.test(e)) return 'нет места в хранилище браузера';
    if (/no storage/i.test(e)) return 'хранилище недоступно (приватный режим?)';
    return 'ошибка записи';
  }
  function doSave(slot, after) {
    defer(() => {
      let ok = false;
      try { ok = Save.save(slot); } catch (e) { ok = false; }
      if (ok) toast('Сохранено: ' + slotName(slot), 'good'); else toast('Не удалось сохранить: ' + saveErrorText(), 'bad');
      if (after) after(ok);
    });
  }
  function doLoad(slot, menu) {
    defer(() => {
      let ok = false;
      try { ok = Save.load(slot); } catch (e) { ok = false; }
      if (ok) { Main.worldReplaced('load'); if (menu) menu.close(); closeAllModals(); toast('Загружено: ' + slotName(slot), 'good'); }
      else toast('Не удалось загрузить: ' + slotName(slot), 'bad');
    });
  }
  function hashSeed(str) {
    str = String(str).trim();
    if (!str) return 0;
    if (/^-?\d{1,10}$/.test(str)) return (Math.abs(parseInt(str, 10)) % 2147483646) || 1;
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 2147483646) + 1;
  }
  function openMenu() {
    const m = openModal({ title: 'Меню' });
    let page = 'main';
    const newOpts = { size: S.w || 96, seed: '', populate: true };
    if (![64, 96, 128].includes(newOpts.size)) newOpts.size = 96;

    function header(title, backTo) {
      m.setTitle(title);
      const old = m.head.querySelector('.sh-btn.bk');
      if (old) old.parentNode.removeChild(old);
      if (backTo) {
        const b = btn('sh-btn bk', 'Назад', () => show(backTo));
        b.textContent = '‹';
        b.style.fontSize = '26px'; b.style.paddingBottom = '3px';
        m.head.insertBefore(b, m.h2);
      }
    }
    function menuItem(icon, title, sub, fn, cls) {
      const b = btn('mbtn' + (cls ? ' ' + cls : ''), title, fn);
      b.appendChild(ico(icon, 32));
      const t = el('div'); t.appendChild(document.createTextNode(title));
      if (sub) t.appendChild(el('small', '', sub));
      b.appendChild(t);
      return b;
    }
    function show(p) {
      page = p;
      clear(m.body);
      if (m.foot) { m.foot.remove(); m.foot = null; }
      m.body.scrollTop = 0;
      if (p === 'main') {
        header('Меню');
        const list = el('div', 'menu-list');
        list.appendChild(menuItem('save', 'Сохранить', 'В один из трёх слотов', () => show('save')));
        list.appendChild(menuItem('load', 'Загрузить', 'Слоты и автосохранение', () => show('load')));
        list.appendChild(menuItem('newworld', 'Новый мир', 'Размер, зерно, население', () => show('new')));
        list.appendChild(menuItem('map_normal', 'Сброс масштаба', 'Показать всю карту', () => { m.close(); Main.resetView(); }));
        list.appendChild(menuItem('tab_info', 'Помощь', 'Как играть', () => { m.close(); openHelp(); }));
        list.appendChild(menuItem('crown', 'О игре', 'GODSIM', () => show('about')));
        m.body.appendChild(list);
        const on0 = !!safe(() => War.autoPeace(), true);
        const ap = btn('check mt' + (on0 ? ' on' : ''), 'Авто‑мир при истощении', () => {
          const on = !ap.classList.contains('on');
          safe(() => War.setAutoPeace(on), 0);
          ap.classList.toggle('on', on); ap.setAttribute('aria-pressed', on ? 'true' : 'false');
          toast(on ? 'Затянувшиеся войны будут заканчиваться миром сами' : 'Войны идут, пока вы не заключите мир');
        });
        ap.dataset.act = 'autopeace'; ap.setAttribute('aria-pressed', on0 ? 'true' : 'false');
        const abox = el('span', 'box'); abox.appendChild(ico('check', 16)); ap.appendChild(abox);
        const atx = el('span'); atx.appendChild(document.createTextNode('Авто‑мир при истощении')); atx.appendChild(el('small', '', 'Затянувшаяся война или смута закончится миром'));
        ap.appendChild(atx);
        m.body.appendChild(ap);
      } else if (p === 'save' || p === 'load') {
        header(p === 'save' ? 'Сохранить' : 'Загрузить', 'main');
        const slots = p === 'save' ? ['1', '2', '3'] : ['auto', '1', '2', '3'];
        slots.forEach((s) => {
          const info = Save.info(s);
          const row = el('div', 'slot');
          const si = el('div', 'si');
          si.appendChild(el('b', '', slotName(s)));
          const txt = slotInfoText(info);
          si.appendChild(el('small', txt ? '' : 'empty', txt || 'пусто'));
          row.appendChild(si);
          if (p === 'save') {
            const b = btn('btn primary', 'Сохранить в ' + slotName(s), () => {
              const go = () => doSave(s, () => show('save'));
              if (info) confirmBox({ title: 'Перезаписать?', text: slotName(s) + ' уже занят: ' + slotInfoText(info) + '. Заменить его текущим миром?', ok: 'Перезаписать', danger: true, onOk: go });
              else go();
            });
            b.textContent = 'Сохранить';
            row.appendChild(b);
          } else {
            const b = btn('btn' + (info ? ' primary' : ''), 'Загрузить ' + slotName(s), () => {
              confirmBox({ title: 'Загрузить мир?', text: 'Текущий мир будет заменён: ' + slotName(s) + ' — ' + slotInfoText(info) + '. Несохранённый прогресс пропадёт.', ok: 'Загрузить', danger: true, onOk: () => doLoad(s, m) });
            });
            b.textContent = 'Загрузить';
            b.disabled = !info;
            row.appendChild(b);
          }
          m.body.appendChild(row);
        });
        if (p === 'save') m.body.appendChild(el('div', 'muted', 'Автосохранение выполняется каждую минуту и при сворачивании игры.'));
      } else if (p === 'new') {
        header('Новый мир', 'main');
        const f1 = el('div', 'field'); f1.appendChild(el('label', '', 'Размер карты'));
        const seg = el('div', 'segm');
        [[64, 'Малая'], [96, 'Средняя'], [128, 'Большая']].forEach(([n, nm]) => {
          const b = btn(newOpts.size === n ? 'on' : '', nm, () => { newOpts.size = n; [...seg.children].forEach((c) => c.classList.toggle('on', c === b)); });
          b.appendChild(document.createTextNode(n + '×' + n)); b.appendChild(el('small', '', nm));
          seg.appendChild(b);
        });
        f1.appendChild(seg); m.body.appendChild(f1);
        const f2 = el('div', 'field'); f2.appendChild(el('label', '', 'Зерно мира (пусто = случайное)'));
        const row = el('div', 'row');
        const inp = el('input', 'txtin'); inp.type = 'text'; inp.inputMode = 'text'; inp.placeholder = 'случайное'; inp.maxLength = 24; inp.autocomplete = 'off'; inp.setAttribute('autocapitalize', 'off'); inp.spellcheck = false;
        inp.value = newOpts.seed;
        inp.addEventListener('input', () => { newOpts.seed = inp.value; });
        const dice = btn('btn', 'Случайное зерно', () => { newOpts.seed = String(1 + Math.floor(Math.random() * 999999)); inp.value = newOpts.seed; });
        dice.textContent = 'Случайно';
        row.appendChild(inp); row.appendChild(dice); f2.appendChild(row); m.body.appendChild(f2);
        const f3 = el('div', 'field');
        const chk = btn('check' + (newOpts.populate ? ' on' : ''), 'Заселить мир', () => { newOpts.populate = !newOpts.populate; chk.classList.toggle('on', newOpts.populate); chk.setAttribute('aria-pressed', newOpts.populate ? 'true' : 'false'); });
        const box = el('span', 'box'); box.appendChild(ico('check', 16)); chk.appendChild(box);
        const tx = el('span'); tx.appendChild(document.createTextNode('Заселить мир')); tx.appendChild(el('small', '', 'Люди, орки и эльфы появятся сразу'));
        chk.appendChild(tx);
        f3.appendChild(chk); m.body.appendChild(f3);
        m.foot = el('div', 'm-foot'); m.card.appendChild(m.foot);
        const go = btn('btn danger', 'Создать мир', () => {
          confirmBox({
            title: 'Создать новый мир?', text: 'Текущий мир будет потерян, если он не сохранён.', ok: 'Создать', danger: true,
            onOk: () => {
              const seed = hashSeed(newOpts.seed);
              defer(() => {
                try { Main.newWorld({ seed: seed || undefined, w: newOpts.size, h: newOpts.size, populate: newOpts.populate }); closeAllModals(); toast('Новый мир создан', 'good'); }
                catch (e) { toast('Не удалось создать мир', 'bad'); console.error(e); }
              });
            },
          });
        });
        go.textContent = 'Создать мир';
        m.foot.appendChild(go);
      } else if (p === 'about') {
        header('О игре', 'main');
        const a = el('div', 'about');
        a.innerHTML = aboutHtml();
        m.body.appendChild(a);
      }
    }
    show(page);
    return m;
  }
  function aboutHtml() {
    return '<p><b>GODSIM</b> — симулятор бога в кармане. Создайте мир, населите его людьми, орками и эльфами и наблюдайте, как рождаются города и королевства, вспыхивают войны и рушатся империи. Помогайте своим любимцам — или карайте.</p>' +
      '<h3>Управление</h3><ul>' +
      '<li>Один палец — двигать карту, два пальца — масштаб.</li>' +
      '<li>Выберите инструмент внизу и тапните по карте.</li>' +
      '<li>Кнопка с кистью включает рисование пальцем.</li>' +
      '<li>Тап без инструмента — карточка существа, здания, города или королевства.</li></ul>' +
      '<h3>Сохранения</h3><p>Мир сохраняется автоматически раз в минуту и при сворачивании. Три слота — в меню.</p>' +
      '<p style="color:#64739a;font-size:12.5px">Всё нарисовано кодом — ни одной картинки. Версия 1.0.</p>';
  }

  // ------------------------------------------------------------------ help panel
  function openHelp() {
    const m = openModal({ title: 'Помощь', tall: true });
    const a = el('div', 'about');
    a.innerHTML =
      '<h3>Карта</h3><ul>' +
      '<li><b>Перетаскивание</b> — двигать карту, <b>щипок</b> — масштаб (или кнопки + и −).</li>' +
      '<li>Кнопка со слоями переключает карту: обычная, границы королевств, культуры.</li></ul>' +
      '<h3>Инструменты</h3><ul>' +
      '<li><b>Ландшафт</b> — поднимайте горы, опускайте землю под воду, сажайте леса, проливайте лаву.</li>' +
      '<li><b>Существа</b> — создавайте людей, орков и эльфов. Ластик стирает существ.</li>' +
      '<li><b>Силы</b> — молнии, метеориты, чума и торнадо. А ещё дождь, исцеление и благословение.</li>' +
      '<li><b>Королевства</b> — шепните королю о войне, примирите враждующих или отколите город.</li></ul>' +
      '<h3>Режим кисти</h3><ul>' +
      '<li>Значок <b>«Рука / Кисть»</b> справа внизу переключает режим.</li>' +
      '<li>В режиме кисти один палец рисует, а двигать и масштабировать карту нужно двумя.</li>' +
      '<li>Размер кисти — ползунок под инструментами.</li></ul>' +
      '<h3>Скорость</h3><ul><li>Пауза, ×1, ×2, ×4 — вверху. На паузе можно спокойно творить.</li></ul>' +
      '<h3>Осмотр</h3><ul>' +
      '<li>Тап без инструмента открывает карточку: здоровье и черты существа, склады города, отношения королевства.</li>' +
      '<li>Кнопка «На карте» показывает объект.</li>' +
      '<li>Лента событий сверху: тап открывает полный журнал.</li></ul>';
    m.body.appendChild(a);
  }

  // ------------------------------------------------------------------ log panel
  function logRow(e) {
    const hasPos = e.x >= 0 && e.y >= 0;
    const b = btn('log-item', '', () => {
      if (!hasPos) return;
      closeAllModals();
      Main.focusTile(e.x, e.y);
      const lrid = safe(() => Render.regionAt(e.x + 0.5, e.y + 0.5), 0);
      if (lrid) setRegionHL(lrid, 3500);
      Render.highlight = { type: 'tile', id: 0, x: e.x, y: e.y };
      setTimeout(() => { if (Render.highlight && Render.highlight.id === 0 && !insp) Render.highlight = null; }, 3500);
    });
    const dot = el('i'); dot.style.color = KIND_COLOR[e.kind] || KIND_COLOR.info;
    b.appendChild(dot);
    b.appendChild(el('span', 'lt', e.msg));
    const right = el('span', 'ly', 'Год ' + e.year);
    b.appendChild(right);
    if (hasPos) { const g = ico('focus', 16); g.classList.add('go'); b.appendChild(g); }
    return b;
  }
  function openLog() {
    if (logPanel) return;
    const m = openModal({ title: 'Журнал', tall: true, onClose: () => { logPanel = null; } });
    const filters = el('div', 'filters');
    m.card.insertBefore(filters, m.body);
    const lp = { m, filter: 'all', lastId: 0, count: 0 };
    logPanel = lp;
    LOG_FILTERS.forEach((f) => {
      const b = btn(f.id === 'all' ? 'on' : '', f.name, () => { lp.filter = f.id; [...filters.children].forEach((c) => c.classList.toggle('on', c === b)); rebuild(); });
      b.textContent = f.name;
      filters.appendChild(b);
    });
    function pass(e) {
      const f = LOG_FILTERS.find((x) => x.id === lp.filter);
      return !f || !f.kinds || f.kinds.indexOf(e.kind) >= 0;
    }
    function rebuild() {
      clear(m.body);
      lp.count = 0;
      const arr = S.log;
      lp.lastId = arr.length ? arr[arr.length - 1].id : 0;
      for (let i = arr.length - 1; i >= 0; i--) if (pass(arr[i])) { m.body.appendChild(logRow(arr[i])); lp.count++; }
      if (!lp.count) m.body.appendChild(el('div', 'muted', 'Пока тихо. Мир ещё не успел ничего натворить.'));
      m.body.scrollTop = 0;
    }
    lp.refresh = () => {
      const arr = S.log;
      if (!arr.length) return;
      const lastId = arr[arr.length - 1].id;
      if (lastId === lp.lastId) return;
      const fresh = [];
      for (let i = arr.length - 1; i >= 0 && arr[i].id > lp.lastId; i--) fresh.push(arr[i]);
      lp.lastId = lastId;
      const ph = m.body.querySelector('.muted'); if (ph) ph.remove();
      const atTop = m.body.scrollTop < 8;
      for (let i = fresh.length - 1; i >= 0; i--) if (pass(fresh[i])) { m.body.insertBefore(logRow(fresh[i]), m.body.firstChild); lp.count++; }
      while (m.body.children.length > 320) m.body.removeChild(m.body.lastChild);
      if (atTop) m.body.scrollTop = 0;
    };
    rebuild();
  }

  // ------------------------------------------------------------------ world panel
  function openWorld() {
    if (statsPanel) return;
    const m = openModal({ title: 'Мир', tall: true, onClose: () => { statsPanel = null; } });
    const sp = { m, ups: [] };
    statsPanel = sp;
    const body = m.body;
    // population by race
    const sec1 = el('div', 'sec'); sec1.appendChild(el('div', 'sec-h', 'Население'));
    const grid = el('div', 'stat-grid');
    const bar = el('div', 'popbar');
    const segs = [];
    for (let r = 0; r < 3; r++) {
      const st = el('div', 'stat');
      st.appendChild(ico(RACE_KEYS[r], 24));
      const b = el('b', '', '0'); b.style.color = Races.list[r].color; st.appendChild(b);
      st.appendChild(el('small', '', rname(r)));
      grid.appendChild(st);
      const seg = el('i'); seg.style.background = Races.list[r].color; seg.style.width = '0%'; bar.appendChild(seg); segs.push(seg);
      sp.ups.push(() => setText(b, S.stats.pop[r] | 0));
    }
    sec1.appendChild(grid); sec1.appendChild(el('div', '', '')); sec1.lastChild.style.height = '8px'; sec1.appendChild(bar);
    sp.ups.push(() => { const tot = Math.max(1, S.stats.popTotal | 0); for (let r = 0; r < 3; r++) setStyle(segs[r], 'width', pct((S.stats.pop[r] | 0) / tot)); });
    body.appendChild(sec1);
    // world totals
    const sec2 = el('div', 'sec'); sec2.appendChild(el('div', 'sec-h', 'Мир'));
    const g2 = el('div', 'stat-grid');
    [['Год', () => Util.year()], ['Жителей', () => S.stats.popTotal | 0], ['Городов', () => S.stats.cities | 0], ['Королевств', () => S.stats.kingdoms | 0], ['Войн', () => S.stats.wars | 0], ['Зданий', () => S.stats.buildings | 0]].forEach(([nm, fn]) => {
      const st = el('div', 'stat'); const b = el('b', '', '0'); st.appendChild(b); st.appendChild(el('small', '', nm)); g2.appendChild(st);
      sp.ups.push(() => setText(b, fn()));
    });
    sec2.appendChild(g2); body.appendChild(sec2);
    // kingdoms ranking
    const sec3 = el('div', 'sec'); sec3.appendChild(el('div', 'sec-h', 'Королевства'));
    const kl = el('div'); sec3.appendChild(kl); body.appendChild(sec3);
    let kSig = '';
    sp.ups.push(() => {
      const arr = kingdomList().slice(0, 8);
      const sig = arr.map((x) => x.k.id + ':' + x.pop).join(',');
      if (sig === kSig) return;
      kSig = sig; clear(kl);
      if (!arr.length) { kl.appendChild(el('div', 'muted', 'Пока нет ни одного королевства.')); return; }
      arr.forEach((x) => {
        const row = el('div', 'kv');
        const l = kingdomLink(x.k, true); l.addEventListener('click', () => { const kid = x.k.id; m.close(); openInspector('kingdom', kid, { focus: true }); });
        row.appendChild(l);
        row.appendChild(el('span', 'v', x.pop + ' жит. · ' + x.k.cities.length + ' гор.'));
        kl.appendChild(row);
      });
    });
    // debug
    const sec4 = el('div', 'sec'); sec4.appendChild(el('div', 'sec-h', 'Производительность'));
    const dbg = el('div', 'dbg'); sec4.appendChild(dbg); body.appendChild(sec4);
    sp.ups.push(() => {
      const rs = Render.stats || {};
      const pf = S.perf || {};
      setText(dbg, 'FPS ' + (rs.fps || 0).toFixed(0) + '  ·  кадр ' + (rs.drawMs || 0).toFixed(1) + ' мс  ·  тик ' + (pf.stepMs || 0).toFixed(2) + ' мс\n' +
        'существ ' + S.units.size + '  ·  думают раз в ' + (pf.thinkEvery || 0) + ' тик.  ·  lod ' + (pf.lod || 0) + '\n' +
        'тик ' + S.tick + '  ·  скорость ×' + Main.getSpeed() + '  ·  масштаб ' + Render.cam.zoom.toFixed(1));
      dbg.style.whiteSpace = 'pre-line';
    });
    sp.refresh = () => { for (let i = 0; i < sp.ups.length; i++) { try { sp.ups[i](); } catch (e) { /* keep going */ } } };
    sp.refresh();
  }

  // ------------------------------------------------------------------ kingdom list helpers
  function kingdomList() {
    const out = [];
    for (const k of S.kingdoms.values()) {
      if (k.alive === false) continue;
      let pop = 0;
      for (let i = 0; i < k.cities.length; i++) { const c = S.cities.get(k.cities[i]); if (c) pop += c.pop || 0; }
      out.push({ k, pop });
    }
    out.sort((a, b) => b.pop - a.pop || a.k.id - b.k.id);
    return out;
  }
  function kingdomAtWar(kid) {
    try {
      if (typeof War !== 'undefined' && War.warsOf) { const w = War.warsOf(kid); if (w && w.length) return true; }
    } catch (e) { /* ignore */ }
    for (const w of S.wars.values()) {
      if (w.ended) continue;
      if ((w.attackers && w.attackers.indexOf(kid) >= 0) || (w.defenders && w.defenders.indexOf(kid) >= 0)) return true;
    }
    return false;
  }
  function updateChips(force) {
    const kb = refs.kbar;
    const list = kingdomList();
    let sig = '';
    for (const x of list) sig += x.k.id + ':' + x.pop + ':' + (kingdomAtWar(x.k.id) ? 1 : 0) + ':' + x.k.name + ':' + flagSig(x.k.flag) + ';';
    if (!force && sig === chipSig) return;
    chipSig = sig;
    if (!list.length) {
      if (!kb.querySelector('.kempty')) { clear(kb); chipMap.clear(); kb.appendChild(el('div', 'kempty', 'Королевств пока нет — они появятся вместе с первыми городами')); }
      return;
    }
    const e = kb.querySelector('.kempty'); if (e) e.remove();
    const alive = new Set();
    list.forEach((x, idx) => {
      const k = x.k;
      alive.add(k.id);
      let ch = chipMap.get(k.id);
      if (!ch) {
        const b = btn('kchip', k.name, () => {
          const kk = S.kingdoms.get(k.id);
          if (!kk) return;
          if (state.tool === 'command') commandKingdom(k.id, {}); else openInspector('kingdom', k.id, { focus: true });
        });
        const fl = flagEl(k.flag, 24);
        const kn = el('span', 'kn'); const nm = el('b'); const sm = el('small');
        kn.appendChild(nm); kn.appendChild(sm);
        const wi = ico('war', 16); wi.classList.add('wi', 'hide'); wi.title = 'Идёт война';
        b.appendChild(fl); b.appendChild(kn); b.appendChild(wi);
        ch = { b, fl, nm, sm, wi };
        chipMap.set(k.id, ch);
      }
      ch.b.style.setProperty('--kc', k.color);
      drawFlag(ch.fl, k.flag);
      setText(ch.nm, k.name);
      const war = kingdomAtWar(k.id);
      setText(ch.sm, x.pop + ' жит. · ' + k.cities.length + ' гор.');
      ch.wi.classList.toggle('hide', !war);
      ch.b.classList.toggle('atwar', war);
      if (ch.b.parentNode !== kb || kb.children[idx] !== ch.b) kb.insertBefore(ch.b, kb.children[idx] || null);
    });
    for (const [id, ch] of chipMap) if (!alive.has(id)) { if (ch.b.parentNode) ch.b.parentNode.removeChild(ch.b); chipMap.delete(id); }
  }

  // ------------------------------------------------------------------ inspector: building blocks
  function mkView() {
    const v = { ups: [], body: el('div'), ava: el('div', 'sh-ava'), title: el('b'), sub: el('small'), finished: false, hl: null, focus: null, actions: [] };
    return v;
  }
  function sec(v, title) { const s = el('div', 'sec'); if (title) s.appendChild(el('div', 'sec-h', title)); v.body.appendChild(s); return s; }
  function kvRow(v, parent, label, get) {
    const r = el('div', 'kv');
    r.appendChild(el('span', '', label));
    const val = el('span', 'v');
    r.appendChild(val);
    parent.appendChild(r);
    if (get) v.ups.push(() => setText(val, get()));
    return val;
  }
  function slot(v, node, get, build) {
    let key = null;
    v.ups.push(() => {
      const k = get();
      if (k === key) return;
      key = k;
      clear(node);
      build(node);
    });
  }
  function barRow(v, parent, label, frac, text, color, mid) {
    const row = el('div', 'bar' + (mid ? ' mid' : ''));
    if (label) row.appendChild(el('label', '', label));
    const tr = el('div', 'track'); const fill = el('div', 'fill'); const tx = el('div', 'txt');
    tr.appendChild(fill); tr.appendChild(tx); row.appendChild(tr);
    parent.appendChild(row);
    v.ups.push(() => {
      const f = frac();
      if (mid) { const o = Util.clamp(f, -1, 1); setStyle(fill, 'left', o < 0 ? (50 + o * 50) + '%' : '50%'); setStyle(fill, 'width', Math.abs(o) * 50 + '%'); }
      else setStyle(fill, 'transform', 'scaleX(' + (Math.round(Util.clamp(f, 0, 1) * 1000) / 1000) + ')');
      const c = color ? color(f) : null;
      if (c) setStyle(fill, 'backgroundColor', c);
      setText(tx, text());
    });
    return row;
  }
  function chipsSlot(v, parent, get, quiet) {          // get() -> [{t, cls}]; quiet: no placeholder when empty
    const box = el('div', 'chips');
    parent.appendChild(box);
    slot(v, box, () => { const a = get(); let s = ''; for (let i = 0; i < a.length; i++) s += a[i].t + '|' + (a[i].cls || '') + ';'; return s; }, (node) => {
      const a = get();
      a.forEach((c) => node.appendChild(el('span', 'chip' + (c.cls ? ' ' + c.cls : ''), c.t)));
      if (!a.length && !quiet) node.appendChild(el('span', 'muted', '—'));
      node.style.display = a.length || !quiet ? '' : 'none';
      node.style.marginBottom = a.length && quiet ? '6px' : '';
    });
    return box;
  }
  function linkBtn(type, id, nameEl, iconEl) {
    const b = btn('link', '', () => openInspector(type, id, { push: true }));
    if (iconEl) b.appendChild(iconEl);
    b.appendChild(nameEl);
    return b;
  }
  function kingdomLink(k, noNav) {
    const b = btn('link', k.name, noNav ? null : () => openInspector('kingdom', k.id, { push: true }));
    b.appendChild(flagEl(k.flag, 24));
    b.appendChild(el('span', '', k.name));
    return b;
  }
  function cityLink(c) {
    const ic = spriteEl(Sprites.building(Const.B.TOWNHALL, c.race, Math.min(3, c.level || 1), true), 24);
    return linkBtn('city', c.id, el('span', '', c.name), ic);
  }
  function unitLink(u) {
    return linkBtn('unit', u.id, el('span', '', u.name), ico(RACE_KEYS[u.race] || 'human', 16));
  }
  function histList(v, parent, getHist) {
    const ul = el('ul', 'hist');
    parent.appendChild(ul);
    slot(v, ul, () => { const h = getHist(); return h && h.length ? h.length + ':' + h[h.length - 1].t + h[h.length - 1].y : '0'; }, (node) => {
      const h = getHist() || [];
      if (!h.length) { const li = el('li'); li.appendChild(el('span', 'muted', 'Пока ничего не произошло')); node.appendChild(li); return; }
      for (let i = h.length - 1; i >= Math.max(0, h.length - 8); i--) {
        const li = el('li'); li.appendChild(el('b', '', 'Год ' + h[i].y)); li.appendChild(el('span', '', h[i].t)); node.appendChild(li);
      }
    });
  }

  // ------------------------------------------------------------------ inspector: views
  function viewUnit(id) {
    const u0 = S.units.get(id);
    if (!u0) return null;
    const v = mkView();
    const get = () => S.units.get(id);
    let last = { x: u0.x, y: u0.y };
    v.hl = { type: 'unit', id, x: u0.x, y: u0.y };
    v.focus = () => { const u = get(); if (u) last = { x: u.x, y: u.y }; return last; };
    v.ava.appendChild(ico(RACE_KEYS[u0.race] || 'human', 32));
    const raceInfo = Races.list[u0.race];
    v.ups.push(() => {
      const u = get();
      if (!u) {
        if (!v.finished) { v.finished = true; setText(v.sub, 'Погиб · ' + raceInfo.one); v.dead = true; }
        return;
      }
      const ruler = u.isRuler ? Names.ruler(u.race, u.sex) + ' ' : '';
      setText(v.title, ruler + u.name);
      const stg = Units.stage(u);
      setText(v.sub, raceInfo.one + ' · ' + (u.sex === Const.SEX.F ? 'жен.' : 'муж.') + ' · ' + ageText(u) + (stg === 'child' ? ' · ребёнок' : stg === 'elder' ? ' · старец' : ''));
    });
    const maxHp = (u) => { const s = Units.stats(u); return s ? s.maxHp : (u.maxHp || 1); };
    const bars = sec(v); const bg = el('div', 'bars'); bars.appendChild(bg);
    barRow(v, bg, 'Здоровье', () => { const u = get(); return u ? u.hp / maxHp(u) : 0; }, () => { const u = get(); return u ? Math.ceil(Math.max(0, u.hp)) + ' / ' + maxHp(u) : '—'; }, hpColor);
    barRow(v, bg, 'Голод', () => { const u = get(); return u ? u.hunger / 100 : 0; }, () => { const u = get(); return u ? (u.hunger < 25 ? 'сыт' : u.hunger < 60 ? 'проголодался' : u.hunger < 85 ? 'голоден' : 'умирает с голоду') : '—'; }, (f) => hpColor(1 - f));
    barRow(v, bg, 'Энергия', () => { const u = get(); return u ? u.energy / 100 : 0; }, () => { const u = get(); return u ? num(u.energy) + '%' : '—'; }, () => '#58c7ff');
    barRow(v, bg, 'Опыт', () => { const u = get(); return u ? u.xp / (20 * u.level) : 0; }, () => { const u = get(); return u ? 'ур. ' + u.level + ' · ' + Math.floor(u.xp) + ' / ' + 20 * u.level : '—'; }, () => '#c78bff');

    const s1 = sec(v);
    chipsSlot(v, s1, () => {
      const u = get(); const a = [];
      if (!u) return a;
      if (u.isRuler) a.push({ t: 'Правитель', cls: 'gold' });
      if (u.sick > S.tick) a.push({ t: 'Болеет', cls: 'bad' });
      if (u.burning > S.tick) a.push({ t: 'Горит', cls: 'warn' });
      if (u.buffUntil > S.tick) a.push({ t: 'Благословлён', cls: 'good' });
      if (u.hunger > 85) a.push({ t: 'Голодает', cls: 'bad' });
      if (u.armyId) a.push({ t: 'В армии', cls: 'warn' });
      return a;
    }, true);
    kvRow(v, s1, 'Занятие', () => { const u = get(); if (!u) return '—'; let s = Units.stateLabel(u) || '—'; if (u.carry && u.carryAmt > 0) { const g = (GOOD_NAMES[u.carry] || u.carry).toLowerCase(); s = s === 'Несёт добычу' ? 'Несёт: ' + g : s + ' · несёт ' + g; } return s; });
    kvRow(v, s1, 'Оружие', () => { const u = get(); if (!u) return '—'; const nm = Gear.weaponNames[RACE_KEYS[u.race]]; return nm ? nm[u.weapon | 0] : '—'; });
    kvRow(v, s1, 'Броня', () => { const u = get(); return u ? Gear.armorNames[u.armor | 0] || '—' : '—'; });
    kvRow(v, s1, 'Бой', () => { const u = get(); if (!u) return '—'; const s = Units.stats(u); return s ? 'атака ' + s.atk.toFixed(1) + ' · защита ' + s.def.toFixed(1) + ' · убийств ' + (u.kills | 0) : '—'; });
    const rc = el('div', 'kv'); rc.appendChild(el('span', '', 'Город')); const rcv = el('span', 'v'); rc.appendChild(rcv); s1.appendChild(rc);
    slot(v, rcv, () => { const u = get(); return u ? u.cityId + ':' + (S.cities.get(u.cityId) ? S.cities.get(u.cityId).name : '') : '-'; }, (node) => {
      const u = get(); const c = u && S.cities.get(u.cityId);
      if (c) node.appendChild(cityLink(c)); else node.appendChild(el('span', 'muted', 'бездомный'));
    });
    const rk = el('div', 'kv'); rk.appendChild(el('span', '', 'Королевство')); const rkv = el('span', 'v'); rk.appendChild(rkv); s1.appendChild(rk);
    slot(v, rkv, () => { const u = get(); const k = u && S.kingdoms.get(u.kingdomId); return k ? k.id + ':' + k.name + flagSig(k.flag) : '-'; }, (node) => {
      const u = get(); const k = u && S.kingdoms.get(u.kingdomId);
      if (k) node.appendChild(kingdomLink(k)); else node.appendChild(el('span', 'muted', 'нет'));
    });

    const s2 = sec(v, 'Черты');
    const tr = el('div', 'chips'); s2.appendChild(tr);
    (u0.traits || []).forEach((t) => { const tt = Traits.get(t); if (tt) tr.appendChild(el('span', 'chip', tt.name)); });
    if (!tr.children.length) tr.appendChild(el('span', 'muted', '—'));

    const s3 = sec(v, 'Семья');
    const fam = el('div', 'chips'); s3.appendChild(fam);
    let kids = [], kidsAt = -1e9;
    const childrenOf = () => {
      const t = performance.now();
      if (t - kidsAt < 1000) return kids;
      kidsAt = t; kids = [];
      for (const o of S.units.values()) { if (o.fatherId === id || o.motherId === id) { kids.push(o.id); if (kids.length >= 8) break; } }
      return kids;
    };
    slot(v, fam, () => {
      const u = get(); if (!u) return 'x';
      return u.fatherId + '|' + u.motherId + '|' + u.spouseId + '|' + childrenOf().join(',');
    }, (node) => {
      const u = get(); if (!u) return;
      const add = (label, o) => { if (!o) return; const w = el('div', 'kv'); w.style.width = '100%'; w.appendChild(el('span', '', label)); const vv = el('span', 'v'); vv.appendChild(unitLink(o)); w.appendChild(vv); node.appendChild(w); };
      add('Отец', S.units.get(u.fatherId));
      add('Мать', S.units.get(u.motherId));
      add(u.sex === Const.SEX.F ? 'Муж' : 'Жена', S.units.get(u.spouseId));
      const ks = childrenOf().map((cid) => S.units.get(cid)).filter(Boolean);
      if (ks.length) {
        const w = el('div', 'kv'); w.style.width = '100%'; w.style.alignItems = 'flex-start';
        w.appendChild(el('span', '', 'Дети'));
        const vv = el('span', 'v');
        ks.slice(0, 7).forEach((o) => vv.appendChild(unitLink(o)));
        w.appendChild(vv); node.appendChild(w);
      }
      if (!node.children.length) node.appendChild(el('span', 'muted', 'Родных рядом нет'));
    });

    const s4 = sec(v, 'История');
    histList(v, s4, () => { const u = get(); return u ? u.hist : null; });
    return v;
  }

  function viewBuilding(id) {
    const b0 = S.buildings.get(id);
    if (!b0) return null;
    const v = mkView();
    const get = () => S.buildings.get(id);
    const def = (t) => Buildings.defs[t] || { name: 'Здание', hp: 1 };
    const city0 = S.cities.get(b0.cityId);
    let last = { x: b0.x, y: b0.y };
    v.hl = { type: 'building', id, x: b0.x, y: b0.y };
    v.focus = () => last;
    v.ava.appendChild(spriteEl(Sprites.building(b0.type, city0 ? city0.race : 0, Math.min(3, b0.level || 1), b0.done !== false), 32));
    v.ups.push(() => {
      const b = get();
      if (!b) { if (!v.finished) { v.finished = true; v.dead = true; setText(v.sub, 'Разрушено'); } return; }
      const c = S.cities.get(b.cityId);
      setText(v.title, def(b.type).name + (b.done ? '' : ' (стройка)'));
      setText(v.sub, (c ? c.name + ' · ' : '') + 'уровень ' + (b.level || 1));
    });
    const bars = sec(v); const bg = el('div', 'bars'); bars.appendChild(bg);
    barRow(v, bg, 'Прочность', () => { const b = get(); return b ? b.hp / Math.max(1, b.maxHp) : 0; }, () => { const b = get(); return b ? Math.ceil(b.hp) + ' / ' + Math.round(b.maxHp) : '—'; }, hpColor);
    const prog = barRow(v, bg, 'Стройка', () => { const b = get(); return b ? b.progress : 0; }, () => { const b = get(); return b ? num((b.progress || 0) * 100) + '%' : '—'; }, () => '#ffca3d');
    v.ups.push(() => { const b = get(); setCls(prog, 'hide', !b || b.done); });
    const s1 = sec(v);
    kvRow(v, s1, 'Вмещает', () => { const b = get(); if (!b) return '—'; const cap = Buildings.capOf ? Buildings.capOf(b) : 0; return cap ? cap + ' жит.' : '—'; });
    const rc = el('div', 'kv'); rc.appendChild(el('span', '', 'Город')); const rcv = el('span', 'v'); rc.appendChild(rcv); s1.appendChild(rc);
    slot(v, rcv, () => { const b = get(); const c = b && S.cities.get(b.cityId); return c ? c.id + c.name : '-'; }, (node) => { const b = get(); const c = b && S.cities.get(b.cityId); if (c) node.appendChild(cityLink(c)); else node.appendChild(el('span', 'muted', '—')); });
    const rk = el('div', 'kv'); rk.appendChild(el('span', '', 'Королевство')); const rkv = el('span', 'v'); rk.appendChild(rkv); s1.appendChild(rk);
    slot(v, rkv, () => { const b = get(); const c = b && S.cities.get(b.cityId); const k = c && S.kingdoms.get(c.kingdomId); return k ? k.id + k.name + flagSig(k.flag) : '-'; }, (node) => { const b = get(); const c = b && S.cities.get(b.cityId); const k = c && S.kingdoms.get(c.kingdomId); if (k) node.appendChild(kingdomLink(k)); else node.appendChild(el('span', 'muted', 'нет')); });
    kvRow(v, s1, 'Координаты', () => { const b = get(); return b ? b.x + ', ' + b.y : '—'; });
    return v;
  }

  function cultureOf(id) { return S.cultures && S.cultures[id] ? S.cultures[id] : null; }
  function viewCity(id) {
    const c0 = S.cities.get(id);
    if (!c0) return null;
    const v = mkView();
    const get = () => S.cities.get(id);
    let last = { x: c0.x + 0.5, y: c0.y + 0.5 };
    v.hl = { type: 'city', id, x: c0.x, y: c0.y };
    v.focus = () => { const c = get(); if (c) last = { x: c.x + 0.5, y: c.y + 0.5 }; return last; };
    v.ava.appendChild(spriteEl(Sprites.building(Const.B.TOWNHALL, c0.race, Math.min(3, c0.level || 1), true), 32));
    v.ups.push(() => {
      const c = get();
      if (!c) { if (!v.finished) { v.finished = true; v.dead = true; setText(v.sub, 'Город пал'); } return; }
      setText(v.title, c.name);
      setText(v.sub, Names.cityWord(c.pop | 0) + ' · ' + rname(c.race) + ' · ур. ' + (c.level || 1));
    });
    const s1 = sec(v);
    const rk = el('div', 'kv'); rk.appendChild(el('span', '', 'Королевство')); const rkv = el('span', 'v'); rk.appendChild(rkv); s1.appendChild(rk);
    slot(v, rkv, () => { const c = get(); const k = c && S.kingdoms.get(c.kingdomId); return k ? k.id + k.name + flagSig(k.flag) : '-'; }, (node) => { const c = get(); const k = c && S.kingdoms.get(c.kingdomId); if (k) node.appendChild(kingdomLink(k)); else node.appendChild(el('span', 'muted', 'независимый')); });
    const rg = el('div', 'kv'); rg.appendChild(el('span', '', 'Регион')); const rgv = el('span', 'v'); rg.appendChild(rgv); s1.appendChild(rg);
    slot(v, rgv, () => { const c = get(); return c ? c.regionId + ':' + rName(c.regionId) + ':' + (c.occupierId || 0) : '-'; }, (node) => {
      const c = get();
      if (!c || !c.regionId || !regionOf(c.regionId)) { node.appendChild(el('span', 'muted', '—')); return; }
      node.appendChild(regionLink(c.regionId));
      if (c.occupierId) { const o = kget(c.occupierId); node.appendChild(el('span', 'chip bad', 'оккупирован' + (o ? ': ' + o.name : ''))); }
    });
    kvRow(v, s1, 'Население', () => { const c = get(); if (!c) return '—'; const cap = typeof Cities.housingCap === 'function' ? Cities.housingCap(id) : 0; return (c.pop | 0) + (cap ? ' / ' + cap + ' мест' : ''); });
    kvRow(v, s1, 'Культура', () => { const c = get(); const cu = c && cultureOf(c.culture); return cu ? cu.name : '—'; });
    kvRow(v, s1, 'Основан', () => { const c = get(); return c ? yearText(1 + Math.floor((c.founded | 0) / Const.TICKS_PER_YEAR)) : '—'; });
    const bars = sec(v); const bg = el('div', 'bars'); bars.appendChild(bg);
    barRow(v, bg, 'Лояльность', () => { const c = get(); return c ? c.loyalty / 100 : 0; }, () => { const c = get(); return c ? num(c.loyalty) + '%' : '—'; }, hpColor);
    const s2 = sec(v, 'Склад');
    const res = el('div', 'res'); s2.appendChild(res);
    Const.GOODS.forEach((g) => {
      const d = el('div'); d.appendChild(ico(g, 24)); const b = el('span', '', '0'); d.appendChild(b); d.title = GOOD_NAMES[g]; res.appendChild(d);
      v.ups.push(() => { const c = get(); setText(b, c && c.stock ? Math.floor(c.stock[g] || 0) : 0); });
    });
    const s3 = sec(v, 'Здания');
    const bl = el('div', 'chips'); s3.appendChild(bl);
    slot(v, bl, () => {
      const c = get(); if (!c) return 'x';
      let s = ''; const bs = Buildings.byCity(id);
      const cnt = {}; for (const b of bs) { const k = b.type + (b.done ? 'd' : 'u'); cnt[k] = (cnt[k] || 0) + 1; }
      for (const k in cnt) s += k + cnt[k] + ';';
      return s;
    }, (node) => {
      const bs = Buildings.byCity(id); const done = {}, site = {};
      for (const b of bs) { if (b.done) done[b.type] = (done[b.type] || 0) + 1; else site[b.type] = (site[b.type] || 0) + 1; }
      const types = new Set(Object.keys(done).concat(Object.keys(site)));
      types.forEach((t) => {
        const d = Buildings.defs[t]; if (!d) return;
        node.appendChild(el('span', 'chip', d.name + ' ×' + (done[t] || 0) + (site[t] ? ' (+' + site[t] + ')' : '')));
      });
      if (!types.size) node.appendChild(el('span', 'muted', 'Пока нет построек'));
    });
    const s4 = sec(v, 'История');
    histList(v, s4, () => { const c = get(); return c ? c.hist : null; });
    return v;
  }

  function relationsOf(kid) {
    try { const r = Diplomacy.relationsOf(kid); return Array.isArray(r) ? r : []; } catch (e) { return []; }
  }
  function warsOf(kid) {
    try { const r = War.warsOf(kid); if (Array.isArray(r)) return r; } catch (e) { /* ignore */ }
    return [];
  }
  function viewKingdom(id) {
    const k0 = S.kingdoms.get(id);
    if (!k0) return null;
    const v = mkView();
    const get = () => S.kingdoms.get(id);
    const capPos = () => { const k = get(); const c = k && (S.cities.get(k.capitalId) || S.cities.get(k.cities[0])); return c ? { x: c.x + 0.5, y: c.y + 0.5 } : null; };
    let last = capPos() || { x: S.w / 2, y: S.h / 2 };
    v.hl = { type: 'kingdom', id, x: Math.floor(last.x), y: Math.floor(last.y) };
    v.focus = () => { const p = capPos(); if (p) last = p; return last; };
    v.zoom = 7;
    const fl = flagEl(k0.flag, 32);
    v.ava.appendChild(fl); v.ava.style.width = '56px';
    v.ups.push(() => {
      const k = get();
      if (!k) { if (!v.finished) { v.finished = true; v.dead = true; setText(v.sub, 'Королевство пало'); } return; }
      drawFlag(fl, k.flag);
      setText(v.title, k.name);
      setText(v.sub, Names.title(k.race) + ' · ' + rname(k.race));
    });
    const s0 = sec(v);
    const cmdBtn = actBtn('block primary', 'Командовать', 'command', () => commandKingdom(id, {}));
    cmdBtn.dataset.act = 'command'; s0.appendChild(cmdBtn);
    v.ups.push(() => { const k = get(); cmdBtn.classList.toggle('hide', !k || cm.kid === id); });
    const s1 = sec(v);
    const rr = el('div', 'kv'); rr.appendChild(el('span', '', 'Правитель')); const rrv = el('span', 'v'); rr.appendChild(rrv); s1.appendChild(rr);
    slot(v, rrv, () => { const k = get(); const u = k && S.units.get(k.rulerId); return u ? u.id + u.name : '-'; }, (node) => {
      const k = get(); const u = k && S.units.get(k.rulerId);
      if (u) { const l = unitLink(u); node.appendChild(l); node.insertBefore(el('span', 'chip gold', Names.ruler(u.race, u.sex)), l); } else node.appendChild(el('span', 'muted', 'трон пуст'));
    });
    const rc = el('div', 'kv'); rc.appendChild(el('span', '', 'Столица')); const rcv = el('span', 'v'); rc.appendChild(rcv); s1.appendChild(rc);
    slot(v, rcv, () => { const k = get(); const c = k && S.cities.get(k.capitalId); return c ? c.id + c.name : '-'; }, (node) => { const k = get(); const c = k && S.cities.get(k.capitalId); if (c) node.appendChild(cityLink(c)); else node.appendChild(el('span', 'muted', '—')); });
    kvRow(v, s1, 'Население', () => { const k = get(); return k ? Kingdoms.pop(id) + ' жит.' : '—'; });
    if (typeof Kingdoms.strength === 'function') kvRow(v, s1, 'Сила', () => { const k = get(); if (!k) return '—'; const s = Kingdoms.strength(id); return s ? num(s) : '—'; });
    kvRow(v, s1, 'Культура', () => { const k = get(); const cu = k && cultureOf(k.culture); return cu ? cu.name : '—'; });
    kvRow(v, s1, 'Династия', () => { const k = get(); return k && k.clan ? k.clan : '—'; });
    kvRow(v, s1, 'Основано', () => { const k = get(); return k ? yearText(1 + Math.floor((k.born | 0) / Const.TICKS_PER_YEAR)) : '—'; });
    const bars = sec(v); const bg = el('div', 'bars'); bars.appendChild(bg);
    const stRow = barRow(v, bg, 'Стабильность', () => { const k = get(); return k ? k.stability / 100 : 0; }, () => { const k = get(); return k ? num(k.stability) + '%' : '—'; }, hpColor);
    const stWhy = el('div', 'causes hide'); bars.appendChild(stWhy);
    stRow.classList.add('tapc'); stRow.title = 'Тап: из чего складывается стабильность';
    let stSig = '';
    const fillWhy = () => {
      const list = safe(() => Kingdoms.explainStability(id), []);
      const sg = list.map((c) => c.why + c.v).join('|');
      if (sg === stSig) return;
      stSig = sg; clear(stWhy);
      list.filter((c) => Math.abs(c.v) >= 0.5).forEach((c) => { const l = el('div', 'cz'); l.appendChild(el('b', c.v < 0 ? 'neg' : 'pos', fmtV(c.v))); l.appendChild(el('span', '', c.why)); stWhy.appendChild(l); });
      if (!stWhy.children.length) stWhy.appendChild(el('div', 'muted', 'Всё спокойно'));
    };
    stRow.addEventListener('click', () => { stWhy.classList.toggle('hide'); fillWhy(); });
    v.ups.push(() => { if (!stWhy.classList.contains('hide')) fillWhy(); });
    barRow(v, bg, 'Дурная слава', () => { const k = get(); return k ? (k.infamy || 0) / 100 : 0; }, () => { const k = get(); return k ? num(k.infamy || 0) + '%' : '—'; }, (f) => hpColor(1 - f));
    const s1b = sec(v);
    kvRow(v, s1b, 'Регионов', () => { const k = get(); if (!k) return '—'; const st = kStats(id); return st.regions + (st.held ? ' (+' + st.held + ' занято)' : '') + (st.lost ? ' · оккупировано ' + st.lost : ''); });
    const ov = el('div', 'kv'); ov.appendChild(el('span', '', 'Сюзерен')); const ovv = el('span', 'v'); ov.appendChild(ovv); s1b.appendChild(ov);
    slot(v, ovv, () => { const k = get(); const o = k && k.overlordId ? kget(k.overlordId) : null; return o ? o.id + o.name : '-'; }, (node) => {
      const k = get(); const o = k && k.overlordId ? kget(k.overlordId) : null;
      if (o) node.appendChild(kingdomLink(o)); else node.appendChild(el('span', 'muted', 'независимо'));
    });
    const vs = el('div', 'kv'); vs.appendChild(el('span', '', 'Вассалы')); const vsv = el('span', 'v'); vs.appendChild(vsv); s1b.appendChild(vs);
    slot(v, vsv, () => safe(() => Kingdoms.vassalsOf(id), []).join(','), (node) => {
      const list = safe(() => Kingdoms.vassalsOf(id), []).map(kget).filter(Boolean);
      list.forEach((o) => node.appendChild(kingdomLink(o)));
      if (!list.length) node.appendChild(el('span', 'muted', 'нет'));
    });

    const s2 = sec(v, 'Города');
    const cl = el('div', 'chips'); s2.appendChild(cl);
    slot(v, cl, () => { const k = get(); return k ? k.cities.map((cid) => { const c = S.cities.get(cid); return cid + ':' + (c ? c.name + (c.pop | 0) : ''); }).join(',') : 'x'; }, (node) => {
      const k = get(); if (!k) return;
      k.cities.forEach((cid) => { const c = S.cities.get(cid); if (c) node.appendChild(cityLink(c)); });
      if (!node.children.length) node.appendChild(el('span', 'muted', '—'));
    });

    const s3 = sec(v, 'Отношения');
    const rl = el('div'); s3.appendChild(rl);
    const relBars = [];
    slot(v, rl, () => {
      const k = get(); if (!k) return 'x';
      return relationsOf(id).map((r) => r.other + ':' + r.state + (r.truce ? 't' : '')).join(',') + '|' + warsOf(id).map((w) => w.id).join(',');
    }, (node) => {
      relBars.length = 0;
      const rels = relationsOf(id).filter((r) => S.kingdoms.has(r.other));
      rels.sort((a, b) => (b.state === 2) - (a.state === 2) || b.opinion - a.opinion);
      if (!rels.length) { node.appendChild(el('div', 'muted', 'Нет контактов с другими королевствами')); return; }
      rels.forEach((r) => {
        const ok = S.kingdoms.get(r.other);
        const wrap = el('div', 'relwrap');
        const row = el('div', 'relrow');
        row.appendChild(kingdomLink(ok));
        const bar = el('div', 'bar mid tapc'); const tr = el('div', 'track'); const fill = el('div', 'fill'); const tx = el('div', 'txt');
        tr.appendChild(fill); tr.appendChild(tx); bar.appendChild(tr); row.appendChild(bar);
        bar.title = 'Тап: почему такие отношения';
        const st = el('span', 'rs');
        if (r.state === Const.REL.WAR) { st.appendChild(ico('sword', 16)); st.title = 'Война'; }
        else if (r.state === Const.REL.ALLIANCE) { st.appendChild(ico('heart', 16)); st.title = 'Союз'; }
        else if (r.truce) { st.appendChild(ico('peace', 16)); st.title = 'Перемирие'; }
        row.appendChild(st);
        wrap.appendChild(row);
        const cz = causesBox(); wrap.appendChild(cz.node);
        bar.addEventListener('click', () => { cz.toggle(); cz.set(id, r.other); });
        node.appendChild(wrap);
        relBars.push({ other: r.other, fill, tx, cz });
      });
    });
    v.ups.push(() => {
      if (!relBars.length) return;
      const map = {};
      relationsOf(id).forEach((r) => { map[r.other] = r; });
      relBars.forEach((b) => {
        const r = map[b.other]; if (!r) return;
        const o = Util.clamp(r.opinion | 0, -100, 100);
        setStyle(b.fill, 'left', o < 0 ? (50 + o / 2) + '%' : '50%');
        setStyle(b.fill, 'width', Math.abs(o) / 2 + '%');
        setStyle(b.fill, 'backgroundColor', opinionColor(o));
        setText(b.tx, (o > 0 ? '+' : '') + o);
        if (b.cz.open) b.cz.set(id, b.other);
      });
    });
    const s4 = sec(v, 'Войны');
    const wl = el('div', 'wl-insp'); s4.appendChild(wl);
    slot(v, wl, () => warsOf(id).map((w) => w.id + ':' + Math.round(warScore(w.id, id) / 5) + ':' + w.goals.length).join(','), (node) => {
      const ws = warsOf(id);
      ws.forEach((w) => {
        const enemies = warEnemies(w, id);
        const names = enemies.map((e) => { const kk = S.kingdoms.get(e); return kk ? kk.name : null; }).filter(Boolean);
        const lead = enemyLeadOf(w, id);
        const row = el('div', 'wirow');
        const ek = kget(lead);
        row.appendChild(ek ? kingdomLink(ek) : el('span', '', '—'));
        const ms = Math.round(warScore(w.id, id)), es = ek ? Math.round(warScore(w.id, ek.id)) : 0;
        row.appendChild(el('span', 'chip ' + (ms >= es ? 'good' : 'bad'), 'очки ' + ms + ' : ' + es));
        if (names.length > 1) row.appendChild(el('span', 'chip', '+' + (names.length - 1) + ' союзн.'));
        const goals = w.goals.filter((g) => g.kid === id);
        if (goals.length) row.appendChild(el('span', 'chip gold', 'цели: ' + goals.map((g) => rName(g.regionId) + (g.done ? ' ✓' : '')).join(', ')));
        node.appendChild(row);
      });
      if (!ws.length) node.appendChild(el('span', 'muted', 'Мирное время'));
    });
    const s5 = sec(v, 'История');
    histList(v, s5, () => { const k = get(); return k ? k.hist : null; });
    return v;
  }

  function regionLink(rid) {
    const r = regionOf(rid);
    return linkBtn('region', rid, el('span', '', r ? r.name : '?'), ico('region', 16));
  }
  const TERRAIN_LABEL = { forest: 'Лес', hill: 'Холмы', mountain: 'Горы', sand: 'Песок', snow: 'Снег' };
  function viewRegion(id) {
    const r0 = regionOf(id);
    if (!r0) return null;
    const v = mkView();
    const get = () => regionOf(id);
    let last = { x: r0.cx + 0.5, y: r0.cy + 0.5 };
    v.regionHL = id;
    v.zoom = 8;
    v.focus = () => { const c = safe(() => Render.regionCenter(id), null); if (c) last = c; else { const r = get(); if (r) last = { x: r.cx + 0.5, y: r.cy + 0.5 }; } return last; };
    v.ava.appendChild(ico('region', 32));
    v.ups.push(() => {
      const r = get();
      if (!r) { if (!v.finished) { v.finished = true; v.dead = true; setText(v.sub, 'Регион исчез'); } return; }
      setText(v.title, r.name);
      setText(v.sub, 'Регион · ' + r.tiles + ' клеток');
    });
    const s1 = sec(v);
    const ro = el('div', 'kv'); ro.appendChild(el('span', '', 'Владелец')); const rov = el('span', 'v'); ro.appendChild(rov); s1.appendChild(ro);
    slot(v, rov, () => { const r = get(); const k = r && r.ownerId ? kget(r.ownerId) : null; return k ? k.id + k.name + flagSig(k.flag) : '-'; }, (node) => {
      const r = get(); const k = r && r.ownerId ? kget(r.ownerId) : null;
      if (k) node.appendChild(kingdomLink(k)); else node.appendChild(el('span', 'muted', 'ничья земля'));
    });
    const rc = el('div', 'kv'); rc.appendChild(el('span', '', 'Контроль')); const rcv = el('span', 'v'); rc.appendChild(rcv); s1.appendChild(rc);
    slot(v, rcv, () => { const r = get(); if (!r) return 'x'; const k = r.controllerId ? kget(r.controllerId) : null; return r.controllerId + ':' + r.ownerId + (k ? k.name + flagSig(k.flag) : ''); }, (node) => {
      const r = get(); if (!r) return;
      const k = r.controllerId ? kget(r.controllerId) : null;
      if (!r.ownerId) { node.appendChild(el('span', 'muted', 'никто')); return; }
      if (k) node.appendChild(kingdomLink(k));
      if (r.controllerId && r.controllerId !== r.ownerId) node.appendChild(el('span', 'chip bad', 'оккупация'));
      else if (k) node.appendChild(el('span', 'chip good', 'своя земля'));
    });
    kvRow(v, s1, 'Ценность', () => { const r = get(); return r ? String(Math.round(r.value * 10) / 10) : '—'; });
    kvRow(v, s1, 'Владеет с', () => { const r = get(); return r && r.ownerId ? yearText(1 + Math.floor((r.since | 0) / Const.TICKS_PER_YEAR)) : '—'; });
    const s2 = sec(v, 'Рельеф');
    const tc = el('div', 'chips'); s2.appendChild(tc);
    slot(v, tc, () => { const r = get(); return r && r.terrain ? Object.keys(TERRAIN_LABEL).map((k) => Math.round((r.terrain[k] || 0) * 100)).join(',') : 'x'; }, (node) => {
      const r = get(); if (!r || !r.terrain) return;
      const arr = Object.keys(TERRAIN_LABEL).map((k) => ({ k, f: r.terrain[k] || 0 })).filter((o) => o.f >= 0.08).sort((a, b) => b.f - a.f);
      arr.forEach((o) => node.appendChild(el('span', 'chip', TERRAIN_LABEL[o.k] + ' ' + Math.round(o.f * 100) + '%')));
      if (!arr.length) node.appendChild(el('span', 'chip', 'Равнина'));
    });
    const s3 = sec(v, 'Города');
    const cl = el('div', 'chips'); s3.appendChild(cl);
    slot(v, cl, () => { const r = get(); return r ? r.cityIds.join(',') + ':' + r.cityIds.map((c) => (S.cities.get(c) || {}).name).join(',') : 'x'; }, (node) => {
      const r = get(); if (!r) return;
      r.cityIds.forEach((cid) => { const c = S.cities.get(cid); if (c) node.appendChild(cityLink(c)); });
      if (!node.children.length) node.appendChild(el('span', 'muted', 'Городов нет'));
    });
    const s4 = sec(v, 'Притязания');
    const cc = el('div', 'chips'); s4.appendChild(cc);
    slot(v, cc, () => { const r = get(); return r ? (r.claims || []).join(',') : 'x'; }, (node) => {
      const r = get(); if (!r) return;
      (r.claims || []).forEach((kid) => { const k = kget(kid); if (k) node.appendChild(kingdomLink(k)); });
      if (!node.children.length) node.appendChild(el('span', 'muted', 'Притязаний нет'));
    });
    const s5 = sec(v, 'Соседи');
    const nl = el('div', 'chips'); s5.appendChild(nl);
    slot(v, nl, () => { const r = get(); return r ? r.nb.map((n) => { const q = regionOf(n); return n + ':' + (q ? q.ownerId : 0); }).join(',') : 'x'; }, (node) => {
      const r = get(); if (!r) return;
      r.nb.forEach((nid) => {
        const q = regionOf(nid); if (!q) return;
        const k = q.ownerId ? kget(q.ownerId) : null;
        const b = linkBtn('region', nid, el('span', '', q.name), k ? flagEl(k.flag, 16) : ico('region', 16));
        node.appendChild(b);
      });
      if (!node.children.length) node.appendChild(el('span', 'muted', '—'));
    });
    const s6 = sec(v);
    const cmdBtn = actBtn('block primary', 'Командовать владельцем', 'command', () => { const r = get(); if (r && r.ownerId) commandKingdom(r.ownerId, {}); });
    cmdBtn.dataset.act = 'cmd-owner';
    s6.appendChild(cmdBtn);
    v.ups.push(() => { const r = get(); cmdBtn.classList.toggle('hide', !r || !r.ownerId || r.ownerId === cm.kid || !kget(r.ownerId)); });
    return v;
  }

  function viewTile(idx) {
    const x = idx % S.w, y = (idx / S.w) | 0;
    if (!S.inBounds(x, y)) return null;
    const v = mkView();
    v.hl = { type: 'tile', id: idx, x, y };
    v.focus = () => ({ x: x + 0.5, y: y + 0.5 });
    const t0 = S.tile[idx];
    v.ava.appendChild(tileEl(t0, x, y, 32));
    v.ups.push(() => {
      const t = S.tile[idx];
      setText(v.title, Tiles.defs[t] ? Tiles.defs[t].name : '?');
      setText(v.sub, 'Клетка ' + x + ', ' + y);
    });
    const s1 = sec(v);
    kvRow(v, s1, 'Высота', () => S.elev[idx] + ' / 255');
    kvRow(v, s1, 'Ресурс', () => {
      const r = World.resAt(x, y);
      if (!r || !r.kind) return 'нет';
      const t = S.tile[idx];
      return (RES_NAMES[r.kind] || '?') + (r.amt ? ' · ' + r.amt : t === Const.T.FOREST ? '' : '');
    });
    kvRow(v, s1, 'Огонь', () => (S.fire[idx] ? 'горит' : 'нет'));
    const ro = el('div', 'kv'); ro.appendChild(el('span', '', 'Владелец')); const rov = el('span', 'v'); ro.appendChild(rov); s1.appendChild(ro);
    slot(v, rov, () => S.owner[idx] + ':' + (S.cities.get(S.owner[idx]) ? S.cities.get(S.owner[idx]).kingdomId : 0), (node) => {
      const c = S.cities.get(S.owner[idx]);
      if (!c) { node.appendChild(el('span', 'muted', 'ничья земля')); return; }
      node.appendChild(cityLink(c));
      const k = S.kingdoms.get(c.kingdomId); if (k) node.appendChild(kingdomLink(k));
    });
    return v;
  }

  // ------------------------------------------------------------------ inspector: open / close / refresh
  function buildView(type, id) {
    switch (type) {
      case 'unit': return viewUnit(id);
      case 'building': return viewBuilding(id);
      case 'city': return viewCity(id);
      case 'kingdom': return viewKingdom(id);
      case 'tile': return viewTile(id);
      case 'region': return viewRegion(id);
    }
    return null;
  }
  /** opts: {push: keep previous view for the back button, focus: glide the camera to the object} */
  function openInspector(type, id, opts) {
    opts = opts || {};
    if (!ready) return false;
    let v = null;
    try { v = buildView(type, id); } catch (e) { console.error('inspector', e); v = null; }
    if (!v) { toast('Объект больше недоступен', 'bad'); return false; }
    const stack = insp ? insp.stack : [];
    if (opts.push && insp && !(insp.type === type && insp.id === id)) { stack.push({ type: insp.type, id: insp.id }); if (stack.length > 10) stack.shift(); }
    else if (!opts.push) stack.length = 0;
    insp = { type, id, view: v, stack };
    renderSheet();
    runUpdaters(v);
    applyInspHL(v);
    refs.bottom.classList.add('sheet-open');
    layoutSoon();
    const f = v.focus ? v.focus() : null;
    if (f) {
      if (opts.focus) requestAnimationFrame(() => focusVisible(f.x, f.y, Math.max(Render.cam.zoom, v.zoom || 12)));
      else requestAnimationFrame(() => ensureVisible(f.x, f.y));
    }
    return true;
  }
  function goBack() {
    if (!insp) return;
    const p = insp.stack.pop();
    if (!p) return;
    let w = null;
    try { w = buildView(p.type, p.id); } catch (e) { w = null; }
    if (!w) { if (insp.stack.length) goBack(); else closeInspector(); return; }
    insp = { type: p.type, id: p.id, view: w, stack: insp.stack };
    renderSheet();
    runUpdaters(w);
    applyInspHL(w);
    const f = w.focus ? w.focus() : null;
    if (f) requestAnimationFrame(() => ensureVisible(f.x, f.y));
  }
  function applyInspHL(v) {
    Render.highlight = v.hl ? Object.assign({}, v.hl) : null;
    setRegionHL(v.regionHL || 0, 0);
  }
  function renderSheet() {
    const sh = refs.sheet;
    clear(sh);
    sh.classList.remove('cmd', 'gm', 'pm', 'am');
    document.body.classList.remove('cmd-pick');
    sh.style.animation = 'none'; void sh.offsetWidth; sh.style.animation = '';
    const v = insp.view;
    const head = el('div', 'sh-head');
    if (insp.stack.length) {
      const b = btn('sh-btn back', 'Назад', goBack);
      b.textContent = '‹';
      head.appendChild(b);
    }
    head.appendChild(v.ava);
    const tt = el('div', 'sh-title'); tt.appendChild(v.title); tt.appendChild(v.sub); head.appendChild(tt);
    const fb = btn('sh-btn primary', 'Показать на карте', () => {
      const f = v.focus ? v.focus() : null;
      if (f) focusVisible(f.x, f.y, Math.max(Render.cam.zoom, v.zoom || 12));
      if (v.hl) Render.highlight = Object.assign({}, v.hl);
    });
    fb.title = 'Показать на карте';
    fb.appendChild(ico('focus', 24));
    fb.appendChild(el('span', 't', 'На карте'));
    head.appendChild(fb);
    const cb = btn('sh-btn', 'Закрыть', () => closeInspector());
    cb.appendChild(ico('close', 24));
    head.appendChild(cb);
    sh.appendChild(head);
    const body = el('div', 'sh-body');
    body.appendChild(v.body);
    sh.appendChild(body);
    refs.sheetBody = body;
  }
  function runUpdaters(v) {
    for (let i = 0; i < v.ups.length; i++) {
      try { v.ups[i](); } catch (e) { if (!v.warned) { v.warned = true; console.error('inspector update', e); } }
    }
    if (refs.sheetBody) refs.sheetBody.classList.toggle('dead', !!v.dead);
    if (v.finished && Render.highlight && v.hl && Render.highlight.id === v.hl.id && Render.highlight.type === v.hl.type && v.hl.type === 'unit') Render.highlight = null;
  }
  function updateInspector() {
    if (!insp) return;
    if (!insp.view.finished || insp._fin !== true) {
      runUpdaters(insp.view);
      if (insp.view.finished) insp._fin = true;
    }
  }
  function closeInspector() {
    if (!insp) return;
    insp = null;
    Render.highlight = null;
    refs.sheetBody = null;
    setRegionHL(0, 0);
    if (cm.kid) { showCmdSheet(); return; }          // the command sheet underneath comes back
    refs.bottom.classList.remove('sheet-open');
    refs.sheet.classList.remove('cmd', 'gm', 'pm', 'am');
    clear(refs.sheet);
    sheetFresh = true;
    layoutSoon();
  }
  function inspectAt(tx, ty, explicit) {
    const p = Powers.pick(tx, ty);
    if (!p) { return; }
    if (p.type === 'tile' && !explicit) { closeInspector(); return; }
    if (p.type === 'region' && !explicit && insp) { closeInspector(); return; }      // a tap on bare land dismisses an open card
    openInspector(p.type, p.id);
  }

  // ------------------------------------------------------------------ camera helpers shared with Main
  /** the part of the screen not covered by the top bar / dock / sheet (css px) */
  function bandInfo() {
    const sz = Render.size;
    const top = refs.top ? refs.top.getBoundingClientRect().bottom : 0;
    let bot = sz.h, left = 0, right = sz.w;
    if (refs.bottom) {
      if (refs.bottom.classList.contains('sheet-open')) {
        const r = refs.sheet.getBoundingClientRect();
        if (r.width < sz.w * 0.9 && r.left > sz.w * 0.3) right = r.left;     // landscape: side panel
        else bot = r.top;
      } else bot = sz.h - refs.bottom.getBoundingClientRect().height;
    }
    return { w: sz.w, h: sz.h, top: top + 8, bot: Math.max(top + 60, bot - 8), left, right: Math.max(left + 120, right - 8) };
  }
  /** glide so that tile (x,y) sits in the middle of the area not covered by the top bar / dock / sheet */
  function focusVisible(x, y, zoom, instant) {
    const bi = bandInfo();
    const z = zoom > 0 ? Util.clamp(zoom, Render.minZoom(), Render.maxZoom()) : Render.cam.zoom;
    const cx = (bi.left + bi.right) / 2, cy = (bi.top + bi.bot) / 2;
    Render.focusOn(x - (cx - bi.w / 2) / z, y - (cy - bi.h / 2) / z, z, instant);
  }
  function ensureVisible(x, y) {
    const bi = bandInfo();
    const p = Render.tileToScreen(x, y);
    const m = 36;
    if (p.x > bi.left + m && p.x < bi.right - m && p.y > bi.top + m && p.y < bi.bot - m) return;
    focusVisible(x, y, Render.cam.zoom);
  }

  // ------------------------------------------------------------------ layout bookkeeping
  let layoutQueued = false;
  function layoutSoon() { if (layoutQueued) return; layoutQueued = true; requestAnimationFrame(() => { layoutQueued = false; layout(); }); }
  function layout() {
    if (!ready) return;
    const top = refs.top.getBoundingClientRect().bottom;
    const bh = refs.bottom.getBoundingClientRect().height;
    const bi = bandInfo();
    Render.pad.t = Math.round(top);
    Render.pad.b = Math.round(bh);
    Render.pad.r = Math.round(Math.max(0, bi.w - bi.right - 8));
    document.documentElement.style.setProperty('--top-h', Math.round(top) + 'px');
    document.documentElement.style.setProperty('--bot-h', Math.round(bh) + 'px');
    updateToolsHint();
  }

  // ------------------------------------------------------------------ input callbacks
  function applyTool(tool, tx, ty, phase) {
    const def = ToolDefs.byId[tool];
    if (!def) return false;
    const r = def.brush ? state.brush : 1;
    let ok = false;
    try { ok = Powers.apply(tool, tx, ty, r, phase); } catch (e) { console.error('Powers.apply', e); }
    if (!ok && phase !== 'end') {
      const m = Powers.lastMessage;
      if (m) toast(m, 'bad');
    }
    if (def.brush && phase !== 'end') { Render.brush = { x: tx, y: ty, r }; clearTimeout(brushTimer); brushTimer = setTimeout(() => { if (!Input.painting) Render.brush = null; }, 650); }
    return ok;
  }
  function handleTap(tx, ty) {
    if (!ready || modalOpen()) return;
    const tool = state.tool;
    if (cm.kid || tool === 'command') { cmdTap(tx, ty); return; }
    if (!tool || tool === 'inspect') { inspectAt(tx, ty, tool === 'inspect'); return; }
    if (insp) closeInspector();                        // the dock (with the active tool) comes back
    applyTool(tool, tx, ty, 'tap');
  }
  function handlePaint(tx, ty, phase) {
    if (!ready || modalOpen()) return;
    const tool = state.tool;
    if (cm.kid || tool === 'command') { cmdPaint(tx, ty, phase); return; }
    if (!tool || tool === 'inspect') { if (phase === 'start') inspectAt(tx, ty, tool === 'inspect'); return; }
    if (insp) closeInspector();
    applyTool(tool, tx, ty, phase);
    if (phase === 'end') { clearTimeout(brushTimer); brushTimer = setTimeout(() => { Render.brush = null; }, 350); }
  }

  // ==================================================================================================================
  // STAGE 2 — command mode (HOI4-style): commanded-kingdom sheet (Война | Армии | Регионы), goal picking on the map,
  // army orders, peace conference, region highlights / popups.  All Render coupling goes through Render.cmd.
  // ==================================================================================================================
  const ORD_LABEL = { attack: 'Атака', hold: 'Удерживает', defend: 'Оборона', retreat: 'Отход' };
  const MODE_LABEL = { gather: 'Сбор', march: 'В походе', siege: 'Осада', hold: 'На позиции', retreat: 'Отступает' };
  const NONE = Object.freeze([]);
  const cm = { kid: 0, page: 'war', goal: null, peace: null, armyId: 0, selRegion: 0, tkid: 0, pop: null, view: null, mapPrev: -1, rc: null, targets: NONE, tgSig: '', tick: 0 };
  const rhl = { rid: 0, timer: 0 };               // transient region highlight (log focus / inspector)
  let tmpCmd = null, sheetFresh = true;

  // ---- tolerant wrappers (stubs / dead ids never break the UI)
  function safe(fn, dflt) { try { const r = fn(); return r === undefined || r === null ? dflt : r; } catch (e) { return dflt; } }
  const kget = (kid) => { const k = S.kingdoms.get(kid); return k && k.alive !== false ? k : null; };
  const regionOf = (rid) => (S.regions ? S.regions.get(rid) || null : null);
  const rName = (rid) => { const r = regionOf(rid); return r ? r.name : '?'; };
  const regionsOn = () => !!(S.regions && S.regions.size > 0 && S.region);
  const strengthOf = (kid) => safe(() => Kingdoms.strength(kid), 0) || 0;
  const regionCostOf = (rid) => safe(() => War.regionCost(rid), 0) || 0;
  const armiesOfK = (kid) => safe(() => War.armiesOf(kid), []);
  const warScore = (wid, kid) => safe(() => War.score(wid, kid), 0) || 0;
  function wside(w, kid) { return w.attackers.indexOf(kid) >= 0 ? 1 : w.defenders.indexOf(kid) >= 0 ? 2 : 0; }
  function warEnemies(w, kid) { const s = wside(w, kid); return s === 1 ? w.defenders : s === 2 ? w.attackers : NONE; }
  function warLead(w, side) {
    const p = side === 1 ? w.aggressor : w.defender, arr = side === 1 ? w.attackers : w.defenders;
    if (arr.indexOf(p) >= 0 && kget(p)) return p;
    for (let i = 0; i < arr.length; i++) if (kget(arr[i])) return arr[i];
    return 0;
  }
  function enemyLeadOf(w, kid) { const s = wside(w, kid); return s ? warLead(w, 3 - s) : 0; }
  function kStats(kid) {
    const o = { regions: 0, held: 0, lost: 0, cities: 0, pop: 0 };
    if (!regionsOn()) return o;
    for (const r of S.regions.values()) {
      if (r.ownerId === kid) { o.regions++; if (r.controllerId && r.controllerId !== kid) o.lost++; }
      else if (r.controllerId === kid && r.ownerId) o.held++;
    }
    const k = S.kingdoms.get(kid);
    if (k) { o.cities = k.cities.length; o.pop = safe(() => Kingdoms.pop(kid), 0); }
    return o;
  }
  function ratioInfo(kid, other) {
    const mine = Math.max(1, strengthOf(kid)), theirs = strengthOf(other);
    const r = theirs / mine;
    const cls = r <= 0.75 ? 'good' : r >= 1.35 ? 'bad' : 'warn';
    return { r, cls, text: 'Сила ×' + (r < 10 ? r.toFixed(1) : Math.round(r)) + (cls === 'good' ? ' · слабее' : cls === 'bad' ? ' · сильнее' : ' · равны') };
  }
  function fmtYears(ticks) { const y = Math.round(ticks / Const.TICKS_PER_YEAR * 10) / 10; return y + ' г.'; }
  function fmtV(v) { const a = Math.abs(v); const s = a < 10 ? String(Math.round(a * 10) / 10) : String(Math.round(a)); return (v < 0 ? '−' : '+') + s; }
  function supplyColor(s) { return s < 30 ? '#ff5b5b' : s < 60 ? '#ffc83d' : '#58e08a'; }

  // ---- Render.cmd bridge
  function rcMake(kid) { return { kid: kid | 0, regionId: 0, armyId: 0, goals: NONE, candidates: NONE, targetKid: 0 }; }
  function rcSync() {
    if (!cm.kid) return;
    const rc = cm.rc || (cm.rc = rcMake(cm.kid));
    rc.kid = cm.kid; rc.armyId = cm.armyId | 0;
    rc.regionId = cm.selRegion || rhl.rid || 0;
    if (cm.goal) { rc.goals = cm.goal.goals; rc.candidates = cm.goal.cand; rc.targetKid = cm.goal.targetKid; }
    else if (cm.peace) { rc.goals = cm.peace.picks; rc.candidates = cm.peace.cand; rc.targetKid = cm.peace.enemy; }
    else { rc.goals = NONE; rc.candidates = cm.armyId ? cm.targets : NONE; rc.targetKid = cm.tkid | 0; }
    Render.cmd = rc;
  }
  function applyRegionHL() {
    if (cm.kid) { rcSync(); return; }
    if (rhl.rid) { if (!tmpCmd) tmpCmd = rcMake(0); tmpCmd.regionId = rhl.rid; Render.cmd = tmpCmd; }
    else { if (tmpCmd && Render.cmd === tmpCmd) Render.cmd = null; tmpCmd = null; }
  }
  /** pulsing outline of a region (ms = 0: until cleared) */
  function setRegionHL(rid, ms) {
    clearTimeout(rhl.timer);
    rhl.rid = rid | 0;
    applyRegionHL();
    if (rhl.rid && ms) rhl.timer = setTimeout(() => { rhl.rid = 0; applyRegionHL(); }, ms);
  }

  // ---- camera helpers
  function fitRegions(rids, minZ, maxZ) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
    for (let i = 0; i < rids.length; i++) {
      const r = regionOf(rids[i]); if (!r) continue;
      const bb = safe(() => Regions.bbox(rids[i]), null);
      if (bb) { x0 = Math.min(x0, bb.x0); y0 = Math.min(y0, bb.y0); x1 = Math.max(x1, bb.x1 + 1); y1 = Math.max(y1, bb.y1 + 1); }
      else { const rad = Math.sqrt(r.tiles || 60) * 0.55; x0 = Math.min(x0, r.cx - rad); y0 = Math.min(y0, r.cy - rad); x1 = Math.max(x1, r.cx + rad); y1 = Math.max(y1, r.cy + rad); }
      n++;
    }
    if (!n) return false;
    const bi = bandInfo();
    const w = Math.max(6, x1 - x0 + 3), h = Math.max(6, y1 - y0 + 3);
    const z = Util.clamp(Math.min((bi.right - bi.left) / w, (bi.bot - bi.top) / h), minZ || 5, maxZ || 12);
    focusVisible((x0 + x1) / 2, (y0 + y1) / 2, z);
    return true;
  }
  function focusKingdom(kid) {
    const k = kget(kid); if (!k) return;
    const ids = [];
    if (regionsOn()) for (const r of S.regions.values()) if (r.ownerId === kid) ids.push(r.id);
    if (ids.length && fitRegions(ids, 6, 11)) return;
    const c = S.cities.get(k.capitalId) || S.cities.get(k.cities[0]);
    if (c) focusVisible(c.x + 0.5, c.y + 0.5, Math.max(Render.cam.zoom, 8));
  }
  function focusRegion(rid, zoom) {
    const c = safe(() => Render.regionCenter(rid), null);
    if (c) focusVisible(c.x, c.y, Math.max(Render.cam.zoom, zoom || 8));
  }

  // ---- reusable bits
  function miniBar(label, cls) {
    const row = el('div', 'bar sm' + (cls ? ' ' + cls : ''));
    const lb = el('label', '', label); row.appendChild(lb);
    const tr = el('div', 'track'), fill = el('div', 'fill'), tx = el('div', 'txt');
    tr.appendChild(fill); tr.appendChild(tx); row.appendChild(tr);
    return { node: row, label: lb, set(f, text, color) { setStyle(fill, 'transform', 'scaleX(' + (Math.round(Util.clamp(f, 0, 1) * 1000) / 1000) + ')'); if (color) setStyle(fill, 'backgroundColor', color); setText(tx, text); } };
  }
  function opinionBar() {
    const bar = el('div', 'bar mid'); const tr = el('div', 'track'), fill = el('div', 'fill'), tx = el('div', 'txt');
    tr.appendChild(fill); tr.appendChild(tx); bar.appendChild(tr);
    return { node: bar, set(o) { o = Util.clamp(o | 0, -100, 100); setStyle(fill, 'left', o < 0 ? (50 + o / 2) + '%' : '50%'); setStyle(fill, 'width', Math.abs(o) / 2 + '%'); setStyle(fill, 'backgroundColor', opinionColor(o)); setText(tx, (o > 0 ? '+' : '') + o); } };
  }
  /** opinion breakdown (Diplomacy causes) as small lines; set(a,b) refreshes only when something changed */
  function causesBox() {
    const box = el('div', 'causes hide');
    let sig = '';
    return {
      node: box,
      toggle() { box.classList.toggle('hide'); return !box.classList.contains('hide'); },
      get open() { return !box.classList.contains('hide'); },
      set(a, b) {
        const list = safe(() => Diplomacy.causes(a, b), []);
        const s = list.map((c) => c.why + c.v).join('|');
        if (s === sig) return;
        sig = s; clear(box);
        const lines = list.filter((c) => Math.abs(c.v) >= 0.5).sort((x, y) => Math.abs(y.v) - Math.abs(x.v)).slice(0, 9);
        lines.forEach((c) => { const l = el('div', 'cz'); l.appendChild(el('b', c.v < 0 ? 'neg' : 'pos', fmtV(c.v))); l.appendChild(el('span', '', c.why)); box.appendChild(l); });
        if (!lines.length) box.appendChild(el('div', 'muted', 'Причин для отношений пока нет'));
      },
    };
  }
  /** keyed list: rows are rebuilt only when their signature changes (taps never hit a freshly replaced node), values update in place */
  function listSlot(ups, parent, get, keyOf, sigOf, build, emptyText) {
    const rows = new Map();
    let ph = null;
    ups.push(() => {
      const items = get();
      const seen = new Set();
      if (!items.length) {
        if (!ph && emptyText) { ph = el('div', 'muted', emptyText); parent.appendChild(ph); }
      } else if (ph) { if (ph.parentNode) ph.parentNode.removeChild(ph); ph = null; }
      let prev = null;
      for (let i = 0; i < items.length; i++) {
        const it = items[i], key = keyOf(it), sig = sigOf(it);
        seen.add(key);
        let row = rows.get(key);
        if (!row || row.sig !== sig) {
          const nr = build(it);
          nr.sig = sig;
          if (row && row.node.parentNode === parent) parent.replaceChild(nr.node, row.node);
          row = nr; rows.set(key, row);
        }
        if (row.upd) row.upd(it);
        const want = prev ? prev.nextSibling : parent.firstChild;
        if (row.node.parentNode !== parent || want !== row.node) parent.insertBefore(row.node, want);
        prev = row.node;
      }
      for (const [k, row] of rows) if (!seen.has(k)) { if (row.node.parentNode) row.node.parentNode.removeChild(row.node); rows.delete(k); }
    });
  }
  function chipEl(text, cls, icon) {
    const c = el('span', 'chip' + (cls ? ' ' + cls : ''));
    if (icon) c.appendChild(ico(icon, 16));
    c.appendChild(document.createTextNode(text));
    return c;
  }
  function actBtn(cls, label, icon, fn) {
    const b = btn('cbtn' + (cls ? ' ' + cls : ''), label, fn);
    if (icon) { const ic = ico(icon.replace('~', ''), 16); if (icon.charAt(0) === '~') ic.style.transform = 'rotate(180deg)'; b.appendChild(ic); }
    b.appendChild(el('span', '', label));
    return b;
  }

  // ---- popups next to a tapped region
  function dismissPop() {
    if (!cm.pop) return;
    const rid = cm.pop.rid;
    if (cm.pop.node.parentNode) cm.pop.node.parentNode.removeChild(cm.pop.node);
    cm.pop = null;
    if (cm.selRegion === rid) { cm.selRegion = 0; rcSync(); }
  }
  function showPop(rid, title, sub, kid, buttons) {
    dismissPop();
    const host = refs.pops; if (!host) return;
    const node = el('div', 'cpop');
    const hd = el('div', 'cp-head');
    const k = kid ? kget(kid) : null;
    if (k) hd.appendChild(flagEl(k.flag, 24));
    const tx = el('div', 'cp-t'); tx.appendChild(el('b', '', title)); tx.appendChild(el('small', '', sub)); hd.appendChild(tx);
    node.appendChild(hd);
    const row = el('div', 'cp-btns');
    buttons.forEach((b) => {
      const x = btn('cp-btn' + (b.cls ? ' ' + b.cls : ''), b.label, () => { dismissPop(); b.fn(); });
      if (b.icon) x.appendChild(ico(b.icon, 16));
      x.appendChild(el('span', '', b.label));
      row.appendChild(x);
    });
    node.appendChild(row);
    host.appendChild(node);
    const r = regionOf(rid);
    const c = safe(() => Render.regionCenter(rid), null) || (r ? { x: r.cx + 0.5, y: r.cy + 0.5 } : { x: S.w / 2, y: S.h / 2 });
    const sp = Render.tileToScreen(c.x, c.y);
    const bi = bandInfo();
    const w = node.offsetWidth, h = node.offsetHeight;
    const left = Util.clamp(sp.x - w / 2, 8, Math.max(8, bi.w - w - 8));
    let top = sp.y - h - 16;
    if (top < bi.top) top = sp.y + 18;
    top = Util.clamp(top, bi.top, Math.max(bi.top, bi.bot - h));
    node.style.left = Math.round(left) + 'px'; node.style.top = Math.round(top) + 'px';
    cm.pop = { node, rid, x: Render.cam.x, y: Render.cam.y, z: Render.cam.zoom, born: performance.now() };
  }
  function updatePop() {
    if (!cm.pop) return;
    const cam = Render.cam, p = cm.pop;
    if (Math.abs(cam.x - p.x) + Math.abs(cam.y - p.y) > 0.4 || Math.abs(cam.zoom - p.z) > 0.05 || performance.now() - p.born > 9000) dismissPop();
  }

  // ---- commanding a kingdom
  function enterCommandView() {
    cm.mapPrev = state.mapMode;
    if (state.mapMode === 0) { state.mapMode = 1; Render.setMode(MAP_MODES[1].mode); syncMapFab(); }
    if (state.mode === 'paint') setMode('pan');
  }
  function leaveCommandView() {
    if (cm.mapPrev === 0 && state.mapMode === 1) { state.mapMode = 0; Render.setMode(MAP_MODES[0].mode); syncMapFab(); }
    cm.mapPrev = -1;
  }
  function commandKingdom(kid, opts) {
    opts = opts || {};
    if (!ready) return false;
    const k = kget(kid);
    if (!k) { toast('Королевство недоступно', 'bad'); return false; }
    if (!regionsOn()) { toast('Командование требует карты регионов', 'bad'); return false; }
    if (cm.kid === kid) { if (opts.focus !== false) focusKingdom(kid); return true; }
    let ok = false;
    try { ok = Kingdoms.setCommanded(kid, true); } catch (e) { ok = false; }
    if (!ok) { toast('Не удалось взять королевство под командование', 'bad'); return false; }
    const was = cm.kid;
    cm.goal = null; cm.peace = null; cm.armyId = 0; cm.selRegion = 0; cm.tkid = 0; dismissPop();
    cm.kid = kid; cm.page = opts.page || 'war'; cm.rc = rcMake(kid);
    if (insp) { insp = null; Render.highlight = null; }
    if (!was) enterCommandView();
    rcSync();
    showCmdSheet();
    if (opts.focus !== false) defer(() => { if (cm.kid === kid && !cm.goal && !cm.peace) focusKingdom(kid); });
    hintOnce('cmdstart', 'Откройте «Война», выберите соседа и регион для захвата. Армии соберутся сами.');
    return true;
  }
  function releaseCommand(quiet) {
    if (!cm.kid) return;
    const kid = cm.kid;
    cm.goal = null; cm.peace = null; dismissPop();
    safe(() => Kingdoms.setCommanded(kid, false), 0);
    cm.kid = 0; cm.armyId = 0; cm.selRegion = 0; cm.tkid = 0; cm.view = null; cm.rc = null; cm.targets = NONE; cm.tgSig = '';
    Render.cmd = null;
    leaveCommandView();
    applyRegionHL();
    if (!insp) { closeSheetDom(); }
    if (!quiet) toast('Командование снято: королевство снова живёт само', undefined);
  }
  function closeSheetDom() {
    document.body.classList.remove('cmd', 'cmd-pick');
    refs.bottom.classList.remove('sheet-open');
    refs.sheet.classList.remove('cmd', 'gm', 'pm', 'am');
    clear(refs.sheet);
    sheetFresh = true;
    layoutSoon();
  }
  function setPage(p) {
    if (cm.page === p && cm.view && cm.view.page === p) return;
    cm.page = p;
    if (cm.armyId && p !== 'armies') { /* selection survives page switches */ }
    if (cm.view && cm.view.pageHost) buildPage(cm.view);
    syncSeg();
    syncSheetMode();
  }
  function syncSeg() {
    const v = cm.view; if (!v || !v.seg) return;
    [...v.seg.children].forEach((b) => { const on = b.dataset.page === cm.page; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  }

  // ---- the command sheet
  function showCmdSheet() {
    if (!cm.kid) return;
    const k = kget(cm.kid);
    if (!k) { releaseCommand(true); return; }
    const sh = refs.sheet;
    clear(sh);
    if (sheetFresh) { sh.style.animation = 'none'; void sh.offsetWidth; sh.style.animation = ''; sheetFresh = false; }
    sh.classList.add('cmd'); sh.classList.toggle('gm', !!cm.goal); sh.classList.toggle('pm', !!cm.peace);
    sh.classList.remove('am');
    document.body.classList.add('cmd'); document.body.classList.toggle('cmd-pick', !!(cm.goal || cm.peace));
    refs.bottom.classList.add('sheet-open');
    cm.view = null;
    if (cm.goal) buildGoalBar(sh);
    else if (cm.peace) buildPeaceSheet(sh);
    else buildCmdMain(sh, k);
    layoutSoon();
  }
  function sumChip(icon, title, unit) {
    const c = el('span', 'sc'); c.title = title; c.appendChild(ico(icon, 16));
    const b = el('b', '', '0'); c.appendChild(b);
    if (unit) c.appendChild(el('small', '', unit));
    return { node: c, b };
  }
  function buildCmdMain(sh, k) {
    const v = { ups: [], pups: [], page: '', pageHost: null, seg: null };
    cm.view = v;
    const head = el('div', 'sh-head cm-head');
    const ava = el('div', 'sh-ava'); ava.style.width = '56px';
    const fl = flagEl(k.flag, 32); ava.appendChild(fl); head.appendChild(ava);
    const tt = el('div', 'sh-title'); const t1 = el('b'); const t2 = el('small'); tt.appendChild(t1); tt.appendChild(t2); head.appendChild(tt);
    const fb = btn('sh-btn primary', 'Показать на карте', () => focusKingdom(cm.kid)); fb.appendChild(ico('focus', 24)); fb.appendChild(el('span', 't', 'На карте'));
    const cb = btn('sh-btn', 'Снять командование', () => releaseCommand()); cb.dataset.act = 'release'; cb.appendChild(ico('close', 24));
    head.appendChild(fb); head.appendChild(cb);
    sh.appendChild(head);
    v.ups.push(() => {
      const kk = kget(cm.kid); if (!kk) return;
      drawFlag(fl, kk.flag);
      setText(t1, kk.name);
      const u = S.units.get(kk.rulerId);
      setText(t2, cm.armyId && cm.page === 'armies' ? 'Тап по региону на карте: враг — атака, свой — удержание' : (u ? Names.ruler(u.race, u.sex) + ' ' + u.name : 'трон пуст') + ' · ' + rname(kk.race));
    });
    // summary strip
    const sum = el('div', 'csum');
    const cReg = sumChip('region', 'Регионов', 'рег.'), cCit = sumChip('tab_kingdoms', 'Городов', 'гор.'), cPop = sumChip('human', 'Жителей', 'жит.');
    const cSt = el('span', 'sc stab'); cSt.title = 'Стабильность'; cSt.appendChild(ico('heart', 16));
    const mb = el('span', 'mb'); const mi = el('i'); mb.appendChild(mi); cSt.appendChild(mb); const stb = el('b', '', '0'); cSt.appendChild(stb);
    const cWar = el('span', 'sc war hide'); cWar.appendChild(ico('war', 16)); const wb = el('b', '', '0'); cWar.appendChild(wb);
    [cReg.node, cCit.node, cPop.node, cSt, cWar].forEach((n) => sum.appendChild(n));
    sh.appendChild(sum);
    v.ups.push(() => {
      const kk = kget(cm.kid); if (!kk) return;
      const st = kStats(cm.kid);
      setText(cReg.b, st.regions + (st.held ? '+' + st.held : ''));
      setText(cCit.b, st.cities);
      setText(cPop.b, st.pop);
      const sv = Util.clamp(kk.stability / 100, 0, 1);
      setStyle(mi, 'transform', 'scaleX(' + (Math.round(sv * 100) / 100) + ')'); setStyle(mi, 'backgroundColor', hpColor(sv));
      setText(stb, num(kk.stability) + '%');
      const ws = warsOf(cm.kid);
      cWar.classList.toggle('hide', !ws.length);
      setText(wb, ws.length === 1 ? num(warScore(ws[0].id, cm.kid)) + ' : ' + num(warScore(ws[0].id, enemyLeadOf(ws[0], cm.kid))) : ws.length);
      cWar.title = 'Войн: ' + ws.length + (ws.length === 1 ? ' · очки войны' : '');
    });
    // segmented pages
    const seg = el('div', 'cseg'); seg.setAttribute('role', 'tablist'); v.seg = seg;
    [['war', 'war', 'Война'], ['armies', 'army', 'Армии'], ['info', 'region', 'Регионы']].forEach(([id, icon, label]) => {
      const b = btn('', label, () => setPage(id)); b.dataset.page = id; b.setAttribute('role', 'tab');
      b.appendChild(ico(icon, 16)); b.appendChild(el('span', '', label));
      seg.appendChild(b);
    });
    sh.appendChild(seg);
    const body = el('div', 'sh-body'); const host = el('div', 'cpage'); body.appendChild(host); sh.appendChild(body);
    refs.sheetBody = body;
    v.pageHost = host;
    runUps(v.ups);
    buildPage(v);
    syncSeg();
  }
  function runUps(list) {
    for (let i = 0; i < list.length; i++) { try { list[i](); } catch (e) { reportOnce('cmd.up', e); } }
  }
  function buildPage(v) {
    v.pups = [];
    v.page = cm.page;
    clear(v.pageHost);
    if (refs.sheetBody) refs.sheetBody.scrollTop = 0;
    if (cm.page === 'armies') pageArmies(v, v.pageHost);
    else if (cm.page === 'info') pageRegions(v, v.pageHost);
    else pageWar(v, v.pageHost);
    runUps(v.pups);
  }

  // ------------------------------------------------------------------ page: Война
  function pageWar(v, host) {
    const kid = cm.kid;
    const sw = el('div', 'sec'); sw.appendChild(el('div', 'sec-h', 'Идущие войны'));
    const wl = el('div', 'wlist'); sw.appendChild(wl); host.appendChild(sw);
    listSlot(v.pups, wl, () => warsOf(kid), (w) => w.id, warSig, warCard, 'Мирное время. Выберите соседа ниже и объявите войну за конкретный регион.');
    const sn = el('div', 'sec'); sn.appendChild(el('div', 'sec-h', 'Соседи'));
    const nl = el('div', 'nlist'); sn.appendChild(nl); host.appendChild(sn);
    listSlot(v.pups, nl, neighborItems, (it) => it.kid, neighborSig, neighborRow, 'У королевства нет соседей по границе — воевать пока не с кем.');
  }
  function warSig(w) {
    const kid = cm.kid;
    let s = w.id + ':' + w.attackers.length + '.' + w.defenders.length + ':' + enemyLeadOf(w, kid) + ':';
    for (let i = 0; i < w.goals.length; i++) s += w.goals[i].kid + '.' + w.goals[i].regionId + (w.goals[i].done ? 'd' : 'p') + ',';
    const po = safe(() => War.pendingOffer(w.id), null);
    if (po) s += '!' + po.from + po.regions.join('.');
    return s;
  }
  function warCard(w) {
    const kid = cm.kid, me = kget(kid), lead = enemyLeadOf(w, kid), ek = kget(lead);
    const card = el('div', 'wcard'); card.dataset.war = w.id;
    const head = btn('wc-head', ek ? 'Враг: ' + ek.name : 'Враг', () => focusWar(w));
    if (ek) head.appendChild(flagEl(ek.flag, 24));
    const tt = el('span', 'wc-t'); tt.appendChild(el('b', '', ek ? ek.name : 'Противник'));
    const extra = warEnemies(w, kid).length - 1;
    const sm = el('small'); tt.appendChild(sm);
    head.appendChild(tt);
    const dur = el('span', 'wc-d'); head.appendChild(dur);
    card.appendChild(head);
    const bars = el('div', 'wc-bars');
    const bMe = miniBar('Мы'), bEn = miniBar('Враг');
    bars.appendChild(bMe.node); bars.appendChild(bEn.node);
    card.appendChild(bars);
    const info = el('div', 'wc-info'); card.appendChild(info);
    const goals = el('div', 'chips wc-goals');
    const mine = w.goals.filter((g) => g.kid === kid || wside(w, g.kid) === wside(w, kid));
    const theirs = w.goals.filter((g) => wside(w, g.kid) !== wside(w, kid));
    mine.forEach((g) => {
      const c = chipEl(rName(g.regionId) + (g.done ? ' · взят' : ' · цель'), g.done ? 'good' : 'gold', 'star');
      c.classList.add('tapc'); c.addEventListener('click', () => { focusRegion(g.regionId, 8); setRegionHL(g.regionId, 3500); });
      goals.appendChild(c);
    });
    theirs.forEach((g) => {
      const c = chipEl(rName(g.regionId) + ' · цель врага', 'bad', 'flag_goal');
      c.classList.add('tapc'); c.addEventListener('click', () => { focusRegion(g.regionId, 8); setRegionHL(g.regionId, 3500); });
      goals.appendChild(c);
    });
    if (!mine.length) goals.appendChild(el('span', 'muted', theirs.length ? 'Своих целей нет — «+ Цель» выберет регион для контрудара' : 'Целей нет — добавьте регион'));
    card.appendChild(goals);
    if (mine.length && mine.every((g) => g.done)) {
      card.appendChild(el('div', 'wc-note', 'Цели взяты: армии удерживают регионы и дальше не пойдут. Война продолжается, пока вы не заключите мир или не поставите новую цель.'));
    }
    const po = safe(() => War.pendingOffer(w.id), null);
    if (po && po.to === kid) {
      const box = el('div', 'offer');
      const f = kget(po.from);
      box.appendChild(el('div', 'ot', (f ? '«' + f.name + '»' : 'Враг') + ' предлагает мир' + (po.regions.length ? ': уступить ' + po.regions.map(rName).join(', ') : ' (белый мир)')));
      const r = el('div', 'orow');
      r.appendChild(actBtn('primary', 'Принять', 'check', () => { const ok = safe(() => War.respondOffer(w.id, true), false); toast(ok ? 'Мир заключён' : 'Не удалось принять мир', ok ? 'good' : 'bad'); }));
      r.appendChild(actBtn('', 'Отклонить', 'close', () => { safe(() => War.respondOffer(w.id, false), false); toast('Предложение отклонено'); }));
      box.appendChild(r); card.appendChild(box);
    }
    const acts = el('div', 'wc-acts');
    const add = actBtn('', '+ Цель', 'flag_goal', () => startGoalMode(lead, w.id)); add.dataset.act = 'addgoal';
    const front = actBtn('', 'Фронт', 'focus', () => focusWar(w));
    const peace = actBtn('primary', 'Мир', 'handshake', () => openPeace(w.id)); peace.dataset.act = 'peace';
    acts.appendChild(add); acts.appendChild(front); acts.appendChild(peace);
    card.appendChild(acts);
    const upd = () => {
      const f = kget(kid), e = kget(enemyLeadOf(w, kid));
      const ms = warScore(w.id, kid), es = e ? warScore(w.id, e.id) : 0;
      bMe.set(ms / 100, num(ms), me ? me.color : '#58c7ff');
      bEn.set(es / 100, num(es), e ? e.color : '#ff5b5b');
      const wear = safe(() => War.weariness(kid), 0);
      let held = 0; try { held = War.heldRegions(w.id, kid).length; } catch (er) { held = 0; }
      let sub = (extra > 0 ? '+' + extra + ' ' + Util.plural(extra, 'союзник', 'союзника', 'союзников') + ' · ' : '') + 'удерживаете: ' + held;
      setText(sm, sub);
      setText(info, 'Усталость от войны: ' + num(wear) + '%' + (f && f.stability < 30 ? ' · смута в стране' : ''));
      setCls(info, 'warn', wear >= 60);
      setText(dur, fmtYears(S.tick - w.started));
    };
    return { node: card, upd };
  }
  function focusWar(w) {
    const kid = cm.kid, ids = [];
    for (let i = 0; i < w.goals.length; i++) if (w.goals[i].kid === kid || wside(w, w.goals[i].kid) === wside(w, kid)) ids.push(w.goals[i].regionId);
    safe(() => War.heldRegions(w.id, kid), []).forEach((r) => { if (ids.indexOf(r) < 0) ids.push(r); });
    if (!ids.length) { const lead = enemyLeadOf(w, kid); focusKingdom(lead); return; }
    fitRegions(ids, 6, 10);
  }
  function neighborItems() {
    const kid = cm.kid;
    const rels = new Map();
    relationsOf(kid).forEach((r) => rels.set(r.other, r));
    const out = [];
    safe(() => Diplomacy.neighbors(kid), []).forEach((n) => { const k2 = kget(n.kid); if (k2) out.push({ kid: n.kid, dist: n.dist, contact: n.contact, rel: rels.get(n.kid) || null, can: null }); });
    // enemies without a common border (allies of the foe) still deserve a row
    warsOf(kid).forEach((w) => { warEnemies(w, kid).forEach((e) => { if (kget(e) && !out.some((o) => o.kid === e)) out.push({ kid: e, dist: 0, contact: 0, rel: rels.get(e) || null, can: null }); }); });
    out.forEach((o) => { o.can = o.rel && o.rel.state === Const.REL.WAR ? { ok: false, reason: 'война уже идёт' } : safe(() => Diplomacy.canDeclare(kid, o.kid), { ok: false, reason: '' }); });
    return out;
  }
  function neighborSig(it) {
    const k2 = S.kingdoms.get(it.kid), r = it.rel;
    return it.kid + ':' + (k2 ? k2.name + flagSig(k2.flag) : '') + ':' + (r ? r.state + ':' + (r.truce ? 1 : 0) + ':' + r.vassal : '') + ':' + (it.can.ok ? 1 : 0) + it.can.reason;
  }
  function neighborRow(it) {
    const kid = cm.kid, k2 = S.kingdoms.get(it.kid), r = it.rel;
    const row = el('div', 'nrow'); row.dataset.kid = it.kid;
    const top = el('div', 'nr-top');
    top.appendChild(k2 ? kingdomLink(k2) : el('span', '', '?'));
    const chips = el('span', 'nr-chips');
    const st = r ? r.state : Const.REL.PEACE;
    if (st === Const.REL.WAR) chips.appendChild(chipEl('Война', 'bad', 'war'));
    else if (st === Const.REL.ALLIANCE) chips.appendChild(chipEl('Союз', 'good', 'heart'));
    else chips.appendChild(chipEl('Мир', ''));
    if (r && r.truce && st !== Const.REL.WAR) chips.appendChild(chipEl('Перемирие ' + fmtYears(r.truceLeft), 'warn'));
    if (r && r.vassal === 'overlord') chips.appendChild(chipEl('Сюзерен', 'gold', 'crown'));
    if (r && r.vassal === 'vassal') chips.appendChild(chipEl('Вассал', 'gold', 'crown'));
    top.appendChild(chips);
    row.appendChild(top);
    const mid = el('div', 'nr-mid');
    const ob = opinionBar(); mid.appendChild(ob.node);
    const sr = el('span', 'chip nr-str'); mid.appendChild(sr);
    row.appendChild(mid);
    const cz = causesBox(); row.appendChild(cz.node);
    ob.node.classList.add('tapc'); ob.node.title = 'Тап: почему такие отношения';
    ob.node.addEventListener('click', () => { cz.toggle(); cz.set(kid, it.kid); });
    const bot = el('div', 'nr-bot');
    if (st !== Const.REL.WAR) {
      if (it.can.ok) {
        const b = actBtn('danger', 'Объявить войну', 'war', () => startGoalMode(it.kid, 0)); b.dataset.act = 'declare'; b.dataset.kid = it.kid;
        bot.appendChild(b);
      } else {
        const b = actBtn('', 'Объявить войну', 'war', () => { toast(it.can.reason || 'Сейчас нельзя', 'bad'); }); b.classList.add('off'); b.dataset.act = 'declare'; b.dataset.kid = it.kid;
        bot.appendChild(b);
        if (it.can.reason) bot.appendChild(el('span', 'why', it.can.reason));
      }
    } else bot.appendChild(el('span', 'why', 'Война идёт — карточка выше'));
    row.appendChild(bot);
    const upd = (cur) => {
      const rr = cur.rel;
      ob.set(rr ? rr.opinion : 0);
      const ri = ratioInfo(kid, cur.kid);
      setText(sr, ri.text); sr.className = 'chip nr-str ' + ri.cls;
      if (cz.open) cz.set(kid, cur.kid);
    };
    return { node: row, upd };
  }

  // ------------------------------------------------------------------ goal picking (declare a war / add a goal)
  function addableGoals(w, kid) {
    const out = [];
    const s = wside(w, kid); if (!s) return out;
    const mates = s === 1 ? w.attackers : w.defenders, foes = s === 1 ? w.defenders : w.attackers;
    for (let i = 0; i < mates.length; i++) for (let j = 0; j < foes.length; j++) {
      const list = safe(() => Regions.attackable(mates[i], foes[j]), []);
      for (let q = 0; q < list.length; q++) {
        const rid = list[q];
        if (out.indexOf(rid) >= 0) continue;
        if (w.goals.some((g) => g.kid === kid && g.regionId === rid)) continue;
        out.push(rid);
      }
    }
    return out;
  }
  function startGoalMode(targetKid, warId) {
    const kid = cm.kid;
    if (!kget(kid) || !kget(targetKid)) return;
    let cand = [];
    if (warId) { const w = safe(() => War.get(warId), null); if (!w || w.ended) { toast('Война окончена', 'bad'); return; } cand = addableGoals(w, kid); }
    else {
      const can = safe(() => Diplomacy.canDeclare(kid, targetKid), { ok: false, reason: '' });
      if (!can.ok) { toast(can.reason || 'Сейчас нельзя объявить войну', 'bad'); return; }
      cand = safe(() => War.potentialGoals(kid, targetKid), []).slice();
    }
    if (!cand.length) { toast('Нет доступных регионов: цель должна граничить с вашими землями', 'bad'); return; }
    dismissPop();
    cm.peace = null; cm.armyId = 0; cm.selRegion = 0; cm.tkid = targetKid;
    cm.goal = { targetKid, warId: warId | 0, goals: [], cand, allowance: safe(() => War.allowance(kid, targetKid), 40) };
    rcSync();
    showCmdSheet();
    defer(() => { if (cm.goal) fitRegions(cand, 6, 10); });
    hintOnce('goalpick', 'Тапайте по подсвеченным регионам, чтобы выбрать цели. Захватив, армии удержат их и не пойдут дальше.');
  }
  function cancelGoal(silent) {
    if (!cm.goal) return;
    cm.goal = null;
    if (!silent) { rcSync(); showCmdSheet(); }
  }
  function goalCost() { let c = 0; if (cm.goal) for (let i = 0; i < cm.goal.goals.length; i++) c += regionCostOf(cm.goal.goals[i]); return c; }
  function toggleGoal(rid) {
    const g = cm.goal; if (!g) return;
    const r = regionOf(rid);
    if (!r) return;
    const i = g.goals.indexOf(rid);
    if (i >= 0) g.goals.splice(i, 1);
    else if (g.cand.indexOf(rid) >= 0) { g.goals.push(rid); if (g.goals.length === 1) hintOnce('goalone', 'Можно выбрать несколько регионов — но чем больше цель, тем труднее победить'); }
    else {
      const o = r.ownerId ? kget(r.ownerId) : null;
      toast(!o ? 'Это ничья земля — войны за неё не бывает' : r.ownerId === cm.kid ? 'Это ваш регион' : r.ownerId === g.targetKid ? 'Регион не граничит с вашими землями' : 'Нужен регион врага рядом с вашими землями', 'bad');
      return;
    }
    refreshGoal();
  }
  function confirmGoals() {
    const g = cm.goal; if (!g || !g.goals.length) return;
    const kid = cm.kid;
    if (g.warId) {
      let n = 0, why = '';
      g.goals.forEach((rid) => { const ok = safe(() => War.addGoal(g.warId, kid, rid), false); if (ok) n++; else if (!why) why = safe(() => War.lastError, ''); });
      cm.goal = null; rcSync(); showCmdSheet();
      if (n) toast(n > 1 ? 'Новых целей: ' + n : 'Новая цель войны: «' + rName(g.goals[0]) + '»', 'good'); else toast(why || 'Цель не принята', 'bad');
      return;
    }
    const w = safe(() => War.declare(kid, g.targetKid, g.goals.slice(), undefined), null);
    if (!w) { toast(safe(() => War.lastError, '') || 'Не удалось объявить войну', 'bad'); return; }
    cm.goal = null; cm.page = 'armies'; cm.armyId = 0;
    rcSync(); showCmdSheet();
    toast('Война объявлена! Армии собираются…', 'good');
  }
  function buildGoalBar(sh) {
    const g = cm.goal;
    const v = { ups: [], pups: [], page: 'goal' };
    cm.view = v;
    const tk = kget(g.targetKid);
    const head = el('div', 'sh-head gb-head');
    const ava = el('div', 'sh-ava'); ava.style.width = '56px';
    if (tk) ava.appendChild(flagEl(tk.flag, 32)); else ava.appendChild(ico('war', 32));
    head.appendChild(ava);
    const tt = el('div', 'sh-title');
    tt.appendChild(el('b', '', g.warId ? 'Новая цель войны' : 'Война против «' + (tk ? tk.name : '?') + '»'));
    tt.appendChild(el('small', '', 'Тап по региону на карте'));
    head.appendChild(tt);
    const cb = btn('sh-btn', 'Отмена', () => cancelGoal()); cb.appendChild(ico('close', 24)); head.appendChild(cb);
    sh.appendChild(head);
    const body = el('div', 'sh-body gb-body'); sh.appendChild(body); refs.sheetBody = body;
    const chipsBox = el('div', 'chips gb-chips'); body.appendChild(chipsBox);
    const bar = miniBar('Цена'); bar.node.classList.add('gb-bar'); body.appendChild(bar.node);
    const hint = el('div', 'gb-hint'); body.appendChild(hint);
    const foot = el('div', 'sh-foot');
    const no = actBtn('', 'Отмена', null, () => cancelGoal()); no.dataset.act = 'goal-cancel';
    const go = actBtn('danger', 'Начать войну', 'war', () => confirmGoals()); go.dataset.act = 'goal-go';
    foot.appendChild(no); foot.appendChild(go); sh.appendChild(foot);
    let sig = '';
    g.render = () => {
      const kid = cm.kid;
      const s = g.goals.join(',');
      if (s !== sig) {
        sig = s; clear(chipsBox);
        g.goals.forEach((rid) => {
          const c = chipEl(rName(rid) + ' · ' + regionCostOf(rid), 'gold', 'star'); c.classList.add('tapc'); c.title = 'Тап: убрать цель';
          c.appendChild(el('i', 'x', '×'));
          c.addEventListener('click', () => toggleGoal(rid));
          chipsBox.appendChild(c);
        });
        if (!g.goals.length) chipsBox.appendChild(el('span', 'muted', 'Цели не выбраны — подсвеченные регионы можно захватить'));
      }
      const cost = goalCost(), allow = Math.max(1, g.allowance || 40);
      bar.set(cost / allow, cost + ' / ' + num(allow), cost <= allow ? '#58e08a' : '#ff9a3a');
      let claims = 0;
      g.goals.forEach((rid) => { if (safe(() => Regions.hasClaim(rid, kid), false)) claims++; });
      let t, cls = '';
      if (!g.goals.length) t = g.warId ? 'Выберите регион врага рядом с вашими землями.' : 'Выберите хотя бы один регион для захвата.';
      else if (cost > allow) { t = 'Аппетиты велики: победа будет трудной, а мир — далёким.'; cls = 'warn'; }
      else if (claims === g.goals.length) { t = 'Законные притязания: война справедлива, дурная слава растёт слабо.'; cls = 'good'; }
      else t = 'Захватив регион, армия удержит его. Война закончится только миром.';
      setText(hint, t); hint.className = 'gb-hint ' + cls;
      go.disabled = !g.goals.length;
      setText(go.lastChild, g.warId ? 'Добавить цель' : 'Начать войну');
    };
    g.render();
  }
  function refreshGoal() { if (cm.goal && cm.goal.render) cm.goal.render(); rcSync(); }

  // ------------------------------------------------------------------ page: Армии
  function armyById(id) { const a = id ? S.armies.get(id) : null; return a && a.kingdomId === cm.kid ? a : null; }
  /** enemy regions this army may be ordered to attack (enemy land next to ours, or our land lost to the enemy) — shown as dashed outlines */
  function refreshTargets() {
    const a = cm.armyId ? S.armies.get(cm.armyId) : null;
    const w = a ? S.wars.get(a.warId) : null;
    let out = NONE;
    if (a && w && !w.ended) {
      const side = wside(w, cm.kid), mates = side === 1 ? w.attackers : w.defenders, foes = side === 1 ? w.defenders : w.attackers;
      const friend = (x) => !!x && wside(w, x) === side, foe = (x) => !!x && wside(w, x) === 3 - side;
      out = [];
      for (let i = 0; i < mates.length; i++) for (let j = 0; j < foes.length; j++) {
        const list = safe(() => Regions.attackable(mates[i], foes[j]), []);
        for (let q = 0; q < list.length; q++) { const r = regionOf(list[q]); if (r && !friend(r.controllerId) && out.indexOf(r.id) < 0) out.push(r.id); }
      }
      for (const r of S.regions.values()) if (friend(r.ownerId) && foe(r.controllerId) && out.indexOf(r.id) < 0) out.push(r.id);
    }
    const sig = out.join(',');
    if (sig !== cm.tgSig) { cm.tgSig = sig; cm.targets = out.length ? out : NONE; rcSync(); }
  }
  function selectArmy(id, opts) {
    opts = opts || {};
    const a = armyById(id);
    if (!a) return false;
    cm.armyId = id; cm.selRegion = 0; cm.tgSig = '~';
    dismissPop();
    if (cm.page !== 'armies') setPage('armies');
    refreshTargets();
    rcSync();
    const av = safe(() => War.armiesOf(cm.kid), []).find((x) => x.id === id);
    if (opts.focus !== false && av) focusVisible(av.x, av.y, Math.max(Render.cam.zoom, 8));
    hintOnce('armysel', 'Теперь тапните регион на карте: вражеский — атака, свой — удержание или оборона.');
    updatePage();
    return true;
  }
  function deselectArmy() { if (!cm.armyId) return; cm.armyId = 0; cm.targets = NONE; cm.tgSig = ''; rcSync(); updatePage(); }
  function updatePage() { syncSheetMode(); const v = cm.view; if (v && v.pups) runUps(v.pups); }
  /** with an army selected the sheet shrinks to that army (the map is what the player needs next) */
  function syncSheetMode() {
    const on = !!(cm.kid && cm.armyId && cm.page === 'armies' && !cm.goal && !cm.peace && !insp);
    if (refs.sheet.classList.contains('am') !== on) { refs.sheet.classList.toggle('am', on); layoutSoon(); }
  }
  function pageArmies(v, host) {
    const kid = cm.kid;
    const bulk = el('div', 'abulk');
    const hold = actBtn('', 'Все: удерживать', 'shield', () => holdAll()); hold.dataset.act = 'hold-all';
    const ret = actBtn('', 'Все: отступить', '~arrow', () => confirmBox({ title: 'Отступить всем армиям?', text: 'Все армии вернутся домой и будут распущены. Захваченные регионы останутся за вами, пока идёт война, но без гарнизонов их могут отбить.', ok: 'Отступить', danger: true, onOk: () => { const ok = safe(() => War.order(kid, 'all', { type: 'retreat', regionId: 0 }), false); toast(ok ? 'Армии отходят домой' : (safe(() => War.lastError, '') || 'Некому отступать'), ok ? undefined : 'bad'); } }));
    ret.dataset.act = 'retreat-all';
    bulk.appendChild(hold); bulk.appendChild(ret); host.appendChild(bulk);
    const hint = el('div', 'ahint'); host.appendChild(hint);
    const list = el('div', 'alist'); host.appendChild(list);
    host.appendChild(allOrdersToggle());
    v.pups.push(() => {
      const n = armiesOfK(kid).length;
      const a = armyById(cm.armyId);
      setText(hint, !n ? '' : a ? 'Армия выбрана. Тап по региону: враг — атака, свой — удержание.' : 'Тапните армию в списке или её флаг на карте.');
      setCls(hint, 'hide', !n);
      hold.disabled = !n; ret.disabled = !n;
    });
    listSlot(v.pups, list, () => armiesOfK(kid).sort((a, b) => a.id - b.id), (a) => a.id, armySig, armyCard, 'Армий нет. Объявите войну — армии соберутся из горожан сами. Пока идёт мир, они распущены.');
  }
  function allOrdersToggle() {
    const c = btn('check mt sm' + (Render.showAllOrders ? ' on' : ''), 'Показывать приказы всех армий', () => {
      Render.showAllOrders = !Render.showAllOrders;
      c.classList.toggle('on', !!Render.showAllOrders); c.setAttribute('aria-pressed', Render.showAllOrders ? 'true' : 'false');
    });
    c.dataset.act = 'show-orders'; c.setAttribute('aria-pressed', Render.showAllOrders ? 'true' : 'false');
    const box = el('span', 'box'); box.appendChild(ico('check', 16)); c.appendChild(box);
    const tx = el('span'); tx.appendChild(document.createTextNode('Приказы всех армий на карте')); tx.appendChild(el('small', '', 'Стрелки и щиты вражеских армий — видно, куда они идут'));
    c.appendChild(tx);
    return c;
  }
  function armySig(a) { return a.id + ':' + (cm.armyId === a.id ? 1 : 0); }
  function armyLabel(a) {
    const ld = S.units.get(a.leaderId);
    return ld ? 'Армия «' + ld.name + '»' : 'Армия №' + a.id;
  }
  function armyCard(a) {
    const kid = cm.kid, k = kget(kid), sel = cm.armyId === a.id;
    const card = el('div', 'acard' + (sel ? ' sel' : '')); card.dataset.army = a.id;
    const head = btn('ac-head', armyLabel(a), () => (cm.armyId === a.id ? deselectArmy() : selectArmy(a.id)));
    const ic = el('span', 'ac-ic'); if (k) ic.appendChild(flagEl(k.flag, 24)); head.appendChild(ic);
    const tt = el('span', 'ac-t'); const nm = el('b', '', armyLabel(a)); const sz = el('small'); tt.appendChild(nm); tt.appendChild(sz); head.appendChild(tt);
    const oc = el('span', 'chip ac-ord');
    head.appendChild(oc);
    let ocSig = '';
    const setOrder = (cur) => {
      const sg = cur.order.type + ':' + cur.order.regionId + ':' + rName(cur.order.regionId);
      if (sg === ocSig) return;
      ocSig = sg; clear(oc);
      oc.className = 'chip ac-ord ' + (cur.order.type === 'attack' ? 'bad' : cur.order.type === 'retreat' ? 'warn' : 'blue');
      const oi = ico(cur.order.type === 'attack' ? 'sword' : cur.order.type === 'retreat' ? 'arrow' : 'shield', 16);
      if (cur.order.type === 'retreat') oi.style.transform = 'rotate(180deg)';
      oc.appendChild(oi);
      oc.appendChild(document.createTextNode((ORD_LABEL[cur.order.type] || cur.order.type) + (cur.order.regionId ? ' · ' + rName(cur.order.regionId) : '')));
    };
    card.appendChild(head);
    const sup = miniBar('Снабжение'); card.appendChild(sup.node);
    const loc = el('div', 'ac-loc'); card.appendChild(loc);
    const upd = (cur) => {
      setOrder(cur);
      setText(sz, cur.size + ' ' + Util.plural(cur.size, 'солдат', 'солдата', 'солдат') + ' · сила ' + cur.strength);
      const low = cur.supply < 30;
      sup.set(cur.supply / 100, (low ? 'ВНЕ СНАБЖЕНИЯ ' : '') + cur.supply + '%', supplyColor(cur.supply));
      setCls(card, 'low', low);
      const where = cur.regionId ? 'в «' + rName(cur.regionId) + '»' : 'в пути';
      setText(loc, where + ' · ' + (MODE_LABEL[cur.mode] || cur.mode) + (cur.auto ? ' · авто' : ' · по приказу'));
    };
    if (sel) {
      const act = el('div', 'ac-acts');
      const h = actBtn('', 'Держать', 'shield', () => { const cur = armiesOfK(kid).find((x) => x.id === a.id); if (cur && cur.regionId) giveOrder([a.id], 'hold', cur.regionId); else toast('Армия в пути: выберите регион на карте', 'bad'); });
      h.dataset.act = 'army-hold';
      const r = actBtn('', 'Отступить', '~arrow', () => giveOrder([a.id], 'retreat', 0)); r.dataset.act = 'army-retreat';
      const l = actBtn('', 'Список', 'close', () => deselectArmy()); l.dataset.act = 'army-list';
      act.appendChild(h); act.appendChild(r); act.appendChild(l);
      card.appendChild(act);
    }
    return { node: card, upd };
  }
  function orderText(type, rid) { return (type === 'attack' ? 'Атака на «' : type === 'defend' ? 'Оборона «' : type === 'hold' ? 'Удержание «' : 'Отход «') + rName(rid) + '»'; }
  function giveOrder(ids, type, rid) {
    const ok = safe(() => War.order(cm.kid, ids, { type, regionId: rid | 0 }), false);
    if (ok) {
      toast(type === 'retreat' ? 'Армия отходит домой' : 'Приказ: ' + orderText(type, rid), 'good');
      if (rid) { cm.selRegion = rid; rcSync(); setTimeout(() => { if (cm.selRegion === rid) { cm.selRegion = 0; rcSync(); } }, 1600); }
    } else toast(safe(() => War.lastError, '') || 'Приказ не принят', 'bad');
    updatePage();
    return ok;
  }
  function holdAll() {
    const kid = cm.kid, arr = armiesOfK(kid);
    let n = 0, skip = 0;
    arr.forEach((a) => {
      const r = regionOf(a.regionId);
      const w = S.wars.get(a.warId);
      const ok = r && w && !w.ended && wside(w, r.controllerId) === wside(w, kid) && wside(w, kid) > 0;
      if (ok && safe(() => War.order(kid, [a.id], { type: 'hold', regionId: a.regionId }), false)) n++; else skip++;
    });
    toast(n ? 'Держат позицию: ' + n + (skip ? ' (остальные вне своей земли)' : '') : 'Некому держать: армии стоят не на своей земле', n ? 'good' : 'bad');
    updatePage();
  }
  /** map tap while an army is selected: enemy region = attack, own / held region = popup (hold / defend) */
  function orderTap(rid) {
    const a = armyById(cm.armyId);
    if (!a) { deselectArmy(); return false; }
    const r = regionOf(rid); if (!r) return false;
    const w = S.wars.get(a.warId);
    if (!w || w.ended) { toast('Эта армия уже не воюет', 'bad'); return true; }
    const kid = cm.kid, side = wside(w, kid);
    const friend = (x) => !!x && wside(w, x) === side;
    const foe = (x) => !!x && wside(w, x) === 3 - side;
    if (friend(r.controllerId) || (friend(r.ownerId) && !foe(r.controllerId))) {
      const ok = r.ownerId ? kget(r.ownerId) : null;
      showPop(rid, r.name, r.ownerId === kid ? 'ваш регион' : 'занятая земля' + (ok ? ' · «' + ok.name + '»' : ''), r.ownerId, [
        { label: 'Удерживать', icon: 'shield', cls: 'primary', fn: () => giveOrder([a.id], 'hold', rid) },
        { label: 'Оборонять', icon: 'shield', fn: () => giveOrder([a.id], 'defend', rid) },
      ]);
      cm.selRegion = rid; rcSync();
      return true;
    }
    if (foe(r.ownerId) || foe(r.controllerId)) { giveOrder([a.id], 'attack', rid); return true; }
    toast('Этот регион не принадлежит ни вам, ни врагу', 'bad');
    return true;
  }

  // ------------------------------------------------------------------ page: Регионы
  function pageRegions(v, host) {
    const kid = cm.kid;
    const s0 = el('div', 'sec');
    const kb = actBtn('block', 'Карточка королевства', 'crown', () => openInspector('kingdom', kid, { push: true })); kb.dataset.act = 'kingdom-card';
    s0.appendChild(kb); host.appendChild(s0);
    const s1 = el('div', 'sec'); s1.appendChild(el('div', 'sec-h', 'Ваши регионы')); const l1 = el('div', 'rlist'); s1.appendChild(l1); host.appendChild(s1);
    listSlot(v.pups, l1, () => regionItems(kid, 'own'), (it) => it.rid, regionSig, regionRow, 'У королевства нет регионов.');
    const s2 = el('div', 'sec'); s2.appendChild(el('div', 'sec-h', 'Занятые вами земли врага')); const l2 = el('div', 'rlist'); s2.appendChild(l2); host.appendChild(s2);
    listSlot(v.pups, l2, () => regionItems(kid, 'held'), (it) => it.rid, regionSig, regionRow, 'Чужих регионов под контролем нет.');
    const s3 = el('div', 'sec'); s3.appendChild(el('div', 'sec-h', 'Притязания')); const l3 = el('div', 'rlist'); s3.appendChild(l3); host.appendChild(s3);
    listSlot(v.pups, l3, () => regionItems(kid, 'claim'), (it) => it.rid, regionSig, regionRow, 'Притязаний нет: они появляются, когда регион отнимают.');
  }
  function regionItems(kid, kind) {
    const out = [];
    if (!regionsOn()) return out;
    if (kind === 'claim') {
      safe(() => Regions.claimsOf(kid), []).forEach((rid) => { const r = regionOf(rid); if (r && r.ownerId !== kid) out.push({ rid, kind }); });
      return out;
    }
    for (const r of S.regions.values()) {
      if (kind === 'own' && r.ownerId === kid) out.push({ rid: r.id, kind });
      else if (kind === 'held' && r.controllerId === kid && r.ownerId && r.ownerId !== kid) out.push({ rid: r.id, kind });
    }
    out.sort((a, b) => a.rid - b.rid);
    return out;
  }
  function regionSig(it) {
    const r = regionOf(it.rid); if (!r) return it.rid + ':x';
    return it.rid + ':' + it.kind + ':' + r.ownerId + ':' + r.controllerId + ':' + r.cityIds.length + ':' + r.name;
  }
  function regionRow(it) {
    const r = regionOf(it.rid), kid = cm.kid;
    const row = el('div', 'rrow'); row.dataset.rid = it.rid;
    const main = btn('rr-main', r ? r.name : '?', () => { focusRegion(it.rid, 8); cm.selRegion = it.rid; rcSync(); setTimeout(() => { if (cm.selRegion === it.rid) { cm.selRegion = 0; rcSync(); } }, 3500); });
    main.appendChild(ico('region', 16));
    const tt = el('span', 'rr-t'); tt.appendChild(el('b', '', r ? r.name : '?'));
    const bits = [];
    if (r) {
      const nc = r.cityIds.length; if (nc) bits.push(nc + ' ' + Util.plural(nc, 'город', 'города', 'городов'));
      bits.push('ценность ' + (Math.round(r.value * 10) / 10));
      if (it.kind === 'claim') { const o = r.ownerId ? kget(r.ownerId) : null; bits.push(o ? 'владеет «' + o.name + '»' : 'ничья'); }
      if (it.kind === 'held') { const o = kget(r.ownerId); if (o) bits.push('владеет «' + o.name + '»'); }
    }
    tt.appendChild(el('small', '', bits.join(' · ')));
    main.appendChild(tt);
    const chips = el('span', 'rr-chips');
    if (r) {
      const k = kget(kid), cap = k ? S.cities.get(k.capitalId) : null;
      if (cap && cap.regionId === r.id && it.kind === 'own') chips.appendChild(chipEl('Столица', 'gold', 'crown'));
      if (r.controllerId && r.controllerId !== r.ownerId && it.kind === 'own') { const c = kget(r.controllerId); chips.appendChild(chipEl('Оккупирован' + (c ? ': «' + c.name + '»' : ''), 'bad', 'war')); }
      if (it.kind === 'held') chips.appendChild(chipEl('Под вашим контролем', 'good', 'shield'));
    }
    main.appendChild(chips);
    row.appendChild(main);
    const info = btn('rr-i', 'О регионе', () => openInspector('region', it.rid, { push: true })); info.textContent = 'i'; info.title = 'О регионе';
    row.appendChild(info);
    return { node: row };
  }

  // ------------------------------------------------------------------ peace conference
  function openPeace(warId) {
    const kid = cm.kid;
    const w = safe(() => War.get(warId), null);
    if (!w || w.ended) { toast('Война окончена', 'bad'); return; }
    const enemy = enemyLeadOf(w, kid);
    const held = safe(() => War.heldRegions(warId, kid), []).slice();
    const side = wside(w, kid);
    const goals = [];
    w.goals.forEach((g) => { if (wside(w, g.kid) === side && goals.indexOf(g.regionId) < 0) goals.push(g.regionId); });
    const list = held.slice();
    goals.forEach((rid) => { if (list.indexOf(rid) < 0) list.push(rid); });
    const picks = [];
    let cost = 0; const allow0 = safe(() => War.allowanceFor(warId, kid, goals), 0);
    held.forEach((rid) => { if (goals.indexOf(rid) >= 0) { const c = regionCostOf(rid); if (cost + c <= allow0) { picks.push(rid); cost += c; } } });
    dismissPop();
    cm.goal = null; cm.armyId = 0; cm.selRegion = 0; cm.tkid = enemy;
    cm.peace = { warId, enemy, held, goals, list, picks, cand: held.filter((r) => picks.indexOf(r) < 0), vassal: false, result: null };
    rcSync();
    showCmdSheet();
    defer(() => { if (cm.peace && list.length) fitRegions(list, 6, 10); });
    hintOnce('peacehint', 'Мирная конференция: выберите занятые регионы, которые заберёте себе. Цена зависит от очков войны.');
  }
  function closePeace() {
    if (!cm.peace) return;
    cm.peace = null; cm.tkid = 0;
    rcSync(); showCmdSheet();
  }
  function peaceVassalCost() {
    const p = cm.peace; if (!p) return 0;
    return 50 + 4 * kStats(p.enemy).regions;
  }
  function peaceTotals() {
    const p = cm.peace;
    const cost = safe(() => War.peaceCost(p.warId, p.picks), 0) + (p.vassal ? peaceVassalCost() : 0);
    const allow = safe(() => War.allowanceFor(p.warId, cm.kid, p.picks), 0);
    return { cost, allow };
  }
  function togglePick(rid) {
    const p = cm.peace; if (!p) return;
    if (p.held.indexOf(rid) < 0) {
      toast(p.goals.indexOf(rid) >= 0 ? 'Этот регион ещё не занят вашими армиями' : 'Требовать можно только занятые вами регионы врага', 'bad');
      return;
    }
    const i = p.picks.indexOf(rid);
    if (i >= 0) p.picks.splice(i, 1); else p.picks.push(rid);
    p.cand = p.held.filter((r) => p.picks.indexOf(r) < 0);
    p.result = null;
    rcSync();
    if (p.render) p.render(true);
  }
  function doOffer(white) {
    const p = cm.peace; if (!p) return;
    const terms = white ? { regions: [], vassalize: false } : { regions: p.picks.slice(), vassalize: p.vassal };
    const res = safe(() => War.peaceOffer(p.warId, cm.kid, terms), { ok: false, reason: safe(() => War.lastError, '') || 'Предложение не принято' });
    if (res.ok && res.accepted) {
      toast('Мир заключён: ' + (res.reason || 'условия приняты'), 'good');
      cm.peace = null; cm.tkid = 0; cm.page = 'war'; cm.armyId = 0; rcSync(); showCmdSheet();
      return;
    }
    p.result = { kind: res.pending ? 'warn' : 'bad', text: (res.pending ? '… ' : '✗ ') + (res.reason || 'Противник отказался') };
    if (p.render) p.render(false);
  }
  function doForce() {
    const p = cm.peace; if (!p) return;
    const ok = safe(() => War.forcePeace(p.warId, { winner: cm.kid, regions: p.picks.slice(), vassalize: p.vassal }), false);
    if (!ok) { toast(safe(() => War.lastError, '') || 'Не удалось навязать мир', 'bad'); return; }
    toast('Бог навязал мир: условия выполнены', 'good');
    cm.peace = null; cm.tkid = 0; cm.page = 'war'; cm.armyId = 0; rcSync(); showCmdSheet();
  }
  function buildPeaceSheet(sh) {
    const p = cm.peace, kid = cm.kid;
    const v = { ups: [], pups: [], page: 'peace' };
    cm.view = v;
    const ek = kget(p.enemy), me = kget(kid);
    const head = el('div', 'sh-head gb-head');
    const back = btn('sh-btn back', 'Назад', () => closePeace()); back.textContent = '‹'; head.appendChild(back);
    const ava = el('div', 'sh-ava'); ava.style.width = '56px'; ava.appendChild(ico('handshake', 32)); head.appendChild(ava);
    const tt = el('div', 'sh-title'); tt.appendChild(el('b', '', 'Мир с «' + (ek ? ek.name : '?') + '»'));
    tt.appendChild(el('small', '', 'Мирная конференция')); head.appendChild(tt);
    const cb = btn('sh-btn', 'Закрыть', () => closePeace()); cb.appendChild(ico('close', 24)); head.appendChild(cb);
    sh.appendChild(head);
    const body = el('div', 'sh-body pc-body'); sh.appendChild(body); refs.sheetBody = body;
    const w = safe(() => War.get(p.warId), null);
    const sb = el('div', 'pc-scores');
    const bMe = miniBar('Мы'), bEn = miniBar('Враг');
    sb.appendChild(bMe.node); sb.appendChild(bEn.node); body.appendChild(sb);
    body.appendChild(el('div', 'sec-h pc-h', 'Требовать регионы (тап по чипу или по карте)'));
    const chips = el('div', 'chips pc-chips'); body.appendChild(chips);
    const vas = el('div', 'pc-vas'); body.appendChild(vas);
    const bud = miniBar('Цена'); bud.node.classList.add('gb-bar'); body.appendChild(bud.node);
    const res = el('div', 'pc-res hide'); body.appendChild(res);
    const force = actBtn('god block', 'Принудить (бог)', 'crown', () => doForce()); force.dataset.act = 'force'; force.title = 'Бог навязывает врагу эти условия: он соглашается всегда';
    const fh = el('div', 'pc-force'); fh.appendChild(force); fh.appendChild(el('small', '', 'Божья воля: враг примет любые условия — без торга и без очков войны.')); body.appendChild(fh);
    const foot = el('div', 'sh-foot pc-foot');
    const white = actBtn('', 'Белый мир', 'peace', () => doOffer(true)); white.dataset.act = 'white';
    const offer = actBtn('primary', 'Предложить', 'handshake', () => doOffer(false)); offer.dataset.act = 'offer';
    foot.appendChild(white); foot.appendChild(offer); sh.appendChild(foot);
    let chipSig = '';
    p.render = (rebuild) => {
      if (!cm.peace || cm.peace !== p) return;
      const sg = p.list.map((r) => r + (p.picks.indexOf(r) >= 0 ? 'x' : '') + (p.held.indexOf(r) >= 0 ? 'h' : '')).join(',') + '|' + (p.vassal ? 1 : 0);
      if (rebuild || sg !== chipSig) {
        chipSig = sg; clear(chips);
        p.list.forEach((rid) => {
          const held = p.held.indexOf(rid) >= 0, on = p.picks.indexOf(rid) >= 0, isGoal = p.goals.indexOf(rid) >= 0;
          const claim = safe(() => Regions.hasClaim(rid, kid), false);
          const c = btn('pchip' + (on ? ' on' : '') + (held ? '' : ' off'), rName(rid), () => togglePick(rid));
          c.dataset.rid = rid;
          const box = el('span', 'pbox'); if (on) box.appendChild(ico('check', 16)); c.appendChild(box);
          const tx = el('span', 'pt'); tx.appendChild(el('b', '', rName(rid)));
          tx.appendChild(el('small', '', held ? 'цена ' + regionCostOf(rid) + (isGoal ? ' · цель' : '') + (claim ? ' · притязание' : '') : 'не занят вашими армиями'));
          c.appendChild(tx);
          if (isGoal) c.appendChild(ico('star', 16));
          chips.appendChild(c);
        });
        if (!p.list.length) chips.appendChild(el('span', 'muted', 'Ни одного вражеского региона пока не занято — можно заключить белый мир.'));
        clear(vas);
        const lk = ek && !ek.overlordId;
        if (lk) {
          const vc = btn('pchip vas' + (p.vassal ? ' on' : ''), 'Сделать вассалом', () => { p.vassal = !p.vassal; p.result = null; p.render(true); });
          const box = el('span', 'pbox'); if (p.vassal) box.appendChild(ico('check', 16)); vc.appendChild(box);
          const tx = el('span', 'pt'); tx.appendChild(el('b', '', 'Сделать «' + ek.name + '» вассалом'));
          tx.appendChild(el('small', '', 'цена ' + peaceVassalCost() + ' · враг платит дань верностью'));
          vc.appendChild(tx); vc.appendChild(ico('crown', 16));
          vas.appendChild(vc);
        }
      }
      const t = peaceTotals();
      bud.set(t.cost / Math.max(1, t.allow), t.cost + ' / ' + num(t.allow) + ' очков войны', t.cost <= t.allow + 1e-9 ? '#58e08a' : '#ff5b5b');
      offer.disabled = !(p.picks.length || p.vassal) || t.cost > t.allow + 1e-9;
      setText(offer.lastChild, p.picks.length || p.vassal ? 'Предложить' : 'Выберите регионы');
      force.disabled = false;
      if (p.result) { res.className = 'pc-res ' + p.result.kind; setText(res, p.result.text); } else res.className = 'pc-res hide';
    };
    v.ups.push(() => {
      if (!w) return;
      const ms = warScore(p.warId, kid), es = ek ? warScore(p.warId, ek.id) : 0;
      bMe.set(ms / 100, num(ms), me ? me.color : '#58c7ff');
      bEn.set(es / 100, num(es), ek ? ek.color : '#ff5b5b');
      // regions that became held / lost since the sheet opened
      const held = safe(() => War.heldRegions(p.warId, kid), []);
      if (held.join(',') !== p.held.join(',')) {
        p.held = held.slice();
        p.picks = p.picks.filter((r) => held.indexOf(r) >= 0);
        p.goals.forEach((r) => { if (p.list.indexOf(r) < 0) p.list.push(r); });
        held.forEach((r) => { if (p.list.indexOf(r) < 0) p.list.push(r); });
        p.cand = held.filter((r) => p.picks.indexOf(r) < 0);
        rcSync(); p.render(true);
      } else p.render(false);
    });
    p.render(true);
    runUps(v.ups);
  }

  // ------------------------------------------------------------------ map taps in command mode
  function clearSelection() {
    let changed = false;
    if (cm.armyId) { cm.armyId = 0; cm.targets = NONE; cm.tgSig = ''; changed = true; }
    if (cm.selRegion) { cm.selRegion = 0; changed = true; }
    if (cm.pop) { dismissPop(); changed = true; }
    if (changed) { rcSync(); updatePage(); }
  }
  function cmdTap(tx, ty) {
    if (insp) { closeInspector(); if (cm.kid) return; }
    dismissPop();
    const sp = Render.tileToScreen(tx, ty);
    const aid = safe(() => Render.armyAtScreen(sp.x, sp.y), 0);
    const rid = safe(() => Render.regionAt(tx, ty), 0);
    if (cm.goal) { if (rid) toggleGoal(rid); return; }
    if (cm.peace) { if (rid) togglePick(rid); return; }
    if (aid) {
      const a = S.armies.get(aid);
      if (a && !cm.kid && kget(a.kingdomId)) { if (commandKingdom(a.kingdomId, { focus: false })) { cm.page = 'armies'; selectArmy(aid, { focus: false }); setPage('armies'); } return; }
      if (a && a.kingdomId === cm.kid) { selectArmy(aid, { focus: false }); return; }
    }
    if (!cm.kid) {
      const t = safe(() => Powers.kingdomAt(tx, ty), null);
      if (t && t.kid) { commandKingdom(t.kid, {}); return; }
      if (rid) toast('Это ничья земля. Тапните по королевству, чтобы взять его под командование.', undefined);
      return;
    }
    if (!rid) { clearSelection(); return; }
    const r = regionOf(rid); if (!r) return;
    if (cm.armyId && orderTap(rid)) return;
    // no army selected: region card with actions
    const o = r.ownerId ? kget(r.ownerId) : null;
    cm.selRegion = rid; rcSync();
    const btns = [];
    if (o && o.id !== cm.kid) btns.push({ label: 'Командовать', icon: 'command', cls: 'primary', fn: () => commandKingdom(o.id, {}) });
    btns.push({ label: 'О регионе', icon: 'region', fn: () => openInspector('region', rid, { push: true }) });
    const ctl = r.controllerId && r.controllerId !== r.ownerId ? kget(r.controllerId) : null;
    showPop(rid, r.name, (o ? (o.id === cm.kid ? 'ваш регион' : '«' + o.name + '»') : 'ничья земля') + (ctl ? ' · занят «' + ctl.name + '»' : ''), r.ownerId, btns);
  }
  function cmdPaint(tx, ty, phase) {
    if (phase === 'start') { cmdPaint.moved = false; cmdPaint.x = tx; cmdPaint.y = ty; }
    else if (phase === 'move') cmdPaint.moved = true;
    else if (phase === 'end' && !cmdPaint.moved) cmdTap(cmdPaint.x, cmdPaint.y);
  }

  // ------------------------------------------------------------------ live refresh
  function updateCmd() {
    if (!cm.kid) return;
    if (insp) return;
    const k = kget(cm.kid);
    if (!k) { toast('Командуемое королевство пало', 'bad'); releaseCommand(true); return; }
    updatePop();
    if (cm.armyId && !armyById(cm.armyId)) { cm.armyId = 0; cm.targets = NONE; cm.tgSig = ''; rcSync(); }
    else if (cm.armyId && (++cm.tick & 3) === 0) refreshTargets();
    if (cm.goal) {
      const g = cm.goal;
      const tk = kget(g.targetKid);
      const w = g.warId ? safe(() => War.get(g.warId), null) : null;
      if (!tk || (g.warId && (!w || w.ended))) { toast('Цель больше недоступна', 'bad'); cancelGoal(); return; }
      if (!g.warId && safe(() => War.atWar(cm.kid, g.targetKid), false)) { cancelGoal(); return; }
      if (cm.view && cm.view.ups) runUps(cm.view.ups);
      g.render && g.render();
      return;
    }
    if (cm.peace) {
      const w = safe(() => War.get(cm.peace.warId), null);
      if (!w || w.ended) { cm.peace = null; cm.tkid = 0; rcSync(); showCmdSheet(); toast('Война окончена', undefined); return; }
      if (cm.view && cm.view.ups) runUps(cm.view.ups);
      return;
    }
    const v = cm.view; if (!v) return;
    runUps(v.ups); runUps(v.pups);
  }
  function initCommandHooks() {
    Bus.on('warDeclared', (w) => {
      if (!cm.kid || !w || wside(w, cm.kid) !== 2) return;
      const ag = kget(w.aggressor);
      if (w.defender === cm.kid || w.defenders.indexOf(cm.kid) >= 0) toast('На вас напали' + (ag ? ': «' + ag.name + '»' : '') + '! Армии защищают регионы сами — или отдайте приказы.', 'bad');
    });
    Bus.on('regionControl', (r, oldK, newK) => {
      if (!cm.kid || !r || newK !== cm.kid || !r.ownerId || r.ownerId === cm.kid) return;
      toast('Регион «' + r.name + '» занят — армия удерживает его', 'good');
      hintOnce('holdinfo', 'Армия держит позицию и дальше не идёт. Война продолжается, пока вы не заключите мир («Мир» в карточке войны).');
    });
    Bus.on('warEnded', (w, how) => {
      if (!cm.kid || !w || wside(w, cm.kid) === 0) return;
      if (cm.peace && cm.peace.warId === w.id) return;
      if (cm.goal && cm.goal.warId === w.id) return;
      toast(how === 'exhaustion' || how === 'collapse' ? 'Война закончилась: стороны истощены' : 'Война закончилась', undefined);
    });
  }

  // ------------------------------------------------------------------ lifecycle
  function init() {
    if (ready) return;
    refs.top = $('top'); refs.topwrap = $('topwrap'); refs.yearVal = $('yearVal'); refs.counters = $('counters'); refs.speeds = $('speeds');
    refs.pausedTag = $('pausedTag'); refs.menuBtn = $('btnMenu'); refs.feed = $('feed'); refs.bottom = $('bottom'); refs.fabs = $('fabs');
    refs.toasts = $('toasts'); refs.sheet = $('sheet'); refs.dock = $('dock'); refs.tabs = $('tabs'); refs.kbar = $('kbar'); refs.tools = $('tools');
    refs.hint = $('hint'); refs.brushbox = $('brushbox'); refs.modals = $('modals'); refs.pops = $('pops');
    refs.toolswrap = $('toolswrap'); refs.moreR = $('tmoreR'); refs.moreL = $('tmoreL');
    if (refs.moreR) { refs.moreR.appendChild(ico('chevron_up', 16)); refs.moreL.appendChild(ico('chevron_up', 16)); }
    safe(() => Kingdoms.setCommanded(0, false), 0);            // a save made while commanding must not leave the AI of that kingdom switched off
    loadPrefs();
    document.body.classList.add('ui-on');
    buildTop();
    buildTabs();
    buildBrush();
    buildFabs();
    ready = true;
    selectTab(state.tab);
    Bus.on('log', (e) => { if (ready) { feed.pending.push(e); if (feed.pending.length > 24) feed.pending.splice(0, feed.pending.length - 24); } });
    document.addEventListener('click', (ev) => { const b = ev.target && ev.target.closest ? ev.target.closest('button') : null; if (b && ev.detail > 0) b.blur(); });
    // keyboard shortcuts (desktop testing)
    window.addEventListener('keydown', (ev) => {
      if (ev.target && /^(INPUT|TEXTAREA)$/.test(ev.target.tagName)) return;
      if (ev.key === 'Escape') {
        if (modals.length) modals[modals.length - 1].close();
        else if (cm.pop) dismissPop();
        else if (insp) closeInspector();
        else if (cm.goal) cancelGoal();
        else if (cm.peace) closePeace();
        else if (cm.kid) releaseCommand();
      }
      else if (ev.key === ' ') { ev.preventDefault(); Main.setSpeed(Main.getSpeed() === 0 ? 1 : 0); }
    });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => layoutSoon());
      ro.observe(refs.bottom); ro.observe(refs.top);
    }
    window.addEventListener('resize', layoutSoon);
    window.addEventListener('orientationchange', () => { setTimeout(layoutSoon, 250); });
    feed.lastId = S.nextLogId - 1;
    initCommandHooks();
    refs.tools.addEventListener('scroll', updateToolsHint, { passive: true });
    layout();
    updateTop();
    if (!(navigator && navigator.webdriver)) setTimeout(() => { if (!prefs.seen.peek && peekTools()) { prefs.seen.peek = 1; savePrefs(); } }, 2600);
    // first-run hint
    setTimeout(() => { if (state.tab === 'powers' && !insp && !cm.kid) hintOnce('welcome', 'Выберите силу внизу — или тапните по жителю, чтобы осмотреть его'); }, 1200);
  }
  function update(dtMs) {
    if (!ready) return;
    const now = performance.now();
    try { flushFeed(now); fadeFeed(now); } catch (e) { /* keep running */ }
    accFast += dtMs; accStats += dtMs; accSlow += dtMs;
    if (accFast >= 250) {
      accFast = 0;
      try {
        if (accStats >= 250) { accStats = 0; Sim.stats(); }
        updateTop();
        updateInspector();
        updateCmd();
      } catch (e) { reportOnce('ui.fast', e); }
    }
    if (accSlow >= 1000) {
      accSlow = 0;
      try {
        if (state.tab === 'kingdoms') updateChips(false);
        if (logPanel) logPanel.refresh();
        if (statsPanel) statsPanel.refresh();
      } catch (e) { reportOnce('ui.slow', e); }
    }
  }
  const warned = {};
  function reportOnce(k, e) { if (!warned[k]) { warned[k] = 1; console.error(k, e); } }
  function onWorldReplaced() {
    if (!ready) return;
    cm.goal = null; cm.peace = null; dismissPop();
    releaseCommand(true);
    cm.kid = 0; cm.view = null; cm.rc = null; Render.cmd = null; tmpCmd = null; rhl.rid = 0;
    safe(() => Kingdoms.setCommanded(0, false), 0);
    closeInspector();
    closeAllModals();
    clearFeed();
    feed.lastId = S.nextLogId - 1;
    Render.highlight = null; Render.brush = null;
    chipMap = new Map(); chipSig = '';
    if (state.tab === 'kingdoms') renderKBar();
    dockCache.year = -1; dockCache.kingdoms = -1; dockCache.wars = -1; dockCache.pop = [-1, -1, -1];
    updateTop();
    layoutSoon();
  }

  return {
    init, update, toast, state, handleTap, handlePaint, openInspector, closeInspector, onWorldReplaced,
    // stage 2: command mode
    commandKingdom, releaseCommand, startGoalMode, openPeace, selectArmy, setRegionHL, setPage,
    get cmdKid() { return cm.kid; },
    get cmd() { return { kid: cm.kid, page: cm.page, goal: cm.goal ? { targetKid: cm.goal.targetKid, warId: cm.goal.warId, goals: cm.goal.goals.slice(), cand: cm.goal.cand.slice() } : null, peace: cm.peace ? { warId: cm.peace.warId, picks: cm.peace.picks.slice(), held: cm.peace.held.slice() } : null, armyId: cm.armyId, selRegion: cm.selRegion, pop: !!cm.pop }; },
    // extras
    openMenu, openLog, openWorld, openHelp, selectTab, selectTool, setMode, setBrush, layout, focusVisible, ensureVisible, visibleCenter, bandInfo, modalOpen, closeAllModals,
    get inspector() { return insp ? { type: insp.type, id: insp.id } : null; },
    get ready() { return ready; },
  };
})();
