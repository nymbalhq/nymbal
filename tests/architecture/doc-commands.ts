// What public text names, read the way a reader would run or follow it: the code in a Markdown text, the `nymbal`
// invocations in a code line (checked against the command tree the CLI runs), the `pnpm` and `npm run` calls, and the
// link targets. Shared by the adapter guide's test and the public docs' test.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { commandTree, type CliCommand, type CliEntry } from '../../apps/docs/scripts/cli-reference'
import { main } from '../../packages/cli/src/main'
import { ROOT } from './adapter-table'
import { workspaceMembers } from './workspace-manifests'

/** The code a markdown text holds: each inline code span and each line of each fenced block. */
export function codeOf(text: string): string[] {
  const fenced = [...text.matchAll(/^\s*```[^\n]*\n([\s\S]*?)^\s*```/gm)].flatMap((m) =>
    m[1]!.split('\n'),
  )
  const prose = text.replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```/gm, '')
  const spans = [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)
  return [...fenced, ...spans].map((l) => l.trim()).filter(Boolean)
}

/** Markdown link targets, anchors kept; web and mail links included. */
export const linkTargets = (text: string): string[] =>
  [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]!)

/** A placeholder, glob or shell variable stands for a value that need not exist. */
export const isPattern = (token: string): boolean => /[<>*{}$…]|\.\.\./.test(token)

let tree: Promise<CliEntry[]> | undefined
/** Every command of the CLI, from the tree `nymbal` runs. */
export const cliTree = (): Promise<CliEntry[]> => (tree ??= commandTree(main as CliCommand))

const SHELL_STOP = new Set(['&&', '||', ';', '|', '>', '>>', '2>&1', ')'])
/** Tokens a `nymbal` invocation may follow on a line: a runner, an environment assignment, a shell joiner. */
const LEADS = /^(?:\$|npx|-y|--yes|exec|dlx|&&|\|\||;|\(|[A-Z_][A-Z0-9_]*=\S*)$/

/** The argument lists of every `nymbal` invocation in a code line: `nymbal …`, `npx nymbal …`, `node …/nymbal.mjs …`. */
export function nymbalInvocations(line: string): string[][] {
  const tokens = line.split(/\s+/).filter(Boolean)
  const found: string[][] = []
  tokens.forEach((token, i) => {
    const before = tokens[i - 1]
    const cli =
      (token === 'nymbal' && (before === undefined || LEADS.test(before))) ||
      (/(?:^|\/)nymbal\.mjs$/.test(token) && before === 'node')
    if (!cli) return
    const args: string[] = []
    for (const next of tokens.slice(i + 1)) {
      if (SHELL_STOP.has(next)) break
      args.push(next)
    }
    found.push(args)
  })
  return found
}

/** What is wrong with `nymbal <args>` against the CLI's tree, if anything: an unknown command or flag. */
export function nymbalProblem(args: string[], cli: CliEntry[]): string | undefined {
  const byPath = new Map(cli.map((entry) => [entry.path.join(' '), entry]))
  let current = byPath.get('')!
  let takesValue = false
  for (const token of args) {
    if (takesValue) {
      takesValue = false
      continue
    }
    if (token === '--') return undefined
    if (isPattern(token)) return undefined
    const where = `nymbal ${current.path.join(' ')}`.trim()
    if (token.startsWith('-')) {
      const [name, value] = token.replace(/^-+/, '').split('=') as [string, string | undefined]
      if (name === 'help' || name === 'h') continue
      if (current.path.length === 0 && (name === 'version' || name === 'v')) continue
      const arg = current.args.find((a) => !a.positional && a.spellings.includes(name))
      if (arg === undefined) return `${where} has no flag ${token}`
      takesValue = value === undefined && arg.arg.type !== 'boolean'
      continue
    }
    const sub = byPath.get([...current.path, token].join(' '))
    if (sub !== undefined) {
      current = sub
      continue
    }
    if (current.subcommands.length > 0 && !current.args.some((a) => a.positional)) {
      return `${where} has no subcommand ${token}`
    }
    if (current.path.length === 0) return `nymbal has no command ${token}`
  }
  return undefined
}

const binsIn = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : [])
const ROOT_BINS = new Set(binsIn(join(ROOT, 'node_modules', '.bin')))
const PNPM_COMMANDS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'update',
  'exec',
  'dlx',
  'run',
  'test',
  'list',
  'why',
  'publish',
  'pack',
])

/**
 * What is wrong with a `pnpm …` or `npm run …` line, if anything. A script must be one of `scripts` (the manifest the
 * text sits beside), or of the workspace package `--filter` names; otherwise a pnpm command or a root bin.
 */
export function packageManagerProblem(
  line: string,
  scripts: ReadonlySet<string>,
): string | undefined {
  const tokens = line.replace(/^\$\s+/, '').split(/\s+/)
  const [tool, ...rest] = tokens
  if (tool === 'npm') {
    const [verb, script] = rest
    if (verb !== 'run' || script === undefined || isPattern(script)) return undefined
    return scripts.has(script) ? undefined : `no script ${script}`
  }
  if (tool !== 'pnpm') return undefined
  let filter: string | undefined
  const args: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!
    if (t === '--filter' || t === '-F' || t === '-C' || t === '--dir') filter = rest[++i]
    else if (t.startsWith('--filter=')) filter = t.slice('--filter='.length)
    else if (args.length === 0 && t.startsWith('-')) continue
    else args.push(t)
  }
  const [command, next] = args
  if (command === undefined || isPattern(command)) return undefined
  const filtered =
    filter === undefined || isPattern(filter)
      ? undefined
      : workspaceMembers(ROOT).find(
          (m) => m.manifest.name === filter || m.dir === filter.replace(/^\.\//, ''),
        )
  if (filter !== undefined && !isPattern(filter) && filtered === undefined) {
    return `no workspace package ${filter}`
  }
  const own =
    filtered === undefined
      ? scripts
      : new Set(
          Object.keys((filtered.manifest.scripts as Record<string, string> | undefined) ?? {}),
        )
  if (command === 'run') {
    return next === undefined || isPattern(next) || own.has(next) ? undefined : `no script ${next}`
  }
  if (command === 'exec') {
    const bins =
      filtered === undefined
        ? ROOT_BINS
        : new Set([...ROOT_BINS, ...binsIn(join(ROOT, filtered.dir, 'node_modules', '.bin'))])
    return next === undefined || isPattern(next) || bins.has(next) ? undefined : `no bin ${next}`
  }
  return own.has(command) || PNPM_COMMANDS.has(command) || ROOT_BINS.has(command)
    ? undefined
    : `pnpm has no script, command or bin ${command}`
}
