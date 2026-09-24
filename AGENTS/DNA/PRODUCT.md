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

### Planned, in order

1. **Vertical slice.** Record the current tab plus mic from the toolbar button, and screen/window plus mic from the app tab; stream to OPFS; export `recording.mp4` to the chosen folder. Settings: folder, path template, my name, container, mic on/off.
2. **Transcription.** Per-channel Parakeet transcription after stop, with progress, producing `transcript.md` and `transcript.json` with channel-identity attribution (Me vs Speaker).
3. **Meet adapter.** Content script on meet.google.com emitting speaker intervals and the roster; calibrated in a live call with the human.
4. **Recording library.** List of recordings with status, re-run transcription, re-export, delete media.

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
