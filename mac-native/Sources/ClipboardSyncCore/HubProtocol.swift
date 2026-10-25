import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum HubEndpointError: Error, Equatable, LocalizedError {
    case invalid
    case unsupportedScheme

    public var errorDescription: String? {
        switch self {
        case .invalid: return "Invalid Hub URL"
        case .unsupportedScheme: return "The Hub URL must use http or https"
        }
    }
}

/// URL handling mirroring `settings-validation.js` and `hub-client.js`.
public enum HubEndpoints {
    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// Adds `http://` when no scheme is given, requires http/https and a host, and
    /// drops query, fragment and trailing slashes: `nas:8787/` -> `http://nas:8787`.
    public static func normalizeHubUrl(_ value: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw HubEndpointError.invalid }
        let hasScheme = trimmed.range(of: "^[A-Za-z][A-Za-z0-9+.-]*://", options: .regularExpression) != nil
        guard var components = URLComponents(string: hasScheme ? trimmed : "http://\(trimmed)"),
              let scheme = components.scheme?.lowercased()
        else { throw HubEndpointError.invalid }
        guard scheme == "http" || scheme == "https" else { throw HubEndpointError.unsupportedScheme }
        guard let host = components.host, !host.isEmpty else { throw HubEndpointError.invalid }
        components.scheme = scheme
        components.query = nil
        components.fragment = nil
        var path = components.path
        while path.hasSuffix("/") { path.removeLast() }
        components.path = path
        guard let string = components.string else { throw HubEndpointError.invalid }
        return string
    }

    static func percentEncode(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
    }

    /// Like `new URL(path, hubUrl)` in the Electron client: the path replaces any path on the Hub URL.
    public static func url(hubUrl: String, path: String, query: [(String, String)] = [], webSocket: Bool = false) throws -> URL {
        guard var components = URLComponents(string: try normalizeHubUrl(hubUrl)) else { throw HubEndpointError.invalid }
        if webSocket {
            components.scheme = components.scheme == "https" ? "wss" : "ws"
        }
        components.path = path
        components.percentEncodedQuery = query.isEmpty
            ? nil
            : query.map { "\(percentEncode($0.0))=\(percentEncode($0.1))" }.joined(separator: "&")
        guard let url = components.url else { throw HubEndpointError.invalid }
        return url
    }

    public static func webSocketURL(hubUrl: String, deviceId: String, deviceName: String) throws -> URL {
        try url(hubUrl: hubUrl, path: "/v1/ws", query: [("deviceId", deviceId), ("deviceName", deviceName)], webSocket: true)
    }

    public static func request(_ url: URL, token: String?, method: String = "GET", timeout: TimeInterval = 10) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }
}

/// Messages received from the Hub over the WebSocket.
public enum HubMessage {
    case devices([Device])
    case config(HubConfig)
    case clipboard(ClipboardEvent)
    case ack(clientEventId: String?, id: String?, status: String?)
    case historyCleared
    case receiverPolicyUpdated(revision: Int?)
    case error(String?)
    case unknown(String?)

    /// `nil` when the text is not a JSON object.
    public static func parse(_ text: String) -> HubMessage? {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return nil }
        return parse(object)
    }

    public static func parse(_ object: [String: Any]) -> HubMessage? {
        let type = object["type"] as? String
        switch type {
        case "hub.devices":
            let list = object["devices"] as? [Any] ?? []
            return .devices(list.compactMap { Device(json: $0) })
        case "hub.config":
            return .config(HubConfig(json: object))
        case "clipboard.update":
            guard let event = ClipboardEvent(json: object) else { return nil }
            return .clipboard(event)
        case "clipboard.ack":
            return .ack(clientEventId: object["clientEventId"] as? String, id: object["id"] as? String, status: object["status"] as? String)
        case "hub.history-cleared":
            return .historyCleared
        case "hub.receiver-policy-updated":
            return .receiverPolicyUpdated(revision: object["policyRevision"] as? Int)
        case "error":
            return .error(object["message"] as? String)
        default:
            return .unknown(type)
        }
    }
}

/// Messages sent to the Hub.
public enum ClientMessage {
    public static func receiverPolicy(_ policy: ReceiverPolicy, revision: Int) -> String {
        serialize(["type": "client.receiver-policy", "policy": policy.jsonObject, "policyRevision": revision])
    }

    /// `targetDeviceIds` is omitted when nil: the Hub rejects `null` and treats a missing field as broadcast.
    public static func clipboardUpdate(_ snapshot: ClipboardSnapshot, clientEventId: String?, targetDeviceIds: [String]?) -> String {
        var object: [String: Any] = [
            "type": "clipboard.update",
            "contentType": snapshot.contentType,
            "encoding": snapshot.encoding,
            "content": snapshot.content
        ]
        if let clientEventId { object["clientEventId"] = clientEventId }
        if let targetDeviceIds { object["targetDeviceIds"] = targetDeviceIds }
        return serialize(object)
    }

    static func serialize(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

public enum HubAPIError: Error, LocalizedError {
    case status(Int)
    case invalidResponse

    public var errorDescription: String? {
        switch self {
        case .status(let code): return "Hub request failed: \(code)"
        case .invalidResponse: return "Invalid Hub response"
        }
    }
}

/// REST endpoints used next to the WebSocket: devices, config, history, clear history.
public struct HubAPI: @unchecked Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func devices(hubUrl: String, token: String?) async throws -> [Device] {
        let body = try await json(HubEndpoints.request(try HubEndpoints.url(hubUrl: hubUrl, path: "/v1/devices"), token: token))
        return (body["devices"] as? [Any] ?? []).compactMap { Device(json: $0) }
    }

    public func config(hubUrl: String, token: String?) async throws -> HubConfig {
        HubConfig(json: try await json(HubEndpoints.request(try HubEndpoints.url(hubUrl: hubUrl, path: "/v1/config"), token: token)))
    }

    public func history(hubUrl: String, token: String?, deviceId: String, limit: Int) async throws -> [ClipboardEvent] {
        let url = try HubEndpoints.url(hubUrl: hubUrl, path: "/v1/history", query: [("limit", String(limit)), ("deviceId", deviceId)])
        let body = try await json(HubEndpoints.request(url, token: token, timeout: 20))
        return (body["events"] as? [Any] ?? []).compactMap { ClipboardEvent(json: $0) }
    }

    @discardableResult
    public func clearHistory(hubUrl: String, token: String?) async throws -> Int? {
        let url = try HubEndpoints.url(hubUrl: hubUrl, path: "/v1/history")
        let body = try await json(HubEndpoints.request(url, token: token, method: "DELETE"))
        return body["cleared"] as? Int
    }

    private func json(_ request: URLRequest) async throws -> [String: Any] {
        let (data, response): (Data, URLResponse) = try await withCheckedThrowingContinuation { continuation in
            session.dataTask(with: request) { data, response, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let data, let response {
                    continuation.resume(returning: (data, response))
                } else {
                    continuation.resume(throwing: HubAPIError.invalidResponse)
                }
            }.resume()
        }
        guard let http = response as? HTTPURLResponse else { throw HubAPIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw HubAPIError.status(http.statusCode) }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw HubAPIError.invalidResponse }
        return object
    }
}
