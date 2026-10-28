// Reads: **/*.test.*, **/*.spec.*
import { describe, expect, it } from 'vitest'
import { trackedFiles } from './workspace-manifests'

// AC-1: no tracked compiled test file (`*.test.js`, `*.spec.js`, their `.d.ts` and source maps) sits beside a tracked
// TypeScript source of the same stem. A stale emit runs, or is read, beside the test it was compiled from. Non-test
// `tsc` emits are out of scope.

/** `<dir>/<name>.test.js`, `.test.d.ts`, `.test.js.map`, `.test.d.ts.map` (and `.spec.*`); group 1 is the stem. */
const COMPILED_TEST = /^(.*\.(?:test|spec))\.(?:[cm]?js|d\.[cm]?ts)(?:\.map)?$/
const TS_TEST = /\.(?:test|spec)\.[cm]?tsx?$/
const SOURCE_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts']

function compiledTestDuplicates(files: readonly string[]): string[] {
  const tracked = new Set(files)
  return files.filter((file) => {
    const m = COMPILED_TEST.exec(file)
    return m !== null && SOURCE_EXTENSIONS.some((ext) => tracked.has(`${m[1]}.${ext}`))
  })
}

describe('AC-1: no tracked compiled test duplicates', () => {
  const tracked = trackedFiles()

  it('AC-1: no tracked *.test.js / *.spec.js (or its .d.ts / .map) has a tracked .ts sibling of the same stem', () => {
    // The scan is not vacuous: it sees the repository's TypeScript tests.
    expect(tracked.filter((f) => TS_TEST.test(f)).length).toBeGreaterThan(10)
    // The detector names every emit kind beside its source, and nothing without one.
    const sample = [
      'a/x.test.ts',
      'a/x.test.js',
      'a/x.test.js.map',
      'a/x.test.d.ts',
      'a/x.test.d.ts.map',
      'b/y.spec.tsx',
      'b/y.spec.js',
      'c/plain.test.js',
      'd/z.config.js',
      'd/z.config.ts',
    ]
    expect(compiledTestDuplicates(sample)).toEqual([
      'a/x.test.js',
      'a/x.test.js.map',
      'a/x.test.d.ts',
      'a/x.test.d.ts.map',
      'b/y.spec.js',
    ])
    expect(compiledTestDuplicates(tracked)).toEqual([])
  })
})
