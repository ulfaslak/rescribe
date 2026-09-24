# Live checks

Verification that only a real call, the human's own Chrome, or a real file on disk can provide. Each entry has a **Trigger**, exact **Steps**, **Success criteria** and **On failure**. Run entries whose trigger has fired; remove them when they pass; fix forward when they fail.

Agents queue entries here when their PR's behaviour cannot be exercised by the e2e harness (fake devices, no Meet). This is the project's counterpart to a post-deploy verification list.

---

### The first real MP4 plays and seeks in QuickTime

**Trigger**: the first recording made with the real extension in the human's Chrome (vertical slice merged).
**Steps**: open `recording.mp4` from the export folder in QuickTime Player and in Finder's preview; scrub to the middle; check the duration shown.
**Success criteria**: plays with audio, scrubbing works, duration matches the recording. MediaRecorder writes a *fragmented* MP4 (see `spikes/README.md`), which is what this check is about.
**On failure**: remux on export (a `moov`-first, non-fragmented MP4) becomes a task; file it as a bug with the symptom.

### Meet's indicator lead of 0.3 s labels short utterances at handovers correctly

**Trigger**: the first real Meet call transcribed with platform evidence wired in (the PR that feeds `eventsToEvidence` into `attribute()`).
**Steps**: in `transcript.md`, find five handovers where the new speaker opens with a short utterance ("Yes", "Right", a name) and five where the previous speaker closes with one. Check each against the video.
**Success criteria**: the short utterances carry the right name in both directions.
**On failure**: openers credited to the previous speaker mean the indicator lags more than 0.3 s: raise `MEET_LEAD` in `src/lib/evidence.ts`. Closers credited to the next speaker mean it lags less: lower it. The `makeCall` fixture in `src/lib/attribution.test.ts` puts the safe range at 0.2–0.4 s for a 200–400 ms onset lag; measure the real lag from `events.jsonl` against the video before picking a new value.
