import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { openDb, registerAgent, insertFile, getFile } from '../db.ts';
import { safeFilename, safeContentType } from '../file-hygiene.ts';

// #70 — normalise filename and content_type at INGEST.
//
// #68 already made SERVING safe, so there is no exposure today. This is the
// other half: these columns are read by anything that comes later — a UI, an
// export, a log line — and each inherits the raw value. Sanitising at the
// boundary you happen to have protects the consumers you happen to have.
describe('#70 ingest-side file hygiene', () => {
  describe('safeFilename', () => {
    // The hazard: bytes that break a header or a log line if some future
    // consumer interpolates the name without escaping.
    it('strips C0 controls including CR and LF', () => {
      expect(safeFilename('a\r\nb.txt')).toBe('ab.txt');
      expect(safeFilename('x\x00y.bin')).toBe('xy.bin');
      expect(safeFilename('tab	sep.csv')).toBe('tabsep.csv');
      expect(safeFilename('del\x7f.txt')).toBe('del.txt');
    });

    // THE CONTROL THAT MATTERS MOST. A character class written slightly wrong
    // silently eats ordinary filenames, and every "it strips control chars"
    // test above still passes when it does. This is not hypothetical: an
    // earlier revision of this regex was mangled to /[-]/ — stripping every
    // HYPHEN from every filename — and nothing but a case like this would have
    // caught it before it shipped.
    it('CONTROL: ordinary filenames are untouched', () => {
      for (const name of [
        'report-2026.pdf',        // hyphen — the one that was actually broken
        'a_b.c-d.e f.txt',
        'UPPER.TXT',
        '~$temp.doc',
        "quote'and(paren).txt",
        'no-extension',
      ]) {
        expect(safeFilename(name)).toBe(name);
      }
    });

    it('keeps unicode — the RFC 5987 path serves it correctly', () => {
      expect(safeFilename('报告.pdf')).toBe('报告.pdf');
      expect(safeFilename('résumé.doc')).toBe('résumé.doc');
      // C1 is control-like in latin1 but ordinary text in UTF-8, and the
      // serving path's ASCII fallback already handles it. Removing it here
      // would cost real filenames for no reachable gain.
      expect(safeFilename('a\x85b.txt')).toBe('a\x85b.txt');
    });

    it('falls back to a placeholder rather than storing an empty name', () => {
      expect(safeFilename('\r\n')).toBe('file');
      expect(safeFilename('')).toBe('file');
      expect(safeFilename(null)).toBe('file');
      expect(safeFilename(undefined)).toBe('file');
    });
  });

  describe('safeContentType', () => {
    it('passes well-formed types and replaces anything else', () => {
      expect(safeContentType('text/plain')).toBe('text/plain');
      expect(safeContentType('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
      expect(safeContentType('a/b; x=\r\ninjected')).toBe('application/octet-stream');
      expect(safeContentType('nonsense')).toBe('application/octet-stream');
      expect(safeContentType(null)).toBe('application/octet-stream');
      expect(safeContentType('a/b' + 'x'.repeat(300))).toBe('application/octet-stream');
    });
  });

  // The chokepoint. Normalising at insertFile rather than at each caller is the
  // point: every path that stores a file goes through here, including ones that
  // do not exist yet.
  describe('insertFile normalises at the chokepoint', () => {
    let db: Database;
    beforeEach(() => {
      db = openDb(':memory:');
      registerAgent(db, { id: 'from-a', token_hash: 'a'.repeat(64), hostname: 'h' });
      registerAgent(db, { id: 'to-b', token_hash: 'b'.repeat(64), hostname: 'h' });
    });
    afterEach(() => { db.close(); });

    const put = (filename: string, content_type: string) => insertFile(db, {
      id: 'f-1', from_agent: 'from-a', to_agent: 'to-b',
      filename, content_type, size_bytes: 3, file_path: '/tmp/x',
      sent_at: Date.now(), expires_at: null,
    });

    it('poison never reaches the database', () => {
      put('evil\r\nX-Injected: yes.txt', 'a/b; x=\r\ninjected');
      const row = getFile(db, 'f-1')!;
      expect(row.filename).toBe('evilX-Injected: yes.txt');
      expect(row.filename).not.toContain('\r');
      expect(row.filename).not.toContain('\n');
      expect(row.content_type).toBe('application/octet-stream');
    });

    // CONTROL: without this, an insertFile that stored constants would pass
    // the test above.
    it('CONTROL: clean values are stored unchanged', () => {
      put('report-2026.pdf', 'application/pdf');
      const row = getFile(db, 'f-1')!;
      expect(row.filename).toBe('report-2026.pdf');
      expect(row.content_type).toBe('application/pdf');
    });
  });
});
