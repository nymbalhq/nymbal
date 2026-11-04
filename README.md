# Nymbal

An open source commerce platform. Your store is a project of your own, its storefront pages are files you edit, and
the engine (catalogue, carts, checkout, orders, customers, search, the admin, an API built on commands and events)
arrives as versioned npm packages. Agents are built in: the store serves its tools over MCP and the Universal Commerce
Protocol, and an agent's admin writes wait for your approval.

## Quickstart

```bash
npx create-nymbal-app my-store
cd my-store
npx nymbal dev
```

`create-nymbal-app` asks for a name and a template (Astro or Next.js), installs with the package manager that ran it,
and seeds demo products; `--no-install` writes the files only. `nymbal dev` serves the storefront (Astro on port
4321, Next.js on 3000), the API on 3001 and the admin at `http://localhost:3001/admin/`, signed in with the email and
password the scaffold printed and saved in `.env`. It runs on SQLite with stub payments: no Docker, no accounts, no
keys.

Requires Node.js 22 or later.

## Deploy and connect an agent

The [quickstart guide](apps/docs/src/content/docs/quickstart.md) takes a new store to its production image running
with Postgres and Stripe, and an AI agent calling it over MCP, in under fifteen minutes. The same image runs on Fly or
Railway: see [Deploying](apps/docs/src/content/docs/deploying.md).

## Documentation

The guides live in [`apps/docs`](apps/docs/src/content/docs/index.md): [configuration](apps/docs/src/content/docs/configuration.md),
[adapters](apps/docs/src/content/docs/adapters.md), [agents](apps/docs/src/content/docs/agents.md),
[importing from WooCommerce](apps/docs/src/content/docs/importing.md), [upgrading](apps/docs/src/content/docs/upgrading.md)
and the [CLI reference](apps/docs/src/content/docs/reference/cli.md). `pnpm docs:dev` serves them as a site.

## Your store and Nymbal updates

Everything `create-nymbal-app` writes into your project is yours: `nymbal.config.ts` and the `src/` pages, layouts
and components. Edit them, add routes, delete what you don't need. The engine is Nymbal's, installed from npm, and
your files and its files never share a file, so an update never merges. [OVERRIDES.md](OVERRIDES.md) has the details.

## Upgrading

Nymbal's runtime packages are released together at the version of `@nymbalhq/stack`, and a store pins each of them
to exactly that version (`dependencies`, `overrides` and `pnpm.overrides` in its `package.json`). To upgrade, replace
that version with the new one everywhere it appears in `package.json`, then install and migrate:

```bash
npm view @nymbalhq/stack version
npm install
npx nymbal migrate
```

[Upgrading](apps/docs/src/content/docs/upgrading.md) has the steps.

## Packages

| Directory                  | Package                       | What                                                                      |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `packages/types/`          | `@nymbalhq/types`             | The adapter contracts and shared types                                    |
| `packages/config/`         | `@nymbalhq/config`            | `defineConfig()`, the config schema, `env()`                              |
| `packages/platform/`       | `@nymbalhq/platform`          | The kernel: commands, events, read models, services, routes               |
| `packages/http/`           | `@nymbalhq/http`              | The HTTP server, security middleware, and the MCP and UCP endpoints       |
| `packages/sdk/`            | `@nymbalhq/sdk`               | Framework-agnostic client stores for a storefront                         |
| `packages/web-components/` | `@nymbalhq/web-components`    | The storefront's interactive elements                                     |
| `packages/react/`          | `@nymbalhq/react`             | React hooks and wrappers for the web components                           |
| `packages/stack/`          | `@nymbalhq/stack`             | The runtime packages at one tested version                                |
| `packages/cli/`            | `nymbal`                      | The CLI: dev, build, start, deploy, add, doctor, import, mcp and the rest |
| `packages/create-app/`     | `create-nymbal-app`           | Scaffolds a store                                                         |
| `packages/importers/`      | `@nymbalhq/importers`         | The WooCommerce import engine                                             |
| `packages/contract-tests/` | `@nymbalhq/contract-tests`    | The contract suites an adapter is certified against                       |
| `packages/adapters/`       | `@nymbalhq/<slot>-<provider>` | First-party adapters: payments, email, search, storage, shipping and more |
| `apps/admin/`              | `@nymbalhq/admin`             | The admin dashboard, served at `/admin/`                                  |

The storefront templates are `templates/astro/` and `templates/nextjs/`; `create-nymbal-app` copies one into a new
store. The docs site is `apps/docs/`.

## Adapters

Every adapter that can fill a slot, first-party or third-party, is listed in the
[adapter registry](./registry/README.md), with its tier and nightly status. In a store, `npx nymbal add stripe` (or
`postgres`, `redis`, `s3`, `algolia`, `cloudflare`, or `<slot> <provider>`) installs one and edits the config.

To add one to this repository, `pnpm new-adapter <slot> <provider>` scaffolds it from a working adapter of the same
slot; the [guide](./packages/adapters/README.md) covers the rest. Its Claude Code skill, `new-adapter`, loads when you
start the agent in `packages/adapters`, run `/add-dir packages/adapters`, or have it read `packages/adapters/README.md`.

## Migrating from WooCommerce

```bash
nymbal import --source woocommerce --url https://mystore.com --key <ck_…> --secret <cs_…> --dry-run
nymbal import --source woocommerce --url https://mystore.com --key <ck_…> --secret <cs_…>
```

The dry run writes a plan (counts, collisions, unmapped fields) and imports nothing. The import maps products,
categories, customers and orders (reviews with `--entities`), anonymises personal data unless `--no-gdpr`, fills
missing fields through the `AiAdapter` contract when an AI provider is configured, resumes after an interruption, and
writes a report. `--since last` brings over what changed since the last import, and `--rollback` removes what the
imports created. See [Importing](apps/docs/src/content/docs/importing.md).

## Agents

- **MCP**: the store serves its tools at `POST /api/mcp`; `nymbal mcp` connects an MCP host to it on stdio, signed in
  as a user of the store.
- **Proposals**: an agent's admin write waits in the admin's Inbox until someone approves it, unless the config says
  otherwise (`agents.mcp.writes`, `agents.autoApprove`).
- **UCP**: a Universal Commerce Protocol profile at `/.well-known/ucp` and its tools at `POST /api/ucp/mcp`.
- **Crawlers**: `robots.txt`, `llms.txt` and a product feed for AI crawlers.

See [Agents](apps/docs/src/content/docs/agents.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): setting up the repository, the checks a change passes, and changesets.

## Getting help

- A bug or a question: [open an issue](https://github.com/nymbalhq/nymbal/issues/new/choose).
- A vulnerability: report it privately, as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
