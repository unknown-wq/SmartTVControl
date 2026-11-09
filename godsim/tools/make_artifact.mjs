// Converts the built single-file game (index.html) into a "body-only" HTML fragment suitable for the Artifact publisher
// (the platform adds <!doctype>, <head> and <body> itself). usage: node tools/make_artifact.mjs [--out=/path/artifact.html]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const body = html.match(/<body>([\s\S]*?)<script>/)[1];
const js = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];
const out = `<title>GODSIM</title>
<style>
/* full-screen game: it paints edge to edge and applies the safe-area insets itself (--st/--sb/--sl/--sr), so the host's :root padding is cleared */
:root { padding: 0 !important; color-scheme: dark; background: #060b17; }
${css}
</style>
${body}
<script>${js}</script>
`;
const file = path.resolve(args.out || '/tmp/godsim_artifact.html');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, out);
console.log('artifact fragment:', file, (out.length / 1024).toFixed(0) + ' KB');
