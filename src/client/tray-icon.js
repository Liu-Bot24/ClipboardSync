const EMERGENCY_TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKUlEQVR42mP8z8Dwn4ECwESJ5lEDRg0YNWDUMKMGjBowagAAlx0CH5geGwsAAAAASUVORK5CYII=';

function prepareTrayImage(image, platform, size) {
  const resized = image.resize({ width: size, height: size });
  if (platform === 'darwin' && typeof resized.setTemplateImage === 'function') {
    resized.setTemplateImage(true);
  }
  return resized;
}

export function trayIconForPlatform({ nativeImage, readFileSync, iconPath, platform = process.platform, size = 18 }) {
  try {
    const packagedIcon = nativeImage.createFromBuffer(readFileSync(iconPath));
    if (!packagedIcon.isEmpty()) {
      return prepareTrayImage(packagedIcon, platform, size);
    }
  } catch {
    // Fall through to the embedded emergency icon if the packaged asset is unavailable.
  }
  return prepareTrayImage(nativeImage.createFromDataURL(EMERGENCY_TRAY_ICON_DATA_URL), platform, size);
}
