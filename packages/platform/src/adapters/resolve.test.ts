import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ConfigError, type Slot } from '@nymbalhq/types'
import { checkAdapterModule, importAdapterModule, resolveChoice } from './resolve.js'

// The resolver through its importer seam: a stub importer records every specifier and either returns a module or
// throws the error Node throws for a package that is not installed (`code: 'ERR_MODULE_NOT_FOUND'`,
// "Cannot find package '<name>' imported from <parent>").
// AC-4 precedence: custom and a built-in import nothing, `package` imports exactly itself, anything else exactly
// `@nymbalhq/<kebab slot>-<provider>`. AC-5: a module that does not serve the slot and provider is refused.
// AC-6: a typo gets a suggestion and no install line. AC-7: what a failed import becomes. AC-8: the environment
// never changes what is imported.

const COMMERCE = [
  'payments',
  'email',
  'reviews',
  'search',
  'analytics',
  'shipping',
  'tax',
  'ai',
] as const
const SLOTS: readonly Slot[] = [...COMMERCE, 'documentStore', 'eventBus', 'media', 'security']
const isCommerce = (slot: Slot): boolean => (COMMERCE as readonly string[]).includes(slot)

/** Each slot's catalogue: its built-ins, and its first-party providers with the SDK each peers. */
const CATALOGUE: Record<
  Slot,
  { builtIn: readonly string[]; firstParty: Record<string, string | undefined> }
> = {
  payments: { builtIn: ['native'], firstParty: { stripe: 'stripe' } },
  email: {
    builtIn: ['native'],
    firstParty: {
      smtp: 'nodemailer',
      mailgun: 'nodemailer',
      resend: 'nodemailer',
      ses: 'nodemailer',
    },
  },
  reviews: { builtIn: ['native'], firstParty: {} },
  search: { builtIn: ['native'], firstParty: {} },
  analytics: { builtIn: ['native'], firstParty: {} },
  shipping: { builtIn: ['native'], firstParty: { easypost: undefined } },
  tax: { builtIn: ['native'], firstParty: {} },
  ai: { builtIn: ['none'], firstParty: { anthropic: '@anthropic-ai/sdk' } },
  documentStore: {
    builtIn: ['in-memory'],
    firstParty: { redis: 'ioredis', 'postgres-jsonb': 'pg' },
  },
  eventBus: { builtIn: ['in-process'], firstParty: { 'redis-streams': 'ioredis' } },
  media: { builtIn: ['local-fs'], firstParty: { s3: '@aws-sdk/client-s3' } },
  security: { builtIn: ['middleware'], firstParty: { cloudflare: undefined } },
}

/** The names a suggestion may be: the slot's catalogue, and `custom` on a commerce slot. */
const suggestable = (slot: Slot): string[] => [
  ...CATALOGUE[slot].builtIn,
  ...Object.keys(CATALOGUE[slot].firstParty),
  ...(isCommerce(slot) ? ['custom'] : []),
]

const kebab = (slot: string): string => slot.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
const convention = (slot: Slot, provider: string): string => `@nymbalhq/${kebab(slot)}-${provider}`

const INSTALL_VERB = /\b(npm install|npm i|pnpm add|yarn add|bun add)\b/
const PNPM: NodeJS.ProcessEnv = {
  npm_config_user_agent: 'pnpm/9.15.4 npm/? node/v22.23.3 darwin arm64',
}

/** Node's error for a bare specifier with nothing installed under that name. */
function notInstalled(
  specifier: string,
  parent = '/srv/store/node_modules/@nymbalhq/platform/dist/index.js',
): Error {
  return Object.assign(new Error(`Cannot find package '${specifier}' imported from ${parent}`), {
    code: 'ERR_MODULE_NOT_FOUND',
  })
}

/** An adapter module that serves `slot` and `provider`. */
function adapterModule(slot: string, provider: string) {
  return { slot, provider, createAdapter: (ctx: unknown) => ({ built: ctx }) }
}

/** An importer that records each specifier, answers from `installed`, and throws Node's not-installed error otherwise. */
function recording(installed: Record<string, unknown> = {}) {
  const imported: string[] = []
  const importer = async (specifier: string): Promise<unknown> => {
    imported.push(specifier)
    if (Object.hasOwn(installed, specifier)) return installed[specifier]
    throw notInstalled(specifier)
  }
  return { imported, importer }
}

async function rejection(promise: Promise<unknown>): Promise<ConfigError> {
  const outcome = await promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  )
  if (!('error' in outcome)) throw new Error(`resolved to ${JSON.stringify(outcome.value)}`)
  expect(outcome.error).toBeInstanceOf(ConfigError)
  return outcome.error as ConfigError
}

