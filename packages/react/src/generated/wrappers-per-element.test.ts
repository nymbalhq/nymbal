import fc from 'fast-check'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as wc from '@nymbalhq/web-components'
import type { ElementSchema } from '@nymbalhq/web-components'
import { generateWrappers } from '../../scripts/generate-wrappers.js'

// AC-5: the generated wrappers import each element's own subpath, `@nymbalhq/web-components/elements/<tag>`, and
// never the package root at runtime, so a route that renders one wrapper bundles one element.

const SCHEMAS: ElementSchema[] = Object.values(wc as Record<string, unknown>)
  .map((v) => (v as { schema?: ElementSchema } | null)?.schema)
  .filter((s): s is ElementSchema => s !== undefined)

/** The module specifiers a source loads at runtime: type-only imports and exports are left out, as the compiler drops them. */
function runtimeImports(source: string): string[] {
  const file = ts.createSourceFile(
    'wrappers.tsx',
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  )
  const specifiers: string[] = []
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
      specifiers.push((statement.moduleSpecifier as ts.StringLiteral).text)
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
      specifiers.push((statement.moduleSpecifier as ts.StringLiteral).text)
    }
  }
  return specifiers
}

const fromElements = (specifiers: string[]): string[] =>
  specifiers
    .filter((s) => s === '@nymbalhq/web-components' || s.startsWith('@nymbalhq/web-components/'))
    .sort()

describe('AC-5: the wrappers import per-element subpaths', () => {
  it('AC-5: for any set of element schemas, the wrappers import exactly those elements’ subpaths and never the package root', () => {
    expect(SCHEMAS.length).toBeGreaterThan(1)
    fc.assert(
      fc.property(fc.subarray(SCHEMAS, { minLength: 1 }), (schemas) => {
        const imported = fromElements(runtimeImports(generateWrappers(schemas)))
        expect(imported).toEqual(
          schemas.map((s) => `@nymbalhq/web-components/elements/${s.tag}`).sort(),
        )
      }),
      { numRuns: 50 },
    )
  })
})
