// A reference Intel 4004, in plain JavaScript, for use as a test oracle.
//
// This is deliberately NOT part of the app. The app simulates a 4004 out of
// transistors; this computes what one should do. Keeping the two apart is
// the whole point — an oracle that shared code with the thing it checks
// would agree with it while both were wrong.
//
// Every rule here is from Intel's MCS-4 manual rather than from the
// hardware in web/js. Where the two disagree, this file is not
// automatically right — but it is *independently* derived, so a
// disagreement means one of them has a bug worth finding, which is what an
// oracle is for.
//
// The subtle ones, each of which the hardware also had to get right:
//
//   SUB / SBM   ACC + ~operand + ~carry. The carry inverts on the way in
//               and means "no borrow" on the way out — the sense flips
//               across the instruction, which is why the manual tells you
//               to CMC between chained subtractions.
//   DAA         adds 6 when the digit is illegal or the carry is set, and
//               can SET the carry but never RESETS it.
//   BBL         loads its own data field into the accumulator on the way
//               out, so a subroutine cannot return a value in ACC.
//   stack       three registers on a cylinder: a pointer rotates and the
//               values stay put. A fourth push silently overwrites the
//               oldest, with no trap, and a pop leaves what it read.
//   FIN         one byte, two instruction cycles. Its address always comes
//               from r0:r1 whatever pair it writes, and the PC advances by
//               exactly one across both cycles.
//   KBP         1-of-n to binary by table; more than one bit set is an
//               error code (1111) rather than a guess.

export class Emu4004 {
  // `rom` is an array of bytes. `ramBanks` is how many 4002 banks to model;
  // the default of one matches the machines in the library.
  constructor(rom, { ramBanks = 8 } = {}) {
    this.rom = Uint8Array.from(rom);
    this.reset(ramBanks);
  }

  reset(ramBanks = this.ramBanks ?? 8) {
    this.ramBanks = ramBanks;
    this.pc = 0;
    this.acc = 0;
    this.carry = 0;
    this.reg = new Uint8Array(16);
    // Three levels, plus the rotating pointer. Not a shifting stack: see
    // the class comment.
    //
    // Uint16Array, not Uint8Array: these hold 12-bit ROM addresses, and an
    // 8-bit cell silently truncates every call above 0xFF into a return to
    // the wrong page — which passes every test whose program fits in one
    // page, and corrupts the return path on any that does not.
    this.stack = new Uint16Array(3);
    this.sp = 0;
    this.test = 0;            // the TEST pin, driven from outside
    this.bank = 0;            // DCL, and a RESET selects bank 0
    this.src = 0;             // the address SRC left behind
    // Each bank is 4 chips x 4 registers x (16 main + 4 status).
    this.ram = Array.from({ length: ramBanks }, () =>
      Array.from({ length: 4 }, () => ({
        main: Array.from({ length: 4 }, () => new Uint8Array(16)),
        status: Array.from({ length: 4 }, () => new Uint8Array(4)),
        outPort: 0,
      })));
    this.romPort = 0;
    this.halted = false;      // set when a JUN jumps to itself
    this.cycles = 0;          // instruction cycles, so FIN's cost shows
  }

  // --- helpers -----------------------------------------------------------
  get pair() { return (this._fetch(this.pc) >> 1) & 7; }

  // Read the program store, wrapping to its size.
  //
  // A real 4001 decodes only the address lines it has, so a machine with a
  // sixteen-word ROM answers address 0x15 with word 5 — the high bits
  // simply are not wired. The library's machines are built that way, and
  // their programs rely on it: the memory machine's SRC address 0x15
  // doubles as a FIN target precisely because it truncates. Treating an
  // over-long address as "off the end, return 0" instead would make the
  // oracle disagree with the hardware on a program the hardware runs
  // correctly, which is the wrong way round for an oracle.
  _fetch(addr) {
    return this.rom.length ? this.rom[addr % this.rom.length] : 0;
  }

  // The 4002 the current SRC address selects.
  _chip() {
    const chip = (this.src >> 6) & 3;
    return this.ram[this.bank & (this.ramBanks - 1)][chip];
  }
  _regOf() { return (this.src >> 4) & 3; }
  _charOf() { return this.src & 15; }

