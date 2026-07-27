// Headless truth-table tests for the device simulation.
// Run: node test/sim-test.mjs

import { readFileSync } from 'node:fs';
import { buildCircuit, CIRCUITS, GROUP_ORDER } from '../web/js/circuits.js';
import { deriveBuses, busValue } from '../web/js/buses.js';
import { Circuit, LO, HI, X, Z, STRONG, WEAK, CHARGE, VALUE_CHAR } from '../web/js/engine.js';
import { instantiate } from '../web/js/module.js';
import { Inverter, Nand2, Nor2, And2, Or2, Xor2, DLatch, register, rippleAdder } from '../web/js/gates.js';
import { romArray } from '../web/js/rom.js';
import {
  InstructionDecoder, disassemble, disassembleProgram, isTwoByte,
} from '../web/js/decode.js';
import { buildJcnMachine } from '../web/js/behaviour/cmos.js';
import { ringCounter, ConditionTree, IsZero4 } from '../web/js/sequencer.js';

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
  c.solve();
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

// ── solid-state devices ──────────────────────────────────────────────────

function lampV(c, label) {
  const l = c.lamps.find(l => l.label === label || l.label.startsWith(label));
  if (!l) throw new Error(`${c.name}: no lamp ${label}`);
  return c.value[l.net];
}
function lampStr(c, label) {
  const l = c.lamps.find(l => l.label === label || l.label.startsWith(label));
  return c.strength[l.net];
}
const V = v => VALUE_CHAR[v];

