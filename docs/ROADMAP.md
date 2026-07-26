# Roadmap & TODOs

Working plan for Logic Lights. Checked items are done and verified; the
rest is the queue, roughly in dependency order. Keep this file current —
it is the handoff between sessions.

## Status (2026-07-26)

v1 shipped as a relay simulator: 18 circuits, binary I/O table,
orientation-aware layout, click sounds, zoom/pan.

v2 generalises the primitive from relays to physical devices. The engine is
now a four-state switch-level solver (`0` / `1` / `Z` / `X`, at strong /
weak / charge strength) over relays, NMOS, PMOS, diodes and resistors, with
both rails explicit. Nine device circuits added, including a tri-state bus
that demonstrates floating and contended nets directly. Every original relay
truth table passes unchanged under the new solver — that compatibility is
what `Circuit.implicitGround` exists for.

`node test/sim-test.mjs` → **132,429 checks, 0 failures**.

## Ship it

- [x] App, tests, Dockerfile, nginx config, Pages workflow
- [x] Live demo published as a Claude artifact
- [x] Push to `benoc617/logiclights` main
- [x] Device model: four-state solver, transistors, diodes, resistors
- [x] Pages enabled on the repo (`build_type=workflow`). The first two
      deploy runs failed at `configure-pages`: `enablement: true` cannot
      create a site from nothing, so it needed one manual API call. See
      CLAUDE.md § Deploying → live at
      `https://benoc617.github.io/logiclights/`
- [ ] **Production `/lights`** on the puzzleboss stack: merge the infra
      branch in puzzleboss2-infra, `terraform apply`, build+push the ARM64
      image on the utility server, then set `lights_desired_count = 1`
      (starts at 0 so the service doesn't crash-loop on a missing image)
- [ ] Optional: a build workflow for the ECS image on the self-hosted ARM
      runner — needs a runner registered to this repo

## More circuits

- [ ] **CMOS latch and flip-flop** — a transmission-gate latch is two
      inverters and two pass gates; the master-slave pair is the memory
      primitive the CPU needs. The relay side already has SR/D/register.
- [x] **ALU** — 4-bit, six functions (add / sub / AND / OR / XOR / shift
      left), one-hot decoded, steered onto a shared result bus by
      transmission gates. 538 transistors, composed from gate modules
      rather than hand-placed — the first circuit built that way. Full
      sweep in the test suite: 6 functions × 16 × 16, asserting STRONG on
      every result bit so a second open driver (X) or none (Z) fails.
- [ ] **Memory unit** — address decoder feeding a register file (start 4×4,
      then 8×8), with read/write enable. 6T SRAM cells rather than latch
      pairs once the CMOS latch exists.
- [ ] **Program ROM** — an NMOS array, a transistor per stored `0`, driven
      by a row decoder. A good demo on its own before any CPU exists, and
      the thing that makes programs possible. See [4004.md](4004.md).
- [ ] Program counter (ripple counter) and instruction register
- [ ] **Intel 4004** — the long arc, retargeted from the 8008 (4-bit
      datapath, Harvard, no interrupts, 3-level stack, and the existing
      4-bit circuits are already the right width). Needs the hierarchical
      layout work below first. Full plan and program corpus in
      [4004.md](4004.md).

## Engineering to unblock the big machines

- [x] **Sub-circuit abstraction** — `module.js`: modules declare named
      ports, build in local coordinates, and namespace their device names by
      instance tag. Modules nest (`And2` is a NAND plus an inverter; the
      full adder is five gate instances). `gates.js` is the reusable CMOS
      gate library built on it. The hand-routed library circuits are
      deliberately left alone — they are the teaching material.
- [ ] **Auto-routing** for inter-module wires (channel routing between rows).
      Wires are decorative, so a router only has to be legible, not correct.
- [x] **Performance** — `solve()` now precomputes a flat CSR edge list once
      and only flips per-edge enable flags; floods are generation-stamped so
      nothing is cleared per pass. Real circuits 1.6–3.6× faster (`add8`
      3.16 → 0.89 µs); at 4004 scale ~65 → ~32 µs, and a realistic fan-out
      topology solves 4,610 nets in 36 µs. Tiny circuits pay ~1 µs more for
      the per-device flag loop, which is the right trade.
- [ ] **Renderer caching** — build a `Path2D` per net once and reuse it;
      currently every wire is re-pathed each frame, now once per logic value.
- [ ] **Block-diagram LOD tier** above the current one: a whole module
      collapses to a labelled box showing its live bus value, click to zoom
      in. The existing px-per-world-unit ladder extends naturally.
- [ ] **Time control** — turbo mode that runs event-to-event decoupled from
      rAF, since an instruction is seconds of wall clock even at minimum
      delay.

## Features

- [ ] **Assembler panel** — type 4004 assembly, assemble in JS, and set the
      ROM array's switch objects directly. A loader driving real switches,
      not a shortcut. Plus the disassembly direction, so hand-flipped bits
      read back as source.
- [ ] **Circuit editor** — place devices, drag wires, name signals; save to
      localStorage, export/import JSON. The headline feature after the ALU.
      Now has to offer a device palette, not just relays.
- [ ] **Saved circuits alongside the examples** — localStorage first; a
      shared library would need a small API (the ECS service could host it,
      but that turns a static app into a stateful one — decide deliberately)
- [ ] Step mode: advance one device event at a time, pause/resume
- [ ] Timing/waveform view of selected nets over time
- [ ] Critical-path highlight and a device-delay count per circuit
- [ ] Deep-link full state in the URL (circuit + input values), not just
      the circuit id
- [ ] Accessibility: keyboard-operable switches and bit cells, ARIA state,
      honor `prefers-reduced-motion`
- [ ] **iOS app** — wrap the web app in WKWebView first; only port natively
      if the canvas renderer proves too slow on the big circuits

## Model fidelity (deliberate gaps)

Each of these is listed in [DEVICES.md](DEVICES.md) as a known
approximation, not an oversight. Roughly in order of how much they'd add:

- [ ] **Threshold drops** — an NMOS passes a degraded `1`, a PMOS a degraded
      `0`. Modelling this as strength decay would make *Transmission Gate*
      demonstrate the level loss that motivates it, and would let a
      pass-transistor chain visibly fail the way the real thing does.
- [ ] **Charge decay** — stored charge is currently held forever. Needed for
      an authentic PMOS-era 4004, whose dynamic registers are why the real
      chip has a *minimum* clock frequency.
- [x] Distinct timbres per device family — relays click (noise burst),
      transistors get a swept-sawtooth "zzzt". A real MOSFET is silent, so
      this is deliberate sonification, not physics.
- [ ] Distinct pull-in vs drop-out sound timbres; per-device stereo position

## Polish backlog

- [ ] Some wire runs in `reg4` and `addsub4` are visually dense — worth a
      routing pass once auto-routing exists
- [ ] The new device circuits cross wires more than the relay ones do
      (crossings are fine and normal, but a few are tighter than they need
      to be)
- [ ] A short guided tour for first-time visitors: the relay intro, then
      *Three Technologies*, then the adder

## Known gotchas

Documented in CLAUDE.md — sneak paths in undirected conduction, a lit lamp
not meaning a driven net, the guaranteed glitch in every CMOS transition,
momentary switch semantics, circuits that never settle, sandboxed-iframe URL
writes, and orientation-based layout. Read those before debugging something
weird.
