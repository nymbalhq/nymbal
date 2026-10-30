import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ADAPTER_CATALOGUE, conventionPackage, loadConfig, slotFolder } from '@nymbalhq/config'
import { installLine } from '@nymbalhq/platform'
import type { Slot } from '@nymbalhq/types'
import { scaffold } from '../../../create-app/src/index.js'
import {
  REPO,
  changedPaths,
  copyProject,
  listing,
  removeAll,
  tempDir,
} from '../recipes/fixtures/linked-project.js'
import { knownRecipes } from '../recipes/index.js'
import { add, parseAddTarget } from './add.js'

// AC-2 to AC-5 and AC-7: the three forms of `nymbal add` on copies of a fresh create-nymbal-app config, the workspace
// packages linked into node_modules and a pnpm lockfile. `add` runs in process from the positionals as the command
// line gives them (parseAddTarget), its output captured. Every package manager on PATH is a recorder that refuses, so
// a run that tries to install leaves a line in its log. AC-7 spawns the built CLI. Needs `pnpm build`.

const exec = promisify(execFile)
const CLI = join(REPO, 'packages/cli/bin/nymbal.mjs')
const FIXTURES = join(REPO, 'tests/fixtures')
const SEARCH_X = '@acme/nymbal-search-x'
const NO_FACTORY = '@acme/nymbal-search-no-factory'
const SLOTS = Object.keys(ADAPTER_CATALOGUE) as Slot[]
/** Variables a run must find unset, so `Next:` names them. */
const UNSET = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PUBLISHABLE_KEY',
  'ANTHROPIC_API_KEY',
  'ACME_SEARCH_KEY',
  'ACME_SEARCH_REGION',
]

const dirs: string[] = []
const savedEnv = new Map<string, string | undefined>()
let scaffolded = ''
let installLog = ''

beforeAll(async () => {
  // The install line follows the project's lockfile, not the package manager running the tests.
  for (const name of ['npm_config_user_agent', 'PATH', 'JITI_MODULE_CACHE', ...UNSET])
    savedEnv.set(name, process.env[name])
  delete process.env['npm_config_user_agent']
  for (const name of UNSET) delete process.env[name]
  // loadConfig imports through jiti, whose module cache would hand a second read of one config its first contents.
  process.env['JITI_MODULE_CACHE'] = 'false'

  const bin = tempDir('add-forms-bin')
  dirs.push(bin)
  installLog = join(bin, 'installs.log')
  for (const pm of ['pnpm', 'npm', 'yarn', 'bun']) {
    const file = join(bin, pm)
    writeFileSync(file, `#!/bin/sh\necho "${pm} $*" >> "${installLog}"\nexit 1\n`)
    chmodSync(file, 0o755)
  }
  process.env['PATH'] = `${bin}:${process.env['PATH'] ?? ''}`

  scaffolded = tempDir('add-forms-base')
  dirs.push(scaffolded)
  await scaffold(scaffolded, {
    name: 'Forms Shop',
    directory: 'forms-shop',
    currency: 'GBP',
    template: 'astro',
    seedDemo: false,
  })
}, 60_000)

afterAll(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  removeAll(dirs)
})

/** The install commands the package managers on PATH were asked to run, so far. */
const installs = (): string[] =>
  existsSync(installLog) ? readFileSync(installLog, 'utf8').split('\n').filter(Boolean) : []

function projectFrom(label: string, omit: string[] = []): string {
  const dir = copyProject(scaffolded, label, omit)
  dirs.push(dir)
  writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  return dir
}

/** The project's `.env.example` without the scaffold's `# <name>=` line: a commented variable counts as listed. */
function unlist(dir: string, name: string): void {
  const path = join(dir, '.env.example')
  writeFileSync(path, readFileSync(path, 'utf8').replace(new RegExp(`^# ${name}=\\n`, 'm'), ''))
}

/** `name` in the project's node_modules as a link to the fixture package directory. */
function linkFixture(dir: string, name: string, fixture: string): void {
  const at = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(join(at, '..'), { recursive: true })
  symlinkSync(join(FIXTURES, fixture), at, 'dir')
}

