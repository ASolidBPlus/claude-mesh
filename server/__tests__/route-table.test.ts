import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES } from '../http-admin.ts';

// THE AUTH SURFACE, PINNED — one line per route, in the table's own order.
//
// #199 split http-admin.ts into ten modules, and the check that split actually
// owed was one nobody had on a list: DOES ANY ROUTE'S AUTH CHANGE? A refactor
// can move a handler between modules and change which credential reaches which
// route without touching a handler — the route table is where that decision
// lives, and moving handlers is exactly when it is easiest to disturb.
//
// The seat measured it per-split, extracting the table from a RUNNING IMPORT on
// both sides and diffing: 30 routes each, identical. This is the standing form
// of that measurement, and the argument for it is that the property does not
// need a refactor to break — an edit to ROUTES does it too, and a check that
// only runs when someone thinks to run it protects nothing between the times
// they think of it.
//
// TWO READINGS, BECAUSE NEITHER IS SUFFICIENT ALONE:
//
//   RUNTIME  method, handler name and auth scope come from the imported table.
//            That is what the dispatcher actually consults — a grep can drift
//            from it, and the whole point of an auth pin is to describe what
//            RUNS.
//   SOURCE   the path cannot be recovered at runtime: `match` is a closure over
//            `exact('/peers')` or `idMatch(/…/)`, and `String(route.match)`
//            renders identically for every route of the same kind (measured).
//            So the matcher text is read from the source table.
//
// The two are then required to correspond ONE-TO-ONE BY INDEX, so the parse
// cannot silently drift from the runtime — a source scan that fell behind would
// otherwise pin a table nobody dispatches on.

const SRC = readFileSync(join(import.meta.dir, '../http-admin.ts'), 'utf8');

/** The ROUTES entries as written: method, matcher text, handler, optional auth. */
export function sourceRoutes(src: string = SRC): { method: string; matcher: string; handler: string; auth: string }[] {
  const start = src.indexOf('export const ROUTES');
  const table = src.slice(start, src.indexOf('\n];', start));
  // LINE BY LINE, and the matcher is the text BETWEEN `match:` and `handler:`
  // rather than a regex for its shape. A pattern that tries to parse
  // `idMatch(/^\/files\/([^/]+)$/)` has to model slashes inside a character
  // class, and mine silently skipped that one route — which is the auth-scoped
  // one, i.e. exactly the route this file exists for. Taking the span keeps the
  // parser ignorant of matcher syntax.
  //
  // AN UNREADABLE LINE IS SKIPPED, NOT THROWN ON (seat 2). It used to assert
  // its way through with `!`, so a route written across two lines — a
  // reformatting, not a defect — raised a TypeError during the parse and NONE
  // of the assertions below ran: "Ran 0 tests across 1 file", exit 1. It failed
  // closed, but the correspondence control exists precisely to catch a source
  // parse that has fallen behind the runtime table, and a crash pre-empts the
  // one case it was built for. Skipping turns the exception into the
  // assertion, which is what the file is for.
  return table.split('\n')
    .filter(l => /\bmethod:\s*'[A-Z]+'/.test(l))
    .map(l => {
      const method = /\bmethod:\s*'([A-Z]+)'/.exec(l)?.[1];
      const handler = /\bhandler:\s*([A-Za-z0-9_]+)/.exec(l)?.[1];
      const mi = l.indexOf('match:');
      const hi = l.indexOf('handler:');
      if (method === undefined || handler === undefined || mi === -1 || hi < mi) return null;
      const auth = /\bauth:\s*'([a-zA-Z]+)'/.exec(l)?.[1] ?? 'admin';
      const matcher = l.slice(mi + 'match:'.length, hi).replace(/,\s*$/, '').trim().replace(/,$/, '');
      return { method, matcher, handler, auth };
    })
    .filter((r): r is { method: string; matcher: string; handler: string; auth: string } => r !== null);
}

/** One line per route, the form the expectation below is written in. */
const render = (r: { method: string; matcher: string; handler: string; auth: string }) =>
  `${r.method} ${r.matcher} auth=${r.auth} -> ${r.handler}`;

