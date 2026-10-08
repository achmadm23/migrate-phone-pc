import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { destinationFor, FileMeta } from './organize';

export const MAX_CHUNK = 16 * 1024 * 1024;

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/**
 * Resumable upload storage. Each file is appended to `.incoming/<id>.part`;
 * the current size of that file is the resume offset. Finished files are
 * recorded in `.manifest.json` so re-selected files are skipped.
 */
export class Store {
  private readonly incoming: string;
  private readonly manifestPath: string;
  private manifest: Record<string, string> = {};
  private readonly busy = new Set<string>();
  private finalizing: Promise<unknown> = Promise.resolve();

  constructor(readonly root: string) {
    this.incoming = path.join(root, '.incoming');
    this.manifestPath = path.join(root, '.manifest.json');
  }

  get completedCount(): number {
    return Object.keys(this.manifest).length;
  }

  /** Absolute path of a finished upload, or undefined if it isn't in this folder's manifest. */
  pathFor(id: string): string | undefined {
    return this.manifest[id] ? path.join(this.root, this.manifest[id]) : undefined;
  }

  async load(): Promise<void> {
    await fs.mkdir(this.incoming, { recursive: true });
    try {
      this.manifest = JSON.parse(await fs.readFile(this.manifestPath, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async init(meta: FileMeta): Promise<{ id: string; status: 'done' } | { id: string; status: 'partial'; offset: number }> {
    const id = crypto
      .createHash('sha1')
      .update(`${meta.name}\0${meta.size}\0${meta.lastModified}`)
      .digest('hex');
    if (this.manifest[id]) return { id, status: 'done' };

    await fs.writeFile(this.metaPath(id), JSON.stringify(meta));
    await fs.appendFile(this.partPath(id), '');
    return { id, status: 'partial', offset: await this.partSize(id) };
  }

  /** Appends one chunk starting at `offset`. Returns the new offset. */
  async append(id: string, offset: number, body: Readable): Promise<number> {
    const meta = await this.readMeta(id);
    if (this.busy.has(id)) throw new HttpError(503, 'upload busy');
    this.busy.add(id);
    try {
      const current = await this.partSize(id);
      if (offset !== current) throw new HttpError(409, 'offset mismatch', { offset: current });

      const limit = Math.min(MAX_CHUNK, meta.size - current);
      let seen = 0;
      const guard = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          if (seen > limit) cb(new HttpError(413, 'chunk too large'));
          else cb(null, chunk);
        },
      });
      await pipeline(body, guard, createWriteStream(this.partPath(id), { flags: 'a' }));
      return this.partSize(id);
    } finally {
      this.busy.delete(id);
    }
  }

  /** Moves a fully uploaded file into place. Returns its path relative to root. */
  complete(id: string): Promise<string> {
    // Serialized so two files with the same name never pick the same destination.
    const run = this.finalizing.then(() => this.finalize(id));
    this.finalizing = run.catch(() => undefined);
    return run;
  }

  private async finalize(id: string): Promise<string> {
    if (this.manifest[id]) return this.manifest[id];
    if (this.busy.has(id)) throw new HttpError(503, 'upload busy');

    const meta = await this.readMeta(id);
    const size = await this.partSize(id);
    if (size !== meta.size) throw new HttpError(409, 'upload incomplete', { offset: size });

    const dest = await destinationFor(this.root, this.partPath(id), meta);
    await fs.rename(this.partPath(id), dest);
    await fs.rm(this.metaPath(id), { force: true });

    this.manifest[id] = path.relative(this.root, dest);
    const tmp = `${this.manifestPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.manifest, null, 1));
    await fs.rename(tmp, this.manifestPath);
    return this.manifest[id];
  }

  private partPath(id: string): string {
    return path.join(this.incoming, `${id}.part`);
  }

  private metaPath(id: string): string {
    return path.join(this.incoming, `${id}.json`);
  }

  private async partSize(id: string): Promise<number> {
    try {
      return (await fs.stat(this.partPath(id))).size;
    } catch {
      throw new HttpError(404, 'unknown upload');
    }
  }

  private async readMeta(id: string): Promise<FileMeta> {
    try {
      return JSON.parse(await fs.readFile(this.metaPath(id), 'utf8'));
    } catch {
      throw new HttpError(404, 'unknown upload');
    }
  }
}
