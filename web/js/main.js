import { CIRCUITS, GROUP_ORDER, buildCircuit } from './circuits.js';
import { deriveBuses, busValue } from './buses.js';
import { VALUE_CHAR } from './engine.js';
import { Renderer } from './render.js';
import { RelaySound } from './sound.js';

const canvas = document.getElementById('view');
const renderer = new Renderer(canvas);
const sound = new RelaySound();

let circuit = null;
let cssW = 0, cssH = 0;

// ── controls ─────────────────────────────────────────────────────────────

// The circuit picker.
//
// A native <select> cannot nest: optgroups do not contain optgroups, so a
// two-level menu can only be faked with indented labels, and a heading then
// looks exactly like the items beneath it. With four technologies each
// having several subsections that reads as one long undifferentiated list,
// so this is a real nested menu — collapsed technology sections that expand
// to show their subsections and circuits.
//
// It keeps the small surface the rest of this file used from the <select>:
// a readable and assignable `.value`, and a 'change' listener.
const pickerEl = document.getElementById('picker');
const pickerBtn = document.getElementById('picker-btn');
const pickerLabel = document.getElementById('picker-label');
const pickerMenu = document.getElementById('picker-menu');

const sel = {
  _value: null,
  get value() { return this._value; },
  set value(id) {
    if (this._value === id) return;
    this._value = id;
    const entry = CIRCUITS.find(e => e.id === id);
    pickerLabel.textContent = entry ? entry.name : '\u2026';
    for (const node of pickerMenu.querySelectorAll('.pick-item')) {
      node.classList.toggle('on', node.dataset.id === id);
    }
  },
  _handlers: [],
  addEventListener(_type, fn) { this._handlers.push(fn); },
  _emit() { for (const fn of this._handlers) fn(); },
};

// GROUP_ORDER drives the section order, so the registry array can stay in
// whatever order reads best. Anything in a group the list forgot still
// shows up, appended at the end rather than silently dropped.
{
  const order = [...GROUP_ORDER, ...CIRCUITS.map(e => e.group)];
  const seen = new Set();
  const sections = new Map();   // technology -> [{ sub, entries }]
  for (const g of order) {
    if (seen.has(g) || !CIRCUITS.some(e => e.group === g)) continue;
    seen.add(g);
    const [section, sub] = g.split(' \u00b7 ');
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section).push({ sub, entries: CIRCUITS.filter(e => e.group === g) });
  }

  for (const [section, subs] of sections) {
    const box = document.createElement('div');
    box.className = 'pick-section';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'pick-head';
    const caret = document.createElement('span');
    caret.className = 'pick-caret';
    caret.textContent = '\u25b8';
    const title = document.createElement('span');
    title.textContent = section;
    head.append(caret, title);
    const count = document.createElement('span');
    count.className = 'pick-count';
    count.textContent = subs.reduce((n, s) => n + s.entries.length, 0);
    head.appendChild(count);

    const body = document.createElement('div');
    body.className = 'pick-body';
    head.addEventListener('click', () => {
      const open = box.classList.toggle('open');
      caret.textContent = open ? '\u25be' : '\u25b8';
    });
    box.appendChild(head);

    for (const { sub, entries } of subs) {
      // "General" has no subsections; its circuits hang off the section
      if (sub) {
        const label = document.createElement('div');
        label.className = 'pick-sub';
        label.textContent = sub;
        body.appendChild(label);
      }
      for (const e of entries) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'pick-item' + (sub ? '' : ' flush');
        item.textContent = e.name;
        item.dataset.id = e.id;
        item.addEventListener('click', () => {
          sel.value = e.id;
          sel._emit();
          closePicker();
        });
        body.appendChild(item);
      }
    }
    box.appendChild(body);
    pickerMenu.appendChild(box);
  }
}

function openPicker() {
  pickerMenu.hidden = false;
  pickerBtn.setAttribute('aria-expanded', 'true');
  // Reveal the section holding the current circuit, so the menu opens
  // showing where you already are rather than fully collapsed.
  const on = pickerMenu.querySelector('.pick-item.on');
  if (on) {
    const box = on.closest('.pick-section');
    if (box && !box.classList.contains('open')) {
      box.classList.add('open');
      box.querySelector('.pick-caret').textContent = '\u25be';
    }
    // Scroll the open *section* into view, not the item: scrolling to the
    // item alone pushes the section headers off the top, which hides the
    // structure the menu exists to show.
    if (box) box.scrollIntoView({ block: 'nearest' });
  } else {
    pickerMenu.scrollTop = 0;
  }
}
function closePicker() {
  pickerMenu.hidden = true;
  pickerBtn.setAttribute('aria-expanded', 'false');
}
pickerBtn.addEventListener('click', () => {
  if (pickerMenu.hidden) openPicker(); else closePicker();
});
document.addEventListener('pointerdown', ev => {
  if (!pickerEl.contains(ev.target)) closePicker();
});
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape') closePicker();
});

