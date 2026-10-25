import Foundation

/// zh-CN / en strings, keyed like `src/client/i18n.cjs`, plus a few native-only keys.
public enum L10n {
    public static let defaultLanguage = "zh-CN"
    public static let supportedLanguages: [(code: String, label: String)] = [("zh-CN", "简体中文"), ("en", "English")]

    public static func normalizeLanguage(_ value: String?) -> String {
        let raw = (value ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if raw == "en" || raw.hasPrefix("en-") { return "en" }
        if raw == "zh" || raw == "zh-cn" || raw.hasPrefix("zh-hans") { return "zh-CN" }
        return defaultLanguage
    }

    /// First-run language: Chinese for any Chinese system language, English for other languages.
    public static func languageForSystem(_ preferred: [String]) -> String {
        guard let first = preferred.first?.lowercased() else { return defaultLanguage }
        return first.hasPrefix("zh") ? "zh-CN" : "en"
    }

    public static func t(_ language: String, _ key: String, _ params: [String: String] = [:]) -> String {
        let table = messages[normalizeLanguage(language)] ?? [:]
        var value = table[key] ?? messages[defaultLanguage]?[key] ?? key
        for (name, replacement) in params {
            value = value.replacingOccurrences(of: "{\(name)}", with: replacement)
        }
        return value
    }

    public static let messages: [String: [String: String]] = [
        "zh-CN": [
            "app.sharedClipboard": "共享剪贴板",
            "app.mainWindow": "主窗口",
            "status.connected": "已连接",
            "status.disconnected": "已断开",
            "status.invalidHubUrl": "Hub 地址无效",
            "status.duplicateDevice": "设备重复",
            "status.connectionError": "连接错误",
            "status.clipboardError": "剪贴板错误",
            "status.hubError": "服务器错误",
            "status.configError": "设置错误",
            "status.starting": "连接中",
            "status.duplicateDeviceDetail": "设备 ID 重复，30 秒后重试",
            "status.invalidMessage": "Hub 消息无效",
            "status.policyAckTimeout": "Hub 接收策略确认超时",
            "status.serverNotSet": "尚未设置服务器",
            "action.history": "历史",
            "action.refresh": "刷新",
            "action.save": "保存",
            "action.quit": "退出",
            "action.copy": "复制",
            "action.paste": "粘贴",
            "action.removeToken": "移除令牌",
            "settings.pauseSend": "暂停发送",
            "settings.pauseReceive": "暂停接收",
            "settings.autoLaunch": "开机启动",
            "settings.alwaysOnTop": "总在最前",
            "connection.section": "连接",
            "connection.server": "服务器",
            "connection.token": "令牌（可选）",
            "connection.tokenConfigured": "已配置，留空不改",
            "connection.saveFailed": "设置未保存，请检查后重试",
            "connection.tokenEmpty": "未配置，可留空",
            "connection.saved": "已保存",
            "devices.noOtherDevices": "暂无其他设备",
            "devices.unknownIp": "未知 IP",
            "devices.send": "发送",
            "devices.receive": "接收",
            "devices.sendMixed": "部分设备已关闭发送",
            "devices.receiveMixed": "部分设备已关闭接收",
            "devices.thisDevice": "本机",
            "history.section": "历史",
            "history.mainWindow": "主窗口",
            "history.latest": "历史 · 最近 {limit} 条",
            "history.none": "暂无历史",
            "history.notFound": "未找到历史",
            "history.pasted": "已粘贴",
            "history.permissionRequired": "需要辅助功能权限",
            "history.permissionHint": "请在“系统设置 › 隐私与安全性 › 辅助功能”中允许 Clipboard Sync，然后重试。",
            "history.copied": "已写入剪贴板",
            "history.writeFailed": "写入剪贴板失败",
            "history.clearFailed": "清除失败",
            "history.cleared": "全局历史已清除",
            "history.clearGlobal": "清除全局历史",
            "history.confirmClear": "再点一次确认清除",
            "history.image": "图片",
            "history.emptyText": "(空文本)",
            "menu.statusPrefix": "状态：",
            "menu.deviceSettings": "收发设置",
            "menu.language": "语言",
            "launch.failed": "开机启动设置失败",
            "launch.requiresApproval": "请在“系统设置 › 通用 › 登录项”中允许 Clipboard Sync"
        ],
        "en": [
            "app.sharedClipboard": "Shared Clipboard",
            "app.mainWindow": "Main Window",
            "status.connected": "Connected",
            "status.disconnected": "Disconnected",
            "status.invalidHubUrl": "Invalid Hub URL",
            "status.duplicateDevice": "Duplicate device",
            "status.connectionError": "Connection error",
            "status.clipboardError": "Clipboard error",
            "status.hubError": "Server error",
            "status.configError": "Settings error",
            "status.starting": "Connecting",
            "status.duplicateDeviceDetail": "Duplicate device ID; retrying in 30 seconds",
            "status.invalidMessage": "Invalid Hub message",
            "status.policyAckTimeout": "The Hub did not confirm the receive policy",
            "status.serverNotSet": "Server not set",
            "action.history": "History",
            "action.refresh": "Refresh",
            "action.save": "Save",
            "action.quit": "Quit",
            "action.copy": "Copy",
            "action.paste": "Paste",
            "action.removeToken": "Remove Token",
            "settings.pauseSend": "Pause Sending",
            "settings.pauseReceive": "Pause Receiving",
            "settings.autoLaunch": "Launch at Login",
            "settings.alwaysOnTop": "Always on Top",
            "connection.section": "Connection",
            "connection.server": "Server",
            "connection.token": "Token (optional)",
            "connection.tokenConfigured": "Configured; leave blank to keep",
            "connection.saveFailed": "Settings were not saved. Check them and try again.",
            "connection.tokenEmpty": "Not configured; can be empty",
            "connection.saved": "Saved",
            "devices.noOtherDevices": "No other devices",
            "devices.unknownIp": "Unknown IP",
            "devices.send": "Send",
            "devices.receive": "Receive",
            "devices.sendMixed": "Some devices have sending disabled",
            "devices.receiveMixed": "Some devices have receiving disabled",
            "devices.thisDevice": "This Mac",
            "history.section": "History",
            "history.mainWindow": "Main Window",
            "history.latest": "History · Latest {limit}",
            "history.none": "No history",
            "history.notFound": "History item not found",
            "history.pasted": "Pasted",
            "history.permissionRequired": "Accessibility permission required",
            "history.permissionHint": "Allow Clipboard Sync in System Settings › Privacy & Security › Accessibility, then try again.",
            "history.copied": "Copied to clipboard",
            "history.writeFailed": "Could not write to the clipboard",
            "history.clearFailed": "Clear failed",
            "history.cleared": "Global history cleared",
            "history.clearGlobal": "Clear Global History",
            "history.confirmClear": "Click again to clear",
            "history.image": "Image",
            "history.emptyText": "(empty text)",
            "menu.statusPrefix": "Status: ",
            "menu.deviceSettings": "Send / Receive Settings",
            "menu.language": "Language",
            "launch.failed": "Could not change Launch at Login",
            "launch.requiresApproval": "Allow Clipboard Sync in System Settings › General › Login Items"
        ]
    ]

    /// Short single-line preview like `eventPreview` in `clipboard-content.js`.
    public static func preview(of event: ClipboardEvent, language: String, maxLength: Int = 42) -> String {
        guard event.isText else { return t(language, "history.image") }
        let compact = event.content
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        if compact.isEmpty { return t(language, "history.emptyText") }
        return compact.count > maxLength ? String(compact.prefix(maxLength - 1)) + "..." : compact
    }
}
