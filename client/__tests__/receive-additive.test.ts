import { describe, it, expect, afterEach } from 'bun:test';
import { WebSocketServer, WebSocket as WsSocket } from 'ws';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MeshClient, Inbound } from '../src/index.ts';

// #176 - THE RECEIVE PATH IS ADDITIVE-SAFE, and until now that was true by
// luck of construction rather than by a pinned invariant.
//
// F4 added an 11th key (`origin`) to every deliver frame while old clients were
// live. Two consumers were checked AFTER the fact and both tolerated it -
// `JSON.parse` plus a compile-time cast, dispatch on `frame.type` alone, and a
// normalize step that copies named fields, so an unknown key is parsed, never
// read, and dropped. The window was a non-event. But neither F4 review could
// see that: both were scoped to the server repo, and nothing on this side said
// the property had to hold.
//
// So: the server may ADD a deliver field without a client roll, and may add a
// frame TYPE that old clients ignore. Changing either of those is a
// wire-protocol version bump, and this file is what makes that a decision.
//
// A FAKE SERVER, not the real one, because the real one cannot produce the
// inputs the invariant is about: a frame from the future. It speaks only enough
// of the handshake to get the client authenticated, then pushes whatever bytes
// a test asks for.

let portCounter = 19900;

interface Fake {
  port: number;
  /** Send a frame (or raw string) to the connected client. */
  push(frame: Record<string, unknown> | string): void;
  /** How many sockets have authenticated - a reconnect shows up here. */
  auths(): number;
  close(): Promise<void>;
}

