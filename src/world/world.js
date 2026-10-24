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
import { flatMaterial, mergeParts } from './meshUtils.js';
import { mulberry32 } from './random.js';
import { createCameraFx } from '../render/CameraFx.js';
import { installEnvShade, setDroneShadow, setSurface } from '../render/envShade.js';
import { createWater } from './water.js';
import { createPrecip } from './precip.js';
import { createDroneModel } from './droneModel.js';

const CHUNK_SIZE = 256; // m, multiple of every terrain cell size
const CAMERA_OFFSET = new THREE.Vector3(0, 0.03, -0.08); // body frame: slightly up, at the nose
const OBSERVER_FOV = 55; // deg vertical, "second drone" filming the strike
const MENU_FOV = 38; // deg vertical, main menu close-up of the drone
const MENU = { distance: 1.05, height: 0.1, swing: 0.6, shift: 0.17, hover: 1.6 }; // camera m at 5", swing rad around the sun side; drone shown left of centre
const OBSERVER_DISTANCE = 28;
const OBSERVER_HEIGHT = 12;
const OBSERVER_ORBIT = 0.12; // rad/s
// Fake crown shade under trees: a soft blob. With real shadows it stays faint (ambient occlusion) where the
// shadow map reaches and fades to full strength beyond it, where trees have no real shadow.
const SHADE = { opacity: 0.4, nearWithShadows: 0.3 };
const PREVIEW = { orbitDistance: 9, orbitHeight: 3.5, orbitSpeed: 0.25, aboveBack: 45, aboveHeight: 55, aboveAhead: 60 };

