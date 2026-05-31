export function installSingleInstanceGuard(app, onSecondInstance) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  app.on('second-instance', () => onSecondInstance());
  return true;
}
