import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './random.js';

// Tree species. One spec drives both the visible geometry and the colliders, so what you see is
// what you hit. Crowns are built from simple pieces in a unit space:
//   cones: tiers [baseRadius, y0, y1], crown base at y=0, top at y=1 (scaled crownR, crownH)
//   blobs: [radius, x, y, z] inside a unit sphere (scaled rx, ry, rx; rotated with the tree)
// trunk: height share of the tree, base radius (m), bark colour. crownW: crown radius / height.
// ryScale flattens (<1) or stretches the blob crown. hsl: [hue min, hue max, saturation, light min, light max].
// height: [min, max] m (overrides the generator's default for that spot).
export const SPECIES = {
  spruce: {
    height: [12, 22], trunk: [0.08, 0.14], trunkR: 0.2, bark: 0x4a3a2e, crownW: [0.15, 0.19], hsl: [0.33, 0.38, 0.24, 0.09, 0.13],
    cones: [[1, 0, 0.3], [0.85, 0.16, 0.44], [0.7, 0.32, 0.6], [0.55, 0.48, 0.75], [0.4, 0.63, 0.89], [0.24, 0.78, 1]],
  },
  pine: { // Scots pine: long bare reddish trunk, flat irregular crown on top
    height: [14, 22], trunk: [0.6, 0.72], trunkR: 0.2, bark: 0x7a5236, crownW: [0.2, 0.26], ryScale: 1, hsl: [0.25, 0.3, 0.24, 0.12, 0.16],
    blobs: [[0.6, 0, 0, 0], [0.5, 0.5, -0.1, 0.25], [0.5, -0.45, 0.05, -0.2], [0.4, 0.1, 0.15, -0.5], [0.42, -0.2, -0.05, 0.45]],
  },
  oak: {
    height: [10, 16], trunk: [0.25, 0.35], trunkR: 0.32, bark: 0x4a4036, crownW: [0.38, 0.5], ryScale: 0.85, hsl: [0.2, 0.26, 0.28, 0.13, 0.18],
    blobs: [[0.62, 0, 0.26, 0], [0.5, 0.46, 0, 0.2], [0.48, -0.42, 0.05, -0.25], [0.45, 0.1, -0.26, -0.46], [0.42, -0.22, -0.3, 0.42], [0.4, 0.34, 0.45, -0.22]],
  },
  birch: {
    height: [10, 16], trunk: [0.35, 0.5], trunkR: 0.14, bark: 0xd2cfc4, crownW: [0.16, 0.22], ryScale: 1, hsl: [0.19, 0.24, 0.36, 0.22, 0.28],
    blobs: [[0.5, 0, 0.35, 0], [0.45, 0.3, 0.05, 0.15], [0.45, -0.28, -0.1, -0.1], [0.4, 0.05, -0.4, -0.25], [0.38, -0.1, 0.62, 0.1]],
  },
  poplar: { // columnar, typical of village roads and tree lines
    height: [14, 22], trunk: [0.1, 0.16], trunkR: 0.22, bark: 0x5a5248, crownW: [0.09, 0.12], ryScale: 1, hsl: [0.22, 0.26, 0.3, 0.16, 0.21],
    blobs: [[0.45, 0, -0.6, 0], [0.55, 0, -0.15, 0.05], [0.5, 0.05, 0.3, -0.05], [0.38, 0, 0.7, 0]],
  },
  acacia: { // black locust: open, irregular crown; everywhere in tree lines
    height: [8, 13], trunk: [0.4, 0.55], trunkR: 0.2, bark: 0x3e3630, crownW: [0.32, 0.42], ryScale: 0.7, hsl: [0.24, 0.3, 0.26, 0.11, 0.15],
    blobs: [[0.42, 0.4, 0.1, 0.2], [0.4, -0.45, 0, 0.1], [0.36, 0, 0.25, -0.45], [0.32, 0.1, -0.15, 0.5], [0.3, -0.2, 0.3, -0.15]],
  },
  willow: { // wide, drooping, silvery; ravines and wet ground
    height: [8, 12], trunk: [0.2, 0.3], trunkR: 0.38, bark: 0x5a5248, crownW: [0.45, 0.55], ryScale: 0.8, hsl: [0.17, 0.22, 0.16, 0.2, 0.25],
    blobs: [[0.6, 0, 0.25, 0], [0.5, 0.55, -0.2, 0.1], [0.5, -0.5, -0.25, -0.15], [0.48, 0.1, -0.3, 0.55], [0.45, -0.15, -0.35, -0.5], [0.4, 0.3, 0.5, -0.2]],
  },
  fruit: { // small orchard trees around houses
    height: [4, 7], trunk: [0.3, 0.4], trunkR: 0.14, bark: 0x4e4438, crownW: [0.35, 0.45], ryScale: 0.9, hsl: [0.22, 0.28, 0.3, 0.15, 0.2],
    blobs: [[0.62, 0, 0.1, 0], [0.48, 0.42, -0.15, 0.2], [0.46, -0.4, -0.1, -0.22], [0.4, 0.05, 0.4, -0.3]],
  },
  dead: { height: [4, 11], trunk: [1, 1], trunkR: 0.17, bark: 0x3a332c }, // snapped by shelling: trunk and stubs
};
export const SPECIES_NAMES = Object.keys(SPECIES);
const BLOB_VARIANTS = 2; // per species: as specified, and mirrored with a flatter top

