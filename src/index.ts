import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { loadTls, TlsMaterial } from './certs';
import { FileMeta, mediaKind } from './organize';
import { Outbox, serveFile, servePreview, serveShared } from './outbox';
import { canPick, pickPaths, PickOptions } from './picker';
import { HttpError, Store } from './store';

const PORT = Number(process.env.PORT) || 8080;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
const SETTINGS_FILE = path.join(__dirname, '..', 'settings.json');
const TOKEN = crypto.randomBytes(9).toString('base64url');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** Command-line/env folder wins, then the folder last chosen on the dashboard, then ./received. */
function initialOutDir(): string {
  const explicit = process.argv[2] || process.env.OUT_DIR;
  if (explicit) return path.resolve(explicit);
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).outDir;
    if (typeof saved === 'string' && path.isAbsolute(saved)) return saved;
  } catch {
    // no saved settings yet
  }
  return path.resolve('received');
}

let store = new Store(initialOutDir());
const outbox = new Outbox();
let pickerOpen = false;
let phoneUrls: string[] = [];
let tls: TlsMaterial;
let caDer: Buffer;

/** Live state shown on the PC dashboard. */
interface ActiveUpload {
  name: string;
  size: number;
  received: number;
  updatedAt: number;
}
const active = new Map<string, ActiveUpload>();
const recent: { id: string; path: string; size: number; at: number }[] = [];
const session = { files: 0, bytes: 0, skipped: 0, bytesReceived: 0 };

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendFile(res: http.ServerResponse, file: string): void {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8').replaceAll('{{HTTPS_PORT}}', String(HTTPS_PORT));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new HttpError(413, 'body too large');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

function safeName(name: string): string {
  let clean = path.basename(name.replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '');
  if (!clean) clean = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(clean)) clean = `_${clean}`;
  return clean.slice(0, 200);
}

function parseMeta(body: any): FileMeta {
  const { name, size, lastModified } = body ?? {};
  if (typeof name !== 'string' || !Number.isSafeInteger(size) || size < 0 || !Number.isFinite(lastModified)) {
    throw new HttpError(400, 'invalid file info');
  }
  return { name: safeName(name), size, lastModified };
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new HttpError(400, 'invalid id');
  return value;
}

/** The dashboard is only reachable from the PC itself. */
function isLocal(req: http.IncomingMessage): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
}

/** Rejects requests addressed to another host name (DNS rebinding from a website). */
function isLocalHost(req: http.IncomingMessage): boolean {
  return [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`].includes(req.headers.host ?? '');
}

function isReceiving(): boolean {
  const now = Date.now();
  return [...active.values()].some((u) => now - u.updatedAt < 30000);
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const stats = await fsp.statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

async function dashboardStatus() {
  return {
    outDir: store.root,
    freeBytes: await freeBytes(store.root),
    canBrowse: canPick,
    receiving: isReceiving(),
    phoneUrls,
    totalFiles: store.completedCount,
    session,
    active: [...active.values()],
    recent: recent.slice(0, 50).map((r) => ({ ...r, kind: mediaKind(r.path) })),
    shared: outbox.list().map(({ path: _path, ...file }) => ({ ...file, kind: mediaKind(file.name) })),
  };
}

async function changeOutDir(input: unknown): Promise<void> {
  const raw = typeof input === 'string' ? input.trim().replace(/^"(.*)"$/, '$1') : '';
  if (!raw) throw new HttpError(400, 'Enter a folder path.');
  if (!path.isAbsolute(raw)) throw new HttpError(400, 'Use a full path, for example D:\\Phone-Backup');
  if (isReceiving()) throw new HttpError(409, 'Wait until the current transfer finishes.');

  const dir = path.resolve(raw);
  if (dir === store.root) return;
  try {
    await fsp.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    await fsp.writeFile(probe, '');
    await fsp.rm(probe);
  } catch (err) {
    throw new HttpError(400, `Can't save to ${dir} (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
  }

  const next = new Store(dir);
  await next.load();
  store = next;
  active.clear();
  recent.length = 0;
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify({ outDir: dir }, null, 2));
  console.log(`\nSaving to: ${dir}  (${store.completedCount} files already there)\n`);
}

/** Runs one native picker at a time on this PC. */
async function withPicker(opts: PickOptions): Promise<string[]> {
  if (!canPick) throw new HttpError(501, 'The file picker is only available on Windows.');
  if (pickerOpen) throw new HttpError(409, 'A file picker is already open on the PC.');
  pickerOpen = true;
  try {
    return await pickPaths(opts);
  } catch {
    throw new HttpError(500, 'Could not open the file picker.');
  } finally {
    pickerOpen = false;
  }
}

