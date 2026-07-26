// Logic Lights — switch-level device simulation.
//
// A circuit is a set of electrical nets joined by *devices*: relay contacts,
// MOSFET channels, diodes and resistors. Two nets are rails — VDD (net 0,
// always a strong 1) and VSS (net 1, always a strong 0). Every other net
// takes the value of the strongest source that can reach it through
// conducting devices.
//
// Control terminals only sense their net, they never join it: a relay coil
// is galvanically isolated from its contacts, and a MOSFET gate has no DC
// path to its channel. That shared isolation is why one solver handles an
// armature rack and a CMOS gate without special cases.
//
// Conduction through a contact or a channel is undirected, exactly like the
// real thing — circuits must be designed to avoid sneak paths. The diode is
// the one directional device: it passes a 1 from anode to cathode and a 0
// from cathode to anode, and blocks in the other direction.

export const VDD = 0;   // net 0 — positive rail
export const VSS = 1;   // net 1 — ground
export const VCC = VDD; // legacy alias from the relay-only era

// Node values.
export const LO = 0, HI = 1, X = 2, Z = 3;
export const VALUE_CHAR = ['0', '1', 'X', 'Z'];

// Drive strengths, strongest first. A node takes the value of the strongest
// source reaching it; equal-strength sources that disagree make it X.
export const STRONG = 3, WEAK = 2, CHARGE = 1, NONE = 0;

// Transistors switch far faster than armatures. The ratio is wildly
// unphysical (a real one is ~10^9) but it keeps a mixed circuit legible:
// in "Three Technologies" the CMOS output lands while the relay is still
// travelling, which is the point.
const MOS_DELAY_SCALE = 0.3;

export class Circuit {
  constructor(name) {
    this.name = name;
    this.netCount = 2; // net 0 is VDD, net 1 is VSS
    this.relays = [];
    this.transistors = [];
    this.switchings = 0; // channel switchings in the last step(), for sound
    this.diodes = [];
    this.resistors = [];
    this.switches = [];
    this.lamps = [];
    this.buses = [];   // declared internal buses, for the I/O table
    this.wires = [];   // { net, pts: [[x,y], ...] }
    this.labels = [];  // { text, x, y, size, color, align }
    this.hot = [true, false];
    this.value = [HI, LO];
    this.strength = [STRONG, STRONG];
    this.baseDelay = 300; // ms, armature travel time (UI-adjustable)
    // Relay-era circuits draw only the + rail: a lamp's return path and the
    // far end of every coil go to a ground that was never on the schematic.
    // Modelling that as a weakest-of-all pull-down on every net reproduces
    // the old one-rail behaviour exactly. Device circuits wire VSS
    // explicitly and turn this off, which is what lets Z and X exist.
    this.implicitGround = true;
    this._seq = 0;     // device sequence, for deterministic delay variance
    this._built = false;
  }

  net() {
    this.netCount++;
    return this.netCount - 1;
  }

  // ── devices ────────────────────────────────────────────────────────────

  // kind: 'toggle' | 'push' (normally open) | 'push-nc' (normally closed).
  // Conducts between opts.from (default VDD) and `net` when closed. If
  // opts.to is given the switch is a changeover — it connects `net` to
  // `from` when closed and to `to` when open, so an input is always driven.
  addSwitch(label, net, kind, x, y, opts = {}) {
    const s = {
      label, net, kind, on: false, x, y,
      from: opts.from ?? VDD,
      to: opts.to ?? null,
    };
    this.switches.push(s);
    return s;
  }

  // contacts: [{ c, no, nc }] — SPDT changeover. `no`/`nc` may be null.
  // When energized the armature connects c–no, otherwise c–nc.
  addRelay(name, coil, x, y, contacts) {
    const r = {
      name, coil, x, y, contacts,
      energized: false,
      pending: null,      // scheduled armature state, or null
      pendingAt: 0,
      delayScale: 1,
      delayFactor: this._variance(),
    };
    this.relays.push(r);
    return r;
  }

