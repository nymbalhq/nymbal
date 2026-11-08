---
title: CLI reference
description: Every nymbal command and subcommand, with its arguments and their defaults.
---

<!-- Generated from the CLI by `pnpm --filter @nymbalhq/docs cli-reference`. Do not edit by hand. -->

Run a command in your project with `npx nymbal <command>` (or your package manager’s equivalent). Every command
takes `--help`, and `nymbal --version` prints the installed version.

## `nymbal dev`

Start the API server and the configured storefront template with HMR

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--seed` | boolean | Run seed before starting (default: true if empty) | `true` |
| `--api-only` | boolean | Start only the API server (skip template dev server) | `false` |
| `--port` | string | Port for the API server (default: the config's http.port) |  |
| `--storefront-port` | string | Port for the storefront dev server (default: 4321 Astro / 3000 Next.js). If busy, the next free port is used. Also settable via NYMBAL_STOREFRONT_PORT. |  |
| `--verbose` | boolean | Log at debug (LOG_LEVEL, when set, wins) | `false` |

## `nymbal build`

Production build of the configured template

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--image` | boolean | Build a container image of the store (writes a Dockerfile when absent) | `false` |
| `--tag` | string | The image name (default: &lt;package name&gt;:latest) |  |

## `nymbal start`

Run the built store in production: the API, the admin and the storefront on one port

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--migrate` | boolean | Apply pending migrations first (a single host; a deploy runs `nymbal migrate`) | `false` |
| `--port` | string | The public port (default: PORT, else 3001) |  |

## `nymbal deploy`

Deploy the store to Fly or Railway, or write a web server config for your own server

Subcommands: `nymbal deploy fly`, `nymbal deploy railway`, `nymbal deploy nginx`, `nymbal deploy apache`, `nymbal deploy caddy`.

## `nymbal deploy fly`

Write fly.toml and deploy with flyctl

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--dry-run` | boolean | Write the recipe and print the steps; run nothing | `false` |

## `nymbal deploy railway`

Write railway.json and deploy with railway

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--dry-run` | boolean | Write the recipe and print the steps; run nothing | `false` |

## `nymbal deploy nginx`

Write deploy/nginx.conf: nginx with TLS in front of the API on this machine

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--real-ip-from` | string | A CDN's address ranges, comma-separated, trusted to name the client |  |
| `--real-ip-header` | string | The header that CDN names the client in, such as CF-Connecting-IP |  |

## `nymbal deploy apache`

Write deploy/apache.conf: apache with TLS in front of the API on this machine

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--real-ip-from` | string | A CDN's address ranges, comma-separated, trusted to name the client |  |
| `--real-ip-header` | string | The header that CDN names the client in, such as CF-Connecting-IP |  |

## `nymbal deploy caddy`

Write deploy/Caddyfile: caddy with TLS in front of the API on this machine

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--real-ip-from` | string | A CDN's address ranges, comma-separated, trusted to name the client |  |
| `--real-ip-header` | string | The header that CDN names the client in, such as CF-Connecting-IP |  |

## `nymbal migrate`

Run database migrations (Drizzle)

## `nymbal seed`

