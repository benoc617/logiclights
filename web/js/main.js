import { CIRCUITS, buildCircuit } from './circuits.js';
import { sel } from './picker.js';
import {
  buildPanel, updatePanel, showPanel, isPanelHidden, panelRect,
  onPanelToggle, onPanelInteract,
} from './io-panel.js';
import { Renderer } from './render.js';
import { RelaySound } from './sound.js';
import { initInfoPanel } from './info-panel.js';

const canvas = document.getElementById('view');
const renderer = new Renderer(canvas);
const sound = new RelaySound();

let circuit = null;
let cssW = 0, cssH = 0;

// The "more info" overlay. Initialised once; `load` hands it each circuit's
// catalogue entry so the panel always describes what is on the canvas.
const setInfoCircuit = initInfoPanel();

// ── controls ─────────────────────────────────────────────────────────────

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

// ── clock ────────────────────────────────────────────────────────────────
//
// Only circuits that declare a clock get these controls. The clock is an
// ordinary switch being driven on a timer, so pausing it really is just
// nobody flipping the switch, and stepping by hand takes the identical
// path — a stepped machine and a running one cannot diverge.

const clockCtl = document.getElementById('clockctl');
const clkRun = document.getElementById('clk-run');
const clkStep = document.getElementById('clk-step');
const clkRate = document.getElementById('clk-rate');
const clkLabel = document.getElementById('clk-label');
let clkWasStalled = false;

function clockPeriod() {
  // slider 0..100 → 4 s .. 60 ms, log scale. Slow enough at the top to
  // watch a carry propagate between edges.
  return Math.round(4000 * Math.pow(60 / 4000, clkRate.value / 100));
}
function applyClockRate() {
  const p = clockPeriod();
  if (circuit && circuit.clock) circuit.clock.period = p;
  clkLabel.textContent = p >= 1000 ? `${(p / 1000).toFixed(1)} s` : `${p} ms`;
}
function setRunning(on) {
  if (!circuit || !circuit.clock) return;
  circuit.clock.running = on;
  circuit.clock.nextAt = performance.now() + circuit.clock.period / 2;
  clkRun.textContent = on ? '⏸' : '▶';
  clkRun.classList.toggle('on', on);
  // stepping by hand only makes sense while paused
  clkStep.disabled = on;
}
clkRun.addEventListener('click', () => {
  if (circuit && circuit.clock) setRunning(!circuit.clock.running);
});
clkStep.addEventListener('click', () => {
  if (!circuit || !circuit.clock || circuit.clock.running) return;
  circuit.stepClock();
  sound.ensure();
});
clkRate.addEventListener('input', applyClockRate);

// keyboard: space runs/pauses, right arrow steps — the controls you reach
// for without looking when watching a machine
document.addEventListener('keydown', ev => {
  if (!circuit || !circuit.clock) return;
  if (ev.target.tagName === 'INPUT') return;
  if (ev.code === 'Space') {
    ev.preventDefault();
    setRunning(!circuit.clock.running);
  } else if (ev.code === 'ArrowRight' && !circuit.clock.running) {
    ev.preventDefault();
    circuit.stepClock();
  }
});

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
  // The status row is one glanceable line: what this is, and what it cost
  // to build. Everything longer is behind "more info".
  const entry = CIRCUITS.find(e => e.id === id);
  document.getElementById('desc').textContent = entry.title ?? '';
  document.getElementById('stats').textContent =
    `${entry.name} — ${statsText(circuit.counts())}`;
  setInfoCircuit(entry);
  clockCtl.hidden = !circuit.clock;
  if (circuit.clock) { applyClockRate(); setRunning(false); }
  buildPanel(circuit);  // sized before fitting — the panel's width is an inset
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


// How much of the canvas the I/O panel covers, so fitting can avoid it:
// docked right on wide screens, along the bottom on narrow ones.
function panelInset() {
  if (isPanelHidden()) return { right: 0, bottom: 0 };
  const p = panelRect();
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

// the panel refits the canvas when shown or hidden, and unlocks audio when
// a bit cell is tapped — both without importing the renderer or the sound
onPanelToggle(() => { if (circuit) fitView(); });
onPanelInteract(() => sound.ensure());

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
  if (circuit.clock) {
    circuit.tickClock(now);
    // Say so when the clock is waiting for the circuit rather than for the
    // slider. Otherwise a machine running slower than the period asks for
    // looks broken, when in fact it is doing the only correct thing: a
    // synchronous machine clocked before its logic settles latches
    // half-propagated values.
    const stalled = !!circuit.clock.stalled && circuit.clock.running;
    if (stalled !== clkWasStalled) {
      clkWasStalled = stalled;
      clkRun.classList.toggle('waiting', stalled);
      clkLabel.textContent = stalled
        ? 'waiting…'
        : (circuit.clock.period >= 1000
            ? `${(circuit.clock.period / 1000).toFixed(1)} s`
            : `${circuit.clock.period} ms`);
    }
  }
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
