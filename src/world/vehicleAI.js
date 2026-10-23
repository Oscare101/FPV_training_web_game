// Vehicle "drivers": perception (can they see the drone?) and natural driving
// (speed/turn limits), with evasive manoeuvres once the drone is spotted.

const DEG = Math.PI / 180;
const AI_TICK = 0.1; // s, perception + decisions at 10 Hz; driving integrates every frame
const LOS_STEP = 3; // m between line-of-sight samples

// Driving limits. pivot: tracked vehicles can turn on the spot.
const DRIVE = {
  car: { maxSpeed: 22, accel: 3.5, brake: 8, turnRadius: 6, maxYawRate: 1.2, yawAccel: 4, pivot: false },
  truck: { maxSpeed: 15, accel: 1.6, brake: 5, turnRadius: 10, maxYawRate: 0.7, yawAccel: 1.5, pivot: false },
  apc: { maxSpeed: 16, accel: 1.8, brake: 5, turnRadius: 9, maxYawRate: 0.7, yawAccel: 1.5, pivot: false },
  ifv: { maxSpeed: 14, accel: 1.6, brake: 4.5, turnRadius: 6, maxYawRate: 0.6, yawAccel: 1.2, pivot: true },
  tank: { maxSpeed: 11, accel: 1.0, brake: 3.5, turnRadius: 7, maxYawRate: 0.45, yawAccel: 0.8, pivot: true },
};

// What the crew can see. halfFov: horizontal half-angle from the nose; elevMax: highest
// angle above horizontal they can look; detectTime: seconds of view to spot at ~60 m.
const VISION = {
  car: { height: 1.3, halfFov: 115, elevMax: 50, range: 300, detectTime: 0.8, memory: 6 },
  truck: { height: 2.3, halfFov: 95, elevMax: 35, range: 250, detectTime: 1.2, memory: 6 },
  apc: { height: 2.2, halfFov: 50, elevMax: 25, range: 200, detectTime: 1.8, memory: 8 },
  ifv: { height: 2.0, halfFov: 45, elevMax: 25, range: 200, detectTime: 2.0, memory: 8 },
  tank: { height: 2.0, halfFov: 35, elevMax: 20, range: 180, detectTime: 2.5, memory: 8 },
};

// Reaction: delay before acting once spotted, engine start for parked vehicles,
// how often a new manoeuvre is chosen, and manoeuvre weights.
const BEHAVIOR = {
  car: { reaction: 0.5, startup: 1.2, decide: [1.2, 3], weights: { dash: 0.35, brake: 0.25, swerve: 0.3, cover: 0.1 } },
  truck: { reaction: 0.9, startup: 2.5, decide: [2, 4], weights: { dash: 0.3, brake: 0.2, swerve: 0.2, cover: 0.3 } },
  apc: { reaction: 1.0, startup: 2.5, decide: [2, 4.5], weights: { dash: 0.3, brake: 0.2, swerve: 0.2, cover: 0.3 } },
  ifv: { reaction: 1.1, startup: 3, decide: [2, 5], weights: { dash: 0.25, brake: 0.2, swerve: 0.2, cover: 0.35 } },
  tank: { reaction: 1.5, startup: 4.5, decide: [3, 6], weights: { dash: 0.2, brake: 0.2, swerve: 0.2, cover: 0.4 } },
};

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rand = (a, b) => a + Math.random() * (b - a);
// Our yaw convention: nose = (-sin yaw, -cos yaw)
const yawTo = (dx, dz) => Math.atan2(-dx, -dz);

function pick(weights) {
  let r = Math.random() * Object.values(weights).reduce((a, b) => a + b, 0);
  for (const [k, w] of Object.entries(weights)) {
    if ((r -= w) <= 0) return k;
  }
  return Object.keys(weights)[0];
}

// Closest distance along the route to (x, z), searched between s0 and s1
function closestOnRoute(route, x, z, s0 = 0, s1 = route.total) {
  const { points, lengths } = route;
  let best = Infinity;
  let bestS = 0;
  for (let i = 1; i < points.length; i++) {
    if (lengths[i] < s0 || lengths[i - 1] > s1) continue;
    const [ax, az] = points[i - 1];
    const [bx, bz] = points[i];
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    const t = clamp(((x - ax) * ex + (z - az) * ez) / len2, 0, 1);
    const px = ax + ex * t;
    const pz = az + ez * t;
    const d = (x - px) ** 2 + (z - pz) ** 2;
    if (d < best) {
      best = d;
      bestS = lengths[i - 1] + t * Math.sqrt(len2);
    }
  }
  return { s: bestS, dist: Math.sqrt(best) };
}

