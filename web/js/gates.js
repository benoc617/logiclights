// Reusable CMOS gate modules.
//
// These are the same topologies as the hand-placed gates in
// behaviour/cmos.js — PMOS pull-up network, NMOS pull-down network,
// complementary — but written
// once as modules with named ports so they can be instantiated in bulk. The
// library circuits stay hand-routed (they are the teaching material, and
// their wire runs are deliberate); these exist for the composed machines,
// where the ALU and the register file need a hundred gates and nobody is
// placing those by eye.
//
// Local frame for every gate: inputs enter on the left, the output leaves
// on the right, VDD is at y=0 and VSS at y=GATE_H. Stacking instances on a
// GATE_W pitch therefore lines their rails up automatically.

import { VDD, VSS } from './engine.js';
import { defineModule } from './module.js';
import { MOS_H } from './geometry.js';

export const GATE_W = 8;    // horizontal pitch between gate instances
export const GATE_H = 20;   // VDD rail to VSS rail

const yP = 2;               // pull-up row
const yN = 11;              // pull-down row

// NOT: one complementary pair.
export const Inverter = defineModule('inv', {
  ports: [
    { name: 'a', x: -1.5, y: yP + MOS_H, side: 'in' },
    { name: 'y', x: 3, y: 8, side: 'out' },
  ],
  build(m) {
    const a = m.port('a'), y = m.port('y');
    m.transistor('P', 'pmos', a, VDD, y, 0, yP);
    m.transistor('N', 'nmos', a, y, VSS, 0, yN);
    m.wire(VDD, [0, 0], [0, yP]);
    m.wire(y, [0, yP + MOS_H], [0, yN]);
    m.wire(VSS, [0, yN + MOS_H], [0, GATE_H]);
    m.wire(y, [0, 8], [3, 8]);
  },
});

// NAND: PMOS in parallel (either input low lifts the output), NMOS in
// series (only both high pulls it down).
export const Nand2 = defineModule('nand2', {
  ports: [
    { name: 'a', x: -1.5, y: yP + MOS_H, side: 'in' },
    { name: 'b', x: -1.5, y: yN + MOS_H, side: 'in' },
    { name: 'y', x: 6, y: 8, side: 'out' },
  ],
  build(m) {
    const a = m.port('a'), b = m.port('b'), y = m.port('y');
    const mid = m.net();
    m.transistor('PA', 'pmos', a, VDD, y, 0, yP);
    m.transistor('PB', 'pmos', b, VDD, y, 4, yP);
    m.wire(VDD, [0, 0], [0, yP]);
    m.wire(VDD, [4, 0], [4, yP]);
    m.wire(y, [0, yP + MOS_H], [0, yN]);
    m.wire(y, [4, yP + MOS_H], [4, 6], [0, 6]);
    m.transistor('NA', 'nmos', a, y, mid, 0, yN);
    m.transistor('NB', 'nmos', b, mid, VSS, 0, yN + 4.6);
    m.wire(mid, [0, yN + MOS_H], [0, yN + 4.6]);
    m.wire(VSS, [0, yN + 4.6 + MOS_H], [0, GATE_H]);
    m.wire(y, [0, 8], [6, 8]);
  },
});

// NOR: the dual — PMOS in series, NMOS in parallel.
export const Nor2 = defineModule('nor2', {
  ports: [
    { name: 'a', x: -1.5, y: yP + MOS_H, side: 'in' },
    { name: 'b', x: -1.5, y: yN + MOS_H, side: 'in' },
    { name: 'y', x: 6, y: 8, side: 'out' },
  ],
  build(m) {
    const a = m.port('a'), b = m.port('b'), y = m.port('y');
    const mid = m.net();
    m.transistor('PA', 'pmos', a, VDD, mid, 0, yP - 2);
    m.transistor('PB', 'pmos', b, mid, y, 0, yP + 2.2);
    m.wire(VDD, [0, 0], [0, yP - 2]);
    m.wire(mid, [0, yP - 2 + MOS_H], [0, yP + 2.2]);
    m.wire(y, [0, yP + 2.2 + MOS_H], [0, yN]);
    m.transistor('NA', 'nmos', a, y, VSS, 0, yN);
    m.transistor('NB', 'nmos', b, y, VSS, 4, yN);
    m.wire(y, [4, yN], [0, yN]);
    m.wire(VSS, [0, yN + MOS_H], [0, GATE_H]);
    m.wire(VSS, [4, yN + MOS_H], [4, GATE_H]);
    m.wire(y, [0, 8], [6, 8]);
  },
});

