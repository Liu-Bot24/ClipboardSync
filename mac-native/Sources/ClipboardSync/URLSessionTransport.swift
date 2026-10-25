import ClipboardSyncCore
import Foundation

/// `URLSessionWebSocketTask` behind the core's `HubTransport`. One URLSession per
/// connection, delegate callbacks on the main queue.
final class URLSessionTransportFactory: HubTransportFactory {
    /// Upper bound for one incoming message (Hub payload limit 32 MiB as base64 plus JSON).
    static let maxMessageBytes = 64 * 1024 * 1024

    func connect(request: URLRequest, events: HubTransportEvents) -> HubTransport {
        URLSessionTransport(request: request, events: events)
    }
}

final class URLSessionTransport: NSObject, HubTransport, URLSessionWebSocketDelegate {
    private let events: HubTransportEvents
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var opened = false
    private var finished = false
    private(set) var bufferedBytes = 0

    init(request: URLRequest, events: HubTransportEvents) {
        self.events = events
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        // Connect directly like the Electron client (`ws` ignores system proxies); a LAN Hub
        // must not be routed through an HTTP proxy.
        configuration.connectionProxyDictionary = [:]
        configuration.waitsForConnectivity = false
        // The handshake deadline is enforced by HubSession; idle sockets are kept alive by
        // 30 s pings, so the per-request idle timeout must not cut a quiet connection.
        configuration.timeoutIntervalForRequest = 300
        configuration.timeoutIntervalForResource = 7 * 24 * 3600
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = URLSessionTransportFactory.maxMessageBytes
        self.session = session
        self.task = task
        task.resume()
        receiveNext()
    }

    func send(_ text: String, completion: @escaping (Error?) -> Void) {
        guard let task, !finished else {
            completion(URLError(.notConnectedToInternet))
            return
        }
        let size = text.utf8.count
        bufferedBytes += size
        task.send(.string(text)) { [weak self] error in
            DispatchQueue.main.async {
                self?.bufferedBytes -= size
                completion(error)
            }
        }
    }

    func ping(completion: @escaping (Error?) -> Void) {
        guard let task, !finished else {
            completion(URLError(.notConnectedToInternet))
            return
        }
        task.sendPing { error in
            DispatchQueue.main.async { completion(error) }
        }
    }

    func close() {
        guard !finished else { return }
        finished = true
        task?.cancel(with: .normalClosure, reason: nil)
        session?.finishTasksAndInvalidate()
        release()
    }

    func terminate() {
        guard !finished else { return }
        finished = true
        task?.cancel()
        session?.invalidateAndCancel()
        release()
        // Deliver asynchronously so callers never re-enter HubSession from inside terminate().
        let events = events
        DispatchQueue.main.async {
            events.onClose(1006, "")
        }
    }

    private func receiveNext() {
        task?.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, !self.finished else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        self.events.onText(text)
                    case .data(let data):
                        self.events.onText(String(decoding: data, as: UTF8.self))
                    @unknown default:
                        break
                    }
                    self.receiveNext()
                case .failure(let error):
                    self.finish(code: self.closeCode(), reason: self.closeReason(), error: error)
                }
            }
        }
    }

    private func closeCode() -> Int {
        let code = task?.closeCode.rawValue ?? 0
        return code == 0 ? 1006 : code
    }

    private func closeReason() -> String {
        task?.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? ""
    }

    private func finish(code: Int, reason: String, error: Error?) {
        guard !finished else { return }
        finished = true
        // A close frame from the Hub (e.g. 4000) is not a transport error.
        if let error, code == 1006 {
            events.onError(describe(error))
        }
        events.onClose(code, reason)
        task?.cancel()
        session?.invalidateAndCancel()
        release()
    }

    private func release() {
        task = nil
        session = nil
    }

    private func describe(_ error: Error) -> String {
        if let response = task?.response as? HTTPURLResponse, !(200..<300).contains(response.statusCode), response.statusCode != 101 {
            return "Unexpected server response: \(response.statusCode)"
        }
        return error.localizedDescription
    }

    // MARK: URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task, !finished, !opened else { return }
        opened = true
        events.onOpen()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        let code = closeCode.rawValue == 0 ? 1006 : closeCode.rawValue
        finish(code: code, reason: reason.map { String(decoding: $0, as: UTF8.self) } ?? "", error: nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === self.task else { return }
        finish(code: closeCode(), reason: closeReason(), error: error ?? URLError(.networkConnectionLost))
    }
}
