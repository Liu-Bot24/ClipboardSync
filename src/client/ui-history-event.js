import { eventPreview } from './clipboard-content.js';

const MAX_INLINE_IMAGE_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_THUMBNAIL_EDGE = 160;

function thumbnailSrc(buffer, nativeImage) {
  if (!nativeImage) {
    return undefined;
  }
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    return undefined;
  }
  const size = image.getSize();
  const scale = Math.min(MAX_THUMBNAIL_EDGE / Math.max(1, size.width), MAX_THUMBNAIL_EDGE / Math.max(1, size.height), 1);
  const preview =
    scale < 1
      ? image.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: 'good'
        })
      : image;
  return `data:image/png;base64,${Buffer.from(preview.toPNG()).toString('base64')}`;
}

function hasImageSignature(buffer, contentType) {
  if (contentType === 'image/png') {
    return buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  }
  if (contentType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (contentType === 'image/webp') {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

function imagePreviewSrc(event, options = {}) {
  if (!event.contentType?.startsWith('image/') || event.encoding !== 'base64' || typeof event.content !== 'string') {
    return null;
  }

  const buffer = Buffer.from(event.content, 'base64');
  const thumbnail = thumbnailSrc(buffer, options.nativeImage);
  if (thumbnail !== undefined) {
    return thumbnail;
  }

  if (buffer.length > MAX_INLINE_IMAGE_PREVIEW_BYTES) {
    return null;
  }
  if (!hasImageSignature(buffer, event.contentType)) {
    return null;
  }
  return `data:${event.contentType};base64,${event.content}`;
}

export function uiHistoryEvent(event, options = {}) {
  return {
    id: event.id,
    sourceDeviceId: event.sourceDeviceId,
    sourceIp: event.sourceIp,
    contentType: event.contentType,
    preview: eventPreview(event),
    imagePreviewSrc: imagePreviewSrc(event, options)
  };
}
