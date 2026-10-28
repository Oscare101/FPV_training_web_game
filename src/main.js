import './style.css';
import { createWorld } from './world/world.js';
import { InputManager } from './input/InputManager.js';
import { KeyboardInput, isFormTarget } from './input/KeyboardInput.js';
import { FlightController } from './flight/FlightController.js';
import { Settings } from './settings/Settings.js';
import { SettingsMenu } from './ui/SettingsMenu.js';
import { MainMenu } from './ui/MainMenu.js';
import { PauseMenu } from './ui/PauseMenu.js';
import { GameHud } from './ui/GameHud.js';
import { Osd } from './ui/Osd.js';
import { FpsCounter } from './ui/FpsCounter.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { Game, LiveSettings, MODE_NAMES, GLOBAL_PAGES, LOCKED_PAGES, FREE_SETUP_PAGES, CONDITION_PAGES } from './game/Game.js';
import { generateLayout } from './world/gen/layout.js';
import { mapKeyOf, enemyKeyOf } from './game/conditions.js';
import { captureScreenshot, snapshotDataUrl, screenshotToast } from './ui/Screenshot.js';
import { createStickPreview } from './ui/stickPreview.js';
import { Stats } from './game/Stats.js';

const settings = new Settings();
const stats = new Stats();
const live = new LiveSettings(settings); // settings + the active mode's map/weather/rules
const world = createWorld(document.getElementById('app'));
world.applySettings(live.data);
live.onChange((data) => world.applySettings(data));
// Start behind the main menu on the Free Flight map (the drone needs a map to stand on)
world.build(generateLayout(live.data.map.seed || Math.floor(Math.random() * 1e9), live.data.map), { vegDetail: live.data.map.vegDetail });

const input = new InputManager();
const keyboard = new KeyboardInput();
const flight = new FlightController(input, keyboard, world, live);
const osd = new Osd(document.body);
const fps = new FpsCounter(document.body);
const applyOsd = (data) => {
  osd.configure(data.osd);
  fps.el.hidden = !data.osd.fps;
};
applyOsd(settings.data);
settings.onChange(applyOsd);
const audio = new AudioEngine(document.body);
audio.applySettings(live.data);
live.onChange((data) => audio.applySettings(data));

// Loading overlay while a map builds
const loading = document.createElement('div');
loading.className = 'loading';
loading.hidden = true;
loading.innerHTML = '<div class="loading-bar"></div><span></span>';
document.body.appendChild(loading);

let shotPending = false;
let game = null;
const hud = new GameHud(document.body, world, (a) => game.action(a));
const settingsMenu = new SettingsMenu(settings, document.body, {
  input,
  stats,
  onNewMap: () => game.newFreeMap(),
  onScreenshot: () => (shotPending = true),
  onClose: () => {
    // back to where it was opened from
    if (game.playing) pauseMenuShow();
    else if (game.mode !== mainMenu.selected) game.setMode(mainMenu.selected); // the menu shows the selected mode again
  },
});
game = new Game({
  settings, live, world, flight, audio, hud, stats,
  ui: {
    loading(text, soft = false) {
      loading.hidden = !text;
      loading.classList.toggle('soft', soft);
      if (text) loading.querySelector('span').textContent = text;
    },
    status: (text) => settingsMenu.setStatus(text),
  },
});

const mainMenu = new MainMenu(settings, document.body, {
  input,
  onPlay: (mode) => game.start(mode),
  onSettings: () => settingsMenu.open('drone', { allowed: GLOBAL_PAGES, title: 'Settings' }),
  onController: () => settingsMenu.open('controller', { allowed: GLOBAL_PAGES, title: 'Settings' }),
  onGuide: () => settingsMenu.open('guide', { allowed: GLOBAL_PAGES, title: 'Settings' }),
  onStats: () => settingsMenu.open('stats', { allowed: GLOBAL_PAGES, title: 'Settings' }),
  onFreeSetup: () => {
    game.setMode('free');
    settingsMenu.open('free', { allowed: FREE_SETUP_PAGES, title: 'Free Flight' });
  },
  // the scene behind shows the Custom conditions (the Free Flight map) while editing them
  onConditions: () => {
    game.setMode('free');
    settingsMenu.open('weather', { allowed: CONDITION_PAGES, title: 'Custom conditions' });
  },
  onSelect: (mode) => game.setMode(mode), // the menu background shows that mode's weather and time
});

