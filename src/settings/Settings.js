import { DEFAULT_RATES } from '../flight/rates.js';
import { DRONE_PRESETS } from '../flight/presets.js';
import { MAP_DEFAULTS } from '../world/gen/layout.js';
import { LOOK_PRESETS } from '../render/CameraFx.js';

const STORAGE_KEY = 'fpv-trainer.settings.v1';

export function presetValues(name) {
  const { label: _label, ...values } = DRONE_PRESETS[name];
  return values;
}

export function defaultSettings() {
  return {
    drone: { preset: '5inch', ...presetValues('5inch'), batterySim: true },
    rates: structuredClone(DEFAULT_RATES),
    camera: { uptilt: 30, fov: 120 }, // deg, FOV is horizontal
    env: { windSpeed: 3, windDir: 0, gustiness: 0.4, turbulence: 0.2, night: false }, // m/s, deg (from), 0..1, 0..1
    audio: { volume: 0.6, muted: false },
    // targetMode: 'easy' exact marker on one target | 'medium' rough direction + "near" | 'hard' nothing
    mission: { targetMode: 'easy', enemyReaction: true, alertness: 1 },
    // seed 0 = random; newMapEachMission: generate a fresh map for every new strike mission
    // renderScale: pixel ratio cap; detailDistance: radius of full-detail terrain/vegetation
    // look: 'off' | 'clean' | 'digital' | 'analog' camera style; the values below are its preset, editable
    graphics: {
      look: 'digital', ...LOOK_PRESETS.digital,
      grass: 'flat', grassDensity: 1, grassRadius: 70, grassHeight: 1, propWash: true, // grass: 'off' | 'flat' | '3d'
      shadows: 'medium', clouds: 0.45, groundTexture: 1, dust: true,
    },
    map: { ...MAP_DEFAULTS, renderDistance: 700, detailDistance: 220, renderScale: 1.5, vegDetail: 'medium', seed: 0, newMapEachMission: true },
  };
}

// Copy saved values over defaults, keeping only known keys of the same type.
function mergeKnown(target, saved) {
  if (!saved || typeof saved !== 'object') return;
  for (const key of Object.keys(target)) {
    const t = target[key];
    const s = saved[key];
    if (t && typeof t === 'object') mergeKnown(t, s);
    else if (typeof s === typeof t) target[key] = s;
  }
}

export class Settings {
  constructor() {
    this.data = defaultSettings();
    try {
      mergeKnown(this.data, JSON.parse(localStorage.getItem(STORAGE_KEY)));
    } catch {
      // corrupted or unavailable storage: defaults
    }
    this.listeners = new Set();
  }

  get(path) {
    return path.split('.').reduce((o, k) => o[k], this.data);
  }

  set(path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    keys.reduce((o, k) => o[k], this.data)[last] = value;
    if (path.startsWith('drone.') && path !== 'drone.preset' && path !== 'drone.batterySim') {
      this.data.drone.preset = 'custom';
    }
    this.commit();
  }

  applyLook(name) {
    Object.assign(this.data.graphics, LOOK_PRESETS[name] ?? {}, { look: name });
    this.commit();
  }

  applyPreset(name) {
    Object.assign(this.data.drone, presetValues(name), { preset: name });
    this.commit();
  }

  reset() {
    this.data = defaultSettings();
    this.commit();
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  commit() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // storage unavailable: session only
    }
    for (const fn of this.listeners) fn(this.data);
  }
}
