// The 4004 instruction decoder.
//
// A 4004 instruction is one byte, sometimes two. The high nibble (OPR) is
// the opcode and the low nibble (OPA) is its operand — a register number, a
// condition mask, an immediate. Two opcodes escape that rule: `1110` and
// `1111` put a *second* opcode in the low nibble, which is how thirteen
// accumulator instructions fit in the space of two.
//
//   OPR   mnemonic   OPA means
//   0000  NOP        —
//   0001  JCN        condition mask (second byte is the address)
//   0010  FIM/SRC    register pair; bit 0 picks which
//   0011  FIN/JIN    register pair; bit 0 picks which
//   0100  JUN        high 4 bits of a 12-bit address
//   0101  JMS        high 4 bits of a 12-bit address
//   0110  INC        register
//   0111  ISZ        register (second byte is the address)
//   1000  ADD        register
//   1001  SUB        register
//   1010  LD         register
//   1011  XCH        register
//   1100  BBL        immediate returned in the accumulator
//   1101  LDM        immediate
//   1110  —          escape: OPA is a memory/IO opcode
//   1111  —          escape: OPA is an accumulator opcode (CLC, IAC, …)
//
// What this module produces is one-hot: a line per opcode, high when that
// instruction is in the register. Control sequencing then gates the
// datapath from those lines, which is the next stage — a decoder on its own
// does nothing but light up, and that is exactly what makes it the right
// thing to build and watch first.
//
// Built from the same 4-to-16 decoder the ROM and register file use. That
// is the whole reason to have modules: address decoding, row selection and
// instruction decoding are the same operation, and here it is a third time.

import { VDD, VSS } from './engine.js';
import { defineModule } from './module.js';
import { Inverter, And2, Or2, GATE_W, GATE_H } from './gates.js';

// The names in OPR order, so a display can label the one-hot lines. Null
// entries are the two escape prefixes, which name no instruction by
// themselves.
export const OPR_NAMES = [
  'NOP', 'JCN', 'FIM', 'FIN', 'JUN', 'JMS', 'INC', 'ISZ',
  'ADD', 'SUB', 'LD', 'XCH', 'BBL', 'LDM', null, null,
];

// A 4-to-16 one-hot decoder. The ROM has its own copy shaped for a memory
// array (rows on a pitch, gated by an enable); this one is laid out for
// reading instruction lines, so it stays separate rather than being bent
// to serve both.
const DEC_BANK = 8;                 // rows per bank
const DEC_BANK_W = GATE_W * 9;      // horizontal pitch between the two banks
const DEC_BUF_W = GATE_W * 5;       // pitch between the two banks of buffers

export const Decode16 = defineModule('dec16', {
  ports: [
    ...Array.from({ length: 4 }, (_, i) => ({
      name: `a${i}`, x: -1.5, y: i * 4, side: 'in',
    })),
    ...Array.from({ length: 16 }, (_, i) => ({
      name: `y${i}`, x: DEC_BANK_W * 2 + GATE_W, y: (i % DEC_BANK) * 6,
      side: 'out',
    })),
  ],
  build(m) {
    const a = [], na = [];
    for (let i = 0; i < 4; i++) {
      a.push(m.port(`a${i}`));
      na.push(m.net());
      m.instantiate(Inverter, 0, i * (GATE_H + 2), { a: a[i], y: na[i] });
    }
    // Two banks of eight rather than one column of sixteen — the same fold
    // the register file uses, for the same reason. Sixteen stacked rows
    // make a block over a thousand units tall beside a datapath a fifth of
    // that, and everything else on the machine then has to be placed around
    // a column of mostly empty space. The rows are independent, so this is
    // pure placement and costs nothing electrically.
    for (let r = 0; r < 16; r++) {
      const p0 = m.net(), p1 = m.net();
      const y = (r % DEC_BANK) * (GATE_H + 2);
      const x = Math.floor(r / DEC_BANK) * DEC_BANK_W;
      m.instantiate(And2, x + GATE_W * 2, y,
        { a: (r & 1) ? a[0] : na[0], b: (r & 2) ? a[1] : na[1], y: p0 });
      m.instantiate(And2, x + GATE_W * 4, y,
        { a: (r & 4) ? a[2] : na[2], b: (r & 8) ? a[3] : na[3], y: p1 });
      m.instantiate(And2, x + GATE_W * 6, y,
        { a: p0, b: p1, y: m.port(`y${r}`) });
    }
  },
});

