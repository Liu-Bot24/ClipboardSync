import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { EventStore } from '../src/event-store.js';

const baseEvent = {
  type: 'clipboard.update',
  sourceDeviceId: 'main-pc',
  contentType: 'text/plain',
  encoding: 'utf8',
  content: 'hello',
  byteLength: 5,
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
};

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-hub-store-'));
  try {
    await fn(join(dir, 'history.jsonl'));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

test('EventStore appends events with identity and sequence metadata', async () => {
  await withTempStore(async (historyPath) => {
    const store = new EventStore(historyPath, { maxHistoryEntries: 10 });
    await store.ready();

    const stored = await store.append(baseEvent);

    assert.equal(stored.sequence, 1);
    assert.match(stored.id, /^[0-9a-f-]{36}$/);
    assert.equal(stored.sourceDeviceId, 'main-pc');
    assert.ok(Date.parse(stored.createdAt));
    assert.deepEqual(store.recent(10), [stored]);
  });
});

test('EventStore skips adjacent duplicate events from the same source and targets', async () => {
  await withTempStore(async (historyPath) => {
    const store = new EventStore(historyPath, { maxHistoryEntries: 10 });
    await store.ready();

    const first = await store.append({ ...baseEvent, targetDeviceIds: ['macbook', 'mac-mini'] });
    const duplicate = await store.append({ ...baseEvent, targetDeviceIds: ['mac-mini', 'macbook'] });

    assert.equal(duplicate, null);
    assert.deepEqual(store.recent(10), [first]);
    assert.equal((await readFile(historyPath, 'utf8')).trim().split('\n').length, 1);
  });
});

test('EventStore stores the same payload again after another clipboard event intervenes', async () => {
  await withTempStore(async (historyPath) => {
    const store = new EventStore(historyPath, { maxHistoryEntries: 10 });
    await store.ready();

    const first = await store.append(baseEvent);
    await store.append({ ...baseEvent, content: 'other', sha256: 'other-hash' });
    const repeated = await store.append(baseEvent);

    assert.notEqual(repeated, null);
    assert.deepEqual(
      store.recent(10).map((event) => event.sha256),
      [first.sha256, 'other-hash', first.sha256]
    );
  });
});

test('EventStore reloads JSONL history on restart', async () => {
  await withTempStore(async (historyPath) => {
    const firstStore = new EventStore(historyPath, { maxHistoryEntries: 10 });
    await firstStore.ready();
    const stored = await firstStore.append(baseEvent);

    const secondStore = new EventStore(historyPath, { maxHistoryEntries: 10 });
    await secondStore.ready();

    assert.deepEqual(secondStore.recent(10), [stored]);
    const next = await secondStore.append({ ...baseEvent, content: 'later' });
    assert.equal(next.sequence, 2);
  });
});

test('EventStore keeps valid history and backs up a corrupt JSONL file on startup', async () => {
  await withTempStore(async (historyPath) => {
    await writeFile(
      historyPath,
      [
        JSON.stringify({ id: 'valid-1', sequence: 1, content: 'one', createdAt: '2026-06-01T00:00:00.000Z' }),
        '{ not valid json',
        JSON.stringify({ id: 'valid-2', sequence: 2, content: 'two', createdAt: '2026-06-01T00:00:01.000Z' })
      ].join('\n') + '\n'
    );

    const store = new EventStore(historyPath, { maxHistoryEntries: 10 });
    await store.ready();

    assert.deepEqual(
      store.recent(10).map((event) => event.id),
      ['valid-1', 'valid-2']
    );
    assert.doesNotMatch(await readFile(historyPath, 'utf8'), /not valid json/);
    assert.equal(
      (await readdir(dirname(historyPath))).some((file) => file.startsWith('history.jsonl.broken-')),
      true
    );
    const backup = (await readdir(dirname(historyPath))).find((file) => file.startsWith('history.jsonl.broken-'));
    assert.equal((await stat(join(dirname(historyPath), backup))).mode & 0o777, 0o600);
  });
});

test('EventStore prunes old corrupt history backups', async () => {
  await withTempStore(async (historyPath) => {
    await writeFile(historyPath, '{ broken json\n');
    await writeFile(`${historyPath}.broken-1000`, 'oldest\n');
    await writeFile(`${historyPath}.broken-2000`, 'older\n');
    await writeFile(`${historyPath}.broken-3000`, 'newer\n');

    const store = new EventStore(historyPath, {
      maxHistoryEntries: 10,
      maxBrokenBackups: 2,
      now: () => new Date('2026-06-01T00:00:04.000Z')
    });
    await store.ready();

    const backups = (await readdir(dirname(historyPath)))
      .filter((file) => file.startsWith('history.jsonl.broken-'))
      .sort();
    assert.equal(backups.length, 2);
    assert.equal(backups.includes('history.jsonl.broken-1000'), false);
    for (const backup of backups) {
      assert.equal((await stat(join(dirname(historyPath), backup))).mode & 0o777, 0o600);
    }
  });
});

test('EventStore tightens permissions on an existing history file during startup', async () => {
  await withTempStore(async (historyPath) => {
    await writeFile(
      historyPath,
      JSON.stringify({ id: 'valid-1', sequence: 1, content: 'one', createdAt: '2026-06-01T00:00:00.000Z' }) + '\n'
    );
    await chmod(historyPath, 0o644);

    const store = new EventStore(historyPath, { maxHistoryEntries: 10 });
    await store.ready();

    assert.equal((await stat(historyPath)).mode & 0o777, 0o600);
  });
});

test('EventStore returns newest events up to limit', async () => {
  await withTempStore(async (historyPath) => {
    const store = new EventStore(historyPath, { maxHistoryEntries: 10 });
    await store.ready();
    await store.append({ ...baseEvent, content: 'one' });
    const two = await store.append({ ...baseEvent, content: 'two' });
    const three = await store.append({ ...baseEvent, content: 'three' });

    assert.deepEqual(store.recent(2), [two, three]);
  });
});

test('EventStore returns no events when limit is zero', async () => {
  await withTempStore(async (historyPath) => {
    const store = new EventStore(historyPath, { maxHistoryEntries: 10 });
    await store.ready();
    await store.append({ ...baseEvent, content: 'one' });
    await store.append({ ...baseEvent, content: 'two' });

    assert.deepEqual(store.recent(0), []);
    assert.deepEqual(store.recentWhere(0, () => true), []);
  });
});

test('EventStore clears in-memory and persisted history', async () => {
  await withTempStore(async (historyPath) => {
    const store = new EventStore(historyPath, { maxHistoryEntries: 10 });
    await store.ready();
    await store.append({ ...baseEvent, content: 'one' });
    await store.append({ ...baseEvent, content: 'two' });

    const cleared = await store.clear();

    assert.equal(cleared, 2);
    assert.deepEqual(store.recent(10), []);
    assert.equal(await readFile(historyPath, 'utf8'), '');

    const reloaded = new EventStore(historyPath, { maxHistoryEntries: 10 });
    await reloaded.ready();
    assert.deepEqual(reloaded.recent(10), []);
  });
});

test('EventStore compacts persisted history to the newest max entries', async () => {
  await withTempStore(async (historyPath) => {
    const store = new EventStore(historyPath, { maxHistoryEntries: 2 });
    await store.ready();
    await store.append({ ...baseEvent, content: 'one' });
    const two = await store.append({ ...baseEvent, content: 'two' });
    const three = await store.append({ ...baseEvent, content: 'three' });

    assert.deepEqual(store.recent(10), [two, three]);

    const reloaded = new EventStore(historyPath, { maxHistoryEntries: 10 });
    await reloaded.ready();
    assert.deepEqual(reloaded.recent(10), [two, three]);

    const lines = (await readFile(historyPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal((await stat(historyPath)).mode & 0o777, 0o600);
  });
});

test('EventStore serializes concurrent appends before compacting history', async () => {
  await withTempStore(async (historyPath) => {
    const store = new EventStore(historyPath, { maxHistoryEntries: 5 });
    await store.ready();

    await Promise.all(
      Array.from({ length: 50 }, (_, index) => store.append({ ...baseEvent, content: String(index) }))
    );

    assert.deepEqual(
      store.recent(5).map((event) => event.content),
      ['45', '46', '47', '48', '49']
    );

    const reloaded = new EventStore(historyPath, { maxHistoryEntries: 50 });
    await reloaded.ready();
    assert.deepEqual(
      reloaded.recent(5).map((event) => event.content),
      ['45', '46', '47', '48', '49']
    );
  });
});

test('EventStore compacts persisted history to stay under max history bytes', async () => {
  await withTempStore(async (historyPath) => {
    const store = new EventStore(historyPath, {
      maxHistoryEntries: 10,
      maxHistoryBytes: 1_000
    });
    await store.ready();
    await store.append({ ...baseEvent, content: 'x'.repeat(160), byteLength: 160 });
    const second = await store.append({ ...baseEvent, content: 'y'.repeat(160), byteLength: 160 });
    const third = await store.append({ ...baseEvent, content: 'z'.repeat(160), byteLength: 160 });

    assert.deepEqual(store.recent(10), [second, third]);
    assert.ok((await stat(historyPath)).size <= 1_000);
  });
});

test('EventStore prunes events older than maxHistoryAgeMs', async () => {
  await withTempStore(async (historyPath) => {
    const times = [
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-06-08T00:00:01.000Z')
    ];
    const store = new EventStore(historyPath, {
      maxHistoryEntries: 10,
      maxHistoryAgeMs: 604_800_000,
      now: () => times.shift() ?? new Date('2026-06-08T00:00:01.000Z')
    });
    await store.ready();
    await store.append({ ...baseEvent, content: 'old' });
    const fresh = await store.append({ ...baseEvent, content: 'fresh' });

    assert.deepEqual(store.recent(10), [fresh]);
  });
});