  // kind: 'nmos' (conducts when the gate is high) | 'pmos' (when it is low).
  // The channel a–b is bidirectional and symmetric, like a real MOSFET.
  addTransistor(name, kind, gate, a, b, x, y) {
    const t = {
      name, kind, gate, a, b, x, y,
      on: false,
      pending: null,
      pendingAt: 0,
      delayScale: MOS_DELAY_SCALE,
      delayFactor: this._variance(),
    };
    this.transistors.push(t);
    return t;
  }

  // Passes a 1 from anode to cathode and a 0 from cathode to anode; blocks
  // the reverse. opts.vert draws it vertically (anode on top).
  addDiode(name, anode, cathode, x, y, opts = {}) {
    const d = { name, anode, cathode, x, y, vert: !!opts.vert };
    this.diodes.push(d);
    return d;
  }

  // A weak bidirectional conductor: it drives a net only when nothing
  // stronger does, so a pull-up loses to any channel path to ground.
  addResistor(name, a, b, x, y, opts = {}) {
    const r = { name, a, b, x, y, vert: !!opts.vert };
    this.resistors.push(r);
    return r;
  }

  // opts.above draws the caption above the bulb; opts.short names the lamp
  // in the I/O table when the on-canvas label is too wordy. A lamp is an
  // ideal probe — it reads its net without loading it.
  addLamp(label, net, x, y, opts = {}) {
    const l = { label, net, x, y, above: !!opts.above, short: opts.short };
    this.lamps.push(l);
    return l;
  }

  // An internal signal group worth watching in the I/O table (nets LSB-first).
  addBus(name, nets) {
    this.buses.push({ name, nets });
  }

  wire(net, ...pts) {
    this.wires.push({ net, pts });
  }

  label(text, x, y, size = 1, color = null, align = 'center') {
    this.labels.push({ text, x, y, size, color, align });
  }

  // Mechanical/process variance: no two devices are quite alike. A
  // deterministic hash of the device index, so tests stay reproducible.
  _variance() {
    this._seq++;
    return 0.92 + 0.16 * fract(Math.sin(this._seq * 127.1) * 43758.5);
  }

  counts() {
    return {
      relays: this.relays.length,
      contacts: this.relays.reduce((n, r) => n + r.contacts.length, 0),
      transistors: this.transistors.length,
      diodes: this.diodes.length,
      resistors: this.resistors.length,
    };
  }

  // ── simulation ─────────────────────────────────────────────────────────

  // Switching time of one device, in ms. Shared with the renderer so the
  // animated travel matches the scheduled event exactly.
  delayOf(d) {
    return Math.max(15, this.baseDelay * d.delayFactor) * d.delayScale;
  }

  _buildStatic() {
    const n = this.netCount;
    this._adj = Array.from({ length: n }, () => []);   // rebuilt every solve
    this._res = Array.from({ length: n }, () => []);   // resistors — static
    this._dHi = Array.from({ length: n }, () => []);   // anode → cathode
    this._dLo = Array.from({ length: n }, () => []);   // cathode → anode
    for (const d of this.diodes) {
      this._dHi[d.anode].push(d.cathode);
      this._dLo[d.cathode].push(d.anode);
    }
    for (const r of this.resistors) {
      this._res[r.a].push(r.b);
      this._res[r.b].push(r.a);
    }
    this.value = new Array(n).fill(Z);
    this.strength = new Array(n).fill(NONE);
    this.hot = new Array(n).fill(false);
    this._stored = new Array(n).fill(Z);  // charge held on net capacitance
    this._sH = new Uint8Array(n);
    this._sL = new Uint8Array(n);
    this._wH = new Uint8Array(n);
    this._wL = new Uint8Array(n);
    this._stack = new Int32Array(n);
    this._built = true;
  }

