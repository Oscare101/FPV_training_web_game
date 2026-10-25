import * as THREE from 'three';
import { fuseTriggered } from './strike.js';

const ARM_DISTANCE = 20; // m, shorter than missions: fast pace
const STATIC_TIME = 0.6; // s of static, then the next drone is on the pad
const CRASH_RESPAWN = 1.2; // s after a crash (no detonation)
const END_DELAY = 2.5; // s after the last kill before the results (let the fire show)
const RESPAWN_DELAY = [10, 16]; // s until a destroyed vehicle is replaced (Endless)
const RESPAWN_CLEAR = 150; // m the drone must be away from the spawn point
const SCORES_KEY = 'fpv-trainer.hunt.best';
const ALERTNESS = 1;

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const rand = (a, b) => a + Math.random() * (b - a);

function loadScores() {
  try {
    return JSON.parse(localStorage.getItem(SCORES_KEY)) ?? {};
  } catch {
    return {};
  }
}

// Battlefield + rules key for best scores
export const huntKey = (h) => `${h.variant}|${h.variant === 'endless' ? h.duration : ''}|${h.seed}|${h.season}|${h.timeOfDay}|${h.weather}`;
export function bestScore(h) {
  return loadScores()[huntKey(h)] ?? null;
}

// Hunt: destroy vehicles with as many drones as it takes, no hints. Each detonation (or crash)
// costs a drone; the next one is on the pad within a second and arms straight away.
//   sweep   - fixed set of vehicles; clear them all, the clock stops at the last kill
//   endless - destroyed vehicles are replaced after a while; score kills until time runs out
export class Hunt {
  constructor({ flight, world, settings, fx, hud }) {
    Object.assign(this, { flight, world, settings, fx, hud });
    this.state = 'ready'; // 'ready' | 'flying' | 'impact' | 'crash' | 'over'
    this.launch = new THREE.Vector3();
    this.chargeArmed = false;
    this.timer = 0;
    this.respawns = []; // { v, t }
  }

  get observing() {
    return false;
  }

  get hidesOsd() {
    return this.state === 'impact' || this.state === 'over';
  }

  get enemyRules() {
    return { reaction: true, alertness: ALERTNESS };
  }

  get enemies() {
    return this.world.vehicles.list.filter((v) => v.enemy);
  }

  get pauseInfo() {
    return `${this.variant === 'endless' ? 'Endless' : 'Sweep'} · ${this.kills} destroyed · ${this.drones} drones`;
  }

  begin() {
    const h = this.settings.data.hunt;
    this.variant = h.variant;
    this.duration = h.variant === 'endless' ? h.duration : 0;
    this.config = { ...h };
    this.kills = 0;
    this.destroyedSeen = 0; // kills = destroyed transitions counted every frame (any cause)
    this.drones = 0;
    this.clock = 0;
    this.started = false;
    this.over = null;
    this.endTimer = 0;
    this.respawns.length = 0;
    this.total = this.enemies.length;
    this.hud.clearFeed();
    this.world.vehicles.reset();
    this.world.effects.reset();
    this.fx.reset();
    this.flight.reset(); // drone #1
  }

  end() {
    this.state = 'ready';
    this.flight.hotArm = false;
  }

  onReset() {
    if (this.over) return;
    if (this.state === 'flying') this.drones++; // reset mid-flight: that drone is gone too
    this.state = 'ready';
    this.chargeArmed = false;
    this.launch.copy(this.flight.drone.position);
    this.flight.hotArm = true; // arm switch already on: go
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
    this.drones++; // drones used
    const r = this.fx.detonate(hit, drone);
    for (const v of r.changed) {
      if (!v.enemy) continue;
      if (v.state === 'destroyed') {
        this.hud.feed(`+1  ${v.label} destroyed`, 'good');
        if (this.variant === 'endless') this.respawns.push({ v, t: rand(...RESPAWN_DELAY) });
      } else this.hud.feed(`${v.label} ${v.state}`, 'warn');
    }
    if (!r.changed.some((v) => v.enemy)) this.hud.feed('Miss', 'bad');
    this.state = 'impact';
    this.timer = 0;
  }

  get alive() {
    return this.enemies.filter((v) => v.state !== 'destroyed').length;
  }

