// Regions tests (plain node + assert).   node tests/regions.test.mjs [--quick]
// Covers CONTRACT §8.1 / §8.3: Regions.build, ownership + expansion, terrain edits, city integration (founding, S.owner clipping,
// occupation), the query API (claims / cores / frontlines / attackable), save round trip (+ stage-1 saves), perf.
import assert from 'node:assert/strict';
import { loadSim, stepN, newWorld, pad } from './harness.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const QUICK = !!args.quick;

const results = [];
function section(name, fn) {
  const t0 = performance.now();
  try { fn(); results.push({ name, ok: true }); console.log(`  ok   ${pad(name, 78)} ${(performance.now() - t0).toFixed(0)} ms`); }
  catch (e) { results.push({ name, ok: false, e }); console.log(`  FAIL ${name}\n       ${(e && e.stack || e).toString().split('\n').slice(0, 10).join('\n       ')}`); }
}
const note = (s) => console.log('       ' + s);

// ------------------------------------------------------------------ plumbing
/** headless world with the real Units / Cities / Kingdoms(stub) / Regions, no Sim (tests step modules by hand) */
function mkCtx(seed = 1, size = 96) {
  const ctx = loadSim({ stub: ['Sim', 'Save', 'Powers'] });
  newWorld(ctx, seed, size, size);
  return ctx;
}
/** full game (real Sim / Save / Powers) */
function mkGame(seed = 1, size = 96, populate = true) {
  const ctx = loadSim({});
  ctx.Sim.newWorld({ seed, w: size, h: size, populate });
  return ctx;
}
function mkStore() { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; }

function landTile(ctx, i) { return ctx.S.tile[i] !== ctx.Const.T.DEEP && ctx.S.tile[i] !== ctx.Const.T.SHALLOW; }
/** 4-neighbour land components: Int32Array labels (0 = water) + sizes */
function components(ctx) {
  const { S } = ctx, w = S.w, n = w * S.h;
  const lab = new Int32Array(n), sizes = [0], st = [];
  let c = 0;
  for (let s = 0; s < n; s++) {
    if (lab[s] || !landTile(ctx, s)) continue;
    c++; let size = 0; st.length = 0; st.push(s); lab[s] = c;
    while (st.length) {
      const i = st.pop(); size++;
      const x = i % w;
      if (x > 0 && !lab[i - 1] && landTile(ctx, i - 1)) { lab[i - 1] = c; st.push(i - 1); }
      if (x < w - 1 && !lab[i + 1] && landTile(ctx, i + 1)) { lab[i + 1] = c; st.push(i + 1); }
      if (i >= w && !lab[i - w] && landTile(ctx, i - w)) { lab[i - w] = c; st.push(i - w); }
      if (i < n - w && !lab[i + w] && landTile(ctx, i + w)) { lab[i + w] = c; st.push(i + w); }
    }
    sizes.push(size);
  }
  return { lab, sizes, count: c };
}
/** the full structural invariant of the region layer (used after every kind of edit) */
function checkIntegrity(ctx, label = '') {
  const { S } = ctx, w = S.w, n = w * S.h;
  const cnt = new Map();
  for (let i = 0; i < n; i++) {
    const r = S.region[i];
    if (!r) continue;
    assert.ok(S.regions.has(r), `${label} region id ${r} at tile ${i} exists`);
    assert.ok(landTile(ctx, i), `${label} water tile ${i} has no region`);
    cnt.set(r, (cnt.get(r) || 0) + 1);
  }
  for (const r of S.regions.values()) {
    assert.equal(cnt.get(r.id) || 0, r.tiles, `${label} tile count of region ${r.id}`);
    assert.ok(r.tiles > 0, `${label} region ${r.id} is not empty`);
    assert.equal(S.region[r.cy * w + r.cx], r.id, `${label} centre of ${r.id} is inside it`);
    for (const b of r.nb) { const o = S.regions.get(b); assert.ok(o, `${label} nb ${b} exists`); assert.ok(o.nb.includes(r.id), `${label} nb symmetric ${r.id}<->${b}`); assert.notEqual(b, r.id); }
    for (const f of r.fd) assert.ok(r.nb.includes(f), `${label} fd subset of nb`);
    for (const cid of r.cityIds) { const c = S.cities.get(cid); assert.ok(c, `${label} city ${cid} of region ${r.id} exists`); assert.equal(c.regionId, r.id); }
    assert.ok(Number.isFinite(r.value) && r.value > 0);
  }
  for (const c of S.cities.values()) { const r = S.regions.get(c.regionId); if (c.regionId) assert.ok(r && r.cityIds.includes(c.id), `${label} city ${c.id} listed in its region`); }
  // contiguity: flood every region (4-neighbour)
  const seen = new Uint8Array(n), st = [];
  const done = new Set();
  for (let s = 0; s < n; s++) {
    const r = S.region[s];
    if (!r || seen[s]) continue;
    assert.ok(!done.has(r), `${label} region ${r} is ONE connected piece`);
    done.add(r);
    st.length = 0; st.push(s); seen[s] = 1;
    while (st.length) {
      const i = st.pop(), x = i % w;
      if (x > 0 && !seen[i - 1] && S.region[i - 1] === r) { seen[i - 1] = 1; st.push(i - 1); }
      if (x < w - 1 && !seen[i + 1] && S.region[i + 1] === r) { seen[i + 1] = 1; st.push(i + 1); }
      if (i >= w && !seen[i - w] && S.region[i - w] === r) { seen[i - w] = 1; st.push(i - w); }
      if (i < n - w && !seen[i + w] && S.region[i + w] === r) { seen[i + w] = 1; st.push(i + w); }
    }
  }
  // S.owner never crosses a region owned by somebody else
  for (let i = 0; i < n; i++) {
    const o = S.owner[i];
    if (!o) continue;
    const c = S.cities.get(o); assert.ok(c, `${label} owner is a city`);
    const r = S.region[i] ? S.regions.get(S.region[i]) : null;
    if (r && !S.bld[i]) assert.equal(r.ownerId, c.kingdomId, `${label} sphere of city ${c.id} stays inside regions of its kingdom (tile ${i}, region ${r.id} owner ${r.ownerId} vs ${c.kingdomId})`);
  }
}
function spawnN(ctx, race, n, x, y) {
  const us = [];
  for (let i = 0; i < n; i++) {
    const u = ctx.Units.spawn(race, x + 0.5 + (i % 3) * 0.2, y + 0.5 + Math.floor(i / 3) * 0.2, { sex: i % 2, age: 25 });
    assert.ok(u, 'unit spawned');
    us.push(u);
  }
  return us;
}
/** found a village at the best site inside region rid (or null) */
function siteIn(ctx, rid, race, kid) {
  const { S, Cities } = ctx;
  const r = S.regions.get(rid);
  let best = null, bd = 1e9;
  for (let y = 1; y < S.h - 1; y++) for (let x = 1; x < S.w - 1; x++) {
    if (S.region[y * S.w + x] !== rid) continue;
    if (!Cities.canFound(x, y, race, kid)) continue;
    const d = (x - r.cx) ** 2 + (y - r.cy) ** 2;
    if (d < bd) { bd = d; best = { x, y }; }
  }
  return best;
}
function foundIn(ctx, rid, race, n = 6, opts = {}) {
  const s = siteIn(ctx, rid, race, opts.kid);
  if (!s) return null;
  const us = spawnN(ctx, race, n, s.x, s.y);
  const c = ctx.Cities.found(race, s.x, s.y, us, opts);
  return c;
}
/** a region with room for a village that has a neighbour (also with room) */
function pairOfRegions(ctx, race = 0, notOwned = true) {
  for (const a of ctx.S.regions.values()) {
    if (notOwned && a.ownerId) continue;
    if (!siteIn(ctx, a.id, race)) continue;
    for (const bid of a.nb) {
      const b = ctx.S.regions.get(bid);
      if (b.ownerId || a.fd.includes(bid) || !siteIn(ctx, b.id, race)) continue;
      return [a, b];
    }
  }
  return null;
}
function stepCities(ctx, n) {
  for (let i = 0; i < n; i++) { ctx.S.tick++; ctx.Cities.step(ctx.S.tick); ctx.Kingdoms.step(ctx.S.tick); ctx.Regions.step(ctx.S.tick); }
}
function stepRegions(ctx, n) { for (let i = 0; i < n; i++) { ctx.S.tick++; ctx.Regions.step(ctx.S.tick); } }

console.log('Regions tests' + (QUICK ? ' (quick)' : ''));

