import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { posix, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import ts from 'typescript'

// Assertion census. Classifies every `expect(...).matcher(...)` in the test files by the strength of what it checks:
//   C1 presence or sanity (toBeDefined, toBeTruthy, toThrow() ...)
//   C2 a property-based assertion (inside fc.property, fc.asyncProperty, test.prop, it.prop)
//   C3 relational or computed (toBeGreaterThan, toBe(before - qty), toBe(sumOf(lines)) ...)
//   C4 exact against a literal or a plain reference (toBe(3), toEqual({ ... }), toThrow('boom') ...)
//   other: a matcher this script does not know (listed by name in otherMatchers)
// A file with no assertion at all delegates (to a shared suite, say) and is counted as delegating, not as weak;
// `--include <glob>` adds such suites' source files so their assertions are counted too.

export type Counts = { C1: number; C2: number; C3: number; C4: number; other: number }

export type FileCensus = {
  path: string
  package: string
  layer: string
  tests: number
  skipped: number
  prints: number
  assertions: Counts
  otherMatchers: string[]
  hasStrong: boolean
}

export type Totals = Counts & {
  files: number
  tests: number
  skipped: number
  prints: number
  filesWithoutStrong: number
  delegating: number
}

export type Layer = 'unit' | 'integration' | 'contract' | 'e2e' | 'architecture' | 'tooling'

const C1_MATCHERS = new Set([
  'toBeDefined',
  'toBeUndefined',
  'toBeTruthy',
  'toBeFalsy',
  'toBeNull',
  'toBeInstanceOf',
  'toBeVisible',
  'toBeHidden',
  'toBeEnabled',
  'toHaveBeenCalled',
  'toBeOK',
])

const EXACT_MATCHERS = new Set([
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toMatchObject',
  'toHaveLength',
  'toContain',
  'toMatch',
  'toHaveText',
  'toHaveURL',
  'toHaveBeenCalledWith',
  'toHaveBeenCalledTimes',
  'toMatchSnapshot',
  'toThrow',
])

const RELATIONAL_MATCHERS = new Set([
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeCloseTo',
])

/** Property accesses between `expect(...)` and the matcher that do not change what is being asserted. */
const CHAIN_MODIFIERS = new Set(['not', 'resolves', 'rejects'])

/** `expect.<name>(subject)` forms that return an assertion chain. */
const EXPECT_FACTORIES = new Set(['soft', 'poll'])

const TEST_ROOTS = new Set(['it', 'test'])

const TEST_MODIFIERS = new Set([
  'only',
  'skip',
  'todo',
  'each',
  'concurrent',
  'prop',
  'fails',
  'sequential',
  'runIf',
  'skipIf',
  'fixme',
])

/** Modifiers that Playwright also accepts as runtime calls inside a test (`test.skip(cond, reason)`, `test.fixme()`). */
const RUNTIME_MODIFIERS = new Set(['skip', 'fixme'])

/** Modifiers that return a test function rather than registering a test themselves. */
const TEST_FACTORY_MODIFIERS = new Set(['each', 'prop', 'runIf', 'skipIf'])

const PRINT_METHODS = new Set(['log', 'info', 'debug'])

const COMPUTE_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
])

function emptyCounts(): Counts {
  return { C1: 0, C2: 0, C3: 0, C4: 0, other: 0 }
}

function emptyTotals(): Totals {
  return {
    ...emptyCounts(),
    files: 0,
    tests: 0,
    skipped: 0,
    prints: 0,
    filesWithoutStrong: 0,
    delegating: 0,
  }
}

type Chain = { root: string; mods: string[] }

/** `a.b.c` as `{ root: 'a', mods: ['b', 'c'] }`; undefined for anything that is not a plain dotted name. */
function dottedChain(node: ts.Expression): Chain | undefined {
  const mods: string[] = []
  let current: ts.Expression = node
  while (ts.isPropertyAccessExpression(current)) {
    mods.unshift(current.name.text)
    current = current.expression
  }
  return ts.isIdentifier(current) ? { root: current.text, mods } : undefined
}

function testChain(node: ts.Expression): Chain | undefined {
  const chain = dottedChain(node)
  if (!chain || !TEST_ROOTS.has(chain.root)) return undefined
  return chain.mods.every((m) => TEST_MODIFIERS.has(m)) ? chain : undefined
}

type TestSite = { skipped: boolean; property: boolean }

