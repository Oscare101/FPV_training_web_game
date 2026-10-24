import * as THREE from 'three';
import { Drone } from './Drone.js';
import { Wind } from './Wind.js';
import { buildSpec } from './presets.js';
import { betaflightRate } from './rates.js';

const STEP = 1 / 500; // physics rate, independent of frame rate
const MAX_STEPS = 50;
const DEG = Math.PI / 180;
const ARM_THROTTLE_MAX = 0.05;
// Ground contact. A 5" survives a ~2.5 m drop or a fast skid on grass; it doesn't
// survive cartwheeling in at speed or landing on its side.
const LANDING_MAX_VSPEED = 7; // m/s (≈ 2.5 m free fall)
const LANDING_MAX_HSPEED = 12; // m/s skid
const LANDING_MIN_UP = Math.cos(75 * DEG); // touching down tilted more than 75° = crash
const BOUNCE_MIN_VSPEED = 1.5; // m/s, softer touchdowns stick
const BOUNCE_RESTITUTION = 0.25;
const GROUND_FRICTION = 4; // 1/s, sliding on grass
const GROUND_SETTLE = 8; // 1/s, quad rocks back onto its frame when motors are low
const CRASH_RESET_DELAY = 1; // s before a disarm resets a crashed quad
const RC_SMOOTHING_HZ = 25; // per PT2 stage; sticks arrive once per frame, physics runs at 500 Hz
const RC_SMOOTHING_K = STEP / (STEP + 1 / (2 * Math.PI * RC_SMOOTHING_HZ));
const STICKS = ['roll', 'pitch', 'yaw', 'throttle'];

// Two cascaded first-order low-pass stages (like Betaflight's RC smoothing).
class Pt2 {
  constructor() {
    this.a = 0;
    this.b = 0;
  }

  reset(v) {
    this.a = this.b = v;
  }

  update(v) {
    this.a += (v - this.a) * RC_SMOOTHING_K;
    this.b += (this.a - this.b) * RC_SMOOTHING_K;
    return this.b;
  }
}

const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _level = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _spawn = new THREE.Vector3();

// Owns the drone: input -> rates, arming, fixed-step physics, collisions, crash/reset.
export class FlightController {
  constructor(input, keyboard, world, settings) {
    this.input = input;
    this.keyboard = keyboard;
    this.world = world;
    this.settings = settings;
    this.wind = new Wind();
    this.drone = new Drone(buildSpec(settings.data.drone));
    this.env = { wind: new THREE.Vector3(), torque: new THREE.Vector3(), groundHeight: 0 };

    this.status = 'disarmed'; // 'disarmed' | 'armed' | 'crashed' | 'detonated'
    // Hooks for missions: onImpact(hit, drone) -> true to detonate instead of crash; onReset()
    this.onImpact = null;
    this.onReset = null;
    this.groundHit = { kind: 'ground', vDown: 0, skid: 0, hard: false };
    this.waterHit = { kind: 'water', vDown: 0, skid: 0, hard: true };
    this.armBlock = null; // 'throttle' when an arm attempt was refused
    this.crashTimer = 0;
    this.flightTime = 0;
    this.accumulator = 0;

    this.controls = { roll: 0, pitch: 0, yaw: 0, throttle: 0, arm: false, reset: false, radio: false, armMapped: false };
    this.prevArm = null;
    this.prevArmMapped = null;
    this.prevReset = false;
    this.cmd = { armed: false, throttle: 0, rates: new THREE.Vector3() };
    this.filters = Object.fromEntries(STICKS.map((k) => [k, new Pt2()]));

    // Pose for rendering, interpolated between the last two physics steps so motion
    // doesn't judder when a frame gets 8 steps and the next one 9.
    this.prevPosition = new THREE.Vector3();
    this.prevQuaternion = new THREE.Quaternion();
    this.renderPose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

    this.applySettings(settings.data);
    settings.onChange((data) => this.applySettings(data));
    this.reset();
  }

  applySettings(data) {
    this.rates = data.rates;
    this.drone.setSpec(buildSpec(data.drone));
    this.wind.configure(data.env);
    if (this.status !== 'armed') this.drone.payloadMass = data.drone.payload;
  }

  reset() {
    const { position, yaw } = this.world.spawn;
    const ground = this.world.heightAt(position.x, position.z);
    this.drone.reset(_spawn.set(position.x, ground + this.drone.spec.radius, position.z), yaw);
    this.drone.payloadMass = this.settings.data.drone.payload;
    this.status = 'disarmed';
    this.flightTime = 0;
    this.accumulator = 0;
    this.snapRenderPose();
    this.onReset?.();
  }

  snapRenderPose() {
    const d = this.drone;
    this.prevPosition.copy(d.position);
    this.prevQuaternion.copy(d.quaternion);
    this.renderPose.position.copy(d.position);
    this.renderPose.quaternion.copy(d.quaternion);
  }

  dropPayload() {
    this.drone.payloadMass = 0;
  }

  readControls() {
    const s = this.input.state;
    const kb = this.keyboard.state;
    const c = this.controls;
    const src = s.connected ? s : kb;
    c.radio = s.connected;
    c.roll = src.roll;
    c.pitch = src.pitch;
    c.yaw = src.yaw;
    c.throttle = src.throttle;
    c.armMapped = s.connected && s.arm !== null;
    c.arm = c.armMapped ? s.arm : kb.arm; // Space arms when no switch is mapped
    c.reset = s.connected && s.reset === true;
    return c;
  }

