// Canvas renderer: pan/zoom viewport, glowing wires, animated devices.

import {
  RELAY_W, COIL_H, MOS_H, coilT, contactT, relayH,
  mosT, diodeT, resistorT, switchT, switchSpdtT,
} from './geometry.js';
import { LO, HI, X, Z } from './engine.js';

const BG = '#12141a';
const WIRE_OFF = '#3b4252';   // logic 0
const WIRE_HOT = '#ffb54d';   // logic 1
const WIRE_X = '#ff5347';     // contention — two sources fighting
const WIRE_Z = '#55618a';     // floating — nothing is driving it
const GLOW = 'rgba(255, 160, 40, 0.22)';
const GLOW_X = 'rgba(255, 70, 55, 0.26)';
const BODY = '#1c212e';
const BODY_EDGE = '#454e66';
const METAL = '#c7cfe0';
const TEXT = '#8b93a7';
const LAMP_ON = '#ffd67f';

// Longest device name still worth drawing. Hand-routed circuits use short
// deliberate names; composed machines generate instance tags that are both
// longer and meaningless, and drawing those is what makes a zoomed-in
// composed machine look like overlapping noise.
const NAME_MAX = 6;

const REGION_EDGE = 'rgba(120, 136, 178, 0.34)';
const REGION_FILL = 'rgba(86, 100, 140, 0.07)';
const REGION_TEXT = '#7f8ba8';

