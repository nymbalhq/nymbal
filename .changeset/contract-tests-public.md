---
'@nymbalhq/contract-tests': minor
'nymbal': minor
'@nymbalhq/config': minor
'@nymbalhq/platform': minor
'@nymbalhq/adapter-smtp': minor
'@nymbalhq/doc-store-redis': minor
'@nymbalhq/event-bus-redis-streams': minor
---

A third party can certify their own adapter: `npm install --save-dev @nymbalhq/contract-tests vitest`, name the
package on its slot (`commerce.search: { provider: 'custom', package: '@acme/nymbal-search', config: {...} }`) and run
`nymbal test:contracts --package @acme/nymbal-search`. It builds the adapter with the package's
`createAdapter(<the slot's config>)` and runs the published suite for its kind with the project's own vitest. It
prints `certified <pkg> (<kind>): N cases passed` and exits 0 only when every case passed, else
`not certified <pkg> (<kind>): F of N cases failed` and exits 1.

- `@nymbalhq/contract-tests` publishes with the group. Every `run<Kind>Contract(name, build, options?)` runs the
  same cases Nymbal's own adapters pass: the document store's reference-model property, the event bus's delivery
  contract and search's pagination, ranking, facet and hostile-input properties are part of it now; reviews gain a
  cursor-walk case and payments a refund idempotency case (and, with `signedWebhook`, a webhook parsed twice). Every
  suite checks that `healthCheck()` resolves `healthy` or `degraded` within 6 s, which a primitive must implement to
  certify. With `unreachable` (an adapter whose dependency is gone) it checks that `healthCheck()` reports `down` and
  one representative operation rejects, each within 6 s. `runMediaStorageContract` takes `{ fetchUrl }` as options.
  `contractSuites` maps each kind to its suite, and the search oracle (`searchTerms`, `matchesQuery`,
  `toSearchDocument`) is exported.
- A package may export `contractOptions: { options?, unreachable?, kind? }`: the options when no slot names it, the
  options of an unreachable adapter, and a primitive's kind (`documentStore`, `eventBus` or `media`). Both go to
  `createAdapter` and then to `initialize` when the adapter has one, as the slot's config does. A slot config holding
  a value JSON cannot carry (a function, a Date, a BigInt) is refused with one line. `--slot` picks the slot when
  several name the package. `--adapter` runs the monorepo's own contract files, as before.
- Every commerce slot block takes an optional `package`, an npm package name. The kernel does not read it.
- Native reviews page by cursor: `getProductReviews(productId, { limit, cursor })` returns a `nextCursor` until the
  last page, newest first. The native payments stub answers a refund repeated under one `idempotencyKey` with the
  first refund and refunds once. adapter-smtp's `healthCheck` reports `down` when the server cannot be reached
  (`degraded` stays for a server that refuses the login), within 5 s, and a send gives up after 4 s on a host that
  does not connect, greet or answer, where nodemailer waited up to two minutes.
- The Redis document store's client and the Redis Streams bus's command client no longer queue a command until the
  server returns: on a dead server it rejects within a few seconds, and the client keeps reconnecting, so commands
  succeed again once the server is back.
