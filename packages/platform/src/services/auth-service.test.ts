import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import {
  AuthError,
  EVT_CUSTOMER_CREATED,
  EVT_CUSTOMER_PASSWORD_RESET_REQUESTED,
  EVT_CUSTOMER_REGISTERED_AGAIN,
  EVT_CUSTOMER_UPDATED,
  EVT_CUSTOMER_VERIFICATION_REQUESTED,
  ValidationError,
} from '@nymbalhq/types'
import { SignJWT, decodeJwt } from 'jose'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore, rawClients } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createAuthService, hashResetToken } from './auth-service.js'
import { createLogger } from '../logger.js'
import { runAsActor } from '../audit/actor.js'
import { auditedCommand } from '../audit/audit.js'
import { listAuditEntries } from '../repositories/audit-entry.js'
import type { CommandStore } from '../db/command-store.js'

async function setup(verification?: 'required' | 'off') {
  const commandStore = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(commandStore, documentStore)
  const publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  ).publisher
  const auth = createAuthService({
    repos,
    publisher,
    logger,
    jwtSecret: 'test-secret-32-characters-long-x',
    accessTtl: '15m',
    refreshTtl: '7d',
    ...(verification !== undefined && { verification }),
  })
  return { auth, repos, eventBus, commandStore, publisher, logger }
}

