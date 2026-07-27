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
  Inverter, And2, Or2, Nor2, Xor2, DFlipFlop, register, GATE_W, GATE_H,
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
// This is NOT the real 4004's phase structure, and the difference is worth
// stating rather than glossing.
//
// The 4004 runs eight phases per instruction — A1 A2 A3 M1 M2 X1 X2 X3.
// A1-A3 push a 12-bit address out one nibble at a time; M1-M2 read the
// instruction back one nibble at a time; X1-X3 execute. Five of those
// eight exist because the chip had sixteen pins and a four-bit bus. They
// are about moving bits through a narrow wire, not about what an
// instruction means.
//
// The four phases here are a different decomposition of the same job, not
// a subset of the real one: the address goes out whole, the byte comes
// back whole, and FETCH2 exists only because a two-byte instruction really
// does have a second byte to read. That much is architecture — an operand
// has to be fetched before it can be used on any machine — but the
// *shape* is ours.
//
// This follows the scope call in 4004.md: keep what the instruction set
// requires, drop what pin scarcity forced. Honouring the multiplexed bus
// would roughly triple the control-sequencing device count to demonstrate
// 1971 packaging.
//
// FETCH2 is unconditional in the ring and conditional in its *effect*.
// A ring counter that could skip a phase would need a mux in the ring
// itself, and a ring with a mux in it can lose or duplicate its bit — the
// two failures a ring counter exists to make impossible. Passing through
// an idle phase costs one clock on one-byte instructions and keeps the
// ring a ring.
export const PHASES4 = ['FETCH', 'DECODE', 'FETCH2', 'EXEC'];

// The memory machine grows a fifth phase, and for a reason that comes
// straight from the instruction set rather than from packaging.
//
// SRC sends the *eight* bits of a register pair to the memory bus. The
// index register file has one 4-bit read port — as the real chip's does,
// on sheet 1 — so a pair cannot be read in one go. It takes two reads.
//
//   FETCH   capture the opcode
//   DECODE  the decoder settles
//   READ1   read the pair's even register  → the address latch's high half
//   READ2   read the pair's odd register   → the address latch's low half
//   EXEC    act on the addressed memory
//
// The real 4004 does the same thing across its X1/X2/X3 execute phases —
// it also cannot read eight bits at once. This is a case where dropping
// the multiplexed bus does *not* remove the extra phases, because the
// narrowness here is the register file's, not the pin count's.
export const PHASES5 = ['FETCH', 'DECODE', 'READ1', 'READ2', 'EXEC'];

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

// The accumulator group's operand generator.
//
// Thirteen instructions share opcode 1111 and all of them do the same
// shape of thing: take the accumulator and the carry, produce a new
// accumulator and a new carry. The trick the 4004 uses — and the reason
// this costs so few gates — is that most of them are *the adder it
// already has*, fed a different second operand:
//
//   IAC   ACC + 1        second operand 0001, carry in 0
//   DAC   ACC + 15       second operand 1111 — subtracting one, because
//                        at four bits 15 is −1 and there is no borrow
//                        network to build
//   TCS   ACC + 9/10     the decimal-adjust helper; still just an add
//   CLB   ACC + 0 with the accumulator forced to zero
//
// So this block does not compute anything. It *selects a second operand*
// and lets the existing ripple adder do the arithmetic, which is exactly
// the economy that let Intel fit a CPU in 2,300 transistors. The three
// instructions that are not adds — CMA, RAL, RAR — are pure wiring:
// complement is four inverters, and a rotate is a renaming of wires with
// the carry spliced into one end.
//
//   b3 b2 b1 b0   is the operand this emits
//   cin           is the carry to feed the adder
//
// KBP and DAA are deliberately absent, and the omission is worth naming:
// KBP is a 4-to-1 keyboard-process lookup and DAA is a conditional
// decimal correction. Both are small tables rather than adder steering,
// so they belong in their own block rather than bent into this one.
export const AccOperand = defineModule('accop', {
  ports: [
    { name: 'opIAC', x: -1.5, y: 0, side: 'in' },
    { name: 'opDAC', x: -1.5, y: 4, side: 'in' },
    { name: 'opTCS', x: -1.5, y: 8, side: 'in' },
    { name: 'b0', x: GATE_W * 14, y: 0, side: 'out' },
    { name: 'b1', x: GATE_W * 14, y: 4, side: 'out' },
    { name: 'b2', x: GATE_W * 14, y: 8, side: 'out' },
    { name: 'b3', x: GATE_W * 14, y: 12, side: 'out' },
  ],
  build(m) {
    const iac = m.port('opIAC'), dac = m.port('opDAC'), tcs = m.port('opTCS');

    // bit 0 is set for IAC (0001) and DAC (1111). TCS emits 1001 or 1010
    // depending on the carry; this build takes the carry-clear case, 1001,
    // and the machine that needs the other half will gate it — noted
    // rather than silently wrong.
    const o0 = m.net();
    m.instantiate(Or2, 0, 0, { a: iac, b: dac, y: o0 });
    m.instantiate(Or2, GATE_W * 3, 0, { a: o0, b: tcs, y: m.port('b0') });

    // bits 1 and 2 are set only for DAC's 1111
    const t1 = m.net(), t2 = m.net();
    m.instantiate(Inverter, GATE_W * 6, GATE_H, { a: dac, y: t1 });
    m.instantiate(Inverter, GATE_W * 8, GATE_H, { a: t1, y: m.port('b1') });
    m.instantiate(Inverter, GATE_W * 6, GATE_H * 2, { a: dac, y: t2 });
    m.instantiate(Inverter, GATE_W * 8, GATE_H * 2, { a: t2, y: m.port('b2') });

    // bit 3 for DAC (1111) and TCS (1001)
    m.instantiate(Or2, GATE_W * 6, GATE_H * 3,
      { a: dac, b: tcs, y: m.port('b3') });
  },
});

