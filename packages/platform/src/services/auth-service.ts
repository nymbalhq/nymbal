import { v7 as uuidv7 } from 'uuid'
import bcrypt from 'bcryptjs'
const { hash: bcryptHash, compare: bcryptCompare } = bcrypt
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { createHash } from 'node:crypto'
import {
  AuthError,
  EVT_CUSTOMER_CREATED,
  EVT_CUSTOMER_PASSWORD_RESET_REQUESTED,
  EVT_CUSTOMER_REGISTERED_AGAIN,
  EVT_CUSTOMER_UPDATED,
  EVT_CUSTOMER_VERIFICATION_REQUESTED,
  HttpError,
  ValidationError,
  type Customer,
  type CustomerAddress,
  type Logger,
  type Role,
} from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type { Tx } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import type { CustomerWithHash } from '../repositories/customer.js'
import type { EventPublisher } from '../events/publisher.js'
import { toCustomerSnapshot } from '../history/views.js'

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

export type VerificationPolicy = 'required' | 'off'

export interface AuthService {
  /** The sign-up policy the store runs: `required` asks a new address to follow a mailed link before it signs in. */
  readonly verification: VerificationPolicy
  /** The `off` policy's sign-up: a new address signs in at once; a taken one is refused. */
  register(input: RegisterInput): Promise<{ customer: Customer; tokens: AuthTokens }>
  /**
   * The `required` policy's sign-up, alike for every address: a new one gets a pending account and a confirmation
   * link, a pending one takes this register's password and names, and any other account's owner is told by mail.
   */
  signUp(input: RegisterInput): Promise<void>
  /** Confirms the address with a mailed link's token, once, and signs the customer in. */
  verifyEmail(token: string): Promise<{ customer: Customer; tokens: AuthTokens }>
  /** Mails a pending account's link again; any other address gets the same silence. */
  resendVerification(email: string): Promise<void>
  /** Support's send: a new link for a pending customer, whatever the age of the live one. */
  sendVerification(customerId: string): Promise<void>
  /** Support's confirm: a pending customer becomes verified; any other is answered as it is. */
  markVerified(customerId: string): Promise<Customer>
  login(email: string, password: string): Promise<{ customer: Customer; tokens: AuthTokens }>
  refresh(refreshToken: string): Promise<AuthTokens>
  logout(refreshToken: string): Promise<void>
  verifyAccessToken(token: string): Promise<CustomerJwtPayload>
  importCustomer(input: ImportCustomerInput): Promise<Customer>
  /** Mails a reset link to a customer with this address; an address with none gets the same silence. */
  requestPasswordReset(email: string): Promise<void>
  /** Sets the password with a mailed link's token, once, ends every earlier session and signs the customer in. */
  resetPassword(
    token: string,
    password: string,
  ): Promise<{ customer: Customer; tokens: AuthTokens }>
  /** Sets a new password given the current one, ends every earlier session and starts a fresh one. */
  changePassword(
    customerId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ customer: Customer; tokens: AuthTokens }>
}

export interface CreateAuthServiceDeps {
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
  jwtSecret: string
  accessTtl: string
  refreshTtl: string
  issuer?: string
  /** `off` when absent. */
  verification?: VerificationPolicy
}

export function parseDurationToMs(s: string): number {
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
    /* c8 ignore next 2 -- regex above only matches ms|s|m|h|d, making this unreachable */
    default:
      throw new ValidationError(`invalid duration unit: ${match[2]}`)
  }
}

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_HASH_ROUNDS = 10

/**
 * A sign-in for an address with no password to check (no customer, or an imported one) compares against this hash, so
 * every sign-in spends one bcrypt round at the store's cost. It is public, so a compare against it never signs in.
 */
export const DUMMY_PASSWORD = 'nymbal-no-account-dummy-password'
export const DUMMY_PASSWORD_HASH = '$2a$10$shMtNq7SQZ.7xjfzjruJBOiZMT6DSloRzH9UxejqCKdO0C6Pl.VkW'

/** What an imported customer holds until they set a password through a reset link. */
const IMPORTED_NO_PASSWORD = 'IMPORTED_NO_PASSWORD'

/** How long a mailed reset link sets a password. */
export const PASSWORD_RESET_TTL_MS = 15 * 60_000

/** How long a mailed confirmation link confirms the address. */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60_000

/** A shopper's register or resend mails a pending account's link again only once the live one is this old. */
export const VERIFICATION_REISSUE_MS = 15 * 60_000

/** The window an account's owner is told at most once in that someone registered their address. */
export const ACCOUNT_EXISTS_WINDOW_MS = 24 * 60 * 60_000

