const CELL = 16; // m, broad-phase grid
const MARGIN = 1; // m, covers the drone radius at cell borders

const CYLINDER = 0;
const CONE = 1;
const ELLIPSOID = 2;
const BOX = 3;
const OBB = 4;
const CAPSULE = 5;

// Obstacles a vehicle can't drive through: trunks, poles, buildings, fences, wrecks, logs (not bushes or crowns)
export const isSolidForVehicles = (c) => c.type === CYLINDER || c.type === BOX || c.type === OBB || c.type === CAPSULE;

const cellKey = (ix, iz) => (ix + 10000) * 20000 + (iz + 10000);

// Static obstacles in a uniform grid; a sphere test only checks one cell.
// Every collider has a `kind` ('tree', 'building', ...) so impacts can be reported.
export class StaticColliders {
  constructor() {
    this.cells = new Map();
  }

  insert(c, minX, maxX, minZ, maxZ) {
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
