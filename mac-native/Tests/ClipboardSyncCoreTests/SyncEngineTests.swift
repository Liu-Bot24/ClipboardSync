import XCTest
@testable import ClipboardSyncCore

final class SyncEngineTests: XCTestCase {
    struct Sent: Equatable {
        var snapshot: ClipboardSnapshot
        var clientEventId: String
        var targets: [String]?
    }

    var clipboard: FakeClipboard!
    var settings: ClientSettings!
    var devices: [Device] = []
    var sent: [Sent] = []
    var connected = true
    var clock = Date(timeIntervalSince1970: 1_000)
    var nextId = 0
    var engine: SyncEngine!

    override func setUp() {
        super.setUp()
        clipboard = FakeClipboard()
        settings = makeSettings()
        devices = [Device(deviceId: "macbook", ip: "192.0.2.10"), Device(deviceId: "main-pc", ip: "192.0.2.20")]
        sent = []
        connected = true
        nextId = 0
        engine = SyncEngine(
            backend: clipboard,
            settings: { [unowned self] in self.settings },
            devices: { [unowned self] in self.devices },
            send: { [unowned self] snapshot, id, targets in
                guard self.connected else { return false }
                self.sent.append(Sent(snapshot: snapshot, clientEventId: id, targets: targets))
                return true
            },
            now: { [unowned self] in self.clock },
            makeId: { [unowned self] in
                self.nextId += 1
                return "id-\(self.nextId)"
            }
        )
    }

    private func remote(_ text: String, from source: String = "main-pc", id: String = "hub-1", clientEventId: String? = nil) -> ClipboardEvent {
        ClipboardEvent(id: id, sourceDeviceId: source, sourceIp: "192.0.2.20", clientEventId: clientEventId,
                       contentType: "text/plain", encoding: "utf8", content: text)
    }

    func testBaselineIsNotSent() {
        clipboard.userCopies("already there")
        engine.start()
        engine.poll()
        XCTAssertTrue(sent.isEmpty)
    }

    func testLocalCopyIsReadOnceAndSentOnce() {
        engine.start()
        clipboard.userCopies("hello")
        let readsBefore = clipboard.reads
        engine.poll()
        XCTAssertEqual(sent, [Sent(snapshot: .text("hello"), clientEventId: "id-1", targets: nil)])
        engine.poll()
        engine.poll()
        XCTAssertEqual(clipboard.reads, readsBefore + 1, "no re-read without a change count change")
        XCTAssertEqual(sent.count, 1)
    }

    func testUnacknowledgedSendIsRetriedWithSameIdUntilAck() {
        engine.start()
        clipboard.userCopies("hello")
        engine.poll()
        clock += 4
        engine.poll()
        XCTAssertEqual(sent.count, 1)
        clock += 1
        engine.poll()
        XCTAssertEqual(sent.map(\.clientEventId), ["id-1", "id-1"])
        engine.handleAck(clientEventId: "id-1")
        clock += 10
        engine.poll()
        XCTAssertEqual(sent.count, 2)
    }

    func testRetriesStopAfterMaxAttempts() {
        engine.start()
        clipboard.userCopies("hello")
        engine.poll()
        for _ in 0..<20 {
            clock += 5
            engine.poll()
        }
        XCTAssertEqual(sent.count, SyncEngine.maxSendAttempts)
    }

    func testRemoteWriteIsNotSentBack() {
        engine.start()
        engine.applyRemote(remote("from pc"))
        XCTAssertEqual(clipboard.writes.count, 1)
        engine.poll()
        XCTAssertTrue(sent.isEmpty)
        XCTAssertTrue(engine.clipboardHoldsLastWrite)
    }

    func testRecopyingSameContentIsNotANewEvent() {
        engine.start()
        engine.applyRemote(remote("same"))
        clipboard.userCopies("same")
        engine.poll()
        XCTAssertTrue(sent.isEmpty)
        clipboard.userCopies("different")
        engine.poll()
        XCTAssertEqual(sent.count, 1)
    }

    func testPauseAndReceiveRulesBlockRemoteWrites() {
        engine.start()
        settings.pauseReceive = true
        engine.applyRemote(remote("a"))
        settings.pauseReceive = false
        settings.deviceRules = ["main-pc": rule(true, false)]
        engine.applyRemote(remote("b", id: "hub-2"))
        XCTAssertTrue(clipboard.writes.isEmpty)
        settings.deviceRules = [:]
        engine.applyRemote(remote("c", id: "hub-3"))
        XCTAssertEqual(clipboard.writes.map(\.content), ["c"])
    }

    func testPauseSendSkipsWithoutReading() {
        engine.start()
        settings.pauseSend = true
        let readsBefore = clipboard.reads
        clipboard.userCopies("secret")
        engine.poll()
        XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(clipboard.reads, readsBefore)
    }

