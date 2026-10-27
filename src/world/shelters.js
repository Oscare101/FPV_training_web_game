import * as THREE from 'three';
import { VEHICLE_MODELS } from './vehicleModels.js';
import { dugoutDims } from './gen/layout.js';
import { drapeNet, netGeometry } from './camoNet.js';
import { mulberry32 } from './random.js';

// Hide & Seek hideouts, built the way crews really build them. Every visible piece has a matching
// collider and the ways in are real flaws, not doors cut for the game:
//  net:    a camouflage net over poles (or tied to nearby trunks), draped over the vehicle and pegged
//          to the ground. Ways in: the end it drove in from left tied up, a side too short to reach
//          the ground, shrapnel tears. Nets catch the drone but don't stop a blast.
//  dugout: a pit with an entry ramp, log-lined walls, a roof of logs under a layer of earth and sod,
//          the dug-out soil piled around as a parapet. The only way in is the ramp mouth (behind a net
//          curtain on harder levels); earth and logs stop a blast.
// Collider kinds: 'net', 'cover' (blocks blasts), 'pole'.

export const SHELTERS = ['net', 'dugout', 'building'];
export const SHELTER_LABEL = { net: 'camouflage net', dugout: 'dugout', building: 'farm building' };

// Ways in per difficulty (m): net end tied up to `rear` (0 = pegged), a side lifted to `side` for
// `sideLen`, tears of radius `tear`; dugout: curtain gap under the net over the ramp mouth (0 = open)
const FLAWS = {
  net: {
    easy: { rear: 1.6, side: 0, tear: 0.8 },
    normal: { rear: 1.0, side: 0, tear: 0.55 },
    hard: { rear: 0, side: 0.62, sideLen: 3, tear: 0.42 },
  },
  dugout: { easy: { curtain: 0 }, normal: { curtain: 0.95 }, hard: { curtain: 0.58 } },
};

const BARK = 0x5e4b37;
const POLE = 0x6b5a44;
const EARTH = [0.4, 0.33, 0.25];
const SOD = { spring: [0.3, 0.36, 0.2], summer: [0.33, 0.35, 0.21], autumn: [0.42, 0.36, 0.24], winter: [0.78, 0.8, 0.83] };

// Frame of a hideout: local x right, y up from `y0`, z back (nose = -z)
function frame(hd, y0) {
  const c = Math.cos(hd.yaw);
  const sn = Math.sin(hd.yaw);
  return {
    toWorld: (lx, ly, lz) => [hd.x + lx * c + lz * sn, y0 + ly, hd.z - lx * sn + lz * c],
    toLocal: (x, z) => {
      const dx = x - hd.x;
      const dz = z - hd.z;
      return [dx * c - dz * sn, dx * sn + dz * c];
    },
  };
}

// A round log between two local points (merged part) and its capsule collider
function addLog(out, toWorld, a, b, r, kind = 'cover', color = BARK) {
  const pa = new THREE.Vector3(...toWorld(...a));
  const pb = new THREE.Vector3(...toWorld(...b));
  const dir = new THREE.Vector3().subVectors(pb, pa);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(r * 0.92, r, len, 7).translate(0, len / 2, 0)
    .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  out.parts.push({ geo, color, pos: [pa.x, pa.y, pa.z] });
  if (kind) out.cols.push({ t: 'capsule', kind, ax: pa.x, ay: pa.y, az: pa.z, bx: pb.x, by: pb.y, bz: pb.z, r });
}

function addPole(out, toWorld, lx, lz, groundY, top, r = 0.06) {
  const [x, , z] = toWorld(lx, 0, lz);
  const y0 = toWorld(0, groundY, 0)[1];
  const geo = new THREE.CylinderGeometry(r * 0.85, r, top - groundY + 0.3, 6);
  out.parts.push({ geo, color: POLE, pos: [x, y0 + (top - groundY + 0.3) / 2 - 0.3, z] });
  // forked top that holds the net
  for (const s of [-1, 1]) {
    const fork = new THREE.CylinderGeometry(r * 0.5, r * 0.6, 0.35, 5).rotateZ(s * 0.5);
    out.parts.push({ geo: fork, color: POLE, pos: [x + s * 0.08, toWorld(0, top, 0)[1] + 0.12, z] });
  }
  out.cols.push({ t: 'cyl', kind: 'pole', x, z, y0: y0 - 0.3, y1: toWorld(0, top, 0)[1], r });
}

