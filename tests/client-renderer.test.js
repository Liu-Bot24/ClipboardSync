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
  'sourceCapability',
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
    ['updateSetting', { ignoreUnknownSource: false, ignoredSourcePatterns: ['Voice Input', 'DictationHelper'] }]
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
  assert.deepEqual(plain(calls), [['updateSetting', { ignoreUnknownSource: true, ignoredSourcePatterns: [] }]]);
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

for (const stateFirst of [true, false]) test(`S4: clear completion preserves new published history (stateFirst=${stateFirst})`, async () => {
  let publish; let resolveClear;
  const clear = new Promise((resolve) => { resolveClear = resolve; });
  const document = await runRenderer('history-renderer.js', {
    ids: ['history', 'historyStatus', 'historyAlwaysOnTop', 'refreshHistory', 'clearHistory'],
    clipboardSync: { onState: (fn) => { publish = fn; }, getState: async () => ({ settings: {}, history: [] }),
      clearHistory: () => clear, updateSetting: () => {}, refresh: () => {} }
  });
  const newer = { settings: {}, history: [{ id: 'after-clear', contentType: 'text/plain', preview: 'new record' }] };
  const clicked = document.querySelector('#clearHistory').dispatch('click');
  if (stateFirst) publish(newer);
  resolveClear({ cleared: true }); await clicked;
  if (!stateFirst) publish(newer);
  assert.equal(document.querySelector('#history').children[0].children[1].textContent, 'new record');
});

test('history renderer ignores an initial snapshot that completes after a live state', async () => {
  let publish; let resolveInitial;
  const initial = new Promise((resolve) => { resolveInitial = resolve; });
  const document = await runRenderer('history-renderer.js', {
    ids: ['history', 'historyStatus', 'historyAlwaysOnTop', 'refreshHistory', 'clearHistory'],
    clipboardSync: { onState: (fn) => { publish = fn; }, getState: () => initial,
      clearHistory: async () => ({ cleared: true }), updateSetting: () => {}, refresh: () => {} }
  });
  publish({ settings: {}, history: [{ id: 'latest', contentType: 'text/plain', preview: 'new record' }] });
  resolveInitial({ settings: {}, history: [] }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(document.querySelector('#history').children[0].children[1]?.textContent, 'new record');
});

test('ui renderer preserves unsaved connection and ignore edits across state refreshes', async () => {
  let stateListener;
  const document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform: 'darwin',
      onState: (listener) => {
        stateListener = listener;
      },
      getState: () => Promise.resolve(uiState()),
      updateSetting: () => {},
      updateRule: () => {},
      refresh: () => {},
      quit: () => {},
      showHistory: () => {}
    }
  });
  const hubUrl = document.querySelector('#hubUrl');
  const token = document.querySelector('#token');
  const ignoreUnknown = document.querySelector('#ignoreUnknownSource');
  const ignoredPatterns = document.querySelector('#ignoredSourcePatterns');

  hubUrl.value = 'http://draft-hub:8787';
  token.value = 'draft-token';
  ignoredPatterns.value = 'Draft Writer';
  ignoreUnknown.checked = true;
  await hubUrl.dispatch('input');
  await token.dispatch('input');
  await ignoredPatterns.dispatch('input');
  await ignoreUnknown.dispatch('change');

  stateListener(
    uiState({
      status: { state: 'connected' },
      settings: {
        ...uiState().settings,
        hubUrl: 'http://server-refresh:8787',
        ignoreUnknownSource: false,
        ignoredSourcePatterns: ['Server Rule']
      }
    })
  );

  assert.equal(document.querySelector('#status').textContent, '已连接');
  assert.equal(hubUrl.value, 'http://draft-hub:8787');
  assert.equal(token.value, 'draft-token');
  assert.equal(ignoreUnknown.checked, true);
  assert.equal(ignoredPatterns.value, 'Draft Writer');
});

test('ui renderer does not replace a focused connection field before it is edited', async () => {
  let stateListener;
  const document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform: 'darwin',
      onState: (listener) => {
        stateListener = listener;
      },
      getState: () => Promise.resolve(uiState()),
      updateSetting: () => {},
      updateRule: () => {},
      refresh: () => {},
      quit: () => {},
      showHistory: () => {}
    }
  });
  const hubUrl = document.querySelector('#hubUrl');
  document.activeElement = hubUrl;

  stateListener(
    uiState({
      settings: {
        ...uiState().settings,
        hubUrl: 'http://server-refresh:8787'
      }
    })
  );

  assert.equal(hubUrl.value, 'http://192.0.2.10:8787');
});


