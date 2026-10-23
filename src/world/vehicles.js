import * as THREE from 'three';
import { mergeParts } from './meshUtils.js';
import { createDriver } from './vehicleAI.js';
import { mulberry32 } from './random.js';
import { VEHICLE_MODELS } from './vehicleModels.js';

const DUST_INTERVAL = 0.12; // s between dust puffs behind a fast vehicle
const DUST_SPEED = 3; // m/s

function buildRoute(points) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    const [x0, z0] = points[i - 1];
    const [x1, z1] = points[i];
    lengths.push(lengths[i - 1] + Math.hypot(x1 - x0, z1 - z0));
  }
  return { points, lengths, total: lengths[lengths.length - 1] };
}

// Position + heading at distance s along a route
function sampleRoute(route, s, out) {
  const { points, lengths } = route;
  let i = 1;
  while (i < lengths.length - 1 && lengths[i] < s) i++;
  const t = (s - lengths[i - 1]) / (lengths[i] - lengths[i - 1]);
  const [x0, z0] = points[i - 1];
  const [x1, z1] = points[i];
  out.x = x0 + (x1 - x0) * t;
  out.z = z0 + (z1 - z0) * t;
  out.yaw = Math.atan2(-(x1 - x0), -(z1 - z0)); // nose (-Z) along the segment
  return out;
}

// Hit zones in the vehicle's local frame (nose = -Z), from relative position on the
// collision box: u = lx / half.x, v = ly / half.y, w = lz / half.z, each -1..1.
// Game-level model: rear/top are weak, front is strong, running gear immobilizes.
const ZONES = {
  tank: (u, v, w) => {
    if (w > 0.45) return ['Engine deck', 'destroyed'];
    if (v > 0.2) return ['Turret roof', 'destroyed'];
    if (Math.abs(u) > 0.55 && v < 0) return ['Tracks', 'immobilized'];
    if (w < -0.45) return ['Front armor', 'damaged'];
    return ['Side armor', 'damaged'];
  },
  ifv: (u, v, w) => {
    if (w < -0.35) return ['Engine (front)', 'destroyed'];
    if (v > 0.35) return ['Roof', 'destroyed'];
    if (Math.abs(u) > 0.6 && v < -0.1) return ['Tracks', 'immobilized'];
    if (w > 0.75) return ['Rear doors', 'destroyed'];
    return ['Side', 'destroyed'];
  },
  apc: (u, v, w) => {
    if (w > 0.45) return ['Engine', 'destroyed'];
    if (v > 0.3) return ['Roof', 'destroyed'];
    if (Math.abs(u) > 0.7 && v < -0.2) return ['Wheels', 'immobilized'];
    if (w < -0.6) return ['Front plate', 'damaged'];
    return ['Side', 'destroyed'];
  },
  truck: (u, v, w) => (w < -0.4 ? ['Cab', 'destroyed'] : ['Cargo', 'destroyed']),
  car: () => ['Body', 'destroyed'],
  ammo: () => ['Crates', 'destroyed'],
};
const LABELS = { tank: 'Tank', ifv: 'IFV', apc: 'APC', truck: 'Truck', car: 'Car', ammo: 'Ammo stack' };
const ARMORED = { tank: true, ifv: true, apc: true, truck: false, car: false, ammo: false };
const EFFECT_RANK = { none: 0, damaged: 1, immobilized: 2, destroyed: 3 };

// Mud and dust on the lower body, mottled a little higher up
const MUD = [0.36, 0.31, 0.24];
function applyGrime(geo, seed) {
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  const rand = mulberry32(seed);
  for (let i = 0; i < pos.count; i += 3) {
    // per triangle, so flat-shaded faces stay uniform
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const k = Math.min(1, Math.max(0, (1.2 - y) / 1.2)) * 0.6 + rand() * 0.12;
    for (let j = i; j < i + 3; j++) {
      col.setXYZ(j, col.getX(j) + (MUD[0] - col.getX(j)) * k, col.getY(j) + (MUD[1] - col.getY(j)) * k, col.getZ(j) + (MUD[2] - col.getZ(j)) * k);
    }
  }
  col.needsUpdate = true;
  return geo;
}

