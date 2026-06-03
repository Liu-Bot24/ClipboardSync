import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const i18n = require('../src/client/i18n.cjs');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = {};
    this.hidden = false;
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.value = '';
    this.placeholder = '';
    this.checked = false;
    this.indeterminate = false;
    this.type = '';
    this.src = '';
    this.alt = '';
    this.colSpan = 0;
    this.open = false;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  addEventListener(type, listener) {
    this.listeners[type] ||= [];
    this.listeners[type].push(listener);
  }

  setAttribute(name, value) {
    this[name] = value;
  }

  async dispatch(type) {
    await Promise.all((this.listeners[type] || []).map((listener) => listener({ target: this })));
  }

  find(predicate) {
    if (predicate(this)) {
      return this;
    }
    for (const child of this.children) {
      const found = child.find?.(predicate);
      if (found) {
        return found;
      }
    }
    return null;
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const MAIN_UI_IDS = [
  'status',
  'devices',
  'pauseSend',
  'pauseReceive',
  'autoLaunch',
  'hubUrl',
  'token',
  'historyButton',
  'saveConnection',
  'ignoredSourcePatterns',
  'ignoreUnknownSource',
  'recentSources',
  'saveIgnore',
  'refresh',
  'quit'
];

function fakeDocument(ids) {
  const elements = new Map(ids.map((id) => [`#${id}`, new FakeElement()]));
  elements.set('.connection', new FakeElement('details'));
  return {
    documentElement: { lang: '' },
    elements,
    createElement: (tagName) => new FakeElement(tagName),
    querySelectorAll: () => [],
    querySelector(selector) {
      if (!elements.has(selector)) {
        throw new Error(`Missing fake element: ${selector}`);
      }
      return elements.get(selector);
    }
  };
}

async function runRenderer(scriptName, { ids, clipboardSync }) {
  const document = fakeDocument(ids);
  const script = await readFile(join(process.cwd(), 'src/client', scriptName), 'utf8');
  vm.runInNewContext(script, { document, window: { clipboardSync, ClipboardSyncI18n: i18n } }, { filename: scriptName });
  await new Promise((resolve) => setImmediate(resolve));
  return document;
}

function uiState(overrides = {}) {
  return {
    status: { state: 'connection-error', message: 'socket closed' },
    settings: {
      deviceId: 'macbook',
      hubUrl: 'http://192.0.2.10:8787',
      pauseSend: false,
      pauseReceive: true,
      autoLaunch: true,
      hasToken: true,
      ignoreUnknownSource: false,
      ignoredSourcePatterns: ['Voice Input'],
      deviceRules: {
        'main-pc': { send: true, receive: true }
      }
    },
    devices: [
      { deviceId: 'macbook', ip: '192.0.2.10' },
      { deviceId: 'main-pc', ip: '192.0.2.20' },
      { deviceId: 'headless-pc' }
    ],
    history: [],
    recentSources: [],
    ...overrides
  };
}

test('ui renderer never echoes the token and does not overwrite it when the token field is blank', async () => {
  const calls = [];
  const document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform: 'darwin',
      onState: () => {},
      getState: () => Promise.resolve(uiState()),
      updateSetting: (patch) => calls.push(['updateSetting', patch]),
      updateRule: (...args) => calls.push(['updateRule', ...args]),
      refresh: () => calls.push(['refresh']),
      quit: () => calls.push(['quit']),
      showHistory: () => calls.push(['showHistory'])
    }
  });

  const token = document.querySelector('#token');
  const hubUrl = document.querySelector('#hubUrl');
  assert.equal(token.value, '');
  assert.equal(token.placeholder, '已配置，留空不改');
  assert.equal(document.querySelector('#status').textContent, '连接错误 · socket closed');
  assert.equal(document.querySelector('#status').title, 'socket closed');

  hubUrl.value = '  http://192.0.2.10:8787/  ';
  token.value = '';
  document.querySelector('#saveConnection').dispatch('click');
  token.value = 'new-token';
  document.querySelector('#saveConnection').dispatch('click');

  assert.deepEqual(plain(calls), [
    ['updateSetting', { hubUrl: 'http://192.0.2.10:8787/' }],
    ['updateSetting', { hubUrl: 'http://192.0.2.10:8787/', token: 'new-token' }]
  ]);
});

