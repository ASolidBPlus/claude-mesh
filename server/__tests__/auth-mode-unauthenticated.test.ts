import { describe, it, expect } from 'bun:test';
import { fileAccessAuthorized, resolveRouteAuth, type AuthResult } from '../http-admin.ts';
import { openDb } from '../db.ts';
import type * as http from 'http';

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

// A fake response that records whether the dispatcher wrote a refusal, so the
// wiring tests can tell "returned a value" from "wrote a 401 and returned null".
function fakeRes(): http.ServerResponse & { statusCode_: number | null } {
  const rec = { statusCode_: null as number | null };
  return {
    ...rec,
    writeHead(code: number) { rec.statusCode_ = code; return this; },
    end() { return this; },
    get written() { return rec.statusCode_; },
  } as unknown as http.ServerResponse & { statusCode_: number | null };
}

function reqWith(auth?: string): http.IncomingMessage {
  return { headers: auth === undefined ? {} : { authorization: auth } } as http.IncomingMessage;
}

// The WIRING half. Without these, restoring the old { mode: 'admin' } placeholder
// in the dispatcher passes every predicate test AND the typecheck — verified: it
// did exactly that when this fix was first written with the assignment inline.
describe('#84 ①: the dispatcher produces unauthenticated for handler routes', () => {
  it('handler-mode yields unauthenticated, with no credential presented', () => {
    const db = openDb(':memory:');
    const res = fakeRes();
    const auth = resolveRouteAuth(reqWith(), res, db, 'admin-secret', 'handler');
    expect(auth).toEqual({ mode: 'unauthenticated' });
    expect((res as unknown as { written: number | null }).written).toBeNull();
    db.close();
  });

  it('handler-mode yields unauthenticated even when the ADMIN token is presented', () => {
    // Presenting a valid admin token to a handler-mode route must not upgrade
    // the ctx: the route's own check is the only thing that may authorize it.
    const db = openDb(':memory:');
    const auth = resolveRouteAuth(reqWith('Bearer admin-secret'), fakeRes(), db, 'admin-secret', 'handler');
    expect(auth).toEqual({ mode: 'unauthenticated' });
    db.close();
  });

  it('admin-mode still requires the admin token, and unmatched routes still refuse', () => {
    const db = openDb(':memory:');
    expect(resolveRouteAuth(reqWith('Bearer admin-secret'), fakeRes(), db, 'admin-secret', 'admin'))
      .toEqual({ mode: 'admin' });

    const badRes = fakeRes();
    expect(resolveRouteAuth(reqWith('Bearer wrong'), badRes, db, 'admin-secret', 'admin')).toBeNull();
    expect((badRes as unknown as { written: number | null }).written).toBe(401);

    // undefined mode = no route matched: still admin-gated, so 404s are not an
    // existence oracle for unauthenticated callers.
    const noRouteRes = fakeRes();
    expect(resolveRouteAuth(reqWith(), noRouteRes, db, 'admin-secret', undefined)).toBeNull();
    expect((noRouteRes as unknown as { written: number | null }).written).toBe(401);
    db.close();
  });
});

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
