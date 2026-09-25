/**
 * Native TLS for the WS listener: MESH_TLS_CERT + MESH_TLS_KEY, and the CA the
 * border verifies the peers it dials against: MESH_TLS_CA.
 *
 * Each accepts a PATH or PEM CONTENT. A value that begins `-----BEGIN` is
 * content; anything else is a path, since no path can start that way. Literal
 * two-character `\n` sequences in content become newlines: that is the most
 * common way a multi-line value is mangled on its way through an env var, and
 * left alone the parse fails with an error that reads like a bad certificate
 * rather than an escaping problem. No base64 mode: a third encoding is a third
 * thing to get wrong.
 *
 * REFUSE, DON'T DEGRADE. Exactly one of CERT/KEY set is a refusal naming the
 * missing one. A half-configured TLS that fell back to plaintext is a silent
 * downgrade: the operator believes the bus is encrypted, and it is not. The
 * same goes for a certificate or key that cannot be read or parsed, or a key
 * that does not match the certificate. All of these fail at boot, not at the
 * first handshake.
 *
 * THE KEY'S CONTENT NEVER REACHES A LOG, AN ERROR OR THE BOOT LINE. A key in
 * the environment is already visible through `docker inspect` and
 * `/proc/<pid>/environ` — the deployer's accepted trade — and nothing here adds
 * a third copy. Every key error below is a fixed sentence plus, at most, the
 * PATH it was read from. The same care covers the underlying parser messages:
 * they are not forwarded for the key, because nothing guarantees they never
 * quote their input.
 */
import { readFileSync } from 'fs';
import { X509Certificate, createPrivateKey, type KeyObject } from 'crypto';
import { createSecureContext } from 'tls';

export interface ServerTls {
  cert: string;
  key: string;
  /** Parsed from the CERT only — this is what the boot line may say. */
  info: { subject: string; sans: string[]; not_after: string; not_after_ms: number };
}

export type TlsLoad =
  | { ok: true; server: ServerTls | null; ca: string | null }
  | { ok: false; error: string };

const PEM_START = '-----BEGIN';

/** Content or path → PEM text. `what` is the env var name, for messages. */
function readPemSetting(what: string, value: string, secret: boolean): { ok: true; pem: string } | { ok: false; error: string } {
  if (value.startsWith(PEM_START)) return { ok: true, pem: value.replace(/\\n/g, '\n') };
  try {
    return { ok: true, pem: readFileSync(value, 'utf8') };
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unreadable';
    // A path is not the secret; its CONTENT is. Naming the path is what makes
    // the refusal actionable.
    return { ok: false, error: `${what}: cannot read ${secret ? 'key' : 'file'} at path ${JSON.stringify(value)} (${code})` };
  }
}

function certInfo(cert: X509Certificate): ServerTls['info'] {
  return {
    subject: cert.subject,
    sans: (cert.subjectAltName ?? '').split(',').map(s => s.trim()).filter(s => s !== ''),
    not_after: cert.validTo,
    not_after_ms: Date.parse(cert.validTo),
  };
}

export function loadTls(env: Record<string, string | undefined>): TlsLoad {
  const certVal = env.MESH_TLS_CERT === '' ? undefined : env.MESH_TLS_CERT;
  const keyVal = env.MESH_TLS_KEY === '' ? undefined : env.MESH_TLS_KEY;
  const caVal = env.MESH_TLS_CA === '' ? undefined : env.MESH_TLS_CA;

  let server: ServerTls | null = null;
  if (certVal !== undefined || keyVal !== undefined) {
    if (certVal === undefined) {
      return { ok: false, error: 'MESH_TLS_KEY is set but MESH_TLS_CERT is not; set both to serve TLS, or neither to serve plain HTTP — a half configuration is refused rather than served as plaintext' };
    }
    if (keyVal === undefined) {
      return { ok: false, error: 'MESH_TLS_CERT is set but MESH_TLS_KEY is not; set both to serve TLS, or neither to serve plain HTTP — a half configuration is refused rather than served as plaintext' };
    }
    const certPem = readPemSetting('MESH_TLS_CERT', certVal, false);
    if (!certPem.ok) return certPem;
    const keyPem = readPemSetting('MESH_TLS_KEY', keyVal, true);
    if (!keyPem.ok) return keyPem;

    let cert: X509Certificate;
    try { cert = new X509Certificate(certPem.pem); } catch (err) {
      return { ok: false, error: `MESH_TLS_CERT is not a valid PEM certificate (${String((err as Error).message ?? err)})` };
    }
    let key: KeyObject;
    try { key = createPrivateKey(keyPem.pem); } catch {
      return { ok: false, error: 'MESH_TLS_KEY is unreadable: not a PEM private key this runtime can parse' };
    }
    if (!cert.checkPrivateKey(key)) {
      return { ok: false, error: 'MESH_TLS_KEY does not match the certificate in MESH_TLS_CERT' };
    }
    // The last word goes to what the listener will actually build: a pair that
    // passes the checks above but not this would otherwise fail at listen().
    try { createSecureContext({ cert: certPem.pem, key: keyPem.pem }); } catch {
      return { ok: false, error: 'MESH_TLS_CERT/MESH_TLS_KEY were parsed but TLS could not be configured with them' };
    }
    server = { cert: certPem.pem, key: keyPem.pem, info: certInfo(cert) };
  }

  let ca: string | null = null;
  if (caVal !== undefined) {
    const caPem = readPemSetting('MESH_TLS_CA', caVal, false);
    if (!caPem.ok) return caPem;
    try { new X509Certificate(caPem.pem); } catch (err) {
      return { ok: false, error: `MESH_TLS_CA is not a valid PEM certificate (${String((err as Error).message ?? err)})` };
    }
    ca = caPem.pem;
  }
  return { ok: true, server, ca };
}

export const EXPIRY_WARN_DAYS = 14;

/**
 * The boot warning for a certificate that is expired or close to it, or null.
 * Ranges are stood up months apart: an expired certificate should announce
 * itself at deploy, not at the first peering that fails its handshake.
 */
export function expiryWarning(info: ServerTls['info'], now: number): Record<string, unknown> | null {
  const daysLeft = Math.floor((info.not_after_ms - now) / 86_400_000);
  if (info.not_after_ms > now && daysLeft >= EXPIRY_WARN_DAYS) return null;
  return {
    evt: 'ws.tls_cert_expiry',
    not_after: info.not_after,
    days_left: daysLeft,
    note: info.not_after_ms <= now
      ? 'the WS listener certificate has EXPIRED; every client that verifies it will refuse to connect'
      : `the WS listener certificate expires in under ${EXPIRY_WARN_DAYS} days; rotating it is a restart`,
    at: now,
  };
}