/**
 * How long after its first rotation a refresh token may be rotated again: two tabs restored together present one cookie
 * at once. The window is anchored at that first rotation and never slides.
 */
export const REFRESH_REUSE_WINDOW_MS = 30_000

function hashRefresh(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function checkPasswordLength(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new ValidationError(`password must be ≥ ${PASSWORD_MIN_LENGTH} characters`)
  }
}

/** A 400, not a 401: the SDK answers a 401 with a refresh and a resend. One answer for unknown, used and expired. */
function resetLinkInvalid(): HttpError {
  return new HttpError(400, 'This reset link is no longer valid. Ask for a new one.', {
    code: 'auth.reset_link_invalid',
  })
}

function verifyLinkInvalid(): HttpError {
  return new HttpError(400, 'This confirmation link is no longer valid. Ask for a new one.', {
    code: 'auth.verify_link_invalid',
  })
}

function customerNotFound(customerId: string): HttpError {
  return new HttpError(404, `Customer not found: ${customerId}`, { code: 'customers.not_found' })
}

/** The refusals a register makes before it looks the address up, so they never depend on the account. */
function checkRegisterInput(input: RegisterInput): void {
  if (!input.email.includes('@')) throw new ValidationError('invalid email')
  checkPasswordLength(input.password)
}

function currentPasswordInvalid(): HttpError {
  return new HttpError(400, 'The current password is not correct.', {
    code: 'auth.current_password_invalid',
  })
}

/** Whether the customer holds a password a sign-in can be checked against. */
function hasPassword(customer: CustomerWithHash | null): customer is CustomerWithHash {
  return customer !== null && customer.passwordHash !== IMPORTED_NO_PASSWORD
}

function stripPassword(c: Customer & { passwordHash: string }): Customer {
  const { passwordHash: _pw, ...rest } = c
  return rest
}

