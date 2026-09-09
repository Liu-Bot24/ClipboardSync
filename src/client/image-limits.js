import { PNG } from 'image-size/types/png';
import { JPG } from 'image-size/types/jpg';
import { WEBP } from 'image-size/types/webp';

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 32768;

export function assertImageDimensions({ width, height }) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('image exceeds the pixel budget');
  }
}

export function assertImageBudget(buffer, contentType) {
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('image exceeds the encoded byte budget');
  const signatures = {
    'image/png': () => buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
    'image/jpeg': () => buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255,
    'image/webp': () => buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  };
  if (!signatures[contentType]?.()) throw new Error('image format does not match its content type');
  const handler = { 'image/png': PNG, 'image/jpeg': JPG, 'image/webp': WEBP }[contentType];
  if (!handler.validate(buffer)) throw new Error('invalid image header');
  // Dispatch explicitly: a malformed WebP cannot fall back to SVG or another parser.
  const size = handler.calculate(buffer);
  assertImageDimensions(size);
  return size;
}