async function handleDashboard(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  if (!isLocal(req) || !isLocalHost(req)) throw new HttpError(403, 'dashboard is only available on this PC');

  if (req.method === 'POST') {
    // Custom header forces a CORS preflight, so other websites can't trigger these.
    if (req.headers['x-dashboard'] !== '1') throw new HttpError(403, 'forbidden');
    if (pathname === '/dashboard/output') {
      await changeOutDir((await readJson(req))?.path);
      return sendJson(res, 200, await dashboardStatus());
    }
    if (pathname === '/dashboard/browse') {
      const [dir] = await withPicker({ folder: true, title: 'Choose where to save the phone files', initialDir: store.root });
      return sendJson(res, 200, { path: dir ?? null });
    }
    if (pathname === '/dashboard/share') {
      const files = await withPicker({ folder: false, multiple: true, title: 'Choose files to send to the phone' });
      const added = await outbox.add(files);
      if (added) console.log(`Offering ${added} file(s) to the phone`);
      return sendJson(res, 200, await dashboardStatus());
    }
    if (pathname === '/dashboard/unshare') {
      const id = (await readJson(req))?.id;
      if (id === 'all') outbox.clear();
      else if (typeof id === 'string') outbox.remove(id);
      return sendJson(res, 200, await dashboardStatus());
    }
    throw new HttpError(404, 'not found');
  }

  // /dashboard/{preview|view}/{received|shared}/<id>
  const media = /^\/dashboard\/(preview|view)\/(received|shared)\/([a-f0-9]+)$/.exec(pathname);
  if (media) {
    const [, mode, source, id] = media;
    const file = source === 'shared' ? outbox.get(id) : undefined;
    const filePath = file ? file.path : source === 'received' ? store.pathFor(id) : undefined;
    if (!filePath) throw new HttpError(404, 'not found');
    const name = path.basename(filePath);
    if (mode === 'preview') await servePreview(req, res, filePath, name);
    else await serveFile(req, res, filePath, name, true);
    return;
  }

  if (pathname === '/dashboard') return sendFile(res, 'dashboard.html');
  if (pathname === '/dashboard/status') return sendJson(res, 200, await dashboardStatus());
  if (pathname === '/dashboard/qr.svg') {
    const svg = await QRCode.toString(phoneUrls[0] ?? 'no network', { type: 'svg', margin: 2 });
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
    res.end(svg);
    return;
  }
  throw new HttpError(404, 'not found');
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
    return handleDashboard(req, res, url.pathname);
  }

  if (req.method === 'GET' && url.pathname === '/') {
    if (url.searchParams.get('t') === TOKEN) return sendFile(res, 'index.html');
    if (isLocal(req)) {
      res.writeHead(302, { location: '/dashboard' });
      res.end();
      return;
    }
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Scan the QR code shown on the PC to open this page.');
    return;
  }

  // One-time HTTPS setup for phones. The CA certificate is public, so no token is needed.
  if (req.method === 'GET' && url.pathname === '/setup') return sendFile(res, 'setup.html');
  if (req.method === 'GET' && url.pathname === '/setup/ca.crt') {
    res.writeHead(200, {
      // This type makes iPhone offer to install it as a profile.
      'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="Phone-Transfer-CA.crt"',
      'cache-control': 'no-store',
    });
    res.end(caDer);
    return;
  }
  // Lets the HTTP page test whether the phone already trusts our HTTPS certificate.
  if (req.method === 'GET' && url.pathname === '/api/ping') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end('{"ok":true}');
    return;
  }

  if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
  // Download links can't send headers, so they carry the token in the URL.
  if ((req.headers['x-token'] ?? url.searchParams.get('t')) !== TOKEN) throw new HttpError(403, 'invalid token');

  // /api/{download|preview|view}/<id> for files offered by the PC
  const offered = /^\/api\/(download|preview|view)\/([a-f0-9]+)$/.exec(url.pathname);
  if (offered && (req.method === 'GET' || req.method === 'HEAD')) {
    const [, mode, id] = offered;
    const file = outbox.get(id);
    if (!file) throw new HttpError(404, 'This file is no longer offered by the PC.');
    if (mode === 'download') return serveShared(req, res, file);
    if (mode === 'preview') return servePreview(req, res, file.path, file.name);
    await serveFile(req, res, file.path, file.name, true);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/shared') {
    return sendJson(res, 200, outbox.list().map(({ id, name, size }) => ({ id, name, size, kind: mediaKind(name) })));
  }

  if (req.method === 'POST' && url.pathname === '/api/init') {
    const meta = parseMeta(await readJson(req));
    const result = await store.init(meta);
    if (result.status === 'done') {
      session.skipped++;
    } else {
      active.set(result.id, { name: meta.name, size: meta.size, received: result.offset, updatedAt: Date.now() });
    }
    sendJson(res, 200, result);
  } else if (req.method === 'PUT' && url.pathname === '/api/chunk') {
    const id = parseId(url.searchParams.get('id'));
    const offset = Number(url.searchParams.get('offset'));
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'invalid offset');
    const newOffset = await store.append(id, offset, req);
    session.bytesReceived += newOffset - offset;
    const upload = active.get(id);
    if (upload) Object.assign(upload, { received: newOffset, updatedAt: Date.now() });
    sendJson(res, 200, { offset: newOffset });
  } else if (req.method === 'POST' && url.pathname === '/api/complete') {
    const id = parseId((await readJson(req))?.id);
    const target = store;
    const saved = await target.complete(id);
    const size = fs.statSync(path.join(target.root, saved)).size;
    active.delete(id);
    recent.unshift({ id, path: saved, size, at: Date.now() });
    recent.length = Math.min(recent.length, 200);
    session.files++;
    session.bytes += size;
    console.log(`✓ ${saved}  (${formatBytes(size)})  — ${session.files} files / ${formatBytes(session.bytes)} this session`);
    sendJson(res, 200, { ok: true });
  } else {
    throw new HttpError(404, 'not found');
  }
}

