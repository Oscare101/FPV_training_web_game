import './style.css';
import { createWorld } from './world/world.js';
import { InputManager } from './input/InputManager.js';
import { KeyboardInput, isFormTarget } from './input/KeyboardInput.js';
import { FlightController } from './flight/FlightController.js';
import { Settings } from './settings/Settings.js';
import { CalibrationScreen } from './ui/CalibrationScreen.js';
import { SettingsMenu } from './ui/SettingsMenu.js';
import { Osd } from './ui/Osd.js';
import { FpsCounter } from './ui/FpsCounter.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { StrikeMission } from './game/StrikeMission.js';
import { generateLayout } from './world/gen/layout.js';

const settings = new Settings();
const world = createWorld(document.getElementById('app'));
world.applySettings(settings.data);
settings.onChange((data) => world.applySettings(data));

// New procedural map (seed from settings, 0 = random); keepSeed rebuilds the current map
function buildMap(keepSeed = false) {
  const seed = keepSeed && world.layout ? world.layout.seed : settings.data.map.seed || Math.floor(Math.random() * 1e9);
  world.build(generateLayout(seed, settings.data.map), { vegDetail: settings.data.map.vegDetail });
}
buildMap();

const input = new InputManager();
const keyboard = new KeyboardInput();
const flight = new FlightController(input, keyboard, world, settings);
const osd = new Osd(document.body);
const calibration = new CalibrationScreen(input, document.body);
const menu = new SettingsMenu(settings, document.body, {
  onOpenController: () => calibration.show(),
  onNewMap: () => {
    buildMap();
    if (mission.active) mission.start(true, false);
    else flight.reset();
  },
});
const fps = new FpsCounter(document.body);
const audio = new AudioEngine(document.body);
audio.applySettings(settings.data);
settings.onChange((data) => audio.applySettings(data));
const mission = new StrikeMission({ flight, world, audio, settings, input, parent: document.body, regenerate: buildMap });

// Detail settings rebuild the same map right away (geometry + colliders change)
let builtDetail = `${settings.data.map.terrainCell}/${settings.data.map.vegDetail}`;
settings.onChange((data) => {
  const detail = `${data.map.terrainCell}/${data.map.vegDetail}`;
  if (detail === builtDetail) return;
  builtDetail = detail;
  buildMap(true);
  if (mission.active) mission.start(true, false);
  else flight.reset();
});

if (!input.config.calibrated) calibration.show();

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'Escape') {
    if (calibration.visible) calibration.hide();
    else menu.toggle();
    return;
  }
  if (isFormTarget(e)) return;
  if (e.code === 'KeyC') {
    menu.hide();
    calibration.toggle();
  }
  if (e.code === 'KeyN') settings.set('env.night', !settings.data.env.night);
  if (e.code === 'KeyP' && !mission.active) flight.dropPayload(); // a strike charge isn't droppable
  if (e.code === 'Digit1') mission.stop();
  if (e.code === 'Digit2') mission.start(true);
  if (e.code === 'Enter') mission.retry();
  if (e.code === 'KeyX') mission.requestDetonate();
  if (e.code === 'KeyF') fps.toggle();
  if (e.code === 'KeyM') settings.set('audio.muted', !settings.data.audio.muted);
});

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const paused = calibration.visible || menu.visible;

  input.update();
  keyboard.update(dt);
  calibration.update(now);
  flight.update(dt, paused); // physics pauses while a menu is open
  if (!paused) {
    mission.update(dt);
    const threat = flight.status === 'armed' || flight.status === 'disarmed' ? flight.drone : null;
    world.update(dt, threat, settings.data.mission.enemyReaction, settings.data.mission.alertness);
  }
  if (mission.observing) world.updateObserverCamera(mission.observeCenter, mission.approach, mission.timer);
  else world.updateCamera(flight.renderPose);
  // Grass: wind sway and prop wash (strongest close to the ground at high throttle)
  const d = flight.drone;
  const wash = settings.data.graphics.propWash && flight.status === 'armed'
    ? Math.min(1, d.motor * 1.6) * (1 - Math.min(1, Math.max(0, (flight.altitude - 0.3) / 3.5)))
    : 0;
  world.setFlightState(flight.wind.base, flight.wind.gust, d.position, wash);
  world.render(paused ? 0 : dt);
  mission.updateUi();
  osd.root.hidden = mission.hidesOsd;
  osd.update(flight);
  audio.update(flight, paused);
  fps.update(now);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Dev-only handle for debugging/automated checks (not in production builds)
if (import.meta.env.DEV) window.__fpv = { flight, world, mission, settings, buildMap };
