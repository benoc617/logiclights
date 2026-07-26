# Roadmap & TODOs

Working plan for Logic Lights. Checked items are done and verified; the
rest is the queue, roughly in dependency order. Keep this file current —
it is the handoff between sessions.

## Status (2026-07-26)

v1 is built and tested: 18 circuits, relay-accurate simulation, binary I/O
table, orientation-aware layout, click sounds, zoom/pan.
`node test/sim-test.mjs` → **132,305 checks, 0 failures**.

## Ship it

- [x] App, tests, Dockerfile, nginx config, Pages workflow
- [x] Live demo published as a Claude artifact
- [ ] **Push to `benoc617/logiclights` main** and confirm the Pages
      workflow goes green (it runs the tests first, then self-enables
      Pages) → live at `https://benoc617.github.io/logiclights/`
- [ ] **Production `/lights`** on the puzzleboss stack: merge the infra
      branch in puzzleboss2-infra, `terraform apply`, build+push the ARM64
      image on the utility server, then set `lights_desired_count = 1`
      (starts at 0 so the service doesn't crash-loop on a missing image)
- [ ] Optional: a build workflow for the ECS image on the self-hosted ARM
      runner — needs a runner registered to this repo

## More circuits

- [ ] **ALU** — function select (add / sub / AND / OR / XOR / shift) over
      the existing adder core, driven by a mode relay bank like the
      subtractor's. Natural next step; mostly a bigger selector tree.
- [ ] **Memory unit** — address decoder feeding a register file (start 4×4,
      then 8×8), with read/write enable. The 2-to-4 decoder and 4-bit
      register are the building blocks and already work.
- [ ] Program counter (ripple counter) and instruction register
- [ ] Bus multiplexers / tri-state-ish steering between units
- [ ] **Intel 8008** — the long arc. Needs the hierarchical layout work
      below first; hand-placing thousands of wire segments will not scale.
      Stage it: register file → ALU → control sequencing → full CPU.

## Engineering to unblock the big machines

- [ ] **Sub-circuit abstraction** — reusable modules with named ports,
      instantiated at a position, so an ALU is composed rather than hand-
      routed. `faCell()` is the informal prototype; formalize it.
- [ ] **Auto-routing** for inter-module wires (channel routing between rows)
- [ ] **Performance** — the conduction flood-fill is O(V+E) per iteration
      per step. Fine at 24 relays, needs incremental propagation (dirty-net
      queue) at thousands.
- [ ] **Renderer caching** — build a `Path2D` per net once and reuse it;
      currently every wire is re-pathed each frame.

## Features

- [ ] **Circuit editor** — place relays, drag wires, name signals; save to
      localStorage, export/import JSON. The headline feature after the ALU.
- [ ] **Saved circuits alongside the examples** — localStorage first; a
      shared library would need a small API (the ECS service could host it,
      but that turns a static app into a stateful one — decide deliberately)
- [ ] Step mode: advance one relay event at a time, pause/resume
- [ ] Timing/waveform view of selected nets over time
- [ ] Critical-path highlight and a relay-delay count per circuit
- [ ] Deep-link full state in the URL (circuit + input values), not just
      the circuit id
- [ ] Accessibility: keyboard-operable switches and bit cells, ARIA state,
      honor `prefers-reduced-motion`
- [ ] **iOS app** — wrap the web app in WKWebView first; only port natively
      if the canvas renderer proves too slow on the big circuits

## Polish backlog

- [ ] Some wire runs in `reg4` and `addsub4` are visually dense — worth a
      routing pass once auto-routing exists
- [ ] Sound: distinct pull-in vs drop-out timbres; per-relay stereo
      position across a wide circuit
- [ ] A short guided tour for first-time visitors (what to click on the
      relay intro, then the adder)

## Known gotchas

Documented in CLAUDE.md — sneak paths in undirected conduction, momentary
switch semantics, circuits that never settle, sandboxed-iframe URL writes,
and orientation-based layout. Read those before debugging something weird.
