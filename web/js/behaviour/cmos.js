// CMOS circuits: complementary N/P pairs, both rails driven.
//
// The hand-routed gates (inverter, NAND, NOR, transmission gate, tri-state)
// are the teaching material and stay hand-placed. The composed machines
// below them — ALU, ROM, register file — are assembled from the modules in
// gates.js, because nobody places five hundred transistors by eye.

import { Circuit, VDD, VSS, VALUE_CHAR } from '../engine.js';
import { MOS_H, MOS_GATE, switchSpdtT } from '../geometry.js';
import { instantiate } from '../module.js';
import { And2, Or2, Xor2, DLatch, FullAdder, DFlipFlop, Inverter, counter, register, programCounter, rippleAdder } from '../gates.js';
import { Alu4, ALU_BITS } from '../alu.js';
import { decoder as cmosDecoder } from '../rom.js';
import { romArray } from '../rom.js';
import { InstructionDecoder, Decode16, OPR_NAMES, disassemble } from '../decode.js';
import {
  ringCounter, ControlUnit, ControlUnit4, ConditionTree, IsZero4,
  AccOperand, CarryLogic, SubOperand, TwoPhaseClock,
  DecimalAdjust, KeyboardProcess, Incrementer4, SrcLatch, MemControl,
  addressStack,
  PHASES5,
  PHASES, PHASES4,
} from '../sequencer.js';
import { buildRom8 } from './rom-circuit.js';
import { RamBank } from '../ram4002.js';
import { RegFile16x4, REG_WIDTH, REG_ADDR } from '../regfile.js';
import { mosScaffold, cmosInv, buildRing, w } from './mos-scaffold.js';
import { buildFromModule } from './from-module.js';

function buildCmosInverter() {
  const c = new Circuit('CMOS Inverter');
  const yTop = 0, yBot = 14;
  const { IN } = mosScaffold(c, 24, yTop, yBot, [['IN', 6.6]]);
  const out = c.net();
  const g = cmosInv(c, 'K', IN, out, 14, yTop, yBot);
  w(c, IN, [5.2, 6.6], [g.gx, 6.6]);
  w(c, out, [14, 6.6], [20, 6.6]);
  c.addLamp('OUT', out, 20, 6.6);
  return c;
}

function buildCmosNand() {
  const c = new Circuit('CMOS NAND');
  const yTop = 0, yBot = 20;
  const { A, B } = mosScaffold(c, 28, yTop, yBot, [['A', 5], ['B', 9]]);
  const out = c.net(), mid = c.net();
  // pull-up network: PMOS in parallel, so either input low lifts the output
  c.addTransistor('PA', 'pmos', A, VDD, out, 14, 2);
  c.addTransistor('PB', 'pmos', B, VDD, out, 21, 2);
  w(c, VDD, [14, yTop], [14, 2]);
  w(c, VDD, [21, yTop], [21, 2]);
  w(c, out, [14, 4.4], [14, 11]);
  w(c, out, [21, 4.4], [21, 5.6], [14, 5.6]);
  // pull-down network: NMOS in series, so only both high pulls it down
  c.addTransistor('NA', 'nmos', A, out, mid, 14, 11);
  c.addTransistor('NB', 'nmos', B, mid, VSS, 14, 15.6);
  w(c, mid, [14, 13.4], [14, 15.6]);
  w(c, VSS, [14, 18], [14, yBot]);
  w(c, A, [5.2, 5], [12.5, 5]);
  w(c, A, [12.5, 3.2], [12.5, 12.2]);
  w(c, B, [5.2, 9], [10, 9]);
  w(c, B, [10, 9], [10, 16.8], [12.5, 16.8]);
  w(c, B, [10, 9], [10, 0.9], [19.5, 0.9], [19.5, 3.2]);
  w(c, out, [14, 8], [24, 8]);
  c.addLamp('OUT', out, 24, 8);
  return c;
}

function buildCmosNor() {
  const c = new Circuit('CMOS NOR');
  const yTop = 0, yBot = 20;
  const { A, B } = mosScaffold(c, 30, yTop, yBot, [['A', 5], ['B', 10]]);
  const out = c.net(), pmid = c.net();
  // the dual of NAND: PMOS in series, NMOS in parallel
  c.addTransistor('PA', 'pmos', A, VDD, pmid, 14, 2);
  c.addTransistor('PB', 'pmos', B, pmid, out, 14, 6.6);
  c.addTransistor('NA', 'nmos', A, out, VSS, 14, 13);
  c.addTransistor('NB', 'nmos', B, out, VSS, 21, 13);
  w(c, VDD, [14, yTop], [14, 2]);
  w(c, pmid, [14, 4.4], [14, 6.6]);
  w(c, out, [14, 9], [14, 13]);
  w(c, out, [14, 11], [21, 11], [21, 13]);
  w(c, VSS, [14, 15.4], [14, yBot]);
  w(c, VSS, [21, 15.4], [21, yBot]);
  w(c, A, [5.2, 5], [9, 5]);
  w(c, A, [9, 3.2], [9, 14.2]);
  w(c, A, [9, 3.2], [12.5, 3.2]);
  w(c, A, [9, 14.2], [12.5, 14.2]);
  w(c, B, [5.2, 10], [7, 10]);
  w(c, B, [7, 7.8], [7, 17.5]);
  w(c, B, [7, 7.8], [12.5, 7.8]);
  w(c, B, [7, 17.5], [19.5, 17.5], [19.5, 14.2]);
  w(c, out, [14, 10], [26, 10]);
  c.addLamp('OUT', out, 26, 10);
  return c;
}

