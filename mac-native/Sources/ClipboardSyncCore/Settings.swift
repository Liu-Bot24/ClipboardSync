import Foundation

/// Persisted client settings (mirrors `config-store.js`). The Hub token is not
/// part of this file; the app keeps it in the Keychain.
public struct ClientSettings: Codable, Equatable, Sendable {
    public static let defaultMaxSendBytes = 33_554_432
    public static let defaultHistoryDisplayLimit = 30

    public var hubUrl: String
    public var deviceId: String
    public var deviceName: String
    public var autoLaunch: Bool
    public var pauseSend: Bool
    public var pauseReceive: Bool
    public var historyAlwaysOnTop: Bool
    public var historyDisplayLimit: Int
    public var language: String
    public var maxSendBytes: Int
    public var deviceRules: DeviceRules
    public var deviceRulesByIp: DeviceRules

    public init(
        hubUrl: String = "",
        deviceId: String,
        deviceName: String,
        autoLaunch: Bool = true,
        pauseSend: Bool = false,
        pauseReceive: Bool = false,
        historyAlwaysOnTop: Bool = true,
        historyDisplayLimit: Int = ClientSettings.defaultHistoryDisplayLimit,
        language: String = L10n.defaultLanguage,
        maxSendBytes: Int = ClientSettings.defaultMaxSendBytes,
        deviceRules: DeviceRules = [:],
        deviceRulesByIp: DeviceRules = [:]
    ) {
        self.hubUrl = hubUrl
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.autoLaunch = autoLaunch
        self.pauseSend = pauseSend
        self.pauseReceive = pauseReceive
        self.historyAlwaysOnTop = historyAlwaysOnTop
        self.historyDisplayLimit = historyDisplayLimit
        self.language = language
        self.maxSendBytes = maxSendBytes
        self.deviceRules = deviceRules
        self.deviceRulesByIp = deviceRulesByIp
    }

    enum CodingKeys: String, CodingKey {
        case hubUrl, deviceId, deviceName, autoLaunch, pauseSend, pauseReceive, historyAlwaysOnTop
        case historyDisplayLimit, language, maxSendBytes, deviceRules, deviceRulesByIp
    }

    /// Missing keys fall back to defaults so older or hand-edited files still load.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hubUrl = try c.decodeIfPresent(String.self, forKey: .hubUrl) ?? ""
        deviceId = try c.decodeIfPresent(String.self, forKey: .deviceId) ?? ""
        deviceName = try c.decodeIfPresent(String.self, forKey: .deviceName) ?? ""
        autoLaunch = try c.decodeIfPresent(Bool.self, forKey: .autoLaunch) ?? true
        pauseSend = try c.decodeIfPresent(Bool.self, forKey: .pauseSend) ?? false
        pauseReceive = try c.decodeIfPresent(Bool.self, forKey: .pauseReceive) ?? false
        historyAlwaysOnTop = try c.decodeIfPresent(Bool.self, forKey: .historyAlwaysOnTop) ?? true
        let limit = try c.decodeIfPresent(Int.self, forKey: .historyDisplayLimit) ?? Self.defaultHistoryDisplayLimit
        historyDisplayLimit = limit > 0 ? limit : Self.defaultHistoryDisplayLimit
        language = L10n.normalizeLanguage(try c.decodeIfPresent(String.self, forKey: .language))
        let maxBytes = try c.decodeIfPresent(Int.self, forKey: .maxSendBytes) ?? Self.defaultMaxSendBytes
        maxSendBytes = maxBytes > 0 ? maxBytes : Self.defaultMaxSendBytes
        deviceRules = try c.decodeIfPresent(DeviceRules.self, forKey: .deviceRules) ?? [:]
        deviceRulesByIp = try c.decodeIfPresent(DeviceRules.self, forKey: .deviceRulesByIp) ?? [:]
    }
}

public enum SettingsStoreError: Error {
    case encodingFailed
}

/// JSON settings file with atomic, owner-only writes (0600 file, 0700 directory).
public final class SettingsStore {
    public let fileURL: URL
    public private(set) var settings: ClientSettings
    public private(set) var createdOnLoad = false

    private let fileManager = FileManager.default

    public init(directory: URL, defaultDeviceName: String, preferredLanguages: [String]) {
        fileURL = directory.appendingPathComponent("config.json")
        let name = DeviceIdentity.sanitizeName(defaultDeviceName)
        let deviceName = name.isEmpty ? "Mac" : name
        settings = ClientSettings(
            deviceId: DeviceIdentity.randomId(for: deviceName),
            deviceName: deviceName,
            language: L10n.languageForSystem(preferredLanguages)
        )
    }

