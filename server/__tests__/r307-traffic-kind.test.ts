// R-307 — mesh_messages_sent_total / mesh_messages_received_total carry a
// neutral `kind` label: direct | topic | file | reminder. Telling the sys.*
// heartbeat feeds apart is now a deployment rule (R-311), so these tests set
// production's MESH_METRICS_CLASSES and pin the R-307 behaviour as kind plus
// class. Each kind is driven through its real routing path, not by calling
// incSent directly, so a call site passing the wrong facts goes red here.
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { openDb, registerAgent, aclGrant, subscribe, getOrCreateTopic, insertReminder, upsertPeer } from '../db.ts';
import { hashToken } from '../auth.ts';
import { renderMetrics, trafficKind, applyTrafficClasses, TRAFFIC_KINDS, __resetMetricsForTest } from '../metrics.ts';
import { parseTrafficClasses } from '../traffic-classes.ts';
import { routeDirect, routePublish, routeFile, drainQueue } from '../router.ts';
import { startReminderScheduler } from '../reminder-scheduler.ts';
import { tempDirs } from './helpers/temp-dirs.ts';

const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);

function mockWsOpen(): WebSocket {
  return { send: (..._args: unknown[]) => {}, readyState: 1 } as unknown as WebSocket;
}

function lineValue(out: string, prefix: string): number | undefined {
  for (const line of out.split('\n')) {
    if (line.startsWith(prefix + ' ')) return Number(line.slice(prefix.length + 1));
  }
  return undefined;
}

function samples(out: string, metric: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of out.split('\n')) {
    if (!line.startsWith(metric + '{') && !line.startsWith(metric + ' ')) continue;
    const sp = line.lastIndexOf(' ');
    m.set(line.slice(0, sp), Number(line.slice(sp + 1)));
  }
  return m;
}

let db: Database;

// Production's value (R-311). Set in the env and applied through the boot
// parser, as server.ts does.
const PROD_CLASSES = '[{"class":"system","topic":"sys.*"}]';
function configureClasses(raw: string | undefined): void {
  if (raw === undefined) delete process.env.MESH_METRICS_CLASSES; else process.env.MESH_METRICS_CLASSES = raw;
  const parsed = parseTrafficClasses(process.env.MESH_METRICS_CLASSES);
  if (!parsed.ok) throw new Error(parsed.error);
  applyTrafficClasses(parsed.rules);
}

// One message of every kind, each through its own path, every recipient online.
function driveOneOfEachKind(): void {
  for (const id of ['a', 'b', 'pub', 'sub']) {
    registerAgent(db, { id, token_hash: id.padEnd(64, '0'), hostname: 'h' });
  }
  aclGrant(db, 'a', 'b', 'system');
  aclGrant(db, 'pub', 'sub', 'system');
  getOrCreateTopic(db, 'news', 'pub');
  getOrCreateTopic(db, 'sys.presence.turn', 'pub');
  subscribe(db, 'sub', 'news');
  subscribe(db, 'sub', 'sys.presence.turn');
  const agentIndex = new Map<string, WebSocket>([['b', mockWsOpen()], ['sub', mockWsOpen()]]);

  expect(routeDirect(db, agentIndex, 'a', { type: 'send', msg_id: crypto.randomUUID(), to: 'b', payload: 'd' }).ok).toBe(true);
  expect(routePublish(db, agentIndex, 'pub', { type: 'publish', msg_id: crypto.randomUUID(), topic: 'news', payload: 't' }).ok).toBe(true);
  expect(routePublish(db, agentIndex, 'pub', { type: 'publish', msg_id: crypto.randomUUID(), topic: 'sys.presence.turn', payload: 's', ttl_ms: 0 }).ok).toBe(true);
  const data = Buffer.from('file-contents').toString('base64');
  expect(routeFile(db, agentIndex, 'a', { type: 'file_send', msg_id: crypto.randomUUID(), to: 'b', filename: 'f.txt', data }, 10_485_760, tmp('r307-files-')).ok).toBe(true);
  insertReminder(db, { id: 'r1', agent_id: 'b', due_at: Date.now() - 1000, payload: 'wake', created_at: Date.now() - 5000 });
  const scheduler = startReminderScheduler(db, agentIndex, 3_600_000);
  scheduler.tick();
  scheduler.stop();
}

beforeEach(() => {
  __resetMetricsForTest();
  db = openDb(':memory:');
  configureClasses(PROD_CLASSES);
});

