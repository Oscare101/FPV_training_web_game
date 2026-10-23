// Testing fallback, not for training. Sticks are digital with smoothing; throttle
// does not self-center (hold W/S to move it), like a real throttle stick.
const STICK_DEFLECTION = 0.5;
const STICK_RESPONSE = 10; // 1/s smoothing
const THROTTLE_SPEED = 0.6; // per second

// Keys typed into form controls (settings fields) must not fly the drone.
export const isFormTarget = (e) => e.target instanceof HTMLElement && e.target.matches('input, select, textarea');

export class KeyboardInput {
  constructor() {
    this.keys = new Set();
    this.state = { roll: 0, pitch: 0, yaw: 0, throttle: 0, arm: false };
    this.resetRequested = false;

    window.addEventListener('keydown', (e) => {
      if (e.repeat || isFormTarget(e)) return;
      this.keys.add(e.code);
      if (e.code === 'Space') this.state.arm = !this.state.arm;
      if (e.code === 'KeyR') this.resetRequested = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  update(dt) {
    const k = this.keys;
    const s = this.state;
    const axis = (neg, pos) => ((k.has(pos) ? 1 : 0) - (k.has(neg) ? 1 : 0)) * STICK_DEFLECTION;
    const a = 1 - Math.exp(-dt * STICK_RESPONSE);
    s.roll += (axis('ArrowLeft', 'ArrowRight') - s.roll) * a;
    s.pitch += (axis('ArrowDown', 'ArrowUp') - s.pitch) * a;
    s.yaw += (axis('KeyA', 'KeyD') - s.yaw) * a;
    const thr = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    s.throttle = Math.min(1, Math.max(0, s.throttle + thr * THROTTLE_SPEED * dt));
  }

  consumeReset() {
    const r = this.resetRequested;
    this.resetRequested = false;
    return r;
  }
}
