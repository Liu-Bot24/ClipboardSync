function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isUsableRect(rect) {
  return (
    rect &&
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function rectCenter(rect) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2
  };
}

function containsPoint(rect, point) {
  return (
    isUsableRect(rect) &&
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function squaredDistance(a, b) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function displayNearestPoint(displays, point) {
  const usableDisplays = displays.filter((display) => isUsableRect(display.workArea || display.bounds));
  const containing = usableDisplays.find((display) => containsPoint(display.bounds || display.workArea, point));
  if (containing) {
    return containing;
  }
  return usableDisplays
    .map((display) => ({
      display,
      distance: squaredDistance(rectCenter(display.bounds || display.workArea), point)
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.display;
}

function clamp(value, min, max) {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function displayForPopup({ platform, trayBounds, displays, primaryDisplay }) {
  if (platform === 'win32') {
    return primaryDisplay || displays[0];
  }
  if (isUsableRect(trayBounds)) {
    return displayNearestPoint(displays, rectCenter(trayBounds));
  }
  return primaryDisplay || displays[0];
}

export function popupPosition({ platform, trayBounds, displays, primaryDisplay, width, height, margin = 8 }) {
  const display = displayForPopup({ platform, trayBounds, displays, primaryDisplay });
  const area = display?.workArea || display?.bounds || { x: 0, y: 0, width, height };

  let preferredX = area.x + area.width - width - margin;
  let preferredY = area.y + area.height - height - margin;

  if (platform === 'darwin' && isUsableRect(trayBounds)) {
    preferredX = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
    preferredY = Math.round(trayBounds.y + trayBounds.height + margin);
  }

  return {
    x: clamp(Math.round(preferredX), area.x + margin, area.x + area.width - width - margin),
    y: clamp(Math.round(preferredY), area.y + margin, area.y + area.height - height - margin)
  };
}