// AND / OR are a gate plus an inverter — composed, not re-derived, which is
// the point of having modules at all.
export const And2 = defineModule('and2', {
  ports: [
    { name: 'a', x: -1.5, y: yP + MOS_H, side: 'in' },
    { name: 'b', x: -1.5, y: yN + MOS_H, side: 'in' },
    { name: 'y', x: GATE_W + 3, y: 8, side: 'out' },
  ],
  build(m) {
    const n = m.net();
    m.instantiate(Nand2, 0, 0, { a: m.port('a'), b: m.port('b'), y: n });
    m.instantiate(Inverter, GATE_W, 0, { a: n, y: m.port('y') });
    m.wire(n, [6, 8], [GATE_W, 8]);
  },
});

export const Or2 = defineModule('or2', {
  ports: [
    { name: 'a', x: -1.5, y: yP + MOS_H, side: 'in' },
    { name: 'b', x: -1.5, y: yN + MOS_H, side: 'in' },
    { name: 'y', x: GATE_W + 3, y: 8, side: 'out' },
  ],
  build(m) {
    const n = m.net();
    m.instantiate(Nor2, 0, 0, { a: m.port('a'), b: m.port('b'), y: n });
    m.instantiate(Inverter, GATE_W, 0, { a: n, y: m.port('y') });
    m.wire(n, [6, 8], [GATE_W, 8]);
  },
});

// A transmission gate: NMOS and PMOS in parallel so the pair passes a full
// 0 and a full 1. `en` opens it, `nen` must be its complement. When closed
// the output is genuinely floating — this is the one thing a relay cannot
// do, and it is what lets several drivers share a bus.
export const PassGate = defineModule('tg', {
  ports: [
    { name: 'a', x: -1.5, y: 0, side: 'in' },
    { name: 'y', x: 4.5, y: 0, side: 'out' },
    { name: 'en', x: 1.5, y: -2, side: 'top' },
    { name: 'nen', x: 1.5, y: 4, side: 'bottom' },
  ],
  build(m) {
    const a = m.port('a'), y = m.port('y');
    m.transistor('N', 'nmos', m.port('en'), a, y, 0, 0);
    m.transistor('P', 'pmos', m.port('nen'), a, y, 3, 0);
    m.wire(a, [-1.5, 0], [3, 0]);
    m.wire(y, [0, MOS_H], [3, MOS_H]);
    m.wire(y, [1.5, MOS_H], [4.5, MOS_H]);
  },
});

// One bit of ripple-carry addition, built from gates rather than derived:
// sum = a^b^cin, cout = majority(a, b, cin) = ab + cin(a^b).
export const FullAdder = defineModule('fa', {
  ports: [
    { name: 'a', x: -1.5, y: 4, side: 'in' },
    { name: 'b', x: -1.5, y: 8, side: 'in' },
    { name: 'cin', x: -1.5, y: 12, side: 'in' },
    { name: 'sum', x: GATE_W * 7, y: 8, side: 'out' },
    { name: 'cout', x: GATE_W * 7, y: 30, side: 'out' },
  ],
  build(m) {
    const a = m.port('a'), b = m.port('b'), cin = m.port('cin');
    const axb = m.net(), ab = m.net(), cx = m.net();
    m.instantiate(Xor2, 0, 0, { a, b, y: axb });
    m.instantiate(Xor2, GATE_W * 3.5, 0, { a: axb, b: cin, y: m.port('sum') });
    // carry: ab + cin·(a^b) — an OR of two ANDs
    m.instantiate(And2, 0, GATE_H * 2 + 4, { a, b, y: ab });
    m.instantiate(And2, GATE_W * 2.5, GATE_H * 2 + 4, { a: cin, b: axb, y: cx });
    m.instantiate(Or2, GATE_W * 5, GATE_H * 2 + 4, { a: ab, b: cx, y: m.port('cout') });
  },
});

// A transmission-gate D latch, which is the CMOS memory primitive.
//
// Two inverters and two pass gates: when `en` is high the input gate is
// open and the feedback gate shut, so q follows d. When `en` goes low they
// swap, and the two inverters close a loop that holds the value.
//
// The pair is why this is *static* storage rather than charge on a node —
// the loop actively drives, so the bit survives indefinitely. That
// distinction matters for the 4004, whose real registers were dynamic and
// therefore gave the chip a *minimum* clock frequency.
//
// `nen` must be the complement of `en`; the caller supplies it, because a
// register file wants one inverter per row shared by every bit, not one
// per cell.
export const DLatch = defineModule('dlatch', {
  ports: [
    { name: 'd', x: -1.5, y: 8, side: 'in' },
    { name: 'q', x: GATE_W * 4, y: 8, side: 'out' },
    { name: 'en', x: 0, y: -3, side: 'top' },
    { name: 'nen', x: 0, y: -1, side: 'top' },
  ],
  build(m) {
    const en = m.port('en'), nen = m.port('nen'), q = m.port('q');
    const gated = m.net(), nq = m.net();

    // input gate: open while en is high, so q tracks d
    m.instantiate(PassGate, 0, 8, { a: m.port('d'), y: gated, en, nen });
    // the holding pair — gated → nq → q, with q fed back
    m.instantiate(Inverter, GATE_W, 0, { a: gated, y: nq });
    m.instantiate(Inverter, GATE_W * 2, 0, { a: nq, y: q });
    // feedback gate: open while en is *low*, closing the loop that holds.
    // en/nen are swapped here, which is the whole trick — exactly one of
    // the two gates is ever open, so the cell is never both driven and
    // holding (that would be a contention, and would read as X).
    m.instantiate(PassGate, GATE_W * 3, 8, { a: q, y: gated, en: nen, nen: en });
  },
});

