# @nymbalhq/adapter-anthropic

## 1.2.0

### Minor Changes

- 0fe6563: A store owner can enter the provider keys the config leaves unset in the admin's Settings page, instead of editing
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

### Patch Changes

- Updated dependencies [45b8128]
- Updated dependencies [b836370]
- Updated dependencies [3591951]
- Updated dependencies [7a4e472]
- Updated dependencies [0fe6563]
  - @nymbalhq/types@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [3b028c0]
- Updated dependencies [f93dab3]
- Updated dependencies [421722f]
- Updated dependencies [6f72118]
- Updated dependencies [9136ecd]
- Updated dependencies [ea74a39]
  - @nymbalhq/types@1.1.0

## 1.0.0

### Minor Changes

- 6571ce9: Provider SDKs leave the kernel. `@nymbalhq/platform` no longer depends on `stripe`, `@anthropic-ai/sdk` or
  `nodemailer`: each lives in its own package, `@nymbalhq/adapter-stripe`, `@nymbalhq/adapter-anthropic` and
  `@nymbalhq/adapter-smtp`, which the kernel imports only when `nymbal.config.ts` names its provider. A store that uses
  one installs it and its SDK (`npm install @nymbalhq/adapter-stripe stripe`); if it is missing, `createApp` fails with
  `adapter.package_missing` and prints that line for the package manager in use.

  **Breaking: the config only accepts providers it knows.** Each commerce slot's `provider` is now one of
  `KNOWN_PROVIDERS` (exported by `@nymbalhq/config`): payments `native` or `stripe`; email `native` (console) or `smtp`;
  ai `none` or `anthropic`; reviews, search, analytics, shipping and tax `native`; and `custom` for every slot. Any other
  string, which used to load and silently run the native stub, now fails `loadConfig` naming the slot and the providers
  it accepts. In particular:
  - `ai: { provider: 'native' }` is no longer accepted: use `ai: { provider: 'none' }`, which builds no AI adapter
    (`app.adapters.ai` is `null`, and the admin's AI route answers 503).
  - SMTP mail moves from `email: { provider: 'native', config: { transport: 'smtp', smtp } }` to
    `email: { provider: 'smtp', config: { smtp } }` plus `@nymbalhq/adapter-smtp` and `nodemailer`. The old form fails
    `loadConfig` instead of printing mail to the console.
  - The Anthropic key is read from `ai.config.apiKey`, falling back to `ANTHROPIC_API_KEY`.

  **`createApp(config, { adapters })`** takes a project's own adapter for any slot whose provider is `custom`. A `custom`
  slot with nothing injected, or an adapter injected for a slot that is not `custom`, fails with
  `adapter.custom_mismatch`. `nymbal dev` and `nymbal start` cannot inject adapters yet. In production the stub-payments
  refusal reads the resolved adapter, so an injected stub is refused and an injected real adapter starts.

  **Capabilities.** `capabilities` is now a method, `capabilities(): readonly string[]`, on every adapter, the document
  store, the event bus and `MediaStorage`; adapters written against the old `capabilities` array must become a function.
  `app.capabilities()` reports each slot's provider and its adapter's answer. The native payments stub no longer lists
  `webhook`, since it verifies no signature.

  The kernel no longer exports `createStripePaymentsAdapter` or `createAnthropicAiAdapter` (import them from the adapter
  packages), and `createNativeEmailAdapter` keeps only the console transport. A new project's config defaults ai to
  `none`, so a fresh store installs no provider SDK. The WooCommerce importer skips AI enrichment when the store has no
  AI provider.

### Patch Changes

- Updated dependencies [6571ce9]
  - @nymbalhq/types@1.0.0
