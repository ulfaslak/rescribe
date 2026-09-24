# Invariants

What must stay true at runtime, and the failure that taught it.

**Admission test: could you write a test that fails when this stops being true?** If yes, it belongs here. A choice among alternatives goes in [[DECISIONS]]. Where code lives goes in [[ARCHITECTURE]]. Anything a user can observe goes in [[PRODUCT]].

**One entry per invariant.** The `###` heading states the rule, phrased so it can be violated. Under it: the mechanism that enforces it, and the incident that made it necessary. Entries seeded at kickoff have no incident yet and say so; add the incident when one happens. Past ~600 characters, re-read: an entry that long is usually several invariants fused.

An entry that no longer matches the code is a bug in one of them. Find out which before you trust it.

---

### No audio, video or transcript ever leaves the machine

**Mechanism:** the only permitted network traffic is the model download from `huggingface.co` (parakeet.js hub loader, cached in IndexedDB). The e2e harness records every network request during a recording and transcription run and fails on any host other than `huggingface.co` and its CDN redirect targets (planned: `e2e/privacy.spec.ts`). The manifest declares no `host_permissions`.
**Incident:** none. Seeded 2026-09-24 as the product's core promise.

### The mic channel and the display channel are never mixed before transcription

**Mechanism:** two AudioContexts (`src/recorder/graph.ts`). The taps live in the 16 kHz tap context, each fed by a `MediaStreamAudioSourceNode` of its own channel's track and writing its own PCM file; the mixer lives in the mix context and feeds only the MediaRecorder's audio track (and, for tab capture, the display channel to the speakers). Web Audio refuses to connect nodes across contexts, so no path from the mixer to a tap can be built. `src/recorder/graph.test.ts` pins the topology on `planGraph`: every tap has exactly one input, its own channel's source in the tap context; no edge crosses contexts; the mixer has no outputs; the mic never reaches the speakers.
**Incident:** none. Seeded 2026-09-24. Mixing would destroy the free, exact me-versus-them attribution the whole speaker design rests on.

### Every timestamp in the pipeline is recording-relative seconds, t=0 at the first captured sample

**Mechanism:** `Segment`, `Word` and `SpeakerInterval` carry `start`/`end` in seconds from recording start. Content scripts stamp events with `Date.now()` and the app tab converts using the recording's `startedAt` epoch; the conversion lives in one place, `src/lib/clock.ts` (`toRecordingSeconds`, `toEpochMs`), called by `eventsToEvidence` in `src/lib/evidence.ts` when adapter events become evidence. `clock.test.ts` covers multi-hour, sub-millisecond and pre-start stamps; attribution and evidence tests use fixtures spanning multiple hours.
**Incident:** none. Seeded 2026-09-24.

### Captured data is on disk within seconds of capture; a crash loses at most the last chunk

**Mechanism:** MediaRecorder runs with a 1 s timeslice **and** `videoKeyFrameIntervalDuration: 1000`, because Chrome's fragmented-MP4 muxer emits a fragment only at a keyframe (default interval about 5 s); the AudioWorklet taps post 200 ms Int16 blocks. Every chunk and block is transferred to the storage worker, which appends it through a sync access handle and calls `flush()` after each write. What is in memory at any moment: one video chunk being turned into an ArrayBuffer and one block per channel; nothing else grows with the recording (`src/recorder/recorder.ts`). `e2e/record.spec.ts` "app tab closed mid-recording" kills the tab 3.5 s in, reopens it, and asserts the recovered recording has a playable video and PCM matching the elapsed time.
**Incident:** 2026-09-24, self-test of #1: with the default keyframe interval the OPFS video file was still 0 bytes 3.5 s into a recording while both PCM files were growing; the first media fragment arrived at 10 s. The capture spike's "chunks arrive per timeslice" had been read off a 3 s run that ended before the first fragment.

### A platform adapter that stops matching the page must say so, not go quiet

**Mechanism:** the Meet adapter emits `roster` when it finds participant tiles and an `adapter-diagnostic` message after 60 s of either no tiles or tiles without an audio meter (rate-limited to one per 5 min). The app tab surfaces it on the recording (planned). The e2e fixture asserts no diagnostic fires on a healthy page.
**Incident:** none. Seeded 2026-09-24 because Meet's markup is obfuscated and will change.

### Every speaking start has a matching stop, and both are stamped at the change, not at its detection

**Mechanism:** `src/content/meet.ts` keeps the set of participants it has reported as speaking and closes each one on the first of: the meter went quiet (stop stamped at the last meter change via `ChangeActivity.lastChangeAt`), the meter element vanished (mute), or the tile left the layout. Starts are stamped at the first change of the run. The e2e fixture removes a tile mid-speech and asserts every stamp within 300 ms of the scripted truth (`e2e/meet-adapter.spec.ts`).
**Incident:** adversarial review of #12 (2026-09-24): the first version never closed an interval when a tile or meter disappeared, so a participant who muted stayed "speaking" until they unmuted, and stops were stamped at poll time, up to a second late, making every turn handover look like overlap.
