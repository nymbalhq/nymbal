// Reads: packages/web-components/src/**, templates/astro/src/**
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ASTRO_TREE, ELEMENTS_TREE } from './fixtures/sdk-namespace-reads'
import { scanAstroTemplate, scanElementsPackage } from './sdk-namespace-reads'
import { REPO_ROOT } from './workspace-manifests'

// AC-5: a page's client holds only the store namespaces whose `@nymbalhq/sdk/ns/<module>` the page imports, so every
// client-side file of the elements and the Astro template that reads one (`client.<ns>`, `this.client.<ns>`,
// `getClient().<ns>`, or destructured from them) imports its module, itself or through a module of its own package;
// and none imports a value from the `@nymbalhq/sdk` index, which would put every store back on the page.

const ELEMENTS = join(REPO_ROOT, 'packages/web-components')
const ASTRO = join(REPO_ROOT, 'templates/astro')

const temporary: string[] = []

function written(tree: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'nymbal-ns-scan-'))
  temporary.push(root)
  for (const [path, source] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), source)
  }
  return root
}

afterAll(() => {
  for (const root of temporary) rmSync(root, { recursive: true, force: true })
})

const bad = (tree: Record<string, string>): string[] =>
  Object.keys(tree)
    .filter((path) => basename(path).startsWith('bad-'))
    .sort()

describe('AC-5: client-side files import the namespaces they read', () => {
  it('AC-5: the scan reports the negative fixture: a read of this.client.checkout with only ns/cart imported, a destructured read with none, a value import from the index across lines, an Astro script reading client.auth, and a page script reached from no page', () => {
    const elements = written(ELEMENTS_TREE)
    const astro = written(ASTRO_TREE)
    const found = [...scanElementsPackage(elements, elements), ...scanAstroTemplate(astro, astro)]

    expect([...new Set(found.map((f) => f.unit))].sort()).toEqual(
      [...bad(ELEMENTS_TREE), ...bad(ASTRO_TREE)].sort(),
    )
    expect(
      found.filter((f) => f.unit === 'src/bad-reads-checkout.ts').map((f) => f.namespace),
      'the cart is imported; the checkout is not',
    ).toEqual(['checkout'])
    expect(found.filter((f) => f.unit === 'src/pages/bad-account.astro').map((f) => f.namespace)).toEqual(['auth'])
  })

  it('AC-5: every web-components and Astro template client-side file that reads a store namespace imports its @nymbalhq/sdk/ns module, and none imports a value from the @nymbalhq/sdk index', () => {
    const found = [
      ...scanElementsPackage(ELEMENTS, REPO_ROOT),
      ...scanAstroTemplate(ASTRO, REPO_ROOT),
    ]
    expect(found.map((f) => `${f.unit}: ${f.problem}`)).toEqual([])
  })
})
