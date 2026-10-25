import AppKit
import ClipboardSyncCore
import Combine

final class ClosureMenuItem: NSMenuItem {
    private let handler: () -> Void

    init(title: String, state: NSControl.StateValue = .off, handler: @escaping () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(fire), keyEquivalent: "")
        self.target = self
        self.state = state
    }

    required init(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    @objc private func fire() {
        handler()
    }
}

/// Menu bar item. The menu is rebuilt each time it opens, so nothing is rebuilt
/// while the clipboard or connection state changes in the background.
@MainActor
final class StatusMenuController: NSObject, NSMenuDelegate {
    private static let maxMenuTitle = 60
    private let model: AppModel
    private let statusItem: NSStatusItem
    private let menu: NSMenu
    private let showSettings: () -> Void
    private let showHistory: () -> Void
    private var cancellables: Set<AnyCancellable> = []

    init(model: AppModel, showSettings: @escaping () -> Void, showHistory: @escaping () -> Void) {
        self.model = model
        self.showSettings = showSettings
        self.showHistory = showHistory
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        menu = NSMenu()
        super.init()
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: "doc.on.clipboard", accessibilityDescription: "Clipboard Sync")
            image?.isTemplate = true
            button.image = image
        }
        model.$status
            .sink { [weak self] status in self?.updateButton(status) }
            .store(in: &cancellables)
    }

    private func updateButton(_ status: HubStatus) {
        guard let button = statusItem.button else { return }
        button.appearsDisabled = status.state != .connected
        button.toolTip = "Clipboard Sync · \(L10n.t(model.settings.language, status.state.labelKey))"
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let settings = model.settings

        menu.addItem(disabled("\(model.t("menu.statusPrefix"))\(model.statusLabel)"))
        if let detail = model.status.detail(language: settings.language), !detail.isEmpty {
            menu.addItem(disabled(truncated(detail)))
        }
        menu.addItem(ClosureMenuItem(title: model.t("menu.deviceSettings") + "…") { [weak self] in self?.showSettings() })
        menu.addItem(historyItem())
        menu.addItem(.separator())

        menu.addItem(ClosureMenuItem(title: model.t("settings.pauseSend"), state: settings.pauseSend ? .on : .off) { [weak self] in
            guard let self else { return }
            self.model.setPauseSend(!self.model.settings.pauseSend)
        })
        menu.addItem(ClosureMenuItem(title: model.t("settings.pauseReceive"), state: settings.pauseReceive ? .on : .off) { [weak self] in
            guard let self else { return }
            self.model.setPauseReceive(!self.model.settings.pauseReceive)
        })
        menu.addItem(ClosureMenuItem(title: model.t("settings.autoLaunch"), state: model.launchAtLogin ? .on : .off) { [weak self] in
            guard let self else { return }
            self.model.setLaunchAtLogin(!self.model.launchAtLogin)
        })
        menu.addItem(languageItem())
        menu.addItem(.separator())
        menu.addItem(ClosureMenuItem(title: model.t("action.quit")) { NSApp.terminate(nil) })
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func truncated(_ text: String) -> String {
        let line = text.replacingOccurrences(of: "\n", with: " ")
        return line.count > Self.maxMenuTitle ? String(line.prefix(Self.maxMenuTitle - 1)) + "…" : line
    }

    private func historyItem() -> NSMenuItem {
        let item = NSMenuItem(title: model.t("history.section"), action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        submenu.autoenablesItems = false
        submenu.addItem(ClosureMenuItem(title: model.t("history.mainWindow")) { [weak self] in self?.showHistory() })
        submenu.addItem(.separator())
        if model.history.isEmpty {
            submenu.addItem(disabled(model.t("history.none")))
        }
        for event in model.history {
            let source = event.sourceIp ?? event.sourceDeviceId ?? model.t("devices.unknownIp")
            let title = truncated("\(source) \(L10n.preview(of: event, language: model.settings.language))")
            // Choosing an item pastes into the app that was frontmost when the menu opened.
            let entry = ClosureMenuItem(title: title) { [weak self] in self?.model.applyHistory(event, paste: true) }
            if let thumbnail = ThumbnailCache.shared.thumbnail(for: event, maxPixelSize: 36) {
                entry.image = Self.menuIcon(thumbnail)
            }
            submenu.addItem(entry)
        }
        item.submenu = submenu
        return item
    }

    private func languageItem() -> NSMenuItem {
        let item = NSMenuItem(title: model.t("menu.language"), action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        for language in L10n.supportedLanguages {
            let selected = L10n.normalizeLanguage(model.settings.language) == language.code
            submenu.addItem(ClosureMenuItem(title: language.label, state: selected ? .on : .off) { [weak self] in
                self?.model.setLanguage(language.code)
            })
        }
        item.submenu = submenu
        return item
    }

    private static func menuIcon(_ image: NSImage) -> NSImage {
        let box = NSSize(width: 18, height: 18)
        return NSImage(size: box, flipped: false) { rect in
            let size = image.size
            let scale = min(rect.width / max(size.width, 1), rect.height / max(size.height, 1))
            let drawn = NSSize(width: size.width * scale, height: size.height * scale)
            image.draw(in: NSRect(x: (rect.width - drawn.width) / 2, y: (rect.height - drawn.height) / 2, width: drawn.width, height: drawn.height))
            return true
        }
    }
}
