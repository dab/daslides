/**
 * Folder picking + image enumeration.
 * Uses File System Access API where available, falls back to <input webkitdirectory>.
 */

export interface ImageEntry {
  /** Display name (basename) */
  name: string;
  /** Path relative to the chosen folder root */
  path: string;
  /** Lazily resolved File handle source: either a FileSystemFileHandle or a direct File */
  getFile: () => Promise<File>;
}

// Web-native + RAW/TIFF (the latter decoded via embedded JPEG preview)
const IMG_EXT = /\.(jpe?g|png|webp|avif|heic|heif|gif|bmp|tiff?|cr[23]|nef|arw|raf|rw2|orf|dng)$/i;
const IMG_MIME = /^image\//;

const isImage = (name: string, type?: string) =>
  (type && IMG_MIME.test(type)) || IMG_EXT.test(name);

const naturalSort = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** True if the modern picker is usable. */
export const hasDirectoryPicker = () =>
  typeof (window as any).showDirectoryPicker === 'function';

/**
 * Brave exposes `showDirectoryPicker` but blocks the call (File System Access
 * API disabled by default), so the picker silently fails. Detect Brave and skip
 * FSA entirely — the `<input webkitdirectory>` fallback works there.
 */
export async function isBrave(): Promise<boolean> {
  try {
    const b = (navigator as any).brave;
    return !!(b && typeof b.isBrave === 'function' && (await b.isBrave()));
  } catch {
    return false;
  }
}

/**
 * Touch-primary device (phone/tablet). `webkitdirectory` doesn't work on mobile,
 * so the UI leads with the multi-file photo picker instead of "Choose folder".
 */
export const isTouchPrimary = (): boolean =>
  matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches;

/** Open the directory picker. Returns { name, files }. */
export async function pickDirectory(): Promise<{ name: string; files: ImageEntry[] }> {
  if (hasDirectoryPicker()) {
    const dir = await (window as any).showDirectoryPicker({
      mode: 'read',
      startIn: 'pictures',
      id: 'slideshow-folder',
    });
    const files = await collectFromHandle(dir, '');
    files.sort((a, b) => naturalSort(a.path, b.path));
    return { name: dir.name, files };
  }
  throw new Error('No directory picker; use the file input fallback.');
}

async function collectFromHandle(
  dir: any,
  prefix: string,
): Promise<ImageEntry[]> {
  const out: ImageEntry[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file') {
      if (!isImage(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push({
        name: entry.name,
        path,
        getFile: () => entry.getFile(),
      });
    } else if (entry.kind === 'directory') {
      const sub = await collectFromHandle(entry, prefix ? `${prefix}/${entry.name}` : entry.name);
      out.push(...sub);
    }
  }
  return out;
}

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
