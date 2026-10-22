import { parseModule } from 'magicast'
import type { Recipe, RecipeValue } from '@nymbalhq/types'

/** What the scaffold writes into the slots a recipe sets: replacing one of these is no conflict. */
export const SCAFFOLD_DEFAULTS: readonly string[] = [
  'sqlite',
  'in-memory',
  'in-process',
  'local-fs',
  'native',
  'middleware',
]

const CONFIG_MODULE = '@nymbalhq/config'

export type Conflict = { path: string; current: unknown; wanted: unknown }
export type AppliedRecipe = { source: string; changed: string[] } | { conflict: Conflict }

/** The parts of a Babel node this module reads. */
interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

const child = (node: Node, key: string): Node => node[key] as Node
const children = (node: Node, key: string): Node[] => node[key] as Node[]

/** Parses LF text only: recast's offsets count a line break as one character, so CRLF text goes through `lfCopy`. */
function parse(lf: string): Node {
  // Recast expands tabs to `tabWidth` columns before Babel parses: at 1 every offset still points into `lf`.
  return parseModule(lf, { tabWidth: 1 }).$ast as unknown as Node
}

const lfCopy = (source: string): string => source.replace(/\r\n/g, '\n')

function unwrap(node: Node | undefined): Node | undefined {
  let at = node
  while (
    at !== undefined &&
    (at.type === 'TSAsExpression' ||
      at.type === 'TSSatisfiesExpression' ||
      at.type === 'TSNonNullExpression' ||
      at.type === 'ParenthesizedExpression')
  ) {
    at = child(at, 'expression')
  }
  return at
}

function nameOf(node: Node): string | undefined {
  if (node.type === 'Identifier') return node['name'] as string
  if (node.type === 'StringLiteral') return node['value'] as string
  if (node.type === 'NumericLiteral') return String(node['value'])
  return undefined
}

interface ConfigModule {
  program: Node
  /** The object literal `defineConfig` is called with, or the default export itself. */
  config: Node
  /** The local name `env` is imported under from @nymbalhq/config, if it is. */
  envName: string | undefined
  /** Whether a top-level import or declaration binds the name `env`. */
  envBound: boolean
  /** The first value import from @nymbalhq/config that names its imports. */
  namedImport: Node | undefined
}

function configImports(program: Node): Node[] {
  return children(program, 'body').filter(
    (n) =>
      n.type === 'ImportDeclaration' &&
      child(n, 'source')['value'] === CONFIG_MODULE &&
      n['importKind'] !== 'type',
  )
}

function importedAs(program: Node, imported: string): string | undefined {
  for (const decl of configImports(program)) {
    for (const spec of children(decl, 'specifiers')) {
      if (spec.type !== 'ImportSpecifier' || spec['importKind'] === 'type') continue
      if (nameOf(child(spec, 'imported')) === imported)
        return child(spec, 'local')['name'] as string
    }
  }
  return undefined
}

function bindsEnv(program: Node): boolean {
  const bound = (id: Node | undefined): boolean => id?.type === 'Identifier' && id['name'] === 'env'
  return children(program, 'body').some((n) => {
    const decl = n.type === 'ExportNamedDeclaration' ? child(n, 'declaration') : n
    if (decl === null || decl === undefined) return false
    if (decl.type === 'ImportDeclaration')
      return children(decl, 'specifiers').some((s) => bound(child(s, 'local')))
    if (decl.type === 'VariableDeclaration')
      return children(decl, 'declarations').some((d) => bound(child(d, 'id')))
    return bound(child(decl, 'id'))
  })
}

/** The config literal of `source`, the LF copy of a nymbal.config.ts. */
function locate(source: string): ConfigModule | undefined {
  const program = parse(source)
  const exported = children(program, 'body').find((n) => n.type === 'ExportDefaultDeclaration')
  if (exported === undefined) return undefined
  let config = unwrap(child(exported, 'declaration'))
  if (config?.type === 'CallExpression') {
    const callee = child(config, 'callee')
    const define = importedAs(program, 'defineConfig') ?? 'defineConfig'
    if (callee.type !== 'Identifier' || callee['name'] !== define) return undefined
    config = unwrap(children(config, 'arguments')[0])
  }
  if (config?.type !== 'ObjectExpression') return undefined
  // A guard on the offsets: they must frame the literal in `source` itself.
  if (source[config.start] !== '{' || source[config.end - 1] !== '}') return undefined
  return {
    program,
    config,
    envName: importedAs(program, 'env'),
    envBound: bindsEnv(program),
    namedImport: configImports(program).find((d) =>
      children(d, 'specifiers').some((s) => s.type === 'ImportSpecifier'),
    ),
  }
}

