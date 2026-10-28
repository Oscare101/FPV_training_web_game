import { DRONE_PRESETS } from '../flight/presets.js';

// Lifetime statistics, saved in this browser: time in the game and in the air, flights, distance,
// crashes, every detonation (direct hit, blast, net, which zone), what happened to which enemy
// vehicle type, rounds and wins per mode, per drone. Fed by main (per frame), the strike effects
// (detonations, cook-offs) and the game (round results).

const KEY = 'fpv-trainer.stats';
const VERSION = 1;
const RECENT = 30; // kept entries in the recent log
export const STAT_TYPES = ['tank', 'ifv', 'apc', 'truck', 'car', 'ammo'];
export const STAT_MODES = ['free', 'strike', 'hunt', 'hide'];

const blank = () => ({
  version: VERSION,
  since: Date.now(),
  playTime: 0, // s in a mode (not paused, not in menus)
  flightTime: 0, // s armed
  flights: 0, // times armed
  crashes: 0,
  distance: 0, // m flown while armed
  topSpeed: 0, // m/s
  maxAltitude: 0, // m above ground
  detonations: 0,
  directHits: 0, // the charge hit an enemy vehicle
  effective: 0, // detonations that damaged at least one enemy
  netHits: 0, // went off on a camouflage net
  kills: Object.fromEntries(STAT_TYPES.map((t) => [t, { destroyed: 0, immobilized: 0, damaged: 0 }])),
  zones: {}, // 'tank|Engine deck' -> direct hits there
  modes: Object.fromEntries(STAT_MODES.map((m) => [m, { time: 0, rounds: 0, wins: 0, detonations: 0, destroyed: 0 }])),
  drones: {}, // label -> { flights, time, distance }
  recent: [], // newest first: { t, mode, type, to, how }
});

export class Stats {
  constructor() {
    this.data = blank();
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      if (saved?.version === VERSION) this.data = mergeDeep(blank(), saved);
    } catch {
      // unavailable or corrupted storage: start fresh
    }
    this.dirty = false;
    this.saveTimer = 0;
    this.prevStatus = null;
    this.listeners = new Set();
    const flush = () => this.save();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => document.hidden && flush());
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // storage full or unavailable
    }
  }

  reset() {
    this.data = blank();
    this.dirty = true;
    this.save();
    for (const fn of this.listeners) fn();
  }

  // Per frame. ctx: { active (in a mode, not paused), mode, flight, drone: settings.drone }
  tick(dt, { active, mode, flight, drone }) {
    const d = this.data;
    const status = flight.status;
    if (active) {
      d.playTime += dt;
      d.modes[mode].time += dt;
      if (status === 'armed' && this.prevStatus && this.prevStatus !== 'armed') this.armed(drone);
      if (status === 'crashed' && this.prevStatus === 'armed') d.crashes++;
      if (status === 'armed') {
        const v = flight.drone.velocity.length();
        d.flightTime += dt;
        d.distance += v * dt;
        d.topSpeed = Math.max(d.topSpeed, v);
        d.maxAltitude = Math.max(d.maxAltitude, flight.altitude);
        const dr = this.droneEntry(drone);
        dr.time += dt;
        dr.distance += v * dt;
      }
      this.dirty = true;
    }
    this.prevStatus = status;
    this.saveTimer += dt;
    if (this.saveTimer > 5) {
      this.saveTimer = 0;
      this.save();
    }
  }

  droneEntry(drone) {
    const label = DRONE_PRESETS[drone.preset]?.label ?? `Custom ${drone.size}"`;
    return (this.data.drones[label] ??= { flights: 0, time: 0, distance: 0 });
  }

  armed(drone) {
    this.data.flights++;
    this.droneEntry(drone).flights++;
  }

  // A detonation: hit (what the charge met), out (strike.js result), transitions [{ v, from, to }]
  detonation(mode, hit, out, transitions) {
    const d = this.data;
    d.detonations++;
    d.modes[mode].detonations++;
    if (out.struck?.enemy) {
      d.directHits++;
      const k = `${out.struck.type}|${out.zone}`;
      d.zones[k] = (d.zones[k] ?? 0) + 1;
    }
    if (hit.kind === 'net' && !out.struck) d.netHits++;
    const enemy = transitions.filter((t) => t.v.enemy);
    if (enemy.length) d.effective++;
    for (const t of enemy) {
      const how = t.v === out.struck ? `direct hit · ${out.zone}` : hit.kind === 'net' ? 'blast through a net' : 'blast';
      this.transition(mode, t, how);
    }
    this.dirty = true;
  }

  // Secondary explosions of a burning ammo stack
  cookoff(mode, transitions) {
    for (const t of transitions) if (t.v.enemy) this.transition(mode, t, 'ammo cook-off');
    this.dirty = true;
  }

  transition(mode, { v, to }, how) {
    const d = this.data;
    const k = d.kills[v.type];
    if (!k || !(to in k)) return;
    k[to]++;
    if (to === 'destroyed') d.modes[mode].destroyed++;
    d.recent.unshift({ t: Date.now(), mode, type: v.type, to, how });
    d.recent.length = Math.min(d.recent.length, RECENT);
  }

  round(mode, won) {
    const m = this.data.modes[mode];
    m.rounds++;
    if (won) m.wins++;
    this.dirty = true;
  }
}

// Copy saved values over defaults (keeps new default keys when the format grows)
function mergeDeep(target, saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) mergeDeep(target[k], v);
    else target[k] = v;
  }
  return target;
}