// CMOS AND / OR / XOR, built from the gate modules. Unlike the hand-routed
// CMOS NAND and NOR next to them, these are composed — which is the honest
// way to show what they cost: AND is a NAND plus an inverter, and XOR is
// four NANDs, so the "simple" gates are the expensive ones.
function buildCmosComposed(name, def, note) {
  return () => {
    const c = new Circuit(name);
    c.implicitGround = false;
    const yTop = -6, yBot = 46;
    const a = c.net(), b = c.net();
    c.addSwitch('A', a, 'toggle', 4, 6, { to: VSS });
    c.addSwitch('B', b, 'toggle', 4, 12, { to: VSS });
    const inst = instantiate(c, def, 18, 0, { a, b });

    const bounds = c.bounds();
    const xEnd = bounds.x1 + 8;
    w(c, VDD, [0, yTop], [xEnd, yTop]);
    w(c, VSS, [0, yBot], [xEnd, yBot]);
    c.label('+V', -1.6, yTop, 1.1, '#ffb340');
    c.label('GND', -2.4, yBot, 1.1, '#7f8aa3');
    for (const s of c.switches) {
      const t = switchSpdtT(s);
      w(c, VDD, [2.4, yTop], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
      w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
    }
    c.addLamp('OUT', inst.nets.y, xEnd - 4, 8);
    c.region(note, 16, -3, bounds.x1 + 1, 24);
    return c;
  };
}

function buildTransmissionGate() {
  const c = new Circuit('Transmission Gate');
  const yTop = 0, yBot = 18;
  const { A, B, SEL } = mosScaffold(c, 36, yTop, yBot, [['A', 3], ['B', 11.4], ['SEL', 15]]);
  const nsel = c.net(), out = c.net();
  const g = cmosInv(c, 'I', SEL, nsel, 12, yTop, yBot);
  w(c, SEL, [5.2, 15], [g.gx, 15], [g.gx, g.gyN]);

  // Two pass gates, each an NMOS and a PMOS in parallel so the pair carries
  // a full 0 and a full 1. Complementary enables: exactly one is ever open.
  c.addTransistor('N1', 'nmos', nsel, A, out, 20, 3);
  c.addTransistor('P1', 'pmos', SEL, A, out, 26, 3);
  c.addTransistor('N2', 'nmos', SEL, out, B, 20, 9);
  c.addTransistor('P2', 'pmos', nsel, out, B, 26, 9);
  w(c, A, [5.2, 3], [26, 3]);
  w(c, out, [20, 5.4], [20, 9]);
  w(c, out, [26, 5.4], [26, 9]);
  w(c, out, [20, 6.5], [26, 6.5]);
  w(c, B, [5.2, 11.4], [26, 11.4]);
  w(c, out, [26, 6.5], [32, 6.5]);
  c.addLamp('OUT', out, 32, 6.5);

  // gate routing: SEL to P1 and N2, /SEL to N1 and P2 — the crossover is
  // what makes exactly one gate open for either value of SEL
  w(c, SEL, [g.gx, g.gyP], [g.gx, 1.5], [17.2, 1.5]);
  w(c, SEL, [17.2, 1.5], [17.2, 10.2], [18.5, 10.2]);
  w(c, SEL, [17.2, 1.5], [24.5, 1.5], [24.5, 4.2]);
  w(c, nsel, [12, 7.4], [15.8, 7.4], [15.8, 4.2], [18.5, 4.2]);
  w(c, nsel, [15.8, 7.4], [15.8, 12.8], [22.8, 12.8], [22.8, 10.2], [24.5, 10.2]);
  return c;
}

function buildTriState() {
  const c = new Circuit('Tri-State Bus');
  const yTop = 0, yBot = 20;
  const { D1, EN1, D2, EN2 } = mosScaffold(c, 42, yTop, yBot,
    [['D1', 3], ['EN1', 7], ['D2', 13.4], ['EN2', 17]]);
  const nen1 = c.net(), nen2 = c.net(), bus = c.net();
  cmosInv(c, 'A', EN1, nen1, 13, yTop, yBot);
  cmosInv(c, 'B', EN2, nen2, 19, yTop, yBot);
  w(c, EN1, [5.2, 7], [11.5, 7]);
  w(c, EN2, [5.2, 17], [17.5, 17]);

  // Two pass gates onto one shared net. Nothing arbitrates: whether the bus
  // ends up driven, floating or contended is entirely up to the enables.
  c.addTransistor('N1', 'nmos', EN1, D1, bus, 28, 3);
  c.addTransistor('P1', 'pmos', nen1, D1, bus, 33, 3);
  c.addTransistor('N2', 'nmos', EN2, bus, D2, 28, 11);
  c.addTransistor('P2', 'pmos', nen2, bus, D2, 33, 11);
  w(c, D1, [5.2, 3], [33, 3]);
  w(c, bus, [28, 5.4], [28, 11]);
  w(c, bus, [33, 5.4], [33, 11]);
  w(c, bus, [28, 8], [33, 8]);
  w(c, D2, [5.2, 13.4], [33, 13.4]);
  w(c, bus, [33, 8], [39, 8]);
  c.addLamp('BUS', bus, 39, 8);

  w(c, EN1, [11.5, 16.8], [11.5, 18.6], [26.5, 18.6], [26.5, 4.2]);
  w(c, nen1, [13, 5], [15, 5], [15, 1], [31.5, 1], [31.5, 4.2]);
  w(c, EN2, [17.5, 12.2], [26.5, 12.2]);
  w(c, nen2, [19, 14], [21.4, 14], [21.4, 9.6], [31.5, 9.6], [31.5, 12.2]);
  return c;
}

// ALU itself lives in alu.js; this only wraps it in the switches, lamps and
// rails the app needs. That split is the point: the machine is composed,
// and only its I/O is hand-drawn.
function buildAlu4() {
  const c = new Circuit('4-bit ALU');
  c.implicitGround = false;

  const bind = {};
  const yA = 4, yB = 26, yF = 48;
  // operand switches down the left, LSB at the top of each group
  for (let i = 0; i < ALU_BITS; i++) {
    const na = c.net(), nb = c.net();
    c.addSwitch(`A${i}`, na, 'toggle', 4, yA + i * 4, { to: VSS });
    c.addSwitch(`B${i}`, nb, 'toggle', 4, yB + i * 4, { to: VSS });
    bind[`a${i}`] = na;
    bind[`b${i}`] = nb;
  }
  for (let i = 0; i < 3; i++) {
    const n = c.net();
    c.addSwitch(`F${i}`, n, 'toggle', 4, yF + i * 4, { to: VSS });
    bind[`f${i}`] = n;
  }

  const inst = instantiate(c, Alu4, 24, 0, bind);
  c.slices = inst.stored;   // per-bit nets for each function, for display

  // rails span the whole block
  const b = c.bounds();
  const xEnd = Math.max(b.x1, 40) + 8;
  w(c, VDD, [0, -6], [xEnd, -6]);
  w(c, VSS, [0, 70], [xEnd, 70]);
  c.label('+V', -1.6, -6, 1.1, '#ffb340');
  c.label('GND', -2.4, 70, 1.1, '#7f8aa3');

  // feed every input switch from the rails (changeover: always driving)
  for (const s of c.switches) {
    const t = switchSpdtT(s);
    w(c, VDD, [2.4, -6], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
    w(c, VSS, [1.6, 70], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
  }

  // result lamps
  for (let i = 0; i < ALU_BITS; i++) {
    c.addLamp(`Y${i}`, inst.nets[`y${i}`], xEnd - 4, yA + i * 4, { short: `Y${i}` });
  }
  c.addLamp('Cout', inst.nets.cout, xEnd - 4, yB, { short: 'Cout' });
  // no addBus('Y') — the Y0..Y3 lamps already derive that bus, and
  // declaring it again lists it a second time under "Internal"
  return c;
}

// The 4004's index registers: 16 words of 4 bits, separate read and write
// ports. The largest block in the machine, and none of it placed by hand.
function buildRegFile() {
  const c = new Circuit('16×4 Register File');
  c.implicitGround = false;

  const bind = {};
  let y = 4;
  const mk = (label) => {
    const n = c.net();
    c.addSwitch(label, n, 'toggle', 4, y, { to: VSS });
    y += 4.5;
    return n;
  };
  for (let i = 0; i < REG_ADDR; i++) bind[`wa${i}`] = mk(`WA${i}`);
  for (let i = 0; i < REG_WIDTH; i++) bind[`d${i}`] = mk(`D${i}`);
  bind.we = mk('WE');
  y += 3;
  for (let i = 0; i < REG_ADDR; i++) bind[`ra${i}`] = mk(`RA${i}`);

  const inst = instantiate(c, RegFile16x4, 26, 0, bind);

  const b = c.bounds();
  const xEnd = b.x1 + 10;
  const yTop = -10, yBot = b.y1 + 6;
  w(c, VDD, [0, yTop], [xEnd, yTop]);
  w(c, VSS, [0, yBot], [xEnd, yBot]);
  c.label('+V', -1.6, yTop, 1.1, '#ffb340');
  c.label('GND', -2.4, yBot, 1.1, '#7f8aa3');
  for (const s of c.switches) {
    const t = switchSpdtT(s);
    w(c, VDD, [2.4, yTop], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
    w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
  }

  for (let i = 0; i < REG_WIDTH; i++) {
    c.addLamp(`Q${i}`, inst.nets[`q${i}`], xEnd - 5, 6 + i * 5, { short: `Q${i}` });
  }
  // The read port shows one register at a time; this exposes all sixteen,
  // read straight off the latch nets. Stored state is otherwise invisible —
  // you would have to walk RA through every address to find out what the
  // file holds.
  c.cells = inst.stored;
  return c;
}



// A program counter: the first circuit in the library with a clock.
//
// Everything before this was combinational or level-sensitive — you flipped
// a switch and watched the consequence settle. A counter is different: it
// has to remember where it was and advance exactly once per clock edge,
// which is why it needs edge-triggered flip-flops rather than latches. A
// latch is transparent while enabled, so the incremented value would race
// straight back around through the adder and the count would jump several
// times per pulse.
//
// `bits` is 4 for the demo and 12 for the 4004's real program counter.
function buildCounter(bits, name) {
  return () => {
    const c = new Circuit(name);
    c.implicitGround = false;

    const clkNet = c.net(), nclk = c.net(), en = c.net(), rst = c.net();
    const clkSw = c.addSwitch('CLK', clkNet, 'toggle', 4, 6, { to: VSS });
    c.addSwitch('RUN', en, 'toggle', 4, 11, { to: VSS });
    c.addSwitch('RST', rst, 'toggle', 4, 16, { to: VSS });
    // the app grows run / pause / step controls from this
    c.addClock(clkSw, { period: 1200 });

    const inst = instantiate(c, Inverter, 20, 30, { a: clkNet, y: nclk });
    const K = instantiate(c, counter(bits), 36, 0,
      { clk: clkNet, nclk, en, rst });

    const b = c.bounds();
    const xEnd = b.x1 + 10;
    const yTop = -12, yBot = Math.max(b.y1 + 6, 30);
    w(c, VDD, [0, yTop], [xEnd, yTop]);
    w(c, VSS, [0, yBot], [xEnd, yBot]);
    c.label('+V', -1.6, yTop, 1.1, '#ffb340');
    c.label('GND', -2.4, yBot, 1.1, '#7f8aa3');
    for (const sw of c.switches) {
      const t = switchSpdtT(sw);
      w(c, VDD, [2.4, yTop], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
      w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
    }
    for (let i = 0; i < bits; i++) {
      c.addLamp(`Q${i}`, K.nets[`q${i}`], xEnd - 5, 4 + i * 4.5, { short: `Q${i}` });
    }
    c.addLamp('Cout', K.nets.cout, xEnd - 5, 4 + bits * 4.5, { short: 'Cout' });
    c.region('Clock inverter', 16, 26, 30, 44, { side: 'top' });
    return c;
  };
}


// P0 — the fetch machine. A program counter, a program ROM, an instruction
// register and a decoder, wired into a loop that runs on its own.
//
// This is the first circuit here that *executes* rather than computes. Give
// it a clock and it fetches: the PC addresses the ROM, the byte at that
// address lands in the instruction register on the next edge, and the
// decoder lights the line for whatever instruction that is. Nothing acts on
// the decoded instruction yet — that is control sequencing, the next stage
// — so this is a machine that reads a program and understands it without
// doing anything about it.
//
// The 4004 plan calls this the first integration milestone, and the reason
// is that fetch is where a pile of parts becomes a machine. Everything
// before this needed you to flip a switch; this one only needs a clock.
//
// The program is deliberately a mix of one-byte instructions so the decoder
// visibly changes as the PC advances. Two-byte instructions are decoded
// (`twoByte` goes high) but not yet honoured — the sequencer will use that
// line to fetch the operand before executing, and until it exists the
// machine simply reads the operand byte as if it were an instruction. That
// gap is real and worth seeing rather than hiding.
const P0_PROGRAM = [
  0x00,   // NOP
  0xD5,   // LDM 5
  0x60,   // INC 0
  0xB0,   // XCH 0
  0x80,   // ADD 0
  0xA1,   // LD 1
  0xF1,   // (escape — accumulator group)
  0x40,   // JUN — two-byte, so twoByte lights
];

function buildFetch() {
  const c = new Circuit('Fetch Machine');
  c.implicitGround = false;

  const clkNet = c.net(), nclk = c.net(), run = c.net(), rst = c.net();
  const clkSw = c.addSwitch('CLK', clkNet, 'toggle', 4, 6, { to: VSS });
  c.addSwitch('RUN', run, 'toggle', 4, 11, { to: VSS });
  c.addSwitch('RST', rst, 'toggle', 4, 16, { to: VSS });
  c.addClock(clkSw, { period: 1600 });
  instantiate(c, Inverter, 20, 40, { a: clkNet, y: nclk });

  // Boxes are derived from each block's measured extent rather than typed
  // coordinates, because these blocks are wildly different shapes — the
  // decoder is 350 units tall for its sixteen output lines while the
  // counter is 386 wide and 64 tall. A uniform row would leave most of a
  // block outside the box that names it.
  const PC = instantiate(c, counter(3), 40, 0,
    { clk: clkNet, nclk, en: run, rst }, { tag: 'pc' });
  c.region('Program counter', 36, -6, 40 + PC.w + 4, PC.h + 6);

  const xRom = 40 + PC.w + 30;
  const Rom = romArray(P0_PROGRAM, 8, 3);
  const rom = instantiate(c, Rom, xRom, 0,
    { a0: PC.nets.q0, a1: PC.nets.q1, a2: PC.nets.q2 }, { tag: 'rom' });

  // The instruction register: eight flip-flops capturing the fetched byte
  // on the clock edge. Without it the decoder would follow the ROM
  // combinationally and flicker through garbage while the address settles
  // — the register is what makes the fetched instruction *stable* for a
  // whole cycle, which is the only reason the rest of a CPU can rely on it.
  const xIr = xRom + rom.w + 30;
  const ir = [];
  for (let i = 0; i < 8; i++) {
    ir.push(c.net());
    instantiate(c, DFlipFlop, xIr, i * 26,
      { d: rom.nets[`d${i}`], q: ir[i], clk: clkNet, nclk }, { tag: `ir${i}` });
  }
  c.region('Instruction register', xIr - 6, -6, xIr + 70, 7 * 26 + 24);

  const xDec = xIr + 190;
  const bind = {};
  for (let i = 0; i < 8; i++) bind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, 0, bind, { tag: 'dec' });
  c.region('Instruction decoder',
    xDec - 6, -6, xDec + dec.w + 4, dec.h + 6);

  const b = c.bounds();
  const xEnd = b.x1 + 10;
  const yTop = -14, yBot = b.y1 + 8;
  w(c, VDD, [0, yTop], [xEnd, yTop]);
  w(c, VSS, [0, yBot], [xEnd, yBot]);
  c.label('+V', -1.6, yTop, 1.1, '#ffb340');
  c.label('GND', -2.4, yBot, 1.1, '#7f8aa3');
  for (const sw of c.switches) {
    const t = switchSpdtT(sw);
    w(c, VDD, [2.4, yTop], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
    w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
  }

  for (let i = 0; i < 3; i++) {
    c.addLamp(`PC${i}`, PC.nets[`q${i}`], xEnd - 5, 4 + i * 4.5, { short: `PC${i}` });
  }
  for (let i = 0; i < 8; i++) {
    c.addLamp(`IR${i}`, ir[i], xEnd - 5, 22 + i * 4.5, { short: `IR${i}` });
  }
  c.addLamp('2BYTE', dec.nets.twoByte, xEnd - 5, 62, { short: 'TWO' });

  // The fetch loop, said at block level: the counter picks a word, the
  // array hands back a byte, the register holds it, the decoder reads it.
  c.flow('Program counter', 'ROM row decode', { label: 'address' });
  c.flow('ROM row decode', 'ROM array');
  c.flow('ROM array', 'ROM output buffers', { dir: 'v' });
  c.flow('ROM output buffers', 'Instruction register', { label: 'byte' });
  c.flow('Instruction register', 'Instruction decoder', { label: 'opcode' });

  c.decoded = Array.from({ length: 16 }, (_, i) => dec.nets[`op${i}`]);
  c.program = P0_PROGRAM;
  // The address the instruction register was loaded from — which is the
  // instruction actually executing, not the one being fetched. The PC has
  // already advanced past it by the time its effect is visible, so this is
  // what the program listing should highlight. Found by matching the
  // register's contents against the ROM: unambiguous while a program has
  // no repeated bytes, and honest about it when it does.
  c.execAddr = () => {
    let ir = 0;
    for (let i = 0; i < 8; i++) {
      if (c.value[c.lamps.find(l => (l.short ?? l.label) === `IR${i}`).net] === 1) {
        ir |= 1 << i;
      }
    }
    let pc = 0;
    for (let i = 0; i < 3; i++) {
      if (c.value[c.lamps.find(l => (l.short ?? l.label) === `PC${i}`).net] === 1) {
        pc |= 1 << i;
      }
    }
    // the instruction in the register came from the address before the PC
    const back = (pc - 1 + c.program.length) % c.program.length;
    return c.program[back] === ir ? back : c.program.indexOf(ir);
  };
  return c;
}


// P0b — the sequenced machine. The fetch machine with a control unit, so
// the phases of an instruction are separated and a jump actually jumps.
//
// The fetch machine advanced its PC on every clock edge, which works only
// because every instruction in its program was one byte and none of them
// did anything. Real execution needs phases: an instruction has to be
// fetched, then decoded, then acted on, and those cannot happen at once
// because the datapath can only do one thing per cycle.
//
// A ring counter generates the phases and the control unit ANDs them with
// the decoded instruction lines. That AND is the whole idea of a hardwired
// control unit — "we are in EXEC" AND "this is a JUN" is precisely the
// signal that loads the program counter.
//
// The visible payoff is the loop: the program ends in a jump back to the
// start, so this machine runs forever instead of falling off the end of the
// ROM. That is the difference between a circuit that reads a program and
// one that runs it.
const P0B_PROGRAM = [
  0x00,   // NOP
  0xD5,   // LDM 5      — decoded; the accumulator is not built yet
  0x60,   // INC 0
  0xB0,   // XCH 0
  0x00,   // NOP
  0x00,   // NOP
  0x00,   // NOP
  0x40,   // JUN 0      — jump back to the top, so it loops
];

function buildSequenced() {
  const c = new Circuit('Sequenced Machine');
  c.implicitGround = false;

  const clkNet = c.net(), nclk = c.net(), rst = c.net();
  const clkSw = c.addSwitch('CLK', clkNet, 'toggle', 4, 6, { to: VSS });
  c.addSwitch('RST', rst, 'toggle', 4, 11, { to: VSS });
  c.addClock(clkSw, { period: 1400 });
  instantiate(c, Inverter, 20, 40, { a: clkNet, y: nclk });

  // Layout is in rows, because the blocks are wildly different shapes: the
  // decoder is 350 units tall (sixteen output lines), the counter is 386
  // wide and 64 tall. Packing them on one row would leave a strip of
  // devices with a caption floating far above the things it names — so the
  // control path sits on the top row and the datapath below it, each block
  // boxed to its own measured extent.
  const ROW2 = 150;   // y of the second row

  // ── row 1: the control path ────────────────────────────────────────────
  const ring = instantiate(c, ringCounter(3), 40, 0,
    { clk: clkNet, nclk, rst }, { tag: 'ring' });
  c.region('Phase ring',
    36, -6, 40 + ring.w + 4, ring.h + 6);

  // ── row 2: the datapath ────────────────────────────────────────────────
  // The PC advances during FETCH, so by EXEC it already points at the next
  // instruction — which is exactly why a jump has to *override* it rather
  // than simply not incrementing.
  const PC = instantiate(c, counter(3), 40, ROW2,
    { clk: clkNet, nclk, en: ring.nets.p0, rst }, { tag: 'pc' });
  c.region('Program counter', 36, ROW2 - 6, 40 + PC.w + 4, ROW2 + PC.h + 6);

  const nFetch = c.net();
  instantiate(c, Inverter, 40, ROW2 - 40, { a: ring.nets.p0, y: nFetch });

  const xRom = 40 + PC.w + 30;
  const Rom = romArray(P0B_PROGRAM, 8, 3);
  const rom = instantiate(c, Rom, xRom, ROW2,
    { a0: PC.nets.q0, a1: PC.nets.q1, a2: PC.nets.q2 }, { tag: 'rom' });

  // The instruction register loads on the clock edge. Eight flip-flops
  // stacked, so this block is tall and narrow where its neighbours are wide.
  // The instruction register holds its value except during FETCH. A plain
  // flip-flop would reload on every edge, so the register would follow the
  // ROM through DECODE and EXEC — and since the PC has already advanced by
  // then, it would be showing the *next* instruction while the control unit
  // was still acting on this one. Each bit therefore gets a hold mux: take
  // the ROM during FETCH, take your own output otherwise.
  const xIr = xRom + rom.w + 30;
  const ir = [];
  for (let i = 0; i < 8; i++) {
    ir.push(c.net());
    const keep = c.net(), take = c.net(), d = c.net();
    instantiate(c, And2, xIr, ROW2 + i * 26,
      { a: rom.nets[`d${i}`], b: ring.nets.p0, y: take }, { tag: `irt${i}` });
    instantiate(c, And2, xIr, ROW2 + i * 26 + 13,
      { a: ir[i], b: nFetch, y: keep }, { tag: `irk${i}` });
    instantiate(c, Or2, xIr + 42, ROW2 + i * 26,
      { a: take, b: keep, y: d }, { tag: `irm${i}` });
    instantiate(c, DFlipFlop, xIr + 90, ROW2 + i * 26,
      { d, q: ir[i], clk: clkNet, nclk }, { tag: `ir${i}` });
  }
  c.region('Instruction register',
    xIr - 6, ROW2 - 6, xIr + 160, ROW2 + 7 * 26 + 24);

  // ── decode and control, to the right of the register ───────────────────
  // The decoder is the tallest block here (sixteen output lines), so it
  // sets the height of this row rather than being stacked under it — that
  // keeps the whole machine wide and short like the rest of the library.
  const xDec = xIr + 190;
  const dbind = {};
  for (let i = 0; i < 8; i++) dbind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, ROW2, dbind, { tag: 'dec' });
  c.region('Instruction decoder',
    xDec - 6, ROW2 - 6, xDec + dec.w + 4, ROW2 + dec.h + 6);

  const ROW3 = ROW2;
  const xCtrl = xDec + dec.w + 40;
  const ctrl = instantiate(c, ControlUnit, xCtrl, ROW3, {
    pFetch: ring.nets.p0, pDecode: ring.nets.p1, pExec: ring.nets.p2,
    twoByte: dec.nets.twoByte,
    opJUN: dec.nets.op4, opLDM: dec.nets.op13,
    opXCH: dec.nets.op11, opINC: dec.nets.op6,
    // Ports this machine has no hardware for are tied low rather than
    // left unbound: an unbound port floats at Z, and a Z into the control
    // unit's ORs lets control lines fire on instructions they should
    // ignore. The test suite catches it, which is how this was found.
    opADD: VSS, opJCN: VSS, condTake: VSS,
  }, { tag: 'ctrl' });
  c.region('Control unit',
    xCtrl - 6, ROW3 - 6, xCtrl + ctrl.w + 6, ROW3 + ctrl.h + 6);

  const b = c.bounds();
  const xEnd = b.x1 + 10;
  const yTop = -16, yBot = b.y1 + 8;
  w(c, VDD, [0, yTop], [xEnd, yTop]);
  w(c, VSS, [0, yBot], [xEnd, yBot]);
  c.label('+V', -1.6, yTop, 1.1, '#ffb340');
  c.label('GND', -2.4, yBot, 1.1, '#7f8aa3');
  for (const sw of c.switches) {
    const t = switchSpdtT(sw);
    w(c, VDD, [2.4, yTop], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
    w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
  }

  for (let i = 0; i < 3; i++) {
    c.addLamp(`P${i}`, ring.nets[`p${i}`], xEnd - 5, 4 + i * 4.5, { short: `P${i}` });
  }
  for (let i = 0; i < 3; i++) {
    c.addLamp(`PC${i}`, PC.nets[`q${i}`], xEnd - 5, 20 + i * 4.5, { short: `PC${i}` });
  }
  for (let i = 0; i < 8; i++) {
    c.addLamp(`IR${i}`, ir[i], xEnd - 5, 36 + i * 4.5, { short: `IR${i}` });
  }
  c.addLamp('JUMP', ctrl.nets.pcLoad, xEnd - 5, 76, { short: 'JMP' });

  // The fetch loop, at block level: the counter picks a word, the array
  // hands back a byte, the register holds it, the decoder reads it.
  c.flow('Program counter', 'ROM row decode', { label: 'address' });
  c.flow('ROM row decode', 'ROM array');
  c.flow('ROM array', 'ROM output buffers', { dir: 'v' });
  c.flow('ROM output buffers', 'Instruction register', { label: 'byte' });
  c.flow('Instruction register', 'Instruction decoder', { label: 'opcode' });
  // …and what the sequenced machine adds: a phase ring, and a control
  // unit that ANDs a phase with a decoded instruction.
  c.flow('Instruction decoder', 'Control unit', { label: 'which' });
  c.flow('Phase ring', 'Control unit', { label: 'when' });
  c.flow('Control unit', 'Program counter', { label: 'jump' });

  c.decoded = Array.from({ length: 16 }, (_, i) => dec.nets[`op${i}`]);
  c.phases = [ring.nets.p0, ring.nets.p1, ring.nets.p2];
  c.control = {
    pcInc: ctrl.nets.pcInc, pcLoad: ctrl.nets.pcLoad,
    irLoad: ctrl.nets.irLoad, accLoad: ctrl.nets.accLoad,
    regWrite: ctrl.nets.regWrite,
  };
  c.program = P0B_PROGRAM;
  // The address the instruction register was loaded from — which is the
  // instruction actually executing, not the one being fetched. The PC has
  // already advanced past it by the time its effect is visible, so this is
  // what the program listing should highlight. Found by matching the
  // register's contents against the ROM: unambiguous while a program has
  // no repeated bytes, and honest about it when it does.
  c.execAddr = () => {
    let ir = 0;
    for (let i = 0; i < 8; i++) {
      if (c.value[c.lamps.find(l => (l.short ?? l.label) === `IR${i}`).net] === 1) {
        ir |= 1 << i;
      }
    }
    let pc = 0;
    for (let i = 0; i < 3; i++) {
      if (c.value[c.lamps.find(l => (l.short ?? l.label) === `PC${i}`).net] === 1) {
        pc |= 1 << i;
      }
    }
    // the instruction in the register came from the address before the PC
    const back = (pc - 1 + c.program.length) % c.program.length;
    return c.program[back] === ir ? back : c.program.indexOf(ir);
  };
  return c;
}


// P2 — the machine adds. The 4004's actual ADD datapath, not a shortcut.
//
// ADD on a real 4004 is `ADD r`: the accumulator plus the register the
// instruction names plus the carry flag, with the result back in the
// accumulator and the carry updated. Every part of that sentence is a piece
// of hardware, and this machine has all of them:
//
//   the register file      addressed by the instruction's low nibble, which
//                          is exactly how the real encoding works — OPA is
//                          the register number
//   a 4-bit ripple adder   accumulator + register + carry
//   the carry flag         a one-bit register, because the 4004 has one and
//                          because ADD both reads and writes it
//   a source mux           the accumulator takes the immediate for LDM and
//                          the adder's sum for ADD
//
// The mux is the first control line here that *steers* rather than enables.
// Everything before it said "write this now"; accFromAlu says "write from
// there instead", which is the shape all datapath control eventually takes.
//
// The program loads a register, then adds it to the accumulator twice, so
// you can watch a running total. The carry lamp lights when the sum leaves
// four bits, which is the same carry the ripple adders in the Arithmetic
// group show one bit at a time.
const P2_PROGRAM = [
  0xD5,   // LDM 5    ACC = 5
  0xB0,   // XCH 0    R0 = 5, ACC = 0   (see note: XCH is one-directional here)
  0xD9,   // LDM 9    ACC = 9
  0x80,   // ADD 0    ACC = 9 + 5 = 14
  0x80,   // ADD 0    ACC = 14 + 5 = 19 → 3, carry out
  0x00,   // NOP
  0x40,   // JUN 0    round again
  0x00,   // NOP
];

function buildAddMachine() {
  const c = new Circuit('Adding Machine');
  c.implicitGround = false;

  const clkNet = c.net(), nclk = c.net(), rst = c.net();
  const clkSw = c.addSwitch('CLK', clkNet, 'toggle', 4, 6, { to: VSS });
  c.addSwitch('RST', rst, 'toggle', 4, 11, { to: VSS });
  c.addClock(clkSw, { period: 1400 });
  instantiate(c, Inverter, 20, 40, { a: clkNet, y: nclk });

  const ROW2 = 150;
  const ring = instantiate(c, ringCounter(3), 40, 0,
    { clk: clkNet, nclk, rst }, { tag: 'ring' });
  c.region('Phase ring',
    36, -6, 40 + ring.w + 4, ring.h + 6);

  const nFetch = c.net();
  instantiate(c, Inverter, 40, ROW2 - 40, { a: ring.nets.p0, y: nFetch });

  const pcLoadLine = c.net();
  const jumpTarget = [c.net(), c.net(), c.net()];
  const PC = instantiate(c, programCounter(3), 40, ROW2, {
    clk: clkNet, nclk, en: ring.nets.p0, rst, load: pcLoadLine,
    a0: jumpTarget[0], a1: jumpTarget[1], a2: jumpTarget[2],
  }, { tag: 'pc' });
  c.region('Program counter', 36, ROW2 - 6, 40 + PC.w + 4, ROW2 + PC.h + 6);

  const xRom = 40 + PC.w + 30;
  const Rom = romArray(P2_PROGRAM, 8, 3);
  const rom = instantiate(c, Rom, xRom, ROW2,
    { a0: PC.nets.q0, a1: PC.nets.q1, a2: PC.nets.q2 }, { tag: 'rom' });

  const xIr = xRom + rom.w + 30;
  const ir = [];
  for (let i = 0; i < 8; i++) {
    ir.push(c.net());
    const keep = c.net(), take = c.net(), d = c.net();
    instantiate(c, And2, xIr, ROW2 + i * 26,
      { a: rom.nets[`d${i}`], b: ring.nets.p0, y: take }, { tag: `irt${i}` });
    instantiate(c, And2, xIr, ROW2 + i * 26 + 13,
      { a: ir[i], b: nFetch, y: keep }, { tag: `irk${i}` });
    instantiate(c, Or2, xIr + 42, ROW2 + i * 26,
      { a: take, b: keep, y: d }, { tag: `irm${i}` });
    instantiate(c, DFlipFlop, xIr + 90, ROW2 + i * 26,
      { d, q: ir[i], clk: clkNet, nclk }, { tag: `ir${i}` });
  }
  c.region('Instruction register',
    xIr - 6, ROW2 - 6, xIr + 160, ROW2 + 7 * 26 + 24);

  const xDec = xIr + 190;
  const dbind = {};
  for (let i = 0; i < 8; i++) dbind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, ROW2, dbind, { tag: 'dec' });
  c.region('Instruction decoder', xDec - 6, ROW2 - 6, xDec + dec.w + 4, ROW2 + dec.h + 6);

  const xCtrl = xDec + dec.w + 40;
  const ctrl = instantiate(c, ControlUnit, xCtrl, ROW2, {
    pFetch: ring.nets.p0, pDecode: ring.nets.p1, pExec: ring.nets.p2,
    twoByte: dec.nets.twoByte,
    opJUN: dec.nets.op4, opLDM: dec.nets.op13,
    opXCH: dec.nets.op11, opINC: dec.nets.op6,
    opADD: dec.nets.op8,
    // no condition tree in this machine yet — tied low, not left floating
    opJCN: VSS, condTake: VSS,
  }, { tag: 'ctrl' });
  c.region('Control unit', xCtrl - 6, ROW2 - 6, xCtrl + ctrl.w + 6, ROW2 + ctrl.h + 6);

  // jump wiring
  const jn = c.net();
  instantiate(c, Inverter, xCtrl + 20, ROW2 + ctrl.h + 20,
    { a: ctrl.nets.pcLoad, y: jn }, { tag: 'jn' });
  instantiate(c, Inverter, xCtrl + 40, ROW2 + ctrl.h + 20,
    { a: jn, y: pcLoadLine }, { tag: 'jp' });
  for (let i = 0; i < 3; i++) {
    const t = c.net();
    instantiate(c, Inverter, xCtrl + 20, ROW2 + ctrl.h + 44 + i * 24,
      { a: ir[i], y: t }, { tag: `jt${i}n` });
    instantiate(c, Inverter, xCtrl + 40, ROW2 + ctrl.h + 44 + i * 24,
      { a: t, y: jumpTarget[i] }, { tag: `jt${i}` });
  }

  // ── the datapath ───────────────────────────────────────────────────────
  const ROW3 = ROW2 + 680;
  const accQ = [c.net(), c.net(), c.net(), c.net()];

  // The register file, addressed by the instruction's low nibble — which is
  // exactly what OPA means on the real chip. Only four registers are
  // reachable with a 3-bit ROM, but the file is the full 16.
  const rf = instantiate(c, RegFile16x4, 40, ROW3, {
    wa0: ir[0], wa1: ir[1], wa2: ir[2], wa3: ir[3],
    ra0: ir[0], ra1: ir[1], ra2: ir[2], ra3: ir[3],
    d0: accQ[0], d1: accQ[1], d2: accQ[2], d3: accQ[3],
    we: ctrl.nets.regWrite,
  }, { tag: 'rf' });
  c.region('Register file',
    36, ROW3 - 6, 40 + rf.w + 4, ROW3 + rf.h + 6, { side: 'left' });

  // The carry flag: one bit, written by ADD, read by the adder. The 4004
  // has exactly this, and ADD both consumes and produces it — which is why
  // a chain of ADDs can carry across nibbles.
  const carryQ = c.net();
  const xAdd = 40 + rf.w + 60;
  const adder = instantiate(c, rippleAdder(4), xAdd, ROW3, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3],
    b0: rf.nets.q0, b1: rf.nets.q1, b2: rf.nets.q2, b3: rf.nets.q3,
    cin: carryQ,
  }, { tag: 'add' });
  c.region('Adder',
    xAdd - 6, ROW3 - 6, xAdd + adder.w + 6, ROW3 + adder.h + 6);

  const xCf = xAdd + adder.w + 40;
  const cf = instantiate(c, register(1), xCf, ROW3, {
    clk: clkNet, nclk, load: ctrl.nets.accFromAlu, d0: adder.nets.cout,
  }, { tag: 'cf' });
  const cfn = c.net();
  instantiate(c, Inverter, xCf + 20, ROW3 + 60, { a: cf.nets.q0, y: cfn }, { tag: 'cfn' });
  instantiate(c, Inverter, xCf + 40, ROW3 + 60, { a: cfn, y: carryQ }, { tag: 'cfp' });
  c.region('Carry flag', xCf - 6, ROW3 - 6, xCf + 70, ROW3 + 80);

  // The source mux: the accumulator takes the immediate for LDM and the
  // adder's sum for ADD. This is the first control line that steers a
  // datapath rather than enabling something.
  const xMux = xCf + 90;
  const accD = [];
  for (let i = 0; i < 4; i++) {
    const fromAlu = c.net(), fromImm = c.net(), d = c.net();
    const nSel = c.net();
    instantiate(c, Inverter, xMux, ROW3 + i * 40 + 20,
      { a: ctrl.nets.accFromAlu, y: nSel }, { tag: `mxn${i}` });
    instantiate(c, And2, xMux + 20, ROW3 + i * 40,
      { a: adder.nets[`s${i}`], b: ctrl.nets.accFromAlu, y: fromAlu }, { tag: `mxa${i}` });
    instantiate(c, And2, xMux + 20, ROW3 + i * 40 + 22,
      { a: ir[i], b: nSel, y: fromImm }, { tag: `mxi${i}` });
    instantiate(c, Or2, xMux + 50, ROW3 + i * 40,
      { a: fromAlu, b: fromImm, y: d }, { tag: `mxo${i}` });
    accD.push(d);
  }
  c.region('Accumulator source mux',
    xMux - 6, ROW3 - 6, xMux + 90, ROW3 + 4 * 40);

  const xAcc = xMux + 110;
  instantiate(c, register(4), xAcc, ROW3, {
    clk: clkNet, nclk, load: ctrl.nets.accLoad,
    d0: accD[0], d1: accD[1], d2: accD[2], d3: accD[3],
    q0: accQ[0], q1: accQ[1], q2: accQ[2], q3: accQ[3],
  }, { tag: 'acc' });
  c.region('Accumulator', xAcc - 6, ROW3 - 6, xAcc + 140, ROW3 + 90);

  const b = c.bounds();
  const xEnd = b.x1 + 10;
  const yTop = -16, yBot = b.y1 + 8;
  w(c, VDD, [0, yTop], [xEnd, yTop]);
  w(c, VSS, [0, yBot], [xEnd, yBot]);
  c.label('+V', -1.6, yTop, 1.1, '#ffb340');
  c.label('GND', -2.4, yBot, 1.1, '#7f8aa3');
  for (const sw of c.switches) {
    const t = switchSpdtT(sw);
    w(c, VDD, [2.4, yTop], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
    w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
  }

  for (let i = 0; i < 3; i++) {
    c.addLamp(`P${i}`, ring.nets[`p${i}`], xEnd - 5, 4 + i * 4.5, { short: `P${i}` });
  }
  for (let i = 0; i < 3; i++) {
    c.addLamp(`PC${i}`, PC.nets[`q${i}`], xEnd - 5, 20 + i * 4.5, { short: `PC${i}` });
  }
  for (let i = 0; i < 8; i++) {
    c.addLamp(`IR${i}`, ir[i], xEnd - 5, 36 + i * 4.5, { short: `IR${i}` });
  }
  for (let i = 0; i < 4; i++) {
    c.addLamp(`ACC${i}`, accQ[i], xEnd - 5, 76 + i * 4.5, { short: `ACC${i}` });
  }
  for (let i = 0; i < 4; i++) {
    c.addLamp(`R${i}`, rf.nets[`q${i}`], xEnd - 5, 98 + i * 4.5, { short: `R${i}` });
  }
  c.addLamp('CARRY', cf.nets.q0, xEnd - 5, 120, { short: 'CY' });

  // The fetch loop, at block level: the counter picks a word, the array
  // hands back a byte, the register holds it, the decoder reads it.
  c.flow('Program counter', 'ROM row decode', { label: 'address' });
  c.flow('ROM row decode', 'ROM array');
  c.flow('ROM array', 'ROM output buffers', { dir: 'v' });
  c.flow('ROM output buffers', 'Instruction register', { label: 'byte' });
  c.flow('Instruction register', 'Instruction decoder', { label: 'opcode' });
  // Control, then the ADD datapath: OPA names a register, the file reads
  // it, the adder sums it with the accumulator and the carry, and the mux
  // steers the result back.
  c.flow('Instruction decoder', 'Control unit', { label: 'which' });
  c.flow('Phase ring', 'Control unit', { label: 'when' });
  c.flow('Instruction register', 'Read decode', { label: 'OPA' });
  c.flow('Register file', 'Adder', { label: 'operand' });
  c.flow('Carry flag', 'Adder', { label: 'carry in' });
  c.flow('Adder', 'Carry flag', { label: 'carry out' });
  c.flow('Adder', 'Accumulator source mux', { label: 'sum' });
  c.flow('Accumulator source mux', 'Accumulator');
  c.flow('Accumulator', 'Adder', { label: 'accumulator' });

  c.decoded = Array.from({ length: 16 }, (_, i) => dec.nets[`op${i}`]);
  c.phases = [ring.nets.p0, ring.nets.p1, ring.nets.p2];
  c.control = {
    pcInc: ctrl.nets.pcInc, pcLoad: ctrl.nets.pcLoad,
    accLoad: ctrl.nets.accLoad, accFromAlu: ctrl.nets.accFromAlu,
    regWrite: ctrl.nets.regWrite,
  };
  c.cells = rf.stored;
  c.program = P2_PROGRAM;
  // The address the instruction register was loaded from — which is the
  // instruction actually executing, not the one being fetched. The PC has
  // already advanced past it by the time its effect is visible, so this is
  // what the program listing should highlight. Found by matching the
  // register's contents against the ROM: unambiguous while a program has
  // no repeated bytes, and honest about it when it does.
  c.execAddr = () => {
    let ir = 0;
    for (let i = 0; i < 8; i++) {
      if (c.value[c.lamps.find(l => (l.short ?? l.label) === `IR${i}`).net] === 1) {
        ir |= 1 << i;
      }
    }
    let pc = 0;
    for (let i = 0; i < 3; i++) {
      if (c.value[c.lamps.find(l => (l.short ?? l.label) === `PC${i}`).net] === 1) {
        pc |= 1 << i;
      }
    }
    // the instruction in the register came from the address before the PC
    const back = (pc - 1 + c.program.length) % c.program.length;
    return c.program[back] === ir ? back : c.program.indexOf(ir);
  };
  return c;
}


// P3 — conditional jumps. The last bring-up milestone, and the one that
// makes the machine Turing-interesting rather than a straight line.
//
// JCN's operand is a condition *mask*, not a code, and that is the whole
// character of the instruction. The real bits:
//
//   bit 3  invert the result
//   bit 2  accumulator is zero
//   bit 1  carry is set
//   bit 0  the TEST pin is low
//
// So `JCN 4` jumps when the accumulator is zero and `JCN 12` jumps when it
// is not — same three condition inputs, one OR, and bit 3 deciding whether
// to take the result or its complement. One instruction covers what a
// conventional machine spends four opcodes on.
//
// TEST was a real pin: an external input a program could branch on, which
// is how a 4004 polled a keyboard without interrupts. It is a switch here
// because that is what it was — flip it and watch a running program change
// course.
//
// The program counts the accumulator down and loops until it hits zero,
// which is the first program here whose length depends on its data rather
// than on how many instructions were written.
// A countdown that loops on its own condition, which is the point of a
// conditional jump.
//
// r0 holds 15, and adding 15 is how you subtract 1. The accumulator is
// four bits, so arithmetic is mod 16: 4 + 15 = 19, which is 16 + 3 — the
// 16 does not fit and falls out as the carry, leaving 3. Every pass takes
// one off:
//
//   4 + 15 = 19 → 3, carry
//   3 + 15 = 18 → 2, carry
//   2 + 15 = 17 → 1, carry
//   1 + 15 = 16 → 0, carry
//
// That is two's complement: in four bits the top bit carries weight -8, so
// 1111 is -8+4+2+1 = -1. It is also why the 4004 has no subtract-immediate
// instruction — adding the complement is the same operation, and the
// hardware for it already exists.
//
// The loop has to exit at zero rather than run on: 0 + 15 = 15 with no
// carry, so the countdown would wrap to 15 and go round again. The JCN
// catches zero first, which is what makes it terminate. The JCN sends control back to the ADD
// while the result is not yet zero, so the loop runs three times and then
// falls through. Both branches, in one program.
//
// The loop body sits at address 4 because it has to. This machine has no
// two-byte fetch, so a jump's target is the low bits of its own byte — and
// for JCN that nibble is *also* the condition mask. `JCN 12` therefore
// means "jump if not zero" AND "jump to 4" inseparably: mask 12 is 1100,
// whose low three bits are 100. On the real chip the mask and the target
// are in different bytes and no such coupling exists; here it is the most
// visible consequence of the missing two-byte fetch, and worth seeing
// rather than hiding behind a program arranged to avoid it.
const P3_PROGRAM = [
  0xDF,   // LDM 15    ACC = 15, which is -1 in four bits
  0xB0,   // XCH r0    r0 = 15, the amount to add each pass
  0xD4,   // LDM 4     ACC = 4, the countdown
  0x00,   // NOP
  0x80,   // ADD r0    ACC -= 1          ← the loop body, and JCN's target
  0x1C,   // JCN 12    back to 4 while ACC is not zero
  0x40,   // JUN 0     fell through: start the whole thing again
  0x00,   // NOP
];

// `program` lets a test build this machine around a different ROM — the
// same circuit, a different eight bytes — so every JCN mask can be checked
// against a really fetched instruction rather than by forcing nets.
export function buildJcnMachine(program = P3_PROGRAM) {
  const c = new Circuit('Conditional Machine');
  c.implicitGround = false;

  const clkNet = c.net(), nclk = c.net(), rst = c.net(), test = c.net();
  const clkSw = c.addSwitch('CLK', clkNet, 'toggle', 4, 6, { to: VSS });
  c.addSwitch('RST', rst, 'toggle', 4, 11, { to: VSS });
  c.addSwitch('TEST', test, 'toggle', 4, 16, { to: VSS });
  c.addClock(clkSw, { period: 1400 });
  instantiate(c, Inverter, 20, 44, { a: clkNet, y: nclk });

  const ROW2 = 150;
  const ring = instantiate(c, ringCounter(3), 40, 0,
    { clk: clkNet, nclk, rst }, { tag: 'ring' });
  c.region('Phase ring', 36, -6, 40 + ring.w + 4, ring.h + 6);

  const nFetch = c.net();
  instantiate(c, Inverter, 40, ROW2 - 40, { a: ring.nets.p0, y: nFetch });

  const pcLoadLine = c.net();
  const jumpTarget = [c.net(), c.net(), c.net()];
  const PC = instantiate(c, programCounter(3), 40, ROW2, {
    clk: clkNet, nclk, en: ring.nets.p0, rst, load: pcLoadLine,
    a0: jumpTarget[0], a1: jumpTarget[1], a2: jumpTarget[2],
  }, { tag: 'pc' });
  c.region('Program counter', 36, ROW2 - 6, 40 + PC.w + 4, ROW2 + PC.h + 6);

  const xRom = 40 + PC.w + 30;
  const Rom = romArray(program, 8, 3);
  const rom = instantiate(c, Rom, xRom, ROW2,
    { a0: PC.nets.q0, a1: PC.nets.q1, a2: PC.nets.q2 }, { tag: 'rom' });

  const xIr = xRom + rom.w + 30;
  const ir = [];
  for (let i = 0; i < 8; i++) {
    ir.push(c.net());
    const keep = c.net(), take = c.net(), d = c.net();
    instantiate(c, And2, xIr, ROW2 + i * 26,
      { a: rom.nets[`d${i}`], b: ring.nets.p0, y: take }, { tag: `irt${i}` });
    instantiate(c, And2, xIr, ROW2 + i * 26 + 13,
      { a: ir[i], b: nFetch, y: keep }, { tag: `irk${i}` });
    instantiate(c, Or2, xIr + 42, ROW2 + i * 26,
      { a: take, b: keep, y: d }, { tag: `irm${i}` });
    instantiate(c, DFlipFlop, xIr + 90, ROW2 + i * 26,
      { d, q: ir[i], clk: clkNet, nclk }, { tag: `ir${i}` });
  }
  c.region('Instruction register', xIr - 6, ROW2 - 6, xIr + 160, ROW2 + 7 * 26 + 24);

  const xDec = xIr + 190;
  const dbind = {};
  for (let i = 0; i < 8; i++) dbind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, ROW2, dbind, { tag: 'dec' });
  c.region('Instruction decoder', xDec - 6, ROW2 - 6, xDec + dec.w + 4, ROW2 + dec.h + 6);

  // ── the datapath ───────────────────────────────────────────────────────
  const ROW3 = ROW2 + 680;
  const accQ = [c.net(), c.net(), c.net(), c.net()];
  const accZero = c.net(), carryQ = c.net();

  // The condition tree. It reads the mask straight out of the instruction
  // and the flags straight out of the datapath, and answers one question:
  // does this jump take?
  const condTake = c.net();
  const xCond = 40;
  instantiate(c, ConditionTree, xCond, ROW3, {
    m0: ir[0], m1: ir[1], m2: ir[2], m3: ir[3],
    accZero, carry: carryQ, test, take: condTake,
  }, { tag: 'cond' });
  c.region('Condition tree',
    xCond - 6, ROW3 - 6, xCond + 180, ROW3 + 70);

  const xCtrl = xDec + dec.w + 40;
  const ctrl = instantiate(c, ControlUnit, xCtrl, ROW2, {
    pFetch: ring.nets.p0, pDecode: ring.nets.p1, pExec: ring.nets.p2,
    twoByte: dec.nets.twoByte,
    opJUN: dec.nets.op4, opLDM: dec.nets.op13,
    opXCH: dec.nets.op11, opINC: dec.nets.op6,
    opADD: dec.nets.op8, opJCN: dec.nets.op1, condTake,
  }, { tag: 'ctrl' });
  c.region('Control unit', xCtrl - 6, ROW2 - 6, xCtrl + ctrl.w + 6, ROW2 + ctrl.h + 6);

  const jn = c.net();
  instantiate(c, Inverter, xCtrl + 20, ROW2 + ctrl.h + 20,
    { a: ctrl.nets.pcLoad, y: jn }, { tag: 'jn' });
  instantiate(c, Inverter, xCtrl + 40, ROW2 + ctrl.h + 20,
    { a: jn, y: pcLoadLine }, { tag: 'jp' });
  for (let i = 0; i < 3; i++) {
    const t = c.net();
    instantiate(c, Inverter, xCtrl + 20, ROW2 + ctrl.h + 44 + i * 24,
      { a: ir[i], y: t }, { tag: `jt${i}n` });
    instantiate(c, Inverter, xCtrl + 40, ROW2 + ctrl.h + 44 + i * 24,
      { a: t, y: jumpTarget[i] }, { tag: `jt${i}` });
  }

  const xRf = xCond + 200;
  const rf = instantiate(c, RegFile16x4, xRf, ROW3, {
    wa0: ir[0], wa1: ir[1], wa2: ir[2], wa3: ir[3],
    ra0: ir[0], ra1: ir[1], ra2: ir[2], ra3: ir[3],
    d0: accQ[0], d1: accQ[1], d2: accQ[2], d3: accQ[3],
    we: ctrl.nets.regWrite,
  }, { tag: 'rf' });
  c.region('Register file', xRf - 6, ROW3 - 6, xRf + rf.w + 4, ROW3 + rf.h + 6,
    { side: 'left' });

  const xAdd = xRf + rf.w + 50;
  const adder = instantiate(c, rippleAdder(4), xAdd, ROW3, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3],
    b0: rf.nets.q0, b1: rf.nets.q1, b2: rf.nets.q2, b3: rf.nets.q3,
    cin: VSS,
  }, { tag: 'add' });
  c.region('Adder', xAdd - 6, ROW3 - 6, xAdd + adder.w + 6, ROW3 + adder.h + 6);

  const xCf = xAdd + adder.w + 40;
  const cf = instantiate(c, register(1), xCf, ROW3, {
    clk: clkNet, nclk, load: ctrl.nets.accFromAlu, d0: adder.nets.cout,
    q0: carryQ,
  }, { tag: 'cf' });
  c.region('Carry flag', xCf - 6, ROW3 - 6, xCf + 70, ROW3 + 60);

  const xMux = xCf + 90;
  const accD = [];
  for (let i = 0; i < 4; i++) {
    // This machine has the three-phase control unit, whose accumulator
    // has exactly two sources — so the immediate select is still derived
    // here as "not from the ALU". The four-phase machines take an explicit
    // accFromImm from their control unit instead, because once there are
    // more than two sources, "whatever nobody else selected" stops being
    // a definition.
    const fromAlu = c.net(), fromImm = c.net(), d = c.net(), nSel = c.net();
    instantiate(c, Inverter, xMux, ROW3 + i * 40 + 20,
      { a: ctrl.nets.accFromAlu, y: nSel }, { tag: `mxn${i}` });
    instantiate(c, And2, xMux + 20, ROW3 + i * 40,
      { a: adder.nets[`s${i}`], b: ctrl.nets.accFromAlu, y: fromAlu }, { tag: `mxa${i}` });
    instantiate(c, And2, xMux + 20, ROW3 + i * 40 + 22,
      { a: ir[i], b: nSel, y: fromImm }, { tag: `mxi${i}` });
    instantiate(c, Or2, xMux + 50, ROW3 + i * 40,
      { a: fromAlu, b: fromImm, y: d }, { tag: `mxo${i}` });
    accD.push(d);
  }
  c.region('Source mux', xMux - 6, ROW3 - 6, xMux + 90, ROW3 + 4 * 40);

  const xAcc = xMux + 110;
  instantiate(c, register(4), xAcc, ROW3, {
    clk: clkNet, nclk, load: ctrl.nets.accLoad,
    d0: accD[0], d1: accD[1], d2: accD[2], d3: accD[3],
    q0: accQ[0], q1: accQ[1], q2: accQ[2], q3: accQ[3],
  }, { tag: 'acc' });
  c.region('Accumulator', xAcc - 6, ROW3 - 6, xAcc + 140, ROW3 + 90);

  // the zero flag is computed, not stored — the accumulator changes for
  // reasons other than a comparison, so this has to follow it continuously
  const xZ = xAcc + 160;
  instantiate(c, IsZero4, xZ, ROW3, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3], z: accZero,
  }, { tag: 'zero' });
  c.region('Zero detect', xZ - 6, ROW3 - 6, xZ + 90, ROW3 + 50);

  const b = c.bounds();
  const xEnd = b.x1 + 10;
  const yTop = -16, yBot = b.y1 + 8;
  w(c, VDD, [0, yTop], [xEnd, yTop]);
  w(c, VSS, [0, yBot], [xEnd, yBot]);
  c.label('+V', -1.6, yTop, 1.1, '#ffb340');
  c.label('GND', -2.4, yBot, 1.1, '#7f8aa3');
  for (const sw of c.switches) {
    const t = switchSpdtT(sw);
    w(c, VDD, [2.4, yTop], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
    w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
  }

  for (let i = 0; i < 3; i++) {
    c.addLamp(`P${i}`, ring.nets[`p${i}`], xEnd - 5, 4 + i * 4.5, { short: `P${i}` });
  }
  for (let i = 0; i < 3; i++) {
    c.addLamp(`PC${i}`, PC.nets[`q${i}`], xEnd - 5, 20 + i * 4.5, { short: `PC${i}` });
  }
  for (let i = 0; i < 8; i++) {
    c.addLamp(`IR${i}`, ir[i], xEnd - 5, 36 + i * 4.5, { short: `IR${i}` });
  }
  for (let i = 0; i < 4; i++) {
    c.addLamp(`ACC${i}`, accQ[i], xEnd - 5, 76 + i * 4.5, { short: `ACC${i}` });
  }
  c.addLamp('ZERO', accZero, xEnd - 5, 98, { short: 'Z' });
  c.addLamp('CARRY', carryQ, xEnd - 5, 103, { short: 'CY' });
  c.addLamp('TAKE', condTake, xEnd - 5, 108, { short: 'TK' });

  // The fetch loop, at block level: the counter picks a word, the array
  // hands back a byte, the register holds it, the decoder reads it.
  c.flow('Program counter', 'ROM row decode', { label: 'address' });
  c.flow('ROM row decode', 'ROM array');
  c.flow('ROM array', 'ROM output buffers', { dir: 'v' });
  c.flow('ROM output buffers', 'Instruction register', { label: 'byte' });
  c.flow('Instruction register', 'Instruction decoder', { label: 'opcode' });
  // The conditional machine's addition is the loop back through the
  // condition tree: the accumulator's state decides whether the jump is
  // taken, and the control unit loads the counter when it is.
  c.flow('Instruction decoder', 'Control unit', { label: 'which' });
  c.flow('Phase ring', 'Control unit', { label: 'when' });
  c.flow('Register file', 'Adder', { label: 'operand' });
  c.flow('Adder', 'Source mux', { label: 'sum' });
  c.flow('Source mux', 'Accumulator');
  c.flow('Accumulator', 'Zero detect');
  c.flow('Zero detect', 'Condition tree', { label: 'is zero' });
  c.flow('Carry flag', 'Condition tree', { label: 'carry' });
  c.flow('Condition tree', 'Control unit', { label: 'take?' });
  c.flow('Control unit', 'Program counter', { label: 'jump' });

  c.decoded = Array.from({ length: 16 }, (_, i) => dec.nets[`op${i}`]);
  c.phases = [ring.nets.p0, ring.nets.p1, ring.nets.p2];
  c.control = {
    pcLoad: ctrl.nets.pcLoad, accLoad: ctrl.nets.accLoad,
    accFromAlu: ctrl.nets.accFromAlu, regWrite: ctrl.nets.regWrite,
    condTake,
  };
  c.program = program;
  // The address the instruction register was loaded from — which is the
  // instruction actually executing, not the one being fetched. The PC has
  // already advanced past it by the time its effect is visible, so this is
  // what the program listing should highlight. Found by matching the
  // register's contents against the ROM: unambiguous while a program has
  // no repeated bytes, and honest about it when it does.
  c.execAddr = () => {
    let ir = 0;
    for (let i = 0; i < 8; i++) {
      if (c.value[c.lamps.find(l => (l.short ?? l.label) === `IR${i}`).net] === 1) {
        ir |= 1 << i;
      }
    }
    let pc = 0;
    for (let i = 0; i < 3; i++) {
      if (c.value[c.lamps.find(l => (l.short ?? l.label) === `PC${i}`).net] === 1) {
        pc |= 1 << i;
      }
    }
    // the instruction in the register came from the address before the PC
    const back = (pc - 1 + c.program.length) % c.program.length;
    return c.program[back] === ir ? back : c.program.indexOf(ir);
  };
  return c;
}