describe('#199 the admin route table pins its auth surface', () => {
  const parsed = sourceRoutes();

  // CONTROL ON THE PARSER, which is the part that can silently return nothing:
  // a regex that stopped matching would turn this file into a green that pins
  // an empty table.
  it('CONTROL: the parse and the running table agree, one to one', () => {
    expect(parsed.length).toBeGreaterThanOrEqual(25);
    expect(parsed.length).toBe(ROUTES.length);
    // Index by index: method, handler NAME and auth scope come from the table
    // the dispatcher consults, so a parse that fell behind reds here rather
    // than pinning a fiction.
    const runtime = ROUTES.map(r => `${r.method} ${r.handler.name} ${r.auth ?? 'admin'}`);
    const fromSource = parsed.map(r => `${r.method} ${r.handler} ${r.auth}`);
    expect(fromSource).toEqual(runtime);
  });

  // THE PIN. Auth scope is the field this exists for: `admin` requires the
  // admin token, `agentOrAdmin` also accepts an agent's own bearer token, and
  // `handler` means the DISPATCHER checks nothing and the handler owns its
  // authentication. A route silently moving between those is the change this
  // file makes impossible to land unnoticed.
  it('every route, in order, with its auth scope', () => {
    expect(parsed.map(render)).toEqual([
      "POST exact('/outbound-peers') auth=admin -> handleOutboundPeerPost",
      "GET exact('/outbound-peers') auth=admin -> handleOutboundPeerGet",
      "DELETE idMatch(/^\\/outbound-peers\\/([^/]+)$/) auth=admin -> handleOutboundPeerDelete",
      "PATCH idMatch(/^\\/outbound-peers\\/([^/]+)$/) auth=admin -> handleOutboundPeerPatch",
      "POST exact('/peer-keys') auth=admin -> handlePeerKeyPost",
      "GET exact('/peer-keys') auth=admin -> handlePeerKeyGet",
      "DELETE idMatch(/^\\/peer-keys\\/([^/]+)$/) auth=admin -> handlePeerKeyDelete",
      "GET exact('/peers') auth=admin -> handlePeerGet",
      "GET idMatch(/^\\/peers\\/([^/]+)\\/subscriptions$/) auth=admin -> handlePeerSubscriptionsGet",
      "POST exact('/peers/register') auth=handler -> handlePeerRegister",
      "POST exact('/acl') auth=admin -> handleAclPost",
      "DELETE exact('/acl') auth=admin -> handleAclDelete",
      "GET exact('/acl') auth=admin -> handleAclGet",
      "POST exact('/observers') auth=admin -> handleObserverPost",
      "DELETE idMatch(/^\\/observers\\/([^/]+)$/) auth=admin -> handleObserverDelete",
      "GET exact('/observers') auth=admin -> handleObserverGet",
      "POST exact('/topics') auth=admin -> handleTopicPost",
      "GET exact('/topics') auth=admin -> handleTopicGet",
      "POST exact('/agents') auth=admin -> handleAgentPost",
      "GET exact('/agents') auth=admin -> handleAgentGet",
      "GET idMatch(/^\\/agents\\/([^/]+)$/) auth=admin -> handleAgentById",
      "PATCH idMatch(/^\\/agents\\/([^/]+)$/) auth=admin -> handleAgentPatch",
      "DELETE idMatch(/^\\/agents\\/([^/]+)$/) auth=admin -> handleAgentDelete",
      "GET exact('/messages') auth=agentOrAdmin -> handleMessagesGet",
      "GET idMatch(/^\\/files\\/([^/]+)$/) auth=agentOrAdmin -> handleFileById",
      "POST exact('/files') auth=admin -> handleFilePost",
      "POST exact('/reminders') auth=admin -> handleReminderPost",
      "GET exact('/reminders') auth=admin -> handleReminderGet",
      "PATCH idMatch(/^\\/reminders\\/([^/]+)$/) auth=admin -> handleReminderPatch",
      "DELETE idMatch(/^\\/reminders\\/([^/]+)$/) auth=admin -> handleReminderDelete",
    ]);
  });

  // THE THREE NON-DEFAULT SCOPES, named individually. The list above would
  // catch a change to any of them, but a reader looking for "which routes are
  // not admin-only" should find the answer stated rather than have to diff a
  // thirty-line array.
  it('exactly three routes are not admin-only, and they are these', () => {
    const notAdmin = parsed.filter(r => r.auth !== 'admin').map(render);
    expect(notAdmin).toEqual([
      "POST exact('/peers/register') auth=handler -> handlePeerRegister",
      "GET exact('/messages') auth=agentOrAdmin -> handleMessagesGet",
      "GET idMatch(/^\\/files\\/([^/]+)$/) auth=agentOrAdmin -> handleFileById",
    ]);
  });

  // THE PARSE FAILS AS AN ASSERTION, NOT AS AN EXCEPTION. A route written
  // across two lines is a reformatting, not a defect, and the file's own claim
  // is that the correspondence control catches a parse that has fallen behind.
  // While the parser threw, that control never ran in the case it exists for —
  // "Ran 0 tests across 1 file" is a red with zero assertions, which is the same
  // fact as a green with zero assertions in different clothes.
  it('CONTROL: an unreadable entry is skipped, so the count control can speak', () => {
    const synthetic = [
      'export const ROUTES: Route[] = [',
      "  { method: 'GET', match: exact('/one'), handler: handleOne },",
      "  { method: 'POST',",           // the reformatted entry: method here...
      '    match: exact(\'/two\'), handler: handleTwo },',   // ...matcher and handler there
      "  { method: 'GET', match: exact('/three'), handler: handleThree },",
      '];',
    ].join('\n');

    const parsed = sourceRoutes(synthetic);
    // No throw, and the unreadable entry is ABSENT rather than guessed at.
    expect(parsed.map(r => r.handler)).toEqual(['handleOne', 'handleThree']);
    // ...which is what lets the correspondence control report the difference:
    // "source parsed 2, the runtime table has 3" is an assertion a reader can
    // act on; a TypeError at line 47 is not.
    expect(parsed.length).toBe(2);
  });

  // CONTROL ON THE RENDERER: the auth scope must actually reach the rendered
  // line, or every assertion above is blind to the field this file is for.
  it('CONTROL: the rendering carries the auth scope', () => {
    const a = render({ method: 'GET', matcher: "exact('/x')", handler: 'h', auth: 'admin' });
    const b = render({ method: 'GET', matcher: "exact('/x')", handler: 'h', auth: 'agentOrAdmin' });
    expect(a).not.toBe(b);
    expect(b).toContain('agentOrAdmin');
  });
});
