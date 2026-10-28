import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

// How the gate's tests command selects Vitest projects: its filters read from the command, and the projects Vitest
// itself resolves for them.

const REPO = fileURLToPath(new URL('../../', import.meta.url))

/** Shell words of a command line: plain words and single- or double-quoted ones, as package.json scripts write them. */
export function words(command: string): string[] {
  return [...command.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!)
}

/**
 * The `--project` and `--exclude` values of a tests command's Vitest run (its first command), with `pnpm run test`
 * read as the package.json script it runs, and the `NAME=value` assignments that prefix it.
 */
export function vitestFilters(command: string): {
  env: Record<string, string>
  projects: string[]
  excludes: string[]
} {
  let argv = words(command.split(' && ')[0] ?? '')
  const env: Record<string, string> = {}
  while (/^[A-Z][A-Z0-9_]*=/.test(argv[0] ?? '')) {
    const [name = '', ...value] = (argv.shift() ?? '').split('=')
    env[name] = value.join('=')
  }
  if (argv.slice(0, 3).join(' ') === 'pnpm run test') {
    const scripts = (
      JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    argv = [...words(scripts['test'] ?? ''), ...argv.slice(3)]
  }
  const values = (flag: string): string[] =>
    argv.flatMap((word, i) =>
      word === flag
        ? [argv[i + 1] ?? '']
        : word.startsWith(`${flag}=`)
          ? [word.slice(flag.length + 1)]
          : [],
    )
  return { env, projects: values('--project'), excludes: values('--exclude') }
}

/** The harness-style projects a tests command leaves out: those its environment skips or its filters do not select. */
export function leftOut(command: string, names: string[]): string[] {
  const { env, projects } = vitestFilters(command)
  const skipped = (env['NYMBAL_VITEST_SKIP_PROJECTS'] ?? '').split(',')
  return names.filter((name) => skipped.includes(name) || !selects(projects, name)).sort()
}

/** Whether `--project` filters select a project: none selects every one, else any one matching it does (Vitest ORs them). */
export function selects(filters: string[], name: string): boolean {
  return (
    filters.length === 0 ||
    filters.some((filter) => {
      const negated = filter.startsWith('!')
      const glob = `${(negated ? filter.slice(1) : filter)
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`
      return new RegExp(`^${negated ? `(?!${glob})` : glob}`, 'i').test(name)
    })
  )
}

const exec = promisify(execFile)

/** The projects that collect at least one file, from `vitest list --filesOnly` with these arguments and variables. */
export async function listedProjects(
  args: string[],
  extra: Record<string, string> = {},
): Promise<string[]> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VITEST') && !key.startsWith('NYMBAL_')) env[key] = value
  }
  Object.assign(env, extra)
  const { stdout } = await exec(
    join(REPO, 'node_modules/.bin/vitest'),
    ['list', '--filesOnly', '--json', ...args],
    { cwd: REPO, env, maxBuffer: 64 * 1024 * 1024 },
  )
  const rows = JSON.parse(stdout.slice(stdout.indexOf('['))) as Array<{ projectName?: string }>
  return [...new Set(rows.map((row) => row.projectName ?? ''))].sort()
}
