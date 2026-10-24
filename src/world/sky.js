import * as THREE from 'three';
import { mulberry32 } from './random.js';
import { CLOUD_GLSL, setCloudShadow } from '../render/envShade.js';
import { computeSun } from './sun.js';

// Sky dome (gradient + sun/moon disc and glow + procedural clouds), one directional light that is
// the sun by day and the moon at night, with a shadow map that follows the camera, hemisphere fill
// light and fog matched to the horizon. Colours come from the sun's elevation, so mornings,
// sunsets and winter days light the scene differently; weather greys, darkens and fogs it.

// Keyframes by sun elevation (deg): zenith, horizon towards the sun, horizon away from it
const SKY_KEYS = [
  [-12, 0x05080f, 0x141c2b, 0x0d1320],
  [-5, 0x0f1830, 0x3a3048, 0x1a2034],
  [-1, 0x26385e, 0xb85a38, 0x3a4460],
  [3, 0x3a5686, 0xf08a44, 0x7c8ca6],
  [8, 0x4a6ea4, 0xf2b070, 0xa4b2c0],
  [18, 0x5a80b4, 0xd8cab4, 0xb4c2cc],
  [35, 0x5f86b8, 0xbdc9d2, 0xb9c8d4],
  [65, 0x4d7bb8, 0xb2c4d6, 0xb2c4d6],
];
// Sunlight colour and intensity by elevation
const SUN_KEYS = [
  [-2, 0xff6a30, 0],
  [1, 0xff7a3a, 0.6],
  [4, 0xff9850, 1.3],
  [9, 0xffbf80, 1.55],
  [18, 0xffdcb4, 1.7],
  [35, 0xfff0dc, 1.95],
  [65, 0xfff6ea, 2.05],
];
const MOON = { dir: [0.33, 0.62, 0.71], color: 0x8ea4d0, intensity: 0.35 }; // high in the south
const NIGHT_HEMI = { sky: 0x52627e, ground: 0x10140e, intensity: 0.5 };
// shadow quality: map size and half-extent of the shadowed area around the camera
const SHADOWS = { off: null, low: { size: 1024, extent: 70 }, medium: { size: 2048, extent: 110 }, high: { size: 4096, extent: 160 } };