/** The registration of a test: `it(...)`, `it.skip(...)`, or the outer call of `it.each(table)(...)`. */
function testSite(call: ts.CallExpression): TestSite | undefined {
  const callee = call.expression
  if (ts.isCallExpression(callee) || ts.isTaggedTemplateExpression(callee)) {
    const factory = ts.isCallExpression(callee) ? callee.expression : callee.tag
    const chain = testChain(factory)
    const last = chain?.mods[chain.mods.length - 1]
    if (!chain || last === undefined || !TEST_FACTORY_MODIFIERS.has(last)) return undefined
    return { skipped: isSkipped(chain), property: last === 'prop' }
  }
  const chain = testChain(callee)
  if (!chain) return undefined
  const last = chain.mods[chain.mods.length - 1]
  if (last !== undefined && TEST_FACTORY_MODIFIERS.has(last)) return undefined
  if (last !== undefined && RUNTIME_MODIFIERS.has(last) && !registersTest(call)) return undefined
  return { skipped: isSkipped(chain), property: false }
}

/** `test.skip('name', fn)` registers a test; `test.skip()`, `test.skip(cond, reason)` and `test.fixme()` do not. */
function registersTest(call: ts.CallExpression): boolean {
  const [name, body] = call.arguments
  if (name === undefined) return false
  if (ts.isStringLiteralLike(name) || ts.isTemplateExpression(name)) return true
  return body !== undefined && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))
}

function isSkipped(chain: Chain): boolean {
  return chain.mods.some((m) => m === 'skip' || m === 'todo' || m === 'fixme')
}

function isPropertyBuilder(call: ts.CallExpression): boolean {
  const chain = dottedChain(call.expression)
  return (
    chain !== undefined &&
    chain.root === 'fc' &&
    chain.mods.length === 1 &&
    (chain.mods[0] === 'property' || chain.mods[0] === 'asyncProperty')
  )
}

function isFcAssert(call: ts.CallExpression): boolean {
  const chain = dottedChain(call.expression)
  return (
    chain !== undefined &&
    chain.root === 'fc' &&
    chain.mods.length === 1 &&
    chain.mods[0] === 'assert'
  )
}

function isExpectRoot(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text === 'expect'
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return callee.expression.text === 'expect' && EXPECT_FACTORIES.has(callee.name.text)
  }
  return false
}

/** The matcher name when `call` is `expect(...)[.not|.resolves|.rejects]*.matcher(...)`. */
function matcherOf(call: ts.CallExpression): string | undefined {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  let subject: ts.Expression = callee.expression
  while (ts.isPropertyAccessExpression(subject) && CHAIN_MODIFIERS.has(subject.name.text)) {
    subject = subject.expression
  }
  return isExpectRoot(subject) ? callee.name.text : undefined
}

function isExpectNamespaceCall(call: ts.CallExpression): boolean {
  const callee = call.expression
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'expect'
  )
}

/** True when an argument computes its expectation: an arithmetic or comparison operator, or a call other than `expect.*`. */
function computesExpectation(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node) && COMPUTE_OPERATORS.has(node.operatorToken.kind)) return true
  if (ts.isCallExpression(node) && !isExpectNamespaceCall(node)) return true
  return ts.forEachChild(node, (child) => (computesExpectation(child) ? true : undefined)) === true
}

function classifyMatcher(call: ts.CallExpression, name: string): keyof Counts {
  if (C1_MATCHERS.has(name)) return 'C1'
  if (RELATIONAL_MATCHERS.has(name)) return 'C3'
  if (EXACT_MATCHERS.has(name)) {
    if (name === 'toThrow' && call.arguments.length === 0) return 'C1'
    return call.arguments.some(computesExpectation) ? 'C3' : 'C4'
  }
  return 'other'
}

