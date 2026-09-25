import { describe, it, expect, spyOn } from 'bun:test';
import * as clientModule from '../src/client.ts';
import { MeshClient, assertRuntimeVerifiesIpIdentity } from '../src/client.ts';

// The runtime floor for IP-literal wss:// (client.ts). Measured on Bun 1.3.14:
// wss://<ip> accepts any certificate chaining to any trusted CA, whatever names
// it carries. Bun 1.4.2 and Node refuse. The property itself is proven where it
// can be — server/__tests__/native-tls.test.ts dials a two-SAN certificate at a
// third address on whatever Bun runs the suite. This file pins the gate that
// reaches a CONSUMER's runtime, which no test of ours can run in.

const refuses = (url: string, v: string | undefined): boolean => {
  try { assertRuntimeVerifiesIpIdentity(url, v); return false; } catch (e) {
    expect((e as { code?: string }).code).toBe('TLS_IDENTITY_UNVERIFIABLE');
    return true;
  }
};

describe('assertRuntimeVerifiesIpIdentity', () => {
  it('refuses wss:// to an IP literal on Bun < 1.4, v4 and v6', () => {
    expect(refuses('wss://10.20.0.5:7384', '1.3.14')).toBe(true);
    expect(refuses('wss://[fd00::5]:7384', '1.3.14')).toBe(true);
    expect(refuses('wss://10.20.0.5:7384', '0.9.0')).toBe(true);
  });

  it('allows the same URL on Bun >= 1.4, and on Node (no Bun)', () => {
    for (const v of ['1.4.0', '1.4.2', '1.10.0', '2.0.0', undefined]) {
      expect(refuses('wss://10.20.0.5:7384', v)).toBe(false);
    }
  });

  it('does not touch what the old runtime DOES verify: names, and plaintext ws://', () => {
    // Names are identity-checked on 1.3 (measured: a cert without `localhost`
    // is refused at wss://localhost). ws:// has no identity to verify.
    expect(refuses('wss://bus.org-a.range:7384', '1.3.14')).toBe(false);
    expect(refuses('ws://10.20.0.5:7384', '1.3.14')).toBe(false);
  });

  it('the message names the URL, the runtime and the way out', () => {
    try { assertRuntimeVerifiesIpIdentity('wss://10.20.0.5:7384', '1.3.14'); } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('wss://10.20.0.5:7384');
      expect(m).toContain('requires Bun >= 1.4');
      expect(m).toContain('Bun 1.3.14');
      return;
    }
    throw new Error('did not refuse');
  });

  it('connect() consults it with the URL it is about to dial, before any socket opens', async () => {
    // Bun.version is not configurable, so the old runtime cannot be faked
    // here; what CAN be pinned is that connect() calls the gate with the
    // resolved URL and propagates its refusal. The spy is on the module's own
    // export, which is the binding connect() calls.
    const seen: string[] = [];
    const spy = spyOn(clientModule, 'assertRuntimeVerifiesIpIdentity').mockImplementation((url: string) => {
      seen.push(url);
      throw Object.assign(new Error('refused by test'), { code: 'TLS_IDENTITY_UNVERIFIABLE' });
    });
    try {
      const c = new MeshClient({ serverUrl: 'wss://10.255.255.1:1', agentId: 'a', agentToken: 't', ca: 'irrelevant' });
      const err = await c.connect().then(() => null, (e: unknown) => e as { code?: string });
      expect(err?.code).toBe('TLS_IDENTITY_UNVERIFIABLE');
      expect(seen).toEqual(['wss://10.255.255.1:1']);
      c.close();
    } finally { spy.mockRestore(); }
  });
});

describe('MeshClient config: `ca` is a known key', () => {
  it('is accepted at construction (the unknown-key guard would otherwise throw)', () => {
    expect(() => new MeshClient({ serverUrl: 'wss://bus.example:7384', agentId: 'a', agentToken: 't', ca: '-' })).not.toThrow();
  });
});
