// Headless truth-table tests for the device simulation.
// Run: node test/sim-test.mjs

import { buildCircuit, CIRCUITS } from '../web/js/circuits.js';
import { deriveBuses, busValue } from '../web/js/buses.js';
import { Circuit, LO, HI, X, Z, STRONG, WEAK, CHARGE, VALUE_CHAR } from '../web/js/engine.js';
import { instantiate } from '../web/js/module.js';
import { Inverter, Nand2, Nor2, And2, Or2, Xor2 } from '../web/js/gates.js';
import { romArray } from '../web/js/rom.js';

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
  const buses = deriveBuses(c);
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