const pauseMenu = new PauseMenu(document.body, (a) => {
  pauseMenu.hide();
  if (a === 'resume') game.resume();
  if (a === 'restart') game.restart();
  if (a === 'reset-enemies') {
    game.active.resetEnemies?.();
    game.resume();
  }
  if (a === 'settings') settingsMenu.open('rates', { allowed: game.locked ? LOCKED_PAGES : null, title: 'Settings' });
  if (a === 'free-setup') settingsMenu.open('free', { allowed: null, title: 'Settings' });
  if (a === 'controller') settingsMenu.open('controller', { allowed: game.locked ? LOCKED_PAGES : null, title: 'Settings' });
  if (a === 'menu') game.exitToMenu();
});
function pauseMenuShow() {
  game.pause();
  pauseMenu.show(MODE_NAMES[game.mode], game.mode, game.active.pauseInfo, settings.data.free.enemies);
}

game.builtKey = mapKeyOf(live.data.map);
game.builtEnemyKey = enemyKeyOf(live.data.map);
game.lastBuiltMode = 'free';
game.syncVehicles();
mainMenu.select(settings.data.game.mode);
mainMenu.show(); // always the main menu first; the controller chip there says if it still needs setting up

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'Escape') {
    if (settingsMenu.visible) settingsMenu.hide();
    else if (game.playing && pauseMenu.visible) {
      pauseMenu.hide();
      game.resume();
    } else if (game.playing) pauseMenuShow();
    return;
  }
  if (isFormTarget(e)) return;
  if (e.code === 'KeyK') shotPending = true;
  if (e.code === 'KeyF') fps.toggle();
  if (e.code === 'KeyM') settings.set('audio.muted', !settings.data.audio.muted);
  if (e.code === 'KeyC') {
    if (settingsMenu.visible && settingsMenu.category === 'controller') settingsMenu.hide();
    else {
      if (game.playing && !game.paused) pauseMenuShow();
      pauseMenu.hide();
      settingsMenu.open('controller', { allowed: game.playing ? (game.locked ? LOCKED_PAGES : null) : GLOBAL_PAGES, title: 'Settings' });
    }
  }
  if (settingsMenu.visible || pauseMenu.visible) return;
  if (!game.playing) {
    if (mainMenu.visible) mainMenu.key(e);
    return;
  }
  if (e.code === 'KeyX') game.requestDetonate();
  if (e.code === 'Enter' && !hud.el.result.hidden && hud.primaryAction) game.action(hud.primaryAction);
  if (game.mode === 'free') {
    if (e.code === 'KeyN') {
      const t = settings.data.env.timeOfDay;
      if (t !== 'night') lastDaytime = t;
      settings.set('env.timeOfDay', t === 'night' ? lastDaytime : 'night');
    }
    if (e.code === 'KeyP' && !game.active.liveCharge) flight.dropPayload();
  }
});

function screenshotStamp() {
  const d = live.data;
  const g = d.graphics;
  const m = d.map;
  const p = flight.drone.position;
  return [
    'FPV Trainer', MODE_NAMES[game.mode], `seed ${world.layout.seed}`, `${g.look} ${g.lines || 'native'}`, `shadows ${g.shadows}`, `grass ${g.grass}`,
    `clouds ${Math.round(g.clouds * 100)}%`, `terrain ${m.terrainCell} m`, `trees ${m.vegDetail}`, `view ${m.renderDistance} m`,
    `${m.season} ${d.env.timeOfDay} ${d.env.weather}`, fps.text.textContent.trim(), `pos ${Math.round(p.x)},${Math.round(p.z)} alt ${flight.altitude.toFixed(1)} m`,
  ].join(' · ');
}

