import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { REPO, write } from './scratch-gate'

// Real Stryker under one of the repository's configs, with every option of its own but the paths it reads, over a
// scratch module and its test.

const exec = promisify(execFile)
const STRYKER = join(REPO, 'node_modules/.bin/stryker')

export type Mutant = { mutatorName: string; status: string; location: { start: { line: number } } }
export type Report = { files: Record<string, { mutants: Mutant[] }> }
export type StrykerRun = { code: number; report: Report | undefined; output: string }

const created: string[] = []

export function cleanupStrykerScratch(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/**
 * Runs Stryker under `config`'s options, mutating `source` among `files` (path to text), and returns its exit code,
 * output and JSON report (none when the run failed before reporting).
 */
export async function strykerUnder(
  config: string,
  source: string,
  files: Record<string, string>,
): Promise<StrykerRun> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-stryker-')))
  created.push(dir)
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'))
  for (const [path, text] of Object.entries(files)) write(dir, path, text)
  write(dir, 'vitest.config.mjs', "export default { test: { include: ['src/**/*.test.ts'] } }\n")
  write(
    dir,
    'stryker.config.mjs',
    [
      `import config from ${JSON.stringify(pathToFileURL(join(REPO, config)).href)}`,
      'export default {',
      '  ...config,',
      `  mutate: [${JSON.stringify(source)}],`,
      "  vitest: { ...config.vitest, configFile: 'vitest.config.mjs' },",
      '  ignorePatterns: [],',
      "  reporters: ['json'],",
      "  jsonReporter: { fileName: 'report.json' },",
      '  incremental: false,',
      '  concurrency: 1,',
      '}',
      '',
    ].join('\n'),
  )
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('VITEST') && !k.startsWith('NYMBAL_') && k !== 'NODE_OPTIONS') env[k] = v
  }
  let code = 0
  let output: string
  try {
    const { stdout, stderr } = await exec(STRYKER, ['run', 'stryker.config.mjs'], {
      cwd: dir,
      env,
      maxBuffer: 16 * 1024 * 1024,
    })
    output = `${stdout}\n${stderr}`
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    code = typeof failed.code === 'number' ? failed.code : 1
    output = `${failed.stdout ?? ''}\n${failed.stderr ?? ''}`
  }
  const reportPath = join(dir, 'report.json')
  const report = existsSync(reportPath)
    ? (JSON.parse(readFileSync(reportPath, 'utf8')) as Report)
    : undefined
  return { code, report, output }
}
