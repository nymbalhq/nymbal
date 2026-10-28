import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttpServer } from '../../../http/src/index.js'
import { createNotConfiguredAdapter } from '../../src/adapters/not-configured.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import {
  customSlots,
  postDelivery,
  recordsFor,
  type InjectedAdapters,
} from '../support/inbound-webhooks.js'
import { createKernel } from '../support/kernel.js'
import { maxSeq } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import {
  createTestHooksAdapter,
  createTestHooksTaxAdapter,
  sampleBody,
  signedDelivery,
  TEST_HOOKS,
} from '../support/test-hooks.js'

// AC-2 on SQLite: which slot a webhook name reaches. A name no slot answers to, a name whose adapters take no
// deliveries and a not-configured provider all get the same 404, so a caller cannot list the store's providers; two
// slots that both take deliveries under one name stop startup.

const AMBIGUOUS = 'config.webhook_provider_ambiguous'

/** What creating and attaching a store with `adapters` in custom slots ends in: null when it started, else the error. */
async function startupOf(adapters: InjectedAdapters): Promise<unknown> {
  const slots = Object.keys(adapters) as Array<keyof InjectedAdapters>
  let close: (() => Promise<void>) | undefined
  try {
    const k = await createKernel({
      dialect: 'sqlite',
      configure: customSlots(...slots),
      appOptions: { adapters },
    })
    close = () => k.close()
    const http = createHttpServer({
      config: k.config,
      logger: k.logger,
      documentStore: k.documentStore,
      version: '0.0.0',
    })
    await k.app.attachHttp(http.adapter)
    return null
  } catch (error) {
    return error
  } finally {
    await close?.()
  }
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code ?? error
}

/** The words of `words` the error's message leaves out. */
function missingFrom(error: unknown, words: string[]): string[] {
  const message = String((error as { message?: unknown } | null)?.message ?? '')
  return words.filter((word) => !message.includes(word))
}

describe('webhook resolution', () => {
  let served: ServedKernel
  let raw: RawReader

  beforeAll(async () => {
    // The shipping slot takes deliveries as test-hooks; the tax slot shares the name and takes none.
    const k = await createKernel({
      dialect: 'sqlite',
      configure: customSlots('shipping', 'tax'),
      appOptions: {
        adapters: {
          shipping: createTestHooksAdapter(),
          tax: createTestHooksTaxAdapter({ hooked: false }),
        },
      },
    })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  it('AC-2: an unknown name and native (adapters with no hook) each answer 404 webhook.not_found with identical bodies, and record and publish nothing', async () => {
    const body = sampleBody(`dlv_${randomUUID()}`, 2)
    const delivery = signedDelivery(body)
    const recordsBefore = await raw.count('processed_events')
    const seqBefore = await maxSeq(raw)

    const unknown = await postDelivery(served.baseUrl, `nobody-${randomUUID()}`, delivery)
    const hookless = await postDelivery(served.baseUrl, 'native', delivery)

    expect([unknown.status, unknown.error?.code]).toEqual([404, 'webhook.not_found'])
    expect(hookless.body).toEqual(unknown.body)
    expect(hookless.status).toBe(unknown.status)
    expect(await raw.count('processed_events')).toBe(recordsBefore)
    expect(await maxSeq(raw)).toBe(seqBefore)
  })

  it('AC-2: two slots sharing a name, only one of them hooked, start, and the name reaches the hooked one', async () => {
    const body = sampleBody(`dlv_${randomUUID()}`, 2)
    const eventsBefore = await raw.count('events')

    const answer = await postDelivery(served.baseUrl, TEST_HOOKS, signedDelivery(body))

    expect([answer.status, answer.data]).toEqual([200, { received: true, events: 2 }])
    expect(await recordsFor(raw, `webhook:${TEST_HOOKS}`, body.id)).toBe(1)
    expect(await raw.count('events')).toBe(eventsBefore + body.events.length)
  })

  it('AC-2: two custom slots both hooked as dup-hooks refuse to start with config.webhook_provider_ambiguous naming the name and both slots', async () => {
    const error = await startupOf({
      shipping: createTestHooksAdapter({ providerName: 'dup-hooks' }),
      tax: createTestHooksTaxAdapter({ providerName: 'dup-hooks' }),
    })

    expect(codeOf(error)).toBe(AMBIGUOUS)
    expect(missingFrom(error, ['dup-hooks', 'shipping', 'tax'])).toEqual([])
  })

  it('AC-2: a hooked non-payments adapter named stripe refuses to start with config.webhook_provider_ambiguous naming payments and its slot', async () => {
    const error = await startupOf({
      shipping: createTestHooksAdapter({ providerName: 'stripe' }),
    })

    expect(codeOf(error)).toBe(AMBIGUOUS)
    expect(missingFrom(error, ['stripe', 'payments', 'shipping'])).toEqual([])
  })

  it('AC-2: two not-configured slots sharing a name start, and that name answers the same 404 as an unknown one', async () => {
    const k = await createKernel({
      dialect: 'sqlite',
      configure: customSlots('shipping', 'tax'),
      appOptions: {
        adapters: {
          shipping: createNotConfiguredAdapter('shipping', 'nc-hooks', ['apiKey']),
          tax: createNotConfiguredAdapter('tax', 'nc-hooks', ['apiKey']),
        } as InjectedAdapters,
      },
    })
    const store = await serveKernel(k)
    try {
      const delivery = signedDelivery(sampleBody(`dlv_${randomUUID()}`, 1))

      const unknown = await postDelivery(store.baseUrl, `nobody-${randomUUID()}`, delivery)
      const notConfigured = await postDelivery(store.baseUrl, 'nc-hooks', delivery)

      expect([unknown.status, unknown.error?.code]).toEqual([404, 'webhook.not_found'])
      expect([notConfigured.status, notConfigured.body]).toEqual([unknown.status, unknown.body])
    } finally {
      await store.stop()
    }
  })
})