export function createDriver(v, { heightAt, colliders, sampleRoute, coverPoints, half }) {
  const bound = half - 60;
  const drive = DRIVE[v.type];
  const vision = VISION[v.type];
  const behavior = BEHAVIOR[v.type];
  const sample = { x: 0, z: 0, yaw: 0 };
  const probe = { x: 0, y: 0, z: 0 };

  const d = {
    mode: 'idle', // 'patrol' | 'parked' | 'react' | 'startup' | 'evade' | 'recover' | 'hold' | 'dead'
    timer: 0,
    tick: Math.random() * AI_TICK,
    awareness: 0,
    aware: false,
    awareSince: 0,
    lastSeen: -Infinity,
    seeing: false,
    knownX: 0,
    knownZ: 0,
    maneuver: null,
    maneuverTimer: 0,
    maneuverYaw: 0,
    cover: null,
    avoidYaw: 0,
    avoidTimer: 0,
    stuckTimer: 0,
    time: 0,
    desiredYaw: 0,
    targetSpeed: 0,
  };

  function reset(home) {
    Object.assign(d, {
      awareness: 0, aware: false, lastSeen: -Infinity, seeing: false, maneuver: null,
      avoidTimer: 0, stuckTimer: 0, timer: 0, cover: null,
    });
    v.speed = 0;
    v.yawRate = 0;
    if (v.moving) {
      v.s = home.start * v.route.total;
      v.dir = home.dir;
      sampleRoute(v.route, v.s, sample);
      v.x = sample.x;
      v.z = sample.z;
      v.yaw = sample.yaw + (v.dir < 0 ? Math.PI : 0);
      v.speed = v.patrolSpeed;
      d.mode = 'patrol';
    } else {
      v.x = home.x;
      v.z = home.z;
      v.yaw = home.yaw;
      d.mode = 'parked';
    }
    d.desiredYaw = v.yaw;
    d.targetSpeed = v.speed;
  }

  // ---------- perception ----------

  // Fine steps near the vehicle (berms, pit edges are only a few metres wide), coarser further out
  function lineOfSight(sx, sy, sz, tx, ty, tz, dist) {
    for (let s = 1; s < dist - 1; s += s < 12 ? 1 : LOS_STEP) {
      const t = s / dist;
      probe.x = sx + (tx - sx) * t;
      probe.y = sy + (ty - sy) * t;
      probe.z = sz + (tz - sz) * t;
      if (heightAt(probe.x, probe.z) > probe.y) return false; // hill in the way
      if (colliders.hits(probe, 0)) return false; // tree crown, building...
    }
    return true;
  }

  let alert = 1; // alertness multiplier from settings

  function canSee(threat) {
    if (!threat) return false;
    const base = v.mesh.position.y;
    const sx = v.x;
    const sy = base + vision.height;
    const sz = v.z;
    const p = threat.position;
    const dx = p.x - sx;
    const dy = p.y - sy;
    const dz = p.z - sz;
    const distH = Math.hypot(dx, dz);
    const dist = Math.hypot(distH, dy);
    if (dist > vision.range * Math.sqrt(alert) || p.y - heightAt(p.x, p.z) < 1) return false; // too far, or on the ground
    const angle = Math.abs(wrap(yawTo(dx, dz) - v.yaw)) / DEG;
    if (angle > vision.halfFov) return false;
    // Under a camo net or a pile of branches the crew can barely look up
    const underNet = (v.netMesh && Math.hypot(v.x - v.home.x, v.z - v.home.z) < 2) || v.branchMesh;
    if (Math.atan2(dy, distH) / DEG > (underNet ? 8 : vision.elevMax)) return false;
    return lineOfSight(sx, sy, sz, p.x, p.y, p.z, dist);
  }

  function perceive(threat, dt) {
    d.seeing = canSee(threat);
    if (d.seeing) {
      const dist = Math.hypot(threat.position.x - v.x, threat.position.z - v.z);
      d.awareness += (dt * alert) / (vision.detectTime * (0.5 + dist / 120));
      d.knownX = threat.position.x;
      d.knownZ = threat.position.z;
      if (d.awareness >= 1) {
        if (!d.aware) d.awareSince = d.time;
        d.aware = true;
        d.awareness = 1;
        d.lastSeen = d.time;
      }
    } else if (!d.aware) {
      d.awareness = Math.max(0, d.awareness - dt * 0.25);
    } else if (d.time - d.lastSeen > vision.memory) {
      d.aware = false;
      d.awareness = 0;
    }
  }

  // ---------- decisions ----------

  function nearestCover() {
    let best = null;
    let bestD = Infinity;
    for (const c of coverPoints) {
      const dd = (c[0] - v.x) ** 2 + (c[1] - v.z) ** 2;
      // prefer cover that isn't toward the drone
      const toward = (c[0] - v.x) * (d.knownX - v.x) + (c[1] - v.z) * (d.knownZ - v.z) > 0 ? 3 : 1;
      if (dd * toward < bestD) {
        bestD = dd * toward;
        best = c;
      }
    }
    return best;
  }

  function chooseManeuver() {
    d.maneuver = pick(behavior.weights);
    d.maneuverTimer = rand(...behavior.decide);
    const away = yawTo(v.x - d.knownX, v.z - d.knownZ);
    if (d.maneuver === 'dash') d.maneuverYaw = away + rand(-0.6, 0.6);
    if (d.maneuver === 'swerve') d.maneuverYaw = v.yaw + (Math.random() < 0.5 ? -1 : 1) * rand(60, 120) * DEG;
    if (d.maneuver === 'brake') d.maneuverTimer = rand(1, 2.5);
    if (d.maneuver === 'cover') {
      d.cover = nearestCover();
      d.maneuverTimer *= 2;
    }
  }

  function patrolTarget() {
    const lookahead = 10 + v.speed * 1.5;
    const window = 40;
    v.s = closestOnRoute(v.route, v.x, v.z, v.s - window, v.s + window).s;
    if (v.dir > 0 && v.s > v.route.total - 6) v.dir = -1;
    if (v.dir < 0 && v.s < 6) v.dir = 1;
    sampleRoute(v.route, clamp(v.s + v.dir * lookahead, 0, v.route.total), sample);
    return yawTo(sample.x - v.x, sample.z - v.z);
  }

  function decide(dt) {
    d.timer -= dt;
    switch (d.mode) {
      case 'patrol':
        d.desiredYaw = patrolTarget();
        d.targetSpeed = v.patrolSpeed;
        if (d.aware) { d.mode = 'react'; d.timer = behavior.reaction; }
        break;
      case 'parked':
        d.targetSpeed = 0;
        if (d.aware) { d.mode = 'startup'; d.timer = behavior.reaction + behavior.startup; }
        break;
      case 'react':
      case 'startup':
        if (d.timer <= 0) { d.mode = 'evade'; chooseManeuver(); }
        break;
      case 'evade': {
        if (!d.aware) { d.mode = v.moving ? 'recover' : 'hold'; break; }
        d.maneuverTimer -= dt;
        if (d.maneuverTimer <= 0) chooseManeuver();
        const away = yawTo(v.x - d.knownX, v.z - d.knownZ);
        if (d.maneuver === 'dash') {
          const weave = v.type === 'car' ? Math.sin(d.time * 1.7) * 0.35 : 0;
          d.desiredYaw = d.maneuverYaw + weave;
          d.targetSpeed = drive.maxSpeed;
          d.maneuverYaw += wrap(away - d.maneuverYaw) * dt * 0.3; // keep drifting away from the drone
        } else if (d.maneuver === 'brake') {
          d.targetSpeed = 0;
        } else if (d.maneuver === 'swerve') {
          d.desiredYaw = d.maneuverYaw;
          d.targetSpeed = drive.maxSpeed * 0.8;
        } else if (d.maneuver === 'cover' && d.cover) {
          const dx = d.cover[0] - v.x;
          const dz = d.cover[1] - v.z;
          d.desiredYaw = yawTo(dx, dz);
          d.targetSpeed = Math.hypot(dx, dz) < 8 ? 0 : drive.maxSpeed;
        }
        break;
      }
      case 'recover': {
        if (d.aware) { d.mode = 'evade'; chooseManeuver(); break; }
        const near = closestOnRoute(v.route, v.x, v.z);
        if (near.dist < 6) {
          v.s = near.s;
          d.mode = 'patrol';
          break;
        }
        sampleRoute(v.route, near.s, sample);
        d.desiredYaw = yawTo(sample.x - v.x, sample.z - v.z);
        d.targetSpeed = Math.min(v.patrolSpeed * 1.5, drive.maxSpeed);
        break;
      }
      case 'hold':
        d.targetSpeed = 0;
        if (d.aware) { d.mode = 'evade'; chooseManeuver(); }
        break;
    }
    avoidObstacles(dt);
  }

  // Look ahead for trunks, buildings, map edge; steer to the first clear heading.
  function blocked(yaw, dist) {
    probe.x = v.x - Math.sin(yaw) * dist;
    probe.z = v.z - Math.cos(yaw) * dist;
    if (Math.abs(probe.x) > bound || Math.abs(probe.z) > bound) return true;
    probe.y = heightAt(probe.x, probe.z) + 1.2;
    return !!colliders.hits(probe, v.half.x + 0.5);
  }

  function avoidObstacles(dt) {
    if (d.targetSpeed < 0.5) return;
    d.avoidTimer -= dt;
    if (d.avoidTimer > 0) {
      d.desiredYaw = d.avoidYaw;
      return;
    }
    const dist = v.half.z + 3 + Math.abs(v.speed) * 1.2;
    if (!blocked(d.desiredYaw, dist) && !blocked(d.desiredYaw, dist * 0.5)) return;
    const side = Math.random() < 0.5 ? 1 : -1;
    for (const off of [0.4, 0.8, 1.2, 1.6, 2.2]) {
      for (const sgn of [side, -side]) {
        const yaw = d.desiredYaw + sgn * off;
        if (!blocked(yaw, dist) && !blocked(yaw, dist * 0.5)) {
          d.avoidYaw = yaw;
          d.avoidTimer = 1;
          d.desiredYaw = yaw;
          return;
        }
      }
    }
    d.targetSpeed = 0; // boxed in
  }

  // ---------- driving ----------

  function integrate(dt) {
    const err = wrap(d.desiredYaw - v.yaw);
    const speedAbs = Math.abs(v.speed);
    const maxRate = drive.pivot ? drive.maxYawRate : Math.min(drive.maxYawRate, speedAbs / drive.turnRadius);
    const wantRate = clamp(err * 2, -maxRate, maxRate);
    v.yawRate += clamp(wantRate - v.yawRate, -drive.yawAccel * dt, drive.yawAccel * dt);
    if (!drive.pivot && speedAbs < 0.1) v.yawRate = 0;
    v.yaw = wrap(v.yaw + v.yawRate * dt);

    // Slow down for sharp turns (tanks nearly stop to pivot)
    const turn = Math.abs(err);
    let target = d.targetSpeed;
    if (turn > 0.3) target *= drive.pivot ? clamp(1 - turn, 0.1, 1) : clamp(1.2 - turn * 0.6, 0.35, 1);
    if (v.state === 'damaged') target *= 0.6;
    v.speed += clamp(target - v.speed, -drive.brake * dt, drive.accel * dt);

    v.x -= Math.sin(v.yaw) * v.speed * dt;
    v.z -= Math.cos(v.yaw) * v.speed * dt;

    // Stuck: wants to move but isn't (e.g. wedged among trees) -> pick a new heading
    if (d.targetSpeed > 2 && speedAbs < 0.5) d.stuckTimer += dt;
    else d.stuckTimer = 0;
    if (d.stuckTimer > 3) {
      d.stuckTimer = 0;
      d.avoidYaw = v.yaw + Math.PI + rand(-0.8, 0.8);
      d.avoidTimer = 2;
    }
  }

  function update(dt, threat, reactions, alertness = 1) {
    alert = alertness;
    d.time += dt;
    if (v.state === 'destroyed' || v.state === 'immobilized') {
      d.mode = 'dead';
      v.speed = 0;
      v.yawRate = 0;
      d.seeing = false;
      return;
    }
    d.tick += dt;
    if (d.tick >= AI_TICK) {
      const step = d.tick;
      d.tick = 0;
      if (reactions) perceive(threat, step);
      else {
        d.seeing = false;
        d.aware = false;
      }
      decide(step);
    }
    integrate(dt);
  }

  return { state: d, reset, update };
}
