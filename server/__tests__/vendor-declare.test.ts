// R-393: the vendored declaration library is fleet-bridge's, byte for byte, at the commit its
// README names: any edit here, or a partial update, fails this.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dir, '..', 'vendor', 'fleet-bridge-declare');

test('every vendored file matches SHA256SUMS, and every .ts file is listed', () => {
  const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/) as [string, string]);
  for (const [want, file] of sums) expect([file, createHash('sha256').update(readFileSync(join(dir, file))).digest('hex')]).toEqual([file, want]);
  expect(readdirSync(dir).filter((f) => f.endsWith('.ts')).sort()).toEqual(sums.map(([, f]) => f).sort());
});