  // Flood one polarity from a rail through channels, contacts and diodes.
  // `dir` is the diode list that carries this polarity.
  //
  // The opposite rail is marked but never expanded. A supply is an ideal
  // source: a short across it pulls the shorted nets to X, but the rail
  // itself does not then carry the wrong polarity onward into every other
  // net hanging off it. Without this stop a single crowbar anywhere turns
  // the entire machine X, which is neither useful nor true.
  _flood(mark, start, dir, stopAt) {
    const adj = this._adj, stack = this._stack;
    mark.fill(0);
    let sp = 0;
    mark[start] = 1;
    stack[sp++] = start;
    while (sp > 0) {
      const a = stack[--sp];
      if (a === stopAt) continue;
      const nb = adj[a];
      for (let i = 0; i < nb.length; i++) {
        const b = nb[i];
        if (!mark[b]) { mark[b] = 1; stack[sp++] = b; }
      }
      const db = dir[a];
      for (let i = 0; i < db.length; i++) {
        const b = db[i];
        if (!mark[b]) { mark[b] = 1; stack[sp++] = b; }
      }
    }
  }

  // The weak pass. Its sources are the far ends of resistors whose near end
  // came out strongly driven, and it spreads from there through the same
  // channels — but it stops dead at any net a strong driver already holds.
  // A clamped node cannot pass a weak drive along to its neighbours, which
  // is what keeps a pull-up on one gate out of the net next door.
  _floodWeak(mark, seeds, dir) {
    const adj = this._adj, stack = this._stack;
    const sH = this._sH, sL = this._sL;
    mark.fill(0);
    let sp = 0;
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      if (!mark[s] && !sH[s] && !sL[s]) { mark[s] = 1; stack[sp++] = s; }
    }
    while (sp > 0) {
      const a = stack[--sp];
      const nb = adj[a];
      for (let i = 0; i < nb.length; i++) {
        const b = nb[i];
        if (!mark[b] && !sH[b] && !sL[b]) { mark[b] = 1; stack[sp++] = b; }
      }
      const db = dir[a];
      for (let i = 0; i < db.length; i++) {
        const b = db[i];
        if (!mark[b] && !sH[b] && !sL[b]) { mark[b] = 1; stack[sp++] = b; }
      }
    }
  }

  // Resolve every net to a value and a strength.
  solve() {
    if (!this._built) this._buildStatic();
    const n = this.netCount, adj = this._adj;
    for (let i = 0; i < n; i++) adj[i].length = 0;

    for (const s of this.switches) {
      const closed = s.kind === 'push-nc' ? !s.on : s.on;
      if (s.to !== null) {
        const t = closed ? s.from : s.to;   // changeover: always driving
        adj[t].push(s.net); adj[s.net].push(t);
      } else if (closed) {
        adj[s.from].push(s.net); adj[s.net].push(s.from);
      }
    }
    for (const r of this.relays) {
      for (const k of r.contacts) {
        const t = r.energized ? k.no : k.nc;
        if (t !== null && t !== undefined) { adj[k.c].push(t); adj[t].push(k.c); }
      }
    }
    for (const t of this.transistors) {
      if (t.on) { adj[t.a].push(t.b); adj[t.b].push(t.a); }
    }

    this._flood(this._sH, VDD, this._dHi, VSS);
    this._flood(this._sL, VSS, this._dLo, VDD);
    if (this.resistors.length) {
      const seedH = [], seedL = [];
      for (const r of this.resistors) {
        for (const [near, far] of [[r.a, r.b], [r.b, r.a]]) {
          if (this._sH[near] && !this._sL[near]) seedH.push(far);
          else if (this._sL[near] && !this._sH[near]) seedL.push(far);
        }
      }
      this._floodWeak(this._wH, seedH, this._dHi);
      this._floodWeak(this._wL, seedL, this._dLo);
    } else {
      this._wH.fill(0);
      this._wL.fill(0);
    }

    const val = this.value, str = this.strength, hot = this.hot;
    const stored = this._stored;
    const sH = this._sH, sL = this._sL, wH = this._wH, wL = this._wL;
    for (let i = 0; i < n; i++) {
      let v, s;
      if (sH[i] && sL[i]) { v = X; s = STRONG; }        // rail-to-rail short
      else if (sH[i]) { v = HI; s = STRONG; }
      else if (sL[i]) { v = LO; s = STRONG; }
      else if (wH[i] && wL[i]) { v = X; s = WEAK; }     // divider — undefined
      else if (wH[i]) { v = HI; s = WEAK; }
      else if (wL[i]) { v = LO; s = WEAK; }
      else if (this.implicitGround) { v = LO; s = NONE; }
      else if (stored[i] !== Z) { v = stored[i]; s = CHARGE; }
      else { v = Z; s = NONE; }
      val[i] = v; str[i] = s; hot[i] = v === HI;
      if (s >= WEAK && v <= HI) stored[i] = v;
    }
    // the rails are ideal sources and stay themselves even when shorted
    val[VDD] = HI; str[VDD] = STRONG; hot[VDD] = true;
    val[VSS] = LO; str[VSS] = STRONG; hot[VSS] = false;
    return val;
  }

  computeHot() { this.solve(); return this.hot; }  // legacy name

  // Schedule/apply one device's transition. Returns true if it moved.
  _advance(d, want, now, key) {
    const target = d.pending !== null ? d.pending : d[key];
    if (want !== target) {
      if (want === d[key]) {
        // Control returned to the matching state before the device moved.
        d.pending = null;
      } else {
        d.pending = want;
        d.pendingAt = now + this.delayOf(d);
      }
    }
    if (d.pending !== null && now >= d.pendingAt) {
      d[key] = d.pending;
      d.pending = null;
      return true;
    }
    return false;
  }

  // Advance to `now` (ms). Returns the number of armature movements
  // (audible contact clicks). Channel switchings are counted separately in
  // `this.switchings` — a real transistor is silent, but the app sonifies
  // it anyway so device circuits aren't mute; see sound.js.
  step(now) {
    let clicks = 0;
    let switchings = 0;
    for (let guard = 0; guard < 64; guard++) {
      const v = this.solve();
      let changed = false;
      for (const r of this.relays) {
        if (this._advance(r, v[r.coil] === HI, now, 'energized')) {
          clicks++;
          changed = true;
        }
      }
      for (const t of this.transistors) {
        // An X or Z gate turns the channel off: this is a discrete model
        // and will not guess at an indeterminate level.
        const want = t.kind === 'nmos' ? v[t.gate] === HI : v[t.gate] === LO;
        if (this._advance(t, want, now, 'on')) {
          switchings++;
          changed = true;
        }
      }
      if (!changed) break;
    }
    this.switchings = switchings;
    return clicks;
  }

  // Earliest scheduled device transition, or null if the circuit is settled.
  nextEventAt() {
    let t = null;
    const look = d => {
      if (d.pending !== null && (t === null || d.pendingAt < t)) t = d.pendingAt;
    };
    for (const r of this.relays) look(r);
    for (const d of this.transistors) look(d);
    return t;
  }

  bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (x, y, m = 0) => {
      x0 = Math.min(x0, x - m); y0 = Math.min(y0, y - m);
      x1 = Math.max(x1, x + m); y1 = Math.max(y1, y + m);
    };
    for (const w of this.wires) for (const p of w.pts) grow(p[0], p[1]);
    for (const r of this.relays) grow(r.x + 2, r.y + 5, 6);
    for (const t of this.transistors) grow(t.x, t.y + 1.2, 2.6);
    for (const d of this.diodes) grow(d.x, d.y, 1.6);
    for (const r of this.resistors) grow(r.x, r.y, 1.8);
    for (const s of this.switches) grow(s.x, s.y, 2.5);
    for (const l of this.lamps) grow(l.x, l.y, 2.5);
    for (const t of this.labels) grow(t.x, t.y, 2);
    if (x0 === Infinity) { x0 = y0 = 0; x1 = y1 = 10; }
    return { x0, y0, x1, y1 };
  }
}

function fract(v) {
  return v - Math.floor(v);
}
