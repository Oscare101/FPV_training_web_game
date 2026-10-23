import * as THREE from 'three';

// Detailed low-poly vehicle models built from shaped extrusions, lathes and cylinders.
// Local frame: nose toward -Z, ground at y=0, +X right. Each model returns:
//   size: [w, h, l]  main box for hit-zone mapping and placement
//   parts: mergeParts() list for the body; turret: separate list (blown off on wrecks)
//   colliders: [{ c: [x,y,z], h: [hx,hy,hz], zone?: [name, effect], group? }] boxes matching the visible parts
// Parts/colliders may carry a `group` (e.g. 'canopy', 'trackL', 'wheel') so wrecks can lose them.

const C = {
  olive: 0x4b5137,
  oliveDark: 0x3e4430,
  oliveLight: 0x585e42,
  rubber: 0x1b1b19,
  steel: 0x3b3e37,
  track: 0x2b2a26,
  glass: 0x1a2328,
  lamp: 0xc9c5a2,
  canvas: 0x5d5e40,
  wood: 0x6a5838,
  crate: 0x4a5532,
  crateDark: 0x39422a,
};
const PI = Math.PI;

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cylX = (r, len, seg = 12) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(PI / 2); // axis along X
const cylZ = (r, len, seg = 12) => new THREE.CylinderGeometry(r, r, len, seg).rotateX(PI / 2); // axis along Z
const cylY = (rt, rb, h, seg = 12) => new THREE.CylinderGeometry(rt, rb, h, seg);

// Side profile [[L, y], ...] (L = local z, negative = front) extruded across the width
function side(profile, width, bevel = 0.03) {
  const shape = new THREE.Shape(profile.map(([L, y]) => new THREE.Vector2(-L, y)));
  const depth = Math.max(0.01, width - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 6,
  });
  g.translate(0, 0, -depth / 2);
  g.rotateY(PI / 2); // shape x (= -L) -> z = L, extrusion -> x
  return g;
}

// Cross-section [[x, y], ...] extruded along the length, centred on z = 0
function section(profile, length, bevel = 0.03) {
  const shape = new THREE.Shape(profile.map(([x, y]) => new THREE.Vector2(x, y)));
  const depth = Math.max(0.01, length - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1,
  });
  return g.translate(0, 0, -depth / 2);
}

// Track belt seen from the side: rounded loop with a hole, extruded across its width
function trackLoop(L0, L1, y0, y1, r, width, t = 0.09) {
  const loop = (a0, a1, b0, b1, rr) => {
    const s = new THREE.Shape();
    const x0 = -a1;
    const x1 = -a0;
    s.moveTo(x0 + rr, b0);
    s.lineTo(x1 - rr, b0);
    s.absarc(x1 - rr, b0 + rr, rr, -PI / 2, 0, false);
    s.lineTo(x1, b1 - rr);
    s.absarc(x1 - rr, b1 - rr, rr, 0, PI / 2, false);
    s.lineTo(x0 + rr, b1);
    s.absarc(x0 + rr, b1 - rr, rr, PI / 2, PI, false);
    s.lineTo(x0, b0 + rr);
    s.absarc(x0 + rr, b0 + rr, rr, PI, PI * 1.5, false);
    return s;
  };
  const outer = loop(L0, L1, y0, y1, r);
  outer.holes.push(loop(L0 + t, L1 - t, y0 + t, y1 - t, r - t));
  const g = new THREE.ExtrudeGeometry(outer, { depth: width, bevelEnabled: false, curveSegments: 5 });
  g.translate(0, 0, -width / 2);
  return g.rotateY(PI / 2);
}

// Wheel: tyre + hub on both sides, axis along X. Each wheel gets its own id so wrecks can lose single wheels.
let wheelId = 0;
function wheel(r, w, hubColor, pos, seg = 14, group = 'wheel') {
  const id = `${group}${wheelId++}`;
  return [
    { geo: cylX(r, w, seg), color: C.rubber, pos, group, id },
    { geo: cylX(r * 0.58, w + 0.04, 10), color: hubColor, pos, group, id },
    { geo: cylX(r * 0.2, w + 0.08, 6), color: C.steel, pos, group, id },
  ];
}

const lathe = (pts, seg = 16) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);

