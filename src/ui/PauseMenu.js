// In-game pause (Esc): resume, restart, settings, exit. Free Flight can open every setting;
// missions and Hunt only the ones that don't change the game (exit to change the rest).
export class PauseMenu {
  // onAction(action): 'resume' | 'restart' | 'reset-enemies' | 'settings' | 'free-setup' | 'controller' | 'menu'
  constructor(parent, onAction) {
    this.visible = false;
    this.root = document.createElement('div');
    this.root.className = 'pm';
    this.root.innerHTML = `
      <div class="pm-box">
        <small class="pm-kicker">PAUSED</small>
        <h2 class="pm-title"></h2>
        <div class="pm-info"></div>
        <div class="pm-buttons"></div>
        <p class="pm-note"></p>
      </div>`;
    parent.appendChild(this.root);
    this.title = this.root.querySelector('.pm-title');
    this.info = this.root.querySelector('.pm-info');
    this.buttons = this.root.querySelector('.pm-buttons');
    this.note = this.root.querySelector('.pm-note');
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      b.blur();
      onAction(b.dataset.action);
    });
    this.root.hidden = true;
  }

  // mode: 'free' | 'strike' | 'hunt'; info: status line; enemies: free flight with enemies on
  show(modeName, mode, info, enemies) {
    this.visible = true;
    this.root.hidden = false;
    this.title.textContent = modeName;
    this.info.textContent = info;
    const free = mode === 'free';
    const items = [
      ['resume', 'Resume', true],
      ['restart', { free: 'Drone back to the pad', strike: 'Retry mission', hunt: 'Restart the hunt', hide: 'Retry this hideout' }[mode]],
      ...(free && enemies ? [['reset-enemies', 'Reset enemies']] : []),
      ...(free ? [['free-setup', 'Enemies & custom conditions']] : []),
      ['settings', 'Settings'],
      ['controller', 'Controller'],
      ['menu', 'Exit to main menu'],
    ];
    this.buttons.innerHTML = items.map(([a, l, primary]) => `<button data-action="${a}" class="${primary ? 'primary' : ''}">${l}</button>`).join('');
    this.note.textContent = free ? '' : 'Drone, map, weather and enemy settings are set before a mission. Exit to the main menu to change them.';
    this.buttons.querySelector('button').focus();
  }

  hide() {
    this.visible = false;
    this.root.hidden = true;
  }
}
