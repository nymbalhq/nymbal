import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

// Which client-side files read a store namespace from the client, and whether each imports the namespace's
// `@nymbalhq/sdk/ns/<module>` (itself, or through a module of its own package it imports); and which import a value
// from the `@nymbalhq/sdk` index, which brings every store with it.

export const NS_MODULE = {
  cart: 'cart',
  product: 'product',
  productList: 'product-list',
  search: 'search',
  checkout: 'checkout',
  auth: 'auth',
} as const

export type Namespace = keyof typeof NS_MODULE

const isNamespace = (name: string): name is Namespace => Object.hasOwn(NS_MODULE, name)

export interface Finding {
  /** The file (an `.astro` file for one of its scripts), relative to `base`. */
  unit: string
  /** The namespace read with no import of its module; undefined for a value import from the index. */
  namespace?: Namespace
  problem: string
}

interface Unit {
  /** The file the code is in. */
  file: string
  code: string
}

interface Analysis {
  reads: Set<Namespace>
  /** Specifiers imported as values or for their side effects (an `import type` is neither). */
  valueImports: string[]
}

const SOURCE = /\.(ts|mts|js|mjs)$/
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '__fixtures__'])

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : walk(path)
    return [path]
  })
}

const isTest = (file: string): boolean => /\.(test|spec)\.[mc]?[jt]s$/.test(file)

/** The client expressions a namespace is read from: `client`, `this.client`, `getClient()`. */
function isClient(node: ts.Expression): boolean {
  let e = node
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) {
    e = e.expression
  }
  if (ts.isIdentifier(e)) return e.text === 'client'
  if (ts.isPropertyAccessExpression(e)) {
    return e.expression.kind === ts.SyntaxKind.ThisKeyword && e.name.text === 'client'
  }
  if (ts.isCallExpression(e)) {
    return ts.isIdentifier(e.expression) && e.expression.text === 'getClient'
  }
  return false
}

/** Under verbatimModuleSyntax an import whose every name is `type` still loads its module: only `import type` does not. */
function loadsModule(decl: ts.ImportDeclaration): boolean {
  const clause = decl.importClause
  return clause === undefined || !clause.isTypeOnly
}

function analyse(code: string, file: string): Analysis {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const reads = new Set<Namespace>()
  const valueImports: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (loadsModule(node)) valueImports.push(node.moduleSpecifier.text)
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      valueImports.push(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      valueImports.push(node.arguments[0].text)
    } else if (ts.isPropertyAccessExpression(node) && isNamespace(node.name.text)) {
      if (isClient(node.expression)) reads.add(node.name.text)
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      isNamespace(node.argumentExpression.text) &&
      isClient(node.expression)
    ) {
      reads.add(node.argumentExpression.text)
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      isClient(node.initializer)
    ) {
      for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name
        if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && isNamespace(key.text)) {
          reads.add(key.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { reads, valueImports }
}

/** The bundled `<script>` blocks of an `.astro` file (its frontmatter runs on the server; `is:inline` is not bundled). */
function scriptsOf(astro: string): string[] {
  const body = astro.replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
  return [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, attributes]) => {
      const attrs = attributes ?? ''
      if (/\bis:inline\b/.test(attrs)) return false
      const type = /\btype\s*=\s*["']([^"']+)["']/.exec(attrs)?.[1]
      return type === undefined || type === 'module' || type === 'text/javascript'
    })
    .map(([, , code]) => code ?? '')
}

/** A relative specifier's file in the package, as a bundler resolves a TypeScript source's `.js` import. */
function resolveRelative(from: string, specifier: string, root: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = resolve(dirname(from), specifier)
  const stem = base.replace(/\.(js|mjs|ts|mts)$/, '')
  const candidates = [
    base,
    `${stem}.ts`,
    `${stem}.mts`,
    `${stem}.js`,
    `${stem}.mjs`,
    join(base, 'index.ts'),
    join(base, 'index.js'),
  ]
  return candidates.find(
    (c) => c.startsWith(`${root}/`) && SOURCE.test(c) && existsSync(c) && statSync(c).isFile(),
  )
}

const NS_SPECIFIER = /^@nymbalhq\/sdk\/ns\/([a-z-]+)$/
const INDEX = '@nymbalhq/sdk'

