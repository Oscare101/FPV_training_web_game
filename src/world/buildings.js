import * as THREE from 'three';
import { roofGeometry } from './meshUtils.js';

// Procedural village buildings. Every visible piece that matters for flying is emitted together
// with a matching collision box (rotated with the building), so what you see is what you hit:
// a roofless ruin has no roof collider, a gap in a wall is a gap.
// Local frame: x across the width w, z along the depth d (ridge direction), y up from the base.

const WALLS = [0xc9c2b0, 0xb8b09a, 0xd2c8b4, 0xa9a596, 0xbfb59c];
const ROOFS = [0x5e3a2c, 0x4a4b4d, 0x55585a, 0x3d4648, 0x6a4a36];
const BRICK = [0x7a4c3c, 0x86786a, 0x6c5a4c];
const WOOD = [0x5a4a3a, 0x6a5a48, 0x4e4438];
const SOOT = 0x2c2926;
const RUBBLE = [0x77706a, 0x8a8278, 0x5e5650, 0x6c5c4c];
const GLASS = 0x22292d;
const FRAME = 0xd6d2c6;

function builder(h, y0) {
  const parts = [];
  const cols = [];
  const c = Math.cos(h.yaw);
  const s = Math.sin(h.yaw);
  const world = (lx, lz) => [h.x + lx * c + lz * s, h.z - lx * s + lz * c];
  return {
    parts,
    cols,
    // Visible box; collide: add a matching rotated collider (only for upright boxes)
    box(w, hh, d, lx, ly, lz, color, { rotY = 0, rotX = 0, rotZ = 0, collide = true } = {}) {
      const [x, z] = world(lx, lz);
      parts.push({ geo: new THREE.BoxGeometry(w, hh, d), color, pos: [x, y0 + ly, z], rotY: h.yaw + rotY, rotX, rotZ });
      if (collide && !rotX && !rotZ) cols.push([x, y0 + ly, z, w / 2, hh / 2, d / 2, h.yaw + rotY]);
    },
    geo(geometry, color, lx, ly, lz, { rotY = 0, rotX = 0, rotZ = 0 } = {}) {
      const [x, z] = world(lx, lz);
      parts.push({ geo: geometry, color, pos: [x, y0 + ly, z], rotY: h.yaw + rotY, rotX, rotZ });
    },
    col(lx, ly, lz, hx, hy, hz, rotY = 0) {
      const [x, z] = world(lx, lz);
      cols.push([x, y0 + ly, z, hx, hy, hz, h.yaw + rotY]);
    },
  };
}

const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];

// Gable roof with its ridge along z, plus 3 stepped colliders following the slopes
function gableRoof(b, w, d, top, rh, color, zFrom = -d / 2, zTo = d / 2) {
  const len = zTo - zFrom;
  b.geo(roofGeometry(w, rh, len), color, 0, top, (zFrom + zTo) / 2);
  for (let i = 0; i < 3; i++) {
    const hw = (w / 2) * (1 - (i + 0.5) / 3);
    b.col(0, top + (rh * (i + 0.5)) / 3, (zFrom + zTo) / 2, hw, rh / 6, len / 2);
  }
}

// Windows (pane + frame) along one wall face; face: 'x+', 'x-', 'z+', 'z-'
function windows(b, face, len, offset, sill, rand, burnt = false) {
  const n = Math.max(1, Math.floor(len / 2.4));
  for (let k = 0; k < n; k++) {
    const t = -len / 2 + (len / n) * (k + 0.5);
    const along = face[0] === 'x';
    const sign = face[1] === '+' ? 1 : -1;
    const lx = along ? sign * offset : t;
    const lz = along ? t : sign * offset;
    const w = along ? 0.06 : 1.0;
    const d = along ? 1.0 : 0.06;
    b.box(w, 1.15, d, lx, sill + 0.58, lz, burnt ? 0x141210 : GLASS, { collide: false });
    if (!burnt || rand() < 0.5) {
      b.box(along ? 0.08 : 1.16, 0.08, along ? 1.16 : 0.08, lx, sill + 1.2, lz, FRAME, { collide: false });
      b.box(along ? 0.08 : 1.16, 0.08, along ? 1.16 : 0.08, lx, sill - 0.02, lz, FRAME, { collide: false });
    }
  }
}

