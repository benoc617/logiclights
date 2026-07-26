# Design notes

How Logic Lights actually works, and why it's built this way. Read this
before changing the simulation core or adding a large circuit.

## The simulation

A circuit is a set of **nets** joined by **contacts**. Net 0 is the `+`
rail and is always hot. Every step:

1. Build an adjacency list. Each closed switch joins the rail to its net;
   each relay contact joins its common to either its NO throw (energized)
   or its NC throw (at rest).
2. Flood-fill from the rail. A net is **hot** iff current can reach it.
3. Each relay reads its coil net. If it differs from the armature's current
   or pending position, schedule a flip at `now + baseDelay × delayFactor`.
4. Apply any flips whose time has arrived, then repeat until nothing moves
   (bounded — see below).

### Consequences worth understanding

- **Conduction is undirected.** There are no inputs and outputs at the
  electrical level, exactly like a real relay rack. Current entering a
  contact tree from the "wrong" end will happily light things up. This is
  authentic, and it means circuit topologies must be designed sneak-path-
  free. It is the single most common source of subtle bugs here.
- **Feedback is a first-class citizen.** Because relays have real delay, a
  relay whose coil is fed through its own NC contact oscillates (the
  buzzer), and a relay latching itself through its own NO contact remembers
  (the SR latch). Nothing special-cases these.
- **Nothing is guaranteed to settle.** `step()` caps its inner loop at 64
  iterations per call, and the test harness's `settle()` gives up after
  5000 scheduled events. Any new code that waits for stability needs a
  bound.
- **Per-relay variance.** `delayFactor` is a deterministic hash of the
  relay's index giving ±8% spread, so propagation looks and sounds organic
  rather than machine-synchronized. Deterministic matters: tests must be
  reproducible.

## Circuit topologies

### Full adder (3 relays, 11 contacts)

The **sum** is a parity staircase: relay A's changeover splits the current
into "so far even" and "so far odd" rails, B's two changeovers cross them
over, C's two changeovers merge them into one lamp. Same trick as a hallway
light with switches at both ends, chained three deep.

The **carry** is a majority vote: three series pairs (A·B, B·Cin, A·Cin)
wired in parallel, so any two of three inputs completes the path. Each pair
uses a dedicated NO contact rather than tapping the sum network — that
separation is what keeps the cell sneak-path-free.

Ripple adders chain N cells carry-to-carry. The carry lane is routed below
the cells at staggered heights so adjacent runs don't overlap visually.

### Adder/subtractor

`SUB` drives an 8-pole relay that selects, per bit, either B or ~B (each
produced by a small inverter relay), *and* feeds the carry-in. That is
two's complement in hardware: A − B = A + (~B) + 1. The `Beff` internal bus
shows the selected value live, which makes the inversion visible.

### Register

Four D latches sharing one `LOAD` button through an 8-pole relay: two poles
per bit, one gating D in, one holding Q through itself when LOAD is
released.

## Binary I/O buses

`buses.js` groups switches and lamps by name — a trailing number makes a
bit, so `A0..A7` is bus A with bit 0 as LSB. Bits are sorted then packed
LSB-first, so indices needn't start at zero or be contiguous (lamps named
N1/N2/N3 read as a 3-bit bus). Anything without a trailing number is a
one-bit bus. Row order follows creation order, so operands should be
created before mode switches.

Circuits can expose internal signal groups with `c.addBus(name, nets)` —
used for the adders' carry chain and the subtractor's inverted B — and can
add an equation line with a `readout(vals)` function in the registry.

## Rendering

World units are circuit-space; the view is a scale plus an offset, so pan
and zoom are cheap and the layout code never thinks in pixels.

Wires draw in three passes: a wide translucent glow for hot nets, thin
strokes for cold ones, brighter strokes for hot ones. `shadowBlur` is
deliberately avoided — it is dramatically slower for this many strokes.

Level of detail keys off px-per-world-unit: below ~2.5 relays become
state-colored blocks and glow is skipped; below ~5 labels drop; below ~6–7
filaments and coil windings drop. This is what allows the "zoom all the way
out and it still fits a tablet" requirement — components degrade to
pixel-scale on/off indicators rather than turning into unreadable mush.

Armature travel is animated by interpolating the blade between the NC and
NO throw over the relay's delay, so you see the contact move, not teleport.

## Layout

Placement follows aspect ratio, not width, because circuits are wide and
short. Portrait docks the I/O table along the bottom (width is the scarce
axis); landscape docks it right (height is scarce). Short viewports
compact the chrome. `fitView()` insets the fit by the panel's measured
rectangle so the circuit is never hidden behind it.

## Testing

`test/sim-test.mjs` is plain node, no framework, no dependencies. It drives
the real simulator through the real switch objects and asserts on lamp
nets — there is no mock layer, so a passing test means current actually
flowed. Coverage: every gate's truth table, latch set/hold/reset sequences,
register load/hold, all 131,072 8-bit adder input combinations, the
adder/subtractor across all operands in both modes, oscillator liveness
(asserting the circuit *doesn't* settle), and the bus/readout layer.

Visual checks are done with Playwright against the local server; the harness
lives in the session scratch space rather than the repo, since it needs a
browser and the repo has no dependencies by design.

## Deliberate non-goals (for now)

- No gate-level abstraction layer. The whole point is relays.
- No framework, no bundler, no TypeScript — see CLAUDE.md rule 1.
- No server. Everything is static; saved user circuits will need a decision
  here (localStorage first, see ROADMAP).
