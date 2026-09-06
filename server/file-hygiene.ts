/**
 * Filename and content-type hygiene, shared by the INGEST and SERVING paths.
 *
 * #68 made serving safe: `contentDispositionFor` / `safeContentType` sanitize at
 * response time, which covers every row that already exists. #70 is the other
 * half — normalise at insert time so poison never reaches the database at all.
 *
 * WHY BOTH, when serving is already safe. Serving-safe protects ONE consumer:
 * the file download route. These columns are read by anything that comes later —
 * a UI, an export, a log line, a future admin listing — and each of those
 * inherits the raw value. Sanitising at the boundary you happen to have today
 * protects the consumers you happen to have today.
 *
 * THIS MODULE EXISTS SO THE GRAMMAR HAS ONE HOME. The alternative was importing
 * the serving helper from `http-admin.ts` into `db.ts`, which would make the
 * storage layer depend on the HTTP layer for a rule that is about neither. Two
 * copies of the regex would be worse still: they would agree today and diverge
 * on the first fix, and the ingest copy would be the one nobody re-checked.
 */

/**
 * A well-formed `type/subtype` with optional parameters, printable ASCII only.
 * The single authority for what a content-type may be, used at both ends.
 */
export const SAFE_CONTENT_TYPE =
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[\x20-\x7e]*)?$/;

/**
 * A content-type safe to store and to serve. Anything malformed becomes
 * `application/octet-stream` rather than being rejected: the file's BYTES are
 * fine, and refusing the upload over a bad type label would turn a cosmetic
 * problem into a delivery failure.
 */
export function safeContentType(ct: string | null | undefined): string {
  if (typeof ct === 'string' && ct.length <= 256 && SAFE_CONTENT_TYPE.test(ct)) return ct;
  return 'application/octet-stream';
}

/**
 * A filename safe to store.
 *
 * UNICODE IS KEPT. The RFC 5987 `filename*` path serves it correctly, so
 * stripping it would damage legitimate names — an attachment called `报告.pdf`
 * is not a security problem. What is removed is the set that can break a header
 * or a log line if some future consumer interpolates it without escaping: C0
 * controls (including CR and LF) and DEL.
 *
 * C1 (0x80-0x9f) is deliberately NOT stripped. It is control-like in
 * latin1 but ordinary text in UTF-8, `encodeURIComponent` handles it, and the
 * serving path's ASCII fallback already replaces it. Removing it here would cost
 * real filenames for no reachable gain.
 *
 * An empty result falls back to `file`: a stored empty filename is a hole every
 * downstream consumer has to special-case, and the caller's intent — "a file
 * with a name" — is better served by a placeholder than by nothing.
 */
export function safeFilename(name: string | null | undefined): string {
  if (typeof name !== 'string') return 'file';
  // eslint-disable-next-line no-control-regex -- the control set is the point
  const stripped = name.replace(/[\x00-\x1f\x7f]/g, '');
  return stripped.length > 0 ? stripped : 'file';
}
