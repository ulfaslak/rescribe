// Turns a wobbling value into an activity signal. Meet's per-participant audio meter changes its
// class list with the audio level while someone speaks and holds still otherwise, so "changed
// recently" is a speaking signal that does not depend on knowing which class means what.
//
// A run is a sequence of changes each within `windowMs` of the previous one. A key is active
// while its current run has at least two changes (one lone flip, such as a hover style, is not
// speech) and the latest change is within `windowMs` of now. Consumers stamp the start of speech
// at `startedAt` (the run's first change) and the end at `lastChangeAt`, never at observation
// time, so polling latency and background-tab timer throttling do not shift the timeline.

interface Entry {
  value?: string;
  runStart: number;
  runCount: number;
  latest: number;
  /** Last change of the most recent run that reached activity, once a newer run has begun. */
  activeEnd: number;
}

export class ChangeActivity {
  private readonly entries = new Map<string, Entry>();
  private readonly windowMs: number;

  // No parameter properties: Node runs these files with type stripping only (DEVELOPMENT § Commands).
  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /** Record that `key`'s value changed at `now` (ms). */
  touch(key: string, now: number): void {
    const e = this.entries.get(key) ?? {
      runStart: now,
      runCount: 0,
      latest: Number.NEGATIVE_INFINITY,
      activeEnd: Number.NEGATIVE_INFINITY,
    };
    if (now - e.latest <= this.windowMs) {
      e.runCount++;
    } else {
      if (e.runCount >= 2) e.activeEnd = e.latest;
      e.runStart = now;
      e.runCount = 1;
    }
    e.latest = now;
    this.entries.set(key, e);
  }

  /** Record the current value; a difference from the previous value counts as a change. Returns isActive. */
  observe(key: string, value: string, now: number): boolean {
    const e = this.entries.get(key);
    if (!e) {
      this.entries.set(key, {
        value,
        runStart: now,
        runCount: 0,
        latest: Number.NEGATIVE_INFINITY,
        activeEnd: Number.NEGATIVE_INFINITY,
      });
      return false;
    }
    if (e.value !== value) {
      e.value = value;
      this.touch(key, now);
    }
    return this.isActive(key, now);
  }

  isActive(key: string, now: number): boolean {
    const e = this.entries.get(key);
    return !!e && e.runCount >= 2 && now - e.latest <= this.windowMs;
  }

  /** First change of the current run, or undefined when the key was never touched. */
  startedAt(key: string): number | undefined {
    const e = this.entries.get(key);
    return e && e.runCount > 0 ? e.runStart : undefined;
  }

  /** Most recent change, or undefined when the key was never touched. */
  lastChangeAt(key: string): number | undefined {
    const e = this.entries.get(key);
    return e && e.runCount > 0 ? e.latest : undefined;
  }

  /**
   * When the activity ended: the last change of the current run if it is (or was) active, else
   * the last change of the previous active run. A lone change that opens a new run does not move
   * it. Undefined when the key never became active.
   */
  activeUntil(key: string): number | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.runCount >= 2) return e.latest;
    return Number.isFinite(e.activeEnd) ? e.activeEnd : undefined;
  }

  forget(key: string): void {
    this.entries.delete(key);
  }
}
