/** Inline images only: the kit never fetches a URL or reads a file. IDs let criteria name references. */
export type ImageInput = { id: string; mime: string } & (
  | { bytes: Uint8Array; dataUrl?: never }
  | { dataUrl: string; bytes?: never }
);
export type DecisionImage = { id: string; mime: string; dataUrl: string };

export class UnsupportedImagesError extends Error {
  readonly code = 'unsupported_images';
  constructor(backend: string) { super(`${backend} does not support image input.`); this.name = 'UnsupportedImagesError'; }
}
export class InvalidImageError extends Error {
  readonly code = 'invalid_image';
  constructor(message: string) { super(message); this.name = 'InvalidImageError'; }
}

/** Portable base64: no Buffer, btoa, Node or native modules required. */
function base64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chunks: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    chunk += alphabet[a >> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)] +
      (b === undefined ? '=' : alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]) +
      (c === undefined ? '=' : alphabet[c & 63]);
    if (chunk.length >= 8192) { chunks.push(chunk); chunk = ''; }
  }
  if (chunk) chunks.push(chunk);
  return chunks.join('');
}

export function normalizeImages(images: readonly ImageInput[] = []): DecisionImage[] {
  if (!Array.isArray(images)) throw new InvalidImageError('Images must be an array.');
  const ids = new Set<string>();
  return images.map((image) => {
    if (!image || typeof image.id !== 'string' || !image.id.trim() || ids.has(image.id)) {
      throw new InvalidImageError('Every image needs a unique, non-empty id.');
    }
    ids.add(image.id);
    if (typeof image.mime !== 'string' || !/^image\/[a-z0-9.+-]+$/.test(image.mime)) {
      throw new InvalidImageError('Every image needs an image MIME type.');
    }
    let dataUrl: string;
    if (image.bytes !== undefined) {
      if (!(image.bytes instanceof Uint8Array) || !image.bytes.length || image.dataUrl !== undefined) {
        throw new InvalidImageError('Supply non-empty bytes or a data URL, once per image.');
      }
      dataUrl = `data:${image.mime};base64,${base64(image.bytes)}`;
    } else {
      dataUrl = image.dataUrl!;
      const prefix = `data:${image.mime};base64,`;
      if (typeof dataUrl !== 'string' || dataUrl !== dataUrl.trim() || !dataUrl.startsWith(prefix) ||
          (dataUrl.length - prefix.length) % 4 !== 0 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(dataUrl.slice(prefix.length)) ||
          dataUrl.length === prefix.length) {
        throw new InvalidImageError('Supply a non-empty base64 data URL matching the image MIME type.');
      }
    }
    return { id: image.id, mime: image.mime, dataUrl };
  });
}

export function validateImageReferences(questions: Record<string, { images?: string[] }>, images: readonly DecisionImage[]): void {
  const ids = new Set(images.map((image) => image.id));
  for (const question of Object.values(questions)) {
    if (question.images !== undefined && (!Array.isArray(question.images) || question.images.some((id) => !ids.has(id)))) {
      throw new InvalidImageError('A question references an image missing from this decision.');
    }
  }
}
