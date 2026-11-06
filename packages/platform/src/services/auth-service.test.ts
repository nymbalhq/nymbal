import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { AuthError, EVT_CUSTOMER_CREATED, ValidationError } from '@nymbalhq/types'
import { SignJWT, decodeJwt } from 'jose'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore, rawClients } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createAuthService } from './auth-service.js'
import { createLogger } from '../logger.js'
import { runAsActor } from '../audit/actor.js'
import { auditedCommand } from '../audit/audit.js'
import { listAuditEntries } from '../repositories/audit-entry.js'
import type { CommandStore } from '../db/command-store.js'

async function setup() {
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
      fc
        .constantFrom(...units)
        .chain((unit) =>
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
