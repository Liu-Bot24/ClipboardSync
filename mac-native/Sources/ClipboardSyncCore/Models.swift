import Foundation

public enum RuleColumn: String, CaseIterable, Sendable {
    case send
    case receive

    public var other: RuleColumn { self == .send ? .receive : .send }
}

/// A per-device (or per-IP) send/receive rule. `nil` means "not decided", which
/// is different from `true`: the policy functions treat the two differently.
public struct DeviceRule: Codable, Equatable, Sendable {
    public var send: Bool?
    public var receive: Bool?

    public init(send: Bool? = nil, receive: Bool? = nil) {
        self.send = send
        self.receive = receive
    }

    public subscript(column: RuleColumn) -> Bool? {
        get { column == .send ? send : receive }
        set {
            if column == .send { send = newValue } else { receive = newValue }
        }
    }

    init?(json: Any?) {
        guard let object = json as? [String: Any] else { return nil }
        send = object["send"] as? Bool
        receive = object["receive"] as? Bool
    }
}

public typealias DeviceRules = [String: DeviceRule]

public struct Device: Equatable, Hashable, Identifiable, Sendable {
    public var deviceId: String
    public var deviceName: String?
    public var ip: String?
    public var connectedAt: String?

    public var id: String { deviceId }

    public init(deviceId: String, deviceName: String? = nil, ip: String? = nil, connectedAt: String? = nil) {
        self.deviceId = deviceId
        self.deviceName = deviceName
        self.ip = ip
        self.connectedAt = connectedAt
    }

    public init?(json: Any?) {
        guard let object = json as? [String: Any], let deviceId = object["deviceId"] as? String, !deviceId.isEmpty else {
            return nil
        }
        self.deviceId = deviceId
        deviceName = object["deviceName"] as? String
        ip = object["ip"] as? String
        connectedAt = object["connectedAt"] as? String
    }
}

/// A clipboard event as stored and broadcast by the Hub (`clipboard.update`).
public struct ClipboardEvent: Equatable, Sendable {
    public var id: String?
    public var sourceDeviceId: String?
    public var sourceIp: String?
    public var clientEventId: String?
    public var contentType: String
    public var encoding: String
    public var content: String
    public var byteLength: Int?
    public var sha256: String?
    public var targetDeviceIds: [String]?
    public var sequence: Int?
    public var createdAt: String?

    public init(
        id: String? = nil,
        sourceDeviceId: String? = nil,
        sourceIp: String? = nil,
        clientEventId: String? = nil,
        contentType: String,
        encoding: String,
        content: String,
        byteLength: Int? = nil,
        sha256: String? = nil,
        targetDeviceIds: [String]? = nil,
        sequence: Int? = nil,
        createdAt: String? = nil
    ) {
        self.id = id
        self.sourceDeviceId = sourceDeviceId
        self.sourceIp = sourceIp
        self.clientEventId = clientEventId
        self.contentType = contentType
        self.encoding = encoding
        self.content = content
        self.byteLength = byteLength
        self.sha256 = sha256
        self.targetDeviceIds = targetDeviceIds
        self.sequence = sequence
        self.createdAt = createdAt
    }

    public init?(json: Any?) {
        guard
            let object = json as? [String: Any],
            let contentType = object["contentType"] as? String,
            let encoding = object["encoding"] as? String,
            let content = object["content"] as? String
        else { return nil }
        self.contentType = contentType
        self.encoding = encoding
        self.content = content
        id = object["id"] as? String
        sourceDeviceId = object["sourceDeviceId"] as? String
        sourceIp = object["sourceIp"] as? String
        clientEventId = object["clientEventId"] as? String
        byteLength = object["byteLength"] as? Int
        sha256 = object["sha256"] as? String
        targetDeviceIds = object["targetDeviceIds"] as? [String]
        sequence = object["sequence"] as? Int
        createdAt = object["createdAt"] as? String
    }

    public var isText: Bool { contentType == "text/plain" }
    public var isImage: Bool { contentType.hasPrefix("image/") }

    /// Decoded payload bytes: UTF-8 for text, base64-decoded for images.
    public var payloadData: Data? {
        if isText { return Data(content.utf8) }
        return Data(base64Encoded: content)
    }

    /// SHA-256 of the decoded payload. The Hub computes the same digest; trust it
    /// when it is well formed so large images are not hashed twice.
    public var payloadHash: String {
        if let sha256, Hashing.isHexDigest(sha256) { return sha256 }
        return Hashing.sha256Hex(payloadData ?? Data())
    }
}

/// A local clipboard reading, ready to send as `clipboard.update`.
public struct ClipboardSnapshot: Equatable, Sendable {
    public var contentType: String
    public var encoding: String
    public var content: String
    public var byteLength: Int
    public var hash: String

    public init(contentType: String, encoding: String, content: String, byteLength: Int, hash: String) {
        self.contentType = contentType
        self.encoding = encoding
        self.content = content
        self.byteLength = byteLength
        self.hash = hash
    }

    public static func text(_ text: String) -> ClipboardSnapshot {
        let data = Data(text.utf8)
        return ClipboardSnapshot(
            contentType: "text/plain",
            encoding: "utf8",
            content: text,
            byteLength: data.count,
            hash: Hashing.sha256Hex(data)
        )
    }

    public static func png(_ data: Data) -> ClipboardSnapshot {
        ClipboardSnapshot(
            contentType: "image/png",
            encoding: "base64",
            content: data.base64EncodedString(),
            byteLength: data.count,
            hash: Hashing.sha256Hex(data)
        )
    }
}

public struct HubConfig: Equatable, Sendable {
    public var receiverPolicyRevision: Bool
    public var historyDisplayLimit: Int?
    public var maxHistoryEntries: Int?

    public init(receiverPolicyRevision: Bool = false, historyDisplayLimit: Int? = nil, maxHistoryEntries: Int? = nil) {
        self.receiverPolicyRevision = receiverPolicyRevision
        self.historyDisplayLimit = historyDisplayLimit
        self.maxHistoryEntries = maxHistoryEntries
    }

    public init(json: [String: Any]) {
        receiverPolicyRevision = (json["receiverPolicyRevision"] as? Bool) == true
        historyDisplayLimit = json["historyDisplayLimit"] as? Int
        maxHistoryEntries = json["maxHistoryEntries"] as? Int
    }
}

public enum DeviceIdentity {
    private static let idCharacters = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-")

    /// Matches the Hub's `^[A-Za-z0-9_.-]{1,64}$`.
    public static func isValidId(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 64 && value.allSatisfy { idCharacters.contains($0) }
    }

    public static func sanitize(_ value: String) -> String {
        let mapped = String(value.map { idCharacters.contains($0) ? $0 : "-" }.prefix(64))
        return mapped.isEmpty ? "device" : mapped
    }

    public static func randomId(for deviceName: String, uuid: UUID = UUID()) -> String {
        let suffix = uuid.uuidString.lowercased()
        var prefix = String(sanitize(deviceName).prefix(64 - suffix.count - 1))
        if prefix.isEmpty { prefix = "device" }
        return "\(prefix)-\(suffix)"
    }

    /// The Hub accepts names matching `^[^\n\r\t]{1,80}$` and falls back to the ID otherwise.
    public static func sanitizeName(_ value: String) -> String {
        let cleaned = value.filter { $0 != "\n" && $0 != "\r" && $0 != "\t" }
        var result = ""
        for character in cleaned {
            if (result + String(character)).utf16.count > 80 { break }
            result.append(character)
        }
        return result
    }
}
