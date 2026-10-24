// Sun position from season, time of day and latitude (solar time, no Three.js).
// Presets follow the season: "morning" is a fixed early clock time (so winter mornings are dim and
// summer mornings bright), "evening" is always just before sunset (a warm golden hour), "day" is
// around solar noon (highest sun of that season).

const DAY_OF_YEAR = { spring: 105, summer: 172, autumn: 288, winter: 355 }; // mid-Apr, solstice, mid-Oct, solstice
const RAD = Math.PI / 180;

export const declination = (season) => 23.44 * Math.sin((2 * Math.PI * (284 + (DAY_OF_YEAR[season] ?? 172))) / 365);

// solar hours of sunrise / sunset
export function sunTimes(season, latitude) {
  const c = -Math.tan(latitude * RAD) * Math.tan(declination(season) * RAD);
  const h0 = Math.acos(Math.max(-1, Math.min(1, c))) / RAD / 15;
  return { sunrise: 12 - h0, sunset: 12 + h0 };
}

export function presetHour(timeOfDay, season, latitude) {
  const { sunrise, sunset } = sunTimes(season, latitude);
  switch (timeOfDay) {
    case 'morning': return Math.max(7, sunrise + 0.75);
    case 'day': return 12.75;
    case 'evening': return sunset - 0.45;
    case 'night': return 23.5;
    default: return null;
  }
}

// { hour, elevation (deg), azimuth (deg from north, clockwise), dir: [x, y, z] towards the sun }
// World axes: north = -Z, east = +X.
export function computeSun({ season = 'summer', timeOfDay = 'day', hour = 13, latitude = 48.5 }) {
  const h = timeOfDay === 'custom' ? hour : presetHour(timeOfDay, season, latitude);
  const phi = latitude * RAD;
  const dec = declination(season) * RAD;
  const ha = (h - 12) * 15 * RAD;
  const sinE = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha);
  const e = Math.asin(Math.max(-1, Math.min(1, sinE)));
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) + Math.PI;
  return {
    hour: h,
    elevation: e / RAD,
    azimuth: ((az / RAD) + 360) % 360,
    dir: [Math.sin(az) * Math.cos(e), Math.sin(e), -Math.cos(az) * Math.cos(e)],
  };
}

export const fmtHour = (h) => {
  const t = Math.round((((h % 24) + 24) % 24) * 60);
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
