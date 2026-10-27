import * as THREE from 'three';
import { CHARGE_ARM_DISTANCE, fuseTriggered } from './strike.js';
import { SHELTER_LABEL } from '../world/shelters.js';

const STATIC_TIME = 0.6;
const CRASH_RESPAWN = 1.2;
const END_DELAY = 2.5;
// Direction hint per difficulty: offset (m) of the point it shows from the hideouts, distance
// rounding (0 = none), and how close to a hideout it switches to "ENEMY NEAR" and stops pointing
const HINT = {
  easy: { offset: 0, round: 10, near: 20 }, // straight at the (only) hideout
  normal: { offset: 25, round: 25, near: 50 },
  hard: { offset: 60, round: 0, near: 90 },
};
const SCORES_KEY = 'fpv-trainer.hide.best';
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const HOW_IN = {
  net: 'A camouflage net over poles, pegged to the ground. Look for where it was left loose: an end tied up, a side that doesn\'t reach the ground, a tear.',
  dugout: 'A pit under a log-and-earth roof: earth stops a blast. The only way in is the ramp at the back.',
  building: 'Parked inside a farm shed or garage: brick walls stop a blast. Get in through a gate, a broken window or a shell hole in the roof.',
};
const SETTING = { treeline: 'by a tree line', forest: 'at a forest edge', village: 'in a village yard', ravine: 'in a ravine', field: 'in the open' };

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
    // the hint points at the area of all the hideouts (it doesn't tell which one is occupied)
    this.hideouts = this.world.layout.hideouts?.length ? this.world.layout.hideouts : [this.target];
    const cx = this.hideouts.reduce((s, h) => s + h.x, 0) / this.hideouts.length;
    const cz = this.hideouts.reduce((s, h) => s + h.z, 0) / this.hideouts.length;
    const a = Math.random() * Math.PI * 2;
    this.hintCfg = HINT[this.difficulty] ?? HINT.normal;
    const off = this.hintCfg.offset * (0.6 + Math.random() * 0.4);
    this.hint = { x: cx + Math.cos(a) * off, z: cz + Math.sin(a) * off };
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
    else if (hit.kind === 'net') {
      // fast into a net: the fuse fires on the net, short of the hull (a slow touch tangles instead)
      const d = this.world.vehicles.distanceTo(this.target, r.pos);
      this.hud.feed(`Charge went off on the net, ${d.toFixed(1)} m from the ${this.target.label.toLowerCase()} · no damage`, 'bad');
    } else this.hud.feed(hit.kind === 'vehicle' ? 'Hit · no further effect' : `Detonated on ${hit.kind} · no effect`, 'bad');
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
      const near = this.hideouts.some((h) => Math.hypot(h.x - p.x, h.z - p.z) < this.hintCfg.near);
      hud.hint(p, this.hint.x, this.hint.z, near, this.hintCfg.round);
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
      ${/^[AEIOU]/.test(this.target.label) ? 'An' : 'A'} <b>${/^[A-Z]{3}$/.test(this.target.label) ? this.target.label : this.target.label.toLowerCase()}</b> is hidden ${this.shelter === 'net' ? 'under a' : 'in a'} <b>${SHELTER_LABEL[this.shelter]}</b> ~${Math.round(Math.hypot(dx, dz) / 10) * 10} m ${COMPASS[Math.round(b / 45) % 8]}. It won't move.<br>
      ${this.hideouts.length > 1 ? `Recon found <b>${this.hideouts.length} hideouts</b> there; only one is occupied. Faint tracks lead to each of them.<br>` : 'Faint tracks lead to it from the nearest road.<br>'}
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