export const leafyVariants = (blobs) => [
  blobs,
  blobs.map(([r, x, y, z]) => [r, -x, y * 0.8 + 0.08, z]),
  blobs.map(([, x, y, z], i) => [blobs[(i + 1) % blobs.length][0], z, y * 1.15 - 0.04, -x]),
];

// Bushes: [radius, x, y, z], ground at y=0 (scaled r, h, r)
export const BUSHES = [
  [[0.7, -0.22, 0.4, 0.1], [0.6, 0.35, 0.35, -0.15]],
  [[0.62, -0.3, 0.4, 0.15], [0.55, 0.35, 0.35, -0.2], [0.5, 0.05, 0.65, 0.05]],
];

// Detail: tessellation only (same layouts), so the far LOD keeps the silhouette
export const DETAIL = { low: { ico: 0, segments: 7 }, medium: { ico: 1, segments: 9 }, high: { ico: 1, segments: 12 } };
// fit: scale of the smooth collider that best matches the faceted shape (measured by volume
// overlap): icosahedron detail 0 → 0.84 (90%), detail 1 → 0.95 (97%); cones 7/9/12 sides → 0.93/0.95/0.97
export const ICO_FIT = [0.84, 0.95];
const CONE_FIT = { 7: 0.93, 9: 0.95, 12: 0.97 };
export const coneFit = (segments) => CONE_FIT[segments] ?? (1 + Math.cos(Math.PI / segments)) / 2 - 0.015;

function blobGeometry(blobs, ico) {
  const g = mergeGeometries(blobs.map(([rb, x, y, z]) => new THREE.IcosahedronGeometry(rb, ico).translate(x, y, z)));
  g.computeVertexNormals();
  return g;
}
function coneGeometry(tiers, segments) {
  const g = mergeGeometries(tiers.map(([rb, y0, y1]) => new THREE.ConeGeometry(rb, y1 - y0, segments).translate(0, (y0 + y1) / 2, 0)));
  g.computeVertexNormals();
  return g;
}

// Crown geometries for one detail level: crowns[species] = Geometry[] (variants), bushes: Geometry[]
function shapes(detail) {
  const out = { crowns: {}, bushes: BUSHES.map((b) => blobGeometry(b, detail.ico)) };
  for (const [name, sp] of Object.entries(SPECIES)) {
    if (sp.cones) out.crowns[name] = [coneGeometry(sp.cones, detail.segments)];
    else if (sp.blobs) out.crowns[name] = leafyVariants(sp.blobs).slice(0, BLOB_VARIANTS).map((b) => blobGeometry(b, detail.ico));
  }
  return out;
}

export function createVegetationMaterials() {
  return {
    trunk: new THREE.MeshLambertMaterial({ color: 0xffffff }),
    foliage: new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    shade: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
  };
}

