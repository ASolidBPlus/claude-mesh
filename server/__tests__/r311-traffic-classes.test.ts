// R-311 — MESH_METRICS_CLASSES: deployment rules that add a `class` label to
// mesh_messages_sent_total / mesh_messages_received_total. First match wins,
// unmatched traffic is `other`, and no rules means no label at all. Label
// values only ever come from the configured class names.
import { describe, it, expect, beforeEach, afterEach, afterAll, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { openDb, registerAgent, aclGrant, subscribe, getOrCreateTopic } from '../db.ts';
import { renderMetrics, applyTrafficClasses, incSent, __resetMetricsForTest } from '../metrics.ts';
import {
  parseTrafficClasses, compileTrafficClasses, classifyTraffic, classNames,
  MAX_CLASS_RULES, MAX_GLOB_LENGTH, type ClassRule, type Traffic,
} from '../traffic-classes.ts';
import { routeDirect, routePublish, routeFile, drainQueue, drainFileQueue } from '../router.ts';
import { startHttpAdmin } from '../http-admin.ts';
import * as net from 'net';
import { tempDirs } from './helpers/temp-dirs.ts';

const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);

function rulesOf(raw: string): ClassRule[] {
  const p = parseTrafficClasses(raw);
  if (!p.ok) throw new Error(p.error);
  return p.rules;
}

function refusal(raw: string | undefined): string {
  const p = parseTrafficClasses(raw);
  if (p.ok) throw new Error(`accepted: ${raw}`);
  return p.error;
}

function classOf(raw: string, t: Partial<Traffic>): string {
  return classifyTraffic(compileTrafficClasses(rulesOf(raw)), { kind: 'direct', from: 'a', to: 'b', topic: null, ...t });
}

function mockWsOpen(): WebSocket {
  return { send: (..._args: unknown[]) => {}, readyState: 1 } as unknown as WebSocket;
}

function seriesLines(out: string): string[] {
  return out.split('\n').filter(l => l.startsWith('mesh_messages_sent_total') || l.startsWith('mesh_messages_received_total'));
}

describe('parsing MESH_METRICS_CLASSES', () => {
  it('unset and empty are no rules', () => {
    expect(rulesOf('')).toEqual([]);
    expect(parseTrafficClasses(undefined)).toEqual({ ok: true, rules: [] });
    expect(rulesOf('[]')).toEqual([]);
  });

  it('inline JSON and a file path give the same rules', () => {
    const json = '[{"class":"system","topic":"sys.*"},{"class":"ops","kind":["direct","file"],"from":"ops-*","to":"*"}]';
    const file = join(tmp('r311-classes-'), 'classes.json');
    writeFileSync(file, json);
    const want: ClassRule[] = [
      { class: 'system', topic: 'sys.*' },
      { class: 'ops', kind: ['direct', 'file'], from: 'ops-*', to: '*' },
    ];
    expect(rulesOf(json)).toEqual(want);
    expect(rulesOf(`  ${json}`)).toEqual(want);
    expect(rulesOf(file)).toEqual(want);
  });

  it('a path that can\'t be read, bad JSON, or a non-array is refused', () => {
    expect(refusal('/no/such/classes.json')).toContain('"/no/such/classes.json"');
    expect(refusal('[{"class":')).toContain('not valid JSON');
    const notArray = join(tmp('r311-classes-'), 'obj.json');
    writeFileSync(notArray, '{"class":"system"}');
    expect(refusal(notArray)).toContain('must be a JSON array');
  });

  it(`at most ${MAX_CLASS_RULES} rules`, () => {
    const rule = '{"class":"c","topic":"t"}';
    expect(rulesOf(`[${Array(MAX_CLASS_RULES).fill(rule).join(',')}]`)).toHaveLength(MAX_CLASS_RULES);
    expect(refusal(`[${Array(MAX_CLASS_RULES + 1).fill(rule).join(',')}]`)).toContain(`at most ${MAX_CLASS_RULES}`);
  });

  it('each invalid rule is refused, naming the rule by position', () => {
    const long = 'x'.repeat(MAX_GLOB_LENGTH + 1);
    const cases: [string, string][] = [
      ['"system"', 'must be an object'],
      ['null', 'must be an object'],
      ['["system"]', 'must be an object'],
      ['{"topic":"sys.*"}', '"class" must match'],
      ['{"class":"System"}', '"class" must match'],
      ['{"class":"1sys"}', '"class" must match'],
      ['{"class":"sys-tem"}', '"class" must match'],
      ['{"class":""}', '"class" must match'],
      [`{"class":"a${'b'.repeat(32)}"}`, '"class" must match'],
      ['{"class":7}', '"class" must match'],
      ['{"class":"other"}', 'may not be "other"'],
      ['{"class":"c","Topic":"x"}', 'unknown field "Topic"'],
      ['{"class":"c","kind":"topic"}', '"kind" must be a non-empty array'],
      ['{"class":"c","kind":[]}', '"kind" must be a non-empty array'],
      ['{"class":"c","kind":["system"]}', '"kind" value "system"'],
      ['{"class":"c","topic":""}', '"topic" must be a glob'],
      [`{"class":"c","from":"${long}"}`, '"from" must be a glob'],
      ['{"class":"c","to":5}', '"to" must be a glob'],
      ['{"class":"c","topic":"a\\u0000b"}', '"topic" contains a control character'],
      ['{"class":"c","to":"a\\nb"}', '"to" contains a control character'],
    ];
    for (const [rule, reason] of cases) {
      const err = refusal(`[{"class":"ok","topic":"t"},${rule}]`);
      expect(err).toStartWith('rule 2 ');
      expect(err).toContain(reason);
    }
  });

  it('a catch-all rule (no kind, topic, from or to) is refused anywhere but last, naming it', () => {
    const err = refusal('[{"class":"a","topic":"x"},{"class":"everything"},{"class":"b","topic":"y"}]');
    expect(err).toStartWith('rule 2 ');
    expect(err).toContain('make it the last rule');
    expect(refusal('[{"class":"everything"},{"class":"b","topic":"y"}]')).toStartWith('rule 1 ');
    expect(rulesOf('[{"class":"a","topic":"x"},{"class":"everything"}]')).toHaveLength(2);
    expect(rulesOf('[{"class":"everything"}]')).toHaveLength(1);
  });

  it('boundary values are accepted', () => {
    expect(rulesOf(`[{"class":"a${'b'.repeat(31)}","topic":"${'x'.repeat(MAX_GLOB_LENGTH)}"}]`)).toHaveLength(1);
    expect(rulesOf('[{"class":"c"}]')).toEqual([{ class: 'c' }]);
    expect(rulesOf('[{"class":"c","kind":["topic","topic"]}]')).toEqual([{ class: 'c', kind: ['topic'] }]);
  });
});

