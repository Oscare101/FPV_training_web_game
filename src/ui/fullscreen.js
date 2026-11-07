// Fullscreen over the whole screen (no browser UI). While fullscreen, Chrome's keyboard lock keeps
// Esc for the game (pause menu); holding Esc exits fullscreen as usual.

export const isFullscreen = () => !!document.fullscreenElement;

export async function toggleFullscreen() {
  try {
    if (isFullscreen()) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    await navigator.keyboard?.lock?.(['Escape']);
  } catch {
    // refused (needs a click or key press) or unsupported
  }
}

export function onFullscreenChange(fn) {
  document.addEventListener('fullscreenchange', () => {
    if (!isFullscreen()) navigator.keyboard?.unlock?.();
    fn(isFullscreen());
  });
}
