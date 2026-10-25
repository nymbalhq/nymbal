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
//
// The census trend (scripts/gate.ts) also refuses a test the change adds or rewrites when it has one of three shapes,
// whatever else its file holds; an old test left as it was is not judged. `--guard` lists them as if every test were new.
//   R1 presence-only: every assertion says only that something is there (toBeTruthy, toBeVisible, toBeGreaterThan(0));
//      something gone (toBeHidden, toBeFalsy, not.toBeVisible) is an outcome once the test has acted, and so is
//      rejects.toBeInstanceOf(X) or toBeInstanceOf of a class the file imports or declares
//   The assertions of a test include those of the file's functions it calls for effect, not for a value it then uses
//   (those arrange, and assert preconditions); fc.assert over only fc.constant arbitraries is an example test, judged
//   like any other.
//   R2 mock-call-only: every assertion is on a mock's calls (toHaveBeenCalledWith, .mock.calls), or is presence
//   R3 constant-initial-state: the only act is construction, and every assertion compares a read to a literal

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

/** `fc.assert(fc.property(fc.constant(1), ...))`: one fixed input, so an example test, not a property. */
function overConstantsOnly(call: ts.CallExpression): boolean {
  const first = call.arguments[0]
  if (first === undefined) return false
  const built = ts.isParenthesizedExpression(first) ? first.expression : first
  if (!ts.isCallExpression(built) || !isPropertyBuilder(built)) return false
  const arbitraries = built.arguments.slice(0, -1)
  return (
    arbitraries.length > 0 &&
    arbitraries.every((arbitrary) => {
      if (!ts.isCallExpression(arbitrary)) return false
      const chain = dottedChain(arbitrary.expression)
      return chain?.root === 'fc' && chain.mods.length === 1 && chain.mods[0] === 'constant'
    })
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

// ---------------------------------------------------------------------------------------------------------------
// Refused shapes: the tests the census trend turns away when a change adds or rewrites them
// ---------------------------------------------------------------------------------------------------------------

export type RefusedKind = 'R1' | 'R2' | 'R3'

export type RefusedTest = {
  name: string
  line: number
  kind: RefusedKind
  /** The matchers the test's assertions use, in order, with `not.` where negated. */
  matchers: string[]
  /** The test's function with its whitespace collapsed; the same key in the base file means an unchanged test. */
  key: string
}

/** Matchers that say something is there, visible, truthy or of a type, and pin no value. */
const PRESENCE_MATCHERS = new Set([
  'toBeDefined',
  'toBeTruthy',
  'toBeFalsy',
  'toBeInstanceOf',
  'toBeVisible',
  'toBeHidden',
  'toBeAttached',
  'toBeInViewport',
  'toBeInTheDocument',
  'toBeTypeOf',
  'toBeOK',
])

/** Matchers that pin an absence, so negated (`not.toBeNull()`) they say only that something is there. */
const ABSENCE_MATCHERS = new Set(['toBeNull', 'toBeUndefined'])

/** Presence matchers that say something is gone or off; after an act (Escape, `close()`) that is the outcome. */
const GONE_MATCHERS = new Set(['toBeHidden', 'toBeFalsy'])

/** Presence matchers that, negated (`not.toBeVisible()`), say something is gone. */
const THERE_MATCHERS = new Set([
  'toBeVisible',
  'toBeTruthy',
  'toBeDefined',
  'toBeAttached',
  'toBeInViewport',
  'toBeInTheDocument',
])

/** Matchers on a mock's record of calls and returns. */
const MOCK_MATCHERS = new Set([
  'toHaveBeenCalled',
  'toHaveBeenCalledWith',
  'toHaveBeenCalledTimes',
  'toHaveBeenCalledOnce',
  'toHaveBeenCalledExactlyOnceWith',
  'toHaveBeenNthCalledWith',
  'toHaveBeenLastCalledWith',
  'toHaveBeenCalledBefore',
  'toHaveBeenCalledAfter',
  'toBeCalled',
  'toBeCalledWith',
  'toBeCalledTimes',
  'lastCalledWith',
  'nthCalledWith',
  'toHaveReturned',
  'toHaveReturnedWith',
  'toHaveReturnedTimes',
  'toHaveLastReturnedWith',
  'toHaveNthReturnedWith',
  'toReturn',
  'toReturnWith',
  'toReturnTimes',
  'toHaveResolved',
  'toHaveResolvedWith',
  'toHaveResolvedTimes',
])

/** `fn.mock.<record>`: an assertion that reads one is about the mock, whatever its matcher. */
const MOCK_RECORDS = new Set([
  'calls',
  'lastCall',
  'results',
  'settledResults',
  'instances',
  'contexts',
  'invocationCallOrder',
])

/** Matchers that wrap a block of assertions rather than make one (`expect(async () => { ... }).toPass()`). */
const WRAPPER_MATCHERS = new Set(['toPass'])

/** The start of a callee name that constructs the subject rather than acts on it (`createCartStore`, `renderHook`). */
const CONSTRUCTION_PREFIXES = [
  'create',
  'make',
  'build',
  'init',
  'setup',
  'render',
  'mount',
  'fixture',
]

/** Methods that query an object when given arguments; a method given none is a read too. */
const READ_METHODS = new Set([
  'querySelector',
  'querySelectorAll',
  'getAttribute',
  'hasAttribute',
  'closest',
  'getByTestId',
  'getByRole',
  'getByText',
  'getByLabel',
  'get',
  'has',
  'includes',
  'at',
  'slice',
  'find',
  'filter',
  'map',
  'some',
  'every',
  'keys',
  'values',
  'entries',
  'from',
  'split',
  'join',
  'trim',
  'startsWith',
  'endsWith',
  'toString',
  'toJSON',
])

/** Plain functions that cast a read rather than act on it. */
const CAST_FUNCTIONS = new Set(['Number', 'String', 'Boolean', 'BigInt'])

/** Namespaces whose calls configure the run rather than act on the subject (`vi.useFakeTimers()`). */
const NEUTRAL_ROOTS = new Set(['vi', 'jest', 'console'])

const BEFORE_HOOKS = new Set(['beforeEach', 'beforeAll'])
const AFTER_HOOKS = new Set(['afterEach', 'afterAll'])

const KIND_NAMES: Record<RefusedKind, string> = {
  R1: 'presence-only',
  R2: 'mock-call-only',
  R3: 'constant-initial-state',
}

const KIND_HINTS: Record<RefusedKind, string> = {
  R1: "every assertion says only that something is there; assert the outcome instead, e.g. expect(order.status).toBe('paid') or expect(await badge.textContent()).toBe(String(cart.items.length))",
  R2: "every assertion is on a mock's calls; assert what the call left behind instead, e.g. expect(response.status).toBe(204) and expect(sessions().length).toBe(before - 1)",
  R3: 'the only act is construction and every assertion compares a read to a literal; act on it and assert what the act changes, e.g. expect(after.items.length).toBe(before.items.length + 1)',
}

/** `gone` is presence until the test has acted, and an outcome after. */
type Weight = 'presence' | 'gone' | 'mock' | 'outcome'

type Scope = { clean: boolean; constructed: boolean }

/**
 * The functions a file declares, and which of them only read, so `shadow(el)` is a read and `gateStep(root)` an act;
 * and every name the file imports or declares, so `toBeInstanceOf(NotFoundError)` names a class of the code under test
 * where `toBeInstanceOf(Object)` names a built-in.
 */
type Ctx = {
  helpers: Map<string, ts.FunctionLikeDeclaration>
  readOnly: Map<string, boolean>
  declared: Set<string>
}

function contextOf(sourceFile: ts.SourceFile): Ctx {
  const helpers = new Map<string, ts.FunctionLikeDeclaration>()
  const declared = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
      helpers.set(node.name.text, node)
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = peel(node.initializer)
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        helpers.set(node.name.text, init)
    }
    if (
      (ts.isImportClause(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportSpecifier(node) ||
        ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      declared.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { helpers, readOnly: new Map(), declared }
}

/** `x` out of `(x)`, `x as T`, `x satisfies T` and `x!`, keeping an `await`: an awaited call is an act. */
function peel(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/** The `expect(...)` call under a matcher call, through `not`, `resolves` and `rejects`, with those names. */
function expectRoot(
  call: ts.CallExpression,
): { root: ts.CallExpression; modifiers: string[] } | undefined {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee)) return undefined
  const modifiers: string[] = []
  let subject: ts.Expression = callee.expression
  while (ts.isPropertyAccessExpression(subject) && CHAIN_MODIFIERS.has(subject.name.text)) {
    modifiers.unshift(subject.name.text)
    subject = subject.expression
  }
  return isExpectRoot(subject) ? { root: subject as ts.CallExpression, modifiers } : undefined
}

/** What `expect(...)` was given, peeled. */
function expectSubject(call: ts.CallExpression): ts.Expression | undefined {
  const first = expectRoot(call)?.root.arguments[0]
  return first === undefined ? undefined : peel(first)
}

function mentionsMockRecord(node: ts.Node): boolean {
  if (
    ts.isPropertyAccessExpression(node) &&
    MOCK_RECORDS.has(node.name.text) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'mock'
  )
    return true
  return ts.forEachChild(node, (child) => (mentionsMockRecord(child) ? true : undefined)) === true
}

function numberArg(call: ts.CallExpression): number | undefined {
  const arg = call.arguments[0]
  return arg !== undefined && ts.isNumericLiteral(arg) ? Number(arg.text) : undefined
}

/** `x > 0` or `x >= 1`: a count asked only to be non-empty. */
function isNonEmptyComparison(node: ts.Expression): boolean {
  const e = peel(node)
  if (!ts.isBinaryExpression(e) || !ts.isNumericLiteral(e.right)) return false
  const n = Number(e.right.text)
  const op = e.operatorToken.kind
  return (
    (op === ts.SyntaxKind.GreaterThanToken && n === 0) ||
    (op === ts.SyntaxKind.GreaterThanEqualsToken && n === 1)
  )
}

function isNonEmptyCount(
  call: ts.CallExpression,
  matcher: string,
  negated: boolean,
  subject: ts.Expression | undefined,
): boolean {
  if (matcher === 'toBeGreaterThan') return numberArg(call) === 0
  if (matcher === 'toBeGreaterThanOrEqual') return numberArg(call) === 1
  if (matcher === 'toHaveLength') return negated && numberArg(call) === 0
  if (matcher === 'toBe' || matcher === 'toEqual' || matcher === 'toStrictEqual') {
    const arg = call.arguments[0]
    return (
      arg !== undefined &&
      arg.kind === ts.SyntaxKind.TrueKeyword &&
      subject !== undefined &&
      isNonEmptyComparison(subject)
    )
  }
  return false
}

/**
 * How much an assertion pins: presence, a mock's calls, or an outcome; `undefined` for a wrapper such as `toPass`.
 * `rejects.toBeInstanceOf(X)` is `toThrow(X)` for a promise, and an instance of a class the file imports or declares
 * pins which of the code's own types came back, so both are outcomes.
 */
function weigh(call: ts.CallExpression, matcher: string, ctx: Ctx): Weight | undefined {
  if (WRAPPER_MATCHERS.has(matcher)) return undefined
  const modifiers = expectRoot(call)?.modifiers ?? []
  const negated = modifiers.includes('not')
  const subject = expectSubject(call)
  if (subject !== undefined && mentionsMockRecord(subject)) return 'mock'
  if (MOCK_MATCHERS.has(matcher)) return 'mock'
  if (matcher === 'toBeInstanceOf' && !negated) {
    const cls = call.arguments[0]
    const root = cls === undefined ? undefined : rootName(cls)
    if (modifiers.includes('rejects') || (root !== undefined && ctx.declared.has(root))) {
      return 'outcome'
    }
  }
  if (negated ? THERE_MATCHERS.has(matcher) : GONE_MATCHERS.has(matcher)) return 'gone'
  if (PRESENCE_MATCHERS.has(matcher)) return 'presence'
  if (negated && ABSENCE_MATCHERS.has(matcher)) return 'presence'
  if ((matcher === 'toThrow' || matcher === 'toThrowError') && call.arguments.length === 0) {
    return 'presence'
  }
  if (matcher === 'toHaveProperty' && call.arguments.length === 1) return 'presence'
  if (subject !== undefined && ts.isTypeOfExpression(subject)) return 'presence'
  if (isNonEmptyCount(call, matcher, negated, subject)) return 'presence'
  return 'outcome'
}

function lastName(callee: ts.Expression): string | undefined {
  const e = peel(callee)
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return undefined
}

function isConstructionName(name: string | undefined): boolean {
  return (
    name !== undefined &&
    CONSTRUCTION_PREFIXES.some((p) => name.startsWith(p) && !/^[a-z]/.test(name.slice(p.length)))
  )
}

/** `new X(...)`, or a call whose name says it builds the subject, awaited or not. */
function isConstruction(node: ts.Expression): boolean {
  const e = unwrap(node)
  if (ts.isNewExpression(e)) return true
  return ts.isCallExpression(e) && isConstructionName(lastName(e.expression))
}

/**
 * A value written out: a literal, `undefined`, a template without holes, a regex, an array or object of these, or an
 * asymmetric matcher (`expect.any(Number)`, `expect.objectContaining({ ...literals })`).
 */
function isLiteral(node: ts.Expression): boolean {
  const e = unwrap(node)
  if (
    ts.isStringLiteralLike(e) ||
    ts.isNumericLiteral(e) ||
    ts.isBigIntLiteral(e) ||
    ts.isRegularExpressionLiteral(e)
  )
    return true
  if (
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  )
    return true
  if (ts.isIdentifier(e)) return e.text === 'undefined' || e.text === 'NaN' || e.text === 'Infinity'
  if (ts.isPrefixUnaryExpression(e)) return isLiteral(e.operand)
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.every((el) => !ts.isSpreadElement(el) && isLiteral(el))
  }
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.every((p) => ts.isPropertyAssignment(p) && isLiteral(p.initializer))
  }
  if (ts.isCallExpression(e) && isExpectNamespaceCall(e)) {
    const name = (e.expression as ts.PropertyAccessExpression).name.text
    return name === 'any' || name === 'anything' || e.arguments.every(isLiteral)
  }
  return false
}

function isReadArgument(node: ts.Expression, ctx: Ctx): boolean {
  const e = peel(node)
  return (
    isLiteral(e) ||
    isRead(e, ctx) ||
    isConstruction(e) ||
    ts.isArrowFunction(e) ||
    ts.isFunctionExpression(e)
  )
}

/** A function the file declares whose body makes no call that is not itself a read; a recursive one is not. */
function isReadHelper(name: string, ctx: Ctx): boolean {
  const known = ctx.readOnly.get(name)
  if (known !== undefined) return known
  const fn = ctx.helpers.get(name)
  if (fn === undefined || fn.body === undefined) return false
  ctx.readOnly.set(name, false)
  let pure = true
  const visit = (node: ts.Node): void => {
    if (!pure) return
    if (ts.isCallExpression(node) && !isRead(node, ctx)) pure = false
    else ts.forEachChild(node, visit)
  }
  visit(fn.body)
  ctx.readOnly.set(name, pure)
  return pure
}

/**
 * An expression that reads rather than acts: a name, a literal, a property or index of a read, a method given no
 * arguments, a query method given literals or reads, a cast, a read-only helper of the file over a read
 * (`shadow(el)`), `typeof x`, or an awaited property. Any other plain function call, and any awaited call, acts.
 */
function isRead(node: ts.Expression, ctx: Ctx): boolean {
  const e = peel(node)
  if (ts.isAwaitExpression(e)) {
    const inner = peel(e.expression)
    return !ts.isCallExpression(inner) && !ts.isNewExpression(inner) && isRead(inner, ctx)
  }
  if (ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword || isLiteral(e)) return true
  if (ts.isPropertyAccessExpression(e)) return isRead(e.expression, ctx)
  if (ts.isElementAccessExpression(e)) {
    return isRead(e.expression, ctx) && isRead(e.argumentExpression, ctx)
  }
  if (ts.isTypeOfExpression(e)) return isRead(e.expression, ctx)
  if (!ts.isCallExpression(e)) return false
  const callee = peel(e.expression)
  const args = e.arguments
  if (ts.isPropertyAccessExpression(callee)) {
    if (!isRead(callee.expression, ctx)) return false
    if (args.length === 0) return true
    return READ_METHODS.has(callee.name.text) && args.every((a) => isReadArgument(a, ctx))
  }
  if (!ts.isIdentifier(callee) || isConstructionName(callee.text)) return false
  if (!args.every((a) => isReadArgument(a, ctx))) return false
  if (CAST_FUNCTIONS.has(callee.text)) return true
  return args.some((a) => !isLiteral(a)) && isReadHelper(callee.text, ctx)
}

function isSetupValue(node: ts.Expression, ctx: Ctx): boolean {
  const e = peel(node)
  return (
    isLiteral(e) ||
    isConstruction(e) ||
    isRead(e, ctx) ||
    ts.isArrowFunction(e) ||
    ts.isFunctionExpression(e) ||
    ts.isClassExpression(e) ||
    ts.isObjectLiteralExpression(e) ||
    ts.isArrayLiteralExpression(e) ||
    ts.isTemplateExpression(e)
  )
}

/** The call a statement makes, through `await`, when it is nothing but that call. */
function callOf(item: ts.Statement | ts.Expression): ts.CallExpression | undefined {
  const expression = ts.isExpressionStatement(item) ? item.expression : item
  if (!ts.isExpression(expression)) return undefined
  const e = unwrap(expression)
  return ts.isCallExpression(e) ? e : undefined
}

/** The identifier a call chain starts from: `vi` in `vi.spyOn(x, 'y').mockReturnValue(1)`. */
function rootName(node: ts.Expression): string | undefined {
  let current: ts.Expression = peel(node)
  for (;;) {
    if (ts.isIdentifier(current)) return current.text
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current)
    ) {
      current = peel(current.expression)
      continue
    }
    return undefined
  }
}