describe('matching', () => {
  it('kind', () => {
    const r = '[{"class":"files","kind":["file","reminder"]}]';
    expect(classOf(r, { kind: 'file' })).toBe('files');
    expect(classOf(r, { kind: 'reminder' })).toBe('files');
    expect(classOf(r, { kind: 'direct' })).toBe('other');
    expect(classOf(r, { kind: 'topic', to: null, topic: 'x' })).toBe('other');
  });

  it('topic: exact, prefix, suffix, middle, star', () => {
    const t = (glob: string, topic: string) => classOf(`[{"class":"c","topic":"${glob}"}]`, { kind: 'topic', to: null, topic });
    expect(t('news', 'news')).toBe('c');
    expect(t('news', 'news2')).toBe('other');
    expect(t('news', 'xnews')).toBe('other');
    expect(t('sys.*', 'sys.x')).toBe('c');
    expect(t('sys.*', 'sys.')).toBe('c');
    expect(t('sys.*', 'sysfoo')).toBe('other');
    expect(t('sys.*', 'SYS.x')).toBe('other');
    expect(t('sys.*', 'news.sys.x')).toBe('other');
    expect(t('*.turn', 'sys.presence.turn')).toBe('c');
    expect(t('*.turn', 'sys.presence.turned')).toBe('other');
    expect(t('a*b*c', 'abc')).toBe('c');
    expect(t('a*b*c', 'axxbyyc')).toBe('c');
    expect(t('a*b*c', 'acb')).toBe('other');
    expect(t('ab*ba', 'aba')).toBe('other');
    expect(t('ab*ba', 'abba')).toBe('c');
    // A middle piece may not overlap the tail: 'ab' then 'b' needs 4 characters after 'x'.
    expect(t('x*ab*b', 'xab')).toBe('other');
    expect(t('x*ab*b', 'xabb')).toBe('c');
    expect(t('*', 'anything')).toBe('c');
    expect(t('a**b', 'ab')).toBe('c');
    // Only `*` is special: regex and glob characters elsewhere are literal.
    expect(t('a.c', 'abc')).toBe('other');
    expect(t('a?c', 'abc')).toBe('other');
    expect(t('a?c', 'a?c')).toBe('c');
    expect(t('[ab]', 'a')).toBe('other');
    // Many stars over a long near-miss subject stay correct (no backtracking build).
    expect(t(`${'*a'.repeat(40)}*b`, 'a'.repeat(120))).toBe('other');
    expect(t(`${'*a'.repeat(40)}*b`, `${'a'.repeat(120)}b`)).toBe('c');
  });

  it('topic: a remote alias:name matches on the whole name or the part after the alias', () => {
    const r = '[{"class":"system","topic":"sys.*"}]';
    const t = (topic: string) => classOf(r, { kind: 'topic', to: null, topic });
    expect(t('pod1:sys.x')).toBe('system');
    expect(t('pod1:sysfoo')).toBe('other');
    expect(t('pod1:news')).toBe('other');
    expect(t(':sys.x')).toBe('other');
    expect(classOf('[{"class":"pod","topic":"pod1:*"}]', { kind: 'topic', to: null, topic: 'pod1:news' })).toBe('pod');
  });

  it('from and to', () => {
    const r = '[{"class":"ops","from":"ops-*"},{"class":"inbox","to":"*-inbox"}]';
    expect(classOf(r, { from: 'ops-1' })).toBe('ops');
    expect(classOf(r, { from: 'dev-1', to: 'x-inbox' })).toBe('inbox');
    expect(classOf(r, { from: 'dev-1', to: 'x-inbox2' })).toBe('other');
  });

  it('a field the message doesn\'t have never matches', () => {
    // A topic glob of `*` still needs a topic; a `to` glob of `*` still needs a recipient.
    expect(classOf('[{"class":"c","topic":"*"}]', { kind: 'direct', topic: null })).toBe('other');
    expect(classOf('[{"class":"c","to":"*"}]', { kind: 'topic', to: null, topic: 'news' })).toBe('other');
  });

  it('every present field must match', () => {
    const r = '[{"class":"c","kind":["topic"],"topic":"sys.*","from":"bot-*"}]';
    expect(classOf(r, { kind: 'topic', to: null, topic: 'sys.x', from: 'bot-1' })).toBe('c');
    expect(classOf(r, { kind: 'topic', to: null, topic: 'sys.x', from: 'me' })).toBe('other');
    expect(classOf(r, { kind: 'topic', to: null, topic: 'news', from: 'bot-1' })).toBe('other');
    expect(classOf('[{"class":"all"}]', { kind: 'reminder' })).toBe('all');
  });

  it('first match wins', () => {
    const t: Partial<Traffic> = { kind: 'topic', to: null, topic: 'sys.presence.turn' };
    expect(classOf('[{"class":"turn","topic":"*.turn"},{"class":"system","topic":"sys.*"}]', t)).toBe('turn');
    expect(classOf('[{"class":"system","topic":"sys.*"},{"class":"turn","topic":"*.turn"}]', t)).toBe('system');
  });

  it('classNames: configured names in rule order, deduplicated, other last; none without rules', () => {
    expect(classNames(rulesOf('[{"class":"b","topic":"x"},{"class":"a","topic":"y"},{"class":"b","topic":"z"}]'))).toEqual(['b', 'a', 'other']);
    expect(classNames([])).toEqual([]);
  });
});