// XOR from four NANDs — the classic. y = (a·(a·b)') · (b·(a·b)')  … inverted.
export const Xor2 = defineModule('xor2', {
  ports: [
    { name: 'a', x: -1.5, y: yP + MOS_H, side: 'in' },
    { name: 'b', x: -1.5, y: yN + MOS_H, side: 'in' },
    { name: 'y', x: GATE_W * 3 + 6, y: 8, side: 'out' },
  ],
  build(m) {
    const a = m.port('a'), b = m.port('b');
    const nab = m.net(), t1 = m.net(), t2 = m.net();
    m.instantiate(Nand2, 0, 0, { a, b, y: nab });
    m.instantiate(Nand2, GATE_W, 0, { a, b: nab, y: t1 });
    m.instantiate(Nand2, GATE_W, GATE_H + 2, { a: nab, b, y: t2 });
    m.instantiate(Nand2, GATE_W * 2, 0, { a: t1, b: t2, y: m.port('y') });
  },
});

// A master-slave D flip-flop: two latches on opposite clock phases.
//
// This is what a *counter* needs and a plain latch cannot give. A latch is
// transparent while enabled, so a counter built from latches would feed its
// own incremented output straight back through the adder and race around
// several times per clock pulse. The master-slave pair breaks that: while
// the clock is low the master follows d and the slave holds; when the clock
// rises the master shuts and the slave takes what the master captured. New
// data can never reach the output in the same phase it arrived, so the
// feedback path always sees last cycle's value.
//
// The cost is one clock of latency and twice the devices, which is the
// trade every synchronous machine makes.
//
// `nclk` must be the complement of `clk`; the caller supplies it so a
// register bank can share one inverter across every bit.
export const DFlipFlop = defineModule('dff', {
  ports: [
    { name: 'd', x: -1.5, y: 8, side: 'in' },
    { name: 'q', x: GATE_W * 8, y: 8, side: 'out' },
    { name: 'clk', x: 0, y: -3, side: 'top' },
    { name: 'nclk', x: 0, y: -1, side: 'top' },
  ],
  build(m) {
    const clk = m.port('clk'), nclk = m.port('nclk');
    const mid = m.net();
    // master: transparent while the clock is LOW
    m.instantiate(DLatch, 0, 0, {
      d: m.port('d'), q: mid, en: nclk, nen: clk,
    });
    // slave: transparent while it is HIGH, so the value moves on the edge
    m.instantiate(DLatch, GATE_W * 4.5, 0, {
      d: mid, q: m.port('q'), en: clk, nen: nclk,
    });
  },
});

// One bit of a synchronous counter: the flip-flop plus the half-adder that
// produces the next value. `cin` is the carry from the bit below, `cout`
// goes to the bit above, and a chain of these counts on every clock edge.
//
// next = q XOR cin, and the carry propagates when q was already 1 — the
// same half-adder shape as the arithmetic circuits, wired back on itself.
export const CounterBit = defineModule('cntbit', {
  ports: [
    { name: 'cin', x: -1.5, y: 4, side: 'in' },
    { name: 'nrst', x: -1.5, y: 12, side: 'in' },
    { name: 'q', x: GATE_W * 14, y: 8, side: 'out' },
    { name: 'cout', x: GATE_W * 14, y: 24, side: 'out' },
    { name: 'clk', x: 0, y: -3, side: 'top' },
    { name: 'nclk', x: 0, y: -1, side: 'top' },
  ],
  build(m) {
    const q = m.port('q'), cin = m.port('cin'), nrst = m.port('nrst');
    const toggled = m.net(), next = m.net();
    // the incremented value, computed from the *current* q
    m.instantiate(Xor2, 0, 0, { a: q, b: cin, y: toggled });
    // Reset feeds the flip-flop's input rather than masking its output —
    // masking would leave the real state counting behind a zero. It also
    // has to be here because these cells power up at Z: without a defined
    // value reaching the storage, q XOR cin stays undefined forever and
    // the counter never starts.
    //
    // Note this costs one clock: while reset is held the input is 0, so
    // the first edge after releasing it re-clocks that 0 and the count
    // begins on the *second* edge. That is exactly how a real synchronous
    // reset behaves — it is a value clocked in like any other, not a wire
    // that yanks the flip-flop directly — and a machine bringing itself up
    // has to allow for it.
    m.instantiate(And2, GATE_W * 3, 0, { a: toggled, b: nrst, y: next });
    // carry out: this bit rolls over only if it was 1 and is being toggled
    m.instantiate(And2, 0, GATE_H * 2 + 4, { a: q, b: cin, y: m.port('cout') });
    // the flip-flop is what makes the feedback safe — it is why this needs
    // an edge-triggered cell and not a latch
    m.instantiate(DFlipFlop, GATE_W * 6, 0, {
      d: next, q, clk: m.port('clk'), nclk: m.port('nclk'),
    });
  },
});

