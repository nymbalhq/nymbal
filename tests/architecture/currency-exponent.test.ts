// Reads: packages/*/src/**, packages/adapters/*/*/src/**, apps/*/src/**
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './workspace-manifests'

// A currency's minor-unit digits come from one table in @nymbalhq/types. A copy of the runtime's rule (Intl's
// `resolvedOptions().maximumFractionDigits`) lets two surfaces print different digits for one amount: ICU's are not
// ISO 4217's, and a browser's ICU is not Node's.

const ICU_DIGITS = /resolvedOptions\(\)\s*\.maximumFractionDigits/
const SOURCE = /\.tsx?$/
const TEST_FILE = /\.test\.tsx?$/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage'])

/** The source roots: every package's, every adapter's and every app's `src`. */
function sourceRoots(): string[] {
  const under = (dir: string, depth: number): string[] => {
    if (depth === 0) return [dir]
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .flatMap((e) => under(join(dir, e.name), depth - 1))
  }
  return [
    ...under(join(REPO_ROOT, 'packages'), 1),
    ...under(join(REPO_ROOT, 'packages', 'adapters'), 2),
    ...under(join(REPO_ROOT, 'apps'), 1),
  ]
    .map((dir) => join(dir, 'src'))
    .filter((dir) => existsSync(dir))
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        out.push(...sourceFiles(join(dir, entry.name)))
      }
    } else if (
      SOURCE.test(entry.name) &&
      !TEST_FILE.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

/** The names a file imports as values (not `import type`, not `type X`) from `@nymbalhq/types`. */
function valueImportsFromTypes(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const names: string[] = []
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.moduleSpecifier.text !== '@nymbalhq/types') continue
    const clause = statement.importClause
    if (clause === undefined || clause.isTypeOnly) continue
    const bindings = clause.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text)
    }
  }
  return names
}

const READERS = [
  'packages/platform/src/money.ts',
  'packages/platform/src/assistant/golden.ts',
  'packages/importers/src/woocommerce/mappers/money.ts',
  'packages/adapters/shipping/easypost/src/easypost-adapter.ts',
  'apps/admin/src/lib/money.ts',
]

describe('one currency-exponent rule', () => {
  it('AC-5: no source file under packages, adapters or apps reads digits from Intl’s resolvedOptions().maximumFractionDigits', () => {
    const files = sourceRoots().flatMap(sourceFiles)
    const scanned = files.map((path) => relative(REPO_ROOT, path))

    expect(READERS.filter((reader) => !scanned.includes(reader))).toEqual([])
    expect(
      files
        .filter((path) => ICU_DIGITS.test(readFileSync(path, 'utf8')))
        .map((path) => relative(REPO_ROOT, path))
        .sort(),
    ).toEqual([])
  })

  it('AC-5: the kernel’s money, the assistant golden, the importer, EasyPost and the admin each import currencyExponent or CURRENCY_MINOR_UNITS from @nymbalhq/types', () => {
    const reading = READERS.map((reader) => [
      reader,
      valueImportsFromTypes(join(REPO_ROOT, reader)).some(
        (name) => name === 'currencyExponent' || name === 'CURRENCY_MINOR_UNITS',
      ),
    ])

    expect(reading).toEqual(READERS.map((reader) => [reader, true]))
  })
})
