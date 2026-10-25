import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import ClipboardSyncCore

final class ManualScheduler: Scheduler {
    final class Item: Cancellable {
        let due: TimeInterval
        let block: () -> Void
        var cancelled = false
        init(due: TimeInterval, block: @escaping () -> Void) {
            self.due = due
            self.block = block
        }
        func cancel() { cancelled = true }
    }

    private(set) var now: TimeInterval = 0
    private var items: [Item] = []

    func schedule(after seconds: TimeInterval, _ block: @escaping () -> Void) -> Cancellable {
        let item = Item(due: now + seconds, block: block)
        items.append(item)
        return item
    }

    var pendingDelays: [TimeInterval] {
        items.filter { !$0.cancelled }.map { $0.due - now }.sorted()
    }

    func advance(_ seconds: TimeInterval) {
        let target = now + seconds
        while let next = items.filter({ !$0.cancelled && $0.due <= target }).min(by: { $0.due < $1.due }) {
            next.cancelled = true
            now = next.due
            next.block()
        }
        items.removeAll { $0.cancelled }
        now = target
    }
}

final class FakeTransport: HubTransport {
    let request: URLRequest
    let events: HubTransportEvents
    var sent: [String] = []
    var pingCompletions: [(Error?) -> Void] = []
    var closed = false
    var terminated = false
    var bufferedBytes = 0

    init(request: URLRequest, events: HubTransportEvents) {
        self.request = request
        self.events = events
    }

    func send(_ text: String, completion: @escaping (Error?) -> Void) {
        sent.append(text)
        completion(nil)
    }

    func ping(completion: @escaping (Error?) -> Void) {
        pingCompletions.append(completion)
    }

    func close() { closed = true }

    func terminate() {
        guard !terminated else { return }
        terminated = true
        events.onClose(1006, "")
    }

    // Test drivers
    func open() { events.onOpen() }
    func receive(_ object: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: object)
        events.onText(String(decoding: data, as: UTF8.self))
    }
    func serverClose(_ code: Int, _ reason: String = "") { events.onClose(code, reason) }

    func sentObjects() -> [[String: Any]] {
        sent.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
    }
}

final class FakeTransportFactory: HubTransportFactory {
    var transports: [FakeTransport] = []
    var last: FakeTransport? { transports.last }

    func connect(request: URLRequest, events: HubTransportEvents) -> HubTransport {
        let transport = FakeTransport(request: request, events: events)
        transports.append(transport)
        return transport
    }
}

final class FakeClipboard: ClipboardBackend {
    var changeCount = 0
    var current: ClipboardRead = .empty
    var reads = 0
    var writes: [ClipboardEvent] = []
    var failWrites = false

    func read(maxBytes: Int) throws -> ClipboardRead {
        reads += 1
        if case .snapshot(let snapshot) = current, snapshot.byteLength > maxBytes {
            return .tooLarge(hash: snapshot.hash)
        }
        return current
    }

    func write(_ event: ClipboardEvent) throws -> Int {
        struct WriteError: Error {}
        if failWrites { throw WriteError() }
        writes.append(event)
        changeCount += 1
        current = .snapshot(event.isText ? .text(event.content) : .png(event.payloadData ?? Data()))
        return changeCount
    }

    func userCopies(_ text: String) {
        changeCount += 1
        current = .snapshot(.text(text))
    }
}
