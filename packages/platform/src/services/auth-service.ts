import { v7 as uuidv7 } from 'uuid'
import bcrypt from 'bcryptjs'
const { hash: bcryptHash, compare: bcryptCompare } = bcrypt
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { createHash } from 'node:crypto'
import {
  AuthError,
  EVT_CUSTOMER_CREATED,
  ValidationError,
  type Customer,
  type CustomerAddress,
  type Logger,
  type Role,
} from '@nymbal/types'
import type { Repositories } from '../repositories/index.js'
import type { EventPublisher } from '../events/publisher.js'

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export interface RegisterInput {
  email: string
  password: string
  firstName?: string
  lastName?: string
  phone?: string
}

export interface CustomerJwtPayload extends JWTPayload {
  sub: string
  email: string
  roles: Role[]
  type: 'access' | 'refresh'
  jti?: string
}

export interface ImportCustomerInput {
  email: string
  firstName?: string
  lastName?: string
  phone?: string
  addresses?: CustomerAddress[]
  metadata?: Record<string, unknown>
}

export interface AuthService {
  register(input: RegisterInput): Promise<{ customer: Customer; tokens: AuthTokens }>
  login(email: string, password: string): Promise<{ customer: Customer; tokens: AuthTokens }>
  refresh(refreshToken: string): Promise<AuthTokens>
  logout(refreshToken: string): Promise<void>
  verifyAccessToken(token: string): Promise<CustomerJwtPayload>
  importCustomer(input: ImportCustomerInput): Promise<Customer>
}

export interface CreateAuthServiceDeps {
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
  jwtSecret: string
  accessTtl: string
  refreshTtl: string
  issuer?: string
}

function parseDurationToMs(s: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(s)
  if (!match) throw new ValidationError(`invalid duration: ${s}`)
  const qty = Number(match[1])
  switch (match[2]) {
    case 'ms':
      return qty
    case 's':
      return qty * 1000
    case 'm':
      return qty * 60 * 1000
    case 'h':
      return qty * 60 * 60 * 1000
    case 'd':
      return qty * 24 * 60 * 60 * 1000
    default:
      throw new ValidationError(`invalid duration unit: ${match[2]}`)
  }
}

