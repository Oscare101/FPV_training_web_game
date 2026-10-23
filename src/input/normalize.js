const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Self-centering stick -> -1..1, separate scaling on each side of center, deadzone rescaled.
export function normalizeCentered(raw, cal, invert, deadzone) {
  const span = raw >= cal.center ? cal.max - cal.center : cal.center - cal.min;
  if (span <= 1e-6) return 0;
  let v = clamp((raw - cal.center) / span, -1, 1);
  if (invert) v = -v;
  const a = Math.abs(v);
  if (a <= deadzone) return 0;
  return Math.sign(v) * (a - deadzone) / (1 - deadzone);
}

// Throttle -> 0..1, deadzone at both ends so 0 and 100% are always reachable.
export function normalizeThrottle(raw, cal, invert, deadzone) {
  const span = cal.max - cal.min;
  if (span <= 1e-6) return 0;
  let t = clamp((raw - cal.min) / span, 0, 1);
  if (invert) t = 1 - t;
  return clamp((t - deadzone) / (1 - 2 * deadzone), 0, 1);
}