  _push(addr) {
    this.stack[this.sp] = addr & 0xFFF;
    this.sp = (this.sp + 1) % 3;
  }
  _pop() {
    this.sp = (this.sp + 2) % 3;      // back one, modulo three
    return this.stack[this.sp];       // the value stays where it is
  }

  // ACC + operand + carryIn, updating both. Every arithmetic path goes
  // through here so the carry rule lives in exactly one place.
  _add(operand, carryIn) {
    const sum = this.acc + (operand & 15) + (carryIn & 1);
    this.acc = sum & 15;
    this.carry = sum > 15 ? 1 : 0;
  }

  // --- one instruction ---------------------------------------------------
  // Returns the number of instruction cycles it took: 1 for everything
  // except FIN, which is one byte but two cycles.
  step() {
    const at = this.pc;
    const byte = this._fetch(this.pc);
    const opr = (byte >> 4) & 15;
    const opa = byte & 15;
    this.pc = (this.pc + 1) & 0xFFF;
    let cycles = 1;

    const second = () => {
      const b = this._fetch(this.pc);
      this.pc = (this.pc + 1) & 0xFFF;
      return b;
    };

    switch (opr) {
      case 0x0:                                   // NOP
        break;

      case 0x1: {                                 // JCN mask, addr
        const addr = second();
        // mask bit 3 inverts the whole condition; bits 2/1/0 are
        // ACC == 0, carry == 1, TEST == 0 respectively.
        const invert = (opa & 8) !== 0;
        let take = false;
        if (opa & 4) take = take || this.acc === 0;
        if (opa & 2) take = take || this.carry === 1;
        if (opa & 1) take = take || this.test === 0;
        if (invert) take = !take;
        // The target replaces the low 8 bits; the page comes from the
        // address of the *next* instruction, which matters at a page edge.
        if (take) this.pc = (this.pc & 0xF00) | addr;
        break;
      }

      case 0x2: {
        if (opa & 1) {                            // SRC pair
          const p = (opa >> 1) & 7;
          this.src = (this.reg[p * 2] << 4) | this.reg[p * 2 + 1];
        } else {                                  // FIM pair, data
          const data = second();
          const p = (opa >> 1) & 7;
          this.reg[p * 2] = (data >> 4) & 15;     // even takes the high nibble
          this.reg[p * 2 + 1] = data & 15;
        }
        break;
      }

      case 0x3: {
        const p = (opa >> 1) & 7;
        if (opa & 1) {                            // JIN pair
          this.pc = (this.pc & 0xF00)
            | ((this.reg[p * 2] << 4) | this.reg[p * 2 + 1]);
        } else {                                  // FIN pair
          // The address ALWAYS comes from r0:r1, whatever pair it writes.
          const addr = (this.pc & 0xF00)
            | ((this.reg[0] << 4) | this.reg[1]);
          this.reg[p * 2] = (this._fetch(addr) >> 4) & 15;
          this.reg[p * 2 + 1] = this._fetch(addr) & 15;
          cycles = 2;                             // one byte, two cycles
        }
        break;
      }

      case 0x4: {                                 // JUN addr12
        const lo = second();
        const target = ((opa & 15) << 8) | lo;
        if (target === at) this.halted = true;    // JUN $ — the spin idiom
        this.pc = target;
        break;
      }

      case 0x5: {                                 // JMS addr12
        const lo = second();
        this._push(this.pc);                      // return address = next
        this.pc = ((opa & 15) << 8) | lo;
        break;
      }

      case 0x6:                                   // INC reg
        this.reg[opa] = (this.reg[opa] + 1) & 15;
        break;

      case 0x7: {                                 // ISZ reg, addr
        const addr = second();
        this.reg[opa] = (this.reg[opa] + 1) & 15;
        if (this.reg[opa] !== 0) this.pc = (this.pc & 0xF00) | addr;
        break;
      }

      case 0x8:                                   // ADD reg
        this._add(this.reg[opa], this.carry);
        break;

      case 0x9:                                   // SUB reg
        this._add(~this.reg[opa] & 15, (~this.carry) & 1);
        break;

      case 0xA:                                   // LD reg
        this.acc = this.reg[opa];
        break;

      case 0xB: {                                 // XCH reg
        const t = this.acc;
        this.acc = this.reg[opa];
        this.reg[opa] = t;
        break;
      }

      case 0xC:                                   // BBL data
        this.pc = this._pop();
        this.acc = opa;                           // clobbers ACC, by design
        break;

      case 0xD:                                   // LDM data
        this.acc = opa;
        break;

      case 0xE: this._memGroup(opa); break;       // the 1110 escape
      case 0xF: this._accGroup(opa); break;       // the 1111 escape
    }

    this.cycles += cycles;
    return cycles;
  }

