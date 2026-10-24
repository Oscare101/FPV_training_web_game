// Stick conventions (output of InputManager.state):
//   roll  -1..1  (+ = right)
//   pitch -1..1  (+ = stick forward / nose down)
//   yaw   -1..1  (+ = right)
//   throttle 0..1 (0 = stick fully down)
export const CHANNELS = ['roll', 'pitch', 'yaw', 'throttle'];

export const CHANNEL_INFO = {
  roll: { label: 'Roll', push: 'RIGHT' },
  pitch: { label: 'Pitch', push: 'UP (forward)' },
  yaw: { label: 'Yaw', push: 'RIGHT' },
  throttle: { label: 'Throttle', push: 'UP (from low)' },
};

// On/off functions from a radio switch (axis) or button.
export const SWITCHES = ['arm', 'reset', 'detonate', 'screenshot'];

export const SWITCH_INFO = {
  arm: { label: 'Arm', tip: 'Arms the motors when ON. Arming needs low throttle; flip OFF and ON again after a crash.' },
  reset: { label: 'Reset', tip: 'Puts the drone back on the launch point (same as R).' },
  detonate: { label: 'Detonate', tip: 'Fires the strike charge manually (same as X). Only in strike missions, after the charge is armed.' },
  screenshot: { label: 'Screenshot', tip: 'Saves a screenshot when switched ON (same as K). A momentary button works best.' },
};

export const defaultSwitch = () => ({ source: 'none', index: 0, invert: false });

export const DEFAULT_AXIS_CAL = Object.freeze({ min: -1, center: 0, max: 1 });

const STORAGE_KEY = 'fpv-trainer.input.v1';

// EdgeTX "Classic" USB joystick with AETR channel order: CH1..CH4 -> axes 0..3.
export function defaultInputConfig() {
  return {
    mapping: {
      roll: { axis: 0, invert: false },
      pitch: { axis: 1, invert: false },
      throttle: { axis: 2, invert: false },
      yaw: { axis: 3, invert: false },
    },
    switches: Object.fromEntries(SWITCHES.map((sw) => [sw, defaultSwitch()])), // source: 'none' | 'axis' | 'button'
    axes: [], // per raw axis: { min, center, max }
    deadzone: 0.02,
    calibrated: false,
  };
}

export function loadInputConfig() {
  const config = defaultInputConfig();
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return config;
    for (const ch of CHANNELS) {
      const m = saved.mapping?.[ch];
      if (m && Number.isInteger(m.axis)) config.mapping[ch] = { axis: m.axis, invert: !!m.invert };
    }
    for (const sw of SWITCHES) {
      const v = saved.switches?.[sw];
      if (v && ['none', 'axis', 'button'].includes(v.source) && Number.isInteger(v.index)) {
        config.switches[sw] = { source: v.source, index: v.index, invert: !!v.invert };
      }
    }
    if (Array.isArray(saved.axes)) config.axes = saved.axes.map((a) => (a ? { ...a } : null));
    if (typeof saved.deadzone === 'number') config.deadzone = saved.deadzone;
    config.calibrated = !!saved.calibrated;
  } catch {
    // corrupted or unavailable storage: fall back to defaults
  }
  return config;
}

export function saveInputConfig(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // storage unavailable: settings live for this session only
  }
}
