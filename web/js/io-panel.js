// The binary I/O table.
//
// Every input switch is grouped into a named bus (A, B, Cin …) you can drive
// by tapping bits or typing binary, rather than hunting for switches on the
// canvas; outputs and declared internal buses read back live. On top of that
// sit the three guides a big circuit needs to be legible at all: a caption
// per bus, a legend of selector codes with the live row highlighted, and a
// grid of internal state the circuit's own outputs do not expose.
//
// The panel owns its DOM and nothing else. It is told which circuit to show
// (`buildPanel`) and asked to refresh (`updatePanel`); it never reaches for
// the renderer or the simulation loop.

import { deriveBuses, busValue } from './buses.js';
import { VALUE_CHAR } from './engine.js';
import { disassembleProgram } from './decode.js';

const panel = document.getElementById('panel');
const panelBody = document.getElementById('panel-body');
const panelToggle = document.getElementById('panel-toggle');

let circuit = null;       // the circuit being displayed
let rows = [];
let readoutEl = null;
let tableRows = null;     // selector-legend rows, if the circuit has a table
let legendSelect = null;  // picks the live row index from the bus values
let stateCells = null;    // live internal-state cells, if the circuit has any
let stateRead = null;     // reads that state off the circuit each frame
let regCells = null;      // the index registers, one line, for machines
let progRows = null;      // program listing rows, for machines that run one

// Called by main when the panel is shown or hidden, so the canvas can refit
// around it. Set once at startup.
let onVisibilityChange = () => {};
export function onPanelToggle(fn) { onVisibilityChange = fn; }

// Browsers only allow audio to start from a user gesture, and flipping a
// bit in this table is one — so the panel reports interaction rather than
// reaching for the sound module itself.
let onInteract = () => {};
export function onPanelInteract(fn) { onInteract = fn; }

export function isPanelHidden() { return panel.classList.contains('hidden'); }
export function panelRect() { return panel.getBoundingClientRect(); }

export function showPanel(on) {
  panel.classList.toggle('hidden', !on);
  panelToggle.classList.toggle('active', on);
  onVisibilityChange();
}
panelToggle.addEventListener('click', () => showPanel(isPanelHidden()));
document.getElementById('panel-close').addEventListener('click', () => showPanel(false));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setBusValue(bus, v) {
  bus.bits.forEach((b, pos) => { b.sw.on = !!(v & (1 << pos)); });
}

function makeRow(bus, editable, readBit, charOf, hint) {
  const row = el('div', `bus ${editable ? 'io-in' : 'io-out'}`);
  const name = el('span', 'bus-name', bus.name);
  // A bus name is not self-explanatory on the bigger circuits — "WA" and
  // "F" mean nothing without a caption. The hint rides along as a tooltip
  // and is also drawn under the row.
  if (hint) name.title = hint;
  row.appendChild(name);

  const bitsEl = el('div', 'bits');
  const cells = [];
  for (let pos = bus.bits.length - 1; pos >= 0; pos--) {   // MSB on the left
    const bit = bus.bits[pos];
    const cell = el(editable ? 'button' : 'span', 'bit', '0');
    if (editable) {
      cell.type = 'button';
      const sw = bit.sw;
      if (sw.kind === 'toggle') {
        cell.addEventListener('click', () => { sw.on = !sw.on; onInteract(); });
      } else {
        // momentary contacts: held only while the bit is pressed
        const press = ev => { ev.preventDefault(); sw.on = true; onInteract(); };
        const release = () => { sw.on = false; };
        cell.addEventListener('pointerdown', press);
        cell.addEventListener('pointerup', release);
        cell.addEventListener('pointerleave', release);
        cell.addEventListener('pointercancel', release);
      }
    }
    bitsEl.appendChild(cell);
    cells.push({ el: cell, bit, state: null });
  }
  row.appendChild(bitsEl);

  const width = bus.bits.length;
  const bin = el(editable ? 'input' : 'span', 'bin');
  if (editable) {
    bin.type = 'text';
    bin.size = width;
    bin.style.width = `calc(${width}ch + 22px)`;  // + padding, borders, caret
    bin.inputMode = 'numeric';
    bin.spellcheck = false;
    bin.title = `Type ${width} binary digit${width === 1 ? '' : 's'}`;
    bin.addEventListener('input', () => {
      const clean = bin.value.replace(/[^01]/g, '').slice(-width);
      if (clean !== bin.value) bin.value = clean;
      setBusValue(bus, clean === '' ? 0 : parseInt(clean, 2));
      onInteract();
    });
    bin.addEventListener('blur', () => { bin.value = pad(busValue(bus, readBit), width); });
  }
  row.appendChild(bin);

  row.appendChild(el('span', 'eq', '='));
  const dec = el('span', 'dec', '0');
  row.appendChild(dec);

  rows.push({ bus, cells, bin, dec, editable, readBit, charOf, width, shown: null });
  if (!hint) return row;
  // wrap so the caption sits under its row rather than beside it
  const wrap = el('div', 'bus-wrap');
  wrap.appendChild(row);
  wrap.appendChild(el('div', 'bus-hint', hint));
  return wrap;
}

