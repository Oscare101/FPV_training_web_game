import * as THREE from 'three';
import { betaflightRate } from '../flight/rates.js';

const DEG = Math.PI / 180;
const HOVER = 6; // m above the launch pad
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

// Controller page preview: a drone frozen in the air whose attitude follows the sticks through the
// player's rates, exactly like acro (rates in body axes, same signs as the flight controller).
export function createStickPreview() {
  const pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  let active = false;
  let levelSeen = -1;
  return {
    // controls: { roll, pitch, yaw }; rates: settings rates; launch: { x, z, yaw }; level: request counter
    update(dt, controls, rates, launch, ground, level) {
      if (!active || level !== levelSeen) {
        pose.quaternion.setFromAxisAngle(_v.set(0, 1, 0), launch.yaw);
        levelSeen = level;
        active = true;
      }
      pose.position.set(launch.x, ground + HOVER, launch.z);
      const rx = -betaflightRate(controls.pitch, rates.pitch) * DEG;
      const ry = -betaflightRate(controls.yaw, rates.yaw) * DEG;
      const rz = -betaflightRate(controls.roll, rates.roll) * DEG;
      const w = Math.hypot(rx, ry, rz);
      if (w > 1e-6) pose.quaternion.multiply(_q.setFromAxisAngle(_v.set(rx / w, ry / w, rz / w), w * dt)).normalize();
      return pose;
    },
    // next time the page opens it starts level again
    release() {
      active = false;
    },
  };
}
