import { describe, it, expect, afterEach } from 'bun:test';
import { MeshClient } from '../src/client.ts';

// #100 — an unknown config key is REFUSED, not ignored.
//
// The reason is the incident shape, not tidiness. Every MeshClientConfig field
// falls back to an environment variable, so a misspelled key is not inert: it
// is silently replaced by the environment. A throwaway script written against
// localhost with `{ url: … }` instead of `{ serverUrl: … }` connects to
// whatever MESH_SERVER_URL names — in a fleet container, production.
//
// A draft test did exactly this, which is why an incident review had to ask
// every agent whether one of their scripts had connected to production. The
// guard converts that from "nobody can tell" into "it will not start".
describe('#100 MeshClientConfig fails loud on unknown keys', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['MESH_SERVER_URL', 'MESH_AGENT_ID', 'MESH_AGENT_TOKEN']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  // THE INCIDENT, reproduced. Env points somewhere real; the caller means
  // localhost and misspells the key. Before #100 this constructed happily and
  // connected to the env target.
  it('the exact near-miss: `url` instead of `serverUrl` does not silently use the environment', () => {
    process.env.MESH_SERVER_URL = 'ws://production.example:7432';
    expect(() => new MeshClient({ url: 'ws://127.0.0.1:9999' } as never))
      .toThrow(/unknown config key 'url'/);
  });

  it('names the offending key, and lists the ones that exist', () => {
    process.env.MESH_SERVER_URL = 'ws://127.0.0.1:1';
    let msg = '';
    try { new MeshClient({ srvUrl: 'x' } as never); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("'srvUrl'");
    expect(msg).toContain('serverUrl');      // the key they probably meant
    expect(msg).toContain('agentToken');     // the full known set is listed
  });

  it('pluralises and names every unknown key, not just the first', () => {
    process.env.MESH_SERVER_URL = 'ws://127.0.0.1:1';
    let msg = '';
    try { new MeshClient({ url: 'x', token: 'y' } as never); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("'url'");
    expect(msg).toContain("'token'");
    expect(msg).toContain('unknown config keys');
  });

  // POSITIVE CONTROL. Without this, a constructor that threw on EVERYTHING
  // would pass every assertion above. Every documented key, together.
  it('CONTROL: every documented key still constructs', () => {
    expect(() => new MeshClient({
      serverUrl: 'ws://127.0.0.1:1',
      agentId: 'a',
      agentToken: 't',
      httpUrl: 'http://127.0.0.1:2',
      pingIntervalMs: 1,
      pongDeadlineMs: 2,
      ackTimeoutMs: 3,
    })).not.toThrow();
  });

  // The other half of the control: the empty config is legal when the
  // environment supplies what is needed, which is how production plugins
  // construct. #100 must not break that.
  it('CONTROL: an empty config still constructs from the environment', () => {
    process.env.MESH_SERVER_URL = 'ws://127.0.0.1:1';
    expect(() => new MeshClient()).not.toThrow();
  });

  it('missing serverUrl with an empty environment throws at construction', () => {
    delete process.env.MESH_SERVER_URL;
    expect(() => new MeshClient({ agentId: 'a', agentToken: 't' }))
      .toThrow(/serverUrl is required/);
  });
});
