---
'@nymbalhq/platform': minor
'@nymbalhq/types': minor
'@nymbalhq/config': minor
'@nymbalhq/http': minor
'@nymbalhq/sdk': minor
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'@nymbalhq/admin': minor
'nymbal': minor
---

Breaking: on a store with an email provider, `POST /api/auth/register` answers 202 "check your email" for every address and signs nobody in until the mailed link (`/account/verify-email`) is followed; `security.auth.verification: 'off'` keeps the old behaviour, and a `native` store is `off` by default.
Support can send the link again or mark the email confirmed from the customer's admin page; `nymbal doctor` and the admin dashboard warn when sign-ups are not confirmed or mail may not be arriving.
Until an address is confirmed, a later register for it replaces the waiting account's password; its owner can still set their own with Forgot password.
A store scaffolded before this release needs the template's `/account/verify-email` page before it adds an email provider, or the mailed link lands on a missing page.
