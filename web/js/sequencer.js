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
  Inverter, And2, Or2, Nor2, Xor2, DFlipFlop, GATE_W, GATE_H,
} from './gates.js';

export const PHASES = ['FETCH', 'DECODE', 'EXEC'];

// With two-byte fetch the cycle grows a phase: an instruction that carries
// an address fetches its operand before executing.
//
//   FETCH   put the PC on the ROM, capture the opcode byte
//   DECODE  the register is stable, the decoder has settled
//   FETCH2  a two-byte instruction fetches its operand here; a one-byte
//           instruction passes through doing nothing
//   EXEC    act
//
// The real 4004 does the same thing for the same reason, spread over more
// phases because its bus is four bits wide: an instruction that needs a
// 12-bit address cannot get one in a single memory cycle. Dropping the
// multiplexed bus removes the nibble-shuffling phases but not this one —
// the operand still has to be fetched from somewhere before it can be
// used, and that is architecture rather than packaging.
//
// FETCH2 is unconditional in the ring and conditional in its *effect*.
// A ring counter that could skip a phase would need a mux in the ring
// itself, and a ring with a mux in it can lose or duplicate its bit — the
// two failures a ring counter exists to make impossible. Passing through
// an idle phase costs one clock on one-byte instructions and keeps the
// ring a ring.
export const PHASES4 = ['FETCH', 'DECODE', 'FETCH2', 'EXEC'];

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
    { name: 'opJCN', x: -1.5, y: 38, side: 'in' },
    // from the condition tree: this conditional jump's test came out true
    { name: 'condTake', x: -1.5, y: 42, side: 'in' },
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
    // A jump happens on an unconditional JUN, or on a JCN whose condition
    // came out true. Both are gated by EXEC, and from the program
    // counter's point of view they are the same event — which is exactly
    // why the condition tree is a separate block: it decides, the control
    // unit only acts.
    const jcnTake = m.net(), wantJump = m.net();
    m.instantiate(And2, GATE_W * 4, GATE_H * 1,
      { a: m.port('opJCN'), b: m.port('condTake'), y: jcnTake });
    m.instantiate(Or2, GATE_W * 7, GATE_H * 1,
      { a: m.port('opJUN'), b: jcnTake, y: wantJump });
    const jump = m.net();
    m.instantiate(And2, GATE_W * 10, GATE_H * 2,
      { a: pE, b: wantJump, y: jump });
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

