// User-facing drone settings. Everything else is derived from them in buildSpec().
export const DRONE_PRESETS = {
  '5inch': { label: '5" freestyle', size: 5, mass: 0.65, thrustToWeight: 8, payload: 0, cells: 6, capacity: 1300 },
  '7inch': { label: '7" long range', size: 7, mass: 1.05, thrustToWeight: 5, payload: 0, cells: 6, capacity: 3000 },
  '7strike': { label: '7" strike (kamikaze)', size: 7, mass: 1.1, thrustToWeight: 5.5, payload: 1.2, cells: 6, capacity: 3000 },
  '10inch': { label: '10" heavy (payload)', size: 10, mass: 2.4, thrustToWeight: 3.5, payload: 1, cells: 6, capacity: 5000 },
};

// Body frame (Three.js): +X right, +Y up (thrust), -Z forward (nose).
// Values are tuned for a 5" quad and scaled by prop size k = size / 5.
export function buildSpec(d) {
  const k = d.size / 5;
  const maxThrust = d.thrustToWeight * d.mass * 9.81; // N, fixed: payload lowers effective TWR
  return {
    mass: d.mass, // kg, incl. battery, without payload
    maxThrust,
    radius: 0.024 * d.size, // collision sphere, m
    airMode: true,

    // Motors: command 0..1 -> thrust ∝ command² (prop thrust ∝ rpm²)
    idle: 0.05,
    spoolUp: 0.03 * k, // s, time constant
    spoolDown: 0.05 * k,
    propPitchSpeed: 60 - (d.size - 5) * 3, // m/s at full rpm; thrust fades as inflow approaches it

    // Rate controller (stands in for PID + rotational inertia)
    rateTau: { pitch: 0.02 * k, roll: 0.02 * k, yaw: 0.045 * k }, // s
    maxAngAccel: { pitch: 440 / (k * k), roll: 440 / (k * k), yaw: 160 / (k * k) }, // rad/s²

    // Drag in body frame: F = -(linear·v + quad·v·|v|)
    drag: {
      linear: 0.05 * k, // N/(m/s)
      front: 0.011 * k * k, // N/(m/s)², along nose axis
      side: 0.014 * k * k,
      top: 0.016 * k * k, // falling flat / climbing
    },

    // Electrical: ~2.35 A per N of max thrust on 6S
    idleCurrent: 1,
    maxCurrent: maxThrust * 2.35 * (6 / d.cells),
    battery: { cells: d.cells, capacity: d.capacity, enabled: d.batterySim },
  };
}
