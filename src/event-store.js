import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, appendFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { ValidationError } from './event-validation.js';

function validStoredEvent(event) {
  return event && typeof event === 'object' && !Array.isArray(event) &&
    typeof event.id === 'string' && event.id.length > 0 &&
    Number.isSafeInteger(event.sequence) && event.sequence > 0 &&
    Number.isFinite(Date.parse(event.createdAt)) &&
    typeof event.sourceDeviceId === 'string' &&
    ['text/plain', 'image/png', 'image/jpeg', 'image/webp'].includes(event.contentType) &&
    event.encoding === (event.contentType === 'text/plain' ? 'utf8' : 'base64') &&
    typeof event.content === 'string' && typeof event.sha256 === 'string' &&
    (!event.targetDeviceIds || (Array.isArray(event.targetDeviceIds) && event.targetDeviceIds.every((id) => typeof id === 'string')));
}

function historyEntryBytes(event) {
  return Buffer.byteLength(`${JSON.stringify(event)}\n`, 'utf8');
}

function targetKey(event) {
  return JSON.stringify(Array.isArray(event.targetDeviceIds) ? event.targetDeviceIds.slice().sort() : null);
}

function eventIdentity(event) {
  return event.clientEventId ? `${event.sourceDeviceId}:${event.clientEventId}` : null;
}

