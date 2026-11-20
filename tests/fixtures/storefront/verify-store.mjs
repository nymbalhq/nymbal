import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

// A production storefront stand-in for `nymbal verify`, run as `node <this file>` through NYMBAL_STOREFRONT_ENTRY with
// HOST, PORT and NYMBAL_API_URL from the environment. It renders the home page and a product page from the API, as the
// templates do, each loading one script of its own origin. A test copies this file into a directory of its own (never
// the project, which must stay clean) and writes `verify-store.json` beside it:
//
//   { "mode": "healthy" | "product-500" | "hold-product", "report": "<file>" }
//
// `product-500` answers every product page 500; `hold-product` accepts a product page request and never answers.
// Once listening it writes `report`: its pid, port, NYMBAL_API_URL and NODE_ENV, so the test can find both ports.

const sidecar = new URL('./verify-store.json', import.meta.url)
const settings = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, 'utf8')) : {}
const mode = settings.mode ?? 'healthy'
const api = process.env.NYMBAL_API_URL

const escape = (s) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const html = (res, status, body, script) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(
    `<!doctype html><html><head><title>Shop</title>` +
      (script ? `<script type="module" src="${script}"></script>` : '') +
      `</head><body>${body}</body></html>`,
  )
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://stand-in').pathname
  if (path === '/') return html(res, 200, '<h1>Shop</h1>', '/assets/home.js')
  if (path === '/assets/home.js' || path === '/assets/product.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    return res.end('export {}\n')
  }
  const slug = /^\/product\/([^/]+)$/.exec(path)?.[1]
  if (slug !== undefined) {
    if (mode === 'hold-product') return
    if (mode === 'product-500') return html(res, 500, '<h1>Internal error</h1>')
    try {
      const answer = await fetch(new URL(`/api/products/${slug}`, api))
      if (answer.status !== 200) return html(res, answer.status, '<h1>Not found</h1>')
      const { data } = await answer.json()
      return html(res, 200, `<h1>${escape(data.name)}</h1>`, '/assets/product.js')
    } catch (error) {
      return html(res, 502, `<p>${escape(String(error))}</p>`)
    }
  }
  html(res, 404, '<h1>Not found</h1>')
})

server.listen(Number(process.env.PORT), process.env.HOST ?? '127.0.0.1', () => {
  if (settings.report) {
    writeFileSync(
      settings.report,
      JSON.stringify({
        pid: process.pid,
        port: server.address().port,
        apiUrl: api ?? null,
        nodeEnv: process.env.NODE_ENV ?? null,
      }),
    )
  }
})
