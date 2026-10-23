import * as THREE from 'three';

// Splits the map into square chunks (one Group each) so far-away content can be hidden
// beyond the render distance and the GPU never draws the whole map at once.
export function createChunks(size, chunkSize) {
  const root = new THREE.Group();
  const n = Math.ceil(size / chunkSize);
  const half = size / 2;
  const groups = [];
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const g = new THREE.Group();
      g.userData.cx = -half + (ix + 0.5) * chunkSize;
      g.userData.cz = -half + (iz + 0.5) * chunkSize;
      root.add(g);
      groups.push(g);
    }
  }

  const indexOf = (x, z) => {
    const ix = Math.min(n - 1, Math.max(0, Math.floor((x + half) / chunkSize)));
    const iz = Math.min(n - 1, Math.max(0, Math.floor((z + half) / chunkSize)));
    return iz * n + ix;
  };

  return {
    root,
    n,
    chunkSize,
    groups,
    indexOf,
    // Bucket items by chunk: returns array of arrays
    bucket(items) {
      const buckets = groups.map(() => []);
      for (const it of items) buckets[indexOf(it.x, it.z)].push(it);
      return buckets;
    },
    update(camera, renderDistance) {
      const reach = renderDistance + chunkSize * 0.75;
      for (const g of groups) {
        const dx = g.userData.cx - camera.position.x;
        const dz = g.userData.cz - camera.position.z;
        g.visible = dx * dx + dz * dz < reach * reach;
      }
    },
  };
}

// Free GPU memory of everything under `object` (geometries + non-shared materials).
export function disposeTree(object, keepMaterials = new Set()) {
  object.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material && !keepMaterials.has(o.material)) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
    }
  });
}
