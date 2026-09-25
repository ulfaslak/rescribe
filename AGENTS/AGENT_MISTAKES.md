# Agent Mistakes

Running log of errors found during self-testing (step 2 of the test-fix-learn cycle). Each entry records what went wrong and why, so patterns can be identified and turned into guardrails.

Tags: `[learned]` means a **referenced** systemic fix exists (a named CLAUDE.md item, DNA line, test or hook). A `[learned]` with no reference is a tagging error. `[not codified]` means the lesson is real, no guardrail states it, and the entry names what would have to be written.

Format: `### YYYY-MM-DD · #<issue or PR> · <category>` then two or three sentences: what was wrong, what caused it, what caught it.

---

### 2026-09-25 · stop dialog · an API's refusal treated as impossible `[learned]`

`openStopDialog` computed a position for the popup window from the last focused window and passed it to `chrome.windows.create` with no catch; Chrome refuses bounds that are mostly off-screen, so in headless Chromium (and on a desktop with a browser window half off a display) no dialog ever opened and the rejection vanished into a `void` promise, while the badge said `REC` as if all was well. Found by every stop-dialog e2e timing out on the window. Codified in `background.ts` (default placement on refusal) and ENVIRONMENT_NOTES § "`chrome.windows.create` refuses bounds off the visible screen". Rule: a positioned window, a permission request, a picker: anything Chrome may refuse for reasons outside the code gets a fallback, not a `void`.

### 2026-09-25 · stop dialog · two entry points, one bookkeeping path `[learned]`

The decision on a stopped recording could be taken from the dialog (through `applyDecision`, which refreshed the status and the badge afterwards) or from the row (through `decide` directly, which did not), so a Save clicked on the row exported the video and left the pill on `stopped` and the badge on `SAVE`. Found by the "share ends" e2e. Codified by moving the refresh into the `onDecision` listener in `app.ts`, so every entry point shares it, and pinned by the row-Save half of that test.

### 2026-09-25 · stop dialog · a race diagnosed from the symptom, then written into the code `[not codified]`