// Two-byte fetch: the jump target stops being welded to the opcode.
//
// Every machine before this read a jump's target out of the low bits of
// the jump instruction itself, because it had nowhere else to get one.
// That is why the Conditional Machine's `JCN 12` means "jump if not zero"
// AND "jump to 4" inseparably — the condition mask and the target are the
// same four bits.
//
// A real 4004 instruction that needs an address carries a second byte, and
// the machine fetches it in an extra phase before executing. So the cycle
// grows one:
//
//   FETCH   capture the opcode
//   DECODE  the decoder settles
//   FETCH2  a two-byte instruction captures its operand here, and the PC
//           steps over it; a one-byte instruction passes through idle
//   EXEC    act
//
// The PC advancing twice is the structural part. Without it the operand
// byte is the next thing fetched, and the machine executes an address as
// though it were an instruction — which is exactly what the three-phase
// machines do, visible in their listings as a NOP that is really an
// operand.
//
// Now the mask and the target are independent, which is what lets this
// program use `JCN 13` — a mask that would have been unusable when the
// low nibble also had to be an address.
//
// Mask 13 is 1101: test zero, test the TEST pin, invert. So the loop
// continues while the accumulator is non-zero AND the TEST pin is high,
// and pulling TEST low breaks out of it early. That is what the pin was
// for on the real chip — an external input a program could poll without
// an interrupt — and it is only demonstrable once a condition mask stops
// doubling as a jump address.
// A subroutine call and return, which is what the address stack is for.
//
//   LDM 1     something in the accumulator to lose
//   JMS 5     push the return address (3) and jump to the subroutine
//   LDM 7     the subroutine's work
//   BBL 9     pop the return address, and load 9 on the way out
//   JUN 0     start again
//
// Watch the accumulator across BBL. It holds 7 inside the subroutine and
// 9 on return, because BBL loads its own immediate — so a subroutine
// cannot hand a result back in the accumulator. The return instruction
// overwrites it. That is not a limitation of this build; it is what BBL
// does, and it is why 4004 subroutines return values in registers.
const P4_PROGRAM = [
  0xD1,   // 0  LDM 1
  0x50,   // 1  JMS ────┐  push 3, jump to the subroutine
  0x05,   // 2     to 5 ─┘
  0x40,   // 3  JUN ────┐  the return lands here
  0x00,   // 4     to 0 ─┘
  0xD7,   // 5  LDM 7      the subroutine
  0xC9,   // 6  BBL 9      pop and return, loading 9
  0x00,   // 7  NOP
];

// The accumulator group: thirteen instructions sharing one opcode.
//
// Every machine so far has moved values around — load an immediate, add a
// register, jump. This one is about the accumulator *itself*, and the
// program picks the four instructions that are hardest to believe without
// watching: the BCD adjust, the two carry-to-accumulator transfers, and
// the keyboard decoder.
//
//   LDM 8   ACC = 8, CY = 0    a BCD digit, as if a sum had landed here
//   STC     ACC = 8, CY = 1    pretend the previous digit carried
//   DAA     ACC = 14, CY = 1   carry set, so add 6 — and DAA can SET the
//                              carry but never resets it, which is why it
//                              is still 1 here
//   TCC     ACC = 1, CY = 0    the carry becomes the accumulator, and is
//                              then cleared: one instruction to turn a
//                              flag into a number
//   LDM 4   ACC = 4, CY = 0    0100 — one key down, the third one
//   KBP     ACC = 3, CY = 0    1-of-n to binary, by table: 0100 → 3
//   TCS     ACC = 9, CY = 0    carry is 0, so 9 (10 if it were set) —
//                              the BCD ten's-complement constant
//   RAR     ACC = 4, CY = 1    rotate right through carry: 1001 shifts
//                              down to 0100 and the old bit 0 becomes
//                              the new carry
//
// Then the PC wraps to 0 and LDM 8 starts it again, so the loop is the
// whole eight-byte ROM with no jump instruction in it. The second pass
// differs from the first, and deliberately: it begins with the carry left
// set by RAR, so DAA's "carry already set" path is what runs.
//
// RAR is the one worth watching bit by bit. A rotate that dropped the
// bottom bit would lose information; routing it through the carry makes
// the accumulator and carry one 5-bit ring, which is how the 4004 does
// multi-nibble shifts on a 4-bit machine.
const PACC_PROGRAM = [
  0xD8,   // 0  LDM 8      a BCD digit, as if a sum had just landed here
  0xFA,   // 1  STC        pretend the previous digit carried
  0xFB,   // 2  DAA        carry set → add 6 → 14, carry stays set
  0xF7,   // 3  TCC        ACC = the carry (1), then carry cleared
  0xD4,   // 4  LDM 4      0100 — one key pressed, the third one
  0xFC,   // 5  KBP        1-of-n → binary: 0100 → 3
  0xF9,   // 6  TCS        carry is 0, so ACC = 9; carry cleared
  0xF6,   // 7  RAR        rotate right through carry, and the PC wraps
];