// Burnt-out look: soot black, rust in patches, grey ash, a trace of the old paint
const CHAR = [0.13, 0.12, 0.11];
const RUST = [0.46, 0.25, 0.12];
const ASH = [0.4, 0.38, 0.35];
function applyRust(geo, seed) {
  const pos = geo.attributes.position;
  const col = geo.attributes.color;
  const rand = mulberry32(seed);
  // patches ~0.5-1.5 m, plus per-face variation, so soot, rust and ash read as separate blotches
  const patch = (x, y, z) => {
    const v = Math.sin(x * 4.3 + seed) * Math.sin(y * 5.1 + 1.7) * Math.sin(z * 3.7 - seed * 0.3)
      + 0.5 * Math.sin(x * 9.1 - z * 7.3 + y * 3.1);
    return Math.min(1, Math.max(0, v * 0.45 + 0.5));
  };
  for (let i = 0; i < pos.count; i += 3) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const pv = patch(x, y, z);
    const rust = pv > 0.55 ? (pv - 0.55) / 0.45 * (0.8 + rand() * 0.4) : 0; // sharp-edged rust blotches on soot
    const ash = y > 1.2 && rand() < 0.2 ? 0.55 : 0;
    for (let j = i; j < i + 3; j++) {
      const old = [col.getX(j), col.getY(j), col.getZ(j)];
      const c = [0, 1, 2].map((k) => {
        let v = CHAR[k] + (RUST[k] - CHAR[k]) * Math.min(1, rust);
        v += (ASH[k] - v) * ash;
        return v * 0.88 + old[k] * 0.12;
      });
      col.setXYZ(j, c[0], c[1], c[2]);
    }
  }
  col.needsUpdate = true;
  return geo;
}

// What burnt wrecks lose: chance per part group (wheels are rolled per wheel)
const WRECK_LOSS = {
  tank: { turret: 0.7, skirt: 0.6, drums: 0.6, stowage: 0.7, trackL: 0.3, trackR: 0.3, wheel: 0.2 },
  ifv: { turret: 0.6, doors: 0.6, trackL: 0.35, trackR: 0.35, wheel: 0.2 },
  apc: { turret: 0.5, vane: 0.6, wheel: 0.35 },
  truck: { canopy: 0.85, glass: 0.95, spare: 0.6, wheel: 0.4 },
  car: { glass: 0.95, spare: 0.6, wheel: 0.45 },
};

// Paint variants (multiplied with the vertex colours): olive, dark green, sand, grey, brown
const CAMO_TINTS = [[1, 1, 1], [0.85, 0.92, 0.82], [1.12, 1.02, 0.82], [0.95, 0.96, 0.97], [1.05, 0.93, 0.8]];
const NET_COLORS = [[74, 86, 46], [92, 98, 54], [104, 94, 62], [62, 72, 40], [118, 110, 72], [84, 70, 48]];
const CANOPY_SHADE = 0.5; // brightness of a vehicle under tree crowns
const NET_SHADE = 0.7;
const NET_TILE = 1.6; // m of net per texture repeat

