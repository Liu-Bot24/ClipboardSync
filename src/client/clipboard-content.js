import { createHash } from 'node:crypto';

export function decodedBufferForEvent(event) {
  if (event.contentType === 'text/plain') {
    return Buffer.from(event.content, 'utf8');
  }
  return Buffer.from(event.content, 'base64');
}

export function hashEventPayload(event) {
  return createHash('sha256').update(decodedBufferForEvent(event)).digest('hex');
}

export function textSnapshot(text) {
  const content = text ?? '';
  const buffer = Buffer.from(content, 'utf8');
  return {
    type: 'clipboard.update',
    contentType: 'text/plain',
    encoding: 'utf8',
    content,
    byteLength: buffer.length,
    hash: createHash('sha256').update(buffer).digest('hex')
  };
}

export function imageSnapshot(pngBuffer) {
  const buffer = Buffer.from(pngBuffer);
  const content = buffer.toString('base64');
  return {
    type: 'clipboard.update',
    contentType: 'image/png',
    encoding: 'base64',
    content,
    byteLength: buffer.length,
    hash: createHash('sha256').update(buffer).digest('hex')
  };
}

export function eventPreview(event, maxLength = 42) {
  if (event.contentType === 'text/plain') {
    const compact = event.content.replace(/\s+/g, ' ').trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}...` : compact || '(空文本)';
  }
  return '图片';
}
