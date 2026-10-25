import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { APIRequestContext } from '@playwright/test'
import { stackBlock } from '../../../scripts/stack'
import { API_URL, csrf } from './csrf'
import { expect } from './fixtures'

// What the alert journeys share: the store's mail, read from Mailpit through the proof kit's mail sink; the links an
// alert email carries; the API calls a shopper's browser or a storefront server makes; and the custom store's event
// log, read with `nymbal events query` against its database.

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const CLI = join(REPO, 'packages', 'cli', 'bin', 'nymbal.mjs')
const CUSTOM_STORE_DIR = join(REPO, 'tests', 'e2e', 'fixtures', 'custom-providers')

/** Mailpit's API: NYMBAL_TEST_MAILPIT_URL (CI's service), else the stack slot's compose Mailpit. */
export function mailpitUrl(): string {
  const set = process.env.NYMBAL_TEST_MAILPIT_URL
  if (set !== undefined && set !== '') return set
  return `http://localhost:${stackBlock(Number(process.env.NYMBAL_STACK_SLOT ?? '0')).mailpitUi}`
}

export interface Mail {
  subject: string
  text: string
}

export interface Mailbox {
  messages(to: string): Promise<Mail[]>
  waitFor(to: string, count: number): Promise<Mail[]>
}

/**
 * The store's Mailpit through `createMailSink`. Loaded when a journey first reads mail, so a journey on the native
 * store, which sends none, runs without it.
 */
export async function mailbox(): Promise<Mailbox> {
  const { createMailSink } = await import('@nymbalhq/proof-kit')
  const sink = createMailSink({ apiUrl: mailpitUrl() })
  const shape = (found: Array<{ subject: string; text: string }>): Mail[] =>
    found.map((m) => ({ subject: m.subject, text: m.text }))
  return {
    messages: async (to) => shape(await sink.messages({ to })),
    waitFor: async (to, count) => shape(await sink.waitFor({ to, count }, { timeoutMs: 20_000 })),
  }
}

const LINK = /https?:\/\/[^\s"'<>]+/g

/** Every URL in a mail's text. */
export function linksIn(mail: Mail): URL[] {
  return [...mail.text.matchAll(LINK)].map((m) => new URL(m[0].replace(/[.,;)]+$/, '')))
}

/** The one link to `path` in a mail; the journey depends on it. */
export function linkTo(mail: Mail, path: string): URL {
  const found = linksIn(mail).filter((url) => url.pathname === path)
  expect(
    found.map((u) => u.href),
    `links to ${path} in "${mail.subject}"`,
  ).toHaveLength(1)
  return found[0]!
}

/** A confirmation carries a confirm link; an alert carries none, but the product link and an unsubscribe link. */
export const isConfirmation = (mail: Mail): boolean =>
  linksIn(mail).some((url) => url.pathname === '/alerts/confirm')

export const isBackInStock = (mail: Mail, slug: string): boolean =>
  !isConfirmation(mail) &&
  /back in stock/i.test(`${mail.subject} ${mail.text}`) &&
  linksIn(mail).some((url) => url.pathname === `/product/${slug}`)

/** A price-drop alert for the product: no confirm link, the product link, and copy about its price. */
export const isPriceDrop = (mail: Mail, slug: string): boolean =>
  !isConfirmation(mail) &&
  /price/i.test(`${mail.subject} ${mail.text}`) &&
  linksIn(mail).some((url) => url.pathname === `/product/${slug}`)

export interface ApiAnswer {
  status: number
  text: string
}

/** `POST /api/alerts/subscribe` as the storefront's browser makes it: its Origin and the context's CSRF pair. */
export async function subscribeThroughApi(
  request: APIRequestContext,
  origin: string,
  email: string,
  variantId: string,
  kind: 'back_in_stock' | 'price_drop' = 'back_in_stock',
): Promise<ApiAnswer> {
  const res = await request.post(`${API_URL}/api/alerts/subscribe`, {
    headers: { ...(await csrf(request)), origin },
    data: { email, variantId, kind },
  })
  return { status: res.status(), text: await res.text() }
}

/** `POST /api/alerts/confirm` as a storefront server makes it: the token alone. */
export async function confirmThroughApi(
  request: APIRequestContext,
  token: string,
): Promise<ApiAnswer> {
  const res = await request.post(`${API_URL}/api/alerts/confirm`, { data: { token } })
  return { status: res.status(), text: await res.text() }
}

/** The admin's stock adjustment, under a correlation id the journey chooses. */
export async function adjustStock(
  request: APIRequestContext,
  adminToken: string,
  variantId: string,
  delta: number,
  correlationId: string,
): Promise<void> {
  const res = await request.post(`${API_URL}/api/admin/inventory/${variantId}/adjust`, {
    headers: {
      ...(await csrf(request)),
      authorization: `Bearer ${adminToken}`,
      'x-correlation-id': correlationId,
    },
    data: { delta, reason: 'manual' },
  })
  expect(res.status(), `adjust ${variantId} by ${delta}: ${await res.text()}`).toBe(200)
}

export interface LoggedEvent {
  type: string
  payload?: Record<string, unknown>
}

/** `nymbal events query --correlation <id> --type <glob> --json --payload` against the custom store's database. */
export async function customStoreEvents(
  correlationId: string,
  type: string,
): Promise<LoggedEvent[]> {
  const sqlitePath = process.env.NYMBAL_E2E_CUSTOM_SQLITE_PATH
  if (sqlitePath === undefined || sqlitePath === '') {
    throw new Error(
      'NYMBAL_E2E_CUSTOM_SQLITE_PATH is not set: tests/e2e/playwright.config.ts sets it',
    )
  }
  const env: NodeJS.ProcessEnv = { ...process.env, NYMBAL_SQLITE_PATH: sqlitePath }
  delete env['LOG_LEVEL']
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [CLI, 'events', 'query', '--correlation', correlationId, '--type', type, '--json', '--payload'],
    { cwd: CUSTOM_STORE_DIR, env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  )
  return stdout
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as LoggedEvent)
}
