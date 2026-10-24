# @nymbalhq/adapter-anthropic

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