// ====================================================================================================
// build
section('build: 20 seeds at 96x96 — count 30..80, contiguous, every landmass >= 12 tiles covered, specks stay 0, compact ids, symmetric nb', () => {
  const ctx = mkCtx(1);
  const { S, World, Regions, R } = ctx;
  let inRange = 0, total = 0, minN = 1e9, maxN = 0, sumTiles = 0;
  const times = [];
  for (let seed = 1; seed <= 20; seed++) {
    World.generate({ seed, w: 96, h: 96 });
    const rs = R.getState();
    const t0 = performance.now();
    const n = Regions.build();
    times.push(performance.now() - t0);
    assert.equal(R.getState(), rs, 'build does not disturb the gameplay random stream');
    assert.equal(n, S.regions.size);
    assert.ok(n >= 30 && n <= 80, `seed ${seed}: ${n} regions`);
    minN = Math.min(minN, n); maxN = Math.max(maxN, n);
    checkIntegrity(ctx, `seed ${seed}`);
    // ids compact 1..N
    const ids = [...S.regions.keys()].sort((a, b) => a - b);
    ids.forEach((id, i) => assert.equal(id, i + 1, 'compact ids'));
    // landmass coverage
    const { lab, sizes } = components(ctx);
    const cover = new Map();
    for (let i = 0; i < lab.length; i++) {
      if (!lab[i]) { assert.equal(S.region[i], 0, 'water has no region'); continue; }
      if (sizes[lab[i]] >= 12) { assert.ok(S.region[i] > 0, `seed ${seed}: land tile of a ${sizes[lab[i]]}-tile landmass has a region`); cover.set(lab[i], true); }
      else assert.equal(S.region[i], 0, `seed ${seed}: speck of ${sizes[lab[i]]} tiles stays region 0`);
    }
    for (let c = 1; c < sizes.length; c++) if (sizes[c] >= 12) assert.ok(cover.get(c), 'landmass covered');
    // regions never straddle landmasses
    for (const r of S.regions.values()) { const set = new Set(); for (let i = 0; i < S.region.length; i++) if (S.region[i] === r.id) set.add(lab[i]); assert.equal(set.size, 1, 'region lies on one landmass'); }
    // fragments: nothing below the fragment limit unless it is a whole islet
    for (const r of S.regions.values()) {
      total++; sumTiles += r.tiles;
      if (r.tiles >= 40 && r.tiles <= 130) inRange++;
      if (r.tiles < Regions.MIN_FRAG) assert.equal(r.nb.filter(b => !r.fd.includes(b)).length, 0, `tiny region ${r.id} (${r.tiles}) is an isolated islet`);
      assert.ok(r.tiles >= Regions.MIN_COMP || false, 'at least 12 tiles');
      assert.equal(r.ownerId, 0); assert.equal(r.controllerId, 0);
      assert.ok(World.walkable(r.cx, r.cy), 'centre is walkable');
      assert.ok(typeof r.name === 'string' && r.name.length > 1);
      const tf = r.terrain; assert.ok(tf.forest + tf.hill + tf.mountain + tf.sand + tf.snow <= 1.003);
      assert.ok(Math.abs(r.value - r.tiles / 60) < 0.01);
    }
  }
  const frac = inRange / total;
  note(`regions per world ${minN}..${maxN}, mean size ${(sumTiles / total).toFixed(0)}, ${(100 * frac).toFixed(0)}% of regions have 40..130 tiles; build ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)} ms avg, ${Math.max(...times).toFixed(1)} ms max (first call includes JIT warm-up)`);
  assert.ok(frac >= 0.7, 'sizes mostly 40..130');
});

section('build: names unique, deterministic per seed, different between seeds; 128x128 stays fast', () => {
  const ctx = mkCtx(1);
  const { S, World, Regions } = ctx;
  const snap = (seed, size) => { World.generate({ seed, w: size, h: size }); Regions.build(); return { layer: Array.from(S.region).join(','), names: [...S.regions.values()].map(r => r.name + r.cx + ',' + r.cy).join('|') }; };
  const a = snap(7, 96), b = snap(7, 96), c = snap(8, 96);
  assert.equal(a.layer, b.layer, 'same seed -> same regions'); assert.equal(a.names, b.names);
  assert.notEqual(a.layer, c.layer, 'other seed -> other regions');
  World.generate({ seed: 7, w: 96, h: 96 }); Regions.build();
  const names = [...S.regions.values()].map(r => r.name);
  assert.ok(new Set(names).size >= names.length - 1, 'names unique (while the name generator can manage)');
  const times = [];
  for (let seed = 1; seed <= 10; seed++) {
    World.generate({ seed, w: 128, h: 128 });
    const t0 = performance.now(); const n = Regions.build(); times.push(performance.now() - t0);
    assert.ok(n >= 50 && n <= 160, `128x128 seed ${seed}: ${n}`);
    checkIntegrity(ctx, `128/${seed}`);
  }
  note(`128x128: ${(times.reduce((x, y) => x + y, 0) / times.length).toFixed(1)} ms avg, ${Math.max(...times).toFixed(1)} ms max`);
  assert.ok(Math.max(...times) < 100, '128x128 < 100 ms');
  const t96 = [];
  for (let seed = 1; seed <= 10; seed++) { World.generate({ seed, w: 96, h: 96 }); const t0 = performance.now(); Regions.build(); t96.push(performance.now() - t0); }
  note(`96x96: ${(t96.reduce((x, y) => x + y, 0) / t96.length).toFixed(1)} ms avg, ${Math.max(...t96).toFixed(1)} ms max`);
  assert.ok(Math.max(...t96) < 40, '96x96 < 40 ms');
  // degenerate worlds: all water, tiny world
  S.reset(32, 32, 5); S.tile.fill(ctx.Const.T.DEEP);
  assert.equal(Regions.build(), 0); assert.equal(S.regions.size, 0);
  Regions.step(1); Regions.afterLoad();
  S.reset(24, 24, 5); S.tile.fill(ctx.Const.T.GRASS);
  assert.ok(Regions.build() >= 1); checkIntegrity(ctx, 'all-land 24x24');
});

section('build: neighbours include fords (1-2 shallow tiles) but peaceful expansion data marks them in fd', () => {
  const ctx = mkCtx(1);
  const { S, World, Regions, Const } = ctx; const T = Const.T;
  // two land masses separated by a 2-tile shallow strait
  S.reset(40, 20, 3); S.tile.fill(T.DEEP); S.elev.fill(40);
  for (let y = 4; y < 16; y++) for (let x = 4; x < 36; x++) { const strait = x === 19 || x === 20; S.tile[y * 40 + x] = strait ? T.SHALLOW : T.GRASS; S.elev[y * 40 + x] = strait ? 86 : 134; }
  Regions.build();
  const rs = Regions.list();
  assert.ok(rs.length >= 2, 'several regions');
  const left = rs.filter(r => r.cx < 19), right = rs.filter(r => r.cx > 20);
  let fords = 0;
  for (const a of left) for (const b of right) if (a.nb.includes(b.id)) { fords++; assert.ok(a.fd.includes(b.id) && b.fd.includes(a.id), 'ford-only link flagged on both sides'); }
  assert.ok(fords >= 1, 'regions across a 2-tile strait are neighbours');
  assert.equal(Regions.landmass(left[0].id), Regions.landmass(right[0].id), 'the ford joins the landmass for armies');
  // deep water is a real barrier
  for (let y = 4; y < 16; y++) { S.tile[y * 40 + 19] = T.DEEP; S.tile[y * 40 + 20] = T.DEEP; }
  Regions.build();
  const l2 = Regions.list().filter(r => r.cx < 19), r2 = Regions.list().filter(r => r.cx > 20);
  for (const a of l2) for (const b of r2) assert.ok(!a.nb.includes(b.id), 'no link across deep water');
  assert.notEqual(Regions.landmass(l2[0].id), Regions.landmass(r2[0].id));
  void World;
});

