import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Node module hooks for a child process, given as the NODE_OPTIONS that register them. `hide` resolves a bare
// specifier (an SDK an adapter imports) as if from an empty directory, so Node raises its own not-installed error, and
// `record` appends every bare or `file:` specifier resolved, with its importer and the URL it resolved to, to a JSONL
// file. An adapter package is not hooked: the kernel resolves it from the project itself and imports the `file:` URL it
// finds, which `record` sees; a test installs one in its project (tests/support/project.ts).

export interface ModuleHooks {
  hide?: readonly string[]
  record?: string
}

export interface Resolved {
  specifier: string
  parent: string | null
  /** The URL it resolved to, or null when it failed to resolve. */
  url: string | null
}

/** NODE_OPTIONS registering the hooks, written into a fresh directory under `dir`. */
export function moduleHooks(dir: string, hooks: ModuleHooks): string {
  const at = mkdtempSync(join(dir, 'hooks-'))
  const file = join(at, 'hooks.mjs')
  writeFileSync(
    file,
    [
      "import { appendFileSync } from 'node:fs'",
      `const hide = ${JSON.stringify(hooks.hide ?? [])}`,
      `const record = ${JSON.stringify(hooks.record ?? null)}`,
      `const nowhere = ${JSON.stringify(pathToFileURL(join(at, 'nowhere.mjs')).href)}`,
      'const recorded = (s) => s.startsWith("file:") || !/^(node:|data:|\\.|\\/)/.test(s)',
      'const note = (specifier, context, url) => {',
      '  if (record === null || !recorded(specifier)) return',
      '  appendFileSync(record, JSON.stringify({ specifier, parent: context.parentURL ?? null, url }) + "\\n")',
      '}',
      'export async function resolve(specifier, context, nextResolve) {',
      '  const next = hide.includes(specifier) ? { ...context, parentURL: nowhere } : context',
      '  try {',
      '    const result = await nextResolve(specifier, next)',
      '    note(specifier, context, result.url)',
      '    return result',
      '  } catch (error) {',
      '    note(specifier, context, null)',
      '    throw error',
      '  }',
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
