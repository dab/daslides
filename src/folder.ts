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

// Web-native + RAW/TIFF (the latter decoded via embedded JPEG preview).
// This list is authoritative: we used to accept anything with an `image/*` MIME
// type, which let in SVG (createImageBitmap can't decode it), ICO (a 32px icon
// shown fullscreen) and — worst — the `._NAME.ARW` AppleDouble sidecars macOS
// writes onto FAT camera cards. Those match the extension of the real file, so a
// 500-photo card reported 1,000 images, half of them unreadable 4 KB stubs that
// shuffle would happily land on.
const IMG_EXT = /\.(jpe?g|png|webp|avif|heic|heif|gif|bmp|tiff?|cr[23]|nef|arw|raf|rw2|orf|dng)$/i;

const isImage = (name: string) => !name.startsWith('.') && IMG_EXT.test(name);

// One collator, reused. `localeCompare` with an options object builds a new one
// on every call, which on a 20k-photo folder is a multi-second freeze inside the
// input's change handler.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const naturalSort = (a: string, b: string) => collator.compare(a, b);

/**
 * Touch-primary device (phone/tablet). `webkitdirectory` doesn't work on mobile,
 * so the UI leads with the multi-file photo picker instead of "Choose folder".
 */
export const isTouchPrimary = (): boolean =>
  (matchMedia('(pointer: coarse)').matches && !matchMedia('(pointer: fine)').matches) ||
  // An iPad with a Magic Keyboard or a mouse reports a fine pointer, but
  // webkitdirectory still doesn't work there — so it must not be offered the
  // folder picker as its primary action.
  isIOS();

/** iPhone/iPad, including iPadOS which reports itself as a Mac. */
export const isIOS = (): boolean =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

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
    if (!isImage(f.name)) continue;
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

/** The bundled sample photos, fetched one at a time as the slideshow reaches them. */
export function sampleEntries(): ImageEntry[] {
  return __SAMPLE_SLIDES__.map((name) => ({
    name,
    path: name,
    getFile: async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}slides/${name}`);
      if (!res.ok) throw new Error(`sample ${name}: HTTP ${res.status}`);
      return new File([await res.blob()], name);
    },
  }));
}

/**
 * Collect the entries of a drop. Must be called synchronously inside the `drop`
 * handler — the DataTransfer is emptied as soon as the event returns.
 */
export function droppedEntries(dt: DataTransfer): FileSystemEntry[] {
  return Array.from(dt.items)
    .map((item) => item.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => e !== null);
}

/**
 * Walk dropped folders and files into ImageEntries. Only names are listed;
 * each file is opened on demand, as with a picked folder.
 */
export async function entriesFromDrop(
  roots: FileSystemEntry[],
  opts: { name?: string; onProgress?: (count: number) => void } = {},
): Promise<{ name: string; files: ImageEntry[] }> {
  const files: ImageEntry[] = [];

  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      if (!isImage(entry.name)) return;
      const fileEntry = entry as FileSystemFileEntry;
      files.push({
        name: entry.name,
        path: entry.fullPath.replace(/^\//, ''),
        getFile: () => new Promise<File>((res, rej) => fileEntry.file(res, rej)),
      });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most ~100 entries per call; read until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      await Promise.all(batch.map(walk));
      opts.onProgress?.(files.length);
    }
  };

  await Promise.all(roots.map(walk));
  files.sort((a, b) => naturalSort(a.path, b.path));
  const name = roots.length === 1 && roots[0].isDirectory ? roots[0].name : opts.name ?? 'Dropped photos';
  return { name, files };
}
