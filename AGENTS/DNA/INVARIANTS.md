# Invariants

What must stay true at runtime, and the failure that taught it.

**Admission test: could you write a test that fails when this stops being true?** If yes, it belongs here. A choice among alternatives goes in [[DECISIONS]]. Where code lives goes in [[ARCHITECTURE]]. Anything a user can observe goes in [[PRODUCT]].

**One entry per invariant.** The `###` heading states the rule, phrased so it can be violated. Under it: the mechanism that enforces it, and the incident that made it necessary. Entries seeded at kickoff have no incident yet and say so; add the incident when one happens. Past ~600 characters, re-read: an entry that long is usually several invariants fused.

An entry that no longer matches the code is a bug in one of them. Find out which before you trust it.

---

### No audio, video or transcript ever leaves the machine through Rescribe

A routine the human picks for a recording (DECISIONS § Routines) hands its directory to a program of theirs outside the browser, which may send the transcript elsewhere (Index in Lawcel runs Claude Code). That is the human's choice, made per recording, and not Rescribe's traffic: the extension passes the routine the recording's id, title and path, never its content.

**Mechanism:** the only permitted network traffic is the one-time model download from `huggingface.co`: `ParakeetEngine.load` fetches each file with parakeet.js's `getModelFile`, which serves its IndexedDB cache before the network, so a cached model loads with zero requests (`e2e/transcribe.spec.ts` asserts that on a fresh worker). `e2e/privacy.ts` records every HTTP(S) request a Playwright context makes, the transcribe worker's included, and every WebSocket a page opens, and fails on any network host outside its pinned list: `huggingface.co` and `<region>.<cloud>.cdn.hf.co`, the CDN it redirects to (observed `us.aws.cdn.hf.co`). Every test in `e2e/pipeline.spec.ts` asserts it over a whole run: record, transcribe, export; `e2e/transcribe.spec.ts` over the worker alone. The ORT binaries come from `dist/vendor/ort/`: `load` sets `ort.env.wasm.wasmPaths` before parakeet.js can default to jsDelivr. The manifest declares no `host_permissions`.
**Incident:** none. Seeded 2026-09-24 as the product's core promise.

### The mic channel and the display channel are never mixed before transcription

**Mechanism:** two AudioContexts (`src/recorder/graph.ts`). The taps live in the 16 kHz tap context, each fed by a `MediaStreamAudioSourceNode` of its own channel's track and writing its own PCM file; the mixer lives in the mix context and feeds only the MediaRecorder's audio track (and, for tab capture, the display channel to the speakers). Web Audio refuses to connect nodes across contexts, so no path from the mixer to a tap can be built. `src/recorder/graph.test.ts` pins the topology on `planGraph`: every tap has exactly one input, its own channel's source in the tap context; no edge crosses contexts; the mixer has no outputs; the mic never reaches the speakers.
**Incident:** none. Seeded 2026-09-24. Mixing would destroy the free, exact me-versus-them attribution the whole speaker design rests on.

### Every timestamp in the pipeline is recording-relative seconds, t=0 at the first captured sample

**Mechanism:** `Segment`, `Word` and `SpeakerInterval` carry `start`/`end` in seconds from recording start. The PCM files hold one sample per 1/16000 s of elapsed monotonic time: the taps zero-fill absent input and the recorder pads render gaps (`src/recorder/gap.ts`, ARCHITECTURE § Clock); a false gap detection would move every later sample, which is why `e2e/record.spec.ts` asserts an empty `events.jsonl` on a healthy run. Content scripts stamp events with `Date.now()` and the app tab converts using the recording's `startedAt` epoch; the conversion lives in one place, `src/lib/clock.ts` (`toRecordingSeconds`, `toEpochMs`), called by `eventsToEvidence` in `src/lib/evidence.ts` when adapter events become evidence. `clock.test.ts` covers multi-hour, sub-millisecond and pre-start stamps; attribution and evidence tests use fixtures spanning multiple hours.
**Incident:** none. Seeded 2026-09-24.

### Captured data is on disk within seconds of capture; a crash loses at most the last chunk

