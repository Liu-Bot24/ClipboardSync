const QA_THEMES = new Set(['dark', 'light']);

export function applyQaThemeSource(nativeTheme, env = process.env) {
  const theme = env.CLIPBOARD_SYNC_QA_THEME;
  if (!QA_THEMES.has(theme)) {
    return false;
  }
  nativeTheme.themeSource = theme;
  return true;
}