Re-seed demo content (products, categories)

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--local-images` | boolean | Write the product images through the store's media slot instead of linking a placeholder host | `false` |
| `--media-root` | string | Where local-fs media is written (default: public/imported-media) |  |

## `nymbal import`

Migrate content from WooCommerce (or other sources) into Nymbal

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--source` | string | Import source (woocommerce) |  |
| `--url` | string | Store URL (e.g. https://mystore.com) |  |
| `--key` | string | WooCommerce Consumer Key (or set WOOCOMMERCE_KEY env var) |  |
| `--secret` | string | WooCommerce Consumer Secret (or set WOOCOMMERCE_SECRET env var) |  |
| `--entities` | string | Comma-separated list: products,customers,orders,reviews (default: products,customers,orders) |  |
| `--ai` | boolean | Enable AI enrichment (default: true) | `true` |
| `--gdpr` | boolean | Anonymise customer PII (default: true) | `true` |
| `--fresh` | boolean | Ignore previous progress and re-import | `false` |
| `--concurrency` | string | Parallel import workers (default: 4) |  |
| `--untracked-stock` | string | Stock for products WooCommerce does not count, when in stock or on backorder (default: 1000) |  |
| `--dry-run` | boolean | Read the source and write nymbal-import-plan.json and .md (counts, collisions, unmapped fields, estimate); import nothing | `false` |
| `--rollback` | boolean | Remove every record the imports in this project created, from .nymbal-migration.json; needs no source or credentials | `false` |
| `--yes` | boolean | With --rollback: remove without asking | `false` |
| `--since` | string | Bring over what changed in WooCommerce since the last finished import (last), a date (2026-10-01, UTC) or a date-time with a zone |  |

## `nymbal preview`

Import a WooCommerce store into a throwaway store and serve it on your storefront, with a report and a redirect map; your own store is not touched

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--source` | string | Import source (woocommerce) |  |
| `--url` | string | Store URL (e.g. https://mystore.com) |  |
| `--key` | string | WooCommerce Consumer Key (or set WOOCOMMERCE_KEY) |  |
| `--secret` | string | WooCommerce Consumer Secret (or set WOOCOMMERCE_SECRET) |  |
| `--entities` | string | Comma-separated list: categories,products,customers,orders,reviews (default: categories,products,customers,orders) |  |
| `--gdpr` | boolean | Anonymise customer PII (default: true) | `true` |
| `--ai` | boolean | Enrich products with the project's ai provider (default: false) | `false` |
| `--concurrency` | string | Parallel import workers (default: 4) |  |
| `--untracked-stock` | string | Stock for products WooCommerce does not count, when in stock or on backorder (default: 1000) |  |
| `--keep` | boolean | Keep the preview directory (its store, media and import state) when the preview stops | `false` |
| `--api-only` | boolean | Serve only the API (no storefront) | `false` |
| `--port` | string | Port for the preview's API (default: the config's http.port, or the next free one) |  |
| `--storefront-port` | string | Port for the storefront (default: 4321 Astro / 3000 Next.js, or the next free one) |  |
| `--lighthouse` | boolean | Build the storefront for production and compare Lighthouse scores of the store's home, a product and a category with the preview's (needs lighthouse@^12 and Chrome) | `false` |
| `--lighthouse-runs` | string | Lighthouse runs per page, 1 to 9; the report shows the median (default: 3) |  |
| `--lighthouse-timeout` | string | Seconds one Lighthouse run may take, 10 to 600 (default: 120) |  |

## `nymbal config:validate`

Validate nymbal.config.ts

## `nymbal add`

Add a provider by slot, a third-party adapter by package, or a service by recipe (nymbal add lists them)

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `<name>` | positional | &lt;recipe&gt;, &lt;slot&gt; or &lt;package&gt; |  |
| `<provider>` | positional | after &lt;slot&gt;: the slot's provider |  |
| `--install` | boolean | Install the packages (--no-install: they must already be installed) | `true` |
| `--force` | boolean | Overwrite a config value the addition conflicts with | `false` |
| `--dry-run` | boolean | Print the config change, the .env.example lines and the install line, and write nothing | `false` |

## `nymbal doctor`

Check the project without changing it: config, packages, command store, migrations, slots and primitives

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--json` | boolean | Print the checks as one JSON document | `false` |
| `--timeout` | string | How long each check may take, in ms (default 5000) |  |

## `nymbal security:plan`

Show what security:apply would change on the Cloudflare zone

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--json` | boolean | Print the result as one JSON document | `false` |

## `nymbal security:apply`

Write the store's security rules to the Cloudflare zone, leaving the zone's own rules; the first creates NYMBAL_ORIGIN_SECRET

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--adopt-origin-secret` | boolean | Put the secret the zone already sends into .env, writing nothing to the zone (another machine set the lock) | `false` |
| `--new-origin-secret` | boolean | Replace the origin secret on the zone and in .env (a compromised one); the host refuses requests until it has the new one | `false` |

## `nymbal security:drift`

Report where the zone's Nymbal rules differ from the config (exit 1 on drift)

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--json` | boolean | Print the result as one JSON document | `false` |

## `nymbal security:inspect`

List the Nymbal rules live on the Cloudflare zone

## `nymbal secrets`

Manage the values saved in the admin's Settings

Subcommands: `nymbal secrets rotate`, `nymbal secrets clear`.

## `nymbal secrets rotate`

Re-encrypt every saved secret from NYMBAL_SECRETS_KEY_OLD to NYMBAL_SECRETS_KEY, all or none

## `nymbal secrets clear`

Delete saved settings (all, or one slot or path); needs no key

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--slot` | string | Only this slot |  |
| `--path` | string | Only this path |  |

## `nymbal events`

Read the event log without changing it

Subcommands: `nymbal events query`, `nymbal events tail`.

## `nymbal events query`

Print one correlation id’s events, in seq order

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--correlation` | string | The correlation id (required) |  |
| `--type` | string | Only types matching this glob; * matches anything (order.*) |  |
| `--since` | string | Only events appended at or after this ISO time |  |
| `--until` | string | Only events appended before this ISO time |  |
| `--limit` | string | At most this many events (default 1000) |  |
| `--json` | boolean | One envelope per line, with seq and deliveredAt | `false` |
| `--payload` | boolean | Include each event’s payload (it may hold customer data) | `false` |

## `nymbal events tail`

Print events as they are appended, until interrupted. Exact for serially committed events; on Postgres an event whose lower seq commits after a higher one has been printed is skipped.

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--type` | string | Only types matching this glob; * matches anything (order.*) |  |
| `--from` | string | Print events above this seq (default: the current maximum) |  |
| `--json` | boolean | One envelope per line, with seq and deliveredAt | `false` |
| `--payload` | boolean | Include each event’s payload (it may hold customer data) | `false` |

## `nymbal audit`

Read the audit trail

Subcommands: `nymbal audit export`.

## `nymbal audit export`

Print audit entries as NDJSON, oldest first: ids only, no event payloads or customer data

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--since` | string | Only entries at or after this ISO time |  |
| `--until` | string | Only entries before this ISO time |  |
| `--correlation` | string | Only the entries of this correlation id |  |
| `--out` | string | Write the lines to this file instead of stdout |  |

## `nymbal replay`

Rebuild a derived read model from the command store and swap it in: catalogue, orders, customers, search, recently-viewed or all

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--to` | string | The read model: catalogue, orders, customers, search, recently-viewed or all |  |
| `--dry-run` | boolean | Rebuild into memory and count what differs from the live read model; exits 1 if anything does | `false` |

## `nymbal mcp`

Serve the store's agent tools on stdio, for an MCP host to launch (`nymbal mcp tools` lists them)

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `<action>` | positional | `tools`: print the tool names the store lists for this credential |  |
| `--url` | string | The store's MCP endpoint (NYMBAL_MCP_URL; default http://localhost:&lt;http.port&gt;/api/mcp) |  |
| `--token` | string | A bearer the store signed (NYMBAL_MCP_TOKEN); or set NYMBAL_MCP_EMAIL and NYMBAL_MCP_PASSWORD |  |
| `--json` | boolean | With `tools`: the names as one JSON array |  |

## `nymbal eval`

Score a store feature against its golden questions

Subcommands: `nymbal eval assistant`.

## `nymbal eval assistant`

Ask the store assistant the 27 golden questions with the project's AI provider, on a throwaway store

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--only` | string | Run only these question ids, comma-separated |  |
| `--threshold` | string | How many must pass for exit 0 (default 24) |  |
| `--runs` | string | Ask the set this many times, each on a fresh store, and judge each question by majority (default 1) |  |
| `--json` | boolean | Print the tally and every run’s report as JSON | `false` |
| `--verbose` | boolean | Print each call, its arguments and outcome, and each answer | `false` |
| `--stamp` | string | Write the eval stamp to this file when the run passes: the hash of the prompt and tools, the provider, model and tally. Anthropic or OpenAI’s own API only, every question, the default threshold or above |  |

## `nymbal test`

Run unit + integration tests (vitest)

## `nymbal test:e2e`

Run Playwright E2E against the configured template

## `nymbal test:visual`

Run visual regression tests (Playwright toHaveScreenshot)

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--update-baselines` | boolean | Regenerate screenshot baselines | `false` |

## `nymbal test:contracts`

Run adapter contract tests, or certify an adapter package

| Argument | Type | Description | Default |
| --- | --- | --- | --- |
| `--adapter` | string | Run only contracts for a specific adapter (e.g. payments, email) |  |
| `--package` | string | Certify an installed adapter package against the published suite for its kind |  |
| `--slot` | string | With --package: the commerce slot whose config builds it |  |

## `nymbal test:performance`

Run Lighthouse CI against the configured template

## `nymbal test:all`

Run unit, contract, e2e, visual, and performance tests
