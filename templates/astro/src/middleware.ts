import { defineMiddleware } from 'astro:middleware'

/** Whether an `Accept-Encoding` value accepts gzip: a `gzip` entry (or, without one, `*`) with a q-value above 0. */
function acceptsGzip(header: string): boolean {
  let star = false
  for (const entry of header.split(',')) {
    const [coding = '', ...params] = entry.split(';').map((part) => part.trim().toLowerCase())
    const q = params.find((param) => param.startsWith('q='))
    const accepted = q === undefined || Number(q.slice(2)) > 0
    if (coding === 'gzip' || coding === 'x-gzip') return accepted
    if (coding === '*') star = accepted
  }
  return star
}

// The standalone Node adapter compresses nothing, so a page's HTML (its styles inlined) went over the wire whole.
// An HTML response is gzipped as a stream when the client accepts it; everything else passes through unchanged, and a
// proxy that compresses sees the encoding and passes it on. Every HTML response varies on Accept-Encoding, the
// uncompressed one included, so a cache keeps both forms apart.
export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next()
  const type = response.headers.get('content-type') ?? ''
  if (!type.startsWith('text/html') || response.headers.has('content-encoding')) return response
  const headers = new Headers(response.headers)
  headers.append('vary', 'Accept-Encoding')
  let body = response.body
  if (body !== null && acceptsGzip(context.request.headers.get('accept-encoding') ?? '')) {
    headers.set('content-encoding', 'gzip')
    headers.delete('content-length')
    body = body.pipeThrough(new CompressionStream('gzip'))
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
})
