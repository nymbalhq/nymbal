---
'nymbal': minor
'create-nymbal-app': minor
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/admin': minor
'@nymbalhq/adapter-stripe': minor
'@nymbalhq/adapter-anthropic': minor
'@nymbalhq/adapter-smtp': minor
---

A store owner can enter the provider keys the config leaves unset in the admin's Settings page, instead of editing
environment files. Each value is encrypted at rest, never shown again, and applied when the store next starts.

- **Precedence.** The config wins, then the environment, then Settings. A field the config or environment sets shows
  as "Set by environment" and cannot be changed in the admin.
- **The key.** Values are encrypted with AES-256-GCM under `NYMBAL_SECRETS_KEY` (32 random bytes, base64), each bound
  to its slot and path. `create-nymbal-app` writes a fresh key into the new project's `.env` (never `.env.example`).
  Back it up with your deploy's secrets: a store holding a saved secret refuses to start without its key, with a
  `ConfigError` naming the slot and path. A key that does not match, or a row that was changed, refuses the same way.
- **Adapters declare their settings.** A provider package may export
  `settings: Array<{ path, label, secret, env?, optional? }>` (`AdapterSetting` in `@nymbalhq/types`). Stripe declares
  `secretKey`, `webhookSecret` (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) and `publishableKey`; Anthropic
  `apiKey` (`ANTHROPIC_API_KEY`) and `baseUrl`; SMTP `smtp.user` and `smtp.pass`. The kernel honours a declared `env`
  whether or not the package reads it.
- **A missing key no longer stops the store.** When a declared secret is set nowhere, the slot gets an adapter that
  reports itself `down` (naming the field) and refuses every operation, so the store boots and the admin can take the
  key. For payments, the storefront's Place Order stays disabled. Before, Stripe without a `secretKey` stopped boot.
- **`nymbal add stripe`** no longer writes `env('STRIPE_SECRET_KEY')` and `env('STRIPE_WEBHOOK_SECRET')` into the
  config (an unset variable threw before Settings could fill it); the variables stay in `.env.example`, and the hint
  says to set them in `.env` or in the admin's Settings.
- **Admin API.** `GET /api/admin/settings` lists each slot's declared fields with their state and source, and never a
  secret's value; `PUT /api/admin/settings/:slot/:path` with `{ value }` saves one and `DELETE` clears it (409
  `settings.set_by_environment`, 404 `settings.unknown_field`, 503 `settings.key_missing`). A write publishes
  `settings.changed.v1` with `{ slot, path, source }` and answers `restartRequired: true`.
- **No value leaks.** `createApp` wraps whatever logger it is given so no saved secret reaches a log record, and error
  responses are scrubbed the same way. `createLogger` takes a `destination`. `nymbal doctor` reads the saved values
  to check each slot and prints none of them.
- **CLI.** `nymbal secrets rotate` re-encrypts every saved secret from `NYMBAL_SECRETS_KEY_OLD` to
  `NYMBAL_SECRETS_KEY` in one transaction, or changes nothing and exits 2. `nymbal secrets clear [--slot] [--path]`
  deletes saved values without a key, the recovery for a lost one.
- **Migration 0008** adds the `settings` table on SQLite and Postgres: run `nymbal migrate`. A store not yet migrated
  boots with no settings.
- The Anthropic adapter takes `baseUrl` (passed to the SDK as `baseURL`).