async function draftHarness(updateSetting, platform = 'win32') {
  const h = { calls: [] };
  h.document = await runRenderer('ui-renderer.js', {
    ids: MAIN_UI_IDS,
    clipboardSync: {
      platform, onState: listener => { h.publish = listener; },
      getState: () => Promise.resolve(uiState()),
      updateSetting: patch => { h.calls.push(plain(patch)); return updateSetting(patch); },
      updateRule() {}, refresh() {}, quit() {}, showHistory() {}
    }
  });
  h.el = id => h.document.querySelector(`#${id}`);
  h.edit = async (id, value) => { h.el(id).value = value; await h.el(id).dispatch('input'); };
  return h;
}
function savedState(settings = {}, extra = {}) {
  return uiState({ settings: { ...uiState().settings, ...settings }, settingsSaved: true, ...extra });
}
const draftDeferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

test('successful connection save clears only its accepted draft and preserves newer live status', async () => {
  const pending = draftDeferred(); const h = await draftHarness(() => pending.promise);
  await h.edit('hubUrl', 'http://draft.example/'); await h.edit('token', 'test-only-token');
  const saving = h.el('saveConnection').dispatch('click');
  h.publish(savedState({ hubUrl: 'http://draft.example' }, { status: { state: 'connected' } }));
  assert.equal(h.el('token').value, 'test-only-token');
  pending.resolve(savedState({ hubUrl: 'http://draft.example' })); await saving;
  assert.equal(h.el('hubUrl').value, 'http://draft.example'); assert.equal(h.el('token').value, '');
  assert.equal(h.el('status').textContent, '已连接');
  h.publish(savedState({ hubUrl: 'http://later.example' })); assert.equal(h.el('hubUrl').value, 'http://later.example');
});

for (const result of ['rejection', 'not-saved']) {
  test(`failed connection save (${result}) retains the complete draft`, async () => {
    const h = await draftHarness(() => result === 'rejection' ? Promise.reject(Error('IPC unavailable')) : savedState({}, { settingsSaved: false, status: {} }));
    await h.edit('hubUrl', 'http://draft.example'); await h.edit('token', 'test-only-token');
    await h.el('saveConnection').dispatch('click');
    assert.equal(h.el('status').textContent, result === 'rejection' ? '设置未保存，请检查后重试 · IPC unavailable' : '设置未保存，请检查后重试');
    h.publish(uiState());
    assert.equal(h.el('hubUrl').value, 'http://draft.example'); assert.equal(h.el('token').value, 'test-only-token');
  });
}

test('connection save completion does not clear edits made while it was pending', async () => {
  const pending = draftDeferred(); const h = await draftHarness(() => pending.promise);
  await h.edit('hubUrl', 'http://first.example'); await h.edit('token', 'first-test-token');
  const saving = h.el('saveConnection').dispatch('click');
  await h.edit('hubUrl', 'http://second.example'); await h.edit('token', 'second-test-token');
  pending.resolve(savedState({ hubUrl: 'http://first.example' })); await saving;
  h.publish(uiState());
  assert.equal(h.el('hubUrl').value, 'http://second.example'); assert.equal(h.el('token').value, 'second-test-token');
});

test('out-of-order connection save responses cannot undo the latest completed save', async () => {
  const first = draftDeferred(), second = draftDeferred(); let calls = 0;
  const h = await draftHarness(() => (++calls === 1 ? first : second).promise);
  await h.edit('hubUrl', 'http://first.example'); const a = h.el('saveConnection').dispatch('click');
  await h.edit('hubUrl', 'http://second.example'); const b = h.el('saveConnection').dispatch('click');
  second.resolve(savedState({ hubUrl: 'http://second.example' })); await b;
  first.resolve(savedState({ hubUrl: 'http://first.example' })); await a;
  assert.equal(h.el('hubUrl').value, 'http://second.example');
});

test('saved ignore settings use normalized results and allow subsequent external refreshes', async () => {
  const h = await draftHarness(() => savedState({ ignoredSourcePatterns: ['Editor'], ignoreUnknownSource: true }));
  await h.edit('ignoredSourcePatterns', ' Editor \n'); h.el('ignoreUnknownSource').checked = true; await h.el('ignoreUnknownSource').dispatch('change');
  await h.el('saveIgnore').dispatch('click');
  assert.deepEqual(h.calls, [{ ignoredSourcePatterns: ['Editor'], ignoreUnknownSource: true }]);
  assert.equal(h.el('ignoredSourcePatterns').value, 'Editor');
  h.publish(uiState()); assert.equal(h.el('ignoredSourcePatterns').value, 'Voice Input');
});

