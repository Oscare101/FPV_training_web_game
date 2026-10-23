import * as THREE from 'three';

const GUST_TAU = 3; // s, slow gusts
const TURB_TAU = 0.4; // s, fast turbulence
const TORQUE_TAU = 0.15; // s, turbulence bumps on the airframe
const ROUGHNESS = 0.05; // m, log wind profile surface roughness
const REF_HEIGHT = 20; // m, height where wind = configured speed

function gaussian() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

// Ornstein–Uhlenbeck step: mean-reverting noise with std sigma and correlation time tau.
function ou(v, dt, tau, sigma) {
  const k = Math.sqrt((2 * dt) / tau) * sigma;
  v.x += -(v.x / tau) * dt + k * gaussian();
  v.y += -(v.y / tau) * dt + k * gaussian() * 0.3; // weaker vertical component
  v.z += -(v.z / tau) * dt + k * gaussian();
}

export class Wind {
  constructor() {
    this.base = new THREE.Vector3();
    this.gust = new THREE.Vector3();
    this.turb = new THREE.Vector3();
    this.torqueNoise = new THREE.Vector3();
    this.speed = 0;
    this.gustiness = 0;
    this.turbulence = 0;
  }

  // dirDeg: where the wind blows FROM, 0 = north (-Z), 90 = east (+X)
  configure({ windSpeed, windDir, gustiness, turbulence }) {
    const a = (windDir * Math.PI) / 180;
    this.base.set(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(windSpeed);
    this.speed = windSpeed;
    this.gustiness = gustiness;
    this.turbulence = turbulence;
  }

  step(dt) {
    const g = this.speed * this.gustiness;
    ou(this.gust, dt, GUST_TAU, g * 0.5);
    ou(this.turb, dt, TURB_TAU, g * 0.25);
    ou(this.torqueNoise, dt, TORQUE_TAU, this.speed * this.turbulence * 1.5); // rad/s²
  }

  // Wind is weaker near the ground (log profile).
  profile(heightAboveGround) {
    const h = Math.max(heightAboveGround, ROUGHNESS * 1.5);
    return Math.min(1.3, Math.log(h / ROUGHNESS) / Math.log(REF_HEIGHT / ROUGHNESS));
  }

  velocityAt(heightAboveGround, out) {
    return out.copy(this.base).add(this.gust).add(this.turb).multiplyScalar(this.profile(heightAboveGround));
  }

  torqueAt(heightAboveGround, out) {
    return out.copy(this.torqueNoise).multiplyScalar(this.profile(heightAboveGround));
  }
}
