import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createTerrainLod } from './terrain.js';
import { createSky } from './sky.js';
import { buildVegetation, createVegetationMaterials } from './vegetation.js';
import { buildStructures } from './structures.js';
import { createVehicles } from './vehicles.js';
import { createEffects } from './effects.js';
import { createGrass } from './grass.js';
import { createChunks, disposeTree } from './chunks.js';
import { StaticColliders } from './colliders.js';
import { flatMaterial } from './meshUtils.js';
import { mulberry32 } from './random.js';
import { createCameraFx } from '../render/CameraFx.js';

const CHUNK_SIZE = 256; // m, multiple of every terrain cell size
const CAMERA_OFFSET = new THREE.Vector3(0, 0.03, -0.08); // body frame: slightly up, at the nose
const OBSERVER_FOV = 55; // deg vertical, "second drone" filming the strike
const OBSERVER_DISTANCE = 28;
const OBSERVER_HEIGHT = 12;
const OBSERVER_ORBIT = 0.12; // rad/s
const NIGHT_VIEW = 320; // m, max render distance at night
const SHADE_OPACITY = { shadowsOff: 0.32, shadowsOn: 0.14 }; // fake crown shade, lighter when real shadows exist

// Flat ground around the map, as a ring so it never overlaps (and z-fights) the
// terrain. The terrain is flattened to y = 0 at its edges, so the seam is closed.
function createOuterGround(inner, outer) {
  const h = inner / 2;
  const o = outer / 2;
  const strip = (x0, x1, z0, z1) =>
    new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, 0, (z0 + z1) / 2);
  const geo = mergeGeometries([
    strip(-o, o, -o, -h), // north
    strip(-o, o, h, o), // south
    strip(-o, -h, -h, h), // west
    strip(h, o, -h, h), // east
  ]);
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x4f5a30 }));
  mesh.receiveShadow = true;
  return mesh;
}

