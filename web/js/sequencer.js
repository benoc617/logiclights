// Control sequencing: the part that turns decoded instruction lines into
// actions, and the part the 4004 plan warns is where machines like this
// stall.
//
// A decoder says *what* the instruction is. A sequencer says *when* each
// part of it happens — and it has to, because one instruction takes several
// clock cycles and the datapath can only do one thing per cycle. Fetch the
// byte, then decide, then act: those cannot overlap, so something has to
// count phases and gate the datapath from them.
//
// The real 4004 runs an 8-phase cycle (A1 A2 A3 M1 M2 X1 X2 X3), but most
// of those phases exist to shuttle a 12-bit address and an 8-bit
// instruction through a 4-bit bus, one nibble at a time, because Intel had
// sixteen pins. The plan drops the multiplexed bus deliberately, so the
// phases it forced go with it. What is left is the part that is actually
// about executing an instruction rather than about pin scarcity:
//
//   FETCH   put the PC on the ROM address, capture the byte
//   DECODE  the instruction register is stable; the decoder has settled
//   EXEC    gate the datapath — write a register, add, jump
//
// A two-byte instruction inserts a second fetch between DECODE and EXEC,
// which is what `twoByte` from the decoder is for and what makes the
// sequencer a state machine rather than a fixed rotation.

import { VDD, VSS } from './engine.js';
import { defineModule } from './module.js';
import {
  Inverter, And2, Or2, Nor2, DFlipFlop, GATE_W, GATE_H,
} from './gates.js';

export const PHASES = ['FETCH', 'DECODE', 'EXEC'];

// A ring counter: one flip-flop per phase, with the high bit walking around
// the loop on every clock edge. This is `buildOscillator()` grown up — the
// relay ring chases a pulse around three inverters and never settles; this
// chases a *one* around three flip-flops and settles into a stable rotation
// because the clock says when to move.
//
// Ring counters are how real control units generate phases: a decoder from
// a binary counter would need N gates and would glitch between codes as the
// bits arrive at different times, and a glitching phase line would fire the
// wrong datapath control for a few nanoseconds. Here exactly one flip-flop
// is ever set, so there is no code to glitch through.
//
// `rst` forces the ring into phase 0 rather than leaving it empty — a ring
// counter that powers up with no bit set stays empty forever, and one that
// powers up with two never recovers. Like every synchronous reset here it
// takes one clock edge to land: until then the flip-flop outputs are still
// undriven and every phase line reads Z.
export function ringCounter(n) {
  return defineModule(`ring${n}`, {
    ports: [
      { name: 'clk', x: 0, y: -3, side: 'top' },
      { name: 'nclk', x: 0, y: -1, side: 'top' },
      { name: 'rst', x: -1.5, y: 4, side: 'in' },
      ...Array.from({ length: n }, (_, i) => ({
        name: `p${i}`, x: GATE_W * 16, y: i * 30, side: 'out',
      })),
    ],
    build(m) {
      const clk = m.port('clk'), nclk = m.port('nclk');
      const nrst = m.net();
      m.instantiate(Inverter, 0, 0, { a: m.port('rst'), y: nrst });

      const q = Array.from({ length: n }, () => m.net());
      for (let i = 0; i < n; i++) {
        const prev = q[(i + n - 1) % n];
        const d = m.net();
        const x = GATE_W * 4 + i * (GATE_W * 4);
        if (i === 0) {
          // Phase 0 is the odd one: it takes the last phase's output OR
          // reset, so a reset drops the machine into FETCH rather than
          // into nothing. Without this the ring can be empty and the
          // machine simply never starts.
          m.instantiate(Or2, x, i * 30, { a: prev, b: m.port('rst'), y: d });
        } else {
          // every other phase clears on reset, so exactly one bit is set
          m.instantiate(And2, x, i * 30, { a: prev, b: nrst, y: d });
        }
        m.instantiate(DFlipFlop, x + GATE_W * 2, i * 30,
          { d, q: q[i], clk, nclk }, { tag: `ff${i}` });
      }
      // publish the phase lines
      for (let i = 0; i < n; i++) {
        const t = m.net();
        m.instantiate(Inverter, GATE_W * 12, i * 30, { a: q[i], y: t });
        m.instantiate(Inverter, GATE_W * 14, i * 30, { a: t, y: m.port(`p${i}`) });
      }
    },
  });
}

