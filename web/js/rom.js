// Program ROM: a real NMOS mask-ROM array.
//
// This is how read-only memory was actually built, and it is worth building
// properly rather than as a lookup table, because the naive version is a
// classic trap. A bare switch matrix — a switch at every site joining a row
// line to a bit line — sneak-paths: the selected row drives a bit line, that
// line backfeeds through some unselected row's closed switch, and comes out
// again on a *different* bit line, lighting bits that are not in the word
// you addressed. Conduction is undirected (see CLAUDE.md), so the simulator
// reproduces this faithfully. Historically the fix was a diode at every
// site, which is why diode matrices existed at all.
//
// An NMOS array has no such problem, structurally. Each site is a transistor
// whose *gate* is the row line and whose channel connects the bit line to
// ground. The gate is isolated — no DC path to the channel — so a row can
// only ever switch its own sites and can never conduct backwards into
// another row. That isolation is the same property that makes a relay coil
// safe to drive from logic, and it is why the array scales.
//
// Storage convention, which is the real one: a transistor *present* at a
// site pulls its bit line down when the row is selected, so it stores a 0.
// A site with no transistor leaves the line to the pull-up, so it reads 1.
// Programming a mask ROM is deciding where to put transistors — an unused
// site is literally empty silicon.
//
// The bit lines are pulled up by resistors, so an unselected array reads all
// 1s, and a selected row pulls down only where its transistors are. That is
// a wired-AND, and it is the reason the readout is active-low in real parts.

import { VDD, VSS } from './engine.js';
import { defineModule } from './module.js';
import { Inverter, And2, GATE_W, GATE_H } from './gates.js';

// Row pitch, shared by the decoder and the array, so each decoded line runs
// straight across to the row it drives instead of sloping. Tighter than a
// gate is tall: the gates overlap vertically, which is harmless because
// consecutive rows sit in different columns.
const DEC_PITCH = 8;

// Row decoder: `bits` address lines in, 2^bits one-hot row lines out.
export function decoder(bits) {
  const lines = 1 << bits;
  return defineModule(`dec${bits}`, {
    ports: [
      ...Array.from({ length: bits }, (_, i) => ({
        name: `a${i}`, x: -1.5, y: i * 4, side: 'in',
      })),
      ...Array.from({ length: lines }, (_, i) => ({
        name: `r${i}`, x: GATE_W * 6, y: i * 6, side: 'out',
      })),
    ],
    build(m) {
      const a = [], na = [];
      for (let i = 0; i < bits; i++) {
        a.push(m.port(`a${i}`));
        na.push(m.net());
        m.instantiate(Inverter, 0, i * (GATE_H + 2), { a: a[i], y: na[i] });
      }
      for (let r = 0; r < lines; r++) {
        // AND every address line in its selected polarity, folded pairwise.
        // With one address line there is nothing to fold — the polarity of
        // that line *is* the row line, so buffer it through two inverters
        // to keep every row line the same number of gate delays from the
        // address (a decoder that skews its rows would let two sites
        // conduct at once mid-transition).
        if (bits === 1) {
          // r0 is selected when a0 is low, r1 when it is high — so the row
          // line follows the address in its *own* polarity, then two
          // inverters buffer it (an even number, so the sense is kept).
          const t = m.net();
          m.instantiate(Inverter, GATE_W * 2, r * DEC_PITCH, {
            a: (r & 1) ? a[0] : na[0], y: t,
          });
          m.instantiate(Inverter, GATE_W * 4, r * DEC_PITCH, {
            a: t, y: m.port(`r${r}`),
          });
          continue;
        }
        let acc = (r & 1) ? a[0] : na[0];
        for (let i = 1; i < bits; i++) {
          // the last fold drives the row line directly — And2 is already
          // the true AND, so inverting it here would give one-cold output
          const last = i === bits - 1;
          const next = last ? m.port(`r${r}`) : m.net();
          m.instantiate(And2, GATE_W * (2 + i * 2), r * DEC_PITCH, {
            a: acc, b: (r & (1 << i)) ? a[i] : na[i], y: next,
          });
          acc = next;
        }
      }
    },
  });
}

// The storage array itself. `words` is an array of integers, `width` bits
// each; `addrBits` address lines select among them.
//
// Returns a module with ports a0..a{n-1} (address) and d0..d{width-1}
// (data). Data is active-high at the output: the array is wired-AND and
// therefore active-low internally, and an inverter per bit line restores
// the sense — exactly what a real part does with its output buffers.
export function romArray(words, width, addrBits) {
  const rows = 1 << addrBits;
  if (words.length > rows) {
    throw new Error(`rom: ${words.length} words needs more than ${addrBits} address bits`);
  }
  const Dec = decoder(addrBits);

  return defineModule(`rom${rows}x${width}`, {
    ports: [
      ...Array.from({ length: addrBits }, (_, i) => ({
        name: `a${i}`, x: -1.5, y: i * 4, side: 'in',
      })),
      ...Array.from({ length: width }, (_, i) => ({
        name: `d${i}`, x: 200, y: i * 6, side: 'out',
      })),
    ],
    build(m) {
      const bind = {};
      for (let i = 0; i < addrBits; i++) bind[`a${i}`] = m.port(`a${i}`);
      const dec = m.instantiate(Dec, 0, 0, bind);

      const xArray = GATE_W * (8 + addrBits * 2);
      // The array is the wide part and the decoder is the tall part, so
      // give columns a generous pitch and keep rows tight: that lands the
      // block wide and short like the rest of the library, and it leaves
      // room to read each site as an individual transistor when zoomed in.
      const ROW_PITCH = DEC_PITCH;   // decoded lines run straight across
      const COL_PITCH = 12;

      // One pulled-up bit line per column, buffered out through two
      // inverters. Two, not one: a transistor at a site pulls the line down
      // to store a 0, so the line already carries the true bit and a single
      // inverter would report every word complemented. The pair is not
      // decorative — the pull-up drives only weakly (a resistor loses to any
      // channel to ground, by design), and the buffer restores a full-
      // strength output, which is what a real part's output stage is for.
      const bit = [];
      for (let b = 0; b < width; b++) {
        bit[b] = m.net();
        const x = xArray + b * COL_PITCH;
        m.resistor(`RL${b}`, VDD, bit[b], x, -8, { vert: true });
        m.wire(bit[b], [x, -8], [x, 0]);
        const t = m.net();
        m.instantiate(Inverter, x, rows * ROW_PITCH + 4, { a: bit[b], y: t });
        m.instantiate(Inverter, x, rows * ROW_PITCH + 4 + GATE_H + 2,
          { a: t, y: m.port(`d${b}`) });
      }

      // the array: a transistor wherever the stored bit is 0
      for (let r = 0; r < rows; r++) {
        const word = words[r] ?? 0;
        const row = dec.nets[`r${r}`];
        const y = r * ROW_PITCH;
        m.wire(row, [xArray - 4, y], [xArray + (width - 1) * COL_PITCH, y]);
        for (let b = 0; b < width; b++) {
          if (((word >> b) & 1) === 0) {
            // present → pulls the bit line to ground when this row is high
            m.transistor(`Q${r}_${b}`, 'nmos', row, bit[b], VSS,
              xArray + b * COL_PITCH, y);
          }
          // absent → the site is empty silicon and the line stays pulled up
        }
      }
    },
  });
}
