// Headless truth-table tests for the relay simulation.
// Run: node test/sim-test.mjs

import { buildCircuit, CIRCUITS } from '../web/js/circuits.js';
import { deriveBuses, busValue } from '../web/js/buses.js';

let failures = 0;
let checks = 0;
let clock = 0;

function settle(c) {
  clock += 5000;
  c.step(clock);
  let guard = 0;
  while (c.nextEventAt() !== null && guard++ < 5000) {
    clock = c.nextEventAt() + 0.001;
    c.step(clock);
  }
  if (guard >= 5000) throw new Error(`${c.name}: did not settle`);
  c.computeHot();
}

function sw(c, label, on) {
  const s = c.switches.find(s => s.label === label);
  if (!s) throw new Error(`${c.name}: no switch ${label}`);
  s.on = on;
}

function lamp(c, label) {
  const l = c.lamps.find(l => l.label === label || l.label.startsWith(label));
  if (!l) throw new Error(`${c.name}: no lamp ${label}`);
  return c.hot[l.net];
}

function expect(c, desc, actual, wanted) {
  checks++;
  if (actual !== wanted) {
    failures++;
    console.error(`FAIL [${c.name}] ${desc}: got ${actual}, wanted ${wanted}`);
  }
}

// ── two-input gates ──────────────────────────────────────────────────────
const GATES = {
  and: (a, b) => a && b,
  or: (a, b) => a || b,
  xor: (a, b) => a !== b,
  nand: (a, b) => !(a && b),
  nor: (a, b) => !(a || b),
};
for (const [id, fn] of Object.entries(GATES)) {
  const c = buildCircuit(id);
  for (const a of [false, true]) for (const b of [false, true]) {
    sw(c, 'A', a); sw(c, 'B', b); settle(c);
    expect(c, `A=${+a} B=${+b}`, lamp(c, 'OUT'), fn(a, b));
  }
}
{
  const c = buildCircuit('not');
  for (const a of [false, true]) {
    sw(c, 'A', a); settle(c);
    expect(c, `A=${+a}`, lamp(c, 'OUT'), !a);
  }
}
{
  const c = buildCircuit('relay101');
  for (const a of [false, true]) {
    sw(c, 'COIL', a); settle(c);
    expect(c, `coil=${+a} NC`, lamp(c, 'NC'), !a);
    expect(c, `coil=${+a} NO`, lamp(c, 'NO'), a);
  }
}

// ── decoder ──────────────────────────────────────────────────────────────
{
  const c = buildCircuit('dec24');
  for (let v = 0; v < 4; v++) {
    sw(c, 'A', !!(v & 1)); sw(c, 'B', !!(v & 2)); settle(c);
    for (let i = 0; i < 4; i++) {
      expect(c, `v=${v} lamp${i}`, lamp(c, `BA = ${i.toString(2).padStart(2, '0')}`), i === v);
    }
  }
}

// ── latches ──────────────────────────────────────────────────────────────
{
  const c = buildCircuit('srlatch');
  settle(c);
  expect(c, 'initial Q', lamp(c, 'Q'), false);
  sw(c, 'SET', true); settle(c);
  expect(c, 'SET held Q', lamp(c, 'Q'), true);
  sw(c, 'SET', false); settle(c);
  expect(c, 'SET released, Q holds', lamp(c, 'Q'), true);
  sw(c, 'RESET', true); settle(c);
  expect(c, 'RESET pressed, Q drops', lamp(c, 'Q'), false);
  sw(c, 'RESET', false); settle(c);
  expect(c, 'RESET released, Q stays low', lamp(c, 'Q'), false);
}
{
  const c = buildCircuit('dlatch');
  settle(c);
  sw(c, 'D', true); settle(c);
  expect(c, 'D=1 EN=0, Q gated off', lamp(c, 'Q'), false);
  sw(c, 'EN', true); settle(c);
  expect(c, 'D=1 EN=1, Q follows', lamp(c, 'Q'), true);
  sw(c, 'EN', false); settle(c);
  expect(c, 'EN dropped, Q holds', lamp(c, 'Q'), true);
  sw(c, 'D', false); settle(c);
  expect(c, 'D=0 EN=0, Q still holds', lamp(c, 'Q'), true);
  sw(c, 'EN', true); settle(c);
  expect(c, 'EN reopened, Q follows D=0', lamp(c, 'Q'), false);
  sw(c, 'EN', false); settle(c);
  expect(c, 'holds low', lamp(c, 'Q'), false);
}
{
  const c = buildCircuit('reg4');
  settle(c);
  const loadVal = v => {
    for (let i = 0; i < 4; i++) sw(c, `D${i}`, !!(v & (1 << i)));
    settle(c);
    sw(c, 'LOAD', true); settle(c);
    sw(c, 'LOAD', false); settle(c);
  };
  const readQ = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) if (lamp(c, `Q${i}`)) v |= 1 << i;
    return v;
  };
  loadVal(0b1010);
  expect(c, 'load 1010', readQ(), 0b1010);
  for (let i = 0; i < 4; i++) sw(c, `D${i}`, false);
  settle(c);
  expect(c, 'D cleared, Q holds 1010', readQ(), 0b1010);
  loadVal(0b0101);
  expect(c, 'load 0101', readQ(), 0b0101);
  loadVal(0b1111);
  expect(c, 'load 1111', readQ(), 0b1111);
  loadVal(0b0000);
  expect(c, 'load 0000', readQ(), 0b0000);
}

