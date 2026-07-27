# Test suite speed

Where the time goes and what to do about it.

**No timings in this file.** They drifted twice in a single session as the
4004 machines grew, and a stale number is worse than none — it invites
decisions based on a ratio that no longer holds. Measure when you need to:

```bash
node test/run.mjs                 # wall time, sharded
node test/sim-test.mjs            # wall time, serial
```

and for per-block times, run each `// ── ` section alone (the runner
already knows how to split them; `test/run.mjs` is ~120 readable lines).

What follows is the *shape* of the problem, which has been stable.

## The floor is one block, not the total

`test/run.mjs` shards the suite across cores, so the wall time is the cost
of the **slowest single block**, not the sum. More cores buy nothing once
that block dominates.

The slowest block has been *JCN, every mask, in the machine* throughout.
The memory machine's block is second and closing — it is the most
expensive circuit in the library to clock, five phases over a sixteen-word
ROM — but it sits under the JCN block, so it does not set the wall time
today. It would become the floor the moment JCN is fixed.

Everything below is really about those two blocks.

## Option 2 — cut redundant work

**Worth doing. Low risk, no coverage change.**

The JCN block is two `{ }` blocks under one marker, and the second is
where nearly all its time goes. It builds **32 complete machines** — 16
masks × 2 TEST positions — and runs each for up to 30 ticks. Building and
clocking a machine is the expensive thing in this suite, and it does that
32 times to answer what is fundamentally one question.

Three things to do, in order:

1. **Split the marker.** The two `{ }` blocks are independent; giving the
   second its own `// ── ` header lets the runner put them on different
   cores. One line — but the 32-machine half is still the floor
   afterwards, so do it because it is free, not because it solves the
   problem.

2. **Stop rebuilding the machine per mask.** This is the actual win. All
   32 machines are identical except one ROM byte (`0x10 | mask`). Two
   options, and the second is better:
   - Build once per mask and sweep TEST inside it — halves the builds.
   - Better: the mask is *fetched from ROM*, so a single machine whose ROM
     holds all sixteen `JCN` variants in sequence covers every mask in one
     build. That is a real rewrite, but it is also a better test — it
     exercises the masks in a running program rather than in sixteen
     freshly-reset machines.

3. **Look for the same pattern elsewhere.** The two-byte block resets and
   re-runs its program several times to check several properties.
   Recording one trace and asserting against it repeatedly cuts most of
   that — the memory-machine block was written that way after being
   caught doing the same thing, and roughly halved.

Expected result: JCN stops being the floor, two-byte fetch and the memory
machine become it, and step 3 addresses both. All without touching the
engine.

**Risk:** low, but not zero. Consolidating repeated runs means several
assertions start sharing one trace, so a bug that corrupts the machine
mid-run could be masked where separate resets would have caught it. Where
a block resets deliberately *because* it is testing reset, leave it alone.

## Option 3 — make `settle()` faster

**Do last, and separately. Highest value, highest risk.**

The real cost is per-tick, and it scales worse than the device count does.
Every `tick()` is two clock edges, and each edge drains the event queue to
quiescence. Clocking the largest machines costs tens of milliseconds for a
few thousand devices — enough to suggest the solver is redoing work rather
than that the circuits are large.

The trend is the part that matters: per-tick cost has grown faster than
the machines have. That is the wrong direction for a solver meant to be
near-linear in devices, and it is the reason this option exists.

Two candidates, both unverified:

- **`solve()` re-floods nets that cannot have changed.** The CSR flood is
  generation-stamped, but if a stamp is bumped too broadly — say once per
  step rather than per affected net — every edge re-solves the whole
  graph. Worth profiling before assuming.
- **The event queue re-settles from scratch each edge.** If the queue
  drains and refills repeatedly within one edge, the `while` loop in
  `settle()` is doing several full passes where one would do.

**Why this is last despite being the biggest win:** it is the only option
that changes the engine, and the engine is what every test trusts. A
subtle change to flood or settle order can leave every check passing
while making the simulation quietly wrong in a case nobody covers — the
four-state logic (X and Z, drive strengths) is exactly where that hides.

If it is attempted:

1. Profile first (`node --cpu-prof`), and fix what the profile says rather
   than what looks slow.
2. Treat any change in a *settled value* as a failure, not just a change
   in the pass count.
3. Do it in its own commit with no other changes, so a bisect lands on it
   cleanly.

## Not worth doing

- **More cores.** The floor is one block; see above.
- **A test framework.** It would buy parallel execution at the cost of the
  suite's plain-block readability, and the parallelism was ~120 lines.
- **Cutting checks.** The 131,072-case adder sweep is among the cheapest
  blocks in the suite. The check count is not the problem and never was —
  clocked machines are.
