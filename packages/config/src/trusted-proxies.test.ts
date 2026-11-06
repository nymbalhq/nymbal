import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigError, type SecurityNetwork } from '@nymbalhq/types'
import { loadConfig, nymbalConfigSchema, type NymbalConfig } from './index.js'
import { resolveTrustedProxies, trustSuggestion } from './trusted-proxies.js'

// Which peers may tell the API a client's address: the store lists its proxies (NYMBAL_TRUSTED_PROXIES over
// http.trustedProxies, then a security adapter's contribution, then `loopback`), and may name one client-address header
// read from them. A list proxy-addr would refuse at Fastify construction is a ConfigError here, naming the entry and
// where it came from; trusting every address is refused outright, and the removed hop count refuses to start.

const LIST_VAR = 'NYMBAL_TRUSTED_PROXIES'
const HEADER_VAR = 'NYMBAL_CLIENT_IP_HEADER'
const HOPS_VAR = 'NYMBAL_TRUST_PROXY_HOPS'
const PRESETS = ['loopback', 'linklocal', 'uniquelocal'] as const

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function rawConfig(http: Record<string, unknown> = {}) {
  return {
    store: { name: 'Shop', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware' },
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
    http: { adapter: 'fastify', port: 3001, ...http },
    deployment: { strategy: 'standard' },
  }
}

const BASE: NymbalConfig = nymbalConfigSchema.parse(rawConfig())

/**
 * The parsed default config with the two network keys set as given, past the schema: the resolver checks what it is
 * handed whatever the schema let through.
 */
function configWith(network: { trustedProxies?: string[]; clientIpHeader?: string }): NymbalConfig {
  return { ...BASE, http: { ...BASE.http, ...network } }
}

/** loadConfig's rejection message for a project with this raw config, or null when it loaded. */
async function rejectionOf(raw: unknown): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'trusted-proxies-config-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'nymbal.config.ts'), `export default ${JSON.stringify(raw, null, 2)}\n`)
  try {
    await loadConfig(dir)
    return null
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return error.message
  }
}

type Outcome =
  | { resolved: ReturnType<typeof resolveTrustedProxies> }
  | { code: string; message: string; context: Record<string, unknown> }

function outcome(
  config: NymbalConfig,
  env: NodeJS.ProcessEnv,
  contribution?: { adapter: string; network: SecurityNetwork },
): Outcome {
  try {
    return { resolved: resolveTrustedProxies(config, env, contribution) }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return {
      code: error.code,
      message: error.message,
      context: (error.context ?? {}) as Record<string, unknown>,
    }
  }
}

const refusal = (o: Outcome) => ('code' in o ? o : null)

// ─── generators ──────────────────────────────────────────────────────────────────────────────────────────────────────

const hextet = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16))
/** A full eight-hextet IPv6 address, never IPv4-mapped (proxy-addr would read its prefix as an IPv4 one). */
const ipv6 = fc
  .array(hextet, { minLength: 8, maxLength: 8 })
  .filter((h) => !(h.slice(0, 5).every((x) => x === '0') && h[5] === 'ffff'))
  .map((h) => h.join(':'))
const ipv4 = fc.ipV4()
const validEntry = fc.oneof(
  fc.constantFrom(...PRESETS),
  ipv4,
  ipv6,
  fc.tuple(ipv4, fc.integer({ min: 1, max: 32 })).map(([a, p]) => `${a}/${p}`),
  fc.tuple(ipv6, fc.integer({ min: 1, max: 128 })).map(([a, p]) => `${a}/${p}`),
)
const word = fc
  .stringMatching(/^[a-z]{3,12}$/)
  .filter((w) => !(PRESETS as readonly string[]).includes(w))
