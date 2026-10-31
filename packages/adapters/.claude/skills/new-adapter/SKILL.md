---
name: new-adapter
description: Add a Nymbal adapter (a payments, email, search, security or shipping provider) to this repository, or move a published third-party adapter in, with pnpm new-adapter, then make the copy call the real provider and pass its contract suite.
---

# Add an adapter to Nymbal

Use this when someone wants a new provider for a Nymbal slot in this repository, or wants to bring their published
adapter here. The guide is `packages/adapters/README.md`; read it first, it is short.

## 1. Pick the slot, the provider name and the starting point

- The provider name is lower-case letters, digits and hyphens (`royal-mail`). The package is
  `@nymbalhq/<slot>-<provider>`.
- email, payments, search, security and shipping each have a working adapter to copy; the guide's table lists them.
  Choose the one closest to the new provider (for email: an HTTP API with webhooks is mailgun, resend or ses; a plain
  relay is smtp) and pass it as `--from-provider` when it is not the default.
- ai, document-store, event-bus and media have no starting point, and reviews, analytics and tax only built-ins. Do
  not copy one by hand: a primitive is kernel work, so stop and say so. A published adapter for any slot moves in with
  `--from`.

## 2. Scaffold

```sh
pnpm new-adapter <slot> <provider> --dry-run
pnpm new-adapter <slot> <provider>
pnpm install
```

For a published adapter, `pnpm new-adapter <slot> <provider> --from <dir>`. If the command refuses, its one line says
why; do not work around it (it never writes over an existing adapter).

## 3. Prove the copy before changing it

```sh
pnpm vitest run --project adapters packages/adapters/<slot>/<provider>/
pnpm vitest run --project contracts-native tests/contracts/<provider>-*.test.ts
```

Both pass on a fresh copy. If one does not, report it rather than editing the source adapter.

## 4. Make it the new provider

- Replace the provider calls under the package's `src/` with the new provider's API, keeping the exports `slot`,
  `provider` and `createAdapter`.
- Replace the fake the tests run against (in the package's `src/tests/`, or `tests/support/<provider>.ts`) with one
  that answers as the new provider does, from its API documentation. The contract runner must keep passing against it.
- Rewrite the package's `README.md`, its `description`, and the changeset's line under `.changeset/`.
- An SDK the provider needs goes in `peerDependencies` and `devDependencies`, and as `sdk` in the provider's entry in
  `packages/config/src/adapter-names.ts`.
- Never put live keys in tests or fixtures.

## 5. Check

```sh
pnpm gate
```

Fix what it reports, then open the pull request: what the provider is, which slot, and how its fake was checked
against the provider's documentation.