function netHideout(hd, ctx, out) {
  const [w, h, l] = VEHICLE_MODELS[hd.type]().size;
  const hw = w / 2;
  const hl = l / 2;
  const y0 = ctx.heightAt(hd.x, hd.z);
  const { toWorld, toLocal } = frame(hd, y0);
  const ground = (lx, lz) => {
    const [x, , z] = toWorld(lx, 0, lz);
    return ctx.heightAt(x, z) - y0;
  };
  const rand = mulberry32(hd.seed);
  const flaw = FLAWS.net[hd.difficulty] ?? FLAWS.net.normal;
  const px = hw + 1.0;
  const pz = hl + 1.2;
  const poleTop = h + 0.45;
  const nhx = px + 2.1;
  const nhz = pz + 2.3;

  // supports: corner and ridge poles; a trunk close to a corner takes that corner's place
  const trunks = ctx.treesNear(hd.x, hd.z, Math.hypot(nhx, nhz) + 2).map((t) => {
    const [lx, lz] = toLocal(t.x, t.z);
    return { lx, lz, r: 0.18 + t.h * 0.012, top: t.h * 0.6 };
  });
  const posts = [...trunks];
  const pins = [];
  const corners = [[-px, -pz], [px, -pz], [-px, pz], [px, pz]];
  for (const [cx, cz] of corners) {
    const tree = trunks.find((t) => Math.hypot(t.lx - cx, t.lz - cz) < 2.6 && Math.abs(t.lx) > hw + 0.4 && Math.abs(t.lz) > 0);
    if (tree) {
      pins.push({ lx: tree.lx - Math.sign(tree.lx) * (tree.r + 0.05), lz: tree.lz, ly: ground(tree.lx, tree.lz) + h + 0.9 }); // tied to the trunk
    } else {
      const top = poleTop + ground(cx, cz) + rand() * 0.25;
      addPole(out, toWorld, cx, cz, ground(cx, cz), top);
      posts.push({ lx: cx, lz: cz, r: 0.06, top });
      pins.push({ lx: cx, lz: cz, ly: top + 0.04 });
    }
  }
  for (const rz of [-hl * 0.45, hl * 0.45]) {
    const top = h + 0.85 + ground(0, rz);
    addPole(out, toWorld, 0, rz, ground(0, rz), top, 0.07);
    posts.push({ lx: 0, lz: rz, r: 0.07, top });
    pins.push({ lx: 0, lz: rz, ly: top + 0.04 });
  }
  // pegs around the edge, except where the flaws are
  const sideSign = rand() < 0.5 ? -1 : 1;
  const step = 1.4;
  const peg = (lx, lz) => pins.push({ lx, lz, ly: ground(lx, lz) + 0.05 });
  for (let x = -nhx; x <= nhx + 1e-3; x += (2 * nhx) / Math.round((2 * nhx) / step)) {
    peg(x, -nhz); // front
    if (flaw.rear && Math.abs(x) < px + 0.5) pins.push({ lx: x, lz: nhz - 0.6, ly: ground(x, nhz) + flaw.rear + 0.1 * Math.cos(x) }); // rolled up and tied
    else peg(x, nhz);
  }
  for (let z = -nhz + step; z < nhz - 0.1; z += (2 * nhz) / Math.round((2 * nhz) / step)) {
    for (const s of [-1, 1]) {
      if (flaw.side && s === sideSign && Math.abs(z) < flaw.sideLen / 2) pins.push({ lx: s * (nhx - 0.5), lz: z, ly: ground(s * nhx, z) + flaw.side });
      else peg(s * nhx, z);
    }
  }
  // tears: over the vehicle's back half (a dive through it lands on the roof), one more on a slope
  const tears = [];
  if (flaw.tear) {
    tears.push({ lx: (rand() - 0.5) * hw, lz: hl * (0.15 + rand() * 0.35), r: flaw.tear });
    if (hd.difficulty !== 'hard') tears.push({ lx: sideSign * -(px + 0.6), lz: -hl * 0.3, r: flaw.tear * 0.8 });
  }
  const net = drapeNet({
    hx: nhx, hz: nhz, spacing: 0.45, top: h + 2.2, ground, pins, posts, tears, rand,
    boxes: hd.occupied ? [{ cx: 0, cy: h / 2, cz: 0, hx: hw, hy: h / 2, hz: hl }] : [],
    slack: 0.06, ragged: 0.3,
  });
  const { geo, tris } = netGeometry(net, toWorld);
  out.nets.push(geo);
  out.cols.push({ t: 'mesh', kind: 'net', tris });
}