// Camo net texture: diagonal cord grid with leaf-shaped garnish; transparent between (alphaTest)
function createNetTexture() {
  const N = 256;
  const rand = mulberry32(5);
  const data = new Uint8Array(N * N * 4);
  const set = (x, y, [r, g, b]) => {
    const i = (((y + N) % N) * N + ((x + N) % N)) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if ((x + y) % 18 < 2 || (x - y + N * 4) % 18 < 2) set(x, y, [40, 42, 30]); // cords
    }
  }
  for (let k = 0; k < 1300; k++) {
    const cx = rand() * N;
    const cy = rand() * N;
    const rx = 3 + rand() * 6;
    const ry = 2 + rand() * 4;
    const a = rand() * Math.PI;
    const col = NET_COLORS[Math.floor(rand() * NET_COLORS.length)];
    const shade = 0.8 + rand() * 0.35;
    const c = [col[0] * shade, col[1] * shade, col[2] * shade];
    for (let dy = -rx; dy <= rx; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const u = (dx * Math.cos(a) + dy * Math.sin(a)) / rx;
        const v = (-dx * Math.sin(a) + dy * Math.cos(a)) / ry;
        if (u * u + v * v <= 1) set(Math.floor(cx + dx), Math.floor(cy + dy), c);
      }
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Highest visible part under a local point (from the model's part boxes), sloping off its edges
function supportHeight(parts, lx, lz) {
  let best = 0;
  for (const p of parts) {
    const ex = Math.max(Math.abs(lx - p.c[0]) - p.h[0], 0);
    const ez = Math.max(Math.abs(lz - p.c[2]) - p.h[2], 0);
    const top = p.c[1] + p.h[1] + 0.12;
    best = Math.max(best, top - Math.hypot(ex, ez) * 1.15);
  }
  return best;
}

// Camo net draped over the vehicle's actual parts, ragged at the edges, textured with garnish
function buildNet(half, parts, rand) {
  const N = 16;
  const ex = half.x + 1.3;
  const ez = half.z + 1.3;
  const positions = [];
  const uvs = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const edge = i === 0 || j === 0 || i === N || j === N;
      const lx = ((i / N) * 2 - 1) * ex * (edge ? 0.85 + rand() * 0.3 : 1);
      const lz = ((j / N) * 2 - 1) * ez * (edge ? 0.85 + rand() * 0.3 : 1);
      const y = edge ? -0.05 : Math.max(0.05, supportHeight(parts, lx, lz) - rand() * 0.18);
      positions.push(lx, y, lz);
      uvs.push(lx / NET_TILE, lz / NET_TILE);
    }
  }
  const idx = [];
  const at = (i, j) => j * (N + 1) + i;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) idx.push(at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// Pile of cut branches on the roof and hanging over the sides: leaf clumps (fresh and dried) + sticks
function buildBranches(half, parts, rand) {
  const pieces = [];
  const tops = parts.filter((p) => !p.zone); // not on thin gun barrels
  const area = tops.map((p) => p.h[0] * p.h[2]);
  const total = area.reduce((a, b) => a + b, 0);
  const pickPart = () => {
    let t = rand() * total;
    for (let k = 0; k < tops.length; k++) if ((t -= area[k]) <= 0) return tops[k];
    return tops[0];
  };
  const count = Math.round(18 + total * 2.2);
  for (let k = 0; k < count; k++) {
    const p = pickPart();
    const side = rand() < 0.3; // hanging over a side
    const lx = side ? Math.sign(rand() - 0.5) * (p.h[0] + 0.05) : p.c[0] + (rand() - 0.5) * 2 * p.h[0];
    const lz = p.c[2] + (rand() - 0.5) * 2 * p.h[2];
    const ly = p.c[1] + p.h[1] + (side ? -0.35 - rand() * 0.4 : 0.05 + rand() * 0.15);
    const dry = rand() < 0.4;
    const color = dry ? new THREE.Color(0.36 + rand() * 0.06, 0.3 + rand() * 0.05, 0.2).getHex() : new THREE.Color().setHSL(0.21 + rand() * 0.06, 0.3, 0.15 + rand() * 0.06).getHex();
    const geo = new THREE.IcosahedronGeometry(1, 0).scale(0.45 + rand() * 0.45, side ? 0.45 + rand() * 0.3 : 0.2 + rand() * 0.2, 0.45 + rand() * 0.45);
    pieces.push({ geo, color, pos: [lx, ly, lz], rotY: rand() * Math.PI });
  }
  for (let k = 0; k < Math.round(count / 3); k++) {
    const p = pickPart();
    const len = 1.2 + rand() * 1.6;
    pieces.push({
      geo: new THREE.CylinderGeometry(0.025, 0.04, len, 4), color: 0x4a3e30,
      pos: [p.c[0] + (rand() - 0.5) * 2 * p.h[0], p.c[1] + p.h[1] + 0.12, p.c[2] + (rand() - 0.5) * 2 * p.h[2]],
      rotZ: Math.PI / 2 + (rand() - 0.5) * 0.4, rotY: rand() * Math.PI,
    });
  }
  return mergeParts(pieces);
}

// All enemy vehicles + ammo from the layout, plus burnt-out wrecks (decor + obstacles).
export function createVehicles(group, layout, colliders, effects) {
  const { heightAt } = layout;
  const rand = mulberry32(layout.seed + 41);
  const charred = new THREE.MeshLambertMaterial({ vertexColors: true, color: 0x55504a, flatShading: true });
  const rusted = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const scorchMat = new THREE.MeshLambertMaterial({ color: 0x2a2621, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const scorchGeo = new THREE.CircleGeometry(1, 12).rotateX(-Math.PI / 2);
  const wreckGeos = [];
  let dust = true;
  const netMaterial = new THREE.MeshLambertMaterial({ map: createNetTexture(), alphaTest: 0.5, side: THREE.DoubleSide });
  const branchMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const geometries = {};
  const vehicles = [];

  // geo: whole vehicle; hull/turret: separate (wrecks lose the turret)
  const geometryOf = (type) => {
    if (!geometries[type]) {
      const def = VEHICLE_MODELS[type]();
      geometries[type] = {
        geo: applyGrime(mergeParts(def.turret ? [...def.parts, ...def.turret] : def.parts), type.length),
        hull: def.turret ? applyGrime(mergeParts(def.parts), 7) : null,
        turret: def.turret ? mergeParts(def.turret) : null,
        size: def.size,
        parts: def.colliders,
      };
    }
    return geometries[type];
  };
  const shadowed = (mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };

  const add = (type, extra) => {
    const { geo, size, parts } = geometryOf(type);
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const mesh = shadowed(new THREE.Mesh(geo, material));
    mesh.rotation.order = 'YXZ';
    group.add(mesh);
    const v = {
      type,
      label: LABELS[type],
      armored: ARMORED[type],
      enemy: true,
      mesh,
      material,
      tint: CAMO_TINTS[Math.floor(rand() * CAMO_TINTS.length)],
      shade: 1,
      half: { x: size[0] / 2, y: size[1] / 2, z: size[2] / 2 },
      length: size[2],
      parts, // collision boxes matching the visible parts
      dustTimer: 0,
      state: 'intact', // 'intact' | 'damaged' | 'immobilized' | 'destroyed'
      ...extra,
    };
    vehicles.push(v);
    return v;
  };

  // Mesh from the vehicle's (x, z, yaw), pitched to the terrain
  const place = (v) => {
    const { x, z, yaw } = v;
    const fx = -Math.sin(yaw) * v.length * 0.4;
    const fz = -Math.cos(yaw) * v.length * 0.4;
    const front = heightAt(x + fx, z + fz);
    const back = heightAt(x - fx, z - fz);
    v.mesh.position.set(x, (front + back) / 2, z);
    v.mesh.rotation.set(Math.atan2(front - back, v.length * 0.8), yaw, 0);
    v.cos = Math.cos(yaw);
    v.sin = Math.sin(yaw);
  };

  // Darken vehicles under tree crowns (stand-in for real shadows)
  const probe = { x: 0, y: 0, z: 0 };
  const underCanopy = (v) => {
    const base = v.mesh.position.y + v.half.y * 2;
    for (const dy of [2, 4, 7, 10]) {
      probe.x = v.x;
      probe.y = base + dy;
      probe.z = v.z;
      const hit = colliders.hits(probe, 1.2);
      if (hit && hit.kind === 'tree') return true;
    }
    return false;
  };
  const applyColor = (v) => {
    if (v.state === 'destroyed') return;
    const k = v.shade * (v.netMesh && Math.hypot(v.x - v.home.x, v.z - v.home.z) < 2 ? NET_SHADE : 1);
    v.material.color.setRGB(v.tint[0] * k, v.tint[1] * k, v.tint[2] * k);
  };

  for (const p of layout.parked) {
    const v = add(p.type, { moving: false, home: p });
    if (p.net) {
      v.netMesh = shadowed(new THREE.Mesh(buildNet(v.half, v.parts, rand), netMaterial));
      v.netMesh.position.set(p.x, heightAt(p.x, p.z), p.z);
      v.netMesh.rotation.y = p.yaw;
      group.add(v.netMesh);
    } else if (p.branches) {
      // rides on the vehicle (child mesh), burns with it
      v.branchMesh = shadowed(new THREE.Mesh(buildBranches(v.half, v.parts, rand), branchMaterial));
      v.mesh.add(v.branchMesh);
    }
  }
  const routes = Object.fromEntries(Object.entries(layout.routes).map(([k, pts]) => [k, buildRoute(pts)]));
  for (const cfg of layout.moving) {
    add(cfg.type, { moving: true, home: cfg, route: routes[cfg.route], patrolSpeed: cfg.speed });
  }
  const driverCtx = { heightAt, colliders, sampleRoute, coverPoints: layout.coverPoints, half: layout.half };
  for (const v of vehicles) if (v.type !== 'ammo') v.driver = createDriver(v, driverCtx);

  // Burnt-out wrecks: scenery that looks like a target but isn't. Rusted, often missing parts
  // (turret, canvas, wheels, tracks...). Colliders come only from the parts that are still there.
  for (const w of layout.wrecks) {
    const def = VEHICLE_MODELS[w.type]();
    const loss = WRECK_LOSS[w.type] ?? {};
    const lost = new Set(Object.keys(loss).filter((g) => g !== 'wheel' && rand() < loss[g]));
    const lostWheels = new Set();
    for (const p of def.parts) if (p.group === 'wheel' && !lostWheels.has(p.id) && rand() < (loss.wheel ?? 0)) lostWheels.add(p.id);
    const keep = (p) => !lost.has(p.group) && !(p.group === 'wheel' && lostWheels.has(p.id));
    const blown = def.turret && lost.has('turret');
    const bodyParts = [...def.parts, ...(def.turret && !blown ? def.turret : [])].filter(keep);
    const geo = applyRust(mergeParts(bodyParts), Math.floor(w.x * 13 + w.z));
    wreckGeos.push(geo);
    const mesh = shadowed(new THREE.Mesh(geo, rusted));
    const y = heightAt(w.x, w.z) - (lostWheels.size ? 0.4 : 0.2);
    const tiltX = (rand() - 0.5) * 0.12;
    const tiltZ = (rand() - 0.5) * (lostWheels.size ? 0.3 : 0.12);
    mesh.position.set(w.x, y, w.z);
    mesh.rotation.set(tiltX, w.yaw, tiltZ, 'YXZ');
    group.add(mesh);
    const c = Math.cos(w.yaw);
    const sn = Math.sin(w.yaw);
    for (const col of def.colliders) {
      if (lost.has(col.group) || (col.group === 'turret' && blown)) continue;
      const [lx, ly, lz] = col.c;
      colliders.addOBB('wreck', w.x + lx * c + lz * sn, y + ly, w.z - lx * sn + lz * c, col.h[0], col.h[1], col.h[2], w.yaw);
    }
    // scorched ground under it
    const mark = new THREE.Mesh(scorchGeo, scorchMat);
    mark.position.set(w.x, heightAt(w.x, w.z) + 0.05, w.z);
    mark.scale.setScalar(3.5 + rand() * 2);
    group.add(mark);
    if (blown) {
      const a = rand() * Math.PI * 2;
      const d = 3 + rand() * 4;
      const tx = w.x + Math.cos(a) * d;
      const tz = w.z + Math.sin(a) * d;
      const tgeo = applyRust(mergeParts(def.turret), Math.floor(tx * 7));
      wreckGeos.push(tgeo);
      tgeo.computeBoundingBox();
      const { min, max } = tgeo.boundingBox;
      const flipped = rand() < 0.4;
      const t = shadowed(new THREE.Mesh(tgeo, rusted));
      const ty = heightAt(tx, tz) + (flipped ? max.y : -min.y) - 0.15;
      const tyaw = rand() * Math.PI * 2;
      t.position.set(tx, ty, tz);
      t.rotation.set(flipped ? Math.PI : (rand() - 0.5) * 0.3, tyaw, (rand() - 0.5) * 0.3, 'YXZ');
      group.add(t);
      // the model's own turret + gun boxes, moved with the fallen turret
      t.updateMatrix();
      for (const col of def.colliders) {
        if (col.group !== 'turret') continue;
        const p = new THREE.Vector3(...col.c).applyMatrix4(t.matrix);
        colliders.addOBB('wreck', p.x, p.y, p.z, col.h[0], col.h[1], col.h[2], tyaw);
      }
    }
  }

  let shadeTimer = 0;
  // threat: the drone ({ position }) or null; reactions: enemy reaction enabled; alertness: detection multiplier
  function update(dt, threat = null, reactions = true, alertness = 1) {
    shadeTimer -= dt;
    const reshade = shadeTimer <= 0;
    if (reshade) shadeTimer = 0.25;
    for (const v of vehicles) {
      if (v.driver) v.driver.update(dt, threat, reactions, alertness);
      if (v.driver) place(v);
      // Dust kicked up behind fast vehicles
      if (dust && effects && Math.abs(v.speed ?? 0) > DUST_SPEED) {
        v.dustTimer -= dt;
        if (v.dustTimer <= 0) {
          v.dustTimer = DUST_INTERVAL * (8 / Math.max(8, Math.abs(v.speed)));
          const back = Math.sign(v.speed) * v.half.z;
          const x = v.x + Math.sin(v.yaw) * back;
          const z = v.z + Math.cos(v.yaw) * back;
          effects.dust(x, heightAt(x, z) + 0.4, z, Math.min(1, Math.abs(v.speed) / 15));
        }
      }
      if (reshade && (v.moving || v.speed)) {
        v.shade = underCanopy(v) ? CANOPY_SHADE : 1;
        applyColor(v);
      }
    }
  }

  // Back to the initial layout, all vehicles intact and unaware.
  function reset() {
    for (const v of vehicles) {
      v.state = 'intact';
      v.mesh.material = v.material;
      if (v.branchMesh) v.branchMesh.material = branchMaterial;
      if (v.driver) v.driver.reset(v.home);
      else {
        v.x = v.home.x;
        v.z = v.home.z;
        v.yaw = v.home.yaw;
        v.speed = 0;
      }
      place(v);
      v.shade = underCanopy(v) ? CANOPY_SHADE : 1;
      applyColor(v);
    }
  }
  reset();

  // Point in the vehicle's local box frame (yaw only; terrain pitch is small)
  const toLocal = (v, p, out) => {
    const c = v.mesh.position;
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    out.x = dx * v.cos - dz * v.sin;
    out.y = p.y - (c.y + v.half.y);
    out.z = dx * v.sin + dz * v.cos;
    return out;
  };
  const local = { x: 0, y: 0, z: 0 };

  // Distance from a local point to one collision part (0 inside)
  const partDistance = (part, lx, lyGround, lz) => {
    const ex = Math.max(Math.abs(lx - part.c[0]) - part.h[0], 0);
    const ey = Math.max(Math.abs(lyGround - part.c[1]) - part.h[1], 0);
    const ez = Math.max(Math.abs(lz - part.c[2]) - part.h[2], 0);
    return Math.sqrt(ex * ex + ey * ey + ez * ez);
  };

  // Distance from p to the nearest visible part of the vehicle (0 inside)
  let nearestPart = null;
  function distanceTo(v, p) {
    toLocal(v, p, local);
    const ly = local.y + v.half.y; // height above the vehicle's ground
    let best = Infinity;
    for (const part of v.parts) {
      const d = partDistance(part, local.x, ly, local.z);
      if (d < best) {
        best = d;
        nearestPart = part;
      }
    }
    return best;
  }

  // Returns { kind: 'vehicle', vehicle, zone, effect } or null
  function hits(p, r) {
    for (const v of vehicles) {
      const c = v.mesh.position;
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      if (dx * dx + dz * dz > 144) continue;
      if (distanceTo(v, p) < r) {
        if (nearestPart.zone) return { kind: 'vehicle', vehicle: v, zone: nearestPart.zone[0], effect: nearestPart.zone[1] };
        const clamp = (t) => Math.max(-1, Math.min(1, t));
        const [zone, effect] = ZONES[v.type](
          clamp(local.x / v.half.x), clamp(local.y / v.half.y), clamp(local.z / v.half.z)
        );
        return { kind: 'vehicle', vehicle: v, zone, effect };
      }
    }
    return null;
  }

  // Applies damage; a vehicle never gets "less" damaged.
  function damage(v, effect) {
    if (EFFECT_RANK[effect] <= EFFECT_RANK[v.state === 'intact' ? 'none' : v.state]) return;
    v.state = effect;
    if (effect === 'destroyed') {
      v.mesh.material = charred;
      if (v.branchMesh) v.branchMesh.material = charred;
    }
  }

  function dispose() {
    for (const v of vehicles) {
      v.material.dispose();
      if (v.netMesh) v.netMesh.geometry.dispose();
      if (v.branchMesh) v.branchMesh.geometry.dispose();
    }
    for (const g of Object.values(geometries)) for (const geo of [g.geo, g.hull, g.turret]) geo?.dispose();
    charred.dispose();
    netMaterial.map.dispose();
    netMaterial.dispose();
    branchMaterial.dispose();
    rusted.dispose();
    scorchMat.dispose();
    scorchGeo.dispose();
    for (const g of wreckGeos) g.dispose();
  }

  return {
    list: vehicles, update, reset, hits, distanceTo, damage, dispose,
    setDust(on) {
      dust = on;
    },
  };
}
