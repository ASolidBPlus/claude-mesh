import { describe, it, expect } from 'bun:test';
import { fileAccessAuthorized, type AuthResult } from '../http-admin.ts';

// #84 triage ① — the dispatcher's placeholder for auth:'handler' routes was
// { mode: 'admin' }: "nobody checked a credential" represented by the MOST
// privileged value in the union. Inert only because the one handler-mode route
// (POST /register) never reads ctx.auth — but auth.mode === 'admin' is a GRANT
// on the file path, so the next handler-mode route would have inherited admin
// access by default, from a line whose author never thought about files.
//
// Root cause was type-level: AuthResult could not SAY "unauthenticated", so the
// dispatcher had no honest value to use. It can now, and these pin that the new
// mode grants nothing.

const FILE = { from_agent: 'A', to_agent: 'B' };

describe('#84 ①: unauthenticated is never a grant', () => {
  it('refuses file access to a handler-mode caller that reads ctx.auth', () => {
    const auth: AuthResult = { mode: 'unauthenticated' };
    expect(fileAccessAuthorized(auth, FILE)).toBe(false);
  });

  it('refuses even for a file the caller would own were it authenticated', () => {
    // The 'unauthenticated' variant carries no agentId at all — there is no
    // identity to match against from_agent/to_agent. Structural, not a check
    // someone must remember to write.
    expect(fileAccessAuthorized({ mode: 'unauthenticated' }, { from_agent: 'X', to_agent: 'X' })).toBe(false);
  });

  // Positive controls: an absence test that cannot distinguish "refused" from
  // "the predicate refuses everything" proves nothing.
  it('still grants admin, and grants an agent only its own files', () => {
    expect(fileAccessAuthorized({ mode: 'admin' }, FILE)).toBe(true);
    expect(fileAccessAuthorized({ mode: 'agent', agentId: 'A' }, FILE)).toBe(true);
    expect(fileAccessAuthorized({ mode: 'agent', agentId: 'B' }, FILE)).toBe(true);
    expect(fileAccessAuthorized({ mode: 'agent', agentId: 'C' }, FILE)).toBe(false);
  });
});