describe('the class label on the counters', () => {
  let db: Database;
  beforeEach(() => { __resetMetricsForTest(); db = openDb(':memory:'); });
  afterEach(() => {
    __resetMetricsForTest();
    applyTrafficClasses([]);
    delete process.env.MESH_METRICS_IDENTITY_LABELS;
  });

  function drive(topic: string, payload: string, ids: { pub: string; sub: string; a: string; b: string }): void {
    for (const id of Object.values(ids)) registerAgent(db, { id, token_hash: id.padEnd(64, '0').slice(0, 64), hostname: 'h' });
    aclGrant(db, ids.pub, ids.sub, 'system');
    aclGrant(db, ids.a, ids.b, 'system');
    getOrCreateTopic(db, topic, ids.pub);
    subscribe(db, ids.sub, topic);
    const idx = new Map<string, WebSocket>([[ids.sub, mockWsOpen()], [ids.b, mockWsOpen()]]);
    expect(routePublish(db, idx, ids.pub, { type: 'publish', msg_id: crypto.randomUUID(), topic, payload }).ok).toBe(true);
    expect(routeDirect(db, idx, ids.a, { type: 'send', msg_id: crypto.randomUUID(), to: ids.b, payload }).ok).toBe(true);
  }

  it('no rules: no class label in either mode, and HELP says so', () => {
    applyTrafficClasses([]);
    drive('sys.x', 'p', { pub: 'pub', sub: 'sub', a: 'a', b: 'b' });
    const off = renderMetrics(db);
    expect(seriesLines(off).filter(l => l.includes('class='))).toEqual([]);
    expect(seriesLines(off)).toContain('mesh_messages_sent_total{kind="topic"} 1');
    expect(seriesLines(off)).toContain('mesh_messages_sent_total{kind="direct"} 1');
    process.env.MESH_METRICS_IDENTITY_LABELS = '1';
    const on = renderMetrics(db);
    expect(seriesLines(on).filter(l => l.includes('class='))).toEqual([]);
    expect(seriesLines(on)).toContain('mesh_messages_sent_total{from_agent="pub",kind="topic"} 1');
    expect(on).toContain('no class label: MESH_METRICS_CLASSES has no rules');
  });

  it('SENTINEL: a topic name, agent ids and a payload never become a label value', () => {
    applyTrafficClasses(rulesOf('[{"class":"system","topic":"zq-*"},{"class":"chat","kind":["direct"],"from":"zq-*"}]'));
    const S = { topic: 'zq-topic-sentinel-7f3a', payload: 'zq-payload-sentinel-91c2' };
    const ids = { pub: 'zq-pub-sentinel', sub: 'zq-sub-sentinel', a: 'zq-a-sentinel', b: 'zq-b-sentinel' };
    drive(S.topic, S.payload, ids);
    // Positive control: the rules did match, so the label is live, not absent.
    process.env.MESH_METRICS_IDENTITY_LABELS = '1';
    const on = seriesLines(renderMetrics(db));
    expect(on).toContain('mesh_messages_sent_total{from_agent="zq-pub-sentinel",kind="topic",class="system"} 1');
    expect(on).toContain('mesh_messages_sent_total{from_agent="zq-a-sentinel",kind="direct",class="chat"} 1');

    delete process.env.MESH_METRICS_IDENTITY_LABELS;
    const off = seriesLines(renderMetrics(db));
    for (const lines of [on, off]) {
      for (const l of lines) {
        const cls = /class="([^"]*)"/.exec(l)?.[1];
        expect(cls === undefined ? l : cls).toBeOneOf(['system', 'chat', 'other']);
      }
      const joined = lines.join('\n');
      expect(joined).not.toContain(S.topic);
      expect(joined).not.toContain(S.payload);
    }
    // With identity labels off, no agent id appears either.
    for (const id of Object.values(ids)) expect(off.join('\n')).not.toContain(id);
  });

  it('identity off: every kind x class pair from zero, bounded by the rules', () => {
    applyTrafficClasses(rulesOf('[{"class":"system","topic":"sys.*"},{"class":"ops","from":"ops-*"},{"class":"system","topic":"hb.*"}]'));
    const lines = seriesLines(renderMetrics(db)).filter(l => l.startsWith('mesh_messages_sent_total'));
    expect(lines).toHaveLength(4 * 3);
    for (const l of lines) expect(l).toMatch(/^mesh_messages_sent_total\{kind="(direct|topic|file|reminder)",class="(system|ops|other)"\} 0$/);
  });

  it('the boot line lists the classes and the rules', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(String(a[0])); });
    try {
      applyTrafficClasses(rulesOf('[{"class":"system","topic":"sys.*"}]'));
      applyTrafficClasses([]);
    } finally { spy.mockRestore(); }
    const [withRules, without] = logs.map(l => JSON.parse(l));
    expect(withRules.evt).toBe('metrics.classes');
    expect(withRules.classes).toEqual(['system', 'other']);
    expect(withRules.rules).toEqual([{ class: 'system', topic: 'sys.*' }]);
    expect(without.classes).toEqual([]);
  });
});