// The decoder proper: eight instruction-register bits in, one line per
// opcode out, plus the two escape lines and a few signals control
// sequencing will want.
//
// `i0..i7` are the instruction bits, LSB first — so i4..i7 are OPR and
// i0..i3 are OPA, which is the operand.
export const InstructionDecoder = defineModule('idec', {
  ports: [
    ...Array.from({ length: 8 }, (_, i) => ({
      name: `i${i}`, x: -1.5, y: i * 4, side: 'in',
    })),
    // one line per OPR value
    ...Array.from({ length: 16 }, (_, i) => ({
      name: `op${i}`, x: 400, y: (i % DEC_BANK) * 6, side: 'out',
    })),
    // One line per accumulator-group instruction: OPR 1111 decoded again
    // through OPA. `acc0` is CLB, `acc2` is IAC, and so on down the table
    // in ESC_ACC order. These are the thirteen instructions that share a
    // single opcode, and this second decode is how the chip tells them
    // apart — the same 4-to-16 tree, one level down.
    ...Array.from({ length: 16 }, (_, i) => ({
      name: `acc${i}`, x: 400, y: 70 + (i % DEC_BANK) * 6, side: 'out',
    })),
    // `twoByte` is high for the instructions that take an address byte
    // after them, which is what tells the sequencer to fetch again before
    // executing. JCN, JUN, JMS, ISZ and FIM all do.
    { name: 'twoByte', x: 400, y: 100, side: 'out' },
  ],
  build(m) {
    const dec = m.instantiate(Decode16, 0, 0, {
      a0: m.port('i4'), a1: m.port('i5'), a2: m.port('i6'), a3: m.port('i7'),
    });
    // Buffer each line through a pair of inverters: an even number, so the
    // sense is kept, and the decode tree drives the sequencer rather than
    // the sequencer loading the tree. They are ports rather than internal
    // nets so a display can read every one, which is the point of watching
    // a decoder at all.
    // The buffers follow the decoder's two-bank fold, so each pair sits
    // beside the row it buffers rather than trailing off the bottom.
    for (let i = 0; i < 16; i++) {
      const t = m.net();
      const y = (i % DEC_BANK) * (GATE_H + 2);
      const x = Math.floor(i / DEC_BANK) * DEC_BUF_W;
      m.instantiate(Inverter, x + GATE_W * 19, y,
        { a: dec.nets[`y${i}`], y: t });
      m.instantiate(Inverter, x + GATE_W * 21, y,
        { a: t, y: m.port(`op${i}`) });
    }

    // The accumulator group: a second 4-to-16 decode of OPA, gated by the
    // 1111 escape line. Every output is low unless the instruction really
    // is an accumulator instruction, so control can OR these lines with
    // ordinary opcode lines without a qualifier on each one.
    //
    // Note this is the *third* place the same decoder module appears —
    // ROM row select, register file, instruction decode — and now a
    // fourth. Address decoding is one operation wearing four hats.
    const ACC_Y = GATE_H * 22;      // clear of the banked OPR decode above
    const adec = m.instantiate(Decode16, 0, ACC_Y, {
      a0: m.port('i0'), a1: m.port('i1'), a2: m.port('i2'), a3: m.port('i3'),
    });
    for (let i = 0; i < 16; i++) {
      const y = ACC_Y + (i % DEC_BANK) * (GATE_H + 2);
      const x = Math.floor(i / DEC_BANK) * DEC_BUF_W;
      m.instantiate(And2, x + GATE_W * 19, y,
        { a: adec.nets[`y${i}`], b: dec.nets.y15, y: m.port(`acc${i}`) });
    }

    // twoByte = JCN | JUN | JMS | ISZ | FIM-not-SRC.
    // FIM and SRC share opcode 0010 and are told apart by OPA bit 0: even
    // is FIM (two bytes), odd is SRC (one). That shared encoding is why
    // this cannot be read off the OPR nibble alone.
    const notI0 = m.net(), fim = m.net();
    m.instantiate(Inverter, GATE_W * 15, 0, { a: m.port('i0'), y: notI0 });
    m.instantiate(And2, GATE_W * 17, 0,
      { a: dec.nets.y2, b: notI0, y: fim });

    const o1 = m.net(), o2 = m.net(), o3 = m.net();
    m.instantiate(Or2, GATE_W * 15, GATE_H * 2,
      { a: dec.nets.y1, b: dec.nets.y4, y: o1 });          // JCN | JUN
    m.instantiate(Or2, GATE_W * 15, GATE_H * 4,
      { a: dec.nets.y5, b: dec.nets.y7, y: o2 });          // JMS | ISZ
    m.instantiate(Or2, GATE_W * 18, GATE_H * 2, { a: o1, b: o2, y: o3 });
    m.instantiate(Or2, GATE_W * 21, GATE_H * 2,
      { a: o3, b: fim, y: m.port('twoByte') });
  },
});