Two tests failed with the dialog "closing on its own" and Discard "doing nothing"; I attributed both to a broadcast `sendMessage` racing the service worker's non-answer, rewrote the dialog to message the app tab by id, and wrote that race into a comment and a commit message as something "seen in the e2e". The next run failed identically: the real causes were Playwright reporting a page closed *during* the Escape press that closed it, and the two-step button's own double-click guard swallowing a confirm 300 ms after arming. The targeted messaging stayed because it is the right shape (only the owner may answer), the false claim was removed. Already named as a pattern (#12 "prose claim asserted, not verified"); this is the second instance. What would codify it: a CLAUDE.md line under self-testing, "before writing a cause into a comment, make the test fail on that cause and pass on its fix".

### 2026-09-24 · #22 · a tab moved to the background, the start path still written for a visible one `[learned]`

Leaving the app tab hidden on a Meet click was a one-line routing change, but the start path had three assumptions that only held for a visible tab: a note is seen (a missing-microphone note was shown, then overwritten by the ticking clock a second later, after yanking the human out of the call for it), a permission prompt shows (Chrome queues prompts from hidden tabs; the tab-capture id was consumed first, so a queued prompt would have muted the call with nobody hearing it), and a second click reaches a guard (`starting` was set after the first await, and a click landing after the start finished met a stale `idle`). Found by the adversarial review. Rule: when a change alters *where the human is looking*, re-read every line that assumes they can see or act, not just the line that moved them.

### 2026-09-24 · #22 · an absolute count asserted in a profile that persists `[learned]`

The new e2e asserted zero recordings after a failed start; the reused profile held two from the previous test, so the test passed alone and failed in the suite. Measure against what was there before, or clear first.

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


### 2026-09-24 · #2 part 2 · absence of input read as success `[learned]`

The first pipeline runner skipped a channel whose PCM file was missing and went on to `done`, so a recording whose OPFS directory had been deleted (or never received audio because the media was wiped mid-transcription) would have ended `done` with an empty transcript, indistinguishable from a silent call. A missing input is not an empty input. Found on the paper walk of the edge list (storage states); codified in ARCHITECTURE § Pipeline step 3 (no channel and no cache: `done` only when the video is still there, `failed` otherwise) and pinned by `e2e/pipeline.spec.ts` "an interrupted transcription whose media is gone fails".

### 2026-09-24 · #20 · prose promised a path no code had `[learned]`

ARCHITECTURE, DECISIONS, INVARIANTS and PRODUCT all said Save now exports the video and the artifacts together, while the row offered Save now only on `recorded` without an export path and `saveNow` called only `finalize`; a `done` recording whose transcript stayed in OPFS had no way out. The prose was written for the design, not read back against the code. Found by the adversarial review. Codified in `app.ts` (`canSaveNow`, `saveNow`: `finalize` then `exportArtifacts`) and pinned by `e2e/pipeline.spec.ts` "no export folder" (Save now on the `done` row).

### 2026-09-24 · #20 · a list rendered from a read that raced the write `[learned]`

`onRecorderChange('done')` started the pipeline and re-read the list in the same tick; the read landed before the pipeline marked the record, and nothing re-rendered until it finished, so the row showed `recorded` and Save now for the whole transcription, and a click wrote `recorded` over `transcribing` from a stale record. Found by the adversarial review. Codified by the `queued` and `done` pipeline phases with the list re-rendered on every phase change, `saveNow` working from the stored record and refusing while `isTranscribing`, and pinned by the `rowState` poll in "no export folder".

### 2026-09-24 · #20 · queue state in memory, status on disk `[learned]`

`transcribeRecording` kept its queue in a `Map` and wrote `transcribing` only when a recording's turn came, so a queued recording read `recorded` on disk and a library action keyed on the stored status would have pulled its media from under it. Found by the adversarial review. Codified in ARCHITECTURE § Pipeline (marked at enqueue) and pinned by "recording while transcribing" (the queued recording reads `transcribing` at once).

### 2026-09-24 · #20 · a snapshot carried across minutes of work `[learned]`

`run()` used the record as read at its start for the title, the export path and the export decision, and `exportArtifacts` created the directory it was given; a folder chosen mid-transcription got a directory with only the transcript, no error, and a rename mid-transcription left the old title in the files. Found by the adversarial review. Codified by the fresh re-read before assembly and by `findExportDirectory` (never creates, needs the video), pinned by "the export folder changes mid-transcription".

### 2026-09-24 · #20 · a re-run erased the failure it was retrying `[learned]`

Marking a `failed` recording `transcribing` cleared its `error`, so the recorder's reason ("Video chunk lost: …") was gone whatever the re-run did, and a re-run without an export path could end `done` with no error at all. Found by the adversarial review. Codified in `pipeline.ts` (the earlier error moves to the note; `done` without an export path always carries a "Not exported: …" reason; no media keeps the earlier text in front) and pinned by "re-running a failed recording".
### 2026-09-24 · #4 · two-step confirm defeated by a double-click `[learned]`

The library's in-page two-step button armed on the first click and ran on the second, so a double-click on **Delete**, the most ordinary accidental gesture on a button, deleted the recording in one go. The confirm was designed against a single stray click and never walked as a gesture. Found on the paper walk of the edge list before the e2e ran. Codified by `ARM_GUARD_MS` in `src/app/library.ts` (a confirm sooner than 350 ms after arming is ignored) and pinned by the `dblclick` case in `e2e/library.spec.ts`.

### 2026-09-24 · #4 · action target captured at render time `[learned]`

Each row's buttons and the bulk "Delete media for exported recordings" closed over the record and the target list as rendered; a recording the pipeline moved to `transcribing` between render and confirm would have had its PCM deleted under the running transcription. The list is a snapshot, the store is the truth, and a destructive action must re-read the store inside the click. Found on the paper walk. Codified by `claim()` in `src/app/library.ts` (every action re-reads the record and refuses one that is `recording`, `transcribing`, or queued or running in the pipeline per `isTranscribing`, whose in-memory answer is ahead of the status on disk) and the bulk action re-computing its targets, both pinned by the status-flip and queued-pipeline cases in `e2e/library.spec.ts`.

### 2026-09-24 · #19 · trusting a path field over the file it names `[learned]`

"Delete media for exported recordings" took `exportPath` as proof the exported video existed, while the LIVE_CHECKS entry in the same PR asks the human to delete that very file in Finder: the confirm would have removed the only copy. A stored path says where a file went, not that it is still there. Found by the adversarial review. Codified by `exportedFileState` in `src/storage/export.ts`, consulted per target by the row and bulk deletes (a missing file is kept and named; no folder or no permission refuses the run), pinned by the missing-video and no-folder cases in `e2e/library.spec.ts`.

### 2026-09-24 · #19 · capability gated on status instead of on what is on disk `[learned]`

The Re-export button required status `recorded` or `done`, so a `failed` recording with ninety minutes of playable video and both PCM files in OPFS (a chunk lost late in a call) could only be deleted; my own e2e pinned "offers only Delete". The row already had the inventory; the gate should have read it. Found by the adversarial review. Codified by `exportable = inv.video || inv.artifacts.length > 0` in `src/app/library.ts` (a failed recording keeps its status and failure reason when saved), pinned by the failed-with-video case in `e2e/library.spec.ts`.

### 2026-09-24 · #19 · an input removed from the DOM fires blur, and blur meant "save" `[learned]`

The rename form saved on blur, and any wholesale re-render (a live refresh, a recorder phase change) replaced the row, removing the focused input; Chromium fires `blur` on removal, so a half-typed title was saved without an Enter. A save on blur is only safe when the input leaves the DOM on the human's terms. Found by the adversarial review, who verified the blur-on-removal behaviour I had not. Codified by the `editing` guard in `src/app/library.ts` (`renderList` defers while a title is being edited; the edit's finish renders), pinned by the deferral case in `e2e/library.spec.ts`.

