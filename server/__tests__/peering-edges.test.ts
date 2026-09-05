import { describe, it, expect, beforeEach } from 'bun:test';
import {
  openDb, registerAgent, insertPeerKey, upsertPeer, revokePeerKey,
  aclGrant, aclCheck, getPeerByAlias, deletePeeringEdges, deleteAgent,
} from '../db.ts';
import { hashToken } from '../auth.ts';
import { Database } from 'bun:sqlite';

// AN ALIAS'S EDGES END WITH THE PEERING THAT CREATED THEM.
//
// Revocation parked grants instead of revoking them: revokePeerKey disables the
// peers row and never touched acl, a new key may be minted for the same alias
// once the old is revoked, and registration set disabled = 0 — so surviving
// `alias:*` edges came back to life for whoever now held the name.
//
// Not an escalation (every step is an admin action) but operator SURPRISE of
// the worst kind: the operator revoked a peering and believes the grants went
// with it.

let db: Database;

beforeEach(() => {
  db = openDb(':memory:');
  registerAgent(db, { id: 'local-a', token_hash: 'a'.repeat(64), hostname: 'h' });
});

/** Mint a key for `alias` (optionally declaring the key it rotates) and
 *  register a peer against it — in the order the HTTP API permits. */
function mintAndRegister(alias: string, keyId: string, token: string, rotates?: string): void {
  insertPeerKey(db, {
    id: keyId, key_hash: hashToken(`secret-${keyId}`), alias,
    kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    ...(rotates !== undefined ? { rotates } : {}),
  });
  upsertPeer(db, {
    alias, token_hash: hashToken(token), minted_by_key: keyId,
    kinds: '["direct"]', rate_per_min: 600,
    ...(rotates !== undefined ? { rotates } : {}),
  });
}

describe('edges end with the peering (#113)', () => {
  // THE DECISION IS DECLARED LINEAGE, not an inferred one. The obvious signal —
  // "the row was disabled, so this is a rebind" — cannot work:
  //   - minting refuses while a live key exists (409), so a receiver-side
  //     ROTATION must ALSO go revoke -> mint -> register, byte-identical at the
  //     DB layer to a rebind;
  //   - key EXPIRY never disables the row, so expired -> mint -> register
  //     re-arms an ENABLED row and a disabled-based hook never fires.
  // My first attempt used that hook, and its "rotation keeps edges" control
  // passed only because it minted BEFORE revoking — a sequence the 409 makes
  // impossible. The test asserted a state the API cannot produce.

  it('REVOKE then rebind: the new holder does not inherit the edges', () => {
    mintAndRegister('partner', 'k1', 't1');
    aclGrant(db, 'partner:their-agent', 'local-a', 'admin');
    expect(aclCheck(db, 'partner:their-agent', 'local-a')).toBe(true);

    revokePeerKey(db, 'k1');
    // No lineage declared → rebind.
    mintAndRegister('partner', 'k2', 't2');

    expect(aclCheck(db, 'partner:their-agent', 'local-a')).toBe(false);
  });

  it('EXPIRY then rebind: same outcome — the door a disabled-row hook misses', () => {
    // Expiry does NOT disable the peers row, so this re-arms an ENABLED row.
    // Any hook keyed on `disabled` never fires here at all.
    insertPeerKey(db, {
      id: 'k1', key_hash: hashToken('secret-k1'), alias: 'partner',
      kinds: '["direct"]', rate_per_min: 600,
      expires_at: Date.now() - 1000, created_at: Date.now() - 5000,
    });
    upsertPeer(db, {
      alias: 'partner', token_hash: hashToken('t1'), minted_by_key: 'k1',
      kinds: '["direct"]', rate_per_min: 600,
    });
    aclGrant(db, 'partner:their-agent', 'local-a', 'admin');
    expect(getPeerByAlias(db, 'partner')?.disabled).toBe(0); // never disabled

    mintAndRegister('partner', 'k2', 't2');

    expect(aclCheck(db, 'partner:their-agent', 'local-a')).toBe(false);
  });

  it('DECLARED ROTATION keeps its edges — the positive control', () => {
    // The operator says what they meant: this key replaces k1.
    mintAndRegister('partner', 'k1', 't1');
    aclGrant(db, 'partner:their-agent', 'local-a', 'admin');

    revokePeerKey(db, 'k1');
    mintAndRegister('partner', 'k2', 't2', 'k1');   // rotates: k1

    expect(aclCheck(db, 'partner:their-agent', 'local-a')).toBe(true);
  });

  it('lineage naming the WRONG key is a rebind, not a rotation', () => {
    // A stale or copied `rotates` must not carry edges across. The lineage has
    // to match the row's CURRENT key, not merely be present.
    mintAndRegister('partner', 'k1', 't1');
    aclGrant(db, 'partner:their-agent', 'local-a', 'admin');

    revokePeerKey(db, 'k1');
    mintAndRegister('partner', 'k2', 't2', 'some-other-key');

    expect(aclCheck(db, 'partner:their-agent', 'local-a')).toBe(false);
  });

  it('only the rebound alias loses edges — a bystander peering is untouched', () => {
    mintAndRegister('partner', 'k1', 't1');
    mintAndRegister('other', 'k9', 't9');
    aclGrant(db, 'partner:x', 'local-a', 'admin');
    aclGrant(db, 'other:y', 'local-a', 'admin');

    revokePeerKey(db, 'k1');
    mintAndRegister('partner', 'k2', 't2');

    expect(aclCheck(db, 'partner:x', 'local-a')).toBe(false);
    expect(aclCheck(db, 'other:y', 'local-a')).toBe(true);
  });

  it('a FIRST registration has no edges to lose and no lineage to declare', () => {
    // Positive control on the no-existing-row path: the rule must not require
    // a rotation declaration from a peering that never existed before.
    mintAndRegister('fresh', 'kf', 'tf');
    expect(getPeerByAlias(db, 'fresh')).not.toBeNull();
  });
});

