import * as THREE from 'three';
import { VEHICLE_MODELS } from '../world/vehicleModels.js';
import { mergeParts, flatMaterial } from '../world/meshUtils.js';
import { ZONES } from '../world/damage.js';
import { envUniforms } from './envShade.js';

// Pictures of every vehicle model for the target guide: a plain three-quarter view and front/rear
// views with each triangle coloured by what a direct hit there does (same rules as the game:
// part overrides such as gun barrels, otherwise the zone of its position on the hull box).
// Rendered once with a small offscreen renderer, returned as data URLs.

export const ZONE_COLORS = { destroyed: 0xe2553c, immobilized: 0xe6a33a, damaged: 0xa9a57a };

function zoneGeometry(type, def, geo) {
  const g = geo.clone();
  const pos = g.attributes.position;
  const col = g.attributes.color;
  const [w, h, l] = def.size;
  const parts = [...def.colliders];
  const c = new THREE.Vector3();
  const tint = new THREE.Color();
  const clamp = (t) => Math.max(-1, Math.min(1, t));
  for (let i = 0; i < pos.count; i += 3) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) c.x += pos.getX(i + k) / 3, c.y += pos.getY(i + k) / 3, c.z += pos.getZ(i + k) / 3;
    const part = parts.find((p) => p.zone && Math.abs(c.x - p.c[0]) < p.h[0] + 0.05 && Math.abs(c.y - p.c[1]) < p.h[1] + 0.05 && Math.abs(c.z - p.c[2]) < p.h[2] + 0.05);
    const effect = part ? part.zone[1] : ZONES[type](clamp(c.x / (w / 2)), clamp((c.y - h / 2) / (h / 2)), clamp(c.z / (l / 2)))[1];
    tint.setHex(ZONE_COLORS[effect]);
    for (let k = i; k < i + 3; k++) {
      const lum = (col.getX(k) + col.getY(k) + col.getZ(k)) / 3;
      const s = 0.75 + lum * 0.5; // keep a hint of the model's own shading
      col.setXYZ(k, tint.r * s, tint.g * s, tint.b * s);
    }
  }
  col.needsUpdate = true;
  return g;
}

export function renderVehiclePortraits(width = 280, height = 170) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe8ef, 0x3a3f30, 1.4));
  const sun = new THREE.DirectionalLight(0xfff3e0, 1.8);
  sun.position.set(-4, 8, -3);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(28, width / height, 0.1, 100);
  const material = flatMaterial();
  material.defines = { FPV_NO_SNOW: '' };
  // no cloud/drone shadows or wet look in the studio
  const saved = Object.fromEntries(Object.entries(envUniforms).map(([k, v]) => [k, Float32Array.from(v)]));
  envUniforms.fpvCloud[2] = 0;
  envUniforms.fpvDrone0[3] = 0;
  envUniforms.fpvSurf[0] = envUniforms.fpvSurf[1] = 0;

  const out = {};
  for (const type of Object.keys(VEHICLE_MODELS)) {
    const def = VEHICLE_MODELS[type]();
    const geo = mergeParts(def.turret ? [...def.parts, ...def.turret] : def.parts);
    const zoned = zoneGeometry(type, def, geo);
    const mesh = new THREE.Mesh(geo, material);
    scene.add(mesh);
    const [w, h, l] = def.size;
    const radius = Math.hypot(w, h, l) / 2;
    const dist = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 0.72;
    const shot = (dir) => {
      camera.position.set(dir[0], dir[1], dir[2]).normalize().multiplyScalar(dist).add(new THREE.Vector3(0, h * 0.45, 0));
      camera.lookAt(0, h * 0.4, 0);
      renderer.render(scene, camera);
      return canvas.toDataURL('image/png');
    };
    const photo = shot([-1, 0.55, -1.25]); // front-left, nose is -Z
    mesh.geometry = zoned;
    const front = shot([-1, 0.75, -1.1]);
    const rear = shot([1, 0.8, 1.1]);
    scene.remove(mesh);
    geo.dispose();
    zoned.dispose();
    out[type] = { photo, front, rear };
  }
  for (const [k, v] of Object.entries(saved)) envUniforms[k].set(v);
  material.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  return out;
}