### 2026-09-24 · #19 · an editor offered while another writer holds the record `[learned]`

The pencil was rendered on `recording` and `transcribing` rows, so a rename raced the recorder's stop (`updateRecording` was a get-then-put in two IndexedDB transactions: a rename interleaving with `finalize` could rewrite `status: 'recording'` without an export path) and the pipeline's `rec` held from its start (transcript and meta with the old title). Found by the adversarial review. Codified twice: no pencil on live rows in `src/app/library.ts` (pinned by the live-row case in `e2e/library.spec.ts`), and `idb.update` in `src/lib/idb.ts`, a read-modify-write in one readwrite transaction, now behind `updateRecording` (ARCHITECTURE § Storage). The atomicity has no deterministic e2e: with the pencil gone the UI has no concurrent writer pair left to race.

### 2026-09-24 · #19 · a disabled button that a re-render re-enables `[learned]`

`runAction` disabled the row's buttons for the action's duration, but a re-render meanwhile rebuilt the row from the store with everything enabled; a confirmed Delete media during a multi-GB Re-export removed `video.mp4` under the stream, which failed with `TypeError: network error` blamed on the folder. DOM state is not a lock; the in-flight fact has to live where the render reads from. Found by the adversarial review. Codified by the `inflight` map in `src/app/library.ts` (a row in it renders the action's label and no buttons, `runAction` refuses a second action on the id, the bulk filter skips it), pinned by the slowed-export case in `e2e/library.spec.ts`.

### 2026-09-24 · #19 · a render started beside the deletion it announces `[learned]`

To show a row as busy at once, `runAction` began a render (which walks `recordings/` in OPFS) and then ran the action; when the action was "delete recording", the walk could reach that directory after `removeEntry`, `entries()` threw NotFoundError, the render rejected unhandled and the list was never rebuilt, so the deleted row stayed on screen. Found by a negative-control run that failed at the wrong assertion (twice, on a change that could not have caused it), then the trace's `pageerror`. Codified in `src/storage/opfs.ts` (a directory or file removed mid-walk is skipped; the walk is a snapshot, deletion is the truth) and `renderList` in `src/app/library.ts` (never rejects; a failed refresh is reported), pinned by the slowed-`entries()` case in `e2e/library.spec.ts`.

### 2026-09-24 · #19 · a confirm button whose target set was its visibility `[learned]`

The bulk "Delete media for exported recordings" was rendered only while its target set was non-empty, and the pipeline's enqueue re-renders the list, so the moment a candidate was queued the armed button vanished under the human's second click (and Playwright's). A two-step button must stay where it is once armed; what it may act on is decided when it runs. Found by the queued-pipeline e2e in Phase B. Codified in `src/app/library.ts`: `exportedWithMedia` lists candidates by status only, and `removeExportedMedia` leaves held ones alone and says so.
