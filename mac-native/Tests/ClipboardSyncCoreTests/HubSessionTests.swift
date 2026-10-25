import XCTest
@testable import ClipboardSyncCore

final class HubSessionTests: XCTestCase {
    var scheduler: ManualScheduler!
    var factory: FakeTransportFactory!
    var session: HubSession!
    var connection: HubConnectionSettings!
    var statuses: [HubStatus] = []
    var deliveredDevices: [[Device]] = []
    var acks: [String?] = []
    var clipboardEvents: [ClipboardEvent] = []

    override func setUp() {
        super.setUp()
        scheduler = ManualScheduler()
        factory = FakeTransportFactory()
        connection = HubConnectionSettings(
            hubUrl: "http://192.0.2.5:8787/",
            token: "secret",
            deviceId: "macbook-1",
            deviceName: "LQ's Mac+Air",
            receiverPolicy: ReceiverPolicy(blockedSourceDeviceIds: ["main-pc"])
        )
        statuses = []
        deliveredDevices = []
        acks = []
        clipboardEvents = []
        session = HubSession(
            settingsProvider: { [unowned self] in self.connection },
            transportFactory: factory,
            scheduler: scheduler,
            random: { 0.5 }
        )
        session.onStatus = { [unowned self] in self.statuses.append($0) }
        session.onDevices = { [unowned self] in self.deliveredDevices.append($0) }
        session.onAck = { [unowned self] in self.acks.append($0) }
        session.onClipboard = { [unowned self] in self.clipboardEvents.append($0) }
    }

    private func policyMessages(_ transport: FakeTransport) -> [[String: Any]] {
        transport.sentObjects().filter { $0["type"] as? String == "client.receiver-policy" }
    }

    /// Opens and completes the policy handshake.
    @discardableResult
    private func connectReady() -> FakeTransport {
        session.start()
        let transport = factory.last!
        transport.receive(["type": "hub.config", "receiverPolicyRevision": true, "historyDisplayLimit": 30, "maxHistoryEntries": 150])
        transport.open()
        let revision = policyMessages(transport).last?["policyRevision"] as? Int
        transport.receive(["type": "hub.receiver-policy-updated", "policyRevision": revision ?? 0])
        return transport
    }

    func testRequestCarriesDeviceQueryAndBearerToken() {
        session.start()
        let request = factory.last!.request
        XCTAssertEqual(request.url?.absoluteString, "ws://192.0.2.5:8787/v1/ws?deviceId=macbook-1&deviceName=LQ%27s%20Mac%2BAir")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
    }

    func testConnectedOnlyAfterPolicyAcknowledgement() {
        session.start()
        let transport = factory.last!
        transport.receive(["type": "hub.config", "receiverPolicyRevision": true])
        transport.open()
        let policies = policyMessages(transport)
        XCTAssertEqual(policies.count, 1)
        XCTAssertEqual(policies[0]["policyRevision"] as? Int, 1)
        XCTAssertEqual((policies[0]["policy"] as? [String: Any])?["blockedSourceDeviceIds"] as? [String], ["main-pc"])

        transport.receive(["type": "hub.devices", "devices": [["deviceId": "main-pc", "ip": "192.0.2.20"]]])
        XCTAssertTrue(deliveredDevices.isEmpty, "devices are held until the policy is acknowledged")
        XCTAssertFalse(statuses.contains { $0.state == .connected })

        transport.receive(["type": "hub.receiver-policy-updated", "policyRevision": 99])
        XCTAssertFalse(statuses.contains { $0.state == .connected }, "a stale revision is ignored")

        transport.receive(["type": "hub.receiver-policy-updated", "policyRevision": 1])
        XCTAssertEqual(statuses.last?.state, .connected)
        XCTAssertEqual(deliveredDevices, [[Device(deviceId: "main-pc", ip: "192.0.2.20")]])
    }

    func testPolicyAckTimeoutRetriesThenTerminates() {
        session.start()
        let transport = factory.last!
        transport.receive(["type": "hub.config", "receiverPolicyRevision": true])
        transport.open()
        scheduler.advance(2)
        XCTAssertEqual(policyMessages(transport).count, 2)
        scheduler.advance(4)
        XCTAssertEqual(policyMessages(transport).count, 3)
        scheduler.advance(8)
        XCTAssertTrue(transport.terminated)
        XCTAssertTrue(statuses.contains { $0.state == .connectionError && $0.messageKey == "status.policyAckTimeout" })
        XCTAssertEqual(statuses.last?.state, .disconnected)
        scheduler.advance(2)
        XCTAssertEqual(factory.transports.count, 2, "reconnects after the backoff")
    }

    func testDuplicateDeviceRetriesSlowlyInsteadOfGivingUp() {
        let transport = connectReady()
        transport.serverClose(4000, "device replaced")
        XCTAssertEqual(statuses.last?.state, .duplicateDevice)
        scheduler.advance(29)
        XCTAssertEqual(factory.transports.count, 1)
        scheduler.advance(2)
        XCTAssertEqual(factory.transports.count, 2)
    }

