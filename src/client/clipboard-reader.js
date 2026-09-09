import { imageSnapshot, textSnapshot } from './clipboard-content.js';
import { imageFingerprint } from './image-fingerprint.js';
import { assertImageDimensions } from './image-limits.js';

const IMAGE_FORMAT_PATTERNS = [
  /^image\//i,
  /png/i,
  /jpeg/i,
  /jpg/i,
  /tiff?/i,
  /bitmap/i,
  /dib/i,
  /public\.(png|jpeg|tiff?)/i,
  /NSPasteboardType(TIFF|PNG)/i
];

const TEXT_ONLY_FORMAT_PATTERNS = [
  /^text\/plain$/i,
  /^text\/html$/i,
  /^text\/rtf$/i,
  /^public\.(utf8-plain-text|utf16-plain-text|plain-text|html|rtf)$/i,
  /^NSStringPboardType$/i,
  /^NSPasteboardTypeString$/i
];

function clipboardFormats(clipboard) {
  if (typeof clipboard.availableFormats !== 'function') {
    return [];
  }
  try {
    return clipboard.availableFormats();
  } catch {
    return [];
  }
}

function formatsContainImage(formats) {
  return formats.some((format) => IMAGE_FORMAT_PATTERNS.some((pattern) => pattern.test(format)));
}

function formatsAreOnlyText(formats) {
  return formats.length > 0 && formats.every((format) => TEXT_ONLY_FORMAT_PATTERNS.some((pattern) => pattern.test(format)));
}

function formatsKey(formats) {
  return formats.slice().sort().join('\n');
}

function clipboardChangeToken(clipboard) {
  if (typeof clipboard?.readChangeToken !== 'function') {
    return undefined;
  }
  try {
    const token = clipboard.readChangeToken();
    return token === undefined || token === null ? undefined : String(token);
  } catch {
    return undefined;
  }
}

export class ClipboardSnapshotReader {
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now());
    this.imageStablePollMs = options.imageStablePollMs ?? 1_500;
    this.lastImage = null;
    this.lastText = null;
  }

  resetCache() {
    this.lastImage = null;
    this.lastText = null;
  }

  readText(clipboard) {
    const text = clipboard.readText();
    if (text.length === 0) return null;
    if (this.lastText?.content !== text) this.lastText = textSnapshot(text);
    return this.lastText;
  }

  read(clipboard) {
    const formats = clipboardFormats(clipboard);
    const hasFormats = formats.length > 0;
    const shouldTryImage = !hasFormats || formatsContainImage(formats) || !formatsAreOnlyText(formats);

    if (!shouldTryImage) {
      this.lastImage = null;
      return this.readText(clipboard);
    }

    const key = formatsKey(formats);
    const changeToken = clipboardChangeToken(clipboard);
    const now = this.now();
    if (
      this.lastImage &&
      this.lastImage.key === key &&
      changeToken !== undefined && this.lastImage.changeToken === changeToken &&
      now - this.lastImage.readAt < this.imageStablePollMs
    ) {
      return this.lastImage.snapshot;
    }

    const snapshot = readImageSnapshot(clipboard, this.lastImage?.snapshot) || this.readText(clipboard);
    if (snapshot?.contentType === 'image/png') {
      this.lastImage = { key, changeToken, readAt: now, snapshot };
    } else {
      this.lastImage = null;
    }
    return snapshot;
  }
}

function readImageSnapshot(clipboard, previous) {
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    if (image.getSize) assertImageDimensions(image.getSize());
    const pixelHash = image.toBitmap && image.getSize ? imageFingerprint(image) : undefined;
    if (pixelHash && previous?.pixelHash === pixelHash) return previous;
    const snapshot = imageSnapshot(image.toPNG());
    if (pixelHash) snapshot.pixelHash = pixelHash;
    return snapshot;
  }
  return null;
}

export function readClipboardSnapshot(clipboard, options) {
  return new ClipboardSnapshotReader(options).read(clipboard);
}