// ---------------------------------------------------------------- MBT
function tank() {
  const parts = [];
  parts.push({ geo: side([[-3.3, 0.45], [-3.5, 0.8], [-2.25, 1.32], [3.3, 1.32], [3.38, 0.55], [3.0, 0.42]], 2.25), color: C.olive });
  // reactive armour bricks on the glacis (game-level detail, they shape the silhouette)
  for (let row = 0; row < 3; row++) {
    for (let col = -3; col <= 3; col++) {
      const L = -3.25 + row * 0.38;
      parts.push({ geo: box(0.3, 0.07, 0.3), color: C.oliveDark, pos: [col * 0.31, 0.92 + row * 0.165, L], rotX: -0.41 });
    }
  }
  for (const s of [-1, 1]) {
    parts.push({ geo: box(0.62, 0.06, 6.95), color: C.oliveDark, pos: [s * 1.42, 1.3, 0] }); // track guard
    parts.push({ geo: box(0.05, 0.34, 5.3), color: C.oliveDark, pos: [s * 1.74, 1.12, 0.35], group: 'skirt' }); // side skirt
    parts.push({ geo: trackLoop(-3.28, 3.22, 0.04, 0.98, 0.42, 0.56), color: C.track, pos: [s * 1.42, 0, 0], group: s < 0 ? 'trackL' : 'trackR' });
    for (let k = 0; k < 6; k++) parts.push(...wheel(0.36, 0.44, C.oliveDark, [s * 1.42, 0.42, -2.35 + k * 0.94]));
    parts.push(...wheel(0.3, 0.46, C.steel, [s * 1.42, 0.6, 2.95], 10)); // sprocket
    parts.push(...wheel(0.28, 0.46, C.steel, [s * 1.42, 0.62, -2.95], 10)); // idler
    parts.push({ geo: box(0.5, 0.34, 1.1), color: C.oliveLight, pos: [s * 1.45, 1.5, 1.7], group: 'stowage' }); // stowage
    parts.push({ geo: cylZ(0.09, 0.12, 8), color: C.lamp, pos: [s * 1.05, 1.42, -2.42] }); // headlight
  }
  for (const x of [-0.55, 0.55]) parts.push({ geo: cylX(0.27, 0.95), color: C.oliveDark, pos: [x, 1.6, 3.25], group: 'drums' }); // rear drums
  parts.push({ geo: box(0.9, 0.08, 0.5), color: C.rubber, pos: [-0.75, 1.34, 2.5] }); // engine grille

  const turret = [];
  turret.push({ geo: lathe([[0, 0], [1.18, 0], [1.24, 0.12], [1.12, 0.45], [0.75, 0.7], [0, 0.78]]).scale(1, 1, 1.12), color: C.olive, pos: [0, 1.32, 0.35] });
  turret.push({ geo: box(0.62, 0.38, 0.45), color: C.oliveDark, pos: [0, 1.66, -0.95] }); // mantlet
  turret.push({ geo: cylZ(0.085, 4.6, 10), color: C.oliveDark, pos: [0, 1.7, -3.3] }); // gun
  turret.push({ geo: cylZ(0.14, 0.6, 10), color: C.oliveDark, pos: [0, 1.7, -2.6] }); // fume extractor
  turret.push({ geo: cylZ(0.11, 0.22, 10), color: C.steel, pos: [0, 1.7, -5.5] }); // muzzle
  turret.push({ geo: cylY(0.33, 0.37, 0.22, 12), color: C.oliveDark, pos: [0.42, 2.18, 0.55] }); // cupola
  turret.push({ geo: cylY(0.28, 0.3, 0.06, 10), color: C.oliveLight, pos: [0.42, 2.32, 0.55] });
  turret.push({ geo: cylY(0.27, 0.29, 0.07, 10), color: C.oliveLight, pos: [-0.45, 2.12, 0.6] }); // gunner hatch
  turret.push({ geo: cylZ(0.035, 1.1, 6), color: C.steel, pos: [0.42, 2.42, 0.2] }); // roof MG
  turret.push({ geo: cylX(0.1, 1.5, 8), color: C.oliveDark, pos: [0, 1.88, 1.55] }); // snorkel
  turret.push({ geo: box(1.7, 0.34, 0.36), color: C.oliveLight, pos: [0, 1.62, 1.7] }); // rear stowage
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) turret.push({ geo: box(0.32, 0.3, 0.12), color: C.oliveDark, pos: [s * (0.5 + k * 0.28), 1.75, -0.78 + k * 0.17], rotY: s * (0.35 + k * 0.2) });
    turret.push({ geo: cylZ(0.05, 0.12, 6), color: C.rubber, pos: [s * 1.05, 1.72, -0.4] }); // smoke dischargers
  }
  return {
    size: [3.5, 2.3, 7.0],
    parts,
    turret,
    colliders: [
      { c: [0, 0.7, 0.03], h: [1.76, 0.68, 3.45] },
      { c: [0, 1.75, 0.35], h: [1.25, 0.45, 1.4], group: 'turret' },
      { c: [0, 1.7, -4.05], h: [0.13, 0.13, 1.6], zone: ['Gun barrel', 'damaged'], group: 'turret' },
    ],
  };
}

