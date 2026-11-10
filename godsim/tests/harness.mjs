// Headless harness: loads godsim src modules into one scope (no DOM) and returns all top-level names.
// Missing / forced modules are replaced by no-op Proxy stubs so a single module can be tested in isolation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

// sim (DOM-free) module names the harness may stub if their file is missing or forced via opts.stub
export const SIM_MODULES = ['World', 'Buildings', 'Cities', 'Units', 'Regions', 'Kingdoms', 'Diplomacy', 'War', 'Powers', 'Sim', 'Save'];

function stubModule(name) {
  const target = {};
  return new Proxy(target, {
    get(t, k) {
      if (k === '__stub') return true;
      if (k in t) return t[k];
      if (k === 'then') return undefined;
      return () => undefined;
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}

/**
 * loadSim({ stub: ['Cities'], clientToo: false, files: [...] })
 *  - loads src/NN_*.js with number < 20 (sim files) unless clientToo
 *  - any module in SIM_MODULES not declared by loaded files gets a stub; modules named in opts.stub are NOT loaded
 * returns an object with every top-level const/let/function/class of the loaded sources.
 */
export function loadSim(opts = {}) {
  const stub = new Set(opts.stub || []);
  let files = fs.readdirSync(srcDir).filter(f => /^\d\d_.*\.js$/.test(f)).sort();
  if (!opts.clientToo) files = files.filter(f => parseInt(f.slice(0, 2), 10) < 20);
  if (opts.files) files = files.filter(f => opts.files.includes(f));
  const declRe = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  const parts = [];
  const declared = new Set();
  for (const f of files) {
    const code = fs.readFileSync(path.join(srcDir, f), 'utf8');
    const names = [...code.matchAll(declRe)].map(m => m[1]);
    // skip a file when it declares a module we are asked to stub
    if (names.some(n => stub.has(n))) continue;
    names.forEach(n => declared.add(n));
    parts.push(`/* ${f} */\n${code}`);
  }
  const stubs = [];
  for (const m of SIM_MODULES) {
    if (!declared.has(m)) { stubs.push(`const ${m} = __stubModule(${JSON.stringify(m)});`); declared.add(m); }
  }
  // opts.extra = [absolute paths]: extra JS appended in the same scope (plugin fixtures, test plugins)
  const extra = (opts.extra || []).map(f => `/* extra ${path.basename(f)} */\n` + fs.readFileSync(f, 'utf8')).join('\n\n');
  const body = parts.join('\n\n') + '\n' + stubs.join('\n') + '\n' + extra + `\nreturn { ${[...declared].join(', ')} };`;
  const fakeStorage = (() => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, key: i => [...m.keys()][i] ?? null, get length() { return m.size; } }; })();
  const fn = new Function('__stubModule', 'localStorage', 'window', 'document', '"use strict";\n' + body);
  return fn(stubModule, fakeStorage, undefined, undefined);
}

/** Advance the simulation `n` ticks. Uses Sim.step() when the real Sim exists, else calls module steps in canonical order. */
export function stepN(ctx, n) {
  const hasSim = ctx.Sim && !ctx.Sim.__stub;
  for (let i = 0; i < n; i++) {
    if (hasSim) { ctx.Sim.step(); continue; }
    ctx.S.tick++;
    for (const m of ['World', 'Buildings', 'Units', 'Cities', 'Regions', 'Kingdoms', 'Diplomacy', 'War', 'Powers']) {
      const mod = ctx[m];
      if (mod && !mod.__stub && typeof mod.step === 'function') mod.step(ctx.S.tick);
    }
    ctx.Fx.update(0.1);
  }
}

/** Fresh world (real World.generate if present). */
export function newWorld(ctx, seed = 1, w = 96, h = 96) {
  if (ctx.Sim && !ctx.Sim.__stub) return ctx.Sim.newWorld({ seed, w, h, populate: false });
  if (ctx.World && !ctx.World.__stub) { ctx.World.generate({ seed, w, h }); }
  else { ctx.S.reset(w, h, seed); }
  for (const m of SIM_MODULES) { const mod = ctx[m]; if (mod && !mod.__stub && typeof mod.newWorld === 'function' && m !== 'Sim' && m !== 'World') mod.newWorld(); }
}

export function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
