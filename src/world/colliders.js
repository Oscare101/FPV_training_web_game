const CELL = 16; // m, broad-phase grid
const MARGIN = 1; // m, covers the drone radius at cell borders

const CYLINDER = 0;
const CONE = 1;
const ELLIPSOID = 2;
const BOX = 3;
const OBB = 4;
const CAPSULE = 5;
const MESH = 6;
const MESH_CELL = 1; // m, triangle grid inside a mesh collider

// Squared distance from p to triangle (a, b, c) given as 9 floats at t[o..o+8] (Ericson, closest point)
function triDist2(t, o, px, py, pz) {
  const ax = t[o], ay = t[o + 1], az = t[o + 2];
  const abx = t[o + 3] - ax, aby = t[o + 4] - ay, abz = t[o + 5] - az;
  const acx = t[o + 6] - ax, acy = t[o + 7] - ay, acz = t[o + 8] - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) {
    qx = ax; qy = ay; qz = az;
  } else {
    const bpx = px - t[o + 3], bpy = py - t[o + 4], bpz = pz - t[o + 5];
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    const cpx = px - t[o + 6], cpy = py - t[o + 7], cpz = pz - t[o + 8];
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    const vc = d1 * d4 - d3 * d2;
    const vb = d5 * d2 - d1 * d6;
    const va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) {
      qx = t[o + 3]; qy = t[o + 4]; qz = t[o + 5];
    } else if (d6 >= 0 && d5 <= d6) {
      qx = t[o + 6]; qy = t[o + 7]; qz = t[o + 8];
    } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      const v = d1 / (d1 - d3);
      qx = ax + abx * v; qy = ay + aby * v; qz = az + abz * v;
    } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      const w = d2 / (d2 - d6);
      qx = ax + acx * w; qy = ay + acy * w; qz = az + acz * w;
    } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
      const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
      qx = t[o + 3] + (t[o + 6] - t[o + 3]) * w; qy = t[o + 4] + (t[o + 7] - t[o + 4]) * w; qz = t[o + 5] + (t[o + 8] - t[o + 5]) * w;
    } else {
      const den = 1 / (va + vb + vc);
      const v = vb * den;
      const w = vc * den;
      qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
    }
  }
  return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
}

// Obstacles a vehicle can't drive through: trunks, poles, buildings, fences, wrecks, logs (not bushes or crowns)
export const isSolidForVehicles = (c) => c.type === CYLINDER || c.type === BOX || c.type === OBB || c.type === CAPSULE;

const cellKey = (ix, iz) => (ix + 10000) * 20000 + (iz + 10000);

// Static obstacles in a uniform grid; a sphere test only checks one cell.
// Every collider has a `kind` ('tree', 'building', ...) so impacts can be reported.
export class StaticColliders {
  constructor() {
    this.cells = new Map();
    this.tag = null; // set while adding a removable group of colliders (see removeTag)
  }

  // Remove every collider added while `tag` was set
  removeTag(tag) {
    for (const [k, list] of this.cells) {
      const kept = list.filter((c) => c.tag !== tag);
      if (kept.length) this.cells.set(k, kept);
      else this.cells.delete(k);
    }
  }