function buildTwoByteMachine() {
  const c = new Circuit('Two-Byte Machine');
  c.implicitGround = false;

  const clkNet = c.net(), nclk = c.net(), rst = c.net(), test = c.net();
  const clkSw = c.addSwitch('CLK', clkNet, 'toggle', 4, 6, { to: VSS });
  c.addSwitch('RST', rst, 'toggle', 4, 11, { to: VSS });
  c.addSwitch('TEST', test, 'toggle', 4, 16, { to: VSS });
  c.addClock(clkSw, { period: 1200 });
  instantiate(c, Inverter, 20, 44, { a: clkNet, y: nclk });

  const ROW2 = 150;
  // four phases now, not three
  const ring = instantiate(c, ringCounter(4), 40, 0,
    { clk: clkNet, nclk, rst }, { tag: 'ring' });
  c.region('Phase ring',
    36, -6, 40 + ring.w + 4, ring.h + 6);

  const nFetch = c.net();
  instantiate(c, Inverter, 40, ROW2 - 40, { a: ring.nets.p0, y: nFetch });

  // Allocated here and driven from the control unit below: the PC is built
  // before the control unit exists, and nets are the wiring, so binding
  // order does not matter.
  const pcLoadLine = c.net();
  const pcEnable = c.net();
  const jumpTarget = [c.net(), c.net(), c.net()];
  // Driven by the incrementer's zero-detect far below; declared here
  // because the control unit is built first and nets are only wiring.
  const iszTake = c.net();
  const PC = instantiate(c, programCounter(3), 40, ROW2, {
    clk: clkNet, nclk, en: pcEnable, rst, load: pcLoadLine,
    a0: jumpTarget[0], a1: jumpTarget[1], a2: jumpTarget[2],
  }, { tag: 'pc' });
  c.region('Program counter', 36, ROW2 - 6, 40 + PC.w + 4, ROW2 + PC.h + 6);

  const xRom = 40 + PC.w + 30;
  const Rom = romArray(P4_PROGRAM, 8, 3);
  const rom = instantiate(c, Rom, xRom, ROW2,
    { a0: PC.nets.q0, a1: PC.nets.q1, a2: PC.nets.q2 }, { tag: 'rom' });

  // The instruction register: opcode only, captured during FETCH.
  const xIr = xRom + rom.w + 30;
  const ir = [];
  for (let i = 0; i < 8; i++) {
    ir.push(c.net());
    const keep = c.net(), take = c.net(), d = c.net();
    instantiate(c, And2, xIr, ROW2 + i * 26,
      { a: rom.nets[`d${i}`], b: ring.nets.p0, y: take }, { tag: `irt${i}` });
    instantiate(c, And2, xIr, ROW2 + i * 26 + 13,
      { a: ir[i], b: nFetch, y: keep }, { tag: `irk${i}` });
    instantiate(c, Or2, xIr + 42, ROW2 + i * 26,
      { a: take, b: keep, y: d }, { tag: `irm${i}` });
    instantiate(c, DFlipFlop, xIr + 90, ROW2 + i * 26,
      { d, q: ir[i], clk: clkNet, nclk }, { tag: `ir${i}` });
  }
  c.region('Instruction register',
    xIr - 6, ROW2 - 6, xIr + 160, ROW2 + 7 * 26 + 24);

  const xDec = xIr + 190;
  const dbind = {};
  for (let i = 0; i < 8; i++) dbind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, ROW2, dbind, { tag: 'dec' });
  c.region('Instruction decoder', xDec - 6, ROW2 - 6, xDec + dec.w + 4, ROW2 + dec.h + 6);

  const ROW3 = ROW2 + 680;
  const accQ = [c.net(), c.net(), c.net(), c.net()];
  const accZero = c.net(), carryQ = c.net();
  const condTake = c.net();
  instantiate(c, ConditionTree, 40, ROW3, {
    m0: ir[0], m1: ir[1], m2: ir[2], m3: ir[3],
    accZero, carry: carryQ, test, take: condTake,
  }, { tag: 'cond' });
  c.region('Condition tree', 34, ROW3 - 6, 220, ROW3 + 70);

  const xCtrl = xDec + dec.w + 40;
  const ctrl = instantiate(c, ControlUnit4, xCtrl, ROW2, {
    pFetch: ring.nets.p0, pDecode: ring.nets.p1,
    pFetch2: ring.nets.p2, pExec: ring.nets.p3,
    twoByte: dec.nets.twoByte,
    opJUN: dec.nets.op4, opJCN: dec.nets.op1, opLDM: dec.nets.op13,
    opADD: dec.nets.op8, opXCH: dec.nets.op11, opINC: dec.nets.op6,
    condTake,
    // No accumulator-group, SUB or LD here, and no path from the register
    // file back to the accumulator — so XCH stays a one-way write. Tied
    // low deliberately rather than left floating.
    accGroup: VSS, opSUB: VSS, opLD: VSS, opXCHread: VSS,
    opISZ: dec.nets.op7, iszTake,
    opJMS: dec.nets.op5, opBBL: dec.nets.op12,
  }, { tag: 'ctrl' });
  c.region('Control unit',
    xCtrl - 6, ROW2 - 6, xCtrl + ctrl.w + 6, ROW2 + ctrl.h + 6);

  // The PC's enable comes from the control unit: it advances on FETCH, and
  // again on FETCH2 when there is an operand to step over. Buffered
  // through a pair so the counter is driven by a gate rather than loading
  // the control unit's output.
  const pcEnN = c.net();
  instantiate(c, Inverter, xCtrl, ROW2 + ctrl.h + 8,
    { a: ctrl.nets.pcInc, y: pcEnN }, { tag: 'pen' });
  instantiate(c, Inverter, xCtrl + 20, ROW2 + ctrl.h + 8,
    { a: pcEnN, y: pcEnable }, { tag: 'pen2' });

  // The operand register: the second byte, captured during FETCH2. Its low
  // three bits are the jump target — and unlike every machine before, they
  // are a *different byte* from the opcode, so a condition mask and an
  // address no longer share four bits.
  const xOpr = xCtrl + ctrl.w + 40;
  const opr = instantiate(c, register(4), xOpr, ROW2, {
    clk: clkNet, nclk, load: ctrl.nets.oprLoad,
    d0: rom.nets.d0, d1: rom.nets.d1, d2: rom.nets.d2, d3: rom.nets.d3,
  }, { tag: 'opr' });
  c.region('Operand register',
    xOpr - 6, ROW2 - 6, xOpr + 150, ROW2 + 90);

  // The address stack — three registers on a cylinder, per section 2.4 of
  // the manual. JMS pushes the PC (already stepped past the JMS and its
  // operand, so it is the return address); BBL pops it.
  const xStk = xOpr;
  const stack = instantiate(c, addressStack(3), xStk, ROW2 - 260, {
    clk: clkNet, nclk, rst,
    push: ctrl.nets.stackPush, pop: ctrl.nets.stackPop,
    d0: PC.nets.q0, d1: PC.nets.q1, d2: PC.nets.q2,
  }, { tag: 'stk' });
  c.region('Address stack',
    xStk - 6, ROW2 - 266, xStk + stack.w + 10, ROW2 - 260 + stack.h + 10);

  // the jump target now comes from the operand, not the opcode
  const jn = c.net();
  instantiate(c, Inverter, xOpr + 20, ROW2 + 100,
    { a: ctrl.nets.pcLoad, y: jn }, { tag: 'jn' });
  instantiate(c, Inverter, xOpr + 40, ROW2 + 100,
    { a: jn, y: pcLoadLine }, { tag: 'jp' });
  // The jump target: the operand byte for JUN/JCN/JMS/ISZ, or the stack's
  // return address for BBL. One mux, because from the program counter's
  // point of view a return is just a jump to an address it did not have
  // to fetch.
  for (let i = 0; i < 3; i++) {
    const fo = c.net(), fs = c.net(), nb = c.net();
    instantiate(c, Inverter, xOpr + 20, ROW2 + 124 + i * 24,
      { a: dec.nets.op12, y: nb }, { tag: `jt${i}n` });
    instantiate(c, And2, xOpr + 44, ROW2 + 124 + i * 24,
      { a: opr.nets[`q${i}`], b: nb, y: fo }, { tag: `jto${i}` });
    instantiate(c, And2, xOpr + 44, ROW2 + 136 + i * 24,
      { a: stack.nets[`q${i}`], b: dec.nets.op12, y: fs }, { tag: `jts${i}` });
    instantiate(c, Or2, xOpr + 74, ROW2 + 124 + i * 24,
      { a: fo, b: fs, y: jumpTarget[i] }, { tag: `jt${i}` });
  }

  // The register file's write data is a two-way choice: the accumulator
  // for XCH, or the incremented register for INC and ISZ. Declared here
  // and driven below, because the incrementer reads the file's own output.
  const regD = [c.net(), c.net(), c.net(), c.net()];

  const xRf = 260;
  const regWriteGated = c.net();
  instantiate(c, And2, xRf, ROW3 - 40,
    { a: ctrl.nets.regWrite, b: nclk, y: regWriteGated }, { tag: 'wegate' });

  const rf = instantiate(c, RegFile16x4, xRf, ROW3, {
    wa0: ir[0], wa1: ir[1], wa2: ir[2], wa3: ir[3],
    ra0: ir[0], ra1: ir[1], ra2: ir[2], ra3: ir[3],
    d0: regD[0], d1: regD[1], d2: regD[2], d3: regD[3],
    // Gated by the clock's low half, so the read the incrementer depends
    // on happens before the write lands — the same φ2 discipline XCH
    // needs, and for the same reason: this file reads and writes one row
    // in a single instruction.
    we: regWriteGated,
  }, { tag: 'rf' });
  c.region('Register file', xRf - 6, ROW3 - 6, xRf + rf.w + 4, ROW3 + rf.h + 6,
    { side: 'left' });

  // The incrementer: its own block, as on the chip. Sheet 1 of Intel's
  // schematic is titled "ADDRESS REGISTER, INCREMENTER AND INDEX" and
  // draws it separately from the adder — adding 1 is a half-adder chain,
  // much cheaper than routing through the full adder.
  //
  // It reads a *latched* copy of the register, not the file's live read
  // bus, and that is not a detail. The register file's cells are
  // transparent while written, so wiring the incrementer straight to the
  // read bus closes a combinational loop: read → increment → write →
  // read. It does not increment once, it free-runs until the latch shuts,
  // landing on whatever value it happened to reach. The symptom is a
  // register that advances by an irregular amount each instruction —
  // 13, 2, 11, 3, 9 — which reads like a decode bug and is a topology one.
  //
  // The same φ1/φ2 discipline that makes XCH a real exchange fixes it:
  // capture the register on the clock's high half, increment the capture,
  // write the result back on the low half. The chip's address register
  // plays exactly this role for the program counter's incrementer.
  const xInc = xRf + 40;
  const incHold = instantiate(c, register(4), xInc, ROW3 - 300, {
    clk: nclk, nclk: clkNet, load: VDD,
    d0: rf.nets.q0, d1: rf.nets.q1, d2: rf.nets.q2, d3: rf.nets.q3,
  }, { tag: 'ihold' });
  c.region('Increment hold',
    xInc - 6, ROW3 - 306, xInc + 140, ROW3 - 220);

  const inc = instantiate(c, Incrementer4, xInc, ROW3 - 210, {
    q0: incHold.nets.q0, q1: incHold.nets.q1,
    q2: incHold.nets.q2, q3: incHold.nets.q3,
  }, { tag: 'inc' });
  c.region('Incrementer',
    xInc - 6, ROW3 - 216, xInc + inc.w + 10, ROW3 - 210 + inc.h + 10);

  // Write-data mux: incremented register, or the accumulator.
  for (let i = 0; i < 4; i++) {
    const fi = c.net(), fa = c.net(), nsel = c.net();
    instantiate(c, Inverter, xInc + 120, ROW3 - 200 + i * 30,
      { a: ctrl.nets.regFromInc, y: nsel }, { tag: `rdn${i}` });
    instantiate(c, And2, xInc + 145, ROW3 - 200 + i * 30,
      { a: inc.nets[`s${i}`], b: ctrl.nets.regFromInc, y: fi },
      { tag: `rdi${i}` });
    instantiate(c, And2, xInc + 145, ROW3 - 188 + i * 30,
      { a: accQ[i], b: nsel, y: fa }, { tag: `rda${i}` });
    instantiate(c, Or2, xInc + 175, ROW3 - 200 + i * 30,
      { a: fi, b: fa, y: regD[i] }, { tag: `rdo${i}` });
  }
  c.region('Register write mux',
    xInc + 114, ROW3 - 206, xInc + 215, ROW3 - 200 + 4 * 30);

  // ISZ jumps when the incremented value is NOT zero — the name describes
  // the fall-through, not the branch. Zero-detect on the incrementer's
  // output, inverted.
  const incZero = c.net();
  instantiate(c, IsZero4, xInc + 240, ROW3 - 200, {
    a0: inc.nets.s0, a1: inc.nets.s1, a2: inc.nets.s2, a3: inc.nets.s3,
    z: incZero,
  }, { tag: 'incz' });
  instantiate(c, Inverter, xInc + 330, ROW3 - 200,
    { a: incZero, y: iszTake }, { tag: 'iszt' });
  c.region('ISZ condition',
    xInc + 234, ROW3 - 206, xInc + 350, ROW3 - 150);

  const xAdd = xRf + rf.w + 50;
  const adder = instantiate(c, rippleAdder(4), xAdd, ROW3, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3],
    b0: rf.nets.q0, b1: rf.nets.q1, b2: rf.nets.q2, b3: rf.nets.q3,
    cin: VSS,
  }, { tag: 'add' });
  c.region('Adder', xAdd - 6, ROW3 - 6, xAdd + adder.w + 6, ROW3 + adder.h + 6);

  const xCf = xAdd + adder.w + 40;
  const cf = instantiate(c, register(1), xCf, ROW3, {
    clk: clkNet, nclk, load: ctrl.nets.accFromAlu, d0: adder.nets.cout,
    q0: carryQ,
  }, { tag: 'cf' });
  c.region('Carry flag', xCf - 6, ROW3 - 6, xCf + 70, ROW3 + 60);

  const xMux = xCf + 90;
  const accD = [];
  for (let i = 0; i < 4; i++) {
    // Three sources: the adder, LDM's immediate, and BBL's.
    //
    // BBL loading its own low nibble is the trap worth seeing — a
    // subroutine cannot return a value in the accumulator, because the
    // return instruction overwrites it on the way out. It takes the same
    // IR bits as LDM, so it is a separate select rather than separate
    // wiring.
    const fromAlu = c.net(), fromImm = c.net(), fromBbl = c.net();
    const o1 = c.net(), d = c.net(), nSel = c.net();
    instantiate(c, Inverter, xMux, ROW3 + i * 40 + 20,
      { a: ctrl.nets.accFromAlu, y: nSel }, { tag: `mxn${i}` });
    instantiate(c, And2, xMux + 20, ROW3 + i * 40,
      { a: adder.nets[`s${i}`], b: ctrl.nets.accFromAlu, y: fromAlu }, { tag: `mxa${i}` });
    instantiate(c, And2, xMux + 20, ROW3 + i * 40 + 22,
      { a: ir[i], b: nSel, y: fromImm }, { tag: `mxi${i}` });
    instantiate(c, And2, xMux + 20, ROW3 + i * 40 + 34,
      { a: ir[i], b: ctrl.nets.accFromBbl, y: fromBbl }, { tag: `mxb${i}` });
    instantiate(c, Or2, xMux + 50, ROW3 + i * 40,
      { a: fromAlu, b: fromImm, y: o1 }, { tag: `mxo${i}` });
    instantiate(c, Or2, xMux + 76, ROW3 + i * 40,
      { a: o1, b: fromBbl, y: d }, { tag: `mxp${i}` });
    accD.push(d);
  }
  c.region('Source mux', xMux - 6, ROW3 - 6, xMux + 90, ROW3 + 4 * 40);

  const xAcc = xMux + 110;
  instantiate(c, register(4), xAcc, ROW3, {
    clk: clkNet, nclk, load: ctrl.nets.accLoad,
    d0: accD[0], d1: accD[1], d2: accD[2], d3: accD[3],
    q0: accQ[0], q1: accQ[1], q2: accQ[2], q3: accQ[3],
  }, { tag: 'acc' });
  c.region('Accumulator', xAcc - 6, ROW3 - 6, xAcc + 140, ROW3 + 90);

  const xZ = xAcc + 160;
  instantiate(c, IsZero4, xZ, ROW3, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3], z: accZero,
  }, { tag: 'zero' });
  c.region('Zero detect', xZ - 6, ROW3 - 6, xZ + 90, ROW3 + 50);

  const b = c.bounds();
  const xEnd = b.x1 + 10;
  const yTop = -16, yBot = b.y1 + 8;
  w(c, VDD, [0, yTop], [xEnd, yTop]);
  w(c, VSS, [0, yBot], [xEnd, yBot]);
  c.label('+V', -1.6, yTop, 1.1, '#ffb340');
  c.label('GND', -2.4, yBot, 1.1, '#7f8aa3');
  for (const sw of c.switches) {
    const t = switchSpdtT(sw);
    w(c, VDD, [2.4, yTop], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
    w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
  }

  for (let i = 0; i < 4; i++) {
    c.addLamp(`P${i}`, ring.nets[`p${i}`], xEnd - 5, 4 + i * 4.5, { short: `P${i}` });
  }
  for (let i = 0; i < 3; i++) {
    c.addLamp(`PC${i}`, PC.nets[`q${i}`], xEnd - 5, 26 + i * 4.5, { short: `PC${i}` });
  }
  for (let i = 0; i < 8; i++) {
    c.addLamp(`IR${i}`, ir[i], xEnd - 5, 42 + i * 4.5, { short: `IR${i}` });
  }
  for (let i = 0; i < 4; i++) {
    c.addLamp(`OPR${i}`, opr.nets[`q${i}`], xEnd - 5, 82 + i * 4.5, { short: `OPR${i}` });
  }
  for (let i = 0; i < 4; i++) {
    c.addLamp(`ACC${i}`, accQ[i], xEnd - 5, 104 + i * 4.5, { short: `ACC${i}` });
  }
  c.addLamp('ZERO', accZero, xEnd - 5, 126, { short: 'Z' });
  c.addLamp('TAKE', condTake, xEnd - 5, 131, { short: 'TK' });

  c.cells = rf.stored;
  // The fetch loop, at block level: the counter picks a word, the array
  // hands back a byte, the register holds it, the decoder reads it.
  c.flow('Program counter', 'ROM row decode', { label: 'address' });
  c.flow('ROM row decode', 'ROM array');
  c.flow('ROM array', 'ROM output buffers', { dir: 'v' });
  c.flow('ROM output buffers', 'Instruction register', { label: 'byte' });
  c.flow('Instruction register', 'Instruction decoder', { label: 'opcode' });
  // Two bytes and a stack. The operand register holds the second byte, the
  // incrementer serves INC and ISZ, and the address stack remembers where
  // a JMS came from.
  c.flow('Instruction decoder', 'Control unit', { label: 'which' });
  c.flow('Phase ring', 'Control unit', { label: 'when' });
  c.flow('ROM output buffers', 'Operand register', { label: 'byte 2' });
  c.flow('Register file', 'Incrementer', { label: 'register' });
  c.flow('Incrementer', 'Register write mux');
  c.flow('Register write mux', 'Register file', { label: 'write back' });
  c.flow('Incrementer', 'ISZ condition', { label: 'result' });
  c.flow('ISZ condition', 'Control unit', { label: 'not zero?' });
  c.flow('Program counter', 'Address stack', { label: 'return addr' });
  c.flow('Address stack', 'Program counter', { label: 'pop' });
  c.flow('Operand register', 'Program counter', { label: 'target' });

  c.decoded = Array.from({ length: 16 }, (_, i) => dec.nets[`op${i}`]);
  c.phases = [ring.nets.p0, ring.nets.p1, ring.nets.p2, ring.nets.p3];
  c.control = {
    pcInc: ctrl.nets.pcInc, pcLoad: ctrl.nets.pcLoad,
    irLoad: ctrl.nets.irLoad, oprLoad: ctrl.nets.oprLoad,
    accLoad: ctrl.nets.accLoad, regWrite: ctrl.nets.regWrite,
    stackPush: ctrl.nets.stackPush, stackPop: ctrl.nets.stackPop,
  };
  c.stackQ = [stack.nets.q0, stack.nets.q1, stack.nets.q2];
  c.stackP = [stack.nets.p0, stack.nets.p1, stack.nets.p2];
  c.jumpTarget = jumpTarget;
  c.program = P4_PROGRAM;
  c.execAddr = () => {
    let ir8 = 0;
    for (let i = 0; i < 8; i++) {
      if (c.value[c.lamps.find(l => (l.short ?? l.label) === `IR${i}`).net] === 1) {
        ir8 |= 1 << i;
      }
    }
    return c.program.indexOf(ir8);
  };
  return c;
}

// SUB, LD and a real XCH.
//
// All three need the same thing: a path *from* the register file back
// into the accumulator. Every machine before this one could only write
// registers, so its XCH lost half of itself.
//
//   LD r    ACC ← r
//   XCH r   ACC ↔ r, both directions in one instruction
//   SUB r   ACC ← ACC + ~r + ~carry
//
// SUB's carry convention is the part worth reading twice, and it is
// checked against the manual rather than assumed. On the way *in*, carry=1
// means a borrow happened. On the way *out*, carry=1 means no borrow
// happened. The sense flips across the instruction, which is why Intel's
// manual tells you to put a CMC between successive SUBs when chaining
// them across nibbles. Getting this wrong would still pass every
// single-digit test and fail only on multi-digit subtraction.
//
// XCH is the one that looks hard and is not. Both the accumulator and the
// register file are written on the same clock edge, and both read their
// sources combinationally before it — so the old accumulator reaches the
// register and the old register reaches the accumulator in the same
// instant, with no temporary anywhere. A swap needing a scratch register
// is a software problem, not a hardware one.
//
//   LDM 9 · XCH r0 · LDM 4 · XCH r1 · LD r0 · CLC · SUB r1 · XCH r2
//
// which computes 9 − 4 = 5 with carry 1 (no borrow), then parks the result
// in r2 and wraps. Watch the carry after SUB: it is *set*, which on this
// machine means the subtraction did not borrow.
const PSUB_PROGRAM = [
  0xD9,   // 0  LDM 9
  0xB0,   // 1  XCH r0     r0 = 9
  0xD4,   // 2  LDM 4
  0xB1,   // 3  XCH r1     r1 = 4
  0xA0,   // 4  LD r0      ACC = 9
  0xF1,   // 5  CLC        no borrow in
  0x91,   // 6  SUB r1     ACC = 9 − 4 = 5, carry 1 = no borrow
  0xB2,   // 7  XCH r2     store the result in r2, and the PC wraps
];
// A note on testing this, learned the hard way. An earlier version of
// this program exercised XCH against a register that already held the
// accumulator's value. Swap, one-way write and no-op all produce
// identical output in that case, so the test passed while proving
// nothing. Any future test of a real XCH has to use two *different*
// values, or it is not testing anything.