{
  // N-channel conducts on a high gate, P-channel on a low one — and the
  // resistor holds the other output down rather than letting it float
  const c = buildCircuit('t101');
  for (const g of [false, true]) {
    sw(c, 'GATE', g); settle(c);
    expect(c, `gate=${+g} NMOS`, V(lampV(c, 'N-channel')), g ? '1' : '0');
    expect(c, `gate=${+g} PMOS`, V(lampV(c, 'P-channel')), g ? '0' : '1');
  }
}
{
  const c = buildCircuit('cmosinv');
  for (const a of [false, true]) {
    sw(c, 'IN', a); settle(c);
    expect(c, `IN=${+a}`, V(lampV(c, 'OUT')), a ? '0' : '1');
    // at rest exactly one of the pair conducts: never a short, never a float
    expect(c, `IN=${+a} driven hard`, lampStr(c, 'OUT'), STRONG);
  }
}
{
  const c = buildCircuit('nmosinv');
  for (const a of [false, true]) {
    sw(c, 'IN', a); settle(c);
    expect(c, `IN=${+a}`, V(lampV(c, 'OUT')), a ? '0' : '1');
    // the load only ever drives weakly — the transistor always wins
    expect(c, `IN=${+a} strength`, lampStr(c, 'OUT'), a ? STRONG : WEAK);
  }
}
for (const [id, fn] of [['cmosnand', (a, b) => !(a && b)], ['cmosnor', (a, b) => !(a || b)]]) {
  const c = buildCircuit(id);
  for (const a of [false, true]) for (const b of [false, true]) {
    sw(c, 'A', a); sw(c, 'B', b); settle(c);
    expect(c, `A=${+a} B=${+b}`, V(lampV(c, 'OUT')), fn(a, b) ? '1' : '0');
    expect(c, `A=${+a} B=${+b} driven hard`, lampStr(c, 'OUT'), STRONG);
  }
}
{
  // diodes conduct one way only: OR under a pull-down, AND under a pull-up
  const c = buildCircuit('diode');
  for (const a of [false, true]) for (const b of [false, true]) {
    sw(c, 'A', a); sw(c, 'B', b); settle(c);
    expect(c, `A=${+a} B=${+b} OR`, V(lampV(c, 'A OR B')), (a || b) ? '1' : '0');
    expect(c, `A=${+a} B=${+b} AND`, V(lampV(c, 'A AND B')), (a && b) ? '1' : '0');
  }
}
{
  // a pass-gate pair carries a full 0 and a full 1 in either direction
  const c = buildCircuit('tgate');
  for (const s of [false, true]) for (const a of [false, true]) for (const b of [false, true]) {
    sw(c, 'SEL', s); sw(c, 'A', a); sw(c, 'B', b); settle(c);
    const want = s ? b : a;
    expect(c, `SEL=${+s} A=${+a} B=${+b}`, V(lampV(c, 'OUT')), want ? '1' : '0');
    expect(c, `SEL=${+s} A=${+a} B=${+b} not floating`, lampStr(c, 'OUT'), STRONG);
  }
}
{
  // the whole point of a bus: driven, floating, or fought over
  const c = buildCircuit('tristate');
  settle(c);
  expect(c, 'never driven, so floating', V(lampV(c, 'BUS')), 'Z');

  sw(c, 'D1', true); sw(c, 'EN1', true); settle(c);
  expect(c, 'driver 1 enabled', V(lampV(c, 'BUS')), '1');
  expect(c, 'driver 1 drives hard', lampStr(c, 'BUS'), STRONG);

  sw(c, 'EN1', false); settle(c);
  expect(c, 'released, charge holds the 1', V(lampV(c, 'BUS')), '1');
  expect(c, 'held on capacitance, not driven', lampStr(c, 'BUS'), CHARGE);

  sw(c, 'D2', false); sw(c, 'EN2', true); settle(c);
  expect(c, 'driver 2 pulls it back down', V(lampV(c, 'BUS')), '0');

  sw(c, 'EN1', true); sw(c, 'D1', true); settle(c);
  expect(c, 'both drivers disagree — contention', V(lampV(c, 'BUS')), 'X');

  sw(c, 'D1', false); settle(c);
  expect(c, 'both drivers agree — no contention', V(lampV(c, 'BUS')), '0');

  sw(c, 'EN1', false); sw(c, 'EN2', false); settle(c);
  expect(c, 'released again, holds the 0', V(lampV(c, 'BUS')), '0');
}
{
  // one gate, three technologies, one truth table
  const c = buildCircuit('tech3');
  for (const a of [false, true]) for (const b of [false, true]) {
    sw(c, 'A', a); sw(c, 'B', b); settle(c);
    const want = !(a && b) ? '1' : '0';
    for (const tech of ['relay', 'NMOS', 'CMOS']) {
      expect(c, `A=${+a} B=${+b} ${tech}`, V(lampV(c, tech)), want);
    }
  }
}
{
  // relay circuits keep the one-rail model: nothing floats, nothing contends
  for (const id of ['add8', 'reg4', 'addsub4', 'dec24']) {
    const c = buildCircuit(id);
    settle(c);
    let bad = 0;
    for (let n = 0; n < c.netCount; n++) if (c.value[n] === X || c.value[n] === Z) bad++;
    expect(c, `${id}: no X or Z under implicit ground`, bad, 0);
  }
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

// ── sub-circuit modules ──────────────────────────────────────────────────
// Modules bind ports by name and offset their geometry, so a gate can be
// instantiated in bulk instead of hand-placed. Composed gates (And2, Or2,
// Xor2) are built from other modules, so these also cover nesting.
{
  const gate = (def, arity, fn) => {
    for (let i = 0; i < (1 << arity); i++) {
      const c = new Circuit(`mod-${def.name}`);
      c.implicitGround = false;
      const ins = [];
      for (let k = 0; k < arity; k++) {
        const n = c.net();
        const s = c.addSwitch(`S${k}`, n, 'toggle', 0, 0, { from: 0, to: 1 });
        s.on = !!((i >> k) & 1);
        ins.push(n);
      }
      const bind = arity === 1 ? { a: ins[0] } : { a: ins[0], b: ins[1] };
      const inst = instantiate(c, def, 0, 0, bind);
      settle(c);
      const bits = [];
      for (let k = 0; k < arity; k++) bits.push((i >> k) & 1);
      const want = String(fn(...bits));
      expect(c, `${def.name}(${bits.join('')})`,
        VALUE_CHAR[c.value[inst.nets.y]], want);
      // a complementary gate always drives hard: never floating, never X
      expect(c, `${def.name}(${bits.join('')}) driven hard`,
        c.strength[inst.nets.y], STRONG);
    }
  };
  gate(Inverter, 1, a => (a ? 0 : 1));
  gate(Nand2, 2, (a, b) => (a && b ? 0 : 1));
  gate(Nor2, 2, (a, b) => (a || b ? 0 : 1));
  gate(And2, 2, (a, b) => (a && b ? 1 : 0));
  gate(Or2, 2, (a, b) => (a || b ? 1 : 0));
  gate(Xor2, 2, (a, b) => (a ^ b ? 1 : 0));
}
{
  // Instances are independent: same definition, separate nets and devices.
  const c = new Circuit('two-instances');
  c.implicitGround = false;
  const a = c.net(), b = c.net();
  const s1 = c.addSwitch('A', a, 'toggle', 0, 0, { from: 0, to: 1 });
  const s2 = c.addSwitch('B', b, 'toggle', 0, 0, { from: 0, to: 1 });
  s1.on = true; s2.on = false;
  const i1 = instantiate(c, Inverter, 0, 0, { a });
  const i2 = instantiate(c, Inverter, 20, 0, { a: b });
  settle(c);
  expect(c, 'instance 1 independent', VALUE_CHAR[c.value[i1.nets.y]], '0');
  expect(c, 'instance 2 independent', VALUE_CHAR[c.value[i2.nets.y]], '1');
  expect(c, 'instances do not share nets', i1.nets.y !== i2.nets.y, true);
  expect(c, 'device names namespaced',
    new Set(c.transistors.map(t => t.name)).size, c.transistors.length);
}
{
  // Geometry offsets: an instance placed at x lands there, and its extent
  // covers the devices' drawn reach, not just their origins.
  const c = new Circuit('placement');
  c.implicitGround = false;
  const inst = instantiate(c, Inverter, 100, 50, {});
  const xs = c.transistors.map(t => t.x);
  expect(c, 'instance offset applied', xs.every(x => x >= 100), true);
  expect(c, 'instance has non-zero extent', inst.w > 0 && inst.h > 0, true);
}
{
  // Binding an undeclared port is a typo that must not pass silently.
  let threw = false;
  try {
    instantiate(new Circuit('bad'), Inverter, 0, 0, { nope: 3 });
  } catch { threw = true; }
  const c = new Circuit('bad');
  expect(c, 'unknown port rejected', threw, true);
}

// ── D latch ──────────────────────────────────────────────────────────────
// Two inverters and two pass gates. Transparent while en is high, holding
// when it is low — and holding *actively*, driven by the inverter loop, not
// coasting on stored charge.
{
  const c = new Circuit('dlatch-mod');
  c.implicitGround = false;
  const d = c.net(), en = c.net(), nen = c.net();
  const sd = c.addSwitch('D', d, 'toggle', 0, 0, { from: 0, to: 1 });
  const se = c.addSwitch('EN', en, 'toggle', 0, 0, { from: 0, to: 1 });
  instantiate(c, Inverter, 0, 40, { a: en, y: nen });
  const L = instantiate(c, DLatch, 0, 0, { d, en, nen });
  const q = () => c.value[L.nets.q];

  sd.on = true; se.on = true; settle(c);
  expect(c, 'latch transparent: q follows d=1', q(), HI);
  sd.on = false; settle(c);
  expect(c, 'latch transparent: q follows d=0', q(), LO);
  sd.on = true; settle(c);
  se.on = false; settle(c);                 // latch the 1
  expect(c, 'latch holds after en falls', q(), HI);
  sd.on = false; settle(c);
  expect(c, 'latch ignores d while held', q(), HI);
  // static storage: the holding loop drives, so this is not stored charge
  expect(c, 'held value is actively driven', c.strength[L.nets.q], STRONG);
  se.on = true; settle(c);
  expect(c, 'latch transparent again', q(), LO);
}

// ── 16 x 4 register file ─────────────────────────────────────────────────
{
  const c = buildCircuit('regfile');
  const set = (p, v, n) => {
    for (let i = 0; i < n; i++) sw(c, `${p}${i}`, !!((v >> i) & 1));
  };
  // WE must fall before the address changes: these are level-sensitive
  // latches, so moving the address while WE is high walks the old word
  // into the new register on the way past. That is how the real part
  // behaves, and the sequencing is the caller's job.
  const write = (addr, val) => {
    sw(c, 'WE', false); settle(c);
    set('WA', addr, 4); set('D', val, 4); settle(c);
    sw(c, 'WE', true); settle(c);
    sw(c, 'WE', false); settle(c);
  };
  const read = (addr) => {
    set('RA', addr, 4); settle(c);
    let v = 0;
    for (let b = 0; b < 4; b++) {
      if (lampV(c, `Q${b}`) === HI) v |= 1 << b;
      expect(c, `read r${addr} bit ${b} driven`, lampStr(c, `Q${b}`), STRONG);
    }
    return v;
  };

  for (let r = 0; r < 16; r++) write(r, (r * 7) & 15);
  for (let r = 0; r < 16; r++) {
    expect(c, `register ${r} holds its own value`, read(r), (r * 7) & 15);
  }
  // writing one register must not disturb its neighbours
  write(5, 0b1010);
  expect(c, 'rewritten register updates', read(5), 0b1010);
  expect(c, 'neighbour survives a write', read(6), (6 * 7) & 15);
  expect(c, 'far register survives a write', read(15), (15 * 7) & 15);
  // WE low means no write happens at all
  sw(c, 'WE', false); settle(c);
  set('WA', 6, 4); set('D', 0, 4); settle(c);
  expect(c, 'no write while WE is low', read(6), (6 * 7) & 15);
}

// ── program ROM ──────────────────────────────────────────────────────────
// An NMOS array: a transistor at a site pulls the bit line down, storing 0;
// an empty site reads 1 through the pull-up.
{
  // Every address width, not just the one the library circuit uses — the
  // 1-bit decoder takes a different code path from the folded-AND case and
  // had its row lines swapped when it was only exercised at 3 bits.
  for (const bits of [1, 2, 3]) {
    const rows = 1 << bits;
    // a pattern with all-zeros, all-ones and mixed words
    const words = Array.from({ length: rows }, (_, i) => (i * 37 + i) & 0x0f);
    words[0] = 0; words[rows - 1] = 0x0f;
    const Rom = romArray(words, 4, bits);
    for (let addr = 0; addr < rows; addr++) {
      const c = new Circuit(`rom${bits}`);
      c.implicitGround = false;
      const bind = {};
      for (let i = 0; i < bits; i++) {
        const n = c.net();
        const s = c.addSwitch(`A${i}`, n, 'toggle', 0, 0, { from: 0, to: 1 });
        s.on = !!((addr >> i) & 1);
        bind[`a${i}`] = n;
      }
      const inst = instantiate(c, Rom, 0, 0, bind);
      settle(c);
      let got = 0, driven = true;
      for (let b = 0; b < 4; b++) {
        const net = inst.nets[`d${b}`];
        if (c.value[net] === HI) got |= 1 << b;
        // the output buffer must drive hard — the pull-up alone is WEAK,
        // and reporting a weak level as data is how a real part fails
        if (c.strength[net] !== STRONG) driven = false;
      }
      expect(c, `rom${bits} addr ${addr}`, got, words[addr]);
      expect(c, `rom${bits} addr ${addr} driven`, driven, true);
    }
  }
}
{
  // The sneak-path property. This pattern — two rows sharing a column, one
  // a superset of the other — reads wrong on a bare switch matrix, because
  // the selected row backfeeds through the unselected row's site. Isolated
  // gates make it structurally impossible.
  const words = [0b00, 0b01];
  const Rom = romArray(words, 2, 1);
  for (let addr = 0; addr < 2; addr++) {
    const c = new Circuit('rom-sneak');
    c.implicitGround = false;
    const n = c.net();
    const s = c.addSwitch('A0', n, 'toggle', 0, 0, { from: 0, to: 1 });
    s.on = !!addr;
    const inst = instantiate(c, Rom, 0, 0, { a0: n });
    settle(c);
    const got = (c.value[inst.nets.d1] === HI ? 2 : 0) | (c.value[inst.nets.d0] === HI ? 1 : 0);
    expect(c, `no sneak path at addr ${addr}`, got, words[addr]);
  }
}
{
  // The CMOS variant: no resistors, a P-channel per bit line, read in two
  // phases. PRE low charges every line; PRE high turns the pull-ups off and
  // lets the selected row discharge the lines storing 0, so nothing ever
  // fights and there is no static current.
  const c = buildCircuit('romcmos');
  expect(c, 'CMOS ROM uses no resistors', c.resistors.length, 0);
  expect(c, 'CMOS ROM uses both channel types',
    c.transistors.some(t => t.kind === 'pmos') &&
    c.transistors.some(t => t.kind === 'nmos'), true);

  const text = 'LOGIC 42';
  for (let addr = 0; addr < 8; addr++) {
    // PRE drops *before* the address moves. Dynamic logic has a phase
    // order: change the address mid-evaluate and the new row discharges
    // lines the old one already pulled down, and they never come back —
    // a discharged line is only reclaimed by a precharge.
    sw(c, 'PRE', false);
    for (let i = 0; i < 3; i++) sw(c, `A${i}`, !!((addr >> i) & 1));
    settle(c);
    // every line comes up, whatever is stored, and comes up *driven* —
    // the foot transistor is what stops the array fighting the pull-up
    // here, and without it a selected row shorts the rails and reads X
    for (let b = 0; b < 8; b++) {
      expect(c, `precharge lifts D${b} (addr ${addr})`, lampV(c, `D${b}`), HI);
    }
    for (const t of c.transistors) {
      expect(c, `precharge draws no crowbar current (addr ${addr})`,
        c.value[t.a] !== X && c.value[t.b] !== X, true);
    }

    sw(c, 'PRE', true); settle(c);           // evaluate
    let byte = 0;
    for (let b = 0; b < 8; b++) if (lampV(c, `D${b}`) === HI) byte |= 1 << b;
    expect(c, `CMOS ROM addr ${addr} reads "${text[addr]}"`,
      byte, text.charCodeAt(addr));
  }
  // Both ROMs hold the same program, by different means — that comparison
  // is the reason to keep both in the library.
  const nmos = buildCircuit('rom8');
  for (let addr = 0; addr < 8; addr++) {
    for (let i = 0; i < 3; i++) sw(nmos, `A${i}`, !!((addr >> i) & 1));
    settle(nmos);
    let byte = 0;
    for (let b = 0; b < 8; b++) if (lampV(nmos, `D${b}`) === HI) byte |= 1 << b;
    expect(nmos, `both ROMs agree at addr ${addr}`, byte, text.charCodeAt(addr));
  }
}
{
  // The library circuit reads back the ASCII it was programmed with.
  const c = buildCircuit('rom8');
  const text = 'LOGIC 42';
  for (let addr = 0; addr < 8; addr++) {
    for (let i = 0; i < 3; i++) sw(c, `A${i}`, !!((addr >> i) & 1));
    settle(c);
    let byte = 0;
    for (let b = 0; b < 8; b++) if (lampV(c, `D${b}`) === HI) byte |= 1 << b;
    expect(c, `rom8 addr ${addr} reads "${text[addr]}"`, byte, text.charCodeAt(addr));
  }
}

// ── 4-bit ALU ────────────────────────────────────────────────────────────
// Full sweep: six functions over every operand pair. The result bus is
// shared by six transmission gates, so this also asserts that exactly one
// driver is ever open — a second one would show as X, and none as Z.
{
  const c = buildCircuit('alu4');
  const OPS = ['ADD', 'SUB', 'AND', 'OR', 'XOR', 'SHL'];
  const want = (op, a, b) => {
    switch (op) {
      case 'ADD': return (a + b) & 15;
      case 'SUB': return (a - b) & 15;
      case 'AND': return a & b;
      case 'OR': return a | b;
      case 'XOR': return a ^ b;
      case 'SHL': return (a << 1) & 15;
    }
  };
  const setBus = (name, val, bits) => {
    for (let i = 0; i < bits; i++) sw(c, `${name}${i}`, !!((val >> i) & 1));
  };
  for (let f = 0; f < 6; f++) {
    setBus('F', f, 3);
    for (let a = 0; a < 16; a++) {
      setBus('A', a, 4);
      for (let b = 0; b < 16; b++) {
        setBus('B', b, 4);
        settle(c);
        let got = 0, clean = true;
        for (let i = 0; i < 4; i++) {
          const v = lampV(c, `Y${i}`);
          if (v === HI) got |= 1 << i;
          else if (v !== LO) clean = false;
          // the bus must be driven, not floating or contended
          if (lampStr(c, `Y${i}`) !== STRONG) clean = false;
        }
        expect(c, `${OPS[f]} ${a},${b}`, got, want(OPS[f], a, b));
        expect(c, `${OPS[f]} ${a},${b} bus driven`, clean, true);
      }
    }
  }
  // ADD sets carry out on overflow; SUB clears it on borrow
  setBus('F', 0, 3); setBus('A', 15, 4); setBus('B', 1, 4); settle(c);
  expect(c, 'ADD 15+1 carries', lampV(c, 'Cout'), HI);
  setBus('F', 1, 3); setBus('A', 3, 4); setBus('B', 5, 4); settle(c);
  expect(c, 'SUB 3-5 borrows', lampV(c, 'Cout'), LO);
  // An unused function code opens no pass gate, so nothing drives the bus.
  // It does not read Z: with every gate shut the net keeps its last value
  // on stored charge (see CLAUDE.md — a lit lamp is not a driven net), so
  // the honest assertion is on strength, not value.
  setBus('F', 4, 3); setBus('A', 15, 4); setBus('B', 0, 4); settle(c);
  expect(c, 'XOR drives the bus hard', lampStr(c, 'Y0'), STRONG);
  setBus('F', 7, 3); settle(c);
  expect(c, 'unused code leaves the bus undriven', lampStr(c, 'Y0'), CHARGE);
  // Which value it holds is not predictable: the decoder's own gates settle
  // at slightly different times, so the bus can be pulled once more on the
  // way down before the last pass gate shuts. Only the strength is a
  // guarantee — that no function is driving.
  for (let i = 0; i < 4; i++) {
    expect(c, `unused code: Y${i} undriven`, lampStr(c, `Y${i}`), CHARGE);
  }
}

// ── static conduction tables ─────────────────────────────────────────────
// solve() precomputes a flat CSR edge list and only flips per-edge flags.
// The tables must be rebuilt whenever the topology grows, or a circuit
// built up in stages silently solves against a stale graph.
{
  const c = new Circuit('late-devices');
  c.implicitGround = false;
  const a = c.net();
  // solve() before the circuit is finished: builds tables at this size
  c.solve();
  // now grow it — an inverter added after the first solve
  const out = c.net();
  c.addTransistor('P', 'pmos', a, 0, out, 0, 0);
  c.addTransistor('N', 'nmos', a, out, 1, 0, 0);
  const sIn = c.addSwitch('IN', a, 'toggle', 0, 0, { from: 0, to: 1 });
  sIn.on = false;                    // changeover parks IN at VSS → out HI
  for (const t of c.transistors) { t.on = t.kind === 'pmos'; }
  const v = c.solve();
  expect(c, 'devices added after a solve still conduct', VALUE_CHAR[v[out]], '1');
}
{
  // Diodes keep their one-way behaviour in the shared edge structure:
  // a diode passes HI anode→cathode but must not pass it backwards.
  const c = new Circuit('diode-dir');
  c.implicitGround = false;
  const anode = c.net(), cathode = c.net();
  c.addDiode('D', anode, cathode, 0, 0);
  const s = c.addSwitch('S', anode, 'toggle', 0, 0, { from: 0, to: 1 });
  s.on = true;                       // drive the anode high
  let v = c.solve();
  expect(c, 'diode passes forward', VALUE_CHAR[v[cathode]], '1');

  const c2 = new Circuit('diode-rev');
  c2.implicitGround = false;
  const an2 = c2.net(), ca2 = c2.net();
  c2.addDiode('D', an2, ca2, 0, 0);
  const s2 = c2.addSwitch('S', ca2, 'toggle', 0, 0, { from: 0, to: 1 });
  s2.on = true;                      // drive the *cathode* high
  v = c2.solve();
  expect(c2, 'diode blocks reverse HI', VALUE_CHAR[v[an2]] !== '1', true);
}

// ── sound counters: clicks vs channel switchings ─────────────────────────
// step() returns armature movements and parks channel switchings on
// c.switchings. The app plays a different timbre for each, so a circuit
// made of one device family must not report the other's count.
//
// A transition takes two steps: the first schedules it, a later one at the
// event time applies it and counts. Stepping once after a flip counts zero.
function flipAndStep(c, label, on) {
  sw(c, label, on);
  c.step(clock);                      // schedules the transition
  let clicks = 0, switchings = 0;
  let guard = 0;
  while (c.nextEventAt() !== null && guard++ < 5000) {
    clock = c.nextEventAt() + 0.001;
    clicks += c.step(clock);
    switchings += c.switchings;
  }
  return { clicks, switchings };
}
{
  // a relay inverter clicks and never switches a channel
  const c = buildCircuit('not');
  settle(c);
  const n = flipAndStep(c, 'A', true);
  expect(c, 'relay circuit clicks', n.clicks > 0, true);
  expect(c, 'relay circuit has no channel switchings', n.switchings, 0);
}
{
  // a CMOS inverter is the mirror image: silent armatures, live channels
  const c = buildCircuit('cmosinv');
  settle(c);
  const n = flipAndStep(c, 'IN', true);
  expect(c, 'CMOS circuit does not click', n.clicks, 0);
  expect(c, 'CMOS circuit switches channels', n.switchings > 0, true);
}
{
  // the counter is per-step, not cumulative: a settled circuit reports 0
  const c = buildCircuit('cmosinv');
  sw(c, 'IN', true); settle(c);
  clock += 1000; c.step(clock);
  expect(c, 'settled circuit reports no switchings', c.switchings, 0);
}

// ── guides: bus hints and selector legends ───────────────────────────────
// A legend that drifts from the hardware is worse than no legend, so the
// ALU's table is checked against the circuit it describes.
{
  const entry = CIRCUITS.find(e => e.id === 'alu4');
  const c = buildCircuit('alu4');
  const t = entry.table;
  const setBus = (name, val, bits) => {
    for (let i = 0; i < bits; i++) sw(c, `${name}${i}`, !!((val >> i) & 1));
  };
  const OPS = {
    ADD: (a, b) => (a + b) & 15,
    SUB: (a, b) => (a - b) & 15,
    AND: (a, b) => a & b,
    OR: (a, b) => a | b,
    XOR: (a, b) => a ^ b,
    SHL: (a) => (a << 1) & 15,
  };
  setBus('A', 12, 4); setBus('B', 10, 4);
  for (let f = 0; f < 8; f++) {
    setBus('F', f, 3);
    const row = t.rows[t.select({ F: f })];
    expect(c, `legend has a row for F=${f}`, !!row, true);
    const fn = OPS[row.name];
    if (!fn) {                       // the "nothing selected" row
      settle(c);
      expect(c, `F=${f} legend says unselected, bus is undriven`,
        lampStr(c, 'Y0') !== STRONG, true);
      continue;
    }
    settle(c);
    let got = 0;
    for (let i = 0; i < 4; i++) if (lampV(c, `Y${i}`) === HI) got |= 1 << i;
    expect(c, `legend row "${row.name}" matches the hardware at F=${f}`,
      got, fn(12, 10));
  }
}
{
  // Hints must name buses that actually exist, or they silently never show.
  for (const entry of CIRCUITS) {
    if (!entry.hints) continue;
    const c = buildCircuit(entry.id);
    const buses = deriveBuses(c);
    const names = new Set([...buses.inputs, ...buses.outputs, ...buses.internals]
      .map(b => b.name));
    for (const key of Object.keys(entry.hints)) {
      expect(c, `${entry.id}: hint "${key}" names a real bus`, names.has(key), true);
    }
  }
}
{
  // A state readout must agree with the circuit it claims to describe —
  // one that did its own arithmetic would agree with a broken circuit too.
  const c = buildCircuit('alu4');
  const entry = CIRCUITS.find(e => e.id === 'alu4');
  const setBus = (n, v, b) => {
    for (let i = 0; i < b; i++) sw(c, `${n}${i}`, !!((v >> i) & 1));
  };
  const want = { AND: (a, b) => a & b, OR: (a, b) => a | b, XOR: (a, b) => a ^ b };
  for (const [a, b] of [[12, 10], [7, 3], [15, 1], [0, 0]]) {
    setBus('A', a, 4); setBus('B', b, 4); setBus('F', 2, 3);
    settle(c);
    const items = entry.state.read(c, { A: a, B: b, F: 2 });
    for (const it of items) {
      if (!want[it.label]) continue;   // ADD/SUB share the adder
      expect(c, `state ${it.label} of ${a},${b} matches the circuit`,
        it.text, String(want[it.label](a, b)));
    }
    // exactly one entry is marked as the selected function
    expect(c, `state marks one selection at F=2`,
      items.filter(i => i.mark === 'read').length, 1);
  }
  // the register file's state must reflect an actual write
  const rf = buildCircuit('regfile');
  const rfEntry = CIRCUITS.find(e => e.id === 'regfile');
  const set2 = (n, v, b) => {
    for (let i = 0; i < b; i++) sw(rf, `${n}${i}`, !!((v >> i) & 1));
  };
  sw(rf, 'WE', false); settle(rf);
  set2('WA', 6, 4); set2('D', 9, 4); settle(rf);
  sw(rf, 'WE', true); settle(rf);
  sw(rf, 'WE', false); settle(rf);
  const cells = rfEntry.state.read(rf, { RA: 6, WA: 6 });
  expect(rf, 'state shows the written register', cells[6].text, '9');
  // and writing one register must not have disturbed the rest — a
  // never-written latch is genuinely floating, shown as a dash
  expect(rf, 'state shows neighbours untouched', cells[7].text, '–');
}
{
  // Every legend's select() must land inside its own row list.
  for (const entry of CIRCUITS) {
    if (!entry.table) continue;
    const c = buildCircuit(entry.id);
    const buses = deriveBuses(c);
    const t = entry.table;
    // sweep each input bus over its full range, all combinations capped
    const ins = buses.inputs.slice(0, 4);
    const combos = 1 << ins.reduce((n, b) => n + Math.min(b.bits.length, 3), 0);
    for (let k = 0; k < Math.min(combos, 256); k++) {
      const vals = {};
      let shift = 0;
      for (const b of ins) {
        const w = Math.min(b.bits.length, 3);
        vals[b.name] = (k >> shift) & ((1 << w) - 1);
        shift += w;
      }
      const i = t.select(vals);
      expect(c, `${entry.id}: legend select in range`,
        i === -1 || (i >= 0 && i < t.rows.length), true);
    }
  }
}

// ── NMOS gate family ─────────────────────────────────────────────────────
// The pull-down network alone under a resistor load. Same shapes as CMOS —
// series is NAND, parallel is NOR — but with no complementary pull-up, so
// every 1 is driven only weakly and every 0 is driven hard. That asymmetry
// is the whole difference between the technologies, so assert on strength.
{
  const gates = {
    nmosnand: (a, b) => (a && b ? 0 : 1),
    nmosnor: (a, b) => (a || b ? 0 : 1),
    nmosand: (a, b) => (a && b ? 1 : 0),
    nmosor: (a, b) => (a || b ? 1 : 0),
  };
  for (const [id, fn] of Object.entries(gates)) {
    const c = buildCircuit(id);
    for (let i = 0; i < 4; i++) {
      const a = i & 1, b = (i >> 1) & 1;
      sw(c, 'A', !!a); sw(c, 'B', !!b);
      settle(c);
      const want = fn(a, b);
      expect(c, `${id}(${a},${b})`, lampV(c, 'OUT'), want ? HI : LO);
      // a 1 comes from the load resistor and is WEAK; a 0 is pulled hard
      // to ground by the transistor. Reversing this would mean the gate
      // had somehow acquired a complementary pull-up.
      expect(c, `${id}(${a},${b}) drive strength`,
        lampStr(c, 'OUT'), want ? WEAK : STRONG);
    }
  }
}

// ── ring oscillators in silicon ──────────────────────────────────────────
{
  for (const id of ['nmosring', 'cmosring']) {
    const c = buildCircuit(id);
    // RUN low breaks the loop, so it must settle
    sw(c, 'RUN', false);
    settle(c);
    // RUN high closes an odd number of inversions: it can never settle
    sw(c, 'RUN', true);
    clock += 5000; c.step(clock);
    let events = 0;
    for (let k = 0; k < 40; k++) {
      const t = c.nextEventAt();
      if (t === null) break;
      clock = t + 0.001;
      c.step(clock);
      events++;
    }
    expect(c, `${id} keeps oscillating`, events, 40);
  }
  // The comparison worth making: a CMOS stage glitches through X on every
  // handover — both halves briefly on, a real crowbar — while an NMOS
  // stage cannot, because a resistor load never fights hard enough to
  // short the rails. This is why CMOS burns power per transition and NMOS
  // burns it continuously.
  const seen = {};
  for (const id of ['nmosring', 'cmosring']) {
    const c = buildCircuit(id);
    sw(c, 'RUN', true);
    clock += 5000; c.step(clock);
    let sawX = false;
    for (let k = 0; k < 60; k++) {
      const t = c.nextEventAt();
      if (t === null) break;
      clock = t + 0.001;
      c.step(clock);
      c.solve();
      if (c.lamps.some(l => c.value[l.net] === X)) sawX = true;
    }
    seen[id] = sawX;
  }
  expect({ name: 'cmosring' }, 'CMOS handover glitches through X', seen.cmosring, true);
  expect({ name: 'nmosring' }, 'NMOS handover never shorts the rails', seen.nmosring, false);
}

// ── composed CMOS gates as library circuits ──────────────────────────────
// The module-level gate tests exercise And2/Or2/Xor2 directly. These build
// the *library circuits* wrapped around them, which is a different wiring
// path — switches bound to module ports, output taken from a lamp — and a
// swapped port bind there would pass every other test in this file.
{
  const gates = {
    cmosand: (a, b) => (a && b ? 1 : 0),
    cmosor: (a, b) => (a || b ? 1 : 0),
    cmosxor: (a, b) => (a ^ b ? 1 : 0),
  };
  for (const [id, fn] of Object.entries(gates)) {
    const c = buildCircuit(id);
    for (let i = 0; i < 4; i++) {
      const a = i & 1, b = (i >> 1) & 1;
      sw(c, 'A', !!a); sw(c, 'B', !!b);
      settle(c);
      expect(c, `${id}(${a},${b})`, lampV(c, 'OUT'), fn(a, b) ? HI : LO);
      // complementary, so both levels are driven hard — this is the
      // contrast with the NMOS family above
      expect(c, `${id}(${a},${b}) driven hard`, lampStr(c, 'OUT'), STRONG);
    }
  }
}

// ── the same logic in two technologies ───────────────────────────────────
// These circuits exist to be compared, so they are tested as pairs: the
// NMOS and CMOS versions of a function must agree on every input, or the
// comparison the library invites is a lie.
{
  // decoders: exactly one output high, and it must be the addressed one
  for (const id of ['nmosdec', 'cmosdec']) {
    const c = buildCircuit(id);
    for (let a = 0; a < 4; a++) {
      sw(c, 'A0', !!(a & 1)); sw(c, 'A1', !!(a & 2));
      settle(c);
      const hot = [0, 1, 2, 3].filter(i => lampV(c, `Y${i}`) === HI);
      expect(c, `${id} addr ${a} selects one line`, hot.length, 1);
      expect(c, `${id} addr ${a} selects the right line`, hot[0], a);
    }
  }
}
{
  // D latches: transparent while enabled, holding when not. Both
  // technologies, though they are built from entirely different shapes —
  // pass gates in CMOS, cross-coupled NORs in NMOS.
  for (const id of ['nmoslatch', 'cmoslatch']) {
    const c = buildCircuit(id);
    const en = on => {
      sw(c, 'EN', on);
      if (c.switches.some(s => s.label === 'NEN')) sw(c, 'NEN', !on);
    };
    sw(c, 'D', true); en(true); settle(c);
    expect(c, `${id} follows D=1 while enabled`, lampV(c, 'Q'), HI);
    sw(c, 'D', false); settle(c);
    expect(c, `${id} follows D=0 while enabled`, lampV(c, 'Q'), LO);
    sw(c, 'D', true); settle(c);
    en(false); settle(c);
    expect(c, `${id} holds after enable falls`, lampV(c, 'Q'), HI);
    sw(c, 'D', false); settle(c);
    expect(c, `${id} ignores D while held`, lampV(c, 'Q'), HI);
    en(true); settle(c);
    expect(c, `${id} transparent again`, lampV(c, 'Q'), LO);
  }
}
{
  // full adder, one bit, both technologies
  const c = buildCircuit('cmosfa');
  for (let i = 0; i < 8; i++) {
    const a = i & 1, b = (i >> 1) & 1, cin = (i >> 2) & 1;
    sw(c, 'A', !!a); sw(c, 'B', !!b); sw(c, 'Cin', !!cin);
    settle(c);
    const t = a + b + cin;
    expect(c, `cmosfa ${a}+${b}+${cin} sum`, lampV(c, 'S'), (t & 1) ? HI : LO);
    expect(c, `cmosfa ${a}+${b}+${cin} carry`, lampV(c, 'Cout'), t > 1 ? HI : LO);
  }
}
{
  // 4-bit NMOS ripple adder — full sweep, the same guarantee the relay
  // adders get
  const c = buildCircuit('nmosadd4');
  const set = (p, v, n) => { for (let i = 0; i < n; i++) sw(c, `${p}${i}`, !!((v >> i) & 1)); };
  for (let a = 0; a < 16; a++) {
    for (let b = 0; b < 16; b++) {
      set('A', a, 4); set('B', b, 4); sw(c, 'Cin', false);
      settle(c);
      let s = 0;
      for (let i = 0; i < 4; i++) if (lampV(c, `S${i}`) === HI) s |= 1 << i;
      const co = lampV(c, 'Cout') === HI ? 1 : 0;
      expect(c, `nmosadd4 ${a}+${b}`, co * 16 + s, a + b);
      // Still NMOS all the way up: a 1 comes from a load resistor and is
      // WEAK, a 0 is pulled hard to ground. Checking only the arithmetic
      // would pass on an adder that had quietly acquired CMOS pull-ups,
      // which is the one thing this circuit exists to contrast.
      for (let i = 0; i < 4; i++) {
        expect(c, `nmosadd4 ${a}+${b} S${i} drive`,
          lampStr(c, `S${i}`), lampV(c, `S${i}`) === HI ? WEAK : STRONG);
      }
    }
  }
}
{
  // NMOS ALU: four functions over the whole input space. No tri-state here
  // — the result is an OR of gated candidates — so every output bit must
  // be a settled level, never floating.
  const c = buildCircuit('nmosalu');
  const set = (p, v, n) => { for (let i = 0; i < n; i++) sw(c, `${p}${i}`, !!((v >> i) & 1)); };
  const fns = [(a, b) => (a + b) & 15, (a, b) => a & b, (a, b) => a | b, (a, b) => a ^ b];
  const names = ['ADD', 'AND', 'OR', 'XOR'];
  for (let f = 0; f < 4; f++) {
    set('F', f, 2);
    for (let a = 0; a < 16; a++) {
      for (let b = 0; b < 16; b++) {
        set('A', a, 4); set('B', b, 4);
        settle(c);
        let got = 0, clean = true;
        for (let i = 0; i < 4; i++) {
          const v = lampV(c, `Y${i}`);
          if (v === HI) got |= 1 << i;
          else if (v !== LO) clean = false;
        }
        expect(c, `nmosalu ${names[f]} ${a},${b}`, got, fns[f](a, b));
        expect(c, `nmosalu ${names[f]} ${a},${b} settled`, clean, true);
        // the result comes through an OR of gated candidates, all NMOS, so
        // the drive asymmetry has to survive the whole mux tree
        for (let i = 0; i < 4; i++) {
          expect(c, `nmosalu ${names[f]} ${a},${b} Y${i} drive`,
            lampStr(c, `Y${i}`), lampV(c, `Y${i}`) === HI ? WEAK : STRONG);
        }
      }
    }
  }
}
{
  // The comparison itself: NMOS and CMOS XOR must agree, or the library's
  // invitation to compare them is misleading.
  const n = buildCircuit('nmosxor');
  const m = buildCircuit('cmosxor');
  for (let i = 0; i < 4; i++) {
    const a = !!(i & 1), b = !!(i & 2);
    sw(n, 'A', a); sw(n, 'B', b); settle(n);
    sw(m, 'A', a); sw(m, 'B', b); settle(m);
    expect(n, `XOR agrees across technologies (${+a},${+b})`,
      lampV(n, 'OUT'), lampV(m, 'OUT'));
  }
}

// ── catalogue data ───────────────────────────────────────────────────────
// The declarative half of a circuit lives in web/data/circuits.json, and
// the schema beside it is the reference for what a circuit may declare. A
// schema nobody checks is just a comment, so check the essentials here —
// no dependency, so this is a hand-rolled subset rather than a validator.
{
  const cat = JSON.parse(
    readFileSync(new URL('../web/data/circuits.json', import.meta.url), 'utf8'));
  const schema = JSON.parse(
    readFileSync(new URL('../web/data/circuits.schema.json', import.meta.url), 'utf8'));
  const allowed = new Set(Object.keys(schema.definitions.circuit.properties));
  const required = schema.definitions.circuit.required;
  const idPattern = new RegExp(schema.definitions.circuit.properties.id.pattern);
  const ctx = { name: 'circuits.json' };

  // Compare by id, not by count: two entries could drift — one renamed,
  // another dropped — and a length check would still pass at 48.
  const catIds = cat.circuits.map(e => e.id).sort().join(',');
  const regIds = CIRCUITS.map(e => e.id).sort().join(',');
  expect(ctx, 'catalogue and registry hold the same ids', catIds, regIds);
  const ids = new Set();
  for (const e of cat.circuits) {
    for (const key of required) {
      expect(ctx, `${e.id}: has required "${key}"`, typeof e[key], 'string');
    }
    for (const key of Object.keys(e)) {
      expect(ctx, `${e.id}: "${key}" is a known field`, allowed.has(key), true);
    }
    expect(ctx, `${e.id}: id matches the schema pattern`, idPattern.test(e.id), true);
    expect(ctx, `${e.id}: id is unique`, ids.has(e.id), false);
    ids.add(e.id);
    expect(ctx, `${e.id}: group is declared in groupOrder`,
      cat.groupOrder.includes(e.group), true);
    if (e.table) {
      for (const row of e.table.rows) {
        expect(ctx, `${e.id}: legend row has a code`, typeof row.code, 'string');
        expect(ctx, `${e.id}: legend row has a name`, typeof row.name, 'string');
      }
    }
    if (e.state && e.state.columns !== undefined) {
      expect(ctx, `${e.id}: state columns in range`,
        e.state.columns >= 1 && e.state.columns <= 8, true);
    }
  }
  // Prose is the teaching material, so an empty desc is a real defect
  // rather than a formatting nit.
  for (const e of cat.circuits) {
    expect(ctx, `${e.id}: desc says something`, e.desc.length > 30, true);
  }

  // Every string in the catalogue is shown to a reader verbatim, so a
  // literal backslash-u sequence is a visible defect — it reaches the page
  // as the six characters "\u2014" instead of an em dash. This happens
  // when the file is written by a tool that escapes twice, which is exactly
  // how it got in once already.
  const escapes = [];
  const scan = (o, path) => {
    if (typeof o === 'string') {
      if (/\\u[0-9a-fA-F]{4}/.test(o)) escapes.push(path);
    } else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) scan(v, `${path}.${k}`);
    }
  };
  for (const e of cat.circuits) scan(e, e.id);
  expect(ctx, 'no literal escape sequences in catalogue prose',
    escapes.join(', '), '');
}

