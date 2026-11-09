// Reads: packages/web-components/**
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './workspace-manifests'

// The script a theme loads from a CDN, as the package's build writes it: one file a browser can run on its own. Reads
// the built package, so it skips when there is no build at all; a build whose kit step did not run still fails here.

const DIST = join(REPO_ROOT, 'packages/web-components/dist')
const KIT = join(DIST, 'kit.js')
const INDEX = join(DIST, 'index.js')
const REGISTER = join(DIST, 'register-components.js')
const GZIP_BUDGET_BYTES = 25_000

/** The module syntax in a source: every import or export statement, and every dynamic import() call. */
function moduleSyntax(code: string): string[] {
  const source = ts.createSourceFile('kit.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const isExported =
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true
    if (
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node) ||
      isExported ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      found.push(node.getText(source).slice(0, 120))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe.skipIf(!existsSync(INDEX))('the bundle a theme loads', () => {
  it('AC-14: dist/kit.js exists beside the package’s entries, has no import or export of any kind, and is at most 25,000 bytes gzipped', () => {
    expect(existsSync(KIT), `${KIT} was not built`).toBe(true)
    const code = readFileSync(KIT, 'utf8')

    expect(moduleSyntax(code)).toEqual([])
    expect(gzipSync(code).length).toBeLessThanOrEqual(GZIP_BUDGET_BYTES)
    expect(
      [INDEX, REGISTER].filter((path) => !existsSync(path)),
      'the kit’s build removed the package’s other entries',
    ).toEqual([])
  })
})
