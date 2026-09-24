// The only wall-clock ↔ recording-time conversion. Content scripts stamp events with Date.now();
// everything in the pipeline runs on seconds from the recording's first captured sample.
// See AGENTS/DNA/INVARIANTS.md § "Every timestamp in the pipeline is recording-relative seconds".

/** Epoch ms → seconds from recording start. Negative when the event predates the recording. */
export function toRecordingSeconds(atEpochMs: number, startedAtEpochMs: number): number {
  return (atEpochMs - startedAtEpochMs) / 1000;
}

/** Seconds from recording start → epoch ms. Inverse of toRecordingSeconds. */
export function toEpochMs(seconds: number, startedAtEpochMs: number): number {
  return startedAtEpochMs + seconds * 1000;
}
