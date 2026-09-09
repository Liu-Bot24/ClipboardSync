import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/event-store.js';
import { textSnapshot } from '../src/client/clipboard-content.js';

for (const prefixBytes of [0, 31]) for (const repairBlocked of [false, true]) test(`failed append (${prefixBytes} bytes) preserves later records, repair blocked=${repairBlocked}`, async (t) => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'clipboard-partial-'));
  const path = join(dir, 'history.jsonl');
  const event = (content) => ({ ...textSnapshot(content), sha256: textSnapshot(content).hash, type: 'clipboard.update', sourceDeviceId: 'A', clientEventId: content });
  const store = new EventStore(path);
  const originalAppend = fs.appendFile;
  try {
    await store.ready();
    await store.append(event('committed'));
    let inject = true;
    t.mock.method(fs, 'appendFile', async (file, data, options) => {
      if (inject && file === path && data) {
        inject = false;
        await originalAppend(file, data.slice(0, prefixBytes), options);
        throw Object.assign(new Error('injected partial write'), { code: 'ENOSPC' });
      }
      return originalAppend(file, data, options);
    });
    syncBuiltinESMExports();
    await assert.rejects(store.append(event('failed')), /injected partial write/);
    assert.deepEqual(store.recent().map((item) => item.content), ['committed']);
    if (repairBlocked) {
      await fs.mkdir(`${path}.tmp`);
      await assert.rejects(store.append(event('must-not-commit')), /maintenance/);
      assert.deepEqual(store.recent().map((item) => item.content), ['committed']);
      await fs.rmdir(`${path}.tmp`);
    }
    await store.append(event('later'));
    const retry = await store.append(event('failed'));
    assert.equal(await store.append(event('failed')), null);
    assert.equal(retry.sequence, 3);
    await store.maintain();
    const restored = new EventStore(path);
    await restored.ready();
    assert.deepEqual(restored.recent().map((item) => item.content), ['committed', 'later', 'failed']);
    assert.equal(await restored.append(event('failed')), null);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
