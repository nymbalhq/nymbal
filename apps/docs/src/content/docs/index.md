---
title: Introduction
description: What Nymbal is, what you get in a new store, and where to go next.
---

Nymbal is an open source commerce platform. A store is a project of your own: its storefront pages are files you edit,
and the engine behind them (catalogue, carts, checkout, orders, customers, search, the admin) arrives as versioned npm
packages. Taking a Nymbal update is a dependency bump, never a merge.

## What a new store has

- **A storefront** in Astro (fast pages, little JavaScript) or Next.js, with every page in your project's `src/`.
- **An admin** at `/admin/`: products, orders, customers, settings, and an inbox for what agents ask to change.
- **An API** behind both, built on commands and events: every change is a recorded command, and the read models the
  pages use are rebuilt from them.
- **Adapters** for each part that talks to the outside world: payments, email, search, media, shipping, tax, AI.
  Locally everything runs in the box (SQLite, an in-process event bus, stub payments); for production you add Postgres,
  Stripe and the rest with `nymbal add`.
- **Agents built in**: the store serves its tools over MCP, publishes a Universal Commerce Protocol profile, and keeps
  an agent's admin writes as proposals until you approve them.

## Where next

- [Quickstart](quickstart/): from nothing to the store in production with an agent connected.
- [Configuration](configuration/): `nymbal.config.ts`, `.env`, and checking both.
- [Adapters](adapters/), [Agents](agents/), [Deploying](deploying/), [Importing from WooCommerce](importing/),
  [Upgrading](upgrading/).
- [CLI reference](reference/cli/): every `nymbal` command.
- [Getting help](help/).
