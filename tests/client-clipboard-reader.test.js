import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ClipboardSnapshotReader, readClipboardSnapshot } from '../src/client/clipboard-reader.js';

test('readClipboardSnapshot reads image data even when platform formats are not image MIME strings', () => {
  const snapshot = readClipboardSnapshot({
    readImage: () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from([1, 2, 3])
    }),
    readText: () => 'fallback text'
  });

  assert.equal(snapshot.contentType, 'image/png');
  assert.equal(snapshot.content, 'AQID');
});

test('readClipboardSnapshot falls back to text when image data is empty', () => {
  const snapshot = readClipboardSnapshot({
    readImage: () => ({
      isEmpty: () => true,
      toPNG: () => Buffer.alloc(0)
    }),
    readText: () => 'copied text'
  });

  assert.equal(snapshot.contentType, 'text/plain');
  assert.equal(snapshot.content, 'copied text');
});

test('ClipboardSnapshotReader avoids image reads for text-only clipboards', () => {
  let imageReads = 0;
  const reader = new ClipboardSnapshotReader();

  const snapshot = reader.read({
    availableFormats: () => ['text/plain'],
    readImage: () => {
      imageReads += 1;
      throw new Error('readImage should not be called for text-only clipboard data');
    },
    readText: () => 'copied text'
  });

  assert.equal(snapshot.contentType, 'text/plain');
  assert.equal(snapshot.content, 'copied text');
  assert.equal(imageReads, 0);
});

test('ClipboardSnapshotReader tries images for ambiguous Mac URI-list screenshot formats', () => {
  let imageReads = 0;
  const snapshot = readClipboardSnapshot({
    availableFormats: () => ['text/uri-list'],
    readImage: () => {
      imageReads += 1;
      return {
        isEmpty: () => false,
        toPNG: () => Buffer.from([4, 5, 6])
      };
    },
    readText: () => 'file://screenshot.png'
  });

  assert.equal(snapshot.contentType, 'image/png');
  assert.equal(snapshot.content, 'BAUG');
  assert.equal(imageReads, 1);
});

test('ClipboardSnapshotReader caches stable image snapshots between image polls', () => {
  let now = 1_000;
  let imageReads = 0;
  const reader = new ClipboardSnapshotReader({
    imageStablePollMs: 1_500,
    now: () => now
  });
  const clipboard = {
    availableFormats: () => ['public.tiff'],
    readImage: () => {
      imageReads += 1;
      return {
        isEmpty: () => false,
        toPNG: () => Buffer.from([imageReads])
      };
    },
    readText: () => ''
  };

  const first = reader.read(clipboard);
  now += 250;
  const second = reader.read(clipboard);

  assert.equal(imageReads, 1);
  assert.equal(first.content, second.content);
});

test('ClipboardSnapshotReader refreshes image snapshots after the stable image poll interval', () => {
  let now = 1_000;
  let imageReads = 0;
  const reader = new ClipboardSnapshotReader({
    imageStablePollMs: 1_500,
    now: () => now
  });
  const clipboard = {
    availableFormats: () => ['public.tiff'],
    readImage: () => {
      imageReads += 1;
      return {
        isEmpty: () => false,
        toPNG: () => Buffer.from([imageReads])
      };
    },
    readText: () => ''
  };

  const first = reader.read(clipboard);
  now += 1_501;
  const second = reader.read(clipboard);

  assert.equal(imageReads, 2);
  assert.notEqual(first.content, second.content);
});

test('ClipboardSnapshotReader refreshes image snapshots immediately when the clipboard change token changes', () => {
  let now = 1_000;
  let changeToken = 1;
  let imageReads = 0;
  const reader = new ClipboardSnapshotReader({
    imageStablePollMs: 1_500,
    now: () => now
  });
  const clipboard = {
    availableFormats: () => ['public.tiff'],
    readChangeToken: () => changeToken,
    readImage: () => {
      imageReads += 1;
      return {
        isEmpty: () => false,
        toPNG: () => Buffer.from([imageReads])
      };
    },
    readText: () => ''
  };

  const first = reader.read(clipboard);
  now += 250;
  changeToken += 1;
  const second = reader.read(clipboard);

  assert.equal(imageReads, 2);
  assert.notEqual(first.content, second.content);
});
