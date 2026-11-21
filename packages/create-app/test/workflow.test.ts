import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Clack from '@clack/prompts'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { parseYaml, type Yaml } from '../../../tests/tooling/workflow-yaml.js'
import { main, renderWorkflow, type PackageManager } from '../src/index.js'

// The CI workflow every new store gets: what renderWorkflow writes for each package manager (read with the repo's
// block-YAML reader, which throws on anything outside the subset GitHub's workflows here use), and that each path
// through main() writes it for the manager that launched create-nymbal-app.

const WORKFLOW = '.github/workflows/nymbal.yml'

/** Per package manager: the user agent that selects it, and its row of the workflow table. */
const MANAGERS: Record<
  PackageManager,
  {
    userAgent: string
    /** The step that sets the manager up before setup-node: a `uses` action, or a `run` holding this text. */
    setup: { uses: string } | { run: string } | null
    cache: string | null
    install: string
    verify: string
  }
> = {
  npm: {
    userAgent: 'npm/10.9.2 node/v26.12.1 darwin arm64 workspaces/false',
    setup: null,
    cache: 'npm',
    install: 'npm ci',
    verify: 'npx nymbal verify',
  },
  pnpm: {
    userAgent: 'pnpm/10.18.0 npm/? node/v26.12.1 darwin arm64',
    setup: { uses: 'pnpm/action-setup@' },
    cache: 'pnpm',
    install: 'pnpm install --frozen-lockfile',
    verify: 'pnpm exec nymbal verify',
  },
  'yarn-classic': {
    userAgent: 'yarn/1.22.22 npm/? node/v26.12.1 darwin arm64',
    setup: null,
    cache: 'yarn',
    install: 'yarn install --frozen-lockfile',
    verify: 'yarn run nymbal verify',
  },
  'yarn-berry': {
    userAgent: 'yarn/4.5.3 npm/? node/v26.12.1 darwin arm64',
    setup: { run: 'corepack enable' },
    cache: 'yarn',
    install: 'yarn install --immutable',
    verify: 'yarn exec nymbal verify',
  },
  bun: {
    userAgent: 'bun/1.2.19 npm/? node/v24.3.0 darwin arm64',
    setup: { uses: 'oven-sh/setup-bun@' },
    cache: null,
    install: 'bun install --frozen-lockfile',
    verify: 'bunx nymbal verify',
  },
}
const PMS = Object.keys(MANAGERS) as PackageManager[]

