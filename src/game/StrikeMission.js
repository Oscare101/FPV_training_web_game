import * as THREE from 'three';
import { CHARGE_ARM_DISTANCE, EFFECT_RANK, fuseTriggered } from './strike.js';

const STATIC_TIME = 0.7; // s of video static after detonation
const OBSERVE_TIME = 4; // s of observer view before results
const NEAR_RADIUS = 150; // m, medium mode: "ENEMY NEAR" inside this distance of the position
const HINT_OFFSET = [60, 140]; // m, medium mode: how far the hinted point is off the real position
export const STRIKE_ALERTNESS = { easy: 0.6, medium: 1, hard: 1.4 };

const WEAK_SPOTS = {
  tank: 'engine deck (rear), turret roof; tracks immobilize',
  ifv: 'engine (front), roof, sides, rear doors; tracks immobilize',
  apc: 'engine (rear), roof, sides; wheels immobilize',
  truck: 'any hit',
  car: 'any hit',
  ammo: 'any hit — secondary explosions',
};
const OBSTACLE = {
  tree: 'a tree', bush: 'a bush', building: 'a building', pole: 'a pole', wreck: 'a burnt-out wreck', fence: 'a fence', net: 'a camo net',
  ground: 'the ground', water: 'the water', air: 'mid-air (manual)',
};
const OUTCOME = {
  destroyed: ['DESTROYED', 'good'],
  immobilized: ['IMMOBILIZED', 'good'],
  damaged: ['DAMAGED', 'warn'],
  miss: ['MISS', 'bad'],
  wrong: ['WRONG TARGET', 'bad'],
};
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const SEASON = { spring: 'spring', summer: 'summer', autumn: 'autumn', winter: 'winter' };
const WEATHER = { clear: 'clear', partly: 'partly cloudy', overcast: 'overcast', rain: 'rain', snow: 'snowfall', fog: 'fog' };

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const bearingOf = (dx, dz) => ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360; // 0 = north (-Z)
const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];

// Strike Missions: one kamikaze strike per attempt. Difficulty:
//   easy   - one assigned target with an exact marker; other vehicles are wrong targets
//   medium - rough bearing/distance to an enemy position, "ENEMY NEAR" when close; any enemy counts
//   hard   - only the sector; find the enemy yourself; any enemy counts
// Charge arms after launch, impact fuse, feed cuts to static, observer view, results.
export class StrikeMission {
  constructor({ flight, world, settings, fx }) {
    this.flight = flight;
    this.world = world;
    this.settings = settings;
    this.fx = fx;
    this.state = 'off'; // 'ready' | 'flying' | 'impact' | 'observe' | 'result'
    this.difficulty = 'easy';
    this.conditions = null; // rolled conditions of this mission (for the briefing)
    this.target = null; // easy
    this.area = null; // medium: { x, z, hintX, hintZ, count }
    this.chargeArmed = false;
    this.launch = new THREE.Vector3();
    this.timer = 0;
    this.observeCenter = new THREE.Vector3();
    this.approach = new THREE.Vector3(0, 0, -1);
    this.result = null;
    this.attempt = 0;
    this.session = { strikes: 0, destroyed: 0 };
    this.notice = '';
  }

  get observing() {
    return this.state === 'observe' || this.state === 'result';
  }

  get hidesOsd() {
    return this.state === 'impact' || this.observing;
  }

  get enemyRules() {
    return { reaction: true, alertness: STRIKE_ALERTNESS[this.difficulty] };
  }

  get enemies() {
    return this.world.vehicles.list.filter((v) => v.enemy);
  }

  get pauseInfo() {
    return `${this.difficulty[0].toUpperCase() + this.difficulty.slice(1)} · attempt ${this.attempt}`;
  }

  // New mission on the freshly built map (the game builds it); conditions: rolled weather, or null
  begin(conditions, notice = '') {
    this.difficulty = this.settings.data.strike.difficulty;
    this.conditions = conditions;
    this.notice = notice;
    this.pickTarget();
    this.attempt = 0;
    this.flight.reset(); // -> onReset
  }

  retry() {
    this.flight.reset();
  }

  end() {
    this.state = 'off';
  }

  pickTarget() {
    const enemies = this.enemies;
    this.target = enemies[Math.floor(Math.random() * enemies.length)];
    // Medium: one enemy position, hinted with an offset so the direction is only approximate
    const sites = this.world.layout.sites.filter((s) => s.items.length);
    const site = sites[Math.floor(Math.random() * sites.length)] ?? { x: this.target.x, z: this.target.z, items: [] };
    const a = Math.random() * Math.PI * 2;
    const off = HINT_OFFSET[0] + Math.random() * (HINT_OFFSET[1] - HINT_OFFSET[0]);
    this.area = { x: site.x, z: site.z, hintX: site.x + Math.cos(a) * off, hintZ: site.z + Math.sin(a) * off, count: site.items.length };
  }

