// Betaflight "Actual Betaflight rates" formula (rc_rate / super_rate / expo).
export const DEFAULT_RATES = {
  roll: { rcRate: 1.0, superRate: 0.7, expo: 0 },
  pitch: { rcRate: 1.0, superRate: 0.7, expo: 0 },
  yaw: { rcRate: 1.0, superRate: 0.7, expo: 0 },
};

// stick: -1..1 -> deg/s
export function betaflightRate(stick, { rcRate, superRate, expo }) {
  const abs = Math.abs(stick);
  let rc = stick;
  if (expo) rc = rc * abs * abs * abs * expo + rc * (1 - expo);
  let rate = rcRate > 2 ? rcRate + 14.54 * (rcRate - 2) : rcRate;
  let deg = 200 * rate * rc;
  if (superRate) deg *= 1 / Math.min(1, Math.max(0.01, 1 - abs * superRate));
  return deg;
}

export function maxRate(axisRates) {
  return betaflightRate(1, axisRates);
}