/** Whether `message` names `value` on its own: quoted, or not run into other name characters. */
const names = (message: string, value: string): boolean =>
  new RegExp(
    `(^|[^A-Za-z0-9-])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9-])`,
  ).test(message)

/** The packages an install line installs: its words after the verb. */
const installed = (install: unknown): string[] =>
  String(install).replace(INSTALL_VERB, '').trim().split(/\s+/).filter(Boolean)

/** Optimal string alignment distance: Damerau-Levenshtein with adjacent transpositions. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
      }
    }
  }
  return d[a.length]![b.length]!
}

const providerName = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,30}$/)
/** A name no message word is: long enough that only the value itself spells it. */
const longName = fc.stringMatching(/^[a-z][a-z0-9]{2,8}-[a-z0-9]{2,8}$/)
const packageName = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,12}$/),
    fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,20}$/),
  )
  .map(([scope, name]) => `@${scope}/${name}`)
/** A provider that is neither `custom` nor one of the slot's built-ins. */
const packagedProvider = (slot: Slot) =>
  providerName.filter((p) => p !== 'custom' && !CATALOGUE[slot].builtIn.includes(p))

describe('AC-4: which module a slot imports', () => {
  it('AC-4: custom imports nothing on every commerce slot, even with package set', async () => {
    for (const slot of COMMERCE) {
      for (const choice of [
        { provider: 'custom' },
        { provider: 'custom', package: '@acme/nymbal-x' },
      ]) {
        const { imported, importer } = recording({
          '@acme/nymbal-x': adapterModule(slot, 'custom'),
        })
        const mod = await importAdapterModule(slot, choice, {}, importer)

        expect(mod, `${slot} ${JSON.stringify(choice)}`).toBeUndefined()
        expect(imported, `${slot} ${JSON.stringify(choice)}`).toEqual([])
        expect(resolveChoice(slot, choice)).toEqual({ kind: 'custom' })
      }
    }
  })

  it('AC-4: a built-in imports nothing, on every slot', async () => {
    for (const slot of SLOTS) {
      for (const provider of CATALOGUE[slot].builtIn) {
        const { imported, importer } = recording()
        const mod = await importAdapterModule(slot, { provider }, {}, importer)

        expect(mod, `${slot} ${provider}`).toBeUndefined()
        expect(imported, `${slot} ${provider}`).toEqual([])
        expect(resolveChoice(slot, { provider })).toEqual({ kind: 'built-in' })
      }
    }
  })

  it('AC-4: with package set, exactly that specifier is imported, whatever the provider; the module it gives is the one returned', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .constantFrom(...SLOTS)
          .chain((slot) => fc.tuple(fc.constant(slot), packagedProvider(slot), packageName)),
        async ([slot, provider, pkg]) => {
          const mod = adapterModule(slot, provider)
          const { imported, importer } = recording({ [pkg]: mod })
          const got = await importAdapterModule(slot, { provider, package: pkg }, {}, importer)

          expect(imported).toEqual([pkg])
          expect(got?.createAdapter).toBe(mod.createAdapter)
          expect(resolveChoice(slot, { provider, package: pkg })).toEqual({
            kind: 'package',
            package: pkg,
            named: 'package',
          })
        },
      ),
      { numRuns: 120 },
    )
  })

  it('AC-4: without package, exactly @nymbalhq/<kebab slot>-<provider> is imported', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .constantFrom(...SLOTS)
          .chain((slot) => fc.tuple(fc.constant(slot), packagedProvider(slot))),
        async ([slot, provider]) => {
          const name = convention(slot, provider)
          const mod = adapterModule(slot, provider)
          const { imported, importer } = recording({ [name]: mod })
          const got = await importAdapterModule(slot, { provider }, {}, importer)

          expect(imported).toEqual([name])
          expect(got?.createAdapter).toBe(mod.createAdapter)
          const resolution = resolveChoice(slot, { provider })
          expect(resolution).toMatchObject({ kind: 'package', package: name, named: 'convention' })
        },
      ),
      { numRuns: 120 },
    )
  })

  it('AC-4: a first-party convention resolution carries its catalogue SDK; a package: one carries none, even for a catalogue provider', () => {
    for (const slot of SLOTS) {
      for (const [provider, sdk] of Object.entries(CATALOGUE[slot].firstParty)) {
        const conventional = resolveChoice(slot, { provider })
        const forked = resolveChoice(slot, { provider, package: '@acme/fork' })
        expect(conventional, `${slot} ${provider}`).toEqual({
          kind: 'package',
          package: convention(slot, provider),
          named: 'convention',
          ...(sdk !== undefined && { sdk }),
        })
        expect(forked, `${slot} ${provider}`).toEqual({
          kind: 'package',
          package: '@acme/fork',
          named: 'package',
        })
      }
    }
  })
})

