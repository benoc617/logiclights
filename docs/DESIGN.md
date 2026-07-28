# Design notes

How Logic Lights actually works, and why it's built this way. Read this
before changing the simulation core or adding a large circuit.

## The simulation

A circuit is a set of **nets** joined by **devices** — relay contacts,
MOSFET channels, diodes and resistors — solved at switch level. Net 0 is
**VDD** and net 1 is **VSS**; every other net resolves to `0`, `1`, `Z`
(floating) or `X` (contention), at a strength of strong, weak or stored
charge.

The full model, including the two flood rules that are easy to get wrong
and the list of deliberate simplifications, is in
[DEVICES.md](DEVICES.md). Read that before touching `engine.js`. Every step:

1. Rebuild the conducting adjacency: closed switches, relay contacts on
   whichever throw the armature rests on, transistor channels that are on.
2. Flood `1` from VDD and `0` from VSS through channels, contacts and
   diodes, then run the weak pass seeded from resistors.
3. Each relay reads its coil net and each transistor its gate net. If the
   control state differs from the device's current or pending position,
   schedule a flip at `now + delayOf(device)`.
4. Apply any flips whose time has arrived, then repeat until nothing moves
   (bounded — see below).

### Consequences worth understanding

- **Conduction is undirected.** There are no inputs and outputs at the
  electrical level, in a relay rack or in a MOS channel alike. Current
  entering a contact tree from the "wrong" end will happily light things up.
  This is authentic, and it means circuit topologies must be designed
  sneak-path-free. It is the single most common source of subtle bugs here.
  The diode is the one exception, and that asymmetry is the whole of diode
  logic.
- **Feedback is a first-class citizen.** Because devices have real delay, a
  relay whose coil is fed through its own NC contact oscillates (the
  buzzer), and a relay latching itself through its own NO contact remembers
  (the SR latch). Nothing special-cases these.
- **Nothing is guaranteed to settle.** `step()` caps its inner loop at 64
  iterations per call, and the test harness's `settle()` gives up after
  5000 scheduled events. Any new code that waits for stability needs a
  bound.
- **Per-device variance.** `delayFactor` is a deterministic hash of the
  device's index giving ±8% spread, so propagation looks and sounds organic
  rather than machine-synchronized. Deterministic matters: tests must be
  reproducible. One side effect is real: the two halves of a CMOS pair
  never switch at quite the same instant, so every transition passes
  through a moment of `X` (both on) or `Z` (both off).
- **Relay circuits are unchanged.** `implicitGround` models the ground that
  a one-rail schematic never drew, so under it nothing floats and nothing
  contends, and every original truth table passes byte-for-byte.

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

### Static CMOS gates

Every static CMOS gate is one logic network plus its exact dual: the
pull-down network of NMOS *is* the logic, and the pull-up network of PMOS
mirrors it with series and parallel swapped. NAND is two NMOS in series
under two PMOS in parallel; NOR is the other way round. That duality is why
the two gates come in pairs, and why either alone can build a computer.

`cmosInv()` is the informal module prototype — one column, PMOS from VDD,
NMOS to VSS, returning its gate spine so callers can tap it.

### Transmission gates and buses

An NMOS and a PMOS in parallel with complementary gates pass a full `0` and
a full `1` in either direction, which neither device manages alone. This is
the multiplexer primitive that a relay gets free from a changeover contact,
and it is why one relay contact is worth two transistors.

Two of them onto a shared net is a bus, and nothing arbitrates it: enable
neither and the net floats at `Z` on stored charge; enable both with
different data and it is `X`, a rail-to-rail short. Relays cannot do this at
all, and it is the reason a device-level CPU can have buses instead of a
multiplexer tree per destination — see [4004.md](4004.md).

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

Wires draw one pass per logic value, so a whole net reads at a glance: a
wide translucent glow for `1` and `X`, then thin strokes for `0`, dashed
cool-grey for `Z`, bright amber for `1` and red for `X`. `shadowBlur` is
deliberately avoided — it is dramatically slower for this many strokes.

Level of detail keys off px-per-world-unit: below ~2.5 relays and
transistors become state-colored blocks and glow is skipped; below ~5 labels
drop; below ~6–7 filaments and coil windings drop. This is what allows the
"zoom all the way out and it still fits a tablet" requirement — components
degrade to pixel-scale on/off indicators rather than turning into
unreadable mush.

