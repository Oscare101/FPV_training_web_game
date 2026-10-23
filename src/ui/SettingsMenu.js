import { DRONE_PRESETS } from '../flight/presets.js';
import { LAUNCH_SPOTS } from '../world/gen/layout.js';
import { maxRate } from '../flight/rates.js';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => COMPASS[Math.round(deg / 45) % 8];

const pct = (v) => `${Math.round(v * 100)}%`;
const TABS = ['Drone', 'Flight', 'Mission', 'World', 'Graphics', 'Audio'];

const SECTIONS = [
  {
    tab: 'Drone',
    title: 'Drone',
    fields: [
      {
        path: 'drone.preset', label: 'Type', type: 'select',
        options: [...Object.entries(DRONE_PRESETS).map(([k, p]) => [k, p.label]), ['custom', 'Custom']],
      },
      { path: 'drone.size', label: 'Size (prop)', type: 'range', min: 3, max: 10, step: 0.5, fmt: (v) => `${v}"` },
      { path: 'drone.mass', label: 'Mass (w/o payload)', type: 'range', min: 0.2, max: 4, step: 0.05, fmt: (v) => `${v.toFixed(2)} kg` },
      { path: 'drone.thrustToWeight', label: 'Thrust-to-weight', type: 'range', min: 1.5, max: 14, step: 0.1, fmt: (v) => `${v.toFixed(1)}:1` },
      { path: 'drone.payload', label: 'Payload', type: 'range', min: 0, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)} kg` },
      { path: 'drone.cells', label: 'Battery cells', type: 'select', options: [[4, '4S'], [6, '6S'], [8, '8S']], number: true },
      { path: 'drone.capacity', label: 'Battery capacity', type: 'range', min: 450, max: 10000, step: 50, fmt: (v) => `${v} mAh` },
      { path: 'drone.batterySim', label: 'Battery sag', type: 'checkbox' },
    ],
    info: (d) => {
      const maxThrust = d.drone.thrustToWeight * d.drone.mass * 9.81;
      const twr = maxThrust / ((d.drone.mass + d.drone.payload) * 9.81);
      const motor = Math.sqrt(1 / twr);
      const hover = twr > 1 ? Math.round(((motor - 0.05) / 0.95) * 100) : null;
      return `Max thrust ${maxThrust.toFixed(0)} N · loaded TWR ${twr.toFixed(1)} · hover ≈ ${hover === null ? 'cannot hover' : `${hover}%`} (full battery)`;
    },
  },
  { tab: 'Flight', rates: true },
  {
    tab: 'Flight',
    title: 'Camera',
    fields: [
      { path: 'camera.uptilt', label: 'Uptilt', type: 'range', min: 0, max: 60, step: 1, fmt: (v) => `${v}°` },
      { path: 'camera.fov', label: 'FOV (horizontal)', type: 'range', min: 80, max: 150, step: 1, fmt: (v) => `${v}°` },
    ],
  },
  {
    tab: 'World',
    title: 'Weather & time',
    fields: [
      { path: 'env.windSpeed', label: 'Wind', type: 'range', min: 0, max: 15, step: 0.5, fmt: (v) => `${v} m/s (${Math.round(v * 3.6)} km/h)` },
      { path: 'env.windDir', label: 'Wind from', type: 'range', min: 0, max: 345, step: 15, fmt: (v) => `${v}° ${compass(v)}` },
      { path: 'env.gustiness', label: 'Gusts (drift)', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
      { path: 'env.turbulence', label: 'Turbulence (bumps)', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
      { path: 'env.night', label: 'Night (N)', type: 'checkbox' },
    ],
  },
  {
    tab: 'World',
    title: 'Map generation (applies to the next map)',
    fields: [
      { path: 'map.size', label: 'Map size', type: 'select', number: true, options: [[1500, '1.5 km'], [2000, '2 km'], [3000, '3 km']] },
      { path: 'map.launchMin', label: 'Launch distance min', type: 'range', min: 200, max: 1500, step: 50, fmt: (v) => `${v} m` },
      { path: 'map.launchMax', label: 'Launch distance max', type: 'range', min: 300, max: 1800, step: 50, fmt: (v) => `${v} m` },
      { path: 'map.enemySites', label: 'Enemy positions', type: 'range', min: 1, max: 6, step: 1, fmt: (v) => `${v}` },
      { path: 'map.vehiclesPerSite', label: 'Vehicles per position', type: 'range', min: 1, max: 6, step: 1, fmt: (v) => `~${v}` },
      { path: 'map.movingVehicles', label: 'Moving vehicles', type: 'range', min: 0, max: 8, step: 1, fmt: (v) => `${v}` },
      { path: 'map.camoNets', label: 'Camo nets', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { path: 'map.branchCamo', label: 'Branch piles (no net)', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { path: 'map.wrecks', label: 'Burnt-out wrecks', type: 'range', min: 0, max: 15, step: 1, fmt: (v) => `${v}` },
      { path: 'map.vegetation', label: 'Vegetation density', type: 'range', min: 0.3, max: 2, step: 0.1, fmt: (v) => `×${v.toFixed(1)}` },
      { path: 'map.treeLines', label: 'Tree lines', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { path: 'map.forest', label: 'Forest', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { path: 'map.craters', label: 'Shelling (craters)', type: 'range', min: 0, max: 3, step: 0.1, fmt: (v) => `×${v.toFixed(1)}` },
      { path: 'map.ruins', label: 'Ruined houses', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { path: 'map.hilliness', label: 'Hills & lowlands', type: 'range', min: 0, max: 2.5, step: 0.1, fmt: (v) => `×${v.toFixed(1)}` },
      { path: 'map.ravines', label: 'Ravines', type: 'range', min: 0, max: 5, step: 1, fmt: (v) => `${v}` },
      { path: 'map.revetments', label: 'Dug-in vehicles (berms)', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      {
        path: 'map.launchSpot', label: 'Launch spot', type: 'select',
        options: [['random', 'Random'], ...LAUNCH_SPOTS.map((k) => [k, k[0].toUpperCase() + k.slice(1)])],
      },
      { path: 'map.seed', label: 'Seed (0 = random)', type: 'number' },
    ],
    actions: [['new-map', 'Generate new map now']],
  },
  {
    tab: 'Graphics',
    title: 'FPV camera look',
    fields: [
      { path: 'graphics.look', label: 'Camera style', type: 'select', options: [['digital', 'Digital HD'], ['analog', 'Analog'], ['clean', 'Clean'], ['off', 'Off (no effects)']] },
      { path: 'graphics.lines', label: 'Camera resolution', type: 'select', number: true, options: [[360, '360 lines'], [480, '480 lines'], [720, '720 lines'], [1080, '1080 lines'], [0, 'Native']] },
      { path: 'graphics.distortion', label: 'Lens distortion', type: 'range', min: 0, max: 1, step: 0.02, fmt: pct },
      { path: 'graphics.aberration', label: 'Colour fringing', type: 'range', min: 0, max: 1.5, step: 0.05, fmt: pct },
      { path: 'graphics.noise', label: 'Grain / noise', type: 'range', min: 0, max: 0.3, step: 0.005, fmt: (v) => `${Math.round(v * 1000) / 10}%` },
      { path: 'graphics.vignette', label: 'Vignette', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { path: 'graphics.saturation', label: 'Saturation', type: 'range', min: 0, max: 1.6, step: 0.02, fmt: pct },
      { path: 'graphics.contrast', label: 'Contrast', type: 'range', min: 0.6, max: 1.6, step: 0.02, fmt: pct },
      { path: 'graphics.brightness', label: 'Brightness', type: 'range', min: 0.6, max: 1.5, step: 0.02, fmt: pct },
      { path: 'graphics.sharpness', label: 'Sharpening', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
    ],
    info: () => 'Picking a camera style loads its preset; the sliders then fine-tune it.',
  },
  {
    tab: 'Graphics',
    title: 'Scene',
    fields: [
      { path: 'graphics.grass', label: 'Grass', type: 'select', options: [['flat', 'Flat (fast)'], ['3d', '3D blades + prop wash'], ['off', 'Off']] },
      { path: 'graphics.grassDensity', label: 'Grass density', type: 'range', min: 0.2, max: 2, step: 0.1, fmt: (v) => `×${v.toFixed(1)}` },
      { path: 'graphics.grassRadius', label: 'Grass distance', type: 'range', min: 30, max: 200, step: 10, fmt: (v) => `${v} m` },
      { path: 'graphics.grassHeight', label: 'Grass height', type: 'range', min: 0.3, max: 2, step: 0.1, fmt: (v) => `×${v.toFixed(1)}` },
      { path: 'graphics.propWash', label: 'Prop wash on grass', type: 'checkbox' },
      { path: 'graphics.shadows', label: 'Shadows', type: 'select', options: [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
      { path: 'graphics.clouds', label: 'Clouds', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { path: 'graphics.groundTexture', label: 'Ground texture', type: 'range', min: 0, max: 1.5, step: 0.05, fmt: pct },
      { path: 'graphics.dust', label: 'Vehicle dust', type: 'checkbox' },
    ],
  },
  {
    tab: 'Graphics',
    title: 'Detail & performance (terrain/tree detail rebuilds the map)',
    fields: [
      { path: 'map.renderDistance', label: 'Render distance', type: 'range', min: 300, max: 1500, step: 50, fmt: (v) => `${v} m` },
      { path: 'map.renderScale', label: 'Render resolution', type: 'select', number: true, options: [[1, '×1.0 (fast)'], [1.25, '×1.25'], [1.5, '×1.5'], [2, '×2.0 (sharpest)']] },
      { path: 'map.terrainCell', label: 'Terrain detail', type: 'select', number: true, options: [[1, 'Ultra (1 m)'], [2, 'High (2 m)'], [4, 'Medium (4 m)'], [8, 'Low (8 m)']] },
      { path: 'map.vegDetail', label: 'Tree & bush detail', type: 'select', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] },
      { path: 'map.detailDistance', label: 'Full-detail distance', type: 'range', min: 100, max: 500, step: 20, fmt: (v) => `${v} m` },
    ],
  },
  {
    tab: 'Mission',
    title: 'Strike mission',
    fields: [
      {
        path: 'mission.targetMode', label: 'Target mode', type: 'select',
        options: [['easy', 'Easy — exact marker'], ['medium', 'Medium — rough direction'], ['hard', 'Hard — find them yourself']],
      },
      { path: 'mission.enemyReaction', label: 'Enemy reaction', type: 'checkbox' },
      { path: 'mission.alertness', label: 'Enemy alertness', type: 'range', min: 0.3, max: 3, step: 0.1, fmt: (v) => `×${v.toFixed(1)}` },
      { path: 'map.newMapEachMission', label: 'New map every mission', type: 'checkbox' },
    ],
    info: (d) => ({
      easy: 'One assigned target, exact marker. Hitting another vehicle is a wrong target.',
      medium: 'Rough bearing and distance to an enemy position, "ENEMY NEAR" when close. Any enemy vehicle or ammo counts.',
      hard: 'Only the general sector. Find the enemy yourself. Any enemy vehicle or ammo counts.',
    })[d.mission.targetMode],
  },
  {
    tab: 'Audio',
    title: 'Audio',
    fields: [
      { path: 'audio.volume', label: 'Volume', type: 'range', min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
      { path: 'audio.muted', label: 'Mute (M)', type: 'checkbox' },
    ],
  },
];

const RATE_AXES = ['roll', 'pitch', 'yaw'];
const RATE_FIELDS = [
  { key: 'rcRate', label: 'RC rate', min: 0.01, max: 2.55, step: 0.01 },
  { key: 'superRate', label: 'Super rate', min: 0, max: 0.99, step: 0.01 },
  { key: 'expo', label: 'Expo', min: 0, max: 1, step: 0.01 },
];

const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

export class SettingsMenu {
  constructor(settings, parent, { onOpenController, onNewMap }) {
    this.settings = settings;
    this.visible = false;
    this.bindings = []; // { path, el, type, out?, fmt? }
    this.infos = []; // { el, fn }
    this.rateMax = {};

    this.root = document.createElement('div');
    this.root.className = 'calib settings';
    this.root.hidden = true;
    const panel = document.createElement('div');
    panel.className = 'calib-panel';
    panel.innerHTML = `
      <header>
        <h1>Settings</h1>
        <div class="row-actions">
          <button data-action="controller">Controller setup (C)</button>
          <button data-action="close">Close (Esc)</button>
        </div>
      </header>`;
    this.root.appendChild(panel);
    parent.appendChild(this.root);

    // Tabs
    const tabBar = document.createElement('nav');
    tabBar.className = 'tabs';
    panel.appendChild(tabBar);
    this.tabPanels = {};
    this.tabButtons = {};
    for (const tab of TABS) {
      const btn = document.createElement('button');
      btn.textContent = tab;
      btn.dataset.tab = tab;
      tabBar.appendChild(btn);
      this.tabButtons[tab] = btn;
      const tp = document.createElement('div');
      tp.className = 'tab-panel';
      panel.appendChild(tp);
      this.tabPanels[tab] = tp;
    }
    for (const sec of SECTIONS) {
      this.tabPanels[sec.tab].appendChild(sec.rates ? this.buildRates() : this.buildSection(sec));
    }
    this.selectTab('Drone');

    const footer = document.createElement('footer');
    footer.innerHTML = `
      <div><kbd>1</kbd> free flight · <kbd>2</kbd> strike mission · <kbd>X</kbd> detonate · <kbd>Esc</kbd> settings · <kbd>C</kbd> controller · <kbd>N</kbd> day/night · <kbd>R</kbd> reset · <kbd>P</kbd> drop payload · <kbd>M</kbd> mute · <kbd>F</kbd> frame graph</div>
      <button data-action="reset" class="secondary">Reset all settings</button>`;
    panel.appendChild(footer);

    panel.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) {
        this.selectTab(tabBtn.dataset.tab);
        tabBtn.blur();
        return;
      }
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'new-map') onNewMap();
      if (btn.dataset.action === 'close') this.hide();
      if (btn.dataset.action === 'controller') {
        this.hide();
        onOpenController();
      }
      if (btn.dataset.action === 'reset') settings.reset();
      btn.blur();
    });

    settings.onChange(() => this.sync());
    this.sync();
  }

  selectTab(tab) {
    for (const t of TABS) {
      this.tabPanels[t].hidden = t !== tab;
      this.tabButtons[t].classList.toggle('active', t === tab);
    }
  }

  buildSection({ title, fields, info, actions }) {
    const section = document.createElement('section');
    section.innerHTML = `<h2>${title}</h2>`;
    for (const f of fields) {
      const row = document.createElement('label');
      row.className = 'setting-row';
      row.innerHTML = `<span class="setting-label">${f.label}</span>`;
      let el;
      if (f.type === 'select') {
        el = document.createElement('select');
        el.innerHTML = f.options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      } else {
        el = document.createElement('input');
        el.type = f.type;
        if (f.type === 'range') Object.assign(el, { min: f.min, max: f.max, step: f.step });
      }
      row.appendChild(el);
      const out = document.createElement('span');
      out.className = 'setting-value';
      row.appendChild(out);
      section.appendChild(row);

      const event = f.type === 'range' ? 'input' : 'change';
      el.addEventListener(event, () => {
        if (f.path === 'drone.preset') {
          if (el.value !== 'custom') this.settings.applyPreset(el.value);
          return;
        }
        if (f.path === 'graphics.look') {
          this.settings.applyLook(el.value);
          return;
        }
        const value = f.type === 'checkbox' ? el.checked
          : f.type === 'range' || f.type === 'number' || f.number ? Number(el.value) || 0 : el.value;
        this.settings.set(f.path, value);
      });
      this.bindings.push({ ...f, el, out });
    }
    if (actions) {
      const row = document.createElement('div');
      row.className = 'row-actions';
      row.innerHTML = actions.map(([action, label]) => `<button data-action="${action}">${label}</button>`).join('');
      section.appendChild(row);
    }
    if (info) {
      const p = document.createElement('p');
      p.className = 'setting-info';
      section.appendChild(p);
      this.infos.push({ el: p, fn: info });
    }
    return section;
  }

  buildRates() {
    const section = document.createElement('section');
    section.innerHTML = `
      <h2>Rates (Betaflight)</h2>
      <table class="rates">
        <thead><tr><th></th>${RATE_FIELDS.map((f) => `<th>${f.label}</th>`).join('')}<th>Max</th></tr></thead>
        <tbody></tbody>
      </table>`;
    const tbody = section.querySelector('tbody');
    for (const axis of RATE_AXES) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${axis[0].toUpperCase() + axis.slice(1)}</td>`;
      for (const f of RATE_FIELDS) {
        const td = document.createElement('td');
        const el = document.createElement('input');
        Object.assign(el, { type: 'number', min: f.min, max: f.max, step: f.step });
        el.addEventListener('change', () => {
          const v = Math.min(f.max, Math.max(f.min, Number(el.value) || 0));
          this.settings.set(`rates.${axis}.${f.key}`, v);
        });
        td.appendChild(el);
        tr.appendChild(td);
        this.bindings.push({ path: `rates.${axis}.${f.key}`, type: 'number', el });
      }
      const max = document.createElement('td');
      max.className = 'setting-value';
      tr.appendChild(max);
      this.rateMax[axis] = max;
      tbody.appendChild(tr);
    }
    return section;
  }

  sync() {
    const data = this.settings.data;
    for (const b of this.bindings) {
      const v = this.settings.get(b.path);
      if (b.type === 'checkbox') b.el.checked = v;
      else if (document.activeElement !== b.el || b.type === 'range') b.el.value = String(v);
      if (b.out) setText(b.out, b.fmt ? b.fmt(v) : '');
    }
    for (const axis of RATE_AXES) setText(this.rateMax[axis], `${Math.round(maxRate(data.rates[axis]))}°/s`);
    for (const { el, fn } of this.infos) setText(el, fn(data));
  }

  show() {
    this.visible = true;
    this.root.hidden = false;
    this.sync();
  }

  hide() {
    this.visible = false;
    this.root.hidden = true;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }
}
