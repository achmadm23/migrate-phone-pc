import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import exifr from 'exifr';
import { mediaKind, readHead } from './organize';

/** A file on this PC offered for download to the phone. Files are served in place, never copied. */
export interface SharedFile {
  id: string;
  path: string;
  name: string;
  size: number;
  addedAt: number;
  downloads: number;
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.webm': 'video/webm', '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.pdf': 'application/pdf', '.txt': 'text/plain', '.zip': 'application/zip',
};

export class Outbox {
  private readonly files = new Map<string, SharedFile>();

  list(): SharedFile[] {
    return [...this.files.values()].sort((a, b) => b.addedAt - a.addedAt);
  }

  get(id: string): SharedFile | undefined {
    return this.files.get(id);
  }

  async add(paths: string[]): Promise<number> {
    const known = new Set([...this.files.values()].map((f) => f.path.toLowerCase()));
    let added = 0;
    for (const file of paths) {
      if (known.has(file.toLowerCase())) continue;
      const stats = await fsp.stat(file).catch(() => null);
      if (!stats?.isFile()) continue;
      const id = crypto.randomBytes(12).toString('hex');
      this.files.set(id, { id, path: file, name: path.basename(file), size: stats.size, addedAt: Date.now(), downloads: 0 });
      known.add(file.toLowerCase());
      added++;
    }
    return added;
  }

  remove(id: string): void {
    this.files.delete(id);
  }

  clear(): void {
    this.files.clear();
  }
}

/**
 * Streams a file with single-range support, so phones can resume downloads and seek in videos.
 * `inline` shows it in the browser instead of downloading. Returns true when it sent the file from the start.
 */
export async function serveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  name: string,
  inline = false,
): Promise<boolean> {
  const stats = await fsp.stat(filePath).catch(() => null);
  if (!stats?.isFile()) {
    res.writeHead(410, { 'content-type': 'text/plain' });
    res.end('This file is no longer on the PC.');
    return false;
  }
  const size = stats.size;

  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return false;
    }
    status = 206;
  }

  const asciiName = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const headers: http.OutgoingHttpHeaders = {
    'content-type': MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
    'content-length': size === 0 ? 0 : end - start + 1,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'accept-ranges': 'bytes',
    'cache-control': inline ? 'private, max-age=3600' : 'no-store',
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);

  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return false;
  }
  await pipeline(fs.createReadStream(filePath, { start, end }), res).catch(() => undefined);
  return start === 0;
}

/**
 * Small preview for a list: the camera's embedded EXIF thumbnail when the photo has one
 * (a few KB instead of several MB), otherwise the file itself shown inline.
 */
export async function servePreview(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  filePath: string,
  name: string,
): Promise<void> {
  if (mediaKind(name) === 'image') {
    try {
      const thumb = await exifr.thumbnail(await readHead(filePath, 256 * 1024));
      if (thumb) {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' });
        res.end(Buffer.from(thumb));
        return;
      }
    } catch {
      // no usable thumbnail
    }
  }
  await serveFile(req, res, filePath, name, true);
}

/** Download of a shared file; counts completed-from-start downloads. */
export async function serveShared(req: http.IncomingMessage, res: http.ServerResponse, file: SharedFile): Promise<void> {
  if (await serveFile(req, res, file.path, file.name)) file.downloads++;
}

