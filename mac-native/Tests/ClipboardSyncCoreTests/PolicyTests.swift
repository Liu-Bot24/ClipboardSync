import XCTest
@testable import ClipboardSyncCore

func makeSettings(deviceId: String = "macbook", rules: DeviceRules = [:], byIp: DeviceRules = [:]) -> ClientSettings {
    ClientSettings(deviceId: deviceId, deviceName: "Test Mac", deviceRules: rules, deviceRulesByIp: byIp)
}

func rule(_ send: Bool?, _ receive: Bool?) -> DeviceRule { DeviceRule(send: send, receive: receive) }

func event(_ id: String, source: String, ip: String? = nil, targets: [String]? = nil, text: String = "x") -> ClipboardEvent {
    ClipboardEvent(id: id, sourceDeviceId: source, sourceIp: ip, contentType: "text/plain", encoding: "utf8", content: text, targetDeviceIds: targets)
}

/// Cases ported from tests/client-policy.test.js and tests/receive-policy.test.js.
final class PolicyTests: XCTestCase {
    let devices = [
        Device(deviceId: "macbook", ip: "192.0.2.10"),
        Device(deviceId: "main-pc", ip: "192.0.2.20"),
        Device(deviceId: "mac-mini", ip: "192.0.2.30")
    ]

    func testBroadcastsWhenEveryPeerIsSendEnabled() {
        XCTAssertNil(Policy.buildTargetDeviceIds(devices: devices, settings: makeSettings(), selfDeviceId: "macbook"))
    }

    func testLimitsSendsWhenAPeerIsUnchecked() {
        let settings = makeSettings(rules: ["main-pc": rule(true, true), "mac-mini": rule(false, true)])
        XCTAssertEqual(Policy.buildTargetDeviceIds(devices: devices, settings: settings, selfDeviceId: "macbook"), ["main-pc"])
    }

    func testDoesNotBroadcastWhileRestrictedAndDevicesUnknown() {
        let settings = makeSettings(rules: ["mac-mini": rule(false, true)])
        XCTAssertEqual(Policy.buildTargetDeviceIds(devices: [], settings: settings, selfDeviceId: "macbook"), [])
        XCTAssertTrue(Policy.shouldDeferRestrictedSend(devices: [], settings: settings, selfDeviceId: "macbook"))
    }

    func testIncludesRememberedOfflineAllowedDevices() {
        let settings = makeSettings(rules: ["main-pc": rule(true, true), "mac-mini": rule(false, true)])
        let onlySelf = [Device(deviceId: "macbook", ip: "192.0.2.10")]
        XCTAssertEqual(Policy.buildTargetDeviceIds(devices: onlySelf, settings: settings, selfDeviceId: "macbook"), ["main-pc"])
        XCTAssertFalse(Policy.shouldDeferRestrictedSend(devices: onlySelf, settings: settings, selfDeviceId: "macbook"))
    }

    func testNeverTargetsSelfThroughRememberedRules() {
        let settings = makeSettings(rules: ["macbook": rule(true, true), "mac-mini": rule(false, true)])
        let list = [Device(deviceId: "macbook", ip: "192.0.2.10"), Device(deviceId: "mac-mini", ip: "192.0.2.30")]
        XCTAssertEqual(Policy.buildTargetDeviceIds(devices: list, settings: settings, selfDeviceId: "macbook"), [])
    }

    func testNeverTreatsIpRulesAsTargetIds() {
        let onlySelf = [Device(deviceId: "macbook", ip: "192.0.2.10")]
        for ip in ["192.0.2.20", "fe80::1"] {
            let settings = makeSettings(rules: [ip: rule(true, true), "mac-mini": rule(false, true)])
            XCTAssertEqual(Policy.buildTargetDeviceIds(devices: onlySelf, settings: settings, selfDeviceId: "macbook"), [], ip)
        }
    }

    func testReceiveDefaultsToAllowedAndHonorsRules() {
        let incoming = event("1", source: "main-pc", ip: "192.0.2.20")
        XCTAssertTrue(Policy.isReceiveAllowed(incoming, settings: makeSettings()))
        XCTAssertFalse(Policy.isReceiveAllowed(incoming, settings: makeSettings(rules: ["main-pc": rule(true, false)])))
    }

    func testReceiveRejectsEventsTargetedElsewhere() {
        let targeted = event("1", source: "main-pc", ip: "192.0.2.20", targets: ["macbook"])
        XCTAssertFalse(Policy.isReceiveAllowed(targeted, settings: makeSettings(deviceId: "mac-mini")))
        XCTAssertTrue(Policy.isReceiveAllowed(targeted, settings: makeSettings(deviceId: "macbook")))
    }

