import assert from 'node:assert/strict';
import { test } from 'node:test';

import { popupPosition } from '../src/client/window-position.js';

const primaryDisplay = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 }
};

const secondaryDisplay = {
  bounds: { x: -1280, y: 0, width: 1280, height: 1024 },
  workArea: { x: -1280, y: 0, width: 1280, height: 984 }
};

test('popupPosition keeps Windows popups fully inside the primary work area', () => {
  assert.deepEqual(
    popupPosition({
      platform: 'win32',
      trayBounds: { x: -1270, y: 900, width: 24, height: 24 },
      displays: [primaryDisplay, secondaryDisplay],
      primaryDisplay,
      width: 420,
      height: 440
    }),
    { x: 1492, y: 592 }
  );
});

test('popupPosition clamps Mac tray popups inside the matching display', () => {
  assert.deepEqual(
    popupPosition({
      platform: 'darwin',
      trayBounds: { x: 1890, y: 1010, width: 24, height: 24 },
      displays: [primaryDisplay, secondaryDisplay],
      primaryDisplay,
      width: 420,
      height: 440
    }),
    { x: 1492, y: 592 }
  );
});

test('popupPosition uses the tray display for Mac menu bar popups', () => {
  assert.deepEqual(
    popupPosition({
      platform: 'darwin',
      trayBounds: { x: -900, y: 4, width: 24, height: 18 },
      displays: [primaryDisplay, secondaryDisplay],
      primaryDisplay,
      width: 420,
      height: 440
    }),
    { x: -1098, y: 30 }
  );
});
