import AppKit
import ClipboardSyncCore
import SystemConfiguration

/// Owns the Hub connection, the clipboard engine, settings and history (the role of
/// `electron-main.js`). All work happens on the main thread.
@MainActor
final class AppModel: NSObject, ObservableObject {
    struct Notice: Equatable {
        let id = UUID()
        let text: String
        let isError: Bool
    }

    static let bundleId = Bundle.main.bundleIdentifier ?? "dev.liuqi.clipboardsync.mac"

    @Published private(set) var status = HubStatus(.starting)
    @Published private(set) var settings: ClientSettings
    @Published private(set) var devices: [Device] = []
    /// Visible history, newest first.
    @Published private(set) var history: [ClipboardEvent] = []
    @Published private(set) var hasToken = false
    @Published private(set) var launchAtLogin = false
    @Published private(set) var notice: Notice?

    let pasteTargets: PasteTargetTracker
    private let store: SettingsStore
    private let keychain = KeychainTokenStore(service: AppModel.bundleId)
    private var token: String?
    private let scheduler = MainQueueScheduler()
    private let statusTracker: StatusTracker
    private let api: HubAPI
    private let backend = PasteboardBackend()
    private let network = NetworkWatcher()
    private var session: HubSession!
    private var engine: SyncEngine!
    private var pollTimer: Timer?
    private var noticeTimer: Timer?
    /// Hub history (oldest first), already filtered by the receive rules.
    private var rawHistory: [ClipboardEvent] = []
    private var historyRevision = 0
    /// Bumped whenever the connection changes; late HTTP results from an older one are dropped.
    private var connectionEpoch = 0
    private var startupError: String?
    private var appNapActivity: NSObjectProtocol?

    override init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let computerName = (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? ProcessInfo.processInfo.hostName
        store = SettingsStore(
            directory: support.appendingPathComponent(AppModel.bundleId, isDirectory: true),
            defaultDeviceName: computerName,
            preferredLanguages: Locale.preferredLanguages
        )
        do {
            try store.load()
        } catch {
            startupError = error.localizedDescription
        }
        statusTracker = StatusTracker(scheduler: scheduler)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        configuration.timeoutIntervalForRequest = 20
        api = HubAPI(session: URLSession(configuration: configuration))
        settings = store.settings
        pasteTargets = PasteTargetTracker()
        super.init()

        if store.createdOnLoad { importElectronSettings() }
        token = keychain.read()
        hasToken = !(token ?? "").isEmpty
        settings = store.settings

        session = HubSession(
            settingsProvider: { [unowned self] in self.connectionSettings() },
            transportFactory: URLSessionTransportFactory(),
            scheduler: scheduler
        )
        session.onStatus = { [weak self] in self?.handleHubStatus($0) }
        session.onDevices = { [weak self] in self?.handleDevices($0) }
        session.onConfig = { [weak self] in self?.handleConfig($0) }
        session.onClipboard = { [weak self] in self?.handleClipboard($0) }
        session.onAck = { [weak self] in self?.engine.handleAck(clientEventId: $0) }
        session.onHistoryCleared = { [weak self] in self?.handleHistoryCleared() }

        engine = SyncEngine(
            backend: backend,
            settings: { [unowned self] in self.settings },
            devices: { [unowned self] in self.devices },
            send: { [unowned self] snapshot, clientEventId, targets in
                self.session.sendClipboard(snapshot, clientEventId: clientEventId, targetDeviceIds: targets)
            }
        )
        engine.onError = { [weak self] message in
            self?.statusTracker.set(HubStatus(.clipboardError, message: message))
        }
        statusTracker.onChange = { [weak self] in self?.status = $0 }
    }

    // MARK: Lifecycle

