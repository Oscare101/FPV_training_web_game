import * as THREE from 'three';
import { mulberry32 } from './random.js';

// Sky dome (gradient + sun/moon glow + procedural clouds), sun/moon light with a shadow
// map that follows the camera, hemisphere fill light, fog matched to the horizon colour.

const DAY = {
  zenith: 0x5f86b8, horizon: 0xb9c8d4, ground: 0x6d7466, fogNear: 0.25,
  hemiSky: 0xdfe8ef, hemiGround: 0x4a5a35, hemi: 1.05,
  sun: 0xfff3e0, sunIntensity: 2.0, sunDir: [0.45, 0.62, 0.35], glow: 1, cloudLight: 1,
};
const NIGHT = {
  zenith: 0x05080f, horizon: 0x141c2b, ground: 0x07090c, fogNear: 0.1,
  hemiSky: 0x52627e, hemiGround: 0x10140e, hemi: 0.5,
  sun: 0x8ea4d0, sunIntensity: 0.35, sunDir: [-0.4, 0.55, -0.6], glow: 0.25, cloudLight: 0.12,
};
// shadow quality: map size and half-extent of the shadowed area around the camera
const SHADOWS = { off: null, low: { size: 1024, extent: 70 }, medium: { size: 2048, extent: 110 }, high: { size: 4096, extent: 160 } };

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // always on the far plane
  }`;

const fragmentShader = /* glsl */ `
  uniform vec3 zenith;
  uniform vec3 horizon;
  uniform vec3 groundColor;
  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform float glow;
  uniform float clouds;
  uniform float cloudLight;
  uniform float time;
  varying vec3 vDir;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; }
    return s;
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.45));
    if (h < 0.0) col = mix(horizon, groundColor, clamp(-h * 5.0, 0.0, 1.0));
    float sd = max(dot(d, sunDir), 0.0);
    col += sunColor * glow * (pow(sd, 900.0) * 8.0 + pow(sd, 18.0) * 0.22 + pow(sd, 3.0) * 0.06);
    if (h > 0.0 && clouds > 0.0) {
      vec2 uv = d.xz / (h + 0.1) * 0.55 + vec2(time * 0.004, time * 0.0015);
      float n = fbm(uv * 1.6);
      float cover = smoothstep(1.0 - clouds * 0.75, 1.15 - clouds * 0.75, n);
      float shade = 0.75 + 0.25 * fbm(uv * 3.1 + 7.0);
      vec3 cc = vec3(0.93, 0.94, 0.96) * shade * cloudLight + sunColor * pow(sd, 6.0) * 0.25 * cloudLight;
      col = mix(col, cc, cover * smoothstep(0.0, 0.12, h) * 0.95);
    }
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

export function createSky(scene) {
  const hemi = new THREE.HemisphereLight();
  const sun = new THREE.DirectionalLight();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(hemi, sun, sun.target);
  scene.fog = new THREE.Fog(0, 1, 2);

  const uniforms = {
    zenith: { value: new THREE.Color() },
    horizon: { value: new THREE.Color() },
    groundColor: { value: new THREE.Color() },
    sunDir: { value: new THREE.Vector3() },
    sunColor: { value: new THREE.Color() },
    glow: { value: 1 },
    clouds: { value: 0.4 },
    cloudLight: { value: 1 },
    time: { value: 0 },
  };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(100, 32, 16),
    new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, side: THREE.BackSide, depthWrite: false, fog: false })
  );
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  scene.add(dome);

  // Stars: fixed directions, kept centered on the camera
  const rand = mulberry32(3);
  const starPos = new Float32Array(1500 * 3);
  for (let i = 0; i < 1500; i++) {
    const y = 0.05 + rand() * 0.95;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    starPos.set([Math.cos(a) * r * 90, y * 90, Math.sin(a) * r * 90], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xc8d4ff, size: 1.5, sizeAttenuation: false, fog: false, depthWrite: false }));
  stars.frustumCulled = false;
  stars.renderOrder = -9;
  scene.add(stars);

  let shadowCfg = null;
  const sunDir = new THREE.Vector3();

  function apply({ night, viewDistance, clouds, shadows }) {
    const p = night ? NIGHT : DAY;
    uniforms.zenith.value.setHex(p.zenith);
    uniforms.horizon.value.setHex(p.horizon);
    uniforms.groundColor.value.setHex(p.ground);
    uniforms.sunColor.value.setHex(p.sun);
    uniforms.glow.value = p.glow;
    uniforms.clouds.value = clouds;
    uniforms.cloudLight.value = p.cloudLight;
    sunDir.fromArray(p.sunDir).normalize();
    uniforms.sunDir.value.copy(sunDir);
    scene.fog.color.setHex(p.horizon);
    scene.fog.near = p.fogNear * viewDistance;
    scene.fog.far = viewDistance;
    hemi.color.setHex(p.hemiSky);
    hemi.groundColor.setHex(p.hemiGround);
    hemi.intensity = p.hemi;
    sun.color.setHex(p.sun);
    sun.intensity = p.sunIntensity;
    stars.visible = night;

    shadowCfg = night ? null : SHADOWS[shadows] ?? null;
    sun.castShadow = !!shadowCfg;
    if (shadowCfg) {
      if (sun.shadow.mapSize.x !== shadowCfg.size) {
        sun.shadow.mapSize.set(shadowCfg.size, shadowCfg.size);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      const cam = sun.shadow.camera;
      cam.left = cam.bottom = -shadowCfg.extent;
      cam.right = cam.top = shadowCfg.extent;
      cam.near = 1;
      cam.far = 800;
      cam.updateProjectionMatrix();
    }
  }

  const center = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  return {
    apply,
    get shadowsOn() {
      return !!shadowCfg;
    },
    follow(camera, dt = 0) {
      dome.position.copy(camera.position);
      stars.position.copy(camera.position);
      uniforms.time.value += dt;
      // Shadowed area centred a bit ahead of the camera, snapped to shadow texels so edges don't crawl
      fwd.set(0, 0, -1).applyQuaternion(camera.quaternion).setY(0);
      if (fwd.lengthSq() > 1e-4) fwd.normalize();
      const ext = shadowCfg ? shadowCfg.extent : 50;
      center.copy(camera.position).addScaledVector(fwd, ext * 0.5);
      const texel = shadowCfg ? (ext * 2) / shadowCfg.size : 1;
      center.x = Math.round(center.x / texel) * texel;
      center.z = Math.round(center.z / texel) * texel;
      sun.target.position.copy(center);
      sun.position.copy(center).addScaledVector(sunDir, 400);
    },
  };
}
