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

- `video/mp4` (fragmented MP4): a chunk is emitted only when a fragment closes, and a fragment closes at a keyframe. With defaults, `start(1000)` delivered the 1.2 kB header at +5 s and the first media fragment at +10 s. `videoKeyFrameIntervalDuration: 1000` makes a chunk arrive every timeslice (about 87 kB/s for a moving canvas at 2.5 Mbit/s). `video/webm` emits per timeslice regardless: with `videoKeyFrameIntervalDuration: 10000`, 24 chunks arrived in 24 s of WebM against 3 in 24 s of MP4 (probed 2026-09-25, #27, Chromium 153 headless and Brave 152 alike).
- `video/webm;codecs=av1,opus` records in Chromium 153 and Brave 152. Fed the frames of a real Meet call (1080p, 5 fps, screen share plus webcam tiles), `videoBitsPerSecond: 300000` produced about 49 MB/h of video with the shared text legible; the same at `video/mp4;codecs=avc1` with a keyframe per second was about 250 MB/h, and the old defaults (30 fps, 2.5 Mbit/s) 956 MB for a 58-minute call. Frame rate was the next lever after the codec; resolution and slower encoder presets gave little.
- A MediaRecorder WebM has no `Duration`: a `<video>` in Chromium reports `duration` Infinity and an endless seekable range for it (seeking to a time still works); ffprobe reports no duration. With the Duration written into Info (`lib/webm.ts`) both report the value, and a WebM cut mid-write (`head -c` of a recording) still decodes everything before the cut.
- An AudioContext (default rate and `{ sampleRate: 16000 }`) reported `running` without any user gesture in the extension's app page, with and without an active capture, in a one-off **headless** Chromium launched without `--autoplay-policy` (the e2e fixture passes `--autoplay-policy=no-user-gesture-required`, so e2e runs prove nothing about this). Headless may not apply the real policy either; the toolbar path in Brave is the check that counts (LIVE_CHECKS).
- Chrome fires `ended` on a display track when the source ends (Stop sharing, tab closed); `track.stop()` from the page does not, and the MediaRecorder keeps running.
- A file written through a sync access handle in a worker is readable with `getFile()` from another page while the handle is open, with the flushed size; the storage worker's `flush()` per write is what makes the recovery path see the data.

### A tab-capture stream id must name the app tab as its consumer (Brave, 2026-09-24)

`chrome.tabCapture.getMediaStreamId({ targetTabId })` from the service worker without `consumerTabId` produced an id that the app tab could not consume: `getUserMedia` there rejected with `AbortError: Error starting tab capture`. Chromium's `DesktopStreamsRegistry` hands a stream only to the render process it was registered for; for an MV3 service-worker caller that is the worker's own process, and the app tab runs in another one because its COOP/COEP headers make it cross-origin isolated. `consumerTabId: <app tab id>` binds the id to the app tab's frame instead. The registered id lives 10 s. The e2e harness cannot press the toolbar button, so this path is a [[LIVE_CHECKS]] entry; the failure was seen by the human on the first real click.

### Playwright

Chromium for Playwright 1.63 is installed in `~/Library/Caches/ms-playwright/`. The e2e profile `.playwright/profile/` caches the Parakeet model files the spikes and the transcribe spec have requested (about 4 GB after the kickoff runs: int8, fp16 and fp32 encoders); see [[DEVELOPMENT]] § "The e2e harness". Two Playwright runs cannot share the profile at once (Chromium locks the user-data-dir): run e2e specs sequentially.

Verified 2026-09-24 in headless Chromium with the extension loaded: `crossOriginIsolated` is true (the manifest's COOP/COEP keys work in extension pages), so `SharedArrayBuffer` and multithreaded WASM are available; WebGPU is available with `shader-f16` (Apple, metal-3); the fake microphone plays `e2e/fixtures/speech.wav`. Downloads from huggingface.co ran at well over 40 MB/s.

Playwright empties `test-results/` at the start of every run. Anything a test wants to keep for inspection goes under `.playwright/out/`.

`playwright.config.ts` sets no `actionTimeout`, so a locator's `innerText`, `textContent` or `getAttribute` on an element that is not there waits for it until the test timeout (15 minutes). Fine for an assertion, fatal in a poll over a widget that comes and goes: read with `page.evaluate` and `querySelector` there (`e2e/progress.spec.ts` `text()`), and give an element screenshot its own `timeout`. Seen 2026-09-25 on #31: the walk hung after the row it watched finished.

`showDirectoryPicker` cannot be driven, so `e2e/record.spec.ts` stores an OPFS directory handle (`export-test/`) under `handles/export` in IndexedDB: it is a real `FileSystemDirectoryHandle`, the export code runs unchanged, and the test reads the exported file back through OPFS. `--auto-select-tab-capture-source-by-title` in headless mode still captures a virtual screen (`screen:-3:0`) with fake audio rather than the target tab; fine for the pipeline. That virtual screen's audio is the **same fake-device stream as the microphone** (the speech WAV), not a tone (seen 2026-09-24 in `e2e/pipeline.spec.ts`): `display.pcm` holds the fixture's speech too, so a harness transcript has an `Ulf` turn and a `Speaker` turn with the same words.

### The reused profile reopens the last run's pinned app tab

Chrome reopens pinned tabs at startup on its own, session restore or not, from `pinned_tabs`, a protected preference in the profile's `Default/Secure Preferences` (not `Preferences`); the service worker creates the app tab pinned (`ensureAppTab`). The e2e profile is reused (DEVELOPMENT § "The e2e harness"), so every launch after a test that opened the app tab through the service worker started with a ghost app tab: `chrome.tabs.query({ url })` listed it, `ensureAppTab` found it silent and reloaded it instead of creating a tab, and Playwright, which lists it as `chrome-error://chromewebdata/` and never emits `page` for it, timed out on `context.waitForEvent('page')` (found 2026-09-25 on the stop dialog PR: the toolbar routing test hung in the reused profile and passed in a fresh one; the tab list right at launch showed the ghost). `e2e/fixtures.ts` closes the app tabs through the service worker before the context closes, strips `pinned_tabs` from both preference files and deletes the session files (`Default/Sessions/`, older builds `Session_*` and `Tabs_*`) before every launch, next to the `Service Worker/` directory. A first version deleted only session files, which were not the cause, with a brace glob that Node's `globSync` does not expand; verify a cleanup by listing what it matched and the state after it. If a `page` event still never comes, run once with `PW_PROFILE=<fresh dir>` to tell the profile from the code.

### `chrome.windows.create` refuses bounds off the visible screen

Placing a window with `left`/`top` computed from another window's bounds throws `Invalid value for bounds. Bounds must be at least 50% within visible screen space` when the result is mostly off-screen: in headless Chromium the last focused window reports bounds that put a top-right popup out of the virtual screen, and on a desktop a browser window hanging half off a display does the same. `background.ts` `openStopDialog` retries without a position (Chrome's own placement) when that happens (2026-09-25).

### Chrome for Testing crashes when a popup window is removed right after Save as…

Playwright's Chromium runs with dangling-pointer detection on: removing the stop dialog's popup window (`chrome.windows.remove`, from the service worker or from the page itself) within milliseconds of Save as… (a `showDirectoryPicker` result, here the e2e stub's OPFS handle, stored into IndexedDB, and a `tabs.sendMessage` still pending) killed the whole browser with `FATAL:base/allocator/partition_alloc_support.cc Detected dangling raw_ptr in unretained` (SIGTRAP), which a test sees as `browserContext.waitForEvent: Target page, context or browser has been closed` (found 2026-09-25 on #26, three runs in a row at the same spot; Save, which stores no handle, never crashed; closing on the decision's answer, seconds later, as #24 did, never crashed). Production Chrome and Brave do not run that check. `DEBUG=pw:browser` shows the browser's stderr and the exit signal; use it whenever a test dies with "context closed". Let a dialog page finish its own work and close on an answer, not on a timer or from another context.

### A reused Playwright profile runs the old service worker

Chromium keeps an installed extension's service worker script in `<profile>/Default/Service Worker/` and, when the manifest version has not changed, serves that copy at the next launch instead of re-reading `dist/background.js` (found 2026-09-24, #18: a rebuilt worker's new message handler never ran while its old handlers did). Extension pages and content scripts are not affected. `e2e/fixtures.ts` deletes that directory before every launch; the model cache lives in IndexedDB and survives. `PW_PROFILE=<dir>` points a run at another profile (a fresh one is the cleanest control when a service worker change looks ignored).

### The faked toolbar click has no activeTab grant

`helpers.toolbarClick` calls the service worker's `onToggle` directly, so Chrome grants no `activeTab` on the tab: `chrome.scripting.executeScript` for the start dialog's overlay fails and the fallback window opens. The fixture therefore loads a copy of the build with `host_permissions: <all_urls>` (DEVELOPMENT § "The e2e harness"). Whether the real click's grant covers the injection is a live check, not something the e2e proves.

### An extension iframe inside a web page (probed 2026-09-25, headless Chromium)

An extension page in an iframe of an http(s) page, as the start dialog's overlay is: `showDirectoryPicker` throws `NotAllowedError: Third party iframes are not allowed to show a file picker`; IndexedDB and OPFS are the extension origin's own, not partitioned by the page (a handle stored by the app tab reads back); `enumerateDevices` gives labels when the iframe has `allow="microphone"` and the extension origin holds the permission; a page CSP of `default-src 'none'; frame-src 'none'` does not block it; `chrome.runtime.getContexts` lists it as a `TAB` context with the page's `tabId` and a `frameId` above 0, `documentUrl` with its query string.

### Claude in Chrome

The Claude browser extension was not connected in the kickoff session, so browser-automation MCP tools may be unavailable. Playwright is the reliable way to drive the extension; use it.

### Headless Chrome probes

`Google Chrome --headless=new --dump-dom file.html` works for feature probes but **hangs on `navigator.gpu.requestAdapter()`**; give it `--virtual-time-budget` and a short timeout, or don't request an adapter.

### The gtr post-create hook has not run

`.gtrconfig` declares `postCreate = npm install` and `git gtr config list` shows it, but the first four worktrees came up without `node_modules`. Until diagnosed, run `npm install` in a fresh worktree yourself. Remove this note when a worktree comes up installed. Still happening 2026-09-25 (`feat/in-page-start`).
