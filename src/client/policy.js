import { isIP } from 'node:net';

function deviceRule(settings, device) {
  return settings?.deviceRules?.[device.deviceId] ?? settings?.deviceRulesByIp?.[device.ip] ?? settings?.deviceRules?.[device.ip] ?? {};
}

function eventRule(settings, event) {
  return (
    settings?.deviceRules?.[event.sourceDeviceId] ??
    settings?.deviceRulesByIp?.[event.sourceIp] ??
    settings?.deviceRules?.[event.sourceIp] ??
    {}
  );
}

function isAddressedToThisDevice(event, settings) {
  if (!Array.isArray(event.targetDeviceIds)) {
    return true;
  }
  return event.sourceDeviceId === settings?.deviceId || event.targetDeviceIds.includes(settings?.deviceId);
}

function hasSendRestriction(settings, selfDeviceId) {
  return (
    Object.entries(settings?.deviceRules || {}).some(([deviceId, rule]) => deviceId !== selfDeviceId && rule?.send === false) ||
    Object.values(settings?.deviceRulesByIp || {}).some((rule) => rule?.send === false)
  );
}

function rememberedAllowedTargetIds(settings, visiblePeerIds, selfDeviceId) {
  return Object.entries(settings?.deviceRules || {})
    .filter(
      ([deviceId, rule]) =>
        deviceId !== selfDeviceId && !isIpAddress(deviceId) && !visiblePeerIds.has(deviceId) && rule?.send === true
    )
    .map(([deviceId]) => deviceId);
}

function isIpAddress(value) {
  return typeof value === 'string' && isIP(value) !== 0;
}

function uniformColumnRule(settings, devices, column) {
  const values = devices.map((device) => deviceRule(settings, device)[column] !== false);
  if (values.length === 0 || values.every((value) => value === values[0])) {
    return values[0] ?? true;
  }
  return undefined;
}

export function shouldDeferRestrictedSend(devices, settings, selfDeviceId) {
  const peers = devices.filter((device) => device.deviceId !== selfDeviceId);
  const visiblePeerIds = new Set(peers.map((device) => device.deviceId));
  return (
    peers.length === 0 &&
    hasSendRestriction(settings, selfDeviceId) &&
    rememberedAllowedTargetIds(settings, visiblePeerIds, selfDeviceId).length === 0
  );
}

export function buildTargetDeviceIds(devices, settings, selfDeviceId) {
  const peers = devices.filter((device) => device.deviceId !== selfDeviceId);
  const visiblePeerIds = new Set(peers.map((device) => device.deviceId));
  const hasBlockedPeer = peers.some((device) => deviceRule(settings, device).send === false);
  if (!hasBlockedPeer && !hasSendRestriction(settings, selfDeviceId)) {
    return undefined;
  }

  const targetIds = peers
    .filter((device) => deviceRule(settings, device).send !== false)
    .map((device) => device.deviceId);
  for (const deviceId of rememberedAllowedTargetIds(settings, visiblePeerIds, selfDeviceId)) {
    targetIds.push(deviceId);
  }
  return targetIds;
}

export function isReceiveAllowed(event, settings) {
  return isAddressedToThisDevice(event, settings) && eventRule(settings, event).receive !== false;
}

export function filterVisibleHistory(events, settings, limit = 15) {
  return events.filter((event) => isReceiveAllowed(event, settings)).slice(-limit).reverse();
}

export function mergeDeviceRulesByIp(existingRulesByIp = {}, devices = [], existingRules = {}) {
  const nextRulesByIp = { ...existingRulesByIp };
  const devicesByIp = new Map();
  for (const device of devices) {
    if (!device.ip) {
      continue;
    }
    if (!devicesByIp.has(device.ip)) {
      devicesByIp.set(device.ip, []);
    }
    devicesByIp.get(device.ip).push(device);
  }

  for (const [ip, ipDevices] of devicesByIp.entries()) {
    const nextRule = { ...(existingRulesByIp[ip] || {}) };
    for (const column of ['send', 'receive']) {
      if (nextRule[column] === undefined) {
        const uniformValue = uniformColumnRule({ deviceRules: existingRules, deviceRulesByIp: existingRulesByIp }, ipDevices, column);
        if (uniformValue !== undefined) {
          nextRule[column] = uniformValue;
        }
      }
    }
    nextRulesByIp[ip] = nextRule;
  }
  return nextRulesByIp;
}

export function mergeDeviceRules(existingRules = {}, existingRulesByIp = {}, devices = []) {
  const nextRules = { ...existingRules };
  for (const device of devices) {
    nextRules[device.deviceId] = {
      send: existingRules[device.deviceId]?.send ?? existingRulesByIp[device.ip]?.send ?? existingRules[device.ip]?.send ?? true,
      receive:
        existingRules[device.deviceId]?.receive ?? existingRulesByIp[device.ip]?.receive ?? existingRules[device.ip]?.receive ?? true
    };
  }
  return nextRules;
}

export function updateDeviceRule(settings, devices, deviceId, column, checked) {
  if (isIpAddress(deviceId)) {
    const matchingDevices = devices.filter((item) => item.ip === deviceId);
    const ipRule = settings.deviceRulesByIp?.[deviceId] || settings.deviceRules?.[deviceId] || {};
    const nextRule = {
      [column]: Boolean(checked)
    };
    const otherColumn = column === 'send' ? 'receive' : 'send';
    const uniformOtherValue = uniformColumnRule(settings, matchingDevices, otherColumn);
    if (ipRule[otherColumn] !== undefined) {
      nextRule[otherColumn] = ipRule[otherColumn];
    } else if (uniformOtherValue !== undefined) {
      nextRule[otherColumn] = uniformOtherValue;
    }
    const deviceRules = { ...(settings.deviceRules || {}) };
    for (const device of matchingDevices) {
      const current = deviceRule(settings, device);
      deviceRules[device.deviceId] = {
        send: current.send ?? true,
        receive: current.receive ?? true,
        [column]: Boolean(checked)
      };
    }
    return {
      deviceRules,
      deviceRulesByIp: {
        ...(settings.deviceRulesByIp || {}),
        [deviceId]: nextRule
      }
    };
  }

  const device = devices.find((item) => item.deviceId === deviceId);
  const current = device ? deviceRule(settings, device) : settings.deviceRules?.[deviceId] || {};
  const nextRule = {
    send: current.send ?? true,
    receive: current.receive ?? true,
    [column]: Boolean(checked)
  };
  const deviceRules = {
    ...(settings.deviceRules || {}),
    [deviceId]: nextRule
  };
  const deviceRulesByIp = { ...(settings.deviceRulesByIp || {}) };
  if (device?.ip) {
    deviceRulesByIp[device.ip] = nextRule;
  }
  return { deviceRules, deviceRulesByIp };
}
