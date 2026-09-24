# Deferred

Technical items intentionally postponed: tech debt, hardening shortcuts, known limitations, cleanup. Each entry has **What**, **Why deferred** and a concrete **Trigger**. Not for features: those are GitHub issues.

Remove an entry in the PR that resolves it.

---

### Delete `spikes/` once its answers live in `src/`

**What**: `spikes/capture` and `spikes/parakeet` are throwaway pages built into `dist/spikes/` and driven by `e2e/spikes/*.spec.ts`. They are not product code.
**Why deferred**: their answers (recorded in `spikes/README.md` and the DNA) are still the only executable proof of the capture and ASR assumptions until the real recorder and transcribe worker exist.
**Trigger**: the vertical slice PR (recorder + OPFS + export) for `capture`; the transcription PR for `parakeet`. Delete the spike, its e2e spec and the build-script glue in the same PR.

### Extension icons

**What**: `src/manifest.json` declares no icons, so the toolbar shows Chrome's default puzzle piece. The badge (recording state) works regardless.
**Why deferred**: cosmetic.
**Trigger**: the vertical slice PR, when the badge design is decided anyway.
