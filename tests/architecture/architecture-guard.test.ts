import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Architecture guard.
 *
 * Core platform packages must stay framework-agnostic. The CQRS kernel,
 * the SDK, the shared types, config, and the HTTP abstraction are consumed
 * by BOTH the Astro and Next.js templates (and the admin SPA). If any of
 * them imported a rendering framework, that framework would leak into the
 * other template's build, break the "every adapter is swappable" promise,
 * and couple the kernel to a single UI runtime.
 *
 * This test walks the source of those packages and fails if it finds an
 * import of any rendering framework. It deliberately uses only node:fs /
 * node:path so it has no runtime dependency on the packages it guards.
 */

// Resolve the repo root from this file's location: tests/architecture -> repo root.
const REPO_ROOT = resolve(__dirname, '..', '..')

// Packages whose source must never depend on a rendering framework.
const GUARDED_PACKAGES = ['platform', 'sdk', 'types', 'config', 'http'] as const

// Rendering frameworks (and their renderers/runtimes) that must not appear.
const FORBIDDEN_FRAMEWORKS = [
  'react',
  'react-dom',
  'astro',
  'vue',
  'solid-js',
  'svelte',
  'preact',
  'lit',
  '@astrojs',
] as const

interface Offender {
  file: string
  line: number
  specifier: string
}

/** Recursively collect scannable source files under a directory. */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    // Directory does not exist (e.g. a package without src yet). Nothing to scan.
    return files
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const stats = statSync(fullPath)
    if (stats.isDirectory()) {
      if (entry === 'dist' || entry === 'node_modules') continue
      files.push(...collectSourceFiles(fullPath))
      continue
    }
    if (!stats.isFile()) continue
    if (entry.endsWith('.d.ts')) continue
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
      files.push(fullPath)
    }
  }
  return files
}

/**
 * Decide whether an imported module specifier targets a forbidden framework.
 * A specifier matches only when it equals a framework name exactly or starts
 * with that name followed by a "/". This catches "astro/config" and
 * "react-dom/client" while leaving "astrolib" and "reactive-x" alone.
 */
function matchedFramework(specifier: string): string | null {
  for (const framework of FORBIDDEN_FRAMEWORKS) {
    if (specifier === framework || specifier.startsWith(`${framework}/`)) {
      return framework
    }
  }
  return null
}

