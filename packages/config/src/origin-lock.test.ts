import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigError } from '@nymbalhq/types'
import {
  loadConfig,
  nymbalConfigSchema,
  ORIGIN_SECRET_ENV,
  resolveOriginLock,
  type NymbalConfig,
} from './index.js'

// NYMBAL_ORIGIN_SECRET turns the origin lock on: one secret, or several separated by commas while one is rotated out.
// Blank entries are dropped and a blank variable is unset. Each entry is 32 to 256 characters of
// A-Z a-z 0-9 + / = _ . ~ - (a guessable or unsendable secret is refused), and the refusal names the variable and the
// entry's position, never its text. The header the CDN sends it in is the store's to choose, but not one the CDN or
// the API already gives a meaning.

const VAR = 'NYMBAL_ORIGIN_SECRET'
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_.~-'
const CODE = 'config.origin_secret_invalid'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function rawConfig(security: Record<string, unknown> = {}) {
  return {
    store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware', ...security },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3001 },
    deployment: { strategy: 'standard' },
  }
}

const BASE: NymbalConfig = nymbalConfigSchema.parse(rawConfig())

type Outcome =
  | { lock: ReturnType<typeof resolveOriginLock> }
  | { code: string; message: string; context: Record<string, unknown> }

function outcome(env: NodeJS.ProcessEnv, config: NymbalConfig = BASE): Outcome {
  try {
    return { lock: resolveOriginLock(config, env) }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return {
      code: String(error.code),
      message: error.message,
      context: (error.context ?? {}) as Record<string, unknown>,
    }
  }
}

