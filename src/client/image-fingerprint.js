import { createHash } from 'node:crypto';

// Pixel identity survives PNG/JPEG decoding and PNG re-encoding by the clipboard.
export function imageFingerprint(image) {
  const { width, height } = image.getSize();
  return createHash('sha256')
    .update(`${width}x${height}:`)
    .update(image.toBitmap({ scaleFactor: 1 }))
    .digest('hex');
}