const speed = document.getElementById('speed');
const speedLabel = document.getElementById('speed-label');
function currentDelay() {
  // slider 0..100 -> 1000ms .. 30ms, log scale
  return Math.round(1000 * Math.pow(30 / 1000, speed.value / 100));
}
function applySpeed() {
  const d = currentDelay();
  if (circuit) circuit.baseDelay = d;
  speedLabel.textContent = `${d} ms`;
}
speed.addEventListener('input', applySpeed);

const soundBtn = document.getElementById('sound');
soundBtn.addEventListener('click', () => {
  sound.enabled = !sound.enabled;
  soundBtn.textContent = sound.enabled ? '🔊' : '🔇';
  if (sound.enabled) sound.ensure();
});

document.getElementById('reset').addEventListener('click', () => load(sel.value));
document.getElementById('fit').addEventListener('click', () => fitView());
document.getElementById('zin').addEventListener('click', () => renderer.zoomAt(cssW / 2, cssH / 2, 1.45));
document.getElementById('zout').addEventListener('click', () => renderer.zoomAt(cssW / 2, cssH / 2, 1 / 1.45));

sel.addEventListener('change', () => load(sel.value));

// deep links / back button: /#add4 selects the circuit
window.addEventListener('hashchange', () => {
  try {
    const id = location.hash.slice(1);
    if (id !== sel.value && CIRCUITS.some(e => e.id === id)) load(id);
  } catch { /* opaque origin */ }
});

function load(id) {
  if (sel.value !== id) sel.value = id;
  circuit = buildCircuit(id);
  circuit.baseDelay = currentDelay();
  circuit.step(performance.now());
  document.getElementById('desc').textContent = circuit.desc;
  document.getElementById('stats').textContent = statsText(circuit.counts());
  buildPanel();      // sized before fitting — the panel's width is an inset
  fitView();
  // sandboxed viewers (opaque origins) can refuse URL writes — never fatal
  try { history.replaceState(null, '', '#' + id); } catch { /* ignore */ }
}

// Only name the devices a circuit actually contains, so a relay rack still
// reads "24 relays · 88 contacts" and doesn't grow a pile of zeroes.
function statsText(n) {
  const parts = [];
  const add = (v, one, many) => { if (v) parts.push(`${v} ${v === 1 ? one : many}`); };
  add(n.relays, 'relay', 'relays');
  add(n.contacts, 'contact', 'contacts');
  add(n.transistors, 'transistor', 'transistors');
  add(n.diodes, 'diode', 'diodes');
  add(n.resistors, 'resistor', 'resistors');
  return parts.join(' · ');
}

// ── binary I/O table ─────────────────────────────────────────────────────

const panel = document.getElementById('panel');
const panelBody = document.getElementById('panel-body');
const panelToggle = document.getElementById('panel-toggle');
let rows = [];
let readoutEl = null;
let tableRows = null;     // selector-legend rows, if the circuit has a table
let legendSelect = null;  // picks the live row index from the bus values
let stateCells = null;    // live internal-state cells, if the circuit has any
let stateRead = null;     // reads that state off the circuit each frame

// How much of the canvas the I/O panel covers, so fitting can avoid it:
// docked right on wide screens, along the bottom on narrow ones.
function panelInset() {
  if (panel.classList.contains('hidden')) return { right: 0, bottom: 0 };
  const p = panel.getBoundingClientRect();
  const m = canvas.getBoundingClientRect();
  if (!p.width || !m.width) return { right: 0, bottom: 0 };
  return p.left - m.left > m.width / 2
    ? { right: m.right - p.left + 12, bottom: 0 }
    : { right: 0, bottom: m.bottom - p.top + 12 };
}

function fitView() {
  renderer.fit(circuit, cssW, cssH, panelInset());
  lastFit = { w: cssW, h: cssH };
}

