import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEVICE_SETTINGS_MENU_LABEL,
  historyMenuEntryForPlatform,
  historyMenuIconForEvent,
  languageMenuEntry
} from '../src/client/tray-menu-template.js';

test('device settings menu label describes the send receive table action', () => {
  assert.equal(DEVICE_SETTINGS_MENU_LABEL, '收发设置');
});

test('historyMenuEntryForPlatform keeps Mac history as a submenu with a window entry first', () => {
  const menu = historyMenuEntryForPlatform('darwin', () => [{ label: '192.0.2.20 hello' }], () => {});

  assert.equal(menu.label, '历史');
  assert.deepEqual(menu.submenu.map((item) => item.label || item.type), ['主窗口', 'separator', '192.0.2.20 hello']);
  assert.equal('click' in menu, false);
});

test('historyMenuEntryForPlatform keeps Windows history as a popup action', () => {
  const click = () => {};
  const menu = historyMenuEntryForPlatform('win32', () => [{ label: '192.0.2.20 hello' }], click);

  assert.equal(menu.label, '历史');
  assert.equal(menu.click, click);
  assert.equal('submenu' in menu, false);
});

test('languageMenuEntry switches between Chinese and English from the tray menu', () => {
  const calls = [];
  const menu = languageMenuEntry('en', (language) => calls.push(language));

  assert.equal(menu.label, 'Language');
  assert.deepEqual(
    menu.submenu.map((item) => ({ label: item.label, type: item.type, checked: item.checked })),
    [
      { label: '简体中文', type: 'radio', checked: false },
      { label: 'English', type: 'radio', checked: true }
    ]
  );

  menu.submenu[0].click();
  assert.deepEqual(calls, ['zh-CN']);
});

test('historyMenuIconForEvent creates a real thumbnail icon for image history menu items', () => {
  const resizedIcon = {
    setTemplateImage(value) {
      this.template = value;
    }
  };
  const calls = [];
  const icon = historyMenuIconForEvent(
    {
      contentType: 'image/png',
      imagePreviewSrc: 'data:image/png;base64,aW1hZ2U='
    },
    {
      createFromDataURL(value) {
        calls.push(['createFromDataURL', value]);
        return {
          isEmpty: () => false,
          resize(options) {
            calls.push(['resize', options]);
            return resizedIcon;
          }
        };
      }
    }
  );

  assert.equal(icon, resizedIcon);
  assert.deepEqual(calls, [
    ['createFromDataURL', 'data:image/png;base64,aW1hZ2U='],
    ['resize', { width: 18, height: 18, quality: 'good' }]
  ]);
  assert.equal(resizedIcon.template, false);
});

test('historyMenuIconForEvent reuses cached native menu icons', () => {
  let decodeCount = 0;
  const cache = new Map();
  const first = historyMenuIconForEvent(
    {
      id: 'image-menu-cached',
      contentType: 'image/png',
      imagePreviewSrc: 'data:image/png;base64,aW1hZ2U='
    },
    {
      createFromDataURL() {
        decodeCount += 1;
        return {
          isEmpty: () => false,
          resize: () => ({ setTemplateImage() {} })
        };
      }
    },
    18,
    cache
  );
  const second = historyMenuIconForEvent(
    {
      id: 'image-menu-cached',
      contentType: 'image/png',
      imagePreviewSrc: 'data:image/png;base64,aW1hZ2U='
    },
    {
      createFromDataURL() {
        decodeCount += 1;
        return {
          isEmpty: () => false,
          resize: () => ({ setTemplateImage() {} })
        };
      }
    },
    18,
    cache
  );

  assert.equal(second, first);
  assert.equal(decodeCount, 1);
});

test('historyMenuIconForEvent leaves text and placeholder image history without an icon', () => {
  assert.equal(
    historyMenuIconForEvent(
      {
        contentType: 'text/plain',
        imagePreviewSrc: 'data:image/png;base64,aW1hZ2U='
      },
      { createFromDataURL: () => ({ isEmpty: () => false }) }
    ),
    undefined
  );
  assert.equal(historyMenuIconForEvent({ contentType: 'image/png', imagePreviewSrc: null }, {}), undefined);
});