afterEach(() => {
  __resetMetricsForTest();
  configureClasses(undefined);
  delete process.env.MESH_METRICS_IDENTITY_LABELS;
});

describe('kind + class, identity labels on', () => {
  beforeEach(() => { process.env.MESH_METRICS_IDENTITY_LABELS = '1'; });

  it('a direct send, a topic post, a sys.* post, a file and a reminder each land under their kind and class', () => {
    driveOneOfEachKind();
    const out = renderMetrics(db);

    expect(samples(out, 'mesh_messages_sent_total')).toEqual(new Map([
      ['mesh_messages_sent_total{from_agent="a",kind="direct",class="other"}', 1],
      ['mesh_messages_sent_total{from_agent="pub",kind="topic",class="other"}', 1],
      ['mesh_messages_sent_total{from_agent="pub",kind="topic",class="system"}', 1],
      ['mesh_messages_sent_total{from_agent="a",kind="file",class="other"}', 1],
      ['mesh_messages_sent_total{from_agent="mesh",kind="reminder",class="other"}', 1],
    ]));
    expect(samples(out, 'mesh_messages_received_total')).toEqual(new Map([
      ['mesh_messages_received_total{to_agent="b",kind="direct",class="other"}', 1],
      ['mesh_messages_received_total{to_agent="sub",kind="topic",class="other"}', 1],
      ['mesh_messages_received_total{to_agent="sub",kind="topic",class="system"}', 1],
      ['mesh_messages_received_total{to_agent="b",kind="file",class="other"}', 1],
      ['mesh_messages_received_total{to_agent="b",kind="reminder",class="other"}', 1],
    ]));
  });

  it('a drained queue keeps each row\'s kind and topic: sys.alerts → topic/system, news → topic/other', () => {
    for (const id of ['a', 'b']) registerAgent(db, { id, token_hash: id.padEnd(64, '0'), hostname: 'h' });
    aclGrant(db, 'a', 'b', 'system');
    getOrCreateTopic(db, 'sys.alerts', 'a');
    getOrCreateTopic(db, 'news', 'a');
    subscribe(db, 'b', 'sys.alerts');
    subscribe(db, 'b', 'news');
    const offline = new Map<string, WebSocket>();
    routeDirect(db, offline, 'a', { type: 'send', msg_id: crypto.randomUUID(), to: 'b', payload: 'd' });
    routePublish(db, offline, 'a', { type: 'publish', msg_id: crypto.randomUUID(), topic: 'sys.alerts', payload: 's' });
    routePublish(db, offline, 'a', { type: 'publish', msg_id: crypto.randomUUID(), topic: 'news', payload: 't' });
    insertReminder(db, { id: 'r1', agent_id: 'b', due_at: Date.now() - 1000, payload: 'wake', created_at: Date.now() - 5000 });
    const scheduler = startReminderScheduler(db, offline, 3_600_000);
    scheduler.tick();
    scheduler.stop();

    expect(samples(renderMetrics(db), 'mesh_messages_received_total').size).toBe(0);
    expect(drainQueue(db, 'b', mockWsOpen())).toBe(4);

    expect(samples(renderMetrics(db), 'mesh_messages_received_total')).toEqual(new Map([
      ['mesh_messages_received_total{to_agent="b",kind="direct",class="other"}', 1],
      ['mesh_messages_received_total{to_agent="b",kind="topic",class="system"}', 1],
      ['mesh_messages_received_total{to_agent="b",kind="topic",class="other"}', 1],
      ['mesh_messages_received_total{to_agent="b",kind="reminder",class="other"}', 1],
    ]));
  });
});

