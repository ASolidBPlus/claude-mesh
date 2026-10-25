The declaration library (`@dinfra/fleet-bridge/declare`, docs/declare.md there), vendored at
Dinfra/fleet-bridge `e39a018e9cb486a874863f5aba6d8895b2e96cef`. The `.ts` files are its
`src/declare/` byte for byte (the same bytes fleet-access vendors at that commit); `SHA256SUMS`
pins them and `server/__tests__/vendor-declare.test.ts` fails on any drift. It's vendored, not
installed, because fleet-bridge is a private repo: installing it would need a token in CI and in
the image build. To update it, copy `src/declare/*.ts` from the new commit, regenerate
`SHA256SUMS`, and change the commit above.

It imports `zod` 4, which `server/package.json` pins for it (R-393). Nothing else in the server
uses zod, so there is no second zod to isolate it from.
