// Shared scaffolding for the MOS circuits.
//
// Everything below the relay era needs the same frame: both rails drawn,
// implicitGround turned off (a transistor that switches off does not pull
// its output anywhere, so an undriven net must float rather than read low),
// and changeover input switches down the left so every input is always
// driven from one rail or the other.

import { Circuit, VDD, VSS } from '../engine.js';
import { MOS_H, MOS_GATE, switchSpdtT } from '../geometry.js';
import { w } from './util.js';

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

export { mosScaffold, cmosInv, buildRing, w };
