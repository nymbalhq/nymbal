# Contributing to Nymbal

Thank you for helping. Bug fixes, adapters, docs and tests are all welcome. For a large change, open an issue first so
we can agree on the shape before you build it.

## Set up

You need Node.js (the version in `.node-version`), pnpm (the version `packageManager` names in `package.json`; Corepack
picks it up) and, for the integration tests, Docker.

```bash
pnpm install
pnpm build
```

`pnpm dev` runs the CLI's own build in watch mode. To try a change in a store, scaffold one with
`npx create-nymbal-app` outside this repository, or run `node packages/cli/bin/nymbal.mjs dev --api-only` here.

## Checks

| Command                                                            | What                                                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                                        | The unit tests (Vitest), every project but the `integration-*` ones                                                         |
| `pnpm vitest run --project <name>`                                 | One project of `vitest.config.ts`; the `integration-*` ones need `docker compose up -d --wait`                              |
| `pnpm --filter @nymbalhq/e2e exec playwright test --project astro` | The end-to-end journeys against the Astro storefront (also `nextjs`, `admin`)                                               |
| `pnpm lint` · `pnpm typecheck` · `pnpm format`                     | ESLint, TypeScript, Prettier                                                                                                |
| `pnpm gate`                                                        | What a change must pass before it merges: lint, build, typecheck, the tests the change reaches, and the test-quality census |

Every change comes with tests that fail without it. A test asserts what a user or caller gets back (a status, a row, a
total), not that a function was called or an element exists.

## Changesets

A change to a published package (anything under `packages/` or `apps/admin` that is not a test) needs a changeset:

```bash
pnpm changeset
```

Pick the packages and the bump, and write one to three lines a store developer needs: what changed for them, and what
they must do, if anything.

## Adapters

To add a provider for a slot (payments, email, search and the rest), follow the
[guide to adding an adapter](packages/adapters/README.md): `pnpm new-adapter <slot> <provider>` scaffolds a working
copy to start from.

## Docs

The guides are Markdown in `apps/docs/src/content/docs`. `pnpm docs:dev` serves the site and `pnpm docs:build`
builds it. The CLI reference page is generated: after changing a command or a flag, run
`pnpm --filter @nymbalhq/docs cli-reference` and commit the page.

## Pull requests

Keep a pull request to one change. Commit messages read `<type>(<area>): <what>`, such as
`fix(cart): keep the line limit after sign-in`. By contributing you agree that your contribution is licensed under the
[MIT licence](LICENSE).
