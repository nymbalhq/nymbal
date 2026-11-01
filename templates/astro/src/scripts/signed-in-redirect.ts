/**
 * Where to go once signed in: the decoded `redirect` as the URL parser reads it against `origin`, if both are a path
 * on `origin` (one leading `/`, and `/.//host` reads as `//host`) with no control character; else /account.
 */
export function signedInTarget(redirect: string | null, origin: string): string {
  if (redirect === null || !/^\/(?![/\\])/.test(redirect)) return '/account'
  if ([...redirect].some((c) => c < ' ' || c === '\x7f')) return '/account'
  const url = new URL(redirect, origin)
  const target = url.pathname + url.search + url.hash
  return /^\/(?![/\\])/.test(target) && url.origin === new URL(origin).origin ? target : '/account'
}

// Signed in or registered: on to the page that sent the shopper here (`?redirect`), or the account.
document.addEventListener('nymbal:auth:signed-in', () => {
  const redirect = new URLSearchParams(window.location.search).get('redirect')
  window.location.href = signedInTarget(redirect, window.location.origin)
})
