import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * A PER-RUN temp root (R-73), loaded before every test file by bunfig.toml's
 * `preload`. TMPDIR is pointed at a fresh directory for the whole run — so
 * os.tmpdir() in every test, and in every server a test spawns (they inherit
 * the env), lands inside it — and the directory is removed when the run
 * ends. A test that forgets its own cleanup therefore cannot accumulate: the
 * most one run can leave is its own root, and only if it is killed.
 *
 * Same shape as claude-spawner's W-110 guard.
 */
const root = mkdtempSync(join(tmpdir(), 'mesh-test-run-'));
process.env.TMPDIR = root;
// An afterAll in a PRELOAD runs once, after every file in the run. Not
// process.on('exit') / 'beforeExit': under `bun test` neither fires from a
// preload (measured), which left each run's root behind.
afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
});
