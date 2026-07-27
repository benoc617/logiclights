# Test suite speed

Where the time goes and what to do about it. Written after sharding the
suite across cores took it from 4m37s to ~60s, and hit a floor.

All numbers from a 12-core machine, `node test/run.mjs`.

## Where it stands

| | |
|---|---|
| serial (`node test/sim-test.mjs`) | 4m37s |
| sharded (`node test/run.mjs`, 11 processes) | ~60s |
| checks, either way | 149,492 |

The sharding is done. What follows is the two things that would take it
further, in the order they are worth doing.

## The floor: one block is 60 seconds

Per-block timings, measured by running each `// ── ` section alone:

| seconds | block |
|---|---|
| **60.0** | **JCN, every mask, in the machine** |
| 22.6 | two-byte fetch |
| 11.8 | JCN: the condition tree |
| 5.2 | the accumulator group |
| 3.6 | the adding machine |
| 2.4 | 4-bit ALU |
| ~2 each | everything else (30 blocks) |

Total across blocks: ~121s. (The serial suite is slower than that sum
because each block here pays module-load separately; run together they
share it.)

So the sharded wall time is *exactly* the cost of the slowest block. More
cores buy nothing. Every option below is really about that one block.

## Option 2 — cut redundant work

**Worth doing. Low risk, no coverage change.**

The 60s block is two `{ }` blocks under one marker. Measured separately:

| | seconds | checks |
|---|---|---|
| A: walk the countdown, check TAKE at each JCN | 12.1 | 18 |
| **B: 32 machines, one per mask × TEST** | **46.7** | **64** |

B is where the time is. It builds **32 complete machines** — 16 masks × 2
TEST positions — and runs each for up to 30 ticks. Building and clocking a
machine is the expensive thing in this suite, and B does it 32 times to
answer what is fundamentally one question.

Three things to do, in order:

1. **Split the marker.** The two `{ }` blocks are independent; giving the
   second its own `// ── ` header lets the runner put them on different
   cores. One line, but note it only takes the floor from 58.8s to 46.7s —
   B is still the floor afterwards. Do it because it is free, not because
   it solves the problem.

2. **Stop rebuilding the machine per mask.** This is the actual win. All
   32 machines are identical except one ROM byte (`0x10 | mask`). Two
   options, and the second is better:
   - Build once per mask and sweep TEST inside it — halves it to ~23s.
   - Better: the mask is *fetched from ROM*, so a single machine whose ROM
     holds all sixteen `JCN` variants in sequence covers every mask in one
     build. That is a real rewrite, but it is also a better test — it
     exercises the masks in a running program rather than in sixteen
     freshly-reset machines. Should land near 3-5s.

3. **Look for the same pattern elsewhere.** The two-byte block (22.6s)
   resets and re-runs its program four times to check four properties.
   Recording one trace and asserting against it repeatedly would cut most
   of that. My own accumulator-group block does this three times and
   should be fixed at the same time — it is the same mistake, freshly
   made.

Expected result: the JCN floor drops from 46.7s to single digits, which
makes **two-byte fetch (22.6s) the new floor**. Step 3 then matters, and
the suite should land around 25s without touching the engine.

**Risk:** low, but not zero. Consolidating repeated runs means several
assertions start sharing one trace, so a bug that corrupts the machine
mid-run could be masked where separate resets would have caught it. Where
a block resets deliberately *because* it is testing reset, leave it alone.

## Option 3 — make `settle()` faster

**Do last, and separately. Highest value, highest risk.**

The real cost is per-tick, and it scales badly:

| machine | per tick |
|---|---|
| fetch | 7.1ms |
| accumulator | 9.8ms |
| adding machine | 22.0ms |
| conditional | 21.9ms |
| **two-byte** | **29.4ms** |
| accumulator group | 17.3ms |

Every `tick()` is two clock edges, and each edge drains the event queue to
quiescence. 29ms for a few thousand devices is slow enough to suggest the
solver is redoing work rather than that the circuits are large.

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
subtle change to flood or settle order can leave 149,492 checks passing
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
- **Cutting checks.** The 131,072-case adder sweep costs ~1.7s. The check
  count is not the problem and never was.