    func testVisibleHistoryIsNewestAllowedFirst() {
        let events = (0..<20).map { index in
            event("event-\(index)", source: index % 2 == 0 ? "main-pc" : "mac-mini", ip: index % 2 == 0 ? "192.0.2.20" : "192.0.2.30")
        }
        let visible = Policy.filterVisibleHistory(events, settings: makeSettings(rules: ["mac-mini": rule(true, false)]), limit: 5)
        XCTAssertEqual(visible.map { $0.id ?? "" }, ["event-18", "event-16", "event-14", "event-12", "event-10"])
    }

    func testVisibleHistoryKeepsOwnTargetedEvents() {
        let events = [
            event("broadcast", source: "main-pc", ip: "192.0.2.20"),
            event("for-macbook", source: "main-pc", ip: "192.0.2.20", targets: ["macbook"]),
            event("own-sent", source: "mac-mini", ip: "192.0.2.30", targets: ["macbook"])
        ]
        let visible = Policy.filterVisibleHistory(events, settings: makeSettings(deviceId: "mac-mini"), limit: 10)
        XCTAssertEqual(visible.map { $0.id ?? "" }, ["own-sent", "broadcast"])
    }

    func testMergeCarriesIpRulesToNewDeviceId() {
        let merged = Policy.mergeDeviceRules([:], existingByIp: ["192.0.2.20": rule(false, true)], devices: [Device(deviceId: "main-pc-new-id", ip: "192.0.2.20")])
        XCTAssertEqual(merged, ["main-pc-new-id": rule(false, true)])
    }

    func testUpdateByDeviceIdAlsoStoresIpRule() {
        let patch = Policy.updateDeviceRule(settings: makeSettings(), devices: [Device(deviceId: "main-pc", ip: "192.0.2.20")],
                                            key: "main-pc", column: .send, checked: false)
        XCTAssertEqual(patch.deviceRules, ["main-pc": rule(false, true)])
        XCTAssertEqual(patch.deviceRulesByIp, ["192.0.2.20": rule(false, true)])
        let after = makeSettings(byIp: patch.deviceRulesByIp)
        XCTAssertEqual(Policy.buildTargetDeviceIds(devices: [Device(deviceId: "macbook", ip: "192.0.2.10")], settings: after, selfDeviceId: "macbook"), [])
    }

    func testUpdateByIpAppliesToEveryDeviceOnThatIp() {
        let list = [
            Device(deviceId: "main-pc-installed", ip: "192.0.2.20"),
            Device(deviceId: "main-pc-portable", ip: "192.0.2.20"),
            Device(deviceId: "mac-mini", ip: "192.0.2.30")
        ]
        let patch = Policy.updateDeviceRule(settings: makeSettings(), devices: list, key: "192.0.2.20", column: .receive, checked: false)
        XCTAssertEqual(patch.deviceRules, ["main-pc-installed": rule(true, false), "main-pc-portable": rule(true, false)])
        XCTAssertEqual(patch.deviceRulesByIp, ["192.0.2.20": rule(true, false)])
    }

    func testUpdateByIpPreservesEachDevicesOtherColumn() {
        let settings = makeSettings(rules: ["main-pc-installed": rule(false, true), "main-pc-portable": rule(true, true)])
        let list = [Device(deviceId: "main-pc-installed", ip: "192.0.2.20"), Device(deviceId: "main-pc-portable", ip: "192.0.2.20")]
        let patch = Policy.updateDeviceRule(settings: settings, devices: list, key: "192.0.2.20", column: .receive, checked: false)
        XCTAssertEqual(patch.deviceRules["main-pc-installed"], rule(false, false))
        XCTAssertEqual(patch.deviceRules["main-pc-portable"], rule(true, false))
        XCTAssertEqual(patch.deviceRulesByIp["192.0.2.20"], rule(nil, false))
    }

    func testUpdateByIpv6Row() {
        let patch = Policy.updateDeviceRule(settings: makeSettings(), devices: [Device(deviceId: "ipv6-device", ip: "fe80::1")],
                                            key: "fe80::1", column: .send, checked: false)
        XCTAssertEqual(patch.deviceRules, ["ipv6-device": rule(false, true)])
        XCTAssertEqual(patch.deviceRulesByIp, ["fe80::1": rule(false, true)])
    }

    func testMergeByIpPreservesRememberedPreference() {
        let merged = Policy.mergeDeviceRulesByIp(["192.0.2.20": rule(false, true)], devices: [Device(deviceId: "new", ip: "192.0.2.20")], existingRules: [:])
        XCTAssertEqual(merged, ["192.0.2.20": rule(false, true)])
    }