describe('AC-5: the module must serve the slot and the provider', () => {
  const PKG = '@acme/nymbal-search'

  it('AC-5: a module whose slot export is another slot fails adapter.wrong_slot, naming the package, slot, the expected and the actual slot; through the importer too', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SLOTS),
        fc.constantFrom(...SLOTS),
        async (slot, served) => {
          fc.pre(slot !== served)
          const mod = adapterModule(served, 'acme')
          const direct = (() => {
            try {
              checkAdapterModule(mod, slot, 'acme', PKG)
              return null
            } catch (error) {
              return error
            }
          })()
          const { importer } = recording({ [PKG]: mod })
          const loaded = await rejection(
            importAdapterModule(slot, { provider: 'acme', package: PKG }, {}, importer),
          )

          for (const error of [direct, loaded]) {
            expect(error).toBeInstanceOf(ConfigError)
            const e = error as ConfigError
            expect(e.code).toBe('adapter.wrong_slot')
            expect(e.message).toContain(PKG)
            expect(e.message).toMatch(/\bslot\b/)
            expect(names(e.message, slot), e.message).toBe(true)
            expect(names(e.message, served), e.message).toBe(true)
            expect(e.context).toMatchObject({ slot, provider: 'acme', package: PKG })
          }
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-5: a module whose provider export is another provider fails adapter.package_invalid, naming the package, provider, the expected and the actual one', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SLOTS), longName, longName, (slot, wanted, served) => {
        fc.pre(wanted !== served && wanted !== 'custom')
        let error: unknown = null
        try {
          checkAdapterModule(adapterModule(slot, served), slot, wanted, PKG)
        } catch (e) {
          error = e
        }
        expect(error).toBeInstanceOf(ConfigError)
        const e = error as ConfigError
        expect(e.code).toBe('adapter.package_invalid')
        expect(e.message).toContain(PKG)
        expect(e.message).toMatch(/\bprovider\b/)
        expect(names(e.message, wanted), e.message).toBe(true)
        expect(names(e.message, served), e.message).toBe(true)
        expect(e.context).toMatchObject({ slot, provider: wanted, package: PKG })
      }),
      { numRuns: 60 },
    )
  })

  it('AC-5: no createAdapter, a createAdapter that is not a function, no slot export or no provider export each fail, naming the package and the export', () => {
    const cases: Array<{
      label: string
      mod: Record<string, unknown>
      code: string
      exported: string
    }> = [
      {
        label: 'no createAdapter',
        mod: { slot: 'search', provider: 'acme' },
        code: 'adapter.package_invalid',
        exported: 'createAdapter',
      },
      {
        label: 'createAdapter a string',
        mod: { slot: 'search', provider: 'acme', createAdapter: 'nope' },
        code: 'adapter.package_invalid',
        exported: 'createAdapter',
      },
      {
        label: 'no slot',
        mod: { provider: 'acme', createAdapter: () => ({}) },
        code: 'adapter.wrong_slot',
        exported: 'slot',
      },
      {
        label: 'no provider',
        mod: { slot: 'search', createAdapter: () => ({}) },
        code: 'adapter.package_invalid',
        exported: 'provider',
      },
    ]
    const outcomes = cases.map(({ label, mod, exported }) => {
      try {
        checkAdapterModule(mod, 'search', 'acme', PKG)
        return `${label}: accepted`
      } catch (error) {
        const e = error as ConfigError
        const named = e.message.includes(PKG) && new RegExp(`\\b${exported}\\b`).test(e.message)
        return `${label}: ${e instanceof ConfigError ? e.code : String(e)}${named ? '' : ` (message: ${e.message})`}`
      }
    })
    expect(outcomes).toEqual(cases.map(({ label, code }) => `${label}: ${code}`))
  })

  it("AC-5: for a custom block only createAdapter and slot are checked: a module exporting provider 'acme' passes, one for another slot does not", () => {
    const mod = adapterModule('search', 'acme')
    const accepted = checkAdapterModule(mod, 'search', 'custom', PKG)
    let refused: unknown = null
    try {
      checkAdapterModule(adapterModule('payments', 'acme'), 'search', 'custom', PKG)
    } catch (error) {
      refused = error
    }

    expect(accepted.createAdapter).toBe(mod.createAdapter)
    expect(refused).toBeInstanceOf(ConfigError)
    expect((refused as ConfigError).code).toBe('adapter.wrong_slot')
  })

  it('AC-5: a module that serves the slot and provider is returned with its settings', () => {
    const settings = [{ path: 'apiKey', label: 'API key', secret: true }]
    const mod = { ...adapterModule('search', 'acme'), settings }
    const checked = checkAdapterModule(mod, 'search', 'acme', PKG)

    expect(checked.settings).toEqual(settings)
    expect(checked.createAdapter).toBe(mod.createAdapter)
  })
})