    func start() {
        if let startupError { statusTracker.set(HubStatus(.configError, message: startupError)) }
        if store.createdOnLoad && settings.autoLaunch {
            setLaunchAtLogin(true)
        }
        launchAtLogin = LoginItem.isEnabled
        // A windowless menu bar app is a candidate for App Nap, which would stretch the clipboard
        // poll and heartbeat timers to many seconds. Idle system sleep stays allowed.
        appNapActivity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Clipboard sync")
        engine.start()
        session.start()

        let timer = Timer(timeInterval: 0.3, target: self, selector: #selector(pollClipboard), userInfo: nil, repeats: true)
        timer.tolerance = 0.1
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer

        // Sockets rarely survive sleep; reconnect now instead of waiting for heartbeats.
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(didWake), name: NSWorkspace.didWakeNotification, object: nil)
        network.onChange = { [weak self] in self?.reconnectAfterNetworkChange() }
        network.start()
    }

    func shutdown() {
        pollTimer?.invalidate()
        if let appNapActivity { ProcessInfo.processInfo.endActivity(appNapActivity) }
        network.stop()
        engine.stop()
        session.stop()
    }

    @objc private func pollClipboard() {
        engine.poll()
    }

    @objc private func didWake() {
        session.reconnectNow()
    }

    private func reconnectAfterNetworkChange() {
        guard !session.isStopped else { return }
        session.reconnectNow()
    }

    // MARK: Text

    func t(_ key: String, _ params: [String: String] = [:]) -> String {
        L10n.t(settings.language, key, params)
    }

    var statusLabel: String { t(status.state.labelKey) }

    var statusText: String {
        if let detail = status.detail(language: settings.language), !detail.isEmpty {
            return "\(statusLabel) · \(detail)"
        }
        return statusLabel
    }

    func sourceLabel(for event: ClipboardEvent) -> String {
        let name = devices.first { $0.deviceId == event.sourceDeviceId }?.deviceName
        let parts = [name ?? event.sourceDeviceId, event.sourceIp].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? t("devices.unknownIp") : parts.joined(separator: " · ")
    }

