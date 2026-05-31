import { hasSourceIdentity } from './source-ignore.js';

const SOURCE_CANDIDATES = [
  ['appName', '应用'],
  ['processName', '进程'],
  ['name', '名称'],
  ['bundleId', '标识'],
  ['title', '窗口'],
  ['className', '窗口类']
];

function cleanText(value) {
  return String(value || '').trim();
}

function suggestionId(field, value) {
  return `${field.toLowerCase()}:${cleanText(value).toLowerCase()}`;
}

function uniqueDetailParts(source, primaryField, primaryValue) {
  const primary = cleanText(primaryValue).toLowerCase();
  const parts = [];
  const seen = new Set([primary]);
  for (const [field, label] of SOURCE_CANDIDATES) {
    if (field === primaryField) {
      continue;
    }
    const value = cleanText(source?.[field]);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) {
      continue;
    }
    seen.add(key);
    parts.push(`${label}：${value}`);
    if (parts.length >= 2) {
      break;
    }
  }
  return parts;
}

export function sourceSuggestionForUi(source) {
  if (!hasSourceIdentity(source)) {
    return {
      id: 'unknown-source',
      label: '未知复制来源',
      detail: '系统没有提供写入剪贴板的进程',
      unknown: true
    };
  }
  for (const [field] of SOURCE_CANDIDATES) {
    const value = cleanText(source?.[field]);
    if (!value) {
      continue;
    }
    return {
      id: suggestionId(field, value),
      label: value,
      pattern: value,
      detail: uniqueDetailParts(source, field, value).join(' · ')
    };
  }
  return {};
}

export function mergeRecentSourceSuggestions(recent, source, limit = 8) {
  const suggestion = sourceSuggestionForUi(source);
  if (!suggestion.pattern) {
    return Array.isArray(recent) ? recent : [];
  }
  const existing = Array.isArray(recent) ? recent : [];
  return [suggestion, ...existing.filter((item) => item.id !== suggestion.id)].slice(0, limit);
}
