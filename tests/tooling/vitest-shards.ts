import { execFile } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { TestSpecification } from 'vitest/node'
import { words } from './vitest-filters'

// The files a tests command's Vitest run takes, resolved as `vitest run` resolves them: its arguments through Vitest's
// own CLI parser and the repo's config, then, when the command shards, each pool group cut by the configured
// sequencer's `shard`, the call the pool makes before it runs anything. `vitest list` cannot stand in: it ignores
// `--shard`. Each command resolves in a child process whose environment is the command's own, so the variables of the
// run that hosts the test (VITEST_*, NYMBAL_*) do not reach the config.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const SELF = fileURLToPath(import.meta.url)

/**
 * A tests command's Vitest call (its first command): the `NAME=value` assignments that prefix it, and its argv from
 * `vitest`, with `pnpm run test` read as the package.json script it runs and `pnpm exec` dropped.
 */
export function vitestCall(command: string): { env: Record<string, string>; argv: string[] } {
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
  if (argv.slice(0, 2).join(' ') === 'pnpm exec') argv = argv.slice(2)
  return { env, argv }
}

const exec = promisify(execFile)

/** `project:file` for every file each command's Vitest run takes, one list per command, in command order. */
export async function resolvedFiles(commands: string[]): Promise<string[][]> {
  return Promise.all(
    commands.map(async (command) => {
      const { env: own, argv } = vitestCall(command)
      if (argv[0] !== 'vitest') throw new Error(`not a Vitest call: ${command}`)
      const env: NodeJS.ProcessEnv = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (!key.startsWith('VITEST') && !key.startsWith('NYMBAL_')) env[key] = value
      }
      Object.assign(env, own)
      const { stdout } = await exec(TSX, [SELF, JSON.stringify(argv)], {
        cwd: REPO,
        env,
        maxBuffer: 64 * 1024 * 1024,
      })
      return JSON.parse(stdout.slice(stdout.indexOf('['))) as string[]
    }),
  )
}

/** The child: argv in, the `project:file` keys the run takes out, as JSON on stdout. */
async function resolve(argv: string[]): Promise<string[]> {
  const { createVitest, parseCLI } = await import('vitest/node')
  const { filter, options } = parseCLI(argv)
  // Nothing runs, so nothing reports.
  const {
    reporter: _reporter,
    reporters: _reporters,
    outputFile: _outputFile,
    exclude,
    ...rest
  } = options as typeof options & { reporter?: unknown }
  // As the CLI does: a command-line `--exclude` adds to the config's exclude instead of replacing it.
  const cliExclude = exclude === undefined ? undefined : [exclude].flat()
  const vitest = await createVitest(
    'test',
    { ...rest, ...(cliExclude === undefined ? {} : { cliExclude }), watch: false, reporters: [] },
    {},
    { stdout: process.stderr, stderr: process.stderr },
  )
  try {
    const specs = await vitest.globTestSpecifications(filter)
    // The pool shards each sequence group's files per pool, apart from the others.
    const groups = new Map<string, TestSpecification[]>()
    for (const spec of specs) {
      const key = `${spec.project.config.sequence.groupOrder ?? 0}:${spec.pool}`
      groups.set(key, [...(groups.get(key) ?? []), spec])
    }
    const taken: TestSpecification[] = []
    for (const group of groups.values()) {
      if (vitest.config.shard === undefined) taken.push(...group)
      else {
        const Sequencer = vitest.config.sequence.sequencer
        taken.push(...(await new Sequencer(vitest).shard(group)))
      }
    }
    return taken.map(
      (spec) => `${spec.project.name}:${relative(vitest.config.root, spec.moduleId)}`,
    )
  } finally {
    await vitest.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(SELF)) {
  resolve(JSON.parse(process.argv[2] ?? '[]') as string[]).then(
    (keys) => {
      process.stdout.write(`${JSON.stringify(keys)}\n`)
      process.exit(0)
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      )
      process.exit(1)
    },
  )
}
