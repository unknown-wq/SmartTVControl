// Build: concatenates src/NN_*.js (sorted) + src/style.css into a single self-contained index.html
// usage: node build.mjs [--out=index.html|/abs/path.html] [--check] [--stubs] [--extra=tests/boot_x.js] [--no-main]
//   --stubs    : declare no-op Proxy stubs for every module name (sim + client) that has no source file yet (for isolated browser tests)
//   --extra    : append an extra JS file (e.g. a test bootstrap) inside the same scope, after all src files
//   --no-main  : leave out src/99_*.js (so a test bootstrap can replace it)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(root, 'src');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const outFile = path.resolve(root, args.out || 'index.html');

let files = fs.readdirSync(srcDir).filter(f => /^\d\d_.*\.js$/.test(f)).sort();
if (args['no-main']) files = files.filter(f => !f.startsWith('99_'));
let js = files.map(f => `/* ---- ${f} ---- */\n` + fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n\n');

if (args.stubs) {
  const declRe = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  const declared = new Set([...js.matchAll(declRe)].map(m => m[1]));
  const ALL = ['World', 'Buildings', 'Cities', 'Units', 'Kingdoms', 'Diplomacy', 'War', 'Powers', 'Sim', 'Save', 'Sprites', 'Render', 'Input', 'UI'];
  const stubs = ALL.filter(n => !declared.has(n)).map(n => `const ${n} = new Proxy({}, { get(t,k){ if(k in t) return t[k]; if(k==='__stub') return true; return () => undefined; }, set(t,k,v){ t[k]=v; return true; } });`);
  if (stubs.length) js += '\n\n/* ---- stubs ---- */\n' + stubs.join('\n');
}
if (args.extra) js += `\n\n/* ---- extra: ${args.extra} ---- */\n` + fs.readFileSync(path.resolve(root, args.extra), 'utf8');

const cssPath = path.join(srcDir, 'style.css');
const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
const tplPath = path.join(srcDir, 'template.html');
const tpl = fs.existsSync(tplPath) ? fs.readFileSync(tplPath, 'utf8') : '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><style>html,body{margin:0;height:100%;background:#000}canvas{display:block;width:100%;height:100%}/*__CSS__*/</style></head><body><canvas id="game"></canvas><script>/*__JS__*/</script></body></html>';

if (!tpl.includes('/*__CSS__*/') || !tpl.includes('/*__JS__*/')) { console.error('template.html must contain /*__CSS__*/ and /*__JS__*/ markers'); process.exit(1); }
if (/<\/script/i.test(js)) { console.error('JS contains "</script" — escape it as "<\\/script"'); process.exit(1); }

const wrapped = `(function(){\n'use strict';\n${js}\n})();`;
const html = tpl.replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => wrapped);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);
console.log(`built ${outFile}  ${(html.length / 1024).toFixed(1)} KB  (${files.length} js files)`);
if (args.check) {
  try { new Function(wrapped); console.log('syntax OK'); } catch (e) { console.error('SYNTAX ERROR:', e.message); process.exit(2); }
}
