// Damage rules for strike drones, game level. The warhead is a shaped charge with a fragmentation
// sleeve: a direct hit's effect depends on where it lands (zones); a near miss only does what blast
// and fragments do, so it wrecks ammo and soft vehicles nearby but barely scratches armor.
// Buildings, wrecks and earth berms between the blast and a vehicle stop it; nets and trees don't.

export const EFFECT_RANK = { intact: 0, damaged: 1, immobilized: 2, destroyed: 3 };
export const NEXT_STATE = { intact: 'damaged', damaged: 'immobilized', immobilized: 'destroyed', destroyed: 'destroyed' };

// Direct-hit zones in the vehicle's local box frame: u = lx / half.x, v = ly / half.y,
// w = lz / half.z (each -1..1, nose = -w). Rear/top are weak, front is strong, running gear immobilizes.
export const ZONES = {
  tank: (u, v, w) => {
    if (w > 0.45) return ['Engine deck', 'destroyed'];
    if (v > 0.2) return ['Turret roof', 'destroyed'];
    if (Math.abs(u) > 0.55 && v < 0) return ['Tracks', 'immobilized'];
    if (w < -0.45) return ['Front armor', 'damaged'];
    return ['Side armor', 'damaged'];
  },
  ifv: (u, v, w) => {
    if (w < -0.35) return ['Engine (front)', 'destroyed'];
    if (v > 0.35) return ['Roof', 'destroyed'];
    if (Math.abs(u) > 0.6 && v < -0.1) return ['Tracks', 'immobilized'];
    if (w > 0.75) return ['Rear doors', 'destroyed'];
    return ['Side', 'destroyed'];
  },
  apc: (u, v, w) => {
    if (w > 0.45) return ['Engine', 'destroyed'];
    if (v > 0.3) return ['Roof', 'destroyed'];
    if (Math.abs(u) > 0.7 && v < -0.2) return ['Wheels', 'immobilized'];
    if (w < -0.6) return ['Front plate', 'damaged'];
    return ['Side', 'destroyed'];
  },
  truck: (u, v, w) => (w < -0.4 ? ['Cab', 'destroyed'] : ['Cargo', 'destroyed']),
  car: () => ['Body', 'destroyed'],
  ammo: () => ['Crates', 'destroyed'],
};

// Near miss: distance bands [max distance to the nearest part (m), [[effect, probability], ...]];
// the first band containing the distance is rolled, the remaining probability is "no effect".
export const BLAST = {
  tank: [[0.8, [['immobilized', 0.15], ['damaged', 0.2]]]],
  ifv: [[1, [['immobilized', 0.2], ['damaged', 0.35]]], [2.5, [['damaged', 0.1]]]],
  apc: [[1, [['immobilized', 0.35], ['damaged', 0.4]]], [3, [['damaged', 0.3], ['immobilized', 0.1]]]],
  truck: [[1.5, [['destroyed', 0.7], ['immobilized', 0.3]]], [4, [['destroyed', 0.25], ['immobilized', 0.35], ['damaged', 0.3]]], [8, [['damaged', 0.4], ['immobilized', 0.1]]]],
  car: [[1.5, [['destroyed', 0.85], ['immobilized', 0.15]]], [4, [['destroyed', 0.4], ['immobilized', 0.35], ['damaged', 0.25]]], [8, [['damaged', 0.45], ['immobilized', 0.1]]]],
  ammo: [[2, [['destroyed', 1]]], [5, [['destroyed', 0.6], ['damaged', 0.3]]], [9, [['destroyed', 0.15], ['damaged', 0.25]]]],
};
export const BLAST_REACH = 9; // m, nothing beyond this
export const AMMO_COOKOFF = { chance: 0.6, delay: [5, 12] }; // a burning (damaged) ammo stack may still go up

// Near-miss outcome for a vehicle type at distance d; through: 1 open, 0.5 through a fence, 0 blocked
export function blastEffect(type, d, through = 1, rand = Math.random) {
  if (through <= 0) return null;
  const band = (BLAST[type] ?? []).find(([max]) => d <= max);
  if (!band) return null;
  let r = rand();
  for (const [effect, p] of band[1]) {
    if ((r -= p * through) < 0) return effect;
  }
  return null;
}

// What a vehicle becomes after an effect: never less damaged; a repeat hit that wouldn't add
// anything still wears it down one step (damaged -> immobilized -> destroyed)
export function combine(state, effect) {
  if (!effect) return state;
  if (EFFECT_RANK[effect] > EFFECT_RANK[state]) return effect;
  return state === 'intact' ? state : NEXT_STATE[state];
}

// Target guide text (settings)
export const GUIDE = {
  tank: {
    label: 'Tank', armor: 'Heavy armor, tracked',
    summary: 'Only a direct hit on a weak spot kills it. Near misses do almost nothing.',
    tips: 'Dive steeply onto the engine deck (rear) or the turret roof. A hit on the tracks stops it. The front and sides only damage it.',
  },
  ifv: {
    label: 'IFV', armor: 'Light armor, tracked',
    summary: 'Most direct hits destroy it, the engine is at the front. Near misses rarely hurt.',
    tips: 'Front, roof, sides and the rear doors all work. Tracks immobilize. Within a metre a blast may damage tracks or optics.',
  },
  apc: {
    label: 'APC', armor: 'Light armor, wheeled',
    summary: 'Direct hits on the engine (rear), roof or sides destroy it; close blasts can disable the wheels.',
    tips: 'The front plate holds. A blast within ~1 m often wrecks wheels; up to ~3 m it can damage it.',
  },
  truck: {
    label: 'Truck', armor: 'Unarmored',
    summary: 'Any hit destroys it, and a blast a few metres away often does too.',
    tips: 'Fragments shred tyres, radiator and fuel within ~4 m; up to ~8 m it can still be damaged.',
  },
  car: {
    label: 'Car', armor: 'Unarmored',
    summary: 'Any hit destroys it; blasts within ~4 m usually wreck it.',
    tips: 'Fast and hard to catch; it sees you early. A near miss is often enough.',
  },
  ammo: {
    label: 'Ammo stack', armor: 'Crates of ammunition',
    summary: 'The easiest kill: a blast within 2 m sets it off, up to ~9 m it may catch fire.',
    tips: 'A burning stack can still cook off several seconds later, with secondary explosions that hit anything next to it.',
  },
};
export const GUIDE_RULES = [
  ['Direct hit', 'The warhead is a shaped charge: on armor, where it lands decides everything. Steep dives onto the top and rear work best.'],
  ['Near miss', 'Blast and fragments: deadly to ammo and soft vehicles nearby, almost harmless to tanks and IFVs.'],
  ['Cover', 'A wall, a wreck or an earth berm between the blast and a vehicle stops it. A fence lets about half through.'],
  ['Camo nets', 'Nets don\'t stop a blast, but they catch the drone: fast into a net sets off the fuse on the net (a near miss), slow tangles it and you crash. Look for an open edge to fly under.'],
  ['Wear', 'Damage adds up: hitting a damaged vehicle again immobilizes it, then destroys it.'],
  ['Hideouts', 'Earth berms and log roofs stop a blast like walls. Tarp and net covers don\'t, but they catch the drone: get inside through the gap and hit the vehicle directly.'],
];
