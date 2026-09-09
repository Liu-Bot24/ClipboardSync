import { clipboard, nativeImage } from 'electron';

import { ClipboardSnapshotReader } from './clipboard-reader.js';
import { imageFingerprint } from './image-fingerprint.js';
import { hashEventPayload } from './clipboard-content.js';
import { assertImageBudget, MAX_IMAGE_BYTES } from './image-limits.js';

export class ElectronClipboardAdapter {
  constructor(options = {}) {
    this.reader = options.reader ?? new ClipboardSnapshotReader(options);
    this.clipboard = options.clipboard ?? clipboard;
    this.nativeImage = options.nativeImage ?? nativeImage;
  }

  readSnapshot() {
    return this.reader.read(this.clipboard);
  }

  resetCachedSnapshot() {
    this.reader.resetCache?.();
  }

  writeEvent(event) {
    this.prepareWrite(event).write();
  }

  prepareWrite(event) {
    if (event.contentType === 'text/plain') {
      const hash = hashEventPayload(event);
      return {
        write: () => this.clipboard.writeText(event.content),
        matches: (snapshot) => snapshot?.contentType === 'text/plain' && snapshot.hash === hash
      };
    }

    if (event.content.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('image exceeds the encoded byte budget');
    const buffer = Buffer.from(event.content, 'base64');
    assertImageBudget(buffer, event.contentType);
    const image = this.nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) {
      throw new Error('remote image payload could not be decoded');
    }
    const pixelHash = imageFingerprint(image);
    return {
      write: () => this.clipboard.writeImage(image),
      matches: (snapshot) => snapshot?.pixelHash === pixelHash
    };
  }
}
