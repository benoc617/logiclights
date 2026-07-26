// Logic Lights — the circuit library.
//
// Every circuit here is built from nothing but relays, switches, lamps and
// wire, laid out by hand the way a relay rack would be wired. Conduction is
// undirected, so these topologies are designed sneak-path-free, like the
// real thing.

import { Circuit, VCC, VDD, VSS, VALUE_CHAR } from './engine.js';
import { MOS_H, MOS_GATE, switchSpdtT } from './geometry.js';
import { instantiate } from './module.js';
import { Alu4, ALU_BITS } from './alu.js';
import { And2, Or2, Xor2 } from './gates.js';
import { romArray } from './rom.js';
import { RegFile16x4, REG_WIDTH, REG_ADDR } from './regfile.js';

// ── small builder helpers ────────────────────────────────────────────────

function relay(c, name, coil, x, y, contacts) {
  return c.addRelay(name, coil, x, y, contacts);
}

function w(c, net, ...pts) {
  c.wire(net, ...pts);
}

// Horizontal feed from the VCC rail at x=x0 to a contact-common terminal.
function railFeed(c, x0, y, x1) {
  c.wire(VCC, [x0, y], [x1, y]);
}

// ── Basics ───────────────────────────────────────────────────────────────

function buildRelay101() {
  const c = new Circuit('Meet the Relay');
  const a = c.net(), nNC = c.net(), nNO = c.net();
  w(c, VCC, [0, -1], [0, 4.6]);
  c.label('+', 0, -1.8, 1.2, '#ffb340');

  c.addSwitch('COIL', a, 'toggle', 4, 2);
  railFeed(c, 0, 2, 3);

  relay(c, 'K1', a, 9, 1.2, [{ c: VCC, no: nNO, nc: nNC }]);
  w(c, a, [5, 2], [9, 2]);
  railFeed(c, 0, 3.8, 9);

  c.addLamp('NC · closed at rest', nNC, 18.5, 1.4, { short: 'NC' });
  w(c, nNC, [13, 3.2], [15, 3.2], [15, 1.4], [18.5, 1.4]);
  c.addLamp('NO · closed when energized', nNO, 18.5, 6, { short: 'NO' });
  w(c, nNO, [13, 4.4], [15.6, 4.4], [15.6, 6], [18.5, 6]);
  return c;
}

function buildBuzzer() {
  const c = new Circuit('Buzzer');
  const p = c.net(), bz = c.net();
  w(c, VCC, [0, -1], [0, 3]);
  c.label('+', 0, -1.8, 1.2, '#ffb340');

  c.addSwitch('PRESS', p, 'push', 4, 2);
  railFeed(c, 0, 2, 3);

  relay(c, 'K1', bz, 9, 1.2, [{ c: p, no: null, nc: bz }]);
  w(c, p, [5, 2], [6.5, 2], [6.5, 3.8], [9, 3.8]);
  // The NC contact feeds the coil: energize -> contact opens -> drop out -> repeat.
  w(c, bz, [13, 3.2], [15, 3.2], [15, 0.2], [7.6, 0.2], [7.6, 2], [9, 2]);
  w(c, bz, [15, 3.2], [15, 6], [18, 6]);
  c.addLamp('OUT', bz, 18, 6);
  return c;
}

function buildOscillator() {
  const c = new Circuit('Ring Oscillator');
  const run = c.net(), n1 = c.net(), n2 = c.net(), n3 = c.net();
  w(c, VCC, [0, -2], [0, 10]);
  c.label('+', 0, -2.8, 1.2, '#ffb340');

  c.addSwitch('RUN', run, 'toggle', 3, 9);
  railFeed(c, 0, 9, 2);

  relay(c, 'K1', n3, 6, 1.2, [{ c: VCC, no: null, nc: n1 }]);
  relay(c, 'K2', n1, 14, 1.2, [{ c: VCC, no: null, nc: n2 }]);
  relay(c, 'K3', n2, 22, 1.2, [{ c: run, no: null, nc: n3 }]);

  railFeed(c, 0, 3.8, 6);                                   // K1 common
  w(c, VCC, [0, 0.2], [12.8, 0.2], [12.8, 3.8], [14, 3.8]); // K2 common
  w(c, run, [4, 9], [20.5, 9], [20.5, 3.8], [22, 3.8]);     // K3 common

  w(c, n1, [10, 3.2], [11.5, 3.2], [11.5, 2], [14, 2]);
  w(c, n1, [11.5, 3.2], [11.5, 7], [8, 7]);
  c.addLamp('1', n1, 8, 7, { short: 'N1' });

  w(c, n2, [18, 3.2], [19.5, 3.2], [19.5, 2], [22, 2]);
  w(c, n2, [19.5, 3.2], [19.5, 7], [16, 7]);
  c.addLamp('2', n2, 16, 7, { short: 'N2' });

  w(c, n3, [26, 3.2], [27.5, 3.2], [27.5, -0.8], [4.6, -0.8], [4.6, 2], [6, 2]);
  w(c, n3, [27.5, 3.2], [27.5, 7], [24, 7]);
  c.addLamp('3', n3, 24, 7, { short: 'N3' });
  return c;
}

// ── Gate scaffolding: rail + A/B switches ────────────────────────────────

function gateScaffold(c, twoInputs) {
  const a = c.net();
  w(c, VCC, [0, -1], [0, twoInputs ? 12 : 5]);
  c.label('+', 0, -1.8, 1.2, '#ffb340');
  c.addSwitch('A', a, 'toggle', 4, 2);
  railFeed(c, 0, 2, 3);
  w(c, a, [5, 2], [9, 2]);
  let b = null;
  if (twoInputs) {
    b = c.net();
    c.addSwitch('B', b, 'toggle', 4, 9);
    railFeed(c, 0, 9, 3);
    w(c, b, [5, 9], [9, 9]);
  }
  return { a, b };
}

function buildNot() {
  const c = new Circuit('NOT');
  const { a } = gateScaffold(c, false);
  const out = c.net();
  relay(c, 'K1', a, 9, 1.2, [{ c: VCC, no: null, nc: out }]);
  railFeed(c, 0, 3.8, 9);
  w(c, out, [13, 3.2], [15, 3.2], [15, 6], [18, 6]);
  c.addLamp('OUT', out, 18, 6);
  return c;
}

function buildAnd() {
  const c = new Circuit('AND');
  const { a, b } = gateScaffold(c, true);
  const mid = c.net(), out = c.net();
  relay(c, 'KA', a, 9, 1.2, [{ c: VCC, no: mid, nc: null }]);
  relay(c, 'KB', b, 9, 8.2, [{ c: mid, no: out, nc: null }]);
  railFeed(c, 0, 3.8, 9);
  w(c, mid, [13, 4.4], [14.5, 4.4], [14.5, 7.4], [7.5, 7.4], [7.5, 10.8], [9, 10.8]);
  w(c, out, [13, 11.4], [15, 11.4], [15, 7], [18, 7]);
  c.addLamp('OUT', out, 18, 7);
  return c;
}

function buildOr() {
  const c = new Circuit('OR');
  const { a, b } = gateScaffold(c, true);
  const out = c.net();
  relay(c, 'KA', a, 9, 1.2, [{ c: VCC, no: out, nc: null }]);
  relay(c, 'KB', b, 9, 8.2, [{ c: VCC, no: out, nc: null }]);
  railFeed(c, 0, 3.8, 9);
  railFeed(c, 0, 10.8, 9);
  w(c, out, [13, 4.4], [15, 4.4], [15, 11.4], [13, 11.4]);
  w(c, out, [15, 7], [18, 7]);
  c.addLamp('OUT', out, 18, 7);
  return c;
}

function buildNand() {
  const c = new Circuit('NAND');
  const { a, b } = gateScaffold(c, true);
  const out = c.net();
  relay(c, 'KA', a, 9, 1.2, [{ c: VCC, no: null, nc: out }]);
  relay(c, 'KB', b, 9, 8.2, [{ c: VCC, no: null, nc: out }]);
  railFeed(c, 0, 3.8, 9);
  railFeed(c, 0, 10.8, 9);
  w(c, out, [13, 3.2], [15, 3.2], [15, 10.2], [13, 10.2]);
  w(c, out, [15, 7], [18, 7]);
  c.addLamp('OUT', out, 18, 7);
  return c;
}

function buildNor() {
  const c = new Circuit('NOR');
  const { a, b } = gateScaffold(c, true);
  const mid = c.net(), out = c.net();
  relay(c, 'KA', a, 9, 1.2, [{ c: VCC, no: null, nc: mid }]);
  relay(c, 'KB', b, 9, 8.2, [{ c: mid, no: null, nc: out }]);
  railFeed(c, 0, 3.8, 9);
  w(c, mid, [13, 3.2], [14.5, 3.2], [14.5, 7.4], [7.5, 7.4], [7.5, 10.8], [9, 10.8]);
  w(c, out, [13, 10.2], [15, 10.2], [15, 7], [18, 7]);
  c.addLamp('OUT', out, 18, 7);
  return c;
}

function buildXor() {
  const c = new Circuit('XOR');
  const { a, b } = gateScaffold(c, true);
  const x1 = c.net(), x0 = c.net(), out = c.net();
  relay(c, 'KA', a, 9, 1.2, [{ c: VCC, no: x1, nc: x0 }]);
  relay(c, 'KB', b, 9, 8.2, [
    { c: x1, no: null, nc: out },  // A and not B
    { c: x0, no: out, nc: null },  // not A and B
  ]);
  railFeed(c, 0, 3.8, 9);
  w(c, x1, [13, 4.4], [14.6, 4.4], [14.6, 7.2], [7.4, 7.2], [7.4, 10.8], [9, 10.8]);
  w(c, x0, [13, 3.2], [15.3, 3.2], [15.3, 6.4], [6.6, 6.4], [6.6, 12.8], [9, 12.8]);
  w(c, out, [13, 13.4], [16, 13.4], [16, 10.2], [13, 10.2]);
  w(c, out, [16, 10.2], [16, 7], [18, 7]);
  c.addLamp('OUT', out, 18, 7);
  return c;
}

