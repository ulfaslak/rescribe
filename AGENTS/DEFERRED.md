# Deferred

Technical items intentionally postponed: tech debt, hardening shortcuts, known limitations, cleanup. Each entry has **What**, **Why deferred** and a concrete **Trigger**. Not for features: those are GitHub issues.

Remove an entry in the PR that resolves it.

---

### Delete `spikes/capture` once the recorder exists

**What**: `spikes/capture` is a throwaway page built into `dist/spikes/` and driven by `e2e/spikes/capture.spec.ts`. Not product code.
**Why deferred**: its answer (recorded in `spikes/README.md` and the DNA) is the only executable proof of the capture assumptions until the real recorder and storage worker exist.
**Trigger**: the vertical slice PR (recorder + OPFS + export). Delete the spike directory and its e2e spec in that PR. Whichever spike PR merges last also removes `spikes/README.md`, the spike glue in `scripts/build.mjs` (it throws on a missing `spikes/`) and the `spikes/**` globs in `package.json`.

### Delete `spikes/parakeet` once the transcribe worker exists

**What**: `spikes/parakeet` is a throwaway page built into `dist/spikes/` and driven by `e2e/spikes/parakeet.spec.ts`. Not product code.
**Why deferred**: its answer is the only executable proof of the ASR assumptions until the real transcribe worker exists.
**Trigger**: the transcription PR. Delete the spike directory and its e2e spec in that PR; see the entry above for what the last spike PR also removes.

### Extension icons

**What**: `src/manifest.json` declares no icons, so the toolbar shows Chrome's default puzzle piece. The badge (recording state) works regardless.
**Why deferred**: cosmetic.
**Trigger**: the vertical slice PR, when the badge design is decided anyway.
