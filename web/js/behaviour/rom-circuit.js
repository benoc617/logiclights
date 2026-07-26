// The program ROM, in both technologies.
//
// One builder, two loads: a resistor per bit line (the historical NMOS
// part) or a P-channel plus a precharge phase (fully CMOS, no static
// current). The array itself is identical — the difference is entirely in
// how the bit lines are held high, which is the whole comparison.

import { Circuit, VDD, VSS } from '../engine.js';
import { switchSpdtT } from '../geometry.js';
import { instantiate } from '../module.js';
import { romArray } from '../rom.js';
import { w } from './mos-scaffold.js';

const ROM_WORDS = [...'LOGIC 42'].map(ch => ch.charCodeAt(0));

export function buildRom8(load = 'resistor') {
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
