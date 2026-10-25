import Foundation

public enum ClipboardRead: Equatable {
    /// Nothing syncable (empty, or a type this client does not sync).
    case empty
    /// Marked concealed/transient by the source app (password managers), or a file copy.
    case ignored
    /// Larger than the send limit or the image pixel budget.
    case tooLarge(hash: String?)
    case snapshot(ClipboardSnapshot)
}

/// The system clipboard as seen by the sync engine. `changeCount` must change on every
/// write by any process (NSPasteboard semantics).
public protocol ClipboardBackend: AnyObject {
    var changeCount: Int { get }
    func read(maxBytes: Int) throws -> ClipboardRead
    /// Writes the event and returns the change count that identifies this write.
    func write(_ event: ClipboardEvent) throws -> Int
}

/// Clipboard side of `sync-service.js`, rebuilt around `NSPasteboard.changeCount`.
///
/// Loop guard: a change count produced by our own write is never sent back, and
/// content equal to what the clipboard last held is not a new event. A local copy is
/// read once per change instead of being re-read on every poll. Call from one thread.
public final class SyncEngine {
    public static let resendSeconds: TimeInterval = 5
    public static let maxSendAttempts = 6

    struct PendingLocal {
        enum State { case unsent, deferred, sent }
        var changeCount: Int
        var snapshot: ClipboardSnapshot
        var clientEventId: String
        var routeKey: String?
        var state: State = .unsent
        var sentAt: Date?
        var attempts = 0
    }

    public var onError: ((String) -> Void)?

    private let backend: ClipboardBackend
    private let settings: () -> ClientSettings
    private let devices: () -> [Device]
    private let send: (ClipboardSnapshot, String, [String]?) -> Bool
    private let now: () -> Date
    private let makeId: () -> String

    public private(set) var isRunning = false
    private var lastSeenChangeCount: Int?
    private var ownWriteChangeCount: Int?
    private var lastObservedHash: String?
    private var submittedLocalEventId: String?
    private(set) var pending: PendingLocal?

    public init(
        backend: ClipboardBackend,
        settings: @escaping () -> ClientSettings,
        devices: @escaping () -> [Device],
        send: @escaping (_ snapshot: ClipboardSnapshot, _ clientEventId: String, _ targetDeviceIds: [String]?) -> Bool,
        now: @escaping () -> Date = Date.init,
        makeId: @escaping () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.backend = backend
        self.settings = settings
        self.devices = devices
        self.send = send
        self.now = now
        self.makeId = makeId
    }

    /// Takes the current clipboard as the baseline; it is not sent.
    public func start() {
        isRunning = true
        pending = nil
        submittedLocalEventId = nil
        let changeCount = backend.changeCount
        lastSeenChangeCount = changeCount
        if case .snapshot(let snapshot)? = try? backend.read(maxBytes: settings().maxSendBytes) {
            lastObservedHash = snapshot.hash
        } else {
            lastObservedHash = nil
        }
    }

    public func stop() {
        isRunning = false
        pending = nil
        submittedLocalEventId = nil
    }

    /// True while the clipboard still holds the last remote or history write.
    public var clipboardHoldsLastWrite: Bool {
        ownWriteChangeCount != nil && backend.changeCount == ownWriteChangeCount
    }

    /// Call periodically. Reads the clipboard only when its change count moved.
    public func poll() {
        guard isRunning else { return }
        let changeCount = backend.changeCount
        if changeCount != lastSeenChangeCount {
            lastSeenChangeCount = changeCount
            if changeCount != ownWriteChangeCount {
                observeLocalChange(changeCount)
            }
            return
        }
        if let pending, pending.state == .sent, let sentAt = pending.sentAt,
           now().timeIntervalSince(sentAt) >= Self.resendSeconds {
            // No acknowledgement yet: resend with the same clientEventId; the Hub de-duplicates.
            trySendPending()
        }
    }

