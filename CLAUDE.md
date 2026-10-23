# FPV Drone Trainer — Project Brief

Browser-based FPV drone flight trainer with a military theme (Ukrainian frontline style scenarios).
Main goal: **train real FPV flying skills** with a RadioMaster Pocket controller.
Inspiration / comparison: Velocidrone (but with moving targets, varied locations, realistic physics).

## Hard requirements
- Runs in **Chrome** on a **MacBook Air M1**. Target a stable 60 fps. Performance matters more than visual detail.
- Stack: **Three.js + Vite** (npm). Custom drone physics (no general-purpose physics engine unless needed for collisions).
- **Low-poly** graphics, all models generated in code (no external asset downloads).
- UI language: **English**.
- Controller: RadioMaster Pocket (EdgeTX) in **USB Joystick mode** via the browser **Gamepad API**. Axis order can vary, so mapping must be configurable.
- Flight mode: **Acro (rate mode) only**. No angle/horizon mode.

## Phase 1 (current): just fly — physics first
Focus on flight feel. **No gameplay, scoring or mission logic yet.**
1. Project setup (Vite + Three.js), clean module structure.
2. Controller: detection, live axis display, axis mapping + invert, calibration (min/center/max), deadzone.
3. Rates: Betaflight-style (RC rate, super rate, expo) per axis. The user may provide his Velocidrone rates to copy.
4. Drone physics:
   - mass, max thrust / thrust-to-weight, motor spool-up lag
   - linear + quadratic drag, rotational inertia
   - wind with gusts/turbulence
   - battery sag (thrust drops as battery drains)
   - ground effect, camera uptilt angle
   - payload weight that can change (lighter after a drop) — design for it now
   - collisions with ground/objects -> crash + reset
5. Settings menu: drone type (mass, thrust, size), camera uptilt, FOV, rates, wind strength.
6. One map: open field + forest edge, with a few static and slowly moving vehicles (no destruction yet).
7. Day / night toggle.
8. Simple OSD: battery, throttle, speed, altitude, timer.
9. Keyboard fallback for testing without the controller.

## Later phases (do NOT forget, do NOT build yet)
- **Sound**: motor sound that changes with throttle, explosions.
- Drone types: kamikaze, bomber (payload drop), fiber-optic (no jamming, cable length limit, snags on trees), interceptor.
- Video signal model: analog static with distance and obstacles, EW jamming zones.
- Thermal / IR camera (white-hot / black-hot).
- Weather: rain, fog, snow; more locations: city, enemy base, trenches.
- Targets: soldiers, vehicles with weak spots and cope cages, bases, equipment; enemies react (run, drive away, shoot back).
- Scenarios: strike, recon (mark targets), ambush/waiting mode, interception of enemy drones.
- Gameplay, scoring, replays — to be discussed with the user first.

## Working rules
- The user is an experienced developer (React Native). Be concise and action-oriented.
- When changing existing files, keep unrelated code unchanged; only add/modify what is needed.
- Point out his mistakes honestly; prefer strict feedback over agreement.
- Keep computational overhead low (simple geometry, instancing, minimal shadows, no heavy post-processing).
- Keep the military content at game level: the focus is flying skills, not real weapon details.
