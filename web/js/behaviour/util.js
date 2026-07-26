// Trivial helpers shared by the circuit builders.
//
// These are one-line pass-throughs to the Circuit API, kept because the
// builders read better with them: `w(c, net, [x, y], [x, y])` is the
// vocabulary the hand-routed circuits are written in, and spelling out
// `c.wire(...)` several hundred times would bury the geometry in noise.
//
// They live here rather than in each technology's file so the signatures
// cannot drift apart — they were duplicated across relays.js, general.js
// and mos-scaffold.js before this.

export function w(c, net, ...pts) {
  c.wire(net, ...pts);
}

export function relay(c, name, coil, x, y, contacts) {
  return c.addRelay(name, coil, x, y, contacts);
}
