// CLI smoke scenario:  node tests/run.mjs [--seed=1] [--ticks=1200] [--stub=Cities,War] [--humans=24] [--orcs=0] [--elves=0]
import { loadSim, stepN, newWorld } from './harness.mjs';
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const num = (k, d) => (args[k] !== undefined ? +args[k] : d);
const ctx = loadSim({ stub: args.stub ? String(args.stub).split(',') : [] });
const { S } = ctx;
const seed = num('seed', 1);
newWorld(ctx, seed, num('size', 96), num('size', 96));
let landTiles = 0; for (let i = 0; i < S.tile.length; i++) if (ctx.Tiles.isLand(S.tile[i])) landTiles++;
console.log(`world ${S.w}x${S.h} seed=${seed} land=${(100 * landTiles / S.tile.length).toFixed(0)}%`);
const spawn = (race, n) => {
  if (!ctx.Units || ctx.Units.__stub || !ctx.World || ctx.World.__stub) return;
  let placed = 0, guard = 0;
  while (placed < n && guard++ < 5000) {
    const x = ctx.R.i(S.w), y = ctx.R.i(S.h);
    if (S.tile[y * S.w + x] === ctx.Const.T.GRASS) { ctx.Units.spawn(race, x + 0.5, y + 0.5, {}); placed++; }
  }
};
spawn(0, num('humans', 24)); spawn(1, num('orcs', 0)); spawn(2, num('elves', 0));
const t0 = performance.now();
const total = num('ticks', 1200); const chunk = Math.max(1, total / 6 | 0);
for (let t = 0; t < total; t += chunk) {
  stepN(ctx, Math.min(chunk, total - t));
  console.log(`tick ${S.tick} year ${ctx.Util.year()} units=${S.units.size} cities=${S.cities.size} kingdoms=${S.kingdoms.size} buildings=${S.buildings.size} log=${S.log.length}`);
}
const ms = performance.now() - t0;
console.log(`done: ${total} ticks in ${ms.toFixed(0)} ms (${(ms / total).toFixed(2)} ms/tick)`);
