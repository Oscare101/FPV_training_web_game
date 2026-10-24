import { DRONE_PRESETS } from '../flight/presets.js';
import { LAUNCH_SPOTS } from '../world/gen/layout.js';
import { computeSun, sunTimes, fmtHour } from '../world/sun.js';

// Settings menu layout: categories -> groups -> fields. Every field has a tooltip (tip).
// advanced: hidden under "Advanced" in its group. preview: what the right side shows
// ('scene' = live 3D view, wider panel otherwise).

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];
const pct = (v) => `${Math.round(v * 100)}%`;
const times = (v) => `×${v.toFixed(1)}`;
const meters = (v) => `${v} m`;

// Graphics quality presets (one click sets the performance-related values)
export const QUALITY_PRESETS = {
  low: {
    label: 'Low', tip: 'For older or hot laptops: shorter view, coarse terrain, low shadows.',
    values: { 'graphics.shadows': 'low', 'graphics.grass': 'flat', 'map.renderScale': 1, 'map.terrainCell': 4, 'map.vegDetail': 'low', 'map.renderDistance': 500, 'map.detailDistance': 160 },
  },
  medium: {
    label: 'Medium', tip: 'Default. Holds 60 fps on a MacBook Air M1.',
    values: { 'graphics.shadows': 'medium', 'graphics.grass': 'flat', 'map.renderScale': 1.5, 'map.terrainCell': 2, 'map.vegDetail': 'medium', 'map.renderDistance': 700, 'map.detailDistance': 220 },
  },
  high: {
    label: 'High', tip: 'Longer view, sharper shadows, smoother trees. May drop below 60 fps over forests.',
    values: { 'graphics.shadows': 'high', 'graphics.grass': 'flat', 'map.renderScale': 1.5, 'map.terrainCell': 2, 'map.vegDetail': 'high', 'map.renderDistance': 1000, 'map.detailDistance': 300 },
  },
  ultra: {
    label: 'Ultra', tip: '3D grass with prop wash, 1 m terrain, max view. For screenshots, not a stable 60 fps on an Air.',
    values: { 'graphics.shadows': 'high', 'graphics.grass': '3d', 'map.renderScale': 2, 'map.terrainCell': 1, 'map.vegDetail': 'high', 'map.renderDistance': 1500, 'map.detailDistance': 400 },
  },
};

