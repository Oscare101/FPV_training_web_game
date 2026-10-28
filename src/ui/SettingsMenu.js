import { maxRate, betaflightRate } from '../flight/rates.js';
import { defaultSettings } from '../settings/Settings.js';
import { CATEGORIES, QUALITY_PRESETS, KEYS } from './settingsSchema.js';
import { CalibrationScreen } from './CalibrationScreen.js';
import { Osd } from './Osd.js';
import { computeSun } from '../world/sun.js';
import { ZONES, BLAST, GUIDE, GUIDE_RULES } from '../world/damage.js';
import { renderVehiclePortraits } from '../render/portraits.js';

const EFFECT_COLOR = { destroyed: '#e2553c', immobilized: '#e6a33a', damaged: '#a9a57a' }; // = portraits.js ZONE_COLORS
const EFFECT_WORD = { destroyed: 'destroyed', immobilized: 'immobilized', damaged: 'damaged' };

const RATE_AXES = ['roll', 'pitch', 'yaw'];
const RATE_COLORS = { roll: '#9ccc4a', pitch: '#e0a040', yaw: '#6ab8ff' };
const RATE_FIELDS = [
  { key: 'rcRate', label: 'RC rate', min: 0.01, max: 2.55, step: 0.01, tip: 'Overall sensitivity, mostly around centre stick.' },
  { key: 'superRate', label: 'Super rate', min: 0, max: 0.99, step: 0.01, tip: 'Adds rate towards full stick: raises the max rotation speed without making centre twitchy.' },
  { key: 'expo', label: 'Expo', min: 0, max: 1, step: 0.01, tip: 'Softens the centre for fine control; full-stick rate stays the same.' },
];
const PREVIEW_MODES = [['fpv', 'Drone view'], ['orbit', 'Orbit'], ['top', 'Above']];

const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};
const h = (tag, cls, html) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
};
const infoIcon = (tip) => {
  const el = h('span', 'info', 'i');
  el.dataset.tip = tip;
  return el;
};
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

// Settings: docked panel on the left, live scene on the right as the preview.
// Categories in a side nav, grouped fields with tooltips, search, per-field reset.
export class SettingsMenu {
  // hooks: { input, onNewMap, onScreenshot }
  constructor(settings, parent, hooks) {
    this.settings = settings;
    this.hooks = hooks;
    this.defaults = defaultSettings();
    this.visible = false;
    this.category = 'drone';
    this.previewMode = 'fpv';
    this.bindings = []; // { path, el, type, out, fmt, row, revert }
    this.infos = []; // { el, fn }
    this.rateMax = {};
    this.wantSnapshot = false;

    this.root = h('div', 'menu');
    this.root.hidden = true;
    this.panel = h('div', 'menu-panel');
    this.root.appendChild(this.panel);
    parent.appendChild(this.root);

    const header = h('header', 'menu-header', `
      <h1>Settings</h1>
      <input class="menu-search" type="search" placeholder="Search settings…" />
      <button data-action="close" title="Close (Esc)">✕</button>`);
    this.nav = h('nav', 'menu-nav');
    this.content = h('div', 'menu-content');
    const footer = h('footer', 'menu-footer', `
      <span><kbd>Esc</kbd> close · <kbd>K</kbd> screenshot · <kbd>C</kbd> controller</span>
      <span class="menu-footer-actions">
        <button data-action="reset-page" class="secondary">Reset this page</button>
        <button data-action="reset-all" class="secondary">Reset all</button>
      </span>`);
    this.panel.append(header, this.nav, this.content, footer);
    this.search = header.querySelector('.menu-search');
    this.titleEl = header.querySelector('h1');
    this.allowed = null; // category ids shown in this context (null = all)

    // Preview toolbar over the live scene
    this.previewBar = h('div', 'menu-preview', `
      <span class="menu-preview-label">LIVE PREVIEW</span>
      <span class="seg">${PREVIEW_MODES.map(([k, l]) => `<button data-preview="${k}">${l}</button>`).join('')}</span>
      <button data-action="screenshot" title="Save a screenshot (K)">Screenshot</button>
      <span class="menu-status"></span>`);
    // Controller page: FPV view of a drone hovering in place, turned by the sticks at your rates
    this.sticksBar = h('div', 'menu-preview', `
      <span class="menu-preview-label">FPV PREVIEW</span>
      <span class="menu-preview-hint">Move the sticks: the view turns at your rates (acro, no self-levelling)</span>
      <button data-action="level">Level</button>`);
    this.sticksBar.hidden = true;
    this.root.appendChild(this.sticksBar);
    this.levelRequest = 0;
    this.root.appendChild(this.previewBar);
    this.statusEl = this.previewBar.querySelector('.menu-status');

    this.tooltip = h('div', 'tooltip');
    this.tooltip.hidden = true;
    this.root.appendChild(this.tooltip);

    // Pages
    this.pages = {};
    this.navButtons = {};
    this.navSections = {}; // section name -> header element (above its first category)
    for (const cat of CATEGORIES) {
      if (cat.section && !this.navSections[cat.section]) {
        this.navSections[cat.section] = h('div', 'nav-section', cat.section);
        this.nav.appendChild(this.navSections[cat.section]);
      }
      const btn = h('button', '', `<span class="nav-icon">${cat.icon}</span>${cat.label}`);
      btn.dataset.cat = cat.id;
      this.nav.appendChild(btn);
      this.navButtons[cat.id] = btn;
      const page = h('div', 'menu-page');
      page.dataset.cat = cat.id;
      page.appendChild(h('h2', 'page-title', cat.label));
      if (cat.note) page.appendChild(h('p', 'page-note', cat.note));
      for (const g of cat.groups) page.appendChild(this.buildGroup(g, cat));
      this.content.appendChild(page);
      this.pages[cat.id] = page;
    }

    this.bindEvents();
    this.selectCategory('drone');
    settings.onChange(() => this.sync());
    this.sync();
  }

