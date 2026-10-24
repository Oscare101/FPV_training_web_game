import * as THREE from 'three';
import { mulberry32 } from './random.js';
import { mergeParts } from './meshUtils.js';
import { buildBuilding, buildFence } from './buildings.js';

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const BARK = { pine: 0x7a5236, birch: 0xd2cfc4, oak: 0x4a4036, acacia: 0x3e3630, burnt: 0x1c1916 };
const DRY_CROWN = { spring: 0x5e5032, summer: 0x5a5a32, autumn: 0x6a4a28 }; // wilted leaves on a fallen crown

// Fallen tree: log lying on the ground (pitched to the slope), branch stubs, and either an
// uprooted root plate or the snapped stump. Colliders: capsule log, box plate, cylinder stump,
// ellipsoid for a wilted crown at the tip.
function buildFallen(f, heightAt, rand, season, colliders) {
  const parts = [];
  const bark = BARK[f.kind] ?? BARK.oak;
  const ux = -Math.sin(f.yaw);
  const uz = -Math.cos(f.yaw);
  const start = f.root === 'stump' ? 0.35 : 0;
  const ax = f.x + ux * start;
  const az = f.z + uz * start;
  const bx = f.x + ux * f.len;
  const bz = f.z + uz * f.len;
  const ay = heightAt(ax, az) + f.r * 0.85;
  const by = heightAt(bx, bz) + f.r * 0.5;
  const hl = Math.hypot(bx - ax, bz - az);
  const L = Math.hypot(hl, by - ay);
  const slope = Math.atan2(by - ay, hl);
  parts.push({ geo: new THREE.CylinderGeometry(f.r * 0.55, f.r, L, 7), color: bark, pos: [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2], rotY: f.yaw, rotX: -Math.PI / 2 + slope });
  const rLog = f.r * 0.8;
  const t0 = rLog / L;
  colliders.addCapsule('tree', ax + (bx - ax) * t0, ay + (by - ay) * t0, az + (bz - az) * t0, bx - (bx - ax) * t0, by - (by - ay) * t0, bz - (bz - az) * t0, rLog * 0.95);
  // broken branch stubs along the upper half (thin: visual only)
  for (let k = 0; k < 3 + Math.floor(rand() * 4); k++) {
    const t = 0.3 + rand() * 0.65;
    const side = rand() < 0.5 ? 1 : -1;
    parts.push({
      geo: new THREE.CylinderGeometry(0.025, 0.05, 0.5 + rand() * 1.2, 4), color: bark,
      pos: [ax + (bx - ax) * t, ay + (by - ay) * t + 0.15, az + (bz - az) * t], rotY: f.yaw + side * (0.6 + rand() * 0.6), rotX: 0.5 + rand() * 0.7,
    });
  }
  if (f.root === 'plate') {
    const R = 0.8 + rand() * 0.6;
    const px = f.x - ux * 0.15;
    const pz = f.z - uz * 0.15;
    const py = heightAt(px, pz) + R * 0.7;
    parts.push({ geo: new THREE.CylinderGeometry(R, R * 0.9, 0.36, 8), color: season === 'winter' ? 0x50463c : 0x4a3a2a, pos: [px, py, pz], rotY: f.yaw, rotX: -Math.PI / 2 });
    colliders.addOBB('tree', px, py, pz, R * 0.85, R * 0.85, 0.2, f.yaw);
  } else {
    const sh = 0.4 + rand() * 0.8;
    const sy = heightAt(f.x, f.z) - 0.1;
    parts.push({ geo: new THREE.CylinderGeometry(f.r * 0.95, f.r * 1.15, sh, 7), color: bark, pos: [f.x, sy + sh / 2, f.z] });
    parts.push({ geo: new THREE.ConeGeometry(f.r * 0.9, 0.35, 5), color: bark, pos: [f.x, sy + sh + 0.15, f.z] }); // splintered top
    colliders.addCylinder('tree', f.x, f.z, sy, sy + sh + 0.3, f.r * 1.1);
  }
  // wilted crown still on some fresh ones
  if (f.kind !== 'burnt' && season !== 'winter' && rand() < 0.4) {
    const rx = 1.2 + rand() * 0.8;
    const ry = 0.7 + rand() * 0.3;
    const cx = bx - ux * rx * 0.4;
    const cz = bz - uz * rx * 0.4;
    const cy = heightAt(cx, cz) + ry * 0.8;
    parts.push({ geo: new THREE.IcosahedronGeometry(1, 0).scale(rx, ry, rx), color: DRY_CROWN[season] ?? DRY_CROWN.summer, pos: [cx, cy, cz], rotY: rand() * Math.PI });
    colliders.addEllipsoid('tree', cx, cy, cz, rx * 0.84, ry * 0.84);
  }
  return parts;
}

