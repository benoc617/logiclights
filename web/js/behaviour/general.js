// General: the bridge circuits.
//
// Either no transistors at all (diode logic — the technology before
// amplifying devices, which is why it cannot be chained), or deliberately
// spanning technologies. These are what connect the relay section to the
// solid-state ones rather than sitting inside either.

import { Circuit, VCC, VDD, VSS } from '../engine.js';
import { MOS_H, MOS_GATE, switchSpdtT } from '../geometry.js';
import { mosScaffold, cmosInv } from './mos-scaffold.js';
// Three Technologies builds one gate from relays *and* transistors, so it
// needs the relay helper as well as the MOS scaffolding.
import { relay, w } from './util.js';

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

export const general = {
  t101: { build: buildTransistor101 },
  diode: { build: buildDiodeLogic },
  tech3: { build: buildThreeTech },
};
