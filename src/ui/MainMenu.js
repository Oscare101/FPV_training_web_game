import { DRONE_PRESETS } from '../flight/presets.js';
import { bestScore } from '../game/Hunt.js';
import { hideBest } from '../game/HideSeek.js';

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const WEATHER = { clear: 'Clear', partly: 'Partly cloudy', overcast: 'Overcast', rain: 'Rain', snow: 'Snowfall', fog: 'Fog' };
const DIFFICULTY = {
  easy: 'One assigned target with an exact marker. Slow, unalert crews.',
  medium: 'A rough bearing to an enemy position, "ENEMY NEAR" when close. Any enemy counts.',
  hard: 'Only the sector. Find them yourself; crews spot you quickly. Night and fog possible.',
};
const VARIANT = {
  sweep: 'Destroy every vehicle on the battlefield. Unlimited drones, the clock runs.',
  endless: 'Destroyed vehicles are replaced. Score as many as you can before time runs out.',
};

// segmented control html: options [[value, label]]
const seg = (name, options, value, disabled = false) =>
  `<span class="mm-seg${disabled ? ' disabled' : ''}" data-seg="${name}">${options.map(([v, l]) => `<button data-value="${v}" class="${String(v) === String(value) ? 'active' : ''}">${l}</button>`).join('')}</span>`;

// Main menu: the scene and the drone on the left (rendered by the world), title, mode cards with
// their options and a big PLAY on the right; settings and controller buttons at the top.
export class MainMenu {
  // hooks: { onPlay(mode), onSettings(), onController(), onGuide(), onFreeSetup(), onSelect(mode), input }
  constructor(settings, parent, hooks) {
    this.settings = settings;
    this.hooks = hooks;
    this.visible = false;
    this.selected = settings.data.game.mode;
    this.root = document.createElement('div');
    this.root.className = 'mm';
    this.root.innerHTML = `
      <div class="mm-shade"></div>
      <header class="mm-top">
        <div class="mm-logo"><span class="mm-logo-a">FPV</span><span class="mm-logo-b">FRONTLINE</span><small>drone flight trainer</small></div>
        <div class="mm-top-actions">
          <button data-action="controller" class="mm-chip"><span class="mm-dot"></span><span class="mm-pad">Controller</span></button>
          <button data-action="guide" class="mm-chip">◈ Target guide</button>
          <button data-action="settings" class="mm-chip">⚙ Settings</button>
        </div>
      </header>
      <section class="mm-panel">
        <h2>PLAY</h2>
        <div class="mm-cards"></div>
      </section>
      <footer class="mm-bottom">
        <div class="mm-drone"></div>
        <button class="mm-play" data-action="play"><span>PLAY</span><small></small></button>
      </footer>
      <div class="mm-keys"><kbd>Enter</kbd> play · <kbd>↑</kbd><kbd>↓</kbd> mode · <kbd>Esc</kbd> pause in game · <kbd>K</kbd> screenshot</div>`;
    parent.appendChild(this.root);
    this.cards = this.root.querySelector('.mm-cards');
    this.droneEl = this.root.querySelector('.mm-drone');
    this.playSub = this.root.querySelector('.mm-play small');
    this.dot = this.root.querySelector('.mm-dot');
    this.padLabel = this.root.querySelector('.mm-pad');

    this.root.addEventListener('click', (e) => this.click(e));
    settings.onChange(() => this.visible && this.render());
    this.root.hidden = true;
  }

  click(e) {
    const s = this.settings;
    const segBtn = e.target.closest('[data-seg] button');
    if (segBtn) {
      const name = segBtn.parentElement.dataset.seg;
      if (segBtn.parentElement.classList.contains('disabled')) return;
      let v = segBtn.dataset.value;
      if (v === 'true' || v === 'false') v = v === 'true';
      else if (/^\d+$/.test(v)) v = Number(v);
      s.set(name, v);
      segBtn.blur();
      return;
    }
    const card = e.target.closest('[data-card]');
    const act = e.target.closest('[data-action]')?.dataset.action;
    if (act === 'play') this.hooks.onPlay(this.selected);
    else if (act === 'settings') this.hooks.onSettings();
    else if (act === 'controller') this.hooks.onController();
    else if (act === 'guide') this.hooks.onGuide();
    else if (act === 'free-setup') this.hooks.onFreeSetup();
    else if (act === 'new-field') s.set('hunt.seed', 1 + Math.floor(Math.random() * 99999));
    else if (card && card.dataset.card !== this.selected && !e.target.closest('select')) this.select(card.dataset.card);
    e.target.closest('button')?.blur();
  }

  select(mode) {
    this.selected = mode;
    this.settings.set('game.mode', mode);
    this.hooks.onSelect?.(mode);
    this.render();
  }

  cardHtml(id, title, tagline, body) {
    const on = this.selected === id;
    return `<div class="mm-card${on ? ' active' : ''}" data-card="${id}">
      <div class="mm-card-head"><h3>${title}</h3><span>${tagline}</span></div>
      ${on ? `<div class="mm-card-body">${body}</div>` : ''}
    </div>`;
  }

