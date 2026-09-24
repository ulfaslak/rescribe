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
    content/meet.ts       Meet platform adapter (content script, IIFE bundle)
    lib/                  pure, context-free logic; everything here is unit-testable in Node
      types.ts            the data model (below)
      attribution.ts      speaker evidence → labelled segments
      transcript.ts       labelled segments → turns → markdown / json
      (planned) clock.ts, vad.ts, pathtemplate.ts, asr/engine.ts, asr/parakeet.ts
    (planned) recorder/   capture graph, MediaRecorder, AudioWorklet taps (app-tab only)
    (planned) storage/    OPFS store, storage worker, IndexedDB metadata, folder export
    (planned) workers/    transcribe worker (parakeet.js + ORT), storage worker
  e2e/                    Playwright: fixtures.ts (extension + fake media), *.spec.ts, fixtures/ (wav)
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
| Content script | `content/meet.ts` | per Meet page | observes the DOM, emits speaker events and roster to the extension via `chrome.runtime.sendMessage` |
| Workers **(planned)** | `workers/*.ts` | per job | storage worker (OPFS sync access handle), transcribe worker (parakeet.js on WebGPU/WASM) |

Messages between contexts are typed in `src/lib/messages.ts`; the union there is the single roster of message types.

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
