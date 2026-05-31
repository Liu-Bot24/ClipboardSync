const SOURCE_FIELDS = [
  'processName',
  'appName',
  'name',
  'bundleId',
  'title',
  'className'
];

export function normalizeIgnoredSourcePatterns(value) {
  const items = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  return items
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
}

export function sourceMatchesIgnoredPatterns(source, patterns) {
  const normalized = normalizeIgnoredSourcePatterns(patterns);
  if (!source || normalized.length === 0) {
    return false;
  }
  const haystack = SOURCE_FIELDS.map((field) => source[field])
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n')
    .toLowerCase();
  if (!haystack) {
    return false;
  }
  return normalized.some((pattern) => haystack.includes(pattern));
}

export function hasSourceIdentity(source) {
  if (!source) {
    return false;
  }
  return SOURCE_FIELDS.some((field) => typeof source[field] === 'string' && source[field].trim());
}

export function shouldIgnoreLocalClipboardSource(source, settings) {
  if (!hasSourceIdentity(source)) {
    return Boolean(settings?.ignoreUnknownSource);
  }
  return sourceMatchesIgnoredPatterns(source, settings?.ignoredSourcePatterns);
}
