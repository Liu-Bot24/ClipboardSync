import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

public enum IPAddress {
    /// Equivalent of Node's `net.isIP(value) !== 0` for plain IPv4/IPv6 literals.
    public static func isValid(_ value: String) -> Bool {
        guard !value.isEmpty else { return false }
        var v4 = in_addr()
        var v6 = in6_addr()
        return value.withCString { pointer in
            inet_pton(AF_INET, pointer, &v4) == 1 || inet_pton(AF_INET6, pointer, &v6) == 1
        }
    }
}

/// Port of `src/client/policy.js`. Rules are looked up by device ID first, then by
/// the device's IP (`deviceRulesByIp`), then by an IP key in `deviceRules`.
public enum Policy {
    static func rule(for device: Device, rules: DeviceRules, rulesByIp: DeviceRules) -> DeviceRule {
        if let rule = rules[device.deviceId] { return rule }
        if let ip = device.ip {
            if let rule = rulesByIp[ip] { return rule }
            if let rule = rules[ip] { return rule }
        }
        return DeviceRule()
    }

    static func deviceRule(_ settings: ClientSettings, _ device: Device) -> DeviceRule {
        rule(for: device, rules: settings.deviceRules, rulesByIp: settings.deviceRulesByIp)
    }

    static func eventRule(_ settings: ClientSettings, _ event: ClipboardEvent) -> DeviceRule {
        if let source = event.sourceDeviceId, let rule = settings.deviceRules[source] { return rule }
        if let ip = event.sourceIp {
            if let rule = settings.deviceRulesByIp[ip] { return rule }
            if let rule = settings.deviceRules[ip] { return rule }
        }
        return DeviceRule()
    }

    static func isAddressedToThisDevice(_ event: ClipboardEvent, _ settings: ClientSettings) -> Bool {
        guard let targets = event.targetDeviceIds else { return true }
        return event.sourceDeviceId == settings.deviceId || targets.contains(settings.deviceId)
    }

    static func hasSendRestriction(_ settings: ClientSettings, selfDeviceId: String) -> Bool {
        settings.deviceRules.contains { $0.key != selfDeviceId && $0.value.send == false } ||
            settings.deviceRulesByIp.values.contains { $0.send == false }
    }

    static func rememberedAllowedTargetIds(_ settings: ClientSettings, visiblePeerIds: Set<String>, selfDeviceId: String) -> [String] {
        settings.deviceRules
            .filter { key, rule in
                key != selfDeviceId && !IPAddress.isValid(key) && !visiblePeerIds.contains(key) && rule.send == true
            }
            .map(\.key)
            .sorted()
    }

    static func uniformColumnRule(rules: DeviceRules, rulesByIp: DeviceRules, devices: [Device], column: RuleColumn) -> Bool? {
        let values = devices.map { rule(for: $0, rules: rules, rulesByIp: rulesByIp)[column] != false }
        guard let first = values.first else { return true }
        return values.allSatisfy { $0 == first } ? first : nil
    }

    public static func shouldDeferRestrictedSend(devices: [Device], settings: ClientSettings, selfDeviceId: String) -> Bool {
        let peers = devices.filter { $0.deviceId != selfDeviceId }
        let visible = Set(peers.map(\.deviceId))
        return peers.isEmpty &&
            hasSendRestriction(settings, selfDeviceId: selfDeviceId) &&
            rememberedAllowedTargetIds(settings, visiblePeerIds: visible, selfDeviceId: selfDeviceId).isEmpty
    }

    /// `nil` means broadcast (no `targetDeviceIds` field); an empty array means nobody may receive.
    public static func buildTargetDeviceIds(devices: [Device], settings: ClientSettings, selfDeviceId: String) -> [String]? {
        let peers = devices.filter { $0.deviceId != selfDeviceId }
        let visible = Set(peers.map(\.deviceId))
        let hasBlockedPeer = peers.contains { deviceRule(settings, $0).send == false }
        if !hasBlockedPeer && !hasSendRestriction(settings, selfDeviceId: selfDeviceId) {
            return nil
        }
        var targets = peers.filter { deviceRule(settings, $0).send != false }.map(\.deviceId)
        targets.append(contentsOf: rememberedAllowedTargetIds(settings, visiblePeerIds: visible, selfDeviceId: selfDeviceId))
        return targets
    }

    public static func isReceiveAllowed(_ event: ClipboardEvent, settings: ClientSettings) -> Bool {
        isAddressedToThisDevice(event, settings) && eventRule(settings, event).receive != false
    }

    /// Hub order is oldest first; the result is newest first, at most `limit` entries.
    public static func filterVisibleHistory(_ events: [ClipboardEvent], settings: ClientSettings, limit: Int) -> [ClipboardEvent] {
        Array(events.filter { isReceiveAllowed($0, settings: settings) }.suffix(max(0, limit)).reversed())
    }

    public static func mergeDeviceRulesByIp(_ existingByIp: DeviceRules, devices: [Device], existingRules: DeviceRules) -> DeviceRules {
        var next = existingByIp
        var devicesByIp: [String: [Device]] = [:]
        for device in devices {
            guard let ip = device.ip, !ip.isEmpty else { continue }
            devicesByIp[ip, default: []].append(device)
        }
        for (ip, ipDevices) in devicesByIp {
            var rule = existingByIp[ip] ?? DeviceRule()
            for column in RuleColumn.allCases where rule[column] == nil {
                if let uniform = uniformColumnRule(rules: existingRules, rulesByIp: existingByIp, devices: ipDevices, column: column) {
                    rule[column] = uniform
                }
            }
            next[ip] = rule
        }
        return next
    }

