const HISTORY = 120; // frames in the graph
const GRAPH_MAX_MS = 50;
const W = 120;
const H = 36;

// FPS readout plus a frame-time graph (F toggles the graph). Spikes = dropped frames.
export class FpsCounter {
  constructor(parent) {
    this.el = document.createElement('div');
    this.el.className = 'fps';
    this.text = document.createElement('div');
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.el.append(this.text, this.canvas);
    parent.appendChild(this.el);
    this.ctx = this.canvas.getContext('2d');

    this.times = new Float32Array(HISTORY);
    this.head = 0;
    this.last = performance.now();
    this.frames = 0;
    this.worst = 0;
    this.since = this.last;
  }

  toggle() {
    this.canvas.hidden = !this.canvas.hidden;
  }

  update(now) {
    const ms = now - this.last;
    this.last = now;
    this.times[this.head] = ms;
    this.head = (this.head + 1) % HISTORY;
    this.frames++;
    this.worst = Math.max(this.worst, ms);

    const elapsed = now - this.since;
    if (elapsed >= 500) {
      this.text.textContent = `${Math.round((this.frames * 1000) / elapsed)} fps · max ${Math.round(this.worst)} ms`;
      this.frames = 0;
      this.worst = 0;
      this.since = now;
    }
    if (!this.canvas.hidden) this.draw();
  }

  draw() {
    const { ctx } = this;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < HISTORY; i++) {
      const ms = this.times[(this.head + i) % HISTORY];
      const h = Math.min(H, (ms / GRAPH_MAX_MS) * H);
      ctx.fillStyle = ms > 20 ? '#ff6b4a' : '#9ccc4a';
      ctx.fillRect(i, H - h, 1, h);
    }
    const y = H - (16.7 / GRAPH_MAX_MS) * H; // 60 fps budget
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fillRect(0, y, W, 1);
  }
}