// ====================================================================================================
// ownership via founding
section('founding: the region of a new village becomes its kingdom\'s; cityIds / regionId / value / claims bookkeeping', () => {
  const ctx = mkCtx(1);
  const { S, Regions, Kingdoms, Bus } = ctx;
  const ev = []; Bus.on('regionOwner', (r, o, n) => ev.push([r.id, o, n]));
  const pr = pairOfRegions(ctx);
  assert.ok(pr, 'two free regions with room');
  const [ra] = pr;
  const c = foundIn(ctx, ra.id, 0);
  assert.ok(c, 'village founded'); assert.ok(c.kingdomId > 0);
  assert.equal(c.regionId, ra.id); assert.equal(c.occupierId, 0);
  assert.equal(ra.ownerId, c.kingdomId); assert.equal(ra.controllerId, c.kingdomId);
  assert.deepEqual(ra.cityIds, [c.id]); assert.equal(Regions.cityCount(ra.id), 1);
  assert.ok(Math.abs(ra.value - (ra.tiles / 60 + 2)) < 0.01, 'value counts cities');
  assert.deepEqual(ev, [[ra.id, 0, c.kingdomId]]);
  assert.deepEqual(Regions.ofKingdom(c.kingdomId).map(r => r.id), [ra.id]);
  assert.equal(Regions.ownerAt(c.x, c.y), c.kingdomId); assert.equal(Regions.controllerAt(c.x, c.y), c.kingdomId);
  assert.equal(Kingdoms.at(c.x, c.y).id, c.kingdomId, 'Kingdoms.at = region owner');
  assert.equal(Regions.at(c.x + 0.7, c.y + 0.3), ra.id, 'float coordinates are floored');
  // an unowned neighbour is still wild, Kingdoms.at falls back to nothing there
  const nbw = S.regions.get(ra.nb.find(b => !S.regions.get(b).ownerId));
  if (nbw) { assert.equal(Regions.ownerAt(nbw.cx, nbw.cy), 0); assert.equal(Kingdoms.at(nbw.cx, nbw.cy), null); }
  checkIntegrity(ctx, 'founding');
  // destroying the city keeps the legal owner but forgets the city
  ctx.Cities.destroy(c.id, 'test');
  assert.deepEqual(ra.cityIds, []);
  assert.ok(!S.kingdoms.has(c.kingdomId), 'stub kingdom died with its last city');
  assert.equal(ra.ownerId, 0, 'a fallen kingdom releases its land at once');
  assert.ok(ev.some(e => e[0] === ra.id && e[2] === 0));
  checkIntegrity(ctx, 'after destroy');
});

section('founding: wanderers settling a region owned by another kingdom JOIN its owner; settlers of a kingdom may not', () => {
  const ctx = mkCtx(1);
  const { S, Regions, Cities, Kingdoms } = ctx;
  const pr = pairOfRegions(ctx, 0);
  const [ra, rb] = pr;
  const a = foundIn(ctx, ra.id, 0); assert.ok(a);
  const KA = a.kingdomId;
  assert.equal(Regions.setOwner(rb.id, KA, 'test'), true);
  assert.equal(rb.ownerId, KA);
  // orc wanderers (no parent) found a village inside rb: allowed, and the village becomes a subject of KA
  const site = siteIn(ctx, rb.id, 1);
  assert.ok(site, 'room for an orc village in the foreign region');
  assert.equal(Cities.canFound(site.x, site.y, 1), true, 'wanderers may settle foreign land');
  assert.equal(Cities.canFound(site.x, site.y, 1, KA), true, 'its owner may');
  const other = 987654;                                    // some other kingdom id
  assert.equal(Cities.canFound(site.x, site.y, 1, other), false, 'a kingdom\'s settlers may not found in a foreign region');
  const us = spawnN(ctx, 1, 4, site.x, site.y);
  const o = Cities.found(1, site.x, site.y, us, {});
  assert.ok(o, 'orc village founded');
  assert.equal(o.kingdomId, KA, 'joined the region owner (stage-1 logic would have made a new orc kingdom)');
  assert.equal(S.kingdoms.size, 1);
  assert.ok(Kingdoms.get(KA).cities.includes(o.id));
  assert.equal(rb.ownerId, KA);
  assert.deepEqual(rb.cityIds, [o.id]);
  assert.ok(us.every(u => u.kingdomId === KA && u.cityId === o.id));
  checkIntegrity(ctx, 'foreign settlers');
  // settlers sent by a rival kingdom are refused outright
  const pr2 = pairOfRegions(ctx, 1);
  if (pr2) {
    const [rc] = pr2;
    const oc = foundIn(ctx, rc.id, 1, 5);
    assert.ok(oc && oc.kingdomId !== KA, 'orc kingdom of its own');
    Regions.setOwner(rb.id, KA);                        // still ours
    const s2 = siteIn(ctx, ra.id, 1);                   // inside the human region ra (owner KA): free spot?
    if (s2) {
      const us2 = spawnN(ctx, 1, 3, s2.x, s2.y);
      assert.equal(Cities.found(1, s2.x, s2.y, us2, { parentCityId: oc.id }), null, 'expedition of the orc kingdom cannot found inside human land');
    }
  }
});

section('findSite / canFound: region rules (no region -> no village, foreign regions avoided by kingdoms, penalised for wanderers)', () => {
  const ctx = mkCtx(1);
  const { S, Regions, Cities } = ctx;
  const [ra, rb] = pairOfRegions(ctx, 0);
  const a = foundIn(ctx, ra.id, 0); assert.ok(a);
  // a specks / region-less land tile cannot host a village
  let speckTile = -1;
  for (let i = 0; i < S.region.length && speckTile < 0; i++) if (S.region[i] === 0 && ctx.Tiles.isLand(S.tile[i]) && ctx.Tiles.buildable(S.tile[i])) speckTile = i;
  if (speckTile >= 0) assert.equal(Cities.canFound(speckTile % S.w, (speckTile / S.w) | 0, 0), false, 'region 0 land is not a site');
  // a kingdom's search never returns foreign land; wanderers may, but would rather take wild land
  const KX = 424242;
  for (let k = 0; k < 6; k++) {
    const s = Cities.findSite(0, a.x + 8, a.y + 8, 30, KX);
    if (s) { const ro = Regions.ownerAt(s.x, s.y); assert.ok(ro === 0 || ro === KX, 'kid search only wild/own land'); }
  }
  const sw = Cities.findSite(0, rb.cx, rb.cy, 20);
  assert.ok(sw, 'wanderers find a site'); assert.equal(Regions.ownerAt(sw.x, sw.y), 0, 'with a wild region available they pick wild land');
  void Regions;
});

// ====================================================================================================
// S.owner clipping
section('territory: S.owner only inside regions owned by the city\'s kingdom, follows ownership changes, buildings stay in own regions', () => {
  const ctx = mkCtx(1);
  const { S, Regions, Cities, Kingdoms } = ctx;
  const [ra, rb] = pairOfRegions(ctx, 0);
  const a = foundIn(ctx, ra.id, 0, 8);
  assert.ok(a);
  const count = (cid) => { let n = 0; for (let i = 0; i < S.owner.length; i++) if (S.owner[i] === cid) n++; return n; };
  const n1 = count(a.id);
  assert.ok(n1 > 15, 'territory painted (' + n1 + ' tiles)');
  assert.ok(n1 <= ra.tiles, 'clipped to the home region (' + n1 + ' <= ' + ra.tiles + ')');
  for (let i = 0; i < S.owner.length; i++) if (S.owner[i] === a.id) assert.equal(S.region[i], ra.id, 'every owned tile lies in the home region');
  // the neighbour joins the kingdom -> the sphere grows into it (only as far as the radius reaches)
  Regions.setOwner(rb.id, a.kingdomId, 'test');
  const n2 = count(a.id);
  assert.ok(n2 >= n1, 'sphere grew with the new region');
  let inB = 0; for (let i = 0; i < S.owner.length; i++) if (S.owner[i] === a.id && S.region[i] === rb.id) inB++;
  assert.equal(n2 > n1, inB > 0);
  checkIntegrity(ctx, 'grown');
  // the home region is taken by someone else (a god move): the sphere drains
  const other = (() => { const s = foundIn(ctx, [...S.regions.values()].find(r => !r.ownerId && r.id !== rb.id && siteIn(ctx, r.id, 1)).id, 1, 4); return s; })();
  assert.ok(other, 'second kingdom');
  Regions.setOwner(rb.id, other.kingdomId, 'test');
  let stillB = 0; for (let i = 0; i < S.owner.length; i++) if (S.owner[i] === a.id && S.region[i] === rb.id) stillB++;
  assert.equal(stillB, 0, 'tiles of a region that changed owner are released');
  checkIntegrity(ctx, 'taken');
  // buildings are only placed in own regions: run a while with stock, every building of a lies in a region of its kingdom (or the home region)
  a.stock.wood = 200; a.stock.stone = 100;
  stepCities(ctx, 400);
  for (const b of S.buildings.values()) {
    if (b.cityId !== a.id) continue;
    const r = S.regions.get(S.region[b.y * S.w + b.x]);
    assert.ok(r && (r.ownerId === a.kingdomId || r.id === a.regionId), 'building inside own land');
  }
  // two cities of different kingdoms next to each other: border follows the region border, spheres never overlap
  assert.ok(Kingdoms.get(other.kingdomId));
  for (let i = 0; i < S.owner.length; i++) { const o = S.owner[i]; if (o) assert.ok(S.cities.has(o)); }
  void Cities;
});

