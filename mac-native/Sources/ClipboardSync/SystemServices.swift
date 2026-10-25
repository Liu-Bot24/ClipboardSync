import AppKit
import ApplicationServices
import ClipboardSyncCore
import Network
import Security
import ServiceManagement

/// Hub token in the login Keychain (generic password).
struct KeychainTokenStore {
    let service: String
    let account = "hub-token"

    private var query: [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
    }

    func read() -> String? {
        var item: CFTypeRef?
        var request = query
        request[kSecReturnData] = true
        request[kSecMatchLimit] = kSecMatchLimitOne
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Stores the token; nil or empty deletes it.
    func write(_ token: String?) throws {
        guard let token, !token.isEmpty else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
            return
        }
        let data = Data(token.utf8)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
        if update == errSecItemNotFound {
            var item = query
            item[kSecValueData] = data
            item[kSecAttrLabel] = "Clipboard Sync Hub token"
            let status = SecItemAdd(item as CFDictionary, nil)
            guard status == errSecSuccess else { throw KeychainError(status: status) }
        } else if update != errSecSuccess {
            throw KeychainError(status: update)
        }
    }
}

struct KeychainError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? {
        (SecCopyErrorMessageString(status, nil) as String?) ?? "Keychain error \(status)"
    }
}

/// Launch at login through `SMAppService.mainApp` (macOS 13+). Needs the app bundle.
enum LoginItem {
    static var status: SMAppService.Status { SMAppService.mainApp.status }
    static var isEnabled: Bool { status == .enabled }

    static func set(_ enabled: Bool) throws {
        if enabled {
            if status != .enabled { try SMAppService.mainApp.register() }
        } else if status == .enabled || status == .requiresApproval {
            try SMAppService.mainApp.unregister()
        }
    }
}

/// Tracks the app to paste into from activation notifications (no process polling).
@MainActor
final class PasteTargetTracker: NSObject {
    private var memory: PasteTargetMemory

    override init() {
        memory = PasteTargetMemory(ownPid: ProcessInfo.processInfo.processIdentifier, ownBundleId: Bundle.main.bundleIdentifier)
        super.init()
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(self, selector: #selector(applicationActivated(_:)), name: NSWorkspace.didActivateApplicationNotification, object: nil)
        center.addObserver(self, selector: #selector(applicationTerminated(_:)), name: NSWorkspace.didTerminateApplicationNotification, object: nil)
        memory.observeActivation(Self.target(NSWorkspace.shared.frontmostApplication), at: Date())
    }

    var recentTarget: PasteTarget? { memory.recentTarget(at: Date()) }

    private static func target(_ app: NSRunningApplication?) -> PasteTarget? {
        guard let app else { return nil }
        return PasteTarget(pid: app.processIdentifier, bundleId: app.bundleIdentifier ?? "", name: app.localizedName ?? "")
    }

    @objc private func applicationActivated(_ notification: Notification) {
        let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
        memory.observeActivation(Self.target(app), at: Date())
    }

    @objc private func applicationTerminated(_ notification: Notification) {
        if let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
            memory.forget(pid: app.processIdentifier)
        }
    }
}

enum PasteResult {
    case pasted
    case permissionRequired
    case failed
}

/// Sends Cmd+V to the target app (replaces `scripts/mac-paste-helper.m`). Requires
/// Accessibility permission for this app.
@MainActor
enum Paster {
    static func isTrusted(prompt: Bool) -> Bool {
        // "AXTrustedCheckOptionPrompt" is the value of kAXTrustedCheckOptionPrompt.
        let options = ["AXTrustedCheckOptionPrompt": prompt] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    static func paste(into target: PasteTarget) async -> PasteResult {
        guard isTrusted(prompt: true) else { return .permissionRequired }
        guard let app = NSRunningApplication(processIdentifier: target.pid), !app.isTerminated else { return .failed }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != target.pid {
            if #available(macOS 14.0, *) {
                NSApp.yieldActivation(to: app)
                _ = app.activate()
            } else {
                _ = app.activate(options: [.activateIgnoringOtherApps])
            }
            var waited = 0
            while NSWorkspace.shared.frontmostApplication?.processIdentifier != target.pid {
                guard waited < 1500 else { return .failed }
                try? await Task.sleep(nanoseconds: 50_000_000)
                waited += 50
            }
        }
        // Let the target settle focus (and a closing menu finish) before the keystroke.
        try? await Task.sleep(nanoseconds: 150_000_000)
        return postCommandV() ? .pasted : .failed
    }

    private static func postCommandV() -> Bool {
        let vKey: CGKeyCode = 0x09
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false)
        else { return false }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        return true
    }
}

/// Reports network path changes (interface switch, reconnection) after a short debounce.
final class NetworkWatcher {
    private let monitor = NWPathMonitor()
    private var lastSignature: String?
    private var debounce: DispatchWorkItem?
    var onChange: (() -> Void)?

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async { self?.handle(path) }
        }
        monitor.start(queue: .global(qos: .utility))
    }

    func stop() {
        monitor.cancel()
    }

    private func handle(_ path: NWPath) {
        // Ignore VPN/AWDL-style interfaces (type .other) so they do not cause reconnect churn.
        let interfaces = path.availableInterfaces
            .filter { $0.type != .other && $0.type != .loopback }
            .map(\.name)
            .joined(separator: ",")
        let signature = "\(path.status == .satisfied)|\(interfaces)"
        defer { self.lastSignature = signature }
        // The first update describes the current state; only later changes matter.
        guard let previous = lastSignature, previous != signature, path.status == .satisfied else { return }
        debounce?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.onChange?() }
        debounce = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: item)
    }
}