    private func show(_ text: String, error: Bool = false) {
        notice = Notice(text: text, isError: error)
        noticeTimer?.invalidate()
        let timer = Timer(timeInterval: error ? 6 : 2.5, target: self, selector: #selector(clearNotice), userInfo: nil, repeats: false)
        RunLoop.main.add(timer, forMode: .common)
        noticeTimer = timer
    }

    @objc private func clearNotice() {
        notice = nil
    }

    // MARK: Hub events

    private func connectionSettings() -> HubConnectionSettings {
        HubConnectionSettings(
            hubUrl: settings.hubUrl,
            token: token,
            deviceId: settings.deviceId,
            deviceName: settings.deviceName,
            receiverPolicy: ReceiverPolicy(settings: settings)
        )
    }

    private func handleHubStatus(_ next: HubStatus) {
        switch next.state {
        case .connected:
            connectionEpoch += 1
            statusTracker.set(next)
            refreshDevices()
            refreshHistory()
            engine.hubBecameReady()
            return
        case .disconnected, .connectionError, .invalidHubUrl, .duplicateDevice:
            connectionEpoch += 1
        default:
            break
        }
        statusTracker.set(next)
    }

    private func handleDevices(_ list: [Device]) {
        devices = list
        do {
            try updateSettings { settings in
                let rules = settings.deviceRules
                let rulesByIp = settings.deviceRulesByIp
                settings.deviceRules = Policy.mergeDeviceRules(rules, existingByIp: rulesByIp, devices: list)
                settings.deviceRulesByIp = Policy.mergeDeviceRulesByIp(rulesByIp, devices: list, existingRules: rules)
            }
        } catch {
            statusTracker.set(HubStatus(.configError, message: error.localizedDescription))
        }
        session.sendReceiverPolicy()
        engine.devicesChanged()
    }

    private func handleConfig(_ config: HubConfig) {
        guard let limit = config.historyDisplayLimit, limit > 0, limit != settings.historyDisplayLimit else { return }
        try? updateSettings { $0.historyDisplayLimit = limit }
        refreshHistory()
    }

    private func handleClipboard(_ event: ClipboardEvent) {
        engine.applyRemote(event)
        historyRevision += 1
        if !rawHistory.contains(where: { $0.id == event.id }) {
            rawHistory.append(event)
        }
        rawHistory = Array(Policy.filterVisibleHistory(rawHistory, settings: settings, limit: settings.historyDisplayLimit).reversed())
        publishHistory()
    }

    private func handleHistoryCleared() {
        historyRevision += 1
        rawHistory = []
        ThumbnailCache.shared.removeAll()
        publishHistory()
    }

    private func publishHistory() {
        history = Policy.filterVisibleHistory(rawHistory, settings: settings, limit: settings.historyDisplayLimit)
    }

    private func reportHubError(_ error: Error, epoch: Int) {
        guard epoch == connectionEpoch else { return }
        statusTracker.set(HubStatus(.hubError, message: error.localizedDescription))
    }

    // MARK: Hub requests

    func refresh() {
        refreshDevices()
        refreshHistory()
    }

    private func refreshDevices() {
        guard session.receiverPolicyReady else { return }
        let epoch = connectionEpoch
        let hubUrl = settings.hubUrl
        let token = token
        Task {
            do {
                let list = try await api.devices(hubUrl: hubUrl, token: token)
                guard epoch == connectionEpoch else { return }
                handleDevices(list)
            } catch {
                reportHubError(error, epoch: epoch)
            }
        }
    }

    private func refreshHistory(retryOnStale: Bool = true) {
        guard session.receiverPolicyReady else { return }
        let epoch = connectionEpoch
        let revision = historyRevision
        let current = settings
        let token = token
        Task {
            do {
                let events = try await api.history(hubUrl: current.hubUrl, token: token, deviceId: current.deviceId, limit: current.historyDisplayLimit)
                guard epoch == connectionEpoch else { return }
                guard revision == historyRevision else {
                    // A live event or clear arrived meanwhile; fetch once more so neither is lost.
                    if retryOnStale { refreshHistory(retryOnStale: false) }
                    return
                }
                rawHistory = events
                publishHistory()
            } catch {
                reportHubError(error, epoch: epoch)
            }
        }
    }

    func clearGlobalHistory() {
        let hubUrl = settings.hubUrl
        let token = token
        Task {
            do {
                try await api.clearHistory(hubUrl: hubUrl, token: token)
                handleHistoryCleared()
                show(t("history.cleared"))
            } catch {
                show("\(t("history.clearFailed")) · \(error.localizedDescription)", error: true)
            }
        }
    }

    // MARK: History actions

    /// Writes a history item to the clipboard and, when `paste` is set and a recent
    /// target app is known, pastes it there with Cmd+V.
    func applyHistory(_ event: ClipboardEvent, paste: Bool) {
        guard engine.writeHistory(event) else {
            show(t("history.writeFailed"), error: true)
            return
        }
        guard paste, let target = pasteTargets.recentTarget else {
            show(t("history.copied"))
            return
        }
        Task {
            // Do not paste if something else replaced the clipboard in the meantime.
            guard engine.clipboardHoldsLastWrite else {
                show(t("history.copied"))
                return
            }
            switch await Paster.paste(into: target) {
            case .pasted:
                show(t("history.pasted"))
            case .permissionRequired:
                show("\(t("history.permissionRequired")) · \(t("history.permissionHint"))", error: true)
            case .failed:
                show(t("history.copied"))
            }
        }
    }

    // MARK: Settings

    private func updateSettings(_ mutate: (inout ClientSettings) -> Void) throws {
        try store.update(mutate)
        if settings != store.settings { settings = store.settings }
    }

    private func applySetting(_ mutate: (inout ClientSettings) -> Void) {
        do {
            try updateSettings(mutate)
        } catch {
            show("\(t("connection.saveFailed")) · \(error.localizedDescription)", error: true)
        }
        session.sendReceiverPolicy()
    }

    // Read-write properties so SwiftUI toggles bind without closure-based bindings.
    var pauseSendEnabled: Bool {
        get { settings.pauseSend }
        set { setPauseSend(newValue) }
    }

    var pauseReceiveEnabled: Bool {
        get { settings.pauseReceive }
        set { setPauseReceive(newValue) }
    }

    var launchAtLoginEnabled: Bool {
        get { launchAtLogin }
        set { setLaunchAtLogin(newValue) }
    }

    var historyAlwaysOnTopEnabled: Bool {
        get { settings.historyAlwaysOnTop }
        set { setHistoryAlwaysOnTop(newValue) }
    }
    func setPauseSend(_ value: Bool) { applySetting { $0.pauseSend = value } }
    func setPauseReceive(_ value: Bool) { applySetting { $0.pauseReceive = value } }
    func setHistoryAlwaysOnTop(_ value: Bool) { applySetting { $0.historyAlwaysOnTop = value } }

    func setLanguage(_ code: String) {
        applySetting { $0.language = L10n.normalizeLanguage(code) }
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            try LoginItem.set(enabled)
            try? updateSettings { $0.autoLaunch = enabled }
        } catch {
            show("\(t("launch.failed")) · \(error.localizedDescription)", error: true)
        }
        if LoginItem.status == .requiresApproval {
            show(t("launch.requiresApproval"), error: true)
        }
        launchAtLogin = LoginItem.isEnabled
    }

