// Vehicle "drivers": perception (can they see the drone?) and natural driving
// (speed/turn limits). Once the drone is spotted they plan a path on the drivability grid to a
// far destination or to cover, drive all of it (reversing / three-point turns when needed),
// and never through trees or buildings.

import { isSolidForVehicles } from './colliders.js';

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

// Reaction: delay before acting once spotted, engine start for parked vehicles, what they do
// (flee far away vs drive to cover), and how often light vehicles throw in a sudden brake/swerve.
const BEHAVIOR = {
  car: { reaction: 0.5, startup: 1.2, goals: { flee: 0.7, cover: 0.3 }, jink: 0.5 },
  truck: { reaction: 0.9, startup: 2.5, goals: { flee: 0.55, cover: 0.45 }, jink: 0.3 },
  apc: { reaction: 1.0, startup: 2.5, goals: { flee: 0.55, cover: 0.45 }, jink: 0.25 },
  ifv: { reaction: 1.1, startup: 3, goals: { flee: 0.5, cover: 0.5 }, jink: 0.2 },
  tank: { reaction: 1.5, startup: 4.5, goals: { flee: 0.45, cover: 0.55 }, jink: 0.1 },
};
const REVERSE_SPEED = 3.5; // m/s
const ARRIVE = 7; // m from the destination counts as arrived
const FLEE = [220, 480]; // m, how far a fleeing vehicle goes in one leg
const COVER = [60, 450]; // m, cover points considered
const HIDE_RECOVER = [20, 40]; // s hidden before a patrolling vehicle goes back to its route
// Traffic: keep right on routes (oncoming vehicles pass), keep a gap behind slower ones
const LANE = { road: 1.8, track: 0.7 }; // m right of the route centre line (field tracks are narrow)
const FOLLOW_GAP = 4; // m bumper to bumper, plus ~1.5 s of speed

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

