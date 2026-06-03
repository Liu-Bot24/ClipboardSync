import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, appendFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

function parseHistory(content) {
  const events = [];
  let corrupt = false;

  for (const line of content.split('\n').filter(Boolean)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      corrupt = true;
    }
  }

  return { events, corrupt };
}

function historyEntryBytes(event) {
  return Buffer.byteLength(`${JSON.stringify(event)}\n`, 'utf8');
}

function targetKey(event) {
  return Array.isArray(event.targetDeviceIds) ? event.targetDeviceIds.slice().sort().join('\n') : '';
}

function isAdjacentDuplicate(previous, event) {
  if (!previous) {
    return false;
  }
  return (
    previous.sourceDeviceId === event.sourceDeviceId &&
    previous.contentType === event.contentType &&
    previous.encoding === event.encoding &&
    previous.sha256 === event.sha256 &&
    previous.content === event.content &&
    targetKey(previous) === targetKey(event)
  );
}

function samePayload(left, right) {
  return (
    left.contentType === right.contentType &&
    left.encoding === right.encoding &&
    left.sha256 === right.sha256 &&
    left.content === right.content
  );
}

function isRecentCrossDeviceEcho(events, event, nowMs, windowMs) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return false;
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const previous = events[index];
    const previousMs = Date.parse(previous.createdAt);
    if (Number.isNaN(previousMs)) {
      continue;
    }
    if (nowMs - previousMs > windowMs) {
      return false;
    }
    if (previous.sourceDeviceId !== event.sourceDeviceId && samePayload(previous, event)) {
      return true;
    }
  }
  return false;
}

export class EventStore {
  constructor(historyPath, options = {}) {
    this.historyPath = historyPath;
    this.maxHistoryEntries = options.maxHistoryEntries ?? 200;
    this.maxHistoryBytes = options.maxHistoryBytes ?? Number.POSITIVE_INFINITY;
    this.maxHistoryAgeMs = options.maxHistoryAgeMs ?? Number.POSITIVE_INFINITY;
    this.duplicateContentWindowMs = options.duplicateContentWindowMs ?? 30_000;
    this.maxBrokenBackups = options.maxBrokenBackups ?? 3;
    this.now = options.now ?? (() => new Date());
    this.events = [];
    this.nextSequenceNumber = 1;
    this.appendQueue = Promise.resolve();
  }

  async ready() {
    await mkdir(dirname(this.historyPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.historyPath), 0o700);

    let content = '';
    let historyFileExists = false;
    try {
      content = await readFile(this.historyPath, 'utf8');
      historyFileExists = true;
      await chmod(this.historyPath, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    const parsed = parseHistory(content);
    this.events = parsed.events;

    const lastSequence = this.events.reduce(
      (max, event) => Math.max(max, Number.isInteger(event.sequence) ? event.sequence : 0),
      0
    );
    this.nextSequenceNumber = lastSequence + 1;
    if (parsed.corrupt && historyFileExists) {
      const backupPath = `${this.historyPath}.broken-${this.now().getTime()}`;
      await copyFile(this.historyPath, backupPath);
      await chmod(backupPath, 0o600);
      await this.pruneBrokenBackups();
    }
    const pruned = this.pruneMemory();
    if (parsed.corrupt || pruned) {
      await this.compact();
    }
  }

  async pruneBrokenBackups() {
    const dir = dirname(this.historyPath);
    const prefix = `${basename(this.historyPath)}.broken-`;
    const backups = (await readdir(dir))
      .filter((file) => file.startsWith(prefix))
      .map((file) => ({
        file,
        suffix: Number.parseInt(file.slice(prefix.length), 10)
      }))
      .sort((a, b) => {
        if (Number.isNaN(a.suffix) && Number.isNaN(b.suffix)) {
          return b.file.localeCompare(a.file);
        }
        if (Number.isNaN(a.suffix)) {
          return 1;
        }
        if (Number.isNaN(b.suffix)) {
          return -1;
        }
        return b.suffix - a.suffix;
      });

    for (const [index, backup] of backups.entries()) {
      const path = join(dir, backup.file);
      if (index < this.maxBrokenBackups) {
        await chmod(path, 0o600);
      } else {
        await unlink(path);
      }
    }
  }

  async append(event) {
    const operation = this.appendQueue.then(() => this.appendNow(event));
    this.appendQueue = operation.catch(() => {});
    return operation;
  }

  async clear() {
    const operation = this.appendQueue.then(() => this.clearNow());
    this.appendQueue = operation.catch(() => {});
    return operation;
  }

  async appendNow(event) {
    if (isAdjacentDuplicate(this.events.at(-1), event)) {
      return null;
    }
    const now = this.now();
    if (isRecentCrossDeviceEcho(this.events, event, now.getTime(), this.duplicateContentWindowMs)) {
      return null;
    }

    const stored = {
      ...event,
      id: randomUUID(),
      sequence: this.nextSequenceNumber,
      createdAt: now.toISOString()
    };
    this.nextSequenceNumber += 1;

    await appendFile(this.historyPath, `${JSON.stringify(stored)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(this.historyPath, 0o600);
    this.events.push(stored);
    if (this.pruneMemory()) {
      await this.compact();
    }
    return stored;
  }

  safeLimit(limit) {
    return Math.max(0, Math.min(Number.parseInt(limit, 10) || 0, this.maxHistoryEntries));
  }

  recent(limit = 50) {
    const safeLimit = this.safeLimit(limit);
    return safeLimit === 0 ? [] : this.events.slice(-safeLimit);
  }

  recentWhere(limit = 50, predicate) {
    const safeLimit = this.safeLimit(limit);
    return safeLimit === 0 ? [] : this.events.filter(predicate).slice(-safeLimit);
  }

  async clearNow() {
    const cleared = this.events.length;
    this.events = [];
    await this.compact();
    return cleared;
  }

  pruneMemory() {
    const originalLength = this.events.length;
    const cutoff = this.now().getTime() - this.maxHistoryAgeMs;

    this.events = this.events.filter((event) => {
      const createdAtMs = Date.parse(event.createdAt);
      return Number.isNaN(createdAtMs) || createdAtMs >= cutoff;
    });

    if (this.events.length > this.maxHistoryEntries) {
      this.events = this.events.slice(-this.maxHistoryEntries);
    }

    while (
      this.events.length > 1 &&
      this.events.reduce((total, event) => total + historyEntryBytes(event), 0) > this.maxHistoryBytes
    ) {
      this.events.shift();
    }

    return this.events.length !== originalLength;
  }

  async compact() {
    const content = this.events.map((event) => JSON.stringify(event)).join('\n');
    const tempPath = `${this.historyPath}.tmp`;
    await writeFile(tempPath, content ? `${content}\n` : '', { encoding: 'utf8', mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, this.historyPath);
    await chmod(this.historyPath, 0o600);
  }
}