// The carry flag's next value.
//
// Four instructions write the carry directly and one writes it as a side
// effect, and they are worth separating from the accumulator because the
// carry is a *one-bit register with its own instruction set* — which is
// how the 4004 treats it and why it has four opcodes of its own.
//
//   CLC   carry = 0
//   STC   carry = 1
//   CMC   carry = NOT carry
//   TCC   carry = 0, and the old carry goes *into* the accumulator
//   ADD and the arithmetic group   carry = the adder's carry out
//
// `sel` is high when any of these owns the carry; otherwise the adder
// does. Keeping that as one line means the machine has a single place
// where the carry's source is decided, rather than a priority muddle
// spread across the datapath.
export const CarryLogic = defineModule('carry', {
  ports: [
    { name: 'carry', x: -1.5, y: 0, side: 'in' },
    { name: 'opCLC', x: -1.5, y: 4, side: 'in' },
    { name: 'opSTC', x: -1.5, y: 8, side: 'in' },
    { name: 'opCMC', x: -1.5, y: 12, side: 'in' },
    { name: 'opTCC', x: -1.5, y: 16, side: 'in' },
    { name: 'd', x: GATE_W * 16, y: 0, side: 'out' },
    // high when this block owns the carry rather than the adder
    { name: 'sel', x: GATE_W * 16, y: 8, side: 'out' },
  ],
  build(m) {
    const carry = m.port('carry');

    // CMC contributes the complement of the current carry; STC
    // contributes a plain 1. CLC and TCC contribute nothing, which *is*
    // their effect — they select this block and drive zero.
    const ncarry = m.net(), fromCmc = m.net();
    m.instantiate(Inverter, 0, 0, { a: carry, y: ncarry });
    m.instantiate(And2, GATE_W * 3, 0,
      { a: m.port('opCMC'), b: ncarry, y: fromCmc });
    m.instantiate(Or2, GATE_W * 6, 0,
      { a: fromCmc, b: m.port('opSTC'), y: m.port('d') });

    // sel = CLC | STC | CMC | TCC
    const s1 = m.net(), s2 = m.net();
    m.instantiate(Or2, GATE_W * 3, GATE_H * 2,
      { a: m.port('opCLC'), b: m.port('opSTC'), y: s1 });
    m.instantiate(Or2, GATE_W * 3, GATE_H * 3,
      { a: m.port('opCMC'), b: m.port('opTCC'), y: s2 });
    m.instantiate(Or2, GATE_W * 7, GATE_H * 2,
      { a: s1, b: s2, y: m.port('sel') });
  },
});

// A two-phase clock generator: φ1 and φ2, non-overlapping.
//
// This is the 4004's actual clocking scheme, and it is the reason the chip
// can read and write one register array in a single instruction without a
// temporary register anywhere. Intel's schematic (sheet 2, "INDEX REGISTER
// CONTROL") gates the index register's write path and its read path on
// different phases, so the two never happen at the same instant even
// though they belong to the same instruction.
//
// Non-overlapping is the whole point and the part that is easy to get
// wrong. Two phases derived as `clk` and `NOT clk` would overlap during
// the gate delay of the inverter, and in that sliver both paths are live —
// which on a transparent latch is exactly the race that makes an exchange
// collapse into a self-assignment. Each phase here is ANDed with the
// *inverse of the other*, so a gap opens at every crossing:
//
//   clk    ‾‾‾‾|____|‾‾‾‾|____
//   φ1     ‾‾|__________|‾‾|__      high while clk is high, minus the gap
//   φ2     ____|‾‾‾|______|‾‾‾      high while clk is low,  minus the gap
//
// The real chip took φ1 and φ2 as *external pins* — two of its sixteen —
// because at 1971 densities generating them on-die was not worth the
// area. Generating them here from one clock is the concession; the
// non-overlap they guarantee is not.
export const TwoPhaseClock = defineModule('phi', {
  ports: [
    { name: 'clk', x: -1.5, y: 0, side: 'in' },
    { name: 'phi1', x: GATE_W * 12, y: 0, side: 'out' },
    { name: 'phi2', x: GATE_W * 12, y: 8, side: 'out' },
  ],
  build(m) {
    const clk = m.port('clk');
    const nclk = m.net();
    m.instantiate(Inverter, 0, 0, { a: clk, y: nclk });

    // The gap comes from delaying each phase's *rise* rather than from
    // cross-coupling the two outputs.
    //
    // Cross-coupling is the textbook drawing and it does not start: φ1
    // waits for φ2 to be low, φ2 waits for φ1 to be low, and at power-up
    // both are Z, so neither ever rises. That is the same deadlock the
    // ring counter has without its reset, and it is worth not repeating.
    //
    // Instead each phase is ANDed with a delayed copy of its own clock
    // sense. The delay chain is an even number of inverters, so the sense
    // is kept; the AND then holds the phase low for that delay after the
    // clock edge, which is the gap. Falling edges are not delayed, so the
    // phases go low promptly and the gap never closes.
    const d1 = m.net(), d1b = m.net();
    m.instantiate(Inverter, GATE_W * 3, 0, { a: clk, y: d1 });
    m.instantiate(Inverter, GATE_W * 5, 0, { a: d1, y: d1b });
    m.instantiate(And2, GATE_W * 8, 0, { a: clk, b: d1b, y: m.port('phi1') });

    const d2 = m.net(), d2b = m.net();
    m.instantiate(Inverter, GATE_W * 3, GATE_H * 2, { a: nclk, y: d2 });
    m.instantiate(Inverter, GATE_W * 5, GATE_H * 2, { a: d2, y: d2b });
    m.instantiate(And2, GATE_W * 8, GATE_H * 2,
      { a: nclk, b: d2b, y: m.port('phi2') });
  },
});

// The incrementer — a separate block, exactly as the chip has it.
//
// Sheet 1 of Intel's schematic is titled "4004 ADDRESS REGISTER,
// INCREMENTER AND INDEX", and the INCREMENTER is drawn as its own block
// beside the address register — not as a use of the adder on sheet 3.
// That is worth following rather than reasoning past: the instinct is to
// route the index register through the main adder and add 1, but the real
// chip spends gates on a dedicated incrementer instead, and it is cheaper
// than it looks.
//
// Adding 1 does not need full adders. Each bit is `q XOR carry-in`, and
// the carry propagates only while the bits below are all 1 — a half-adder
// chain, with the carry into bit 0 tied high:
//
//   s_i    = q_i XOR c_i
//   c_i+1  = q_i AND c_i        c_0 = 1
//
// Four XORs and three ANDs, against four full adders for the general
// case. The 4004 needed one of these for the program counter and another
// for the index registers, so the saving was worth a block of its own.
//
// `cout` is the carry off the top, which INC and ISZ both ignore — the
// manual is explicit that neither affects the carry bit. It is exposed
// because the program counter's incrementer wants it, not because the
// register path does.
export const Incrementer4 = defineModule('inc4', {
  ports: [
    ...Array.from({ length: 4 }, (_, i) => ({
      name: `q${i}`, x: -1.5, y: i * 4, side: 'in',
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      name: `s${i}`, x: GATE_W * 10, y: i * 4, side: 'out',
    })),
    { name: 'cout', x: GATE_W * 10, y: 20, side: 'out' },
  ],
  build(m) {
    let carry = VDD;                   // +1 enters at the bottom
    for (let i = 0; i < 4; i++) {
      const q = m.port(`q${i}`);
      m.instantiate(Xor2, GATE_W * 4, i * (GATE_H + 2),
        { a: q, b: carry, y: m.port(`s${i}`) });
      const next = i === 3 ? m.port('cout') : m.net();
      m.instantiate(And2, GATE_W * 7, i * (GATE_H + 2),
        { a: q, b: carry, y: next });
      carry = next;
    }
  },
});