// nav: drivability grid + planner (navGrid.js), shared by all vehicles
export function createDriver(v, { heightAt, colliders, sampleRoute, coverPoints, half, nav, vehicles = [] }) {
  const bound = half - 60;
  const drive = DRIVE[v.type];
  const vision = VISION[v.type];
  const behavior = BEHAVIOR[v.type];
  const sample = { x: 0, z: 0, yaw: 0 };
  const probe = { x: 0, y: 0, z: 0 };

  const d = {
    mode: 'idle', // 'patrol' | 'parked' | 'react' | 'startup' | 'evade' | 'hide' | 'recover' | 'dead'
    timer: 0,
    tick: Math.random() * AI_TICK,
    awareness: 0,
    aware: false,
    awareSince: 0,
    lastSeen: -Infinity,
    seeing: false,
    knownX: 0,
    knownZ: 0,
    goal: null, // 'flee' | 'cover' | 'route'
    path: null, // [[x, z], ...] planned waypoints
    pathIdx: 0,
    jink: null, // { kind: 'brake' | 'swerve', timer, side }
    jinkTimer: 0,
    reverse: 0, // s left of backing straight away from an obstacle
    turnPhase: 0, // three-point turn: -1 backing up, +1 pulling forward (both steer towards the target)
    turnTimer: 0,
    reverses: { turn: 0, obstacle: 0, stuck: 0 }, // why it backed up (debug stats)
    planWait: 0, // s until the next planning attempt after a failure
    planFails: 0,
    stuckTimer: 0,
    time: 0,
    desiredYaw: 0,
    targetSpeed: 0,
    laneBias: 0, // extra metres to the right (after a head-on standoff, overtaking a stopped vehicle)
    waitAhead: 0, // s stuck behind a stopped vehicle
    escape: null, // { yaw, sign, timer }: way out of a jam
    blockedBy: null, // vehicle in the way at the last move, and since when
    blockedSince: 0,
    jamSince: 0,
  };

  function reset(home) {
    Object.assign(d, {
      awareness: 0, aware: false, lastSeen: -Infinity, seeing: false, goal: null, path: null, jink: null,
      reverse: 0, turnPhase: 0, escape: null, laneBias: 0, waitAhead: 0, planWait: 0, bumps: 0, boxedUntil: 0, planFails: 0, stuckTimer: 0, timer: 0,
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

  // A patrol spawned overlapping another vehicle: slide it along its route until clear
  function unoverlap() {
    if (!v.moving) return;
    for (let k = 0; k < 30 && vehicleAt(v.x, v.z, v.yaw); k++) {
      v.s = (v.s + 9 * v.dir + v.route.total) % v.route.total;
      sampleRoute(v.route, v.s, sample);
      v.x = sample.x;
      v.z = sample.z;
      v.yaw = sample.yaw + (v.dir < 0 ? Math.PI : 0);
    }
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

  // A destination: flee far away from the drone (roads preferred), or reach cover (tree line /
  // forest edge) that isn't towards it. Plans a path; null when no plan budget this frame.
  function chooseGoal(kind) {
    if (nav.budget <= 0) return false;
    const away = yawTo(v.x - d.knownX, v.z - d.knownZ);
    const candidates = [];
    if (kind === 'cover') {
      for (const c of coverPoints) {
        const dist = Math.hypot(c[0] - v.x, c[1] - v.z);
        if (dist < COVER[0] || dist > COVER[1]) continue;
        const toward = ((c[0] - v.x) * (d.knownX - v.x) + (c[1] - v.z) * (d.knownZ - v.z)) / (dist * (Math.hypot(d.knownX - v.x, d.knownZ - v.z) || 1));
        candidates.push({ x: c[0], z: c[1], score: -dist * (1 + Math.max(0, toward) * 3) });
      }
    } else {
      for (let k = 0; k < 12; k++) {
        const a = away + rand(-0.9, 0.9);
        const dist = rand(...FLEE);
        const x = v.x - Math.sin(a) * dist;
        const z = v.z - Math.cos(a) * dist;
        if (Math.abs(x) > bound || Math.abs(z) > bound || !nav.freeAt(x, z)) continue;
        candidates.push({ x, z, score: Math.hypot(x - d.knownX, z - d.knownZ) + (nav.isRoad(x, z) ? 80 : 0) });
      }
      if (v.moving) {
        // along its own road, whichever way leads away
        for (const ds of [-320, 320]) {
          sampleRoute(v.route, clamp(v.s + ds, 0, v.route.total), sample);
          candidates.push({ x: sample.x, z: sample.z, score: Math.hypot(sample.x - d.knownX, sample.z - d.knownZ) + 150 });
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const c of candidates.slice(0, 2)) {
      nav.budget--;
      const path = nav.plan(v.x, v.z, c.x, c.z, v.yaw);
      if (path) {
        d.goal = kind;
        d.path = path;
        d.pathIdx = 1;
        return true;
      }
      if (nav.budget <= 0) break;
    }
    if (kind === 'cover' && candidates.length === 0) return chooseGoal('flee');
    return false;
  }

  // Path back to the route; ahead > 0: to a point that far along it (detour around a blockage)
  function planToRoute(...aheads) {
    if (nav.budget <= 0) return false;
    nav.budget--;
    const near = closestOnRoute(v.route, v.x, v.z);
    let path = null;
    for (const ahead of aheads.length ? aheads : [0]) {
      sampleRoute(v.route, clamp(near.s + ahead * v.dir, 0, v.route.total), sample);
      path = nav.plan(v.x, v.z, sample.x, sample.z, v.yaw);
      if (path) break;
    }
    if (!path) return false;
    d.goal = 'route';
    d.path = path;
    d.pathIdx = 1;
    return true;
  }

  // Pure pursuit on the planned path: steer at the point `look` metres further along the path
  // from the vehicle's projection on it (no corner cutting). Returns { left, bend } where bend is
  // the heading change at the next waypoint, used to slow down before it.
  const follow = { left: 0, bend: 0, toBend: 0 };
  function followPath() {
    const path = d.path;
    if (path.length < 2) {
      follow.left = follow.bend = follow.toBend = 0; // already there
      return follow;
    }
    // advance along segments while the vehicle has passed their end
    for (;;) {
      if (d.pathIdx >= path.length - 1) break;
      const [ax, az] = path[d.pathIdx - 1];
      const [bx, bz] = path[d.pathIdx];
      const ex = bx - ax;
      const ez = bz - az;
      if (((v.x - ax) * ex + (v.z - az) * ez) / (ex * ex + ez * ez || 1) < 1) break;
      d.pathIdx++;
    }
    const [ax, az] = path[d.pathIdx - 1];
    const [bx, bz] = path[d.pathIdx];
    const ex = bx - ax;
    const ez = bz - az;
    const segLen = Math.hypot(ex, ez) || 1;
    const t = clamp(((v.x - ax) * ex + (v.z - az) * ez) / (segLen * segLen), 0, 1);
    // walk `look` metres along the path from the projection
    let look = 4 + Math.abs(v.speed) * 0.45;
    let i = d.pathIdx;
    let px = ax + ex * t;
    let pz = az + ez * t;
    let tx = px;
    let tz = pz;
    for (;;) {
      const [qx, qz] = path[i];
      const seg = Math.hypot(qx - px, qz - pz);
      if (seg >= look || i === path.length - 1) {
        const f = seg > 1e-6 ? Math.min(1, look / seg) : 0;
        tx = px + (qx - px) * f;
        tz = pz + (qz - pz) * f;
        break;
      }
      look -= seg;
      px = qx;
      pz = qz;
      i++;
    }
    // light vehicles weave and swerve on open ground
    const weave = v.type === 'car' && d.goal === 'flee' ? Math.sin(d.time * 1.3) * 3 : 0;
    const side = (d.jink?.kind === 'swerve' ? d.jink.side * 6 : 0) + weave;
    if (side) {
      const ox = tx + (-ez / segLen) * side;
      const oz = tz + (ex / segLen) * side;
      if (nav.freeAt(ox, oz)) {
        tx = ox;
        tz = oz;
      }
    }
    d.desiredYaw = yawTo(tx - v.x, tz - v.z);
    // remaining distance and the next bend
    let left = Math.hypot(bx - v.x, bz - v.z);
    for (let k = d.pathIdx + 1; k < path.length; k++) left += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
    follow.left = left;
    follow.toBend = Math.hypot(bx - v.x, bz - v.z);
    follow.bend = d.pathIdx < path.length - 1
      ? Math.abs(wrap(yawTo(path[d.pathIdx + 1][0] - bx, path[d.pathIdx + 1][1] - bz) - yawTo(ex, ez)))
      : 0;
    return follow;
  }

  function maybeJink(dt) {
    if (d.jink) {
      d.jink.timer -= dt;
      if (d.jink.timer <= 0) d.jink = null;
      return;
    }
    d.jinkTimer -= dt;
    if (d.jinkTimer > 0) return;
    d.jinkTimer = rand(3, 7);
    if (!d.aware || Math.random() > behavior.jink) return;
    d.jink = Math.random() < 0.45
      ? { kind: 'brake', timer: rand(0.8, 1.6) } // stop dead so the drone overshoots
      : { kind: 'swerve', timer: rand(1.5, 2.5), side: Math.random() < 0.5 ? -1 : 1 };
  }

  // Drive the current path; three-point turn / reverse when the next point is behind
  function drivePath(dt, speed) {
    const { left, bend, toBend } = followPath();
    // brake for the end of the path and for sharp bends ahead (corner speed ~ sqrt(radius * 3 m/s²))
    const cornerSpeed = bend > 0.35 ? Math.max(3, Math.sqrt(3 * drive.turnRadius * 2 / Math.max(0.35, bend))) : speed;
    const brakeTo = (vEnd, dist) => Math.sqrt(vEnd * vEnd + 2 * drive.brake * 0.7 * Math.max(0, dist));
    d.targetSpeed = Math.min(speed, brakeTo(1, left - ARRIVE * 0.5), brakeTo(cornerSpeed, toBend - 3));
    if (d.jink?.kind === 'brake') d.targetSpeed = 0;
    threePointTurn(dt);
    return left;
  }

  // Wheeled vehicles facing away from where they must go: back up and pull forward, steering
  // round each time, until they face it (tracked ones just pivot)
  function threePointTurn(dt) {
    const err = wrap(d.desiredYaw - v.yaw);
    if (!drive.pivot && !d.turnPhase && d.reverse <= 0 && Math.abs(err) > 1.9 && Math.abs(v.speed) < 3) {
      d.turnPhase = -1;
      d.turnTimer = rand(2, 3);
      d.reverses.turn++;
    }
    if (!d.turnPhase) return;
    if (Math.abs(err) < 0.9) {
      d.turnPhase = 0;
      return;
    }
    d.turnTimer -= dt;
    if (d.turnTimer <= 0) {
      d.turnPhase = -d.turnPhase;
      d.turnTimer = rand(2, 3);
    }
    d.targetSpeed = d.turnPhase * REVERSE_SPEED;
  }

  function decide(dt) {
    d.timer -= dt;
    switch (d.mode) {
      case 'patrol':
        d.desiredYaw = patrolTarget();
        d.targetSpeed = v.patrolSpeed;
        traffic();
        threePointTurn(dt); // end of the road
        if (d.aware) { d.mode = 'react'; d.timer = behavior.reaction; }
        else if (d.blockedOnRoute && nav.budget > 0) {
          // drive round it; if there's no way round, turn back
          if (planToRoute(40, 90)) d.mode = 'recover';
          else v.dir = -v.dir;
          d.blockedOnRoute = false;
        }
        break;
      case 'parked':
        d.targetSpeed = 0;
        if (d.aware) { d.mode = 'startup'; d.timer = behavior.reaction + behavior.startup; }
        break;
      case 'react':
      case 'startup':
        if (d.timer <= 0) { d.mode = 'evade'; d.path = null; }
        break;
      case 'evade': {
        d.planWait -= dt;
        if (!d.path) {
          if (d.planWait > 0 || nav.budget <= 0) {
            d.targetSpeed = Math.min(d.targetSpeed, 2); // waiting for a plan: creep
            break;
          }
          if (!chooseGoal(pick(behavior.goals))) {
            d.planWait = 1.5;
            if (++d.planFails >= 4) { d.mode = 'hide'; d.timer = rand(...HIDE_RECOVER); d.planFails = 0; d.boxedUntil = d.time + rand(10, 20); }
            d.targetSpeed = 0;
            break;
          }
          d.planFails = 0;
        }
        maybeJink(dt);
        const left = drivePath(dt, drive.maxSpeed * (d.goal === 'cover' ? 0.85 : 1));
        if (left < ARRIVE) {
          d.path = null;
          // still being watched: keep going; otherwise stay hidden here
          if (!(d.aware && d.time - d.lastSeen < 3)) {
            d.mode = 'hide';
            d.timer = rand(...HIDE_RECOVER);
            d.targetSpeed = 0;
          }
        }
        break;
      }
      case 'hide':
        d.targetSpeed = 0;
        if (d.aware && d.time - d.lastSeen < 1 && d.time > (d.boxedUntil ?? 0)) { d.mode = 'evade'; d.path = null; }
        else if (v.moving && d.timer <= 0 && !d.aware) { d.mode = 'recover'; d.path = null; }
        break;
      case 'recover': {
        if (d.aware) { d.mode = 'evade'; d.path = null; break; }
        d.planWait -= dt;
        if (!d.path && (d.planWait > 0 || !planToRoute())) {
          if (d.planWait <= 0) d.planWait = 2;
          d.targetSpeed = 0;
          break;
        }
        const left = drivePath(dt, Math.min(v.patrolSpeed * 1.3, drive.maxSpeed));
        if (left < ARRIVE) {
          d.path = null;
          v.s = closestOnRoute(v.route, v.x, v.z).s;
          d.mode = 'patrol';
        }
        break;
      }
    }
    if (d.escape) {
      // getting out of a jam with another vehicle (see findEscape)
      d.escape.timer -= dt;
      d.desiredYaw = d.escape.yaw;
      d.targetSpeed = d.escape.sign * 3;
      d.turnPhase = 0;
      if (d.escape.timer <= 0) d.escape = null;
      return;
    }
    if (d.reverse > 0) {
      d.reverse -= dt;
      d.turnPhase = 0;
      d.targetSpeed = -REVERSE_SPEED;
      d.desiredYaw = v.yaw; // straight back
    }
    if (d.mode !== 'evade' && d.mode !== 'recover' && d.mode !== 'patrol') d.turnPhase = 0;
  }

  function patrolTarget() {
    const lookahead = 10 + v.speed * 1.5;
    const window = 40;
    v.s = closestOnRoute(v.route, v.x, v.z, v.s - window, v.s + window).s;
    if (v.dir > 0 && v.s > v.route.total - 6) v.dir = -1;
    if (v.dir < 0 && v.s < 6) v.dir = 1;
    sampleRoute(v.route, clamp(v.s + v.dir * lookahead, 0, v.route.total), sample);
    // aim right of the centre line (right of the direction we travel along the route)
    const ry = sample.yaw + (v.dir < 0 ? Math.PI : 0);
    const lane = (v.home.route === 'main' || v.home.route === 'cross' ? LANE.road : LANE.track) + d.laneBias;
    return yawTo(sample.x + Math.cos(ry) * lane - v.x, sample.z - Math.sin(ry) * lane - v.z);
  }

  // Slow down behind a slower vehicle ahead in the lane, and when passing oncoming traffic
  function traffic() {
    let blocked = false;
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    for (const w of vehicles) {
      if (w === v) continue;
      const dx = w.x - v.x;
      const dz = w.z - v.z;
      const along = dx * fx + dz * fz;
      if (along <= 0 || along > 40) continue;
      const lateral = Math.abs(dx * fz - dz * fx);
      const width = v.half.x + w.half.x + 0.8;
      if (lateral > width + 1) continue;
      const gap = along - v.half.z - w.half.z;
      const wfx = -Math.sin(w.yaw);
      const wfz = -Math.cos(w.yaw);
      const oncoming = wfx * fx + wfz * fz < -0.5 && Math.abs(w.speed) > 0.5;
      if (oncoming) {
        d.targetSpeed = Math.min(d.targetSpeed, Math.max(2.5, v.patrolSpeed * 0.5)); // pass carefully
      } else if (lateral < width) {
        const ahead = Math.max(0, w.speed * (wfx * fx + wfz * fz)); // its speed along our way
        const safe = FOLLOW_GAP + Math.abs(v.speed) * 1.5;
        if (gap < safe) {
          d.targetSpeed = Math.min(d.targetSpeed, gap < FOLLOW_GAP ? 0 : ahead * 0.9);
          // stopped there (parked, broken down, burnt out): after a moment swing out and overtake
          if (ahead < 1) {
            d.waitAhead += AI_TICK;
            if (d.waitAhead > 2) {
              d.laneBias = Math.min(width + 0.4, d.laneBias + 0.4);
              d.targetSpeed = Math.max(d.targetSpeed, 3);
            }
            blocked = true;
          }
        }
      }
    }
    if (!blocked) {
      d.waitAhead = Math.max(0, d.waitAhead - AI_TICK * 0.5); // decays: a leader that creeps on and off still gets passed
      d.laneBias = Math.max(0, d.laneBias - AI_TICK * 0.15);
    }
  }

  // Hull footprint at a pose overlaps something solid (trunk, wall, log, wreck)? Three spheres
  // along the body, from the rear to just past the nose.
  function overlaps(x, z, yaw) {
    const sx = -Math.sin(yaw);
    const sz = -Math.cos(yaw);
    const r = v.half.x * 0.8;
    for (const f of [-0.6, 0, 0.75]) {
      probe.x = x + sx * v.half.z * f;
      probe.z = z + sz * v.half.z * f;
      if (Math.abs(probe.x) > half - 5 || Math.abs(probe.z) > half - 5) return true; // map edge
      probe.y = heightAt(probe.x, probe.z) + 0.8;
      if (colliders.hits(probe, r, isSolidForVehicles)) return true;
    }
    return false;
  }

  // Another vehicle whose hull (three circles along the body) the hull at this pose touches
  function vehicleAt(x, z, yaw) {
    const r = v.half.x * 0.95;
    const sx = -Math.sin(yaw);
    const sz = -Math.cos(yaw);
    for (const w of vehicles) {
      if (w === v) continue;
      const reach = v.half.z + w.half.z + r + w.half.x;
      if (Math.abs(w.x - x) > reach || Math.abs(w.z - z) > reach) continue;
      const wr = w.half.x * 0.95;
      const wsx = -Math.sin(w.yaw);
      const wsz = -Math.cos(w.yaw);
      for (const f of [-0.6, 0, 0.6]) {
        const ax = x + sx * v.half.z * f;
        const az = z + sz * v.half.z * f;
        for (const g of [-0.6, 0, 0.6]) {
          const bx = w.x + wsx * w.half.z * g;
          const bz = w.z + wsz * w.half.z * g;
          if ((ax - bx) ** 2 + (az - bz) ** 2 < (r + wr) ** 2) return w;
        }
      }
    }
    return null;
  }

  // Jammed by another vehicle for a while: find a short move (back, back-left/right, forward-left/
  // right) whose end pose touches neither vehicles nor obstacles, and drive it
  function findEscape() {
    for (const sign of [-1, 1]) {
      for (const dy of [0, 0.5, -0.5, 1, -1]) {
        if (sign > 0 && dy === 0) continue;
        const yaw = wrap(v.yaw + dy);
        const x = v.x - Math.sin(yaw) * 2.5 * sign;
        const z = v.z - Math.cos(yaw) * 2.5 * sign;
        if (!overlaps(x, z, yaw) && !vehicleAt(x, z, yaw)) {
          d.escape = { yaw, sign, timer: 1.6 };
          d.path = null;
          return;
        }
      }
    }
  }

  // ---------- driving ----------

  function integrate(dt) {
    const err = wrap(d.desiredYaw - v.yaw);
    const speedAbs = Math.abs(v.speed);
    const maxRate = drive.pivot ? drive.maxYawRate : Math.min(drive.maxYawRate, speedAbs / drive.turnRadius);
    const wantRate = clamp(err * 2, -maxRate, maxRate);
    v.yawRate += clamp(wantRate - v.yawRate, -drive.yawAccel * dt, drive.yawAccel * dt);
    if (!drive.pivot && speedAbs < 0.1) v.yawRate = 0;
    const oldYaw = v.yaw;
    const newYaw = wrap(v.yaw + v.yawRate * dt);

    // Slow down for sharp turns (tanks nearly stop to pivot); reversing is slow anyway
    const turn = Math.abs(err);
    let target = d.targetSpeed;
    if (target > 0 && turn > 0.3 && !d.turnPhase) target *= drive.pivot ? clamp(1 - turn, 0.1, 1) : clamp(1.2 - turn * 0.6, 0.35, 1);
    if (v.state === 'damaged') target *= 0.6;
    v.speed += clamp(target - v.speed, -drive.brake * dt, drive.accel * dt);

    // Never drive or turn into solid things: refuse the move, then back away (or go forward if
    // the rear is what's blocked). Moves out of an existing overlap are allowed.
    const nx = v.x - Math.sin(newYaw) * v.speed * dt;
    const nz = v.z - Math.cos(newYaw) * v.speed * dt;
    // another vehicle in the way: stop and wait; in a standoff one of them (the lower id waits) backs
    // off and moves further right
    const moved = nx !== v.x || nz !== v.z || newYaw !== oldYaw;
    const other = moved ? vehicleAt(nx, nz, newYaw) : null;
    if (other && !vehicleAt(v.x, v.z, oldYaw)) {
      v.speed = 0;
      v.yawRate = 0;
      if (d.blockedBy !== other) {
        if (!d.blockedBy) d.jamSince = d.time; // jammed by vehicles since (whichever)
        d.blockedBy = other;
        d.blockedSince = d.time;
      }
      // the higher id yields; if it can't back up (blocked behind), the other one does
      const otherStuck = other.driver && other.driver.state.time - (other.driver.state.cantReverse ?? -1e9) < 3;
      if (d.time - d.blockedSince > 1.5 && d.reverse <= 0 && (v.id > other.id || otherStuck || !other.driver)) {
        d.reverse = rand(1, 1.6);
        d.laneBias = Math.min(1.2, d.laneBias + 0.6);
        d.blockedSince = d.time;
      }
      if (d.time - d.jamSince > 3 && !d.escape) {
        findEscape();
        d.jamSince = d.time;
      }
      d.stuckTimer = 0;
      return;
    }
    d.blockedBy = null;
    if ((nx !== v.x || nz !== v.z || newYaw !== oldYaw) && overlaps(nx, nz, newYaw) && !overlaps(v.x, v.z, oldYaw)) {
      const sign = Math.sign(v.speed);
      v.speed = 0;
      v.yawRate = 0;
      if (d.turnPhase) {
        d.turnPhase = sign < 0 ? 1 : -1; // blocked mid-turn: go the other way
        d.turnTimer = rand(2, 3);
        return;
      }
      if (d.mode === 'patrol') d.blockedOnRoute = true;
      if (sign >= 0 && d.reverse <= 0 && d.mode !== 'parked') {
        d.reverses.obstacle++;
        d.reverse = rand(1, 1.6);
        d.path = null; // replan from the new spot
        // boxed in (brush, ravine floor): give up for a while
        d.bumps = (d.bumps ?? 0) * Math.exp(-(d.time - (d.lastBump ?? 0)) / 30) + 1;
        d.lastBump = d.time;
        if (d.bumps > 6 && d.mode !== 'evade' && v.moving) {
          v.dir = -v.dir; // wedged on the way back to the road: try the other way
          d.mode = 'recover';
          d.bumps = 0;
        } else if (d.bumps > 6 && d.mode === 'evade') {
          d.mode = 'hide';
          d.timer = rand(...HIDE_RECOVER);
          d.boxedUntil = d.time + rand(15, 30); // stuck in brush: the crew sits it out
          d.reverse = 0;
          d.bumps = 0;
        }
      } else if (sign < 0) {
        d.reverse = 0;
        d.cantReverse = d.time; // something behind: in a standoff the other vehicle backs off
      }
      return;
    }
    v.yaw = newYaw;
    v.x = nx;
    v.z = nz;

    // Stuck: wants to move but can't for a while -> back off and replan
    if (Math.abs(d.targetSpeed) > 2 && speedAbs < 0.3) d.stuckTimer += dt;
    else d.stuckTimer = 0;
    if (d.stuckTimer > 3) {
      d.stuckTimer = 0;
      d.reverses.stuck++;
      d.reverse = rand(1.5, 2.5);
      d.path = null;
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

  return { state: d, reset, update, unoverlap };
}
