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

### 2026-09-24 · #2 part 1 · float seconds where the unit was frames `[learned]`

The VAD merged two regions when their gap was *under* 500 ms, but computed the gap in float seconds derived from frame indices, so an exact 500 ms gap came out as 0.4999… and merged. Caught by the unit test that pins both sides of the boundary (`vad.test.ts`, "bursts with a gap under the merge gap become one region; over it, two"); fixed by doing pad, merge, drop and split in integer frames and converting to seconds once at the end.

### 2026-09-24 · #2 part 1 · state registered before the fallible call `[not codified]`

`Transcriber.run` set the active job and then called `worker.postMessage(..., [buffer])`; a detached or shared buffer makes that throw, which rejected the job but left it registered as active, so the next job's messages would have been filtered out and that job would hang forever. Found on the paper walk of the edge list (storage and buffer states), not by a test: the client is not exercised by any e2e until part 2 wires it. What would codify it: a unit test of `Transcriber` against a fake `Worker`, or the part 2 e2e driving the client instead of the worker.

### 2026-09-24 · #17 · error path keeps poisoned state `[learned]`

A region that blows the WASM heap or loses the GPU device rejects `transcribe`, and the worker posted the error but kept the engine, which `ensureEngine` then handed to every later job; the client kept the worker too. One bad region on the mic channel would have left the display channel untranscribable until the tab reloaded. Found by the adversarial review. Codified in the worker (drop the engine on a transcribe failure), the protocol (`ErrorMessage.stage`), the client (restart on a transcribe-stage error) and pinned by `transcriber.test.ts` plus the poisoned-sample job in `e2e/transcribe.spec.ts`.

### 2026-09-24 · #17 · prose said one-time download, code listed the repo every load `[learned]`

DECISIONS promised a one-time download; `getParakeetModel` fetched the Hub tree listing before looking in its cache, so every worker spawn pinged huggingface.co and offline WebGPU loading failed. I saw it in my own run ("origins seen" included huggingface.co on a cached run), wrote a DEFERRED entry and shipped. The reviewer rejected the deferral: DNA and code disagreed. Codified by the per-file `getModelFile` loader and the e2e assertion that a fresh worker with a cached model makes zero network requests.

### 2026-09-24 · #17 · dispose that leaves the queue running `[learned]`

`Transcriber.dispose()` failed only the active job; queued jobs then spawned a fresh worker, loaded the model and posted results for a recording that might have been deleted. Found by the adversarial review; pinned by `transcriber.test.ts` ("dispose rejects the active and the queued jobs").

### 2026-09-24 · #17 · contract documented for the eager case, implemented lazily `[learned]`

The client's docstring promised the PCM buffer was transferred at call time; the transfer actually happened when the queued job ran, so a caller reusing the buffer meanwhile would have had the display audio transcribed as the mic channel, silently. Found by the adversarial review; jobs are now posted at call time and `transcriber.test.ts` asserts both buffers are detached before either job finishes.

