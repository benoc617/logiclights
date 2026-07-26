# Devices and the switch-level solver

What the simulator actually models, and why it is built this way. Read this
before changing `engine.js` or adding a circuit that uses anything other
than relays.

## The idea

A circuit is a set of **nets** joined by **devices**. Every device is a
switch — that is the whole model. What differs between a relay contact and a
MOSFET channel is what controls the switch and how fast it moves, not what
it does electrically.

This is not a relay-specific trick. Switch-level simulation is the classic
way to model MOS circuits: a transistor becomes a switch controlled by its
gate node, and the circuit is solved by connectivity rather than by solving
for currents. One solver therefore handles an armature rack and a CMOS gate
with no special cases.

The two devices really are the same shape:

| Relay | MOSFET |
|---|---|
| Coil — isolated from the contacts, sensed but never joined | Gate — no DC path to the channel |
| Contact — conducts in both directions | Channel — conducts in both directions |
| NO contact (closed when energized) | NMOS (conducts when the gate is high) |
| NC contact (closed at rest) | PMOS (conducts when the gate is low) |
| SPDT changeover | an NMOS and a PMOS sharing a gate |

That last row is worth dwelling on: a relay changeover is a complementary
pair, which is exactly what a CMOS inverter is.

## Rails and node values

Net 0 is **VDD** and net 1 is **VSS**. Everything else resolves to one of
four values:

| Value | Meaning |
|---|---|
| `0` / `1` | driven low / high |
| `Z` | floating — no source can reach it |
| `X` | contention — sources of both polarities can reach it |

`Z` and `X` are the two failure modes of MOS design, and a simulator that
cannot express them will happily report that a broken circuit works. They
are drawn distinctly: `Z` is a dashed cool-grey wire, `X` is red.

## Strengths

A node takes the value of the **strongest** source that reaches it. Equal
strongest sources that disagree make it `X`.

| Strength | Source |
|---|---|
| `STRONG` | a rail, through channels and contacts |
| `WEAK` | a rail, through a resistor |
| `CHARGE` | nothing — the node holds its last driven value on its own capacitance |
| `NONE` | never driven, so `Z` |

Strength is what makes a pull-up work: a resistor to VDD loses to any
channel path to ground, which is exactly why an NMOS inverter inverts.

## How a solve works

1. Rebuild the conducting adjacency: closed switches, relay contacts on
   whichever throw the armature is resting on, and transistor channels that
   are on.
2. Flood `1` outward from VDD and `0` outward from VSS, through channels,
   contacts and diodes.
3. Seed the weak pass from the far end of every resistor whose near end came
   out strongly driven, and spread those seeds through the same channels.
4. Resolve each net: strong beats weak beats stored charge; both polarities
   at the same strength is `X`; nothing at all is `Z`.

### Two rules that are easy to get wrong

Both of these were bugs during the port, and both produce plausible-looking
nonsense rather than an obvious failure:

- **A flood stops at the opposite rail.** A supply is an ideal source. A
  short across it drags the shorted nets to `X`, but the rail must not then
  carry the wrong polarity onward into every other net hanging off it —
  otherwise one crowbar anywhere turns the whole machine `X`.
- **The weak pass stops at any strongly driven net.** A node clamped by a
  strong driver cannot pass a weak drive along to its neighbours. Without
  this, a pull-up on one gate leaks through a hard-driven node into the net
  next door.

## The devices

| Builder | What it is |
|---|---|
| `addRelay(name, coil, x, y, contacts)` | SPDT changeover contacts worked by a coil |
| `addTransistor(name, kind, gate, a, b, x, y)` | `'nmos'` or `'pmos'`; channel `a`–`b` is bidirectional and symmetric |
| `addDiode(name, anode, cathode, x, y)` | the only directional device |
| `addResistor(name, a, b, x, y)` | a weak bidirectional conductor |
| `addSwitch(label, net, kind, x, y, opts)` | hand-operated; `opts.to` makes it a changeover |

### Directionality

Contacts and channels conduct **both ways**, exactly like the real things,
so circuits must be designed sneak-path-free. The diode is the exception:
it passes a `1` from anode to cathode and a `0` from cathode to anode, and
blocks the other way. That asymmetry is the whole of diode logic, and it is
why a diode matrix works where a bare switch matrix sneak-paths.

### Input switches

A simple switch joins `opts.from` (default VDD) to its net when closed, and
otherwise leaves it alone — fine for relay circuits, where the implicit
ground means an unfed net reads `0`. A **changeover** switch (`opts.to`) is
what device circuits use: it connects its net to one rail or the other so
the net is always driven. A MOS gate needs driving both ways; leaving one
floating is a fault, not an input state.

## Timing

Every device with a control terminal switches after a delay, and that delay
is the only reason any of this is watchable. Relays use `baseDelay`;
transistors use `baseDelay × 0.3`. The ratio is wildly unphysical — a real
one is around 10⁹ — but it keeps a mixed circuit legible: in *Three
Technologies* the CMOS output lands while the armatures are still moving.

Each device gets a deterministic ±8% variance from a hash of its index, so
propagation looks organic and tests stay reproducible.

### The transient that falls out of this

Because the P and N devices of an inverter switch at slightly different
times, every transition passes through a brief moment where both are on
(`X` — a real short through the pair, which is where crowbar current comes
from) or both are off (`Z` — the output floating on its own charge). Nothing
special-cases this; it is what the model says happens, and real chips are
designed to fight both. Slow the speed slider right down and you can watch
it happen.

## Compatibility with the relay-only era

The original one-rail model has no ground on the schematic: a lamp's return
path and the far end of every coil went to a rail that was never drawn.
`Circuit.implicitGround` (default `true`) models that as a weakest-of-all
pull-down on every net, which reproduces the old behaviour exactly — under
it, nothing can float and nothing can contend. Device circuits wire VSS
themselves and set it `false`, and that is what lets `Z` and `X` exist.

The test suite is the proof: all of the original relay truth tables, sweeps
and latch sequences pass unchanged under the four-state solver, and a
dedicated test asserts that no relay circuit ever produces `X` or `Z`.

## Deliberate simplifications

These are approximations, and they are listed here so nobody mistakes them
for physics:

- **No threshold drops.** A real NMOS passes a degraded `1` and a PMOS a
  degraded `0`, which is why pass-transistor logic cannot be cascaded
  without restoration. Here a channel passes a full level. The
  *Transmission Gate* circuit therefore shows the right topology for the
  right reason, but not the level loss that motivates it.
- **No charge decay.** Stored charge is held indefinitely rather than
  leaking away, so a dynamic node never needs refreshing. Modelling decay
  is a prerequisite for an authentic PMOS-era 4004 (see
  [4004.md](4004.md)).
- **No analogue anything.** Gates at `X` or `Z` turn their channel off
  rather than partially on — this is a discrete model and it will not guess
  at an indeterminate level.
- **Lamps are ideal probes.** A lamp reads its net without loading it.