/** A package written into the project's node_modules whose module is `source`. */
function writeModule(dir: string, name: string, source: string): void {
  const at = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(at, { recursive: true })
  writeFileSync(
    join(at, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', type: 'module', exports: { '.': './index.js' } }),
  )
  writeFileSync(join(at, 'index.js'), source)
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')

/** `nymbal add <args>` in `dir`, in process; `install` is on unless the run says `--no-install`. */
async function nymbalAdd(
  dir: string,
  args: string[],
  flags: { install?: boolean; force?: boolean; dryRun?: boolean } = {},
): Promise<{ code: number; out: string }> {
  const target = parseAddTarget(args)
  if ('error' in target) throw new Error(`parseAddTarget(${JSON.stringify(args)}): ${target.error}`)
  let out = ''
  const capture = (chunk: string | Uint8Array): boolean => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture as never)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture as never)
  try {
    const code = await add(
      {
        target,
        install: flags.install ?? true,
        force: flags.force ?? false,
        dryRun: flags.dryRun ?? false,
      },
      dir,
    )
    return { code, out: stripAnsi(out) }
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
  }
}

/** The words of a text: runs of letters, digits and hyphens, so `@nymbalhq/payments-stripe` holds no word `stripe`. */
const words = (text: string): string[] => text.match(/[A-Za-z0-9][A-Za-z0-9-]*/g) ?? []
const read = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8')
const installLineOf = (out: string): string | undefined =>
  out
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('install:'))
/** The non-empty lines `after` appends to `before`, which it must keep as its start. */
function appended(before: string, after: string): string[] {
  expect(after.startsWith(before), 'every line already in .env.example is kept in place').toBe(true)
  return after
    .slice(before.length)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
}
async function commerceOf(dir: string): Promise<Record<string, Record<string, unknown>>> {
  return (await loadConfig(dir)).config.commerce as unknown as Record<
    string,
    Record<string, unknown>
  >
}
/** Every commerce slot's block but `slot`'s. */
function othersThan(
  commerce: Record<string, Record<string, unknown>>,
  slot: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(commerce).filter(([k]) => k !== slot))
}