// DAA — decimal adjust, and the condition that drives it.
//
// The 4004 was a calculator chip, so it works in BCD: each nibble holds
// one decimal digit, 0-9, and 10-15 are illegal. After a binary ADD a
// digit can land in that illegal range, or can have carried out — and
// either way adding 6 pushes it back into a valid digit with the right
// carry. That is the whole instruction.
//
// From Intel's manual, page 3-34, and both halves matter:
//
//   "If the contents of the accumulator are greater than 9, or if the
//    carry bit = 1, the accumulator is incremented by 6."
//   "If the result of incrementing the accumulator produces a carry out
//    of the high order bit position, the carry bit is set. Otherwise the
//    carry bit is unaffected (in particular, it is not reset)."
//
// That second sentence is underlined in the original and it is the part a
// reimplementation gets wrong. DAA can *set* the carry but never clears
// it, so `A=5, carry=1` adds 6 and leaves the carry set even though
// nothing carried out of bit 3. Treating it as an ordinary add — carry
// out replaces carry — would clear it and quietly break multi-digit BCD.
//
// `gt9` is `a3 & (a2 | a1)`: two gates, because 10-15 are exactly the
// values with bit 3 set and either bit 2 or bit 1 also set.
export const DecimalAdjust = defineModule('daa', {
  ports: [
    ...Array.from({ length: 4 }, (_, i) => ({
      name: `a${i}`, x: -1.5, y: i * 4, side: 'in',
    })),
    { name: 'carry', x: -1.5, y: 18, side: 'in' },
    // high when this instruction should add 6
    { name: 'adjust', x: GATE_W * 12, y: 0, side: 'out' },
    // the constant to add: 0110 when adjusting, 0000 otherwise
    ...Array.from({ length: 4 }, (_, i) => ({
      name: `b${i}`, x: GATE_W * 12, y: 8 + i * 4, side: 'out',
    })),
  ],
  build(m) {
    const a = [0, 1, 2, 3].map(i => m.port(`a${i}`));
    const or21 = m.net(), gt9 = m.net();
    m.instantiate(Or2, 0, 0, { a: a[2], b: a[1], y: or21 });
    m.instantiate(And2, GATE_W * 4, 0, { a: a[3], b: or21, y: gt9 });
    m.instantiate(Or2, GATE_W * 8, 0,
      { a: gt9, b: m.port('carry'), y: m.port('adjust') });

    // 6 is 0110, so bits 1 and 2 follow `adjust` and bits 0 and 3 are
    // always low. Buffered so the adder is driven by a gate.
    const t1 = m.net(), t2 = m.net();
    m.instantiate(Inverter, GATE_W * 8, GATE_H * 2,
      { a: m.port('adjust'), y: t1 });
    m.instantiate(Inverter, GATE_W * 10, GATE_H * 2, { a: t1, y: m.port('b1') });
    m.instantiate(Inverter, GATE_W * 8, GATE_H * 4,
      { a: m.port('adjust'), y: t2 });
    m.instantiate(Inverter, GATE_W * 10, GATE_H * 4, { a: t2, y: m.port('b2') });
    // bits 0 and 3 of 0110 are always low — an inverter from VDD, so the
    // port is driven rather than left floating
    m.instantiate(Inverter, GATE_W * 10, GATE_H * 6, { a: VDD, y: m.port('b0') });
    m.instantiate(Inverter, GATE_W * 10, GATE_H * 8, { a: VDD, y: m.port('b3') });
  },
});

// KBP — keyboard process, and the smallest interesting truth table on the
// chip.
//
// The 4004 was designed for a calculator, and this instruction exists to
// turn a keyboard scan into a digit. A row of key contacts gives you a
// one-of-n code — one wire high, the rest low — and KBP converts it to
// the binary position of that wire. From Intel's manual, page 3-35:
//
//   0000 → 0000     nothing pressed, unchanged
//   0001 → 0001     bit 0 → 1
//   0010 → 0010     bit 1 → 2
//   0100 → 0011     bit 2 → 3
//   1000 → 0100     bit 3 → 4
//   anything else → 1111
//
// That last line is the part worth reading twice. Two keys pressed at once
// is not an encoding error to be papered over — it is a real thing that
// happens on a real keyboard, and the chip reports it as 1111 so the
// program can tell "no valid key" from "key 0". A priority encoder, which
// is what you would reach for by instinct, would silently return the
// highest key and lose that distinction.
//
// The logic is smaller than the table suggests. For a single set bit:
//
//   o0 = a0 | a2     o1 = a1 | a2     o2 = a3     o3 = 0
//
// and then a "more than one bit set" detector forces all four outputs
// high, overriding the encode. Verified against all sixteen rows.
//
// The carry is not affected — the manual says so explicitly, and it is
// why this block has no carry port at all.
export const KeyboardProcess = defineModule('kbp', {
  ports: [
    ...Array.from({ length: 4 }, (_, i) => ({
      name: `a${i}`, x: -1.5, y: i * 4, side: 'in',
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      name: `y${i}`, x: GATE_W * 22, y: i * 4, side: 'out',
    })),
  ],
  build(m) {
    const a = [0, 1, 2, 3].map(i => m.port(`a${i}`));

    // "more than one bit set" — the OR of every pair. Six pairs at four
    // bits, which is fewer gates than counting and then comparing.
    const pairs = [];
    let px = 0;
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const t = m.net();
        m.instantiate(And2, GATE_W * 3, (px++) * (GATE_H + 2),
          { a: a[i], b: a[j], y: t });
        pairs.push(t);
      }
    }
    const o1 = m.net(), o2 = m.net(), o3 = m.net(), o4 = m.net();
    const multi = m.net();
    m.instantiate(Or2, GATE_W * 7, 0, { a: pairs[0], b: pairs[1], y: o1 });
    m.instantiate(Or2, GATE_W * 7, GATE_H * 2, { a: pairs[2], b: pairs[3], y: o2 });
    m.instantiate(Or2, GATE_W * 7, GATE_H * 4, { a: pairs[4], b: pairs[5], y: o3 });
    m.instantiate(Or2, GATE_W * 11, 0, { a: o1, b: o2, y: o4 });
    m.instantiate(Or2, GATE_W * 11, GATE_H * 3, { a: o4, b: o3, y: multi });

    // the single-bit encode, then multi forces every output high
    const e0 = m.net(), e1 = m.net();
    m.instantiate(Or2, GATE_W * 15, 0, { a: a[0], b: a[2], y: e0 });
    m.instantiate(Or2, GATE_W * 15, GATE_H * 2, { a: a[1], b: a[2], y: e1 });
    m.instantiate(Or2, GATE_W * 19, 0, { a: e0, b: multi, y: m.port('y0') });
    m.instantiate(Or2, GATE_W * 19, GATE_H * 2, { a: e1, b: multi, y: m.port('y1') });
    m.instantiate(Or2, GATE_W * 19, GATE_H * 4, { a: a[3], b: multi, y: m.port('y2') });
    // y3 is only ever set by the multi case
    const mn = m.net();
    m.instantiate(Inverter, GATE_W * 19, GATE_H * 6, { a: multi, y: mn });
    m.instantiate(Inverter, GATE_W * 21, GATE_H * 6, { a: mn, y: m.port('y3') });
  },
});

