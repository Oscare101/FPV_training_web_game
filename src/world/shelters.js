import * as THREE from 'three';
import { VEHICLE_MODELS } from './vehicleModels.js';

// Hide & Seek hideouts around a parked vehicle. Every visible piece has a matching collider and
// the ways in are real gaps in both: a hole in a net roof, a door/window/roof hole in a barn, the
// low front of a log dugout. Nets catch the drone but let a blast through; walls, earth berms and
// log roofs stop it (kinds: 'net', 'building', 'cover', 'pole').

export const SHELTERS = ['nets', 'barn', 'dugout'];
export const SHELTER_LABEL = { nets: 'net tunnel', barn: 'barn', dugout: 'log dugout' };
const NET_THICK = 0.05; // half thickness of a net panel collider

// Opening sizes per difficulty (m)
const SIZES = {
  nets: { easy: { hole: 1.4, gap: 1.4 }, normal: { hole: 1.0, gap: 1.0 }, hard: { hole: 0.75, gap: 0.7 } },
  barn: { easy: { door: [0, 0.6], window: [1.3, 1.1], roof: 1.6 }, normal: { door: [2.4, 2.0], window: [0.9, 0.8], roof: 0.9 }, hard: { door: [1.5, 1.2], window: null, roof: 0 } },
  dugout: { easy: { flap: 0 }, normal: { flap: 1.15 }, hard: { flap: 0.95, slitLog: 0.35 } },
};

// rect [a0,a1]x[b0,b1] minus hole [h0,h1]x[k0,k1] -> up to 4 rects
function cutHole([a0, a1, b0, b1], hole) {
  if (!hole) return [[a0, a1, b0, b1]];
  const [h0, h1, k0, k1] = hole;
  return [[a0, a1, b0, k0], [a0, a1, k1, b1], [a0, h0, k0, k1], [h1, a1, k0, k1]].filter(([x0, x1, y0, y1]) => x1 - x0 > 0.02 && y1 - y0 > 0.02);
}