describe(
  'AC-2: nymbal add <slot> <provider> for a provider with a recipe',
  { timeout: 30_000 },
  () => {
    it('AC-2: `add payments stripe` writes byte-identical nymbal.config.ts and .env.example to `add stripe`, and its --dry-run installs the same packages', async () => {
      const viaRecipe = projectFrom('form-recipe')
      const viaSlot = projectFrom('form-slot')
      const before = listing(viaSlot)

      const recipeDry = await nymbalAdd(viaRecipe, ['stripe'], { dryRun: true })
      const slotDry = await nymbalAdd(viaSlot, ['payments', 'stripe'], { dryRun: true })
      expect(recipeDry.code, recipeDry.out).toBe(0)
      expect(slotDry.code, slotDry.out).toBe(0)
      expect(installLineOf(slotDry.out), slotDry.out).toBe(installLineOf(recipeDry.out))
      expect(installLineOf(recipeDry.out)).toContain(conventionPackage('payments', 'stripe'))

      const viaRecipeRun = await nymbalAdd(viaRecipe, ['stripe'], { install: false })
      const viaSlotRun = await nymbalAdd(viaSlot, ['payments', 'stripe'], { install: false })
      expect(viaRecipeRun.code, viaRecipeRun.out).toBe(0)
      expect(viaSlotRun.code, viaSlotRun.out).toBe(0)
      expect(changedPaths(before, listing(viaSlot))).toEqual(['.env.example', 'nymbal.config.ts'])
      expect(read(viaSlot, 'nymbal.config.ts')).toBe(read(viaRecipe, 'nymbal.config.ts'))
      expect(read(viaSlot, '.env.example')).toBe(read(viaRecipe, '.env.example'))
      expect((await commerceOf(viaSlot))['payments']?.['provider']).toBe('stripe')
    })

    it("AC-2: `add payments strpe` exits 1 with did you mean 'stripe', and installs and writes nothing", async () => {
      const dir = projectFrom('typo', ['@nymbalhq/payments-stripe', 'stripe'])
      const before = listing(dir)
      const installed = installs()

      const run = await nymbalAdd(dir, ['payments', 'strpe'])

      expect(run.code, run.out).toBe(1)
      expect(run.out).toContain("did you mean 'stripe'")
      expect(installs()).toEqual(installed)
      expect(changedPaths(before, listing(dir))).toEqual([])
    })

    it('AC-2: `add search foo` exits 1 naming `nymbal add <package>`, before any install, and writes nothing', async () => {
      const dir = projectFrom('unknown-provider')
      const before = listing(dir)
      const installed = installs()

      const run = await nymbalAdd(dir, ['search', 'foo'])

      expect(run.code, run.out).toBe(1)
      expect(run.out).toContain("'foo'")
      expect(run.out).toContain('nymbal add <package>')
      expect(installs()).toEqual(installed)
      expect(changedPaths(before, listing(dir))).toEqual([])
    })

    it('AC-2: `add payments custom` is refused as an adapter passed to createApp, and installs and writes nothing', async () => {
      const dir = projectFrom('custom')
      const before = listing(dir)
      const installed = installs()

      const run = await nymbalAdd(dir, ['payments', 'custom'])

      expect(run.code, run.out).toBe(1)
      expect(run.out).toContain('createApp')
      expect(installs()).toEqual(installed)
      expect(changedPaths(before, listing(dir))).toEqual([])
    })

    it('AC-2: after `add stripe`, `add payments native` is refused as a conflict; with --force --dry-run it prints `install: nothing` and writes nothing; with --force it sets payments to native and leaves every other slot as it was', async () => {
      const dir = projectFrom('native-after-stripe')
      const stripe = await nymbalAdd(dir, ['stripe'], { install: false })
      expect(stripe.code, stripe.out).toBe(0)
      const afterStripe = listing(dir)
      const commerceBefore = await commerceOf(dir)
      const installed = installs()

      const refused = await nymbalAdd(dir, ['payments', 'native'])
      expect(refused.code, refused.out).toBe(1)
      expect(refused.out).toContain('commerce.payments')
      expect(refused.out).toContain('stripe')
      expect(refused.out).toContain('native')
      expect(changedPaths(afterStripe, listing(dir))).toEqual([])

      const dry = await nymbalAdd(dir, ['payments', 'native'], { force: true, dryRun: true })
      expect(dry.code, dry.out).toBe(0)
      expect(installLineOf(dry.out)).toBe('install: nothing')
      expect(changedPaths(afterStripe, listing(dir))).toEqual([])

      const forced = await nymbalAdd(dir, ['payments', 'native'], { force: true })
      expect(forced.code, forced.out).toBe(0)
      expect(installs()).toEqual(installed)
      expect(changedPaths(afterStripe, listing(dir))).toEqual(['nymbal.config.ts'])
      const commerceAfter = await commerceOf(dir)
      expect(commerceAfter['payments']?.['provider']).toBe('native')
      expect(othersThan(commerceAfter, 'payments')).toEqual(othersThan(commerceBefore, 'payments'))
    })

    it.each([
      ['documentStore', 'redis'],
      ['document-store', 'redis'],
      ['eventBus', 'redis-streams'],
    ])(
      'AC-2: `add %s %s` is refused toward `nymbal add redis`, naming document-store and event-bus by their kebab names, with and without --dry-run, and installs and writes nothing',
      async (slot, provider) => {
        // Nothing of redis is linked, so a refusal that came only after the install step would leave a line in the log.
        const dir = projectFrom(`multi-slot-${slot}`, [
          '@nymbalhq/document-store-redis',
          '@nymbalhq/event-bus-redis-streams',
          'ioredis',
        ])
        const before = listing(dir)
        const installed = installs()

        const run = await nymbalAdd(dir, [slot, provider])
        const dry = await nymbalAdd(dir, [slot, provider], { dryRun: true })

        expect(run.code, run.out).toBe(1)
        expect(run.out).toContain('nymbal add redis')
        expect(dry.code, dry.out).toBe(1)
        expect(dry.out).toContain('nymbal add redis')
        // Slots print by their folder names; the config key is only a typed alias.
        for (const out of [run.out, dry.out]) {
          expect(out).toContain('redis sets document-store and event-bus together')
          expect(
            words(out).filter((w) => w === 'documentStore' || w === 'eventBus'),
            out,
          ).toEqual([])
        }
        expect(installs()).toEqual(installed)
        expect(changedPaths(before, listing(dir))).toEqual([])
      },
    )
  },
)

