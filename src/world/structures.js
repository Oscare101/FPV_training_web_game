import * as THREE from 'three';
import { mulberry32 } from './random.js';
import { mergeParts } from './meshUtils.js';
import { buildBuilding, buildFence } from './buildings.js';

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// Village buildings (houses, barns, garages, sheds; intact or ruined), yard fences, utility poles
// along the main road and crater decals. Merged per chunk so they're culled with the rest of it.
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
