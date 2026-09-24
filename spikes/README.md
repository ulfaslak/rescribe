# Spikes

Throwaway experiments that answer one question each about what the browser lets us do. They are built into `dist/spikes/` so Playwright can open them as extension pages (`e2e/spikes/`), but they are not part of the product and share no code with `src/`.

Each spike's question and answer is recorded below when it runs. Once a spike's answer is encoded in `src/` and the DNA, delete the spike (tracked in `AGENTS/DEFERRED.md`).

## capture

**Question:** From an extension page, can we take `getDisplayMedia` (tab, with audio) and a separate microphone stream at the same time, mix them, and get a playable, seekable MP4 (H.264 + AAC) out of `MediaRecorder`? And can a worker append chunks to OPFS via a sync access handle as they arrive?

**Answer:** pending.

## parakeet

**Question:** Does parakeet.js load Parakeet TDT 0.6B v3 (fp16 encoder on WebGPU, int8 decoder on WASM) inside the extension origin under our CSP and COOP/COEP headers, with the ONNX WASM binaries served from `dist/vendor/ort/`, and transcribe a WAV correctly? How fast?

**Answer:** pending.
