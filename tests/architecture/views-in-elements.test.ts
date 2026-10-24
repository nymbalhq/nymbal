import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// AC-6: the cart, search-results and account views live in the package's elements. The template files that rendered
// them are gone from both templates and from the scaffold copies create-nymbal-app ships, and the test ids those
// views render are rendered by `packages/web-components/src` and by no file under `templates/` or
// `packages/create-app/scaffold/`.

const REPO = fileURLToPath(new URL('../../', import.meta.url))

/** The old view files, relative to a template root. */
const DELETED = {
  astro: ['src/scripts/cart-page.ts', 'src/scripts/auth-forms.ts', 'src/scripts/profile-form.ts'],
  nextjs: [
    'components/client/CartPage.tsx',
    'components/client/SearchResults.tsx',
    'components/client/LoginForm.tsx',
    'components/client/RegisterForm.tsx',
    'components/client/ProfileForm.tsx',
    'components/client/AddressManager.tsx',
  ],
} as const

const TEMPLATE_ROOTS = {
  astro: ['templates/astro', 'packages/create-app/scaffold/templates/astro'],
  nextjs: ['templates/nextjs', 'packages/create-app/scaffold/templates/nextjs'],
} as const

/** A trailing `-` is a prefix id (`cart-item-<variantId>`); the rest are whole ids. */
const MOVED_IDS = [
  'cart-item-',
  'cart-remove-',
  'cart-summary',
  'login-submit',
  'register-submit',
  'profile-save',
  'save-address',
  'addresses-list',
] as const

const SKIP_DIRS = new Set(['node_modules', '.next', '.astro', 'dist', '.turbo', 'coverage'])
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|astro|css|html|md|json)$/

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...filesUnder(path))
    } else if (TEXT.test(name)) {
      out.push(path)
    }
  }
  return out
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The id used as a test id: in a `data-testid` attribute or selector (`data-testid="cart-summary"`,
 * `data-testid={\`cart-item-${id}\`}`, `[data-testid="cart-summary"]`), a `dataset.testid` or a `getByTestId(...)`. A
 * class of the same name (`.cart-summary`, `class="cart-summary"`) is not a test id.
 */
function testIdPattern(id: string): RegExp {
  const tail = id.endsWith('-') ? '' : '(?![\\w-])'
  return new RegExp(`testid["'\\]]?\\s*(?:=|:|,|\\()\\s*\\{?\\s*["'\`]${escape(id)}${tail}`, 'i')
}

function usesOf(files: string[]): Map<string, string[]> {
  const uses = new Map<string, string[]>(MOVED_IDS.map((id) => [id, []]))
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const id of MOVED_IDS) {
      if (testIdPattern(id).test(text)) uses.get(id)!.push(relative(REPO, file))
    }
  }
  return uses
}

describe('the moved views live in the elements, not the templates', () => {
  it('AC-6: the old view files exist in neither template nor its scaffold copy', () => {
    const present: string[] = []
    let checked = 0
    for (const template of ['astro', 'nextjs'] as const) {
      for (const root of TEMPLATE_ROOTS[template]) {
        // The root itself is there, so an absent file is a deletion and not a wrong path.
        expect(existsSync(join(REPO, root, 'package.json')), `${root}/package.json`).toBe(true)
        for (const file of DELETED[template]) {
          checked += 1
          if (existsSync(join(REPO, root, file))) present.push(`${root}/${file}`)
        }
      }
    }
    expect(checked).toBe(2 * (DELETED.astro.length + DELETED.nextjs.length))
    expect(present).toEqual([])
  })

  it('AC-6: each moved view’s test ids are rendered under packages/web-components/src and by no file under templates/ or packages/create-app/scaffold/', () => {
    const elementSources = filesUnder(join(REPO, 'packages/web-components/src')).filter(
      (f) => !/\.test\.ts$/.test(f) && !f.includes(`${join('src', 'testing')}`),
    )
    const templateFiles = [
      ...filesUnder(join(REPO, 'templates')),
      ...filesUnder(join(REPO, 'packages/create-app/scaffold')),
    ]
    // The scans reach both trees: the element sources and every template and scaffold page.
    expect(elementSources.length).toBeGreaterThan(10)
    expect(templateFiles.length).toBeGreaterThan(elementSources.length)
    // The matcher sees a test id and not a class: Astro's cart stylesheet styles `.cart-summary` today.
    expect(testIdPattern('cart-summary').test('.cart-summary { padding: 0 }')).toBe(false)
    expect(testIdPattern('cart-summary').test('<div data-testid="cart-summary">')).toBe(true)
    expect(testIdPattern('cart-item-').test('data-testid={`cart-item-${item.variantId}`}')).toBe(
      true,
    )

    const inElements = usesOf(elementSources)
    const inTemplates = usesOf(templateFiles)
    const missing = MOVED_IDS.filter((id) => inElements.get(id)!.length === 0)
    expect(missing, 'test ids no element source renders').toEqual([])
    const left = MOVED_IDS.flatMap((id) => inTemplates.get(id)!.map((file) => `${id} in ${file}`))
    expect(left, 'test ids a template or scaffold file still renders').toEqual([])
  })
})
