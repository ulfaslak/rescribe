# Agent Mistakes

Running log of errors found during self-testing (step 2 of the test-fix-learn cycle). Each entry records what went wrong and why, so patterns can be identified and turned into guardrails.

Tags: `[learned]` means a **referenced** systemic fix exists (a named CLAUDE.md item, DNA line, test or hook). A `[learned]` with no reference is a tagging error. `[not codified]` means the lesson is real, no guardrail states it, and the entry names what would have to be written.

Format: `### YYYY-MM-DD · #<issue or PR> · <category>` then two or three sentences: what was wrong, what caused it, what caught it.

---

### 2026-09-24 · #12 · state machine without exits `[learned]`

The Meet adapter tracked "speaking" per participant but only left the state through the signal going quiet; a tile or meter disappearing mid-speech left the interval open forever. The happy path was tested, the exits were not. Found by the adversarial review, not by self-testing. Codified as INVARIANTS § "Every speaking start has a matching stop", pinned by the e2e fixture that removes a tile mid-speech.

### 2026-09-24 · #12 · stamping events at detection time `[learned]`

Speaker events carried the poll's `Date.now()` rather than the time the DOM actually changed, so stops were late by the activity window plus a poll and adjacent speakers overlapped. A polling detector cannot know when the change happened; a MutationObserver can. Same INVARIANT as above.

### 2026-09-24 · #12 · prose claim asserted, not verified `[not codified]`

The adapter's header stated that Meet's page scripts cannot read a CustomEvent's `detail` dispatched from the isolated world. The reviewer demonstrated the opposite in Chromium. The claim had been written from memory and shipped as documentation. What would codify it: a CLAUDE.md line under self-testing, "a sentence about browser behaviour that you did not observe this session is a hypothesis; test it or mark it".

### 2026-09-24 · #12 · TypeScript syntax that Node's type stripping rejects `[learned]`

A constructor parameter property in `src/lib/activity.ts` compiled under `tsc` and esbuild but made the test file fail to load under `node --test`. Codified in DEVELOPMENT § Commands (`npm test` row).

### 2026-09-24 · #1 · spike result generalised past its measurement `[learned]`

The capture spike recorded "chunks arrive per timeslice, so data on disk within seconds holds" from a 3 s run with two chunks; those were the MP4 header and the final flush. Chrome's fragmented-MP4 muxer only emits at keyframes, about every 5 s by default, so a real recording had 0 bytes of video on disk after 3.5 s. Caught by the recovery e2e (tab killed mid-recording), fixed with a keyframe per timeslice. Codified in INVARIANTS § "on disk within seconds" (mechanism and incident) and ENVIRONMENT_NOTES § "MediaRecorder cadence".

### 2026-09-24 · #3 · threshold compare on ms-derived seconds `[learned]`

`cleanIntervals` tested `end - start < minDuration` and dropped a 300 ms interval, because `5.3 - 5` is `0.29999999999999982`. Every stamp in the pipeline arrives as epoch ms and becomes seconds by division, so any threshold on a difference of two such values sits on this edge; the first unit test with a boundary fixture caught it. Codified as the `EPSILON` slack in `src/lib/evidence.ts` with two boundary tests in `evidence.test.ts`. `attribute()`'s `tolerance` and `toTurns()`'s `maxGap` have the same exposure and no slack yet.

### 2026-09-24 · #16 · inferring from a transport guarantee that does not exist `[learned]`

`eventsToEvidence` opened an interval from t=0 for every stop without a matching start, on the comment "the adapter never emits a stop without having sent its start". True of the adapter, false of the transport: `chrome.runtime.sendMessage` is fire-and-forget, so one lost start turned a stop at 110 s into a phantom 0–110 s interval over another speaker. Found by the adversarial review. Codified in the function's doc comment (what a lost or duplicated message does) and the "adapter stream shaped like the transport" tests in `src/lib/evidence.test.ts`; the inference now applies only to the first toggle received for an id.

### 2026-09-24 · #16 · user-facing list built from raw observations `[learned]`

`participants` collected every name string ever seen, including the adapter's id fallback and pre-rename names, so a transcript would have read `Participants: spaces/x/devices/1, Anna`; a unit test even enshrined `['p1', 'Anna']`. The list should come from resolved state (the final name per id) and the test should have asked what the human would read. Found by the adversarial review. Codified by the "never an id string" contract on `PlatformEvidence.participants` and its tests in `evidence.test.ts`.


### 2026-09-24 · #18 · a second copy of the owner `[learned]`

Any app tab set the badge and answered `query-status` on load, so a second Rescribe tab desynced the badge and, answering first, could start a concurrent recording from a toolbar click. The design said "one app tab" and nothing enforced it. Found by the adversarial review. Codified in ARCHITECTURE § Runtime topology (single owner: a tab that finds a sibling never listens; the service worker closes duplicates and messages the owner by tab id) and pinned by `e2e/record.spec.ts` "a second app tab is inert".

### 2026-09-24 · #18 · readiness assumed for an existing tab `[learned]`

