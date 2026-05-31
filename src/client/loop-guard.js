export class ClipboardLoopGuard {
  constructor(options = {}) {
    this.suppressMs = options.suppressMs ?? 2_000;
    this.now = options.now ?? (() => Date.now());
    this.applied = new Map();
  }

  pruneExpired(now = this.now()) {
    for (const [hash, appliedAt] of this.applied.entries()) {
      if (now - appliedAt > this.suppressMs) {
        this.applied.delete(hash);
      }
    }
  }

  markApplied(hash) {
    const now = this.now();
    this.pruneExpired(now);
    this.applied.set(hash, now);
  }

  shouldSuppress(hash) {
    this.pruneExpired();
    const appliedAt = this.applied.get(hash);
    if (appliedAt === undefined) {
      return false;
    }

    this.applied.delete(hash);
    return this.now() - appliedAt <= this.suppressMs;
  }
}
