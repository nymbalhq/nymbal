# Adapter registry

`adapters.json` lists every adapter that can fill a Nymbal slot (payments, email, search, document store and so on),
with a tier for each. Each night the registry installs every listed third-party adapter into a fresh project,
certifies it with `nymbal test:contracts --package`, and builds a status page with a badge per adapter.

## Tiers

- **first-party**: in this repository, published as `@nymbalhq/<slot>-<provider>` and released with Nymbal. Their
  contract suites run on every change, so the page says "tested in CI" for each one whose kind has a suite.
  `@nymbalhq/ai-anthropic` and `@nymbalhq/security-cloudflare` have no suite yet and carry no such claim.
- **verified**: a third-party adapter whose listing a Nymbal maintainer has reviewed and which has passed for 30
  days. It is promoted by pull request.
- **community**: any third-party adapter listed by pull request, with a named maintainer.

## Contribute it to Nymbal (preferred)

If you have built an adapter, we would rather have it here than listed from elsewhere. A first-party adapter runs its
slot's contract suite on every change, so when a contract changes the adapter is updated in the same pull request. It
is released and versioned with Nymbal, and the maintainers keep it working.

1. Put it at `packages/adapters/<slot>/<provider>/`, named `@nymbalhq/<slot>-<provider>`. The nearest adapter of the
   same slot (for example `packages/adapters/email/resend/`) is a good starting point to copy.
2. Run its slot's contract suite against it with a test under `tests/contracts/`, as the other adapters do (see
   `tests/contracts/algolia-search.test.ts`), and make sure `pnpm test` passes.
3. Open a pull request. We will help with the rest.

## Getting listed

If your adapter stays in its own repository, list it instead. Open a pull request that adds it to `adapters.json`:

```json
{
  "package": "@acme/nymbal-search",
  "slot": "search",
  "provider": "acme",
  "tier": "community",
  "maintainer": "https://github.com/acme",
  "repository": "https://github.com/acme/nymbal-search",
  "source": { "npm": "^1.0.0" }
}
```

- `slot` is spelled as in package names: `document-store`, `event-bus`.
- `maintainer` and `repository` are `https://` links. `maintainer` is required.
- `source.npm` is the semver range the nightly installs.
- Packages under `@nymbalhq/` are first-party only.
- Your package should pass `nymbal test:contracts --package <your package>` before you open the pull request. Export
  `contractOptions.options` for the options it is certified with.

## Statuses

- **passing**: the last night's certification passed.
- **failing**: the last night failed. A package turns red on its first failing night.
- **suspended**: failing for 7 days in a row. The page and the badge say so.
- **no suite**: the adapter's kind has no contract suite yet.

One passing night clears failing and suspended. An adapter suspended for 30 days is removed by pull request.

Install scripts never run. Each adapter is installed and certified in its own container, with no network while it
is certified and a time limit on each step.

## Changing hands

- A maintainer hands an adapter on by a pull request that both maintainers approve. If a maintainer does not answer
  for 30 days, Nymbal may reassign the listing.
- When Nymbal stops maintaining a first-party adapter, it says so in a release. The adapter moves to `community`
  under its new maintainer's package, and the `@nymbalhq` package is deprecated with a pointer to it.