Motion is animated from the same schedule the solver uses (`delayOf`), so
what you see matches what is simulated: an armature blade interpolates
between the NC and NO throw, and a transistor's channel bar grows to bridge
its gap as the inversion layer forms. Contacts move, they don't teleport.

## Layout

Placement follows aspect ratio, not width, because circuits are wide and
short. Portrait docks the I/O table along the bottom (width is the scarce
axis); landscape docks it right (height is scarce). Short viewports
compact the chrome. `fitView()` insets the fit by the panel's measured
rectangle so the circuit is never hidden behind it.

## Testing

`test/run.mjs` is the runner to use day to day. It splits the suite at its
`// ── ` section markers, runs the pieces across cores and sums the
results — the same checks, several times faster. Numbers are deliberately
not quoted here; [TEST-SPEED.md](TEST-SPEED.md) explains why, and how to
measure. Three properties keep it honest and are worth not breaking:

- **Blocks are independent.** Nothing carries state from one `// ── `
  section to the next except the `checks`/`failures`/`clock` counters, and
  no block depends on the `clock` value it inherits. A block that leaned
  on an earlier one would still pass serially while going wrong — or
  silently right — under the runner.
- **A dead shard is a failure, not zero checks.** If a shard exits without
  printing its summary the runner counts a failure, because "we lost some
  tests" must never be indistinguishable from "everything passed".
- **The deal is learned, not guessed.** Each clean run records what every
  block cost and the next run balances the shards with those numbers.
  Block length is a bad proxy for runtime — clock ticks are the cost, not
  lines — and balancing by length left most shards idle while two ran on.
  Only clean runs are recorded, so a part-way failure cannot teach the
  scheduler that an expensive block is cheap.

Helpers declared at top level inside a block (`lampV`, `testAdder`, the
`GATES` table) are hoisted into every shard, so the suite can keep
declaring them wherever they read best.

