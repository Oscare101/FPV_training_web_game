import * as THREE from 'three';
import { CHARGE_ARM_DISTANCE, fuseTriggered } from './strike.js';

const STATIC_TIME = 0.7;
const RESPAWN_TIME = 2.2; // s after a detonation until the next drone is on the pad

// Free Flight: no goal and no battery limit. Enemies optional; with a live charge (drone with a
// payload, enemies on) impacts detonate and damage vehicles, then a new drone is on the pad.
// Destroyed vehicles stay destroyed until "Reset enemies".
export class FreeFlight {
  constructor({ flight, world, settings, fx, hud }) {
    Object.assign(this, { flight, world, settings, fx, hud });
    this.state = 'ready'; // 'ready' | 'flying' | 'impact'
    this.chargeArmed = false;
    this.launch = new THREE.Vector3();
    this.timer = 0;
  }

  get observing() {
    return false;
  }

  get hidesOsd() {
    return this.state === 'impact';
  }

  get enemyRules() {
    const f = this.settings.data.free;
    return { reaction: f.reaction, alertness: f.alertness };
  }

  get liveCharge() {
    const f = this.settings.data.free;
    return f.enemies && f.liveCharge && this.settings.data.drone.payload > 0;
  }

  get pauseInfo() {
    const f = this.settings.data.free;
    return `Enemies ${f.enemies ? 'on' : 'off'}${this.liveCharge ? ' · live charge' : ''}`;
  }

  begin() {
    this.world.vehicles.reset();
    this.world.effects.reset();
    this.fx.reset();
    this.flight.reset();
  }

  end() {
    this.state = 'ready';
  }

  resetEnemies() {
    this.world.vehicles.reset();
    this.world.effects.reset();
    this.fx.reset();
  }

  onReset() {
    this.state = 'ready';
    this.chargeArmed = false;
    this.launch.copy(this.flight.drone.position);
  }

  handleImpact(hit, drone) {
    if (!this.liveCharge || !this.chargeArmed || this.state !== 'flying' || !fuseTriggered(hit, drone)) return false;
    this.blast(hit, drone);
    return true;
  }

  requestDetonate() {
    if (!this.liveCharge || this.state !== 'flying' || !this.chargeArmed || this.flight.status !== 'armed') return;
    this.blast({ kind: 'air' }, this.flight.drone);
    this.flight.detonate();
  }

  blast(hit, drone) {
    const r = this.fx.detonate(hit, drone);
    for (const v of r.changed) if (v.enemy) this.hud.feed(`${v.label} ${v.state}`, v.state === 'destroyed' ? 'good' : 'warn');
    this.state = 'impact';
    this.timer = 0;
  }

  update(dt) {
    const p = this.flight.drone.position;
    if (this.state === 'ready' && this.flight.status === 'armed') this.state = 'flying';
    if (this.state === 'flying' && !this.chargeArmed && Math.hypot(p.x - this.launch.x, p.z - this.launch.z) > CHARGE_ARM_DISTANCE) this.chargeArmed = true;
    if (this.state === 'impact') {
      this.timer += dt;
      if (this.timer > RESPAWN_TIME) this.flight.reset();
    }
  }

  drawHud(hud) {
    if (this.state === 'impact' && this.timer < STATIC_TIME) hud.staticFeed('SIGNAL LOST');
    else if (this.state === 'impact') hud.staticFeed('NEXT DRONE');
    else if (this.liveCharge) hud.charge(this.chargeArmed);
  }
}
