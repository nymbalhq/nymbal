import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { env as configEnv } from '@nymbalhq/config'
import type { Dialect } from '../kernel.js'
import {
  anthropicBlock,
  cleanups,
  newSecretsKey,
  openStore,
  putSetting,
  saveSetting,
  SECRETS_KEY,
  setEnv,
  settingsConfig,
  settingsField,
  startStub,
  STUB_SUGGESTION,
  stripeBlock,
  type ApiClient,
  type Stub,
} from '../settings.js'

// P3-07 AC-3 on one dialect (spec P3-07-secrets-settings, rulings 1 and 3, Decisions 1 and 4): a key saved through the
// admin's Settings reaches its adapter only after the store starts again, through the slot's declared settings.
// - Stripe, with no `secretKey` in config or env and a stub Stripe API (the adapter's host/port/protocol seam): the
//   store boots, a PUT answers `restartRequired: true`, the running adapter is the same object and still unconfigured,
//   and after createApp again the stub's first call carries the saved key.
// - Anthropic, with the stub at the declared `baseUrl`: the product-enhance route reaches the stub with the saved key
//   only after the restart.
// - Env over Settings: with a row saved and STRIPE_SECRET_KEY then exported, the stub sees the env value (the declared
//   env is honoured by the kernel, not only by a package that reads it).
// - `nymbal add stripe` with the variables unset: the recipe's `set`, resolved as loadConfig resolves it (`env()` throws
//   on an unset variable), boots; the admin serves, the listing reports `secretKey` unset, payments health is down
//   naming `payments.secretKey`; Settings fills it, and after a restart the stub sees the key.
// Kills: Settings never reaching resolveSlot; payments resolved before settings are read; a declared env not honoured;
// the recipe's env() throwing before Settings are read; the Stripe adapter's construction-time not_configured stopping
// boot before the admin can take the key.

export interface SuiteTarget {
  target: string
  drop(): Promise<void>
}

const STRIPE_ENV = {
  STRIPE_SECRET_KEY: undefined,
  STRIPE_WEBHOOK_SECRET: undefined,
  STRIPE_PUBLISHABLE_KEY: undefined,
  ANTHROPIC_API_KEY: undefined,
}

const STRIPE_RECIPE = fileURLToPath(
  new URL('../../../../adapter-stripe/recipes/stripe.json', import.meta.url),
)

type RecipeValue =
  | string
  | number
  | boolean
  | { env: string; default?: string }
  | { [k: string]: RecipeValue }

/** A recipe value as the loaded config holds it: each `{ env }` read with @nymbalhq/config's `env()`, as loadConfig would. */
function resolved(value: RecipeValue): unknown {
  if (typeof value !== 'object') return value
  if (typeof (value as { env?: unknown }).env === 'string') {
    const ref = value as { env: string; default?: string }
    return configEnv(ref.env, ref.default)
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolved(v as RecipeValue)]))
}

/** The `commerce.payments` block `nymbal add stripe` writes, as the store loads it with every Stripe variable unset. */
function stripeRecipePayments(): Record<string, unknown> {
  const recipe = JSON.parse(readFileSync(STRIPE_RECIPE, 'utf8')) as {
    set: Array<{ path: string; value: RecipeValue }>
  }
  const entry = recipe.set.find((s) => s.path === 'commerce.payments')
  if (entry === undefined) throw new Error('the stripe recipe sets no commerce.payments')
  return resolved(entry.value) as Record<string, unknown>
}