function hashRefresh(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function stripPassword(c: Customer & { passwordHash: string }): Customer {
  const { passwordHash: _pw, ...rest } = c
  return rest
}

export function createAuthService(deps: CreateAuthServiceDeps): AuthService {
  const { repos, publisher, logger, jwtSecret, accessTtl, refreshTtl } = deps
  const issuer = deps.issuer ?? 'nymbal'
  const secretKey = new TextEncoder().encode(jwtSecret)
  const accessTtlMs = parseDurationToMs(accessTtl)
  const refreshTtlMs = parseDurationToMs(refreshTtl)

  async function mintAccess(customer: Customer): Promise<string> {
    const roles: Role[] = (customer.metadata.roles as Role[] | undefined) ?? ['customer']
    return new SignJWT({
      sub: customer.id,
      email: customer.email,
      roles,
      type: 'access',
    } satisfies CustomerJwtPayload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(issuer)
      .setExpirationTime(new Date(Date.now() + accessTtlMs))
      .sign(secretKey)
  }

  async function mintRefresh(customer: Customer, jti: string): Promise<string> {
    return new SignJWT({
      sub: customer.id,
      email: customer.email,
      roles: ['customer'],
      type: 'refresh',
      jti,
    } satisfies CustomerJwtPayload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setJti(jti)
      .setIssuer(issuer)
      .setExpirationTime(new Date(Date.now() + refreshTtlMs))
      .sign(secretKey)
  }

  async function issueTokens(customer: Customer): Promise<AuthTokens> {
    const jti = uuidv7()
    const refreshToken = await mintRefresh(customer, jti)
    await repos.refreshToken.insert({
      id: jti,
      customerId: customer.id,
      tokenHash: hashRefresh(refreshToken),
      expiresAt: new Date(Date.now() + refreshTtlMs),
      createdAt: new Date(),
    })
    const accessToken = await mintAccess(customer)
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessTtlMs / 1000),
    }
  }

  return {
    async register(input) {
      if (!input.email.includes('@')) throw new ValidationError('invalid email')
      if (input.password.length < 8) throw new ValidationError('password must be ≥ 8 characters')
      const email = input.email.toLowerCase()
      const existing = await repos.customer.findByEmail(email)
      if (existing) {
        throw new AuthError('invalid_credentials', 'An account with this email already exists')
      }
      const id = uuidv7()
      const passwordHash = await bcryptHash(input.password, 10)
      const now = new Date()
      await repos.customer.insert({
        id,
        email,
        passwordHash,
        ...(input.firstName !== undefined && { firstName: input.firstName }),
        ...(input.lastName !== undefined && { lastName: input.lastName }),
        ...(input.phone !== undefined && { phone: input.phone }),
        createdAt: now,
        updatedAt: now,
      })
      const customer = await repos.customer.findById(id)
      if (!customer) throw new Error('customer disappeared after insert')
      const tokens = await issueTokens(customer)
      await publisher.publish(EVT_CUSTOMER_CREATED, { customerId: id, email })
      logger.info({ customerId: id }, 'customer registered')
      return { customer: stripPassword(customer), tokens }
    },

    async login(email, password) {
      const customer = await repos.customer.findByEmail(email.toLowerCase())
      if (!customer) throw new AuthError('invalid_credentials', 'Invalid email or password')
      const ok = await bcryptCompare(password, customer.passwordHash)
      if (!ok) throw new AuthError('invalid_credentials', 'Invalid email or password')
      const tokens = await issueTokens(customer)
      logger.info({ customerId: customer.id }, 'customer login')
      return { customer: stripPassword(customer), tokens }
    },

    async refresh(refreshToken) {
      let verified
      try {
        verified = await jwtVerify(refreshToken, secretKey, { issuer })
      } catch {
        throw new AuthError('token_invalid', 'refresh token invalid')
      }
      const payload = verified.payload as CustomerJwtPayload
      if (payload.type !== 'refresh' || !payload.jti || !payload.sub) {
        throw new AuthError('token_invalid', 'not a refresh token')
      }
      const record = await repos.refreshToken.findById(payload.jti)
      if (!record) throw new AuthError('token_invalid', 'refresh token unknown')
      if (record.revokedAt) throw new AuthError('token_invalid', 'refresh token revoked')
      if (record.tokenHash !== hashRefresh(refreshToken)) {
        // A mismatch means replay with an older token — revoke chain.
        await repos.refreshToken.revokeAllForCustomer(payload.sub)
        throw new AuthError('token_invalid', 'refresh token mismatch; revoking chain')
      }
      const customer = await repos.customer.findById(payload.sub)
      if (!customer) throw new AuthError('token_invalid', 'customer missing')
      const nextJti = uuidv7()
      const nextRefresh = await mintRefresh(customer, nextJti)
      await repos.refreshToken.rotate(payload.jti, {
        id: nextJti,
        customerId: customer.id,
        tokenHash: hashRefresh(nextRefresh),
        expiresAt: new Date(Date.now() + refreshTtlMs),
        createdAt: new Date(),
      })
      const accessToken = await mintAccess(customer)
      return {
        accessToken,
        refreshToken: nextRefresh,
        expiresIn: Math.floor(accessTtlMs / 1000),
      }
    },

    async logout(refreshToken) {
      try {
        const verified = await jwtVerify(refreshToken, secretKey, { issuer })
        const payload = verified.payload as CustomerJwtPayload
        if (payload.jti) await repos.refreshToken.revoke(payload.jti)
      } catch {
        // ignore — already invalid
      }
    },

    async verifyAccessToken(token) {
      try {
        const verified = await jwtVerify(token, secretKey, { issuer })
        const payload = verified.payload as CustomerJwtPayload
        if (payload.type !== 'access') throw new AuthError('token_invalid', 'not an access token')
        return payload
      } catch (err) {
        if (err instanceof AuthError) throw err
        throw new AuthError('token_invalid', 'access token invalid', { cause: err })
      }
    },

    async importCustomer(input) {
      if (!input.email.includes('@')) throw new ValidationError('invalid email')
      const email = input.email.toLowerCase()
      const existing = await repos.customer.findByEmail(email)
      if (existing) return stripPassword(existing)
      const id = uuidv7()
      const now = new Date()
      await repos.customer.insert({
        id,
        email,
        passwordHash: 'IMPORTED_NO_PASSWORD',
        requiresPasswordReset: true,
        ...(input.firstName !== undefined && { firstName: input.firstName }),
        ...(input.lastName !== undefined && { lastName: input.lastName }),
        ...(input.phone !== undefined && { phone: input.phone }),
        ...(input.addresses !== undefined && { addresses: input.addresses }),
        ...(input.metadata !== undefined && { metadata: input.metadata }),
        createdAt: now,
        updatedAt: now,
      })
      const customer = await repos.customer.findById(id)
      if (!customer) throw new Error('customer disappeared after insert')
      await publisher.publish(EVT_CUSTOMER_CREATED, { customerId: id, email })
      logger.info({ customerId: id }, 'customer imported')
      return stripPassword(customer)
    },
  }
}
