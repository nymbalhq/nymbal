import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import ts from 'typescript'
import { matchesReadGlob } from '../../scripts/gate'
import { REPO_ROOT, workspaceMembers } from './workspace-manifests'

// What a harness test reaches outside its imports, read from its source: the checkout root it builds paths from, and
// the fs and child-process calls those paths reach, in the file itself or one hop away in a test helper it imports.

/** Names a helper exports for the checkout root or a script in it. */
const ROOT_NAMES = new Set(['REPO', 'REPO_ROOT', 'GATE', 'TSX'])
const FS_CALLS = new Set([
  'readFileSync',
  'readdirSync',
  'existsSync',
  'statSync',
  'lstatSync',
  'cpSync',
  'copyFileSync',
  'globSync',
  'readFile',
])
const isSpawn = (name: string): boolean => /^(?:spawn|exec)/.test(name)
const touchesDisk = (name: string): boolean => FS_CALLS.has(name) || isSpawn(name)
/** The arguments of an fs call that name a path: the source and destination of a copy, the first of the rest. */
const pathArgs = (name: string): number => (name === 'cpSync' || name === 'copyFileSync' ? 2 : 1)

/** The hooks' test path (`.claude/hooks/lib.sh`, `TEST_PATH_RE`), less the Playwright runner's own configs. */
const TEST_PATH =
  /(^|\/)(tests?|__tests__|__fixtures__|fixtures|journeys|sentinels)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.test-d\.ts$/
const RUNNER_CONFIG = /^(.*\/)?tests\/e2e\/playwright[^/]*\.config\.ts$/

/**
 * A product path: under packages/, templates/ or apps/, but not a member's own manifest or tsconfig at its root, not a
 * test path, and not a package's build scripts.
 */
export function isProductPath(path: string, members: ReadonlySet<string>): boolean {
  if (!/^(?:packages|templates|apps)\//.test(path)) return false
  if (TEST_PATH.test(path) && !RUNNER_CONFIG.test(path)) return false
  if (/^packages\/[^/]+\/scripts\//.test(path)) return false
  const name = posix.basename(path)
  if (
    members.has(posix.dirname(path)) &&
    (name === 'package.json' || /^tsconfig[^/]*\.json$/.test(name))
  ) {
    return false
  }
  return true
}

export type Checkout = { root: string; files: string[]; product: string[] }

/** The files the checkout holds or would add, and which of them are product paths. */
export function checkout(root: string = REPO_ROOT): Checkout {
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
    .split('\0')
    .filter((f) => f !== '' && existsSync(join(root, f)))
  const members = new Set(workspaceMembers(root).map((m) => m.dir))
  return { root, files, product: files.filter((f) => isProductPath(f, members)) }
}

type Module = {
  /** Why the module reaches the checkout, at its top level or anywhere in it; empty when it does not. */
  reaches: string[]
  /** Its top level reaches the checkout as it loads. */
  onLoad: boolean
  /** Exported functions that reach the checkout whatever their arguments. */
  reachingExports: Set<string>
  /** Exported functions that read or spawn what they are handed. */
  touchingExports: Set<string>
}

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression

/** The called name: `readFileSync(…)` and `fs.readFileSync(…)` alike, but never a RegExp's `.exec(…)`. */
const callName = (call: ts.CallExpression): string | undefined => {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee) && callee.name.text !== 'exec') return callee.name.text
  return undefined
}

const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

/**
 * A relative URL on `import.meta.url` (`'../..'`, `'..'`, `'./x'`, a template), `process.cwd()`, `__dirname`,
 * `import.meta.dirname` or `import.meta.filename`: the checkout's root, or a path in it.
 */
function isRootExpression(node: ts.Node): boolean {
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'URL'
  ) {
    const [spec, from] = node.arguments ?? []
    const text =
      spec === undefined
        ? undefined
        : ts.isStringLiteralLike(spec)
          ? spec.text
          : ts.isTemplateExpression(spec)
            ? spec.head.text
            : undefined
    // An absolute URL or path leaves the checkout; any other resolves against the file's own place in it.
    return (
      text !== undefined &&
      !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(text) &&
      from !== undefined &&
      from.getText().includes('import.meta.url')
    )
  }
  if (ts.isCallExpression(node) && node.expression.getText() === 'process.cwd') return true
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    (node.name.text === 'dirname' || node.name.text === 'filename')
  ) {
    return true
  }
  return ts.isIdentifier(node) && node.text === '__dirname'
}

/** A path the process resolves against its working directory, which under Vitest is the checkout's root. */
const isRelativeLiteral = (node: ts.Node | undefined): boolean =>
  node !== undefined &&
  ts.isStringLiteralLike(node) &&
  node.text !== '' &&
  !node.text.startsWith('/')

/** An options object that sets `cwd`, or may (a spread). */
const setsCwd = (call: ts.CallExpression): boolean =>
  call.arguments.some(
    (a) =>
      ts.isObjectLiteralExpression(a) &&
      a.properties.some(
        (p) =>
          ts.isSpreadAssignment(p) ||
          (p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === 'cwd'),
      ),
  )

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)))
}

