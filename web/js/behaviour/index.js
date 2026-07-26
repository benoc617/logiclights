// Per-circuit behaviour, keyed by circuit id.
//
// A circuit is split in two. What it *declares* — name, group, prose, bus
// captions, legend rows — is data, and lives in web/data/circuits.json.
// What it *does* is code, and lives here: how to build it, how to phrase
// its readout, which legend row is live, what internal state to display.
//
// The split is not arbitrary. The declarative half is inert text a
// non-programmer could edit and a schema can validate. This half needs real
// evaluation: `build` places devices, `readout` formats arbitrary strings,
// and `read` walks the circuit's nets. Turning these into data too would
// mean designing an expression language — see docs/DATA.md, which records
// that as a deliberate TODO rather than an oversight.
//
// Every export here is keyed by the same id the JSON uses, and the two are
// checked against each other at load: a behaviour with no matching entry,
// or an entry whose id has no `build`, is a hard error rather than a
// circuit that silently vanishes from the picker.

import { relays } from './relays.js';
import { general } from './general.js';
import { cmos } from './cmos.js';
import { nmos } from './nmos.js';

export const BEHAVIOUR = {
  ...relays,
  ...general,
  ...cmos,
  ...nmos,
};