describe(
  'AC-3: nymbal add <slot> <provider> for a provider with no recipe',
  { timeout: 30_000 },
  () => {
    const PACKAGE = conventionPackage('ai', 'anthropic')
    const SDK = ADAPTER_CATALOGUE.ai['anthropic']?.sdk

    it("AC-3: `add ai anthropic --dry-run` prints the install line of the convention package and the catalogue's SDK, and writes nothing", async () => {
      const dir = projectFrom('ai-dry')
      const before = listing(dir)
      expect(SDK, 'the catalogue names the anthropic SDK').toBe('@anthropic-ai/sdk')

      const run = await nymbalAdd(dir, ['ai', 'anthropic'], { dryRun: true })

      expect(run.code, run.out).toBe(0)
      expect(installLineOf(run.out)).toBe(
        `install: ${installLine([PACKAGE, SDK!], process.env, dir)}`,
      )
      expect(changedPaths(before, listing(dir))).toEqual([])
    })

    it("AC-3: `add ai anthropic --no-install` sets commerce.ai to { provider: 'anthropic' } alone, appends one ANTHROPIC_API_KEY line under its label, and names the setting with no env in Next: as set in the admin's Settings", async () => {
      const dir = projectFrom('ai-run')
      unlist(dir, 'ANTHROPIC_API_KEY')
      const before = listing(dir)
      const exampleBefore = read(dir, '.env.example')
      const commerceBefore = await commerceOf(dir)

      const run = await nymbalAdd(dir, ['ai', 'anthropic'], { install: false })

      expect(run.code, run.out).toBe(0)
      expect(changedPaths(before, listing(dir))).toEqual(['.env.example', 'nymbal.config.ts'])
      const commerceAfter = await commerceOf(dir)
      expect(commerceAfter['ai']?.['provider']).toBe('anthropic')
      expect(commerceAfter['ai']?.['package']).toBeUndefined()
      expect(othersThan(commerceAfter, 'ai')).toEqual(othersThan(commerceBefore, 'ai'))
      expect(appended(exampleBefore, read(dir, '.env.example'))).toEqual([
        '# ai anthropic (nymbal add ai anthropic)',
        '# API key',
        'ANTHROPIC_API_KEY=',
      ])
      expect(run.out).toContain("set ANTHROPIC_API_KEY in .env or in the admin's Settings")
      expect(run.out).toMatch(/set (\S+\.)?baseUrl in the admin's Settings/)
    })
  },
)

describe('AC-4: nymbal add <package> for a third-party adapter', { timeout: 30_000 }, () => {
  it("AC-4: `add @acme/nymbal-search-x --no-install` sets commerce.search to its provider and package, appends ACME_SEARCH_KEY and a commented-out ACME_SEARCH_REGION, says to set the key in .env or the admin's Settings, and the config loads", async () => {
    const dir = projectFrom('package-run')
    linkFixture(dir, SEARCH_X, 'third-party-search-x')
    const before = listing(dir)
    const exampleBefore = read(dir, '.env.example')
    const commerceBefore = await commerceOf(dir)

    const run = await nymbalAdd(dir, [SEARCH_X], { install: false })

    expect(run.code, run.out).toBe(0)
    expect(changedPaths(before, listing(dir))).toEqual(['.env.example', 'nymbal.config.ts'])
    const commerceAfter = await commerceOf(dir)
    expect(commerceAfter['search']).toEqual(
      expect.objectContaining({ provider: 'acme-x', package: SEARCH_X }),
    )
    expect(othersThan(commerceAfter, 'search')).toEqual(othersThan(commerceBefore, 'search'))
    const added = appended(exampleBefore, read(dir, '.env.example'))
    expect(added.filter((l) => l === 'ACME_SEARCH_KEY=')).toHaveLength(1)
    expect(added.filter((l) => /^#\s*ACME_SEARCH_REGION=$/.test(l))).toHaveLength(1)
    expect(added.filter((l) => l.startsWith('ACME_SEARCH_REGION='))).toEqual([])
    expect(run.out).toContain("set ACME_SEARCH_KEY in .env or in the admin's Settings")
  })

  it.each([
    {
      what: 'a module exporting no createAdapter',
      pkg: NO_FACTORY,
      names: 'createAdapter',
      put: (dir: string) => linkFixture(dir, NO_FACTORY, 'third-party-no-create-adapter'),
    },
    {
      what: 'a module whose slot is no slot',
      pkg: '@acme/nymbal-bad-slot',
      names: 'catalog',
      put: (dir: string) =>
        writeModule(
          dir,
          '@acme/nymbal-bad-slot',
          "export const slot = 'catalog'\nexport const provider = 'acme-x'\nexport const settings = []\nexport function createAdapter() { return {} }\n",
        ),
    },
    {
      what: 'a module whose provider is a built-in',
      pkg: '@acme/nymbal-search-y',
      names: 'native',
      put: (dir: string) =>
        writeModule(
          dir,
          '@acme/nymbal-search-y',
          "export const slot = 'search'\nexport const provider = 'native'\nexport const settings = []\nexport function createAdapter() { return {} }\n",
        ),
    },
    {
      what: 'a module whose provider is custom',
      pkg: '@acme/nymbal-search-z',
      names: 'custom',
      put: (dir: string) =>
        writeModule(
          dir,
          '@acme/nymbal-search-z',
          "export const slot = 'search'\nexport const provider = 'custom'\nexport const settings = []\nexport function createAdapter() { return {} }\n",
        ),
    },
  ])(
    'AC-4: $what exits 1 naming the package and $names, and changes neither file',
    async ({ pkg, names, put }) => {
      const dir = projectFrom(`bad-${names}`)
      put(dir)
      const before = listing(dir)

      const run = await nymbalAdd(dir, [pkg], { install: false })

      expect(run.code, run.out).toBe(1)
      expect(run.out).toContain(pkg)
      expect(run.out).toContain(names)
      expect(changedPaths(before, listing(dir))).toEqual([])
    },
  )

  it('AC-4: the refusal of a module whose slot is no slot lists every slot', async () => {
    const dir = projectFrom('bad-slot-list')
    writeModule(
      dir,
      '@acme/nymbal-bad-slot',
      "export const slot = 'catalog'\nexport const provider = 'acme-x'\nexport const settings = []\nexport function createAdapter() { return {} }\n",
    )

    const run = await nymbalAdd(dir, ['@acme/nymbal-bad-slot'], { install: false })

    expect(run.code, run.out).toBe(1)
    const named = words(run.out)
    expect(SLOTS.filter((s) => named.includes(s) || named.includes(slotFolder(s)))).toEqual(SLOTS)
  })

  it('AC-4: --dry-run on a package that is not installed exits 1 with its install line, and installs and writes nothing', async () => {
    const dir = projectFrom('package-missing')
    const before = listing(dir)
    const installed = installs()

    const run = await nymbalAdd(dir, [SEARCH_X], { dryRun: true })

    expect(run.code, run.out).toBe(1)
    expect(run.out).toContain(installLine([SEARCH_X], process.env, dir))
    expect(installs()).toEqual(installed)
    expect(changedPaths(before, listing(dir))).toEqual([])
  })

  it('AC-4: --dry-run on the installed package exits 0, prints the config diff, the .env.example lines and its install line, and writes nothing', async () => {
    const dir = projectFrom('package-dry')
    linkFixture(dir, SEARCH_X, 'third-party-search-x')
    const before = listing(dir)

    const run = await nymbalAdd(dir, [SEARCH_X], { dryRun: true })

    expect(run.code, run.out).toBe(0)
    const plus = run.out.split('\n').filter((l) => /^\s*\+ /.test(l))
    expect(
      plus.filter((l) => l.includes("'acme-x'") || l.includes('"acme-x"')),
      run.out,
    ).not.toEqual([])
    expect(
      plus.filter((l) => l.includes(SEARCH_X)),
      run.out,
    ).not.toEqual([])
    expect(run.out.split('\n').filter((l) => l.trim() === 'ACME_SEARCH_KEY=')).toHaveLength(1)
    expect(installLineOf(run.out)).toBe(`install: ${installLine([SEARCH_X], process.env, dir)}`)
    expect(changedPaths(before, listing(dir))).toEqual([])
  })
})

describe('AC-5: every form is idempotent and refuses a conflict', { timeout: 30_000 }, () => {
  it.each([
    { form: 'recipe', args: ['stripe'] },
    { form: 'slot with a recipe', args: ['payments', 'stripe'] },
    { form: 'slot without a recipe', args: ['ai', 'anthropic'] },
    { form: 'package', args: [SEARCH_X] },
  ])(
    'AC-5: a second identical run of the $form form prints `already added: nothing changed` and changes no file',
    async ({ form, args }) => {
      const dir = projectFrom(`again-${form.replace(/\s+/g, '-')}`)
      unlist(dir, 'ANTHROPIC_API_KEY')
      linkFixture(dir, SEARCH_X, 'third-party-search-x')
      const before = listing(dir)

      const first = await nymbalAdd(dir, args, { install: false })
      expect(first.code, first.out).toBe(0)
      const once = listing(dir)
      const second = await nymbalAdd(dir, args, { install: false })

      expect(changedPaths(before, once)).toEqual(['.env.example', 'nymbal.config.ts'])
      expect(second.code, second.out).toBe(0)
      expect(second.out).toContain('already added: nothing changed')
      expect(changedPaths(once, listing(dir))).toEqual([])
    },
  )

  it('AC-5: `add payments stripe` after `add stripe` prints `already added: nothing changed`: the two forms are one', async () => {
    const dir = projectFrom('again-across-forms')
    const first = await nymbalAdd(dir, ['stripe'], { install: false })
    expect(first.code, first.out).toBe(0)
    const once = listing(dir)

    const second = await nymbalAdd(dir, ['payments', 'stripe'], { install: false })

    expect(second.code, second.out).toBe(0)
    expect(second.out).toContain('already added: nothing changed')
    expect(changedPaths(once, listing(dir))).toEqual([])
  })

  it.each([
    {
      form: 'package',
      args: [SEARCH_X],
      path: 'commerce.search',
      from: "search: { provider: 'native' }",
      to: "search: { provider: 'algolia' }",
      held: 'algolia',
    },
    {
      form: 'slot',
      args: ['ai', 'anthropic'],
      path: 'commerce.ai',
      from: "ai: { provider: 'none' }",
      to: "ai: { provider: 'custom' }",
      held: 'custom',
    },
  ])(
    'AC-5: the $form form refuses a hand-edited $path without --force, naming the path and the value it holds, and changes no file',
    async ({ form, args, path, from, to, held }) => {
      const dir = projectFrom(`conflict-${form}`)
      linkFixture(dir, SEARCH_X, 'third-party-search-x')
      const configPath = join(dir, 'nymbal.config.ts')
      const original = readFileSync(configPath, 'utf8')
      const edited = original.replace(from, to)
      expect(edited, `the scaffold config holds ${from}`).not.toBe(original)
      writeFileSync(configPath, edited)
      const before = listing(dir)

      const run = await nymbalAdd(dir, args, { install: false })

      expect(run.code, run.out).toBe(1)
      expect(run.out).toContain(path)
      expect(run.out).toContain(held)
      expect(changedPaths(before, listing(dir))).toEqual([])
    },
  )
})

describe('AC-7: nymbal add with no argument', () => {
  /** Each catalogue slot's line: the one whose first word is the slot, as its config key or its folder name. */
  function slotLines(out: string, slot: Slot): string[] {
    return out
      .split('\n')
      .filter((l) => [slot, slotFolder(slot)].includes(l.trim().split(/[\s:]+/)[0] ?? ''))
  }
  it('AC-7: lists the three forms, each catalogue slot once by its kebab name with each of its providers once, and every recipe', async () => {
    const dir = projectFrom('help')
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.keys(env)) if (k.startsWith('VITEST')) delete env[k]
    let out: string
    try {
      const { stdout, stderr } = await exec(process.execPath, [CLI, 'add'], {
        cwd: dir,
        env,
        timeout: 30_000,
      })
      out = stripAnsi(stdout + stderr)
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string }
      out = stripAnsi(`${e.stdout ?? ''}${e.stderr ?? ''}`)
    }

    expect(
      ['<slot> <provider>', '<package>', '<recipe>'].filter((f) => out.includes(f)),
      out,
    ).toEqual(['<slot> <provider>', '<package>', '<recipe>'])
    const listed = Object.fromEntries(
      SLOTS.map((slot) => {
        const lines = slotLines(out, slot)
        const providers = Object.keys(ADAPTER_CATALOGUE[slot])
        return [
          slot,
          {
            lines: lines.length,
            providers: Object.fromEntries(
              providers.map((p) => [p, words(lines[0] ?? '').filter((w) => w === p).length]),
            ),
          },
        ]
      }),
    )
    const expected = Object.fromEntries(
      SLOTS.map((slot) => [
        slot,
        {
          lines: 1,
          providers: Object.fromEntries(Object.keys(ADAPTER_CATALOGUE[slot]).map((p) => [p, 1])),
        },
      ]),
    )
    expect(listed, out).toEqual(expected)
    const all = words(out)
    // Each slot line opens with the slot's kebab name, and no camelCase config key is printed anywhere.
    expect(
      SLOTS.map(
        (slot) =>
          slotLines(out, slot)[0]
            ?.trim()
            .split(/[\s:]+/)[0],
      ),
      out,
    ).toEqual(SLOTS.map((slot) => slotFolder(slot)))
    expect(SLOTS.filter((slot) => slot !== slotFolder(slot) && all.includes(slot))).toEqual([])
    expect(knownRecipes().filter((r) => all.includes(r))).toEqual(knownRecipes())
  }, 60_000)
})
