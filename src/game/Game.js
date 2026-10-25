import { generateLayout } from '../world/gen/layout.js';
import { effectiveSettings, mapKeyOf, rollStrikeConditions } from './conditions.js';
import { createStrikeFx } from './strike.js';
import { FreeFlight } from './FreeFlight.js';
import { StrikeMission } from './StrikeMission.js';
import { Hunt } from './Hunt.js';
import { HideSeek } from './HideSeek.js';
import { SHELTERS } from '../world/shelters.js';

export const MODE_NAMES = { free: 'Free Flight', strike: 'Strike Missions', hunt: 'Hunt', hide: 'Hide & Seek' };
// Settings pages per context: free play can change anything; missions/hunt only what doesn't
// change the game (map, weather, drone and enemies are set before starting)
export const GLOBAL_PAGES = ['drone', 'rates', 'camera', 'hud', 'graphics', 'guide', 'audio', 'controller', 'general'];
export const LOCKED_PAGES = ['rates', 'camera', 'hud', 'graphics', 'guide', 'audio', 'controller', 'general'];
export const FREE_SETUP_PAGES = ['free', 'weather', 'map'];

// The settings the world, drone and audio run on: the player's settings with the active mode's
// map, weather and rules on top. Subscribe with onChange like Settings. Create it right after
// Settings so it updates before anything else reacts to a change.
export class LiveSettings {
  constructor(settings) {
    this.settings = settings;
    this.mode = 'free';
    this.conditions = null; // strike: rolled conditions of the current mission
    this.listeners = new Set();
    this.data = this.compute();
    settings.onChange(() => this.publish());
  }

  compute() {
    return effectiveSettings(this.settings.data, { mode: this.mode, conditions: this.conditions });
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  publish() {
    this.data = this.compute();
    for (const fn of this.listeners) fn(this.data);
  }
}

// Game flow: main menu -> a mode (Free Flight / Strike Missions / Hunt) -> pause -> back.
// Owns the "effective" settings the world and drone run on: the player's settings with the
// active mode's map, weather and rules on top (saved settings are never changed by a mode).
export class Game {
  // live: LiveSettings; ui: { loading(text|null), status(text) }
  constructor({ settings, live, world, flight, audio, hud, ui }) {
    Object.assign(this, { settings, live, world, flight, audio, hud, ui });
    this.state = 'menu'; // 'menu' | 'playing'
    this.paused = false;
    this.builtKey = '';
    this.lastBuiltMode = null;
    this.pendingRebuild = false;
    this.rebuildTimer = 0;
    const fx = createStrikeFx(world, audio);
    this.fx = fx;
    const ctx = { flight, world, settings, fx, hud };
    this.modes = { free: new FreeFlight(ctx), strike: new StrikeMission(ctx), hunt: new Hunt(ctx), hide: new HideSeek(ctx) };

    flight.onImpact = (hit, drone) => (this.state === 'playing' ? this.active.handleImpact(hit, drone) : false);
    flight.onReset = () => {
      if (this.state === 'playing') this.active.onReset();
    };
    settings.onChange(() => this.settingsChanged());
  }

  // active mode, or the one whose conditions are shown behind the menu
  get mode() {
    return this.live.mode;
  }

  get data() {
    return this.live.data;
  }

  get active() {
    return this.modes[this.mode];
  }

  get playing() {
    return this.state === 'playing';
  }

  get locked() {
    return this.playing && this.mode !== 'free';
  }

  // Switch whose conditions apply (the live settings follow)
  setMode(mode, conditions = null) {
    this.live.mode = mode;
    this.live.conditions = conditions;
    this.live.publish();
    this.syncVehicles();
  }

  syncVehicles() {
    this.world.setVehiclesEnabled(this.mode !== 'free' || this.settings.data.free.enemies);
  }

