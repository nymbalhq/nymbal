import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './workspace-manifests'

// AC-5 (the architecture check): <nymbal-variant-selector> takes `VariantOption[]` only, so its source holds no
// `JSON.parse`. Read from the AST, so a comment or a string that names JSON.parse is not counted, and `JSON['parse']`
// or an alias (`const parse = JSON.parse`) is.

const VARIANT_SELECTOR = join(
  REPO_ROOT,
  'packages/web-components/src/components/variant-selector.ts',
)

/** Every reference to JSON.parse in a module: called, aliased, or reached by an element access. */
function jsonParseReferences(source: string): string[] {
  const file = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const isJson = (e: ts.Expression) => ts.isIdentifier(e) && e.text === 'JSON'
    if (
      ts.isPropertyAccessExpression(node) &&
      isJson(node.expression) &&
      node.name.text === 'parse'
    ) {
      found.push(node.getText(file))
    }
    if (
      ts.isElementAccessExpression(node) &&
      isJson(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'parse'
    ) {
      found.push(node.getText(file))
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

describe('the variant selector parses no JSON', () => {
  it('AC-5: variant-selector.ts holds no JSON.parse', () => {
    // The scanner sees each spelling and skips text that only names it, so an empty answer below is not a blind one.
    const control = `JSON.parse(a); JSON['parse'](b); const p = JSON.parse; // JSON.parse(c)\nconst s = 'JSON.parse(d)'`
    expect(jsonParseReferences(control).length).toBeGreaterThan(2)
    expect(jsonParseReferences(control).length).toBeLessThan(4)

    expect(jsonParseReferences(readFileSync(VARIANT_SELECTOR, 'utf8'))).toEqual([])
  })
})
