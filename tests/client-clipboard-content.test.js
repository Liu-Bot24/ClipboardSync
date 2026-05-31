import assert from 'node:assert/strict';
import { test } from 'node:test';

import { eventPreview, hashEventPayload, imageSnapshot, textSnapshot } from '../src/client/clipboard-content.js';

test('textSnapshot creates utf8 clipboard update payload with stable hash', () => {
  const snapshot = textSnapshot('hello');

  assert.equal(snapshot.type, 'clipboard.update');
  assert.equal(snapshot.contentType, 'text/plain');
  assert.equal(snapshot.encoding, 'utf8');
  assert.equal(snapshot.content, 'hello');
  assert.equal(snapshot.byteLength, 5);
  assert.equal(snapshot.hash, hashEventPayload(snapshot));
});

test('imageSnapshot creates png base64 clipboard update payload with stable hash', () => {
  const snapshot = imageSnapshot(Buffer.from([1, 2, 3]));

  assert.equal(snapshot.contentType, 'image/png');
  assert.equal(snapshot.encoding, 'base64');
  assert.equal(snapshot.content, 'AQID');
  assert.equal(snapshot.byteLength, 3);
  assert.equal(snapshot.hash, hashEventPayload(snapshot));
});

test('eventPreview keeps menu labels compact', () => {
  assert.equal(eventPreview({ contentType: 'text/plain', content: 'one\n two   three' }), 'one two three');
  assert.equal(eventPreview({ contentType: 'image/png', content: 'AQID', byteLength: 3 }), '图片');
});
