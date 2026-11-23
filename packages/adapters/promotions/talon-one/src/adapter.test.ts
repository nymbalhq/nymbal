import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AdapterContext, PromotionsAdapter, Slot } from '@nymbalhq/types'
import { fillFromSettings, missingSecrets } from '../../../../platform/src/settings/resolve.js'
import { createAdapter, provider, settings, slot } from './index.js'
import {
  FAKE_TALON_ONE_API_KEY,
  startFakeTalonOne,
  type FakeTalonOne,
} from './tests/fake-talon-one.js'
import { outcomeOf, session, silent } from './tests/support.js'

// The package's entry as the kernel's loader calls it: it serves the promotions slot alone, takes its base URL only
// from the config block and only over TLS (plain HTTP to a loopback host, the fake, aside), needs the Application's
// currency, and lets the admin's Settings fill the API key and nothing else.

let fake: FakeTalonOne

beforeAll(async () => {
  fake = await startFakeTalonOne()
})
afterAll(async () => {
  await fake.close()
})

const ctx = (s: Slot, config: Record<string, unknown>): AdapterContext => ({
  slot: s,
  config,
  logger: silent,
  env: {},
})

const block = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  baseUrl: fake.baseUrl,
  apiKey: FAKE_TALON_ONE_API_KEY,
  currency: 'GBP',
  ...over,
})

/** createAdapter then initialize, as the kernel's loader runs them: a refusal at either is the outcome. */
const built = (config: Record<string, unknown>) =>
  outcomeOf(async () => {
    const adapter = createAdapter(ctx('promotions', config))
    await adapter.initialize(config)
    return adapter
  })

describe('AC-7: the package serves promotions, over TLS, from the config block', () => {
  it('AC-7: createAdapter on the promotions slot builds the talon-one engine, which evaluates against the configured Talon.One', async () => {
    const config = block()
    const { value, error } = await built(config)
    const before = fake.requests.length

    await (value as PromotionsAdapter).evaluate(session(), { dry: true })

    expect(error).toBeUndefined()
    expect([slot, provider]).toEqual(['promotions', 'talon-one'])
    expect([value!.kind, value!.providerName]).toEqual([slot, provider])
    expect(fake.requests.length).toBe(before + 1)
  })

  it('AC-7: createAdapter on any other slot throws adapter.wrong_slot and builds nothing', async () => {
    const others: Slot[] = ['payments', 'email', 'search', 'shipping', 'tax']
    for (const other of others) {
      const { value, error } = await outcomeOf(() => createAdapter(ctx(other, block())))

      expect(value, other).toBeUndefined()
      expect((error as { code?: unknown }).code, other).toBe('adapter.wrong_slot')
    }
  })

  it('AC-7: a baseUrl that is plain HTTP to a host other than loopback, another scheme, or not a URL is refused, naming baseUrl', async () => {
    const refused = [
      'http://acme.europe-west1.talon.one',
      'http://localhost.attacker.example',
      'ftp://127.0.0.1',
      'not a url',
    ]
    for (const baseUrl of refused) {
      const { value, error } = await built(block({ baseUrl }))

      expect(value, baseUrl).toBeUndefined()
      expect((error as Error).message, baseUrl).toMatch(/baseUrl/)
    }
  })

  it('AC-7: plain HTTP to a loopback host (the fake) is accepted', async () => {
    const port = new URL(fake.baseUrl).port
    for (const baseUrl of [fake.baseUrl, `http://localhost:${port}`]) {
      const { error } = await built(block({ baseUrl }))
      expect(error, baseUrl).toBeUndefined()
    }
  })

  it('AC-7: a block with no currency is refused, naming currency', async () => {
    const config = block()
    delete config['currency']

    const { value, error } = await built(config)

    expect(value).toBeUndefined()
    expect((error as Error).message).toMatch(/currency/)
  })

  it('AC-7: the admin’s Settings fill the API key and nothing else: a saved baseUrl never reaches the block, and without a key the slot is unconfigured', () => {
    const rows = [
      { slot: 'promotions', path: 'baseUrl', value: 'https://attacker.example' },
      { slot: 'promotions', path: 'currency', value: 'USD' },
      { slot: 'promotions', path: 'apiKey', value: 'from-settings' },
    ]
    const unfilled = { currency: 'GBP' }

    const filled = fillFromSettings('promotions', unfilled, settings, rows, {})

    expect(filled).toEqual({ ...unfilled, apiKey: 'from-settings' })
    expect(missingSecrets(unfilled, settings)).toEqual(['apiKey'])
    expect(missingSecrets(filled, settings)).toEqual([])
  })
})
