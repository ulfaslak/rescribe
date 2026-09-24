# Live checks

Verification that only a real call, the human's own Chrome, or a real file on disk can provide. Each entry has a **Trigger**, exact **Steps**, **Success criteria** and **On failure**. Run entries whose trigger has fired; remove them when they pass; fix forward when they fail.

Agents queue entries here when their PR's behaviour cannot be exercised by the e2e harness (fake devices, no Meet). This is the project's counterpart to a post-deploy verification list.

---

### Validate the Meet speaking signal, solo, then with a second person

**Trigger**: the human is in a Google Meet call (alone is fine for the first pass) with an agent session open. Calibration v2 shipped 2026-09-24; the first solo run (v1) is what identified the meter element.
**Steps**:
1. Reload the extension at `brave://extensions` after a fresh `npm run build` on `main`, then reload the Meet tab. The console must show `[rescribe] Meet adapter loaded`.
2. In the Meet tab's DevTools console run `postMessage({ rescribe: 'calibrate', seconds: 60 }, '*')`. Allow the microphone if asked (the report uses your own mic level as ground truth).
3. Talk for about 10 seconds, stay silent for about 10, repeat. With a second person, alternate.
4. Copy the printed `calibration report` object and paste it to the agent.
**Success criteria**: for your own tile, `speakingVsMic.speaking.meanMic` is several times `speakingVsMic.silent.meanMic`, and `speaking.pct` is roughly the share of time you talked. `nameGuess` is `You` or your name, not a menu label. With a second person, `speaker` events in the Rescribe tab's console name the right person when they talk. `media` lists the page's audio elements with their track ids, which is data for a possible per-participant audio signal later.
**On failure**: if `meterFound` is false, Meet changed the meter's `jsname`: pick the toggling element from `meterStates`/`nameCandidates` and update `METER_SELECTOR`. If the mic correlation is flat, the meter is not an audio meter after all: revert to roster-only and file a bug with the report attached.

### The first real MP4 plays and seeks in QuickTime

**Trigger**: the first recording made with the real extension in the human's Chrome (vertical slice merged).
**Steps**: open `recording.mp4` from the export folder in QuickTime Player and in Finder's preview; scrub to the middle; check the duration shown.
**Success criteria**: plays with audio, scrubbing works, duration matches the recording. MediaRecorder writes a *fragmented* MP4 (see `spikes/README.md`), which is what this check is about.
**On failure**: remux on export (a `moov`-first, non-fragmented MP4) becomes a task; file it as a bug with the symptom.
