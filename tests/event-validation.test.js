import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ValidationError, normalizeClipboardEvent } from '../src/event-validation.js';

test('normalizeClipboardEvent accepts text and computes content metadata', () => {
  const event = normalizeClipboardEvent(
    {
      type: 'clipboard.update',
      contentType: 'text/plain',
      encoding: 'utf8',
      content: 'hello from PC',
      targetDeviceIds: ['macbook', 'mac-mini']
    },
    {
      maxPayloadBytes: 1024,
      sourceDeviceId: 'main-pc'
    }
  );

  assert.equal(event.type, 'clipboard.update');
  assert.equal(event.sourceDeviceId, 'main-pc');
  assert.equal(event.contentType, 'text/plain');
  assert.equal(event.encoding, 'utf8');
  assert.equal(event.content, 'hello from PC');
  assert.equal(event.byteLength, 13);
  assert.equal(event.sha256.length, 64);
  assert.deepEqual(event.targetDeviceIds, ['macbook', 'mac-mini']);
});

test('normalizeClipboardEvent accepts base64 images and measures decoded bytes', () => {
  const event = normalizeClipboardEvent(
    {
      type: 'clipboard.update',
      contentType: 'image/png',
      encoding: 'base64',
      content: Buffer.from([1, 2, 3, 4]).toString('base64')
    },
    {
      maxPayloadBytes: 1024,
      sourceDeviceId: 'macbook'
    }
  );

  assert.equal(event.contentType, 'image/png');
  assert.equal(event.byteLength, 4);
});

test('normalizeClipboardEvent rejects unsupported content types', () => {
  assert.throws(
    () =>
      normalizeClipboardEvent(
        {
          type: 'clipboard.update',
          contentType: 'application/pdf',
          encoding: 'base64',
          content: 'AA=='
        },
        {
          maxPayloadBytes: 1024,
          sourceDeviceId: 'macbook'
        }
      ),
    ValidationError
  );
});

test('normalizeClipboardEvent rejects oversized payloads', () => {
  assert.throws(
    () =>
      normalizeClipboardEvent(
        {
          type: 'clipboard.update',
          contentType: 'text/plain',
          encoding: 'utf8',
          content: '12345'
        },
        {
          maxPayloadBytes: 4,
          sourceDeviceId: 'macbook'
        }
      ),
    /payload exceeds/
  );
});

test('normalizeClipboardEvent rejects too many target devices', () => {
  assert.throws(
    () =>
      normalizeClipboardEvent(
        {
          type: 'clipboard.update',
          contentType: 'text/plain',
          encoding: 'utf8',
          content: 'hello',
          targetDeviceIds: Array.from({ length: 129 }, (_, index) => `device-${index}`)
        },
        {
          maxPayloadBytes: 1024,
          maxTargetDeviceIds: 128,
          sourceDeviceId: 'macbook'
        }
      ),
    /targetDeviceIds exceeds/
  );
});