  onReset() {
    this.world.vehicles.reset();
    this.world.effects.reset();
    this.fx.reset();
    this.state = 'ready';
    this.chargeArmed = false;
    this.result = null;
    this.attempt++;
    this.launch.copy(this.flight.drone.position);
  }

  handleImpact(hit, drone) {
    if (!this.chargeArmed || this.state !== 'flying' || !fuseTriggered(hit, drone)) return false;
    this.resolve(hit, drone);
    return true;
  }

  requestDetonate() {
    if (this.state !== 'flying' || !this.chargeArmed || this.flight.status !== 'armed') return;
    this.resolve({ kind: 'air' }, this.flight.drone);
    this.flight.detonate();
  }

  resolve(hit, drone) {
    const easy = this.difficulty === 'easy';
    const enemies = this.enemies;
    const result = {
      difficulty: this.difficulty,
      impactSpeed: drone.velocity.length(),
      flightTime: this.flight.flightTime,
      batteryUsed: drone.battery.used,
      spotted: null, // s the earliest enemy had been aware of the drone, or null
      missDistance: null,
    };
    for (const v of enemies) {
      const s = v.driver?.state;
      if (s?.aware) result.spotted = Math.max(result.spotted ?? 0, s.time - s.awareSince);
    }
    const blast = this.fx.detonate(hit, drone);
    Object.assign(result, { struck: blast.struck, zone: blast.zone, obstacle: blast.obstacle, destroyed: blast.destroyed, others: blast.changed.filter((v) => v.enemy && v !== this.target) });
    if (easy) {
      const otherHit = blast.changed.some((v) => v.enemy && v !== this.target);
      if (blast.struck && blast.struck !== this.target) result.outcome = 'wrong';
      else if (this.target.state === 'intact') result.outcome = otherHit ? 'wrong' : 'miss';
      else result.outcome = this.target.state;
      result.focus = this.target;
    } else {
      const hitEnemies = blast.changed.filter((v) => v.enemy);
      hitEnemies.sort((a, b) => EFFECT_RANK[b.state] - EFFECT_RANK[a.state]);
      result.focus = blast.struck ?? hitEnemies[0] ?? null;
      result.outcome = hitEnemies.length ? hitEnemies[0].state : 'miss';
    }
    if (result.outcome === 'miss') {
      const vehicles = this.world.vehicles;
      const nearest = (easy ? [this.target] : enemies.filter((v) => v.state !== 'destroyed')).reduce((best, v) => {
        const d = vehicles.distanceTo(v, blast.pos);
        return d < best.d ? { v, d } : best;
      }, { v: null, d: Infinity });
      result.missDistance = nearest.d;
      result.focus = nearest.v;
    }
    this.session.strikes++;
    this.session.destroyed += result.destroyed;
    this.result = result;
    this.observeCenter.copy(blast.pos);
    this.approach.copy(drone.velocity).setY(0);
    if (this.approach.lengthSq() < 0.01) this.approach.set(0, 0, -1).applyQuaternion(drone.quaternion).setY(0);
    this.approach.normalize();
    this.state = 'impact';
    this.timer = 0;
  }

  update(dt) {
    const d = this.flight.drone;
    switch (this.state) {
      case 'ready':
        if (this.flight.status === 'armed') this.state = 'flying';
        break;
      case 'flying':
        if (!this.chargeArmed && Math.hypot(d.position.x - this.launch.x, d.position.z - this.launch.z) > CHARGE_ARM_DISTANCE) this.chargeArmed = true;
        break;
      case 'impact':
      case 'observe':
        this.timer += dt;
        if (this.timer > STATIC_TIME) this.state = 'observe';
        if (this.timer > STATIC_TIME + OBSERVE_TIME) this.state = 'result';
        break;
      case 'result':
        this.timer += dt;
        break;
    }
  }

  // ---------- HUD ----------

  drawHud(hud) {
    const st = this.state;
    if (st === 'ready') hud.briefing(`strike-${this.world.layout.seed}-${this.attempt}`, this.briefingHtml());
    const inFlight = st === 'ready' || st === 'flying';
    if (inFlight) {
      let extra = '';
      if (this.difficulty === 'easy') extra = `TGT ${Math.round(hud.marker(this.target, this.flight.drone.position))} m`;
      hud.charge(this.chargeArmed, extra);
      if (this.difficulty === 'medium') {
        const p = this.flight.drone.position;
        hud.hint(p, this.area.hintX, this.area.hintZ, Math.hypot(this.area.x - p.x, this.area.z - p.z) < NEAR_RADIUS);
      }
    }
    if (st === 'impact') hud.staticFeed('SIGNAL LOST');
    if (st === 'result') hud.result(this.resultView());
  }

