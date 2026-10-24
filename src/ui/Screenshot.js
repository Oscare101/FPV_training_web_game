// Screenshot of the WebGL canvas, optionally with the DOM HUD drawn on top and an info stamp.
// Must run right after the frame was rendered (the drawing buffer is not preserved).

const pad = (n) => String(n).padStart(2, '0');

function fileName() {
  const d = new Date();
  return `fpv-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.png`;
}

function opacityChain(el, stop) {
  let a = 1;
  for (let e = el; e && e !== stop.parentElement; e = e.parentElement) a *= Number(getComputedStyle(e).opacity);
  return a;
}

function isShown(el) {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

// Draws text nodes, canvases and simple borders of the overlay roots onto ctx (css px * scale)
function drawDom(ctx, roots, scale) {
  const range = document.createRange();
  for (const root of roots) {
    if (!root || !isShown(root)) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.currentNode; node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        const el = node.parentElement;
        if (!text || !isShown(el)) continue;
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect();
        if (!r.width) continue;
        const cs = getComputedStyle(el);
        ctx.save();
        ctx.globalAlpha = opacityChain(el, root);
        ctx.font = `${cs.fontWeight} ${parseFloat(cs.fontSize) * scale}px ${cs.fontFamily}`;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = cs.color;
        ctx.shadowColor = 'rgba(0,0,0,0.9)';
        ctx.shadowBlur = 3 * scale;
        ctx.fillText(text, r.left * scale, (r.top + r.height / 2) * scale);
        ctx.restore();
        continue;
      }
      const el = node;
      if (!isShown(el)) continue;
      const r = el.getBoundingClientRect();
      if (el instanceof HTMLCanvasElement) {
        if (r.width && r.height) {
          ctx.save();
          ctx.globalAlpha = opacityChain(el, root);
          ctx.drawImage(el, r.left * scale, r.top * scale, r.width * scale, r.height * scale);
          ctx.restore();
        }
        continue;
      }
      if (el.classList.contains('osd-cross')) {
        const cx = (r.left + r.width / 2) * scale;
        const cy = (r.top + r.height / 2) * scale;
        ctx.save();
        ctx.globalAlpha = opacityChain(el, root);
        ctx.fillStyle = getComputedStyle(el).color;
        ctx.fillRect(cx - scale, r.top * scale, 2 * scale, r.height * scale);
        ctx.fillRect(r.left * scale, cy - scale, r.width * scale, 2 * scale);
        ctx.restore();
        continue;
      }
      const cs = getComputedStyle(el);
      const bw = parseFloat(cs.borderTopWidth);
      if (bw > 0 && cs.borderTopStyle === 'solid' && cs.borderTopColor === cs.borderLeftColor && r.width > 2 && r.height > 2) {
        ctx.save();
        ctx.globalAlpha = opacityChain(el, root);
        ctx.strokeStyle = cs.borderTopColor;
        ctx.lineWidth = bw * scale;
        ctx.strokeRect((r.left + bw / 2) * scale, (r.top + bw / 2) * scale, (r.width - bw) * scale, (r.height - bw) * scale);
        ctx.restore();
      }
    }
  }
}

// canvas: the WebGL canvas; overlays: DOM roots to draw (HUD, mission); stamp: text or ''
export function captureScreenshot(canvas, { overlays = [], stamp = '' } = {}) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(canvas, 0, 0);
  const scale = canvas.width / canvas.clientWidth;
  drawDom(ctx, overlays, scale);
  if (stamp) {
    const fs = Math.round(11 * scale);
    ctx.font = `${fs}px ui-monospace, Menlo, monospace`;
    ctx.textBaseline = 'bottom';
    const w = ctx.measureText(stamp).width;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, out.height - fs * 1.7, w + fs, fs * 1.7);
    ctx.fillStyle = '#e8eee8';
    ctx.fillText(stamp, fs / 2, out.height - fs * 0.35);
  }
  const name = fileName();
  out.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
  return name;
}

// Small downscaled JPEG of the current frame (settings menu HUD preview background)
export function snapshotDataUrl(canvas, width = 720) {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = Math.round((width * canvas.height) / canvas.width);
  out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.85);
}

// Brief flash + toast so the user knows a screenshot was taken
export function screenshotToast(name) {
  const flash = document.createElement('div');
  flash.className = 'shot-flash';
  const toast = document.createElement('div');
  toast.className = 'shot-toast';
  toast.textContent = `Screenshot saved to Downloads · ${name}`;
  document.body.append(flash, toast);
  setTimeout(() => flash.remove(), 250);
  setTimeout(() => toast.remove(), 2600);
}