// s: { kind, difficulty, type, x, z, yaw }; returns { parts (mergeParts boxes), nets (world-space quads with uv), cols }
export function buildShelter(s, heightAt, rand) {
  const [w, h, l] = VEHICLE_MODELS[s.type]().size;
  const y0 = heightAt(s.x, s.z);
  const c = Math.cos(s.yaw);
  const sn = Math.sin(s.yaw);
  const toWorld = (lx, ly, lz) => [s.x + lx * c + lz * sn, y0 + ly, s.z - lx * sn + lz * c];
  const parts = [];
  const nets = []; // [ [x,y,z] x4 corners ] quads
  const cols = []; // { t: 'obb'|'cyl'|'capsule', kind, ... }
  const sz = SIZES[s.kind][s.difficulty] ?? SIZES[s.kind].normal;

  const box = (bw, bh, bd, lx, ly, lz, color, kind) => {
    const [x, y, z] = toWorld(lx, ly, lz);
    parts.push({ geo: new THREE.BoxGeometry(bw, bh, bd), color, pos: [x, y, z], rotY: s.yaw });
    if (kind) cols.push({ t: 'obb', kind, x, y, z, hx: bw / 2, hy: bh / 2, hz: bd / 2, yaw: s.yaw });
  };
  const pole = (lx, lz, top, r = 0.06) => {
    const [x, , z] = toWorld(lx, 0, lz);
    parts.push({ geo: new THREE.CylinderGeometry(r, r * 1.2, top + 0.3, 6), color: 0x5b4a3a, pos: [x, y0 + top / 2 - 0.15, z] });
    cols.push({ t: 'cyl', kind: 'pole', x, z, y0: y0 - 0.3, y1: y0 + top, r });
  };
  const log = (ax, ay, az, bx, by, bz, r, kind = 'cover') => {
    const a = new THREE.Vector3(...toWorld(ax, ay, az));
    const b = new THREE.Vector3(...toWorld(bx, by, bz));
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const geo = new THREE.CylinderGeometry(r * 0.9, r, len, 7).translate(0, len / 2, 0)
      .applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
    parts.push({ geo, color: 0x5e4b37, pos: [a.x, a.y, a.z] });
    cols.push({ t: 'capsule', kind, ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, r: r * 0.95 });
  };
  // Net panel (axis-aligned in the shelter frame), optional rectangular hole, as quads + thin boxes
  // plane 'x' (at lx = at, spans z,y), 'z' (at lz = at, spans x,y), 'y' (at ly = at, spans x,z)
  const panel = (plane, at, rect, hole = null) => {
    for (const [p0, p1, q0, q1] of cutHole(rect, hole)) {
      const corner = (p, q) => (plane === 'x' ? toWorld(at, q, p) : plane === 'z' ? toWorld(p, q, at) : toWorld(p, at, q));
      nets.push([corner(p0, q0), corner(p1, q0), corner(p1, q1), corner(p0, q1)]);
      const cp = (p0 + p1) / 2;
      const cq = (q0 + q1) / 2;
      const hp = (p1 - p0) / 2;
      const hq = (q1 - q0) / 2;
      const [x, y, z] = plane === 'x' ? toWorld(at, cq, cp) : plane === 'z' ? toWorld(cp, cq, at) : toWorld(cp, at, cq);
      const [hx, hy, hz] = plane === 'x' ? [NET_THICK, hq, hp] : plane === 'z' ? [hp, hq, NET_THICK] : [hp, NET_THICK, hq];
      cols.push({ t: 'obb', kind: 'net', x, y, z, hx, hy, hz, yaw: s.yaw });
    }
  };

  if (s.kind === 'nets') {
    // Net tunnel on poles: closed sides and rear, a flap over the front with a gap underneath,
    // a hole in the roof (hard: a second roof layer with its own hole, offset)
    const hx = w / 2 + 1.1;
    const hz = l / 2 + 1.1;
    const H = h + 0.6;
    for (const px of [-hx, hx]) for (const pz of [-hz, 0, hz]) pole(px, pz, H);
    const holeAt = (sizeH) => {
      const cx = (rand() - 0.5) * (2 * hx - sizeH - 1.2);
      const cz = (rand() - 0.5) * (2 * hz - sizeH - 1.2);
      return [cx - sizeH / 2, cx + sizeH / 2, cz - sizeH / 2, cz + sizeH / 2];
    };
    const hole = holeAt(sz.hole);
    panel('y', H, [-hx, hx, -hz, hz], hole);
    if (s.difficulty === 'hard') {
      let hole2;
      for (let k = 0; k < 20; k++) {
        hole2 = holeAt(sz.hole);
        if (Math.abs(hole2[0] - hole[0]) > 1.3 || Math.abs(hole2[2] - hole[2]) > 1.3) break;
      }
      for (const px of [-hx, hx]) for (const pz of [-hz, hz]) pole(px, pz, H + 0.65);
      panel('y', H + 0.6, [-hx, hx, -hz, hz], hole2);
    }
    panel('x', -hx, [-hz, hz, -0.05, H]);
    panel('x', hx, [-hz, hz, -0.05, H]);
    panel('z', hz, [-hx, hx, -0.05, H]);
    panel('z', -hz, [-hx, hx, sz.gap, H]);
    return { parts, nets, cols, radius: Math.hypot(hx, hz) + 0.5 };
  }

  if (s.kind === 'barn') {
    // Plank shed with a door opening at the front, maybe a side window, maybe a collapsed roof patch
    const hx = w / 2 + 1;
    const hz = l / 2 + 1;
    const H = h + 1;
    const t = 0.25;
    const wall = rand() < 0.5 ? 0x6b5a45 : 0x7d6a52;
    const [dw0, dh] = sz.door;
    const dw = dw0 || 2 * hx - 0.8;
    const doorH = s.difficulty === 'easy' ? h + 0.6 : dh;
    const side = rand() < 0.5 ? -1 : 1;
    // side walls (one maybe with a window)
    for (const sx of [-1, 1]) {
      const win = sx === side && sz.window;
      const wz = win ? (rand() - 0.5) * (2 * hz - 3) : 0;
      const rects = cutHole([-hz, hz, -0.3, H], win ? [wz - sz.window[0] / 2, wz + sz.window[0] / 2, 1.4, 1.4 + sz.window[1]] : null);
      for (const [z0, z1, y0r, y1r] of rects) box(t, y1r - y0r, z1 - z0, sx * (hx - t / 2), (y0r + y1r) / 2, (z0 + z1) / 2, wall, 'building');
    }
    box(2 * hx - 2 * t, H + 0.3, t, 0, (H - 0.3) / 2, hz - t / 2, wall, 'building'); // rear
    for (const [x0, x1, y0r, y1r] of cutHole([-hx + t, hx - t, -0.3, H], [-dw / 2, dw / 2, -0.3, doorH])) {
      box(x1 - x0, y1r - y0r, t, (x0 + x1) / 2, (y0r + y1r) / 2, -hz + t / 2, wall, 'building'); // front around the door
    }
    // roof slab, a hole where it collapsed
    const rh = sz.roof;
    const rcx = (rand() - 0.5) * (2 * hx - rh - 1.5);
    const rcz = (rand() - 0.5) * (2 * hz - rh - 1.5);
    for (const [x0, x1, z0, z1] of cutHole([-hx - 0.2, hx + 0.2, -hz - 0.2, hz + 0.2], rh ? [rcx - rh / 2, rcx + rh / 2, rcz - rh / 2, rcz + rh / 2] : null)) {
      box(x1 - x0, 0.16, z1 - z0, (x0 + x1) / 2, H + 0.08, (z0 + z1) / 2, 0x55524c, 'building');
    }
    return { parts, nets, cols, radius: Math.hypot(hx, hz) + 0.5 };
  }

  // Log dugout: earth berms left, right and behind, a roof of logs with branches on top, open (or a
  // net flap with a low gap) at the front; hard: a log across the opening leaves only a slit
  const bx = w / 2 + 0.9;
  const hb = h + 0.25;
  const front = -l / 2 - 0.4;
  const rear = l / 2 + 1;
  const earth = 0x5a4a38;
  for (const sx of [-1, 1]) box(1.4, hb + 0.3, rear - front, sx * (bx + 0.7), (hb - 0.3) / 2, (front + rear) / 2, earth, 'cover');
  box(2 * bx + 2.8, hb + 0.3, 1.4, 0, (hb - 0.3) / 2, rear + 0.7, earth, 'cover');
  const r = 0.14;
  for (let z = front + r; z < rear + 1.3; z += r * 2.05) log(-bx - 1.2, hb + r, z, bx + 1.2, hb + r, z, r);
  // branches and leaves on the roof (visual)
  for (let k = 0; k < 26; k++) {
    const [x, y, z] = toWorld((rand() - 0.5) * (2 * bx + 2), hb + 0.35, front + rand() * (rear - front + 1.2));
    const geo = new THREE.IcosahedronGeometry(1, 0).scale(0.5 + rand() * 0.5, 0.25 + rand() * 0.15, 0.5 + rand() * 0.5);
    parts.push({ geo, color: rand() < 0.4 ? 0x5e5434 : 0x3e4a2a, pos: [x, y, z], rotY: rand() * 3 });
  }
  if (sz.flap) panel('z', front, [-bx, bx, sz.flap, hb]);
  if (sz.slitLog) log(-bx - 0.6, sz.slitLog, front - 0.15, bx + 0.6, sz.slitLog, front - 0.15, 0.18);
  return { parts, nets, cols, radius: Math.hypot(bx + 1.4, rear + 1.4) };
}
