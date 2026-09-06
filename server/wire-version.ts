/**
 * The server side's ONLY cross-package import of the protocol version (#131).
 *
 * THIS FILE MUST STAY TINY, and that is the entire reason it exists.
 *
 * #131 was an intermittent link failure on `PEER_PROTOCOL_VERSION`: an import
 * would fail to resolve a binding that demonstrably exists, dropping a whole
 * test file from the suite population. The only importer that ever failed was
 * the one that was BOTH at or over the on-disk transpiler-cache threshold —
 * 51,200 B, fine-bisected at 51,197 B -> 0 entries and 51,497 B -> 1 — AND
 * crossing the package boundary. A cached cross-package importer is the shape
 * the defect was measured in.
 *
 * THE INVARIANT, scoped to cross-package EDGES rather than to this constant:
 * after this change, the set of `server/` files that are BOTH >= 51,200 B (the
 * transpiler-cache threshold, fine-bisected: 51,197 -> 0 entries, 51,497 -> 1)
 * AND import cross-package from `client/` is EMPTY. The only cached server
 * files are `http-admin.ts` and `db.ts`, and `db.ts` imports nothing
 * cross-package.
 *
 * Cross-package importers still exist and that is fine — `router.ts` and
 * `border.ts` both are, and both are far below the threshold. What must not
 * exist is a file in BOTH sets. Today's margins: `ws-server.ts` 4,420 B,
 * `router.ts` 18,412 B, `border.ts` 36,449 B.
 *
 * NOT a guarantee. wire-version.ts is a bare re-export barrel with no reason to
 * approach 51,200 B, but nothing STOPS it growing, and it is exactly where the
 * next wire constant will get added. #131 REOPENS if any `server/` file at or
 * above 51,200 B imports cross-package from `client/`, or if this file stops
 * being a bare re-export barrel.
 *
 * An earlier version of this fix pointed `http-admin.ts` at `ws-server.ts`
 * instead. That was withdrawn: `ws-server.ts` is 46,780 B, inside the bisected
 * band and only ~0.7 KB above its lowest clean point, and it is the most edited
 * file in the repo — a margin that closes silently on some future commit with
 * nobody noticing.
 *
 * So: do not add code here. Not a helper, not a type, not a second re-export.
 * Anything that grows this file re-creates the condition it was made to remove.
 *
 * The constant still has exactly ONE definition, in the wire module. That, and
 * the specifier every reader uses, are pinned by `server/__tests__/border.test.ts`.
 *
 * None of this is a proof of mechanism — #131 remains open and unexplained. It
 * is the removal of a measured asymmetry.
 */
export { PEER_PROTOCOL_VERSION } from '../client/src/protocol.ts';
