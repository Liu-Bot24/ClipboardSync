import { createHash } from 'node:crypto';

const SUPPORTED_CONTENT_TYPES = new Set(['text/plain', 'image/png', 'image/jpeg', 'image/webp']);
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const DEFAULT_MAX_TARGET_DEVICE_IDS = 128;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function assertDeviceId(deviceId, fieldName) {
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new ValidationError(`${fieldName} must contain 1-64 letters, numbers, dots, underscores, or hyphens`);
  }
}

function decodeContent(content, encoding, contentType) {
  if (typeof content !== 'string') {
    throw new ValidationError('content must be a string');
  }

  if (contentType === 'text/plain') {
    if (encoding !== 'utf8') {
      throw new ValidationError('text/plain events must use utf8 encoding');
    }
    return Buffer.from(content, 'utf8');
  }

  if (encoding !== 'base64') {
    throw new ValidationError(`${contentType} events must use base64 encoding`);
  }

  const buffer = Buffer.from(content, 'base64');
  if (buffer.length === 0 || buffer.toString('base64').replace(/=+$/, '') !== content.replace(/=+$/, '')) {
    throw new ValidationError('content must be valid base64');
  }
  return buffer;
}

function normalizeTargetDeviceIds(targetDeviceIds, maxTargetDeviceIds) {
  if (targetDeviceIds === undefined) {
    return undefined;
  }
  if (!Array.isArray(targetDeviceIds)) {
    throw new ValidationError('targetDeviceIds must be an array');
  }
  if (targetDeviceIds.length > maxTargetDeviceIds) {
    throw new ValidationError(`targetDeviceIds exceeds ${maxTargetDeviceIds} devices`);
  }

  const uniqueIds = [];
  const seen = new Set();
  for (const targetDeviceId of targetDeviceIds) {
    assertDeviceId(targetDeviceId, 'targetDeviceIds[]');
    if (!seen.has(targetDeviceId)) {
      seen.add(targetDeviceId);
      uniqueIds.push(targetDeviceId);
    }
  }
  return uniqueIds;
}

export function normalizeClipboardEvent(input, context) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('message must be an object');
  }
  if (input.type !== 'clipboard.update') {
    throw new ValidationError('type must be clipboard.update');
  }

  assertDeviceId(context?.sourceDeviceId, 'sourceDeviceId');

  const { contentType, encoding, content } = input;
  if (!SUPPORTED_CONTENT_TYPES.has(contentType)) {
    throw new ValidationError(`unsupported contentType: ${contentType}`);
  }

  const decoded = decodeContent(content, encoding, contentType);
  if (decoded.length > context.maxPayloadBytes) {
    throw new ValidationError(`payload exceeds ${context.maxPayloadBytes} bytes`);
  }

  return {
    type: 'clipboard.update',
    sourceDeviceId: context.sourceDeviceId,
    contentType,
    encoding,
    content,
    byteLength: decoded.length,
    sha256: createHash('sha256').update(decoded).digest('hex'),
    targetDeviceIds: normalizeTargetDeviceIds(input.targetDeviceIds, context.maxTargetDeviceIds ?? DEFAULT_MAX_TARGET_DEVICE_IDS)
  };
}
