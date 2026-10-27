import { execFile, execFileSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// A copy of this work tree as the base commit of a fresh repository, where a test makes one change and asks the real
// Vitest which test files a tests command selects for it.

export const REPO = fileURLToPath(new URL('../../', import.meta.url))

const created: string[] = []

export function removeCopies(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=f', '-c', 'user.email=f@x', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
}

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** The work tree's files, tracked and untracked alike, committed as the base of a fresh repository. */
export function workTreeCopy(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-harness-inputs-')))
  created.push(dir)
  const files = gitIn(REPO, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0')
    .filter(Boolean)
  for (const path of files) {
    const from = join(REPO, path)
    const link = isLink(from)
    if (!link && !existsSync(from)) continue
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    // A tracked symlink (./migrations) stays a link, relative as git holds it.
    if (link) symlinkSync(readlinkSync(from), join(dir, path))
    else copyFileSync(from, join(dir, path))
  }
  // Dependencies resolve through this checkout's installs, the root's and each package's, and a workspace package
  // through its build output, which git ignores.
  for (const pkg of ['.', ...files.filter((p) => basename(p) === 'package.json').map(dirname)]) {
    for (const ignored of ['node_modules', 'dist']) {
      const from = join(REPO, pkg, ignored)
      if (existsSync(from) && !existsSync(join(dir, pkg, ignored))) {
        symlinkSync(from, join(dir, pkg, ignored))
      }
    }
  }
  gitIn(dir, 'init', '--quiet')
  appendFileSync(join(dir, '.git/info/exclude'), 'node_modules\ndist\n')
  gitIn(dir, 'add', '-A')
  gitIn(dir, 'commit', '--quiet', '-m', 'base')
  return dir
}

/** Puts the copy back at its base commit: no change, staged or not, and no untracked file. */
export function resetCopy(dir: string): void {
  gitIn(dir, 'reset', '--quiet', '--hard', 'HEAD')
  gitIn(dir, 'clean', '--quiet', '-fd')
}

/** The environment a gate command starts from: none of this run's Vitest, gate or CI base variables. */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('VITEST') || key.startsWith('NYMBAL_') || key === 'GATE_BASE') continue
    env[key] = value
  }
  return env
}

export type ShellRun = { code: number; output: string }

/** Runs a gate step's command line in `cwd` as the gate does, through a shell. */
export function shell(cwd: string, command: string, timeout = 240_000): Promise<ShellRun> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      ['-c', command],
      { cwd, env: cleanEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ code, output: `${stdout}${stderr}` })
      },
    )
  })
}

const NO_TEST = "'^no test is named this, so Vitest collects and runs nothing$'"
const REPORTERS = /\s--reporter[= ]\S+|\s--outputFile(?:\.json)?[= ]\S+/g

/**
 * The test files a tests command's Vitest run (its first command) selects in `cwd`: the command itself, its reporters
 * replaced by a JSON report and its tests filtered by a name none has, so Vitest collects the files and runs no test.
 */
export async function selectedFiles(cwd: string, command: string): Promise<string[]> {
  const out = join(mkdtempSync(join(tmpdir(), 'nymbal-selected-')), 'report.json')
  created.push(dirname(out))
  const first = (command.split(' && ')[0] ?? '').replace(REPORTERS, '')
  const run = await shell(cwd, `${first} -t ${NO_TEST} --reporter=json --outputFile.json=${out}`)
  if (!existsSync(out)) {
    throw new Error(`no Vitest report from: ${first}\n${run.output.slice(-3000)}`)
  }
  const report = JSON.parse(readFileSync(out, 'utf8')) as { testResults: Array<{ name: string }> }
  return [...new Set(report.testResults.map((r) => relative(cwd, r.name)))].sort()
}
