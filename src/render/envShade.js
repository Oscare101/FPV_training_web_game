import * as THREE from 'three';

// Extra shading for the sun (directional light) on every Lambert material, patched into
// three's shader chunks once: cloud shadows (same cloud field as the sky dome), the drone's
// own shadow (analytic silhouette, so it is sharp at any shadow-map quality) and a soft fade
// at the edge of the shadow-map area instead of a hard line.

export const CLOUD_HEIGHT = 1000; // m, cloud layer
export const CLOUD_SCALE = 0.00055; // noise units per m
const SUN_BLUR = 0.0093; // rad, the sun's angular diameter: penumbra width per metre of distance

// Shared by the sky dome and the cloud shadows so they show the same clouds
export const CLOUD_GLSL = /* glsl */ `
  float fpvHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float fpvNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(fpvHash(i), fpvHash(i + vec2(1, 0)), u.x), mix(fpvHash(i + vec2(0, 1)), fpvHash(i + vec2(1, 1)), u.x), u.y);
  }
  // fbm truncated to 'oct' octaves; the missing octaves are added as their mean so the coverage matches
  float fpvCloudFbm(vec2 p, int oct) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) {
      if (i >= oct) { s += a * 0.5; a *= 0.5; continue; }
      s += a * fpvNoise(p); p *= 2.03; a *= 0.5;
    }
    return s;
  }
  // 0..1 cloud cover at cloud-plane coords uv; amount = clouds setting; soft widens the edge
  float fpvCloudCover(vec2 uv, float amount, int oct, float soft) {
    float n = fpvCloudFbm(uv * 1.6, oct);
    return smoothstep(1.0 - amount * 0.75 - soft, 1.15 - amount * 0.75 + soft, n);
  }
  // point on the cloud plane seen from p along direction d (d.y > 0), in noise coords
  vec2 fpvCloudUv(vec3 p, vec3 d, vec2 drift) {
    return (p.xz + d.xz * (${CLOUD_HEIGHT.toFixed(1)} - p.y) / (d.y + 0.1)) * ${CLOUD_SCALE} + drift;
  }`;

// Uniform values are typed arrays: three's uniform cloning keeps them shared by reference, so
// one write per frame reaches every material.
export const envUniforms = {
  fpvCloud: new Float32Array(4), // drift u, drift v, shadow strength, cloud amount
  fpvDrone0: new Float32Array(4), // drone position, shadow strength (0 = off)
  fpvDrone1: new Float32Array(4), // body right axis (world), motor distance from centre
  fpvDrone2: new Float32Array(4), // body forward axis (world), prop radius
  fpvDrone3: new Float32Array(4), // prop spin 0..1, frame scale
  fpvSurf: new Float32Array(4), // snow on upward faces 0..1, wetness 0..1
};

