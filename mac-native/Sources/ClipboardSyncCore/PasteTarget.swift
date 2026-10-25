import Foundation

public struct PasteTarget: Equatable, Sendable {
    public var pid: Int32
    public var bundleId: String
    public var name: String

    public init(pid: Int32, bundleId: String, name: String) {
        self.pid = pid
        self.bundleId = bundleId
        self.name = name
    }
}

/// Remembers the app to paste into, fed by app-activation notifications (port of
/// `paste-target-memory.js`). The target stays usable while it is frontmost and for
/// `ttl` seconds after it stopped being frontmost.
public struct PasteTargetMemory {
    public enum Action: Equatable { case keep, clear, update }

    public static let ttl: TimeInterval = 30
    public static let ignoredBundleIds: Set<String> = [
        "dev.liuqi.clipboardsync",
        "com.apple.ControlCenter",
        "com.apple.Dock",
        "com.apple.notificationcenterui",
        "com.apple.systemuiserver",
        "com.apple.Spotlight"
    ]
    public static let nonPasteBundleIds: Set<String> = ["com.apple.finder"]

    public let ownPid: Int32
    public let ownBundleId: String?
    public private(set) var target: PasteTarget?
    private var targetIsFrontmost = false
    private var lastFrontmostAt: Date?

    public init(ownPid: Int32, ownBundleId: String?) {
        self.ownPid = ownPid
        self.ownBundleId = ownBundleId
    }

    public func action(for candidate: PasteTarget?) -> Action {
        guard let candidate else { return .keep }
        if candidate.pid == ownPid || candidate.bundleId == ownBundleId { return .keep }
        if Self.ignoredBundleIds.contains(candidate.bundleId) { return .keep }
        if Self.nonPasteBundleIds.contains(candidate.bundleId) { return .clear }
        if candidate.pid <= 0 || candidate.bundleId.isEmpty { return .clear }
        return .update
    }

    public mutating func observeActivation(_ candidate: PasteTarget?, at now: Date) {
        if targetIsFrontmost && candidate?.pid != target?.pid {
            lastFrontmostAt = now
            targetIsFrontmost = false
        }
        switch action(for: candidate) {
        case .keep:
            break
        case .clear:
            target = nil
            targetIsFrontmost = false
        case .update:
            target = candidate
            targetIsFrontmost = true
            lastFrontmostAt = now
        }
    }

    /// The target app terminated.
    public mutating func forget(pid: Int32) {
        if target?.pid == pid {
            target = nil
            targetIsFrontmost = false
        }
    }

    public func recentTarget(at now: Date) -> PasteTarget? {
        guard let target else { return nil }
        if targetIsFrontmost { return target }
        guard let lastFrontmostAt, now.timeIntervalSince(lastFrontmostAt) <= Self.ttl else { return nil }
        return target
    }
}

/// Encoded-image checks shared by the reader and writer (port of `image-limits.js`).
public enum ImageRules {
    public static let maxBytes = 32 * 1024 * 1024
    public static let maxPixels = 64 * 1024 * 1024
    public static let maxEdge = 32_768

    public static func dimensionsAllowed(width: Int, height: Int) -> Bool {
        width > 0 && height > 0 && width <= maxEdge && height <= maxEdge && width * height <= maxPixels
    }

    public static func signatureMatches(_ data: Data, contentType: String) -> Bool {
        let bytes = [UInt8](data.prefix(12))
        switch contentType {
        case "image/png":
            return bytes.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        case "image/jpeg":
            return bytes.starts(with: [0xFF, 0xD8, 0xFF])
        case "image/webp":
            return bytes.count >= 12 && bytes[0..<4].elementsEqual(Array("RIFF".utf8)) && bytes[8..<12].elementsEqual(Array("WEBP".utf8))
        default:
            return false
        }
    }
}
