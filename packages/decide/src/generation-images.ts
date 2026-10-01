import { normalizeImages, InvalidImageError, type ImageInput, type DecisionImage } from './images.ts';

/** PNG/JPEG inline only. The host converts other bitmap formats; the kit never reads files or URLs. */
export function generationImages(input?: readonly ImageInput[]): DecisionImage[] {
  return normalizeImages(input).map((image) => {
    if (image.mime === 'image/jpg') return { ...image, mime: 'image/jpeg', dataUrl: image.dataUrl.replace('data:image/jpg;', 'data:image/jpeg;') };
    if (image.mime !== 'image/png' && image.mime !== 'image/jpeg') throw new InvalidImageError('Supply PNG or JPEG images for generation.');
    return image;
  });
}
