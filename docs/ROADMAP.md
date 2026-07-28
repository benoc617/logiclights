# Roadmap & TODOs

Working plan for Logic Lights. Checked items are done and verified; the
rest is the queue, roughly in dependency order. Keep this file current —
it is the handoff between sessions.

## Status (2026-07-28)

The library builds the same logic in relays, CMOS and NMOS so the versions
can be compared, and the comparison is now the organising idea rather than
an afterthought. Current counts, the full circuit list and the
concept-by-technology matrix are in [INVENTORY.md](INVENTORY.md) —
generated, so this file does not repeat them.

- **v1** shipped as a relay simulator: binary I/O table, orientation-aware
  layout, click sounds, zoom/pan.
- **v2** generalised the primitive from relays to physical devices. The
  engine is a four-state switch-level solver (`0` / `1` / `Z` / `X`, at
  strong / weak / charge strength) over relays, NMOS, PMOS, diodes and
  resistors, with both rails explicit. Every original relay truth table
  passes unchanged under it — that compatibility is what
  `Circuit.implicitGround` exists for.
- **v3** filled the technology matrix: CMOS and NMOS each gained the full
  gate family, a ring oscillator, a decoder, a latch, an adder and an ALU,
  so most rows can be read across.
- The library is split into catalogue data (`web/data/circuits.json`) and
  per-circuit behaviour (`web/js/behaviour/`) — see [DATA.md](DATA.md).
- **v4** is the 4004 arc: eight machines, and every defined instruction but
  `WPM` acting on hardware. Circuit prose split by where the reader wants
  it — a subtitle in the status bar, then an info panel carrying the idea,
  a line-by-line walkthrough, and the engineering detail — with the
  walkthrough's quoted values verified against the running hardware by the
  suite. The machines annotate themselves with labelled blocks and arrows
  between them, and no two boxes may cross.

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

- [x] **CMOS latch** — transmission-gate D latch in `gates.js`: two
      inverters, two pass gates, complementary enables so exactly one is
      ever open. Static storage — the holding loop drives, so a held bit
      reads STRONG rather than coasting on charge.
- [x] **Master-slave flip-flop** — `DFlipFlop` in `gates.js`: two DLatches
      on opposite clock phases, so new data cannot reach the output in the
      phase it arrived. That is what makes counter feedback safe; built
      from latches the incremented value races back through the adder.
- [x] **ALU** — 4-bit, six functions (add / sub / AND / OR / XOR / shift
      left), one-hot decoded, steered onto a shared result bus by
      transmission gates, composed from gate modules rather than
      hand-placed — the first circuit built that way. Full
      sweep in the test suite: 6 functions × 16 × 16, asserting STRONG on
      every result bit so a second open driver (X) or none (Z) fails.
- [x] **16 × 4 register file** — the 4004's index registers, dual-ported
      (separate read and write addresses), sixteen rows sharing four bit
      lines through tri-state gates. About 3× the ~500 devices the 4004
      budget table guessed, because each cell is a full static latch plus
      its tri-state buffer rather than a 6T SRAM cell — see
      [INVENTORY.md](INVENTORY.md) for the measured count.
- [x] **Data RAM** — decided *not* to build from cells. One real 4002 is
      320 bits, ~7,400 transistors at this cell density and ~2,600 even
      with a 6T SRAM cell, against a 2,300-transistor CPU — and it would
      demonstrate nothing the register file has not already shown. The 4002
      is modelled behaviourally in `ram4002.js` with its real organisation
      (4 registers × 16 main + 4 status characters, four chips to a bank).
      Its *interface* stays real. See CLAUDE.md rule 4 for the boundary.
- [x] **Program ROM** — 8 × 8 NMOS array, a transistor per stored `0`,
      driven by a one-hot row decoder, bit lines pulled up and buffered out.
      Contents spell "LOGIC 42" in ASCII so the array holds something
      legible. Tests cover every decoder width (1/2/3 address bits — the
      1-bit path had its rows swapped when only 3-bit was exercised) and
      assert the sneak-path property directly.