export function createAuthService(deps: CreateAuthServiceDeps): AuthService {
  const { repos, publisher, logger, jwtSecret, accessTtl, refreshTtl } = deps
  const verification = deps.verification ?? 'off'
  const { store } = repos.customer
  const issuer = deps.issuer ?? 'nymbal'
  const secretKey = new TextEncoder().encode(jwtSecret)
  const accessTtlMs = parseDurationToMs(accessTtl)
  const refreshTtlMs = parseDurationToMs(refreshTtl)

  /** Its own jti: the other claims are whole seconds, so two minted in one second for one customer would be one. */
  async function mintAccess(customer: CustomerWithHash): Promise<string> {
    return new SignJWT({
      sub: customer.id,
      email: customer.email,
      roles: customer.roles,
      type: 'access',
    } satisfies CustomerJwtPayload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setJti(uuidv7())
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

  async function issueTokens(customer: CustomerWithHash): Promise<AuthTokens> {
    const jti = uuidv7()
    const refreshToken = await mintRefresh(customer, jti)
    await store.transaction((tx) =>
      repos.refreshToken.insert(tx, {
        id: jti,
        customerId: customer.id,
        tokenHash: hashRefresh(refreshToken),
        expiresAt: new Date(Date.now() + refreshTtlMs),
        createdAt: new Date(),
      }),
    )
    const accessToken = await mintAccess(customer)
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessTtlMs / 1000),
    }
  }

  /**
   * Sets the password, takes away every reset link and ends every session, in the caller's transaction; tokens are
   * issued only after it commits, so the revoke cannot reach them.
   */
  async function setPassword(
    tx: Tx,
    customerId: string,
    passwordHash: string,
  ): Promise<CustomerWithHash> {
    const current = await repos.customer.findById(tx, customerId)
    // Removing a customer deletes their reset links in its transaction, so only a change racing a removal gets here.
    /* c8 ignore next */
    if (current === null) throw new AuthError('unauthorized', 'customer missing')
    // A reset link proves the mailbox as a confirmation link does.
    const confirms = current.emailVerification === 'pending'
    await repos.customer.update(tx, customerId, {
      passwordHash,
      requiresPasswordReset: false,
      ...(confirms && { emailVerification: 'verified' as const }),
      updatedAt: new Date(),
    })
    if (confirms) await repos.emailVerificationToken.deleteByCustomer(tx, customerId)
    const fresh = (await repos.customer.findById(tx, customerId))!
    await repos.passwordResetToken.deleteByCustomer(tx, customerId)
    await repos.refreshToken.revokeAllForCustomer(tx, customerId)
    await publisher.publish(EVT_CUSTOMER_UPDATED, {
      customerId,
      customer: toCustomerSnapshot(fresh),
    })
    return fresh
  }

  /** Confirms a pending customer's address and takes away their links, in the caller's transaction. */
  async function confirm(tx: Tx, customerId: string): Promise<CustomerWithHash> {
    await repos.customer.update(tx, customerId, {
      emailVerification: 'verified',
      updatedAt: new Date(),
    })
    await repos.emailVerificationToken.deleteByCustomer(tx, customerId)
    const fresh = (await repos.customer.findById(tx, customerId))!
    await publisher.publish(EVT_CUSTOMER_UPDATED, {
      customerId,
      customer: toCustomerSnapshot(fresh),
    })
    return fresh
  }

  async function existingCustomer(tx: Tx, customerId: string): Promise<CustomerWithHash> {
    const customer = await repos.customer.findById(tx, customerId)
    if (customer === null) throw customerNotFound(customerId)
    return customer
  }

  return {
    verification,

    async register(input) {
      audit.note('customer.register')
      checkRegisterInput(input)
      const email = input.email.toLowerCase()
      const existing = await store.read((tx) => repos.customer.findByEmail(tx, email))
      if (existing) {
        throw new AuthError('invalid_credentials', 'An account with this email already exists')
      }
      const id = uuidv7()
      const passwordHash = await bcryptHash(input.password, PASSWORD_HASH_ROUNDS)
      const now = new Date()
      const customer = await store.transaction(async (tx) => {
        audit.note('customer.register', [{ type: 'customer', id }])
        await repos.customer.insert(tx, {
          id,
          email,
          passwordHash,
          ...(input.firstName !== undefined && { firstName: input.firstName }),
          ...(input.lastName !== undefined && { lastName: input.lastName }),
          ...(input.phone !== undefined && { phone: input.phone }),
          createdAt: now,
          updatedAt: now,
        })
        const inserted = await repos.customer.findById(tx, id)
        /* c8 ignore next -- defensive: customer was inserted in this transaction */
        if (!inserted) throw new Error('customer disappeared after insert')
        await publisher.publish(EVT_CUSTOMER_CREATED, {
          customerId: id,
          email,
          customer: toCustomerSnapshot(inserted),
        })
        return inserted
      })
      const tokens = await issueTokens(customer)
      logger.info({ customerId: id }, 'customer registered')
      return { customer: stripPassword(customer), tokens }
    },

    async signUp(input) {
      audit.note('customer.register')
      checkRegisterInput(input)
      const email = input.email.toLowerCase()
      // Before the lookup and on every path, so the answer's time does not say whether the address has an account.
      const passwordHash = await bcryptHash(input.password, PASSWORD_HASH_ROUNDS)
      const profile = {
        firstName: input.firstName ?? '',
        lastName: input.lastName ?? '',
        phone: input.phone ?? '',
      }
      await store.transaction(async (tx) => {
        const existing = await repos.customer.findByEmail(tx, email)
        if (existing === null) {
          const id = uuidv7()
          audit.note('customer.register', [{ type: 'customer', id }])
          const now = new Date()
          await repos.customer.insert(tx, {
            id,
            email,
            passwordHash,
            ...profile,
            emailVerification: 'pending',
            createdAt: now,
            updatedAt: now,
          })
          const inserted = (await repos.customer.findById(tx, id))!
          await publisher.publish(EVT_CUSTOMER_CREATED, {
            customerId: id,
            email,
            customer: toCustomerSnapshot(inserted),
            verification: 'pending',
          })
          await publisher.publish(EVT_CUSTOMER_VERIFICATION_REQUESTED, {
            customerId: id,
            reissue: 'if-stale',
          })
          return
        }
        audit.note('customer.register', [{ type: 'customer', id: existing.id }])
        if (existing.emailVerification !== 'pending') {
          // A confirmed, never-asked or imported account is never written: its owner is told instead.
          await publisher.publish(EVT_CUSTOMER_REGISTERED_AGAIN, { customerId: existing.id })
          return
        }
        // Nobody has proved this mailbox yet, so whoever follows the link holds the password typed last.
        await repos.customer.update(tx, existing.id, {
          passwordHash,
          ...profile,
          updatedAt: new Date(),
        })
        const fresh = (await repos.customer.findById(tx, existing.id))!
        await publisher.publish(EVT_CUSTOMER_UPDATED, {
          customerId: existing.id,
          customer: toCustomerSnapshot(fresh),
        })
        await publisher.publish(EVT_CUSTOMER_VERIFICATION_REQUESTED, {
          customerId: existing.id,
          reissue: 'if-stale',
        })
      })
    },

    async verifyEmail(token) {
      const tokenHash = hashResetToken(token)
      const live = await store.read((tx) =>
        repos.emailVerificationToken.findLive(tx, tokenHash, new Date()),
      )
      if (live === null) throw verifyLinkInvalid()
      const customer = await store.transaction(async (tx) => {
        // The conditional delete is the one use: of two presses that both read the row, only one deletes it.
        const customerId = await repos.emailVerificationToken.consume(tx, tokenHash, new Date())
        if (customerId === null) throw verifyLinkInvalid()
        audit.note('customer.verifyEmail', [{ type: 'customer', id: customerId }])
        return confirm(tx, customerId)
      })
      const tokens = await issueTokens(customer)
      logger.info({ customerId: customer.id }, 'customer email verified')
      return { customer: stripPassword(customer), tokens }
    },

    async resendVerification(email) {
      const customer = await store.read((tx) => repos.customer.findByEmail(tx, email.toLowerCase()))
      if (customer?.emailVerification !== 'pending') return
      await store.transaction(async () => {
        audit.note('customer.resendVerification', [{ type: 'customer', id: customer.id }])
        await publisher.publish(EVT_CUSTOMER_VERIFICATION_REQUESTED, {
          customerId: customer.id,
          reissue: 'if-stale',
        })
      })
    },

    async sendVerification(customerId) {
      await store.transaction(async (tx) => {
        if ((await existingCustomer(tx, customerId)).emailVerification !== 'pending') {
          throw new HttpError(409, 'This customer has no email waiting to be confirmed.', {
            code: 'customers.not_pending',
          })
        }
        audit.note('customer.sendVerification', [{ type: 'customer', id: customerId }])
        await publisher.publish(EVT_CUSTOMER_VERIFICATION_REQUESTED, {
          customerId,
          reissue: 'always',
        })
      })
    },

    async markVerified(customerId) {
      const customer = await store.transaction(async (tx) => {
        const current = await existingCustomer(tx, customerId)
        // Anything but a pending account is answered as it is: a second press changes nothing.
        if (current.emailVerification !== 'pending') return current
        audit.note('customer.markVerified', [{ type: 'customer', id: customerId }])
        return confirm(tx, customerId)
      })
      return stripPassword(customer)
    },

    async login(email, password) {
      const customer = await store.read((tx) => repos.customer.findByEmail(tx, email.toLowerCase()))
      // One compare on every path, so the answer's time does not say whether the address has a password.
      const real = hasPassword(customer)
      const ok = await bcryptCompare(password, real ? customer.passwordHash : DUMMY_PASSWORD_HASH)
      // After the compare and with the same refusal, so an unconfirmed account reads as a wrong password.
      const unconfirmed = verification === 'required' && customer?.emailVerification === 'pending'
      if (!real || !ok || unconfirmed) {
        throw new AuthError('invalid_credentials', 'Invalid email or password')
      }
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
      const jti = payload.jti
      const customerId = payload.sub
      const record = await store.read((tx) => repos.refreshToken.findById(tx, jti))
      if (!record) {
        // Every token is inserted before it is returned, so a signed one with no row was rotated and purged: a replay.
        await store.transaction((tx) => repos.refreshToken.revokeAllForCustomer(tx, customerId))
        throw new AuthError('token_invalid', 'refresh token unknown; sessions revoked')
      }
      if (record.revokedAt) {
        // Revoked by logout or by a sign-out of every session: refused, and nothing more.
        if (record.replacedByJti === null) {
          throw new AuthError('token_invalid', 'refresh token revoked')
        }
        // Rotated: two tabs presenting one cookie together get a pair each; later, it is a stolen token replayed.
        if (Date.now() - Date.parse(record.revokedAt) > REFRESH_REUSE_WINDOW_MS) {
          await store.transaction((tx) => repos.refreshToken.revokeAllForCustomer(tx, customerId))
          throw new AuthError('token_invalid', 'refresh token reused; sessions revoked')
        }
      }
      if (record.tokenHash !== hashRefresh(refreshToken)) {
        // A mismatch means replay with an older token — revoke chain.
        await store.transaction((tx) => repos.refreshToken.revokeAllForCustomer(tx, customerId))
        throw new AuthError('token_invalid', 'refresh token mismatch; revoking chain')
      }
      const customer = await store.read((tx) => repos.customer.findById(tx, customerId))
      if (!customer) throw new AuthError('token_invalid', 'customer missing')
      const nextJti = uuidv7()
      const nextRefresh = await mintRefresh(customer, nextJti)
      const rotated = await store.transaction((tx) =>
        repos.refreshToken.rotate(tx, jti, {
          id: nextJti,
          customerId: customer.id,
          tokenHash: hashRefresh(nextRefresh),
          expiresAt: new Date(Date.now() + refreshTtlMs),
          createdAt: new Date(),
        }),
      )
      // A sign-out committed after the read above. Losing to one is not theft, so nothing else is revoked.
      if (!rotated) throw new AuthError('token_invalid', 'refresh token revoked')
      const accessToken = await mintAccess(customer)
      return {
        accessToken,
        refreshToken: nextRefresh,
        expiresIn: Math.floor(accessTtlMs / 1000),
      }
    },

    async logout(refreshToken) {
      let payload: CustomerJwtPayload
      try {
        const verified = await jwtVerify(refreshToken, secretKey, { issuer })
        payload = verified.payload as CustomerJwtPayload
      } catch {
        return // already invalid
      }
      const { jti } = payload
      if (jti) {
        await store.transaction(async (tx) => {
          if (await repos.refreshToken.revoke(tx, jti)) return
          // Already rotated: the pointer names only the last fork, so only ending every session leaves none live.
          const row = await repos.refreshToken.findById(tx, jti)
          if (row?.replacedByJti) await repos.refreshToken.revokeAllForCustomer(tx, row.customerId)
        })
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
      const customer = await store.transaction(async (tx) => {
        const existing = await repos.customer.findByEmail(tx, email)
        if (existing) return existing
        const id = uuidv7()
        audit.note('customer.import', [{ type: 'customer', id }])
        const now = new Date()
        await repos.customer.insert(tx, {
          id,
          email,
          passwordHash: IMPORTED_NO_PASSWORD,
          requiresPasswordReset: true,
          ...(input.firstName !== undefined && { firstName: input.firstName }),
          ...(input.lastName !== undefined && { lastName: input.lastName }),
          ...(input.phone !== undefined && { phone: input.phone }),
          ...(input.addresses !== undefined && { addresses: input.addresses }),
          ...(input.metadata !== undefined && { metadata: input.metadata }),
          roles: ['customer'],
          createdAt: now,
          updatedAt: now,
        })
        const inserted = await repos.customer.findById(tx, id)
        /* c8 ignore next -- defensive: customer was inserted above */
        if (!inserted) throw new Error('customer disappeared after insert')
        await publisher.publish(EVT_CUSTOMER_CREATED, {
          customerId: id,
          email,
          customer: toCustomerSnapshot(inserted),
          origin: 'import',
        })
        logger.info({ customerId: id }, 'customer imported')
        return inserted
      })
      return stripPassword(customer)
    },

    async requestPasswordReset(email) {
      const customer = await store.read((tx) => repos.customer.findByEmail(tx, email.toLowerCase()))
      if (customer === null) return
      await store.transaction(async () => {
        audit.note('customer.requestPasswordReset', [{ type: 'customer', id: customer.id }])
        await publisher.publish(EVT_CUSTOMER_PASSWORD_RESET_REQUESTED, { customerId: customer.id })
      })
    },

    async resetPassword(token, password) {
      const tokenHash = hashResetToken(token)
      const live = await store.read((tx) =>
        repos.passwordResetToken.findLive(tx, tokenHash, new Date()),
      )
      if (live === null) throw resetLinkInvalid()
      // Before the link is consumed, so a typo does not burn it.
      checkPasswordLength(password)
      const passwordHash = await bcryptHash(password, PASSWORD_HASH_ROUNDS)
      const customer = await store.transaction(async (tx) => {
        // The conditional delete is the one use: of two resets that both read the row, only one deletes it.
        const customerId = await repos.passwordResetToken.consume(tx, tokenHash, new Date())
        if (customerId === null) throw resetLinkInvalid()
        audit.note('customer.resetPassword', [{ type: 'customer', id: customerId }])
        return setPassword(tx, customerId, passwordHash)
      })
      const tokens = await issueTokens(customer)
      logger.info({ customerId: customer.id }, 'customer password reset')
      return { customer: stripPassword(customer), tokens }
    },

    async changePassword(customerId, currentPassword, newPassword) {
      checkPasswordLength(newPassword)
      const current = await store.read((tx) => repos.customer.findById(tx, customerId))
      const ok = current !== null && (await bcryptCompare(currentPassword, current.passwordHash))
      if (!ok) throw currentPasswordInvalid()
      const passwordHash = await bcryptHash(newPassword, PASSWORD_HASH_ROUNDS)
      const customer = await store.transaction(async (tx) => {
        audit.note('customer.changePassword', [{ type: 'customer', id: customerId }])
        return setPassword(tx, customerId, passwordHash)
      })
      const tokens = await issueTokens(customer)
      logger.info({ customerId }, 'customer password changed')
      return { customer: stripPassword(customer), tokens }
    },
  }
}
