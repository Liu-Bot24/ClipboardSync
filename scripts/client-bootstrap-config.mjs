const DEFAULT_MAX_SEND_BYTES = 33_554_432;
const DEFAULT_HISTORY_DISPLAY_LIMIT = 30;
export const DEFAULT_UPSTREAM_HUB_URL = '';
export const MAC_LOCAL_PROXY_HUB_URL = 'http://127.0.0.1:18787';

export function parseOptionalBoolean(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function configuredValue(envName, config, key, env) {
  return env[envName] || config[key] || '';
}

export function createClientBootstrapConfig(existingConfig, env = process.env) {
  return {
    hubUrl: configuredValue('CLIPBOARD_CLIENT_HUB_URL', existingConfig, 'hubUrl', env),
    token: configuredValue('CLIPBOARD_CLIENT_TOKEN', existingConfig, 'token', env),
    autoLaunch: parseOptionalBoolean(env.CLIPBOARD_CLIENT_AUTO_LAUNCH, true),
    pauseSend: false,
    pauseReceive: false,
    historyAlwaysOnTop: true,
    historyDisplayLimit: DEFAULT_HISTORY_DISPLAY_LIMIT,
    maxSendBytes: DEFAULT_MAX_SEND_BYTES,
    deviceRules: {}
  };
}

export function isLoopbackHubUrl(value) {
  if (!value) {
    return false;
  }
  try {
    const { hostname } = new URL(value);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

export function upstreamHubUrlForPackage(existingConfig, env = process.env) {
  const explicitUpstream =
    env.CLIPBOARD_CLIENT_UPSTREAM_HUB_URL || existingConfig.upstreamHubUrl || existingConfig.proxyTargetUrl || '';
  if (explicitUpstream) {
    return explicitUpstream;
  }

  const configured = configuredValue('CLIPBOARD_CLIENT_HUB_URL', existingConfig, 'hubUrl', env);
  if (!configured || isLoopbackHubUrl(configured)) {
    return DEFAULT_UPSTREAM_HUB_URL;
  }
  return configured;
}

export function createMacProxyConfig(existingConfig, env = process.env) {
  return {
    listenHost: '127.0.0.1',
    listenPort: 18787,
    targetUrl: upstreamHubUrlForPackage(existingConfig, env)
  };
}