  briefingHtml() {
    const charge = `Charge arms ${CHARGE_ARM_DISTANCE} m from launch · impact fuse · X / detonate switch = manual`;
    const c = this.conditions;
    const cond = c ? `<span class="briefing-cond">${SEASON[c.season]} · ${c.timeOfDay} · ${WEATHER[c.weather]} · wind ${c.windSpeed} m/s</span><br>` : '';
    const notice = this.notice ? `<br><i>${this.notice}</i>` : '';
    if (this.difficulty === 'easy') {
      const t = this.target;
      const dx = t.x - this.launch.x;
      const dz = t.z - this.launch.z;
      const b = bearingOf(dx, dz);
      return `<b>STRIKE — EASY</b><br>${cond}
        Target: <b>${t.label}</b> — ${t.moving ? 'moving' : 'parked'}, ${Math.round(Math.hypot(dx, dz))} m ${compass(b)} (${Math.round(b)}°)<br>
        Weak spots: ${WEAK_SPOTS[t.type]}<br>${charge}${notice}`;
    }
    if (this.difficulty === 'medium') {
      const a = this.area;
      const dx = a.hintX - this.launch.x;
      const dz = a.hintZ - this.launch.z;
      return `<b>STRIKE — MEDIUM</b><br>${cond}
        Enemy position reported ~${Math.round(Math.hypot(dx, dz) / 100) * 100} m, roughly ${compass(bearingOf(dx, dz))}. Expect ${a.count} targets.<br>
        Any enemy vehicle or ammo is a target. Look under tree lines and nets.<br>${charge}${notice}`;
    }
    return `<b>STRIKE — HARD</b><br>${cond}
      Enemy positions somewhere ahead, 500–900 m from launch. Find them yourself.<br>
      Any enemy vehicle or ammo is a target. Burnt-out wrecks are not.<br>${charge}${notice}`;
  }

  resultView() {
    const r = this.result;
    const [title, cls] = OUTCOME[r.outcome];
    const done = r.outcome === 'destroyed' || r.outcome === 'immobilized';
    const subject = r.difficulty === 'easy' ? 'TARGET' : r.focus ? r.focus.label.toUpperCase() : 'ENEMY';
    const lines = [];
    if (r.outcome === 'wrong' && !r.struck) {
      lines.push(`The blast hit the ${r.others.map((v) => `${v.label.toLowerCase()} (${v.state})`).join(', ')} — the target was the ${this.target.label.toLowerCase()}`);
    } else if (r.struck) {
      lines.push(r.outcome === 'wrong'
        ? `Hit a ${r.struck.label.toLowerCase()} (${r.struck.state}) — the target was the ${this.target.label.toLowerCase()}`
        : `${r.struck.label}: ${r.zone} hit`);
    } else if (r.outcome === 'miss') {
      lines.push(`Detonated on ${OBSTACLE[r.obstacle] ?? r.obstacle}, ${r.missDistance.toFixed(1)} m from the nearest ${r.difficulty === 'easy' ? 'target' : 'enemy'}${r.focus ? ` (${r.focus.label.toLowerCase()})` : ''}`);
    } else {
      lines.push(`Detonated on ${OBSTACLE[r.obstacle] ?? r.obstacle} — the blast reached the ${r.focus.label.toLowerCase()}`);
    }
    if (r.destroyed > 1) lines.push(`${r.destroyed} enemy targets destroyed by this strike`);
    lines.push(r.spotted === null ? 'Nobody spotted you' : `The enemy spotted you ${r.spotted.toFixed(1)} s before impact`);
    lines.push(`Impact speed ${Math.round(r.impactSpeed * 3.6)} km/h · flight time ${fmtTime(r.flightTime)} · battery ${Math.round(r.batteryUsed)} mAh`);
    lines.push(`Session: ${this.session.strikes} strikes · ${this.session.destroyed} enemy targets destroyed`);
    return {
      key: r,
      title: r.outcome === 'miss' || r.outcome === 'wrong' ? title : `${subject} ${title}`,
      cls,
      lines,
      // the next mission unlocks once the target is out of the fight (destroyed, or a mobility kill)
      actions: done
        ? [['next', 'Next mission (Enter)', true], ['retry', 'Retry'], ['menu', 'Main menu']]
        : [['retry', 'Retry (Enter)', true], ['next', 'Next mission', false, 'Destroy or immobilize the target first'], ['menu', 'Main menu']],
    };
  }
}