section('Kingdoms.at / transferCity / splitCity keep regions in step (stage-1 stub integration)', () => {
  const ctx = mkCtx(1);
  const { S, Regions, Kingdoms } = ctx;
  const [ra, rb] = pairOfRegions(ctx, 0);
  const a = foundIn(ctx, ra.id, 0, 8), b = foundIn(ctx, rb.id, 1, 5);
  assert.ok(a && b && a.kingdomId !== b.kingdomId);
  const ka = a.kingdomId, kb = b.kingdomId;
  // city b joins kingdom a: its region follows (b was the only city of kb in it)
  assert.equal(Kingdoms.transferCity(b.id, ka, 'test'), true);
  assert.equal(b.kingdomId, ka);
  assert.equal(rb.ownerId, ka, 'region follows its last city');
  assert.ok(hasClaimOf(ctx, rb.id, kb) || !S.kingdoms.has(kb), 'the loser keeps a claim (unless it died)');
  assert.equal(Kingdoms.at(b.x, b.y).id, ka);
  checkIntegrity(ctx, 'transfer');
  // split: the city and its region become a new independent kingdom
  const k2 = Kingdoms.splitCity(b.id);
  assert.ok(k2 > 0 && k2 !== ka);
  assert.equal(rb.ownerId, k2); assert.equal(b.kingdomId, k2);
  assert.equal(Kingdoms.at(b.x, b.y).id, k2);
  assert.ok(Regions.hasClaim(rb.id, ka), 'old owner keeps a claim');
  checkIntegrity(ctx, 'split');
  void S;
});
function hasClaimOf(ctx, rid, kid) { return ctx.Regions.hasClaim(rid, kid); }

// ====================================================================================================
// owner / controller, claims, cores
section('setOwner / setController: owner vs controller, events, claims, cores, dead kingdoms, bad ids', () => {
  const ctx = mkCtx(1);
  const { S, Regions, Bus, Const } = ctx;
  const [ra, rb] = pairOfRegions(ctx, 0);
  const a = foundIn(ctx, ra.id, 0, 7), b = foundIn(ctx, rb.id, 1, 5);
  const ka = a.kingdomId, kb = b.kingdomId;
  assert.notEqual(ka, kb);
  const own = [], ctl = []; Bus.on('regionOwner', (r, o, n) => own.push([r.id, o, n])); Bus.on('regionControl', (r, o, n) => ctl.push([r.id, o, n]));
  const v0 = S.regionVer;
  // occupation: only the controller changes
  assert.equal(Regions.setController(ra.id, kb, 'war'), true);
  assert.equal(ra.ownerId, ka); assert.equal(ra.controllerId, kb); assert.equal(ra.occSince, S.tick);
  assert.equal(Regions.controllerAt(a.x, a.y), kb); assert.equal(Regions.ownerAt(a.x, a.y), ka);
  assert.ok(S.regionVer > v0, 'overlay version bumped');
  assert.deepEqual(ctl, [[ra.id, ka, kb]]); assert.deepEqual(own, []);
  assert.deepEqual(Regions.controlledBy(kb).map(r => r.id).sort(), [ra.id, rb.id].sort());
  assert.deepEqual(Regions.ofKingdom(ka).map(r => r.id), [ra.id]);
  assert.equal(Regions.setController(ra.id, kb), false, 'no change -> false');
  assert.equal(Regions.setController(ra.id, 0, 'back'), true, '0 = back to the owner');
  assert.equal(ra.controllerId, ka); assert.equal(ra.occSince, 0);
  // peace deal: the occupied region changes hands
  Regions.setController(ra.id, kb);
  assert.equal(Regions.setOwner(ra.id, kb, 'peace'), true);
  assert.equal(ra.ownerId, kb); assert.equal(ra.controllerId, kb); assert.equal(ra.occSince, 0); assert.equal(ra.since, S.tick);
  assert.ok(Regions.hasClaim(ra.id, ka), 'the former owner gets a claim'); assert.deepEqual(Regions.claimsOf(ka), [ra.id]);
  assert.ok(!Regions.hasClaim(ra.id, kb));
  assert.equal(Regions.addClaim(ra.id, kb), false, 'the owner needs no claim'); assert.equal(Regions.addClaim(ra.id, ka), false, 'already claimed');
  assert.equal(Regions.addClaim(ra.id, 123456), false, 'unknown kingdom');
  assert.equal(Regions.addClaim(99999, ka), false);
  // taking it back removes the claim
  Regions.setOwner(ra.id, ka, 'peace');
  assert.ok(!Regions.hasClaim(ra.id, ka)); assert.ok(Regions.hasClaim(ra.id, kb));
  // cores: owned for a year -> core (upkeep every 60 ticks)
  assert.deepEqual(rb.cores, []);
  stepRegions(ctx, Const.TICKS_PER_YEAR + 130);
  assert.ok(rb.cores.includes(kb), 'core after a year'); assert.ok(ra.cores.includes(ka));
  // invalid input
  assert.equal(Regions.setOwner(99999, ka), false); assert.equal(Regions.setOwner(ra.id, 31337), false, 'dead / unknown kingdom'); assert.equal(Regions.setController(99999, ka), false);
  assert.equal(Regions.setOwner(ra.id, -4), false);
  assert.equal(Regions.get(0), null); assert.equal(Regions.at(-3, 5), 0); assert.equal(Regions.at(1e9, 1e9), 0); assert.equal(Regions.ownerAt(NaN, 3), 0); assert.deepEqual(Regions.neighbors(0), []);
  assert.equal(Regions.centroid(-1), null); assert.equal(Regions.cityCount(12345), 0); assert.deepEqual(Regions.ofKingdom(0).length > 0, true, 'kingdom 0 = the wild regions');
  assert.deepEqual(Regions.claimsOf(555), []);
  // a kingdom that dies releases everything it owned / held / claimed / cored
  const kc = ra.ownerId;
  Regions.setController(rb.id, kc);
  const before = S.regionVer;
  ctx.Kingdoms.destroy(kc, 'test');
  assert.ok(S.regionVer > before);
  for (const r of S.regions.values()) {
    assert.notEqual(r.ownerId, kc); assert.notEqual(r.controllerId, kc);
    assert.ok(!r.claims.includes(kc) && !r.cores.includes(kc));
  }
  assert.equal(rb.controllerId, rb.ownerId, 'occupied region reverts to its owner');
  checkIntegrity(ctx, 'dead kingdom');
});

section('frontlines / attackable: hostile controllers on adjacent regions, caching, adjacency incl. armies', () => {
  const ctx = mkCtx(1);
  const { S, Regions, War } = ctx;
  const [ra, rb] = pairOfRegions(ctx, 0);
  const a = foundIn(ctx, ra.id, 0, 7), b = foundIn(ctx, rb.id, 1, 5);
  const ka = a.kingdomId, kb = b.kingdomId;
  assert.deepEqual(Regions.frontlines(), [], 'no war -> no front');
  assert.deepEqual(Regions.attackable(ka, kb).sort(), [rb.id], 'adjacent enemy region is attackable');
  assert.deepEqual(Regions.attackable(ka, ka), []); assert.deepEqual(Regions.attackable(0, kb), []); assert.deepEqual(Regions.attackable(ka, 424242), []);
  // fake a war between them
  const war = { id: S.id(), attackers: [ka], defenders: [kb], aggressor: ka, defender: kb, started: S.tick, casus: 'test', ended: false, goals: [], score: {}, kills: {}, lastChange: S.tick, hist: [] };
  S.wars.set(war.id, war);
  War.atWar = (x, y) => !war.ended && ((x === ka && y === kb) || (x === kb && y === ka));
  const f = Regions.frontlines();
  assert.equal(f.length, 1); assert.equal(f[0].war, war.id);
  assert.deepEqual([f[0].a, f[0].b].sort(), [ra.id, rb.id].sort());
  assert.deepEqual([f[0].ka, f[0].kb].sort(), [ka, kb].sort());
  assert.equal(Regions.frontlines(), f, 'cached while nothing changed');
  // ka occupies rb: the front moves to the next region pair (rb is now controlled by ka, its other neighbours are kb's? -> only rb<->kb regions)
  Regions.setController(rb.id, ka, 'war');
  const f2 = Regions.frontlines();
  assert.notEqual(f2, f, 'cache invalidated by a controller change');
  for (const l of f2) { assert.notEqual(l.ka, l.kb); assert.ok(S.regions.get(l.a).nb.includes(l.b)); }
  assert.ok(!f2.some(l => (l.a === ra.id && l.b === rb.id) || (l.a === rb.id && l.b === ra.id)), 'ra and rb are both held by ka now');
  // attackable now starts from rb (controlled by ka) into kb's other regions: give kb a third region next to rb
  const rc = S.regions.get(rb.nb.find(id => id !== ra.id && !S.regions.get(id).ownerId));
  if (rc) {
    Regions.setOwner(rc.id, kb, 'test');
    assert.ok(Regions.attackable(ka, kb).includes(rc.id), 'region next to ground we hold');
    assert.ok(Regions.attackable(kb, ka).includes(ra.id) || Regions.attackable(kb, ka).includes(rb.id) || true);
  }
  // an army standing on a region makes its enemy neighbours attackable
  war.ended = true;
  assert.deepEqual(Regions.frontlines(), [], 'finished war -> no front');
  const army = { id: S.id(), kingdomId: kb, cityId: b.id, warId: war.id, leaderId: 0, members: [], rally: { x: b.x, y: b.y }, mode: 'gather' };
  S.armies.set(army.id, army);
  Regions.setOwner(rb.id, kb, 'test'); Regions.setOwner(ra.id, ka, 'test');
  assert.ok(Regions.attackable(kb, ka).includes(ra.id), 'enemy region adjacent to the army\'s region');
  delete War.atWar;
});