function isEnvRef(value: unknown): value is { env: string; default?: string } {
  if (typeof value !== 'object' || value === null) return false
  const keys = Object.keys(value)
  return (
    typeof (value as { env?: unknown }).env === 'string' &&
    keys.every((k) => k === 'env' || k === 'default')
  )
}

/** The value a literal node holds, `env('X')` as `{ env: 'X' }`; undefined for anything that is not a literal. */
function evaluate(node: Node, envName: string | undefined): unknown {
  const at = unwrap(node)!
  switch (at.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return at['value']
    case 'TemplateLiteral': {
      const quasis = children(at, 'quasis')
      return children(at, 'expressions').length === 0
        ? (quasis[0]?.['value'] as { cooked: string }).cooked
        : undefined
    }
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {}
      for (const prop of children(at, 'properties')) {
        const key =
          prop.type === 'ObjectProperty' && !prop['computed']
            ? nameOf(child(prop, 'key'))
            : undefined
        const value = key === undefined ? undefined : evaluate(child(prop, 'value'), envName)
        if (key === undefined || value === undefined) return undefined
        out[key] = value
      }
      return out
    }
    case 'CallExpression': {
      const callee = child(at, 'callee')
      const args = children(at, 'arguments')
      if (callee.type !== 'Identifier' || callee['name'] !== (envName ?? 'env')) return undefined
      if (args.length < 1 || args.length > 2 || args.some((a) => a.type !== 'StringLiteral'))
        return undefined
      return {
        env: args[0]!['value'],
        ...(args[1] !== undefined && { default: args[1]['value'] }),
      }
    }
    default:
      return undefined
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return a === b
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return (
    ka.length === kb.length &&
    ka.every(
      (k, i) =>
        k === kb[i] &&
        sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  )
}

function isScaffoldDefault(value: unknown): boolean {
  if (typeof value === 'string') return SCAFFOLD_DEFAULTS.includes(value)
  const provider = (value as { provider?: unknown } | null)?.provider
  return typeof provider === 'string' && SCAFFOLD_DEFAULTS.includes(provider)
}

interface Style {
  quote: string
  unit: string
  envName: string
}

function styleOf(source: string, mod: ConfigModule): Style {
  const firstString = /(['"])(?:(?!\1)[^\\\r\n]|\\.)*\1/.exec(source.slice(mod.config.start))
  const indented = /\n([ \t]+)\S/.exec(source.slice(mod.config.start))
  return {
    quote: firstString?.[1] ?? "'",
    unit: indented?.[1] ?? '  ',
    envName: mod.envName ?? 'env',
  }
}

function quoted(text: string, style: Style): string {
  const q = style.quote
  const body = text
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(q, 'g'), `\\${q}`)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  return `${q}${body}${q}`
}

function renderKey(key: string, style: Style): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quoted(key, style)
}

/** `value` as source text, an object over several lines starting at `indent`. */
function render(value: RecipeValue, indent: string, style: Style): string {
  if (typeof value === 'string') return quoted(value, style)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (isEnvRef(value)) {
    const fallback = value.default === undefined ? '' : `, ${quoted(value.default, style)}`
    return `${style.envName}(${quoted(value.env, style)}${fallback})`
  }
  const entries = Object.entries(value)
  if (entries.length === 0) return '{}'
  const inner = indent + style.unit
  const lines = entries.map(
    ([k, v]) => `${inner}${renderKey(k, style)}: ${render(v, inner, style)},`,
  )
  return `{\n${lines.join('\n')}\n${indent}}`
}

function writesEnv(value: RecipeValue): boolean {
  if (isEnvRef(value)) return true
  return typeof value === 'object' && Object.values(value).some(writesEnv)
}

/** The whitespace that starts the line `offset` is on. */
function indentAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*/.exec(source.slice(lineStart))![0]
}

/** An edit at offsets of the LF copy, its text LF too. */
type Splice = { at: number; remove: number; text: string }

/**
 * `source` with `edits` made. Their offsets are mapped from the LF copy back to `source`, and a line an edit adds ends
 * as the line it lands in does, so a CRLF or mixed file keeps its own endings and every byte outside the edits.
 */