// ── adders ───────────────────────────────────────────────────────────────
{
  const c = buildCircuit('halfadd');
  for (const a of [0, 1]) for (const b of [0, 1]) {
    sw(c, 'A', !!a); sw(c, 'B', !!b); settle(c);
    expect(c, `${a}+${b} sum`, lamp(c, 'SUM'), !!((a + b) & 1));
    expect(c, `${a}+${b} carry`, lamp(c, 'CARRY'), a + b > 1);
  }
}
{
  const c = buildCircuit('fulladd');
  for (const a of [0, 1]) for (const b of [0, 1]) for (const ci of [0, 1]) {
    sw(c, 'A0', !!a); sw(c, 'B0', !!b); sw(c, 'Cin', !!ci); settle(c);
    const t = a + b + ci;
    expect(c, `${a}+${b}+${ci} sum`, lamp(c, 'S0'), !!(t & 1));
    expect(c, `${a}+${b}+${ci} cout`, lamp(c, 'Cout'), t > 1);
  }
}

function testAdder(id, N) {
  const c = buildCircuit(id);
  const max = 1 << N;
  for (let a = 0; a < max; a++) {
    for (let b = 0; b < max; b++) {
      for (const ci of [0, 1]) {
        for (let i = 0; i < N; i++) {
          sw(c, `A${i}`, !!(a & (1 << i)));
          sw(c, `B${i}`, !!(b & (1 << i)));
        }
        sw(c, 'Cin', !!ci);
        settle(c);
        const want = a + b + ci;
        let got = 0;
        for (let i = 0; i < N; i++) if (lamp(c, `S${i}`)) got |= 1 << i;
        if (lamp(c, 'Cout')) got |= max;
        checks++;
        if (got !== want) {
          failures++;
          console.error(`FAIL [${c.name}] ${a}+${b}+${ci}: got ${got}, wanted ${want}`);
        }
      }
    }
  }
}
testAdder('add4', 4);
testAdder('add8', 8);

{
  const c = buildCircuit('addsub4');
  for (let a = 0; a < 16; a++) {
    for (let b = 0; b < 16; b++) {
      for (const s of [0, 1]) {
        for (let i = 0; i < 4; i++) {
          sw(c, `A${i}`, !!(a & (1 << i)));
          sw(c, `B${i}`, !!(b & (1 << i)));
        }
        sw(c, 'SUB', !!s);
        settle(c);
        const want = s ? (a - b) & 15 : (a + b) & 15;
        const wantC = s ? a >= b : a + b > 15;
        let got = 0;
        for (let i = 0; i < 4; i++) if (lamp(c, `S${i}`)) got |= 1 << i;
        checks++;
        if (got !== want || lamp(c, 'Cout') !== wantC) {
          failures++;
          console.error(`FAIL [${c.name}] a=${a} b=${b} sub=${s}: got ${got} c=${lamp(c, 'Cout')}, wanted ${want} c=${wantC}`);
        }
      }
    }
  }
}

// ── dynamic circuits: must NOT settle while running ──────────────────────
{
  const c = buildCircuit('buzzer');
  settle(c);
  sw(c, 'PRESS', true);
  clock += 5000; c.step(clock);
  let flips = 0;
  for (let k = 0; k < 20; k++) {
    const t = c.nextEventAt();
    if (t === null) break;
    clock = t + 0.001;
    flips += c.step(clock);
  }
  expect(c, 'buzzer keeps buzzing', flips >= 20, true);
  sw(c, 'PRESS', false); settle(c);
}
{
  const c = buildCircuit('osc');
  settle(c);
  sw(c, 'RUN', true);
  clock += 5000; c.step(clock);
  let flips = 0;
  for (let k = 0; k < 30; k++) {
    const t = c.nextEventAt();
    if (t === null) break;
    clock = t + 0.001;
    flips += c.step(clock);
  }
  expect(c, 'oscillator keeps running', flips >= 30, true);
}

