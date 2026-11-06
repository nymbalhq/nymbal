import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { HealthReport } from '@nymbalhq/types'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { diagnose, type DiagnosisReport } from '../../src/index.js'
import { createLogger } from '../../src/logger.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'
import {
  newSecretsKey,
  openStore,
  saveSetting,
  SECRETS_KEY,
  setEnv,
  settingsConfig,
  settingsConfigInput,
} from '../support/settings.js'

// AC-12: `nymbal doctor`'s `ai host` line, from the adapter diagnose builds for the ai slot: where the assistant sends
// its requests (host and port only), whether that is this machine, the store's network or remote (by name, no lookup),
// and what of a customer's data goes there under agents.assistant. It sits right after `slot ai`, is always `ok` but
// for an endpoint that is not a URL (degraded), is absent when the slot is down, and never makes doctor exit 1.

const logger = createLogger({ pretty: false, level: 'silent' })
const FIVE = ['email', 'phone', 'address', 'postcode', 'name'] as const
const DEFAULT = ['email', 'phone', 'address', 'postcode']

/** Each host the property draws, and the place its name says it is. */
const PLACES: Record<string, 'this machine' | 'your network' | 'remote'> = {
  localhost: 'this machine',
  '127.0.0.5': 'this machine',
  '[::1]': 'this machine',
  '0.0.0.0': 'this machine',
  '10.1.2.3': 'your network',
  '172.20.0.4': 'your network',
  '172.32.0.1': 'remote',
  '192.168.1.20': 'your network',
  '100.100.1.1': 'your network',
  '[fd00::1]': 'your network',
  'host.docker.internal': 'your network',
  'gpu.local': 'your network',
  ollama: 'your network',
  'api.anthropic.com': 'remote',
  'api.openai.com': 'remote',
  '8.8.8.8': 'remote',
}

let dir = ''
let sqlitePath = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-ai-host-'))
  sqlitePath = join(dir, 'store.sqlite')
  const store = createCommandStore(kernelConfig('sqlite'), { sqlitePath })
  try {
    await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  } finally {
    await store.close()
  }
})

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

/** A third party's ai adapter: `endpoint` only when given, healthy unless told otherwise. */
function customAi(endpoint: string | undefined, health: HealthReport = { status: 'healthy' }) {
  return {
    kind: 'ai',
    providerName: 'acme-ai',
    capabilities: () => ['complete', 'chat', 'tools'],
    producesEvents: [],
    consumesEvents: [],
    async initialize() {},
    async healthCheck() {
      return health
    },
    async embed(): Promise<number[][]> {
      throw new Error('not used')
    },
    async complete(): Promise<string> {
      throw new Error('not used')
    },
    async chat(): Promise<never> {
      throw new Error('not used')
    },
    ...(endpoint !== undefined && { endpoint }),
  }
}

/** The kernel config with `ai` set and agents.assistant as given (mask left out when undefined). */
function configWith(
  ai: Record<string, unknown>,
  assistant: { customerData?: boolean; mask?: readonly string[] } = {},
): NymbalConfig {
  const base = kernelConfig('sqlite')
  return {
    ...base,
    commerce: { ...base.commerce, ai },
    agents: { ...base.agents, assistant },
  } as unknown as NymbalConfig
}

async function report(config: NymbalConfig, ai?: ReturnType<typeof customAi>) {
  return diagnose(config, {
    ...(ai !== undefined && { adapters: { ai: ai as never } }),
    logger,
    timeoutMs: 5000,
    sqlitePath,
    env: {},
  })
}

/** The `ai host` lines and where they stand against `slot ai`. */
function hostLines(r: DiagnosisReport) {
  const names = r.checks.map((c) => c.name)
  return {
    lines: r.checks.filter((c) => c.name === 'ai host'),
    at: names.indexOf('ai host'),
    slot: names.indexOf('slot ai'),
  }
}

/** Whether doctor exits 1 on these checks: any one down (packages/cli/src/commands/doctor.ts). */
const exitsOne = (checks: DiagnosisReport['checks']) => checks.some((c) => c.status === 'down')

/** The detail's data part, by the Interface's rules. */
function dataOf(customerData: boolean, mask: readonly string[]): string {
  if (!customerData) return 'customer data off'
  if (mask.length === 0) return 'customer fields sent as they are'
  const listed = FIVE.filter((field) => mask.includes(field)).join(', ')
  return `customer fields masked: ${listed}; ${mask.includes('name') ? 'city and notes sent' : 'names, city and notes sent'}`
}

