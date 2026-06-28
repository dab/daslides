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

/** Fallback: turn a FileList from <input webkitdirectory> into ImageEntries. */
export function entriesFromFileList(list: FileList): { name: string; files: ImageEntry[] } {
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
  return { name: root || 'Selected files', files };
}