/** loadConfig's refusal for a project with this raw config: each issue's path, or null when it loaded. */
async function issuePaths(raw: unknown): Promise<string[] | null> {
  const dir = mkdtempSync(join(tmpdir(), 'origin-lock-config-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'nymbal.config.ts'), `export default ${JSON.stringify(raw, null, 2)}\n`)
  try {
    await loadConfig(dir)
    return null
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    const issues = ((error.context ?? {}) as { issues?: Array<{ path: PropertyKey[] }> }).issues
    return (issues ?? []).map((issue) => issue.path.map(String).join('.'))
  }
}

const distinct = (min: number) => (s: string) => new Set(s).size >= min
const unit = fc.constantFrom(...ALPHABET)
const validEntry = fc.string({ unit, minLength: 32, maxLength: 256 }).filter(distinct(8))
/** Entries the lock refuses, each distinctive enough that no message holds one by chance, none holding a comma. */
const invalidEntry = fc.oneof(
  fc.string({ unit, minLength: 12, maxLength: 31 }).filter(distinct(6)),
  fc.string({ unit, minLength: 257, maxLength: 300 }).filter(distinct(8)),
  fc
    .tuple(
      fc.string({ unit, minLength: 16, maxLength: 120 }).filter(distinct(6)),
      fc.constantFrom(' ', 'é', '"', '!', '#', '@', ';', '\\', '<', '\t'),
      fc.string({ unit, minLength: 16, maxLength: 120 }).filter(distinct(6)),
    )
    .map(([a, junk, b]) => `${a}${junk}${b}`),
)

describe('AC-1: resolveOriginLock reads NYMBAL_ORIGIN_SECRET', () => {
  it('AC-1: unset or blank is undefined; " <a> , , <b> " is { header: X-Nymbal-Origin, secrets: [a, b] }; with security.originLock.header X-Edge-Proof the header is that one', () => {
    const a = 'Aa0+/=_.~-'.repeat(4)
    const b = 'origin-secret-second-entry-Hq7Zt2Lw9Kd8'
    const edge = nymbalConfigSchema.parse(rawConfig({ originLock: { header: 'X-Edge-Proof' } }))

    expect(ORIGIN_SECRET_ENV).toBe(VAR)
    expect([outcome({}), outcome({ [VAR]: '' }), outcome({ [VAR]: '  ,  ' })]).toEqual([
      { lock: undefined },
      { lock: undefined },
      { lock: undefined },
    ])
    expect(outcome({ [VAR]: ` ${a} , , ${b} ` })).toEqual({
      lock: { header: 'X-Nymbal-Origin', secrets: [a, b] },
    })
    expect(outcome({ [VAR]: a }, edge)).toEqual({
      lock: { header: 'X-Edge-Proof', secrets: [a] },
    })
  })

  it('AC-1: an entry of 31 characters, of 257, or holding a space, é or " throws config.origin_secret_invalid naming NYMBAL_ORIGIN_SECRET and the entry’s 1-based position, and not its text', () => {
    const valid = 'v'.repeat(16) + 'Qm4Xv8Lp2Rt6Zw0K'
    const bad = [
      'Short31-Qm4Xv8Lp2Rt6Zw0KaBcDeFg',
      `Long257-${'Lw9Kd8Mx3Pb5'.repeat(21)}`.slice(0, 257),
      'has a space-Qm4Xv8Lp2Rt6Zw0KaBcDeFg',
      'accentéd-Qm4Xv8Lp2Rt6Zw0KaBcDeFgHi',
      'quote"d-Qm4Xv8Lp2Rt6Zw0KaBcDeFgHiJ',
    ]
    expect(bad.map((e) => e.length).slice(0, 2)).toEqual([31, 257])

    const refusals = bad.map((entry) => outcome({ [VAR]: `${valid},${entry}` }))

    expect(refusals.map((r) => ('code' in r ? [r.code, r.context] : r))).toEqual(
      bad.map(() => [CODE, { variable: VAR, position: 2 }]),
    )
    for (const [i, r] of refusals.entries()) {
      const message = 'message' in r ? r.message : ''
      expect(message).toContain(VAR)
      expect(message).toMatch(/\b2\b/)
      expect(message.includes(bad[i]!) || message.includes(valid)).toBe(false)
    }
  })

  it('AC-1: property: over lists of generated valid and invalid entries, a list of valid ones resolves to them in order, any invalid one is refused at the position of an invalid entry, and no refusal’s message or context holds any entry’s text', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            validEntry.map((text) => ({ text, valid: true })),
            invalidEntry.map((text) => ({ text, valid: false })),
          ),
          { minLength: 1, maxLength: 4 },
        ),
        (entries) => {
          const result = outcome({ [VAR]: entries.map((e) => e.text).join(',') })
          const invalidAt = entries.flatMap((e, i) => (e.valid ? [] : [i + 1]))

          const observed =
            'lock' in result
              ? result
              : {
                  code: result.code,
                  variable: result.context['variable'],
                  atAnInvalidEntry: invalidAt.includes(result.context['position'] as number),
                  leaked: entries.filter((e) =>
                    `${result.message}\n${JSON.stringify(result.context)}`.includes(e.text),
                  ),
                }

          expect(observed).toEqual(
            invalidAt.length === 0
              ? { lock: { header: 'X-Nymbal-Origin', secrets: entries.map((e) => e.text) } }
              : { code: CODE, variable: VAR, atAnInvalidEntry: true, leaked: [] },
          )
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('AC-1: security.originLock.header', () => {
  it('AC-1: loadConfig refuses a header of "", "bad header", Host, X-Forwarded-For, x-forwarded-host, CF-Ray, X-Nymbal-Shopper or X-Correlation-Id with an issue at security.originLock.header, and loads X-Edge-Proof', async () => {
    const refused = [
      '',
      'bad header',
      'Host',
      'X-Forwarded-For',
      'x-forwarded-host',
      'CF-Ray',
      'X-Nymbal-Shopper',
      'X-Correlation-Id',
    ]
    const paths = await Promise.all(
      refused.map((header) => issuePaths(rawConfig({ originLock: { header } }))),
    )
    const accepted = await issuePaths(rawConfig({ originLock: { header: 'X-Edge-Proof' } }))

    expect(paths).toEqual(refused.map(() => ['security.originLock.header']))
    expect(accepted).toBeNull()
    expect(BASE.security).toMatchObject({ originLock: { header: 'X-Nymbal-Origin' } })
  })
})
