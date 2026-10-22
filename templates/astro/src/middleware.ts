import { defineMiddleware } from 'astro:middleware'

// The standalone Node adapter compresses nothing, so a page's HTML (its styles inlined) went over the wire whole.
// An HTML response is gzipped as a stream when the client accepts it; everything else passes through unchanged, and a
// proxy that compresses sees the encoding and passes it on.
export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next()
  const accepts = context.request.headers.get('accept-encoding') ?? ''
  const type = response.headers.get('content-type') ?? ''
  if (
    !/(^|,)\s*gzip\s*(;|,|$)/.test(accepts) ||
    !type.startsWith('text/html') ||
    response.body === null ||
    response.headers.has('content-encoding')
  ) {
    return response
  }
  const headers = new Headers(response.headers)
  headers.set('content-encoding', 'gzip')
  headers.delete('content-length')
  headers.append('vary', 'Accept-Encoding')
  return new Response(response.body.pipeThrough(new CompressionStream('gzip')), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
})