function house(h, y0, rand) {
  const b = builder(h, y0);
  const wall = pick(WALLS, rand);
  const plinth = 0.5;
  const top = plinth + h.h;
  b.box(h.w + 0.12, plinth, h.d + 0.12, 0, plinth / 2, 0, 0x5d5a55);
  // front faces the road: local x side opposite to `back`
  const backX = Math.sign(h.back[0] * Math.cos(h.yaw) - h.back[1] * Math.sin(h.yaw)) || 1;
  if (!h.ruined) {
    b.box(h.w, h.h, h.d, 0, plinth + h.h / 2, 0, wall);
    windows(b, backX > 0 ? 'x-' : 'x+', h.d, h.w / 2 + 0.03, plinth + 0.9, rand);
    windows(b, backX > 0 ? 'x+' : 'x-', h.d, h.w / 2 + 0.03, plinth + 0.9, rand);
    windows(b, 'z+', h.w, h.d / 2 + 0.03, plinth + 0.9, rand);
    b.box(0.06, 2.0, 0.95, -backX * (h.w / 2 + 0.03), plinth + 1.0, h.d / 4, 0x4e3a2a, { collide: false }); // door
    b.box(0.8, 0.2, 1.3, -backX * (h.w / 2 + 0.4), 0.1, h.d / 4, 0x6a6660); // step
    const rh = 1.8 + rand() * 0.9;
    gableRoof(b, h.w + 0.7, h.d + 0.7, top, rh, pick(ROOFS, rand));
    b.box(0.5, rh * 0.9 + 0.5, 0.5, h.w * 0.22, top + rh * 0.45 + 0.25, h.d * 0.18, 0x7a5a4a); // chimney
    return b;
  }
  if (rand() < 0.6) {
    // Burnt-out shell: jagged walls, soot on top, rubble and fallen beams inside, no roof
    const faces = [['z-', h.w], ['z+', h.w], ['x-', h.d], ['x+', h.d]];
    for (const [face, len] of faces) {
      const along = face[0] === 'x';
      const sign = face[1] === '+' ? 1 : -1;
      const segs = 4 + Math.floor(rand() * 3);
      for (let k = 0; k < segs; k++) {
        if (rand() < 0.15) continue; // breach
        const segLen = len / segs;
        const t = -len / 2 + segLen * (k + 0.5);
        const corner = k === 0 || k === segs - 1;
        const wh = corner ? h.h * (0.7 + rand() * 0.3) : h.h * (0.25 + rand() * 0.75);
        const lx = along ? sign * (h.w / 2 - 0.15) : t;
        const lz = along ? t : sign * (h.d / 2 - 0.15);
        b.box(along ? 0.3 : segLen, wh, along ? segLen : 0.3, lx, plinth + wh / 2, lz, wall);
        // soot cap: clearly wider than the wall and inset at the ends, so no face is coplanar with a wall (no flicker)
        b.box(along ? 0.38 : segLen - 0.08, 0.35, along ? segLen - 0.08 : 0.38, lx, plinth + wh - 0.15, lz, SOOT, { collide: false });
      }
    }
    for (let k = 0; k < 7; k++) {
      const sz = 0.5 + rand() * 1.2;
      b.box(sz, sz * 0.5, sz * (0.6 + rand() * 0.6), (rand() - 0.5) * (h.w - 1.5), plinth + sz * 0.25, (rand() - 0.5) * (h.d - 1.5), pick(RUBBLE, rand), { rotY: rand() * 3 });
    }
    for (let k = 0; k < 3; k++) b.box(0.18, 0.18, h.d * (0.5 + rand() * 0.4), (rand() - 0.5) * (h.w - 1.5), plinth + 0.6 + rand() * 0.6, (rand() - 0.5) * 1.5, 0x2a2420, { rotY: (rand() - 0.5) * 0.6 });
    return b;
  }
  // Collapsed: a corner still standing, a mound of rubble and roof sheets
  const cx = (rand() < 0.5 ? -1 : 1) * (h.w / 2 - 0.15);
  const cz = (rand() < 0.5 ? -1 : 1) * (h.d / 2 - 0.15);
  const ch = h.h * (0.6 + rand() * 0.35);
  b.box(0.3, ch, h.d * (0.3 + rand() * 0.3), cx, plinth + ch / 2, cz * 0.6, wall);
  b.box(h.w * (0.3 + rand() * 0.3), ch * 0.8, 0.3, cx * 0.6, plinth + ch * 0.4, cz, wall);
  for (let k = 0; k < 12; k++) {
    const sz = 0.6 + rand() * 1.6;
    const lx = (rand() - 0.5) * h.w * 0.8;
    const lz = (rand() - 0.5) * h.d * 0.8;
    const centre = 1 - Math.hypot(lx / h.w, lz / h.d);
    b.box(sz, sz * (0.3 + centre * 0.5), sz, lx, plinth + sz * 0.2 * (1 + centre), lz, pick(RUBBLE, rand), { rotY: rand() * 3 });
  }
  for (let k = 0; k < 3; k++) b.box(2 + rand() * 2, 0.06, 1.5 + rand(), (rand() - 0.5) * h.w * 0.6, plinth + 0.8 + rand() * 0.5, (rand() - 0.5) * h.d * 0.6, pick(ROOFS, rand), { rotY: rand() * 3 });
  return b;
}

