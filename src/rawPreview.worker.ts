/**
 * Extracts the embedded JPEG preview from a RAW or TIFF file, off the main
 * thread.
 *
 * Cameras store one or more ready-made JPEGs inside a RAW file — that is what
 * the body shows you on its own screen — and for a slideshow that preview is
 * all we need. Decoding the actual sensor data would mean shipping a demosaicing
 * library and spending an order of magnitude more time per photo.
 *
 * Two strategies:
 *
 *   TIFF-based containers (CR2, ARW, NEF, ORF, RW2, DNG, TIFF) are walked
 *   properly: follow the IFD chain plus SubIFD/ExifIFD links and collect every
 *   image block. This is exact — no guessing where the bytes start.
 *
 *   Anything else (CR3 is ISO-BMFF, RAF has a Fujifilm header) gets a bounded
 *   scan for JPEG start/end markers over the front of the file, which is where
 *   previews live in practice.
 *
 * Candidates are then validated by their SOF marker and sorted by pixel area.
 * Validation is what makes this safe: a CR2's sensor data is *also* a JPEG
 * stream by tag, but a lossless one (SOF3) that no browser can decode, and an
 * ARW's largest block is 47 MB of uncompressed pixels. Checking the marker
 * rejects both without attempting a decode.
 *
 * Orientation has to travel separately. An embedded preview is a bare JPEG with
 * no APP1/Exif segment (verified on Canon and Sony files), so the rotation flag
 * only exists in the parent file's IFD0 and `imageOrientation: 'from-image'`
 * has nothing to read. We return it and the caller applies it.
 */

export interface RawPreview {
  /** JPEG bytes, or null when the file has no usable preview. */
  blob: Blob | null;
  /** EXIF orientation (1-8) from the parent file. 1 means upright. */
  orientation: number;
  width: number;
  height: number;
}

/** Reject previews smaller than this; they're thumbnails, not previews. */
const MIN_WIDTH = 800;
/** How far into a non-TIFF file to scan for JPEG markers. */
const SCAN_BYTES = 12 << 20;
/** Enough to cover the IFD tables of every real-world RAW. */
const HEADER_BYTES = 1 << 20;

// TIFF tags we care about.
const STRIP_OFFSETS = 273;
const STRIP_BYTE_COUNTS = 279;
const COMPRESSION = 259;
const SUB_IFD = 330;
const EXIF_IFD = 34665;
const ORIENTATION = 274;
const THUMB_OFFSET = 513;
const THUMB_LENGTH = 514;
const COMPRESSION_JPEG = 6;

const TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

interface Candidate { offset: number; length: number; }

/** A JPEG we have parsed far enough to trust. */
interface Validated { offset: number; length: number; width: number; height: number; }

/**
 * Baseline, extended-sequential and progressive are decodable by browsers.
 * Everything else in the SOF range (notably SOF3, lossless — which is how CR2
 * stores its sensor data) is not.
 */
const DECODABLE_SOF = new Set([0xc0, 0xc1, 0xc2]);
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * Read a JPEG's SOF marker to get its real dimensions and confirm a browser can
 * decode it. Returns null for anything that isn't a usable JPEG.
 */
function readSof(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i < bytes.length - 8) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;   // EOI/scan before SOF
    const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
    if (segLen < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      if (!DECODABLE_SOF.has(marker)) return null;
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + segLen;
  }
  return null;
}

