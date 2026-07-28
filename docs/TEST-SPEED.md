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

The engine work below has landed; the remaining cost is real work,
building and clocking large circuits.

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

### ~~Make `settle()` faster~~ — done

This was the biggest win and it landed. Two things were wrong, and the
second was not what this file predicted.

**The settle loop rescanned every device on every pass.** A pass advances
whichever devices are due, and it did that by asking all of them. Measured
on the complete 4004: **1.01 devices actually fired per pass**, out of
9,718 scanned — about 24 million pointless comparisons to settle one clock
phase. Now each net carries a CSR index of the devices watching it, `solve`
records which nets changed value, and a pass visits only those devices plus
the few holding a reservation. `step` went from 20% of runtime to 1.9%.

**`nextEventAt` rescanned every device too**, to answer "is anything still
moving?" — thousands of times per phase. It is maintained incrementally
now: `_advance` keeps the earliest pending time, and the scan only runs
when the device that owned it has fired.

One trap worth knowing, because it cost a debugging round: a modelled
peripheral writing to a switch between solves changes a net *without* any
device having driven it, so the dirty-net list misses it. A switch that
moved forces one full pass. The 4002 does this on every memory access, and
the symptom was the memory machines failing while everything else passed.

What did **not** work, both tried and reverted:

- **Resolving only the nets the floods reached.** In a machine of any size
  the floods reach about two thirds of all nets, because everything hangs
  off the rails through some chain of conducting channels. Collecting the
  list costs more than the third it saves.
- **Skipping unchanged devices when flipping edge flags.** The comparison
  costs about what the write costs.

The remaining cost is `solve` and `_flood`, together about 87% of runtime,
and both are already tight loops over typed arrays. That is the irreducible
work of resolving a switch-level network — improving further means changing
what is computed, not how.

### The other half was never the solver

Worth stating plainly, because it is the part that shows up for a *user*
rather than for the test suite.

Every device gets a slightly different switching delay, which is what stops
a rank of gates flipping in visible lockstep. It also gives every device a
*distinct* event time, and the settle advances event by event — so two
thousand devices with two thousand different times means two thousand
solves, where identical delays would coalesce into a few dozen groups.

On the complete 4004 that was the difference between about a second per
clock phase and about ten milliseconds. Not solver cost: scheduling cost,
bought entirely with visual fidelity nobody can see once the stagger is
quicker than a frame.

What costs the time is not the *size* of the spread but the number of
**distinct** switching times in it, because the settle visits each one. So
`Circuit.varianceSteps` quantises the spread into levels rather than
scaling it: 64 is the full per-device stagger, 0 puts every device on one
delay, and each halving roughly halves the events a rank of gates costs to
settle. The app steps it down with the speed slider.

Two earlier attempts got this wrong, and both are instructive:

- **Rounding delays onto a grid** that switched on below a threshold. The
  cost fell 48× between two *adjacent* slider positions — a control whose
  middle does nothing and whose one notch changes everything.
- **Scaling the spread toward the mean.** Smooth in principle, useless in
  practice: compressing it leaves every device on its own slightly
  different time, so the solve count barely moves until the spread
  collapses entirely. Measured, the cost stayed flat through most of the
  slider and then fell off the same cliff.

Quantising is what makes the control proportional, because it acts on the
quantity that actually costs. The slider's range was extended to match, its
old floor of 30 ms having sat above the engine's own 15 ms floor — so the
fast half of it did nothing on a large machine.

The default setting keeps 33 distinct delays spread over about 14 ms, which
still reads as a wavefront crossing a rank of gates. It is also about nine
times faster than the full per-device spread was, on a machine where nobody
could resolve the difference.

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
