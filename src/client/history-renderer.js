let currentState = null;
const historyEl = document.querySelector('#history');
const historyStatusEl = document.querySelector('#historyStatus');
const historyAlwaysOnTopEl = document.querySelector('#historyAlwaysOnTop');
const clearHistoryEl = document.querySelector('#clearHistory');

function setHistoryStatus(text) {
  if (historyStatusEl) {
    historyStatusEl.textContent = text;
  }
}

function historyLimitLabel() {
  const limit = Number(currentState?.settings?.historyDisplayLimit);
  return `历史 · 最近 ${Number.isSafeInteger(limit) && limit > 0 ? limit : 30} 条`;
}

function renderHistory() {
  historyEl.replaceChildren();
  if (!currentState || currentState.history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty history-empty';
    empty.textContent = '暂无历史';
    historyEl.append(empty);
    return;
  }

  for (const event of currentState.history) {
    const button = document.createElement('button');
    button.className = 'history-item';
    button.addEventListener('click', async () => {
      const result = await window.clipboardSync.applyHistory(event.id);
      if (result?.pasted) {
        setHistoryStatus('已粘贴');
      } else if (result?.permissionRequired) {
        setHistoryStatus('需要辅助功能权限');
      } else if (result === false || result?.applied === false) {
        setHistoryStatus('未找到历史');
      } else {
        setHistoryStatus('已写入剪贴板');
      }
    });

    const ip = document.createElement('div');
    ip.className = 'history-ip';
    const sourceLabel = event.sourceIp || event.sourceDeviceId || '未知 IP';
    ip.textContent = sourceLabel;
    ip.title = sourceLabel;

    const preview = document.createElement('div');
    preview.className = 'history-preview';
    if (event.contentType === 'text/plain') {
      preview.textContent = event.preview;
    } else {
      const media = document.createElement('span');
      media.className = 'history-image-preview';
      if (event.imagePreviewSrc) {
        const image = document.createElement('img');
        image.src = event.imagePreviewSrc;
        image.alt = '图片剪贴板预览';
        media.append(image);
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'image-placeholder';
        placeholder.textContent = event.preview || '图片';
        media.append(placeholder);
      }

      preview.append(media);
    }

    button.append(ip, preview);
    historyEl.append(button);
  }
}

function renderSettings() {
  if (historyAlwaysOnTopEl && currentState?.settings) {
    historyAlwaysOnTopEl.checked = Boolean(currentState.settings.historyAlwaysOnTop);
  }
}

window.clipboardSync.onState((state) => {
  currentState = state;
  setHistoryStatus(historyLimitLabel());
  renderSettings();
  renderHistory();
});
window.clipboardSync.getState().then((state) => {
  currentState = state;
  setHistoryStatus(historyLimitLabel());
  renderSettings();
  renderHistory();
});
document.querySelector('#refreshHistory').addEventListener('click', () => window.clipboardSync.refresh());
historyAlwaysOnTopEl?.addEventListener('change', () =>
  window.clipboardSync.updateSetting({ historyAlwaysOnTop: historyAlwaysOnTopEl.checked })
);
clearHistoryEl?.addEventListener('click', async () => {
  const result = await window.clipboardSync.clearHistory();
  if (result?.cleared === false) {
    setHistoryStatus('清除失败');
    return;
  }
  currentState = {
    ...(currentState || {}),
    history: []
  };
  renderHistory();
  setHistoryStatus('全局历史已清除');
});