  // 1110 — memory and I/O, addressed by the last SRC.
  _memGroup(opa) {
    const chip = this._chip();
    const r = this._regOf(), ch = this._charOf();
    switch (opa) {
      case 0x0: chip.main[r][ch] = this.acc; break;              // WRM
      case 0x1: chip.outPort = this.acc; break;                  // WMP
      case 0x2: this.romPort = this.acc; break;                  // WRR
      case 0x3: break;   // WPM — needs a writable program store; not modelled
      case 0x4: case 0x5: case 0x6: case 0x7:                    // WR0-3
        // Status characters are picked by WHICH opcode ran, not by the
        // character SRC selected. The manual draws this explicitly.
        chip.status[r][opa - 4] = this.acc; break;
      case 0x8:                                                  // SBM
        this._add(~chip.main[r][ch] & 15, (~this.carry) & 1); break;
      case 0x9: this.acc = chip.main[r][ch]; break;              // RDM
      case 0xA: this.acc = this.romPort; break;                  // RDR
      case 0xB: this._add(chip.main[r][ch], this.carry); break;  // ADM
      case 0xC: case 0xD: case 0xE: case 0xF:                    // RD0-3
        this.acc = chip.status[r][opa - 12]; break;
    }
  }

  // 1111 — the accumulator group: thirteen instructions, one opcode.
  _accGroup(opa) {
    switch (opa) {
      case 0x0: this.acc = 0; this.carry = 0; break;             // CLB
      case 0x1: this.carry = 0; break;                           // CLC
      case 0x2: this._add(1, 0); break;                          // IAC
      case 0x3: this.carry ^= 1; break;                          // CMC
      case 0x4: this.acc = ~this.acc & 15; break;                // CMA
      case 0x5: {                                                // RAL
        const hi = (this.acc >> 3) & 1;
        this.acc = ((this.acc << 1) & 15) | this.carry;
        this.carry = hi; break;
      }
      case 0x6: {                                                // RAR
        const lo = this.acc & 1;
        this.acc = (this.acc >> 1) | (this.carry << 3);
        this.carry = lo; break;
      }
      case 0x7:                                                  // TCC
        this.acc = this.carry; this.carry = 0; break;
      case 0x8: this._add(15, 0); break;                         // DAC (+15 = -1)
      case 0x9:                                                  // TCS
        this.acc = this.carry ? 10 : 9; this.carry = 0; break;
      case 0xA: this.carry = 1; break;                           // STC
      case 0xB: {                                                // DAA
        if (this.acc > 9 || this.carry) {
          const sum = this.acc + 6;
          this.acc = sum & 15;
          // sets the carry on overflow, and never clears it
          if (sum > 15) this.carry = 1;
        }
        break;
      }
      case 0xC: {                                                // KBP
        const t = { 0: 0, 1: 1, 2: 2, 4: 3, 8: 4 };
        this.acc = t[this.acc] ?? 15;   // >1 key down is an error code
        break;
      }
      case 0xD: this.bank = this.acc & 7; break;                 // DCL
    }
  }

  // A snapshot small enough to diff after every instruction, and complete
  // enough that any divergence shows up in it.
  state() {
    return {
      pc: this.pc, acc: this.acc, carry: this.carry,
      reg: Array.from(this.reg), src: this.src, bank: this.bank,
      stack: Array.from(this.stack), sp: this.sp,
    };
  }
}