const malformedEntry = fc.oneof(
  fc.constant(''),
  word,
  fc.constantFrom('loopbak', 'localhost', 'uniqelocal', 'link-local'),
  fc
    .tuple(fc.integer({ min: 256, max: 999 }), fc.integer({ min: 0, max: 255 }))
    .map(([a, b]) => `${a}.${b}.1.1`),
  fc.tuple(ipv4, fc.integer({ min: 33, max: 99 })).map(([a, p]) => `${a}/${p}`),
  fc.tuple(ipv6, fc.integer({ min: 129, max: 300 })).map(([a, p]) => `${a}/${p}`),
)
const headerName = fc
  .stringMatching(/^[A-Za-z][A-Za-z0-9-]{1,20}$/)
  .filter((h) => !['x-forwarded-for', 'forwarded'].includes(h.toLowerCase()))
const validList = fc.array(validEntry, { minLength: 1, maxLength: 4 })

describe('AC-3: the trusted proxy list resolves from the variable, then the config, then loopback', () => {
  it("AC-3: unset everywhere is ['loopback'] from the default; http.trustedProxies is that list from the config; a padded NYMBAL_TRUSTED_PROXIES replaces any config list, trimmed; a blank variable is unset", () => {
    const fromConfig = ['uniquelocal', '198.51.100.10']
    const unset = resolveTrustedProxies(BASE, {})
    const configured = resolveTrustedProxies(configWith({ trustedProxies: fromConfig }), {})
    const variable = { [LIST_VAR]: ' uniquelocal , 10.0.0.5 ' }
    const overDefault = resolveTrustedProxies(BASE, variable)
    const overConfig = resolveTrustedProxies(configWith({ trustedProxies: fromConfig }), variable)
    const blanks = ['', '   '].map((blank) =>
      resolveTrustedProxies(configWith({ trustedProxies: fromConfig }), { [LIST_VAR]: blank }),
    )

    expect(unset.trustedProxies).toEqual(['loopback'])
    expect(unset.trustedProxiesSource).toEqual({ kind: 'default', name: 'default' })
    expect(configured.trustedProxies).toEqual(fromConfig)
    expect(configured.trustedProxiesSource).toEqual({ kind: 'config', name: 'http.trustedProxies' })
    expect(overDefault.trustedProxies).toEqual(['uniquelocal', '10.0.0.5'])
    expect(overConfig.trustedProxies).toEqual(overDefault.trustedProxies)
    expect(overConfig.trustedProxiesSource).toEqual({ kind: 'env', name: LIST_VAR })
    expect(blanks.map((b) => b.trustedProxies)).toEqual([fromConfig, fromConfig])
    expect(blanks.map((b) => b.trustedProxiesSource.kind)).toEqual(['config', 'config'])
  })

  it('AC-3: each invalid entry (10.0.0.0/33, 300.1.1.1, fe80::/129, localhost, loopbak, an empty one) throws config.trusted_proxies_invalid naming the entry and its source, from the variable and from the config', () => {
    const entries = ['10.0.0.0/33', '300.1.1.1', 'fe80::/129', 'localhost', 'loopbak', '']
    for (const entry of entries) {
      const fromConfig = refusal(outcome(configWith({ trustedProxies: ['loopback', entry] }), {}))
      expect(fromConfig?.code, `config ${JSON.stringify(entry)}`).toBe(
        'config.trusted_proxies_invalid',
      )
      expect(fromConfig?.context).toMatchObject({ entry, source: 'http.trustedProxies' })
      expect(fromConfig?.message).toContain('http.trustedProxies')
      if (entry === '') continue
      const fromEnv = refusal(outcome(BASE, { [LIST_VAR]: `loopback,${entry}` }))
      expect(fromEnv?.code, `env ${entry}`).toBe('config.trusted_proxies_invalid')
      expect(fromEnv?.context).toMatchObject({ entry, source: LIST_VAR })
      expect(fromEnv?.message).toContain(entry)
      expect(fromEnv?.message).toContain(LIST_VAR)
      expect(fromConfig?.message).toContain(entry)
    }
  })

  it("AC-3: empty segments in NYMBAL_TRUSTED_PROXIES are ignored ('loopback,' is ['loopback']), while an empty string in http.trustedProxies is config.trusted_proxies_invalid", () => {
    const fromConfig = ['uniquelocal']
    const segments = ['loopback,', ',loopback', 'loopback, ,10.0.0.5,', ' , loopback ,, ']
    const resolved = segments.map(
      (value) =>
        resolveTrustedProxies(configWith({ trustedProxies: fromConfig }), { [LIST_VAR]: value })
          .trustedProxies,
    )
    const emptyInConfig = refusal(outcome(configWith({ trustedProxies: ['loopback', ''] }), {}))

    expect(resolved).toEqual([['loopback'], ['loopback'], ['loopback', '10.0.0.5'], ['loopback']])
    expect(emptyInConfig?.code).toBe('config.trusted_proxies_invalid')
    expect(emptyInConfig?.context).toMatchObject({ entry: '', source: 'http.trustedProxies' })
  })

  it('AC-3: the same invalid entries in nymbal.config.ts fail loadConfig with a ConfigError naming http.trustedProxies, and a valid list loads as given', async () => {
    const entries = ['10.0.0.0/33', '300.1.1.1', 'fe80::/129', 'localhost', 'loopbak', '']
    const messages: Array<string | null> = []
    for (const entry of entries) {
      messages.push(await rejectionOf(rawConfig({ trustedProxies: ['loopback', entry] })))
    }
    const valid = await rejectionOf(rawConfig({ trustedProxies: ['loopback', '10.0.0.0/8'] }))

    expect(
      messages.map((m) => m?.includes('http.trustedProxies') ?? false),
      String(messages),
    ).toEqual(entries.map(() => true))
    expect(valid).toBeNull()
  })

  it('AC-3: 0.0.0.0/0 or ::/0, from the variable or the config, throws config.trusted_proxies_everyone under NODE_ENV production, development and unset; loadConfig refuses it too', async () => {
    const codes: string[] = []
    for (const everyone of ['0.0.0.0/0', '::/0']) {
      for (const nodeEnv of ['production', 'development', undefined]) {
        const env = nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }
        codes.push(refusal(outcome(BASE, { ...env, [LIST_VAR]: everyone }))?.code ?? 'resolved')
        codes.push(
          refusal(outcome(configWith({ trustedProxies: [everyone] }), env))?.code ?? 'resolved',
        )
      }
    }
    const loaded = await rejectionOf(rawConfig({ trustedProxies: ['0.0.0.0/0'] }))

    expect(codes).toEqual(codes.map(() => 'config.trusted_proxies_everyone'))
    expect(loaded).not.toBeNull()
    expect(loaded).toContain('http.trustedProxies')
  })

  it('AC-3: an IPv4-mapped range of /96 or wider (::ffff:0.0.0.0/96, ::ffff:10.0.0.0/96, ::ffff:0:0/80), from the variable or the config, throws config.trusted_proxies_everyone naming the entry, while a narrower mapped range resolves', () => {
    const mapped = [
      '::ffff:0.0.0.0/96',
      '::ffff:10.0.0.0/96',
      '0:0:0:0:0:ffff:0:0/96',
      '::ffff:0:0/80',
    ]
    const refused = mapped.flatMap((entry) => [
      refusal(outcome(BASE, { [LIST_VAR]: entry })),
      refusal(outcome(configWith({ trustedProxies: [entry] }), {})),
    ])
    const narrower = outcome(BASE, { [LIST_VAR]: '::ffff:10.0.0.0/104' })

    expect(refused.map((r) => r?.code)).toEqual(
      refused.map(() => 'config.trusted_proxies_everyone'),
    )
    expect(refused.map((r) => r?.context['entry'])).toEqual(mapped.flatMap((e) => [e, e]))
    expect('resolved' in narrower ? narrower.resolved.trustedProxies : narrower).toEqual([
      '::ffff:10.0.0.0/104',
    ])
  })

  it('AC-3: property: every generated valid entry (preset, IPv4, IPv6, CIDR with a prefix from 1 to the maximum) resolves as given, from the variable and the config; every malformed one is refused as config.trusted_proxies_invalid naming it', () => {
    fc.assert(
      fc.property(validList, malformedEntry, (list, bad) => {
        const viaEnv = outcome(BASE, { [LIST_VAR]: list.join(',') })
        const viaConfig = outcome(configWith({ trustedProxies: list }), {})
        const refused = refusal(outcome(configWith({ trustedProxies: [...list, bad] }), {}))

        expect('resolved' in viaEnv ? viaEnv.resolved.trustedProxies : viaEnv).toEqual(list)
        expect('resolved' in viaConfig ? viaConfig.resolved.trustedProxies : viaConfig).toEqual(
          list,
        )
        expect(refused?.code).toBe('config.trusted_proxies_invalid')
        expect(refused?.context['entry']).toBe(bad)
      }),
      { numRuns: 300 },
    )
  })
})

