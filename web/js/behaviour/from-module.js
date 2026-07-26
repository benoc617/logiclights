// A generic frame for module-built circuits.

import { Circuit, VDD, VSS } from '../engine.js';
import { switchSpdtT } from '../geometry.js';
import { instantiate } from '../module.js';
import { w } from './mos-scaffold.js';


// A generic wrapper for module-built solid-state circuits: switches down
// the left, lamps down the right, rails top and bottom. The module supplies
// the logic; this only gives it I/O and a frame to sit in.
//
// `inputs` and `outputs` are [label, portName] pairs. A port left out of
// `inputs` is bound to whatever the module allocates, which is how the
// carry-in of an adder can default to 0 without a switch for it.
export function buildFromModule(name, def, inputs, outputs, opts = {}) {
  return () => {
    const c = new Circuit(name);
    c.implicitGround = false;
    const bind = {};
    let y = 4;
    for (const [label, port] of inputs) {
      const n = c.net();
      c.addSwitch(label, n, 'toggle', 4, y, { to: VSS });
      bind[port] = n;
      y += 4.5;
    }
    for (const [port, net] of Object.entries(opts.tie || {})) bind[port] = net;

    const inst = instantiate(c, def, 24, 0, bind);

    const b = c.bounds();
    const xEnd = b.x1 + 10;
    const yTop = -10, yBot = Math.max(b.y1 + 6, y + 6);
    w(c, VDD, [0, yTop], [xEnd, yTop]);
    w(c, VSS, [0, yBot], [xEnd, yBot]);
    c.label('+V', -1.6, yTop, 1.1, '#ffb340');
    c.label('GND', -2.4, yBot, 1.1, '#7f8aa3');
    for (const s of c.switches) {
      const t = switchSpdtT(s);
      w(c, VDD, [2.4, yTop], [2.4, t.hi.y], [t.hi.x, t.hi.y]);
      w(c, VSS, [1.6, yBot], [1.6, t.lo.y], [t.lo.x, t.lo.y]);
    }
    let ly = 4;
    for (const [label, port] of outputs) {
      c.addLamp(label, inst.nets[port], xEnd - 5, ly, { short: label });
      ly += 5;
    }
    if (opts.after) opts.after(c, inst);
    return c;
  };
}