// A synchronous binary counter of `bits` stages — the shape of a program
// counter. Every flip-flop sees the same clock edge, so the whole word
// advances at once rather than rippling; the carry chain settles between
// edges instead.
//
// `en` gates counting: it feeds the LSB's carry-in, so with it low the
// counter holds. `rst` forces every bit low, which is what brings a machine
// up in a known state — without it the flip-flops power up undefined and
// the count would start from nowhere.
//
// The reset is *synchronous*: it is clocked in like any other value, so
// releasing it costs one edge before counting begins. Real synchronous
// resets behave the same way, and a caller sequencing a bring-up needs to
// know it.
export function counter(bits) {
  return defineModule(`cnt${bits}`, {
    ports: [
      { name: 'clk', x: 0, y: -3, side: 'top' },
      { name: 'nclk', x: 0, y: -1, side: 'top' },
      { name: 'en', x: -1.5, y: 4, side: 'in' },
      { name: 'rst', x: -1.5, y: 8, side: 'in' },
      ...Array.from({ length: bits }, (_, i) => ({
        name: `q${i}`, x: 400, y: i * 4, side: 'out',
      })),
      { name: 'cout', x: 400, y: bits * 4, side: 'out' },
    ],
    build(m) {
      const clk = m.port('clk'), nclk = m.port('nclk');
      const nrst = m.net();
      m.instantiate(Inverter, 0, 0, { a: m.port('rst'), y: nrst });

      let carry = m.port('en');
      for (let i = 0; i < bits; i++) {
        const x = GATE_W * 4 + i * (GATE_W * 15);
        const cout = i === bits - 1 ? m.port('cout') : m.net();
        m.instantiate(CounterBit, x, 0, {
          cin: carry, nrst, q: m.port(`q${i}`), cout, clk, nclk,
        }, { tag: `b${i}` });
        carry = cout;
      }
    },
  });
}

// A register with a load enable: `bits` flip-flops that take `d` when
// `load` is high on the clock edge, and hold otherwise.
//
// The hold is the whole point. A bare flip-flop takes its input on every
// edge, so a register wired straight to a bus would follow whatever the bus
// happened to carry — the value would survive exactly one cycle. Gating it
// is what makes storage that persists until something decides to change it,
// which is the difference between a wire and a register.
//
// Each bit is a two-input mux feeding the flip-flop: take `d` when load is
// high, take your own output when it is low. That shape recurs everywhere
// state meets control, which is why it is worth having once.
export function register(bits) {
  return defineModule(`reg${bits}`, {
    ports: [
      { name: 'clk', x: 0, y: -3, side: 'top' },
      { name: 'nclk', x: 0, y: -1, side: 'top' },
      { name: 'load', x: -1.5, y: 2, side: 'in' },
      ...Array.from({ length: bits }, (_, i) => ({
        name: `d${i}`, x: -1.5, y: 8 + i * 4, side: 'in',
      })),
      ...Array.from({ length: bits }, (_, i) => ({
        name: `q${i}`, x: GATE_W * 16, y: i * 4, side: 'out',
      })),
    ],
    build(m) {
      const clk = m.port('clk'), nclk = m.port('nclk');
      const load = m.port('load');
      const nload = m.net();
      m.instantiate(Inverter, 0, 0, { a: load, y: nload });

      for (let i = 0; i < bits; i++) {
        const y = i * (GATE_H + 4);
        const take = m.net(), keep = m.net(), d = m.net();
        m.instantiate(And2, GATE_W * 3, y,
          { a: m.port(`d${i}`), b: load, y: take });
        m.instantiate(And2, GATE_W * 3, y + GATE_H + 2,
          { a: m.port(`q${i}`), b: nload, y: keep });
        m.instantiate(Or2, GATE_W * 6, y, { a: take, b: keep, y: d });
        m.instantiate(DFlipFlop, GATE_W * 10, y,
          { d, q: m.port(`q${i}`), clk, nclk }, { tag: `b${i}` });
      }
    },
  });
}
