import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - Scheduling

public protocol Cancellable: AnyObject {
    func cancel()
}

/// Timer source. The app uses the main queue; tests drive a manual clock.
public protocol Scheduler: AnyObject {
    func schedule(after seconds: TimeInterval, _ block: @escaping () -> Void) -> Cancellable
}

public final class MainQueueScheduler: Scheduler {
    private final class Token: Cancellable {
        let item: DispatchWorkItem
        init(_ item: DispatchWorkItem) { self.item = item }
        func cancel() { item.cancel() }
    }

    public init() {}

    public func schedule(after seconds: TimeInterval, _ block: @escaping () -> Void) -> Cancellable {
        let item = DispatchWorkItem(block: block)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
        return Token(item)
    }
}

// MARK: - Status

public struct HubStatus: Equatable, Sendable {
    public enum State: String, Sendable {
        case starting
        case connected
        case disconnected
        case invalidHubUrl = "invalid-hub-url"
        case duplicateDevice = "duplicate-device"
        case connectionError = "connection-error"
        case clipboardError = "clipboard-error"
        case hubError = "hub-error"
        case configError = "config-error"

        public var labelKey: String {
            switch self {
            case .starting: return "status.starting"
            case .connected: return "status.connected"
            case .disconnected: return "status.disconnected"
            case .invalidHubUrl: return "status.invalidHubUrl"
            case .duplicateDevice: return "status.duplicateDevice"
            case .connectionError: return "status.connectionError"
            case .clipboardError: return "status.clipboardError"
            case .hubError: return "status.hubError"
            case .configError: return "status.configError"
            }
        }

        /// Errors that do not describe the Hub connection (see `status-tracker.js`).
        public var isTransient: Bool { self == .clipboardError || self == .hubError || self == .configError }
    }

    public var state: State
    /// Free text from the Hub or the system.
    public var message: String?
    /// Localization key for messages produced by this client.
    public var messageKey: String?

    public init(_ state: State, message: String? = nil, messageKey: String? = nil) {
        self.state = state
        self.message = message
        self.messageKey = messageKey
    }

    public func detail(language: String) -> String? {
        if let messageKey { return L10n.t(language, messageKey) }
        return message
    }
}

/// Shows transient errors for a while, then falls back to the connection state.
public final class StatusTracker {
    public private(set) var connection = HubStatus(.starting)
    private var transient: HubStatus?
    private var timer: Cancellable?
    private let scheduler: Scheduler
    private let transientSeconds: TimeInterval
    public var onChange: ((HubStatus) -> Void)?

    public init(scheduler: Scheduler, transientSeconds: TimeInterval = 10) {
        self.scheduler = scheduler
        self.transientSeconds = transientSeconds
    }

    public var current: HubStatus { transient ?? connection }

    public func set(_ status: HubStatus) {
        timer?.cancel()
        timer = nil
        guard status.state.isTransient else {
            transient = nil
            connection = status
            onChange?(current)
            return
        }
        let repeated = transient == status
        transient = status
        timer = scheduler.schedule(after: transientSeconds) { [weak self] in
            guard let self else { return }
            self.timer = nil
            self.transient = nil
            self.onChange?(self.current)
        }
        if !repeated { onChange?(current) }
    }
}

// MARK: - Transport

public struct HubTransportEvents {
    public var onOpen: () -> Void
    public var onText: (String) -> Void
    /// Called exactly once per transport, including after `terminate()`. Not required after `close()`.
    public var onClose: (_ code: Int, _ reason: String) -> Void
    public var onError: (String) -> Void

    public init(onOpen: @escaping () -> Void, onText: @escaping (String) -> Void,
                onClose: @escaping (Int, String) -> Void, onError: @escaping (String) -> Void) {
        self.onOpen = onOpen
        self.onText = onText
        self.onClose = onClose
        self.onError = onError
    }
}

public protocol HubTransport: AnyObject {
    /// Bytes handed to `send` whose completion has not run yet.
    var bufferedBytes: Int { get }
    func send(_ text: String, completion: @escaping (Error?) -> Void)
    /// Completion runs when the pong arrives (nil) or the ping fails.
    func ping(completion: @escaping (Error?) -> Void)
    /// Graceful close of a connection that is being replaced or stopped.
    func close()
    /// Abort a dead or stuck connection; must still deliver `onClose`.
    func terminate()
}

