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
- Meet speaker adapter (2026-09-24): on meet.google.com the extension knows who is speaking when and who is present, validated in a two-person call.
- Vertical slice (2026-09-24): the toolbar button records the current tab plus the microphone, "Record screen…" in the Rescribe tab records a tab, window or screen through Chrome's picker; both stream video and the two audio channels to OPFS as they happen, and Stop exports `recording.mp4` (or `.webm`) into `<template>/` in the chosen folder (the share ending asks first since the stop dialog, below) and lists the recording as `recorded` with each channel's level; a recording interrupted by the tab closing is recovered from disk on the next open, and one that could not be saved to the folder offers **Save now**. One Rescribe tab owns everything; a second one only offers to take you to the first. Verified with fake devices in headless Chromium; the toolbar path in the human's Brave is a pending live check.
- Transcription (2026-09-24): when a recording stops (or from the library), each audio channel goes through Parakeet in the browser, with the model download and the region count on the status line and the badge (the badge until the processing tab of 2026-09-25 took that over), and `transcript.md`, `transcript.json` and `meta.json` land next to the video, the microphone under the name from Settings and everything else under "Speaker"; without a folder they wait inside Rescribe for Save now, and a Rescribe tab reloaded mid-transcription picks it up again. Settings offer the WebGPU backend and turning auto-transcription off. Verified with the fake microphone in headless Chromium; the first real transcript in Brave, and WebGPU there, are pending live checks.
- Meet speaker attribution (2026-09-24): during a recording the Meet adapter's speaker and roster events are kept with the recording, and the transcript names each display-channel turn after the Meet participant whose indicator was on, lists the participants in `transcript.md` and `meta.json`, and shows an adapter diagnostic on the recording's row. Your own tile is recognised by its overlap with the microphone, whatever Meet calls it, and presentation tiles are not listed as participants (2026-09-25). The event path is verified end to end with injected events and the self tile against a real 58-minute two-person call; the names against the video are a pending live check.

- Stay in the call (2026-09-24): the toolbar button (or `Alt+Shift+R`) on a Meet tab starts recording without leaving Meet: the badge shows `REC` and the Rescribe tab opens pinned in the background, coming forward only when the start needs you (the first time, for the microphone permission; a start that failed). On any other tab the Rescribe tab comes forward as before (until the start dialog of 2026-09-25, which keeps it in the background everywhere). The failed-start case is verified in headless Chromium; the click on a real Meet tab in Brave is a pending live check.
- Recording library (2026-09-24): every recording is a row with an editable title (renaming never renames the exported folder), date, duration, sources, status, folder path, channel levels and local size; a row offers **Re-export** (Save now on a row that never got a folder: the video and every transcript file still in local storage into the folder, recreating the folder if it was deleted), **Re-run transcription** (again from the audio, or from the kept recogniser output when the audio is gone), **Delete media** (frees the video and audio in local storage, keeps the record, the transcript files and the exported files; refused while the exported video cannot be found) and **Delete** (record and local files; the exported files stay), each deletion an in-page two-step click; a running recording's row ticks and a transcribing row shows the pipeline's progress; the section shows the local storage total with one button that deletes the media of every fully exported (`done`) recording.

- Stop dialog (2026-09-25): while recording, the toolbar button (or `Alt+Shift+R`) opens a small window next to the browser's top right instead of the Rescribe tab: **Save** stops and saves into the folder from Settings (asking for the folder first if none is chosen), **Save as…** stops and saves into a folder you pick for this recording only, **Discard** (click twice) stops and deletes it with nothing written anywhere; Escape or closing the window keeps recording. Leaving a Meet call opens the same window while the recording goes on, so rejoining loses nothing. When the share ends on its own (Chrome's Stop sharing bar, the captured tab closed) the recording waits: the window opens, the badge says `SAVE`, the recording's row offers the same three buttons (and keeps offering them after a reload), and nothing is saved or transcribed until you choose; a waiting recording never stops you from starting the next one (the badge then says `REC` again, and `SAVE` once that one is done). Stop in the Rescribe tab still saves in one click; a Save with no folder chosen yet asks for one first. A recording saved elsewhere shows its folder in front of its path and Re-export goes there too. Verified in headless Chromium, including the transcript following a Save as… folder; the window, the pickers and the permission prompt from it in Brave, and leaving a real Meet call, are pending live checks.
- Start dialog and processing tab (2026-09-25): the toolbar button (or `Alt+Shift+R`) on a tab opens a small window next to the browser's top right showing the tab it will record, a microphone selector (the microphones by name once Rescribe has been allowed one; "No microphone" too), the folder recordings go to with **Change…**, and **Start Capture**; the button again or Escape closes it and nothing records until Start; the choices stick. The window also says when a recording is waiting to be saved or is being transcribed in the background, with a way there. Nothing starts from the click alone any more, so a click while a transcription runs no longer records by accident. After **Save** or **Save as…** in the stop window, a new tab opens in the browser window and follows the recording: saving the video, the one-time model download, the transcription and where it all went; it can be closed at any time, the pinned Rescribe tab does the work; when that tab is closed the page says `Paused` and **Open Rescribe** resumes. The toolbar icon shows nothing while transcribing (no more `…`). Verified in headless Chromium; the windows, the real microphone names, the folder picker from the start window and Start Capture on a real Meet tab in Brave are pending live checks.

### Planned, in order

Nothing queued; see Later.

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
