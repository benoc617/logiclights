// The circuit registry: catalogue data joined to per-circuit behaviour.
//
// What a circuit *declares* — name, group, prose, bus captions, legend rows
// — is data, in web/data/circuits.json, validated by the schema beside it.
// What a circuit *does* is code, in web/js/behaviour/, keyed by the same id.
//
// The join happens here, and it is strict in both directions: an entry with
// no behaviour, or a behaviour with no entry, throws at load rather than
// producing a circuit that quietly fails to appear. A typo in an id is the
// likeliest mistake either half can make, so it should be loud.
//
// docs/DATA.md explains where the line falls, and what it would take to
// move the rest of the way to data (the "full JSON circuits" TODO).

import { BEHAVIOUR } from './behaviour/index.js';
import catalogue from '../data/circuits.json' with { type: 'json' };

export const GROUP_ORDER = catalogue.groupOrder;

export const CIRCUITS = catalogue.circuits.map(entry => {
  const b = BEHAVIOUR[entry.id];
  if (!b) {
    throw new Error(`circuit "${entry.id}" has catalogue data but no behaviour`);
  }
  if (typeof b.build !== 'function') {
    throw new Error(`circuit "${entry.id}" has no build function`);
  }
  const merged = { ...entry, build: b.build };
  if (b.readout) merged.readout = b.readout;
  // `select` and `read` sit flat on the behaviour but belong to the table
  // and state blocks the catalogue declares — joined here so the rest of
  // the app sees one object per feature.
  if (entry.table) {
    if (!b.select) {
      throw new Error(`circuit "${entry.id}" declares a table but has no select()`);
    }
    merged.table = { ...entry.table, select: b.select };
  }
  if (entry.state) {
    if (!b.read) {
      throw new Error(`circuit "${entry.id}" declares state but has no read()`);
    }
    merged.state = { ...entry.state, read: b.read };
  }
  return merged;
});

// The other direction: behaviour for a circuit nobody catalogued could
// never be reached, so say so rather than letting it rot.
{
  const known = new Set(catalogue.circuits.map(e => e.id));
  const orphans = Object.keys(BEHAVIOUR).filter(id => !known.has(id));
  if (orphans.length) {
    throw new Error(`behaviour with no catalogue entry: ${orphans.join(', ')}`);
  }
}

export function buildCircuit(id) {
  const entry = CIRCUITS.find(e => e.id === id);
  if (!entry) throw new Error(`no circuit "${id}"`);
  const c = entry.build();
  c.desc = entry.desc;
  c.readout = entry.readout;
  c.hints = entry.hints;   // per-bus captions in the I/O table
  c.table = entry.table;   // legend of selector codes, if the circuit has one
  c.state = entry.state;   // live internal state, for circuits that store any
  return c;
}
