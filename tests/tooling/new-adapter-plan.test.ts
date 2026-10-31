// Reads: scripts/new-adapter.ts, registry/adapters.json, package.json, packages/platform/package.json
// Reads: packages/adapters/*/*/package.json, packages/create-app/scripts/sync-scaffold.mjs, tests/contracts/*.test.ts
// Reads: tests/support/*.ts, tests/fixtures/third-party-search/*
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  ADAPTER_CATALOGUE,
  PROVIDER_NAME,
  type CatalogueEntry,
} from '../../packages/config/src/adapter-names'
import type { Slot } from '../../packages/types/src/index'
import { NewAdapterError, SOURCES, planAdapter } from '../../scripts/new-adapter'
import { privateWords } from '../architecture/private-words'
import { NO_INSTALL } from './vitest-report'
import { REPO, gitIn, removeCopies, resetCopy, shell, workTreeCopy } from './work-tree-copy'

// The scaffold's plan, read without applying it. AC-1: from any starting point, for any new provider name, the plan is
// the source package's tracked files less its changelog and recipes, plus the source table's outside files, renamed so
// that no spelling of the source provider is left outside the protected specifiers; one changeset bumps the new package
// and @nymbalhq/config; and the five list files each gain the one entry, sorted. AC-2: every refusal is one line and
// writes nothing. AC-5: `--from` normalises a third-party package into the repository's layout. AC-6: the script, what it
// prints and the changeset it writes carry none of the private process's words.

/** The plan as the interface gives it: files to write, and edits of existing files from what they hold now. */
interface Plan {
  files: Array<{ path: string; content: string }>
  edits: Array<{ path: string; before: string; after: string }>
}
interface PlanInput {
  slot: string
  provider: string
  fromProvider?: string
  fromDir?: string
}

/** The plan, whether planAdapter returns it or a promise of it. */
const plan = (input: PlanInput, repo: string): Promise<Plan> =>
  Promise.resolve().then(
    () => planAdapter(input as Parameters<typeof planAdapter>[0], repo) as Plan,
  )

/** What planAdapter threw, or undefined when it returned a plan. */
async function refusal(input: PlanInput, repo: string): Promise<unknown> {
  try {
    await plan(input, repo)
    return undefined
  } catch (error) {
    return error
  }
}

/** The source table's starting points: the slot folder, the provider, its identifier spelling and outside files. */
interface StartingPoint {
  slot: string
  provider: string
  ident: string
  outside: readonly string[]
}

const STARTING_POINTS: readonly StartingPoint[] = [
  {
    slot: 'email',
    provider: 'mailgun',
    ident: 'Mailgun',
    outside: ['tests/contracts/mailgun-email-feedback.test.ts', 'tests/support/mailgun.ts'],
  },
  {
    slot: 'email',
    provider: 'resend',
    ident: 'Resend',
    outside: ['tests/contracts/resend-email-feedback.test.ts', 'tests/support/resend.ts'],
  },
  {
    slot: 'email',
    provider: 'ses',
    ident: 'Ses',
    outside: ['tests/contracts/ses-email-feedback.test.ts', 'tests/support/ses.ts'],
  },
  {
    slot: 'email',
    provider: 'smtp',
    ident: 'Smtp',
    outside: ['tests/contracts/smtp-email.test.ts'],
  },
  {
    slot: 'payments',
    provider: 'stripe',
    ident: 'Stripe',
    outside: ['tests/contracts/stripe-payments.test.ts', 'tests/contracts/stripe-refunds.test.ts'],
  },
  {
    slot: 'search',
    provider: 'algolia',
    ident: 'Algolia',
    outside: ['tests/contracts/algolia-search.test.ts'],
  },
  {
    slot: 'security',
    provider: 'cloudflare',
    ident: 'Cloudflare',
    outside: ['tests/contracts/cloudflare-security.test.ts'],
  },
  {
    slot: 'shipping',
    provider: 'easypost',
    ident: 'EasyPost',
    outside: ['tests/contracts/easypost-shipping-tracking.test.ts', 'tests/support/easypost.ts'],
  },
]