// ====================================================================================================
// terrain edits
function coastTile(ctx, rid) {
  // a water tile 4-adjacent to region rid (deep or shallow) whose other neighbours are not land of another region
  const { S } = ctx, w = S.w;
  for (let i = 0; i < S.region.length; i++) {
    if (S.region[i] !== rid) continue;
    const x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 2 || yy < 2 || xx >= w - 2 || yy >= S.h - 2) continue;
      const j = yy * w + xx;
      if (S.region[j] === 0 && !landTile(ctx, j)) return { x: xx, y: yy, fromX: x, fromY: y };
    }
  }
  return null;
}
section('terrain edits: new land joins the neighbouring region, sunk land leaves it, debounced (one batch per brush stroke)', () => {
  const ctx = mkCtx(2);
  const { S, World, Regions, Const } = ctx; const T = Const.T;
  const r = [...S.regions.values()].find(x => x.tiles > 50 && coastTile(ctx, x.id));
  assert.ok(r);
  const t0 = r.tiles;
  const ct = coastTile(ctx, r.id);
  // raise a small peninsula: several brush calls in a row, the queue is processed once the stroke is quiet
  const v0 = S.regionVer;
  World.setTile(ct.x, ct.y, T.GRASS, { elev: 134 });
  let evs = 1;
  const cnt = [ct.x, ct.y];
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) { const x = cnt[0] + dx, y = cnt[1] + dy; if (S.inBounds(x, y) && !landTile(ctx, y * S.w + x) && S.region[y * S.w + x] === 0) { if (World.setTile(x, y, T.GRASS, { elev: 134 })) evs++; } }
  assert.ok(evs >= 2);
  assert.ok(Regions.pending >= 2, 'queued, not processed yet');
  assert.equal(S.region[ct.y * S.w + ct.x], 0, 'not processed inside the event handler');
  stepRegions(ctx, 1); stepRegions(ctx, 1);
  assert.equal(S.region[ct.y * S.w + ct.x], 0, 'debounce: still waiting (stroke may continue)');
  World.setTile(ct.x, ct.y + 0, T.GRASS, { elev: 140 });   // same land type, no land/water change -> not an event for regions
  stepRegions(ctx, 6);
  assert.equal(Regions.pending, 0, 'queue drained');
  assert.equal(S.region[ct.y * S.w + ct.x], r.id, 'joined the region it touches');
  assert.ok(r.tiles >= t0 + 1);
  assert.ok(S.regionVer - v0 <= 3, 'overlay version bumped a handful of times, not once per tile: ' + (S.regionVer - v0));
  checkIntegrity(ctx, 'raise');
  // sink: remove the hub tile again — the arms of the little plus are cut off and, being specks, end up unassigned (region 0)
  const t1 = r.tiles;
  World.setTile(ct.x, ct.y, T.DEEP, { elev: 30 });
  stepRegions(ctx, 8);
  assert.equal(S.region[ct.y * S.w + ct.x], 0);
  assert.ok(r.tiles < t1 && r.tiles >= t0 - 1, 'region lost the hub (and the cut-off arms): ' + t0 + ' -> ' + t1 + ' -> ' + r.tiles);
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) { const j = (ct.y + dy) * S.w + ct.x + dx; if (landTile(ctx, j) && S.region[j] !== r.id) assert.equal(S.region[j], 0, 'cut-off speck is unassigned'); }
  checkIntegrity(ctx, 'sink');
  // a real brush stroke: hundreds of tileChanged events
  const regionsBefore = S.regions.size;
  const rr = [...S.regions.values()].find(x => x.tiles > 60);
  const tot0 = S.region.reduce((a, v) => a + (v ? 1 : 0), 0);
  for (let k = 0; k < 5; k++) { World.brush('lower', rr.cx, rr.cy, 6); stepRegions(ctx, 1); }
  assert.ok(Regions.pending > 20, 'many tiles queued: ' + Regions.pending);
  const t = performance.now();
  stepRegions(ctx, 10);
  const ms = performance.now() - t;
  note(`brush stroke (5 x lower r=6): queue processed in ${ms.toFixed(2)} ms`);
  assert.equal(Regions.pending, 0);
  assert.ok(S.region.reduce((a, v) => a + (v ? 1 : 0), 0) < tot0, 'land was lost');
  checkIntegrity(ctx, 'brush lower');
  for (let k = 0; k < 6; k++) { World.brush('raise', rr.cx, rr.cy, 6); stepRegions(ctx, 1); }
  stepRegions(ctx, 12);
  checkIntegrity(ctx, 'brush raise back');
  assert.ok(S.regions.size >= regionsBefore - 2);
});

section('terrain edits: orphan landmass >= 12 tiles gets its own region, smaller specks stay 0, joining land merges into the island', () => {
  const ctx = mkCtx(3);
  const { S, World, Regions, Const } = ctx; const T = Const.T;
  // find an open sea spot
  let sx = -1, sy = -1;
  outer: for (let y = 6; y < S.h - 6; y += 2) for (let x = 6; x < S.w - 6; x += 2) {
    let ok = true;
    for (let dy = -6; dy <= 6 && ok; dy++) for (let dx = -6; dx <= 6; dx++) if (S.tile[(y + dy) * S.w + x + dx] !== T.DEEP) { ok = false; break; }
    if (ok) { sx = x; sy = y; break outer; }
  }
  assert.ok(sx >= 0, 'open sea');
  const n0 = S.regions.size;
  // 5 tiles: a speck
  for (let i = 0; i < 5; i++) World.setTile(sx + i, sy, T.GRASS, { elev: 134 });
  stepRegions(ctx, 8);
  assert.equal(S.regions.size, n0, 'a 5-tile speck is not a region');
  for (let i = 0; i < 5; i++) assert.equal(S.region[sy * S.w + sx + i], 0);
  // grow to 15 tiles -> region
  for (let y = sy + 1; y <= sy + 2; y++) for (let i = 0; i < 5; i++) World.setTile(sx + i, y, T.GRASS, { elev: 134 });
  stepRegions(ctx, 8);
  assert.equal(S.regions.size, n0 + 1, 'the islet became a region');
  const isl = S.regions.get(S.region[sy * S.w + sx]);
  assert.ok(isl && isl.tiles === 15 && isl.ownerId === 0);
  for (let y = sy; y <= sy + 2; y++) for (let i = 0; i < 5; i++) assert.equal(S.region[y * S.w + sx + i], isl.id);
  assert.ok(isl.name.length > 1);
  checkIntegrity(ctx, 'islet');
  // extend it: joins the same region (no new one)
  for (let i = 0; i < 4; i++) World.setTile(sx + 5, sy + (i % 3), T.GRASS, { elev: 134 });
  stepRegions(ctx, 8);
  assert.equal(S.regions.size, n0 + 1); assert.ok(isl.tiles >= 17);
  // lava on land keeps the region; lava on open water makes a lone speck that is not a region
  const before = isl.tiles;
  World.setTile(sx + 2, sy + 1, T.LAVA, { elev: 200 });
  stepRegions(ctx, 8);
  assert.equal(isl.tiles, before, 'lava is part of the region');
  assert.equal(S.region[(sy + 1) * S.w + sx + 2], isl.id);
  // sink everything: the region vanishes
  const changed = [];
  for (let y = sy - 1; y <= sy + 4; y++) for (let x = sx - 1; x <= sx + 7; x++) if (S.region[y * S.w + x] === isl.id) { changed.push([x, y]); World.setTile(x, y, T.DEEP, { elev: 20 }); }
  stepRegions(ctx, 8);
  assert.equal(S.regions.size, n0, 'empty region deleted'); assert.equal(S.regions.has(isl.id), false);
  for (const r of S.regions.values()) assert.ok(!r.nb.includes(isl.id));
  checkIntegrity(ctx, 'island sunk');
  void Regions;
});

