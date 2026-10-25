import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { parseWatcherLine, WindowsForegroundWatcher, windowsWatcherScript } from '../src/client/windows-foreground-watcher.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function sampleLine(requestId, title = 'Notepad') {
  return `${JSON.stringify({
    requestId,
    target: { hwnd: 10, pid: 20, className: 'Notepad', processName: 'notepad', title, canPaste: true },
    source: { platform: 'win32', ownerHwnd: 30, ownerPid: 40, processName: 'code', title: 'editor' }
  })}\n`;
}

function harness(options = {}) {
  const h = { children: [], timers: new Set(), now: 0 };
  h.watcher = new WindowsForegroundWatcher({
    now: () => h.now,
    setTimeoutImpl: (callback, delay) => { const timer = { callback, delay }; h.timers.add(timer); return timer; },
    clearTimeoutImpl: (timer) => h.timers.delete(timer),
    setIntervalImpl: () => ({}),
    clearIntervalImpl: () => {},
    spawnImpl: (file, args, spawnOptions) => {
      const child = new EventEmitter();
      child.file = file;
      child.args = args;
      child.options = spawnOptions;
      child.exitCode = null;
      child.stdout = new PassThrough();
      child.written = [];
      child.stdin = { write: (data) => child.written.push(data), end() {}, on() {} };
      child.kill = () => { child.exitCode = 1; child.emit('exit', 1); };
      h.children.push(child);
      return child;
    },
    ...options
  });
  h.timer = (delay) => [...h.timers].find((timer) => timer.delay === delay);
  return h;
}

test('parseWatcherLine reads target and clipboard owner, tolerating a UTF-8 BOM', () => {
  const sample = parseWatcherLine(`﻿${sampleLine(3, '记事本')}`);
  assert.equal(sample.requestId, 3);
  assert.equal(sample.target.title, '记事本');
  assert.equal(sample.target.canPaste, true);
  assert.equal(sample.source.processName, 'code');
  assert.equal(parseWatcherLine('not json'), null);
});

test('windowsWatcherScript compiles helpers once and exits on stdin EOF', () => {
  const script = windowsWatcherScript(1_000);
  assert.equal((script.match(/Add-Type @"/g) || []).length, 1);
  assert.match(script, /\$read\.Wait\(1000\)/);
  assert.match(script, /if \(\$count -le 0\) \{ break \}/);
});

test('WindowsForegroundWatcher spawns one hidden PowerShell with an encoded command', () => {
  const h = harness();
  h.watcher.start();
  h.watcher.start();
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0].file, 'powershell.exe');
  assert.ok(h.children[0].args.includes('-EncodedCommand'));
  assert.equal(h.children[0].options.windowsHide, true);
  h.watcher.stop();
});

test('WindowsForegroundWatcher emits periodic samples', async () => {
  const h = harness();
  const samples = [];
  h.watcher.on('sample', (sample) => samples.push(sample.target.title));
  h.watcher.start();
  h.children[0].stdout.write(sampleLine(0, 'first'));
  await tick();
  assert.deepEqual(samples, ['first']);
  h.watcher.stop();
});

test('WindowsForegroundWatcher request ignores samples taken before the request', async () => {
  const h = harness();
  h.watcher.start();
  const child = h.children[0];
  const reply = h.watcher.request();
  assert.deepEqual(child.written, ['1\n']);
  let resolved = null;
  reply.then((sample) => { resolved = sample; });

  child.stdout.write(sampleLine(0, 'stale'));
  await tick();
  assert.equal(resolved, null);

  child.stdout.write(sampleLine(1, 'fresh'));
  await tick();
  assert.equal(resolved.target.title, 'fresh');
  h.watcher.stop();
});

test('WindowsForegroundWatcher request resolves null on timeout or when not running', async () => {
  const h = harness();
  assert.equal(await h.watcher.request(), null);
  h.watcher.start();
  const reply = h.watcher.request();
  h.timer(1_500).callback();
  assert.equal(await reply, null);
  h.watcher.stop();
});

test('WindowsForegroundWatcher restarts an exited process with backoff and fails pending requests', async () => {
  const h = harness();
  h.watcher.start();
  const reply = h.watcher.request();
  h.children[0].kill();
  assert.equal(await reply, null);
  assert.equal(h.watcher.isRunning(), false);
  const restart = h.timer(1_000);
  assert.ok(restart);
  h.timers.delete(restart);
  restart.callback();
  assert.equal(h.children.length, 2);
  h.children[1].kill();
  assert.ok(h.timer(2_000));
  h.watcher.stop();
  assert.equal(h.timers.size, 0);
});

test('WindowsForegroundWatcher kills a stalled process so it can restart', () => {
  const h = harness({ stallMs: 15_000 });
  h.watcher.start();
  h.now = 15_001;
  h.watcher.checkStall();
  assert.equal(h.children[0].exitCode, 1);
  assert.ok(h.timer(1_000));
  h.watcher.stop();
});

test('WindowsForegroundWatcher stop prevents restart after exit', () => {
  const h = harness();
  h.watcher.start();
  const child = h.children[0];
  h.watcher.stop();
  assert.equal(child.exitCode, 1);
  assert.equal(h.timers.size, 0);
});
