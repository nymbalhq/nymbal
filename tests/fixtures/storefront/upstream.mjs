import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'

// A storefront stand-in for `nymbal start`, run as `node <this file>` through NYMBAL_STOREFRONT_ENTRY with HOST and
// PORT from the environment. Like the Astro node server it installs no SIGTERM or SIGINT handler, so either signal
// ends it at once, with any response in flight cut.
//
// A test copies this file into a directory of its own and writes `storefront-upstream.json` beside it,
// `{ "controlPort": <n> }`; the stand-in then connects to that port and reports, one JSON line each, that it is up
// (with its pid) and every request it gets. A request under /held waits until the test writes a `release` line, then
// calls GET /api/products on NYMBAL_API_URL and answers 200 with what it got. Any other request answers 200 at once
// with the path and the environment it was started with.

const sidecar = new URL('./storefront-upstream.json', import.meta.url)
const control = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, 'utf8')) : null

const waiting = []
let socket = null
if (control !== null) {
  socket = connect(control.controlPort, '127.0.0.1')
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  let buffered = ''
  socket.on('data', (chunk) => {
    buffered += chunk
    let at
    while ((at = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, at)
      buffered = buffered.slice(at + 1)
      if (line === 'release') waiting.shift()?.()
    }
  })
}

function report(message) {
  socket?.write(`${JSON.stringify(message)}\n`)
}

async function products() {
  try {
    const res = await fetch(new URL('/api/products', process.env.NYMBAL_API_URL))
    return { status: res.status, body: await res.json() }
  } catch (error) {
    return { error: String(error) }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://upstream')
  report({ event: 'request', method: req.method, path: url.pathname })
  if (url.pathname.startsWith('/held')) {
    await new Promise((resolve) => {
      waiting.push(resolve)
      report({ event: 'arrived', path: url.pathname })
    })
    const api = await products()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ page: url.pathname, api }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      page: url.pathname,
      headers: req.headers,
      env: {
        HOST: process.env.HOST ?? null,
        PORT: process.env.PORT ?? null,
        NYMBAL_API_URL: process.env.NYMBAL_API_URL ?? null,
        NYMBAL_PUBLIC_URL: process.env.NYMBAL_PUBLIC_URL ?? null,
      },
    }),
  )
})

server.listen(Number(process.env.PORT), process.env.HOST ?? '127.0.0.1', () => {
  report({ event: 'up', pid: process.pid })
})