// SUB's operand conditioning.
//
// The 4004 subtracts the way every two's-complement machine does — add the
// complement — but its carry convention is genuinely odd, and it is odd in
// a way that is easy to "fix" into being wrong. From the manual:
//
//   ACC ← ACC + ~REG + ~carry
//
// Note the *inverted* carry in. On the way in, carry=1 means a borrow
// happened; on the way out, carry=1 means no borrow happened. The sense
// flips across the instruction, which is why the manual tells you to put a
// `CMC` between successive `SUB`s when chaining them across nibbles. A
// machine that used the carry directly would be subtly wrong only on
// multi-digit subtraction — the case nobody checks first.
//
// So this block conditions both operands for the adder: complement the
// register, complement the carry, and let the same ripple adder that does
// ADD do the work. Nothing else changes.
export const SubOperand = defineModule('subop', {
  ports: [
    ...Array.from({ length: 4 }, (_, i) => ({
      name: `r${i}`, x: -1.5, y: i * 4, side: 'in',
    })),
    { name: 'carry', x: -1.5, y: 18, side: 'in' },
    { name: 'sub', x: -1.5, y: 22, side: 'in' },
    ...Array.from({ length: 4 }, (_, i) => ({
      name: `b${i}`, x: GATE_W * 10, y: i * 4, side: 'out',
    })),
    { name: 'cin', x: GATE_W * 10, y: 18, side: 'out' },
  ],
  build(m) {
    const sub = m.port('sub');
    // Each bit passes through unchanged for ADD and inverted for SUB —
    // an XOR with the select line, which is the standard adder/subtractor
    // trick and the same one `alu.js` uses one level down.
    for (let i = 0; i < 4; i++) {
      m.instantiate(Xor2, 0, i * (GATE_H + 2),
        { a: m.port(`r${i}`), b: sub, y: m.port(`b${i}`) });
    }
    // The carry in is inverted for SUB and passed through for ADD — the
    // same XOR, which is what makes the odd convention cost nothing.
    m.instantiate(Xor2, GATE_W * 4, GATE_H * 5,
      { a: m.port('carry'), b: sub, y: m.port('cin') });
  },
});

