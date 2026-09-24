# Spikes

Throwaway experiments that answer one question each about what the browser lets us do. They are built into `dist/spikes/` so Playwright can open them as extension pages (`e2e/spikes/`), but they are not part of the product and share no code with `src/`.

Each spike's question and answer is recorded below when it runs. Once a spike's answer is encoded in `src/` and the DNA, delete the spike (tracked in `AGENTS/DEFERRED.md`).

## capture

**Question:** From an extension page, can we take `getDisplayMedia` (tab, with audio) and a separate microphone stream at the same time, mix them, and get a playable, seekable MP4 (H.264 + AAC) out of `MediaRecorder`? And can a worker append chunks to OPFS via a sync access handle as they arrive?

**Answer (2026-09-24, headless Chromium via Playwright, extension origin):** yes to all of it.
`getDisplayMedia({video, audio})` and `getUserMedia({audio})` run concurrently; both feed one
`AudioContext` (analysers saw signal on both). `MediaRecorder` with
`video/mp4;codecs=avc1.42E01E,mp4a.40.2` and a 500 ms timeslice produced a **fragmented MP4**
(`ftyp`, `moov` with `mvex`, then `moof`+`mdat` per fragment, `mfra` at the end) that `ffprobe`
reads cleanly: h264 + aac, duration 3.05 s for a 3 s capture, 174 kB at 1.5 Mbit/s. Concatenating
the chunks byte for byte is the file. The OPFS worker's sync access handle wrote exactly the same
byte count with `flush()` per chunk. Chunks arrive per timeslice (2 chunks for 3 s here), so
"data on disk within seconds" holds. Still to verify in a real Chrome by the human: QuickTime
plays and seeks the fragmented MP4 (LIVE_CHECKS).

Harness detail: with `--auto-select-tab-capture-source-by-title` the headless run still captured
a virtual screen (`screen:-3:0`) with "Fake audio", not the target tab. Good enough for the
pipeline; if a test ever needs true tab capture, try `--auto-select-desktop-capture-source` or a
headed run.

## parakeet

**Question:** Does parakeet.js load Parakeet TDT 0.6B v3 (fp16 encoder on WebGPU, int8 decoder on WASM) inside the extension origin under our CSP and COOP/COEP headers, with the ONNX WASM binaries served from `dist/vendor/ort/`, and transcribe a WAV correctly? How fast?

**Answer (2026-09-24, headless Chromium, extension origin, Apple Silicon 16 threads):** it works,
with one constraint. `crossOriginIsolated` is true so ORT runs 16 WASM threads; WebGPU is
available with `shader-f16`. Transcription of the 7.7 s fixture was word-perfect in every variant,
with sentence timestamps. Measured (fixture is short, so treat the ratios as a floor):

| Variant | Download | Load (cached) | Transcribe 7.7 s | Speed |
|---|---|---|---|---|
| `wasm`, encoder int8 | 652 MB | 8 s | 1.31 s | ~6× real time |
| `webgpu`, encoder fp32 as external data (`encoder-model.onnx` + `.onnx.data`) | 2.4 GB | ~10 s | 0.99 s | ~8× real time |
| `webgpu`, encoder fp16 single file | 1.24 GB | fails | | `std::bad_alloc` creating the session |

The fp16 file is one 1.24 GB protobuf; ORT copies it into the 32-bit WASM heap and parses it into
a second copy, which overflows the 4 GB ceiling. The fp32 export ships its weights as *external
data*, which ORT loads without the protobuf copy, so even at 2.4 GB it fits. An fp16 external-data
export would likely be the best WebGPU option (issue filed). Decoder int8 on WASM in all cases.

Ruling recorded in DECISIONS: default `wasm` + int8 (small download, no GPU dependence, fast
enough), `webgpu` + fp32 external data as a Settings option.
