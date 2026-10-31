// Reads: pnpm-workspace.yaml, **/package.json, scripts/workspace-packages.ts, tests/architecture/workspace-manifests.ts
// Reads: vitest.config.ts, tsconfig.json, .github/workflows/ci.yml, .github/workflows/nightly.yml
// Reads: stryker.config.mjs, stryker.integration.config.mjs, packages/**, tests/contracts/**
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, posix, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import * as expander from '../../scripts/workspace-packages'
import { parseYaml } from '../tooling/workflow-yaml'
import { ROOT, pnpmPackageDirs } from './adapter-table'
import { CALLS_A_SUITE, namedRunners } from './contract-runner-files'
import * as manifests from './workspace-manifests'

// AC-1, the repo half: every workspace member under packages/ that `pnpm -r list` finds on the disk is in each tool's
// view of the workspace, and those tools read it from one module, scripts/workspace-packages.ts. A tool left at
// `packages/*` would otherwise drop a nested package's tests, typecheck, coverage, artefact or sandbox in silence.

const exec = promisify(execFile)

const members = pnpmPackageDirs()

const tracked = (): string[] =>
  execFileSync('git', ['ls-files', '-z', '--', 'packages'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  })
    .split('\0')
    .filter(Boolean)

const trackedUnder = (dir: string, files: string[]): string[] =>
  files.filter((f) => f.startsWith(`${dir}/`))

const manifestOf = (dir: string): { scripts?: Record<string, string> } =>
  JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }

const globMatch = (path: string, globs: string[]): boolean =>
  globs.some((g) => posix.matchesGlob(path, g))