// The JCN condition tree: does this conditional jump take?
//
// JCN's operand nibble is a condition *mask*, not a code — the real 4004
// tests several things at once and ORs the results, then optionally
// inverts. The bits, from the actual encoding:
//
//   OPA bit 3  invert the whole result
//   OPA bit 2  accumulator is zero
//   OPA bit 1  carry is set
//   OPA bit 0  the TEST pin is low
//
// So `JCN 4` jumps if the accumulator is zero, `JCN 12` jumps if it is
// *not* zero, `JCN 2` jumps on carry, and `JCN 6` jumps if either. That
// composability is why it is a mask: one instruction covers what a
// conventional machine spends four opcodes on.
//
// TEST is a real pin on the chip — an external input the program can branch
// on, which is how a 4004 read a keyboard without an interrupt. It is
// exposed here as an ordinary switch, because that is what it was.
//
// The inversion bit is what makes this a *tree* rather than a lookup: the
// same three condition inputs feed one OR, and bit 3 decides whether the
// jump takes on that result or its complement.
export const ConditionTree = defineModule('cond', {
  ports: [
    // the mask, from the instruction's low nibble
    { name: 'm0', x: -1.5, y: 0, side: 'in' },   // TEST
    { name: 'm1', x: -1.5, y: 4, side: 'in' },   // carry
    { name: 'm2', x: -1.5, y: 8, side: 'in' },   // accumulator zero
    { name: 'm3', x: -1.5, y: 12, side: 'in' },  // invert
    // machine state
    { name: 'accZero', x: -1.5, y: 18, side: 'in' },
    { name: 'carry', x: -1.5, y: 22, side: 'in' },
    { name: 'test', x: -1.5, y: 26, side: 'in' },
    { name: 'take', x: GATE_W * 20, y: 8, side: 'out' },
  ],
  build(m) {
    // each condition contributes only if its mask bit is set
    const cZero = m.net(), cCarry = m.net(), cTest = m.net();
    m.instantiate(And2, 0, 0,
      { a: m.port('m2'), b: m.port('accZero'), y: cZero });
    m.instantiate(And2, 0, GATE_H + 2,
      { a: m.port('m1'), b: m.port('carry'), y: cCarry });
    // TEST is active *low* on the real chip, so the mask bit tests for the
    // pin being low rather than high — one of those details that looks like
    // an error until you check the datasheet.
    const nTest = m.net();
    m.instantiate(Inverter, 0, GATE_H * 2 + 4, { a: m.port('test'), y: nTest });
    m.instantiate(And2, GATE_W * 3, GATE_H * 2 + 4,
      { a: m.port('m0'), b: nTest, y: cTest });

    // any selected condition true → the raw result
    const anyA = m.net(), raw = m.net();
    m.instantiate(Or2, GATE_W * 6, 0, { a: cZero, b: cCarry, y: anyA });
    m.instantiate(Or2, GATE_W * 9, 0, { a: anyA, b: cTest, y: raw });

    // bit 3 inverts: take = raw XOR invert, which is the whole trick
    m.instantiate(Xor2, GATE_W * 13, 0,
      { a: raw, b: m.port('m3'), y: m.port('take') });
  },
});

// Is a 4-bit value zero? An OR of every bit, inverted — the flag JCN needs
// and the one a machine has to compute rather than store, because the
// accumulator changes for reasons other than a comparison.
export const IsZero4 = defineModule('zero4', {
  ports: [
    ...Array.from({ length: 4 }, (_, i) => ({
      name: `a${i}`, x: -1.5, y: i * 4, side: 'in',
    })),
    { name: 'z', x: GATE_W * 10, y: 6, side: 'out' },
  ],
  build(m) {
    const o1 = m.net(), o2 = m.net(), any = m.net();
    m.instantiate(Or2, 0, 0, { a: m.port('a0'), b: m.port('a1'), y: o1 });
    m.instantiate(Or2, 0, GATE_H + 2, { a: m.port('a2'), b: m.port('a3'), y: o2 });
    m.instantiate(Or2, GATE_W * 4, 0, { a: o1, b: o2, y: any });
    m.instantiate(Inverter, GATE_W * 8, 0, { a: any, y: m.port('z') });
  },
});

