// Reads: scripts/registry/**, registry/adapters.json, packages/stack/package.json, packages/adapters/*/*/package.json, package.json, .node-version
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// The real registry run over the real, first-party-only manifest: no adapter is certified, so no container runs and
// this works on any platform. Needs the workspace CLI built.

const REPO = fileURLToPath(new URL('../..', import.meta.url))

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
  delete env['NODE_OPTIONS']
  delete env['NODE_ENV']
  return env
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

type Adapter = { version: string | null; status: string; line?: string }
type Doc = {
  stacks?: Record<string, { packages: Record<string, string>; adapters: Record<string, Adapter> }>
}

describe('AC-20: a first-party-only night writes a matrix the CLI accepts', () => {
  it("AC-20: every entry is first-party at the version in its package's package.json, the row's packages are the stack's, and parseMatrix accepts the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-first-party-'))
    scratch.push(dir)
    mkdirSync(join(dir, 'work'))
    const out = join(dir, 'site')
    const history = join(dir, 'history.json')
    writeFileSync(history, '{}\n')
    const manifestPath = join(REPO, 'registry', 'adapters.json')
    const manifest = readJson<{
      adapters: Array<{ package: string; tier: string; source: { dir: string } }>
    }>(manifestPath)
    const stack = readJson<{
      name: string
      version: string
      dependencies: Record<string, string>
    }>(join(REPO, 'packages', 'stack', 'package.json'))
    const atPackageVersions = () =>
      Object.fromEntries(
        manifest.adapters.map((e) => [
          e.package,
          {
            version: readJson<{ version: string }>(join(REPO, e.source.dir, 'package.json'))
              .version,
            status: 'first-party',
          },
        ]),
      )

    const run = spawnSync(
      'pnpm',
      [
        '--silent',
        'registry',
        '--manifest',
        manifestPath,
        '--history',
        history,
        '--out',
        out,
        '--now',
        '2026-11-09T03:00:00.000Z',
        '--work',
        join(dir, 'work'),
      ],
      { cwd: REPO, encoding: 'utf8', env: cleanEnv(), timeout: 50_000 },
    )
    const file = join(out, 'matrix.json')
    const doc = existsSync(file) ? readJson<Doc>(file) : undefined
    const row = doc?.stacks?.[stack.version]
    const seen =
      row === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(row.adapters).map(([name, a]) => [
              name,
              { version: a.version, status: a.status },
            ]),
          )

    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
    expect(seen).toEqual(atPackageVersions())
    expect(row?.packages).toEqual({ ...stack.dependencies, [stack.name]: stack.version })
    const { parseMatrix } = await import('../../packages/cli/src/upgrade/matrix')
    expect(parseMatrix(doc)).toEqual(doc)
  })
})
