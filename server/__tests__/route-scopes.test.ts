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

  // A route may accept several scopes (R-454); these checks see each one.
  const scopesOf = (r: (typeof ROUTES)[number]): string[] => (r.scope === undefined ? [] : typeof r.scope === 'string' ? [r.scope] : [...r.scope]);

  it('W-1514 M10: a :read scope is only ever on a GET, and plain mesh:agents is on no route', () => {
    for (const r of ROUTES) {
      for (const sc of scopesOf(r)) {
        if (sc.endsWith(':read')) expect({ route: routeLabel(r.method, r), method: r.method }).toEqual({ route: routeLabel(r.method, r), method: 'GET' });
        expect(sc).not.toBe('mesh:agents');
      }
    }
  });

  it('R-454: mesh:agents:bind is on PATCH /agents/:id only, after mesh:agents:write', () => {
    const withBind = ROUTES.filter(r => scopesOf(r).includes('mesh:agents:bind')).map(r => routeLabel(r.method, r));
    expect(withBind).toEqual(['PATCH /agents/:id']);
    expect(scopesOf(ROUTES.find(r => routeLabel(r.method, r) === 'PATCH /agents/:id')!)).toEqual(['mesh:agents:write', 'mesh:agents:bind']);
  });

  it('routes no admin access token reaches declare no scope', () => {
    for (const r of ROUTES.filter(r => r.auth === 'agentOrAdmin' || r.auth === 'handler')) {
      expect({ route: routeLabel(r.method, r), scope: r.scope }).toEqual({ route: routeLabel(r.method, r), scope: undefined });
    }
  });
});
