import * as THREE from 'three';

const CHARGE_ARM_DISTANCE = 30; // m from launch before the charge arms
const FUSE_VSPEED = 3; // m/s, ground touchdown that sets off the impact fuse
const FUSE_SKID = 6;
const STATIC_TIME = 0.7; // s of video static after detonation
const OBSERVE_TIME = 4; // s of observer view before results
const STRIKE_PRESETS = ['7strike', 'custom'];
const NEAR_RADIUS = 150; // m, medium mode: "ENEMY NEAR" inside this distance of the position
const HINT_OFFSET = [60, 140]; // m, medium mode: how far the hinted point is off the real position

const WEAK_SPOTS = {
  tank: 'engine deck (rear), turret roof; tracks immobilize',
  ifv: 'engine (front), roof, sides, rear doors; tracks immobilize',
  apc: 'engine (rear), roof, sides; wheels immobilize',
  truck: 'any hit',
  car: 'any hit',
  ammo: 'any hit — secondary explosions',
};
const OBSTACLE = {
  tree: 'a tree', bush: 'a bush', building: 'a building', pole: 'a pole', wreck: 'a burnt-out wreck',
  ground: 'the ground', air: 'mid-air (manual)',
};
const OUTCOME = {
  destroyed: ['DESTROYED', 'good'],
  immobilized: ['IMMOBILIZED', 'good'],
  damaged: ['DAMAGED', 'warn'],
  miss: ['MISS', 'bad'],
  wrong: ['WRONG TARGET', 'bad'],
};
const EFFECT_RANK = { intact: 0, damaged: 1, immobilized: 2, destroyed: 3 };
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const bearingOf = (dx, dz) => ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360; // 0 = north (-Z)
const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];

// Blast without a direct hit: soft vehicles suffer nearby, armor needs it almost touching.
function nearMissEffect(v, distance) {
  if (v.armored) return distance <= 1 ? 'damaged' : null;
  if (distance <= 2) return 'destroyed';
  if (distance <= 5) return 'damaged';
  return null;
}

// Kamikaze strike. Target modes:
//   easy   - one assigned target with an exact marker; other vehicles are wrong targets
//   medium - rough bearing/distance to an enemy position, "ENEMY NEAR" when close; any enemy counts
//   hard   - only the sector; find the enemy yourself; any enemy counts
// Charge arms after launch, impact fuse, feed cuts to static, observer view, results.
export class StrikeMission {
  constructor({ flight, world, audio, settings, input, parent, regenerate }) {
    this.flight = flight;
    this.world = world;
    this.audio = audio;
    this.settings = settings;
    this.input = input;
    this.regenerate = regenerate;

    this.active = false;
    this.state = 'off'; // 'off' | 'ready' | 'flying' | 'impact' | 'observe' | 'result'
    this.mode = 'easy';
    this.target = null; // easy mode
    this.area = null; // medium mode: { x, z, hintX, hintZ, count }
    this.chargeArmed = false;
    this.launch = new THREE.Vector3();
    this.timer = 0;
    this.observeCenter = new THREE.Vector3();
    this.approach = new THREE.Vector3(0, 0, -1);
    this.result = null;
    this.session = { strikes: 0, destroyed: 0 };
    this.secondary = []; // pending ammo cook-off blasts { t, pos }
    this.prevDetonate = false;
    this.notice = '';

    flight.onImpact = (hit, drone) => this.handleImpact(hit, drone);
    flight.onReset = () => this.handleReset();

    this.buildUi(parent);
  }

  get observing() {
    return this.state === 'observe' || this.state === 'result';
  }

  get hidesOsd() {
    return this.state === 'impact' || this.observing;
  }

  get enemies() {
    return this.world.vehicles.list.filter((v) => v.enemy);
  }

  // ---------- flow ----------

