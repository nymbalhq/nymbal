---
title: Adapters
description: Fill a slot (payments, email, search, storage) with a provider, first-party or your own.
---

Every part of a store that talks to the outside world is a **slot** with a **provider**: payments, email, reviews,
search, analytics, shipping, tax and AI under `commerce`, and the command store, read-model store, event bus and media
under `infrastructure`. A new store fills each with a built-in provider that needs no account. For production you swap
in real ones.

## Adding one

`nymbal add` installs the package, edits `nymbal.config.ts`, and lists the variables the provider needs in
`.env.example`:

```sh
npx nymbal add stripe
npx nymbal add postgres
npx nymbal add <slot> <provider>
npx nymbal add <package>
```

The short forms are recipes: `postgres`, `redis`, `s3`, `stripe`, `algolia` and `cloudflare`. `nymbal add` on its own
lists every recipe and slot, and `--dry-run` prints the change without writing it. A third-party adapter is added by
its package name.

## First-party adapters

These live in the Nymbal repository, are published as `@nymbalhq/<slot>-<provider>`, and pass their slot's contract
suite on every change:

| Slot           | Providers                         |
| -------------- | --------------------------------- |
| payments       | Stripe                            |
| email          | Mailgun, Resend, Amazon SES, SMTP |
| search         | Algolia                           |
| shipping       | EasyPost                          |
| document store | Postgres (JSONB), Redis           |
| event bus      | Redis Streams                     |
| media          | S3 and S3-compatible storage      |
| security       | Cloudflare                        |
| AI             | Anthropic, OpenAI                 |

## The registry

The [adapter registry](https://github.com/nymbalhq/nymbal/blob/main/registry/README.md) lists every adapter, first-party
and third-party, with its tier and its nightly certification status. To certify an adapter you wrote against its
slot's contract suite:

```sh
npx nymbal test:contracts --package <package>
```

To contribute one to Nymbal itself, see the
[guide to adding an adapter](https://github.com/nymbalhq/nymbal/blob/main/packages/adapters/README.md).
