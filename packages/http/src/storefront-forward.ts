import httpProxy from '@fastify/http-proxy'
import type { HTTPMethods } from 'fastify'
import type { FastifyHttpAdapter } from './fastify-adapter.js'

export interface StorefrontForwardOptions {
  /** The storefront's internal port on 127.0.0.1. */
  port: number
  /** The store's public origin: the storefront sees its host and scheme, whatever the client sent. */
  publicUrl: string
}

export interface StorefrontForward {
  /** Forwards started and not yet ended or cut. */
  inFlight(): number
  /** From now on a new page request answers 503; forwards in flight go on. */
  refuse(): void
  /** Resolves true once no forward is in flight, false when `timeoutMs` passes first. */
  drained(timeoutMs: number): Promise<boolean>
}

/** OPTIONS stays the API's: CORS answers a preflight on any path. */
const FORWARDED_METHODS: HTTPMethods[] = ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT']

/**
 * Forwards every request the API does not route to the storefront on its internal port, body and headers unchanged
 * both ways. A path under /api/ keeps the API's not-found answer and never reaches the storefront. Call before
 * `adapter.start`.
 */
export function forwardToStorefront(
  adapter: FastifyHttpAdapter,
  options: StorefrontForwardOptions,
): StorefrontForward {
  const origin = new URL(options.publicUrl)
  const proto = origin.protocol.slice(0, -1)
  let inFlight = 0
  let refusing = false
  const waiters = new Set<() => void>()
  const settle = (): void => {
    inFlight -= 1
    if (inFlight === 0) for (const wake of [...waiters]) wake()
  }

  adapter.registerPlugin(async (api) => {
    // The forward's own context passes every body through as a stream, so this one does too.
    api.removeAllContentTypeParsers()
    api.addContentTypeParser('*', (_req, payload, done) => done(null, payload))
    api.route({
      method: FORWARDED_METHODS,
      url: '/api/*',
      handler: (_req, reply) => reply.callNotFound(),
    })
  })

  adapter.registerPlugin(async (pages) => {
    pages.removeAllContentTypeParsers()
    await pages.register(httpProxy, {
      upstream: `http://127.0.0.1:${options.port}`,
      httpMethods: FORWARDED_METHODS,
      internalRewriteLocationHeader: false,
      preHandler: (_req, reply, done) => {
        if (refusing) {
          void reply
            .code(503)
            .header('connection', 'close')
            .send({ error: { code: 'unavailable', message: 'The store is shutting down' } })
          return
        }
        inFlight += 1
        reply.raw.once('close', settle)
        done()
      },
      replyOptions: {
        rewriteRequestHeaders: (req, headers) => {
          const prior = req.headers['x-forwarded-for']
          const peer = req.raw.socket.remoteAddress ?? req.ip
          return {
            ...headers,
            host: origin.host,
            'x-forwarded-host': origin.host,
            'x-forwarded-proto': proto,
            'x-forwarded-for': [prior, peer].flat().filter(Boolean).join(', '),
          }
        },
        // A forward is never retried: a page POST may not be idempotent, and a 503 is the storefront's answer.
        retryDelay: () => null,
        onError: (reply) => {
          void reply
            .code(503)
            .send({ error: { code: 'unavailable', message: 'The storefront is not answering' } })
        },
      },
    })
  })

  return {
    inFlight: () => inFlight,
    refuse() {
      refusing = true
    },
    drained(timeoutMs) {
      if (inFlight === 0) return Promise.resolve(true)
      return new Promise<boolean>((resolve) => {
        const finish = (value: boolean): void => {
          clearTimeout(timer)
          waiters.delete(wake)
          resolve(value)
        }
        const wake = (): void => finish(true)
        const timer = setTimeout(() => finish(false), timeoutMs)
        waiters.add(wake)
      })
    },
  }
}
