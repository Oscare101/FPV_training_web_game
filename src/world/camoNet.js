import * as THREE from 'three';
import { mulberry32 } from './random.js';

// Camouflage nets like the real ones: a rope mesh with incised "leaf" garnish in blotches of
// 3-4 colours, see-through gaps between them, ragged edges. The shape comes from a small cloth
// simulation run once at build time: the net is pinned to poles, tree trunks and ground pegs,
// sags between them and drapes over whatever is under it (the vehicle). Collision uses the same
// triangles as the mesh.

// Garnish colours (sRGB) per season, and the rope colour
const PALETTES = {
  summer: [[58, 66, 38], [88, 92, 52], [96, 78, 52], [126, 116, 80]],
  spring: [[64, 86, 42], [90, 100, 56], [50, 60, 36], [92, 80, 54]],
  autumn: [[108, 84, 52], [138, 114, 72], [90, 86, 52], [70, 60, 40]],
  winter: [[212, 215, 216], [182, 186, 188], [146, 148, 146], [112, 116, 102]],
};
const ROPE = [44, 42, 32];
export const NET_TILE = 2.4; // m of net per texture repeat

// Tileable value noise on an n×n lattice
function tileNoise(size, cells, rand) {
  const lat = new Float32Array(cells * cells).map(() => rand());
  return (x, y) => {
    const fx = (x / size) * cells;
    const fy = (y / size) * cells;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const at = (a, b) => lat[(((b % cells) + cells) % cells) * cells + (((a % cells) + cells) % cells)];
    const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
    const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
    return top + (bottom - top) * sy;
  };
}

const textures = new Map(); // season -> texture (shared, never disposed: small and reused every map)

export function camoNetTexture(season = 'summer') {
  if (textures.has(season)) return textures.get(season);
  const N = 512;
  const rand = mulberry32(77);
  const palette = PALETTES[season] ?? PALETTES.summer;
  const data = new Uint8Array(N * N * 4);
  const put = (x, y, r, g, b) => {
    const i = (((y + N) % N) * N + ((x + N) % N)) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  // rope mesh: diagonal squares ~8 cm
  const mesh = Math.round((0.08 / NET_TILE) * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if ((x + y) % mesh < 2 || (x - y + N * 8) % mesh < 2) put(x, y, ...ROPE);
    }
  }
  // colour blotches (~0.4 m) and see-through gaps (~0.25 m) as low-frequency noise
  const blotch = tileNoise(N, 6, rand);
  const blotch2 = tileNoise(N, 13, rand);
  const gaps = tileNoise(N, 10, rand);
  const colourAt = (x, y) => {
    const v = blotch(x, y) * 0.7 + blotch2(x, y) * 0.3;
    return palette[v < 0.36 ? 0 : v < 0.5 ? 1 : v < 0.64 ? 2 : 3];
  };
  // garnish leaves: pointed ellipses 5-11 cm, random angles, denser where the gap noise is low
  const leafCount = 5200;
  for (let k = 0; k < leafCount; k++) {
    const cx = rand() * N;
    const cy = rand() * N;
    if (gaps(cx, cy) > 0.62 && rand() < 0.85) continue; // see-through patches
    const len = (0.05 + rand() * 0.06) / NET_TILE * N;
    const wid = len * (0.32 + rand() * 0.18);
    const a = rand() * Math.PI;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const base = colourAt(cx, cy);
    const shade = 0.82 + rand() * 0.3;
    const reach = Math.ceil(len);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const u = (dx * ca + dy * sa) / len;
        const v = (-dx * sa + dy * ca) / wid;
        const taper = 1 - u * u; // pointed ends
        if (u * u > 1 || v * v > taper * taper) continue;
        const edge = 0.86 + 0.14 * Math.min(1, (taper - Math.abs(v)) * 3); // darker rim: reads as 3D cut leaves
        const s = shade * edge;
        put(Math.floor(cx + dx), Math.floor(cy + dy), Math.min(255, base[0] * s), Math.min(255, base[1] * s), Math.min(255, base[2] * s));
      }
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  textures.set(season, tex);
  return tex;
}

// One material per season for every draped net
const materials = new Map();
export function camoNetMaterial(season = 'summer') {
  if (!materials.has(season)) {
    const mat = new THREE.MeshLambertMaterial({ map: camoNetTexture(season), alphaTest: 0.45, side: THREE.DoubleSide });
    mat.userData.shared = true; // reused by every map
    materials.set(season, mat);
  }
  return materials.get(season);
}