`test/sim-test.mjs` is plain node, no framework, no dependencies, and still
runs standalone exactly as before — reach for it when a failure wants a
clean stack trace. It drives
the real simulator through the real switch objects and asserts on lamp
nets — there is no mock layer, so a passing test means current actually
flowed. Coverage: every gate's truth table, latch set/hold/reset sequences,
register load/hold, all 131,072 8-bit adder input combinations, the
adder/subtractor across all operands in both modes, oscillator liveness
(asserting the circuit *doesn't* settle), and the bus/readout layer.

Device circuits are asserted on the four-state value, not just "is it hot":
the CMOS gates must come out `STRONG` at rest (never a short, never a
float), the NMOS inverter must be `WEAK` high and `STRONG` low so the load
is demonstrably losing to the transistor, and the tri-state bus is walked
through driven → floating-on-charge → contended → agreeing. A separate test
asserts that no relay circuit ever produces `X` or `Z`, which is what pins
the `implicitGround` compatibility path.

Visual checks are done with Playwright against the local server; the harness
lives in the session scratch space rather than the repo, since it needs a
browser and the repo has no dependencies by design.

## Deliberate non-goals (for now)

- No gate-level abstraction layer. The point is the devices: a NAND is four
  transistors or two relays, never a primitive.
- No analogue modelling — no threshold drops, no charge decay, no partially
  conducting channels. The simplifications are listed in
  [DEVICES.md](DEVICES.md); do not let them drift without writing them down.
- No framework, no bundler, no TypeScript — see CLAUDE.md rule 1.
- No server. Everything is static; saved user circuits will need a decision
  here (localStorage first, see ROADMAP).

## The two ROMs

Both read the same eight bytes out of the same array shape; they differ
only in how the bit lines are held high, and that difference is the whole
comparison.

**Resistor load (NMOS).** A pull-up resistor per bit line. The array is a
wired-AND: a transistor at a site pulls its line down to store a 0, an
empty site leaves it pulled up as a 1, and programming a mask ROM is
deciding where to put transistors. The cost is that whenever a line is
pulled low there is an unbroken path from the rail to ground for as long as
it stays there.

**Precharge (CMOS).** No resistors: a P-channel per line, plus a foot
transistor per column, both gated by PRE. With PRE low the pull-ups charge
every line; PRE then rises, the pull-ups switch off, the feet switch on,
and the selected row discharges only the lines storing 0. Nothing ever
fights, so there is no static current at all.

Two things this arrangement forces, both real properties of dynamic logic
rather than modelling artifacts:

- **The foot transistors are not optional.** Without them the array still
  conducts during precharge, shorting VDD to VSS through the selected site;
  the bit line reads X and the data only comes out right if the downstream
  inverters happen to resolve the X favourably. The test suite asserts the
  precharge phase draws no crowbar current, not merely that the bytes are
  correct.
- **PRE must fall before the address moves.** Change the address mid-
  evaluate and the new row discharges lines the old one already pulled
  down, and nothing restores them until the next precharge.

A static P-channel load — pseudo-NMOS — is deliberately *not* offered.
Real pseudo-NMOS works because the pull-up is fabricated far weaker than
the pull-down; this simulator has one drive strength per transistor, so the
two would simply contend and the line would read X. That is the model being
honest about what it does not represent, and it is why the CMOS version has
to be dynamic.

## Region annotations

`c.region(text, x0, y0, x1, y1)` draws a labelled box *behind* the circuit
naming a block of it — "Write decoder", "Bit 2 (MSB)", "r9". They exist
because a composed machine of several hundred transistors reads as
undifferentiated texture at any zoom that fits it on screen, and the boxes
are what turn that back into structure you can point at.

They are annotation only: they conduct nothing and the solver never reads
them. `ModuleBuilder.region()` deliberately does not grow an instance's
extent, so drawing a box around a block never shifts the next one.

Two rendering choices differ from the device labels, on purpose:

- **Drawn at every zoom level.** Device labels drop out below ~5 px per
  world unit because at that scale they are noise. Region captions do the
  opposite — they matter *most* when zoomed out, which is exactly when
  everything else stops being legible — so the caption size is computed in
  pixels and converted back to world units, clamped to a readable range.
- **Captions clip to their own box.** Without that, adjacent blocks' labels
  overlap the moment two boxes sit side by side, and a caption that
  overflows its box points at the wrong devices. `side: 'inside'` tucks the
  label into the top-left corner for boxes packed too tightly for an
  outside caption — the sixteen register rows, the per-slice internals of
  the ALU. `side: 'left'` runs it up the left edge instead, for a box that
  *encloses* other labelled boxes: both captions would otherwise be drawn
  at the same corner and the outer name would sit on the inner one.

Because the caption is clipped, a region name has to be a **block name and
not a description** — "Adder", not "Adder — accumulator + register +
carry". A long one is truncated to an ellipsis, so the explanation is lost
while still costing layout; that prose belongs in the circuit's `brief` or
`desc`, which the info panel shows in full.

Boxes may nest, and do — a register row inside its bank inside the file —
but two boxes must never *partially* overlap. A box crossing another's edge
means one block's caption is pointing at another block's devices, which is
worse than no label at all. The test suite checks this, because it is
invisible until you look at exactly the right zoom: thirty-four crossings
had accumulated across the machines before anyone measured.

## Flow arrows

`c.flow(fromName, toName, { label })` draws a labelled arrow between two
named regions — "Program counter" to "ROM row decode", labelled `address`.
Also annotation: nets carry the electrical truth, but on a machine with
thousands of devices a single signal is one thread among hundreds, and the
block-level story of what feeds what is invisible without saying it.

Endpoints are region *names* rather than coordinates, so an arrow follows
its boxes when a block moves instead of having to be re-typed — and a name
that matches no region throws rather than silently drawing nothing, since a
diagram quietly losing half its arrows is the failure worth preventing.
Routing is an elbow between the nearest facing edges, which keeps every
arrow on one of two axes; `{ dir: 'v' }` forces a vertical departure where
the automatic choice would cut back across the source box.

## The circuit picker

A native `<select>` cannot nest: optgroups do not contain optgroups. With
dozens of circuits across four technology sections, a flat list with
indented labels made a heading indistinguishable from the circuits under
it. `js/picker.js` is a custom widget instead — collapsed technology
sections that expand to reveal their subsections — and it deliberately
exposes the same small surface the `<select>` did (a readable and
assignable `.value`, plus a `change` listener), so the rest of the app is
unaware it is not a native control.
