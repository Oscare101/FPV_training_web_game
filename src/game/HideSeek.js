import * as THREE from 'three';
import { CHARGE_ARM_DISTANCE, fuseTriggered } from './strike.js';
import { SHELTER_LABEL } from '../world/shelters.js';

const STATIC_TIME = 0.6;
const CRASH_RESPAWN = 1.2;
const END_DELAY = 2.5;
const NEAR = 45; // m: inside this the hint says "ENEMY NEAR" instead of pointing
const HINT_OFFSET = { easy: 15, normal: 30, hard: 50 }; // m off the real position
const SCORES_KEY = 'fpv-trainer.hide.best';
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const HOW_IN = {
  nets: 'Net roof with a hole, closed sides, a flap over the front with a gap underneath.',
  barn: 'Plank shed: get in through the door, a window or a hole in the roof. Walls stop a blast.',
  dugout: 'Earth berms and a log roof stop a blast; the only way in is the low front.',
};

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function loadScores() {
  try {
    return JSON.parse(localStorage.getItem(SCORES_KEY)) ?? {};
  } catch {
    return {};
  }
}
export function hideBest(difficulty) {
  return loadScores()[difficulty] ?? null;
}

// Hide & Seek: one parked vehicle in a hideout close to the launch point. The crew stays put; the
// challenge is getting in: slow, precise flying through gaps. Unlimited drones (each detonation
// or crash costs one), scored on drones used, then time.
export class HideSeek {
  constructor({ flight, world, settings, fx, hud }) {
    Object.assign(this, { flight, world, settings, fx, hud });
    this.state = 'ready';
    this.launch = new THREE.Vector3();
    this.chargeArmed = false;
    this.timer = 0;
  }

  get observing() {
    return false;
  }

  get hidesOsd() {
    return this.state === 'impact' || this.state === 'over';
  }

  get enemyRules() {
    return { reaction: false, alertness: 1 }; // dug in: nobody drives off
  }

  get pauseInfo() {
    return `${this.difficulty[0].toUpperCase() + this.difficulty.slice(1)} · ${SHELTER_LABEL[this.shelter]} · ${this.drones} drones used`;
  }

  begin(conditions) {
    this.difficulty = this.settings.data.hide.difficulty;
    this.shelter = conditions.shelter;
    this.conditions = conditions;
    this.target = this.world.vehicles.list.find((v) => v.home?.shelter) ?? this.world.vehicles.list[0];
    const a = Math.random() * Math.PI * 2;
    const off = HINT_OFFSET[this.difficulty] * (0.5 + Math.random() * 0.5);
    this.hint = { x: this.target.x + Math.cos(a) * off, z: this.target.z + Math.sin(a) * off };
    this.retry();
  }

  // same hideout from scratch
  retry() {
    this.drones = 0;
    this.clock = 0;
    this.started = false;
    this.over = null;
    this.endTimer = 0;
    this.attemptKey = Math.random();
    this.hud.clearFeed();
    this.world.vehicles.reset();
    this.world.effects.reset();
    this.fx.reset();
    this.flight.reset();
  }

  end() {
    this.state = 'ready';
    this.flight.hotArm = false;
  }

  onReset() {
    if (this.over) return;
    if (this.state === 'flying') this.drones++;
    this.state = 'ready';
    this.chargeArmed = false;
    this.launch.copy(this.flight.drone.position);
    this.flight.hotArm = true;
    if (this.drones > 0) this.hud.banner(`DRONE ${this.drones + 1}`, 900);
  }

  handleImpact(hit, drone) {
    if (!this.chargeArmed || this.state !== 'flying' || !fuseTriggered(hit, drone)) return false;
    this.blast(hit, drone);
    return true;
  }

  requestDetonate() {
    if (this.state !== 'flying' || !this.chargeArmed || this.flight.status !== 'armed') return;
    this.blast({ kind: 'air' }, this.flight.drone);
    this.flight.detonate();
  }

  blast(hit, drone) {
    this.drones++;
    const before = this.target.state;
    const r = this.fx.detonate(hit, drone);
    if (this.target.state !== before) this.hud.feed(`${this.target.label} ${this.target.state}${r.struck === this.target ? ` · ${r.zone}` : hit.kind === 'net' ? ' · through the net' : ' · blast'}`, this.target.state === 'destroyed' ? 'good' : 'warn');
    else this.hud.feed(hit.kind === 'net' ? 'Caught in the net · no effect' : hit.kind === 'vehicle' ? 'Hit · no further effect' : `Detonated on ${hit.kind} · no effect`, 'bad');
    this.state = 'impact';
    this.timer = 0;
  }

