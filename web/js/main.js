import { CIRCUITS, buildCircuit } from './circuits.js';
import { deriveBuses, busValue } from './buses.js';
import { Renderer } from './render.js';
import { RelaySound } from './sound.js';

const canvas = document.getElementById('view');
const renderer = new Renderer(canvas);
const sound = new RelaySound();

let circuit = null;
let cssW = 0, cssH = 0;

// ── controls ─────────────────────────────────────────────────────────────

const sel = document.getElementById('circuit');
const groups = {};
for (const e of CIRCUITS) {
  if (!groups[e.group]) {
    groups[e.group] = document.createElement('optgroup');
    groups[e.group].label = e.group;
    sel.appendChild(groups[e.group]);
  }
  const opt = document.createElement('option');
  opt.value = e.id;
  opt.textContent = e.name;
  groups[e.group].appendChild(opt);
}

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
  const nContacts = circuit.relays.reduce((n, r) => n + r.contacts.length, 0);
  document.getElementById('stats').textContent =
    `${circuit.relays.length} relay${circuit.relays.length === 1 ? '' : 's'} · ${nContacts} contacts`;
  buildPanel();      // sized before fitting — the panel's width is an inset
  fitView();
  // sandboxed viewers (opaque origins) can refuse URL writes — never fatal
  try { history.replaceState(null, '', '#' + id); } catch { /* ignore */ }
}

// ── binary I/O table ─────────────────────────────────────────────────────

const panel = document.getElementById('panel');
const panelBody = document.getElementById('panel-body');
const panelToggle = document.getElementById('panel-toggle');
let rows = [];
let readoutEl = null;

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

function makeRow(bus, editable, readBit) {
  const row = el('div', `bus ${editable ? 'io-in' : 'io-out'}`);
  row.appendChild(el('span', 'bus-name', bus.name));

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

  rows.push({ bus, cells, bin, dec, editable, readBit, width, value: null });
  return row;
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

  const section = (title, list, editable, readBit) => {
    if (!list.length) return;
    panelBody.appendChild(el('div', 'sec-title', title));
    for (const bus of list) panelBody.appendChild(makeRow(bus, editable, readBit));
  };
  section('Inputs', buses.inputs, true, swBit);
  section('Outputs', buses.outputs, false, hotBit);
  section('Internal', buses.internals, false, hotBit);

  if (circuit.readout) {
    readoutEl = el('div', 'readout', '');
    panelBody.appendChild(readoutEl);
  }
  updatePanel();
}

function updatePanel() {
  if (panel.classList.contains('hidden')) return;
  const vals = {};
  for (const r of rows) {
    for (const c of r.cells) {
      const on = r.readBit(c.bit);
      if (c.state !== on) {
        c.state = on;
        c.el.textContent = on ? '1' : '0';
        c.el.classList.toggle('on', on);
      }
    }
    const v = busValue(r.bus, r.readBit);
    vals[r.bus.name] = v;
    if (r.value !== v) {
      r.value = v;
      r.dec.textContent = String(v);
      const bits = pad(v, r.width);
      if (r.editable) {
        if (document.activeElement !== r.bin) r.bin.value = bits;
      } else {
        r.bin.textContent = bits;
      }
    }
  }
  if (readoutEl) {
    const text = circuit.readout(vals);
    if (readoutEl.textContent !== text) readoutEl.textContent = text;
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
