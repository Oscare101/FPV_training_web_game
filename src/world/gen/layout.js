import { mulberry32 } from '../random.js';
import { createNoise } from './noise.js';

// Procedural frontline map. Pure data (no Three.js): terrain heights, ground colours,
// vegetation/structure lists, enemy positions, vehicle routes. North (-Z) = enemy side,
// south (+Z) = our side with the launch point.
//
// Pieces: a rotated grid of fields with tree lines on their borders, noise-shaped forest
// patches, a main road through a village, field tracks, a "grey zone" of craters and
// shredded trees between the lines, and 2-4 enemy positions with parked vehicles/ammo.

export const MAP_DEFAULTS = {
  size: 2000, // m
  terrainCell: 2, // m, finest terrain cell (near the camera); the physics ground uses this grid
  launchMin: 500, // m to the enemy positions
  launchMax: 900,
  enemySites: 3,
  vehiclesPerSite: 3,
  movingVehicles: 2,
  vegetation: 1, // density multiplier
  treeLines: 0.75, // share of field borders with a tree line
  forest: 0.5, // forest coverage, 0..1
  craters: 1,
  camoNets: 0.5, // chance a parked vehicle is under a net
  branchCamo: 0.45, // chance a vehicle without a net is covered with cut branches
  ruins: 0.5, // share of ruined village houses
  wrecks: 4, // burnt-out vehicles (not targets)
  hilliness: 1, // small hills, lowlands and general relief
  ravines: 2, // winding gullies ("balka")
  revetments: 0.6, // chance a parked vehicle is dug in behind an earth berm
  launchSpot: 'random', // 'random' | one of LAUNCH_SPOTS
};

export const LAUNCH_SPOTS = ['field', 'treeline', 'forest', 'ravine', 'ruins', 'track'];

// Muted, slightly dusty colours as they come out of an FPV camera
const CROPS = {
  stubble: [0.56, 0.53, 0.38],
  wheat: [0.53, 0.5, 0.35],
  plowed: [0.37, 0.31, 0.25],
  green: [0.33, 0.4, 0.23],
  sunflower: [0.28, 0.33, 0.2],
  fallow: [0.43, 0.44, 0.3],
};
const CROP_NAMES = Object.keys(CROPS);
// Tree species mixes by place (see vegetation.js SPECIES), and their height ranges
const TREE_MIX = {
  treeline: { acacia: 0.28, poplar: 0.2, oak: 0.2, birch: 0.14, spruce: 0.08, fruit: 0.04, willow: 0.06 },
  forestPine: { pine: 0.45, spruce: 0.4, birch: 0.15 },
  forestLeaf: { oak: 0.4, birch: 0.25, acacia: 0.2, spruce: 0.15 },
  ravine: { willow: 0.5, acacia: 0.3, oak: 0.2 },
  village: { fruit: 0.5, poplar: 0.2, oak: 0.2, birch: 0.1 },
  lone: { oak: 0.35, acacia: 0.3, poplar: 0.15, fruit: 0.1, birch: 0.1 },
  cover: { oak: 0.6, acacia: 0.25, willow: 0.15 },
};
const TREE_HEIGHT = {
  spruce: [12, 22], pine: [14, 22], oak: [10, 16], birch: [10, 16], poplar: [14, 22], acacia: [8, 13], willow: [8, 12], fruit: [4, 7], dead: [4, 11],
};
// Grass per crop: [density 0..1, height m]
const CROP_GRASS = {
  stubble: [0.95, 0.16], wheat: [1, 0.85], plowed: [0.08, 0.12], green: [0.95, 0.45], sunflower: [0.6, 0.6], fallow: [0.9, 0.55],
};
const COLORS = {
  road: [0.47, 0.42, 0.34],
  forestFloor: [0.23, 0.25, 0.18],
  wet: [0.26, 0.33, 0.2], // lowland meadow / ravine floor
  earth: [0.4, 0.33, 0.25], // freshly dug berms
  treeline: [0.29, 0.33, 0.21],
  yard: [0.41, 0.39, 0.31],
  scorched: [0.24, 0.22, 0.18],
};

const VEHICLE_WEIGHTS = { tank: 0.2, ifv: 0.2, apc: 0.15, truck: 0.3, car: 0.15 };
const HALF_WIDTH = { tank: 1.75, ifv: 1.45, apc: 1.48, truck: 1.25, car: 0.95, ammo: 1.45 }; // for placing trees beside them
const HALF_LENGTH = { tank: 3.5, ifv: 3.45, apc: 3.75, truck: 3.85, car: 2.15, ammo: 1.1 };

