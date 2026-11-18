// Photos for Jack (meal analysis). The browser shrinks them first so the upload stays small and fast.

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
export const MAX_PHOTO_SIDE = 1024;
export const PHOTO_QUALITY = 0.8;

// Returns a translation key when the file cannot be used, otherwise ''.
export function photoProblem(file) {
  if (!file || !IMAGE_TYPES.includes(file.type)) return 'jackPhotoType';
  if (file.size > MAX_PHOTO_BYTES) return 'jackPhotoSize';
  return '';
}

// The size that fits inside max x max and keeps the proportions; never enlarges.
export function fitWithin(width, height, max = MAX_PHOTO_SIDE) {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// Reads a picture, shrinks it and returns { mime: 'image/jpeg', data: <base64>, previewUrl }.
export async function prepareJackPhoto(file) {
  const problem = photoProblem(file);
  if (problem) throw new Error(problem);

  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
  return { mime: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1), previewUrl: dataUrl };
}