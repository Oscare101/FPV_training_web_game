import * as THREE from 'three';

// Smooth road surfaces over the terrain near the camera. The ground's own colour can only change
// per terrain vertex (1-8 m), so up close roads looked stepped; these strips follow the route
// curves (smoothed) with soft edges: main roads as a dirt road with darker wheel ruts, field
// tracks as two ruts with grass between. Beyond the detail radius only the ground colour shows
// (coarser terrain there would let the strips float or sink).

// Cross-section [offset m, alpha, darkness] from one edge to the other
const PROFILES = {
  road: [[-4.3, 0, 0], [-3.4, 1, 0.04], [-1.9, 1, 0.1], [-1.2, 1, 0], [1.2, 1, 0], [1.9, 1, 0.1], [3.4, 1, 0.04], [4.3, 0, 0]],
  track: [[-1.5, 0, 0.1], [-1.2, 1, 0.12], [-0.7, 1, 0.12], [-0.4, 0, 0.1], [0.4, 0, 0.1], [0.7, 1, 0.12], [1.2, 1, 0.12], [1.5, 0, 0.1]],
};
const DIRT = { spring: [0.42, 0.37, 0.29], summer: [0.5, 0.45, 0.36], autumn: [0.44, 0.38, 0.3], winter: [0.6, 0.6, 0.6] };

function smoothLine(pts, passes = 3) {
  let out = pts;
  for (let p = 0; p < passes; p++) {
    const sm = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const [ax, az] = out[i];
      const [bx, bz] = out[i + 1];
      sm.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    sm.push(out[out.length - 1]);
    out = sm;
  }
  return out;
}

// samples every `step` m along a polyline: [x, z, tx, tz] (unit tangent)
function resample(pts, step) {
  const out = [];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    const tx = (bx - ax) / len;
    const tz = (bz - az) / len;
    for (let t = carry; t < len; t += step) out.push([ax + tx * t, az + tz * t, tx, tz]);
    carry = (carry - len) % step;
    if (carry < 0) carry += step;
  }
  return out;
}

export function buildRoads(layout, chunks) {
  const { heightAt } = layout;
  const dirt = DIRT[layout.season] ?? DIRT.summer;
  const buckets = chunks.groups.map(() => ({ pos: [], col: [] }));
  for (const [name, route] of Object.entries(layout.routes)) {
    const profile = name === 'main' || name === 'cross' ? PROFILES.road : PROFILES.track;
    const samples = resample(smoothLine(route), 2);
    const rows = samples.map(([x, z, tx, tz], i) => {
      const nx = -tz;
      const nz = tx;
      const shade = 0.94 + 0.06 * Math.sin(i * 0.7 + x * 0.05) * Math.sin(z * 0.03 + i * 0.31); // patchy surface
      return profile.map(([o, a, dark]) => {
        const px = x + nx * o;
        const pz = z + nz * o;
        const k = shade * (1 - dark);
        return { p: [px, heightAt(px, pz) + 0.05, pz], c: [dirt[0] * k, dirt[1] * k, dirt[2] * k, a] };
      });
    });
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i];
      const b = rows[i + 1];
      const [mx, , mz] = a[0].p;
      const [cx, , cz] = a[Math.floor(profile.length / 2)].p;
      const water = layout.waterAt?.(cx, cz) ?? null;
      if (water !== null && water - heightAt(cx, cz) > 0.3) continue; // not under deep water (fords are shallow)
      const bucket = buckets[chunks.indexOf(mx, mz)];
      for (let j = 0; j < profile.length - 1; j++) {
        if (a[j].c[3] === 0 && a[j + 1].c[3] === 0) continue; // grass between track ruts
        for (const v of [a[j], a[j + 1], b[j], a[j + 1], b[j + 1], b[j]]) { // facing up
          bucket.pos.push(...v.p);
          bucket.col.push(...v.c);
        }
      }
    }
  }
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  material.userData.noCastShadow = true;
  const meshes = [];
  buckets.forEach((b, ci) => {
    if (!b.pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 4));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.renderOrder = -1; // under other transparent things (tracks, water)
    chunks.groups[ci].add(mesh);
    meshes.push({ mesh, ci });
  });
  return {
    // only within the detail radius (full-resolution terrain under them)
    update(camera, detailDistance) {
      const { x, z } = camera.position;
      const hs = chunks.chunkSize / 2;
      for (const { mesh, ci } of meshes) {
        const g = chunks.groups[ci];
        const d = Math.hypot(Math.max(0, Math.abs(x - g.userData.cx) - hs), Math.max(0, Math.abs(z - g.userData.cz) - hs));
        mesh.visible = d < detailDistance;
      }
    },
  };
}
