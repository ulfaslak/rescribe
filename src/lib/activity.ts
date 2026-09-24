// Turns a wobbling value into an activity signal. Meet's per-participant audio meter changes its
// class list with the audio level while someone speaks and holds still otherwise, so "changed
// recently" is a speaking signal that does not depend on knowing which class means what.

export class ChangeActivity {
  private readonly last = new Map<string, { value: string; changedAt: number }>();
  private readonly windowMs: number;

  // No parameter properties: Node runs these files with type stripping only (DEVELOPMENT § Commands).
  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /** Record the current value for `key` at time `now` (ms). Returns whether it changed within the window. */
  observe(key: string, value: string, now: number): boolean {
    const prev = this.last.get(key);
    if (!prev) {
      this.last.set(key, { value, changedAt: Number.NEGATIVE_INFINITY });
      return false;
    }
    if (prev.value !== value) {
      prev.value = value;
      prev.changedAt = now;
    }
    return now - prev.changedAt <= this.windowMs;
  }

  forget(key: string): void {
    this.last.delete(key);
  }
}