// Byte raster at a fixed cell size, for O(1) "is there a road/tree line here" lookups.
function createRaster(size, cell) {
  const n = Math.ceil(size / cell);
  const data = new Uint8Array(n * n);
  const half = size / 2;
  const idx = (x, z) => {
    const ix = Math.floor((x + half) / cell);
    const iz = Math.floor((z + half) / cell);
    return ix < 0 || iz < 0 || ix >= n || iz >= n ? -1 : iz * n + ix;
  };
  return {
    get(x, z) {
      const i = idx(x, z);
      return i < 0 ? 0 : data[i];
    },
    stamp(x, z, r, value) {
      for (let dz = -r; dz <= r; dz += cell) {
        for (let dx = -r; dx <= r; dx += cell) {
          if (dx * dx + dz * dz > r * r) continue;
          const i = idx(x + dx, z + dz);
          if (i >= 0 && data[i] < value) data[i] = value;
        }
      }
    },
    stampLine(x1, z1, x2, z2, r, value) {
      const len = Math.hypot(x2 - x1, z2 - z1);
      const steps = Math.max(1, Math.ceil(len / (cell * 0.75)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        this.stamp(x1 + (x2 - x1) * t, z1 + (z2 - z1) * t, r, value);
      }
    },
  };
}

// Float raster keeping the max value stamped into each cell
function createFloatRaster(size, cell) {
  const n = Math.ceil(size / cell);
  const data = new Float32Array(n * n);
  const half = size / 2;
  const idx = (x, z) => {
    const ix = Math.floor((x + half) / cell);
    const iz = Math.floor((z + half) / cell);
    return ix < 0 || iz < 0 || ix >= n || iz >= n ? -1 : iz * n + ix;
  };
  return {
    get(x, z) {
      const i = idx(x, z);
      return i < 0 ? 0 : data[i];
    },
    max(x, z, value) {
      const i = idx(x, z);
      if (i >= 0 && data[i] < value) data[i] = value;
    },
  };
}

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function generateLayout(seed, options = {}) {
  const o = { ...MAP_DEFAULTS, ...options };
  const rand = mulberry32(seed);
  const { fbm } = createNoise(seed);
  const r = (a, b) => a + rand() * (b - a);
  const chance = (p) => rand() < p;
  const pickWeighted = (w) => {
    let t = rand() * Object.values(w).reduce((a, b) => a + b, 0);
    for (const [k, v] of Object.entries(w)) if ((t -= v) <= 0) return k;
    return Object.keys(w)[0];
  };

  const size = o.size;
  const half = size / 2;
  const inside = (x, z, margin = 30) => Math.abs(x) < half - margin && Math.abs(z) < half - margin;

  // ---------- launch + front geometry ----------
  // launchRef fixes the front geometry; the actual launch spot is picked nearby later
  const launchRef = { x: r(-0.3, 0.3) * half, z: half - r(150, 250) };
  const launch = { x: launchRef.x, z: launchRef.z, yaw: 0, kind: 'field', clear: 6 };
  const enemyDist = r(o.launchMin, o.launchMax);
  const enemyCenter = { x: launchRef.x + r(-0.25, 0.25) * enemyDist, z: launchRef.z - enemyDist };
  // Grey zone: 0 at launch, rising to 1 toward the enemy line, fading behind enemy positions.
  // Drives craters, scorched ground and shredded trees.
  const grey = (x, z) => {
    const t = (launchRef.z - z) / enemyDist;
    return smoothstep(0.15, 0.6, t) * (1 - smoothstep(1.15, 1.5, t));
  };

  // ---------- field grid ----------
  const angle = r(-0.35, 0.35);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const toGrid = (x, z) => [x * ca + z * sa, -x * sa + z * ca];
  const fromGrid = (u, w) => [u * ca - w * sa, u * sa + w * ca];
  const lines = (min, max, step) => {
    const out = [];
    for (let v = min; v < max; v += r(step[0], step[1])) out.push(v);
    return out;
  };
  const span = half * 1.5;
  const uLines = lines(-span, span, [140, 320]);
  const wLines = lines(-span, span, [180, 420]);
  const bisect = (arr, v) => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const cropOf = new Map();
  const fieldCrop = (x, z) => {
    const [u, w] = toGrid(x, z);
    const id = bisect(uLines, u) * 1000 + bisect(wLines, w);
    if (!cropOf.has(id)) cropOf.set(id, CROP_NAMES[Math.floor(mulberry32(seed + id)() * CROP_NAMES.length)]);
    return cropOf.get(id);
  };

  // ---------- forest ----------
  const forestNoise = (x, z) => fbm(x / 380 + 50, z / 380 - 30, 4);
  const forestThreshold = 0.35 - o.forest * 0.45;
  const isForest = (x, z) => forestNoise(x, z) > forestThreshold;

  // ---------- rasters ----------
  const RC = 4;
  const roadMask = createRaster(size, RC); // 1 track, 2 road
  const treeMask = createRaster(size, RC); // 1 tree line strip
  const yardMask = createRaster(size, RC); // village yards
  const earthMask = createRaster(size, RC); // dug earth (berms, pits)
  const wet = createFloatRaster(size, RC); // 0..1 lowland / ravine wetness (colour, vegetation)

  // ---------- roads ----------
  const routes = {};
  const polyline = (pts) => pts.filter(([x, z]) => inside(x, z, 10));
  // Main road: east-west, wiggly, near the enemy line
  const roadZ0 = enemyCenter.z + r(-60, 120);
  const roadPhase = r(0, 6);
  const mainRoad = polyline(Array.from({ length: Math.ceil(size / 20) + 1 }, (_, i) => {
    const x = -half + i * 20;
    return [x, roadZ0 + 18 * Math.sin(x / 140 + roadPhase) + 0.06 * x * Math.sin(roadPhase)];
  }));
  routes.main = mainRoad;
  // Cross road: north-south through our side to the main road
  const crossX0 = enemyCenter.x + r(-250, 250);
  const crossRoad = polyline(Array.from({ length: Math.ceil(size / 20) + 1 }, (_, i) => {
    const z = -half + i * 20;
    return [crossX0 + 14 * Math.sin(z / 120 + roadPhase), z];
  }));
  routes.cross = crossRoad;
  for (const road of [mainRoad, crossRoad]) {
    for (let i = 1; i < road.length; i++) roadMask.stampLine(...road[i - 1], ...road[i], 3.5, 2);
  }

  // ---------- tree lines along field borders ----------
  const treeLines = []; // { x1, z1, x2, z2 }
  const addBorder = (u1, w1, u2, w2) => {
    if (!chance(o.treeLines)) return;
    // split into pieces with gaps
    let t = 0;
    while (t < 1) {
      const len = Math.hypot(u2 - u1, w2 - w1);
      const piece = r(80, 260) / len;
      const t2 = Math.min(1, t + piece);
      const [x1, z1] = fromGrid(u1 + (u2 - u1) * t, w1 + (w2 - w1) * t);
      const [x2, z2] = fromGrid(u1 + (u2 - u1) * t2, w1 + (w2 - w1) * t2);
      if (inside(x1, z1, 20) || inside(x2, z2, 20)) treeLines.push({ x1, z1, x2, z2 });
      t = t2 + r(15, 50) / len;
    }
  };
  for (let i = 0; i < uLines.length; i++) {
    for (let j = 0; j < wLines.length - 1; j++) addBorder(uLines[i], wLines[j], uLines[i], wLines[j + 1]);
  }
  for (let j = 0; j < wLines.length; j++) {
    for (let i = 0; i < uLines.length - 1; i++) addBorder(uLines[i], wLines[j], uLines[i + 1], wLines[j]);
  }
  for (const t of treeLines) treeMask.stampLine(t.x1, t.z1, t.x2, t.z2, 7, 1);

  // Field tracks run beside some tree lines; they become vehicle routes too
  const tracks = treeLines.filter((t) => Math.hypot(t.x2 - t.x1, t.z2 - t.z1) > 150 && chance(0.25)).slice(0, 6);
  tracks.forEach((t, k) => {
    const len = Math.hypot(t.x2 - t.x1, t.z2 - t.z1);
    const nx = -(t.z2 - t.z1) / len;
    const nz = (t.x2 - t.x1) / len;
    const pts = [];
    for (let s = 0; s <= len; s += 20) {
      const f = s / len;
      pts.push([t.x1 + (t.x2 - t.x1) * f + nx * 9, t.z1 + (t.z2 - t.z1) * f + nz * 9]);
    }
    const route = polyline(pts);
    if (route.length > 3) {
      routes[`track${k}`] = route;
      for (let i = 1; i < route.length; i++) roadMask.stampLine(...route[i - 1], ...route[i], 2, 1);
    }
  });

  // ---------- village on the main road ----------
  const houses = []; // { kind: 'house' | 'barn' | 'garage' | 'shed', x, z, w, d, h, yaw, ruined, back: [x, z] }
  const villageS = Math.floor(mainRoad.length * r(0.3, 0.7));
  const villageCenter = { x: mainRoad[villageS][0], z: mainRoad[villageS][1] };
  for (let i = villageS - 8; i <= villageS + 8; i++) {
    if (i < 1 || i >= mainRoad.length) continue;
    const [x0, z0] = mainRoad[i - 1];
    const [x1, z1] = mainRoad[i];
    const yaw = Math.atan2(-(x1 - x0), -(z1 - z0));
    const len = Math.hypot(x1 - x0, z1 - z0);
    const nx = -(z1 - z0) / len;
    const nz = (x1 - x0) / len;
    for (const side of [-1, 1]) {
      if (!chance(0.75)) continue;
      const off = side * r(13, 18);
      const x = x1 + nx * off;
      const z = z1 + nz * off;
      if (roadMask.get(x, z)) continue;
      const back = [nx * side, nz * side]; // away from the road
      houses.push({ kind: 'house', x, z, w: r(7, 10), d: r(6, 8), h: r(2.8, 3.4), yaw, ruined: chance(o.ruins), back });
      yardMask.stamp(x + nx * side * 8, z + nz * side * 8, 14, 1);
      // Outbuilding in the yard behind: brick garage or wooden shed
      if (chance(0.5)) {
        const along = r(-5, 5);
        const bx = x + back[0] * r(12, 15) - nz * along;
        const bz = z + back[1] * r(12, 15) + nx * along;
        const garage = chance(0.4);
        houses.push({
          kind: garage ? 'garage' : 'shed', x: bx, z: bz, yaw,
          w: garage ? r(3.6, 4.2) : r(3, 4), d: garage ? r(5.5, 6.5) : r(3.5, 5), h: garage ? r(2.4, 2.8) : r(2.2, 2.6),
          ruined: chance(o.ruins * 0.7), back,
        });
      }
    }
  }
  // Barns at the village ends, set back from the road
  for (const end of [villageS - 10, villageS + 10]) {
    if (end < 1 || end >= mainRoad.length || !chance(0.75)) continue;
    const [x0, z0] = mainRoad[end - 1];
    const [x1, z1] = mainRoad[end];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const side = chance(0.5) ? 1 : -1;
    const nx = (-(z1 - z0) / len) * side;
    const nz = ((x1 - x0) / len) * side;
    const x = x1 + nx * r(24, 30);
    const z = z1 + nz * r(24, 30);
    houses.push({ kind: 'barn', x, z, w: r(9, 12), d: r(16, 22), h: r(3.8, 4.8), yaw: Math.atan2(-(x1 - x0), -(z1 - z0)), ruined: chance(o.ruins), back: [nx, nz] });
    yardMask.stamp(x, z, 16, 1);
  }

  // ---------- ravines: winding gullies crossing the map ----------
  const ravines = []; // { pts: [[x, z]], width, depth }
  for (let k = 0; k < Math.round(o.ravines); k++) {
    const vertical = chance(0.5);
    let x = vertical ? r(-half * 0.8, half * 0.8) : -half;
    let z = vertical ? -half : r(-half * 0.8, half * 0.8);
    let heading = vertical ? Math.PI / 2 : 0; // +x or +z
    const pts = [];
    while (Math.abs(x) <= half && Math.abs(z) <= half && pts.length < 600) {
      pts.push([x, z]);
      heading += r(-0.18, 0.18);
      const base = vertical ? Math.PI / 2 : 0;
      heading = base + Math.max(-0.7, Math.min(0.7, heading - base));
      x += Math.cos(heading) * 8;
      z += Math.sin(heading) * 8;
    }
    ravines.push({ pts, width: r(40, 85), depth: r(5, 11) });
  }
  const nearestRavinePoint = (x, z, maxDist) => {
    let best = null;
    let bestD = maxDist;
    for (const rv of ravines) {
      rv.pts.forEach(([px, pz], i) => {
        const d = Math.hypot(px - x, pz - z);
        if (d < bestD) {
          bestD = d;
          const [qx, qz] = rv.pts[Math.min(i + 1, rv.pts.length - 1)];
          best = { x: px, z: pz, ravine: rv, yaw: Math.atan2(-(qx - px), -(qz - pz)), dist: d };
        }
      });
    }
    return best;
  };

  // ---------- hills and lowlands ----------
  const area = (size / 2000) ** 2;
  const bumps = [];
  for (let i = 0; i < Math.round(o.hilliness * 30 * area); i++) bumps.push({ x: r(-half, half), z: r(-half, half), r: r(25, 70), h: r(2, 7) });
  for (let i = 0; i < Math.round(o.hilliness * 10 * area); i++) bumps.push({ x: r(-half, half), z: r(-half, half), r: r(60, 160), h: -r(1.5, 4) });

  // ---------- launch spot ----------
  const launchCandidates = {
    field: () => {
      for (let i = 0; i < 60; i++) {
        const x = launchRef.x + r(-120, 120);
        const z = launchRef.z + r(-80, 80);
        if (!isForest(x, z) && !treeMask.get(x, z) && !roadMask.get(x, z)) return { x, z, clear: 6 };
      }
      return null;
    },
    treeline: () => {
      // Just behind (south of) a tree line, in a gap of the near row
      let best = null;
      for (const t of treeLines) {
        const ex = t.x2 - t.x1;
        const ez = t.z2 - t.z1;
        const len = Math.hypot(ex, ez);
        const sOn = Math.max(0.1, Math.min(0.9, ((launchRef.x - t.x1) * ex + (launchRef.z - t.z1) * ez) / (len * len)));
        let nx = -ez / len;
        let nz = ex / len;
        if (nz < 0) { nx = -nx; nz = -nz; } // our side = +Z
        const x = t.x1 + ex * sOn + nx * 8;
        const z = t.z1 + ez * sOn + nz * 8;
        const d = Math.hypot(x - launchRef.x, z - launchRef.z);
        if (d < 260 && (!best || d < best.d) && !roadMask.get(x, z)) best = { x, z, d, clear: 5 };
      }
      return best;
    },
    forest: () => {
      for (let i = 0; i < 300; i++) {
        const x = launchRef.x + r(-250, 250);
        const z = launchRef.z + r(-150, 150);
        if ([0, 1, 2, 3, 4, 5].every((k) => isForest(x + Math.cos(k) * 25, z + Math.sin(k) * 25)) && isForest(x, z)) return { x, z, clear: 9 };
      }
      return null;
    },
    ravine: () => {
      const p = nearestRavinePoint(launchRef.x, launchRef.z, 450);
      return p && p.ravine.depth > 4 && !roadMask.get(p.x, p.z) ? { x: p.x, z: p.z, clear: 6 } : null;
    },
    ruins: () => {
      for (let i = 0; i < 40; i++) {
        const x = launchRef.x + r(-120, 120);
        const z = launchRef.z + r(-80, 80);
        if (!isForest(x, z) && !roadMask.get(x, z)) return { x, z, clear: 6, ruins: true };
      }
      return null;
    },
    track: () => {
      let best = null;
      for (const [name, route] of Object.entries(routes)) {
        if (!name.startsWith('track')) continue;
        for (let i = 1; i < route.length; i++) {
          const [x0, z0] = route[i - 1];
          const [x1, z1] = route[i];
          const len = Math.hypot(x1 - x0, z1 - z0);
          const x = x1 - ((z1 - z0) / len) * 6;
          const z = z1 + ((x1 - x0) / len) * 6;
          const d = Math.hypot(x - launchRef.x, z - launchRef.z);
          if (d < 400 && (!best || d < best.d) && !roadMask.get(x, z)) best = { x, z, d, clear: 6 };
        }
      }
      return best;
    },
  };
  // Weighted order without replacement; open field is the least likely (and the fallback)
  const SPOT_WEIGHTS = { treeline: 0.22, forest: 0.18, ravine: 0.18, ruins: 0.16, track: 0.12, field: 0.14 };
  const weightedOrder = () => {
    const left = { ...SPOT_WEIGHTS };
    const out = [];
    while (Object.keys(left).length) {
      const k = pickWeighted(left);
      out.push(k);
      delete left[k];
    }
    return out;
  };
  const spotOrder = o.launchSpot !== 'random' && launchCandidates[o.launchSpot]
    ? [o.launchSpot, 'field']
    : weightedOrder();
  for (const kind of spotOrder) {
    const c = launchCandidates[kind]();
    if (!c) continue;
    Object.assign(launch, { x: c.x, z: c.z, kind, clear: c.clear });
    if (c.ruins) {
      // Small ruined farmstead around a yard
      const kinds = ['house', 'barn', 'shed'];
      const n = 2 + Math.floor(rand() * 2);
      for (let k = 0; k < n; k++) {
        const kind = kinds[k];
        const a = (k / n) * Math.PI * 2 + r(-0.4, 0.4);
        const d = kind === 'barn' ? r(18, 22) : r(13, 17);
        const dims = kind === 'barn' ? [r(8, 10), r(12, 16), r(3.6, 4.4)] : kind === 'shed' ? [r(3, 4), r(3.5, 4.5), r(2.2, 2.5)] : [r(6, 9), r(5, 7), r(2.6, 3.2)];
        houses.push({ kind, x: c.x + Math.cos(a) * d, z: c.z + Math.sin(a) * d, w: dims[0], d: dims[1], h: dims[2], yaw: -a + Math.PI / 2, ruined: true, farm: true, back: [Math.cos(a), Math.sin(a)] });
      }
      yardMask.stamp(c.x, c.z, 18, 1);
    }
    break;
  }

  // ---------- heights ----------
  // Large-scale relief on a 4 m grid, upsampled to the fine grid; features are carved at full resolution.
  const hill = o.hilliness;
  const baseHeight = (x, z) => {
    let h = 14 * fbm(x / 700, z / 700, 3) + 3.2 * hill * fbm(x / 170 + 9, z / 170 - 4, 3)
      + 1.1 * hill * fbm(x / 55 - 3, z / 55 + 8, 2) + 0.3 * fbm(x / 18, z / 18, 2);
    h *= 1 - smoothstep(half - 120, half - 20, Math.max(Math.abs(x), Math.abs(z))); // 0 at map edge
    return h;
  };
  const edgeFade = (x, z) => 1 - smoothstep(half - 120, half - 40, Math.max(Math.abs(x), Math.abs(z)));
  const cell = o.terrainCell;
  const n = Math.round(size / cell);
  const stride = n + 1;
  const heights = new Float32Array(stride * stride);
  const CC = Math.max(4, cell);
  const cn = Math.round(size / CC);
  const coarse = new Float32Array((cn + 1) * (cn + 1));
  for (let iz = 0; iz <= cn; iz++) {
    for (let ix = 0; ix <= cn; ix++) coarse[iz * (cn + 1) + ix] = baseHeight(-half + ix * CC, -half + iz * CC);
  }
  const ratio = CC / cell;
  for (let iz = 0; iz <= n; iz++) {
    const fz = iz / ratio;
    const cz = Math.min(cn - 1, Math.floor(fz));
    const tz = fz - cz;
    for (let ix = 0; ix <= n; ix++) {
      const fx = ix / ratio;
      const cx = Math.min(cn - 1, Math.floor(fx));
      const tx = fx - cx;
      const a = coarse[cz * (cn + 1) + cx];
      const b = coarse[cz * (cn + 1) + cx + 1];
      const c = coarse[(cz + 1) * (cn + 1) + cx];
      const d = coarse[(cz + 1) * (cn + 1) + cx + 1];
      heights[iz * stride + ix] = a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
    }
  }
  // Visit fine grid vertices within radius of (x, z): fn(index, dx, dz)
  const forVertices = (x, z, rad, fn) => {
    const ix0 = Math.max(0, Math.floor((x - rad + half) / cell));
    const ix1 = Math.min(n, Math.ceil((x + rad + half) / cell));
    const iz0 = Math.max(0, Math.floor((z - rad + half) / cell));
    const iz1 = Math.min(n, Math.ceil((z + rad + half) / cell));
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) fn(iz * stride + ix, -half + ix * cell - x, -half + iz * cell - z);
    }
  };

  for (const b of bumps) {
    forVertices(b.x, b.z, b.r * 2.5, (i, dx, dz) => {
      heights[i] += b.h * Math.exp(-(dx * dx + dz * dz) / (b.r * b.r)) * edgeFade(b.x + dx, b.z + dz);
    });
    if (b.h < 0) {
      for (let dz = -b.r; dz <= b.r; dz += RC) {
        for (let dx = -b.r; dx <= b.r; dx += RC) {
          const f = Math.exp(-(dx * dx + dz * dz) / (b.r * b.r));
          if (f > 0.3) wet.max(b.x + dx, b.z + dz, f * 0.6);
        }
      }
    }
  }

  // Ravines: smooth profile, max-combined; roads cross them on embankments
  const roadZone = createRaster(size, 2);
  for (const road of Object.values(routes)) {
    for (let i = 1; i < road.length; i++) {
      for (const [rad, level] of [[17, 1], [14, 2], [11, 3], [8, 4], [5, 5]]) roadZone.stampLine(...road[i - 1], ...road[i], rad, level);
    }
  }
  const carve = new Float32Array(stride * stride);
  for (const rv of ravines) {
    const hw = rv.width / 2;
    for (let k = 1; k < rv.pts.length; k++) {
      const [x0, z0] = rv.pts[k - 1];
      const [x1, z1] = rv.pts[k];
      for (let t = 0; t < 1; t += 0.5) {
        const px = x0 + (x1 - x0) * t;
        const pz = z0 + (z1 - z0) * t;
        forVertices(px, pz, hw, (i, dx, dz) => {
          const d = Math.hypot(dx, dz);
          if (d >= hw) return;
          const c = Math.cos((d / hw) * Math.PI * 0.5);
          const v = rv.depth * c * c;
          if (v > carve[i]) carve[i] = v;
        });
        for (let dz = -hw; dz <= hw; dz += RC) {
          for (let dx = -hw; dx <= hw; dx += RC) {
            const d = Math.hypot(dx, dz);
            if (d < hw) wet.max(px + dx, pz + dz, Math.cos((d / hw) * Math.PI * 0.5) ** 2);
          }
        }
      }
    }
  }
  for (let iz = 0; iz <= n; iz++) {
    for (let ix = 0; ix <= n; ix++) {
      const i = iz * stride + ix;
      if (!carve[i]) continue;
      const x = -half + ix * cell;
      const z = -half + iz * cell;
      heights[i] -= carve[i] * (1 - roadZone.get(x, z) / 5) * edgeFade(x, z);
    }
  }

  // ---------- craters (bowls carved into the height grid + decals) ----------
  const craters = [];
  const craterCount = Math.round(o.craters * 700 * (size / 2000) ** 2);
  for (let tries = 0; craters.length < craterCount && tries < craterCount * 20; tries++) {
    const x = r(-half + 40, half - 40);
    const z = r(-half + 40, half - 40);
    const g = grey(x, z);
    if (rand() > 0.05 + g * 0.95) continue;
    if (Math.hypot(x - launch.x, z - launch.z) < launch.clear + 15) continue;
    const big = chance(0.15);
    craters.push({ x, z, r: big ? r(3.5, 6) : r(1.2, 3) });
  }
  const cellH = (ix, iz) => heights[iz * stride + ix];
  for (const c of craters) {
    if (c.r < cell * 0.9) continue; // too small for the grid: decal only
    const depth = c.r * 0.28;
    forVertices(c.x, c.z, c.r * 1.4, (i, dx, dz) => {
      const d = Math.hypot(dx, dz) / c.r;
      if (d < 1) heights[i] -= depth * (1 - d * d);
      else if (d < 1.4) heights[i] += depth * 0.25 * Math.sin(((d - 1) / 0.4) * Math.PI); // rim
    });
  }

  // Exact surface height (triangle interpolation matching the rendered mesh)
  function heightAt(x, z) {
    const fx = (x + half) / cell;
    const fz = (z + half) / cell;
    if (fx < 0 || fz < 0 || fx >= n || fz >= n) return 0;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    if (tx + tz <= 1) {
      const h00 = cellH(ix, iz);
      return h00 + (cellH(ix + 1, iz) - h00) * tx + (cellH(ix, iz + 1) - h00) * tz;
    }
    const h11 = cellH(ix + 1, iz + 1);
    return h11 + (cellH(ix, iz + 1) - h11) * (1 - tx) + (cellH(ix + 1, iz) - h11) * (1 - tz);
  }

  // ---------- ground colour ----------
  function groundColor(x, z, out) {
    const road = roadMask.get(x, z);
    let c;
    if (road === 2) c = COLORS.road;
    else if (road === 1) c = COLORS.road;
    else if (isForest(x, z)) c = COLORS.forestFloor;
    else if (yardMask.get(x, z)) c = COLORS.yard;
    else if (treeMask.get(x, z)) c = COLORS.treeline;
    else c = CROPS[fieldCrop(x, z)];
    const wv = road ? 0 : wet.get(x, z);
    if (wv > 0) {
      const k = Math.min(1, wv * 1.2);
      c = [c[0] + (COLORS.wet[0] - c[0]) * k, c[1] + (COLORS.wet[1] - c[1]) * k, c[2] + (COLORS.wet[2] - c[2]) * k];
    }
    if (earthMask.get(x, z)) c = COLORS.earth;
    const g = grey(x, z);
    const n1 = fbm(x / 45, z / 45, 2) * 0.12;
    const scorch = g * Math.max(0, fbm(x / 90 + 3, z / 90, 2)) * 0.9;
    let cr = c[0] * (1 + n1);
    let cg = c[1] * (1 + n1);
    let cb = c[2] * (1 + n1);
    cr += (COLORS.scorched[0] - cr) * scorch;
    cg += (COLORS.scorched[1] - cg) * scorch;
    cb += (COLORS.scorched[2] - cb) * scorch;
    if (road !== 1 && fieldCrop(x, z) === 'plowed' && !treeMask.get(x, z)) {
      const [u] = toGrid(x, z);
      const stripe = Math.floor(u / 3) % 2 ? 0.92 : 1; // furrows
      cr *= stripe;
      cg *= stripe;
      cb *= stripe;
    }
    return out.setRGB(cr, cg, cb);
  }

  // ---------- grass: [density 0..1, height m] for the GPU grass ----------
  function grassAt(x, z) {
    if (Math.hypot(x - launch.x, z - launch.z) < launch.clear) return [0.9, 0.1]; // short grass on the pad
    const road = roadMask.get(x, z);
    if (road === 2) return [0, 0];
    if (road === 1) return [0.18, 0.15]; // tufts along a field track
    if (earthMask.get(x, z)) return [0.08, 0.2];
    let d;
    let h;
    if (isForest(x, z)) [d, h] = [0.35, 0.3];
    else if (yardMask.get(x, z)) [d, h] = [0.5, 0.25];
    else if (treeMask.get(x, z)) [d, h] = [0.85, 0.7];
    else [d, h] = CROP_GRASS[fieldCrop(x, z)];
    const wv = wet.get(x, z);
    if (wv > 0) {
      d += (0.95 - d) * wv;
      h += (0.75 - h) * wv;
    }
    const scorch = grey(x, z) * Math.max(0, fbm(x / 90 + 3, z / 90, 2)) * 0.9;
    d *= (1 - scorch * 0.85) * (0.8 + 0.4 * (fbm(x / 22 + 5, z / 22 - 1, 2) * 0.5 + 0.5)); // patchy
    return [Math.min(1, Math.max(0, d)), h];
  }

  // ---------- enemy positions ----------
  const occupied = houses.map((h) => ({ x: h.x, z: h.z, r: Math.max(h.w, h.d) / 2 + 1.5 })); // footprints of placed objects
  const free = (x, z, rad) => inside(x, z, 40) && !occupied.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + rad);
  const nearestTreeLinePoint = (x, z) => {
    let best = null;
    let bestD = Infinity;
    for (const t of treeLines) {
      const ex = t.x2 - t.x1;
      const ez = t.z2 - t.z1;
      const len2 = ex * ex + ez * ez;
      const s = Math.max(0, Math.min(1, ((x - t.x1) * ex + (z - t.z1) * ez) / len2));
      const px = t.x1 + ex * s;
      const pz = t.z1 + ez * s;
      const d = Math.hypot(px - x, pz - z);
      if (d < bestD) {
        bestD = d;
        best = { x: px, z: pz, line: t, yaw: Math.atan2(-ex, -ez), dist: d };
      }
    }
    return best;
  };
  const findForestEdge = (x, z) => {
    for (let rad = 0; rad < 400; rad += 20) {
      for (let a = 0; a < Math.PI * 2; a += 0.3) {
        const px = x + Math.cos(a) * rad;
        const pz = z + Math.sin(a) * rad;
        if (isForest(px, pz) && !isForest(px + Math.cos(a) * 25, pz + Math.sin(a) * 25)) return { x: px, z: pz, yaw: a };
      }
    }
    return null;
  };

  const sites = [];
  const kinds = ['treeline', 'village', 'forest', 'field', 'treeline', 'ravine'];
  const villageHouses = houses.filter((h) => !h.farm && h.kind === 'house');
  for (let i = 0; i < o.enemySites; i++) {
    const bearing = r(-0.6, 0.6);
    const dist = r(o.launchMin, o.launchMax);
    const sx = launch.x + Math.sin(bearing) * dist;
    const sz = launch.z - Math.cos(bearing) * dist;
    let kind = kinds[(i + Math.floor(rand() * kinds.length)) % kinds.length];
    if (kind === 'village' && sites.some((s) => s.kind === 'village')) kind = 'treeline';
    let anchor = null;
    if (kind === 'treeline') {
      const p = nearestTreeLinePoint(sx, sz);
      if (p && p.dist < 250) anchor = { x: p.x, z: p.z, yaw: p.yaw, line: p.line };
    } else if (kind === 'village') {
      anchor = { x: villageCenter.x, z: villageCenter.z, yaw: 0 };
    } else if (kind === 'forest') {
      const p = findForestEdge(sx, sz);
      if (p && Math.hypot(p.x - sx, p.z - sz) < 300) anchor = p;
    } else if (kind === 'ravine') {
      const p = nearestRavinePoint(sx, sz, 250);
      if (p) anchor = { x: p.x, z: p.z, yaw: p.yaw, ravine: p.ravine };
    }
    if (!anchor) {
      kind = 'field';
      anchor = { x: sx, z: sz, yaw: r(0, Math.PI * 2) };
    }
    if (!inside(anchor.x, anchor.z, 80)) continue;
    sites.push({ kind, x: anchor.x, z: anchor.z, yaw: anchor.yaw ?? 0, line: anchor.line, ravine: anchor.ravine, items: [] });
  }

  const parked = []; // { type, x, z, yaw, net, site }
  for (const site of sites) {
    const count = Math.max(1, o.vehiclesPerSite + Math.floor(r(-1, 2)));
    const items = [];
    for (let k = 0; k < count; k++) items.push(pickWeighted(VEHICLE_WEIGHTS));
    if (chance(0.75)) items.push('ammo');
    if (chance(0.3)) items.push('ammo');
    for (const type of items) {
      let placed = null;
      for (let attempt = 0; attempt < 40 && !placed; attempt++) {
        let x;
        let z;
        let yaw;
        if (site.kind === 'treeline' && site.line) {
          const t = site.line;
          const len = Math.hypot(t.x2 - t.x1, t.z2 - t.z1);
          const s = Math.max(0, Math.min(1, ((site.x - t.x1) * (t.x2 - t.x1) + (site.z - t.z1) * (t.z2 - t.z1)) / (len * len) + r(-60, 60) / len));
          const side = chance(0.6) ? 1 : -1; // tucked into the tree row
          const nx = -(t.z2 - t.z1) / len;
          const nz = (t.x2 - t.x1) / len;
          const off = side * r(1, 4);
          x = t.x1 + (t.x2 - t.x1) * s + nx * off;
          z = t.z1 + (t.z2 - t.z1) * s + nz * off;
          yaw = site.yaw + (chance(0.5) ? 0 : Math.PI);
        } else if (site.kind === 'ravine' && site.ravine) {
          // Along the gully floor, sheltered by its slopes
          const p = nearestRavinePoint(site.x + r(-60, 60), site.z + r(-60, 60), 120);
          if (!p) continue;
          const across = r(-0.15, 0.15) * site.ravine.width;
          x = p.x + Math.cos(p.yaw) * across;
          z = p.z - Math.sin(p.yaw) * across;
          yaw = p.yaw + (chance(0.5) ? 0 : Math.PI);
        } else if (site.kind === 'village' && villageHouses.length) {
          const h = villageHouses[Math.floor(rand() * villageHouses.length)];
          const a = h.yaw + (chance(0.5) ? Math.PI / 2 : -Math.PI / 2);
          x = h.x - Math.sin(a) * r(8, 12) + r(-4, 4);
          z = h.z - Math.cos(a) * r(8, 12) + r(-4, 4);
          yaw = h.yaw + r(-0.3, 0.3);
          if (roadMask.get(x, z) === 2) continue;
        } else if (site.kind === 'forest') {
          x = site.x + r(-35, 35);
          z = site.z + r(-35, 35);
          if (!isForest(x, z)) continue;
          yaw = r(0, Math.PI * 2);
        } else {
          x = site.x + r(-45, 45);
          z = site.z + r(-45, 45);
          yaw = r(0, Math.PI * 2);
        }
        const rad = type === 'ammo' ? 3 : 5;
        if (!free(x, z, rad)) continue;
        const net = chance(type === 'ammo' ? Math.min(1, o.camoNets + 0.2) : o.camoNets);
        placed = { type, x, z, yaw, net, branches: !net && type !== 'ammo' && chance(o.branchCamo), site: sites.indexOf(site) };
        occupied.push({ x, z, r: rad });
      }
      if (placed) {
        parked.push(placed);
        site.items.push(placed);
      }
    }
  }

  // Burnt-out wrecks along roads in the grey zone (decor, not targets)
  const wrecks = [];
  for (let tries = 0; wrecks.length < o.wrecks && tries < 200; tries++) {
    const route = rand() < 0.6 ? mainRoad : crossRoad;
    const i = 1 + Math.floor(rand() * (route.length - 2));
    const [x0, z0] = route[i - 1];
    const [x1, z1] = route[i];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const off = r(4, 9) * (chance(0.5) ? 1 : -1);
    const x = x1 - ((z1 - z0) / len) * off;
    const z = z1 + ((x1 - x0) / len) * off;
    if (grey(x, z) < 0.3 || !free(x, z, 5)) continue;
    wrecks.push({ type: pickWeighted(VEHICLE_WEIGHTS), x, z, yaw: Math.atan2(-(x1 - x0), -(z1 - z0)) + r(-0.8, 0.8) });
    occupied.push({ x, z, r: 5 });
  }

  // ---------- yard fences behind village houses (skipping where vehicles stand) ----------
  const fences = []; // { x1, z1, x2, z2 }
  for (const h of houses) {
    if (h.kind !== 'house' || h.farm || !chance(0.7)) continue;
    const tx = -Math.sin(h.yaw);
    const tz = -Math.cos(h.yaw);
    const [bx, bz] = h.back;
    const half = r(6, 9);
    const near = h.d / 2 + 1.5;
    const far = r(14, 20);
    const corner = (a, b) => [h.x + tx * a + bx * b, h.z + tz * a + bz * b];
    const ring = [corner(-half, near), corner(-half, far), corner(half, far), corner(half, near)];
    for (let k = 0; k < 3; k++) {
      const [x1, z1] = ring[k];
      const [x2, z2] = ring[k + 1];
      const len = Math.hypot(x2 - x1, z2 - z1);
      for (let s0 = 0; s0 < len; s0 += 4) {
        if (chance(0.22)) continue; // gaps and broken sections
        const s1 = Math.min(len, s0 + 4);
        if (s1 - s0 < 0.8) continue; // leftover sliver
        const ax = x1 + ((x2 - x1) * s0) / len;
        const az = z1 + ((z2 - z1) * s0) / len;
        const cx = x1 + ((x2 - x1) * s1) / len;
        const cz = z1 + ((z2 - z1) * s1) / len;
        const mx = (ax + cx) / 2;
        const mz = (az + cz) / 2;
        if (roadMask.get(mx, mz) || occupied.some((p) => p.r < 6 && Math.hypot(p.x - mx, p.z - mz) < p.r + 1.5)) continue;
        fences.push({ x1: ax, z1: az, x2: cx, z2: cz });
      }
    }
  }

  // ---------- earthworks around parked vehicles: pit + U-shaped berm open at the front ----------
  for (const p of parked) {
    if (sites[p.site].kind === 'village' || !chance(o.revetments)) continue;
    const hx = HALF_WIDTH[p.type] + 1;
    const hz = HALF_LENGTH[p.type] + 1;
    const pit = p.type === 'ammo' ? 0.5 : r(0.6, 1.1);
    const bermH = r(1.3, 2.1);
    const c = Math.cos(p.yaw);
    const sn = Math.sin(p.yaw);
    forVertices(p.x, p.z, Math.max(hx, hz) + 7, (i, dx, dz) => {
      const lx = dx * c - dz * sn;
      const lz = dx * sn + dz * c; // nose = -lz
      const ex = Math.abs(lx) - hx;
      const ez = Math.abs(lz) - hz;
      const dOut = Math.hypot(Math.max(ex, 0), Math.max(ez, 0)) + Math.min(Math.max(ex, ez), 0); // signed distance
      let dh = 0;
      if (dOut < 1.5) dh -= pit * smoothstep(1.5, -0.5, dOut);
      const front = lz < -hz + 0.5 && Math.abs(lx) < hx + 1.5; // exit lane
      const db = Math.abs(dOut - 2.4);
      if (db < 2 && !front) {
        const k = Math.cos((db / 2) * Math.PI * 0.5);
        dh += bermH * k * k;
      }
      heights[i] += dh;
    });
    for (let dz = -(hz + 5); dz <= hz + 5; dz += RC) {
      for (let dx = -(hx + 5); dx <= hx + 5; dx += RC) {
        const lx = dx * c - dz * sn;
        const lz = dx * sn + dz * c;
        if (Math.abs(lx) < hx + 4.5 && Math.abs(lz) < hz + 4.5 && (Math.abs(lx) > hx + 0.5 || Math.abs(lz) > hz + 0.5)) earthMask.stamp(p.x + dx, p.z + dz, 0, 1);
      }
    }
  }

  // ---------- launch pad: level ground under the drone ----------
  {
    let sum = 0;
    let cnt = 0;
    forVertices(launch.x, launch.z, 3, (i) => {
      sum += heights[i];
      cnt++;
    });
    const padH = sum / cnt;
    forVertices(launch.x, launch.z, 9, (i, dx, dz) => {
      const k = 1 - smoothstep(4, 9, Math.hypot(dx, dz));
      heights[i] += (padH - heights[i]) * k;
    });
  }

  // Moving vehicles on roads/tracks, starting near the enemy area
  const routeNames = Object.keys(routes);
  const moving = [];
  for (let i = 0; i < o.movingVehicles; i++) {
    const route = routeNames[i === 0 ? 0 : Math.floor(rand() * routeNames.length)];
    moving.push({ type: pickWeighted({ truck: 0.3, car: 0.25, apc: 0.15, ifv: 0.15, tank: 0.15 }), route, speed: r(4, 9), start: r(0.2, 0.8), dir: chance(0.5) ? 1 : -1 });
  }

  // ---------- vegetation ----------
  const trees = []; // { kind: species name (vegetation.js SPECIES), x, z, h }
  const bushes = []; // { x, z, r, h }
  const blocked = (x, z, rad) =>
    roadMask.get(x, z) || Math.hypot(x - launch.x, z - launch.z) < launch.clear + rad ||
    occupied.some((p) => Math.abs(p.x - x) < p.r + rad && Math.abs(p.z - z) < p.r + rad && Math.hypot(p.x - x, p.z - z) < p.r + rad - 1);
  const veg = o.vegetation;
  // mix: a TREE_MIX key or a species name; height comes from the species
  const addTree = (mix, x, z) => {
    let kind = TREE_MIX[mix] ? pickWeighted(TREE_MIX[mix]) : mix;
    if (mix === 'treeline' && wet.get(x, z) > 0.4 && chance(0.5)) kind = 'willow';
    const g = grey(x, z);
    if (chance(g * 0.45)) kind = 'dead'; // shelling strips the crowns
    const [h0, h1] = TREE_HEIGHT[kind];
    const h = r(h0, h1);
    // Trunks may stand right beside a parked vehicle so the crown hangs over it
    if (!inside(x, z, 10) || blocked(x, z, -0.2)) return;
    if (Math.hypot(x - launch.x, z - launch.z) < launch.clear + h * 0.5 + 1) return; // keep the sky above the pad open
    trees.push({ kind, x, z, h });
  };
  const addBush = (x, z, rad) => {
    if (!inside(x, z, 10) || blocked(x, z, 0)) return;
    bushes.push({ x, z, r: rad, h: rad * r(0.7, 1.1) });
  };

  for (const t of treeLines) {
    const len = Math.hypot(t.x2 - t.x1, t.z2 - t.z1);
    const ux = (t.x2 - t.x1) / len;
    const uz = (t.z2 - t.z1) / len;
    const spacing = 4.2 / Math.sqrt(veg);
    for (let s = 0; s < len; s += spacing * r(0.7, 1.3)) {
      for (const side of [-1.8, 1.8]) {
        if (!chance(0.88)) continue;
        const x = t.x1 + ux * s - uz * side + r(-1, 1);
        const z = t.z1 + uz * s + ux * side + r(-1, 1);
        addTree('treeline', x, z);
      }
      if (chance(0.7 * veg)) {
        const side = r(-5, 5);
        addBush(t.x1 + ux * s - uz * side, t.z1 + uz * s + ux * side, r(0.8, 1.8));
      }
    }
  }
  const forestSpacing = 7.5 / Math.sqrt(veg);
  for (let z = -half + 20; z < half - 20; z += forestSpacing) {
    for (let x = -half + 20; x < half - 20; x += forestSpacing) {
      const px = x + r(-3, 3);
      const pz = z + r(-3, 3);
      if (!isForest(px, pz)) continue;
      const pineZone = fbm(px / 250 - 20, pz / 250 + 7, 2) > 0;
      addTree(pineZone ? 'forestPine' : 'forestLeaf', px, pz);
      if (chance(0.35 * veg)) addBush(px + r(-3, 3), pz + r(-3, 3), r(0.8, 1.6));
    }
  }
  for (const h of houses) {
    for (let k = 0; k < 4; k++) {
      const a = r(0, Math.PI * 2);
      const d = r(8, 16);
      if (chance(0.6)) addTree('village', h.x + Math.cos(a) * d, h.z + Math.sin(a) * d);
      else addBush(h.x + Math.cos(a) * d, h.z + Math.sin(a) * d, r(0.8, 1.5));
    }
  }
  // Ravines: brush and trees, densest on the floor
  for (const rv of ravines) {
    for (let k = 0; k < rv.pts.length; k++) {
      const [px, pz] = rv.pts[k];
      for (let m = 0; m < 2 * veg; m++) {
        const across = (rand() - 0.5) * rv.width * 0.8;
        const [qx, qz] = rv.pts[Math.min(k + 1, rv.pts.length - 1)];
        const len = Math.hypot(qx - px, qz - pz) || 1;
        const x = px - ((qz - pz) / len) * across + r(-3, 3);
        const z = pz + ((qx - px) / len) * across + r(-3, 3);
        const floor = 1 - Math.abs(across) / (rv.width * 0.4);
        if (rand() > 0.35 + floor * 0.5) continue;
        if (chance(0.3)) addTree('ravine', x, z);
        else addBush(x, z, r(0.8, 2));
      }
    }
  }
  // Scrub and lone trees in the fields
  const scrub = Math.round(400 * veg * (size / 2000) ** 2);
  for (let i = 0; i < scrub; i++) {
    const x = r(-half, half);
    const z = r(-half, half);
    if (chance(0.25)) addTree(wet.get(x, z) > 0.4 ? 'ravine' : 'lone', x, z);
    else addBush(x, z, r(0.6, 1.4));
  }
  // Parked under a tree: a big crown right beside most hidden vehicles
  for (const p of parked) {
    if (sites[p.site].kind === 'field' || !chance(0.75)) continue;
    const side = chance(0.5) ? 1 : -1;
    const off = HALF_WIDTH[p.type] + r(1.4, 2.2);
    const along = r(-1.5, 1.5);
    const x = p.x + Math.cos(p.yaw) * off * side - Math.sin(p.yaw) * along;
    const z = p.z - Math.sin(p.yaw) * off * side - Math.cos(p.yaw) * along;
    const kind = pickWeighted(TREE_MIX.cover);
    if (inside(x, z, 10) && !roadMask.get(x, z)) trees.push({ kind, x, z, h: r(TREE_HEIGHT[kind][0] + 1, TREE_HEIGHT[kind][1]) });
  }
  // Bushes around enemy positions help hide them
  for (const p of parked) {
    for (let k = 0; k < 3; k++) {
      const a = r(0, Math.PI * 2);
      addBush(p.x + Math.cos(a) * r(5, 8), p.z + Math.sin(a) * r(5, 8), r(0.8, 1.6));
    }
  }

  // ---------- cover points for vehicle AI ----------
  const coverPoints = [];
  for (const t of treeLines) {
    const len = Math.hypot(t.x2 - t.x1, t.z2 - t.z1);
    for (let s = 15; s < len; s += 35) {
      const f = s / len;
      const x = t.x1 + (t.x2 - t.x1) * f;
      const z = t.z1 + (t.z2 - t.z1) * f;
      if (inside(x, z, 40)) coverPoints.push([x, z]);
    }
  }
  for (let z = -half + 60; z < half - 60; z += 40) {
    for (let x = -half + 60; x < half - 60; x += 40) {
      if (isForest(x, z) && !isForest(x + 40, z)) coverPoints.push([x - 6, z]);
    }
  }
  for (const rv of ravines) {
    for (let k = 0; k < rv.pts.length; k += 5) if (inside(...rv.pts[k], 40)) coverPoints.push(rv.pts[k]);
  }

  return {
    seed,
    size,
    half,
    cell,
    n,
    heights,
    heightAt,
    groundColor,
    grassAt,
    launch,
    enemyCenter,
    sites,
    parked,
    wrecks,
    moving,
    routes,
    houses,
    craters,
    trees,
    bushes,
    ravines,
    fences,
    treeLines,
    coverPoints,
    villageCenter,
    mainRoad,
    grey,
  };
}
