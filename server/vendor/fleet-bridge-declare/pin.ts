// A real certificate pin for fetch (W-1469). Passing `tls: { ca }` alone is no pin: on Bun 1.3.14
// it is added to the default roots, so any publicly trusted certificate for the name passes too.
// This checks the server's certificate itself, on every request:
//   - `checkServerIdentity` runs the usual host check, then requires the presented certificate
//     to be the pinned one, by its SHA-256 fingerprint (our pins are self-signed leaf certs);
//   - `keepalive: false`, because Bun skips the checker on a pooled connection, so after one
//     good request a wrong certificate would otherwise be accepted (measured on 1.3.14, W-930);
//   - `ca` is still given, so the self-signed certificate is trusted at all.
// Every fetch to a pinned host spreads these options in, and nothing else is set alongside them.
import { createHash, X509Certificate } from 'node:crypto';
import { checkServerIdentity as hostCheck, type PeerCertificate } from 'node:tls';

export interface PinnedFetchOptions {
  keepalive: false;
  tls: { ca: string; checkServerIdentity: (host: string, cert: PeerCertificate) => Error | undefined };
}

const fingerprint = (der: Buffer) => createHash('sha256').update(der).digest('hex');
const made = new Map<string, PinnedFetchOptions>();

/** The fetch options that pin `pem`, a certificate. Throws if it isn't one, so a bad pin fails at startup. */
export function pinnedFetchOptions(pem: string): PinnedFetchOptions {
  const known = made.get(pem);
  if (known !== undefined) return known;
  let want: string;
  try {
    want = fingerprint(Buffer.from(new X509Certificate(pem).raw));
  } catch {
    throw new Error('pinnedFetchOptions: the pin is not a certificate (PEM)');
  }
  const options: PinnedFetchOptions = {
    keepalive: false,
    tls: {
      ca: pem,
      checkServerIdentity(host, cert) {
        const wrongHost = hostCheck(host, cert);
        if (wrongHost) return wrongHost;
        if (!cert?.raw || fingerprint(Buffer.from(cert.raw)) !== want) return new Error(`the certificate ${host} presented is not the pinned one`);
        return undefined;
      },
    },
  };
  made.set(pem, options);
  return options;
}