  // fresh = new mission (new target, and a new map if enabled); otherwise same map and target.
  // newMap = false when the caller already built a fresh map.
  start(fresh = true, newMap = fresh) {
    this.notice = '';
    if (!STRIKE_PRESETS.includes(this.settings.data.drone.preset)) {
      this.settings.applyPreset('7strike');
      this.notice = 'Drone switched to 7" strike (change it in Esc → Drone).';
    }
    if (newMap && this.settings.data.map.newMapEachMission) this.regenerate();
    this.mode = this.settings.data.mission.targetMode;
    if (fresh || !this.target) this.pickTarget();
    this.active = true;
    this.flight.reset(); // -> handleReset
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.state = 'off';
    this.world.vehicles.reset();
    this.world.effects.reset();
    this.flight.reset();
    this.updateUi();
  }

  retry() {
    if (this.active) this.flight.reset();
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

  handleReset() {
    if (!this.active) return;
    this.world.vehicles.reset();
    this.world.effects.reset();
    this.state = 'ready';
    this.chargeArmed = false;
    this.result = null;
    this.secondary.length = 0;
    this.launch.copy(this.flight.drone.position);
  }

  handleImpact(hit, drone) {
    if (!this.active || !this.chargeArmed || this.state !== 'flying') return false;
    if (hit.kind === 'ground' && !hit.hard && hit.vDown < FUSE_VSPEED && hit.skid < FUSE_SKID) return false; // soft landing
    this.resolve(hit, drone);
    return true;
  }

  requestDetonate() {
    if (this.state !== 'flying' || !this.chargeArmed || this.flight.status !== 'armed') return;
    this.resolve({ kind: 'air' }, this.flight.drone);
    this.flight.detonate();
  }

  resolve(hit, drone) {
    const pos = drone.position.clone();
    const vehicles = this.world.vehicles;
    const enemies = this.enemies;
    const before = new Map(vehicles.list.map((v) => [v, v.state]));
    const easy = this.mode === 'easy';
    const result = {
      mode: this.mode,
      impactSpeed: drone.velocity.length(),
      flightTime: this.flight.flightTime,
      batteryUsed: drone.battery.used,
      zone: null,
      obstacle: null,
      missDistance: null,
      struck: null,
      spotted: null, // s the earliest enemy had been aware of the drone, or null
      destroyed: 0,
    };
    for (const v of enemies) {
      const s = v.driver?.state;
      if (s?.aware) result.spotted = Math.max(result.spotted ?? 0, s.time - s.awareSince);
    }

    if (hit.kind === 'vehicle') {
      result.struck = hit.vehicle;
      result.zone = hit.zone;
      vehicles.damage(hit.vehicle, hit.effect);
    } else {
      result.obstacle = hit.kind;
    }
    // Blast effect on everything nearby
    for (const v of vehicles.list) {
      if (v === result.struck) continue;
      const effect = nearMissEffect(v, vehicles.distanceTo(v, pos));
      if (effect) vehicles.damage(v, effect);
    }

    const changed = vehicles.list.filter((v) => v.state !== before.get(v));
    result.destroyed = changed.filter((v) => v.enemy && v.state === 'destroyed').length;
    if (easy) {
      if (result.struck && result.struck !== this.target) result.outcome = 'wrong';
      else result.outcome = this.target.state === 'intact' ? 'miss' : this.target.state;
      result.focus = this.target;
    } else {
      // Best effect on any enemy
      const hitEnemies = changed.filter((v) => v.enemy);
      hitEnemies.sort((a, b) => EFFECT_RANK[b.state] - EFFECT_RANK[a.state]);
      result.focus = result.struck ?? hitEnemies[0] ?? null;
      result.outcome = hitEnemies.length ? hitEnemies[0].state : 'miss';
    }
    if (result.outcome === 'miss') {
      const alive = enemies.filter((v) => v.state !== 'destroyed');
      const nearest = (easy ? [this.target] : alive).reduce(
        (best, v) => {
          const d = vehicles.distanceTo(v, pos);
          return d < best.d ? { v, d } : best;
        },
        { v: null, d: Infinity }
      );
      result.missDistance = nearest.d;
      result.focus = nearest.v;
    }

    // Effects: fireball, smoke from whatever changed state, ammo cooks off
    this.world.effects.explode(pos);
    for (const v of changed) {
      if (v.state === 'destroyed') this.world.effects.burn(v.mesh, 4);
      else if (v.state === 'immobilized') this.world.effects.burn(v.mesh, 2, 10);
      else this.world.effects.burn(v.mesh, 1.5, 4);
      if (v.type === 'ammo' && v.state === 'destroyed') {
        for (let k = 0; k < 4; k++) {
          const p = v.mesh.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 1 + Math.random() * 2, (Math.random() - 0.5) * 4));
          this.secondary.push({ t: 0.5 + k * 0.45 + Math.random() * 0.3, pos: p });
        }
      }
    }
    this.audio.playExplosion();

