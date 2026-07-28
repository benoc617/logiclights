# Test suite speed

Where the time goes and what to do about it.

**No timings in this file.** They drifted twice in a single session as the
4004 machines grew, and a stale number is worse than none — it invites
decisions based on a ratio that no longer holds. Measure when you need to:

```bash
node test/run.mjs --shards
```

That prints the wall time and how long each shard took. For per-block
numbers, read `test/.block-times.json`, which the runner writes after every
clean run (see below) — it is the same data the scheduler uses.

What follows is the *shape* of the problem, which has been stable.

## The floor is one block, not the total

`test/run.mjs` shards the suite across cores, so the wall time is the cost
of the **slowest single block**, not the sum. More cores buy nothing once
that block dominates.

The floor has been *JCN, every mask, in the machine* throughout, and the
memory machine's block is second. Both are slow for the same reason: they
build machines and clock them, and clocking is the expensive thing here.

## Measure under load, not alone

This is worth stating because it caused a wrong conclusion once, in a
documentation audit that set out to check exactly this file.

Timing each block by running it *alone* gives numbers that do not add up to
what the suite does, and the ranking they produce is wrong. Run by itself
on an idle machine, the JCN block looks cheap; under the real suite, with
eleven processes competing for cores and memory bandwidth, it is the
slowest thing in the file by a wide margin. The audit briefly rewrote this
document around the solo numbers and had to be corrected.

So: take timings from `--shards` and from `.block-times.json`, which
measure blocks in the conditions they actually run in. A block timed in
isolation is answering a different question.

## The scheduler learns

Blocks are dealt longest-first onto whichever shard has least work, which
is only as good as the cost estimate. Line count is a bad estimate — the
expensive blocks are expensive because of clock ticks, not length, and a
four-line block that walks the memory machine outweighs a hundred lines of
truth table. Dealing by length left two shards running for the better part
of two minutes while five finished inside ten seconds; most of the wall
time was spent waiting on an unlucky deal rather than on work.

So each clean run writes what every block actually cost to
`test/.block-times.json`, and the next run deals with those numbers. That
roughly halved the wall time here, and the gain should be larger on a
machine with more cores, since it is idle shards that the learned deal
fills.

Two details worth keeping:

- **Only clean runs are recorded.** A failing shard can die part-way and
  report times for a fraction of its blocks; writing those would teach the
  scheduler that an expensive block is cheap, and the mistake would persist
  after the failure was fixed.
- **An unseen block is assumed median, not free.** A new block guessed
  cheap lands on an already-loaded shard, which is the case where being
  wrong costs the most. The file is gitignored — it is machine-specific,
  and a checkout that has never run the suite falls back to line counts and
  corrects itself on the second run.

## What is left

The remaining cost is real work: building and clocking large circuits.
Two things could still move it, in this order.

### Split the slow blocks

The JCN block builds **32 complete machines** — 16 masks × 2 TEST positions
— and runs each for up to 30 ticks, to answer what is fundamentally one
question. Two ways to cut it, and the second is better:

- Build once per mask and sweep TEST inside it, halving the builds.
- Better: the mask is *fetched from ROM*, so a single machine whose ROM
  holds all sixteen `JCN` variants in sequence covers every mask in one
  build. A real rewrite, but also a better test — it exercises the masks in
  a running program rather than in sixteen freshly-reset machines.

Either way, splitting one expensive block into several cheaper ones now
helps twice: less work, and more pieces for the scheduler to balance.

**Risk:** low, but not zero. Consolidating repeated runs means several
assertions start sharing one trace, so a bug that corrupts the machine
mid-run could be masked where separate resets would have caught it. Where a
block resets deliberately *because* it is testing reset, leave it alone.

### Make `settle()` faster

**Do last, and separately. Highest value, highest risk.**

The cost is per-tick and it scales worse than the device count does. Every
`tick()` is two clock edges, and each edge drains the event queue to
quiescence. Between the smallest machine and the largest, roughly a 5×
device count costs roughly 10× per tick. That is the wrong direction for a
solver meant to be near-linear in devices.

Two candidates, both unverified:

- **`solve()` re-floods nets that cannot have changed.** The CSR flood is
  generation-stamped, but if a stamp is bumped too broadly — say once per
  step rather than per affected net — every edge re-solves the whole graph.
  Worth profiling before assuming.
- **The event queue re-settles from scratch each edge.** If the queue
  drains and refills repeatedly within one edge, the `while` loop in
  `settle()` is doing several full passes where one would do.

**Why this is last despite being the biggest win:** it is the only option
that changes the engine, and the engine is what every test trusts. A subtle
change to flood or settle order can leave every check passing while making
the simulation quietly wrong in a case nobody covers — the four-state logic
(X and Z, drive strengths) is exactly where that hides.

If it is attempted:

1. Profile first (`node --cpu-prof`), and fix what the profile says rather
   than what looks slow.
2. Treat any change in a *settled value* as a failure, not just a change in
   the pass count.
3. Do it in its own commit with no other changes, so a bisect lands on it
   cleanly.

## Not worth doing

- **More cores.** The floor is one block; see above. Balancing helped
  because shards were idle, not because there were too few.
- **A test framework.** It would buy parallel execution at the cost of the
  suite's plain-block readability, and the parallelism was ~120 lines.
- **Cutting checks.** The 131,072-case adder sweep runs in a couple of
  seconds and is among the cheapest blocks in the suite. The check count is
  not the problem and never was — clocked machines are.
- **Trimming the walkthrough checks.** That block verifies the prose in the
  info panel against the hardware it describes, and it exists because a
  comment describing a program that had been replaced survived unnoticed
  for a long time. It is not the floor, and trading it for wall time would
  buy back the exact failure it was built to prevent.
