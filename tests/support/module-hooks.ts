import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Node module hooks for a child process, given as the NODE_OPTIONS that register them. They stand in for what is
// installed where the kernel looks, without touching any node_modules: `alias` answers a bare specifier from a file
// (a third party's adapter, installed), `hide` resolves one as if from an empty directory so Node raises its own
// not-installed error, and `record` appends every bare specifier resolved, with its importer, to a JSONL file.

export interface ModuleHooks {
  alias?: Record<string, string>
  hide?: readonly string[]
  record?: string
}

export interface Resolved {
  specifier: string
  parent: string | null
}

/** NODE_OPTIONS registering the hooks, written into a fresh directory under `dir`. */
export function moduleHooks(dir: string, hooks: ModuleHooks): string {
  const at = mkdtempSync(join(dir, 'hooks-'))
  const alias = Object.fromEntries(
    Object.entries(hooks.alias ?? {}).map(([name, file]) => [name, pathToFileURL(file).href]),
  )
  const file = join(at, 'hooks.mjs')
  writeFileSync(
    file,
    [
      "import { appendFileSync } from 'node:fs'",
      `const alias = ${JSON.stringify(alias)}`,
      `const hide = ${JSON.stringify(hooks.hide ?? [])}`,
      `const record = ${JSON.stringify(hooks.record ?? null)}`,
      `const nowhere = ${JSON.stringify(pathToFileURL(join(at, 'nowhere.mjs')).href)}`,
      'const bare = (s) => !/^(node:|file:|data:|\\.|\\/)/.test(s)',
      'export async function resolve(specifier, context, nextResolve) {',
      '  if (record !== null && bare(specifier)) {',
      '    appendFileSync(record, JSON.stringify({ specifier, parent: context.parentURL ?? null }) + "\\n")',
      '  }',
      '  if (Object.hasOwn(alias, specifier)) return { url: alias[specifier], shortCircuit: true }',
      '  if (hide.includes(specifier)) return nextResolve(specifier, { ...context, parentURL: nowhere })',
      '  return nextResolve(specifier, context)',
      '}',
      '',
    ].join('\n'),
  )
  const entry = join(at, 'register.mjs')
  writeFileSync(
    entry,
    `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(file).href)})\n`,
  )
  return `--import=${pathToFileURL(entry).href}`
}

/** What a `record` file holds. */
export function readResolved(record: string): Resolved[] {
  return readFileSync(record, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Resolved)
}

/** An install verb of any package manager. */
export const INSTALL_VERB = /\b(npm install|npm i|pnpm add|yarn add|bun add)\b/
