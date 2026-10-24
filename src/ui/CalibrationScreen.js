import { CHANNELS, CHANNEL_INFO, SWITCHES, SWITCH_INFO } from '../input/config.js';

const DETECT_THRESHOLD = 0.6; // raw delta needed to accept a detected axis
const DETECT_SETTLE_MS = 400; // let sticks return to center before taking the baseline
const DETECT_TIMEOUT_MS = 10000;
const MIN_RANGE = 0.5; // calibrated range below this is treated as "stick not moved"

const info = (tip) => `<span class="info" data-tip="${tip}">i</span>`;

const TEMPLATE = `
  <div class="ctl">
    <section class="group ctl-device">
      <div class="ctl-device-row">
        <span class="ctl-dot"></span>
        <div class="device-status"></div>
        <select class="device-select" hidden></select>
      </div>
      <p class="ctl-help">RadioMaster / EdgeTX: <b>Model → USB Joystick, mode Classic</b> (or System → USB mode Joystick), then plug in and move a stick.</p>
    </section>

    <div class="ctl-grid">
      <section class="group">
        <h3><span class="step">1</span>Sticks ${info('Which gamepad axis drives each channel. Auto-map asks you to push each stick in turn. Invert flips a channel that moves the wrong way.')}</h3>
        <table class="mapping">
          <thead><tr><th>Channel</th><th>Axis</th><th>Invert</th><th></th><th>Output</th></tr></thead>
          <tbody></tbody>
        </table>
        <div class="row-actions">
          <button data-action="detect-all" class="primary">Auto-map all sticks</button>
        </div>
      </section>

      <section class="group ctl-live">
        <h3>Live ${info('What the simulator receives after mapping, calibration and deadzone (Mode 2). Dots must follow your sticks exactly.')}</h3>
        <div class="sticks">
          <div class="stick" data-stick="left"><div class="dot"></div><span>Yaw / Throttle</span></div>
          <div class="stick" data-stick="right"><div class="dot"></div><span>Roll / Pitch</span></div>
        </div>
      </section>
    </div>

    <section class="group wizard">
      <h3><span class="step">2</span>Calibrate ${info('Measures the real min / centre / max of every axis so full stick = full rate and centre = zero. Redo it after changing the radio\'s outputs or trims.')}</h3>
      <p class="wizard-text"></p>
      <div class="row-actions">
        <button data-action="calib-start" class="primary">Start calibration</button>
        <button data-action="calib-next" class="primary" hidden>Next</button>
        <button data-action="calib-cancel" hidden>Cancel</button>
      </div>
    </section>

    <section class="group">
      <h3><span class="step">3</span>Switches ${info('Radio switches or buttons for in-flight functions. Detect, then flip the switch into its ON position. Each one also has a keyboard key.')}</h3>
      <table class="mapping switches">
        <thead><tr><th>Function</th><th>Source</th><th>Invert</th><th></th><th>State</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>

    <details class="group adv">
      <summary>Advanced: raw axes, deadzone, reset</summary>
      <label class="deadzone">Deadzone ${info('Stick movement around centre that is ignored. Raise it if the drone drifts with sticks centred; keep it as low as possible (1–3%).')}
        <input type="range" min="0" max="0.1" step="0.005" />
        <span></span>
      </label>
      <h3 class="sub">Raw axes ${info('Unprocessed values from the browser Gamepad API. Ticks: calibrated min / centre / max.')}</h3>
      <div class="raw-axes"></div>
      <div class="row-actions">
        <button data-action="reset" class="secondary">Reset controller to defaults</button>
      </div>
    </details>
  </div>
`;

const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};
const pct = (v) => ((Math.max(-1, Math.min(1, v)) + 1) / 2) * 100;
const fmt = (v) => (v < 0 ? '' : '+') + v.toFixed(3);

function setCenteredFill(fill, v) {
  const p = pct(v);
  fill.style.left = `${Math.min(p, 50)}%`;
  fill.style.width = `${Math.abs(p - 50)}%`;
}

