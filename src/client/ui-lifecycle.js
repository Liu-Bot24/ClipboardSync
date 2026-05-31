export function createUiLifecycle() {
  let quitting = false;

  return {
    beginQuit() {
      quitting = true;
    },
    canBroadcast() {
      return !quitting;
    },
    canUseTray(tray) {
      return !quitting && Boolean(tray);
    }
  };
}
