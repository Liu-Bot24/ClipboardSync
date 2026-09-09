export class HistoryRefreshController {
  constructor({ retryDelayMs = 250, maxRetryDelayMs = 10_000 } = {}) {
    this.revision = 0;
    this.request = 0;
    this.retryDelayMs = retryDelayMs;
    this.maxRetryDelayMs = maxRetryDelayMs;
    this.retryAttempts = 0;
    this.retryTimer = null;
    this.pending = null;
    this.followUp = false;
    this.enabled = true;
  }

  invalidate() {
    this.revision += 1;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.invalidate();
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.followUp = false;
    }
  }

  refresh(load, apply, { retryOnStale = false, onError = () => {} } = {}) {
    if (!retryOnStale) return this.refreshOnce(load, apply);
    this.latest = { load, apply, onError };
    if (!this.enabled) return Promise.resolve(false);
    if (this.pending) {
      this.followUp = true;
      return this.pending;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.followUp = false;
    const pending = this.refreshOnce(load, apply).catch((error) => {
      try { onError(error); } catch { /* Reporting must not break background refresh. */ }
      return false;
    }).then((applied) => {
      if (applied) this.retryAttempts = 0;
      else this.followUp = true;
      return applied;
    }).finally(() => {
      if (this.pending === pending) this.pending = null;
      if (this.enabled && this.followUp) {
        const delay = Math.min(this.maxRetryDelayMs, this.retryDelayMs * 2 ** Math.min(this.retryAttempts++, 6));
        this.retryTimer = setTimeout(() => {
          const latest = this.latest;
          this.refresh(latest.load, latest.apply, { retryOnStale: true, onError: latest.onError });
        }, delay);
        this.retryTimer.unref?.();
      }
    });
    this.pending = pending;
    return pending;
  }

  async refreshOnce(load, apply) {
    const revision = this.revision;
    const request = ++this.request;
    const value = await load();
    if (revision !== this.revision || request !== this.request) return false;
    apply(value);
    return true;
  }
}

export class SingleFlightSampler {
  constructor() {
    this.pending = null;
    this.generation = 0;
  }

  invalidate() {
    this.generation += 1;
  }

  sample(read, apply) {
    if (this.pending) return this.pending;
    const generation = this.generation;
    const pending = Promise.resolve().then(read).then((value) => {
      if (generation !== this.generation) return null;
      return apply(value);
    }).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }
}
