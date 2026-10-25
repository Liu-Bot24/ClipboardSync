// Errors that do not describe the Hub connection. They are shown while they keep
// recurring, then the display falls back to the real connection state.
const TRANSIENT_STATES = new Set(['clipboard-error', 'hub-error', 'config-error']);

export function isTransientStatus(status) {
  return TRANSIENT_STATES.has(status?.state);
}

export class StatusTracker {
  constructor({ onChange = () => {}, transientMs = 10_000, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    this.onChange = onChange;
    this.transientMs = transientMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.connection = { state: 'starting' };
    this.transient = null;
    this.timer = null;
  }

  get current() {
    return this.transient ?? this.connection;
  }

  set(status) {
    this.clearTimeoutImpl(this.timer);
    this.timer = null;
    if (!isTransientStatus(status)) {
      this.transient = null;
      this.connection = status;
      this.onChange(this.current);
      return;
    }
    const repeated = this.transient?.state === status.state && this.transient?.message === status.message;
    this.transient = status;
    // Each repeat extends the display, so a persistent error stays visible
    // without rebroadcasting the UI on every clipboard poll.
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      this.transient = null;
      this.onChange(this.current);
    }, this.transientMs);
    this.timer?.unref?.();
    if (!repeated) this.onChange(this.current);
  }
}
