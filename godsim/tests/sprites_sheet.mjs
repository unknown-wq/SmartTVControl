// Contact-sheet screenshot tool for the Sprites module.
//   node tests/sprites_sheet.mjs [--only=tiles,units] [--out=/tmp/godsim-sprites-shots] [--dpr=1]
// Builds a page with `node build.mjs --stubs --no-main --extra=tests/sprites_boot.js`, then screenshots every section as PNG.
// Open the PNGs with an image viewer / the Read tool to review the art.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const outDir = args.out || '/tmp/godsim-sprites-shots';
const html = '/tmp/godsim-sprites.html';
fs.mkdirSync(outDir, { recursive: true });

execFileSync('node', [path.join(root, 'build.mjs'), '--stubs', '--no-main', `--out=${html}`, '--extra=tests/sprites_boot.js'], { cwd: root, stdio: 'inherit' });

const b = await launch({ url: 'file://' + html, width: 1400, height: 900, dpr: +(args.dpr || 1) });
await b.wait(300);
const names = await b.eval(() => window.__sheet.names);
const only = args.only ? String(args.only).split(',') : null;
const jobs = [];
for (const n of names) {
  if (only && !only.includes(n)) continue;
  if (n === 'units') for (let r = 0; r < 3; r++) jobs.push([n, { race: r }, `units_${['human', 'orc', 'elf'][r]}`]);
  else if (n === 'scene') { jobs.push([n, { zoom: 4, frame: 0 }, 'scene']); jobs.push([n, { zoom: 2, frame: 1 }, 'scene_z2']); jobs.push([n, { zoom: 1, frame: 0 }, 'scene_z1']); }
  else jobs.push([n, { sc: args.sc ? +args.sc : undefined }, n + (args.sc ? '_x' + args.sc : '')]);
}
for (const [n, o, file] of jobs) {
  const size = await b.eval(([n, o]) => window.__sheet.draw(n, o), [n, o]);
  await b.page.setViewportSize({ width: Math.min(3000, size.w + 4), height: Math.min(3000, size.h + 4) });
  await b.wait(60);
  const f = path.join(outDir, file + '.png');
  await b.shot(f, { clip: { x: 0, y: 0, width: size.w, height: size.h } });
  console.log('shot', f, size.w + 'x' + size.h);
}
if (args.perf) console.log('perf (real browser, headless swiftshader):', JSON.stringify(await b.eval(() => window.__perf()), null, 1));
console.log('init ms:', (await b.eval(() => window.__initMs)).toFixed(1));
if (b.errors.length) { console.log('PAGE ERRORS:\n' + b.errors.join('\n')); process.exitCode = 1; } else console.log('no page errors');
await b.close();
