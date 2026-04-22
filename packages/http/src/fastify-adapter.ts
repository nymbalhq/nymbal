import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyCookie from '@fastify/cookie'
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
} from '@nymbal/types'
import { HttpError, NymbalError } from '@nymbal/types'

export interface FastifyAdapterOptions {
  logger: Logger
  trustProxy?: boolean
}

export class FastifyHttpAdapter implements HttpAdapter {
  readonly #app: FastifyInstance
  readonly #logger: Logger
  readonly #middlewares: MiddlewareHandler[] = []
  #started = false

  constructor(options: FastifyAdapterOptions) {
    this.#logger = options.logger
    this.#app = Fastify({
      logger: false,
      trustProxy: options.trustProxy ?? true,
      disableRequestLogging: true,
      genReqId: () => uuidv7(),
    })
    void this.#app.register(fastifyCookie)
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
    this.#app.route({
      method,
      url: path,
      handler: async (req, reply) => {
        const ctx = this.#buildContext(req)
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
    })
  }

  registerMiddleware(middleware: MiddlewareHandler): void {
    if (this.#started) {
      throw new Error('Cannot register middleware after the server has started')
    }
    this.#middlewares.push(middleware)
  }

  async start(port: number, host = '0.0.0.0'): Promise<void> {
    await this.#app.listen({ port, host })
    this.#started = true
    this.#logger.info({ port, host }, 'HTTP server listening')
  }

  async stop(): Promise<void> {
    if (!this.#started) return
    await this.#app.close()
    this.#started = false
  }

  #buildContext(req: FastifyRequest): RequestContext {
    const correlationId =
      (req.headers['x-correlation-id'] as string | undefined) ?? req.id
    const logger = this.#logger.child({ requestId: req.id, correlationId })
    return {
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
  }

  #applyEnvelope(reply: FastifyReply, envelope: ResponseEnvelope): FastifyReply {
    reply.status(envelope.status)
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
