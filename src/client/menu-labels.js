export function menuSafeLabel(value, maxLength = 96) {
  const label = String(value || '').replace(/\s+/g, ' ').trim();
  if (label.length <= maxLength) {
    return label;
  }
  return `${label.slice(0, Math.max(0, maxLength - 1))}…`;
}