const PARS = /* glsl */ `
  uniform vec4 fpvCloud, fpvDrone0, fpvDrone1, fpvDrone2, fpvDrone3, fpvSurf;
  ${CLOUD_GLSL}
  // closest distance between the ray p + s*t (t >= 0) and segment ab; returns (distance, t)
  vec2 fpvRaySeg(vec3 p, vec3 s, vec3 a, vec3 b) {
    vec3 ab = b - a, ap = a - p;
    float abab = dot(ab, ab), abs_ = dot(ab, s), aps = dot(ap, s), apab = dot(ap, ab);
    float den = abab - abs_ * abs_;
    float u = den > 1e-9 ? clamp((abs_ * aps - apab) / den, 0.0, 1.0) : 0.0;
    float t = max(dot(a + ab * u - p, s), 0.0);
    u = clamp(dot(p + s * t - a, ab) / max(abab, 1e-9), 0.0, 1.0);
    vec3 q = a + ab * u;
    t = max(dot(q - p, s), 0.0);
    return vec2(length(p + s * t - q), t);
  }
  // shadow of a capsule (radius r) at ray distance dt = (distance, t), blurred by the sun's disc
  float fpvCap(vec2 dt, float r) {
    float w = dt.y * ${SUN_BLUR} + 0.004;
    return clamp(0.5 - (dt.x - r) / w, 0.0, 1.0) * min(1.0, 4.0 * r / w);
  }

  // The drone as a few capsules (body, battery, arms, motors) plus prop discs, ray-traced towards the sun
  float fpvDroneShadow(vec3 wp, vec3 s) {
    vec3 R = fpvDrone1.xyz, F = fpvDrone2.xyz, U = cross(R, F), D = fpvDrone0.xyz;
    float arm = fpvDrone1.w, prop = fpvDrone2.w, k = fpvDrone3.y, spin = fpvDrone3.x;
    vec3 dp = D - wp;
    float tc = dot(dp, s);
    if (tc < 0.05 || tc > 120.0) return 0.0;
    float reach = arm + prop + 0.08 * k + tc * ${SUN_BLUR};
    if (dot(dp, dp) - tc * tc > reach * reach) return 0.0;
    float m = 0.7071 * arm;
    float a = fpvCap(fpvRaySeg(wp, s, D + F * (0.055 * k) + U * (0.012 * k), D - F * (0.06 * k) + U * (0.012 * k)), 0.022 * k);
    a = max(a, fpvCap(fpvRaySeg(wp, s, D + F * (0.03 * k) + U * (0.04 * k), D - F * (0.03 * k) + U * (0.04 * k)), 0.018 * k));
    a = max(a, fpvCap(fpvRaySeg(wp, s, D + (R + F) * m, D - (R + F) * m), 0.008 * k));
    a = max(a, fpvCap(fpvRaySeg(wp, s, D + (R - F) * m, D - (R - F) * m), 0.008 * k));
    float pa = 0.0;
    for (int i = 0; i < 4; i++) {
      vec3 mp = D + (R * (i < 2 ? m : -m)) + (F * (i == 0 || i == 2 ? m : -m));
      a = max(a, fpvCap(fpvRaySeg(wp, s, mp, mp + U * (0.02 * k)), 0.014 * k));
      vec3 pc = mp + U * (0.026 * k);
      if (spin > 0.0) {
        // spinning prop: a faint disc where the ray crosses the prop plane
        float den = dot(s, U);
        if (abs(den) > 0.02) {
          float t = dot(pc - wp, U) / den;
          float w = t * ${SUN_BLUR} + 0.004;
          float dist = length(wp + s * t - pc);
          pa = max(pa, clamp(0.5 - (dist - prop) / w, 0.0, 1.0) * 0.3 * spin);
        }
      } else {
        // stopped prop: two blades
        vec3 bd = (R * 0.94 + F * 0.34) * prop;
        a = max(a, fpvCap(fpvRaySeg(wp, s, pc - bd, pc + bd), 0.007 * k));
      }
    }
    return max(a, pa) * fpvDrone0.w;
  }

  // sun factor at view-space position vp for a light along view-space direction ld
  float fpvSunShade(vec3 vp, vec3 ld) {
    mat3 r = mat3(viewMatrix);
    vec3 wp = (vp - viewMatrix[3].xyz) * r; // view -> world (rotation is orthonormal)
    vec3 s = normalize(ld * r);
    float f = 1.0;
    if (fpvCloud.z > 0.0 && s.y > 0.0) f -= fpvCloud.z * fpvCloudCover(fpvCloudUv(wp, s, fpvCloud.xy), fpvCloud.w, 4, 0.03);
    if (fpvDrone0.w > 0.0) f *= 1.0 - fpvDroneShadow(wp, s);
    return f;
  }
  // Albedo of a surface (view-space normal n, view-space position vp): darker when wet, snow on upward faces (patchy)
  vec3 fpvSurface(vec3 c, vec3 n, vec3 vp) {
    c *= 1.0 - 0.28 * fpvSurf.y;
    #ifndef FPV_NO_SNOW
    if (fpvSurf.x > 0.0) {
      mat3 r = mat3(viewMatrix);
      vec3 wn = n * r;
      vec3 wp = (vp - viewMatrix[3].xyz) * r;
      float patchy = fpvNoise(wp.xz * 1.7) * 0.6 + fpvNoise(wp.xz * 6.0 + 3.1) * 0.4;
      float s = fpvSurf.x * smoothstep(0.4, 0.8, wn.y) * smoothstep(0.2, 0.55, patchy + 0.25 * fpvSurf.x);
      c = mix(c, vec3(0.74, 0.76, 0.8), s);
    }
    #endif
    return c;
  }

  // fade the shadow map out over the last 8% towards its edge
  float fpvShadowFade(vec4 sc) {
    vec2 e = min(sc.xy, 1.0 - sc.xy) / sc.w;
    return smoothstep(0.0, 0.08, min(e.x, e.y));
  }`;

let installed = false;
export function installEnvShade() {
  if (installed) return;
  installed = true;
  const chunk = THREE.ShaderChunk;
  chunk.lights_pars_begin = `${chunk.lights_pars_begin}\n${PARS}`;
  const shadowCall = 'getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] )';
  const info = 'getDirectionalLightInfo( directionalLight, directLight );';
  if (!chunk.lights_fragment_begin.includes(shadowCall) || !chunk.lights_fragment_begin.includes(info)) {
    console.warn('envShade: three.js light chunk changed, cloud/drone shadows disabled');
    return;
  }
  chunk.lights_fragment_begin = chunk.lights_fragment_begin
    .replace(info, `${info}\n\t\tdirectLight.color *= fpvSunShade( geometryPosition, directLight.direction );`)
    .replace(shadowCall, `mix( 1.0, ${shadowCall}, fpvShadowFade( vDirectionalShadowCoord[ i ] ) )`);
  const lambert = THREE.ShaderLib.lambert;
  lambert.fragmentShader = lambert.fragmentShader.replace('#include <lights_lambert_fragment>', 'diffuseColor.rgb = fpvSurface( diffuseColor.rgb, normal, - vViewPosition );\n#include <lights_lambert_fragment>');
  const lib = lambert.uniforms;
  for (const [name, value] of Object.entries(envUniforms)) lib[name] = { value };
}

// snow: 0..1 on upward faces of every lit object (materials can opt out with the FPV_NO_SNOW define)
export function setSurface(snow, wet) {
  envUniforms.fpvSurf[0] = snow;
  envUniforms.fpvSurf[1] = wet;
}

export function setCloudShadow(driftU, driftV, strength, amount) {
  envUniforms.fpvCloud.set([driftU, driftV, strength, amount]);
}

const _r = new THREE.Vector3();
const _f = new THREE.Vector3();
// pose: { position, quaternion } or null to hide; size: prop inches; spin 0..1
export function setDroneShadow(pose, size, spin, strength) {
  if (!pose || strength <= 0) {
    envUniforms.fpvDrone0[3] = 0;
    return;
  }
  const k = size / 5;
  _r.set(1, 0, 0).applyQuaternion(pose.quaternion);
  _f.set(0, 0, -1).applyQuaternion(pose.quaternion);
  const p = pose.position;
  envUniforms.fpvDrone0.set([p.x, p.y, p.z, strength]);
  envUniforms.fpvDrone1.set([_r.x, _r.y, _r.z, 0.1125 * k]);
  envUniforms.fpvDrone2.set([_f.x, _f.y, _f.z, size * 0.0127]);
  envUniforms.fpvDrone3.set([spin, k, 0, 0]);
}
