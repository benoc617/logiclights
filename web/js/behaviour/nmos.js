// NMOS circuits: N-channel pull-down networks under resistor loads.
//
// How it was done before CMOS, and how the 4004's contemporaries were
// built. Half the transistors of the complementary version, and static
// current whenever an output is low — every 1 here is only weakly driven
// by its load, every 0 is pulled hard to ground.

import { Circuit, VDD, VSS } from '../engine.js';
import { MOS_H, MOS_GATE, switchSpdtT } from '../geometry.js';
import { instantiate } from '../module.js';
import { NDecode2, NDLatch, NXor2, nRippleAdder, nAlu } from '../nmos.js';
import { buildRom8 } from './rom-circuit.js';
import { mosScaffold, buildRing, w } from './mos-scaffold.js';
import { buildFromModule } from './from-module.js';

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

export const nmos = {
  nmosinv: { build: buildNmosInverter },
  nmosring: { build: buildRing('NMOS Ring Oscillator', 'nmos', 2) },
  nmosnand: { build: nmosGate('NMOS NAND', true, false) },
  nmosnor: { build: nmosGate('NMOS NOR', false, false) },
  nmosand: { build: nmosGate('NMOS AND', true, true) },
  nmosor: { build: nmosGate('NMOS OR', false, true) },
  nmosxor: {
    build: buildFromModule('NMOS XOR', NXor2,
      [['A', 'a'], ['B', 'b']], [['OUT', 'y']]),
  },
  nmosdec: {
    build: buildFromModule('NMOS 2-to-4 Decoder', NDecode2,
      [['A0', 'a0'], ['A1', 'a1']],
      [['Y0', 'y0'], ['Y1', 'y1'], ['Y2', 'y2'], ['Y3', 'y3']]),
  },
  nmoslatch: {
    build: buildFromModule('NMOS D Latch', NDLatch,
      [['D', 'd'], ['EN', 'en']], [['Q', 'q']]),
  },
  nmosadd4: {
    build: buildFromModule('NMOS 4-bit Adder', nRippleAdder(4),
      [['A0', 'a0'], ['A1', 'a1'], ['A2', 'a2'], ['A3', 'a3'],
       ['B0', 'b0'], ['B1', 'b1'], ['B2', 'b2'], ['B3', 'b3'], ['Cin', 'cin']],
      [['S0', 's0'], ['S1', 's1'], ['S2', 's2'], ['S3', 's3'], ['Cout', 'cout']]),
    readout: v => `${v.A} + ${v.B} + ${v.Cin} = ${v.Cout * 16 + v.S}`,
  },
  nmosalu: {
    build: buildFromModule('NMOS 4-bit ALU', nAlu(4),
      [['A0', 'a0'], ['A1', 'a1'], ['A2', 'a2'], ['A3', 'a3'],
       ['B0', 'b0'], ['B1', 'b1'], ['B2', 'b2'], ['B3', 'b3'],
       ['F0', 'f0'], ['F1', 'f1']],
      [['Y0', 'y0'], ['Y1', 'y1'], ['Y2', 'y2'], ['Y3', 'y3'], ['Cout', 'cout']]),
    select: v => v.F,
  },
  rom8: {
    build: buildRom8,
    readout: v => {
      const ch = v.D;
      const glyph = ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '\u00b7';
      return `addr ${v.A} \u2192 ${ch} = 0x${ch.toString(16).toUpperCase().padStart(2, '0')} = "${glyph}"`;
    },
    read: (c, v) => [...'LOGIC 42'].map((ch, i) => ({
      label: String(i),
      text: ch === ' ' ? '\u2423' : ch,
      mark: i === v.A ? 'read' : null,
    })),
  },
};