describe('AuthService', () => {
  it('register creates customer and emits customer.created', async () => {
    const { auth, eventBus, commandStore } = await setup()
    const events: unknown[] = []
    await eventBus.subscribe(EVT_CUSTOMER_CREATED, (e) => {
      events.push(e.payload)
    })
    const { customer, tokens } = await auth.register({
      email: 'jane@example.com',
      password: 'password123',
      firstName: 'Jane',
      lastName: 'Doe',
    })
    expect(customer.email).toBe('jane@example.com')
    expect(customer.firstName).toBe('Jane')
    expect(tokens.accessToken).toBeTruthy()
    expect(tokens.refreshToken).toBeTruthy()
    expect(events).toHaveLength(1)
    await commandStore.close()
  })

  it("customer.created carries origin 'import' for an imported customer and no origin for a registered one", async () => {
    const { auth, eventBus, commandStore } = await setup()
    const events: Array<{ email: string; origin?: string }> = []
    await eventBus.subscribe(EVT_CUSTOMER_CREATED, (e) => {
      events.push(e.payload as { email: string; origin?: string })
    })
    await auth.register({ email: 'shopper@example.com', password: 'password123' })
    await auth.importCustomer({ email: 'migrated@example.com' })
    expect(events.map((p) => [p.email, p.origin])).toEqual([
      ['shopper@example.com', undefined],
      ['migrated@example.com', 'import'],
    ])
    await commandStore.close()
  })

  it('register stores optional phone when provided', async () => {
    const { auth, commandStore } = await setup()
    const { customer } = await auth.register({
      email: 'phone@test.com',
      password: 'password123',
      phone: '+441234567890',
    })
    expect(customer.phone).toBe('+441234567890')
    await commandStore.close()
  })

  it('register rejects invalid email', async () => {
    const { auth, commandStore } = await setup()
    await expect(auth.register({ email: 'notanemail', password: 'password123' })).rejects.toThrow(
      ValidationError,
    )
    await commandStore.close()
  })

  it('register rejects password shorter than 8 chars', async () => {
    const { auth, commandStore } = await setup()
    await expect(auth.register({ email: 'short@test.com', password: '1234567' })).rejects.toThrow(
      ValidationError,
    )
    await commandStore.close()
  })

  it('register rejects duplicate email', async () => {
    const { auth, commandStore } = await setup()
    await auth.register({ email: 'dup@test.com', password: 'password123' })
    await expect(auth.register({ email: 'dup@test.com', password: 'password456' })).rejects.toThrow(
      AuthError,
    )
    await commandStore.close()
  })

  it('login returns tokens for valid credentials', async () => {
    const { auth, commandStore } = await setup()
    await auth.register({ email: 'login@test.com', password: 'password123' })
    const { customer, tokens } = await auth.login('login@test.com', 'password123')
    expect(customer.email).toBe('login@test.com')
    expect(tokens.accessToken).toBeTruthy()
    await commandStore.close()
  })

  it('login is case-insensitive for email', async () => {
    const { auth, commandStore } = await setup()
    await auth.register({ email: 'UPPER@test.com', password: 'password123' })
    const { customer } = await auth.login('upper@test.com', 'password123')
    expect(customer.email).toBe('upper@test.com')
    await commandStore.close()
  })

  it('login rejects wrong password', async () => {
    const { auth, commandStore } = await setup()
    await auth.register({ email: 'wrong@test.com', password: 'password123' })
    await expect(auth.login('wrong@test.com', 'wrongpassword')).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  it('login rejects unknown email', async () => {
    const { auth, commandStore } = await setup()
    await expect(auth.login('ghost@test.com', 'password123')).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  it('refresh issues new tokens', async () => {
    const { auth, commandStore } = await setup()
    const { tokens } = await auth.register({ email: 'refresh@test.com', password: 'password123' })
    const newTokens = await auth.refresh(tokens.refreshToken)
    expect(newTokens.accessToken).toBeTruthy()
    expect(newTokens.refreshToken).toBeTruthy()
    expect(newTokens.refreshToken).not.toBe(tokens.refreshToken)
    await commandStore.close()
  })

  it('refresh rejects invalid token', async () => {
    const { auth, commandStore } = await setup()
    await expect(auth.refresh('invalid.token.here')).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  // Within 30 s of its rotation a rotated token is a concurrent refresh and is answered (refresh-reuse.test.ts).
  it('refresh rejects a rotated token replayed after the reuse window', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    try {
      const { auth, commandStore } = await setup()
      const { tokens } = await auth.register({ email: 'rotate@test.com', password: 'password123' })
      await auth.refresh(tokens.refreshToken)
      vi.setSystemTime(Date.now() + 31_000)
      await expect(auth.refresh(tokens.refreshToken)).rejects.toThrow(AuthError)
      await commandStore.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('logout revokes refresh token', async () => {
    const { auth, commandStore } = await setup()
    const { tokens } = await auth.register({ email: 'logout@test.com', password: 'password123' })
    await auth.logout(tokens.refreshToken)
    await expect(auth.refresh(tokens.refreshToken)).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  // Defect: logout trusts a token it has not verified, so a forged one signs another shopper out; or it throws.
  it('logout of an invalid or forged token is silent and leaves the session as it was', async () => {
    const { auth, repos, commandStore } = await setup()
    const { tokens } = await auth.register({ email: 'silent@test.com', password: 'password123' })
    const claims = decodeJwt(tokens.refreshToken)
    const forged = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('not-the-store-secret-32-chars-xx'))
    const row = () => commandStore.read((tx) => repos.refreshToken.findById(tx, claims.jti!))
    const before = await row()
    expect(before?.revokedAt).toBeNull()
    for (const token of ['garbage', forged]) await auth.logout(token)
    expect(await row()).toEqual(before)
    await commandStore.close()
  })

  it('verifyAccessToken returns payload for valid token', async () => {
    const { auth, commandStore } = await setup()
    const { tokens } = await auth.register({ email: 'verify@test.com', password: 'password123' })
    const payload = await auth.verifyAccessToken(tokens.accessToken)
    expect(payload.email).toBe('verify@test.com')
    expect(payload.type).toBe('access')
    // The token lives for the configured accessTtl (15m); iat and exp are each truncated to the second.
    const lifetimeSeconds = payload.exp! - payload.iat!
    expect(lifetimeSeconds).toBeGreaterThanOrEqual(15 * 60 - 1)
    expect(lifetimeSeconds).toBeLessThanOrEqual(15 * 60)
    await commandStore.close()
  })

  it('verifyAccessToken rejects invalid token', async () => {
    const { auth, commandStore } = await setup()
    await expect(auth.verifyAccessToken('not.valid.jwt')).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  it('verifyAccessToken rejects refresh token used as access token', async () => {
    const { auth, commandStore } = await setup()
    const { tokens } = await auth.register({ email: 'typecheck@test.com', password: 'password123' })
    await expect(auth.verifyAccessToken(tokens.refreshToken)).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  it('importCustomer creates a new customer with all optional fields', async () => {
    const { auth, commandStore } = await setup()
    const customer = await auth.importCustomer({
      email: 'imported@test.com',
      firstName: 'Import',
      lastName: 'Test',
      phone: '+441234567890',
      addresses: [
        {
          id: 'addr-1',
          firstName: 'Import',
          lastName: 'Test',
          addressLine1: '1 Import St',
          city: 'London',
          region: 'England',
          postalCode: 'SW1A 1AA',
          country: 'GB',
          isDefaultBilling: false,
          isDefaultShipping: false,
        },
      ],
      metadata: { source: 'woocommerce', wcId: 42 },
    })
    expect(customer.email).toBe('imported@test.com')
    expect(customer.firstName).toBe('Import')
    expect('passwordHash' in customer).toBe(false)
    await commandStore.close()
  })

  it('importCustomer without optional fields creates minimal customer', async () => {
    const { auth, commandStore } = await setup()
    const customer = await auth.importCustomer({ email: 'minimal@test.com' })
    expect(customer.email).toBe('minimal@test.com')
    await commandStore.close()
  })

  it('importCustomer is idempotent for duplicate email', async () => {
    const { auth, commandStore } = await setup()
    const first = await auth.importCustomer({ email: 'idempotent@test.com', firstName: 'First' })
    const second = await auth.importCustomer({ email: 'idempotent@test.com', firstName: 'Second' })
    expect(second.id).toBe(first.id)
    expect(second.firstName).toBe('First')
    await commandStore.close()
  })

  it('importCustomer rejects invalid email', async () => {
    const { auth, commandStore } = await setup()
    await expect(auth.importCustomer({ email: 'notvalid' })).rejects.toThrow(ValidationError)
    await commandStore.close()
  })

  it('refresh rejects token with wrong type claim', async () => {
    const { auth, commandStore } = await setup()
    const { tokens } = await auth.register({ email: 'wrongtype@test.com', password: 'password123' })
    // Access token has type: 'access' — using it as a refresh token should be rejected
    await expect(auth.refresh(tokens.accessToken)).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  it('refresh rejects revoked token', async () => {
    const { auth, commandStore } = await setup()
    const { tokens } = await auth.register({ email: 'revoked@test.com', password: 'password123' })
    await auth.logout(tokens.refreshToken)
    await expect(auth.refresh(tokens.refreshToken)).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  // Defect: a unit scaled wrongly (an hour read as minutes), or the access and refresh lifetimes crossed.
  it('property: for every duration unit, each minted token lives the ttl configured for it', async () => {
    const unitMs = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const
    const units = Object.keys(unitMs) as Array<keyof typeof unitMs>
    // A refresh token must outlive the second it is minted in to be presented by the next run.
    const ttl = (minMs: number) =>
      fc.constantFrom(...units).chain((unit) =>
        fc
          .integer({
            min: Math.max(1, Math.ceil(minMs / unitMs[unit])),
            max: unit === 'ms' ? 1_000_000 : 1000,
          })
          .map((qty) => ({ text: `${qty}${unit}`, ms: qty * unitMs[unit] })),
      )
    // A whole second, so exp − iat is the ttl's whole seconds with nothing lost to truncation.
    vi.useFakeTimers({ toFake: ['Date'], now: 1_800_000_000_000 })
    try {
      const { auth, repos, publisher, logger, commandStore } = await setup()
      let { refreshToken } = (
        await auth.register({ email: 'ttl@test.com', password: 'password123' })
      ).tokens
      await fc.assert(
        fc.asyncProperty(ttl(0), ttl(1000), async (access, refresh) => {
          const service = createAuthService({
            repos,
            publisher,
            logger,
            jwtSecret: 'test-secret-32-characters-long-x',
            accessTtl: access.text,
            refreshTtl: refresh.text,
          })
          const tokens = await service.refresh(refreshToken)
          refreshToken = tokens.refreshToken
          const minted = {
            access: decodeJwt(tokens.accessToken),
            refresh: decodeJwt(tokens.refreshToken),
          }
          expect(tokens.expiresIn).toBe(Math.floor(access.ms / 1000))
          expect(minted.access.exp! - minted.access.iat!).toBe(Math.floor(access.ms / 1000))
          expect(minted.refresh.exp! - minted.refresh.iat!).toBe(Math.floor(refresh.ms / 1000))
        }),
        { numRuns: 50 },
      )
      await commandStore.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('refresh rejects valid JWT whose JTI has no DB record', async () => {
    const { auth, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'nojti@test.com', password: 'password123' })
    // Mint a valid JWT with a fresh JTI but do NOT insert a record for it
    const jti = 'no-record-jti-' + Date.now()
    const secret = new TextEncoder().encode('test-secret-32-characters-long-x')
    const ghostJwt = await new SignJWT({
      sub: customer.id,
      email: customer.email,
      roles: ['customer'] as const,
      type: 'refresh' as const,
      jti,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('nymbal')
      .setJti(jti)
      .setExpirationTime(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))
      .sign(secret)
    await expect(auth.refresh(ghostJwt)).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  it('refresh rejects valid token when customer has been deleted', async () => {
    const { auth, commandStore } = await setup()
    const { customer, tokens } = await auth.register({
      email: 'deleted@test.com',
      password: 'password123',
    })
    // Delete the customer directly from the DB to simulate account deletion
    const clients = rawClients(commandStore)
    if (clients.kind === 'sqlite') {
      clients.raw.prepare('DELETE FROM customers WHERE id = ?').run(customer.id)
    }
    await expect(auth.refresh(tokens.refreshToken)).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  it('refresh rejects token where DB hash does not match token hash (replay attack detection)', async () => {
    // Construct a valid refresh JWT with a known jti, but insert a record into the DB
    // with a different tokenHash — simulates the token-replay / chain-revocation path
    const { auth, repos, commandStore } = await setup()
    const { customer } = await auth.register({
      email: 'hashmismatch@test.com',
      password: 'password123',
    })
    const jti = 'test-replay-jti-' + Date.now()
    const secret = new TextEncoder().encode('test-secret-32-characters-long-x')
    const replayJwt = await new SignJWT({
      sub: customer.id,
      email: customer.email,
      roles: ['customer'] as const,
      type: 'refresh' as const,
      jti,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('nymbal')
      .setJti(jti)
      .setExpirationTime(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))
      .sign(secret)
    // Insert a record whose tokenHash does NOT match the JWT above
    await commandStore.transaction((tx) =>
      repos.refreshToken.insert(tx, {
        id: jti,
        customerId: customer.id,
        tokenHash: 'intentionally-wrong-hash-to-trigger-mismatch',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
      }),
    )
    await expect(auth.refresh(replayJwt)).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  it('createAuthService throws ValidationError for invalid duration', async () => {
    const commandStore2 = createCommandStore(
      // @ts-expect-error minimal config
      { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
      { sqlitePath: ':memory:' },
    )
    await runMigrations(commandStore2, {
      migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
    })
    const ds = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const logger = createLogger({ pretty: false, level: 'error' })
    const eb = new InProcessEventBus({ logger })
    const repos = buildRepositories(commandStore2, ds)
    const publisher = wirePublisher(
      { createEventPublisher, createRelay },
      { store: commandStore2, eventLog: repos.eventLog, eventBus: eb, logger },
    ).publisher
    expect(() =>
      createAuthService({
        repos,
        publisher,
        logger,
        jwtSecret: 'test-secret-32-characters-long-x',
        accessTtl: 'invalid',
        refreshTtl: '7d',
      }),
    ).toThrow(ValidationError)
    await commandStore2.close()
  })
})

// A service notes the command it runs and the records it touches into the open command, and writes no row itself.
// Under an actor with no opener (an import), each transaction a service notes in is a command of its own.
const importer = { kind: 'import', id: 'woocommerce' } as const
const admin = { kind: 'admin', id: 'admin-1' } as const

const noted = async (commandStore: CommandStore) =>
  (await commandStore.read((tx) => listAuditEntries(tx, { order: 'asc', limit: 100 }))).map(
    (e) => ({
      actor: e.actor,
      command: e.command,
      subjects: e.subjects,
      outcome: e.outcome,
      status: e.responseStatus,
    }),
  )

describe('AuthService: audit notes', () => {
  it('AC-2: under an actor with no opener, a registration and a new import each leave one applied entry naming the customer; an import of a known email leaves none', async () => {
    const { auth, commandStore } = await setup()
    const { customer } = await runAsActor(importer, () =>
      auth.register({ email: 'registered@test.com', password: 'password123' }),
    )
    const imported = await runAsActor(importer, () =>
      auth.importCustomer({ email: 'imported@test.com' }),
    )
    const again = await runAsActor(importer, () =>
      auth.importCustomer({ email: 'imported@test.com' }),
    )
    expect(again.id).toBe(imported.id)
    expect(await noted(commandStore)).toEqual([
      {
        actor: importer,
        command: 'customer.register',
        subjects: [{ type: 'customer', id: customer.id }],
        outcome: 'applied',
        status: null,
      },
      {
        actor: importer,
        command: 'customer.import',
        subjects: [{ type: 'customer', id: imported.id }],
        outcome: 'applied',
        status: null,
      },
    ])
    await commandStore.close()
  })

  it('AC-2: a registration refused before its transaction is recorded as customer.register refused; with no actor nothing is recorded', async () => {
    const { auth, commandStore } = await setup()
    await expect(
      runAsActor(admin, () =>
        auditedCommand(commandStore, undefined, () =>
          auth.register({ email: 'not-an-email', password: 'password123' }),
        ),
      ),
    ).rejects.toThrow(ValidationError)
    await auth.register({ email: 'unscoped@test.com', password: 'password123' })
    expect(await noted(commandStore)).toEqual([
      { actor: admin, command: 'customer.register', subjects: [], outcome: 'refused', status: 400 },
    ])
    await commandStore.close()
  })
})

// A reset link is a row holding the token's hash; the mail handler writes it, so these write it directly.
async function resetLink(
  { repos, commandStore }: Awaited<ReturnType<typeof setup>>,
  customerId: string,
  expiresAt = new Date(Date.now() + 15 * 60_000),
): Promise<string> {
  const token = randomUUID()
  await commandStore.transaction((tx) =>
    repos.passwordResetToken.insert(tx, {
      id: randomUUID(),
      customerId,
      tokenHash: hashResetToken(token),
      expiresAt,
      createdAt: new Date(),
    }),
  )
  return token
}

const refreshes = (auth: Awaited<ReturnType<typeof setup>>['auth'], token: string) =>
  auth.refresh(token).then(
    () => true,
    () => false,
  )
const signsIn = (auth: Awaited<ReturnType<typeof setup>>['auth'], email: string, password: string) =>
  auth.login(email, password).then(
    () => true,
    () => false,
  )

const LINK_INVALID = {
  status: 400,
  code: 'auth.reset_link_invalid',
  message: 'This reset link is no longer valid. Ask for a new one.',
}
const CURRENT_INVALID = {
  status: 400,
  code: 'auth.current_password_invalid',
  message: 'The current password is not correct.',
}

describe('AuthService: password reset and change', () => {
  it('hashResetToken is the hex SHA-256 of the token', () => {
    expect(hashResetToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('two access tokens minted in one second for one customer differ by their jti', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    try {
      const { auth, commandStore } = await setup()
      const { tokens } = await auth.register({ email: 'twice@test.com', password: 'password123' })
      const again = await auth.login('twice@test.com', 'password123')
      const [first, second] = [decodeJwt(tokens.accessToken), decodeJwt(again.tokens.accessToken)]
      expect(first.iat).toBe(second.iat)
      expect(first.jti).toEqual(expect.any(String))
      expect(first.jti).not.toBe(second.jti)
      await commandStore.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('requestPasswordReset publishes one request naming the customer, whatever the case of the address, and nothing for an unknown address; each request is noted', async () => {
    const ctx = await setup()
    const { auth, eventBus, commandStore } = ctx
    const { customer } = await auth.register({ email: 'forgot@test.com', password: 'password123' })
    const requested: unknown[] = []
    await eventBus.subscribe(EVT_CUSTOMER_PASSWORD_RESET_REQUESTED, (e) => {
      requested.push(e.payload)
    })
    const guest = { kind: 'guest', id: 'anonymous' } as const
    await runAsActor(guest, () => auth.requestPasswordReset('FORGOT@Test.com'))
    await runAsActor(guest, () => auth.requestPasswordReset('ghost@test.com'))
    expect(requested).toEqual([{ customerId: customer.id }])
    expect(await noted(commandStore)).toEqual([
      {
        actor: guest,
        command: 'customer.requestPasswordReset',
        subjects: [{ type: 'customer', id: customer.id }],
        outcome: 'applied',
        status: null,
      },
    ])
    await commandStore.close()
  })

  it('resetPassword with a live link sets the password, clears the reset flag, takes away every link, ends every earlier session, publishes the change and signs in; the link then answers reset_link_invalid', async () => {
    const ctx = await setup()
    const { auth, repos, eventBus, commandStore } = ctx
    const imported = await auth.importCustomer({ email: 'moved@test.com' })
    const { customer, tokens: first } = await auth.register({
      email: 'reset@test.com',
      password: 'oldpassword1',
    })
    const second = (await auth.login('reset@test.com', 'oldpassword1')).tokens
    const token = await resetLink(ctx, customer.id)
    const spare = await resetLink(ctx, customer.id)
    const otherLink = await resetLink(ctx, imported.id)
    const updated: Array<{ customerId: string; customer: { id: string } }> = []
    await eventBus.subscribe(EVT_CUSTOMER_UPDATED, (e) => {
      updated.push(e.payload as { customerId: string; customer: { id: string } })
    })

    const guest = { kind: 'guest', id: 'anonymous' } as const
    const result = await runAsActor(guest, () => auth.resetPassword(token, 'newpassword1'))

    expect(result.customer).toMatchObject({ id: customer.id, email: 'reset@test.com' })
    expect(result.customer).not.toHaveProperty('passwordHash')
    expect((await auth.verifyAccessToken(result.tokens.accessToken)).sub).toBe(customer.id)
    expect(await refreshes(auth, first.refreshToken)).toBe(false)
    expect(await refreshes(auth, second.refreshToken)).toBe(false)
    expect(await refreshes(auth, result.tokens.refreshToken)).toBe(true)
    expect(await signsIn(auth, 'reset@test.com', 'oldpassword1')).toBe(false)
    expect(await signsIn(auth, 'reset@test.com', 'newpassword1')).toBe(true)
    expect(updated.map((p) => [p.customerId, p.customer.id])).toEqual([
      [customer.id, customer.id],
    ])
    const now = new Date()
    expect(
      await commandStore.read((tx) => repos.passwordResetToken.findLiveForCustomer(tx, customer.id, now)),
    ).toBeNull()
    expect(
      await commandStore.read((tx) => repos.passwordResetToken.findLiveForCustomer(tx, imported.id, now)),
    ).not.toBeNull()
    for (const used of [token, spare]) {
      await expect(auth.resetPassword(used, 'thirdpassword')).rejects.toMatchObject(LINK_INVALID)
    }
    expect(await signsIn(auth, 'reset@test.com', 'newpassword1')).toBe(true)
    expect(
      (await noted(commandStore)).filter((e) => e.command === 'customer.resetPassword'),
    ).toEqual([
      {
        actor: guest,
        command: 'customer.resetPassword',
        subjects: [{ type: 'customer', id: customer.id }],
        outcome: 'applied',
        status: null,
      },
    ])

    // An imported customer has no password until a link sets one, and then needs no reset.
    expect(await signsIn(auth, 'moved@test.com', 'IMPORTED_NO_PASSWORD')).toBe(false)
    await auth.resetPassword(otherLink, 'movedpassword')
    const moved = await commandStore.read((tx) => repos.customer.findById(tx, imported.id))
    expect(moved?.requiresPasswordReset).toBe(false)
    expect(await signsIn(auth, 'moved@test.com', 'movedpassword')).toBe(true)
    await commandStore.close()
  })

  it('resetPassword refuses an unknown or expired link with one answer, and a short password before the link is used, leaving the hash and the link as they were', async () => {
    const ctx = await setup()
    const { auth, repos, commandStore } = ctx
    const { customer } = await auth.register({ email: 'keep@test.com', password: 'oldpassword1' })
    const expired = await resetLink(ctx, customer.id, new Date(Date.now() - 1))
    const token = await resetLink(ctx, customer.id)
    const hash = async () =>
      (await commandStore.read((tx) => repos.customer.findById(tx, customer.id)))?.passwordHash

    const before = await hash()
    for (const t of [expired, randomUUID()]) {
      await expect(auth.resetPassword(t, 'newpassword1')).rejects.toMatchObject(LINK_INVALID)
    }
    await expect(auth.resetPassword(token, '1234567')).rejects.toThrow(ValidationError)
    expect(await hash()).toBe(before)

    // A link another reset consumed between the read and the write is refused the same way.
    vi.spyOn(repos.passwordResetToken, 'consume').mockResolvedValueOnce(null)
    await expect(auth.resetPassword(token, 'newpassword1')).rejects.toMatchObject(LINK_INVALID)
    expect(await hash()).toBe(before)

    await auth.resetPassword(token, '12345678')
    expect(await signsIn(auth, 'keep@test.com', '12345678')).toBe(true)
    await commandStore.close()
  })

  it('changePassword with the current password sets the new one, ends every other session and starts a fresh one', async () => {
    const { auth, eventBus, commandStore } = await setup()
    const { customer, tokens: first } = await auth.register({
      email: 'change@test.com',
      password: 'oldpassword1',
    })
    const other = await auth.register({ email: 'other@test.com', password: 'otherpassword' })
    const second = (await auth.login('change@test.com', 'oldpassword1')).tokens
    const updated: string[] = []
    await eventBus.subscribe(EVT_CUSTOMER_UPDATED, (e) => {
      updated.push((e.payload as { customerId: string }).customerId)
    })
    const self = { kind: 'customer', id: customer.id } as const
    const result = await runAsActor(self, () =>
      auth.changePassword(customer.id, 'oldpassword1', '12345678'),
    )

    expect(result.customer).toMatchObject({ id: customer.id, email: 'change@test.com' })
    expect(result.customer).not.toHaveProperty('passwordHash')
    expect((await auth.verifyAccessToken(result.tokens.accessToken)).sub).toBe(customer.id)
    expect(await refreshes(auth, first.refreshToken)).toBe(false)
    expect(await refreshes(auth, second.refreshToken)).toBe(false)
    expect(await refreshes(auth, result.tokens.refreshToken)).toBe(true)
    expect(await refreshes(auth, other.tokens.refreshToken)).toBe(true)
    expect(await signsIn(auth, 'change@test.com', 'oldpassword1')).toBe(false)
    expect(await signsIn(auth, 'change@test.com', '12345678')).toBe(true)
    expect(updated).toEqual([customer.id])
    expect(await noted(commandStore)).toEqual([
      {
        actor: self,
        command: 'customer.changePassword',
        subjects: [{ type: 'customer', id: customer.id }],
        outcome: 'applied',
        status: null,
      },
    ])
    await commandStore.close()
  })

  it('changePassword refuses a wrong current password, an unknown customer and a short new password, and changes nothing', async () => {
    const { auth, commandStore } = await setup()
    const { customer, tokens } = await auth.register({
      email: 'refused@test.com',
      password: 'oldpassword1',
    })
    await expect(
      auth.changePassword(customer.id, 'wrongpassword', 'newpassword1'),
    ).rejects.toMatchObject(CURRENT_INVALID)
    await expect(
      auth.changePassword(randomUUID(), 'oldpassword1', 'newpassword1'),
    ).rejects.toMatchObject(CURRENT_INVALID)
    await expect(auth.changePassword(customer.id, 'oldpassword1', '1234567')).rejects.toThrow(
      ValidationError,
    )
    expect(await signsIn(auth, 'refused@test.com', 'oldpassword1')).toBe(true)
    expect(await refreshes(auth, tokens.refreshToken)).toBe(true)
    await commandStore.close()
  })
})

// Under `required` a sign-up asks the address to prove itself with a mailed link before it signs in. The mail handler
// writes a link's row, so these tests write it directly, as the reset tests above do.
type Ctx = Awaited<ReturnType<typeof setup>>

const guest = { kind: 'guest', id: 'anonymous' } as const

async function verificationLink(
  { repos, commandStore }: Ctx,
  customerId: string,
  expiresAt = new Date(Date.now() + 24 * 60 * 60_000),
): Promise<string> {
  const token = randomUUID()
  await commandStore.transaction((tx) =>
    repos.emailVerificationToken.insert(tx, {
      id: randomUUID(),
      customerId,
      tokenHash: hashResetToken(token),
      expiresAt,
      createdAt: new Date(),
    }),
  )
  return token
}

const liveLink = ({ repos, commandStore }: Ctx, customerId: string) =>
  commandStore.read((tx) =>
    repos.emailVerificationToken.findLiveForCustomer(tx, customerId, new Date()),
  )

const stored = ({ repos, commandStore }: Ctx, email: string) =>
  commandStore.read((tx) => repos.customer.findByEmail(tx, email))

async function payloads<T>(
  eventBus: InProcessEventBus,
  type: Parameters<InProcessEventBus['subscribe']>[0],
): Promise<T[]> {
  const seen: T[] = []
  await eventBus.subscribe(type, (e) => {
    seen.push(e.payload as T)
  })
  return seen
}

/** The same accounts under another policy, as a store that changes its setting keeps them. */
const underPolicy = (ctx: Ctx, verification?: 'required' | 'off') =>
  createAuthService({
    repos: ctx.repos,
    publisher: ctx.publisher,
    logger: ctx.logger,
    jwtSecret: 'test-secret-32-characters-long-x',
    accessTtl: '15m',
    refreshTtl: '7d',
    ...(verification !== undefined && { verification }),
  })

async function pendingAccount(ctx: Ctx, email: string, password = 'password123') {
  await ctx.auth.signUp({ email, password })
  return (await stored(ctx, email))!
}

async function confirmedAccount(ctx: Ctx, email: string, password = 'password123') {
  const { id } = await pendingAccount(ctx, email, password)
  await ctx.commandStore.transaction((tx) =>
    ctx.repos.customer.update(tx, id, { emailVerification: 'verified', updatedAt: new Date() }),
  )
  return (await stored(ctx, email))!
}

/** What a caller can tell about a refusal. */
const refusal = (attempt: Promise<unknown>) =>
  attempt.then(
    () => null,
    (e: AuthError) => ({ kind: e.constructor.name, status: e.status, code: e.code, message: e.message }),
  )

const VERIFY_INVALID = {
  status: 400,
  code: 'auth.verify_link_invalid',
  message: 'This confirmation link is no longer valid. Ask for a new one.',
}
const NOT_PENDING = {
  status: 409,
  code: 'customers.not_pending',
  message: 'This customer has no email waiting to be confirmed.',
}
const notFound = (id: string) => ({
  status: 404,
  code: 'customers.not_found',
  message: `Customer not found: ${id}`,
})

type CreatedPayload = { customerId: string; email: string; customer: { id: string }; verification?: string }
type UpdatedPayload = { customerId: string; customer: { id: string } }
type RequestedPayload = { customerId: string; reissue: string }

describe('AuthService: sign-up verification', () => {
  it('AC-4: under required, a new address gets one pending account with the typed password and names, a created event marked pending and one if-stale link request, noted as its register', async () => {
    const ctx = await setup('required')
    const created = await payloads<CreatedPayload>(ctx.eventBus, EVT_CUSTOMER_CREATED)
    const requested = await payloads<RequestedPayload>(
      ctx.eventBus,
      EVT_CUSTOMER_VERIFICATION_REQUESTED,
    )

    await runAsActor(guest, () =>
      ctx.auth.signUp({
        email: 'New@Test.com',
        password: 'password123',
        firstName: 'Ada',
        lastName: 'Lovelace',
        phone: '+44 20 0000',
      }),
    )

    const row = (await stored(ctx, 'new@test.com'))!
    expect(row).toMatchObject({
      email: 'new@test.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '+44 20 0000',
      emailVerification: 'pending',
    })
    expect(await signsIn(underPolicy(ctx, 'off'), 'new@test.com', 'password123')).toBe(true)
    expect(created.map((p) => [p.customerId, p.email, p.customer.id, p.verification])).toEqual([
      [row.id, 'new@test.com', row.id, 'pending'],
    ])
    expect(requested).toEqual([{ customerId: row.id, reissue: 'if-stale' }])
    expect(await noted(ctx.commandStore)).toEqual([
      {
        actor: guest,
        command: 'customer.register',
        subjects: [{ type: 'customer', id: row.id }],
        outcome: 'applied',
        status: null,
      },
    ])
    await ctx.commandStore.close()
  })

  it('AC-2: a sign-up with an invalid address or a short password is refused as register refuses it, before any account exists', async () => {
    const ctx = await setup('required')
    await expect(
      runAsActor(admin, () =>
        auditedCommand(ctx.commandStore, undefined, () =>
          ctx.auth.signUp({ email: 'not-an-email', password: 'password123' }),
        ),
      ),
    ).rejects.toThrow(ValidationError)
    await expect(
      ctx.auth.signUp({ email: 'short@test.com', password: '1234567' }),
    ).rejects.toThrow(ValidationError)
    expect(await stored(ctx, 'not-an-email')).toBeNull()
    expect(await stored(ctx, 'short@test.com')).toBeNull()
    expect(await noted(ctx.commandStore)).toEqual([
      { actor: admin, command: 'customer.register', subjects: [], outcome: 'refused', status: 400 },
    ])
    await ctx.commandStore.close()
  })

  it("AC-2: a pending address signing up again takes this sign-up's password and names, stays the one pending account and is asked to confirm again", async () => {
    const ctx = await setup('required')
    await ctx.auth.signUp({
      email: 'again@test.com',
      password: 'firstpass1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '+44 20 0000',
    })
    const before = (await stored(ctx, 'again@test.com'))!
    const created = await payloads<CreatedPayload>(ctx.eventBus, EVT_CUSTOMER_CREATED)
    const updated = await payloads<UpdatedPayload>(ctx.eventBus, EVT_CUSTOMER_UPDATED)
    const requested = await payloads<RequestedPayload>(
      ctx.eventBus,
      EVT_CUSTOMER_VERIFICATION_REQUESTED,
    )
    const told = await payloads<{ customerId: string }>(ctx.eventBus, EVT_CUSTOMER_REGISTERED_AGAIN)

    await runAsActor(guest, () =>
      ctx.auth.signUp({ email: 'AGAIN@test.com', password: 'secondpass2' }),
    )

    const after = (await stored(ctx, 'again@test.com'))!
    expect(after.id).toBe(before.id)
    expect(after).toMatchObject({
      firstName: '',
      lastName: '',
      phone: '',
      emailVerification: 'pending',
    })
    const off = underPolicy(ctx, 'off')
    expect(await signsIn(off, 'again@test.com', 'secondpass2')).toBe(true)
    expect(await signsIn(off, 'again@test.com', 'firstpass1')).toBe(false)
    expect(created).toEqual([])
    expect(told).toEqual([])
    expect(updated.map((p) => [p.customerId, p.customer.id])).toEqual([[before.id, before.id]])
    expect(requested).toEqual([{ customerId: before.id, reissue: 'if-stale' }])
    expect(await noted(ctx.commandStore)).toEqual([
      {
        actor: guest,
        command: 'customer.register',
        subjects: [{ type: 'customer', id: before.id }],
        outcome: 'applied',
        status: null,
      },
    ])
    await ctx.commandStore.close()
  })

  it("AC-2: a sign-up for a confirmed, a never-asked or an imported account changes nothing in it and tells the account's owner instead", async () => {
    const ctx = await setup('required')
    const confirmed = await confirmedAccount(ctx, 'confirmed@test.com')
    const { customer: neverAsked } = await underPolicy(ctx, 'off').register({
      email: 'never-asked@test.com',
      password: 'password123',
      firstName: 'Old',
    })
    const imported = await ctx.auth.importCustomer({ email: 'imported@test.com', phone: '+1 555' })
    const accounts = [confirmed, neverAsked, imported]
    const before = await Promise.all(accounts.map((c) => stored(ctx, c.email)))
    const told = await payloads<{ customerId: string }>(ctx.eventBus, EVT_CUSTOMER_REGISTERED_AGAIN)
    const updated = await payloads<UpdatedPayload>(ctx.eventBus, EVT_CUSTOMER_UPDATED)
    const requested = await payloads<RequestedPayload>(
      ctx.eventBus,
      EVT_CUSTOMER_VERIFICATION_REQUESTED,
    )

    for (const c of accounts) {
      await runAsActor(guest, () =>
        ctx.auth.signUp({
          email: c.email.toUpperCase(),
          password: 'intruder99',
          firstName: 'Eve',
          lastName: 'Intruder',
          phone: '000',
        }),
      )
    }

    expect(await Promise.all(accounts.map((c) => stored(ctx, c.email)))).toEqual(before)
    expect(await signsIn(ctx.auth, 'confirmed@test.com', 'password123')).toBe(true)
    expect(await signsIn(ctx.auth, 'never-asked@test.com', 'password123')).toBe(true)
    expect(await signsIn(ctx.auth, 'confirmed@test.com', 'intruder99')).toBe(false)
    expect(told).toEqual(accounts.map((c) => ({ customerId: c.id })))
    expect(updated).toEqual([])
    expect(requested).toEqual([])
    expect(await noted(ctx.commandStore)).toEqual(
      accounts.map((c) => ({
        actor: guest,
        command: 'customer.register',
        subjects: [{ type: 'customer', id: c.id }],
        outcome: 'applied',
        status: null,
      })),
    )
    await ctx.commandStore.close()
  })

  it("AC-5: under required a pending account with its right password gets a wrong password's refusal; it signs in under off, and a never-asked account signs in under required", async () => {
    const ctx = await setup('required')
    await pendingAccount(ctx, 'waiting@test.com')
    const right = await refusal(ctx.auth.login('waiting@test.com', 'password123'))
    const wrong = await refusal(ctx.auth.login('waiting@test.com', 'wrongpass1'))
    expect(right).toEqual(wrong)
    expect(right).toMatchObject({ kind: 'AuthError', status: 401, code: 'auth.invalid_credentials' })

    // A store that never set the policy runs `off`.
    const unset = underPolicy(ctx)
    expect([ctx.auth.verification, unset.verification]).toEqual(['required', 'off'])
    expect(await signsIn(unset, 'waiting@test.com', 'password123')).toBe(true)
    expect(await signsIn(underPolicy(ctx, 'off'), 'waiting@test.com', 'password123')).toBe(true)

    await unset.register({ email: 'seeded@test.com', password: 'password123' })
    expect(await signsIn(ctx.auth, 'seeded@test.com', 'password123')).toBe(true)
    await ctx.commandStore.close()
  })

  it('AC-6: a live link confirms the account, takes away its other links, publishes the change and signs it in; used, unknown, expired and raced links get one refusal and change nothing', async () => {
    const ctx = await setup('required')
    const { id } = await pendingAccount(ctx, 'confirm@test.com')
    const other = await pendingAccount(ctx, 'other@test.com')
    const expired = await verificationLink(ctx, id, new Date(Date.now() - 1))
    const token = await verificationLink(ctx, id)
    const spare = await verificationLink(ctx, id)
    const otherLink = await verificationLink(ctx, other.id)
    const updated = await payloads<UpdatedPayload>(ctx.eventBus, EVT_CUSTOMER_UPDATED)

    for (const t of [expired, randomUUID()]) {
      await expect(ctx.auth.verifyEmail(t)).rejects.toMatchObject(VERIFY_INVALID)
    }
    expect((await stored(ctx, 'confirm@test.com'))?.emailVerification).toBe('pending')

    const result = await runAsActor(guest, () => ctx.auth.verifyEmail(token))

    expect(result.customer).toMatchObject({
      id,
      email: 'confirm@test.com',
      emailVerification: 'verified',
    })
    expect(result.customer).not.toHaveProperty('passwordHash')
    expect((await ctx.auth.verifyAccessToken(result.tokens.accessToken)).sub).toBe(id)
    expect(await refreshes(ctx.auth, result.tokens.refreshToken)).toBe(true)
    expect((await stored(ctx, 'confirm@test.com'))?.emailVerification).toBe('verified')
    expect(await signsIn(ctx.auth, 'confirm@test.com', 'password123')).toBe(true)
    expect(updated.map((p) => [p.customerId, p.customer.id])).toEqual([[id, id]])
    expect(await liveLink(ctx, id)).toBeNull()
    expect((await liveLink(ctx, other.id))?.customerId).toBe(other.id)
    for (const used of [token, spare]) {
      await expect(ctx.auth.verifyEmail(used)).rejects.toMatchObject(VERIFY_INVALID)
    }
    expect(
      (await noted(ctx.commandStore)).filter((e) => e.command === 'customer.verifyEmail'),
    ).toEqual([
      {
        actor: guest,
        command: 'customer.verifyEmail',
        subjects: [{ type: 'customer', id }],
        outcome: 'applied',
        status: null,
      },
    ])

    // A link another press consumed between the read and the write is refused the same way.
    vi.spyOn(ctx.repos.emailVerificationToken, 'consume').mockResolvedValueOnce(null)
    await expect(ctx.auth.verifyEmail(otherLink)).rejects.toMatchObject(VERIFY_INVALID)
    expect((await stored(ctx, 'other@test.com'))?.emailVerification).toBe('pending')
    expect(updated).toHaveLength(1)
    await ctx.commandStore.close()
  })

  it('AC-10: a resend asks for a pending account’s link again whatever the case typed, and does nothing for a confirmed, a never-asked or an unknown address', async () => {
    const ctx = await setup('required')
    const pending = await pendingAccount(ctx, 'pending@test.com')
    await confirmedAccount(ctx, 'done@test.com')
    await underPolicy(ctx, 'off').register({ email: 'old@test.com', password: 'password123' })
    const requested = await payloads<RequestedPayload>(
      ctx.eventBus,
      EVT_CUSTOMER_VERIFICATION_REQUESTED,
    )

    for (const email of ['PENDING@Test.com', 'done@test.com', 'old@test.com', 'ghost@test.com']) {
      await runAsActor(guest, () => ctx.auth.resendVerification(email))
    }

    expect(requested).toEqual([{ customerId: pending.id, reissue: 'if-stale' }])
    expect(await noted(ctx.commandStore)).toEqual([
      {
        actor: guest,
        command: 'customer.resendVerification',
        subjects: [{ type: 'customer', id: pending.id }],
        outcome: 'applied',
        status: null,
      },
    ])
    await ctx.commandStore.close()
  })

  it("AC-12: support's send asks for a pending customer's link always; a customer not pending is refused 409 and an unknown id 404, asking for nothing", async () => {
    const ctx = await setup('required')
    const pending = await pendingAccount(ctx, 'pending@test.com')
    const done = await confirmedAccount(ctx, 'done@test.com')
    const { customer: old } = await underPolicy(ctx, 'off').register({
      email: 'old@test.com',
      password: 'password123',
    })
    const ghost = randomUUID()
    const requested = await payloads<RequestedPayload>(
      ctx.eventBus,
      EVT_CUSTOMER_VERIFICATION_REQUESTED,
    )

    await runAsActor(admin, () => ctx.auth.sendVerification(pending.id))
    for (const id of [done.id, old.id]) {
      await expect(runAsActor(admin, () => ctx.auth.sendVerification(id))).rejects.toMatchObject(
        NOT_PENDING,
      )
    }
    await expect(runAsActor(admin, () => ctx.auth.sendVerification(ghost))).rejects.toMatchObject(
      notFound(ghost),
    )

    expect(requested).toEqual([{ customerId: pending.id, reissue: 'always' }])
    expect(await noted(ctx.commandStore)).toEqual([
      {
        actor: admin,
        command: 'customer.sendVerification',
        subjects: [{ type: 'customer', id: pending.id }],
        outcome: 'applied',
        status: null,
      },
    ])
    await ctx.commandStore.close()
  })

  it("AC-12: support's confirm makes a pending customer verified, refuses their live link and lets their password sign in; again, or on a customer not pending, it answers the customer as they are", async () => {
    const ctx = await setup('required')
    const pending = await pendingAccount(ctx, 'pending@test.com')
    const link = await verificationLink(ctx, pending.id)
    const { customer: old } = await underPolicy(ctx, 'off').register({
      email: 'old@test.com',
      password: 'password123',
    })
    const oldBefore = await stored(ctx, 'old@test.com')
    const ghost = randomUUID()
    const updated = await payloads<UpdatedPayload>(ctx.eventBus, EVT_CUSTOMER_UPDATED)

    const confirmed = await runAsActor(admin, () => ctx.auth.markVerified(pending.id))

    expect(confirmed).toMatchObject({ id: pending.id, emailVerification: 'verified' })
    expect(confirmed).not.toHaveProperty('passwordHash')
    expect(await signsIn(ctx.auth, 'pending@test.com', 'password123')).toBe(true)
    await expect(ctx.auth.verifyEmail(link)).rejects.toMatchObject(VERIFY_INVALID)

    const again = await runAsActor(admin, () => ctx.auth.markVerified(pending.id))
    expect(again).toEqual(confirmed)
    const oldAnswer = await runAsActor(admin, () => ctx.auth.markVerified(old.id))
    expect(oldAnswer.id).toBe(old.id)
    expect(oldAnswer.emailVerification).toBeUndefined()
    expect(await stored(ctx, 'old@test.com')).toEqual(oldBefore)
    await expect(runAsActor(admin, () => ctx.auth.markVerified(ghost))).rejects.toMatchObject(
      notFound(ghost),
    )

    expect(updated.map((p) => [p.customerId, p.customer.id])).toEqual([[pending.id, pending.id]])
    expect(await noted(ctx.commandStore)).toEqual([
      {
        actor: admin,
        command: 'customer.markVerified',
        subjects: [{ type: 'customer', id: pending.id }],
        outcome: 'applied',
        status: null,
      },
    ])
    await ctx.commandStore.close()
  })

  it("AC-11: a password reset confirms a pending account and refuses its earlier confirmation link; a never-asked account's reset leaves it never asked", async () => {
    const ctx = await setup('required')
    const pending = await pendingAccount(ctx, 'lost@test.com')
    const link = await verificationLink(ctx, pending.id)
    const { customer: old } = await underPolicy(ctx, 'off').register({
      email: 'old@test.com',
      password: 'password123',
    })

    const result = await ctx.auth.resetPassword(await resetLink(ctx, pending.id), 'newpassword1')
    await ctx.auth.resetPassword(await resetLink(ctx, old.id), 'newpassword2')

    expect(result.customer).toMatchObject({ id: pending.id, emailVerification: 'verified' })
    expect((await stored(ctx, 'lost@test.com'))?.emailVerification).toBe('verified')
    expect(await liveLink(ctx, pending.id)).toBeNull()
    await expect(ctx.auth.verifyEmail(link)).rejects.toMatchObject(VERIFY_INVALID)
    expect(await signsIn(ctx.auth, 'lost@test.com', 'newpassword1')).toBe(true)
    expect((await stored(ctx, 'old@test.com'))?.emailVerification).toBeUndefined()
    expect(await signsIn(ctx.auth, 'old@test.com', 'newpassword2')).toBe(true)
    await ctx.commandStore.close()
  })
})