// ── clocked state: flip-flops and counters ───────────────────────────────
// The first circuits that have to remember where they were. A latch would
// race here — transparent while enabled, so the incremented value would run
// straight back around — so these must be edge-triggered, and the tests
// assert the edge behaviour rather than just the count.
{
  const c = buildCircuit('cmospc4');
  const tick = () => {
    // one full cycle through the circuit's own clock, which is the same
    // path the UI's run and step controls take
    c.stepClock(); settle(c);   // rising
    c.stepClock(); settle(c);   // falling
  };
  const val = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) if (lampV(c, `Q${i}`) === HI) v |= 1 << i;
    return v;
  };
  expect(c, 'counter declares a clock', !!c.clock, true);

  sw(c, 'RST', true); sw(c, 'RUN', true); settle(c);
  expect(c, 'reset clears the count', val(), 0);
  sw(c, 'RST', false); settle(c);
  // Synchronous reset costs one edge: the first rising edge re-clocks the
  // zero that reset was holding at the input. Real synchronous resets do
  // exactly this, so the test encodes it rather than hiding it.
  tick();
  expect(c, 'first edge after reset re-clocks zero', val(), 0);
  for (let n = 1; n <= 15; n++) {
    tick();
    expect(c, `counts to ${n}`, val(), n);
  }
  tick();
  expect(c, 'rolls over at 16', val(), 0);

  // RUN low holds the value: the clock keeps going, the count does not
  for (let n = 0; n < 3; n++) tick();
  const held = val();
  sw(c, 'RUN', false); settle(c);
  tick(); tick();
  expect(c, 'RUN low holds the count', val(), held);
  sw(c, 'RUN', true); settle(c);
  tick();
  expect(c, 'RUN high resumes', val(), (held + 1) & 15);

  // Every stored bit is driven hard — these are static flip-flops, so a
  // paused machine holds its state indefinitely rather than decaying.
  for (let i = 0; i < 4; i++) {
    expect(c, `Q${i} is statically driven`, lampStr(c, `Q${i}`), STRONG);
  }
}
{
  // The 12-bit program counter: same module, three times as wide, and the
  // width that actually addresses the 4004's program space.
  const c = buildCircuit('cmospc12');
  const tick = () => { c.stepClock(); settle(c); c.stepClock(); settle(c); };
  const val = () => {
    let v = 0;
    for (let i = 0; i < 12; i++) if (lampV(c, `Q${i}`) === HI) v |= 1 << i;
    return v;
  };
  sw(c, 'RST', true); sw(c, 'RUN', true); settle(c);
  sw(c, 'RST', false); settle(c);
  tick();                       // the reset edge
  for (const n of [1, 2, 3]) { tick(); expect(c, `PC reaches ${n}`, val(), n); }
  // carry has to cross a byte boundary correctly — the bug a 4-bit test
  // cannot see
  for (let n = 4; n <= 260; n++) tick();
  expect(c, 'PC crosses 8-bit boundary', val(), 260);
}
{
  // Stepping by hand and running free must take the identical path, or a
  // machine you single-step would diverge from one you let run.
  const a = buildCircuit('cmospc4');
  const b = buildCircuit('cmospc4');
  for (const c of [a, b]) {
    sw(c, 'RST', true); sw(c, 'RUN', true); settle(c);
    sw(c, 'RST', false); settle(c);
  }
  // a: driven by stepClock, as the step button does
  for (let k = 0; k < 12; k++) { a.stepClock(); settle(a); }
  // b: driven by tickClock on a timer, as the run loop does
  b.clock.running = true;
  let now = 0;
  for (let k = 0; k < 12; k++) {
    now += b.clock.period;      // always past due, so every call ticks
    b.tickClock(now);
    settle(b);
  }
  const read = c => {
    let v = 0;
    for (let i = 0; i < 4; i++) if (lampV(c, `Q${i}`) === HI) v |= 1 << i;
    return v;
  };
  expect(a, 'stepping and running agree', read(a), read(b));
}

