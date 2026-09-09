import { buildTargetDeviceIds, isReceiveAllowed, shouldDeferRestrictedSend } from './policy.js';
import { decodedBufferForEvent, hashEventPayload } from './clipboard-content.js';
import { shouldIgnoreLocalClipboardSource } from './source-ignore.js';
import { randomUUID } from 'node:crypto';

function snapshotByteLength(snapshot) {
  return Number.isInteger(snapshot.byteLength) ? snapshot.byteLength : decodedBufferForEvent(snapshot).length;
}

export class ClipboardSyncService {
  constructor(options) {
    this.clipboard = options.clipboard;
    this.hub = options.hub;
    this.settingsProvider = options.settingsProvider;
    this.devicesProvider = options.devicesProvider;
    this.loopGuard = options.loopGuard;
    this.onError = options.onError ?? (() => {});
    this.onTrace = options.onTrace ?? (() => {});
    this.onSourceObserved = options.onSourceObserved ?? null;
    this.sourceProvider = options.sourceProvider ?? (() => null);
    this.pollMs = options.pollMs ?? 250;
    this.pendingAckMs = options.pendingAckMs ?? 5_000;
    this.remoteWriteRetryMs = options.remoteWriteRetryMs ?? 250;
    this.remoteWriteMaxAttempts = options.remoteWriteMaxAttempts ?? 8;
    this.setTimeout = options.setTimeout ?? setTimeout;
    this.clearTimeout = options.clearTimeout ?? clearTimeout;
    this.now = options.now ?? (() => Date.now());
    this.timer = null;
    this.remoteWriteTimers = new Set();
    this.lastLocalHash = null;
    this.pendingLocalHashes = new Map();
    this.hasLocalBaseline = false;
    this.polling = null;
    this.stopped = false;
    this.generation = 0;
    this.currentWrite = null;
    this.lastObservedHash = null;
    this.localEvent = null;
    this.submittedLocalEventId = null;
    this.boundClipboardListener = (event) => this.applyRemoteEvent(event);
    this.boundAckListener = (event) => this.acknowledgeLocalEvent(event);
  }

  start() {
    this.stop();
    this.stopped = false;
    this.establishLocalBaseline();
    this.hub.on('clipboard', this.boundClipboardListener);
    this.hub.on('ack', this.boundAckListener);
    this.timer = setInterval(() => {
      this.pollLocalClipboard();
    }, this.pollMs);
  }

