export function disableElectronSafeStorageKeychain(app, runtime = {}) {
  const platform = runtime.platform || process.platform;
  if (platform !== 'darwin') {
    return;
  }

  app.commandLine.appendSwitch('use-mock-keychain');
  app.commandLine.appendSwitch('password-store', 'basic');
}

export function safeStorageKeychainSuppressionState(app, runtime = {}) {
  const platform = runtime.platform || process.platform;
  if (platform !== 'darwin') {
    return {
      required: false,
      enabled: true
    };
  }

  return {
    required: true,
    enabled: app.commandLine.hasSwitch('use-mock-keychain') && app.commandLine.hasSwitch('password-store'),
    mockKeychain: app.commandLine.hasSwitch('use-mock-keychain'),
    passwordStore: app.commandLine.getSwitchValue('password-store') || ''
  };
}
