// Thin wrapper over the Gamepad API. Chrome only exposes a pad after the user
// moves a stick or presses a button while the page is open.
export class GamepadSource {
  constructor() {
    this.index = null;
    window.addEventListener('gamepadconnected', (e) => {
      if (this.index === null) this.index = e.gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.index === e.gamepad.index) this.index = null;
    });
  }

  list() {
    return Array.from(navigator.getGamepads?.() ?? []).filter(Boolean);
  }

  select(index) {
    this.index = index;
  }

  // Must be called every frame: Chrome returns snapshots, not live objects.
  poll() {
    const pads = navigator.getGamepads?.() ?? [];
    if (this.index !== null && pads[this.index]) return pads[this.index];
    const first = Array.from(pads).find(Boolean);
    this.index = first ? first.index : null;
    return first ?? null;
  }
}
