// Relay click sounds: short filtered noise bursts with pitch jitter.

export class RelaySound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.noise = null;
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
}