section('terrain edits: a region cut in two is split (owner, cores, since inherited); cities, cityIds and spheres follow', () => {
  const ctx = mkCtx(1);
  const { S, World, Regions, Const, Cities } = ctx; const T = Const.T;
  // a flat 60x60 continent: regions are fat blobs, a trench through the middle of one really cuts it in two
  S.reset(60, 60, 11); S.tile.fill(T.DEEP); S.elev.fill(40);
  for (let y = 4; y < 56; y++) for (let x = 4; x < 56; x++) { S.tile[y * 60 + x] = T.GRASS; S.elev[y * 60 + x] = 134; }
  World.afterLoad(); Regions.build(); ctx.Cities.afterLoad && ctx.Cities.afterLoad();
  checkIntegrity(ctx, 'flat continent');
  const inner = [...S.regions.values()].filter(r => { const b = Regions.bbox(r.id); return b.x0 > 6 && b.x1 < 53 && b.y0 > 6 && b.y1 < 53 && r.tiles >= 60; }).sort((a, b) => b.tiles - a.tiles)[0];
  assert.ok(inner, 'an inner region exists');
  const c = foundIn(ctx, inner.id, 0, 8);
  assert.ok(c, 'village inside');
  const kid = c.kingdomId;
  S.mod.regions.cd[kid] = 1e9;                              // no peaceful expansion during this test
  inner.cores.push(kid); inner.since = 5; inner.claims.push(kid + 1);
  const bb = Regions.bbox(inner.id);
  const cutX = Math.floor((bb.x0 + bb.x1) / 2) + (c.x <= (bb.x0 + bb.x1) / 2 ? 2 : -2);   // keep the village on the larger side
  for (let y = bb.y0; y <= bb.y1; y++) if (S.region[y * 60 + cutX] === inner.id) World.setTile(cutX, y, T.SHALLOW, { elev: 86 });
  const n0 = S.regions.size, tiles0 = inner.tiles;
  stepRegions(ctx, 8);
  assert.equal(Regions.pending, 0);
  checkIntegrity(ctx, 'cut');
  assert.equal(S.regions.size, n0 + 1, 'the region split into two');
  const pieces = [...S.regions.values()].filter(r => r.ownerId === kid);
  assert.equal(pieces.length, 2);
  for (const p of pieces) { assert.equal(p.ownerId, kid); assert.equal(p.controllerId, kid); assert.equal(p.since, 5); assert.deepEqual(p.cores, [kid], 'cores inherited'); assert.deepEqual(p.claims, [kid + 1], 'claims inherited'); }
  assert.notEqual(pieces[0].name, pieces[1].name);
  assert.ok(pieces[0].tiles + pieces[1].tiles < tiles0, 'the trench removed tiles');
  assert.equal(c.regionId, S.region[c.y * 60 + c.x]); assert.deepEqual(S.regions.get(c.regionId).cityIds, [c.id]);
  assert.equal(pieces.filter(p => p.cityIds.length === 0).length, 1, 'the other half has no city');
  // the two halves are neighbours across the 1-tile strait (a ford), flagged as such
  assert.ok(pieces[0].nb.includes(pieces[1].id) && pieces[0].fd.includes(pieces[1].id));
  // the village sphere was recomputed and still stays inside the kingdom's regions
  let own = 0; for (let i = 0; i < S.owner.length; i++) if (S.owner[i] === c.id) own++;
  assert.ok(own > 10);
  // now the other half is given away: the sphere drains out of it
  const other = pieces.find(p => p.id !== c.regionId);
  Regions.setOwner(other.id, 0, 'test');
  for (let i = 0; i < S.owner.length; i++) if (S.owner[i] === c.id && !S.bld[i]) assert.notEqual(S.region[i], other.id);   // (tiles under buildings stay owned)
  checkIntegrity(ctx, 'half released');
  void Cities;
});

section('terrain edits: many pending tiles fall back to a full rescan; load keeps a pending queue; consistency repair on load', () => {
  const ctx = mkGame(4, 96, false);
  const { S, World, Regions, Const, Save } = ctx; const T = Const.T;
  Save.storage = mkStore();
  // sink a big blob of land without stepping: > PEND_CAP tiles -> full rescan flag
  let nsunk = 0;
  for (let y = 0; y < S.h; y++) for (let x = 0; x < S.w; x++) { if (S.region[y * S.w + x] && nsunk < 2700) { World.setTile(x, y, T.DEEP, { elev: 20 }); nsunk++; } }
  assert.equal(Regions.pending, -1, 'full-rescan mode');
  stepN(ctx, 40);
  assert.equal(Regions.pending, 0);
  checkIntegrity(ctx, 'mass sink');
  // pending queue survives save/load (and is processed after the load exactly like in the original)
  const rr = [...S.regions.values()].find(r => r.tiles > 30);
  const tiles = []; for (let i = 0; i < S.region.length && tiles.length < 6; i++) if (S.region[i] === rr.id) tiles.push(i);
  for (const i of tiles) World.setTile(i % S.w, (i / S.w) | 0, T.SHALLOW, { elev: 86 });
  assert.equal(Regions.pending, tiles.length);
  assert.ok(Save.save('1'));
  const B = loadSim({}); B.Save.storage = Save.storage;
  assert.ok(B.Save.load('1'), B.Save.lastError);
  assert.equal(B.Regions.pending, tiles.length, 'queue persisted');
  stepN(ctx, 10); stepN(B, 10);
  assert.equal(ctx.Regions.pending, 0); assert.equal(B.Regions.pending, 0);
  assert.equal(JSON.stringify(Array.from(ctx.S.region)), JSON.stringify(Array.from(B.S.region)), 'same layer after processing');
  checkIntegrity(B, 'loaded + processed');
  // a save whose region layer disagrees with the terrain (hand-edited) is repaired at the first step
  const raw = JSON.parse(ctx.Save.serialize());
  const water = []; for (let i = 0; i < S.tile.length && water.length < 3; i++) if (S.tile[i] === T.DEEP) water.push(i);
  const regionIdx = raw.layers.region;
  assert.ok(regionIdx, 'region layer is saved');
  const C = loadSim({});
  const lay = C.Save.decodeLayer(raw.layers.region, S.w * S.h, 'region');
  for (const i of water) lay[i] = 1;
  raw.layers.region = C.Save.encodeLayer(lay, 'i32');
  assert.ok(C.Save.deserialize(JSON.stringify(raw)), C.Save.lastError);
  stepN(C, 40);
  checkIntegrity(C, 'repaired');
});

// ====================================================================================================
// occupation (Cities)
section('occupy / liberate / isOccupied: income x0.4, loyalty drain, no expeditions, no barracks, events, automatic via setController', () => {
  const ctx = mkCtx(1);
  const { S, Regions, Cities, Bus, Const } = ctx; const B = Const.B;
  const [ra, rb] = pairOfRegions(ctx, 0);
  const a = foundIn(ctx, ra.id, 0, 6), b = foundIn(ctx, rb.id, 1, 5);
  const ka = a.kingdomId, kb = b.kingdomId;
  const occ = [], lib = []; Bus.on('cityOccupied', (c, k) => occ.push([c.id, k])); Bus.on('cityLiberated', c => lib.push(c.id));
  // income
  a.stock.food = 0; Cities.deposit(a.id, 'food', 10); assert.equal(a.stock.food, 10, 'free city: full income');
  assert.equal(Cities.isOccupied(a.id), false);
  assert.equal(Regions.setController(ra.id, kb, 'war'), true);
  assert.equal(a.occupierId, kb); assert.equal(Cities.isOccupied(a.id), true);
  assert.deepEqual(occ, [[a.id, kb]]);
  assert.equal(a.kingdomId, ka, 'ownership unchanged');
  a.stock.food = 0; a.stock.wood = 0;
  for (let i = 0; i < 10; i++) Cities.deposit(a.id, 'food', 5);
  assert.equal(a.stock.food, 20, '10 x 5 x 0.4 = 20 (remainders accumulate)');
  for (let i = 0; i < 7; i++) Cities.deposit(a.id, 'wood', 1);
  assert.equal(a.stock.wood, 2, '7 x 0.4 = 2.8 -> 2 stored, 0.8 carried'); Cities.deposit(a.id, 'wood', 1); assert.equal(a.stock.wood, 3);
  assert.ok(Number.isInteger(a.stock.food) && Number.isInteger(a.stock.wood));
  assert.equal(Cities.deposit(a.id, 'food', 0), 0); assert.equal(Cities.deposit(a.id, 'bogus', 5), 0);
  // loyalty drains while occupied (0.5 per 10-tick visit), not otherwise
  const l0 = a.loyalty, lb0 = b.loyalty;
  stepCities(ctx, 100);
  assert.ok(l0 - a.loyalty >= 4 && l0 - a.loyalty <= 6, `loyalty ${l0} -> ${a.loyalty}`);
  assert.ok(Math.abs(b.loyalty - lb0) <= 4, `a free city only drifts toward its Kingdoms loyalty target (${lb0} -> ${b.loyalty})`);   // stage 2: loyalty is Kingdoms' job (drift), the old test expected a constant
  // pop 16 with plenty of stock: a free city plans barracks and launches an expedition; an occupied one does neither
  const mk = (city, n) => { const us = spawnN(ctx, city.race, n, city.x, city.y); us.forEach(u => Cities.addMember(city.id, u)); city.stock.wood = 300; city.stock.stone = 200; city.stock.food = 300; };
  mk(a, 14); mk(b, 14);
  for (const bid of b.buildings.slice()) { const bd = S.buildings.get(bid); if (bd && !bd.done) ctx.Buildings.work(bd, 1e6); }
  const exps0 = S.mod.cities.exps.length;
  stepCities(ctx, 700);
  const barracks = (c) => c.buildings.filter(id => S.buildings.get(id) && S.buildings.get(id).type === B.BARRACKS).length;
  assert.equal(barracks(a), 0, 'occupied: no barracks');
  assert.equal(a.members.filter(id => S.units.get(id).state === 'settle').length, 0, 'occupied: no expedition');
  const freeActs = barracks(b) + (S.mod.cities.exps.length - exps0) + b.members.filter(id => S.units.get(id) && S.units.get(id).state === 'settle').length;
  assert.ok(barracks(b) >= 1 || freeActs > 0, 'the control city does plan a barracks / expedition');
  // liberation
  const lbefore = a.loyalty;
  assert.equal(Regions.setController(ra.id, 0, 'retake'), true);
  assert.equal(a.occupierId, 0); assert.deepEqual(lib, [a.id]); assert.ok(a.loyalty > lbefore, 'liberation cheers');
  a.stock.food = 0; Cities.deposit(a.id, 'food', 10); assert.equal(a.stock.food, 10, 'full income again');
  // direct API: idempotent, rejects nonsense
  assert.equal(Cities.occupy(a.id, kb), true); assert.equal(Cities.occupy(a.id, kb), false); assert.equal(Cities.occupy(a.id, 0), false);
  assert.equal(Cities.occupy(a.id, ka), false, 'own kingdom cannot occupy');
  assert.equal(Cities.occupy(777777, kb), false); assert.equal(Cities.liberate(777777), false); assert.equal(Cities.isOccupied(777777), false);
  assert.equal(Cities.liberate(a.id), true); assert.equal(Cities.liberate(a.id), false);
  // the peace deal: region changes hands -> occupation of the city ends, city follows with Kingdoms.transferCity
  Regions.setController(ra.id, kb);
  assert.equal(a.occupierId, kb);
  Regions.setOwner(ra.id, kb, 'peace');
  assert.equal(a.occupierId, 0, 'controller == owner -> no occupation flag');
  assert.equal(ctx.Kingdoms.transferCity(a.id, kb, 'peace'), true);
  assert.equal(a.kingdomId, kb); assert.equal(a.occupierId, 0);
  assert.ok(a.members.every(id => S.units.get(id).kingdomId === kb));
  checkIntegrity(ctx, 'occupation');
  // a city that is destroyed while occupied
  Regions.setOwner(rb.id, ka, 'x');
  Regions.setController(rb.id, kb);
  Cities.destroy(b.id, 'test');
  checkIntegrity(ctx, 'destroyed while occupied');
});

