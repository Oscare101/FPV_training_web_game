import * as THREE from 'three';

// FPV camera look in one full-screen pass: the scene renders at camera resolution into a
// target, then this shader adds lens barrel distortion, chromatic fringing, colour response,
// grain, vignette and (analog) scanlines, soft chroma and line jitter.

export const LOOK_PRESETS = {
  clean: { lines: 0, distortion: 0, aberration: 0, noise: 0, vignette: 0, saturation: 1, contrast: 1, brightness: 1, analog: 0, sharpness: 0 },
  digital: { lines: 720, distortion: 0.28, aberration: 0.25, noise: 0.035, vignette: 0.45, saturation: 0.92, contrast: 1.08, brightness: 0.98, analog: 0, sharpness: 0.35 },
  analog: { lines: 480, distortion: 0.38, aberration: 0.55, noise: 0.11, vignette: 0.6, saturation: 0.72, contrast: 1.15, brightness: 1.02, analog: 1, sharpness: 0 },
};

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

const fragmentShader = /* glsl */ `
  uniform sampler2D tScene;
  uniform vec2 texel;
  uniform float aspect, time, distortion, aberration, noise, vignette, saturation, contrast, brightness, analog, sharpness, lines;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  // the render target holds linear colour; grade and output in sRGB
  vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

  // Barrel distortion, normalized so the corners stay in frame
  vec2 lens(vec2 uv, float k) {
    vec2 c = (uv - 0.5) * vec2(aspect, 1.0);
    float r2 = dot(c, c);
    float corner = aspect * aspect * 0.25 + 0.25;
    c *= (1.0 + k * r2) / (1.0 + k * corner);
    return c / vec2(aspect, 1.0) + 0.5;
  }

  vec3 sampleScene(vec2 uv) {
    vec3 col;
    float ab = aberration * 0.004 * length(uv - 0.5) * 2.0;
    vec2 dir = normalize(uv - 0.5 + 1e-5);
    col.r = texture2D(tScene, lens(uv + dir * ab, distortion)).r;
    col.g = texture2D(tScene, lens(uv, distortion)).g;
    col.b = texture2D(tScene, lens(uv - dir * ab, distortion)).b;
    return toSRGB(col);
  }

  void main() {
    vec2 uv = vUv;
    // analog: per-line horizontal jitter
    if (analog > 0.0) {
      float line = floor(uv.y * lines);
      uv.x += (hash(vec2(line, floor(time * 30.0))) - 0.5) * 0.0018 * analog;
    }
    vec3 col = sampleScene(uv);

    // mild sharpen (digital cameras over-sharpen)
    if (sharpness > 0.0) {
      vec2 lu = lens(uv, distortion);
      vec3 blur = toSRGB((texture2D(tScene, lu + vec2(texel.x, 0.0)).rgb + texture2D(tScene, lu - vec2(texel.x, 0.0)).rgb +
                   texture2D(tScene, lu + vec2(0.0, texel.y)).rgb + texture2D(tScene, lu - vec2(0.0, texel.y)).rgb) * 0.25);
      col += (col - blur) * sharpness;
    }
    // analog: chroma smears horizontally, luma stays
    if (analog > 0.0) {
      vec2 lu = lens(uv, distortion);
      vec3 smear = toSRGB((texture2D(tScene, lu + vec2(texel.x * 2.5, 0.0)).rgb + texture2D(tScene, lu - vec2(texel.x * 2.5, 0.0)).rgb) * 0.5);
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      float ls = dot(smear, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(l) + (smear - vec3(ls)), 0.6 * analog);
    }

    // colour response
    col *= brightness;
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(lum), col, saturation);
    col = (col - 0.5) * contrast + 0.5;

    // grain
    float g = hash(vUv * vec2(1731.0, 977.0) + fract(time * 7.13)) - 0.5;
    col += g * noise * (analog > 0.0 ? 1.4 : 1.0);
    // scanlines
    if (analog > 0.0) col *= 0.93 + 0.07 * sin(vUv.y * lines * 3.14159);
    // vignette
    vec2 v = (vUv - 0.5) * vec2(aspect, 1.0);
    col *= 1.0 - vignette * smoothstep(0.35, 1.05, length(v));
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }`;

export function createCameraFx(renderer) {
  const target = new THREE.WebGLRenderTarget(16, 16, { samples: 4 });
  const uniforms = {
    tScene: { value: target.texture },
    texel: { value: new THREE.Vector2() },
    aspect: { value: 1 },
    time: { value: 0 },
    distortion: { value: 0 },
    aberration: { value: 0 },
    noise: { value: 0 },
    vignette: { value: 0 },
    saturation: { value: 1 },
    contrast: { value: 1 },
    brightness: { value: 1 },
    analog: { value: 0 },
    sharpness: { value: 0 },
    lines: { value: 480 },
  };
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, depthTest: false, depthWrite: false }));
  quad.frustumCulled = false;
  const fxScene = new THREE.Scene();
  fxScene.add(quad);
  const fxCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  let enabled = false;
  let lines = 720;
  const size = new THREE.Vector2();

  function resize() {
    renderer.getSize(size);
    const aspect = size.x / size.y;
    // camera resolution: N lines tall (0 = native)
    const h = lines > 0 ? Math.min(lines, size.y * renderer.getPixelRatio()) : size.y * renderer.getPixelRatio();
    const w = Math.round(h * aspect);
    target.setSize(w, Math.round(h));
    uniforms.texel.value.set(1 / w, 1 / h);
    uniforms.aspect.value = aspect;
    uniforms.lines.value = Math.round(h);
  }

  return {
    get enabled() {
      return enabled;
    },
    // fx: { look, lines, distortion, aberration, noise, vignette, saturation, contrast, brightness }
    configure(fx) {
      enabled = fx.look !== 'off';
      const analog = fx.look === 'analog' ? 1 : 0;
      lines = fx.lines;
      for (const k of ['distortion', 'aberration', 'noise', 'vignette', 'saturation', 'contrast', 'brightness', 'sharpness']) uniforms[k].value = fx[k];
      uniforms.analog.value = analog;
      resize();
    },
    resize,
    // Where a projected point (NDC, -1..1) ends up on screen after the barrel distortion:
    // inverse of the shader's lens() (radial, solved with a few Newton steps)
    toScreen(x, y, out = [0, 0]) {
      const k = enabled ? uniforms.distortion.value : 0;
      if (!k) {
        out[0] = x;
        out[1] = y;
        return out;
      }
      const aspect = uniforms.aspect.value;
      const sx = (x / 2) * aspect;
      const sy = y / 2;
      const rs = Math.hypot(sx, sy);
      if (rs < 1e-6) {
        out[0] = x;
        out[1] = y;
        return out;
      }
      const D = 1 + k * (aspect * aspect * 0.25 + 0.25);
      let ru = rs;
      for (let i = 0; i < 8; i++) ru -= ((ru * (1 + k * ru * ru)) / D - rs) / ((1 + 3 * k * ru * ru) / D);
      const f = ru / rs;
      out[0] = x * f;
      out[1] = y * f;
      return out;
    },
    // height in pixels the scene renders at
    get height() {
      return enabled ? target.height : size.y * renderer.getPixelRatio();
    },
    render(scene, camera, dt) {
      if (!enabled) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      uniforms.time.value += dt;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(fxScene, fxCamera);
    },
  };
}
