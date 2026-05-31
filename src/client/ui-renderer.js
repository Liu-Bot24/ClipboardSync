let currentState = null;

const statusEl = document.querySelector('#status');
const devicesEl = document.querySelector('#devices');
const pauseSendEl = document.querySelector('#pauseSend');
const pauseReceiveEl = document.querySelector('#pauseReceive');
const autoLaunchEl = document.querySelector('#autoLaunch');
const hubUrlEl = document.querySelector('#hubUrl');
const tokenEl = document.querySelector('#token');
const historyButtonEl = document.querySelector('#historyButton');
const connectionEl = document.querySelector('.connection');
const ignoreUnknownSourceEl = document.querySelector('#ignoreUnknownSource');
const ignoredSourcePatternsEl = document.querySelector('#ignoredSourcePatterns');
const recentSourcesEl = document.querySelector('#recentSources');
const saveIgnoreEl = document.querySelector('#saveIgnore');

function statusLabel(state) {
  const labels = {
    connected: '已连接',
    disconnected: '已断开',
    'invalid-hub-url': 'Hub 地址无效',
    'duplicate-device': '设备重复',
    'connection-error': '连接错误',
    'clipboard-error': '剪贴板错误',
    'hub-error': '服务器错误'
  };
  return labels[state.status?.state] || '连接中';
}

function statusText(state) {
  const label = statusLabel(state);
  const message = state.status?.message;
  return message ? `${label} · ${message}` : label;
}

function ruleFor(device) {
  return currentState.settings.deviceRules[device.deviceId] || currentState.settings.deviceRulesByIp?.[device.ip] || { send: true, receive: true };
}

function peerGroups(peers) {
  const groups = new Map();
  for (const device of peers) {
    const key = device.ip || device.deviceId;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        ip: device.ip,
        devices: []
      });
    }
    groups.get(key).devices.push(device);
  }
  return [...groups.values()];
}

function ruleForGroup(group) {
  const rules = group.devices.map(ruleFor);
  const sendValues = rules.map((rule) => rule.send !== false);
  const receiveValues = rules.map((rule) => rule.receive !== false);
  return {
    send: sendValues.every(Boolean),
    receive: receiveValues.every(Boolean),
    sendMixed: sendValues.some(Boolean) && !sendValues.every(Boolean),
    receiveMixed: receiveValues.some(Boolean) && !receiveValues.every(Boolean)
  };
}

function renderDevices() {
  devicesEl.replaceChildren();
  const peers = currentState.devices.filter((device) => device.deviceId !== currentState.settings.deviceId);
  const groups = peerGroups(peers);
  if (groups.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.className = 'empty';
    cell.textContent = '暂无其他设备';
    row.append(cell);
    devicesEl.append(row);
    return;
  }

  for (const group of groups) {
    const rule = ruleForGroup(group);
    const row = document.createElement('tr');
    const ip = document.createElement('td');
    const deviceLabel = group.ip || '未知 IP';
    ip.textContent = deviceLabel;
    ip.title = group.ip || group.key;

    const send = document.createElement('td');
    const sendBox = document.createElement('input');
    sendBox.type = 'checkbox';
    sendBox.checked = rule.send;
    sendBox.indeterminate = rule.sendMixed;
    sendBox.title = rule.sendMixed ? '部分设备已关闭发送' : '';
    sendBox.addEventListener('change', () => window.clipboardSync.updateRule(group.key, 'send', sendBox.checked));
    send.append(sendBox);

    const receive = document.createElement('td');
    const receiveBox = document.createElement('input');
    receiveBox.type = 'checkbox';
    receiveBox.checked = rule.receive;
    receiveBox.indeterminate = rule.receiveMixed;
    receiveBox.title = rule.receiveMixed ? '部分设备已关闭接收' : '';
    receiveBox.addEventListener('change', () => window.clipboardSync.updateRule(group.key, 'receive', receiveBox.checked));
    receive.append(receiveBox);

    row.append(ip, send, receive);
    devicesEl.append(row);
  }
}

