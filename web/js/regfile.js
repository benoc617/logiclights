// A 16 × 4 register file — the 4004's index registers.
//
// The largest single block in the machine (4004.md budgets ~500 devices for
// it) and the one that decides whether the module abstraction actually
// works: sixteen identical rows of four identical cells, none of it placed
// by hand.
//
// Structure, which is the standard one:
//
//   write port  — a 4-to-16 decoder gated by WE picks one row's latches.
//                 Only the selected row's enable goes high, so only that
//                 word is written and every other row keeps holding.
//   read  port  — a second 4-to-16 decoder drives tri-state buffers, so all
//                 sixteen rows share four bit lines. This is the same
//                 shared-bus trick as the ALU's result bus and the reason a
//                 register file does not need a mux tree per destination.
//
// Two separate address inputs, because a real datapath reads one register
// while writing another. Reading is combinational; writing takes effect
// while WE is high (these are level-sensitive latches, not edge-triggered
// flip-flops — the 4004's own registers were level-sensitive too).
//
// The read bus genuinely floats when no row is selected. That is not a
// defect to paper over: it is what tri-state means, and the four-state
// solver reports Z rather than inventing a level.

import { VDD, VSS } from './engine.js';
import { defineModule } from './module.js';
import {
  Inverter, And2, DLatch, PassGate, GATE_W, GATE_H,
} from './gates.js';

export const REG_WORDS = 16;
export const REG_WIDTH = 4;
export const REG_ADDR = 4;      // log2(REG_WORDS)

const ROW_PITCH = 26;           // vertical pitch between register rows
const CELL_PITCH = GATE_W * 5;  // horizontal pitch between bit cells

// 4-to-16 one-hot decoder with an enable. When `en` is low every output is
// low, which is what lets the write decoder be held off between writes.
const Decode4 = defineModule('dec4', {
  ports: [
    ...Array.from({ length: REG_ADDR }, (_, i) => ({
      name: `a${i}`, x: -1.5, y: i * 4, side: 'in',
    })),
    { name: 'en', x: -1.5, y: 20, side: 'in' },
    ...Array.from({ length: REG_WORDS }, (_, i) => ({
      name: `y${i}`, x: GATE_W * 10, y: i * ROW_PITCH, side: 'out',
    })),
  ],
  build(m) {
    const a = [], na = [];
    for (let i = 0; i < REG_ADDR; i++) {
      a.push(m.port(`a${i}`));
      na.push(m.net());
      m.instantiate(Inverter, 0, i * (GATE_H + 2), { a: a[i], y: na[i] });
    }
    for (let r = 0; r < REG_WORDS; r++) {
      // fold the four address lines pairwise, then gate with `en`.
      // Rows are laid out in two banks of eight to match the array, so the
      // decode gates sit beside the rows they drive.
      const p0 = m.net(), p1 = m.net(), both = m.net();
      const y = (r % 8) * ROW_PITCH;
      const x0 = Math.floor(r / 8) * GATE_W * 9;   // second bank to the right
      m.instantiate(And2, x0 + GATE_W * 2, y,
        { a: (r & 1) ? a[0] : na[0], b: (r & 2) ? a[1] : na[1], y: p0 });
      m.instantiate(And2, x0 + GATE_W * 4, y,
        { a: (r & 4) ? a[2] : na[2], b: (r & 8) ? a[3] : na[3], y: p1 });
      m.instantiate(And2, x0 + GATE_W * 6, y, { a: p0, b: p1, y: both });
      m.instantiate(And2, x0 + GATE_W * 8, y,
        { a: both, b: m.port('en'), y: m.port(`y${r}`) });
    }
  },
});

// One register: REG_WIDTH latches sharing a write-enable, each driving the
// shared read bus through a tri-state gate.
const RegRow = defineModule('reg', {
  ports: [
    ...Array.from({ length: REG_WIDTH }, (_, i) => ({
      name: `d${i}`, x: -1.5, y: i * 4, side: 'in',
    })),
    ...Array.from({ length: REG_WIDTH }, (_, i) => ({
      name: `q${i}`, x: CELL_PITCH * REG_WIDTH, y: i * 4, side: 'out',
    })),
    { name: 'we', x: 0, y: -6, side: 'top' },
    { name: 'nwe', x: 0, y: -4, side: 'top' },
    { name: 'rd', x: 0, y: -2, side: 'top' },
    { name: 'nrd', x: 0, y: 0, side: 'top' },
  ],
  build(m) {
    // The stored nets are internal — nothing outside the row would be able
    // to see them, since the read bus only shows the one selected register.
    // Hand them back so the app can display all sixteen words at once.
    m.stored = [];
    for (let b = 0; b < REG_WIDTH; b++) {
      const stored = m.net();
      m.stored.push(stored);
      m.instantiate(DLatch, b * CELL_PITCH, 0, {
        d: m.port(`d${b}`), q: stored,
        en: m.port('we'), nen: m.port('nwe'),
      });
      // tri-state onto the shared bus: open only for the selected row
      m.instantiate(PassGate, b * CELL_PITCH + GATE_W * 4, 14, {
        a: stored, y: m.port(`q${b}`),
        en: m.port('rd'), nen: m.port('nrd'),
      });
    }
  },
});

