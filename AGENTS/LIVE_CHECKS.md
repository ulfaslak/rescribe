# Live checks

Verification that only a real call, the human's own Chrome, or a real file on disk can provide. Each entry has a **Trigger**, exact **Steps**, **Success criteria** and **On failure**. Run entries whose trigger has fired; remove them when they pass; fix forward when they fail.

Agents queue entries here when their PR's behaviour cannot be exercised by the e2e harness (fake devices, no Meet). This is the project's counterpart to a post-deploy verification list.

---

### Validate the Meet speaking signal with a second person

**Trigger**: the human is in a Google Meet call with at least one other participant, with an agent session open. The solo pass succeeded 2026-09-24: on the human's own tile the meter's idle class state sat at mic RMS 0.002 and the moving states at 0.026–0.059, the adapter's speaking share was 45% against roughly 50% talk time, and the name came from `span.notranslate`.
**Steps**:
1. Reload the extension at `brave://extensions` after a fresh `npm run build` on `main`, then reload the Meet tab. The console must show `[rescribe] Meet adapter loaded`.
2. In the Meet tab's DevTools console run `postMessage({ rescribe: 'calibrate', seconds: 60 }, '*')`. Allow the microphone if asked.
3. Alternate: the other person talks about 10 seconds, pause, you talk about 10 seconds, pause, repeat. Note roughly who spoke when.
4. Copy the printed `calibration report` object and paste it to the agent.
**Success criteria**: `adapterEvents` contains `speaker` on/off pairs whose `name` and `at` (seconds into the run) match who actually spoke; the other person's tile has `meterFound: true` and its `meterStates` move while they talk; `nameGuess` is right for both tiles. Bonus data: `media` lists audio elements with track ids, which may allow a per-participant audio signal later.
**On failure**: if the remote tile's meter never changes while they talk, Meet renders remote audio levels elsewhere; use the report's `meterStates`/`nameCandidates` to find the moving element and update `METER_SELECTOR`. Fallback known from the solo run: the meter carries `sxlEM` plus a level class while audio flows and reads `DYfzY cYKTje gjg47c` when idle.

### The first real MP4 plays and seeks in QuickTime

**Trigger**: the first recording made with the real extension in the human's Chrome (vertical slice merged).
**Steps**: open `recording.mp4` from the export folder in QuickTime Player and in Finder's preview; scrub to the middle; check the duration shown.
**Success criteria**: plays with audio, scrubbing works, duration matches the recording. MediaRecorder writes a *fragmented* MP4 (see `spikes/README.md`), which is what this check is about.
**On failure**: remux on export (a `moov`-first, non-fragmented MP4) becomes a task; file it as a bug with the symptom.