function analyse(
  root: string,
  file: string,
  helpers: ((specifier: string) => Module | undefined) | undefined,
): Module {
  const sf = ts.createSourceFile(
    file,
    readFileSync(join(root, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  /** Local name → the helper module and the name it exports. */
  const imported = new Map<string, { module: Module; name: string }>()
  const rooted = new Set<string>()
  let importReach: string | undefined
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly === true) continue
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
    const bindings = statement.importClause?.namedBindings
    const named = bindings !== undefined && ts.isNamedImports(bindings) ? bindings.elements : []
    for (const element of named) {
      if (element.isTypeOnly) continue
      const name = (element.propertyName ?? element.name).text
      if (ROOT_NAMES.has(name)) rooted.add(element.name.text)
    }
    const module = specifier.startsWith('.') ? helpers?.(specifier) : undefined
    if (module === undefined) continue
    if (module.onLoad)
      importReach ??= `imports ${specifier}, which reaches the checkout as it loads`
    for (const element of named) {
      if (!element.isTypeOnly) {
        imported.set(element.name.text, {
          module,
          name: (element.propertyName ?? element.name).text,
        })
      }
    }
  }

  const derived = new Set(rooted)
  const mentionsRoot = (node: ts.Node): boolean => {
    let found = false
    const visit = (n: ts.Node): void => {
      if (found) return
      if (isRootExpression(n)) found = true
      else if (ts.isIdentifier(n) && derived.has(n.text)) {
        const parent = n.parent
        const isMember = ts.isPropertyAccessExpression(parent) && parent.name === n
        const isKey = ts.isPropertyAssignment(parent) && parent.name === n
        if (!isMember && !isKey) found = true
      }
      if (!found) ts.forEachChild(n, visit)
    }
    visit(node)
    return found
  }
  // Values built from the root: variables and parameter defaults, to a fixed point.
  for (let grew = true; grew; ) {
    grew = false
    const visit = (n: ts.Node): void => {
      if ((ts.isVariableDeclaration(n) || ts.isParameter(n)) && n.initializer !== undefined) {
        if (mentionsRoot(n.initializer)) {
          for (const name of bindingNames(n.name)) {
            if (!derived.has(name)) {
              derived.add(name)
              grew = true
            }
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }

  // Functions declared here, by name, and those that read or spawn what they are handed.
  const functions = new Map<string, FunctionLike>()
  const collect = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name !== undefined) functions.set(n.name.text, n)
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer !== undefined &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      functions.set(n.name.text, n.initializer)
    }
    ts.forEachChild(n, collect)
  }
  collect(sf)
  const calls = (node: ts.Node): ts.CallExpression[] => {
    const out: ts.CallExpression[] = []
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) out.push(n)
      ts.forEachChild(n, visit)
    }
    visit(node)
    return out
  }
  const touching = new Set<string>()
  for (let grew = true; grew; ) {
    grew = false
    for (const [name, fn] of functions) {
      if (touching.has(name)) continue
      const touches = calls(fn).some((c) => {
        const callee = callName(c)
        if (callee === undefined) return false
        return (
          touchesDisk(callee) ||
          touching.has(callee) ||
          imported.get(callee)?.module.touchingExports.has(imported.get(callee)!.name) === true
        )
      })
      if (touches) {
        touching.add(name)
        grew = true
      }
    }
  }

  /** Why a call reaches the checkout, or undefined. */
  const reachOf = (c: ts.CallExpression): string | undefined => {
    const where = `${file}:${lineOf(sf, c)}`
    const withRoot = c.arguments.some((a) => mentionsRoot(a))
    if (c.expression.kind === ts.SyntaxKind.ImportKeyword) {
      return withRoot ? `${where}: import() of a path in the checkout` : undefined
    }
    const callee = callName(c)
    if (callee === undefined) return undefined
    if (withRoot && (touchesDisk(callee) || touching.has(callee))) {
      return `${where}: ${callee}() on a path in the checkout`
    }
    if (
      FS_CALLS.has(callee) &&
      c.arguments.slice(0, pathArgs(callee)).some(isRelativeLiteral) &&
      !setsCwd(c)
    ) {
      return `${where}: ${callee}() on a path relative to the working directory, the checkout`
    }
    if (isSpawn(callee) && !setsCwd(c)) {
      return `${where}: ${callee}() with no cwd, so in the checkout`
    }
    const from = ts.isIdentifier(c.expression) ? imported.get(callee) : undefined
    if (from?.module.reachingExports.has(from.name) === true) {
      return `${where}: ${callee}(), a helper that reaches the checkout`
    }
    if (withRoot && from?.module.touchingExports.has(from.name) === true) {
      return `${where}: ${callee}() on a path in the checkout`
    }
    return undefined
  }

  const reaches = calls(sf).flatMap((c) => reachOf(c) ?? [])
  if (importReach !== undefined) reaches.unshift(`${file}: ${importReach}`)
  const insideFunction = (n: ts.Node): boolean => {
    for (let p = n.parent; p !== undefined; p = p.parent) {
      if (ts.isFunctionLike(p)) return true
    }
    return false
  }
  const onLoad = calls(sf).some((c) => !insideFunction(c) && reachOf(c) !== undefined)

  // A function reaches when a call in it does, or it calls one here that does.
  const reaching = new Set<string>()
  for (let grew = true; grew; ) {
    grew = false
    for (const [name, fn] of functions) {
      if (reaching.has(name)) continue
      const hit = calls(fn).some((c) => reachOf(c) !== undefined || reaching.has(callName(c) ?? ''))
      if (hit) {
        reaching.add(name)
        grew = true
      }
    }
  }
  const exported = new Set<string>()
  const exportVisit = (n: ts.Node): void => {
    const modifiers = ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined
    const isExported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
    if (isExported && ts.isFunctionDeclaration(n) && n.name !== undefined) exported.add(n.name.text)
    if (isExported && ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations)
        bindingNames(d.name).forEach((x) => exported.add(x))
    }
    if (
      ts.isExportDeclaration(n) &&
      n.exportClause !== undefined &&
      ts.isNamedExports(n.exportClause)
    ) {
      for (const e of n.exportClause.elements) exported.add((e.propertyName ?? e.name).text)
    }
  }
  sf.statements.forEach(exportVisit)
  return {
    reaches,
    onLoad,
    reachingExports: new Set([...exported].filter((n) => reaching.has(n))),
    touchingExports: new Set([...exported].filter((n) => touching.has(n))),
  }
}

