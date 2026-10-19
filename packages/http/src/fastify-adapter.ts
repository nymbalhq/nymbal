import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyCors from '@fastify/cors'
import { v7 as uuidv7 } from 'uuid'
import type {
  HttpAdapter,
  HttpMethod,
  Logger,
  MiddlewareHandler,
  RequestContext,
  ResponseEnvelope,
  RouteHandler,
  RouteOptions,
  SseEvent,
  StreamContext,
  StreamHandler,
} from '@nymbalhq/types'
import { HttpError, NymbalError } from '@nymbalhq/types'
import type { NymbalConfig } from '@nymbalhq/config'
import { createSecurityGuard, type SecurityGuard } from './security-middleware.js'

export interface CorsOptions {
  allowedOrigins: string[]
  credentials: boolean
}

export interface FastifyAdapterOptions {
  logger: Logger
  /** The guard every route passes before its middlewares and handler: rate limit, then CSRF on unsafe methods. */
  security: NymbalConfig['security']
  /** Whether `X-Forwarded-For` sets the request IP. Off unless a trusted proxy sits in front. */
  trustProxy?: boolean
  cors?: CorsOptions
}

/** How long a stream ended at shutdown may take to flush before its socket is destroyed regardless. */
const STREAM_END_BOUND_MS = 500

export class FastifyHttpAdapter implements HttpAdapter {
  readonly #app: FastifyInstance
  readonly #logger: Logger
  readonly #guard: SecurityGuard
  readonly #middlewares: MiddlewareHandler[] = []
  readonly #defaultHeaders: Record<string, string> = {}
  /** Ends each open stream for shutdown; a stream removes itself once its close callbacks have run. */
  readonly #openStreams = new Set<() => void>()
  #started = false
  #stopping = false
  #boundPort = 0