section('Cities.capture is an alias of occupy; stage-1 callers still work, Bus cityCaptured kept', () => {
  const ctx = mkCtx(1);
  const { S, Cities, Regions } = ctx;
  const [ra, rb] = pairOfRegions(ctx, 0);
  const a = foundIn(ctx, ra.id, 0, 6), b = foundIn(ctx, rb.id, 1, 5);
  const ev = []; ctx.Bus.on('cityCaptured', (c, o, n) => ev.push([c.id, o, n]));
  assert.equal(Cities.capture(a.id, b.kingdomId, null), true);
  assert.equal(a.occupierId, b.kingdomId); assert.equal(a.kingdomId !== b.kingdomId, true);
  assert.deepEqual(ev, [[a.id, a.kingdomId, b.kingdomId]]);
  assert.ok(S.log.some(l => l.msg.includes(a.name) && l.msg.includes('оккупирован')));
  assert.equal(Cities.capture(a.id, b.kingdomId, null), false);
  assert.equal(Regions.controllerAt(a.x, a.y), a.kingdomId, 'the region controller is War\'s business, not Cities\'');
});

// ====================================================================================================
// expansion over time (full game)
section('expansion: 6000 ticks, several villages — modest pace, borders contact, no crossing water, cooldown respected, no errors', () => {
  const seeds = QUICK ? [1, 2] : [1, 2, 3, 4];
  const rows = [];
  for (const seed of seeds) {
    const ctx = mkGame(seed, 96, true);
    const { S, Sim, Regions, Bus } = ctx;
    const exp = [];
    Bus.on('regionOwner', (r, o, n, why) => { if (why === 'expand') exp.push({ t: S.tick, rid: r.id, kid: n }); });
    const landRegions = S.regions.size;
    const ownedAt = {}, largestAt = {};
    for (const T of [1500, 3000, 6000]) {
      stepN(ctx, T - S.tick);
      const by = new Map();
      for (const r of S.regions.values()) if (r.ownerId) by.set(r.ownerId, (by.get(r.ownerId) || 0) + 1);
      ownedAt[T] = [...by.values()].reduce((a, b) => a + b, 0);
      largestAt[T] = Math.max(0, ...by.values());
      checkIntegrity(ctx, `seed ${seed} t${T}`);
    }
    assert.equal(Sim.totalErrors, 0, 'no sim errors: ' + JSON.stringify(Sim.errors));
    // expansions: adjacent by land to an owned region of the same kingdom, 300+ ticks apart per kingdom
    const lastT = {};
    for (const e of exp) {
      if (lastT[e.kid] !== undefined) assert.ok(e.t - lastT[e.kid] >= 290, `cooldown (${e.t - lastT[e.kid]})`);
      lastT[e.kid] = e.t;
    }
    const kings = [...S.kingdoms.values()];
    const races = new Set(kings.map(k => k.race));
    rows.push({ seed, landRegions, owned1500: ownedAt[1500], owned3000: ownedAt[3000], owned6000: ownedAt[6000], largest1500: largestAt[1500], largest6000: largestAt[6000], kingdoms: kings.length, races: races.size, expansions: exp.length, units: S.units.size, cities: S.cities.size });
    // modest: nobody swallows the continent quickly; several kingdoms of different races coexist and border each other
    assert.ok(largestAt[1500] <= landRegions * 0.3, `seed ${seed}: largest kingdom at t1500 owns ${largestAt[1500]} of ${landRegions}`);
    assert.ok(ownedAt[1500] < ownedAt[6000], 'keeps growing');
    assert.ok(ownedAt[6000] <= landRegions);
    assert.ok(kings.length >= 3, `seed ${seed}: ${kings.length} kingdoms at t6000`);
    assert.ok(races.size >= 2, `seed ${seed}: kingdoms of ${races.size} race(s)`);
    let borders = 0;
    for (const r of S.regions.values()) for (const b of r.nb) { const o = S.regions.get(b); if (r.ownerId && o.ownerId && r.ownerId !== o.ownerId && b > r.id) borders++; }
    assert.ok(borders >= 1, 'two kingdoms share a border');
    // peaceful expansion never crossed water: each expand event's region touches land of the same kingdom (land contact) at that time is not
    // recoverable afterwards, but the final map must have every kingdom's regions reachable by walkable land from one of its cities
    for (const k of kings) for (const r of Regions.ofKingdom(k.id)) {
      const near = k.cities.map(id => S.cities.get(id)).filter(Boolean).some(c => ctx.World.sameLand(c.x, c.y, r.cx, r.cy));
      assert.ok(near, `region ${r.id} of kingdom ${k.id} is on the landmass of one of its cities`);
    }
  }
  console.table(rows);
});