type YamlMap = { [key: string]: Yaml }
const asMap = (value: Yaml | undefined, what: string): YamlMap => {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what} is not a mapping: ${JSON.stringify(value)}`)
  }
  return value
}
interface Step {
  uses?: string
  run?: string
  with?: YamlMap
}

function read(pm: PackageManager) {
  const text = renderWorkflow(pm)
  const doc = asMap(parseYaml(text), 'the workflow')
  const jobs = asMap(doc['jobs'], 'jobs')
  const verify = asMap(jobs['verify'], 'jobs.verify')
  const steps = (verify['steps'] as Yaml[]).map((s) => asMap(s, 'a step') as Step)
  const at = (match: (s: Step) => boolean) => steps.findIndex(match)
  return { text, doc, jobs, steps, at }
}

// ─── AC-12 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-12: renderWorkflow', () => {
  for (const pm of PMS) {
    const row = MANAGERS[pm]

    it(`AC-12: ${pm}: read-only token at workflow level and none per job, on pull_request and push to main, no secret`, () => {
      const { text, doc, jobs } = read(pm)

      expect(doc['permissions']).toEqual({ contents: 'read' })
      expect(
        Object.entries(jobs).filter(([, job]) => 'permissions' in asMap(job, 'a job')),
      ).toEqual([])
      const on = asMap(doc['on'], 'on')
      expect('pull_request' in on).toBe(true)
      // No branch filter on pull requests: a Renovate branch must be checked whatever its base.
      expect(
        on['pull_request'] === null || !('branches' in asMap(on['pull_request'], 'pull_request')),
      ).toBe(true)
      expect(asMap(on['push'], 'push')['branches']).toEqual(['main'])
      expect(text).not.toMatch(/secrets\./)
    })

    it(`AC-12: ${pm}: setup-node reads .node-version with ${row.cache === null ? 'no cache key' : `cache ${row.cache}`}`, () => {
      const { steps } = read(pm)

      const setupNode = steps.filter((s) => s.uses?.startsWith('actions/setup-node@'))
      expect(setupNode).toHaveLength(1)
      const inputs = setupNode[0]!.with ?? {}
      expect(inputs['node-version-file']).toBe('.node-version')
      // bun has no cache input at all: setup-node takes npm, yarn and pnpm only.
      expect('cache' in inputs).toBe(row.cache !== null)
      expect(inputs['cache'] ?? null).toBe(row.cache)
    })

    it(`AC-12: ${pm}: checkout, then its setup, then setup-node, and the run steps end with its frozen install then its verify`, () => {
      const { steps, at } = read(pm)

      const checkout = at((s) => s.uses?.startsWith('actions/checkout@') === true)
      const setupNode = at((s) => s.uses?.startsWith('actions/setup-node@') === true)
      const runs = steps.filter((s) => typeof s.run === 'string').map((s) => s.run!.trim())
      expect(runs.slice(-2)).toEqual([row.install, row.verify])
      const install = at((s) => s.run?.trim() === row.install)
      const verify = at((s) => s.run?.trim() === row.verify)

      expect(checkout).toBe(0)
      expect(setupNode).toBeGreaterThan(checkout)
      expect(install).toBeGreaterThan(setupNode)
      expect(verify).toBeGreaterThan(install)

      const pnpmSetup = at((s) => s.uses?.startsWith('pnpm/action-setup@') === true)
      expect(
        pnpmSetup > checkout && pnpmSetup < setupNode,
        `pnpm/action-setup at ${pnpmSetup}`,
      ).toBe(pm === 'pnpm')
      expect(pnpmSetup === -1, `pnpm/action-setup at ${pnpmSetup}`).toBe(pm !== 'pnpm')
      const setup = row.setup
      const own =
        setup === null
          ? -1
          : at(
              (s) =>
                ('uses' in setup ? s.uses?.startsWith(setup.uses) : s.run?.includes(setup.run)) ===
                true,
            )
      expect(
        setup === null || (own > checkout && own < setupNode),
        `${pm}: its setup step at ${own}, between checkout ${checkout} and setup-node ${setupNode}`,
      ).toBe(true)
    })
  }

  it("AC-12: no two managers share an install or a verify line, so none runs another's", () => {
    const lines = PMS.map((pm) =>
      read(pm)
        .steps.filter((s) => typeof s.run === 'string')
        .map((s) => s.run!.trim()),
    )
    const installs = new Set(lines.map((l) => l.at(-2)))
    const verifies = new Set(lines.map((l) => l.at(-1)))
    expect([installs.size, verifies.size]).toEqual([PMS.length, PMS.length])
  })
})

// ─── AC-13 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const clack = vi.hoisted(() => ({ asked: 0 }))

vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof Clack>()
  return {
    ...actual,
    intro: () => {},
    outro: () => {},
    note: () => {},
    cancel: () => {},
    text: async (opts: { message: string; initialValue?: string }) => {
      clack.asked += 1
      return /email/i.test(opts.message) ? (opts.initialValue ?? 'admin@shop.example') : 'Shop'
    },
    select: async (opts: { initialValue?: unknown; options: Array<{ value: unknown }> }) => {
      clack.asked += 1
      return opts.initialValue ?? opts.options[0]?.value
    },
    // Install is always declined: a real install would shell out.
    confirm: async (opts: { message: string; initialValue?: boolean }) => {
      clack.asked += 1
      return /install/i.test(opts.message) ? false : (opts.initialValue ?? false)
    },
  }
})

const scratch: string[] = []
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

/** Every entry under `dir` whose name still starts with `_dot`, node_modules aside. */
async function dotNames(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.name.startsWith('_dot')) found.push(path)
    if (entry.isDirectory()) found.push(...(await dotNames(path)))
  }
  return found
}

describe('AC-13: every path through main() writes the workflow for the detected manager', () => {
  const originalCwd = process.cwd()
  const originalUa = process.env['npm_config_user_agent']
  afterEach(() => {
    process.chdir(originalCwd)
    if (originalUa === undefined) delete process.env['npm_config_user_agent']
    else process.env['npm_config_user_agent'] = originalUa
  })

  const PATHS: Array<[string, string[]]> = [
    ['--yes', ['shop', '--yes']],
    ['--yes --no-install', ['shop', '--yes', '--no-install']],
    ['interactive, install declined', []],
  ]

  for (const [path, args] of PATHS) {
    it(`AC-13: ${path}: under each manager's user agent the project's ${WORKFLOW} is renderWorkflow of that manager, the Node version file it names is there, and no _dot name is left`, async () => {
      for (const pm of PMS) {
        process.env['npm_config_user_agent'] = MANAGERS[pm].userAgent
        const cwd = realpathSync(await mkdtemp(join(tmpdir(), `workflow-${pm}-`)))
        scratch.push(cwd)
        process.chdir(cwd)
        clack.asked = 0
        await main(['node', 'create-nymbal-app', ...args], { run: async () => {} })

        const project = join(cwd, 'shop')
        expect(existsSync(join(project, 'package.json')), `${pm}: no project at ${project}`).toBe(
          true,
        )
        const written = await readFile(join(project, WORKFLOW), 'utf8').catch(() => null)
        expect(written, `${pm} (${path}): no ${WORKFLOW}`).not.toBeNull()
        expect(written, `${pm} (${path}): ${WORKFLOW}`).toBe(renderWorkflow(pm))
        // setup-node throws on a node-version-file that is not there, so CI would stop before install.
        const steps = asMap(
          asMap(asMap(parseYaml(written!), 'the workflow')['jobs'], 'jobs')['verify'],
          'jobs.verify',
        )['steps'] as Yaml[]
        const versionFile = steps
          .map((s) => asMap(s, 'a step') as Step)
          .find((s) => s.uses?.startsWith('actions/setup-node@'))?.with?.['node-version-file']
        expect(typeof versionFile, `${pm}: node-version-file`).toBe('string')
        expect(
          existsSync(join(project, versionFile as string)),
          `${pm} (${path}): ${String(versionFile)} is not in the project`,
        ).toBe(true)
        expect(await dotNames(project), pm).toEqual([])
        expect(clack.asked > 0, `${pm}: prompted`).toBe(args.length === 0)
      }
    }, 60_000)
  }
})