describe('AC-1: one workspace expander', () => {
  it('AC-1: workspace-manifests.ts re-exports the expander of scripts/workspace-packages.ts and defines none of its own', () => {
    const source = readFileSync(join(ROOT, 'tests/architecture/workspace-manifests.ts'), 'utf8')
    const own = [
      /\bfunction\s+workspaceGlobs\b/,
      /\bfunction\s+workspaceMembers\b/,
      /\bfunction\s+globToRegExp\b/,
      /pnpm-workspace\.yaml['"]/,
    ].filter((re) => re.test(source))

    expect(own.map(String)).toEqual([])
    expect(manifests.workspaceMembers).toBe(expander.workspaceMembers)
    expect(manifests.workspaceGlobs).toBe(expander.workspaceGlobs)
  })

  it('AC-1: workspacePackageDirs is every member pnpm finds under packages/, sorted, with no root entry', () => {
    const dirs = expander.workspacePackageDirs(ROOT)

    expect(dirs.filter((d) => d.startsWith('packages/'))).toEqual(members)
    expect(dirs.includes('')).toBe(false)
    expect([...dirs].sort()).toEqual(dirs)
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  it("AC-1: `workspace-packages.ts --manifests` prints each member's package.json, one per line", () => {
    const out = execFileSync(process.execPath, ['scripts/workspace-packages.ts', '--manifests'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    const lines = out.split('\n').filter(Boolean)

    expect(lines.filter((l) => l.startsWith('packages/')).sort()).toEqual(
      members.map((d) => `${d}/package.json`),
    )
    expect(lines.filter((l) => !existsSync(join(ROOT, l)))).toEqual([])
    expect(lines.length).toBe(expander.workspacePackageDirs(ROOT).length)
  })
})

describe("AC-1: every member under packages/ is in each tool's view", () => {
  it('AC-1: a Vitest project collects every tracked test file of every member', async () => {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith('VITEST') && !key.startsWith('NYMBAL_')) env[key] = value
    }
    // The quarantined files are collected by the nightly project, which exists only under NYMBAL_NIGHTLY.
    env['NYMBAL_NIGHTLY'] = '1'
    const { stdout } = await exec(
      join(ROOT, 'node_modules/.bin/vitest'),
      ['list', '--filesOnly', '--json'],
      { cwd: ROOT, env, maxBuffer: 64 * 1024 * 1024 },
    )
    const collected = new Set(
      (JSON.parse(stdout.slice(stdout.indexOf('['))) as Array<{ file: string }>).map((r) =>
        relative(ROOT, r.file).split('\\').join('/'),
      ),
    )
    const files = tracked()
    const tests = members.flatMap((d) =>
      trackedUnder(d, files).filter((f) => /\.test\.tsx?$/.test(f)),
    )
    const missed = tests.filter((f) => !collected.has(f))

    expect(missed).toEqual([])
    expect(tests.filter((f) => collected.has(f)).length).toBe(tests.length)
  }, 60_000)

  it("AC-1: tsconfig.json's typecheck includes every tracked source file under each member's src", () => {
    const shown = JSON.parse(
      execFileSync(join(ROOT, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json', '--showConfig'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 << 20,
      }),
    ) as { files?: string[] }
    const included = new Set((shown.files ?? []).map((f) => posix.normalize(f)))
    const files = tracked()
    const sources = members.flatMap((d) =>
      trackedUnder(`${d}/src`, files).filter((f) => /\.tsx?$/.test(f)),
    )
    const missed = sources.filter((f) => !included.has(f))

    expect(missed).toEqual([])
    expect(sources.filter((f) => included.has(f)).length).toBe(sources.length)
  })

  it("AC-1: coverage reads every member's src, apart from the packages it leaves out by name, and never its src/index.ts", async () => {
    const config = (await import('../../vitest.config')).default as {
      test?: { coverage?: { include?: string[]; exclude?: string[] } }
    }
    const include = config.test?.coverage?.include ?? []
    const exclude = config.test?.coverage?.exclude ?? []
    const byName = (dir: string): boolean => exclude.some((g) => g.startsWith(`${dir}/`))
    const read = members.filter((d) => !byName(d))

    expect(
      read.filter(
        (d) => !(globMatch(`${d}/src/a.ts`, include) && !globMatch(`${d}/src/a.ts`, exclude)),
      ),
    ).toEqual([])
    expect(members.filter((d) => !globMatch(`${d}/src/index.ts`, exclude))).toEqual([])
    expect(read.length).toBeLessThan(members.length)
  })

  it.each(['.github/workflows/ci.yml', '.github/workflows/nightly.yml'])(
    "AC-1: %s's build-output artefact carries the dist of every member with a build script",
    (workflow) => {
      type Step = { uses?: string; with?: Record<string, string> }
      const doc = parseYaml(readFileSync(join(ROOT, workflow), 'utf8')) as {
        jobs?: Record<string, { steps?: Step[] }>
      }
      const uploads = Object.values(doc.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .filter(
          (s) =>
            s.uses?.startsWith('actions/upload-artifact@') === true &&
            s.with?.['name'] === 'build-output',
        )
      const lines = uploads.flatMap((s) =>
        (s.with?.['path'] ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      )
      const include = lines.filter((l) => !l.startsWith('!'))
      const exclude = lines.filter((l) => l.startsWith('!')).map((l) => l.slice(1))
      const building = members.filter((d) => typeof manifestOf(d).scripts?.['build'] === 'string')
      const dropped = building.filter(
        (d) => !globMatch(`${d}/dist`, include) || globMatch(`${d}/dist`, exclude),
      )

      expect(uploads.length).toBe(1)
      expect(dropped).toEqual([])
      expect(building.length).toBeGreaterThan(members.length / 2)
    },
  )

  it("AC-1: both Stryker sandboxes take a member's src and leave its dist as they do packages/platform's", async () => {
    // Stryker's own file walk (the ProjectReader its runs use), over a tree holding every member's manifest, a
    // source file and a dist file, so the verdict is Stryker's matcher on the real ignore patterns.
    const core = dirname(
      createRequire(join(ROOT, 'package.json')).resolve('@stryker-mutator/core/package.json'),
    )
    await import(pathToFileURL(join(core, 'dist/src/index.js')).href)
    const { ProjectReader } = (await import(
      pathToFileURL(join(core, 'dist/src/fs/project-reader.js')).href
    )) as {
      ProjectReader: new (
        fs: unknown,
        log: unknown,
        options: Record<string, unknown>,
      ) => { resolveInputFileNames(): Promise<string[]> }
    }
    const cwd = process.cwd()
    const files = [
      'package.json',
      'tsconfig.json',
      'vitest.stryker.config.ts',
      'vitest.stryker.integration.config.ts',
      ...members.flatMap((d) => [`${d}/package.json`, `${d}/src/a.ts`, `${d}/dist/a.js`]),
    ]
    const dirent = (name: string, dir: boolean) => ({
      name,
      isDirectory: () => dir,
      isFile: () => !dir,
    })
    const fs = {
      readdir: (path: string) => {
        const at = relative(cwd, path).split('\\').join('/')
        const prefix = at === '' ? '' : `${at}/`
        const entries = new Map<string, boolean>()
        for (const f of files.filter((f) => f.startsWith(prefix))) {
          const [head, ...rest] = f.slice(prefix.length).split('/')
          entries.set(head!, rest.length > 0 || entries.get(head!) === true)
        }
        return Promise.resolve([...entries].map(([name, dir]) => dirent(name, dir)))
      },
    }
    const log = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      isDebugEnabled: () => false,
      isTraceEnabled: () => false,
    }
    const sandbox = async (config: string): Promise<Set<string>> => {
      const options = (await import(pathToFileURL(join(ROOT, config)).href)) as {
        default: { mutate: string[]; tempDirName: string; ignorePatterns: string[] }
      }
      const reader = new ProjectReader(fs, log, {
        mutate: options.default.mutate,
        tempDirName: options.default.tempDirName,
        ignorePatterns: options.default.ignorePatterns,
        incremental: false,
        incrementalFile: 'reports/stryker-incremental.json',
        force: false,
        htmlReporter: { fileName: 'reports/mutation.html' },
        jsonReporter: { fileName: 'reports/mutation.json' },
        testFiles: [],
      })
      return new Set(
        (await reader.resolveInputFileNames()).map((f) => relative(cwd, f).split('\\').join('/')),
      )
    }
    const unit = await sandbox('stryker.config.mjs')
    const integration = await sandbox('stryker.integration.config.mjs')
    const platform = (set: Set<string>) => [
      set.has('packages/platform/src/a.ts'),
      set.has('packages/platform/dist/a.js'),
    ]
    const unlike = (set: Set<string>) =>
      members.filter(
        (d) =>
          d !== 'packages/platform' &&
          (set.has(`${d}/src/a.ts`) !== platform(set)[0] ||
            set.has(`${d}/dist/a.js`) !== platform(set)[1]),
      )

    // The unit sandbox is an allowlist of the platform alone; the integration sandbox keeps every package's source.
    expect(platform(unit)).toEqual([true, false])
    expect(members.filter((d) => d !== 'packages/platform' && unit.has(`${d}/src/a.ts`))).toEqual(
      [],
    )
    expect(members.filter((d) => unit.has(`${d}/dist/a.js`))).toEqual([])
    expect(platform(integration)).toEqual([true, false])
    expect(unlike(integration)).toEqual([])
    expect(members.filter((d) => integration.has(`${d}/src/a.ts`)).length).toBe(members.length)
  })

  it("AC-1: namedRunners lists every member's src/contract.test.ts that calls a suite", () => {
    const runners = new Set(namedRunners())
    const expected = members
      .map((d) => `${d}/src/contract.test.ts`)
      .filter(
        (f) => existsSync(join(ROOT, f)) && CALLS_A_SUITE.test(readFileSync(join(ROOT, f), 'utf8')),
      )

    expect(expected.filter((f) => !runners.has(f))).toEqual([])
    expect(expected.length).toBeGreaterThanOrEqual(3)
  })
})