    func updateRule(groupKey: String, column: RuleColumn, checked: Bool) {
        let patch = Policy.updateDeviceRule(settings: settings, devices: devices, key: groupKey, column: column, checked: checked)
        applySetting {
            $0.deviceRules = patch.deviceRules
            $0.deviceRulesByIp = patch.deviceRulesByIp
        }
        publishHistory()
        // Receive rules decide which history the Hub returns.
        historyRevision += 1
        refreshHistory()
    }

    /// Saves the Hub URL and, when given, a new token. Returns an error message or nil.
    func saveConnection(hubUrl rawUrl: String, newToken: String) -> String? {
        let hubUrl: String
        do {
            hubUrl = try HubEndpoints.normalizeHubUrl(rawUrl)
        } catch {
            return t("status.invalidHubUrl")
        }
        var changed = hubUrl != settings.hubUrl
        if !newToken.isEmpty && newToken != token {
            do {
                try keychain.write(newToken)
            } catch {
                return error.localizedDescription
            }
            token = newToken
            hasToken = true
            changed = true
        }
        do {
            try updateSettings { $0.hubUrl = hubUrl }
        } catch {
            return error.localizedDescription
        }
        if changed { restartConnection() }
        return nil
    }

    func removeToken() {
        do {
            try keychain.write(nil)
        } catch {
            show(error.localizedDescription, error: true)
            return
        }
        token = nil
        hasToken = false
        restartConnection()
    }

    /// New Hub identity: drop devices and history of the old connection and start over.
    private func restartConnection() {
        session.stop()
        connectionEpoch += 1
        devices = []
        historyRevision += 1
        rawHistory = []
        ThumbnailCache.shared.removeAll()
        publishHistory()
        engine.stop()
        engine.start()
        statusTracker.set(HubStatus(.starting))
        session.start()
    }

    // MARK: Electron migration

    /// First run only: take over the Electron client's Hub URL, token and rules.
    private func importElectronSettings() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        // Electron keeps userData under the package name ("clipboard-hub"); the others are fallbacks.
        for folder in ["clipboard-hub", "Clipboard Sync", "ClipboardSync"] {
            let directory = support.appendingPathComponent(folder, isDirectory: true)
            guard let config = try? Data(contentsOf: directory.appendingPathComponent("config.json")) else { continue }
            let proxy = try? Data(contentsOf: directory.appendingPathComponent("clipboard-sync.proxy.json"))
            guard let imported = ElectronConfigImporter.merge(electronConfig: config, proxyConfig: proxy, into: store.settings) else { continue }
            try? store.replace(with: imported.settings)
            if let importedToken = imported.token, keychain.read() == nil {
                try? keychain.write(importedToken)
            }
            return
        }
    }
}

extension ClipboardEvent {
    var rowId: String { id ?? payloadHash }
}
