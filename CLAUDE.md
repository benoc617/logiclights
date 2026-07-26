# CLAUDE.md

Guidance for Claude Code working in the Logic Lights repo.

## What this is

An interactive web app showing how logic is actually built out of physical
devices — **relays, then transistors** — with lights on every wire, visible
propagation delay, and optional device sounds. It runs from a single relay,
through CMOS gates and a tri-state bus, up to an 8-bit ripple adder today;
the long arc is an Intel 4004 plus a build-your-own-circuit editor (see
[docs/ROADMAP.md](docs/ROADMAP.md) and [docs/4004.md](docs/4004.md)).

Read [docs/DEVICES.md](docs/DEVICES.md) before touching `engine.js` — it
documents the four-state switch-level solver, the two flood rules that are
easy to get wrong, and the deliberate simplifications. Design and rationale
for everything else live in [docs/DESIGN.md](docs/DESIGN.md).

## Hard rules

1. **No dependencies, no build step.** Vanilla ES modules + canvas, served
   as static files. Anything that needs npm install, bundling, or a
   framework is out. This is what lets the app ship as a GitHub Pages site,
   an nginx container, and a single inlined HTML file simultaneously.
2. **`node test/sim-test.mjs` must pass before every commit.** It is the
   only guard on circuit correctness — the topologies are hand-wired and a
   one-character slip produces a plausible-looking circuit that adds wrong.
   Add cases for whatever you change.
3. **Circuits are simulated, never faked.** No shortcut that computes a
   gate's output arithmetically. Everything is nets, channels, contacts and
   coils; if it lights up, current actually reached it. A reference model
   used as a test oracle is fine — in `test/` only, never in the app.

## Layout

```
web/
  index.html          UI shell
  css/style.css       all styling (orientation-aware, see below)
  js/engine.js        Circuit: nets, devices, four-state solver, timing
  js/geometry.js      symbol geometry shared by builders and renderer
  js/circuits.js      the circuit library + registry (CIRCUITS)
  js/module.js        sub-circuit modules: named ports, local coordinates
  js/gates.js         reusable CMOS gates built on module.js
  js/alu.js           4-bit ALU, composed from gates.js
  js/rom.js           NMOS mask ROM array + row decoder
  js/buses.js         groups switches/lamps into binary buses
  js/render.js        canvas renderer (pan/zoom, glow, LOD)
  js/sound.js         WebAudio relay clicks + transistor "zzzt"
  js/main.js          UI wiring, rAF loop, pointer input, binary I/O panel
test/sim-test.mjs     headless truth-table suite (no runner, plain node)
Dockerfile            nginx image serving /lights/ for the puzzleboss stack
nginx.conf            with /lights/health for the ALB health check
.github/workflows/    tests + GitHub Pages deploy on push to main
```

## The device model in one paragraph

Net 0 is **VDD**, net 1 is **VSS**. Nets resolve to `0`, `1`, `Z`
(floating) or `X` (contention) at a strength of strong / weak / stored
charge. Relays and transistors are the same thing wearing different clothes
— an isolated control terminal working a bidirectional switch — so
`addRelay` and `addTransistor` share one solver and one delay scheduler.
Diodes are the only directional device. Full detail in
[docs/DEVICES.md](docs/DEVICES.md).

## Hand-routed circuits vs composed machines

Two ways to build, deliberately kept apart.

The **library circuits** in `circuits.js` are hand-placed: every device at a
chosen coordinate, every wire routed by eye. They are the teaching material,
their layouts are the explanation, and they should stay that way.

The **composed machines** (`alu.js`, and whatever follows) are assembled from
modules in `gates.js` via `module.js`. A module declares named ports, builds
in local coordinates, and gets instantiated at a position with its ports
bound to caller nets; device names are namespaced by instance tag so a fault
in one of sixteen copies is identifiable. Modules nest.

The rule of thumb: if you would place it by eye, hand-route it. If it needs
more than a few dozen devices or the same block more than three times,
compose it. When composing, pitch instances to the blocks' measured extents
(`inst.w` / `inst.h`) — guessing leaves a sparse, unreadable circuit, and
these layouts want to be wide and short like the rest of the library.

## Adding a circuit

1. Write a `buildX()` in `circuits.js` returning a `Circuit`. Use `c.net()`
   for signals, then `relay()`, `c.addTransistor()`, `c.addDiode()`,
   `c.addResistor()`, `c.addSwitch()`, `c.addLamp()`, and `w()` for wires.
   Coordinates are world units, hand-placed.
   - **Relay circuits**: keep the default `implicitGround`, feed from the
     `+` rail with `railFeed()`, and don't wire VSS.
   - **Device circuits**: call `mosScaffold()`, which draws both rails,
     turns `implicitGround` off, and puts changeover inputs down the left.
     `cmosInv()` builds an inverter column and hands back its gate spine.
2. Register it in `CIRCUITS` with `id`, `group`, `name`, `build`, `desc`.
   Optionally `readout: v => ...` for an equation line in the I/O table.