/** The five files a scaffold edits. */
const EDITED = [
  'package.json',
  'packages/config/src/adapter-names.ts',
  'packages/create-app/scripts/sync-scaffold.mjs',
  'packages/platform/package.json',
  'registry/adapters.json',
]

/** SDK module specifiers and the shared fakes, which a copy imports unchanged. */
const PROTECTED_SDKS = [
  'stripe',
  'nodemailer',
  '@anthropic-ai/sdk',
  '@aws-sdk/client-s3',
  'pg',
  'ioredis',
]
const SHARED_FAKES = [
  'support/smtp-server',
  'support/tcp-proxy',
  'support/fake-stripe',
  'stripe-api/',
]

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const isProtectedSpecifier = (spec: string): boolean =>
  PROTECTED_SDKS.some((sdk) => spec === sdk || spec.startsWith(`${sdk}/`)) ||
  SHARED_FAKES.some((fake) => spec.includes(fake))

const QUOTED = /(['"])((?:(?!\1)[^\n\\])*)\1/g
const IMPORT = /\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2/g

/**
 * A quoted string that is the source provider's own name where no module or dependency is named (not an import, a
 * mock, a require or a manifest key) is the provider's name, as in stripe's `provider = 'stripe'`, not its SDK.
 */
const namesProvider = (text: string, at: number, quoted: string, provider: string): boolean =>
  quoted.slice(1, -1) === provider &&
  !/(?:\bfrom\s+|\bimport\s*\(?\s*|\bmock\(\s*|\brequire\(\s*)$/.test(text.slice(0, at)) &&
  !/^\s*:/.test(text.slice(at + quoted.length))

/**
 * The text a rename must reach: the protected parts taken out. Those are the quoted SDK specifiers and shared-fake
 * paths (and so the manifest's SDK keys), the names a file binds from them, and every @nymbalhq name but the source's.
 */
function unprotected(text: string, sourcePackage: string, provider: string): string {
  const bound = [...text.matchAll(IMPORT)]
    .filter((m) => isProtectedSpecifier(m[3]!))
    .flatMap((m) => m[1]!.match(/[A-Za-z_$][\w$]*/g) ?? [])
    .filter((name) => name !== 'type' && name !== 'as')
  let out = text.replace(QUOTED, (all, _q: string, value: string, at: number) =>
    isProtectedSpecifier(value) && !namesProvider(text, at, all, provider) ? '""' : all,
  )
  out = out.replace(/@nymbalhq\/[a-z0-9-]+/g, (name) => (name === sourcePackage ? name : ''))
  for (const name of new Set(bound)) out = out.replace(new RegExp(`\\b${escape(name)}\\b`, 'g'), '')
  return out
}

/** The source provider's spellings: lower, its identifier spelling and UPPER, each as a whole token. */
function spellings(source: StartingPoint): RegExp[] {
  return [
    new RegExp(`(?<![a-z])${escape(source.provider)}(?![a-z])`),
    new RegExp(`(?<![A-Z])${escape(source.ident)}(?![a-z])`),
    new RegExp(`(?<![A-Z])${escape(source.provider.toUpperCase())}(?![A-Z])`),
  ]
}

/** A source path with the provider's lower spelling renamed. */
const renamePath = (path: string, source: StartingPoint, provider: string): string =>
  path.replace(new RegExp(`(?<![a-z])${escape(source.provider)}(?![a-z])`, 'g'), provider)

const trackedCache = new Map<string, string[]>()
const tracked = (dir: string): string[] => {
  const cached = trackedCache.get(dir)
  if (cached !== undefined) return cached
  const files = execFileSync('git', ['ls-files', '--', dir], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  trackedCache.set(dir, files)
  return files
}

const readRepo = (path: string): string => readFileSync(join(REPO, path), 'utf8')

const fileOf = (p: Plan, path: string): { path: string; content: string } | undefined =>
  p.files.find((f) => f.path === path)
const editOf = (
  p: Plan,
  path: string,
): { path: string; before: string; after: string } | undefined =>
  p.edits.find((e) => e.path === path)

/** A changeset's frontmatter, as package → bump, and its body's non-empty lines. */
function parseChangeset(text: string): { bumps: Record<string, string>; body: string[] } {
  const [, front = '', body = ''] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text) ?? []
  const bumps = Object.fromEntries(
    front
      .split('\n')
      .map((l) => /^\s*['"]?([^'":]+)['"]?\s*:\s*(\w+)\s*$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1]!, m[2]!]),
  )
  return { bumps, body: body.split('\n').filter((l) => l.trim() !== '') }
}

const isSorted = (xs: readonly string[]): boolean =>
  xs.every((x, i) => i === 0 || xs[i - 1]!.localeCompare(x) <= 0)

/** A list that was sorted is sorted still. */
const staysSorted = (before: readonly string[], after: readonly string[]): boolean =>
  !isSorted(before) || isSorted(after)

/** The package names listed in sync-scaffold.mjs's NON_SCAFFOLD_PACKAGES. */
function nonScaffold(text: string): string[] {
  const start = text.indexOf('NON_SCAFFOLD_PACKAGES')
  const block = text.slice(start, text.indexOf('])', start))
  return [...block.matchAll(/['"](@nymbalhq\/[a-z0-9-]+)['"]/g)].map((m) => m[1]!)
}

interface Manifest {
  name?: string
  version?: string
  license?: string
  type?: string
  main?: string
  types?: string
  exports?: unknown
  files?: string[]
  scripts?: Record<string, string>
  publishConfig?: Record<string, unknown>
  repository?: Record<string, unknown>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

interface RegistryEntry {
  package: string
  slot: string
  provider: string
  tier: string
  source: Record<string, unknown>
  [key: string]: unknown
}

const scratch = mkdtempSync(join(tmpdir(), 'nymbal-new-adapter-plan-'))
let loaded = 0

/** ADAPTER_CATALOGUE as an edited adapter-names.ts declares it. */
async function catalogueOf(
  source: string,
): Promise<Record<string, Record<string, CatalogueEntry>>> {
  const path = join(scratch, `adapter-names-${++loaded}.ts`)
  writeFileSync(path, source)
  const mod = (await import(pathToFileURL(path).href)) as {
    ADAPTER_CATALOGUE: Record<string, Record<string, CatalogueEntry>>
  }
  return mod.ADAPTER_CATALOGUE
}

const slotKey = (folder: string): Slot =>
  folder.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) as Slot

/** A provider name a contributor might pick: lower-case words joined by single hyphens. */
const providerName = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/),
    fc.option(fc.stringMatching(/^[a-z0-9]{1,5}$/), { nil: undefined }),
  )
  .map(([a, b]) => (b === undefined ? a : `${a}-${b}`))

/** A starting point and a new provider the slot does not have, whose name holds none of the source's. */
const startingPointAndProvider = fc
  .tuple(fc.constantFrom(...STARTING_POINTS), providerName)
  .filter(
    ([source, provider]) =>
      PROVIDER_NAME.test(provider) &&
      !provider.includes(source.provider) &&
      !Object.hasOwn(ADAPTER_CATALOGUE[slotKey(source.slot)], provider) &&
      !existsSync(join(REPO, 'packages', 'adapters', source.slot, provider)) &&
      source.outside.every((f) => !existsSync(join(REPO, renamePath(f, source, provider)))),
  )

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  removeCopies()
})

describe('AC-1: the plan copies a working adapter of the slot, renamed', () => {
  it('AC-1: property: from any starting point, for any new provider, the plan is the renamed copy, one changeset and one sorted entry in each list', async () => {
    const catalogueBefore = ADAPTER_CATALOGUE as unknown as Record<
      string,
      Record<string, CatalogueEntry>
    >
    await fc.assert(
      fc.asyncProperty(startingPointAndProvider, async ([source, provider]) => {
        const p = await plan({ slot: source.slot, provider, fromProvider: source.provider }, REPO)
        const sourceDir = `packages/adapters/${source.slot}/${source.provider}`
        const dir = `packages/adapters/${source.slot}/${provider}`
        const name = `@nymbalhq/${source.slot}-${provider}`
        const sourcePackage = `@nymbalhq/${source.slot}-${source.provider}`

        // The files: the package's tracked files less CHANGELOG.md, recipes/ and what the source table leaves out (a
        // test that reads the recipes), the row's outside files, renamed.
        const leftOut = (
          SOURCES.find((s) => s.slot === source.slot && s.provider === source.provider)?.leaveOut ??
          []
        ).map((f) => `${sourceDir}/${f}`)
        const copied = tracked(sourceDir).filter(
          (f) =>
            !f.endsWith('/CHANGELOG.md') &&
            !f.startsWith(`${sourceDir}/recipes/`) &&
            !leftOut.includes(f),
        )
        const pairs = [
          ...copied.map((f) => ({
            from: f,
            to: `${dir}${renamePath(f.slice(sourceDir.length), source, provider)}`,
          })),
          ...source.outside.map((f) => ({ from: f, to: renamePath(f, source, provider) })),
        ]
        const changesets = p.files.filter((f) => f.path.startsWith('.changeset/'))
        expect(changesets.map((f) => f.path)).toEqual([
          expect.stringMatching(/^\.changeset\/[^/]+\.md$/),
        ])
        expect(
          p.files
            .map((f) => f.path)
            .filter((f) => !f.startsWith('.changeset/'))
            .sort(),
        ).toEqual(pairs.map((x) => x.to).sort())
        expect(
          p.files.filter((f) => f.path.endsWith('CHANGELOG.md') || f.path.includes('/recipes/')),
        ).toEqual([])

        // No spelling of the source survives outside the protected specifiers, which all survive.
        const leaks = p.files.flatMap((f) => [
          ...spellings(source)
            .filter((re) => re.test(f.path))
            .map((re) => `${f.path}: its path holds ${re.source}`),
          ...spellings(source)
            .filter((re) => re.test(unprotected(f.content, sourcePackage, source.provider)))
            .map((re) => `${f.path}: holds ${re.source}`),
          ...(f.content.includes(sourcePackage) ? [`${f.path}: holds ${sourcePackage}`] : []),
        ])
        expect(leaks).toEqual([])
        const specifiers = (text: string): string[] =>
          [...text.matchAll(QUOTED)]
            .filter((m) => !namesProvider(text, m.index, m[0], source.provider))
            .map((m) => m[2]!)
            .filter(isProtectedSpecifier)
            .sort()
        expect(
          pairs.map((x) => ({ file: x.to, kept: specifiers(fileOf(p, x.to)?.content ?? '') })),
        ).toEqual(pairs.map((x) => ({ file: x.to, kept: specifiers(readRepo(x.from)) })))

        // The new package starts at 0.0.0, peering the source's @nymbalhq/types floor.
        const manifest = JSON.parse(fileOf(p, `${dir}/package.json`)?.content ?? '{}') as Manifest
        const sourceManifest = JSON.parse(readRepo(`${sourceDir}/package.json`)) as Manifest
        expect({
          name: manifest.name,
          version: manifest.version,
          types: manifest.peerDependencies?.['@nymbalhq/types'],
        }).toEqual({
          name,
          version: '0.0.0',
          types: sourceManifest.peerDependencies?.['@nymbalhq/types'],
        })

        // One changeset: a minor for the new package and for config, and one line naming the provider.
        const changeset = parseChangeset(changesets[0]?.content ?? '')
        expect(changeset.bumps).toEqual({ [name]: 'minor', '@nymbalhq/config': 'minor' })
        expect(changeset.body).toHaveLength(1)
        expect(changeset.body[0]).toContain(provider)

        // The edits: the five list files, each from what the repository holds now.
        expect(p.edits.map((e) => e.path).sort()).toEqual(EDITED)
        expect(p.edits.map((e) => e.before)).toEqual(p.edits.map((e) => readRepo(e.path)))

        // registry/adapters.json gains the first-party entry, sorted by package.
        const registry = editOf(p, 'registry/adapters.json')!
        const before = (JSON.parse(registry.before) as { adapters: RegistryEntry[] }).adapters
        const after = (JSON.parse(registry.after) as { adapters: RegistryEntry[] }).adapters
        expect(after.length).toBe(before.length + 1)
        expect(after.filter((e) => e.package !== name)).toEqual(before)
        expect(after.filter((e) => e.package === name)).toEqual([
          { package: name, slot: source.slot, provider, tier: 'first-party', source: { dir } },
        ])
        expect(
          staysSorted(
            before.map((e) => e.package),
            after.map((e) => e.package),
          ),
        ).toBe(true)

        // The root and the kernel link it at workspace:*, devDependencies kept sorted.
        for (const path of ['package.json', 'packages/platform/package.json']) {
          const edit = editOf(p, path)!
          const was = JSON.parse(edit.before) as Manifest
          const now = JSON.parse(edit.after) as Manifest
          const { [name]: linked, ...rest } = now.devDependencies ?? {}
          expect({ path, linked }).toEqual({ path, linked: 'workspace:*' })
          expect({ ...now, devDependencies: rest }).toEqual(was)
          expect(
            staysSorted(
              Object.keys(was.devDependencies ?? {}),
              Object.keys(now.devDependencies ?? {}),
            ),
          ).toBe(true)
        }

        // sync-scaffold.mjs excludes it: one line added, the list kept sorted.
        const sync = editOf(p, 'packages/create-app/scripts/sync-scaffold.mjs')!
        expect(
          sync.after
            .split('\n')
            .filter((l) => !l.includes(`'${name}'`) && !l.includes(`"${name}"`)),
        ).toEqual(sync.before.split('\n'))
        expect(nonScaffold(sync.after).sort()).toEqual([...nonScaffold(sync.before), name].sort())
        expect(staysSorted(nonScaffold(sync.before), nonScaffold(sync.after))).toBe(true)

        // The catalogue gains the provider in its slot, with the source's SDK, and nothing else changes.
        const catalogue = await catalogueOf(
          editOf(p, 'packages/config/src/adapter-names.ts')!.after,
        )
        const key = slotKey(source.slot)
        const { [provider]: entry, ...others } = catalogue[key] ?? {}
        const sdk = catalogueBefore[key]?.[source.provider]?.sdk
        expect(entry).toEqual(sdk === undefined ? {} : { sdk })
        expect({ ...catalogue, [key]: others }).toEqual(catalogueBefore)
        const providers = (c: Record<string, CatalogueEntry>): string[] =>
          Object.entries(c)
            .filter(([, e]) => e.builtIn !== true)
            .map(([n]) => n)
        expect(
          staysSorted(providers(catalogueBefore[key] ?? {}), providers(catalogue[key] ?? {})),
        ).toBe(true)
      }),
      { numRuns: 24 },
    )
  })

  it("AC-1: email's default starting point is mailgun: planning without --from-provider is planning from mailgun", async () => {
    const withoutChangesetName = (p: Plan) => ({
      files: p.files
        .map((f) => ({ ...f, path: f.path.startsWith('.changeset/') ? '.changeset/' : f.path }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      edits: p.edits,
    })
    const byDefault = await plan({ slot: 'email', provider: 'acme' }, REPO)
    const fromMailgun = await plan(
      { slot: 'email', provider: 'acme', fromProvider: 'mailgun' },
      REPO,
    )

    expect(withoutChangesetName(byDefault)).toEqual(withoutChangesetName(fromMailgun))
  })
})

/** A copy's status and the content of every file it lists: what a refusal must leave as it was. */
function state(dir: string): string {
  const lines = gitIn(dir, 'status', '--porcelain', '-uall').split('\n').filter(Boolean)
  return lines
    .map((l) => {
      const path = join(dir, l.slice(3))
      return `${l}\n${existsSync(path) ? readFileSync(path, 'utf8') : '(gone)'}`
    })
    .join('\n')
}

let copy = ''

describe('AC-2, AC-5 and AC-6: refusals, the move-in and the printed plan, in a copy of the work tree', () => {
  beforeAll(() => {
    copy = workTreeCopy()
  }, 60_000)

  afterEach(() => {
    resetCopy(copy)
  })

  /** Plans in the copy; the refusal, with the copy's state before and after. */
  async function refuse(
    input: PlanInput,
  ): Promise<{ error: unknown; before: string; after: string }> {
    const before = state(copy)
    const error = await refusal(input, copy)
    return { error, before, after: state(copy) }
  }

  const line = (error: unknown): string => (error instanceof Error ? error.message : String(error))

  it('AC-2: property: an invalid provider name is refused in one line naming it, and nothing is written', async () => {
    const unit = fc.constantFrom(...'abcxyzACME019-_ .!/~'.split(''))
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit, minLength: 1, maxLength: 70 }).filter((s) => !PROVIDER_NAME.test(s)),
        async (provider) => {
          const { error, before, after } = await refuse({ slot: 'search', provider })

          expect(error).toBeInstanceOf(NewAdapterError)
          expect(line(error).split('\n')).toEqual([line(error)])
          expect(line(error)).toContain(provider)
          expect(after).toBe(before)
        },
      ),
      { numRuns: 30 },
    )
  })

  it('AC-2: a provider the slot already has, its own or built in, is refused naming it, and nothing is written', async () => {
    for (const [slot, provider] of [
      ['search', 'algolia'],
      ['search', 'native'],
      ['email', 'smtp'],
      ['shipping', 'easypost'],
    ] as const) {
      const { error, before, after } = await refuse({ slot, provider })

      expect(error).toBeInstanceOf(NewAdapterError)
      expect(line(error).split('\n')).toEqual([line(error)])
      expect(line(error)).toContain(provider)
      expect(after).toBe(before)
    }
  })

  it('AC-2: an unknown slot is refused in one line naming it', async () => {
    for (const slot of ['payment', 'Search', 'documentstore', 'widgets']) {
      const { error, before, after } = await refuse({ slot, provider: 'acme' })

      expect(error).toBeInstanceOf(NewAdapterError)
      expect(line(error).split('\n')).toEqual([line(error)])
      expect(line(error)).toContain(slot)
      expect(after).toBe(before)
    }
  })

  it('AC-2: a target directory that exists, tracked or untracked, is refused naming it, and its files stay as they were', async () => {
    const tracked = join(copy, 'packages', 'adapters', 'search', 'acme')
    mkdirSync(tracked, { recursive: true })
    writeFileSync(join(tracked, 'README.md'), '# work in progress, tracked\n')
    gitIn(copy, 'add', relative(copy, tracked))
    const untracked = join(copy, 'packages', 'adapters', 'shipping', 'acme')
    mkdirSync(join(untracked, 'src'), { recursive: true })
    writeFileSync(join(untracked, 'src', 'index.ts'), '// work in progress, untracked\n')

    for (const [slot, dir] of [
      ['search', 'packages/adapters/search/acme'],
      ['shipping', 'packages/adapters/shipping/acme'],
    ] as const) {
      const { error, before, after } = await refuse({ slot, provider: 'acme' })

      expect(error).toBeInstanceOf(NewAdapterError)
      expect(line(error).split('\n')).toEqual([line(error)])
      expect(line(error)).toContain(dir)
      expect(after).toBe(before)
    }
  })

  it('AC-2: each refused source is refused by name and reason, pointing at the guide, whichever spelling of the slot', async () => {
    const refused = [
      { slot: 'ai', key: 'ai', provider: 'anthropic', reason: /contract/i },
      {
        slot: 'document-store',
        key: 'documentStore',
        provider: 'postgres-jsonb',
        reason: /kernel/i,
      },
      { slot: 'document-store', key: 'documentStore', provider: 'redis', reason: /kernel/i },
      { slot: 'event-bus', key: 'eventBus', provider: 'redis-streams', reason: /kernel/i },
      { slot: 'media', key: 'media', provider: 's3', reason: /kernel/i },
    ]
    for (const r of refused) {
      const byFolder = await refuse({ slot: r.slot, provider: 'acme', fromProvider: r.provider })
      const byKey = await refuse({ slot: r.key, provider: 'acme', fromProvider: r.provider })

      expect(byFolder.error).toBeInstanceOf(NewAdapterError)
      expect(line(byFolder.error).split('\n')).toEqual([line(byFolder.error)])
      expect(line(byFolder.error)).toContain(r.provider)
      expect(line(byFolder.error)).toMatch(r.reason)
      expect(line(byFolder.error)).toContain('packages/adapters/README.md')
      expect(line(byKey.error).replaceAll(r.key, r.slot)).toBe(line(byFolder.error))
      expect(byFolder.after).toBe(byFolder.before)
      expect(byKey.after).toBe(byKey.before)
    }
  })

  it('AC-2: a slot with no starting point, given no --from, is refused in one line naming --from', async () => {
    for (const slot of [
      'reviews',
      'analytics',
      'tax',
      'ai',
      'document-store',
      'event-bus',
      'media',
    ]) {
      const { error, before, after } = await refuse({ slot, provider: 'acme' })

      expect(error).toBeInstanceOf(NewAdapterError)
      expect(line(error).split('\n')).toEqual([line(error)])
      expect(line(error)).toContain('--from')
      expect(after).toBe(before)
    }
  })

  it('AC-2: property: a copy for a valid provider name that starts with a digit, which no identifier can, is refused in one line naming it and --from, and nothing is written', async () => {
    const digitLed = fc
      .tuple(fc.stringMatching(/^[0-9][a-z0-9]{0,8}$/), fc.constantFrom(...STARTING_POINTS))
      .filter(([provider]) => PROVIDER_NAME.test(provider))
    await fc.assert(
      fc.asyncProperty(digitLed, async ([provider, source]) => {
        const { error, before, after } = await refuse({
          slot: source.slot,
          provider,
          fromProvider: source.provider,
        })

        expect(error).toBeInstanceOf(NewAdapterError)
        expect(line(error).split('\n')).toEqual([line(error)])
        expect(line(error)).toContain(provider)
        expect(line(error)).toContain('--from')
        expect(after).toBe(before)
      }),
      { numRuns: 12 },
    )
  })

  it('AC-5: --from moves a listed third-party search adapter in under the convention name, normalised, replacing its community entry', async () => {
    const fixture = join(copy, 'tests', 'fixtures', 'third-party-search')
    const thirdParty = (JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8')) as Manifest)
      .name!
    const registryPath = join(copy, 'registry', 'adapters.json')
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as { adapters: RegistryEntry[] }
    registry.adapters.push({
      package: thirdParty,
      slot: 'search',
      provider: 'acme',
      tier: 'community',
      maintainer: 'https://github.com/acme',
      repository: 'https://github.com/acme/nymbal-search',
      source: { npm: '^1.0.0' },
    })
    registry.adapters.sort((a, b) => a.package.localeCompare(b.package))
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`)

    const p = await plan({ slot: 'search', provider: 'acme', fromDir: fixture }, copy)
    const dir = 'packages/adapters/search/acme'
    const convention = (file: string): string =>
      readFileSync(join(copy, 'packages', 'adapters', 'search', 'algolia', file), 'utf8')
    const conventionManifest = JSON.parse(convention('package.json')) as Manifest
    const root = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8')) as Manifest
    const manifest = JSON.parse(fileOf(p, `${dir}/package.json`)?.content ?? '{}') as Manifest

    // The manifest, normalised as the repository's adapters are.
    const exportTargets = JSON.stringify(manifest.exports ?? null).match(/"\.\/[^"]*"/g) ?? []
    expect({
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      main: manifest.main?.replace(/^\.\//, '').split('/')[0],
      types: manifest.types?.replace(/^\.\//, '').split('/')[0],
      exportsOutsideDist: exportTargets.filter((t) => !t.startsWith('"./dist/')),
      filesHoldDist: manifest.files?.includes('dist'),
      publishConfig: manifest.publishConfig,
      repository: manifest.repository,
      license: manifest.license,
      typesPeer: manifest.peerDependencies?.['@nymbalhq/types'],
      build: manifest.scripts?.['build'],
      typecheck: manifest.scripts?.['typecheck'],
    }).toEqual({
      name: '@nymbalhq/search-acme',
      version: '0.0.0',
      type: 'module',
      main: 'dist',
      types: 'dist',
      exportsOutsideDist: [],
      filesHoldDist: true,
      publishConfig: conventionManifest.publishConfig,
      repository: { ...conventionManifest.repository, directory: dir },
      license: root.license,
      typesPeer: conventionManifest.peerDependencies?.['@nymbalhq/types'],
      build: conventionManifest.scripts?.['build'],
      typecheck: conventionManifest.scripts?.['typecheck'],
    })
    expect(exportTargets.length).toBeGreaterThanOrEqual(1)

    // tsconfig.json and tsup.config.ts from the convention; the source as given.
    expect(JSON.parse(fileOf(p, `${dir}/tsconfig.json`)?.content ?? 'null')).toEqual(
      JSON.parse(convention('tsconfig.json')),
    )
    const squeeze = (s: string | undefined): string | undefined => s?.replace(/\s+/g, ' ').trim()
    expect(squeeze(fileOf(p, `${dir}/tsup.config.ts`)?.content)).toBe(
      squeeze(convention('tsup.config.ts')),
    )
    const source = readFileSync(join(fixture, 'index.js'), 'utf8')
    expect(p.files.filter((f) => f.path.startsWith(`${dir}/`) && f.content === source).length).toBe(
      1,
    )

    // A runner that certifies it with the search suite and its own contractOptions.
    const runners = p.files.filter((f) => f.path.startsWith('tests/contracts/'))
    expect(runners).toHaveLength(1)
    expect(runners[0]!.content).toMatch(/\brunSearchContract\b/)
    expect(runners[0]!.content).toMatch(/\bcontractOptions\b/)

    // The community entry is replaced by the first-party one, not listed beside it.
    const edit = editOf(p, 'registry/adapters.json')!
    const before = (JSON.parse(edit.before) as { adapters: RegistryEntry[] }).adapters
    const after = (JSON.parse(edit.after) as { adapters: RegistryEntry[] }).adapters
    expect(after.length).toBe(before.length)
    expect(after.filter((e) => e.slot === 'search' && e.provider === 'acme')).toEqual([
      {
        package: '@nymbalhq/search-acme',
        slot: 'search',
        provider: 'acme',
        tier: 'first-party',
        source: { dir },
      },
    ])

    // Nothing planned keeps the third party's name.
    expect(
      [
        ...p.files.map((f) => ({ path: f.path, text: f.content })),
        ...p.edits.map((e) => ({ path: e.path, text: e.after })),
      ]
        .filter((f) => f.text.includes(thirdParty))
        .map((f) => f.path),
    ).toEqual([])
  })

  it('AC-6: the script, its --dry-run output and the changeset it plans hold no task id, phase number or private process word; the dry run lists the plan and writes nothing', async () => {
    const script = readFileSync(join(REPO, 'scripts', 'new-adapter.ts'), 'utf8')
    const p = await plan({ slot: 'search', provider: 'acme' }, copy)
    const changeset = p.files.find((f) => f.path.startsWith('.changeset/'))?.content ?? ''
    const before = state(copy)
    const dry = await shell(copy, `${NO_INSTALL} pnpm new-adapter search acme --dry-run`)

    expect(dry.code, dry.output).toBe(0)
    expect(state(copy)).toBe(before)
    expect(
      [...p.files, ...p.edits]
        .map((x) => x.path)
        .filter((path) => !path.startsWith('.changeset/') && !dry.output.includes(path)),
    ).toEqual([])
    expect({
      script: privateWords(script),
      output: privateWords(dry.output),
      changeset: privateWords(changeset),
    }).toEqual({ script: [], output: [], changeset: [] })
  })
})
