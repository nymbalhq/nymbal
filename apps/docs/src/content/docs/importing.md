---
title: Importing from WooCommerce
description: Bring products, categories, customers, orders and reviews over from a WooCommerce store.
---

`nymbal import` reads a WooCommerce store through its REST API and writes what it finds into yours. Create a REST API
key in WooCommerce (WooCommerce, Settings, Advanced, REST API) with read access, then plan the import before you run
it:

```sh
npx nymbal import --source woocommerce --url https://mystore.com --key <ck_…> --secret <cs_…> --dry-run
npx nymbal import --source woocommerce --url https://mystore.com --key <ck_…> --secret <cs_…>
```

`--dry-run` imports nothing: it writes `nymbal-import-plan.json` and `.md` with the counts, the collisions, the records it
cannot read, the fields it cannot map and an estimate. `WOOCOMMERCE_KEY` and `WOOCOMMERCE_SECRET` can stand in for `--key` and `--secret`.

## What it does

- Maps products, categories, customers and orders onto Nymbal's, and reviews too with
  `--entities categories,products,customers,orders,reviews`.
- Anonymises customers' personal data by default; `--no-gdpr` keeps it.
- Fills in missing product fields through your AI provider when one is configured; `--no-ai` turns it off.
- Resumes where it stopped after an interruption; `--fresh` starts again.
- Writes a report of what it imported, skipped, and left for you to review.

## Later imports and undoing one

```sh
npx nymbal import --source woocommerce --url https://mystore.com --key <ck_…> --secret <cs_…> --since last
npx nymbal import --rollback
```

`--since last` (or a date, such as `--since 2026-10-01`) brings over only what changed since the last finished import:
new records are created, and imported products take their new names, copy, images and prices. `--rollback` removes
every record the imports in this project created; it asks first, unless you add `--yes`.

## Sign-ins checked against the old platform

When the old platform cannot hand over password hashes, add one small endpoint to it and name it in
`nymbal.config.ts`. Until `security.auth.legacy.until`, a shopper your store has no password for (never imported, or
imported without a hash) signs in with their old email and password: Nymbal asks the endpoint once and, on a yes,
creates or completes the account with its own hash of that password. Every later sign-in is an ordinary one.

```ts
security: {
  auth: {
    legacy: {
      until: '2027-06-30',
      remote: { url: 'https://old-store.example/nymbal/check', timeoutMs: 5000 },
    },
  },
},
```

The URL must be `https://` and hold no user name or password. Set `NYMBAL_LEGACY_AUTH_SECRET` to a secret of at least
32 characters (`openssl rand -base64 32`); the store does not start without it. `timeoutMs` is 500 to 10000 (5000 by
default). The endpoint is asked only for an address with no password in the store, and never after `until`.

The endpoint receives:

```
POST <url>
authorization: Bearer <NYMBAL_LEGACY_AUTH_SECRET>
content-type: application/json

{ "email": "<lowercased>", "password": "<as typed>" }
```

and answers `200 { "valid": true, "customer": { "firstName": "…", "lastName": "…", "phone": "…" } }` (`customer` and
each field optional) or `200 { "valid": false }`. Anything else, a redirect included, is a failure, and the sign-in is
refused. A profile field that is not a string, or is longer than 200 characters, is dropped; an existing customer's
details are never changed from the answer. The endpoint must refuse a request without the bearer, spend the same work
for an address it knows and one it does not, and log no request body, since it holds a shopper's password.

Each address is checked at most 5 times an hour. After 5 timeouts, network errors, 5xx or 429 answers inside a minute,
the endpoint is not asked for 10 minutes and a warning is logged. A refused sign-in answers the same however the
endpoint answered.

## Comparing speed with Lighthouse

`nymbal preview` imports your store into a throwaway copy and serves it on your storefront. With `--lighthouse` it
builds the storefront for production and runs Lighthouse on your WooCommerce home page, one product and one category,
against the same pages in the preview:

```sh
npm install -D lighthouse@^12
npx nymbal preview --source woocommerce --url https://mystore.com --key <ck_…> --secret <cs_…> --lighthouse
```

Lighthouse is not installed with `nymbal`: add it with your package manager, or set `NYMBAL_LIGHTHOUSE_CLI` to the
`lighthouse/cli/index.js` of an install elsewhere. It needs Google Chrome or Chromium; set `CHROME_PATH` if it is not
in the usual place. Each page is measured 3 times (`--lighthouse-runs`, 1 to 9) with Lighthouse's mobile settings, and
`nymbal-preview-report.md` gains a `## Lighthouse` table of the medians. A page that cannot be measured shows `n/a` and
why.