// The accumulator group in hardware.
//
// Structurally this is the two-byte machine with its datapath opened up.
// Everything before it could write the accumulator from exactly two
// places — an immediate or the adder. The accumulator group needs four
// more sources, and the interesting part is how few gates that costs:
//
//   the adder     IAC, DAC, TCS — all of them are ACC + something, and
//                 AccOperand picks the something
//   complement    CMA — four inverters
//   rotate left   RAL — a wire shift with the carry spliced in at bit 0
//   rotate right  RAR — the same wires read the other way
//   zero          CLB — drive nothing and let the mux default low
//
// Only the first needs arithmetic. The rest are wiring, which is the
// lesson: an instruction set grows much faster than the silicon under it
// when the instructions are chosen to reuse what is already there.
function buildAccGroupMachine() {
  const c = new Circuit('Accumulator Group');
  c.implicitGround = false;

  const clkNet = c.net(), nclk = c.net(), rst = c.net();
  const clkSw = c.addSwitch('CLK', clkNet, 'toggle', 4, 6, { to: VSS });
  c.addSwitch('RST', rst, 'toggle', 4, 11, { to: VSS });
  c.addClock(clkSw, { period: 1200 });
  instantiate(c, Inverter, 20, 44, { a: clkNet, y: nclk });

  const ROW2 = 150;
  const ring = instantiate(c, ringCounter(4), 40, 0,
    { clk: clkNet, nclk, rst }, { tag: 'ring' });
  c.region('Phase ring',
    36, -6, 40 + ring.w + 4, ring.h + 6);

  const nFetch = c.net();
  instantiate(c, Inverter, 40, ROW2 - 40, { a: ring.nets.p0, y: nFetch });

  const pcLoadLine = c.net(), pcEnable = c.net();
  const PC = instantiate(c, programCounter(3), 40, ROW2, {
    clk: clkNet, nclk, en: pcEnable, rst, load: pcLoadLine,
    a0: VSS, a1: VSS, a2: VSS,
  }, { tag: 'pc' });
  c.region('Program counter', 36, ROW2 - 6, 40 + PC.w + 4, ROW2 + PC.h + 6);

  const xRom = 40 + PC.w + 30;
  const Rom = romArray(PACC_PROGRAM, 8, 3);
  const rom = instantiate(c, Rom, xRom, ROW2,
    { a0: PC.nets.q0, a1: PC.nets.q1, a2: PC.nets.q2 }, { tag: 'rom' });

  const xIr = xRom + rom.w + 30;
  const ir = [];
  for (let i = 0; i < 8; i++) {
    ir.push(c.net());
    const keep = c.net(), take = c.net(), d = c.net();
    instantiate(c, And2, xIr, ROW2 + i * 26,
      { a: rom.nets[`d${i}`], b: ring.nets.p0, y: take }, { tag: `irt${i}` });
    instantiate(c, And2, xIr, ROW2 + i * 26 + 13,
      { a: ir[i], b: nFetch, y: keep }, { tag: `irk${i}` });
    instantiate(c, Or2, xIr + 42, ROW2 + i * 26,
      { a: take, b: keep, y: d }, { tag: `irm${i}` });
    instantiate(c, DFlipFlop, xIr + 90, ROW2 + i * 26,
      { d, q: ir[i], clk: clkNet, nclk }, { tag: `ir${i}` });
  }
  c.region('Instruction register',
    xIr - 6, ROW2 - 6, xIr + 160, ROW2 + 7 * 26 + 24);

  const xDec = xIr + 190;
  const dbind = {};
  for (let i = 0; i < 8; i++) dbind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, ROW2, dbind, { tag: 'dec' });
  c.region('Instruction decoder',
    xDec - 6, ROW2 - 6, xDec + dec.w + 4, ROW2 + dec.h + 6);

  // The thirteen accumulator lines, named. Reading `dec.nets.acc2` at every
  // use site would make this datapath unreadable; naming them once keeps
  // the wiring below saying what it means.
  const IAC = dec.nets.acc2, CMA = dec.nets.acc4, RAL = dec.nets.acc5;
  const RAR = dec.nets.acc6, DAC = dec.nets.acc8, CLB = dec.nets.acc0;
  const CLC = dec.nets.acc1, CMC = dec.nets.acc3, TCC = dec.nets.acc7;
  const STC = dec.nets.acc10, TCS = dec.nets.acc9;
  const DAA = dec.nets.acc11, KBP = dec.nets.acc12;

  const ROW3 = ROW2 + 680;
  const accQ = [c.net(), c.net(), c.net(), c.net()];
  const accZero = c.net(), carryQ = c.net();

  // Which of the group write the accumulator: the arithmetic three, the
  // complement, the two rotates, and CLB. The carry-only instructions
  // (CLC, STC, CMC, TCC) are deliberately absent — they leave the
  // accumulator alone, and telling the control unit otherwise would clock
  // a fresh value into it every time a program touched the carry.
  const accGroup = c.net();
  {
    const xg = xDec, yg = ROW2 - 120;
    const g = [];
    const or = (a, b, i) => {
      const y = c.net();
      instantiate(c, Or2, xg + i * 28, yg + (i % 2) * 26, { a, b, y },
        { tag: `ag${i}` });
      return y;
    };
    g.push(or(IAC, DAC, 0));
    g.push(or(TCS, CMA, 1));
    g.push(or(RAL, RAR, 2));
    g.push(or(CLB, TCC, 3));
    g.push(or(DAA, KBP, 4));
    const h1 = or(g[0], g[1], 5);
    const h2 = or(g[2], g[3], 6);
    const h3 = or(h1, h2, 7);
    instantiate(c, Or2, xg + 8 * 28, yg, { a: h3, b: g[4], y: accGroup },
      { tag: 'ag8' });
  }

  const xCtrl = xDec + dec.w + 40;
  const ctrl = instantiate(c, ControlUnit4, xCtrl, ROW2, {
    pFetch: ring.nets.p0, pDecode: ring.nets.p1,
    pFetch2: ring.nets.p2, pExec: ring.nets.p3,
    twoByte: dec.nets.twoByte,
    // This machine's program contains no jumps and no register
    // instructions, so those decoded lines are tied low rather than left
    // floating. An unbound control port reads Z and can fire a control
    // line — the failure that bit twice before, so every port is bound
    // deliberately even when the answer is "never".
    opJUN: VSS, opJCN: VSS, opADD: VSS, opXCH: VSS, opINC: VSS,
    opSUB: VSS, opLD: VSS, opXCHread: VSS, opISZ: VSS, iszTake: VSS,
    opJMS: VSS, opBBL: VSS,
    opLDM: dec.nets.op13,
    condTake: VSS, accGroup,
  }, { tag: 'ctrl' });
  c.region('Control unit',
    xCtrl - 6, ROW2 - 6, xCtrl + ctrl.w + 6, ROW2 + ctrl.h + 6);

  const pcEnN = c.net();
  instantiate(c, Inverter, xCtrl, ROW2 + ctrl.h + 8,
    { a: ctrl.nets.pcInc, y: pcEnN }, { tag: 'pen' });
  instantiate(c, Inverter, xCtrl + 20, ROW2 + ctrl.h + 8,
    { a: pcEnN, y: pcEnable }, { tag: 'pen2' });
  // no jumps in this program: the PC only ever counts
  instantiate(c, Inverter, xCtrl + 40, ROW2 + ctrl.h + 8,
    { a: VDD, y: pcLoadLine }, { tag: 'nold' });

  // The adder's second operand, from AccOperand rather than a register.
  const xOp = 40;
  const accOp = instantiate(c, AccOperand, xOp, ROW3, {
    opIAC: IAC, opDAC: DAC, opTCS: VSS,
  }, { tag: 'accop' });
  c.region('Adder operand',
    xOp - 6, ROW3 - 6, xOp + accOp.w + 20, ROW3 + accOp.h + 10);

  // DAA decides for itself whether to add 6, from the accumulator and the
  // carry — so it supplies its own constant rather than being another
  // line into AccOperand. Its `adjust` output is also what tells the
  // datapath to take the adder at all.
  const xDaa = xOp;
  const daa = instantiate(c, DecimalAdjust, xDaa, ROW3 + 130, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3], carry: carryQ,
  }, { tag: 'daa' });
  c.region('Decimal adjust',
    xDaa - 6, ROW3 + 124, xDaa + daa.w + 20, ROW3 + 130 + daa.h + 10);

  // The adder's B input: DAA's 6 when DAA is executing, otherwise the
  // constant AccOperand selected. One two-way mux per bit.
  const bIn = [];
  for (let i = 0; i < 4; i++) {
    const fd = c.net(), fa = c.net(), b = c.net(), nd = c.net();
    instantiate(c, Inverter, xOp + 120, ROW3 + 250 + i * 30,
      { a: DAA, y: nd }, { tag: `bn${i}` });
    instantiate(c, And2, xOp + 145, ROW3 + 250 + i * 30,
      { a: daa.nets[`b${i}`], b: DAA, y: fd }, { tag: `bd${i}` });
    instantiate(c, And2, xOp + 145, ROW3 + 262 + i * 30,
      { a: accOp.nets[`b${i}`], b: nd, y: fa }, { tag: `ba${i}` });
    instantiate(c, Or2, xOp + 175, ROW3 + 250 + i * 30,
      { a: fd, b: fa, y: b }, { tag: `bo${i}` });
    bIn.push(b);
  }
  c.region('Adder B mux',
    xOp + 114, ROW3 + 244, xOp + 215, ROW3 + 250 + 4 * 30);

  const xAdd = xOp + accOp.w + 60;
  const adder = instantiate(c, rippleAdder(4), xAdd, ROW3, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3],
    b0: bIn[0], b1: bIn[1], b2: bIn[2], b3: bIn[3],
    cin: VSS,
  }, { tag: 'add' });
  c.region('Adder', xAdd - 6, ROW3 - 6, xAdd + adder.w + 6, ROW3 + adder.h + 6);

  // Which instructions take the adder's result. Everything in the
  // arithmetic subset of the group; the rest steer elsewhere.
  // Which instructions take the adder's result: IAC and DAC add a
  // constant, and DAA adds 6 when it decides to. TCS is not here — it
  // writes a literal 9 or 10 rather than adding, which is what the
  // manual says and what makes it a mux term rather than an adder op.
  const useAdd = c.net();
  {
    const t = c.net();
    instantiate(c, Or2, xAdd, ROW3 + adder.h + 20,
      { a: IAC, b: DAC, y: t }, { tag: 'ua1' });
    instantiate(c, Or2, xAdd + 30, ROW3 + adder.h + 20,
      { a: t, b: DAA, y: useAdd }, { tag: 'ua2' });
  }

  // KBP's encoder. Its own block because it is a truth table rather than
  // arithmetic — see the note on KeyboardProcess.
  const kbp = instantiate(c, KeyboardProcess, xAdd + 260, ROW3 + 200, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3],
  }, { tag: 'kbp' });
  c.region('Keyboard process',
    xAdd + 254, ROW3 + 194, xAdd + 260 + kbp.w + 10, ROW3 + 200 + kbp.h + 10);

  // TCS writes a literal 9 (1001) or 10 (1010) depending on the carry —
  // no arithmetic, just two constants and the carry choosing between
  // them. Bit 0 is set when the carry is clear, bit 1 when it is set, and
  // bit 3 always: 1001 vs 1010.
  const ncarry = c.net();
  instantiate(c, Inverter, xAdd + 260, ROW3 + 380, { a: carryQ, y: ncarry },
    { tag: 'tcsn' });

  // The accumulator's source mux, now eight-way. Each source contributes
  // its bits ANDed with its own select line and the results are ORed —
  // the same shape as the two-source mux before it, just wider. CLB needs
  // no term at all: selecting nothing drives zero, which is what CLB
  // means, and TCC's zeroing of bits 1-3 works the same way.
  //
  // This row sits clear of everything hanging below ROW3 — the B mux
  // reaches 520 units past it and the decimal adjust 470, so the old 260
  // gap ran this row straight through both of them.
  const ROW4 = ROW3 + 560;
  const xMux = 40;
  const accD = [];
  for (let i = 0; i < 4; i++) {
    const y = ROW4 + i * 46;
    const fAdd = c.net(), fImm = c.net(), fCma = c.net();
    const fRal = c.net(), fRar = c.net();

    instantiate(c, And2, xMux, y,
      { a: adder.nets[`s${i}`], b: useAdd, y: fAdd }, { tag: `mxa${i}` });
    instantiate(c, And2, xMux, y + 10,
      { a: ir[i], b: ctrl.nets.accFromImm, y: fImm }, { tag: `mxi${i}` });

    // CMA: the complement of this bit
    const nAcc = c.net();
    instantiate(c, Inverter, xMux - 24, y + 20, { a: accQ[i], y: nAcc },
      { tag: `cman${i}` });
    instantiate(c, And2, xMux, y + 20,
      { a: nAcc, b: CMA, y: fCma }, { tag: `mxc${i}` });

    // RAL: this bit takes the one below it, and bit 0 takes the carry.
    // RAR: this bit takes the one above it, and bit 3 takes the carry.
    // The carry is what closes the ring, so the pair is lossless.
    const ralSrc = i === 0 ? carryQ : accQ[i - 1];
    const rarSrc = i === 3 ? carryQ : accQ[i + 1];
    instantiate(c, And2, xMux, y + 30,
      { a: ralSrc, b: RAL, y: fRal }, { tag: `mxl${i}` });
    instantiate(c, And2, xMux, y + 40,
      { a: rarSrc, b: RAR, y: fRar }, { tag: `mxr${i}` });

    // KBP: the encoder's output for this bit.
    const fKbp = c.net();
    instantiate(c, And2, xMux, y + 50,
      { a: kbp.nets[`y${i}`], b: KBP, y: fKbp }, { tag: `mxk${i}` });

    // TCC puts the carry in bit 0 and zero everywhere else — the manual
    // is explicit that the accumulator is cleared first and only A0 takes
    // the carry. Bits 1-3 contribute nothing, which is how they end zero.
    const fTcc = c.net();
    if (i === 0) {
      instantiate(c, And2, xMux, y + 60,
        { a: carryQ, b: TCC, y: fTcc }, { tag: `mxt${i}` });
    } else {
      instantiate(c, And2, xMux, y + 60,
        { a: VSS, b: TCC, y: fTcc }, { tag: `mxt${i}` });
    }

    // TCS: 9 (1001) when the carry is clear, 10 (1010) when it is set.
    const fTcs = c.net();
    const tcsBit = i === 0 ? ncarry : i === 1 ? carryQ : i === 3 ? VDD : VSS;
    instantiate(c, And2, xMux, y + 70,
      { a: tcsBit, b: TCS, y: fTcs }, { tag: `mxs${i}` });

    const o1 = c.net(), o2 = c.net(), o3 = c.net();
    const o4 = c.net(), o5 = c.net(), o6 = c.net(), d = c.net();
    instantiate(c, Or2, xMux + 40, y, { a: fAdd, b: fImm, y: o1 },
      { tag: `mo1${i}` });
    instantiate(c, Or2, xMux + 40, y + 14, { a: fCma, b: fRal, y: o2 },
      { tag: `mo2${i}` });
    instantiate(c, Or2, xMux + 40, y + 28, { a: fRar, b: fKbp, y: o3 },
      { tag: `mo3${i}` });
    instantiate(c, Or2, xMux + 40, y + 42, { a: fTcc, b: fTcs, y: o4 },
      { tag: `mo4${i}` });
    instantiate(c, Or2, xMux + 70, y, { a: o1, b: o2, y: o5 },
      { tag: `mo5${i}` });
    instantiate(c, Or2, xMux + 70, y + 28, { a: o3, b: o4, y: o6 },
      { tag: `mo6${i}` });
    instantiate(c, Or2, xMux + 100, y, { a: o5, b: o6, y: d },
      { tag: `mo7${i}` });
    accD.push(d);
  }
  c.region('Accumulator source mux',
    xMux - 30, ROW4 - 8, xMux + 140, ROW4 + 4 * 46);

  const xAcc = xMux + 170;
  instantiate(c, register(4), xAcc, ROW4, {
    clk: clkNet, nclk, load: ctrl.nets.accLoad,
    d0: accD[0], d1: accD[1], d2: accD[2], d3: accD[3],
    q0: accQ[0], q1: accQ[1], q2: accQ[2], q3: accQ[3],
  }, { tag: 'acc' });
  c.region('Accumulator', xAcc - 6, ROW4 - 6, xAcc + 140, ROW4 + 90);

  const xZ = xAcc + 160;
  instantiate(c, IsZero4, xZ, ROW4, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3], z: accZero,
  }, { tag: 'zero' });
  c.region('Zero detect', xZ - 6, ROW4 - 6, xZ + 90, ROW4 + 50);

  // The carry: its own little instruction set, plus the rotates and the
  // adder feeding it.
  const xCar = xZ + 120;
  // TCS clears the carry exactly as TCC does — the manual says "in either
  // case, the carry bit is then reset" — so it joins TCC on the same
  // input rather than needing a port of its own.
  const tccOrTcs = c.net();
  instantiate(c, Or2, xCar - 40, ROW4, { a: TCC, b: TCS, y: tccOrTcs },
    { tag: 'tcx' });
  const carry = instantiate(c, CarryLogic, xCar, ROW4, {
    carry: carryQ, opCLC: CLC, opSTC: STC, opCMC: CMC, opTCC: tccOrTcs,
  }, { tag: 'carry' });
  c.region('Carry logic',
    xCar - 6, ROW4 - 6, xCar + carry.w + 10, ROW4 + carry.h + 10);

  // What the carry loads, and when. A rotate writes the bit that fell off
  // the end; the arithmetic instructions write the adder's carry out; the
  // carry group writes its own answer.
  const carryD = c.net(), carryLoad = c.net();
  {
    const fRal = c.net(), fRar = c.net(), fAdd = c.net(), fOwn = c.net();
    // RAL pushes out bit 3, RAR pushes out bit 0
    instantiate(c, And2, xCar, ROW4 + 120,
      { a: accQ[3], b: RAL, y: fRal }, { tag: 'cyl' });
    instantiate(c, And2, xCar, ROW4 + 134,
      { a: accQ[0], b: RAR, y: fRar }, { tag: 'cyr' });
    instantiate(c, And2, xCar, ROW4 + 148,
      { a: adder.nets.cout, b: useAdd, y: fAdd }, { tag: 'cya' });
    instantiate(c, And2, xCar, ROW4 + 162,
      { a: carry.nets.d, b: carry.nets.sel, y: fOwn }, { tag: 'cyo' });
    const o1 = c.net(), o2 = c.net();
    instantiate(c, Or2, xCar + 40, ROW4 + 120, { a: fRal, b: fRar, y: o1 },
      { tag: 'cyo1' });
    instantiate(c, Or2, xCar + 40, ROW4 + 148, { a: fAdd, b: fOwn, y: o2 },
      { tag: 'cyo2' });
    instantiate(c, Or2, xCar + 70, ROW4 + 130, { a: o1, b: o2, y: carryD },
      { tag: 'cyo3' });

    // The carry is written whenever any of those owns it, gated by EXEC —
    // with one exception the manual is emphatic about.
    //
    // DAA may *set* the carry but must never clear it: "if the result of
    // incrementing the accumulator produces a carry out of the high order
    // bit position, the carry bit is set. Otherwise the carry bit is
    // unaffected (in particular, it is not reset)." So DAA's write is
    // gated by the adder's carry-out rather than firing every time, which
    // is what leaves the carry alone when 8 + 6 = 14 does not carry.
    //
    // Writing it unconditionally is the obvious implementation and it is
    // wrong in a way that only shows up in multi-digit BCD — the second
    // digit loses the carry the first one produced.
    const arith = c.net(), daaW = c.net();
    instantiate(c, Or2, xCar + 10, ROW4 + 176, { a: IAC, b: DAC, y: arith },
      { tag: 'cwa' });
    instantiate(c, And2, xCar + 10, ROW4 + 190,
      { a: DAA, b: adder.nets.cout, y: daaW }, { tag: 'cwd' });

    const w1 = c.net(), w2 = c.net(), w3 = c.net(), w4 = c.net(), any = c.net();
    instantiate(c, Or2, xCar + 40, ROW4 + 190, { a: RAL, b: RAR, y: w1 },
      { tag: 'cw1' });
    instantiate(c, Or2, xCar + 40, ROW4 + 204,
      { a: arith, b: carry.nets.sel, y: w2 }, { tag: 'cw2' });
    instantiate(c, Or2, xCar + 70, ROW4 + 204, { a: w2, b: daaW, y: w4 },
      { tag: 'cw2b' });
    instantiate(c, Or2, xCar + 70, ROW4 + 190, { a: w1, b: w4, y: w3 },
      { tag: 'cw3' });
    instantiate(c, And2, xCar + 100, ROW4 + 190,
      { a: w3, b: ring.nets.p3, y: any }, { tag: 'cw4' });
    // buffered through a pair, so the register's load input is driven by a
    // gate rather than loading the control logic
    const anyN = c.net();
    instantiate(c, Inverter, xCar + 130, ROW4 + 190, { a: any, y: anyN },
      { tag: 'cwn' });
    instantiate(c, Inverter, xCar + 150, ROW4 + 190,
      { a: anyN, y: carryLoad }, { tag: 'cwb' });
  }

  instantiate(c, register(1), xCar + 200, ROW4, {
    clk: clkNet, nclk, load: carryLoad, d0: carryD, q0: carryQ,
  }, { tag: 'cf' });
  c.region('Carry flag', xCar + 194, ROW4 - 6, xCar + 264, ROW4 + 60);

  const b = c.bounds();
  const xEnd = b.x1 + 10;
  const yTop = -16, yBot = b.y1 + 8;
  w(c, VDD, [0, yTop], [xEnd, yTop]);
  w(c, VSS, [0, yBot], [xEnd, yBot]);
  c.label('+V', -1.6, yTop, 1.1, '#ffb340');
  c.label('GND', -2.4, yBot, 1.1, '#7f8aa3');
  for (const sw of c.switches) {
    const t = switchSpdtT(sw);
    w(c, VDD, [2.4, yTop], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
    w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
  }

  for (let i = 0; i < 4; i++) {
    c.addLamp(`P${i}`, ring.nets[`p${i}`], xEnd - 5, 4 + i * 4.5, { short: `P${i}` });
  }
  for (let i = 0; i < 3; i++) {
    c.addLamp(`PC${i}`, PC.nets[`q${i}`], xEnd - 5, 26 + i * 4.5, { short: `PC${i}` });
  }
  for (let i = 0; i < 8; i++) {
    c.addLamp(`IR${i}`, ir[i], xEnd - 5, 42 + i * 4.5, { short: `IR${i}` });
  }
  for (let i = 0; i < 4; i++) {
    c.addLamp(`ACC${i}`, accQ[i], xEnd - 5, 82 + i * 4.5, { short: `ACC${i}` });
  }
  c.addLamp('CY', carryQ, xEnd - 5, 104, { short: 'CY' });
  c.addLamp('ZERO', accZero, xEnd - 5, 109, { short: 'Z' });

  // The fetch loop, at block level: the counter picks a word, the array
  // hands back a byte, the register holds it, the decoder reads it.
  c.flow('Program counter', 'ROM row decode', { label: 'address' });
  c.flow('ROM row decode', 'ROM array');
  c.flow('ROM array', 'ROM output buffers', { dir: 'v' });
  c.flow('ROM output buffers', 'Instruction register', { label: 'byte' });
  c.flow('Instruction register', 'Instruction decoder', { label: 'opcode' });
  // Thirteen instructions behind one opcode, all of them steering the
  // accumulator's source mux rather than adding new arithmetic.
  c.flow('Instruction decoder', 'Control unit', { label: 'which' });
  c.flow('Phase ring', 'Control unit', { label: 'when' });
  c.flow('Adder operand', 'Adder B mux', { label: 'constant' });
  c.flow('Decimal adjust', 'Adder B mux', { label: 'DAA’s 6' });
  c.flow('Adder B mux', 'Adder');
  c.flow('Adder', 'Accumulator source mux', { label: 'sum' });
  c.flow('Keyboard process', 'Accumulator source mux', { label: 'KBP' });
  c.flow('Accumulator source mux', 'Accumulator');
  c.flow('Accumulator', 'Adder', { label: 'accumulator' });
  c.flow('Accumulator', 'Decimal adjust');
  c.flow('Accumulator', 'Keyboard process');
  c.flow('Carry logic', 'Carry flag');

  c.decoded = Array.from({ length: 16 }, (_, i) => dec.nets[`op${i}`]);
  c.accLines = Array.from({ length: 16 }, (_, i) => dec.nets[`acc${i}`]);
  c.phases = [ring.nets.p0, ring.nets.p1, ring.nets.p2, ring.nets.p3];
  c.control = {
    pcInc: ctrl.nets.pcInc, irLoad: ctrl.nets.irLoad,
    accLoad: ctrl.nets.accLoad, carryLoad,
  };
  c.program = PACC_PROGRAM;
  c.execAddr = () => {
    let ir8 = 0;
    for (let i = 0; i < 8; i++) {
      if (c.value[c.lamps.find(l => (l.short ?? l.label) === `IR${i}`).net] === 1) {
        ir8 |= 1 << i;
      }
    }
    return c.program.indexOf(ir8);
  };
  return c;
}

