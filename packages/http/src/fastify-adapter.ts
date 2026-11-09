import Fastify, {
  errorCodes,
  type FastifyInstance,
  type InjectOptions,
  type LightMyRequestResponse,
  type FastifyPluginAsync,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { createHash, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import fastifyCookie from '@fastify/cookie'
import fastifyCors from '@fastify/cors'
import proxyAddr from '@fastify/proxy-addr'
import { v7 as uuidv7 } from 'uuid'
import type {
  HttpAdapter,
  HttpMethod,
  Logger,
  MiddlewareHandler,
  RequestContext,
  ResolvedOriginLock,
  ResponseEnvelope,
  RouteHandler,
  RouteOptions,
  SseEvent,
  StreamContext,
  StreamHandler,
} from '@nymbalhq/types'
import {
  CORRELATION_ID_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  HttpError,
  isValidCorrelationId,
  NymbalError,
} from '@nymbalhq/types'
import { TRUSTED_PROXIES_ENV, trustSuggestion, type NymbalConfig } from '@nymbalhq/config'
import { createSecurityGuard, type SecurityGuard } from './security-middleware.js'
import { createShopperAttestation, type ShopperAttestation } from './shopper-attestation.js'

export interface CorsOptions {
  allowedOrigins: string[]
  /** Origins answered, with credentials, on `KIT_ROUTES` alone; `allowedOrigins` wins for an origin on both. */
  kitOrigins?: string[]
  credentials: boolean
}

const KIT_ROUTES = /^\/api\/(?:csrf|capabilities|alerts\/subscribe|cart(?:\/.*)?)$/

function isKitRoute(url: string): boolean {
  return KIT_ROUTES.test(url.split('?', 1)[0] ?? '')
}

export interface FastifyAdapterOptions {
  logger: Logger
  /** The guard every route passes before its middlewares and handler: rate limit, then CSRF on unsafe methods. */
  security: NymbalConfig['security']
  /**
   * The proxies whose `X-Forwarded-For` sets the client address, walked from the socket peer while each hop is listed:
   * `loopback`, `linklocal`, `uniquelocal`, addresses and CIDRs. Default `['loopback']`. The first request from an
   * unlisted peer that carries a forwarded address logs a warning naming the peer.
   */
  trustedProxies?: string[]
  /**
   * One header a listed proxy sets to the client's address; when set, it decides in place of `X-Forwarded-For`, and
   * only when it holds exactly one IP address.
   */
  clientIpHeader?: string
  /**
   * Whether the header counts only on a locked request (one carrying the origin secret), from any peer, and on no
   * other; when false it counts from a listed peer.
   */
  clientIpRequiresLock?: boolean
  /**
   * The origin lock: a request from another machine that does not carry one of the secrets in the header is refused
   * 403 `origin_locked` before anything else sees it, bar the routes `/health` and `/ready`.
   */
  originLock?: ResolvedOriginLock
  /**
   * The header the CDN sends the origin secret in, removed from every request whether or not the lock is on: an edge
   * that sends it to a host without the variable must not hand it to handlers or the storefront.
   */
  originLockHeader?: string
  cors?: CorsOptions
  /** Whether the CSRF cookie carries `Secure`: `secureCookies(config, env)`. */
  secureCookies?: boolean
}

/** How long a stream ended at shutdown may take to flush before its socket is destroyed regardless. */
const STREAM_END_BOUND_MS = 500

/** The platform's health checks reach the API directly, never through the CDN. */
const UNLOCKED_ROUTES = new Set(['/health', '/ready'])
const isLoopback = proxyAddr.compile('loopback')

/** A fixed-length digest, so comparing it takes the same time whatever the length or content of the value sent. */
const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

export class FastifyHttpAdapter implements HttpAdapter {
  readonly #app: FastifyInstance
  readonly #logger: Logger
  readonly #guard: SecurityGuard
  readonly #attestation: ShopperAttestation = createShopperAttestation()
  readonly #middlewares: MiddlewareHandler[] = []
  readonly #defaultHeaders: Record<string, string> = {}
  /** Ends each open stream for shutdown; a stream removes itself once its close callbacks have run. */
  readonly #openStreams = new Set<() => void>()
  #started = false
  #stopping = false
  #boundPort = 0
  /** Decides both Fastify's walk of X-Forwarded-For and whether the peer may speak for the client. */
  readonly #trusts: (address: string, hop: number) => boolean
  /** Lower-cased, as Node keys request headers. */
  readonly #clientIpHeader: string | undefined
  readonly clientIpRequiresLock: boolean
  /** Lower-cased, as Node keys request headers. */
  readonly #lockHeader: string | undefined
  readonly #lockDigests: readonly Buffer[]
  /** Lower-cased: every header the secret may arrive in, removed from each request. */
  readonly #proofHeaders: readonly string[]
  #warnedUnlistedPeer = false
  #warnedClientIpHeader = false
  #warnedOriginLocked = false

  constructor(options: FastifyAdapterOptions) {
    this.#logger = options.logger
    this.#trusts = proxyAddr.compile(options.trustedProxies ?? ['loopback'])
    this.#clientIpHeader = options.clientIpHeader?.toLowerCase()
    this.clientIpRequiresLock = options.clientIpRequiresLock ?? false
    this.#lockHeader = options.originLock?.header.toLowerCase()
    this.#lockDigests = (options.originLock?.secrets ?? []).map(digest)
    this.#proofHeaders = [
      ...new Set(
        [options.originLockHeader?.toLowerCase(), this.#lockHeader].filter(
          (h): h is string => h !== undefined,
        ),
      ),
    ]
    this.#guard = createSecurityGuard(options.security, {
      attestation: this.#attestation,
      secureCookies: options.secureCookies ?? false,
    })
    this.#app = Fastify({
      logger: false,
      trustProxy: this.#trusts,
      disableRequestLogging: true,
      // Fastify's default takes `req.id` from an inbound `request-id` header, unvalidated; the id is always ours.
      requestIdHeader: false,
      genReqId: () => uuidv7(),
    })
    // Hooks rather than #buildContext and #applyEnvelope: Fastify's own 404 and body-parse 400 never reach a route
    // handler, and they carry the id too.
    this.#app.decorateRequest('correlationId', '')
    this.#app.decorateRequest('clientIp', '')
    this.#app.addHook('onRequest', async (req, reply) => {
      const inbound = req.headers[CORRELATION_ID_HEADER]
      if (typeof inbound === 'string' && isValidCorrelationId(inbound)) req.correlationId = inbound
      else req.correlationId = isValidCorrelationId(req.id) ? req.id : uuidv7()
      const locked = this.#takeOriginProof(req)
      if (!locked && this.#refusesUnlocked(req)) {
        req.clientIp = req.raw.socket.remoteAddress ?? req.ip
        return this.#refuseOrigin(req, reply)
      }
      req.clientIp = this.#resolveClientIp(req, locked)
    })
    this.#app.addHook('onSend', async (req, reply, payload) => {
      reply.header(CORRELATION_ID_HEADER, req.correlationId)
      // An API answer that chooses no caching of its own is shopper state: a disk-cached cart would come back on Back.
      if (req.url.startsWith('/api/') && !reply.hasHeader('cache-control')) {
        reply.header('cache-control', 'no-store')
      }
      return payload
    })
    // A signed webhook is verified against the bytes sent, so a route registered with `rawBody` keeps them. The
    // body is still parsed by Fastify's own JSON parser, with its poisoning settings and its 400s.
    const parseJson = this.#app.getDefaultJsonParser(
      this.#app.initialConfig.onProtoPoisoning ?? 'error',
      this.#app.initialConfig.onConstructorPoisoning ?? 'error',
    )
    const takesRawBody = (req: FastifyRequest): boolean =>
      (req.routeOptions.config as { routeOptions?: RouteOptions } | undefined)?.routeOptions
        ?.rawBody === true
    this.#app.removeContentTypeParser('application/json')
    this.#app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      const buffer = body as Buffer
      if (takesRawBody(req)) req.rawBody = buffer
      parseJson(req, buffer.toString('utf8'), done)
    })
    // Providers also post form-encoded, plain-text and other bodies, signing those bytes too, so a `rawBody` route
    // takes every type, its body the UTF-8 text. Every other route answers as Fastify does by default: `text/plain` as
    // a string, anything else (a bodied request with no Content-Type included) 415, and an unknown URL its 404.
    const keepRawBody =
      (elsewhere: 'text' | 'refuse') =>
      (
        req: FastifyRequest,
        body: string | Buffer,
        done: (err: Error | null, body?: unknown) => void,
      ) => {
        const buffer = body as Buffer
        if (takesRawBody(req)) req.rawBody = buffer
        else if (elsewhere === 'refuse' && !req.is404) {
          done(new errorCodes.FST_ERR_CTP_INVALID_MEDIA_TYPE(req.headers['content-type']))
          return
        }
        done(null, buffer.toString('utf8'))
      }
    this.#app.removeContentTypeParser('text/plain')
    this.#app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, keepRawBody('text'))
    this.#app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'buffer' },
      keepRawBody('refuse'),
    )
    this.#app.addContentTypeParser('*', { parseAs: 'buffer' }, keepRawBody('refuse'))
    // Fastify's `close()` waits for every open connection, and a stream never ends by itself. `preClose` runs after
    // Fastify answers new requests 503 and before `server.close()`, so no stream can hold the close once it has run.
    this.#app.addHook('preClose', async () => {
      this.#stopping = true
      for (const endStream of this.#openStreams) endStream()
    })
    void this.#app.register(fastifyCookie)
    if (options.cors) this.#registerCors(options.cors)
    // The token a client on another origin of the same site echoes in `x-csrf-token`: it cannot read this cookie.
    this.registerRoute('GET', '/api/csrf', (ctx) => this.#guard.issueToken(ctx))
  }

  #registerCors({ allowedOrigins, kitOrigins = [], credentials }: CorsOptions): void {
    if (allowedOrigins.length === 0 && kitOrigins.length === 0) return
    const shared = {
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      // A browser client on an allowed origin reads the request's id and whether a keyed write was a replay.
      exposedHeaders: [CORRELATION_ID_HEADER, IDEMPOTENT_REPLAYED_HEADER],
    }
    const standard = {
      ...shared,
      credentials,
      origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    }
    const kit = { ...shared, credentials: true, origin: kitOrigins }
    // `origin: false` rather than a list without it: the plugin sends Allow-Credentials to any origin a list refuses.
    const refused = { ...shared, credentials: false, origin: false }
    void this.#app.register(fastifyCors, {
      delegator: (req, callback) => {
        const origin = req.headers.origin ?? ''
        if (!kitOrigins.includes(origin) || allowedOrigins.includes(origin)) {
          callback(null, standard)
        } else {
          callback(null, isKitRoute(req.url) ? kit : refused)
        }
      },
    })
  }

  get boundPort(): number {
    return this.#boundPort
  }

  /**
   * A token for `ip` that this adapter's guard, and no other, accepts in `x-nymbal-shopper` for the next minute: the
   * storefront forward's proof of the shopper's address.
   */
  attestShopper(ip: string): string {
    return this.#attestation.mint(ip)
  }

  /** Fastify's `inject`: `remoteAddress` sets the socket peer, which a request from loopback cannot. */
  inject(options: InjectOptions): Promise<LightMyRequestResponse> {
    return this.#app.inject(options)
  }

  /** The guard every route passes, for a mounted handler that admits a request it serves on a route's behalf. */
  get guard(): SecurityGuard {
    return this.#guard
  }

  /**
   * A route whose handler answers a web-standard `Response` (the MCP endpoint's SDK), or an envelope when it refuses.
   * It passes the guard and the middlewares as every route does.
   */
  registerWebRoute(
    method: HttpMethod,
    path: string,
    handler: (ctx: RequestContext) => Promise<Response | ResponseEnvelope>,
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
        let answer: Response | ResponseEnvelope
        try {
          answer = await this.#runMiddlewaresThen(ctx, handler)
        } catch (err) {
          answer = this.#renderError(err, ctx)
        }
        if (!(answer instanceof Response)) {
          return this.#applyEnvelope(reply, this.#guard.finish(ctx, answer))
        }
        const { headers } = this.#guard.finish(ctx, { status: answer.status })
        for (const [name, value] of Object.entries({ ...this.#defaultHeaders, ...headers })) {
          reply.header(name, value)
        }
        return reply.send(answer)
      },
      config: { routeOptions: options ?? {} },
    })
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
        // A hijacked reply skips onSend.
        raw.writeHead(200, {
          ...this.#defaultHeaders,
          [CORRELATION_ID_HEADER]: ctx.correlationId,
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

  /** A Fastify plugin on this server, in a context of its own: how the storefront forward is added. */
  registerPlugin(plugin: FastifyPluginAsync): void {
    if (this.#started) {
      throw new Error('Cannot register plugins after the server has started')
    }
    void this.#app.register(plugin)
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
    this.#logger.debug({ port: this.#boundPort, host }, 'HTTP server listening')
  }

  async stop(): Promise<void> {
    if (!this.#started) return
    await this.#app.close()
    this.#started = false
  }

  async #runMiddlewaresThen<T extends Response | ResponseEnvelope>(
    ctx: RequestContext,
    handler: (ctx: RequestContext) => Promise<T> | T,
  ): Promise<T | ResponseEnvelope> {
    for (const mw of this.#middlewares) {
      const out = await mw(ctx)
      if (out) return out
    }
    return handler(ctx)
  }

  /**
   * Whether the request carries one of the origin secrets, compared by digest against every entry. The header is
   * removed whatever the outcome and with the lock off too, so no handler, log line or storefront forward sees it.
   */
  #takeOriginProof(req: FastifyRequest): boolean {
    const name = this.#lockHeader
    const sent = name === undefined ? undefined : req.headers[name]
    for (const header of this.#proofHeaders) delete req.headers[header]
    if (typeof sent !== 'string') return false
    const given = digest(sent)
    let matched = false
    for (const entry of this.#lockDigests) matched = timingSafeEqual(given, entry) || matched
    return matched
  }

  /** An unlocked request is refused unless the lock is off, it comes from this machine, or it is a health check. */
  #refusesUnlocked(req: FastifyRequest): boolean {
    if (this.#lockHeader === undefined) return false
    const peer = req.raw.socket.remoteAddress
    if (peer !== undefined && isLoopback(peer, 0)) return false
    return req.is404 || !UNLOCKED_ROUTES.has(req.routeOptions.url ?? '')
  }

  #refuseOrigin(req: FastifyRequest, reply: FastifyReply): FastifyReply {
    if (!this.#warnedOriginLocked) {
      this.#warnedOriginLocked = true
      const peer = req.raw.socket.remoteAddress ?? req.ip
      const header = this.#lockHeader!
      this.#requestLogger(req).warn(
        { peer, header },
        `A request from ${peer} without the origin secret in ${header} was refused: requests must cross the CDN. If the CDN does send it, check it holds an entry of NYMBAL_ORIGIN_SECRET (nymbal doctor); later refusals are not logged`,
      )
    }
    return this.#applyEnvelope(reply, {
      status: 403,
      body: {
        error: {
          code: 'origin_locked',
          message: 'This API answers only requests that reach it through the store’s CDN',
        },
      },
    })
  }

  /**
   * The one client address a request resolves to. An unlisted peer is the client, whatever it sends. From a listed peer,
   * the client-address header when one is configured (a single IP address, else the peer), otherwise X-Forwarded-For
   * walked by Fastify with the same list. A header that requires the lock counts on a locked request from any peer and
   * is not read on any other.
   */
  #resolveClientIp(req: FastifyRequest, locked: boolean): string {
    const peer = req.raw.socket.remoteAddress
    if (peer === undefined) return req.ip
    const header = this.clientIpRequiresLock && !locked ? undefined : this.#clientIpHeader
    const fromAnyPeer = this.clientIpRequiresLock && header !== undefined
    if (!fromAnyPeer && !this.#trusts(peer, 0)) {
      const carried =
        req.headers['x-forwarded-for'] !== undefined
          ? 'x-forwarded-for'
          : header !== undefined && req.headers[header] !== undefined
            ? header
            : undefined
      if (carried !== undefined && !this.#warnedUnlistedPeer) {
        this.#warnedUnlistedPeer = true
        const suggested = trustSuggestion(peer)
        this.#requestLogger(req).warn(
          { peer, header: carried, variable: TRUSTED_PROXIES_ENV, suggested },
          `${carried} from ${peer} is ignored: ${peer} is not a listed proxy, so it is the client address. If ${peer} is your proxy, set ${TRUSTED_PROXIES_ENV}=${suggested}`,
        )
      }
      return peer
    }
    if (header === undefined) return req.ip
    const value = req.headers[header]
    if (value === undefined) return peer
    if (typeof value === 'string' && !value.includes(',') && isIP(value) !== 0) return value
    const reason = typeof value !== 'string' || value.includes(',') ? 'multiple' : 'invalid'
    if (!this.#warnedClientIpHeader) {
      this.#warnedClientIpHeader = true
      this.#requestLogger(req).warn(
        { peer, header, reason },
        `${header} from ${peer} does not hold one IP address (${reason}), so the address is the peer; the proxy should set it to the client's address alone`,
      )
    }
    return peer
  }

  #requestLogger(req: FastifyRequest): Logger {
    return this.#logger.child({ requestId: req.id, correlationId: req.correlationId })
  }

  #buildContext(req: FastifyRequest, includeRawBody: boolean): RequestContext {
    const { correlationId } = req
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
      ip: req.clientIp,
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
    /** Set by the onRequest hook before anything else runs. */
    correlationId: string
    /** The client address the request resolves to, set by the onRequest hook: what every reader of the address uses. */
    clientIp: string
  }
}
