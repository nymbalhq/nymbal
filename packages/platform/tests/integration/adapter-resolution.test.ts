import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { createNativeStubPaymentsAdapter } from '../../src/adapters/payments/native-stub.js'
import { createLogger } from '../../src/logger.js'
import { createKernel } from '../support/kernel.js'
import {
  INSTALL_VERB,
  moduleHooks,
  readResolved,
  type ModuleHooks,
} from '../../../../tests/support/module-hooks.js'

// The resolver through createApp. Child processes run createApp from the built dist (`pnpm build` first) under Node
// module hooks: a third party's package is a fixture file the hooks answer its specifier with, and every bare specifier
// resolved is recorded. AC-4: a custom slot uses the injected adapter even with `package` set. AC-6: a typo or an unknown
// provider, with no such package, is adapter.provider_unknown with no install line. AC-12: security resolves by the
// same rule. AC-14: Settings rows never choose the code a slot runs.

const exec = promisify(execFile)
const FIXTURES = fileURLToPath(new URL('./fixtures/adapter-resolution/', import.meta.url))
const CHILD = join(FIXTURES, 'child.mjs')
const PAYMENTS_FIXTURE = join(FIXTURES, 'payments-acme.mjs')
const SECURITY_FIXTURE = join(FIXTURES, 'security-acme.mjs')

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-resolution-test-'))
  dirs.push(dir)
  return dir
}

type Raw = Record<string, unknown> & { commerce: Record<string, unknown> }

/** A raw config, as nymbal.config.ts would export it: SQLite, block-form infrastructure, every slot native. */
function rawConfig(edit: (raw: Raw) => void = () => undefined): Raw {
  const raw: Raw = {
    store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware' },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native', config: { transport: 'console' } },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3999, host: '127.0.0.1' },
    deployment: { strategy: 'standard' },
  }
  edit(raw)
  return raw
}

interface Outcome {
  started?: {
    payments: string
    security: { providerName: string | null; capabilities: string[] }
  }
  error?: { name?: string; code?: string; message: string; context: Record<string, unknown> | null }
  received: Record<string, { slot: string; config: Record<string, unknown> }>
}