function buildDecoder() {
  const c = new Circuit('2-to-4 Decoder');
  const { a, b } = gateScaffold(c, true);
  const y0 = c.net(), y1 = c.net();
  const o = [c.net(), c.net(), c.net(), c.net()];
  relay(c, 'KA', a, 9, 1.2, [{ c: VCC, no: y1, nc: y0 }]);
  relay(c, 'KB', b, 9, 8.2, [
    { c: y0, no: o[2], nc: o[0] },
    { c: y1, no: o[3], nc: o[1] },
  ]);
  railFeed(c, 0, 3.8, 9);
  w(c, y0, [13, 3.2], [14.2, 3.2], [14.2, 6.6], [6.6, 6.6], [6.6, 10.8], [9, 10.8]);
  w(c, y1, [13, 4.4], [15.4, 4.4], [15.4, 5.9], [7.4, 5.9], [7.4, 12.8], [9, 12.8]);
  const lampY = [9, 11.5, 14, 16.5];
  const src = [[13, 10.2], [13, 12.2], [13, 11.4], [13, 13.4]];
  const lane = [14.5, 15.1, 15.8, 16.5];
  for (let i = 0; i < 4; i++) {
    w(c, o[i], src[i], [lane[i], src[i][1]], [lane[i], lampY[i]], [19, lampY[i]]);
    c.addLamp(`BA = ${i.toString(2).padStart(2, '0')}`, o[i], 19, lampY[i], { short: `Y${i}` });
  }
  return c;
}

// ── Memory ───────────────────────────────────────────────────────────────

function buildSrLatch() {
  const c = new Circuit('SR Latch');
  const L = c.net(), h = c.net(), q = c.net();
  w(c, VCC, [0, -1], [0, 8]);
  c.label('+', 0, -1.8, 1.2, '#ffb340');

  c.addSwitch('SET', L, 'push', 4, 2);
  railFeed(c, 0, 2, 3);
  c.addSwitch('RESET', h, 'push-nc', 4, 7);
  railFeed(c, 0, 7, 3);

  relay(c, 'K1', L, 9, 1.2, [
    { c: h, no: L, nc: null },   // hold path, broken by RESET
    { c: VCC, no: q, nc: null }, // output pole
  ]);
  w(c, L, [5, 2], [9, 2]);
  w(c, h, [5, 7], [7, 7], [7, 3.8], [9, 3.8]);
  w(c, L, [13, 4.4], [14.5, 4.4], [14.5, 0.2], [7.6, 0.2], [7.6, 2], [9, 2]);
  railFeed(c, 0, 5.8, 9);
  w(c, q, [13, 6.4], [18, 6.4]);
  c.addLamp('Q', q, 18, 6.4);
  return c;
}

function buildDLatch() {
  const c = new Circuit('D Latch');
  const d = c.net(), en = c.net(), g = c.net(), s = c.net(), qc = c.net(), q = c.net();
  w(c, VCC, [0, -1], [0, 19]);
  c.label('+', 0, -1.8, 1.2, '#ffb340');

  c.addSwitch('D', d, 'toggle', 4, 2);
  railFeed(c, 0, 2, 3);
  c.addSwitch('EN', en, 'toggle', 4, 8);
  railFeed(c, 0, 8, 3);

  relay(c, 'KD', d, 9, 1.2, [{ c: VCC, no: g, nc: null }]);
  relay(c, 'KE', en, 9, 7.2, [
    { c: g, no: qc, nc: null },  // EN on: Q follows D
    { c: s, no: null, nc: qc },  // EN off: Q holds itself
  ]);
  relay(c, 'KQ', qc, 9, 14.2, [
    { c: VCC, no: s, nc: null },
    { c: VCC, no: q, nc: null },
  ]);

  w(c, d, [5, 2], [9, 2]);
  w(c, en, [5, 8], [9, 8]);
  railFeed(c, 0, 3.8, 9);
  w(c, g, [13, 4.4], [14.5, 4.4], [14.5, 6.6], [7, 6.6], [7, 9.8], [9, 9.8]);
  w(c, qc, [13, 10.4], [15.2, 10.4], [15.2, 13.2], [7, 13.2], [7, 15], [9, 15]);
  w(c, qc, [13, 11.2], [15.2, 11.2]);
  railFeed(c, 0, 16.8, 9);
  w(c, s, [13, 17.4], [16.2, 17.4], [16.2, 14.6], [6.4, 14.6], [6.4, 11.8], [9, 11.8]);
  railFeed(c, 0, 18.8, 9);
  w(c, q, [13, 19.4], [18, 19.4]);
  c.addLamp('Q', q, 18, 19.4);
  return c;
}

function buildRegister4() {
  const c = new Circuit('4-bit Register');
  const load = c.net();
  w(c, VCC, [0, -1], [0, 3]);
  w(c, VCC, [0, -1], [62, -1]);
  c.label('+', -0.8, -1, 1.2, '#ffb340');

  c.addSwitch('LOAD', load, 'push', 3, 2);
  railFeed(c, 0, 2, 2);

  const bits = [];
  for (let i = 0; i < 4; i++) bits.push({
    d: c.net(), g: c.net(), s: c.net(), qc: c.net(), q: c.net(),
    xb: 16 + (3 - i) * 13,
  });
  const enContacts = [];
  for (let i = 0; i < 4; i++) {
    enContacts.push({ c: bits[i].g, no: bits[i].qc, nc: null });
    enContacts.push({ c: bits[i].s, no: null, nc: bits[i].qc });
  }
  relay(c, 'KEN', load, 6, 1.2, enContacts);
  w(c, load, [4, 2], [6, 2]);

  for (let i = 0; i < 4; i++) {
    const { d, g, s, qc, q, xb } = bits[i];
    c.addSwitch(`D${i}`, d, 'toggle', xb - 3, 2);
    w(c, VCC, [xb - 4, -1], [xb - 4, 2]);

    relay(c, `KD${i}`, d, xb, 1.2, [{ c: VCC, no: g, nc: null }]);
    relay(c, `KQ${i}`, qc, xb, 7.2, [
      { c: VCC, no: s, nc: null },
      { c: VCC, no: q, nc: null },
    ]);
    w(c, d, [xb - 2, 2], [xb, 2]);
    // shared VCC drop for the three commons of this bit
    w(c, VCC, [xb - 5.2, -1], [xb - 5.2, 11.8]);
    w(c, VCC, [xb - 5.2, 3.8], [xb, 3.8]);
    w(c, VCC, [xb - 5.2, 9.8], [xb, 9.8]);
    w(c, VCC, [xb - 5.2, 11.8], [xb, 11.8]);

    const yG = 3.8 + 4 * i, yS = 5.8 + 4 * i;
    const laneG = 4.6 - i * 0.4, laneS = 2.6 - i * 0.4;
    w(c, g, [xb + 4, 4.4], [xb + 5, 4.4], [xb + 5, 20 + i * 0.7],
      [laneG, 20 + i * 0.7], [laneG, yG], [6, yG]);
    w(c, s, [xb + 4, 10.4], [xb + 5.6, 10.4], [xb + 5.6, 23 + i * 0.7],
      [laneS, 23 + i * 0.7], [laneS, yS], [6, yS]);
    const joinX = 10.6 + i * 0.4;
    w(c, qc, [10, yG + 0.6], [joinX, yG + 0.6], [joinX, yS - 0.6], [10, yS - 0.6]);
    w(c, qc, [joinX, yS - 0.6], [joinX, 26 + i * 0.7], [xb - 6.4, 26 + i * 0.7],
      [xb - 6.4, 8], [xb, 8]);

    w(c, q, [xb + 4, 12.4], [xb + 6.2, 12.4], [xb + 6.2, -3.5], [xb + 2, -3.5]);
    c.addLamp(`Q${i}`, q, xb + 2, -3.5);
  }
  return c;
}

// ── Arithmetic ───────────────────────────────────────────────────────────

function buildHalfAdder() {
  const c = new Circuit('Half Adder');
  const { a, b } = gateScaffold(c, true);
  const x1 = c.net(), x0 = c.net(), m = c.net(), sum = c.net(), carry = c.net();
  relay(c, 'KA', a, 9, 1.2, [
    { c: VCC, no: x1, nc: x0 },
    { c: VCC, no: m, nc: null },
  ]);
  relay(c, 'KB', b, 9, 8.2, [
    { c: x1, no: null, nc: sum },
    { c: x0, no: sum, nc: null },
    { c: m, no: carry, nc: null },
  ]);
  railFeed(c, 0, 3.8, 9);
  railFeed(c, 0, 5.8, 9);
  w(c, x1, [13, 4.4], [14.4, 4.4], [14.4, 7.2], [7.4, 7.2], [7.4, 10.8], [9, 10.8]);
  w(c, x0, [13, 3.2], [15.1, 3.2], [15.1, 6.5], [6.7, 6.5], [6.7, 12.8], [9, 12.8]);
  w(c, m, [13, 6.4], [15.8, 6.4], [15.8, 7.9], [6.0, 7.9], [6.0, 14.8], [9, 14.8]);
  w(c, sum, [13, 10.2], [16, 10.2], [16, 13.4], [13, 13.4]);
  w(c, sum, [16, 10.2], [19, 10.2]);
  c.addLamp('SUM', sum, 19, 10.2);
  w(c, carry, [13, 15.4], [19, 15.4]);
  c.addLamp('CARRY', carry, 19, 15.4);
  return c;
}

