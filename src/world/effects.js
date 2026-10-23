import * as THREE from 'three';

const MAX_PUFFS = 400;
const MAX_SCORCH = 16;
const FIREBALL_TIME = 0.6; // s
const FLASH_TIME = 0.25;

// Explosion fireball + flash, pooled smoke puffs, scorch marks and smoke columns for
// burning vehicles. Cheap: one instanced mesh for all smoke, one reusable fireball,
// and a single point light that always exists (adding lights at runtime recompiles shaders).
export function createEffects(scene, heightAt) {
  const fireball = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, depthWrite: false, fog: false })
  );
  fireball.visible = false;
  scene.add(fireball);

  const flash = new THREE.PointLight(0xffb060, 0, 80, 1.5);
  scene.add(flash);

  const smoke = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, transparent: true, opacity: 0.8, depthWrite: false }),
    MAX_PUFFS
  );
  smoke.frustumCulled = false;
  smoke.count = 0;
  scene.add(smoke);
  const puffs = []; // { pos, vel, age, life, size, shade, tint, rise }
  let next = 0;

  const scorchGeo = new THREE.CircleGeometry(1, 12).rotateX(-Math.PI / 2);
  const scorchMat = new THREE.MeshLambertMaterial({ color: 0x1e1c18, polygonOffset: true, polygonOffsetFactor: -2 });
  const scorches = [];

  const emitters = []; // burning vehicles: { target: Object3D, rate, acc, until }
  let blast = null; // { pos, age }

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const col = new THREE.Color();

  const GREY = [1, 1, 1];
  const DUST = [1.35, 1.15, 0.88];
  function spawnPuff(pos, vel, life, size, shade, tint = GREY, rise = 0.6) {
    const p = { pos: pos.clone(), vel: vel.clone(), age: 0, life, size, shade, tint, rise };
    if (puffs.length < MAX_PUFFS) puffs.push(p);
    else puffs[next++ % MAX_PUFFS] = p; // recycle the oldest slot
  }

  const v = new THREE.Vector3();
  function explode(pos) {
    blast = { pos: pos.clone(), age: 0 };
    fireball.position.copy(pos);
    flash.position.copy(pos).y += 1;
    for (let i = 0; i < 26; i++) {
      v.set(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 4);
      spawnPuff(pos, v, 3 + Math.random() * 3, 1.2 + Math.random() * 1.5, 0.15 + Math.random() * 0.2);
    }
    const ground = heightAt(pos.x, pos.z);
    if (pos.y - ground < 3) {
      const mark = new THREE.Mesh(scorchGeo, scorchMat);
      mark.position.set(pos.x, ground + 0.02, pos.z);
      mark.scale.setScalar(2 + Math.random());
      scene.add(mark);
      scorches.push(mark);
      if (scorches.length > MAX_SCORCH) scene.remove(scorches.shift());
    }
  }

  // Dust kicked up by a vehicle; amount 0..1
  const dustPos = new THREE.Vector3();
  const dustVel = new THREE.Vector3();
  function dust(x, y, z, amount) {
    dustPos.set(x + (Math.random() - 0.5), y, z + (Math.random() - 0.5));
    dustVel.set((Math.random() - 0.5) * 0.8, 0.3 + Math.random() * 0.4, (Math.random() - 0.5) * 0.8);
    spawnPuff(dustPos, dustVel, 2 + amount * 2, 0.6 + amount * 1.1, 0.42 + Math.random() * 0.08, DUST, 0.08);
  }

  // Continuous smoke column from an object (burning vehicle); duration Infinity = until reset
  function burn(target, rate = 4, duration = Infinity) {
    emitters.push({ target, rate, acc: 0, until: duration });
  }

  function reset() {
    blast = null;
    fireball.visible = false;
    flash.intensity = 0;
    puffs.length = 0;
    emitters.length = 0;
    for (const mark of scorches) scene.remove(mark);
    scorches.length = 0;
  }

  const emitPos = new THREE.Vector3();
  function update(dt) {
    if (blast) {
      blast.age += dt;
      const t = blast.age / FIREBALL_TIME;
      fireball.visible = t < 1;
      fireball.scale.setScalar(1 + 5 * Math.sqrt(Math.min(t, 1)));
      fireball.material.opacity = Math.max(0, 1 - t);
      flash.intensity = Math.max(0, 1 - blast.age / FLASH_TIME) * 400;
      if (t >= 1 && blast.age > FLASH_TIME) blast = null;
    }

    for (const e of emitters) {
      e.until -= dt;
      if (e.until <= 0) continue;
      e.acc += dt * e.rate;
      while (e.acc >= 1) {
        e.acc -= 1;
        emitPos.copy(e.target.position).add(v.set((Math.random() - 0.5) * 1.5, 2, (Math.random() - 0.5) * 1.5));
        spawnPuff(emitPos, v.set((Math.random() - 0.5) * 0.6, 2 + Math.random(), (Math.random() - 0.5) * 0.6), 6, 1 + Math.random(), 0.12 + Math.random() * 0.1);
      }
    }

    let n = 0;
    for (const p of puffs) {
      p.age += dt;
      if (p.age >= p.life) continue;
      puffs[n] = p; // compact: drop expired puffs
      p.vel.multiplyScalar(Math.exp(-dt * 1.5));
      p.vel.y += dt * p.rise; // hot smoke rises, dust barely
      p.pos.addScaledVector(p.vel, dt);
      const t = p.age / p.life;
      const size = p.size * (1 + t * 3) * (t > 0.7 ? (1 - t) / 0.3 : 1);
      smoke.setMatrixAt(n, m.compose(p.pos, q, s.setScalar(size)));
      const g = p.shade + t * 0.25;
      smoke.setColorAt(n, col.setRGB(g * p.tint[0], g * p.tint[1], g * p.tint[2]));
      n++;
    }
    puffs.length = n;
    smoke.count = n;
    smoke.instanceMatrix.needsUpdate = true;
    if (smoke.instanceColor) smoke.instanceColor.needsUpdate = true;
  }

  return { explode, burn, dust, reset, update };
}
