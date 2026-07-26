// CMOS circuits: complementary N/P pairs, both rails driven.
//
// The hand-routed gates (inverter, NAND, NOR, transmission gate, tri-state)
// are the teaching material and stay hand-placed. The composed machines
// below them — ALU, ROM, register file — are assembled from the modules in
// gates.js, because nobody places five hundred transistors by eye.

import { Circuit, VDD, VSS, VALUE_CHAR } from '../engine.js';
import { MOS_H, MOS_GATE, switchSpdtT } from '../geometry.js';
import { instantiate } from '../module.js';
import { And2, Or2, Xor2, DLatch, FullAdder, DFlipFlop, Inverter, counter, register } from '../gates.js';
import { Alu4, ALU_BITS } from '../alu.js';
import { decoder as cmosDecoder } from '../rom.js';
import { romArray } from '../rom.js';
import { InstructionDecoder, OPR_NAMES } from '../decode.js';
import { ringCounter, ControlUnit, PHASES } from '../sequencer.js';
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
