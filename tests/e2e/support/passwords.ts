import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { request as playwrightRequest, type Page, type Request } from '@playwright/test'
import { buildRepositories, createCommandStore, InMemoryDocumentStore } from '@nymbalhq/platform'
import { API_URL, csrf } from './csrf'
import { expect } from './fixtures'
import { apiStoreEnv } from './order-keys'

// What the password journeys share: a shopper registered through the API, a sign-in through the API that answers only
// its status, and a reset link planted in the running store for a store that mails nothing. A planted link is what
// the store's own mail would carry: a token of 32 random bytes whose SHA-256 is the only thing the store keeps, live
// for 15 minutes, written through the store's own repository on its own connection (as order-keys.ts backdates keys).

export const RESET_PATH = '/account/reset-password'
export const FORGOT_PATH = '/account/forgot-password'
const RESET_TTL_MS = 15 * 60_000

export interface Shopper {
  email: string
  password: string
}

export function newShopper(label: string): Shopper {
  const tag = randomUUID().slice(0, 8)
  return { email: `${label}-${tag}@e2e.test`, password: `Correct-${tag}-Horse` }
}

/** Registers `shopper` through the API, on a request context of its own. */
export async function registerThroughApi(shopper: Shopper): Promise<void> {
  const context = await playwrightRequest.newContext()
  try {
    const res = await context.post(`${API_URL}/api/auth/register`, {
      headers: await csrf(context),
      data: {
        email: shopper.email,
        password: shopper.password,
        firstName: 'Ada',
        lastName: 'Reset',
      },
    })
    expect(res.ok(), `POST /api/auth/register: ${await res.text()}`).toBe(true)
  } finally {
    await context.dispose()
  }
}

/** The status of `POST /api/auth/login` with these credentials, on a request context of its own. */
export async function apiSignInStatus(email: string, password: string): Promise<number> {
  const context = await playwrightRequest.newContext()
  try {
    const res = await context.post(`${API_URL}/api/auth/login`, {
      headers: await csrf(context),
      data: { email, password },
    })
    return res.status()
  } finally {
    await context.dispose()
  }
}

type StoreConfig = Parameters<typeof createCommandStore>[0]

/** A live reset link for `email`'s customer, written in the running store as its mail would have made it. */
export async function plantResetLink(email: string): Promise<string> {
  const env = apiStoreEnv()
  const postgres = env.NYMBAL_COMMAND_STORE === 'postgres'
  const store = createCommandStore(
    {
      infrastructure: { commandStore: postgres ? 'postgres' : 'sqlite' },
    } as unknown as StoreConfig,
    postgres ? { postgresUrl: env.DATABASE_URL! } : { sqlitePath: env.NYMBAL_SQLITE_PATH! },
  )
  try {
    const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
    const customer = await store.read((tx) => repos.customer.findByEmail(tx, email.toLowerCase()))
    if (customer === null) throw new Error(`plantResetLink: no customer ${email}`)
    const token = randomBytes(32).toString('base64url')
    const createdAt = new Date()
    await store.transaction((tx) =>
      repos.passwordResetToken.insert(tx, {
        id: randomUUID(),
        customerId: customer.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(createdAt.getTime() + RESET_TTL_MS),
        createdAt,
      }),
    )
    return token
  } finally {
    await store.close()
  }
}

/** Counts the requests the page sends with `method` to the API `path`, for as long as the listener is on. */
export function requestsTo(
  page: Page,
  method: string,
  path: string,
): { count: () => number; stop: () => void } {
  const seen: string[] = []
  const listener = (req: Request): void => {
    if (req.method() === method && new URL(req.url()).pathname === path) seen.push(req.url())
  }
  page.on('request', listener)
  return { count: () => seen.length, stop: () => page.off('request', listener) }
}
