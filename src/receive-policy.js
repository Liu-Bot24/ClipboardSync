import { isIP } from 'node:net';

const MAX_BLOCKED_SOURCES = 512;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function unique(values) {
  return [...new Set(values)];
}

function isIpAddress(value) {
  return typeof value === 'string' && isIP(value) !== 0;
}

function normalizedSourceId(value) {
  return SOURCE_ID_PATTERN.test(value || '') ? value : null;
}

function normalizedSourceIp(value) {
  return isIpAddress(value) ? value : null;
}

export function receiverPolicyFromSettings(settings = {}) {
  const allowedSourceDeviceIds = [];
  const blockedSourceDeviceIds = [];
  const blockedSourceIps = [];

  for (const [key, rule] of Object.entries(settings.deviceRules || {})) {
    if (rule?.receive === true) {
      const sourceId = normalizedSourceId(key);
      if (sourceId && !isIpAddress(key)) {
        allowedSourceDeviceIds.push(sourceId);
      }
      continue;
    }
    if (rule?.receive !== false) {
      continue;
    }
    if (isIpAddress(key)) {
      blockedSourceIps.push(key);
      continue;
    }
    const sourceId = normalizedSourceId(key);
    if (sourceId) {
      blockedSourceDeviceIds.push(sourceId);
    }
  }

  for (const [ip, rule] of Object.entries(settings.deviceRulesByIp || {})) {
    if (rule?.receive === false && normalizedSourceIp(ip)) {
      blockedSourceIps.push(ip);
    }
  }

  return {
    allowedSourceDeviceIds: unique(allowedSourceDeviceIds).slice(0, MAX_BLOCKED_SOURCES),
    blockedSourceDeviceIds: unique(blockedSourceDeviceIds).slice(0, MAX_BLOCKED_SOURCES),
    blockedSourceIps: unique(blockedSourceIps).slice(0, MAX_BLOCKED_SOURCES)
  };
}

export function normalizeReceiverPolicy(policy = {}) {
  return {
    allowedSourceDeviceIds: unique(
      (Array.isArray(policy.allowedSourceDeviceIds) ? policy.allowedSourceDeviceIds : [])
        .map((value) => normalizedSourceId(String(value)))
        .filter(Boolean)
    ).slice(0, MAX_BLOCKED_SOURCES),
    blockedSourceDeviceIds: unique(
      (Array.isArray(policy.blockedSourceDeviceIds) ? policy.blockedSourceDeviceIds : [])
        .map((value) => normalizedSourceId(String(value)))
        .filter(Boolean)
    ).slice(0, MAX_BLOCKED_SOURCES),
    blockedSourceIps: unique(
      (Array.isArray(policy.blockedSourceIps) ? policy.blockedSourceIps : [])
        .map((value) => normalizedSourceIp(String(value)))
        .filter(Boolean)
    ).slice(0, MAX_BLOCKED_SOURCES)
  };
}

export function receiverAllowsEvent(policy, event, receiverDeviceId) {
  if (event.sourceDeviceId === receiverDeviceId) {
    return true;
  }
  const normalized = normalizeReceiverPolicy(policy);
  if (event.sourceDeviceId && normalized.allowedSourceDeviceIds.includes(event.sourceDeviceId)) {
    return true;
  }
  if (event.sourceDeviceId && normalized.blockedSourceDeviceIds.includes(event.sourceDeviceId)) {
    return false;
  }
  if (event.sourceIp && normalized.blockedSourceIps.includes(event.sourceIp)) {
    return false;
  }
  return true;
}
