import { execFile, execFileSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Step } from '../../scripts/gate'

// Scratch repositories the real scripts/gate.ts runs in. `pnpm` on the PATH and `node_modules/.bin/playwright` are
// stand-ins that log their arguments, one call per line, to `<scratch>/calls.log` and exit 0; a Playwright stand-in
// writes `reports/e2e-shutdown.json` when FAKE_SHUTDOWN_COMMAND is set, as the E2E wrapper does when a server
// outlives its shutdown. `scripts/` links to this checkout's scripts, and `node_modules/.bin/tsx` runs this
// checkout's tsx, so a step that calls either works as it does here.

export const REPO = fileURLToPath(new URL('../../', import.meta.url))
export const TSX = join(REPO, 'node_modules/.bin/tsx')
export const GATE = join(REPO, 'scripts/gate.ts')

const created: string[] = []

export function cleanupScratch(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.NYMBAL_TEST_POSTGRES_URL
  delete env.CI
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return { ...env, ...extra }
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
}

const STAND_IN = `#!/usr/bin/env bash
echo "$NAME $*" >>"$SCRATCH/calls.log"
case " $* " in
  *" playwright "*|*"playwright test"*|"playwright "*) PW=1 ;;
esac
[ "$NAME" = playwright ] && PW=1
if [ -n "$PW" ] && [ -n "$FAKE_SHUTDOWN_COMMAND" ]; then
  mkdir -p reports
  printf '{"command":"%s","pid":4242,"waitedMs":5000}\\n' "$FAKE_SHUTDOWN_COMMAND" >reports/e2e-shutdown.json
fi
exit 0
`

export type Scratch = { root: string; bin: string; calls: () => string[] }

/**
 * A git repository holding `files` at its base commit (HEAD), with the stand-ins and links described above. With
 * `realModules`, `node_modules` links to this checkout's, for steps that run Vitest for real.
 */
export function scratchRepo(
  files: Record<string, string>,
  opts: { realModules?: boolean } = {},
): Scratch {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-gate-')))
  created.push(root)
  for (const [path, text] of Object.entries(files)) write(root, path, text)
  symlinkSync(join(REPO, 'scripts'), join(root, 'scripts'))
  const bin = join(root, '.bin')
  mkdirSync(bin)
  const standIn = (path: string, name: string): void => {
    writeFileSync(
      path,
      STAND_IN.replace('#!/usr/bin/env bash\n', `#!/usr/bin/env bash\nNAME=${name}\n`),
    )
    chmodSync(path, 0o755)
  }
  standIn(join(bin, 'pnpm'), 'pnpm')
  if (opts.realModules === true) {
    symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'))
  } else {
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
    writeFileSync(join(root, 'node_modules/.bin/tsx'), `#!/bin/sh\nexec '${TSX}' "$@"\n`)
    chmodSync(join(root, 'node_modules/.bin/tsx'), 0o755)
    standIn(join(root, 'node_modules/.bin/playwright'), 'playwright')
  }
  git(root, 'init', '-q', '-b', 'dev')
  appendFileSync(
    join(root, '.git/info/exclude'),
    'scripts\nnode_modules\n.bin\ncalls.log\nreports/\n',
  )
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  const log = join(root, 'calls.log')
  return {
    root,
    bin,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
  }
}

export type CliRun = {
  code: number | null
  output: string
  stdout: string
  steps: Step[]
  ms: number
}

/** Runs the real gate.ts in `scratch` with the stand-ins first on the PATH. `steps` is from `--json`, when given. */
export function gateCli(
  scratch: Scratch,
  args: string[],
  env: Record<string, string> = {},
  usePnpmStandIn = true,
): Promise<CliRun> {
  const started = Date.now()
  return new Promise((resolvePromise) => {
    execFile(
      TSX,
      [GATE, ...args],
      {
        cwd: scratch.root,
        env: childEnv({
          ...(usePnpmStandIn ? { PATH: `${scratch.bin}:${process.env.PATH ?? ''}` } : {}),
          SCRATCH: scratch.root,
          ...env,
        }),
        encoding: 'utf8',
        timeout: 90_000,
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' ? error.code : (error.code ?? null)
        const json = stdout
          .split('\n')
          .reverse()
          .find((line) => line.startsWith('{'))
        let steps: Step[] = []
        try {
          steps = json === undefined ? [] : ((JSON.parse(json) as { steps?: Step[] }).steps ?? [])
        } catch {
          steps = []
        }
        resolvePromise({
          code: code as number | null,
          output: `${stdout}${stderr}`,
          stdout,
          steps,
          ms: Date.now() - started,
        })
      },
    )
  })
}

/** The package and app outputs `artefactPresent` requires, for one built package. */
export const ARTEFACT: Record<string, string> = {
  'packages/alpha/package.json': JSON.stringify({
    name: '@nymbalhq/alpha',
    scripts: { build: 'tsup' },
  }),
  'packages/alpha/dist/index.js': 'export {}\n',
  'templates/astro/dist/index.html': '<!doctype html>\n',
  'templates/nextjs/.next/BUILD_ID': 'scratch\n',
  'apps/admin/dist/index.html': '<!doctype html>\n',
}

export const GATE_PACKAGE_JSON = JSON.stringify({
  name: 'gate-scratch',
  private: true,
  scripts: { lint: 'true', typecheck: 'true', sentinels: 'true', 'mutation:ratchet': 'true' },
})

export const STRYKER_CONFIG = "export default { mutate: ['nothing/**/*.ts'] }\n"
