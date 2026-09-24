# Live checks

Verification that only a real call, the human's own Chrome, or a real file on disk can provide. Each entry has a **Trigger**, exact **Steps**, **Success criteria** and **On failure**. Run entries whose trigger has fired; remove them when they pass; fix forward when they fail.

Agents queue entries here when their PR's behaviour cannot be exercised by the e2e harness (fake devices, no Meet). This is the project's counterpart to a post-deploy verification list.

---

### The first real MP4 plays and seeks in QuickTime

**Trigger**: the first recording made with the real extension in the human's Chrome (vertical slice merged).
**Steps**: open `recording.mp4` from the export folder in QuickTime Player and in Finder's preview; scrub to the middle; check the duration shown.
**Success criteria**: plays with audio, scrubbing works, duration matches the recording. MediaRecorder writes a *fragmented* MP4 (see `spikes/README.md`), which is what this check is about.
**On failure**: remux on export (a `moov`-first, non-fragmented MP4) becomes a task; file it as a bug with the symptom.

### The toolbar path records a real Meet tab in Brave

**Trigger**: the vertical slice merged and the extension reloaded at `brave://extensions`.
**Steps**: choose an export folder in the Rescribe tab. Join a Meet call (a solo test call is enough), click the Rescribe toolbar button on the Meet tab. Talk for 10 s, then click Stop in the Rescribe tab.
**Success criteria**: the badge shows `REC` and the Rescribe tab opens; you still hear the call while recording (tab capture mutes the tab unless Rescribe plays it back) and hear no echo of your own voice; the title in the list is the Meet tab's title; after Stop the list shows `recorded` with the folder path, and `<folder>/<date> <time> <title>/recording.mp4` plays with both your voice and the tab's audio. `Alt+Shift+R` does the same.
**Channel purity step**: make a second recording where you stay silent for its whole length while the tab plays someone talking (a YouTube tab is fine). The row's levels readout must show `mic` far below `display` (at least 25 dB lower; a mic that picks up the speakers through echo cancellation sits around −50 dBFS or lower). If `mic` is within 10 dB of `display`, echo cancellation is not doing its job and me-versus-them attribution will bleed: file it with the two numbers.
**On failure**: "Couldn't capture that tab (…)" in the Rescribe tab means `getMediaStreamId` failed in Brave: file a bug with the message. "Audio is blocked in this tab" means Brave's autoplay policy stopped the AudioContexts without a gesture (headless Chromium allowed it): the fix is a click in the Rescribe tab before the toolbar click, then a redesign of the start sequence.

### The export folder permission is re-requested on Stop

**Trigger**: the first recording after restarting Brave with a folder already chosen (the handle persists, its permission may not).
**Steps**: with the Settings hint saying "Chrome will ask for permission again on the next export", record a few seconds and click Stop.
**Success criteria**: the permission prompt appears from the Stop click; after allowing, the recording exports. Deny it once: the recording is listed as `recorded` with "Not exported: …", its media is kept in OPFS, and the row's **Save now** button prompts again and exports.
**On failure**: the prompt does not appear, or appears after the export failed: `ensureExportPermission` in `onStop` is not running inside the gesture; file a bug.

### Chrome's "Stop sharing" bar ends the recording cleanly

**Trigger**: the first picker-path recording in Brave (Record screen… → a window or the entire screen).
**Steps**: record a window, then click "Stop sharing" on Brave's bar instead of Stop in the Rescribe tab. (The e2e dispatches a synthetic `ended` on the track; only this check exercises Chrome's real one.)
**Success criteria**: the Rescribe tab returns to idle and the recording is listed `recorded`. Because no click happened, the export may need the folder permission: if the row shows "Not exported" and a **Save now** button, clicking it must export. System audio from a window or screen share lands in `display.pcm` (Brave 152 on macOS 26 should offer it; the tab share always carries tab audio).
**On failure**: the status stays `recording`: the track's `ended` event did not fire; fix forward in `recorder.ts`.

### Meet's indicator lead of 0.3 s labels short utterances at handovers correctly

**Trigger**: the first real Meet call transcribed with platform evidence wired in (the PR that feeds `eventsToEvidence` into `attribute()`).
**Steps**: in `transcript.md`, take the handovers from the **end** of the call (the last ten minutes, where any drift between `Date.now()` and the audio clock is largest; see [[DEFERRED]] § "Anchor platform stamps to the audio clock"): five where the new speaker opens with a short utterance ("Yes", "Right", a name) and five where the previous speaker closes with one. Check each against the video. Also note what Meet labels your own tile in your UI language (English: "You"); `eventsToEvidence` drops that label from display evidence via `selfNames`.
**Success criteria**: the short utterances carry the right name in both directions; the self tile's label is "You" or the wiring passes the right `selfNames`.
**On failure**: openers credited to the previous speaker mean the indicator lags more than 0.3 s: raise `MEET_LEAD` in `src/lib/evidence.ts`. Closers credited to the next speaker mean it lags less: lower it. The `makeCall` fixture in `src/lib/attribution.test.ts` puts the safe range at 0.2–0.4 s for a 200–400 ms onset lag; measure the real lag from `events.jsonl` against the video before picking a new value. Misattribution concentrated late in a long call is drift, not lag: that is the DEFERRED trigger, not a reason to move `MEET_LEAD`.