export function classifySource(source: string, path: string): FileCensus {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const assertions = emptyCounts()
  const otherMatchers = new Set<string>()
  let tests = 0
  let skipped = 0
  let prints = 0
  let propertyDepth = 0
  let assertionTotal = 0

  function visit(node: ts.Node): void {
    if (!ts.isCallExpression(node)) {
      ts.forEachChild(node, visit)
      return
    }

    const site = testSite(node)
    if (site) {
      tests += 1
      if (site.skipped) skipped += 1
    }

    const callee = node.expression
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'console' &&
      PRINT_METHODS.has(callee.name.text)
    ) {
      prints += 1
    }

    const matcher = matcherOf(node)
    if (matcher !== undefined) {
      const kind = propertyDepth > 0 ? 'C2' : classifyMatcher(node, matcher)
      assertions[kind] += 1
      assertionTotal += 1
      if (classifyMatcher(node, matcher) === 'other') otherMatchers.add(matcher)
    }

    const inProperty = isPropertyBuilder(node) || site?.property === true
    const before = assertionTotal
    if (inProperty) propertyDepth += 1
    ts.forEachChild(node, visit)
    if (inProperty) propertyDepth -= 1

    if (isFcAssert(node) && assertionTotal === before) {
      assertions.C2 += 1
      assertionTotal += 1
    }
  }

  visit(sourceFile)

  return {
    path,
    package: packageOf(path),
    layer: layerOf(path),
    tests,
    skipped,
    prints,
    assertions,
    otherMatchers: [...otherMatchers].sort(),
    hasStrong: assertions.C2 + assertions.C3 > 0,
  }
}

/** The local names `@playwright/test`'s `request` is imported under (`import { request as r }` included). */
function playwrightRequestNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@playwright/test'
    )
      continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'request') names.add(element.name.text)
    }
  }
  return names
}

/** Variables holding a context from `request.newContext()` (the import) or `playwright.request.newContext()`. */
function requestContexts(sourceFile: ts.SourceFile): Set<string> {
  const imported = playwrightRequestNames(sourceFile)
  const contexts = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer)
      const chain = ts.isCallExpression(init) ? dottedChain(init.expression) : undefined
      if (
        chain !== undefined &&
        ((imported.has(chain.root) && chain.mods.join('.') === 'newContext') ||
          (chain.root === 'playwright' && chain.mods.join('.') === 'request.newContext'))
      )
        contexts.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return contexts
}

type ApiRead = (node: ts.Node) => node is ts.CallExpression

/**
 * A call on the `request` fixture, `page.request` or a request context, or `fetch`, whose first argument names a path
 * under `/api/`.
 */
function apiReader(sourceFile: ts.SourceFile): ApiRead {
  const contexts = requestContexts(sourceFile)
  return (node: ts.Node): node is ts.CallExpression => {
    if (!ts.isCallExpression(node)) return false
    const chain = dottedChain(node.expression)
    const reader =
      chain !== undefined &&
      ((chain.root === 'fetch' && chain.mods.length === 0) ||
        ((chain.root === 'request' || contexts.has(chain.root)) && chain.mods.length === 1) ||
        (chain.root === 'page' && chain.mods.length === 2 && chain.mods[0] === 'request'))
    const target = node.arguments[0]
    return reader && target !== undefined && target.getText().includes('/api/')
  }
}

/** `x` out of `await x`, `(x)`, `x as T`, `x satisfies T` and `x!`. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function mentions(node: ts.Node, names: Set<string>, isApiRead: ApiRead): boolean {
  if (ts.isIdentifier(node) && names.has(node.text)) return true
  if (isApiRead(node)) return true
  return (
    ts.forEachChild(node, (child) => (mentions(child, names, isApiRead) ? true : undefined)) ===
    true
  )
}

/** A body the journey rule reads: the test file itself, or a support helper a test calls. */
type Unit = { node: ts.Node; isApiRead: ApiRead }

const SUPPORT = 'tests/e2e/support/'
const MODULE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '/index.ts']

/** The exported function bodies of a module, by exported name. */
function exportedFunctions(sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const found = new Map<string, ts.Node>()
  const exported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.body &&
      exported(statement)
    ) {
      found.set(statement.name.text, statement.body)
    } else if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const d of statement.declarationList.declarations) {
        const init = d.initializer
        if (
          ts.isIdentifier(d.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          found.set(d.name.text, init.body)
        }
      }
    }
  }
  return found
}

/**
 * The functions a journey imports from `tests/e2e/support/**`, by local name, each with its body and the reads its
 * own file makes; read from `root`, the repo the paths are relative to.
 */
