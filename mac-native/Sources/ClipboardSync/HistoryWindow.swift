import AppKit
import ClipboardSyncCore
import Combine
import SwiftUI

/// Non-activating panel: clicking it never takes focus from the app being pasted
/// into, so Cmd+V reaches that app's focused field directly.
final class HistoryPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Lets the first click on the (never key) panel act on buttons and rows.
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class HistoryWindowController: NSObject, NSWindowDelegate {
    private let model: AppModel
    private var panel: HistoryPanel?
    private var subscriptions: Set<AnyCancellable> = []

    init(model: AppModel) {
        self.model = model
        super.init()
    }

    func show() {
        if panel == nil {
            let panel = HistoryPanel(
                contentRect: NSRect(x: 0, y: 0, width: 520, height: 640),
                styleMask: [.titled, .closable, .resizable, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            panel.isReleasedWhenClosed = false
            panel.hidesOnDeactivate = false
            panel.becomesKeyOnlyIfNeeded = true
            panel.collectionBehavior = [.fullScreenAuxiliary, .moveToActiveSpace]
            panel.minSize = NSSize(width: 360, height: 320)
            panel.contentView = FirstMouseHostingView(rootView: HistoryView(model: model))
            panel.setFrameAutosaveName("HistoryWindow")
            if !panel.setFrameUsingName("HistoryWindow") { panel.center() }
            panel.delegate = self
            self.panel = panel
            model.$settings
                .map { ($0.historyAlwaysOnTop, $0.language) }
                .removeDuplicates { $0 == $1 }
                .sink { [weak self] value in
                    let (alwaysOnTop, language) = value
                    guard let panel = self?.panel else { return }
                    panel.isFloatingPanel = alwaysOnTop
                    panel.level = alwaysOnTop ? .floating : .normal
                    panel.title = L10n.t(language, "app.mainWindow")
                }
                .store(in: &subscriptions)
        }
        model.refresh()
        panel?.orderFrontRegardless()
    }

    func windowWillClose(_ notification: Notification) {
        subscriptions.removeAll()
        panel = nil
    }
}

@MainActor
struct HistoryView: View {
    @ObservedObject var model: AppModel
    @State private var confirmingClear = false

    private func t(_ key: String, _ params: [String: String] = [:]) -> String { model.t(key, params) }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(t("app.mainWindow")).font(.headline)
                    Text(t("history.latest", ["limit": String(model.settings.historyDisplayLimit)]))
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer()
                Toggle(t("settings.alwaysOnTop"), isOn: $model.historyAlwaysOnTopEnabled)
                    .toggleStyle(.checkbox)
                Button(confirmingClear ? t("history.confirmClear") : t("history.clearGlobal")) { clearTapped() }
                    .foregroundColor(.red)
                Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .help(t("action.refresh"))
            }
            .padding(12)
            Divider()
            if model.history.isEmpty {
                Spacer()
                Text(t("history.none")).foregroundColor(.secondary)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 6) {
                        ForEach(model.history, id: \.rowId) { event in
                            HistoryRow(model: model, event: event)
                        }
                    }
                    .padding(10)
                }
            }
            if let notice = model.notice {
                Divider()
                Text(notice.text)
                    .font(.caption)
                    .foregroundColor(notice.isError ? .red : .secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
            }
        }
        .frame(minWidth: 360, minHeight: 320)
    }

    private func clearTapped() {
        guard confirmingClear else {
            confirmingClear = true
            Task {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                confirmingClear = false
            }
            return
        }
        confirmingClear = false
        model.clearGlobalHistory()
    }
}

@MainActor
struct HistoryRow: View {
    @ObservedObject var model: AppModel
    let event: ClipboardEvent

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    private static let isoParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    var body: some View {
        Button {
            model.applyHistory(event, paste: true)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                content
                HStack {
                    Text(model.sourceLabel(for: event))
                    Spacer()
                    if let time = time { Text(time) }
                }
                .font(.caption2)
                .foregroundColor(.secondary)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .controlBackgroundColor)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(model.t("action.paste")) { model.applyHistory(event, paste: true) }
            Button(model.t("action.copy")) { model.applyHistory(event, paste: false) }
        }
    }

    @ViewBuilder
    private var content: some View {
        if event.isImage {
            if let image = ThumbnailCache.shared.thumbnail(for: event, maxPixelSize: 320) {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 160, maxHeight: 120, alignment: .leading)
            } else {
                Text(model.t("history.image")).italic()
            }
        } else {
            // Render a bounded prefix: a history item can be megabytes of text.
            Text(event.content.isEmpty ? model.t("history.emptyText") : String(event.content.prefix(600)))
                .lineLimit(4)
                .multilineTextAlignment(.leading)
        }
    }

    private var time: String? {
        guard let createdAt = event.createdAt, let date = Self.isoParser.date(from: createdAt) else { return nil }
        return Self.timeFormatter.string(from: date)
    }
}