// The control unit: phases in, datapath control lines out.
//
// Each output is an AND of "we are in this phase" and "the instruction
// wants this" — which is all a hardwired control unit is. A microcoded one
// would look the byte up in a ROM instead; the 4004 is hardwired, and at
// this instruction count hardwired is also the thing you can actually read
// off the canvas.
export const ControlUnit = defineModule('ctrl', {
  ports: [
    { name: 'pFetch', x: -1.5, y: 0, side: 'in' },
    { name: 'pDecode', x: -1.5, y: 4, side: 'in' },
    { name: 'pExec', x: -1.5, y: 8, side: 'in' },
    // from the decoder
    { name: 'twoByte', x: -1.5, y: 14, side: 'in' },
    { name: 'opJUN', x: -1.5, y: 18, side: 'in' },
    { name: 'opLDM', x: -1.5, y: 22, side: 'in' },
    { name: 'opXCH', x: -1.5, y: 26, side: 'in' },
    { name: 'opINC', x: -1.5, y: 30, side: 'in' },
    { name: 'opADD', x: -1.5, y: 34, side: 'in' },
    // to the datapath
    { name: 'pcInc', x: 300, y: 0, side: 'out' },    // advance the PC
    { name: 'pcLoad', x: 300, y: 6, side: 'out' },   // jump: load the PC
    { name: 'irLoad', x: 300, y: 12, side: 'out' },  // capture the fetched byte
    { name: 'accLoad', x: 300, y: 18, side: 'out' }, // write the accumulator
    { name: 'regWrite', x: 300, y: 24, side: 'out' },// write a register
    // High when the accumulator should take the adder's output rather than
    // the instruction's immediate. LDM and ADD both write the accumulator;
    // this is what says *which source*, and it is the first control line
    // that steers a datapath rather than simply enabling something.
    { name: 'accFromAlu', x: 300, y: 30, side: 'out' },
  ],
  build(m) {
    const pF = m.port('pFetch'), pD = m.port('pDecode'), pE = m.port('pExec');

    // The instruction register captures during FETCH — that is the whole
    // job of that phase.
    const nF = m.net();
    m.instantiate(Inverter, 0, 0, { a: pF, y: nF });
    m.instantiate(Inverter, GATE_W * 2, 0, { a: nF, y: m.port('irLoad') });

    // The PC advances on FETCH too, so the next address is ready by the
    // time this instruction finishes. A jump overrides it at EXEC.
    const jump = m.net();
    m.instantiate(And2, GATE_W * 4, GATE_H * 2,
      { a: pE, b: m.port('opJUN'), y: jump });
    const njump = m.net();
    m.instantiate(Inverter, GATE_W * 7, GATE_H * 2, { a: jump, y: njump });
    m.instantiate(And2, GATE_W * 9, GATE_H * 2,
      { a: pF, b: njump, y: m.port('pcInc') });
    const t = m.net();
    m.instantiate(Inverter, GATE_W * 11, GATE_H * 2, { a: jump, y: t });
    m.instantiate(Inverter, GATE_W * 13, GATE_H * 2, { a: t, y: m.port('pcLoad') });

    // LDM and ADD both write the accumulator at EXEC — one from the
    // instruction's immediate, the other from the adder. accLoad says
    // *whether* to write; accFromAlu says *from where*.
    const wantAcc = m.net();
    m.instantiate(Or2, GATE_W * 4, GATE_H * 6,
      { a: m.port('opLDM'), b: m.port('opADD'), y: wantAcc });
    m.instantiate(And2, GATE_W * 8, GATE_H * 6,
      { a: pE, b: wantAcc, y: m.port('accLoad') });
    m.instantiate(And2, GATE_W * 4, GATE_H * 7,
      { a: pE, b: m.port('opADD'), y: m.port('accFromAlu') });

    // XCH and INC both write a register, so the write line is their OR
    // gated by EXEC — this is the shape every control line takes.
    const rw = m.net();
    m.instantiate(Or2, GATE_W * 4, GATE_H * 8,
      { a: m.port('opXCH'), b: m.port('opINC'), y: rw });
    m.instantiate(And2, GATE_W * 8, GATE_H * 8,
      { a: pE, b: rw, y: m.port('regWrite') });
  },
});
