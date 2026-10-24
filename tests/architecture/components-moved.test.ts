import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// P2-17 AC-6 (the views-in-elements pattern, P2-15 AC-6 and P2-16 AC-7): the templates' server-rendered components
// moved into the eleven elements, not copied. The files Decision 4 deletes are gone from both templates and from the
// scaffold `create-nymbal-app` copies; every moved test id is rendered under `packages/web-components/src` and by no
// file under `templates/` or `packages/create-app/scaffold/`; the scaffold's copies of the template sources are the
// templates' own byte for byte (the re-sync ran); and the template sources have fewer lines than at the base (d9b47e7:
// `wc -l` 4395 over templates/astro/src, 3628 over templates/nextjs/{app,components,lib}). Files are what git tracks
// plus what it would add (untracked, not ignored), so a build output never counts. Kills: a view duplicated in a
// template beside its element, a test id living in two places, a scaffold that drifted, a task that moved nothing out.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCAFFOLD = 'packages/create-app/scaffold/templates'

/** Decision 4's deletions, relative to a template root. */
const DELETED: Record<'astro' | 'nextjs', string[]> = {
  astro: [
    'src/components/ProductCard.astro',
    'src/components/PriceDisplay.astro',
    'src/components/StockBadge.astro',
    'src/components/Breadcrumb.astro',
    'src/components/ImageGallery.astro',
    'src/components/Header.astro',
    'src/components/Footer.astro',
    'src/components/CategoryNav.astro',
    'src/components/ReviewList.astro',
    'src/components/ReviewForm.astro',
    'src/components/OrderSummary.astro',
    'src/components/RelatedProducts.astro',
    'src/components/Pagination.astro',
    'src/scripts/image-gallery.ts',
    'src/scripts/review-form.ts',
  ],
  nextjs: [
    'components/server/ProductCard.tsx',
    'components/server/PriceDisplay.tsx',
    'components/server/Breadcrumb.tsx',
    'components/server/Footer.tsx',
    'components/server/Footer.module.css',
    'components/server/CategoryNav.tsx',
    'components/server/ReviewList.tsx',
    'components/server/OrderSummary.tsx',
    'components/server/RelatedProducts.tsx',
    'components/client/ReviewForm.tsx',
    'components/client/ImageGallery.tsx',
  ],
}

/** The spec's MOVED ids. A trailing `-` is a prefix id (`product-card-<slug>`); the rest are whole ids. */
const MOVED_IDS = [
  'product-card-',
  'product-price',
  'stock-badge',
  'breadcrumb',
  'product-gallery',
  'site-header',
  'site-footer',
  'category-',
  'review-list',
  'review-',
  'review-form',
  'order-summary',
  'load-more',
] as const

/** The template sources the line count covers, and the scaffold mirrors. */
const SOURCES = {
  astro: ['templates/astro/src'],
  nextjs: ['templates/nextjs/app', 'templates/nextjs/components', 'templates/nextjs/lib'],
} as const

/** `wc -l` at the base (d9b47e7), measured in the spec's Context. */
const BASE_LINES = { astro: 4395, nextjs: 3628 } as const

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

const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|astro|css|html|md|json)$/
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The id used as a test id: in a `data-testid` attribute or selector (`data-testid="site-footer"`,
 * `data-testid={\`category-${slug}\`}`, `[data-testid="breadcrumb"]`), a `dataset.testid` or a `getByTestId(...)`. A
 * class of the same name (`.breadcrumb`, `class="site-header"`) is not a test id.
 */
function testIdPattern(id: string): RegExp {
  const tail = id.endsWith('-') ? '' : '(?![\\w-])'
  return new RegExp(`testid["'\\]]?\\s*(?:=|:|,|\\()\\s*\\{?\\s*["'\`]${escape(id)}${tail}`, 'i')
}

/** `wc -l`: the newlines in every file under the directories. */
function lines(dirs: readonly string[]): number {
  return dirs
    .flatMap(filesUnder)
    .reduce((n, path) => n + (readFileSync(join(ROOT, path), 'utf8').match(/\n/g)?.length ?? 0), 0)
}

