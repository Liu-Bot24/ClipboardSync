let currentState = null;
let currentLanguage = 'zh-CN';
const i18n = window.ClipboardSyncI18n;
const historyEl = document.querySelector('#history');
const historyStatusEl = document.querySelector('#historyStatus');
const historyAlwaysOnTopEl = document.querySelector('#historyAlwaysOnTop');
const clearHistoryEl = document.querySelector('#clearHistory');

function tr(key, params) {
  return i18n?.t ? i18n.t(currentLanguage, key, params) : key;
}

function normalizeLanguage(value) {
  return i18n?.normalizeLanguage ? i18n.normalizeLanguage(value) : 'zh-CN';
}

function translatedElements(selector) {
  return typeof document.querySelectorAll === 'function' ? [...document.querySelectorAll(selector)] : [];
}

function applyTranslations() {
  document.documentElement.lang = currentLanguage === 'en' ? 'en' : 'zh-CN';
  for (const element of translatedElements('[data-i18n]')) {
    element.textContent = tr(element.dataset.i18n);
  }
  for (const element of translatedElements('[data-i18n-title]')) {
    element.title = tr(element.dataset.i18nTitle);
  }
  for (const element of translatedElements('[data-i18n-aria-label]')) {
    element.setAttribute('aria-label', tr(element.dataset.i18nAriaLabel));
  }
}

function setHistoryStatus(text) {
  if (historyStatusEl) {
    historyStatusEl.textContent = text;
  }
}

function historyLimitLabel() {
  const limit = Number(currentState?.settings?.historyDisplayLimit);
  return tr('history.latest', { limit: Number.isSafeInteger(limit) && limit > 0 ? limit : 30 });
}

function renderHistory() {
  historyEl.replaceChildren();
  if (!currentState || currentState.history.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty history-empty';
    empty.textContent = tr('history.none');
    historyEl.append(empty);
    return;
  }

  for (const event of currentState.history) {
    const button = document.createElement('button');
    button.className = 'history-item';
    button.addEventListener('click', async () => {
      const result = await window.clipboardSync.applyHistory(event.id);
      if (result?.pasted) {
        setHistoryStatus(tr('history.pasted'));
      } else if (result?.permissionRequired) {
        setHistoryStatus(tr('history.permissionRequired'));
      } else if (result === false || result?.applied === false) {
        setHistoryStatus(tr('history.notFound'));
      } else {
        setHistoryStatus(tr('history.copied'));
      }
    });

    const ip = document.createElement('div');
    ip.className = 'history-ip';
    const sourceLabel = event.sourceIp || event.sourceDeviceId || tr('devices.unknownIp');
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
        image.alt = tr('history.imageAlt');
        media.append(image);
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'image-placeholder';
        placeholder.textContent = event.preview && event.preview !== '图片' ? event.preview : tr('history.image');
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
  currentLanguage = normalizeLanguage(state.settings?.language);
  applyTranslations();
  setHistoryStatus(historyLimitLabel());
  renderSettings();
  renderHistory();
});
window.clipboardSync.getState().then((state) => {
  currentState = state;
  currentLanguage = normalizeLanguage(state.settings?.language);
  applyTranslations();
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
    setHistoryStatus(tr('history.clearFailed'));
    return;
  }
  currentState = {
    ...(currentState || {}),
    history: []
  };
  renderHistory();
  setHistoryStatus(tr('history.cleared'));
});