function ignoredSourcePatterns() {
  return ignoredSourcePatternsEl.value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderRecentSources() {
  recentSourcesEl.replaceChildren();
  const sources = currentState.recentSources || [];
  if (sources.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'recent-source-empty';
    empty.textContent = '暂无最近复制来源';
    recentSourcesEl.append(empty);
    return;
  }

  for (const source of sources) {
    const row = document.createElement('div');
    row.className = 'recent-source-row';

    const text = document.createElement('div');
    text.className = 'recent-source-text';
    const label = document.createElement('div');
    label.className = 'recent-source-label';
    label.textContent = source.label || source.pattern;
    const detail = document.createElement('div');
    detail.className = 'recent-source-detail';
    detail.textContent = source.detail || source.pattern || '';
    text.append(label, detail);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'source-add-button';
    add.textContent = source.unknown ? '忽略' : '加入';
    add.disabled = !source.pattern && !source.unknown;
    add.addEventListener('click', () => {
      if (source.unknown) {
        ignoreUnknownSourceEl.checked = true;
        window.clipboardSync.updateSetting({ ignoreUnknownSource: true });
        return;
      }
      const existing = ignoredSourcePatterns();
      const exists = existing.some((item) => item.toLowerCase() === source.pattern.toLowerCase());
      const next = exists ? existing : [...existing, source.pattern];
      ignoredSourcePatternsEl.value = next.join('\n');
      window.clipboardSync.updateSetting({ ignoredSourcePatterns: next });
    });

    row.append(text, add);
    recentSourcesEl.append(row);
  }
}

function render(state) {
  currentState = state;
  statusEl.textContent = statusText(state);
  statusEl.title = state.status?.message || statusLabel(state);
  pauseSendEl.checked = state.settings.pauseSend;
  pauseReceiveEl.checked = state.settings.pauseReceive;
  autoLaunchEl.checked = state.settings.autoLaunch;
  hubUrlEl.value = state.settings.hubUrl;
  tokenEl.value = '';
  tokenEl.placeholder = state.settings.hasToken ? '已配置，留空不改' : '未配置，可留空';
  ignoreUnknownSourceEl.checked = Boolean(state.settings.ignoreUnknownSource);
  ignoredSourcePatternsEl.value = (state.settings.ignoredSourcePatterns || []).join('\n');
  if (!state.settings.hubUrl) {
    connectionEl.open = true;
  }
  renderRecentSources();
  renderDevices();
}

pauseSendEl.addEventListener('change', () => window.clipboardSync.updateSetting({ pauseSend: pauseSendEl.checked }));
pauseReceiveEl.addEventListener('change', () =>
  window.clipboardSync.updateSetting({ pauseReceive: pauseReceiveEl.checked })
);
autoLaunchEl.addEventListener('change', () => window.clipboardSync.updateSetting({ autoLaunch: autoLaunchEl.checked }));
if (window.clipboardSync.platform !== 'darwin') {
  historyButtonEl.hidden = false;
  historyButtonEl.addEventListener('click', () => window.clipboardSync.showHistory());
}
document.querySelector('#saveConnection').addEventListener('click', () => {
  const patch = { hubUrl: hubUrlEl.value.trim() };
  if (tokenEl.value.length > 0) {
    patch.token = tokenEl.value;
  }
  window.clipboardSync.updateSetting(patch);
});
saveIgnoreEl.addEventListener('click', () => {
  window.clipboardSync.updateSetting({
    ignoreUnknownSource: ignoreUnknownSourceEl.checked,
    ignoredSourcePatterns: ignoredSourcePatterns()
  });
});
document.querySelector('#refresh').addEventListener('click', () => window.clipboardSync.refresh());
document.querySelector('#quit').addEventListener('click', () => window.clipboardSync.quit());

window.clipboardSync.onState(render);
window.clipboardSync.getState().then(render);