// ── instruction decoder ──────────────────────────────────────────────────
// Every one of the 256 possible instruction bytes must decode to exactly
// one opcode line. A decoder that lit two lines, or none, would send the
// sequencer down two paths at once — the failure that is hardest to see
// downstream and easiest to check here.
{
  const c = buildCircuit('fetch');
  // drive the instruction register directly by walking the ROM: the
  // machine only holds 8 bytes, so the exhaustive sweep is on the module
  const twoByteWant = (op, opa) =>
    op === 1 || op === 4 || op === 5 || op === 7 || (op === 2 && (opa & 1) === 0);
  for (let byte = 0; byte < 256; byte++) {
    const d = new Circuit('idec');
    d.implicitGround = false;
    const bind = {};
    for (let i = 0; i < 8; i++) {
      const n = d.net();
      d.addSwitch(`I${i}`, n, 'toggle', 0, 0, { from: 0, to: 1 }).on =
        !!((byte >> i) & 1);
      bind[`i${i}`] = n;
    }
    const D = instantiate(d, InstructionDecoder, 0, 0, bind);
    settle(d);
    const op = (byte >> 4) & 15, opa = byte & 15;
    let hot = 0, which = -1;
    for (let i = 0; i < 16; i++) {
      if (d.value[D.nets[`op${i}`]] === HI) { hot++; which = i; }
    }
    expect(d, `0x${byte.toString(16)} lights exactly one line`, hot, 1);
    expect(d, `0x${byte.toString(16)} decodes to OPR ${op}`, which, op);
    expect(d, `0x${byte.toString(16)} twoByte`,
      d.value[D.nets.twoByte] === HI, twoByteWant(op, opa));
  }
}