// The SRC address latch: eight bits, filled a nibble at a time.
//
// SRC's address has to survive until the *next* SRC, because the access
// instructions that use it (RDM, WRM, ADM, the status and port
// instructions) are separate opcodes executed later. The manual is
// explicit: "the address sent by the SRC remains in effect until changed
// by a subsequent SRC." That persistence is the whole reason SRC exists
// as its own instruction rather than being folded into each access.
//
// Two load enables rather than one, because the two halves arrive in
// different phases. The high nibble is the chip-and-register select, the
// low nibble the character within that register — the split the manual
// draws on page 3-51.
export const SrcLatch = defineModule('srclatch', {
  ports: [
    { name: 'clk', x: 0, y: -3, side: 'top' },
    { name: 'nclk', x: 0, y: -1, side: 'top' },
    { name: 'loadHi', x: -1.5, y: 2, side: 'in' },
    { name: 'loadLo', x: -1.5, y: 6, side: 'in' },
    ...Array.from({ length: 4 }, (_, i) => ({
      name: `d${i}`, x: -1.5, y: 12 + i * 4, side: 'in',
    })),
    ...Array.from({ length: 8 }, (_, i) => ({
      name: `q${i}`, x: GATE_W * 20, y: i * 4, side: 'out',
    })),
  ],
  build(m) {
    const clk = m.port('clk'), nclk = m.port('nclk');
    const bindLo = { clk, nclk, load: m.port('loadLo') };
    const bindHi = { clk, nclk, load: m.port('loadHi') };
    for (let i = 0; i < 4; i++) {
      bindLo[`d${i}`] = m.port(`d${i}`);
      bindLo[`q${i}`] = m.port(`q${i}`);
      bindHi[`d${i}`] = m.port(`d${i}`);
      bindHi[`q${i}`] = m.port(`q${i + 4}`);
    }
    m.instantiate(register(4), 0, 0, bindLo, { tag: 'lo' });
    m.instantiate(register(4), 0, GATE_H * 6, bindHi, { tag: 'hi' });
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
    // High when this instruction is one of the accumulator group that
    // writes the accumulator — the 1111 escape decoded a second time. The
    // control unit does not care *which* of them it is; that is the
    // datapath's business. It only needs to know the accumulator is being
    // written, which is one line rather than thirteen.
    { name: 'accGroup', x: -1.5, y: 50, side: 'in' },
    { name: 'opSUB', x: -1.5, y: 54, side: 'in' },
    { name: 'opLD', x: -1.5, y: 58, side: 'in' },
    // XCH's read half: high only on a machine that has a path from the
    // register file back into the accumulator. Tie it low and XCH stays
    // the one-way write the earlier machines implement.
    { name: 'opXCHread', x: -1.5, y: 62, side: 'in' },
    // ISZ: increment a register, then jump if the result is NOT zero.
    { name: 'opISZ', x: -1.5, y: 66, side: 'in' },
    // JMS calls a subroutine, BBL returns from one.
    { name: 'opJMS', x: -1.5, y: 74, side: 'in' },
    { name: 'opBBL', x: -1.5, y: 78, side: 'in' },
    // high when the incremented register came out non-zero
    { name: 'iszTake', x: -1.5, y: 70, side: 'in' },
    { name: 'pcInc', x: 340, y: 0, side: 'out' },
    { name: 'pcLoad', x: 340, y: 6, side: 'out' },
    { name: 'irLoad', x: 340, y: 12, side: 'out' },
    { name: 'oprLoad', x: 340, y: 18, side: 'out' },
    { name: 'accLoad', x: 340, y: 24, side: 'out' },
    { name: 'accFromAlu', x: 340, y: 30, side: 'out' },
    // High when the accumulator should take the instruction's immediate.
    // Previously this was "not accFromAlu" and could stay implicit, because
    // there were only two sources. With five, the immediate needs to say
    // so itself rather than being the default nobody selected.
    { name: 'accFromImm', x: 340, y: 36, side: 'out' },
    // High when the accumulator should take the register file's output
    // directly — LD, and the read half of XCH.
    { name: 'accFromReg', x: 340, y: 42, side: 'out' },
    // High for SUB, feeding SubOperand. ADD and SUB share the adder and
    // differ only in this line.
    { name: 'aluSub', x: 340, y: 48, side: 'out' },
    // high when the register file's write data should come from the
    // incrementer rather than from the accumulator
    { name: 'regFromInc', x: 340, y: 60, side: 'out' },
    { name: 'stackPush', x: 340, y: 66, side: 'out' },
    { name: 'stackPop', x: 340, y: 72, side: 'out' },
    // BBL loads its immediate into the accumulator on the way back
    { name: 'accFromBbl', x: 340, y: 78, side: 'out' },
    { name: 'regWrite', x: 340, y: 54, side: 'out' },
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

    // A jump: unconditional, conditional and true, or an ISZ whose
    // incremented register came out non-zero.
    //
    // ISZ jumping on NOT zero is the way round that surprises people —
    // "increment and skip if zero" describes the fall-through, not the
    // jump. The manual states it as the jump: "if the result does not
    // equal 0000B, the 8 bits specified by ADDR replace the lowest 8 bits
    // of the program counter."
    const jcnTake = m.net(), anyTake = m.net(), wantJump = m.net();
    const jump = m.net();
    m.instantiate(And2, GATE_W * 4, GATE_H * 4,
      { a: m.port('opJCN'), b: m.port('condTake'), y: jcnTake });
    const iszTake = m.net();
    m.instantiate(And2, GATE_W * 4, GATE_H * 5,
      { a: m.port('opISZ'), b: m.port('iszTake'), y: iszTake });
    m.instantiate(Or2, GATE_W * 7, GATE_H * 5,
      { a: jcnTake, b: iszTake, y: anyTake });
    // JMS jumps to its operand like JUN, and BBL jumps to whatever the
    // stack hands back — so both join the same want-jump term. What
    // differs is where the address comes from, which is the datapath's
    // business rather than the control unit's.
    const callRet = m.net(), jun2 = m.net();
    m.instantiate(Or2, GATE_W * 4, GATE_H * 6,
      { a: m.port('opJMS'), b: m.port('opBBL'), y: callRet });
    m.instantiate(Or2, GATE_W * 7, GATE_H * 6,
      { a: m.port('opJUN'), b: callRet, y: jun2 });
    m.instantiate(Or2, GATE_W * 7, GATE_H * 4,
      { a: jun2, b: anyTake, y: wantJump });
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

    // Everything that writes the accumulator: LDM, ADD, SUB, LD, XCH and
    // the accumulator group. accFromAlu / accFromImm / accFromReg pick
    // between the sources.
    const wA = m.net(), wB = m.net(), wC = m.net(), wantAcc = m.net();
    m.instantiate(Or2, GATE_W * 4, GATE_H * 8,
      { a: m.port('opLDM'), b: m.port('opADD'), y: wA });
    m.instantiate(Or2, GATE_W * 4, GATE_H * 9,
      { a: m.port('opSUB'), b: m.port('opLD'), y: wB });
    m.instantiate(Or2, GATE_W * 6, GATE_H * 8, { a: wA, b: wB, y: wC });
    // XCH writes the accumulator too — a swap is a write in both
    // directions — but only on a machine that has a path from the
    // register file back to the accumulator. `opXCHread` is that machine
    // saying so.
    //
    // This has to be a separate input from `opXCH`, not the same line.
    // The machines built before LD decode XCH and write the register, but
    // have no return path: telling them XCH writes the accumulator makes
    // the source mux select nothing, and the accumulator captures zero.
    // The two-byte machine's countdown quietly loaded 0 over its 15 with
    // no other symptom — the failure looked like a decode bug three
    // modules away.
    // BBL writes the accumulator too — that is the whole point of "branch
    // back and LOAD". Selecting its source without enabling the write is
    // a silent no-op: the mux drives the right value at the right moment
    // and nothing captures it.
    const wD0 = m.net(), wD = m.net();
    m.instantiate(Or2, GATE_W * 6, GATE_H * 9,
      { a: m.port('accGroup'), b: m.port('opXCHread'), y: wD0 });
    m.instantiate(Or2, GATE_W * 6, GATE_H * 10,
      { a: wD0, b: m.port('opBBL'), y: wD });
    m.instantiate(Or2, GATE_W * 8, GATE_H * 8, { a: wC, b: wD, y: wantAcc });
    m.instantiate(And2, GATE_W * 10, GATE_H * 8,
      { a: pE, b: wantAcc, y: m.port('accLoad') });

    // ADD and SUB both come from the adder.
    //
    // The OR is on the *phase* side rather than in front of accFromAlu,
    // so accFromAlu stays exactly one gate deep. That matters more than it
    // looks: the machines built before SUB derive their immediate select
    // by inverting this line, and adding a gate here put the two selects a
    // delay apart — during which the mux drove neither source and the
    // accumulator captured nothing. The two-byte machine's countdown
    // stopped decrementing, with no other symptom.
    const exAdd = m.net(), exSub = m.net();
    m.instantiate(And2, GATE_W * 4, GATE_H * 10,
      { a: pE, b: m.port('opADD'), y: exAdd });
    m.instantiate(And2, GATE_W * 4, GATE_H * 11,
      { a: pE, b: m.port('opSUB'), y: exSub });
    m.instantiate(Or2, GATE_W * 8, GATE_H * 10,
      { a: exAdd, b: exSub, y: m.port('accFromAlu') });
    m.instantiate(And2, GATE_W * 4, GATE_H * 12,
      { a: pE, b: m.port('opLDM'), y: m.port('accFromImm') });

    // LD and XCH both read the register file into the accumulator.
    const fromReg = m.net();
    m.instantiate(Or2, GATE_W * 4, GATE_H * 13,
      { a: m.port('opLD'), b: m.port('opXCHread'), y: fromReg });
    m.instantiate(And2, GATE_W * 8, GATE_H * 13,
      { a: pE, b: fromReg, y: m.port('accFromReg') });

    // SUB conditions the adder's operands; it is not gated by a phase
    // because the adder is combinational and only its captured result
    // matters.
    const sn = m.net();
    m.instantiate(Inverter, GATE_W * 4, GATE_H * 14,
      { a: m.port('opSUB'), y: sn });
    m.instantiate(Inverter, GATE_W * 6, GATE_H * 14,
      { a: sn, y: m.port('aluSub') });

    // The stack. JMS pushes at EXEC; BBL pops one phase EARLIER.
    //
    // The push wants to be late: by EXEC the PC has stepped past the JMS
    // and its operand byte, so the value pushed is the address of the
    // next instruction rather than of the JMS itself. That is the return
    // address, and taking it any earlier would return into the middle of
    // the call.
    //
    // The pop wants to be early, for the opposite reason. Popping at EXEC
    // moves the pointer on the same edge that loads the program counter,
    // so the counter samples the stack's output *before* the pointer has
    // backed up — and loads whatever the previous slot held, which for a
    // fresh machine is zero. The symptom is a return that always goes to
    // address 0: it looks like the stack never stored anything, when in
    // fact it stored correctly and was read one phase too soon.
    //
    // Popping at FETCH2 gives the pointer a whole phase to settle, so the
    // address is stable on the bus when EXEC loads it. Same read-then-act
    // separation the register file needs for XCH, one level up.
    m.instantiate(And2, GATE_W * 4, GATE_H * 18,
      { a: pE, b: m.port('opJMS'), y: m.port('stackPush') });
    m.instantiate(And2, GATE_W * 4, GATE_H * 19,
      { a: pF2, b: m.port('opBBL'), y: m.port('stackPop') });
    // BBL also loads its low nibble into the accumulator — the trap that
    // a subroutine cannot return a result in the accumulator, because
    // the return instruction overwrites it.
    m.instantiate(And2, GATE_W * 4, GATE_H * 20,
      { a: pE, b: m.port('opBBL'), y: m.port('accFromBbl') });

    // XCH, INC and ISZ all write a register. INC and ISZ write the
    // incremented value; XCH writes the accumulator, so regFromInc is
    // what picks between the two sources.
    const rw = m.net(), incOrIsz = m.net();
    m.instantiate(Or2, GATE_W * 4, GATE_H * 16,
      { a: m.port('opINC'), b: m.port('opISZ'), y: incOrIsz });
    m.instantiate(Or2, GATE_W * 4, GATE_H * 15,
      { a: m.port('opXCH'), b: incOrIsz, y: rw });
    m.instantiate(And2, GATE_W * 8, GATE_H * 15,
      { a: pE, b: rw, y: m.port('regWrite') });
    const rfi = m.net();
    m.instantiate(Inverter, GATE_W * 8, GATE_H * 17,
      { a: incOrIsz, y: rfi });
    m.instantiate(Inverter, GATE_W * 10, GATE_H * 17,
      { a: rfi, y: m.port('regFromInc') });
  },
});

