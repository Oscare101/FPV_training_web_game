import * as THREE from 'three';

const MAX_INSTANCES = 110000; // per layer
const NEAR_RADIUS = 35; // m, dense carpet inside, sparser layer outside
const PARAM_CELL = 4; // m, resolution of the grass colour/density/height textures

// Tuft of 6 thin tapered blades, unit height (y 0..1), ~3 cm wide at the base
function clumpGeometry() {
  const pos = [];
  const idx = [];
  const blades = [[0, 0, 0, 1], [1.05, 0.05, 0.03, 0.8], [2.1, -0.04, 0.06, 0.9], [3.15, 0.06, -0.05, 0.7], [4.2, -0.06, -0.03, 0.85], [5.25, 0.02, 0.07, 0.6]];
  for (const [ang, ox, oz, hgt] of blades) {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const base = pos.length / 3;
    // base L/R, mid L/R, tip
    for (let [x, yy] of [[-0.016, 0], [0.016, 0], [-0.011, 0.5], [0.011, 0.5], [0, 1]]) {
      const y = yy * hgt;
      const lean = yy * yy * 0.22; // natural outward lean
      x *= 1.5; // ~5 cm wide base: thin, but covers the ground at FPV resolution
      pos.push(ox + x * c + lean * s, y, oz - x * s + lean * c);
    }
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

// GPU-placed grass: a fixed grid of clumps around the camera. The vertex shader picks each
// clump's world position (stable per world cell), ground height (same triangles as physics),
// colour/height/density from textures, wind sway and prop-wash flattening.
export function createGrass(layout) {
  const { heights, n, cell, half, size } = layout;

  const heightTex = new THREE.DataTexture(heights, n + 1, n + 1, THREE.RedFormat, THREE.FloatType);
  heightTex.needsUpdate = true;

  const pn = Math.ceil(size / PARAM_CELL);
  const colorData = new Uint8Array(pn * pn * 4);
  const heightData = new Uint8Array(pn * pn * 4);
  const col = new THREE.Color();
  const fill = (ix0, iz0, ix1, iz1) => {
    for (let iz = iz0; iz < iz1; iz++) {
      for (let ix = ix0; ix < ix1; ix++) param(ix, iz);
    }
  };
  const param = (ix, iz) => {
    {
      const x = -half + (ix + 0.5) * PARAM_CELL;
      const z = -half + (iz + 0.5) * PARAM_CELL;
      const [density, h] = layout.grassAt(x, z);
      layout.groundColor(x, z, col);
      const i = (iz * pn + ix) * 4;
      colorData[i] = Math.min(255, col.r * 1.25 * 255);
      colorData[i + 1] = Math.min(255, col.g * 1.3 * 255);
      colorData[i + 2] = Math.min(255, col.b * 1.1 * 255);
      colorData[i + 3] = density * 255;
      heightData[i] = Math.min(255, (h / 2) * 255);
    }
  };
  fill(0, 0, pn, pn);
  const colorTex = new THREE.DataTexture(colorData, pn, pn, THREE.RGBAFormat);
  colorTex.magFilter = THREE.LinearFilter;
  colorTex.needsUpdate = true;
  const paramTex = new THREE.DataTexture(heightData, pn, pn, THREE.RGBAFormat);
  paramTex.magFilter = THREE.LinearFilter;
  paramTex.needsUpdate = true;

  const makeUniforms = () => ({
    heightMap: { value: heightTex },
    grassColor: { value: colorTex },
    grassParam: { value: paramTex },
    cellSize: { value: cell },
    gridN: { value: n },
    mapHalf: { value: half },
    mapSize: { value: size },
    grassOrigin: { value: new THREE.Vector2() },
    spacing: { value: 0.55 },
    radius: { value: 80 },
    density: { value: 1 },
    heightScale: { value: 1 },
    time: { value: 0 },
    windVec: { value: new THREE.Vector2() },
    washPos: { value: new THREE.Vector3(0, -1000, 0) },
    washStrength: { value: 0 },
    innerRadius: { value: 0 },
  });

  const makeMaterial = (uniforms) => {
  const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */ `#include <common>
        attribute vec2 gridOffset;
        uniform sampler2D heightMap;
        uniform sampler2D grassColor;
        uniform sampler2D grassParam;
        uniform float cellSize, gridN, mapHalf, mapSize, spacing, radius, innerRadius, density, heightScale, time, washStrength;
        uniform vec2 grassOrigin, windVec;
        uniform vec3 washPos;
        varying vec3 vGrass;
        vec2 hash22(vec2 p) {
          vec3 a = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
          a += dot(a, a.yzx + 33.33);
          return fract((a.xx + a.yz) * a.zy);
        }
        float terrainHeight(vec2 p) {
          vec2 f = (p + mapHalf) / cellSize;
          vec2 i = clamp(floor(f), vec2(0.0), vec2(gridN - 1.0));
          vec2 t = f - i;
          ivec2 ii = ivec2(i);
          float h00 = texelFetch(heightMap, ii, 0).r;
          float h10 = texelFetch(heightMap, ii + ivec2(1, 0), 0).r;
          float h01 = texelFetch(heightMap, ii + ivec2(0, 1), 0).r;
          float h11 = texelFetch(heightMap, ii + ivec2(1, 1), 0).r;
          if (t.x + t.y <= 1.0) return h00 + (h10 - h00) * t.x + (h01 - h00) * t.y;
          return h11 + (h01 - h11) * (1.0 - t.x) + (h10 - h11) * (1.0 - t.y);
        }`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', /* glsl */ `
        vec2 cellPos = grassOrigin + gridOffset;
        vec2 hh = hash22(cellPos * 0.731 + 17.0);
        vec2 wp = cellPos + (hh - 0.5) * spacing;
        vec2 tuv = (wp + mapHalf) / mapSize;
        vec4 gc = texture2D(grassColor, tuv);
        float gh = texture2D(grassParam, tuv).r * 2.0 * heightScale;
        float dist = distance(wp, cameraPosition.xz);
        float fade = (1.0 - smoothstep(radius * 0.65, radius, dist)) * (innerRadius > 0.0 ? smoothstep(innerRadius * 0.8, innerRadius, dist) : 1.0);
        float keep = step(hh.x, gc.a * density);
        float s = gh * fade * keep * (0.6 + 0.8 * fract(hh.y * 7.13));
        float ang = hh.y * 6.2831;
        float ca = cos(ang), sa = sin(ang);
        float t = position.y;
        float wscale = 0.8 + 0.5 * min(s, 1.0);
        vec3 bp = vec3((position.x * ca - position.z * sa) * wscale, t * s, (position.x * sa + position.z * ca) * wscale);
        float gust = sin(time * 1.7 + wp.x * 0.31 + wp.y * 0.23) * 0.6 + sin(time * 3.3 + wp.x * 0.9 + wp.y * 0.4) * 0.25;
        vec2 bend = windVec * (0.5 + gust) * t * t * s;
        vec2 away = wp - washPos.xz;
        float wd = length(away);
        float wash = washStrength * (1.0 - smoothstep(0.4, 4.5, wd));
        bend += away / max(wd, 0.05) * wash * t * t * s * (0.9 + 0.3 * sin(time * 25.0 + wd * 3.0));
        bp.y *= 1.0 - wash * 0.55;
        vec3 transformed = vec3(wp.x + bp.x + bend.x, terrainHeight(wp) - 0.04 + bp.y, wp.y + bp.z + bend.y);
        vGrass = gc.rgb * (0.68 + 0.42 * t);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrass;')
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vGrass;');
  };
  return material;
  };

  const clump = clumpGeometry();
  // One instanced layer: a grid of clumps (ring between innerRadius and radius)
  function makeLayer() {
    const uniforms = makeUniforms();
    const material = makeMaterial(uniforms);
    const geometry = new THREE.InstancedBufferGeometry().copy(clump);
    const offsets = new Float32Array(MAX_INSTANCES * 2);
    const offsetAttr = new THREE.InstancedBufferAttribute(offsets, 2);
    geometry.setAttribute('gridOffset', offsetAttr);
    geometry.instanceCount = 0;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    let builtFor = '';
    return {
      mesh,
      uniforms,
      // Grid for a radius + spacing (rebuilt only when those change); spacing grows to cap the count
      configure(inner, radius, density, height, baseSpacing) {
        let spacing = baseSpacing / Math.sqrt(density);
        const area = Math.PI * (radius * radius - inner * inner * 0.64);
        if (area / (spacing * spacing) > MAX_INSTANCES) spacing = Math.sqrt(area / MAX_INSTANCES);
        Object.assign(uniforms.spacing, { value: spacing });
        uniforms.radius.value = radius;
        uniforms.innerRadius.value = inner;
        uniforms.density.value = Math.min(1, density);
        uniforms.heightScale.value = height;
        const key = `${inner}/${radius}/${spacing}`;
        if (key === builtFor) return;
        builtFor = key;
        const k = Math.floor(radius / spacing);
        const kin = Math.max(0, Math.floor((inner * 0.8) / spacing) - 1);
        let count = 0;
        for (let j = -k; j <= k && count < MAX_INSTANCES; j++) {
          for (let i = -k; i <= k && count < MAX_INSTANCES; i++) {
            const d2 = i * i + j * j;
            if (d2 > k * k || d2 < kin * kin) continue;
            offsets[count * 2] = i * spacing;
            offsets[count * 2 + 1] = j * spacing;
            count++;
          }
        }
        offsetAttr.needsUpdate = true;
        geometry.instanceCount = count;
      },
      update(camera, dt, wind, wash) {
        const s = uniforms.spacing.value;
        uniforms.grassOrigin.value.set(Math.round(camera.position.x / s) * s, Math.round(camera.position.z / s) * s);
        uniforms.time.value += dt;
        uniforms.windVec.value.set(wind.x, wind.z).multiplyScalar(0.045);
        uniforms.washPos.value.copy(wash.position);
        uniforms.washStrength.value = wash.strength;
      },
      dispose() {
        geometry.dispose();
        material.dispose();
      },
    };
  }
  const nearLayer = makeLayer();
  const farLayer = makeLayer();
  const group = new THREE.Group();
  group.add(nearLayer.mesh, farLayer.mesh);

  return {
    mesh: group,
    colorTex, // rgb grass colour, a density: also used to paint flat grass onto the terrain
    configure({ enabled, radius, density, height }) {
      group.visible = enabled;
      const nearR = Math.min(NEAR_RADIUS, radius);
      nearLayer.configure(0, nearR, density, height, 0.26);
      farLayer.mesh.visible = radius > nearR;
      if (radius > nearR) farLayer.configure(nearR, radius, density, height, 0.6);
    },
    // wind: Vector3 (m/s), wash: { position, strength 0..1 }
    update(camera, dt, wind, wash) {
      nearLayer.update(camera, dt, wind, wash);
      farLayer.update(camera, dt, wind, wash);
    },
    // The ground changed in these areas [x0, z0, x1, z1] (enemy earthworks): re-read it
    refresh(boxes) {
      heightTex.needsUpdate = true;
      const cellOf = (v) => Math.min(pn, Math.max(0, Math.floor((v + half) / PARAM_CELL)));
      for (const [x0, z0, x1, z1] of boxes) fill(cellOf(x0), cellOf(z0), cellOf(x1) + 1, cellOf(z1) + 1);
      colorTex.needsUpdate = true;
      paramTex.needsUpdate = true;
    },
    dispose() {
      nearLayer.dispose();
      farLayer.dispose();
      clump.dispose();
      heightTex.dispose();
      colorTex.dispose();
      paramTex.dispose();
    },
  };
}
