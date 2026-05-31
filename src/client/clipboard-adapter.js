import { clipboard, nativeImage } from 'electron';

import { ClipboardSnapshotReader } from './clipboard-reader.js';

export class ElectronClipboardAdapter {
  constructor(options = {}) {
    this.reader = options.reader ?? new ClipboardSnapshotReader(options);
  }

  readSnapshot() {
    return this.reader.read(clipboard);
  }

  resetCachedSnapshot() {
    this.reader.resetCache?.();
  }

  writeEvent(event) {
    if (event.contentType === 'text/plain') {
      clipboard.writeText(event.content);
      return;
    }

    const image = nativeImage.createFromBuffer(Buffer.from(event.content, 'base64'));
    if (image.isEmpty()) {
      throw new Error('remote image payload could not be decoded');
    }
    clipboard.writeImage(image);
  }
}
