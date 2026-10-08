import fs from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.webp', '.dng', '.tif', '.tiff', '.avif', '.bmp']);
const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v', '.3gp', '.avi', '.webm', '.mkv']);

export function mediaKind(name: string): 'image' | 'video' | null {
  const ext = path.extname(name).toLowerCase();
  return IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : null;
}

const MEDIA_EXT = new Set([
  '.jpg', '.jpeg', '.heic', '.heif', '.png', '.gif', '.webp', '.dng', '.tif', '.tiff',
  '.mov', '.mp4', '.m4v', '.3gp', '.avi',
]);
const EXIF_EXT = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png', '.tif', '.tiff', '.dng']);

export interface FileMeta {
  name: string;
  size: number;
  lastModified: number;
}

/** Capture date from EXIF when available, otherwise the file's lastModified reported by the phone. */
async function captureDate(file: string, ext: string, fallbackMs: number): Promise<Date> {
  if (EXIF_EXT.has(ext)) {
    try {
      // Pass a buffer: given a path, exifr leaves file handles open.
      const tags = await exifr.parse(await readHead(file, 64 * 1024 * 1024), ['DateTimeOriginal', 'CreateDate']);
      const date = tags?.DateTimeOriginal ?? tags?.CreateDate;
      if (date instanceof Date && !isNaN(date.getTime())) return date;
    } catch {
      // unreadable EXIF -> fall back
    }
  }
  return new Date(fallbackMs);
}

/** Reads at most `limit` bytes from the start of a file. */
export async function readHead(file: string, limit: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(limit, (await handle.stat()).size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

async function uniquePath(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const { name: base, ext } = path.parse(name);
  let candidate = path.join(dir, name);
  for (let i = 1; await exists(candidate); i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

/** Photos/videos go to Photos/YYYY/MM, everything else to Files. Never overwrites. */
export async function destinationFor(root: string, uploadedFile: string, meta: FileMeta): Promise<string> {
  const ext = path.extname(meta.name).toLowerCase();
  if (!MEDIA_EXT.has(ext)) return uniquePath(path.join(root, 'Files'), meta.name);

  const date = await captureDate(uploadedFile, ext, meta.lastModified);
  const dir = path.join(
    root,
    'Photos',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
  );
  return uniquePath(dir, meta.name);
}
