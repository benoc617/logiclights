// Parallel runner for the simulation test suite.
//
// The suite is one long script of independent blocks, each introduced by a
// `// ── name ───` marker. Every block builds its own circuits and asserts
// against them; nothing carries state from one block to the next except
// the three counters at the top of the file. That independence is what
// makes this possible, and it is worth stating because it is the property
// that would break sharding if it were ever lost.
//
// So: split the file at those markers, give each worker the shared
// preamble plus a subset of the blocks, run the workers concurrently and
// sum the results. No test changes, no coverage change — the same checks
// run, on more than one core.
//
// Why not a test framework? The suite's whole style is plain asserts in
// plain blocks, readable top to bottom. A framework would buy parallelism
// at the cost of that, and the parallelism is a hundred lines on its own.
//
// Run: node test/run.mjs            (all cores)
//      node test/run.mjs --serial   (one process, for debugging)
//      node test/run.mjs --jobs 4

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SUITE = join(HERE, 'sim-test.mjs');
const MARKER = /^\/\/ ── /;

const args = process.argv.slice(2);
const serial = args.includes('--serial');
const jobsArg = args.indexOf('--jobs');
// Leave a core for the OS; the workers are CPU-bound and oversubscribing
// makes the slowest shard slower without finishing any sooner.
const JOBS = serial ? 1
  : jobsArg >= 0 ? Math.max(1, parseInt(args[jobsArg + 1], 10) || 1)
  : Math.max(1, Math.min(cpus().length - 1, 12));

// ── split the suite into a preamble and a list of blocks ─────────────────
// The preamble is everything before the first marker: imports, the counters
// and the helpers (`settle`, `sw`, `expect`) every block uses. It goes into
// every shard verbatim.
//
// The trailer is the last block. It contains the summary print and the
// process exit, and it also holds the inventory check — which shells out to
// the generator and must run exactly once, so it stays pinned to shard 0
// rather than being distributed like the rest.
const src = readFileSync(SUITE, 'utf8').split('\n');
const marks = [];
src.forEach((line, i) => { if (MARKER.test(line)) marks.push(i); });
if (!marks.length) {
  // Rather than guess at a split, hand the whole file to node unchanged.
  // Slow, but correct — and it means restructuring the suite degrades to
  // the old behaviour instead of silently running nothing.
  console.error('test/run.mjs: no `// ── ` section markers found — has the '
    + 'suite been restructured? Running it in one process.');
  const { spawnSync } = await import('node:child_process');
  process.exit(spawnSync('node', [SUITE], { cwd: ROOT, stdio: 'inherit' }).status ?? 1);
}

const preamble = src.slice(0, marks[0]).join('\n');
const blocks = marks.map((start, i) => {
  const end = i + 1 < marks.length ? marks[i + 1] : src.length;
  return { name: src[start].replace(/^\/\/ ── /, '').replace(/[─\s]+$/, ''),
           text: src.slice(start, end).join('\n') };
});

// Some shared helpers (`lampV`, `testAdder`, `flipAndStep`, the `GATES`
// table) are declared at top level *inside* a block rather than in the
// preamble, and later blocks use them. A shard that gets the user without
// the definition dies with a ReferenceError.
//
// So every top-level declaration is hoisted into all shards. It is
// duplicated work — the definitions are cheap — but it means the suite can
// keep declaring helpers wherever they read best, which is the property
// worth protecting. A block is still free to move; only the declaration
// pattern matters, and it is a plain `function`/`const` at column zero.
//
// Blocks keep their own copy too, so a block that both defines and uses a
// helper still runs standalone. Redeclaring a `const` in the same scope is
// an error, so the hoisted copies are wrapped rather than emitted twice —
// see shardSource.
const DECL = /^(?:function|const|let)\s+([A-Za-z_$][\w$]*)/;
const helpers = [];
for (const b of blocks) {
  const lines = b.text.split('\n');
  lines.forEach((line, i) => {
    const m = line.match(DECL);
    if (!m) return;
    // take the declaration through to the first line that closes it at
    // column zero — these are all either one-liners or `}`-terminated
    let end = i;
    if (/[{[(]\s*$/.test(line)) {
      while (end + 1 < lines.length && !/^[}\])];?\s*$/.test(lines[end + 1])) end++;
      end++;
    }
    helpers.push({ name: m[1], text: lines.slice(i, end + 1).join('\n') });
  });
}

