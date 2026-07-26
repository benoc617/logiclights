// A 4-bit ALU, composed from gate modules.
//
// Six functions over two 4-bit operands, selected by a 3-bit F code:
//
//   F   op        how
//   000 ADD       full-adder chain, Cin = 0
//   001 SUB       same chain, B inverted and Cin = 1 (two's complement)
//   010 AND       bitwise
//   011 OR        bitwise
//   100 XOR       bitwise
//   101 SHL       A shifted left one bit (bit i takes A[i-1], LSB takes 0)
//
// The result bus is the point of building this after the tri-state work
// rather than before. Each function drives the shared per-bit output net
// through its own transmission gate, and the decoder guarantees exactly one
// is open — so the bus is genuinely one wire with six possible drivers, the
// way the 4004's internal bus is, instead of a mux tree per destination
// (which is all a relay machine could do). When no function is selected the
// bus floats, which the four-state solver shows as Z rather than inventing
// a value.

import { VDD, VSS } from './engine.js';
import { defineModule, instantiate } from './module.js';
import {
  Inverter, Nand2, And2, Or2, Xor2, PassGate, FullAdder, GATE_W, GATE_H,
} from './gates.js';

export const ALU_BITS = 4;

// 3-to-8 one-hot decode. Only six lines are used, but decoding all eight
// keeps the tree regular and leaves room for two more functions.
const Decode3 = defineModule('dec3', {
  ports: [
    { name: 'f0', x: -1.5, y: 0, side: 'in' },
    { name: 'f1', x: -1.5, y: 4, side: 'in' },
    { name: 'f2', x: -1.5, y: 8, side: 'in' },
    ...Array.from({ length: 8 }, (_, i) => ({
      name: `y${i}`, x: GATE_W * 6, y: i * 6, side: 'out',
    })),
  ],
  build(m) {
    const f = [m.port('f0'), m.port('f1'), m.port('f2')];
    const nf = [m.net(), m.net(), m.net()];
    for (let i = 0; i < 3; i++) {
      m.instantiate(Inverter, 0, i * (GATE_H + 2), { a: f[i], y: nf[i] });
    }
    // y_i = (f0 sel) · (f1 sel) · (f2 sel), one AND3 per line as two AND2s
    for (let i = 0; i < 8; i++) {
      const l0 = (i & 1) ? f[0] : nf[0];
      const l1 = (i & 2) ? f[1] : nf[1];
      const l2 = (i & 4) ? f[2] : nf[2];
      const t = m.net();
      const yb = i * (GATE_H + 2);
      m.instantiate(And2, GATE_W * 2, yb, { a: l0, b: l1, y: t });
      m.instantiate(And2, GATE_W * 4, yb, { a: l2, b: t, y: m.port(`y${i}`) });
    }
  },
});

// One bit slice: every function computed in parallel, then steered onto the
// shared result net by the one-hot select lines.
const AluBit = defineModule('alubit', {
  ports: [
    { name: 'a', x: -1.5, y: 0, side: 'in' },
    { name: 'b', x: -1.5, y: 4, side: 'in' },
    { name: 'bx', x: -1.5, y: 8, side: 'in' },   // B or ~B, from the adder path
    { name: 'ashl', x: -1.5, y: 12, side: 'in' },// A[i-1], for the shift
    { name: 'cin', x: -1.5, y: 16, side: 'in' },
    { name: 'sum', x: GATE_W * 8, y: 0, side: 'out' },
    { name: 'cout', x: GATE_W * 8, y: 30, side: 'out' },
    { name: 'y', x: GATE_W * 12, y: 0, side: 'out' },   // shared result bus
    // one-hot selects and their complements (a pass gate needs both)
    ...['add', 'sub', 'and', 'or', 'xor', 'shl'].flatMap(s => [
      { name: `s_${s}`, x: 0, y: -4, side: 'top' },
      { name: `n_${s}`, x: 0, y: -2, side: 'top' },
    ]),
  ],
  build(m) {
    const a = m.port('a'), b = m.port('b');
    const y = m.port('y');

    // adder core — shared by ADD and SUB, which differ only in bx and cin
    const fa = m.instantiate(FullAdder, 0, 0, {
      a, b: m.port('bx'), cin: m.port('cin'),
      sum: m.port('sum'), cout: m.port('cout'),
    });

    // logic functions, all computed regardless of selection. Rows are
    // pitched to the blocks' measured heights (a gate is GATE_H tall, Xor2
    // is two rows) so the slice packs instead of scattering.
    const andY = m.net(), orY = m.net(), xorY = m.net();
    const yLogic = GATE_H * 3.5;   // below the full adder
    m.instantiate(And2, 0, yLogic, { a, b, y: andY });
    m.instantiate(Or2, 0, yLogic + GATE_H + 2, { a, b, y: orY });
    const lastLogic = m.instantiate(Xor2, 0, yLogic + (GATE_H + 2) * 2,
      { a, b, y: xorY });

    // Name the two halves of the slice: the adder up top (shared by ADD and
    // SUB) and the bitwise gates below, all computing at once whether or
    // not they are selected.
    m.region('Adder', -4, -3, GATE_W * 7, fa.h + 2, { side: 'inside' });
    m.region('AND · OR · XOR', -4, yLogic - 3, GATE_W * 7,
      yLogic + (GATE_H + 2) * 2 + lastLogic.h + 2, { side: 'inside' });

    // steer one of them onto the bus. ADD and SUB share the adder's sum.
    const srcs = [
      ['add', fa.nets.sum], ['sub', fa.nets.sum],
      ['and', andY], ['or', orY], ['xor', xorY],
      ['shl', m.port('ashl')],
    ];
    // the six pass gates stack in a column: this is the result bus, and
    // seeing all six drivers on one net is the point of the circuit
    srcs.forEach(([name, src], i) => {
      m.instantiate(PassGate, GATE_W * 7.5, i * 5, {
        a: src, y,
        en: m.port(`s_${name}`), nen: m.port(`n_${name}`),
      });
    });
    // The six gates onto one net are the whole idea of the circuit, so the
    // box names it rather than leaving it as six anonymous pass gates.
    // Kept short: this repeats once per bit slice, and the full explanation
    // belongs in the circuit description rather than four times on canvas.
    m.region('6→1 bus', GATE_W * 7.5 - 3, -3,
      GATE_W * 7.5 + 12, srcs.length * 5 + 2, { side: 'inside' });
  },
});