/**
 * Setup rather than an act: a declaration or assignment of a construction, a read or a value written out, an
 * assertion, a run-configuration call (`vi.*`), or a declaration of a helper or a type.
 */
function isSetupStatement(item: ts.Statement | ts.Expression, ctx: Ctx): boolean {
  if (ts.isVariableStatement(item)) {
    return item.declarationList.declarations.every(
      (d) => d.initializer === undefined || isSetupValue(d.initializer, ctx),
    )
  }
  if (ts.isExpressionStatement(item) || ts.isExpression(item)) {
    const e = unwrap(ts.isExpressionStatement(item) ? item.expression : item)
    if (ts.isCallExpression(e)) {
      if (matcherOf(e) !== undefined) return true
      const root = rootName(e)
      return root !== undefined && NEUTRAL_ROOTS.has(root)
    }
    return (
      ts.isBinaryExpression(e) &&
      e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isSetupValue(e.right, ctx)
    )
  }
  return (
    ts.isFunctionDeclaration(item) ||
    ts.isClassDeclaration(item) ||
    ts.isTypeAliasDeclaration(item) ||
    ts.isInterfaceDeclaration(item) ||
    ts.isEnumDeclaration(item) ||
    ts.isImportDeclaration(item) ||
    ts.isExportDeclaration(item) ||
    ts.isEmptyStatement(item)
  )
}

