---
'@nymbalhq/sdk': patch
---

Requests refused with an expired access token while a token refresh is in flight now wait for that one refresh and are sent again with the new token, rather than failing. A custom `FetchClient` whose `onUnauthorized` refreshes through the same client should pass `{ authRefresh: true }` on that request; an unmarked refresh that is refused is cut off after 10 seconds with the original 401.