    func testOversizedCopyIsNotSent() {
        engine.start()
        settings.maxSendBytes = 3
        clipboard.userCopies("too long")
        engine.poll()
        XCTAssertTrue(sent.isEmpty)
    }

    func testCopyMadeOfflineIsSentWhenHubBecomesReady() {
        engine.start()
        connected = false
        clipboard.userCopies("offline")
        engine.poll()
        XCTAssertTrue(sent.isEmpty)
        connected = true
        engine.hubBecameReady()
        XCTAssertEqual(sent.map(\.snapshot.content), ["offline"])
    }

    func testOfflineCopyIsDroppedWhenClipboardChangedAgain() {
        engine.start()
        connected = false
        clipboard.userCopies("first")
        engine.poll()
        clipboard.changeCount += 1 // another change not yet polled
        connected = true
        engine.hubBecameReady()
        XCTAssertTrue(sent.isEmpty)
    }

    func testTargetsFollowSendRules() {
        devices.append(Device(deviceId: "mac-mini", ip: "192.0.2.30"))
        settings.deviceRules = ["mac-mini": rule(false, true)]
        engine.start()
        clipboard.userCopies("x")
        engine.poll()
        XCTAssertEqual(sent.first?.targets, ["main-pc"])
    }

    func testAllPeersBlockedMeansNoSend() {
        settings.deviceRules = ["main-pc": rule(false, true)]
        engine.start()
        clipboard.userCopies("x")
        engine.poll()
        XCTAssertTrue(sent.isEmpty)
    }

    func testRestrictedSendWaitsForDeviceList() {
        settings.deviceRules = ["mac-mini": rule(false, true)]
        devices = []
        engine.start()
        clipboard.userCopies("x")
        engine.poll()
        XCTAssertTrue(sent.isEmpty)
        devices = [Device(deviceId: "macbook"), Device(deviceId: "main-pc", ip: "192.0.2.20")]
        engine.devicesChanged()
        XCTAssertEqual(sent.first?.targets, ["main-pc"])
    }

    func testRouteChangeUsesNewClientEventId() {
        devices.append(Device(deviceId: "mac-mini", ip: "192.0.2.30"))
        engine.start()
        connected = false
        clipboard.userCopies("x")
        engine.poll()
        settings.deviceRules = ["mac-mini": rule(false, true)]
        connected = true
        engine.hubBecameReady()
        XCTAssertEqual(sent.first?.clientEventId, "id-2")
        XCTAssertEqual(sent.first?.targets, ["main-pc"])
    }

    func testOwnEchoRestoresLocalCopyAfterConcurrentRemoteWrite() {
        engine.start()
        clipboard.userCopies("mine")
        engine.poll()
        let ownId = sent[0].clientEventId
        // A peer's copy was stored before ours and arrives first.
        engine.applyRemote(remote("theirs", id: "hub-1"))
        XCTAssertEqual(clipboard.writes.map(\.content), ["theirs"])
        engine.applyRemote(remote("mine", from: "macbook", id: "hub-2", clientEventId: ownId))
        XCTAssertEqual(clipboard.writes.map(\.content), ["theirs", "mine"])
    }

    func testOwnEchoDoesNotOverwriteNewerLocalCopy() {
        engine.start()
        clipboard.userCopies("first")
        engine.poll()
        let ownId = sent[0].clientEventId
        clipboard.userCopies("second")
        engine.applyRemote(remote("first", from: "macbook", id: "hub-2", clientEventId: ownId))
        XCTAssertTrue(clipboard.writes.isEmpty)
        engine.poll()
        XCTAssertEqual(sent.map(\.snapshot.content), ["first", "second"])
    }

    func testOwnEchoWithoutConcurrentWriteDoesNothing() {
        engine.start()
        clipboard.userCopies("mine")
        engine.poll()
        engine.applyRemote(remote("mine", from: "macbook", id: "hub-2", clientEventId: sent[0].clientEventId))
        XCTAssertTrue(clipboard.writes.isEmpty)
        clock += 10
        engine.poll()
        XCTAssertEqual(sent.count, 1, "the echo acknowledged the send")
    }

    func testHistoryWriteIsNotSent() {
        engine.start()
        XCTAssertTrue(engine.writeHistory(remote("old item")))
        engine.poll()
        XCTAssertTrue(sent.isEmpty)
    }

    func testWriteFailureIsReported() {
        var errors: [String] = []
        engine.onError = { errors.append($0) }
        engine.start()
        clipboard.failWrites = true
        XCTAssertFalse(engine.writeHistory(remote("x")))
        XCTAssertEqual(errors.count, 1)
    }
}
