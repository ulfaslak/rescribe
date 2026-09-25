# Deferred

Technical items intentionally postponed: tech debt, hardening shortcuts, known limitations, cleanup. Each entry has **What**, **Why deferred** and a concrete **Trigger**. Not for features: those are GitHub issues.

Remove an entry in the PR that resolves it.

---

### The loaded model stays in memory for the life of the app tab

**What**: `app/pipeline.ts` keeps one `Transcriber` (one worker, the model loaded) after the first transcription; ARCHITECTURE § Runtime topology says the worker lives as long as the app tab. The pinned tab lives all day, so the int8 model's working set (about 1 GB on WASM) stays resident between calls. Freeing it after an idle period costs a reload from the cache (seconds) on the next recording.
**Why deferred**: no measurement of the resident size in Brave yet, and reloading per recording would slow every transcript.
**Trigger**: the human notices the Rescribe tab's memory in Brave's task manager, or a transcription fails with an out-of-memory after a long day.

### Adapter events on the picker path are not tied to a tab

**What**: a toolbar recording captures one tab, and `app.ts` drops adapter messages from any other tab. A picker recording (a window, the whole screen) has no tab id, so a Meet call speaking in another tab lands in its `events.jsonl` and names its display turns (its diagnostics are dropped unless that tab already contributed events).
**Why deferred**: the picker path cannot know which tab the shared window belongs to; the only Meet-while-recording-something-else case is unusual.
**Trigger**: a narrated screen recording gets Meet names in its transcript. Then: a per-recording switch ("use Meet events") in the Record section, or match the shared window's title to a Meet tab.

### Self tile without a microphone

**What**: the human's own Meet tile is found by its overlap with microphone speech (DECISIONS § Audio channels). A recording without a mic channel (microphone denied or off, or a re-run after the mic's recogniser output was deleted with the media) falls back to the label rule, and Meet named the tile by full name on 2026-09-25: the human's speaking then leaks into display evidence under that name, and with one remote the one-remote rule builds on it. Fix: a `self: true` flag on the `speaker` message from a structural mark of the self tile (Meet renders the self view twice, grid tile plus thumbnail with the same id; `data-self-name` is an unverified candidate), or a Settings field for the Meet display name.
**Why deferred**: every recording so far had a microphone, and a no-mic call is a recording of other people only, which the human has not asked for.
**Trigger**: a transcript of a no-mic recording shows the human's Meet name on display turns, or the calibration mode reports which attribute marks the self tile.

### The roster carries names, not ids

**What**: `roster` messages list display names (`src/content/meet.ts` `poll()` dedupes them), so two remote participants with the same display name are one roster entry, and `eventsToEvidence` folds a roster name onto the speaking id of that name: a silent namesake is neither a participant nor a second remote, and with one other person the one-remote rule labels the namesake's words with the shared name. Fix: the roster carries `{ id, name }` pairs and participants are counted by id.
**Why deferred**: two people with the same display name in one call has not happened; the change touches the message type, the adapter, the e2e harness's injected rosters and the evidence layer.
**Trigger**: a call with two participants of the same display name.

### Anchor platform stamps to the audio clock

**What**: segment times will come from the 16 kHz sample count (the audio clock) while platform events are stamped with `Date.now()` (the wall clock). `src/lib/clock.ts` converts with one `startedAt` anchor, so any drift between the two clocks grows through the call: 30 ppm over 3 h is 0.32 s, the whole 0.2–0.4 s safe band of `MEET_LEAD`. Fix: the recorder logs `(Date.now(), sampleIndex)` anchors periodically and `clock.ts` interpolates between them.
**Why deferred**: the first long recording (58 min, 2026-09-25) showed no drift: the best shift between Meet's intervals and the remote speaker's speech was +0.25 s in the first ten minutes and +0.10 s in the last, so the wall clock and the audio clock agree within the band on this machine.
**Trigger**: the first transcript of a call over an hour shows handover misattribution concentrated late in the call (the LIVE_CHECKS entry on `MEET_LEAD` samples the end of the call for this reason).