// `program` is a parameter so the test suite can drive cases the demo
// program cannot reach. XCH in particular needs an exchange between two
// *different* values to prove anything — swapping equal values looks
// identical whether the hardware swaps, copies one way, or does nothing.
export function buildSubMachine(program = PSUB_PROGRAM) {
  const c = new Circuit('Subtract and Exchange');
  c.implicitGround = false;

  const clkNet = c.net(), nclk = c.net(), rst = c.net();
  const clkSw = c.addSwitch('CLK', clkNet, 'toggle', 4, 6, { to: VSS });
  c.addSwitch('RST', rst, 'toggle', 4, 11, { to: VSS });
  c.addClock(clkSw, { period: 1200 });
  instantiate(c, Inverter, 20, 44, { a: clkNet, y: nclk });

  const ROW2 = 150;
  const ring = instantiate(c, ringCounter(4), 40, 0,
    { clk: clkNet, nclk, rst }, { tag: 'ring' });
  c.region('Phase ring',
    36, -6, 40 + ring.w + 4, ring.h + 6);

  const nFetch = c.net();
  instantiate(c, Inverter, 40, ROW2 - 40, { a: ring.nets.p0, y: nFetch });

  const pcLoadLine = c.net(), pcEnable = c.net();
  const PC = instantiate(c, programCounter(3), 40, ROW2, {
    clk: clkNet, nclk, en: pcEnable, rst, load: pcLoadLine,
    a0: VSS, a1: VSS, a2: VSS,
  }, { tag: 'pc' });
  c.region('Program counter', 36, ROW2 - 6, 40 + PC.w + 4, ROW2 + PC.h + 6);

  const xRom = 40 + PC.w + 30;
  const Rom = romArray(program, 8, 3);
  const rom = instantiate(c, Rom, xRom, ROW2,
    { a0: PC.nets.q0, a1: PC.nets.q1, a2: PC.nets.q2 }, { tag: 'rom' });

  const xIr = xRom + rom.w + 30;
  const ir = [];
  for (let i = 0; i < 8; i++) {
    ir.push(c.net());
    const keep = c.net(), take = c.net(), d = c.net();
    instantiate(c, And2, xIr, ROW2 + i * 26,
      { a: rom.nets[`d${i}`], b: ring.nets.p0, y: take }, { tag: `irt${i}` });
    instantiate(c, And2, xIr, ROW2 + i * 26 + 13,
      { a: ir[i], b: nFetch, y: keep }, { tag: `irk${i}` });
    instantiate(c, Or2, xIr + 42, ROW2 + i * 26,
      { a: take, b: keep, y: d }, { tag: `irm${i}` });
    instantiate(c, DFlipFlop, xIr + 90, ROW2 + i * 26,
      { d, q: ir[i], clk: clkNet, nclk }, { tag: `ir${i}` });
  }
  c.region('Instruction register',
    xIr - 6, ROW2 - 6, xIr + 160, ROW2 + 7 * 26 + 24);

  const xDec = xIr + 190;
  const dbind = {};
  for (let i = 0; i < 8; i++) dbind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, ROW2, dbind, { tag: 'dec' });
  c.region('Instruction decoder', xDec - 6, ROW2 - 6, xDec + dec.w + 4, ROW2 + dec.h + 6);

  const ROW3 = ROW2 + 680;
  const accQ = [c.net(), c.net(), c.net(), c.net()];
  const accZero = c.net(), carryQ = c.net();

  // CLC is the only accumulator-group instruction this program uses, and
  // it does not write the accumulator — so accGroup stays low and only
  // the carry logic sees it.
  const CLC = dec.nets.acc1;

  const xCtrl = xDec + dec.w + 40;
  const ctrl = instantiate(c, ControlUnit4, xCtrl, ROW2, {
    pFetch: ring.nets.p0, pDecode: ring.nets.p1,
    pFetch2: ring.nets.p2, pExec: ring.nets.p3,
    twoByte: dec.nets.twoByte,
    // No jumps, no INC and no ISZ in this machine's program — tied low
    // deliberately rather than left floating, since an unbound control
    // port reads Z and can fire a control line.
    opJUN: VSS, opJCN: VSS, opINC: VSS, condTake: VSS,
    opISZ: VSS, iszTake: VSS, opJMS: VSS, opBBL: VSS,
    opLDM: dec.nets.op13, opADD: dec.nets.op8,
    opSUB: dec.nets.op9, opLD: dec.nets.op10, opXCH: dec.nets.op11,
    // This machine reads the register file on the clock's high half and
    // writes it on the low half, so XCH is a genuine exchange.
    opXCHread: dec.nets.op11,
    accGroup: VSS,
  }, { tag: 'ctrl' });
  c.region('Control unit',
    xCtrl - 6, ROW2 - 6, xCtrl + ctrl.w + 6, ROW2 + ctrl.h + 6);

  const pcEnN = c.net();
  instantiate(c, Inverter, xCtrl, ROW2 + ctrl.h + 8,
    { a: ctrl.nets.pcInc, y: pcEnN }, { tag: 'pen' });
  instantiate(c, Inverter, xCtrl + 20, ROW2 + ctrl.h + 8,
    { a: pcEnN, y: pcEnable }, { tag: 'pen2' });
  instantiate(c, Inverter, xCtrl + 40, ROW2 + ctrl.h + 8,
    { a: VDD, y: pcLoadLine }, { tag: 'nold' });

  // The register file. Its write data is the accumulator, and its read
  // address is the same nibble as its write address — which is exactly
  // what makes XCH a swap: the row being written is the row being read,
  // and both happen on the same edge.
  // The write enable is gated by the clock's low half.
  //
  // This is what makes XCH a swap rather than a self-assignment, and it is
  // worth being precise about why. The register file's cells are
  // level-sensitive latches — the 4004's were too — so while `we` is high
  // the cell is *transparent*: whatever is on the write data appears
  // immediately on the read bus. XCH reads and writes the same row, so
  // without this gate the accumulator would capture the value it was in
  // the middle of writing, and the swap would be a no-op in one direction.
  //
  // The register file's write lands on φ2.
  //
  // This is how the real chip separates a register read from a register
  // write inside one instruction, and it is worth following exactly
  // rather than approximating. From Intel's transistor-level schematic
  // (sheet 2, "INDEX REGISTER CONTROL"; sheet 3, the accumulator block):
  // the index register's read and write paths are gated on *different
  // phases of a two-phase clock*, and the read path is enabled by a term
  // the drawing spells out as INC + ISZ + ADD + SUB + XCH + LD — XCH
  // sitting in the same list as LD, because both read a register.
  //
  // What the schematic also settles is that there is no temporary
  // register. The chip has ACC, a CARRY F/F, the ADDER and an ADB register
  // on the adder's second input, and nothing that exists to hold a value
  // mid-swap. Non-overlapping phases are what make the scratch space
  // unnecessary: the old register value reaches the accumulator during φ1,
  // and the old accumulator value reaches the register during φ2, with a
  // gap in between where neither path is live.
  //
  // The 4004 took φ1 and φ2 as two of its sixteen pins. Generating them
  // from one clock here is the concession; the non-overlap is not.
  //
  // What is built so far is the clock and the φ2-gated write. The φ1 read
  // path into the accumulator is not wired yet, which is why XCH is still
  // one-way on this machine — see opXCHread above.
  // In the gap between the phase ring above and the program counter row
  // below. It sat at y=70 tucked under the ring, inside the ring's own
  // box, so the ring's caption pointed at the clock's transistors.
  const phi = instantiate(c, TwoPhaseClock, 20, 250, { clk: clkNet },
    { tag: 'phi' });
  c.region('Two-phase clock',
    14, 244, 20 + phi.w + 10, 250 + phi.h + 10);

  // The ADB register: the accumulator's value, held on the adder's second
  // input.
  //
  // This is the piece the schematic supplies and that guessing did not.
  // Sheet 3 shows the accumulator block driving an ADB REGISTER through
  // control lines labelled ACC→ADB and CY→ADB, with ADD→ACC coming back
  // the other way. The chip has no scratch register for XCH because ADB
  // *is* the holding place — it already exists to feed the adder for ADD,
  // and XCH reuses it.
  //
  // On the real chip that is what makes the exchange work without a race:
  // ADB holds the old accumulator while the register file's write takes
  // its data from ADB rather than from the live accumulator, so the
  // accumulator is free to load the register's old value in the same
  // instruction. Two registers, two phases, no scratch.
  //
  // Here it is built but not yet load-bearing. XCH's read half is off
  // (see opXCHread above), so ADB currently only supplies the register
  // file's write data — which it does correctly, but which a plain
  // connection to the accumulator would also do. It earns its place when
  // the read path lands.
  // ADB captures on the falling edge, half a cycle *after* the
  // accumulator has latched. So while the accumulator moves on to the
  // register's old value, ADB still holds what the accumulator had when
  // the instruction began — which is exactly the value the register file
  // needs to be written with, and exactly what a swap requires.
  const adb = instantiate(c, register(4), xDec, ROW3 - 150, {
    clk: nclk, nclk: clkNet, load: VDD,
    d0: accQ[0], d1: accQ[1], d2: accQ[2], d3: accQ[3],
  }, { tag: 'adb' });
  c.region('ADB register',
    xDec - 6, ROW3 - 156, xDec + 150, ROW3 - 66);

  const regWriteGated = c.net();
  instantiate(c, And2, xDec, ROW3 - 60,
    { a: ctrl.nets.regWrite, b: phi.nets.phi2, y: regWriteGated },
    { tag: 'wegate' });

  const xRf = 40;
  const rf = instantiate(c, RegFile16x4, xRf, ROW3, {
    wa0: ir[0], wa1: ir[1], wa2: ir[2], wa3: ir[3],
    ra0: ir[0], ra1: ir[1], ra2: ir[2], ra3: ir[3],
    // written from ADB, not from the live accumulator — see above
    d0: adb.nets.q0, d1: adb.nets.q1, d2: adb.nets.q2, d3: adb.nets.q3,
    we: regWriteGated,
  }, { tag: 'rf' });
  c.region('Register file',
    xRf - 6, ROW3 - 6, xRf + rf.w + 4, ROW3 + rf.h + 6, { side: 'left' });

  // SUB conditioning: complement the register and the carry, or pass both
  // through for ADD.
  const xSub = xRf + rf.w + 40;
  const subop = instantiate(c, SubOperand, xSub, ROW3, {
    r0: rf.nets.q0, r1: rf.nets.q1, r2: rf.nets.q2, r3: rf.nets.q3,
    carry: carryQ, sub: ctrl.nets.aluSub,
  }, { tag: 'subop' });
  c.region('SUB conditioning',
    xSub - 6, ROW3 - 6, xSub + subop.w + 20, ROW3 + subop.h + 10);

  const xAdd = xSub + subop.w + 60;
  const adder = instantiate(c, rippleAdder(4), xAdd, ROW3, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3],
    b0: subop.nets.b0, b1: subop.nets.b1,
    b2: subop.nets.b2, b3: subop.nets.b3,
    cin: subop.nets.cin,
  }, { tag: 'add' });
  c.region('Adder',
    xAdd - 6, ROW3 - 6, xAdd + adder.w + 6, ROW3 + adder.h + 6);

  // The accumulator's source mux: adder, immediate, or the register file.
  const ROW4 = ROW3 + 260;
  const xMux = 40;
  const accD = [];
  for (let i = 0; i < 4; i++) {
    const y = ROW4 + i * 40;
    const fAlu = c.net(), fImm = c.net(), fReg = c.net();
    instantiate(c, And2, xMux, y,
      { a: adder.nets[`s${i}`], b: ctrl.nets.accFromAlu, y: fAlu },
      { tag: `mxa${i}` });
    instantiate(c, And2, xMux, y + 12,
      { a: ir[i], b: ctrl.nets.accFromImm, y: fImm }, { tag: `mxi${i}` });
    instantiate(c, And2, xMux, y + 24,
      { a: rf.nets[`q${i}`], b: ctrl.nets.accFromReg, y: fReg },
      { tag: `mxr${i}` });
    const o1 = c.net(), d = c.net();
    instantiate(c, Or2, xMux + 40, y, { a: fAlu, b: fImm, y: o1 },
      { tag: `mo1${i}` });
    instantiate(c, Or2, xMux + 70, y, { a: o1, b: fReg, y: d },
      { tag: `mo2${i}` });
    accD.push(d);
  }
  c.region('Accumulator source mux',
    xMux - 6, ROW4 - 8, xMux + 110, ROW4 + 4 * 40);

  const xAcc = xMux + 140;
  // The accumulator samples on the clock's HIGH half, opposite to every
  // other register here, and that is what completes XCH.
  //
  // A master-slave register is transparent on its master while the clock
  // is low, so a normally-clocked register captures whatever `d` held
  // during the low half. But the register file's write is gated to φ2 —
  // also the low half — so by then the read bus already shows the value
  // being written, and an exchange reads back what it just wrote.
  //
  // Swapping clk/nclk moves the accumulator's sampling window to the high
  // half, where the read bus still holds the register's OLD value. The
  // write then lands in the half that follows. Read first, write second,
  // one instruction, no scratch register — which is what the two-phase
  // clock buys and why the real chip needs no temporary for XCH.
  instantiate(c, register(4), xAcc, ROW4, {
    clk: nclk, nclk: clkNet, load: ctrl.nets.accLoad,
    d0: accD[0], d1: accD[1], d2: accD[2], d3: accD[3],
    q0: accQ[0], q1: accQ[1], q2: accQ[2], q3: accQ[3],
  }, { tag: 'acc' });
  c.region('Accumulator', xAcc - 6, ROW4 - 6, xAcc + 140, ROW4 + 90);

  const xZ = xAcc + 160;
  instantiate(c, IsZero4, xZ, ROW4, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3], z: accZero,
  }, { tag: 'zero' });
  c.region('Zero detect', xZ - 6, ROW4 - 6, xZ + 90, ROW4 + 50);

  // The carry: written by ADD/SUB from the adder, and by CLC directly.
  const xCar = xZ + 120;
  const carry = instantiate(c, CarryLogic, xCar, ROW4, {
    carry: carryQ, opCLC: CLC, opSTC: VSS, opCMC: VSS, opTCC: VSS,
  }, { tag: 'carry' });
  c.region('Carry logic', xCar - 6, ROW4 - 6, xCar + carry.w + 10,
    ROW4 + carry.h + 10);

  const carryD = c.net(), carryLoad = c.net();
  {
    const fAdd = c.net(), fOwn = c.net(), any = c.net();
    instantiate(c, And2, xCar, ROW4 + 120,
      { a: adder.nets.cout, b: ctrl.nets.accFromAlu, y: fAdd },
      { tag: 'cya' });
    instantiate(c, And2, xCar, ROW4 + 134,
      { a: carry.nets.d, b: carry.nets.sel, y: fOwn }, { tag: 'cyo' });
    instantiate(c, Or2, xCar + 40, ROW4 + 120,
      { a: fAdd, b: fOwn, y: carryD }, { tag: 'cyd' });

    const w1 = c.net();
    instantiate(c, Or2, xCar + 40, ROW4 + 160,
      { a: ctrl.nets.accFromAlu, b: carry.nets.sel, y: w1 }, { tag: 'cw1' });
    instantiate(c, And2, xCar + 70, ROW4 + 160,
      { a: w1, b: ring.nets.p3, y: any }, { tag: 'cw2' });
    const anyN = c.net();
    instantiate(c, Inverter, xCar + 100, ROW4 + 160, { a: any, y: anyN },
      { tag: 'cwn' });
    instantiate(c, Inverter, xCar + 120, ROW4 + 160,
      { a: anyN, y: carryLoad }, { tag: 'cwb' });
  }

  instantiate(c, register(1), xCar + 170, ROW4, {
    clk: clkNet, nclk, load: carryLoad, d0: carryD, q0: carryQ,
  }, { tag: 'cf' });
  c.region('Carry flag', xCar + 164, ROW4 - 6, xCar + 234, ROW4 + 60);

  const b = c.bounds();
  const xEnd = b.x1 + 10;
  const yTop = -16, yBot = b.y1 + 8;
  w(c, VDD, [0, yTop], [xEnd, yTop]);
  w(c, VSS, [0, yBot], [xEnd, yBot]);
  c.label('+V', -1.6, yTop, 1.1, '#ffb340');
  c.label('GND', -2.4, yBot, 1.1, '#7f8aa3');
  for (const sw of c.switches) {
    const t = switchSpdtT(sw);
    w(c, VDD, [2.4, yTop], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
    w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
  }

  for (let i = 0; i < 4; i++) {
    c.addLamp(`P${i}`, ring.nets[`p${i}`], xEnd - 5, 4 + i * 4.5, { short: `P${i}` });
  }
  for (let i = 0; i < 3; i++) {
    c.addLamp(`PC${i}`, PC.nets[`q${i}`], xEnd - 5, 26 + i * 4.5, { short: `PC${i}` });
  }
  for (let i = 0; i < 8; i++) {
    c.addLamp(`IR${i}`, ir[i], xEnd - 5, 42 + i * 4.5, { short: `IR${i}` });
  }
  for (let i = 0; i < 4; i++) {
    c.addLamp(`ACC${i}`, accQ[i], xEnd - 5, 82 + i * 4.5, { short: `ACC${i}` });
  }
  for (let i = 0; i < 4; i++) {
    c.addLamp(`R${i}`, rf.nets[`q${i}`], xEnd - 5, 104 + i * 4.5, { short: `R${i}` });
  }
  c.addLamp('CY', carryQ, xEnd - 5, 126, { short: 'CY' });
  c.addLamp('ZERO', accZero, xEnd - 5, 131, { short: 'Z' });

  // The fetch loop, at block level: the counter picks a word, the array
  // hands back a byte, the register holds it, the decoder reads it.
  c.flow('Program counter', 'ROM row decode', { label: 'address' });
  c.flow('ROM row decode', 'ROM array');
  c.flow('ROM array', 'ROM output buffers', { dir: 'v' });
  c.flow('ROM output buffers', 'Instruction register', { label: 'byte' });
  c.flow('Instruction register', 'Instruction decoder', { label: 'opcode' });
  // The read path back from the registers is what this machine adds, and
  // the two-phase clock is what makes XCH a true exchange.
  c.flow('Instruction decoder', 'Control unit', { label: 'which' });
  c.flow('Phase ring', 'Control unit', { label: 'when' });
  c.flow('Register file', 'SUB conditioning', { label: 'operand' });
  c.flow('SUB conditioning', 'Adder');
  c.flow('ADB register', 'Adder', { label: 'accumulator' });
  c.flow('Adder', 'Accumulator source mux', { label: 'sum' });
  c.flow('Accumulator source mux', 'Accumulator');
  c.flow('Accumulator', 'ADB register');
  c.flow('Accumulator', 'Register file', { label: 'XCH' });
  c.flow('Two-phase clock', 'Register file', { label: 'φ2' });
  c.flow('Carry logic', 'Carry flag');

  c.decoded = Array.from({ length: 16 }, (_, i) => dec.nets[`op${i}`]);
  c.phases = [ring.nets.p0, ring.nets.p1, ring.nets.p2, ring.nets.p3];
  c.cells = rf.stored;
  c.control = {
    pcInc: ctrl.nets.pcInc, irLoad: ctrl.nets.irLoad,
    accLoad: ctrl.nets.accLoad, accFromReg: ctrl.nets.accFromReg,
    aluSub: ctrl.nets.aluSub, regWrite: ctrl.nets.regWrite,
  };
  c.program = program;
  c.execAddr = () => {
    let ir8 = 0;
    for (let i = 0; i < 8; i++) {
      if (c.value[c.lamps.find(l => (l.short ?? l.label) === `IR${i}`).net] === 1) {
        ir8 |= 1 << i;
      }
    }
    return c.program.indexOf(ir8);
  };
  return c;
}

// The memory machine — the CPU talking to a 4002.
//
// This is the one machine with a modelled part in it, and the boundary is
// worth stating plainly because everything else in this project is built
// from devices. The CPU is real: registers, decoder, control, the address
// path. The 4002 behind the bus is a JavaScript object (`ram4002.js`).
//
// The line is the package boundary — CLAUDE.md's fourth rule. A 4002 is a
// separate chip the CPU reaches over a bus, and 320 bits of storage costs
// ~7,400 transistors to simulate, three times the whole CPU, to
// demonstrate nothing the register file has not already shown. What stays
// real is the *interface*: the addressing, the bank select, the timing of
// when data appears. What is modelled is the array behind it.
//
// SRC is why this machine has five phases. It sends the eight bits of a
// register pair to the bus, and the index register file has one 4-bit
// read port — so the pair takes two reads, one per phase. The real chip
// has the same problem for the same reason and solves it the same way,
// across its X1/X2/X3 execute phases.
//
//   LDM 1 · XCH r0    r0 = 1   the chip-and-register half of the address
//   LDM 5 · XCH r1    r1 = 5   the character half
//   SRC 0P            send r0:r1 = 0x15 to the bus
//   LDM 7 · WRM       write 7 to the addressed character
//   RDM               read it back into the accumulator
//
// Watch the address latch across READ1 and READ2: it fills a nibble at a
// time, and then holds. That persistence is the whole reason SRC is its
// own instruction — the manual says the address "remains in effect until
// changed by a subsequent SRC", so one SRC can serve many accesses.
const PMEM_PROGRAM = [
  0x20,   //  0  FIM 0P ─┐  load a register pair with an immediate…
  0x15,   //  1     0x15 ┘  …r0 = 1, r1 = 5: the even register takes the
          //               high nibble, which is the manual's convention
  0x21,   //  2  SRC 0P     send r0:r1 as address 0x15, and it stays there
  0xD7,   //  3  LDM 7
  0xE0,   //  4  WRM        RAM[0][1][5] = 7
  0xDA,   //  5  LDM 10
  0xEB,   //  6  ADM        10 + 7 = 1 with a carry — the manual's example
  0xE1,   //  7  WMP        the RAM output port takes it
  0xD3,   //  8  LDM 3
  0xE4,   //  9  WR0        status character 0 = 3
  0xEC,   // 10  RD0        read it back
  0xE2,   // 11  WRR        the ROM output port takes it
  0xEA,   // 12  RDR        and reads back
  0xE9,   // 13  RDM        main memory again
  0x32,   // 14  FIN 1P     r2:r3 ← ROM[r0:r1 = 0x15 → word 5] = 0xDA,
          //               so r2 = 13, r3 = 10 — the address ALWAYS comes
          //               from pair 0, whatever pair the result names
  0x31,   // 15  JIN 0P     jump to r0:r1 = 0x15 → address 5 in this ROM
];

