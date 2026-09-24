// AudioWorklet tap: one per channel, in the 16 kHz tap context (graph.ts). Converts its mono
// input to Int16 and posts ~200 ms blocks (transferred, nothing retained). When the input is
// absent or empty (track ended, nothing connected yet) it writes zeros, so the sample count keeps
// tracking elapsed time and `sample / 16000` stays recording-relative seconds (ARCHITECTURE § Clock).
import { floatToInt16 } from '../lib/pcm.ts';

/** Tap → app tab. */
export type TapMessage =
  { type: 'block'; pcm: ArrayBuffer; frame: number } | { type: 'flushed'; frames: number };
/** App tab → tap. `flush` posts the partial block and stops the processor. */
export type TapCommand = { type: 'flush' };

const BLOCK_FRAMES = 3200; // 200 ms at 16 kHz
const QUANTUM = 128;

class TapProcessor extends AudioWorkletProcessor {
  private buf = new Int16Array(BLOCK_FRAMES);
  private fill = 0;
  private blockFrame = 0;
  private total = 0;
  private done = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<TapCommand>) => {
      if (e.data.type !== 'flush' || this.done) return;
      this.done = true;
      this.emit();
      this.port.postMessage({ type: 'flushed', frames: this.total } satisfies TapMessage);
    };
  }

  private emit(): void {
    if (this.fill === 0) return;
    const out = this.buf.slice(0, this.fill);
    this.port.postMessage(
      { type: 'block', pcm: out.buffer, frame: this.blockFrame } satisfies TapMessage,
      [out.buffer],
    );
    this.fill = 0;
  }

  override process(inputs: Float32Array[][]): boolean {
    if (this.done) return false;
    const input = inputs[0]?.[0];
    const frames = input && input.length > 0 ? input.length : QUANTUM;
    let offset = 0;
    while (offset < frames) {
      if (this.fill === 0) this.blockFrame = currentFrame + offset;
      const room = BLOCK_FRAMES - this.fill;
      const n = Math.min(room, frames - offset);
      if (input && input.length > 0) {
        floatToInt16(input.subarray(offset, offset + n), this.buf, this.fill);
      } else {
        this.buf.fill(0, this.fill, this.fill + n);
      }
      this.fill += n;
      this.total += n;
      offset += n;
      if (this.fill === BLOCK_FRAMES) this.emit();
    }
    return true;
  }
}

registerProcessor('rescribe-tap', TapProcessor);
