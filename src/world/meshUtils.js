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
