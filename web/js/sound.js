// Device sounds. Two timbres, because the two devices fail differently to
// the ear: a relay is a mechanical impact (broadband noise burst), while a
// transistor gets a short buzzy "zzzt" (a sawtooth swept down through a
// resonant lowpass). A real MOSFET is of course silent — this is a
// deliberate sonification so device circuits aren't mute, not a claim
// about physics.

export class RelaySound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.noise = null;
    // ctx time of the most recent zap, for rate limiting. -Infinity, not 0:
    // a fresh AudioContext starts currentTime near 0, so 0 would make the
    // limiter swallow the very first zap after load.
    this.lastZap = -Infinity;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.enabled = false; return false; }
      this.ctx = new AC();
      const len = Math.floor(this.ctx.sampleRate * 0.05);
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.12));
      }
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  }

  // n armature movements happened this frame
  clicks(n) {
    if (!this.enabled || n <= 0) return;
    if (!this.ensure()) return;
    const t0 = this.ctx.currentTime;
    const voices = Math.min(n, 6);
    for (let i = 0; i < voices; i++) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.85 + Math.random() * 0.5;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1600 + Math.random() * 1800;
      bp.Q.value = 1.2;
      const g = this.ctx.createGain();
      g.gain.value = 0.5 / Math.sqrt(voices);
      src.connect(bp).connect(g).connect(this.ctx.destination);
      src.start(t0 + Math.random() * 0.025);
    }
  }

  // n channel switchings happened this frame. Quieter and shorter than a
  // click: a whole CMOS gate changing state is one "zzzt", not one per
  // transistor, and every transition glitches through X or Z on the way
  // (see DEVICES.md), so bursts arrive far denser than armature movements.
  zaps(n) {
    if (!this.enabled || n <= 0) return;
    if (!this.ensure()) return;
    const t0 = this.ctx.currentTime;
    // Rate limit: at ~16ms of rAF a big adder would otherwise fire hundreds
    // of overlapping voices and turn to mush.
    if (t0 - this.lastZap < 0.03) return;
    this.lastZap = t0;

    const voices = Math.min(n, 3);
    for (let i = 0; i < voices; i++) {
      const t = t0 + i * 0.012;
      const dur = 0.045 + Math.random() * 0.02;

      const osc = this.ctx.createOscillator();
      osc.type = 'sawtooth';
      // Swept down: the falling pitch is what reads as "zzzt" rather than
      // a beep. Jittered so simultaneous devices don't sound like one tone.
      const f0 = 320 + Math.random() * 220;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.45, t + dur);

      // Resonant lowpass, also swept: adds the buzzy edge and takes the
      // harshness off the raw saw.
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2600 + Math.random() * 1200, t);
      lp.frequency.exponentialRampToValueAtTime(700, t + dur);
      lp.Q.value = 6;

      const g = this.ctx.createGain();
      const peak = 0.16 / Math.sqrt(voices);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(lp).connect(g).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.01);
    }
  }
}
