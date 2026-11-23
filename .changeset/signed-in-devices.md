---
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/sdk': minor
'@nymbalhq/web-components': minor
'@nymbalhq/react': minor
'create-nymbal-app': patch
---

The profile page lists the devices a shopper is signed in on (`nymbal-session-list`, `SessionList`), and each can be signed out, or every one at once; signing out now ends only that browser's session, and the release signs nobody out.
Breaking: a custom `CommerceAdapter` must implement `customers.listSessions`, `endSession` and `endAllSessions`.
