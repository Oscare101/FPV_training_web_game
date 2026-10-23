import { GamepadSource } from './GamepadSource.js';
import { CHANNELS, SWITCHES, DEFAULT_AXIS_CAL, defaultInputConfig, loadInputConfig, saveInputConfig } from './config.js';
import { normalizeCentered, normalizeThrottle } from './normalize.js';

const NO_AXES = Object.freeze([]);

export class InputManager {
  constructor() {
    this.source = new GamepadSource();
    this.config = loadInputConfig();
    this.gamepad = null;
    this.raw = NO_AXES;
    this.buttons = NO_AXES;
    // arm/reset: boolean, or null when the switch is not mapped
    this.state = { connected: false, roll: 0, pitch: 0, yaw: 0, throttle: 0, arm: null, reset: null };
  }

  update() {
    const gp = this.source.poll();
    this.gamepad = gp;
    const s = this.state;
    if (!gp) {
      this.raw = NO_AXES;
      this.buttons = NO_AXES;
      s.connected = false;
      s.roll = s.pitch = s.yaw = s.throttle = 0;
      s.arm = s.reset = null;
      return;
    }
    this.raw = gp.axes;
    this.buttons = gp.buttons;
    s.connected = true;
    const { mapping, deadzone } = this.config;
    for (const ch of CHANNELS) {
      const { axis, invert } = mapping[ch];
      const v = this.raw[axis];
      if (v === undefined) {
        s[ch] = 0;
        continue;
      }
      const cal = this.axisCal(axis);
      s[ch] = ch === 'throttle'
        ? normalizeThrottle(v, cal, invert, deadzone)
        : normalizeCentered(v, cal, invert, deadzone);
    }
    for (const sw of SWITCHES) s[sw] = this.readSwitch(this.config.switches[sw]);
  }

  // Axis switch is ON at one end (+1, or -1 when inverted), so a 3-pos middle counts as OFF.
  readSwitch({ source, index, invert }) {
    if (source === 'axis') {
      const v = this.raw[index] ?? 0;
      return invert ? v < -0.5 : v > 0.5;
    }
    if (source === 'button') return !!this.buttons[index]?.pressed !== invert;
    return null;
  }

  axisCal(axis) {
    return this.config.axes[axis] ?? DEFAULT_AXIS_CAL;
  }

  // Assigning an axis already used by another channel swaps the two.
  setMapping(channel, axis, invert) {
    const { mapping } = this.config;
    const current = mapping[channel];
    if (axis !== current.axis) {
      const other = CHANNELS.find((ch) => ch !== channel && mapping[ch].axis === axis);
      if (other) mapping[other].axis = current.axis;
    }
    mapping[channel] = { axis, invert };
    this.save();
  }

  setSwitch(name, source, index, invert) {
    this.config.switches[name] = { source, index, invert };
    this.save();
  }

  setCalibration(axes) {
    this.config.axes = axes;
    this.config.calibrated = true;
    this.save();
  }

  setDeadzone(deadzone) {
    this.config.deadzone = deadzone;
    this.save();
  }

  reset() {
    this.config = defaultInputConfig();
    this.save();
  }

  save() {
    saveInputConfig(this.config);
  }
}
