// The CLI reference page, generated from the command tree the CLI itself runs (packages/cli/src/main.ts): a section per
// command and nested subcommand, each argument with its type, description and default. Run it after a command or a
// flag changes, and commit the page: `pnpm --filter @nymbalhq/docs cli-reference`. A test compares the two.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

type Resolvable<T> = T | Promise<T> | (() => T) | (() => Promise<T>)

export interface CliArg {
  type?: string
  description?: string
  default?: unknown
  alias?: string | string[]
  required?: boolean
}

export interface CliCommand {
  meta?: Resolvable<{ name?: string; description?: string } | undefined>
  args?: Resolvable<Record<string, CliArg> | undefined>
  subCommands?: Resolvable<Record<string, Resolvable<CliCommand>> | undefined>
}

export interface CliArgument {
  name: string
  /** How a command line writes it: `--dry-run`, or `<name>` for a positional. */
  display: string
  /** Every spelling citty accepts for it, without dashes: the name, its camel and kebab forms, aliases, `no-` forms. */
  spellings: string[]
  positional: boolean
  arg: CliArg
}

export interface CliEntry {
  /** The words after `nymbal`; empty for the root. */
  path: string[]
  description: string
  args: CliArgument[]
  subcommands: string[]
}

export const CLI_REFERENCE = fileURLToPath(
  new URL('../src/content/docs/reference/cli.md', import.meta.url),
)

async function resolve<T>(value: Resolvable<T>): Promise<T> {
  return typeof value === 'function' ? await (value as () => T | Promise<T>)() : await value
}

const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
const camel = (s: string): string => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())

function argument(name: string, arg: CliArg): CliArgument {
  const positional = arg.type === 'positional'
  const aliases = arg.alias === undefined ? [] : Array.isArray(arg.alias) ? arg.alias : [arg.alias]
  const names = [...new Set([name, camel(name), kebab(name), ...aliases])]
  const spellings = arg.type === 'boolean' ? [...names, ...names.map((n) => `no-${n}`)] : names
  return {
    name,
    display: positional ? `<${name}>` : `--${kebab(name)}`,
    spellings,
    positional,
    arg,
  }
}

/** Every command in the tree, depth first in the order the tree declares them, the root first. */
export async function commandTree(root: CliCommand): Promise<CliEntry[]> {
  const entries: CliEntry[] = []
  const walk = async (command: CliCommand, path: string[]): Promise<void> => {
    const meta = (await resolve(command.meta)) ?? {}
    const args = (await resolve(command.args)) ?? {}
    const subs = (await resolve(command.subCommands)) ?? {}
    entries.push({
      path,
      description: meta.description ?? '',
      args: Object.entries(args).map(([name, arg]) => argument(name, arg)),
      subcommands: Object.keys(subs),
    })
    for (const [name, sub] of Object.entries(subs)) await walk(await resolve(sub), [...path, name])
  }
  await walk(root, [])
  return entries
}

/** Text for a Markdown table cell: angle brackets escaped outside code spans, pipes escaped everywhere. */
function cell(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith('`') ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;')))
    .join('')
    .replace(/\|/g, '\\|')
}

function defaultOf(arg: CliArg): string {
  return arg.default === undefined ? '' : `\`${JSON.stringify(arg.default)}\``
}

export async function renderCliReference(root: CliCommand): Promise<string> {
  const entries = await commandTree(root)
  const lines = [
    '---',
    'title: CLI reference',
    'description: Every nymbal command and subcommand, with its arguments and their defaults.',
    '---',
    '',
    '<!-- Generated from the CLI by `pnpm --filter @nymbalhq/docs cli-reference`. Do not edit by hand. -->',
    '',
    'Run a command in your project with `npx nymbal <command>` (or your package manager’s equivalent). Every command',
    'takes `--help`, and `nymbal --version` prints the installed version.',
  ]
  for (const entry of entries.filter((e) => e.path.length > 0)) {
    lines.push('', `## \`nymbal ${entry.path.join(' ')}\``, '', cell(entry.description))
    if (entry.subcommands.length > 0) {
      lines.push(
        '',
        `Subcommands: ${entry.subcommands.map((s) => `\`nymbal ${[...entry.path, s].join(' ')}\``).join(', ')}.`,
      )
    }
    if (entry.args.length > 0) {
      lines.push('', '| Argument | Type | Description | Default |', '| --- | --- | --- | --- |')
      for (const a of entry.args) {
        const type = a.positional ? 'positional' : (a.arg.type ?? 'string')
        lines.push(
          `| \`${a.display}\` | ${type} | ${cell(a.arg.description ?? '')} | ${defaultOf(a.arg)} |`,
        )
      }
    }
  }
  return `${lines.join('\n')}\n`
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { main } = await import('../../../packages/cli/src/main')
  writeFileSync(CLI_REFERENCE, await renderCliReference(main as CliCommand))
  process.stdout.write(`wrote ${CLI_REFERENCE}\n`)
}
