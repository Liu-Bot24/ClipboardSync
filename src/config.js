function parsePositiveInteger(value, name) {
  if (!/^[1-9]\d*$/.test(String(value || ''))) {
    throw new Error(`${name} must be a positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return number;
}

export function readConfig(env = process.env) {
  const token = String(env.CLIPBOARD_HUB_TOKEN || '').trim();
  if (
    token &&
    (
      token.length < 24 ||
      /(?:replace|change|example|test-token|token-here|long-random-token)/i.test(token)
    )
  ) {
    throw new Error('CLIPBOARD_HUB_TOKEN must be a real random token with at least 24 characters');
  }

  const maxPayloadBytes = env.CLIPBOARD_HUB_MAX_PAYLOAD_BYTES
    ? parsePositiveInteger(env.CLIPBOARD_HUB_MAX_PAYLOAD_BYTES, 'CLIPBOARD_HUB_MAX_PAYLOAD_BYTES')
    : 33_554_432;
  const maxHistoryBytes = env.CLIPBOARD_HUB_MAX_HISTORY_BYTES
    ? parsePositiveInteger(env.CLIPBOARD_HUB_MAX_HISTORY_BYTES, 'CLIPBOARD_HUB_MAX_HISTORY_BYTES')
    : 1_073_741_824;

  if (maxHistoryBytes < maxPayloadBytes) {
    throw new Error('CLIPBOARD_HUB_MAX_HISTORY_BYTES must be greater than or equal to CLIPBOARD_HUB_MAX_PAYLOAD_BYTES');
  }

  return {
    host: env.CLIPBOARD_HUB_HOST || '0.0.0.0',
    port: env.CLIPBOARD_HUB_PORT
      ? parsePositiveInteger(env.CLIPBOARD_HUB_PORT, 'CLIPBOARD_HUB_PORT')
      : 8787,
    historyPath: env.CLIPBOARD_HUB_HISTORY_PATH || '/data/history.jsonl',
    maxPayloadBytes,
    maxHistoryEntries: env.CLIPBOARD_HUB_MAX_HISTORY_ENTRIES
      ? parsePositiveInteger(env.CLIPBOARD_HUB_MAX_HISTORY_ENTRIES, 'CLIPBOARD_HUB_MAX_HISTORY_ENTRIES')
      : 100,
    historyDisplayLimit: env.CLIPBOARD_HUB_HISTORY_DISPLAY_LIMIT
      ? parsePositiveInteger(env.CLIPBOARD_HUB_HISTORY_DISPLAY_LIMIT, 'CLIPBOARD_HUB_HISTORY_DISPLAY_LIMIT')
      : 30,
    maxHistoryBytes,
    maxHistoryAgeMs: env.CLIPBOARD_HUB_MAX_HISTORY_AGE_MS
      ? parsePositiveInteger(env.CLIPBOARD_HUB_MAX_HISTORY_AGE_MS, 'CLIPBOARD_HUB_MAX_HISTORY_AGE_MS')
      : 604_800_000,
    token
  };
}
