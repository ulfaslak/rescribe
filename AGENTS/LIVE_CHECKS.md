# Live checks

Verification that only a real call, the human's own Chrome, or a real file on disk can provide. Each entry has a **Trigger**, exact **Steps**, **Success criteria** and **On failure**. Run entries whose trigger has fired; remove them when they pass; fix forward when they fail.

Agents queue entries here when their PR's behaviour cannot be exercised by the e2e harness (fake devices, no Meet). This is the project's counterpart to a post-deploy verification list.

---

### Calibrate the Meet adapter

**Trigger**: the human is in a Google Meet call with at least one other participant, with an agent session open.
**Steps**:
1. On the Meet tab, open DevTools → Console, run `postMessage({ rescribe: 'calibrate', seconds: 60 }, '*')`.
2. Over the next 60 seconds, have at least two different people speak, with pauses.
3. Copy the console summary (it lists the participant tiles found, the names guessed, and every attribute/class that toggled per tile with its toggle count and timing) and paste it to the agent.
**Success criteria**: the agent can name one selector per tile that toggles exactly when that participant speaks, writes it into `SPEAKING_SELECTORS` in `src/content/meet.ts`, and after a reload the Rescribe tab's console shows `speaker` events matching who talked.
**On failure**: the adapter stays in calibration-only mode (emits roster, no speaking events) and the transcript falls back to channel identity ("Me" / "Speaker").

### The first real MP4 plays and seeks in QuickTime

**Trigger**: the first recording made with the real extension in the human's Chrome (vertical slice merged).
**Steps**: open `recording.mp4` from the export folder in QuickTime Player and in Finder's preview; scrub to the middle; check the duration shown.
**Success criteria**: plays with audio, scrubbing works, duration matches the recording. MediaRecorder writes a *fragmented* MP4 (see `spikes/README.md`), which is what this check is about.
**On failure**: remux on export (a `moov`-first, non-fragmented MP4) becomes a task; file it as a bug with the symptom.
