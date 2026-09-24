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

### 2026-09-24 · #3 · threshold compare on ms-derived seconds `[learned]`

`cleanIntervals` tested `end - start < minDuration` and dropped a 300 ms interval, because `5.3 - 5` is `0.29999999999999982`. Every stamp in the pipeline arrives as epoch ms and becomes seconds by division, so any threshold on a difference of two such values sits on this edge; the first unit test with a boundary fixture caught it. Codified as the `EPSILON` slack in `src/lib/evidence.ts` with two boundary tests in `evidence.test.ts`. `attribute()`'s `tolerance` and `toTurns()`'s `maxGap` have the same exposure and no slack yet.