async function boot(
  raw: Raw,
  opts: {
    alias?: ModuleHooks['alias']
    settings?: Array<{ slot: string; path: string; value: string }>
  } = {},
): Promise<{ outcome: Outcome; specifiers: string[] }> {
  const dir = scratch()
  const record = join(dir, 'resolved.jsonl')
  writeFileSync(record, '')
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['npm_config_user_agent']
  const { stdout } = await exec(process.execPath, [CHILD, JSON.stringify(raw)], {
    cwd: dir,
    env: {
      ...env,
      NODE_OPTIONS: moduleHooks(dir, { record, ...(opts.alias && { alias: opts.alias }) }),
      ADAPTER_RESOLUTION: JSON.stringify({ settings: opts.settings ?? [] }),
    },
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const line = stdout.split('\n').find((l) => l.startsWith('ADAPTER-RESOLUTION-OUTCOME '))
  if (line === undefined) throw new Error(`the child printed no outcome:\n${stdout}`)
  return {
    outcome: JSON.parse(line.slice('ADAPTER-RESOLUTION-OUTCOME '.length)) as Outcome,
    specifiers: [...new Set(readResolved(record).map((r) => r.specifier))].sort(),
  }
}

const withPayments = (block: Record<string, unknown>) =>
  rawConfig((raw) => {
    raw.commerce['payments'] = block
  })
const withSecurity = (security: Record<string, unknown>) =>
  rawConfig((raw) => {
    raw['security'] = security
  })

/** The specifiers that could carry a payments or security adapter: an adapter package, Stripe's SDK, a third party. */
const adapterLike = (specifiers: string[]): string[] =>
  specifiers.filter((s) => /^@nymbalhq\/(payments|security)-|^stripe$|^@acme\//.test(s))

describe('AC-4: a custom slot uses the injected adapter', () => {
  it('AC-4: through createApp, payments custom with package @nymbalhq/payments-stripe uses the injected adapter, not the package', async () => {
    const injected = {
      ...createNativeStubPaymentsAdapter({
        logger: createLogger({ pretty: false, level: 'error' }),
      }),
      providerName: 'resolution-injected',
    }
    const kernel = await createKernel({
      dialect: 'sqlite',
      configure: (config) => ({
        ...config,
        commerce: {
          ...config.commerce,
          payments: { provider: 'custom', package: '@nymbalhq/payments-stripe' },
        },
      }),
      appOptions: { adapters: { payments: injected } },
    })
    try {
      expect(kernel.app.adapters.payments).toBe(injected)
      expect(kernel.app.adapters.payments.providerName).toBe(injected.providerName)
    } finally {
      await kernel.close()
    }
  }, 60_000)
})

describe('AC-6: a typo or an unknown provider gets no install line', () => {
  it("AC-6: payments 'strpe' fails adapter.provider_unknown with did you mean 'stripe'; 'custm' suggests custom; 'acme' names package:; none prints an install verb", async () => {
    const [strpe, custm, acme] = await Promise.all(
      ['strpe', 'custm', 'acme'].map((provider) => boot(withPayments({ provider }))),
    )

    for (const [label, { outcome }] of [
      ['strpe', strpe],
      ['custm', custm],
      ['acme', acme],
    ] as const) {
      expect(outcome.started, label).toBeUndefined()
      expect(outcome.error?.code, `${label}: ${outcome.error?.message}`).toBe(
        'adapter.provider_unknown',
      )
      expect(outcome.error?.message, label).not.toMatch(INSTALL_VERB)
      expect(outcome.error?.message, label).toMatch(/\bpayments\b/)
    }
    expect(strpe.outcome.error?.message).toContain("did you mean 'stripe'")
    expect(strpe.outcome.error?.context).toMatchObject({
      slot: 'payments',
      provider: 'strpe',
      package: '@nymbalhq/payments-strpe',
      suggestion: 'stripe',
    })
    expect(custm.outcome.error?.message).toContain("did you mean 'custom'")
    expect(acme.outcome.error?.message).toContain('package:')
    expect(acme.outcome.error?.context?.['suggestion']).toBeUndefined()
  }, 120_000)
})

describe('AC-12: security.adapter resolves by the same rule', () => {
  it("AC-12: 'cloudflare' loads @nymbalhq/security-cloudflare; 'middleware' imports no security package", async () => {
    const [cloudflare, middleware] = await Promise.all([
      boot(
        withSecurity({
          adapter: 'cloudflare',
          // Never called: the adapter makes no request while the app boots.
          cloudflare: {
            zoneId: 'zone-ac12',
            apiToken: 'token-ac12',
            apiBase: 'http://127.0.0.1:9/client/v4',
          },
        }),
      ),
      boot(withSecurity({ adapter: 'middleware' })),
    ])

    expect(cloudflare.outcome.error, JSON.stringify(cloudflare.outcome.error)).toBeUndefined()
    expect(cloudflare.outcome.started?.security.capabilities).toContain('edge-rules')
    expect(cloudflare.specifiers).toContain('@nymbalhq/security-cloudflare')
    expect(middleware.outcome.error, JSON.stringify(middleware.outcome.error)).toBeUndefined()
    expect(middleware.outcome.started?.security.capabilities).not.toContain('edge-rules')
    expect(middleware.specifiers.filter((s) => s.startsWith('@nymbalhq/security-'))).toEqual([])
  }, 120_000)

  it.each(['aws-waf', 'akamai'])(
    "AC-12: '%s', uninstalled, fails adapter.provider_unknown naming security.adapter, with no install verb",
    async (adapter) => {
      const { outcome } = await boot(withSecurity({ adapter }))

      expect(outcome.error?.code, outcome.error?.message).toBe('adapter.provider_unknown')
      expect(outcome.error?.message).toMatch(/\bsecurity\b/)
      expect(outcome.error?.message).toContain(`'${adapter}'`)
      expect(outcome.error?.message).not.toMatch(INSTALL_VERB)
    },
    90_000,
  )

  it('AC-12: a third-party security adapter named by package: is loaded and built with security.config as its ctx.config', async () => {
    const config = { apiToken: 't' }
    const { outcome, specifiers } = await boot(
      withSecurity({ adapter: 'acme', package: '@acme/nymbal-security', config }),
      { alias: { '@acme/nymbal-security': SECURITY_FIXTURE } },
    )

    expect(outcome.error, JSON.stringify(outcome.error)).toBeUndefined()
    expect(outcome.started?.security.providerName).toBe('acme-security')
    expect(outcome.received['security']).toEqual({ slot: 'security', config })
    expect(adapterLike(specifiers)).toEqual(['@acme/nymbal-security'])
  }, 90_000)
})

describe('AC-14: Settings rows never choose the code a slot runs', () => {
  it('AC-14: with Settings rows naming another provider and another package for payments, createApp runs the config’s adapter and imports exactly what it imports without them', async () => {
    const raw = withPayments({ provider: 'acme', package: '@acme/nymbal-payments' })
    const alias = { '@acme/nymbal-payments': PAYMENTS_FIXTURE }
    const [without, withRows] = await Promise.all([
      boot(raw, { alias }),
      boot(raw, {
        alias,
        settings: [
          { slot: 'payments', path: 'provider', value: 'stripe' },
          { slot: 'payments', path: 'package', value: '@acme/settings-chosen' },
        ],
      }),
    ])

    expect(without.outcome.error, JSON.stringify(without.outcome.error)).toBeUndefined()
    expect(withRows.outcome.error, JSON.stringify(withRows.outcome.error)).toBeUndefined()
    expect(without.outcome.started?.payments).toBe('acme-payments')
    expect(withRows.outcome.started?.payments).toBe(without.outcome.started?.payments)
    expect(adapterLike(withRows.specifiers)).toEqual(adapterLike(without.specifiers))
    expect(adapterLike(withRows.specifiers)).toEqual(['@acme/nymbal-payments'])
  }, 120_000)
})
