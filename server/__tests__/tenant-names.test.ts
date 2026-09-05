import { describe, it, expect } from 'bun:test';
import {
  checkTenantName,
  checkAgentShortName,
  checkHomeAgentId,
  fqId,
  RESERVED_TENANT_NAMES,
  TENANT_NAME_RE,
} from '../tenant-names.ts';

// DESIGN_FEDERATION §4 + PR #77 §7 amendment. "Reserved" is a property of every
// writing surface refusing the word, not of the word — §3/§5.1 called `home`
// reserved while POST /agents would have created it. These tests pin the
// grammar and the refusals; the route-level tests pin that each SURFACE calls
// this.

describe('checkTenantName', () => {
  it('accepts the grammar: lowercase alnum with inner dashes, 1-63', () => {
    for (const ok of ['a', 'acme', 'acme-corp', 'a1', '9lives', 'x'.repeat(63)]) {
      expect(checkTenantName(ok).ok).toBe(true);
    }
  });

  it('refuses anything outside it, naming the grammar', () => {
    for (const bad of ['', 'Acme', 'acme_corp', 'acme.corp', '-lead', 'x'.repeat(64), 'a b']) {
      const r = checkTenantName(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it("★ refuses a colon — the FQ separator, or `a:b` could forge membership", () => {
    expect(checkTenantName('acme:evil').ok).toBe(false);
  });

  it('★ refuses every reserved word, with the AMBIGUITY reason stated', () => {
    for (const word of RESERVED_TENANT_NAMES) {
      const r = checkTenantName(word);
      expect(r.ok).toBe(false);
      // The reason must explain the consequence, not just assert reservation:
      // a future reader adding a word needs to know what breaks without it.
      if (!r.ok) expect(r.reason).toMatch(/reserved|ambiguous/i);
    }
  });

  it('home and mesh are BOTH reserved — the set is not just home', () => {
    // `mesh` collides with the system sender (§6), whose deliveries are exempt
    // from the admit rule; that is a collision with an exemption, not a label.
    expect(RESERVED_TENANT_NAMES.has('home')).toBe(true);
    expect(RESERVED_TENANT_NAMES.has('mesh')).toBe(true);
    expect(checkTenantName('mesh').ok).toBe(false);
  });
});

describe('checkAgentShortName', () => {
  it('holds minted agents to the full grammar', () => {
    expect(checkAgentShortName('worker-1').ok).toBe(true);
    expect(checkAgentShortName('Worker').ok).toBe(false);
    expect(checkAgentShortName('a:b').ok).toBe(false);
    expect(checkAgentShortName('home').ok).toBe(false);
  });
});

describe('checkHomeAgentId — the two refusals POST /agents gains', () => {
  it('★ keeps the permissive grammar: existing fleet ids must still register', () => {
    // The asymmetry is deliberate (§4): tightening the grammar here would
    // break ids the fleet already uses. Only the two FQ-protecting refusals
    // are added.
    for (const legacy of ['spawner-backend', 'mesh_builder', 'Agent.One', 'x'.repeat(80)]) {
      expect(checkHomeAgentId(legacy).ok).toBe(true);
    }
  });

  it('★ refuses a colon — a home agent must not be able to forge an FQ id', () => {
    const r = checkHomeAgentId('acme:worker');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(':');
  });

  it('refuses the bare reserved words', () => {
    expect(checkHomeAgentId('home').ok).toBe(false);
    expect(checkHomeAgentId('mesh').ok).toBe(false);
  });

  it('a reserved word as a PREFIX is fine — only the exact word is reserved', () => {
    // Guards against a future "startsWith" reading of reservation, which would
    // refuse legitimate ids like `mesh-builder` (this agent).
    expect(checkHomeAgentId('mesh-builder').ok).toBe(true);
    expect(checkTenantName('home-office').ok).toBe(true);
  });
});

describe('fqId', () => {
  it('composes <tenant>:<name>, in one place', () => {
    expect(fqId('acme', 'worker-1')).toBe('acme:worker-1');
  });

  it('★ round-trips with the grammar: neither half can contain the separator', () => {
    // The invariant that makes splitting an FQ id unambiguous. If either
    // validator ever admitted a colon, this is what would catch it.
    const tenant = 'acme';
    const name = 'worker-1';
    expect(checkTenantName(tenant).ok).toBe(true);
    expect(checkAgentShortName(name).ok).toBe(true);
    expect(fqId(tenant, name).split(':')).toEqual([tenant, name]);
    expect(TENANT_NAME_RE.test(':')).toBe(false);
  });
});