/**
 * Scans one package. `root` is the package directory; `entries` are its client-side units: every module under
 * `src` for a package of elements, the `<script>` blocks of its `.astro` files for a template. Each relative module an
 * entry reaches is client-side too.
 */
function scan(root: string, entries: Unit[], base: string): Finding[] {
  const analyses = new Map<string, Analysis>()
  const moduleAnalysis = (file: string): Analysis => {
    let found = analyses.get(file)
    if (found === undefined) {
      found = analyse(readFileSync(file, 'utf8'), file)
      analyses.set(file, found)
    }
    return found
  }

  /** The namespace modules a unit imports, itself or through the package's modules it reaches. */
  const registered = (unit: Unit, own: Analysis): Set<string> => {
    const modules = new Set<string>()
    const seen = new Set<string>()
    const queue: Array<[string, Analysis]> = [[unit.file, own]]
    while (queue.length > 0) {
      const [from, analysis] = queue.shift()!
      for (const specifier of analysis.valueImports) {
        const ns = NS_SPECIFIER.exec(specifier)?.[1]
        if (ns !== undefined) modules.add(ns)
        const next = resolveRelative(from, specifier, root)
        if (next !== undefined && !seen.has(next)) {
          seen.add(next)
          queue.push([next, moduleAnalysis(next)])
        }
      }
    }
    return modules
  }

  const findings: Finding[] = []
  const reported = new Set<string>()
  const report = (finding: Finding): void => {
    const key = `${finding.unit}|${finding.problem}`
    if (reported.has(key)) return
    reported.add(key)
    findings.push(finding)
  }
  const check = (unit: Unit, analysis: Analysis): void => {
    const name = relative(base, unit.file)
    const imported = registered(unit, analysis)
    for (const ns of analysis.reads) {
      if (!imported.has(NS_MODULE[ns])) {
        report({
          unit: name,
          namespace: ns,
          problem: `reads client.${ns} without importing @nymbalhq/sdk/ns/${NS_MODULE[ns]}`,
        })
      }
    }
    if (analysis.valueImports.includes(INDEX)) {
      report({ unit: name, problem: `imports a value from ${INDEX} (import type, or @nymbalhq/sdk/core)` })
    }
  }

  // Every client-side module: the entries, and each module of the package an entry reaches.
  const pending: Unit[] = [...entries]
  const checked = new Set<string>()
  while (pending.length > 0) {
    const unit = pending.shift()!
    const isModule = !unit.file.endsWith('.astro')
    if (isModule && checked.has(unit.file)) continue
    if (isModule) checked.add(unit.file)
    const analysis = isModule ? moduleAnalysis(unit.file) : analyse(unit.code, unit.file)
    check(unit, analysis)
    for (const specifier of analysis.valueImports) {
      const next = resolveRelative(unit.file, specifier, root)
      if (next !== undefined && !checked.has(next)) {
        pending.push({ file: next, code: '' })
      }
    }
  }
  return findings.sort((a, b) => a.unit.localeCompare(b.unit) || a.problem.localeCompare(b.problem))
}

/** A package of elements: every module under `src` but its tests runs in the browser. */
export function scanElementsPackage(root: string, base: string): Finding[] {
  const entries = walk(join(root, 'src'))
    .filter((file) => SOURCE.test(file) && !file.endsWith('.d.ts') && !isTest(file))
    .map((file) => ({ file, code: '' }))
  return scan(root, entries, base)
}

/**
 * An Astro template: the bundled scripts of its `.astro` files, every module under `src/scripts` (the page scripts a
 * store's own pages import, whether or not a page of the template does), and the modules they reach.
 */
export function scanAstroTemplate(root: string, base: string): Finding[] {
  const files = walk(join(root, 'src'))
  const scripts = files
    .filter((file) => extname(file) === '.astro')
    .flatMap((file) => scriptsOf(readFileSync(file, 'utf8')).map((code) => ({ file, code })))
  const pageScripts = walk(join(root, 'src/scripts'))
    .filter((file) => SOURCE.test(file) && !file.endsWith('.d.ts') && !isTest(file))
    .map((file) => ({ file, code: '' }))
  return scan(root, [...scripts, ...pageScripts], base)
}