function constructs(item: ts.Statement | ts.Expression): boolean {
  if (ts.isVariableStatement(item)) {
    return item.declarationList.declarations.some(
      (d) => d.initializer !== undefined && isConstruction(d.initializer),
    )
  }
  const e = ts.isExpressionStatement(item) ? item.expression : item
  return (
    ts.isBinaryExpression(e) &&
    e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isConstruction(e.right)
  )
}

function functionArgument(
  call: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let i = call.arguments.length - 1; i >= 0; i -= 1) {
    const argument = call.arguments[i] as ts.Expression
    if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return argument
  }
  return undefined
}

/** The statements of a function body, or its one expression. */
function bodyItems(
  fn: ts.ArrowFunction | ts.FunctionExpression,
): Array<ts.Statement | ts.Expression> {
  return ts.isBlock(fn.body) ? [...fn.body.statements] : [fn.body]
}

function hookName(call: ts.CallExpression): string | undefined {
  const chain = dottedChain(call.expression)
  if (chain === undefined) return undefined
  if (chain.mods.length === 0) return chain.root
  if (TEST_ROOTS.has(chain.root) && chain.mods.length === 1) return chain.mods[0]
  return undefined
}

/** The body of `describe(...)`, `describe.skip(...)`, `describe.each(table)(...)`, `suite(...)` or `test.describe(...)`. */
function describeBody(
  call: ts.CallExpression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  let factory: ts.Expression = call.expression
  if (ts.isCallExpression(factory)) factory = factory.expression
  const chain = dottedChain(factory)
  if (chain === undefined) return undefined
  const isDescribe =
    chain.root === 'describe' ||
    chain.root === 'suite' ||
    (TEST_ROOTS.has(chain.root) && chain.mods[0] === 'describe')
  return isDescribe ? functionArgument(call) : undefined
}