// ---------------------------------------------------------------- IFV (tracked)
function ifv() {
  const parts = [];
  parts.push({ geo: side([[-3.35, 0.48], [-3.5, 0.62], [-1.85, 1.5], [-1.55, 1.72], [3.2, 1.72], [3.3, 0.48]], 2.36), color: C.olive });
  for (let k = 0; k < 5; k++) parts.push({ geo: box(2.2, 0.04, 0.06), color: C.oliveDark, pos: [0, 0.78 + k * 0.17, -3.2 + k * 0.32], rotX: -0.48 }); // ribbed nose
  for (const s of [-1, 1]) {
    parts.push({ geo: trackLoop(-3.15, 3.15, 0.04, 0.8, 0.36, 0.44), color: C.track, pos: [s * 1.4, 0, 0], group: s < 0 ? 'trackL' : 'trackR' });
    for (let k = 0; k < 6; k++) parts.push(...wheel(0.32, 0.36, C.oliveDark, [s * 1.4, 0.38, -2.45 + k * 0.98]));
    parts.push(...wheel(0.26, 0.38, C.steel, [s * 1.4, 0.55, -2.95], 10));
    parts.push({ geo: box(0.48, 0.05, 6.3), color: C.oliveDark, pos: [s * 1.42, 0.83, 0.05] });
    parts.push({ geo: box(0.06, 0.3, 0.6), color: C.rubber, pos: [s * 1.2, 1.25, 1.6] }); // side hatch outline
  }
  for (const x of [-0.5, 0.5]) parts.push({ geo: box(0.62, 0.85, 0.1), color: C.oliveDark, pos: [x, 1.08, 3.3], group: 'doors' }); // rear doors
  for (let k = 0; k < 4; k++) parts.push({ geo: box(0.5, 0.05, 0.62), color: C.oliveLight, pos: [k % 2 ? 0.45 : -0.45, 1.76, 1.1 + Math.floor(k / 2) * 0.9] }); // roof hatches
  for (const s of [-1, 1]) parts.push({ geo: cylZ(0.07, 0.1, 8), color: C.lamp, pos: [s * 0.95, 1.2, -2.7] });

  const turret = [];
  turret.push({ geo: cylY(0.58, 0.86, 0.44, 12), color: C.olive, pos: [0, 1.94, -0.25] });
  turret.push({ geo: cylY(0.24, 0.26, 0.1, 10), color: C.oliveLight, pos: [0.3, 2.21, -0.1] });
  turret.push({ geo: box(0.3, 0.26, 0.3), color: C.oliveDark, pos: [0, 2.0, -0.95] });
  turret.push({ geo: cylZ(0.045, 2.5, 8), color: C.oliveDark, pos: [0, 2.02, -2.3] }); // autocannon
  turret.push({ geo: cylZ(0.07, 0.4, 8), color: C.oliveDark, pos: [0, 2.02, -1.25] });
  turret.push({ geo: cylZ(0.075, 1.15, 10), color: C.oliveLight, pos: [-0.35, 2.32, -0.35] }); // missile tube
  return {
    size: [2.9, 2.3, 6.9],
    parts,
    turret,
    colliders: [
      { c: [0, 0.95, 0], h: [1.45, 0.85, 3.4] },
      { c: [0, 2.0, -0.25], h: [0.86, 0.3, 0.86], group: 'turret' },
      { c: [0, 2.02, -2.4], h: [0.07, 0.07, 1.25], zone: ['Cannon', 'damaged'], group: 'turret' },
    ],
  };
}

