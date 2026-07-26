// Logic Lights — relay-level simulation engine.
//
// A circuit is a set of electrical nets joined by contacts. A net is "hot"
// when it has a conduction path to the VCC rail through closed contacts.
// Relay coils energize from the net they're attached to; the armature moves
// after a configurable mechanical delay, changing which contacts conduct.
// That delay is what makes propagation visible (and audible).
//
// Conduction is undirected, exactly like real relay logic — circuits must be
// designed to avoid sneak paths, just like the real thing.

export const VCC = 0;

export class Circuit {
  constructor(name) {
    this.name = name;
    this.netCount = 1; // net 0 is the VCC rail, always hot
    this.relays = [];
    this.switches = [];
    this.lamps = [];
    this.buses = [];   // declared internal buses, for the I/O table
    this.wires = [];   // { net, pts: [[x,y], ...] }
    this.labels = [];  // { text, x, y, size, color, align }
    this.hot = [true];
    this.baseDelay = 300; // ms, armature travel time (UI-adjustable)
  }

  net() {
    this.netCount++;
    return this.netCount - 1;
  }

  // kind: 'toggle' | 'push' (normally open) | 'push-nc' (normally closed).
  // A switch conducts between VCC and `net` when closed.
  addSwitch(label, net, kind, x, y) {
    const s = { label, net, kind, on: false, x, y };
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
      // Mechanical variance: no two relays are quite alike.
      delayFactor: 0.92 + 0.16 * fract(Math.sin((this.relays.length + 1) * 127.1) * 43758.5),
    };
    this.relays.push(r);
    return r;
  }

  // opts.above draws the caption above the bulb; opts.short names the lamp
  // in the I/O table when the on-canvas label is too wordy.
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

  // ── Simulation ─────────────────────────────────────────────────────────

  computeHot() {
    const adj = Array.from({ length: this.netCount }, () => []);
    const join = (a, b) => {
      if (a == null || b == null) return;
      adj[a].push(b);
      adj[b].push(a);
    };
    for (const s of this.switches) {
      const closed = s.kind === 'push-nc' ? !s.on : s.on;
      if (closed) join(VCC, s.net);
    }
    for (const r of this.relays) {
      for (const k of r.contacts) {
        join(k.c, r.energized ? k.no : k.nc);
      }
    }
    const hot = new Array(this.netCount).fill(false);
    const stack = [VCC];
    hot[VCC] = true;
    while (stack.length) {
      const n = stack.pop();
      for (const m of adj[n]) {
        if (!hot[m]) { hot[m] = true; stack.push(m); }
      }
    }
    this.hot = hot;
    return hot;
  }

  // Advance to `now` (ms). Returns the number of armature movements
  // (contact clicks) that happened, for the sound effects.
  step(now) {
    let clicks = 0;
    for (let guard = 0; guard < 64; guard++) {
      const hot = this.computeHot();
      let changed = false;
      for (const r of this.relays) {
        const want = hot[r.coil];
        const target = r.pending !== null ? r.pending : r.energized;
        if (want !== target) {
          if (want === r.energized) {
            // Coil returned to matching state before the armature moved.
            r.pending = null;
          } else {
            r.pending = want;
            r.pendingAt = now + Math.max(15, this.baseDelay * r.delayFactor);
          }
        }
        if (r.pending !== null && now >= r.pendingAt) {
          r.energized = r.pending;
          r.pending = null;
          clicks++;
          changed = true;
        }
      }
      if (!changed) break;
    }
    return clicks;
  }

  // Earliest scheduled armature movement, or null if the circuit is settled.
  nextEventAt() {
    let t = null;
    for (const r of this.relays) {
      if (r.pending !== null && (t === null || r.pendingAt < t)) t = r.pendingAt;
    }
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
