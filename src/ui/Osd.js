const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

const fmtTime = (s) => {
  const t = Math.floor(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

export class Osd {
  constructor(parent) {
    this.root = document.createElement('div');
    this.root.className = 'osd';
    this.root.innerHTML = `
      <div class="osd-cross"></div>
      <div class="osd-timer"></div>
      <div class="osd-status"></div>
      <div class="osd-hint"></div>
      <div class="osd-left"><div class="osd-bat"></div><div class="osd-mah"></div><div class="osd-thr"></div><div class="osd-payload"></div></div>
      <div class="osd-right"><div class="osd-speed"></div><div class="osd-alt"></div></div>`;
    parent.appendChild(this.root);
    const q = (s) => this.root.querySelector(s);
    this.el = {
      timer: q('.osd-timer'),
      status: q('.osd-status'),
      hint: q('.osd-hint'),
      thr: q('.osd-thr'),
      bat: q('.osd-bat'),
      mah: q('.osd-mah'),
      payload: q('.osd-payload'),
      speed: q('.osd-speed'),
      alt: q('.osd-alt'),
    };
  }

  update(flight) {
    const c = flight.controls;
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

    let status = '';
    let hint = '';
    const armHow = c.armMapped ? 'arm switch' : 'Space';
    if (flight.status === 'detonated') {
      // mission overlays take over
    } else if (flight.status === 'crashed') {
      status = 'CRASHED';
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
}
