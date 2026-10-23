import * as THREE from 'three';
import { Battery } from './Battery.js';

export const GRAVITY = 9.81;

const _up = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _force = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _dq = new THREE.Quaternion();
const _axis = new THREE.Vector3();

// PID I-term stand-in: wind bumps excite a damped oscillation that returns the
// quad to its commanded attitude instead of leaving a permanent tilt.
const DIST_OMEGA = 18; // rad/s
const DIST_ZETA = 0.7;

const lerpExp = (from, to, dt, tau) => from + (to - from) * (1 - Math.exp(-dt / tau));
const clampAbs = (v, max) => (v > max ? max : v < -max ? -max : v);

// Rigid-body quad. Physics only: arming, crashes and input live in FlightController.
export class Drone {
  constructor(spec) {
    this.spec = spec;
    this.battery = new Battery(spec.battery);
    this.payloadMass = 0; // kg, can change in flight (drops)
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.angularVelocity = new THREE.Vector3(); // body frame, rad/s (x pitch, y yaw, z roll)
    this.distRate = new THREE.Vector3(); // disturbance part of the body rate
    this.distAngle = new THREE.Vector3();
    this.motor = 0; // 0..1 spooled motor output
    this.thrust = 0; // N, last step
    this.mix = new THREE.Vector3(); // -1..1 per axis: share of max angular accel used (motor differential)
  }

  get mass() {
    return this.spec.mass + this.payloadMass;
  }

  setSpec(spec) {
    this.spec = spec;
    this.battery.configure(spec.battery);
  }

  reset(position, yaw = 0) {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.quaternion.setFromAxisAngle(_axis.set(0, 1, 0), yaw);
    this.angularVelocity.set(0, 0, 0);
    this.distRate.set(0, 0, 0);
    this.distAngle.set(0, 0, 0);
    this.motor = 0;
    this.thrust = 0;
    this.battery.reset();
  }

  // cmd: { armed, throttle 0..1, rates: Vector3 target body rates rad/s }
  // env: { wind: Vector3 air velocity, torque: Vector3 body rad/s² disturbance, groundHeight }
  step(dt, cmd, env) {
    const s = this.spec;

    // Motors with spool lag
    const target = cmd.armed ? s.idle + (1 - s.idle) * cmd.throttle : 0;
    this.motor = lerpExp(this.motor, target, dt, target > this.motor ? s.spoolUp : s.spoolDown);

    const bat = this.battery;
    bat.step(dt, cmd.armed ? s.idleCurrent + s.maxCurrent * Math.pow(this.motor, 2.5) : 0.3);

    // Rotation: first-order tracking of commanded rates, limited by motor authority
    const w = this.angularVelocity;
    const wx0 = w.x;
    const wy0 = w.y;
    const wz0 = w.z;
    if (cmd.armed) {
      const authority = s.airMode ? 1 : Math.min(1, this.motor * 3);
      w.x += clampAbs(lerpExp(w.x, cmd.rates.x, dt, s.rateTau.pitch) - w.x, s.maxAngAccel.pitch * authority * dt);
      w.y += clampAbs(lerpExp(w.y, cmd.rates.y, dt, s.rateTau.yaw) - w.y, s.maxAngAccel.yaw * authority * dt);
      w.z += clampAbs(lerpExp(w.z, cmd.rates.z, dt, s.rateTau.roll) - w.z, s.maxAngAccel.roll * authority * dt);
      this.mix.set(
        (w.x - wx0) / (s.maxAngAccel.pitch * dt),
        (w.y - wy0) / (s.maxAngAccel.yaw * dt),
        (w.z - wz0) / (s.maxAngAccel.roll * dt)
      );
    } else {
      this.mix.set(0, 0, 0);
      w.multiplyScalar(Math.exp(-dt * 2)); // tumbling, aerodynamic damping only
    }
    const dr = this.distRate;
    const da = this.distAngle;
    if (cmd.armed) {
      const k = 2 * DIST_ZETA * DIST_OMEGA;
      const k2 = DIST_OMEGA * DIST_OMEGA;
      dr.x += (env.torque.x - k * dr.x - k2 * da.x) * dt;
      dr.y += (env.torque.y - k * dr.y - k2 * da.y) * dt;
      dr.z += (env.torque.z - k * dr.z - k2 * da.z) * dt;
      da.addScaledVector(dr, dt);
    } else {
      w.addScaledVector(env.torque, dt);
      dr.set(0, 0, 0);
      da.set(0, 0, 0);
    }
    _axis.copy(w).add(dr);
    const angle = _axis.length() * dt;
    if (angle > 0) {
      _dq.setFromAxisAngle(_axis.normalize(), angle);
      this.quaternion.multiply(_dq).normalize(); // body-frame rotation
    }

    // Aerodynamics use velocity relative to the air
    _rel.copy(this.velocity).sub(env.wind);

    // Thrust along body up, reduced by axial inflow (prop pitch speed limit)
    _up.set(0, 1, 0).applyQuaternion(this.quaternion);
    const inflow = _rel.dot(_up);
    const pitchSpeed = s.propPitchSpeed * Math.max(this.motor, 0.15);
    const inflowFactor = Math.min(1.5, Math.max(0, 1 - inflow / pitchSpeed));

    // Ground effect: 1 / (1 - (R / 4z)²), faded out when tilted
    const z = Math.max(this.position.y - env.groundHeight, 0.05);
    const ratio = s.radius / (4 * z);
    const groundEffect = 1 + (1 / (1 - Math.min(ratio * ratio, 0.25)) - 1) * Math.max(0, _up.y);

    this.thrust = s.maxThrust * this.motor * this.motor * inflowFactor * groundEffect * bat.thrustScale;
    _force.copy(_up).multiplyScalar(this.thrust);

    // Drag per body axis
    _qInv.copy(this.quaternion).invert();
    _vb.copy(_rel).applyQuaternion(_qInv);
    const d = s.drag;
    _vb.set(
      -(d.linear * _vb.x + d.side * _vb.x * Math.abs(_vb.x)),
      -(d.linear * _vb.y + d.top * _vb.y * Math.abs(_vb.y)),
      -(d.linear * _vb.z + d.front * _vb.z * Math.abs(_vb.z))
    ).applyQuaternion(this.quaternion);
    _force.add(_vb);

    // Semi-implicit Euler
    const m = this.mass;
    this.velocity.x += (_force.x / m) * dt;
    this.velocity.y += (_force.y / m - GRAVITY) * dt;
    this.velocity.z += (_force.z / m) * dt;
    this.position.addScaledVector(this.velocity, dt);
  }
}