// Patterns that capture the module specifier from each import form.
// Static imports + side-effect imports: `import ... from '<spec>'` / `import '<spec>'`.
const STATIC_IMPORT_RE = /\bimport\b[^'"`]*?from\s*['"`]([^'"`]+)['"`]/g
const SIDE_EFFECT_IMPORT_RE = /\bimport\s*['"`]([^'"`]+)['"`]/g
// Re-exports: `export ... from '<spec>'`.
const EXPORT_FROM_RE = /\bexport\b[^'"`]*?from\s*['"`]([^'"`]+)['"`]/g
// Dynamic import(): `import('<spec>')`.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g
// CommonJS require(): `require('<spec>')`.
const REQUIRE_RE = /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g

const SPECIFIER_PATTERNS = [
  STATIC_IMPORT_RE,
  SIDE_EFFECT_IMPORT_RE,
  EXPORT_FROM_RE,
  DYNAMIC_IMPORT_RE,
  REQUIRE_RE,
]

/** Extract every module specifier referenced on a single source line. */
function specifiersInLine(line: string): string[] {
  return specifiersWithLines(line).map((s) => s.specifier)
}

/**
 * Extract every module specifier in a source string together with the 1-based
 * line it starts on. Scans the WHOLE content (not line-by-line) so multi-line
 * imports — e.g. `import {\n  foo,\n} from 'react'`, which are extremely common
 * — are caught. The negated character classes in the patterns already span
 * newlines. Erring toward over-matching is the safe direction for a guard: a
 * false positive fails loudly and gets investigated, whereas a missed framework
 * import would let a rendering runtime leak into the kernel silently.
 */
function specifiersWithLines(content: string): { specifier: string; line: number }[] {
  const results: { specifier: string; line: number }[] = []
  const seen = new Set<string>()
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      const specifier = match[1]
      if (specifier === undefined) continue
      // Line number = 1 + number of newlines before the match start.
      const line = content.slice(0, match.index).split('\n').length
      const key = `${specifier}@${line}`
      if (seen.has(key)) continue
      seen.add(key)
      results.push({ specifier, line })
    }
  }
  return results
}

function scanFile(file: string): Offender[] {
  const offenders: Offender[] = []
  const content = readFileSync(file, 'utf8')
  for (const { specifier, line } of specifiersWithLines(content)) {
    const framework = matchedFramework(specifier)
    if (framework) {
      offenders.push({
        file: file.replace(`${REPO_ROOT}/`, ''),
        line,
        specifier,
      })
    }
  }
  return offenders
}

describe('architecture guard: core packages stay framework-agnostic', () => {
  it('imports no rendering framework anywhere in guarded package source', () => {
    const offenders: Offender[] = []
    let scannedFiles = 0

    for (const pkg of GUARDED_PACKAGES) {
      const srcDir = join(REPO_ROOT, 'packages', pkg, 'src')
      const files = collectSourceFiles(srcDir)
      scannedFiles += files.length
      for (const file of files) {
        offenders.push(...scanFile(file))
      }
    }

    // Guard the guard: if we scanned nothing, the walk is broken and the test
    // would pass vacuously. Fail loudly instead.
    expect(scannedFiles).toBeGreaterThan(0)

    const report = offenders
      .map((o) => `  ${o.file}:${o.line} -> ${o.specifier}`)
      .join('\n')

    expect(
      offenders,
      offenders.length > 0
        ? `Core packages must not import rendering frameworks. Offenders:\n${report}`
        : '',
    ).toEqual([])
  })

  it('matchedFramework distinguishes frameworks from look-alike packages', () => {
    // Exact and subpath specifiers are caught.
    expect(matchedFramework('react')).toBe('react')
    expect(matchedFramework('react-dom/client')).toBe('react-dom')
    expect(matchedFramework('astro/config')).toBe('astro')
    expect(matchedFramework('@astrojs/node')).toBe('@astrojs')
    expect(matchedFramework('lit')).toBe('lit')
    // Look-alike packages are NOT caught.
    expect(matchedFramework('astrolib')).toBeNull()
    expect(matchedFramework('reactive-x')).toBeNull()
    expect(matchedFramework('preactive')).toBeNull()
    expect(matchedFramework('@astrojsx/thing')).toBeNull()
    expect(matchedFramework('@nymbal/types')).toBeNull()
  })

  it('specifiersInLine extracts specifiers from every import form', () => {
    expect(specifiersInLine(`import { foo } from 'react'`)).toContain('react')
    expect(specifiersInLine(`import 'lit'`)).toContain('lit')
    expect(specifiersInLine(`export { x } from 'vue'`)).toContain('vue')
    expect(specifiersInLine(`const m = await import('solid-js')`)).toContain('solid-js')
    expect(specifiersInLine(`const r = require('preact')`)).toContain('preact')
  })

  it('catches multi-line imports and reports the line the import starts on', () => {
    // A wrapped import — the dominant React import style — must not slip past
    // the guard. A line-by-line scanner would miss this because no single line
    // contains both `import` and `from '<spec>'`.
    const src = [
      `import { createApp } from '@nymbal/platform'`, // line 1
      `import {`, //                                     line 2 (import starts here)
      `  useState,`, //                                  line 3
      `  useEffect,`, //                                 line 4
      `} from 'react'`, //                               line 5
      ``, //                                             line 6
      `const x = 1`, //                                  line 7
    ].join('\n')
    const found = specifiersWithLines(src)
    const react = found.find((f) => f.specifier === 'react')
    expect(react, 'multi-line react import must be detected').toBeDefined()
    expect(react?.line).toBe(2)
    // The non-framework specifier is still captured and not flagged.
    expect(found.some((f) => f.specifier === '@nymbal/platform')).toBe(true)
    expect(matchedFramework('@nymbal/platform')).toBeNull()
  })
})
