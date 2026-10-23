const CELL = 16; // m, broad-phase grid
const MARGIN = 1; // m, covers the drone radius at cell borders

const CYLINDER = 0;
const CONE = 1;
const ELLIPSOID = 2;
const BOX = 3;
const OBB = 4;

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

  // Returns the first collider touching the sphere, or null.
  hits(p, r) {
    const list = this.cells.get(cellKey(Math.floor(p.x / CELL), Math.floor(p.z / CELL)));
    if (!list) return null;
    for (const c of list) {
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