const HELPER_DIRS = ['tests/tooling/', 'tests/architecture/']

/**
 * Why a test file reaches the checkout through an fs read or a child process, following one hop of relative imports
 * into helpers under tests/tooling and tests/architecture. Empty when it does not.
 */
export function checkoutReaches(root: string, file: string): string[] {
  const cache = new Map<string, Module>()
  const helper = (specifier: string): Module | undefined => {
    const base = resolve(root, dirname(file), specifier)
    const candidates = [base, `${base}.ts`, base.replace(/\.js$/, '.ts'), join(base, 'index.ts')]
    const found = candidates.find((c) => c.endsWith('.ts') && existsSync(c))
    if (found === undefined) return undefined
    const path = relative(root, found).split('\\').join('/')
    if (
      !HELPER_DIRS.some((d) => path.startsWith(d)) ||
      TEST_PATH.test(path.replace(/^tests\//, ''))
    ) {
      return undefined
    }
    if (!cache.has(path)) cache.set(path, analyse(root, path, undefined))
    return cache.get(path)
  }
  return analyse(root, file, helper).reaches
}

export type Finding = { file: string; check: 'i' | 'ii' | 'iii' | 'iv'; message: string }

const literalPrefix = (glob: string): string => glob.split(/[*?[{]/)[0] ?? ''

/**
 * What is wrong with a harness test file's `// Reads:` declaration, read with `declared`. `as` is the path the file
 * is judged at (a fixture judged as a tooling test); its imports resolve from where it is.
 */
export function readsFindings(
  co: Checkout,
  file: string,
  declared: (source: string) => string[] | undefined,
  as: string = file,
): Finding[] {
  let globs: string[] | undefined
  try {
    globs = declared(readFileSync(join(co.root, file), 'utf8'))
  } catch (error) {
    return [{ file: as, check: 'i', message: `${as}: ${(error as Error).message}` }]
  }
  if (globs === undefined) {
    return [
      {
        file: as,
        check: 'i',
        message: `${as}: no "// Reads:" line; name the checkout files it reads or runs outside its imports, or "// Reads: nothing"`,
      },
    ]
  }
  const out: Finding[] = []
  const listed = new Set(co.files)
  for (const glob of globs) {
    const prefix = literalPrefix(glob)
    const matches =
      prefix === glob
        ? listed.has(glob)
        : co.files.some((p) => p.startsWith(prefix) && matchesReadGlob(p, glob))
    if (!matches) {
      out.push({
        file: as,
        check: 'ii',
        message: `${as}: "// Reads: ${glob}" matches no file in the checkout`,
      })
    }
  }
  if (globs.length === 0) {
    const why = checkoutReaches(co.root, file)
    if (why.length > 0) {
      out.push({
        file: as,
        check: 'iii',
        message: `${as}: declares "// Reads: nothing" but reaches the checkout (${why[0]})`,
      })
    }
  }
  if (as.startsWith('tests/tooling/')) {
    for (const glob of globs) {
      const prefix = literalPrefix(glob)
      const hit = co.product.find((p) => p.startsWith(prefix) && matchesReadGlob(p, glob))
      if (hit !== undefined) {
        out.push({
          file: as,
          check: 'iv',
          message: `${as}: "// Reads: ${glob}" names the product path ${hit}; a tooling test declares none`,
        })
      }
    }
  }
  return out
}
