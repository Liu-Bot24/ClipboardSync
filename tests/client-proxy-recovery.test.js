import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { MacLocalProxyManager, MAC_LOCAL_PROXY_HUB_URL } from '../src/client/mac-local-proxy.js';

const readyMessage = Buffer.from('clipboard local proxy listening on 127.0.0.1:18787');
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t) {
  const h = { children: [], timers: new Map(), writes: [], now: 0, nextMode: 'ready' };
  h.manager = new MacLocalProxyManager({
    resourcesPath: '/fake/resources', userDataPath: '/fake/user',
    existsSyncImpl: () => true, mkdirImpl: async () => {},
    writeFileImpl: async (_path, content) => { h.writes.push(JSON.parse(content)); },
    now: () => h.now, retryBaseMs: 10, retryMaxMs: 40,
    setTimeoutImpl: (callback, delay) => { const timer = { callback, delay, unref() {} }; h.timers.set(timer, timer); return timer; },
    clearTimeoutImpl: timer => h.timers.delete(timer),
    spawnImpl: () => {
      const mode = h.nextMode; h.nextMode = 'ready';
      if (mode === 'throw') throw new Error('spawn failed');
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.exitCode = null;
      child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0); };
      h.children.push(child);
      if (mode === 'ready') setImmediate(() => child.stdout.emit('data', readyMessage));
      if (mode === 'fail') setImmediate(() => { child.exitCode = 1; child.emit('exit', 1); });
      return child;
    }
  });
  h.start = url => h.manager.sync({ hubUrl: url || 'http://192.0.2.10:8787', token: 'test-only' });
  h.crash = (child = h.children.at(-1)) => { child.exitCode = 1; child.emit('exit', 1); };
  h.takeTimer = () => { assert.equal(h.timers.size, 1); const timer = h.timers.values().next().value; h.timers.delete(timer); return timer; };
  h.runRetry = () => h.takeTimer().callback();
  t.after(async () => { await h.manager.stop(); for (const child of h.children) if (child.exitCode === null) child.kill(); });
  return h;
}

test('proxy recovers an unexpected exit after listening without changing its upstream', async t => {
  const h = harness(t);
  assert.equal((await h.start()).hubUrl, MAC_LOCAL_PROXY_HUB_URL);
  assert.equal(h.timers.size, 0);
  h.crash(); await h.runRetry();
  assert.equal(h.children.length, 2);
  assert.equal(h.manager.proxy.isActive(), true);
  assert.deepEqual(h.writes.map(x => x.targetUrl), ['http://192.0.2.10:8787', 'http://192.0.2.10:8787']);
});

test('proxy stop cancels recovery even when an already queued timer callback runs', async t => {
  const h = harness(t); await h.start(); h.crash();
  const timer = h.takeTimer(); await h.manager.stop(); await timer.callback();
  assert.equal(h.children.length, 1); assert.equal(h.timers.size, 0);
});

test('proxy replacement ignores old exits and obsolete recovery callbacks', async t => {
  const h = harness(t); await h.start(); h.crash(); const timer = h.takeTimer();
  await h.start('http://192.0.2.20:8787'); await timer.callback(); h.crash(h.children[0]);
  assert.equal(h.children.length, 2); assert.equal(h.timers.size, 0);
  assert.equal(h.manager.proxy.targetUrl, 'http://192.0.2.20:8787');
});

for (const url of ['https://hub.example.com', 'http://127.0.0.1:18787', '']) {
  test(`proxy recovery is disabled for direct connection ${url || '(empty)'}`, async t => {
    const h = harness(t); await h.start(); h.crash(); const timer = h.takeTimer();
    assert.equal((await h.manager.sync({ hubUrl: url })).hubUrl, url); await timer.callback();
    assert.equal(h.children.length, 1); assert.equal(h.timers.size, 0);
  });
}

test('proxy repeated sync keeps one process and one recovery schedule', async t => {
  const h = harness(t); await h.start(); await h.start(); await h.start();
  assert.equal(h.children.length, 1); h.crash();
  assert.equal(h.timers.size, 1); await h.runRetry();
  assert.equal(h.children.length, 2); assert.equal(h.timers.size, 0);
});

test('proxy retries failed recovery with bounded backoff and resets after stable uptime', async t => {
  const h = harness(t); await h.start(); h.crash();
  const delays = [];
  for (let i = 0; i < 4; i++) {
    const timer = h.takeTimer(); delays.push(timer.delay); h.nextMode = i % 2 ? 'throw' : 'fail'; await timer.callback();
  }
  assert.deepEqual(delays, [10, 20, 40, 40]);
  await h.runRetry(); h.now += 30_001; h.crash();
  assert.equal(h.takeTimer().delay, 10);
});

test('proxy initial startup failure is reported and does not start a hidden retry loop', async t => {
  const h = harness(t); h.nextMode = 'fail';
  await assert.rejects(h.start(), /exited before listening/);
  assert.equal(h.timers.size, 0);
});

test('proxy recovery in flight cannot resurrect a stopped manager', async t => {
  const h = harness(t); await h.start(); h.crash(); h.nextMode = 'wait';
  const recovery = h.runRetry(); await tick();
  assert.equal(h.children.length, 2); await h.manager.stop(); await recovery;
  assert.equal(h.children[1].killed, true); assert.equal(h.timers.size, 0);
});

test('proxy recovery in flight cannot replace the latest requested Hub', async t => {
  const h = harness(t); await h.start(); h.crash(); h.nextMode = 'wait';
  const recovery = h.runRetry(); await tick();
  const switched = h.start('http://192.0.2.20:8787');
  h.children[1].stdout.emit('data', readyMessage);
  await recovery; await switched;
  assert.equal(h.children[1].killed, true);
  assert.equal(h.manager.proxy.targetUrl, 'http://192.0.2.20:8787'); assert.equal(h.timers.size, 0);
});

test('proxy invalid settings do not interrupt a healthy existing connection', async t => {
  const h = harness(t); await h.start();
  await assert.rejects(h.start('http://['));
  assert.equal(h.manager.proxy.isActive(), true); assert.equal(h.children.length, 1); assert.equal(h.timers.size, 0);
});
