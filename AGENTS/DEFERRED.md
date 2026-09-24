# Deferred

Technical items intentionally postponed: tech debt, hardening shortcuts, known limitations, cleanup. Each entry has **What**, **Why deferred** and a concrete **Trigger**. Not for features: those are GitHub issues.

Remove an entry in the PR that resolves it.

---

### Delete `spikes/capture` once the recorder exists

**What**: `spikes/capture` is a throwaway page built into `dist/spikes/` and driven by `e2e/spikes/capture.spec.ts`. Not product code.
**Why deferred**: its answer (recorded in `spikes/README.md` and the DNA) is the only executable proof of the capture assumptions until the real recorder and storage worker exist.
**Trigger**: the vertical slice PR (recorder + OPFS + export). Delete the spike directory and its e2e spec in that PR. Whichever spike PR merges last also removes `spikes/README.md`, the spike glue in `scripts/build.mjs` (it throws on a missing `spikes/`) and the `spikes/**` globs in `package.json`.

### Extension icons

**What**: `src/manifest.json` declares no icons, so the toolbar shows Chrome's default puzzle piece. The badge (recording state) works regardless.
**Why deferred**: cosmetic.
**Trigger**: the vertical slice PR, when the badge design is decided anyway.

### Self tile identified structurally by the adapter

**What**: `src/content/meet.ts` emits the human's own tile like any other participant; `eventsToEvidence` (`src/lib/evidence.ts`) recognises it only by its display label (`selfNames`, default `['You']`). A non-English Meet UI ("Du", "Vous") or a self tile whose name did not resolve (the adapter then sends the id as the name; such intervals are labelled with `unresolvedLabel`) leaks the human's own speaking into display evidence. The fix is a `self: true` flag on the `speaker` message set from a DOM attribute of the self tile.
**Why deferred**: no live observation yet of which attribute marks the self tile (`data-self-name` is a candidate, unverified), and the calibration on 2026-09-24 showed "You" on the human's tile, so the default holds for his account.
**Trigger**: the next calibration run reports which attribute marks the self tile. Then: adapter sets `self`, `eventsToEvidence` keys on it, `selfNames` goes.

### Anchor platform stamps to the audio clock

**What**: segment times will come from the 16 kHz sample count (the audio clock) while platform events are stamped with `Date.now()` (the wall clock). `src/lib/clock.ts` converts with one `startedAt` anchor, so any drift between the two clocks grows through the call: 30 ppm over 3 h is 0.32 s, the whole 0.2–0.4 s safe band of `MEET_LEAD`. Fix: the recorder logs `(Date.now(), sampleIndex)` anchors periodically and `clock.ts` interpolates between them.
**Why deferred**: no recording exists yet to measure the drift, and short calls sit well inside the band.
**Trigger**: the first transcript of a call over an hour shows handover misattribution concentrated late in the call (the LIVE_CHECKS entry on `MEET_LEAD` samples the end of the call for this reason).