    /// Loads the file, or keeps the defaults and writes them when it does not exist.
    /// A corrupt file is moved aside (`config.json.broken-<ms>`) instead of being overwritten.
    public func load() throws {
        let defaults = settings
        if let data = try? Data(contentsOf: fileURL) {
            do {
                var loaded = try JSONDecoder().decode(ClientSettings.self, from: data)
                var repaired = false
                if !DeviceIdentity.isValidId(loaded.deviceId) {
                    loaded.deviceId = defaults.deviceId
                    repaired = true
                }
                if DeviceIdentity.sanitizeName(loaded.deviceName).isEmpty {
                    loaded.deviceName = defaults.deviceName
                    repaired = true
                }
                settings = loaded
                createdOnLoad = false
                if repaired { try save() }
                return
            } catch {
                let backup = fileURL.appendingPathExtension("broken-\(Int(Date().timeIntervalSince1970 * 1000))")
                try? fileManager.moveItem(at: fileURL, to: backup)
            }
        }
        createdOnLoad = true
        try save()
    }

    @discardableResult
    public func update(_ mutate: (inout ClientSettings) -> Void) throws -> ClientSettings {
        var next = settings
        mutate(&next)
        guard next != settings else { return settings }
        let previous = settings
        settings = next
        do {
            try save()
        } catch {
            settings = previous
            throw error
        }
        return settings
    }

    /// Replaces the in-memory and on-disk settings (used by the one-time Electron import).
    public func replace(with next: ClientSettings) throws {
        try update { $0 = next }
    }

    private func save() throws {
        let directory = fileURL.deletingLastPathComponent()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(settings)
        try data.write(to: fileURL, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }
}

/// One-time import from the Electron client's `config.json` so switching keeps the
/// Hub address, token and send/receive rules. The device ID is not imported: the
/// native client gets its own, so both apps can briefly run without evicting each
/// other on the Hub. Peers still apply their per-IP rules to the new ID.
public enum ElectronConfigImporter {
    public static let legacyProxyPort = 18787

    public static func merge(electronConfig: Data, proxyConfig: Data?, into base: ClientSettings) -> (settings: ClientSettings, token: String?)? {
        guard let object = (try? JSONSerialization.jsonObject(with: electronConfig)) as? [String: Any] else { return nil }
        var settings = base

        if let hubUrl = object["hubUrl"] as? String, !hubUrl.isEmpty {
            if isLegacyLocalProxyUrl(hubUrl) {
                // The Electron Mac app reached the Hub through a local relay; use the relay's target.
                if let proxyConfig,
                   let proxy = (try? JSONSerialization.jsonObject(with: proxyConfig)) as? [String: Any],
                   let target = proxy["targetUrl"] as? String,
                   let normalized = try? HubEndpoints.normalizeHubUrl(target) {
                    settings.hubUrl = normalized
                }
            } else if let normalized = try? HubEndpoints.normalizeHubUrl(hubUrl) {
                settings.hubUrl = normalized
            }
        }
        if let name = object["deviceName"] as? String, !DeviceIdentity.sanitizeName(name).isEmpty {
            settings.deviceName = DeviceIdentity.sanitizeName(name)
        }
        if let value = object["language"] as? String { settings.language = L10n.normalizeLanguage(value) }
        if let value = object["pauseSend"] as? Bool { settings.pauseSend = value }
        if let value = object["pauseReceive"] as? Bool { settings.pauseReceive = value }
        if let value = object["autoLaunch"] as? Bool { settings.autoLaunch = value }
        if let value = object["historyAlwaysOnTop"] as? Bool { settings.historyAlwaysOnTop = value }
        if let value = object["historyDisplayLimit"] as? Int, value > 0 { settings.historyDisplayLimit = value }
        if let value = object["maxSendBytes"] as? Int, value > 0 { settings.maxSendBytes = value }
        settings.deviceRules = rules(object["deviceRules"]) ?? settings.deviceRules
        settings.deviceRulesByIp = rules(object["deviceRulesByIp"]) ?? settings.deviceRulesByIp

        let token = (object["token"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return (settings, token)
    }

    static func isLegacyLocalProxyUrl(_ value: String) -> Bool {
        guard let components = URLComponents(string: value), let host = components.host?.lowercased() else { return false }
        return components.port == legacyProxyPort && ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host)
    }

    static func rules(_ value: Any?) -> DeviceRules? {
        guard let object = value as? [String: Any] else { return nil }
        var result: DeviceRules = [:]
        for (key, raw) in object {
            if let rule = DeviceRule(json: raw) { result[key] = rule }
        }
        return result
    }
}