  render() {
    const d = this.settings.data;
    const f = d.free;
    const payload = d.drone.payload > 0;
    const freeBody = `
      <div class="mm-row"><label>Enemies</label>${seg('free.enemies', [[true, 'On'], [false, 'Off']], f.enemies)}</div>
      <div class="mm-row"><label>Live charge</label>${seg('free.liveCharge', [[true, 'On'], [false, 'Off']], f.liveCharge, !f.enemies)}</div>
      ${f.enemies && f.liveCharge && !payload ? '<p class="mm-note">Live charge needs a drone with a payload (e.g. 7" strike, Settings → Drone).</p>' : ''}
      <div class="mm-row"><label>Battery limit</label>${seg('free.battery', [[false, 'Off'], [true, 'On']], f.battery)}</div>
      <div class="mm-row mm-cond"><span>${cap(d.map.season)} · ${cap(d.env.timeOfDay)} · ${WEATHER[d.env.weather] ?? 'Custom'} · wind ${d.env.windSpeed} m/s</span>
        <button data-action="free-setup">Map &amp; weather…</button></div>`;
    const st = d.strike;
    const strikeBody = `
      <div class="mm-row"><label>Difficulty</label>${seg('strike.difficulty', [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']], st.difficulty)}</div>
      <p class="mm-note">${DIFFICULTY[st.difficulty]}</p>
      <div class="mm-row"><label>Conditions</label>${seg('strike.conditions', [['random', 'Random'], ['free', 'Free Flight\'s']], st.conditions)}</div>
      <p class="mm-note">${st.conditions === 'random' ? 'Every mission a new map, season, time and weather.' : 'Every mission a new map, with the season and weather you set for Free Flight.'}</p>`;
    const h = d.hunt;
    const best = bestScore(h);
    const bestText = best ? (h.variant === 'sweep' ? `Best ${fmt(best.time)} · ${best.drones} drones` : `Best ${best.kills} destroyed`) : 'No record on this battlefield yet';
    const huntBody = `
      <div class="mm-row"><label>Variant</label>${seg('hunt.variant', [['sweep', 'Sweep'], ['endless', 'Endless']], h.variant)}</div>
      <p class="mm-note">${VARIANT[h.variant]}</p>
      ${h.variant === 'endless' ? `<div class="mm-row"><label>Time</label>${seg('hunt.duration', [[180, '3 min'], [300, '5 min'], [600, '10 min'], [0, 'No limit']], h.duration)}</div>` : ''}
      <div class="mm-row"><label>Season</label>${seg('hunt.season', [['spring', 'Spring'], ['summer', 'Summer'], ['autumn', 'Autumn'], ['winter', 'Winter']], h.season)}</div>
      <div class="mm-row"><label>Time of day</label>${seg('hunt.timeOfDay', [['morning', 'Morning'], ['day', 'Day'], ['evening', 'Evening'], ['night', 'Night']], h.timeOfDay)}</div>
      <div class="mm-row"><label>Weather</label>${seg('hunt.weather', [['clear', 'Clear'], ['partly', 'Cloudy'], ['overcast', 'Overcast'], ['rain', 'Rain'], ['snow', 'Snow'], ['fog', 'Fog']], h.weather)}</div>
      <div class="mm-row mm-cond"><span>Battlefield <b>#${h.seed}</b> · ${bestText}</span><button data-action="new-field">New battlefield</button></div>`;
    const hd = d.hide;
    const hb = hideBest(hd.difficulty);
    const hideBody = `
      <div class="mm-row"><label>Difficulty</label>${seg('hide.difficulty', [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], hd.difficulty)}</div>
      <p class="mm-note">${{ easy: 'Big openings, a close hint.', normal: 'Tighter gaps, a rougher hint.', hard: 'Slits and double nets; the hint is only roughly where it is.' }[hd.difficulty]}</p>
      <div class="mm-row"><label>Hideout</label>${seg('hide.shelter', [['random', 'Random'], ['nets', 'Net tunnel'], ['barn', 'Barn'], ['dugout', 'Dugout']], hd.shelter)}</div>
      <div class="mm-row mm-cond"><span>${hb ? `Best on ${hd.difficulty}: <b>${hb.drones}</b> drones · ${fmt(hb.time)}` : `No kill on ${hd.difficulty} yet`}</span></div>`;
    this.cards.innerHTML = [
      this.cardHtml('free', 'FREE FLIGHT', 'Fly anywhere, no goal, no battery limit', freeBody),
      this.cardHtml('strike', 'STRIKE MISSIONS', 'One drone, one target, new mission every time', strikeBody),
      this.cardHtml('hunt', 'HUNT', 'Clear the battlefield, unlimited drones', huntBody),
      this.cardHtml('hide', 'HIDE & SEEK', 'One target in a hideout, close by. Find the way in', hideBody),
    ].join('');
    const preset = DRONE_PRESETS[d.drone.preset];
    this.droneEl.innerHTML = `<small>DRONE</small><b>${preset ? preset.label : `Custom ${d.drone.size}"`}</b>
      <span>${d.drone.size}" · ${d.drone.thrustToWeight.toFixed(1)}:1${payload ? ` · payload ${d.drone.payload.toFixed(1)} kg` : ''}</span>
      <button data-action="settings">Change</button>`;
    this.playSub.textContent = { free: 'Free Flight', strike: `Strike · ${cap(st.difficulty)}`, hunt: `Hunt · ${cap(h.variant)}`, hide: `Hide & Seek · ${cap(hd.difficulty)}` }[this.selected];
  }

  // per frame while visible: controller status
  update() {
    if (!this.visible) return;
    const gp = this.hooks.input.gamepad;
    const text = gp ? gp.id.replace(/\(.*?\)/g, '').trim().slice(0, 28) || 'Controller' : 'No controller · keyboard';
    if (this.padLabel.textContent !== text) this.padLabel.textContent = text;
    this.dot.classList.toggle('on', !!gp);
  }

  key(e) {
    const order = ['free', 'strike', 'hunt', 'hide'];
    if (e.code === 'Enter') this.hooks.onPlay(this.selected);
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      const i = order.indexOf(this.selected) + (e.code === 'ArrowDown' ? 1 : -1);
      this.select(order[(i + order.length) % order.length]);
    }
  }

  show() {
    this.visible = true;
    this.root.hidden = false;
    this.render();
  }

  hide() {
    this.visible = false;
    this.root.hidden = true;
  }
}