public protocol HubTransportFactory: AnyObject {
    func connect(request: URLRequest, events: HubTransportEvents) -> HubTransport
}

// MARK: - Session

public struct HubConnectionSettings: Equatable {
    public var hubUrl: String
    public var token: String?
    public var deviceId: String
    public var deviceName: String
    public var receiverPolicy: ReceiverPolicy

    public init(hubUrl: String, token: String?, deviceId: String, deviceName: String, receiverPolicy: ReceiverPolicy) {
        self.hubUrl = hubUrl
        self.token = token
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.receiverPolicy = receiverPolicy
    }
}

/// Port of `src/client/hub-client.js` (WebSocket part). Call from one thread (the main thread).
///
/// Connected is reported only after the Hub acknowledges this device's receiver
/// policy, so no event filtered by an older policy is mistaken for a live state.
public final class HubSession {
    public struct Timing {
        public var reconnectBase: TimeInterval = 2
        public var reconnectMax: TimeInterval = 30
        public var duplicateRetry: TimeInterval = 30
        public var heartbeat: TimeInterval = 30
        public var handshakeTimeout: TimeInterval = 10
        public var policyAck: TimeInterval = 2
        public var policyMaxAttempts = 3
        public var maxBufferedBytes = 64 * 1024 * 1024
        public init() {}
    }

    private struct PendingPolicy {
        var policy: ReceiverPolicy
        var revision: Int
        var generation: Int
        var attempts: Int
        var message: String
    }

    public var onStatus: ((HubStatus) -> Void)?
    public var onDevices: (([Device]) -> Void)?
    public var onConfig: ((HubConfig) -> Void)?
    public var onClipboard: ((ClipboardEvent) -> Void)?
    public var onAck: ((_ clientEventId: String?) -> Void)?
    public var onHistoryCleared: (() -> Void)?
    /// Every acknowledged receiver policy, including later rule changes.
    public var onReceiverPolicyUpdated: (() -> Void)?

    private let settingsProvider: () -> HubConnectionSettings
    private let transportFactory: HubTransportFactory
    private let scheduler: Scheduler
    private let random: () -> Double
    public let timing: Timing

    private var transport: HubTransport?
    private var generation = 0
    private var stopped = true
    private var opened = false
    private var alive = true
    private var connectedDeviceId = ""
    private var reconnectTimer: Cancellable?
    private var heartbeatTimer: Cancellable?
    private var handshakeTimer: Cancellable?
    private var policyTimer: Cancellable?
    public private(set) var reconnectAttempts = 0
    public private(set) var receiverPolicyReady = false
    private var pendingDevices: [Device]?
    private var pendingConfig: HubConfig?
    private var policyRevision = 0
    private var pendingPolicy: PendingPolicy?
    private var desiredPolicy: ReceiverPolicy?
    private var acknowledgedPolicy: ReceiverPolicy?
    private var policyRevisionSupported: Bool?

    public init(
        settingsProvider: @escaping () -> HubConnectionSettings,
        transportFactory: HubTransportFactory,
        scheduler: Scheduler,
        timing: Timing = Timing(),
        random: @escaping () -> Double = { Double.random(in: 0..<1) }
    ) {
        self.settingsProvider = settingsProvider
        self.transportFactory = transportFactory
        self.scheduler = scheduler
        self.timing = timing
        self.random = random
    }

    public var isOpen: Bool { transport != nil && opened }
    public var isStopped: Bool { stopped }

    public func start() {
        stopped = false
        connect()
    }

    public func stop() {
        stopped = true
        reconnectTimer?.cancel()
        reconnectTimer = nil
        retireConnection()
    }

    /// Reconnect immediately, e.g. after wake or a network change.
    public func reconnectNow() {
        reconnectTimer?.cancel()
        reconnectTimer = nil
        retireConnection()
        reconnectAttempts = 0
        connect()
    }

    private func retireConnection() {
        policyTimer?.cancel()
        policyTimer = nil
        pendingPolicy = nil
        desiredPolicy = nil
        acknowledgedPolicy = nil
        policyRevisionSupported = nil
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        handshakeTimer?.cancel()
        handshakeTimer = nil
        generation += 1
        opened = false
        let previous = transport
        transport = nil
        previous?.close()
    }

