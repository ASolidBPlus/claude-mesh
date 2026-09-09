import { readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Every `.ts` source file under `dir`, RECURSIVELY, skipping `node_modules`
 * and `__tests__`.
 *
 * ONE COPY (#199). This was written twice, byte-identically, in
 * `border.test.ts` and `one-token-helper.test.ts`, and #143's new derived walks
 * needed a third. Two copies of one rule agree until they don't; the walks that
 * use this answer questions of the form "does ANY server module do X", and a
 * copy that quietly stops recursing turns that into "does any module I happened
 * to look at do X".
 *
 * THE RECURSION IS DORMANT AND MUST STAY. `server/` is flat today, so this
 * never descends — `border.test.ts` says the same about its own walk and names
 * what reopens it: "the first real directory under server/". #143 added ten
 * modules beside twelve, which is exactly the tree where someone reaches for a
 * subdirectory next, so the walks that guard chokepoints must already be able
 * to see into one. It is pinned by `source-files.test.ts` against a synthetic
 * tree rather than left to be exercised by a directory nobody has created yet.
 *
 * `border.test.ts` keeps a deliberately INDEPENDENT re-implementation beside
 * its use of this helper: that control exists to catch divergence between two
 * walks, and sharing both halves would make it agree with itself.
 */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}
