import assert from 'node:assert/strict';
import { test } from 'node:test';

import { historyEventForSelection } from '../src/client/history-selection.js';

const events = [
  { id: 'broadcast', sourceDeviceId: 'main-pc', sourceIp: '192.0.2.20' },
  { id: 'hidden-by-rule', sourceDeviceId: 'mac-mini', sourceIp: '192.0.2.21' },
  { id: 'hidden-by-target', sourceDeviceId: 'main-pc', sourceIp: '192.0.2.20', targetDeviceIds: ['other-device'] },
  { id: 'visible-targeted', sourceDeviceId: 'main-pc', sourceIp: '192.0.2.20', targetDeviceIds: ['macbook'] }
];

test('historyEventForSelection returns only events visible under current receive rules', () => {
  const settings = {
    deviceId: 'macbook',
    deviceRules: {
      'mac-mini': { send: true, receive: false }
    }
  };

  assert.equal(historyEventForSelection(events, settings, 'broadcast')?.id, 'broadcast');
  assert.equal(historyEventForSelection(events, settings, 'visible-targeted')?.id, 'visible-targeted');
  assert.equal(historyEventForSelection(events, settings, 'hidden-by-rule'), null);
  assert.equal(historyEventForSelection(events, settings, 'hidden-by-target'), null);
});

test('historyEventForSelection respects the visible history limit', () => {
  const manyEvents = Array.from({ length: 20 }, (_, index) => ({
    id: `event-${index}`,
    sourceDeviceId: 'main-pc',
    sourceIp: '192.0.2.20'
  }));

  assert.equal(historyEventForSelection(manyEvents, { deviceId: 'macbook', deviceRules: {} }, 'event-19', 15)?.id, 'event-19');
  assert.equal(historyEventForSelection(manyEvents, { deviceId: 'macbook', deviceRules: {} }, 'event-0', 15), null);
});
