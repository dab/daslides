/**
 * Resolve a picked file to something the browser can actually draw.
 *
 *  - Ordinary web formats (JPEG / PNG / WebP / AVIF / GIF / BMP / HEIC) are
 *    handed over untouched; the browser decodes them.
 *
 *  - RAW and TIFF go to a worker that pulls out the embedded JPEG preview.
 *    See rawPreview.worker.ts for why that is the right trade-off and how the
 *    preview is located and validated.
 *
 *  - Files with no usable preview return a null blob, and the engine skips
 *    them. We would rather skip than display a 160x120 thumbnail stretched
 *    across a 4K screen.
 */

import type { RawPreview } from './rawPreview.worker.ts';

const RAW_EXT  = /\.(cr[23]|nef|arw|raf|rw2|orf|dng|tiff?)$/i;
const TIFF_EXT = /\.tiff?$/i;

export interface ResolvedImage {
  blob: Blob | null;
  /**
   * EXIF orientation 1-8. For RAW this comes from the parent file, because an
   * extracted preview carries no Exif of its own — so unlike a normal JPEG the
   * browser cannot apply it for us.
   */
  orientation: number;
}

// ─── worker plumbing ────────────────────────────────────────────────────────

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (r: RawPreview) => void>();

/**
 * One worker, created on first RAW. Messages queue naturally, which also stops
 * the engine's 5-7 parallel preloads from all parsing at once.
 */
function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./rawPreview.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.onmessage = (
    e: MessageEvent<{ id: number; result?: RawPreview; error?: string }>,
  ) => {
    const done = pending.get(e.data.id);
    if (!done) return;
    pending.delete(e.data.id);
    if (e.data.error) {
      console.warn('[slideshow] preview extraction failed:', e.data.error);
      done({ blob: null, orientation: 1, width: 0, height: 0 });
    } else {
      done(e.data.result!);
    }
  };
  return worker;
}

function extractPreview(file: File): Promise<RawPreview> {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    getWorker().postMessage({ id, file });
  });
}

// ─── public API ─────────────────────────────────────────────────────────────

export async function getImageBlob(file: File): Promise<ResolvedImage> {
  if (!RAW_EXT.test(file.name)) return { blob: file, orientation: 1 };

  const preview = await extractPreview(file);
  if (preview.blob) return { blob: preview.blob, orientation: preview.orientation };

  // Baseline TIFFs are decodable directly by some browsers (Safari), so it's
  // worth handing the file over rather than giving up.
  if (TIFF_EXT.test(file.name)) return { blob: file, orientation: preview.orientation };

  return { blob: null, orientation: 1 };
}

// ─── decode ─────────────────────────────────────────────────────────────────

/**
 * Rotate/flip a bitmap to match its EXIF orientation. Only needed for RAW
 * previews, which have no Exif for the browser to honour.
 */
async function applyOrientation(src: ImageBitmap, orientation: number): Promise<ImageBitmap> {
  const swap = orientation >= 5;
  const w = swap ? src.height : src.width;
  const h = swap ? src.width : src.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return src;
  const sw = src.width, sh = src.height;
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, sw, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, sw, sh); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, sh); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, sh, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, sh, sw); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, sw); break;
    default: return src;
  }
  ctx.drawImage(src, 0, 0);
  src.close();
  return canvas.transferToImageBitmap();
}

/**
 * Decode a Blob to an ImageBitmap no larger than (capW, capH) device pixels.
 *
 * Why downscale: a 24 MP file would otherwise become a ~96 MB GPU texture that
 * is then minified into a ~1920 px quad with a single bilinear tap — wasting
 * VRAM and shimmering on fine detail while panning.
 *
 * The cap is applied PER AXIS, not to the long edge. Cover fit needs both axes
 * to meet their cap, so this keeps panoramas wide and tall photos tall; capping
 * the long edge alone would under-resolve a 3:1 panorama.
 *
 * No zoom headroom: at the tightest Ken Burns keyframe the photo is magnified by
 * at most 1.30, which trilinear filtering makes imperceptible.
 */
export async function decodeToBitmap(
  blob: Blob,
  capW: number,
  capH: number,
  orientation = 1,
): Promise<ImageBitmap> {
  // `from-image` is pinned rather than left to the default, which changed from
  // "ignore EXIF" to "apply it" partway through this API's life.
  let full = await createImageBitmap(blob, {
    premultiplyAlpha: 'premultiply',
    imageOrientation: 'from-image',
  });
  if (orientation > 1) full = await applyOrientation(full, orientation);

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
    // Verify rather than trust; falling back costs quality and memory, not
    // correctness.
    if (small.width !== w) { small.close(); return full; }
    full.close();
    return small;
  } catch {
    return full;
  }
}