3. Add truth-table cases to `test/sim-test.mjs`. For anything with more
   than a couple of inputs, sweep the full input space — the 8-bit adder
   sweeps all 131,072 combinations and it still runs in seconds. For device
   circuits assert on the four-state value *and* the strength, not just on
   `hot`: "the lamp is lit" does not distinguish a driven 1 from a floating
   node that happens to be holding one.
4. Check it visually at several zoom levels; wires are hand-routed and
   overlaps are easy to miss.

**Wires are decorative.** `c.wire()` only stores geometry — conduction comes
entirely from devices. Two wires of different nets sharing a segment is a
lie the simulator will never catch, so route deliberately. Crossings are
fine and normal; collinear overlaps are not.

**Naming drives the binary I/O table.** A trailing number makes a bus bit:
switches `A0..A7` become bus **A** with bit 0 as LSB. Names without a
number (`Cin`, `SUB`, `LOAD`) are one-bit buses. Switch/lamp creation order
sets row order in the table — create operands before mode switches. For a
lamp whose on-canvas caption is wordy, pass `{ short: 'Y0' }`. Expose an
interesting internal signal group with `c.addBus('CARRY', nets)`.

## Things that will bite you

- **Conduction is undirected**, in a relay rack and in a MOS channel alike.
  A contact tree that looks fine can leak current backwards through another
  branch (a "sneak path") and light things that should be dark. The test
  suite is the only thing that catches this — never add a circuit without
  one. Diodes are the exception and exist precisely to break the symmetry.
- **A lit lamp is not a driven net.** With `implicitGround` off, an undriven
  net floats and holds its last value on stored charge, so it can read `1`
  long after anything stopped driving it. Assert on `c.strength[]` when that
  distinction matters.
- **Every CMOS transition passes through a glitch.** The P and N halves have
  independent delays, so there is always a brief `X` (both on — real crowbar
  current) or `Z` (both off) mid-handover. This is the model being honest,
  not a bug. Tests must assert on *settled* state.
- **Conduction tables are precomputed and must be invalidated.** `solve()`
  builds a static CSR edge list on first use and thereafter only flips
  per-edge enable flags. Anything that changes the *topology* — `net()` or
  any `add*()` device call — must set `this._built = false`, or the circuit
  solves against a stale graph. Adding a new device type means adding its
  edges to `_buildStatic()` as well as handling it in `solve()`.
- **A transition takes two `step()` calls.** The first schedules it
  (`nextEventAt()` goes non-null), a later one at or past the event time
  applies it and counts it. Flipping a switch and stepping once reports
  zero movements — step to `nextEventAt()` in a loop, as `settle()` does.
- **`step()` returns clicks; switchings land on `c.switchings`.** Armature
  movements are the return value, channel switchings a field, because the
  app plays a different timbre for each and the oscillator tests sum the
  return value. Keep the return type a number.
- **Momentary switches** (`push`, `push-nc`) are held only while pressed,
  on canvas and in the I/O table. `push-nc` is closed at rest, so `on`
  means *pressed*, which *opens* it.
- **Feedback is normal.** Latches and oscillators never settle; anything
  that assumes the circuit reaches a fixed point must have a guard. See
  `settle()` in the test suite and the iteration cap in `Circuit.step()`.
- **Sandboxed viewers** (artifact iframes, chat render panels) run on an
  opaque origin where writing `location.hash` throws. All URL access is
  wrapped in try/catch — keep it that way or startup dies after the chrome
  renders but before the canvas draws.
- **Layout follows orientation, not width** (`max-aspect-ratio: 1/1`).
  Circuits are wide and short, so in portrait the I/O table docks along the
  bottom and in landscape it docks right. `fitView()` insets around it so
  the circuit is never covered. Refits are threshold-based (>15%) so a
  mobile URL bar sliding away doesn't discard the user's zoom.
- **Renderer LOD**: below ~2.5 px/world-unit devices collapse to state-
  colored blocks and labels drop out. That's what lets a large circuit
  shrink to pixel scale and still read as on/off.

## Deploying

- **GitHub Pages** — push to `main`; `.github/workflows/pages.yml` runs the
  tests and only deploys if they pass. Pages must already be enabled on the
  repo: `configure-pages` has `enablement: true`, but that cannot bootstrap
  a site from nothing — creating one needs `administration: write`, which
  `GITHUB_TOKEN` is never granted no matter what the `permissions:` block
  says, so the deploy job fails with "Resource not accessible by
  integration". Enable it once per repo, then the workflow is self-
  sufficient:

  ```bash
  gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow
  ```
- **puzzleboss infra (`/lights`)** — the Terraform lives in the
  [puzzleboss2-infra](https://github.com/bigjimmy/puzzleboss2-infra) repo
  (`lights` ECR repo, ECS service, ALB rule priority 13, health at
  `/lights/health`). Build ARM64 on the utility server; commands are in
  README.md. `lights_desired_count` starts at 0 — set it to 1 after the
  first image push.

## Git

- Clear, descriptive commit messages; explain *why* in the body.
- Co-authorship footer: `Co-Authored-By: Claude <noreply@anthropic.com>`
- Never `git reset` or `git rebase` without explicit user confirmation.
