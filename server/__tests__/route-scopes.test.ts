// R-406: every admin route declares the scope an admin access token needs to
// reach it. A route without one would be reachable by the static admin token
// only, and so stranded once MESH_ADMIN_STATIC_TOKEN=off. A new route added
// without a scope fails here instead of becoming static-only unnoticed.
import { describe, it, expect } from 'bun:test';
import { ROUTES } from '../http-admin.ts';
import { routeLabel } from '../admin-ctx.ts';

// Admin routes deliberately reached by the static admin token only. Empty: a
// route listed here can't be used at all once the static token is off.
const STATIC_ONLY_ALLOWED = new Set<string>([]);

describe('R-406 route scopes', () => {
  it('every admin route has a scope (or is on the explicit, empty, allow-list)', () => {
    const admin = ROUTES.filter(r => (r.auth ?? 'admin') === 'admin');
    expect(admin.length).toBeGreaterThan(20);
    const missing = admin.filter(r => r.scope === undefined).map(r => routeLabel(r.method, r)).filter(l => !STATIC_ONLY_ALLOWED.has(l));
    expect(missing).toEqual([]);
  });

  it('routes no admin access token reaches declare no scope', () => {
    for (const r of ROUTES.filter(r => r.auth === 'agentOrAdmin' || r.auth === 'handler')) {
      expect({ route: routeLabel(r.method, r), scope: r.scope }).toEqual({ route: routeLabel(r.method, r), scope: undefined });
    }
  });
});