function pad(v, width) {
  return v.toString(2).padStart(width, '0');
}

export function buildPanel(c) {
  circuit = c;
  const buses = deriveBuses(circuit);
  rows = [];
  readoutEl = null;
  panelBody.innerHTML = '';

  const hotBit = b => circuit.hot[b.net];
  const swBit = b => b.sw.on;
  const netChar = b => VALUE_CHAR[circuit.value[b.net]];
  const swChar = b => (b.sw.on ? '1' : '0');

  const hints = circuit.hints || {};
  const section = (title, list, editable, readBit, charOf) => {
    if (!list.length) return;
    panelBody.appendChild(el('div', 'sec-title', title));
    for (const bus of list) {
      panelBody.appendChild(makeRow(bus, editable, readBit, charOf, hints[bus.name]));
    }
  };
  section('Inputs', buses.inputs, true, swBit, swChar);
  section('Outputs', buses.outputs, false, hotBit, netChar);
  section('Internal', buses.internals, false, hotBit, netChar);

  if (circuit.readout) {
    readoutEl = el('div', 'readout', '');
    panelBody.appendChild(readoutEl);
  }

  // The program listing, for machines that run one. Watching a CPU without
  // being able to read its program is like watching a debugger with the
  // source hidden — you can see the machine work but not what it is
  // working on. The disassembly comes from the same opcode table the
  // hardware decoder uses, so a listing and the lit decoder line can never
  // disagree.
  progRows = null;
  if (circuit.program) {
    panelBody.appendChild(el('div', 'sec-title', 'Program'));
    const box = el('div', 'prog');
    progRows = disassembleProgram(circuit.program).map(r => {
      const row = el('div', 'prog-row');
      row.appendChild(el('span', 'prog-addr', String(r.addr)));
      row.appendChild(el('span', 'prog-byte',
        r.byte.toString(16).toUpperCase().padStart(2, '0')));
      const text = el('span', 'prog-text', r.text);
      // An address that is the operand of the instruction above it is not
      // an instruction, however it disassembles — but the machine can jump
      // into one, so it is shown greyed rather than hidden.
      if (r.isOperand) text.classList.add('operand');
      row.appendChild(text);
      box.appendChild(row);
      return { el: row, addr: r.addr, on: null };
    });
    panelBody.appendChild(box);
  }

  // A selector legend, for circuits where an input is a code rather than a
  // number: the ALU's F is the case that makes the circuit unusable without
  // one. Rows highlight live as the selected code changes, so the table
  // doubles as an indicator of what the machine is currently doing.
  tableRows = null;
  if (circuit.table) {
    const t = circuit.table;
    panelBody.appendChild(el('div', 'sec-title', t.title));
    const box = el('div', 'legend');
    tableRows = t.rows.map((r, i) => {
      const row = el('div', 'legend-row');
      row.appendChild(el('span', 'legend-code', r.code));
      row.appendChild(el('span', 'legend-name', r.name));
      if (r.note) row.appendChild(el('span', 'legend-note', r.note));
      box.appendChild(row);
      return { el: row, index: i, on: null };
    });
    panelBody.appendChild(box);
    legendSelect = t.select;
  }

  // The index registers, on one line.
  //
  // A register file's stored words are invisible from outside: the read
  // port shows one at a time, so without this you would have to walk the
  // read address through all sixteen to learn what the file holds. Every
  // machine with a register file gets the same line, in the same place,
  // reading the same way — following a program means watching these
  // numbers, and having to look somewhere different on each machine is
  // what makes that hard.
  //
  // A never-written cell is genuinely floating, and says so with a dash
  // rather than a zero: "unknown" and "zero" are different claims, and on
  // a machine that has only just been reset most of the file is the first.
  // Eight columns, two rows — which is one column per register PAIR, not
  // an arbitrary fold to fit the panel. Pairs are architectural on the
  // 4004: FIM loads one, SRC sends one to the memory bus, FIN reads ROM
  // through one and JIN jumps through one, always r0:r1, r2:r3 and so on
  // with the even register holding the high nibble. Stacking r0 above r1
  // puts each pair in a column, so an eight-bit quantity reads down rather
  // than being scattered across a square.
  //
  // Skipped when the circuit's own state grid is already the registers —
  // the standalone register file's grid IS the circuit, showing each word
  // with the addressed row highlighted, and a second copy of the same
  // sixteen numbers above it would be noise.
  regCells = null;
  const stateIsRegisters = circuit.state
    && /^register/i.test(circuit.state.title);
  if (circuit.cells && circuit.cells.length && !stateIsRegisters) {
    panelBody.appendChild(el('div', 'sec-title', 'Registers'));
    const grid = el('div', 'reg-grid');
    // Column-major: r0 and r1 share a column, then r2 and r3, and so on.
    const order = [];
    for (let half = 0; half < 2; half++) {
      for (let i = half; i < circuit.cells.length; i += 2) order.push(i);
    }
    regCells = order.map(i => {
      const cell = el('div', 'reg-cell');
      cell.appendChild(el('span', 'reg-label', `r${i}`));
      const val = el('span', 'reg-val', '\u2013');
      cell.appendChild(val);
      grid.appendChild(cell);
      return { nets: circuit.cells[i], val, shown: null };
    });
    panelBody.appendChild(grid);
  }

  // Live internal state, for circuits that declare a state grid.
  stateCells = null;
  if (circuit.state) {
    const st = circuit.state;
    panelBody.appendChild(el('div', 'sec-title', st.title));
    const grid = el('div', 'state-grid');
    grid.style.gridTemplateColumns = `repeat(${st.columns || 4}, 1fr)`;
    const initial = st.read(circuit, {});
    stateCells = initial.map(item => {
      const cell = el('div', 'state-cell');
      cell.appendChild(el('span', 'state-label', item.label));
      const val = el('span', 'state-val', item.text);
      cell.appendChild(val);
      grid.appendChild(cell);
      return { cell, val, shown: null, mark: null };
    });
    panelBody.appendChild(grid);
    if (st.key) panelBody.appendChild(el('div', 'state-key', st.key));
    stateRead = st.read;
  }
  updatePanel();
}