// ---------------------------------------------------------------- APC (8x8 wheeled)
function apc() {
  const parts = [];
  parts.push({ geo: section([[-1.2, 0.6], [1.2, 0.6], [1.45, 1.28], [1.08, 2.02], [-1.08, 2.02], [-1.45, 1.28]], 5.5), color: C.olive, pos: [0, 0, 0.45] });
  parts.push({ geo: side([[-2.3, 0.6], [-3.3, 0.72], [-3.75, 1.12], [-2.3, 2.02]], 2.3), color: C.olive }); // nose wedge
  parts.push({ geo: box(2.0, 0.55, 0.05), color: C.oliveDark, pos: [0, 1.25, -3.43], rotX: -0.75, group: 'vane' }); // trim vane
  for (const s of [-1, 1]) {
    for (const L of [-2.35, -1.1, 0.75, 2.0]) parts.push(...wheel(0.56, 0.42, C.oliveDark, [s * 1.33, 0.56, L], 16));
    parts.push({ geo: box(0.05, 0.72, 0.82), color: C.rubber, pos: [s * 1.47, 1.32, -0.18] }); // side door
    parts.push({ geo: box(0.3, 0.25, 0.5), color: C.oliveDark, pos: [s * 1.25, 1.95, 2.6] }); // exhaust box
    parts.push({ geo: cylZ(0.07, 0.1, 8), color: C.lamp, pos: [s * 0.75, 1.6, -3.0] });
    for (let k = 0; k < 3; k++) parts.push({ geo: box(0.14, 0.08, 0.1), color: C.glass, pos: [s * 0.95, 2.05, -1.9 + k * 0.4] }); // periscopes
  }
  for (const x of [-0.45, 0.45]) parts.push({ geo: box(0.55, 0.05, 0.7), color: C.oliveLight, pos: [x, 2.05, -1.95] }); // driver hatches
  const turret = [];
  turret.push({ geo: cylY(0.5, 0.7, 0.46, 12), color: C.olive, pos: [0, 2.25, -0.95] });
  turret.push({ geo: cylZ(0.055, 2.1, 8), color: C.oliveDark, pos: [0, 2.32, -2.5] });
  turret.push({ geo: cylZ(0.035, 0.7, 6), color: C.oliveDark, pos: [0.2, 2.3, -1.75] });
  return {
    size: [2.95, 2.5, 7.5],
    parts,
    turret,
    colliders: [
      { c: [0, 1.32, 0.15], h: [1.48, 0.72, 3.55] },
      { c: [0, 0.56, 0], h: [1.55, 0.56, 2.95] },
      { c: [0, 2.28, -0.95], h: [0.7, 0.25, 0.7], group: 'turret' },
      { c: [0, 2.32, -2.55], h: [0.08, 0.08, 1.05], zone: ['Gun', 'damaged'], group: 'turret' },
    ],
  };
}

