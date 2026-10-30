import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as Clack from '@clack/prompts'
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ADAPTER_NAMES } from '../../../tests/architecture/adapter-table.js'
import { loadConfig } from '../../config/src/index.js'
import { main, parseCliFlags, scaffold } from '../src/index.js'

// Scaffold from a clean machine, AC-1 to AC-6. AC-1's type half lives in tests/scaffold/scaffold-answers.test-d.ts
// (root typecheck); AC-6's `nymbal dev` half and AC-7 to AC-10 are in the cli project. The scaffold is read from
// scaffold/templates, so run `pnpm build` first.

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
const PACKAGES = resolve(REPO_ROOT, 'packages')

const TEMPLATES = ['astro', 'nextjs'] as const
type Template = (typeof TEMPLATES)[number]

// The first-party adapter packages: optional peers of the kernel that a project installs only when its config names one.
const ADAPTER_PACKAGES: readonly string[] = ADAPTER_NAMES

// The public runtime packages @nymbalhq/stack pins, and the directory each lives in.
const PUBLIC_RUNTIME: Record<string, string> = {
  nymbal: 'cli',
  '@nymbalhq/config': 'config',
  '@nymbalhq/platform': 'platform',
  '@nymbalhq/sdk': 'sdk',
  '@nymbalhq/types': 'types',
  '@nymbalhq/web-components': 'web-components',
  '@nymbalhq/http': 'http',
  '@nymbalhq/react': 'react',
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']

interface Manifest {
  name?: string
  version?: string
  private?: boolean
  packageManager?: string
  engines?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  overrides?: Record<string, string>
  pnpm?: { overrides?: Record<string, string> }
}

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, 'utf8')) as T
const isNymbal = (name: string): boolean => name === 'nymbal' || name.startsWith('@nymbalhq/')

// ─── prompts: the interactive flow is driven through @clack/prompts, recorded and answered here ──────────────────

const clack = vi.hoisted(() => ({
  asked: [] as Array<{ kind: 'text' | 'select' | 'confirm'; message: string }>,
  installAnswer: false,
}))

vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof Clack>()
  return {
    ...actual,
    intro: () => {},
    outro: () => {},
    note: () => {},
    cancel: () => {},
    text: async (opts: { message: string }) => {
      clack.asked.push({ kind: 'text', message: opts.message })
      return 'Shop'
    },
    select: async (opts: {
      message: string
      initialValue?: unknown
      options: Array<{ value: unknown }>
    }) => {
      clack.asked.push({ kind: 'select', message: opts.message })
      return opts.initialValue ?? opts.options[0]?.value
    },
    confirm: async (opts: { message: string; initialValue?: boolean }) => {
      clack.asked.push({ kind: 'confirm', message: opts.message })
      // Never answer "install" with yes by accident: a real install would shell out.
      return /install/i.test(opts.message) ? clack.installAnswer : (opts.initialValue ?? false)
    },
  }
})

// ─── a scratch directory per test, outside the checkout ──────────────────────────────────────────────────────────

const scratch: string[] = []
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `scaffold-${prefix}-`))
  scratch.push(dir)
  return realpathSync(dir)
}
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

async function scaffoldInto(template: Template, userAgent?: string): Promise<string> {
  const dir = join(await tempDir(`scaffold-${template}`), 'shop')
  const saved = process.env['npm_config_user_agent']
  if (userAgent === undefined) delete process.env['npm_config_user_agent']
  else process.env['npm_config_user_agent'] = userAgent
  try {
    await scaffold(dir, {
      name: 'Shop',
      directory: 'shop',
      currency: 'GBP',
      template,
      seedDemo: true,
    })
  } finally {
    if (saved === undefined) delete process.env['npm_config_user_agent']
    else process.env['npm_config_user_agent'] = saved
  }
  return dir
}

// ─── AC-1, AC-5: the bin's flow, through main(argv, { run }) ─────────────────────────────────────────────────────

type Run = { cmd: string; args: string[]; cwd: string }

