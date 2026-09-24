# Deferred

Technical items intentionally postponed: tech debt, hardening shortcuts, known limitations, cleanup. Each entry has **What**, **Why deferred** and a concrete **Trigger**. Not for features: those are GitHub issues.

Remove an entry in the PR that resolves it.

---

### Delete `spikes/parakeet` once the transcribe worker exists

**What**: `spikes/parakeet` is a throwaway page built into `dist/spikes/` and driven by `e2e/spikes/parakeet.spec.ts`. Not product code.
**Why deferred**: its answer is the only executable proof of the ASR assumptions until the real transcribe worker exists.
**Trigger**: the transcription PR. Delete the spike directory and its e2e spec in that PR. It is the last spike, so also remove `spikes/README.md`, the spike glue in `scripts/build.mjs` (it throws on a missing `spikes/`) and the `spikes/**` globs in `package.json`.

### WebM exports carry no duration header

**What**: a MediaRecorder WebM is a live stream: the header has no `Duration` element, so `ffprobe` reports none and players show an unknown length until they parse the whole file. The MP4 path is unaffected (fragmented MP4 with `mfra`; see the QuickTime live check).
**Why deferred**: WebM is the non-default container; remuxing on export means shipping a muxer.
**Trigger**: the human uses WebM and a player refuses to seek, or a downstream tool needs the duration.

### `meta.json` is not written on stop

**What**: PRODUCT lists `meta.json` (when, what was captured, roster, model) among the assets; the vertical slice writes only the video on stop.
**Why deferred**: half of its content (roster, model and version) exists only once #2 and #3 land; one write at transcription completion beats two.
**Trigger**: the transcription PR (#2) writes it alongside `transcript.md`.
