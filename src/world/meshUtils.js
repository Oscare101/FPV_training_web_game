import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();

// parts: [{ geo, color, pos: [x,y,z], rotY?, rotX?, rotZ? }] -> one vertex-colored, flat-shaded geometry
export function mergeParts(parts) {
  const geos = parts.map(({ geo, color, pos = [0, 0, 0], rotX = 0, rotY = 0, rotZ = 0 }) => {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.deleteAttribute('uv');
    g.applyMatrix4(_m.compose(_p.fromArray(pos), _q.setFromEuler(_e.set(rotX, rotY, rotZ, 'YXZ')), _s));
    _c.setHex(color);
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([_c.r, _c.g, _c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.clearGroups();
    return g;
  });
  const merged = mergeGeometries(geos, false);
  merged.computeVertexNormals();
  return merged;
}

// Textured parts (part.tex = a SURFACES name): like mergeParts, plus uvs in metres projected along
// each triangle's main axis in the part's building frame (uvYaw), so bricks run level and
// continue across the pieces of one building. Colour tints the texture.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _n = new THREE.Vector3();
export function mergeTextured(parts, tile) {
  const geos = parts.map(({ geo, color, pos = [0, 0, 0], rotX = 0, rotY = 0, rotZ = 0, uvYaw = rotY }) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(_m.compose(_p.fromArray(pos), _q.setFromEuler(_e.set(rotX, rotY, rotZ, 'YXZ')), _s));
    const p = g.attributes.position;
    const n = p.count;
    const uv = new Float32Array(n * 2);
    const c = Math.cos(-uvYaw);
    const s = Math.sin(-uvYaw);
    const local = (i, out) => out.set(p.getX(i) * c + p.getZ(i) * s, p.getY(i), -p.getX(i) * s + p.getZ(i) * c);
    const q = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let t = 0; t < n; t += 3) {
      for (let k = 0; k < 3; k++) local(t + k, q[k]);
      _n.crossVectors(_a.subVectors(q[1], q[0]), _b.subVectors(q[2], q[0]));
      const ax = Math.abs(_n.x);
      const ay = Math.abs(_n.y);
      const az = Math.abs(_n.z);
      for (let k = 0; k < 3; k++) {
        const v = q[k];
        const [u, w] = ay >= ax && ay >= az ? [v.x, v.z] : ax >= az ? [v.z, v.y] : [v.x, v.y];
        uv[(t + k) * 2] = u / tile[0];
        uv[(t + k) * 2 + 1] = w / tile[1];
      }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    _c.setHex(color);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([_c.r, _c.g, _c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    for (const k of Object.keys(g.attributes)) if (!['position', 'uv', 'color', 'normal'].includes(k)) g.deleteAttribute(k);
    g.clearGroups();
    return g;
  });
  const merged = mergeGeometries(geos, false);
  merged.computeVertexNormals();
  return merged;
}

export const flatMaterial = () => new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

// Triangular roof prism along Z: width w (X), height h, length l
export function roofGeometry(w, h, l) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  return new THREE.ExtrudeGeometry(shape, { depth: l, bevelEnabled: false }).translate(0, 0, -l / 2);
}
