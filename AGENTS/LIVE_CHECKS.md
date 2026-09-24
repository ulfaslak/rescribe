# Live checks

Verification that only a real call, the human's own Chrome, or a real file on disk can provide. Each entry has a **Trigger**, exact **Steps**, **Success criteria** and **On failure**. Run entries whose trigger has fired; remove them when they pass; fix forward when they fail.

Agents queue entries here when their PR's behaviour cannot be exercised by the e2e harness (fake devices, no Meet). This is the project's counterpart to a post-deploy verification list.

---

### WebGPU transcription runs on the GPU in Brave

**Trigger**: the backend setting exists in the human's Brave (part 2 of #2 merged).
**Steps**: Settings → backend WebGPU; transcribe a recording with the app tab's DevTools console open (the worker's messages show there). Look for `[Parakeet.js] Creating ONNX sessions with execution mode 'webgpu-hybrid'` and for any ORT warning that says it is *removing* the `webgpu` execution provider. Note the transcription time, then repeat with WASM on the same recording.
**Success criteria**: a transcript, no fallback warning, WebGPU faster than WASM. Headless Chromium has WebGPU (ENVIRONMENT_NOTES) and `e2e/transcribe.spec.ts` covers it with `RESCRIBE_E2E_WEBGPU=1`; Brave gates GPU features differently, so only the real browser settles it.
**On failure**: keep WASM as the default (it is), file a bug with the console output.

### The first real MP4 plays and seeks in QuickTime

**Trigger**: the first recording made with the real extension in the human's Chrome (vertical slice merged).
**Steps**: open `recording.mp4` from the export folder in QuickTime Player and in Finder's preview; scrub to the middle; check the duration shown.
**Success criteria**: plays with audio, scrubbing works, duration matches the recording. MediaRecorder writes a *fragmented* MP4 (see `spikes/README.md`), which is what this check is about.
**On failure**: remux on export (a `moov`-first, non-fragmented MP4) becomes a task; file it as a bug with the symptom.