describe('AC-6: a typo gets a suggestion, not an install line', () => {
  /** One edit of `name`: an insertion, deletion, substitution or adjacent transposition. */
  const oneEdit = (name: string) =>
    fc
      .tuple(
        fc.constantFrom('insert', 'delete', 'substitute', 'transpose'),
        fc.nat(),
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'),
      )
      .map(([op, at, c]) => {
        const i = at % (name.length + (op === 'insert' ? 1 : 0))
        if (op === 'insert') return name.slice(0, i) + c + name.slice(i)
        if (op === 'delete') return name.slice(0, i) + name.slice(i + 1)
        if (op === 'substitute') return name.slice(0, i) + c + name.slice(i + 1)
        const j = Math.min(i, name.length - 2)
        return name.slice(0, j) + name[j + 1]! + name[j]! + name.slice(j + 2)
      })

  it('AC-6: over every one-edit typo of a slot’s names that PROVIDER_NAME accepts, with nothing installed, the error is adapter.provider_unknown suggesting a name at distance at most 1, with no install verb', async () => {
    const typo = fc
      .constantFrom(...SLOTS)
      .chain((slot) => fc.tuple(fc.constant(slot), fc.constantFrom(...suggestable(slot))))
      .chain(([slot, name]) => fc.tuple(fc.constant(slot), oneEdit(name)))
      .filter(([slot, t]) => /^[a-z0-9][a-z0-9-]*$/.test(t) && !suggestable(slot).includes(t))

    await fc.assert(
      fc.asyncProperty(typo, async ([slot, t]) => {
        const { importer } = recording()
        const error = await rejection(importAdapterModule(slot, { provider: t }, PNPM, importer))
        const suggestion = (error.context as { suggestion?: unknown } | undefined)?.suggestion

        expect(error.code, error.message).toBe('adapter.provider_unknown')
        expect(suggestable(slot)).toContain(suggestion)
        expect(distance(String(suggestion), t)).toBeLessThanOrEqual(1)
        expect(error.message).toContain(`did you mean '${String(suggestion)}'`)
        expect(error.message).not.toMatch(INSTALL_VERB)
        expect(error.context).toMatchObject({ slot, provider: t, package: convention(slot, t) })
      }),
      { numRuns: 200 },
    )
  })

  it('AC-6: a catalogue provider whose package is not installed keeps adapter.package_missing with the package and its SDK in the install line', async () => {
    const lines: string[] = []
    for (const slot of SLOTS) {
      for (const [provider, sdk] of Object.entries(CATALOGUE[slot].firstParty)) {
        const pkg = convention(slot, provider)
        const { importer } = recording()
        const error = await rejection(importAdapterModule(slot, { provider }, PNPM, importer))
        const want = ['pnpm add', pkg, ...(sdk === undefined ? [] : [sdk])].join(' ')
        const install = (error.context as { install?: unknown } | undefined)?.install

        expect(error.code, `${slot} ${provider}: ${error.message}`).toBe('adapter.package_missing')
        expect(install, `${slot} ${provider}`).toBe(want)
        expect(error.message).toContain(want)
        expect(error.context).toMatchObject({ slot, provider, package: pkg })
        lines.push(want)
      }
    }
    expect(lines.length).toBe(
      Object.values(CATALOGUE).flatMap((c) => Object.keys(c.firstParty)).length,
    )
  })
})