// ---------------------------------------------------------------- hooded 6x6 truck
function truck() {
  const parts = [];
  for (const x of [-0.45, 0.45]) parts.push({ geo: box(0.12, 0.2, 7.0), color: C.rubber, pos: [x, 0.92, 0] }); // frame
  parts.push({ geo: side([[-3.6, 1.0], [-3.6, 1.62], [-3.45, 1.78], [-2.2, 1.86], [-2.2, 1.0]], 1.25, 0.05), color: C.olive }); // hood
  for (const s of [-1, 1]) {
    parts.push({ geo: side([[-3.85, 1.05], [-3.55, 1.42], [-2.6, 1.5], [-2.28, 1.22], [-2.28, 1.05]], 0.48, 0.03), color: C.oliveDark, pos: [s * 0.98, 0, 0] }); // fender
    parts.push({ geo: cylZ(0.11, 0.12, 10), color: C.lamp, pos: [s * 0.98, 1.47, -3.66] });
    parts.push({ geo: box(0.03, 0.42, 0.95), color: C.glass, pos: [s * 1.16, 2.22, -1.35], group: 'glass' }); // side window
    parts.push({ geo: box(0.04, 0.03, 0.3), color: C.rubber, pos: [s * 1.17, 1.75, -1.6] }); // door handle
    parts.push({ geo: box(0.06, 0.32, 0.18), color: C.rubber, pos: [s * 1.32, 2.15, -2.05] }); // mirror
    parts.push({ geo: box(0.06, 0.5, 4.1), color: C.oliveDark, pos: [s * 1.2, 1.67, 1.6] }); // bed side
    parts.push({ geo: box(0.04, 0.9, 4.1), color: C.canvas, pos: [s * 1.19, 2.37, 1.6], group: 'canopy' }); // canopy wall
  }
  parts.push({ geo: side([[-2.2, 1.0], [-2.2, 2.0], [-2.05, 2.62], [-0.6, 2.66], [-0.6, 1.0]], 2.3, 0.05), color: C.olive }); // cab
  for (const x of [-0.52, 0.52]) parts.push({ geo: box(0.95, 0.52, 0.04), color: C.glass, pos: [x, 2.3, -2.17], rotX: 0.24, group: 'glass' }); // windshield
  parts.push({ geo: box(1.0, 0.55, 0.05), color: C.rubber, pos: [0, 1.38, -3.63] }); // grille
  for (let k = -2; k <= 2; k++) parts.push({ geo: box(0.05, 0.55, 0.07), color: C.oliveDark, pos: [k * 0.2, 1.38, -3.66] });
  parts.push({ geo: box(2.35, 0.18, 0.2), color: C.oliveDark, pos: [0, 1.0, -3.9] }); // bumper
  parts.push({ geo: box(2.4, 0.14, 4.1), color: C.wood, pos: [0, 1.38, 1.6] }); // bed floor
  parts.push({ geo: box(2.4, 0.5, 0.06), color: C.oliveDark, pos: [0, 1.67, 3.66] }); // tailgate
  parts.push({ geo: new THREE.CylinderGeometry(1.2, 1.2, 4.1, 12, 1, false, PI / 2, PI).rotateX(PI / 2).scale(1, 0.55, 1), color: C.canvas, pos: [0, 2.82, 1.6], group: 'canopy' }); // canvas roof
  // canopy frame ribs under the canvas (exposed when the canvas burns away)
  for (let k = 0; k < 4; k++) {
    const z = 0.0 + k * 1.1;
    for (const sx of [-1, 1]) parts.push({ geo: box(0.06, 1.0, 0.06), color: C.steel, pos: [sx * 1.17, 2.32, z], group: 'ribs' });
    parts.push({ geo: new THREE.TorusGeometry(1.17, 0.035, 4, 10, PI).scale(1, 0.55, 1), color: C.steel, pos: [0, 2.82, z], group: 'ribs' });
  }
  for (const L of [-3.0]) for (const s of [-1, 1]) parts.push(...wheel(0.56, 0.4, C.oliveDark, [s * 1.0, 0.56, L], 16));
  for (const L of [1.35, 2.75]) for (const s of [-1, 1]) parts.push(...wheel(0.56, 0.46, C.oliveDark, [s * 1.0, 0.56, L], 16));
  parts.push({ geo: cylZ(0.26, 0.95, 12), color: C.oliveDark, pos: [1.0, 0.86, -1.3] }); // fuel tank
  parts.push({ geo: box(0.45, 0.4, 0.5), color: C.oliveDark, pos: [-1.0, 0.95, -1.3] }); // battery box
  parts.push(...wheel(0.5, 0.36, C.oliveDark, [0, 1.85, -0.42], 14, 'spare').map((p) => ({ ...p, rotY: PI / 2 }))); // spare
  return {
    size: [2.5, 3.5, 7.7],
    parts,
    turret: null,
    colliders: [
      { c: [0, 1.75, -2.25], h: [1.2, 0.95, 1.65] },
      { c: [0, 1.66, 1.6], h: [1.25, 0.36, 2.1] },
      { c: [0, 2.72, 1.6], h: [1.25, 0.75, 2.1], group: 'canopy' },
      { c: [0, 0.75, 0], h: [1.25, 0.6, 3.75] },
    ],
  };
}