  finish() {
    const scores = loadScores();
    const prev = scores[this.difficulty] ?? null;
    const better = !prev || this.drones < prev.drones || (this.drones === prev.drones && this.clock < prev.time);
    this.over = { time: this.clock, drones: this.drones, prev, record: better };
    if (better) {
      scores[this.difficulty] = { drones: this.drones, time: this.clock, at: Date.now() };
      try {
        localStorage.setItem(SCORES_KEY, JSON.stringify(scores));
      } catch {
        // storage unavailable
      }
    }
    this.state = 'over';
    this.flight.hotArm = false;
  }

  update(dt) {
    if (this.over) return;
    const p = this.flight.drone.position;
    if (!this.started && this.flight.status === 'armed') this.started = true;
    if (this.started) this.clock += dt;
    switch (this.state) {
      case 'ready':
        if (this.flight.status === 'armed') this.state = 'flying';
        break;
      case 'flying':
        if (!this.chargeArmed && Math.hypot(p.x - this.launch.x, p.z - this.launch.z) > CHARGE_ARM_DISTANCE) this.chargeArmed = true;
        if (this.flight.status === 'crashed') {
          this.state = 'crash';
          this.timer = 0;
          this.drones++;
          this.hud.feed(this.flight.crashReason === 'net' ? 'Tangled in the net' : 'Drone lost', 'bad');
        }
        break;
      case 'impact':
      case 'crash':
        this.timer += dt;
        if (this.timer > (this.state === 'impact' ? STATIC_TIME : CRASH_RESPAWN)) this.flight.reset();
        break;
    }
    if (this.target.state === 'destroyed') {
      this.endTimer += dt;
      if (this.endTimer > END_DELAY) this.finish();
    }
  }

  drawHud(hud) {
    if (this.state !== 'over') {
      hud.stats(`<span><small>TARGET</small> <b>${this.target.state.toUpperCase()}</b></span><span><b>${this.drones}</b> <small>DRONES USED</small></span><span>${fmt(this.clock)}</span>`);
    }
    const flying = this.state === 'ready' || this.state === 'flying';
    if (flying) {
      hud.charge(this.chargeArmed);
      const p = this.flight.drone.position;
      hud.hint(p, this.hint.x, this.hint.z, Math.hypot(this.target.x - p.x, this.target.z - p.z) < NEAR);
    }
    if (this.state === 'ready' && this.drones === 0 && !this.started) hud.briefing(`hide-${this.attemptKey}`, this.briefingHtml());
    if (this.state === 'impact') hud.staticFeed('NEXT DRONE');
    if (this.state === 'over') hud.result(this.resultView());
  }

  briefingHtml() {
    const dx = this.hint.x - this.launch.x;
    const dz = this.hint.z - this.launch.z;
    const b = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
    return `<b>HIDE &amp; SEEK — ${this.difficulty.toUpperCase()}</b><br>
      ${/^[AEIOU]/.test(this.target.label) ? 'An' : 'A'} <b>${/^[A-Z]{3}$/.test(this.target.label) ? this.target.label : this.target.label.toLowerCase()}</b> is dug in in a <b>${SHELTER_LABEL[this.shelter]}</b>, ~${Math.round(Math.hypot(dx, dz) / 10) * 10} m ${COMPASS[Math.round(b / 45) % 8]}. It won't move.<br>
      ${HOW_IN[this.shelter]} Fly slowly and find the way in. Nets catch the drone: fast = the charge goes off on the net.<br>
      Unlimited drones · charge arms ${CHARGE_ARM_DISTANCE} m from launch · X / detonate switch = manual`;
  }

  resultView() {
    const o = this.over;
    const lines = [`${this.target.label} in the ${SHELTER_LABEL[this.shelter]} destroyed in <b>${fmt(o.time)}</b> with <b>${o.drones}</b> drone${o.drones === 1 ? '' : 's'}`];
    lines.push(o.record ? (o.prev ? `New best on ${this.difficulty} — previous ${o.prev.drones} drones, ${fmt(o.prev.time)}` : `First kill on ${this.difficulty}`) : `Best on ${this.difficulty}: ${o.prev.drones} drones, ${fmt(o.prev.time)}`);
    return {
      key: o,
      title: 'TARGET DESTROYED',
      cls: 'good',
      lines,
      actions: [['next', 'Next hideout (Enter)', true], ['again', 'Retry this one'], ['menu', 'Main menu']],
    };
  }
}
