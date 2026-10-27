import { MAP_DEFAULTS } from '../world/gen/layout.js';
import { WEATHER_PRESETS } from '../settings/Settings.js';

// What each game mode feeds the world and the drone: the player's settings with the mode's own map,
// weather and rules on top. The saved settings are never changed by a mode.

// Graphics/performance values that live under `map` but belong to the player in every mode
const DETAIL_KEYS = ['terrainCell', 'vegDetail', 'renderDistance', 'detailDistance', 'renderScale'];

// Hunt: a compact battlefield with the enemy close to the launch point (fast contact)
export const HUNT_MAP = {
  size: 1500, launchMin: 250, launchMax: 480, enemySites: 3, vehiclesPerSite: 3, movingVehicles: 2,
  wrecks: 3, lakes: 0, rivers: 1, craters: 1.2, launchSpot: 'random',
};
export const HUNT_WIND = 2; // m/s, same every round so times compare
// Hide & Seek: small map, one hidden target close to the launch point, nothing else to shoot.
// Ground detail at least 2 m there, so a dugout's pit has sharp edges.
export const HIDE_MAP = {
  size: 1500, launchMin: 110, launchMax: 220, enemySites: 0, movingVehicles: 0, wrecks: 2, launchSpot: 'field',
};
const HIDE_RANDOM_TERRAIN = { lakes: 0, rivers: 0 };

const pick = (weights, rand = Math.random) => {
  let t = rand() * Object.values(weights).reduce((a, b) => a + b, 0);
  for (const [k, w] of Object.entries(weights)) if ((t -= w) <= 0) return k;
  return Object.keys(weights)[0];
};

// Random conditions for one strike mission; harder missions get night, fog and more wind
export function rollStrikeConditions(difficulty) {
  const hard = difficulty === 'hard';
  const easy = difficulty === 'easy';
  const season = pick({ summer: 0.35, autumn: 0.25, spring: 0.2, winter: 0.2 });
  const timeOfDay = pick(easy ? { day: 0.5, morning: 0.25, evening: 0.25 } : { day: 0.4, morning: 0.2, evening: 0.25, night: hard ? 0.2 : 0.1 });
  const weather = pick({
    clear: 0.25, partly: 0.35, overcast: 0.2,
    rain: season === 'winter' || easy ? 0 : 0.1, snow: season === 'winter' ? 0.25 : 0, fog: easy ? 0 : hard ? 0.12 : 0.06,
  });
  const [w0, w1] = easy ? [0, 3] : hard ? [2, 7] : [1, 5];
  return { season, timeOfDay, weather, windSpeed: Math.round((w0 + Math.random() * (w1 - w0)) * 2) / 2, windDir: Math.floor(Math.random() * 24) * 15 };
}

// Weather preset -> { env, graphics } overrides
function weatherOverrides(name) {
  const env = {};
  const graphics = {};
  for (const [path, v] of Object.entries(WEATHER_PRESETS[name] ?? WEATHER_PRESETS.partly)) {
    const [group, key] = path.split('.');
    (group === 'env' ? env : graphics)[key] = v;
  }
  return { env, graphics };
}

// Custom conditions map (Map page) without what the modes decide themselves: enemies, front line, seed
const customMap = (map) => Object.fromEntries(Object.entries(map).filter(([k]) => !ENEMY_KEYS.includes(k) && !['launchMin', 'launchMax', 'seed'].includes(k)));

// data: saved settings; ctx: { mode, conditions (strike roll) }
export function effectiveSettings(data, { mode, conditions }) {
  const detail = Object.fromEntries(DETAIL_KEYS.map((k) => [k, data.map[k]]));
  if (mode === 'strike' && data.strike.conditions === 'random' && conditions) {
    const w = weatherOverrides(conditions.weather);
    return {
      ...data,
      env: { ...data.env, ...w.env, weather: conditions.weather, timeOfDay: conditions.timeOfDay, windSpeed: conditions.windSpeed, windDir: conditions.windDir },
      graphics: { ...data.graphics, ...w.graphics },
      map: { ...MAP_DEFAULTS, ...detail, season: conditions.season },
    };
  }
  if (mode === 'strike') return { ...data, map: { ...MAP_DEFAULTS, ...customMap(data.map), ...detail } };
  if (mode === 'hide' && conditions && data.hide.conditions === 'custom') {
    return { ...data, map: { ...MAP_DEFAULTS, ...customMap(data.map), ...HIDE_MAP, ...detail, terrainCell: Math.min(detail.terrainCell, 2), farmNearLaunch: conditions.shelter === 'building', hideSeek: { shelter: conditions.shelter, difficulty: data.hide.difficulty } } };
  }
  if (mode === 'hide' && conditions) {
    const w = weatherOverrides(conditions.weather);
    return {
      ...data,
      env: { ...data.env, ...w.env, weather: conditions.weather, timeOfDay: conditions.timeOfDay, windSpeed: conditions.windSpeed, windDir: conditions.windDir },
      graphics: { ...data.graphics, ...w.graphics },
      map: { ...MAP_DEFAULTS, ...HIDE_MAP, ...HIDE_RANDOM_TERRAIN, ...detail, terrainCell: Math.min(detail.terrainCell, 2), season: conditions.season, farmNearLaunch: conditions.shelter === 'building', hideSeek: { shelter: conditions.shelter, difficulty: data.hide.difficulty } },
    };
  }
  if (mode === 'hunt') {
    const h = data.hunt;
    const w = weatherOverrides(h.weather);
    return {
      ...data,
      env: { ...data.env, ...w.env, weather: h.weather, timeOfDay: h.timeOfDay, windSpeed: HUNT_WIND },
      graphics: { ...data.graphics, ...w.graphics },
      map: { ...MAP_DEFAULTS, ...HUNT_MAP, ...detail, season: h.season, seed: h.seed },
    };
  }
  // Free Flight: everything as set, battery limit only if chosen
  return { ...data, drone: { ...data.drone, batterySim: data.drone.batterySim && data.free.battery } };
}

// Enemy-layer settings: changing them swaps the enemies on the same map (no rebuild)
export const ENEMY_KEYS = ['enemySites', 'vehiclesPerSite', 'movingVehicles', 'camoNets', 'branchCamo', 'revetments', 'hideouts', 'whitewash', 'wrecks'];
// Map generation parameters only (what a full rebuild depends on)
export const MAP_GEN_KEYS = [...Object.keys(MAP_DEFAULTS).filter((k) => !ENEMY_KEYS.includes(k)), 'vegDetail', 'seed'];
export const mapKeyOf = (map) => MAP_GEN_KEYS.map((k) => map[k]).join('/');
export const enemyKeyOf = (map) => ENEMY_KEYS.map((k) => map[k]).join('/');
export const enemyOptionsOf = (map) => Object.fromEntries(ENEMY_KEYS.map((k) => [k, map[k]]));