describe('the sys.* rule boundary', () => {
  beforeEach(() => { process.env.MESH_METRICS_IDENTITY_LABELS = '1'; });

  it('through routePublish: sysfoo is other, sys.x is system', () => {
    registerAgent(db, { id: 'pub', token_hash: 'p'.repeat(64), hostname: 'h' });
    getOrCreateTopic(db, 'sysfoo', 'pub');
    getOrCreateTopic(db, 'sys.x', 'pub');
    expect(routePublish(db, new Map(), 'pub', { type: 'publish', msg_id: crypto.randomUUID(), topic: 'sysfoo', payload: '1' }).ok).toBe(true);
    expect(routePublish(db, new Map(), 'pub', { type: 'publish', msg_id: crypto.randomUUID(), topic: 'sys.x', payload: '2' }).ok).toBe(true);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_messages_sent_total{from_agent="pub",kind="topic",class="other"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_sent_total{from_agent="pub",kind="topic",class="system"}')).toBe(1);
  });

  it('through a remote routePublish: pod1:sys.x is system, pod1:sysfoo is other', () => {
    registerAgent(db, { id: 'pub', token_hash: 'p'.repeat(64), hostname: 'h' });
    upsertPeer(db, { alias: 'pod1', token_hash: hashToken('pod1'), minted_by_key: 'k', kinds: '["topic-publish"]', rate_per_min: 600 });
    db.prepare(`INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
                VALUES ('pod1', 'wss://pod1.example', 'tok', 'orch', '["topic-publish"]', 600, ?)`).run(Date.now());
    aclGrant(db, 'pub', 'pod1:sys.x', 'admin');
    aclGrant(db, 'pub', 'pod1:sysfoo', 'admin');
    expect(routePublish(db, new Map(), 'pub', { type: 'publish', msg_id: crypto.randomUUID(), topic: 'pod1:sys.x', payload: '1' }).ok).toBe(true);
    expect(routePublish(db, new Map(), 'pub', { type: 'publish', msg_id: crypto.randomUUID(), topic: 'pod1:sysfoo', payload: '2' }).ok).toBe(true);
    const out = renderMetrics(db);
    expect(lineValue(out, 'mesh_messages_sent_total{from_agent="pub",kind="topic",class="system"}')).toBe(1);
    expect(lineValue(out, 'mesh_messages_sent_total{from_agent="pub",kind="topic",class="other"}')).toBe(1);
  });

  it('a stored row\'s kind maps through trafficKind', () => {
    expect(trafficKind('topic')).toBe('topic');
    expect(trafficKind('direct')).toBe('direct');
    expect(trafficKind('reminder')).toBe('reminder');
    expect(trafficKind('file')).toBe('file');
    expect(trafficKind('response')).toBe('direct');
  });
});

describe('kind + class, identity labels off', () => {
  it('aggregates by kind and class only, names nobody, and every pair is present from zero', () => {
    const pairs = TRAFFIC_KINDS.flatMap(k => ['system', 'other'].map(c => `kind="${k}",class="${c}"`));
    const before = renderMetrics(db);
    for (const metric of ['mesh_messages_sent_total', 'mesh_messages_received_total']) {
      expect(samples(before, metric)).toEqual(new Map(pairs.map(p => [`${metric}{${p}}`, 0])));
    }

    driveOneOfEachKind();
    const out = renderMetrics(db);
    const want = new Map(pairs.map(p => [p, 0]));
    for (const p of ['kind="direct",class="other"', 'kind="topic",class="other"', 'kind="topic",class="system"', 'kind="file",class="other"', 'kind="reminder",class="other"']) want.set(p, 1);
    for (const metric of ['mesh_messages_sent_total', 'mesh_messages_received_total']) {
      expect(samples(out, metric)).toEqual(new Map([...want].map(([p, v]) => [`${metric}{${p}}`, v])));
    }
    for (const id of ['"a"', '"b"', '"pub"', '"sub"', '"mesh"']) {
      expect(out.split('\n').filter(l => l.startsWith('mesh_messages_') && l.includes(id))).toEqual([]);
    }
  });

  it('sum over kind and class equals the old unlabelled total (one per accepted send, one per delivery)', () => {
    driveOneOfEachKind();
    // Five sends accepted (direct, topic, sys topic, file, reminder) and five
    // deliveries (one subscriber per topic, every recipient online): the
    // unlabelled series read 5 and 5 before R-307.
    const out = renderMetrics(db);
    const sum = (metric: string) => [...samples(out, metric).values()].reduce((x, y) => x + y, 0);
    expect(sum('mesh_messages_sent_total')).toBe(5);
    expect(sum('mesh_messages_received_total')).toBe(5);
  });

  it('HELP lists the kinds and the classes', () => {
    const out = renderMetrics(db);
    for (const metric of ['mesh_messages_sent_total', 'mesh_messages_received_total']) {
      const help = out.split('\n').find(l => l.startsWith(`# HELP ${metric} `))!;
      expect(help).toContain(`kind = ${TRAFFIC_KINDS.join('|')}`);
      expect(help).toContain('(system|other)');
    }
  });
});