test('ui renderer saves ignored source application patterns', async () => {
  const calls = [];
  const document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform: 'darwin',
      onState: () => {},
      getState: () => Promise.resolve(uiState()),
      updateSetting: (patch) => calls.push(['updateSetting', patch]),
      updateRule: () => {},
      refresh: () => {},
      quit: () => {},
      showHistory: () => {}
    }
  });

  const ignored = document.querySelector('#ignoredSourcePatterns');
  const ignoreUnknown = document.querySelector('#ignoreUnknownSource');
  assert.equal(ignored.value, 'Voice Input');
  ignoreUnknown.checked = true;
  ignored.value = 'Voice Input\nDictation Helper\n';
  await document.querySelector('#saveIgnore').dispatch('click');

  assert.deepEqual(plain(calls), [
    ['updateSetting', { ignoreUnknownSource: true, ignoredSourcePatterns: ['Voice Input', 'Dictation Helper'] }]
  ]);
});

test('ui renderer adds a recent clipboard source to ignored source rules', async () => {
  const calls = [];
  const document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform: 'darwin',
      onState: () => {},
      getState: () =>
        Promise.resolve(
          uiState({
            settings: {
              ...uiState().settings,
              ignoredSourcePatterns: ['Voice Input']
            },
            recentSources: [
              {
                id: 'processname:dictationhelper',
                label: 'DictationHelper',
                pattern: 'DictationHelper',
                detail: '窗口：正在听写'
              }
            ]
          })
        ),
      updateSetting: (patch) => calls.push(['updateSetting', patch]),
      updateRule: () => {},
      refresh: () => {},
      quit: () => {},
      showHistory: () => {}
    }
  });

  const recentRows = document.querySelector('#recentSources').children;
  assert.equal(recentRows.length, 1);
  assert.equal(recentRows[0].children[0].children[0].textContent, 'DictationHelper');
  assert.equal(recentRows[0].children[0].children[1].textContent, '窗口：正在听写');

  await recentRows[0].children[1].dispatch('click');

  assert.deepEqual(plain(calls), [
    ['updateSetting', { ignoredSourcePatterns: ['Voice Input', 'DictationHelper'] }]
  ]);
});

test('ui renderer turns unidentified recent copy sources into the unknown-source toggle', async () => {
  const calls = [];
  const document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform: 'win32',
      onState: () => {},
      getState: () =>
        Promise.resolve(
          uiState({
            settings: {
              ...uiState().settings,
              ignoreUnknownSource: false,
              ignoredSourcePatterns: []
            },
            recentSources: [
              {
                id: 'unknown-source',
                label: '未知复制来源',
                detail: '系统没有提供写入剪贴板的进程',
                unknown: true
              }
            ]
          })
        ),
      updateSetting: (patch) => calls.push(['updateSetting', patch]),
      updateRule: () => {},
      refresh: () => {},
      quit: () => {},
      showHistory: () => {}
    }
  });

  const row = document.querySelector('#recentSources').children[0];
  assert.equal(row.children[0].children[0].textContent, '未知复制来源');

  await row.children[1].dispatch('click');

  assert.equal(document.querySelector('#ignoreUnknownSource').checked, true);
  assert.deepEqual(plain(calls), [['updateSetting', { ignoreUnknownSource: true }]]);
});

