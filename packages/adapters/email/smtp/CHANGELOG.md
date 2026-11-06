# @nymbalhq/email-smtp

## 1.6.0

### Minor Changes

- bb965f3: Breaking: the email adapters now need nodemailer 10.1.4 or later, the first release with every published security fix; on nodemailer 6 to 9, upgrade it with the adapter.

### Patch Changes

- 853d563: Every package has a README on npm. `nymbal mcp` now passes on the name and version of the MCP host that connected, so proposals, carts and orders record that agent rather than a generic client.
  `create-nymbal-app` ends by naming where to report a problem.

## 1.5.0

### Minor Changes

- 6c85536: Adapters are named by slot: `@nymbalhq/payments-stripe` (renamed from `@nymbalhq/adapter-stripe`), `@nymbalhq/email-smtp`
  (from `@nymbalhq/adapter-smtp`), `@nymbalhq/ai-anthropic` (from `@nymbalhq/adapter-anthropic`), `@nymbalhq/document-store-redis`
  (from `@nymbalhq/doc-store-redis`) and `@nymbalhq/document-store-postgres-jsonb` (from `@nymbalhq/doc-store-postgres-jsonb`).
  Breaking: replace each old name with its new one in your store's `package.json`; the old names are not loaded.

### Patch Changes

- f05e635: Any provider name loads `@nymbalhq/<slot>-<provider>`, or the package its block names with `package:` (`security`
  too), so a third-party adapter needs no Nymbal release; a mistyped provider gets "did you mean", not an install line.
  Breaking: write `documentStore: { provider: 'redis' }` for `documentStore: 'redis'`, and the same for `eventBus` and
  `media`.
  Breaking: `@nymbalhq/config` `KNOWN_INFRASTRUCTURE` is now `ADAPTER_CATALOGUE` and `COMMAND_STORES`; `@nymbalhq/platform`
  `PROVIDER_PACKAGES` and `importProviderPackage` are now `resolveChoice` and `importAdapterModule`; error code
  `config.security_adapter_unknown` is now `adapter.provider_unknown`.
- d2513b9: Adapters now version on their own and peer `@nymbalhq/types`; install an adapter by name, with no version to match.

## 1.4.0

### Patch Changes

- Updated dependencies [8e06b03]
- Updated dependencies [295dab6]
- Updated dependencies [d724fd2]
- Updated dependencies [6f73872]
- Updated dependencies [ff6559d]
- Updated dependencies [8e06b03]
- Updated dependencies [75989c8]
- Updated dependencies [dbf1425]
- Updated dependencies [c8588b2]
  - @nymbalhq/types@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0

## 1.2.0

- `healthCheck` reports `down` within 5 s when the server cannot be reached, and a send gives up after 4 s on a host
  that never answers.
- Declares `smtp.user` and `smtp.pass` as settings the admin can fill.

## 1.1.0

- Versioned with the other packages; no changes of its own.

## 1.0.0

- First release: SMTP mail, moved out of the kernel. Use `email: { provider: 'smtp', config: { smtp } }` and install it
  with `nodemailer`.
