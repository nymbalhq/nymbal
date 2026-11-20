// Reads: stryker.config.mjs, stryker.integration.config.mjs
// Reads: vitest.stryker.config.ts, vitest.stryker.integration.config.ts
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { REPO } from './scratch-gate'

// Stryker copies only what its ignorePatterns keep into a sandbox, and its Vitest runner fails the initial test run
// when a test file there cannot load (an import of a file the sandbox leaves out). So a test file in a Stryker Vitest
// include list that reaches outside its sandbox stops every mutation run, local and CI alike. Each config is run here
// for real up to the sandbox: Stryker builds it with the config's own patterns and mutate set, then, in place of the
// tests, runs `vitest list` over the config's include list there, which imports every test file without running it.
// The files it collects there must be the files Vitest finds for that config in the checkout: none left behind by the
// sandbox's patterns, none failing to load.

const exec = promisify(execFile)
const STRYKER = join(REPO, 'node_modules/.bin/stryker')

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Listed = Array<{ file: string }>

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('VITEST') && !k.startsWith('NYMBAL_') && k !== 'NODE_OPTIONS') env[k] = v
  }
  return env
}

/** The test files Vitest finds under `vitestConfig` in the checkout, without loading them. */
async function inCheckout(vitestConfig: string): Promise<string[]> {
  const { stdout } = await exec(
    join(REPO, 'node_modules/.bin/vitest'),
    ['list', '--filesOnly', '--json', '--config', vitestConfig],
    { cwd: REPO, env: childEnv(), maxBuffer: 64 * 1024 * 1024 },
  )
  const rows = JSON.parse(stdout.slice(stdout.indexOf('['))) as Listed
  return [...new Set(rows.map((row) => relative(REPO, row.file)))].sort()
}

async function loadInSandbox(
  config: string,
): Promise<{ code: number; output: string; collected: string[] }> {
  const scratch = mkdtempSync(join(tmpdir(), 'nymbal-stryker-loads-'))
  created.push(scratch)
  const listed = join(scratch, 'listed.json')
  const tempDirName = `.stryker-tmp-loads-${process.pid}-${created.length}`
  created.push(join(REPO, tempDirName))
  const configFile = join(scratch, 'stryker.config.mjs')
  writeFileSync(
    configFile,
    [
      `import config from ${JSON.stringify(pathToFileURL(join(REPO, config)).href)}`,
      'export default {',
      '  ...config,',
      "  testRunner: 'command',",
      '  commandRunner: {',
      `    command: \`node_modules/.bin/vitest list --json=${listed} --config \${config.vitest.configFile}\`,`,
      '  },',
      "  coverageAnalysis: 'off',",
      '  ignoreStatic: false,',
      '  dryRunOnly: true,',
      '  reporters: [],',
      '  incremental: false,',
      '  concurrency: 1,',
      `  tempDirName: ${JSON.stringify(tempDirName)},`,
      '}',
      '',
    ].join('\n'),
  )
  let code = 0
  let output: string
  try {
    const { stdout, stderr } = await exec(STRYKER, ['run', configFile], {
      cwd: REPO,
      env: childEnv(),
      maxBuffer: 64 * 1024 * 1024,
    })
    output = `${stdout}\n${stderr}`
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    code = typeof failed.code === 'number' ? failed.code : 1
    output = `${failed.stdout ?? ''}\n${failed.stderr ?? ''}`
  }
  // Paths in the sandbox, made relative to its root (<tempDirName>/sandbox-<id>/).
  const rows = existsSync(listed) ? (JSON.parse(readFileSync(listed, 'utf8')) as Listed) : []
  const sandboxPath = (file: string): string => {
    const [, under = file] = file.split(`/${tempDirName}/`)
    return under.slice(under.indexOf('/') + 1)
  }
  const collected = [...new Set(rows.map((row) => sandboxPath(row.file)))].sort()
  return { code, output, collected }
}

describe('every test file Stryker includes loads inside its sandbox', () => {
  it.each(['stryker.config.mjs', 'stryker.integration.config.mjs'])(
    '%s: Vitest collects every included test file in the sandbox and the initial run completes',
    async (config) => {
      const { default: options } = (await import(pathToFileURL(join(REPO, config)).href)) as {
        default: { vitest: { configFile: string } }
      }
      const expected = await inCheckout(options.vitest.configFile)
      const { code, output, collected } = await loadInSandbox(config)
      expect(output, output).toMatch(/Initial test run succeeded/)
      expect(code, output).toBe(0)
      expect(expected.length, 'test files the config includes').toBeGreaterThan(0)
      expect(collected, 'the files collected in the sandbox').toEqual(expected)
    },
    300_000,
  )
})
