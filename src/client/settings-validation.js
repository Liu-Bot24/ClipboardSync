function withDefaultHubScheme(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(trimmed)) {
    return trimmed;
  }
  return `http://${trimmed}`;
}

export function normalizeHubUrl(value) {
  let url;
  try {
    url = new URL(withDefaultHubScheme(value));
  } catch {
    throw new Error('Hub 地址无效');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Hub 地址必须是 http 或 https');
  }

  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}
