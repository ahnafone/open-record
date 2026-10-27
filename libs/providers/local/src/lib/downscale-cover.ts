/** Longest edge, in px, of a stored cover: sharp on the largest sleeve at 3x without decoding megapixel art. */
export const COVER_MAX_EDGE = 512;
const COVER_QUALITY = 0.82;

export interface CoverBytes {
  mime: string;
  data: Uint8Array;
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function makeCanvas(width: number, height: number): { ctx: Canvas2D; encode: () => Promise<Blob | null> } | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    return ctx ? { ctx, encode: () => canvas.convertToBlob({ type: 'image/jpeg', quality: COVER_QUALITY }) } : null;
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  return ctx
    ? { ctx, encode: () => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', COVER_QUALITY)) }
    : null;
}

/**
 * Re-encode embedded cover art as a JPEG whose longest edge is at most
 * {@link COVER_MAX_EDGE}, keeping its aspect ratio. Covers already that small,
 * and any failure (no canvas, undecodable image), keep the original bytes.
 */
export async function downscaleCover(cover: CoverBytes): Promise<CoverBytes> {
  if (typeof createImageBitmap !== 'function') return cover;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(new Blob([cover.data as Uint8Array<ArrayBuffer>], { type: cover.mime }));
    const scale = COVER_MAX_EDGE / Math.max(bitmap.width, bitmap.height);
    if (!(scale < 1)) return cover;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = makeCanvas(width, height);
    if (!canvas) return cover;
    // JPEG has no alpha: paint transparent covers onto black (the vinyl colour) rather than undefined pixels.
    canvas.ctx.fillStyle = '#000';
    canvas.ctx.fillRect(0, 0, width, height);
    canvas.ctx.imageSmoothingQuality = 'high';
    canvas.ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.encode();
    if (!blob) return cover;
    return { mime: 'image/jpeg', data: new Uint8Array(await blob.arrayBuffer()) };
  } catch {
    return cover;
  } finally {
    bitmap?.close();
  }
}