  settingsChanged() {
    this.syncVehicles();
    const key = mapKeyOf(this.data.map);
    if (key === this.builtKey) return;
    if (this.mode !== 'free') {
      if (this.playing) this.pendingRebuild = true; // e.g. terrain detail changed mid-mission: next round
      return; // behind the menu a mission/hunt map is only built on Play
    }
    // Free Flight (playing or behind the menu): rebuild in place, debounced for sliders
    this.ui.status('Map changes pending…');
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.ui.status('Rebuilding map…');
      setTimeout(() => {
        this.buildMap(this.data.map.seed);
        this.flight.reset();
        if (this.playing) this.active.begin?.();
        this.ui.status('');
      }, 40);
    }, 450);
  }

  // ---------- map ----------

  buildMap(seed) {
    const s = seed || Math.floor(Math.random() * 1e9);
    this.world.build(generateLayout(s, this.data.map), { vegDetail: this.data.map.vegDetail });
    this.builtKey = mapKeyOf(this.data.map);
    this.pendingRebuild = false;
  }

  // Shows the loading screen, lets it paint, then runs fn (map builds block for ~1 s)
  withLoading(text, fn) {
    this.ui.loading(text);
    setTimeout(() => {
      fn();
      this.ui.loading(null);
    }, 50);
  }

  // ---------- flow ----------

  start(mode) {
    clearTimeout(this.rebuildTimer);
    this.paused = false;
    this.hud.clearFeed();
    let notice = '';
    if (mode !== 'free' && this.settings.data.drone.payload <= 0) {
      this.settings.applyPreset('7strike'); // a strike needs a charge
      notice = 'Drone switched to 7" strike (change it in Settings → Drone).';
    }
    let conditions = mode === 'strike' && this.settings.data.strike.conditions === 'random'
      ? rollStrikeConditions(this.settings.data.strike.difficulty) : null;
    if (mode === 'hide') {
      // mild random conditions (it's about precision, not weather), the hideout type chosen or random
      const pick = this.settings.data.hide.shelter;
      conditions = { ...rollStrikeConditions('easy'), shelter: SHELTERS.includes(pick) ? pick : SHELTERS[Math.floor(Math.random() * SHELTERS.length)] };
    }
    this.setMode(mode, conditions);
    const text = { free: 'Preparing the map…', strike: 'Preparing the mission…', hunt: 'Preparing the battlefield…', hide: 'Hiding the target…' }[mode];
    this.withLoading(text, () => {
      const key = mapKeyOf(this.data.map);
      if (mode === 'strike' || mode === 'hide') this.buildMap(0); // every mission / hideout a new map
      else if (mode === 'hunt') this.buildMap(this.data.map.seed); // same battlefield, fresh (no wrecks)
      else if (key !== this.builtKey || this.pendingRebuild || this.lastBuiltMode !== 'free') this.buildMap(this.data.map.seed);
      this.lastBuiltMode = mode;
      this.state = 'playing';
      if (mode === 'strike' || mode === 'hide') this.active.begin(conditions, notice);
      else this.active.begin();
    });
  }

  // Strike: same mission again; Hunt: same battlefield from scratch; Free: drone back on the pad
  restart() {
    this.paused = false;
    if (this.mode === 'hide') return this.pendingRebuild ? this.start('hide') : this.active.retry();
    if (this.mode === 'hunt') this.start('hunt');
    else if (this.mode === 'strike' && this.pendingRebuild) this.start('strike');
    else if (this.mode === 'strike') this.active.retry();
    else this.flight.reset();
  }

  nextMission() {
    this.start('strike');
  }

  newBattlefield() {
    this.settings.set('hunt.seed', 1 + Math.floor(Math.random() * 99999));
    this.start('hunt');
  }

  exitToMenu() {
    this.active.end();
    this.state = 'menu';
    this.paused = false;
    this.flight.hotArm = false;
    this.hud.clearFeed();
  }

  // Free Flight "New random map"
  newFreeMap() {
    if (this.mode !== 'free') return;
    this.withLoading('Generating a new map…', () => {
      this.buildMap(0);
      this.lastBuiltMode = 'free';
      if (this.playing) this.active.begin();
      else this.flight.reset();
    });
  }

  pause() {
    if (this.playing) this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  // Result-panel buttons
  action(a) {
    if (a === 'retry' || a === 'again') this.restart();
    if (a === 'next') this.start(this.mode === 'hide' ? 'hide' : 'strike');
    if (a === 'newfield') this.newBattlefield();
    if (a === 'menu') this.exitToMenu();
  }

  requestDetonate() {
    if (this.playing && !this.paused) this.active.requestDetonate?.();
  }

  // ---------- per frame ----------

  // Simulation step (not while paused or in the menu)
  update(dt) {
    if (!this.playing || this.paused) return;
    this.fx.update(dt);
    this.active.update(dt);
    const threat = this.flight.status === 'armed' || this.flight.status === 'disarmed' ? this.flight.drone : null;
    const rules = this.active.enemyRules;
    this.world.update(dt, threat, rules.reaction, rules.alertness);
  }

  // Menu background: vehicles keep driving, nobody reacts
  updateMenu(dt) {
    this.world.update(dt, null, false, 1);
  }
}
