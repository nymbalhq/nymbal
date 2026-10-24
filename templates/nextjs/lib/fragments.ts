// The fragment routes answer one element as the server renders it, the same as the pages carry, for a CDN to cache
// and an edge to assemble. Next sets each 200's Cache-Control from the route's TTL; a fragment reads no request, so it
// is the same for every shopper.

/** A fragment's HTML. It has no <meta charset>, so the charset is in the header. */
export function fragment(html: string): Response {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

/** No fragment by that name: Next may hold it for the route's TTL, and `no-store` keeps a CDN from storing it. */
export function noFragment(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