// Earth-coloured triangle soup helper (vertex colours, merged as one part)
function earthMesh(positions, colors) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

function dugoutHideout(hd, ctx, out) {
  const d = dugoutDims(hd.type);
  const y0 = hd.ground; // ground level before digging (the pit floor is y0 - depth)
  const { toWorld } = frame(hd, y0);
  const rand = mulberry32(hd.seed);
  const flaw = FLAWS.dugout[hd.difficulty] ?? FLAWS.dugout.normal;
  const floor = -d.depth;
  const roofY = d.roofY; // underside of the roof logs, above ground
  const roofEnd = d.pl - 0.4; // the roof stops here; behind it the pit is open down to the ramp
  const sod = SOD[ctx.season] ?? SOD.summer;
  const LOG = 0.1;

  // log-lined walls: left, right, front, and the ramp sides tapering up to the ground
  const wallTop = 0.22;
  for (let y = floor + LOG; y < wallTop; y += LOG * 2) {
    for (const s of [-1, 1]) addLog(out, toWorld, [s * (d.pw + LOG), y, -d.pl - LOG], [s * (d.pw + LOG), y, d.pl], LOG, null);
    addLog(out, toWorld, [-d.pw - LOG, y, -d.pl - LOG], [d.pw + LOG, y, -d.pl - LOG], LOG, null);
  }
  const wallCol = (lx, lz, hx, hz, top = wallTop) => {
    const [x, y, z] = toWorld(lx, (floor + top) / 2, lz);
    out.cols.push({ t: 'obb', kind: 'cover', x, y, z, hx, hy: (top - floor) / 2, hz, yaw: hd.yaw });
  };
  for (const s of [-1, 1]) wallCol(s * (d.pw + LOG), 0, LOG, d.pl + LOG);
  wallCol(0, -d.pl - LOG, d.pw + LOG * 2, LOG);

  // posts and the roof: beams along the walls, logs across, then earth and sod on top
  for (const s of [-1, 1]) {
    for (const lz of [-d.pl + 0.2, 0, roofEnd - 0.1]) {
      addLog(out, toWorld, [s * (d.pw - 0.12), floor, lz], [s * (d.pw - 0.12), roofY, lz], 0.09, 'pole');
    }
    addLog(out, toWorld, [s * (d.pw - 0.12), roofY + 0.1, -d.pl - 0.3], [s * (d.pw - 0.12), roofY + 0.1, roofEnd + 0.1], 0.12, null);
  }
  for (let lz = -d.pl - 0.2; lz <= roofEnd; lz += 0.25) addLog(out, toWorld, [-d.pw - 0.7, roofY + 0.3, lz], [d.pw + 0.7, roofY + 0.3 + (rand() - 0.5) * 0.04, lz], 0.115, null);
  {
    const [x, y, z] = toWorld(0, roofY + 0.45, (roofEnd - d.pl - 0.3) / 2);
    out.cols.push({ t: 'obb', kind: 'cover', x, y, z, hx: d.pw + 0.8, hy: 0.45, hz: (roofEnd + d.pl + 0.3) / 2, yaw: hd.yaw });
  }

  // Mound: earth over the roof and the spoil parapet around the sides and front, one bumpy surface
  // over a grid in the hideout frame; height falls off outside the pit to the ground ~3 m out
  const top = roofY + 0.75; // earth crown over the roof
  const reachX = d.pw + 3.6;
  const reachZ0 = -d.pl - 3.4;
  const reachZ1 = d.pl + d.ramp + 1;
  const G = 0.45;
  const nx = Math.round((2 * reachX) / G) + 1;
  const nz = Math.round((reachZ1 - reachZ0) / G) + 1;
  const lump = (lx, lz) => (Math.sin(lx * 1.3 + lz * 0.7 + hd.seed) + Math.sin(lx * 0.6 - lz * 1.7 + hd.seed * 0.3) + Math.sin(lx * 2.9 + lz * 2.3) * 0.4) * 0.09;
  const hAt = (lx, lz) => {
    // distance outside the pit's outline (rounded rectangle), with a wobbly rim
    const ex = Math.max(0, Math.abs(lx) - d.pw - 0.3);
    const ez = Math.max(0, -d.pl - 0.3 - lz);
    const rim = 3 * (1 + 0.18 * Math.sin(Math.atan2(lx, lz) * 5 + hd.seed));
    const k = Math.max(0, 1 - Math.hypot(ex, ez) / rim);
    const along = lz > roofEnd ? Math.max(0, 1 - (lz - roofEnd) / (d.ramp + 0.6)) : 1; // tapers along the ramp
    const dome = 1 - 0.12 * (lx / (d.pw + 1)) ** 2;
    const s = k * k * (3 - 2 * k) * along;
    return (top * dome + lump(lx, lz)) * s - (1 - s) * 0.3; // sinks into the ground at the rim
  };
  const pos = [];
  const col = [];
  const groundCol = new THREE.Color();
  const vtx = (i, j) => {
    const lx = -reachX + i * G;
    const lz = reachZ0 + j * G;
    let ly = hAt(lx, lz);
    const w = toWorld(lx, ly, lz);
    const g = ctx.heightAt(w[0], w[2]) - y0;
    const inMouth = Math.abs(lx) < d.pw + 0.35;
    const channel = inMouth && lz > roofEnd + 0.25; // the ramp: no mound in it
    if (inMouth && !channel) ly = Math.min(ly, roofY + 0.3 + Math.max(0, roofEnd - lz) * 0.9); // slopes down to the roof edge
    if (channel) ly = g - 0.3;
    if (ly < g + 0.03) ly = g - 0.08; // tuck the rim under the terrain
    // sod (the local ground colour) on top; bare earth on steep, dug parts near the pit and the ramp
    ctx.groundColor(w[0], w[2], groundCol);
    const dug = Math.min(1, Math.max(0, 1.4 - Math.hypot(Math.max(0, Math.abs(lx) - d.pw), Math.max(0, lz - roofEnd)) / 1.2)) * (lz > roofEnd - 0.4 ? 1 : 0.35);
    const patch = 0.5 + 0.5 * Math.sin(lx * 2.1 + hd.seed) * Math.sin(lz * 1.7);
    return { p: toWorld(lx, ly, lz), earthK: Math.min(1, dug + patch * 0.25), g: [groundCol.r, groundCol.g, groundCol.b], channel, mouthEdge: inMouth && !channel && lz > roofEnd - 0.5 };
  };
  const grid = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) grid.push(vtx(i, j));
  const push = (v) => {
    pos.push(...v.p);
    const k = v.earthK;
    const sodC = ctx.season === 'winter' ? sod : v.g.map((x, i) => x * 0.85 + sod[i] * 0.15);
    col.push(sodC[0] + (EARTH[0] - sodC[0]) * k, sodC[1] + (EARTH[1] - sodC[1]) * k, sodC[2] + (EARTH[2] - sodC[2]) * k);
  };
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = grid[j * nx + i];
      const b = grid[j * nx + i + 1];
      const c = grid[(j + 1) * nx + i];
      const e = grid[(j + 1) * nx + i + 1];
      // leave the mouth open: no face from the roof edge down into the ramp
      const opening = (q) => q.some((v) => v.channel) && q.some((v) => v.mouthEdge);
      if (!opening([a, c, b])) { push(a); push(c); push(b); }
      if (!opening([b, c, e])) { push(b); push(c); push(e); }
    }
  }
  out.earth.push(earthMesh(pos, col));
  // parapet colliders (the mound beside and in front of the pit)
  for (const s of [-1, 1]) {
    const [x, y, z] = toWorld(s * (d.pw + 1.4), top * 0.45, (reachZ0 + roofEnd) / 2 + 1);
    out.cols.push({ t: 'obb', kind: 'cover', x, y, z, hx: 1.2, hy: top * 0.45, hz: (roofEnd - reachZ0) / 2 - 0.6, yaw: hd.yaw });
  }
  {
    const [x, y, z] = toWorld(0, top * 0.45, -d.pl - 1.4);
    out.cols.push({ t: 'obb', kind: 'cover', x, y, z, hx: d.pw + 1.6, hy: top * 0.45, hz: 1.2, yaw: hd.yaw });
  }
  // cut branches thrown on the mound
  const leaf = ctx.season === 'winter' ? [0x6f6a5e, 0x5d5a50] : ctx.season === 'autumn' ? [0x6e5a32, 0x5e4a2a] : [0x4a5530, 0x3e4a2a];
  for (let k = 0; k < 11; k++) {
    const lx = (rand() - 0.5) * 2 * (d.pw + 1);
    const lz = -d.pl - 1.5 + rand() * (roofEnd + d.pl + 1);
    const r = 0.45 + rand() * 0.45;
    const geo = new THREE.IcosahedronGeometry(r, 1);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const f = 0.65 + rand() * 0.6; // ragged
      p.setXYZ(i, p.getX(i) * f, p.getY(i) * f * 0.4, p.getZ(i) * f * 1.4);
    }
    geo.rotateY(rand() * Math.PI).computeVertexNormals();
    const [x, y, z] = toWorld(lx, hAt(lx, lz) + r * 0.12, lz);
    out.parts.push({ geo, color: leaf[k % 2], pos: [x, y, z] });
  }
  // net curtain over the ramp mouth (harder levels): hangs from the roof edge, gap below
  if (flaw.curtain) {
    const zc = roofEnd + 0.05;
    const yTop = roofY + 0.25;
    const yBottom = floor + flaw.curtain;
    const cols = 9;
    const rows = 5;
    const pts = new Float32Array(cols * rows * 3);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = (j * cols + i) * 3;
        pts[k] = -d.pw - 0.2 + ((2 * d.pw + 0.4) * i) / (cols - 1);
        pts[k + 1] = yTop + ((yBottom - yTop) * j) / (rows - 1) + (j === rows - 1 ? (rand() - 0.5) * 0.08 : 0);
        pts[k + 2] = zc + Math.sin(i * 1.7 + j) * 0.06 * (j / (rows - 1));
      }
    }
    const { geo, tris } = netGeometry({ points: pts, cut: new Uint8Array(cols * rows), nx: cols, nz: rows, spacing: 0.5 }, toWorld);
    out.nets.push(geo);
    out.cols.push({ t: 'mesh', kind: 'net', tris });
  }
}

