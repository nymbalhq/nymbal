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

`--dry-run` imports nothing: it writes `nymbal-import-plan.json` and `.md` with the counts, the collisions, the fields
it cannot map and an estimate. `WOOCOMMERCE_KEY` and `WOOCOMMERCE_SECRET` can stand in for `--key` and `--secret`.

## What it does

- Maps products, categories, customers and orders onto Nymbal's, and reviews too with
  `--entities products,customers,orders,reviews`.
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
