import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// River ribbons and lake surfaces at the layout's water levels. Liquid: Lambert (so it gets sun,
// cloud and drone shadows) plus ripples, sky reflection by Fresnel and a sun glint. Winter: ice.

const RIBBON_EXTRA = 4; // m past the river half-width, hidden under the banks
const LAKE_EXTRA = 6;

function riverGeometry(rv) {
  const pos = [];
  const idx = [];
  const hw = rv.width / 2 + RIBBON_EXTRA;
  rv.pts.forEach(([x, z], i) => {
    const [qx, qz] = rv.pts[Math.min(i + 1, rv.pts.length - 1)];
    const [px, pz] = rv.pts[Math.max(i - 1, 0)];
    const len = Math.hypot(qx - px, qz - pz) || 1;
    const nx = -(qz - pz) / len;
    const nz = (qx - px) / len;
    const y = rv.levels[i];
    pos.push(x + nx * hw, y, z + nz * hw, x - nx * hw, y, z - nz * hw);
    if (i) idx.push(2 * i - 2, 2 * i, 2 * i - 1, 2 * i - 1, 2 * i, 2 * i + 1);
  });
  // face up whichever way the river runs
  const tri = (k) => new THREE.Vector3(pos[idx[k] * 3], pos[idx[k] * 3 + 1], pos[idx[k] * 3 + 2]);
  if (idx.length && new THREE.Vector3().crossVectors(tri(1).sub(tri(0)), tri(2).sub(tri(0))).y < 0) {
    for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function lakeGeometry(l) {
  const pos = [l.x, l.level, l.z];
  const idx = [];
  const n = l.radii.length;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pos.push(l.x + Math.cos(a) * (l.radii[i] + LAKE_EXTRA), l.level, l.z + Math.sin(a) * (l.radii[i] + LAKE_EXTRA));
    idx.push(0, 1 + ((i + 1) % n), 1 + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function liquidMaterial(uniforms) {
  const m = new THREE.MeshLambertMaterial({ color: 0x34443e, transparent: true, opacity: 0.86 });
  m.defines = { FPV_NO_SNOW: '' };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;\nuniform float waterTime, sunVis;\nuniform vec3 waterHorizon, waterZenith, sunDirW, sunColorW;')
      .replace('#include <opaque_fragment>', /* glsl */ `
        vec3 wp = vWaterPos;
        float t = waterTime;
        vec2 g = vec2(cos(wp.x * 1.3 + t * 1.1 + sin(wp.z * 0.7)), cos(wp.z * 1.7 - t * 0.9 + sin(wp.x * 0.5))) * 0.05
               + vec2(cos(wp.x * 3.1 - wp.z * 2.3 + t * 2.0), cos(wp.z * 3.7 + wp.x * 1.9 - t * 1.7)) * 0.025;
        vec3 nW = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 V = normalize(cameraPosition - wp);
        float fres = 0.04 + 0.96 * pow(1.0 - max(dot(V, nW), 0.0), 5.0);
        vec3 R = reflect(-V, nW);
        vec3 sky = mix(waterHorizon, waterZenith, clamp(R.y * 1.5, 0.0, 1.0));
        vec3 col = mix(outgoingLight, sky, fres * 0.85);
        col += sunColorW * pow(max(dot(R, normalize(sunDirW)), 0.0), 180.0) * 2.5 * sunVis;
        gl_FragColor = vec4(col, mix(diffuseColor.a, 1.0, fres));`);
  };
  return m;
}

export function createWater(layout) {
  const { rivers, lakes, frozen } = layout.water;
  const geos = [...rivers.map(riverGeometry), ...lakes.map(lakeGeometry)];
  const uniforms = {
    waterTime: { value: 0 },
    sunVis: { value: 1 },
    waterHorizon: { value: new THREE.Color() },
    waterZenith: { value: new THREE.Color() },
    sunDirW: { value: new THREE.Vector3(0, 1, 0) },
    sunColorW: { value: new THREE.Color() },
  };
  const group = new THREE.Group();
  if (!geos.length) {
    return { mesh: group, update() {}, dispose() {} };
  }
  const geo = mergeGeometries(geos.map((g) => g.toNonIndexed()));
  geos.forEach((g) => g.dispose());
  geo.computeVertexNormals();
  // ice: matt, a little blue; snow lands on it (global snow shading)
  const material = frozen ? new THREE.MeshLambertMaterial({ color: 0x8a98a2 }) : liquidMaterial(uniforms);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  group.add(mesh);
  return {
    mesh: group,
    // sky: { zenith, horizon, sunDir, sunColor, light 0..1 }
    update(dt, sky) {
      uniforms.waterTime.value += dt;
      uniforms.waterHorizon.value.copy(sky.horizon);
      uniforms.waterZenith.value.copy(sky.zenith);
      uniforms.sunDirW.value.copy(sky.sunDir);
      uniforms.sunColorW.value.copy(sky.sunColor);
      uniforms.sunVis.value = sky.light;
    },
    dispose() {
      geo.dispose();
      material.dispose();
    },
  };
}
