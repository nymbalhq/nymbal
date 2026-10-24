import { Agent, request, type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import { FastifyHttpAdapter } from './fastify-adapter.js'

// AC-1: the adapter ends its open streams when it stops, without aborting sockets, running a close callback twice, or
// letting a stream opened during shutdown hold `close()`.

const logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this
  },
}
const security = securitySchema.parse({ adapter: 'middleware' })

const STOP_WITHIN_MS = 1000
/** How long any wait in this file lasts before it gives up, so a red run fails instead of hanging. */
const GIVE_UP_MS = 3000

let cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

/** Resolves with the elapsed ms, or `Infinity` when `p` did not settle within `ms`. */
async function elapsedWithin(p: Promise<unknown>, ms: number): Promise<number> {
  const startedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<number>((r) => {
    timer = setTimeout(() => r(Number.POSITIVE_INFINITY), ms)
  })
  try {
    return await Promise.race([p.then(() => Date.now() - startedAt), gaveUp])
  } finally {
    clearTimeout(timer)
  }
}

function waitFor<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`gave up after ${ms} ms waiting for ${what}`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** Resolves once `cond()` holds, checked on every turn of the event loop; rejects after `ms`. */
async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`gave up after ${ms} ms waiting for ${what}`)
    await new Promise((r) => setImmediate(r))
  }
}

async function startAdapter(): Promise<{
  adapter: FastifyHttpAdapter
  port: number
  closes: () => number
}> {
  const adapter = new FastifyHttpAdapter({ logger, security })
  let closeCount = 0
  adapter.registerRoute('GET', '/api/ping', async () => ({ status: 200, body: { ok: true } }))
  adapter.registerStreamRoute('GET', '/api/stream', async (_ctx, stream) => {
    stream.onClose(() => {
      closeCount += 1
    })
    stream.send({ event: 'connected', data: { ok: true } })
  })
  await adapter.start(0, '127.0.0.1')
  cleanup.push(async () => {
    await elapsedWithin(
      adapter.stop().catch(() => {}),
      GIVE_UP_MS,
    )
  })
  return { adapter, port: adapter.boundPort, closes: () => closeCount }
}

function keepAliveAgent(): Agent {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  cleanup.push(() => agent.destroy())
  return agent
}

interface OpenStream {
  res: IncomingMessage
  socket: Socket
  /** Settles when the response emits `end` (true) or is aborted / errors first (false). */
  ended: Promise<boolean>
  socketClosed: Promise<void>
}

/** Opens the stream and waits for its first frame, so the handler has registered its close callback. */
async function openStream(port: number, agent: Agent): Promise<OpenStream> {
  return waitFor(
    new Promise<OpenStream>((resolveOpen, rejectOpen) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/stream', agent }, (res) => {
        const socket = res.socket
        const ended = new Promise<boolean>((r) => {
          res.once('end', () => r(res.complete))
          res.once('aborted', () => r(false))
          res.once('error', () => r(false))
          res.once('close', () => r(res.complete))
        })
        const socketClosed = new Promise<void>((r) => socket.once('close', () => r()))
        res.once('data', () => resolveOpen({ res, socket, ended, socketClosed }))
      })
      req.on('error', rejectOpen)
      req.end()
    }),
    GIVE_UP_MS,
    'the stream to open',
  )
}

/** A plain request that leaves its socket idle in the agent's keep-alive pool. */
async function ping(port: number, agent: Agent): Promise<void> {
  await waitFor(
    new Promise<void>((resolvePing, rejectPing) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/ping', agent }, (res) => {
        res.resume()
        res.once('end', () => resolvePing())
      })
      req.on('error', rejectPing)
      req.end()
    }),
    GIVE_UP_MS,
    'GET /api/ping',
  )
}

type LateOutcome = { kind: 'status'; status: number; contentType: string } | { kind: 'closed' }

/** A stream request whose answer is a status, or a socket closed before any answer. */
function lateStream(port: number, agent: Agent): Promise<LateOutcome> {
  return new Promise<LateOutcome>((resolveLate) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/stream', agent }, (res) => {
      res.resume()
      resolveLate({
        kind: 'status',
        status: res.statusCode ?? 0,
        contentType: String(res.headers['content-type'] ?? ''),
      })
    })
    req.on('error', () => resolveLate({ kind: 'closed' }))
    req.on('close', () => resolveLate({ kind: 'closed' }))
    req.end()
  })
}

describe('FastifyHttpAdapter.stop() with open streams', () => {
  it('AC-1: with a keep-alive client holding a stream open, stop() resolves within 1 s, the response ends cleanly and onClose runs exactly once, also after the client socket closes late', async () => {
    const { adapter, port, closes } = await startAdapter()
    const agent = keepAliveAgent()
    const stream = await openStream(port, agent)
    cleanup.push(() => {
      stream.socket.destroy()
    })
    expect(closes(), 'onClose before stop()').toBe(0)

    const stopMs = await elapsedWithin(adapter.stop(), GIVE_UP_MS)
    expect(stopMs, 'ms until stop() resolved').toBeLessThan(STOP_WITHIN_MS)

    const endedCleanly = await waitFor(stream.ended, GIVE_UP_MS, 'the response to end')
    expect(endedCleanly, 'the response ended with `end`, complete, not an abort').toBe(true)

    await until(() => closes() > 0, GIVE_UP_MS, 'the onClose callback to run')
    // The client's own socket close arrives after stop(); the callback must not run again.
    stream.socket.destroy()
    await waitFor(stream.socketClosed, GIVE_UP_MS, 'the client socket to close')
    await new Promise((r) => setImmediate(r))
    expect(closes()).toBe(1)
  })

  it('AC-1: a stream opened after stop() began gets 503 or a closed socket, never a held stream, and stop() still resolves within 1 s', async () => {
    const { adapter, port } = await startAdapter()
    const held = await openStream(port, keepAliveAgent())
    cleanup.push(() => {
      held.socket.destroy()
    })
    // An idle keep-alive socket, so the late request reaches the server that is shutting down, not a refused port.
    const lateAgent = keepAliveAgent()
    await ping(port, lateAgent)

    const stopping = adapter.stop()
    const late = lateStream(port, lateAgent)

    const stopMs = await elapsedWithin(stopping, GIVE_UP_MS)
    expect(stopMs, 'ms until stop() resolved').toBeLessThan(STOP_WITHIN_MS)

    const outcome = await waitFor(
      late,
      GIVE_UP_MS,
      'the late stream request to be answered or closed',
    )
    const answer = outcome.kind === 'status' ? outcome.status : 'closed'
    expect([503, 'closed'], `late stream: ${JSON.stringify(outcome)}`).toContain(answer)
  })
})
