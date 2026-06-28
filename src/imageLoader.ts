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