function barn(h, y0, rand) {
  const b = builder(h, y0);
  const wall = rand() < 0.5 ? pick(WOOD, rand) : pick(BRICK, rand);
  const roof = rand() < 0.6 ? 0x6b6e70 : 0x5a3e30;
  b.box(h.w, h.h, h.d, 0, h.h / 2, 0, wall);
  for (let k = 0; k < Math.floor(h.d / 1.2); k++) {
    for (const sx of [-1, 1]) b.box(0.05, h.h * 0.95, 0.08, sx * (h.w / 2 + 0.02), h.h / 2, -h.d / 2 + 0.6 + k * 1.2, 0x3a3028, { collide: false }); // planks
  }
  for (const sz of [-1, 1]) b.box(Math.min(3, h.w * 0.35), Math.min(3.4, h.h * 0.8), 0.08, 0, Math.min(3.4, h.h * 0.8) / 2, sz * (h.d / 2 + 0.04), 0x2a2420, { collide: false }); // big doors
  const rh = h.w * 0.32;
  if (!h.ruined) {
    gableRoof(b, h.w + 0.8, h.d + 0.6, h.h, rh, roof);
  } else {
    // half the roof is gone, rafters showing over the open half
    const split = (rand() - 0.5) * h.d * 0.4;
    gableRoof(b, h.w + 0.8, h.d + 0.6, h.h, rh, roof, -h.d / 2 - 0.3, split);
    const slope = Math.atan(rh / (h.w / 2));
    const rafter = (h.w / 2) / Math.cos(slope);
    for (let z = split + 1; z < h.d / 2; z += 1.6) {
      for (const sx of [-1, 1]) {
        // each rafter rises from the wall (x = ±w/2) to the ridge (x = 0)
        b.geo(new THREE.BoxGeometry(rafter, 0.14, 0.14), 0x2a2420, (sx * h.w) / 4, h.h + rh / 2, z, { rotZ: -sx * slope });
        for (let i = 0; i < 3; i++) {
          const f = (i + 0.5) / 3; // from the wall toward the ridge
          b.col(sx * (h.w / 2) * (1 - f), h.h + rh * f, z, h.w / 12, 0.12, 0.08);
        }
      }
    }
    b.box(h.w * 0.5, 0.06, 2.5, (rand() - 0.5) * h.w * 0.3, 0.6, split + 3, roof, { rotY: rand() }); // fallen sheet
  }
  return b;
}

function garage(h, y0, rand) {
  const b = builder(h, y0);
  const wall = pick(BRICK, rand);
  const backX = Math.sign(h.back[0] * Math.cos(h.yaw) - h.back[1] * Math.sin(h.yaw)) || 1;
  b.box(h.w, h.h, h.d, 0, h.h / 2, 0, wall);
  const door = !h.ruined || rand() < 0.5;
  b.box(0.06, 2.1, h.d * 0.75, -backX * (h.w / 2 + 0.03), 1.05, 0, door ? 0x4f5848 : 0x121110, { collide: false });
  if (door) for (let k = -3; k <= 3; k++) b.box(0.08, 2.1, 0.05, -backX * (h.w / 2 + 0.05), 1.05, (k * h.d * 0.75) / 7, 0x434b3c, { collide: false });
  if (!h.ruined) b.box(h.w + 0.3, 0.18, h.d + 0.3, 0, h.h + 0.09, 0, 0x3a3a3a);
  else b.box(h.w * 0.9, 0.18, h.d * 0.6, 0, 1.0, h.d * 0.15, 0x3a3a3a, { rotY: 0.1 }); // roof slab fell in
  return b;
}