const _a = new THREE.Color();
const _b = new THREE.Color();
function lerpKeys(keys, e, idx, out) {
  let i = 1;
  while (i < keys.length - 1 && keys[i][0] < e) i++;
  const k0 = keys[i - 1];
  const k1 = keys[i];
  const t = Math.min(1, Math.max(0, (e - k0[0]) / (k1[0] - k0[0])));
  return out.copy(_a.setHex(k0[idx])).lerp(_b.setHex(k1[idx]), t);
}
function lerpNum(keys, e, idx) {
  let i = 1;
  while (i < keys.length - 1 && keys[i][0] < e) i++;
  const k0 = keys[i - 1];
  const k1 = keys[i];
  const t = Math.min(1, Math.max(0, (e - k0[0]) / (k1[0] - k0[0])));
  return k0[idx] + (k1[idx] - k0[idx]) * t;
}
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const vertexShader = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww; // always on the far plane
  }`;

const fragmentShader = /* glsl */ `
  uniform vec3 zenith, horizonSun, horizonAway, groundColor, sunDir, sunColor, cloudTint, fogColor;
  uniform float glow, disc, clouds, cloudLight, cloudDark, fogAmount;
  uniform vec2 drift;
  varying vec3 vDir;
  ${CLOUD_GLSL}

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    // horizon is warm on the sun's side (sunrise/sunset), cool opposite
    vec2 hd = normalize(d.xz + 1e-5);
    vec2 hs = normalize(sunDir.xz + 1e-5);
    float toward = pow(max(dot(hd, hs), 0.0) * 0.5 + 0.5, 3.0);
    vec3 horizon = mix(horizonAway, horizonSun, toward);
    vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.45));
    if (h < 0.0) col = mix(horizon, groundColor, clamp(-h * 5.0, 0.0, 1.0));
    float sd = max(dot(d, sunDir), 0.0);
    col += sunColor * glow * (pow(sd, 1200.0) * 9.0 * disc + pow(sd, 18.0) * 0.22 + pow(sd, 3.0) * 0.07);
    if (h > 0.0 && clouds > 0.0) {
      // clouds sit on a world-fixed layer, so they drift past overhead and match their shadows
      vec2 uv = fpvCloudUv(cameraPosition, d, drift);
      float cover = fpvCloudCover(uv, clouds, 5, 0.0);
      float shade = 0.75 + 0.25 * fpvCloudFbm(uv * 3.1 + 7.0, 5);
      vec3 cc = cloudTint * shade * cloudLight * (1.0 - cloudDark) + sunColor * pow(sd, 6.0) * 0.35 * cloudLight;
      col = mix(col, cc, cover * smoothstep(0.0, 0.12, h) * 0.95);
    }
    col = mix(col, fogColor, fogAmount * (1.0 - 0.45 * smoothstep(0.0, 0.7, h)));
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
    horizonSun: { value: new THREE.Color() },
    horizonAway: { value: new THREE.Color() },
    groundColor: { value: new THREE.Color() },
    sunDir: { value: new THREE.Vector3() },
    sunColor: { value: new THREE.Color() },
    cloudTint: { value: new THREE.Color() },
    fogColor: { value: new THREE.Color() },
    glow: { value: 1 },
    disc: { value: 1 },
    clouds: { value: 0.4 },
    cloudLight: { value: 1 },
    cloudDark: { value: 0 },
    fogAmount: { value: 0 },
    drift: { value: new THREE.Vector2() },
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
  const starMat = new THREE.PointsMaterial({ color: 0xc8d4ff, size: 1.5, sizeAttenuation: false, fog: false, depthWrite: false, transparent: true });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  stars.renderOrder = -9;
  scene.add(stars);

  let shadowCfg = null;
  let cloudShadow = 0;
  let time = 0;
  const lightDir = new THREE.Vector3();
  const state = { elevation: 45, dark: 0, viewDistance: 700, horizon: new THREE.Color(), sunColor: new THREE.Color(), lightIntensity: 1 };

  // env: { season, timeOfDay, hour, latitude, clouds, cloudShadows, fog, rain, snowfall, viewDistance, shadows }
  function apply(env) {
    const s = computeSun(env);
    const e = s.elevation;
    state.elevation = e;
    const clouds = env.clouds;
    const overcast = smooth(0.6, 1, clouds);
    const storm = Math.max(env.rain ?? 0, (env.snowfall ?? 0) * 0.7);
    const night = e < -2;
    state.dark = 1 - smooth(-8, 2, e); // 0 day .. 1 full night

    // sky gradient, greyed by overcast/rain
    lerpKeys(SKY_KEYS, e, 1, uniforms.zenith.value);
    lerpKeys(SKY_KEYS, e, 2, uniforms.horizonSun.value);
    lerpKeys(SKY_KEYS, e, 3, uniforms.horizonAway.value);
    const bright = 1 - state.dark * 0.92;
    const grey = _a.setRGB(0.55, 0.58, 0.62).multiplyScalar(bright * (1 - storm * 0.35));
    for (const c of [uniforms.zenith.value, uniforms.horizonSun.value, uniforms.horizonAway.value]) c.lerp(grey, overcast * 0.85);
    uniforms.groundColor.value.copy(uniforms.horizonAway.value).multiplyScalar(0.55);
    state.horizon.copy(uniforms.horizonAway.value).lerp(uniforms.horizonSun.value, 0.35);

    // light: sun by day, moon at night
    if (!night) {
      lightDir.fromArray(s.dir);
      lerpKeys(SUN_KEYS, e, 1, state.sunColor);
      state.lightIntensity = lerpNum(SUN_KEYS, e, 2) * (1 - overcast * 0.75) * (1 - storm * 0.3);
    } else {
      lightDir.fromArray(MOON.dir).normalize();
      state.sunColor.setHex(MOON.color);
      state.lightIntensity = MOON.intensity * smooth(-2, -8, e) * (1 - overcast * 0.8);
    }
    uniforms.sunDir.value.copy(lightDir);
    uniforms.sunColor.value.copy(state.sunColor);
    uniforms.glow.value = (night ? 0.3 : 1) * (1 - overcast * 0.9);
    uniforms.disc.value = night ? 0.25 : smooth(-1.5, 0.5, e);
    sun.color.copy(state.sunColor);
    sun.intensity = state.lightIntensity;
    sun.shadow.intensity = 1 - overcast * 0.75;
    const grazing = 1 - smooth(4, 25, e);
    sun.shadow.normalBias = 0.04 + grazing * 0.1;
    sun.shadow.bias = -0.0004 - grazing * 0.0008;

    // clouds: white by day, warm at sunrise/sunset, dark grey in rain
    const warm = night ? 0 : 1 - smooth(2, 22, e);
    uniforms.cloudTint.value.setRGB(0.93, 0.94, 0.96).lerp(_a.copy(state.sunColor).multiplyScalar(0.95), warm * 0.55);
    uniforms.cloudLight.value = night ? 0.05 : 0.35 + 0.65 * smooth(-2, 12, e);
    uniforms.cloudDark.value = storm * 0.45 + overcast * 0.12;
    uniforms.clouds.value = clouds;

    // fill light
    if (night) {
      hemi.color.setHex(NIGHT_HEMI.sky);
      hemi.groundColor.setHex(NIGHT_HEMI.ground);
      hemi.intensity = NIGHT_HEMI.intensity;
    } else {
      hemi.color.copy(uniforms.zenith.value).lerp(_a.setHex(0xdfe8ef), 0.6).lerp(state.sunColor, warm * 0.4);
      hemi.groundColor.setHex(0x4a5a35).multiplyScalar(0.6 + 0.4 * smooth(0, 20, e));
      hemi.intensity = (0.68 + 0.37 * smooth(-2, 30, e)) * (1 + overcast * 0.25);
    }

    // fog / visibility: night, fog, rain and snow shorten it
    const fog = env.fog ?? 0;
    let vis = env.viewDistance * (1 - 0.55 * state.dark);
    vis = Math.min(vis, env.viewDistance * (1 - fog * 0.9) + 60 * fog);
    vis *= 1 - 0.35 * (env.rain ?? 0) - 0.45 * (env.snowfall ?? 0);
    state.viewDistance = Math.max(80, vis);
    scene.fog.color.copy(state.horizon).lerp(_a.setRGB(0.62, 0.65, 0.68).multiplyScalar(bright), Math.min(1, fog + overcast * 0.5));
    scene.fog.near = state.viewDistance * (0.25 - 0.2 * fog);
    scene.fog.far = state.viewDistance;
    uniforms.fogColor.value.copy(scene.fog.color);
    uniforms.fogAmount.value = Math.min(1, fog * 1.1 + storm * 0.25);

    stars.visible = state.dark > 0.6 && overcast < 0.9;
    starMat.opacity = smooth(0.6, 1, state.dark) * (1 - overcast);
    cloudShadow = (env.cloudShadows ?? 0) * (night ? 0.5 : 1) * (1 - overcast * 0.6);

    shadowCfg = night || e < 0.5 ? null : SHADOWS[env.shadows] ?? null;
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
  const colors = { zenith: uniforms.zenith.value, horizon: state.horizon, sunDir: lightDir, sunColor: state.sunColor, light: 1 };
  return {
    apply,
    state, // elevation, dark, viewDistance, horizon colour, sunColor, lightIntensity
    get colors() {
      colors.light = Math.min(1, state.lightIntensity / 2);
      return colors;
    },
    get shadowsOn() {
      return !!shadowCfg;
    },
    // half-size of the shadow-mapped area (m), 0 when off
    get shadowExtent() {
      return shadowCfg ? shadowCfg.extent : 0;
    },
    follow(camera, dt = 0) {
      dome.position.copy(camera.position);
      stars.position.copy(camera.position);
      time += dt;
      uniforms.drift.value.set(time * 0.004, time * 0.0015);
      setCloudShadow(time * 0.004, time * 0.0015, cloudShadow, uniforms.clouds.value);
      // Shadowed area centred a bit ahead of the camera, snapped to shadow texels so edges don't crawl
      fwd.set(0, 0, -1).applyQuaternion(camera.quaternion).setY(0);
      if (fwd.lengthSq() > 1e-4) fwd.normalize();
      const ext = shadowCfg ? shadowCfg.extent : 50;
      center.copy(camera.position).addScaledVector(fwd, ext * 0.5);
      const texel = shadowCfg ? (ext * 2) / shadowCfg.size : 1;
      center.x = Math.round(center.x / texel) * texel;
      center.z = Math.round(center.z / texel) * texel;
      sun.target.position.copy(center);
      sun.position.copy(center).addScaledVector(lightDir, 400);
    },
  };
}
