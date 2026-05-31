export function shouldShowInitialPopup({ platform, firstRun }) {
  return (platform === 'darwin' || platform === 'win32') && firstRun === true;
}

export function popupActionFor({ isVisible, forceShow }) {
  return isVisible && !forceShow ? 'hide' : 'show';
}

export function shouldHidePopupOnBlur({ hasFocused, devToolsOpened, windowRole = 'tray-panel' }) {
  if (windowRole === 'history-main') {
    return false;
  }
  return Boolean(hasFocused) && !devToolsOpened;
}
