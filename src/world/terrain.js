import * as THREE from 'three';

const MAX_STEP = 16; // m, coarsest LOD cell
const BUILD_MS = 4; // ms per frame spent building chunk meshes (keeps frame time even)

// Deterministic 0..1 hash per grid vertex, so colours don't flicker between LOD rebuilds
const hash = (ix, iz) => {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// Terrain with level-of-detail rings. Each chunk is built (lazily) at the detail its distance
// needs: the finest level uses the layout's own grid, so near the drone the rendered ground is
// exactly the physics ground (layout.heightAt). Skirts hide cracks between levels.
export function createTerrainLod(layout, chunks, material) {
  const { heights, cell, n, half, groundColor } = layout;
  const stride = n + 1;
  const cellsPerChunk = Math.round(chunks.chunkSize / cell);
  const levels = [];
  for (let s = cell; s <= Math.max(cell, MAX_STEP) && levels.length < 3; s *= 2) levels.push(s);
  const col = new THREE.Color();

  const state = chunks.groups.map(() => ({ level: -1, meshes: new Map() }));
  let job = null; // in-progress chunk build { ci, level, it }

  // Generator: yields between vertex rows so a build can be spread over several frames
  function* buildMesh(ci, level) {
    const cz = Math.floor(ci / chunks.n);
    const cx = ci % chunks.n;
    const ix0 = cx * cellsPerChunk;
    const iz0 = cz * cellsPerChunk;
    const ix1 = Math.min(n, ix0 + cellsPerChunk);
    const iz1 = Math.min(n, iz0 + cellsPerChunk);
    if (ix0 >= ix1 || iz0 >= iz1) return null;
    const stepI = levels[level] / cell;
    // Grid indices along each axis (always includes the far edge)
    const axis = (a0, a1) => {
      const out = [];
      for (let i = a0; i < a1; i += stepI) out.push(i);
      out.push(a1);
      return out;
    };
    const xs = axis(ix0, ix1);
    const zs = axis(iz0, iz1);
    const nx = xs.length;
    const nz = zs.length;
    const skirt = levels[level] * 1.5;
    const vCount = nx * nz + 2 * (nx + nz);
    const positions = new Float32Array(vCount * 3);
    const colors = new Float32Array(vCount * 3);
    let v = 0;
    const vert = (ix, iz, drop) => {
      const x = -half + ix * cell;
      const z = -half + iz * cell;
      positions[v * 3] = x;
      positions[v * 3 + 1] = heights[iz * stride + ix] - drop;
      positions[v * 3 + 2] = z;
      groundColor(x, z, col);
      const k = 0.93 + hash(ix, iz) * 0.12;
      colors[v * 3] = col.r * k;
      colors[v * 3 + 1] = col.g * k;
      colors[v * 3 + 2] = col.b * k;
      return v++;
    };
    for (const iz of zs) {
      for (const ix of xs) vert(ix, iz, 0);
      yield;
    }
    const idx = [];
    const at = (i, j) => j * nx + i;
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        // Same diagonal as layout.heightAt: (x0, z1)-(x1, z0)
        idx.push(at(i, j), at(i, j + 1), at(i + 1, j));
        idx.push(at(i + 1, j), at(i, j + 1), at(i + 1, j + 1));
      }
      if (j % 16 === 15) yield;
    }
    // Skirts: a lowered copy of each edge, stitched to it
    const edge = (count, getTop, ixOf, izOf) => {
      const start = v;
      for (let k = 0; k < count; k++) vert(ixOf(k), izOf(k), skirt);
      for (let k = 0; k < count - 1; k++) {
        const a = getTop(k);
        const b = getTop(k + 1);
        idx.push(a, start + k, b, b, start + k, start + k + 1);
      }
    };
    yield;
    edge(nx, (k) => at(k, 0), (k) => xs[k], () => zs[0]);
    edge(nx, (k) => at(k, nz - 1), (k) => xs[k], () => zs[nz - 1]);
    edge(nz, (k) => at(0, k), () => xs[0], (k) => zs[k]);
    edge(nz, (k) => at(nx - 1, k), () => xs[nx - 1], (k) => zs[k]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    return mesh;
  }

  const runToEnd = (job) => {
    let r = job.next();
    while (!r.done) r = job.next();
    return r.value;
  };

  function show(ci, level, mesh = null) {
    const st = state[ci];
    if (st.level === level) return;
    mesh = mesh ?? st.meshes.get(level);
    if (!mesh) {
      mesh = runToEnd(buildMesh(ci, level));
      if (!mesh) return;
    }
    st.meshes.set(level, mesh);
    for (const [l, m] of st.meshes) {
      if (l === level) continue;
      chunks.groups[ci].remove(m);
      // keep the coarsest level as a cheap fallback, free the others
      if (l !== levels.length - 1) {
        m.geometry.dispose();
        st.meshes.delete(l);
      }
    }
    chunks.groups[ci].add(mesh);
    st.level = level;
  }

  const levelFor = (ci, x, z, detailDistance) => {
    const g = chunks.groups[ci];
    const hs = chunks.chunkSize / 2;
    const dx = Math.max(0, Math.abs(x - g.userData.cx) - hs);
    const dz = Math.max(0, Math.abs(z - g.userData.cz) - hs);
    const d = Math.hypot(dx, dz);
    if (d < detailDistance) return 0;
    if (d < detailDistance * 2.5) return Math.min(1, levels.length - 1);
    return levels.length - 1;
  };

  return {
    levels,
    // The ground changed in these areas [x0, z0, x1, z1]: rebuild the chunks touching them now
    invalidate(boxes) {
      const hs = chunks.chunkSize / 2 + cell;
      state.forEach((st, ci) => {
        const g = chunks.groups[ci];
        const { cx, cz } = g.userData;
        if (!boxes.some(([x0, z0, x1, z1]) => x1 > cx - hs && x0 < cx + hs && z1 > cz - hs && z0 < cz + hs)) return;
        if (job?.ci === ci) job = null;
        const level = st.level;
        for (const m of st.meshes.values()) {
          g.remove(m);
          m.geometry.dispose();
        }
        st.meshes.clear();
        st.level = -1;
        if (level >= 0) show(ci, level);
      });
    },
    // Build everything near (x, z) right away (no budget), coarse elsewhere
    prime(x, z, detailDistance) {
      state.forEach((_, ci) => show(ci, levelFor(ci, x, z, detailDistance)));
    },
    // Swaps cached levels immediately; new meshes are built in time-sliced jobs (nearest first),
    // the old mesh stays visible until the new one is ready
    update(camera, detailDistance) {
      const { x, z } = camera.position;
      const t0 = performance.now();
      let wanted = null;
      let wantedDist = Infinity;
      for (let ci = 0; ci < state.length; ci++) {
        if (!chunks.groups[ci].visible) continue;
        const want = levelFor(ci, x, z, detailDistance);
        const st = state[ci];
        if (want === st.level) continue;
        if (st.meshes.has(want)) {
          show(ci, want);
          continue;
        }
        const g = chunks.groups[ci];
        const d = Math.hypot(g.userData.cx - x, g.userData.cz - z);
        if (d < wantedDist) {
          wantedDist = d;
          wanted = { ci, level: want };
        }
      }
      if (!job && wanted) job = { ...wanted, it: buildMesh(wanted.ci, wanted.level) };
      while (job && performance.now() - t0 < BUILD_MS) {
        const r = job.it.next();
        if (r.done) {
          if (r.value && levelFor(job.ci, x, z, detailDistance) === job.level) show(job.ci, job.level, r.value);
          else r.value?.geometry.dispose();
          job = wanted && (wanted.ci !== job.ci || wanted.level !== job.level) ? { ...wanted, it: buildMesh(wanted.ci, wanted.level) } : null;
        }
      }
    },
  };
}