    private func observeLocalChange(_ changeCount: Int) {
        let current = settings()
        submittedLocalEventId = nil
        pending = nil
        if current.pauseSend {
            // Do not read (and possibly convert an image) while sending is paused.
            lastObservedHash = nil
            return
        }
        let result: ClipboardRead
        do {
            result = try backend.read(maxBytes: current.maxSendBytes)
        } catch {
            onError?(error.localizedDescription)
            return
        }
        switch result {
        case .empty, .ignored:
            lastObservedHash = nil
        case .tooLarge(let hash):
            lastObservedHash = hash
        case .snapshot(let snapshot):
            // Copying identical content again is not a new event (as in the Electron client).
            guard snapshot.hash != lastObservedHash else { return }
            lastObservedHash = snapshot.hash
            pending = PendingLocal(changeCount: changeCount, snapshot: snapshot, clientEventId: makeId())
            trySendPending()
        }
    }

    private func trySendPending() {
        guard var item = pending else { return }
        guard backend.changeCount == item.changeCount else {
            pending = nil
            return
        }
        let current = settings()
        if current.pauseSend || item.snapshot.byteLength > current.maxSendBytes {
            pending = nil
            return
        }
        let peers = devices()
        let targets = Policy.buildTargetDeviceIds(devices: peers, settings: current, selfDeviceId: current.deviceId)
        if let targets, targets.isEmpty {
            if Policy.shouldDeferRestrictedSend(devices: peers, settings: current, selfDeviceId: current.deviceId) {
                // The device list is not known yet; decide when it arrives.
                item.state = .deferred
                pending = item
            } else {
                pending = nil
            }
            return
        }
        let routeKey = targets.map { $0.sorted().joined(separator: ",") } ?? "*"
        if let previous = item.routeKey, previous != routeKey {
            item.clientEventId = makeId()
            item.attempts = 0
        }
        item.routeKey = routeKey
        guard item.attempts < Self.maxSendAttempts else {
            pending = nil
            return
        }
        if send(item.snapshot, item.clientEventId, targets) {
            item.state = .sent
            item.sentAt = now()
            item.attempts += 1
            submittedLocalEventId = item.clientEventId
        } else {
            item.state = .unsent
        }
        pending = item
    }

    /// The Hub connection became ready: send a copy made while offline.
    public func hubBecameReady() {
        guard isRunning, pending != nil else { return }
        trySendPending()
    }

    /// Device list changed: a deferred or unsent copy may now have a route.
    public func devicesChanged() {
        guard isRunning, let pending, pending.state != .sent else { return }
        trySendPending()
    }

    public func handleAck(clientEventId: String?) {
        guard let clientEventId, pending?.clientEventId == clientEventId else { return }
        pending = nil
    }

    /// A live `clipboard.update` from the Hub (including our own echo).
    public func applyRemote(_ event: ClipboardEvent) {
        guard isRunning else { return }
        let current = settings()
        if event.sourceDeviceId == current.deviceId {
            handleAck(clientEventId: event.clientEventId)
            // Concurrent copies converge on the Hub's order: if a peer's event was written
            // here after our copy but stored before it, restore our copy. Never replay it
            // over a newer local copy (that resets submittedLocalEventId / changes the count).
            if event.id != nil, let clientEventId = event.clientEventId, clientEventId == submittedLocalEventId {
                submittedLocalEventId = nil
                if clipboardHoldsLastWrite, lastObservedHash != event.payloadHash,
                   !current.pauseReceive, Policy.isReceiveAllowed(event, settings: current) {
                    write(event)
                }
            }
            return
        }
        guard !current.pauseReceive, Policy.isReceiveAllowed(event, settings: current) else { return }
        write(event)
    }

    /// Writes a history item chosen by the user. It is not sent back to the Hub.
    @discardableResult
    public func writeHistory(_ event: ClipboardEvent) -> Bool {
        submittedLocalEventId = nil
        return write(event)
    }

    @discardableResult
    private func write(_ event: ClipboardEvent) -> Bool {
        do {
            let changeCount = try backend.write(event)
            ownWriteChangeCount = changeCount
            lastSeenChangeCount = changeCount
            let hash = event.payloadHash
            lastObservedHash = hash
            pending = nil
            return true
        } catch {
            onError?(error.localizedDescription)
            return false
        }
    }
}
