// NMOS gate modules — the same library as gates.js, one technology back.
//
// An NMOS gate is the pull-down network alone: a resistor load holds the
// output high, and whatever pattern of N-channels sits below decides when
// it gets pulled down. Series is NAND, parallel is NOR — the identical
// shapes CMOS uses for its pull-down half — but with no complementary
// pull-up above them.
//
// Two consequences run through everything built here:
//
//   Half the transistors. A CMOS NAND is four devices; this one is two and
//   a resistor. That density is why NMOS held on as long as it did, and why
//   the 4004 was built this way.
//
//   A 1 is only ever weak. The load resistor can never drive as hard as a
//   transistor pulling to ground, so every high output is WEAK while every
//   low output is STRONG. Whenever the output is low there is an unbroken
//   path from the rail to ground, burning current for as long as it stays
//   there. A CMOS gate only draws current while it switches; an NMOS gate
//   draws it continuously, and that is what eventually killed the
//   technology.
//
// The asymmetry has a design consequence worth watching for: chaining
// pass-transistor logic degrades a 1 further at every stage, so these gates
// always restore the level through a fresh load rather than passing a
// weak high along.

import { VDD, VSS } from './engine.js';
import { defineModule } from './module.js';
import { MOS_H } from './geometry.js';

export const NGATE_W = 8;    // horizontal pitch between gate instances
export const NGATE_H = 20;   // VDD rail to VSS rail

const yLoad = 2;             // load resistor row
const yPull = 8;             // pull-down network row

// NOT: one transistor and a load.
export const NInverter = defineModule('ninv', {
  ports: [
    { name: 'a', x: -1.5, y: yPull + MOS_H / 2, side: 'in' },
    { name: 'y', x: 3, y: 6, side: 'out' },
  ],
  build(m) {
    const a = m.port('a'), y = m.port('y');
    m.resistor('RL', VDD, y, 0, yLoad, { vert: true });
    m.transistor('N', 'nmos', a, y, VSS, 0, yPull);
    m.wire(VDD, [0, 0], [0, yLoad]);
    m.wire(y, [0, yLoad + 1.2], [0, yPull]);
    m.wire(VSS, [0, yPull + MOS_H], [0, NGATE_H]);
    m.wire(y, [0, 6], [3, 6]);
  },
});

// NAND: series pull-down — both inputs must be high to reach ground.
export const NNand2 = defineModule('nnand2', {
  ports: [
    { name: 'a', x: -1.5, y: yPull + MOS_H / 2, side: 'in' },
    { name: 'b', x: -1.5, y: yPull + 4.6 + MOS_H / 2, side: 'in' },
    { name: 'y', x: 3, y: 6, side: 'out' },
  ],
  build(m) {
    const a = m.port('a'), b = m.port('b'), y = m.port('y');
    const mid = m.net();
    m.resistor('RL', VDD, y, 0, yLoad, { vert: true });
    m.transistor('NA', 'nmos', a, y, mid, 0, yPull);
    m.transistor('NB', 'nmos', b, mid, VSS, 0, yPull + 4.6);
    m.wire(VDD, [0, 0], [0, yLoad]);
    m.wire(y, [0, yLoad + 1.2], [0, yPull]);
    m.wire(mid, [0, yPull + MOS_H], [0, yPull + 4.6]);
    m.wire(VSS, [0, yPull + 4.6 + MOS_H], [0, NGATE_H]);
    m.wire(y, [0, 6], [3, 6]);
  },
});

// NOR: parallel pull-down — either input high reaches ground. In NMOS this
// is the *cheap* gate: parallel transistors do not stack their channel
// resistance the way a series chain does, so an NMOS NOR switches faster
// than an NMOS NAND. CMOS designers prefer NAND for the mirror-image
// reason, which is why NMOS-era logic looks NOR-heavy and CMOS-era logic
// looks NAND-heavy.
export const NNor2 = defineModule('nnor2', {
  ports: [
    { name: 'a', x: -1.5, y: yPull + MOS_H / 2, side: 'in' },
    { name: 'b', x: 4.5, y: yPull + MOS_H / 2, side: 'in' },
    { name: 'y', x: 9, y: 6, side: 'out' },
  ],
  build(m) {
    const a = m.port('a'), b = m.port('b'), y = m.port('y');
    m.resistor('RL', VDD, y, 0, yLoad, { vert: true });
    m.transistor('NA', 'nmos', a, y, VSS, 0, yPull);
    m.transistor('NB', 'nmos', b, y, VSS, 6, yPull);
    m.wire(VDD, [0, 0], [0, yLoad]);
    m.wire(y, [0, yLoad + 1.2], [0, yPull]);
    m.wire(y, [0, 6], [6, 6], [6, yPull]);
    m.wire(VSS, [0, yPull + MOS_H], [0, NGATE_H]);
    m.wire(VSS, [6, yPull + MOS_H], [6, NGATE_H]);
    m.wire(y, [0, 6], [9, 6]);
  },
});