/**
 * The scope a test runs in, from the statements around it: clean when every statement is setup, constructed when
 * one of them builds something. Tests, describes and after-hooks are not statements of the setup; a before-hook's
 * body is.
 */
function scopeOf(items: Array<ts.Statement | ts.Expression>, parent: Scope, ctx: Ctx): Scope {
  let { clean, constructed } = parent
  const judge = (list: Array<ts.Statement | ts.Expression>): void => {
    for (const item of list) {
      const call = callOf(item)
      if (call !== undefined) {
        const hook = hookName(call)
        if (
          testSite(call) !== undefined ||
          describeBody(call) !== undefined ||
          (hook !== undefined && AFTER_HOOKS.has(hook))
        )
          continue
        if (hook !== undefined && BEFORE_HOOKS.has(hook)) {
          const fn = functionArgument(call)
          if (fn !== undefined) judge(bodyItems(fn))
          continue
        }
      }
      if (!isSetupStatement(item, ctx)) clean = false
      if (constructs(item)) constructed = true
    }
  }
  judge(items)
  return { clean, constructed }
}

function testName(call: ts.CallExpression): string {
  const title = call.arguments[0]
  return title !== undefined && ts.isStringLiteralLike(title) ? title.text : '(unnamed)'
}

function keyOf(fn: ts.Node, sourceFile: ts.SourceFile): string {
  return fn.getText(sourceFile).replace(/\s+/g, ' ').trim()
}

