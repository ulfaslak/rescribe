// Render-gap detection for the PCM channels (ARCHITECTURE § Clock). The taps write one sample per
// 1/16000 s of *rendered* context time; when the render thread does not run (output device
// change, a suspended context) nothing is written and `sample / 16000` drifts ahead of the wall
// clock. The recorder feeds every block here with the monotonic time since the taps started; when
// the audio position stays behind by more than the threshold for a whole window, the lag is
// padded with zeros into both channel files. The window is what separates a render gap (every
// block afterwards shows the same lag) from a main-thread stall (queued blocks arrive in a burst
// whose last member shows no lag). Pure; unit-tested in gap.test.ts.

export interface GapOptions {
  sampleRate: number;
  /** Lags at or under this are latency and jitter, not gaps. */
  thresholdMs: number;
  /** The lag must persist over this much elapsed time before it is padded. */
  windowMs: number;
  /** Upper bound on one insertion, against clock jumps. */
  maxPadMs: number;
}

export class GapDetector {
  private readonly o: GapOptions;
  /** Zero frames inserted so far; shared by both channels. */
  paddedFrames = 0;
  private lags: Array<{ at: number; lagMs: number }> = [];

  constructor(o: GapOptions) {
    this.o = o;
  }

  /**
   * @param elapsedMs monotonic ms since the taps started (`performance.now()` based)
   * @param position frames the tap emitted before this block
   * @param blockFrames frames in this block
   * @returns zero frames to write to every channel file before this block; 0 almost always
   */
  observe(elapsedMs: number, position: number, blockFrames: number): number {
    const fileEndMs = ((position + blockFrames + this.paddedFrames) / this.o.sampleRate) * 1000;
    const lagMs = elapsedMs - fileEndMs;
    this.lags.push({ at: elapsedMs, lagMs });
    this.lags = this.lags.filter((l) => l.at >= elapsedMs - this.o.windowMs);
    const oldest = this.lags[0]!;
    if (elapsedMs - oldest.at < this.o.windowMs) return 0;
    const minLag = Math.min(...this.lags.map((l) => l.lagMs));
    if (minLag <= this.o.thresholdMs) return 0;
    const padMs = Math.min(minLag, this.o.maxPadMs);
    const frames = Math.round((padMs / 1000) * this.o.sampleRate);
    this.paddedFrames += frames;
    this.lags = [];
    return frames;
  }
}
