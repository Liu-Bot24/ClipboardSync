import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildTargetDeviceIds,
  filterVisibleHistory,
  isReceiveAllowed,
  mergeDeviceRules,
  mergeDeviceRulesByIp,
  updateDeviceRule
} from '../src/client/policy.js';

const devices = [
  { deviceId: 'macbook', ip: '192.0.2.10' },
  { deviceId: 'main-pc', ip: '192.0.2.20' },
  { deviceId: 'mac-mini', ip: '192.0.2.30' }
];

test('buildTargetDeviceIds broadcasts to the group when every visible device is send-enabled', () => {
  assert.equal(buildTargetDeviceIds(devices, { deviceRules: {} }, 'macbook'), undefined);
});

test('buildTargetDeviceIds limits sends when a peer IP row is unchecked', () => {
  assert.deepEqual(
    buildTargetDeviceIds(
      devices,
      {
        deviceRules: {
          'main-pc': { send: true, receive: true },
          'mac-mini': { send: false, receive: true }
        }
      },
      'macbook'
    ),
    ['main-pc']
  );
});

test('buildTargetDeviceIds does not broadcast while send restrictions exist but devices are unknown', () => {
  assert.deepEqual(
    buildTargetDeviceIds(
      [],
      {
        deviceRules: {
          'mac-mini': { send: false, receive: true }
        }
      },
      'macbook'
    ),
    []
  );
});

test('buildTargetDeviceIds includes allowed devices remembered from rules even when they are offline', () => {
  assert.deepEqual(
    buildTargetDeviceIds(
      [{ deviceId: 'macbook', ip: '192.0.2.10' }],
      {
        deviceRules: {
          'main-pc': { send: true, receive: true },
          'mac-mini': { send: false, receive: true }
        }
      },
      'macbook'
    ),
    ['main-pc']
  );
});

test('buildTargetDeviceIds never targets the local device through remembered rules', () => {
  assert.deepEqual(
    buildTargetDeviceIds(
      [
        { deviceId: 'macbook', ip: '192.0.2.10' },
        { deviceId: 'mac-mini', ip: '192.0.2.30' }
      ],
      {
        deviceRules: {
          macbook: { send: true, receive: true },
          'mac-mini': { send: false, receive: true }
        }
      },
      'macbook'
    ),
    []
  );
});

test('isReceiveAllowed defaults to receiving and blocks unchecked source rows', () => {
  assert.equal(isReceiveAllowed({ sourceDeviceId: 'main-pc', sourceIp: '192.0.2.20' }, { deviceRules: {} }), true);
  assert.equal(
    isReceiveAllowed(
      { sourceDeviceId: 'main-pc', sourceIp: '192.0.2.20' },
      { deviceRules: { 'main-pc': { send: true, receive: false } } }
    ),
    false
  );
});

test('isReceiveAllowed rejects events targeted to a different device', () => {
  assert.equal(
    isReceiveAllowed(
      { sourceDeviceId: 'main-pc', sourceIp: '192.0.2.20', targetDeviceIds: ['macbook'] },
      { deviceId: 'mac-mini', deviceRules: {} }
    ),
    false
  );
  assert.equal(
    isReceiveAllowed(
      { sourceDeviceId: 'main-pc', sourceIp: '192.0.2.20', targetDeviceIds: ['macbook'] },
      { deviceId: 'macbook', deviceRules: {} }
    ),
    true
  );
});

test('filterVisibleHistory returns newest receive-allowed events up to the menu limit', () => {
  const events = Array.from({ length: 20 }, (_, index) => ({
    id: `event-${index}`,
    sourceDeviceId: index % 2 === 0 ? 'main-pc' : 'mac-mini',
    sourceIp: index % 2 === 0 ? '192.0.2.20' : '192.0.2.30',
    content: String(index)
  }));

  const visible = filterVisibleHistory(
    events,
    { deviceRules: { 'mac-mini': { send: true, receive: false } } },
    5
  );

  assert.deepEqual(
    visible.map((event) => event.id),
    ['event-18', 'event-16', 'event-14', 'event-12', 'event-10']
  );
});

test('filterVisibleHistory hides targeted events for other devices but keeps own sent events', () => {
  const events = [
    { id: 'broadcast', sourceDeviceId: 'main-pc', sourceIp: '192.0.2.20', content: 'all' },
    {
      id: 'for-macbook',
      sourceDeviceId: 'main-pc',
      sourceIp: '192.0.2.20',
      targetDeviceIds: ['macbook'],
      content: 'macbook only'
    },
    {
      id: 'own-sent',
      sourceDeviceId: 'mac-mini',
      sourceIp: '192.0.2.30',
      targetDeviceIds: ['macbook'],
      content: 'sent by mac mini'
    }
  ];

  assert.deepEqual(
    filterVisibleHistory(events, { deviceId: 'mac-mini', deviceRules: {} }, 10).map((event) => event.id),
    ['own-sent', 'broadcast']
  );
});

test('mergeDeviceRules carries IP rules to a reinstalled device id', () => {
  assert.deepEqual(
    mergeDeviceRules(
      {},
      {
        '192.0.2.20': { send: false, receive: true }
      },
      [{ deviceId: 'main-pc-new-id', ip: '192.0.2.20' }]
    ),
    {
      'main-pc-new-id': { send: false, receive: true }
    }
  );
});

