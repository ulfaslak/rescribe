// The WebGPU guards every engine shares (parakeet.ts, whisper.ts): a WebGPU load either runs on
// WebGPU or fails loudly, never quietly on WASM with weights meant for the GPU.
import type { Backend } from './engine.ts';

/** A WebGPU load must not quietly become fp32 or fp16 on WASM, slower than the int8 default. */
export async function assertWebGpu(): Promise<void> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown | null> } }).gpu;
  const adapter = gpu ? await gpu.requestAdapter() : null;
  if (!adapter) {
    throw new Error('WebGPU is not available in this browser; switch the backend to WASM');
  }
}

/**
 * ORT drops an execution provider it cannot initialise with only a console.warn ("removing
 * requested execution provider ..." in onnxruntime-web/dist/ort.mjs) and runs on WASM. For the
 * WebGPU backend that is the silent degradation `assertWebGpu` guards against one step earlier;
 * catch it here too, at the moment it happens, and release what was created.
 */
export async function failOnDroppedWebGpu<T>(
  backend: Backend,
  release: (created: T) => void,
  create: () => Promise<T>,
): Promise<T> {
  if (backend !== 'webgpu') return create();
  const originalWarn = console.warn;
  let dropped: string | undefined;
  console.warn = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (/removing requested execution provider "webgpu"/.test(text)) dropped = text;
    originalWarn.apply(console, args);
  };
  try {
    const created = await create();
    if (dropped) {
      release(created);
      throw new Error(`WebGPU refused by ONNX Runtime, not running on WASM instead: ${dropped}`);
    }
    return created;
  } finally {
    console.warn = originalWarn;
  }
}