function startFake(): Promise<Fake> {
  const port = portCounter++;
  const wss = new WebSocketServer({ port });
  let live: WsSocket | null = null;
  let auths = 0;

  wss.on('connection', (ws) => {
    live = ws;
    ws.on('message', (raw: unknown) => {
      let f: Record<string, unknown>;
      try { f = JSON.parse(String(raw)); } catch { return; }
      if (f.type === 'auth') {
        auths++;
        ws.send(JSON.stringify({ type: 'auth_ok', agent_id: f.agent_id, queued: 0, queued_files: 0 }));
        return;
      }
      if (f.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: f.ts, server_ts: Date.now() }));
        return;
      }
      // `send` is ACKED, because one test needs a pending ack to survive an
      // unknown frame arriving in the middle of it.
      if (f.type === 'send' && typeof f.msg_id === 'string') {
        ws.send(JSON.stringify({ type: 'ack', ref: f.msg_id, ok: true }));
      }
    });
  });

  return new Promise<Fake>((resolve) => {
    wss.on('listening', () => resolve({
      port,
      push: (frame) => live?.send(typeof frame === 'string' ? frame : JSON.stringify(frame)),
      auths: () => auths,
      close: () => new Promise<void>((res) => { wss.close(() => res()); }),
    }));
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A deliver frame as the server writes it today, plus whatever a test adds. */
const deliverFrame = (over: Record<string, unknown> = {}) => ({
  type: 'deliver',
  msg_id: 'm-1',
  kind: 'direct',
  from: 'someone',
  to: 'me',
  topic: null,
  correlation_id: null,
  payload: 'hello',
  content_type: 'text/plain',
  sent_at: 1_700_000_000_000,
  ...over,
});

describe('#176 the receive path is additive-safe', () => {
  const started: { client: MeshClient; fake: Fake }[] = [];
  afterEach(async () => {
    for (const { client, fake } of started.splice(0)) {
      client.close();
      await fake.close().catch(() => {});
    }
  });

  async function connected(): Promise<{ client: MeshClient; fake: Fake; inbox: Inbound[] }> {
    const fake = await startFake();
    const client = new MeshClient({
      serverUrl: `ws://127.0.0.1:${fake.port}`, agentId: 'me', agentToken: 't',
    });
    started.push({ client, fake });
    const inbox: Inbound[] = [];
    client.onMessage((m) => { inbox.push(m); });
    await client.connect();
    return { client, fake, inbox };
  }

  // THE HARNESS'S OWN CONTROL, first. Every assertion below is of the form
  // "nothing bad happened", and those are satisfied by a harness that delivers
  // nothing at all.
  it('CONTROL: an ordinary deliver frame arrives', async () => {
    const { fake, inbox } = await connected();
    fake.push(deliverFrame());
    await delay(50);

    expect(inbox.length).toBe(1);
    expect(inbox[0]!.msgId).toBe('m-1');
    expect(inbox[0]!.text).toBe('hello');
    expect(inbox[0]!.origin).toBe(null);
  });

  // (1) A FIELD FROM THE FUTURE. This is the exact shape F4 shipped: a key the
  // client has never heard of, on a frame it otherwise understands.
  it('an UNKNOWN deliver key is parsed, ignored, and absent from the Inbound', async () => {
    const { fake, inbox } = await connected();
    fake.push(deliverFrame({
      future_field: 'a value from a newer server',
      another: { nested: [1, 2, 3] },
    }));
    await delay(50);

    expect(inbox.length).toBe(1);
    const m = inbox[0]!;
    expect(m.msgId).toBe('m-1');
    expect(m.text).toBe('hello');
    // The unknown keys do not ride along. `normalizeDeliver` copies NAMED
    // fields, which is the mechanism this asserts the effect of - a spread
    // would put both of these on the object.
    expect(Object.keys(m)).not.toContain('future_field');
    expect(Object.keys(m)).not.toContain('another');
  });

  // The SAME shape as the one that actually shipped, named so a reader can see
  // the history rather than infer it.
  it('the F4 case specifically: `origin` on a client that predates it', async () => {
    const { fake, inbox } = await connected();
    fake.push(deliverFrame({ origin: 'orch:pod1:alice' }));
    await delay(50);

    expect(inbox[0]!.origin).toBe('orch:pod1:alice');
  });

  // (1b) A KNOWN KEY WITH AN UNEXPECTED TYPE. The SDK casts at compile time and
  // does not validate at runtime, so the value is PASSED THROUGH. That is the
  // honest statement of the contract: the receive path does not crash and does
  // not drop the message, and a consumer that needs a number checks for one.
  it('a known key with the wrong TYPE does not throw or drop the message', async () => {
    const { fake, inbox } = await connected();
    fake.push(deliverFrame({ sent_at: 'not-a-number', kind: 42 }));
    await delay(50);

    expect(inbox.length).toBe(1);
    expect(inbox[0]!.sentAt as unknown).toBe('not-a-number');
    // ...and the connection is untouched: still one authentication.
    expect(fake.auths()).toBe(1);
  });

  it('a MISSING key normalizes rather than throwing', async () => {
    const { fake, inbox } = await connected();
    fake.push({ type: 'deliver', msg_id: 'm-2', payload: 'bare' });
    await delay(50);

    expect(inbox.length).toBe(1);
    expect(inbox[0]!.msgId).toBe('m-2');
    // `origin` is the one field with a stated default, and it holds even when
    // every other key is absent.
    expect(inbox[0]!.origin).toBe(null);
  });

  // (2) AN UNKNOWN FRAME TYPE. This is the half nobody measured: dispatch's
  // `default` must be a no-op, which means no throw, no reconnect, and no
  // disturbance to a pending ack.
  it('an UNKNOWN frame type is a no-op: no throw, no reconnect, no lost ack', async () => {
    const { client, fake, inbox } = await connected();

    // A send is in flight, so the pending-ack map is non-empty when the
    // unknown frame lands. The fake acks `send`, so this resolves - unless the
    // unknown frame disturbed the map or the socket.
    const pending = client.send('someone', 'hi');
    fake.push({ type: 'a_type_from_the_future', anything: { at: 'all' } });
    fake.push({ type: 'deliver_v2', msg_id: 'm-3', payload: 'ignored' });
    await expect(pending).resolves.toBeUndefined();

    await delay(50);
    // No reconnect: a thrown handler would tear the socket down and the client
    // would authenticate again.
    expect(fake.auths()).toBe(1);
    // The unknown types produced no message, and the ordinary path still works
    // afterwards - the socket is alive, not merely unclosed.
    expect(inbox.length).toBe(0);
    fake.push(deliverFrame({ msg_id: 'm-4' }));
    await delay(50);
    expect(inbox.map(m => m.msgId)).toEqual(['m-4']);
  });

  // ADJACENT, and pinned because it is the same property one layer lower: the
  // parse itself. Bytes that are not JSON at all must not kill the connection.
  it('an UNPARSEABLE frame is ignored and the connection survives', async () => {
    const { fake, inbox } = await connected();
    fake.push('this is not json {');
    await delay(50);

    expect(fake.auths()).toBe(1);
    fake.push(deliverFrame({ msg_id: 'm-5' }));
    await delay(50);
    expect(inbox.map(m => m.msgId)).toEqual(['m-5']);
  });

  // (3) THE INVARIANT IS WRITTEN DOWN WHERE IT IS RELIED ON. A property with no
  // note at the code is one the next edit removes without noticing - the F4
  // window happened precisely because nothing on this side said the property
  // had to hold.
  it('normalizeDeliver names the invariant, and dispatch keeps its default arm', () => {
    const src = readFileSync(join(import.meta.dir, '../src/client.ts'), 'utf8');
    expect(src).toContain('ADDITIVE-SAFE');
    expect(src).toContain('#176');
    // The mechanism the tests above measure: a named-field copy, and a default
    // arm that returns. Either one silently becoming a spread or a throw is
    // what this file exists to catch.
    expect(src).toMatch(/default:\s*\n\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*return;/);
  });
});