`ensureAppTab` waited for the app to answer only when it had just created the tab; an existing tab that was discarded, reloading or crashed was focused and messaged into `.catch(() => undefined)`, and the toolbar click did nothing while the stream id expired. Found by the adversarial review. Codified in `background.ts` (`waitForAppReady` on every path, reload of a silent tab, badge `!` when nothing answers) and ARCHITECTURE § Runtime topology.

### 2026-09-24 · #18 · the recovery path could not do the one thing it was for `[learned]`

Recovery after a browser restart and the "Stop sharing" path both ran `finalize` outside a user gesture, and the persisted folder handle is `prompt` after a restart, so the recovered recording ended as `recorded` + "Not exported" with no way to export it, while README and ARCHITECTURE claimed otherwise. Found by the adversarial review. Codified as the **Save now** row button (ARCHITECTURE § Storage, README § Use) and pinned by the e2e "Save now exports it later".

### 2026-09-24 · #18 · a promise chain that stops after one rejection `[learned]`

Video chunks were queued as `pending = pending.then(async …)`; one rejected `arrayBuffer()` skipped every later `.then`, silently dropping all further video while the PCM files kept growing, and the failure branch of stop skipped closing the contexts and the writer. Found by the adversarial review. Codified in `recorder.ts` (each chunk catches into `fail()`; stop's release step runs whatever the drain did) and pinned by the e2e "a lost video chunk fails the recording at once".

### 2026-09-24 · #18 · a worker whose failure settles nothing `[learned]`

`StorageWriter` reported `worker.onerror` only through a callback that, during start, pointed at a recorder that did not exist yet, so `await writer.open()` hung with the share live; a crash mid-recording hung `close()` at "Finishing…" behind a `beforeunload` prompt. Found by the adversarial review. Codified in `writer.ts` (`fail` rejects any pending open/close) and `recorder.ts` (deadlines on open, close, flush and MediaRecorder stop), pinned by the e2e "storage worker fails to load".

### 2026-09-24 · #18 · writing the record after arming the stop paths `[learned]`

`wire()` attached the `ended` and `stop` listeners and `rec.start()` ran before `putRecording` resolved, so a stop in that window updated a record that did not exist yet, then the insert re-wrote `status: 'recording'` over the outcome. Found by the adversarial review. Codified by ordering in `Recorder.start` (the record is persisted before any listener can fire) with the comment that says why.

### 2026-09-24 · #2 part 1 · float seconds where the unit was frames `[learned]`

The VAD merged two regions when their gap was *under* 500 ms, but computed the gap in float seconds derived from frame indices, so an exact 500 ms gap came out as 0.4999… and merged. Caught by the unit test that pins both sides of the boundary (`vad.test.ts`, "bursts with a gap under the merge gap become one region; over it, two"); fixed by doing pad, merge, drop and split in integer frames and converting to seconds once at the end.

### 2026-09-24 · #2 part 1 · state registered before the fallible call `[learned]`

`Transcriber.run` set the active job and then called `worker.postMessage(..., [buffer])`; a detached or shared buffer makes that throw, which rejected the job but left it registered as active, so the next job's messages would have been filtered out and that job would hang forever. Found on the paper walk of the edge list (storage and buffer states). Codified after the review by `src/app/transcriber.test.ts` ("a postMessage that throws fails that job only and registers nothing"), which runs the client against a fake worker.

### 2026-09-24 · #17 · error path keeps poisoned state `[learned]`

A region that blows the WASM heap or loses the GPU device rejects `transcribe`, and the worker posted the error but kept the engine, which `ensureEngine` then handed to every later job; the client kept the worker too. One bad region on the mic channel would have left the display channel untranscribable until the tab reloaded. Found by the adversarial review. Codified in the worker (drop the engine on a transcribe failure), the protocol (`ErrorMessage.stage`), the client (restart on a transcribe-stage error) and pinned by `transcriber.test.ts` plus the poisoned-sample job in `e2e/transcribe.spec.ts`.

### 2026-09-24 · #17 · prose said one-time download, code listed the repo every load `[learned]`

DECISIONS promised a one-time download; `getParakeetModel` fetched the Hub tree listing before looking in its cache, so every worker spawn pinged huggingface.co and offline WebGPU loading failed. I saw it in my own run ("origins seen" included huggingface.co on a cached run), wrote a DEFERRED entry and shipped. The reviewer rejected the deferral: DNA and code disagreed. Codified by the per-file `getModelFile` loader and the e2e assertion that a fresh worker with a cached model makes zero network requests.

### 2026-09-24 · #17 · dispose that leaves the queue running `[learned]`

`Transcriber.dispose()` failed only the active job; queued jobs then spawned a fresh worker, loaded the model and posted results for a recording that might have been deleted. Found by the adversarial review; pinned by `transcriber.test.ts` ("dispose rejects the active and the queued jobs").

### 2026-09-24 · #17 · contract documented for the eager case, implemented lazily `[learned]`

The client's docstring promised the PCM buffer was transferred at call time; the transfer actually happened when the queued job ran, so a caller reusing the buffer meanwhile would have had the display audio transcribed as the mic channel, silently. Found by the adversarial review; jobs are now posted at call time and `transcriber.test.ts` asserts both buffers are detached before either job finishes.

