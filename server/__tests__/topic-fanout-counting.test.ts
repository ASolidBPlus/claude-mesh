import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { openDb, registerAgent, aclGrant, getOrCreateTopic, subscribe } from '../db.ts';
import { routePublish, routeDirect } from '../router.ts';
import { renderMetrics, __resetMetricsForTest as resetMetrics } from '../metrics.ts';

// #136 — per-subscriber ACL filtering of a TOPIC fan-out counted as sender
// denials.
//
// NOT a system-topic problem, though sys.presence.turn is where it surfaced.
// On a topic publish the sender does not choose the recipients: it names a
// topic and the ACL filters the subscriber list. Counting each filtered
// subscriber as an "ACL-denied send attempt by sender" is a semantics error for
// EVERY topic — the sender attempted one publish, not N sends to N agents it
// never named. The turn topic only made it visible, at ~2/s fleet-wide and
// ~5,800 phantom denials an hour.
//
// THE GATE ITSELF STAYS: routeSubscribe has no ACL check, so any authenticated
// agent can subscribe to sys.presence.turn, and ungating the fan-out would hand
// every subscriber the activity of the whole roster.
describe('#136 topic fan-out counting', () => {
  let db: Database;
  const lines = (): string[] => renderMetrics(db).split('\n').filter(l => l.length > 0 && !l.startsWith('#'));
  const series = (name: string): string[] => lines().filter(l => l.startsWith(name));

  beforeEach(() => {
    resetMetrics();
    db = openDb(':memory:');
    registerAgent(db, { id: 'turner', token_hash: 'a'.repeat(64), hostname: 'h' });
    registerAgent(db, { id: 'watcher-no-edge', token_hash: 'b'.repeat(64), hostname: 'h' });
    registerAgent(db, { id: 'watcher-with-edge', token_hash: 'c'.repeat(64), hostname: 'h' });
    aclGrant(db, 'turner', 'watcher-with-edge', 'system');
  });
  afterEach(() => { db.close(); resetMetrics(); });

  // The publisher is excluded from its own fan-out (router: "remove publisher"),
  // so a second subscriber is required to reach the fan-out path at all. Found
  // the hard way: the first reproduction of this defect failed for that reason.
  const publish = (topic: string, from = 'turner') => {
    getOrCreateTopic(db, topic, from);
    subscribe(db, 'watcher-no-edge', topic);
    subscribe(db, 'watcher-with-edge', topic);
    return routePublish(db, new Map<string, WebSocket>(), from,
      { type: 'publish', msg_id: crypto.randomUUID(), topic, payload: 'x', ttl_ms: 0 } as never,
      new Map<string, WebSocket>());
  };

  const allZero = (name: string) => series(name).every(l => l.trim().endsWith(' 0'));

  it('the turn topic: acl_denied unchanged, fan-out filtering counted', () => {
    expect(allZero('mesh_acl_denied_total')).toBe(true);

    publish('sys.presence.turn');

    // The sender-attributed counter is untouched: the publisher named a topic,
    // not a recipient.
    expect(allZero('mesh_acl_denied_total')).toBe(true);
    expect(allZero('mesh_errors_total')).toBe(true);

    // ...and the outcome is visible where it belongs.
    expect(series('mesh_topic_fanout_total')).toContain('mesh_topic_fanout_total{outcome="filtered"} 1');
    expect(series('mesh_topic_fanout_total')).toContain('mesh_topic_fanout_total{outcome="allowed"} 1');

    // ALLOWED IS NOT DELIVERED, and the pair proves it rather than asserting
    // the name. This publish is ttl=0 with no connected subscriber, so the one
    // subscriber that passed the ACL filter was NOT delivered to — and
    // mesh_messages_total, the authority on delivery, says dropped. A counter
    // named `delivered` here would have contradicted it on every turn event.
    const dropped = renderMetrics(db).split('\n')
      .filter(l => l.startsWith('mesh_messages_total') && l.includes('status="dropped"'));
    expect(dropped.some(l => !l.trim().endsWith(' 0'))).toBe(true);
  });

  // It is the SEMANTICS, not the topic name: an ordinary topic behaves the same.
  it('an ordinary topic is counted the same way — this was never about sys.*', () => {
    publish('general');
    expect(allZero('mesh_acl_denied_total')).toBe(true);
    expect(series('mesh_topic_fanout_total')).toContain('mesh_topic_fanout_total{outcome="filtered"} 1');
  });

  // CONTROL. Without it, a change that simply stopped counting ACL denials
  // anywhere would pass every assertion above. A DIRECT send is where the
  // sender really did choose the recipient, and it must still be attributed.
  it('CONTROL: a direct send without an edge still counts against the sender', () => {
    const r = routeDirect(db, new Map<string, WebSocket>(), 'turner',
      { type: 'send', msg_id: crypto.randomUUID(), to: 'watcher-no-edge', payload: 'x' } as never,
      new Map<string, WebSocket>());
    expect(r.ok).toBe(false);
    expect(allZero('mesh_acl_denied_total')).toBe(false);
    expect(allZero('mesh_errors_total')).toBe(false);
  });

  // THE REACHABLE-PATH TEST. The earlier revision of this series carried a
  // {topic} label behind a `sys.` prefix check, and its test drove the metrics
  // function DIRECTLY — so it tested the function's logic, not the path an
  // agent can actually take. Through the real router, an agent publishing to
  // `sys.<victim-id>` with one other subscriber put that id straight into the
  // unauthenticated document.
  //
  // This drives the real entry point with an agent `from_agent`, and it holds
  // BY CONSTRUCTION now rather than by a guard: the series has no name label,
  // so there is nothing for an agent-chosen string to travel in.
  it('REACHABLE PATH: no agent-chosen topic name reaches the flag-off document', () => {
    const names = ['sys.zzz', 'sys.victim-9f3-secret', 'general-victim-9f3', 'sys.presence.turn'];
    for (const n of names) publish(n);

    const doc = renderMetrics(db);
    for (const n of ['zzz', 'victim-9f3-secret', 'victim-9f3']) {
      expect(doc).not.toContain(n);
    }

    // The fan-out really happened — otherwise the absence above proves nothing.
    expect(series('mesh_topic_fanout_total').some(l => !l.trim().endsWith(' 0'))).toBe(true);
  });

  // Byte-level default pin, extended: with the identity flag unset, NO series
  // line may contain any agent id or agent-chosen topic name registered here.
  it('DEFAULT: the flag-off document names no party and no agent-chosen string', () => {
    publish('sys.zzz');
    publish('a-topic-named-turner');

    const seriesLines = lines();
    const forbidden = ['turner', 'watcher-no-edge', 'watcher-with-edge', 'zzz', 'a-topic-named'];
    const leaks = seriesLines.filter(l => forbidden.some(f => l.includes(f)));
    expect(leaks).toEqual([]);

    // Positive control: the same strings DO appear once the flag is set, so the
    // absence above is the flag working rather than the strings never existing.
    process.env.MESH_METRICS_IDENTITY_LABELS = '1';
    try {
      const on = renderMetrics(db).split('\n').filter(l => l.length > 0 && !l.startsWith('#'));
      expect(on.some(l => l.includes('turner'))).toBe(true);
    } finally {
      delete process.env.MESH_METRICS_IDENTITY_LABELS;
    }
  });

  it('the HELP texts say which counter means what', () => {
    const out = renderMetrics(db);
    const acl = out.split('\n').find(l => l.startsWith('# HELP mesh_acl_denied_total'))!;
    expect(acl).toContain('DIRECT');
    expect(acl).toContain('mesh_topic_fanout_total');

    const fan = out.split('\n').find(l => l.startsWith('# HELP mesh_topic_fanout_total'))!;
    expect(fan).toContain('NOT counted in mesh_acl_denied_total');
  });
});
