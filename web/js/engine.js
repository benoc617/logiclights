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
    this.regions = []; // { text, x0, y0, x1, y1 } — annotation only
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
    this._built = false;   // net count changed: static tables are stale
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
    this._built = false;
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
    this._built = false;
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
    this._built = false;
    return t;
  }

  // Passes a 1 from anode to cathode and a 0 from cathode to anode; blocks
  // the reverse. opts.vert draws it vertically (anode on top).
  addDiode(name, anode, cathode, x, y, opts = {}) {
    const d = { name, anode, cathode, x, y, vert: !!opts.vert };
    this.diodes.push(d);
    this._built = false;
    return d;
  }

  // A weak bidirectional conductor: it drives a net only when nothing
  // stronger does, so a pull-up loses to any channel path to ground.
  addResistor(name, a, b, x, y, opts = {}) {
    const r = { name, a, b, x, y, vert: !!opts.vert };
    this.resistors.push(r);
    this._built = false;
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

  // A named region of the canvas: a labelled box drawn behind the circuit,
  // saying what this patch of devices is. Purely annotation — it conducts
  // nothing and the simulation never reads it. On the composed machines a
  // few hundred transistors otherwise look like undifferentiated texture,
  // and this is what says "these sixteen rows are the registers".
  region(text, x0, y0, x1, y1, opts = {}) {
    this.regions.push({
      text, x0, y0, x1, y1,
      color: opts.color || null,
      // where the caption sits: 'top' (default) or 'bottom'
      side: opts.side || 'top',
    });
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

  // Build the static conduction tables. The topology never changes — only
  // *which* of a contact's two throws is selected, and whether a channel is
  // on — so every edge that could ever exist is laid out once in flat CSR
  // arrays (`_eHead`/`_eNext`/`_eTo`, an intrusive per-net linked list) and
  // a solve only flips the per-edge `_eOn` byte. That turns the old
  // rebuild-every-call — clearing n sub-arrays and pushing into them — into
  // a write per switched device.
  //
  // Undirected edges are stored as two half-edges, `i` and `i^1`, so one
  // enable flag pair is toggled by index arithmetic. Diodes go in the same
  // structure with a polarity tag, since they are always conducting in one
  // direction and never in the other.
  _buildStatic() {
    const n = this.netCount;

    // Count the half-edges first so the arrays are allocated exactly once.
    let m = 0;
    for (const s of this.switches) m += s.to !== null ? 4 : 2;
    for (const r of this.relays) {
      for (const k of r.contacts) {
        if (k.no !== null && k.no !== undefined) m += 2;
        if (k.nc !== null && k.nc !== undefined) m += 2;
      }
    }
    m += this.transistors.length * 2;
    m += this.diodes.length * 2;

    this._eTo = new Int32Array(m);
    this._eNext = new Int32Array(m).fill(-1);
    this._eOn = new Uint8Array(m);
    // 0 = plain conductor, 1 = passes HI only, 2 = passes LO only
    this._ePol = new Uint8Array(m);
    this._eHead = new Int32Array(n).fill(-1);
    this._eCount = 0;

    // Switched devices record their edge slots so solve() can address them
    // directly instead of searching.
    for (const s of this.switches) {
      s._e = s.to !== null
        ? [this._edge(s.net, s.from), this._edge(s.net, s.to)]
        : [this._edge(s.net, s.from)];
    }
    for (const r of this.relays) {
      for (const k of r.contacts) {
        k._eNo = (k.no !== null && k.no !== undefined) ? this._edge(k.c, k.no) : -1;
        k._eNc = (k.nc !== null && k.nc !== undefined) ? this._edge(k.c, k.nc) : -1;
      }
    }
    for (const t of this.transistors) t._e = this._edge(t.a, t.b);
    // A diode is a permanent one-way conductor: enabled once, never toggled.
    for (const d of this.diodes) {
      const e = this._edge(d.anode, d.cathode);
      this._eOn[e] = 1; this._eOn[e ^ 1] = 1;
      this._ePol[e] = 1;      // anode → cathode carries HI
      this._ePol[e ^ 1] = 2;  // cathode → anode carries LO
    }

    this._res = Array.from({ length: n }, () => []);   // resistors — static
    for (const r of this.resistors) {
      this._res[r.a].push(r.b);
      this._res[r.b].push(r.a);
    }

    this.value = new Array(n).fill(Z);
    this.strength = new Array(n).fill(NONE);
    this.hot = new Array(n).fill(false);
    this._stored = new Array(n).fill(Z);  // charge held on net capacitance
    // Generation-stamped visit marks: each flood writes its own generation
    // number, so bumping the counter retires the whole array and no clear
    // is ever needed. A flood costs the nets it reaches, not every net.
    this._sH = new Int32Array(n);
    this._sL = new Int32Array(n);
    this._wH = new Int32Array(n);
    this._wL = new Int32Array(n);
    this._stack = new Int32Array(n);
    this._gen = 0;
    this._built = true;
  }

  // Add an undirected edge as the half-edge pair (i, i^1). Returns i.
  _edge(a, b) {
    const i = this._eCount;
    this._eTo[i] = b; this._eNext[i] = this._eHead[a]; this._eHead[a] = i;
    this._eTo[i + 1] = a; this._eNext[i + 1] = this._eHead[b]; this._eHead[b] = i + 1;
    this._eCount += 2;
    return i;
  }

  // Flood one polarity from a rail through channels, contacts and diodes.
  // `dir` is the diode list that carries this polarity.
  //
  // The opposite rail is marked but never expanded. A supply is an ideal
  // source: a short across it pulls the shorted nets to X, but the rail
  // itself does not then carry the wrong polarity onward into every other
  // net hanging off it. Without this stop a single crowbar anywhere turns
  // the entire machine X, which is neither useful nor true.
  // `pol` is the diode polarity this pass may traverse (1 = HI, 2 = LO).
  // Marks reached nets by stamping `mark[net] = gen` and returns `gen`, so
  // no array ever has to be cleared: a flood costs the nets it reaches, not
  // every net in the circuit. Callers test `mark[i] === gen`.
  _flood(mark, start, pol, stopAt) {
    const head = this._eHead, next = this._eNext, to = this._eTo;
    const on = this._eOn, ep = this._ePol;
    const stack = this._stack;
    const gen = ++this._gen;
    let sp = 0;
    mark[start] = gen;
    stack[sp++] = start;
    while (sp > 0) {
      const a = stack[--sp];
      if (a === stopAt) continue;
      for (let e = head[a]; e !== -1; e = next[e]) {
        if (!on[e]) continue;
        const p = ep[e];
        if (p !== 0 && p !== pol) continue;   // diode blocks this polarity
        const b = to[e];
        if (mark[b] !== gen) { mark[b] = gen; stack[sp++] = b; }
      }
    }
    return gen;
  }

  // The weak pass. Its sources are the far ends of resistors whose near end
  // came out strongly driven, and it spreads from there through the same
  // channels — but it stops dead at any net a strong driver already holds.
  // A clamped node cannot pass a weak drive along to its neighbours, which
  // is what keeps a pull-up on one gate out of the net next door.
  // Same stamping scheme. `gH`/`gL` are the generations of the two strong
  // passes, so "already strongly driven" is a stamp comparison too.
  _floodWeak(mark, seeds, pol, gH, gL) {
    const head = this._eHead, next = this._eNext, to = this._eTo;
    const on = this._eOn, ep = this._ePol;
    const stack = this._stack;
    const sH = this._sH, sL = this._sL;
    const gen = ++this._gen;
    let sp = 0;
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i];
      if (mark[s] !== gen && sH[s] !== gH && sL[s] !== gL) {
        mark[s] = gen; stack[sp++] = s;
      }
    }
    while (sp > 0) {
      const a = stack[--sp];
      for (let e = head[a]; e !== -1; e = next[e]) {
        if (!on[e]) continue;
        const p = ep[e];
        if (p !== 0 && p !== pol) continue;
        const b = to[e];
        if (mark[b] !== gen && sH[b] !== gH && sL[b] !== gL) {
          mark[b] = gen; stack[sp++] = b;
        }
      }
    }
    return gen;
  }

  // Resolve every net to a value and a strength.
  solve() {
    if (!this._built) this._buildStatic();
    const n = this.netCount;
    const on = this._eOn;

    // Select conduction by flipping edge flags — the edges themselves and
    // their adjacency were laid out once in _buildStatic().
    for (const s of this.switches) {
      const closed = s.kind === 'push-nc' ? !s.on : s.on;
      if (s.to !== null) {
        // changeover: always driving, one throw or the other
        const a = s._e[0], b = s._e[1];
        const f = closed ? a : b, o = closed ? b : a;
        on[f] = 1; on[f ^ 1] = 1;
        on[o] = 0; on[o ^ 1] = 0;
      } else {
        const e = s._e[0], v = closed ? 1 : 0;
        on[e] = v; on[e ^ 1] = v;
      }
    }
    for (const r of this.relays) {
      const en = r.energized;
      for (const k of r.contacts) {
        const a = k._eNo, b = k._eNc;
        if (a !== -1) { const v = en ? 1 : 0; on[a] = v; on[a ^ 1] = v; }
        if (b !== -1) { const v = en ? 0 : 1; on[b] = v; on[b ^ 1] = v; }
      }
    }
    for (const t of this.transistors) {
      const e = t._e, v = t.on ? 1 : 0;
      on[e] = v; on[e ^ 1] = v;
    }

    const gH = this._flood(this._sH, VDD, 1, VSS);
    const gL = this._flood(this._sL, VSS, 2, VDD);
    // -1 never matches a stamp (generations count up from 1, and the arrays
    // are zero-filled), so an unrun weak pass reads as "reached nothing"
    // without touching the array.
    let gWH = -1, gWL = -1;
    if (this.resistors.length) {
      const seedH = [], seedL = [];
      for (const r of this.resistors) {
        for (const [near, far] of [[r.a, r.b], [r.b, r.a]]) {
          if (this._sH[near] === gH && this._sL[near] !== gL) seedH.push(far);
          else if (this._sL[near] === gL && this._sH[near] !== gH) seedL.push(far);
        }
      }
      gWH = this._floodWeak(this._wH, seedH, 1, gH, gL);
      gWL = this._floodWeak(this._wL, seedL, 2, gH, gL);
    }

    const val = this.value, str = this.strength, hot = this.hot;
    const stored = this._stored;
    const sH = this._sH, sL = this._sL, wH = this._wH, wL = this._wL;
    for (let i = 0; i < n; i++) {
      let v, s;
      const isH = sH[i] === gH, isL = sL[i] === gL;
      if (isH && isL) { v = X; s = STRONG; }            // rail-to-rail short
      else if (isH) { v = HI; s = STRONG; }
      else if (isL) { v = LO; s = STRONG; }
      else if (wH[i] === gWH && wL[i] === gWL) { v = X; s = WEAK; }  // divider
      else if (wH[i] === gWH) { v = HI; s = WEAK; }
      else if (wL[i] === gWL) { v = LO; s = WEAK; }
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
    // regions extend the drawn area, and their captions sit outside the box
    for (const r of this.regions) { grow(r.x0, r.y0, 2.5); grow(r.x1, r.y1, 2.5); }
    if (x0 === Infinity) { x0 = y0 = 0; x1 = y1 = 10; }
    return { x0, y0, x1, y1 };
  }
}

function fract(v) {
  return v - Math.floor(v);
}
