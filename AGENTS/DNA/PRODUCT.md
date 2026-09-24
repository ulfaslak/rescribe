# Product

## Vision

Press one button before a call. After the call, find a folder with the video and a transcript that says who said what. Nothing leaves the machine. That's it.

The human is Ulf: runs many Google Meet calls (consulting, PyMC Labs, Lawcel), sometimes Teams, wants transcripts as raw material for later work with agents. He records his own screen with narration sometimes. He does not want workflows hard-coded: Meet calls, Teams calls and narrated screen recordings must all fall out of one mechanism (sources in, assets out).

## The two assets

Every recording produces, in the folder chosen in Settings, under a per-recording directory named by the path template:

- `recording.mp4`: the captured video with a mixed audio track (everyone plus the microphone).
- `transcript.md`: speaker-attributed turns with timestamps, readable as-is.
- `transcript.json`: the same data with word timings, channels, and the evidence used for each attribution, for programmatic use.
- `meta.json`: when, what was captured, the participant roster if a platform adapter saw one, model and version used.

## Feature inventory

### Shipped

- Repository scaffold, build, test harness (2026-09-24). No user-facing feature yet.
- Meet speaker adapter (2026-09-24): on meet.google.com the extension knows who is speaking when and who is present, validated in a two-person call. Nothing consumes the events yet; that lands with transcription (#2) and #3.
- Vertical slice (2026-09-24): the toolbar button records the current tab plus the microphone, "Record screen…" in the Rescribe tab records a tab, window or screen through Chrome's picker; both stream video and the two audio channels to OPFS as they happen, and Stop (or the share ending) exports `recording.mp4` (or `.webm`) into `<template>/` in the chosen folder and lists the recording as `recorded` with each channel's level; a recording interrupted by the tab closing is recovered from disk on the next open, and one that could not be saved to the folder offers **Save now**. One Rescribe tab owns everything; a second one only offers to take you to the first. Verified with fake devices in headless Chromium; the toolbar path in the human's Brave is a pending live check.
- Recording library (2026-09-24): every recording is a row with an editable title (renaming never renames the exported folder), date, duration, sources, status, folder path, channel levels and local size; a row offers **Re-export** (writes the video and any transcript files still in local storage into the folder again, recreating it if it was deleted), **Delete media** (frees the video and audio in local storage, keeps the record and the exported files) and **Delete** (record and local files; the exported files stay), each deletion an in-page two-step click; a running recording's row ticks; the section shows the local storage total with one button that deletes the media of every exported recording. **Re-run transcription** is on each row but disabled until transcription (#2) lands.

### Planned, in order

2. **Transcription.** Per-channel Parakeet transcription after stop, with progress, producing `transcript.md` and `transcript.json` with channel-identity attribution (Me vs Speaker).
3. **Meet adapter.** Content script on meet.google.com emitting speaker intervals and the roster; calibrated in a live call with the human.

### Later

- Diarization model for the display channel (several remote speakers without platform metadata).
- Teams (browser) adapter.
- Live transcription during the call.
- Opt-in Meet captions adapter for speaker timing.
- Silero VAD replacing the energy gate.

## Non-goals

- Cloud anything: sync, accounts, sharing links.
- Editing video.
- Summaries or LLM post-processing inside the extension. The transcript is the raw material; what happens next is up to the human's other tools.
