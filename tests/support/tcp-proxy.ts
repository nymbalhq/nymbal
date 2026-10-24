import { connect, createServer, type Server, type Socket } from 'node:net'

// A TCP proxy to a service, so a client that connects at construction (the Redis primitives) can be built while the
// service is up and then left on a port that refuses: the way the health and contract tests make "unreachable".
// `reopen()` listens on the same port again, so a test can see the client reconnect.

export interface TcpProxy {
  port: number
  /** `target`'s URL with the host and port replaced by the proxy's. */
  url(target: string): string
  /** Stops listening and cuts every open connection: the port then refuses. Idempotent. */
  close(): Promise<void>
  /** Listens on the same port again, forwarding as before. */
  reopen(): Promise<void>
}

export async function tcpProxy(target: URL): Promise<TcpProxy> {
  const sockets = new Set<Socket>()
  let server: Server | null = null
  let port = 0

  const listen = async (on: number): Promise<number> => {
    const s = createServer((client) => {
      const upstream = connect(Number(target.port), target.hostname)
      sockets.add(client).add(upstream)
      const end = () => {
        client.destroy()
        upstream.destroy()
        sockets.delete(client)
        sockets.delete(upstream)
      }
      client.on('error', end).on('close', end)
      upstream.on('error', end).on('close', end)
      client.pipe(upstream).pipe(client)
    })
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject)
      s.listen(on, '127.0.0.1', () => resolve())
    })
    server = s
    return (s.address() as { port: number }).port
  }

  port = await listen(0)
  return {
    port,
    url(of: string) {
      const u = new URL(of)
      u.hostname = '127.0.0.1'
      u.port = String(port)
      return u.toString()
    },
    async close() {
      const s = server
      server = null
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      if (s !== null) await new Promise<void>((resolve) => s.close(() => resolve()))
    },
    async reopen() {
      if (server === null) await listen(port)
    },
  }
}

/** A port nothing listens on: bound, read and released. */
export async function closedPort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', () => resolve()))
  const { port } = s.address() as { port: number }
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}

/** How a call settled within `ms`: resolved, rejected, or still pending (`hung`), and how long it took. */
export async function settleWithin<T>(
  call: Promise<T>,
  ms: number,
): Promise<{ state: 'resolved' | 'rejected' | 'hung'; value?: T; error?: unknown; ms: number }> {
  const started = Date.now()
  let timer: NodeJS.Timeout | undefined
  const hung = new Promise<{ state: 'hung' }>((resolve) => {
    timer = setTimeout(() => resolve({ state: 'hung' }), ms)
  })
  try {
    const outcome = await Promise.race([
      call.then(
        (value) => ({ state: 'resolved' as const, value }),
        (error: unknown) => ({ state: 'rejected' as const, error }),
      ),
      hung,
    ])
    return { ...outcome, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

/** Closes something without letting a close that hangs hold the suite. */
export async function closeBounded(close: () => Promise<void>, ms = 5000): Promise<void> {
  await Promise.race([close().catch(() => undefined), new Promise((r) => setTimeout(r, ms))])
}