- [x] **Program counter and instruction register** — `counter(bits)` and
      `programCounter(bits)` in `gates.js` (the latter loadable, for
      jumps), plus the instruction register with a hold mux so a fetched
      instruction stays stable across all phases of its execution.
- [x] **Instruction decoder** — `decode.js`: the real encoding, one-hot
      output, tested against all 256 bytes. Includes a disassembler that
      shares the opcode table, so a program listing and the lit decoder
      line cannot disagree.
- [x] **Control sequencing** — `sequencer.js`: a ring counter generating
      phases, a hardwired control unit (phase AND decoded instruction), and
      the JCN condition tree. Three-phase and four-phase variants; the
      four-phase one honours two-byte instructions.
- [ ] **Intel 4004** — in progress, and the bring-up ladder is complete.
      Eight machines exist, each isolating one idea: fetch, phase
      sequencing, the real ADD datapath, conditional jumps, two-byte
      fetch, SUB and LD with the first register-to-accumulator path
      (which also makes XCH a real exchange), and the accumulator group.
      Two early ones — Accumulator Machine and Jump Machine — were
      retired once later machines demonstrated their ideas better; their
      test coverage moved to the Adding Machine. Instruction coverage is
      now complete but for one deliberate deferral: forty-five of the
      real chip's 46 defined instructions act on hardware, including
      FIN's two-instruction-cycle sequencing; WPM is the deferral, and
      [4004.md](4004.md) explains it along with the full plan and
      program corpus.

## Engineering to unblock the big machines

- [x] **Sub-circuit abstraction** — `module.js`: modules declare named
      ports, build in local coordinates, and namespace their device names by
      instance tag. Modules nest (`And2` is a NAND plus an inverter; the
      full adder is five gate instances). `gates.js` is the reusable CMOS
      gate library built on it. The hand-routed library circuits are
      deliberately left alone — they are the teaching material.
- [ ] **Auto-routing** for inter-module wires (channel routing between rows).
      Wires are decorative, so a router only has to be legible, not correct.
- [x] **Performance** — `solve()` now precomputes a flat CSR edge list
      once and only flips per-edge enable flags; floods are
      generation-stamped so nothing is cleared per pass. Every real
      circuit got faster, most by a small multiple; tiny circuits pay a
      little more for the per-device flag loop, which is the right trade.
      Per-tick cost has since grown faster than the machines have, which
      is the open question [TEST-SPEED.md](TEST-SPEED.md) records.
- [x] **Test suite wall time** — `test/run.mjs` shards `sim-test.mjs` at
      its section markers and runs the pieces across cores, with no change
      to what is checked. Because it shards, the wall time is the cost of
      the slowest single block rather than the sum, so more cores stop
      helping once one block dominates. The deal is now balanced on
      *measured* block times, recorded each clean run — block length turned
      out to be a poor proxy for runtime and most shards were sitting idle,
      so learning the real costs roughly halved the wall time. What is left
      and what to try next is in [TEST-SPEED.md](TEST-SPEED.md), which
      deliberately carries no timings: they drifted twice in one session as
      the 4004 machines grew.
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
      Now has to offer a device palette, not just relays. Its file format is
      the "full JSON circuits" TODO in [DATA.md](DATA.md) — the catalogue
      half of that split already landed, so the remaining work is a netlist
      schema and a small expression language, not a format from scratch.
- [ ] **Saved circuits alongside the examples** — localStorage first; a
      shared library would need a small API (the ECS service could host it,
      but that turns a static app into a stateful one — decide deliberately)
- [x] **Clock and step mode** — run / pause / single-step with a period
      slider, shown for circuits that declare a clock. The clock refuses to
      advance while the circuit is still settling, which is a correctness
      requirement rather than politeness: clocking a synchronous machine
      mid-propagation latches half-computed values.
- [ ] Step *by device event* rather than by clock edge — finer than the
      current stepping, for watching a carry propagate within one phase
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
