import { describe, expect, it } from 'vitest'
import { AuthError, EVT_CUSTOMER_CREATED, ValidationError } from '@nymbal/types'
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
  return { auth, eventBus, commandStore }
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
})