// ── the fetch machine ────────────────────────────────────────────────────
// PC → ROM → instruction register → decoder, running on a clock. The first
// circuit that executes rather than computes.
{
  const c = buildCircuit('fetch');
  const tick = () => { c.stepClock(); settle(c); c.stepClock(); settle(c); };
  const rd = (p, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) if (lampV(c, `${p}${i}`) === HI) v |= 1 << i;
    return v;
  };
  sw(c, 'RST', true); sw(c, 'RUN', true); settle(c);
  sw(c, 'RST', false); settle(c);
  tick();                       // the synchronous-reset edge

  // The instruction register lags the PC by one cycle: the byte in the
  // register was fetched at the *previous* address. That is a pipeline,
  // not an off-by-one — the register is what makes a fetched instruction
  // stable for a whole cycle, and every later stage depends on it.
  const seen = [];
  for (let k = 0; k < 8; k++) {
    seen.push({ pc: rd('PC', 3), ir: rd('IR', 8) });
    tick();
  }
  for (let k = 1; k < 8; k++) {
    expect(c, `IR at step ${k} holds the byte from PC ${k - 1}`,
      seen[k].ir, c.program[k - 1]);
  }
  // and the PC walks 0..7 then wraps, because three bits is the whole ROM
  for (let k = 0; k < 8; k++) {
    expect(c, `PC reaches ${k}`, seen[k].pc, k);
  }
  // the loop above already ticked past the last address, so the PC has
  // wrapped: three bits is the whole ROM, and it runs in a ring
  expect(c, 'PC wraps to 0 at the end of the ROM', rd('PC', 3), 0);

  // exactly one decoded line at all times, for whatever is in the register
  for (let k = 0; k < 8; k++) {
    let hot = 0;
    for (let i = 0; i < 16; i++) if (c.value[c.decoded[i]] === HI) hot++;
    expect(c, 'exactly one instruction decoded', hot, 1);
    tick();
  }
}

