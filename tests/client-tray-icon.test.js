import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';

import { trayIconForPlatform } from '../src/client/tray-icon.js';

function fakeNativeImage({ emptyPackagedIcon = false } = {}) {
  const calls = [];
  function image(label, empty = false) {
    return {
      label,
      template: false,
      isEmpty: () => empty,
      resize(options) {
        calls.push(['resize', label, options]);
        return image(`${label}:resized`, false);
      },
      setTemplateImage(value) {
        calls.push(['setTemplateImage', this.label, value]);
        this.template = value;
      }
    };
  }
  return {
    calls,
    createFromBuffer() {
      calls.push(['createFromBuffer']);
      return image('packaged', emptyPackagedIcon);
    },
    createFromDataURL() {
      calls.push(['createFromDataURL']);
      return image('fallback', false);
    }
  };
}

test('trayIconForPlatform marks macOS tray icons as template images', () => {
  const nativeImage = fakeNativeImage();
  const icon = trayIconForPlatform({
    nativeImage,
    readFileSync: () => Buffer.from('png'),
    iconPath: '/icon.png',
    platform: 'darwin'
  });

  assert.equal(icon.template, true);
  assert.deepEqual(nativeImage.calls, [
    ['createFromBuffer'],
    ['resize', 'packaged', { width: 18, height: 18 }],
    ['setTemplateImage', 'packaged:resized', true]
  ]);
});

test('trayIconForPlatform keeps Windows tray icons colorful', () => {
  const nativeImage = fakeNativeImage();
  const icon = trayIconForPlatform({
    nativeImage,
    readFileSync: () => Buffer.from('png'),
    iconPath: '/icon.png',
    platform: 'win32'
  });

  assert.equal(icon.template, false);
});

test('trayIconForPlatform falls back when the packaged icon is missing or empty', () => {
  const nativeImage = fakeNativeImage({ emptyPackagedIcon: true });
  const icon = trayIconForPlatform({
    nativeImage,
    readFileSync: () => Buffer.from('png'),
    iconPath: '/icon.png',
    platform: 'darwin'
  });

  assert.equal(icon.template, true);
  assert.deepEqual(
    nativeImage.calls.map((call) => call[0]),
    ['createFromBuffer', 'createFromDataURL', 'resize', 'setTemplateImage']
  );
});

function rgbaPixelsFromPng(buffer) {
  assert.deepEqual(buffer.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let offset = 8;
  let width = 0;
  let height = 0;
  const compressed = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[9], 6, 'tray icon PNG must be RGBA');
    }
    if (type === 'IDAT') {
      compressed.push(data);
    }
    offset += 12 + length;
  }

  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(compressed));
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? pixels[outStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[outStart + x - stride] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[outStart + x - stride - bytesPerPixel] : 0;
      const value = raw[rowStart + x];
      let predictor = 0;
      if (filter === 1) {
        predictor = left;
      } else if (filter === 2) {
        predictor = up;
      } else if (filter === 3) {
        predictor = Math.floor((left + up) / 2);
      } else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else {
        assert.equal(filter, 0, 'unsupported PNG filter');
      }
      pixels[outStart + x] = (value + predictor) & 0xff;
    }
  }
  return pixels;
}

test('packaged Mac menu bar icon is a transparent glyph, not an opaque app tile', () => {
  const pixels = rgbaPixelsFromPng(readFileSync('src/client/tray-icon.png'));
  let transparent = 0;
  let visible = 0;
  for (let offset = 3; offset < pixels.length; offset += 4) {
    if (pixels[offset] === 0) {
      transparent += 1;
    }
    if (pixels[offset] > 0) {
      visible += 1;
    }
  }
  assert.ok(visible > 0, 'tray icon should contain a visible glyph');
  assert.ok(transparent > visible, 'tray icon should not be an opaque rounded-square app icon');
});

test('packaged Windows tray icon keeps the colorful app-style tile', () => {
  const pixels = rgbaPixelsFromPng(readFileSync('src/client/tray-icon-win.png'));
  let opaque = 0;
  let colored = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha > 240) {
      opaque += 1;
    }
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    if (alpha > 180 && Math.max(red, green, blue) - Math.min(red, green, blue) > 30) {
      colored += 1;
    }
  }

  assert.ok(opaque > pixels.length / 8, 'Windows tray icon should keep an opaque visible tile');
  assert.ok(colored > 0, 'Windows tray icon should keep color instead of becoming a template glyph');
});