  insert(c, minX, maxX, minZ, maxZ) {
    if (this.tag) c.tag = this.tag;
    const x0 = Math.floor((minX - MARGIN) / CELL);
    const x1 = Math.floor((maxX + MARGIN) / CELL);
    const z0 = Math.floor((minZ - MARGIN) / CELL);
    const z1 = Math.floor((maxZ + MARGIN) / CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = cellKey(ix, iz);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(c);
      }
    }
  }

  // Vertical cylinder from y0 to y1
  addCylinder(kind, x, z, y0, y1, r) {
    this.insert({ type: CYLINDER, kind, x, z, y0, y1, r }, x - r, x + r, z - r, z + r);
  }

  // Vertical cone: radius r at y0, point at y1
  addCone(kind, x, z, y0, y1, r) {
    this.insert({ type: CONE, kind, x, z, y0, y1, r }, x - r, x + r, z - r, z + r);
  }

  addEllipsoid(kind, x, y, z, rx, ry) {
    this.insert({ type: ELLIPSOID, kind, x, y, z, rx, ry }, x - rx, x + rx, z - rx, z + rx);
  }

  addBox(kind, minX, minY, minZ, maxX, maxY, maxZ) {
    this.insert({ type: BOX, kind, minX, minY, minZ, maxX, maxY, maxZ }, minX, maxX, minZ, maxZ);
  }

  // Box rotated about Y (yaw, same convention as Object3D.rotation.y), centre (x, y, z), half extents
  addOBB(kind, x, y, z, hx, hy, hz, yaw) {
    const r = Math.hypot(hx, hz);
    this.insert({ type: OBB, kind, x, y, z, hx, hy, hz, cos: Math.cos(yaw), sin: Math.sin(yaw) }, x - r, x + r, z - r, z + r);
  }

  // Capsule: segment a-b with radius r (fallen logs)
  addCapsule(kind, ax, ay, az, bx, by, bz, r) {
    this.insert({ type: CAPSULE, kind, ax, ay, az, bx, by, bz, r }, Math.min(ax, bx) - r, Math.max(ax, bx) + r, Math.min(az, bz) - r, Math.max(az, bz) + r);
  }

  // Triangle mesh (draped nets): tris = Float32Array, 9 floats per triangle, world space
  addMesh(kind, tris) {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < tris.length; i += 3) {
      minX = Math.min(minX, tris[i]); maxX = Math.max(maxX, tris[i]);
      minY = Math.min(minY, tris[i + 1]); maxY = Math.max(maxY, tris[i + 1]);
      minZ = Math.min(minZ, tris[i + 2]); maxZ = Math.max(maxZ, tris[i + 2]);
    }
    const gnx = Math.ceil((maxX - minX) / MESH_CELL) + 1;
    const gnz = Math.ceil((maxZ - minZ) / MESH_CELL) + 1;
    const grid = Array.from({ length: gnx * gnz }, () => []);
    for (let o = 0; o < tris.length; o += 9) {
      const x0 = Math.min(tris[o], tris[o + 3], tris[o + 6]), x1 = Math.max(tris[o], tris[o + 3], tris[o + 6]);
      const z0 = Math.min(tris[o + 2], tris[o + 5], tris[o + 8]), z1 = Math.max(tris[o + 2], tris[o + 5], tris[o + 8]);
      for (let iz = Math.floor((z0 - minZ) / MESH_CELL); iz <= Math.floor((z1 - minZ) / MESH_CELL); iz++) {
        for (let ix = Math.floor((x0 - minX) / MESH_CELL); ix <= Math.floor((x1 - minX) / MESH_CELL); ix++) grid[iz * gnx + ix].push(o);
      }
    }
    this.insert({ type: MESH, kind, tris, grid, minX, minY, minZ, maxY, gnx, gnz }, minX, maxX, minZ, maxZ);
  }

  // Returns the first collider touching the sphere, or null. filter(c): only consider matching colliders
  hits(p, r, filter) {
    const list = this.cells.get(cellKey(Math.floor(p.x / CELL), Math.floor(p.z / CELL)));
    if (!list) return null;
    for (const c of list) {
      if (filter && !filter(c)) continue;
      switch (c.type) {
        case CYLINDER: {
          if (p.y + r < c.y0 || p.y - r > c.y1) break;
          const dx = p.x - c.x;
          const dz = p.z - c.z;
          const rr = c.r + r;
          if (dx * dx + dz * dz < rr * rr) return c;
          break;
        }
        case CONE: {
          if (p.y + r < c.y0 || p.y - r > c.y1) break;
          const t = Math.min(1, Math.max(0, (p.y - c.y0) / (c.y1 - c.y0)));
          const dx = p.x - c.x;
          const dz = p.z - c.z;
          const rr = c.r * (1 - t) + r;
          if (dx * dx + dz * dz < rr * rr) return c;
          break;
        }
        case ELLIPSOID: {
          const dx = (p.x - c.x) / (c.rx + r);
          const dy = (p.y - c.y) / (c.ry + r);
          const dz = (p.z - c.z) / (c.rx + r);
          if (dx * dx + dy * dy + dz * dz < 1) return c;
          break;
        }
        case OBB: {
          const dx = p.x - c.x;
          const dz = p.z - c.z;
          const ex = Math.max(Math.abs(dx * c.cos - dz * c.sin) - c.hx, 0);
          const ey = Math.max(Math.abs(p.y - c.y) - c.hy, 0);
          const ez = Math.max(Math.abs(dx * c.sin + dz * c.cos) - c.hz, 0);
          const d2 = ex * ex + ey * ey + ez * ez;
          if (d2 < r * r || d2 === 0) return c; // d2 = 0: inside (also for r = 0 line-of-sight probes)
          break;
        }
        case CAPSULE: {
          const ex = c.bx - c.ax;
          const ey = c.by - c.ay;
          const ez = c.bz - c.az;
          const t = Math.max(0, Math.min(1, ((p.x - c.ax) * ex + (p.y - c.ay) * ey + (p.z - c.az) * ez) / (ex * ex + ey * ey + ez * ez)));
          const dx = p.x - c.ax - ex * t;
          const dy = p.y - c.ay - ey * t;
          const dz = p.z - c.az - ez * t;
          const rr = c.r + r;
          if (dx * dx + dy * dy + dz * dz < rr * rr) return c;
          break;
        }
        case MESH: {
          if (p.y + r < c.minY || p.y - r > c.maxY) break;
          const ix0 = Math.max(0, Math.floor((p.x - r - c.minX) / MESH_CELL));
          const ix1 = Math.min(c.gnx - 1, Math.floor((p.x + r - c.minX) / MESH_CELL));
          const iz0 = Math.max(0, Math.floor((p.z - r - c.minZ) / MESH_CELL));
          const iz1 = Math.min(c.gnz - 1, Math.floor((p.z + r - c.minZ) / MESH_CELL));
          const r2 = r * r;
          for (let iz = iz0; iz <= iz1; iz++) {
            for (let ix = ix0; ix <= ix1; ix++) {
              for (const o of c.grid[iz * c.gnx + ix]) if (triDist2(c.tris, o, p.x, p.y, p.z) < r2) return c;
            }
          }
          break;
        }
        case BOX: {
          const dx = Math.max(c.minX - p.x, 0, p.x - c.maxX);
          const dy = Math.max(c.minY - p.y, 0, p.y - c.maxY);
          const dz = Math.max(c.minZ - p.z, 0, p.z - c.maxZ);
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < r * r || d2 === 0) return c;
          break;
        }
      }
    }
    return null;
  }
}
