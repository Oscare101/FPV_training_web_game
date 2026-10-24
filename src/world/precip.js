import * as THREE from 'three';
import { mulberry32 } from './random.js';

// Rain streaks and snowflakes in a box that wraps around the camera. Positions are world-fixed
// (seed + velocity * time, wrapped), so flying through them looks right; rain streaks stretch
// along the drop velocity relative to the camera, so they slant when you fly fast.

const RAIN = { count: 9000, box: 36, fall: 9, streak: 0.035 };
const SNOW = { count: 7000, box: 30, fall: 1.1, size: 0.035 };

const rainVertex = /* glsl */ `
  attribute vec3 seed;
  attribute float tip;
  uniform vec3 camPos, fallVel, relVel;
  uniform float time, box, streak;
  varying float vAlpha;
  void main() {
    vec3 p = seed * box + fallVel * time;
    p = camPos + mod(p - camPos + box * 0.5, box) - box * 0.5;
    p -= relVel * streak * tip;
    vAlpha = (1.0 - tip * 0.7) * (1.0 - smoothstep(box * 0.3, box * 0.5, length(p - camPos)));
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }`;
const rainFragment = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vAlpha;
  void main() { gl_FragColor = vec4(color, opacity * vAlpha); }`;

const snowVertex = /* glsl */ `
  attribute vec3 seed;
  uniform vec3 camPos, fallVel;
  uniform float time, box, size, pxScale;
  varying float vAlpha;
  void main() {
    vec3 p = seed * box + fallVel * time;
    p.x += sin(time * 1.3 + seed.y * 40.0) * 0.35;
    p.z += cos(time * 1.1 + seed.x * 40.0) * 0.35;
    p = camPos + mod(p - camPos + box * 0.5, box) - box * 0.5;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    float d = max(0.2, -mv.z);
    gl_PointSize = clamp(size * pxScale / d, 1.0, 9.0);
    vAlpha = 1.0 - smoothstep(box * 0.3, box * 0.5, length(p - camPos));
    gl_Position = projectionMatrix * mv;
  }`;
const snowFragment = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5);
    gl_FragColor = vec4(color, opacity * vAlpha * (1.0 - smoothstep(0.2, 0.5, r)));
  }`;

export function createPrecip(scene) {
  const rand = mulberry32(77);

  const rainGeo = new THREE.BufferGeometry();
  const rs = new Float32Array(RAIN.count * 6);
  const rt = new Float32Array(RAIN.count * 2);
  for (let i = 0; i < RAIN.count; i++) {
    const s = [rand(), rand(), rand()];
    rs.set(s, i * 6);
    rs.set(s, i * 6 + 3);
    rt[i * 2 + 1] = 1;
  }
  rainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RAIN.count * 6), 3)); // unused, sets the count
  rainGeo.setAttribute('seed', new THREE.BufferAttribute(rs, 3));
  rainGeo.setAttribute('tip', new THREE.BufferAttribute(rt, 1));
  const common = () => ({
    camPos: { value: new THREE.Vector3() },
    fallVel: { value: new THREE.Vector3() },
    time: { value: 0 },
    color: { value: new THREE.Color() },
    opacity: { value: 0 },
  });
  const rainU = { ...common(), relVel: { value: new THREE.Vector3() }, box: { value: RAIN.box }, streak: { value: RAIN.streak } };
  const rain = new THREE.LineSegments(rainGeo, new THREE.ShaderMaterial({
    uniforms: rainU, vertexShader: rainVertex, fragmentShader: rainFragment, transparent: true, depthWrite: false,
  }));

  const snowGeo = new THREE.BufferGeometry();
  const ss = new Float32Array(SNOW.count * 3).map(() => rand());
  snowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SNOW.count * 3), 3));
  snowGeo.setAttribute('seed', new THREE.BufferAttribute(ss, 3));
  const snowU = { ...common(), box: { value: SNOW.box }, size: { value: SNOW.size }, pxScale: { value: 400 } };
  const snow = new THREE.Points(snowGeo, new THREE.ShaderMaterial({
    uniforms: snowU, vertexShader: snowVertex, fragmentShader: snowFragment, transparent: true, depthWrite: false,
  }));

  for (const o of [rain, snow]) {
    o.frustumCulled = false;
    o.renderOrder = 5;
    o.visible = false;
    scene.add(o);
  }

  let rainAmount = 0;
  let snowAmount = 0;
  return {
    // amounts 0..1; light: 0..1 scene brightness (dims the particles at night)
    configure(rainK, snowK, light) {
      rainAmount = rainK;
      snowAmount = snowK;
      rain.visible = rainK > 0.01;
      snow.visible = snowK > 0.01;
      rainGeo.setDrawRange(0, Math.round(RAIN.count * rainK) * 2);
      snowGeo.setDrawRange(0, Math.round(SNOW.count * snowK));
      rainU.color.value.setRGB(0.72, 0.76, 0.82).multiplyScalar(0.3 + 0.7 * light);
      rainU.opacity.value = 0.32 + 0.15 * rainK;
      snowU.color.value.setRGB(0.95, 0.96, 1).multiplyScalar(0.35 + 0.65 * light);
      snowU.opacity.value = 0.9;
    },
    // wind: m/s; camVel: camera velocity m/s; pxHeight: render height in pixels; fovV: rad
    update(camera, dt, wind, camVel, pxHeight, fovV) {
      if (!rainAmount && !snowAmount) return;
      for (const u of [rainU, snowU]) {
        u.time.value += dt;
        u.camPos.value.copy(camera.position);
      }
      rainU.fallVel.value.set(wind.x, -RAIN.fall, wind.z);
      rainU.relVel.value.copy(rainU.fallVel.value).sub(camVel);
      snowU.fallVel.value.set(wind.x * 0.8, -SNOW.fall, wind.z * 0.8);
      snowU.pxScale.value = pxHeight / (2 * Math.tan(fovV / 2));
    },
    dispose() {
      for (const o of [rain, snow]) {
        scene.remove(o);
        o.geometry.dispose();
        o.material.dispose();
      }
    },
  };
}
