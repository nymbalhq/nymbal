import { describe, expect, it } from 'vitest'
import { AuthError, EVT_CUSTOMER_CREATED, ValidationError } from '@nymbal/types'
import { SignJWT } from 'jose'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher } from '../events/publisher.js'
import { createAuthService } from './auth-service.js'
import { createLogger } from '../logger.js'

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
  const publisher = createEventPublisher({
    eventBus,
    builderContext: { storeId: 'test', environment: 'development', version: '0.0.0', source: 'test' },
  })
  const auth = createAuthService({
    repos, publisher, logger,
    jwtSecret: 'test-secret-32-characters-long-x',
    accessTtl: '15m',
    refreshTtl: '7d',
  })
  return { auth, repos, eventBus, commandStore }
}

describe('AuthService', () => {
  it('register creates customer and emits customer.created', async () => {
    const { auth, eventBus, commandStore } = await setup()
    const events: unknown[] = []
    await eventBus.subscribe(EVT_CUSTOMER_CREATED, (e) => { events.push(e.payload) })
    const { customer, tokens } = await auth.register({
      email: 'jane@example.com', password: 'password123',
      firstName: 'Jane', lastName: 'Doe',
    })
    expect(customer.email).toBe('jane@example.com')
    expect(customer.firstName).toBe('Jane')
    expect(tokens.accessToken).toBeTruthy()
    expect(tokens.refreshToken).toBeTruthy()
    expect(events).toHaveLength(1)
    await commandStore.close()
  })

  it('register stores optional phone when provided', async () => {
    const { auth, commandStore } = await setup()
    const { customer } = await auth.register({
      email: 'phone@test.com', password: 'password123', phone: '+441234567890',
    })
    expect(customer.phone).toBe('+441234567890')
    await commandStore.close()
  })

  it('register rejects invalid email', async () => {
    const { auth, commandStore } = await setup()
    await expect(auth.register({ email: 'notanemail', password: 'password123' })).rejects.toThrow(ValidationError)
    await commandStore.close()
  })

  it('register rejects password shorter than 8 chars', async () => {
    const { auth, commandStore } = await setup()
    await expect(auth.register({ email: 'short@test.com', password: '1234567' })).rejects.toThrow(ValidationError)
    await commandStore.close()
  })

  it('register rejects duplicate email', async () => {
    const { auth, commandStore } = await setup()
    await auth.register({ email: 'dup@test.com', password: 'password123' })
    await expect(auth.register({ email: 'dup@test.com', password: 'password456' })).rejects.toThrow(AuthError)
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

  it('refresh rejects already-refreshed (rotated) token', async () => {
    const { auth, commandStore } = await setup()
    const { tokens } = await auth.register({ email: 'rotate@test.com', password: 'password123' })
    await auth.refresh(tokens.refreshToken)
    await expect(auth.refresh(tokens.refreshToken)).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  it('logout revokes refresh token', async () => {
    const { auth, commandStore } = await setup()
    const { tokens } = await auth.register({ email: 'logout@test.com', password: 'password123' })
    await auth.logout(tokens.refreshToken)
    await expect(auth.refresh(tokens.refreshToken)).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  it('logout of invalid token is silent', async () => {
    const { auth, commandStore } = await setup()
    await expect(auth.logout('garbage')).resolves.not.toThrow()
    await commandStore.close()
  })

  it('verifyAccessToken returns payload for valid token', async () => {
    const { auth, commandStore } = await setup()
    const { tokens } = await auth.register({ email: 'verify@test.com', password: 'password123' })
    const payload = await auth.verifyAccessToken(tokens.accessToken)
    expect(payload.email).toBe('verify@test.com')
    expect(payload.type).toBe('access')
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
      addresses: [{
        id: 'addr-1',
        firstName: 'Import', lastName: 'Test',
        addressLine1: '1 Import St', city: 'London',
        region: 'England', postalCode: 'SW1A 1AA', country: 'GB',
        isDefaultBilling: false, isDefaultShipping: false,
      }],
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

  it('createAuthService accepts ms and h duration units', async () => {
    // Exercises the 'ms' and 'h' branches of parseDurationToMs
    const commandStore2 = createCommandStore(
      // @ts-expect-error minimal config
      { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
      { sqlitePath: ':memory:' },
    )
    await runMigrations(commandStore2, { migrationsRoot: new URL('../../migrations', import.meta.url).pathname })
    const ds = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const logger = createLogger({ pretty: false, level: 'error' })
    const eb = new InProcessEventBus({ logger })
    const repos = buildRepositories(commandStore2, ds)
    const publisher = createEventPublisher({ eventBus: eb, builderContext: { storeId: 't', environment: 'development', version: '0.0.0', source: 't' } })
    const auth = createAuthService({ repos, publisher, logger, jwtSecret: 'test-secret-32-characters-long-x', accessTtl: '500ms', refreshTtl: '1h' })
    const { tokens } = await auth.register({ email: 'ms-unit@test.com', password: 'password123' })
    expect(tokens.accessToken).toBeTruthy()
    await commandStore2.close()
  })

  it('createAuthService accepts s duration unit', async () => {
    const commandStore2 = createCommandStore(
      // @ts-expect-error minimal config
      { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
      { sqlitePath: ':memory:' },
    )
    await runMigrations(commandStore2, { migrationsRoot: new URL('../../migrations', import.meta.url).pathname })
    const ds = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const logger = createLogger({ pretty: false, level: 'error' })
    const eb = new InProcessEventBus({ logger })
    const repos = buildRepositories(commandStore2, ds)
    const publisher = createEventPublisher({ eventBus: eb, builderContext: { storeId: 't', environment: 'development', version: '0.0.0', source: 't' } })
    const auth = createAuthService({ repos, publisher, logger, jwtSecret: 'test-secret-32-characters-long-x', accessTtl: '900s', refreshTtl: '604800s' })
    const { tokens } = await auth.register({ email: 's-unit@test.com', password: 'password123' })
    expect(tokens.accessToken).toBeTruthy()
    await commandStore2.close()
  })

  it('refresh rejects valid JWT whose JTI has no DB record', async () => {
    const { auth, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'nojti@test.com', password: 'password123' })
    // Mint a valid JWT with a fresh JTI but do NOT insert a record for it
    const jti = 'no-record-jti-' + Date.now()
    const secret = new TextEncoder().encode('test-secret-32-characters-long-x')
    const ghostJwt = await new SignJWT({
      sub: customer.id, email: customer.email, roles: ['customer'] as const, type: 'refresh' as const, jti,
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
    const { auth, repos, commandStore } = await setup()
    const { customer, tokens } = await auth.register({ email: 'deleted@test.com', password: 'password123' })
    // Delete the customer directly from the DB to simulate account deletion
    if (commandStore.kind === 'sqlite') {
      commandStore.raw.prepare('DELETE FROM customers WHERE id = ?').run(customer.id)
    }
    await expect(auth.refresh(tokens.refreshToken)).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  it('refresh rejects token where DB hash does not match token hash (replay attack detection)', async () => {
    // Construct a valid refresh JWT with a known jti, but insert a record into the DB
    // with a different tokenHash — simulates the token-replay / chain-revocation path
    const { auth, repos, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'hashmismatch@test.com', password: 'password123' })
    const jti = 'test-replay-jti-' + Date.now()
    const secret = new TextEncoder().encode('test-secret-32-characters-long-x')
    const replayJwt = await new SignJWT({
      sub: customer.id, email: customer.email, roles: ['customer'] as const, type: 'refresh' as const, jti,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('nymbal')
      .setJti(jti)
      .setExpirationTime(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))
      .sign(secret)
    // Insert a record whose tokenHash does NOT match the JWT above
    await repos.refreshToken.insert({
      id: jti, customerId: customer.id,
      tokenHash: 'intentionally-wrong-hash-to-trigger-mismatch',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
    })
    await expect(auth.refresh(replayJwt)).rejects.toThrow(AuthError)
    await commandStore.close()
  })

  it('createAuthService throws ValidationError for invalid duration', async () => {
    const commandStore2 = createCommandStore(
      // @ts-expect-error minimal config
      { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
      { sqlitePath: ':memory:' },
    )
    await runMigrations(commandStore2, { migrationsRoot: new URL('../../migrations', import.meta.url).pathname })
    const ds = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
    const logger = createLogger({ pretty: false, level: 'error' })
    const eb = new InProcessEventBus({ logger })
    const repos = buildRepositories(commandStore2, ds)
    const publisher = createEventPublisher({ eventBus: eb, builderContext: { storeId: 't', environment: 'development', version: '0.0.0', source: 't' } })
    expect(() => createAuthService({ repos, publisher, logger, jwtSecret: 'test-secret-32-characters-long-x', accessTtl: 'invalid', refreshTtl: '7d' })).toThrow(ValidationError)
    await commandStore2.close()
  })
})
