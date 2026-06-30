/**
 * Image enumeration from a picked FileList.
 *
 * Picking is done with native `<input>` elements opened by `<label for>` (see
 * index.html): `webkitdirectory` for desktop folder selection, plain `multiple`
 * for universal/mobile photo selection. The native label avoids the
 * user-gesture and File System Access API pitfalls (Brave blocks the FSA picker;
 * `showDirectoryPicker` after an `await` loses the gesture). `entriesFromFileList`
 * turns either selection into `ImageEntry[]`.
 */

export interface ImageEntry {
  /** Display name (basename) */
  name: string;
  /** Path relative to the chosen folder root (or just the filename) */
  path: string;
  /** Lazily resolved File (read on demand, never eagerly) */
  getFile: () => Promise<File>;
}

// Web-native + RAW/TIFF (the latter decoded via embedded JPEG preview)
const IMG_EXT = /\.(jpe?g|png|webp|avif|heic|heif|gif|bmp|tiff?|cr[23]|nef|arw|raf|rw2|orf|dng)$/i;
const IMG_MIME = /^image\//;

const isImage = (name: string, type?: string) =>
  (type && IMG_MIME.test(type)) || IMG_EXT.test(name);

const naturalSort = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Touch-primary device (phone/tablet). `webkitdirectory` doesn't work on mobile,
 * so the UI leads with the multi-file photo picker instead of "Choose folder".
 */
export const isTouchPrimary = (): boolean =>
  matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;

/**
 * Fallback: turn a FileList into ImageEntries. Handles both a directory
 * selection (`<input webkitdirectory>`, files carry `webkitRelativePath`) and a
 * flat multi-file selection (`<input multiple>`, used on mobile / as a universal
 * escape hatch). `fallbackName` labels the latter when there's no folder root.
 */
export function entriesFromFileList(
  list: FileList,
  fallbackName = 'Selected files',
): { name: string; files: ImageEntry[] } {
  const files: ImageEntry[] = [];
  let root = '';
  for (const f of Array.from(list)) {
    if (!isImage(f.name, f.type)) continue;
    const rel = (f as any).webkitRelativePath as string | undefined;
    const path = rel || f.name;
    if (!root && rel) root = rel.split('/')[0];
    files.push({
      name: f.name,
      path,
      getFile: async () => f,
    });
  }
  files.sort((a, b) => naturalSort(a.path, b.path));
  return { name: root || fallbackName, files };
}
