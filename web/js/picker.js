// The circuit picker: a real nested menu.
//
// A native <select> cannot nest — optgroups do not contain optgroups — so a
// two-level menu could only be faked with indented labels, and a heading
// then looked exactly like the items beneath it. At forty-odd circuits
// across four technologies that read as one undifferentiated list.
//
// So this is a custom widget: collapsed technology sections that expand to
// show their subsections and circuits. It deliberately exposes the small
// surface main.js used from the <select> it replaced — a readable and
// assignable `.value`, and a 'change' listener — so the rest of the app is
// unaware it is not a native control.

import { CIRCUITS, GROUP_ORDER } from './circuits.js';

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

export const sel = {
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
