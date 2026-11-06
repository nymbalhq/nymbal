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