    public static func mergeDeviceRules(_ existingRules: DeviceRules, existingByIp: DeviceRules, devices: [Device]) -> DeviceRules {
        var next = existingRules
        for device in devices {
            let ip = device.ip
            func value(_ column: RuleColumn) -> Bool {
                if let value = existingRules[device.deviceId]?[column] { return value }
                if let ip, let value = existingByIp[ip]?[column] { return value }
                if let ip, let value = existingRules[ip]?[column] { return value }
                return true
            }
            next[device.deviceId] = DeviceRule(send: value(.send), receive: value(.receive))
        }
        return next
    }

    /// Port of `updateDeviceRule`. `key` is a device group key: an IP address or a device ID.
    public static func updateDeviceRule(
        settings: ClientSettings,
        devices: [Device],
        key: String,
        column: RuleColumn,
        checked: Bool
    ) -> (deviceRules: DeviceRules, deviceRulesByIp: DeviceRules) {
        if IPAddress.isValid(key) {
            let matching = devices.filter { $0.ip == key }
            let ipRule = settings.deviceRulesByIp[key] ?? settings.deviceRules[key] ?? DeviceRule()
            var nextRule = DeviceRule()
            nextRule[column] = checked
            let other = column.other
            if let existing = ipRule[other] {
                nextRule[other] = existing
            } else if let uniform = uniformColumnRule(
                rules: settings.deviceRules, rulesByIp: settings.deviceRulesByIp, devices: matching, column: other
            ) {
                nextRule[other] = uniform
            }
            var rules = settings.deviceRules
            for device in matching {
                let current = deviceRule(settings, device)
                var rule = DeviceRule(send: current.send ?? true, receive: current.receive ?? true)
                rule[column] = checked
                rules[device.deviceId] = rule
            }
            var byIp = settings.deviceRulesByIp
            byIp[key] = nextRule
            return (rules, byIp)
        }

        let device = devices.first { $0.deviceId == key }
        let current = device.map { deviceRule(settings, $0) } ?? settings.deviceRules[key] ?? DeviceRule()
        var nextRule = DeviceRule(send: current.send ?? true, receive: current.receive ?? true)
        nextRule[column] = checked
        var rules = settings.deviceRules
        rules[key] = nextRule
        var byIp = settings.deviceRulesByIp
        if let ip = device?.ip, !ip.isEmpty {
            byIp[ip] = nextRule
        }
        return (rules, byIp)
    }
}

/// Port of `receiverPolicyFromSettings` in `src/receive-policy.js`. The Hub applies
/// this per receiver, so blocked sources are filtered before events reach us.
public struct ReceiverPolicy: Equatable, Sendable {
    public static let maxEntries = 512

    public var allowedSourceDeviceIds: [String]
    public var blockedSourceDeviceIds: [String]
    public var blockedSourceIps: [String]

    public init(allowedSourceDeviceIds: [String] = [], blockedSourceDeviceIds: [String] = [], blockedSourceIps: [String] = []) {
        self.allowedSourceDeviceIds = allowedSourceDeviceIds
        self.blockedSourceDeviceIds = blockedSourceDeviceIds
        self.blockedSourceIps = blockedSourceIps
    }

    public init(settings: ClientSettings) {
        var allowed: Set<String> = []
        var blockedIds: Set<String> = []
        var blockedIps: Set<String> = []
        for (key, rule) in settings.deviceRules {
            if rule.receive == true {
                if DeviceIdentity.isValidId(key) && !IPAddress.isValid(key) { allowed.insert(key) }
                continue
            }
            guard rule.receive == false else { continue }
            if IPAddress.isValid(key) {
                blockedIps.insert(key)
            } else if DeviceIdentity.isValidId(key) {
                blockedIds.insert(key)
            }
        }
        for (ip, rule) in settings.deviceRulesByIp where rule.receive == false && IPAddress.isValid(ip) {
            blockedIps.insert(ip)
        }
        // Sorted so the same rules always produce the same message and signature.
        allowedSourceDeviceIds = Array(allowed.sorted().prefix(Self.maxEntries))
        blockedSourceDeviceIds = Array(blockedIds.sorted().prefix(Self.maxEntries))
        blockedSourceIps = Array(blockedIps.sorted().prefix(Self.maxEntries))
    }

    public var jsonObject: [String: Any] {
        [
            "allowedSourceDeviceIds": allowedSourceDeviceIds,
            "blockedSourceDeviceIds": blockedSourceDeviceIds,
            "blockedSourceIps": blockedSourceIps
        ]
    }
}

/// UI grouping of peers by IP, as in `ui-renderer.js`.
public struct DeviceGroup: Identifiable, Equatable, Sendable {
    public enum CheckState: Equatable, Sendable { case on, off, mixed }

    public var key: String
    public var ip: String?
    public var devices: [Device]

    public var id: String { key }

    public static func peerGroups(devices: [Device], selfDeviceId: String) -> [DeviceGroup] {
        var groups: [DeviceGroup] = []
        for device in devices where device.deviceId != selfDeviceId {
            let ip = (device.ip?.isEmpty == false) ? device.ip : nil
            let key = ip ?? device.deviceId
            if let index = groups.firstIndex(where: { $0.key == key }) {
                groups[index].devices.append(device)
            } else {
                groups.append(DeviceGroup(key: key, ip: ip, devices: [device]))
            }
        }
        return groups
    }

    public func state(_ column: RuleColumn, settings: ClientSettings) -> CheckState {
        let values = devices.map { device -> Bool in
            let rule = settings.deviceRules[device.deviceId]
                ?? device.ip.flatMap { settings.deviceRulesByIp[$0] }
                ?? DeviceRule(send: true, receive: true)
            return rule[column] != false
        }
        if values.allSatisfy({ $0 }) { return .on }
        return values.contains(true) ? .mixed : .off
    }
}