    func testReconnectBackoffDoublesAndCaps() {
        session.start()
        var delays: [TimeInterval] = []
        for _ in 0..<7 {
            factory.last!.serverClose(1006)
            delays.append(scheduler.pendingDelays.first ?? -1)
            scheduler.advance(delays.last!)
        }
        XCTAssertEqual(delays, [2, 4, 8, 16, 30, 30, 30])
    }

    func testAcknowledgedPolicyResetsBackoff() {
        session.start()
        factory.last!.serverClose(1006)
        scheduler.advance(2)
        factory.last!.serverClose(1006)
        scheduler.advance(4)
        let transport = factory.last!
        transport.receive(["type": "hub.config", "receiverPolicyRevision": true])
        transport.open()
        transport.receive(["type": "hub.receiver-policy-updated", "policyRevision": (policyMessages(transport).last?["policyRevision"] as? Int) ?? 0])
        XCTAssertEqual(session.reconnectAttempts, 0)
    }

    func testHeartbeatTerminatesWhenPongIsMissing() {
        let transport = connectReady()
        scheduler.advance(30)
        XCTAssertEqual(transport.pingCompletions.count, 1)
        transport.pingCompletions[0](nil)
        scheduler.advance(30)
        XCTAssertEqual(transport.pingCompletions.count, 2)
        XCTAssertFalse(transport.terminated)
        scheduler.advance(30)
        XCTAssertTrue(transport.terminated)
    }

    func testHandshakeTimeoutTerminates() {
        session.start()
        scheduler.advance(10)
        XCTAssertTrue(factory.transports[0].terminated)
        XCTAssertEqual(statuses.last?.state, .disconnected)
    }

    func testStaleTransportEventsAreIgnoredAfterReconnect() {
        let first = connectReady()
        session.reconnectNow()
        XCTAssertTrue(first.closed)
        let count = statuses.count
        first.serverClose(1006)
        first.receive(["type": "clipboard.update", "id": "x", "sourceDeviceId": "pc", "contentType": "text/plain", "encoding": "utf8", "content": "a"])
        XCTAssertEqual(statuses.count, count)
        XCTAssertTrue(clipboardEvents.isEmpty)
    }

    func testClipboardMessageOmitsTargetsWhenBroadcasting() {
        let transport = connectReady()
        XCTAssertTrue(session.sendClipboard(.text("hello"), clientEventId: "evt-1", targetDeviceIds: nil))
        XCTAssertTrue(session.sendClipboard(.text("only"), clientEventId: "evt-2", targetDeviceIds: ["main-pc"]))
        let updates = transport.sentObjects().filter { $0["type"] as? String == "clipboard.update" }
        XCTAssertEqual(updates.count, 2)
        XCTAssertNil(updates[0]["targetDeviceIds"])
        XCTAssertEqual(updates[0]["clientEventId"] as? String, "evt-1")
        XCTAssertEqual(updates[0]["encoding"] as? String, "utf8")
        XCTAssertEqual(updates[1]["targetDeviceIds"] as? [String], ["main-pc"])
    }

    func testCannotSendBeforeOpen() {
        session.start()
        XCTAssertFalse(session.sendClipboard(.text("x"), clientEventId: nil, targetDeviceIds: nil))
    }

    func testLegacyDuplicateAcknowledgement() {
        let transport = connectReady()
        transport.receive(["type": "clipboard.update", "sourceDeviceId": "macbook-1", "clientEventId": "evt-1", "contentType": "text/plain", "encoding": "utf8", "content": "a"])
        XCTAssertEqual(acks, ["evt-1"])
        XCTAssertTrue(clipboardEvents.isEmpty)
        transport.receive(["type": "clipboard.ack", "clientEventId": "evt-2", "status": "duplicate"])
        XCTAssertEqual(acks, ["evt-1", "evt-2"])
    }

    func testPolicyChangeAfterReadySendsNewRevisionWithoutReconnecting() {
        let transport = connectReady()
        let connectedCount = statuses.filter { $0.state == .connected }.count
        connection.receiverPolicy = ReceiverPolicy(blockedSourceIps: ["192.0.2.20"])
        session.sendReceiverPolicy()
        let policies = policyMessages(transport)
        XCTAssertEqual(policies.count, 2)
        XCTAssertEqual(policies[1]["policyRevision"] as? Int, 2)
        transport.receive(["type": "hub.receiver-policy-updated", "policyRevision": 2])
        XCTAssertEqual(statuses.filter { $0.state == .connected }.count, connectedCount)
        session.sendReceiverPolicy()
        XCTAssertEqual(policyMessages(transport).count, 2, "an acknowledged policy is not resent")
    }

    func testInvalidHubUrlReportsStatusWithoutConnecting() {
        connection.hubUrl = ""
        session.start()
        XCTAssertTrue(factory.transports.isEmpty)
        XCTAssertEqual(statuses.last?.state, .invalidHubUrl)
        XCTAssertEqual(statuses.last?.messageKey, "status.serverNotSet")
    }

    func testStopPreventsReconnect() {
        let transport = connectReady()
        session.stop()
        XCTAssertTrue(transport.closed)
        transport.serverClose(1006)
        scheduler.advance(60)
        XCTAssertEqual(factory.transports.count, 1)
    }
}