describe('AC-7: what a failed import becomes', () => {
  it('AC-7: an installed package whose SDK is missing fails adapter.package_missing, installing the missing specifier, for a catalogue provider and for one the catalogue does not know', async () => {
    const cases = [
      { slot: 'payments' as const, provider: 'stripe', sdk: 'stripe' },
      { slot: 'search' as const, provider: 'acme', sdk: 'acme-index-client' },
    ]
    for (const { slot, provider, sdk } of cases) {
      const pkg = convention(slot, provider)
      const importer = async (specifier: string): Promise<unknown> => {
        throw notInstalled(sdk, `/srv/store/node_modules/${specifier}/dist/index.js`)
      }
      const error = await rejection(importAdapterModule(slot, { provider }, PNPM, importer))
      const install = (error.context as { install?: unknown } | undefined)?.install

      expect(error.code, `${slot} ${provider}: ${error.message}`).toBe('adapter.package_missing')
      expect(installed(install), `${slot} ${provider}`).toContain(sdk)
      expect(error.message).toContain(String(install))
      expect(error.context).toMatchObject({ slot, provider, package: pkg })
    }
  })

  it("AC-7: { provider: 'stripe', package: '@acme/stripe-fork' } with the fork missing installs @acme/stripe-fork alone: no @nymbalhq name and no catalogue SDK", async () => {
    const { imported, importer } = recording()
    const error = await rejection(
      importAdapterModule(
        'payments',
        { provider: 'stripe', package: '@acme/stripe-fork' },
        PNPM,
        importer,
      ),
    )
    const install = (error.context as { install?: unknown } | undefined)?.install

    expect(imported).toEqual(['@acme/stripe-fork'])
    expect(error.code).toBe('adapter.package_missing')
    expect(installed(install)).toEqual(['@acme/stripe-fork'])
    expect(error.message).not.toContain('@nymbalhq/')
    expect(error.context).toMatchObject({
      slot: 'payments',
      provider: 'stripe',
      package: '@acme/stripe-fork',
    })
  })

  it('AC-7: any other import error is rethrown unchanged, an ERR_MODULE_NOT_FOUND whose message is not Node’s shape or names a missing file inside an installed package among them', async () => {
    const thrown = fc.oneof(
      fc.string().map((m) => new Error(m)),
      fc.string().map((m) => new SyntaxError(m)),
      fc
        .string()
        .filter((m) => !/Cannot find (?:package|module) '/.test(m))
        .map((m) => Object.assign(new Error(m), { code: 'ERR_MODULE_NOT_FOUND' })),
      fc.constant(
        Object.assign(new Error('Cannot find package @nymbalhq/payments-stripe'), {
          code: 'ERR_MODULE_NOT_FOUND',
        }),
      ),
      fc
        .constantFrom('@nymbalhq/payments-stripe', '@acme/pay')
        .map((pkg) =>
          Object.assign(
            new Error(
              `Cannot find module '/abs/node_modules/${pkg}/dist/x.js' imported from /abs/node_modules/${pkg}/dist/index.js`,
            ),
            { code: 'ERR_MODULE_NOT_FOUND' },
          ),
        ),
    )
    await fc.assert(
      fc.asyncProperty(
        thrown,
        fc.constantFrom({ provider: 'stripe' }, { provider: 'acme', package: '@acme/pay' }),
        async (error, choice) => {
          const importer = async (): Promise<unknown> => {
            throw error
          }
          const outcome = await importAdapterModule('payments', choice, PNPM, importer).then(
            () => 'resolved',
            (e: unknown) => e,
          )
          expect(outcome).toBe(error)
        },
      ),
      { numRuns: 60 },
    )
  })
})

describe('AC-8: the environment never chooses what is imported', () => {
  it('AC-8: with arbitrary extra environment variables, NYMBAL_PAYMENTS_PROVIDER, NYMBAL_PAYMENTS_PACKAGE and npm_package_name among them, the imported specifiers equal those for the same config with an empty env', async () => {
    const extraEnv = fc.dictionary(
      fc.oneof(
        fc.constantFrom(
          'NYMBAL_PAYMENTS_PROVIDER',
          'NYMBAL_PAYMENTS_PACKAGE',
          'npm_package_name',
          'NYMBAL_SEARCH_PACKAGE',
          'NODE_ENV',
        ),
        fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,20}$/),
      ),
      fc.oneof(providerName, packageName, fc.string({ maxLength: 20 })),
      { maxKeys: 8 },
    )
    const choice = fc.oneof(
      fc.constantFrom(
        { provider: 'native' },
        { provider: 'stripe' },
        { provider: 'custom', package: '@acme/pay' },
      ),
      packagedProvider('payments').map((provider) => ({ provider })),
      fc
        .tuple(packagedProvider('payments'), packageName)
        .map(([provider, pkg]) => ({ provider, package: pkg })),
    )
    await fc.assert(
      fc.asyncProperty(choice, extraEnv, async (c, env) => {
        const run = async (e: NodeJS.ProcessEnv) => {
          const imported: string[] = []
          const importer = async (specifier: string): Promise<unknown> => {
            imported.push(specifier)
            return adapterModule('payments', c.provider)
          }
          await importAdapterModule('payments', c, e, importer)
          return imported
        }
        expect(await run({ ...env })).toEqual(await run({}))
      }),
      { numRuns: 120 },
    )
  })
})