  finish(reason) {
    this.over = { reason, time: this.clock, kills: this.kills, drones: this.drones };
    // best score: sweep = fastest clear (then fewest drones); endless = most kills
    const scores = loadScores();
    const key = huntKey(this.config);
    const prev = scores[key];
    const better = !prev || (reason === 'cleared'
      ? this.clock < prev.time - 0.05 || (Math.abs(this.clock - prev.time) < 0.05 && this.drones < prev.drones)
      : this.kills > prev.kills);
    this.over.prev = prev ?? null;
    this.over.record = better && (reason === 'cleared' || reason === 'time');
    if (this.over.record) {
      scores[key] = { time: this.clock, kills: this.kills, drones: this.drones, at: Date.now() };
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
    const destroyed = this.enemies.length - this.alive;
    if (destroyed > this.destroyedSeen) this.kills += destroyed - this.destroyedSeen;
    this.destroyedSeen = destroyed;
    if (!this.started && this.flight.status === 'armed') this.started = true;
    if (this.started) this.clock += dt;

    switch (this.state) {
      case 'ready':
        if (this.flight.status === 'armed') this.state = 'flying';
        break;
      case 'flying':
        if (!this.chargeArmed && Math.hypot(p.x - this.launch.x, p.z - this.launch.z) > ARM_DISTANCE) this.chargeArmed = true;
        if (this.flight.status === 'crashed') {
          this.state = 'crash';
          this.timer = 0;
          this.drones++;
          this.hud.feed('Drone lost', 'bad');
        }
        break;
      case 'impact':
      case 'crash':
        this.timer += dt;
        if (this.timer > (this.state === 'impact' ? STATIC_TIME : CRASH_RESPAWN)) this.flight.reset();
        break;
    }

    // Endless: replacements arrive once the drone is away from the spot
    for (let i = this.respawns.length - 1; i >= 0; i--) {
      const r = this.respawns[i];
      r.t -= dt;
      if (r.t > 0) continue;
      if (Math.hypot(p.x - r.v.home.x, p.z - r.v.home.z) < RESPAWN_CLEAR) {
        r.t = 2;
        continue;
      }
      this.world.vehicles.respawn(r.v);
      this.destroyedSeen--;
      this.respawns.splice(i, 1);
    }

    if (this.variant === 'sweep' && this.alive === 0) {
      this.endTimer += dt;
      if (this.endTimer > END_DELAY) this.finish('cleared');
    }
    if (this.duration && this.clock >= this.duration) this.finish('time');
  }

  drawHud(hud) {
    const left = this.duration ? Math.max(0, this.duration - this.clock) : null;
    const score = this.variant === 'sweep'
      ? `<b>${this.total - this.alive}</b> / ${this.total} <small>DESTROYED</small>`
      : `<b>${this.kills}</b> <small>DESTROYED</small>`;
    const clock = left === null ? fmt(this.clock) : `${fmt(left)} <small>LEFT</small>`;
    if (this.state !== 'over') hud.stats(`<span>${score}</span><span><b>${this.drones}</b> <small>DRONES USED</small></span><span class="${left !== null && left < 30 ? 'warn' : ''}">${clock}</span>`);
    if (this.state === 'ready' || this.state === 'flying') hud.charge(this.chargeArmed);
    if (this.state === 'ready' && this.drones === 0 && !this.started) hud.briefing(`hunt-${this.config.seed}`, this.briefingHtml());
    if (this.state === 'impact') hud.staticFeed('NEXT DRONE');
    if (this.state === 'over') hud.result(this.resultView());
  }

  briefingHtml() {
    return this.variant === 'sweep'
      ? `<b>HUNT — SWEEP</b><br>Destroy all ${this.total} enemy vehicles and ammo. No markers, no hints.<br>
        Every detonation or crash costs a drone; the next one is ready on the pad. The clock starts when you arm.<br>
        Charge arms ${ARM_DISTANCE} m from launch · X / detonate switch = manual`
      : `<b>HUNT — ENDLESS</b><br>Destroy as many vehicles as you can${this.duration ? ` in ${fmt(this.duration)}` : ''}. Destroyed ones are replaced.<br>
        Unlimited drones; the next one is ready on the pad. The clock starts when you arm.<br>
        Charge arms ${ARM_DISTANCE} m from launch · X / detonate switch = manual`;
  }

  resultView() {
    const o = this.over;
    const lines = [];
    const perDrone = o.drones ? (o.kills / o.drones).toFixed(2) : '0';
    if (o.reason === 'cleared') {
      lines.push(`Field cleared in <b>${fmt(o.time)}</b> with ${o.drones} drone${o.drones === 1 ? '' : 's'} · ${o.kills} kills (${perDrone} per drone)`);
      lines.push(o.record ? (o.prev ? `New best — previous ${fmt(o.prev.time)} with ${o.prev.drones} drones` : 'First clear of this battlefield') : `Best ${fmt(o.prev.time)} with ${o.prev.drones} drones`);
    } else {
      lines.push(`<b>${o.kills}</b> destroyed in ${fmt(o.time)} with ${o.drones} drones (${perDrone} per drone)`);
      lines.push(o.record ? (o.prev ? `New best — previous ${o.prev.kills}` : 'First score on this battlefield') : `Best ${o.prev.kills}`);
    }
    return {
      key: o,
      title: o.reason === 'cleared' ? 'FIELD CLEARED' : 'TIME',
      cls: 'good',
      lines,
      actions: [['again', 'Play again (Enter)', true], ['newfield', 'New battlefield'], ['menu', 'Main menu']],
    };
  }
}