// One full-adder cell: 3 relays, 11 contacts. Origin (cx, cy) is the
// top-left of relay A. The sum lamp goes above the cell; the carry is
// collected on a lane at the cell's right edge for the ripple chain.
function faCell(c, cx, cy, aNet, bNet, cinNet, bitLabel) {
  const p0 = c.net(), p1 = c.net(), q0 = c.net(), q1 = c.net();
  const m1 = c.net(), m2 = c.net(), m3 = c.net();
  const sum = c.net(), cout = c.net();

  relay(c, `A${bitLabel}`, aNet, cx, cy, [
    { c: VCC, no: p1, nc: p0 },
    { c: VCC, no: m1, nc: null },
    { c: VCC, no: m3, nc: null },
  ]);
  relay(c, `B${bitLabel}`, bNet, cx + 7, cy, [
    { c: p0, no: q1, nc: q0 },
    { c: p1, no: q0, nc: q1 },
    { c: m1, no: cout, nc: null },
    { c: VCC, no: m2, nc: null },
  ]);
  relay(c, `C${bitLabel}`, cinNet, cx + 14, cy, [
    { c: q1, no: null, nc: sum },
    { c: q0, no: sum, nc: null },
    { c: m2, no: cout, nc: null },
    { c: m3, no: cout, nc: null },
  ]);

  const Y = dy => cy + dy;
  const chP0 = Y(12.4), chP1 = Y(13.0), chQ0 = Y(13.6), chQ1 = Y(14.2);
  const chM3 = Y(14.8), chCout = Y(16.0), chVCC = Y(16.6);
  const LV = cx - 0.6;

  // VCC to the five commons that need it
  w(c, VCC, [cx, Y(2.6)], [LV, Y(2.6)]);
  w(c, VCC, [cx, Y(4.6)], [LV, Y(4.6)]);
  w(c, VCC, [cx, Y(6.6)], [LV, Y(6.6)]);
  w(c, VCC, [LV, Y(2.6)], [LV, chVCC], [cx + 5.6, chVCC]);
  w(c, VCC, [cx + 7, Y(8.6)], [cx + 5.6, Y(8.6)], [cx + 5.6, chVCC]);

  // parity staircase, stage A -> B
  w(c, p0, [cx + 4, Y(2.0)], [cx + 4.5, Y(2.0)], [cx + 4.5, chP0],
    [cx + 6.5, chP0], [cx + 6.5, Y(2.6)], [cx + 7, Y(2.6)]);
  w(c, p1, [cx + 4, Y(3.2)], [cx + 5.0, Y(3.2)], [cx + 5.0, chP1],
    [cx + 6.0, chP1], [cx + 6.0, Y(4.6)], [cx + 7, Y(4.6)]);
  // stage B -> C
  w(c, q1, [cx + 11, Y(3.2)], [cx + 11.5, Y(3.2)], [cx + 11.5, chQ1],
    [cx + 13.5, chQ1], [cx + 13.5, Y(2.6)], [cx + 14, Y(2.6)]);
  w(c, q1, [cx + 11, Y(4.0)], [cx + 11.5, Y(4.0)]);
  w(c, q0, [cx + 11, Y(2.0)], [cx + 12.0, Y(2.0)], [cx + 12.0, chQ0],
    [cx + 13.0, chQ0], [cx + 13.0, Y(4.6)], [cx + 14, Y(4.6)]);
  w(c, q0, [cx + 11, Y(5.2)], [cx + 12.0, Y(5.2)]);
  // majority-carry rungs
  w(c, m1, [cx + 4, Y(5.2)], [cx + 5.75, Y(5.2)], [cx + 5.75, Y(6.6)], [cx + 7, Y(6.6)]);
  w(c, m2, [cx + 11, Y(9.2)], [cx + 12.5, Y(9.2)], [cx + 12.5, Y(6.6)], [cx + 14, Y(6.6)]);
  w(c, m3, [cx + 4, Y(7.2)], [cx + 5.5, Y(7.2)], [cx + 5.5, chM3],
    [cx + 13.75, chM3], [cx + 13.75, Y(8.6)], [cx + 14, Y(8.6)]);
  // sum up to the lamp row
  w(c, sum, [cx + 18, Y(2.0)], [cx + 18.6, Y(2.0)], [cx + 18.6, Y(-2.5)], [cx + 16, Y(-2.5)]);
  w(c, sum, [cx + 18, Y(5.2)], [cx + 18.6, Y(5.2)]);
  c.addLamp(`S${bitLabel}`, sum, cx + 16, Y(-2.5), { above: true });
  // carry-out collection
  w(c, cout, [cx + 11, Y(7.2)], [cx + 11.75, Y(7.2)], [cx + 11.75, chCout], [cx + 19.2, chCout]);
  w(c, cout, [cx + 18, Y(7.2)], [cx + 19.2, Y(7.2)], [cx + 19.2, chCout]);
  w(c, cout, [cx + 18, Y(9.2)], [cx + 19.2, Y(9.2)]);

  return { sum, cout, chCout, coutLaneX: cx + 19.2 };
}

const FA_PITCH = 22;

// Ripple-carry adder built into an existing Circuit. When opts.bNets is
// given, B coils are driven externally (adder/subtractor); otherwise B
// toggles are created. When opts.cinNet is given, no Cin switch is made.
function rippleAdder(c, N, opts = {}) {
  const cxOf = i => (N - 1 - i) * FA_PITCH;
  const busY = 24.5;
  const railX = cxOf(N - 1) - 8;

  const aNets = [], bNets = [], cells = [];
  for (let i = 0; i < N; i++) {
    aNets.push(c.net());
    bNets.push(opts.bNets ? opts.bNets[i] : c.net());
  }
  const cin0 = opts.cinNet ?? c.net();

  for (let i = 0; i < N; i++) {
    const cx = cxOf(i);
    const cinNet = i === 0 ? cin0 : cells[i - 1].cout;
    cells.push(faCell(c, cx, 0, aNets[i], bNets[i], cinNet, String(i)));

    c.addSwitch(`A${i}`, aNets[i], 'toggle', cx - 2.6, 21.5);
    w(c, aNets[i], [cx - 1.6, 21.5], [cx - 1.4, 21.5], [cx - 1.4, 0.8], [cx, 0.8]);
    w(c, VCC, [cx - 3.6, 21.5], [cx - 3.6, busY]);
    if (!opts.bNets) {
      c.addSwitch(`B${i}`, bNets[i], 'toggle', cx + 4.4, 21.5);
      w(c, bNets[i], [cx + 5.4, 21.5], [cx + 6.4, 21.5], [cx + 6.4, 0.8], [cx + 7, 0.8]);
      w(c, VCC, [cx + 3.4, 21.5], [cx + 3.4, busY]);
    }
    if (i > 0) {
      const prev = cells[i - 1];
      const carryY = 18.0 + (i % 2) * 0.6;
      w(c, prev.cout, [prev.coutLaneX, prev.chCout], [prev.coutLaneX, carryY],
        [cx + 13.2, carryY], [cx + 13.2, 0.8], [cx + 14, 0.8]);
    }
  }

  if (!opts.cinNet) {
    const sw = c.addSwitch('Cin', cin0, 'toggle', cxOf(0) + 23, 0.8);
    sw.flip = true; // output faces left, toward the C-relay coil
    w(c, VCC, [cxOf(0) + 24, 0.8], [cxOf(0) + 25, 0.8], [cxOf(0) + 25, busY]);
    w(c, cin0, [cxOf(0) + 22, 0.8], [cxOf(0) + 14, 0.8]);
  }

  // final carry-out lamp, top left
  const top = cells[N - 1];
  const cxT = cxOf(N - 1);
  const carryY = 18.0 + (N % 2) * 0.6;
  w(c, top.cout, [top.coutLaneX, top.chCout], [top.coutLaneX, carryY],
    [cxT - 6, carryY], [cxT - 6, -2.5], [cxT - 4, -2.5]);
  c.addLamp('Cout', top.cout, cxT - 4, -2.5, { above: true });
  c.addBus('CARRY', cells.map(cell => cell.cout));

  w(c, VCC, [railX, busY], [cxOf(0) + 25, busY]);
  c.label('+', railX - 0.8, busY, 1.2, '#ffb340');

  return { aNets, bNets, cin0, cells, cxOf, busY };
}

function buildFullAdder() {
  const c = new Circuit('Full Adder');
  rippleAdder(c, 1);
  return c;
}
function buildAdder4() {
  const c = new Circuit('4-bit Ripple Adder');
  rippleAdder(c, 4);
  return c;
}
function buildAdder8() {
  const c = new Circuit('8-bit Ripple Adder');
  rippleAdder(c, 8);
  return c;
}

