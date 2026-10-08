import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Node's global WebCrypto (matches the DOM types @peculiar/x509 expects).
const webcrypto = globalThis.crypto;
x509.cryptoProvider.set(webcrypto);

/**
 * HTTPS for the phone page. A local certificate authority is created once and kept in certs/;
 * the phone trusts it after a one-time install. The server certificate is reissued from it
 * whenever this PC's LAN addresses change, so the phone never needs to be set up again.
 */
const DIR = path.join(__dirname, '..', 'certs');
const CA_KEY = path.join(DIR, 'ca.key');
const CA_CERT = path.join(DIR, 'ca.crt');
const SERVER_KEY = path.join(DIR, 'server.key');
const SERVER_CERT = path.join(DIR, 'server.crt');
const SERVER_INFO = path.join(DIR, 'server.json');

const ALG = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
};
const DAY = 24 * 60 * 60 * 1000;

export interface TlsMaterial {
  key: string;
  cert: string;
  /** The CA certificate in DER form, for the phone to install. */
  caDer: Buffer;
}

function toPem(label: string, der: ArrayBuffer): string {
  const base64 = Buffer.from(der).toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

async function exportKey(key: CryptoKey): Promise<string> {
  return toPem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', key));
}

async function importKey(pem: string): Promise<CryptoKey> {
  const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  return webcrypto.subtle.importKey('pkcs8', der, ALG, true, ['sign']);
}

const serial = () => crypto.randomBytes(16).toString('hex').replace(/^[89a-f]/, '1');

async function loadOrCreateCa(): Promise<{ cert: x509.X509Certificate; key: CryptoKey }> {
  if (fs.existsSync(CA_KEY) && fs.existsSync(CA_CERT)) {
    const cert = new x509.X509Certificate(fs.readFileSync(CA_CERT, 'utf8'));
    if (cert.notAfter.getTime() > Date.now() + 30 * DAY) {
      return { cert, key: await importKey(fs.readFileSync(CA_KEY, 'utf8')) };
    }
  }

  const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const host = os.hostname().replace(/[^\w.-]/g, '');
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: `CN=Phone Transfer CA (${host}), O=Phone Transfer`,
    notBefore: new Date(Date.now() - DAY),
    notAfter: new Date(Date.now() + 3650 * DAY),
    keys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  fs.writeFileSync(CA_KEY, await exportKey(keys.privateKey), { mode: 0o600 });
  fs.writeFileSync(CA_CERT, cert.toString('pem'));
  // Any older server certificate came from a different CA.
  fs.rmSync(SERVER_INFO, { force: true });
  console.log('Created a new local certificate authority for HTTPS.');
  return { cert, key: keys.privateKey };
}

export async function loadTls(ips: string[]): Promise<TlsMaterial> {
  fs.mkdirSync(DIR, { recursive: true });
  const ca = await loadOrCreateCa();
  const caThumbprint = Buffer.from(await ca.cert.getThumbprint()).toString('hex');
  const caDer = Buffer.from(ca.cert.rawData);

  try {
    const info = JSON.parse(fs.readFileSync(SERVER_INFO, 'utf8'));
    const stillValid = info.caThumbprint === caThumbprint
      && info.notAfter > Date.now() + 7 * DAY
      && ips.every((ip) => info.ips.includes(ip));
    if (stillValid) {
      return { key: fs.readFileSync(SERVER_KEY, 'utf8'), cert: fs.readFileSync(SERVER_CERT, 'utf8'), caDer };
    }
  } catch {
    // no server certificate yet
  }

  // iOS rejects server certificates valid for more than 825 days or without SAN/serverAuth.
  const keys = await webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const notAfter = new Date(Date.now() + 397 * DAY);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: 'CN=Phone Transfer',
    issuer: ca.cert.subject,
    notBefore: new Date(Date.now() - DAY),
    notAfter,
    signingKey: ca.key,
    publicKey: keys.publicKey,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: 'localhost' },
        { type: 'ip', value: '127.0.0.1' },
        ...ips.map((ip) => ({ type: 'ip' as const, value: ip })),
      ]),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(ca.cert),
    ],
  });

  const key = await exportKey(keys.privateKey);
  const pem = cert.toString('pem');
  fs.writeFileSync(SERVER_KEY, key, { mode: 0o600 });
  fs.writeFileSync(SERVER_CERT, pem);
  fs.writeFileSync(SERVER_INFO, JSON.stringify({ ips, caThumbprint, notAfter: notAfter.getTime() }, null, 2));
  return { key, cert: pem, caDer };
}
