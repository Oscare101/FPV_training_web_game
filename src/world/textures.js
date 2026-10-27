import * as THREE from 'three';

// Building surface textures: CC0 photo textures from ambientCG (see public/textures/CREDITS.md),
// 512 px, applied in world space (metres, see mergeTextured) and tinted by vertex colour, so one
// shared material per surface serves every building. tile: [u, v] metres per texture repeat.
export const SURFACES = {
  brick: { file: 'brick.jpg', tile: [2.54, 1.27] },
  plaster: { file: 'plaster.jpg', tile: [4, 4], contrast: 0.35 }, // worn plaster, bricks showing through: toned down
  silicate: { file: 'silicate.jpg', tile: [1.23, 1.23], contrast: 0.6 },
  concrete: { file: 'concrete.jpg', tile: [3, 3] },
  metal: { file: 'metal.jpg', tile: [2, 2] },
  corrugated: { file: 'corrugated.jpg', tile: [5.1, 2.56] }, // asbestos slate / steel sheets, ridges along u
  planks: { file: 'planks.jpg', tile: [2.4, 2.4] },
};

const materials = new Map();
const canLoad = typeof document !== 'undefined';
const base = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';

// Pull every pixel toward the image's mean colour: k = 1 keeps it, 0 makes it flat
function lowerContrast(img, k) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  const mean = [0, 0, 0];
  for (let i = 0; i < px.length; i += 4) for (let j = 0; j < 3; j++) mean[j] += px[i + j];
  for (let j = 0; j < 3; j++) mean[j] /= px.length / 4;
  for (let i = 0; i < px.length; i += 4) for (let j = 0; j < 3; j++) px[i + j] = mean[j] + (px[i + j] - mean[j]) * k;
  ctx.putImageData(d, 0, 0);
  return c;
}

// Shared material for a surface (never disposed: userData.shared)
export function surfaceMaterial(name) {
  if (materials.has(name)) return materials.get(name);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.userData.shared = true;
  if (canLoad) {
    const def = SURFACES[name];
    const tex = new THREE.Texture();
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const img = new Image();
    img.onload = () => {
      tex.image = def.contrast ? lowerContrast(img, def.contrast) : img;
      tex.needsUpdate = true;
    };
    img.src = `${base}textures/${def.file}`;
    mat.map = tex;
  }
  materials.set(name, mat);
  return mat;
}
