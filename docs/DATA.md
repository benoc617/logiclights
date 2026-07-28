# Circuit data and behaviour

A circuit is defined in two places, split by a single question: is this
inert text, or does it need evaluating?

| | Where | What |
|---|---|---|
| **Catalogue** | `web/data/circuits.json` | id, group, name, prose, bus hints, legend rows, state-grid layout |
| **Behaviour** | `web/js/behaviour/<technology>.js` | `build`, `readout`, `select`, `read` |

## The four kinds of prose

Text about a circuit is split by where the reader is when they want it,
because one long description served all three badly — it filled the footer,
and the reader who wanted the idea got the construction details first.

| Field | Where it shows | What belongs there |
|---|---|---|
| `title` | the status row, after the name | a few words naming what this demonstrates. Not a sentence; it truncates |
| `brief` | top of the info panel | one or two sentences: what you are looking at and why it matters |
| `walkthrough` | info panel, first tab | the program line by line — machines only |
| `desc` | info panel, "Engineering detail" | how it is built, what it cost, which bug the shape avoids |

The split is worth keeping deliberately. `brief` is the only prose most
readers see, so it carries the idea rather than the implementation; `desc`
is where the construction argument lives, and it can be as long as it needs
to be because nobody reads it by accident.

**Walkthrough values are verified, not asserted.** Each step may quote
machine state (`ACC`, `CY`, a register), and the test suite re-runs the
machine headless and checks every quoted value against what the hardware
actually settles to — including that the named instruction is really the
byte at that address. This exists because a hand-maintained comment already
drifted once: the accumulator group's description confidently walked
through a program that had been replaced. Prose that quotes hardware has to
be executable, or it is only a claim about hardware.

They are joined in `web/js/circuits.js`, keyed by circuit id, and the join
is strict in both directions. An entry with no behaviour, or behaviour with
no entry, throws at load rather than producing a circuit that quietly fails
to appear — a mistyped id is the likeliest error either half can make, so it
is made loud.

The catalogue has a JSON Schema beside it (`circuits.schema.json`)
documenting every field. That file is the reference; this one explains why
the line falls where it does.

## Adding a circuit

The full procedure is in [CLAUDE.md](../CLAUDE.md#adding-a-circuit) — this
file covers only the data/behaviour split it refers to.

One rule specific to that split, beyond the strict join described above:
the group must match the devices the circuit is actually made of. The test
suite checks it — a circuit filed under CMOS really does have to use
complementary pairs.

## Why the split is here and not elsewhere

Four fields resisted becoming data, for different reasons:

- **`build`** places devices and routes wires. For a hand-routed circuit it
  is thirty lines of coordinates, which *could* be a netlist. For a composed
  machine it is a loop — `nAlu` generates its mux tree programmatically, and
  the register file stamps sixteen rows. Those do not reduce to a static
  netlist without either flattening them (losing the structure that makes
  them comprehensible) or putting loops in the data format.
- **`readout`** is arbitrary string formatting, including conditionals:
  `A − B = 4 (borrow — negative)`.
- **`select`** picks a live legend row from bus values, sometimes with
  arithmetic (the tri-state bus compares two drivers' data and enables).
- **`read`** walks the circuit's nets. The ALU's version deliberately reads
  what the hardware settled to rather than recomputing the result, because
  a display doing its own arithmetic would agree with a broken circuit.

Everything else — every string a reader sees, every legend row, every bus
caption — is now data, editable without touching JavaScript and checkable
against a schema.

## TODO: full JSON circuits

The next step, if the goal is circuits authored without writing code — and
it is the same format the **build-your-own-circuit editor** in
[ROADMAP.md](ROADMAP.md) would need, so it is that feature arriving early
rather than extra work.

It requires four things this repo does not have:

1. **A netlist + geometry schema.** Devices, nets, wires, and their
   coordinates, expressive enough for the hand-routed layouts. Those
   layouts are the teaching material (see CLAUDE.md) — a format that
   auto-arranges them would lose the thing they exist to show.
2. **Parametric structure.** Sixteen register rows and four ALU bit slices
   are generated, not enumerated. Either the format grows repetition
   (`repeat`/`foreach` with index substitution), or composed machines stay
   in code and only the hand-routed ones become data. The second option is
   smaller and probably right to do first.
3. **An expression language** for `readout`, `select` and `read`. Something
   deliberately small — field access, arithmetic, comparison, a conditional
   — evaluated against bus values and net states. The hazard is that this
   grows into a programming language nobody chose to design; a hard
   restriction (no loops, no definitions, pure expressions) is what keeps it
   honest.
4. **Validation with real errors.** A malformed netlist should say which
   device references a net that does not exist, not fail somewhere inside
   the solver.

Worth noting what *cannot* move: the four-state solver, the timing
scheduler and the renderer are the simulator, and they stay code. The
question is only how much of a circuit's definition can be declared rather
than programmed.

A reasonable order: schema for hand-routed circuits first (they are the
majority and the simplest), keeping composed machines in code; then the
expression language; then parametric structure only if the editor needs it.
