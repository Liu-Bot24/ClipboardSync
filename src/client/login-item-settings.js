export function loginItemSettingsFor(settings, runtime = {}) {
  const platform = runtime.platform ?? process.platform;
  const options = {
    openAtLogin: Boolean(settings.autoLaunch && !runtime.disableAutoLaunchRegistration)
  };

  if (platform === 'win32') {
    options.path = runtime.execPath ?? process.execPath;
  }

  return options;
}