type Assertion = { call: ts.CallExpression; weight: Weight; label: string }

/** A subject read and a literal expectation: `expect(store.getState().items).toHaveLength(0)`. */
function isLiteralCompare(assertion: Assertion, ctx: Ctx): boolean {
  const subject = expectSubject(assertion.call)
  return (
    subject !== undefined &&
    !ts.isArrowFunction(subject) &&
    !ts.isFunctionExpression(subject) &&
    isRead(subject, ctx) &&
    assertion.call.arguments.every(isLiteral)
  )
}

/**
 * A call made for its effect, its value unused: an assertion helper (`present(el)`). A helper whose value the test
 * goes on to use (`const out = await devOutput()`) arranges, and its assertions are preconditions, not the test's.
 */
function isDiscarded(call: ts.CallExpression): boolean {
  let node: ts.Node = call
  while (ts.isAwaitExpression(node.parent) || ts.isParenthesizedExpression(node.parent)) {
    node = node.parent
  }
  return (
    ts.isExpressionStatement(node.parent) ||
    (ts.isArrowFunction(node.parent) && node.parent.body === node)
  )
}

function judgeTest(
  call: ts.CallExpression,
  site: TestSite,
  scope: Scope,
  sourceFile: ts.SourceFile,
  ctx: Ctx,
): RefusedTest | undefined {
  const fn = functionArgument(call)
  if (fn === undefined || site.skipped || site.property) return undefined
  const assertions: Assertion[] = []
  let property = false
  let acted = false
  const followed = new Set<ts.Node>()
  const collect = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (isFcAssert(node) && !overConstantsOnly(node)) property = true
      const matcher = matcherOf(node)
      if (matcher !== undefined) {
        const weighed = weigh(node, matcher, ctx)
        const weight = weighed === 'gone' ? (acted ? 'outcome' : 'presence') : weighed
        if (weight !== undefined) {
          const negated = (expectRoot(node)?.modifiers ?? []).includes('not')
          assertions.push({ call: node, weight, label: `${negated ? 'not.' : ''}${matcher}` })
        }
      }
      const callee = peel(node.expression)
      const helper =
        ts.isIdentifier(callee) && isDiscarded(node) ? ctx.helpers.get(callee.text) : undefined
      if (helper?.body !== undefined && !followed.has(helper)) {
        followed.add(helper)
        collect(helper.body)
      }
    }
    ts.forEachChild(node, collect)
  }
  for (const item of bodyItems(fn)) {
    collect(item)
    if (!isSetupStatement(item, ctx)) acted = true
  }
  if (property || assertions.length === 0) return undefined
  const found = {
    name: testName(call),
    line: sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line + 1,
    matchers: assertions.map((a) => a.label),
    key: keyOf(fn, sourceFile),
  }
  if (assertions.every((a) => a.weight !== 'outcome')) {
    return { ...found, kind: assertions.some((a) => a.weight === 'mock') ? 'R2' : 'R1' }
  }
  const local = scopeOf(bodyItems(fn), scope, ctx)
  if (local.clean && local.constructed && assertions.every((a) => isLiteralCompare(a, ctx))) {
    return { ...found, kind: 'R3' }
  }
  return undefined
}

