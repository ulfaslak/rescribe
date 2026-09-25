# Decisions

Flat lookup of rulings, organized by domain. A short "not X" clause is allowed where the rejected alternative is tempting; longer rationale does not belong here. Rulings dated 2026-09-24 come from the kickoff session with the human.

## Form factor

Chrome extension, Manifest V3, loaded unpacked from `dist/`. Not a web app: only a content script can read Meet's speaker signals.
One full-tab app page (`app/app.html`) hosts recording, the library, settings and all processing. Not an offscreen document: the tab can show pickers, use WebGPU and be debugged. The tab warns on close while recording or processing.
The toolbar button is the primary control. One click on a tab opens the **start dialog**, a small popup window (`src/start/`) with the tab it will record, a microphone selector, the save folder (changeable there) and one Start Capture button; the button again, or Escape, closes it and nothing records until Start. Not a start on the click itself: a click meant to see what Rescribe was doing started a recording while the previous one transcribed (2026-09-25, the human). While recording, the badge shows `REC` and clicking the button opens the **stop dialog**, a small popup window (`src/stop/`) with Save, Save as… and Discard; closing the dialog keeps recording. Not the app tab: the human is in the call and wants a decision, not a page (2026-09-25, the human). Not action popups (`action.default_popup`): Chrome opens one only from a click and closes it under a folder picker; popup-type windows can be opened when the call ends and host the pickers and the permission prompt.
A click leaves the human where they are, on a call platform tab (Meet; `src/lib/platform.ts` says which URLs count) or any other: the app tab opens, or stays, in the background; the dialogs and the badge are the feedback. It comes forward on its own only when a start needs the human: a microphone permission prompt (Chrome shows it only for a visible tab), a start that failed inside the app tab, a second Start while one is pending. A Start that cannot get the tab (`getMediaStreamId` refused) is answered in the dialog, not by a page. Not a stop: a click while recording opens the stop dialog wherever it lands and the app tab stays where it is (2026-09-24, the human: hitting record in Meet must not leave Meet; 2026-09-25: with the dialog there is no reason left to surface the app tab on any tab).
After a save in the stop dialog, a **processing tab** (`src/progress/`) opens in the browser window (the dialog stays until the export answers, then closes): it follows that recording's export and transcription to the end and can be closed at any time, since the app tab, pinned in the background, does the work. Not the app tab brought forward: closing it would stop the work. Not a badge: the toolbar shows nothing while a transcription runs; the tab is the feedback (2026-09-25, the human). A save from the app tab (Stop, a row) opens no tab: the row shows the progress.
While the app tab lives, a recording ends only by the human's decision (Save, Save as…, Discard; Stop in the app tab is Save in one click) or by its stream dying. The Meet call ending (the adapter's `call-ended`) opens the stop dialog and keeps recording until the human answers, so a rejoin loses nothing. A stream that dies (Stop sharing, the captured tab closed) leaves the recording `stopped`: the dialog opens, the badge says `SAVE`, the row offers the same three choices, and nothing is exported or transcribed until one is taken. Not the automatic export of before: what becomes of a recording is the human's call, and Discard must be able to leave no trace (2026-09-25). A Save without a folder chosen picks one first (and makes it the Settings folder); it never ends as "recorded, not exported".
A recording interrupted by a crash or a closed app tab is the exception: recovered on the next open and exported to the Settings folder without asking (`recoverInterrupted`), because nobody was there to ask and the row's Save now and Delete cover the rest.
A recording waiting `stopped` never blocks a new one: the toolbar button on a call starts recording as if idle, and the waiting one keeps its row (and its dialog, from a click on the app tab). Not a gate: a missed call costs more than a decision postponed, the same ruling as for transcription (2026-09-25, adversarial review of #24).
A keyboard command (`toggle-recording`) mirrors the button.
Transcription never blocks recording: `query-status` answers the recorder's state, so Start Capture starts a new recording while the previous one transcribes and the pipeline queues it; the start dialog says what runs in the background. Not a lock: a missed call costs more than a later transcript.
Recording anything other than the current tab (a window, the whole screen) starts from the app tab, through Chrome's own picker.

## Capture

`getDisplayMedia` is the universal capture primitive for screen/window/tab from the app tab; `chrome.tabCapture` (no picker) is the one-click path from the toolbar button. Both produce the same `Source` and feed the same recorder.
The microphone is captured with `getUserMedia` in the app tab, independently of the display stream, and is optional per recording. Which one is a setting (`micDeviceId`), chosen in the start dialog and used on both paths; the default device when none is set or the chosen one is gone. Not a per-recording prompt: the choice is what the human picked last, shown before every Start.
Audio for the video file is mixed in the app tab with the Web Audio API; the mix exists only for playback.
Video and audio are encoded by `MediaRecorder`. No WebCodecs, no ffmpeg in the browser.

## Audio channels and speaker attribution

The microphone and the display audio are separate **channels**, kept apart all the way to the transcript. Each channel is transcribed on its own.
Speaker attribution is layered **evidence** resolved by one pure function (`src/lib/attribution.ts`). Every layer emits `SpeakerInterval`s in recording-relative seconds. Layers, in priority order: platform events (Meet/Teams DOM) > diarization model (later) > channel identity (mic = the human, display = "Speaker") > nothing.
The human's own platform tile is identified by evidence, not by its label: the participant whose speaking coincides with microphone speech (at least half of its speaking time, over at least five seconds; `src/lib/evidence.ts`) is the human, its intervals are not display evidence (the display channel never carries the human's voice) and it is listed under "my name"; exactly one tile may qualify (two that do, a colleague in the same room on their own laptop, are both kept); the label rule ("You") remains as the fallback for a tile that spoke too little to judge and for a recording without a microphone channel, where the leak of 2026-09-25 stands (DEFERRED § "Self tile without a microphone"). Not by Meet's label: Meet showed "You" on 2026-09-24 and the full name on 2026-09-25, when two thirds of the remote speaker's words in a 58-minute call were labelled as the human. Not by a DOM attribute of the self tile: none has been observed, and the microphone is ground truth on every platform.
With exactly one remote tile of substance, counted per tile (an unresolved name or a rejoin under a new id counts too) and only when the log holds a roster to vouch for who was there, the display channel's identity is that participant rather than "Speaker": everything the display carries is their voice, and Meet's indicator misses most of a listener's short replies while the human talks (181 of 304 remote segments in the call of 2026-09-25). With two or more, none known, or no roster line, the generic label stays; the Meet adapter re-sends the roster every 30 s so a recording started into a stable call holds one. A participant is a tile of substance: it spoke for the indicator's minimum duration, or was on screen for ten seconds of roster time (half the recording when that is shorter); Meet's flashes for a shared screen or a status ("You are presenting") are nobody.
Platform adapters are content scripts, one per platform, isolated in `src/content/`. They ship with a calibration mode because platform markup is obfuscated and changes.
On Meet, "speaking" is derived from the tile's audio meter *changing* (class list flipped within 700 ms, `src/lib/activity.ts`), never from what a particular class means. Meet's level classes are opaque and renamed at will; motion is not.
Scraping Meet's live captions is not the default (it leans on Google's cloud speech recognition). It may become an opt-in adapter.
Model-based diarization of the display channel is a later layer, not v1. The evidence interface exists from day one so adding it is a new emitter, not a redesign.