// Turn a byte into the instruction it encodes.
//
// This is the disassembler half of what the hardware decoder does in gates:
// same opcode table, same OPA rules, so a program listing and the lit
// decoder line always agree. If they ever disagree one of them is wrong,
// which is a useful property to have.
//
// It is display code, not simulation — the machine decodes in transistors
// and this only names what it decoded, the way the assembler in 4004.md
// will only set switch objects. Nothing here computes anything the circuit
// does not.
//
// The escape groups have their own tables: opcode 1110 puts a memory/IO
// opcode in OPA and 1111 puts an accumulator opcode there, which is how
// thirteen instructions fit in the space of two.
const ESC_MEM = {
  0: 'WRM', 1: 'WMP', 2: 'WRR', 4: 'WR0', 5: 'WR1', 6: 'WR2', 7: 'WR3',
  8: 'SBM', 9: 'RDM', 10: 'RDR', 11: 'ADM',
  12: 'RD0', 13: 'RD1', 14: 'RD2', 15: 'RD3',
};
const ESC_ACC = {
  0: 'CLB', 1: 'CLC', 2: 'IAC', 3: 'CMC', 4: 'CMA', 5: 'RAL', 6: 'RAR',
  7: 'TCC', 8: 'DAC', 9: 'TCS', 10: 'STC', 11: 'DAA', 12: 'KBP', 13: 'DCL',
};

// How the operand nibble reads for each opcode.
//   'reg'  a register number      INC 3
//   'pair' a register pair        FIM 0P
//   'imm'  an immediate           LDM 5
//   'mask' a JCN condition mask   JCN 12
//   'addr' the high bits of an address, with a second byte following
//   null   no operand             NOP
const OPA_KIND = [
  null, 'mask', 'pair', 'pair', 'addr', 'addr', 'reg', 'reg',
  'reg', 'reg', 'reg', 'reg', 'imm', 'imm', 'esc', 'esc',
];

// Which instructions consume a following byte. Matches the hardware's
// twoByte line exactly, including FIM/SRC sharing opcode 0010 and being
// told apart by OPA bit 0.
export function isTwoByte(byte) {
  const opr = (byte >> 4) & 15, opa = byte & 15;
  if (opr === 1 || opr === 4 || opr === 5 || opr === 7) return true;
  if (opr === 2 && (opa & 1) === 0) return true;   // FIM, not SRC
  return false;
}

// Disassemble one byte, optionally with the byte that follows it.
// Returns { text, twoByte } — `text` is the mnemonic with its operand.
export function disassemble(byte, next) {
  const opr = (byte >> 4) & 15, opa = byte & 15;
  const two = isTwoByte(byte);

  // 0xFE and 0xFF are genuinely undefined on the chip and show a dash.
  // 0xE3 is NOT undefined — it is WPM, write program memory — but it is
  // deliberately deferred here (it is INTELLEC-4 development-system
  // support, not architecture; docs/4004.md tells that story), so its
  // slot shows the same dash until it exists. A dash is honest either
  // way; an invented mnemonic would not be.
  if (opr === 14) return { text: ESC_MEM[opa] ?? '—', twoByte: false };
  if (opr === 15) return { text: ESC_ACC[opa] ?? '—', twoByte: false };

  const name = OPR_NAMES[opr];
  const kind = OPA_KIND[opr];

  // FIM and SRC, FIN and JIN share an opcode; OPA bit 0 picks which
  let mnemonic = name;
  if (opr === 2) mnemonic = (opa & 1) ? 'SRC' : 'FIM';
  if (opr === 3) mnemonic = (opa & 1) ? 'JIN' : 'FIN';

  let arg = '';
  if (kind === 'reg') arg = ` r${opa}`;
  else if (kind === 'pair') arg = ` ${opa >> 1}P`;
  else if (kind === 'imm') arg = ` ${opa}`;
  else if (kind === 'mask') arg = ` ${opa}`;
  else if (kind === 'addr') {
    // the full target is this nibble plus the whole next byte
    arg = next === undefined ? ` ${opa}xx` : ` ${((opa << 8) | next)}`;
  }
  if (two && kind !== 'addr' && next !== undefined) arg += `, ${next}`;

  return { text: mnemonic + arg, twoByte: two };
}

// Disassemble a whole ROM into one entry per address.
//
// Every address gets a line, including the operand bytes of two-byte
// instructions — because the machine can land on one. A program that jumps
// into the middle of an instruction executes the operand as an opcode, and
// hiding those addresses would hide exactly that.
export function disassembleProgram(bytes) {
  return bytes.map((byte, addr) => {
    const next = bytes[addr + 1];
    const { text, twoByte } = disassemble(byte, next);
    // is this address the operand of the instruction before it?
    const isOperand = addr > 0 && isTwoByte(bytes[addr - 1]);
    return { addr, byte, text, twoByte, isOperand };
  });
}