describe('create-nymbal-app main(argv, { run })', () => {
  const argv = (...args: string[]): string[] => ['node', 'create-nymbal-app', ...args]
  const originalCwd = process.cwd()
  const originalUa = process.env['npm_config_user_agent']
  let runs: Run[]
  const run = async (cmd: string, args: string[], cwd: string): Promise<void> => {
    runs.push({ cmd, args: [...args], cwd })
  }

  beforeEach(() => {
    runs = []
    clack.asked.length = 0
    clack.installAnswer = false
  })
  afterEach(() => {
    process.chdir(originalCwd)
    if (originalUa === undefined) delete process.env['npm_config_user_agent']
    else process.env['npm_config_user_agent'] = originalUa
  })

  it('AC-1: the interactive prompts are exactly name, currency, template, demo content, install; no mobile prompt', async () => {
    process.chdir(await tempDir('interactive'))
    await main(argv(), { run })

    expect(clack.asked.map((p) => p.message).filter((m) => /mobile/i.test(m))).toEqual([])
    const expected: Array<[string, RegExp]> = [
      ['text', /name/i],
      ['select', /currency/i],
      ['select', /template/i],
      ['confirm', /demo/i],
      ['confirm', /install/i],
    ]
    expect(clack.asked).toHaveLength(expected.length)
    expected.forEach(([kind, message], i) => {
      expect(clack.asked[i]?.kind, `prompt ${i}`).toBe(kind)
      expect(clack.asked[i]?.message, `prompt ${i}`).toMatch(message)
    })
  })

  it('AC-5: --yes runs install with the detected package manager, then nymbal seed, both in the project dir', async () => {
    const userAgents: Array<[string, string]> = [
      ['pnpm', 'pnpm/9.12.3 npm/? node/v22.23.3 darwin arm64'],
      ['npm', 'npm/10.9.2 node/v22.23.3 darwin arm64 workspaces/false'],
      ['yarn', 'yarn/1.22.22 npm/? node/v22.23.3 darwin arm64'],
    ]
    for (const [pm, ua] of userAgents) {
      runs = []
      process.env['npm_config_user_agent'] = ua
      const cwd = await tempDir(`yes-${pm}`)
      process.chdir(cwd)
      await main(argv('shop', '--yes'), { run })

      const projectDir = join(cwd, 'shop')
      const lines = runs.map((r) => [r.cmd, ...r.args].join(' '))
      const installAt = lines.findIndex((l) => new RegExp(`^${pm} install\\b`).test(l))
      const seedAt = lines.findIndex((l) => /\bnymbal\b.*\bseed\b/.test(l))
      expect(
        installAt,
        `${pm}: install not run; ran ${JSON.stringify(lines)}`,
      ).toBeGreaterThanOrEqual(0)
      expect(seedAt, `${pm}: nymbal seed not run; ran ${JSON.stringify(lines)}`).toBeGreaterThan(
        installAt,
      )
      for (const at of [installAt, seedAt]) expect(realpathSync(runs[at]!.cwd), pm).toBe(projectDir)
      expect(existsSync(join(projectDir, 'package.json')), pm).toBe(true)
      expect(clack.asked, `${pm}: --yes must not prompt`).toEqual([])
    }
  })

  it('AC-5: --no-install, and interactive mode with install declined, run neither install nor seed', async () => {
    expect(parseCliFlags(argv('shop', '--yes', '--no-install')).install).toBe(false)
    expect(parseCliFlags(argv('shop', '--yes')).install).not.toBe(false)

    const filesOnly = await tempDir('no-install')
    process.chdir(filesOnly)
    await main(argv('shop', '--yes', '--no-install'), { run })
    expect(runs).toEqual([])
    expect(existsSync(join(filesOnly, 'shop', 'package.json'))).toBe(true)
    expect(LOCKFILES.filter((f) => existsSync(join(filesOnly, 'shop', f)))).toEqual([])

    const declined = await tempDir('declined')
    process.chdir(declined)
    clack.installAnswer = false
    await main(argv(), { run })
    expect(clack.asked.some((p) => /install/i.test(p.message))).toBe(true)
    expect(runs).toEqual([])
  })
})

// ─── AC-2, AC-4, AC-6: what scaffold() writes ────────────────────────────────────────────────────────────────────

