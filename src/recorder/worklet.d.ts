// AudioWorkletGlobalScope, which TypeScript's DOM lib does not declare. Used by *.worklet.ts.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
): void;
declare const currentFrame: number;
declare const currentTime: number;
declare const sampleRate: number;