// The memory machine's control unit: five phases, and the memory group.
//
// Structurally simpler than ControlUnit4 despite covering more
// instructions, because the memory group is uniform. Every access is
// "read or write the thing SRC addressed", so the control lines are a
// direction, a destination and a source rather than sixteen special cases.
//
// The RAM itself is modelled rather than simulated (see ram4002.js and
// CLAUDE.md's fourth rule), so what this unit drives is the *interface* —
// the same signals the real CPU puts on the bus. What happens behind them
// is a JavaScript array, and the machine says so on screen.
export const MemControl = defineModule('memctrl', {
  ports: [
    { name: 'pFetch', x: -1.5, y: 0, side: 'in' },
    { name: 'pDecode', x: -1.5, y: 4, side: 'in' },
    { name: 'pRead1', x: -1.5, y: 8, side: 'in' },
    { name: 'pRead2', x: -1.5, y: 12, side: 'in' },
    { name: 'pExec', x: -1.5, y: 16, side: 'in' },
    // decoded instruction lines
    { name: 'opSRC', x: -1.5, y: 22, side: 'in' },
    { name: 'opLDM', x: -1.5, y: 26, side: 'in' },
    { name: 'opXCH', x: -1.5, y: 30, side: 'in' },
    // any memory-group instruction that writes the accumulator
    { name: 'memToAcc', x: -1.5, y: 34, side: 'in' },
    // any that writes memory or a port
    { name: 'memWrite', x: -1.5, y: 38, side: 'in' },
    // ADM and SBM: RAM through the adder, exactly as ADD and SUB take a
    // register through it. Same block, different operand source.
    { name: 'opADM', x: -1.5, y: 42, side: 'in' },
    { name: 'opSBM', x: -1.5, y: 46, side: 'in' },
    // DCL: the accumulator's low three bits select the RAM bank.
    { name: 'opDCL', x: -1.5, y: 50, side: 'in' },
    // The register-pair group. All three address registers two at a time,
    // which is why they live on the machine that already reads a pair.
    { name: 'opFIM', x: -1.5, y: 54, side: 'in' },
    { name: 'opFIN', x: -1.5, y: 58, side: 'in' },
    { name: 'opJIN', x: -1.5, y: 62, side: 'in' },
    { name: 'twoByte', x: -1.5, y: 66, side: 'in' },
    // High during FIN's *second* instruction cycle. FIN is one byte but
    // two cycles — the only instruction in the set that is — because it
    // needs to read a register pair, address the ROM with it, and write
    // a register pair, which does not fit in one pass of the ring.
    { name: 'finCycle2', x: -1.5, y: 70, side: 'in' },
    // outputs
    { name: 'pcInc', x: 320, y: 0, side: 'out' },
    { name: 'irLoad', x: 320, y: 6, side: 'out' },
    // the two halves of the SRC address, one phase each
    { name: 'srcHi', x: 320, y: 12, side: 'out' },
    { name: 'srcLo', x: 320, y: 18, side: 'out' },
    { name: 'accLoad', x: 320, y: 24, side: 'out' },
    { name: 'accFromImm', x: 320, y: 30, side: 'out' },
    { name: 'accFromMem', x: 320, y: 36, side: 'out' },
    { name: 'accFromReg', x: 320, y: 42, side: 'out' },
    { name: 'regWrite', x: 320, y: 48, side: 'out' },
    { name: 'ramWrite', x: 320, y: 54, side: 'out' },
    { name: 'accFromAlu', x: 320, y: 60, side: 'out' },
    { name: 'aluSub', x: 320, y: 66, side: 'out' },
    { name: 'carryWrite', x: 320, y: 72, side: 'out' },
    { name: 'bankLoad', x: 320, y: 78, side: 'out' },
    // Writing a pair: the even register in one phase, the odd in the
    // next, mirroring how SRC reads one.
    { name: 'pairHi', x: 320, y: 84, side: 'out' },
    { name: 'pairLo', x: 320, y: 90, side: 'out' },
    // FIN drives the ROM from r0:r1 rather than from the program counter
    { name: 'romFromPair', x: 320, y: 96, side: 'out' },
    // JIN loads the program counter from the pair it read
    { name: 'pcLoad', x: 320, y: 102, side: 'out' },
  ],
  build(m) {
    const pF = m.port('pFetch'), pR1 = m.port('pRead1');
    const pR2 = m.port('pRead2'), pE = m.port('pExec');

    // The opcode is captured during FETCH, and the PC steps then too.
    const nF = m.net();
    m.instantiate(Inverter, 0, 0, { a: pF, y: nF });
    m.instantiate(Inverter, GATE_W * 2, 0, { a: nF, y: m.port('irLoad') });

    // It steps a second time during DECODE for a two-byte instruction,
    // so the operand byte is not fetched as the next opcode.
    //
    // This machine has no FETCH2 phase — every instruction it had was one
    // byte, so it never needed one. FIM is the first that carries an
    // operand, and without the extra step the machine executes the
    // operand as an instruction: FIM 0P 0x0C is followed by 0x0C decoding
    // as NOP, and everything after it runs one address early. The
    // four-phase machines solve this with a whole phase; here the operand
    // is captured during DECODE, so only the increment is needed.
    const inc2 = m.net(), anyInc = m.net(), gated = m.net();
    m.instantiate(And2, 0, GATE_H * 2,
      { a: m.port('pDecode'), b: m.port('twoByte'), y: inc2 });
    m.instantiate(Or2, GATE_W * 3, GATE_H * 2,
      { a: pF, b: inc2, y: anyInc });
    // …but not on FIN's first cycle. FIN re-fetches the same byte on its
    // second pass, so the counter must sit still through the first — a
    // one-byte instruction that occupies two cycles still advances the
    // program by one.
    const finHold = m.net(), nHold = m.net();
    const nf2 = m.net();
    m.instantiate(Inverter, GATE_W * 6, GATE_H * 3,
      { a: m.port('finCycle2'), y: nf2 });
    m.instantiate(And2, GATE_W * 8, GATE_H * 3,
      { a: m.port('opFIN'), b: nf2, y: finHold });
    m.instantiate(Inverter, GATE_W * 11, GATE_H * 3,
      { a: finHold, y: nHold });
    m.instantiate(And2, GATE_W * 13, GATE_H * 2,
      { a: anyInc, b: nHold, y: gated });
    const nF2 = m.net();
    m.instantiate(Inverter, GATE_W * 16, GATE_H * 2, { a: gated, y: nF2 });
    m.instantiate(Inverter, GATE_W * 18, GATE_H * 2,
      { a: nF2, y: m.port('pcInc') });

    // SRC fills its latch a nibble at a time: the pair's even register in
    // READ1, the odd one in READ2. Only SRC does this, so both are gated
    // by the instruction as well as the phase.
    m.instantiate(And2, GATE_W * 5, 0,
      { a: pR1, b: m.port('opSRC'), y: m.port('srcHi') });
    m.instantiate(And2, GATE_W * 5, GATE_H * 2,
      { a: pR2, b: m.port('opSRC'), y: m.port('srcLo') });

    // The accumulator is written by LDM and by any memory instruction
    // that reads — RDM, RDn, RDR, and the arithmetic pair ADM/SBM.
    //
    // XCH is deliberately NOT here. This machine uses XCH only to load
    // the address pair, so it wants the write half and not the read half;
    // including it would fire accLoad with no source selected, and the
    // mux drives zero when nothing selects it. The accumulator would be
    // wiped by every XCH — which is what happened, and is why the
    // omission is stated rather than left to be noticed.
    const w0 = m.net(), wantAcc = m.net();
    m.instantiate(Or2, GATE_W * 8, GATE_H * 4,
      { a: m.port('opLDM'), b: m.port('memToAcc'), y: w0 });
    const arith0 = m.net();
    m.instantiate(Or2, GATE_W * 8, GATE_H * 5,
      { a: m.port('opADM'), b: m.port('opSBM'), y: arith0 });
    m.instantiate(Or2, GATE_W * 10, GATE_H * 4,
      { a: w0, b: arith0, y: wantAcc });
    m.instantiate(And2, GATE_W * 12, GATE_H * 4,
      { a: pE, b: wantAcc, y: m.port('accLoad') });

    // …and the three sources it picks between.
    m.instantiate(And2, GATE_W * 5, GATE_H * 6,
      { a: pE, b: m.port('opLDM'), y: m.port('accFromImm') });
    m.instantiate(And2, GATE_W * 5, GATE_H * 8,
      { a: pE, b: m.port('memToAcc'), y: m.port('accFromMem') });
    // accFromReg is deliberately tied low: this machine uses XCH only to
    // load the address pair, so it needs the write half. Turning the read
    // half on without the two-phase split the Subtract and Exchange
    // machine has would make the accumulator take the register in the
    // same phase the register takes the accumulator, and both land on the
    // register's old value — XCH r1 stores 1 instead of 5.
    m.instantiate(Inverter, GATE_W * 5, GATE_H * 10,
      { a: VDD, y: m.port('accFromReg') });

    // XCH writes a register; the memory-write group writes the 4002.
    m.instantiate(And2, GATE_W * 5, GATE_H * 12,
      { a: pE, b: m.port('opXCH'), y: m.port('regWrite') });
    m.instantiate(And2, GATE_W * 5, GATE_H * 14,
      { a: pE, b: m.port('memWrite'), y: m.port('ramWrite') });

    // ADM and SBM are ADD and SUB with the RAM as the operand:
    //   ADM   ACC ← ACC + RAM + carry
    //   SBM   ACC ← ACC + ~RAM + ~carry
    // Both write the carry from the adder — ADM sets it on overflow, SBM
    // sets it when there was no borrow, which is the same carry-out bit
    // read two ways. So one control line covers both.
    const arith = m.net();
    m.instantiate(Or2, GATE_W * 5, GATE_H * 16,
      { a: m.port('opADM'), b: m.port('opSBM'), y: arith });
    m.instantiate(And2, GATE_W * 9, GATE_H * 16,
      { a: pE, b: arith, y: m.port('accFromAlu') });
    m.instantiate(And2, GATE_W * 9, GATE_H * 18,
      { a: pE, b: arith, y: m.port('carryWrite') });
    // SBM alone inverts the operand and the carry in.
    const sn = m.net();
    m.instantiate(Inverter, GATE_W * 5, GATE_H * 20,
      { a: m.port('opSBM'), y: sn });
    m.instantiate(Inverter, GATE_W * 7, GATE_H * 20,
      { a: sn, y: m.port('aluSub') });

    // DCL latches the accumulator's low three bits as the bank select.
    m.instantiate(And2, GATE_W * 5, GATE_H * 22,
      { a: pE, b: m.port('opDCL'), y: m.port('bankLoad') });

    // Writing a register pair, for FIM and FIN. Same two-phase shape as
    // reading one: the even register takes the high nibble, the odd the
    // low. That order is the manual's — FIM 2 254 leaves r2 holding 15
    // and r3 holding 14 — and it is the same convention SRC uses, which
    // is what makes a pair a consistent 8-bit quantity across the whole
    // instruction set.
    //
    // FIN only writes on its SECOND cycle. On the first it is reading r0
    // and r1 to build the ROM address, and writing then would clobber the
    // very registers it is reading from — visibly, since RP=0 makes the
    // source and destination the same pair.
    const finWrite = m.net(), pairWrite = m.net();
    m.instantiate(And2, GATE_W * 5, GATE_H * 23,
      { a: m.port('opFIN'), b: m.port('finCycle2'), y: finWrite });
    m.instantiate(Or2, GATE_W * 5, GATE_H * 24,
      { a: m.port('opFIM'), b: finWrite, y: pairWrite });
    m.instantiate(And2, GATE_W * 9, GATE_H * 24,
      { a: pR1, b: pairWrite, y: m.port('pairHi') });
    m.instantiate(And2, GATE_W * 9, GATE_H * 26,
      { a: pR2, b: pairWrite, y: m.port('pairLo') });

    // FIN reads program memory at r0:r1 rather than at the program
    // counter. The ROM address multiplexes for one instruction, which is
    // the only time in this machine that the program counter does not
    // drive it.
    const fn = m.net();
    m.instantiate(Inverter, GATE_W * 5, GATE_H * 28,
      { a: m.port('opFIN'), y: fn });
    m.instantiate(Inverter, GATE_W * 7, GATE_H * 28,
      { a: fn, y: m.port('romFromPair') });

    // JIN loads the low eight bits of the program counter from the pair.
    m.instantiate(And2, GATE_W * 5, GATE_H * 30,
      { a: pE, b: m.port('opJIN'), y: m.port('pcLoad') });
  },
});

