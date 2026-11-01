/**
 * Resolve a folder ImageEntry to a Blob the browser can render natively.
 *
 *  - For ordinary web formats (JPEG / PNG / WebP / AVIF / GIF / BMP / HEIC):
 *    return the File as-is. The browser decodes it.
 *
 *  - For RAW (CR2, CR3, ARW, NEF, RAF, RW2, ORF, DNG) and TIFF:
 *    extract the embedded JPEG preview via exifr. Modern cameras embed a
 *    full-sized JPEG inside the RAW for in-camera review — that's exactly
 *    what we want for slideshow display. Pixel-accurate RAW decoding would
 *    require a 3–5 MB WASM build (LibRaw etc.); embedded previews give us
 *    ~99 % of the visual fidelity at a fraction of the cost (and decode time).
 *
 *  - If no preview is extractable, return `null`. We refuse to hand the raw
 *    RAW bytes to the browser — no browser can decode CR2/ARW/NEF natively
 *    and a failed texture upload is far more expensive than a clean skip.
 *    For .tif/.tiff we DO fall through to the raw file because Safari can
 *    decode baseline TIFFs.
 *
 * exifr is loaded dynamically — keeps the initial bundle small for users
 * who never throw a RAW at the app.
 */

const RAW_EXT  = /\.(cr[23]|nef|arw|raf|rw2|orf|dng|tiff?)$/i;
const TIFF_EXT = /\.tiff?$/i;

export async function getImageBlob(file: File): Promise<Blob | null> {
  if (!RAW_EXT.test(file.name)) return file;

  // RAW / TIFF — try embedded JPEG preview
  try {
    const exifr = await import('exifr');

    // 1. Full-size preview tags (CR2 IFD2, ARW PreviewImage, NEF PreviewIFD, …)
    //    exifr surfaces these via the `pick` option; results are Uint8Arrays.
    const meta = await (exifr as any).parse(file, {
      pick: ['PreviewImage', 'JpgFromRaw', 'OtherImage', 'ThumbnailImage'],
      translateValues: false,
      mergeOutput: true,
    }) as Record<string, unknown> | undefined;

    if (meta) {
      for (const k of ['PreviewImage', 'JpgFromRaw', 'OtherImage', 'ThumbnailImage']) {
        const v = meta[k];
        if (v instanceof Uint8Array && v.byteLength > 16_000) {
          // Heuristic: >16 KB is a real preview, not a 160×120 EXIF thumbnail
          return new Blob([v as BlobPart], { type: 'image/jpeg' });
        }
      }
    }

    // 2. Fall back to the EXIF thumbnail (small, ~160×120 on many cameras)
    const thumb = await (exifr as any).thumbnail(file);
    if (thumb instanceof Uint8Array && thumb.byteLength > 0) {
      return new Blob([thumb as BlobPart], { type: 'image/jpeg' });
    }
  } catch (err) {
    // Common case: corrupt file or a CR2 variant exifr can't walk
    // ("offset is outside the bounds of the DataView"). Warned once per file
    // by the engine's failure tracker.
  }

  // 3. TIFF: hand to the browser (Safari decodes baseline TIFFs)
  if (TIFF_EXT.test(file.name)) return file;

  // 4. RAW with no extractable preview — refuse. The engine marks the file
  //    as permanently failed and skips it.
  return null;
}

/**
 * Decode a Blob to an ImageBitmap no larger than (capW, capH) device pixels.
 *
 * Why downscale at all: Pixi's loader uploads photos at native resolution, so a
 * 24 MP file becomes a ~96 MB GPU texture that is then minified into a ~1920 px
 * quad with a single bilinear tap — which both wastes VRAM (14 cached slides
 * could reach ~1.3 GB) and shimmers on fine detail while panning.
 *
 * The cap is applied PER AXIS, not to the long edge. Cover fit requires both
 * axes to meet their cap, so this keeps panoramas wide and tall photos tall;
 * capping the long edge alone would under-resolve a 3:1 panorama.
 *
 * No zoom headroom: at the tightest Ken Burns keyframe the photo is magnified by
 * at most 1.30, which trilinear filtering makes imperceptible.
 *
 * Decode-then-resize (rather than probing the file header for dimensions and
 * decoding straight to size) is deliberate: it is a few lines, works for every
 * format the browser can decode, and the full-resolution bitmap is transient.
 * `createImageBitmap` decodes off the main thread, so doing this ourselves
 * instead of going through Pixi's worker costs nothing — that worker existed
 * mainly to move a `fetch` off-thread, and we already hold the Blob.
 */
export async function decodeToBitmap(
  blob: Blob,
  capW: number,
  capH: number,
): Promise<ImageBitmap> {
  const full = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
  const k = Math.min(1, Math.max(capW / full.width, capH / full.height));
  if (k >= 1) return full;

  const w = Math.max(1, Math.round(full.width * k));
  const h = Math.max(1, Math.round(full.height * k));
  try {
    const small = await createImageBitmap(full, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'high',
      premultiplyAlpha: 'premultiply',
    });
    // Some engines accept resize options and ignore them without erroring.
    // Verify rather than trust; a full-resolution texture is a quality/memory
    // regression, not a correctness one, so falling back is fine.
    if (small.width !== w) { small.close(); return full; }
    full.close();
    return small;
  } catch {
    return full;
  }
}
