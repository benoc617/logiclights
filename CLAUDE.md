# CLAUDE.md

Guidance for Claude Code working in the Logic Lights repo.

## What this is

An interactive web app that shows logic circuits **implemented in relays** —
lights on every wire, visible propagation delay, optional click sounds. It
runs from a single gate up to an 8-bit ripple adder today; the long arc is
an entire Intel 8008 plus a build-your-own-circuit editor (see
[docs/ROADMAP.md](docs/ROADMAP.md)).

Design and rationale live in [docs/DESIGN.md](docs/DESIGN.md) — read it
before changing the simulation core or adding a large circuit.

## Hard rules

1. **No dependencies, no build step.** Vanilla ES modules + canvas, served
   as static files. Anything that needs npm install, bundling, or a
   framework is out. This is what lets the app ship as a GitHub Pages site,
   an nginx container, and a single inlined HTML file simultaneously.
2. **`node test/sim-test.mjs` must pass before every commit.** It is the
   only guard on circuit correctness — the relay topologies are hand-wired
   and a one-character slip produces a plausible-looking circuit that adds
   wrong. Add cases for whatever you change.
3. **Circuits are simulated, never faked.** No shortcut that computes a
   gate's output arithmetically. Everything is nets, contacts and coils; if
   it lights up, current actually reached it.

## Layout

```
web/
  index.html          UI shell
  css/style.css       all styling (orientation-aware, see below)
  js/engine.js        Circuit: nets, relays, switches, lamps, timing
  js/geometry.js      symbol geometry shared by builders and renderer
  js/circuits.js      the circuit library + registry (CIRCUITS)
  js/buses.js         groups switches/lamps into binary buses
  js/render.js        canvas renderer (pan/zoom, glow, LOD)
  js/sound.js         WebAudio relay clicks
  js/main.js          UI wiring, rAF loop, pointer input, binary I/O panel
test/sim-test.mjs     headless truth-table suite (no runner, plain node)
Dockerfile            nginx image serving /lights/ for the puzzleboss stack
nginx.conf            with /lights/health for the ALB health check
.github/workflows/    tests + GitHub Pages deploy on push to main
```

## Adding a circuit

1. Write a `buildX()` in `circuits.js` returning a `Circuit`. Use `c.net()`
   for signals, `relay()`, `c.addSwitch()`, `c.addLamp()`, `w()` for wires.
   Coordinates are world units, hand-placed; `railFeed()` drops a lead from
   the + rail.
2. Register it in `CIRCUITS` with `id`, `group`, `name`, `build`, `desc`.
   Optionally `readout: v => ...` for an equation line in the I/O table.
3. Add truth-table cases to `test/sim-test.mjs`. For anything with more
   than a couple of inputs, sweep the full input space — the 8-bit adder
   sweeps all 131,072 combinations and it still runs in seconds.
4. Check it visually at several zoom levels; wires are hand-routed and
   overlaps are easy to miss.

**Naming drives the binary I/O table.** A trailing number makes a bus bit:
switches `A0..A7` become bus **A** with bit 0 as LSB. Names without a
number (`Cin`, `SUB`, `LOAD`) are one-bit buses. Switch/lamp creation order
sets row order in the table — create operands before mode switches. For a
lamp whose on-canvas caption is wordy, pass `{ short: 'Y0' }`. Expose an
interesting internal signal group with `c.addBus('CARRY', nets)`.

## Things that will bite you

- **Conduction is undirected**, exactly like a real relay rack. A contact
  tree that looks fine can leak current backwards through another branch (a
  "sneak path") and light things that should be dark. The test suite is the
  only thing that catches this — never add a circuit without one.
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
- **Renderer LOD**: below ~2.5 px/world-unit relays collapse to state-
  colored blocks and labels drop out. That's what lets a large circuit
  shrink to pixel scale and still read as on/off.

## Deploying

- **GitHub Pages** — push to `main`; `.github/workflows/pages.yml` runs the
  tests and only deploys if they pass. It self-enables Pages.
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
