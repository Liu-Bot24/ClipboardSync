import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { installSingleInstanceGuard } from '../src/client/single-instance.js';

function fakeApp(lockResult) {
  const app = new EventEmitter();
  app.quitCalls = 0;
  app.requestSingleInstanceLock = () => lockResult;
  app.quit = () => {
    app.quitCalls += 1;
  };
  return app;
}

test('installSingleInstanceGuard quits the second process when the lock is unavailable', () => {
  const app = fakeApp(false);
  let focused = false;

  assert.equal(installSingleInstanceGuard(app, () => {
    focused = true;
  }), false);
  assert.equal(app.quitCalls, 1);
  assert.equal(focused, false);
  assert.equal(app.listenerCount('second-instance'), 0);
});

test('installSingleInstanceGuard focuses the existing app when another instance starts', () => {
  const app = fakeApp(true);
  let focusCalls = 0;

  assert.equal(installSingleInstanceGuard(app, () => {
    focusCalls += 1;
  }), true);
  assert.equal(app.quitCalls, 0);

  app.emit('second-instance');

  assert.equal(focusCalls, 1);
});
