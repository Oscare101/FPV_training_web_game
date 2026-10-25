import { DEFAULT_RATES } from '../flight/rates.js';
import { DRONE_PRESETS } from '../flight/presets.js';
import { MAP_DEFAULTS } from '../world/gen/layout.js';
import { LOOK_PRESETS } from '../render/CameraFx.js';

const STORAGE_KEY = 'fpv-trainer.settings.v1';
const VERSION = 3; // bump with a migration below when defaults change meaning

// Weather presets: one choice sets clouds, rain, snow and fog
export const WEATHER_PRESETS = {
  clear: { 'graphics.clouds': 0.12, 'env.rain': 0, 'env.snowfall': 0, 'env.fog': 0 },
  partly: { 'graphics.clouds': 0.45, 'env.rain': 0, 'env.snowfall': 0, 'env.fog': 0 },
  overcast: { 'graphics.clouds': 0.95, 'env.rain': 0, 'env.snowfall': 0, 'env.fog': 0.12 },
  rain: { 'graphics.clouds': 1, 'env.rain': 0.7, 'env.snowfall': 0, 'env.fog': 0.25 },
  snow: { 'graphics.clouds': 0.95, 'env.rain': 0, 'env.snowfall': 0.6, 'env.fog': 0.2 },
  fog: { 'graphics.clouds': 0.6, 'env.rain': 0, 'env.snowfall': 0, 'env.fog': 0.75 },
};

export function presetValues(name) {
  const { label: _label, ...values } = DRONE_PRESETS[name];
  return values;
}

export function defaultSettings() {
  return {
    drone: { preset: '5inch', ...presetValues('5inch'), batterySim: true },
    rates: structuredClone(DEFAULT_RATES),
    camera: { uptilt: 30, fov: 120 }, // deg, FOV is horizontal
    version: VERSION,
    // wind m/s, deg (from), 0..1, 0..1; weather: preset name; rain/snowfall/fog 0..1
    // timeOfDay: 'morning' | 'day' | 'evening' | 'night' | 'custom' (uses hour, solar time); latitude deg N
    env: {
      windSpeed: 3, windDir: 0, gustiness: 0.4, turbulence: 0,
      weather: 'partly', rain: 0, snowfall: 0, fog: 0, timeOfDay: 'day', hour: 12.75, latitude: 48.5,
    },
    audio: { volume: 0.6, muted: false },
    // Game modes. free: Free Flight sandbox (its map/weather are env + map below). strike: difficulty
    // 'easy' exact marker | 'medium' rough direction | 'hard' nothing; conditions 'random' (rolled per
    // mission) | 'free' (the Free Flight weather). hunt: variant 'sweep' (clear all) | 'endless'
    // (vehicles respawn, duration s, 0 = no limit); a fixed battlefield: seed + conditions.
    game: { mode: 'free' },
    free: { enemies: true, reaction: true, alertness: 1, liveCharge: true, battery: false },
    strike: { difficulty: 'easy', conditions: 'random' },
    hide: { difficulty: 'normal', shelter: 'random' },
    hunt: { variant: 'sweep', duration: 300, seed: 1 + Math.floor(Math.random() * 99999), season: 'summer', timeOfDay: 'day', weather: 'partly' },
    // seed 0 = random
    // renderScale: pixel ratio cap; detailDistance: radius of full-detail terrain/vegetation
    // look: 'off' | 'clean' | 'digital' | 'analog' camera style; the values below are its preset, editable
    graphics: {
      look: 'digital', ...LOOK_PRESETS.digital,
      grass: 'flat', grassDensity: 1, grassRadius: 70, grassHeight: 1, propWash: true, // grass: 'off' | 'flat' | '3d'
      shadows: 'medium', clouds: 0.45, cloudShadows: 0.7, droneShadow: true, groundTexture: 1, dust: true,
    },
    // HUD: element toggles + style; compass: 'rose' | 'tape' | 'off'
    osd: {
      compass: 'rose', compassWind: true, home: true, timer: true, battery: true, mah: true, throttle: true,
      speed: true, altitude: true, crosshair: true, hints: true, fps: true, scale: 1, color: 'white', opacity: 1, margin: 20,
    },
    screenshot: { hud: true, stamp: true },
    map: { ...MAP_DEFAULTS, renderDistance: 700, detailDistance: 220, renderScale: 1.5, vegDetail: 'medium', seed: 0 },
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
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      mergeKnown(this.data, saved);
      if (saved && (saved.version ?? 1) < 2) {
        if (saved.env?.turbulence === 0.2) this.data.env.turbulence = 0; // old default: now off
        if (saved.env?.night) this.data.env.timeOfDay = 'night';
      }
      if (saved && (saved.version ?? 1) < 3 && saved.mission) {
        // mission settings moved into the game modes
        if (['easy', 'medium', 'hard'].includes(saved.mission.targetMode)) this.data.strike.difficulty = saved.mission.targetMode;
        if (typeof saved.mission.enemyReaction === 'boolean') this.data.free.reaction = saved.mission.enemyReaction;
        if (typeof saved.mission.alertness === 'number') this.data.free.alertness = saved.mission.alertness;
      }
      this.data.version = VERSION;
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

  // { 'a.b': value, ... } with a single change notification
  setMany(values) {
    for (const [path, value] of Object.entries(values)) {
      const keys = path.split('.');
      const last = keys.pop();
      keys.reduce((o, k) => o[k], this.data)[last] = value;
    }
    this.commit();
  }

  applyWeather(name) {
    Object.assign(this.data.env, { weather: name });
    this.setMany(WEATHER_PRESETS[name] ?? {});
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