// Flat ground around the map, as a ring so it never overlaps (and z-fights) the
// terrain. The terrain is flattened to y = 0 at its edges, so the seam is closed.
function createOuterGround(inner, outer, color) {
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
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
  mesh.material.defines = { FPV_NO_SNOW: '' };
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
function patchShadeMaterial(material) {
  const uniforms = { shadeNear: { value: 1 }, shadeFadeStart: { value: 1e5 }, shadeFadeEnd: { value: 2e5 } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vRadial;\nvarying float vShadeDist;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vRadial = length(position.xz);
        vShadeDist = length((modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz - cameraPosition);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vRadial;\nvarying float vShadeDist;\nuniform float shadeNear, shadeFadeStart, shadeFadeEnd;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.a *= (1.0 - smoothstep(0.25, 1.0, vRadial)) * mix(shadeNear, 1.0, smoothstep(shadeFadeStart, shadeFadeEnd, vShadeDist));`);
  };
  material.userData.uniforms = uniforms;
}

function createTerrainMaterial() {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  material.defines = { FPV_NO_SNOW: '' }; // snow cover is in the ground colours
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
  installEnvShade(); // before any material compiles
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
  patchShadeMaterial(vegetationMaterials.shade);
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
  const droneModel = createDroneModel();
  const droneMesh = droneModel.group;
  scene.add(droneMesh);
  let vehiclesOn = true;
  let menuView = false;
  const menuPose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  const menuBase = { layout: null, size: 0, a: 0 }; // clear camera angle for this map
  const menuRight = new THREE.Vector3();

  // Camera + settings state
  const uptilt = new THREE.Quaternion();
  const offset = new THREE.Vector3();
  let fovH = 120;
  let renderDistance = 700;
  let detailDistance = 220;
  let env = null;
  let season = 'summer';
  let water = null;
  const precip = createPrecip(scene);
  const prevCam = new THREE.Vector3();
  const camVel = new THREE.Vector3();
  let observing = false;
  let graphics = null;
  const flightState = { wind: new THREE.Vector3(), wash: { position: new THREE.Vector3(0, -1000, 0), strength: 0 } };
  const updateProjection = () => {
    const aspect = window.innerWidth / window.innerHeight;
    camera.aspect = aspect;
    camera.fov = menuView ? MENU_FOV : observing ? OBSERVER_FOV : (2 * Math.atan(Math.tan((fovH * Math.PI) / 360) / aspect) * 180) / Math.PI;
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
      o.castShadow = !shade && !o.material.polygonOffset && !o.material.userData.noCastShadow;
      o.receiveShadow = !shade;
    });
  }

  function clear() {
    if (!layout) return;
    scene.remove(chunks.root, dynamicGroup, outer, grass.mesh, water.mesh);
    water.dispose();
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
    renderer,
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
    // Projected point (NDC) -> where it shows on screen through the FPV lens distortion
    lensWarp(x, y, out) {
      return fx.toScreen(x, y, out);
    },
    // Water surface where the ground is below it (null if dry); frozen water is solid ground
    waterAt(x, z) {
      return layout.waterAt(x, z);
    },
    get waterFrozen() {
      return layout.water.frozen;
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
      dynamicGroup.visible = vehiclesOn;
      scene.add(dynamicGroup);

      water = createWater(layout);
      scene.add(water.mesh);
      grass = createGrass(layout);
      scene.add(grass.mesh);
      terrainMaterial.userData.uniforms.grassColorMap.value = grass.colorTex;
      terrainMaterial.userData.uniforms.mapHalf.value = layout.half;
      terrainMaterial.userData.uniforms.mapSize.value = layout.size;

      // colour of the flat ground outside: average of the map's edge, so no band shows (snow in winter)
      const edgeCol = new THREE.Color(0, 0, 0);
      const c = new THREE.Color();
      for (let k = 0; k < 64; k++) {
        const t = (k % 16) / 16 * layout.size - layout.half;
        const e = layout.half - 8;
        const [x, z] = [[t, -e], [t, e], [-e, t], [e, t]][k >> 4];
        edgeCol.add(layout.groundColor(x, z, c));
      }
      outer = createOuterGround(layout.size, layout.size * 4, edgeCol.multiplyScalar(1 / 64));
      scene.add(outer);
      if (graphics) this.applyGraphics();
    },

    // First obstacle touching the sphere: { kind: 'tree' | 'bush' | 'building' | 'pole' | 'wreck' }
    // or { kind: 'vehicle', vehicle, zone, effect }; null if clear. Ground is handled by the caller.
    hitTest(p, r) {
      return colliders.hits(p, r) || (vehiclesOn ? vehicles.hits(p, r) : null);
    },

    // Free Flight without enemies: vehicles hidden, not hittable, not driving
    setVehiclesEnabled(on) {
      vehiclesOn = on;
      if (dynamicGroup) dynamicGroup.visible = on;
    },

    applySettings({ camera: cam, env: settingsEnv, map, graphics: g }) {
      uptilt.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (cam.uptilt * Math.PI) / 180);
      fovH = cam.fov;
      updateProjection();
      renderDistance = map.renderDistance;
      detailDistance = map.detailDistance;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, map.renderScale));
      env = settingsEnv;
      season = map.season;
      graphics = g;
      this.applyGraphics();
    },

    applyGraphics() {
      const g = graphics;
      sky.apply({
        season, timeOfDay: env.timeOfDay, hour: env.hour, latitude: env.latitude, clouds: g.clouds, cloudShadows: g.cloudShadows,
        fog: env.fog, rain: env.rain, snowfall: env.snowfall, viewDistance: renderDistance, shadows: g.shadows,
      });
      const light = 1 - sky.state.dark * 0.8;
      precip.configure(env.rain, env.snowfall, light);
      setSurface(season === 'winter' ? 0.85 : env.snowfall * 0.5, env.rain * 0.9);
      const shade = vegetationMaterials.shade;
      const ext = sky.shadowExtent;
      shade.opacity = SHADE.opacity;
      shade.userData.uniforms.shadeNear.value = ext ? SHADE.nearWithShadows : 1;
      shade.userData.uniforms.shadeFadeStart.value = ext ? ext * 0.55 : 1e5;
      shade.userData.uniforms.shadeFadeEnd.value = ext ? ext * 0.95 : 2e5;
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

    // Drone shadow on the ground: pose { position, quaternion } or null; size in prop inches; spin 0..1
    setDrone(pose, size, spin, payload = false) {
      setDroneShadow(graphics?.droneShadow ? pose : null, size, spin, 0.85 - sky.state.dark * 0.25);
      droneMesh.visible = observing && !!pose;
      if (pose) {
        droneMesh.position.copy(pose.position);
        droneMesh.quaternion.copy(pose.quaternion);
        droneMesh.scale.setScalar(size / 5);
        droneModel.update(1 / 60, spin, payload);
      }
    },

    // threat: the drone ({ position }) when it can be seen, else null
    update(dt, threat, reactions, alertness) {
      if (vehiclesOn) vehicles.update(dt, threat, reactions, alertness);
      effects.update(dt);
    },

    // FPV camera rigidly mounted on the drone with uptilt. pose: { position, quaternion }
    updateCamera(pose) {
      if (observing) {
        observing = false;
        menuView = false;
        updateProjection();
      }
      offset.copy(CAMERA_OFFSET).applyQuaternion(pose.quaternion);
      camera.position.copy(pose.position).add(offset);
      camera.quaternion.copy(pose.quaternion).multiply(uptilt);
    },

    // Slow orbit around a point, starting behind `fromDir` (the strike's approach direction)
    updateObserverCamera(center, fromDir, t) {
      if (!observing || menuView) {
        observing = true;
        menuView = false;
        updateProjection();
      }
      const a = Math.atan2(-fromDir.x, -fromDir.z) + t * OBSERVER_ORBIT;
      observerOffset.set(Math.sin(a) * OBSERVER_DISTANCE, OBSERVER_HEIGHT, Math.cos(a) * OBSERVER_DISTANCE);
      camera.position.copy(center).add(observerOffset);
      camera.position.y = Math.max(camera.position.y, layout.heightAt(camera.position.x, camera.position.z) + 3);
      camera.lookAt(center);
    },

    // Main menu: the drone hovers over the launch pad, the camera circles it close up with the drone
    // left of centre (the menu panel is on the right). Returns the drone pose to draw.
    updateMenuCamera(t, size) {
      const k = size / 5;
      if (!menuView || !observing) {
        menuView = true;
        observing = true;
        updateProjection();
      }
      const l = layout.launch;
      const g = layout.heightAt(l.x, l.z);
      menuPose.position.set(l.x, g + MENU.hover + Math.sin(t * 1.3) * 0.03, l.z);
      // camera on the sun's side (the drone is lit, never a silhouette) where nothing blocks the view
      if (menuBase.layout !== layout || menuBase.size !== size) {
        const sun = sky.colors.sunDir;
        const a0 = Math.atan2(sun.x, sun.z);
        const p = new THREE.Vector3();
        menuBase.a = a0;
        for (const off of [0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.4, -1.4, 1.75, -1.75]) {
          const a = a0 + off;
          let clear = true;
          for (const f of [0.35, 0.7, 1, 1.4]) {
            p.set(l.x + Math.sin(a) * MENU.distance * k * f, menuPose.position.y + MENU.height * k * f, l.z + Math.cos(a) * MENU.distance * k * f);
            if (colliders.hits(p, 0.3 * k) || p.y < layout.heightAt(p.x, p.z) + 0.2) clear = false;
          }
          if (clear) {
            menuBase.a = a;
            break;
          }
        }
        menuBase.layout = layout;
        menuBase.size = size;
      }
      const a = menuBase.a + Math.sin(t * 0.1) * MENU.swing * 0.5;
      // nose turned three-quarters towards the camera
      menuPose.quaternion.setFromEuler(new THREE.Euler(Math.sin(t * 0.9) * 0.03, menuBase.a + Math.PI - 0.65 + Math.sin(t * 0.25) * 0.15, Math.sin(t * 0.7) * 0.04, 'YXZ'));
      camera.position.set(l.x + Math.sin(a) * MENU.distance * k, menuPose.position.y + MENU.height * k, l.z + Math.cos(a) * MENU.distance * k);
      menuRight.set(Math.cos(a), 0, -Math.sin(a)); // camera's right
      camera.lookAt(observerOffset.copy(menuPose.position).addScaledVector(menuRight, MENU.shift * k));
      return menuPose;
    },

    // Settings preview: 'orbit' circles the drone, 'above' looks over it towards where it faces
    updatePreviewCamera(mode, pose, t) {
      if (!observing || menuView) {
        observing = true;
        menuView = false;
        updateProjection();
      }
      const p = pose.position;
      if (mode === 'orbit') {
        const a = t * PREVIEW.orbitSpeed;
        camera.position.set(p.x + Math.sin(a) * PREVIEW.orbitDistance, p.y + PREVIEW.orbitHeight, p.z + Math.cos(a) * PREVIEW.orbitDistance);
        observerOffset.copy(p);
      } else {
        observerOffset.set(0, 0, -1).applyQuaternion(pose.quaternion).setY(0);
        if (observerOffset.lengthSq() < 1e-4) observerOffset.set(0, 0, -1);
        observerOffset.normalize();
        camera.position.copy(p).addScaledVector(observerOffset, -PREVIEW.aboveBack);
        camera.position.y = p.y + PREVIEW.aboveHeight;
        observerOffset.multiplyScalar(PREVIEW.aboveAhead).add(p);
      }
      camera.position.y = Math.max(camera.position.y, layout.heightAt(camera.position.x, camera.position.z) + 1.5);
      camera.lookAt(observerOffset);
    },

    render(dt = 0) {
      sky.follow(camera, dt);
      chunks.update(camera, Math.min(renderDistance, sky.state.viewDistance + 30)); // nothing past the fog
      if (dt > 0) camVel.subVectors(camera.position, prevCam).divideScalar(dt);
      if (camVel.lengthSq() > 1e4) camVel.set(0, 0, 0); // camera jumped
      prevCam.copy(camera.position);
      precip.update(camera, dt, flightState.wind, camVel, fx.height, (camera.fov * Math.PI) / 180);
      water.update(dt, sky.colors);
      terrain.update(camera, detailDistance);
      vegetation.update(camera, detailDistance);
      grass.update(camera, dt, flightState.wind, flightState.wash);
      fx.render(scene, camera, dt);
    },
  };
}
