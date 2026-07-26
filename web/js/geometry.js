// Shared geometry for device symbols, in world units.
// Used by both the circuit builders (for wiring) and the renderer.

export const RELAY_W = 4;          // relay body width
export const COIL_H = 1.6;         // coil box height
export const CONTACT_PITCH = 2;    // vertical spacing between contacts
export const CONTACT_Y0 = 2.6;     // first contact offset from relay top

export const MOS_H = 2.4;          // channel length, drain to source
export const MOS_GATE = 1.5;       // gate lead reach, left of the channel
export const DIODE_L = 1.8;        // anode-to-cathode lead span
export const RES_L = 2.4;          // resistor lead span

// Coil input terminal (left edge of the coil).
export function coilT(r) {
  return { x: r.x, y: r.y + 0.8 };
}

// Terminals of contact i: common (left), NC throw (upper right), NO throw
// (lower right).
export function contactT(r, i) {
  const yC = r.y + CONTACT_Y0 + i * CONTACT_PITCH;
  return {
    c: { x: r.x, y: yC },
    nc: { x: r.x + RELAY_W, y: yC - 0.6 },
    no: { x: r.x + RELAY_W, y: yC + 0.6 },
  };
}

export function relayH(r) {
  return CONTACT_Y0 + r.contacts.length * CONTACT_PITCH + 0.4;
}

// MOSFET terminals. (t.x, t.y) is the `a` end of the channel; the channel
// runs down to `b` and the gate lead sticks out to the left. The channel is
// symmetric, so which end is drain and which is source is a matter of the
// voltages, not the drawing — the builders just call them a and b.
export function mosT(t) {
  return {
    a: { x: t.x, y: t.y },
    b: { x: t.x, y: t.y + MOS_H },
    g: { x: t.x - MOS_GATE, y: t.y + MOS_H / 2 },
  };
}

// Two-terminal passives. Horizontal by default (a left, b right); with
// `vert` set, a is on top. For a diode, a is the anode and b the cathode.
function twoT(d, len) {
  const h = len / 2;
  return d.vert
    ? { a: { x: d.x, y: d.y - h }, b: { x: d.x, y: d.y + h } }
    : { a: { x: d.x - h, y: d.y }, b: { x: d.x + h, y: d.y } };
}

export function diodeT(d) { return twoT(d, DIODE_L); }
export function resistorT(r) { return twoT(r, RES_L); }

// Switch terminals: fed side (in) and output side (out). Normally fed from
// the left; s.flip mirrors it so the output faces left.
export function switchT(s) {
  const a = { x: s.x - 1, y: s.y }, b = { x: s.x + 1, y: s.y };
  return s.flip ? { in: b, out: a } : { in: a, out: b };
}

// A changeover switch (one with a `to` net) is drawn like a relay contact
// worked by hand: the common is the output, and the lever rests on the
// high throw or the low one.
export function switchSpdtT(s) {
  return {
    c: { x: s.x + 1, y: s.y },
    hi: { x: s.x - 1, y: s.y - 0.6 },
    lo: { x: s.x - 1, y: s.y + 0.6 },
  };
}
