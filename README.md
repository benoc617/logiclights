# ⚡ Logic Lights

How logic is actually built, from armatures to CMOS. Pick a circuit — a
single relay, a two-transistor inverter, a tri-state bus, an 8-bit ripple
adder — flip the input switches, and watch (and hear) the signal make its
way through the machine. Every wire is a light: amber means driven high.

- **Authentic simulation** — no gate abstractions. Everything is nets and
  devices, solved at switch level: relay contacts, MOSFET channels, diodes
  and resistors, with conduction undirected exactly like the real things
  (the circuits are designed sneak-path-free). Devices switch after a
  configurable delay, so you can *see* a carry ripple across an adder and
  *hear* the armatures clack — and transistors get a "zzzt" of their own, so
  the solid-state circuits aren't mute (real ones are silent; this is
  deliberate sonification).
- **Four-state nets** — `0` and `1`, but also `Z` for a floating wire
  (drawn dashed, holding its last value on stored charge) and `X` for
  contention (drawn red). Those are the two ways real circuits fail, and a
  simulator that can't show them will tell you a broken design works.
- **Relays *and* transistors** — the same solver runs both, because they are
  the same thing: an isolated control terminal working a bidirectional
  switch. *Three Technologies* builds one NAND gate three ways from the same
  two inputs, and the CMOS output lands while the armatures are still
  travelling.
- **Binary I/O table** — every input is grouped into a named bus (A, B, Cin
  …) you can drive by tapping bits or typing binary, instead of hunting for
  switches on the canvas. Outputs and interesting internal buses (the carry
  chain, the subtractor's inverted B) read back live in binary and decimal,
  with an equation line for the arithmetic circuits.
- **Zoom & pan** — pinch/scroll from single-contact detail out to a whole
  machine on one tablet screen.
- **Circuit library, organised by technology** — the same logic built in
  relays, CMOS and NMOS so the versions can be read side by side, plus the
  bridge circuits that connect them. The full list, device counts and the
  concept-by-technology matrix live in
  [docs/INVENTORY.md](docs/INVENTORY.md), which is generated rather than
  written, so it cannot drift.
- **A CPU being built, one idea at a time** — nine machines under
  CMOS · Machines, each isolating exactly one thing: fetch, then phase
  sequencing, the 4004's real `ADD r` datapath, conditional jumps with the
  full condition mask, two-byte fetch with a subroutine stack, `SUB`
  sharing the adder with `ADD` alongside a genuine `XCH`, the
  thirteen-instruction accumulator group, and the memory machine talking
  to a 4002 RAM across a bus — and finally the whole thing on one
  machine, every defined instruction but `WPM`, checked against a
  reference emulator after every instruction it executes. Give one a
  clock and it runs a program on its own, with the ROM disassembled beside
  it and the executing instruction highlighted. See
  [docs/4004.md](docs/4004.md) for what remains.
- **Guides for the big circuits** — a caption under every input explaining
  what it selects, a legend of function codes with the live one highlighted,
  a grid of internal state the outputs do not expose (all sixteen registers
  at once, or every function an ALU computed simultaneously), and labelled
  boxes on the canvas naming each block of a composed machine, with arrows
  between them showing what feeds what.
- **"More info" on every circuit** — a short subtitle in the status bar,
  and behind it a panel carrying the idea in a sentence or two, a
  line-by-line walkthrough of what the program does and why, and the
  engineering detail underneath. Every value the walkthrough quotes is
  re-checked against the running hardware by the test suite, so the prose
  cannot drift from the circuit it describes.

No frameworks, no build step: vanilla ES modules + canvas.

**Docs:** [docs/INVENTORY.md](docs/INVENTORY.md) — what is in the library:
every circuit, its device counts, and the concept-by-technology matrix
(generated, never hand-written) · [CLAUDE.md](CLAUDE.md) — conventions and
gotchas for working in this repo · [docs/DATA.md](docs/DATA.md) — how a circuit is split between
catalogue data and behaviour code · [docs/DEVICES.md](docs/DEVICES.md) — the device model and the
switch-level solver · [docs/DESIGN.md](docs/DESIGN.md) — how the circuit
topologies and renderer work · [docs/4004.md](docs/4004.md) — the plan for
building a 4004 · [docs/TEST-SPEED.md](docs/TEST-SPEED.md) — where the test
suite spends its time and what would make it faster ·
[docs/ROADMAP.md](docs/ROADMAP.md) — the queue and open TODOs.

## Run it

Any static file server pointed at `web/`:

```bash
cd web && python3 -m http.server 8080
# → http://localhost:8080
```

## Bus naming

The I/O table builds buses from names: a trailing number makes a bit, so
switches `A0`..`A7` become the 8-bit bus **A** (bit 0 = LSB) and anything
else (`Cin`, `SUB`, `LOAD`) is a one-bit bus. Lamps work the same way via
`addLamp(..., { short: 'Y0' })` when the on-canvas caption is wordier than
the table wants. A circuit can also expose internal signals with
`c.addBus('CARRY', nets)`, and a registry entry can add an equation line
with `readout: v => ...`.

## Tests

Full truth-table verification of every circuit (all 131k+ adder input
combinations, latch sequences, oscillator dynamics) plus bus grouping,
one-hot decoding, two's-complement readouts, and the four-state device
behaviour — drive strength, floating nets, and bus contention:

```bash
node test/run.mjs
```

## Deployment

- **GitHub Pages** — pushed to `main`, `.github/workflows/pages.yml` runs the
  tests and publishes `web/` automatically.
- **Puzzleboss infra (ECS)** — the `Dockerfile` builds an nginx image serving
  under `/lights/` with a health endpoint at `/lights/health`, matching the
  Terraform in
  [puzzleboss2-infra](https://github.com/bigjimmy/puzzleboss2-infra)
  (`lights` ECS service, ALB rule `/lights*`). Build & push on the utility
  server (native ARM64):

  ```bash
  aws ecr get-login-password --region us-east-1 | \
    docker login --username AWS --password-stdin "$ECR/puzzleboss/lights"
  docker build -t "$ECR/puzzleboss/lights:latest" .
  docker push "$ECR/puzzleboss/lights:latest"
  aws ecs update-service --cluster puzzleboss --service lights --force-new-deployment
  ```

## Roadmap

- Bigger machines: ALU, memory unit with address decoding … an Intel 4004,
  device by device. See [docs/4004.md](docs/4004.md).
- Build-your-own-circuit editor, saving creations alongside the examples.
- iOS app.

## How the adder works (the fun part)

Each full-adder cell is 3 relays / 11 contacts. The **sum** is a changeover
staircase — the same trick as a hallway light with switches at both ends,
chained three deep, computing parity. The **carry** is a majority vote:
three series contact pairs (A·B, B·Cin, A·Cin) in parallel. Chain four or
eight cells carry-to-carry and you have arithmetic you can watch happen.

## Why a relay and a transistor are the same circuit

A relay coil is galvanically isolated from its contacts; a MOSFET gate has
no DC path to its channel. Both work a switch that conducts in either
direction. So an NO contact is an NMOS, an NC contact is a PMOS — and a
relay's SPDT changeover is exactly a complementary pair, which is to say a
CMOS inverter.

The difference that matters is what happens when the switch is *off*. A
relay circuit's lamp returns through a ground nobody drew, so an unfed net
is simply dark. A transistor that turns off doesn't pull its output
anywhere — it just lets go, and the net floats. That is why the solver
needs four states instead of two, why every device circuit here wires both
rails, and why *Tri-State Bus* is worth playing with: it is the one thing a
relay rack cannot do, and it is what lets a CPU have buses.