describe('scaffold() output', () => {
  const out = {} as Record<Template, string>

  beforeAll(async () => {
    for (const template of TEMPLATES) {
      out[template] = await scaffoldInto(template, 'pnpm/9.12.3 npm/? node/v22.23.3 darwin arm64')
    }
  }, 60_000)

  for (const template of TEMPLATES) {
    it(`AC-2: ${template} pins every Nymbal dependency and override to one exact version, @nymbalhq/stack's`, async () => {
      const pkg = await readJson<Manifest>(join(out[template], 'package.json'))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      const nymbalDeps = Object.entries(deps).filter(([name]) => isNymbal(name))
      expect(nymbalDeps.length).toBeGreaterThan(0)

      // Exact: a bare semver (a prerelease suffix allowed for snapshots), no ^ ~ > < * x or ranges.
      for (const [name, spec] of nymbalDeps)
        expect(spec, name).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
      const cohort = new Set(nymbalDeps.map(([, spec]) => spec))
      expect([...cohort]).toHaveLength(1)
      const version = [...cohort][0]!

      expect(Object.keys(deps)).toContain('@nymbalhq/stack')

      // Every @nymbalhq/* package the sources import is a dependency.
      const imported = await importedNymbalPackages(out[template])
      expect(imported.size).toBeGreaterThan(0)
      expect([...imported].filter((name) => !(name in deps))).toEqual([])

      // Both override maps: names ⊇ the Nymbal dependencies, every Nymbal value = the cohort version.
      for (const [field, overrides] of [
        ['pnpm.overrides', pkg.pnpm?.overrides],
        ['overrides', pkg.overrides],
      ] as const) {
        expect(overrides, field).toBeTypeOf('object')
        const missing = nymbalDeps.map(([name]) => name).filter((name) => !(name in overrides!))
        expect(missing, `${field} misses`).toEqual([])
        for (const [name, spec] of Object.entries(overrides!).filter(([n]) => isNymbal(n))) {
          expect(spec, `${field}.${name}`).toBe(version)
        }
      }

      const stack = await readJson<Manifest>(join(PACKAGES, 'stack', 'package.json'))
      expect(version).toBe(stack.version)
    })
  }

  for (const template of TEMPLATES) {
    it(`AC-4: ${template} has .node-version equal to the repo's, .npmrc with engine-strict=true, engines.node >=22`, async () => {
      const dir = out[template]
      const repoNode = (await readFile(join(REPO_ROOT, '.node-version'), 'utf8')).trim()
      expect(existsSync(join(dir, '.node-version')), '.node-version').toBe(true)
      expect((await readFile(join(dir, '.node-version'), 'utf8')).trim()).toBe(repoNode)
      expect(existsSync(join(dir, '.npmrc')), '.npmrc').toBe(true)
      const npmrc = (await readFile(join(dir, '.npmrc'), 'utf8'))
        .split(/\r?\n/)
        .map((l) => l.trim())
      expect(npmrc).toContain('engine-strict=true')
      expect((await readJson<Manifest>(join(dir, 'package.json'))).engines?.node).toBe('>=22')
    })
  }

  it('AC-4: packageManager is <pm>@<version> from the pnpm, npm or yarn user agent', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('pnpm', 'npm', 'yarn'),
        fc.tuple(fc.nat(40), fc.nat(40), fc.nat(40)),
        fc.constantFrom(...TEMPLATES),
        async (pm, [major, minor, patch], template) => {
          const version = `${major}.${minor}.${patch}`
          const ua = `${pm}/${version} npm/? node/v22.23.3 linux x64`
          const dir = await scaffoldInto(template, ua)
          const pkg = await readJson<Manifest>(join(dir, 'package.json'))
          expect(pkg.packageManager).toBe(`${pm}@${version}`)
        },
      ),
      { numRuns: 8 },
    )
  }, 60_000)

  it('AC-4: without a user agent, packageManager is npm@<npm -v>', async () => {
    const npm = spawnSync('npm', ['-v'], { encoding: 'utf8' })
    expect(npm.status).toBe(0)
    const dir = await scaffoldInto('astro', undefined)
    const pkg = await readJson<Manifest>(join(dir, 'package.json'))
    expect(pkg.packageManager).toBe(`npm@${npm.stdout.trim()}`)
  })

  for (const template of TEMPLATES) {
    it(`AC-6: ${template}'s generated nymbal.config.ts parses with the config schema and uses native payments`, async () => {
      const dir = out[template]
      // The config imports @nymbalhq/config; link the workspace package in as an install would.
      await mkdir(join(dir, 'node_modules', '@nymbalhq'), { recursive: true })
      if (!existsSync(join(dir, 'node_modules', '@nymbalhq', 'config'))) {
        await symlink(
          join(PACKAGES, 'config'),
          join(dir, 'node_modules', '@nymbalhq', 'config'),
          'dir',
        )
      }
      const { config, projectRoot } = await loadConfig(dir)
      expect(realpathSync(projectRoot)).toBe(dir)
      expect(config.template).toBe(template)
      expect(config.commerce.payments.provider).toBe('native')
    })
  }

  // A fresh project runs no AI provider and lists no provider SDK or adapter package, so its install holds none.
  for (const template of TEMPLATES) {
    it(`AC-7: ${template}'s generated config has ai { provider: 'none' } and its package.json lists no provider SDK or adapter package`, async () => {
      const dir = out[template]
      await mkdir(join(dir, 'node_modules', '@nymbalhq'), { recursive: true })
      if (!existsSync(join(dir, 'node_modules', '@nymbalhq', 'config'))) {
        await symlink(
          join(PACKAGES, 'config'),
          join(dir, 'node_modules', '@nymbalhq', 'config'),
          'dir',
        )
      }
      const { config } = await loadConfig(dir)
      const pkg = await readJson<Manifest>(join(dir, 'package.json'))
      const listed = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ]

      expect(config.commerce.ai).toEqual({ provider: 'none' })
      expect(
        listed.filter(
          (n) =>
            ['stripe', '@anthropic-ai/sdk', 'nodemailer'].includes(n) ||
            ADAPTER_PACKAGES.includes(n),
        ),
      ).toEqual([])
    })
  }
})

