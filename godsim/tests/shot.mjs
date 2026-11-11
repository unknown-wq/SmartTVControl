// node tests/shot.mjs [--file=index.html] [--out=/tmp/shot.png] [--wait=1500] [--eval="window.__god.S.tick"]
import { launch } from './browser.mjs';
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const b = await launch({ file: args.file || 'index.html', verbose: true });
await b.wait(+(args.wait || 1500));
if (args.eval) console.log('eval =>', JSON.stringify(await b.eval(args.eval)));
await b.shot(args.out || '/tmp/shot.png');
console.log('screenshot ->', args.out || '/tmp/shot.png');
if (b.errors.length) console.log('ERRORS:\n' + b.errors.join('\n')); else console.log('no page errors');
if (b.logs.length) console.log(b.logs.slice(0, 20).join('\n'));
await b.close();
