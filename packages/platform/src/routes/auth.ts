import {
  AuthError,
  type HttpAdapter,
  type ResponseEnvelope,
  type ResponseCookie,
} from '@nymbal/types'
import type { AuthService } from '../services/auth-service.js'
import { ok, fail, renderError } from './envelope.js'

interface RegisterBody {
  email?: string
  password?: string
  firstName?: string
  lastName?: string
  phone?: string
}
interface LoginBody {
  email?: string
  password?: string
}
interface RefreshBody {
  refreshToken?: string
}

const REFRESH_COOKIE = 'nymbal.refresh'

function refreshCookies(token: string, maxAgeSeconds: number): ResponseCookie[] {
  return [
    {
      name: REFRESH_COOKIE,
      value: token,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: maxAgeSeconds,
    },
  ]
}

function expiredCookies(): ResponseCookie[] {
  return [{ name: REFRESH_COOKIE, value: '', path: '/', maxAge: 0, httpOnly: true }]
}

export function registerAuthRoutes(adapter: HttpAdapter, auth: AuthService): void {
  adapter.registerRoute('POST', '/api/auth/register', async (ctx) => {
    try {
      const body = ctx.body as RegisterBody | undefined
      if (!body?.email || !body.password) {
        return fail('auth.invalid_input', 'email and password are required', 400)
      }
      const registerInput: Parameters<AuthService['register']>[0] = {
        email: body.email,
        password: body.password,
        ...(body.firstName !== undefined && { firstName: body.firstName }),
        ...(body.lastName !== undefined && { lastName: body.lastName }),
        ...(body.phone !== undefined && { phone: body.phone }),
      }
      const result = await auth.register(registerInput)
      const envelope = ok(
        { customer: result.customer, accessToken: result.tokens.accessToken, expiresIn: result.tokens.expiresIn },
        undefined,
        201,
      )
      envelope.cookies = refreshCookies(result.tokens.refreshToken, 60 * 60 * 24 * 7)
      return envelope as ResponseEnvelope
    } catch (err) {
      return renderError(err)
    }
  })

  adapter.registerRoute('POST', '/api/auth/login', async (ctx) => {
    try {
      const body = ctx.body as LoginBody | undefined
      if (!body?.email || !body.password) {
        return fail('auth.invalid_input', 'email and password are required', 400)
      }
      const result = await auth.login(body.email, body.password)
      const envelope = ok({
        customer: result.customer,
        accessToken: result.tokens.accessToken,
        expiresIn: result.tokens.expiresIn,
      })
      envelope.cookies = refreshCookies(result.tokens.refreshToken, 60 * 60 * 24 * 7)
      return envelope as ResponseEnvelope
    } catch (err) {
      return renderError(err)
    }
  })

  adapter.registerRoute('POST', '/api/auth/refresh', async (ctx) => {
    try {
      const body = ctx.body as RefreshBody | undefined
      const refreshToken = body?.refreshToken ?? ctx.cookies[REFRESH_COOKIE]
      if (!refreshToken) throw new AuthError('token_invalid', 'refresh token missing')
      const tokens = await auth.refresh(refreshToken)
      const envelope = ok({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn })
      envelope.cookies = refreshCookies(tokens.refreshToken, 60 * 60 * 24 * 7)
      return envelope as ResponseEnvelope
    } catch (err) {
      return renderError(err)
    }
  })

  adapter.registerRoute('POST', '/api/auth/logout', async (ctx) => {
    try {
      const refreshToken =
        (ctx.body as RefreshBody | undefined)?.refreshToken ?? ctx.cookies[REFRESH_COOKIE]
      if (refreshToken) await auth.logout(refreshToken)
      const envelope = ok({ ok: true })
      envelope.cookies = expiredCookies()
      return envelope as ResponseEnvelope
    } catch (err) {
      return renderError(err)
    }
  })
}
