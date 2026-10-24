const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

const fmtTime = (s) => {
  const t = Math.floor(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

const COLORS = { white: '#ffffff', green: '#7dff6a', yellow: '#ffe14a', cyan: '#6af0ff' };
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const ROSE = 84; // css px at scale 1
const TAPE_W = 260;
const TAPE_H = 30;
const ARROW = 18;

// heading in degrees, 0 = north (-Z), 90 = east (+X)
export function headingOf(quaternion) {
  const { x, y, z, w } = quaternion;
  // forward (0,0,-1) rotated by q
  const fx = -(2 * (x * z + w * y));
  const fz = -(1 - 2 * (x * x + y * y));
  return ((Math.atan2(fx, -fz) * 180) / Math.PI + 360) % 360;
}

function outlined(ctx, fn) {
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 3;
  fn(true);
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 1.4;
  fn(false);
}

// Betaflight-style OSD as DOM text. preview: absolutely positioned inside a box (settings menu).
export class Osd {
  constructor(parent, { preview = false } = {}) {
    this.root = document.createElement('div');
    this.root.className = preview ? 'osd preview' : 'osd';
    this.root.innerHTML = `
      <div class="osd-cross"></div>
      <canvas class="osd-compass"></canvas>
      <div class="osd-heading"></div>
      <div class="osd-timer"></div>
      <div class="osd-status"></div>
      <div class="osd-hint"></div>
      <div class="osd-left"><div class="osd-bat"></div><div class="osd-mah"></div><div class="osd-thr"></div><div class="osd-payload"></div></div>
      <div class="osd-right"><div class="osd-home"><canvas class="osd-home-arrow"></canvas><span></span></div><div class="osd-speed"></div><div class="osd-alt"></div></div>`;
    parent.appendChild(this.root);
    const q = (s) => this.root.querySelector(s);
    this.el = {
      cross: q('.osd-cross'),
      compass: q('.osd-compass'),
      heading: q('.osd-heading'),
      timer: q('.osd-timer'),
      status: q('.osd-status'),
      hint: q('.osd-hint'),
      thr: q('.osd-thr'),
      bat: q('.osd-bat'),
      mah: q('.osd-mah'),
      payload: q('.osd-payload'),
      home: q('.osd-home'),
      homeText: q('.osd-home span'),
      homeArrow: q('.osd-home-arrow'),
      speed: q('.osd-speed'),
      alt: q('.osd-alt'),
    };
    this.cfg = null;
    this.drawn = '';
    this.arrowDrawn = '';
  }

  // osd settings: element toggles, compass mode, scale, color, opacity, margin
  configure(cfg) {
    this.cfg = cfg;
    const st = this.root.style;
    st.setProperty('--osd-scale', cfg.scale);
    st.setProperty('--osd-color', COLORS[cfg.color] ?? '#fff');
    st.setProperty('--osd-margin', `${cfg.margin}px`);
    st.opacity = cfg.opacity;
    const e = this.el;
    e.cross.hidden = !cfg.crosshair;
    e.timer.hidden = !cfg.timer;
    e.bat.hidden = !cfg.battery;
    e.mah.hidden = !cfg.mah;
    e.thr.hidden = !cfg.throttle;
    e.speed.hidden = !cfg.speed;
    e.alt.hidden = !cfg.altitude;
    e.home.hidden = !cfg.home;
    e.status.hidden = e.hint.hidden = !cfg.hints;
    e.compass.hidden = cfg.compass === 'off';
    e.heading.hidden = cfg.compass !== 'rose';
    this.root.classList.toggle('tape', cfg.compass === 'tape');
    // canvas backing size
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const [w, h] = cfg.compass === 'tape' ? [TAPE_W, TAPE_H] : [ROSE, ROSE];
    e.compass.width = Math.round(w * cfg.scale * dpr);
    e.compass.height = Math.round(h * cfg.scale * dpr);
    e.compass.style.width = `${w * cfg.scale}px`;
    e.compass.style.height = `${h * cfg.scale}px`;
    e.homeArrow.width = e.homeArrow.height = Math.round(ARROW * cfg.scale * dpr);
    e.homeArrow.style.width = e.homeArrow.style.height = `${ARROW * cfg.scale}px`;
    this.drawn = this.arrowDrawn = '';
  }

  // flight: FlightController (or a look-alike for the preview); home: { x, z } launch point
  update(flight, home) {
    const c = flight.controls;
    const cfg = this.cfg;
    setText(this.el.timer, fmtTime(flight.flightTime));
    setText(this.el.thr, `THR ${Math.round(c.throttle * 100)}%`);
    setText(this.el.speed, `${Math.round(flight.speed * 3.6)} km/h`);
    setText(this.el.alt, `ALT ${flight.altitude.toFixed(1)} m`);

    const bat = flight.drone.battery;
    if (bat.enabled) {
      setText(this.el.bat, `${bat.voltage.toFixed(1)}V ${bat.cellVoltage.toFixed(2)}V/c`);
      setText(this.el.mah, `${Math.round(bat.used)} mAh`);
    } else {
      setText(this.el.bat, 'BAT SIM OFF');
      setText(this.el.mah, '');
    }
    this.el.bat.classList.toggle('warn', bat.enabled && (bat.soc < 0.2 || bat.cellVoltage < 3.3));
    const payload = flight.drone.payloadMass;
    setText(this.el.payload, payload > 0 ? `PAYLOAD ${payload.toFixed(2)} kg` : '');

    const heading = headingOf(flight.drone.quaternion);
    if (cfg && cfg.compass !== 'off') this.drawCompass(heading, flight.wind?.base);
    if (cfg?.home && home) {
      const p = flight.drone.position;
      const dx = home.x - p.x;
      const dz = home.z - p.z;
      const dist = Math.hypot(dx, dz);
      setText(this.el.homeText, dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(2)} km`);
      const bearing = (Math.atan2(dx, -dz) * 180) / Math.PI;
      this.drawHomeArrow(dist < 2 ? null : bearing - heading);
    }

    let status = '';
    let hint = '';
    const armHow = c.armMapped ? 'arm switch' : 'Space';
    if (flight.status === 'detonated') {
      // mission overlays take over
    } else if (flight.status === 'crashed') {
      status = flight.crashReason === 'water' ? 'IN THE WATER' : 'CRASHED';
      hint = `Disarm (${armHow}) or press R to reset`;
    } else if (flight.status === 'disarmed') {
      if (flight.armBlock === 'throttle') {
        status = 'THROTTLE NOT LOW';
        hint = `Lower throttle and flip the ${armHow} again`;
      } else if (c.arm) {
        status = 'DISARMED';
        hint = `Flip the ${armHow} off and on again to arm`;
      } else {
        status = 'DISARMED';
        hint = c.radio && !c.armMapped
          ? 'No arm switch mapped: press C to map one, or press Space to arm'
          : `Throttle down, then ${c.armMapped ? 'flip the arm switch' : 'press Space'} to arm`;
      }
    }
    if (!c.radio) hint += (hint ? ' · ' : '') + 'Keyboard: W/S throttle, arrows pitch/roll, A/D yaw, R reset';
    setText(this.el.status, status);
    setText(this.el.hint, hint);
  }

  drawCompass(heading, wind) {
    const cfg = this.cfg;
    const windOn = cfg.compassWind && wind && Math.hypot(wind.x, wind.z) > 0.3;
    const key = `${heading.toFixed(1)}/${windOn ? `${wind.x.toFixed(1)},${wind.z.toFixed(1)}` : ''}/${cfg.compass}`;
    if (key === this.drawn) return;
    this.drawn = key;
    const cv = this.el.compass;
    const ctx = cv.getContext('2d');
    const color = COLORS[cfg.color] ?? '#fff';
    const s = cv.width / (cfg.compass === 'tape' ? TAPE_W : ROSE);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const windTo = windOn ? (Math.atan2(wind.x, -wind.z) * 180) / Math.PI : null; // direction it blows to
    if (cfg.compass === 'tape') this.drawTape(ctx, heading, windTo, color);
    else this.drawRose(ctx, heading, windTo, color, wind);
    setText(this.el.heading, `${String(Math.round(heading) % 360).padStart(3, '0')}° ${CARDINALS[Math.round(heading / 45) % 8]}`);
  }

  drawRose(ctx, heading, windTo, color, wind) {
    const c = ROSE / 2;
    const r = c - 9;
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.arc(c, c, r + 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    outlined(ctx, () => {
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.stroke();
    });
    for (let d = 0; d < 360; d += 30) {
      const a = ((d - heading - 90) * Math.PI) / 180;
      const major = d % 90 === 0;
      const r0 = major ? r - 7 : r - 4;
      outlined(ctx, () => {
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
        ctx.stroke();
      });
    }
    ctx.font = '700 11px ui-monospace, Menlo, monospace';
    ctx.lineJoin = 'round';
    for (const [d, label] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
      const a = ((d - heading - 90) * Math.PI) / 180;
      const x = c + Math.cos(a) * (r - 14);
      const y = c + Math.sin(a) * (r - 14);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 3;
      ctx.strokeText(label, x, y);
      ctx.fillStyle = d === 0 ? '#ff5a4a' : color;
      ctx.fillText(label, x, y);
    }
    ctx.fillStyle = color;
    if (windTo !== null) {
      const a = ((windTo - heading - 90) * Math.PI) / 180;
      const len = (r - 20) * Math.min(1, 0.4 + Math.hypot(wind.x, wind.z) / 12);
      const tx = c + Math.cos(a) * len;
      const ty = c + Math.sin(a) * len;
      ctx.save();
      ctx.fillStyle = ctx.strokeStyle = '#6ab8ff';
      outlined(ctx, () => {
        ctx.beginPath();
        ctx.moveTo(c - Math.cos(a) * len * 0.6, c - Math.sin(a) * len * 0.6);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      });
      ctx.beginPath();
      ctx.moveTo(tx + Math.cos(a) * 3, ty + Math.sin(a) * 3);
      ctx.lineTo(tx + Math.cos(a + 2.5) * 6, ty + Math.sin(a + 2.5) * 6);
      ctx.lineTo(tx + Math.cos(a - 2.5) * 6, ty + Math.sin(a - 2.5) * 6);
      ctx.fill();
      ctx.restore();
    }
    // lubber mark: the direction you face
    ctx.beginPath();
    ctx.moveTo(c, 1);
    ctx.lineTo(c - 5, 9);
    ctx.lineTo(c + 5, 9);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fill();
  }

  drawTape(ctx, heading, windTo, color) {
    const pxPerDeg = 2.2;
    const mid = TAPE_W / 2;
    ctx.font = '700 11px ui-monospace, Menlo, monospace';
    const labels = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    const start = Math.ceil((heading - mid / pxPerDeg) / 5) * 5;
    for (let d = start; d <= heading + mid / pxPerDeg; d += 5) {
      const x = mid + (d - heading) * pxPerDeg;
      const dn = ((d % 360) + 360) % 360;
      const major = dn % 30 === 0;
      outlined(ctx, () => {
        ctx.beginPath();
        ctx.moveTo(x, TAPE_H - 2);
        ctx.lineTo(x, TAPE_H - (major ? 9 : 5));
        ctx.stroke();
      });
      if (major) {
        const text = labels[dn] ?? String(dn);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.lineWidth = 3;
        ctx.strokeText(text, x, 8);
        ctx.fillStyle = dn === 0 ? '#ff5a4a' : color;
        ctx.fillText(text, x, 8);
        ctx.fillStyle = color;
      }
    }
    if (windTo !== null) {
      const rel = ((windTo - heading + 540) % 360) - 180;
      const x = Math.max(4, Math.min(TAPE_W - 4, mid + rel * pxPerDeg));
      ctx.save();
      ctx.fillStyle = '#6ab8ff';
      ctx.beginPath();
      ctx.moveTo(x, TAPE_H - 11);
      ctx.lineTo(x - 4, TAPE_H - 17);
      ctx.lineTo(x + 4, TAPE_H - 17);
      ctx.fill();
      ctx.restore();
    }
    // centre mark + readout box
    const txt = String(Math.round(heading) % 360).padStart(3, '0');
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(mid - 17, 1, 34, 14);
    ctx.fillStyle = color;
    ctx.fillText(txt, mid, 8.5);
    ctx.beginPath();
    ctx.moveTo(mid, TAPE_H - 10);
    ctx.lineTo(mid - 4, TAPE_H - 1);
    ctx.lineTo(mid + 4, TAPE_H - 1);
    ctx.closePath();
    ctx.fill();
  }

  // relative bearing (deg, 0 = straight ahead) or null when at home
  drawHomeArrow(rel) {
    const key = rel === null ? 'home' : rel.toFixed(0);
    if (key === this.arrowDrawn) return;
    this.arrowDrawn = key;
    const cv = this.el.homeArrow;
    const ctx = cv.getContext('2d');
    const s = cv.width / ARROW;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.setTransform(s, 0, 0, s, ARROW / 2 * s, ARROW / 2 * s);
    ctx.fillStyle = COLORS[this.cfg.color] ?? '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (rel === null) {
      ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
    } else {
      ctx.rotate((rel * Math.PI) / 180);
      ctx.moveTo(0, -7.5);
      ctx.lineTo(5.5, 6);
      ctx.lineTo(0, 3);
      ctx.lineTo(-5.5, 6);
      ctx.closePath();
    }
    ctx.stroke();
    ctx.fill();
  }
}