export class CalibrationScreen {
  // mount: element the setup page is built into (the settings menu's Controller tab)
  constructor(input, mount) {
    this.input = input;
    this.visible = false;
    this.axisRows = [];
    this.optionsKey = '';
    this.deviceKey = null;
    this.wizard = null; // { step: 'extremes' | 'center', min: number[], max: number[] }
    this.detect = null; // { kind: 'channel' | 'switch', queue, channel, used, baseline, buttons, settleUntil }
    this.message = '';

    mount.innerHTML = TEMPLATE;
    this.root = mount.firstElementChild;

    const q = (s) => this.root.querySelector(s);
    this.el = {
      status: q('.device-status'),
      select: q('.device-select'),
      axes: q('.raw-axes'),
      mapping: q('.mapping tbody'),
      switches: q('.switches tbody'),
      deadzone: q('.deadzone input'),
      deadzoneValue: q('.deadzone span'),
      wizardText: q('.wizard-text'),
      dot: q('.ctl-dot'),
      wizard: q('.wizard'),
      start: q('[data-action="calib-start"]'),
      next: q('[data-action="calib-next"]'),
      cancel: q('[data-action="calib-cancel"]'),
      leftDot: q('[data-stick="left"] .dot'),
      rightDot: q('[data-stick="right"] .dot'),
    };

    this.buildMappingRows();
    this.buildSwitchRows();
    this.bindEvents();
    this.syncControls();
  }

