// Reads: apps/admin/src/**, apps/admin/package.json, packages/types/src/**
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './workspace-manifests'

// AC-14: every type the admin shares with the kernel comes from @nymbalhq/types. No type, interface, enum, class or
// const declared at the top level of a module under apps/admin/src takes the name of an export of @nymbalhq/types;
// the export list is read from packages/types/src with the TypeScript checker (types and values), so a new shared
// export is covered without editing this test.

const TYPES_INDEX = join(REPO_ROOT, 'packages/types/src/index.ts')
const ADMIN_SRC = join(REPO_ROOT, 'apps/admin/src')
const ADMIN_MANIFEST = join(REPO_ROOT, 'apps/admin/package.json')

function sharedExports(): Set<string> {
  const program = ts.createProgram([TYPES_INDEX], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(TYPES_INDEX)
  const moduleSymbol = source && checker.getSymbolAtLocation(source)
  if (!moduleSymbol) throw new Error(`no module symbol for ${TYPES_INDEX}`)
  return new Set(checker.getExportsOfModule(moduleSymbol).map((s) => s.getName()))
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : []
  })
}

interface Declaration {
  name: string
  kind: string
  at: string
}

/** Top-level type, interface, enum, class and variable declarations of one module. */
function declarations(file: string): Declaration[] {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2022,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const at = (node: ts.Node) =>
    `${relative(REPO_ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
  const found: Declaration[] = []
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement))
      found.push({ name: statement.name.text, kind: 'interface', at: at(statement) })
    else if (ts.isTypeAliasDeclaration(statement))
      found.push({ name: statement.name.text, kind: 'type', at: at(statement) })
    else if (ts.isEnumDeclaration(statement))
      found.push({ name: statement.name.text, kind: 'enum', at: at(statement) })
    else if (ts.isClassDeclaration(statement) && statement.name)
      found.push({ name: statement.name.text, kind: 'class', at: at(statement) })
    else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name))
          found.push({ name: decl.name.text, kind: 'const', at: at(decl) })
      }
    }
  }
  return found
}

function importsSharedTypes(file: string): boolean {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ES2022,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  return source.statements.some(
    (s) =>
      (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) &&
      s.moduleSpecifier !== undefined &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      (s.moduleSpecifier.text === '@nymbalhq/types' ||
        s.moduleSpecifier.text.startsWith('@nymbalhq/types/')),
  )
}

describe('AC-14: the admin declares no shared type of its own', () => {
  const shared = sharedExports()
  const files = sourceFiles(ADMIN_SRC)
  const declared = files.flatMap(declarations)

  it('AC-14: no top-level type, interface, enum, class or const under apps/admin/src has the name of an export of @nymbalhq/types (export list read from packages/types/src)', () => {
    // The export list must hold the shared names, or the check below would pass vacuously.
    expect(shared.size).toBeGreaterThan(50)
    for (const name of [
      'Order',
      'Address',
      'OrderStatus',
      'ORDER_STATUS_TRANSITIONS',
      'StockStatus',
      'STANDARD_EVENT_TYPES',
    ]) {
      expect(shared.has(name), name).toBe(true)
    }
    expect(declared.length).toBeGreaterThan(0)
    const duplicates = declared
      .filter((d) => shared.has(d.name))
      .map((d) => `${d.kind} ${d.name} (${d.at})`)
    expect(duplicates).toEqual([])
  })

  it('AC-14: InventoryStatus is gone in favour of StockStatus, and the admin imports from @nymbalhq/types, a dependency in its manifest', () => {
    expect(declared.filter((d) => d.name === 'InventoryStatus').map((d) => d.at)).toEqual([])
    const importers = files.filter(importsSharedTypes)
    expect(importers.length).toBeGreaterThan(0)
    const manifest = JSON.parse(readFileSync(ADMIN_MANIFEST, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(
      manifest.devDependencies?.['@nymbalhq/types'] ?? manifest.dependencies?.['@nymbalhq/types'],
    ).toBeDefined()
  })
})