function eventSignature(event) {
  return `${event.contentType}:${event.encoding}:${event.sha256}:${targetKey(event)}`;
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
    this.eventBytes = new WeakMap();
    this.totalBytes = 0;
    this.fileBytes = 0;
    this.dirty = false;
    this.maintenanceError = null;
    this.onMaintenanceError = options.onMaintenanceError ?? (() => {});
    this.maxQueuedEntries = options.maxQueuedEntries ?? 256;
    this.maxQueuedBytes = options.maxQueuedBytes ?? 128 * 1024 * 1024;
    this.queuedEntries = 0;
    this.queuedBytes = 0;
    this.receipts = new Map();
  }

  async ready() {
    await mkdir(dirname(this.historyPath), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.historyPath), 0o700);

    let corrupt = false;
    let historyFileExists = false;
    let lastByte;
    try {
      // Create the file before append commits; permission maintenance cannot fail after a commit.
      await appendFile(this.historyPath, '', { mode: 0o600 });
      historyFileExists = true;
      await chmod(this.historyPath, 0o600);
      const input = createReadStream(this.historyPath);
      input.on('data', (chunk) => {
        this.fileBytes += chunk.length;
        lastByte = chunk.at(-1);
      });
      const lines = createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { corrupt = true; continue; }
        if (!validStoredEvent(event)) { corrupt = true; continue; }
        this.nextSequenceNumber = Math.max(this.nextSequenceNumber, event.sequence + 1);
        this.events.push(event);
        const bytes = historyEntryBytes(event);
        this.eventBytes.set(event, bytes);
        this.totalBytes += bytes;
        this.pruneMemory();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    if (corrupt && historyFileExists) {
      const backupPath = `${this.historyPath}.broken-${this.now().getTime()}`;
      await copyFile(this.historyPath, backupPath);
      await chmod(backupPath, 0o600);
      await this.pruneBrokenBackups();
    }
    if (corrupt || this.dirty || (lastByte !== undefined && lastByte !== 10) || this.fileBytes > this.maxHistoryBytes) {
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
    const bytes = historyEntryBytes(event);
    if (this.queuedEntries >= this.maxQueuedEntries || this.queuedBytes + bytes > this.maxQueuedBytes) {
      throw new ValidationError('history queue is full; retry later');
    }
    this.queuedEntries += 1;
    this.queuedBytes += bytes;
    const operation = this.appendQueue.then(() => this.appendNow(event)).finally(() => {
      this.queuedEntries -= 1;
      this.queuedBytes -= bytes;
    });
    this.appendQueue = operation.catch(() => {});
    return operation;
  }

  async clear() {
    const operation = this.appendQueue.then(() => this.clearNow());
    this.appendQueue = operation.catch(() => {});
    return operation;
  }

  async appendNow(event) {
    const now = this.now();
    const identity = eventIdentity(event);
    for (const [key, receipt] of this.receipts) {
      if (now.getTime() - receipt.at > 600_000) this.receipts.delete(key);
    }
    const previous = identity && (this.receipts.get(identity) || this.events.find((item) => eventIdentity(item) === identity));
    if (previous) {
      if ((previous.signature ?? eventSignature(previous)) !== eventSignature(event)) {
        throw new ValidationError('clientEventId was reused for a different event');
      }
      return null;
    }
    if (this.maintenanceError) {
      await this.tryCompact();
      if (this.maintenanceError) throw new ValidationError('history maintenance failed; retry after storage recovers');
    }

    const stored = {
      ...event,
      id: randomUUID(),
      sequence: this.nextSequenceNumber,
      createdAt: now.toISOString()
    };
    const serialized = `${JSON.stringify(stored)}\n`;
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > this.maxHistoryBytes) throw new ValidationError('event exceeds the history byte budget');
    try {
      await appendFile(this.historyPath, serialized, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      // A rejected append may have written a prefix. Rebuild from committed
      // records before accepting another append onto this uncertain tail.
      this.dirty = true;
      this.maintenanceError = error;
      try { this.onMaintenanceError(error); } catch { /* Preserve the write error. */ }
      throw error;
    }
    this.nextSequenceNumber += 1;
    if (identity) {
      this.receipts.set(identity, { signature: eventSignature(event), at: now.getTime() });
      while (this.receipts.size > 4096) this.receipts.delete(this.receipts.keys().next().value);
    }
    this.events.push(stored);
    this.eventBytes.set(stored, bytes);
    this.totalBytes += bytes;
    this.fileBytes += bytes;
    this.pruneMemory();
    if (this.dirty && (this.fileBytes > this.maxHistoryBytes || this.totalBytes <= this.fileBytes * 0.75)) {
      await this.tryCompact();
    }
    return stored;
  }

  safeLimit(limit) {
    return Math.max(0, Math.min(Number.parseInt(limit, 10) || 0, this.maxHistoryEntries));
  }

  recent(limit = 50) {
    const safeLimit = this.safeLimit(limit);
    return safeLimit === 0 ? [] : this.liveEvents().slice(-safeLimit);
  }

  recentWhere(limit = 50, predicate) {
    const safeLimit = this.safeLimit(limit);
    return safeLimit === 0 ? [] : this.liveEvents().filter(predicate).slice(-safeLimit);
  }

  liveEvents() {
    const cutoff = this.now().getTime() - this.maxHistoryAgeMs;
    return this.events.filter((event) => Date.parse(event.createdAt) >= cutoff);
  }

  async clearNow() {
    const cleared = this.events.length;
    await this.compact([]);
    this.events = [];
    this.totalBytes = 0;
    return cleared;
  }

  pruneMemory() {
    const originalLength = this.events.length;
    const cutoff = this.now().getTime() - this.maxHistoryAgeMs;

    this.events = this.events.filter((event) => {
      if (Date.parse(event.createdAt) >= cutoff) return true;
      this.totalBytes -= this.eventBytes.get(event) ?? historyEntryBytes(event);
      return false;
    });

    while (this.events.length && (this.events.length > this.maxHistoryEntries || this.totalBytes > this.maxHistoryBytes)) {
      const event = this.events.shift();
      this.totalBytes -= this.eventBytes.get(event) ?? historyEntryBytes(event);
    }

    const pruned = this.events.length !== originalLength;
    this.dirty ||= pruned;
    return pruned;
  }

  async tryCompact() {
    try {
      await this.compact();
    } catch (error) {
      this.maintenanceError = error;
      try { this.onMaintenanceError(error); } catch { /* Reporting must not undo a committed append. */ }
    }
  }

  async maintain() {
    const operation = this.appendQueue.then(async () => {
      this.pruneMemory();
      if (this.dirty) await this.tryCompact();
    });
    this.appendQueue = operation.catch(() => {});
    return operation;
  }

  async compact(events = this.events) {
    const content = events.map((event) => JSON.stringify(event)).join('\n');
    const tempPath = `${this.historyPath}.tmp`;
    await writeFile(tempPath, content ? `${content}\n` : '', { encoding: 'utf8', mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, this.historyPath);
    this.fileBytes = Buffer.byteLength(content ? `${content}\n` : '', 'utf8');
    this.dirty = false;
    this.maintenanceError = null;
  }
}