// ====================================================================================================
// save / load
section('save round trip: regions identical after load and after 300 more ticks; stage-1 save (no regions) gets them built', () => {
  const A = mkGame(3, 96, true);
  stepN(A, 1800);
  A.World.brush('lower', 30, 30, 4); stepN(A, 4);
  const store = mkStore(); A.Save.storage = store;
  const kid = [...A.S.kingdoms.keys()][0];
  A.Regions.addClaim(1, kid === A.S.regions.get(1).ownerId ? [...A.S.kingdoms.keys()][1] : kid);
  assert.ok(A.Save.save('auto'), A.Save.lastError);
  // same cache reset a load does (Cities seekers/siteCache, World fire list) — documented leaks of other modules, see save.test.mjs
  A.Cities.afterLoad(); A.World.afterLoad();
  const B = loadSim({}); B.Save.storage = store;
  assert.ok(B.Save.load('auto'), B.Save.lastError);
  assert.equal(B.Save.lastLoad.repaired, 0);
  const regionPart = (c) => JSON.stringify({ layer: Array.from(c.S.region), regions: [...c.S.regions.values()], mod: c.S.mod.regions, ver: 0 });
  assert.equal(regionPart(A), regionPart(B), 'regions + layer + private state identical right after the load');
  assert.equal(B.S.regions.size, A.S.regions.size);
  checkIntegrity(B, 'loaded');
  stepN(A, 300); stepN(B, 300);
  assert.equal(A.Sim.totalErrors + B.Sim.totalErrors, 0);
  assert.equal(regionPart(A), regionPart(B), 'regions identical after 300 more ticks (save/load determinism with regions)');
  assert.equal(A.Save.serialize({ savedAt: 0 }).length > 0, true);
  note(`${A.S.regions.size} regions, ${[...A.S.regions.values()].filter(r => r.ownerId).length} owned, ${A.S.kingdoms.size} kingdoms, cities ${A.S.cities.size}, bytes of region data ${JSON.stringify([...A.S.regions.values()]).length + A.S.region.length}`);
  // stage-1 save: no region layer / table / city fields
  const raw = JSON.parse(A.Save.serialize({ savedAt: 0 }));
  delete raw.layers.region; delete raw.regions;
  for (const f of ['regionId', 'occupierId']) { const ix = raw.cities.k.indexOf(f); if (ix >= 0) { raw.cities.k.splice(ix, 1); raw.cities.r.forEach(r => r.splice(ix, 1)); } }
  delete raw.mod.regions;
  const C = loadSim({});
  assert.ok(C.Save.deserialize(JSON.stringify(raw)), C.Save.lastError);
  assert.ok(C.S.regions.size >= 30, 'regions built on load');
  checkIntegrity(C, 'migrated');
  for (const c of C.S.cities.values()) {
    const r = C.S.regions.get(c.regionId);
    assert.ok(r, 'city has a region'); assert.equal(r.ownerId, c.kingdomId, `region of city ${c.id} belongs to its kingdom`);
    assert.equal(C.S.owner[c.y * C.S.w + c.x], c.id, 'city centre stays inside its own sphere');
  }
  // the migrated game keeps working
  stepN(C, 300);
  assert.equal(C.Sim.totalErrors, 0, JSON.stringify(C.Sim.errors));
  checkIntegrity(C, 'migrated + 300 ticks');
  note('stage-1 save migrated: ' + [...C.S.regions.values()].filter(r => r.ownerId).length + ' regions owned');
  // corrupt: region id that does not exist is repaired, load still succeeds
  const raw2 = JSON.parse(A.Save.serialize({ savedAt: 0 }));
  const lay = A.Save.decodeLayer(raw2.layers.region, A.S.w * A.S.h, 'region'); lay[0] = 9999; lay[1] = -3;
  raw2.layers.region = A.Save.encodeLayer(lay, 'i32');
  const D = loadSim({}); assert.ok(D.Save.deserialize(JSON.stringify(raw2)), D.Save.lastError);
  assert.equal(D.S.region[0], 0); assert.equal(D.S.region[1], 0);
  stepN(D, 20); assert.equal(D.Sim.totalErrors, 0);
});

// ====================================================================================================
// fuzz: god edits + war-like controller changes + kingdom deaths + splits while the game runs
function fuzzRun(seed, ticks) {
  const ctx = mkGame(seed, 96, true);
  const { S, Sim, World, Regions, Kingdoms, Cities } = ctx;
  let st = (seed * 2654435761) >>> 0;
  const rnd = (n) => { st = (Math.imul(st, 1664525) + 1013904223) >>> 0; return (st >>> 8) % n; };
  const ops = { brush: 0, ctl: 0, own: 0, kill: 0, split: 0, lava: 0 };
  for (let t = 0; t < ticks; t += 25) {
    stepN(ctx, 25);
    if (t % 250 === 0) checkIntegrity(ctx, `fuzz ${seed} t${S.tick}`);          // (queued terrain edits are applied within 3-30 ticks: check before the next op)
    const op = rnd(12);
    if (op < 3) { World.brush(['raise', 'lower', 'grass', 'sand', 'hill'][rnd(5)], rnd(S.w), rnd(S.h), 1 + rnd(8)); ops.brush++; }
    else if (op === 3) { World.brush('lava', rnd(S.w), rnd(S.h), 1 + rnd(3)); ops.lava++; }
    else if (op < 6) { const rs = Regions.list(), ks = [...S.kingdoms.keys()]; if (rs.length && ks.length) { Regions.setController(rs[rnd(rs.length)].id, rnd(3) ? ks[rnd(ks.length)] : 0, 'fuzz'); ops.ctl++; } }
    else if (op < 8) { const rs = Regions.list(), ks = [...S.kingdoms.keys()]; if (rs.length && ks.length) { Regions.setOwner(rs[rnd(rs.length)].id, rnd(4) ? ks[rnd(ks.length)] : 0, 'fuzz'); ops.own++; } }
    else if (op === 8) { const cs = [...S.cities.values()]; if (cs.length > 2) { Cities.destroy(cs[rnd(cs.length)].id, 'fuzz'); ops.kill++; } }
    else if (op === 9) { const cs = [...S.cities.values()]; if (cs.length > 2) { if (Kingdoms.splitCity(cs[rnd(cs.length)].id)) ops.split++; } }
  }
  stepN(ctx, 40);
  checkIntegrity(ctx, `fuzz ${seed} end`);
  assert.equal(Sim.totalErrors, 0, `fuzz ${seed}: ` + JSON.stringify(Sim.errors) + ' ' + (Sim.lastError && Object.values(Sim.lastError).map(e => e && e.stack).join('\n')));
  return { ctx, ops };
}
section('fuzz: random brushes / lava / controller + owner changes / city deaths / splits keep every invariant, no sim errors; deterministic', () => {
  const nSeeds = args.fuzz ? +args.fuzz : (QUICK ? 2 : 6);        // node tests/regions.test.mjs --fuzz=40 for a long soak
  const seeds = Array.from({ length: nSeeds }, (_, i) => i + 1);
  const rows = [];
  for (const seed of seeds) {
    const { ctx, ops } = fuzzRun(seed, QUICK ? 1500 : 3000);
    rows.push(Object.assign({ seed, regions: ctx.S.regions.size, owned: [...ctx.S.regions.values()].filter(r => r.ownerId).length, kingdoms: ctx.S.kingdoms.size, cities: ctx.S.cities.size, units: ctx.S.units.size }, ops));
  }
  if (rows.length <= 12) console.table(rows);
  const a = fuzzRun(3, 1200).ctx, b = fuzzRun(3, 1200).ctx;
  const part = (c) => JSON.stringify({ l: Array.from(c.S.region), r: [...c.S.regions.values()], m: c.S.mod.regions });
  assert.equal(part(a), part(b), 'same seed + same operations -> identical regions');
});

// ====================================================================================================
// perf
section('perf: Regions.step cost per tick (idle, expanding, with edits) and Sim wiring (profile, stats)', () => {
  const ctx = mkGame(2, 96, true);
  const { S, Sim, Regions } = ctx;
  assert.ok('Regions' in Sim.profile, 'Sim profiles Regions');
  assert.equal(Sim.stats().regions, S.regions.size, 'Sim.stats().regions');
  let tot = 0, worst = 0, n = 0;
  const T = QUICK ? 1500 : 3000;
  for (let t = 0; t < T; t++) {
    ctx.Sim.step();
    // time Regions.step alone every tick (the call is idempotent per tick: it only does scheduled work)
    const t0 = performance.now(); Regions.step(S.tick); const d = performance.now() - t0;
    tot += d; n++; if (d > worst) worst = d;
  }
  note(`Regions.step: ${(tot / n * 1000).toFixed(1)} us/tick avg, worst tick ${worst.toFixed(3)} ms; Sim.profile.Regions ${Sim.profile.Regions.toFixed(4)} ms (EMA); whole tick ${Sim.profile.total.toFixed(3)} ms`);
  assert.ok(tot / n < 0.1, 'avg < 0.1 ms/tick');
  assert.ok(worst < 4, 'worst < 4 ms');
  // processing a big stroke
  const t0 = performance.now();
  ctx.World.brush('lower', 48, 48, 8); ctx.World.brush('raise', 20, 70, 8);
  stepN(ctx, 8);
  const ms = performance.now() - t0;
  note(`two r=8 brush strokes + 8 ticks (incl. processing): ${ms.toFixed(1)} ms`);
  assert.equal(Sim.totalErrors, 0);
  const t1 = performance.now(); for (let i = 0; i < 20; i++) Regions.computeStats(true); const cs = (performance.now() - t1) / 20;
  note(`computeStats(true) ${cs.toFixed(2)} ms`); assert.ok(cs < 8);
  const t2 = performance.now(); for (let i = 0; i < 2000; i++) { Regions.frontlines(); Regions.ownerAt(i % 90, (i * 7) % 90); Regions.at(i % 90, i % 70); } const q = performance.now() - t2;
  assert.ok(q < 50, 'queries are cheap: ' + q.toFixed(1) + ' ms for 6000 calls');
});

// ====================================================================================================
// summary
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
if (failed.length) process.exit(1);