/** Walk the TIFF IFDs, collecting image blocks and the orientation flag. */
function readTiff(head: Uint8Array): { candidates: Candidate[]; orientation: number } | null {
  if (head.length < 8) return null;
  const le = head[0] === 0x49 && head[1] === 0x49;
  const be = head[0] === 0x4d && head[1] === 0x4d;
  if (!le && !be) return null;

  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const u16 = (o: number) => view.getUint16(o, le);
  const u32 = (o: number) => view.getUint32(o, le);

  const candidates: Candidate[] = [];
  let orientation = 1;
  const seen = new Set<number>();
  const queue: number[] = [u32(4)];

  while (queue.length) {
    const start = queue.shift()!;
    // Offsets past the header window belong to IFDs we can't reach cheaply;
    // skipping them only costs us a candidate, never correctness.
    if (!start || seen.has(start) || start + 2 > head.length) continue;
    seen.add(start);

    const count = u16(start);
    if (count > 512) continue;                      // not a real IFD
    const end = start + 2 + count * 12;
    if (end + 4 > head.length) continue;

    const tags = new Map<number, number>();
    for (let n = 0; n < count; n++) {
      const e = start + 2 + n * 12;
      const tag = u16(e);
      const type = u16(e + 2);
      const len = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 4) * len;
      let value: number;
      if (size <= 4) {
        value = type === 3 || type === 8 ? u16(e + 8) : u32(e + 8);
      } else {
        // Values longer than 4 bytes live elsewhere; we only need the first.
        const at = u32(e + 8);
        if (at + 4 > head.length) continue;
        value = type === 3 || type === 8 ? u16(at) : u32(at);
      }
      tags.set(tag, value);
    }

    if (orientation === 1) {
      const o = tags.get(ORIENTATION);
      if (o && o >= 1 && o <= 8) orientation = o;
    }

    // Strips are only JPEG when Compression says so; an ARW's biggest strip is
    // raw uncompressed pixels.
    const so = tags.get(STRIP_OFFSETS);
    const sl = tags.get(STRIP_BYTE_COUNTS);
    if (so && sl && tags.get(COMPRESSION) === COMPRESSION_JPEG) {
      candidates.push({ offset: so, length: sl });
    }
    // The 513/514 pair is a JPEG by definition.
    const to = tags.get(THUMB_OFFSET);
    const tl = tags.get(THUMB_LENGTH);
    if (to && tl) candidates.push({ offset: to, length: tl });

    const next = u32(end);
    if (next) queue.push(next);
    for (const link of [SUB_IFD, EXIF_IFD]) {
      const at = tags.get(link);
      if (at) queue.push(at);
    }
  }
  return { candidates, orientation };
}

/** Bounded scan for complete JPEG streams, for containers we can't parse. */
function scanForJpegs(bytes: Uint8Array): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xd8 || bytes[i + 2] !== 0xff) continue;
    // Find this stream's EOI. Scanning forward is fine — a truncated tail just
    // means no candidate here.
    for (let j = i + 2; j + 1 < bytes.length; j++) {
      if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
        out.push({ offset: i, length: j + 2 - i });
        i = j + 1;
        break;
      }
    }
  }
  return out;
}

async function extract(file: File): Promise<RawPreview> {
  const headSize = Math.min(file.size, HEADER_BYTES);
  const head = new Uint8Array(await file.slice(0, headSize).arrayBuffer());

  const tiff = readTiff(head);
  const orientation = tiff?.orientation ?? 1;

  let candidates = tiff?.candidates ?? [];
  if (!candidates.length) {
    const scanSize = Math.min(file.size, SCAN_BYTES);
    const buf = scanSize <= headSize
      ? head
      : new Uint8Array(await file.slice(0, scanSize).arrayBuffer());
    candidates = scanForJpegs(buf);
  }

  // Validate biggest-first and stop at the first usable one.
  const bySize = candidates
    .filter(c => c.offset > 0 && c.length > 1024 && c.offset + c.length <= file.size)
    .sort((a, b) => b.length - a.length);

  let best: Validated | null = null;
  for (const c of bySize) {
    const probe = new Uint8Array(
      await file.slice(c.offset, c.offset + Math.min(c.length, 1 << 16)).arrayBuffer(),
    );
    const sof = readSof(probe);
    if (!sof) continue;
    if (sof.width < MIN_WIDTH) continue;
    best = { ...c, ...sof };
    break;
  }

  if (!best) return { blob: null, orientation, width: 0, height: 0 };
  return {
    blob: file.slice(best.offset, best.offset + best.length, 'image/jpeg'),
    orientation,
    width: best.width,
    height: best.height,
  };
}

self.onmessage = async (e: MessageEvent<{ id: number; file: File }>) => {
  const { id, file } = e.data;
  try {
    const result = await extract(file);
    (self as unknown as Worker).postMessage({ id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