// ---------------------------------------------------------------- 4x4 light utility vehicle
function car() {
  const parts = [];
  parts.push({ geo: side([[-2.05, 0.45], [-2.05, 0.95], [-1.95, 1.06], [-0.95, 1.12], [2.0, 1.1], [2.05, 0.45]], 1.72, 0.04), color: C.olive });
  parts.push({ geo: side([[-0.95, 1.1], [-0.68, 1.78], [1.92, 1.78], [2.0, 1.1]], 1.62, 0.04), color: C.olive }); // cabin
  parts.push({ geo: box(1.3, 0.45, 0.03), color: C.glass, pos: [0, 1.44, -0.83], rotX: 0.38, group: 'glass' }); // windshield
  parts.push({ geo: box(1.2, 0.38, 0.03), color: C.glass, pos: [0, 1.45, 1.99], group: 'glass' }); // rear window
  for (const s of [-1, 1]) {
    for (const L of [-0.3, 0.8]) parts.push({ geo: box(0.03, 0.38, 0.85), color: C.glass, pos: [s * 0.82, 1.45, L], group: 'glass' });
    for (const L of [-1.35, 1.25]) {
      parts.push(...wheel(0.38, 0.27, C.oliveDark, [s * 0.86, 0.38, L], 14));
      parts.push({ geo: box(0.3, 0.05, 0.95), color: C.oliveDark, pos: [s * 0.84, 0.88, L] }); // arch
    }
    parts.push({ geo: cylZ(0.09, 0.08, 10), color: C.lamp, pos: [s * 0.62, 0.92, -2.08] });
    parts.push({ geo: box(0.05, 0.16, 0.12), color: C.rubber, pos: [s * 0.92, 1.25, -0.85] }); // mirror
  }
  parts.push({ geo: box(0.7, 0.32, 0.04), color: C.rubber, pos: [0, 0.88, -2.08] }); // grille
  for (let k = -3; k <= 3; k++) parts.push({ geo: box(0.04, 0.32, 0.05), color: C.olive, pos: [k * 0.1, 0.88, -2.1] });
  parts.push({ geo: box(1.8, 0.14, 0.14), color: C.oliveDark, pos: [0, 0.6, -2.15] }); // bumper
  parts.push({ geo: box(1.8, 0.14, 0.14), color: C.oliveDark, pos: [0, 0.6, 2.12] });
  parts.push(...wheel(0.34, 0.24, C.oliveDark, [0, 1.05, 2.2], 14, 'spare').map((p) => ({ ...p, rotY: PI / 2 }))); // spare on tailgate
  return {
    size: [1.9, 1.85, 4.3],
    parts,
    turret: null,
    colliders: [
      { c: [0, 0.78, 0], h: [0.92, 0.42, 2.1] },
      { c: [0, 1.45, 0.5], h: [0.83, 0.34, 1.48] },
    ],
  };
}

// ---------------------------------------------------------------- ammo on pallets
function ammo() {
  const parts = [];
  for (const px of [-0.72, 0.72]) {
    parts.push({ geo: box(1.35, 0.12, 2.1), color: C.wood, pos: [px, 0.06, 0] }); // pallet
    for (let layer = 0; layer < 2; layer++) {
      for (let row = 0; row < 2; row++) {
        const y = 0.12 + 0.21 + layer * 0.43;
        const z = -0.5 + row * 1.0;
        parts.push({ geo: box(1.25, 0.42, 0.95), color: layer ? C.crate : C.crateDark, pos: [px, y, z] });
        parts.push({ geo: box(1.27, 0.04, 0.2), color: C.rubber, pos: [px, y + 0.12, z] }); // strap
        for (const e of [-1, 1]) parts.push({ geo: box(0.06, 0.06, 0.25), color: C.rubber, pos: [px + e * 0.64, y + 0.05, z] }); // handles
      }
    }
  }
  for (let k = 0; k < 3; k++) parts.push({ geo: box(0.42, 0.28, 1.6), color: C.crate, pos: [-0.5 + k * 0.5, 1.12, 0.05], rotY: 0.04 * (k - 1) }); // long crates
  return {
    size: [2.9, 1.3, 2.2],
    parts,
    turret: null,
    colliders: [{ c: [0, 0.6, 0], h: [1.42, 0.62, 1.08] }, { c: [0, 1.12, 0.05], h: [0.75, 0.15, 0.82] }],
  };
}

export const VEHICLE_MODELS = { tank, ifv, apc, truck, car, ammo };