    func testMergeByIpDoesNotInventMixedSendRule() {
        let merged = Policy.mergeDeviceRulesByIp(
            [:],
            devices: [Device(deviceId: "main-pc-installed", ip: "192.0.2.20"), Device(deviceId: "main-pc-portable", ip: "192.0.2.20")],
            existingRules: ["main-pc-installed": rule(false, true), "main-pc-portable": rule(true, true)]
        )
        XCTAssertEqual(merged, ["192.0.2.20": rule(nil, true)])
    }

    func testFourDeviceMatrix() {
        let list = [
            Device(deviceId: "macbook", ip: "192.0.2.10"),
            Device(deviceId: "main-pc-installed", ip: "192.0.2.20"),
            Device(deviceId: "main-pc-portable", ip: "192.0.2.20"),
            Device(deviceId: "mac-mini", ip: "192.0.2.21"),
            Device(deviceId: "mini-pc", ip: "192.0.2.22")
        ]
        let settings = makeSettings(rules: ["mac-mini": rule(true, true)],
                                    byIp: ["192.0.2.20": rule(false, true), "192.0.2.22": rule(true, false)])
        XCTAssertEqual(Policy.buildTargetDeviceIds(devices: list, settings: settings, selfDeviceId: "macbook"), ["mac-mini", "mini-pc"])
        XCTAssertTrue(Policy.isReceiveAllowed(event("1", source: "main-pc-installed", ip: "192.0.2.20"), settings: settings))
        XCTAssertFalse(Policy.isReceiveAllowed(event("2", source: "mini-pc", ip: "192.0.2.22"), settings: settings))
    }

    func testReceiverPolicyExportsOnlyReceiveDecisions() {
        let settings = makeSettings(
            rules: ["main-pc": rule(true, false), "mac-mini": rule(false, true), "192.0.2.30": rule(true, false)],
            byIp: ["192.0.2.40": rule(true, false)]
        )
        let policy = ReceiverPolicy(settings: settings)
        XCTAssertEqual(policy.allowedSourceDeviceIds, ["mac-mini"])
        XCTAssertEqual(policy.blockedSourceDeviceIds, ["main-pc"])
        XCTAssertEqual(policy.blockedSourceIps, ["192.0.2.30", "192.0.2.40"])
    }

    func testReceiverPolicyDeviceAllowNextToBlockedIp() {
        let policy = ReceiverPolicy(settings: makeSettings(rules: ["main-pc-portable": rule(true, true)], byIp: ["192.0.2.20": rule(true, false)]))
        XCTAssertEqual(policy, ReceiverPolicy(allowedSourceDeviceIds: ["main-pc-portable"], blockedSourceDeviceIds: [], blockedSourceIps: ["192.0.2.20"]))
    }

    func testReceiverPolicySkipsInvalidKeys() {
        let policy = ReceiverPolicy(settings: makeSettings(rules: ["bad/device": rule(true, false), "ok-device": rule(nil, false)], byIp: ["bad-ip": rule(true, false)]))
        XCTAssertEqual(policy.blockedSourceDeviceIds, ["ok-device"])
        XCTAssertEqual(policy.blockedSourceIps, [])
    }

    func testDeviceGroupsByIpWithMixedState() {
        let list = [
            Device(deviceId: "macbook", ip: "192.0.2.10"),
            Device(deviceId: "pc-a", ip: "192.0.2.20"),
            Device(deviceId: "pc-b", ip: "192.0.2.20"),
            Device(deviceId: "no-ip", ip: nil)
        ]
        let groups = DeviceGroup.peerGroups(devices: list, selfDeviceId: "macbook")
        XCTAssertEqual(groups.map(\.key), ["192.0.2.20", "no-ip"])
        let settings = makeSettings(rules: ["pc-a": rule(false, true), "pc-b": rule(true, true)])
        XCTAssertEqual(groups[0].state(.send, settings: settings), .mixed)
        XCTAssertEqual(groups[0].state(.receive, settings: settings), .on)
        XCTAssertEqual(groups[1].state(.send, settings: settings), .on)
        XCTAssertEqual(groups[0].state(.send, settings: makeSettings(byIp: ["192.0.2.20": rule(false, true)])), .off)
    }

    func testIpAddressDetection() {
        XCTAssertTrue(IPAddress.isValid("192.168.1.5"))
        XCTAssertTrue(IPAddress.isValid("fe80::1"))
        XCTAssertFalse(IPAddress.isValid("main-pc"))
        XCTAssertFalse(IPAddress.isValid("1.2.3"))
        XCTAssertFalse(IPAddress.isValid(""))
    }
}