test('ui renderer localizes dynamic main window text in English', async () => {
  const document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform: 'darwin',
      onState: () => {},
      getState: () =>
        Promise.resolve(
          uiState({
            status: { state: 'connected' },
            settings: {
              ...uiState().settings,
              language: 'en',
              hubUrl: '',
              hasToken: false,
              ignoredSourcePatterns: []
            },
            devices: [{ deviceId: 'macbook', ip: '192.0.2.10' }],
            recentSources: []
          })
        ),
      updateSetting: () => {},
      updateRule: () => {},
      refresh: () => {},
      quit: () => {},
      showHistory: () => {}
    }
  });

  assert.equal(document.querySelector('#status').textContent, 'Connected');
  assert.equal(document.querySelector('#token').placeholder, 'Not configured; can be empty');
  assert.equal(document.querySelector('#devices').children[0].children[0].textContent, 'No other devices');
  assert.equal(document.querySelector('#recentSources').children[0].textContent, 'No recent copy sources');
});

test('history renderer localizes English history actions', async () => {
  const document = await runRenderer('history-renderer.js', {
    ids: ['history', 'historyStatus', 'historyAlwaysOnTop', 'refreshHistory', 'clearHistory'],
    clipboardSync: {
      onState: () => {},
      getState: () =>
        Promise.resolve({
          settings: {
            language: 'en',
            historyAlwaysOnTop: true,
            historyDisplayLimit: 12
          },
          history: [
            { id: 'text-1', sourceIp: '192.0.2.20', contentType: 'text/plain', preview: 'hello' },
            { id: 'image-1', contentType: 'image/png', preview: '图片', imagePreviewSrc: null }
          ]
        }),
      applyHistory: () => Promise.resolve({ applied: true, pasted: false }),
      clearHistory: () => Promise.resolve({ cleared: true }),
      updateSetting: () => {},
      refresh: () => {}
    }
  });

  assert.equal(document.querySelector('#historyStatus').textContent, 'History · Latest 12');
  const items = document.querySelector('#history').children;
  assert.equal(items[1].children[0].textContent, 'Unknown IP');
  assert.equal(items[1].find((element) => element.className === 'image-placeholder').textContent, 'Image');

  await items[0].dispatch('click');
  assert.equal(document.querySelector('#historyStatus').textContent, 'Copied to clipboard');
  await document.querySelector('#clearHistory').dispatch('click');
  assert.equal(document.querySelector('#historyStatus').textContent, 'Global history cleared');
});

test('ui renderer opens connection settings when the public package is not configured', async () => {
  const document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform: 'darwin',
      onState: () => {},
      getState: () =>
        Promise.resolve(
          uiState({
            settings: {
              ...uiState().settings,
              hubUrl: '',
              hasToken: false
            }
          })
        ),
      updateSetting: () => {},
      updateRule: () => {},
      refresh: () => {},
      quit: () => {},
      showHistory: () => {}
    }
  });

  assert.equal(document.querySelector('.connection').open, true);
  assert.equal(document.querySelector('#token').placeholder, '未配置，可留空');
});

test('ui renderer does not open connection settings just because LAN mode has no token', async () => {
  const document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform: 'darwin',
      onState: () => {},
      getState: () =>
        Promise.resolve(
          uiState({
            settings: {
              ...uiState().settings,
              hasToken: false
            }
          })
        ),
      updateSetting: () => {},
      updateRule: () => {},
      refresh: () => {},
      quit: () => {},
      showHistory: () => {}
    }
  });

  assert.equal(document.querySelector('.connection').open, false);
  assert.equal(document.querySelector('#token').placeholder, '未配置，可留空');
});

