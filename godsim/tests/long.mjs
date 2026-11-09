// Long-run headless simulation CLI.
//   node tests/long.mjs --seeds=1,2,3,4,5 --ticks=30000 [--size=96] [--window=3000] [--par=3] [--json=/tmp/dir] [--verbose]
// Prints, per seed, one row per window (units per race, cities, kingdoms, regions owned/wild, wars started/ended, regions transferred,
// rebellions, merges, max units, ms/tick avg+worst, log volume, errors) and a designer summary (war length, stalls, hold behaviour, spam).
import fs from 'node:fs';
import { runSeeds } from './longlib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const seeds = String(args.seeds || '1,2,3,4,5,6').split(',').map(Number).filter(n => n > 0);
const opts = { ticks: +(args.ticks || 30000), size: +(args.size || 96), window: +(args.window || 3000) };
const par = +(args.par || 3);
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const pad = (s, n) => String(s).padStart(n);

export function printReport(r, verbose) {
  console.log(`\n=== seed ${r.seed}  ${r.size}x${r.size}  ${r.ticks} ticks  wall ${(r.wallMs / 1000).toFixed(1)}s  sim errors ${r.simErrors} ${JSON.stringify(r.simErrorMap)}`);
  console.log(' tick  |  hum  orc  elf | cit kin(h/o/e) | reg own/wild occ | war(act) st/end | occ lib xfer reb mrg vas | maxU | ms avg  worst  (<=600u) | log/w (max/100t) | err');
  for (const w of r.windows) {
    console.log(`${pad(w.tick, 6)} | ${pad(w.pop[0], 4)} ${pad(w.pop[1], 4)} ${pad(w.pop[2], 4)} | ${pad(w.cities, 3)} ${pad(w.kingdoms, 2)}(${w.kPerRace.join('/')}) | ${pad(w.owned + w.wild, 3)} ${pad(w.owned, 3)}/${pad(w.wild, 2)} ${pad(w.occupied, 3)} | ${pad(w.warsStarted, 3)}(${w.activeWars}) ${pad(w.warsEnded, 3)} | ${pad(w.occ, 3)} ${pad(w.lib, 3)} ${pad(w.transfers, 4)} ${pad(w.rebel, 3)} ${pad(w.merge, 3)} ${pad(w.vassal, 3)} | ${pad(w.maxUnits, 4)} | ${f1(w.msAvg)} ${pad(f1(w.msWorst), 6)} (${f1(w.msSmallAvg)}) | ${pad(w.log, 4)} (${pad(w.logMaxPer100, 2)}) | ${w.errors}`);
  }
  const wars = r.wars;
  if (wars.length) {
    const dur = wars.map(w => w.dur).sort((a, b) => a - b);
    const med = dur[dur.length >> 1];
    const stalled = wars.filter(w => w.stalled).length;
    const noGoal = wars.filter(w => w.goalsDone === 0).length;
    const extra = wars.reduce((a, w) => a + w.extra, 0), occ = wars.reduce((a, w) => a + w.occ, 0);
    const ends = {}; for (const w of wars) ends[w.how] = (ends[w.how] || 0) + 1;
    console.log(` wars ended ${wars.length}: dur median ${med} min ${dur[0]} max ${dur[dur.length - 1]} | stalled(no control change) ${stalled} | goal never reached ${noGoal} | occupations ${occ} (non-goal ${extra}) | ends ${JSON.stringify(ends)}`);
  } else console.log(' no war ended');
  const dead = r.kingdoms.filter(k => k.t1 !== undefined);
  const short = dead.filter(k => k.t1 - k.t0 < 1500);
  console.log(` kingdoms created/ended: ${r.kingdoms.length}/${dead.length} (lifetime < 1500 ticks: ${short.length}) | rebellions ${r.rebellions.length} | anomalies ${r.anomalies.length}${r.anomalies.length ? ': ' + r.anomalies.slice(0, 3).join(' ; ') : ''}`);
  console.log(` bounds ${JSON.stringify(r.bounds)}`);
  if (r.errors.length) console.log(` console.error x${r.errors.length}: ${r.errors.slice(0, 3).join(' | ')}`);
  const top = Object.entries(r.spam).sort((a, b) => b[1] - a[1]).slice(0, verbose ? 12 : 4);
  console.log(' top log lines: ' + top.map(([k, v]) => `${v}x ${k.slice(0, 60)}`).join(' | '));
  const end = r.endKingdoms.map(k => `${['H', 'O', 'E'][k.race]}:${k.regions}r/${k.cities}c/${k.pop}p${k.vassal ? 'v' : ''}`).join(' ');
  console.log(` end kingdoms: ${end}`);
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const t0 = Date.now();
  const reps = await runSeeds(seeds, opts, par);
  for (const r of reps) printReport(r, !!args.verbose);
  if (args.json) { fs.mkdirSync(args.json, { recursive: true }); for (const r of reps) fs.writeFileSync(`${args.json}/long_${r.seed}.json`, JSON.stringify(r)); }
  console.log(`\nwall ${((Date.now() - t0) / 1000).toFixed(0)} s for ${seeds.length} seeds`);
}