function spliced(source: string, edits: Splice[]): string {
  // The LF copy's offset of every `\n` that a `\r` stands before in `source`.
  const crlf: number[] = []
  for (const m of source.matchAll(/\r\n/g)) crlf.push(m.index - crlf.length)
  const at = (lf: number): number => lf + crlf.filter((p) => p < lf).length
  const lastBreak = /\r?\n(?![\s\S]*\n)/.exec(source)?.[0] ?? '\n'
  return edits
    .map((e) => {
      const start = at(e.at)
      const end = at(e.at + e.remove)
      const eol = /\r?\n/.exec(source.slice(end))?.[0] ?? lastBreak
      return { start, end, text: e.text.replace(/\n/g, eol) }
    })
    .sort((a, b) => b.start - a.start)
    .reduce((s, e) => s.slice(0, e.start) + e.text + s.slice(e.end), source)
}

/** The edits that add `key: value` as the last property of `object`, in the layout the object already has. */
function addProperty(
  source: string,
  object: Node,
  key: string,
  value: RecipeValue,
  style: Style,
): Splice[] {
  const props = children(object, 'properties')
  const close = object.end - 1
  const last = props.at(-1)
  if (last === undefined) {
    const indent = indentAt(source, object.start)
    const inside = source.slice(object.start + 1, close)
    const text = `${indent}${style.unit}${renderKey(key, style)}: ${render(value, indent + style.unit, style)},`
    // An empty `{}` (or one holding only whitespace) is rewritten; anything else in it, a comment, stays above.
    return inside.trim() === ''
      ? [
          {
            at: object.start + 1,
            remove: inside.length,
            text: `\n${text}\n${indent}`,
          },
        ]
      : [{ at: close, remove: 0, text: `\n${text}\n${indent}` }]
  }
  const after = /^[ \t]*,/.exec(source.slice(last.end, close))
  const comma = after === null ? undefined : last.end + after[0].length
  const lineEnd = source.slice(last.end, close).indexOf('\n')
  const property = (indent: string): string =>
    `${renderKey(key, style)}: ${render(value, indent, style)}`
  if (lineEnd === -1) {
    // `{ a: 1 }` on one line: the property joins it there.
    return comma === undefined
      ? [{ at: last.end, remove: 0, text: `, ${property(indentAt(source, last.start))}` }]
      : [{ at: comma, remove: 0, text: ` ${property(indentAt(source, last.start))},` }]
  }
  const indent = indentAt(source, last.start)
  const edits: Splice[] = [
    {
      at: last.end + lineEnd,
      remove: 0,
      text: `\n${indent}${property(indent)}${comma === undefined ? '' : ','}`,
    },
  ]
  if (comma === undefined) edits.push({ at: last.end, remove: 0, text: ',' })
  return edits
}

function findProperty(object: Node, key: string): Node | undefined {
  return children(object, 'properties').findLast(
    (p) => p.type === 'ObjectProperty' && !p['computed'] && nameOf(child(p, 'key')) === key,
  )
}

function editByHand(recipe: Recipe, why: string): Error {
  const wanted = recipe.set.map(({ path, value }) => `${path} = ${JSON.stringify(value)}`)
  return new Error(
    `nymbal.config.ts ${why}, so the ${recipe.name} recipe cannot edit it: edit by hand and set ${wanted.join('; ')}`,
  )
}

type Step = { source: string; wrote: boolean } | { conflict: Conflict }

/** One `set` entry applied to `source`. */
function setPath(
  source: string,
  recipe: Recipe,
  path: string,
  value: RecipeValue,
  force: boolean,
): Step {
  const lf = lfCopy(source)
  const mod = locate(lf)
  if (mod === undefined)
    throw editByHand(recipe, 'does not export a defineConfig({...}) object literal')
  const style = styleOf(lf, mod)
  const keys = path.split('.')
  let object = mod.config
  for (const [i, key] of keys.entries()) {
    const prop = findProperty(object, key)
    if (prop === undefined) {
      const nested = keys.slice(i + 1).reduceRight<RecipeValue>((v, k) => ({ [k]: v }), value)
      return {
        source: spliced(source, addProperty(lf, object, key, nested, style)),
        wrote: true,
      }
    }
    const held = child(prop, 'value')
    if (i === keys.length - 1) {
      const current = evaluate(held, mod.envName)
      if (current !== undefined && sameValue(current, value)) return { source, wrote: false }
      if (!force && !isScaffoldDefault(current)) {
        return {
          conflict: { path, current: current ?? lf.slice(held.start, held.end), wanted: value },
        }
      }
      const text = render(value, indentAt(lf, prop.start), style)
      return {
        source: spliced(source, [{ at: held.start, remove: held.end - held.start, text }]),
        wrote: true,
      }
    }
    const inner = unwrap(held)
    if (inner?.type !== 'ObjectExpression') {
      throw editByHand(
        recipe,
        `holds ${keys.slice(0, i + 1).join('.')} as something other than an object literal`,
      )
    }
    object = inner
  }
  return { source, wrote: false }
}

