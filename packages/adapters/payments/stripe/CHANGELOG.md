# @nymbalhq/payments-stripe

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

- Declares `secretKey`, `webhookSecret` and `publishableKey` as settings the admin can fill. Without a `secretKey` the
  store starts with payments `down` instead of failing.

## 1.1.0

- Ships the `stripe` recipe for `nymbal add stripe`.
- `client()` hands the storefront the publishable key (`publishableKey` or `STRIPE_PUBLISHABLE_KEY`); a secret key there
  fails at start.

## 1.0.0

- First release: the Stripe payments adapter, moved out of the kernel. Install it with `stripe` when the config names
  `payments: { provider: 'stripe' }`.