test('ui renderer wires device rule checkboxes and platform-specific history entry', async () => {
  const calls = [];
  const document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform: 'win32',
      onState: () => {},
      getState: () => Promise.resolve(uiState()),
      updateSetting: (patch) => calls.push(['updateSetting', patch]),
      updateRule: (...args) => calls.push(['updateRule', ...args]),
      refresh: () => calls.push(['refresh']),
      quit: () => calls.push(['quit']),
      showHistory: () => calls.push(['showHistory'])
    }
  });

  const historyButton = document.querySelector('#historyButton');
  assert.equal(historyButton.hidden, false);
  historyButton.dispatch('click');

  const rows = document.querySelector('#devices').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[0].textContent, '192.0.2.20');
  assert.equal(rows[1].children[0].textContent, '未知 IP');
  assert.equal(rows[1].children[0].title, 'headless-pc');

  const sendBox = rows[0].children[1].find((element) => element.tagName === 'INPUT');
  sendBox.checked = false;
  sendBox.dispatch('change');

  assert.deepEqual(plain(calls), [
    ['showHistory'],
    ['updateRule', '192.0.2.20', 'send', false]
  ]);
});

test('ui renderer groups duplicate IP peers into one rule row', async () => {
  const calls = [];
  const document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform: 'darwin',
      onState: () => {},
      getState: () =>
        Promise.resolve(
          uiState({
            devices: [
              { deviceId: 'macbook', ip: '192.0.2.10' },
              { deviceId: 'main-pc-installed', ip: '192.0.2.20' },
              { deviceId: 'main-pc-portable', ip: '192.0.2.20' }
            ],
            settings: {
              ...uiState().settings,
              deviceRules: {
                'main-pc-installed': { send: true, receive: true },
                'main-pc-portable': { send: true, receive: true }
              },
              deviceRulesByIp: {}
            }
          })
        ),
      updateSetting: (patch) => calls.push(['updateSetting', patch]),
      updateRule: (...args) => calls.push(['updateRule', ...args]),
      refresh: () => calls.push(['refresh']),
      quit: () => calls.push(['quit']),
      showHistory: () => calls.push(['showHistory'])
    }
  });

  const rows = document.querySelector('#devices').children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].children[0].textContent, '192.0.2.20');

  const sendBox = rows[0].children[1].find((element) => element.tagName === 'INPUT');
  sendBox.checked = false;
  sendBox.dispatch('change');

  assert.deepEqual(plain(calls), [['updateRule', '192.0.2.20', 'send', false]]);
});

test('ui renderer shows a mixed checkbox state for partially enabled duplicate IP peers', async () => {
  const document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform: 'darwin',
      onState: () => {},
      getState: () =>
        Promise.resolve(
          uiState({
            devices: [
              { deviceId: 'macbook', ip: '192.0.2.10' },
              { deviceId: 'main-pc-installed', deviceName: 'Main PC', ip: '192.0.2.20' },
              { deviceId: 'main-pc-portable', deviceName: 'Portable', ip: '192.0.2.20' }
            ],
            settings: {
              ...uiState().settings,
              deviceRules: {
                'main-pc-installed': { send: false, receive: true },
                'main-pc-portable': { send: true, receive: true }
              },
              deviceRulesByIp: {
                '192.0.2.20': { send: true, receive: true }
              }
            }
          })
        ),
      updateSetting: () => {},
      updateRule: () => {},
      refresh: () => {},
      quit: () => {},
      showHistory: () => {}
    }
  });

  const row = document.querySelector('#devices').children[0];
  assert.equal(row.children[0].title, '192.0.2.20');
  assert.doesNotMatch(row.children[0].title, /main-pc-installed|Portable|Main PC/);

  const sendBox = row.children[1].find((element) => element.tagName === 'INPUT');
  assert.equal(sendBox.checked, false);
  assert.equal(sendBox.indeterminate, true);
  assert.equal(sendBox.title, '部分设备已关闭发送');

  const receiveBox = row.children[2].find((element) => element.tagName === 'INPUT');
  assert.equal(receiveBox.checked, true);
  assert.equal(receiveBox.indeterminate, false);
});