// The suite ends with a summary print and `process.exit`. A shard must not
// do either — the runner owns the totals — so that tail is stripped and
// replaced with a machine-readable line the parent parses.
const TAIL = /\nconsole\.log\(`\$\{checks\} checks[\s\S]*$/;
const last = blocks[blocks.length - 1];
last.text = last.text.replace(TAIL, '\n');

// ── deal blocks to shards ────────────────────────────────────────────────
// Longest-first by estimated cost, onto whichever shard has the least work
// so far.
//
// The estimate is measured runtime when we have it. Line count is a bad
// proxy — the expensive blocks are expensive because of clock ticks, not
// length, and a four-line block that walks the memory machine outweighs a
// hundred lines of truth table. Balancing by length left two shards at
// ~120s while five finished inside ten, which is most of the wall time
// spent waiting on an unlucky deal rather than on work.
//
// So each run writes what every block actually cost to `.block-times.json`
// beside this file, and the next run deals with those numbers. The first
// run on a clean checkout (or after adding a block) falls back to line
// count for anything it has not seen, then corrects itself.
const TIMES = join(HERE, '.block-times.json');
let known = {};
try { known = JSON.parse(readFileSync(TIMES, 'utf8')); } catch { /* first run */ }
// Unseen blocks get the median known cost rather than zero: a new block
// assumed free lands on an already-loaded shard, which is the one case
// where guessing wrong costs the most.
const seen = Object.values(known).filter(n => typeof n === 'number');
const fallback = seen.length
  ? seen.slice().sort((a, b) => a - b)[Math.floor(seen.length / 2)]
  : 0;
const estimate = i => known[blocks[i].name] ?? (fallback || blocks[i].text.length);

const shards = Array.from({ length: JOBS }, () => []);
const cost = new Array(JOBS).fill(0);
const order = blocks.map((b, i) => i)
  .sort((a, b) => estimate(b) - estimate(a));
for (const i of order) {
  const lightest = cost.indexOf(Math.min(...cost));
  shards[lightest].push(i);
  cost[lightest] += estimate(i);
}
// keep each shard's blocks in source order, so failure output reads sanely
for (const s of shards) s.sort((a, b) => a - b);

// The inventory check shells out to the generator and must run once. It
// lives in the final block; pin that block to shard 0.
{
  const lastIdx = blocks.length - 1;
  for (const s of shards) {
    const at = s.indexOf(lastIdx);
    if (at >= 0) s.splice(at, 1);
  }
  shards[0].push(lastIdx);
  shards[0].sort((a, b) => a - b);
}

// Shards must live in the *same* directory as the suite, not merely near
// it: the suite imports the app through relative paths (`../web/js/...`),
// which resolve against the importing file. One level deeper breaks every
// import, so the shards are dotfiles in test/ and are deleted on the way
// out.
const TMP = HERE;
const shardPath = id => join(TMP, `.shard-${id}.mjs`);

function shardSource(indices) {
  // Only the helpers this shard does not already define — redeclaring a
  // `const` in the same scope is a syntax error, so "hoist everything"
  // has to mean "hoist what is missing".
  const own = new Set();
  for (const i of indices) {
    for (const line of blocks[i].text.split('\n')) {
      const m = line.match(DECL);
      if (m) own.add(m[1]);
    }
  }
  const missing = [];
  const seen = new Set();
  for (const h of helpers) {
    if (own.has(h.name) || seen.has(h.name)) continue;
    seen.add(h.name);
    missing.push(h.text);
  }
  return [
    preamble,
    ...missing,
    // Each block is followed by a stamp of what it cost, so the parent can
    // learn the real per-block times and deal better next run. The stamp
    // is a bare statement between blocks, which is safe because every
    // block is a self-contained `{ }` or a top-level call.
    ...indices.flatMap(i => [
      `\nglobalThis.__t = Date.now();`,
      blocks[i].text,
      `console.log("__TIME__ " + ${JSON.stringify(blocks[i].name)}`
        + ` + " " + (Date.now() - globalThis.__t));`,
    ]),
    // the parent reads this line; anything else on stdout is a failure
    // message and is passed straight through
    '\nconsole.log(`__SHARD__ ${checks} ${failures}`);\n',
  ].join('\n');
}

function runOne(source, id) {
  const file = shardPath(id);
  writeFileSync(file, source);
  const started = Date.now();
  return new Promise(resolve => {
    execFile('node', [file], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const ms = Date.now() - started;
        let checks = 0, failures = 0, sawSummary = false;
        const noise = [];
        const times = {};
        for (const line of stdout.split('\n')) {
          const m = line.match(/^__SHARD__ (\d+) (\d+)$/);
          if (m) { checks += +m[1]; failures += +m[2]; sawSummary = true; continue; }
          const t = line.match(/^__TIME__ (.*) (\d+)$/);
          if (t) { times[t[1]] = +t[2]; continue; }
          if (line.trim()) noise.push(line);
        }
        // A shard that dies before printing its summary has failed in a way
        // the counters cannot express — a syntax error, a throw outside a
        // block, an OOM. Reporting it as zero checks would let the suite
        // pass by losing tests, which is the one failure mode a parallel
        // runner must never have.
        if (!sawSummary) {
          failures += 1;
          noise.push(`FAIL [runner] shard ${id} exited without a summary`
            + `${err ? ` (${err.message.split('\n')[0]})` : ''}`);
        }
        resolve({ checks, failures, out: noise, err: stderr.trim(), ms, times });
      });
  });
}

// ── run ──────────────────────────────────────────────────────────────────
const t0 = Date.now();
const active = shards.filter(s => s.length);
const results = await Promise.all(
  active.map((indices, id) => runOne(shardSource(indices), id)));

let checks = 0, failures = 0;
for (const r of results) {
  checks += r.checks;
  failures += r.failures;
  for (const line of r.out) console.log(line);
  if (r.err) console.error(r.err);
}

for (let id = 0; id < active.length; id++) {
  rmSync(shardPath(id), { force: true });
}

// Record what each block cost, for the next run's deal. Only on a clean
// run: a failing shard can die part-way and report times for a fraction of
// its blocks, and writing those would teach the scheduler that an
// expensive block is cheap. Best-effort — a read-only checkout should not
// fail the suite over a cache file.
if (!failures) {
  const merged = { ...known };
  for (const r of results) Object.assign(merged, r.times);
  try { writeFileSync(TIMES, JSON.stringify(merged, null, 1) + '\n'); }
  catch { /* not writable; the deal just stays as good as it was */ }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`${checks} checks, ${failures} failures  `
  + `(${secs}s across ${active.length} ${active.length === 1 ? 'process' : 'processes'})`);

// --shards prints how long each one took. Blocks are dealt by line count,
// which is a poor proxy for runtime, so a straggler here is the thing to
// look at before concluding the suite is uniformly slow — one shard
// finishing far after the rest means the deal was unlucky, not that there
// is more work to do. See docs/TEST-SPEED.md.
if (args.includes('--shards')) {
  const rows = results
    .map((r, id) => ({ id, ms: r.ms, blocks: active[id].length }))
    .sort((a, b) => b.ms - a.ms);
  console.log('\nshard   seconds   blocks');
  for (const r of rows) {
    console.log(`  ${String(r.id).padStart(2)}  ${(r.ms / 1000).toFixed(1).padStart(8)}`
      + `  ${String(r.blocks).padStart(6)}`);
  }
}
process.exit(failures ? 1 : 0);