  stop() {
    this.stopped = true;
    this.invalidatePendingWork();
    this.localEvent = null;
    this.submittedLocalEventId = null;
    this.pendingLocalHashes.clear();
    this.polling = null;
    clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.remoteWriteTimers) {
      this.clearTimeout(timer);
    }
    this.remoteWriteTimers.clear();
    this.hub.off?.('clipboard', this.boundClipboardListener);
    this.hub.off?.('ack', this.boundAckListener);
  }

  invalidatePendingWork() {
    this.generation += 1;
    this.cancelWrite();
  }

  updatePolicy(settings) {
    this.generation += 1;
    const operation = this.currentWrite;
    if (operation && ((operation.remote && settings.pauseReceive) || !isReceiveAllowed(operation.event, settings))) {
      this.cancelWrite();
    }
  }

  cancelWrite() {
    const operation = this.currentWrite;
    if (operation) {
      operation.controller.abort();
      this.finishWrite(operation, 'cancelled');
    }
    this.currentWrite = null;
    for (const timer of this.remoteWriteTimers) this.clearTimeout(timer);
    this.remoteWriteTimers.clear();
  }

  finishWrite(operation, status) {
    if (operation.status !== 'pending') return;
    operation.status = status;
    operation.acceptPrevious = null;
    operation.resolve(status === 'succeeded');
  }

  beginWrite(event, remote, acceptPrevious = null) {
    this.invalidatePendingWork();
    const operation = { event, hash: hashEventPayload(event), remote, acceptPrevious, status: 'pending', controller: new AbortController() };
    operation.promise = new Promise((resolve) => { operation.resolve = resolve; });
    this.currentWrite = operation;
    if (this.stopped) {
      this.cancelWrite();
      return operation;
    }
    this.applyClipboardWrite(event, operation.hash, 1, operation);
    return operation;
  }

  isWriteCurrent(operation, { confirm = false } = {}) {
    if (!operation || this.currentWrite !== operation || this.stopped || operation.controller.signal.aborted) return false;
    const settings = this.settingsProvider();
    if (operation.remote && (settings.pauseReceive || !isReceiveAllowed(operation.event, settings))) {
      this.cancelWrite();
      return false;
    }
    if (confirm) {
      this.resetClipboardReadCache();
      const actual = this.readSnapshot();
      if (!actual.ok || actual.snapshot?.hash !== operation.actualHash) {
        this.cancelWrite();
        return false;
      }
    }
    return true;
  }

  writeMatches(operation, snapshot) {
    return operation.prepared ? operation.prepared.matches(snapshot) : this.clipboardContainsEvent(operation.event, operation.hash, snapshot);
  }

  confirmWrite(operation, snapshot, attempt) {
    this.trace({ stage: 'clipboard-write-passed', attempt, contentType: operation.event.contentType,
      sourceDeviceId: operation.event.sourceDeviceId, targetDeviceIds: operation.event.targetDeviceIds, hash: operation.hash });
    this.loopGuard.markApplied(operation.hash);
    this.loopGuard.markApplied(snapshot.hash);
    this.lastLocalHash = snapshot.hash;
    this.lastObservedHash = snapshot.hash;
    this.localEvent = null;
    this.pendingLocalHashes.clear();
    this.hasLocalBaseline = true;
    operation.actualHash = snapshot.hash;
    this.finishWrite(operation, 'succeeded');
    return true;
  }

  reportError(error) {
    try {
      this.onError(error);
    } catch {
      // Error reporting must never crash the clipboard loop.
    }
  }

  trace(event) {
    try {
      this.onTrace(event);
    } catch {
      // Smoke tracing must never affect clipboard behavior.
    }
  }

  async readLocalSource(snapshot) {
    try {
      return await this.sourceProvider(snapshot);
    } catch (error) {
      this.trace({ stage: 'clipboard-source-error', message: error.message });
      return null;
    }
  }

  observeLocalSource(source, snapshot) {
    if (!this.onSourceObserved || !source) {
      return;
    }
    try {
      this.onSourceObserved({
        source,
        contentType: snapshot.contentType,
        hash: snapshot.hash,
        capturedAt: new Date(this.now()).toISOString()
      });
    } catch {
      // Source discovery is only for settings UI; it must not affect syncing.
    }
  }

  readSnapshot() {
    try {
      return { ok: true, snapshot: this.clipboard.readSnapshot() };
    } catch (error) {
      this.reportError(error);
      return { ok: false, snapshot: null };
    }
  }

  writeEvent(event, operation) {
    try {
      if (this.clipboard.prepareWrite) {
        operation.prepared ??= this.clipboard.prepareWrite(event);
        operation.prepared.write();
      } else {
        this.clipboard.writeEvent(event);
      }
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  resetClipboardReadCache() {
    try {
      this.clipboard.resetCachedSnapshot?.();
    } catch {
      // Cache reset is a best-effort guard after our own writes.
    }
  }

  clipboardContainsEvent(event, hash, snapshot) {
    if (!snapshot) {
      return false;
    }
    if (event.contentType === 'text/plain') {
      return snapshot.contentType === 'text/plain' && snapshot.hash === hash;
    }
    if (event.contentType?.startsWith('image/')) {
      if (!snapshot.contentType?.startsWith('image/')) {
        return false;
      }
      return snapshot.hash === hash;
    }
    return false;
  }

  scheduleClipboardWriteRetry(event, hash, attempt, reason, operation) {
    this.trace({
      stage: 'clipboard-write-failed',
      attempt,
      reason,
      contentType: event.contentType,
      sourceDeviceId: event.sourceDeviceId,
      targetDeviceIds: event.targetDeviceIds,
      hash
    });
    if (attempt >= this.remoteWriteMaxAttempts) {
      this.finishWrite(operation, 'failed');
      return;
    }
    let timer = null;
    timer = this.setTimeout(() => {
      this.remoteWriteTimers.delete(timer);
      this.applyClipboardWrite(event, hash, attempt + 1, operation);
    }, this.remoteWriteRetryMs);
    this.remoteWriteTimers.add(timer);
  }

  establishLocalBaseline() {
    this.submittedLocalEventId = null;
    const { ok, snapshot } = this.readSnapshot();
    if (!ok) {
      return;
    }
    this.lastLocalHash = snapshot?.hash || null;
    this.lastObservedHash = this.lastLocalHash;
    this.localEvent = null;
    this.pendingLocalHashes.clear();
    this.hasLocalBaseline = true;
  }

  hasPendingLocalHash(hash) {
    const sentAt = this.pendingLocalHashes.get(hash);
    if (sentAt === undefined) {
      return false;
    }
    if (this.now() - sentAt < this.pendingAckMs) {
      return true;
    }
    this.pendingLocalHashes.delete(hash);
    return false;
  }

  acknowledgeLocalHash(hash) {
    this.pendingLocalHashes.delete(hash);
    if (this.lastObservedHash === hash) {
      this.lastLocalHash = hash;
      this.hasLocalBaseline = true;
    }
  }

  rememberKnownSnapshot(snapshot) {
    this.lastObservedHash = snapshot?.hash ?? null;
    this.lastLocalHash = this.lastObservedHash;
    this.hasLocalBaseline = true;
  }

  acknowledgeLocalEvent(event) {
    if (event.clientEventId && event.clientEventId === this.localEvent?.id) {
      this.acknowledgeLocalHash(this.localEvent.hash);
    } else if (!event.clientEventId && event.type === 'clipboard.update' && event.sourceDeviceId === this.settingsProvider().deviceId) {
      this.acknowledgeLocalHash(hashEventPayload(event));
    }
  }

  pollLocalClipboard() {
    if (this.polling) {
      return this.polling;
    }
    const result = this.pollLocalClipboardNow();
    if (result && typeof result.then === 'function') {
      const polling = result.catch((error) => this.reportError(error)).finally(() => {
        if (this.polling === polling) this.polling = null;
      });
      this.polling = polling;
      return this.polling;
    }
    return result;
  }

  pollLocalClipboardNow() {
    if (this.stopped) return;
    const { ok, snapshot } = this.readSnapshot();
    if (!ok) {
      return;
    }
    const writing = this.currentWrite;
    if (writing?.status === 'pending' && this.isWriteCurrent(writing)) {
      if (writing.hasWritten && this.writeMatches(writing, snapshot)) {
        this.confirmWrite(writing, snapshot);
        return;
      }
      if (writing.acceptPrevious?.(snapshot)) {
        this.rememberKnownSnapshot(snapshot);
        return;
      }
    }
    if ((snapshot?.hash ?? null) !== this.lastObservedHash) {
      this.cancelWrite();
      this.submittedLocalEventId = null;
      this.lastLocalHash = null;
      this.loopGuard.reset?.();
      this.lastObservedHash = snapshot?.hash ?? null;
      this.localEvent = snapshot ? { hash: snapshot.hash, id: randomUUID() } : null;
      this.pendingLocalHashes.clear();
    }
    if (!snapshot) {
      this.lastLocalHash = null;
      this.pendingLocalHashes.clear();
      this.hasLocalBaseline = true;
      return;
    }

    if (!this.hasLocalBaseline) {
      this.lastLocalHash = snapshot.hash;
      this.hasLocalBaseline = true;
      return;
    }

    if (snapshot.hash === this.lastLocalHash) {
      return;
    }

    if (this.hasPendingLocalHash(snapshot.hash)) {
      return;
    }

    if (this.loopGuard.shouldSuppress(snapshot.hash)) {
      this.lastLocalHash = snapshot.hash;
      return;
    }

    const settings = this.settingsProvider();
    if (settings.pauseSend) {
      this.lastLocalHash = snapshot.hash;
      return;
    }

    if (Number.isInteger(settings.maxSendBytes) && snapshotByteLength(snapshot) > settings.maxSendBytes) {
      this.lastLocalHash = snapshot.hash;
      return;
    }

    if (
      this.onSourceObserved ||
      settings.ignoreUnknownSource ||
      (Array.isArray(settings.ignoredSourcePatterns) && settings.ignoredSourcePatterns.length > 0)
    ) {
      return this.pollLocalClipboardWithSource(snapshot, settings);
    }

    return this.sendLocalSnapshot(snapshot, settings);
  }

  async pollLocalClipboardWithSource(snapshot, settings) {
    const generation = this.generation;
    const source = await this.readLocalSource(snapshot);
    if (this.stopped || generation !== this.generation) return;
    settings = this.settingsProvider();
    const current = this.readSnapshot();
    if (!current.ok) {
      return;
    }
    if (current.snapshot?.hash !== snapshot.hash) {
      return this.pollLocalClipboardNow();
    }
    this.observeLocalSource(source, snapshot);
    if (shouldIgnoreLocalClipboardSource(source, settings)) {
      this.trace({
        stage: 'local-event-ignored',
        contentType: snapshot.contentType,
        hash: snapshot.hash,
        source
      });
      this.lastLocalHash = snapshot.hash;
      return;
    }
    return this.sendLocalSnapshot(snapshot, settings);
  }

  sendLocalSnapshot(snapshot, settings) {
    if (this.stopped) return;
    settings = this.settingsProvider();
    if (settings.pauseSend || (Number.isInteger(settings.maxSendBytes) && snapshotByteLength(snapshot) > settings.maxSendBytes)) {
      this.lastLocalHash = snapshot.hash;
      return;
    }
    const devices = this.devicesProvider();
    const targetDeviceIds = buildTargetDeviceIds(devices, settings, settings.deviceId);
    if (Array.isArray(targetDeviceIds) && targetDeviceIds.length === 0) {
      if (shouldDeferRestrictedSend(devices, settings, settings.deviceId)) {
        return;
      }
      this.lastLocalHash = snapshot.hash;
      return;
    }
    this.localEvent ??= { hash: snapshot.hash, id: randomUUID() };
    const route = JSON.stringify(targetDeviceIds?.slice().sort() ?? null);
    if (this.localEvent.route !== undefined && this.localEvent.route !== route) {
      this.localEvent = { hash: snapshot.hash, id: randomUUID() };
    }
    this.localEvent.route = route;
    if (this.hub.sendClipboard({ ...snapshot, clientEventId: this.localEvent.id }, targetDeviceIds)) {
      this.submittedLocalEventId = this.localEvent.id;
      this.pendingLocalHashes.set(snapshot.hash, this.now());
    }
  }

  applyClipboardWrite(event, hash, attempt = 1, operation = this.currentWrite) {
    if (!this.isWriteCurrent(operation) || operation.status !== 'pending') return false;
    this.trace({
      stage: 'clipboard-write-attempt',
      attempt,
      contentType: event.contentType,
      sourceDeviceId: event.sourceDeviceId,
      targetDeviceIds: event.targetDeviceIds,
      hash
    });
    const previous = this.readSnapshot();
    if (attempt > 1 && previous.ok && operation.hasWritten && this.writeMatches(operation, previous.snapshot)) {
      return this.confirmWrite(operation, previous.snapshot, attempt);
    }
    if (previous.ok && operation.acceptPrevious && !operation.acceptPrevious(previous.snapshot)) {
      this.cancelWrite();
      return false;
    }
    if (previous.ok && operation.acceptPrevious) this.rememberKnownSnapshot(previous.snapshot);
    if (attempt > 1 && !operation.acceptPrevious && operation.hasObservation && previous.ok && previous.snapshot?.hash !== operation.observedHash) {
      this.cancelWrite();
      return false;
    }
    if (!previous.ok) {
      this.scheduleClipboardWriteRetry(event, hash, attempt, 'read-error', operation);
      return false;
    }
    operation.observedHash = previous.snapshot?.hash;
    operation.hasObservation = true;
    if (!this.writeEvent(event, operation)) {
      this.scheduleClipboardWriteRetry(event, hash, attempt, 'write-error', operation);
      return false;
    }
    operation.hasWritten = true;
    this.resetClipboardReadCache();
    const actual = this.readSnapshot();
    const matches = actual.ok && this.writeMatches(operation, actual.snapshot);
    if (!matches) {
      this.scheduleClipboardWriteRetry(event, hash, attempt, actual.ok ? 'write-not-observed' : 'read-error', operation);
      return false;
    }
    return this.confirmWrite(operation, actual.snapshot, attempt);
  }

  applyRemoteEvent(event) {
    if (this.stopped) return;
    const settings = this.settingsProvider();
    const hash = hashEventPayload(event);
    if (event.sourceDeviceId === settings.deviceId) {
      if (event.clientEventId) this.acknowledgeLocalEvent(event);
      else this.acknowledgeLocalHash(hash);
      // A committed self echo participates in the same ordered stream as peer
      // events. Keep its identity across intervening remote writes so concurrent
      // copies converge, but never replay it over a newer local copy or selection.
      if (event.id && event.clientEventId && event.clientEventId === this.submittedLocalEventId) {
        this.submittedLocalEventId = null;
        const current = this.readSnapshot();
        const previousWrite = this.currentWrite?.remote ? this.currentWrite : null;
        const observedHash = this.lastObservedHash;
        const acceptPrevious = (snapshot) => snapshot?.hash === observedHash ||
          (previousWrite?.hasWritten && this.writeMatches(previousWrite, snapshot));
        if ((!current.ok || acceptPrevious(current.snapshot)) && !settings.pauseReceive && isReceiveAllowed(event, settings)) {
          if (current.ok && current.snapshot?.hash === hash && !previousWrite?.hasWritten) {
            this.cancelWrite();
          } else {
            this.beginWrite(event, true, acceptPrevious);
          }
        }
      }
      return;
    }

    if (settings.pauseReceive || !isReceiveAllowed(event, settings)) {
      this.trace({
        stage: 'remote-event-skipped',
        contentType: event.contentType,
        sourceDeviceId: event.sourceDeviceId,
        targetDeviceIds: event.targetDeviceIds,
        hash,
        pauseReceive: Boolean(settings.pauseReceive)
      });
      return;
    }

    this.trace({
      stage: 'remote-event-accepted',
      contentType: event.contentType,
      sourceDeviceId: event.sourceDeviceId,
      targetDeviceIds: event.targetDeviceIds,
      hash
    });
    this.beginWrite(event, true);
  }

  applyHistoryEvent(event) {
    return this.beginHistoryWrite(event).status === 'succeeded';
  }

  beginHistoryWrite(event) {
    this.submittedLocalEventId = null;
    return this.beginWrite(event, false);
  }
}
