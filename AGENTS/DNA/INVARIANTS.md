# Invariants

What must stay true at runtime, and the failure that taught it.

**Admission test: could you write a test that fails when this stops being true?** If yes, it belongs here. A choice among alternatives goes in [[DECISIONS]]. Where code lives goes in [[ARCHITECTURE]]. Anything a user can observe goes in [[PRODUCT]].

**One entry per invariant.** The `###` heading states the rule, phrased so it can be violated. Under it: the mechanism that enforces it, and the incident that made it necessary. Entries seeded at kickoff have no incident yet and say so; add the incident when one happens. Past ~600 characters, re-read: an entry that long is usually several invariants fused.

An entry that no longer matches the code is a bug in one of them. Find out which before you trust it.

---

### No audio, video or transcript ever leaves the machine

**Mechanism:** the only permitted network traffic is the one-time model download from `huggingface.co`: `ParakeetEngine.load` fetches each file with parakeet.js's `getModelFile`, which serves its IndexedDB cache before the network, so a cached model loads with zero requests (`e2e/transcribe.spec.ts` asserts that on a fresh worker). `e2e/privacy.ts` records every HTTP(S) request a Playwright context makes, the transcribe worker's included, and every WebSocket a page opens, and fails on any network host outside its pinned list: `huggingface.co` and `<region>.<cloud>.cdn.hf.co`, the CDN it redirects to (observed `us.aws.cdn.hf.co`). The recording spec must assert it too once it exists. The ORT binaries come from `dist/vendor/ort/`: `load` sets `ort.env.wasm.wasmPaths` before parakeet.js can default to jsDelivr. The manifest declares no `host_permissions`.
**Incident:** none. Seeded 2026-09-24 as the product's core promise.

### The mic channel and the display channel are never mixed before transcription

**Mechanism:** each channel has its own AudioWorklet tap writing its own PCM file in OPFS; the mixer node's only consumer is the MediaRecorder's audio track. (Planned: a unit test on the audio graph builder asserting the tap nodes have exactly one input each.)
**Incident:** none. Seeded 2026-09-24. Mixing would destroy the free, exact me-versus-them attribution the whole speaker design rests on.

### Every timestamp in the pipeline is recording-relative seconds, t=0 at the first captured sample

**Mechanism:** `Segment`, `Word` and `SpeakerInterval` carry `start`/`end` in seconds from recording start. Content scripts stamp events with `Date.now()` and the app tab converts using the recording's `startedAt` epoch; the conversion lives in one place (`src/lib/clock.ts`, planned). Attribution tests use fixtures spanning multiple hours.
**Incident:** none. Seeded 2026-09-24.

### Captured data is on disk within seconds of capture; a crash loses at most the last chunk

**Mechanism:** MediaRecorder emits chunks on a timeslice and the AudioWorklet taps emit PCM blocks; both are appended to OPFS by the storage worker with a sync access handle and flushed per write. Nothing is accumulated in memory across the recording. (Planned e2e: kill the app tab mid-recording, reopen, assert the OPFS file length.)
**Incident:** none. Seeded 2026-09-24. Calls are long and unrepeatable.

### A platform adapter that stops matching the page must say so, not go quiet

**Mechanism:** the Meet adapter emits `roster` when it finds participant tiles and an `adapter-diagnostic` message after 60 s of either no tiles or tiles without an audio meter (rate-limited to one per 5 min). The app tab surfaces it on the recording (planned). The e2e fixture asserts no diagnostic fires on a healthy page.
**Incident:** none. Seeded 2026-09-24 because Meet's markup is obfuscated and will change.

### Every speaking start has a matching stop, and both are stamped at the change, not at its detection

**Mechanism:** `src/content/meet.ts` keeps the set of participants it has reported as speaking and closes each one on the first of: the meter went quiet (stop stamped at the last meter change via `ChangeActivity.lastChangeAt`), the meter element vanished (mute), or the tile left the layout. Starts are stamped at the first change of the run. The e2e fixture removes a tile mid-speech and asserts every stamp within 300 ms of the scripted truth (`e2e/meet-adapter.spec.ts`).
**Incident:** adversarial review of #12 (2026-09-24): the first version never closed an interval when a tile or meter disappeared, so a participant who muted stayed "speaking" until they unmuted, and stops were stamped at poll time, up to a second late, making every turn handover look like overlap.
