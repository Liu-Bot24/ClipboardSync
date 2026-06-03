import assert from 'node:assert/strict';
import { test } from 'node:test';

import { uiHistoryEvent } from '../src/client/ui-history-event.js';

test('uiHistoryEvent keeps only preview data needed by the renderer', () => {
  const event = uiHistoryEvent({
    id: 'text-1',
    sourceDeviceId: 'main-pc',
    sourceIp: '192.0.2.20',
    contentType: 'text/plain',
    encoding: 'utf8',
    content: 'secret text copied from another device'
  });

  assert.deepEqual(event, {
    id: 'text-1',
    sourceDeviceId: 'main-pc',
    sourceIp: '192.0.2.20',
    contentType: 'text/plain',
    preview: 'secret text copied from another device',
    imagePreviewSrc: null
  });
  assert.equal('content' in event, false);
});

test('uiHistoryEvent inlines small valid image previews but not large image payloads', () => {
  const smallContent = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP8z8AARQAFAAHeAitJAAAAAElFTkSuQmCC';
  const small = uiHistoryEvent({
    id: 'image-small',
    sourceDeviceId: 'macbook',
    contentType: 'image/png',
    encoding: 'base64',
    content: smallContent,
    byteLength: Buffer.from(smallContent, 'base64').length
  });
  assert.equal(small.imagePreviewSrc, `data:image/png;base64,${smallContent}`);

  const large = uiHistoryEvent({
    id: 'image-large',
    sourceDeviceId: 'macbook',
    contentType: 'image/png',
    encoding: 'base64',
    content: Buffer.alloc(17 * 1024 * 1024).toString('base64'),
    byteLength: 17 * 1024 * 1024
  });
  assert.equal(large.imagePreviewSrc, null);
  assert.equal('content' in large, false);
});

test('uiHistoryEvent uses native thumbnails for larger image history when available', () => {
  const event = uiHistoryEvent(
    {
      id: 'image-thumb',
      sourceDeviceId: 'macbook',
      contentType: 'image/png',
      encoding: 'base64',
      content: Buffer.alloc(17 * 1024 * 1024).toString('base64'),
      byteLength: 17 * 1024 * 1024
    },
    {
      nativeImage: {
        createFromBuffer() {
          return {
            isEmpty: () => false,
            getSize: () => ({ width: 400, height: 200 }),
            resize: () => ({
              toPNG: () => Buffer.from('thumb')
            }),
            toPNG: () => Buffer.from('original')
          };
        }
      }
    }
  );

  assert.equal(event.imagePreviewSrc, `data:image/png;base64,${Buffer.from('thumb').toString('base64')}`);
});

test('uiHistoryEvent reuses cached image previews for the same history event', () => {
  let decodeCount = 0;
  const cache = new Map();
  const event = {
    id: 'image-cached',
    sha256: 'same-image-hash',
    sourceDeviceId: 'macbook',
    contentType: 'image/png',
    encoding: 'base64',
    content: Buffer.alloc(17 * 1024 * 1024).toString('base64'),
    byteLength: 17 * 1024 * 1024
  };
  const nativeImage = {
    createFromBuffer() {
      decodeCount += 1;
      return {
        isEmpty: () => false,
        getSize: () => ({ width: 400, height: 200 }),
        resize: () => ({
          toPNG: () => Buffer.from('thumb')
        }),
        toPNG: () => Buffer.from('original')
      };
    }
  };

  const first = uiHistoryEvent(event, { nativeImage, cache });
  const second = uiHistoryEvent(event, { nativeImage, cache });

  assert.equal(first.imagePreviewSrc, `data:image/png;base64,${Buffer.from('thumb').toString('base64')}`);
  assert.deepEqual(second, first);
  assert.equal(decodeCount, 1);
});

test('uiHistoryEvent still exposes valid small image data when native thumbnail decode is unavailable', () => {
  const content = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mP8z8AARQAFAAHeAitJAAAAAElFTkSuQmCC';
  const event = uiHistoryEvent(
    {
      id: 'image-valid-small',
      sourceDeviceId: 'macbook',
      contentType: 'image/png',
      encoding: 'base64',
      content,
      byteLength: Buffer.from(content, 'base64').length
    },
    {
      nativeImage: {
        createFromBuffer() {
          return {
            isEmpty: () => true
          };
        }
      }
    }
  );

  assert.equal(event.imagePreviewSrc, `data:image/png;base64,${content}`);
});

test('uiHistoryEvent falls back to a 图片 placeholder when Electron cannot render an image payload', () => {
  const event = uiHistoryEvent(
    {
      id: 'image-placeholder',
      sourceDeviceId: 'macbook',
      contentType: 'image/png',
      encoding: 'base64',
      content: Buffer.from('not-a-renderable-image').toString('base64'),
      byteLength: 22
    },
    {
      nativeImage: {
        createFromBuffer() {
          return {
            isEmpty: () => true
          };
        }
      }
    }
  );

  assert.equal(event.preview, '图片');
  assert.equal(event.imagePreviewSrc, null);
});
