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
 *  UI.openInspector(type,id)    type: unit | building | city | kingdom | tile (tile id = y*S.w+x)
 *  UI.onWorldReplaced()         Main calls it after Sim.newWorld / Save.load
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
  const SHORT = { earthquake: 'Землетр.', bless: 'Благосл.', war_whisper: 'Шёпот', lightning: 'Молния', split: 'Раскол' };
  const GROUP_LABEL = { terrain: 'Рельеф', creatures: 'Существа', destroy: 'Разрушение', bless: 'Благословение', diplomacy: 'Дипломатия', info: 'Осмотр' };
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
  function hintOnce(key, text) { if (seenOnce(key)) toast(text); }

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
    state.tool = remembered && ToolDefs.byId[remembered] && ToolDefs.byId[remembered].tab === id ? remembered : (id === 'info' ? 'inspect' : null);
    renderTools();
    renderKBar();
    layoutSoon();
  }
  function selectTool(id) {
    const def = ToolDefs.byId[id];
    if (!def) return;
    state.tool = id;
    tabTool[def.tab] = id;
    syncToolSel();
    Render.brush = null;
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
        const b = btn('kchip', k.name, () => { const kk = S.kingdoms.get(k.id); if (kk) { openInspector('kingdom', k.id, { focus: true }); } });
        const fl = flagEl(k.flag, 24);
        const kn = el('span', 'kn'); const nm = el('b'); const sm = el('small');
        kn.appendChild(nm); kn.appendChild(sm);
        b.appendChild(fl); b.appendChild(kn);
        ch = { b, fl, nm, sm };
        chipMap.set(k.id, ch);
      }
      ch.b.style.setProperty('--kc', k.color);
      drawFlag(ch.fl, k.flag);
      setText(ch.nm, k.name);
      const war = kingdomAtWar(k.id);
      const txt = x.pop + ' жит. · ' + k.cities.length + ' гор.' + (war ? ' · ' : '');
      if (ch.sm._t !== txt + war) {
        ch.sm._t = txt + war;
        ch.sm.textContent = txt;
        if (war) ch.sm.appendChild(el('u', '', 'война'));
      }
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
    barRow(v, bg, 'Стабильность', () => { const k = get(); return k ? k.stability / 100 : 0; }, () => { const k = get(); return k ? num(k.stability) + '%' : '—'; }, hpColor);

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
      return relationsOf(id).map((r) => r.other + ':' + r.state).join(',') + '|' + warsOf(id).map((w) => w.id).join(',');
    }, (node) => {
      relBars.length = 0;
      const rels = relationsOf(id).filter((r) => S.kingdoms.has(r.other));
      rels.sort((a, b) => (b.state === 2) - (a.state === 2) || b.opinion - a.opinion);
      if (!rels.length) { node.appendChild(el('div', 'muted', 'Нет контактов с другими королевствами')); return; }
      rels.forEach((r) => {
        const ok = S.kingdoms.get(r.other);
        const row = el('div', 'relrow');
        row.appendChild(kingdomLink(ok));
        const bar = el('div', 'bar mid'); const tr = el('div', 'track'); const fill = el('div', 'fill'); const tx = el('div', 'txt');
        tr.appendChild(fill); tr.appendChild(tx); bar.appendChild(tr); row.appendChild(bar);
        const st = el('span', 'rs');
        if (r.state === Const.REL.WAR) { st.appendChild(ico('sword', 16)); st.title = 'Война'; }
        else if (r.state === Const.REL.ALLIANCE) { st.appendChild(ico('heart', 16)); st.title = 'Союз'; }
        row.appendChild(st);
        node.appendChild(row);
        relBars.push({ other: r.other, fill, tx });
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
      });
    });
    const s4 = sec(v, 'Войны');
    const wl = el('div', 'chips'); s4.appendChild(wl);
    slot(v, wl, () => warsOf(id).map((w) => w.id).join(','), (node) => {
      const ws = warsOf(id);
      ws.forEach((w) => {
        const enemies = ((w.attackers || []).indexOf(id) >= 0 ? w.defenders : w.attackers) || [];
        const names = enemies.map((e) => { const kk = S.kingdoms.get(e); return kk ? kk.name : null; }).filter(Boolean);
        node.appendChild(el('span', 'chip bad', 'Война: ' + (names.length ? names.join(', ') : '—')));
      });
      if (!ws.length) node.appendChild(el('span', 'muted', 'Мирное время'));
    });
    const s5 = sec(v, 'История');
    histList(v, s5, () => { const k = get(); return k ? k.hist : null; });
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
    Render.highlight = v.hl ? Object.assign({}, v.hl) : null;
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
    Render.highlight = w.hl ? Object.assign({}, w.hl) : null;
    const f = w.focus ? w.focus() : null;
    if (f) requestAnimationFrame(() => ensureVisible(f.x, f.y));
  }
  function renderSheet() {
    const sh = refs.sheet;
    clear(sh);
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
    refs.bottom.classList.remove('sheet-open');
    clear(refs.sheet);
    layoutSoon();
  }
  function inspectAt(tx, ty, explicit) {
    const p = Powers.pick(tx, ty);
    if (!p) { return; }
    if (p.type === 'tile' && !explicit) { closeInspector(); return; }
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
    if (!tool || tool === 'inspect') { inspectAt(tx, ty, tool === 'inspect'); return; }
    if (insp) closeInspector();                        // the dock (with the active tool) comes back
    applyTool(tool, tx, ty, 'tap');
  }
  function handlePaint(tx, ty, phase) {
    if (!ready || modalOpen()) return;
    const tool = state.tool;
    if (!tool || tool === 'inspect') { if (phase === 'start') inspectAt(tx, ty, tool === 'inspect'); return; }
    if (insp) closeInspector();
    applyTool(tool, tx, ty, phase);
    if (phase === 'end') { clearTimeout(brushTimer); brushTimer = setTimeout(() => { Render.brush = null; }, 350); }
  }

  // ------------------------------------------------------------------ lifecycle
  function init() {
    if (ready) return;
    refs.top = $('top'); refs.topwrap = $('topwrap'); refs.yearVal = $('yearVal'); refs.counters = $('counters'); refs.speeds = $('speeds');
    refs.pausedTag = $('pausedTag'); refs.menuBtn = $('btnMenu'); refs.feed = $('feed'); refs.bottom = $('bottom'); refs.fabs = $('fabs');
    refs.toasts = $('toasts'); refs.sheet = $('sheet'); refs.dock = $('dock'); refs.tabs = $('tabs'); refs.kbar = $('kbar'); refs.tools = $('tools');
    refs.hint = $('hint'); refs.brushbox = $('brushbox'); refs.modals = $('modals');
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
      if (ev.key === 'Escape') { if (modals.length) modals[modals.length - 1].close(); else closeInspector(); }
      else if (ev.key === ' ') { ev.preventDefault(); Main.setSpeed(Main.getSpeed() === 0 ? 1 : 0); }
    });
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => layoutSoon());
      ro.observe(refs.bottom); ro.observe(refs.top);
    }
    window.addEventListener('resize', layoutSoon);
    window.addEventListener('orientationchange', () => { setTimeout(layoutSoon, 250); });
    feed.lastId = S.nextLogId - 1;
    layout();
    updateTop();
    // first-run hint
    setTimeout(() => hintOnce('welcome', 'Выберите силу внизу — или тапните по жителю, чтобы осмотреть его'), 1200);
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
    // extras
    openMenu, openLog, openWorld, openHelp, selectTab, selectTool, setMode, setBrush, layout, focusVisible, ensureVisible, visibleCenter, bandInfo, modalOpen, closeAllModals,
    get inspector() { return insp ? { type: insp.type, id: insp.id } : null; },
    get ready() { return ready; },
  };
})();