function buildAddSub4() {
  const N = 4;
  const c = new Circuit('4-bit Adder / Subtractor');
  const beff = [], bIn = [], bt = [], bf = [];
  for (let i = 0; i < N; i++) {
    beff.push(c.net()); bIn.push(c.net()); bt.push(c.net()); bf.push(c.net());
  }
  const sub = c.net();

  const { cxOf, busY } = rippleAdder(c, N, { bNets: beff, cinNet: sub });

  // SUB toggle, top-left: feeds the inverter-select relay AND the carry-in
  // (two's complement: A - B = A + ~B + 1).
  const subX = cxOf(N - 1) - 6;
  w(c, VCC, [subX - 1, -4.5], [subX - 1.6, -4.5], [subX - 1.6, busY]);
  w(c, sub, [subX + 1, -4.5], [cxOf(0) + 13.4, -4.5], [cxOf(0) + 13.4, 0.8], [cxOf(0) + 14, 0.8]);

  // selector relay: 8 poles, two per bit, picks B or not-B
  const rsx = cxOf(0) + 24;
  const subContacts = [];
  for (let i = 0; i < N; i++) subContacts.push(
    { c: bt[i], no: null, nc: beff[i] },  // pass B when adding
    { c: bf[i], no: beff[i], nc: null },  // pass not-B when subtracting
  );
  relay(c, 'KSUB', sub, rsx, 28, subContacts);
  w(c, sub, [cxOf(0) + 13.4, -4.5], [rsx - 1.4, -4.5], [rsx - 1.4, 28.8], [rsx, 28.8]);

  for (let i = 0; i < N; i++) {
    const cx = cxOf(i);
    // B input toggle + its inverter relay (gives both B and not-B)
    c.addSwitch(`B${i}`, bIn[i], 'toggle', cx + 4.4, 28.5);
    w(c, VCC, [cx + 3.4, 28.5], [cx + 3.4, busY]);
    relay(c, `KN${i}`, bIn[i], cx + 7.5, 30.5, [{ c: VCC, no: bt[i], nc: bf[i] }]);
    w(c, bIn[i], [cx + 5.4, 28.5], [cx + 6.6, 28.5], [cx + 6.6, 31.3], [cx + 7.5, 31.3]);
    w(c, VCC, [cx + 3.4, busY], [cx + 3.4, 33.1], [cx + 7.5, 33.1]);

    // bt/bf across to KSUB's commons (contact 2i at yT, 2i+1 at yF)
    const yT = 30.6 + 4 * i, yF = 32.6 + 4 * i;
    w(c, bt[i], [cx + 11.5, 33.7], [cx + 12.3, 33.7], [cx + 12.3, 37.5 + i * 0.6],
      [rsx - 3 - i * 0.5, 37.5 + i * 0.6], [rsx - 3 - i * 0.5, yT], [rsx, yT]);
    w(c, bf[i], [cx + 11.5, 32.5], [cx + 12.8, 32.5], [cx + 12.8, 46.5 + i * 0.6],
      [rsx - 6 - i * 0.5, 46.5 + i * 0.6], [rsx - 6 - i * 0.5, yF], [rsx, yF]);

    // B-effective back to the adder's B coil (throws: 2i nc, 2i+1 no)
    const yA = yT - 0.6, yB = yF + 0.6;
    w(c, beff[i], [rsx + 4, yA], [rsx + 5.2 + i * 0.5, yA],
      [rsx + 5.2 + i * 0.5, 51 + i * 0.6], [cx + 6.4, 51 + i * 0.6],
      [cx + 6.4, 0.8], [cx + 7, 0.8]);
    w(c, beff[i], [rsx + 4, yB], [rsx + 5.2 + i * 0.5, yB]);
  }
  // added last so the I/O table lists the mode switch after both operands
  c.addSwitch('SUB', sub, 'toggle', subX, -4.5);
  c.addBus('Beff', beff);
  return c;
}

// ── Solid state ──────────────────────────────────────────────────────────
//
// Everything below wires both rails explicitly and turns off the implicit
// ground, so a net that nothing drives really does float. That is what makes
// Z (floating) and X (two sources fighting) visible instead of silently
// reading as zero — and a missing pull-up becomes a bug you can see.