test('ui renderer shows four devices as three IP rows with mixed duplicate-IP state', async () => {
  const document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform: 'darwin',
      onState: () => {},
      getState: () =>
        Promise.resolve(
          uiState({
            devices: [
              { deviceId: 'macbook', ip: '192.0.2.10' },
              { deviceId: 'main-pc-installed', ip: '192.0.2.20' },
              { deviceId: 'main-pc-portable', ip: '192.0.2.20' },
              { deviceId: 'mac-mini', ip: '192.0.2.21' },
              { deviceId: 'mini-pc', ip: '192.0.2.22' }
            ],
            settings: {
              ...uiState().settings,
              deviceRules: {
                'main-pc-installed': { send: false, receive: true },
                'main-pc-portable': { send: true, receive: true },
                'mac-mini': { send: false, receive: true },
                'mini-pc': { send: true, receive: false }
              },
              deviceRulesByIp: {}
            }
          })
        ),
      updateSetting: () => {},
      updateRule: () => {},
      refresh: () => {},
      quit: () => {},
      showHistory: () => {}
    }
  });

  const rows = document.querySelector('#devices').children;
  assert.deepEqual(
    rows.map((row) => row.children[0].textContent),
    ['192.0.2.20', '192.0.2.21', '192.0.2.22']
  );

  const sharedIpSend = rows[0].children[1].find((element) => element.tagName === 'INPUT');
  assert.equal(sharedIpSend.indeterminate, true);
  const miniPcReceive = rows[2].children[2].find((element) => element.tagName === 'INPUT');
  assert.equal(miniPcReceive.checked, false);
});

test('history renderer renders text and image history and applies selected entries locally', async () => {
  const calls = [];
  const document = await runRenderer('history-renderer.js', {
    ids: ['history', 'historyStatus', 'historyAlwaysOnTop', 'refreshHistory', 'clearHistory'],
    clipboardSync: {
      onState: () => {},
      getState: () => Promise.resolve({
        settings: {
          historyAlwaysOnTop: true
        },
        history: [
          { id: 'text-1', sourceIp: '192.0.2.20', contentType: 'text/plain', preview: 'hello' },
          { id: 'image-1', contentType: 'image/png', preview: '图片', imagePreviewSrc: 'data:image/png;base64,aW1hZ2U=' },
          { id: 'image-large', contentType: 'image/png', preview: '图片', imagePreviewSrc: null }
        ]
      }),
      applyHistory: (id) => {
        calls.push(['applyHistory', id]);
        return Promise.resolve({ applied: true, pasted: true });
      },
      clearHistory: () => {
        calls.push(['clearHistory']);
        return Promise.resolve({ cleared: true });
      },
      updateSetting: (patch) => calls.push(['updateSetting', patch]),
      refresh: () => calls.push(['refresh'])
    }
  });

  const pin = document.querySelector('#historyAlwaysOnTop');
  assert.equal(pin.checked, true);
  pin.checked = false;
  await pin.dispatch('change');

  const items = document.querySelector('#history').children;
  assert.equal(items.length, 3);
  assert.equal(items[0].children[0].textContent, '192.0.2.20');
  assert.equal(items[0].children[1].textContent, 'hello');
  assert.equal(items[1].children[0].textContent, '未知 IP');
  const image = items[1].find((element) => element.tagName === 'IMG');
  assert.equal(image.src, 'data:image/png;base64,aW1hZ2U=');
  assert.equal(image.alt, '图片剪贴板预览');
  assert.equal(items[1].children[1].find((element) => element.className === 'history-preview-text'), null);
  const placeholder = items[2].find((element) => element.className === 'image-placeholder');
  assert.ok(placeholder);
  assert.equal(placeholder.textContent, '图片');

  await items[0].dispatch('click');
  assert.equal(document.querySelector('#historyStatus').textContent, '已粘贴');
  document.querySelector('#refreshHistory').dispatch('click');
  await document.querySelector('#clearHistory').dispatch('click');
  assert.equal(document.querySelector('#historyStatus').textContent, '全局历史已清除');

  assert.deepEqual(plain(calls), [
    ['updateSetting', { historyAlwaysOnTop: false }],
    ['applyHistory', 'text-1'],
    ['refresh'],
    ['clearHistory']
  ]);
});
