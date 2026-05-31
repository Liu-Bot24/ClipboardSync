export const DEVICE_SETTINGS_MENU_LABEL = '收发设置';
export const HISTORY_MENU_ICON_SIZE = 18;

export function historyMenuIconForEvent(event, nativeImage, size = HISTORY_MENU_ICON_SIZE) {
  if (!event?.contentType?.startsWith('image/') || !event.imagePreviewSrc || !nativeImage?.createFromDataURL) {
    return undefined;
  }

  let image;
  try {
    image = nativeImage.createFromDataURL(event.imagePreviewSrc);
  } catch {
    return undefined;
  }

  if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) {
    return undefined;
  }

  const icon =
    typeof image.resize === 'function'
      ? image.resize({
          width: size,
          height: size,
          quality: 'good'
        })
      : image;
  icon?.setTemplateImage?.(false);
  return icon;
}

export function historyMenuEntryForPlatform(platform, historyMenuItems, showHistoryPopup) {
  return platform === 'darwin'
    ? { label: '历史', submenu: [{ label: '主窗口', click: showHistoryPopup }, { type: 'separator' }, ...historyMenuItems()] }
    : { label: '历史', click: showHistoryPopup };
}