function showPanel(on) {
  panel.classList.toggle('hidden', !on);
  panelToggle.classList.toggle('active', on);
  if (circuit) fitView();
}
panelToggle.addEventListener('click', () => showPanel(panel.classList.contains('hidden')));
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
        cell.addEventListener('click', () => { sw.on = !sw.on; sound.ensure(); });
      } else {
        // momentary contacts: held only while the bit is pressed
        const press = ev => { ev.preventDefault(); sw.on = true; sound.ensure(); };
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
      sound.ensure();
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

function buildPanel() {
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

  // Live internal state. A register file's stored words are invisible
  // otherwise — the read port shows one at a time, so you would have to
  // walk RA through all sixteen addresses to learn what the file holds.
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

function updatePanel() {
  if (panel.classList.contains('hidden')) return;
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

// ── canvas sizing ────────────────────────────────────────────────────────

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  cssW = rect.width;
  cssH = rect.height;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  renderer.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
// Rotating the device (or any big viewport change) refits; small changes —
// a mobile URL bar sliding away, the footer rewrapping — must not throw
// away the zoom and pan the user set up.
let lastFit = { w: 0, h: 0 };
function onViewportChange() {
  resize();
  if (!circuit) return;
  const dw = Math.abs(cssW - lastFit.w) / Math.max(1, lastFit.w);
  const dh = Math.abs(cssH - lastFit.h) / Math.max(1, lastFit.h);
  if (dw > 0.15 || dh > 0.15) fitView();
}
window.addEventListener('resize', onViewportChange);
window.addEventListener('orientationchange', onViewportChange);
new ResizeObserver(onViewportChange).observe(canvas.parentElement);

// ── pointer interaction: tap switches, drag to pan, pinch/wheel to zoom ──

const pointers = new Map(); // pointerId -> {x, y}
const heldSwitches = new Map(); // pointerId -> momentary switch
let pinchDist = 0;

function hitSwitch(px, py) {
  const [wx, wy] = renderer.toWorld(px, py);
  const r = Math.max(1.6, 14 / renderer.view.scale); // generous touch target
  let best = null, bestD = r;
  for (const s of circuit.switches) {
    const d = Math.hypot(s.x - wx, s.y - wy);
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

canvas.addEventListener('pointerdown', ev => {
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.offsetX, y: ev.offsetY, moved: false });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
  sound.ensure(); // unlock audio on first gesture
  const s = pointers.size === 1 ? hitSwitch(ev.offsetX, ev.offsetY) : null;
  if (s) {
    if (s.kind === 'toggle') s.on = !s.on;
    else { s.on = true; heldSwitches.set(ev.pointerId, s); }
  }
});

canvas.addEventListener('pointermove', ev => {
  const p = pointers.get(ev.pointerId);
  if (!p) return;
  const dx = ev.offsetX - p.x, dy = ev.offsetY - p.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) p.moved = true;
  if (pointers.size === 1 && !heldSwitches.has(ev.pointerId)) {
    renderer.view.x += dx;
    renderer.view.y += dy;
  }
  p.x = ev.offsetX; p.y = ev.offsetY;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) {
      renderer.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
    }
    pinchDist = d;
  }
});

function pointerEnd(ev) {
  const s = heldSwitches.get(ev.pointerId);
  if (s) { s.on = false; heldSwitches.delete(ev.pointerId); }
  pointers.delete(ev.pointerId);
  pinchDist = 0;
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);

canvas.addEventListener('wheel', ev => {
  ev.preventDefault();
  renderer.zoomAt(ev.offsetX, ev.offsetY, Math.pow(1.0015, -ev.deltaY));
}, { passive: false });

// ── main loop ────────────────────────────────────────────────────────────

function frame(now) {
  const clicks = circuit.step(now);
  if (clicks) sound.clicks(clicks);
  if (circuit.switchings) sound.zaps(circuit.switchings);
  renderer.draw(circuit, now, cssW, cssH);
  updatePanel();
  requestAnimationFrame(frame);
}

// debug/testing hook
window.__ll = { get circuit() { return circuit; }, renderer, load };

resize();
applySpeed();
let startId = 'relay101';
try {
  const h = location.hash.slice(1);
  if (CIRCUITS.some(e => e.id === h)) startId = h;
} catch { /* ignore */ }
load(startId);
requestAnimationFrame(frame);