function supportHelpers(sourceFile: ts.SourceFile, path: string, root: string): Map<string, Unit> {
  const helpers = new Map<string, Unit>()
  const parsed = new Map<string, { functions: Map<string, ts.Node>; isApiRead: ApiRead } | null>()
  const load = (target: string): { functions: Map<string, ts.Node>; isApiRead: ApiRead } | null => {
    if (!parsed.has(target)) {
      const file = MODULE_SUFFIXES.map((suffix) => `${target}${suffix}`).find((candidate) => {
        const absolute = resolve(root, candidate)
        return existsSync(absolute) && statSync(absolute).isFile()
      })
      if (file === undefined) parsed.set(target, null)
      else {
        const helper = ts.createSourceFile(
          file,
          readFileSync(resolve(root, file), 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        )
        parsed.set(target, { functions: exportedFunctions(helper), isApiRead: apiReader(helper) })
      }
    }
    return parsed.get(target) ?? null
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const specifier = statement.moduleSpecifier.text
    if (!specifier.startsWith('.')) continue
    const target = posix.join(posix.dirname(path), specifier)
    if (!target.startsWith(SUPPORT)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    const module = load(target)
    if (module === null) continue
    for (const element of bindings.elements) {
      const body = module.functions.get((element.propertyName ?? element.name).text)
      if (body !== undefined)
        helpers.set(element.name.text, { node: body, isApiRead: module.isApiRead })
    }
  }
  return helpers
}

/**
 * The journey rule (constitution rule 7) on one `tests/e2e/journeys/**` file: every test needs an assertion outside
 * C1, and the file needs an API read whose value, or its `.json()`, reaches an `expect()` as the subject or a matcher
 * argument. A read nothing asserts on is decoration, not evidence of what the user sees. Given `root`, a function a
 * test calls that the file imports from `tests/e2e/support/**` counts as part of the test, one level deep.
 */
export function journeyViolations(source: string, path: string, root?: string): string[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const helpers =
    root === undefined ? new Map<string, Unit>() : supportHelpers(sourceFile, path, root)
  const violations: string[] = []
  const called = new Set<Unit>()

  const helperOf = (node: ts.Node): Unit | undefined =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      ? helpers.get(node.expression.text)
      : undefined

  const judgeTests = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const site = testSite(node)
      if (site !== undefined && !site.skipped) {
        const kinds: Array<keyof Counts> = []
        const collect = (child: ts.Node, follow: boolean): void => {
          if (ts.isCallExpression(child)) {
            const name = matcherOf(child)
            if (name !== undefined) kinds.push(classifyMatcher(child, name))
            const helper = follow ? helperOf(child) : undefined
            if (helper !== undefined) {
              called.add(helper)
              collect(helper.node, false)
            }
          }
          ts.forEachChild(child, (grand) => collect(grand, follow))
        }
        node.arguments.forEach((argument) => collect(argument, true))
        if (!kinds.some((kind) => kind !== 'C1')) {
          const title = node.arguments[0]
          const name =
            title !== undefined && ts.isStringLiteralLike(title) ? title.text : '(unnamed)'
          violations.push(
            `${path}: test "${name}": ${kinds.length} assertion(s), all presence (C1); the journey rule needs one outside C1`,
          )
        }
      }
    }
    ts.forEachChild(node, judgeTests)
  }
  judgeTests(sourceFile)

  let reads = 0
  let asserted = false
  for (const { node: unit, isApiRead } of [
    { node: sourceFile, isApiRead: apiReader(sourceFile) },
    ...called,
  ]) {
    const fromApi = new Set<string>()
    const derived = (expression: ts.Expression): boolean => {
      const e = unwrap(expression)
      if (isApiRead(e)) return true
      if (ts.isIdentifier(e)) return fromApi.has(e.text)
      if (
        ts.isCallExpression(e) &&
        ts.isPropertyAccessExpression(e.expression) &&
        e.expression.name.text === 'json'
      ) {
        return derived(e.expression.expression)
      }
      return false
    }
    const bind = (node: ts.Node): void => {
      if (isApiRead(node)) reads += 1
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (derived(node.initializer)) fromApi.add(node.name.text)
      }
      ts.forEachChild(node, bind)
    }
    bind(unit)
    const judge = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        matcherOf(node) !== undefined &&
        mentions(node, fromApi, isApiRead)
      ) {
        asserted = true
      }
      ts.forEachChild(node, judge)
    }
    judge(unit)
  }

  if (reads === 0) {
    violations.push(
      `${path}: no API read (the request fixture, page.request, a request context or fetch to /api/); the journey rule needs one an expect() asserts on`,
    )
  } else if (!asserted) {
    violations.push(
      `${path}: ${reads} API read(s), none reaches an expect(); the journey rule needs one asserted on`,
    )
  }
  return violations
}

export function packageOf(path: string): string {
  const [first, second] = path.split('/')
  if (second === undefined) return '.'
  if (first === 'packages') return second
  if (first === 'apps' || first === 'templates' || first === 'tests') return `${first}/${second}`
  return first ?? '.'
}