    private func emit(_ status: HubStatus) {
        onStatus?(status)
    }

    private func isCurrent(_ connectionGeneration: Int) -> Bool {
        !stopped && generation == connectionGeneration && transport != nil
    }

    private func connect() {
        guard !stopped else { return }
        let settings = settingsProvider()
        let url: URL
        do {
            url = try HubEndpoints.webSocketURL(hubUrl: settings.hubUrl, deviceId: settings.deviceId, deviceName: settings.deviceName)
        } catch {
            let key = settings.hubUrl.trimmingCharacters(in: .whitespaces).isEmpty ? "status.serverNotSet" : nil
            emit(HubStatus(.invalidHubUrl, message: error.localizedDescription, messageKey: key))
            return
        }

        reconnectTimer?.cancel()
        reconnectTimer = nil
        retireConnection()
        let connectionGeneration = generation
        receiverPolicyReady = false
        pendingDevices = nil
        pendingConfig = nil
        connectedDeviceId = settings.deviceId

        // The handshake deadline is the handshake timer below. URLSession may treat the request
        // timeout as an idle timeout for the open socket, so keep it well above the ping interval.
        let request = HubEndpoints.request(url, token: settings.token, timeout: max(300, timing.heartbeat * 4))
        let events = HubTransportEvents(
            onOpen: { [weak self] in
                guard let self, self.isCurrent(connectionGeneration) else { return }
                self.handleOpen(connectionGeneration)
            },
            onText: { [weak self] text in
                guard let self, self.isCurrent(connectionGeneration) else { return }
                self.handleText(text)
            },
            onClose: { [weak self] code, reason in
                guard let self, self.isCurrent(connectionGeneration) else { return }
                self.handleClose(code: code, reason: reason)
            },
            onError: { [weak self] message in
                guard let self, self.isCurrent(connectionGeneration) else { return }
                self.emit(HubStatus(.connectionError, message: message))
            }
        )
        let transport = transportFactory.connect(request: request, events: events)
        self.transport = transport
        handshakeTimer = scheduler.schedule(after: timing.handshakeTimeout) { [weak self, weak transport] in
            guard let self, self.isCurrent(connectionGeneration), !self.opened else { return }
            transport?.terminate()
        }
    }

    private func handleOpen(_ connectionGeneration: Int) {
        opened = true
        alive = true
        handshakeTimer?.cancel()
        handshakeTimer = nil
        scheduleHeartbeat(connectionGeneration)
        sendReceiverPolicy()
    }

    private func scheduleHeartbeat(_ connectionGeneration: Int) {
        heartbeatTimer = scheduler.schedule(after: timing.heartbeat) { [weak self] in
            guard let self, self.isCurrent(connectionGeneration), let transport = self.transport else { return }
            if !self.alive {
                transport.terminate()
                return
            }
            self.alive = false
            transport.ping { [weak self] error in
                guard let self, self.isCurrent(connectionGeneration) else { return }
                if error == nil { self.alive = true }
            }
            self.scheduleHeartbeat(connectionGeneration)
        }
    }

    private func handleText(_ text: String) {
        guard let message = HubMessage.parse(text) else {
            emit(HubStatus(.hubError, messageKey: "status.invalidMessage"))
            return
        }
        switch message {
        case .devices(let devices):
            if receiverPolicyReady { onDevices?(devices) } else { pendingDevices = devices }
        case .config(let config):
            policyRevisionSupported = config.receiverPolicyRevision
            if receiverPolicyReady { onConfig?(config) } else { pendingConfig = config }
        case .clipboard(let event):
            guard let id = event.id, !id.isEmpty else {
                // Old Hubs used an unpersisted clipboard.update as a duplicate acknowledgement.
                if event.sourceDeviceId == connectedDeviceId { onAck?(event.clientEventId) }
                return
            }
            onClipboard?(event)
        case .ack(let clientEventId, _, _):
            onAck?(clientEventId)
        case .historyCleared:
            onHistoryCleared?()
        case .receiverPolicyUpdated(let revision):
            handleReceiverPolicyUpdated(revision: revision)
        case .error(let message):
            emit(HubStatus(.hubError, message: message))
        case .unknown:
            break
        }
    }

