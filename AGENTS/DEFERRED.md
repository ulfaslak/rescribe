# Deferred

Technical items intentionally postponed: tech debt, hardening shortcuts, known limitations, cleanup. Each entry has **What**, **Why deferred** and a concrete **Trigger**. Not for features: those are GitHub issues.

Remove an entry in the PR that resolves it.

---

### Delete `spikes/capture` once the recorder exists

**What**: `spikes/capture` is a throwaway page built into `dist/spikes/` and driven by `e2e/spikes/capture.spec.ts`. Not product code.
**Why deferred**: its answer (recorded in `spikes/README.md` and the DNA) is the only executable proof of the capture assumptions until the real recorder and storage worker exist.
**Trigger**: the vertical slice PR (recorder + OPFS + export). Delete the spike directory and its e2e spec in that PR. Whichever spike PR merges last also removes `spikes/README.md`, the spike glue in `scripts/build.mjs` (it throws on a missing `spikes/`) and the `spikes/**` globs in `package.json`.

### parakeet.js lists the Hub repo on every model load

**What**: `getParakeetModel` fetches `https://huggingface.co/api/models/<repo>/tree/main` before it looks in its IndexedDB cache, so every model load pings huggingface.co (metadata, never audio). Offline, the listing fails and the loader then skips the optional external-data file, so the WebGPU fp32 encoder cannot load offline; the default int8 WASM model loads from the cache fine.
**Why deferred**: metadata to the one permitted host stays within the privacy invariant; the offline case only bites the optional backend.
**Trigger**: offline transcription becoming a requirement, or a parakeet.js release that checks the cache first. The fix is local to `src/lib/asr/parakeet.ts`: resolve the four file URLs with `getModelFile` (the names are deterministic per quantisation) and call `ParakeetModel.fromUrls` without `getParakeetModel`.

### Extension icons

**What**: `src/manifest.json` declares no icons, so the toolbar shows Chrome's default puzzle piece. The badge (recording state) works regardless.
**Why deferred**: cosmetic.
**Trigger**: the vertical slice PR, when the badge design is decided anyway.
