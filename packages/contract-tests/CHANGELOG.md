# @nymbalhq/contract-tests

## 1.2.0

### Minor Changes

- 1653d3f: A third party can certify their own adapter: `npm install --save-dev @nymbalhq/contract-tests vitest`, name the
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

- 7a4e472: Every derived read model can be rebuilt from the command store's tables, completely and without readers seeing it
  half-built, and a fresh process serves exactly what a long-running one serves.
  - **`nymbal replay --to <catalogue|orders|customers|search|all>`.** Rebuilds the read model from the tables, swaps it
    in, then re-applies the events delivered while it was read. It prints each model with the documents in each
    collection, and exits 2 when a rebuilder fails (nothing is swapped) or a catch-up event fails (the model is swapped,
    and the event's seq is printed). `--dry-run` rebuilds into memory, prints what would be added, changed and removed,
    writes nothing, and exits 1 if anything differs. On an `in-memory` document store the document models live in the
    server's process, so only `--to search` runs: use `redis` or `postgres-jsonb` for a shared read model.
  - **Boot rebuilds.** `createApp` rebuilds every read model before it serves, in place of the old warm-up, which
    replayed only created and placed events (statuses, stock and updates were lost on a restart). `warmDocumentStore` is
    removed; `rebuild`, `diffReadModel`, `READ_MODELS` and `openReadModels` are exported. Seed calls the same rebuild.
  - **The live projections match a rebuild.** They build every document from the rows at handle time, through the same
    builders a rebuild uses: a recategorised product leaves no stale `products-by-category` entry, a stock change and a
    category rename or delete re-project the products concerned, a paid or refunded order updates its customer's
    profile, and a pending order's document carries its payment intent.
  - **Events.** `OrderService.updateStatus` publishes `order.status_changed.v1` (`orderId`, `from`, `to`), and a
    checkout publishes `payment.intent_created.v1` (`paymentId`, `orderId`) when it stores the intent on the order.
  - **Adapters.** `DocumentStoreAdapter` gains `replaceCollection(collection, entries)`: readers see the old contents
    or the new, and a source that throws leaves the old. The Redis store stages a hash and `RENAME`s it with its expiry
    index; Postgres JSONB replaces in one transaction. `SearchAdapter` gains an optional `replaceAll(documents)`, which
    the native index implements. The document store contract suite in `@nymbalhq/contract-tests` has
    `replaceCollection` cases, so a third-party store must implement it.
  - **Migration `0010`** indexes `events (dead_at, delivered_at, seq)` for the catch-up read. Run `nymbal migrate`.

### Patch Changes

- Updated dependencies [45b8128]
- Updated dependencies [b836370]
- Updated dependencies [3591951]
- Updated dependencies [7a4e472]
- Updated dependencies [0fe6563]
  - @nymbalhq/types@1.2.0