    private func handleClose(code: Int, reason: String) {
        retireConnection()
        let delay: TimeInterval
        if code == 4000 {
            emit(HubStatus(.duplicateDevice, message: reason.isEmpty ? nil : reason, messageKey: "status.duplicateDeviceDetail"))
            // A stale handshake relayed for this device can also evict us. Retry
            // slowly so a real duplicate cannot flap while a transient one heals.
            delay = timing.duplicateRetry
        } else {
            emit(HubStatus(.disconnected))
            delay = min(timing.reconnectMax, timing.reconnectBase * pow(2, Double(min(reconnectAttempts, 5))))
            reconnectAttempts += 1
        }
        guard !stopped else { return }
        reconnectTimer = scheduler.schedule(after: delay * (0.8 + random() * 0.4)) { [weak self] in
            self?.connect()
        }
    }

    /// Sends a `clipboard.update`. Returns false when there is no open socket or too much is queued.
    @discardableResult
    public func sendClipboard(_ snapshot: ClipboardSnapshot, clientEventId: String?, targetDeviceIds: [String]?) -> Bool {
        guard let transport, opened else { return false }
        let message = ClientMessage.clipboardUpdate(snapshot, clientEventId: clientEventId, targetDeviceIds: targetDeviceIds)
        guard transport.bufferedBytes + message.utf8.count <= timing.maxBufferedBytes else { return false }
        let connectionGeneration = generation
        transport.send(message) { [weak self] error in
            guard let self, let error, self.isCurrent(connectionGeneration) else { return }
            self.emit(HubStatus(.connectionError, message: error.localizedDescription))
        }
        return true
    }

    /// Sends the current receiver policy (from settings) if it differs from the acknowledged one.
    @discardableResult
    public func sendReceiverPolicy() -> Bool {
        guard transport != nil, opened else { return false }
        desiredPolicy = settingsProvider().receiverPolicy
        return flushReceiverPolicy()
    }

    private func flushReceiverPolicy() -> Bool {
        guard let desired = desiredPolicy else { return false }
        if pendingPolicy != nil || desired == acknowledgedPolicy { return true }
        policyRevision += 1
        pendingPolicy = PendingPolicy(
            policy: desired,
            revision: policyRevision,
            generation: generation,
            attempts: 0,
            message: ClientMessage.receiverPolicy(desired, revision: policyRevision)
        )
        return sendPolicyAttempt()
    }

    private func sendPolicyAttempt() -> Bool {
        guard !stopped, var pending = pendingPolicy, pending.generation == generation, let transport else { return false }
        pending.attempts += 1
        pendingPolicy = pending
        let connectionGeneration = generation
        let revision = pending.revision
        transport.send(pending.message) { [weak self] error in
            guard let self, let error, self.isCurrent(connectionGeneration) else { return }
            self.emit(HubStatus(.connectionError, message: error.localizedDescription))
        }
        policyTimer?.cancel()
        let wait = timing.policyAck * pow(2, Double(pending.attempts - 1))
        policyTimer = scheduler.schedule(after: wait) { [weak self] in
            guard let self, self.isCurrent(connectionGeneration),
                  let current = self.pendingPolicy, current.revision == revision else { return }
            if self.policyRevisionSupported != true || current.attempts >= self.timing.policyMaxAttempts {
                self.emit(HubStatus(.connectionError, messageKey: "status.policyAckTimeout"))
                self.transport?.terminate()
                return
            }
            _ = self.sendPolicyAttempt()
        }
        return true
    }

    private func handleReceiverPolicyUpdated(revision: Int?) {
        guard let pending = pendingPolicy else { return }
        if let revision, revision != pending.revision { return }
        if revision == nil && policyRevisionSupported == true { return }
        if revision != nil { policyRevisionSupported = true }
        policyTimer?.cancel()
        policyTimer = nil
        acknowledgedPolicy = pending.policy
        pendingPolicy = nil
        if desiredPolicy != acknowledgedPolicy {
            _ = flushReceiverPolicy()
            return
        }
        reconnectAttempts = 0
        let wasReady = receiverPolicyReady
        receiverPolicyReady = true
        onReceiverPolicyUpdated?()
        guard !wasReady else { return }
        emit(HubStatus(.connected))
        if let devices = pendingDevices {
            pendingDevices = nil
            onDevices?(devices)
        }
        if let config = pendingConfig {
            pendingConfig = nil
            onConfig?(config)
        }
    }
}
