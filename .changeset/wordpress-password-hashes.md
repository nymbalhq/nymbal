---
'@nymbalhq/platform': minor
'@nymbalhq/config': minor
'@nymbalhq/importers': patch
'nymbal': minor
---

`nymbal import --source woocommerce --password-hashes <file>` loads WordPress password hashes (`wp db query "SELECT user_email, user_pass FROM wp_users" --skip-column-names`) for imported customers, who then sign in with their WordPress password once and hold a Nymbal one. Set `security.auth.legacy.until` (a date at most 366 days ahead) first: after it, old hashes are refused and swept. `security.auth.legacy.maxCost: 11 | 12` accepts the costlier bcrypt WordPress writes on PHP 8.4, at the price of slower refused sign-ins until that date.
