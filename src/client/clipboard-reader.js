import { imageSnapshot, textSnapshot } from './clipboard-content.js';

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
  }

  resetCache() {
    this.lastImage = null;
  }

  read(clipboard) {
    const formats = clipboardFormats(clipboard);
    const hasFormats = formats.length > 0;
    const shouldTryImage = !hasFormats || formatsContainImage(formats) || !formatsAreOnlyText(formats);

    if (!shouldTryImage) {
      this.lastImage = null;
      return readTextSnapshot(clipboard);
    }

    const key = formatsKey(formats);
    const changeToken = clipboardChangeToken(clipboard);
    const now = this.now();
    if (
      this.lastImage &&
      this.lastImage.key === key &&
      (changeToken === undefined || this.lastImage.changeToken === changeToken) &&
      now - this.lastImage.readAt < this.imageStablePollMs
    ) {
      return this.lastImage.snapshot;
    }

    const snapshot = readImageSnapshot(clipboard) || readTextSnapshot(clipboard);
    if (snapshot?.contentType === 'image/png') {
      this.lastImage = { key, changeToken, readAt: now, snapshot };
    } else {
      this.lastImage = null;
    }
    return snapshot;
  }
}

function readImageSnapshot(clipboard) {
  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    return imageSnapshot(image.toPNG());
  }
  return null;
}

function readTextSnapshot(clipboard) {
  const text = clipboard.readText();
  if (text.length === 0) {
    return null;
  }
  return textSnapshot(text);
}

export function readClipboardSnapshot(clipboard, options) {
  return new ClipboardSnapshotReader(options).read(clipboard);
}