**Mechanism:** MediaRecorder runs with a 1 s timeslice, and every timeslice must yield a chunk. Chrome's WebM muxer emits one per timeslice whatever the keyframe interval, so the default container runs with a keyframe every 10 s (`KEYFRAME_INTERVAL_MS`); Chrome's fragmented-MP4 muxer emits a fragment only at a keyframe (default interval about 5 s), so the MP4 option runs with `videoKeyFrameIntervalDuration: 1000`. The AudioWorklet taps post 200 ms Int16 blocks. Every chunk and block is transferred to the storage worker, which appends it through a sync access handle and calls `flush()` after each write. What is in memory at any moment: one video chunk being turned into an ArrayBuffer and one block per channel; nothing else grows with the recording (`src/recorder/recorder.ts`). `e2e/record.spec.ts` "app tab closed mid-recording" runs once per container: it kills the tab 3.5 s in (before a WebM's second keyframe), reopens it, and asserts the recovered recording has a video that decodes up to the last chunk and PCM matching the elapsed time.
**Incident:** 2026-09-24, self-test of #1: with the default keyframe interval the OPFS video file was still 0 bytes 3.5 s into a recording while both PCM files were growing; the first media fragment arrived at 10 s. The capture spike's "chunks arrive per timeslice" had been read off a 3 s run that ended before the first fragment.

### A platform adapter that stops matching the page must say so, not go quiet

**Mechanism:** the Meet adapter emits `roster` when it finds participant tiles and an `adapter-diagnostic` message after 60 s of either no tiles or tiles without an audio meter (rate-limited to one per 5 min). The app tab appends it to the recording's note while recording (`Recorder.addNote`, persisted at once so a crash keeps it) and to `events.jsonl`, so the row shows "Meet adapter: …". The e2e fixture asserts no diagnostic fires on a healthy page; `e2e/pipeline.spec.ts` injects one during a recording and asserts the note and the row.
**Incident:** none. Seeded 2026-09-24 because Meet's markup is obfuscated and will change.

### A transcript exists in OPFS before its export is attempted

**Mechanism:** `app/pipeline.ts` writes `transcript.md`, `transcript.json` and `meta.json` with `writeArtifact` and only then calls `exportArtifacts`, which never creates a directory and needs the exported video in it; an export failure leaves the recording `done` with `error` set, never `failed`, and **Save now** (`app.ts` `saveNow`: `finalize` then `exportArtifacts`) exports what is in OPFS. `e2e/pipeline.spec.ts` "no export folder" records with no folder chosen, asserts the three files in `recordings/<id>/` and the recording at `done`, then chooses a folder and asserts Save now puts all four files there; "the export folder changes mid-transcription" asserts nothing is written under the new folder until Save now.
**Incident:** none. Seeded 2026-09-24: transcription may finish long after Stop's click, when the folder's permission is gone (after a browser restart) or no folder was chosen; a transcript that took minutes of GPU or CPU time must not depend on either.

### Every speaking start has a matching stop, and both are stamped at the change, not at its detection

**Mechanism:** `src/content/meet.ts` keeps the set of participants it has reported as speaking and closes each one on the first of: the meter went quiet (stop stamped at the last meter change via `ChangeActivity.lastChangeAt`), the meter element vanished (mute), or the tile left the layout. Starts are stamped at the first change of the run. The e2e fixture removes a tile mid-speech and asserts every stamp within 300 ms of the scripted truth (`e2e/meet-adapter.spec.ts`).
**Incident:** adversarial review of #12 (2026-09-24): the first version never closed an interval when a tile or meter disappeared, so a participant who muted stayed "speaking" until they unmuted, and stops were stamped at poll time, up to a second late, making every turn handover look like overlap.

### Only a start dialog the service worker opened can start a capture

**Mechanism:** `start/start.html` is web-accessible (the overlay needs that), so any site can load it in a frame of its own. The service worker puts a one-time key in the URL of each dialog it opens (`background.ts` `issueStartKey`, kept in `chrome.storage.session` per tab) and counts a dialog as open, for Start Capture and for the toolbar toggle, only when its URL carries that tab's key (`startDialogs`); `start-capture` names the key, the key goes when the dialog is closed from the toolbar or its Start succeeds, and the page without it shows nothing and asks nothing of the app tab. `e2e/start-dialog.spec.ts` (the overlay test) frames the page from another site with a guessed key.
**Incident:** 2026-09-25, the in-page start dialog's review: without the key, a site framing `start.html?tab=<id>` passed the "dialog still open" check, so a click in it recorded a tab whose click grant was still alive (the human had opened and closed the dialog there), and its frame made every toolbar click on that tab count as "close".

### A routine runs only on a recording the host can vouch for

**Mechanism:** the extension knows a recording's directory only by name (a folder handle has no path), so `native/store.ts` `resolveRecording` checks before a run starts that the Settings folder's name is the recordings folder's (`~/.rescribe/recordings`), that the export path resolves inside that folder, and that the directory's `meta.json` names the recording and sits next to `transcript.md`. Refused, the run never starts and the reason goes to the row. Run ids are checked by `isRunId` before they become paths. `native/host.test.ts` "refuses a recording it cannot vouch for" covers each case, `..` included; the routines e2e spec covers a refusal through the browser.
**Incident:** none. Seeded 2026-10-23: Index in Lawcel pushes what it is given to a shared repository, so a run on the wrong recording would publish the wrong meeting.

### A routine never runs with the human's API key

**Mechanism:** `native/lib.ts` `routineEnv` builds every routine's environment from the browser's without `ANTHROPIC_API_KEY` (and without Claude Code's session variables), so `claude` in a routine bills the human's subscription. `native/lib.test.ts` asserts it on the function, and `native/host.test.ts` runs a routine under a host that has the key and asserts the routine's environment does not.
**Incident:** none. Seeded 2026-10-23: the human's keys bill metered accounts, uncapped, and an automation must never spend them.

### A run that stopped without finishing is reported failed, never running forever

**Mechanism:** `status.json` carries the supervisor's pid while a run goes on; `native/store.ts` `currentStatus` turns a `running` status into `failed` and writes it back when that pid is gone or belongs to another user (reused after a restart), or when the run is five minutes past its routine's `timeoutMinutes`, by which time the supervisor has stopped it (SIGTERM to the group, SIGKILL after ten seconds) or is not there to say so. The app tab polls only `running` runs, so without this a row would poll and say "running" forever, with its routine buttons disabled. `native/host.test.ts` "a run whose supervisor is gone is failed" kills the supervisor, and "a run still running far past its time limit is failed" gives the run a live pid and an old start.
**Incident:** adversarial review of the routines (2026-10-23): the first version took an EPERM pid for alive and had no time limit, so a pid reused by a system process after a restart kept a run `running` forever.

### What was said on a call never reaches an agent that can run commands

**Mechanism:** a routine that runs Claude Code on a transcript runs it `--restricted --strict-mcp-config --tools Read,Write,Edit,Glob,Grep` (no Bash or other code-running tools, no WebFetch or WebSearch, no SendMessage to other sessions, no MCP servers, no user settings, file tools confined to its working directory; `--restricted` alone still offered WebSearch and SendMessage, seen in a dry run's tool list) and never with `bypassPermissions` or `--dangerously-skip-permissions`; the meeting's files are copied into that directory, and the script around it does the git work. `native/routines.test.ts` reads every routine's `run.sh` and fails on a `claude` call without the two flags or with any other tool list, or on either bypass anywhere.
**Incident:** adversarial review of the routines (2026-10-23): the first Index in Lawcel ran `bypassPermissions` with the home directory in reach, so anyone on a call could have had it read `.env` keys into a note it then pushed to a shared repository.

### What a call puts on the board passes the script's checks first

**Mechanism:** Index in Lawcel's agent only writes cards as files. `routines/index-in-lawcel/run.sh` refuses the run before anything is pushed when there are more than ten, or a card lacks a one-line title of at most 120 characters or a body; it leaves out an assignee who is not among the repository's assignable people and a card whose title is that of an issue already filed from the same call, writes the line saying where a card came from itself, and files nothing until the commit is on `origin/main` (or there was nothing to commit). Titles are measured in characters (`LC_ALL` is set: the browser gives the host no locale). The cards go to the repository the clone's `origin` is on GitHub, never a constant, so a scratch clone cannot file on the founders' board. When the origin is not on GitHub or `gh` cannot read the board, the run stops before Claude Code starts. `native/index-in-lawcel.test.ts` covers each, with a stand-in `gh` that records what `origin/main` was when each issue was filed.
**Incident:** self-testing (2026-10-26): a sandbox run with a scratch clone filed a real card on the founders' board (lawcel-knowledge #32), when the repository was still a constant. Seeded the same day: the cards are written from what was said on a call, and a sentence on it could otherwise flood the board or hand work to anyone.

### A pick of a routine starts at most one run

**Mechanism:** every `run-routine` carries a key for the pick (`src/lib/routines.ts` `runKey`: the recording's id, the routine, the epoch ms it was picked), stored in the run's `run.json`; `native/host.ts` answers a key it has seen (`store.ts` `findRun`) with that run's status instead of starting another. The app tab treats a start the host did not answer in time as unknown, not failed: the routine stays `waiting` and is asked again under the same key (`app/routines.ts` `startWhenReady`). `native/host.test.ts` "a start asked again under the same key gets the same run" asks twice and asserts one run.
**Incident:** adversarial review of the routines (2026-10-23): a lost or slow answer marked the routine failed while the run went on outside the browser, and the retry the row offered would push the same meeting's notes a second time.