/**
 * The tests of a file that have a refused shape (R1, R2, R3 in the header), each with the matchers it used and the
 * key of its body. A skipped test, a property test and a test with no assertion, its own or in a function of the file
 * it calls, are not judged.
 */
export function refusedTests(source: string, path: string): RefusedTest[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const ctx = contextOf(sourceFile)
  const refused: RefusedTest[] = []
  const walk = (node: ts.Node, scope: Scope): void => {
    if (ts.isCallExpression(node)) {
      const site = testSite(node)
      if (site !== undefined) {
        const verdict = judgeTest(node, site, scope, sourceFile, ctx)
        if (verdict !== undefined) refused.push(verdict)
        return
      }
      const body = describeBody(node)
      if (body !== undefined) {
        const inner = scopeOf(bodyItems(body), scope, ctx)
        ts.forEachChild(body.body, (child) => walk(child, inner))
        return
      }
    }
    ts.forEachChild(node, (child) => walk(child, scope))
  }
  walk(sourceFile, scopeOf([...sourceFile.statements], { clean: true, constructed: false }, ctx))
  return refused
}

/** The body keys of every test in a file, for telling a rewritten test from one left as it was. */
export function testKeys(source: string, path: string): string[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const keys: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && testSite(node) !== undefined) {
      const fn = functionArgument(node)
      if (fn !== undefined) keys.push(keyOf(fn, sourceFile))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return keys
}

