import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// AC-7: checkout lives in `nymbal-checkout`, not in the templates. The old checkout files are gone from both
// templates and from the scaffold `create-nymbal-app` copies, the scaffold's checkout pages are the templates' own
// byte for byte, and the checkout's test ids live in the web-components source and in no file a template or the
// scaffold holds. Files are what git tracks plus what it would add (untracked, not ignored), so a build output or a
// dependency never counts.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCAFFOLD = 'packages/create-app/scaffold/templates'

const DELETED: Record<'astro' | 'nextjs', string[]> = {
  astro: [
    'src/scripts/checkout.ts',
    'src/components/AddressForm.astro',
    'src/components/CheckoutSteps.astro',
    'src/styles/pages/checkout.css',
  ],
  nextjs: [
    'components/client/CheckoutForm.tsx',
    'components/server/CheckoutSteps.tsx',
    'styles/pages/checkout.module.css',
  ],
}

/** The checkout pages each template keeps, as paths under the template. */
const PAGES: Record<'astro' | 'nextjs', string> = {
  astro: 'src/pages/checkout.astro',
  nextjs: 'app/(shopper)/checkout',
}

const TEST_IDS = ['place-order', 'contact-continue', 'shipping-continue', 'checkout-summary']

/** Every file git tracks or would add under `dir`, relative to the repo root. */
function filesUnder(dir: string): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', dir],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return [...new Set(out.split('\0').filter((path) => path !== ''))].filter((path) =>
    existsSync(join(ROOT, path)),
  )
}

/** The id as a whole token: `checkout-summary` is not `checkout-summary-items`, a class the order page keeps. */
function holds(path: string, id: string): boolean {
  return new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(readFileSync(join(ROOT, path), 'utf8'))
}

/** Every file under a path (a file is itself), relative to that path. */
function walk(path: string): string[] {
  if (!statSync(path).isDirectory()) return ['']
  return readdirSync(path, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(path, join(entry.parentPath, entry.name)))
}

describe('AC-7: the checkout left the templates', () => {
  it('AC-7: none of the old checkout files exists in either template or in the scaffold, and the scaffold’s checkout pages are the templates’ byte for byte', () => {
    const present = (['astro', 'nextjs'] as const).flatMap((template) =>
      [`templates/${template}`, `${SCAFFOLD}/${template}`].flatMap((base) =>
        DELETED[template]
          .map((file) => `${base}/${file}`)
          .filter((path) => existsSync(join(ROOT, path))),
      ),
    )
    expect(present).toEqual([])

    for (const template of ['astro', 'nextjs'] as const) {
      const page = join(ROOT, 'templates', template, PAGES[template])
      const copy = join(ROOT, SCAFFOLD, template, PAGES[template])
      expect(existsSync(copy), `${SCAFFOLD}/${template}/${PAGES[template]}`).toBe(true)
      const files = walk(page)
      expect(walk(copy).sort(), `${template}: the scaffold's checkout files`).toEqual(
        [...files].sort(),
      )
      for (const file of files) {
        expect(readFileSync(join(copy, file)), `${template}: ${PAGES[template]}/${file}`).toEqual(
          readFileSync(join(page, file)),
        )
      }
    }
  })

  it('AC-7: place-order, contact-continue, shipping-continue and checkout-summary are in the web-components source and in no file under templates/ or the scaffold', () => {
    const source = filesUnder('packages/web-components/src').filter(
      (path) => /\.ts$/.test(path) && !/\.test\.ts$/.test(path),
    )
    const outside = [...filesUnder('templates'), ...filesUnder('packages/create-app/scaffold')]
    expect(outside.length, 'the templates and the scaffold hold files').toBeGreaterThan(0)

    for (const id of TEST_IDS) {
      expect(
        source.filter((path) => holds(path, id)).length,
        `${id} in packages/web-components/src`,
      ).toBeGreaterThan(0)
    }
    const left = TEST_IDS.flatMap((id) =>
      outside.filter((path) => holds(path, id)).map((path) => `${id}: ${path}`),
    )
    expect(left).toEqual([])
  })
})
