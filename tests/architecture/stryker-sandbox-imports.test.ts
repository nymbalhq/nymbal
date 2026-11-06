// Reads: stryker.config.mjs, vitest.stryker.config.ts, packages/platform/src/**/*.test.ts
import { globSync, readFileSync } from 'node:fs'
import { join, matchesGlob, posix, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import strykerVitest from '../../vitest.stryker.config'
import { REPO_ROOT } from './workspace-manifests'

// Stryker copies only part of the checkout into its sandbox (stryker.config.mjs `ignorePatterns`). A unit test next to
// the code it mutates that imports a file left out of the sandbox fails to load there, so its mutants read as not
// covered and it kills none, while the same test passes in `pnpm test`. Such a test belongs in tests/integration.

type Config = { mutate: string[]; ignorePatterns: string[] }

/** The directories under packages/platform the sandbox leaves out: the plain (not negated, not glob) patterns there. */
function sandboxExcludedDirs(config: Config): string[] {
  return config.ignorePatterns
    .filter((p) => p.startsWith('/packages/platform/') && !/[*?[!]/.test(p))
    .map((p) => p.slice(1))
}

/** Whether a test file sits in the mutate set: its path, or the source it is named for, matches a mutate glob. */
function testsMutatedCode(file: string, config: Config): boolean {
  const globs = config.mutate.filter((g) => !g.startsWith('!'))
  const source = file.replace(/\.test\.ts$/, '.ts')
  return globs.some((g) => matchesGlob(file, g) || matchesGlob(source, g))
}

/** The relative imports of a test file (static, dynamic and re-exports) that resolve into a directory left out. */
function importsOutOfSandbox(file: string, source: string, excluded: string[]): string[] {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.map((ref) => ref.fileName)
    .filter((spec) => spec.startsWith('.'))
    .filter((spec) => {
      const target = posix.normalize(posix.join(posix.dirname(file), spec))
      return excluded.some((dir) => target === dir || target.startsWith(`${dir}/`))
    })
}

/** stryker.config.mjs, loaded by URL: it is plain JavaScript with no declaration file. */
const loadConfig = async (): Promise<Config> =>
  ((await import(pathToFileURL(join(REPO_ROOT, 'stryker.config.mjs')).href)) as { default: Config })
    .default

const included = strykerVitest.test?.include ?? []

function offenders(config: Config, files: string[], read: (file: string) => string): string[] {
  const excluded = sandboxExcludedDirs(config)
  return files
    .filter((file) => testsMutatedCode(file, config))
    .flatMap((file) =>
      importsOutOfSandbox(file, read(file), excluded).map((spec) => `${file} imports ${spec}`),
    )
}

describe('the unit tests Stryker runs load in its sandbox', () => {
  it('the sandbox leaves out packages/platform/tests, and a services test that imports tests/support is refused while one that imports its service is not', async () => {
    const config = await loadConfig()
    expect(sandboxExcludedDirs(config)).toContain('packages/platform/tests')
    const sources: Record<string, string> = {
      'packages/platform/src/services/planted.test.ts': [
        "import { createKernel } from '../../tests/support/kernel.js'",
        "import { createCartService } from './cart-service.js'",
        "const later = () => import('../../tests/support/money.js')",
      ].join('\n'),
      'packages/platform/src/events/relay.test.ts':
        "export { x } from '../../tests/support/outbox.js'",
      'packages/platform/src/routes/planted.test.ts':
        "import { createKernel } from '../../tests/support/kernel.js'",
      'packages/platform/src/repositories/planted.test.ts': "import { db } from '../db/index.js'",
    }
    expect(offenders(config, Object.keys(sources), (file) => sources[file] ?? '')).toEqual([
      'packages/platform/src/services/planted.test.ts imports ../../tests/support/kernel.js',
      'packages/platform/src/services/planted.test.ts imports ../../tests/support/money.js',
      'packages/platform/src/events/relay.test.ts imports ../../tests/support/outbox.js',
    ])
  })

  it('no test under the mutate set imports a file the sandbox leaves out', async () => {
    const config = await loadConfig()
    const files = included.flatMap((glob) =>
      globSync(glob, { cwd: REPO_ROOT }).map((file) => file.split(sep).join('/')),
    )
    // The scan reaches the tests beside the mutated code, so an empty result is not an empty scan.
    expect(files.filter((file) => testsMutatedCode(file, config)).length).toBeGreaterThan(0)
    expect(offenders(config, files, (file) => readFileSync(join(REPO_ROOT, file), 'utf8'))).toEqual(
      [],
    )
  })
})