    this.session.strikes++;
    this.session.destroyed += result.destroyed;

    this.result = result;
    this.observeCenter.copy(pos);
    this.approach.copy(drone.velocity).setY(0);
    if (this.approach.lengthSq() < 0.01) this.approach.set(0, 0, -1).applyQuaternion(drone.quaternion).setY(0);
    this.approach.normalize();
    this.state = 'impact';
    this.timer = 0;
  }

  update(dt) {
    if (!this.active) return;
    const s = this.input.state;
    const detonate = s.detonate === true;
    if (detonate && !this.prevDetonate) this.requestDetonate();
    this.prevDetonate = detonate;

    for (const b of this.secondary) {
      b.t -= dt;
      if (b.t <= 0 && !b.done) {
        b.done = true;
        this.world.effects.explode(b.pos);
        this.audio.playExplosion();
      }
    }

    const d = this.flight.drone;
    switch (this.state) {
      case 'ready':
        if (this.flight.status === 'armed') this.state = 'flying';
        break;
      case 'flying':
        if (!this.chargeArmed && Math.hypot(d.position.x - this.launch.x, d.position.z - this.launch.z) > CHARGE_ARM_DISTANCE) {
          this.chargeArmed = true;
        }
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

  // ---------- UI ----------

  buildUi(parent) {
    const root = document.createElement('div');
    root.className = 'mission';
    root.innerHTML = `
      <div class="mission-briefing"></div>
      <div class="mission-hint"><div class="mission-hint-arrow">▲</div><span></span></div>
      <div class="mission-hud"><div class="mission-charge"></div><div class="mission-dist"></div></div>
      <div class="mission-marker"><div class="mission-marker-shape"></div><span></span></div>
      <canvas class="mission-static" width="160" height="90"></canvas>
      <div class="mission-signal">SIGNAL LOST</div>
      <div class="mission-result">
        <h1></h1>
        <div class="mission-result-lines"></div>
        <div class="row-actions">
          <button data-action="retry">Retry (Enter / R)</button>
          <button data-action="new">New mission (2)</button>
          <button data-action="free" class="secondary">Free flight (1)</button>
        </div>
      </div>`;
    parent.appendChild(root);
    const q = (sel) => root.querySelector(sel);
    this.ui = {
      root,
      briefing: q('.mission-briefing'),
      hint: q('.mission-hint'),
      hintArrow: q('.mission-hint-arrow'),
      hintText: q('.mission-hint span'),
      hud: q('.mission-hud'),
      charge: q('.mission-charge'),
      dist: q('.mission-dist'),
      marker: q('.mission-marker'),
      markerShape: q('.mission-marker-shape'),
      markerText: q('.mission-marker span'),
      static: q('.mission-static'),
      signal: q('.mission-signal'),
      result: q('.mission-result'),
      resultTitle: q('.mission-result h1'),
      resultLines: q('.mission-result-lines'),
    };
    this.staticCtx = this.ui.static.getContext('2d');
    this.staticImage = this.staticCtx.createImageData(160, 90);
    q('.mission-result').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'retry') this.retry();
      if (btn.dataset.action === 'new') this.start(true);
      if (btn.dataset.action === 'free') this.stop();
      btn.blur();
    });
    this.resultShown = null;
    this.updateUi();
  }

  briefingHtml() {
    const charge = `Charge arms ${CHARGE_ARM_DISTANCE} m from launch · impact fuse · X / detonate switch = manual`;
    const notice = this.notice ? `<br><i>${this.notice}</i>` : '';
    if (this.mode === 'easy') {
      const t = this.target;
      const dx = t.x - this.launch.x;
      const dz = t.z - this.launch.z;
      const b = bearingOf(dx, dz);
      return `<b>STRIKE — EASY</b><br>
        Target: <b>${t.label}</b> — ${t.moving ? 'moving' : 'parked'}, ${Math.round(Math.hypot(dx, dz))} m ${compass(b)} (${Math.round(b)}°)<br>
        Weak spots: ${WEAK_SPOTS[t.type]}<br>${charge}${notice}`;
    }
    if (this.mode === 'medium') {
      const a = this.area;
      const dx = a.hintX - this.launch.x;
      const dz = a.hintZ - this.launch.z;
      return `<b>STRIKE — MEDIUM</b><br>
        Enemy position reported ~${Math.round(Math.hypot(dx, dz) / 100) * 100} m, roughly ${compass(bearingOf(dx, dz))}. Expect ${a.count} targets.<br>
        Any enemy vehicle or ammo is a target. Look under tree lines and nets.<br>${charge}${notice}`;
    }
    const o = this.settings.data.map;
    return `<b>STRIKE — HARD</b><br>
      Enemy positions somewhere ahead, ${o.launchMin}–${o.launchMax} m from launch. Find them yourself.<br>
      Any enemy vehicle or ammo is a target. Burnt-out wrecks are not.<br>${charge}${notice}`;
  }

  // Call after the camera is updated for this frame.
  updateUi() {
    const ui = this.ui;
    const st = this.state;
    ui.root.hidden = !this.active;
    if (!this.active) return;

    ui.briefing.hidden = st !== 'ready';
    if (st === 'ready' && this.briefingFor !== this.target) {
      ui.briefing.innerHTML = this.briefingHtml();
      this.briefingFor = this.target;
    }

    const inFlight = st === 'ready' || st === 'flying';
    ui.hud.hidden = !inFlight;
    if (inFlight) {
      ui.charge.textContent = this.chargeArmed ? 'CHARGE ARMED' : 'CHARGE SAFE';
      ui.charge.classList.toggle('armed', this.chargeArmed);
    }
    const showMarker = inFlight && this.mode === 'easy';
    ui.dist.hidden = !showMarker;
    this.updateMarker(showMarker);
    this.updateHint(inFlight && this.mode === 'medium');

    const showStatic = st === 'impact';
    ui.static.hidden = !showStatic;
    ui.signal.hidden = !showStatic;
    if (showStatic) this.drawStatic();

    ui.result.hidden = st !== 'result';
    if (st === 'result' && this.resultShown !== this.result) this.showResult();
  }

  // Medium mode: arrow toward the hinted point relative to where the camera looks
  updateHint(show) {
    const ui = this.ui;
    ui.hint.hidden = !show;
    if (!show) return;
    const p = this.flight.drone.position;
    const a = this.area;
    const near = Math.hypot(a.x - p.x, a.z - p.z) < NEAR_RADIUS;
    ui.hint.classList.toggle('near', near);
    if (near) {
      ui.hintText.textContent = 'ENEMY NEAR';
      ui.hintArrow.hidden = true;
      return;
    }
    ui.hintArrow.hidden = false;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.world.camera.quaternion);
    const heading = Math.atan2(fwd.x, -fwd.z);
    const toHint = Math.atan2(a.hintX - p.x, -(a.hintZ - p.z));
    ui.hintArrow.style.transform = `rotate(${toHint - heading}rad)`;
    ui.hintText.textContent = `~${Math.round(Math.hypot(a.hintX - p.x, a.hintZ - p.z) / 50) * 50} m`;
  }

  updateMarker(show) {
    const ui = this.ui;
    ui.marker.hidden = !show;
    if (!show) return;
    const camera = this.world.camera;
    const t = this.target;
    const p = new THREE.Vector3().copy(t.mesh.position);
    p.y += t.half.y * 2;
    const dist = p.distanceTo(this.flight.drone.position);
    ui.dist.textContent = `TGT ${Math.round(dist)} m`;

    const toTarget = p.clone().sub(camera.position);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const behind = toTarget.dot(forward) < 0;
    p.project(camera);
    let x = p.x;
    let y = p.y;
    if (behind) {
      x = -x;
      y = -y;
    }
    const margin = 0.9;
    const onScreen = !behind && Math.abs(x) < margin && Math.abs(y) < margin;
    if (!onScreen) {
      const k = margin / Math.max(Math.abs(x), Math.abs(y), 1e-6);
      x *= k;
      y *= k;
    }
    const sx = ((x + 1) / 2) * window.innerWidth;
    const sy = ((1 - y) / 2) * window.innerHeight;
    ui.marker.style.transform = `translate(${sx}px, ${sy}px)`;
    ui.marker.classList.toggle('edge', !onScreen);
    ui.markerShape.style.transform = onScreen ? 'rotate(45deg)' : `rotate(${Math.atan2(x, y)}rad)`;
    const spotted = t.driver?.state.aware ?? false;
    ui.markerText.textContent = `${Math.round(dist)} m${spotted ? ' · SPOTTED' : ''}`;
    ui.marker.classList.toggle('spotted', spotted);
  }

  drawStatic() {
    const data = this.staticImage.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.random() * 255;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
    this.staticCtx.putImageData(this.staticImage, 0, 0);
  }

  showResult() {
    const r = this.result;
    this.resultShown = r;
    const [title, cls] = OUTCOME[r.outcome];
    const subject = r.mode === 'easy' ? 'TARGET' : r.focus ? r.focus.label.toUpperCase() : 'ENEMY';
    this.ui.resultTitle.textContent = r.outcome === 'miss' || r.outcome === 'wrong' ? title : `${subject} ${title}`;
    this.ui.resultTitle.className = cls;
    const lines = [];
    if (r.struck) {
      lines.push(r.outcome === 'wrong'
        ? `Hit a ${r.struck.label.toLowerCase()} (${r.struck.state}) — the target was the ${this.target.label.toLowerCase()}`
        : `${r.struck.label}: ${r.zone} hit`);
    } else if (r.outcome === 'miss') {
      lines.push(`Detonated on ${OBSTACLE[r.obstacle] ?? r.obstacle}, ${r.missDistance.toFixed(1)} m from the nearest ${r.mode === 'easy' ? 'target' : 'enemy'}${r.focus ? ` (${r.focus.label.toLowerCase()})` : ''}`);
    } else {
      lines.push(`Detonated on ${OBSTACLE[r.obstacle] ?? r.obstacle} — the blast reached the ${r.focus.label.toLowerCase()}`);
    }
    if (r.destroyed > 1) lines.push(`${r.destroyed} enemy targets destroyed by this strike`);
    lines.push(r.spotted === null ? 'Nobody spotted you' : `The enemy spotted you ${r.spotted.toFixed(1)} s before impact`);
    lines.push(`Impact speed ${Math.round(r.impactSpeed * 3.6)} km/h · flight time ${fmtTime(r.flightTime)} · battery ${Math.round(r.batteryUsed)} mAh`);
    lines.push(`Session: ${this.session.strikes} strikes · ${this.session.destroyed} enemy targets destroyed`);
    this.ui.resultLines.innerHTML = lines.map((l) => `<div>${l}</div>`).join('');
  }
}