  update(dt, paused) {
    const c = this.readControls();
    // Arming needs a real off->on flip; changing arm source (radio plugged in) is not a flip.
    const armRise = c.arm && this.prevArm === false && this.prevArmMapped === c.armMapped;
    const keyboardReset = this.keyboard.consumeReset();
    const resetPressed = keyboardReset || (c.reset && !this.prevReset);
    this.prevArm = c.arm;
    this.prevArmMapped = c.armMapped;
    this.prevReset = c.reset;
    if (!c.arm) this.armBlock = null;
    if (paused) return;

    if (resetPressed) this.reset();

    switch (this.status) {
      case 'armed':
        if (!c.arm) this.status = 'disarmed';
        break;
      case 'disarmed':
        // hotArm (Hunt: next drone on the pad): an arm switch that is already on arms it
        if (armRise || (this.hotArm && c.arm)) {
          this.hotArm = false;
          if (c.throttle > ARM_THROTTLE_MAX) this.armBlock = 'throttle';
          else this.status = 'armed';
        }
        break;
      case 'crashed':
        this.crashTimer += dt;
        if (!c.arm && this.crashTimer >= CRASH_RESET_DELAY) this.reset();
        return;
      case 'detonated':
        return; // the mission decides what happens next
    }

    const cmd = this.cmd;
    const f = this.filters;
    cmd.armed = this.status === 'armed';
    if (!cmd.armed) for (const k of STICKS) f[k].reset(c[k]); // no smoothing lag on arm

    const d = this.drone;
    const env = this.env;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= STEP && steps < MAX_STEPS) {
      env.groundHeight = this.surfaceAt(d.position.x, d.position.z);
      const agl = d.position.y - env.groundHeight;
      this.wind.step(STEP);
      this.wind.velocityAt(agl, env.wind);
      this.wind.torqueAt(agl, env.torque);
      cmd.throttle = f.throttle.update(c.throttle);
      // Body rates (see Drone): +stick = right roll / nose down / right yaw = negative rotation
      cmd.rates.set(
        -betaflightRate(f.pitch.update(c.pitch), this.rates.pitch) * DEG,
        -betaflightRate(f.yaw.update(c.yaw), this.rates.yaw) * DEG,
        -betaflightRate(f.roll.update(c.roll), this.rates.roll) * DEG
      );
      this.prevPosition.copy(d.position);
      this.prevQuaternion.copy(d.quaternion);
      d.step(STEP, cmd, env);
      this.accumulator -= STEP;
      steps++;
      if (this.collide()) break;
    }
    if (cmd.armed) this.flightTime += dt;

    const alpha = Math.min(1, this.accumulator / STEP);
    this.renderPose.position.lerpVectors(this.prevPosition, d.position, alpha);
    this.renderPose.quaternion.slerpQuaternions(this.prevQuaternion, d.quaternion, alpha);
  }

  // Returns true on crash.
  collide() {
    const d = this.drone;
    const p = d.position;
    const v = d.velocity;
    const r = d.spec.radius;

    const hit = this.world.hitTest(p, r);
    if (hit) return this.onImpact?.(hit, d) ? this.detonate() : this.crash(hit.kind);

    // liquid water: always a crash (frozen water counts as ground)
    const water = this.world.waterAt?.(p.x, p.z) ?? null;
    if (water !== null && !this.world.waterFrozen && p.y < water + r) {
      this.waterHit.vDown = -v.y;
      this.waterHit.skid = Math.hypot(v.x, v.z);
      return this.onImpact?.(this.waterHit, d) ? this.detonate() : this.crash('water');
    }
    const ground = water !== null && this.world.waterFrozen ? Math.max(water, this.world.heightAt(p.x, p.z)) : this.world.heightAt(p.x, p.z);
    if (p.y < ground + r) {
      _up.set(0, 1, 0).applyQuaternion(d.quaternion);
      const g = this.groundHit;
      g.vDown = -v.y;
      g.skid = Math.hypot(v.x, v.z);
      g.hard = g.vDown > LANDING_MAX_VSPEED || g.skid > LANDING_MAX_HSPEED || _up.y < LANDING_MIN_UP;
      if (this.onImpact?.(g, d)) return this.detonate();
      if (g.hard) return this.crash('ground');
      p.y = ground + r;
      if (v.y < 0) v.y = -v.y > BOUNCE_MIN_VSPEED ? -v.y * BOUNCE_RESTITUTION : 0;
      const f = Math.exp(-STEP * GROUND_FRICTION);
      v.x *= f;
      v.z *= f;
      if (d.motor < 0.3) {
        _fwd.set(0, 0, -1).applyQuaternion(d.quaternion);
        _level.setFromAxisAngle(_yAxis, Math.atan2(-_fwd.x, -_fwd.z));
        d.quaternion.slerp(_level, 1 - Math.exp(-STEP * GROUND_SETTLE));
      }
    }
    return false;
  }

  crash(reason) {
    this.status = 'crashed';
    this.crashReason = reason;
    this.crashTimer = 0;
    this.accumulator = 0;
    this.drone.motor = 0;
    return true;
  }

  // Charge went off (impact or manual): drone is gone until reset.
  detonate() {
    this.status = 'detonated';
    this.accumulator = 0;
    this.drone.motor = 0;
    this.drone.velocity.set(0, 0, 0);
    return true;
  }

  // Ground or water surface height
  surfaceAt(x, z) {
    const ground = this.world.heightAt(x, z);
    const water = this.world.waterAt?.(x, z) ?? null;
    return water === null ? ground : Math.max(ground, water);
  }

  get altitude() {
    const p = this.drone.position;
    return p.y - this.surfaceAt(p.x, p.z) - this.drone.spec.radius;
  }

  get speed() {
    return this.drone.velocity.length();
  }
}
