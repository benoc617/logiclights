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