test('updateDeviceRule persists by device id and IP without turning IPs into target ids', () => {
  const patch = updateDeviceRule(
    { deviceRules: {}, deviceRulesByIp: {} },
    [{ deviceId: 'main-pc', ip: '192.0.2.20' }],
    'main-pc',
    'send',
    false
  );

  assert.deepEqual(patch, {
    deviceRules: { 'main-pc': { send: false, receive: true } },
    deviceRulesByIp: { '192.0.2.20': { send: false, receive: true } }
  });
  assert.deepEqual(
    buildTargetDeviceIds(
      [{ deviceId: 'macbook', ip: '192.0.2.10' }],
      { deviceRules: {}, deviceRulesByIp: patch.deviceRulesByIp },
      'macbook'
    ),
    []
  );
});

test('updateDeviceRule applies IP row rules to every current device on that IP', () => {
  const patch = updateDeviceRule(
    { deviceRules: {}, deviceRulesByIp: {} },
    [
      { deviceId: 'main-pc-installed', ip: '192.0.2.20' },
      { deviceId: 'main-pc-portable', ip: '192.0.2.20' },
      { deviceId: 'mac-mini', ip: '192.0.2.30' }
    ],
    '192.0.2.20',
    'receive',
    false
  );

  assert.deepEqual(patch, {
    deviceRules: {
      'main-pc-installed': { send: true, receive: false },
      'main-pc-portable': { send: true, receive: false }
    },
    deviceRulesByIp: { '192.0.2.20': { send: true, receive: false } }
  });
});

test('updateDeviceRule preserves each device other checkbox state when editing an IP row', () => {
  const patch = updateDeviceRule(
    {
      deviceRules: {
        'main-pc-installed': { send: false, receive: true },
        'main-pc-portable': { send: true, receive: true }
      },
      deviceRulesByIp: {}
    },
    [
      { deviceId: 'main-pc-installed', ip: '192.0.2.20' },
      { deviceId: 'main-pc-portable', ip: '192.0.2.20' }
    ],
    '192.0.2.20',
    'receive',
    false
  );

  assert.deepEqual(patch.deviceRules['main-pc-installed'], { send: false, receive: false });
  assert.deepEqual(patch.deviceRules['main-pc-portable'], { send: true, receive: false });
  assert.deepEqual(patch.deviceRulesByIp['192.0.2.20'], { receive: false });
});

test('buildTargetDeviceIds never treats legacy IP rules as target device IDs', () => {
  assert.deepEqual(
    buildTargetDeviceIds(
      [{ deviceId: 'macbook', ip: '192.0.2.10' }],
      { deviceRules: { '192.0.2.20': { send: true, receive: true }, 'mac-mini': { send: false, receive: true } } },
      'macbook'
    ),
    []
  );
});

test('buildTargetDeviceIds never treats IPv6 rules as target device IDs', () => {
  assert.deepEqual(
    buildTargetDeviceIds(
      [{ deviceId: 'macbook', ip: '192.0.2.10' }],
      { deviceRules: { 'fe80::1': { send: true, receive: true }, 'mac-mini': { send: false, receive: true } } },
      'macbook'
    ),
    []
  );
});

test('updateDeviceRule applies IPv6 row rules to matching current devices', () => {
  const patch = updateDeviceRule(
    { deviceRules: {}, deviceRulesByIp: {} },
    [{ deviceId: 'ipv6-device', ip: 'fe80::1' }],
    'fe80::1',
    'send',
    false
  );

  assert.deepEqual(patch, {
    deviceRules: { 'ipv6-device': { send: false, receive: true } },
    deviceRulesByIp: { 'fe80::1': { send: false, receive: true } }
  });
});

test('mergeDeviceRulesByIp preserves remembered IP preferences', () => {
  assert.deepEqual(
    mergeDeviceRulesByIp(
      { '192.0.2.20': { send: false, receive: true } },
      [{ deviceId: 'main-pc-new-id', ip: '192.0.2.20' }],
      {}
    ),
    { '192.0.2.20': { send: false, receive: true } }
  );
});

test('mergeDeviceRulesByIp does not invent a single IP send rule from mixed device rules', () => {
  assert.deepEqual(
    mergeDeviceRulesByIp(
      {},
      [
        { deviceId: 'main-pc-installed', ip: '192.0.2.20' },
        { deviceId: 'main-pc-portable', ip: '192.0.2.20' }
      ],
      {
        'main-pc-installed': { send: false, receive: true },
        'main-pc-portable': { send: true, receive: true }
      }
    ),
    { '192.0.2.20': { receive: true } }
  );
});

test('four-device IP matrix sends only to allowed device ids and filters receive by source IP', () => {
  const groupDevices = [
    { deviceId: 'macbook', ip: '192.0.2.10' },
    { deviceId: 'main-pc-installed', ip: '192.0.2.20' },
    { deviceId: 'main-pc-portable', ip: '192.0.2.20' },
    { deviceId: 'mac-mini', ip: '192.0.2.21' },
    { deviceId: 'mini-pc', ip: '192.0.2.22' }
  ];
  const settings = {
    deviceId: 'macbook',
    deviceRules: {
      'mac-mini': { send: true, receive: true }
    },
    deviceRulesByIp: {
      '192.0.2.20': { send: false, receive: true },
      '192.0.2.22': { send: true, receive: false }
    }
  };

  assert.deepEqual(buildTargetDeviceIds(groupDevices, settings, 'macbook'), ['mac-mini', 'mini-pc']);
  assert.equal(isReceiveAllowed({ sourceDeviceId: 'main-pc-installed', sourceIp: '192.0.2.20' }, settings), true);
  assert.equal(isReceiveAllowed({ sourceDeviceId: 'mini-pc', sourceIp: '192.0.2.22' }, settings), false);
});
