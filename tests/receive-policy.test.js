import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeReceiverPolicy, receiverAllowsEvent, receiverPolicyFromSettings } from '../src/receive-policy.js';

test('receiverPolicyFromSettings exports only receive-disabled sources', () => {
  assert.deepEqual(
    receiverPolicyFromSettings({
      deviceRules: {
        'main-pc': { send: true, receive: false },
        'mac-mini': { send: false, receive: true },
        '192.0.2.30': { send: true, receive: false }
      },
      deviceRulesByIp: {
        '192.0.2.40': { send: true, receive: false }
      }
    }),
    {
      allowedSourceDeviceIds: ['mac-mini'],
      blockedSourceDeviceIds: ['main-pc'],
      blockedSourceIps: ['192.0.2.30', '192.0.2.40']
    }
  );
});

test('receiverAllowsEvent blocks by source device id or source IP but keeps own sent history', () => {
  const policy = {
    blockedSourceDeviceIds: ['main-pc'],
    blockedSourceIps: ['192.0.2.30']
  };

  assert.equal(receiverAllowsEvent(policy, { sourceDeviceId: 'main-pc', sourceIp: '192.0.2.20' }, 'macbook'), false);
  assert.equal(receiverAllowsEvent(policy, { sourceDeviceId: 'mac-mini', sourceIp: '192.0.2.30' }, 'macbook'), false);
  assert.equal(receiverAllowsEvent(policy, { sourceDeviceId: 'macbook', sourceIp: '192.0.2.30' }, 'macbook'), true);
  assert.equal(receiverAllowsEvent(policy, { sourceDeviceId: 'mac-mini', sourceIp: '192.0.2.40' }, 'macbook'), true);
});

test('receiverAllowsEvent lets a device-specific allow override a blocked source IP', () => {
  const policy = receiverPolicyFromSettings({
    deviceRules: {
      'main-pc-portable': { send: true, receive: true }
    },
    deviceRulesByIp: {
      '192.0.2.20': { send: true, receive: false }
    }
  });

  assert.deepEqual(policy, {
    allowedSourceDeviceIds: ['main-pc-portable'],
    blockedSourceDeviceIds: [],
    blockedSourceIps: ['192.0.2.20']
  });
  assert.equal(receiverAllowsEvent(policy, { sourceDeviceId: 'main-pc-portable', sourceIp: '192.0.2.20' }, 'macbook'), true);
  assert.equal(receiverAllowsEvent(policy, { sourceDeviceId: 'main-pc-installed', sourceIp: '192.0.2.20' }, 'macbook'), false);
});

test('normalizeReceiverPolicy drops invalid policy values', () => {
  assert.deepEqual(
    normalizeReceiverPolicy({
      allowedSourceDeviceIds: ['allowed-device', 'bad/allowed'],
      blockedSourceDeviceIds: ['valid-device', 'bad/device'],
      blockedSourceIps: ['192.0.2.20', 'bad-ip']
    }),
    {
      allowedSourceDeviceIds: ['allowed-device'],
      blockedSourceDeviceIds: ['valid-device'],
      blockedSourceIps: ['192.0.2.20']
    }
  );
});