// ── control sequencing ───────────────────────────────────────────────────
// The ring counter generates the phases and the control unit gates the
// datapath from them. Exactly one phase active at a time is the property
// everything downstream depends on — two would fire conflicting control
// lines in the same cycle.
{
  const c = buildCircuit('sequenced');
  const tick = () => { c.stepClock(); settle(c); c.stepClock(); settle(c); };
  const rd = (p, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) if (lampV(c, `${p}${i}`) === HI) v |= 1 << i;
    return v;
  };
  const phase = () => [0, 1, 2].filter(i => c.value[c.phases[i]] === HI);

  sw(c, 'RST', true); settle(c);
  tick();                       // synchronous reset lands
  expect(c, 'reset drops the ring into FETCH', JSON.stringify(phase()), '[0]');
  sw(c, 'RST', false); settle(c);

  // the ring rotates, one phase at a time, forever
  for (let k = 0; k < 12; k++) {
    expect(c, `exactly one phase active at step ${k}`, phase().length, 1);
    tick();
  }

  // An instruction must hold still across all three of its phases. If the
  // register followed the ROM on every edge it would show the *next*
  // instruction by EXEC, since the PC advances during FETCH — the control
  // unit would then act on the wrong one.
  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);
  // align to a FETCH boundary first — the register changes *during* FETCH,
  // so a window that straddles one would see two different instructions
  // and the test would be measuring its own misalignment
  while (phase()[0] !== 0) tick();
  tick();                      // step past the load itself
  for (let instr = 0; instr < 4; instr++) {
    const held = [];
    for (let p = 0; p < 3; p++) { held.push(rd('IR', 8)); tick(); }
    expect(c, `instruction ${instr} holds across its phases`,
      held[0] === held[1] && held[1] === held[2], true);
  }

  // Control lines only fire in the phase that owns them: irLoad during
  // FETCH, and never during EXEC.
  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);
  for (let k = 0; k < 9; k++) {
    const p = phase()[0];
    const irLoad = c.value[c.control.irLoad] === HI;
    if (p === 0) expect(c, 'irLoad fires during FETCH', irLoad, true);
    if (p === 2) expect(c, 'irLoad is silent during EXEC', irLoad, false);
    tick();
  }
}
{
  // The ring counter on its own: it must never be empty and never hold two
  // bits. Both failures are unrecoverable — an empty ring stops the machine
  // forever, and a double ring fires two phases' control lines at once.
  const c = new Circuit('ring');
  c.implicitGround = false;
  const clk = c.net(), nclk = c.net(), rst = c.net();
  const sClk = c.addSwitch('CLK', clk, 'toggle', 0, 0, { from: 0, to: 1 });
  const sRst = c.addSwitch('RST', rst, 'toggle', 0, 0, { from: 0, to: 1 });
  instantiate(c, Inverter, 0, 120, { a: clk, y: nclk });
  const R = instantiate(c, ringCounter(3), 0, 0, { clk, nclk, rst });
  const tick = () => {
    sClk.on = true; settle(c); sClk.on = false; settle(c);
  };
  sRst.on = true; settle(c); tick();
  sRst.on = false; settle(c);
  for (let k = 0; k < 9; k++) {
    let hot = 0;
    for (let i = 0; i < 3; i++) if (c.value[R.nets[`p${i}`]] === HI) hot++;
    expect(c, `ring holds exactly one bit at step ${k}`, hot, 1);
    tick();
  }
}

// ── the clock must not outrun the circuit ────────────────────────────────
// A synchronous machine clocked before its combinational logic has settled
// latches half-propagated values: a counter clocked mid-carry stores a
// number that is neither the old one nor the new one. Real hardware meets
// this by choosing a period longer than the critical path; here the device
// delays are visible and adjustable, so the clock has to wait instead.
//
// This was a real bug — free-running counters corrupted or stuck while
// hand-stepping worked, because stepping always let the circuit settle.
{
  for (const period of [1200, 400, 100]) {
    const c = buildCircuit('cmospc4');
    sw(c, 'RST', true); sw(c, 'RUN', true);
    c.clock.running = true;
    c.clock.period = period;
    let now = 0;
    const counts = [];
    let last = null;
    for (let f = 0; f < 3000; f++) {
      now += 16;
      c.tickClock(now);
      c.step(now);
      if (f === 30) sw(c, 'RST', false);
      // sample only when fully settled, which is the only moment the
      // value means anything — mid-transition a CMOS stage is legitimately
      // X while its two halves hand over
      if (f > 60 && c.nextEventAt() === null) {
        c.solve();
        let v = 0, clean = true;
        for (let i = 0; i < 4; i++) {
          const b = lampV(c, `Q${i}`);
          if (b === HI) v |= 1 << i;
          else if (b !== LO) clean = false;
        }
        if (clean && v !== last) { counts.push(v); last = v; }
      }
    }
    // Whatever the period, settled values must only ever step by one.
    // A skip means an edge landed on a half-propagated carry.
    let bad = 0;
    for (let i = 1; i < counts.length; i++) {
      if (counts[i] !== ((counts[i - 1] + 1) & 15)) bad++;
    }
    expect({ name: `clock@${period}` },
      `counts monotonically at period ${period}`, bad, 0);
    expect({ name: `clock@${period}` },
      `actually counted at period ${period}`, counts.length > 4, true);
  }
}

// ── the accumulator machine: state that actually changes ─────────────────
// The first machine here that acts on what it decoded. LDM loads its
// operand nibble into the accumulator, so running the program leaves a
// number behind — and only LDM does, which is the property worth guarding.
{
  const c = buildCircuit('accmachine');
  const tick = () => { c.stepClock(); settle(c); c.stepClock(); settle(c); };
  const rd = (p, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) if (lampV(c, `${p}${i}`) === HI) v |= 1 << i;
    return v;
  };
  const phase = () => [0, 1, 2].findIndex(i => c.value[c.phases[i]] === HI);

  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);

  // Walk the program and record what the accumulator holds after each
  // instruction. The ROM is LDM 3, NOP, LDM 12, NOP, LDM 5, NOP, NOP, NOP.
  const wanted = [3, 3, 12, 12, 5, 5, 5, 5];
  const got = [];
  for (let k = 0; k < 8; k++) {
    // advance a whole instruction: three phases
    for (let p = 0; p < 3; p++) tick();
    got.push(rd('ACC', 4));
  }
  // the accumulator holds each loaded value until the next LDM replaces it
  expect(c, 'LDM loads the accumulator', got.includes(3), true);
  expect(c, 'a later LDM replaces it', got.includes(12), true);
  expect(c, 'and again', got.includes(5), true);

  // accLoad must fire only at EXEC of an LDM. Firing in another phase
  // would write the accumulator from whatever the register happened to
  // hold; firing on another instruction would corrupt it silently.
  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);
  let fires = 0, wrongPhase = 0, wrongInstr = 0;
  for (let k = 0; k < 24; k++) {
    if (c.value[c.control.accLoad] === HI) {
      fires++;
      if (phase() !== 2) wrongPhase++;
      if (((rd('IR', 8) >> 4) & 15) !== 13) wrongInstr++;   // 13 = LDM
    }
    tick();
  }
  expect(c, 'accLoad fires at all', fires > 0, true);
  expect(c, 'accLoad only fires during EXEC', wrongPhase, 0);
  expect(c, 'accLoad only fires for LDM', wrongInstr, 0);

  // Every accumulator bit is statically driven — this is a register, not a
  // node coasting on charge, so a paused machine keeps its value.
  for (let i = 0; i < 4; i++) {
    expect(c, `ACC${i} is statically driven`, lampStr(c, `ACC${i}`), STRONG);
  }
}
{
  // The register module on its own: it must hold when load is low, which
  // is the whole difference between a register and a wire.
  const c = new Circuit('reg');
  c.implicitGround = false;
  const clk = c.net(), nclk = c.net(), load = c.net();
  const sClk = c.addSwitch('CLK', clk, 'toggle', 0, 0, { from: 0, to: 1 });
  const sLoad = c.addSwitch('LD', load, 'toggle', 0, 0, { from: 0, to: 1 });
  instantiate(c, Inverter, 0, 200, { a: clk, y: nclk });
  const bind = { clk, nclk, load };
  const sd = [];
  for (let i = 0; i < 4; i++) {
    const n = c.net();
    sd.push(c.addSwitch(`D${i}`, n, 'toggle', 0, 0, { from: 0, to: 1 }));
    bind[`d${i}`] = n;
  }
  const R = instantiate(c, register(4), 0, 0, bind);
  const tick = () => { sClk.on = true; settle(c); sClk.on = false; settle(c); };
  const setD = v => { for (let i = 0; i < 4; i++) sd[i].on = !!((v >> i) & 1); };
  const val = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) if (c.value[R.nets[`q${i}`]] === HI) v |= 1 << i;
    return v;
  };
  setD(5); sLoad.on = true; settle(c); tick();
  expect(c, 'register loads', val(), 5);
  sLoad.on = false; settle(c);
  setD(10); settle(c); tick(); tick();
  expect(c, 'register holds while load is low', val(), 5);
  sLoad.on = true; settle(c); tick();
  expect(c, 'register loads again', val(), 10);
}

// ── the adding machine: the 4004's real ADD datapath ─────────────────────
// ADD r is the accumulator plus the named register plus the carry flag,
// result to the accumulator, carry updated. Every one of those is hardware
// here, so the test walks the program and checks the arithmetic rather than
// just that something changed.
{
  const c = buildCircuit('addmachine');
  const tick = () => { c.stepClock(); settle(c); c.stepClock(); settle(c); };
  const rd = (p, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) if (lampV(c, `${p}${i}`) === HI) v |= 1 << i;
    return v;
  };
  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);

  // Program: LDM 5, XCH 0, LDM 9, ADD 0, ADD 0, NOP, JUN 0, NOP.
  // Walk it and record the accumulator after each instruction completes.
  const trace = [];
  for (let k = 0; k < 8; k++) {
    for (let p = 0; p < 3; p++) tick();
    trace.push({ acc: rd('ACC', 4), carry: lampV(c, 'CARRY') === HI });
  }
  // 9 + 5 = 14 fits in four bits, so no carry
  expect(c, 'ADD produces the sum', trace.some(t => t.acc === 14), true);
  // 14 + 5 = 19, which is 3 with a carry out — the flag is the only place
  // that fifth bit survives, which is why ADD has to write it
  expect(c, 'ADD wraps and sets carry', trace.some(t => t.acc === 3 && t.carry), true);

  // accFromAlu must steer the accumulator only for ADD. If it fired for
  // LDM the accumulator would take the adder's output instead of the
  // immediate, and LDM would quietly load the wrong number.
  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);
  let steered = 0, wrongInstr = 0;
  for (let k = 0; k < 24; k++) {
    if (c.value[c.control.accFromAlu] === HI) {
      steered++;
      if (((rd('IR', 8) >> 4) & 15) !== 8) wrongInstr++;   // 8 = ADD
    }
    tick();
  }
  expect(c, 'accFromAlu fires at all', steered > 0, true);
  expect(c, 'accFromAlu only steers for ADD', wrongInstr, 0);
}
{
  // The ripple adder module on its own, swept across every operand pair
  // and both carry-ins — the same guarantee the relay adders get.
  const Add = rippleAdder(4);
  for (let a = 0; a < 16; a++) {
    for (let b = 0; b < 16; b++) {
      for (const ci of [0, 1]) {
        const c = new Circuit('add4');
        c.implicitGround = false;
        const bind = {};
        for (let i = 0; i < 4; i++) {
          const na = c.net(), nb = c.net();
          c.addSwitch(`A${i}`, na, 'toggle', 0, 0, { from: 0, to: 1 }).on =
            !!((a >> i) & 1);
          c.addSwitch(`B${i}`, nb, 'toggle', 0, 0, { from: 0, to: 1 }).on =
            !!((b >> i) & 1);
          bind[`a${i}`] = na; bind[`b${i}`] = nb;
        }
        const cn = c.net();
        c.addSwitch('CI', cn, 'toggle', 0, 0, { from: 0, to: 1 }).on = !!ci;
        bind.cin = cn;
        const I = instantiate(c, Add, 0, 0, bind);
        settle(c);
        let sum = 0;
        for (let i = 0; i < 4; i++) if (c.value[I.nets[`s${i}`]] === HI) sum |= 1 << i;
        const co = c.value[I.nets.cout] === HI ? 1 : 0;
        expect(c, `${a}+${b}+${ci}`, co * 16 + sum, a + b + ci);
      }
    }
  }
}

