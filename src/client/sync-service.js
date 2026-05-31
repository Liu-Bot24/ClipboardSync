import { buildTargetDeviceIds, isReceiveAllowed, shouldDeferRestrictedSend } from './policy.js';
import { decodedBufferForEvent, hashEventPayload } from './clipboard-content.js';
import { shouldIgnoreLocalClipboardSource } from './source-ignore.js';

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
    this.boundClipboardListener = (event) => this.applyRemoteEvent(event);
  }

  start() {
    this.stop();
    this.establishLocalBaseline();
    this.hub.on('clipboard', this.boundClipboardListener);
    this.timer = setInterval(() => {
      this.pollLocalClipboard();
    }, this.pollMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.remoteWriteTimers) {
      this.clearTimeout(timer);
    }
    this.remoteWriteTimers.clear();
    this.hub.off?.('clipboard', this.boundClipboardListener);
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

  writeEvent(event) {
    try {
      this.clipboard.writeEvent(event);
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

  clipboardContainsEvent(event, hash, snapshot, previousSnapshot = null) {
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
      if (snapshot.hash === hash) {
        return true;
      }
      if (!previousSnapshot?.contentType?.startsWith('image/')) {
        return true;
      }
      return snapshot.hash !== previousSnapshot.hash;
    }
    return false;
  }

  scheduleClipboardWriteRetry(event, hash, attempt, reason) {
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
      return;
    }
    let timer = null;
    timer = this.setTimeout(() => {
      this.remoteWriteTimers.delete(timer);
      this.applyClipboardWrite(event, hash, attempt + 1);
    }, this.remoteWriteRetryMs);
    this.remoteWriteTimers.add(timer);
  }

  establishLocalBaseline() {
    const { ok, snapshot } = this.readSnapshot();
    if (!ok) {
      return;
    }
    this.lastLocalHash = snapshot?.hash || null;
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
    this.lastLocalHash = hash;
    this.hasLocalBaseline = true;
  }

  pollLocalClipboard() {
    if (this.polling) {
      return this.polling;
    }
    const result = this.pollLocalClipboardNow();
    if (result && typeof result.then === 'function') {
      this.polling = result.finally(() => {
        this.polling = null;
      });
      return this.polling;
    }
    return result;
  }

  pollLocalClipboardNow() {
    const { ok, snapshot } = this.readSnapshot();
    if (!ok) {
      return;
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
    const source = await this.readLocalSource(snapshot);
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
    const devices = this.devicesProvider();
    const targetDeviceIds = buildTargetDeviceIds(devices, settings, settings.deviceId);
    if (Array.isArray(targetDeviceIds) && targetDeviceIds.length === 0) {
      if (shouldDeferRestrictedSend(devices, settings, settings.deviceId)) {
        return;
      }
      this.lastLocalHash = snapshot.hash;
      return;
    }
    if (this.hub.sendClipboard(snapshot, targetDeviceIds)) {
      this.pendingLocalHashes.set(snapshot.hash, this.now());
    }
  }

  applyClipboardWrite(event, hash, attempt = 1) {
    this.trace({
      stage: 'clipboard-write-attempt',
      attempt,
      contentType: event.contentType,
      sourceDeviceId: event.sourceDeviceId,
      targetDeviceIds: event.targetDeviceIds,
      hash
    });
    const previous = this.readSnapshot();
    if (!this.writeEvent(event)) {
      this.scheduleClipboardWriteRetry(event, hash, attempt, 'write-error');
      return false;
    }
    this.resetClipboardReadCache();
    const actual = this.readSnapshot();
    if (!actual.ok || !this.clipboardContainsEvent(event, hash, actual.snapshot, previous.snapshot)) {
      this.scheduleClipboardWriteRetry(event, hash, attempt, actual.ok ? 'write-not-observed' : 'read-error');
      return false;
    }
    this.trace({
      stage: 'clipboard-write-passed',
      attempt,
      contentType: event.contentType,
      sourceDeviceId: event.sourceDeviceId,
      targetDeviceIds: event.targetDeviceIds,
      hash
    });
    this.loopGuard.markApplied(hash);
    this.loopGuard.markApplied(actual.snapshot.hash);
    this.lastLocalHash = actual.snapshot.hash;
    this.hasLocalBaseline = true;
    return true;
  }

  applyRemoteEvent(event) {
    const settings = this.settingsProvider();
    const hash = hashEventPayload(event);
    if (event.sourceDeviceId === settings.deviceId) {
      this.acknowledgeLocalHash(hash);
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
    this.applyClipboardWrite(event, hash);
  }

  applyHistoryEvent(event) {
    const hash = hashEventPayload(event);
    return this.applyClipboardWrite(event, hash);
  }
}
