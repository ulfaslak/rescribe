# Deferred

Technical items intentionally postponed: tech debt, hardening shortcuts, known limitations, cleanup. Each entry has **What**, **Why deferred** and a concrete **Trigger**. Not for features: those are GitHub issues.

Remove an entry in the PR that resolves it.

---

### WebM exports carry no duration header

**What**: a MediaRecorder WebM is a live stream: the header has no `Duration` element, so `ffprobe` reports none and players show an unknown length until they parse the whole file. The MP4 path is unaffected (fragmented MP4 with `mfra`; see the QuickTime live check).
**Why deferred**: WebM is the non-default container; remuxing on export means shipping a muxer.
**Trigger**: the human uses WebM and a player refuses to seek, or a downstream tool needs the duration.

### The loaded model stays in memory for the life of the app tab

**What**: `app/pipeline.ts` keeps one `Transcriber` (one worker, the model loaded) after the first transcription; ARCHITECTURE § Runtime topology says the worker lives as long as the app tab. The pinned tab lives all day, so the int8 model's working set (about 1 GB on WASM) stays resident between calls. Freeing it after an idle period costs a reload from the cache (seconds) on the next recording.
**Why deferred**: no measurement of the resident size in Brave yet, and reloading per recording would slow every transcript.
**Trigger**: the human notices the Rescribe tab's memory in Brave's task manager, or a transcription fails with an out-of-memory after a long day.

### Adapter events on the picker path are not tied to a tab

**What**: a toolbar recording captures one tab, and `app.ts` drops adapter messages from any other tab. A picker recording (a window, the whole screen) has no tab id, so a Meet call speaking in another tab lands in its `events.jsonl` and names its display turns (its diagnostics are dropped unless that tab already contributed events).
**Why deferred**: the picker path cannot know which tab the shared window belongs to; the only Meet-while-recording-something-else case is unusual.
**Trigger**: a narrated screen recording gets Meet names in its transcript. Then: a per-recording switch ("use Meet events") in the Record section, or match the shared window's title to a Meet tab.

### Self tile identified structurally by the adapter

**What**: `src/content/meet.ts` emits the human's own tile like any other participant; `eventsToEvidence` (`src/lib/evidence.ts`) recognises it only by its display label (`selfNames`, default `['You']`). A non-English Meet UI ("Du", "Vous") or a self tile whose name did not resolve (the adapter then sends the id as the name; such intervals are labelled with `unresolvedLabel`) leaks the human's own speaking into display evidence. The fix is a `self: true` flag on the `speaker` message set from a DOM attribute of the self tile.
**Why deferred**: no live observation yet of which attribute marks the self tile (`data-self-name` is a candidate, unverified), and the calibration on 2026-09-24 showed "You" on the human's tile, so the default holds for his account.
**Trigger**: the next calibration run reports which attribute marks the self tile. Then: adapter sets `self`, `eventsToEvidence` keys on it, `selfNames` goes.

### Anchor platform stamps to the audio clock

**What**: segment times will come from the 16 kHz sample count (the audio clock) while platform events are stamped with `Date.now()` (the wall clock). `src/lib/clock.ts` converts with one `startedAt` anchor, so any drift between the two clocks grows through the call: 30 ppm over 3 h is 0.32 s, the whole 0.2–0.4 s safe band of `MEET_LEAD`. Fix: the recorder logs `(Date.now(), sampleIndex)` anchors periodically and `clock.ts` interpolates between them.
**Why deferred**: no recording exists yet to measure the drift, and short calls sit well inside the band.
**Trigger**: the first transcript of a call over an hour shows handover misattribution concentrated late in the call (the LIVE_CHECKS entry on `MEET_LEAD` samples the end of the call for this reason).