describe('AC-4: the hop count is removed', () => {
  it('AC-4: http.trustProxy set to true, false, 0 or 1 fails loadConfig with a ConfigError naming http.trustedProxies', async () => {
    const values = [true, false, 0, 1]
    const messages: Array<string | null> = []
    for (const trustProxy of values) messages.push(await rejectionOf(rawConfig({ trustProxy })))
    const without = await rejectionOf(rawConfig())

    expect(without).toBeNull()
    expect(
      messages.map((m) => m?.includes('http.trustedProxies') ?? false),
      String(messages),
    ).toEqual(values.map(() => true))
    expect(messages.map((m) => m?.includes('http.trustProxy') ?? false)).toEqual(
      values.map(() => true),
    )
  })

  it('AC-4: NYMBAL_TRUST_PROXY_HOPS of 0, 1 or x throws config.trust_proxy_hops_removed naming NYMBAL_TRUSTED_PROXIES, whatever else is set; a blank one is ignored', () => {
    const refused = ['0', '1', 'x'].flatMap((hops) => [
      refusal(outcome(BASE, { [HOPS_VAR]: hops })),
      refusal(outcome(BASE, { [HOPS_VAR]: hops, [LIST_VAR]: 'uniquelocal' })),
    ])
    const blank = ['', '  '].map((hops) => outcome(BASE, { [HOPS_VAR]: hops }))

    expect(refused.map((r) => r?.code)).toEqual(
      refused.map(() => 'config.trust_proxy_hops_removed'),
    )
    expect(refused.map((r) => r?.message.includes(LIST_VAR))).toEqual(refused.map(() => true))
    expect(refused.map((r) => r?.context['variable'])).toEqual(refused.map(() => HOPS_VAR))
    expect(blank.map((b) => ('resolved' in b ? b.resolved.trustedProxies : b))).toEqual([
      ['loopback'],
      ['loopback'],
    ])
  })
})