describe('review round', () => {
  let db: Database;
  beforeEach(() => {
    __resetMetricsForTest();
    db = openDb(':memory:');
    process.env.MESH_METRICS_IDENTITY_LABELS = '1';
  });
  afterEach(() => {
    __resetMetricsForTest();
    applyTrafficClasses([]);
    delete process.env.MESH_METRICS_IDENTITY_LABELS;
  });

  it('a `to` rule classifies a topic post the same on the send and the receive side, live and drained', () => {
    applyTrafficClasses(rulesOf('[{"class":"mon","to":"monitor*"}]'));
    for (const id of ['pub', 'monitor-1', 'monitor-2']) registerAgent(db, { id, token_hash: id.padEnd(64, '0').slice(0, 64), hostname: 'h' });
    aclGrant(db, 'pub', 'monitor-1', 'system');
    aclGrant(db, 'pub', 'monitor-2', 'system');
    getOrCreateTopic(db, 'news', 'pub');
    subscribe(db, 'monitor-1', 'news');
    subscribe(db, 'monitor-2', 'news');
    // monitor-1 online (live fan-out), monitor-2 offline (queued, then drained).
    expect(routePublish(db, new Map([['monitor-1', mockWsOpen()]]), 'pub', { type: 'publish', msg_id: crypto.randomUUID(), topic: 'news', payload: 't' }).ok).toBe(true);
    expect(drainQueue(db, 'monitor-2', mockWsOpen())).toBe(1);
    // Positive control: a direct send to the same recipient does match.
    expect(routeDirect(db, new Map([['monitor-1', mockWsOpen()]]), 'pub', { type: 'send', msg_id: crypto.randomUUID(), to: 'monitor-1', payload: 'd' }).ok).toBe(true);

    expect(seriesLines(renderMetrics(db)).sort()).toEqual([
      'mesh_messages_received_total{to_agent="monitor-1",kind="direct",class="mon"} 1',
      'mesh_messages_received_total{to_agent="monitor-1",kind="topic",class="other"} 1',
      'mesh_messages_received_total{to_agent="monitor-2",kind="topic",class="other"} 1',
      'mesh_messages_sent_total{from_agent="pub",kind="direct",class="mon"} 1',
      'mesh_messages_sent_total{from_agent="pub",kind="topic",class="other"} 1',
    ]);
  });

  it('an agent id containing NUL can\'t shift the kind or class it is counted under', () => {
    applyTrafficClasses(rulesOf('[{"class":"system","topic":"sys.*"}]'));
    incSent({ kind: 'topic', from: 'x\0direct\0system', to: null, topic: 'news' });
    delete process.env.MESH_METRICS_IDENTITY_LABELS;
    const lines = seriesLines(renderMetrics(db));
    expect(lines).toContain('mesh_messages_sent_total{kind="topic",class="other"} 1');
    expect(lines.filter(l => l.endsWith(' 1'))).toHaveLength(1);
    process.env.MESH_METRICS_IDENTITY_LABELS = '1';
    expect(seriesLines(renderMetrics(db))).toContain('mesh_messages_sent_total{from_agent="x\0direct\0system",kind="topic",class="other"} 1');
  });

  it('a queued file is counted as received when it is drained', () => {
    for (const id of ['a', 'b']) registerAgent(db, { id, token_hash: id.padEnd(64, '0'), hostname: 'h' });
    aclGrant(db, 'a', 'b', 'system');
    const data = Buffer.from('queued-file').toString('base64');
    expect(routeFile(db, new Map(), 'a', { type: 'file_send', msg_id: crypto.randomUUID(), to: 'b', filename: 'f.txt', data }, 10_485_760, tmp('r311-files-')).ok).toBe(true);
    expect(seriesLines(renderMetrics(db)).filter(l => l.startsWith('mesh_messages_received_total'))).toEqual([]);
    expect(drainFileQueue(db, 'b', mockWsOpen())).toBe(1);
    expect(seriesLines(renderMetrics(db))).toContain('mesh_messages_received_total{to_agent="b",kind="file"} 1');
  });

  it('a file uploaded on the admin API to an online agent is counted as received', async () => {
    for (const id of ['alice', 'bob']) registerAgent(db, { id, token_hash: id.padEnd(64, '0'), hostname: 'h' });
    aclGrant(db, 'alice', 'bob', 'system');
    const handle = await startHttpAdmin(0, db, 'tok', 10_485_760, tmp('r311-admin-files-'), new Map([['bob', mockWsOpen()]]));
    try {
      const form = new FormData();
      form.append('file', new File(['hello'], 'h.txt', { type: 'text/plain' }));
      form.append('from_agent', 'alice');
      form.append('to_agent', 'bob');
      const res = await fetch(`http://127.0.0.1:${(handle.server.address() as net.AddressInfo).port}/files`, {
        method: 'POST', headers: { Authorization: 'Bearer tok' }, body: form,
      });
      expect(res.status).toBe(201);
    } finally { await handle.shutdown().catch(() => {}); }
    expect(seriesLines(renderMetrics(db))).toContain('mesh_messages_received_total{to_agent="bob",kind="file"} 1');
  });
});
