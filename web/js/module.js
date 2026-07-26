// Sub-circuit modules: reusable blocks with named ports, instantiated at a
// position instead of hand-placed.
//
// The existing builders (`faCell`, `cmosInv`) take a circuit and absolute
// coordinates, allocate nets inline, and hand geometry back for the caller
// to wire against. That works while a circuit is two dozen devices laid out
// by eye. It does not reach an ALU, let alone a CPU: every instance has to
// be positioned by arithmetic on its neighbours, and every internal net is
// visible to everything else.
//
// A module instead declares its interface up front and builds its content
// in *local* coordinates. Instantiating it binds each port to a net the
// caller already has (or allocates a fresh one), offsets all geometry, and
// returns a handle carrying the port nets and the block's extent — so the
// caller composes by naming signals, never by counting device positions.
//
// Wires stay decorative (see CLAUDE.md): a module's ports are the *only*
// electrical contract. Two instances that share a port net conduct because
// they share a net, not because a wire was drawn between them.

import { VDD, VSS } from './engine.js';
import { MOS_H, MOS_GATE, RELAY_W, CONTACT_PITCH, CONTACT_Y0 } from './geometry.js';

// A port declaration: name plus where its stub lands in local coordinates,
// so a router (or a human) has something to aim at.
//   { name, x, y, side }  side: 'in' | 'out' | 'top' | 'bottom'
//
// defineModule(name, { ports, build }) → a definition you can instantiate
// many times. `build(m)` runs once per instance and receives a builder
// scoped to that instance.
export function defineModule(name, { ports = [], build }) {
  if (typeof build !== 'function') {
    throw new Error(`module ${name}: build must be a function`);
  }
  return { name, ports, build, __module: true };
}

// Instantiate `def` into circuit `c` at (x, y).
//
// `bind` maps port name → net. A port left unbound gets a fresh net, so a
// module can be dropped in standalone and probed. VDD/VSS are global and
// are never ports.
//
// Returns { nets, x, y, w, h, tag } — `nets` is the port map, including
// any nets that were auto-allocated, which is how the caller wires onward.
export function instantiate(c, def, x, y, bind = {}, opts = {}) {
  const tag = opts.tag || `${def.name}${c._modSeq = (c._modSeq || 0) + 1}`;

  const nets = {};
  for (const p of def.ports) {
    const name = typeof p === 'string' ? p : p.name;
    if (bind[name] !== undefined && bind[name] !== null) {
      nets[name] = bind[name];
    } else {
      nets[name] = c.net();
    }
  }
  // Binding a name the module does not declare is a typo that would
  // otherwise silently do nothing.
  for (const k of Object.keys(bind)) {
    if (!(k in nets)) {
      throw new Error(`module ${def.name}: no port "${k}" (has: ${Object.keys(nets).join(', ') || 'none'})`);
    }
  }

  const b = new ModuleBuilder(c, x, y, tag, nets);
  def.build(b);

  return {
    nets, tag,
    x, y,
    w: b._maxX - b._minX === -Infinity ? 0 : b._maxX - b._minX,
    h: b._maxY - b._minY === -Infinity ? 0 : b._maxY - b._minY,
    ports: def.ports,
  };
}

// The builder handed to a module's build(). Every coordinate it takes is
// local to the instance; it adds the instance origin before touching the
// circuit. Device names are prefixed with the instance tag so a fault in
// one instance of sixteen is identifiable.
class ModuleBuilder {
  constructor(c, ox, oy, tag, nets) {
    this.c = c;
    this.ox = ox;
    this.oy = oy;
    this.tag = tag;
    this.nets = nets;       // port nets, by name
    this._minX = Infinity; this._minY = Infinity;
    this._maxX = -Infinity; this._maxY = -Infinity;
  }

  // Grow the instance extent. A device is not a point — pass its drawn
  // reach so `w`/`h` describe the block a placer has to leave room for,
  // not just where the origins landed.
  _grow(x, y, left = 0, down = 0) {
    if (x - left < this._minX) this._minX = x - left;
    if (y < this._minY) this._minY = y;
    if (x > this._maxX) this._maxX = x;
    if (y + down > this._maxY) this._maxY = y + down;
  }

  // A net private to this instance. Ports come from `this.nets`; anything
  // else a module needs internally should come from here, so it cannot be
  // reached by name from outside.
  net() { return this.c.net(); }

  // Port net by name — throws rather than returning undefined, which would
  // otherwise surface much later as a device wired to net `undefined`.
  port(name) {
    const n = this.nets[name];
    if (n === undefined) {
      throw new Error(`module ${this.tag}: no port "${name}"`);
    }
    return n;
  }

  transistor(name, kind, gate, a, bNet, x, y) {
    this._grow(x, y, MOS_GATE, MOS_H);   // gate lead left, channel down
    return this.c.addTransistor(`${this.tag}.${name}`, kind, gate, a, bNet,
      this.ox + x, this.oy + y);
  }

  relay(name, coil, x, y, contacts) {
    // A relay is as tall as its contact stack, not a fixed box.
    this._grow(x + RELAY_W, y, 0, CONTACT_Y0 + contacts.length * CONTACT_PITCH);
    return this.c.addRelay(`${this.tag}.${name}`, coil, this.ox + x, this.oy + y, contacts);
  }

  diode(name, anode, cathode, x, y, opts) {
    this._grow(x, y);
    return this.c.addDiode(`${this.tag}.${name}`, anode, cathode,
      this.ox + x, this.oy + y, opts);
  }

  resistor(name, a, bNet, x, y, opts) {
    this._grow(x, y);
    return this.c.addResistor(`${this.tag}.${name}`, a, bNet,
      this.ox + x, this.oy + y, opts);
  }

  // Switches and lamps keep their bare labels: those are user-facing and
  // drive the binary I/O table's bus naming, which must not be prefixed.
  switch(label, net, kind, x, y, opts) {
    this._grow(x, y);
    return this.c.addSwitch(label, net, kind, this.ox + x, this.oy + y, opts);
  }

  lamp(label, net, x, y, opts) {
    this._grow(x, y);
    return this.c.addLamp(label, net, this.ox + x, this.oy + y, opts);
  }

  wire(net, ...pts) {
    for (const p of pts) this._grow(p[0], p[1]);
    this.c.wire(net, ...pts.map(p => [this.ox + p[0], this.oy + p[1]]));
  }

  label(text, x, y, size, color, align) {
    this._grow(x, y);
    this.c.label(text, this.ox + x, this.oy + y, size, color, align);
  }

  // A labelled box saying what this part of the module is. Annotation only:
  // it conducts nothing, and it does not grow the instance extent, so
  // drawing a box around a block never changes where the next one is
  // placed.
  region(text, x0, y0, x1, y1, opts) {
    this.c.region(text, this.ox + x0, this.oy + y0,
      this.ox + x1, this.oy + y1, opts);
  }

  // Nest a module inside another. Offsets compose, so a block built from
  // blocks places its children in its own local frame.
  instantiate(def, x, y, bind, opts) {
    this._grow(x, y);
    const inst = instantiate(this.c, def, this.ox + x, this.oy + y, bind, opts);
    this._grow(x + inst.w, y + inst.h);
    return inst;
  }

  get VDD() { return VDD; }
  get VSS() { return VSS; }
}
