# Decisions

Flat lookup of rulings, organized by domain. A short "not X" clause is allowed where the rejected alternative is tempting; longer rationale does not belong here. Rulings dated 2026-09-24 come from the kickoff session with the human.

## Form factor

Chrome extension, Manifest V3, loaded unpacked from `dist/`. Not a web app: only a content script can read Meet's speaker signals.
One full-tab app page (`app/app.html`) hosts recording, the library, settings and all processing. Not an offscreen document: the tab can show pickers, use WebGPU and be debugged. The tab warns on close while recording or processing.
The toolbar button is the primary control: one click on a tab starts recording that tab plus the microphone; while recording, the button badge shows the state and clicking it focuses the app tab where Stop lives. Not a popup.
A keyboard command (`toggle-recording`) mirrors the button.
Recording anything other than the current tab (a window, the whole screen) starts from the app tab, through Chrome's own picker.

## Capture

`getDisplayMedia` is the universal capture primitive for screen/window/tab from the app tab; `chrome.tabCapture` (no picker) is the one-click path from the toolbar button. Both produce the same `Source` and feed the same recorder.
The microphone is captured with `getUserMedia` in the app tab, independently of the display stream, and is optional per recording.
Audio for the video file is mixed in the app tab with the Web Audio API; the mix exists only for playback.
Video and audio are encoded by `MediaRecorder`. No WebCodecs, no ffmpeg in the browser.

## Audio channels and speaker attribution

The microphone and the display audio are separate **channels**, kept apart all the way to the transcript. Each channel is transcribed on its own.
Speaker attribution is layered **evidence** resolved by one pure function (`src/lib/attribution.ts`). Every layer emits `SpeakerInterval`s in recording-relative seconds. Layers, in priority order: platform events (Meet/Teams DOM) > diarization model (later) > channel identity (mic = the human, display = "Speaker") > nothing.
Platform adapters are content scripts, one per platform, isolated in `src/content/`. They ship with a calibration mode because platform markup is obfuscated and changes.
Scraping Meet's live captions is not the default (it leans on Google's cloud speech recognition). It may become an opt-in adapter.
Model-based diarization of the display channel is a later layer, not v1. The evidence interface exists from day one so adding it is a new emitter, not a redesign.

## Speech recognition

Engine: NVIDIA Parakeet TDT 0.6B **v3** (multilingual, incl. Danish and English, word timestamps) via `parakeet.js`, encoder on WebGPU (fp16), decoder on WASM (int8). Not Whisper: Parakeet is what FluidVoice runs and the quality the human already trusts.
The engine sits behind a small interface (`src/lib/asr/engine.ts`, planned) so sherpa-onnx or Whisper can be added without touching the pipeline.
Silence gating (VAD) runs before recognition on every channel. Energy-based first, Silero later.
The only permitted network traffic is the one-time model download from huggingface.co, cached in the browser. Never a CDN for runtime code: the ONNX WASM binaries ship inside `dist/vendor/ort/`.
No language setting. Parakeet v3 handles the language itself.
Transcription runs after the recording stops, in a Worker, not live. Live transcription is a later feature and the PCM already streams to disk, so it will be incremental, not a rewrite.

## Storage and output

During recording, data goes to the Origin Private File System (OPFS) through a worker with a sync access handle, appended as it arrives. Not straight to the user's folder: File System Access writes only commit on close.
On stop, the recording is exported to the folder the human chose in Settings (File System Access API, directory handle persisted in IndexedDB). Fallback if that API misbehaves in the extension origin: `chrome.downloads` into a subfolder of Downloads.
Output layout per recording, path template configurable in Settings, default `{date} {time} {title}/`: `recording.mp4`, `transcript.md`, `transcript.json`, `meta.json`.
Video container: MP4 (H.264 + AAC) by default, WebM (VP9 + Opus) as an option.
Settings live in `chrome.storage.local`. Recording metadata lives in IndexedDB. Media lives in OPFS until exported and, when the human says so, deleted.

## Stack

TypeScript, strict. Vanilla DOM, no UI framework, no CSS framework. Not React.
esbuild bundles `src/` into `dist/`; `tsc --noEmit` type-checks; no other build tooling. Imports between source files use the `.ts` extension so Node can run tests without a build.
Dependencies are npm packages bundled by esbuild. Runtime assets that cannot be bundled (WASM) are copied into `dist/vendor/` by the build script.
Prettier formats; `.prettierrc` is the source of truth.

## Testing

Pure logic (attribution, transcript assembly, VAD, path templates) is unit-tested with Node's built-in test runner, tests colocated as `*.test.ts`.
The record-to-transcript path is end-to-end tested with Playwright driving the real extension in Chromium with fake media devices (`e2e/`).
What fake devices cannot exercise (a real Meet call, the real folder picker, QuickTime playback) is a [[LIVE_CHECKS]] entry the human runs.

## Process and tracking

Full lawcel cycle: worktree per change (`git gtr`), PR, self-test, adversarial review for pipeline diffs, mistakes ledger, merge by the agent.
GitHub Issues on `ulfaslak/rescribe` track dev work. Claim comment `🔨 Started work on this.` marks in-progress. Labels: `bug`, `enhancement`, `eventually`.
Release is manual: build `main` in the primary clone, reload the extension in Chrome.

## Naming

The product and repo are "Rescribe". The human's own speaker label defaults to "Me" and is a setting.