// Two rails plus a column of changeover inputs down the left. The inputs are
// changeovers, not simple make contacts: a MOS gate must be driven both ways,
// and leaving one floating is a fault, not an input state.
function mosScaffold(c, xEnd, yTop, yBot, inputs) {
  c.implicitGround = false;
  w(c, VDD, [0, yTop], [xEnd, yTop]);
  w(c, VSS, [0, yBot], [xEnd, yBot]);
  c.label('+V', -1.3, yTop, 1.1, '#ffb340');
  c.label('GND', -1.9, yBot, 1.1, '#7f8aa3');
  const nets = {};
  for (const [label, y] of inputs) {
    const n = c.net();
    nets[label] = n;
    const s = c.addSwitch(label, n, 'toggle', 4.2, y, { to: VSS });
    const t = switchSpdtT(s);
    w(c, VDD, [2.4, yTop], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
    w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
  }
  return nets;
}

// A CMOS inverter in one column: PMOS pulls up, NMOS pulls down, and exactly
// one of them is ever on. Returns the gate spine so callers can tap it.
function cmosInv(c, tag, inNet, outNet, x, yTop, yBot) {
  const yP = yTop + 2, yN = yBot - 4.4;
  c.addTransistor(`${tag}p`, 'pmos', inNet, VDD, outNet, x, yP);
  c.addTransistor(`${tag}n`, 'nmos', inNet, outNet, VSS, x, yN);
  w(c, VDD, [x, yTop], [x, yP]);
  w(c, outNet, [x, yP + MOS_H], [x, yN]);
  w(c, VSS, [x, yN + MOS_H], [x, yBot]);
  const gx = x - MOS_GATE;
  w(c, inNet, [gx, yP + MOS_H / 2], [gx, yN + MOS_H / 2]);
  return { gx, gyP: yP + MOS_H / 2, gyN: yN + MOS_H / 2 };
}

function buildTransistor101() {
  const c = new Circuit('Meet the Transistor');
  const yTop = 0, yBot = 15;
  const { GATE } = mosScaffold(c, 32, yTop, yBot, [['GATE', 7.5]]);

  // N-channel: the gate attracts a conducting channel when it goes high.
  const outN = c.net();
  c.addTransistor('N1', 'nmos', GATE, VDD, outN, 13, 2);
  c.addResistor('R1', outN, VSS, 13, 9.6, { vert: true });
  w(c, VDD, [13, yTop], [13, 2]);
  w(c, outN, [13, 4.4], [13, 8.4]);
  w(c, VSS, [13, 10.8], [13, yBot]);
  w(c, outN, [13, 6], [18, 6]);
  c.addLamp('N-channel', outN, 18, 6, { short: 'NMOS' });

  // P-channel: the exact complement, on when the gate is low.
  const outP = c.net();
  c.addTransistor('P1', 'pmos', GATE, VDD, outP, 24, 2);
  c.addResistor('R2', outP, VSS, 24, 9.6, { vert: true });
  w(c, VDD, [24, yTop], [24, 2]);
  w(c, outP, [24, 4.4], [24, 8.4]);
  w(c, VSS, [24, 10.8], [24, yBot]);
  w(c, outP, [24, 6], [29, 6]);
  c.addLamp('P-channel', outP, 29, 6, { short: 'PMOS' });

  // one gate signal, both devices
  w(c, GATE, [5.2, 7.5], [11.5, 7.5], [11.5, 3.2]);
  w(c, GATE, [11.5, 7.5], [22.5, 7.5], [22.5, 3.2]);
  c.label('pull-down', 16.6, 9.6, 0.8);
  c.label('pull-down', 27.6, 9.6, 0.8);
  return c;
}

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

// NMOS logic is the pull-down network alone: a resistor holds the output
// high, and whatever pattern of N-channels you wire below it decides when
// the output gets pulled down. Series is NAND, parallel is NOR — the same
// two shapes as CMOS, but with no complementary network above, which is why
// NMOS needs roughly half the transistors and pays for it in static current.
function nmosGate(name, series, invert) {
  return () => {
    const c = new Circuit(name);
    const yTop = 0, yBot = 20;
    const { A, B } = mosScaffold(c, 32, yTop, yBot, [['A', 5], ['B', 10]]);
    const out = c.net();
    c.addResistor('RL', VDD, out, 14, 2, { vert: true });
    w(c, VDD, [14, yTop], [14, 0.8]);

    if (series) {
      // both must be high to reach ground → NAND
      const mid = c.net();
      c.addTransistor('NA', 'nmos', A, out, mid, 14, 7);
      c.addTransistor('NB', 'nmos', B, mid, VSS, 14, 12);
      w(c, out, [14, 3.2], [14, 7]);
      w(c, mid, [14, 9.4], [14, 12]);
      w(c, VSS, [14, 14.4], [14, yBot]);
      w(c, A, [5.2, 5], [12.5, 5], [12.5, 8.2]);
      w(c, B, [5.2, 10], [10, 10], [10, 13.2], [12.5, 13.2]);
    } else {
      // either one high reaches ground → NOR
      c.addTransistor('NA', 'nmos', A, out, VSS, 14, 8);
      c.addTransistor('NB', 'nmos', B, out, VSS, 20, 8);
      w(c, out, [14, 3.2], [14, 8]);
      w(c, out, [14, 5.6], [20, 5.6], [20, 8]);
      w(c, VSS, [14, 10.4], [14, yBot]);
      w(c, VSS, [20, 10.4], [20, yBot]);
      w(c, A, [5.2, 5], [12.5, 5], [12.5, 9.2]);
      w(c, B, [5.2, 10], [10, 10], [10, 16], [18.5, 16], [18.5, 9.2]);
    }

    // AND and OR are the inverted forms, so they cost an extra inverter —
    // exactly as in CMOS, and the reason NAND and NOR are the primitives.
    let final = out;
    if (invert) {
      final = c.net();
      c.addResistor('RL2', VDD, final, 26, 2, { vert: true });
      c.addTransistor('NI', 'nmos', out, final, VSS, 26, 8);
      w(c, VDD, [26, yTop], [26, 0.8]);
      w(c, final, [26, 3.2], [26, 8]);
      w(c, VSS, [26, 10.4], [26, yBot]);
      w(c, out, [14, 6.5], [24.5, 6.5], [24.5, 9.2]);
    }
    w(c, final, [invert ? 26 : 14, 6.5], [invert ? 30 : 28, 6.5]);
    c.addLamp('OUT', final, invert ? 30 : 28, 6.5);
    return c;
  };
}

// A ring oscillator in silicon. Same idea as the relay version — an odd
// number of inversions can never settle — but where the relay ring ticks at
// armature speed you can watch, this one runs at transistor speed, which is
// the whole point of the comparison. Ring oscillators are also how you
// measure a real process: fabricate one, count the frequency, and you know
// how fast the transistors are.
//
// `stages` counts the plain inverters only. The run/stop NAND at the head
// of the ring is itself an inversion, so the total is stages + 1 and
// `stages` must be EVEN — two inverters plus the NAND is three inversions.
// Three inverters would make four, which is even, and the ring would simply
// sit in a stable state.
function buildRing(name, kind, stages) {
  if (stages % 2 !== 0) {
    throw new Error(`${name}: stages must be even (the gating NAND inverts too)`);
  }
  return () => {
    const c = new Circuit(name);
    const yTop = 0, yBot = 18;
    const { RUN } = mosScaffold(c, 12 + stages * 12, yTop, yBot, [['RUN', 8]]);

    const nets = [];
    for (let i = 0; i < stages; i++) nets.push(c.net());

    // A real ring starts itself: thermal noise is enough, because the loop
    // has gain and any imbalance runs away. This model has no noise, and a
    // floating gate turns its transistor off, so a CMOS ring would sit at Z
    // at power-on and never move. One weak pull-down gives it a definite
    // starting state — the equivalent of the relay version's coils
    // defaulting to de-energized.
    //
    // The NMOS ring needs no such help: every stage already has a resistor
    // load holding its output high, so no node is ever floating. Adding one
    // here would in fact break it, forming a divider against that load and
    // pinning the node at X.
    if (kind === 'cmos') {
      c.addResistor('RS', nets[stages - 1], VSS, 12 + stages * 12 - 4, 14);
    }

    // The ring is gated so it can be stopped: stage 0's input is the last
    // stage NANDed with RUN, which for one extra transistor gives a run/stop
    // control instead of a ring that free-runs from power-on.
    const gated = c.net();
    const x0 = 14;
    if (kind === 'cmos') {
      c.addTransistor('GP1', 'pmos', RUN, VDD, gated, x0, 2);
      c.addTransistor('GP2', 'pmos', nets[stages - 1], VDD, gated, x0 + 5, 2);
      const gm = c.net();
      c.addTransistor('GN1', 'nmos', RUN, gated, gm, x0, 9);
      c.addTransistor('GN2', 'nmos', nets[stages - 1], gm, VSS, x0, 13);
      w(c, VDD, [x0, yTop], [x0, 2]);
      w(c, VDD, [x0 + 5, yTop], [x0 + 5, 2]);
      w(c, gated, [x0, 4.4], [x0, 9]);
      w(c, gated, [x0 + 5, 4.4], [x0 + 5, 6], [x0, 6]);
      w(c, gm, [x0, 11.4], [x0, 13]);
      w(c, VSS, [x0, 15.4], [x0, yBot]);
    } else {
      // NMOS: series pull-down under a load, no complementary network
      c.addResistor('RG', VDD, gated, x0, 2, { vert: true });
      const gm = c.net();
      c.addTransistor('GN1', 'nmos', RUN, gated, gm, x0, 8);
      c.addTransistor('GN2', 'nmos', nets[stages - 1], gm, VSS, x0, 12.5);
      w(c, VDD, [x0, yTop], [x0, 0.8]);
      w(c, gated, [x0, 3.2], [x0, 8]);
      w(c, gm, [x0, 10.4], [x0, 12.5]);
      w(c, VSS, [x0, 14.9], [x0, yBot]);
    }
    w(c, RUN, [5.2, 8], [x0 - 2.4, 8], [x0 - 2.4, kind === 'cmos' ? 10.2 : 9.2]);

    // the inverter chain
    let input = gated;
    for (let i = 0; i < stages; i++) {
      const x = x0 + 10 + i * 11;
      const out = nets[i];
      if (kind === 'cmos') {
        c.addTransistor(`P${i}`, 'pmos', input, VDD, out, x, 4);
        c.addTransistor(`N${i}`, 'nmos', input, out, VSS, x, 10);
        w(c, VDD, [x, yTop], [x, 4]);
        w(c, out, [x, 6.4], [x, 10]);
        w(c, VSS, [x, 12.4], [x, yBot]);
      } else {
        c.addResistor(`R${i}`, VDD, out, x, 3, { vert: true });
        c.addTransistor(`N${i}`, 'nmos', input, out, VSS, x, 9);
        w(c, VDD, [x, yTop], [x, 1.8]);
        w(c, out, [x, 4.2], [x, 9]);
        w(c, VSS, [x, 11.4], [x, yBot]);
      }
      w(c, input, [x - 1.5, kind === 'cmos' ? 5.2 : 10.2],
        [x - 1.5, kind === 'cmos' ? 11.2 : 10.2]);
      w(c, input, [x - 4, 8], [x - 1.5, 8]);
      c.addLamp(`Q${i}`, out, x + 2.5, 8, { short: `Q${i}` });
      input = out;
    }
    // close the ring: the last stage feeds the gate at the start
    const xLast = x0 + 10 + (stages - 1) * 11;
    w(c, nets[stages - 1], [xLast + 2.5, 8], [xLast + 5, 8],
      [xLast + 5, yBot - 2], [x0 + 2, yBot - 2],
      [x0 + 2, kind === 'cmos' ? 14.2 : 13.7]);
    return c;
  };
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

function buildNmosInverter() {
  const c = new Circuit('NMOS Inverter');
  const yTop = 0, yBot = 15;
  const { IN } = mosScaffold(c, 24, yTop, yBot, [['IN', 6]]);
  const out = c.net();
  // A resistor load instead of a PMOS: it only ever drives weakly, so the
  // transistor wins whenever it is on — and burns current the whole time.
  c.addResistor('RL', VDD, out, 14, 3, { vert: true });
  c.addTransistor('N1', 'nmos', IN, out, VSS, 14, 8);
  w(c, VDD, [14, yTop], [14, 1.8]);
  w(c, out, [14, 4.2], [14, 8]);
  w(c, VSS, [14, 10.4], [14, yBot]);
  w(c, IN, [5.2, 6], [12.5, 6], [12.5, 9.2]);
  w(c, out, [14, 6], [20, 6]);
  c.addLamp('OUT', out, 20, 6);
  c.label('load', 16.4, 3, 0.8);
  return c;
}

function buildDiodeLogic() {
  const c = new Circuit('Diode Logic');
  const yTop = 0, yBot = 17;
  const { A, B } = mosScaffold(c, 34, yTop, yBot, [['A', 4], ['B', 8]]);
  const orOut = c.net(), andOut = c.net();

  // OR: a diode can only push a 1 forward, so the output follows whichever
  // input is high; the resistor holds it down when neither is.
  c.addDiode('D1', A, orOut, 13, 4);
  c.addDiode('D2', B, orOut, 13, 8);
  c.addResistor('R1', orOut, VSS, 15.5, 12, { vert: true });
  w(c, A, [5.2, 4], [12.1, 4]);
  w(c, B, [5.2, 8], [12.1, 8]);
  w(c, orOut, [13.9, 4], [15.5, 4], [15.5, 10.8]);
  w(c, orOut, [13.9, 8], [15.5, 8]);
  w(c, VSS, [15.5, 13.2], [15.5, yBot]);
  w(c, orOut, [15.5, 6], [20, 6]);
  c.addLamp('A OR B', orOut, 20, 6, { short: 'OR' });

  // AND: the diodes point the other way, so any low input drags the output
  // down through them; the pull-up only wins when every input is high.
  c.addResistor('R2', VDD, andOut, 26, 2.5, { vert: true });
  c.addDiode('D3', andOut, A, 26, 6, { vert: true });
  c.addDiode('D4', andOut, B, 29, 6, { vert: true });
  w(c, VDD, [26, yTop], [26, 1.3]);
  w(c, andOut, [26, 3.7], [26, 5.1]);
  w(c, andOut, [26, 4.4], [29, 4.4], [29, 5.1]);
  w(c, A, [8, 4], [8, 13.5], [26, 13.5], [26, 6.9]);
  w(c, B, [10, 8], [10, 15.2], [29, 15.2], [29, 6.9]);
  w(c, andOut, [29, 4.4], [32, 4.4]);
  c.addLamp('A AND B', andOut, 32, 4.4, { short: 'AND' });
  return c;
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

function buildThreeTech() {
  const c = new Circuit('Three Technologies');
  const yTop = 0, yBot = 19;
  const { A, B } = mosScaffold(c, 50, yTop, yBot, [['A', 15.4], ['B', 17.2]]);
  const rout = c.net(), nout = c.net(), nmid = c.net();
  const cout = c.net(), cmid = c.net();

  // Relay: two normally-closed contacts in parallel. Either coil at rest
  // completes the path, so the output is low only when both pull in.
  relay(c, 'K1', A, 11, 2, [{ c: VDD, no: null, nc: rout }]);
  relay(c, 'K2', B, 11, 8, [{ c: VDD, no: null, nc: rout }]);
  c.addResistor('R0', rout, VSS, 17, 14, { vert: true });
  w(c, VDD, [9, yTop], [9, 10.6], [11, 10.6]);
  w(c, VDD, [9, 4.6], [11, 4.6]);
  w(c, rout, [15, 4], [17, 4], [17, 12.8]);
  w(c, rout, [15, 10], [17, 10]);
  w(c, VSS, [17, 15.2], [17, yBot]);
  w(c, rout, [17, 6.5], [20, 6.5]);
  c.addLamp('relay', rout, 20, 6.5, { short: 'RELAY' });

  // NMOS: same pull-down network, but the pull-up is a plain resistor, so a
  // low output is a permanent short from the rail through the load.
  c.addResistor('RL', VDD, nout, 28, 2.5, { vert: true });
  c.addTransistor('NA', 'nmos', A, nout, nmid, 28, 6);
  c.addTransistor('NB', 'nmos', B, nmid, VSS, 28, 10);
  w(c, VDD, [28, yTop], [28, 1.3]);
  w(c, nout, [28, 3.7], [28, 6]);
  w(c, nmid, [28, 8.4], [28, 10]);
  w(c, VSS, [28, 12.4], [28, yBot]);
  w(c, nout, [28, 5], [32, 5]);
  c.addLamp('NMOS', nout, 32, 5);

  // CMOS: the resistor becomes a second transistor network, the exact
  // complement of the first. No path from rail to rail, ever.
  c.addTransistor('PA', 'pmos', A, VDD, cout, 40, 2);
  c.addTransistor('PB', 'pmos', B, VDD, cout, 46, 2);
  c.addTransistor('CA', 'nmos', A, cout, cmid, 40, 8);
  c.addTransistor('CB', 'nmos', B, cmid, VSS, 40, 12);
  w(c, VDD, [40, yTop], [40, 2]);
  w(c, VDD, [46, yTop], [46, 2]);
  w(c, cout, [40, 4.4], [40, 8]);
  w(c, cout, [46, 4.4], [46, 5.6], [40, 5.6]);
  w(c, cmid, [40, 10.4], [40, 12]);
  w(c, VSS, [40, 14.4], [40, yBot]);
  w(c, cout, [40, 7], [43, 7]);
  c.addLamp('CMOS', cout, 43, 7);

  // A and B run as spines under the whole rack and tap up into each column
  w(c, A, [5.2, 15.4], [37, 15.4]);
  w(c, A, [7.2, 15.4], [7.2, 2.8], [11, 2.8]);      // K1 coil
  w(c, A, [24, 15.4], [24, 7.2], [26.5, 7.2]);      // NA gate
  w(c, A, [37, 15.4], [37, 3.2], [38.5, 3.2]);      // PA gate
  w(c, A, [37, 9.2], [38.5, 9.2]);                  // CA gate
  w(c, B, [5.2, 17.2], [44.5, 17.2]);
  w(c, B, [8.4, 17.2], [8.4, 8.8], [11, 8.8]);      // K2 coil
  w(c, B, [22.6, 17.2], [22.6, 11.2], [26.5, 11.2]); // NB gate
  w(c, B, [36, 17.2], [36, 13.2], [38.5, 13.2]);    // CB gate
  w(c, B, [44.5, 17.2], [44.5, 3.2]);               // PB gate
  return c;
}

// ── Composed machines ────────────────────────────────────────────────────

// The first circuit assembled from modules rather than placed by hand. The
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

// An 8 x 8 mask ROM. The contents spell a short message in ASCII, so the
// array holds something legible rather than arbitrary bytes — you can read
// the pattern of transistors off the canvas and decode it by eye, which is
// the charm of a mask ROM: the program is visible as physical structure.
const ROM_WORDS = [...'LOGIC 42'].map(ch => ch.charCodeAt(0));

function buildRom8(load = 'resistor') {
  const c = new Circuit(load === 'precharge' ? 'CMOS Program ROM' : 'Program ROM');
  c.implicitGround = false;

  const bind = {};
  for (let i = 0; i < 3; i++) {
    const n = c.net();
    c.addSwitch(`A${i}`, n, 'toggle', 4, 6 + i * 5, { to: VSS });
    bind[`a${i}`] = n;
  }
  if (load === 'precharge') {
    const n = c.net();
    // starts low, which is the precharge phase — the lines come up before
    // you ever touch it, so the circuit reads correctly on load
    c.addSwitch('PRE', n, 'toggle', 4, 6 + 3 * 5, { to: VSS });
    bind.pre = n;
  }

  const Rom = romArray(ROM_WORDS, 8, 3, { load });
  const inst = instantiate(c, Rom, 22, 0, bind);

  const b = c.bounds();
  const xEnd = b.x1 + 10;
  const yBot = b.y1 + 6;
  w(c, VDD, [0, -14], [xEnd, -14]);
  w(c, VSS, [0, yBot], [xEnd, yBot]);
  c.label('+V', -1.6, -14, 1.1, '#ffb340');
  c.label('GND', -2.4, yBot, 1.1, '#7f8aa3');
  for (const s of c.switches) {
    const t = switchSpdtT(s);
    w(c, VDD, [2.4, -14], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
    w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
  }

  for (let i = 0; i < 8; i++) {
    c.addLamp(`D${i}`, inst.nets[`d${i}`], xEnd - 5, 6 + i * 5, { short: `D${i}` });
  }
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

// ── Registry ─────────────────────────────────────────────────────────────

// The picker is organised by *technology* first, then by what the circuit
// does. The point of the library is that the same logic gets built several
// ways out of different physical devices, so grouping by technology lets
// you read a NAND gate three times over and compare, instead of hunting
// through one flat list of gates.
//
//   Relays  — coils and contacts only, no semiconductors.
//   CMOS    — complementary N/P pairs, both rails driven, no static current.
//   NMOS    — N-channel plus a resistor load: how it was done before CMOS,
//             and how the real 4004 was built.
//   General — no transistors at all (diode logic), or deliberately spanning
//             technologies. These are the bridges between the sections.
//
// Entries can be listed in any order below; this array is what the picker
// follows. A group named here with no circuits in it simply does not appear.
export const GROUP_ORDER = [
  'Relays · Basics',
  'Relays · Gates',
  'Relays · Memory',
  'Relays · Arithmetic',
  'General',
  'CMOS · Basics',
  'CMOS · Gates',
  'CMOS · Buses',
  'CMOS · Memory',
  'CMOS · Arithmetic',
  'NMOS · Basics',
  'NMOS · Gates',
  'NMOS · Arrays',
];

export const CIRCUITS = [
  { id: 'relay101', group: 'Relays · Basics', name: 'Meet the Relay', build: buildRelay101,
    desc: 'One relay: energize the coil and the armature snaps over, closing the normally-open contact and opening the normally-closed one. Everything else here is built from just this.' },
  { id: 'buzzer', group: 'Relays · Basics', name: 'Buzzer', build: buildBuzzer,
    desc: 'The relay interrupts its own coil through its NC contact, so it chatters forever — the classic doorbell buzzer. Hold PRESS and crank the speed up.' },
  { id: 'osc', group: 'Relays · Basics', name: 'Ring Oscillator', build: buildOscillator,
    desc: 'Three NOT relays in a loop. An odd number of inversions can never settle, so the pulse chases itself around the ring at a speed set by the relay delay.' },
  { id: 'not', group: 'Relays · Gates', name: 'NOT', build: buildNot,
    desc: 'Inversion is free with relays: the normally-closed contact conducts exactly when the coil is off.' },
  { id: 'and', group: 'Relays · Gates', name: 'AND', build: buildAnd,
    desc: 'Two normally-open contacts in series — current only gets through when both relays pull in.' },
  { id: 'or', group: 'Relays · Gates', name: 'OR', build: buildOr,
    desc: 'Two normally-open contacts in parallel — either relay can complete the path.' },
  { id: 'xor', group: 'Relays · Gates', name: 'XOR', build: buildXor,
    desc: 'Two changeover paths criss-cross like a hallway light with two wall switches: the lamp is on when the switches disagree.' },
  { id: 'nand', group: 'Relays · Gates', name: 'NAND', build: buildNand,
    desc: 'Parallel normally-closed contacts: the light stays on unless both relays pull in. NAND alone is enough to build everything else.' },
  { id: 'nor', group: 'Relays · Gates', name: 'NOR', build: buildNor,
    desc: 'Series normally-closed contacts: on only when both relays are at rest.' },
  { id: 'dec24', group: 'Relays · Gates', name: '2-to-4 Decoder', build: buildDecoder,
    desc: 'A contact tree: relay A splits the current two ways, relay B splits each again. Two inputs select exactly one of four lamps — this is how addresses select memory rows.' },
  { id: 't101', group: 'General', name: 'Meet the Transistor', build: buildTransistor101,
    desc: 'A MOSFET is a relay with no moving parts: the gate is isolated from the channel exactly like a coil is isolated from its contacts. N-channel conducts when the gate is high, P-channel when it is low — the two throws of a relay, split into two devices. Each output needs a resistor to hold it down, because a transistor that is off does not pull anything low; it just lets go.' },
  { id: 'cmosinv', group: 'CMOS · Basics', name: 'CMOS Inverter', build: buildCmosInverter,
    desc: 'Two transistors, and the whole of CMOS in miniature: the P-channel pulls the output up, the N-channel pulls it down, and the input turns exactly one of them on. Slow the clock right down and watch the handover — for a moment both are on (a red X, a dead short through the pair) or both are off (a dashed Z, the output floating on its own charge). Real chips fight both.' },
  { id: 'cmosnand', group: 'CMOS · Gates', name: 'CMOS NAND', build: buildCmosNand,
    desc: 'Four transistors. The pull-down network is the logic — two N-channels in series, so both inputs must be high to reach ground — and the pull-up is its exact complement, two P-channels in parallel. Every static CMOS gate is built this way, and the pull-up is always the dual of the pull-down.' },
  { id: 'cmosnor', group: 'CMOS · Gates', name: 'CMOS NOR', build: buildCmosNor,
    desc: 'The mirror image of NAND: series P-channels above, parallel N-channels below. Swap series for parallel in both networks and the gate inverts — which is why NAND and NOR come in pairs and why either one alone can build a computer.' },
  { id: 'nmosinv', group: 'NMOS · Basics', name: 'NMOS Inverter', build: buildNmosInverter,
    desc: 'How it was done before CMOS, and how the 4004 itself was built: one transistor and a resistor load. It works — but the load only ever drives weakly, so whenever the output is low there is a permanent path from the rail to ground. That static current is why early chips ran hot and why the second transistor was worth adding.' },
  { id: 'diode', group: 'General', name: 'Diode Logic', build: buildDiodeLogic,
    desc: 'The one directional device here: a diode passes a 1 forward and a 0 backward, and blocks the other way. Point them one way with a pull-down and you get OR; turn them around under a pull-up and you get AND. No transistors at all — but also no gain, so the output is weaker than the input and these cannot be chained. That is exactly why amplifying devices had to be invented.' },
  { id: 'cmosand', group: 'CMOS · Gates', name: 'CMOS AND',
    build: buildCmosComposed('CMOS AND', And2, 'NAND + inverter'),
    desc: 'There is no such thing as a CMOS AND gate — only a NAND with an inverter bolted on, which is what you are looking at. Six transistors where the NAND alone needs four, and one more gate delay. Compare the relay AND: two contacts in series, and inversion is the thing that costs extra there. Each technology makes a different gate cheap, and that shapes how logic gets written for it.' },
  { id: 'cmosor', group: 'CMOS · Gates', name: 'CMOS OR',
    build: buildCmosComposed('CMOS OR', Or2, 'NOR + inverter'),
    desc: 'A NOR plus an inverter, for the same reason AND is a NAND plus an inverter: the complementary pull-up network of a static CMOS gate always inverts. Nothing in CMOS produces a non-inverted output for free.' },
  { id: 'cmosxor', group: 'CMOS · Gates', name: 'CMOS XOR',
    build: buildCmosComposed('CMOS XOR', Xor2, 'four NAND gates'),
    desc: 'Four NAND gates — sixteen transistors for a function a single relay changeover contact gives you for nothing (see the relay XOR). XOR is the gate where relays genuinely beat transistors on device count, and it is why the relay adder is so much smaller than you would guess: its sum output is pure changeover staircase.' },
  { id: 'tgate', group: 'CMOS · Gates', name: 'Transmission Gate', build: buildTransmissionGate,
    desc: 'An N-channel and a P-channel wired in parallel, driven by complementary gates: together they pass a full 0 and a full 1 in either direction, which neither can do alone. Two of them make a 2-to-1 multiplexer — the building block relays get for free with a changeover contact, and the reason a relay contact is worth two transistors.' },
  { id: 'tristate', group: 'CMOS · Buses', name: 'Tri-State Bus', build: buildTriState,
    desc: 'Two drivers, one shared wire, and nothing to arbitrate. Enable one and the bus follows it. Enable neither and the bus floats — dashed Z, holding its last value on stray capacitance until it leaks away. Enable both with different data and they fight: a red X, a rail-to-rail short. This is the thing relays cannot do, and it is what lets a CPU have buses instead of a multiplexer tree for every destination.',
    // D1/D2 and EN1/EN2 group into 2-bit buses D and EN by the trailing-
    // digit rule, so bit 0 is driver 1 and bit 1 is driver 2.
    hints: {
      D: 'what each driver would put on the bus (bit 0 = driver 1)',
      EN: 'which drivers are switched on (bit 0 = driver 1)',
      BUS: 'the shared wire they all drive',
    },
    table: {
      title: 'What the bus does',
      select: v => {
        const e1 = v.EN & 1, e2 = (v.EN >> 1) & 1;
        const d1 = v.D & 1, d2 = (v.D >> 1) & 1;
        if (e1 && e2) return d1 === d2 ? 1 : 3;
        return (e1 || e2) ? 0 : 2;
      },
      rows: [
        { code: '1', name: 'One driver enabled', note: 'the bus follows it' },
        { code: '2', name: 'Both, agreeing', note: 'no conflict — same value' },
        { code: 'Z', name: 'Neither enabled', note: 'floating, holds its last value' },
        { code: 'X', name: 'Both, disagreeing', note: 'contention — a real short' },
      ],
    } },
  { id: 'tech3', group: 'General', name: 'Three Technologies', build: buildThreeTech,
    desc: 'One NAND gate, built three ways from the same two inputs: two relays, two transistors and a resistor, then four transistors. Same truth table, same lamps, wildly different machines — and the CMOS output lands while the armatures are still travelling.' },
  { id: 'srlatch', group: 'Relays · Memory', name: 'SR Latch', build: buildSrLatch,
    desc: 'Tap SET and the relay feeds its own coil through its own contact — it remembers. RESET breaks the hold path. One bit of memory.' },
  { id: 'dlatch', group: 'Relays · Memory', name: 'D Latch', build: buildDLatch,
    desc: 'While EN is on, Q follows D through one path; when EN drops, a second path lets Q hold itself. Flip D with EN off — nothing happens until you open the gate.' },
  { id: 'reg4', group: 'Relays · Memory', name: '4-bit Register', build: buildRegister4,
    desc: 'Four D latches sharing one LOAD button through an 8-pole relay. Set a number on the D switches, tap LOAD, and the register keeps it.' },
  { id: 'regfile', group: 'CMOS · Memory', name: '16×4 Register File', build: buildRegFile,
    desc: 'The 4004’s index registers: sixteen 4-bit words, written through one address port and read through another, so the machine can read one register while writing a different one. Every row drives the same four bit lines through tri-state gates — one shared bus, sixteen possible drivers. Set WA and D, raise WE to store, then read any address back. Drop WE before changing the address: these are level-sensitive latches, so moving the address with WE still high walks the word into the next register, exactly as the real part does.',
    readout: v => `read r${v.RA} → ${v.Q}   ·   write r${v.WA} ← ${v.D}${v.WE ? '  (WE high — storing now)' : ''}`,
    hints: {
      WA: 'write address — which of the 16 registers to store into',
      D: 'data to write',
      WE: 'write enable — raise to store, then drop before changing WA',
      RA: 'read address — independent of WA, so you can read while writing',
      Q: 'contents of register RA (always live)',
    },
    table: {
      title: 'Writing a register',
      // only the "raise WE" step has a live state to reflect
      select: v => (v.WE ? 1 : -1),
      rows: [
        { code: '1.', name: 'Set WA and D', note: 'with WE low' },
        { code: '2.', name: 'Raise WE', note: 'stored while high' },
        { code: '3.', name: 'Drop WE', note: 'before touching WA again' },
        { code: '4.', name: 'Set RA', note: 'Q follows it immediately' },
      ],
    },
    state: {
      title: 'Register contents',
      columns: 4,
      key: 'amber = the register RA is reading · blue = where WA would write',
      // one entry per register, read straight off its latch nets
      read: (c, v) => c.cells.map((nets, i) => {
        const bits = nets.map(n => VALUE_CHAR[c.value[n]]);
        const settled = bits.every(b => b === '0' || b === '1');
        return {
          label: `r${i}`,
          // A never-written latch is genuinely floating, and saying so
          // matters — but four Z's per cell swamps the grid, so it reads
          // as a single dash and keeps the colour that flags it.
          text: settled ? String(parseInt(bits.slice().reverse().join(''), 2)) : '–',
          // flag the two registers the ports are pointed at
          mark: i === v.RA ? 'read' : i === v.WA ? 'write' : null,
        };
      }),
    } },
  { id: 'nmosring', group: 'NMOS · Basics', name: 'NMOS Ring Oscillator',
    build: buildRing('NMOS Ring Oscillator', 'nmos', 2),
    desc: 'The same trick as the relay Ring Oscillator — an odd number of inversions in a loop can never settle — but in silicon. Two inverters plus the run/stop NAND makes three, so raising RUN closes the ring and it never stops. Watch the asymmetry the relay version cannot show you: each stage snaps down hard through its transistor and drifts up slowly through its load resistor, so the waveform is lopsided. That is the NMOS pull-up being weak, and it is half of why CMOS won.' },
  { id: 'cmosring', group: 'CMOS · Basics', name: 'CMOS Ring Oscillator',
    build: buildRing('CMOS Ring Oscillator', 'cmos', 2),
    desc: 'The same ring in complementary CMOS. Both edges are now driven hard — the P-channel pulls up as strongly as the N-channel pulls down — so the waveform is symmetric where the NMOS one drifts. Ring oscillators are how you actually measure a fabrication process: build one, count its frequency, and you know how fast the transistors came out.' },
  { id: 'nmosnand', group: 'NMOS · Gates', name: 'NMOS NAND',
    build: nmosGate('NMOS NAND', true, false),
    desc: 'Two N-channels in series under a resistor load. Compare it with the CMOS NAND: same pull-down network, but no complementary pull-up above it — half the transistors, and the output is only ever pulled high weakly. Whenever the output is low there is a permanent path from the rail to ground through the load, which is the static current that made NMOS chips run hot.' },
  { id: 'nmosnor', group: 'NMOS · Gates', name: 'NMOS NOR',
    build: nmosGate('NMOS NOR', false, false),
    desc: 'Two N-channels in parallel: either input high pulls the output down. In NMOS the NOR is the cheap gate — parallel transistors do not stack their resistance the way a series chain does, so NOR was the workhorse where CMOS designers prefer NAND.' },
  { id: 'nmosand', group: 'NMOS · Gates', name: 'NMOS AND',
    build: nmosGate('NMOS AND', true, true),
    desc: 'A NAND followed by an inverter, and you can see the cost: AND needs a whole second stage with its own load resistor, so it burns current in two places instead of one. This is why the primitive gate of any technology is the inverting one, and why designers rewrite logic to avoid the non-inverted forms.' },
  { id: 'nmosor', group: 'NMOS · Gates', name: 'NMOS OR',
    build: nmosGate('NMOS OR', false, true),
    desc: 'A NOR plus an inverter. Same story as AND: the extra stage doubles the static current and adds a full gate delay, for an output that a NOR feeding the next stage could often have given you for free.' },
  { id: 'rom8', group: 'NMOS · Arrays', name: 'Program ROM', build: buildRom8,
    desc: 'A real NMOS mask ROM: 8 words of 8 bits. A transistor at a site pulls its bit line down, so it stores a 0 — and a site storing 1 is literally empty silicon, which you can see on the canvas. Resistors pull every line up, so the array is a wired-AND. A bare switch matrix would sneak-path here (the selected row backfeeds through an unselected one and lights bits that are not stored); isolated gates make that structurally impossible, which is why ROM is built this way and why diode matrices existed before it.',
    readout: v => {
      const ch = v.D;
      const glyph = ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '·';
      return `addr ${v.A} → ${ch} = 0x${ch.toString(16).toUpperCase().padStart(2, '0')} = "${glyph}"`;
    },
    hints: {
      A: 'address — which of the 8 stored words to read',
      D: 'the word at that address (bit = 1 where the array has no transistor)',
    },
    state: {
      title: 'Stored contents',
      columns: 4,
      key: 'amber = the word the address lines are selecting',
      // The ROM's contents are fixed at build time, so this is a listing
      // rather than a live reading — but which word is selected *is* live.
      read: (c, v) => [...'LOGIC 42'].map((ch, i) => ({
        label: String(i),
        text: ch === ' ' ? '␣' : ch,
        mark: i === v.A ? 'read' : null,
      })),
    } },
  { id: 'romcmos', group: 'CMOS · Memory', name: 'CMOS Program ROM',
    build: () => buildRom8('precharge'),
    desc: 'The same 8 × 8 array with no resistors anywhere — a P-channel per bit line instead. It reads in two phases: with PRE low the pull-ups charge every line high, then PRE goes high, the pull-ups switch off, and the selected row discharges only the lines that have a transistor. Nothing ever fights, so unlike the NMOS version there is no path from rail to ground and no static current — which is the whole reason CMOS replaced NMOS. The cost is that a line reading 1 is only floating on its own charge (dashed, Z), so the reading is valid until the charge leaks away. That is dynamic logic, and it is why such chips have a minimum clock speed as well as a maximum.',
    readout: v => {
      if (!v.PRE) return 'PRE low — precharging, every line pulled high';
      const ch = v.D;
      const glyph = ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '·';
      return `addr ${v.A} → ${ch} = 0x${ch.toString(16).toUpperCase().padStart(2, '0')} = "${glyph}"`;
    },
    hints: {
      A: 'address — which of the 8 stored words to read',
      PRE: 'low charges every bit line; raise it to evaluate the word',
      D: 'the word at that address',
    },
    table: {
      title: 'Read cycle',
      select: v => (v.PRE ? 1 : 0),
      rows: [
        { code: '1.', name: 'PRE low', note: 'pull-ups on, every line charged high' },
        { code: '2.', name: 'PRE high', note: 'pull-ups off, the row discharges its 0s' },
      ],
    },
    state: {
      title: 'Stored contents',
      columns: 4,
      key: 'amber = the word the address lines are selecting',
      read: (c, v) => [...'LOGIC 42'].map((ch, i) => ({
        label: String(i),
        text: ch === ' ' ? '␣' : ch,
        mark: i === v.A ? 'read' : null,
      })),
    } },
  { id: 'alu4', group: 'CMOS · Arithmetic', name: '4-bit ALU', build: buildAlu4,
    desc: 'Six functions over two nibbles, chosen by F. Every function is computed at once and a transmission gate steers the selected one onto a shared result bus — one wire with six possible drivers, the way a CPU does it, not a mux tree per destination. 538 transistors, composed from gate modules rather than placed by hand. Codes 6 and 7 select nothing, and the bus floats.',
    hints: {
      A: 'first operand',
      B: 'second operand',
      F: 'function select — see the table below',
      Y: 'result',
      Cout: 'carry out of the top bit (borrow flag when subtracting)',
    },
    table: {
      title: 'Function select (F)',
      // codes 6 and 7 share the last row — both select nothing
      select: v => (v.F <= 5 ? v.F : 6),
      rows: [
        { code: '000', name: 'ADD', note: 'A + B' },
        { code: '001', name: 'SUB', note: 'A − B, two’s complement' },
        { code: '010', name: 'AND', note: 'bitwise' },
        { code: '011', name: 'OR', note: 'bitwise' },
        { code: '100', name: 'XOR', note: 'bitwise' },
        { code: '101', name: 'SHL', note: 'A shifted left one bit' },
        { code: '11x', name: '—', note: 'nothing selected; the bus floats' },
      ],
    },
    state: {
      title: 'All six results',
      columns: 3,
      key: 'read off the circuit, not recomputed. The logic gates all compute at once; ADD and SUB share one adder, so only the selected one has a value (· = not being computed).',
      // The circuit really does compute all six simultaneously; the pass
      // gates just decide which one is visible. Showing them together is
      // the clearest statement of what "steered onto a shared bus" means.
      read: (c, v) => {
        // read the nets the circuit actually settled to, never recompute:
        // a display that does its own arithmetic would agree with a broken
        // circuit, which is the one thing it must never do
        const word = key => {
          let n = 0;
          for (let i = 0; i < c.slices.length; i++) {
            const ch = VALUE_CHAR[c.value[c.slices[i][key]]];
            if (ch === '1') n |= 1 << i;
            else if (ch !== '0') return '—';
          }
          return String(n);
        };
        // ADD and SUB share the adder; which one it computed depends on F
        const sum = word('sum');
        return [
          { label: 'ADD', text: v.F === 1 ? '·' : sum },
          { label: 'SUB', text: v.F === 1 ? sum : '·' },
          { label: 'AND', text: word('and') },
          { label: 'OR', text: word('or') },
          { label: 'XOR', text: word('xor') },
          { label: 'SHL', text: word('shl') },
        ].map((it, i) => ({ ...it, mark: i === v.F ? 'read' : null }));
      },
    },
    readout: v => {
      const OPS = ['+', '−', 'AND', 'OR', 'XOR', '<<'];
      if (v.F > 5) return `F=${v.F}: no function selected — result bus floating`;
      if (v.F === 5) return `${v.A} << 1 = ${v.Y}`;
      const carry = v.F === 0 && v.Cout ? '  (carry)' : '';
      const borrow = v.F === 1 && !v.Cout ? '  (borrow — negative)' : '';
      return `${v.A} ${OPS[v.F]} ${v.B} = ${v.Y}${carry}${borrow}`;
    } },
  { id: 'halfadd', group: 'Relays · Arithmetic', name: 'Half Adder', build: buildHalfAdder,
    desc: 'XOR gives the sum bit, a series pair gives the carry: 1+1=10. Five contacts on two relays.',
    readout: v => `${v.A} + ${v.B} = ${v.CARRY * 2 + v.SUM}` },
  { id: 'fulladd', group: 'Relays · Arithmetic', name: 'Full Adder', build: buildFullAdder,
    desc: 'Three relays add three bits: a changeover staircase computes the parity (sum) and three series pairs vote on the majority (carry). The building block of every adder.',
    readout: v => `${v.A} + ${v.B} + ${v.Cin} = ${v.Cout * 2 + v.S}` },
  { id: 'add4', group: 'Relays · Arithmetic', name: '4-bit Ripple Adder', build: buildAdder4,
    desc: 'Four full adders chained carry-to-carry. Set A=1111 then flip B0 on and watch the carry ripple down the whole row — this is why adders have a "critical path".',
    readout: v => `${v.A} + ${v.B} + ${v.Cin} = ${v.Cout * 16 + v.S}` },
  { id: 'add8', group: 'Relays · Arithmetic', name: '8-bit Ripple Adder', build: buildAdder8,
    desc: '24 relays, 88 contacts, numbers up to 255. Zoom out to see the machine, zoom in to watch any single contact. Try 11111111 + 1.',
    readout: v => `${v.A} + ${v.B} + ${v.Cin} = ${v.Cout * 256 + v.S}` },
  { id: 'addsub4', group: 'Relays · Arithmetic', name: '4-bit Adder / Subtractor', build: buildAddSub4,
    desc: 'Flip SUB and a relay bank inverts every B bit while the same signal injects a carry-in: two’s complement, A−B = A+(~B)+1, in hardware. The seed of an ALU.',
    readout: v => v.SUB
      ? `${v.A} − ${v.B} = ${v.S}${v.Cout ? '' : '  (borrow — negative)'}`
      : `${v.A} + ${v.B} = ${v.Cout * 16 + v.S}` },
];

export function buildCircuit(id) {
  const entry = CIRCUITS.find(e => e.id === id);
  const c = entry.build();
  c.desc = entry.desc;
  c.readout = entry.readout;
  c.hints = entry.hints;   // per-bus captions in the I/O table
  c.table = entry.table;   // legend of selector codes, if the circuit has one
  c.state = entry.state;   // live internal state, for circuits that store any
  return c;
}
