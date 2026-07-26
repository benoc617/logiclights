// Shared geometry for relay/switch/lamp symbols, in world units.
// Used by both the circuit builders (for wiring) and the renderer.

export const RELAY_W = 4;          // relay body width
export const COIL_H = 1.6;         // coil box height
export const CONTACT_PITCH = 2;    // vertical spacing between contacts
export const CONTACT_Y0 = 2.6;     // first contact offset from relay top

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

// Switch terminals: fed side (in) and output side (out). Normally fed from
// the left; s.flip mirrors it so the output faces left.
export function switchT(s) {
  const a = { x: s.x - 1, y: s.y }, b = { x: s.x + 1, y: s.y };
  return s.flip ? { in: b, out: a } : { in: a, out: b };
}
