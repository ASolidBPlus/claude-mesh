import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { openDb, registerAgent, aclGrant, getOrCreateTopic, subscribe } from '../db.ts';
import { routePublish } from '../router.ts';
import { renderMetrics, __resetMetricsForTest as resetMetrics, incSysFanout } from '../metrics.ts';

// #136 — a server-originated sys.* fan-out refused by a SUBSCRIBER's ACL is not
// an agent send attempt, and must not be counted as one.
//
// THE GATE STAYS. Removing it was the other option and it is wrong:
// routeSubscribe has no ACL check, so any authenticated agent can subscribe to
// sys.presence.turn, and ungating the fan-out would hand every subscriber the
// activity of the entire roster.
//
// Measured in production before the fix: ~5,800 ACL_DENIED per hour attributed
// to no client, continuous for a day, surviving two recreates — enough artefact
// that a real refusal storm would have been invisible in the same counter.
describe('#136 sys.* fan-out counting', () => {
  let db: Database;
  const series = (name: string): string[] =>
    renderMetrics(db).split('\n').filter(l => l.startsWith(name) && !l.startsWith('#'));

  beforeEach(() => {
    resetMetrics();
    db = openDb(':memory:');
    registerAgent(db, { id: 'turner', token_hash: 'a'.repeat(64), hostname: 'h' });
    registerAgent(db, { id: 'watcher-no-edge', token_hash: 'b'.repeat(64), hostname: 'h' });
    registerAgent(db, { id: 'watcher-with-edge', token_hash: 'c'.repeat(64), hostname: 'h' });
    aclGrant(db, 'turner', 'watcher-with-edge', 'system');
  });
  afterEach(() => { db.close(); resetMetrics(); });

  const publishTurn = (topic: string) => {
    getOrCreateTopic(db, topic, 'turner');
    subscribe(db, 'watcher-no-edge', topic);
    subscribe(db, 'watcher-with-edge', topic);
    return routePublish(db, new Map<string, WebSocket>(), 'turner',
      { type: 'publish', msg_id: crypto.randomUUID(), topic, payload: 'turn', ttl_ms: 0 } as never,
      new Map<string, WebSocket>());
  };

  // THE TEST FROM THE ISSUE.
  it('one turn event with a subscriber lacking an edge: acl_denied unchanged, new series increments', () => {
    // The series always renders — unlabelled and zero with the identity flag
    // off — so the baseline is "every sample is 0", not "the series is absent".
    expect(series('mesh_acl_denied_total').every(l => l.trim().endsWith(' 0'))).toBe(true);

    publishTurn('sys.presence.turn');

    // The sender-attributed counter is untouched — the turning agent sent
    // nothing, so nothing may be attributed to it.
    const denied = renderMetrics(db).split('\n')
      .filter(l => l.startsWith('mesh_acl_denied_total') && !l.startsWith('#'));
    expect(denied.every(l => l.trim().endsWith(' 0'))).toBe(true);

    // ...and the refusal is visible where it belongs.
    const fanout = series('mesh_sys_fanout_total');
    expect(fanout.some(l => l.includes('topic="sys.presence.turn"') && l.includes('outcome="refused"'))).toBe(true);
    expect(fanout.some(l => l.includes('outcome="delivered"'))).toBe(true);
  });

  // CONTROL. Without this, a change that stopped counting ACL denials at ALL
  // would pass the test above. An ordinary topic must still attribute its
  // refusals to the sender, because there the sender really did send.
  it('CONTROL: an ordinary topic still counts refusals against the sender', () => {
    publishTurn('general');

    const denied = renderMetrics(db).split('\n')
      .filter(l => l.startsWith('mesh_acl_denied_total') && !l.startsWith('#'));
    expect(denied.some(l => !l.trim().endsWith(' 0'))).toBe(true);

    // ...and it must NOT appear in the system series.
    expect(series('mesh_sys_fanout_total').some(l => l.includes('topic="general"'))).toBe(false);
  });

  // The `topic` label is party-free ONLY because the series is restricted to
  // sys.* topics. Agents choose topic names freely (routeSubscribe →
  // getOrCreateTopic), so an unguarded label would put an agent-chosen name —
  // possibly a person's — into unauthenticated /metrics, reopening what #126
  // closed. This pins the guard rather than the intention.
  it('the topic label cannot carry an agent-chosen name', () => {
    incSysFanout('user-joelle-private', 'refused');
    incSysFanout('general', 'delivered');
    expect(series('mesh_sys_fanout_total')).toEqual([]);

    incSysFanout('sys.presence.turn', 'refused');
    expect(series('mesh_sys_fanout_total').length).toBe(1);
  });

  it('the HELP text says where system fan-out is counted, and where it is not', () => {
    const out = renderMetrics(db);
    const aclHelp = out.split('\n').find(l => l.startsWith('# HELP mesh_acl_denied_total'))!;
    expect(aclHelp).toContain('mesh_sys_fanout_total');
    expect(aclHelp).toContain('Excludes server-originated');

    const sysHelp = out.split('\n').find(l => l.startsWith('# HELP mesh_sys_fanout_total'))!;
    expect(sysHelp).toContain('NOT counted in mesh_acl_denied_total');
  });
});
