// Reads: packages/sdk/**
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './workspace-manifests'

// AC-4: Astro `/`'s client (the core with `ns/cart`, `ns/search` and `ns/product-list`), bundled from the built SDK as
// a storefront's bundler would, tree-shaken, carries none of the checkout, auth or product stores. tsup splits shared
// code into hashed chunks, so each chunk in the bundle is traced to its sources through the `.map` beside it. The SDK
// entries are found through its package.json `exports`, as a storefront resolves `@nymbalhq/sdk/core`.
//
// Reads packages/sdk/dist: without a build it skips and says so (the gate builds first).

const SDK = join(REPO_ROOT, 'packages/sdk')
const DIST = join(SDK, 'dist')

/** Astro `/`'s namespaces, and the stores no element on `/` reads. */
const HOME = ['cart', 'search', 'product-list'] as const
const ABSENT = ['checkout', 'auth', 'product'] as const

const storeFile = (name: string): string => `src/store/${name}-store.ts`

interface Metafile {
  outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>
}
interface Esbuild {
  build(options: Record<string, unknown>): Promise<{ metafile: Metafile }>
}

/** The esbuild tsup bundles, through the root's tsup devDependency. */
function tsupEsbuild(): Esbuild {
  const tsup = realpathSync(join(REPO_ROOT, 'node_modules/tsup'))
  return createRequire(join(tsup, 'package.json'))('esbuild') as Esbuild
}

/** The file an SDK export (`./core`, `./ns/cart`) resolves to for an ESM importer, or undefined when it is not exported. */
function exported(subpath: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8')) as {
    exports?: Record<string, string | { import?: string; default?: string }>
  }
  for (const [pattern, target] of Object.entries(manifest.exports ?? {})) {
    const file = typeof target === 'string' ? target : (target.import ?? target.default)
    if (file === undefined) continue
    if (pattern === subpath) return join(SDK, file)
    const star = pattern.indexOf('*')
    if (star === -1) continue
    const [head, tail] = [pattern.slice(0, star), pattern.slice(star + 1)]
    if (subpath.startsWith(head) && subpath.endsWith(tail) && subpath.length > head.length) {
      return join(SDK, file.replace('*', subpath.slice(head.length, subpath.length - tail.length)))
    }
  }
  return undefined
}

/** The SDK sources (relative to packages/sdk) of a built file, from the sourcemap tsup wrote beside it. */
function sourcesOf(builtFile: string): string[] | undefined {
  const map = `${builtFile}.map`
  if (!existsSync(map)) return undefined
  const { sources, sourceRoot } = JSON.parse(readFileSync(map, 'utf8')) as {
    sources: string[]
    sourceRoot?: string
  }
  return sources.map((s) => relative(SDK, resolve(dirname(map), sourceRoot ?? '', s)))
}

describe('AC-4: the core and the home page namespaces bundle without the other stores', () => {
  it('AC-4: bundling @nymbalhq/sdk/core with ns/cart, ns/search and ns/product-list from dist, tree-shaken, keeps the cart, search and product-list stores and none of the checkout, auth or product stores', async (ctx) => {
    if (!existsSync(join(DIST, 'index.js'))) {
      return ctx.skip('packages/sdk/dist is not built: pnpm --filter @nymbalhq/sdk build')
    }
    const subpaths = ['./core', ...HOME.map((ns) => `./ns/${ns}`)]
    const entries = subpaths.map((subpath) => ({ subpath, file: exported(subpath) }))
    expect(
      entries
        .filter(({ file }) => file === undefined || !existsSync(file))
        .map(({ subpath, file }) => `${subpath} -> ${file ?? 'not in package.json exports'}`),
      'SDK entries the home page imports',
    ).toEqual([])

    const [core, ...namespaces] = entries.map(({ file }) => file!)
    const page = [
      `import { createNymbalClient } from ${JSON.stringify(core)}`,
      ...namespaces.map((file) => `import ${JSON.stringify(file)}`),
      `const client = createNymbalClient({ baseUrl: '/' })`,
      `client.cart.load()`,
      `export { client }`,
    ].join('\n')
    const { metafile } = await tsupEsbuild().build({
      stdin: { contents: page, resolveDir: SDK, sourcefile: 'astro-home.js', loader: 'js' },
      absWorkingDir: REPO_ROOT,
      bundle: true,
      treeShaking: true,
      minify: true,
      format: 'esm',
      platform: 'browser',
      external: ['@nymbalhq/types'],
      metafile: true,
      write: false,
      logLevel: 'silent',
    })

    const inBundle = Object.values(metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, input]) => input.bytesInOutput > 0)
        .map(([path]) => resolve(REPO_ROOT, path))
        .filter((path) => path.startsWith(`${DIST}/`)),
    )
    const unmapped = inBundle.filter((file) => sourcesOf(file) === undefined)
    expect(unmapped.map((file) => relative(SDK, file)), 'chunks with no sourcemap').toEqual([])
    const sources = new Set(inBundle.flatMap((file) => sourcesOf(file) ?? []))

    expect(
      ABSENT.map(storeFile).filter((file) => sources.has(file)),
      'stores no element on / reads',
    ).toEqual([])
    expect(HOME.map(storeFile).filter((file) => sources.has(file))).toEqual(HOME.map(storeFile))
  })
})