// ── JCN: the condition tree ──────────────────────────────────────────────
// JCN's operand is a mask, not a code: bit 2 tests zero, bit 1 tests carry,
// bit 0 tests the TEST pin, bit 3 inverts the result. Swept exhaustively
// against the real semantics, because a condition tree that is subtly wrong
// makes a program take a branch it should not and the symptom appears
// somewhere else entirely.
{
  const want = (mask, z, cy, test) => {
    const raw = (((mask >> 2) & 1) && z)
      || (((mask >> 1) & 1) && cy)
      || ((mask & 1) && !test);
    return ((mask >> 3) & 1) ? !raw : !!raw;
  };
  for (let mask = 0; mask < 16; mask++) {
    for (const z of [0, 1]) {
      for (const cy of [0, 1]) {
        for (const test of [0, 1]) {
          const c = new Circuit('cond');
          c.implicitGround = false;
          const mk = v => {
            const n = c.net();
            c.addSwitch(`S${c.netCount}`, n, 'toggle', 0, 0, { from: 0, to: 1 })
              .on = !!v;
            return n;
          };
          const I = instantiate(c, ConditionTree, 0, 0, {
            m0: mk(mask & 1), m1: mk((mask >> 1) & 1),
            m2: mk((mask >> 2) & 1), m3: mk((mask >> 3) & 1),
            accZero: mk(z), carry: mk(cy), test: mk(test),
          });
          settle(c);
          expect(c, `JCN mask ${mask} z=${z} cy=${cy} t=${test}`,
            c.value[I.nets.take] === HI, want(mask, z, cy, test));
        }
      }
    }
  }
}
{
  // The zero detector: an OR of every bit, inverted. It has to be computed
  // rather than stored, because the accumulator changes for reasons other
  // than a comparison and a stale flag would branch on old data.
  for (let v = 0; v < 16; v++) {
    const c = new Circuit('zero');
    c.implicitGround = false;
    const bind = {};
    for (let i = 0; i < 4; i++) {
      const n = c.net();
      c.addSwitch(`A${i}`, n, 'toggle', 0, 0, { from: 0, to: 1 }).on =
        !!((v >> i) & 1);
      bind[`a${i}`] = n;
    }
    const I = instantiate(c, IsZero4, 0, 0, bind);
    settle(c);
    expect(c, `zero detect ${v}`, c.value[I.nets.z] === HI, v === 0);
  }
}
{
  // The machine: a conditional jump must actually not take when its
  // condition is false. The plan calls for one taken and one untaken JCN
  // before trusting any loop.
  const c = buildCircuit('jcnmachine');
  const tick = () => { c.stepClock(); settle(c); c.stepClock(); settle(c); };
  const rd = (p, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) if (lampV(c, `${p}${i}`) === HI) v |= 1 << i;
    return v;
  };
  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);

  // The program is a countdown, so the same JCN must take while the
  // accumulator is non-zero and fall through when it reaches zero. Seeing
  // only one branch would leave the other untested by the demo.
  let tookWhenNonZero = 0, fellThroughWhenZero = 0, tookWhenZero = 0;
  for (let k = 0; k < 60; k++) {
    const isExec = c.value[c.phases[2]] === HI;
    const isJcn = ((rd('IR', 8) >> 4) & 15) === 1;
    if (isExec && isJcn) {
      const take = lampV(c, 'TAKE') === HI;
      const zero = lampV(c, 'ZERO') === HI;
      if (!zero && take) tookWhenNonZero++;
      if (zero && !take) fellThroughWhenZero++;
      if (zero && take) tookWhenZero++;     // must never happen
    }
    tick();
  }
  expect(c, 'JCN 12 takes while the accumulator is not zero',
    tookWhenNonZero > 0, true);
  expect(c, 'JCN 12 falls through when the accumulator is zero',
    fellThroughWhenZero > 0, true);
  expect(c, 'JCN 12 never takes while the accumulator is zero',
    tookWhenZero, 0);

  // and the countdown actually counts: the accumulator must pass through
  // every value on its way down, not skip or stall
  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);
  const seen = new Set();
  for (let k = 0; k < 60; k++) { tick(); seen.add(rd('ACC', 4)); }
  for (const v of [4, 3, 2, 1, 0]) {
    expect(c, `the countdown passes through ${v}`, seen.has(v), true);
  }

  // pcLoad must follow the condition, not the opcode: a JCN that does not
  // take must leave the program counter alone.
  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);
  let loadedWithoutTaking = 0;
  for (let k = 0; k < 40; k++) {
    const isJcn = ((rd('IR', 8) >> 4) & 15) === 1;
    if (isJcn && c.value[c.control.pcLoad] === HI
        && lampV(c, 'TAKE') !== HI) loadedWithoutTaking++;
    tick();
  }
  expect(c, 'an untaken JCN never loads the PC', loadedWithoutTaking, 0);
}

// ── the disassembler must agree with the hardware ────────────────────────
// The program listing is display code, but a listing that disagrees with
// the machine is worse than none — it would show one instruction while the
// circuit executed another. Both read the same opcode table, and this is
// what holds them together.
{
  const c = new Circuit('idec-vs-disasm');
  for (let byte = 0; byte < 256; byte++) {
    const d = new Circuit('d');
    d.implicitGround = false;
    const bind = {};
    for (let i = 0; i < 8; i++) {
      const n = d.net();
      d.addSwitch(`I${i}`, n, 'toggle', 0, 0, { from: 0, to: 1 }).on =
        !!((byte >> i) & 1);
      bind[`i${i}`] = n;
    }
    const D = instantiate(d, InstructionDecoder, 0, 0, bind);
    settle(d);
    // the hardware's twoByte line and the disassembler's must match on
    // every byte, including the FIM/SRC pair that shares an opcode
    expect(d, `twoByte agrees at 0x${byte.toString(16)}`,
      d.value[D.nets.twoByte] === HI, isTwoByte(byte));
    // and every byte must disassemble to something rather than throwing
    const { text } = disassemble(byte, 0);
    expect(d, `0x${byte.toString(16)} disassembles`, text.length > 0, true);
  }
  // spot-check the encodings the machines actually run
  const cases = [
    [0x00, 'NOP'], [0xD5, 'LDM 5'], [0xB0, 'XCH r0'], [0x80, 'ADD r0'],
    [0x60, 'INC r0'], [0x21, 'SRC 0P'], [0x20, 'FIM 0P'], [0xF1, 'CLC'],
    [0xE9, 'RDM'],
  ];
  for (const [byte, want] of cases) {
    expect(c, `0x${byte.toString(16).toUpperCase()} is ${want}`,
      disassemble(byte).text.split(',')[0], want);
  }
  // Every machine's program listing has a line per ROM address — including
  // the operand bytes, because a jump can land on one and the machine will
  // execute it as an opcode.
  for (const e of CIRCUITS) {
    const m = buildCircuit(e.id);
    if (!m.program) continue;
    const rows = disassembleProgram(m.program);
    expect(m, `${e.id}: a listing line per ROM address`,
      rows.length, m.program.length);
  }
}

// ── JCN, every mask, in the machine ──────────────────────────────────────
// The ConditionTree module is swept exhaustively above, but a module is
// not a machine: a tree that is right in isolation and mis-wired into the
// datapath would pass that sweep and fail here. This drives the circuit's
// own condition inputs — the live accumulator, its computed zero flag, the
// carry register, the TEST switch — and checks the take line the control
// unit actually sees, for every one of the sixteen masks.
//
// The masks are reached by walking the machine to states with different
// flags rather than by forcing values in, because forcing them would test
// a circuit nobody runs. The accumulator and carry are driven by the
// datapath, exactly as they are on the real chip.
{
  // What the real 4004 does with a condition mask.
  const want = (mask, z, cy, test) => {
    const raw = (((mask >> 2) & 1) && z)
      || (((mask >> 1) & 1) && cy)
      || ((mask & 1) && !test);
    return ((mask >> 3) & 1) ? !raw : !!raw;
  };

  const c = buildCircuit('jcnmachine');
  const tick = () => { c.stepClock(); settle(c); c.stepClock(); settle(c); };
  const rd = (p, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) if (lampV(c, `${p}${i}`) === HI) v |= 1 << i;
    return v;
  };

  // Walk the countdown and check the take line at every JCN, against the
  // flags the machine itself computed. The countdown drives the
  // accumulator from 4 down to 0, so this covers both the zero and
  // non-zero cases with a real fetched instruction and real flags — and
  // with the TEST pin in both positions.
  for (const testPin of [false, true]) {
    sw(c, 'RST', true); settle(c); tick();
    sw(c, 'RST', false); sw(c, 'TEST', testPin); settle(c);
    let checked = 0;
    for (let k = 0; k < 80; k++) {
      const isExec = c.value[c.phases[2]] === HI;
      const ir = rd('IR', 8);
      if (isExec && ((ir >> 4) & 15) === 1) {
        const mask = ir & 15;
        const z = lampV(c, 'ZERO') === HI ? 1 : 0;
        const cy = lampV(c, 'CARRY') === HI ? 1 : 0;
        expect(c, `JCN mask ${mask} z=${z} cy=${cy} test=${+testPin}`,
          lampV(c, 'TAKE') === HI, want(mask, z, cy, testPin ? 1 : 0));
        checked++;
      }
      tick();
    }
    expect(c, `the JCN was reached with TEST=${+testPin}`, checked > 0, true);
  }
}
{
  // Every mask, on a machine that actually fetches it. One circuit per
  // mask: the ROM holds `JCN <mask>` after arithmetic that leaves known
  // flags, so the condition tree is answering about a real instruction
  // rather than about nets somebody poked.
  //
  // The setup leaves the accumulator at zero with the carry set — 13 + 3
  // wraps in four bits — so z=1 and cy=1 at the JCN. That exercises both
  // flags at once, and it is the state the countdown demo ends in.
  const want = (mask, z, cy, test) => {
    const raw = (((mask >> 2) & 1) && z)
      || (((mask >> 1) & 1) && cy)
      || ((mask & 1) && !test);
    return ((mask >> 3) & 1) ? !raw : !!raw;
  };
  for (let mask = 0; mask < 16; mask++) {
    for (const testPin of [false, true]) {
      const m = buildJcnMachine([
        0xD3,             // LDM 3
        0xB0,             // XCH r0
        0xDD,             // LDM 13  (= -3 in four bits)
        0x80,             // ADD r0  → 0 with a carry out
        0x10 | mask,      // JCN <mask>
        0x00, 0x00, 0x00,
      ]);
      const tick = () => { m.stepClock(); settle(m); m.stepClock(); settle(m); };
      const rd = (p, n) => {
        let v = 0;
        for (let i = 0; i < n; i++) if (lampV(m, `${p}${i}`) === HI) v |= 1 << i;
        return v;
      };
      sw(m, 'RST', true); settle(m); tick();
      sw(m, 'RST', false); sw(m, 'TEST', testPin); settle(m);

      let saw = false;
      for (let k = 0; k < 30 && !saw; k++) {
        const isExec = m.value[m.phases[2]] === HI;
        const ir = rd('IR', 8);
        if (isExec && ((ir >> 4) & 15) === 1 && (ir & 15) === mask) {
          const z = lampV(m, 'ZERO') === HI ? 1 : 0;
          const cy = lampV(m, 'CARRY') === HI ? 1 : 0;
          expect(m, `fetched JCN ${mask}, z=${z} cy=${cy} test=${+testPin}`,
            lampV(m, 'TAKE') === HI, want(mask, z, cy, testPin ? 1 : 0));
          saw = true;
        }
        tick();
      }
      expect(m, `mask ${mask} was fetched and executed (test=${+testPin})`,
        saw, true);
    }
  }
}

