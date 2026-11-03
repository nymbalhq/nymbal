// Reads: packages/**
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './workspace-manifests'

// A signature checked with `===` or `!==` leaks, by its timing, how much of a forged one is right. Every non-test
// source file under packages/ that computes an HMAC imports `timingSafeEqual` from node:crypto and calls it.

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'tests', '__tests__', 'fixtures'])
const SOURCE = /\.(?:[cm]?ts|tsx)$/
const NOT_SOURCE = /\.(?:test|spec)\.[cm]?tsx?$|\.d\.ts$|\.test-d\.ts$/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(join(dir, entry.name)))
    } else if (SOURCE.test(entry.name) && !NOT_SOURCE.test(entry.name)) {
      out.push(join(dir, entry.name))
    }
  }
  return out
}

interface CryptoUse {
  callsHmac: boolean
  importsTimingSafeEqual: boolean
  callsTimingSafeEqual: boolean
}

/** What a file does with node:crypto: an HMAC call, and whether it imports and calls `timingSafeEqual`. */
function cryptoUse(path: string): CryptoUse {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const use: CryptoUse = {
    callsHmac: false,
    importsTimingSafeEqual: false,
    callsTimingSafeEqual: false,
  }
  const namespaces = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      ['node:crypto', 'crypto'].includes(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings
      if (node.importClause?.name) namespaces.add(node.importClause.name.text)
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if ((el.propertyName ?? el.name).text === 'timingSafeEqual')
            use.importsTimingSafeEqual = true
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined
      if (name === 'createHmac') use.callsHmac = true
      if (name === 'timingSafeEqual') {
        use.callsTimingSafeEqual = true
        if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          namespaces.has(callee.expression.text)
        ) {
          use.importsTimingSafeEqual = true
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return use
}

describe('AC-19: every HMAC check is constant time', () => {
  it('AC-19: every non-test source file under packages/ that calls createHmac imports and calls timingSafeEqual', () => {
    const hmacFiles = sourceFiles(join(REPO_ROOT, 'packages'))
      .map((path) => ({ file: relative(REPO_ROOT, path), use: cryptoUse(path) }))
      .filter((f) => f.use.callsHmac)

    expect(hmacFiles.map((f) => f.file)).toContain('packages/platform/src/routes/events-sse.ts')
    expect(
      hmacFiles.map((f) => [f.file, f.use.importsTimingSafeEqual && f.use.callsTimingSafeEqual]),
    ).toEqual(hmacFiles.map((f) => [f.file, true]))
  })
})