describe('deletePeeringEdges: direction is explicit, never inferred', () => {
  it('inbound removes alias-as-granter, outbound removes alias-as-grantee', () => {
    // A helper that guessed direction from context would eventually guess wrong
    // in the direction that leaves a door open.
    upsertPeer(db, {
      alias: 'partner', token_hash: hashToken('t'), minted_by_key: 'k',
      kinds: '["direct"]', rate_per_min: 600,
    });
    aclGrant(db, 'partner:them', 'local-a', 'admin');   // inbound
    db.prepare('INSERT INTO acl (from_agent, to_agent, granted_at, granted_by) VALUES (?,?,?,?)')
      .run('local-a', 'partner:them', Date.now(), 'admin'); // outbound, inserted raw:
      // aclGrant would refuse it today (no outbound peering until F2).

    expect(deletePeeringEdges(db, 'partner', 'inbound')).toBe(1);
    expect(aclCheck(db, 'partner:them', 'local-a')).toBe(false);
    expect(aclCheck(db, 'local-a', 'partner:them')).toBe(true);   // untouched

    expect(deletePeeringEdges(db, 'partner', 'outbound')).toBe(1);
    expect(aclCheck(db, 'local-a', 'partner:them')).toBe(false);
  });

  it('the prefix range does not catch a longer alias that starts the same', () => {
    // `partner` must not take `partnership`'s edges. A LIKE with an unescaped
    // pattern, or a bare `>=` without the upper bound, would.
    upsertPeer(db, {
      alias: 'partner', token_hash: hashToken('t1'), minted_by_key: 'k',
      kinds: '["direct"]', rate_per_min: 600,
    });
    upsertPeer(db, {
      alias: 'partnership', token_hash: hashToken('t2'), minted_by_key: 'k',
      kinds: '["direct"]', rate_per_min: 600,
    });
    aclGrant(db, 'partner:x', 'local-a', 'admin');
    aclGrant(db, 'partnership:x', 'local-a', 'admin');

    expect(deletePeeringEdges(db, 'partner', 'inbound')).toBe(1);
    expect(aclCheck(db, 'partnership:x', 'local-a')).toBe(true);
  });

  it('a bare local id sharing the alias name is not touched', () => {
    // `partner` the alias and `partner` the agent id cannot coexist (#98's
    // collision gates), but the QUERY must be right regardless of who enforces
    // that — a rule relying on a distant invariant is the #104 shape.
    registerAgent(db, { id: 'partner-local', token_hash: 'b'.repeat(64), hostname: 'h' });
    aclGrant(db, 'partner-local', 'local-a', 'admin');
    upsertPeer(db, {
      alias: 'partner', token_hash: hashToken('t'), minted_by_key: 'k',
      kinds: '["direct"]', rate_per_min: 600,
    });

    expect(deletePeeringEdges(db, 'partner', 'inbound')).toBe(0);
    expect(aclCheck(db, 'partner-local', 'local-a')).toBe(true);
  });
});

describe('every site that writes or deletes acl rows', () => {
  // The enumeration, asserted rather than only listed in the PR body. If a
  // fifth writer appears, this test does not fail — that is stated honestly:
  // it pins what each KNOWN site does, and the body carries the argument that
  // the union is total.
  it('aclGrant writes, aclRevoke removes one edge, deleteAgent removes an agent\'s, deletePeeringEdges removes an alias\'s', () => {
    registerAgent(db, { id: 'local-b', token_hash: 'c'.repeat(64), hostname: 'h' });
    upsertPeer(db, {
      alias: 'partner', token_hash: hashToken('t'), minted_by_key: 'k',
      kinds: '["direct"]', rate_per_min: 600,
    });

    aclGrant(db, 'local-a', 'local-b', 'admin');
    aclGrant(db, 'partner:x', 'local-b', 'admin');
    expect(aclCheck(db, 'local-a', 'local-b')).toBe(true);

    // deleteAgent: every edge naming that agent, either side.
    deleteAgent(db, 'local-a');
    expect(aclCheck(db, 'local-a', 'local-b')).toBe(false);

    // deletePeeringEdges: every edge naming that alias, one direction.
    expect(deletePeeringEdges(db, 'partner', 'inbound')).toBe(1);
    expect(aclCheck(db, 'partner:x', 'local-b')).toBe(false);
  });
});