// Cloth drape. All positions in a local frame: x right, y up from the ground at the centre,
// z back (nose = -z). spec:
//   hx, hz: half size of the net; spacing: particle grid step (m)
//   top: start height of the flat sheet (above everything)
//   ground(lx, lz): local ground height
//   pins: [{ lx, lz, ly }] grid points nearest each (lx, lz) are held at that point
//   boxes: [{ cx, cy, cz, hx, hy, hz }] solid boxes the net rests on (the vehicle)
//   posts: [{ lx, lz, r, top }] poles and trunks it can't pass through
//   tears: [{ lx, lz, r }] holes torn into the net; ragged: share of edge points cut away
// Returns { points: Float32Array (xyz per grid point), cut: Uint8Array, nx, nz, spacing }
export function drapeNet(spec) {
  const s = spec.spacing ?? 0.4;
  const nx = Math.round((spec.hx * 2) / s) + 1;
  const nz = Math.round((spec.hz * 2) / s) + 1;
  const n = nx * nz;
  const rand = spec.rand ?? mulberry32(1);
  const p = new Float64Array(n * 3); // doubles: no float32 conversion in the hot loop
  const prev = new Float64Array(n * 3);
  const cut = new Uint8Array(n);
  const pinned = new Int32Array(n).fill(-1);
  const pinFrom = [];
  const pinTo = [];
  const idx = (i, j) => j * nx + i;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = idx(i, j) * 3;
      p[k] = -spec.hx + i * s;
      p[k + 1] = spec.top + (rand() - 0.5) * 0.02;
      p[k + 2] = -spec.hz + j * s;
    }
  }
  prev.set(p);
  // tears and ragged edges: cut points (never pinned ones)
  for (const t of spec.tears ?? []) {
    for (let k = 0; k < n; k++) {
      const d = Math.hypot(p[k * 3] - t.lx, p[k * 3 + 2] - t.lz);
      if (d < t.r * (0.75 + rand() * 0.45)) cut[k] = 1;
    }
  }
  for (const pin of spec.pins ?? []) {
    const i = Math.max(0, Math.min(nx - 1, Math.round((pin.lx + spec.hx) / s)));
    const j = Math.max(0, Math.min(nz - 1, Math.round((pin.lz + spec.hz) / s)));
    const k = idx(i, j);
    if (pinned[k] >= 0) continue;
    pinned[k] = pinTo.length;
    cut[k] = 0;
    pinFrom.push([p[k * 3], p[k * 3 + 1], p[k * 3 + 2]]);
    pinTo.push([pin.lx, pin.ly, pin.lz]);
  }
  const ragged = spec.ragged ?? 0.25;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const edge = i === 0 || j === 0 || i === nx - 1 || j === nz - 1;
      const k = idx(i, j);
      if (edge && pinned[k] < 0 && rand() < ragged) cut[k] = 1;
    }
  }

  // distance constraints: structural, shear, bend (every second point, soft)
  const cons = [];
  const slack = 1 + (spec.slack ?? 0.04);
  const link = (a, b, stiff) => {
    if (cut[a] || cut[b]) return;
    const d = Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 2] - p[b * 3 + 2]) * slack;
    cons.push(a, b, d, stiff);
  };
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = idx(i, j);
      if (i + 1 < nx) link(k, idx(i + 1, j), 1);
      if (j + 1 < nz) link(k, idx(i, j + 1), 1);
      if (i + 1 < nx && j + 1 < nz) {
        link(k, idx(i + 1, j + 1), 0.7);
        link(idx(i + 1, j), idx(i, j + 1), 0.7);
      }
      if (i + 2 < nx) link(k, idx(i + 2, j), 0.08);
      if (j + 2 < nz) link(k, idx(i, j + 2), 0.08);
    }
  }
  // links as flat typed arrays: main links first, then bend links; point offsets premultiplied by 3,
  // and each end's share of the correction (0 for a pinned end)
  const order = [];
  for (let q = 0; q < cons.length; q += 4) if (cons[q + 3] >= 0.5) order.push(q);
  const nMain = order.length;
  for (let q = 0; q < cons.length; q += 4) if (cons[q + 3] < 0.5) order.push(q);
  const nLinks = order.length;
  const LA = new Int32Array(nLinks);
  const LB = new Int32Array(nLinks);
  const LR = new Float32Array(nLinks);
  const LS = new Float32Array(nLinks);
  const FA = new Float32Array(nLinks);
  const FB = new Float32Array(nLinks);
  order.forEach((q, i) => {
    const wa = pinned[cons[q]] >= 0 ? 0 : 1;
    const wb = pinned[cons[q + 1]] >= 0 ? 0 : 1;
    LA[i] = cons[q] * 3;
    LB[i] = cons[q + 1] * 3;
    LR[i] = cons[q + 2];
    LS[i] = cons[q + 3];
    FA[i] = wa + wb ? wa / (wa + wb) : 0;
    FB[i] = wa + wb ? wb / (wa + wb) : 0;
  });
  const boxes = spec.boxes ?? [];
  // only posts and trunks the sheet can reach
  const posts = (spec.posts ?? []).filter((c) => Math.abs(c.lx) < spec.hx + c.r + 0.5 && Math.abs(c.lz) < spec.hz + c.r + 0.5);
  const ground = spec.ground;
  const groundCache = new Float32Array(n);
  const steps = spec.steps ?? 120;
  const g = -9.81 * (1 / 60) ** 2;

  const collide = (k) => {
    const o = k * 3;
    let x = p[o];
    let y = p[o + 1];
    let z = p[o + 2];
    for (const b of boxes) {
      const dx = x - b.cx;
      const dy = y - b.cy;
      const dz = z - b.cz;
      const ox = b.hx + 0.06 - Math.abs(dx);
      const oy = b.hy + 0.06 - Math.abs(dy);
      const oz = b.hz + 0.06 - Math.abs(dz);
      if (ox > 0 && oy > 0 && oz > 0) {
        // out through the nearest face (never down through the floor)
        if (oy <= ox && oy <= oz && dy > -b.hy * 0.5) y = b.cy + b.hy + 0.06;
        else if (ox <= oz) x = b.cx + Math.sign(dx || 1) * (b.hx + 0.06);
        else z = b.cz + Math.sign(dz || 1) * (b.hz + 0.06);
      }
    }
    for (const c of posts) {
      if (y > c.top + 0.05) continue;
      const dx = x - c.lx;
      const dz = z - c.lz;
      const d = Math.hypot(dx, dz);
      const r = c.r + 0.05;
      if (d < r && d > 1e-6) {
        x = c.lx + (dx / d) * r;
        z = c.lz + (dz / d) * r;
      }
    }
    const gy = groundCache[k] + 0.05;
    if (y < gy) y = gy;
    p[o] = x;
    p[o + 1] = y;
    p[o + 2] = z;
  };

  for (let step = 0; step < steps; step++) {
    const t = Math.min(1, step / (steps * 0.55)); // pins travel to their places first
    if (step % 10 === 0) for (let k = 0; k < n; k++) groundCache[k] = ground(p[k * 3], p[k * 3 + 2]);
    for (let k = 0; k < n; k++) {
      if (cut[k]) continue;
      const o = k * 3;
      if (pinned[k] >= 0) {
        const a = pinFrom[pinned[k]];
        const b = pinTo[pinned[k]];
        const e = t * t * (3 - 2 * t);
        prev[o] = p[o];
        prev[o + 1] = p[o + 1];
        prev[o + 2] = p[o + 2];
        p[o] = a[0] + (b[0] - a[0]) * e;
        p[o + 1] = a[1] + (b[1] - a[1]) * e;
        p[o + 2] = a[2] + (b[2] - a[2]) * e;
        continue;
      }
      for (let c = 0; c < 3; c++) {
        const v = (p[o + c] - prev[o + c]) * 0.96;
        prev[o + c] = p[o + c];
        p[o + c] += v + (c === 1 ? g * 6 : 0);
      }
    }
    for (let it = 0; it < 3; it++) {
      const count = it === 0 ? nLinks : nMain; // bend links (at the end) once per step
      for (let q = 0; q < count; q++) {
        const a = LA[q];
        const b = LB[q];
        const dx = p[b] - p[a];
        const dy = p[b + 1] - p[a + 1];
        const dz = p[b + 2] - p[a + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        if (q >= nMain && d < LR[q]) continue; // bend links only resist stretching
        const diff = ((d - LR[q]) / d) * LS[q];
        const fa = diff * FA[q];
        const fb = diff * FB[q];
        p[a] += dx * fa;
        p[a + 1] += dy * fa;
        p[a + 2] += dz * fa;
        p[b] -= dx * fb;
        p[b + 1] -= dy * fb;
        p[b + 2] -= dz * fb;
      }
      // collisions on the last iteration of each step (and every other one late on, to settle)
      if (it === 2 || (step > steps * 0.7 && it === 0)) for (let k = 0; k < n; k++) if (!cut[k] && pinned[k] < 0) collide(k);
    }
  }
  return { points: p, cut, nx, nz, spacing: s };
}

// Mesh + collision triangles (world space) for a draped net. toWorld(lx, ly, lz) -> [x, y, z]
export function netGeometry(net, toWorld) {
  const { points, cut, nx, nz, spacing } = net;
  const idx = (i, j) => j * nx + i;
  const pos = new Float32Array(nx * nz * 3);
  const uv = new Float32Array(nx * nz * 2);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const k = idx(i, j);
      const w = toWorld(points[k * 3], points[k * 3 + 1], points[k * 3 + 2]);
      pos.set(w, k * 3);
      uv[k * 2] = (i * spacing) / NET_TILE;
      uv[k * 2 + 1] = (j * spacing) / NET_TILE;
    }
  }
  const index = [];
  const tris = [];
  const tri = (a, b, c) => {
    index.push(a, b, c);
    for (const v of [a, b, c]) tris.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
  };
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = idx(i, j);
      const b = idx(i + 1, j);
      const c = idx(i, j + 1);
      const d = idx(i + 1, j + 1);
      if (!cut[a] && !cut[b] && !cut[c]) tri(a, c, b);
      if (!cut[b] && !cut[c] && !cut[d]) tri(b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return { geo, tris: Float32Array.from(tris) };
}
