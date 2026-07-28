// The "more info" overlay: what a circuit is, what its program does line by
// line, and how it is built.
//
// The status row under the canvas is deliberately one line — name, subtitle
// and device count — because it is glanceable and a reader should not have
// to scroll a footer. Everything longer lives here, behind a click, split
// into the two things a reader actually wants at different moments: the
// story of a run, and the construction behind it.

const el = id => document.getElementById(id);

// Prose in the catalogue is plain text with blank-line paragraph breaks.
// Rendering it as textContent per paragraph keeps it un-HTML — the
// catalogue is data, and data that can inject markup is a liability.
function renderProse(target, text) {
  target.replaceChildren();
  for (const para of String(text ?? '').split('\n\n')) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const p = document.createElement('p');
    p.textContent = trimmed;
    target.appendChild(p);
  }
}

// One row per instruction: where it is in the ROM, what it is, what the
// machine looked like afterwards, and why that matters.
function renderWalkthrough(target, walk) {
  target.replaceChildren();
  if (walk.intro) {
    const intro = document.createElement('p');
    intro.className = 'wt-intro';
    intro.textContent = walk.intro;
    target.appendChild(intro);
  }

  const list = document.createElement('ol');
  list.className = 'wt-steps';
  for (const step of walk.steps) {
    const li = document.createElement('li');

    const head = document.createElement('div');
    head.className = 'wt-head';

    const at = document.createElement('span');
    at.className = 'wt-at';
    at.textContent = String(step.at);
    at.title = `ROM address ${step.at}`;
    head.appendChild(at);

    const op = document.createElement('code');
    op.className = 'wt-op';
    op.textContent = step.op;
    head.appendChild(op);

    for (const [key, value] of Object.entries(step.state ?? {})) {
      const chip = document.createElement('span');
      chip.className = 'wt-state';
      const k = document.createElement('span');
      k.className = 'wt-key';
      k.textContent = key;
      const v = document.createElement('span');
      v.className = 'wt-val';
      v.textContent = value;
      chip.append(k, v);
      head.appendChild(chip);
    }
    li.appendChild(head);

    const text = document.createElement('p');
    text.className = 'wt-text';
    text.textContent = step.text;
    li.appendChild(text);

    list.appendChild(li);
  }
  target.appendChild(list);

  if (walk.outro) {
    const outro = document.createElement('p');
    outro.className = 'wt-outro';
    outro.textContent = walk.outro;
    target.appendChild(outro);
  }
}

export function initInfoPanel() {
  const overlay = el('info');
  const openBtn = el('info-open');
  const closeBtn = el('info-close');
  const tabs = [...el('info-tabs').querySelectorAll('[role="tab"]')];
  const panes = {
    walkthrough: el('pane-walkthrough'),
    engineering: el('pane-engineering'),
  };
  let entry = null;
  let lastFocus = null;

  function showTab(which) {
    for (const tab of tabs) {
      const on = tab.dataset.tab === which;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
    }
    for (const [name, pane] of Object.entries(panes)) {
      pane.hidden = name !== which;
    }
    el('info').querySelector('.info-body').scrollTop = 0;
  }

  function open() {
    if (!entry) return;
    lastFocus = document.activeElement;
    overlay.hidden = false;
    // A circuit with no program has nothing to walk through, so the tab
    // strip collapses to a single pane rather than offering an empty one.
    const hasWalk = !!entry.walkthrough;
    el('tab-walkthrough').hidden = !hasWalk;
    el('info-tabs').classList.toggle('single', !hasWalk);
    showTab(hasWalk ? 'walkthrough' : 'engineering');
    closeBtn.focus();
  }

  function close() {
    overlay.hidden = true;
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
  }

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  // Clicking the backdrop closes; clicking inside the box must not.
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hidden) { close(); e.preventDefault(); }
  });
  for (const tab of tabs) {
    tab.addEventListener('click', () => showTab(tab.dataset.tab));
  }

  // Called on every circuit load, so the overlay always describes what is
  // on the canvas even if it is left open across a change.
  return function setCircuit(next) {
    entry = next;
    el('info-name').textContent = next.name;
    el('info-title').textContent = next.title ?? '';
    el('info-brief').textContent = next.brief ?? '';
    renderProse(panes.engineering, next.desc);
    if (next.walkthrough) {
      renderWalkthrough(panes.walkthrough, next.walkthrough);
    } else {
      panes.walkthrough.replaceChildren();
    }
    if (!overlay.hidden) open();
  };
}
