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
import { InstructionDecoder, OPR_NAMES, disassemble } from '../decode.js';
import {
  ringCounter, ControlUnit, ControlUnit4, ConditionTree, IsZero4,
  AccOperand, CarryLogic, SubOperand, TwoPhaseClock,
  DecimalAdjust, KeyboardProcess,
  PHASES, PHASES4,
} from '../sequencer.js';
import { buildRom8 } from './rom-circuit.js';
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
  c.region('Instruction decoder — one line per opcode',
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
  c.region('Phase ring — FETCH / DECODE / EXEC',
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
  c.region('Instruction register — loads only during FETCH',
    xIr - 6, ROW2 - 6, xIr + 160, ROW2 + 7 * 26 + 24);

  // ── decode and control, to the right of the register ───────────────────
  // The decoder is the tallest block here (sixteen output lines), so it
  // sets the height of this row rather than being stacked under it — that
  // keeps the whole machine wide and short like the rest of the library.
  const xDec = xIr + 190;
  const dbind = {};
  for (let i = 0; i < 8; i++) dbind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, ROW2, dbind, { tag: 'dec' });
  c.region('Instruction decoder — one line per opcode',
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
  c.region('Control unit — phase AND instruction',
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


// P1 — the machine with an accumulator. The first one whose state changes.
//
// Everything up to here read a program and understood it. This one acts on
// what it read: LDM loads its operand nibble into the accumulator, so
// running the program visibly leaves a number behind.
//
// That is a small step and a large one. Small because an accumulator is
// just a register with a load enable. Large because it closes the loop —
// decode produces a control line, the control line gates a register, and
// the register holds the result. Every instruction after this is the same
// shape with a different destination.
//
// The program loads three different values in turn, so the accumulator
// visibly changes and you can watch each LDM take effect at EXEC and only
// at EXEC. The NOPs between them are there so the value sits still long
// enough to read.
const P1_PROGRAM = [
  0xD3,   // LDM 3   → ACC = 3
  0x00,   // NOP
  0xDC,   // LDM 12  → ACC = 12
  0x00,   // NOP
  0xD5,   // LDM 5   → ACC = 5
  0x00,   // NOP
  0x00,   // NOP
  0x00,   // NOP     (then the PC wraps and it runs again)
];

function buildAccumulator() {
  const c = new Circuit('Accumulator Machine');
  c.implicitGround = false;

  const clkNet = c.net(), nclk = c.net(), rst = c.net();
  const clkSw = c.addSwitch('CLK', clkNet, 'toggle', 4, 6, { to: VSS });
  c.addSwitch('RST', rst, 'toggle', 4, 11, { to: VSS });
  c.addClock(clkSw, { period: 1400 });
  instantiate(c, Inverter, 20, 40, { a: clkNet, y: nclk });

  const ROW2 = 150;
  const ring = instantiate(c, ringCounter(3), 40, 0,
    { clk: clkNet, nclk, rst }, { tag: 'ring' });
  c.region('Phase ring — FETCH / DECODE / EXEC',
    36, -6, 40 + ring.w + 4, ring.h + 6);

  const nFetch = c.net();
  instantiate(c, Inverter, 40, ROW2 - 40, { a: ring.nets.p0, y: nFetch });

  const PC = instantiate(c, counter(3), 40, ROW2,
    { clk: clkNet, nclk, en: ring.nets.p0, rst }, { tag: 'pc' });
  c.region('Program counter', 36, ROW2 - 6, 40 + PC.w + 4, ROW2 + PC.h + 6);

  const xRom = 40 + PC.w + 30;
  const Rom = romArray(P1_PROGRAM, 8, 3);
  const rom = instantiate(c, Rom, xRom, ROW2,
    { a0: PC.nets.q0, a1: PC.nets.q1, a2: PC.nets.q2 }, { tag: 'rom' });

  // instruction register, held stable across all three phases
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
  c.region('Instruction register — loads only during FETCH',
    xIr - 6, ROW2 - 6, xIr + 160, ROW2 + 7 * 26 + 24);

  const xDec = xIr + 190;
  const dbind = {};
  for (let i = 0; i < 8; i++) dbind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, ROW2, dbind, { tag: 'dec' });
  c.region('Instruction decoder — one line per opcode',
    xDec - 6, ROW2 - 6, xDec + dec.w + 4, ROW2 + dec.h + 6);

  const xCtrl = xDec + dec.w + 40;
  const ctrl = instantiate(c, ControlUnit, xCtrl, ROW2, {
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
  c.region('Control unit — phase AND instruction',
    xCtrl - 6, ROW2 - 6, xCtrl + ctrl.w + 6, ROW2 + ctrl.h + 6);

  // The accumulator. Its data comes from the instruction's low nibble —
  // which for LDM *is* the immediate value — and it loads when the control
  // unit says so, which is EXEC of an LDM and no other time.
  const xAcc = xCtrl + ctrl.w + 50;
  const acc = instantiate(c, register(4), xAcc, ROW2, {
    clk: clkNet, nclk, load: ctrl.nets.accLoad,
    d0: ir[0], d1: ir[1], d2: ir[2], d3: ir[3],
  }, { tag: 'acc' });
  c.region('Accumulator — loads on EXEC of an LDM',
    xAcc - 6, ROW2 - 6, xAcc + acc.w + 6, ROW2 + acc.h + 6);

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
    c.addLamp(`ACC${i}`, acc.nets[`q${i}`], xEnd - 5, 76 + i * 4.5, { short: `ACC${i}` });
  }

  c.decoded = Array.from({ length: 16 }, (_, i) => dec.nets[`op${i}`]);
  c.phases = [ring.nets.p0, ring.nets.p1, ring.nets.p2];
  c.control = {
    pcInc: ctrl.nets.pcInc, pcLoad: ctrl.nets.pcLoad,
    irLoad: ctrl.nets.irLoad, accLoad: ctrl.nets.accLoad,
    regWrite: ctrl.nets.regWrite,
  };
  c.program = P1_PROGRAM;
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


// P1b — jumps take effect. The accumulator machine with a loadable PC.
//
// Until now JUN decoded correctly and lit its control line, and then
// nothing happened: the program counter could only count, so the machine
// walked off the end of the ROM and wrapped by accident rather than by
// instruction. Giving the PC a load input is what turns a decoded jump into
// a taken one.
//
// The precedence matters and is easy to get backwards. The PC advances
// during FETCH so the next address is ready when the instruction finishes
// — which means a jump discovered at EXEC arrives to find the counter has
// already moved on. Load therefore has to *overwrite* the incremented
// value, not combine with it.
//
// The program counts the accumulator up by loading three values, then jumps
// back to the top. With the jump working the machine runs a genuine loop:
// the PC returns to 0 because an instruction said so, and you can watch
// pcLoad fire on the edge that does it.
const P1B_PROGRAM = [
  0xD3,   // LDM 3   → ACC = 3
  0x00,   // NOP
  0xDC,   // LDM 12  → ACC = 12
  0x00,   // NOP
  0xD5,   // LDM 5   → ACC = 5
  0x00,   // NOP
  0x40,   // JUN 0   → back to the top
  0x00,   // NOP     (never reached once the jump works)
];

function buildJumpMachine() {
  const c = new Circuit('Jump Machine');
  c.implicitGround = false;

  const clkNet = c.net(), nclk = c.net(), rst = c.net();
  const clkSw = c.addSwitch('CLK', clkNet, 'toggle', 4, 6, { to: VSS });
  c.addSwitch('RST', rst, 'toggle', 4, 11, { to: VSS });
  c.addClock(clkSw, { period: 1400 });
  instantiate(c, Inverter, 20, 40, { a: clkNet, y: nclk });

  const ROW2 = 150;
  const ring = instantiate(c, ringCounter(3), 40, 0,
    { clk: clkNet, nclk, rst }, { tag: 'ring' });
  c.region('Phase ring — FETCH / DECODE / EXEC',
    36, -6, 40 + ring.w + 4, ring.h + 6);

  const nFetch = c.net();
  instantiate(c, Inverter, 40, ROW2 - 40, { a: ring.nets.p0, y: nFetch });

  // The jump target. JUN's operand nibble is the high 4 bits of a 12-bit
  // address on the real chip; this ROM is 8 words, so the low 3 bits of
  // the instruction are the whole address here. That is the one place this
  // machine simplifies the encoding, and it is because the ROM is small
  // rather than because the decode is wrong.
  // The PC is built before the instruction register exists, so its load
  // and address inputs are allocated here and driven further down — nets
  // are the wiring, so binding order does not matter.
  const pcLoadLine = c.net();
  const jumpTarget = [c.net(), c.net(), c.net()];
  const PC = instantiate(c, programCounter(3), 40, ROW2, {
    clk: clkNet, nclk, en: ring.nets.p0, rst, load: pcLoadLine,
    a0: jumpTarget[0], a1: jumpTarget[1], a2: jumpTarget[2],
  }, { tag: 'pc' });
  c.region('Program counter — counts, or loads a jump target',
    36, ROW2 - 6, 40 + PC.w + 4, ROW2 + PC.h + 6);

  const xRom = 40 + PC.w + 30;
  const Rom = romArray(P1B_PROGRAM, 8, 3);
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
  c.region('Instruction register — loads only during FETCH',
    xIr - 6, ROW2 - 6, xIr + 160, ROW2 + 7 * 26 + 24);

  const xDec = xIr + 190;
  const dbind = {};
  for (let i = 0; i < 8; i++) dbind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, ROW2, dbind, { tag: 'dec' });
  c.region('Instruction decoder — one line per opcode',
    xDec - 6, ROW2 - 6, xDec + dec.w + 4, ROW2 + dec.h + 6);

  const xCtrl = xDec + dec.w + 40;
  const ctrl = instantiate(c, ControlUnit, xCtrl, ROW2, {
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
  c.region('Control unit — phase AND instruction',
    xCtrl - 6, ROW2 - 6, xCtrl + ctrl.w + 6, ROW2 + ctrl.h + 6);

  // Close the jump loop: the control unit's pcLoad drives the PC's load,
  // and the instruction's low bits are the target address. Buffered so the
  // PC is driven by a gate rather than loading the control unit's output.
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

  const xAcc = xCtrl + ctrl.w + 50;
  const acc = instantiate(c, register(4), xAcc, ROW2, {
    clk: clkNet, nclk, load: ctrl.nets.accLoad,
    d0: ir[0], d1: ir[1], d2: ir[2], d3: ir[3],
  }, { tag: 'acc' });
  c.region('Accumulator — loads on EXEC of an LDM',
    xAcc - 6, ROW2 - 6, xAcc + acc.w + 6, ROW2 + acc.h + 6);

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
    c.addLamp(`ACC${i}`, acc.nets[`q${i}`], xEnd - 5, 76 + i * 4.5, { short: `ACC${i}` });
  }
  c.addLamp('JUMP', pcLoadLine, xEnd - 5, 98, { short: 'JMP' });

  c.decoded = Array.from({ length: 16 }, (_, i) => dec.nets[`op${i}`]);
  c.phases = [ring.nets.p0, ring.nets.p1, ring.nets.p2];
  c.control = {
    pcInc: ctrl.nets.pcInc, pcLoad: ctrl.nets.pcLoad,
    irLoad: ctrl.nets.irLoad, accLoad: ctrl.nets.accLoad,
    regWrite: ctrl.nets.regWrite,
  };
  c.program = P1B_PROGRAM;
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
  c.region('Phase ring — FETCH / DECODE / EXEC',
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
  c.region('Instruction register — loads only during FETCH',
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
  const ROW3 = ROW2 + 380;
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
  c.region('Register file — OPA names the register, exactly as the real encoding does',
    36, ROW3 - 6, 40 + rf.w + 4, ROW3 + rf.h + 6);

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
  c.region('Adder — accumulator + register + carry',
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
  c.region('Source mux — immediate for LDM, the sum for ADD',
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
  const ROW3 = ROW2 + 380;
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
  c.region('Condition tree — does this jump take?',
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
  c.region('Register file', xRf - 6, ROW3 - 6, xRf + rf.w + 4, ROW3 + rf.h + 6);

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
const P4_PROGRAM = [
  0xDF,   // 0  LDM 15     ACC = 15 (= -1)
  0xB0,   // 1  XCH r0     r0 = 15
  0xD4,   // 2  LDM 4      the countdown
  0x80,   // 3  ADD r0     ACC -= 1        ← loop body
  0x1D,   // 4  JCN 13 ─┐  loop while not zero *and* TEST is high…
  0x03,   // 5     to 3 ─┘  …to address 3, in its own byte
  0x40,   // 6  JUN ────┐   done: start over
  0x00,   // 7     to 0 ─┘
];

// The accumulator group: thirteen instructions sharing one opcode.
//
// Every machine so far has moved values around — load an immediate, add a
// register, jump. This one is about the accumulator *itself*: incrementing
// it, complementing it, rotating it through the carry, and setting or
// clearing the carry directly.
//
// The program walks through them in an order where each result is visible
// in the next, so the panel reads as a story rather than a list:
//
//   LDM 5   ACC = 5              start somewhere recognisable
//   IAC     ACC = 6              increment
//   CMA     ACC = 9              complement: 0110 → 1001
//   STC     carry = 1            set the carry by itself
//   RAL     ACC = 3, carry = 1   rotate left through carry:
//                                1001 with carry 1 in at the bottom
//                                becomes 0011, and the old bit 3 (1)
//                                becomes the new carry
//   RAR     ACC = 9, carry = 1   rotate back, which is the point — the
//                                carry makes it a 5-bit rotation, so the
//                                pair is reversible
//   CLC     carry = 0            clear it, leaving ACC at 9
//   DAC     ACC = 8              decrement: add 15, which is −1 at four
//                                bits and is why there is no subtract here
//
// Then the PC wraps to 0 and LDM 5 starts it again, so the loop is the
// whole eight-byte ROM with no jump instruction in it.
//
// RAL and RAR are the two worth watching. A rotate that dropped the top
// bit would lose information; routing it through the carry makes the
// accumulator and carry one 5-bit ring, which is how the 4004 does
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
  c.region('Phase ring — FETCH / DECODE / FETCH2 / EXEC',
    36, -6, 40 + ring.w + 4, ring.h + 6);

  const nFetch = c.net();
  instantiate(c, Inverter, 40, ROW2 - 40, { a: ring.nets.p0, y: nFetch });

  // Allocated here and driven from the control unit below: the PC is built
  // before the control unit exists, and nets are the wiring, so binding
  // order does not matter.
  const pcLoadLine = c.net();
  const pcEnable = c.net();
  const jumpTarget = [c.net(), c.net(), c.net()];
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
  c.region('Instruction register — the opcode',
    xIr - 6, ROW2 - 6, xIr + 160, ROW2 + 7 * 26 + 24);

  const xDec = xIr + 190;
  const dbind = {};
  for (let i = 0; i < 8; i++) dbind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, ROW2, dbind, { tag: 'dec' });
  c.region('Instruction decoder', xDec - 6, ROW2 - 6, xDec + dec.w + 4, ROW2 + dec.h + 6);

  const ROW3 = ROW2 + 380;
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
  }, { tag: 'ctrl' });
  c.region('Control unit — four phases',
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
  c.region('Operand register — the second byte',
    xOpr - 6, ROW2 - 6, xOpr + 150, ROW2 + 90);

  // the jump target now comes from the operand, not the opcode
  const jn = c.net();
  instantiate(c, Inverter, xOpr + 20, ROW2 + 100,
    { a: ctrl.nets.pcLoad, y: jn }, { tag: 'jn' });
  instantiate(c, Inverter, xOpr + 40, ROW2 + 100,
    { a: jn, y: pcLoadLine }, { tag: 'jp' });
  for (let i = 0; i < 3; i++) {
    const t = c.net();
    instantiate(c, Inverter, xOpr + 20, ROW2 + 124 + i * 24,
      { a: opr.nets[`q${i}`], y: t }, { tag: `jt${i}n` });
    instantiate(c, Inverter, xOpr + 40, ROW2 + 124 + i * 24,
      { a: t, y: jumpTarget[i] }, { tag: `jt${i}` });
  }

  const xRf = 260;
  const rf = instantiate(c, RegFile16x4, xRf, ROW3, {
    wa0: ir[0], wa1: ir[1], wa2: ir[2], wa3: ir[3],
    ra0: ir[0], ra1: ir[1], ra2: ir[2], ra3: ir[3],
    d0: accQ[0], d1: accQ[1], d2: accQ[2], d3: accQ[3],
    we: ctrl.nets.regWrite,
  }, { tag: 'rf' });
  c.region('Register file', xRf - 6, ROW3 - 6, xRf + rf.w + 4, ROW3 + rf.h + 6);

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
    // Two sources here, so the immediate select is derived as "not from
    // the ALU". The subtract machine has five and takes an explicit
    // accFromImm from its control unit instead — past two sources,
    // "whatever nobody else selected" stops being a definition.
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

  c.decoded = Array.from({ length: 16 }, (_, i) => dec.nets[`op${i}`]);
  c.phases = [ring.nets.p0, ring.nets.p1, ring.nets.p2, ring.nets.p3];
  c.control = {
    pcInc: ctrl.nets.pcInc, pcLoad: ctrl.nets.pcLoad,
    irLoad: ctrl.nets.irLoad, oprLoad: ctrl.nets.oprLoad,
    accLoad: ctrl.nets.accLoad, regWrite: ctrl.nets.regWrite,
  };
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
  c.region('Phase ring — FETCH / DECODE / FETCH2 / EXEC',
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
  c.region('Instruction register — the opcode',
    xIr - 6, ROW2 - 6, xIr + 160, ROW2 + 7 * 26 + 24);

  const xDec = xIr + 190;
  const dbind = {};
  for (let i = 0; i < 8; i++) dbind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, ROW2, dbind, { tag: 'dec' });
  c.region('Instruction decoder — OPR, then OPA for the 1111 group',
    xDec - 6, ROW2 - 6, xDec + dec.w + 4, ROW2 + dec.h + 6);

  // The thirteen accumulator lines, named. Reading `dec.nets.acc2` at every
  // use site would make this datapath unreadable; naming them once keeps
  // the wiring below saying what it means.
  const IAC = dec.nets.acc2, CMA = dec.nets.acc4, RAL = dec.nets.acc5;
  const RAR = dec.nets.acc6, DAC = dec.nets.acc8, CLB = dec.nets.acc0;
  const CLC = dec.nets.acc1, CMC = dec.nets.acc3, TCC = dec.nets.acc7;
  const STC = dec.nets.acc10, TCS = dec.nets.acc9;
  const DAA = dec.nets.acc11, KBP = dec.nets.acc12;

  const ROW3 = ROW2 + 380;
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
    opSUB: VSS, opLD: VSS, opXCHread: VSS,
    opLDM: dec.nets.op13,
    condTake: VSS, accGroup,
  }, { tag: 'ctrl' });
  c.region('Control unit — four phases',
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
  c.region('Adder operand — which constant this instruction adds',
    xOp - 6, ROW3 - 6, xOp + accOp.w + 20, ROW3 + accOp.h + 10);

  // DAA decides for itself whether to add 6, from the accumulator and the
  // carry — so it supplies its own constant rather than being another
  // line into AccOperand. Its `adjust` output is also what tells the
  // datapath to take the adder at all.
  const xDaa = xOp;
  const daa = instantiate(c, DecimalAdjust, xDaa, ROW3 + 130, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3], carry: carryQ,
  }, { tag: 'daa' });
  c.region('Decimal adjust — add 6 when the digit is illegal or carried',
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
  c.region('Adder B mux — DAA\u2019s 6, or the accumulator group\u2019s constant',
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
  c.region('Keyboard process — 1-of-n to binary, 1111 if more than one key',
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
  const ROW4 = ROW3 + 260;
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
  c.region('Accumulator source mux — adder / immediate / CMA / RAL / RAR',
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
  c.region('Carry logic — CLC / STC / CMC / TCC',
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
  c.region('Phase ring — FETCH / DECODE / FETCH2 / EXEC',
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
  c.region('Instruction register — the opcode',
    xIr - 6, ROW2 - 6, xIr + 160, ROW2 + 7 * 26 + 24);

  const xDec = xIr + 190;
  const dbind = {};
  for (let i = 0; i < 8; i++) dbind[`i${i}`] = ir[i];
  const dec = instantiate(c, InstructionDecoder, xDec, ROW2, dbind, { tag: 'dec' });
  c.region('Instruction decoder', xDec - 6, ROW2 - 6, xDec + dec.w + 4, ROW2 + dec.h + 6);

  const ROW3 = ROW2 + 380;
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
    opJUN: VSS, opJCN: VSS, opINC: VSS, condTake: VSS,
    opLDM: dec.nets.op13, opADD: dec.nets.op8,
    opSUB: dec.nets.op9, opLD: dec.nets.op10, opXCH: dec.nets.op11,
    // This machine reads the register file on the clock's high half and
    // writes it on the low half, so XCH is a genuine exchange.
    opXCHread: dec.nets.op11,
    accGroup: VSS,
  }, { tag: 'ctrl' });
  c.region('Control unit — four phases',
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
  const phi = instantiate(c, TwoPhaseClock, 20, 70, { clk: clkNet },
    { tag: 'phi' });
  c.region('Two-phase clock — φ2 gates the register write',
    14, 64, 20 + phi.w + 10, 70 + phi.h + 10);

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
  c.region('ADB register — the accumulator, held for the adder and for XCH',
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
  c.region('Register file — LD and SUB read it, XCH writes it',
    xRf - 6, ROW3 - 6, xRf + rf.w + 4, ROW3 + rf.h + 6);

  // SUB conditioning: complement the register and the carry, or pass both
  // through for ADD.
  const xSub = xRf + rf.w + 40;
  const subop = instantiate(c, SubOperand, xSub, ROW3, {
    r0: rf.nets.q0, r1: rf.nets.q1, r2: rf.nets.q2, r3: rf.nets.q3,
    carry: carryQ, sub: ctrl.nets.aluSub,
  }, { tag: 'subop' });
  c.region('SUB conditioning — invert the operand and the carry',
    xSub - 6, ROW3 - 6, xSub + subop.w + 20, ROW3 + subop.h + 10);

  const xAdd = xSub + subop.w + 60;
  const adder = instantiate(c, rippleAdder(4), xAdd, ROW3, {
    a0: accQ[0], a1: accQ[1], a2: accQ[2], a3: accQ[3],
    b0: subop.nets.b0, b1: subop.nets.b1,
    b2: subop.nets.b2, b3: subop.nets.b3,
    cin: subop.nets.cin,
  }, { tag: 'add' });
  c.region('Adder — shared by ADD and SUB',
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
  c.region('Accumulator source mux — adder / immediate / register',
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
  jumpmachine: {
    build: buildJumpMachine,
    readout: v => {
      const ph = PHASES[[0, 1, 2].find(i => (v.P >> i) & 1)] ?? '—';
      const name = OPR_NAMES[(v.IR >> 4) & 15] || 'escape';
      const arg = name === 'LDM' ? ` ${v.IR & 15}` : name === 'JUN' ? ` ${v.IR & 7}` : '';
      return `${ph}  ·  PC ${v.PC}  ·  ${name}${arg}  ·  ACC = ${v.ACC}`
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
  accmachine: {
    build: buildAccumulator,
    readout: v => {
      const ph = PHASES[[0, 1, 2].find(i => (v.P >> i) & 1)] ?? '—';
      const name = OPR_NAMES[(v.IR >> 4) & 15] || 'escape';
      return `${ph}  ·  PC ${v.PC}  ·  ${name}`
        + `${name === 'LDM' ? ` ${v.IR & 15}` : ''}`
        + `  ·  ACC = ${v.ACC}`;
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