/** Waits for the rest of the request body so the client receives the error response. */
function drain(req: http.IncomingMessage): Promise<void> {
  if (req.readableEnded || req.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    req.once('end', resolve);
    req.once('close', resolve);
    req.resume();
  });
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function lanAddresses(): string[] {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address)
    .filter((ip) => !ip.startsWith('169.254.'));
  // Typical home Wi-Fi ranges first.
  return addresses.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
}

function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
}

async function main(): Promise<void> {
  await store.load();
  const ips = lanAddresses();
  caDer = (tls = await loadTls(ips)).caDer;

  const handler: http.RequestListener = (req, res) => {
    handle(req, res).catch(async (err) => {
      const httpErr = err instanceof HttpError ? err : new HttpError(500, 'server error');
      if (!(err instanceof HttpError) && !req.destroyed) console.error(err);
      await drain(req);
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, httpErr.status, { error: httpErr.message, ...httpErr.extra });
      }
    });
  };

  const listen = (server: http.Server, port: number, envName: string) =>
    new Promise<void>((resolve) => {
      server.on('error', (err: NodeJS.ErrnoException) => {
        console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use. Try: set ${envName}=${port + 1}` : err);
        process.exit(1);
      });
      server.listen(port, '0.0.0.0', resolve);
    });

  // Plain HTTP for the dashboard and first contact; HTTPS for phones that trust our certificate.
  await listen(http.createServer(handler), PORT, 'PORT');
  await listen(https.createServer({ key: tls.key, cert: tls.cert }, handler), HTTPS_PORT, 'HTTPS_PORT');

  // The QR code opens the HTTP page; it switches itself to HTTPS once the phone trusts us.
  phoneUrls = ips.map((ip) => `http://${ip}:${PORT}/?t=${TOKEN}`);
  const dashboardUrl = `http://localhost:${PORT}/dashboard`;
  console.log(`\nSaving to: ${store.root}`);
  console.log(`Already received earlier: ${store.completedCount} files`);
  console.log(`Dashboard: ${dashboardUrl}\n`);
  if (phoneUrls.length === 0) {
    console.log('No LAN address found. Is this PC connected to Wi-Fi/Ethernet?');
  } else {
    console.log(await QRCode.toString(phoneUrls[0], { type: 'terminal', small: true }));
    console.log('Scan the QR code with the phone camera, or open this link in its browser:');
    for (const u of phoneUrls) console.log(`  ${u}`);
    console.log(`Secure version (after the one-time setup on the phone): https://${ips[0]}:${HTTPS_PORT}/?t=${TOKEN}`);
    console.log('\nIf the phone cannot connect, allow Node.js through Windows Firewall on Private networks.\n');
  }
  if (process.env.NO_OPEN !== '1') openInBrowser(dashboardUrl);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
