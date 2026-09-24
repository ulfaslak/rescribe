# Architecture

Parts marked **(planned)** describe the target shape agreed at kickoff and not yet in the code. Remove the marker in the PR that builds the part; if the built shape differs, change this file in the same PR.

## File structure

```
rescribe/
  CLAUDE.md, README.md
  AGENTS/                 persistent agent context (DNA + ledgers)
  .claude/                agents, hooks, settings for Claude Code
  scripts/build.mjs       esbuild: src/ → dist/, copies static assets and ORT wasm
  src/
    manifest.json         MV3 manifest
    background.ts         service worker: toolbar button, badge, keyboard command, tab capture ids
    app/                  the app tab: app.html, app.css, app.ts (+ panels as they grow)
      transcriber.ts      client of the transcribe worker: spawns it on first use, posts jobs as they
                          come (the worker serialises), restarts it after a transcribe failure
    content/meet.ts       Meet platform adapter (content script, IIFE bundle)
    lib/                  pure, context-free logic; unit-testable in Node, except asr/parakeet.ts,
                          which needs ORT's WASM and the model and is covered by e2e/transcribe.spec.ts
      types.ts            the data model (below)
      attribution.ts      speaker evidence → labelled segments
      transcript.ts       labelled segments → turns → markdown / json
      activity.ts         "value changed recently" detector, the Meet speaking signal
      (planned) clock.ts        wall-clock ms → recording-relative seconds, the only conversion
      (planned) pathtemplate.ts export directory name from the Settings template
      vad.ts              energy-based silence gate over 16 kHz PCM (Float32 or Int16) → voiced regions
      asr/engine.ts       the ASR engine interface (load with progress, transcribe PCM, dispose)
      asr/parakeet.ts     the parakeet.js implementation of it; ORT on WASM or WebGPU
      asr/regions.ts      region slicing and words → Segment (the worker's pure half)
    (planned) recorder/   capture graph, MediaRecorder, AudioWorklet taps (app-tab only);
                          `*.worklet.ts` files are AudioWorklet processors, each its own bundle
    (planned) storage/    OPFS store client, IndexedDB metadata, folder export (app-tab only)
    workers/              one file per worker, each its own bundle; a worker's request/response
                          types are exported from the worker file itself, not from lib/messages.ts
      (planned) storage.ts     appends video chunks and PCM blocks to OPFS (sync access handle)
      transcribe.ts       VAD → Parakeet (parakeet.js + ORT) → Segment[] for one channel
  e2e/                    Playwright: fixtures.ts (extension + fake media), privacy.ts (network watch),
                          *.spec.ts, fixtures/ (wav, fake-meet.html)
  spikes/                 throwaway experiments, see spikes/README.md
  dist/                   build output, gitignored, what Chrome loads
```

To see the current tree: `tree -I 'node_modules|dist|.playwright' -L 3`.

## Runtime topology

Four execution contexts, each with a distinct job:

| Context | File | Lifetime | Does |
|---|---|---|---|
| Service worker | `background.ts` | ephemeral, event-driven | toolbar click and keyboard command, badge, `chrome.tabCapture.getMediaStreamId` (must happen inside the click), opens/focuses the app tab, forwards nothing else |
| App tab | `app/app.ts` | while open; pinned; warns on close when busy | owns the recorder, the audio graph, OPFS writes, transcription workers, export, settings UI, library UI |
| Content script | `content/meet.ts` | per Meet page | observes the DOM, emits speaker events and roster to the extension via `chrome.runtime.sendMessage`; mirrors every message as a `rescribe:event` CustomEvent on `window` for the e2e harness (Meet's scripts cannot read the detail across worlds) |
| Storage worker **(planned)** | `workers/storage.ts` | per recording | appends video chunks and PCM blocks to OPFS through a sync access handle, flushing per write |
| Transcribe worker | `workers/transcribe.ts` | spawned on the first job, lives as long as the app tab or until a transcribe failure | VAD, then parakeet.js on WASM (default) or WebGPU; one channel per job, jobs serialised, the model kept loaded across jobs and reloaded when a job names another model or backend or after a failure |

Messages that cross `chrome.runtime` (service worker, app tab, content scripts) are typed in `src/lib/messages.ts`; the union there is the single roster of those message types. A worker's `postMessage` protocol is typed in the worker's own file and imported by its one client, so adding a worker touches no shared file.

## Data model (`src/lib/types.ts`)

- `ChannelId`: `'mic' | 'display'`. Two channels, always. A recording may have only one of them.
- `Source`: what a channel captured (`microphone`, `tab`, `window`, `screen`) plus a label.
- `Recording`: id, `startedAt`/`endedAt` (epoch ms, the only wall-clock values in the model), title, sources, status (`recording → recorded → transcribing → done | failed`), container, export path.
- `Segment`: `{ channel, start, end, text, words? }`, seconds from recording start. Output of the ASR engine, per channel.
- `SpeakerInterval`: `{ channel, speaker, start, end, source }` with `source` one of `platform | model | channel`. The unit of speaker evidence. Adapters, the diarizer and channel identity all produce these.
- `LabelledSegment`: a `Segment` plus `speaker` and the `evidence` that decided it.
- `Turn`: consecutive labelled segments by the same speaker, merged for rendering.
- `Settings`: folder handle id, path template, my name, container, mic default, model choice.

## Clock

Recording-relative seconds everywhere in `lib/`. `startedAt` is the epoch ms of the first captured sample. Content scripts stamp with `Date.now()`; the app tab converts on receipt. See [[INVARIANTS]].

## Storage **(planned)**

- **OPFS**, per recording directory `recordings/<id>/`: `video.<mp4|webm>` (MediaRecorder chunks appended), `mic.pcm` and `display.pcm` (16 kHz mono Int16, appended by the AudioWorklet taps via the storage worker), `events.jsonl` (speaker events as received).
- **IndexedDB** `rescribe`: `recordings` (the `Recording` records), `handles` (the export directory handle).
- **chrome.storage.local**: `Settings` minus the handle.
- **Export folder** (user's disk): `<template>/recording.mp4`, `transcript.md`, `transcript.json`, `meta.json`. Written on stop (video) and on transcription completion (transcript).

## Pipeline **(planned)**

1. Capture: streams → `AudioContext` graph: per-channel `AudioWorkletNode` taps at 16 kHz → storage worker; mixer → `MediaStreamAudioDestinationNode` → `MediaRecorder` with the video track.
2. Stop: finalize OPFS files, export video, mark `recorded`.
3. Transcribe: per channel, VAD → voiced regions → Parakeet → `Segment[]` with region offsets applied.
4. Attribute: `SpeakerInterval[]` from channel identity + platform events (+ model) → `attribute()` → `LabelledSegment[]`.
5. Render: `toTurns()` → `transcript.md`, `transcript.json`; export; mark `done`.

Each stage is a function over data on disk, so any stage can be re-run from the library.
