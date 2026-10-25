import XCTest
@testable import ClipboardSyncCore

final class EndpointTests: XCTestCase {
    func testNormalizeHubUrl() throws {
        XCTAssertEqual(try HubEndpoints.normalizeHubUrl("192.0.2.5:8787"), "http://192.0.2.5:8787")
        XCTAssertEqual(try HubEndpoints.normalizeHubUrl("  HTTPS://hub.example.com/clip/?x=1#frag "), "https://hub.example.com/clip")
        XCTAssertEqual(try HubEndpoints.normalizeHubUrl("http://nas.local:8787///"), "http://nas.local:8787")
        XCTAssertThrowsError(try HubEndpoints.normalizeHubUrl(""))
        XCTAssertThrowsError(try HubEndpoints.normalizeHubUrl("ftp://nas")) { error in
            XCTAssertEqual(error as? HubEndpointError, .unsupportedScheme)
        }
    }

    func testPathReplacesHubPathAndSchemeMapsToWebSocket() throws {
        XCTAssertEqual(try HubEndpoints.url(hubUrl: "https://hub.example.com/clip", path: "/v1/ws", webSocket: true).absoluteString,
                       "wss://hub.example.com/v1/ws")
        XCTAssertEqual(try HubEndpoints.url(hubUrl: "nas:8787", path: "/v1/history", query: [("limit", "30"), ("deviceId", "mac-1")]).absoluteString,
                       "http://nas:8787/v1/history?limit=30&deviceId=mac-1")
    }

    func testRequestAddsBearerOnlyWithToken() throws {
        let url = try HubEndpoints.url(hubUrl: "nas:8787", path: "/v1/config")
        XCTAssertEqual(HubEndpoints.request(url, token: "abc").value(forHTTPHeaderField: "Authorization"), "Bearer abc")
        XCTAssertNil(HubEndpoints.request(url, token: "").value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(HubEndpoints.request(url, token: nil, method: "DELETE").httpMethod, "DELETE")
    }
}

final class ProtocolTests: XCTestCase {
    func testParsesHubMessages() {
        guard case .devices(let devices)? = HubMessage.parse(#"{"type":"hub.devices","devices":[{"deviceId":"pc","deviceName":"PC","ip":"192.0.2.20"},{"bad":1}]}"#) else {
            return XCTFail("devices")
        }
        XCTAssertEqual(devices, [Device(deviceId: "pc", deviceName: "PC", ip: "192.0.2.20")])

        guard case .config(let config)? = HubMessage.parse(#"{"type":"hub.config","receiverPolicyRevision":true,"historyDisplayLimit":30,"maxHistoryEntries":150}"#) else {
            return XCTFail("config")
        }
        XCTAssertEqual(config, HubConfig(receiverPolicyRevision: true, historyDisplayLimit: 30, maxHistoryEntries: 150))

        let update = #"{"type":"clipboard.update","id":"e1","sourceDeviceId":"pc","sourceIp":"192.0.2.20","contentType":"text/plain","encoding":"utf8","content":"hi","sha256":"x","targetDeviceIds":null,"sequence":4}"#
        guard case .clipboard(let event)? = HubMessage.parse(update) else { return XCTFail("clipboard") }
        XCTAssertEqual(event.id, "e1")
        XCTAssertNil(event.targetDeviceIds)
        XCTAssertEqual(event.payloadHash, Hashing.sha256Hex(Data("hi".utf8)), "a malformed sha256 is recomputed")

        guard case .receiverPolicyUpdated(let revision)? = HubMessage.parse(#"{"type":"hub.receiver-policy-updated","policyRevision":3}"#) else {
            return XCTFail("policy")
        }
        XCTAssertEqual(revision, 3)
        guard case .historyCleared? = HubMessage.parse(#"{"type":"hub.history-cleared"}"#) else { return XCTFail("cleared") }
        XCTAssertNil(HubMessage.parse("not json"))
        XCTAssertNil(HubMessage.parse("[1,2]"))
    }

    func testReceiverPolicyMessage() throws {
        let text = ClientMessage.receiverPolicy(ReceiverPolicy(blockedSourceIps: ["192.0.2.20"]), revision: 7)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "client.receiver-policy")
        XCTAssertEqual(object["policyRevision"] as? Int, 7)
        let policy = try XCTUnwrap(object["policy"] as? [String: Any])
        XCTAssertEqual(policy["blockedSourceIps"] as? [String], ["192.0.2.20"])
        XCTAssertEqual(policy["allowedSourceDeviceIds"] as? [String], [])
    }

