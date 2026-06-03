(function attachI18n(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ClipboardSyncI18n = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createI18n() {
  const DEFAULT_LANGUAGE = 'zh-CN';
  const supportedLanguages = [
    { code: 'zh-CN', label: '简体中文' },
    { code: 'en', label: 'English' }
  ];

  const messages = {
    'zh-CN': {
      app: {
        sharedClipboard: '共享剪贴板',
        mainWindow: '主窗口'
      },
      status: {
        connected: '已连接',
        disconnected: '已断开',
        invalidHubUrl: 'Hub 地址无效',
        duplicateDevice: '设备重复',
        connectionError: '连接错误',
        clipboardError: '剪贴板错误',
        hubError: '服务器错误',
        starting: '连接中'
      },
      action: {
        history: '历史',
        refresh: '刷新',
        save: '保存',
        quit: '退出',
        add: '加入',
        ignore: '忽略'
      },
      settings: {
        pauseSend: '暂停发送',
        pauseReceive: '暂停接收',
        autoLaunch: '开机启动',
        alwaysOnTop: '总在最前'
      },
      connection: {
        section: '连接',
        server: '服务器',
        token: '令牌（可选）',
        tokenConfigured: '已配置，留空不改',
        tokenEmpty: '未配置，可留空'
      },
      ignore: {
        section: '忽略',
        unknownSource: '忽略未知复制来源',
        recentSources: '最近复制来源',
        noRecentSources: '暂无最近复制来源',
        rules: '规则',
        rulesPlaceholder: '可手动填写，一行一个',
        unknownSourceLabel: '未知复制来源',
        unknownSourceDetail: '系统没有提供写入剪贴板的进程'
      },
      devices: {
        noOtherDevices: '暂无其他设备',
        unknownIp: '未知 IP',
        send: '发送',
        receive: '接收',
        sendMixed: '部分设备已关闭发送',
        receiveMixed: '部分设备已关闭接收'
      },
      history: {
        section: '历史',
        mainWindow: '主窗口',
        latest: '历史 · 最近 {limit} 条',
        none: '暂无历史',
        notFound: '未找到历史',
        pasted: '已粘贴',
        permissionRequired: '需要辅助功能权限',
        copied: '已写入剪贴板',
        clearFailed: '清除失败',
        cleared: '全局历史已清除',
        clearGlobal: '清除全局历史',
        image: '图片',
        imageAlt: '图片剪贴板预览'
      },
      menu: {
        statusPrefix: '状态：',
        deviceSettings: '收发设置',
        language: '语言'
      }
    },
    en: {
      app: {
        sharedClipboard: 'Shared Clipboard',
        mainWindow: 'Main Window'
      },
      status: {
        connected: 'Connected',
        disconnected: 'Disconnected',
        invalidHubUrl: 'Invalid Hub URL',
        duplicateDevice: 'Duplicate device',
        connectionError: 'Connection error',
        clipboardError: 'Clipboard error',
        hubError: 'Server error',
        starting: 'Connecting'
      },
      action: {
        history: 'History',
        refresh: 'Refresh',
        save: 'Save',
        quit: 'Quit',
        add: 'Add',
        ignore: 'Ignore'
      },
      settings: {
        pauseSend: 'Pause Sending',
        pauseReceive: 'Pause Receiving',
        autoLaunch: 'Launch at Login',
        alwaysOnTop: 'Always on Top'
      },
      connection: {
        section: 'Connection',
        server: 'Server',
        token: 'Token (optional)',
        tokenConfigured: 'Configured; leave blank to keep',
        tokenEmpty: 'Not configured; can be empty'
      },
      ignore: {
        section: 'Ignore',
        unknownSource: 'Ignore Unknown Copy Sources',
        recentSources: 'Recent Copy Sources',
        noRecentSources: 'No recent copy sources',
        rules: 'Rules',
        rulesPlaceholder: 'One app, process, or window title per line',
        unknownSourceLabel: 'Unknown copy source',
        unknownSourceDetail: 'The system did not expose the clipboard writer process'
      },
      devices: {
        noOtherDevices: 'No other devices',
        unknownIp: 'Unknown IP',
        send: 'Send',
        receive: 'Receive',
        sendMixed: 'Some devices have sending disabled',
        receiveMixed: 'Some devices have receiving disabled'
      },
      history: {
        section: 'History',
        mainWindow: 'Main Window',
        latest: 'History · Latest {limit}',
        none: 'No history',
        notFound: 'History item not found',
        pasted: 'Pasted',
        permissionRequired: 'Accessibility permission required',
        copied: 'Copied to clipboard',
        clearFailed: 'Clear failed',
        cleared: 'Global history cleared',
        clearGlobal: 'Clear Global History',
        image: 'Image',
        imageAlt: 'Image clipboard preview'
      },
      menu: {
        statusPrefix: 'Status: ',
        deviceSettings: 'Send / Receive Settings',
        language: 'Language'
      }
    }
  };

  function normalizeLanguage(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'en' || raw.startsWith('en-')) {
      return 'en';
    }
    if (raw === 'zh' || raw === 'zh-cn' || raw.startsWith('zh-hans')) {
      return 'zh-CN';
    }
    return DEFAULT_LANGUAGE;
  }

  function lookup(source, key) {
    return key.split('.').reduce((value, part) => (value && part in value ? value[part] : undefined), source);
  }

  function interpolate(template, params = {}) {
    return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => String(params[key] ?? ''));
  }

  function t(language, key, params) {
    const normalized = normalizeLanguage(language);
    const value = lookup(messages[normalized], key) ?? lookup(messages[DEFAULT_LANGUAGE], key) ?? key;
    return interpolate(value, params);
  }

  return {
    DEFAULT_LANGUAGE,
    supportedLanguages,
    messages,
    normalizeLanguage,
    t
  };
});