// Tileable noise for close-up ground detail: R fine grain, G medium blotches
function createDetailTexture() {
  const N = 256;
  const rand = mulberry32(99);
  const smooth = (scale) => {
    const g = new Float32Array(scale * scale).map(() => rand());
    return (x, y) => {
      const fx = (x / N) * scale;
      const fy = (y / N) * scale;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const ty = fy - iy;
      const at = (a, b) => g[((b % scale) + scale) % scale * scale + (((a % scale) + scale) % scale)];
      const u = tx * tx * (3 - 2 * tx);
      const v = ty * ty * (3 - 2 * ty);
      return at(ix, iy) * (1 - u) * (1 - v) + at(ix + 1, iy) * u * (1 - v) + at(ix, iy + 1) * (1 - u) * v + at(ix + 1, iy + 1) * u * v;
    };
  };
  const f1 = smooth(64);
  const f2 = smooth(128);
  const m1 = smooth(8);
  const m2 = smooth(16);
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      data[i] = (f1(x, y) * 0.6 + f2(x, y) * 0.4) * 255;
      data[i + 1] = (m1(x, y) * 0.6 + m2(x, y) * 0.4) * 255;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// Tileable "grass seen from above": short light and dark blade strokes on mid grey
function createBladeTexture() {
  const N = 256;
  const rand = mulberry32(17);
  const data = new Uint8Array(N * N * 4).fill(128);
  for (let k = 0; k < 4500; k++) {
    const v = rand() < 0.55 ? 170 + rand() * 70 : 30 + rand() * 60;
    const a = rand() * Math.PI * 2;
    const len = 3 + rand() * 9;
    let x = rand() * N;
    let y = rand() * N;
    for (let t = 0; t < len; t++) {
      const i = ((Math.floor(y) & (N - 1)) * N + (Math.floor(x) & (N - 1))) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      x += Math.cos(a);
      y += Math.sin(a);
    }
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// Lambert terrain + world-space dirt texture that fades out with distance, and optional flat
// grass painted from the grass colour/density map (no geometry: the cheap grass mode)
function createTerrainMaterial() {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  const uniforms = {
    detailMap: { value: createDetailTexture() },
    detailStrength: { value: 1 },
    grassColorMap: { value: null },
    grassPattern: { value: createBladeTexture() },
    grassFlat: { value: 0 },
    mapHalf: { value: 1000 },
    mapSize: { value: 2000 },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTerrainPos;\nuniform sampler2D detailMap, grassColorMap, grassPattern;\nuniform float detailStrength, grassFlat, mapHalf, mapSize;')
      .replace('#include <color_fragment>', /* glsl */ `#include <color_fragment>
        float dd = length(vTerrainPos - cameraPosition);
        float fine = texture2D(detailMap, vTerrainPos.xz * 0.45).r;
        float mid = texture2D(detailMap, vTerrainPos.xz * 0.06).g;
        float k = detailStrength * (1.0 - smoothstep(25.0, 150.0, dd));
        diffuseColor.rgb *= mix(1.0, 0.76 + 0.44 * fine, k) * mix(1.0, 0.86 + 0.28 * mid, detailStrength);
        if (grassFlat > 0.0) {
          vec4 gc = texture2D(grassColorMap, (vTerrainPos.xz + mapHalf) / mapSize);
          // tufts ~10-30 cm near (texture repeats every 3 m), clumps further out
          float bl = texture2D(grassPattern, vTerrainPos.xz * 0.33).r;
          float bl2 = texture2D(grassPattern, vTerrainPos.xz * 0.07 + 0.31).r;
          float nearF = 1.0 - smoothstep(8.0, 70.0, dd);
          float pattern = mix(0.35 + 0.65 * bl2, bl, nearF);
          vec3 grassCol = gc.rgb * (0.35 + 1.05 * pattern);
          diffuseColor.rgb = mix(diffuseColor.rgb, grassCol, grassFlat * gc.a * 0.8);
        }`);
  };
  material.userData.uniforms = uniforms;
  return material;
}

export function createWorld(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  const fx = createCameraFx(renderer);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(90, 1, 0.05, 2500);
  const sky = createSky(scene);

  // Shared materials survive map rebuilds
  const terrainMaterial = createTerrainMaterial();
  const structureMaterial = flatMaterial();
  const vegetationMaterials = createVegetationMaterials();
  const shared = new Set([terrainMaterial, structureMaterial, ...Object.values(vegetationMaterials)]);

  // Current map; replaced by build()
  let layout = null;
  let chunks = null;
  let colliders = null;
  let vehicles = null;
  let terrain = null;
  let vegetation = null;
  let grass = null;
  let dynamicGroup = null;
  let outer = null;
  const effects = createEffects(scene, (x, z) => (layout ? layout.heightAt(x, z) : 0));

  // Camera + settings state
  const uptilt = new THREE.Quaternion();
  const offset = new THREE.Vector3();
  let fovH = 120;
  let renderDistance = 700;
  let detailDistance = 220;
  let night = false;
  let observing = false;
  let graphics = null;
  const flightState = { wind: new THREE.Vector3(), wash: { position: new THREE.Vector3(0, -1000, 0), strength: 0 } };
  const updateProjection = () => {
    const aspect = window.innerWidth / window.innerHeight;
    camera.aspect = aspect;
    camera.fov = observing ? OBSERVER_FOV : (2 * Math.atan(Math.tan((fovH * Math.PI) / 360) / aspect) * 180) / Math.PI;
    camera.updateProjectionMatrix();
  };
  updateProjection();
  const observerOffset = new THREE.Vector3();

  window.addEventListener('resize', () => {
    updateProjection();
    renderer.setSize(window.innerWidth, window.innerHeight);
    fx.resize();
  });

  // Shadow flags for everything in the static chunks (terrain meshes set their own)
  function setShadowFlags(root) {
    root.traverse((o) => {
      if (!o.isMesh || o.material === terrainMaterial) return;
      const shade = o.material === vegetationMaterials.shade;
      o.castShadow = !shade && !o.material.polygonOffset;
      o.receiveShadow = !shade;
    });
  }

  function clear() {
    if (!layout) return;
    scene.remove(chunks.root, dynamicGroup, outer, grass.mesh);
    disposeTree(chunks.root, shared);
    disposeTree(outer);
    vehicles.dispose();
    vegetation.dispose();
    grass.dispose();
    effects.reset();
  }

  return {
    scene,
    camera,
    get layout() {
      return layout;
    },
    get vehicles() {
      return vehicles;
    },
    effects,
    get spawn() {
      const l = layout.launch;
      return { position: new THREE.Vector3(l.x, 0, l.z), yaw: l.yaw };
    },
    heightAt(x, z) {
      return layout.heightAt(x, z);
    },

    // Replace the whole map with a new layout. vegDetail: 'low' | 'medium' | 'high'
    build(newLayout, { vegDetail = 'medium' } = {}) {
      clear();
      layout = newLayout;
      // Face the enemy from the launch point
      const l = layout.launch;
      l.yaw = Math.atan2(-(layout.enemyCenter.x - l.x), -(layout.enemyCenter.z - l.z));

      chunks = createChunks(layout.size, CHUNK_SIZE);
      colliders = new StaticColliders();
      terrain = createTerrainLod(layout, chunks, terrainMaterial);
      terrain.prime(l.x, l.z, detailDistance);
      buildStructures(layout, chunks, colliders, structureMaterial);
      vegetation = buildVegetation(layout, chunks, colliders, vegetationMaterials, vegDetail);
      setShadowFlags(chunks.root);
      scene.add(chunks.root);

      dynamicGroup = new THREE.Group();
      vehicles = createVehicles(dynamicGroup, layout, colliders, effects);
      scene.add(dynamicGroup);

      grass = createGrass(layout);
      scene.add(grass.mesh);
      terrainMaterial.userData.uniforms.grassColorMap.value = grass.colorTex;
      terrainMaterial.userData.uniforms.mapHalf.value = layout.half;
      terrainMaterial.userData.uniforms.mapSize.value = layout.size;

      outer = createOuterGround(layout.size, layout.size * 4);
      scene.add(outer);
      if (graphics) this.applyGraphics();
    },

    // First obstacle touching the sphere: { kind: 'tree' | 'bush' | 'building' | 'pole' | 'wreck' }
    // or { kind: 'vehicle', vehicle, zone, effect }; null if clear. Ground is handled by the caller.
    hitTest(p, r) {
      return colliders.hits(p, r) || vehicles.hits(p, r);
    },

    applySettings({ camera: cam, env, map, graphics: g }) {
      uptilt.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (cam.uptilt * Math.PI) / 180);
      fovH = cam.fov;
      updateProjection();
      renderDistance = map.renderDistance;
      detailDistance = map.detailDistance;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, map.renderScale));
      night = env.night;
      graphics = g;
      this.applyGraphics();
    },

    applyGraphics() {
      const g = graphics;
      sky.apply({ night, viewDistance: night ? Math.min(renderDistance, NIGHT_VIEW) : renderDistance, clouds: g.clouds, shadows: g.shadows });
      vegetationMaterials.shade.opacity = sky.shadowsOn ? SHADE_OPACITY.shadowsOn : SHADE_OPACITY.shadowsOff;
      terrainMaterial.userData.uniforms.detailStrength.value = g.groundTexture;
      fx.configure(g);
      // grass: 'off' | 'flat' (painted on the ground) | '3d' (blades + painted ground under them)
      terrainMaterial.userData.uniforms.grassFlat.value = g.grass === 'off' ? 0 : 1;
      if (grass) grass.configure({ enabled: g.grass === '3d', radius: g.grassRadius, density: g.grassDensity, height: g.grassHeight });
      if (vehicles) vehicles.setDust(g.dust);
    },

    // Per-frame flight context for grass: wind (m/s) and prop wash under the drone
    setFlightState(windBase, windGust, washPosition, washStrength) {
      flightState.wind.copy(windBase).add(windGust);
      flightState.wash.position.copy(washPosition);
      flightState.wash.strength = washStrength;
    },

    // threat: the drone ({ position }) when it can be seen, else null
    update(dt, threat, reactions, alertness) {
      vehicles.update(dt, threat, reactions, alertness);
      effects.update(dt);
    },

    // FPV camera rigidly mounted on the drone with uptilt. pose: { position, quaternion }
    updateCamera(pose) {
      if (observing) {
        observing = false;
        updateProjection();
      }
      offset.copy(CAMERA_OFFSET).applyQuaternion(pose.quaternion);
      camera.position.copy(pose.position).add(offset);
      camera.quaternion.copy(pose.quaternion).multiply(uptilt);
    },

    // Slow orbit around a point, starting behind `fromDir` (the strike's approach direction)
    updateObserverCamera(center, fromDir, t) {
      if (!observing) {
        observing = true;
        updateProjection();
      }
      const a = Math.atan2(-fromDir.x, -fromDir.z) + t * OBSERVER_ORBIT;
      observerOffset.set(Math.sin(a) * OBSERVER_DISTANCE, OBSERVER_HEIGHT, Math.cos(a) * OBSERVER_DISTANCE);
      camera.position.copy(center).add(observerOffset);
      camera.position.y = Math.max(camera.position.y, layout.heightAt(camera.position.x, camera.position.z) + 3);
      camera.lookAt(center);
    },

    render(dt = 0) {
      sky.follow(camera, dt);
      chunks.update(camera, night ? Math.min(renderDistance, NIGHT_VIEW) : renderDistance);
      terrain.update(camera, detailDistance);
      vegetation.update(camera, detailDistance);
      grass.update(camera, dt, flightState.wind, flightState.wash);
      fx.render(scene, camera, dt);
    },
  };
}