export function settingsRestartSuite(
  dialect: Dialect,
  makeTarget: () => Promise<SuiteTarget>,
): void {
  describe(`P3-07 AC-3: a saved key reaches the adapter after a restart (${dialect})`, () => {
    const scope = cleanups()
    afterEach(() => scope.run())

    async function begin(kind: 'stripe' | 'anthropic'): Promise<{ stub: Stub; target: string }> {
      scope.add(setEnv({ ...STRIPE_ENV, [SECRETS_KEY]: newSecretsKey() }))
      const stub = await startStub(kind)
      scope.add(() => stub.close())
      const db = await makeTarget()
      scope.add(() => db.drop())
      return { stub, target: db.target }
    }

    async function boot(target: string, commerce: Record<string, unknown>) {
      const store = await openStore({ dialect, target, config: settingsConfig(dialect, commerce) })
      scope.add(() => store.stop())
      return store
    }

    it('AC-3: Stripe with no secretKey boots; a PUT says restartRequired and leaves the running adapter as it was; after createApp again the stub’s first call carries the saved key', async () => {
      const { stub, target } = await begin('stripe')
      const commerce = { payments: stripeBlock(stub, { webhookSecret: 'whsec_p3_07_config' }) }
      const key = `sk_test_p3_07_${randomUUID()}`

      const first = await boot(target, commerce)
      const running = first.app.adapters.payments
      const admin = await first.admin()
      const put = await putSetting(admin, 'payments', 'secretKey', key)
      expect(put.status, JSON.stringify(put.body)).toBe(200)
      expect(put.body.data?.restartRequired).toBe(true)
      expect(first.app.adapters.payments).toBe(running)
      expect((await first.app.adapters.payments.healthCheck()).status).toBe('down')
      expect(stub.credentials().filter((c) => c === key)).toEqual([])
      await first.stop()

      stub.reset()
      const second = await boot(target, commerce)
      const health = await second.app.adapters.payments.healthCheck()
      expect(stub.calls.length).toBeGreaterThan(0)
      expect(stub.calls[0]!.credential).toBe(key)
      expect(health.status).toBe('healthy')
    }, 60_000)

    it('AC-3: Anthropic apiKey saved in Settings reaches the stub at the declared baseUrl through product enhance, only after a restart', async () => {
      const { stub, target } = await begin('anthropic')
      const commerce = { ai: anthropicBlock(stub) }
      const key = `sk-ant-p3-07-${randomUUID()}`
      const enhance = (client: ApiClient) =>
        client.call<{ suggestion: string }>('POST', `/api/admin/products/${randomUUID()}/enhance`, {
          field: 'description',
          context: { name: 'Settings Widget' },
        })

      const first = await boot(target, commerce)
      const admin = await first.admin()
      const put = await putSetting(admin, 'ai', 'apiKey', key)
      expect(put.status, JSON.stringify(put.body)).toBe(200)
      expect(put.body.data?.restartRequired).toBe(true)
      await enhance(admin)
      expect(stub.credentials().filter((c) => c === key)).toEqual([])
      await first.stop()

      stub.reset()
      const second = await boot(target, commerce)
      const answer = await enhance(await second.admin())
      expect(answer.status, JSON.stringify(answer.body)).toBe(200)
      expect(answer.body.data?.suggestion).toBe(STUB_SUGGESTION)
      expect(stub.calls.length).toBeGreaterThan(0)
      expect(stub.calls[0]!.credential).toBe(key)
    }, 60_000)

    it('AC-3: env over Settings: with a row saved and STRIPE_SECRET_KEY then exported, the stub sees the env value and the listing says env', async () => {
      const { stub, target } = await begin('stripe')
      const commerce = { payments: stripeBlock(stub, { webhookSecret: 'whsec_p3_07_config' }) }
      const saved = `sk_test_p3_07_row_${randomUUID()}`
      const exported = `sk_test_p3_07_env_${randomUUID()}`

      const first = await boot(target, commerce)
      await saveSetting(await first.admin(), 'payments', 'secretKey', saved)
      await first.stop()

      scope.add(setEnv({ STRIPE_SECRET_KEY: exported }))
      stub.reset()
      const second = await boot(target, commerce)
      await second.app.adapters.payments.healthCheck()
      expect(stub.calls.length).toBeGreaterThan(0)
      expect(stub.calls[0]!.credential).toBe(exported)
      expect(stub.credentials()).not.toContain(saved)
      const listing = await (await second.admin()).call('GET', '/api/admin/settings')
      expect(listing.status).toBe(200)
      expect(settingsField(listing.body.data, 'payments', 'secretKey')?.source).toBe('env')
    }, 60_000)

    it('AC-3: a store from `nymbal add stripe` with the variables unset boots; the admin serves, secretKey is unset, payments health is down naming payments.secretKey; Settings fills it and after a restart the stub sees the key', async () => {
      const { stub, target } = await begin('stripe')
      const payments = stripeRecipePayments()
      const block = {
        ...payments,
        config: {
          ...((payments['config'] as Record<string, unknown> | undefined) ?? {}),
          ...stripeBlock(stub).config,
        },
      }
      const commerce = { payments: block }
      const key = `sk_test_p3_07_add_${randomUUID()}`

      const first = await boot(target, commerce)
      const admin = await first.admin()
      const listing = await admin.call('GET', '/api/admin/settings')
      expect(listing.status, JSON.stringify(listing.body)).toBe(200)
      expect(settingsField(listing.body.data, 'payments', 'secretKey')?.state).toBe('unset')
      const health = await first.app.adapters.payments.healthCheck()
      expect(health.status).toBe('down')
      expect(health.detail ?? '').toContain('payments.secretKey')

      await saveSetting(admin, 'payments', 'secretKey', key)
      await saveSetting(admin, 'payments', 'webhookSecret', `whsec_p3_07_${randomUUID()}`)
      await first.stop()

      stub.reset()
      const second = await boot(target, commerce)
      expect((await second.app.adapters.payments.healthCheck()).status).toBe('healthy')
      expect(stub.calls.length).toBeGreaterThan(0)
      expect(stub.calls[0]!.credential).toBe(key)
    }, 60_000)
  })
}