export const CATEGORIES = [
  {
    id: 'drone', label: 'Drone', icon: '✣',
    groups: [
      {
        title: 'Type',
        fields: [
          {
            path: 'drone.preset', label: 'Preset', type: 'select',
            options: [...Object.entries(DRONE_PRESETS).map(([k, p]) => [k, p.label]), ['custom', 'Custom']],
            tip: 'Loads a complete drone. Changing any value below switches to Custom.',
          },
          { path: 'drone.size', label: 'Prop size', type: 'range', min: 3, max: 10, step: 0.5, fmt: (v) => `${v}"`, tip: 'Propeller diameter in inches. Bigger props = more inertia, slower spool-up, more drag.' },
          { path: 'drone.mass', label: 'Mass', type: 'range', min: 0.2, max: 4, step: 0.05, fmt: (v) => `${v.toFixed(2)} kg`, tip: 'All-up weight with battery, without payload.' },
          { path: 'drone.thrustToWeight', label: 'Thrust-to-weight', type: 'range', min: 1.5, max: 14, step: 0.1, fmt: (v) => `${v.toFixed(1)}:1`, tip: 'Max motor thrust divided by the drone\'s weight (without payload). 5" freestyle ≈ 8:1, heavy carriers 3–4:1.' },
          { path: 'drone.payload', label: 'Payload', type: 'range', min: 0, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)} kg`, tip: 'Extra weight (charge, bomb). Lowers effective thrust-to-weight. P drops it in free flight.' },
        ],
        info: (d) => {
          const maxThrust = d.drone.thrustToWeight * d.drone.mass * 9.81;
          const twr = maxThrust / ((d.drone.mass + d.drone.payload) * 9.81);
          const hover = twr > 1 ? Math.round(((Math.sqrt(1 / twr) - 0.05) / 0.95) * 100) : null;
          return `Max thrust ${maxThrust.toFixed(0)} N · loaded TWR ${twr.toFixed(1)} · hover ≈ ${hover === null ? 'cannot hover' : `${hover}%`} throttle`;
        },
      },
      {
        title: 'Battery',
        fields: [
          { path: 'drone.batterySim', label: 'Battery sag', type: 'checkbox', tip: 'Voltage drops under load and as the pack drains, so punch-outs get weaker over the flight. Off = constant full power.' },
          { path: 'drone.cells', label: 'Cells', type: 'select', options: [[4, '4S'], [6, '6S'], [8, '8S']], number: true, tip: 'Pack voltage (cell count). Shown on the HUD.' },
          { path: 'drone.capacity', label: 'Capacity', type: 'range', min: 450, max: 10000, step: 50, fmt: (v) => `${v} mAh`, tip: 'Bigger pack = longer flight time (its weight is part of Mass).' },
        ],
      },
    ],
  },
  {
    id: 'rates', label: 'Rates', icon: '↻',
    groups: [{ title: 'Betaflight rates', custom: 'rates' }],
  },
  {
    id: 'camera', label: 'Camera', icon: '◉', preview: 'scene',
    groups: [
      {
        title: 'Mount',
        fields: [
          { path: 'camera.uptilt', label: 'Uptilt', type: 'range', min: 0, max: 60, step: 1, fmt: (v) => `${v}°`, tip: 'Camera tilt up from the frame. More uptilt = you fly faster with the horizon level. 25–35° is typical for 5".' },
          { path: 'camera.fov', label: 'Field of view', type: 'range', min: 80, max: 150, step: 1, fmt: (v) => `${v}°`, tip: 'Horizontal angle. Real FPV cameras are 120–150°. Wider = more peripheral view, objects look farther away.' },
        ],
      },
      {
        title: 'Image',
        fields: [
          { path: 'graphics.look', label: 'Camera style', type: 'select', options: [['digital', 'Digital HD'], ['analog', 'Analog'], ['clean', 'Clean'], ['off', 'Off (no effects)']], tip: 'Digital = DJI/Walksnail-like, Analog = 480-line video with noise and smear. Loads a preset for the sliders under Advanced.' },
          { path: 'graphics.lines', label: 'Resolution', type: 'select', number: true, options: [[360, '360 lines'], [480, '480 lines'], [720, '720 lines'], [1080, '1080 lines'], [0, 'Native']], tip: 'Vertical resolution the scene renders at. Lower looks like real FPV video and is faster.' },
          { path: 'graphics.distortion', label: 'Lens distortion', type: 'range', min: 0, max: 1, step: 0.02, fmt: pct, advanced: true, tip: 'Barrel (fish-eye) bend of a wide FPV lens.' },
          { path: 'graphics.aberration', label: 'Colour fringing', type: 'range', min: 0, max: 1.5, step: 0.05, fmt: pct, advanced: true, tip: 'Red/blue edges towards the corners (chromatic aberration).' },
          { path: 'graphics.noise', label: 'Grain', type: 'range', min: 0, max: 0.3, step: 0.005, fmt: (v) => `${Math.round(v * 1000) / 10}%`, advanced: true, tip: 'Sensor noise / analog static.' },
          { path: 'graphics.vignette', label: 'Vignette', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, advanced: true, tip: 'Darker corners.' },
          { path: 'graphics.saturation', label: 'Saturation', type: 'range', min: 0, max: 1.6, step: 0.02, fmt: pct, advanced: true, tip: 'Colour intensity. FPV cameras are usually a bit washed out.' },
          { path: 'graphics.contrast', label: 'Contrast', type: 'range', min: 0.6, max: 1.6, step: 0.02, fmt: pct, advanced: true, tip: 'Difference between dark and bright.' },
          { path: 'graphics.brightness', label: 'Brightness', type: 'range', min: 0.6, max: 1.5, step: 0.02, fmt: pct, advanced: true, tip: 'Overall exposure.' },
          { path: 'graphics.sharpness', label: 'Sharpening', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, advanced: true, tip: 'Edge sharpening like digital camera processing.' },
        ],
      },
    ],
  },
  {
    id: 'hud', label: 'HUD', icon: '▣', wide: true,
    groups: [
      { title: 'Preview', custom: 'osdPreview' },
      {
        title: 'Elements',
        fields: [
          { path: 'osd.compass', label: 'Compass', type: 'select', options: [['rose', 'Rose (top left)'], ['tape', 'Heading tape (top)'], ['off', 'Off']], tip: 'Your heading. N is north; the map\'s enemy side is usually ahead of the launch point.' },
          { path: 'osd.compassWind', label: 'Wind on compass', type: 'checkbox', tip: 'Blue arrow on the compass: where the wind blows to.' },
          { path: 'osd.home', label: 'Home distance', type: 'checkbox', tip: 'Distance and arrow back to the launch point.' },
          { path: 'osd.timer', label: 'Flight timer', type: 'checkbox', tip: 'Armed time, top centre.' },
          { path: 'osd.battery', label: 'Battery voltage', type: 'checkbox', tip: 'Pack and per-cell voltage. Blinks below 3.3 V/cell.' },
          { path: 'osd.mah', label: 'mAh used', type: 'checkbox', tip: 'Consumed capacity.' },
          { path: 'osd.throttle', label: 'Throttle', type: 'checkbox', tip: 'Throttle stick position in %.' },
          { path: 'osd.speed', label: 'Speed', type: 'checkbox', tip: 'Ground speed in km/h.' },
          { path: 'osd.altitude', label: 'Altitude', type: 'checkbox', tip: 'Height above the ground below you.' },
          { path: 'osd.crosshair', label: 'Crosshair', type: 'checkbox', tip: 'Centre mark (where the camera points, not where you fly).' },
          { path: 'osd.hints', label: 'Status & hints', type: 'checkbox', tip: 'DISARMED / CRASHED messages with what to do next.' },
          { path: 'osd.fps', label: 'FPS counter', type: 'checkbox', tip: 'Frames per second, top right. F toggles the frame-time graph.' },
        ],
      },
      {
        title: 'Style',
        fields: [
          { path: 'osd.scale', label: 'Size', type: 'range', min: 0.7, max: 1.6, step: 0.05, fmt: pct, tip: 'Scales all HUD text and the compass.' },
          { path: 'osd.color', label: 'Colour', type: 'select', options: [['white', 'White'], ['green', 'Green'], ['yellow', 'Yellow'], ['cyan', 'Cyan']], tip: 'Text colour. Every element has a dark outline for contrast.' },
          { path: 'osd.opacity', label: 'Opacity', type: 'range', min: 0.3, max: 1, step: 0.05, fmt: pct, tip: 'Lower = less distracting.' },
          { path: 'osd.margin', label: 'Edge margin', type: 'range', min: 4, max: 80, step: 2, fmt: (v) => `${v} px`, tip: 'Distance from the screen edges. Increase if the corners are cut off on your display or goggles.' },
        ],
      },
    ],
  },
  {
    id: 'free', label: 'Free Flight', icon: '◎', preview: 'scene',
    note: 'Free Flight only. Strike Missions and Hunt use their own rules.',
    groups: [
      {
        title: 'Enemies',
        fields: [
          { path: 'free.enemies', label: 'Enemies', type: 'checkbox', tip: 'Enemy vehicles on the map. Off = an empty map, just flying.' },
          { path: 'free.reaction', label: 'Enemy reaction', type: 'checkbox', tip: 'Vehicles that spot you drive away to cover or far away, swerving and braking.' },
          { path: 'free.alertness', label: 'Enemy alertness', type: 'range', min: 0.3, max: 3, step: 0.1, fmt: times, tip: 'How quickly crews notice the drone. Vehicles under nets or branches see little upwards.' },
          { path: 'free.liveCharge', label: 'Live charge', type: 'checkbox', tip: 'With a drone that carries a payload (e.g. 7" strike), hits detonate and damage vehicles; the next drone is ready on the pad. Destroyed vehicles stay until you reset enemies from the pause menu.' },
        ],
      },
      {
        title: 'Drone',
        fields: [
          { path: 'free.battery', label: 'Battery limit', type: 'checkbox', tip: 'Off = endless battery in Free Flight (Battery sag in Drone still applies in missions).' },
        ],
      },
    ],
  },
  {
    id: 'weather', label: 'Weather', icon: '☁', preview: 'scene',
    note: 'Free Flight conditions. Strike Missions roll their own, Hunt has its battlefield.',
    groups: [
      {
        title: 'Time & season',
        fields: [
          {
            path: 'map.season', label: 'Season', type: 'select',
            options: [['spring', 'Spring'], ['summer', 'Summer'], ['autumn', 'Autumn'], ['winter', 'Winter']],
            tip: 'Ground, crops, foliage and camouflage. Autumn: yellow and brown trees, harvested fields. Winter: snow, bare deciduous trees, frozen rivers, white nets and some whitewashed vehicles. Also sets how high the sun gets. Rebuilds the map.',
          },
          {
            path: 'env.timeOfDay', label: 'Time of day', type: 'select',
            options: [['morning', 'Morning'], ['day', 'Day'], ['evening', 'Evening (sunset)'], ['night', 'Night'], ['custom', 'Custom clock']],
            tip: 'Morning is an early clock time, so winter mornings are dim and low and summer mornings bright. Day = around noon (the highest sun of the season). Evening = just before sunset, warm light and long shadows. N toggles night in flight.',
          },
          { path: 'env.hour', label: 'Clock (solar time)', type: 'range', min: 0, max: 24, step: 0.25, fmt: fmtHour, advanced: true, tip: 'Exact time of day; moving it switches Time of day to Custom.' },
          { path: 'env.latitude', label: 'Latitude', type: 'range', min: 0, max: 70, step: 0.5, fmt: (v) => `${v}° N`, advanced: true, tip: 'Ukraine is 45–52° N; there the summer noon sun reaches about 63°, never overhead. Set ~25° for a sun almost straight above.' },
        ],
        info: (d) => {
          const sun = computeSun({ season: d.map.season, ...d.env });
          const { sunrise, sunset } = sunTimes(d.map.season, d.env.latitude);
          const dir = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(sun.azimuth / 45) % 8];
          return sun.elevation > 0
            ? `${fmtHour(sun.hour)} · sun ${sun.elevation.toFixed(0)}° high in the ${dir} · sunrise ${fmtHour(sunrise)}, sunset ${fmtHour(sunset)}`
            : `${fmtHour(sun.hour)} · sun below the horizon (${sun.elevation.toFixed(0)}°) · sunrise ${fmtHour(sunrise)}, sunset ${fmtHour(sunset)}`;
        },
      },
      {
        title: 'Weather',
        fields: [
          {
            path: 'env.weather', label: 'Weather', type: 'select',
            options: [['clear', 'Clear'], ['partly', 'Partly cloudy'], ['overcast', 'Overcast'], ['rain', 'Rain'], ['snow', 'Snowfall'], ['fog', 'Fog']],
            tip: 'Loads a preset for clouds, rain, snow and fog. Fine-tune with the sliders below.',
          },
          { path: 'graphics.clouds', label: 'Clouds', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Cloud cover. Clouds sit on a fixed layer, so you fly under them. Near full cover the light turns flat with weak shadows.' },
          { path: 'env.rain', label: 'Rain', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Rain streaks (they slant when you fly fast), wet darker ground, darker clouds, less visibility.' },
          { path: 'env.snowfall', label: 'Snowfall', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Falling snow and lower visibility. Snow lying on the ground comes from the Winter season.' },
          { path: 'env.fog', label: 'Fog', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Visibility: 0 = view distance from Graphics, 100% ≈ 100 m. Thick fog also makes the game faster (less is drawn).' },
          { path: 'graphics.cloudShadows', label: 'Cloud shadows', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'How dark the shadows of clouds on the ground are. They move with the clouds. 0 = off.' },
        ],
      },
      {
        title: 'Wind',
        fields: [
          { path: 'env.windSpeed', label: 'Wind speed', type: 'range', min: 0, max: 15, step: 0.5, fmt: (v) => `${v} m/s`, tip: 'Mean wind at 10 m height (1 m/s = 3.6 km/h). Weaker close to the ground.' },
          { path: 'env.windDir', label: 'Wind from', type: 'range', min: 0, max: 345, step: 15, fmt: (v) => `${v}° ${compass(v)}`, tip: 'Direction the wind comes from (0° = north).' },
          { path: 'env.gustiness', label: 'Gusts', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Slow changes of wind speed and direction that push you off your line.' },
          { path: 'env.turbulence', label: 'Turbulence', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Fast small bumps in attitude, stronger near trees and the ground. Changes the feel a lot; 0 by default.' },
        ],
      },
    ],
  },
  {
    id: 'map', label: 'Map', icon: '▦', preview: 'scene',
    note: 'Free Flight map. Changes rebuild it automatically (same seed).',
    groups: [
      {
        title: 'Map',
        fields: [
          { path: 'map.size', label: 'Map size', type: 'select', number: true, options: [[1500, '1.5 km'], [2000, '2 km'], [3000, '3 km']], tip: 'Side length of the playable square.' },
          {
            path: 'map.launchSpot', label: 'Launch spot', type: 'select',
            options: [['random', 'Random'], ...LAUNCH_SPOTS.map((k) => [k, k[0].toUpperCase() + k.slice(1)])],
            tip: 'Where you take off: field, tree line, ruins, trench… Random picks a different one every map.',
          },
          { path: 'map.launchMin', label: 'Enemy distance min', type: 'range', min: 200, max: 1500, step: 50, fmt: meters, tip: 'Shortest distance from launch to the enemy area.' },
          { path: 'map.launchMax', label: 'Enemy distance max', type: 'range', min: 300, max: 1800, step: 50, fmt: meters, tip: 'Longest distance from launch to the enemy area.' },
          { path: 'map.seed', label: 'Seed', type: 'number', tip: 'Same seed = same map. 0 = a random map every time.' },
        ],
        actions: [['new-map', 'New random map']],
      },
      {
        title: 'Enemy',
        fields: [
          { path: 'map.enemySites', label: 'Enemy sites', type: 'range', min: 1, max: 6, step: 1, fmt: (v) => `${v}`, tip: 'Groups of parked vehicles and ammo.' },
          { path: 'map.vehiclesPerSite', label: 'Vehicles per site', type: 'range', min: 1, max: 6, step: 1, fmt: (v) => `~${v}`, tip: 'Average number of vehicles at each position.' },
          { path: 'map.movingVehicles', label: 'Moving vehicles', type: 'range', min: 0, max: 8, step: 1, fmt: (v) => `${v}`, tip: 'Vehicles driving along roads and tracks.' },
          { path: 'map.camoNets', label: 'Camo nets', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Share of parked vehicles under a camouflage net.' },
          { path: 'map.branchCamo', label: 'Branch piles', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Share of the remaining vehicles covered with cut branches.' },
          { path: 'map.revetments', label: 'Dug-in vehicles', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Share of parked vehicles in a dug pit behind an earth berm.' },
          { path: 'map.whitewash', label: 'Winter whitewash', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Winter only: share of vehicles with improvised white paint. In this war most vehicles stay green in winter; whitewash is occasional. Nets turn white regardless.' },
          { path: 'map.wrecks', label: 'Wrecks (decoys)', type: 'range', min: 0, max: 15, step: 1, fmt: (v) => `${v}`, tip: 'Already destroyed vehicles (decoys: hitting one is a miss).' },
        ],
      },
      {
        title: 'Terrain',
        fields: [
          { path: 'map.hilliness', label: 'Hills & lowlands', type: 'range', min: 0, max: 2.5, step: 0.1, fmt: times, tip: 'Height of rolling hills and depth of lowlands.' },
          { path: 'map.ravines', label: 'Ravines', type: 'range', min: 0, max: 5, step: 1, fmt: (v) => `${v}`, tip: 'Number of overgrown gullies (good cover for low flying).' },
          { path: 'map.craters', label: 'Shelling craters', type: 'range', min: 0, max: 3, step: 0.1, fmt: times, tip: 'Crater density, highest in the grey zone between the lines.' },
        ],
      },
      {
        title: 'Water & damage',
        fields: [
          { path: 'map.rivers', label: 'Rivers', type: 'range', min: 0, max: 3, step: 1, fmt: (v) => `${v}`, tip: 'Rivers meandering through the low ground, with shallow fords where roads cross. Flying into water is a crash.' },
          { path: 'map.lakes', label: 'Lakes', type: 'range', min: 0, max: 4, step: 1, fmt: (v) => `${v}`, tip: 'Ponds and lakes in open land, with willows on the shore. Frozen in winter (you can land on the ice).' },
          { path: 'map.burned', label: 'Burnt land', type: 'range', min: 0, max: 2, step: 0.1, fmt: times, tip: 'Patches of an old fire: black and ash-grey ground, charred bare trunks, little grass.' },
          { path: 'map.fallenTrees', label: 'Fallen trees', type: 'range', min: 0, max: 3, step: 0.1, fmt: times, tip: 'Logs on the ground, uprooted or snapped, most in forests, the grey zone and burnt land. Solid obstacles.' },
        ],
      },
      {
        title: 'Vegetation & villages',
        fields: [
          { path: 'map.vegetation', label: 'Vegetation', type: 'range', min: 0.3, max: 2, step: 0.1, fmt: times, tip: 'Trees and bushes overall.' },
          { path: 'map.treeLines', label: 'Tree lines', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Windbreaks between fields, a typical hiding place for vehicles.' },
          { path: 'map.forest', label: 'Forest', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Amount of forest patches.' },
          { path: 'map.ruins', label: 'Ruined houses', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Share of village houses that are burnt shells or collapsed.' },
        ],
      },
    ],
  },
  {
    id: 'graphics', label: 'Graphics', icon: '◧', preview: 'scene',
    groups: [
      { title: 'Quality preset', custom: 'quality' },
      {
        title: 'Lighting',
        fields: [
          { path: 'graphics.shadows', label: 'Shadows', type: 'select', options: [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], tip: 'Sun shadows from trees, buildings and vehicles. Higher = sharper and reaching farther; costs fps over forests.' },
          { path: 'graphics.droneShadow', label: 'Drone shadow', type: 'checkbox', tip: 'Your drone\'s shadow on the ground, sharp up close and blurring out with height, like in real footage. Almost free.' },
        ],
      },
      {
        title: 'Grass',
        fields: [
          { path: 'graphics.grass', label: 'Grass', type: 'select', options: [['flat', 'Flat (fast)'], ['3d', '3D blades + prop wash'], ['off', 'Off']], tip: 'Flat = painted on the ground, free. 3D = real blades that sway and flatten under your props; about 10 fps slower on an Air.' },
          { path: 'graphics.grassDensity', label: 'Density', type: 'range', min: 0.2, max: 2, step: 0.1, fmt: times, tip: '3D grass only: blades per square metre.' },
          { path: 'graphics.grassRadius', label: 'Distance', type: 'range', min: 30, max: 200, step: 10, fmt: meters, tip: '3D grass only: how far the blades reach. Biggest fps cost.' },
          { path: 'graphics.grassHeight', label: 'Height', type: 'range', min: 0.3, max: 2, step: 0.1, fmt: times, tip: '3D grass only.' },
          { path: 'graphics.propWash', label: 'Prop wash', type: 'checkbox', tip: '3D grass only: blades flatten under the drone close to the ground.' },
        ],
      },
      {
        title: 'Detail',
        fields: [
          { path: 'map.renderDistance', label: 'View distance', type: 'range', min: 300, max: 1500, step: 50, fmt: meters, tip: 'Everything beyond is fog. Big effect on fps.' },
          { path: 'map.detailDistance', label: 'Detail radius', type: 'range', min: 100, max: 500, step: 20, fmt: meters, tip: 'Radius with full-detail terrain and trees; simpler versions beyond.' },
          { path: 'map.terrainCell', label: 'Terrain detail', type: 'select', number: true, options: [[1, 'Ultra (1 m)'], [2, 'High (2 m)'], [4, 'Medium (4 m)'], [8, 'Low (8 m)']], tip: 'Ground mesh resolution: smaller cells = finer bumps, berms and craters. Rebuilds the map.' },
          { path: 'map.vegDetail', label: 'Tree detail', type: 'select', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], tip: 'Polygons per tree. Collision shapes follow the visible shape at every level. Rebuilds the map.' },
          { path: 'map.renderScale', label: 'Screen resolution', type: 'select', number: true, options: [[1, '×1.0 (fast)'], [1.25, '×1.25'], [1.5, '×1.5'], [2, '×2.0 (sharpest)']], tip: 'Pixel density of the final image on Retina screens. Camera resolution (Camera tab) usually matters more.' },
        ],
      },
      {
        title: 'Effects',
        fields: [
          { path: 'graphics.groundTexture', label: 'Ground texture', type: 'range', min: 0, max: 1.5, step: 0.05, fmt: pct, tip: 'Strength of the close-up dirt and grass detail. Helps judge height when landing.' },
          { path: 'graphics.dust', label: 'Vehicle dust', type: 'checkbox', tip: 'Dust trails behind driving vehicles: easier to spot from far away.' },
        ],
      },
    ],
  },
  {
    id: 'audio', label: 'Audio', icon: '♪',
    groups: [
      {
        title: 'Audio',
        fields: [
          { path: 'audio.volume', label: 'Volume', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, tip: 'Master volume.' },
          { path: 'audio.muted', label: 'Mute', type: 'checkbox', tip: 'M toggles it in flight.' },
        ],
      },
    ],
  },
  {
    id: 'controller', label: 'Controller', icon: '✥', preview: 'sticks',
    groups: [{ title: '', custom: 'controller' }],
  },
  {
    id: 'general', label: 'General', icon: '⌨',
    groups: [
      {
        title: 'Screenshots',
        fields: [
          { path: 'screenshot.hud', label: 'Include HUD', type: 'checkbox', tip: 'Draw the HUD (and mission overlays) into the screenshot.' },
          { path: 'screenshot.stamp', label: 'Info stamp', type: 'checkbox', tip: 'Small line in the corner with map seed, graphics settings and fps, so a screenshot shows exactly what was running.' },
        ],
        actions: [['screenshot', 'Take screenshot now (K)']],
        info: () => 'Screenshots are saved as PNG to your Downloads folder. K or a mapped radio switch takes one in flight.',
      },
      { title: 'Keyboard', custom: 'keys' },
    ],
  },
];

export const KEYS = [
  ['1', 'Free flight'], ['2', 'Strike mission'], ['Enter', 'Retry mission'], ['X', 'Detonate'],
  ['Esc', 'Settings'], ['C', 'Controller setup'], ['K', 'Screenshot'], ['N', 'Day / night'],
  ['R', 'Reset drone'], ['P', 'Drop payload'], ['M', 'Mute'], ['F', 'Frame-time graph'],
  ['Space', 'Arm (keyboard)'], ['W / S', 'Throttle (keyboard)'], ['Arrows', 'Pitch / roll (keyboard)'], ['A / D', 'Yaw (keyboard)'],
];
