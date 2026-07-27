// The 4002 RAM chip, modelled rather than simulated.
//
// This is the one place in the project where a thing is not built from
// devices, and it is worth being explicit about why. 320 bits of storage
// costs roughly 7,400 transistors at this cell density — three times the
// whole 4004 — and simulating them would demonstrate nothing the 16×4
// register file has not already shown with real cells. Storage is storage.
//
// The 4002 is also a *separate chip*: the 4004 reaches it over a bus, not
// through internal wiring, so the package boundary is a defensible place
// to stop building. See CLAUDE.md's fourth rule.
//
// What stays real is everything about the *interface*, because that is the
// part that is about the 4004:
//
//   SRC   sends 8 bits from a register pair — the high nibble selects a
//         chip and one of its four registers, the low nibble selects a
//         character within that register. The CPU does this addressing in
//         gates; this model only receives the result.
//   DCL   selects which bank of chips is live.
//   WRM/RDM   write and read the addressed main-memory character.
//   WR0-3 / RD0-3   the four status characters each register carries
//         alongside its sixteen main ones — separately addressed, which is
//         why they need eight opcodes of their own.
//   WMP / WRR / RDR   the 4-bit output and input ports.
//
// One real 4002 organisation, not a simplification of it:
//
//   4 registers × 16 main characters  =  64 nibbles
//   4 registers ×  4 status characters =  16 nibbles
//                                        ─────────
//                                         80 nibbles = 320 bits

export const REGISTERS = 4;      // per chip
export const MAIN_CHARS = 16;    // per register
export const STATUS_CHARS = 4;   // per register

export class Ram4002 {
  constructor(chipId = 0) {
    this.chipId = chipId;
    // main[register][character] and status[register][character]
    this.main = Array.from({ length: REGISTERS },
      () => new Uint8Array(MAIN_CHARS));
    this.status = Array.from({ length: REGISTERS },
      () => new Uint8Array(STATUS_CHARS));
    // The 4-bit output port. WMP writes it; on real hardware it drove a
    // printer or a display, and it holds its value until written again.
    this.outPort = 0;
    // What SRC last selected. Held here because SRC and the access that
    // follows it are separate instructions — the address persists between
    // them, which is exactly why SRC exists as its own opcode.
    this.selectedReg = 0;
    this.selectedChar = 0;
    this.selected = false;   // is this chip the one SRC addressed?
  }

  // SRC delivers 8 bits. The top two select the chip, the next two the
  // register, the low four the character. A chip that is not selected
  // ignores every access until the next SRC, which is how four chips share
  // one bus without arbitration.
  src(byte) {
    const chip = (byte >> 6) & 3;
    this.selected = chip === this.chipId;
    this.selectedReg = (byte >> 4) & 3;
    this.selectedChar = byte & 15;
  }

  readMain() {
    if (!this.selected) return null;
    return this.main[this.selectedReg][this.selectedChar];
  }

  writeMain(nibble) {
    if (!this.selected) return;
    this.main[this.selectedReg][this.selectedChar] = nibble & 15;
  }

  // Status characters are addressed by *which* status opcode was used,
  // not by the character SRC selected — RD0 reads status 0 of the
  // selected register regardless of where SRC pointed within main memory.
  // That asymmetry is real and easy to get wrong.
  readStatus(index) {
    if (!this.selected) return null;
    return this.status[this.selectedReg][index & 3];
  }

  writeStatus(index, nibble) {
    if (!this.selected) return;
    this.status[this.selectedReg][index & 3] = nibble & 15;
  }

  writePort(nibble) {
    if (!this.selected) return;
    this.outPort = nibble & 15;
  }

  // Everything the display needs, in one call: what is stored, what is
  // addressed, what the port is driving. A modelled chip has to be *more*
  // legible than a simulated one, not less — it cannot be inspected by
  // looking at it, so it has to say what it holds.
  inspect() {
    return {
      chipId: this.chipId,
      selected: this.selected,
      reg: this.selectedReg,
      char: this.selectedChar,
      main: this.main.map(r => Array.from(r)),
      status: this.status.map(r => Array.from(r)),
      outPort: this.outPort,
    };
  }
}

// A bank of four chips, which is what DCL selects between and what a
// single SRC addresses across. The bank is the unit the CPU sees: it puts
// eight bits on the bus and exactly one chip answers.
export class RamBank {
  constructor() {
    this.chips = [0, 1, 2, 3].map(id => new Ram4002(id));
  }

  src(byte) { for (const c of this.chips) c.src(byte); }

  // Reads return the one selected chip's answer. Null means no chip is
  // selected, which is a real state — a program that reads without an
  // SRC gets nothing, and pretending otherwise would hide the bug.
  readMain() {
    for (const c of this.chips) {
      const v = c.readMain();
      if (v !== null) return v;
    }
    return null;
  }

  readStatus(i) {
    for (const c of this.chips) {
      const v = c.readStatus(i);
      if (v !== null) return v;
    }
    return null;
  }

  writeMain(n) { for (const c of this.chips) c.writeMain(n); }
  writeStatus(i, n) { for (const c of this.chips) c.writeStatus(i, n); }
  writePort(n) { for (const c of this.chips) c.writePort(n); }

  inspect() { return this.chips.map(c => c.inspect()); }
}