export function layerOf(path: string): Layer {
  const segments = path.split('/')
  if (segments[0] === 'packages' && segments[1] === 'contract-tests') return 'contract'
  if (segments[0] === 'tests') {
    switch (segments[1]) {
      case 'contracts':
        return 'contract'
      case 'e2e':
        return 'e2e'
      case 'architecture':
        return 'architecture'
      case 'tooling':
        return 'tooling'
      default:
        break
    }
  }
  if (segments.slice(0, -1).includes('integration')) return 'integration'
  return 'unit'
}

function addInto(totals: Totals, file: FileCensus): void {
  totals.C1 += file.assertions.C1
  totals.C2 += file.assertions.C2
  totals.C3 += file.assertions.C3
  totals.C4 += file.assertions.C4
  totals.other += file.assertions.other
  totals.files += 1
  totals.tests += file.tests
  totals.skipped += file.skipped
  totals.prints += file.prints
  const { C1, C2, C3, C4, other } = file.assertions
  if (C1 + C2 + C3 + C4 + other === 0) totals.delegating += 1
  else if (C2 + C3 === 0) totals.filesWithoutStrong += 1
}

export function aggregate(files: FileCensus[]): {
  byPackage: Record<string, Totals>
  byLayer: Record<string, Totals>
  total: Totals
} {
  const byPackage: Record<string, Totals> = {}
  const byLayer: Record<string, Totals> = {}
  const total = emptyTotals()
  for (const file of files) {
    addInto((byPackage[file.package] ??= emptyTotals()), file)
    addInto((byLayer[file.layer] ??= emptyTotals()), file)
    addInto(total, file)
  }
  return { byPackage, byLayer, total }
}

export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/
export const EXCLUDED_PREFIXES = ['tests/tooling/fixtures/', 'tests/sentinels/']

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
}

function lsFiles(root: string, pathspecs: string[]): string[] {
  return execFileSync('git', ['ls-files', '--', ...pathspecs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean)
}

function trackedTestFiles(root: string): string[] {
  return lsFiles(root, []).filter(
    (p) => TEST_FILE.test(p) && !EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix)),
  )
}

function censusFiles(root: string, paths: string[]): FileCensus[] {
  const files: FileCensus[] = []
  for (const path of new Set(paths)) {
    const absolute = resolve(root, path)
    if (!existsSync(absolute)) continue
    files.push(classifySource(readFileSync(absolute, 'utf8'), relative(root, absolute)))
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const COLUMNS: Array<[header: string, key: keyof Totals]> = [
  ['files', 'files'],
  ['tests', 'tests'],
  ['skipped', 'skipped'],
  ['C1', 'C1'],
  ['C2', 'C2'],
  ['C3', 'C3'],
  ['C4', 'C4'],
  ['other', 'other'],
  ['prints', 'prints'],
  ['files without C2/C3', 'filesWithoutStrong'],
  ['delegating', 'delegating'],
]

function table(title: string, rows: Array<[string, Totals]>): string {
  const lines = [
    `### ${title}`,
    '',
    `| ${title} | ${COLUMNS.map(([h]) => h).join(' | ')} |`,
    `|---|${COLUMNS.map(() => '---:').join('|')}|`,
  ]
  for (const [name, totals] of rows) {
    lines.push(`| ${name} | ${COLUMNS.map(([, key]) => totals[key]).join(' | ')} |`)
  }
  return lines.join('\n')
}

function sortedRows(rows: Record<string, Totals>): Array<[string, Totals]> {
  return Object.entries(rows).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

export function renderTables(result: ReturnType<typeof aggregate>): string {
  return [
    table('By package', sortedRows(result.byPackage)),
    table('By layer', sortedRows(result.byLayer)),
    table('Total', [['total', result.total]]),
  ].join('\n\n')
}

function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      include: { type: 'string', multiple: true, default: [] },
    },
  })
  const root = repoRoot()
  const base = positionals.length > 0 ? positionals : trackedTestFiles(root)
  const included =
    values.include.length > 0
      ? lsFiles(
          root,
          values.include.map((g) => `:(glob)${g}`),
        )
      : []
  const files = censusFiles(root, [...base, ...included])
  const result = aggregate(files)
  const output = values.json ? JSON.stringify({ ...result, files }) : renderTables(result)
  process.stdout.write(`${output}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
