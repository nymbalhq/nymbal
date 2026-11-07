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

The assistant eval stamp records a passing run of the store assistant against Anthropic's or OpenAI's own API. A change
to the assistant's instructions or to the tools it is offered merges without one: the stamp is recorded once per
release, on the release candidate, and `pnpm release:check` holds a release until it matches. After `pnpm build`, run
it from the assistant store in `tests/e2e/fixtures/assistant` (its `ai` block is Anthropic's, with `baseUrl` read
from `NYMBAL_E2E_AI_BASE_URL`), giving the stamp's absolute path:

```sh
cd tests/e2e/fixtures/assistant
NYMBAL_E2E_AI_BASE_URL=https://api.anthropic.com ANTHROPIC_API_KEY=<your key> \
  node ../../../../packages/cli/bin/nymbal.mjs eval assistant --runs 5 \
  --stamp "$(git rev-parse --show-toplevel)/packages/platform/assistant-eval.json"
```

The stamp is written only when the run passes; commit it on the release candidate.

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
