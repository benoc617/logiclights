// Logic Lights — the circuit library.
//
// Every circuit here is built from nothing but relays, switches, lamps and
// wire, laid out by hand the way a relay rack would be wired. Conduction is
// undirected, so these topologies are designed sneak-path-free, like the
// real thing.

import { Circuit, VCC } from './engine.js';

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

// ── Registry ─────────────────────────────────────────────────────────────

export const CIRCUITS = [
  { id: 'relay101', group: 'Basics', name: 'Meet the Relay', build: buildRelay101,
    desc: 'One relay: energize the coil and the armature snaps over, closing the normally-open contact and opening the normally-closed one. Everything else here is built from just this.' },
  { id: 'buzzer', group: 'Basics', name: 'Buzzer', build: buildBuzzer,
    desc: 'The relay interrupts its own coil through its NC contact, so it chatters forever — the classic doorbell buzzer. Hold PRESS and crank the speed up.' },
  { id: 'osc', group: 'Basics', name: 'Ring Oscillator', build: buildOscillator,
    desc: 'Three NOT relays in a loop. An odd number of inversions can never settle, so the pulse chases itself around the ring at a speed set by the relay delay.' },
  { id: 'not', group: 'Gates', name: 'NOT', build: buildNot,
    desc: 'Inversion is free with relays: the normally-closed contact conducts exactly when the coil is off.' },
  { id: 'and', group: 'Gates', name: 'AND', build: buildAnd,
    desc: 'Two normally-open contacts in series — current only gets through when both relays pull in.' },
  { id: 'or', group: 'Gates', name: 'OR', build: buildOr,
    desc: 'Two normally-open contacts in parallel — either relay can complete the path.' },
  { id: 'xor', group: 'Gates', name: 'XOR', build: buildXor,
    desc: 'Two changeover paths criss-cross like a hallway light with two wall switches: the lamp is on when the switches disagree.' },
  { id: 'nand', group: 'Gates', name: 'NAND', build: buildNand,
    desc: 'Parallel normally-closed contacts: the light stays on unless both relays pull in. NAND alone is enough to build everything else.' },
  { id: 'nor', group: 'Gates', name: 'NOR', build: buildNor,
    desc: 'Series normally-closed contacts: on only when both relays are at rest.' },
  { id: 'dec24', group: 'Gates', name: '2-to-4 Decoder', build: buildDecoder,
    desc: 'A contact tree: relay A splits the current two ways, relay B splits each again. Two inputs select exactly one of four lamps — this is how addresses select memory rows.' },
  { id: 'srlatch', group: 'Memory', name: 'SR Latch', build: buildSrLatch,
    desc: 'Tap SET and the relay feeds its own coil through its own contact — it remembers. RESET breaks the hold path. One bit of memory.' },
  { id: 'dlatch', group: 'Memory', name: 'D Latch', build: buildDLatch,
    desc: 'While EN is on, Q follows D through one path; when EN drops, a second path lets Q hold itself. Flip D with EN off — nothing happens until you open the gate.' },
  { id: 'reg4', group: 'Memory', name: '4-bit Register', build: buildRegister4,
    desc: 'Four D latches sharing one LOAD button through an 8-pole relay. Set a number on the D switches, tap LOAD, and the register keeps it.' },
  { id: 'halfadd', group: 'Arithmetic', name: 'Half Adder', build: buildHalfAdder,
    desc: 'XOR gives the sum bit, a series pair gives the carry: 1+1=10. Five contacts on two relays.',
    readout: v => `${v.A} + ${v.B} = ${v.CARRY * 2 + v.SUM}` },
  { id: 'fulladd', group: 'Arithmetic', name: 'Full Adder', build: buildFullAdder,
    desc: 'Three relays add three bits: a changeover staircase computes the parity (sum) and three series pairs vote on the majority (carry). The building block of every adder.',
    readout: v => `${v.A} + ${v.B} + ${v.Cin} = ${v.Cout * 2 + v.S}` },
  { id: 'add4', group: 'Arithmetic', name: '4-bit Ripple Adder', build: buildAdder4,
    desc: 'Four full adders chained carry-to-carry. Set A=1111 then flip B0 on and watch the carry ripple down the whole row — this is why adders have a "critical path".',
    readout: v => `${v.A} + ${v.B} + ${v.Cin} = ${v.Cout * 16 + v.S}` },
  { id: 'add8', group: 'Arithmetic', name: '8-bit Ripple Adder', build: buildAdder8,
    desc: '24 relays, 88 contacts, numbers up to 255. Zoom out to see the machine, zoom in to watch any single contact. Try 11111111 + 1.',
    readout: v => `${v.A} + ${v.B} + ${v.Cin} = ${v.Cout * 256 + v.S}` },
  { id: 'addsub4', group: 'Arithmetic', name: '4-bit Adder / Subtractor', build: buildAddSub4,
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
  return c;
}