// s: a layout hideout { kind, difficulty, type, x, z, yaw, occupied, seed, ground?, floor? };
// ctx: { heightAt, treesNear(x, z, r), season }.
// Returns { parts (mergeParts list), nets (geometries), earth (vertex-coloured geometries), cols }
export function buildShelter(hd, ctx) {
  const out = { parts: [], nets: [], earth: [], cols: [] };
  if (hd.kind === 'dugout') dugoutHideout(hd, ctx, out);
  else if (hd.kind === 'net') netHideout(hd, ctx, out);
  // 'building': the farm building itself is the hideout (built with the map)
  return out;
}

// Faint tyre or track marks along a polyline: two ruts following the ground, built as continuous
// strips (shared rows) so curves don't overlap and double the transparency
export function buildTrackGeometry(track, heightAt) {
  const { pts, gauge } = track;
  const rut = track.wheels ? 0.32 : 0.5;
  // resample every metre with a smoothed direction
  const samples = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    for (let t = 0; t < len; t += 1) samples.push([ax + ((bx - ax) * t) / len, az + ((bz - az) * t) / len]);
  }
  samples.push(pts[pts.length - 1]);
  const n = samples.length;
  if (n < 2) return new THREE.BufferGeometry();
  const fade = (k) => Math.max(0, Math.min(1, k / 12, (n - 1 - k) / 4)); // in from the road, out at the hideout
  const rows = samples.map(([x, z], k) => {
    const [px, pz] = samples[Math.max(0, k - 2)];
    const [qx, qz] = samples[Math.min(n - 1, k + 2)];
    const len = Math.hypot(qx - px, qz - pz) || 1;
    const nx = -(qz - pz) / len;
    const nz = (qx - px) / len;
    return [-1, 1].flatMap((side) => [-rut / 2, rut / 2].map((e) => {
      const vx = x + nx * ((side * gauge) / 2 + e);
      const vz = z + nz * ((side * gauge) / 2 + e);
      return [vx, heightAt(vx, vz) + 0.035, vz, fade(k)];
    }));
  });
  const pos = [];
  const col = [];
  for (let k = 0; k < n - 1; k++) {
    const a = rows[k];
    const b = rows[k + 1];
    for (const j of [0, 2]) {
      for (const v of [a[j], a[j + 1], b[j], a[j + 1], b[j + 1], b[j]]) { // facing up
        pos.push(v[0], v[1], v[2]);
        col.push(1, 1, 1, v[3]);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4)); // alpha fades the ends
  geo.computeVertexNormals();
  return geo;
}
