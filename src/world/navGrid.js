// Drivability grid for ground vehicles (4 m cells) and an A* planner on it.
// Built once per map from the static colliders (trunks, buildings, fences, logs, wrecks), water,
// slopes and roads; planning is CPU-only and rare (a new destination), with a per-frame budget.

import { isSolidForVehicles } from './colliders.js';

const CELL = 4;
const CLEARANCE = 2.2; // m from a solid collider to the cell centre (about half a vehicle width + margin)
const MAX_SLOPE = 2.4; // m height change over 4 m (~31°)
const COST = { road: 1, open: 1.5 };
const MAX_EXPAND = 9000;
const H_WEIGHT = 1.8; // weighted A*: slightly longer paths, far fewer expansions
const BODY = 1.9; // m, half width kept clear of solid colliders along smoothed segments
const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

export function createNavGrid(layout, colliders) {
  const { size, half, heightAt } = layout;
  const n = Math.ceil(size / CELL);
  const cost = new Float32Array(n * n); // 0 = blocked
  const cx = (i) => -half + (i + 0.5) * CELL;
  const cellOf = (v) => Math.max(0, Math.min(n - 1, Math.floor((v + half) / CELL)));
  const probe = { x: 0, y: 0, z: 0 };

  // roads / tracks are cheap
  const road = new Uint8Array(n * n);
  for (const pts of Object.values(layout.routes)) {
    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1];
      const [x1, z1] = pts[i];
      const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2);
      for (let k = 0; k <= steps; k++) road[cellOf(z0 + ((z1 - z0) * k) / steps) * n + cellOf(x0 + ((x1 - x0) * k) / steps)] = 1;
    }
  }
  const edge = half - 60;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = cx(ix);
      const z = cx(iz);
      const i = iz * n + ix;
      if (Math.abs(x) > edge || Math.abs(z) > edge) continue;
      const h = heightAt(x, z);
      const w = layout.waterAt?.(x, z) ?? null;
      if (w !== null && !layout.water?.frozen && w - h > 0.5) continue; // deeper than a ford
      const slope = Math.max(Math.abs(heightAt(x + 2, z) - heightAt(x - 2, z)), Math.abs(heightAt(x, z + 2) - heightAt(x, z - 2)));
      if (slope > MAX_SLOPE) continue;
      probe.x = x;
      probe.y = h + 0.8;
      probe.z = z;
      if (colliders.hits(probe, CLEARANCE, isSolidForVehicles)) continue;
      cost[i] = road[i] ? COST.road : COST.open;
    }
  }

  // Connected regions (4-neighbour flood fill): unreachable goals are rejected without searching
  const region = new Int32Array(n * n);
  {
    const stack = new Int32Array(n * n);
    let label = 0;
    for (let i0 = 0; i0 < n * n; i0++) {
      if (!cost[i0] || region[i0]) continue;
      label++;
      let top = 0;
      stack[top++] = i0;
      region[i0] = label;
      while (top) {
        const i = stack[--top];
        const ix = i % n;
        for (const j of [ix > 0 ? i - 1 : -1, ix < n - 1 ? i + 1 : -1, i - n, i + n]) {
          if (j < 0 || j >= n * n || !cost[j] || region[j]) continue;
          region[j] = label;
          stack[top++] = j;
        }
      }
    }
  }

  const free = (ix, iz) => ix >= 0 && iz >= 0 && ix < n && iz < n && cost[iz * n + ix] > 0;
  const freeAt = (x, z) => free(cellOf(x), cellOf(z));

  // nearest free cell within r cells (optionally in a given region), or -1
  function nearestFree(x, z, r, inRegion = 0) {
    const ix0 = cellOf(x);
    const iz0 = cellOf(z);
    let best = -1;
    let bestD = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (!free(ix0 + dx, iz0 + dz)) continue;
        if (inRegion && region[(iz0 + dz) * n + ix0 + dx] !== inRegion) continue;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = (iz0 + dz) * n + ix0 + dx;
        }
      }
    }
    return best;
  }

  // straight segment stays on free cells and a body width away from trunks/walls (exact colliders)
  function lineFree(x0, z0, x1, z1, r = BODY) {
    const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 1.5);
    for (let k = 1; k < steps; k++) {
      const x = x0 + ((x1 - x0) * k) / steps;
      const z = z0 + ((z1 - z0) * k) / steps;
      if (!freeAt(x, z)) return false;
      probe.x = x;
      probe.y = heightAt(x, z) + 0.8;
      probe.z = z;
      if (colliders.hits(probe, r, isSolidForVehicles)) return false;
    }
    return true;
  }

  // A* scratch, reused between plans (visit stamps avoid clearing)
  const g = new Float32Array(n * n);
  const came = new Int32Array(n * n);
  const stamp = new Uint32Array(n * n);
  const closed = new Uint32Array(n * n);
  let gen = 0;
  let heapF = new Float32Array(4096);
  let heapI = new Int32Array(4096);
  let heapN = 0;
  const push = (f, i) => {
    if (heapN === heapF.length) {
      const f2 = new Float32Array(heapN * 2);
      const i2 = new Int32Array(heapN * 2);
      f2.set(heapF);
      i2.set(heapI);
      heapF = f2;
      heapI = i2;
    }
    let k = heapN++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heapF[p] <= f) break;
      heapF[k] = heapF[p];
      heapI[k] = heapI[p];
      k = p;
    }
    heapF[k] = f;
    heapI[k] = i;
  };
  const pop = () => {
    const top = heapI[0];
    const f = heapF[--heapN];
    const i = heapI[heapN];
    let k = 0;
    for (;;) {
      let c = 2 * k + 1;
      if (c >= heapN) break;
      if (c + 1 < heapN && heapF[c + 1] < heapF[c]) c++;
      if (heapF[c] >= f) break;
      heapF[k] = heapF[c];
      heapI[k] = heapI[c];
      k = c;
    }
    heapF[k] = f;
    heapI[k] = i;
    return top;
  };

  // First cell to drive to: reachable in a clear straight line from where the vehicle stands
  // (it may be parked tight against brush), preferably ahead of it and towards the goal
  function startCell(x0, z0, yaw, x1, z1) {
    const ix0 = cellOf(x0);
    const iz0 = cellOf(z0);
    const cands = [];
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (!free(ix0 + dx, iz0 + dz)) continue;
        const x = cx(ix0 + dx);
        const z = cx(iz0 + dz);
        const dist = Math.hypot(x - x0, z - z0);
        const ahead = dist < 0.5 ? 1 : (-(x - x0) * Math.sin(yaw) - (z - z0) * Math.cos(yaw)) / dist;
        cands.push([dist + (ahead < -0.2 ? 6 : 0) + Math.hypot(x1 - x, z1 - z) * 0.05, (iz0 + dz) * n + ix0 + dx, x, z]);
      }
    }
    cands.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < Math.min(6, cands.length); k++) if (lineFree(x0, z0, cands[k][2], cands[k][3], 1.3)) return cands[k][1];
    return cands.length ? cands[0][1] : -1;
  }

  // World path [[x, z], ...] from (x0, z0) to near (x1, z1), smoothed; null if unreachable.
  // yaw: the vehicle's heading (prefers starting ahead of it)
  function plan(x0, z0, x1, z1, yaw = 0) {
    const start = startCell(x0, z0, yaw, x1, z1);
    if (start < 0) return null;
    const goal = nearestFree(x1, z1, 4, region[start]);
    if (goal < 0) return null;
    gen++;
    heapN = 0;
    const gx = goal % n;
    const gz = (goal / n) | 0;
    const hfun = (i) => {
      const dx = Math.abs((i % n) - gx);
      const dz = Math.abs(((i / n) | 0) - gz);
      return (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)) * COST.road * H_WEIGHT;
    };
    g[start] = 0;
    stamp[start] = gen;
    came[start] = -1;
    push(hfun(start), start);
    let found = false;
    let expanded = 0;
    while (heapN > 0 && expanded < MAX_EXPAND) {
      const cur = pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      if (cur === goal) {
        found = true;
        break;
      }
      expanded++;
      const ix = cur % n;
      const iz = (cur / n) | 0;
      for (const [dx, dz, len] of NB) {
        const jx = ix + dx;
        const jz = iz + dz;
        if (!free(jx, jz)) continue;
        if (dx && dz && (!free(ix + dx, iz) || !free(ix, iz + dz))) continue; // no corner cutting
        const j = jz * n + jx;
        if (closed[j] === gen) continue;
        const ng = g[cur] + len * (cost[cur] + cost[j]) * 0.5;
        if (stamp[j] !== gen || ng < g[j]) {
          stamp[j] = gen;
          g[j] = ng;
          came[j] = cur;
          push(ng + hfun(j), j);
        }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let c = goal; c >= 0; c = came[c]) cells.push([cx(c % n), cx((c / n) | 0)]);
    cells.reverse();
    cells[0] = [x0, z0];
    // string pulling: skip waypoints while the straight line stays drivable
    const out = [cells[0]];
    let i = 0;
    while (i < cells.length - 1) {
      let j = Math.min(cells.length - 1, i + 14);
      while (j > i + 1 && !lineFree(cells[i][0], cells[i][1], cells[j][0], cells[j][1], i === 0 ? 1.3 : BODY)) j--;
      out.push(cells[j]);
      i = j;
    }
    return out;
  }

  return {
    plan,
    freeAt,
    isRoad: (x, z) => road[cellOf(z) * n + cellOf(x)] === 1 && freeAt(x, z),
    budget: 1, // plans allowed this frame (reset by the owner every frame)
  };
}