// ── binary I/O buses ─────────────────────────────────────────────────────
{
  // bus widths and grouping are what the I/O table renders
  const c = buildCircuit('add8');
  const b = deriveBuses(c);
  const width = (list, name) => list.find(x => x.name === name)?.bits.length;
  expect(c, 'A bus width', width(b.inputs, 'A'), 8);
  expect(c, 'B bus width', width(b.inputs, 'B'), 8);
  expect(c, 'Cin bus width', width(b.inputs, 'Cin'), 1);
  expect(c, 'S bus width', width(b.outputs, 'S'), 8);
  expect(c, 'Cout bus width', width(b.outputs, 'Cout'), 1);
  expect(c, 'CARRY internal width', width(b.internals, 'CARRY'), 8);

  // setting inputs through the bus abstraction must produce the right sum
  const setBus = (bus, v) => bus.bits.forEach((bit, pos) => { bit.sw.on = !!(v & (1 << pos)); });
  const A = b.inputs.find(x => x.name === 'A');
  const B = b.inputs.find(x => x.name === 'B');
  const S = b.outputs.find(x => x.name === 'S');
  const Cout = b.outputs.find(x => x.name === 'Cout');
  for (const [a, bb] of [[200, 55], [255, 1], [0, 0], [170, 85], [128, 128]]) {
    setBus(A, a); setBus(B, bb); settle(c);
    const got = busValue(S, bit => c.hot[bit.net]) +
      256 * busValue(Cout, bit => c.hot[bit.net]);
    expect(c, `bus ${a}+${bb}`, got, a + bb);
    expect(c, `bus A reads back ${a}`, busValue(A, bit => bit.sw.on), a);
  }
}
{
  // one-hot decoder exposes Y0..Y3 as a single 4-bit bus
  const c = buildCircuit('dec24');
  const b = deriveBuses(c);
  const Y = b.outputs.find(x => x.name === 'Y');
  expect(c, 'Y bus width', Y.bits.length, 4);
  for (let v = 0; v < 4; v++) {
    sw(c, 'A', !!(v & 1)); sw(c, 'B', !!(v & 2)); settle(c);
    expect(c, `decoder one-hot v=${v}`, busValue(Y, bit => c.hot[bit.net]), 1 << v);
  }
}
{
  // readouts must not throw and must reflect the circuit
  const c = buildCircuit('addsub4');
  const b = deriveBuses(c);
  const setBus = (bus, v) => bus.bits.forEach((bit, pos) => { bit.sw.on = !!(v & (1 << pos)); });
  setBus(b.inputs.find(x => x.name === 'A'), 9);
  setBus(b.inputs.find(x => x.name === 'B'), 4);
  setBus(b.inputs.find(x => x.name === 'SUB'), 1);
  settle(c);
  const vals = {};
  for (const list of [b.inputs, b.outputs, b.internals]) {
    for (const bus of list) {
      vals[bus.name] = busValue(bus, bit => (bit.sw ? bit.sw.on : c.hot[bit.net]));
    }
  }
  expect(c, 'subtract 9-4 sum bus', vals.S, 5);
  expect(c, 'Beff shows ~B', vals.Beff, 11);
  expect(c, 'readout text', c.readout(vals), '9 − 4 = 5');
}

// every registered circuit builds, has geometry, and derives sane buses
for (const e of CIRCUITS) {
  const c = e.build();
  const b = c.bounds();
  checks++;
  if (!(b.x1 > b.x0 && b.y1 > b.y0)) {
    failures++;
    console.error(`FAIL [${e.id}] degenerate bounds`);
  }
  const buses = deriveBuses(c);
  checks++;
  if (!buses.inputs.length || !buses.outputs.length) {
    failures++;
    console.error(`FAIL [${e.id}] missing input or output buses`);
  }
  for (const bus of [...buses.inputs, ...buses.outputs, ...buses.internals]) {
    checks++;
    if (!bus.name || !bus.bits.length || bus.bits.length > 8) {
      failures++;
      console.error(`FAIL [${e.id}] bad bus ${bus.name} (${bus.bits.length} bits)`);
    }
  }
}

console.log(`${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
