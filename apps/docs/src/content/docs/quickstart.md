---
title: Quickstart
description: From nothing to a store running in production with an agent connected over MCP, in under fifteen minutes.
---

This page takes you from an empty directory to your store's production image running in a container, with an AI
agent calling it over MCP. It needs Node.js 22 or later, Docker, and port 8080 free. The same steps run in CI on fresh
machines, and finish well inside fifteen minutes.

## 1. Create the store

Pick a template: `astro` (fastest pages) or `nextjs`.

```sh
npx create-nymbal-app my-store --template <astro|nextjs> --yes
cd my-store
```

This installs the packages and seeds demo products. `.env` now holds your admin's email and password, and the keys
the store signs and encrypts with. To work on the store locally, `npx nymbal dev` serves it with the admin at
`http://localhost:3001/admin/`. The rest of this page puts it into production.

## 2. Deploy

Production runs on Postgres, and takes payments through Stripe (the built-in stub payments are for development, and
production refuses them). Start a Postgres container on a network of its own:

```sh
docker network create my-store
docker run -d --name my-store-db --network my-store -e POSTGRES_PASSWORD=nymbal postgres:16-alpine
```

Add Postgres and Stripe to your store's config:

```sh
npx nymbal add postgres
npx nymbal add stripe
```

Write the production environment. It starts from `.env` and adds the database, the store's public address and your
Stripe test-mode keys, from your Stripe dashboard under Developers, API keys. The webhook secret can be any
placeholder until you add a webhook endpoint in Stripe; nothing on this page takes a payment.

```sh
cp .env .env.production
cat >> .env.production <<'EOF'
DATABASE_URL=postgres://postgres:nymbal@my-store-db:5432/postgres
NYMBAL_PUBLIC_URL=http://localhost:8080
NYMBAL_STOREFRONT_URL=http://localhost:8080
STRIPE_SECRET_KEY=<sk_test_…>
STRIPE_WEBHOOK_SECRET=<whsec_…>
STRIPE_PUBLISHABLE_KEY=<pk_test_…>
EOF
```

Build the store's image. `nymbal build --image` writes a `Dockerfile` (and a `.dockerignore` that keeps `.env*` out
of the image) and runs `docker build`, tagging the image `my-store`:

```sh
npx nymbal build --image
```

Create the tables, seed the demo catalogue, and start the store on port 8080:

```sh
for _ in $(seq 60); do docker exec my-store-db pg_isready -U postgres && break; sleep 1; done
docker run --rm --network my-store --env-file .env.production my-store node node_modules/nymbal/bin/nymbal.mjs migrate
docker run --rm --network my-store --env-file .env.production my-store node node_modules/nymbal/bin/nymbal.mjs seed
docker run -d --name my-store --network my-store --env-file .env.production -p 8080:3001 my-store
```

The storefront is at `http://localhost:8080`, the admin at `http://localhost:8080/admin/`. `GET /ready` answers 200
once the store takes traffic. A hosting platform runs this same image: see [Deploying](../deploying/).

## 3. Connect an agent

The store serves its agent tools over MCP at `/api/mcp`. `nymbal mcp` connects an MCP host to it on stdio; list the
tools an anonymous agent sees:

```sh
NYMBAL_MCP_URL=http://localhost:8080/api/mcp npx nymbal mcp tools
```

To give an agent the admin's tools, add the store to your MCP host's config (Claude Desktop, Claude Code, or any host
that launches a stdio server), with the admin's email and password from `.env`:

```json
{
  "mcpServers": {
    "my-store": {
      "command": "npx",
      "args": ["-y", "nymbal", "mcp"],
      "env": {
        "NYMBAL_MCP_URL": "http://localhost:8080/api/mcp",
        "NYMBAL_MCP_EMAIL": "<NYMBAL_ADMIN_EMAIL from .env>",
        "NYMBAL_MCP_PASSWORD": "<NYMBAL_ADMIN_PASSWORD from .env>"
      }
    }
  }
}
```

Ask the agent to list your products, then to add one. Reads answer at once. A write waits in the admin's **Inbox**
(`http://localhost:8080/admin/inbox`) until you approve it: see [Agents](../agents/) for what changes that.

## Clean up

```sh
docker rm -f my-store my-store-db
docker network rm my-store
```