/** The violation line for a refused test: the test, its kind and matchers, and what an outcome assertion looks like. */
export function refusalMessage(path: string, test: RefusedTest): string {
  return `${path}: test "${test.name}" (line ${test.line}): ${test.kind} ${KIND_NAMES[test.kind]} (${test.matchers.join(', ')}): ${KIND_HINTS[test.kind]}`
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

/** `--guard`: the refused shapes over the given files, each test judged as if it were new, with a count per kind. */
function guardReport(root: string, paths: string[], json: boolean): void {
  const refused: Array<RefusedTest & { path: string }> = []
  const counts: Record<RefusedKind, number> = { R1: 0, R2: 0, R3: 0 }
  let tests = 0
  let files = 0
  for (const path of new Set(paths)) {
    const absolute = resolve(root, path)
    if (!existsSync(absolute)) continue
    const source = readFileSync(absolute, 'utf8')
    const rel = relative(root, absolute)
    files += 1
    tests += classifySource(source, rel).tests
    for (const test of refusedTests(source, rel)) {
      refused.push({ path: rel, ...test })
      counts[test.kind] += 1
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify({ counts, tests, files, refused })}\n`)
    return
  }
  for (const test of refused) process.stdout.write(`${refusalMessage(test.path, test)}\n`)
  process.stdout.write(
    `refused: R1 ${counts.R1}, R2 ${counts.R2}, R3 ${counts.R3}; ${refused.length} of ${tests} test(s) in ${files} file(s), each judged as if new\n`,
  )
}

function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      include: { type: 'string', multiple: true, default: [] },
      guard: { type: 'boolean', default: false },
    },
  })
  const root = repoRoot()
  const base = positionals.length > 0 ? positionals : trackedTestFiles(root)
  if (values.guard) {
    guardReport(root, base, values.json)
    return
  }
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
