import * as THREE from 'three';

const _p = new THREE.Vector3();
const _f = new THREE.Vector3();
const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

// Mode overlays on top of the flight view: briefing, counters, charge status, target marker,
// direction hint, video static after detonation, banner, kill feed and the result panel.
// Modes set what they need each frame; anything not set this frame is hidden by begin()/end().
export class GameHud {
  // world: for camera + lens warp; onAction(action) for result-panel buttons
  constructor(parent, world, onAction) {
    this.world = world;
    const root = document.createElement('div');
    root.className = 'mission';
    root.innerHTML = `
      <div class="mission-briefing"></div>
      <div class="hud-stats"></div>
      <div class="mission-hint"><div class="mission-hint-arrow">▲</div><span></span></div>
      <div class="mission-hud"><div class="mission-charge"></div><div class="mission-dist"></div></div>
      <div class="mission-marker"><div class="mission-marker-shape"></div><span></span></div>
      <canvas class="mission-static" width="160" height="90"></canvas>
      <div class="mission-signal"></div>
      <div class="hud-banner"></div>
      <div class="hud-feed"></div>
      <div class="mission-result">
        <h1></h1>
        <div class="mission-result-lines"></div>
        <div class="row-actions"></div>
      </div>`;
    parent.appendChild(root);
    const q = (sel) => root.querySelector(sel);
    this.root = root;
    this.el = {
      briefing: q('.mission-briefing'),
      stats: q('.hud-stats'),
      hint: q('.mission-hint'),
      hintArrow: q('.mission-hint-arrow'),
      hintText: q('.mission-hint span'),
      hud: q('.mission-hud'),
      charge: q('.mission-charge'),
      dist: q('.mission-dist'),
      marker: q('.mission-marker'),
      markerShape: q('.mission-marker-shape'),
      markerText: q('.mission-marker span'),
      static: q('.mission-static'),
      signal: q('.mission-signal'),
      banner: q('.hud-banner'),
      feed: q('.hud-feed'),
      result: q('.mission-result'),
      resultTitle: q('.mission-result h1'),
      resultLines: q('.mission-result-lines'),
      resultActions: q('.mission-result .row-actions'),
    };
    this.staticCtx = this.el.static.getContext('2d');
    this.staticImage = this.staticCtx.createImageData(160, 90);
    this.el.result.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      onAction(btn.dataset.action);
      btn.blur();
    });
    this.briefingKey = null;
    this.resultKey = null;
    this.bannerUntil = 0;
    this.feedItems = [];
    this.used = new Set();
    this.hideAll();
  }

  hideAll() {
    for (const k of ['briefing', 'stats', 'hint', 'hud', 'marker', 'static', 'signal', 'result']) this.el[k].hidden = true;
  }

  // Frame protocol: begin(), mode calls setters, end() hides whatever wasn't set
  begin() {
    this.used.clear();
  }

  end(now) {
    for (const k of ['briefing', 'stats', 'hint', 'hud', 'marker', 'static', 'signal', 'result']) this.el[k].hidden = !this.used.has(k);
    this.el.banner.hidden = now > this.bannerUntil;
    // kill feed: fade out after 4 s
    this.feedItems = this.feedItems.filter((f) => {
      if (now - f.t > 4000) {
        f.el.remove();
        return false;
      }
      f.el.style.opacity = String(Math.min(1, (4000 - (now - f.t)) / 800));
      return true;
    });
  }

  briefing(key, html) {
    this.used.add('briefing');
    if (this.briefingKey !== key) {
      this.el.briefing.innerHTML = html;
      this.briefingKey = key;
    }
  }

  stats(html) {
    this.used.add('stats');
    if (this.el.stats.innerHTML !== html) this.el.stats.innerHTML = html;
  }

  charge(armed, extra = '') {
    this.used.add('hud');
    setText(this.el.charge, armed ? 'CHARGE ARMED' : 'CHARGE SAFE');
    this.el.charge.classList.toggle('armed', armed);
    this.el.dist.hidden = !extra;
    if (extra) setText(this.el.dist, extra);
  }

  staticFeed(text) {
    this.used.add('static');
    this.used.add('signal');
    setText(this.el.signal, text);
    const data = this.staticImage.data;
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.random() * 255;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
    this.staticCtx.putImageData(this.staticImage, 0, 0);
  }

  banner(text, ms = 1500, cls = '') {
    this.el.banner.textContent = text;
    this.el.banner.className = `hud-banner ${cls}`;
    this.bannerUntil = performance.now() + ms;
  }

  feed(text, cls = '') {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    this.el.feed.prepend(el);
    this.feedItems.push({ el, t: performance.now() });
    if (this.feedItems.length > 5) this.feedItems.shift().el.remove();
  }

  clearFeed() {
    for (const f of this.feedItems) f.el.remove();
    this.feedItems = [];
  }

  // Direction arrow to a point (medium strike); near: show "ENEMY NEAR" instead
  hint(from, toX, toZ, near) {
    this.used.add('hint');
    const el = this.el;
    el.hint.classList.toggle('near', near);
    if (near) {
      setText(el.hintText, 'ENEMY NEAR');
      el.hintArrow.hidden = true;
      return;
    }
    el.hintArrow.hidden = false;
    _f.set(0, 0, -1).applyQuaternion(this.world.camera.quaternion);
    const heading = Math.atan2(_f.x, -_f.z);
    const to = Math.atan2(toX - from.x, -(toZ - from.z));
    el.hintArrow.style.transform = `rotate(${to - heading}rad)`;
    setText(el.hintText, `~${Math.round(Math.hypot(toX - from.x, toZ - from.z) / 50) * 50} m`);
  }

  // Marker on a vehicle (top of its hull), through the FPV lens distortion; clamped to the edge
  marker(vehicle, dronePos) {
    this.used.add('marker');
    const el = this.el;
    const camera = this.world.camera;
    _p.copy(vehicle.mesh.position);
    _p.y += vehicle.half.y * 2;
    const dist = _p.distanceTo(dronePos);
    _f.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const behind = _p.clone().sub(camera.position).dot(_f) < 0;
    _p.project(camera);
    let x = _p.x;
    let y = _p.y;
    if (behind) {
      x = -x;
      y = -y;
    } else if (this.world.lensWarp) {
      [x, y] = this.world.lensWarp(x, y);
    }
    const margin = 0.9;
    const onScreen = !behind && Math.abs(x) < margin && Math.abs(y) < margin;
    if (!onScreen) {
      const k = margin / Math.max(Math.abs(x), Math.abs(y), 1e-6);
      x *= k;
      y *= k;
    }
    el.marker.style.transform = `translate(${((x + 1) / 2) * window.innerWidth}px, ${((1 - y) / 2) * window.innerHeight}px)`;
    el.marker.classList.toggle('edge', !onScreen);
    el.markerShape.style.transform = onScreen ? 'rotate(45deg)' : `rotate(${Math.atan2(x, y)}rad)`;
    const spotted = vehicle.driver?.state.aware ?? false;
    setText(el.markerText, `${Math.round(dist)} m${spotted ? ' · SPOTTED' : ''}`);
    el.marker.classList.toggle('spotted', spotted);
    return dist;
  }

  // result: { key, title, cls, lines: [html], actions: [[action, label, primary?]] }
  result(r) {
    this.used.add('result');
    if (this.resultKey === r.key) return;
    this.resultKey = r.key;
    this.el.resultTitle.textContent = r.title;
    this.el.resultTitle.className = r.cls;
    this.el.resultLines.innerHTML = r.lines.map((l) => `<div>${l}</div>`).join('');
    this.el.resultActions.innerHTML = r.actions.map(([a, l, primary]) => `<button data-action="${a}" class="${primary ? 'primary' : 'secondary'}">${l}</button>`).join('');
  }
}