// A control unit for the four-phase cycle, with two-byte fetch.
//
// The difference from the three-phase one is `oprLoad`: during FETCH2 a
// two-byte instruction captures the byte at the PC into an operand
// register, and the PC advances again so it does not re-execute that byte
// as an opcode. That last part is the whole reason two-byte fetch is
// structural rather than cosmetic — without it, a machine reads the
// operand as an instruction, which is exactly what the three-phase
// machines do and why their jump targets are welded to their opcodes.
export const ControlUnit4 = defineModule('ctrl4', {
  ports: [
    { name: 'pFetch', x: -1.5, y: 0, side: 'in' },
    { name: 'pDecode', x: -1.5, y: 4, side: 'in' },
    { name: 'pFetch2', x: -1.5, y: 8, side: 'in' },
    { name: 'pExec', x: -1.5, y: 12, side: 'in' },
    { name: 'twoByte', x: -1.5, y: 18, side: 'in' },
    { name: 'opJUN', x: -1.5, y: 22, side: 'in' },
    { name: 'opJCN', x: -1.5, y: 26, side: 'in' },
    { name: 'opLDM', x: -1.5, y: 30, side: 'in' },
    { name: 'opADD', x: -1.5, y: 34, side: 'in' },
    { name: 'opXCH', x: -1.5, y: 38, side: 'in' },
    { name: 'opINC', x: -1.5, y: 42, side: 'in' },
    { name: 'condTake', x: -1.5, y: 46, side: 'in' },
    { name: 'pcInc', x: 340, y: 0, side: 'out' },
    { name: 'pcLoad', x: 340, y: 6, side: 'out' },
    { name: 'irLoad', x: 340, y: 12, side: 'out' },
    { name: 'oprLoad', x: 340, y: 18, side: 'out' },
    { name: 'accLoad', x: 340, y: 24, side: 'out' },
    { name: 'accFromAlu', x: 340, y: 30, side: 'out' },
    { name: 'regWrite', x: 340, y: 36, side: 'out' },
  ],
  build(m) {
    const pF = m.port('pFetch'), pF2 = m.port('pFetch2'), pE = m.port('pExec');

    // the opcode is captured during FETCH
    const nF = m.net();
    m.instantiate(Inverter, 0, 0, { a: pF, y: nF });
    m.instantiate(Inverter, GATE_W * 2, 0, { a: nF, y: m.port('irLoad') });

    // the operand during FETCH2, and only for an instruction that has one
    m.instantiate(And2, 0, GATE_H * 2,
      { a: pF2, b: m.port('twoByte'), y: m.port('oprLoad') });

    // A jump: unconditional, or conditional and true.
    const jcnTake = m.net(), wantJump = m.net(), jump = m.net();
    m.instantiate(And2, GATE_W * 4, GATE_H * 4,
      { a: m.port('opJCN'), b: m.port('condTake'), y: jcnTake });
    m.instantiate(Or2, GATE_W * 7, GATE_H * 4,
      { a: m.port('opJUN'), b: jcnTake, y: wantJump });
    m.instantiate(And2, GATE_W * 10, GATE_H * 4, { a: pE, b: wantJump, y: jump });
    const jn = m.net();
    m.instantiate(Inverter, GATE_W * 13, GATE_H * 4, { a: jump, y: jn });
    m.instantiate(Inverter, GATE_W * 15, GATE_H * 4,
      { a: jn, y: m.port('pcLoad') });

    // The PC advances on FETCH, and again on FETCH2 when there is an
    // operand to step over — otherwise the operand byte would be the next
    // thing fetched as an opcode.
    const njump = m.net(), incF2 = m.net(), anyInc = m.net();
    m.instantiate(Inverter, GATE_W * 4, GATE_H * 6, { a: jump, y: njump });
    m.instantiate(And2, GATE_W * 7, GATE_H * 6,
      { a: pF2, b: m.port('twoByte'), y: incF2 });
    m.instantiate(Or2, GATE_W * 10, GATE_H * 6, { a: pF, b: incF2, y: anyInc });
    m.instantiate(And2, GATE_W * 13, GATE_H * 6,
      { a: anyInc, b: njump, y: m.port('pcInc') });

    // LDM and ADD both write the accumulator; accFromAlu picks the source
    const wantAcc = m.net();
    m.instantiate(Or2, GATE_W * 4, GATE_H * 8,
      { a: m.port('opLDM'), b: m.port('opADD'), y: wantAcc });
    m.instantiate(And2, GATE_W * 8, GATE_H * 8,
      { a: pE, b: wantAcc, y: m.port('accLoad') });
    m.instantiate(And2, GATE_W * 4, GATE_H * 9,
      { a: pE, b: m.port('opADD'), y: m.port('accFromAlu') });

    const rw = m.net();
    m.instantiate(Or2, GATE_W * 4, GATE_H * 10,
      { a: m.port('opXCH'), b: m.port('opINC'), y: rw });
    m.instantiate(And2, GATE_W * 8, GATE_H * 10,
      { a: pE, b: rw, y: m.port('regWrite') });
  },
});