  // the menu shows/hides the page; visible pauses the flight
  setVisible(visible) {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) this.syncControls();
    else {
      this.wizard = null;
      this.detect = null;
    }
  }

  // ---------- setup ----------

  buildMappingRows() {
    this.mappingRows = {};
    for (const ch of CHANNELS) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${CHANNEL_INFO[ch].label}</td>
        <td><select class="axis-select"></select></td>
        <td><input type="checkbox" class="invert" /></td>
        <td><button data-action="detect" data-ch="${ch}">Detect</button></td>
        <td class="out"><div class="bar"><div class="fill"></div></div><span class="val"></span></td>`;
      const select = tr.querySelector('.axis-select');
      const invert = tr.querySelector('.invert');
      select.addEventListener('change', () => this.applyMapping(ch, Number(select.value), invert.checked));
      invert.addEventListener('change', () => this.applyMapping(ch, Number(select.value), invert.checked));
      this.el.mapping.appendChild(tr);
      this.mappingRows[ch] = {
        select,
        invert,
        fill: tr.querySelector('.fill'),
        val: tr.querySelector('.val'),
      };
    }
  }

  buildSwitchRows() {
    this.switchRows = {};
    for (const sw of SWITCHES) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${SWITCH_INFO[sw].label} ${info(SWITCH_INFO[sw].tip)}</td>
        <td><select class="switch-select"></select></td>
        <td><input type="checkbox" class="invert" /></td>
        <td><button data-action="detect-switch" data-sw="${sw}">Detect</button></td>
        <td class="switch-state"></td>`;
      const select = tr.querySelector('.switch-select');
      const invert = tr.querySelector('.invert');
      const apply = () => {
        const [source, index] = select.value.split(':');
        this.input.setSwitch(sw, source, Number(index ?? 0), invert.checked);
      };
      select.addEventListener('change', apply);
      invert.addEventListener('change', apply);
      this.el.switches.appendChild(tr);
      this.switchRows[sw] = { select, invert, state: tr.querySelector('.switch-state') };
    }
  }

  bindEvents() {
    this.root.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      switch (btn.dataset.action) {
        case 'calib-start': this.startCalibration(); break;
        case 'calib-next': this.nextCalibrationStep(); break;
        case 'calib-cancel': this.wizard = null; this.message = 'Calibration cancelled.'; break;
        case 'reset':
          this.input.reset();
          this.wizard = null;
          this.detect = null;
          this.message = 'Reset to defaults.';
          this.syncControls();
          break;
        case 'detect': this.startDetect([btn.dataset.ch]); break;
        case 'detect-all': this.startDetect(CHANNELS); break;
        case 'detect-switch': this.startSwitchDetect(btn.dataset.sw); break;
      }
      btn.blur(); // keep keyboard shortcuts working
    });

    this.el.deadzone.addEventListener('input', () => {
      this.input.setDeadzone(Number(this.el.deadzone.value));
      this.syncControls();
    });

    this.el.select.addEventListener('change', () => {
      this.input.source.select(Number(this.el.select.value));
    });
  }

  applyMapping(ch, axis, invert) {
    this.input.setMapping(ch, axis, invert);
    this.syncControls(); // a swap may have changed another row
  }

  syncControls() {
    const { mapping, deadzone } = this.input.config;
    this.ensureAxisOptions();
    for (const ch of CHANNELS) {
      const row = this.mappingRows[ch];
      row.select.value = String(mapping[ch].axis);
      row.invert.checked = mapping[ch].invert;
    }
    for (const sw of SWITCHES) {
      const { source, index, invert } = this.input.config.switches[sw];
      const row = this.switchRows[sw];
      row.select.value = source === 'none' ? 'none' : `${source}:${index}`;
      row.invert.checked = invert;
    }
    this.el.deadzone.value = String(deadzone);
    setText(this.el.deadzoneValue, `${Math.round(deadzone * 1000) / 10}%`);
  }

  ensureAxisOptions() {
    const { mapping, switches } = this.input.config;
    const maxMapped = Math.max(...CHANNELS.map((ch) => mapping[ch].axis));
    const swMax = (src) => Math.max(-1, ...SWITCHES.map((sw) => (switches[sw].source === src ? switches[sw].index : -1)));
    const axisCount = Math.max(this.input.raw.length, maxMapped + 1, swMax('axis') + 1, 4);
    const buttonCount = Math.max(this.input.buttons.length, swMax('button') + 1);
    const key = `${axisCount}/${buttonCount}`;
    if (key === this.optionsKey) return;
    this.optionsKey = key;

    const axisOptions = Array.from({ length: axisCount }, (_, i) => `<option value="${i}">Axis ${i}</option>`).join('');
    for (const ch of CHANNELS) {
      const { select } = this.mappingRows[ch];
      select.innerHTML = axisOptions;
      select.value = String(mapping[ch].axis);
    }

    const switchOptions = '<option value="none">None</option>'
      + Array.from({ length: axisCount }, (_, i) => `<option value="axis:${i}">Axis ${i}</option>`).join('')
      + Array.from({ length: buttonCount }, (_, i) => `<option value="button:${i}">Button ${i}</option>`).join('');
    for (const sw of SWITCHES) {
      const { select } = this.switchRows[sw];
      const { source, index } = switches[sw];
      select.innerHTML = switchOptions;
      select.value = source === 'none' ? 'none' : `${source}:${index}`;
    }
  }

  buildAxisRows(count) {
    this.el.axes.innerHTML = '';
    this.axisRows = [];
    for (let i = 0; i < count; i++) {
      const row = document.createElement('div');
      row.className = 'axis-row';
      row.innerHTML = `
        <span class="axis-name">A${i}</span>
        <span class="axis-tag"></span>
        <div class="bar">
          <div class="fill"></div>
          <i class="tick min"></i><i class="tick center"></i><i class="tick max"></i>
        </div>
        <span class="val"></span>`;
      this.el.axes.appendChild(row);
      this.axisRows.push({
        tag: row.querySelector('.axis-tag'),
        fill: row.querySelector('.fill'),
        min: row.querySelector('.tick.min'),
        center: row.querySelector('.tick.center'),
        max: row.querySelector('.tick.max'),
        val: row.querySelector('.val'),
      });
    }
    this.ensureAxisOptions();
  }

  // ---------- calibration wizard ----------

  startCalibration() {
    if (!this.input.state.connected) {
      this.message = 'No controller connected.';
      return;
    }
    this.detect = null;
    const raw = Array.from(this.input.raw);
    this.wizard = { step: 'extremes', min: raw.slice(), max: raw.slice() };
  }

  nextCalibrationStep() {
    if (!this.wizard) return;
    if (this.wizard.step === 'extremes') this.wizard.step = 'center';
    else this.finishCalibration();
  }

  finishCalibration() {
    const { min, max } = this.wizard;
    const { mapping } = this.input.config;
    const raw = this.input.raw;
    const axes = Array.from(raw, (v, i) => {
      const lo = min[i] ?? v;
      const hi = max[i] ?? v;
      if (hi - lo < MIN_RANGE) return null; // not moved: keep default -1..1
      return { min: lo, max: hi, center: Math.min(hi, Math.max(lo, v)) };
    });
    // Throttle doesn't spring back, so its captured "center" is meaningless.
    const thr = axes[mapping.throttle.axis];
    if (thr) thr.center = (thr.min + thr.max) / 2;

    this.input.setCalibration(axes);
    this.wizard = null;

    const weak = CHANNELS.filter((ch) => !axes[mapping[ch].axis]).map((ch) => CHANNEL_INFO[ch].label);
    this.message = weak.length
      ? `Saved, but no movement detected on: ${weak.join(', ')}. Check the mapping and recalibrate.`
      : 'Calibration saved. Verify the stick preview matches your sticks.';
  }

  // ---------- axis auto-detection ----------

  startDetect(channels) {
    if (!this.input.state.connected) {
      this.message = 'No controller connected.';
      return;
    }
    this.wizard = null;
    this.detect = { kind: 'channel', queue: channels.slice(), channel: null, used: new Set(), baseline: [], settleUntil: 0 };
    this.nextDetect(performance.now());
  }

  nextDetect(now) {
    const d = this.detect;
    d.channel = d.queue.shift() ?? null;
    if (!d.channel) {
      this.detect = null;
      this.message = 'Mapping done. Now run calibration.';
      return;
    }
    d.settleUntil = now + DETECT_SETTLE_MS;
  }

  startSwitchDetect(name) {
    if (!this.input.state.connected) {
      this.message = 'No controller connected.';
      return;
    }
    this.wizard = null;
    this.detect = { kind: 'switch', name, baseline: [], buttons: [], settleUntil: performance.now() + DETECT_SETTLE_MS };
  }

  // Whatever changes first (axis jump or button toggle) becomes the switch; its current position = ON.
  updateSwitchDetect(raw) {
    const d = this.detect;
    const buttons = this.input.buttons;
    for (let i = 0; i < buttons.length; i++) {
      if (buttons[i].pressed !== d.buttons[i]) {
        this.finishSwitchDetect(d.name, 'button', i, !buttons[i].pressed);
        return;
      }
    }
    for (let i = 0; i < raw.length; i++) {
      if (Math.abs(raw[i] - (d.baseline[i] ?? raw[i])) >= DETECT_THRESHOLD) {
        this.finishSwitchDetect(d.name, 'axis', i, raw[i] < 0);
        return;
      }
    }
  }

  finishSwitchDetect(name, source, index, invert) {
    this.input.setSwitch(name, source, index, invert);
    this.detect = null;
    this.syncControls();
    this.message = `${SWITCH_INFO[name].label} mapped to ${source} ${index}. Check the State column.`;
  }

  updateDetect(now, raw) {
    const d = this.detect;
    if (now < d.settleUntil) {
      d.baseline = Array.from(raw);
      d.buttons = Array.from(this.input.buttons, (b) => b.pressed);
      return;
    }
    if (now - d.settleUntil > DETECT_TIMEOUT_MS) {
      const label = d.kind === 'switch' ? SWITCH_INFO[d.name].label : CHANNEL_INFO[d.channel].label;
      this.message = `Detection timed out for ${label}.`;
      this.detect = null;
      return;
    }
    if (d.kind === 'switch') {
      this.updateSwitchDetect(raw);
      return;
    }
    let best = -1;
    let bestDelta = 0;
    for (let i = 0; i < raw.length; i++) {
      if (d.used.has(i)) continue;
      const delta = raw[i] - (d.baseline[i] ?? raw[i]);
      if (Math.abs(delta) > Math.abs(bestDelta)) {
        best = i;
        bestDelta = delta;
      }
    }
    if (best >= 0 && Math.abs(bestDelta) >= DETECT_THRESHOLD) {
      // Pushed in the channel's positive direction but the axis went down -> invert.
      this.input.setMapping(d.channel, best, bestDelta < 0);
      d.used.add(best);
      this.syncControls();
      this.nextDetect(now);
    }
  }

  // ---------- per-frame ----------

  update(now) {
    if (!this.visible) return;
    const { input } = this;
    const raw = input.raw;
    const gp = input.gamepad;

    this.updateDevice(gp);
    if (raw.length !== this.axisRows.length) this.buildAxisRows(raw.length);
    this.ensureAxisOptions(); // button count can change too

    if (this.wizard?.step === 'extremes') {
      const { min, max } = this.wizard;
      for (let i = 0; i < raw.length; i++) {
        if (!(raw[i] >= min[i])) min[i] = raw[i]; // also handles undefined
        if (!(raw[i] <= max[i])) max[i] = raw[i];
      }
    }
    if (this.detect) this.updateDetect(now, raw);

    this.updateAxisRows(raw);
    this.updateOutputs();
    this.updateWizardUi();
  }

  updateDevice(gp) {
    setText(
      this.el.status,
      gp
        ? `${gp.id} — ${gp.axes.length} axes, ${gp.buttons.length} buttons`
        : 'No controller detected. Put the RadioMaster in USB Joystick mode, plug it in, then move a stick.'
    );
    this.el.status.classList.toggle('warn', !gp);
    this.el.dot.classList.toggle('on', !!gp);

    const pads = this.input.source.list();
    const key = pads.map((p) => `${p.index}:${p.id}`).join('|');
    if (key !== this.deviceKey) {
      this.deviceKey = key;
      this.el.select.innerHTML = pads.map((p) => `<option value="${p.index}">${p.index}: ${p.id}</option>`).join('');
      this.el.select.hidden = pads.length < 2;
    }
    if (gp) this.el.select.value = String(gp.index);
  }

  updateAxisRows(raw) {
    const { mapping, axes } = this.input.config;
    const live = this.wizard?.step === 'extremes' ? this.wizard : null;
    for (let i = 0; i < this.axisRows.length; i++) {
      const row = this.axisRows[i];
      const v = raw[i];
      setCenteredFill(row.fill, v);
      setText(row.val, fmt(v));

      const tag = CHANNELS.filter((ch) => mapping[ch].axis === i).map((ch) => CHANNEL_INFO[ch].label).join(', ');
      setText(row.tag, tag);

      const cal = live ? { min: live.min[i], max: live.max[i], center: null } : axes[i];
      for (const k of ['min', 'center', 'max']) {
        const t = row[k];
        const value = cal?.[k];
        t.hidden = value === null || value === undefined;
        if (!t.hidden) t.style.left = `${pct(value)}%`;
      }
    }
  }

  updateOutputs() {
    const s = this.input.state;
    for (const ch of CHANNELS) {
      const row = this.mappingRows[ch];
      const v = s[ch];
      if (ch === 'throttle') {
        row.fill.style.left = '0%';
        row.fill.style.width = `${v * 100}%`;
        setText(row.val, `${Math.round(v * 100)}%`);
      } else {
        setCenteredFill(row.fill, v);
        setText(row.val, fmt(v));
      }
    }
    for (const sw of SWITCHES) {
      const v = s[sw];
      const el = this.switchRows[sw].state;
      setText(el, v === null ? '—' : v ? 'ON' : 'off');
      el.classList.toggle('on', v === true);
    }
    // Mode 2: left = yaw (x) / throttle (y), right = roll (x) / pitch (y)
    this.el.leftDot.style.left = `${pct(s.yaw)}%`;
    this.el.leftDot.style.top = `${(1 - s.throttle) * 100}%`;
    this.el.rightDot.style.left = `${pct(s.roll)}%`;
    this.el.rightDot.style.top = `${100 - pct(s.pitch)}%`;
  }

  updateWizardUi() {
    const w = this.wizard;
    const d = this.detect;
    let text;
    if (d) {
      if (performance.now() < d.settleUntil) {
        text = d.kind === 'switch' ? 'Get ready…' : 'Release the sticks…';
      } else if (d.kind === 'switch') {
        text = `Detecting ${SWITCH_INFO[d.name].label}: flip the switch (or press the button) you want into its ON position.`;
      } else {
        const info = CHANNEL_INFO[d.channel];
        text = `Detecting ${info.label}: keep the other sticks still, push ${info.label} ${info.push} fully.`;
      }
    } else if (w?.step === 'extremes') {
      text = 'Step 1/2: move every stick to its full extent in all directions (circle both sticks, throttle fully up and down). Then press Next.';
    } else if (w?.step === 'center') {
      text = 'Step 2/2: release the sticks so roll, pitch and yaw are centered. Throttle position does not matter. Press Save.';
    } else {
      text = this.message || (this.input.config.calibrated
        ? 'Controller is calibrated. Recalibrate if the sticks feel off.'
        : 'Not calibrated yet. Map the axes (Auto-map all), then run calibration.');
    }
    setText(this.el.wizardText, text);
    this.el.wizard.classList.toggle('active', !!(w || d));

    this.el.start.hidden = !!w;
    this.el.next.hidden = !w;
    this.el.cancel.hidden = !w;
    setText(this.el.next, w?.step === 'center' ? 'Save' : 'Next');
  }
}