export function buildMemMachine(program = PMEM_PROGRAM) {
  const c = new Circuit('Memory Machine');
  c.implicitGround = false;

  const clkNet = c.net(), nclk = c.net(), rst = c.net();
  const clkSw = c.addSwitch('CLK', clkNet, 'toggle', 4, 6, { to: VSS });
  c.addSwitch('RST', rst, 'toggle', 4, 11, { to: VSS });
  c.addClock(clkSw, { period: 1200 });
  instantiate(c, Inverter, 20, 44, { a: clkNet, y: nclk });

  // A five-phase ring is taller than the four-phase ones every other
  // machine uses, so this row starts lower — at 150 its box overlapped the
  // ring's by two units, which is invisible on screen and still means one
  // caption sits over the other block's devices.
  const ROW2 = 170;
  const ring = instantiate(c, ringCounter(5), 40, 0,
    { clk: clkNet, nclk, rst }, { tag: 'ring' });
  c.region('Phase ring',
    36, -6, 40 + ring.w + 4, ring.h + 6);

  // JIN loads the program counter from a register pair. On the real chip
  // only the low eight bits are replaced and the page stays put; this
  // ROM is one page, so the whole counter is the low bits.
  const pcEnable = c.net();
  const jinTarget = [c.net(), c.net(), c.net(), c.net()];
  const pcLoadLine = c.net();
  const PC = instantiate(c, programCounter(4), 40, ROW2, {
    clk: clkNet, nclk, en: pcEnable, rst, load: pcLoadLine,
    a0: jinTarget[0], a1: jinTarget[1], a2: jinTarget[2], a3: jinTarget[3],
  }, { tag: 'pc' });
  c.region('Program counter', 36, ROW2 - 6, 40 + PC.w + 4, ROW2 + PC.h + 6);

  // Sixteen words rather than eight. The memory group needs setup before
  // it can demonstrate anything — load a pair, send it, put a value in
  // memory — and the manual's own examples are four instructions before
  // the one being shown. Eight words was a demo limit, not a 4004 one;
  // the real chip addresses 4K.
  const xRom = 40 + PC.w + 30;
  const Rom = romArray(program, 8, 4);
  // The ROM's address: the program counter normally, r0:r1 for FIN.
  //
  // FIN is the only instruction in the set that reads program memory at
  // an address the program counter did not produce — "the contents of
  // registers 0 and 1 are concatenated to form the lower 8 bits of a ROM
  // address". That makes the ROM address a mux for exactly one
  // instruction, which is why it is worth pointing at.
  const romAddr = [c.net(), c.net(), c.net(), c.net()];
  const finAddr = [c.net(), c.net(), c.net(), c.net()];
  const rom = instantiate(c, Rom, xRom, ROW2,
    { a0: romAddr[0], a1: romAddr[1], a2: romAddr[2], a3: romAddr[3] },
    { tag: 'rom' });

  // The instruction register loads when the control unit says fetch —
  // NOT simply "during phase 0". The difference is FIN: on its second
  // pass through the ring the ROM is emitting the data byte FIN asked
  // for, and an unconditional phase-0 load would replace the instruction
  // with its own result. The control unit's irLoad line carries the
  // fetch-suppressed-on-cycle-2 version; it is declared here because the
  // register is built before the control unit is.
  const irLoadLine = c.net(), nIrLoad = c.net();
  instantiate(c, Inverter, 40, ROW2 - 40, { a: irLoadLine, y: nIrLoad },
    { tag: 'irln' });

  const xIr = xRom + rom.w + 30;
  const ir = [];
  for (let i = 0; i < 8; i++) {
    ir.push(c.net());
    const keep = c.net(), take = c.net(), d = c.net();
    instantiate(c, And2, xIr, ROW2 + i * 26,
      { a: rom.nets[`d${i}`], b: irLoadLine, y: take }, { tag: `irt${i}` });
    instantiate(c, And2, xIr, ROW2 + i * 26 + 13,
      { a: ir[i], b: nIrLoad, y: keep }, { tag: `irk${i}` });
    instantiate(c, Or2, xIr + 42, ROW2 + i * 26,
      { a: take, b: keep, y: d }, { tag: `irm${i}` });
    instantiate(c, DFlipFlop, xIr + 90, ROW2 + i * 26,
      { d, q: ir[i], clk: clkNet, nclk }, { tag: `ir${i}` });
  }
  c.region('Instruction register', xIr - 6, ROW2 - 6, xIr + 160,
    ROW2 + 7 * 26 + 24);

  // FIM carries a second byte. The operand register captures it during
  // DECODE — this machine has no FETCH2, so the byte after the opcode is
  // read while the decoder settles, which works because the program
  // counter has already stepped past the opcode by then.
  // Directly under the instruction register, sharing its column: the two
  // hold the two bytes of one instruction, so reading them stacked is the
  // arrangement that says so. Placed at xIr rather than xIr + 160, which
  // put it in the decoder's column.
  const xOpr = xIr;
  const opr = instantiate(c, register(8), xOpr, ROW2 + 250, {
    clk: clkNet, nclk, load: ring.nets.p1,
    d0: rom.nets.d0, d1: rom.nets.d1, d2: rom.nets.d2, d3: rom.nets.d3,
    d4: rom.nets.d4, d5: rom.nets.d5, d6: rom.nets.d6, d7: rom.nets.d7,
  }, { tag: 'opr' });
  c.region('Operand register',
    xOpr - 6, ROW2 + 244, xOpr + 160, ROW2 + 340);

  const xDec = xIr + 190;
  const dbind = {};
  for (let i = 0; i < 8; i++) dbind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, ROW2, dbind,
    { tag: 'dec' });
  c.region('Instruction decoder', xDec - 6, ROW2 - 6, xDec + dec.w + 4,
    ROW2 + dec.h + 6);

  // SRC and FIM share opcode 0010, told apart by OPA bit 0: odd is SRC.
  // The same shared-encoding rule the decoder's twoByte line uses.
  // Four instructions share two opcodes, told apart by OPA bit 0 — the
  // same shared-encoding rule the decoder's twoByte line uses.
  //
  //   0010 rrr 0  FIM    0010 rrr 1  SRC
  //   0011 rrr 0  FIN    0011 rrr 1  JIN
  const nir0 = c.net();
  instantiate(c, Inverter, xDec + dec.w + 10, ROW2 - 80,
    { a: ir[0], y: nir0 }, { tag: 'nir0' });
  const opSRC = c.net(), opFIM = c.net(), opFIN = c.net(), opJIN = c.net();
  const finCycle2 = c.net();
  instantiate(c, And2, xDec + dec.w + 34, ROW2 - 80,
    { a: dec.nets.op2, b: ir[0], y: opSRC }, { tag: 'srcd' });
  instantiate(c, And2, xDec + dec.w + 34, ROW2 - 60,
    { a: dec.nets.op2, b: nir0, y: opFIM }, { tag: 'fimd' });
  instantiate(c, And2, xDec + dec.w + 34, ROW2 - 40,
    { a: dec.nets.op3, b: nir0, y: opFIN }, { tag: 'find' });
  instantiate(c, And2, xDec + dec.w + 34, ROW2 - 20,
    { a: dec.nets.op3, b: ir[0], y: opJIN }, { tag: 'jind' });

  // The FIN cycle flag — this machine's version of the SINGLE CYCLE
  // flip-flop on sheet 2 of the 4004 schematic. Low through an
  // instruction's first pass of the ring, high through FIN's second:
  //
  //   d = ¬rst · ( q·¬p4  +  ¬q·opFIN·p4 )
  //
  // Clocked by the GLOBAL clock, not by a phase line. The second term
  // raises it at the edge that ends EXEC of a FIN's first cycle — the
  // same edge that returns the ring to FETCH — and the first term holds
  // it up until the edge that ends EXEC of the second, where both terms
  // go dead and it falls. ¬q in the set term is what stops a held FIN
  // opcode from stretching to a third cycle.
  //
  // Two lessons are baked into that equation. Clocking it from a phase
  // line left it UNDRIVEN until the first p4 edge, and every control
  // line that consults it answered X for the whole first instruction —
  // a two-instruction program never got its second instruction executed.
  // And it must be reset like the carry flag is: on the global clock
  // with ¬rst in the data term, the reset tick drives it to a firm 0
  // before the first fetch.
  {
    const nrstF = c.net(), np4 = c.net(), q = c.net(), nq = c.net();
    const hold = c.net(), setp = c.net(), sete = c.net();
    const dsum = c.net(), d = c.net();
    instantiate(c, Inverter, xDec + dec.w + 60, ROW2 - 130,
      { a: rst, y: nrstF }, { tag: 'fc2r' });
    instantiate(c, Inverter, xDec + dec.w + 60, ROW2 - 100,
      { a: ring.nets.p4, y: np4 }, { tag: 'fc2p' });
    instantiate(c, Inverter, xDec + dec.w + 60, ROW2 - 70,
      { a: q, y: nq }, { tag: 'fc2q' });
    instantiate(c, And2, xDec + dec.w + 86, ROW2 - 100,
      { a: q, b: np4, y: hold }, { tag: 'fc2h' });
    instantiate(c, And2, xDec + dec.w + 86, ROW2 - 70,
      { a: opFIN, b: ring.nets.p4, y: setp }, { tag: 'fc2s' });
    instantiate(c, And2, xDec + dec.w + 112, ROW2 - 70,
      { a: setp, b: nq, y: sete }, { tag: 'fc2e' });
    instantiate(c, Or2, xDec + dec.w + 112, ROW2 - 100,
      { a: hold, b: sete, y: dsum }, { tag: 'fc2o' });
    instantiate(c, And2, xDec + dec.w + 138, ROW2 - 100,
      { a: dsum, b: nrstF, y: d }, { tag: 'fc2d' });
    instantiate(c, DFlipFlop, xDec + dec.w + 164, ROW2 - 100,
      { d, q, clk: clkNet, nclk }, { tag: 'fc2' });
    const t = c.net();
    instantiate(c, Inverter, xDec + dec.w + 212, ROW2 - 100,
      { a: q, y: t }, { tag: 'fc2b' });
    instantiate(c, Inverter, xDec + dec.w + 232, ROW2 - 100,
      { a: t, y: finCycle2 }, { tag: 'fc2c' });
  }

  const ROW3 = ROW2 + 680;
  const accQ = [c.net(), c.net(), c.net(), c.net()];
  // The RAM's four output bits and the carry flag, declared before the
  // blocks that read them — nets are only wiring, so order is free.
  const ramQ = [c.net(), c.net(), c.net(), c.net()];
  const carryQ = c.net();
  // Pair write data, driven far below where the operand and ROM nibbles
  // are muxed; declared here because the register file is built first.
  const pairD = [c.net(), c.net(), c.net(), c.net()];

  const xCtrl = xDec + dec.w + 40;
  const memToAcc = c.net(), memWrite = c.net();
  const opADM = c.net(), opSBM = c.net(), opDCL = c.net();
  const ctrl = instantiate(c, MemControl, xCtrl, ROW2, {
    pFetch: ring.nets.p0, pDecode: ring.nets.p1,
    pRead1: ring.nets.p2, pRead2: ring.nets.p3, pExec: ring.nets.p4,
    opSRC, opLDM: dec.nets.op13, opXCH: dec.nets.op11,
    memToAcc, memWrite, opADM, opSBM, opDCL,
    // FIN is the only instruction in the 4004 set that takes TWO
    // instruction cycles — one byte, sixteen clock periods — because it
    // must read a register pair, address the ROM with it, and write a
    // register pair back, and that does not fit in one pass of a
    // five-phase ring. The finCycle2 flag above tells the control unit
    // which pass this is; irLoad comes back out with the second pass's
    // fetch suppressed, which is what keeps the FIN opcode in charge
    // while its data byte is on the ROM's output.
    opFIM, opFIN, opJIN, twoByte: dec.nets.twoByte, finCycle2,
    irLoad: irLoadLine,
    // The jump, call and increment group is not built on this machine —
    // it is the memory group's demonstration, not the whole CPU. Tied low
    // rather than left unbound: an unbound port floats, and Z into a
    // control line is how three earlier bugs here started. The complete
    // 4004 binds these for real.
    opJUN: VSS, opJCN: VSS, opJMS: VSS, opBBL: VSS,
    opINC: VSS, opISZ: VSS, opADD: VSS, opSUB: VSS, opLD: VSS,
    condTake: VSS, iszTake: VSS, accGroup: VSS, opXCHread: VSS,
  }, { tag: 'ctrl' });
  c.region('Control unit',
    xCtrl - 6, ROW2 - 6, xCtrl + ctrl.w + 6, ROW2 + ctrl.h + 6);

  const pcEnN = c.net();
  instantiate(c, Inverter, xCtrl, ROW2 + ctrl.h + 8,
    { a: ctrl.nets.pcInc, y: pcEnN }, { tag: 'pen' });
  instantiate(c, Inverter, xCtrl + 20, ROW2 + ctrl.h + 8,
    { a: pcEnN, y: pcEnable }, { tag: 'pen2' });

  // The register file. Its read address is the instruction's OPA for XCH,
  // and the SRC pair's two registers during READ1/READ2 — pair n is
  // registers 2n and 2n+1, so the address is RRR with bit 0 picking the
  // half. That is the manual's encoding on page 3-50.
  const ra = [c.net(), c.net(), c.net(), c.net()];
  {
    // bit 0: 0 during READ1 (even register), 1 during READ2 (odd)
    const t = c.net();
    instantiate(c, Inverter, xDec, ROW3 - 90, { a: ring.nets.p3, y: t },
      { tag: `ra0n` });
    instantiate(c, Inverter, xDec + 20, ROW3 - 90, { a: t, y: ra[0] },
      { tag: `ra0b` });
    // bits 1-3: the register (or pair) number, straight from OPA — for
    // everything except FIN.
    //
    // FIN is the exception, and the manual is specific: its *address*
    // always comes from registers 0 and 1 regardless of RP, while its
    // *result* goes to the pair RP names. So while a FIN is decoded, the
    // read address is forced to pair 0. One AND per bit does it.
    //
    // The previous version of this block is a bug worth recording. It
    // built a five-gate pair/non-pair classifier and fed it into a mux
    // whose two legs both passed ir[i] — a selector between a signal and
    // itself. The comment claimed FIN was forced to pair 0; the gates did
    // nothing of the kind, so FIN read its own *destination* pair as the
    // address source. FIN 1P fetched from whatever the destination
    // happened to hold, and every test that "passed" had used 0P
    // operands, where RRR = 000 makes the bug invisible. A mux between
    // identical inputs cannot be caught by testing its output — only by
    // reading it.
    const nOpFIN = c.net();
    instantiate(c, Inverter, xDec, ROW3 - 70,
      { a: opFIN, y: nOpFIN }, { tag: 'ranf' });
    for (let i = 1; i < 4; i++) {
      instantiate(c, And2, xDec + 24, ROW3 - 70 + i * 22,
        { a: ir[i], b: nOpFIN, y: ra[i] }, { tag: `ras${i}` });
    }
  }

  // FIN's address comes from r0 and r1, which the machine reads the same
  // way SRC reads its pair — during READ1 and READ2. The nibbles are
  // captured into a latch so both are available at once when the ROM
  // needs them.
  for (let i = 0; i < 4; i++) {
    const fp = c.net(), fc = c.net(), nf = c.net();
    instantiate(c, Inverter, xRom - 90, ROW2 + 260 + i * 26,
      { a: ctrl.nets.romFromPair, y: nf }, { tag: `ran${i}` });
    instantiate(c, And2, xRom - 64, ROW2 + 260 + i * 26,
      { a: finAddr[i], b: ctrl.nets.romFromPair, y: fp }, { tag: `rap${i}` });
    instantiate(c, And2, xRom - 64, ROW2 + 272 + i * 26,
      { a: PC.nets[`q${i}`], b: nf, y: fc }, { tag: `rac${i}` });
    instantiate(c, Or2, xRom - 34, ROW2 + 260 + i * 26,
      { a: fp, b: fc, y: romAddr[i] }, { tag: `rao${i}` });
  }
  c.region('ROM address mux',
    xRom - 96, ROW2 + 254, xRom - 20, ROW2 + 260 + 4 * 26);

  const xRf = 40;
  // The register file's write enable and its data source. XCH writes the
  // accumulator at EXEC; FIM and FIN write a pair across READ1/READ2.
  const regWriteGated = c.net(), pairWr = c.net(), anyWr = c.net();
  instantiate(c, Or2, xRf, ROW3 - 70,
    { a: ctrl.nets.pairHi, b: ctrl.nets.pairLo, y: pairWr },
    { tag: 'pwe' });
  instantiate(c, Or2, xRf + 30, ROW3 - 70,
    { a: ctrl.nets.regWrite, b: pairWr, y: anyWr }, { tag: 'awe' });
  instantiate(c, And2, xRf, ROW3 - 40,
    { a: anyWr, b: nclk, y: regWriteGated }, { tag: 'wegate' });
  // Write data: the accumulator for XCH, or a pair nibble for FIM/FIN.
  const regD = [c.net(), c.net(), c.net(), c.net()];
  for (let i = 0; i < 4; i++) {
    const fa = c.net(), fp = c.net(), np = c.net();
    instantiate(c, Inverter, xRf - 60, ROW3 + 40 + i * 26,
      { a: pairWr, y: np }, { tag: `rdn${i}` });
    instantiate(c, And2, xRf - 34, ROW3 + 40 + i * 26,
      { a: accQ[i], b: np, y: fa }, { tag: `rda${i}` });
    instantiate(c, And2, xRf - 34, ROW3 + 52 + i * 26,
      { a: pairD[i], b: pairWr, y: fp }, { tag: `rdp${i}` });
    instantiate(c, Or2, xRf - 8, ROW3 + 40 + i * 26,
      { a: fa, b: fp, y: regD[i] }, { tag: `rdo${i}` });
  }

  // Write address: bits 1-3 come from OPA always — the destination
  // register for XCH, the destination *pair* for FIM and FIN. Only bit 0
  // differs by kind: the instruction's own bit for XCH, the phase for a
  // pair write (even register in READ1, odd in READ2).
  //
  // The write address must NOT reuse the read address. FIN is the reason:
  // its two ports address different pairs in the same phase — the read
  // sits on pair 0 (the address source, always r0:r1) while the write
  // goes to the pair RP names. That is what a dual-ported register file
  // is *for*, and the 4004 has one. An earlier version borrowed ra[] for
  // pair writes, which sent FIN's result onto its own address source.
  //
  // (Bit 0 from the phase for XCH was an older bug of the same family:
  // XCH r1 wrote r0, quietly.)
  const wa0 = c.net();
  {
    const buf = c.net(), np = c.net(), g1 = c.net(), g2 = c.net();
    const t = c.net();
    instantiate(c, Inverter, xRf - 146, ROW3 + 40,
      { a: ring.nets.p3, y: t }, { tag: 'wa0n' });
    instantiate(c, Inverter, xRf - 126, ROW3 + 40,
      { a: t, y: buf }, { tag: 'wa0b' });
    instantiate(c, Inverter, xRf - 146, ROW3 + 66,
      { a: pairWr, y: np }, { tag: 'wa0m' });
    instantiate(c, And2, xRf - 120, ROW3 + 40,
      { a: buf, b: pairWr, y: g1 }, { tag: 'wa0p' });
    instantiate(c, And2, xRf - 120, ROW3 + 66,
      { a: ir[0], b: np, y: g2 }, { tag: 'wa0x' });
    instantiate(c, Or2, xRf - 94, ROW3 + 40,
      { a: g1, b: g2, y: wa0 }, { tag: 'wa0o' });
  }

  const rf = instantiate(c, RegFile16x4, xRf, ROW3, {
    wa0, wa1: ir[1], wa2: ir[2], wa3: ir[3],
    ra0: ra[0], ra1: ra[1], ra2: ra[2], ra3: ra[3],
    d0: regD[0], d1: regD[1], d2: regD[2], d3: regD[3],
    we: regWriteGated,
  }, { tag: 'rf' });
  c.region('Register file',
    xRf - 6, ROW3 - 6, xRf + rf.w + 4, ROW3 + rf.h + 6, { side: 'left' });

  // JIN's target is the pair it read, captured the same way FIN's
  // address is — the low nibble in READ2, the high in READ1.
  for (let i = 0; i < 4; i++) {
    instantiate(c, register(1), 40, ROW2 + 300 + i * 26, {
      clk: clkNet, nclk, load: ring.nets.p3,
      d0: rf.nets[`q${i}`], q0: jinTarget[i],
    }, { tag: `jt${i}` });
  }
  const jn = c.net();
  instantiate(c, Inverter, 40, ROW2 + 420, { a: ctrl.nets.pcLoad, y: jn },
    { tag: 'jln' });
  instantiate(c, Inverter, 60, ROW2 + 420, { a: jn, y: pcLoadLine },
    { tag: 'jlb' });

  // FIN's address latch. On the real chip r0 and r1 concatenate into the
  // low eight bits of a ROM address; this ROM is sixteen words, so only
  // the LOW nibble of that address has anywhere to land — and the low
  // nibble is the ODD register, on the read bus during READ2. Capturing
  // in READ1 grabs r0, the high nibble, and a FIN pointed at 0x15 reads
  // word 1 instead of word 5 — off by exactly "which register did you
  // latch". Same one-page rule JIN's target uses above.
  //
  // finLoad is already gated to READ2 of the first cycle only, so the
  // address holds while the second cycle consumes it — which is the
  // reason the latch exists: FIN 0P overwrites r0:r1 with the fetched
  // byte, and the address must survive its own destination being
  // written.
  for (let i = 0; i < 4; i++) {
    instantiate(c, register(1), xRf + rf.w + 4, ROW3 + 300 + i * 30, {
      clk: clkNet, nclk, load: ctrl.nets.finLoad,
      d0: rf.nets[`q${i}`], q0: finAddr[i],
    }, { tag: `fa${i}` });
  }
  c.region('FIN address latch',
    xRf + rf.w - 2, ROW3 + 294, xRf + rf.w + 90, ROW3 + 300 + 4 * 30);

  // Writing a register pair: the operand's high nibble to the even
  // register, the low nibble to the odd one — the manual's convention
  // (FIM 2 254 leaves r2 = 15 and r3 = 14). FIN writes the same way but
  // from the ROM byte it just fetched rather than from an operand.
  for (let i = 0; i < 4; i++) {
    const fromOpr = c.net(), fromRom = c.net(), nf = c.net();
    const hi = c.net(), lo = c.net(), nsel = c.net();
    // FIM takes the operand register, FIN the ROM's output
    instantiate(c, Inverter, xRf + rf.w + 120, ROW3 + 300 + i * 30,
      { a: opFIN, y: nf }, { tag: `pdn${i}` });
    // high nibble in READ1, low nibble in READ2
    instantiate(c, And2, xRf + rf.w + 146, ROW3 + 300 + i * 30,
      { a: opr.nets[`q${i + 4}`], b: nf, y: hi }, { tag: `pdh${i}` });
    instantiate(c, And2, xRf + rf.w + 146, ROW3 + 312 + i * 30,
      { a: rom.nets[`d${i + 4}`], b: opFIN, y: fromRom }, { tag: `pdr${i}` });
    instantiate(c, Or2, xRf + rf.w + 176, ROW3 + 300 + i * 30,
      { a: hi, b: fromRom, y: fromOpr }, { tag: `pdo${i}` });
    // the low nibble, same two sources
    const lh = c.net(), lr = c.net();
    instantiate(c, And2, xRf + rf.w + 146, ROW3 + 324 + i * 30,
      { a: opr.nets[`q${i}`], b: nf, y: lh }, { tag: `pll${i}` });
    instantiate(c, And2, xRf + rf.w + 146, ROW3 + 336 + i * 30,
      { a: rom.nets[`d${i}`], b: opFIN, y: lr }, { tag: `plr${i}` });
    instantiate(c, Or2, xRf + rf.w + 176, ROW3 + 324 + i * 30,
      { a: lh, b: lr, y: lo }, { tag: `plo${i}` });
    // pick which nibble by phase
    instantiate(c, Inverter, xRf + rf.w + 206, ROW3 + 312 + i * 30,
      { a: ring.nets.p3, y: nsel }, { tag: `psn${i}` });
    const th = c.net(), tl = c.net();
    instantiate(c, And2, xRf + rf.w + 232, ROW3 + 300 + i * 30,
      { a: fromOpr, b: nsel, y: th }, { tag: `psh${i}` });
    instantiate(c, And2, xRf + rf.w + 232, ROW3 + 312 + i * 30,
      { a: lo, b: ring.nets.p3, y: tl }, { tag: `psl${i}` });
    instantiate(c, Or2, xRf + rf.w + 262, ROW3 + 300 + i * 30,
      { a: th, b: tl, y: pairD[i] }, { tag: `pso${i}` });
  }
  c.region('Pair write data',
    xRf + rf.w + 114, ROW3 + 294, xRf + rf.w + 300, ROW3 + 300 + 4 * 30 + 40);

  // The SRC address latch: eight bits, filled a nibble per phase, held
  // until the next SRC.
  const xSrc = xRf + rf.w + 40;
  const src = instantiate(c, SrcLatch, xSrc, ROW3, {
    clk: clkNet, nclk,
    loadHi: ctrl.nets.srcHi, loadLo: ctrl.nets.srcLo,
    d0: rf.nets.q0, d1: rf.nets.q1, d2: rf.nets.q2, d3: rf.nets.q3,
  }, { tag: 'src' });
  c.region('SRC address latch',
    xSrc - 6, ROW3 - 6, xSrc + src.w + 10, ROW3 + src.h + 10);

  // The memory group lives in the 1110 escape. The decoder already
  // produces one line per OPA for the 1111 group; the 1110 group needs
  // the same second decode against a different escape line.
  //
  //   0 WRM   1 WMP   2 WRR   4..7 WR0-3
  //   8 SBM   9 RDM  10 RDR  11 ADM  12..15 RD0-3
  const xMem = xDec;
  const memDec = instantiate(c, Decode16, xMem, ROW3 + 260, {
    a0: ir[0], a1: ir[1], a2: ir[2], a3: ir[3],
  }, { tag: 'mdec' });
  const MEMOP = [];
  for (let i = 0; i < 16; i++) {
    const y = c.net();
    instantiate(c, And2, xMem + 220, ROW3 + 260 + i * 22,
      { a: memDec.nets[`y${i}`], b: dec.nets.op14, y }, { tag: `mo${i}` });
    MEMOP.push(y);
  }
  c.region('Memory-group decode',
    xMem - 6, ROW3 + 254, xMem + 260, ROW3 + 260 + 16 * 22);

  // Reads: RDM, RDR, RD0-3, and the arithmetic pair ADM/SBM all put
  // something into the accumulator. Writes: WRM, WMP, WRR, WR0-3.
  const or = (a, b, x, y, tag) => {
    const n = c.net();
    instantiate(c, Or2, x, y, { a, b, y: n }, { tag });
    return n;
  };
  {
    const xr = xMem + 300, yr = ROW3 + 260;
    const r1 = or(MEMOP[9], MEMOP[10], xr, yr, 'mr1');            // RDM RDR
    // RDR appears twice in this tree — harmless, it is an OR — but it
    // keeps the shape symmetric now that ADM/SBM have moved out.
    const r2 = or(MEMOP[12], MEMOP[13], xr, yr + 30, 'mr2');      // RD0 RD1
    const r3 = or(MEMOP[14], MEMOP[15], xr, yr + 60, 'mr3');      // RD2 RD3
    // ADM and SBM are deliberately absent: they reach the accumulator
    // through the adder, not straight off the bus, so they select
    // accFromAlu rather than accFromMem. Putting them here would drive
    // two mux inputs at once and the accumulator would take their OR.
    const r5 = or(r1, r2, xr + 30, yr, 'mr5');
    const r6 = or(r3, MEMOP[10], xr + 30, yr + 60, 'mr6');
    instantiate(c, Or2, xr + 60, yr + 30, { a: r5, b: r6, y: memToAcc },
      { tag: 'mrA' });

    const w1 = or(MEMOP[0], MEMOP[1], xr, yr + 130, 'mw1');       // WRM WMP
    const w2 = or(MEMOP[2], MEMOP[4], xr, yr + 160, 'mw2');       // WRR WR0
    const w3 = or(MEMOP[5], MEMOP[6], xr, yr + 190, 'mw3');       // WR1 WR2
    const w4 = or(w1, w2, xr + 30, yr + 130, 'mw4');
    const w5 = or(w3, MEMOP[7], xr + 30, yr + 190, 'mw5');        // + WR3
    instantiate(c, Or2, xr + 60, yr + 160, { a: w4, b: w5, y: memWrite },
      { tag: 'mwA' });
  }
  c.region('Memory access decode',
    xMem + 294, ROW3 + 254, xMem + 400, ROW3 + 470);

  // ADM, SBM and DCL, named from the memory-group decode below. Driven
  // there; declared here because the control unit is built first.
  {
    const buf = (from, to, x, y, tag) => {
      const t = c.net();
      instantiate(c, Inverter, x, y, { a: from, y: t }, { tag: tag + 'n' });
      instantiate(c, Inverter, x + 20, y, { a: t, y: to }, { tag });
    };
    buf(MEMOP[11], opADM, xMem + 460, ROW3 + 260, 'badm');
    buf(MEMOP[8], opSBM, xMem + 460, ROW3 + 290, 'bsbm');
    buf(dec.nets.acc13, opDCL, xMem + 460, ROW3 + 320, 'bdcl');
  }

  // SBM conditions the RAM operand and the carry, exactly as SUB does for
  // a register — same block, different source. ADM passes both through.
  const xSub = xMem + 520;
  const subop = instantiate(c, SubOperand, xSub, ROW3 + 260, {
    r0: ramQ[0], r1: ramQ[1], r2: ramQ[2], r3: ramQ[3],
    carry: carryQ, sub: ctrl.nets.aluSub,
  }, { tag: 'subop' });
  c.region('SBM conditioning',
    xSub - 6, ROW3 + 254, xSub + subop.w + 20, ROW3 + 260 + subop.h + 10);

  const xAdd = xSub + subop.w + 60;
  const adder = instantiate(c, rippleAdder(4), xAdd, ROW3 + 260, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3],
    b0: subop.nets.b0, b1: subop.nets.b1,
    b2: subop.nets.b2, b3: subop.nets.b3,
    cin: subop.nets.cin,
  }, { tag: 'add' });
  c.region('Adder',
    xAdd - 6, ROW3 + 254, xAdd + adder.w + 6, ROW3 + 260 + adder.h + 6);

  // The carry flag. ADM sets it on overflow; SBM sets it when there was
  // no borrow — the same carry-out bit, read two ways.
  //
  // Reset forces it to zero, and it needs to: a flag that powers up
  // floating feeds Z into the adder's carry-in, and the first ADM comes
  // out one too high with no other symptom. The manual gives RESET a
  // defined effect on the bank select for the same reason, and a carry
  // with no defined start is the same hazard one bit wide.
  const carryD = c.net(), nrst = c.net();
  instantiate(c, Inverter, xAdd + adder.w + 20, ROW3 + 300,
    { a: rst, y: nrst }, { tag: 'cfrn' });
  instantiate(c, And2, xAdd + adder.w + 40, ROW3 + 300,
    { a: adder.nets.cout, b: nrst, y: carryD }, { tag: 'cfr' });
  const carryLd = c.net();
  instantiate(c, Or2, xAdd + adder.w + 40, ROW3 + 330,
    { a: ctrl.nets.carryWrite, b: rst, y: carryLd }, { tag: 'cfl' });
  instantiate(c, register(1), xAdd + adder.w + 40, ROW3 + 260, {
    clk: clkNet, nclk, load: carryLd, d0: carryD, q0: carryQ,
  }, { tag: 'cf' });
  c.region('Carry flag', xAdd + adder.w + 34, ROW3 + 254,
    xAdd + adder.w + 104, ROW3 + 314);

  // DCL's bank register: the accumulator's low three bits, held until the
  // next DCL. The manual notes a RESET selects bank 0, which is what the
  // machine's RST does here.
  // "A RESET causes DATA RAM BANK 0 to be selected" — the manual, page
  // 3-49. So reset both loads the register and forces its input low.
  const bankD = [c.net(), c.net(), c.net()];
  for (let i = 0; i < 3; i++) {
    instantiate(c, And2, xAdd + adder.w + 130, ROW3 + 300 + i * 24,
      { a: accQ[i], b: nrst, y: bankD[i] }, { tag: `bkr${i}` });
  }
  const bankLd = c.net();
  instantiate(c, Or2, xAdd + adder.w + 130, ROW3 + 380,
    { a: ctrl.nets.bankLoad, b: rst, y: bankLd }, { tag: 'bkl' });
  const bank = instantiate(c, register(3), xAdd + adder.w + 150, ROW3 + 260, {
    clk: clkNet, nclk, load: bankLd,
    d0: bankD[0], d1: bankD[1], d2: bankD[2],
  }, { tag: 'bank' });
  c.region('Bank select',
    xAdd + adder.w + 144, ROW3 + 254, xAdd + adder.w + 280, ROW3 + 330);

  // The accumulator's source mux: an immediate, the register file, or
  // whatever the modelled RAM put on the bus.
  //
  // The RAM's four output bits are *switches*, not nets driven from
  // JavaScript. That is the honest way to model a chip on the far side of
  // a bus: the model decides a value, and the value reaches the circuit
  // through the same mechanism every other external input uses. Nothing
  // in the solver knows the difference between these and a switch a
  // finger flipped, which is what keeps "simulated, never faked" true on
  // the CPU side of the boundary.
  const ramSw = [];
  for (let i = 0; i < 4; i++) {
    const sw = c.addSwitch(`RAM${i}`, ramQ[i], 'toggle',
      4, 22 + i * 5, { to: VSS });
    // Driven by the 4002 model, not by a finger. `driven` keeps it out of
    // the input table so the user cannot fight the model for the bus.
    sw.driven = true;
    ramSw.push(sw);
  }
  // Clear of the blocks hanging below ROW3 — the pair-write data and the
  // memory-group decode both reach well past a 260 gap. The row also
  // starts to the right of the memory-group decode, which is the tallest
  // thing on the machine and would otherwise swallow the accumulator.
  const ROW4 = ROW3 + 420;
  const xMux = xMem + 560;
  const accD = [];
  for (let i = 0; i < 4; i++) {
    const y = ROW4 + i * 40;
    const fi = c.net(), fr = c.net(), fm = c.net(), fa = c.net();
    const o1 = c.net(), o2 = c.net(), d = c.net();
    instantiate(c, And2, xMux, y,
      { a: ir[i], b: ctrl.nets.accFromImm, y: fi }, { tag: `mxi${i}` });
    instantiate(c, And2, xMux, y + 12,
      { a: rf.nets[`q${i}`], b: ctrl.nets.accFromReg, y: fr },
      { tag: `mxr${i}` });
    instantiate(c, And2, xMux, y + 24,
      { a: ramQ[i], b: ctrl.nets.accFromMem, y: fm }, { tag: `mxm${i}` });
    // ADM and SBM arrive here, through the adder rather than off the bus
    instantiate(c, And2, xMux, y + 36,
      { a: adder.nets[`s${i}`], b: ctrl.nets.accFromAlu, y: fa },
      { tag: `mxa${i}` });
    instantiate(c, Or2, xMux + 40, y, { a: fi, b: fr, y: o1 },
      { tag: `mo1${i}` });
    instantiate(c, Or2, xMux + 40, y + 24, { a: fm, b: fa, y: o2 },
      { tag: `mo2${i}` });
    instantiate(c, Or2, xMux + 70, y, { a: o1, b: o2, y: d },
      { tag: `mo3${i}` });
    accD.push(d);
  }
  c.region('Accumulator source mux',
    xMux - 6, ROW4 - 8, xMux + 110, ROW4 + 4 * 40);

  const xAcc = xMux + 140;
  // Clocked normally, unlike the subtract machine's accumulator. That one
  // samples on the high half so XCH can read the register file before the
  // write lands; here XCH's read half is not wired, and clocking both the
  // accumulator and the register write on the low half makes them move
  // together — the register then captures an accumulator that has already
  // changed, and every XCH stores zero.
  instantiate(c, register(4), xAcc, ROW4, {
    clk: clkNet, nclk, load: ctrl.nets.accLoad,
    d0: accD[0], d1: accD[1], d2: accD[2], d3: accD[3],
    q0: accQ[0], q1: accQ[1], q2: accQ[2], q3: accQ[3],
  }, { tag: 'acc' });
  c.region('Accumulator', xAcc - 6, ROW4 - 6, xAcc + 140, ROW4 + 90);

  const b = c.bounds();
  const xEnd = b.x1 + 10;
  const yTop = -16, yBot = b.y1 + 8;
  w(c, VDD, [0, yTop], [xEnd, yTop]);
  w(c, VSS, [0, yBot], [xEnd, yBot]);
  c.label('+V', -1.6, yTop, 1.1, '#ffb340');
  c.label('GND', -2.4, yBot, 1.1, '#7f8aa3');
  for (const sw of c.switches) {
    const t = switchSpdtT(sw);
    w(c, VDD, [2.4, yTop], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
    w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
  }

  for (let i = 0; i < 5; i++) {
    c.addLamp(`P${i}`, ring.nets[`p${i}`], xEnd - 5, 4 + i * 4.5,
      { short: `P${i}` });
  }
  for (let i = 0; i < 4; i++) {
    c.addLamp(`PC${i}`, PC.nets[`q${i}`], xEnd - 5, 30 + i * 4.5,
      { short: `PC${i}` });
  }
  for (let i = 0; i < 8; i++) {
    c.addLamp(`IR${i}`, ir[i], xEnd - 5, 46 + i * 4.5, { short: `IR${i}` });
  }
  for (let i = 0; i < 8; i++) {
    c.addLamp(`SRC${i}`, src.nets[`q${i}`], xEnd - 5, 86 + i * 4.5,
      { short: `SRC${i}` });
  }
  for (let i = 0; i < 4; i++) {
    c.addLamp(`ACC${i}`, accQ[i], xEnd - 5, 126 + i * 4.5,
      { short: `ACC${i}` });
  }
  c.addLamp('CY', carryQ, xEnd - 5, 148, { short: 'CY' });
  for (let i = 0; i < 3; i++) {
    c.addLamp(`BANK${i}`, bank.nets[`q${i}`], xEnd - 5, 155 + i * 4.5,
      { short: `BANK${i}` });
  }
  // FIN's extra cycle — the one lamp that ever lights two ring passes
  // into the same instruction. Digit-free name on purpose: a trailing
  // digit would make the I/O table read it as bit 2 of a bus called "C".
  c.addLamp('XCY', finCycle2, xEnd - 5, 169, { short: 'XCY' });

  // The fetch loop, at block level: the counter picks a word, the array
  // hands back a byte, the register holds it, the decoder reads it.
  c.flow('Program counter', 'ROM row decode', { label: 'address' });
  c.flow('ROM row decode', 'ROM array');
  c.flow('ROM array', 'ROM output buffers', { dir: 'v' });
  c.flow('ROM output buffers', 'Instruction register', { label: 'byte' });
  c.flow('Instruction register', 'Instruction decoder', { label: 'opcode' });
  // The memory group: a register pair becomes an address, the address
  // reaches the 4002 over a bus, and FIN steers the ROM from the same pair.
  c.flow('Instruction decoder', 'Control unit', { label: 'which' });
  c.flow('Phase ring', 'Control unit', { label: 'when' });
  c.flow('ROM output buffers', 'Operand register', { label: 'byte 2' });
  c.flow('Register file', 'SRC address latch', { label: 'pair' });
  c.flow('Register file', 'FIN address latch', { label: 'r0:r1' });
  c.flow('FIN address latch', 'ROM address mux', { label: 'FIN' });
  c.flow('Program counter', 'ROM address mux');
  c.flow('Instruction decoder', 'Memory-group decode', { label: '1110' });
  c.flow('Memory-group decode', 'Memory access decode');
  c.flow('Operand register', 'Pair write data');
  c.flow('Pair write data', 'Register file', { label: 'FIM / FIN' });
  c.flow('SBM conditioning', 'Adder');
  c.flow('Adder', 'Accumulator source mux', { label: 'sum' });
  c.flow('Accumulator source mux', 'Accumulator');
  c.flow('Accumulator', 'Bank select', { label: 'DCL' });

  c.decoded = Array.from({ length: 16 }, (_, i) => dec.nets[`op${i}`]);
  c.phases = [ring.nets.p0, ring.nets.p1, ring.nets.p2, ring.nets.p3,
              ring.nets.p4];
  c.cells = rf.stored;
  c.control = {
    pcInc: ctrl.nets.pcInc, irLoad: ctrl.nets.irLoad,
    srcHi: ctrl.nets.srcHi, srcLo: ctrl.nets.srcLo,
    accLoad: ctrl.nets.accLoad, accFromMem: ctrl.nets.accFromMem,
    accFromAlu: ctrl.nets.accFromAlu, aluSub: ctrl.nets.aluSub,
    regWrite: ctrl.nets.regWrite, ramWrite: ctrl.nets.ramWrite,
    bankLoad: ctrl.nets.bankLoad,
    pairHi: ctrl.nets.pairHi, pairLo: ctrl.nets.pairLo,
    romFromPair: ctrl.nets.romFromPair, pcLoad: ctrl.nets.pcLoad,
    finLoad: ctrl.nets.finLoad,
  };
  c.finCycle2 = finCycle2;
  c.finAddr = finAddr;
  c.bankNets = [bank.nets.q0, bank.nets.q1, bank.nets.q2];
  c.program = program;
  c.ramQ = ramQ;
  c.ramSw = ramSw;
  c.memOp = MEMOP;
  c.srcNets = Array.from({ length: 8 }, (_, i) => src.nets[`q${i}`]);
  c.execAddr = () => {
    let ir8 = 0;
    for (let i = 0; i < 8; i++) {
      if (c.value[c.lamps.find(l => (l.short ?? l.label) === `IR${i}`).net]
          === 1) ir8 |= 1 << i;
    }
    return c.program.indexOf(ir8);
  };
  return c;
}

