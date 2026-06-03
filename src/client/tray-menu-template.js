import i18n from './i18n.cjs';

export const DEVICE_SETTINGS_MENU_LABEL = '收发设置';
export const HISTORY_MENU_ICON_SIZE = 18;
const { normalizeLanguage, supportedLanguages, t } = i18n;

export function deviceSettingsMenuLabel(language = 'zh-CN') {
  return t(language, 'menu.deviceSettings');
}

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

export function historyMenuEntryForPlatform(platform, historyMenuItems, showHistoryPopup, language = 'zh-CN') {
  return platform === 'darwin'
    ? {
        label: t(language, 'history.section'),
        submenu: [{ label: t(language, 'history.mainWindow'), click: showHistoryPopup }, { type: 'separator' }, ...historyMenuItems()]
      }
    : { label: t(language, 'history.section'), click: showHistoryPopup };
}

export function languageMenuEntry(language, updateLanguage) {
  const currentLanguage = normalizeLanguage(language);
  return {
    label: t(currentLanguage, 'menu.language'),
    submenu: supportedLanguages.map((item) => ({
      label: item.label,
      type: 'radio',
      checked: item.code === currentLanguage,
      click: () => updateLanguage(item.code)
    }))
  };
}
