import * as THREE from 'three';
import { mergeParts, flatMaterial } from './meshUtils.js';

// Low-poly 5" quad (scaled by prop size): carbon X frame, stack, battery with strap, FPV camera,
// motors, two-blade props that spin, VTX antenna; a strike charge under the frame when it carries
// a payload. Body frame like the physics: +X right, +Y up, -Z forward. Units: m at 5".

const M = 0.0795; // motor offset on each axis (225 mm diagonal wheelbase)
const MOTORS = [[1, -1], [-1, -1], [1, 1], [-1, 1]];
const CARBON = 0x1b1c1e;
const ANODIZED = 0xb3242a;

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r0, r1, h, seg = 10) => new THREE.CylinderGeometry(r0, r1, h, seg);

function bodyParts() {
  const p = [
    { geo: box(0.1, 0.004, 0.062), color: CARBON, pos: [0, 0, 0] }, // bottom plate
    { geo: box(0.07, 0.003, 0.05), color: CARBON, pos: [0, 0.03, 0] }, // top plate
    { geo: box(0.034, 0.014, 0.034), color: 0x1d4a2c, pos: [0, 0.012, 0.004] }, // FC / ESC stack
    { geo: box(0.026, 0.002, 0.026), color: 0x111111, pos: [0, 0.0205, 0.004] },
    // battery on top with label band and strap
    { geo: box(0.036, 0.032, 0.074), color: 0x1f1f20, pos: [0, 0.0475, 0.006] },
    { geo: box(0.0365, 0.016, 0.05), color: 0xd9a21c, pos: [0, 0.0475, 0.006] },
    { geo: box(0.04, 0.036, 0.012), color: ANODIZED, pos: [0, 0.047, -0.008] },
    // camera cage + orange camera, tilted up, black lens
    { geo: box(0.003, 0.026, 0.026), color: CARBON, pos: [0.013, 0.016, -0.04] },
    { geo: box(0.003, 0.026, 0.026), color: CARBON, pos: [-0.013, 0.016, -0.04] },
    { geo: box(0.02, 0.02, 0.02), color: 0xd2561d, pos: [0, 0.016, -0.04], rotX: 0.52 },
    { geo: cyl(0.0075, 0.0075, 0.012, 12), color: 0x0b0b0c, pos: [0, 0.022, -0.052], rotX: Math.PI / 2 + 0.52 },
    // VTX antenna out the back
    { geo: cyl(0.0018, 0.0018, 0.07, 5), color: 0x151515, pos: [0, 0.055, 0.052], rotX: 0.75 },
    { geo: cyl(0.007, 0.007, 0.014, 8), color: 0x111111, pos: [0, 0.08, 0.075], rotX: 0.75 },
  ];
  for (const [sx, sz] of MOTORS) {
    // arm, standoff, motor (stator + silver bell + coloured top + nut)
    const a = Math.atan2(sx, sz);
    p.push({ geo: box(0.022, 0.005, 0.105), color: CARBON, pos: [sx * M * 0.55, -0.001, sz * M * 0.55], rotY: a });
    p.push({ geo: cyl(0.003, 0.003, 0.028, 6), color: ANODIZED, pos: [sx * 0.028, 0.015, sz * 0.022] });
    p.push({ geo: cyl(0.0145, 0.0145, 0.006), color: 0x26272a, pos: [sx * M, 0.005, sz * M] });
    p.push({ geo: cyl(0.0135, 0.014, 0.013, 12), color: 0xb9bdc2, pos: [sx * M, 0.0145, sz * M] });
    p.push({ geo: cyl(0.0125, 0.0135, 0.003, 12), color: ANODIZED, pos: [sx * M, 0.0225, sz * M] });
    p.push({ geo: cyl(0.004, 0.004, 0.007, 6), color: 0xd0d0d0, pos: [sx * M, 0.026, sz * M] });
  }
  return p;
}

// Strike charge strapped under the frame: warhead body, nose cone, straps
function payloadParts() {
  return [
    { geo: cyl(0.032, 0.032, 0.15, 12), color: 0x4b5137, pos: [0, -0.04, -0.01], rotX: Math.PI / 2 },
    { geo: cyl(0.004, 0.032, 0.07, 12), color: 0x434832, pos: [0, -0.04, -0.12], rotX: -Math.PI / 2 },
    { geo: cyl(0.024, 0.03, 0.03, 10), color: 0x2c2f24, pos: [0, -0.04, 0.08], rotX: Math.PI / 2 },
    { geo: box(0.07, 0.006, 0.012), color: 0x111111, pos: [0, -0.012, -0.03] },
    { geo: box(0.07, 0.006, 0.012), color: 0x111111, pos: [0, -0.012, 0.03] },
  ];
}

export function createDroneModel() {
  const group = new THREE.Group();
  const material = flatMaterial();
  group.add(new THREE.Mesh(mergeParts(bodyParts()), material));
  const payload = new THREE.Mesh(mergeParts(payloadParts()), material);
  group.add(payload);

  // props: 2 blades each, spun about the motor axis; a faint disc shows the blur when spinning
  const bladeGeo = new THREE.BoxGeometry(0.06, 0.0016, 0.011).translate(0.032, 0, 0);
  const bladeMat = new THREE.MeshLambertMaterial({ color: 0xe8661f, transparent: true, opacity: 0.9 });
  const discMat = new THREE.MeshBasicMaterial({ color: 0x8a5a3a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const discGeo = new THREE.CircleGeometry(0.0635, 20).rotateX(-Math.PI / 2);
  const props = MOTORS.map(([sx, sz], i) => {
    const prop = new THREE.Group();
    prop.position.set(sx * M, 0.03, sz * M);
    for (const a of [0, Math.PI]) {
      const blade = new THREE.Mesh(bladeGeo, bladeMat);
      blade.rotation.set((i % 2 ? -1 : 1) * 0.25, a, 0, 'YXZ'); // blade pitch
      prop.add(blade);
    }
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.copy(prop.position);
    group.add(prop, disc);
    return { prop, dir: (sx * sz > 0 ? 1 : -1) };
  });
  group.visible = false;

  return {
    group,
    // spin 0..1 (motor output), payload: show the strike charge
    update(dt, spin, hasPayload) {
      payload.visible = hasPayload;
      const rate = spin > 0 ? 35 + spin * 40 : 0; // rad/s shown (strobing like a camera sees it)
      for (const p of props) p.prop.rotation.y += p.dir * rate * dt;
      bladeMat.opacity = spin > 0 ? 0.55 : 0.95;
      discMat.opacity = spin > 0 ? 0.16 : 0;
    },
    dispose() {
      group.traverse((o) => o.geometry?.dispose());
      material.dispose();
      bladeMat.dispose();
      discMat.dispose();
    },
  };
}