## Speech recognition

Engine: NVIDIA Parakeet TDT 0.6B **v3** (multilingual, incl. Danish and English, word timestamps) via `parakeet.js`. Not Whisper: Parakeet is what FluidVoice runs and the quality the human already trusts.
Default runtime configuration: `backend: 'wasm'`, encoder int8, decoder int8, multithreaded (the extension is cross-origin isolated). Optional in Settings: `backend: 'webgpu'` with the fp32 external-data encoder. The single-file fp16 encoder is not offered: it does not fit the 32-bit WASM heap (the parakeet spike, 2026-09-24: ORT copies the 1.24 GB protobuf into the heap and parses a second copy; the fp32 export ships its weights as external data and fits).
The engine sits behind a small interface (`src/lib/asr/engine.ts`, planned) so sherpa-onnx or Whisper can be added without touching the pipeline.
Silence gating (VAD) runs before recognition on every channel. Energy-based first, Silero later.
The only permitted network traffic is the one-time model download from huggingface.co, cached in the browser. Never a CDN for runtime code: the ONNX WASM binaries ship inside `dist/vendor/ort/`.
No language setting. Parakeet v3 handles the language itself.
Transcription runs after the recording stops, in a Worker, not live. Live transcription is a later feature and the PCM already streams to disk, so it will be incremental, not a rewrite.
It starts by itself when a recording stops (Settings "Transcribe as soon as a recording stops", on by default); off, the library runs it. Recordings are transcribed one at a time, channels one after another; never two channels in the worker's queue at once, because a transcribe failure restarts the worker and fails whatever is queued behind it.

## Storage and output

During recording, data goes to the Origin Private File System (OPFS) through a worker with a sync access handle, appended as it arrives. Not straight to the user's folder: File System Access writes only commit on close.
On stop, the recording is exported to the folder the human chose in Settings (File System Access API, directory handle persisted in IndexedDB). Fallback if that API misbehaves in the extension origin: `chrome.downloads` into a subfolder of Downloads.
Output layout per recording, path template configurable in Settings, default `{date} {time} {title}/`: `recording.mp4`, `transcript.md`, `transcript.json`, `meta.json`. The folder name and the header of `transcript.md` show the start in the machine's local zone at the moment each is written (the folder at Save, the header at transcription; a machine moved between zones in between shows them apart), through one formatter; the JSON files carry epoch milliseconds. Not UTC: the human reads the header next to the folder name (a header two hours off the folder, 2026-09-25). Not an offset suffix on the header: noise for every reader to cover a re-run on another continent.
Video container: MP4 (H.264 + AAC) by default, WebM (VP9 + Opus) as an option.
Save as… puts one recording under a folder of its own (its handle under IndexedDB `handles/export:<id>`, its name on the record as `exportRoot`) and leaves the Settings folder alone; the transcript follows the video there. Not a change of the default: a one-off location is what was asked for (2026-09-25).
Transcript artifacts are written to OPFS first and exported second, and only into a directory the video already went to; a failed export leaves them in OPFS for **Save now**, which exports the video and the artifacts together. Not straight to the folder: transcription may finish long after Stop's click, when the folder's permission is gone (a restart) or no folder was ever chosen.
Settings live in `chrome.storage.local`. Recording metadata lives in IndexedDB. Media lives in OPFS until exported and, when the human says so, deleted. Deleting media removes the video and the PCM only; the transcript artifacts and the per-channel segments cache stay, so a transcript can still be exported and re-assembled. Not the whole directory: the audio is the expensive part, the transcript is what the human keeps.

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
