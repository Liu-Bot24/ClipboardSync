import assert from 'node:assert/strict';
import { test } from 'node:test';

import { StatusTracker } from '../src/client/status-tracker.js';

function harness() {
  const h = { changes: [], timers: new Set() };
  h.tracker = new StatusTracker({
    onChange: (status) => h.changes.push(status.state),
    setTimeoutImpl: (callback, delay) => { const timer = { callback, delay }; h.timers.add(timer); return timer; },
    clearTimeoutImpl: (timer) => h.timers.delete(timer)
  });
  h.expire = () => { const [timer] = h.timers; h.timers.delete(timer); timer.callback(); };
  return h;
}

test('StatusTracker restores the connection state after a transient error expires', () => {
  const h = harness();
  h.tracker.set({ state: 'connected' });
  h.tracker.set({ state: 'clipboard-error', message: 'read failed' });
  assert.equal(h.tracker.current.state, 'clipboard-error');
  h.expire();
  assert.equal(h.tracker.current.state, 'connected');
  assert.deepEqual(h.changes, ['connected', 'clipboard-error', 'connected']);
});

test('StatusTracker keeps a recurring error visible without repeated broadcasts', () => {
  const h = harness();
  h.tracker.set({ state: 'connected' });
  for (let i = 0; i < 5; i++) h.tracker.set({ state: 'clipboard-error', message: 'too large' });
  assert.equal(h.timers.size, 1);
  assert.deepEqual(h.changes, ['connected', 'clipboard-error']);
  h.tracker.set({ state: 'hub-error', message: 'queue full' });
  assert.deepEqual(h.changes, ['connected', 'clipboard-error', 'hub-error']);
});

test('StatusTracker lets a connection change replace a transient error immediately', () => {
  const h = harness();
  h.tracker.set({ state: 'connected' });
  h.tracker.set({ state: 'hub-error', message: 'bad message' });
  h.tracker.set({ state: 'disconnected' });
  assert.equal(h.timers.size, 0);
  assert.equal(h.tracker.current.state, 'disconnected');
});

test('StatusTracker does not treat connection failures as transient', () => {
  const h = harness();
  h.tracker.set({ state: 'connection-error', message: 'refused' });
  h.tracker.set({ state: 'duplicate-device', message: 'device replaced' });
  assert.equal(h.timers.size, 0);
  assert.equal(h.tracker.current.state, 'duplicate-device');
});
