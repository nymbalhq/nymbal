# Adding an adapter to Nymbal

An adapter fills a slot (payments, email, search, shipping and so on) with a provider. You can publish one from your
own repository and list it in the [adapter registry](../../registry/README.md), but we would rather have it here: a
first-party adapter runs its slot's contract suite on every change, so when a contract changes the adapter changes in
the same pull request, and it is released with Nymbal.

Each adapter lives at `packages/adapters/<slot>/<provider>/` and is published as `@nymbalhq/<slot>-<provider>`, where
`<slot>` is spelled as in package names (`document-store`, `event-bus`).

## With Claude Code

This directory carries a Claude Code skill, `new-adapter`, that walks an agent through the steps below. Claude Code
loads a skill in a subdirectory only once it is working there: start the agent in `packages/adapters`, run
`/add-dir packages/adapters` in a session started at the root, or have the agent read `packages/adapters/README.md`
first. Then ask it to add your adapter, or run `/new-adapter`.

## 1. Scaffold it

```sh
pnpm new-adapter <slot> <provider>
```

The command copies a working adapter of the same slot, renamed to your provider, with its contract runner and its fake
provider, so the copy passes its tests before you change a line. It also lists the new package where the repository
lists adapters: `registry/adapters.json`, the catalogue in `packages/config/src/adapter-names.ts`, the root
`package.json` and `packages/platform/package.json` (the kernel links every adapter for its tests), and
`packages/create-app/scripts/sync-scaffold.mjs`. It writes a changeset under `.changeset/`. The new package starts at
version 0.0.0; its first release is 0.1.0. Add `--dry-run` to see what it would write.

| Slot     | Starts from (the default first) |
| -------- | ------------------------------- |
| email    | mailgun, resend, ses, smtp      |
| payments | stripe                          |
| search   | algolia                         |
| security | cloudflare                      |
| shipping | easypost                        |

Pick another starting point with `--from-provider`, for example `pnpm new-adapter email <provider> --from-provider smtp`
for a plain SMTP relay. The command refuses a provider the slot already has and a directory that already exists.

The other slots have no starting point. An ai adapter has no contract suite to prove a copy against, and a new document
store, event bus or media store is kernel work (the kernel pins its primitives, and their contract runs need Postgres,
Redis or MinIO): open an issue first. Reviews, analytics and tax have built-in providers only. For these, bring your
own package with `--from` (below).

Then install, and run what the copy brought:

```sh
pnpm install
pnpm vitest run --project adapters packages/adapters/<slot>/<provider>/
pnpm vitest run --project contracts-native tests/contracts/<provider>-*.test.ts
```

## 2. Make it yours

- Replace the provider calls in `src/`: the client, the adapter and its health check. Keep the exports (`slot`,
  `provider`, `createAdapter`) as they are; the kernel checks them on load.
- Replace the fake provider the tests run against. It is either in the package (`src/tests/`) or under
  `tests/support/`, as the copy shows. The contract runner under `tests/contracts/` runs the slot's suite against it.
- Rewrite the package's `README.md` and the `description` in its `package.json`. If the provider needs an SDK, add it
  to `peerDependencies` and `devDependencies` and give its name as `sdk` in the catalogue entry.
- Read the changeset the command wrote and make its line say what the adapter does.
- If the adapter delivers webhooks the kernel acts on, add a kernel integration test beside the others in
  `packages/platform/tests/integration/`. A store installs the adapter with `nymbal add <slot> <provider>`; it needs no
  recipe.

## 3. Check and open the pull request

```sh
pnpm gate
```

When it is green, open a pull request. We will help with the rest.

## Moving a published adapter in

If your adapter is already published and listed in the registry, move it in with:

```sh
pnpm new-adapter <slot> <provider> --from <dir>
```

`<dir>` is your package's directory. The command renames the package to `@nymbalhq/<slot>-<provider>` at version
0.0.0, gives its `package.json` the repository's fields (exports and types from `dist/`, `files`, `publishConfig`,
`repository`, `license`, the `@nymbalhq/types` peer, the build and typecheck scripts), adds `tsconfig.json` and
`tsup.config.ts` when it has none, and keeps your source as it is. It writes a contract runner under
`tests/contracts/` that runs the slot's suite with your package's exported `contractOptions`, as
`nymbal test:contracts --package <package>` does; point those options at a fake of your provider. Your registry
entry is replaced by the first-party one.

A moved package is not expected to pass unedited: move its entry to `src/index.ts`, make the build and the runner pass,
then check with `pnpm gate`. Once the first-party package is released, deprecate the old one with a pointer to it (see
[Changing hands](../../registry/README.md#changing-hands)).