describe('AC-5: trustSuggestion names the preset that holds an address', () => {
  const octet = fc.integer({ min: 0, max: 255 })
  const v4 = (a: number, b: fc.Arbitrary<number> = octet) =>
    fc.tuple(b, octet, octet).map(([x, y, z]) => `${a}.${x}.${y}.${z}`)
  const inPreset: Array<[string, fc.Arbitrary<string>]> = [
    ['loopback', v4(127)],
    ['loopback', fc.constant('::1')],
    ['uniquelocal', v4(10)],
    ['uniquelocal', v4(172, fc.integer({ min: 16, max: 31 }))],
    ['uniquelocal', v4(192, fc.constant(168))],
    [
      'uniquelocal',
      fc
        .tuple(
          fc.integer({ min: 0xfc00, max: 0xfdff }),
          fc.array(hextet, { minLength: 7, maxLength: 7 }),
        )
        .map(([first, rest]) => [first.toString(16), ...rest].join(':')),
    ],
    ['linklocal', v4(169, fc.constant(254))],
    [
      'linklocal',
      fc
        .tuple(
          fc.integer({ min: 0xfe80, max: 0xfebf }),
          fc.array(hextet, { minLength: 7, maxLength: 7 }),
        )
        .map(([first, rest]) => [first.toString(16), ...rest].join(':')),
    ],
  ]
  /** Outside every preset: public IPv4 first octets and global unicast IPv6 (2000::/3). */
  const outside = fc.oneof(
    fc
      .tuple(fc.constantFrom(1, 8, 23, 45, 100, 151, 185, 198, 203, 223), octet, octet, octet)
      .map((o) => o.join('.')),
    fc
      .tuple(
        fc.integer({ min: 0x2000, max: 0x3fff }),
        fc.array(hextet, { minLength: 7, maxLength: 7 }),
      )
      .map(([first, rest]) => [first.toString(16), ...rest].join(':')),
  )

  it('AC-5: property: an address in 127/8 or ::1 is loopback, in 10/8, 172.16/12, 192.168/16 or fc00::/7 uniquelocal, in 169.254/16 or fe80::/10 linklocal, the IPv4 ones mapped (::ffff:a.b.c.d) the same preset, and any other address is itself', () => {
    fc.assert(
      fc.property(
        fc.oneof(...inPreset.map(([preset, arb]) => arb.map((address) => ({ preset, address })))),
        outside,
        ({ preset, address }, other) => {
          // An IPv4 address mapped into IPv6 (::ffff:a.b.c.d) is held by the same preset.
          const mapped = address.includes('.') ? `::ffff:${address}` : address
          expect(trustSuggestion(address)).toBe(preset)
          expect(trustSuggestion(mapped)).toBe(preset)
          expect(trustSuggestion(other)).toBe(other)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('AC-6: the client-address header name', () => {
  it('AC-6: a clientIpHeader of X-Forwarded-For, forwarded, an empty name or "bad header", from the config or the variable, throws config.client_ip_header_invalid; True-Client-IP resolves', () => {
    const bad = ['X-Forwarded-For', 'forwarded', '', 'bad header']
    const fromConfig = bad.map((h) => refusal(outcome(configWith({ clientIpHeader: h }), {}))?.code)
    const fromEnv = bad
      .filter((h) => h !== '')
      .map((h) => refusal(outcome(BASE, { [HEADER_VAR]: h }))?.code)
    const good = outcome(configWith({ clientIpHeader: 'True-Client-IP' }), {})

    expect(fromConfig).toEqual(bad.map(() => 'config.client_ip_header_invalid'))
    expect(fromEnv).toEqual(fromEnv.map(() => 'config.client_ip_header_invalid'))
    expect(fromEnv).toHaveLength(3)
    expect('resolved' in good ? good.resolved.clientIpHeader?.toLowerCase() : good).toBe(
      'true-client-ip',
    )
  })
})

describe('AC-14: a security adapter contributes below what the store sets', () => {
  const ADAPTER = 'fixture'
  const LIST_SOURCES = {
    env: { kind: 'env', name: LIST_VAR },
    config: { kind: 'config', name: 'http.trustedProxies' },
    adapter: { kind: 'adapter', name: ADAPTER },
    default: { kind: 'default', name: 'default' },
  } as const
  const HEADER_SOURCES = {
    env: { kind: 'env', name: HEADER_VAR },
    config: { kind: 'config', name: 'http.clientIpHeader' },
    adapter: { kind: 'adapter', name: ADAPTER },
  } as const
  const layer = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined })

  it('AC-14: property: over which of the variable, the config key and the contribution set each of the list and the header, each resolves on its own to the first set of variable, config, adapter, else the default, its source names that one, and clientIpRequiresLock is true exactly when the header in effect is the adapter’s and it set the flag', () => {
    fc.assert(
      fc.property(
        fc.record({
          envList: layer(validList),
          configList: layer(validList),
          adapterList: layer(validList),
          envHeader: layer(headerName),
          configHeader: layer(headerName),
          adapterHeader: layer(headerName),
          lock: fc.option(fc.boolean(), { nil: undefined }),
        }),
        (c) => {
          const env: NodeJS.ProcessEnv = {
            ...(c.envList !== undefined && { [LIST_VAR]: c.envList.join(',') }),
            ...(c.envHeader !== undefined && { [HEADER_VAR]: c.envHeader }),
          }
          const config = configWith({
            ...(c.configList !== undefined && { trustedProxies: c.configList }),
            ...(c.configHeader !== undefined && { clientIpHeader: c.configHeader }),
          })
          const network: SecurityNetwork = {
            ...(c.adapterList !== undefined && { trustedProxies: c.adapterList }),
            ...(c.adapterHeader !== undefined && { clientIpHeader: c.adapterHeader }),
            ...(c.lock !== undefined && { clientIpRequiresLock: c.lock }),
          }
          const listFrom =
            c.envList !== undefined
              ? 'env'
              : c.configList !== undefined
                ? 'config'
                : c.adapterList !== undefined
                  ? 'adapter'
                  : 'default'
          const headerFrom =
            c.envHeader !== undefined
              ? 'env'
              : c.configHeader !== undefined
                ? 'config'
                : c.adapterHeader !== undefined
                  ? 'adapter'
                  : undefined
          const expectedList = {
            env: c.envList,
            config: c.configList,
            adapter: c.adapterList,
            default: ['loopback'],
          }[listFrom]
          const expectedHeader =
            headerFrom === undefined
              ? undefined
              : { env: c.envHeader, config: c.configHeader, adapter: c.adapterHeader }[headerFrom]

          const r = resolveTrustedProxies(config, env, { adapter: ADAPTER, network })

          expect(r.trustedProxies).toEqual(expectedList)
          expect(r.trustedProxiesSource).toEqual(LIST_SOURCES[listFrom])
          expect(r.clientIpHeader?.toLowerCase()).toBe(expectedHeader?.toLowerCase())
          expect(r.clientIpHeaderSource).toEqual(
            headerFrom === undefined ? undefined : HEADER_SOURCES[headerFrom],
          )
          expect(r.clientIpRequiresLock).toBe(headerFrom === 'adapter' && c.lock === true)
        },
      ),
      { numRuns: 400 },
    )
  })

  it('AC-14: an invalid contribution (an entry 10.0.0.0/33, or a header X-Forwarded-For) throws the code the same value throws from the config, naming adapter fixture', () => {
    const list = refusal(
      outcome(BASE, {}, { adapter: ADAPTER, network: { trustedProxies: ['10.0.0.0/33'] } }),
    )
    const header = refusal(
      outcome(BASE, {}, { adapter: ADAPTER, network: { clientIpHeader: 'X-Forwarded-For' } }),
    )
    const listFromConfig = refusal(outcome(configWith({ trustedProxies: ['10.0.0.0/33'] }), {}))
    const headerFromConfig = refusal(outcome(configWith({ clientIpHeader: 'X-Forwarded-For' }), {}))

    expect(list?.code).toBe(listFromConfig?.code)
    expect(header?.code).toBe(headerFromConfig?.code)
    expect([list?.code, header?.code]).toEqual([
      'config.trusted_proxies_invalid',
      'config.client_ip_header_invalid',
    ])
    expect(list?.context).toMatchObject({ entry: '10.0.0.0/33', source: `adapter ${ADAPTER}` })
    expect([list?.message, header?.message].map((m) => m?.includes(`adapter ${ADAPTER}`))).toEqual([
      true,
      true,
    ])
  })
})

describe('AC-15: a contribution of nothing changes nothing', () => {
  it('AC-15: property: for any variable and config, a contribution absent, or one whose network is {}, resolves equal to no contribution, and no source is the adapter', () => {
    fc.assert(
      fc.property(
        fc.option(validList, { nil: undefined }),
        fc.option(validList, { nil: undefined }),
        fc.option(headerName, { nil: undefined }),
        (envList, configList, header) => {
          const env: NodeJS.ProcessEnv = {
            ...(envList !== undefined && { [LIST_VAR]: envList.join(',') }),
            ...(header !== undefined && { [HEADER_VAR]: header }),
          }
          const config = configWith(configList === undefined ? {} : { trustedProxies: configList })
          const alone = resolveTrustedProxies(config, env)
          const absent = resolveTrustedProxies(config, env, undefined)
          const empty = resolveTrustedProxies(config, env, { adapter: 'middleware', network: {} })

          expect(absent).toEqual(alone)
          expect(empty).toEqual(alone)
          expect([empty.trustedProxiesSource.kind, empty.clientIpHeaderSource?.kind]).not.toContain(
            'adapter',
          )
          expect(empty.clientIpRequiresLock).toBe(false)
        },
      ),
      { numRuns: 200 },
    )
  })
})
