// LiPo pack: open-circuit voltage from state of charge, minus I·R sag.
// Thrust scales with voltage² (rpm ∝ V at a given throttle).
const OCV_CURVE = [
  [0, 3.27], [0.05, 3.5], [0.1, 3.6], [0.2, 3.69], [0.4, 3.76], [0.6, 3.85], [0.8, 3.98], [1, 4.2],
];
const REFERENCE_CELL_V = 3.9; // spec thrust is defined at this loaded cell voltage
const SAG_TAU = 0.05; // s, voltage response

function ocvPerCell(soc) {
  for (let i = 1; i < OCV_CURVE.length; i++) {
    const [s1, v1] = OCV_CURVE[i];
    if (soc <= s1) {
      const [s0, v0] = OCV_CURVE[i - 1];
      return v0 + ((soc - s0) / (s1 - s0)) * (v1 - v0);
    }
  }
  return OCV_CURVE[OCV_CURVE.length - 1][1];
}

export class Battery {
  constructor(cfg) {
    this.configure(cfg);
  }

  // Keeps the charge state unless the pack itself changed.
  configure({ cells, capacity, enabled }) {
    const changed = cells !== this.cells || capacity !== this.capacity;
    this.cells = cells;
    this.capacity = capacity; // mAh
    this.enabled = enabled;
    this.resistance = cells * 0.0045 * (1300 / capacity); // Ω, pack internal resistance
    if (changed) this.reset();
  }

  reset() {
    this.used = 0; // mAh
    this.current = 0;
    this.voltage = this.cells * ocvPerCell(1);
  }

  get soc() {
    return Math.max(0, 1 - this.used / this.capacity);
  }

  get cellVoltage() {
    return this.voltage / this.cells;
  }

  get thrustScale() {
    if (!this.enabled) return 1;
    const r = this.voltage / (this.cells * REFERENCE_CELL_V);
    return Math.min(1.2, Math.max(0.3, r * r));
  }

  step(dt, current) {
    this.current = current;
    this.used += (current * dt) / 3.6; // A·s -> mAh
    const target = this.cells * ocvPerCell(this.soc) - current * this.resistance;
    this.voltage += (target - this.voltage) * (1 - Math.exp(-dt / SAG_TAU));
  }
}
