// Canvas renderer: pan/zoom viewport, glowing wires, animated armatures.

import { RELAY_W, COIL_H, coilT, contactT, relayH, switchT } from './geometry.js';

const BG = '#12141a';
const WIRE_OFF = '#3b4252';
const WIRE_HOT = '#ffb54d';
const GLOW = 'rgba(255, 160, 40, 0.22)';
const BODY = '#1c212e';
const BODY_EDGE = '#454e66';
const METAL = '#c7cfe0';
const TEXT = '#8b93a7';
const LAMP_ON = '#ffd67f';

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

    const hot = c.hot;
    const lod = s; // px per world unit

    // wires: glow pass for hot nets, then core strokes
    if (lod > 2.5) {
      ctx.strokeStyle = GLOW;
      ctx.lineWidth = 0.42;
      ctx.beginPath();
      for (const wr of c.wires) if (hot[wr.net]) this.path(ctx, wr.pts);
      ctx.stroke();
    }
    ctx.strokeStyle = WIRE_OFF;
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    for (const wr of c.wires) if (!hot[wr.net]) this.path(ctx, wr.pts);
    ctx.stroke();
    ctx.strokeStyle = WIRE_HOT;
    ctx.lineWidth = 0.13;
    ctx.beginPath();
    for (const wr of c.wires) if (hot[wr.net]) this.path(ctx, wr.pts);
    ctx.stroke();

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
    ctx.strokeStyle = c.hot[r.coil] ? WIRE_HOT : WIRE_OFF;
    ctx.lineWidth = 0.13;
    ctx.beginPath();
    ctx.moveTo(ct.x, ct.y);
    ctx.lineTo(cx0, ct.y);
    ctx.stroke();
    this.dot(ctx, ct.x, ct.y, c.hot[r.coil]);
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
    if (r.pending !== null) {
      const delay = Math.max(15, c.baseDelay * r.delayFactor);
      const prog = Math.max(0, Math.min(1, 1 - (r.pendingAt - now) / delay));
      pos = r.pending ? prog : 1 - prog;
    }

    for (let i = 0; i < r.contacts.length; i++) {
      const k = r.contacts[i];
      const t = contactT(r, i);
      const commonHot = c.hot[k.c];
      // throw terminals
      if (k.nc !== null) this.dot(ctx, t.nc.x, t.nc.y, c.hot[k.nc], k.nc === undefined);
      else this.smallTick(ctx, t.nc.x, t.nc.y);
      if (k.no !== null) this.dot(ctx, t.no.x, t.no.y, c.hot[k.no]);
      else this.smallTick(ctx, t.no.x, t.no.y);
      this.dot(ctx, t.c.x, t.c.y, commonHot);
      // armature blade from common to a point interpolated NC->NO
      const ty = t.nc.y + (t.no.y - t.nc.y) * pos;
      const live = commonHot;
      ctx.strokeStyle = live ? WIRE_HOT : METAL;
      ctx.lineWidth = live ? 0.16 : 0.12;
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
      ctx.fillText(r.name, r.x + RELAY_W / 2, r.y - 0.45);
    }
  }

  drawSwitch(ctx, c, s, lod) {
    const t = switchT(s);
    const a = s.flip ? t.out : t.in;   // fixed pivot side (fed side)
    const b = s.flip ? t.in : t.out;
    const closed = s.kind === 'push-nc' ? !s.on : s.on;
    const inHot = true; // fed from VCC
    const outHot = c.hot[s.net];

    if (lod <= 2.5) {
      ctx.fillStyle = closed ? '#b06018' : '#30374a';
      ctx.fillRect(s.x - 1, s.y - 0.7, 2, 1.4);
      return;
    }

    this.dot(ctx, t.in.x, t.in.y, inHot);
    this.dot(ctx, t.out.x, t.out.y, outHot);

    // lever pivots on the fed side; open = tip raised
    const dir = Math.sign(t.out.x - t.in.x);
    const hx = closed ? t.out.x - dir * 0.15 : t.out.x - dir * 0.45;
    const hy = closed ? t.out.y : t.out.y - 1.0;
    ctx.strokeStyle = closed ? WIRE_HOT : METAL;
    ctx.lineWidth = 0.16;
    ctx.beginPath();
    ctx.moveTo(t.in.x, t.in.y);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.fillStyle = s.kind === 'toggle' ? '#5f8dd3' : (s.kind === 'push-nc' ? '#d36a5f' : '#67b26f');
    ctx.beginPath();
    ctx.arc(hx, hy, 0.28, 0, Math.PI * 2);
    ctx.fill();

    if (lod > 5) {
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
  }

  drawLamp(ctx, c, l, lod) {
    const on = c.hot[l.net];
    if (on && lod > 2.5) {
      const g = ctx.createRadialGradient(l.x, l.y, 0.1, l.x, l.y, 1.8);
      g.addColorStop(0, 'rgba(255, 205, 110, 0.55)');
      g.addColorStop(1, 'rgba(255, 205, 110, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(l.x, l.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = on ? LAMP_ON : '#262b39';
    ctx.strokeStyle = on ? '#ffe9bd' : '#4d5568';
    ctx.lineWidth = 0.09;
    ctx.beginPath();
    ctx.arc(l.x, l.y, 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (lod > 6) {
      // filament cross
      ctx.strokeStyle = on ? '#b97b1f' : '#414b60';
      ctx.lineWidth = 0.07;
      const d = 0.7 * 0.707;
      ctx.beginPath();
      ctx.moveTo(l.x - d, l.y - d); ctx.lineTo(l.x + d, l.y + d);
      ctx.moveTo(l.x - d, l.y + d); ctx.lineTo(l.x + d, l.y - d);
      ctx.stroke();
    }
    if (lod > 5) {
      ctx.fillStyle = on ? '#e8d5ac' : TEXT;
      ctx.font = '0.75px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = l.above ? 'bottom' : 'top';
      ctx.fillText(l.label, l.x, l.above ? l.y - 1.0 : l.y + 1.0);
    }
  }

  dot(ctx, x, y, hotState) {
    ctx.fillStyle = hotState ? WIRE_HOT : '#59637e';
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