// AND and OR are the inverting gates plus a restoring inverter — the same
// tax CMOS pays, but doubled here, because the extra stage brings its own
// load resistor and therefore its own static current.
export const NAnd2 = defineModule('nand2n', {
  ports: [
    { name: 'a', x: -1.5, y: yPull + MOS_H / 2, side: 'in' },
    { name: 'b', x: -1.5, y: yPull + 4.6 + MOS_H / 2, side: 'in' },
    { name: 'y', x: NGATE_W + 3, y: 6, side: 'out' },
  ],
  build(m) {
    const n = m.net();
    m.instantiate(NNand2, 0, 0, { a: m.port('a'), b: m.port('b'), y: n });
    m.instantiate(NInverter, NGATE_W, 0, { a: n, y: m.port('y') });
    m.wire(n, [3, 6], [NGATE_W, 6]);
  },
});

export const NOr2 = defineModule('nor2n', {
  ports: [
    { name: 'a', x: -1.5, y: yPull + MOS_H / 2, side: 'in' },
    { name: 'b', x: 4.5, y: yPull + MOS_H / 2, side: 'in' },
    { name: 'y', x: NGATE_W * 2 + 3, y: 6, side: 'out' },
  ],
  build(m) {
    const n = m.net();
    m.instantiate(NNor2, 0, 0, { a: m.port('a'), b: m.port('b'), y: n });
    m.instantiate(NInverter, NGATE_W * 2, 0, { a: n, y: m.port('y') });
    m.wire(n, [9, 6], [NGATE_W * 2, 6]);
  },
});

// XOR from four NANDs, the same construction as the CMOS one — which makes
// the device-count comparison exact: 8 transistors + 4 resistors here
// against CMOS's 16 transistors, against a relay XOR's two changeover
// contacts. XOR is the function that punishes transistor logic and rewards
// relays, and this is where you can see all three side by side.
export const NXor2 = defineModule('nxor2', {
  ports: [
    { name: 'a', x: -1.5, y: yPull + MOS_H / 2, side: 'in' },
    { name: 'b', x: -1.5, y: yPull + 4.6 + MOS_H / 2, side: 'in' },
    { name: 'y', x: NGATE_W * 3 + 3, y: 6, side: 'out' },
  ],
  build(m) {
    const a = m.port('a'), b = m.port('b');
    const nab = m.net(), t1 = m.net(), t2 = m.net();
    m.instantiate(NNand2, 0, 0, { a, b, y: nab });
    m.instantiate(NNand2, NGATE_W, 0, { a, b: nab, y: t1 });
    m.instantiate(NNand2, NGATE_W, NGATE_H + 2, { a: nab, b, y: t2 });
    m.instantiate(NNand2, NGATE_W * 2, 0, { a: t1, b: t2, y: m.port('y') });
  },
});

// A full adder, gate for gate the same topology as the CMOS one in
// gates.js. Building it from the NMOS library rather than re-deriving it is
// the point: the logic is identical, only the devices underneath differ.
export const NFullAdder = defineModule('nfa', {
  ports: [
    { name: 'a', x: -1.5, y: 4, side: 'in' },
    { name: 'b', x: -1.5, y: 8, side: 'in' },
    { name: 'cin', x: -1.5, y: 12, side: 'in' },
    { name: 'sum', x: NGATE_W * 7, y: 8, side: 'out' },
    { name: 'cout', x: NGATE_W * 7, y: 30, side: 'out' },
  ],
  build(m) {
    const a = m.port('a'), b = m.port('b'), cin = m.port('cin');
    const axb = m.net(), ab = m.net(), cx = m.net();
    m.instantiate(NXor2, 0, 0, { a, b, y: axb });
    m.instantiate(NXor2, NGATE_W * 3.5, 0, { a: axb, b: cin, y: m.port('sum') });
    // carry: ab + cin·(a^b)
    m.instantiate(NAnd2, 0, NGATE_H * 2 + 4, { a, b, y: ab });
    m.instantiate(NAnd2, NGATE_W * 2.5, NGATE_H * 2 + 4, { a: cin, b: axb, y: cx });
    m.instantiate(NOr2, NGATE_W * 5, NGATE_H * 2 + 4, { a: ab, b: cx, y: m.port('cout') });
  },
});

// A D latch. No transmission gates here — those need a complementary pair,
// which is exactly what NMOS does not have. Instead this is the classic
// cross-coupled NOR latch with steering: the shape used before pass gates
// were available, and the same one the relay SR latch uses.
export const NDLatch = defineModule('ndlatch', {
  ports: [
    { name: 'd', x: -1.5, y: 6, side: 'in' },
    { name: 'en', x: -1.5, y: 14, side: 'in' },
    { name: 'q', x: NGATE_W * 4, y: 6, side: 'out' },
  ],
  build(m) {
    const d = m.port('d'), en = m.port('en'), q = m.port('q');
    const nd = m.net(), s = m.net(), r = m.net(), nq = m.net();
    m.instantiate(NInverter, 0, 0, { a: d, y: nd });
    // gate D and its complement with EN: S sets, R resets, and with EN low
    // both are low so the cross-coupled pair simply holds.
    m.instantiate(NAnd2, NGATE_W, 0, { a: d, b: en, y: s });
    m.instantiate(NAnd2, NGATE_W, NGATE_H + 2, { a: nd, b: en, y: r });
    // cross-coupled NORs: each output feeds the other's input
    m.instantiate(NNor2, NGATE_W * 3, 0, { a: r, b: nq, y: q });
    m.instantiate(NNor2, NGATE_W * 3, NGATE_H + 2, { a: s, b: q, y: nq });
  },
});
