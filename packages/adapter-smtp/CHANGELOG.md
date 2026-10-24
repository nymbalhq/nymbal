# @nymbalhq/adapter-smtp

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
