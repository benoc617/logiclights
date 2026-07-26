// Group a circuit's switches and lamps into named binary buses so the I/O
// table can show (and set) whole numbers instead of individual contacts.
//
// Naming convention: a trailing number makes a bit of a bus — A0..A7 form
// bus "A", bit 0 being the LSB. Anything else is a one-bit bus of its own.
// Bit indices need not start at zero or be contiguous: bits are sorted and
// then packed LSB-first, so lamps named N1/N2/N3 read as a 3-bit bus.

const NAME_RE = /^([A-Za-z][A-Za-z_-]*?)(\d+)$/;

function splitKey(key) {
  const m = NAME_RE.exec(key);
  return m ? { name: m[1], index: Number(m[2]) } : { name: key, index: 0 };
}

function group(items) {
  const order = [];
  const byName = new Map();
  for (const item of items) {
    const { name, index } = splitKey(item.key);
    if (!byName.has(name)) { byName.set(name, []); order.push(name); }
    byName.get(name).push({ ...item, index });
  }
  return order.map(name => ({
    name,
    bits: byName.get(name).sort((a, b) => a.index - b.index),
  }));
}

export function deriveBuses(circuit) {
  return {
    inputs: group(circuit.switches.map(sw => ({ key: sw.label, sw }))),
    outputs: group(circuit.lamps.map(l => ({ key: l.short ?? l.label, net: l.net }))),
    internals: circuit.buses.map(b => ({
      name: b.name,
      bits: b.nets.map((net, index) => ({ net, index })),
    })),
  };
}

// read(bit) -> boolean. Bit at position 0 is the LSB.
export function busValue(bus, read) {
  let v = 0;
  for (let pos = 0; pos < bus.bits.length; pos++) {
    if (read(bus.bits[pos])) v += 2 ** pos;
  }
  return v;
}
