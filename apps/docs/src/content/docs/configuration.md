---
title: Configuration
description: nymbal.config.ts, the .env file beside it, and how to check both.
---

A store has one configuration file, `nymbal.config.ts`, which the CLI, the API and the storefront all read. It is code:
it is built into your production image, so values that differ between machines (keys, URLs, passwords) come from the
environment through `env()`.

```ts
import { defineConfig, env } from '@nymbalhq/config'

export default defineConfig({
  store: {
    name: 'My Store',
    currency: 'GBP',
    locale: 'en-GB',
    timezone: 'Europe/London',
    url: env('NYMBAL_STOREFRONT_URL', 'http://localhost:4321'),
  },
  template: 'astro',
  infrastructure: {
    commandStore: 'sqlite',
    documentStore: { provider: 'in-memory' },
    eventBus: { provider: 'in-process' },
  },
  commerce: { payments: { provider: 'native' } /* … */ },
  http: { adapter: 'fastify', port: 3001 },
  // security, deployment, features, events, agents
})
```

## The sections

| Section                            | What it sets                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `store`                            | Name, currency, locale, time zone, and the storefront's public URL (order emails link to it).                                  |
| `template`                         | `astro` or `nextjs`: which storefront `nymbal dev`, `build` and `start` run.                                                   |
| `infrastructure`                   | Where commands and events are kept (`sqlite` or `postgres`), the read-model store, the event bus, media storage.               |
| `commerce`                         | One provider per slot: payments, email, reviews, search, analytics, shipping, tax, AI.                                         |
| `security`                         | Rate limits, bot protection, security headers, CSRF, sign-in token settings.                                                   |
| `http`                             | The API's port, CORS origins, the proxies in front (`trustedProxies`) and a client-address header (`clientIpHeader`).          |
| `agents`                           | MCP and UCP, whether an agent's admin writes apply or wait as proposals, and what crawlers may read. See [Agents](../agents/). |
| `events`, `deployment`, `features` | Event retention and archiving, the deployment strategy, optional features.                                                     |

`nymbal add` edits this file for you: `npx nymbal add postgres` sets the command store, `npx nymbal add stripe`
the payments provider, and each lists the variables it needs in `.env.example`. See [Adapters](../adapters/).

## `.env`

`create-nymbal-app` writes `.env` with the first admin's email and password, `NYMBAL_SECRETS_KEY` (encrypts the keys
you save in the admin's Settings) and `NYMBAL_JWT_SECRET` (signs sign-in tokens). Keep it out of version control, and
deploy the last two with your other secrets: losing the first loses the saved keys, and changing the second signs
everyone out. `nymbal dev` loads `.env`; in production the environment comes from your host.

## Checking it

```sh
npx nymbal config:validate
npx nymbal doctor
```

`config:validate` checks the file against the schema. `doctor` checks the whole project without changing anything:
the config, the installed packages, the command store and its migrations, and each slot's health. `--json` prints the
same as one document.
