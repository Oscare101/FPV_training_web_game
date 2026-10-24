import * as THREE from 'three';

// Charge detonation shared by every mode: damage to the struck vehicle and everything in blast
// range, fireball, smoke from damaged vehicles, ammo cook-offs. Rules stay at game level.

export const CHARGE_ARM_DISTANCE = 30; // m from launch before the charge arms
export const FUSE_VSPEED = 3; // m/s, ground touchdown that sets off the impact fuse
export const FUSE_SKID = 6;
export const EFFECT_RANK = { intact: 0, damaged: 1, immobilized: 2, destroyed: 3 };

// Blast without a direct hit: soft vehicles suffer nearby, armor needs it almost touching.
function nearMissEffect(v, distance) {
  if (v.armored) return distance <= 1 ? 'damaged' : null;
  if (distance <= 2) return 'destroyed';
  if (distance <= 5) return 'damaged';
  return null;
}

// Does this impact set off the charge? (soft landings don't)
export function fuseTriggered(hit) {
  return !(hit.kind === 'ground' && !hit.hard && hit.vDown < FUSE_VSPEED && hit.skid < FUSE_SKID);
}

export function createStrikeFx(world, audio) {
  const secondary = []; // pending ammo cook-off blasts { t, pos, done }

  // hit: from the flight controller ({ kind: 'vehicle', vehicle, zone, effect } or an obstacle/ground);
  // returns { pos, struck, zone, obstacle, changed: vehicles whose state changed, destroyed: enemies destroyed }
  function detonate(hit, drone) {
    const pos = drone.position.clone();
    const vehicles = world.vehicles;
    const before = new Map(vehicles.list.map((v) => [v, v.state]));
    const out = { pos, struck: null, zone: null, obstacle: null, changed: [], destroyed: 0 };
    if (hit.kind === 'vehicle') {
      out.struck = hit.vehicle;
      out.zone = hit.zone;
      vehicles.damage(hit.vehicle, hit.effect);
    } else {
      out.obstacle = hit.kind;
    }
    for (const v of vehicles.list) {
      if (v === out.struck) continue;
      const effect = nearMissEffect(v, vehicles.distanceTo(v, pos));
      if (effect) vehicles.damage(v, effect);
    }
    out.changed = vehicles.list.filter((v) => v.state !== before.get(v));
    out.destroyed = out.changed.filter((v) => v.enemy && v.state === 'destroyed').length;

    world.effects.explode(pos);
    for (const v of out.changed) {
      if (v.state === 'destroyed') world.effects.burn(v.mesh, 4);
      else if (v.state === 'immobilized') world.effects.burn(v.mesh, 2, 10);
      else world.effects.burn(v.mesh, 1.5, 4);
      if (v.type === 'ammo' && v.state === 'destroyed') {
        for (let k = 0; k < 4; k++) {
          const p = v.mesh.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 1 + Math.random() * 2, (Math.random() - 0.5) * 4));
          secondary.push({ t: 0.5 + k * 0.45 + Math.random() * 0.3, pos: p, done: false });
        }
      }
    }
    audio.playExplosion();
    return out;
  }

  return {
    detonate,
    get pending() {
      return secondary.filter((b) => !b.done).length;
    },
    update(dt) {
      for (const b of secondary) {
        b.t -= dt;
        if (b.t <= 0 && !b.done) {
          b.done = true;
          world.effects.explode(b.pos);
          audio.playExplosion();
        }
      }
      if (secondary.length > 32) secondary.splice(0, secondary.length - 32);
    },
    reset() {
      secondary.length = 0;
    },
  };
}