function shed(h, y0, rand) {
  const b = builder(h, y0);
  const wall = pick(WOOD, rand);
  b.box(h.w, h.h, h.d, 0, h.h / 2, 0, wall);
  for (let k = 0; k < Math.floor(h.w / 0.5); k++) b.box(0.04, h.h, 0.04, -h.w / 2 + 0.25 + k * 0.5, h.h / 2, h.d / 2 + 0.02, 0x3a3028, { collide: false });
  if (!h.ruined) {
    // lean-to roof sloping along z; colliders as 3 steps under the slope
    const rise = 0.6;
    const slope = Math.atan(rise / h.d);
    b.geo(new THREE.BoxGeometry(h.w + 0.5, 0.08, Math.hypot(h.d, rise) + 0.5), 0x585a5c, 0, h.h + rise / 2, 0, { rotX: slope });
    // the slab rises toward -z (positive rotX lifts the front end)
    for (let i = 0; i < 3; i++) b.col(0, h.h + (rise * (i + 0.5)) / 3, h.d / 2 - (h.d * (i + 0.5)) / 3, (h.w + 0.5) / 2, rise / 6 + 0.05, h.d / 6 + 0.1);
  }
  return b;
}

const BUILD = { house, barn, garage, shed };

// Returns { parts, cols } in world space; cols: [x, y, z, hx, hy, hz, yaw]
export function buildBuilding(h, heightAt, rand) {
  const c = Math.cos(h.yaw);
  const s = Math.sin(h.yaw);
  const corner = (a, b2) => heightAt(h.x + a * c + b2 * s, h.z - a * s + b2 * c);
  const y0 = Math.min(corner(-h.w / 2, -h.d / 2), corner(h.w / 2, -h.d / 2), corner(-h.w / 2, h.d / 2), corner(h.w / 2, h.d / 2)) - 0.2;
  return (BUILD[h.kind] ?? house)(h, y0, rand);
}

// Yard fence segment: boards or pickets between posts, weathered or painted
const FENCE_COLORS = [0x6a5f52, 0x5a5048, 0x4f6a5a, 0x5a6a7a, 0x7a6a5a];
export function buildFence(f, heightAt, rand) {
  const parts = [];
  const len = Math.hypot(f.x2 - f.x1, f.z2 - f.z1);
  const yaw = Math.atan2(-(f.x2 - f.x1), -(f.z2 - f.z1)) + Math.PI / 2; // local x along the fence
  const mx = (f.x1 + f.x2) / 2;
  const mz = (f.z1 + f.z2) / 2;
  const y = heightAt(mx, mz) - 0.1;
  const color = FENCE_COLORS[Math.floor(rand() * FENCE_COLORS.length)];
  const hgt = 1.2 + rand() * 0.4;
  const boards = rand() < 0.5;
  if (boards) parts.push({ geo: new THREE.BoxGeometry(len, hgt, 0.04), color, pos: [mx, y + hgt / 2, mz], rotY: yaw });
  else {
    for (const ry of [0.35, hgt - 0.25]) parts.push({ geo: new THREE.BoxGeometry(len, 0.07, 0.05), color, pos: [mx, y + ry, mz], rotY: yaw });
    const n = Math.max(1, Math.floor(len / 0.22));
    for (let k = 0; k <= n; k++) {
      const t = -len / 2 + (len * k) / n;
      parts.push({ geo: new THREE.BoxGeometry(0.08, hgt * (0.9 + rand() * 0.1), 0.025), color, pos: [mx + Math.cos(yaw) * t, y + hgt / 2, mz - Math.sin(yaw) * t], rotY: yaw });
    }
  }
  for (const t of [-len / 2, len / 2]) parts.push({ geo: new THREE.BoxGeometry(0.1, hgt + 0.15, 0.1), color: 0x4a4036, pos: [mx + Math.cos(yaw) * t, y + (hgt + 0.15) / 2, mz - Math.sin(yaw) * t], rotY: yaw });
  return { parts, col: [mx, y + hgt / 2, mz, len / 2, hgt / 2, 0.06, yaw] };
}