export function updatePanel() {
  if (!circuit) return;
  if (isPanelHidden()) return;

  if (regCells) {
    for (const r of regCells) {
      let n = 0, settled = true;
      // cells are LSB-first; a single unsettled bit makes the word unknown
      for (let b = r.nets.length - 1; b >= 0; b--) {
        const ch = VALUE_CHAR[circuit.value[r.nets[b]]];
        if (ch === '1') n = n * 2 + 1;
        else if (ch === '0') n *= 2;
        else { settled = false; break; }
      }
      const text = settled ? String(n) : '\u2013';
      if (r.shown !== text) {
        r.shown = text;
        r.val.textContent = text;
        r.val.classList.toggle('unset', !settled);
      }
    }
  }
  const vals = {};
  for (const r of rows) {
    let bits = '';                       // cells are stored MSB-first
    for (const c of r.cells) {
      const ch = r.charOf(c.bit);
      if (c.state !== ch) {
        c.state = ch;
        c.el.textContent = ch;
        c.el.classList.toggle('on', ch === '1');
        c.el.classList.toggle('bad', ch === 'X');
        c.el.classList.toggle('float', ch === 'Z');
      }
      bits += ch;
    }
    const v = busValue(r.bus, r.readBit);
    vals[r.bus.name] = v;
    if (r.shown !== bits) {
      r.shown = bits;
      // a bus with a floating or contended bit has no numeric value
      r.dec.textContent = /[XZ]/.test(bits) ? '—' : String(v);
      if (r.editable) {
        if (document.activeElement !== r.bin) r.bin.value = pad(v, r.width);
      } else {
        r.bin.textContent = bits;
      }
    }
  }
  if (readoutEl) {
    const text = circuit.readout(vals);
    if (readoutEl.textContent !== text) readoutEl.textContent = text;
  }
  if (tableRows) {
    // -1 when the code selects nothing, so no row lights
    const live = legendSelect(vals);
    for (const r of tableRows) {
      const on = r.index === live;
      if (r.on !== on) { r.on = on; r.el.classList.toggle('live', on); }
    }
  }
  if (progRows) {
    // Highlight the instruction that is *executing*, not the one being
    // fetched. Those differ by a cycle and it matters: the PC advances
    // during FETCH, so by the time you see LDM 3 land in the accumulator
    // the counter has already moved to the next line. Highlighting the PC
    // marks the wrong instruction as responsible for what you just watched
    // happen.
    //
    // The instruction register holds what is running, so the executing
    // address is the one the register's contents came from. Machines that
    // publish `execAddr` say so directly; otherwise fall back to the byte
    // before the PC, which is where a one-byte instruction came from.
    const exec = circuit.execAddr
      ? circuit.execAddr()
      : (vals.PC === undefined ? -1
         : (vals.PC - 1 + progRows.length) % progRows.length);
    for (const r of progRows) {
      const on = r.addr === exec;
      if (r.on !== on) { r.on = on; r.el.classList.toggle('at', on); }
    }
  }
  if (stateCells) {
    const items = stateRead(circuit, vals);
    for (let i = 0; i < stateCells.length; i++) {
      const c = stateCells[i], item = items[i];
      if (c.shown !== item.text) {
        c.shown = item.text;
        c.val.textContent = item.text;
        // a value that never settled is worth flagging, however it is
        // spelled — 'Z', 'X', or a dash standing in for a floating word
        c.val.classList.toggle('bad', /[XZ]/.test(item.text) || item.text === '–');
      }
      if (c.mark !== item.mark) {
        c.mark = item.mark;
        c.cell.classList.toggle('is-read', item.mark === 'read');
        c.cell.classList.toggle('is-write', item.mark === 'write');
      }
    }
  }
}
