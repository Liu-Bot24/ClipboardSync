import AppKit
import ClipboardSyncCore
import Combine
import SwiftUI

/// Regular window (it needs keyboard input for the Hub URL). Created on demand and
/// released when closed.
@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
    private let model: AppModel
    private var window: NSWindow?
    private var titleSubscription: AnyCancellable?

    init(model: AppModel) {
        self.model = model
        super.init()
    }

    func show() {
        if window == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 460, height: 600),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: SettingsView(model: model))
            window.setFrameAutosaveName("SettingsWindow")
            if !window.setFrameUsingName("SettingsWindow") { window.center() }
            window.delegate = self
            self.window = window
            titleSubscription = model.$settings
                .map(\.language)
                .removeDuplicates()
                .sink { [weak window] language in window?.title = L10n.t(language, "menu.deviceSettings") }
        }
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        titleSubscription = nil
        window = nil
    }
}

@MainActor
struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var hubUrl = ""
    @State private var tokenInput = ""
    @State private var connectionMessage: String?
    @State private var connectionFailed = false

    private func t(_ key: String) -> String { model.t(key) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            GroupBox {
                VStack(alignment: .leading, spacing: 6) {
                    Toggle(t("settings.pauseSend"), isOn: $model.pauseSendEnabled)
                    Toggle(t("settings.pauseReceive"), isOn: $model.pauseReceiveEnabled)
                    Toggle(t("settings.autoLaunch"), isOn: $model.launchAtLoginEnabled)
                }
                .toggleStyle(.checkbox)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            connection
            devices
            footer
        }
        .padding(16)
        .frame(minWidth: 420, minHeight: 520, alignment: .topLeading)
        .onAppear { hubUrl = model.settings.hubUrl }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(t("app.sharedClipboard")).font(.headline)
                Text(model.statusText)
                    .font(.caption)
                    .foregroundColor(model.status.state == .connected ? .secondary : .orange)
                    .lineLimit(2)
                    .help(model.statusText)
            }
            Spacer()
            Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                .help(t("action.refresh"))
        }
    }

    private var connection: some View {
        GroupBox(label: Text(t("connection.section"))) {
            VStack(alignment: .leading, spacing: 8) {
                Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 8) {
                    GridRow {
                        Text(t("connection.server"))
                        TextField("http://192.168.1.10:8787", text: $hubUrl)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { save() }
                    }
                    GridRow {
                        Text(t("connection.token"))
                        SecureField(model.hasToken ? t("connection.tokenConfigured") : t("connection.tokenEmpty"), text: $tokenInput)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { save() }
                    }
                }
                HStack {
                    if let connectionMessage {
                        Text(connectionMessage)
                            .font(.caption)
                            .foregroundColor(connectionFailed ? .red : .secondary)
                    }
                    Spacer()
                    if model.hasToken {
                        Button(t("action.removeToken")) { model.removeToken() }
                    }
                    Button(t("action.save")) { save() }
                        .keyboardShortcut(.defaultAction)
                }
            }
            .padding(.top, 4)
        }
    }

    private var devices: some View {
        GroupBox {
            let groups = DeviceGroup.peerGroups(devices: model.devices, selfDeviceId: model.settings.deviceId)
            ScrollView {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                    GridRow {
                        Text("IP").bold()
                        Text(t("devices.send")).bold().gridColumnAlignment(.center)
                        Text(t("devices.receive")).bold().gridColumnAlignment(.center)
                    }
                    Divider().gridCellUnsizedAxes(.horizontal)
                    if groups.isEmpty {
                        Text(t("devices.noOtherDevices")).foregroundColor(.secondary)
                    }
                    ForEach(groups) { group in
                        GridRow {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(group.ip ?? t("devices.unknownIp"))
                                Text(group.devices.map { $0.deviceName ?? $0.deviceId }.joined(separator: ", "))
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                                    .lineLimit(1)
                            }
                            .help(group.devices.map(\.deviceId).joined(separator: "\n"))
                            checkbox(group, .send, mixedHint: "devices.sendMixed")
                            checkbox(group, .receive, mixedHint: "devices.receiveMixed")
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(4)
            }
        }
        .frame(maxHeight: .infinity)
    }

    private func checkbox(_ group: DeviceGroup, _ column: RuleColumn, mixedHint: String) -> some View {
        let state = group.state(column, settings: model.settings)
        return TriStateCheckbox(state: state, toolTip: state == .mixed ? t(mixedHint) : nil) { checked in
            model.updateRule(groupKey: group.key, column: column, checked: checked)
        }
        .frame(width: 20, height: 18)
        .gridColumnAlignment(.center)
    }

    private var footer: some View {
        HStack {
            Text("\(t("devices.thisDevice")): \(model.settings.deviceName) · \(model.settings.deviceId)")
                .font(.caption2)
                .foregroundColor(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
            Spacer()
            Button(t("action.quit")) { NSApp.terminate(nil) }
        }
    }

    private func save() {
        if let error = model.saveConnection(hubUrl: hubUrl, newToken: tokenInput) {
            connectionFailed = true
            connectionMessage = "\(t("connection.saveFailed")) · \(error)"
            return
        }
        connectionFailed = false
        connectionMessage = t("connection.saved")
        hubUrl = model.settings.hubUrl
        tokenInput = ""
    }
}

/// AppKit checkbox with a mixed state for IP rows that group several devices.
struct TriStateCheckbox: NSViewRepresentable {
    var state: DeviceGroup.CheckState
    var toolTip: String?
    var onChange: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(checkboxWithTitle: "", target: context.coordinator, action: #selector(Coordinator.toggled(_:)))
        button.allowsMixedState = true
        return button
    }

    func updateNSView(_ button: NSButton, context: Context) {
        context.coordinator.state = state
        context.coordinator.onChange = onChange
        button.state = Coordinator.value(state)
        button.toolTip = toolTip
    }

    final class Coordinator: NSObject {
        var state: DeviceGroup.CheckState = .on
        var onChange: (Bool) -> Void = { _ in }

        static func value(_ state: DeviceGroup.CheckState) -> NSControl.StateValue {
            switch state {
            case .on: return .on
            case .off: return .off
            case .mixed: return .mixed
            }
        }

        @objc func toggled(_ sender: NSButton) {
            // Like an indeterminate HTML checkbox: mixed or off becomes checked, checked becomes unchecked.
            let checked = state != .on
            sender.state = Self.value(state)
            onChange(checked)
        }
    }
}