/** `source` importing `env` from @nymbalhq/config, by adding it to an import that names its imports, or a new one. */
function importEnv(source: string, recipe: Recipe): string {
  const lf = lfCopy(source)
  const mod = locate(lf)!
  if (mod.envName !== undefined) return source
  if (mod.envBound)
    throw editByHand(recipe, 'binds `env` to something other than the env of @nymbalhq/config')
  const style = styleOf(lf, mod)
  if (mod.namedImport !== undefined) {
    const last = children(mod.namedImport, 'specifiers')
      .filter((s) => s.type === 'ImportSpecifier')
      .at(-1)!
    return spliced(source, [{ at: last.end, remove: 0, text: ', env' }])
  }
  const imports = children(mod.program, 'body').filter((n) => n.type === 'ImportDeclaration')
  const line = `import { env } from ${quoted(CONFIG_MODULE, style)}\n`
  const lastImport = imports.at(-1)
  const lineEnd = lastImport === undefined ? -1 : lf.indexOf('\n', lastImport.end)
  const edit: Splice =
    lastImport === undefined
      ? { at: 0, remove: 0, text: line }
      : lineEnd === -1
        ? { at: lf.length, remove: 0, text: `\n${line}` }
        : { at: lineEnd + 1, remove: 0, text: line }
  return spliced(source, [edit])
}

/**
 * `source` (a `nymbal.config.ts`) with every `set` path of the recipe holding the recipe's value, through the AST of
 * the `defineConfig({...})` literal (or a plain object default export). Everything outside the edited properties is
 * kept byte for byte, and a path already holding the value is left alone, so applying it twice equals applying it
 * once. A path holding another value that is not the scaffold's default is a conflict unless `force`. A config that
 * is not such a literal throws "edit by hand".
 */
export function applyRecipeToConfig(
  source: string,
  recipe: Recipe,
  opts: { force: boolean },
): AppliedRecipe {
  if (locate(lfCopy(source)) === undefined) {
    throw editByHand(recipe, 'does not export a defineConfig({...}) object literal')
  }
  let current = source
  const changed: string[] = []
  let envWritten = false
  for (const { path, value } of recipe.set) {
    const step = setPath(current, recipe, path, value, opts.force)
    if ('conflict' in step) return step
    if (!step.wrote) continue
    current = step.source
    changed.push(path)
    envWritten ||= writesEnv(value)
  }
  if (envWritten) current = importEnv(current, recipe)
  return { source: current, changed }
}

export type EnvCall = { name: string; defaulted: boolean }

/**
 * Every variable an `env('NAME')` call names in the config, `env` imported from @nymbalhq/config, and whether every
 * call naming it has a default. A load needs the others set; a defaulted one runs on its default unless `.env` sets it.
 */
export function envCalls(source: string): EnvCall[] {
  const lf = lfCopy(source)
  const mod = locate(lf)
  const envName = mod === undefined ? importedAs(parse(lf), 'env') : mod.envName
  if (envName === undefined) return []
  const defaulted = new Map<string, boolean>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (typeof node !== 'object' || node === null || typeof (node as Node).type !== 'string') return
    const n = node as Node
    if (n.type === 'CallExpression') {
      const callee = child(n, 'callee')
      const args = children(n, 'arguments')
      const first = args[0]
      if (
        callee.type === 'Identifier' &&
        callee['name'] === envName &&
        first?.type === 'StringLiteral'
      ) {
        const name = first['value'] as string
        defaulted.set(name, (defaulted.get(name) ?? true) && args.length > 1)
      }
    }
    for (const [key, value] of Object.entries(n)) {
      if (key !== 'loc' && key !== 'comments' && key !== 'extra' && key !== 'original') visit(value)
    }
  }
  visit(mod?.program ?? parse(lf))
  return [...defaulted].map(([name, all]) => ({ name, defaulted: all }))
}
