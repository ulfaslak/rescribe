# Deferred

Technical items intentionally postponed: tech debt, hardening shortcuts, known limitations, cleanup. Each entry has **What**, **Why deferred** and a concrete **Trigger**. Not for features: those are GitHub issues.

Remove an entry in the PR that resolves it.

---

### WebM exports carry no duration header

**What**: a MediaRecorder WebM is a live stream: the header has no `Duration` element, so `ffprobe` reports none and players show an unknown length until they parse the whole file. The MP4 path is unaffected (fragmented MP4 with `mfra`; see the QuickTime live check).
**Why deferred**: WebM is the non-default container; remuxing on export means shipping a muxer.
**Trigger**: the human uses WebM and a player refuses to seek, or a downstream tool needs the duration.

### `meta.json` is not written on stop

**What**: PRODUCT lists `meta.json` (when, what was captured, roster, model) among the assets; the vertical slice writes only the video on stop.
**Why deferred**: half of its content (roster, model and version) exists only once #2 and #3 land; one write at transcription completion beats two.
**Trigger**: the transcription PR (#2) writes it alongside `transcript.md`.

### Self tile identified structurally by the adapter

**What**: `src/content/meet.ts` emits the human's own tile like any other participant; `eventsToEvidence` (`src/lib/evidence.ts`) recognises it only by its display label (`selfNames`, default `['You']`). A non-English Meet UI ("Du", "Vous") or a self tile whose name did not resolve (the adapter then sends the id as the name; such intervals are labelled with `unresolvedLabel`) leaks the human's own speaking into display evidence. The fix is a `self: true` flag on the `speaker` message set from a DOM attribute of the self tile.
**Why deferred**: no live observation yet of which attribute marks the self tile (`data-self-name` is a candidate, unverified), and the calibration on 2026-09-24 showed "You" on the human's tile, so the default holds for his account.
**Trigger**: the next calibration run reports which attribute marks the self tile. Then: adapter sets `self`, `eventsToEvidence` keys on it, `selfNames` goes.

### Anchor platform stamps to the audio clock

**What**: segment times will come from the 16 kHz sample count (the audio clock) while platform events are stamped with `Date.now()` (the wall clock). `src/lib/clock.ts` converts with one `startedAt` anchor, so any drift between the two clocks grows through the call: 30 ppm over 3 h is 0.32 s, the whole 0.2–0.4 s safe band of `MEET_LEAD`. Fix: the recorder logs `(Date.now(), sampleIndex)` anchors periodically and `clock.ts` interpolates between them.
**Why deferred**: no recording exists yet to measure the drift, and short calls sit well inside the band.
**Trigger**: the first transcript of a call over an hour shows handover misattribution concentrated late in the call (the LIVE_CHECKS entry on `MEET_LEAD` samples the end of the call for this reason).
