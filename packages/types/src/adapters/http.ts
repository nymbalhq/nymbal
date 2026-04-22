export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

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
  headers: Record<string, string | string[] | undefined>
  cookies: Record<string, string>
  auth?: RequestAuth
  requestId: string
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
}

export type MiddlewareHandler = (
  ctx: RequestContext,
) => Promise<ResponseEnvelope | void> | ResponseEnvelope | void

export interface HttpAdapter {
  registerRoute(
    method: HttpMethod,
    path: string,
    handler: RouteHandler,
    options?: RouteOptions,
  ): void
  registerMiddleware(middleware: MiddlewareHandler): void
  start(port: number, host?: string): Promise<void>
  stop(): Promise<void>
}