export const RegFile16x4 = defineModule('regfile', {
  ports: [
    // write port
    ...Array.from({ length: REG_ADDR }, (_, i) => ({
      name: `wa${i}`, x: -1.5, y: i * 4, side: 'in',
    })),
    ...Array.from({ length: REG_WIDTH }, (_, i) => ({
      name: `d${i}`, x: -1.5, y: 20 + i * 4, side: 'in',
    })),
    { name: 'we', x: -1.5, y: 40, side: 'in' },
    // read port
    ...Array.from({ length: REG_ADDR }, (_, i) => ({
      name: `ra${i}`, x: -1.5, y: 50 + i * 4, side: 'in',
    })),
    ...Array.from({ length: REG_WIDTH }, (_, i) => ({
      name: `q${i}`, x: 400, y: i * 4, side: 'out',
    })),
  ],
  build(m) {
    // every register's stored nets, so the app can show the whole file at
    // once rather than one word at a time through the read port
    const cells = [];
    m.stored = cells;

    // write decoder, gated by WE so nothing is written between writes
    const wBind = { en: m.port('we') };
    for (let i = 0; i < REG_ADDR; i++) wBind[`a${i}`] = m.port(`wa${i}`);
    const wdec = m.instantiate(Decode4, 0, 0, wBind, { tag: 'wdec' });
    // Boxes are derived from the instances' measured extents rather than
    // hand-typed coordinates, so they follow the layout instead of drifting
    // from it the next time a pitch changes.
    m.region('Write decoder — WA selects one of 16 rows',
      -3, -3, wdec.w + 2, wdec.h + 2);

    // read decoder, always enabled — reading is combinational
    const rBind = { en: VDD };
    for (let i = 0; i < REG_ADDR; i++) rBind[`a${i}`] = m.port(`ra${i}`);
    // clear of the write decoder, which is now two banks wide
    const rdec = m.instantiate(Decode4, GATE_W * 21, 0, rBind, { tag: 'rdec' });
    m.region('Read decoder — RA selects one of 16 rows',
      GATE_W * 21 - 2, -2, GATE_W * 21 + rdec.w + 2, rdec.h + 2);

    // Sixteen rows stacked is a tall thin block; the library is drawn wide
    // and short. Fold them into two banks of eight side by side — the rows
    // are electrically independent (they share only the data and read
    // buses, which are nets, not wires), so this is purely a placement
    // choice and costs nothing.
    const BANK = 8;
    const bankW = CELL_PITCH * REG_WIDTH + GATE_W * 8;
    const xRows0 = GATE_W * 47;   // clear of both decoders, with room for boxes
    for (let r = 0; r < REG_WORDS; r++) {
      const bank = Math.floor(r / BANK);
      const xRows = xRows0 + bank * bankW;
      const y = (r % BANK) * ROW_PITCH;
      // each row needs both polarities of its two selects
      const nwe = m.net(), nrd = m.net();
      m.instantiate(Inverter, xRows - GATE_W * 3, y,
        { a: wdec.nets[`y${r}`], y: nwe });
      m.instantiate(Inverter, xRows - GATE_W * 1.5, y,
        { a: rdec.nets[`y${r}`], y: nrd });

      const bind = {
        we: wdec.nets[`y${r}`], nwe,
        rd: rdec.nets[`y${r}`], nrd,
      };
      for (let b = 0; b < REG_WIDTH; b++) {
        bind[`d${b}`] = m.port(`d${b}`);   // data bus, shared by every row
        bind[`q${b}`] = m.port(`q${b}`);   // read bus, shared by every row
      }
      const row = m.instantiate(RegRow, xRows, y, bind, { tag: `r${r}` });
      cells.push(row.stored);   // this register's four stored nets, LSB first

      // Each register gets its own box, so "where is r9" has an answer you
      // can point at. At a glance the sixteen boxes are also the clearest
      // statement of what this circuit is: sixteen copies of one thing.
      // caption inside the box: the rows are pitched too tightly for an
      // outside label, which would land on the row above
      m.region(`r${r}`, xRows - GATE_W * 4, y - 2,
        xRows + row.w + 1, y + ROW_PITCH - 6, { side: 'inside' });
    }

    // and a box around each bank, naming the whole array
    const bankH = BANK * ROW_PITCH;
    for (let bank = 0; bank < REG_WORDS / BANK; bank++) {
      const x = xRows0 + bank * bankW;
      m.region(
        bank === 0
          ? 'Registers r0–r7 — four static latches each'
          : 'Registers r8–r15 — tri-stated onto one shared read bus',
        x - GATE_W * 5, -6,
        x + CELL_PITCH * (REG_WIDTH - 1) + GATE_W * 6, bankH - 4,
        { side: 'bottom' });
    }
  },
});