// ─── AC-3: the stack cohort ──────────────────────────────────────────────────────────────────────────────────────

describe('@nymbalhq/stack', () => {
  it('AC-3: packages/stack depends on every public runtime package at its repo version, exactly', async () => {
    const path = join(PACKAGES, 'stack', 'package.json')
    expect(existsSync(path), 'packages/stack/package.json').toBe(true)
    const stack = await readJson<Manifest>(path)
    expect(stack.name).toBe('@nymbalhq/stack')
    expect(stack.private).not.toBe(true)
    for (const [name, dir] of Object.entries(PUBLIC_RUNTIME)) {
      const current = (await readJson<Manifest>(join(PACKAGES, dir, 'package.json'))).version
      expect(stack.dependencies?.[name], name).toBe(current)
    }
  })

  it('AC-3: .changeset/config.json puts the stack and every package it pins in one fixed group', async () => {
    const changesets = await readJson<{ fixed: string[][] }>(
      join(REPO_ROOT, '.changeset', 'config.json'),
    )
    const groups = changesets.fixed.filter((group) => group.includes('@nymbalhq/stack'))
    expect(groups).toHaveLength(1)
    const missing = Object.keys(PUBLIC_RUNTIME).filter((name) => !groups[0]!.includes(name))
    expect(missing).toEqual([])
  })
})

/** Package names (`@nymbalhq/x`) that the project's source files import. */
async function importedNymbalPackages(root: string): Promise<Set<string>> {
  const names = new Set<string>()
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (/\.(ts|tsx|mts|mjs|js|jsx|astro)$/.test(e.name)) {
        const text = await readFile(full, 'utf8')
        for (const m of text.matchAll(
          /(?:from\s+|import\s*\(\s*|import\s+)['"](@nymbalhq\/[a-z0-9-]+)/g,
        )) {
          names.add(m[1]!)
        }
      }
    }
  }
  await walk(root)
  return names
}