const stickPreview = createStickPreview();
let prevShotSwitch = false;
let prevDetonate = false;
let lastDaytime = settings.data.env.timeOfDay === 'night' ? 'day' : settings.data.env.timeOfDay;
let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const inMenu = !game.playing;
  const paused = inMenu || game.paused || settingsMenu.visible;
  const showMain = inMenu && !settingsMenu.visible;
  if (showMain !== mainMenu.visible) {
    if (showMain) mainMenu.show();
    else mainMenu.hide();
  }

  input.update();
  keyboard.update(dt);
  settingsMenu.update(now);
  mainMenu.update();
  const shotSwitch = input.state.screenshot === true;
  if (shotSwitch && !prevShotSwitch) shotPending = true;
  prevShotSwitch = shotSwitch;
  const detonate = input.state.detonate === true;
  if (detonate && !prevDetonate && !paused) game.requestDetonate();
  prevDetonate = detonate;

  flight.update(dt, paused); // physics pauses in menus
  stats.tick(dt, { active: !paused, mode: game.mode, flight, drone: live.data.drone });
  if (!paused) game.update(dt);
  else if (inMenu) game.updateMenu(dt);

  // camera
  const d = flight.drone;
  const size = live.data.drone.size;
  const payload = flight.drone.payloadMass > 0; // gone after a drop
  const preview = settingsMenu.activePreview;
  if (preview === 'sticks') {
    const l = world.layout.launch;
    world.updateCamera(stickPreview.update(dt, flight.controls, live.data.rates, l, world.heightAt(l.x, l.z), settingsMenu.levelRequest));
    world.setDrone(null, size, 0);
  } else if (preview !== 'fpv') {
    world.updatePreviewCamera(preview, flight.renderPose, now / 1000);
    world.setDrone(flight.renderPose, size, flight.status === 'armed' ? 1 : 0, payload);
  } else if (inMenu) {
    world.setDrone(world.updateMenuCamera(now / 1000, size, settingsMenu.visible ? -1 : 1), size, 1, payload); // the drone showcase
  } else {
    if (game.active.observing) world.updateObserverCamera(game.active.observeCenter, game.active.approach, game.active.timer);
    else world.updateCamera(flight.renderPose);
    world.setDrone(flight.status === 'detonated' ? null : flight.renderPose, size, flight.status === 'armed' ? 1 : 0, payload);
  }
  // Grass: wind sway and prop wash (strongest close to the ground at high throttle)
  const wash = live.data.graphics.propWash && flight.status === 'armed'
    ? Math.min(1, d.motor * 1.6) * (1 - Math.min(1, Math.max(0, (flight.altitude - 0.3) / 3.5)))
    : 0;
  world.setFlightState(flight.wind.base, flight.wind.gust, d.position, wash);
  world.render(dt);

  if (preview !== 'sticks') stickPreview.release();
  // overlays
  const overlay = game.playing && !settingsMenu.visible && !pauseMenu.visible;
  hud.begin();
  if (overlay) game.active.drawHud(hud);
  hud.end(now);
  hud.root.hidden = !overlay;
  osd.root.hidden = !overlay || game.active.hidesOsd;
  osd.update(flight, world.layout.launch);
  // right after rendering, while the frame is still in the drawing buffer
  if (shotPending) {
    shotPending = false;
    const g = settings.data.screenshot;
    const name = captureScreenshot(world.renderer.domElement, {
      overlays: g.hud && overlay ? [osd.root, hud.root] : [],
      stamp: g.stamp ? screenshotStamp() : '',
    });
    screenshotToast(name);
  }
  if (settingsMenu.wantSnapshot) settingsMenu.setOsdBackdrop(snapshotDataUrl(world.renderer.domElement));
  audio.update(flight, paused);
  fps.update(now);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Dev-only handle for debugging/automated checks (not in production builds)
if (import.meta.env.DEV) window.__fpv = { flight, world, game, settings, live, menu: settingsMenu, mainMenu, pauseMenu, hud };