// ── the program listing highlights the executing instruction ─────────────
// Not the one being fetched. Those differ by a cycle: the PC advances
// during FETCH, so by the time an instruction's effect is visible the
// counter has moved past it. Highlighting the PC blames the wrong line for
// what you just watched happen, which is exactly the bug this guards.
{
  const c = buildCircuit('jcnmachine');
  const tick = () => { c.stepClock(); settle(c); c.stepClock(); settle(c); };
  const rd = (p, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) if (lampV(c, `${p}${i}`) === HI) v |= 1 << i;
    return v;
  };
  expect(c, 'the machine publishes an executing address',
    typeof c.execAddr, 'function');

  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);

  // Walk until the accumulator first becomes 15. The instruction that did
  // it is LDM 15 at address 0 — the highlight must be there, not on the
  // XCH at address 1 that the PC has already advanced to.
  let blamed = null;
  for (let k = 0; k < 12 && blamed === null; k++) {
    tick();
    if (rd('ACC', 4) === 15) blamed = c.execAddr();
  }
  expect(c, 'the accumulator reaches 15', blamed !== null, true);
  expect(c, 'LDM 15 is blamed for the accumulator becoming 15', blamed, 0);

  // and the highlighted address must always hold the byte the instruction
  // register is actually running
  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);
  let mismatched = 0;
  for (let k = 0; k < 20; k++) {
    tick();
    const a = c.execAddr();
    if (a >= 0 && c.program[a] !== rd('IR', 8)) mismatched++;
  }
  expect(c, 'the highlighted line matches the instruction register',
    mismatched, 0);
}

// ── two-byte fetch ───────────────────────────────────────────────────────
// The jump target stops being welded to the opcode. Every earlier machine
// read a jump's destination from the low bits of the jump instruction
// itself; this one fetches a second byte, which is what the real chip
// does and what lets a condition mask and an address coexist.
{
  const c = buildCircuit('twobyte');
  const tick = () => { c.stepClock(); settle(c); c.stepClock(); settle(c); };
  const rd = (p, n) => {
    let v = 0;
    for (let i = 0; i < n; i++) if (lampV(c, `${p}${i}`) === HI) v |= 1 << i;
    return v;
  };
  const phase = () => [0, 1, 2, 3].findIndex(i => c.value[c.phases[i]] === HI);

  expect(c, 'the ring has four phases', c.phases.length, 4);

  // The program's JCN uses mask 13, which tests the TEST pin as well as
  // zero: the loop runs while the accumulator is non-zero AND TEST is
  // high. So TEST goes high for the tests that expect the loop to run.
  sw(c, 'TEST', true);
  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);
  for (let k = 0; k < 20; k++) {
    expect(c, `exactly one phase active at step ${k}`,
      [0, 1, 2, 3].filter(i => c.value[c.phases[i]] === HI).length, 1);
    tick();
  }

  // oprLoad must fire only during FETCH2, and only for an instruction that
  // has an operand. Firing on a one-byte instruction would capture the
  // *next opcode* as an operand and the jump would go somewhere arbitrary.
  sw(c, 'TEST', true);
  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);
  let loads = 0, wrongPhase = 0, wrongInstr = 0;
  for (let k = 0; k < 60; k++) {
    if (c.value[c.control.oprLoad] === HI) {
      loads++;
      if (phase() !== 2) wrongPhase++;
      const opr = (rd('IR', 8) >> 4) & 15;
      // only JCN(1), JUN(4), JMS(5), ISZ(7) and FIM take a second byte
      if (![1, 2, 4, 5, 7].includes(opr)) wrongInstr++;
    }
    tick();
  }
  expect(c, 'oprLoad fires at all', loads > 0, true);
  expect(c, 'oprLoad only fires during FETCH2', wrongPhase, 0);
  expect(c, 'oprLoad only fires for two-byte instructions', wrongInstr, 0);

  // The jump goes to the *operand*, not to the opcode's low bits. The
  // program's JCN is 0x1C at address 4 with operand 3 at address 5: the
  // opcode's low bits are 12, so a machine still reading them would jump
  // to 4 and this would fail.
  sw(c, 'TEST', true);
  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);
  let jumpedTo = null;
  for (let k = 0; k < 60 && jumpedTo === null; k++) {
    const wasJump = c.value[c.control.pcLoad] === HI && phase() === 3;
    tick();
    if (wasJump) jumpedTo = rd('PC', 3);
  }
  expect(c, 'a jump happened', jumpedTo !== null, true);
  expect(c, 'the jump used the operand byte, not the opcode', jumpedTo, 3);

  // and the countdown still runs, so the loop terminates
  sw(c, 'TEST', true);
  sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);
  const seen = new Set();
  for (let k = 0; k < 90; k++) { tick(); seen.add(rd('ACC', 4)); }
  for (const v of [4, 3, 2, 1, 0]) {
    expect(c, `two-byte machine counts through ${v}`, seen.has(v), true);
  }

  // The TEST pin is a real input and must change what the program does.
  // Mask 13 continues the loop only while the pin is high, so pulling it
  // low has to break out at the first JCN — which is the whole point of
  // having the pin, and was not demonstrable before the mask stopped
  // doubling as a jump address.
  const runLoop = pin => {
    sw(c, 'TEST', pin);
    sw(c, 'RST', true); settle(c); tick(); sw(c, 'RST', false); settle(c);
    let taken = 0;
    for (let k = 0; k < 40; k++) {
      const isExec = c.value[c.phases[3]] === HI;
      if (isExec && ((rd('IR', 8) >> 4) & 15) === 1
          && lampV(c, 'TAKE') === HI) taken++;
      tick();
    }
    return taken;
  };
  const withPinHigh = runLoop(true);
  const withPinLow = runLoop(false);
  expect(c, 'the loop runs while TEST is high', withPinHigh > 1, true);
  expect(c, 'pulling TEST low breaks out of the loop', withPinLow, 0);
}

// ── picker grouping ──────────────────────────────────────────────────────
// Sections are by technology, so a circuit's group has to match the devices
// it is actually made of — otherwise a new circuit lands in the wrong
// section and quietly contradicts the thing the library is trying to show.
{
  for (const e of CIRCUITS) {
    const c = e.build();
    const n = c.counts();
    const kinds = new Set(c.transistors.map(t => t.kind));
    const section = e.group.split(' · ')[0];
    checks++;
    if (!GROUP_ORDER.includes(e.group)) {
      failures++;
      console.error(`FAIL [${e.id}] group "${e.group}" is not in GROUP_ORDER`);
    }
    if (section === 'Relays') {
      expect(c, `${e.id} is in Relays and has relays`, n.relays > 0, true);
      expect(c, `${e.id} is in Relays and has no transistors`, n.transistors, 0);
    } else if (section === 'CMOS') {
      expect(c, `${e.id} is in CMOS and has no relays`, n.relays, 0);
      // complementary means both polarities are present
      expect(c, `${e.id} is in CMOS and uses both channel types`,
        kinds.has('nmos') && kinds.has('pmos'), true);
    } else if (section === 'NMOS') {
      expect(c, `${e.id} is in NMOS and has no relays`, n.relays, 0);
      expect(c, `${e.id} is in NMOS and uses N-channel`, kinds.has('nmos'), true);
      // N-channel must dominate: a real mask ROM is an NMOS array with CMOS
      // periphery (decoder, output buffers), so requiring zero P-channel
      // would be wrong — but the part is only "NMOS" if the array is.
      expect(c, `${e.id} is in NMOS and is mostly N-channel`,
        c.transistors.filter(t => t.kind === 'nmos').length >
        c.transistors.filter(t => t.kind === 'pmos').length, true);
      // an NMOS load is a resistor, which is the whole point of the section
      expect(c, `${e.id} is in NMOS and has a resistor load`, n.resistors > 0, true);
    } else {
      // General is the bridge section: circuits with no transistors at all
      // (diode logic), circuits mixing technologies (Three Technologies), or
      // ones introducing a device rather than building logic from it.
      expect(c, `${e.id} is in General and is not plain single-technology logic`,
        n.transistors === 0 || n.relays > 0 || n.resistors > 0, true);
    }
  }
  // every declared group is actually used — a stale name is dead weight
  for (const g of GROUP_ORDER) {
    expect({ name: 'GROUP_ORDER' }, `group "${g}" has circuits`,
      CIRCUITS.some(e => e.group === g), true);
  }
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
    // The upper bound is a sanity check against a derivation bug inventing
    // an absurd bus, not a real constraint — 12 is the 4004's program
    // counter, and a wider machine would legitimately go past it.
    if (!bus.name || !bus.bits.length || bus.bits.length > 16) {
      failures++;
      console.error(`FAIL [${e.id}] bad bus ${bus.name} (${bus.bits.length} bits)`);
    }
  }
}

// docs/INVENTORY.md is generated from the catalogue, and it is the only
// place any count lives — so a stale one is a test failure, not something
// a reader finds later. Skipped if the generator is absent (the app ships
// without tools/).
try {
  const { execFileSync } = await import('node:child_process');
  execFileSync('node', ['tools/inventory.mjs', '--check'],
    { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' });
  checks++;
} catch (e) {
  if (e.code === 'ENOENT') {
    // no generator here; nothing to check
  } else {
    checks++; failures++;
    console.error('FAIL [inventory] docs/INVENTORY.md is out of date — '
      + 'run: node tools/inventory.mjs');
  }
}

console.log(`${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