// The 4004's address stack — three registers on a cylinder.
//
// This is not the stack most people picture, and the difference is the
// whole reason it is worth building rather than modelling. From section
// 2.4 of Intel's manual: "it may be helpful to visualize the stack as
// three registers on the surface of a cylinder". Nothing shifts. A
// pointer rotates, and the registers stay where they are:
//
//   write   store at the pointer, then advance it
//   read    back the pointer up, then read — "the address read remains
//           in the stack undisturbed"
//
// Two consequences fall out, both real 4004 behaviour rather than
// simplifications:
//
//   A fourth call overwrites the first, silently. There is no overflow
//   detection because there is nowhere to report it — figure 2-4 shows
//   `d` landing on top of `a` and the manual just says the address is
//   "overwritten and lost". Three levels of nesting is the budget, and
//   exceeding it corrupts the return path with no diagnostic.
//
//   A return does not erase what it read. Reading is only moving the
//   pointer back, so the value stays in its register — figure 2-5 shows
//   three reads leaving all three addresses in place. A conventional
//   pop-and-clear would behave identically for well-formed programs and
//   differently for ill-formed ones, which is exactly the sort of detail
//   that makes a reimplementation subtly not-the-chip.
//
// The pointer is a 3-state ring, so it is a ring counter — the same block
// the phase ring uses, one more place where the same idea shows up. It
// needs to count *both ways*, which a plain ring cannot, so each cell
// takes its next value from a mux between its neighbours.
export function addressStack(bits) {
  return defineModule(`stack${bits}`, {
    ports: [
      { name: 'clk', x: 0, y: -3, side: 'top' },
      { name: 'nclk', x: 0, y: -1, side: 'top' },
      { name: 'rst', x: -1.5, y: 2, side: 'in' },
      { name: 'push', x: -1.5, y: 6, side: 'in' },
      { name: 'pop', x: -1.5, y: 10, side: 'in' },
      ...Array.from({ length: bits }, (_, i) => ({
        name: `d${i}`, x: -1.5, y: 16 + i * 4, side: 'in',
      })),
      ...Array.from({ length: bits }, (_, i) => ({
        name: `q${i}`, x: GATE_W * 40, y: i * 4, side: 'out',
      })),
      // which register the pointer is on, for the display
      ...Array.from({ length: 3 }, (_, i) => ({
        name: `p${i}`, x: GATE_W * 40, y: 40 + i * 4, side: 'out',
      })),
    ],
    build(m) {
      const clk = m.port('clk'), nclk = m.port('nclk');
      const rst = m.port('rst'), push = m.port('push'), pop = m.port('pop');

      // The pointer: three one-hot cells. On push it moves forward, on
      // pop backward, and reset drops it on register 0.
      //
      // A pop must move the pointer BEFORE the read, and a push AFTER the
      // write. Both are handled by reading the *pre-pop* position for a
      // write and the *post-pop* position for a read, which is what the
      // two selection nets below are for.
      const p = [0, 1, 2].map(() => m.net());
      const nrst = m.net();
      m.instantiate(Inverter, 0, 0, { a: rst, y: nrst });
      for (let i = 0; i < 3; i++) {
        const fwd = m.net(), bwd = m.net(), hold = m.net();
        const move = m.net(), keep = m.net(), d = m.net();
        // forward: take the cell behind us; backward: the one ahead
        m.instantiate(And2, GATE_W * 3, i * 40,
          { a: p[(i + 2) % 3], b: push, y: fwd });
        m.instantiate(And2, GATE_W * 3, i * 40 + GATE_H,
          { a: p[(i + 1) % 3], b: pop, y: bwd });
        m.instantiate(Or2, GATE_W * 6, i * 40, { a: fwd, b: bwd, y: move });
        // hold when neither push nor pop is asserted
        const any = m.net(), nany = m.net();
        m.instantiate(Or2, GATE_W * 3, i * 40 + GATE_H * 2,
          { a: push, b: pop, y: any });
        m.instantiate(Inverter, GATE_W * 6, i * 40 + GATE_H * 2,
          { a: any, y: nany });
        m.instantiate(And2, GATE_W * 8, i * 40 + GATE_H * 2,
          { a: p[i], b: nany, y: hold });
        m.instantiate(Or2, GATE_W * 11, i * 40, { a: move, b: hold, y: keep });
        // reset forces cell 0 set and the others clear
        if (i === 0) {
          m.instantiate(Or2, GATE_W * 14, i * 40, { a: keep, b: rst, y: d });
        } else {
          m.instantiate(And2, GATE_W * 14, i * 40, { a: keep, b: nrst, y: d });
        }
        m.instantiate(DFlipFlop, GATE_W * 17, i * 40,
          { d, q: p[i], clk, nclk }, { tag: `pf${i}` });
        // publish
        const t = m.net();
        m.instantiate(Inverter, GATE_W * 22, i * 40, { a: p[i], y: t });
        m.instantiate(Inverter, GATE_W * 24, i * 40,
          { a: t, y: m.port(`p${i}`) });
      }

      // Where a write lands, and where a read comes from.
      //
      // Both use the pointer directly, and the ordering the manual
      // describes — "the pointer is backed up one register, [then] the
      // memory address indicated by the pointer is read" — falls out of
      // the clock edge rather than needing extra logic. The pointer moves
      // on the edge, so by the time the value is sampled it has already
      // backed up and is pointing at the register to read.
      //
      // Selecting p[(i+1)%3] here instead looks right on paper and reads
      // one register too far, because it backs up a second time on top of
      // the edge. The symptom is returns that come back in the right
      // *pattern* but from the wrong slot — d,c,b becomes c,b,d — which
      // is only visible against the manual's own worked figure.
      const wsel = p;
      const rsel = p;

      // Three register rows, each written when selected and pushed.
      const cell = [];
      for (let r = 0; r < 3; r++) {
        const we = m.net();
        m.instantiate(And2, GATE_W * 27, r * 40,
          { a: wsel[r], b: push, y: we });
        const bindq = [];
        const bind = { clk, nclk, load: we };
        for (let b = 0; b < bits; b++) {
          bind[`d${b}`] = m.port(`d${b}`);
          const q = m.net();
          bind[`q${b}`] = q;
          bindq.push(q);
        }
        m.instantiate(register(bits), GATE_W * 30, r * 40, bind,
          { tag: `s${r}` });
        cell.push(bindq);
      }

      // Read mux: the selected row drives the output bus.
      for (let b = 0; b < bits; b++) {
        const t0 = m.net(), t1 = m.net(), t2 = m.net(), o = m.net();
        m.instantiate(And2, GATE_W * 34, b * 6, { a: cell[0][b], b: rsel[0], y: t0 });
        m.instantiate(And2, GATE_W * 34, b * 6 + 8, { a: cell[1][b], b: rsel[1], y: t1 });
        m.instantiate(And2, GATE_W * 34, b * 6 + 16, { a: cell[2][b], b: rsel[2], y: t2 });
        m.instantiate(Or2, GATE_W * 37, b * 6, { a: t0, b: t1, y: o });
        m.instantiate(Or2, GATE_W * 39, b * 6, { a: o, b: t2, y: m.port(`q${b}`) });
      }
      m.stackCells = cell;
    },
  });
}