  get calibrationActive() {
    return this.visible && this.category === 'controller' && !this.search.value;
  }

  // ---------- building ----------

  buildGroup(g, cat) {
    const section = h('section', 'group');
    if (g.title) section.appendChild(h('h3', '', g.title));
    if (g.note) section.appendChild(h('p', 'group-note', g.note));
    if (g.custom === 'rates') section.appendChild(this.buildRates());
    if (g.custom === 'quality') section.appendChild(this.buildQuality());
    if (g.custom === 'keys') section.appendChild(this.buildKeys());
    if (g.custom === 'osdPreview') section.appendChild(this.buildOsdPreview());
    if (g.custom === 'guide') {
      section.className = 'group-plain';
      section.appendChild(this.buildGuide());
    }
    if (g.custom === 'stats') {
      section.className = 'group-plain';
      this.statsEl = h('div', 'stats');
      section.appendChild(this.statsEl);
      this.statsEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-stats-reset]')) this.confirm('Reset all statistics?', 'Time, flights, strikes, kills and records per mode start again from zero.', 'Reset', () => this.hooks.stats.reset());
      });
      this.hooks.stats?.onChange(() => this.category === 'stats' && this.renderStats());
    }
    if (g.custom === 'controller') {
      section.className = 'group-plain';
      const mount = h('div');
      section.appendChild(mount);
      this.calibration = new CalibrationScreen(this.hooks.input, mount);
    }
    if (g.fields) {
      const basic = g.fields.filter((f) => !f.advanced);
      const adv = g.fields.filter((f) => f.advanced);
      for (const f of basic) section.appendChild(this.buildRow(f, cat, g));
      if (adv.length) {
        const details = h('details', 'adv', `<summary>Advanced · ${adv.length}</summary>`);
        for (const f of adv) details.appendChild(this.buildRow(f, cat, g));
        section.appendChild(details);
      }
    }
    if (g.actions) {
      const row = h('div', 'row-actions', g.actions.map(([a, l]) => `<button data-action="${a}">${l}</button>`).join(''));
      section.appendChild(row);
    }
    if (g.info) {
      const p = h('p', 'group-info');
      section.appendChild(p);
      this.infos.push({ el: p, fn: g.info });
    }
    return section;
  }

  buildRow(f, cat, g) {
    const row = h('div', `srow ${f.type}`);
    row.dataset.search = `${f.label} ${f.tip ?? ''} ${g.title ?? ''} ${cat.label}`.toLowerCase();
    const label = h('div', 'srow-label', `<span>${f.label}</span>`);
    if (f.tip) label.appendChild(infoIcon(f.tip));
    const revert = h('button', 'revert', '↺');
    revert.title = 'Reset to default';
    label.appendChild(revert);
    row.appendChild(label);

    let el;
    if (f.type === 'select') {
      el = h('select', '', f.options.map(([v, l]) => `<option value="${v}">${l}</option>`).join(''));
    } else if (f.type === 'checkbox') {
      el = h('input', 'toggle');
      el.type = 'checkbox';
    } else {
      el = h('input');
      el.type = f.type;
      if (f.type === 'range') Object.assign(el, { min: f.min, max: f.max, step: f.step });
    }
    const control = h('div', 'srow-control');
    control.appendChild(el);
    row.appendChild(control);
    const out = h('span', 'srow-value');
    row.appendChild(out);

    el.addEventListener(f.type === 'range' ? 'input' : 'change', () => {
      const value = f.type === 'checkbox' ? el.checked
        : f.type === 'range' || f.type === 'number' || f.number ? Number(el.value) || 0 : el.value;
      this.setValue(f.path, value);
    });
    revert.addEventListener('click', () => this.setValue(f.path, getPath(this.defaults, f.path)));
    this.bindings.push({ ...f, el, out, row, revert });
    return row;
  }

  setValue(path, value) {
    if (path === 'drone.preset') {
      if (value !== 'custom') this.settings.applyPreset(value);
      else this.sync();
      return;
    }
    if (path === 'graphics.look') {
      this.settings.applyLook(value);
      return;
    }
    if (path === 'env.weather') {
      this.settings.applyWeather(value);
      return;
    }
    if (path === 'env.hour') {
      this.settings.setMany({ 'env.hour': value, 'env.timeOfDay': 'custom' });
      return;
    }
    if (path === 'env.timeOfDay' && value !== 'custom') {
      const d = this.settings.data;
      this.settings.setMany({ 'env.timeOfDay': value, 'env.hour': Math.round(computeSun({ ...d.env, season: d.map.season, timeOfDay: value }).hour * 4) / 4 });
      return;
    }
    this.settings.set(path, value);
  }

  buildRates() {
    const wrap = h('div', 'rates-wrap');
    const table = h('table', 'rates', `
      <thead><tr><th></th>${RATE_FIELDS.map((f) => `<th>${f.label}</th>`).join('')}<th>Max</th></tr></thead>
      <tbody></tbody>`);
    const ths = table.querySelectorAll('th');
    RATE_FIELDS.forEach((f, i) => ths[i + 1].appendChild(infoIcon(f.tip)));
    const tbody = table.querySelector('tbody');
    for (const axis of RATE_AXES) {
      const tr = h('tr', '', `<td><i class="swatch" style="background:${RATE_COLORS[axis]}"></i>${axis[0].toUpperCase() + axis.slice(1)}</td>`);
      tr.dataset.search = `rates ${axis} rc rate super expo`;
      for (const f of RATE_FIELDS) {
        const td = h('td');
        const el = h('input');
        Object.assign(el, { type: 'number', min: f.min, max: f.max, step: f.step });
        el.addEventListener('change', () => {
          const v = Math.min(f.max, Math.max(f.min, Number(el.value) || 0));
          this.settings.set(`rates.${axis}.${f.key}`, v);
        });
        td.appendChild(el);
        tr.appendChild(td);
        this.bindings.push({ path: `rates.${axis}.${f.key}`, type: 'number', el });
      }
      const max = h('td', 'srow-value');
      tr.appendChild(max);
      this.rateMax[axis] = max;
      tbody.appendChild(tr);
    }
    this.rateCanvas = h('canvas', 'rate-curve');
    this.rateCanvas.width = 760;
    this.rateCanvas.height = 300;
    const actions = h('div', 'row-actions', '<button data-action="reset-rates" class="secondary">Default rates</button>');
    wrap.append(table, this.rateCanvas, h('p', 'group-info', 'Rotation speed (deg/s) over stick travel, centre to full. Copy RC rate / Super rate / Expo from Betaflight or Velocidrone to get the same feel.'), actions);
    return wrap;
  }

  drawRates() {
    const cv = this.rateCanvas;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width;
    const H = cv.height;
    const P = { l: 56, r: 36, t: 14, b: 34 };
    const rates = this.settings.data.rates;
    const top = Math.max(400, ...RATE_AXES.map((a) => maxRate(rates[a])));
    const yMax = Math.ceil(top / 200) * 200;
    ctx.clearRect(0, 0, W, H);
    ctx.font = '20px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#8a978c';
    ctx.strokeStyle = '#2f3a33';
    ctx.lineWidth = 1.5;
    for (let v = 0; v <= yMax; v += 200) {
      const y = H - P.b - (v / yMax) * (H - P.t - P.b);
      ctx.beginPath();
      ctx.moveTo(P.l, y);
      ctx.lineTo(W - P.r, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(String(v), P.l - 8, y + 7);
    }
    ctx.textAlign = 'center';
    for (const s of [0, 0.25, 0.5, 0.75, 1]) ctx.fillText(`${s * 100}%`, P.l + s * (W - P.l - P.r), H - 8);
    ctx.lineWidth = 3.5;
    for (const axis of RATE_AXES) {
      ctx.strokeStyle = RATE_COLORS[axis];
      ctx.beginPath();
      for (let i = 0; i <= 100; i++) {
        const s = i / 100;
        const x = P.l + s * (W - P.l - P.r);
        const y = H - P.b - (Math.min(yMax, betaflightRate(s, rates[axis])) / yMax) * (H - P.t - P.b);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
  }

  buildQuality() {
    const wrap = h('div', 'quality');
    this.qualityButtons = {};
    for (const [k, p] of Object.entries(QUALITY_PRESETS)) {
      const b = h('button', 'quality-btn', `<b>${p.label}</b><small>${p.tip}</small>`);
      b.dataset.quality = k;
      wrap.appendChild(b);
      this.qualityButtons[k] = b;
    }
    return wrap;
  }

  // Target guide: per vehicle, direct-hit zone maps (top and side, drawn from the real zone rules),
  // near-miss chances by distance, and tips; general rules first
  // Vehicle pictures (guide, statistics), rendered once
  portraits() {
    this.portraitCache ??= renderVehiclePortraits();
    return this.portraitCache;
  }

  renderStats() {
    const d = this.hooks.stats?.data;
    if (!d || !this.statsEl) return;
    const hm = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min` : `${Math.round(s)} s`);
    const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
    const tile = (value, label, note = '') => `<div class="stat-tile"><b>${value}</b><span>${label}</span>${note ? `<small>${note}</small>` : ''}</div>`;
    const totals = Object.values(d.kills).reduce((s, k) => ({ destroyed: s.destroyed + k.destroyed, immobilized: s.immobilized + k.immobilized, damaged: s.damaged + k.damaged }), { destroyed: 0, immobilized: 0, damaged: 0 });
    const modeName = { free: 'Free Flight', strike: 'Strike Missions', hunt: 'Hunt', hide: 'Hide & Seek' };
    const zones = Object.entries(d.zones).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const drones = Object.entries(d.drones).sort((a, b) => b[1].time - a[1].time);
    const since = new Date(d.since).toLocaleDateString();
    const vehicleCards = Object.entries(d.kills).map(([type, k]) => `
      <div class="stat-vehicle${k.destroyed + k.immobilized + k.damaged ? '' : ' none'}">
        <img data-type="${type}" alt="${GUIDE[type].label}">
        <div><h4>${GUIDE[type].label}</h4>
          ${['destroyed', 'immobilized', 'damaged'].map((e) => `<span><i style="background:${EFFECT_COLOR[e]}"></i>${EFFECT_WORD[e]} <b>${k[e]}</b></span>`).join('')}
        </div>
      </div>`).join('');
    this.statsEl.innerHTML = `
      <p class="stats-since">Since ${since} · saved in this browser</p>
      <h3>Flying</h3>
      <div class="stat-tiles">
        ${tile(hm(d.playTime), 'time in the game')}
        ${tile(hm(d.flightTime), 'flight time')}
        ${tile(d.flights, 'flights', `${d.crashes} crashed`)}
        ${tile(km(d.distance), 'distance flown')}
        ${tile(`${Math.round(d.topSpeed * 3.6)} km/h`, 'top speed')}
        ${tile(`${Math.round(d.maxAltitude)} m`, 'highest above ground')}
      </div>
      <h3>Strikes</h3>
      <div class="stat-tiles">
        ${tile(d.detonations, 'detonations')}
        ${tile(pct(d.directHits, d.detonations), 'accuracy', `${d.directHits} direct hits on a vehicle`)}
        ${tile(pct(d.effective, d.detonations), 'effective strikes', 'damaged at least one enemy')}
        ${tile(totals.destroyed, 'vehicles destroyed', `${totals.immobilized} immobilized · ${totals.damaged} damaged`)}
        ${tile(totals.destroyed ? (d.detonations / totals.destroyed).toFixed(1) : '–', 'drones per kill')}
        ${tile(d.netHits, 'charges stopped by a net')}
      </div>
      <h3>Vehicles</h3>
      <div class="stat-vehicles">${vehicleCards}</div>
      <div class="stats-cols">
        <div><h3>Where you hit them</h3>
          ${zones.length ? `<table class="stats-table"><tbody>${zones.map(([k, n]) => { const [type, zone] = k.split('|'); return `<tr><td>${GUIDE[type]?.label ?? type}</td><td>${zone}</td><td class="num">${n}</td></tr>`; }).join('')}</tbody></table>` : '<p class="stats-empty">No direct hits yet.</p>'}
        </div>
        <div><h3>Modes</h3>
          <table class="stats-table"><thead><tr><th></th><th class="num">Time</th><th class="num">Rounds</th><th class="num">Won</th><th class="num">Destroyed</th></tr></thead><tbody>
          ${Object.entries(d.modes).map(([m, v]) => `<tr><td>${modeName[m]}</td><td class="num">${hm(v.time)}</td><td class="num">${m === 'free' ? '–' : v.rounds}</td><td class="num">${m === 'free' ? '–' : v.wins}</td><td class="num">${v.destroyed}</td></tr>`).join('')}
          </tbody></table>
        </div>
      </div>
      <div class="stats-cols">
        <div><h3>Drones</h3>
          ${drones.length ? `<table class="stats-table"><thead><tr><th></th><th class="num">Flights</th><th class="num">Time</th><th class="num">Distance</th></tr></thead><tbody>${drones.map(([label, v]) => `<tr><td>${label}</td><td class="num">${v.flights}</td><td class="num">${hm(v.time)}</td><td class="num">${km(v.distance)}</td></tr>`).join('')}</tbody></table>` : '<p class="stats-empty">No flights yet.</p>'}
        </div>
        <div><h3>Recent</h3>
          ${d.recent.length ? `<table class="stats-table"><tbody>${d.recent.slice(0, 12).map((r) => `<tr><td>${new Date(r.t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</td><td>${GUIDE[r.type]?.label ?? r.type} <span style="color:${EFFECT_COLOR[r.to]}">${EFFECT_WORD[r.to]}</span></td><td class="muted">${r.how} · ${modeName[r.mode]}</td></tr>`).join('')}</tbody></table>` : '<p class="stats-empty">Nothing hit yet.</p>'}
        </div>
      </div>
      <div class="stats-foot"><button data-stats-reset>Reset statistics</button></div>`;
    setTimeout(() => {
      const pics = this.portraits();
      for (const img of this.statsEl.querySelectorAll('img[data-type]')) img.src = pics[img.dataset.type]?.photo ?? '';
    }, 30);
  }

  buildGuide() {
    this.guideImages = {};
    const wrap = h('div', 'guide');
    wrap.appendChild(h('div', 'guide-rules', GUIDE_RULES.map(([t, d]) => `<div><b>${t}</b><span>${d}</span></div>`).join('')));
    wrap.appendChild(h('div', 'guide-legend', Object.entries(EFFECT_COLOR).map(([e, c]) => `<span><i style="background:${c}"></i>${EFFECT_WORD[e]}</span>`).join('') + '<span class="guide-front">◀ front</span>'));
    for (const [type, info] of Object.entries(GUIDE)) {
      const card = h('div', 'guide-card');
      card.dataset.search = `${info.label} ${info.armor} target guide weak spots`.toLowerCase();
      // zones this vehicle has (sampled over its hull box from all sides)
      const zoneList = new Map();
      for (let a = -1; a <= 1; a += 0.1) {
        for (let b = -1; b <= 1; b += 0.1) {
          for (const [u, v, w] of [[a, 0.95, b], [0.97, a, b], [a, b, -0.97], [a, b, 0.97]]) {
            const [zone, effect] = ZONES[type](u, v, w);
            if (!zoneList.has(zone)) zoneList.set(zone, effect);
          }
        }
      }
      const nearRows = BLAST[type].map(([d, outs]) => `<tr><td>≤ ${d} m</td><td>${outs.map(([e, p]) => `<span style="color:${EFFECT_COLOR[e]}">${EFFECT_WORD[e]} ${Math.round(p * 100)}%</span>`).join(' · ')}</td></tr>`).join('');
      card.innerHTML = `
        <div class="guide-head"><h4>${info.label}</h4><span>${info.armor}</span></div>
        <p class="guide-summary">${info.summary}</p>
        <div class="guide-body">
          <div class="guide-maps">
            <img class="guide-photo" alt="${info.label}">
            <div class="guide-zone-shots"><img alt="weak spots, front"><img alt="weak spots, rear"></div>
            <small>weak spots · front · rear</small>
          </div>
          <div class="guide-text">
            <div class="guide-zones">${[...zoneList].map(([z, e]) => `<span><i style="background:${EFFECT_COLOR[e]}"></i>${z}: ${EFFECT_WORD[e]}</span>`).join('')}</div>
            <table class="guide-near"><thead><tr><th>Near miss</th><th></th></tr></thead><tbody>${nearRows}<tr><td>further</td><td>no effect</td></tr></tbody></table>
            <p class="guide-tips">${info.tips}</p>
          </div>
        </div>`;
      const imgs = card.querySelectorAll('.guide-maps img');
      this.guideImages[type] = { photo: imgs[0], front: imgs[1], rear: imgs[2] };
      wrap.appendChild(card);
    }
    return wrap;
  }

  buildKeys() {
    return h('div', 'keys', KEYS.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join(''));
  }

  buildOsdPreview() {
    const box = h('div', 'osd-preview');
    this.osdStage = h('div', 'osd-preview-stage');
    box.appendChild(this.osdStage);
    this.osdPreviewBox = box;
    this.previewOsd = new Osd(this.osdStage, { preview: true });
    const q = { x: 0, y: 0, z: 0, w: 1 };
    this.fakeFlight = {
      controls: { throttle: 0.42, arm: true, armMapped: true, radio: true },
      flightTime: 83, speed: 17.5, altitude: 12.4, status: 'armed', armBlock: null,
      wind: { base: { x: 2.2, z: 1.4 } },
      drone: {
        battery: { enabled: true, voltage: 22.6, cellVoltage: 3.77, used: 642, soc: 0.6 },
        payloadMass: 0, quaternion: q, position: { x: 140, z: -260 },
      },
    };
    return box;
  }

  // ---------- events ----------

  bindEvents() {
    this.root.addEventListener('click', (e) => {
      const t = e.target;
      const cat = t.closest('[data-cat]');
      if (cat && cat.tagName === 'BUTTON') {
        this.search.value = '';
        this.applySearch();
        this.selectCategory(cat.dataset.cat);
        cat.blur();
        return;
      }
      const prev = t.closest('[data-preview]');
      if (prev) {
        this.previewMode = prev.dataset.preview;
        this.syncPreviewBar();
        prev.blur();
        return;
      }
      const q = t.closest('[data-quality]');
      if (q) {
        this.settings.setMany(QUALITY_PRESETS[q.dataset.quality].values);
        q.blur();
        return;
      }
      const btn = t.closest('[data-action]');
      if (!btn) return;
      const a = btn.dataset.action;
      if (a === 'close') this.hide();
      if (a === 'new-map') this.hooks.onNewMap();
      if (a === 'screenshot') this.hooks.onScreenshot();
      if (a === 'level') this.levelRequest++;
      if (a === 'reset-all') this.confirm('Reset all settings to defaults?', 'Controller mapping and calibration are kept.', 'Reset all', () => this.settings.reset());
      if (a === 'reset-page') {
        const label = CATEGORIES.find((c) => c.id === this.category).label;
        this.confirm(`Reset the ${label} page to defaults?`, this.category === 'controller' ? 'Clears the stick mapping, switches and calibration.' : 'Only the settings on this page change.', 'Reset page', () => this.resetPage());
      }
      if (a === 'reset-rates') this.settings.setMany(Object.fromEntries(RATE_AXES.flatMap((ax) => RATE_FIELDS.map((f) => [`rates.${ax}.${f.key}`, this.defaults.rates[ax][f.key]]))));
      btn.blur();
    });
    this.search.addEventListener('input', () => this.applySearch());
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (this.search.value) {
          this.search.value = '';
          this.applySearch();
        } else this.search.blur();
      }
    });

    // One floating tooltip for every (i)
    this.root.addEventListener('mouseover', (e) => {
      const el = e.target.closest('[data-tip]');
      if (!el) return;
      this.tooltip.textContent = el.dataset.tip;
      this.tooltip.hidden = false;
      const r = el.getBoundingClientRect();
      const tw = this.tooltip.offsetWidth;
      const th = this.tooltip.offsetHeight;
      let x = r.left + r.width / 2 - tw / 2;
      x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
      let y = r.bottom + 8;
      if (y + th > window.innerHeight - 8) y = r.top - th - 8;
      this.tooltip.style.transform = `translate(${x}px, ${y}px)`;
    });
    this.root.addEventListener('mouseout', (e) => {
      if (e.target.closest('[data-tip]') && !e.relatedTarget?.closest?.('[data-tip]')) this.tooltip.hidden = true;
    });
  }

  // Small modal: title, detail, confirm button label, action
  confirm(title, detail, label, onYes) {
    const overlay = h('div', 'confirm', `
      <div class="confirm-box" role="dialog">
        <h3>${title}</h3>
        <p>${detail}</p>
        <div class="row-actions"><button data-c="no">Cancel</button><button data-c="yes" class="danger">${label}</button></div>
      </div>`);
    const close = () => {
      overlay.remove();
      window.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        close();
        onYes();
      }
    };
    overlay.addEventListener('click', (e) => {
      const c = e.target.closest('[data-c]')?.dataset.c;
      if (!c && e.target !== overlay) return;
      e.stopPropagation();
      close();
      if (c === 'yes') onYes();
    });
    window.addEventListener('keydown', onKey, true);
    this.root.appendChild(overlay);
    overlay.querySelector('[data-c="yes"]').focus();
  }

  resetPage() {
    const page = this.pages[this.category];
    const values = {};
    for (const b of this.bindings) if (page.contains(b.el) && b.path !== 'drone.preset') values[b.path] = getPath(this.defaults, b.path);
    if (this.category === 'drone') values['drone.preset'] = this.defaults.drone.preset;
    if (this.category === 'controller') {
      this.hooks.input.reset();
      this.calibration.syncControls();
      return;
    }
    if (Object.keys(values).length) this.settings.setMany(values);
  }

  applySearch() {
    const q = this.search.value.trim().toLowerCase();
    this.root.classList.toggle('searching', !!q);
    for (const cat of CATEGORIES) {
      const page = this.pages[cat.id];
      if (!this.isAllowed(cat.id)) {
        page.hidden = true;
        continue;
      }
      if (!q) {
        page.hidden = cat.id !== this.category;
        page.querySelectorAll('[data-search]').forEach((r) => (r.hidden = false));
        page.querySelectorAll('.group, details.adv').forEach((g) => (g.hidden = false));
        continue;
      }
      let any = false;
      page.querySelectorAll('[data-search]').forEach((r) => {
        r.hidden = !q.split(/\s+/).every((w) => r.dataset.search.includes(w));
        any ||= !r.hidden;
      });
      page.querySelectorAll('details.adv').forEach((d) => {
        const vis = [...d.querySelectorAll('[data-search]')].some((r) => !r.hidden);
        d.hidden = !vis;
        if (vis) d.open = true;
      });
      page.querySelectorAll('.group').forEach((g) => {
        g.hidden = ![...g.querySelectorAll('[data-search]')].some((r) => !r.hidden);
      });
      page.hidden = !any;
    }
    if (q) for (const b of Object.values(this.navButtons)) b.classList.remove('active');
    else this.selectCategory(this.category);
    this.updateLayout();
  }

  selectCategory(id) {
    this.category = id;
    for (const cat of CATEGORIES) {
      this.pages[cat.id].hidden = cat.id !== id;
      this.navButtons[cat.id].classList.toggle('active', cat.id === id);
    }
    this.content.scrollTop = 0;
    // pages without settings (guide, statistics) have nothing to reset
    const hasFields = CATEGORIES.find((c) => c.id === id).groups.some((g) => g.fields || g.custom === 'rates' || g.custom === 'controller' || g.custom === 'quality');
    for (const b of this.root.querySelectorAll('[data-action="reset-page"], [data-action="reset-all"]')) b.hidden = !hasFields;
    if (id === 'hud') this.refreshOsdBackdrop();
    if (id === 'guide' && !this.portraitsDone) {
      // render the vehicle pictures the first time the guide opens
      this.portraitsDone = true;
      setTimeout(() => {
        const pics = this.portraits();
        for (const [type, el] of Object.entries(this.guideImages)) {
          if (!pics[type]) continue;
          for (const k of ['photo', 'front', 'rear']) el[k].src = pics[type][k];
        }
      }, 30);
    }
    if (id === 'stats') this.renderStats();
    this.updateLayout();
  }

  updateLayout() {
    const cat = CATEGORIES.find((c) => c.id === this.category);
    const searching = !!this.search.value.trim();
    const sticks = !searching && cat.preview === 'sticks';
    const scene = !searching && (cat.preview === 'scene' || sticks);
    this.root.classList.toggle('wide', !searching && !!cat.wide);
    this.root.classList.toggle('scene', scene);
    this.root.classList.toggle('stick-preview', sticks);
    this.previewBar.hidden = !scene || sticks;
    this.sticksBar.hidden = !sticks;
    this.calibration?.setVisible(this.calibrationActive);
    this.syncPreviewBar();
  }

  syncPreviewBar() {
    for (const b of this.previewBar.querySelectorAll('[data-preview]')) b.classList.toggle('active', b.dataset.preview === this.previewMode);
  }

  // Which camera the live scene uses while the menu is open
  get activePreview() {
    if (this.visible && this.root.classList.contains('stick-preview')) return 'sticks';
    return this.visible && this.root.classList.contains('scene') ? this.previewMode : 'fpv';
  }

  setStatus(text) {
    setText(this.statusEl, text);
  }

  // the HUD preview shows the current frame behind it; main grabs it right after rendering
  refreshOsdBackdrop() {
    this.wantSnapshot = !!this.osdPreviewBox;
  }

  setOsdBackdrop(url) {
    this.wantSnapshot = false;
    this.osdPreviewBox.style.backgroundImage = `url(${url})`;
  }

  // ---------- sync ----------

  sync() {
    const data = this.settings.data;
    for (const b of this.bindings) {
      const v = getPath(data, b.path);
      if (b.type === 'checkbox') b.el.checked = v;
      else if (document.activeElement !== b.el || b.type === 'range') b.el.value = String(v);
      if (b.out) setText(b.out, b.fmt ? b.fmt(v) : '');
      if (b.revert) b.revert.classList.toggle('shown', b.path !== 'drone.preset' && v !== getPath(this.defaults, b.path));
    }
    for (const axis of RATE_AXES) setText(this.rateMax[axis], `${Math.round(maxRate(data.rates[axis]))}°/s`);
    for (const { el, fn } of this.infos) setText(el, fn(data));
    // quality preset that matches the current values
    if (this.qualityButtons) {
      for (const [k, p] of Object.entries(QUALITY_PRESETS)) {
        const match = Object.entries(p.values).every(([path, v]) => getPath(data, path) === v);
        this.qualityButtons[k].classList.toggle('active', match);
      }
    }
    // graphics-only fields that do nothing in the current grass mode
    for (const b of this.bindings) {
      if (['graphics.grassDensity', 'graphics.grassRadius', 'graphics.grassHeight', 'graphics.propWash'].includes(b.path)) b.row.classList.toggle('inactive', data.graphics.grass !== '3d');
      if (b.path === 'osd.compassWind') b.row.classList.toggle('inactive', data.osd.compass === 'off');
    }
    this.previewOsd?.configure(data.osd);
    this.drawRates();
  }

  // per frame while open
  update(now) {
    if (!this.visible) return;
    if (this.calibrationActive) this.calibration.update(now);
    if (this.category === 'hud' && this.previewOsd) {
      // full-screen HUD scaled into the preview box, compass turning slowly
      const bw = this.osdPreviewBox.clientWidth;
      const W = window.innerWidth;
      const H = window.innerHeight;
      this.osdPreviewBox.style.height = `${(bw * H) / W}px`;
      Object.assign(this.osdStage.style, { width: `${W}px`, height: `${H}px`, transform: `scale(${bw / W})` });
      const a = (now / 1000) * 0.35;
      const q = this.fakeFlight.drone.quaternion;
      q.y = Math.sin(a / 2);
      q.w = Math.cos(a / 2);
      this.previewOsd.update(this.fakeFlight, { x: 0, z: 0 });
    }
  }

  isAllowed(id) {
    return !this.allowed || this.allowed.includes(id);
  }

  // context: { allowed: category ids (null = all), title } — e.g. only global settings during a
  // mission, only map & weather for the Free Flight setup
  open(category, context = null) {
    if (context) {
      this.allowed = context.allowed ?? null;
      this.titleEl.textContent = context.title ?? 'Settings';
      for (const cat of CATEGORIES) this.navButtons[cat.id].hidden = !this.isAllowed(cat.id);
      for (const [name, el] of Object.entries(this.navSections)) el.hidden = !CATEGORIES.some((c) => c.section === name && this.isAllowed(c.id));
      if (!category || !this.isAllowed(category)) category = this.isAllowed(this.category) ? this.category : this.allowed[0];
    }
    if (category) {
      this.search.value = '';
      this.applySearch();
      this.selectCategory(category);
    }
    this.show();
  }

  show() {
    this.visible = true;
    this.root.hidden = false;
    this.sync();
    this.updateLayout();
    if (this.category === 'hud') this.refreshOsdBackdrop();
  }

  hide() {
    const was = this.visible;
    this.visible = false;
    this.root.hidden = true;
    if (was) this.hooks.onClose?.();
    this.tooltip.hidden = true;
    this.calibration?.setVisible(false);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }
}
