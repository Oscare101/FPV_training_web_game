// Synthesized sound, no audio files:
//   - 4 motors: sawtooth + blade-pass overtone, pitch follows each motor's rpm
//     (collective throttle + roll/pitch/yaw differential), lowered by battery sag
//   - prop noise: band-passed noise rising with thrust
//   - wind: low-passed noise rising with airspeed
//   - crash: noise burst + thump
// Chrome only starts audio after a click or key press, so the context resumes on the first gesture.

const SMOOTH = 0.02; // s, parameter glide
// Quad-X mixer signs per motor: [roll, pitch, yaw]
const MOTOR_SIGNS = [[1, 1, -1], [-1, 1, 1], [1, -1, 1], [-1, -1, -1]];
const MIX_DEPTH = 0.25;
const DETUNE = [0, 3, -4, 6]; // cents, keeps 4 motors from phasing into one tone

export class AudioEngine {
  constructor(parent) {
    this.ctx = new AudioContext();
    this.volume = 0.6;
    this.muted = false;
    this.prevStatus = null;

    this.hint = document.createElement('div');
    this.hint.className = 'audio-hint';
    this.hint.textContent = 'Click or press any key to enable sound';
    parent.appendChild(this.hint);

    const resume = () => this.ctx.resume();
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.ctx.suspend();
      else this.ctx.resume();
    });

    this.build();
  }

  build() {
    const ctx = this.ctx;
    const compressor = ctx.createDynamicsCompressor();
    compressor.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(compressor);

    // Motors
    this.motorFilter = ctx.createBiquadFilter();
    this.motorFilter.type = 'lowpass';
    this.motorFilter.Q.value = 0.7;
    this.motorBus = ctx.createGain();
    this.motorBus.gain.value = 0;
    this.motorBus.connect(this.motorFilter).connect(this.master);
    this.motors = MOTOR_SIGNS.map((_, i) => {
      const base = ctx.createOscillator();
      base.type = 'sawtooth';
      base.detune.value = DETUNE[i];
      const blade = ctx.createOscillator();
      blade.type = 'triangle';
      blade.detune.value = DETUNE[i];
      const baseGain = ctx.createGain();
      baseGain.gain.value = 0.22;
      const bladeGain = ctx.createGain();
      bladeGain.gain.value = 0.12;
      base.connect(baseGain).connect(this.motorBus);
      blade.connect(bladeGain).connect(this.motorBus);
      base.start();
      blade.start();
      return { base, blade };
    });

    // Shared white noise buffer
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const loopNoise = (offset) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.start(0, offset);
      return src;
    };

    this.propFilter = ctx.createBiquadFilter();
    this.propFilter.type = 'bandpass';
    this.propFilter.Q.value = 0.8;
    this.propGain = ctx.createGain();
    this.propGain.gain.value = 0;
    loopNoise(0).connect(this.propFilter).connect(this.propGain).connect(this.master);

    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    loopNoise(1).connect(windFilter).connect(this.windGain).connect(this.master);
  }

  applySettings({ audio }) {
    this.volume = audio.volume;
    this.muted = audio.muted;
  }

  set(param, value) {
    param.setTargetAtTime(value, this.ctx.currentTime, SMOOTH);
  }

  update(flight, paused) {
    this.hint.hidden = this.ctx.state === 'running' || this.muted;
    if (this.ctx.state !== 'running') return;

    if (flight.status === 'crashed' && this.prevStatus !== 'crashed' && this.prevStatus !== null) this.playCrash();
    this.prevStatus = flight.status;

    this.set(this.master.gain, paused || this.muted ? 0 : this.volume);

    const d = flight.drone;
    const m = d.motor;
    const rpm = Math.sqrt(d.battery.thrustScale); // rpm ∝ voltage
    const sizeScale = 0.024 * 5 / d.spec.radius; // bigger props spin slower
    const spread = MIX_DEPTH * Math.max(m, 0.2);
    for (let i = 0; i < 4; i++) {
      const [sr, sp, sy] = MOTOR_SIGNS[i];
      const mi = Math.min(1, Math.max(0, m + spread * (sr * d.mix.z + sp * d.mix.x + sy * d.mix.y)));
      const f = (40 + 560 * mi) * rpm * sizeScale;
      this.set(this.motors[i].base.frequency, f);
      this.set(this.motors[i].blade.frequency, f * 3);
    }
    this.set(this.motorBus.gain, Math.pow(Math.min(1, m * 3), 0.7) * 0.5);
    this.set(this.motorFilter.frequency, 600 + 7000 * m);
    this.set(this.propFilter.frequency, 1200 + 3000 * m);
    this.set(this.propGain.gain, 0.35 * m * m);

    const airspeed = flight.speed;
    const flying = flight.status === 'armed' || flight.status === 'disarmed';
    this.set(this.windGain.gain, flying ? Math.min(0.5, (airspeed / 35) ** 2 * 0.5) : 0);
  }

  // Big boom: long low-passed noise rumble + deep thump
  playExplosion() {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(4000, t);
    lp.frequency.exponentialRampToValueAtTime(150, t + 2.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(1.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 3);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 3);

    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(90, t);
    thump.frequency.exponentialRampToValueAtTime(25, t + 0.8);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(1.5, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 1);
    thump.connect(tg).connect(this.master);
    thump.start(t);
    thump.stop(t + 1);
  }

  playCrash() {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3000, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.5);

    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(130, t);
    thump.frequency.exponentialRampToValueAtTime(35, t + 0.3);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.8, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    thump.connect(tg).connect(this.master);
    thump.start(t);
    thump.stop(t + 0.35);
  }
}