for (const result of ['rejection', 'not-saved']) {
  test(`failed ignore save (${result}) keeps unsaved rules across status refreshes`, async () => {
    const h = await draftHarness(() => result === 'rejection' ? Promise.reject(Error('IPC unavailable')) : savedState({}, { settingsSaved: false }));
    await h.edit('ignoredSourcePatterns', 'Unsaved Editor'); h.el('ignoreUnknownSource').checked = true; await h.el('ignoreUnknownSource').dispatch('change');
    await h.el('saveIgnore').dispatch('click'); h.publish(uiState());
    assert.equal(h.el('ignoredSourcePatterns').value, 'Unsaved Editor'); assert.equal(h.el('ignoreUnknownSource').checked, true);
  });
}

test('ignore save does not consume new edits or overwrite an unrelated connection draft', async () => {
  const pending = draftDeferred(); const h = await draftHarness(() => pending.promise);
  await h.edit('hubUrl', 'http://unsaved.example'); await h.edit('ignoredSourcePatterns', 'First Editor');
  const saving = h.el('saveIgnore').dispatch('click');
  await h.edit('ignoredSourcePatterns', 'Second Editor');
  pending.resolve(savedState({ ignoredSourcePatterns: ['First Editor'] })); await saving; h.publish(uiState());
  assert.equal(h.el('ignoredSourcePatterns').value, 'Second Editor'); assert.equal(h.el('hubUrl').value, 'http://unsaved.example');
});

test('adding a recent source saves the other pending ignore edits as one form', async () => {
  const h = await draftHarness(patch => savedState(patch));
  h.publish(uiState({ recentSources: [{ pattern: 'Source App', label: 'Source App' }] }));
  await h.edit('ignoredSourcePatterns', 'Unsaved Editor'); h.el('ignoreUnknownSource').checked = true; await h.el('ignoreUnknownSource').dispatch('change');
  await h.el('recentSources').children[0].children[1].dispatch('click');
  assert.deepEqual(h.calls, [{ ignoreUnknownSource: true, ignoredSourcePatterns: ['Unsaved Editor', 'Source App'] }]);
});

test('unmodified unfocused form still follows external settings broadcasts', async () => {
  const h = await draftHarness(() => {});
  h.publish(savedState({ hubUrl: 'http://external.example', ignoredSourcePatterns: ['External Editor'], ignoreUnknownSource: true }));
  assert.equal(h.el('hubUrl').value, 'http://external.example'); assert.equal(h.el('ignoredSourcePatterns').value, 'External Editor');
});

for (const [button, failure] of [
  ['saveConnection', { state: 'invalid-hub-url', message: 'Hub 地址必须是 http 或 https' }],
  ['saveConnection', { state: 'config-error', message: 'EACCES: permission denied' }],
  ['saveIgnore', { state: 'config-error', message: 'ENOSPC: no space left on device' }]
]) {
  test(`${button} retains the specific save error after its state broadcast`, async () => {
    let h;
    h = await draftHarness(() => {
      const failed = savedState({}, { settingsSaved: false, status: failure });
      h.publish(failed);
      return failed;
    });
    await h.edit('hubUrl', 'ftp://draft.example');
    await h.edit('token', 'test-only-draft');
    await h.edit('ignoredSourcePatterns', 'Unsaved Editor');
    await h.el(button).dispatch('click');
    assert.equal(h.el('status').textContent, `设置未保存，请检查后重试 · ${failure.message}`);
    assert.equal(h.el('status').title, failure.message);
    assert.equal(h.el('token').value, 'test-only-draft');
    assert.equal(h.el('ignoredSourcePatterns').value, 'Unsaved Editor');
  });
}

test('ignore save IPC rejection shows its reason without discarding the draft', async () => {
  const h = await draftHarness(() => Promise.reject(Error('IPC unavailable')));
  await h.edit('ignoredSourcePatterns', 'Unsaved Editor');
  await h.el('saveIgnore').dispatch('click');
  assert.equal(h.el('status').textContent, '设置未保存，请检查后重试 · IPC unavailable');
  assert.equal(h.el('status').title, 'IPC unavailable');
  assert.equal(h.el('ignoredSourcePatterns').value, 'Unsaved Editor');
});

test('an obsolete save failure cannot replace a newer successful result', async () => {
  const first = draftDeferred(), second = draftDeferred(); let calls = 0;
  const h = await draftHarness(() => (++calls === 1 ? first : second).promise);
  await h.edit('hubUrl', 'http://first.example'); const a = h.el('saveConnection').dispatch('click');
  await h.edit('hubUrl', 'http://second.example'); const b = h.el('saveConnection').dispatch('click');
  h.publish(savedState({ hubUrl: 'http://second.example' }, { status: { state: 'connected' } }));
  second.resolve(savedState({ hubUrl: 'http://second.example' })); await b;
  first.reject(Error('obsolete IPC failure')); await a;
  assert.equal(h.el('status').textContent, '已连接');
  assert.equal(h.el('hubUrl').value, 'http://second.example');
});
