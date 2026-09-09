import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventStore } from '../src/event-store.js';

export async function benchmarkHistory({ entries = 100, additions = 10, contentBytes = 8192 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'clipboard-history-benchmark-'));
  const store = new EventStore(join(dir, 'history.jsonl'), { maxHistoryEntries: entries });
  const event = (index) => ({ type: 'clipboard.update', clientEventId: `event-${index}`, sourceDeviceId: 'benchmark',
    contentType: 'text/plain', encoding: 'utf8', content: `${index}:`.padEnd(contentBytes, 'x'), sha256: String(index), byteLength: contentBytes });
  try {
    await store.ready();
    for (let index = 0; index < entries; index++) await store.append(event(index));
    let compactions = 0; let compactBytes = 0; let appendedBytes = 0;
    const compact = store.compact.bind(store);
    store.compact = async (...args) => {
      compactions++;
      compactBytes += Buffer.byteLength(store.events.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
      return compact(...args);
    };
    const start = performance.now();
    for (let index = entries; index < entries + additions; index++) {
      const stored = await store.append(event(index));
      appendedBytes += Buffer.byteLength(`${JSON.stringify(stored)}\n`);
    }
    return { entries, additions, contentBytes, compactions, appendedBytes, compactBytes,
      logicalWriteAmplification: (appendedBytes + compactBytes) / appendedBytes,
      elapsedMs: performance.now() - start, retained: store.recent(entries).length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await benchmarkHistory(), null, 2));
  console.log(JSON.stringify(await benchmarkHistory({ additions: 1000 }), null, 2));
}
