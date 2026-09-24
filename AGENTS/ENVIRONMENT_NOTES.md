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

### Playwright

Chromium for Playwright 1.63 is installed in `~/Library/Caches/ms-playwright/`. The e2e profile `.playwright/profile/` caches the Parakeet model files the spikes have requested (about 4 GB after the kickoff runs: int8, fp16 and fp32 encoders); see [[DEVELOPMENT]] § "The e2e harness". Two Playwright runs cannot share the profile at once (Chromium locks the user-data-dir): run e2e specs sequentially.

Verified 2026-09-24 in headless Chromium with the extension loaded: `crossOriginIsolated` is true (the manifest's COOP/COEP keys work in extension pages), so `SharedArrayBuffer` and multithreaded WASM are available; WebGPU is available with `shader-f16` (Apple, metal-3); the fake microphone plays `e2e/fixtures/speech.wav`. Downloads from huggingface.co ran at well over 40 MB/s.

Playwright empties `test-results/` at the start of every run. Anything a test wants to keep for inspection goes under `.playwright/out/`.

### Claude in Chrome

The Claude browser extension was not connected in the kickoff session, so browser-automation MCP tools may be unavailable. Playwright is the reliable way to drive the extension; use it.

### Headless Chrome probes

`Google Chrome --headless=new --dump-dom file.html` works for feature probes but **hangs on `navigator.gpu.requestAdapter()`**; give it `--virtual-time-budget` and a short timeout, or don't request an adapter.

### The gtr post-create hook has not run

`.gtrconfig` declares `postCreate = npm install` and `git gtr config list` shows it, but the first four worktrees came up without `node_modules`. Until diagnosed, run `npm install` in a fresh worktree yourself. Remove this note when a worktree comes up installed.

### The capture spike can die when it runs after the Meet adapter spec (2026-09-24, cause unknown)

Observed in the `feat-meet-evidence-layer` worktree while two other agents were also running e2e on this Mac: `npm run e2e` failed `e2e/spikes/capture.spec.ts` in 3 of 4 full runs with `page.waitForFunction: Target page, context or browser has been closed` right after clicking `#go`, and the browser stderr carried `CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670`; the one passing full run printed no such line. Run alone (`npx playwright test e2e/spikes/capture.spec.ts`) the spike passed 5 of 5 with no display-link errors, and the other two specs together passed. The branch under test touched only `src/lib/` and `AGENTS/`, which the spike does not import. Hypotheses, none verified: the previous spec's context shutdown leaving Chromium's display path broken; the Mac's display asleep; concurrent screen capture from sibling Chromiums. If a full run fails only there, rerun the spike alone before blaming the change; if it fails alone, it is real.