// ── behaviour, keyed by circuit id ───────────────────────────────────────

const ALU_OPS = ['+', '\u2212', 'AND', 'OR', 'XOR', '<<'];

export const cmos = {
  cmosinv: { build: buildCmosInverter },
  cmosring: { build: buildRing('CMOS Ring Oscillator', 'cmos', 2) },
  cmosnand: { build: buildCmosNand },
  cmosnor: { build: buildCmosNor },
  cmosand: { build: buildCmosComposed('CMOS AND', And2, 'NAND + inverter') },
  cmosor: { build: buildCmosComposed('CMOS OR', Or2, 'NOR + inverter') },
  cmosxor: { build: buildCmosComposed('CMOS XOR', Xor2, 'four NAND gates') },
  cmosdec: {
    build: buildFromModule('CMOS 2-to-4 Decoder', cmosDecoder(2),
      [['A0', 'a0'], ['A1', 'a1']],
      [['Y0', 'r0'], ['Y1', 'r1'], ['Y2', 'r2'], ['Y3', 'r3']]),
  },
  cmoslatch: {
    build: buildFromModule('CMOS D Latch', DLatch,
      [['D', 'd'], ['EN', 'en'], ['NEN', 'nen']], [['Q', 'q']]),
  },
  cmosfa: {
    build: buildFromModule('CMOS Full Adder', FullAdder,
      [['A', 'a'], ['B', 'b'], ['Cin', 'cin']], [['S', 'sum'], ['Cout', 'cout']]),
    readout: v => `${v.A} + ${v.B} + ${v.Cin} = ${v.Cout * 2 + v.S}`,
  },
  tgate: { build: buildTransmissionGate },
  tristate: {
    build: buildTriState,
    // D1/D2 and EN1/EN2 group into 2-bit buses by the trailing-digit rule,
    // so bit 0 is driver 1 and bit 1 is driver 2.
    select: v => {
      const e1 = v.EN & 1, e2 = (v.EN >> 1) & 1;
      const d1 = v.D & 1, d2 = (v.D >> 1) & 1;
      if (e1 && e2) return d1 === d2 ? 1 : 3;
      return (e1 || e2) ? 0 : 2;
    },
  },
  regfile: {
    build: buildRegFile,
    readout: v => `read r${v.RA} \u2192 ${v.Q}   \u00b7   write r${v.WA} \u2190 ${v.D}${v.WE ? '  (WE high \u2014 storing now)' : ''}`,
    select: v => (v.WE ? 1 : -1),
    read: (c, v) => c.cells.map((nets, i) => {
      const bits = nets.map(n => VALUE_CHAR[c.value[n]]);
      const settled = bits.every(b => b === '0' || b === '1');
      return {
        label: `r${i}`,
        // A never-written latch is genuinely floating, and saying so
        // matters — but four Z's per cell swamps the grid, so it reads as
        // a single dash and keeps the colour that flags it.
        text: settled ? String(parseInt(bits.slice().reverse().join(''), 2)) : '\u2013',
        mark: i === v.RA ? 'read' : i === v.WA ? 'write' : null,
      };
    }),
  },
  romcmos: {
    build: () => buildRom8('precharge'),
    readout: v => {
      if (!v.PRE) return 'PRE low \u2014 precharging, every line pulled high';
      const ch = v.D;
      const glyph = ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '\u00b7';
      return `addr ${v.A} \u2192 ${ch} = 0x${ch.toString(16).toUpperCase().padStart(2, '0')} = "${glyph}"`;
    },
    select: v => (v.PRE ? 1 : 0),
    read: (c, v) => [...'LOGIC 42'].map((ch, i) => ({
      label: String(i),
      text: ch === ' ' ? '\u2423' : ch,
      mark: i === v.A ? 'read' : null,
    })),
  },
  memmachine: {
    build: buildMemMachine,
    // The modelled 4002 is stepped from here rather than from inside the
    // builder, because it is not a circuit — it is a peer the circuit
    // talks to. Each solve, we look at what the CPU is driving and let
    // the model respond, exactly as a real chip on the far side of the
    // bus would.
    step: (c) => {
      const on = n => VALUE_CHAR[c.value[n]] === '1';
      const bits = nets => nets.reduce((v, n, i) => v | (on(n) ? 1 << i : 0), 0);
      if (!c.ram) { c.ram = new RamBank(); c.romPort = 0; }

      // DCL selects the bank. The model holds one bank, so the selection
      // is recorded and shown rather than switching arrays — the machine
      // says which bank it would be talking to, which is the part that is
      // about the CPU.
      c.bank = bits(c.bankNets);

      const addr = bits(c.srcNets);
      if (addr !== c.lastSrc) { c.ram.src(addr); c.lastSrc = addr; }

      const acc = bits([0, 1, 2, 3].map(i =>
        c.lamps.find(l => (l.short ?? l.label) === `ACC${i}`).net));
      const op = c.memOp.findIndex(n => on(n));

      if (on(c.control.ramWrite)) {
        if (op === 0) c.ram.writeMain(acc);                     // WRM
        else if (op === 1) c.ram.writePort(acc);                // WMP
        else if (op === 2) c.romPort = acc;                     // WRR
        else if (op >= 4 && op <= 7) c.ram.writeStatus(op - 4, acc);
      }

      // What the RAM or a port is putting on the bus. RDR reads the ROM
      // port — on a real 4001 those four lines can be inputs or outputs,
      // and the manual says which you get "is a function of the hardware,
      // not under control of the programmer". Here it reads back what WRR
      // last wrote, which is the INTELLEC 4 behaviour the manual
      // describes as a port used for both directions.
      let out = 0;
      if (op === 9) out = c.ram.readMain() ?? 0;                // RDM
      else if (op === 10) out = c.romPort;                      // RDR
      else if (op === 11) out = c.ram.readMain() ?? 0;          // ADM
      else if (op === 8) out = c.ram.readMain() ?? 0;           // SBM
      else if (op >= 12) out = c.ram.readStatus(op - 12) ?? 0;  // RD0-3
      c.ramValue = out;
      for (let i = 0; i < 4; i++) c.ramSw[i].on = !!((out >> i) & 1);
    },
    readout: v => {
      const ph = PHASES5[[0, 1, 2, 3, 4].find(i => (v.P >> i) & 1)] ?? '—';
      const { text } = disassemble(v.IR);
      const a = v.SRC ?? 0;
      return `${ph}  ·  PC ${v.PC}  ·  ${text}  ·  ACC ${v.ACC}`
        + `  ·  SRC 0x${a.toString(16).toUpperCase().padStart(2, '0')}`
        + ` = chip ${(a >> 6) & 3}, reg ${(a >> 4) & 3}, char ${a & 15}`;
    },
    read: (c) => {
      const on = n => VALUE_CHAR[c.value[n]] === '1';
      const rows = PHASES5.map((p, i) => ({
        label: p, text: on(c.phases[i]) ? '◀' : '·',
        mark: on(c.phases[i]) ? 'read' : null,
      }));
      for (const [k, net] of Object.entries(c.control)) {
        rows.push({ label: k, text: on(net) ? '1' : '·',
                    mark: on(net) ? 'write' : null });
      }
      return rows;
    },
  },
  submachine: {
    build: buildSubMachine,
    readout: v => {
      const ph = PHASES4[[0, 1, 2, 3].find(i => (v.P >> i) & 1)] ?? '—';
      const { text } = disassemble(v.IR);
      return `${ph}  ·  PC ${v.PC}  ·  ${text}`
        + `  ·  ACC ${v.ACC}  R ${v.R}`
        + `${v.CY ? '  carry — no borrow' : ''}${v.Z ? '  zero' : ''}`;
    },
    read: (c, v) => c.cells.map((nets, i) => {
      const bits = nets.map(n => VALUE_CHAR[c.value[n]]);
      const settled = bits.every(b => b === '0' || b === '1');
      return {
        label: `r${i}`,
        text: settled ? String(parseInt(bits.slice().reverse().join(''), 2)) : '–',
        mark: i === (v.IR & 15) ? 'read' : null,
      };
    }),
  },
  accgroup: {
    build: buildAccGroupMachine,
    readout: v => {
      const ph = PHASES4[[0, 1, 2, 3].find(i => (v.P >> i) & 1)] ?? '—';
      // Every instruction here is either LDM or in the 1111 escape group,
      // so the disassembler's own table names it — the same table the
      // hardware decoder implements in gates.
      const { text } = disassemble(v.IR);
      return `${ph}  ·  PC ${v.PC}  ·  ${text}`
        + `  ·  ACC ${v.ACC}${v.CY ? '  carry' : ''}${v.Z ? '  zero' : ''}`;
    },
    read: (c) => {
      const on = n => VALUE_CHAR[c.value[n]] === '1';
      const rows = PHASES4.map((p, i) => ({
        label: p, text: on(c.phases[i]) ? '◀' : '·',
        mark: on(c.phases[i]) ? 'read' : null,
      }));
      for (const [k, net] of Object.entries(c.control)) {
        rows.push({ label: k, text: on(net) ? '1' : '·',
                    mark: on(net) ? 'write' : null });
      }
      return rows;
    },
  },
  twobyte: {
    build: buildTwoByteMachine,
    readout: v => {
      const ph = PHASES4[[0, 1, 2, 3].find(i => (v.P >> i) & 1)] ?? '—';
      const name = OPR_NAMES[(v.IR >> 4) & 15] || 'escape';
      const arg = name === 'LDM' ? ` ${v.IR & 15}`
        : name === 'JCN' ? ` ${v.IR & 15}, ${v.OPR}`
        : name === 'JUN' ? ` ${v.OPR}`
        : ['ADD', 'XCH'].includes(name) ? ` r${v.IR & 15}` : '';
      return `${ph}  ·  PC ${v.PC}  ·  ${name}${arg}  ·  ACC ${v.ACC}`
        + `${v.Z ? '  zero' : ''}${v.TK && name === 'JCN' ? '  → taking' : ''}`;
    },
    read: (c) => {
      const on = n => VALUE_CHAR[c.value[n]] === '1';
      const rows = PHASES4.map((p, i) => ({
        label: p, text: on(c.phases[i]) ? '◀' : '·',
        mark: on(c.phases[i]) ? 'read' : null,
      }));
      for (const [k, net] of Object.entries(c.control)) {
        rows.push({ label: k, text: on(net) ? '1' : '·',
                    mark: on(net) ? 'write' : null });
      }
      return rows;
    },
  },
  jcnmachine: {
    build: buildJcnMachine,
    readout: v => {
      const ph = PHASES[[0, 1, 2].find(i => (v.P >> i) & 1)] ?? '—';
      const name = OPR_NAMES[(v.IR >> 4) & 15] || 'escape';
      const arg = name === 'LDM' ? ` ${v.IR & 15}`
        : name === 'JCN' ? ` mask ${v.IR & 15}`
        : ['ADD', 'XCH'].includes(name) ? ` r${v.IR & 15}`
        : name === 'JUN' ? ` ${v.IR & 7}` : '';
      return `${ph}  ·  PC ${v.PC}  ·  ${name}${arg}  ·  ACC ${v.ACC}`
        + `${v.Z ? '  zero' : ''}${v.CY ? '  carry' : ''}`
        + `${name === 'JCN' ? (v.TK ? '  → taking' : '  → not taking') : ''}`;
    },
    read: (c) => {
      const on = n => VALUE_CHAR[c.value[n]] === '1';
      const rows = PHASES.map((p, i) => ({
        label: p, text: on(c.phases[i]) ? '◀' : '·',
        mark: on(c.phases[i]) ? 'read' : null,
      }));
      for (const [k, net] of Object.entries(c.control)) {
        rows.push({ label: k, text: on(net) ? '1' : '·',
                    mark: on(net) ? 'write' : null });
      }
      return rows;
    },
  },
  addmachine: {
    build: buildAddMachine,
    readout: v => {
      const ph = PHASES[[0, 1, 2].find(i => (v.P >> i) & 1)] ?? '—';
      const name = OPR_NAMES[(v.IR >> 4) & 15] || 'escape';
      const arg = ['LDM'].includes(name) ? ` ${v.IR & 15}`
        : ['ADD', 'XCH', 'INC'].includes(name) ? ` r${v.IR & 15}`
        : name === 'JUN' ? ` ${v.IR & 7}` : '';
      return `${ph}  ·  PC ${v.PC}  ·  ${name}${arg}`
        + `  ·  ACC ${v.ACC}  R ${v.R}${v.CY ? '  carry' : ''}`;
    },
    read: (c) => {
      const on = n => VALUE_CHAR[c.value[n]] === '1';
      const rows = PHASES.map((p, i) => ({
        label: p, text: on(c.phases[i]) ? '◀' : '·',
        mark: on(c.phases[i]) ? 'read' : null,
      }));
      for (const [k, net] of Object.entries(c.control)) {
        rows.push({ label: k, text: on(net) ? '1' : '·',
                    mark: on(net) ? 'write' : null });
      }
      return rows;
    },
  },
  sequenced: {
    build: buildSequenced,
    readout: v => {
      const ph = PHASES[[0, 1, 2].find(i => (v.P >> i) & 1)] ?? '—';
      const name = OPR_NAMES[(v.IR >> 4) & 15] || 'escape';
      return `${ph}  ·  PC ${v.PC}  ·  IR 0x`
        + `${v.IR.toString(16).toUpperCase().padStart(2, '0')} (${name})`
        + `${v.JMP ? '  ← jumping' : ''}`;
    },
    read: (c) => {
      const on = n => VALUE_CHAR[c.value[n]] === '1';
      const rows = PHASES.map((p, i) => ({
        label: p, text: on(c.phases[i]) ? '◀' : '·',
        mark: on(c.phases[i]) ? 'read' : null,
      }));
      for (const [k, net] of Object.entries(c.control)) {
        rows.push({ label: k, text: on(net) ? '1' : '·',
                    mark: on(net) ? 'write' : null });
      }
      return rows;
    },
  },
  fetch: {
    build: buildFetch,
    readout: v => {
      const name = OPR_NAMES[(v.IR >> 4) & 15];
      const label = name || 'escape group';
      return `PC ${v.PC} → 0x${v.IR.toString(16).toUpperCase().padStart(2, '0')}`
        + `  ·  ${label}${v.TWO ? '  (needs a second byte)' : ''}`;
    },
    // `read` sits flat on the behaviour; the title/columns/key half of the
    // state block is catalogue data. See docs/DATA.md.
    read: (c) => OPR_NAMES.map((name, i) => {
      const on = VALUE_CHAR[c.value[c.decoded[i]]] === '1';
      return {
        label: name || (i === 14 ? 'esc0' : 'esc1'),
        text: on ? '◀' : '·',
        mark: on ? 'read' : null,
      };
    }),
  },
  cmospc4: {
    build: buildCounter(4, '4-bit Counter'),
    readout: v => `count = ${v.Q}${v.Cout ? '  (rolling over)' : ''}`,
  },
  cmospc12: {
    build: buildCounter(12, '12-bit Program Counter'),
    readout: v => `PC = ${v.Q}  (0x${v.Q.toString(16).toUpperCase().padStart(3, '0')})`,
  },
  alu4: {
    build: buildAlu4,
    readout: v => {
      if (v.F > 5) return `F=${v.F}: no function selected \u2014 result bus floating`;
      if (v.F === 5) return `${v.A} << 1 = ${v.Y}`;
      const carry = v.F === 0 && v.Cout ? '  (carry)' : '';
      const borrow = v.F === 1 && !v.Cout ? '  (borrow \u2014 negative)' : '';
      return `${v.A} ${ALU_OPS[v.F]} ${v.B} = ${v.Y}${carry}${borrow}`;
    },
    // codes 6 and 7 share the last row — both select nothing
    select: v => (v.F <= 5 ? v.F : 6),
    read: (c, v) => {
      // read the nets the circuit actually settled to, never recompute: a
      // display that does its own arithmetic would agree with a broken
      // circuit, which is the one thing it must never do
      const word = key => {
        let n = 0;
        for (let i = 0; i < c.slices.length; i++) {
          const ch = VALUE_CHAR[c.value[c.slices[i][key]]];
          if (ch === '1') n |= 1 << i;
          else if (ch !== '0') return '\u2014';
        }
        return String(n);
      };
      // ADD and SUB share the adder; which one it computed depends on F
      const sum = word('sum');
      return [
        { label: 'ADD', text: v.F === 1 ? '\u00b7' : sum },
        { label: 'SUB', text: v.F === 1 ? sum : '\u00b7' },
        { label: 'AND', text: word('and') },
        { label: 'OR', text: word('or') },
        { label: 'XOR', text: word('xor') },
        { label: 'SHL', text: word('shl') },
      ].map((it, i) => ({ ...it, mark: i === v.F ? 'read' : null }));
    },
  },
};
