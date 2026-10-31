import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '@nymbalhq/config'
import { scaffold } from '../../../create-app/src/index.js'
import {
  changedPaths,
  copyProject,
  listing,
  removeAll,
  tempDir,
} from '../recipes/fixtures/linked-project.js'
import { readRecipe } from '../recipes/index.js'
import { add, type AddOptions } from './add.js'

// AC-8: `nymbal add algolia` on a fresh create-nymbal-app config (scaffolded with --no-install's files, the workspace
// packages linked into node_modules, a pnpm lockfile), through `add` in process with its output captured. Without the
// package: --dry-run exits 1 naming the holder and the install line. With it: --dry-run exits 0, shows the change and
// writes nothing; the run sets commerce.search to algolia, adds the two required variables to .env.example, leaves no
// secret in the config and says to replay search. Needs `pnpm build` (the linked packages are their builds).

const PACKAGE = '@nymbalhq/search-algolia'
const dirs: string[] = []
let scaffolded = ''
let userAgent: string | undefined

beforeAll(async () => {
  // The install line follows the project's lockfile, not the package manager running the tests.
  userAgent = process.env['npm_config_user_agent']
  delete process.env['npm_config_user_agent']
  scaffolded = tempDir('add-algolia-base')
  dirs.push(scaffolded)
  await scaffold(scaffolded, {
    name: 'Algolia Shop',
    directory: 'algolia-shop',
    currency: 'GBP',
    template: 'astro',
    seedDemo: false,
  })
}, 60_000)

afterAll(() => {
  if (userAgent !== undefined) process.env['npm_config_user_agent'] = userAgent
  removeAll(dirs)
})

function projectFrom(label: string, omit: string[] = []): string {
  const dir = copyProject(scaffolded, label, omit)
  dirs.push(dir)
  writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  return dir
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')

async function addAlgolia(
  dir: string,
  opts: Partial<AddOptions> = {},
): Promise<{ code: number; out: string }> {
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
        target: { kind: 'recipe', name: 'algolia' },
        install: false,
        force: false,
        dryRun: false,
        ...opts,
      },
      dir,
    )
    return { code, out: stripAnsi(out) }
  } finally {
    stdout.mockRestore()
    stderr.mockRestore()
  }
}

const envNames = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
    .filter((n): n is string => n !== undefined)

describe('AC-8: nymbal add algolia', () => {
  it('AC-8: without the package installed, --dry-run exits 1 saying the recipe ships in @nymbalhq/search-algolia and how to install it, and changes nothing', async () => {
    const dir = projectFrom('algolia-missing', [PACKAGE])
    const before = listing(dir)

    const run = await addAlgolia(dir, { dryRun: true })

    expect(run.code, run.out).toBe(1)
    expect(run.out).toContain(
      `the algolia recipe ships in ${PACKAGE}, which is not installed. Install it: pnpm add ${PACKAGE}`,
    )
    expect(changedPaths(before, listing(dir))).toEqual([])
  })

  it('AC-8: with the package installed, --dry-run exits 0, shows commerce.search becoming algolia and both required variables, and changes nothing', async () => {
    const dir = projectFrom('algolia-dry')
    const before = listing(dir)

    const run = await addAlgolia(dir, { dryRun: true })

    expect(run.code, run.out).toBe(0)
    const added = run.out.split('\n').filter((l) => /^\s*\+ /.test(l))
    expect(
      added.filter((l) => /provider: ['"]algolia['"]/.test(l)),
      run.out,
    ).toHaveLength(1)
    for (const name of ['ALGOLIA_APP_ID', 'ALGOLIA_API_KEY']) {
      expect(
        run.out.split('\n').filter((l) => l.trim().startsWith(`${name}=`)),
        name,
      ).toHaveLength(1)
    }
    expect(changedPaths(before, listing(dir))).toEqual([])
  })

  it('AC-8: the run sets commerce.search to algolia in a config loadConfig accepts, adds the two required variables to .env.example once, puts no key in the config, and says to replay search', async () => {
    const dir = projectFrom('algolia-run')
    const before = listing(dir)
    const exampleBefore = envNames(readFileSync(join(dir, '.env.example'), 'utf8'))

    const run = await addAlgolia(dir)

    expect(run.code, run.out).toBe(0)
    expect(changedPaths(before, listing(dir))).toEqual(['.env.example', 'nymbal.config.ts'])
    const { config } = await loadConfig(dir)
    expect(config.commerce.search.provider).toBe('algolia')
    expect(config.commerce.search.package).toBeUndefined()
    const source = readFileSync(join(dir, 'nymbal.config.ts'), 'utf8')
    expect(source.match(/apiKey|ALGOLIA_API_KEY/g) ?? []).toEqual([])
    const exampleAfter = envNames(readFileSync(join(dir, '.env.example'), 'utf8'))
    const addedNames = exampleAfter.filter((n) => !exampleBefore.includes(n))
    expect(addedNames.filter((n) => n !== 'ALGOLIA_INDEX').sort()).toEqual([
      'ALGOLIA_API_KEY',
      'ALGOLIA_APP_ID',
    ])
    expect(exampleAfter.filter((n) => n.startsWith('ALGOLIA_API_KEY')).length).toBe(
      exampleBefore.filter((n) => n.startsWith('ALGOLIA_API_KEY')).length + 1,
    )
    expect(run.out).toContain('nymbal replay --to search')
  })

  it("AC-8: the algolia recipe installs only its package, sets only commerce.search's provider, requires ALGOLIA_APP_ID and ALGOLIA_API_KEY, offers ALGOLIA_INDEX, and its next says to replay search and that a replace holds the catalogue twice", async () => {
    const dir = projectFrom('algolia-recipe')
    const recipe = await readRecipe('algolia', dir)

    expect(recipe.install).toEqual([PACKAGE])
    expect(recipe.set).toEqual([{ path: 'commerce.search', value: { provider: 'algolia' } }])
    expect(recipe.env.map((e) => [e.name, e.required]).sort()).toEqual([
      ['ALGOLIA_API_KEY', true],
      ['ALGOLIA_APP_ID', true],
      ['ALGOLIA_INDEX', false],
    ])
    const next = recipe.next.join('\n')
    expect(next).toContain('nymbal replay --to search')
    expect(next).toMatch(/twice/)
    expect(next).toMatch(/half/)
  })
})