describe('AC-12: doctor names the AI host and what goes there', () => {
  it('AC-12: property: for a custom adapter whose endpoint is http(s)://[user:pass@]<host>[:port]/path, under any mask and customerData, exactly one ai host line stands right after slot ai, ok, reading <host[:port]> (<place>): <data>, never the scheme, user, password or path, and doctor’s exit is what it is without it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          scheme: fc.constantFrom('http', 'https'),
          user: fc.constantFrom('', 'alice:s3cret-pw@', 'svc-user@'),
          host: fc.constantFrom(...Object.keys(PLACES)),
          port: fc.constantFrom('', ':8443', ':11434'),
          path: fc.constantFrom('', '/v1', '/private-route/v1'),
          mask: fc.option(fc.subarray([...FIVE]), { nil: undefined }),
          customerData: fc.boolean(),
        }),
        async ({ scheme, user, host, port, path, mask, customerData }) => {
          const endpoint = `${scheme}://${user}${host}${port}${path}`
          const r = await report(
            configWith(
              { provider: 'custom' },
              { customerData, ...(mask !== undefined && { mask }) },
            ),
            customAi(endpoint),
          )
          const { lines, at, slot } = hostLines(r)

          expect(lines).toEqual([
            {
              name: 'ai host',
              status: 'ok',
              detail: `${host}${port} (${PLACES[host]!}): ${dataOf(customerData, mask ?? DEFAULT)}`,
            },
          ])
          expect(at).toBe(slot + 1)
          const detail = lines[0]!.detail
          expect(
            [
              `${scheme}:`,
              '//',
              's3cret-pw',
              'alice',
              'svc-user',
              ...(path === '' ? [] : [path]),
            ].filter((part) => detail.includes(part)),
          ).toEqual([])
          expect(exitsOne(r.checks)).toBe(exitsOne(r.checks.filter((c) => c.name !== 'ai host')))
        },
      ),
      { numRuns: 40 },
    )
  }, 180_000)

  it('AC-12: ai none reads none: the assistant is off; an adapter without endpoint says it does not say where it sends requests; an endpoint that is not a URL is degraded; each right after slot ai, none changes doctor’s exit, and a slot ai that is down has no ai host line', async () => {
    const cases: Array<{ config: NymbalConfig; ai?: ReturnType<typeof customAi>; line: object }> = [
      {
        config: configWith({ provider: 'none' }),
        line: { name: 'ai host', status: 'ok', detail: 'none: the assistant is off' },
      },
      {
        config: configWith({ provider: 'custom' }),
        ai: customAi(undefined),
        line: {
          name: 'ai host',
          status: 'ok',
          detail: 'custom: its adapter does not say where it sends requests',
        },
      },
      {
        config: configWith({ provider: 'custom' }),
        ai: customAi('ollama box'),
        line: { name: 'ai host', status: 'degraded', detail: 'custom: its endpoint is not a URL' },
      },
    ]
    for (const c of cases) {
      const r = await report(c.config, c.ai)
      const { lines, at, slot } = hostLines(r)

      expect(lines).toEqual([c.line])
      expect(at).toBe(slot + 1)
      expect(exitsOne(r.checks)).toBe(
        exitsOne(r.checks.filter((check) => check.name !== 'ai host')),
      )
    }

    // A slot that is down has no host to name.
    const down = await report(
      configWith({ provider: 'custom' }),
      customAi('https://api.openai.com/v1', { status: 'down', detail: 'unreachable' }),
    )
    expect(down.checks.find((c) => c.name === 'slot ai')?.status).toBe('down')
    expect(hostLines(down).lines).toEqual([])
  }, 60_000)

  it('AC-12: an openai store whose baseUrl is saved only in Settings names that host', async () => {
    const own = mkdtempSync(join(tmpdir(), 'nymbal-doctor-ai-settings-'))
    const target = join(own, 'store.sqlite')
    const key = newSecretsKey()
    const restore = setEnv({ [SECRETS_KEY]: key, OPENAI_API_KEY: undefined })
    const ai = {
      provider: 'openai',
      config: { model: 'gpt-doctor', apiKey: `sk-doctor-${'k'.repeat(24)}` },
    }
    try {
      const store = await openStore({
        dialect: 'sqlite',
        target,
        config: settingsConfig('sqlite', { ai }),
      })
      try {
        await saveSetting(await store.admin(), 'ai', 'baseUrl', 'https://llm.corp.internal:8443/v1')
      } finally {
        await store.stop()
      }

      const r = await diagnose(settingsConfigInput('sqlite', { ai }) as unknown as NymbalConfig, {
        logger,
        timeoutMs: 5000,
        sqlitePath: target,
        env: { [SECRETS_KEY]: key },
      })

      const { lines, at, slot } = hostLines(r)
      expect(lines).toEqual([
        {
          name: 'ai host',
          status: 'ok',
          detail: `llm.corp.internal:8443 (your network): ${dataOf(true, DEFAULT)}`,
        },
      ])
      expect(at).toBe(slot + 1)
    } finally {
      restore()
      rmSync(own, { recursive: true, force: true })
    }
  }, 60_000)
})