  constructor(options: FastifyAdapterOptions) {
    this.#logger = options.logger
    this.#guard = createSecurityGuard(options.security)
    this.#app = Fastify({
      logger: false,
      trustProxy: options.trustProxy ?? false,
      disableRequestLogging: true,
      genReqId: () => uuidv7(),
    })
    // A signed webhook is verified against the bytes sent, so a route registered with `rawBody` keeps them. The
    // body is still parsed by Fastify's own JSON parser, with its poisoning settings and its 400s.
    const parseJson = this.#app.getDefaultJsonParser(
      this.#app.initialConfig.onProtoPoisoning ?? 'error',
      this.#app.initialConfig.onConstructorPoisoning ?? 'error',
    )
    this.#app.removeContentTypeParser('application/json')
    this.#app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      const buffer = body as Buffer
      const config = req.routeOptions.config as { routeOptions?: RouteOptions } | undefined
      if (config?.routeOptions?.rawBody === true) req.rawBody = buffer
      parseJson(req, buffer.toString('utf8'), done)
    })
    // Fastify's `close()` waits for every open connection, and a stream never ends by itself. `preClose` runs after
    // Fastify answers new requests 503 and before `server.close()`, so no stream can hold the close once it has run.
    this.#app.addHook('preClose', async () => {
      this.#stopping = true
      for (const endStream of this.#openStreams) endStream()
    })
    void this.#app.register(fastifyCookie)
    if (options.cors && options.cors.allowedOrigins.length > 0) {
      void this.#app.register(fastifyCors, {
        origin: options.cors.allowedOrigins,
        credentials: options.cors.credentials,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      })
    }
    // The token a client on another origin of the same site echoes in `x-csrf-token`: it cannot read this cookie.
    this.registerRoute('GET', '/api/csrf', (ctx) => this.#guard.issueToken(ctx))
  }

  get boundPort(): number {
    return this.#boundPort
  }

  registerRoute(
    method: HttpMethod,
    path: string,
    handler: RouteHandler,
    options?: RouteOptions,
  ): void {
    if (this.#started) {
      throw new Error('Cannot register routes after the server has started')
    }
    const routeConfig: {
      method: HttpMethod
      url: string
      handler: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>
      config: { routeOptions: RouteOptions }
      bodyLimit?: number
    } = {
      method,
      url: path,
      handler: async (req, reply) => {
        const ctx = this.#buildContext(req, options?.rawBody ?? false)
        const refused = this.#guard.admit(ctx, options)
        if (refused) return this.#applyEnvelope(reply, refused)
        let envelope: ResponseEnvelope
        try {
          envelope = await this.#runMiddlewaresThen(ctx, handler)
        } catch (err) {
          envelope = this.#renderError(err, ctx)
        }
        return this.#applyEnvelope(reply, this.#guard.finish(ctx, envelope))
      },
      config: { routeOptions: options ?? {} },
    }
    this.#app.route(routeConfig)
  }

  registerStreamRoute(
    method: 'GET',
    path: string,
    handler: StreamHandler,
    options?: RouteOptions,
  ): void {
    if (this.#started) {
      throw new Error('Cannot register routes after the server has started')
    }
    this.#app.route({
      method,
      url: path,
      handler: async (req, reply) => {
        const ctx = this.#buildContext(req, false)
        const refused = this.#guard.admit(ctx, options)
        if (refused) return this.#applyEnvelope(reply, refused)
        try {
          for (const mw of this.#middlewares) {
            const out = await mw(ctx)
            if (out) {
              return this.#applyEnvelope(reply, out)
            }
          }
        } catch (err) {
          return this.#applyEnvelope(reply, this.#renderError(err, ctx))
        }
        // Routed before Fastify began closing, but its middlewares finished after the open streams were ended.
        if (this.#stopping) {
          return this.#applyEnvelope(reply, {
            status: 503,
            headers: { connection: 'close' },
            body: { error: { code: 'unavailable', message: 'Server is shutting down' } },
          })
        }
        const raw = reply.raw
        // Taken now: a finished response detaches from its socket before `end`'s callback runs.
        const socket = req.raw.socket
        raw.writeHead(200, {
          ...this.#defaultHeaders,
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        reply.hijack()
        const closeCallbacks: Array<() => void> = []
        let ending = false
        let closed = false
        const end = (then?: () => void): void => {
          if (ending) return
          ending = true
          try {
            raw.end(then)
          } catch {
            // ignore
          }
        }
        // A clean end, so the client sees a complete response, then the keep-alive socket goes too: it would hold
        // `server.close()` open. The bound covers a socket whose end never flushes.
        const endForShutdown = (): void => {
          const bound = setTimeout(() => socket.destroy(), STREAM_END_BOUND_MS)
          bound.unref()
          end(() => {
            clearTimeout(bound)
            socket.destroy()
          })
        }
        const close = (): void => {
          end()
          if (closed) return
          closed = true
          this.#openStreams.delete(endForShutdown)
          for (const cb of closeCallbacks) {
            try {
              cb()
            } catch (err) {
              ctx.logger.error({ err }, 'stream close callback failed')
            }
          }
        }
        req.raw.on('close', close)
        req.raw.on('error', close)
        this.#openStreams.add(endForShutdown)
        const stream: StreamContext = {
          send(event: SseEvent): void {
            if (ending) return
            let line = ''
            if (event.id !== undefined) line += `id: ${event.id}\n`
            if (event.event !== undefined) line += `event: ${event.event}\n`
            const data = typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
            line += `data: ${data}\n\n`
            raw.write(line)
          },
          close,
          onClose(cb: () => void): void {
            closeCallbacks.push(cb)
          },
        }
        try {
          await handler(ctx, stream)
        } catch (err) {
          ctx.logger.error({ err }, 'stream handler threw')
          close()
        }
        return reply
      },
      config: { routeOptions: options ?? {} },
    })
  }

  registerMiddleware(middleware: MiddlewareHandler): void {
    if (this.#started) {
      throw new Error('Cannot register middleware after the server has started')
    }
    this.#middlewares.push(middleware)
  }

  setDefaultHeaders(headers: Record<string, string>): void {
    for (const [k, v] of Object.entries(headers)) {
      this.#defaultHeaders[k.toLowerCase()] = v
    }
  }

  async start(port: number, host = '0.0.0.0'): Promise<void> {
    await this.#app.listen({ port, host })
    this.#boundPort = (this.#app.server.address() as { port: number }).port
    this.#started = true
    this.#logger.info({ port: this.#boundPort, host }, 'HTTP server listening')
  }

  async stop(): Promise<void> {
    if (!this.#started) return
    await this.#app.close()
    this.#started = false
  }

  async #runMiddlewaresThen(ctx: RequestContext, handler: RouteHandler): Promise<ResponseEnvelope> {
    for (const mw of this.#middlewares) {
      const out = await mw(ctx)
      if (out) return out
    }
    return handler(ctx)
  }

  #buildContext(req: FastifyRequest, includeRawBody: boolean): RequestContext {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) ?? req.id
    const logger = this.#logger.child({ requestId: req.id, correlationId })
    const ctx: RequestContext = {
      method: req.method as HttpMethod,
      path: req.routeOptions?.url ?? req.url,
      url: req.url,
      params: (req.params ?? {}) as Record<string, string>,
      query: (req.query ?? {}) as Record<string, string | string[] | undefined>,
      body: req.body,
      headers: req.headers,
      cookies: (req.cookies ?? {}) as Record<string, string>,
      requestId: req.id,
      correlationId,
      logger,
      ip: req.ip,
    }
    if (includeRawBody && Buffer.isBuffer(req.rawBody)) {
      ctx.rawBody = req.rawBody
    }
    return ctx
  }

  #applyEnvelope(reply: FastifyReply, envelope: ResponseEnvelope): FastifyReply {
    reply.status(envelope.status)
    for (const [name, value] of Object.entries(this.#defaultHeaders)) {
      reply.header(name, value)
    }
    if (envelope.headers) {
      for (const [name, value] of Object.entries(envelope.headers)) {
        reply.header(name, value)
      }
    }
    if (envelope.cookies) {
      for (const cookie of envelope.cookies) {
        reply.setCookie(cookie.name, cookie.value, {
          path: cookie.path ?? '/',
          ...(cookie.domain !== undefined && { domain: cookie.domain }),
          ...(cookie.maxAge !== undefined && { maxAge: cookie.maxAge }),
          httpOnly: cookie.httpOnly ?? false,
          secure: cookie.secure ?? false,
          ...(cookie.sameSite !== undefined && { sameSite: cookie.sameSite }),
        })
      }
    }
    if (envelope.body === undefined) {
      return reply.send()
    }
    return reply.send(envelope.body)
  }

  #renderError(err: unknown, ctx: RequestContext): ResponseEnvelope {
    if (err instanceof HttpError) {
      ctx.logger.warn({ err: err.toJSON() }, err.message)
      return {
        status: err.status,
        body: { error: { code: err.code, message: err.message } },
      }
    }
    if (err instanceof NymbalError) {
      ctx.logger.error({ err: err.toJSON() }, err.message)
      return {
        status: 500,
        body: { error: { code: err.code, message: err.message } },
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger.error({ err }, message)
    return {
      status: 500,
      body: { error: { code: 'internal', message: 'Internal server error' } },
    }
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer
  }
}