// The full 4-bit ALU.
export const Alu4 = defineModule('alu4', {
  ports: [
    ...Array.from({ length: ALU_BITS }, (_, i) => ({ name: `a${i}`, x: -1.5, y: i * 4, side: 'in' })),
    ...Array.from({ length: ALU_BITS }, (_, i) => ({ name: `b${i}`, x: -1.5, y: 20 + i * 4, side: 'in' })),
    { name: 'f0', x: -1.5, y: 40, side: 'in' },
    { name: 'f1', x: -1.5, y: 44, side: 'in' },
    { name: 'f2', x: -1.5, y: 48, side: 'in' },
    ...Array.from({ length: ALU_BITS }, (_, i) => ({ name: `y${i}`, x: 200, y: i * 4, side: 'out' })),
    { name: 'cout', x: 200, y: 20, side: 'out' },
  ],
  build(m) {
    // decode the function code to one-hot, and complement each line for the
    // pass gates
    const dec = m.instantiate(Decode3, 0, 0, {
      f0: m.port('f0'), f1: m.port('f1'), f2: m.port('f2'),
    });
    m.region('Function decoder — F to one-hot', -3, -3, dec.w + 2, dec.h + 2);
    const NAMES = ['add', 'sub', 'and', 'or', 'xor', 'shl'];
    const sel = {}, nsel = {};
    NAMES.forEach((name, i) => {
      sel[name] = dec.nets[`y${i}`];
      nsel[name] = m.net();
      m.instantiate(Inverter, GATE_W * 6.5, i * (GATE_H + 2), {
        a: sel[name], y: nsel[name],
      });
    });

    // SUB inverts B and forces Cin = 1. Both are just the sub select line:
    // bx_i = b_i XOR sub, and carry-in to bit 0 is sub itself.
    const bx = [];
    let bxBottom = 0;
    for (let i = 0; i < ALU_BITS; i++) {
      bx[i] = m.net();
      const inst = m.instantiate(Xor2, GATE_W * 9.5, i * (GATE_H * 2 + 4), {
        a: m.port(`b${i}`), b: sel.sub, y: bx[i],
      });
      bxBottom = i * (GATE_H * 2 + 4) + inst.h;
    }
    m.region('B inverter — two’s complement for SUB',
      GATE_W * 9.5 - 3, -3, GATE_W * 9.5 + 26, bxBottom + 2);

    let carry = sel.sub;   // Cin = 1 for two's-complement subtract
    const selBind = {};
    for (const n of NAMES) { selBind[`s_${n}`] = sel[n]; selBind[`n_${n}`] = nsel[n]; }

    // Bit slices run left to right, not stacked: these circuits are drawn
    // wide and short (the layout code assumes it — see CLAUDE.md), and a
    // ripple carry reads naturally as a left-to-right chain.
    for (let i = 0; i < ALU_BITS; i++) {
      const cout = i === ALU_BITS - 1 ? m.port('cout') : m.net();
      const x = GATE_W * 15 + i * (GATE_W * 11);
      const slice = m.instantiate(AluBit, x, 0, {
        a: m.port(`a${i}`),
        b: m.port(`b${i}`),
        bx: bx[i],
        // SHL: bit i takes A[i-1]; the LSB shifts in a hard 0
        ashl: i === 0 ? VSS : m.port(`a${i - 1}`),
        cin: carry,
        cout,
        y: m.port(`y${i}`),
        ...selBind,
      }, { tag: `bit${i}` });
      // One box per bit slice: the four of them side by side are the
      // clearest statement that this is one circuit repeated, with the
      // carry threaded left to right.
      m.region(`Bit ${i}${i === 0 ? ' (LSB)' : i === ALU_BITS - 1 ? ' (MSB)' : ''}`,
        x - 4, -3, x + GATE_W * 10.5, slice.h + 2);
      carry = cout;
    }
  },
});
