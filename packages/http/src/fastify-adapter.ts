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
} from '@nymbal/types'
import { HttpError, NymbalError } from '@nymbal/types'

export interface CorsOptions {
  allowedOrigins: string[]
  credentials: boolean
}

export interface FastifyAdapterOptions {
  logger: Logger
  trustProxy?: boolean
  cors?: CorsOptions
}

export class FastifyHttpAdapter implements HttpAdapter {
  readonly #app: FastifyInstance
  readonly #logger: Logger
  readonly #middlewares: MiddlewareHandler[] = []
  readonly #defaultHeaders: Record<string, string> = {}
  #started = false
  #boundPort = 0

  constructor(options: FastifyAdapterOptions) {
    this.#logger = options.logger
    this.#app = Fastify({
      logger: false,
      trustProxy: options.trustProxy ?? true,
      disableRequestLogging: true,
      genReqId: () => uuidv7(),
    })
    void this.#app.register(fastifyCookie)
    if (options.cors && options.cors.allowedOrigins.length > 0) {
      void this.#app.register(fastifyCors, {
        origin: options.cors.allowedOrigins,
        credentials: options.cors.credentials,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      })
    }
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
    const routeConfig: { method: HttpMethod; url: string; handler: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>; config: { routeOptions: RouteOptions }; bodyLimit?: number } = {
      method,
      url: path,
      handler: async (req, reply) => {
        const ctx = this.#buildContext(req, options?.rawBody ?? false)
        try {
          for (const mw of this.#middlewares) {
            const out = await mw(ctx)
            if (out) {
              return this.#applyEnvelope(reply, out)
            }
          }
          const envelope = await handler(ctx)
          return this.#applyEnvelope(reply, envelope)
        } catch (err) {
          return this.#applyEnvelope(reply, this.#renderError(err, ctx))
        }
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
        reply.raw.writeHead(200, {
          ...this.#defaultHeaders,
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        reply.hijack()
        const closeCallbacks: Array<() => void> = []
        let closed = false
        const close = (): void => {
          if (closed) return
          closed = true
          try {
            reply.raw.end()
          } catch {
            // ignore
          }
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
        const stream: StreamContext = {
          send(event: SseEvent): void {
            if (closed) return
            let line = ''
            if (event.id !== undefined) line += `id: ${event.id}\n`
            if (event.event !== undefined) line += `event: ${event.event}\n`
            const data =
              typeof event.data === 'string' ? event.data : JSON.stringify(event.data)
            line += `data: ${data}\n\n`
            reply.raw.write(line)
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

  #buildContext(req: FastifyRequest, includeRawBody: boolean): RequestContext {
    const correlationId =
      (req.headers['x-correlation-id'] as string | undefined) ?? req.id
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