const WIRE_COL = [WIRE_OFF, WIRE_HOT, WIRE_X, WIRE_Z];
const DOT_COL = ['#59637e', WIRE_HOT, WIRE_X, '#4a5470'];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { x: 0, y: 0, scale: 24 }; // world origin offset (px) and px-per-unit
    this.minScale = 0.5;
    this.maxScale = 64;
  }

  toScreen(x, y) {
    return [x * this.view.scale + this.view.x, y * this.view.scale + this.view.y];
  }
  toWorld(px, py) {
    return [(px - this.view.x) / this.view.scale, (py - this.view.y) / this.view.scale];
  }

  // inset keeps the drawing clear of overlaying UI (the binary I/O panel)
  fit(circuit, wPx, hPx, inset = { right: 0, bottom: 0 }) {
    const b = circuit.bounds();
    const m = 2.5;
    const bw = b.x1 - b.x0 + m * 2, bh = b.y1 - b.y0 + m * 2;
    const availW = Math.max(80, wPx - inset.right);
    const availH = Math.max(80, hPx - inset.bottom);
    const s = Math.min(availW / bw, availH / bh, 40);
    this.view.scale = s;
    this.minScale = s * 0.4;
    this.view.x = (availW - (b.x1 + b.x0) * s) / 2;
    this.view.y = (availH - (b.y1 + b.y0) * s) / 2;
  }

  zoomAt(px, py, factor) {
    const s0 = this.view.scale;
    const s1 = Math.max(this.minScale, Math.min(this.maxScale, s0 * factor));
    this.view.x = px - (px - this.view.x) * (s1 / s0);
    this.view.y = py - (py - this.view.y) * (s1 / s0);
    this.view.scale = s1;
  }

  draw(c, now, wPx, hPx) {
    const ctx = this.ctx;
    const s = this.view.scale;
    ctx.save();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, wPx, hPx);
    ctx.translate(this.view.x, this.view.y);
    ctx.scale(s, s);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const val = c.value;
    const lod = s; // px per world unit

    // Region annotations go down first, behind the circuit, so they read as
    // zones rather than as more wiring. They matter most when zoomed out —
    // that is exactly when a composed machine turns into undifferentiated
    // texture — so unlike device labels they are drawn at every LOD, with
    // the caption held at a readable pixel size instead of scaling away.
    if (c.regions && c.regions.length) this.drawRegions(ctx, c, lod);

    // wires: glow pass for driven-high and contended nets, then core strokes
    // in one pass per logic value so the whole net reads at a glance
    if (lod > 2.5) {
      for (const [v, col] of [[HI, GLOW], [X, GLOW_X]]) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 0.42;
        ctx.beginPath();
        for (const wr of c.wires) if (val[wr.net] === v) this.path(ctx, wr.pts);
        ctx.stroke();
      }
    }
    for (const v of [LO, Z, HI, X]) {
      ctx.strokeStyle = WIRE_COL[v];
      ctx.lineWidth = v === LO || v === Z ? 0.1 : 0.13;
      if (v === Z) ctx.setLineDash([0.34, 0.26]);
      ctx.beginPath();
      for (const wr of c.wires) if (val[wr.net] === v) this.path(ctx, wr.pts);
      ctx.stroke();
      if (v === Z) ctx.setLineDash([]);
    }

    for (const r of c.resistors) this.drawResistor(ctx, c, r, lod);
    for (const d of c.diodes) this.drawDiode(ctx, c, d, lod);
    for (const t of c.transistors) this.drawTransistor(ctx, c, t, now, lod);
    for (const r of c.relays) this.drawRelay(ctx, c, r, now, lod);
    for (const sw of c.switches) this.drawSwitch(ctx, c, sw, lod);
    for (const l of c.lamps) this.drawLamp(ctx, c, l, lod);

    if (lod > 5) {
      ctx.fillStyle = TEXT;
      for (const t of c.labels) {
        ctx.fillStyle = t.color || TEXT;
        ctx.font = `${0.9 * t.size}px system-ui, sans-serif`;
        ctx.textAlign = t.align;
        ctx.textBaseline = 'middle';
        ctx.fillText(t.text, t.x, t.y);
      }
    }
    ctx.restore();
  }

  path(ctx, pts) {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }

  // Fraction of the way through an in-flight transition, 0..1.
  travel(c, d, now) {
    if (d.pending === null) return null;
    const delay = c.delayOf(d);
    return Math.max(0, Math.min(1, 1 - (d.pendingAt - now) / delay));
  }

  // Labelled boxes behind the circuit, saying what each patch of devices
  // is. The caption is sized in *pixels* and converted back to world units,
  // so it stays legible whether you are looking at the whole machine or one
  // corner of it — the opposite of the device labels, which are meant to
  // disappear as you zoom out.
  drawRegions(ctx, c, lod) {
    const px = 1 / lod;                       // one screen pixel in world units
    ctx.save();
    ctx.lineWidth = Math.max(0.04, px);
    ctx.setLineDash([px * 5, px * 4]);
    for (const r of c.regions) {
      const w = r.x1 - r.x0, h = r.y1 - r.y0;
      ctx.strokeStyle = r.color || REGION_EDGE;
      ctx.fillStyle = REGION_FILL;
      ctx.beginPath();
      ctx.roundRect(r.x0, r.y0, w, h, px * 6);
      ctx.fill();
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Captions last, so no box edge crosses a word. Clamp the type size to
    // a pixel range: big enough to read zoomed out, never so big zoomed in
    // that it swamps the devices it is labelling.
    const fontPx = Math.min(15, Math.max(9, lod * 1.1));
    ctx.font = `600 ${fontPx * px}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const r of c.regions) {
      // 'inside' tucks the caption into the top-left corner of the box,
      // for boxes packed tightly enough that an outside caption would
      // land on the neighbour above.
      const y = r.side === 'bottom' ? r.y1 + fontPx * px * 0.85
              : r.side === 'inside' ? r.y0 + fontPx * px * 0.75
              : r.y0 - fontPx * px * 0.85;
      // Clip the caption to its own box. Without this, neighbouring blocks'
      // labels run into each other the moment two boxes sit side by side —
      // and a caption that overflows its box points at the wrong devices.
      const maxW = (r.x1 - r.x0) - px * 4;
      let text = r.text;
      if (ctx.measureText(text).width > maxW) {
        while (text.length > 1 && ctx.measureText(text + '…').width > maxW) {
          text = text.slice(0, -1);
        }
        text = text.replace(/[\s—–-]+$/, '') + '…';
      }
      const tw = ctx.measureText(text).width;
      // a slab behind the text so it stays readable over dense wiring
      ctx.fillStyle = BG;
      ctx.globalAlpha = 0.82;
      ctx.fillRect(r.x0 - px * 2, y - fontPx * px * 0.62,
        tw + px * 5, fontPx * px * 1.24);
      ctx.globalAlpha = 1;
      ctx.fillStyle = r.color || REGION_TEXT;
      ctx.fillText(text, r.x0 + px * 1.5, y);
    }
    ctx.restore();
  }

  drawRelay(ctx, c, r, now, lod) {
    const h = relayH(r);
    const energizedCoil = c.hot[r.coil];

    if (lod <= 2.5) {
      // far zoom: relays become state-colored blocks
      ctx.fillStyle = energizedCoil ? '#b06018' : '#262c3c';
      ctx.fillRect(r.x, r.y, RELAY_W, h);
      return;
    }

    // body
    ctx.fillStyle = BODY;
    ctx.strokeStyle = BODY_EDGE;
    ctx.lineWidth = 0.08;
    ctx.beginPath();
    ctx.roundRect(r.x - 0.15, r.y - 0.3, RELAY_W + 0.3, h + 0.3, 0.3);
    ctx.fill();
    ctx.stroke();

    // coil
    const cx0 = r.x + 1, cy0 = r.y + 0.1;
    ctx.fillStyle = energizedCoil ? 'rgba(255,140,30,0.5)' : '#2a3040';
    ctx.strokeStyle = energizedCoil ? WIRE_HOT : '#5a6480';
    ctx.lineWidth = 0.09;
    ctx.beginPath();
    ctx.roundRect(cx0, cy0, 2, COIL_H - 0.2, 0.15);
    ctx.fill();
    ctx.stroke();
    if (lod > 7) {
      ctx.beginPath();
      for (let i = 1; i <= 3; i++) {
        ctx.moveTo(cx0 + i * 0.5, cy0);
        ctx.lineTo(cx0 + i * 0.5, cy0 + COIL_H - 0.2);
      }
      ctx.stroke();
    }
    // coil feed terminal + wire stub
    const ct = coilT(r);
    ctx.strokeStyle = WIRE_COL[c.value[r.coil]];
    ctx.lineWidth = 0.13;
    ctx.beginPath();
    ctx.moveTo(ct.x, ct.y);
    ctx.lineTo(cx0, ct.y);
    ctx.stroke();
    this.dot(ctx, ct.x, ct.y, c.value[r.coil]);
    // ground stub on the far side of the coil
    if (lod > 7) {
      ctx.strokeStyle = '#566078';
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.moveTo(cx0 + 2, ct.y); ctx.lineTo(cx0 + 2.55, ct.y);
      ctx.moveTo(cx0 + 2.55, ct.y - 0.28); ctx.lineTo(cx0 + 2.55, ct.y + 0.28);
      ctx.moveTo(cx0 + 2.75, ct.y - 0.16); ctx.lineTo(cx0 + 2.75, ct.y + 0.16);
      ctx.moveTo(cx0 + 2.92, ct.y - 0.06); ctx.lineTo(cx0 + 2.92, ct.y + 0.06);
      ctx.stroke();
    }

    // armature position: 0 = NC (up), 1 = NO (down); animate travel
    let pos = r.energized ? 1 : 0;
    const prog = this.travel(c, r, now);
    if (prog !== null) pos = r.pending ? prog : 1 - prog;

    for (let i = 0; i < r.contacts.length; i++) {
      const k = r.contacts[i];
      const t = contactT(r, i);
      const commonHot = c.hot[k.c];
      // throw terminals
      if (k.nc !== null) this.dot(ctx, t.nc.x, t.nc.y, c.value[k.nc]);
      else this.smallTick(ctx, t.nc.x, t.nc.y);
      if (k.no !== null) this.dot(ctx, t.no.x, t.no.y, c.value[k.no]);
      else this.smallTick(ctx, t.no.x, t.no.y);
      this.dot(ctx, t.c.x, t.c.y, c.value[k.c]);
      // armature blade from common to a point interpolated NC->NO
      const ty = t.nc.y + (t.no.y - t.nc.y) * pos;
      ctx.strokeStyle = commonHot ? WIRE_HOT : METAL;
      ctx.lineWidth = commonHot ? 0.16 : 0.12;
      ctx.beginPath();
      ctx.moveTo(t.c.x + 0.12, t.c.y);
      ctx.lineTo(t.nc.x - 0.45, ty);
      ctx.lineTo(t.nc.x - 0.12, ty);
      ctx.stroke();
    }

    if (lod > 6) {
      ctx.fillStyle = TEXT;
      ctx.font = '0.7px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      if (r.name.length <= NAME_MAX) {
        ctx.fillText(r.name, r.x + RELAY_W / 2, r.y - 0.45);
      }
    }
  }

  // A MOSFET: channel between a and b, gate bar alongside it, isolated. The
  // channel is drawn broken when the device is off, so it reads as the
  // switch it is; the gap closes as the transition completes.
  drawTransistor(ctx, c, t, now, lod) {
    const p = mosT(t);
    const pmos = t.kind === 'pmos';
    const conducting = t.on;

    if (lod <= 2.5) {
      ctx.fillStyle = conducting ? '#b06018' : '#262c3c';
      ctx.fillRect(t.x - 0.6, t.y, 1.2, MOS_H);
      return;
    }

    const va = c.value[t.a], vb = c.value[t.b];
    // drain/source leads
    ctx.lineWidth = 0.13;
    ctx.strokeStyle = WIRE_COL[va];
    ctx.beginPath();
    ctx.moveTo(p.a.x, p.a.y); ctx.lineTo(p.a.x, p.a.y + 0.62);
    ctx.stroke();
    ctx.strokeStyle = WIRE_COL[vb];
    ctx.beginPath();
    ctx.moveTo(p.b.x, p.b.y); ctx.lineTo(p.b.x, p.b.y - 0.62);
    ctx.stroke();

    // channel: three segments of the vertical bar, joined only when on
    const y0 = p.a.y + 0.62, y1 = p.b.y - 0.62;
    const prog = this.travel(c, t, now);
    let closed = conducting ? 1 : 0;
    if (prog !== null) closed = t.pending ? prog : 1 - prog;
    ctx.strokeStyle = conducting && (va === HI || vb === HI) ? WIRE_HOT : METAL;
    ctx.lineWidth = 0.15;
    ctx.beginPath();
    ctx.moveTo(t.x, y0); ctx.lineTo(t.x, y0 + 0.32);
    ctx.moveTo(t.x, y1); ctx.lineTo(t.x, y1 - 0.32);
    ctx.stroke();
    if (closed > 0) {
      // the inversion layer forming: a bar that grows to bridge the gap
      const mid = (y0 + y1) / 2, half = ((y1 - y0) / 2 - 0.3) * closed;
      ctx.globalAlpha = 0.35 + 0.65 * closed;
      ctx.beginPath();
      ctx.moveTo(t.x, mid - half); ctx.lineTo(t.x, mid + half);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // gate: a bar parallel to the channel, never touching it
    const gx = t.x - 0.5;
    ctx.strokeStyle = WIRE_COL[c.value[t.gate]];
    ctx.lineWidth = 0.14;
    ctx.beginPath();
    ctx.moveTo(gx, y0 - 0.1); ctx.lineTo(gx, y1 + 0.1);
    ctx.stroke();
    // gate lead, with the PMOS inversion bubble
    const gy = (p.a.y + p.b.y) / 2;
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.moveTo(p.g.x, p.g.y); ctx.lineTo(p.g.x, gy);
    ctx.lineTo(gx - (pmos ? 0.34 : 0), gy);
    ctx.stroke();
    if (pmos) {
      ctx.fillStyle = BG;
      ctx.beginPath();
      ctx.arc(gx - 0.17, gy, 0.17, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    this.dot(ctx, p.g.x, p.g.y, c.value[t.gate]);
    this.dot(ctx, p.a.x, p.a.y, va);
    this.dot(ctx, p.b.x, p.b.y, vb);

    // Device names are worth drawing on the hand-routed circuits, where
    // they were chosen to mean something (K1, PA, NB). On a composed
    // machine they are auto-generated instance tags — `nand2112.PA` — which
    // say nothing a reader wants and collide with their neighbours, since
    // module layouts pack far tighter than hand-placed ones. So they are
    // drawn only when short enough to be deliberate, and only when there is
    // room for them.
    if (lod > 6 && t.name.length <= NAME_MAX) {
      ctx.fillStyle = pmos ? '#9d86c9' : '#6f9dd0';
      ctx.font = '0.62px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(t.name, t.x + 0.4, gy);
    }
  }

  drawDiode(ctx, c, d, lod) {
    const p = diodeT(d);
    const va = c.value[d.anode], vb = c.value[d.cathode];
    if (lod <= 2.5) {
      ctx.fillStyle = va === HI ? '#b06018' : '#262c3c';
      ctx.fillRect(d.x - 0.5, d.y - 0.5, 1, 1);
      return;
    }
    const ang = d.vert ? Math.PI / 2 : 0;
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(ang);
    // leads
    ctx.lineWidth = 0.13;
    ctx.strokeStyle = WIRE_COL[va];
    ctx.beginPath(); ctx.moveTo(-0.9, 0); ctx.lineTo(-0.32, 0); ctx.stroke();
    ctx.strokeStyle = WIRE_COL[vb];
    ctx.beginPath(); ctx.moveTo(0.32, 0); ctx.lineTo(0.9, 0); ctx.stroke();
    // triangle pointing anode -> cathode, with the cathode bar
    const conducting = va === HI && vb !== HI;
    ctx.fillStyle = conducting ? WIRE_HOT : METAL;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.moveTo(-0.34, -0.38); ctx.lineTo(0.28, 0); ctx.lineTo(-0.34, 0.38);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0.3, -0.42); ctx.lineTo(0.3, 0.42);
    ctx.stroke();
    ctx.restore();
    this.dot(ctx, p.a.x, p.a.y, va);
    this.dot(ctx, p.b.x, p.b.y, vb);
  }

  drawResistor(ctx, c, r, lod) {
    const p = resistorT(r);
    const va = c.value[r.a], vb = c.value[r.b];
    if (lod <= 2.5) {
      ctx.strokeStyle = '#4a5470';
      ctx.lineWidth = 0.2;
      ctx.beginPath();
      ctx.moveTo(p.a.x, p.a.y); ctx.lineTo(p.b.x, p.b.y);
      ctx.stroke();
      return;
    }
    ctx.save();
    ctx.translate(r.x, r.y);
    ctx.rotate(r.vert ? Math.PI / 2 : 0);
    const h = 1.2;
    ctx.lineWidth = 0.13;
    ctx.strokeStyle = WIRE_COL[va];
    ctx.beginPath(); ctx.moveTo(-h, 0); ctx.lineTo(-0.62, 0); ctx.stroke();
    ctx.strokeStyle = WIRE_COL[vb];
    ctx.beginPath(); ctx.moveTo(0.62, 0); ctx.lineTo(h, 0); ctx.stroke();
    // zigzag body
    ctx.strokeStyle = METAL;
    ctx.lineWidth = 0.11;
    ctx.beginPath();
    ctx.moveTo(-0.62, 0);
    for (let i = 0; i < 6; i++) {
      ctx.lineTo(-0.52 + i * 0.207, (i % 2 ? -1 : 1) * 0.3);
    }
    ctx.lineTo(0.62, 0);
    ctx.stroke();
    ctx.restore();
    this.dot(ctx, p.a.x, p.a.y, va);
    this.dot(ctx, p.b.x, p.b.y, vb);
  }

  drawSwitch(ctx, c, s, lod) {
    const closed = s.kind === 'push-nc' ? !s.on : s.on;
    if (s.to !== null) return this.drawSpdt(ctx, c, s, closed, lod);

    const t = switchT(s);
    const vIn = c.value[s.from];
    const vOut = c.value[s.net];

    if (lod <= 2.5) {
      ctx.fillStyle = closed ? '#b06018' : '#30374a';
      ctx.fillRect(s.x - 1, s.y - 0.7, 2, 1.4);
      return;
    }

    this.dot(ctx, t.in.x, t.in.y, vIn);
    this.dot(ctx, t.out.x, t.out.y, vOut);

    // lever pivots on the fed side; open = tip raised
    const dir = Math.sign(t.out.x - t.in.x);
    const hx = closed ? t.out.x - dir * 0.15 : t.out.x - dir * 0.45;
    const hy = closed ? t.out.y : t.out.y - 1.0;
    ctx.strokeStyle = closed && vIn === HI ? WIRE_HOT : METAL;
    ctx.lineWidth = 0.16;
    ctx.beginPath();
    ctx.moveTo(t.in.x, t.in.y);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    this.knob(ctx, s, hx, hy);
    this.switchLabel(ctx, s, lod);
  }

  // Changeover input switch: the lever rests on the + throw or the ground
  // throw, so the driven net is never left floating.
  drawSpdt(ctx, c, s, closed, lod) {
    const t = switchSpdtT(s);
    if (lod <= 2.5) {
      ctx.fillStyle = closed ? '#b06018' : '#30374a';
      ctx.fillRect(s.x - 1, s.y - 0.7, 2, 1.4);
      return;
    }
    this.dot(ctx, t.hi.x, t.hi.y, c.value[s.from]);
    this.dot(ctx, t.lo.x, t.lo.y, c.value[s.to]);
    this.dot(ctx, t.c.x, t.c.y, c.value[s.net]);
    const tip = closed ? t.hi : t.lo;
    ctx.strokeStyle = c.value[s.net] === HI ? WIRE_HOT : METAL;
    ctx.lineWidth = 0.16;
    ctx.beginPath();
    ctx.moveTo(t.c.x - 0.12, t.c.y);
    ctx.lineTo(tip.x + 0.4, tip.y);
    ctx.lineTo(tip.x + 0.12, tip.y);
    ctx.stroke();
    this.knob(ctx, s, s.x - 0.05, tip.y - 0.5);
    this.switchLabel(ctx, s, lod);
  }

  knob(ctx, s, x, y) {
    ctx.fillStyle = s.kind === 'toggle' ? '#5f8dd3'
      : (s.kind === 'push-nc' ? '#d36a5f' : '#67b26f');
    ctx.beginPath();
    ctx.arc(x, y, 0.28, 0, Math.PI * 2);
    ctx.fill();
  }

  switchLabel(ctx, s, lod) {
    if (lod <= 5) return;
    ctx.fillStyle = TEXT;
    ctx.font = '0.75px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(s.label, s.x, s.y + 0.75);
    if (s.kind !== 'toggle' && lod > 9) {
      ctx.fillStyle = '#5d6578';
      ctx.font = '0.5px system-ui, sans-serif';
      ctx.fillText(s.kind === 'push-nc' ? '(push · NC)' : '(push)', s.x, s.y + 1.7);
    }
  }

  drawLamp(ctx, c, l, lod) {
    const v = c.value[l.net];
    const on = v === HI;
    const bad = v === X;
    if ((on || bad) && lod > 2.5) {
      const tint = bad ? '255, 90, 75' : '255, 205, 110';
      const g = ctx.createRadialGradient(l.x, l.y, 0.1, l.x, l.y, 1.8);
      g.addColorStop(0, `rgba(${tint}, 0.55)`);
      g.addColorStop(1, `rgba(${tint}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(l.x, l.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = on ? LAMP_ON : bad ? '#8f2a22' : '#262b39';
    ctx.strokeStyle = on ? '#ffe9bd' : bad ? '#ff8a7d' : v === Z ? WIRE_Z : '#4d5568';
    ctx.lineWidth = 0.09;
    if (v === Z) ctx.setLineDash([0.28, 0.22]);
    ctx.beginPath();
    ctx.arc(l.x, l.y, 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    if (lod > 6) {
      // filament cross
      ctx.strokeStyle = on ? '#b97b1f' : bad ? '#d4675a' : '#414b60';
      ctx.lineWidth = 0.07;
      const d = 0.7 * 0.707;
      ctx.beginPath();
      ctx.moveTo(l.x - d, l.y - d); ctx.lineTo(l.x + d, l.y + d);
      ctx.moveTo(l.x - d, l.y + d); ctx.lineTo(l.x + d, l.y - d);
      ctx.stroke();
    }
    if (lod > 5) {
      ctx.fillStyle = on ? '#e8d5ac' : bad ? '#ff9c90' : TEXT;
      ctx.font = '0.75px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = l.above ? 'bottom' : 'top';
      const cap = v === X ? `${l.label} · X` : v === Z ? `${l.label} · Z` : l.label;
      ctx.fillText(cap, l.x, l.above ? l.y - 1.0 : l.y + 1.0);
    }
  }

  dot(ctx, x, y, v) {
    ctx.fillStyle = DOT_COL[v] ?? DOT_COL[LO];
    ctx.beginPath();
    ctx.arc(x, y, 0.14, 0, Math.PI * 2);
    ctx.fill();
  }

  smallTick(ctx, x, y) {
    ctx.strokeStyle = '#3a4152';
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    ctx.moveTo(x - 0.1, y);
    ctx.lineTo(x + 0.1, y);
    ctx.stroke();
  }
}
