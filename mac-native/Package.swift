// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ClipboardSyncMac",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "ClipboardSync", targets: ["ClipboardSync"])
    ],
    targets: [
        // Platform-independent protocol, policy and sync logic. No AppKit, so it is unit-testable.
        .target(name: "ClipboardSyncCore"),
        // Menu bar app: AppKit/SwiftUI, NSPasteboard, URLSessionWebSocketTask, Keychain, SMAppService.
        .executableTarget(
            name: "ClipboardSync",
            dependencies: ["ClipboardSyncCore"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ServiceManagement"),
                .linkedFramework("Network")
            ]
        ),
        .testTarget(name: "ClipboardSyncCoreTests", dependencies: ["ClipboardSyncCore"])
    ]
)
