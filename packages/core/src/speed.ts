const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/** Rolling-window speed meter (default span 3s). */
export class SpeedMeter {
  private samples: Array<{ t: number; bytes: number }> = [];
  private total = 0;
  private span: number;

  constructor(spanMs = 3000) {
    this.span = spanMs;
  }

  add(bytes: number): void {
    this.total += bytes;
    const t = nowMs();
    this.samples.push({ t, bytes });
    while (this.samples.length > 0 && t - this.samples[0].t > this.span) this.samples.shift();
  }

  get bytesTotal(): number {
    return this.total;
  }

  /** bytes per second over the window (0 until first sample settles) */
  get bytesPerSecond(): number {
    if (this.samples.length === 0) return 0;
    const tEnd = this.samples[this.samples.length - 1].t;
    const tStart = Math.max(this.samples[0].t, tEnd - this.span);
    let bytes = 0;
    for (const s of this.samples) if (s.t >= tStart) bytes += s.bytes;
    const dt = tEnd - tStart;
    if (dt <= 0) return bytes > 0 ? bytes : 0;
    return (bytes / dt) * 1000;
  }

  /** seconds to reach totalBytes at current speed; Infinity if unknown */
  eta(totalBytes: number): number {
    const bps = this.bytesPerSecond;
    if (bps <= 0) return Infinity;
    return Math.max(0, (totalBytes - this.total) / bps);
  }

  reset(): void {
    this.samples = [];
    this.total = 0;
  }
}
