// Reads: apps/docs/src/content/docs/reference/cli.md
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CLI_REFERENCE,
  commandTree,
  renderCliReference,
  type CliCommand,
} from '../../apps/docs/scripts/cli-reference'
import { main } from '../../packages/cli/src/main'

// AC-5: the CLI reference page is generated from the command tree `nymbal` runs, and the committed page is what the
// generator writes today: a section per command and nested subcommand, each argument with its description and
// default. A command or flag added to the tree without regenerating the page fails here.

const committed = readFileSync(CLI_REFERENCE, 'utf8')
const root = main as CliCommand

/** The page's sections: each `## \`nymbal …\`` heading with the text up to the next one. */
function sections(page: string): Map<string, string> {
  const parts = page.split(/^## `nymbal ([^`]+)`$/m)
  const out = new Map<string, string>()
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i]!, parts[i + 1]!)
  return out
}

describe('AC-5: the committed CLI reference is the one the CLI generates', () => {
  it('AC-5: the committed page equals what cli-reference renders from the CLI’s command tree', async () => {
    expect(committed).toBe(await renderCliReference(root))
  })

  it('AC-5: the page has one section per command and nested subcommand, and each names every argument with its description and default', async () => {
    const tree = (await commandTree(root)).filter((entry) => entry.path.length > 0)
    const page = sections(committed)
    const missing = tree.flatMap((entry) => {
      const where = `nymbal ${entry.path.join(' ')}`
      const section = page.get(entry.path.join(' '))
      if (section === undefined) return [`no section for ${where}`]
      const rows = section.split('\n').filter((line) => line.startsWith('| `'))
      return entry.args.flatMap((a) => {
        const row = rows.find((line) => line.startsWith(`| \`${a.display}\` |`))
        // The description's opening words, before any character the table escapes.
        const opening = (a.arg.description ?? '').split(/[<>|]/)[0]!.slice(0, 30)
        const shown = a.arg.default === undefined ? '' : `\`${JSON.stringify(a.arg.default)}\``
        const cells = row?.split(' | ').map((c) => c.replace(/^\| |\s*\|$/g, '').trim())
        if (row === undefined) return [`${where}: no row for ${a.display}`]
        if (!row.includes(opening)) return [`${where}: ${a.display} without its description`]
        if (cells?.at(-1) !== shown)
          return [`${where}: ${a.display} default ${cells?.at(-1)}, not ${shown}`]
        return []
      })
    })

    expect(missing).toEqual([])
    expect([...page.keys()].sort()).toEqual(tree.map((entry) => entry.path.join(' ')).sort())
    expect(tree.some((entry) => entry.path.length > 1)).toBe(true)
  })

  it('AC-5: a flag added to a nested subcommand, or a new command, makes the page differ from the committed one', async () => {
    const tree = await commandTree(root)
    const deploy = (root.subCommands as Record<string, CliCommand>)['deploy']!
    const fly = (deploy.subCommands as Record<string, CliCommand>)['fly']!
    const withFlag: CliCommand = {
      ...root,
      subCommands: {
        ...(root.subCommands as Record<string, CliCommand>),
        deploy: {
          ...deploy,
          subCommands: {
            ...(deploy.subCommands as Record<string, CliCommand>),
            fly: {
              ...fly,
              args: { ...(fly.args as object), region: { type: 'string', description: 'x' } },
            },
          },
        },
      },
    }
    const withCommand: CliCommand = {
      ...root,
      subCommands: {
        ...(root.subCommands as Record<string, CliCommand>),
        upgrade: { meta: { description: 'x' } },
      },
    }

    expect(tree.find((e) => e.path.join(' ') === 'deploy fly')).toBeDefined()
    expect(await renderCliReference(withFlag)).not.toBe(committed)
    expect(await renderCliReference(withCommand)).not.toBe(committed)
  })
})
