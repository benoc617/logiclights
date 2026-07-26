# ⚡ Logic Lights

Logic circuits the way they were built before transistors: **relays**. Pick a
circuit — from a single relay up through gates, latches, registers and ripple
adders — flip the input switches, and watch (and hear) the signal click its
way through the machine. Every wire is a light: amber means energized.

- **Authentic simulation** — no gate abstractions. Nets conduct through relay
  contacts from the + rail, exactly like a relay rack (conduction is
  undirected; the circuits are designed sneak-path-free). Coils pull in after
  a configurable mechanical delay, so you can *see* a carry ripple across an
  adder and *hear* the armatures clack.
- **Binary I/O table** — every input is grouped into a named bus (A, B, Cin
  …) you can drive by tapping bits or typing binary, instead of hunting for
  switches on the canvas. Outputs and interesting internal buses (the carry
  chain, the subtractor's inverted B) read back live in binary and decimal,
  with an equation line for the arithmetic circuits.
- **Zoom & pan** — pinch/scroll from single-contact detail out to a whole
  machine on one tablet screen.
- **Circuit library** — Meet the Relay, Buzzer, Ring Oscillator; NOT / AND /
  OR / XOR / NAND / NOR; 2-to-4 Decoder; SR Latch, D Latch, 4-bit Register;
  Half/Full Adder, 4-bit & 8-bit Ripple Adders, 4-bit Adder/Subtractor
  (two's complement).

No frameworks, no build step: vanilla ES modules + canvas.

**Docs:** [CLAUDE.md](CLAUDE.md) — conventions and gotchas for working in
this repo · [docs/DESIGN.md](docs/DESIGN.md) — how the simulation, circuit
topologies and renderer work · [docs/ROADMAP.md](docs/ROADMAP.md) — the
plan and open TODOs.

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
one-hot decoding, and two's-complement readouts:

```bash
node test/sim-test.mjs
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

- Bigger machines: ALU, memory unit with address decoding … an Intel 8008,
  relay by relay.
- Build-your-own-circuit editor, saving creations alongside the examples.
- iOS app.

## How the adder works (the fun part)

Each full-adder cell is 3 relays / 11 contacts. The **sum** is a changeover
staircase — the same trick as a hallway light with switches at both ends,
chained three deep, computing parity. The **carry** is a majority vote:
three series contact pairs (A·B, B·Cin, A·Cin) in parallel. Chain four or
eight cells carry-to-carry and you have arithmetic you can watch happen.
