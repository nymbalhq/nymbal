export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/** The request header a caller may name its own correlation id in, and the response header that echoes the one used. */
export const CORRELATION_ID_HEADER = 'x-correlation-id'

const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/

/**
 * Whether `s` may be used as a correlation id: it reaches logs and the event log, so an inbound value that fails is
 * replaced, never cleaned. The id is a label only; nothing reads it to decide access.
 */
export function isValidCorrelationId(s: string): boolean {
  return CORRELATION_ID.test(s)
}

export interface RequestAuth {
  userId?: string
  roles?: string[]
  token?: string
}

export interface Logger {
  trace(obj: unknown, msg?: string): void
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
  child(bindings: Record<string, unknown>): Logger
}

export interface RequestContext<TBody = unknown, TQuery = Record<string, string | string[] | undefined>, TParams = Record<string, string>> {
  method: HttpMethod
  path: string
  url: string
  params: TParams
  query: TQuery
  body: TBody
  rawBody?: Buffer
  headers: Record<string, string | string[] | undefined>
  cookies: Record<string, string>
  auth?: RequestAuth
  requestId: string
  /** The inbound `x-correlation-id` when `isValidCorrelationId` accepts it, else the request id. */
  correlationId: string
  logger: Logger
  ip: string
}

export interface ResponseCookie {
  name: string
  value: string
  path?: string
  domain?: string
  maxAge?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'strict' | 'lax' | 'none'
}

export interface ResponseEnvelope<T = unknown> {
  status: number
  headers?: Record<string, string>
  body?: T
  cookies?: ResponseCookie[]
}

export type RouteHandler<TBody = unknown, TQuery = Record<string, string | string[] | undefined>, TParams = Record<string, string>, TResponse = unknown> = (
  ctx: RequestContext<TBody, TQuery, TParams>,
) => Promise<ResponseEnvelope<TResponse>> | ResponseEnvelope<TResponse>

export interface RouteOptions {
  name?: string
  csrf?: boolean
  rateLimit?: string
  rawBody?: boolean
}

export type MiddlewareHandler = (
  ctx: RequestContext,
) => Promise<ResponseEnvelope | void> | ResponseEnvelope | void

export interface SseEvent {
  id?: string
  event?: string
  data: unknown
}

export interface StreamContext {
  send(event: SseEvent): void
  close(): void
  onClose(callback: () => void): void
}

export type StreamHandler = (
  ctx: RequestContext,
  stream: StreamContext,
) => Promise<void> | void

export interface HttpAdapter {
  registerRoute(
    method: HttpMethod,
    path: string,
    handler: RouteHandler,
    options?: RouteOptions,
  ): void
  registerStreamRoute(
    method: 'GET',
    path: string,
    handler: StreamHandler,
    options?: RouteOptions,
  ): void
  registerMiddleware(middleware: MiddlewareHandler): void
  setDefaultHeaders(headers: Record<string, string>): void
  start(port: number, host?: string): Promise<void>
  stop(): Promise<void>
}
