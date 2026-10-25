import * as THREE from 'three';
import { BLAST_REACH, AMMO_COOKOFF, EFFECT_RANK, blastEffect } from '../world/damage.js';

// Charge detonation shared by every mode (rules in world/damage.js): the struck vehicle takes the
// zone's effect, everything else nearby rolls a near-miss effect by distance unless a wall, wreck
// or earth berm is in the way. Burning ammo may cook off later and blast its neighbours.

export const CHARGE_ARM_DISTANCE = 30; // m from launch before the charge arms
export const FUSE_VSPEED = 3; // m/s, ground touchdown that sets off the impact fuse
export const FUSE_SKID = 6;
export const NET_FUSE_SPEED = 5; // m/s: faster into a net sets the fuse off on it, slower tangles the drone
export { EFFECT_RANK };

const COVER = new Set(['building', 'wreck', 'cover']); // stop blast and fragments (walls, wrecks, berms, log roofs)
const PATH_STEP = 0.3; // m

// Does this impact set off the charge? (soft landings and slow net contacts don't)
export function fuseTriggered(hit, drone) {
  if (hit.kind === 'net') return drone.velocity.length() > NET_FUSE_SPEED;
  return !(hit.kind === 'ground' && !hit.hard && hit.vDown < FUSE_VSPEED && hit.skid < FUSE_SKID);
}

export function createStrikeFx(world, audio) {
  const pending = []; // { t, pos, vehicle? } cook-off blasts
  const tmp = new THREE.Vector3();
  const target = new THREE.Vector3();
  const coverFilter = (c) => COVER.has(c.kind) || c.kind === 'fence';

  // How much of a blast at `from` reaches vehicle v: 1 open, 0.5 through a fence, 0 behind cover.
  // Two rays (hull centre and top); the better one counts.
  function blastPath(from, v) {
    let best = 0;
    for (const up of [v.half.y, v.half.y * 1.8]) {
      target.copy(v.mesh.position).y += up;
      const dist = from.distanceTo(target);
      let through = 1;
      for (let s = PATH_STEP; s < dist; s += PATH_STEP) {
        tmp.lerpVectors(from, target, s / dist);
        if (world.vehicles.distanceTo(v, tmp) < 0.15) break; // reached its hull
        if (world.heightAt(tmp.x, tmp.z) > tmp.y + 0.05) { through = 0; break; } // berm / hill
        const c = world.colliderAt(tmp, PATH_STEP / 2, coverFilter); // radius: thin walls between samples count
        if (c && COVER.has(c.kind)) { through = 0; break; }
        if (c) through = Math.min(through, 0.5);
      }
      best = Math.max(best, through);
      if (best === 1) break;
    }
    return best;
  }

  // Near-miss effects of a blast at pos on every vehicle except `skip`; returns the vehicles changed
  function blast(pos, skip = null) {
    const vehicles = world.vehicles;
    for (const v of vehicles.list) {
      if (v === skip || v.state === 'destroyed') continue;
      const d = vehicles.distanceTo(v, pos);
      if (d > BLAST_REACH) continue;
      const effect = blastEffect(v.type, d, blastPath(pos, v));
      if (effect) vehicles.damage(v, effect);
    }
  }

  function effectsFor(changed) {
    for (const v of changed) {
      if (v.state === 'destroyed') world.effects.burn(v.mesh, 4);
      else if (v.state === 'immobilized') world.effects.burn(v.mesh, 2, 10);
      else world.effects.burn(v.mesh, 1.5, v.type === 'ammo' ? 14 : 4);
      if (v.type !== 'ammo') continue;
      if (v.state === 'destroyed') {
        for (let k = 0; k < 4; k++) pending.push({ t: 0.5 + k * 0.45 + Math.random() * 0.3, pos: v.mesh.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 1 + Math.random() * 2, (Math.random() - 0.5) * 4)) });
      } else if (Math.random() < AMMO_COOKOFF.chance) {
        // burning crates: may still go up a few seconds later
        pending.push({ t: AMMO_COOKOFF.delay[0] + Math.random() * (AMMO_COOKOFF.delay[1] - AMMO_COOKOFF.delay[0]), pos: v.mesh.position.clone(), vehicle: v });
      }
    }
  }

  // hit: from the flight controller ({ kind: 'vehicle', vehicle, zone, effect }, { kind: 'net', vehicle }
  // or an obstacle/ground); returns { pos, struck, zone, obstacle, changed, destroyed }
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
    blast(pos, out.struck);
    out.changed = vehicles.list.filter((v) => v.state !== before.get(v));
    out.destroyed = out.changed.filter((v) => v.enemy && v.state === 'destroyed').length;
    world.effects.explode(pos);
    effectsFor(out.changed);
    audio.playExplosion();
    return out;
  }

  return {
    detonate,
    blastPath,
    update(dt) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const b = pending[i];
        b.t -= dt;
        if (b.t > 0) continue;
        pending.splice(i, 1);
        world.effects.explode(b.pos);
        audio.playExplosion();
        if (b.vehicle && b.vehicle.state !== 'destroyed') {
          // a burning stack cooks off: it goes up and blasts what's next to it
          const before = new Map(world.vehicles.list.map((v) => [v, v.state]));
          world.vehicles.damage(b.vehicle, 'destroyed');
          blast(b.pos, b.vehicle);
          effectsFor(world.vehicles.list.filter((v) => v.state !== before.get(v)));
        }
      }
    },
    reset() {
      pending.length = 0;
    },
  };
}
