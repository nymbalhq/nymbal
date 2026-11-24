// Reads: apps/admin/src/**, packages/types/src/domain/currency.ts
import { globSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { CURRENCY_MINOR_UNITS } from '../../packages/types/src/domain/currency'
import { REPO_ROOT } from './workspace-manifests'

// The admin learns the store's currency from the session answer and from each order's or payment's own; a currency
// code written into an admin source file is a page formatting money in a currency the store may not sell in.

const ADMIN_SRC = join(REPO_ROOT, 'apps', 'admin', 'src')
const TESTS_DIR = join(ADMIN_SRC, 'tests')
const SOURCE = /\.tsx?$/
const TEST_FILE = /\.test\.tsx?$/
const CODES = new Set(Object.keys(CURRENCY_MINOR_UNITS))

function adminSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (path !== TESTS_DIR && entry.name !== 'node_modules') out.push(...adminSources(path))
    } else if (
      SOURCE.test(entry.name) &&
      !TEST_FILE.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(path)
    }
  }
  return out
}

/** Each string literal or no-substitution template in `text` that is an ISO 4217 code, as `<line>: <code>`. */
function currencyLiterals(name: string, text: string): string[] {
  const kind = name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, kind)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      CODES.has(node.text)
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
      found.push(`${line}: ${node.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('the admin’s store currency has one source', () => {
  it('AC-8: no admin source file outside tests holds a string literal equal to an ISO 4217 code; comments and JSX text are not literals', () => {
    const sample = [
      "// formatMoney(1234, 'GBP') -> '£12.34'",
      '/** toMoneyInput(1999, `JPY`) */',
      "const a = 'USD'",
      'const b = `KWD`',
      "const c = 'all'",
      'const d = <p>EUR</p>',
    ].join('\n')
    expect(currencyLiterals('sample.tsx', sample), 'the reader on a sample').toEqual([
      '3: USD',
      '4: KWD',
    ])

    const files = adminSources(ADMIN_SRC)
    const scanned = files.map((path) => relative(ADMIN_SRC, path))
    expect(
      ['pages/ProductEditPage.tsx', 'lib/money.ts', 'hooks/useMe.ts'].filter(
        (file) => !scanned.includes(file),
      ),
      'files the scan must reach',
    ).toEqual([])
    expect(scanned.filter((file) => file.startsWith('tests/') || TEST_FILE.test(file))).toEqual([])
    const everySource = globSync('**/*.{ts,tsx}', { cwd: ADMIN_SRC })
    const outOfScope = everySource.filter(
      (file) => file.startsWith('tests/') || TEST_FILE.test(file) || file.endsWith('.d.ts'),
    )
    expect(scanned.length, 'every admin source but tests is scanned').toBe(
      everySource.length - outOfScope.length,
    )

    const offending = files.flatMap((path) =>
      currencyLiterals(path, readFileSync(path, 'utf8')).map(
        (hit) => `${relative(REPO_ROOT, path)}:${hit}`,
      ),
    )

    expect(offending).toEqual([])
  })
})