    func testImageSnapshotIsBase64Png() throws {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])
        let snapshot = ClipboardSnapshot.png(png)
        let text = ClientMessage.clipboardUpdate(snapshot, clientEventId: "c1", targetDeviceIds: nil)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
        XCTAssertEqual(object["contentType"] as? String, "image/png")
        XCTAssertEqual(object["encoding"] as? String, "base64")
        XCTAssertEqual(Data(base64Encoded: object["content"] as? String ?? ""), png)
        XCTAssertEqual(snapshot.byteLength, png.count)
    }

    func testSha256KnownVectors() {
        XCTAssertEqual(Hashing.sha256Hex(Data()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(Hashing.sha256Hex(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(Hashing.sha256Hex(Data(repeating: 0x61, count: 1000)), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3")
    }
}

final class SettingsTests: XCTestCase {
    var directory: URL!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("clipboard-sync-tests-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    func testFirstLoadCreatesFileWithDefaults() throws {
        let store = SettingsStore(directory: directory, defaultDeviceName: "LQ’s MacBook Air", preferredLanguages: ["en-US"])
        try store.load()
        XCTAssertTrue(store.createdOnLoad)
        XCTAssertTrue(DeviceIdentity.isValidId(store.settings.deviceId))
        XCTAssertTrue(store.settings.deviceId.hasPrefix("LQ-s-MacBook-Air-"))
        XCTAssertEqual(store.settings.language, "en")
        XCTAssertEqual(store.settings.historyDisplayLimit, 30)
        XCTAssertTrue(store.settings.autoLaunch)

        let reloaded = SettingsStore(directory: directory, defaultDeviceName: "Other", preferredLanguages: [])
        try reloaded.load()
        XCTAssertFalse(reloaded.createdOnLoad)
        XCTAssertEqual(reloaded.settings, store.settings)
    }

    func testUpdatePersistsRules() throws {
        let store = SettingsStore(directory: directory, defaultDeviceName: "Mac", preferredLanguages: ["zh-Hans-CN"])
        try store.load()
        XCTAssertEqual(store.settings.language, "zh-CN")
        try store.update { $0.deviceRules["pc"] = DeviceRule(send: false, receive: nil) }
        let reloaded = SettingsStore(directory: directory, defaultDeviceName: "Mac", preferredLanguages: [])
        try reloaded.load()
        XCTAssertEqual(reloaded.settings.deviceRules["pc"], DeviceRule(send: false, receive: nil))
    }

    func testPartialFileUsesDefaultsAndCorruptFileIsMovedAside() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("config.json")
        try Data(#"{"hubUrl":"http://nas:8787","deviceId":"mac-1","historyDisplayLimit":0}"#.utf8).write(to: file)
        let store = SettingsStore(directory: directory, defaultDeviceName: "Mac", preferredLanguages: [])
        try store.load()
        XCTAssertEqual(store.settings.deviceId, "mac-1")
        XCTAssertEqual(store.settings.historyDisplayLimit, 30)
        XCTAssertEqual(store.settings.deviceName, "Mac")

        try Data("{broken".utf8).write(to: file)
        let corrupt = SettingsStore(directory: directory, defaultDeviceName: "Mac", preferredLanguages: [])
        try corrupt.load()
        XCTAssertTrue(corrupt.createdOnLoad)
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertTrue(names.contains { $0.hasPrefix("config.json.broken-") })
    }

    func testElectronImportUsesProxyTargetAndKeepsOwnDeviceId() throws {
        let base = ClientSettings(deviceId: "native-id", deviceName: "Mac")
        let electron = Data(#"""
        {"hubUrl":"http://127.0.0.1:18787","token":"tok","deviceId":"electron-id","deviceName":"LQs-Mac-mini.local",
         "language":"en","pauseSend":true,"historyDisplayLimit":50,
         "deviceRules":{"main-pc":{"send":false,"receive":true},"bad":"x"},"deviceRulesByIp":{"192.0.2.20":{"receive":false}}}
        """#.utf8)
        let proxy = Data(#"{"listenHost":"127.0.0.1","listenPort":18787,"targetUrl":"http://192.0.2.5:8787"}"#.utf8)
        let result = try XCTUnwrap(ElectronConfigImporter.merge(electronConfig: electron, proxyConfig: proxy, into: base))
        XCTAssertEqual(result.settings.hubUrl, "http://192.0.2.5:8787")
        XCTAssertEqual(result.settings.deviceId, "native-id")
        XCTAssertEqual(result.settings.deviceName, "LQs-Mac-mini.local")
        XCTAssertEqual(result.settings.language, "en")
        XCTAssertTrue(result.settings.pauseSend)
        XCTAssertEqual(result.settings.historyDisplayLimit, 50)
        XCTAssertEqual(result.settings.deviceRules, ["main-pc": DeviceRule(send: false, receive: true)])
        XCTAssertEqual(result.settings.deviceRulesByIp, ["192.0.2.20": DeviceRule(send: nil, receive: false)])
        XCTAssertEqual(result.token, "tok")
    }

    func testElectronImportWithoutProxyLeavesUrlEmpty() throws {
        let base = ClientSettings(deviceId: "native-id", deviceName: "Mac")
        let result = try XCTUnwrap(ElectronConfigImporter.merge(electronConfig: Data(#"{"hubUrl":"http://localhost:18787"}"#.utf8), proxyConfig: nil, into: base))
        XCTAssertEqual(result.settings.hubUrl, "")
        XCTAssertNil(result.token)
    }
}

final class SupportTests: XCTestCase {
    func testLocalizationTablesHaveTheSameKeys() {
        let zh = Set(L10n.messages["zh-CN"]!.keys)
        let en = Set(L10n.messages["en"]!.keys)
        XCTAssertEqual(zh.subtracting(en), [])
        XCTAssertEqual(en.subtracting(zh), [])
        XCTAssertEqual(L10n.t("en", "history.latest", ["limit": "30"]), "History · Latest 30")
        XCTAssertEqual(L10n.t("fr", "status.connected"), "已连接")
        XCTAssertEqual(L10n.normalizeLanguage("en-GB"), "en")
        XCTAssertEqual(L10n.normalizeLanguage("zh-Hans"), "zh-CN")
    }

    func testPreview() {
        let long = ClipboardEvent(contentType: "text/plain", encoding: "utf8", content: "  a\n\tb  " + String(repeating: "x", count: 60))
        let preview = L10n.preview(of: long, language: "en")
        XCTAssertTrue(preview.hasPrefix("a b xxx"))
        XCTAssertEqual(preview.count, 44)
        XCTAssertEqual(L10n.preview(of: ClipboardEvent(contentType: "image/png", encoding: "base64", content: ""), language: "en"), "Image")
    }

    func testDeviceIdentity() {
        XCTAssertEqual(DeviceIdentity.sanitize("My Mac/1"), "My-Mac-1")
        let id = DeviceIdentity.randomId(for: String(repeating: "n", count: 80), uuid: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!)
        XCTAssertEqual(id.count, 64)
        XCTAssertTrue(DeviceIdentity.isValidId(id))
        XCTAssertEqual(DeviceIdentity.sanitizeName("a\tb\nc"), "abc")
        XCTAssertEqual(DeviceIdentity.sanitizeName(String(repeating: "长", count: 100)).utf16.count, 80)
    }

    func testPasteTargetMemory() {
        var memory = PasteTargetMemory(ownPid: 10, ownBundleId: "dev.liuqi.clipboardsync.mac")
        let start = Date(timeIntervalSince1970: 0)
        let editor = PasteTarget(pid: 20, bundleId: "com.apple.TextEdit", name: "TextEdit")
        memory.observeActivation(editor, at: start)
        XCTAssertEqual(memory.recentTarget(at: start + 600), editor, "a frontmost target stays usable")

        memory.observeActivation(PasteTarget(pid: 10, bundleId: "dev.liuqi.clipboardsync.mac", name: "Clipboard Sync"), at: start + 600)
        XCTAssertEqual(memory.recentTarget(at: start + 620), editor)
        XCTAssertNil(memory.recentTarget(at: start + 631), "expires 30 s after it lost focus")

        memory.observeActivation(PasteTarget(pid: 30, bundleId: "com.apple.Dock", name: "Dock"), at: start + 700)
        XCTAssertEqual(memory.target, editor, "system UI keeps the target")
        memory.observeActivation(PasteTarget(pid: 40, bundleId: "com.apple.finder", name: "Finder"), at: start + 701)
        XCTAssertNil(memory.target)
        memory.observeActivation(editor, at: start + 702)
        memory.forget(pid: 20)
        XCTAssertNil(memory.target)
    }

    func testStatusTrackerFallsBackAfterTransientError() {
        let scheduler = ManualScheduler()
        let tracker = StatusTracker(scheduler: scheduler)
        var changes: [HubStatus.State] = []
        tracker.onChange = { changes.append($0.state) }
        tracker.set(HubStatus(.connected))
        tracker.set(HubStatus(.clipboardError, message: "boom"))
        tracker.set(HubStatus(.clipboardError, message: "boom"))
        XCTAssertEqual(changes, [.connected, .clipboardError], "a repeated error is not rebroadcast")
        scheduler.advance(10)
        XCTAssertEqual(changes, [.connected, .clipboardError, .connected])
        XCTAssertEqual(tracker.current.state, .connected)
    }

    func testImageRules() {
        XCTAssertTrue(ImageRules.signatureMatches(Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0]), contentType: "image/png"))
        XCTAssertFalse(ImageRules.signatureMatches(Data([0xFF, 0xD8, 0xFF]), contentType: "image/png"))
        XCTAssertTrue(ImageRules.signatureMatches(Data([0xFF, 0xD8, 0xFF, 0xE0]), contentType: "image/jpeg"))
        XCTAssertTrue(ImageRules.signatureMatches(Data("RIFF\0\0\0\0WEBP".utf8), contentType: "image/webp"))
        XCTAssertTrue(ImageRules.dimensionsAllowed(width: 8192, height: 8192))
        XCTAssertFalse(ImageRules.dimensionsAllowed(width: 40_000, height: 10))
        XCTAssertFalse(ImageRules.dimensionsAllowed(width: 0, height: 10))
    }
}
