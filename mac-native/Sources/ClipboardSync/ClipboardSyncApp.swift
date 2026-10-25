import AppKit

@main
enum ClipboardSyncMain {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        // Menu bar only (also declared by LSUIElement in Info.plist).
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) {
            app.run()
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var model: AppModel?
    private var statusMenu: StatusMenuController?
    private var settingsWindow: SettingsWindowController?
    private var historyWindow: HistoryWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let model = AppModel()
        let settingsWindow = SettingsWindowController(model: model)
        let historyWindow = HistoryWindowController(model: model)
        statusMenu = StatusMenuController(
            model: model,
            showSettings: { settingsWindow.show() },
            showHistory: { historyWindow.show() }
        )
        self.model = model
        self.settingsWindow = settingsWindow
        self.historyWindow = historyWindow
        model.start()
        if model.settings.hubUrl.isEmpty {
            settingsWindow.show()
        }
    }

    /// Opening the app again (Finder, Spotlight) shows the settings window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        settingsWindow?.show()
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        model?.shutdown()
    }
}
