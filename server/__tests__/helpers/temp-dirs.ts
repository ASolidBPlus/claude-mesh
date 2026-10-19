import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Temp directories a test file creates, removed when it is done (R-73).
 *
 * The R-271 suite alone left a 28 MB files dir per run, and a container's
 * /tmp is on the host's root disk: 543 runs filled 15 GB of it. Each file
 * registers `cleanup` with `afterAll`; the per-run temp root (tmp-root.ts) is
 * the backstop for anything that still escapes.
 */
export function tempDirs(): { tmp: (prefix: string) => string; cleanup: () => void } {
  const made: string[] = [];
  return {
    tmp: (prefix: string): string => {
      const d = mkdtempSync(join(tmpdir(), prefix));
      made.push(d);
      return d;
    },
    cleanup: (): void => {
      for (const d of made.splice(0)) {
        try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort; the run root catches the rest */ }
      }
    },
  };
}
