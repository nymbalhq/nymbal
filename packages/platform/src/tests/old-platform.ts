import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { createHold, type Hold } from './settles-within.js'

// An old platform the store asks about a shopper's password, in process, on http://127.0.0.1:<port>. It records every
// request it receives (method, path, headers, raw body) and answers through `reply`, which a test swaps between calls.
// While `hold` is held every request waits at the fake before its reply is chosen, so a test can have several checks
// in flight together. `'hang'` never answers; `close()` ends those sockets too.

export interface OldPlatformRequest {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: string
}

export type OldPlatformReply =
  | { status: number; json?: unknown; text?: string; headers?: Record<string, string> }
  | 'hang'

export interface FakeOldPlatform {
  /** The endpoint the store is configured with. */
  url: string
  /** Requests in arrival order. */
  requests: OldPlatformRequest[]
  /** What the next request is answered; called once per request, after the hold lets it pass. */
  reply: (request: OldPlatformRequest) => OldPlatformReply | Promise<OldPlatformReply>
  /** Called as each request arrives, before the hold (a test moves its injected clock here). */
  onRequest: (request: OldPlatformRequest) => void
  hold: Hold
  close(): Promise<void>
}

export const VALID_FALSE: OldPlatformReply = { status: 200, json: { valid: false } }
export const validTrue = (customer?: Record<string, unknown>): OldPlatformReply => ({
  status: 200,
  json: customer === undefined ? { valid: true } : { valid: true, customer },
})

/** The JSON body a request carried, or undefined when it was not JSON. */
export function bodyOf(request: OldPlatformRequest): unknown {
  try {
    return JSON.parse(request.body) as unknown
  } catch {
    return undefined
  }
}

function send(res: ServerResponse, reply: Exclude<OldPlatformReply, 'hang'>): void {
  const body =
    reply.text !== undefined
      ? reply.text
      : reply.json === undefined
        ? ''
        : JSON.stringify(reply.json)
  res.writeHead(reply.status, {
    ...(reply.json !== undefined && { 'content-type': 'application/json' }),
    ...reply.headers,
  })
  res.end(body)
}

export async function startOldPlatform(path = '/nymbal/check'): Promise<FakeOldPlatform> {
  const sockets = new Set<Socket>()
  const fake: FakeOldPlatform = {
    url: '',
    requests: [],
    reply: () => VALID_FALSE,
    onRequest: () => undefined,
    hold: createHold(),
    close: async () => undefined,
  }
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const request: OldPlatformRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      fake.requests.push(request)
      fake.onRequest(request)
      void (async () => {
        await fake.hold.pass()
        const reply = await fake.reply(request)
        if (reply === 'hang') return
        send(res, reply)
      })()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  fake.url = `http://127.0.0.1:${port}${path}`
  fake.close = async () => {
    fake.hold.release()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return fake
}

/** A URL on 127.0.0.1 nothing listens on: a port bound, then released. */
export async function closedPortUrl(path = '/nymbal/check'): Promise<string> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return `http://127.0.0.1:${port}${path}`
}
