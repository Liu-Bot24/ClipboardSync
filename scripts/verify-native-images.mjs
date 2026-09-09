import assert from 'node:assert/strict';
import { app, clipboard as systemClipboard, nativeImage } from 'electron';
import { ElectronClipboardAdapter } from '../src/client/clipboard-adapter.js';
import { imageFingerprint } from '../src/client/image-fingerprint.js';
import { uiHistoryEvent } from '../src/client/ui-history-event.js';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const userData = fileURLToPath(new URL('../.local/native-image-verification/', import.meta.url));
mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const timeout = setTimeout(() => { console.error('Native verification timed out'); app.exit(1); }, 15_000);
app.whenReady().then(() => {
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = i % 253; pixels[i + 1] = 90; pixels[i + 2] = 200; pixels[i + 3] = 255;
  }
  const image = nativeImage.createFromBitmap(pixels, { width: 16, height: 16 });
  assert.equal(image.isEmpty(), false);
  let current = image;
  const useSystemClipboard = process.argv.includes('--system-clipboard');
  const clipboard = useSystemClipboard ? systemClipboard : {
    availableFormats: () => ['image/png'], readImage: () => current,
    // Exercise the real codecs while leaving the operating-system clipboard untouched.
    writeImage: (value) => { current = nativeImage.createFromBuffer(value.toPNG()); }
  };
  const adapter = new ElectronClipboardAdapter({ clipboard });
  const flowFixture = readFileSync(new URL('../src/client/tray-icon.png', import.meta.url));
  for (const [contentType, buffer] of [['image/png', image.toPNG()], ['image/jpeg', image.toJPEG(90)], ['image/png', flowFixture]]) {
    const event = { id: `${contentType}:${buffer.length}`, contentType, encoding: 'base64', content: buffer.toString('base64') };
    const operation = adapter.prepareWrite(event);
    operation.write(); adapter.resetCachedSnapshot();
    assert.equal(operation.matches(adapter.readSnapshot()), true);
    const different = nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 255), { width: 16, height: 16 });
    assert.notEqual(imageFingerprint(current), imageFingerprint(different));
    if (useSystemClipboard) systemClipboard.writeImage(different);
    else current = different;
    adapter.resetCachedSnapshot();
    assert.equal(operation.matches(adapter.readSnapshot()), false);
    assert.match(uiHistoryEvent(event, { nativeImage }).imagePreviewSrc, /^data:image\/png;base64,/);
  }
  console.log(`Native PNG/JPEG write preparation, re-encoding, pixel confirmation, wrong-image rejection and thumbnails passed, including the core-flow PNG fixture (${useSystemClipboard ? 'system clipboard' : 'in-memory clipboard'}).`);
  clearTimeout(timeout);
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  app.exit(1);
});