// Village buildings (houses, barns, garages, sheds; intact or ruined), yard fences, fallen trees,
// utility poles along the main road and crater decals. Merged per chunk so they're culled with the rest of it.
// Building colliders are rotated boxes matching each visible piece (see buildings.js).
export function buildStructures(layout, chunks, colliders, material) {
  const { heightAt } = layout;
  const rand = mulberry32(layout.seed + 31);
  const parts = chunks.groups.map(() => []);

  for (const h of layout.houses) {
    const b = buildBuilding(h, heightAt, rand);
    parts[chunks.indexOf(h.x, h.z)].push(...b.parts);
    for (const [x, y, z, hx, hy, hz, yaw] of b.cols) colliders.addOBB('building', x, y, z, hx, hy, hz, yaw);
  }
  for (const f of layout.fences) {
    const fence = buildFence(f, heightAt, rand);
    parts[chunks.indexOf((f.x1 + f.x2) / 2, (f.z1 + f.z2) / 2)].push(...fence.parts);
    const [x, y, z, hx, hy, hz, yaw] = fence.col;
    colliders.addOBB('fence', x, y, z, hx, hy, hz, yaw);
  }

  for (const f of layout.fallen ?? []) parts[chunks.indexOf(f.x, f.z)].push(...buildFallen(f, heightAt, rand, layout.season, colliders));

  // Utility poles along the main road (no wires yet)
  const road = layout.mainRoad;
  for (let i = 2; i < road.length - 1; i += 2) {
    const [x0, z0] = road[i - 1];
    const [x1, z1] = road[i];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const x = x1 - ((z1 - z0) / len) * 6;
    const z = z1 + ((x1 - x0) / len) * 6;
    const g = layout.grey(x, z);
    if (rand() < g * 0.5) continue; // some knocked down
    const y = heightAt(x, z) - 0.2;
    const list = parts[chunks.indexOf(x, z)];
    list.push({ geo: new THREE.CylinderGeometry(0.11, 0.15, 9, 6), color: 0x5b4a3a, pos: [x, y + 4.5, z] });
    list.push({ geo: box(1.6, 0.12, 0.12), color: 0x5b4a3a, pos: [x, y + 8.4, z], rotY: Math.atan2(-(x1 - x0), -(z1 - z0)) + Math.PI / 2 });
    colliders.addCylinder('pole', x, z, y, y + 9, 0.15);
  }

  parts.forEach((list, i) => {
    if (list.length) chunks.groups[i].add(new THREE.Mesh(mergeParts(list), material));
  });

  // Crater decals: dark scorched discs (big ones are also carved into the terrain)
  const craterGeo = new THREE.CircleGeometry(1, 10).rotateX(-Math.PI / 2);
  const craterMat = new THREE.MeshLambertMaterial({ color: 0x4a4034, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  craterMat.defines = { FPV_NO_SNOW: '' }; // fresh craters stay dark in snow
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  chunks.bucket(layout.craters).forEach((list, i) => {
    if (!list.length) return;
    const mesh = new THREE.InstancedMesh(craterGeo, craterMat, list.length);
    list.forEach((c, k) => {
      mesh.setMatrixAt(k, m.compose(p.set(c.x, heightAt(c.x, c.z) + 0.04, c.z), q.identity(), s.set(c.r, 1, c.r)));
    });
    mesh.computeBoundingSphere();
    chunks.groups[i].add(mesh);
  });
}