describe('P2-17 AC-6: the components left the templates for the elements', () => {
  it('AC-6: none of the files Decision 4 deletes exists in either template or in the scaffold, and the scaffold’s copies of the template sources are exactly the templates’, byte for byte', () => {
    let checked = 0
    const present = (['astro', 'nextjs'] as const).flatMap((template) =>
      [`templates/${template}`, `${SCAFFOLD}/${template}`].flatMap((base) => {
        // The root is there, so an absent file is a deletion and not a wrong path.
        expect(existsSync(join(ROOT, base, 'package.json')), `${base}/package.json`).toBe(true)
        return DELETED[template]
          .map((file) => {
            checked += 1
            return `${base}/${file}`
          })
          .filter((path) => existsSync(join(ROOT, path)))
      }),
    )
    expect(checked).toBe(2 * (DELETED.astro.length + DELETED.nextjs.length))
    expect(present).toEqual([])

    // And the scaffold holds exactly the template sources, each byte-identical to the template's.
    for (const template of ['astro', 'nextjs'] as const) {
      for (const dir of SOURCES[template]) {
        const copy = `${SCAFFOLD}/${dir.slice('templates/'.length)}`
        const own = filesUnder(dir).map((path) => path.slice(dir.length))
        const copied = filesUnder(copy).map((path) => path.slice(copy.length))
        expect(own.length, `${dir} has files`).toBeGreaterThan(0)
        expect([...copied].sort(), `${copy}: the same files as ${dir}`).toEqual([...own].sort())
        const differ = own.filter(
          (rel) =>
            existsSync(join(ROOT, copy + rel)) &&
            !readFileSync(join(ROOT, copy + rel)).equals(readFileSync(join(ROOT, dir + rel))),
        )
        expect(differ, `${copy}: files that differ from ${dir}`).toEqual([])
      }
    }
  })

  it('AC-6: every moved test id is rendered under packages/web-components/src and by no file under templates/ or the scaffold', () => {
    const elementSources = filesUnder('packages/web-components/src').filter(
      (path) => /\.ts$/.test(path) && !/\.test\.ts$/.test(path) && !path.includes('/testing/'),
    )
    const outside = [
      ...filesUnder('templates'),
      ...filesUnder('packages/create-app/scaffold'),
    ].filter((path) => TEXT.test(path))
    expect(elementSources.length).toBeGreaterThan(10)
    expect(outside.length).toBeGreaterThan(elementSources.length)
    // The matcher sees a test id and not a class, nor a longer id that merely starts with a whole one.
    expect(testIdPattern('breadcrumb').test('<nav class="breadcrumb">')).toBe(false)
    expect(testIdPattern('breadcrumb').test('<nav data-testid="breadcrumb">')).toBe(true)
    expect(testIdPattern('review-form').test('data-testid="review-form-message"')).toBe(false)
    expect(testIdPattern('category-').test('data-testid={`category-${cat.slug}`}')).toBe(true)

    const uses = (files: string[], id: string): string[] =>
      files.filter((path) => testIdPattern(id).test(readFileSync(join(ROOT, path), 'utf8')))
    const missing = MOVED_IDS.filter((id) => uses(elementSources, id).length === 0)
    expect(missing, 'moved test ids no element source renders').toEqual([])
    const left = MOVED_IDS.flatMap((id) => uses(outside, id).map((path) => `${id} in ${path}`))
    expect(left, 'moved test ids a template or scaffold file still renders').toEqual([])
  })

  it('AC-6: wc -l over templates/astro/src and templates/nextjs/{app,components,lib} is below the base’s 4395 and 3628', () => {
    const head = { astro: lines(SOURCES.astro), nextjs: lines(SOURCES.nextjs) }
    expect(head.astro, `templates/astro/src: ${head.astro} lines`).toBeLessThan(BASE_LINES.astro)
    expect(head.nextjs, `templates/nextjs/{app,components,lib}: ${head.nextjs} lines`).toBeLessThan(
      BASE_LINES.nextjs,
    )
  })
})