// detailName: near-camera detail ('low' | 'medium' | 'high'); far chunks always use 'low'.
export function buildVegetation(layout, chunks, colliders, materials, detailName = 'medium') {
  const { heightAt } = layout;
  const near = DETAIL[detailName] ?? DETAIL.medium;
  const nearGeo = shapes(near);
  const farGeo = detailName === 'low' ? null : shapes(DETAIL.low);
  const trunkGeo = new THREE.CylinderGeometry(0.6, 1, 1, 6, 1, true).translate(0, 0.5, 0);
  const stubGeo = new THREE.CylinderGeometry(0.5, 1, 1, 4, 1, true).translate(0, 0.5, 0);
  const discGeo = new THREE.CircleGeometry(1, 8).rotateX(-Math.PI / 2);
  const blobFit = ICO_FIT[near.ico];
  const conesFit = coneFit(near.segments);
  const variantBlobs = Object.fromEntries(
    Object.entries(SPECIES).filter(([, sp]) => sp.blobs).map(([n, sp]) => [n, leafyVariants(sp.blobs).slice(0, BLOB_VARIANTS)])
  );

  const rand = mulberry32(layout.seed + 21);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const q2 = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  const e = new THREE.Euler();

  // Blob colliders: rotate the blob offset with the tree (yaw), scale into world space
  const addBlobs = (kind, blobs, x, y, z, yaw, sx, sy) => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    for (const [rb, ox, oy, oz] of blobs) {
      const lx = ox * sx;
      const lz = oz * sx;
      colliders.addEllipsoid(kind, x + lx * c + lz * s, y + oy * sy, z - lx * s + lz * c, rb * sx * blobFit, rb * sy * blobFit);
    }
  };

  const treeBuckets = chunks.bucket(layout.trees);
  const bushBuckets = chunks.bucket(layout.bushes);
  const lodSets = []; // per chunk: { near: Mesh[], far: Mesh[] }

  chunks.groups.forEach((group, ci) => {
    const trees = treeBuckets[ci];
    const bushes = bushBuckets[ci];
    if (!trees.length && !bushes.length) return;
    const trunks = new THREE.InstancedMesh(trunkGeo, materials.trunk, Math.max(1, trees.length));
    trunks.count = 0;
    const stubs = new THREE.InstancedMesh(stubGeo, materials.trunk, Math.max(1, trees.length * 3));
    stubs.count = 0;
    const shade = new THREE.InstancedMesh(discGeo, materials.shade, trees.length + bushes.length);
    shade.count = 0;

    // Instanced crowns per (species, variant) in every LOD set, created on first use
    const sets = [{ geo: nearGeo, meshes: new Map() }, ...(farGeo ? [{ geo: farGeo, meshes: new Map() }] : [])];
    const put = (key, geoOf, matrix, color, capacity) => {
      for (const set of sets) {
        let mesh = set.meshes.get(key);
        if (!mesh) {
          mesh = new THREE.InstancedMesh(geoOf(set.geo), materials.foliage, capacity);
          mesh.count = 0;
          set.meshes.set(key, mesh);
        }
        mesh.setMatrixAt(mesh.count, matrix);
        mesh.setColorAt(mesh.count++, color);
      }
    };
    const addShade = (x, y, z, r) => {
      shade.setMatrixAt(shade.count++, m.compose(pos.set(x, y + 0.05, z), q.identity(), scl.set(r, 1, r)));
    };
    const bark = (sp) => col.setHex(sp.bark).multiplyScalar(0.85 + rand() * 0.3);

    for (const t of trees) {
      const sp = SPECIES[t.kind] ?? SPECIES.oak;
      const kind = SPECIES[t.kind] ? t.kind : 'oak';
      const y = heightAt(t.x, t.z) - 0.3;
      const yaw = rand() * Math.PI * 2;
      q.setFromAxisAngle(up, yaw);
      const trunkH = t.h * (sp.trunk[0] + rand() * (sp.trunk[1] - sp.trunk[0]));
      const tr = sp.trunkR * (0.8 + rand() * 0.4);
      const leaf = () => col.setHSL(sp.hsl[0] + rand() * (sp.hsl[1] - sp.hsl[0]), sp.hsl[2], sp.hsl[3] + rand() * (sp.hsl[4] - sp.hsl[3]));

      if (kind === 'dead') {
        trunks.setMatrixAt(trunks.count, m.compose(pos.set(t.x, y, t.z), q, scl.set(tr, t.h, tr)));
        trunks.setColorAt(trunks.count++, bark(sp));
        colliders.addCylinder('tree', t.x, t.z, y, y + t.h, tr);
        // a few snapped branch stubs (thin: visual only)
        for (let k = 0; k < 2 + Math.floor(rand() * 2); k++) {
          e.set(0.8 + rand() * 0.6, rand() * Math.PI * 2, 0, 'YXZ');
          q2.setFromEuler(e);
          stubs.setMatrixAt(stubs.count, m.compose(pos.set(t.x, y + t.h * (0.45 + rand() * 0.45), t.z), q2, scl.set(0.07, 0.6 + rand() * 1.2, 0.07)));
          stubs.setColorAt(stubs.count++, bark(sp));
        }
        continue;
      }

      if (sp.cones) {
        const crownR = t.h * (sp.crownW[0] + rand() * (sp.crownW[1] - sp.crownW[0]));
        const crownH = t.h - trunkH;
        trunks.setMatrixAt(trunks.count, m.compose(pos.set(t.x, y, t.z), q, scl.set(tr, trunkH + crownH * 0.3, tr)));
        trunks.setColorAt(trunks.count++, bark(sp));
        put(`${kind}0`, (g) => g.crowns[kind][0], m.compose(pos.set(t.x, y + trunkH, t.z), q, scl.set(crownR, crownH, crownR)), leaf(), trees.length);
        colliders.addCylinder('tree', t.x, t.z, y, y + trunkH, tr);
        for (const [rb, y0, y1] of sp.cones) colliders.addCone('tree', t.x, t.z, y + trunkH + y0 * crownH, y + trunkH + y1 * crownH, rb * crownR * conesFit);
        addShade(t.x, y + 0.3, t.z, crownR * 1.2);
      } else {
        const ry = ((t.h - trunkH) / 2) * (sp.ryScale ?? 1);
        const rx = t.h * (sp.crownW[0] + rand() * (sp.crownW[1] - sp.crownW[0]));
        const cy = y + trunkH + ry;
        const variant = Math.floor(rand() * BLOB_VARIANTS);
        trunks.setMatrixAt(trunks.count, m.compose(pos.set(t.x, y, t.z), q, scl.set(tr, trunkH + ry * 0.5, tr)));
        trunks.setColorAt(trunks.count++, bark(sp));
        put(`${kind}${variant}`, (g) => g.crowns[kind][variant], m.compose(pos.set(t.x, cy, t.z), q, scl.set(rx, ry, rx)), leaf(), trees.length);
        colliders.addCylinder('tree', t.x, t.z, y, y + trunkH, tr);
        addBlobs('tree', variantBlobs[kind][variant], t.x, cy, t.z, yaw, rx, ry);
        addShade(t.x, y + 0.3, t.z, rx * 1.1);
      }
    }

    for (const b of bushes) {
      const y = heightAt(b.x, b.z) - 0.25;
      const yaw = rand() * Math.PI * 2;
      const variant = Math.floor(rand() * BUSHES.length);
      q.setFromAxisAngle(up, yaw);
      put(`bush${variant}`, (g) => g.bushes[variant], m.compose(pos.set(b.x, y, b.z), q, scl.set(b.r, b.h, b.r)), col.setHSL(0.17 + rand() * 0.1, 0.23, 0.15 + rand() * 0.07), bushes.length);
      addBlobs('bush', BUSHES[variant], b.x, y, b.z, yaw, b.r, b.h);
      addShade(b.x, y + 0.25, b.z, b.r * 1.15);
    }

    const finish = (mesh) => {
      if (!mesh.count) return null;
      mesh.computeBoundingSphere();
      group.add(mesh);
      return mesh;
    };
    finish(trunks);
    finish(stubs);
    finish(shade);
    const lod = sets.map((set) => [...set.meshes.values()].map(finish).filter(Boolean));
    if (lod.length > 1) lodSets[ci] = { near: lod[0], far: lod[1] };
  });

  return {
    // Near chunks show the detailed crowns, far chunks the simple ones
    update(camera, detailDistance) {
      const { x, z } = camera.position;
      const hs = chunks.chunkSize / 2;
      lodSets.forEach((set, ci) => {
        if (!set) return;
        const g = chunks.groups[ci];
        const d = Math.hypot(Math.max(0, Math.abs(x - g.userData.cx) - hs), Math.max(0, Math.abs(z - g.userData.cz) - hs));
        const isNear = d < detailDistance;
        for (const mesh of set.near) mesh.visible = isNear;
        for (const mesh of set.far) mesh.visible = !isNear;
      });
    },
    dispose() {
      for (const geo of [nearGeo, farGeo]) {
        if (!geo) continue;
        for (const list of Object.values(geo.crowns)) for (const g of list) g.dispose();
        for (const g of geo.bushes) g.dispose();
      }
      trunkGeo.dispose();
      stubGeo.dispose();
      discGeo.dispose();
    },
  };
}
