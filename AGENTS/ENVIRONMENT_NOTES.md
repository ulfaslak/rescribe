# Environment notes

Things true about this environment but not derivable from the code. Read before blaming your change for a confusing failure. Delete an entry in the PR that makes it obsolete.

---

### The human's machine (2026-09-24)

- macOS 26 (Darwin 25.6), Apple Silicon. Node 25.6, npm 11.9, `git gtr` 2.6, `gh` authenticated as `ulfaslak`.
- **The human's browser is Brave** (152.1.94, Chromium 152), loaded from `brave://extensions`. Google Chrome 152 is also installed at `/Applications/Google Chrome.app` and was used for the headless probes below; anything probed on Chrome must be re-checked on Brave before it counts. Brave disables some web APIs by default: the File System Access API needed `brave://flags/#file-system-access-api` → Enabled, done 2026-09-24. With the flag on, `showDirectoryPicker` works from the extension's app tab and the handle persists across page loads.
- `ffmpeg` and `ffprobe` are on PATH from Homebrew. Use `ffprobe` to validate recordings in tests.
- FluidVoice is installed and runs NVIDIA Parakeet (`~/Library/Application Support/FluidVoice/`), which is why Parakeet is our engine.

### What the installed Chrome supports (probed headless, 2026-09-24)

`MediaRecorder.isTypeSupported` is true for `video/mp4;codecs=avc1.42E01E,mp4a.40.2`, `video/mp4;codecs=avc1.42E01E,opus`, `audio/mp4;codecs=mp4a.40.2`, and the WebM VP8/VP9/AV1 + Opus combinations. `navigator.gpu` exists. `window.showDirectoryPicker` exists on a `file://` page and, verified by the human in Brave, works from the extension's app tab.

System audio with `getDisplayMedia` on macOS needs Chrome 141+ and macOS 14.2+ (both satisfied) and is offered for window and entire-screen sharing; tab sharing has always carried tab audio.

### MediaRecorder cadence (probed 2026-09-24, headless Chromium, extension page)

- `video/mp4` (fragmented MP4): a chunk is emitted only when a fragment closes, and a fragment closes at a keyframe. With defaults, `start(1000)` delivered the 1.2 kB header at +5 s and the first media fragment at +10 s. `videoKeyFrameIntervalDuration: 1000` makes a chunk arrive every timeslice (about 87 kB/s for a moving canvas at 2.5 Mbit/s). `video/webm` emits per timeslice regardless.
- An AudioContext (default rate and `{ sampleRate: 16000 }`) reported `running` without any user gesture in the extension's app page, with and without an active capture, in a one-off **headless** Chromium launched without `--autoplay-policy` (the e2e fixture passes `--autoplay-policy=no-user-gesture-required`, so e2e runs prove nothing about this). Headless may not apply the real policy either; the toolbar path in Brave is the check that counts (LIVE_CHECKS).
- Chrome fires `ended` on a display track when the source ends (Stop sharing, tab closed); `track.stop()` from the page does not, and the MediaRecorder keeps running.
- A file written through a sync access handle in a worker is readable with `getFile()` from another page while the handle is open, with the flushed size; the storage worker's `flush()` per write is what makes the recovery path see the data.

### A tab-capture stream id must name the app tab as its consumer (Brave, 2026-09-24)

`chrome.tabCapture.getMediaStreamId({ targetTabId })` from the service worker without `consumerTabId` produced an id that the app tab could not consume: `getUserMedia` there rejected with `AbortError: Error starting tab capture`. Chromium's `DesktopStreamsRegistry` hands a stream only to the render process it was registered for; for an MV3 service-worker caller that is the worker's own process, and the app tab runs in another one because its COOP/COEP headers make it cross-origin isolated. `consumerTabId: <app tab id>` binds the id to the app tab's frame instead. The registered id lives 10 s. The e2e harness cannot press the toolbar button, so this path is a [[LIVE_CHECKS]] entry; the failure was seen by the human on the first real click.

### Playwright

Chromium for Playwright 1.63 is installed in `~/Library/Caches/ms-playwright/`. The e2e profile `.playwright/profile/` caches the Parakeet model files the spikes and the transcribe spec have requested (about 4 GB after the kickoff runs: int8, fp16 and fp32 encoders); see [[DEVELOPMENT]] § "The e2e harness". Two Playwright runs cannot share the profile at once (Chromium locks the user-data-dir): run e2e specs sequentially.

Verified 2026-09-24 in headless Chromium with the extension loaded: `crossOriginIsolated` is true (the manifest's COOP/COEP keys work in extension pages), so `SharedArrayBuffer` and multithreaded WASM are available; WebGPU is available with `shader-f16` (Apple, metal-3); the fake microphone plays `e2e/fixtures/speech.wav`. Downloads from huggingface.co ran at well over 40 MB/s.

Playwright empties `test-results/` at the start of every run. Anything a test wants to keep for inspection goes under `.playwright/out/`.

`showDirectoryPicker` cannot be driven, so `e2e/record.spec.ts` stores an OPFS directory handle (`export-test/`) under `handles/export` in IndexedDB: it is a real `FileSystemDirectoryHandle`, the export code runs unchanged, and the test reads the exported file back through OPFS. `--auto-select-tab-capture-source-by-title` in headless mode still captures a virtual screen (`screen:-3:0`) with fake audio rather than the target tab; fine for the pipeline.

### A reused Playwright profile runs the old service worker

Chromium keeps an installed extension's service worker script in `<profile>/Default/Service Worker/` and, when the manifest version has not changed, serves that copy at the next launch instead of re-reading `dist/background.js` (found 2026-09-24, #18: a rebuilt worker's new message handler never ran while its old handlers did). Extension pages and content scripts are not affected. `e2e/fixtures.ts` deletes that directory before every launch; the model cache lives in IndexedDB and survives. `PW_PROFILE=<dir>` points a run at another profile (a fresh one is the cleanest control when a service worker change looks ignored).

### Claude in Chrome

The Claude browser extension was not connected in the kickoff session, so browser-automation MCP tools may be unavailable. Playwright is the reliable way to drive the extension; use it.

### Headless Chrome probes

`Google Chrome --headless=new --dump-dom file.html` works for feature probes but **hangs on `navigator.gpu.requestAdapter()`**; give it `--virtual-time-budget` and a short timeout, or don't request an adapter.

### The gtr post-create hook has not run

`.gtrconfig` declares `postCreate = npm install` and `git gtr config list` shows it, but the first four worktrees came up without `node_modules`. Until diagnosed, run `npm install` in a fresh worktree yourself. Remove this note when a worktree comes up installed.
